// Easy Orders STATUS SYNC — central engine (2026-10-02 audit).
//
// Root causes this module addresses (all proven with live API samples + production logs, see the audit report):
//  1. The old reconcile loop swallowed every non-200 (429 rate-limit and 400 "record not found" both became a silent
//     `null`), re-walked ~10.9k active orders every 2 minutes with no overlap guard, and had no per-key rate budget —
//     so it spent its life inside the 40 req/min cap (shared with production) and nobody could tell.
//  2. An order was only ever checked with the key of the store it is TAGGED with. ~1.9k orders tagged `default` belong to
//     the other Easy Orders account, so the default key answers 400 forever. Those orders could never be reconciled.
//  3. In Easy Orders itself most orders really are still `pending` (confirmation/shipping happen outside Easy Orders), so
//     downstream "confirmation rate" numbers are not evidence. The store-level STATUS TRUST below makes that explicit and
//     central so every consumer (performance block, COD quality, Data Quality, Smart Advisor) stops treating it as signal.
//
// Nothing here writes to Meta. DB writes: EasyOrdersOrder status/raw_status via the existing applyStatusToOrder()
// (so DailyOrder/customer aggregates recompute exactly like the webhook path) and, additively, easy_orders_store_id.
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { listStores, getStoreApiKey } from './easyOrdersStores.js';
import { EASYORDERS_API_BASE, normalizeStatus, applyStatusToOrder } from './easyOrders.js';

// ---------------------------------------------------------------------------
// Status trust (pure judge + cached DB read)
// ---------------------------------------------------------------------------
export const TRUST = { MATURE_DAYS: 5, MIN_MATURE_ORDERS: 30, NO_SIGNAL_SHARE: 0.05, PARTIAL_SHARE: 0.25 };

/**
 * Pure. `matureOrders` = orders old enough that a real operation would have moved them off PENDING;
 * `nonPending` = how many of those are confirmed/delivered/returned/cancelled.
 *  NO_STATUS_SIGNAL — under 5% moved: a real COD operation cancels/returns far more than that, so the statuses are not maintained.
 */
export function judgeStatusTrust({ matureOrders, nonPending }) {
  const m = Number(matureOrders) || 0, np = Number(nonPending) || 0;
  if (m < TRUST.MIN_MATURE_ORDERS) return { state: 'INSUFFICIENT_SAMPLE', share: m ? np / m : null, matureOrders: m, nonPending: np };
  const share = np / m;
  const state = share < TRUST.NO_SIGNAL_SHARE ? 'NO_STATUS_SIGNAL' : share < TRUST.PARTIAL_SHARE ? 'PARTIAL' : 'OK';
  return { state, share, matureOrders: m, nonPending: np };
}
const TRUST_NOTE_AR = {
  NO_STATUS_SIGNAL: 'حالات الأوردرات في Easy Orders غير محدّثة (أغلبها لسه PENDING حتى القديمة) — نسب التأكيد/التسليم مش دليل ومش بتتعرض.',
  PARTIAL: 'حالات الأوردرات محدّثة جزئيًا فقط — نسب التأكيد/التسليم أقل من الحقيقة.',
  OK: 'حالات الأوردرات بتتحدّث بشكل طبيعي.',
  INSUFFICIENT_SAMPLE: 'مفيش أوردرات ناضجة كفاية للحكم على موثوقية الحالات.',
};

const trustCache = new Map(); // storeKey -> {at, value}
const TRUST_TTL_MS = 10 * 60_000;
export function invalidateStatusTrustCache() { trustCache.clear(); }

/** Store-level trust (storeId null = every store). Mature = created more than TRUST.MATURE_DAYS ago. */
export async function getStoreStatusTrust(storeId = null, { now = new Date(), force = false } = {}) {
  const k = storeId || '*';
  const hit = trustCache.get(k);
  if (!force && hit && now.getTime() - hit.at < TRUST_TTL_MS) return hit.value;
  const cutoff = new Date(now.getTime() - TRUST.MATURE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = await prisma.easyOrdersOrder.groupBy({ by: ['status'], where: { ...(storeId ? { store_id: storeId } : {}), date: { lt: cutoff } }, _count: { _all: true } });
  const total = rows.reduce((a, r) => a + r._count._all, 0);
  const pending = rows.filter((r) => r.status === 'PENDING').reduce((a, r) => a + r._count._all, 0);
  const verdict = judgeStatusTrust({ matureOrders: total, nonPending: total - pending });
  const value = { ...verdict, storeId, cutoffDate: cutoff, note: TRUST_NOTE_AR[verdict.state], checkedAt: now.toISOString() };
  trustCache.set(k, { at: now.getTime(), value });
  return value;
}

// ---------------------------------------------------------------------------
// Rate-limited, classified Easy Orders client
// ---------------------------------------------------------------------------
const keyId = (apiKey) => crypto.createHash('sha1').update(String(apiKey)).digest('hex').slice(0, 8);
const buckets = new Map(); // keyId -> {tokens, last}
export const DEFAULT_PER_MINUTE = 30; // Easy Orders' cap is ~40/min per key and production shares the key — stay well under

/** Token bucket per API key (never logs the key). */
export async function acquire(apiKey, { perMinute = DEFAULT_PER_MINUTE, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const id = keyId(apiKey);
  const b = buckets.get(id) || { tokens: perMinute, last: now() };
  for (;;) {
    const t = now();
    b.tokens = Math.min(perMinute, b.tokens + ((t - b.last) / 60_000) * perMinute);
    b.last = t;
    if (b.tokens >= 1) { b.tokens -= 1; buckets.set(id, b); return; }
    buckets.set(id, b);
    await sleep(Math.ceil(((1 - b.tokens) / perMinute) * 60_000) + 50);
  }
}
export function resetRateBuckets() { buckets.clear(); }

/**
 * One order, one key. Classified — never a bare null:
 *  OK | NOT_FOUND (404, or 400 "record not found" — the key cannot see this order) | RATE_LIMITED (429 after retries) | ERROR
 */
export async function fetchOrderClassified(orderId, apiKey, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), maxRetries = 2, perMinute = DEFAULT_PER_MINUTE } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await acquire(apiKey, { perMinute, now, sleep });
    let res;
    try { res = await fetchImpl(`${EASYORDERS_API_BASE}/orders/${orderId}`, { headers: { 'Api-Key': apiKey } }); }
    catch (err) { last = { kind: 'ERROR', http: null, error: err.message }; await sleep(1000 * (attempt + 1)); continue; }
    if (res.status === 200) return { kind: 'OK', http: 200, order: await res.json() };
    const text = await res.text().catch(() => '');
    if (res.status === 404 || (res.status === 400 && /not found/i.test(text))) return { kind: 'NOT_FOUND', http: res.status };
    if (res.status === 429) {
      last = { kind: 'RATE_LIMITED', http: 429 };
      const ra = Number(res.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15_000 * (attempt + 1));
      continue;
    }
    last = { kind: 'ERROR', http: res.status, error: text.slice(0, 80) };
    if (res.status < 500) break; // a 4xx other than the ones above will not heal on retry
    await sleep(1000 * (attempt + 1));
  }
  return last || { kind: 'ERROR', http: null };
}

/** Candidate keys for an order: the store it is tagged with first, then every other distinct configured key. */
export function candidateStores(hintStoreId, stores = listStores(), keyOf = getStoreApiKey) {
  const ordered = [];
  const push = (id) => { const key = keyOf(id); if (key && !ordered.some((o) => o.key === key)) ordered.push({ storeId: id, key }); };
  if (hintStoreId) push(hintStoreId);
  for (const s of stores) if (s.enabled !== false) push(s.id);
  return ordered;
}

/** Resolves an order across the configured stores' keys. Tells the caller which store actually owns it (tag-mismatch audit). */
export async function resolveOrderAcrossStores(orderId, hintStoreId, deps = {}) {
  const cands = deps.candidates || candidateStores(hintStoreId, deps.stores, deps.keyOf);
  let sawRateLimit = false, sawError = false;
  for (const c of cands) {
    const r = await fetchOrderClassified(orderId, c.key, deps);
    if (r.kind === 'OK') return { kind: 'OK', order: r.order, foundWithStoreId: c.storeId, tried: cands.map((x) => x.storeId) };
    if (r.kind === 'RATE_LIMITED') sawRateLimit = true;
    if (r.kind === 'ERROR') sawError = true;
  }
  return { kind: sawRateLimit ? 'RATE_LIMITED' : sawError ? 'ERROR' : 'NOT_FOUND', tried: cands.map((x) => x.storeId) };
}

// ---------------------------------------------------------------------------
// Reconcile (bounded, resumable, observable)
// ---------------------------------------------------------------------------
const lastChecked = new Map(); // orderId -> ms
const ownerHint = new Map(); // our store tag -> store id whose key actually owns most of that tag's orders (learned), so a mis-tagged store is not probed with a guaranteed-400 key first
const cursor = { skip: 0 };
export const RECHECK_MS = { recent: 6 * 3600_000, old: 24 * 3600_000 };
export function resetReconcileState() { lastChecked.clear(); ownerHint.clear(); cursor.skip = 0; }

function daysBetween(a, b) { return (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000; }

/**
 * Checks at most `limit` active orders against Easy Orders and applies real status changes through applyStatusToOrder().
 * Prioritises recent orders, skips ones checked recently, stops early on sustained rate-limiting, and returns exact counters
 * (checked / changed / notFound / rateLimited / errors / tag mismatches / raw status histogram) so nothing is silent any more.
 */
export async function reconcileOrders({ limit = 30, dryRun = false, only = null, now = new Date(), deps = {}, fillStoreId = false } = {}) {
  const stats = { limit, dryRun, scanned: 0, checked: 0, changed: 0, notFound: 0, rateLimited: 0, errors: 0, storeIdFilled: 0, tagMismatch: {}, eoStatuses: {}, changes: [], startedAt: now.toISOString() };
  const page = 400;
  let skip = cursor.skip;
  const picked = [];
  let wrapped = false;
  while (picked.length < limit) {
    const rows = await prisma.easyOrdersOrder.findMany({
      where: { status: { in: ['PENDING', 'CONFIRMED'] }, ...(only?.storeId ? { store_id: only.storeId } : {}), ...(only?.orderIds ? { order_id: { in: only.orderIds } } : {}) },
      select: { order_id: true, store_id: true, date: true, easy_orders_store_id: true }, distinct: ['order_id'], orderBy: [{ date: 'desc' }, { id: 'desc' }], skip, take: page,
    });
    if (!rows.length) { if (wrapped || skip === 0) break; skip = 0; wrapped = true; continue; }
    let consumed = rows.length;
    for (const [i, r] of rows.entries()) {
      stats.scanned++;
      const recent = daysBetween(r.date, now) <= 14;
      const t = lastChecked.get(r.order_id);
      if (t && now.getTime() - t < (recent ? RECHECK_MS.recent : RECHECK_MS.old)) continue;
      picked.push(r);
      if (picked.length >= limit) { consumed = i + 1; break; } // only advance past what was actually examined — never skip unexamined orders
    }
    skip += consumed;
    if (rows.length < page) { if (picked.length < limit && !wrapped && skip > page) { skip = 0; wrapped = true; continue; } break; }
  }
  cursor.skip = skip;

  let consecutiveRateLimited = 0;
  for (const row of picked) {
    const res = await resolveOrderAcrossStores(row.order_id, ownerHint.get(row.store_id) || row.store_id, deps);
    lastChecked.set(row.order_id, now.getTime());
    if (res.kind === 'RATE_LIMITED') { stats.rateLimited++; if (++consecutiveRateLimited >= 3) { stats.stoppedEarly = 'RATE_LIMITED'; break; } continue; }
    consecutiveRateLimited = 0;
    if (res.kind === 'NOT_FOUND') { stats.notFound++; continue; }
    if (res.kind === 'ERROR') { stats.errors++; continue; }
    stats.checked++;
    const raw = res.order.status;
    stats.eoStatuses[raw] = (stats.eoStatuses[raw] || 0) + 1;
    if (res.foundWithStoreId !== row.store_id) { ownerHint.set(row.store_id, res.foundWithStoreId); const k = `${row.store_id}->${res.foundWithStoreId}`; stats.tagMismatch[k] = (stats.tagMismatch[k] || 0) + 1; }
    const target = normalizeStatus(raw);
    const stored = await prisma.easyOrdersOrder.findMany({ where: { order_id: row.order_id }, select: { id: true, status: true, raw_status: true, easy_orders_store_id: true } });
    const wouldChange = stored.some((s) => s.status !== target || s.raw_status !== raw);
    if (wouldChange) {
      stats.changed++;
      if (stats.changes.length < 25) stats.changes.push({ order: row.order_id.slice(0, 8), from: stored[0]?.raw_status, to: raw, normalized: target });
      if (!dryRun) { await deps.beforeApply?.(row.order_id, stored); await applyStatusToOrder(row.order_id, raw); }
    }
    // additive metadata: Easy Orders' own account UUID, only where it was never recorded. OPT-IN (`fillStoreId`) — the scheduled job
    // never sets it, so a routine tick can never become a slow backfill of old orders.
    if (fillStoreId && !dryRun && res.order.store_id && stored.some((s) => !s.easy_orders_store_id)) {
      const r = await prisma.easyOrdersOrder.updateMany({ where: { order_id: row.order_id, easy_orders_store_id: null }, data: { easy_orders_store_id: String(res.order.store_id) } });
      stats.storeIdFilled += r.count;
    }
  }
  stats.finishedAt = new Date().toISOString();
  if (stats.changed > 0 && !dryRun) invalidateStatusTrustCache();
  return stats;
}

/**
 * Re-derives `status` from the stored raw_status for rows the (old) normaliser mis-bucketed — e.g. `in_delivery` was stored
 * as DELIVERED. Uses applyStatusToOrder so DailyOrder + customer aggregates recompute like any status change.
 */
export async function remapStoredStatuses({ dryRun = false, orderIds = null, beforeApply = null } = {}) {
  const rows = await prisma.easyOrdersOrder.findMany({ where: { raw_status: { not: null }, ...(orderIds ? { order_id: { in: orderIds } } : {}) }, select: { order_id: true, status: true, raw_status: true }, distinct: ['order_id', 'status', 'raw_status'] });
  const wrong = rows.filter((r) => normalizeStatus(r.raw_status) !== r.status);
  const byOrder = new Map(wrong.map((r) => [r.order_id, r]));
  const out = { examined: rows.length, wrong: byOrder.size, fixed: 0, changes: [...byOrder.values()].map((r) => `${r.raw_status}: ${r.status} -> ${normalizeStatus(r.raw_status)}`) };
  if (!dryRun) for (const r of byOrder.values()) { await beforeApply?.(r.order_id, r); const x = await applyStatusToOrder(r.order_id, r.raw_status); out.fixed += x.changedRows > 0 ? 1 : 0; }
  if (out.fixed) invalidateStatusTrustCache();
  return out;
}

/** Read-only sample audit: which of OUR store keys actually owns a sample of orders tagged with each store. */
export async function auditStoreTags({ perStore = 10, deps = {} } = {}) {
  const out = {};
  for (const s of listStores()) {
    const total = await prisma.easyOrdersOrder.count({ where: { store_id: s.id } });
    const sample = [];
    for (let i = 0; i < Math.min(perStore, total); i++) {
      const r = await prisma.easyOrdersOrder.findFirst({ where: { store_id: s.id }, skip: Math.floor(Math.random() * total), select: { order_id: true } });
      if (r) sample.push(r.order_id);
    }
    const tally = { tagged: s.id, totalRows: total, sampled: 0, ownedBy: {}, notFound: 0, unresolved: 0 };
    for (const id of sample) {
      const r = await resolveOrderAcrossStores(id, s.id, deps);
      tally.sampled++;
      if (r.kind === 'OK') tally.ownedBy[r.foundWithStoreId] = (tally.ownedBy[r.foundWithStoreId] || 0) + 1;
      else if (r.kind === 'NOT_FOUND') tally.notFound++;
      else tally.unresolved++;
    }
    out[s.id] = tally;
  }
  return out;
}

/** Last tick summary — surfaced by diagnostics so the job is never silent again. */
export const reconcileHealth = { lastTickAt: null, lastStats: null, running: false, ticks: 0, totals: { checked: 0, changed: 0, notFound: 0, rateLimited: 0, errors: 0 } };
export function recordTick(stats) {
  reconcileHealth.lastTickAt = new Date().toISOString();
  reconcileHealth.lastStats = { checked: stats.checked, changed: stats.changed, notFound: stats.notFound, rateLimited: stats.rateLimited, errors: stats.errors, tagMismatch: stats.tagMismatch, stoppedEarly: stats.stoppedEarly || null };
  reconcileHealth.ticks++;
  for (const k of Object.keys(reconcileHealth.totals)) reconcileHealth.totals[k] += stats[k] || 0;
  if (stats.rateLimited || stats.errors || stats.changed || stats.notFound) logger.info('EasyOrders status reconcile tick', reconcileHealth.lastStats);
}
