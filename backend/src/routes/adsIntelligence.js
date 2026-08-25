// AI Business Intelligence — Phase 1: Ads Data Upload, AI Column Mapping,
// Data Quality Center, True Business Performance. ADMIN/MANAGER only, same
// gating tier as /api/settings and /api/team (requireRole, not the stricter
// Owner-only gate used for /api/users). File is accepted as base64 inside
// the normal JSON body (matches the existing admin.js IndexedDB-import
// pattern) rather than multipart — avoids adding a new dependency (multer)
// for a feature that doesn't need streaming uploads.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { prisma } from '../prisma.js';
import { parseFile, guessColumnMapping, validateRows, matchCampaignToProduct, CANONICAL_FIELDS } from '../services/adsImport.js';
import { aggregateMetrics, aggregateByCampaign, hasDateVariety, detectProblems, buildDecisions, buildExecutiveSummary, MIN_SPEND_FOR_VERDICT } from '../services/campaignAnalysis.js';
import { netProfit, revenue } from '../../../js/profit.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));

/** Reconstructs {headers, rows} from stored AdsRawRow.raw_data (each stored as a JSON object keyed by original header name — self-describing, no separate headers column needed). */
async function loadRawRowsAsTable(uploadId) {
  const raw = await prisma.adsRawRow.findMany({ where: { upload_id: uploadId }, orderBy: { row_index: 'asc' } });
  if (raw.length === 0) return { headers: [], rows: [] };
  const parsedObjects = raw.map((r) => JSON.parse(r.raw_data));
  const headers = Object.keys(parsedObjects[0]);
  const rows = parsedObjects.map((obj) => headers.map((h) => obj[h]));
  return { headers, rows };
}

router.post(
  '/uploads',
  asyncRoute(async (req, res) => {
    const { filename, fileType, contentBase64 } = req.body || {};
    if (!filename || !fileType || !contentBase64) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'الملف والاسم والنوع مطلوبين.' });
    }
    if (!['csv', 'xlsx'].includes(fileType)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'نوع الملف لازم يكون CSV أو XLSX.' });
    }

    const buffer = Buffer.from(contentBase64, 'base64');
    let headers, rows;
    try {
      ({ headers, rows } = await parseFile(buffer, fileType));
    } catch (err) {
      return res.status(400).json({ error: 'PARSE_ERROR', message: `مقدرش أقرأ الملف: ${err.message}` });
    }
    if (rows.length === 0) {
      return res.status(400).json({ error: 'EMPTY_FILE', message: 'الملف فاضي أو مفيهوش بيانات.' });
    }

    const upload = await prisma.adsUpload.create({
      data: { filename, file_type: fileType, status: 'UPLOADED', row_count: rows.length },
    });
    await prisma.adsRawRow.createMany({
      data: rows.map((row, i) => ({
        upload_id: upload.id,
        row_index: i,
        raw_data: JSON.stringify(Object.fromEntries(headers.map((h, j) => [h, row[j] ?? '']))),
      })),
    });

    const guessedMapping = guessColumnMapping(headers);
    const { warnings, invalidCount } = validateRows(headers, rows, guessedMapping);

    res.status(201).json({
      uploadId: upload.id,
      headers,
      canonicalFields: CANONICAL_FIELDS,
      guessedMapping,
      rowCount: rows.length,
      invalidCount,
      sampleWarnings: warnings.slice(0, 20),
    });
  })
);

router.patch(
  '/uploads/:id/mapping',
  asyncRoute(async (req, res) => {
    const { mapping } = req.body || {};
    if (!mapping || typeof mapping !== 'object') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'الـ Mapping مطلوب.' });
    }
    const upload = await prisma.adsUpload.findUnique({ where: { id: Number(req.params.id) } });
    if (!upload) return res.status(404).json({ error: 'NOT_FOUND', message: 'الرفعة دي مش موجودة.' });

    await prisma.adsUpload.update({ where: { id: upload.id }, data: { column_mapping: JSON.stringify(mapping), status: 'MAPPED' } });

    const { headers, rows } = await loadRawRowsAsTable(upload.id);
    const { warnings, invalidCount } = validateRows(headers, rows, mapping);
    res.json({ invalidCount, totalRows: rows.length, sampleWarnings: warnings.slice(0, 20) });
  })
);

router.post(
  '/uploads/:id/process',
  asyncRoute(async (req, res) => {
    const upload = await prisma.adsUpload.findUnique({ where: { id: Number(req.params.id) } });
    if (!upload) return res.status(404).json({ error: 'NOT_FOUND', message: 'الرفعة دي مش موجودة.' });
    if (!upload.column_mapping) return res.status(400).json({ error: 'MAPPING_REQUIRED', message: 'لازم تأكد الـ Mapping الأول.' });

    const mapping = JSON.parse(upload.column_mapping);
    const { headers, rows } = await loadRawRowsAsTable(upload.id);
    const { parsed, warnings } = validateRows(headers, rows, mapping);
    const validRows = parsed.filter((r) => r.valid);

    const products = await prisma.product.findMany({ select: { id: true, product_name: true, sku: true } });
    const matchCache = new Map(); // campaign_name -> match result, avoids re-matching the same campaign per row
    const unmatchedCampaigns = new Set();

    const metricRows = validRows.map((r) => {
      if (!matchCache.has(r.campaign_name)) matchCache.set(r.campaign_name, matchCampaignToProduct(r.campaign_name, products));
      const match = matchCache.get(r.campaign_name);
      if (match.method === 'unmatched') unmatchedCampaigns.add(r.campaign_name);
      return {
        upload_id: upload.id,
        date: r.date,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        adset_id: r.adset_id,
        adset_name: r.adset_name,
        ad_id: r.ad_id,
        ad_name: r.ad_name,
        creative_id: r.creative_id,
        creative_name: r.creative_name,
        spend: r.spend,
        impressions: r.impressions,
        reach: r.reach,
        frequency: r.frequency,
        clicks: r.clicks,
        ctr: r.ctr,
        cpc: r.cpc,
        cpm: r.cpm,
        landing_page_views: r.landing_page_views,
        leads: r.leads,
        add_to_cart: r.add_to_cart,
        initiate_checkout: r.initiate_checkout,
        meta_purchases: r.meta_purchases,
        meta_revenue: r.meta_revenue,
        meta_roas: r.meta_roas,
        results: r.results,
        cost_per_result: r.cost_per_result,
        result_indicator: r.result_indicator,
        campaign_delivery: r.campaign_delivery,
        matched_product_id: match.productId,
        match_confidence: match.confidence,
        match_method: match.method,
      };
    });

    if (metricRows.length > 0) await prisma.adsDailyMetric.createMany({ data: metricRows });

    await prisma.adsUpload.update({
      where: { id: upload.id },
      data: { status: 'PROCESSED', processed_at: new Date(), errors: JSON.stringify(warnings) },
    });

    res.json({
      metricsCreated: metricRows.length,
      skippedInvalidRows: parsed.length - validRows.length,
      unmatchedCampaigns: [...unmatchedCampaigns],
    });
  })
);

router.get(
  '/uploads',
  asyncRoute(async (req, res) => {
    const uploads = await prisma.adsUpload.findMany({
      orderBy: { uploaded_at: 'desc' },
      include: { uploaded_by: { select: { name: true } } },
    });
    res.json(
      uploads.map((u) => ({
        id: u.id,
        filename: u.filename,
        fileType: u.file_type,
        status: u.status,
        rowCount: u.row_count,
        uploadedBy: u.uploaded_by?.name || null,
        uploadedAt: u.uploaded_at,
        processedAt: u.processed_at,
      }))
    );
  })
);

router.get(
  '/data-quality',
  asyncRoute(async (req, res) => {
    const [unmatchedGroups, totalMetrics, uploads] = await Promise.all([
      prisma.adsDailyMetric.groupBy({
        by: ['campaign_name'],
        where: { matched_product_id: null },
        _sum: { spend: true },
        _count: true,
      }),
      prisma.adsDailyMetric.count(),
      prisma.adsUpload.findMany({ where: { errors: { not: null } }, select: { id: true, filename: true, errors: true, uploaded_at: true } }),
    ]);

    const unmatchedCampaigns = unmatchedGroups
      .map((g) => ({ campaignName: g.campaign_name, rowCount: g._count, totalSpend: g._sum.spend || 0 }))
      .sort((a, b) => b.totalSpend - a.totalSpend);

    const importIssues = uploads
      .map((u) => {
        const warnings = JSON.parse(u.errors || '[]');
        return { uploadId: u.id, filename: u.filename, uploadedAt: u.uploaded_at, warningCount: warnings.length };
      })
      .filter((u) => u.warningCount > 0);

    // Two genuinely different problem categories, per explicit user direction:
    // unmatched campaigns are a business-mapping gap (optional, for product
    // profitability only) — never framed as something blocking ads analysis,
    // which reads AdsDailyMetric directly and needs no product link at all.
    res.json({
      totalMetricRows: totalMetrics,
      adsDataQuality: {
        importIssues, // per-upload row-level warnings (missing dates/spend/etc.) from the validation step
      },
      businessMapping: {
        note: 'تحليل أداء الحملات شغال بالكامل من غير الحاجة للربط ده. الربط بيضيف بس تحليل الربحية الحقيقية للمنتج.',
        unmatchedCampaignCount: unmatchedCampaigns.length,
        unmatchedCampaigns,
      },
    });
  })
);

// Manual product linking — the optional Business Mapping layer, deliberately
// separate from ads analysis. A human picks the product explicitly (or
// accepts a suggested match); never auto-links on a low-confidence guess.
router.post(
  '/campaigns/link-product',
  asyncRoute(async (req, res) => {
    const { campaignName, productId } = req.body || {};
    if (!campaignName || !productId) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'اسم الحملة والمنتج مطلوبين.' });
    }
    const product = await prisma.product.findUnique({ where: { id: Number(productId) } });
    if (!product) return res.status(404).json({ error: 'NOT_FOUND', message: 'المنتج ده مش موجود.' });

    const updated = await prisma.adsDailyMetric.updateMany({
      where: { campaign_name: campaignName },
      data: { matched_product_id: product.id, match_method: 'manual', match_confidence: 1 },
    });
    res.json({ updatedRows: updated.count, productId: product.id, productName: product.product_name });
  })
);

router.get(
  '/true-performance',
  asyncRoute(async (req, res) => {
    const { dateFrom, dateTo } = req.query;
    const dateFilter = {};
    if (dateFrom) dateFilter.gte = dateFrom;
    if (dateTo) dateFilter.lte = dateTo;

    const adsWhere = { matched_product_id: { not: null } };
    if (dateFrom || dateTo) adsWhere.date = dateFilter;

    const adsGroups = await prisma.adsDailyMetric.groupBy({
      by: ['matched_product_id'],
      where: adsWhere,
      _sum: { spend: true, meta_purchases: true, meta_revenue: true, impressions: true, clicks: true },
    });

    const results = [];
    for (const g of adsGroups) {
      const productId = g.matched_product_id;
      const product = await prisma.product.findUnique({ where: { id: productId } });
      if (!product) continue;

      const spend = g._sum.spend || 0;
      const metaPurchases = g._sum.meta_purchases || 0;
      const metaRevenue = g._sum.meta_revenue || 0;
      const metaRoas = spend > 0 ? metaRevenue / spend : null;

      const eoWhere = { product_id: productId };
      if (dateFrom || dateTo) eoWhere.date = dateFilter;
      const eoRows = await prisma.easyOrdersOrder.findMany({ where: eoWhere });

      let source, actualOrders, confirmedOrders, deliveredOrders, cancelledOrders, returnedOrders, actualRevenue;
      if (eoRows.length > 0) {
        source = 'easyorders';
        const byOrder = new Map();
        for (const r of eoRows) if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, r.status);
        const statuses = [...byOrder.values()];
        actualOrders = statuses.length;
        confirmedOrders = statuses.filter((s) => s === 'CONFIRMED').length;
        deliveredOrders = statuses.filter((s) => s === 'DELIVERED').length;
        cancelledOrders = statuses.filter((s) => s === 'CANCELLED').length;
        returnedOrders = statuses.filter((s) => s === 'RETURNED').length;
        actualRevenue = revenue(product, deliveredOrders || actualOrders);
      } else {
        const doWhere = { product_id: productId };
        if (dateFrom || dateTo) doWhere.date = dateFilter;
        const dailyRows = await prisma.dailyOrder.findMany({ where: doWhere });
        source = dailyRows.length > 0 ? 'daily_orders' : 'none';
        actualOrders = dailyRows.reduce((s, r) => s + (r.orders_count || 0), 0);
        confirmedOrders = null; // DailyOrder doesn't distinguish confirmed from placed
        deliveredOrders = dailyRows.reduce((s, r) => s + (r.delivered_count || 0), 0);
        cancelledOrders = null;
        returnedOrders = dailyRows.reduce((s, r) => s + (r.returned_count || 0), 0);
        actualRevenue = revenue(product, deliveredOrders || actualOrders);
      }

      const trueCPA = actualOrders > 0 ? spend / actualOrders : null;
      const netProfitValue = netProfit(product, deliveredOrders || actualOrders, trueCPA ?? undefined);
      const trueRoas = spend > 0 && actualRevenue !== null ? actualRevenue / spend : null;
      const deliveredRoas = spend > 0 && deliveredOrders ? (deliveredOrders * product.selling_price) / spend : null;
      const costPerDeliveredOrder = deliveredOrders > 0 ? spend / deliveredOrders : null;

      results.push({
        productId,
        productName: product.product_name,
        meta: { spend, purchases: metaPurchases, revenue: metaRevenue, roas: metaRoas, impressions: g._sum.impressions || 0, clicks: g._sum.clicks || 0 },
        real: {
          source, // "easyorders" | "daily_orders" | "none" — which real data source this came from, shown for transparency
          actualOrders,
          confirmedOrders,
          deliveredOrders,
          cancelledOrders,
          returnedOrders,
          actualRevenue,
          netProfit: netProfitValue,
          trueCPA,
          trueRoas,
          deliveredRoas,
          costPerDeliveredOrder,
        },
      });
    }

    results.sort((a, b) => b.meta.spend - a.meta.spend);
    res.json({ dateFrom: dateFrom || null, dateTo: dateTo || null, products: results });
  })
);

// ============================================================================
// Campaign performance analysis — Critical Fixes 1-6. Deliberately reads
// ONLY AdsDailyMetric (no product/order join anywhere below) so campaign
// analysis works fully regardless of whether campaign->product matching
// succeeded — matching is an optional extra layer (/true-performance above),
// never a prerequisite. See services/campaignAnalysis.js for the actual math.
// ============================================================================

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Resolves the current + previous comparison window from query params, falling back to "all data available" when no explicit range is given. Previous period is the same length immediately preceding the current one — returns null previous bounds when there's nothing before the earliest data (so the caller can show an honest "no history yet" state instead of comparing against nothing). */
async function resolveDateWindows(dateFrom, dateTo) {
  const extent = await prisma.adsDailyMetric.aggregate({ _min: { date: true }, _max: { date: true } });
  const dataMin = extent._min.date;
  const dataMax = extent._max.date;
  if (!dataMin) return { current: null, previous: null };

  const currentFrom = dateFrom || dataMin;
  const currentTo = dateTo || dataMax;
  const spanDays = Math.round((new Date(currentTo) - new Date(currentFrom)) / 86400000) + 1;
  const previousTo = addDays(currentFrom, -1);
  const previousFrom = addDays(previousTo, -(spanDays - 1));
  const previousHasData = previousTo >= dataMin;

  return {
    current: { from: currentFrom, to: currentTo },
    previous: previousHasData ? { from: previousFrom, to: previousTo } : null,
  };
}

async function loadMetricsInRange(window) {
  if (!window) return [];
  return prisma.adsDailyMetric.findMany({ where: { date: { gte: window.from, lte: window.to } } });
}

router.get(
  '/analysis',
  asyncRoute(async (req, res) => {
    const { dateFrom, dateTo } = req.query;
    const { current, previous } = await resolveDateWindows(dateFrom, dateTo);
    if (!current) {
      return res.json({ hasData: false, message: 'مفيش بيانات إعلانات مرفوعة لسه — ارفع ملف الأول.' });
    }

    const [currentRows, previousRows] = await Promise.all([loadMetricsInRange(current), loadMetricsInRange(previous)]);

    const overview = aggregateMetrics(currentRows);
    const previousOverview = previous ? aggregateMetrics(previousRows) : null;
    const campaigns = aggregateByCampaign(currentRows);
    const previousCampaigns = previous ? aggregateByCampaign(previousRows) : [];
    const accountAvg = { cpa: overview.cpa, spend: overview.spend / Math.max(campaigns.length, 1) };

    const problems = detectProblems(campaigns, accountAvg, { previousCampaigns });
    const decisions = buildDecisions(campaigns, accountAvg, problems);
    const summary = buildExecutiveSummary({ overview, previousOverview, problems, decisions });

    campaigns.sort((a, b) => (a.cpa === null) - (b.cpa === null) || a.cpa - b.cpa); // best (lowest real) CPA first, unjudgeable (null) ones last

    res.json({
      hasData: true,
      window: current,
      previousWindow: previous,
      hasHistory: !!previous,
      hasDateVariety: hasDateVariety(currentRows),
      minSpendForVerdict: MIN_SPEND_FOR_VERDICT,
      overview,
      previousOverview,
      campaigns,
      problems,
      decisions,
      summary,
    });
  })
);

router.get(
  '/campaign-detail',
  asyncRoute(async (req, res) => {
    const { name, dateFrom, dateTo } = req.query;
    if (!name) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'اسم الحملة مطلوب.' });

    const { current } = await resolveDateWindows(dateFrom, dateTo);
    const allRows = current ? await loadMetricsInRange(current) : [];
    const campaignRows = allRows.filter((r) => (r.campaign_name || '(بدون اسم)') === name);
    if (campaignRows.length === 0) return res.status(404).json({ error: 'NOT_FOUND', message: 'مفيش بيانات لحملة بالاسم ده في الفترة دي.' });

    const summaryMetrics = aggregateMetrics(campaignRows);
    const accountAvg = aggregateMetrics(allRows);

    // Daily breakdown for a real trend line — only meaningful once the data spans more than one date.
    const byDate = new Map();
    for (const r of campaignRows) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date).push(r);
    }
    const dailySeries = [...byDate.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, rows]) => ({ date, ...aggregateMetrics(rows) }));

    // Related ad-level rows, if the export included ad_name — spec: "Related Ads" section, only shown when the data actually supports it.
    const adRows = campaignRows.filter((r) => r.ad_name);
    const relatedAds = adRows.length > 0 ? aggregateByCampaign(adRows.map((r) => ({ ...r, campaign_name: r.ad_name }))) : [];

    res.json({
      campaignName: name,
      delivery: campaignRows.find((r) => r.campaign_delivery)?.campaign_delivery || null,
      hasDateVariety: dailySeries.length > 1,
      summary: summaryMetrics,
      accountAvg,
      dailySeries,
      relatedAds,
    });
  })
);

export default router;
