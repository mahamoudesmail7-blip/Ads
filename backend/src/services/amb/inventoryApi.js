// 📦 Inventory API integration core (webhook + reconciliation share this). 2026-10-06.
//   Inventory System → Webhook → InventorySnapshot → resolveStockInputs (stockGuard) → Stock Guard / Readiness / Advisor / Rules / AI Operator
// There is NO parallel inventory system: stock lands in the existing `InventorySnapshot` table (source INVENTORY_API/WEBHOOK | INVENTORY_API/RECONCILE) and
// is read through the ONE central resolver (stockGuard.resolveStockInputs). A product only PREFERS the API over its manual/catalogue stock after the owner
// approves it (productOverrides[pid].inventory.primary) — until then API snapshots are stored and shown for comparison, manual stays authoritative.
// Rules that never bend: unknown/stale/errored is NEVER zero; the name alone is never VERIFIED; nothing is created automatically (no Product, no mapping);
// nothing here can reach Meta (no executor import); a duplicate or older event can never change the stock.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getOperatorConfig } from './operatorStore.js';

export const SOURCE_WEBHOOK = 'INVENTORY_API/WEBHOOK';
export const SOURCE_RECONCILE = 'INVENTORY_API/RECONCILE';
export const isApiSource = (s) => String(s || '').startsWith('INVENTORY_API');
export const DEFAULT_EVENT_TYPES = ['stock.updated', 'inventory.updated', 'product.updated']; // overridable (INVENTORY_WEBHOOK_EVENT_TYPES) — the real names come from the provider's docs
export const MAX_ITEMS_PER_EVENT = 200;
export const MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_STALE_HOURS = 72;
export const INVENTORY_STATES = ['VERIFIED', 'STALE', 'UNKNOWN', 'API_ERROR', 'MAPPING_ERROR'];

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const MS_H = 3_600_000;
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);
const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

// =====================================================================================================================
// 1. AUTHENTICATION (pure) — HMAC-SHA256 signature when the sender signs, otherwise a shared secret header. Never a query parameter.
// =====================================================================================================================
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const header = (h, name) => { const v = h?.[name] ?? h?.[name.toLowerCase()]; return Array.isArray(v) ? v[0] : v; };
/**
 * headers: node-style lowercase map. Signature scheme (adjustable once the provider's real scheme is known):
 *   X-Inventory-Signature: [sha256=]<hex hmac-sha256>  over  `${X-Inventory-Timestamp}.${rawBody}`  (timestamp header present)  or  over rawBody
 *   or a shared secret in  X-Inventory-Secret  /  Authorization: Bearer <secret>
 * A PRESENT-but-wrong signature is a rejection (never downgraded to the shared-secret path). Returns {ok, method, replayProtected, reason}.
 */
export function verifyWebhookAuth({ headers, rawBody, secret, now = Date.now(), mode = 'auto', toleranceSec = 300 }) {
  if (!secret) return { ok: false, reason: 'NOT_CONFIGURED' };
  const sig = header(headers, 'x-inventory-signature');
  const ts = header(headers, 'x-inventory-timestamp');
  if (sig) {
    if (mode === 'secret') return { ok: false, reason: 'SIGNATURE_NOT_ACCEPTED_IN_SECRET_MODE' };
    const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''));
    const signed = ts ? Buffer.concat([Buffer.from(`${ts}.`), raw]) : raw;
    const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
    const given = String(sig).trim().replace(/^sha256=/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(given) || !safeEq(given, expected)) return { ok: false, reason: 'INVALID_SIGNATURE' };
    if (ts) {
      const t = /^\d+$/.test(String(ts)) ? Number(ts) * (String(ts).length <= 11 ? 1000 : 1) : Date.parse(String(ts));
      if (!Number.isFinite(t) || Math.abs(now - t) > toleranceSec * 1000) return { ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' };
      return { ok: true, method: 'HMAC', replayProtected: true };
    }
    return { ok: true, method: 'HMAC', replayProtected: false };
  }
  if (mode === 'hmac') return { ok: false, reason: 'SIGNATURE_REQUIRED' };
  const bearer = String(header(headers, 'authorization') || '').replace(/^Bearer\s+/i, '');
  const given = header(headers, 'x-inventory-secret') || bearer;
  if (given && safeEq(given, secret)) return { ok: true, method: 'SECRET', replayProtected: false };
  return { ok: false, reason: given ? 'INVALID_SECRET' : 'MISSING_CREDENTIALS' };
}

// =====================================================================================================================
// 2. PAYLOAD → canonical event (pure). The CANONICAL schema below is OUR contract; a provider adapter maps its payload into it (ADAPTERS).
// =====================================================================================================================
/**
 * {
 *   "event_id": "evt_123",              // idempotency key (optional; else a hash of the body)
 *   "event_type": "stock.updated",      // one of INVENTORY_WEBHOOK_EVENT_TYPES
 *   "occurred_at": "2026-10-06T12:00:00Z", // when the stock changed AT THE SOURCE (out-of-order protection) — or "version": 17
 *   "store_id": "trendy-storeee",       // optional: OUR store id, restricts matching (never merges stores)
 *   "warehouse": "main",                // optional
 *   "items": [{ "external_product_id": "..", "sku": "..", "barcode": "..", "easy_orders_uuid": "..", "name": "..",
 *               "current_stock": 10, "reserved": 2, "available": 8, "minimum_stock": 5, "updated_at": "..", "warehouse": "..", "store_id": ".." }]
 * }
 * A flat payload (item fields at the top level, no `items`) is accepted as a one-item event.
 */
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
function parseDate(v) { if (v === undefined || v === null || v === '') return null; const n = Number(v); const d = Number.isFinite(n) && String(v).trim() !== '' ? new Date(n < 1e11 ? n * 1000 : n) : new Date(v); return Number.isNaN(d.getTime()) ? NaN : d; }

export function parseItem(raw, ctx = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['ITEM_NOT_AN_OBJECT'] };
  const item = {
    externalProductId: str(pick(raw, 'external_product_id', 'externalProductId', 'product_id', 'productId', 'id')),
    sku: str(pick(raw, 'sku', 'SKU')), barcode: str(pick(raw, 'barcode', 'ean', 'upc')), easyOrdersUuid: str(pick(raw, 'easy_orders_uuid', 'easyOrdersUuid')),
    name: str(pick(raw, 'name', 'product_name', 'productName')), storeId: str(pick(raw, 'store_id', 'storeId')) || ctx.storeId || null, warehouse: str(pick(raw, 'warehouse', 'warehouse_id', 'warehouseId')) || ctx.warehouse || null,
  };
  if (!item.externalProductId && !item.sku && !item.barcode && !item.easyOrdersUuid && !item.name) errors.push('NO_PRODUCT_IDENTITY');
  const cur = num(pick(raw, 'current_stock', 'currentStock', 'stock', 'quantity', 'on_hand', 'onHand'));
  const res = num(pick(raw, 'reserved', 'reserved_stock', 'reservedStock', 'allocated'));
  const av = num(pick(raw, 'available', 'available_stock', 'availableStock'));
  const min = num(pick(raw, 'minimum_stock', 'minimumStock', 'min_stock', 'reorder_level'));
  for (const [k, v] of Object.entries({ current_stock: cur, reserved: res, available: av, minimum_stock: min })) if (Number.isNaN(v) || (v !== null && v < 0)) errors.push(`${k.toUpperCase()}_INVALID`);
  if (cur === null && av === null) errors.push('NO_STOCK_VALUE');
  const at = parseDate(pick(raw, 'updated_at', 'updatedAt', 'occurred_at', 'occurredAt'));
  if (Number.isNaN(at)) errors.push('UPDATED_AT_INVALID');
  if (errors.length) return { ok: false, errors, item };
  // Available = what can be promised. Provided -> as is; else current - reserved; else (reserved unknown) current, flagged.
  const current = cur ?? (av !== null && res !== null ? av + res : av);
  const available = av !== null ? av : (res !== null ? Math.max(0, cur - res) : cur);
  return { ok: true, item: { ...item, current, reserved: res, available, reservedUnknown: res === null && av === null, minimumStock: min, updatedAt: at } };
}

export function parseCanonicalEvent(body, { allowedTypes = DEFAULT_EVENT_TYPES, rawBody = '' } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, code: 'INVALID_PAYLOAD', errors: ['BODY_NOT_AN_OBJECT'] };
  const type = str(pick(body, 'event_type', 'eventType', 'type', 'event'));
  if (!type) return { ok: false, code: 'INVALID_PAYLOAD', errors: ['EVENT_TYPE_MISSING'] };
  if (!allowedTypes.includes(type)) return { ok: true, ignored: true, eventType: type };
  const occurredAt = parseDate(pick(body, 'occurred_at', 'occurredAt', 'timestamp', 'created_at'));
  if (Number.isNaN(occurredAt)) return { ok: false, code: 'INVALID_PAYLOAD', errors: ['OCCURRED_AT_INVALID'] };
  const version = num(pick(body, 'version', 'sequence'));
  if (Number.isNaN(version)) return { ok: false, code: 'INVALID_PAYLOAD', errors: ['VERSION_INVALID'] };
  const ctx = { storeId: str(pick(body, 'store_id', 'storeId')), warehouse: str(pick(body, 'warehouse', 'warehouse_id')) };
  let rawItems = pick(body, 'items', 'products');
  if (rawItems === undefined) rawItems = [body]; // flat single-item payload
  if (!Array.isArray(rawItems) || !rawItems.length) return { ok: false, code: 'INVALID_PAYLOAD', errors: ['ITEMS_EMPTY'] };
  if (rawItems.length > MAX_ITEMS_PER_EVENT) return { ok: false, code: 'PAYLOAD_TOO_LARGE', errors: [`MAX_${MAX_ITEMS_PER_EVENT}_ITEMS`] };
  const eventId = str(pick(body, 'event_id', 'eventId', 'id')) || `h_${crypto.createHash('sha1').update(Buffer.isBuffer(rawBody) ? rawBody : String(rawBody)).digest('hex').slice(0, 24)}`;
  const items = rawItems.map((r, i) => ({ index: i, ...parseItem(r, ctx) }));
  return { ok: true, event: { eventId, eventType: type, occurredAt, version, storeId: ctx.storeId, warehouse: ctx.warehouse, items } };
}
/** Adapter registry: a provider adapter converts the REAL payload into the canonical body. Only `canonical` exists until the provider's documentation is known. */
export const ADAPTERS = { canonical: (body) => body };

// =====================================================================================================================
// 3. PRODUCT MATCHING (I/O, read-only). Explicit -> SKU -> Barcode (explicit only: Product has no barcode column) -> External ID / Easy Orders UUID -> name (SUGGESTED only).
// =====================================================================================================================
export async function loadInventoryLinks() { return (await getOperatorConfig()).limits?.inventoryLinks || {}; }
export const linkKey = (kind, value) => `${kind}:${String(value).trim().toLowerCase()}`;

/** items = parsed items; returns Map(index -> match). Batched: 3 queries for the whole event. */
export async function matchItems(items, { links = null } = {}) {
  const L = links || await loadInventoryLinks();
  const skus = [...new Set(items.flatMap((i) => [i.sku, i.externalProductId, i.barcode]).filter(Boolean))];
  const uuids = [...new Set(items.flatMap((i) => [i.easyOrdersUuid, i.externalProductId]).filter(Boolean))];
  const names = [...new Set(items.map((i) => i.name).filter(Boolean))];
  const sel = { id: true, product_name: true, sku: true, product_code: true, store_id: true, easy_orders_uuid: true, minimum_stock: true, current_stock: true };
  const bySku = skus.length ? await prisma.product.findMany({ where: { OR: [{ sku: { in: skus, mode: 'insensitive' } }, { product_code: { in: skus, mode: 'insensitive' } }] }, select: sel }) : [];
  const byUuid = uuids.length ? await prisma.product.findMany({ where: { easy_orders_uuid: { in: uuids } }, select: sel }) : [];
  const byName = names.length ? await prisma.product.findMany({ where: { OR: names.map((n) => ({ product_name: { equals: n, mode: 'insensitive' } })) }, select: sel }) : [];
  const explicitIds = [...new Set(Object.values(L).map((l) => l.productId))];
  const explicit = explicitIds.length ? new Map((await prisma.product.findMany({ where: { id: { in: explicitIds } }, select: sel })).map((p) => [p.id, p])) : new Map();
  const out = new Map();
  for (const it of items) out.set(it.index, matchOne(it, { L, bySku, byUuid, byName, explicit }));
  return out;
}
const lc = (s) => String(s || '').trim().toLowerCase();
const inStore = (p, storeId) => !storeId || p.store_id === storeId;
function matchOne(it, { L, bySku, byUuid, byName, explicit }) {
  const slim = (p) => ({ productId: p.id, name: p.product_name, store: p.store_id });
  // 1. explicit mapping (owner-made) — by external id, then sku, then barcode
  for (const [kind, v] of [['ext', it.externalProductId], ['sku', it.sku], ['barcode', it.barcode]]) {
    if (!v) continue;
    const link = L[linkKey(kind, v)];
    if (!link) continue;
    const p = explicit.get(link.productId);
    if (!p) return { status: 'MAPPING_ERROR', via: 'EXPLICIT', reason: 'LINKED_PRODUCT_MISSING', key: linkKey(kind, v) };
    if (it.storeId && p.store_id !== it.storeId) return { status: 'CONFLICT', via: 'EXPLICIT', reason: 'STORE_MISMATCH', candidates: [slim(p)] };
    return { status: 'VERIFIED', via: 'EXPLICIT', productId: p.id, store: p.store_id, product: p };
  }
  const resolve = (pool, via, test) => {
    const hits = pool.filter((p) => test(p) && inStore(p, it.storeId));
    const uniq = [...new Map(hits.map((p) => [p.id, p])).values()];
    if (uniq.length === 1) return { status: 'VERIFIED', via, productId: uniq[0].id, store: uniq[0].store_id, product: uniq[0] };
    if (uniq.length > 1) return { status: 'CONFLICT', via, reason: 'AMBIGUOUS_MATCH', candidates: uniq.map(slim) }; // same identity in several products/stores: never merged, never guessed
    return null;
  };
  // 2. SKU (Product.sku or product_code)
  if (it.sku) { const r = resolve(bySku, 'SKU', (p) => lc(p.sku) === lc(it.sku) || lc(p.product_code) === lc(it.sku)); if (r) return r; }
  // 3. barcode: there is no barcode column on Product — only an explicit link can resolve it (see tier 1)
  // 4. external product id / Easy Orders UUID (store-scoped)
  for (const v of [it.easyOrdersUuid, it.externalProductId]) { if (!v) continue; const r = resolve(byUuid, 'EASY_ORDERS_UUID', (p) => p.easy_orders_uuid === v); if (r) return r; }
  if (it.externalProductId) { const r = resolve(bySku, 'EXTERNAL_ID_AS_SKU', (p) => lc(p.sku) === lc(it.externalProductId) || lc(p.product_code) === lc(it.externalProductId)); if (r) return r; }
  // 5. name: NEVER verified
  if (it.name) {
    const hits = byName.filter((p) => lc(p.product_name) === lc(it.name) && inStore(p, it.storeId));
    if (hits.length === 1) return { status: 'SUGGESTED', via: 'NAME', productId: hits[0].id, store: hits[0].store_id, candidates: [slim(hits[0])] };
    if (hits.length > 1) return { status: 'CONFLICT', via: 'NAME', reason: 'AMBIGUOUS_NAME', candidates: hits.map(slim) };
  }
  return { status: 'UNMAPPED', reason: 'NO_MATCH' };
}

// =====================================================================================================================
// 4. APPLY (I/O) — InventorySnapshot is the store. Idempotent, order-safe, per-warehouse, per-product serialised.
// =====================================================================================================================
const cairoDate = (d) => new Date(d.getTime() + 3 * MS_H).toISOString().slice(0, 10);
const locks = new Map();
async function withLock(key, fn) { const prev = locks.get(key) || Promise.resolve(); let rel; const next = new Promise((r) => { rel = r; }); locks.set(key, prev.then(() => next)); await prev; try { return await fn(); } finally { rel(); if (locks.get(key) === next) locks.delete(key); } }

export async function latestApiSnapshot(productId) {
  const row = await prisma.inventorySnapshot.findFirst({ where: { product_id: Number(productId), source: { startsWith: 'INVENTORY_API' } }, orderBy: [{ date: 'desc' }, { id: 'desc' }] });
  return row ? { row, state: j(row.notes, {}) || {} } : null;
}
/** Pure ordering decision for ONE warehouse entry. Returns {accept, reason}. */
export function decideOrdering({ prev, incoming }) {
  if (!prev) return { accept: true, reason: 'FIRST' };
  if (incoming.eventId && (prev.eventIds || []).includes(incoming.eventId)) return { accept: false, reason: 'DUPLICATE' };
  if (incoming.version != null && prev.version != null) return incoming.version > prev.version ? { accept: true, reason: 'NEWER_VERSION' } : { accept: false, reason: incoming.version === prev.version ? 'DUPLICATE' : 'STALE_EVENT' };
  const t = incoming.sourceAt?.getTime?.(), p = prev.sourceUpdatedAt ? Date.parse(prev.sourceUpdatedAt) : null;
  if (t != null && p != null) {
    if (t > p) return { accept: true, reason: 'NEWER_TIMESTAMP' };
    return { accept: false, reason: t === p && prev.available === incoming.available && prev.current === incoming.current ? 'DUPLICATE' : 'STALE_EVENT' };
  }
  return { accept: true, reason: 'ORDERING_UNVERIFIED' }; // no timestamp/version on either side: the event id still protects against replays
}
export function totalsOf(warehouses) {
  const e = Object.values(warehouses);
  const sum = (k) => e.reduce((a, w) => a + (w[k] ?? 0), 0);
  const anyReserved = e.some((w) => w.reserved != null);
  return { current: sum('current'), reserved: anyReserved ? sum('reserved') : null, available: sum('available') };
}

/**
 * Applies ONE parsed+matched item. Returns {status: APPLIED|DUPLICATE|STALE_EVENT, ...}. dryRun=true computes everything and writes nothing.
 * `source` = SOURCE_WEBHOOK | SOURCE_RECONCILE. `event` = {eventId, occurredAt, version}.
 */
export async function applyItem({ product, item, event, source = SOURCE_WEBHOOK, now = new Date(), dryRun = false }) {
  return withLock(`p${product.id}`, async () => {
    const latest = await latestApiSnapshot(product.id);
    const st = latest?.state || {};
    const wh = { ...(st.warehouses || {}) };
    const key = item.warehouse || '*';
    const incoming = { eventId: event.eventId, version: event.version ?? null, sourceAt: item.updatedAt || event.occurredAt || null, available: item.available, current: item.current };
    const d = decideOrdering({ prev: wh[key], incoming });
    const before = latest ? { available: st.totals?.available ?? null, current: st.totals?.current ?? null, asOf: latest.row.date } : null;
    if (!d.accept) {
      if (!dryRun && d.reason === 'DUPLICATE') await touchSync(product.id, latest, now); // the source confirmed (again) that this state is current
      return { status: d.reason === 'DUPLICATE' ? 'DUPLICATE' : 'STALE_EVENT', reason: d.reason, before };
    }
    wh[key] = { current: item.current, reserved: item.reserved, available: item.available, reservedUnknown: !!item.reservedUnknown, sourceUpdatedAt: incoming.sourceAt ? incoming.sourceAt.toISOString() : null, version: incoming.version, eventIds: [event.eventId, ...((wh[key]?.eventIds) || [])].slice(0, 10), receivedAt: now.toISOString() };
    const totals = totalsOf(wh);
    const notes = { v: 1, lastSyncAt: now.toISOString(), totals, minimumStock: item.minimumStock ?? st.minimumStock ?? null, externalProductId: item.externalProductId || st.externalProductId || null, sku: item.sku || st.sku || null, warehouses: wh, ordering: d.reason };
    const after = { available: totals.available, current: totals.current, reserved: totals.reserved };
    if (dryRun) return { status: 'WOULD_APPLY', reason: d.reason, before, after };
    const date = cairoDate(now);
    const data = { product_name: product.product_name, closing_stock: totals.available, units_out: 0, movement_type: 'API_SYNC', source, notes: JSON.stringify(notes).slice(0, 8000), updated_by: 'inventory-api' };
    await prisma.inventorySnapshot.upsert({ where: { product_id_date: { product_id: product.id, date } }, create: { product_id: product.id, date, ...data }, update: data });
    return { status: 'APPLIED', reason: d.reason, before, after };
  });
}
/** Reconciliation/duplicate heartbeat: the source re-confirmed the stored state — refresh freshness only, never the numbers. */
async function touchSync(productId, latest, now) {
  if (!latest) return;
  const notes = { ...latest.state, lastSyncAt: now.toISOString() };
  await prisma.inventorySnapshot.update({ where: { id: latest.row.id }, data: { notes: JSON.stringify(notes).slice(0, 8000) } });
}
export async function touchVerified(productId, now = new Date()) { return touchSync(productId, await latestApiSnapshot(productId), now); }

// =====================================================================================================================
// 5. STATE / FRESHNESS (pure + batched read)
// =====================================================================================================================
/** VERIFIED (fresh API data) | STALE (older than the threshold — NOT zero) | UNKNOWN (never received). API_ERROR / MAPPING_ERROR are overlays set by callers. */
export function apiStateOf({ snapshot, now = new Date(), staleHours = DEFAULT_STALE_HOURS, lastReconcile = null }) {
  if (!snapshot) return { state: lastReconcile && lastReconcile.ok === false ? 'API_ERROR' : 'UNKNOWN', lastSyncAt: null };
  const last = snapshot.state?.lastSyncAt ? new Date(snapshot.state.lastSyncAt) : new Date(snapshot.row.updated_at);
  const ageHours = (now.getTime() - last.getTime()) / MS_H;
  const fresh = ageHours <= staleHours;
  if (!fresh && lastReconcile && lastReconcile.ok === false && lastReconcile.at > last.getTime()) return { state: 'API_ERROR', lastSyncAt: last.toISOString(), ageHours };
  return { state: fresh ? 'VERIFIED' : 'STALE', lastSyncAt: last.toISOString(), ageHours: Math.round(ageHours * 10) / 10 };
}
export async function getStaleHours() {
  try { const { getAmbSettings } = await import('./settings.js'); const s = await getAmbSettings(); const h = Number(s.ambInventoryApiStaleHours); return Number.isFinite(h) && h > 0 ? h : DEFAULT_STALE_HOURS; } catch { return DEFAULT_STALE_HOURS; }
}
export async function lastReconcileResult() {
  const r = await prisma.aiAuditLog.findFirst({ where: { kind: 'INVENTORY_RECONCILE' }, orderBy: { id: 'desc' }, select: { success: true, created_at: true, error: true } });
  return r ? { ok: !!r.success, at: r.created_at.getTime(), error: r.error || null } : null;
}
export const primaryOf = (config, productId) => ((config?.limits?.productOverrides || {})[String(productId)] || {}).inventory || null;

/** Latest API snapshot per product (one query) -> Map(productId -> {state, available, current, reserved, lastSyncAt, primary}). Used by readiness/grid/completion. */
export async function inventoryStateMap(productIds, { config = null, now = new Date() } = {}) {
  const ids = [...new Set((productIds || []).map(Number).filter(Number.isInteger))];
  const out = new Map(); if (!ids.length) return out;
  const cfg = config || await getOperatorConfig();
  const rows = await prisma.inventorySnapshot.findMany({ where: { product_id: { in: ids }, source: { startsWith: 'INVENTORY_API' } }, orderBy: [{ product_id: 'asc' }, { date: 'desc' }, { id: 'desc' }] });
  const staleHours = await getStaleHours(); const lastRec = await lastReconcileResult();
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.product_id)) continue; seen.add(r.product_id);
    const state = j(r.notes, {}) || {};
    const s = apiStateOf({ snapshot: { row: r, state }, now, staleHours, lastReconcile: lastRec });
    out.set(r.product_id, { state: s.state, available: state.totals?.available ?? r.closing_stock, current: state.totals?.current ?? null, reserved: state.totals?.reserved ?? null, minimumStock: state.minimumStock ?? null, lastSyncAt: s.lastSyncAt, ageHours: s.ageHours ?? null, primary: !!primaryOf(cfg, r.product_id)?.primary });
  }
  for (const id of ids) if (!out.has(id)) out.set(id, { state: lastRec && lastRec.ok === false ? 'API_ERROR' : 'UNKNOWN', available: null, current: null, reserved: null, minimumStock: null, lastSyncAt: null, ageHours: null, primary: !!primaryOf(cfg, id)?.primary });
  return out;
}
/** The stock a readiness/grid row should show for a product: the API figure ONLY when the owner approved it AND it is fresh; stale approved API = unknown (null), never zero. */
export function effectiveStock({ manual, api }) {
  if (api?.primary) return api.state === 'VERIFIED' ? { value: api.available, source: 'INVENTORY_API', state: 'VERIFIED' } : { value: null, source: 'INVENTORY_API', state: api.state };
  return { value: manual ?? null, source: manual != null ? 'MANUAL' : null, state: api?.state && api.state !== 'UNKNOWN' ? `API_PENDING_APPROVAL(${api.state})` : 'MANUAL' };
}

// =====================================================================================================================
// 6. ONE EVENT END-TO-END (shared by the webhook route and the reconciliation job)
// =====================================================================================================================
const UNMAPPED_TTL_MS = 24 * MS_H;
/** Records an unresolved item for owner review (AiAuditLog kind INVENTORY_WEBHOOK_UNMAPPED), once per identity per 24h. Never creates a Product or a mapping. */
async function logUnresolved(it, m, event, source) {
  const key = crypto.createHash('sha1').update(JSON.stringify([it.externalProductId, it.sku, it.barcode, it.easyOrdersUuid, it.name, it.storeId])).digest('hex').slice(0, 16);
  const since = new Date(Date.now() - UNMAPPED_TTL_MS);
  const dup = await prisma.aiAuditLog.findFirst({ where: { kind: 'INVENTORY_WEBHOOK_UNMAPPED', created_at: { gte: since }, input_json: { contains: `"key":"${key}"` } }, select: { id: true } });
  if (dup) return false;
  await prisma.aiAuditLog.create({ data: { actor_id: null, kind: 'INVENTORY_WEBHOOK_UNMAPPED', action: 'REVIEW', success: false, error: m.status, input_json: JSON.stringify({ key, status: m.status, reason: m.reason || null, via: m.via || null, item: { externalProductId: it.externalProductId, sku: it.sku, barcode: it.barcode, easyOrdersUuid: it.easyOrdersUuid, name: it.name, storeId: it.storeId, available: it.available }, candidates: m.candidates || [], eventId: event.eventId, source }).slice(0, 3900) } });
  return true;
}
/**
 * event = parseCanonicalEvent().event. Writes nothing when dryRun. Returns {results:[{index, status, ...}], counts}. Only VERIFIED items are applied;
 * SUGGESTED / UNMAPPED / CONFLICT / MAPPING_ERROR are reported (and logged for review) and change NO stock.
 */
export async function processInventoryEvent({ event, source = SOURCE_WEBHOOK, now = new Date(), dryRun = false, links = null }) {
  const valid = event.items.filter((i) => i.ok).map((i) => ({ ...i.item, index: i.index }));
  const matches = valid.length ? await matchItems(valid, { links }) : new Map();
  const results = []; const touched = new Set();
  for (const raw of event.items) {
    if (!raw.ok) { results.push({ index: raw.index, status: 'INVALID_ITEM', errors: raw.errors }); continue; }
    const it = valid.find((v) => v.index === raw.index); const m = matches.get(raw.index);
    const base = { index: raw.index, sku: it.sku, externalProductId: it.externalProductId, match: m.status, via: m.via || null };
    if (m.status !== 'VERIFIED') {
      if (!dryRun) await logUnresolved(it, m, event, source).catch((e) => logger.warn('[inventoryApi] unresolved log failed', { message: e.message }));
      results.push({ ...base, status: m.status === 'SUGGESTED' ? 'SUGGESTED' : m.status === 'CONFLICT' ? 'CONFLICT' : m.status === 'MAPPING_ERROR' ? 'MAPPING_ERROR' : 'UNMAPPED', reason: m.reason || null, candidates: m.candidates || [] });
      continue;
    }
    const r = await applyItem({ product: m.product, item: it, event, source, now, dryRun });
    results.push({ ...base, productId: m.productId, store: m.store, ...r });
    if (r.status === 'APPLIED') touched.add(m.productId);
  }
  const counts = results.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
  return { results, counts, touched: [...touched] };
}
/** After stock changed: drop every cache that held the old number so Stock Guard / Readiness / Operator / Advisor recompute. Pure invalidation — executes nothing. */
export async function invalidateStockCaches(productIds) {
  try { (await import('./operatorContext.js')).clearOperatorFactsCache(); } catch { /* optional */ }
  try {
    const { invalidatePlanCache } = await import('./advisorTracking.js');
    if (productIds?.length) { const ps = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, store_id: true } }); for (const p of ps) if (p.store_id) invalidatePlanCache(p.id, p.store_id); }
  } catch { /* optional */ }
}

// =====================================================================================================================
// 7. OWNER CONTROLS (explicit links, primary-source approval) — stored beside the other per-product overrides (no table)
// =====================================================================================================================
async function saveLimits(mutate, userId, auditInput) {
  const cfg = await getOperatorConfig();
  const next = mutate(JSON.parse(JSON.stringify(cfg.limits || {})));
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify(next), updated_by_id: userId } });
  await prisma.aiAuditLog.create({ data: { actor_id: userId || null, kind: 'OPERATOR_INVENTORY', action: 'EXECUTE', input_json: JSON.stringify(auditInput).slice(0, 3000), success: true } }).catch(() => {});
  return next;
}
const KINDS = ['ext', 'sku', 'barcode'];
export async function setInventoryLink({ kind, value, productId, userId = null, now = new Date() }) {
  if (!KINDS.includes(kind) || !str(value)) { const e = new Error('kind لازم يكون ext أو sku أو barcode وvalue مطلوب.'); e.status = 400; throw e; }
  const p = await prisma.product.findUnique({ where: { id: Number(productId) }, select: { id: true, store_id: true } });
  if (!p) { const e = new Error('المنتج غير موجود.'); e.status = 404; throw e; }
  const key = linkKey(kind, value);
  await saveLimits((l) => { l.inventoryLinks = { ...(l.inventoryLinks || {}), [key]: { productId: p.id, store: p.store_id, by: userId, at: now.toISOString() } }; return l; }, userId, { link: key, productId: p.id });
  return { key, productId: p.id };
}
export async function removeInventoryLink({ kind, value, userId = null }) {
  const key = linkKey(kind, value);
  await saveLimits((l) => { const m = { ...(l.inventoryLinks || {}) }; delete m[key]; l.inventoryLinks = m; return l; }, userId, { unlink: key });
  return { key };
}
/** Owner approval that THIS product now trusts the API over its manual stock. Refused unless fresh VERIFIED API data exists. */
export async function setInventoryPrimary({ productId, on, userId = null, now = new Date() }) {
  const pid = Number(productId);
  if (on) {
    const m = await inventoryStateMap([pid]); const s = m.get(pid);
    if (!s || s.state !== 'VERIFIED') { const e = new Error(`مفيش بيانات API موثّقة وحديثة للمنتج ده (الحالة: ${s?.state || 'UNKNOWN'}) — مينفعش تعتمد الـAPI كمصدر أساسي.`); e.status = 409; throw e; }
  }
  await saveLimits((l) => { const all = { ...(l.productOverrides || {}) }; const k = String(pid); const cur = { ...(all[k] || {}) }; if (on) cur.inventory = { primary: true, approvedBy: userId, at: now.toISOString() }; else delete cur.inventory; if (Object.keys(cur).length) all[k] = cur; else delete all[k]; l.productOverrides = all; return l; }, userId, { productId: pid, primary: !!on });
  await invalidateStockCaches([pid]);
  return { productId: pid, primary: !!on };
}
/** Manual vs API for one product (what the owner must see before approving). */
export async function compareManualVsApi(productId) {
  const pid = Number(productId);
  const p = await prisma.product.findUnique({ where: { id: pid }, select: { id: true, product_name: true, store_id: true, current_stock: true, minimum_stock: true } });
  if (!p) return null;
  const s = (await inventoryStateMap([pid])).get(pid);
  const api = s?.available ?? null;
  return { productId: pid, name: p.product_name, store: p.store_id, manual: p.current_stock ?? null, manualMinimum: p.minimum_stock ?? null, api: { state: s?.state || 'UNKNOWN', available: api, current: s?.current ?? null, reserved: s?.reserved ?? null, minimum: s?.minimumStock ?? null, lastSyncAt: s?.lastSyncAt ?? null }, difference: api != null && p.current_stock != null ? api - p.current_stock : null, primary: !!s?.primary };
}

// =====================================================================================================================
// 8. OVERVIEW for the owner (status of the feed, products with API data, unresolved items awaiting review)
// =====================================================================================================================
export async function inventoryOverview({ now = new Date() } = {}) {
  const cfg = await getOperatorConfig();
  const snaps = await prisma.inventorySnapshot.findMany({ where: { source: { startsWith: 'INVENTORY_API' } }, distinct: ['product_id'], select: { product_id: true } });
  const primaryIds = Object.entries(cfg.limits?.productOverrides || {}).filter(([, v]) => v?.inventory?.primary).map(([k]) => Number(k));
  const ids = [...new Set([...snaps.map((s) => s.product_id), ...primaryIds])];
  const map = await inventoryStateMap(ids, { config: cfg, now });
  const products = ids.length ? await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, product_name: true, store_id: true, current_stock: true, minimum_stock: true } }) : [];
  const rows = products.map((p) => { const s = map.get(p.id); return { productId: p.id, name: p.product_name, store: p.store_id, state: s.state, primary: s.primary, apiAvailable: s.available, apiCurrent: s.current, reserved: s.reserved, manual: p.current_stock ?? null, minimum: p.minimum_stock ?? s.minimumStock ?? null, lastSyncAt: s.lastSyncAt, ageHours: s.ageHours }; });
  const unresolvedRows = await prisma.aiAuditLog.findMany({ where: { kind: 'INVENTORY_WEBHOOK_UNMAPPED', created_at: { gte: new Date(now.getTime() - 7 * 86_400_000) } }, orderBy: { id: 'desc' }, take: 100, select: { id: true, created_at: true, error: true, input_json: true } });
  const unresolved = unresolvedRows.map((r) => ({ id: r.id, at: r.created_at, status: r.error, ...(j(r.input_json, {}) || {}) }));
  const lastRec = await lastReconcileResult();
  const byState = rows.reduce((a, r) => (a[r.state] = (a[r.state] || 0) + 1, a), {});
  return { configured: { webhookSecret: !!process.env.INVENTORY_WEBHOOK_SECRET, authMode: process.env.INVENTORY_WEBHOOK_AUTH_MODE || 'auto', adapter: process.env.INVENTORY_WEBHOOK_ADAPTER || 'canonical', apiReconcile: false }, staleHours: await getStaleHours(), counts: { productsWithApiData: rows.length, primary: rows.filter((r) => r.primary).length, byState, unresolved: unresolved.length }, products: rows, unresolved, links: Object.entries(cfg.limits?.inventoryLinks || {}).map(([key, v]) => ({ key, ...v })), lastReconcile: lastRec };
}
