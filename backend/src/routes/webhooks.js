// EasyOrders integration — webhook receiver (spec: js/orders-provider.js's
// EasyOrdersProvider stub, now wired up for real). EasyOrders has no bulk
// "list orders" endpoint (confirmed against their public docs at
// public-api-docs.easy-orders.net) — their model is push, not pull: they
// POST here the instant an order is created or its status changes. This
// route is deliberately NOT behind requireAuth (EasyOrders' servers can't
// log in as one of our users).
//
// Multi-store — a SECOND store's webhooks arrive on an explicit URL path
// segment, `/easyorders/:storeId`, not anything in the payload body (a body
// field is never trustworthy input for "which store" — it would let a
// malicious or buggy sender attribute an order to the wrong store).
// Register a SEPARATE webhook URL per store in each store's own Easy
// Orders dashboard:
//   - the ORIGINAL store keeps using the bare `/easyorders` URL — its
//     handling below is BYTE-FOR-BYTE the same logic as before multi-store
//     (verified against git history, commit ae8407d): payload shape is
//     classified FIRST, unconditionally, before any secret is even looked
//     at (an unrecognized shape is refused regardless of what secret, or no
//     secret, it carries), and each of the two payload TYPES is checked
//     against its OWN dedicated secret (EasyOrders' dashboard issues a
//     different secret per webhook type even though both post to the same
//     URL) — zero config change, zero regression risk for the one real
//     store already working in production today.
//   - any additional store registers `/easyorders/<its own storeId>`, a
//     genuinely new code path with its own, simpler contract: the store
//     must exist (else 404 UNKNOWN_STORE), then its ONE configured
//     webhookSecretEnv is checked BEFORE the payload shape is classified
//     (else 400 STORE_WEBHOOK_NOT_CONFIGURED if that store has no secret
//     configured, or 401 INVALID_SECRET if it doesn't match), and only then
//     is the shape classified (400 UNRECOGNIZED_PAYLOAD if unknown). This
//     deliberately does not split by payload type — that split was only
//     ever confirmed necessary for the original account.
//
// The actual ingest/status-apply logic lives in services/easyOrders.js,
// shared with the periodic reconciliation job (services/easyOrdersReconcile.js).
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../prisma.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { logger } from '../logger.js';
import { ingestOrder, fetchOrderById, applyStatusToOrder } from '../services/easyOrders.js';
import { getStore, getStoreWebhookSecret, defaultStoreId } from '../services/easyOrdersStores.js';

const router = Router();

const webhookLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

/** Classifies the payload shape BEFORE any secret is checked — a request never has to guess/probe a secret just to learn its shape wasn't recognized, and an unrecognized shape is refused (no ingest) regardless of what secret it carries. */
function classifyEasyOrdersPayload(body) {
  if (body && body.event_type === 'order-status-update') return 'STATUS_UPDATE';
  if (body && body.id && Array.isArray(body.cart_items)) return 'ORDER_CREATED';
  return 'UNKNOWN';
}

async function handleOrderCreated(body, storeId, res) {
  await ingestOrder(body, storeId);
  logger.info('EasyOrders order ingested', { order_id: body.id, items: body.cart_items.length, storeId });
  res.json({ ok: true });
}

async function handleStatusUpdate(body, storeId, res) {
  const existing = await prisma.easyOrdersOrder.findMany({ where: { order_id: body.order_id } });
  if (existing.length === 0) {
    const fetched = await fetchOrderById(body.order_id, storeId);
    if (fetched) await ingestOrder(fetched, storeId);
  }
  const { totalRows } = await applyStatusToOrder(body.order_id, body.new_status);
  logger.info('EasyOrders status update processed', { order_id: body.order_id, new_status: body.new_status, rowsAffected: totalRows, storeId });
  res.json({ ok: true, rowsAffected: totalRows });
}

// Original store — untouched logic, untouched URL. storeId is always
// 'default' here; it is never taken from the request body.
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

    const storeId = defaultStoreId();
    if (type === 'STATUS_UPDATE') return handleStatusUpdate(body, storeId, res);
    return handleOrderCreated(body, storeId, res);
  })
);

// Additional stores — one URL, one secret, per store.
router.post(
  '/easyorders/:storeId',
  webhookLimiter,
  asyncRoute(async (req, res) => {
    const storeId = req.params.storeId;
    if (!getStore(storeId)) {
      return res.status(404).json({ error: 'UNKNOWN_STORE' });
    }

    const storeSecret = getStoreWebhookSecret(storeId);
    if (!storeSecret) return res.status(400).json({ error: 'STORE_WEBHOOK_NOT_CONFIGURED' });
    if (req.headers['secret'] !== storeSecret) return res.status(401).json({ error: 'INVALID_SECRET' });

    const body = req.body || {};
    const type = classifyEasyOrdersPayload(body);
    if (type === 'UNKNOWN') {
      return res.status(400).json({ error: 'UNRECOGNIZED_PAYLOAD' });
    }

    if (type === 'STATUS_UPDATE') return handleStatusUpdate(body, storeId, res);
    return handleOrderCreated(body, storeId, res);
  })
);

export default router;
