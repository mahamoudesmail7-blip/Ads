// EasyOrders integration — webhook receiver. EasyOrders has no bulk "list orders" endpoint — their model is push: they POST here
// the instant an order is created or its status changes. Deliberately NOT behind requireAuth (EasyOrders' servers can't log in).
//
// 2026-10-02 rewrite of the AUTH + STORE-ATTRIBUTION layer (the ingest/status logic itself is unchanged and still lives in
// services/easyOrders.js). Audit evidence: production returned 401 to 106/106 deliveries on the bare `/easyorders` URL, and 1,126/1,126
// audited orders filed under `default` were actually owned by the other Easy Orders account — the old code trusted the URL
// path alone to pick the store, so a webhook registered on the "wrong" URL was either rejected or silently mis-filed.
//
// Now (services/easyOrdersWebhookAuth.js):
//   * both `/easyorders` and `/easyorders/:storeId` authenticate against EVERY configured secret (timing-safe); the matching
//     secret — not the URL, never a body field — decides the store. The default store keeps its two dedicated secrets
//     (order-created vs status-update); a store's single secret works for both event types.
//   * for a newly created order the owning Easy Orders ACCOUNT is verified with Easy Orders itself; a verified owner overrides the
//     secret/route store (logged as TAG_CORRECTED); if verification is impossible the order is still ingested (flagged unverified).
//   * every rejection logs why (env var NAMES / lengths / "header equals secret X but wrong event type") — never a secret value.
// Shape rules kept from before: the bare URL classifies the payload shape BEFORE looking at any secret (400 UNRECOGNIZED_PAYLOAD);
// the store URL requires the store to exist (404) and have a secret (400) first, then authenticates, then classifies.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../prisma.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { logger as defaultLogger } from '../logger.js';
import { ingestOrder, applyStatusToOrder } from '../services/easyOrders.js';
import { getStore, getStoreWebhookSecret, defaultStoreId } from '../services/easyOrdersStores.js';
import { buildSecretRegistry, matchWebhookSecret, verifyOrderOwner } from '../services/easyOrdersWebhookAuth.js';
import { resolveOrderAcrossStores } from '../services/easyOrdersStatus.js';

/** Counters + the last rejection reason, readable by diagnostics without any secret. */
export const webhookAuthHealth = { rejected: 0, lastRejectedAt: null, lastRejection: null, accepted: 0, lastAcceptedAt: null, tagCorrected: 0, routeSecretMismatch: 0, ownerUnverified: 0 };

function classifyEasyOrdersPayload(body) {
  if (body && body.event_type === 'order-status-update') return 'STATUS_UPDATE';
  if (body && body.id && Array.isArray(body.cart_items)) return 'ORDER_CREATED';
  return 'UNKNOWN';
}

export function createWebhooksRouter(overrides = {}) {
  const d = {
    logger: defaultLogger,
    ingestOrder, applyStatusToOrder, getStore, getStoreWebhookSecret, defaultStoreId,
    registry: () => buildSecretRegistry({ defaultStoreId: defaultStoreId() }),
    verifyOwner: (orderId, hint) => verifyOrderOwner(orderId, hint),
    resolveOrder: (orderId, hint) => resolveOrderAcrossStores(orderId, hint, { maxRetries: 1 }),
    orderRows: (orderId) => prisma.easyOrdersOrder.findMany({ where: { order_id: orderId }, select: { id: true } }),
    ...overrides,
  };
  const router = Router();
  const webhookLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

  // log-once-per-5-min per key so a retry storm cannot flood the logs, while the FIRST occurrence always explains itself
  const throttle = new Map();
  function logThrottled(level, key, message, fields) {
    const now = Date.now(); const e = throttle.get(key) || { count: 0, last: 0 }; e.count++;
    if (now - e.last >= 5 * 60_000) { d.logger[level](message, { ...fields, suppressedSincePrevious: e.count - 1 }); e.count = 0; e.last = now; }
    throttle.set(key, e);
  }

  async function handleOrderCreated(body, storeId, res) {
    const owner = await d.verifyOwner(body.id, storeId);
    let finalStore = storeId;
    if (owner.verified) {
      if (owner.storeId !== storeId) {
        webhookAuthHealth.tagCorrected++;
        logThrottled('warn', 'tag-corrected', 'EasyOrders order store CORRECTED by owner verification', { order_id: body.id, secretOrRouteStore: storeId, verifiedOwnerStore: owner.storeId });
        finalStore = owner.storeId;
      }
    } else {
      webhookAuthHealth.ownerUnverified++;
      logThrottled('info', 'owner-unverified', 'EasyOrders order ingested with UNVERIFIED store (owner lookup unavailable)', { order_id: body.id, store: storeId, reason: owner.reason });
    }
    await d.ingestOrder(body, finalStore);
    d.logger.info('EasyOrders order ingested', { order_id: body.id, items: body.cart_items.length, storeId: finalStore, ownerVerified: !!owner.verified });
    res.json({ ok: true });
  }

  async function handleStatusUpdate(body, storeId, res) {
    const existing = await d.orderRows(body.order_id);
    if (existing.length === 0) {
      const r = await d.resolveOrder(body.order_id, storeId); // any configured key: the order may belong to the other account
      if (r.kind === 'OK') await d.ingestOrder(r.order, r.foundWithStoreId);
    }
    const { totalRows } = await d.applyStatusToOrder(body.order_id, body.new_status);
    d.logger.info('EasyOrders status update processed', { order_id: body.order_id, new_status: body.new_status, rowsAffected: totalRows, storeId });
    res.json({ ok: true, rowsAffected: totalRows });
  }

  function handler(urlStoreId) {
    return asyncRoute(async (req, res) => {
      const body = req.body || {};
      const type = classifyEasyOrdersPayload(body);
      const route = urlStoreId ? '/easyorders/:storeId' : '/easyorders';

      if (!urlStoreId && type === 'UNKNOWN') return res.status(400).json({ error: 'UNRECOGNIZED_PAYLOAD' }); // shape first, before any secret
      if (urlStoreId) {
        if (!d.getStore(urlStoreId)) return res.status(404).json({ error: 'UNKNOWN_STORE' });
        if (!d.getStoreWebhookSecret(urlStoreId)) return res.status(400).json({ error: 'STORE_WEBHOOK_NOT_CONFIGURED' });
      }

      const header = req.headers['secret'];
      const m = matchWebhookSecret(header, type, d.registry());
      if (!m.ok) {
        webhookAuthHealth.rejected++; webhookAuthHealth.lastRejectedAt = new Date().toISOString(); webhookAuthHealth.lastRejection = { route, urlStoreId: urlStoreId || null, ...m.diagnosis };
        logThrottled('warn', `401|${route}|${type}`, 'EasyOrders webhook REJECTED (INVALID_SECRET)', { route, urlStoreId: urlStoreId || null, userAgent: String(req.headers['user-agent'] || '').slice(0, 40), ...m.diagnosis });
        return res.status(401).json({ error: 'INVALID_SECRET' });
      }
      if (type === 'UNKNOWN') return res.status(400).json({ error: 'UNRECOGNIZED_PAYLOAD' });

      const routeStore = urlStoreId || d.defaultStoreId();
      if (m.storeId !== routeStore) {
        webhookAuthHealth.routeSecretMismatch++;
        logThrottled('warn', `mismatch|${route}|${m.storeId}`, 'EasyOrders webhook: the secret belongs to a different store than the URL it was sent to — the SECRET decides the store', { route, urlStore: routeStore, secretStore: m.storeId, secretSource: m.source });
      }
      if (m.ambiguous) logThrottled('warn', 'ambiguous', 'EasyOrders webhook secret is shared by more than one store — first match used', { stores: m.ambiguous });
      webhookAuthHealth.accepted++; webhookAuthHealth.lastAcceptedAt = new Date().toISOString();

      if (type === 'STATUS_UPDATE') return handleStatusUpdate(body, m.storeId, res);
      return handleOrderCreated(body, m.storeId, res);
    });
  }

  router.post('/easyorders', webhookLimiter, handler(null));
  router.post('/easyorders/:storeId', webhookLimiter, (req, res, next) => handler(req.params.storeId)(req, res, next));
  return router;
}

export default createWebhooksRouter();
