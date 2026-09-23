// AI Media Buyer — Profit Brain (Product Growth & Profit Intelligence,
// Phase 3 Slice 1). Answers "المنتج ده بيكسب فعلاً؟" with a real, threshold-
// based state — never CPA-vs-target alone. Wraps the EXISTING, already
// chat-exposed truePerformance.js engine (js/profit.js's revenue/netProfit
// math over real Product cost fields + real EasyOrders/DailyOrder counts) —
// never a third profit engine, never edits truePerformance.js itself so its
// other consumer (the true-performance route) keeps its exact existing shape.
import { prisma } from '../../prisma.js';
import { computeTruePerformance } from '../truePerformance.js';

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/**
 * 'KNOWN' | 'ESTIMATED' | 'NOT_CONFIGURED' — never invents a missing cost.
 * selling_price/product_cost <= 0 (the codebase's own existing precedent for
 * "unset", e.g. productEconomics.js's effectiveSellingPrice() >0 check) means
 * no honest profit number is possible at all -> NOT_CONFIGURED. The
 * secondary costs (shipping/packaging/other/commission/expected_return_cost)
 * still sitting at their default of 0 means a number CAN be computed but
 * rests on an assumption -> ESTIMATED.
 */
export function economicsConfigState(product) {
  const sp = num(product?.selling_price);
  const cost = num(product?.product_cost);
  if (sp === null || sp <= 0 || cost === null || cost <= 0) return 'NOT_CONFIGURED';
  const secondary = [product?.shipping_cost, product?.packaging_cost, product?.other_cost, product?.commission, product?.expected_return_cost];
  const anyEstimated = secondary.some((v) => num(v) === null || num(v) === 0);
  return anyEstimated ? 'ESTIMATED' : 'KNOWN';
}

/**
 * `row` = one item of computeTruePerformance()'s `products` array; `product`
 * = the real Product row (for economicsConfigState). Never judges from CPA
 * alone — classifies from the real net margin.
 */
export function classifyProfitState(row, product, settings) {
  const configState = economicsConfigState(product);
  const actualOrders = num(row?.real?.actualOrders) ?? 0;
  if (actualOrders <= 0) {
    return { state: 'INSUFFICIENT_DATA', configState, marginPct: null, profitPerOrder: null, reason: 'مفيش أوردرات حقيقية كفاية في الفترة دي للحكم على الربح.' };
  }
  if (configState === 'NOT_CONFIGURED') {
    return { state: 'PARTIAL_DATA', configState, marginPct: null, profitPerOrder: null, reason: 'سعر البيع أو تكلفة المنتج غير مسجلة — مينفعش نحسب ربح حقيقي دقيق دلوقتي.' };
  }

  const netProfit = num(row?.real?.netProfit);
  const revenue = num(row?.real?.actualRevenue);
  if (netProfit === null || revenue === null || revenue <= 0) {
    return { state: 'PARTIAL_DATA', configState, marginPct: null, profitPerOrder: null, reason: 'الإيرادات الحقيقية غير كافية لحساب هامش الربح لهذه الفترة.' };
  }

  const marginPct = (netProfit / revenue) * 100;
  const deliveredOrCount = num(row?.real?.deliveredOrders) || actualOrders;
  const profitPerOrder = deliveredOrCount > 0 ? netProfit / deliveredOrCount : null;

  const band = Number(settings?.ambProfitBreakEvenBandPct) || 3;
  const thinPct = Number(settings?.ambProfitMarginThinPct) || 15;

  let state;
  if (marginPct < -band) state = 'UNPROFITABLE';
  else if (marginPct <= band) state = 'BREAK_EVEN';
  else if (marginPct <= thinPct) state = 'MARGIN_THIN';
  else state = 'PROFITABLE';

  return { state, configState, marginPct, profitPerOrder, reason: null };
}

/** Batched — attaches {profitState:{state,configState,marginPct,profitPerOrder,reason}} to every row from get_product_profit's existing computeTruePerformance() result, one product query for the whole list. */
export async function attachProfitStates(rows, settings) {
  if (!rows?.length) return rows;
  const productIds = rows.map((r) => r.productId).filter(Boolean);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true, commission: true, expected_return_cost: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  return rows.map((row) => ({ ...row, profitState: classifyProfitState(row, byId.get(row.productId) || {}, settings) }));
}

/** One-product composition for prepare_scale's Money Guard gate — same computeTruePerformance() engine, scoped to the exact operational window the SCALE_CANDIDATE verdict itself used. */
export async function getProductProfitBrain({ productId, dateFrom, dateTo }) {
  const { getAmbSettings } = await import('./settings.js');
  const settings = await getAmbSettings();
  const data = await computeTruePerformance({ dateFrom, dateTo, productId: Number(productId) });
  const row = data.products?.[0] || { productId: Number(productId), real: { actualOrders: 0 } };
  const product = await prisma.product.findUnique({
    where: { id: Number(productId) },
    select: { selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true, commission: true, expected_return_cost: true },
  });
  return classifyProfitState(row, product || {}, settings);
}
