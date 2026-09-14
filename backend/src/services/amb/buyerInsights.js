// Product Marketing Intelligence — §7 "Buyer Insights". Deterministic only,
// zero AI. Built entirely from real Easy Orders orders + the real Customer
// Database. Explicitly does NOT infer religion/medical condition/income/
// political views/ethnicity/age/gender or any other sensitive attribute —
// only observable transactional facts (new vs repeat, order value,
// co-purchased products). Never returns a raw customer name/phone/address;
// callers (including any AI prompt) only ever see these aggregates.
import { prisma } from '../../prisma.js';

const EMPTY_RESULT = {
  source: 'none',
  newCustomers: null, repeatCustomers: null,
  aovNew: null, aovRepeat: null,
  topCoPurchasedProducts: [],
};

/**
 * @param {{productId:number, from?:string, to?:string}} params
 */
export async function buyerInsightsForProduct({ productId, from, to }) {
  const dateFilter = {};
  if (from) dateFilter.gte = from;
  if (to) dateFilter.lte = to;
  const where = { product_id: productId };
  if (from || to) where.date = dateFilter;

  const rows = await prisma.easyOrdersOrder.findMany({
    where,
    select: { order_id: true, order_cost: true, customer_id: true },
  });
  if (rows.length === 0) return EMPTY_RESULT;

  const byOrder = new Map();
  for (const r of rows) if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, r);
  const orders = [...byOrder.values()];

  const customerIds = [...new Set(orders.map((o) => o.customer_id).filter(Boolean))];
  let newCustomers = null, repeatCustomers = null, aovNew = null, aovRepeat = null;
  if (customerIds.length > 0) {
    const customers = await prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, total_orders: true } });
    const repeatIdSet = new Set(customers.filter((c) => c.total_orders > 1).map((c) => c.id));
    const newOrders = orders.filter((o) => o.customer_id && !repeatIdSet.has(o.customer_id));
    const repeatOrders = orders.filter((o) => o.customer_id && repeatIdSet.has(o.customer_id));
    newCustomers = new Set(newOrders.map((o) => o.customer_id)).size || null;
    repeatCustomers = repeatIdSet.size ? [...customerIds].filter((id) => repeatIdSet.has(id)).length : null;
    aovNew = newOrders.length > 0 ? newOrders.reduce((a, o) => a + (o.order_cost || 0), 0) / newOrders.length : null;
    aovRepeat = repeatOrders.length > 0 ? repeatOrders.reduce((a, o) => a + (o.order_cost || 0), 0) / repeatOrders.length : null;
  }

  // Top co-purchased products: same order_id, a DIFFERENT product_id than
  // the one we're analyzing. Real join, no inference.
  const orderIds = orders.map((o) => o.order_id);
  const coRows = orderIds.length
    ? await prisma.easyOrdersOrder.findMany({
        where: { order_id: { in: orderIds }, product_id: { not: productId } },
        select: { order_id: true, product_id: true, product: { select: { product_name: true } } },
      })
    : [];
  const coCount = new Map();
  const seenPerOrder = new Set();
  for (const r of coRows) {
    if (!r.product_id) continue;
    const dedupKey = `${r.order_id}:${r.product_id}`;
    if (seenPerOrder.has(dedupKey)) continue; // one order's multiple cart-item rows for the same co-product count once
    seenPerOrder.add(dedupKey);
    const entry = coCount.get(r.product_id) || { productId: r.product_id, productName: r.product?.product_name || null, coOrders: 0 };
    entry.coOrders++;
    coCount.set(r.product_id, entry);
  }
  const topCoPurchasedProducts = [...coCount.values()].sort((a, b) => b.coOrders - a.coOrders).slice(0, 8);

  return {
    source: 'easyorders',
    newCustomers, repeatCustomers, aovNew, aovRepeat,
    topCoPurchasedProducts,
  };
}
