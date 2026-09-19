// Smart Decision Center — Product Discovery + Fast Inbox List. NOT a
// second analysis engine: every classification a card shows (decision,
// health score, confidence) comes from the EXISTING Phase 6 Decision
// Package, already computed and persisted by productAutoAnalysis.js (or an
// earlier manual POST /product-decision/:id call) — this file only does the
// CHEAP, BULK aggregation needed to render many product cards in one fast
// page load, without re-running the full funnel/creative/segment pipeline
// synchronously per product on every page view.
//
// "Relevant" here deliberately means more than "has an AmbProduct row" —
// the real catalog has 400+ SKUs, most completely unrelated to advertising.
// Showing all of them would violate the "understandable in seconds"
// requirement worse than a smart, evidence-based default ever could. A
// product is discoverable when it has ANY real, observable signal: an
// AmbProduct economics profile, a Launch Builder link, a confirmed campaign
// mapping, or genuine recent Easy Orders sales — never a guess.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { entityWindowMetrics, resolveWindow } from './metricsEngine.js';
import { resolveProductCampaigns } from './productPerformance.js';

const RECENT_ORDER_DAYS = 90;

async function discoverRelevantProductIds(storeId) {
  const cutoff = new Date(Date.now() - RECENT_ORDER_DAYS * 86400000).toISOString().slice(0, 10);
  const orderWhere = { product_id: { not: null }, date: { gte: cutoff } };
  if (storeId) orderWhere.OR = [{ store_id: storeId }, { store_id: null }];

  const [ambProducts, launchLinked, recentOrders] = await Promise.all([
    prisma.ambProduct.findMany({ where: { product_id: { not: null }, active: true }, select: { product_id: true } }),
    prisma.ambLaunchJob.findMany({ where: { product_id: { not: null } }, distinct: ['product_id'], select: { product_id: true } }),
    prisma.easyOrdersOrder.findMany({ where: orderWhere, distinct: ['product_id'], select: { product_id: true } }),
  ]);
  const ids = new Set();
  for (const r of [...ambProducts, ...launchLinked, ...recentOrders]) if (r.product_id) ids.add(r.product_id);
  return [...ids];
}

async function resolveProductImages(productIds) {
  const [ambProducts, profiles] = await Promise.all([
    prisma.ambProduct.findMany({ where: { product_id: { in: productIds } }, select: { product_id: true, image_url: true } }),
    prisma.productMarketingProfile.findMany({ where: { product_id: { in: productIds }, primary_image_url: { not: null } }, orderBy: { created_at: 'desc' }, select: { product_id: true, primary_image_url: true } }),
  ]);
  const map = new Map();
  for (const p of profiles) if (!map.has(p.product_id)) map.set(p.product_id, p.primary_image_url); // profiles ordered desc — first write per id is the newest
  for (const a of ambProducts) if (a.image_url) map.set(a.product_id, a.image_url); // an explicit AmbProduct image, when set, is the more deliberate/authoritative choice
  return map;
}

/** One bulk call per distinct ad account instead of one per product — the same entityWindowMetrics() primitive productPerformance.js's single-product path already uses, just amortized across the whole inbox. */
async function bulkMetaAggregates(campaignsByProduct, window) {
  const adAccountIds = new Set();
  for (const list of campaignsByProduct.values()) for (const c of list) if (c.adAccountId) adAccountIds.add(c.adAccountId);
  const metaByCampaign = new Map();
  for (const adAccountId of adAccountIds) {
    try {
      const m = await entityWindowMetrics({ level: 'campaign', from: window.from, to: window.to, adAccountId });
      for (const [id, agg] of m.entries()) metaByCampaign.set(id, agg);
    } catch (err) {
      logger.warn('[productDiscovery] entityWindowMetrics failed', { adAccountId, message: err.message });
    }
  }
  const result = new Map();
  for (const [productId, list] of campaignsByProduct) {
    const matched = list.map((c) => metaByCampaign.get(c.campaignId)).filter(Boolean);
    if (!matched.length) { result.set(productId, null); continue; }
    let spend = 0, purchases = 0, hasPurch = false;
    for (const a of matched) { spend += a.spend || 0; if (a.purchases != null) { purchases += a.purchases; hasPurch = true; } }
    result.set(productId, { spend, purchases: hasPurch ? purchases : null, cpa: hasPurch && purchases > 0 ? spend / purchases : null });
  }
  return result;
}

/** One query for every campaign's freshest known status instead of a live Meta call per product — mirrors productPerformance.js's own "reuse the synced snapshot, never a second live fetch" convention. */
async function bulkActiveCampaignCounts(allCampaignIds) {
  if (!allCampaignIds.length) return new Map();
  const rows = await prisma.metaPerformanceSnapshot.findMany({
    where: { campaign_id: { in: allCampaignIds }, level: 'campaign' },
    distinct: ['campaign_id'], orderBy: { snapshot_at: 'desc' },
    select: { campaign_id: true, campaign_status: true },
  });
  const map = new Map();
  for (const r of rows) map.set(r.campaign_id, r.campaign_status);
  return map;
}

/** One groupable query for every product's Easy Orders counts instead of codOrders.js's codCountsForProduct() called once per product — same dedup-by-order_id-per-product logic, just batched. */
async function bulkCodAggregates(productIds, { storeId, window }) {
  const where = { product_id: { in: productIds } };
  if (storeId) where.store_id = storeId;
  if (window?.from || window?.to) where.date = { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lte: window.to } : {}) };
  const rows = await prisma.easyOrdersOrder.findMany({ where, select: { product_id: true, order_id: true, status: true } });
  const byProductOrder = new Map();
  for (const r of rows) {
    if (!byProductOrder.has(r.product_id)) byProductOrder.set(r.product_id, new Map());
    const m = byProductOrder.get(r.product_id);
    if (!m.has(r.order_id)) m.set(r.order_id, r); // first row wins per real order — same convention as codOrders.js
  }
  const result = new Map();
  for (const [productId, m] of byProductOrder) {
    const orders = [...m.values()];
    result.set(productId, {
      orders: orders.length,
      confirmed: orders.filter((o) => o.status === 'CONFIRMED' || o.status === 'DELIVERED').length,
      delivered: orders.filter((o) => o.status === 'DELIVERED').length,
    });
  }
  return result;
}

const DECISION_LABEL_AR = {
  SCALE_CANDIDATE: 'جاهز للـScale', KEEP_TESTING: 'قيد الاختبار', NEW_CREATIVE_TEST: 'يحتاج كرياتيف',
  AUDIENCE_TEST: 'قيد الاختبار', GEO_TEST: 'قيد الاختبار', LANDING_PAGE_FIX: 'يحتاج تحسين',
  OFFER_TEST: 'يحتاج تحسين', PAUSE_CANDIDATE: 'مرشح للإيقاف', INSUFFICIENT_DATA: 'بيانات غير كافية',
};

/** The Smart Decision Center's own filter buckets — a plain, documented reshape of the real PRODUCT_DECISIONS vocabulary, never a second classification. */
export function decisionFilterBucket(decisionStatus) {
  if (decisionStatus === 'UNMAPPED') return 'unmapped';
  if (decisionStatus === 'NEEDS_MAPPING_REVIEW') return 'needsReview';
  if (decisionStatus === 'PENDING_ANALYSIS') return 'insufficientData';
  if (decisionStatus === 'MEASURING') return 'measuring';
  if (decisionStatus === 'INSUFFICIENT_DATA') return 'insufficientData';
  if (decisionStatus === 'SCALE_CANDIDATE') return 'scale';
  if (decisionStatus === 'NEW_CREATIVE_TEST') return 'needsCreative';
  if (['LANDING_PAGE_FIX', 'OFFER_TEST'].includes(decisionStatus)) return 'needsImprovement';
  if (['KEEP_TESTING', 'AUDIENCE_TEST', 'GEO_TEST'].includes(decisionStatus)) return 'testing';
  if (decisionStatus === 'PAUSE_CANDIDATE') return 'pauseCandidate';
  return 'ready';
}

/**
 * The Product Intelligence Inbox — one fast call, every real relevant
 * product, zero manual Product ID entry. Cards for products with a
 * persisted decision show it as-is; products with real linked campaigns but
 * no decision yet show PENDING_ANALYSIS (productAutoAnalysis.js's scheduler
 * will reach them; opening the product's own dossier also computes one
 * on-demand); products with zero linked campaigns show UNMAPPED.
 */
export async function listSmartDecisionProducts({ storeId, windowName } = {}) {
  const window = resolveWindow(windowName || 'last7');
  const productIds = await discoverRelevantProductIds(storeId);
  if (!productIds.length) return [];

  const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, product_name: true, store_id: true, active: true } });

  const ambProducts = await prisma.ambProduct.findMany({ where: { product_id: { in: productIds } }, select: { id: true, product_id: true } });
  const ambIdByProductId = new Map(ambProducts.map((a) => [a.product_id, a.id]));
  const ambProductIds = ambProducts.map((a) => a.id);

  const [campaignsEntries, images, mappedRows, suggestedRows] = await Promise.all([
    Promise.all(productIds.map(async (id) => [id, await resolveProductCampaigns(id).catch(() => [])])),
    resolveProductImages(productIds),
    ambProductIds.length ? prisma.ambProductCampaignMap.findMany({ where: { amb_product_id: { in: ambProductIds }, status: 'MAPPED' }, select: { amb_product_id: true } }) : [],
    ambProductIds.length ? prisma.ambProductCampaignMap.findMany({ where: { amb_product_id: { in: ambProductIds }, status: 'SUGGESTED' }, select: { amb_product_id: true } }) : [],
  ]);
  const campaignsByProduct = new Map(campaignsEntries);
  const mappedAmbIds = new Set(mappedRows.map((r) => r.amb_product_id));
  const suggestedAmbIds = new Set(suggestedRows.map((r) => r.amb_product_id));

  const allCampaignIds = [...campaignsByProduct.values()].flatMap((list) => list.map((c) => c.campaignId));
  const [statusByCampaign, metaByProduct, codByProduct, latestRecs] = await Promise.all([
    bulkActiveCampaignCounts(allCampaignIds),
    bulkMetaAggregates(campaignsByProduct, window),
    bulkCodAggregates(productIds, { storeId, window }),
    ambProductIds.length
      ? prisma.ambRecommendation.findMany({ where: { level: 'product', amb_product_id: { in: ambProductIds } }, orderBy: { created_at: 'desc' } })
      : [],
  ]);
  const latestRecByAmbId = new Map();
  for (const r of latestRecs) if (!latestRecByAmbId.has(r.amb_product_id)) latestRecByAmbId.set(r.amb_product_id, r); // ordered desc — first per id is the newest

  const cards = products.map((p) => {
    const campaigns = campaignsByProduct.get(p.id) || [];
    const ambId = ambIdByProductId.get(p.id) || null;
    const meta = metaByProduct.get(p.id) || null;
    const cod = codByProduct.get(p.id) || null;
    const activeCampaigns = campaigns.filter((c) => statusByCampaign.get(c.campaignId) === 'ACTIVE').length;
    const lastRec = ambId ? latestRecByAmbId.get(ambId) : null;

    let decisionStatus, decisionLabel, health = null, confidence = null;
    if (!campaigns.length) {
      decisionStatus = (ambId && suggestedAmbIds.has(ambId) && !mappedAmbIds.has(ambId)) ? 'NEEDS_MAPPING_REVIEW' : 'UNMAPPED';
      decisionLabel = decisionStatus === 'NEEDS_MAPPING_REVIEW' ? 'يحتاج مراجعة الربط' : 'غير مربوط بحملات';
    } else if (lastRec) {
      const facts = JSON.parse(lastRec.reason_facts_json || '{}');
      health = facts.health?.score ?? null;
      confidence = lastRec.confidence;
      const hasActiveExperiment = lastRec.status === 'EXECUTED';
      decisionStatus = hasActiveExperiment ? 'MEASURING' : lastRec.decision;
      decisionLabel = hasActiveExperiment ? 'قيد القياس' : (DECISION_LABEL_AR[lastRec.decision] || lastRec.decision);
    } else {
      decisionStatus = 'PENDING_ANALYSIS';
      decisionLabel = 'قيد التحليل الأول';
    }

    return {
      productId: p.id, productName: p.product_name, storeId: p.store_id, image: images.get(p.id) || null,
      mappedCampaigns: campaigns.length, activeCampaigns,
      spend: meta?.spend ?? null, metaPurchases: meta?.purchases ?? null, cpa: meta?.cpa ?? null,
      orders: cod?.orders ?? null, confirmedOrders: cod?.confirmed ?? null, deliveredOrders: cod?.delivered ?? null,
      healthScore: health, decisionStatus, decisionLabel, confidence,
      filterBucket: decisionFilterBucket(decisionStatus),
      lastAnalysisAt: lastRec?.created_at || null,
      window,
    };
  });

  return cards;
}
