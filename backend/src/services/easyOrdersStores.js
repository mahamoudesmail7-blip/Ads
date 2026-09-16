// Multi-store / multi-website Easy Orders configuration — server-side ONLY.
// Product Marketing Center needs to pick which real Easy Orders
// store/website to browse/lock a product from before Meta/COD data can be
// safely attributed. This is purely additive: it extends the existing
// single-key integration (EASYORDERS_API_KEY, services/easyOrders.js /
// services/amb/easyOrdersProducts.js) rather than replacing it, and every
// existing single-store call site keeps working unchanged.
//
// Configuration (env-only, never hardcoded, never committed):
//   EASYORDERS_STORES_JSON — a JSON array of real stores, e.g.:
//     [
//       {"id":"trendy","name":"Trendy Store","apiKeyEnv":"EASYORDERS_API_KEY_TRENDY","webhookSecretEnv":"EASYORDERS_WEBHOOK_SECRET_TRENDY","domain":"trendy.example.com"},
//       {"id":"smart","name":"Smart Store","apiKeyEnv":"EASYORDERS_API_KEY_SMART","webhookSecretEnv":"EASYORDERS_WEBHOOK_SECRET_SMART"}
//     ]
//   Each store's REAL API key AND webhook secret live in their OWN separate
//   env vars (named by apiKeyEnv/webhookSecretEnv) — EASYORDERS_STORES_JSON
//   itself never holds a credential value, so even if that one JSON blob
//   were ever logged/echoed by mistake it still exposes no secret, only
//   structure. webhookSecretEnv is OPTIONAL on a store entry (a store can
//   exist for catalog/product browsing before its webhook is wired up) —
//   backend/src/routes/webhooks.js refuses (not this module) to accept a
//   webhook for a store that doesn't have one configured.
//
// Backward compatibility: if EASYORDERS_STORES_JSON is unset (or invalid),
// and EASYORDERS_API_KEY is set, exactly one default store is synthesized
// pointing at EASYORDERS_API_KEY (+ EASYORDERS_WEBHOOK_SECRET for its
// webhook) — every existing single-store deployment (today's production
// included) keeps working with ZERO config changes.
import { logger } from '../logger.js';
import crypto from 'node:crypto';

const DEFAULT_STORE_ID = 'default';

// Display-name correction, DISPLAY ONLY — never touches store id, apiKeyEnv,
// webhookSecretEnv, domain, or routing. The user manually verified (real
// login to each Easy Orders storefront) that EASYORDERS_STORES_JSON's own
// `name` fields for these two ids were swapped/misleading: the "default"
// id's real-world storefront is their "Trendy Storeee" (confirmed here by
// its 75-product catalog), and the "trendy-storeee" id's real-world
// storefront is actually their main "Trendy Store" (confirmed here by its
// 328-product catalog) — the id "trendy-storeee" is just its internal key,
// unrelated to which real brand it turned out to be. Fixing this properly
// means editing EASYORDERS_STORES_JSON on Railway (out of reach here); this
// override corrects only what every caller in this app actually shows a
// human, with zero effect on which API key/webhook/catalog either id reads
// from. Remove this once EASYORDERS_STORES_JSON itself is corrected.
const STORE_NAME_DISPLAY_OVERRIDE = {
  default: 'Trendy Storeee',
  'trendy-storeee': 'Trendy Store',
};
function displayName(id, configuredName) {
  return STORE_NAME_DISPLAY_OVERRIDE[id] ?? configuredName;
}

function parseConfiguredStores() {
  const raw = process.env.EASYORDERS_STORES_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('EASYORDERS_STORES_JSON must be a JSON array');
    const stores = [];
    for (const s of parsed) {
      if (!s || typeof s !== 'object' || !s.id || !s.name || !s.apiKeyEnv) {
        logger.warn('[easyOrdersStores] skipped one malformed entry in EASYORDERS_STORES_JSON (needs id, name, apiKeyEnv)', { entry: JSON.stringify(s).slice(0, 100) });
        continue;
      }
      stores.push({
        id: String(s.id), name: String(s.name), apiKeyEnv: String(s.apiKeyEnv),
        webhookSecretEnv: s.webhookSecretEnv ? String(s.webhookSecretEnv) : null,
        domain: s.domain ? String(s.domain) : null, enabled: s.enabled !== false,
      });
    }
    return stores;
  } catch (err) {
    logger.error('[easyOrdersStores] EASYORDERS_STORES_JSON is set but invalid — falling back to single-store mode', { message: err.message });
    return null;
  }
}

/** Every configured store, safe metadata only (id/name/domain/enabled — NEVER a key/secret value or env var name, which would leak which env var to target). */
export function listStores() {
  const configured = parseConfiguredStores();
  if (configured && configured.length) return configured.map(({ id, name, domain, enabled }) => ({ id, name: displayName(id, name), domain, enabled }));
  if (process.env.EASYORDERS_API_KEY) return [{ id: DEFAULT_STORE_ID, name: displayName(DEFAULT_STORE_ID, 'المتجر الرئيسي'), domain: null, enabled: true }];
  return [];
}

/** Full internal record for one store (still no credential VALUE — apiKeyEnv/webhookSecretEnv are just env var NAMES to look up), or null if unknown. */
function findStoreRecord(storeId) {
  const configured = parseConfiguredStores();
  if (configured && configured.length) return configured.find((s) => s.id === storeId) || null;
  if ((!storeId || storeId === DEFAULT_STORE_ID) && process.env.EASYORDERS_API_KEY) {
    return { id: DEFAULT_STORE_ID, name: 'المتجر الرئيسي', apiKeyEnv: 'EASYORDERS_API_KEY', webhookSecretEnv: 'EASYORDERS_WEBHOOK_SECRET', domain: null, enabled: true };
  }
  return null;
}

/** Safe metadata for one store (id/name/domain/enabled), or null if unknown/misconfigured. */
export function getStore(storeId) {
  const rec = findStoreRecord(storeId);
  if (!rec) return null;
  return { id: rec.id, name: displayName(rec.id, rec.name), domain: rec.domain, enabled: rec.enabled };
}

/** The store's real API key, resolved server-side from its own env var. NEVER return this to a route response — callers use it only to call the Easy Orders API directly. Returns null if the store or its key is missing/misconfigured. */
export function getStoreApiKey(storeId) {
  const rec = findStoreRecord(storeId);
  if (!rec || !rec.enabled) return null;
  const key = process.env[rec.apiKeyEnv];
  return key && key.trim() ? key : null;
}

/** The store's real webhook secret, resolved server-side from its own env var. NEVER return this to a route response — used only to compare against an incoming webhook's `secret` header. Returns null if the store, its webhookSecretEnv, or the underlying env var is missing/misconfigured (the caller must treat that as "this store's webhook isn't set up", never as an open pass). */
export function getStoreWebhookSecret(storeId) {
  const rec = findStoreRecord(storeId);
  if (!rec || !rec.enabled || !rec.webhookSecretEnv) return null;
  const secret = process.env[rec.webhookSecretEnv];
  return secret && secret.trim() ? secret : null;
}

/** The store to assume when the caller/frontend doesn't specify one yet (keeps every pre-multi-store call site working unchanged). */
export function defaultStoreId() {
  const list = listStores();
  return list[0]?.id || DEFAULT_STORE_ID;
}

/** One-way, non-reversible fingerprint of a credential value — proves two values are equal or different WITHOUT exposing or being able to reconstruct either one. Truncated to 12 hex chars: enough to distinguish real keys (astronomically unlikely to collide), nowhere near enough to brute-force back to the original. */
function fingerprint(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * ADMIN-only diagnostic — reports which Railway ENV VAR NAME each store's
 * key/secret is configured to read from, whether that variable currently
 * holds a non-empty value, and a one-way fingerprint of that value (see
 * fingerprint() above) — enough to PROVE from outside whether two stores'
 * env vars actually resolve to the same or different real credential in
 * THIS running process, without ever exposing or being able to reconstruct
 * the value itself. Resolves through the exact same getStoreApiKey() /
 * getStoreWebhookSecret() path real requests use (not a raw process.env
 * read), so this also catches a resolution bug, not just a Railway
 * misconfiguration. An admin can be told EXACTLY which Railway variable to
 * check/fix without Claude (or anyone else) ever needing to see the actual
 * key/secret value.
 */
export function storeConfigDiagnostics() {
  const configured = parseConfiguredStores();
  const records = configured && configured.length
    ? configured
    : (process.env.EASYORDERS_API_KEY ? [{ id: DEFAULT_STORE_ID, name: 'المتجر الرئيسي', apiKeyEnv: 'EASYORDERS_API_KEY', webhookSecretEnv: 'EASYORDERS_WEBHOOK_SECRET', enabled: true }] : []);
  return records.map((r) => ({
    id: r.id,
    name: displayName(r.id, r.name),
    enabled: r.enabled,
    apiKeyEnv: r.apiKeyEnv,
    apiKeyConfigured: !!(process.env[r.apiKeyEnv] && process.env[r.apiKeyEnv].trim()),
    apiKeyFingerprint: fingerprint(getStoreApiKey(r.id)),
    webhookSecretEnv: r.webhookSecretEnv || null,
    webhookSecretConfigured: !!(r.webhookSecretEnv && process.env[r.webhookSecretEnv] && process.env[r.webhookSecretEnv].trim()),
  }));
}

export { DEFAULT_STORE_ID };
