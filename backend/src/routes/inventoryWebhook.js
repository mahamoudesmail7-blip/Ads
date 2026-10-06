// 📦 Inventory webhook receiver — POST /api/webhooks/inventory. PUBLIC (the external inventory system cannot log in), authenticated by its own secret
// (INVENTORY_WEBHOOK_SECRET — an environment variable ONLY, never the inventory API key) via HMAC signature or a shared-secret header.
// Mounted in server.js BEFORE the global JSON parser: it needs the RAW body for the signature and its own small size limit (256 KB).
//   Inventory System → this route → InventorySnapshot (source INVENTORY_API/WEBHOOK) → stockGuard.resolveStockInputs → Stock Guard / Readiness / Advisor / Rules / AI Operator
// The handler only stores stock. It imports NO executor and can never reach Meta; a stock change merely invalidates caches so every reader recomputes.
//   ?dryRun=1 (authenticated like any request) validates + matches + computes the outcome and writes NOTHING.
import { Router, raw } from 'express';
import rateLimit from 'express-rate-limit';
import { logger as defaultLogger } from '../logger.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { verifyWebhookAuth, parseCanonicalEvent, ADAPTERS, DEFAULT_EVENT_TYPES, MAX_BODY_BYTES, processInventoryEvent, invalidateStockCaches, SOURCE_WEBHOOK } from '../services/amb/inventoryApi.js';

/** Counters + last rejection reason (no secret value ever), readable by diagnostics. */
export const inventoryWebhookHealth = { accepted: 0, rejected: 0, ignored: 0, lastAcceptedAt: null, lastRejectedAt: null, lastRejection: null, lastEventAt: null, applied: 0, unresolved: 0 };

const envTypes = () => String(process.env.INVENTORY_WEBHOOK_EVENT_TYPES || '').split(',').map((s) => s.trim()).filter(Boolean);

export function createInventoryWebhookRouter(overrides = {}) {
  const d = {
    logger: defaultLogger,
    secret: () => process.env.INVENTORY_WEBHOOK_SECRET || '',
    authMode: () => process.env.INVENTORY_WEBHOOK_AUTH_MODE || 'auto', // auto | hmac | secret
    toleranceSec: () => Number(process.env.INVENTORY_WEBHOOK_TOLERANCE_SEC) || 300,
    adapter: () => process.env.INVENTORY_WEBHOOK_ADAPTER || 'canonical',
    allowedTypes: () => (envTypes().length ? envTypes() : DEFAULT_EVENT_TYPES),
    process: processInventoryEvent, invalidate: invalidateStockCaches, now: () => new Date(),
    ...overrides,
  };
  const router = Router();
  const limiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const throttle = new Map();
  function logThrottled(level, key, message, fields) { const now = Date.now(); const e = throttle.get(key) || { count: 0, last: 0 }; e.count++; if (now - e.last >= 5 * 60_000) { d.logger[level](message, { ...fields, suppressedSincePrevious: e.count - 1 }); e.count = 0; e.last = now; } throttle.set(key, e); }

  router.post('/', limiter, raw({ type: () => true, limit: MAX_BODY_BYTES }), asyncRoute(async (req, res) => {
    const secret = d.secret();
    if (!secret) return res.status(503).json({ error: 'WEBHOOK_NOT_CONFIGURED' }); // never accept without a configured secret
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const auth = verifyWebhookAuth({ headers: req.headers, rawBody, secret, now: d.now().getTime(), mode: d.authMode(), toleranceSec: d.toleranceSec() });
    if (!auth.ok) {
      inventoryWebhookHealth.rejected++; inventoryWebhookHealth.lastRejectedAt = d.now().toISOString(); inventoryWebhookHealth.lastRejection = { reason: auth.reason };
      logThrottled('warn', `401|${auth.reason}`, 'Inventory webhook REJECTED', { reason: auth.reason, userAgent: String(req.headers['user-agent'] || '').slice(0, 40), hasSignature: !!req.headers['x-inventory-signature'], hasSecretHeader: !!req.headers['x-inventory-secret'] }); // header PRESENCE only, never a value
      return res.status(401).json({ error: 'UNAUTHORIZED', reason: auth.reason });
    }
    let body;
    try { body = JSON.parse(rawBody.toString('utf8')); } catch { return res.status(400).json({ error: 'INVALID_JSON' }); }
    const adapt = ADAPTERS[d.adapter()];
    if (!adapt) return res.status(503).json({ error: 'ADAPTER_NOT_CONFIGURED' });
    let canonical; try { canonical = adapt(body); } catch { return res.status(400).json({ error: 'INVALID_PAYLOAD', errors: ['ADAPTER_FAILED'] }); }
    const parsed = parseCanonicalEvent(canonical, { allowedTypes: d.allowedTypes(), rawBody });
    if (!parsed.ok) return res.status(parsed.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400).json({ error: parsed.code, errors: parsed.errors });
    inventoryWebhookHealth.accepted++; inventoryWebhookHealth.lastAcceptedAt = d.now().toISOString();
    if (parsed.ignored) { inventoryWebhookHealth.ignored++; return res.status(200).json({ ok: true, ignored: true, reason: 'EVENT_TYPE_NOT_SUPPORTED', eventType: parsed.eventType }); }
    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
    const out = await d.process({ event: parsed.event, source: SOURCE_WEBHOOK, now: d.now(), dryRun });
    if (!dryRun) {
      inventoryWebhookHealth.lastEventAt = d.now().toISOString();
      inventoryWebhookHealth.applied += out.counts.APPLIED || 0;
      inventoryWebhookHealth.unresolved += (out.counts.UNMAPPED || 0) + (out.counts.SUGGESTED || 0) + (out.counts.CONFLICT || 0) + (out.counts.MAPPING_ERROR || 0);
      if (out.touched.length) await d.invalidate(out.touched);
    }
    d.logger.info('Inventory webhook processed', { eventId: parsed.event.eventId, type: parsed.event.eventType, dryRun, counts: out.counts, method: auth.method });
    res.status(200).json({ ok: true, eventId: parsed.event.eventId, dryRun, replayProtected: auth.replayProtected, counts: out.counts, results: out.results.map(({ index, status, reason, productId, store, match, via, before, after, candidates, errors }) => ({ index, status, reason: reason || null, match, via, productId: productId ?? null, store: store ?? null, before: before ?? null, after: after ?? null, candidates: candidates?.length ? candidates : undefined, errors })) });
  }));

  // a too-large body must answer 413 (not the generic 500) and never echo the payload
  router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err?.type === 'entity.too.large' || err?.status === 413) return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', maxBytes: MAX_BODY_BYTES });
    d.logger.error('Inventory webhook error', { message: err?.message });
    return res.status(500).json({ error: 'SERVER_ERROR' });
  });
  return router;
}

export default createInventoryWebhookRouter();
