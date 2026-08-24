// Read-only API for the Easy Orders dashboard (js/easy-orders.js). Purely
// additive — does not touch the webhook ingestion route, the secret
// verification, or the EasyOrders API key. Every number here is derived
// directly from EasyOrdersOrder rows written by the real webhook in
// webhooks.js; nothing is invented, randomized, or hardcoded.
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { prisma } from '../prisma.js';

const router = Router();
router.use(requireAuth);

const STATUS_KEYS = ['PENDING', 'CONFIRMED', 'DELIVERED', 'CANCELLED', 'RETURNED'];

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** One row per real order (not per cart item) — a multi-item order's product names are joined so the UI never has to guess which one "the" product is. */
function groupByOrder(rows) {
  const byOrder = new Map();
  for (const r of rows) {
    if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []);
    byOrder.get(r.order_id).push(r);
  }
  return [...byOrder.entries()].map(([orderId, items]) => ({
    orderId,
    status: items[0].status, // every row for one order_id is kept in sync by the webhook handler
    createdAt: items.reduce((min, r) => (r.created_at < min ? r.created_at : min), items[0].created_at),
    quantity: items.reduce((s, r) => s + r.quantity, 0),
    productNames: [...new Set(items.map((r) => r.product?.product_name || r.product_name_raw || 'منتج غير معروف'))],
  }));
}

function statusCounts(orders) {
  const counts = Object.fromEntries(STATUS_KEYS.map((k) => [k, 0]));
  for (const o of orders) counts[o.status] = (counts[o.status] || 0) + 1;
  return counts;
}

/** Groups line items into per-product quantity totals — grouped by matched product_id when available, else by sku/name so an unmatched product still gets its own real row instead of being lost or merged with something unrelated. */
function productPerformance(todayRows, yesterdayRows) {
  const key = (r) => (r.product_id ? `p:${r.product_id}` : `u:${r.sku || r.product_name_raw || r.id}`);
  const name = (r) => r.product?.product_name || r.product_name_raw || 'منتج غير معروف';

  const map = new Map();
  for (const r of todayRows) {
    const k = key(r);
    if (!map.has(k)) map.set(k, { productId: r.product_id, name: name(r), today: 0, yesterday: 0, matched: r.matched });
    map.get(k).today += r.quantity;
  }
  for (const r of yesterdayRows) {
    const k = key(r);
    if (!map.has(k)) map.set(k, { productId: r.product_id, name: name(r), today: 0, yesterday: 0, matched: r.matched });
    map.get(k).yesterday += r.quantity;
  }
  return [...map.values()].sort((a, b) => b.today - a.today);
}

// The whole system is Egypt-oriented (ar-EG locale, Egyptian phone/government
// fields throughout real order data) but timestamps are stored in UTC —
// shifting by Egypt's fixed +2 offset here keeps the hourly label consistent
// with what an Egypt-based media buyer actually reads on their clock.
const EGYPT_UTC_OFFSET_HOURS = 2;

/** Only hours that actually had at least one order — spec: "Show the exact real orders that entered during that hour," never a padded 24-row table of empty hours. */
function hourlyBreakdown(orders) {
  const byHour = new Map();
  for (const o of orders) {
    const hour = (new Date(o.createdAt).getUTCHours() + EGYPT_UTC_OFFSET_HOURS) % 24;
    if (!byHour.has(hour)) byHour.set(hour, []);
    byHour.get(hour).push(o);
  }
  return [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, hourOrders]) => ({
      hourLabel: `${String(hour).padStart(2, '0')}:00 - ${String((hour + 1) % 24).padStart(2, '0')}:00`,
      incoming: hourOrders.length,
      ...statusCounts(hourOrders),
    }));
}

router.get(
  '/summary',
  asyncRoute(async (req, res) => {
    const today = req.query.date || todayUTC();
    const yesterday = shiftDate(today, -1);

    const [todayRows, yesterdayRows] = await Promise.all([
      prisma.easyOrdersOrder.findMany({ where: { date: today }, include: { product: { select: { product_name: true } } }, orderBy: { created_at: 'desc' } }),
      prisma.easyOrdersOrder.findMany({ where: { date: yesterday }, include: { product: { select: { product_name: true } } } }),
    ]);

    const todayOrders = groupByOrder(todayRows);
    const yesterdayOrders = groupByOrder(yesterdayRows);

    res.json({
      today,
      yesterday,
      totals: {
        todayOrders: todayOrders.length,
        yesterdayOrders: yesterdayOrders.length,
        diff: todayOrders.length - yesterdayOrders.length,
        pct: yesterdayOrders.length ? Math.round(((todayOrders.length - yesterdayOrders.length) / yesterdayOrders.length) * 100) : todayOrders.length > 0 ? 100 : 0,
      },
      statusCounts: statusCounts(todayOrders),
      products: productPerformance(todayRows, yesterdayRows),
      unmatchedToday: todayRows.filter((r) => !r.matched).length,
      hourly: hourlyBreakdown(todayOrders),
      orders: todayOrders
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((o) => ({ orderId: o.orderId, productNames: o.productNames, quantity: o.quantity, status: o.status, createdAt: o.createdAt })),
    });
  })
);

export default router;
