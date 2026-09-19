// Smart Decision Center Phase 2 — the Unified Product Performance dataset.
// The single, trustworthy source of truth PMC and the future Smart Decision
// Center both read instead of each recomputing their own Meta+EasyOrders
// join. Strictly a DATA FOUNDATION: no AI, no segment/scale conclusions, no
// Meta writes anywhere in this file.
//
// Walks the deterministic Phase 1 chain (Store -> Product -> Launch Job ->
// Campaign) PLUS the pre-existing historical AmbProductCampaignMap mapping,
// unions both into one real set of Meta campaign ids, and reuses the
// already-hardened, OOM-incident-fixed metricsEngine.js aggregation
// (entityWindowMetrics/loadSnapshots/aggregateRows) rather than re-querying
// meta_performance_snapshots directly. Easy Orders truth reuses codOrders.js,
// store-scoped via the product's own Product.store_id (Phase 2's multi-store
// isolation fix) — never a second implementation of either.
//
// Meta "purchases" and Easy Orders "orders" are kept in two SEPARATE blocks
// on purpose: no reliable per-order attribution key exists between a Meta ad
// click and a real Easy Orders order today, so this file never joins them
// into one fabricated row. Every block carries its own dataState — one of
// AVAILABLE | NO_DATA | NOT_SYNCED | INSUFFICIENT_DATA | META_UNMAPPED |
// PROVIDER_ERROR — so a caller can never mistake "never synced" or "not
// mapped" for a genuine zero.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { resolveWindow, entityWindowMetrics } from './metricsEngine.js';
import { codCountsForProduct, codCountsByGovernorate } from './codOrders.js';

const MIN_COD_SAMPLE = 10; // mirrors codOrders.js's observedRatesForProduct() convention

function emptyMetaBlock(dataState) {
  return {
    dataState,
    spend: null, impressions: null, reach: null, clicks: null, ctr: null, cpc: null, cpm: null,
    purchases: null, cpa: null, conversionRate: null, revenue: null,
    campaignIds: [], lastSyncAt: null,
  };
}
function emptyEasyOrdersBlock(dataState) {
  return {
    dataState,
    orders: null, confirmed: null, delivered: null, returned: null, cancelled: null,
    revenue: null, deliveredRevenue: null, confirmationRate: null, deliveryRate: null,
    sample: 0, governorates: [], lastOrderAt: null, source: 'none',
  };
}

/**
 * Resolves the real Meta campaign ids this product is linked to, via BOTH:
 *  - the deterministic Phase 1 chain (AmbLaunchJob.product_id -> AmbLaunchCampaign.meta_campaign_id)
 *  - the pre-existing historical mapping (AmbProduct -> AmbProductCampaignMap, status MAPPED)
 * Never campaign-name matching — that stays historical-review-only.
 * Returns [{ campaignId, adAccountId, via: 'LAUNCH'|'MAPPING' }], deduped by campaignId (LAUNCH wins on collision).
 */
export async function resolveProductCampaigns(productId) {
  const [launchCampaigns, ambProduct] = await Promise.all([
    prisma.ambLaunchCampaign.findMany({
      where: { job: { product_id: productId }, meta_campaign_id: { not: null } },
      select: { meta_campaign_id: true, job: { select: { ad_account_id: true } } },
    }),
    prisma.ambProduct.findUnique({ where: { product_id: productId }, select: { id: true } }),
  ]);

  const mappedCampaigns = ambProduct
    ? await prisma.ambProductCampaignMap.findMany({
        where: { amb_product_id: ambProduct.id, status: 'MAPPED' },
        select: { campaign_id: true, ad_account_id: true },
      })
    : [];

  const entries = [
    ...launchCampaigns.map((c) => ({ campaignId: c.meta_campaign_id, adAccountId: c.job.ad_account_id, via: 'LAUNCH' })),
    ...mappedCampaigns.map((c) => ({ campaignId: c.campaign_id, adAccountId: c.ad_account_id, via: 'MAPPING' })),
  ];
  const byId = new Map();
  for (const e of entries) if (!byId.has(e.campaignId)) byId.set(e.campaignId, e);
  return [...byId.values()];
}

function sumMetaAggregates(aggs) {
  let spend = 0, impressions = 0, reach = 0, clicks = 0, purchases = 0, revenue = 0;
  let hasImpr = false, hasClicks = false, hasPurch = false, hasRev = false;
  for (const a of aggs) {
    spend += a.spend || 0;
    if (a.impressions != null) { impressions += a.impressions; hasImpr = true; }
    if (a.reach != null) reach += a.reach;
    if (a.clicks != null) { clicks += a.clicks; hasClicks = true; }
    if (a.purchases != null) { purchases += a.purchases; hasPurch = true; }
    if (a.revenue != null) { revenue += a.revenue; hasRev = true; }
  }
  return {
    spend,
    impressions: hasImpr ? impressions : null,
    reach: reach || null,
    clicks: hasClicks ? clicks : null,
    purchases: hasPurch ? purchases : null,
    revenue: hasRev ? revenue : null,
    ctr: hasClicks && hasImpr && impressions > 0 ? (clicks / impressions) * 100 : null,
    cpc: hasClicks && clicks > 0 ? spend / clicks : null,
    cpm: hasImpr && impressions > 0 ? (spend / impressions) * 1000 : null,
    cpa: hasPurch && purchases > 0 ? spend / purchases : null,
    conversionRate: hasClicks && hasPurch && clicks > 0 ? (purchases / clicks) * 100 : null,
  };
}

/** Meta block: resolves campaigns, aggregates via the existing hardened metricsEngine, distinguishes META_UNMAPPED / NOT_SYNCED / NO_DATA / AVAILABLE. */
async function buildMetaBlock(productId, window) {
  let campaigns;
  try {
    campaigns = await resolveProductCampaigns(productId);
  } catch (err) {
    logger.warn('[productPerformance] resolveProductCampaigns failed', { productId, message: err.message });
    return { block: emptyMetaBlock('PROVIDER_ERROR'), resolvedVia: [] };
  }
  if (!campaigns.length) return { block: emptyMetaBlock('META_UNMAPPED'), resolvedVia: [] };

  const adAccountIds = [...new Set(campaigns.map((c) => c.adAccountId).filter(Boolean))];
  const metaByCampaign = new Map();
  try {
    for (const adAccountId of adAccountIds) {
      const m = await entityWindowMetrics({ level: 'campaign', from: window.from, to: window.to, adAccountId });
      for (const [id, agg] of m.entries()) metaByCampaign.set(id, agg);
    }
  } catch (err) {
    logger.warn('[productPerformance] entityWindowMetrics failed', { productId, message: err.message });
    return { block: emptyMetaBlock('PROVIDER_ERROR'), resolvedVia: [...new Set(campaigns.map((c) => c.via))] };
  }

  const campaignIds = campaigns.map((c) => c.campaignId);
  const matched = campaignIds.map((id) => metaByCampaign.get(id)).filter(Boolean);
  const resolvedVia = [...new Set(campaigns.map((c) => c.via))];

  const [lastRun] = await Promise.all([
    prisma.ambSyncRun.findFirst({ where: { status: { in: ['SUCCESS', 'PARTIAL'] } }, orderBy: { finished_at: 'desc' }, select: { finished_at: true } }),
  ]);
  const lastSyncAt = lastRun?.finished_at || null;

  if (!matched.length) {
    // Campaigns are genuinely known/linked, but no rows for this window —
    // distinguish "never synced at all" from "synced, just zero activity".
    const everSynced = await prisma.metaPerformanceSnapshot.count({ where: { campaign_id: { in: campaignIds }, level: 'campaign' } });
    return { block: { ...emptyMetaBlock(everSynced > 0 ? 'NO_DATA' : 'NOT_SYNCED'), campaignIds, lastSyncAt }, resolvedVia };
  }

  const sums = sumMetaAggregates(matched);
  return { block: { dataState: 'AVAILABLE', ...sums, campaignIds, lastSyncAt }, resolvedVia };
}

/** Easy Orders block: reuses codOrders.js, store-scoped, never fabricates a rate from too small a sample. */
async function buildEasyOrdersBlock(productId, storeId, window) {
  try {
    const [cod, governorates] = await Promise.all([
      codCountsForProduct({ productId, storeId, from: window.from, to: window.to }),
      codCountsByGovernorate({ productId, storeId, from: window.from, to: window.to }),
    ]);
    if (cod.source === 'none') return { ...emptyEasyOrdersBlock('NO_DATA'), source: 'none' };

    const sample = cod.orders || 0;
    const sufficient = sample >= MIN_COD_SAMPLE;
    const confirmationRate = sufficient && cod.confirmed != null && sample > 0 ? cod.confirmed / sample : null;
    const deliveryRate = sufficient && cod.confirmed != null && cod.confirmed > 0 && cod.delivered != null ? cod.delivered / cod.confirmed : null;

    // Freshness proxy: the most recent order timestamp actually counted — a
    // real, observed value, never a synthetic "last synced" clock (Easy
    // Orders ingestion is webhook/import-driven, not a polling sync).
    let lastOrderAt = null;
    if (cod.source === 'easyorders') {
      const latest = await prisma.easyOrdersOrder.findFirst({
        where: { product_id: productId, ...(storeId ? { store_id: storeId } : {}), ...((window.from || window.to) ? { date: { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lte: window.to } : {}) } } : {}) },
        orderBy: { updated_at: 'desc' }, select: { updated_at: true },
      });
      lastOrderAt = latest?.updated_at || null;
    }

    return {
      dataState: sample > 0 ? 'AVAILABLE' : 'NO_DATA',
      orders: cod.orders, confirmed: cod.confirmed, delivered: cod.delivered, returned: cod.returned, cancelled: cod.cancelled,
      revenue: cod.revenue, deliveredRevenue: cod.deliveredRevenue,
      confirmationRate, deliveryRate,
      sample, governorates, lastOrderAt, source: cod.source,
      ...(sample > 0 && !sufficient ? { rateNote: `عدد الأوردرات (${sample}) أقل من الحد الأدنى (${MIN_COD_SAMPLE}) — نسب التأكيد/التسليم غير معروضة حتى تتوفر عينة كافية.` } : {}),
    };
  } catch (err) {
    logger.warn('[productPerformance] buildEasyOrdersBlock failed', { productId, message: err.message });
    return emptyEasyOrdersBlock('PROVIDER_ERROR');
  }
}

/**
 * The Unified Product Performance dataset — one Product, one time window,
 * every genuinely-available Meta + Easy Orders metric with an explicit
 * dataState per block. Consumed by PMC and (later) the Smart Decision Center
 * instead of either rebuilding this join itself.
 * @param {{productId:number, windowName?:string, from?:string, to?:string}} params
 */
export async function getProductPerformance({ productId, windowName, from, to }) {
  const pid = Number(productId);
  if (!Number.isInteger(pid) || pid <= 0) { const e = new Error('productId غير صالح.'); e.status = 400; throw e; }

  const product = await prisma.product.findUnique({ where: { id: pid }, select: { id: true, product_name: true, store_id: true, active: true, is_historical: true } });
  if (!product) { const e = new Error('المنتج غير موجود.'); e.status = 404; throw e; }

  const window = (from || to) ? { from: from || null, to: to || null } : resolveWindow(windowName || 'last7');
  const storeId = product.store_id || null;

  const [{ block: meta, resolvedVia }, easyOrders] = await Promise.all([
    buildMetaBlock(pid, window),
    buildEasyOrdersBlock(pid, storeId, window),
  ]);

  return {
    productId: product.id,
    productName: product.product_name,
    storeId,
    window,
    resolvedVia, // ['LAUNCH'] | ['MAPPING'] | ['LAUNCH','MAPPING'] | []
    meta,
    easyOrders,
    generatedAt: new Date().toISOString(),
  };
}
