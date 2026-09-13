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
//       {"id":"trendy","name":"Trendy Store","apiKeyEnv":"EASYORDERS_API_KEY_TRENDY","domain":"trendy.example.com"},
//       {"id":"smart","name":"Smart Store","apiKeyEnv":"EASYORDERS_API_KEY_SMART"}
//     ]
//   Each store's REAL API key lives in its OWN separate env var (named by
//   apiKeyEnv) — EASYORDERS_STORES_JSON itself never holds a key value, so
//   even if that one JSON blob were ever logged/echoed by mistake it still
//   exposes no secret, only structure.
//
// Backward compatibility: if EASYORDERS_STORES_JSON is unset (or invalid),
// and EASYORDERS_API_KEY is set, exactly one default store is synthesized
// pointing at EASYORDERS_API_KEY — every existing single-store deployment
// (today's production included) keeps working with ZERO config changes.
import { logger } from '../logger.js';

const DEFAULT_STORE_ID = 'default';

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
      stores.push({ id: String(s.id), name: String(s.name), apiKeyEnv: String(s.apiKeyEnv), domain: s.domain ? String(s.domain) : null, enabled: s.enabled !== false });
    }
    return stores;
  } catch (err) {
    logger.error('[easyOrdersStores] EASYORDERS_STORES_JSON is set but invalid — falling back to single-store mode', { message: err.message });
    return null;
  }
}

/** Every configured store, safe metadata only (id/name/domain/enabled — NEVER a key value or env var name, which would leak which env var to target). */
export function listStores() {
  const configured = parseConfiguredStores();
  if (configured && configured.length) return configured.map(({ id, name, domain, enabled }) => ({ id, name, domain, enabled }));
  if (process.env.EASYORDERS_API_KEY) return [{ id: DEFAULT_STORE_ID, name: 'المتجر الرئيسي', domain: null, enabled: true }];
  return [];
}

/** Full internal record for one store (still no key VALUE — apiKeyEnv is just the env var NAME to look up), or null if unknown. */
function findStoreRecord(storeId) {
  const configured = parseConfiguredStores();
  if (configured && configured.length) return configured.find((s) => s.id === storeId) || null;
  if ((!storeId || storeId === DEFAULT_STORE_ID) && process.env.EASYORDERS_API_KEY) {
    return { id: DEFAULT_STORE_ID, name: 'المتجر الرئيسي', apiKeyEnv: 'EASYORDERS_API_KEY', domain: null, enabled: true };
  }
  return null;
}

/** Safe metadata for one store (id/name/domain/enabled), or null if unknown/misconfigured. */
export function getStore(storeId) {
  const rec = findStoreRecord(storeId);
  if (!rec) return null;
  return { id: rec.id, name: rec.name, domain: rec.domain, enabled: rec.enabled };
}

/** The store's real API key, resolved server-side from its own env var. NEVER return this to a route response — callers use it only to call the Easy Orders API directly. Returns null if the store or its key is missing/misconfigured. */
export function getStoreApiKey(storeId) {
  const rec = findStoreRecord(storeId);
  if (!rec || !rec.enabled) return null;
  const key = process.env[rec.apiKeyEnv];
  return key && key.trim() ? key : null;
}

/** The store to assume when the caller/frontend doesn't specify one yet (keeps every pre-multi-store call site working unchanged). */
export function defaultStoreId() {
  const list = listStores();
  return list[0]?.id || DEFAULT_STORE_ID;
}

export { DEFAULT_STORE_ID };
