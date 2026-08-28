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
];

export const TOOL_IMPLS = {
  get_campaign_performance,
  get_decisions_summary,
  get_product_profit,
  get_order_metrics,
  get_lost_orders_summary,
  get_inventory_status,
};
