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
import { isRelevantRow, buildEntities } from '../services/productAnalysis.js';
import { classifyEntities, DEFAULT_THRESHOLDS } from '../services/decisionEngine.js';
import { generateActionPlan, computeInputHash } from '../services/aiActionPlan.js';
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

    // Re-uploading a file replaces the data for the dates it covers rather
    // than stacking a duplicate copy on top of whatever was already there —
    // found in production twice in one day (the same real export uploaded
    // 3x during debugging silently tripled every total on the dashboard).
    // A re-import is a correction/refresh of those dates, never an addition.
    const distinctDates = [...new Set(metricRows.map((r) => r.date))];
    let replacedRows = 0;
    if (distinctDates.length > 0) {
      const deleted = await prisma.adsDailyMetric.deleteMany({ where: { date: { in: distinctDates } } });
      replacedRows = deleted.count;
    }
    if (metricRows.length > 0) await prisma.adsDailyMetric.createMany({ data: metricRows });

    await prisma.adsUpload.update({
      where: { id: upload.id },
      data: { status: 'PROCESSED', processed_at: new Date(), errors: JSON.stringify(warnings) },
    });

    res.json({
      metricsCreated: metricRows.length,
      replacedRows, // rows deleted for the same dates before inserting — 0 the first time a date is imported, >0 on every re-upload
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

// ============================================================================
// Daily Decision System — AI Intelligence Phase 2. Product-first, Top-3-by-
// default decision dashboard: buildEntities() groups active-filtered rows
// into products (mapped campaigns) and standalone campaigns (unmapped —
// never blocked on missing product mapping), classifyEntities() applies the
// configurable EGP-CPA rules, generateActionPlan() asks the real Claude
// "Marketing Performance Decision Agent" to write the reason/action text on
// top of those already-final numbers (never invents a classification).
// ============================================================================

async function loadThresholds() {
  const row = await prisma.settings.findUnique({ where: { id: 'default' } });
  const saved = row ? JSON.parse(row.data) : {};
  return {
    aiScaleCpaThreshold: saved.aiScaleCpaThreshold ?? DEFAULT_THRESHOLDS.aiScaleCpaThreshold,
    aiOptimizeCpaThreshold: saved.aiOptimizeCpaThreshold ?? DEFAULT_THRESHOLDS.aiOptimizeCpaThreshold,
    aiMinSpendForDecision: saved.aiMinSpendForDecision ?? DEFAULT_THRESHOLDS.aiMinSpendForDecision,
    aiMinOrdersForDecision: saved.aiMinOrdersForDecision ?? DEFAULT_THRESHOLDS.aiMinOrdersForDecision,
  };
}

/** Explicit dateFrom/dateTo win (presets computed client-side); otherwise defaults to real "today", falling back to the latest available upload date when today has no data (spec §22) — usedFallback tells the UI which happened. */
async function resolveDecisionWindow(dateFrom, dateTo) {
  if (dateFrom || dateTo) {
    const from = dateFrom || dateTo;
    const to = dateTo || dateFrom;
    return { from, to, usedFallback: false };
  }
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = await prisma.adsDailyMetric.count({ where: { date: today } });
  if (todayCount > 0) return { from: today, to: today, usedFallback: false };

  const extent = await prisma.adsDailyMetric.aggregate({ _max: { date: true } });
  if (!extent._max.date) return null;
  return { from: extent._max.date, to: extent._max.date, usedFallback: true };
}

// ---------------------------------------------------------------------------
// AI Intelligence -> Manager Control bridge. A TaskRecord "links back" to the
// live-computed entity it was created from via a synthetic
// (source_entity_type, source_entity_key) pair — same idiom as
// AdsDecisionReview above, since the recommendation itself is never its own
// DB row. A linked task "blocks" converting the same entity into a new task
// again unless it was cancelled, or completed AND manager-approved — that's
// the only way a manager gets a fresh "تحويل إلى مهمة" for a genuine new cycle.
// ---------------------------------------------------------------------------

function taskBlocksConversion(task) {
  if (!task) return false;
  if (task.status === 'CANCELLED') return false;
  if (task.status === 'COMPLETED' && task.review_status === 'APPROVED') return false;
  return true;
}

/** @param {{entityType:string, entityKey:string}[]} pairs @returns {Promise<Map<string, object>>} keyed by "entityType:entityKey", most recent task per pair */
async function loadLinkedTasks(pairs) {
  if (pairs.length === 0) return new Map();
  const rows = await prisma.taskRecord.findMany({
    where: { OR: pairs.map(({ entityType, entityKey }) => ({ source_entity_type: entityType, source_entity_key: entityKey })) },
    include: { employee: { select: { name: true } } },
    orderBy: { created_at: 'desc' },
  });
  const map = new Map();
  for (const t of rows) {
    const k = `${t.source_entity_type}:${t.source_entity_key}`;
    if (!map.has(k)) map.set(k, t); // rows are newest-first, so the first one seen per key is the most recent
  }
  return map;
}

function taskInfoFor(task) {
  if (!task) return null;
  return {
    taskId: task.id,
    status: task.status,
    reviewStatus: task.review_status,
    assignedToName: task.employee?.name || null,
    blocksConversion: taskBlocksConversion(task),
  };
}

router.get(
  '/decisions',
  asyncRoute(async (req, res) => {
    const { dateFrom, dateTo } = req.query;
    const window = await resolveDecisionWindow(dateFrom, dateTo);
    if (!window) {
      return res.json({ hasData: false, message: 'مفيش بيانات إعلانات مرفوعة لسه — ارفع ملف الأول.' });
    }

    const allRows = await prisma.adsDailyMetric.findMany({ where: { date: { gte: window.from, lte: window.to } } });
    const relevantRows = allRows.filter(isRelevantRow);
    const inactiveCount = allRows.length - relevantRows.length;

    const emptyBuckets = { scale: { items: [], totalCount: 0 }, optimize: { items: [], totalCount: 0 }, stop: { items: [], totalCount: 0 }, collectMoreData: { items: [], totalCount: 0 }, opportunities: { items: [], totalCount: 0 } };

    if (relevantRows.length === 0) {
      return res.json({
        hasData: true,
        window,
        activeSummary: { activeProducts: 0, activeCampaigns: 0, spend: 0, results: 0, cpa: null },
        buckets: emptyBuckets,
        needsMapping: { count: 0, sample: [] },
        actionPlan: { summary: 'مفيش حملات نشطة فيها صرف أو حالة Active في الفترة دي.', items: [], source: 'FALLBACK' },
        inactiveCount,
      });
    }

    const products = await prisma.product.findMany({ select: { id: true, product_name: true } });
    const thresholds = await loadThresholds();
    const rawEntities = buildEntities(relevantRows, products);
    const { entities, buckets } = classifyEntities(rawEntities, thresholds);

    const overview = aggregateMetrics(relevantRows);
    const activeSummary = {
      activeProducts: entities.filter((e) => e.entityType === 'product').length,
      activeCampaigns: relevantRows.reduce((set, r) => set.add(r.campaign_name), new Set()).size,
      spend: overview.spend,
      results: overview.results,
      cpa: overview.cpa,
    };

    const reviews = await prisma.adsDecisionReview.findMany({ where: { entity_key: { in: entities.map((e) => e.entityKey) } } });
    const reviewByKey = new Map(reviews.map((r) => [`${r.entity_type}:${r.entity_key}`, r.status]));
    const taskByKey = await loadLinkedTasks(entities.map((e) => ({ entityType: e.entityType, entityKey: e.entityKey })));
    const stripHeavyFields = (e) => {
      const { campaigns, adBreakdown, ...rest } = e;
      return {
        ...rest,
        hasCampaignBreakdown: !!campaigns,
        reviewStatus: reviewByKey.get(`${e.entityType}:${e.entityKey}`) || null,
        task: taskInfoFor(taskByKey.get(`${e.entityType}:${e.entityKey}`)),
      };
    };

    const visibleBuckets = {};
    for (const [key, arr] of Object.entries(buckets)) {
      const visible = arr.filter((e) => reviewByKey.get(`${e.entityType}:${e.entityKey}`) !== 'DISMISSED').map(stripHeavyFields);
      visibleBuckets[key] = { items: visible, totalCount: visible.length };
    }

    const unmatchedGroups = await prisma.adsDailyMetric.groupBy({
      by: ['campaign_name'],
      where: { date: { gte: window.from, lte: window.to }, matched_product_id: null },
      _sum: { spend: true },
      _count: true,
    });
    const relevantNames = new Set(relevantRows.filter((r) => !r.matched_product_id).map((r) => r.campaign_name));
    const needsMapping = unmatchedGroups
      .filter((g) => relevantNames.has(g.campaign_name))
      .map((g) => ({ campaignName: g.campaign_name, spend: g._sum.spend || 0, rowCount: g._count }))
      .sort((a, b) => b.spend - a.spend);

    // AI Action Plan — cached per window, regenerated only if the classified entity set actually changed or the user forces it via /decisions/generate-plan.
    const inputHash = computeInputHash(entities, thresholds);
    const cached = await prisma.adsActionPlan.findUnique({ where: { window_from_window_to: { window_from: window.from, window_to: window.to } } });
    let actionPlan;
    if (cached && cached.input_hash === inputHash) {
      actionPlan = { summary: JSON.parse(cached.plan_json).summary, items: JSON.parse(cached.plan_json).items, source: cached.source };
    } else {
      const plan = await generateActionPlan(entities, thresholds);
      await prisma.adsActionPlan.upsert({
        where: { window_from_window_to: { window_from: window.from, window_to: window.to } },
        create: { window_from: window.from, window_to: window.to, input_hash: plan.inputHash, plan_json: JSON.stringify({ summary: plan.summary, items: plan.items }), source: plan.source },
        update: { input_hash: plan.inputHash, plan_json: JSON.stringify({ summary: plan.summary, items: plan.items }), source: plan.source, generated_at: new Date() },
      });
      actionPlan = plan;
    }

    res.json({
      hasData: true,
      window,
      usedFallback: window.usedFallback,
      activeSummary,
      buckets: visibleBuckets,
      needsMapping: { count: needsMapping.length, sample: needsMapping.slice(0, 5) },
      actionPlan,
      inactiveCount,
    });
  })
);

router.post(
  '/decisions/generate-plan',
  asyncRoute(async (req, res) => {
    const { dateFrom, dateTo } = req.body || {};
    const window = await resolveDecisionWindow(dateFrom, dateTo);
    if (!window) return res.status(400).json({ error: 'NO_DATA', message: 'مفيش بيانات إعلانات مرفوعة لسه.' });

    const allRows = await prisma.adsDailyMetric.findMany({ where: { date: { gte: window.from, lte: window.to } } });
    const relevantRows = allRows.filter(isRelevantRow);
    const products = await prisma.product.findMany({ select: { id: true, product_name: true } });
    const thresholds = await loadThresholds();
    const { entities } = classifyEntities(buildEntities(relevantRows, products), thresholds);

    const plan = await generateActionPlan(entities, thresholds);
    await prisma.adsActionPlan.upsert({
      where: { window_from_window_to: { window_from: window.from, window_to: window.to } },
      create: { window_from: window.from, window_to: window.to, input_hash: plan.inputHash, plan_json: JSON.stringify({ summary: plan.summary, items: plan.items }), source: plan.source },
      update: { input_hash: plan.inputHash, plan_json: JSON.stringify({ summary: plan.summary, items: plan.items }), source: plan.source, generated_at: new Date() },
    });

    res.json(plan);
  })
);

router.get(
  '/decisions/entity',
  asyncRoute(async (req, res) => {
    const { type, key, dateFrom, dateTo } = req.query;
    if (!type || !key) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'النوع والمفتاح مطلوبين.' });

    const window = await resolveDecisionWindow(dateFrom, dateTo);
    if (!window) return res.status(404).json({ error: 'NOT_FOUND', message: 'مفيش بيانات.' });

    const allRows = await prisma.adsDailyMetric.findMany({ where: { date: { gte: window.from, lte: window.to } } });
    const relevantRows = allRows.filter(isRelevantRow);
    const products = await prisma.product.findMany({ select: { id: true, product_name: true } });
    const thresholds = await loadThresholds();
    const { entities } = classifyEntities(buildEntities(relevantRows, products), thresholds);

    const entity = entities.find((e) => e.entityType === type && e.entityKey === key);
    if (!entity) return res.status(404).json({ error: 'NOT_FOUND', message: 'مفيش بيانات للعنصر ده في الفترة دي.' });

    const cachedPlan = await prisma.adsActionPlan.findUnique({ where: { window_from_window_to: { window_from: window.from, window_to: window.to } } });
    let reason = null, recommendedAction = null;
    if (cachedPlan) {
      const item = JSON.parse(cachedPlan.plan_json).items.find((it) => it.entityKey === key);
      if (item) ({ reason, recommendedAction } = item);
    }

    const review = await prisma.adsDecisionReview.findUnique({ where: { entity_type_entity_key: { entity_type: type, entity_key: key } } }).catch(() => null);
    const linkedTask = (await loadLinkedTasks([{ entityType: type, entityKey: key }])).get(`${type}:${key}`);

    res.json({ ...entity, reason, recommendedAction, reviewStatus: review?.status || null, task: taskInfoFor(linkedTask), window });
  })
);

// Priority/task-type suggestions reuse the app's existing 3-tier priority
// (js/task-engine.js TASK_PRIORITY) and existing task-type vocabulary
// (TASK_TYPE) rather than inventing new ones — the manager can always
// change either in the modal before creating the task.
const PRIORITY_SUGGESTION = { STOP: 'URGENT', SCALE: 'IMPORTANT', OPTIMIZE: 'IMPORTANT', COLLECT_MORE_DATA: 'NORMAL' };
const TASK_TYPE_SUGGESTION = { SCALE: 'SCALE', OPTIMIZE: 'REVIEW_PRODUCT', STOP: 'PAUSE_REVIEW', COLLECT_MORE_DATA: 'COLLECT_DATA' };

router.post(
  '/decisions/convert-to-task',
  requireRole('ADMIN', 'MANAGER'),
  asyncRoute(async (req, res) => {
    const { entityType, entityKey, employeeId, priority, taskType, title, details, dueDate, executionDate, dateFrom, dateTo } = req.body || {};
    if (!entityType || !entityKey || !title) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'entityType, entityKey, title مطلوبين.' });
    }

    // Re-run the real classification server-side rather than trusting whatever the client last saw — the snapshot must reflect genuinely current numbers.
    const window = await resolveDecisionWindow(dateFrom, dateTo);
    if (!window) return res.status(400).json({ error: 'NO_DATA', message: 'مفيش بيانات إعلانات مرفوعة لسه.' });
    const allRows = await prisma.adsDailyMetric.findMany({ where: { date: { gte: window.from, lte: window.to } } });
    const relevantRows = allRows.filter(isRelevantRow);
    const products = await prisma.product.findMany({ select: { id: true, product_name: true } });
    const thresholds = await loadThresholds();
    const { entities } = classifyEntities(buildEntities(relevantRows, products), thresholds);
    const entity = entities.find((e) => e.entityType === entityType && e.entityKey === entityKey);
    if (!entity) return res.status(404).json({ error: 'NOT_FOUND', message: 'مفيش بيانات للعنصر ده في الفترة دي.' });

    const existingTask = (await loadLinkedTasks([{ entityType, entityKey }])).get(`${entityType}:${entityKey}`);
    if (taskBlocksConversion(existingTask)) {
      return res.status(409).json({ error: 'TASK_EXISTS', message: 'فيه مهمة شغالة بالفعل على العنصر ده.', taskId: existingTask.id });
    }

    const cachedPlan = await prisma.adsActionPlan.findUnique({ where: { window_from_window_to: { window_from: window.from, window_to: window.to } } });
    const planItem = cachedPlan ? JSON.parse(cachedPlan.plan_json).items.find((it) => it.entityKey === entityKey) : null;

    const snapshot = {
      classification: entity.classification,
      priority: entity.priority,
      confidence: entity.confidence,
      metrics: { spend: entity.spend, results: entity.results, cpa: entity.cpa },
      reason: planItem?.reason || null,
      recommendedAction: planItem?.recommendedAction || null,
      capturedAt: new Date().toISOString(),
    };

    const today = new Date().toISOString().slice(0, 10);
    const created = await prisma.taskRecord.create({
      data: {
        date: executionDate || today,
        execution_date: executionDate || today,
        due_date: dueDate || null,
        product_id: entityType === 'product' ? Number(entityKey) : null,
        product_name: entity.entityName,
        employee_id: employeeId ? Number(employeeId) : null,
        created_by_id: req.user.id,
        status: 'PENDING',
        task_type: taskType || TASK_TYPE_SUGGESTION[entity.classification] || 'OTHER',
        priority: priority || PRIORITY_SUGGESTION[entity.classification] || 'NORMAL',
        title,
        details: details || null,
        related_campaign: entityType === 'campaign' ? entityKey : null,
        source: 'ai_intelligence',
        assignment_source: 'manager',
        assigned_by: 'manager',
        assigned_at: employeeId ? new Date() : null,
        source_entity_type: entityType,
        source_entity_key: entityKey,
        ai_recommendation_snapshot: JSON.stringify(snapshot),
      },
    });

    await prisma.taskActivityLog.create({
      data: { date: created.date, task_id: created.id, action_type: 'ADD', details_text: `اتعمل من توصية AI Intelligence (${entity.classification})`, actor_id: req.user.id },
    });

    res.status(201).json(created);
  })
);

router.post(
  '/decisions/review',
  asyncRoute(async (req, res) => {
    const { entityType, entityKey, status } = req.body || {};
    if (!entityType || !entityKey || !['REVIEWED', 'DISMISSED'].includes(status)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'entityType, entityKey, status (REVIEWED|DISMISSED) مطلوبين.' });
    }
    const review = await prisma.adsDecisionReview.upsert({
      where: { entity_type_entity_key: { entity_type: entityType, entity_key: entityKey } },
      create: { entity_type: entityType, entity_key: entityKey, status, reviewed_by_id: req.user?.id || null },
      update: { status, reviewed_by_id: req.user?.id || null, reviewed_at: new Date() },
    });
    res.json(review);
  })
);

export default router;
