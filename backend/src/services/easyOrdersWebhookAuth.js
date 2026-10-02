// Easy Orders WEBHOOK AUTH + STORE ATTRIBUTION (2026-10-02 audit).
//
// What the audit proved (production logs + live API ownership checks):
//  * Production answered 401 INVALID_SECRET to 106/106 Easy Orders deliveries on the bare `/easyorders` URL (no ingest at all).
//  * 1,126/1,126 audited orders tagged `default` are owned by the OTHER Easy Orders account (the one whose key is
//    EASYORDERS_STORE_2_API_KEY): that account's webhook points at the bare default URL, and the old route trusted the URL
//    alone to decide the store, so every one of those orders was filed under the wrong store.
//
// This module makes the receiver independent of which URL Easy Orders was configured with:
//  1. IDENTITY BY SECRET — every configured webhook secret belongs to exactly one store (and one event type for the default
//     store, which has a dedicated order-created secret and a dedicated status secret). A request is authenticated against ALL
//     of them (timing-safe) and the matching secret — never the URL, never a body field — decides the store.
//  2. OWNER VERIFICATION — for a newly created order the owning Easy Orders ACCOUNT is confirmed by asking Easy Orders (only the
//     owning account's key can retrieve the order). If that disagrees with the secret/route, the verified owner wins and the
//     correction is logged. If verification is impossible (429/timeout/error) the order is still ingested with the secret's
//     store and flagged unverified — an unverifiable order is never dropped.
//  3. DIAGNOSTICS WITHOUT SECRETS — a rejection reports env var NAMES, lengths and whether the header equals ANY known secret
//     (and which one), so a misconfiguration is identifiable from the logs without ever printing a value.
import crypto from 'node:crypto';
import { listStores, getStoreWebhookSecret, getStoreApiKey } from './easyOrdersStores.js';
import { resolveOrderAcrossStores } from './easyOrdersStatus.js';

const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
export const secretLength = (v) => (v == null ? 0 : String(v).length);

/** Constant-time equality over fixed-length digests (also hides the secret's length from timing). */
export function safeEqual(a, b) {
  if (a == null || b == null || a === '' || b === '') return false;
  return crypto.timingSafeEqual(digest(a), digest(b));
}

/**
 * Registry of every webhook secret the server knows. Entries carry env var NAMES only for diagnostics.
 *  events: 'ORDER_CREATED' | 'STATUS_UPDATE' | 'ANY'
 */
export function buildSecretRegistry({ env = process.env, stores = listStores(), storeSecret = getStoreWebhookSecret, defaultStoreId = 'default' } = {}) {
  const reg = [];
  const add = (secret, storeId, events, name) => { if (secret && String(secret).trim()) reg.push({ secret: String(secret), storeId, events, name }); };
  add(env.EASYORDERS_WEBHOOK_SECRET, defaultStoreId, 'ORDER_CREATED', 'EASYORDERS_WEBHOOK_SECRET');
  add(env.EASYORDERS_STATUS_WEBHOOK_SECRET, defaultStoreId, 'STATUS_UPDATE', 'EASYORDERS_STATUS_WEBHOOK_SECRET');
  for (const s of stores) {
    const sec = storeSecret(s.id);
    // a store whose single secret is the same variable the default store already registered is not added twice
    if (sec && !reg.some((r) => r.secret === sec && r.storeId === s.id)) add(sec, s.id, 'ANY', `store:${s.id}:webhookSecretEnv`);
  }
  return reg;
}

/**
 * Authenticates a header value for an event type. Returns {ok, storeId, source, ambiguous?} or {ok:false, diagnosis}.
 * `diagnosis` never contains a secret value: header presence/length, and which KNOWN secret (by name) the header equals, if any.
 */
export function matchWebhookSecret(headerValue, eventType, registry) {
  const present = headerValue != null && String(headerValue).length > 0;
  const equalsKnown = registry.filter((r) => present && safeEqual(headerValue, r.secret));
  const usable = equalsKnown.filter((r) => r.events === 'ANY' || r.events === eventType);
  if (usable.length) {
    const stores = [...new Set(usable.map((u) => u.storeId))];
    return { ok: true, storeId: usable[0].storeId, source: usable[0].name, ambiguous: stores.length > 1 ? stores : null };
  }
  return {
    ok: false,
    diagnosis: {
      headerPresent: present,
      headerLength: present ? String(headerValue).length : 0,
      eventType,
      knownSecrets: registry.map((r) => ({ name: r.name, store: r.storeId, events: r.events, length: r.secret.length, lengthMatches: present && String(headerValue).length === r.secret.length })),
      headerEqualsKnownSecret: equalsKnown.map((r) => ({ name: r.name, store: r.storeId, events: r.events })), // non-empty here means: right secret, wrong EVENT TYPE
    },
  };
}

/**
 * Confirms which of OUR stores owns an order by asking Easy Orders (deterministic: only the owning account's key can read it).
 * Never throws and never blocks a webhook for long: `timeoutMs` caps the wait; any failure => {verified:false}.
 */
export async function verifyOrderOwner(orderId, hintStoreId, { resolve = resolveOrderAcrossStores, timeoutMs = 4000, deps = {} } = {}) {
  const attempt = resolve(orderId, hintStoreId, { maxRetries: 0, ...deps }).then((r) => (r.kind === 'OK' ? { verified: true, storeId: r.foundWithStoreId, eoStoreId: r.order?.store_id || null } : { verified: false, reason: r.kind }));
  const timeout = new Promise((res) => setTimeout(() => res({ verified: false, reason: 'TIMEOUT' }), timeoutMs));
  try { return await Promise.race([attempt, timeout]); } catch (err) { return { verified: false, reason: 'ERROR', error: err.message }; }
}

export { getStoreApiKey };
