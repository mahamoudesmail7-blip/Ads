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

    res.json({
      totalMetricRows: totalMetrics,
      unmatchedCampaignCount: unmatchedCampaigns.length,
      unmatchedCampaigns,
      importIssues,
    });
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

export default router;
