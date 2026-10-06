// 📦 Periodic API reconciliation for the inventory feed (the safety net for a lost webhook). 2026-10-06.
// The provider contract (base URL / endpoint / auth / response) is NOT known yet, so the real fetcher does not exist: `buildFetcherFromEnv()` returns null and
// `runInventoryReconcile()` answers NOT_CONFIGURED without any network call. When the adapter is written it only has to return the CANONICAL item list; everything
// below (batching, timeout, retry/backoff, no-overlap, store isolation, ordering, freshness, audit) is already in place and tested with an injected fetcher.
// Nothing here can reach Meta, and an API failure NEVER turns stock into zero: it records API_ERROR and the products simply age toward STALE.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { parseItem, processInventoryEvent, touchVerified, invalidateStockCaches, SOURCE_RECONCILE } from './inventoryApi.js';

export const RECONCILE_BATCH = 100;
export const RECONCILE_FETCH_TIMEOUT_MS = 20_000;
export const RECONCILE_MAX_ATTEMPTS = 3;
let running = false;
export const reconcileState = { lastRun: null, lastError: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The real provider fetcher. null until the provider's documentation is known (no URL is ever guessed). */
export function buildFetcherFromEnv() { return null; }

export async function withRetry(fn, { attempts = RECONCILE_MAX_ATTEMPTS, baseMs = 500, timeoutMs = RECONCILE_FETCH_TIMEOUT_MS, sleepFn = sleep } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await Promise.race([fn(), new Promise((_, rej) => { const t = setTimeout(() => rej(Object.assign(new Error('INVENTORY_FETCH_TIMEOUT'), { code: 'TIMEOUT' })), timeoutMs); t.unref?.(); })]);
    } catch (e) {
      last = e;
      if (e?.status && e.status >= 400 && e.status < 500 && e.status !== 429) break; // a 4xx (except rate limit) will not fix itself
      if (i < attempts) await sleepFn(baseMs * 2 ** (i - 1) + Math.floor(Math.random() * 100));
    }
  }
  throw last;
}

async function audit(ok, info, error = null) {
  try { await prisma.aiAuditLog.create({ data: { actor_id: null, kind: 'INVENTORY_RECONCILE', action: 'EXECUTE', success: ok, error: error ? String(error).slice(0, 300) : null, input_json: JSON.stringify(info).slice(0, 3000) } }); }
  catch (e) { logger.error('[inventoryReconcile] audit write failed', { message: e.message }); }
}

/**
 * fetchAll() -> array of RAW items in the canonical item shape (the adapter's job). Items are validated, matched (VERIFIED only), applied in batches.
 * Concurrent calls are refused (no overlap). `deps` is for tests.
 */
export async function runInventoryReconcile({ fetchAll = buildFetcherFromEnv(), now = new Date(), deps = {} } = {}) {
  if (!fetchAll) return { skipped: 'NOT_CONFIGURED', message: 'مفيش Base URL/Documentation لنظام المخزون — الـReconciliation متوقف (مفيش اتصال).' };
  if (running) return { skipped: 'ALREADY_RUNNING' };
  running = true;
  const t0 = Date.now();
  try {
    let items;
    try { items = await withRetry(fetchAll, deps.retry || {}); }
    catch (e) {
      reconcileState.lastError = { at: now.toISOString(), message: e.message };
      await audit(false, { stage: 'FETCH' }, e.message);
      return { ok: false, state: 'API_ERROR', error: e.message, stockChanged: false }; // stock is left exactly as it was — never zero
    }
    if (!Array.isArray(items)) { await audit(false, { stage: 'SHAPE' }, 'NOT_AN_ARRAY'); return { ok: false, state: 'API_ERROR', error: 'RESPONSE_NOT_AN_ARRAY', stockChanged: false }; }
    const parsed = items.map((raw, index) => ({ index, ...parseItem(raw) }));
    const counts = {}; const touched = new Set();
    for (let i = 0; i < parsed.length; i += RECONCILE_BATCH) {
      const chunk = parsed.slice(i, i + RECONCILE_BATCH).map((p, k) => ({ ...p, index: k }));
      const event = { eventId: `reconcile_${now.getTime()}_${i}`, eventType: 'reconcile', occurredAt: now, version: null, items: chunk };
      const out = await (deps.process || processInventoryEvent)({ event, source: SOURCE_RECONCILE, now, links: deps.links });
      for (const [k, v] of Object.entries(out.counts)) counts[k] = (counts[k] || 0) + v;
      for (const id of out.touched) touched.add(id);
      // the source re-confirmed a value we already hold (an older/equal event): refresh freshness only
      for (const r of out.results) if (r.status === 'STALE_EVENT' && r.productId != null) {
        const it = chunk[r.index]?.item;
        if (it && r.before?.available === it.available) { await (deps.touch || touchVerified)(r.productId, now); touched.add(r.productId); }
      }
      if (i + RECONCILE_BATCH < parsed.length) await (deps.sleep || sleep)(deps.batchPauseMs ?? 250); // gentle on the DB
    }
    if (touched.size) await (deps.invalidate || invalidateStockCaches)([...touched]);
    reconcileState.lastRun = { at: now.toISOString(), counts, ms: Date.now() - t0 }; reconcileState.lastError = null;
    await audit(true, { counts, items: parsed.length, ms: Date.now() - t0 });
    return { ok: true, counts, items: parsed.length, touched: touched.size };
  } finally { running = false; }
}
export const isReconcileRunning = () => running;
