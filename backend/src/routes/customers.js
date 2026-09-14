// Customer Database — read-only search + detail views. ADMIN|MANAGER only
// (same tier as every other order-adjacent view in this app), reusing the
// existing requireAuth/requireRole middleware — no new auth mechanism.
// List views mask the phone number; the per-customer detail view (an
// explicit, authorized drill-down) shows the full value — same "list masks,
// detail reveals to an authorized viewer" pattern requested for §13/§14.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { prisma } from '../prisma.js';
import { normalizeEgyptianPhone } from '../services/phoneNormalize.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));

/** "01012345678" -> "010****678" — first 3 + last 3 digits visible, everything else masked. Never logged/returned in full from a list endpoint. */
function maskPhone(phone) {
  if (!phone) return null;
  const s = String(phone);
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 3)}${'*'.repeat(s.length - 6)}${s.slice(-3)}`;
}

function summarize(c) {
  return {
    id: c.id,
    name: c.name,
    phoneMasked: maskPhone(c.primary_phone),
    government: c.government,
    totalOrders: c.total_orders,
    confirmedOrders: c.confirmed_orders,
    deliveredOrders: c.delivered_orders,
    lastOrderAt: c.last_order_at,
  };
}

/** Search by Name / Phone / Order ID — spec §13. Phone is normalized before matching (same rule as ingestion), so any real raw format finds the right customer. An Order ID may be Easy Orders' own UUID or the human short_id. */
router.get('/', asyncRoute(async (req, res) => {
  const q = String(req.query.search || '').trim();
  if (!q) {
    const recent = await prisma.customer.findMany({ orderBy: { last_order_at: 'desc' }, take: 50 });
    return res.json({ customers: recent.map(summarize) });
  }

  let orderMatch = await prisma.easyOrdersOrder.findFirst({ where: { order_id: q }, select: { customer_id: true } });
  if (!orderMatch && /^\d+$/.test(q)) {
    orderMatch = await prisma.easyOrdersOrder.findFirst({ where: { short_id: Number(q) }, select: { customer_id: true } });
  }
  if (orderMatch) {
    const c = orderMatch.customer_id ? await prisma.customer.findUnique({ where: { id: orderMatch.customer_id } }) : null;
    return res.json({ customers: c ? [summarize(c)] : [] });
  }

  const normalizedQuery = normalizeEgyptianPhone(q);
  const where = normalizedQuery ? { normalized_phone: normalizedQuery } : { name: { contains: q, mode: 'insensitive' } };
  const results = await prisma.customer.findMany({ where, take: 50, orderBy: { last_order_at: 'desc' } });
  res.json({ customers: results.map(summarize) });
}));

/** Full authorized detail view — spec §13's "Detailed authorized view". */
router.get('/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { const e = new Error('مُعرّف غير صالح.'); e.status = 400; throw e; }
  const c = await prisma.customer.findUnique({ where: { id } });
  if (!c) return res.status(404).json({ error: 'NOT_FOUND', message: 'العميل غير موجود.' });

  const rows = await prisma.easyOrdersOrder.findMany({
    where: { customer_id: id },
    select: { order_id: true, short_id: true, status: true, order_cost: true, created_at: true, product_name_raw: true, product: { select: { product_name: true } } },
    orderBy: { created_at: 'desc' },
  });
  const byOrder = new Map();
  for (const r of rows) if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, r);
  const orderHistory = [...byOrder.values()].map((r) => ({
    orderId: r.order_id, shortId: r.short_id, status: r.status, cost: r.order_cost, createdAt: r.created_at,
    productName: r.product?.product_name || r.product_name_raw || null,
  }));
  const productsPurchased = [...new Set(orderHistory.map((o) => o.productName).filter(Boolean))];

  res.json({
    id: c.id,
    name: c.name,
    phone: c.primary_phone,
    otherPhones: c.other_phones_json ? JSON.parse(c.other_phones_json) : [],
    government: c.government,
    address: c.address,
    firstOrderAt: c.first_order_at,
    lastOrderAt: c.last_order_at,
    totalOrders: c.total_orders,
    confirmedOrders: c.confirmed_orders,
    deliveredOrders: c.delivered_orders,
    returnedOrders: c.returned_orders,
    cancelledOrders: c.cancelled_orders,
    totalOrderValue: c.total_order_value,
    deliveredRevenue: c.delivered_revenue,
    productsPurchased,
    orderHistory,
  });
}));

export default router;
