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
    return { ok: true, ...data };
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
    const data = await creativeIntelForProduct({ adAccountId, windowName: window || 'last7', settings, ambProductId: ambProduct.id, compareToPrior: false });
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
    description: 'يجيب الربح الحقيقي لكل منتج — صرف Meta، أوردرات حقيقية، تم التسليم، مرتجعات، صافي الربح، True CPA، True ROAS. استخدمه لأسئلة زي "إحنا كسبنا كام" أو "أفضل منتج مربح".',
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
    description: '[مركز القرار الذكي] تحليل الكرياتيف الحقيقي لمنتج معين — أي فيديو/صورة هو الفايز الحالي، الأداء مقارنة بالباقي.',
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
export const AMB_TOOL_NAMES = ['get_amb_product_performance', 'get_amb_product_decision', 'get_amb_audience_breakdown', 'get_amb_governorate_breakdown', 'get_amb_creative_intel', 'get_amb_scale_center_product', 'get_amb_bump_preview'];
