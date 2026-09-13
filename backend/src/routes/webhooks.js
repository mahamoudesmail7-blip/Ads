// EasyOrders integration — webhook receiver (spec: js/orders-provider.js's
// EasyOrdersProvider stub, now wired up for real). EasyOrders has no bulk
// "list orders" endpoint (confirmed against their public docs at
// public-api-docs.easy-orders.net) — their model is push, not pull: they
// POST here the instant an order is created or its status changes. This
// route is deliberately NOT behind requireAuth (EasyOrders' servers can't
// log in as one of our users).
//
// Per-payload-type secret (single store, no store_id, no DB change):
// EasyOrders' seller dashboard actually issues a DIFFERENT secret per
// webhook TYPE — the "Order Created" webhook and the "Order Status Update"
// webhook are two separate registrations, each with its own secret, even
// though both POST to the same URL. The old code compared every request
// against one single EASYORDERS_WEBHOOK_SECRET, which only ever matched
// one of the two — this fixes that by determining which payload TYPE
// arrived first, then checking it against THAT type's own secret:
//   - an order-created payload (has `id` + a `cart_items` array)
//     -> EASYORDERS_WEBHOOK_SECRET
//   - an order-status-update payload (`event_type === 'order-status-update'`)
//     -> EASYORDERS_STATUS_WEBHOOK_SECRET (NEW)
//   - anything else -> rejected before any secret is even compared, and
//     before any ingest is attempted.
//
// The actual ingest/status-apply logic lives in services/easyOrders.js,
// shared with the periodic reconciliation job (services/easyOrdersReconcile.js).
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../prisma.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { logger } from '../logger.js';
import { ingestOrder, fetchOrderById, applyStatusToOrder } from '../services/easyOrders.js';

const router = Router();

const webhookLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

/** Classifies the payload shape BEFORE any secret is checked — a request never has to guess/probe a secret just to learn its shape wasn't recognized, and an unrecognized shape is refused (no ingest) regardless of what secret it carries. */
function classifyEasyOrdersPayload(body) {
  if (body && body.event_type === 'order-status-update') return 'STATUS_UPDATE';
  if (body && body.id && Array.isArray(body.cart_items)) return 'ORDER_CREATED';
  return 'UNKNOWN';
}

router.post(
  '/easyorders',
  webhookLimiter,
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const type = classifyEasyOrdersPayload(body);

    if (type === 'UNKNOWN') {
      return res.status(400).json({ error: 'UNRECOGNIZED_PAYLOAD' });
    }

    const expectedSecret = type === 'STATUS_UPDATE' ? process.env.EASYORDERS_STATUS_WEBHOOK_SECRET : process.env.EASYORDERS_WEBHOOK_SECRET;
    if (!expectedSecret || req.headers['secret'] !== expectedSecret) {
      return res.status(401).json({ error: 'INVALID_SECRET' });
    }

    if (type === 'STATUS_UPDATE') {
      const existing = await prisma.easyOrdersOrder.findMany({ where: { order_id: body.order_id } });
      if (existing.length === 0) {
        const fetched = await fetchOrderById(body.order_id);
        if (fetched) await ingestOrder(fetched);
      }
      const { totalRows } = await applyStatusToOrder(body.order_id, body.new_status);
      logger.info('EasyOrders status update processed', { order_id: body.order_id, new_status: body.new_status, rowsAffected: totalRows });
      return res.json({ ok: true, rowsAffected: totalRows });
    }

    // ORDER_CREATED
    await ingestOrder(body);
    logger.info('EasyOrders order ingested', { order_id: body.id, items: body.cart_items.length });
    res.json({ ok: true });
  })
);

export default router;
