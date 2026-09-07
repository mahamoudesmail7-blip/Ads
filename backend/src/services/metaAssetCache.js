// metaAssetCache.js — a small in-process cache + request de-duplicator for the
// SLOW Meta "asset discovery" reads (Businesses, ad accounts, Pages, Instagram
// identities, Pixels). These lists change rarely but were being re-fetched
// from the Graph API on every UI render across AI Intelligence, AI Media Buyer
// and Campaign Clone — each call fanning out to dozens of sub-requests — which
// tripped Meta error #4 "Application request limit reached".
//
// Behaviour:
//   • TTL cache (default 5 min) keyed by a stable token fingerprint + a
//     logical key. A fresh entry is served without touching Meta.
//   • In-flight de-duplication: concurrent callers for the same key share ONE
//     promise (and therefore one Graph API fan-out).
//   • force:true bypasses the cache and refreshes it — wired to the "تحديث"
//     buttons.
//   • Rate-limit resilience: if the loader throws a Meta rate-limit error
//     (#4 / #17 / #32 / #613 / #80004) and we still hold ANY previous value
//     (even expired), that stale value is returned with `__stale:true`, and a
//     short cooldown is recorded so callers stop hammering. Only when there is
//     nothing cached at all does the error propagate.
//
// In-memory only: one Railway instance, and the lists re-warm in one call
// after a restart. No secrets are stored (the value is asset metadata; the
// key uses a SHA-256 prefix of the token, never the token itself).
import crypto from 'node:crypto';
import { logger } from '../logger.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 2 * 60 * 1000;

const store = new Map();     // key -> { value, expiresAt, at }
const inFlight = new Map();  // key -> Promise
let rateLimitedUntil = 0;    // epoch ms; while in the future, prefer cache

/** Meta rate-limit / throttle error codes. graphFetch tags err.isMetaRateLimit; this also sniffs a raw message. */
export function isMetaRateLimitError(err) {
  if (!err) return false;
  if (err.isMetaRateLimit) return true;
  const code = Number(err.graphCode ?? err.code);
  if ([4, 17, 32, 613, 80004].includes(code)) return true;
  return /request limit reached|rate limit|too many calls|reduce the amount of data/i.test(err.message || '');
}

export function fingerprintToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
}

export function isRateLimitedNow() {
  return Date.now() < rateLimitedUntil;
}
export function noteRateLimit() {
  rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
}

/**
 * @param key        logical cache key, e.g. `businesses:<fp>` / `identities:<fp>:<act_id>`
 * @param loader     async () => value  (the real Meta fan-out)
 * @param opts.ttlMs override TTL
 * @param opts.force bypass a fresh entry and refresh
 * Returns the value. On a rate-limit with any prior value, returns that value
 * with a non-enumerable `__stale` marker.
 */
export async function cachedMetaFetch(key, loader, { ttlMs = DEFAULT_TTL_MS, force = false } = {}) {
  const now = Date.now();
  const hit = store.get(key);

  if (!force && hit && hit.expiresAt > now) return hit.value;

  // During a rate-limit cooldown, serve whatever we have rather than pile on.
  if (!force && isRateLimitedNow() && hit) {
    return markStale(hit.value);
  }

  if (inFlight.has(key)) return inFlight.get(key);

  const p = (async () => {
    try {
      const value = await loader();
      store.set(key, { value, expiresAt: Date.now() + ttlMs, at: Date.now() });
      return value;
    } catch (err) {
      if (isMetaRateLimitError(err)) {
        noteRateLimit();
        if (hit) {
          logger.warn('Meta rate-limited — serving stale asset cache', { key, ageSec: Math.round((Date.now() - hit.at) / 1000) });
          return markStale(hit.value);
        }
      }
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, p);
  return p;
}

function markStale(value) {
  if (value && typeof value === 'object') {
    try { Object.defineProperty(value, '__stale', { value: true, enumerable: true, configurable: true }); } catch { /* frozen */ }
  }
  return value;
}

/** Drop cached entries for one token (all keys carry its fingerprint). Used by the "force refresh" path and on disconnect. */
export function invalidateForToken(token) {
  const fp = fingerprintToken(token);
  for (const k of [...store.keys()]) if (k.includes(fp)) store.delete(k);
}

export function cacheStats() {
  return { entries: store.size, inFlight: inFlight.size, rateLimitedUntil, rateLimitedNow: isRateLimitedNow() };
}
