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
// The actual ingest/status-apply logic lives in services/easyOrders.js,
// shared with the periodic reconciliation job (services/easyOrdersReconcile.js)
// — added after confirming (twice, with a real order) that EasyOrders never
// actually sends an "order-status-update" event for this store, so the
// reconciliation job is what catches a real status change in practice. This
// route's own logic is otherwise unchanged from before that refactor.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../prisma.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { logger } from '../logger.js';
import { ingestOrder, fetchOrderById, applyStatusToOrder } from '../services/easyOrders.js';

const router = Router();

const webhookLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

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
      const { totalRows } = await applyStatusToOrder(body.order_id, body.new_status);
      logger.info('EasyOrders status update processed', { order_id: body.order_id, new_status: body.new_status, rowsAffected: totalRows });
      return res.json({ ok: true, rowsAffected: totalRows });
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
