// aiTools.js — the AI E-Commerce Operating System's Tool Layer. This is the
// ONLY place the AI agent (routes/aiAssistant.js) is allowed to reach real
// data through; the agent itself never touches Prisma directly. Every tool
// here:
//   - wraps EXISTING, already-tested logic (never re-derives numbers a
//     different way, so it can never quietly disagree with what the rest of
//     the app shows)
//   - is read-only for Phase 1 (action: 'READ') — no tool here can pause a
//     campaign, change a budget, or write anything. Write tools are a later
//     phase, deliberately not built yet.
//   - never throws past its own boundary: catches its own errors and
//     returns {ok:false, error} so one bad tool call can never break the
//     whole agent turn
//   - is logged by the caller (routes/aiAssistant.js) to AiAuditLog, not
//     here, so every tool stays a plain, easily-unit-testable function.
import { prisma } from '../prisma.js';
import { aggregateByCampaign } from './campaignAnalysis.js';
import { isRelevantRow, buildEntities } from './productAnalysis.js';
import { classifyEntities } from './decisionEngine.js';
import { computeTruePerformance } from './truePerformance.js';
import { resolveDateWindows, loadMetricsInRange, loadThresholds, resolveDecisionWindow } from '../routes/adsIntelligence.js';
import { getProductPerformance } from './amb/productPerformance.js';
import { buildProductDecisionPackage } from './amb/productDecision.js';
import { codCountsByGovernorate } from './amb/codOrders.js';
import { creativeIntelForProduct } from './amb/creativeIntel.js';
import { getScaleCenterProduct, getScaleCenterProductAudience, previewBumpForAdSet } from './amb/scaleCenter.js';
import { resolveWindow } from './amb/metricsEngine.js';
import { getAmbSettings } from './amb/settings.js';
import { attachProfitStates } from './amb/profitBrain.js';
import { buildTestMatrix, nextBestTest, buildControlledTestDesign } from './amb/testingBrain.js';
import { buildGrowthPlan } from './amb/growthStrategist.js';
import { buildTargetingStrategy } from './amb/targetingStrategy.js';
import { generateAngleProposals, generateHooks, generateCreativeIdeas } from './amb/productMarketingAI.js';
import { buildCodQualityReport } from './amb/codQualityBrain.js';
import { buildProductPlaybook } from './amb/productPlaybook.js';
import { resolveScaleLadderStage, STAGE_ORDER } from './amb/scaleLadder.js';
import { classifyProfitState } from './amb/profitBrain.js';
import { stockGuardForProduct } from './amb/stockGuard.js';
import { getConnection } from './metaAuth.js';

const LOST_ORDER_STATUSES = ['NEW', 'PROCESSING', 'CONTACTED', 'CUSTOMER_APPROVED', 'CUSTOMER_REJECTED', 'REPLACEMENT_CREATED', 'CLOSED'];

// Trims an entity from decisionEngine.js down to what the AI actually needs
// to reason about — the full shape includes heavy nested campaign/ad
// breakdowns meant for the UI drawer, not for a token-budget-limited tool
// result. Field names here match decisionEngine.js's real output shape
// exactly (entityName, flat spend/results/cpa via ...aggregateMetrics,
// problem as the reason text) — NOT a guessed shape; verified live against
// a real classified entity before this was written this way.
const RECOMMENDED_ACTION_BY_CLASSIFICATION = {
  SCALE: 'زيادة الميزانية — الأداء كويس والعائد مثبت',
  OPTIMIZE: 'مراجعة وتحسين — CPA في النطاق المتوسط، محتاج ضبط',
  STOP: 'إيقاف أو تقليل الصرف — CPA أعلى من الحد المسموح',
  COLLECT_MORE_DATA: 'استنى بيانات أكتر قبل أي قرار — الصرف أو عدد النتائج لسه قليل',
};
// `problem` is the real human-readable reason text decisionEngine.js
// already writes for OPTIMIZE/STOP/COLLECT_MORE_DATA — it's null for SCALE
// (a "why" isn't needed when everything's fine), so this fallback covers
// only that one honest gap, never invents a reason for an actual problem.
const FALLBACK_REASON_BY_CLASSIFICATION = { SCALE: 'الـ CPA تحت حد التوسع والبيانات كفاية لاتخاذ قرار.' };

function slimEntity(e) {
  return {
    entityType: e.entityType,
    entityKey: e.entityKey,
    name: e.entityName,
    classification: e.classification,
    priority: e.priority,
    confidence: e.confidence,
    spend: e.spend ?? null,
    results: e.results ?? null,
    cpa: e.cpa ?? null,
    reason: e.problem || FALLBACK_REASON_BY_CLASSIFICATION[e.classification] || null,
    recommendedAction: RECOMMENDED_ACTION_BY_CLASSIFICATION[e.classification] || null,
  };
}

export async function get_campaign_performance({ dateFrom, dateTo } = {}) {
  try {
    const windows = await resolveDateWindows(dateFrom, dateTo);
    if (!windows.current) return { ok: true, hasData: false, message: 'مفيش بيانات إعلانات مرفوعة أو متزامنة لسه.' };
    const rows = await loadMetricsInRange(windows.current);
    const relevant = rows.filter(isRelevantRow);
    const campaigns = aggregateByCampaign(relevant)
      .sort((a, b) => (b.spend || 0) - (a.spend || 0))
      .slice(0, 30) // cap — this tool answers "best/worst campaign" questions, not a full export
      .map((c) => ({ campaignName: c.campaignName, spend: c.spend, results: c.results, cpa: c.cpa, impressions: c.impressions, clicks: c.clicks }));
    return { ok: true, hasData: true, window: windows.current, campaignCount: campaigns.length, campaigns };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_decisions_summary({ dateFrom, dateTo } = {}) {
  try {
    const window = await resolveDecisionWindow(dateFrom, dateTo);
    if (!window) return { ok: true, hasData: false, message: 'مفيش بيانات إعلانات مرفوعة أو متزامنة لسه.' };
    const allRows = await prisma.adsDailyMetric.findMany({ where: { date: { gte: window.from, lte: window.to } } });
    const relevantRows = allRows.filter(isRelevantRow);
    if (relevantRows.length === 0) return { ok: true, hasData: true, window, message: 'مفيش حملات نشطة فيها صرف أو حالة Active في الفترة دي.' };

    const products = await prisma.product.findMany({ select: { id: true, product_name: true } });
    const thresholds = await loadThresholds();
    const { entities, buckets } = classifyEntities(buildEntities(relevantRows, products), thresholds);

    return {
      ok: true,
      hasData: true,
      window,
      thresholds,
      totalEntities: entities.length,
      buckets: {
        scale: buckets.scale.map(slimEntity),
        optimize: buckets.optimize.map(slimEntity),
        stop: buckets.stop.map(slimEntity),
        collectMoreData: buckets.collectMoreData.map(slimEntity),
        opportunities: buckets.opportunities.map(slimEntity),
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_product_profit({ dateFrom, dateTo, productId } = {}) {
  try {
    const data = await computeTruePerformance({ dateFrom, dateTo, productId });
    const settings = await getAmbSettings();
    const products = await attachProfitStates(data.products, settings);
    return { ok: true, ...data, products };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_order_metrics({ dateFrom, dateTo } = {}) {
  try {
    const where = {};
    if (dateFrom && dateTo) where.date = { gte: dateFrom, lte: dateTo };
    else if (dateFrom) where.date = { gte: dateFrom };
    else if (dateTo) where.date = { lte: dateTo };

    const rows = await prisma.easyOrdersOrder.findMany({ where });
    const byOrder = new Map();
    for (const r of rows) if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, r.status);
    const statuses = [...byOrder.values()];
    const total = statuses.length;
    const counts = {
      PENDING: statuses.filter((s) => s === 'PENDING').length,
      CONFIRMED: statuses.filter((s) => s === 'CONFIRMED').length,
      DELIVERED: statuses.filter((s) => s === 'DELIVERED').length,
      RETURNED: statuses.filter((s) => s === 'RETURNED').length,
      CANCELLED: statuses.filter((s) => s === 'CANCELLED').length,
    };
    const confirmable = total - counts.PENDING;
    return {
      ok: true,
      hasData: total > 0,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      totalOrders: total,
      counts,
      confirmationRate: confirmable > 0 ? Math.round(((counts.CONFIRMED + counts.DELIVERED + counts.RETURNED) / confirmable) * 1000) / 10 : null,
      deliveryRate: counts.CONFIRMED + counts.DELIVERED + counts.RETURNED > 0 ? Math.round((counts.DELIVERED / (counts.CONFIRMED + counts.DELIVERED + counts.RETURNED)) * 1000) / 10 : null,
      returnRate: counts.DELIVERED + counts.RETURNED > 0 ? Math.round((counts.RETURNED / (counts.DELIVERED + counts.RETURNED)) * 1000) / 10 : null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_lost_orders_summary() {
  try {
    const rows = await prisma.lostOrder.groupBy({ by: ['processing_status'], _count: true });
    const counts = Object.fromEntries(LOST_ORDER_STATUSES.map((s) => [s, 0]));
    for (const r of rows) counts[r.processing_status] = r._count;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      ok: true,
      hasData: total > 0,
      total,
      new: counts.NEW,
      processing: counts.PROCESSING + counts.CONTACTED + counts.CUSTOMER_APPROVED + counts.CUSTOMER_REJECTED,
      replacementCreated: counts.REPLACEMENT_CREATED,
      closed: counts.CLOSED,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_inventory_status() {
  try {
    const products = await prisma.product.findMany({
      where: { active: true },
      select: { id: true, product_name: true, current_stock: true, minimum_stock: true },
    });
    const withStockData = products.filter((p) => p.current_stock !== null && p.current_stock !== undefined);
    const lowStock = withStockData
      .filter((p) => p.minimum_stock !== null && p.minimum_stock !== undefined && p.current_stock <= p.minimum_stock)
      .map((p) => ({ productId: p.id, productName: p.product_name, currentStock: p.current_stock, minimumStock: p.minimum_stock }))
      .sort((a, b) => a.currentStock - b.currentStock);
    return {
      ok: true,
      hasData: withStockData.length > 0,
      trackedProducts: withStockData.length,
      lowStockCount: lowStock.length,
      lowStock: lowStock.slice(0, 20),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// AMB (🧠 مركز القرار الذكي / 🚀 مركز التوسّع) tools — `get_amb_*`. These wrap
// the ACTIVELY-MAINTAINED, dataState-honest product pipeline in
// services/amb/*, which is a SEPARATE, independently-computed system from
// the 6 tools above (those wrap campaignAnalysis.js/decisionEngine.js/
// truePerformance.js/adsIntelligence.js). The two pipelines can disagree on
// CPA/classification for the same product because neither reads the other's
// numbers — never blend them in one answer. For any question about a
// specific product's real ad performance, Decision Center, Scale Center, or
// Launch Builder, prefer these over get_product_profit/get_campaign_performance
// (see SYSTEM_PROMPT_AMB_NOTE below, appended by routes/aiAssistant.js).
async function resolveAmbAdAccountId() {
  const connection = await getConnection();
  return connection?.selected_ad_account_id || null;
}

export async function get_amb_product_performance({ productId, window } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const w = resolveWindow(window || 'last7');
    const data = await getProductPerformance({ productId: Number(productId), from: w.from, to: w.to });
    return { ok: true, hasData: data?.meta?.dataState === 'AVAILABLE' || data?.easyOrders?.dataState === 'AVAILABLE', window: w, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_amb_product_decision({ productId, window } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const settings = await getAmbSettings();
    const adAccountId = await resolveAmbAdAccountId();
    const pkg = await buildProductDecisionPackage({ productId: Number(productId), windowName: window || 'last7', settings, adAccountId });
    return {
      ok: true,
      hasData: true,
      productId: pkg.productId,
      productName: pkg.productName,
      window: pkg.window,
      decision: pkg.decision,
      confidence: pkg.confidence,
      reason: pkg.reason,
      health: pkg.health,
      dataQuality: pkg.dataQuality,
      businessConversionRate: pkg.businessConversionRate,
      winners: pkg.winners,
      losers: pkg.losers,
      proposedChange: pkg.proposedChange,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_testing_brain({ productId, window } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const settings = await getAmbSettings();
    const adAccountId = await resolveAmbAdAccountId();
    const pkg = await buildProductDecisionPackage({ productId: Number(productId), windowName: window || 'last7', settings, adAccountId });
    const { matrix, hasProfile } = await buildTestMatrix({ productId: Number(productId), pkg });
    const next = nextBestTest({ pkg, testMatrix: matrix });
    const design = buildControlledTestDesign({ pkg, next });
    return {
      ok: true, hasData: true, productId: pkg.productId, productName: pkg.productName, window: pkg.window,
      hasMarketingProfile: hasProfile, testMatrix: matrix, nextBestTest: next, controlledTestDesign: design,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_growth_plan({ productId, window } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const settings = await getAmbSettings();
    const adAccountId = await resolveAmbAdAccountId();
    const pkg = await buildProductDecisionPackage({ productId: Number(productId), windowName: window || 'last7', settings, adAccountId });

    const product = await prisma.product.findUnique({
      where: { id: Number(productId) },
      select: { store_id: true, selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true, commission: true, expected_return_cost: true },
    });
    const trueRows = await computeTruePerformance({ productId: Number(productId) });
    const profitBrain = classifyProfitState(trueRows.products?.[0] || { real: { actualOrders: 0 } }, product || {}, settings);
    const stockGuard = await stockGuardForProduct({ productId: Number(productId), storeId: product?.store_id, days: settings.ambStockGuardVelocityWindowDays });

    const plan = await buildGrowthPlan({ productId: Number(productId), pkg, profitBrain, stockGuard });
    return { ok: true, hasData: true, ...plan };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_targeting_strategy({ productId, window } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const settings = await getAmbSettings();
    const adAccountId = await resolveAmbAdAccountId();
    const pkg = await buildProductDecisionPackage({ productId: Number(productId), windowName: window || 'last7', settings, adAccountId });
    const strategy = buildTargetingStrategy({ pkg });
    return { ok: true, hasData: true, productId: pkg.productId, productName: pkg.productName, window: pkg.window, ...strategy };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Real, already-known angle labels for this product (Testing Brain's own ANGLE-dimension keys) — passed to the AI so it never re-proposes something already tried, and never invents "existing angles" that don't exist. */
async function knownAnglesFor(productId, pkg) {
  const { matrix } = await buildTestMatrix({ productId, pkg });
  return [...new Set(matrix.filter((e) => e.dimension === 'ANGLE').map((e) => e.key))];
}

export async function generate_angles({ productId, count } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const product = await prisma.product.findUnique({ where: { id: Number(productId) }, select: { product_name: true } });
    if (!product) return { ok: false, error: 'المنتج غير موجود.' };
    const settings = await getAmbSettings();
    const adAccountId = await resolveAmbAdAccountId();
    const pkg = await buildProductDecisionPackage({ productId: Number(productId), windowName: 'last7', settings, adAccountId }).catch(() => null);
    const existingAngles = pkg ? await knownAnglesFor(Number(productId), pkg) : [];
    const bottleneckContext = pkg?.diagnosis?.bottleneck?.evidence || null;
    const res = await generateAngleProposals({ productName: product.product_name, existingAngles, bottleneckContext, count: count || 3 });
    if (!res.ok) return { ok: false, error: res.reason };
    return { ok: true, angles: res.angles, existingAnglesConsidered: existingAngles };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function generate_hooks({ productId, angle, category, count } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const product = await prisma.product.findUnique({ where: { id: Number(productId) }, select: { product_name: true } });
    if (!product) return { ok: false, error: 'المنتج غير موجود.' };
    const res = await generateHooks({ productName: product.product_name, angle, category, count: count || 10 });
    if (!res.ok) return { ok: false, error: res.reason };
    return { ok: true, hooks: res.hooks };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function generate_creative_brief({ productId, angle, count } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const product = await prisma.product.findUnique({ where: { id: Number(productId) }, select: { product_name: true } });
    if (!product) return { ok: false, error: 'المنتج غير موجود.' };
    const res = await generateCreativeIdeas({ productName: product.product_name, angle, count: count || 4 });
    if (!res.ok) return { ok: false, error: res.reason };
    return { ok: true, ideas: res.ideas };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_cod_quality({ productId, window } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const settings = await getAmbSettings();
    const adAccountId = await resolveAmbAdAccountId();
    const w = resolveWindow(window || 'last7');
    const pkg = await buildProductDecisionPackage({ productId: Number(productId), windowName: window || 'last7', settings, adAccountId });
    const product = await prisma.product.findUnique({ where: { id: Number(productId) }, select: { store_id: true } });
    const report = await buildCodQualityReport({ productId: Number(productId), storeId: product?.store_id, from: w.from, to: w.to, pkg });
    return { ok: true, hasData: true, productId: pkg.productId, productName: pkg.productName, window: w, ...report };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_product_playbook({ productId, window } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const settings = await getAmbSettings();
    const adAccountId = await resolveAmbAdAccountId();
    const w = resolveWindow(window || 'last7');
    const [pkg, ambProduct, product] = await Promise.all([
      buildProductDecisionPackage({ productId: Number(productId), windowName: window || 'last7', settings, adAccountId }),
      prisma.ambProduct.findUnique({ where: { product_id: Number(productId) }, select: { id: true } }),
      prisma.product.findUnique({ where: { id: Number(productId) }, select: { store_id: true, selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true, commission: true, expected_return_cost: true } }),
    ]);
    const trueRows = await computeTruePerformance({ productId: Number(productId) });
    const profitBrain = classifyProfitState(trueRows.products?.[0] || { real: { actualOrders: 0 } }, product || {}, settings);
    const codReport = await buildCodQualityReport({ productId: Number(productId), storeId: product?.store_id, from: w.from, to: w.to, pkg });

    const playbook = await buildProductPlaybook({ productId: Number(productId), ambProductId: ambProduct?.id || null, profitBrain, codReport });
    return { ok: true, hasData: true, productId: pkg.productId, productName: pkg.productName, ...playbook };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_scale_ladder({ productId, window } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const settings = await getAmbSettings();
    const adAccountId = await resolveAmbAdAccountId();
    const pkg = await buildProductDecisionPackage({ productId: Number(productId), windowName: window || 'last7', settings, adAccountId });

    const { matrix } = await buildTestMatrix({ productId: Number(productId), pkg });
    const product = await prisma.product.findUnique({
      where: { id: Number(productId) },
      select: { selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true, commission: true, expected_return_cost: true },
    });
    const trueRows = await computeTruePerformance({ productId: Number(productId) });
    const profitBrain = classifyProfitState(trueRows.products?.[0] || { real: { actualOrders: 0 } }, product || {}, settings);

    const creativeFatigueStates = [
      ...(pkg.creativeIntel?.creative?.table || []),
      ...(pkg.creativeIntel?.hooks?.table || []),
      ...(pkg.creativeIntel?.angles?.table || []),
    ].map((r) => r.fatigueRadar?.state).filter(Boolean);

    const ladder = resolveScaleLadderStage({ pkg, testMatrix: matrix, profitBrain, creativeFatigueStates });
    return { ok: true, hasData: true, productId: pkg.productId, productName: pkg.productName, stageOrder: STAGE_ORDER, ...ladder };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_amb_audience_breakdown({ productId, window } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const data = await getScaleCenterProductAudience({ productId: Number(productId), windowName: window || 'last7' });
    return { ok: true, hasData: !!data.available, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_amb_governorate_breakdown({ productId, window, storeId } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const w = resolveWindow(window || 'last7');
    const rows = await codCountsByGovernorate({ productId: Number(productId), storeId: storeId || null, from: w.from, to: w.to });
    return { ok: true, hasData: rows.length > 0, window: w, governorates: rows.sort((a, b) => b.orders - a.orders).slice(0, 30) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_amb_creative_intel({ productId, window } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const ambProduct = await prisma.ambProduct.findUnique({ where: { product_id: Number(productId) }, select: { id: true } });
    if (!ambProduct) return { ok: true, hasData: false, message: 'المنتج ده مش متتبع في مركز القرار الذكي لسه.' };
    const adAccountId = await resolveAmbAdAccountId();
    if (!adAccountId) return { ok: true, hasData: false, message: 'مفيش حساب إعلاني متصل.' };
    const settings = await getAmbSettings();
    const data = await creativeIntelForProduct({ adAccountId, windowName: window || 'last7', settings, ambProductId: ambProduct.id, compareToPrior: true });
    return { ok: true, hasData: !!data.dataAvailable, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_amb_scale_center_product({ productId, window, storeId } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const row = await getScaleCenterProduct({ productId: Number(productId), storeId: storeId || null, windowName: window || 'last7' });
    return { ok: true, hasData: true, ...row };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_amb_bump_preview({ adSetId, pct } = {}) {
  try {
    if (!adSetId) return { ok: false, error: 'adSetId مطلوب.' };
    const data = await previewBumpForAdSet({ adSetId: String(adSetId), pct: pct || 25 });
    return { ok: true, hasData: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Anthropic tool-use schema definitions — kept next to the implementations
// so a new tool can never be registered without its matching function
// (see TOOL_IMPLS below, and the equality check the assistant route runs
// against it on startup).
export const TOOL_DEFINITIONS = [
  {
    name: 'get_campaign_performance',
    description: 'يجيب أداء الحملات الإعلانية الحقيقي (Meta Ads) لفترة تاريخ معينة — الصرف، النتائج، CPA لكل حملة، مرتبة من الأعلى صرفًا. استخدمه لأسئلة زي "أفضل حملة" أو "أداء الحملات".',
    input_schema: {
      type: 'object',
      properties: {
        dateFrom: { type: 'string', description: 'تاريخ البداية YYYY-MM-DD، اختياري' },
        dateTo: { type: 'string', description: 'تاريخ النهاية YYYY-MM-DD، اختياري' },
      },
    },
  },
  {
    name: 'get_decisions_summary',
    description: 'يجيب تصنيف القرارات الحقيقي للمنتجات/الحملات (SCALE / OPTIMIZE / STOP / COLLECT_MORE_DATA / opportunities) بناءً على الحدود المضبوطة في النظام. استخدمه لأسئلة زي "فين بنخسر؟" أو "فرص Scaling".',
    input_schema: {
      type: 'object',
      properties: {
        dateFrom: { type: 'string', description: 'تاريخ البداية YYYY-MM-DD، اختياري' },
        dateTo: { type: 'string', description: 'تاريخ النهاية YYYY-MM-DD، اختياري' },
      },
    },
  },
  {
    name: 'get_product_profit',
    description: 'يجيب الربح الحقيقي لكل منتج — صرف Meta، أوردرات حقيقية، تم التسليم، مرتجعات، صافي الربح، True CPA، True ROAS، وحالة الربح الحقيقية (profitState: PROFITABLE/MARGIN_THIN/BREAK_EVEN/UNPROFITABLE/PARTIAL_DATA/INSUFFICIENT_DATA) مبنية على هامش الربح الحقيقي، مش على الـ CPA لوحده. استخدمه لأسئلة زي "إحنا كسبنا كام" أو "أفضل منتج مربح" أو "المنتج ده بيكسب فعلاً؟".',
    input_schema: {
      type: 'object',
      properties: {
        dateFrom: { type: 'string', description: 'تاريخ البداية YYYY-MM-DD، اختياري' },
        dateTo: { type: 'string', description: 'تاريخ النهاية YYYY-MM-DD، اختياري' },
        productId: { type: 'integer', description: 'رقم منتج معين لو السؤال عن منتج واحد بس، اختياري' },
      },
    },
  },
  {
    name: 'get_order_metrics',
    description: 'يجيب إحصائيات الأوردرات الحقيقية من EasyOrders — نسبة التأكيد، نسبة التسليم، نسبة المرتجعات لفترة معينة.',
    input_schema: {
      type: 'object',
      properties: {
        dateFrom: { type: 'string', description: 'تاريخ البداية YYYY-MM-DD، اختياري' },
        dateTo: { type: 'string', description: 'تاريخ النهاية YYYY-MM-DD، اختياري' },
      },
    },
  },
  {
    name: 'get_lost_orders_summary',
    description: 'يجيب ملخص الأوردرات المفقودة/المرتجعة الحقيقي (جديد، قيد المعالجة، تم إنشاء بديل، مغلق).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_inventory_status',
    description: 'يجيب حالة المخزون الحقيقية — المنتجات اللي مخزونها وصل أو أقل من الحد الأدنى.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_amb_product_performance',
    description: '[مركز القرار الذكي / مركز التوسّع] أداء منتج واحد الحقيقي من Meta + Easy Orders (صرف، CPA، LPV، أوردرات) ونسبة التحويل الصحيحة (Purchase Results×100/LPV). استخدم ده بدل get_product_profit لأي سؤال عن أداء منتج معين في صفحات مركز القرار/مركز التوسّع.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        window: { type: 'string', description: 'today | yesterday | last3 | last7 | last14 | last30 | last90، افتراضي last7' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'get_amb_product_decision',
    description: '[مركز القرار الذكي] الحزمة الكاملة لقرار منتج: التصنيف (SCALE_CANDIDATE/KEEP_TESTING/PAUSE_CANDIDATE/...)، سبب القرار، بوابة جودة البيانات (VERIFIED/WARNING/BLOCKED)، الكرياتيف الفايز/الخاسر، فرصة تعديل السعر. استخدم ده لأسئلة "هل المنتج ده جاهز للتوسع؟" أو "ليه المنتج ده متوقف؟".',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        window: { type: 'string', description: 'today | yesterday | last3 | last7 | last14 | last30 | last90، افتراضي last7' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'get_testing_brain',
    description: '[Testing Brain] تاريخ اختبارات المنتج الكامل موحّد من كل المصادر الحقيقية (ذاكرة التعلم + الكرياتيف/الجمهور الحالي + اختبارات مركز التسويق) — لكل بُعد (كرياتيف/Hook/زاوية/جمهور/محافظة/عرض): TESTED/TESTING/WON/LOST/INCONCLUSIVE/NOT_TESTED. كمان بيرجع أفضل اختبار تالي مقترح بناءً على العنق الحقيقي (Bottleneck) الحالي، مع تصميم اختبار كامل (دليل/فرضية/متغيّر/Control/Variant/مقياس نجاح). استخدمه لأسئلة "إيه اللي اتجرب قبل كده؟" أو "أختبر إيه بعد كده؟".',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        window: { type: 'string', description: 'today | yesterday | last3 | last7 | last14 | last30 | last90، افتراضي last7' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'get_growth_plan',
    description: '[🧠 خطة النمو] "المنتج ده مش عارف أطلعه، أعمل إيه؟" — خطة إخراج كاملة تجمع كل الأدلة الحقيقية (القمع الإعلاني/الربح/المخزون/الكرياتيف/الجمهور/Testing Brain) في مكان واحد: الحالة الحالية، العنق الحقيقي (مع فصل واضح بين الدليل والفرضية)، إيه اللي شغال وإيه اللي مش شغال، إيه اللي لازم يفضل زي ما هو، الاختبار التالي المقترح، الاستهداف/الزاوية/الهوك الفائز، فرصة تعديل السعر لو موجودة، ومقياس النجاح. استخدمه لأي سؤال شامل عن "أطلع المنتج إزاي" أو "اعمللي خطة للمنتج".',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        window: { type: 'string', description: 'today | yesterday | last3 | last7 | last14 | last30 | last90، افتراضي last7' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'get_targeting_strategy',
    description: '[🎯 استراتيجية الاستهداف] يقسّم استهداف المنتج لثلاث رؤى منفصلة دايمًا: (1) الأعلى حاليًا — القائد الحالي بالأرقام مهما كان مبكر، (2) Scale Targeting — بس الأبعاد المثبتة بأدلة قوية (PROVEN)، أو Broad صراحة لو مفيش دليل كافٍ، (3) Test Targeting — الأبعاد الواعدة (PROMISING/EARLY_SIGNAL) اللي تستاهل اختبار. ممنوع تترقّى إشارة مبكرة لاستهداف Scale تلقائيًا. استخدمه لأسئلة "أستهدف مين؟" أو "أنهي عمر/جنس/محافظة؟".',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        window: { type: 'string', description: 'today | yesterday | last3 | last7 | last14 | last30 | last90، افتراضي last7' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'generate_angles',
    description: '[💡 توليد زوايا جديدة — لا يُستخدم تلقائيًا] يقترح زوايا بيع جديدة (Selling Angles) لمنتج — كل زاوية فيها: الاسم، ليه بتناسب، الـpersona المستهدفة، الوعد الأساسي، اتجاه الـHook، اتجاه الكرياتيف، والفرضية اللي بتختبرها. يتجنب تلقائيًا الزوايا المجربة قبل كده (من Testing Brain). كل زاوية تبدأ بحالة PROPOSED — ممنوع تقول إنها فائزة قبل ما الأداء الحقيقي يثبت كده. اعرضها على المستخدم كمسودة يوافق عليها.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        count: { type: 'integer', description: 'عدد الزوايا المطلوبة، افتراضي 3' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'generate_hooks',
    description: '[🎣 توليد Hooks — لا يُستخدم تلقائيًا] يكتب Hooks إعلانية مصرية لمنتج ولزاوية معينة، مع تصنيف أمان الادّعاءات لكل Hook. اعرضها على المستخدم كمسودة يوافق عليها قبل الاستخدام في أي كامبين.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        angle: { type: 'string', description: 'الزاوية المطلوب كتابة Hooks لها، اختياري' },
        category: { type: 'string', description: 'نوع Hook معين لو مطلوب، اختياري' },
        count: { type: 'integer', description: 'عدد الـHooks، افتراضي 10' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'generate_creative_brief',
    description: '[🎥 Creative Brief — لا يُستخدم تلقائيًا ولا يستهلك رصيد توليد صور/فيديو] يقترح أفكار كرياتيف عملية وقابلة للتنفيذ (نوع المحتوى، المشهد، الـHook، ظهور المنتج، النص الأساسي، CTA، الجمهور المستهدف) لمنتج وزاوية معينة — تعليمات جاهزة تُستخدم بمعرفة مصنع الكرياتيف أو مصمم بشري، مش توليد فعلي. استخدمه لما المستخدم يقول "اعملي Creative Brief".',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        angle: { type: 'string', description: 'الزاوية المطلوب بناء الأفكار عليها، اختياري' },
        count: { type: 'integer', description: 'عدد الأفكار، افتراضي 4' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'get_cod_quality',
    description: '[🚚 جودة الـCOD] تفاصيل الأوردرات الحقيقية من Easy Orders لمنتج معين — العدد الكلي، قيد الانتظار، مؤكد، ملغي، تم التسليم، مرتجع، مع نسب التأكيد/الإلغاء/التسليم/الإرجاع. وتوزيع حقيقي على المحافظات مُرتَّب بالدليل (مثبت/واعد/غير كافٍ) مش بعدد الأوردرات الخام بس. يوضّح صراحة لو جودة الـCOD هي سبب عدم التوسع حتى لو الـCPA من Meta كويس. استخدمه لأسئلة "التأكيد كام؟" أو "المحافظة دي كويسة ولا لأ؟" أو "المخزون/التسليم بيمنع Scale؟".',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        window: { type: 'string', description: 'today | yesterday | last3 | last7 | last14 | last30 | last90، افتراضي last7' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'get_product_playbook',
    description: '[📘 دليل المنتج] كل اللي اتعلمناه عن المنتج ده مع الوقت — أفضل Angle/Hook/جمهور/محافظة/كرياتيف أثبتوا نفسهم فعلاً (مع العينة وآخر تأكيد)، وتاريخ القرارات الحقيقية (Scale/اختبار/إيقاف) اللي اتاخدت له، ولقطة حالية من الربح وجودة الـCOD. استخدمه لأسئلة "إيه اللي اتعلمناه عن المنتج؟" أو "أنهي Angle كان أنجح؟" أو "مين أفضل جمهور تاريخيًا؟" أو "آخر Creative Winner كان إيه؟".',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        window: { type: 'string', description: 'today | yesterday | last3 | last7 | last14 | last30 | last90، افتراضي last7 (بيأثر بس على لقطة الربح/الـCOD الحالية، مش على التاريخ)' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'get_scale_ladder',
    description: '[📈 سلم التوسع] المرحلة التشغيلية الحالية للمنتج (NEW → TESTING → SIGNAL_FOUND → VALIDATED → SCALE_CAMPAIGN → STABLE → FATIGUE → REFRESH) — مبنية على القرار الحقيقي وTesting Brain وحالة الربح وإجهاد الكرياتيف، مش قاعدة صارمة. بترجع المرحلة الحالية، السبب، المرحلة التالية الممكنة، والعوائق اللي لازم تتحل الأول. استخدمه لأسئلة زي "المنتج ده وصل لفين؟" أو "الخطوة الجاية إيه؟".',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        window: { type: 'string', description: 'today | yesterday | last3 | last7 | last14 | last30 | last90، افتراضي last7' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'get_amb_audience_breakdown',
    description: '[مركز التوسّع] تقسيم الجمهور الحقيقي من Meta (العمر والنوع) لحملات منتج معين — مين بيشتري، رجالة ولا ستات، ومن أي فئة عمرية.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        window: { type: 'string', description: 'today | yesterday | last3 | last7 | last14 | last30 | last90، افتراضي last7' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'get_amb_governorate_breakdown',
    description: '[مركز التوسّع] توزيع الأوردرات الحقيقي (Easy Orders) لمنتج معين على المحافظات — عدد الأوردرات، المؤكد، المتسلم، المرتجع لكل محافظة.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        window: { type: 'string', description: 'today | yesterday | last3 | last7 | last14 | last30 | last90، افتراضي last7' },
        storeId: { type: 'string', description: 'فلترة على متجر معين، اختياري' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'get_amb_creative_intel',
    description: '[مركز القرار الذكي] تحليل الكرياتيف الحقيقي لمنتج معين — أي فيديو/صورة هو الفايز الحالي، الأداء مقارنة بالباقي، وحالة الإجهاد (fatigueRadar: NEW/LEARNING/HEALTHY/WATCH/FATIGUING/FATIGUED/INSUFFICIENT_DATA) لكل كرياتيف/Hook/زاوية — استخدمه لأسئلة زي "الكرياتيف الفائز بدأ يضعف؟".',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        window: { type: 'string', description: 'today | yesterday | last3 | last7 | last14 | last30 | last90، افتراضي last7' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'get_amb_scale_center_product',
    description: '[مركز التوسّع] صف مركز التوسّع الكامل لمنتج معين — الأداء + القرار + جودة البيانات + أعلى 3 محافظات + هل مؤهل لـ Scale أو Bump ولية.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        window: { type: 'string', description: 'today | yesterday | last3 | last7 | last14 | last30 | last90، افتراضي last7' },
        storeId: { type: 'string', description: 'فلترة على متجر معين، اختياري' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'get_amb_bump_preview',
    description: '[مركز التوسّع] معاينة زيادة ميزانية Ad Set حقيقي عند نسبة معينة — الميزانية الحالية والمقترحة، الـ CPA، هل فيه فترة تهدئة (cooldown) تمنع الزيادة دلوقتي. قراءة فقط — لا يغيّر أي ميزانية فعليًا.',
    input_schema: {
      type: 'object',
      properties: {
        adSetId: { type: 'string', description: 'رقم Ad Set في Meta' },
        pct: { type: 'number', description: 'نسبة الزيادة المطلوبة، افتراضي 25' },
      },
      required: ['adSetId'],
    },
  },
];

export const TOOL_IMPLS = {
  get_campaign_performance,
  get_decisions_summary,
  get_product_profit,
  get_order_metrics,
  get_lost_orders_summary,
  get_inventory_status,
  get_amb_product_performance,
  get_amb_product_decision,
  get_testing_brain,
  get_growth_plan,
  get_targeting_strategy,
  generate_angles,
  generate_hooks,
  generate_creative_brief,
  get_cod_quality,
  get_product_playbook,
  get_scale_ladder,
  get_amb_audience_breakdown,
  get_amb_governorate_breakdown,
  get_amb_creative_intel,
  get_amb_scale_center_product,
  get_amb_bump_preview,
};

// A dedicated tool subset + prompt note for the GLOBAL assistant bubble
// (routes/aiAssistant.js's /chat, called from every page) — keeps the
// original ai-command-center.js's tool list untouched (still every tool,
// covering both pipelines for its "AI E-Commerce Operating System" scope)
// while the new global bubble leads with the AMB layer, since it's mounted
// on the AMB-driven pages (Scale Center, Decision Center, Launch Builder).
export const AMB_TOOL_NAMES = ['get_amb_product_performance', 'get_amb_product_decision', 'get_testing_brain', 'get_growth_plan', 'get_targeting_strategy', 'generate_angles', 'generate_hooks', 'generate_creative_brief', 'get_cod_quality', 'get_product_playbook', 'get_scale_ladder', 'get_amb_audience_breakdown', 'get_amb_governorate_breakdown', 'get_amb_creative_intel', 'get_amb_scale_center_product', 'get_amb_bump_preview'];
