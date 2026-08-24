// EasyOrders integration — webhook receiver (spec: js/orders-provider.js's
// EasyOrdersProvider stub, now wired up for real). EasyOrders has no bulk
// "list orders" endpoint (confirmed against their public docs at
// public-api-docs.easy-orders.net) — their model is push, not pull: they
// POST here the instant an order is created or its status changes. This
// route is deliberately NOT behind requireAuth (EasyOrders' servers can't
// log in as one of our users) — it's authenticated instead via the shared
// `secret` header EasyOrders sends, generated when the webhook is created
// in their seller dashboard.
//
// ABSOLUTE RULE (carried over from orders-provider.js): a CANCELLED or
// RETURNED order must never inflate that day's orders_count as if it were
// a completed sale. Every aggregate recompute below enforces this by
// construction — orders_count only sums PENDING/CONFIRMED/DELIVERED rows.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../prisma.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { logger } from '../logger.js';

const router = Router();

const webhookLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

const EASYORDERS_API_BASE = 'https://api.easy-orders.net/api/v1/external-apps';

/**
 * EasyOrders hasn't published a full status enum (only "pending"/"paid" are
 * shown in their docs) — matched by keyword rather than an exact list, so an
 * unanticipated status string still lands somewhere sane (PENDING, never
 * silently treated as DELIVERED) instead of throwing.
 */
function normalizeStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('cancel')) return 'CANCELLED';
  if (s.includes('return')) return 'RETURNED';
  if (s.includes('deliver')) return 'DELIVERED';
  if (s.includes('confirm') || s === 'paid') return 'CONFIRMED';
  return 'PENDING';
}

function toDateOnly(iso) {
  return (iso || new Date().toISOString()).slice(0, 10);
}

/** Recomputes the DailyOrder aggregate for one (product, date) from every EasyOrdersOrder row tracked for it — never hand-incremented, always derived fresh so a later status change (e.g. a return) self-corrects the aggregate instead of drifting. */
async function recomputeDailyOrder(productId, date) {
  if (!productId) return;
  const rows = await prisma.easyOrdersOrder.findMany({ where: { product_id: productId, date } });
  const sum = (statuses) => rows.filter((r) => statuses.includes(r.status)).reduce((acc, r) => acc + r.quantity, 0);
  const orders_count = sum(['PENDING', 'CONFIRMED', 'DELIVERED']);
  const delivered_count = sum(['DELIVERED']);
  const returned_count = sum(['RETURNED']);

  if (rows.length === 0) return; // nothing left to track for this product+date — leave any pre-existing manual/demo row alone.

  await prisma.dailyOrder.upsert({
    where: { product_id_date: { product_id: productId, date } },
    update: { orders_count, delivered_count, returned_count, source: 'easyorders' },
    create: { product_id: productId, date, orders_count, delivered_count, returned_count, source: 'easyorders' },
  });
}

/** Matches an EasyOrders cart item to our Product by exact SKU — no fuzzy name matching here (unlike the Excel-import path in product-mapping.js): a wrong guess would silently misattribute a real sale, which is worse than leaving it unmatched for manual review. */
async function matchProduct(sku) {
  if (!sku) return null;
  return prisma.product.findFirst({ where: { sku } });
}

/** Upserts one EasyOrdersOrder row per cart item from a full order payload (either the original webhook body, or a backfilled Get-Order-By-ID response), then recomputes every (product, date) it touches. */
async function ingestOrder(order) {
  const date = toDateOnly(order.created_at);
  const status = normalizeStatus(order.status);
  const touched = new Set();

  for (const item of order.cart_items || []) {
    const sku = item.product?.sku || null;
    const product = await matchProduct(sku);
    await prisma.easyOrdersOrder.upsert({
      where: { order_id_cart_item_id: { order_id: order.id, cart_item_id: item.id } },
      update: { status, raw_status: order.status, quantity: item.quantity || 1, product_id: product?.id ?? null, sku, matched: !!product, date },
      create: {
        order_id: order.id,
        cart_item_id: item.id,
        product_id: product?.id ?? null,
        sku,
        date,
        status,
        raw_status: order.status,
        quantity: item.quantity || 1,
        matched: !!product,
      },
    });
    if (product) touched.add(`${product.id}::${date}`);
  }

  for (const key of touched) {
    const [productId, d] = key.split('::');
    await recomputeDailyOrder(Number(productId), d);
  }
}

/** Fallback for an order-status-update whose order_id we've never seen (e.g. the original order-created webhook was missed) — pulls the full order via the API key so we still have cart items to attribute the status to. */
async function fetchOrderById(orderId) {
  const apiKey = process.env.EASYORDERS_API_KEY;
  if (!apiKey) return null;
  const res = await fetch(`${EASYORDERS_API_BASE}/orders/${orderId}`, { headers: { 'Api-Key': apiKey } });
  if (!res.ok) return null;
  return res.json();
}

router.post(
  '/easyorders',
  webhookLimiter,
  asyncRoute(async (req, res) => {
    const configuredSecret = process.env.EASYORDERS_WEBHOOK_SECRET;
    if (!configuredSecret || req.headers['secret'] !== configuredSecret) {
      return res.status(401).json({ error: 'INVALID_SECRET' });
    }

    const body = req.body || {};

    if (body.event_type === 'order-status-update') {
      const existing = await prisma.easyOrdersOrder.findMany({ where: { order_id: body.order_id } });
      if (existing.length === 0) {
        const fetched = await fetchOrderById(body.order_id);
        if (fetched) await ingestOrder(fetched);
      }
      const status = normalizeStatus(body.new_status);
      const rows = await prisma.easyOrdersOrder.findMany({ where: { order_id: body.order_id } });
      const touched = new Set();
      for (const row of rows) {
        await prisma.easyOrdersOrder.update({ where: { id: row.id }, data: { status, raw_status: body.new_status } });
        if (row.product_id) touched.add(`${row.product_id}::${row.date}`);
      }
      for (const key of touched) {
        const [productId, d] = key.split('::');
        await recomputeDailyOrder(Number(productId), d);
      }
      logger.info('EasyOrders status update processed', { order_id: body.order_id, new_status: body.new_status, rowsAffected: rows.length });
      return res.json({ ok: true, rowsAffected: rows.length });
    }

    // order-created (or any event carrying a full order object with cart_items)
    if (!body.id || !Array.isArray(body.cart_items)) {
      return res.status(400).json({ error: 'UNRECOGNIZED_PAYLOAD' });
    }
    await ingestOrder(body);
    logger.info('EasyOrders order ingested', { order_id: body.id, items: body.cart_items.length });
    res.json({ ok: true });
  })
);

export default router;
