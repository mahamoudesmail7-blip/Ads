// Product Marketing Intelligence — real Customer-quality summary for one
// product over a date window. Built entirely from Easy Orders' own real
// order data + the Customer Database (services/customers.js) — never
// invents a number, mirrors the exact byOrder-dedup + status-classification
// convention already used by services/amb/codOrders.js's
// codCountsForProduct/codCountsByGovernorate (kept as a separate file
// rather than added there, to avoid entangling with that file's own
// paused, unrelated multi-store `storeId` work).
import { prisma } from '../../prisma.js';
import { bandMarket } from './productMarketingScoring.js';
import { normalizeGovernorateName } from './governorateNormalize.js';

const EMPTY_RESULT = {
  source: 'none', orders: null, confirmed: null, delivered: null, returned: null, cancelled: null,
  confirmationRate: null, deliveryRate: null, rtoRate: null, revenue: null, deliveredRevenue: null,
  customerCount: null, repeatCustomerCount: null, governorates: [],
};

/**
 * "Repeat customer" here means: a distinct customer who ordered THIS
 * product and whose OVERALL total_orders (across every product, from the
 * real Customer Database) is more than 1 — i.e. a genuine repeat buyer of
 * the store, not necessarily of this exact product more than once (that
 * finer-grained signal isn't tracked per-product on Customer today).
 *
 * @param {{productId:number, storeId?:string, from?:string, to?:string}} params (from/to = YYYY-MM-DD inclusive)
 */
export async function customerQualityForProduct({ productId, storeId, from, to }) {
  const dateFilter = {};
  if (from) dateFilter.gte = from;
  if (to) dateFilter.lte = to;
  const where = { product_id: productId };
  if (storeId) where.store_id = storeId;
  if (from || to) where.date = dateFilter;

  const rows = await prisma.easyOrdersOrder.findMany({
    where,
    select: { order_id: true, status: true, order_cost: true, customer_id: true, customer_government: true },
  });
  if (rows.length === 0) return EMPTY_RESULT;

  const byOrder = new Map();
  for (const r of rows) if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, r);
  const orders = [...byOrder.values()];

  const countWhere = (pred) => orders.filter(pred).length;
  const sumCostWhere = (pred) => orders.filter(pred).reduce((acc, o) => acc + (o.order_cost || 0), 0);
  const isConfirmedLike = (o) => o.status === 'CONFIRMED' || o.status === 'DELIVERED';

  const totalOrders = orders.length;
  const confirmed = countWhere(isConfirmedLike);
  const delivered = countWhere((o) => o.status === 'DELIVERED');
  const returned = countWhere((o) => o.status === 'RETURNED');
  const cancelled = countWhere((o) => o.status === 'CANCELLED');

  const customerIds = [...new Set(orders.map((o) => o.customer_id).filter(Boolean))];
  let repeatCustomerCount = null;
  let repeatCustomerIdSet = new Set();
  if (customerIds.length > 0) {
    const customers = await prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, total_orders: true } });
    repeatCustomerIdSet = new Set(customers.filter((c) => c.total_orders > 1).map((c) => c.id));
    repeatCustomerCount = repeatCustomerIdSet.size;
  }

  // Phase 1 Markets & Areas — same single query, wider per-governorate
  // bucket: revenue/AOV/customerCount/repeatCustomerCount alongside the
  // original orders/delivered counts. No second DB round-trip.
  const byGov = new Map();
  for (const o of orders) {
    const gov = normalizeGovernorateName(o.customer_government);
    if (!gov) continue; // never bucket an unknown address under a fabricated label
    if (!byGov.has(gov)) byGov.set(gov, { government: gov, orders: 0, confirmed: 0, delivered: 0, returned: 0, cancelled: 0, revenue: 0, deliveredRevenue: 0, customerIds: new Set() });
    const g = byGov.get(gov);
    g.orders++;
    if (isConfirmedLike(o)) g.confirmed++;
    if (o.status === 'DELIVERED') { g.delivered++; g.deliveredRevenue += o.order_cost || 0; }
    if (o.status === 'RETURNED') g.returned++;
    if (o.status === 'CANCELLED') g.cancelled++;
    g.revenue += o.order_cost || 0;
    if (o.customer_id) g.customerIds.add(o.customer_id);
  }
  const governorates = [...byGov.values()].map((g) => {
    const customerCount = g.customerIds.size || null;
    const repeatCustomerCount = g.customerIds.size ? [...g.customerIds].filter((id) => repeatCustomerIdSet.has(id)).length : null;
    return {
      government: g.government, orders: g.orders, confirmed: g.confirmed, delivered: g.delivered, returned: g.returned, cancelled: g.cancelled,
      confirmationRate: g.orders > 0 ? g.confirmed / g.orders : null,
      deliveryRate: g.confirmed > 0 ? g.delivered / g.confirmed : null,
      rtoRate: g.confirmed > 0 ? g.returned / g.confirmed : null,
      revenue: g.revenue, deliveredRevenue: g.deliveredRevenue,
      aov: g.orders > 0 ? g.revenue / g.orders : null,
      customerCount, repeatCustomerCount,
    };
  });

  return {
    source: 'easyorders',
    orders: totalOrders, confirmed, delivered, returned, cancelled,
    confirmationRate: totalOrders > 0 ? confirmed / totalOrders : null,
    deliveryRate: confirmed > 0 ? delivered / confirmed : null,
    rtoRate: confirmed > 0 ? returned / confirmed : null,
    revenue: sumCostWhere(() => true),
    deliveredRevenue: sumCostWhere((o) => o.status === 'DELIVERED'),
    customerCount: customerIds.length || null,
    repeatCustomerCount,
    governorates,
  };
}

/**
 * §6 "Markets & Areas" — wraps customerQualityForProduct()'s real
 * governorate breakdown with a deterministic SCALE_MARKET/KEEP_TESTING/
 * MONITOR/REDUCE_PRIORITY/INSUFFICIENT_DATA band per row. Same real numbers,
 * no new query.
 */
export async function marketsForProduct({ productId, storeId, from, to, minOrders = 10 } = {}) {
  const quality = await customerQualityForProduct({ productId, storeId, from, to });
  if (quality.source === 'none') return { source: 'none', markets: [] };
  const markets = quality.governorates
    .map((g) => ({ ...g, band: bandMarket(g, { minOrders }) }))
    .sort((a, b) => (b.delivered || 0) - (a.delivered || 0));
  return { source: 'easyorders', markets };
}

/**
 * Live Campaign Intelligence Slice 2 — governorate trend. Easy Orders is
 * already near-real-time (webhook + 2-min reconciliation — see
 * easyOrdersReconcile.js), so a real trend doesn't need a new history table
 * the way Meta's audience breakdown does: it's just marketsForProduct() run
 * twice, over the current window and the immediately preceding equal-length
 * window — the exact same current-vs-prior pattern
 * productPerformance.js's getProductDiagnosis() already uses for Meta CTR/
 * CPA fatigue corroboration. `from`/`to` are the CURRENT window (YYYY-MM-DD).
 */
export async function governorateTrendForProduct({ productId, storeId, from, to, minOrders = 10 }) {
  const current = await marketsForProduct({ productId, storeId, from, to, minOrders });
  const spanDays = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86_400_000) + 1);
  const priorTo = new Date(new Date(from).getTime() - 86_400_000).toISOString().slice(0, 10);
  const priorFrom = new Date(new Date(priorTo).getTime() - (spanDays - 1) * 86_400_000).toISOString().slice(0, 10);
  const prior = await marketsForProduct({ productId, storeId, from: priorFrom, to: priorTo, minOrders });

  const priorByGov = new Map((prior.markets || []).map((m) => [m.government, m]));
  const markets = (current.markets || []).map((m) => {
    const p = priorByGov.get(m.government);
    // Only a real prior INSUFFICIENT_DATA-free band counts as a comparable point — never diff against a governorate the prior window itself couldn't judge.
    const trend = !p || p.band === 'INSUFFICIENT_DATA' || m.band === 'INSUFFICIENT_DATA'
      ? null
      : (m.deliveryRate ?? 0) - (p.deliveryRate ?? 0);
    return { ...m, priorWindow: p ? { deliveryRate: p.deliveryRate, band: p.band, delivered: p.delivered } : null, deliveryRateTrend: trend };
  });
  return { source: current.source, window: { from, to }, priorWindow: { from: priorFrom, to: priorTo }, markets };
}
