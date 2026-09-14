// Product Marketing Intelligence — real Customer-quality summary for one
// product over a date window. Built entirely from Easy Orders' own real
// order data + the Customer Database (services/customers.js) — never
// invents a number, mirrors the exact byOrder-dedup + status-classification
// convention already used by services/amb/codOrders.js's
// codCountsForProduct/codCountsByGovernorate (kept as a separate file
// rather than added there, to avoid entangling with that file's own
// paused, unrelated multi-store `storeId` work).
import { prisma } from '../../prisma.js';

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
 * @param {{productId:number, from?:string, to?:string}} params (from/to = YYYY-MM-DD inclusive)
 */
export async function customerQualityForProduct({ productId, from, to }) {
  const dateFilter = {};
  if (from) dateFilter.gte = from;
  if (to) dateFilter.lte = to;
  const where = { product_id: productId };
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
  if (customerIds.length > 0) {
    const customers = await prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { total_orders: true } });
    repeatCustomerCount = customers.filter((c) => c.total_orders > 1).length;
  }

  const byGov = new Map();
  for (const o of orders) {
    const gov = (o.customer_government || '').trim();
    if (!gov) continue; // never bucket an unknown address under a fabricated label
    if (!byGov.has(gov)) byGov.set(gov, { government: gov, orders: 0, delivered: 0 });
    byGov.get(gov).orders++;
    if (o.status === 'DELIVERED') byGov.get(gov).delivered++;
  }

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
    governorates: [...byGov.values()],
  };
}
