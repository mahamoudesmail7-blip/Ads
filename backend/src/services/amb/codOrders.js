// AI Media Buyer — COD order truth. Pulls REAL confirmed / delivered /
// returned order counts per product for a date window, from the existing
// EasyOrders integration (EasyOrdersOrder, one row per order-item, with a
// normalized status) and falling back to DailyOrder aggregates. Same join
// philosophy as services/truePerformance.js — not a second copy of that
// file's profit math, just the counts AI Media Buyer's economics engine
// needs for Confirmed CPA / Delivered CPA / real Net Profit.
//
// If neither source has data for a product, `source: 'none'` and every
// count is null — the caller must treat that as "COD data not available
// yet", never as zero delivered orders.
import { prisma } from '../../prisma.js';

/**
 * @param {{productId:number, from?:string, to?:string}} params  (from/to = YYYY-MM-DD inclusive)
 * @returns {Promise<{source:'easyorders'|'daily_orders'|'none', metaWindow:null, orders:number|null, confirmed:number|null, delivered:number|null, returned:number|null, cancelled:number|null}>}
 */
export async function codCountsForProduct({ productId, from, to }) {
  const dateFilter = {};
  if (from) dateFilter.gte = from;
  if (to) dateFilter.lte = to;
  const hasRange = from || to;

  const eoWhere = { product_id: productId };
  if (hasRange) eoWhere.date = dateFilter;
  const eoRows = await prisma.easyOrdersOrder.findMany({ where: eoWhere });

  if (eoRows.length > 0) {
    const byOrder = new Map();
    for (const r of eoRows) if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, r.status);
    const s = [...byOrder.values()];
    return {
      source: 'easyorders',
      orders: s.length,
      confirmed: s.filter((x) => x === 'CONFIRMED' || x === 'DELIVERED').length, // delivered implies it was confirmed
      delivered: s.filter((x) => x === 'DELIVERED').length,
      returned: s.filter((x) => x === 'RETURNED').length,
      cancelled: s.filter((x) => x === 'CANCELLED').length,
    };
  }

  const doWhere = { product_id: productId };
  if (hasRange) doWhere.date = dateFilter;
  const daily = await prisma.dailyOrder.findMany({ where: doWhere });
  if (daily.length > 0) {
    return {
      source: 'daily_orders',
      orders: daily.reduce((a, r) => a + (r.orders_count || 0), 0),
      confirmed: null, // DailyOrder has no confirmed count
      delivered: daily.reduce((a, r) => a + (r.delivered_count || 0), 0),
      returned: daily.reduce((a, r) => a + (r.returned_count || 0), 0),
      cancelled: null,
    };
  }

  return { source: 'none', orders: null, confirmed: null, delivered: null, returned: null, cancelled: null };
}

/**
 * Real per-governorate order counts for a product over a date window — the
 * data source for AI Product Marketing Center's Location Intelligence
 * (§8). Grouped from the SAME EasyOrdersOrder.customer_government field the
 * Lost Orders feature already reads (see that model's field comment) — no
 * new integration, no hard-coded location list. [] when there's no real
 * customer_government data for this product/window (never a fabricated row).
 * @returns {Promise<Array<{government:string, orders:number, confirmed:number, delivered:number, returned:number}>>}
 */
export async function codCountsByGovernorate({ productId, from, to }) {
  const dateFilter = {};
  if (from) dateFilter.gte = from;
  if (to) dateFilter.lte = to;
  const where = { product_id: productId };
  if (from || to) where.date = dateFilter;
  const rows = await prisma.easyOrdersOrder.findMany({ where, select: { order_id: true, status: true, customer_government: true } });

  const byOrder = new Map();
  for (const r of rows) if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, r);
  const byGov = new Map();
  for (const r of byOrder.values()) {
    const gov = (r.customer_government || '').trim();
    if (!gov) continue; // never bucket unknown addresses under a fabricated label
    if (!byGov.has(gov)) byGov.set(gov, { government: gov, orders: 0, confirmed: 0, delivered: 0, returned: 0 });
    const g = byGov.get(gov);
    g.orders++;
    if (r.status === 'CONFIRMED' || r.status === 'DELIVERED') g.confirmed++;
    if (r.status === 'DELIVERED') g.delivered++;
    if (r.status === 'RETURNED') g.returned++;
  }
  return [...byGov.values()];
}

/** Observed confirmation/delivery rates from real COD data for a product over a window — used to auto-suggest AmbProduct.confirmation_rate / delivery_rate (never auto-saved). Null when the sample is too small to be meaningful. */
export async function observedRatesForProduct({ productId, from, to, minSample = 10 }) {
  const c = await codCountsForProduct({ productId, from, to });
  if (c.source === 'none' || !c.orders || c.orders < minSample) {
    return { source: c.source, sample: c.orders || 0, confirmationRate: null, deliveryRate: null };
  }
  const confirmationRate = c.confirmed != null && c.orders > 0 ? c.confirmed / c.orders : null;
  const deliveryRate = c.confirmed != null && c.confirmed > 0 && c.delivered != null ? c.delivered / c.confirmed : null;
  return { source: c.source, sample: c.orders, confirmationRate, deliveryRate };
}
