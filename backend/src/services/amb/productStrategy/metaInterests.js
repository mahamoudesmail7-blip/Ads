// AI Product Targeting & Creative Strategy — verifying suggested interests against META ITSELF (read-only: Marketing API «targeting search», type=adinterest). Nothing is written to Meta.
// An interest is shown as verified only when Meta returned an exact-name match; everything else stays a suggestion that needs review. When Meta is not connected / the call fails, the status is
// UNAVAILABLE — never «verified». Results are cached for 7 days (the same persistent cache the AI gateway uses) so re-opening a product never re-queries Meta.
import { graphFetch } from '../../metaGraphClient.js';
import { getDecryptedToken } from '../../metaAuth.js';
import { requestHash, cacheGet, cacheSet } from '../../aiGateway/cache.js';
import { matchInterest } from './schema.js';

const TTL_MS = 7 * 24 * 3_600_000;
const MAX_TERMS = 30;

export async function searchAdInterest(token, q) {
  const data = await graphFetch('/search', { type: 'adinterest', q, limit: 10, locale: 'en_US' }, token);
  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * @param {string[]} names   interest names exactly as suggested
 * @param {{ getToken?:()=>Promise<string>, search?:Function, cache?:{get:Function,set:Function}, now?:()=>Date }} deps  injectable for tests
 * @returns {Promise<{ results: Map<string, object>, available: boolean, reason: string|null }>}
 */
export async function verifyInterests(names, deps = {}) {
  const getToken = deps.getToken || getDecryptedToken; const search = deps.search || searchAdInterest;
  const cache = deps.cache || { get: (k) => cacheGet(k), set: (k, v) => cacheSet({ cacheKey: k, feature: 'meta.adinterest', promptVersion: 'v1', data: v, ttlMs: TTL_MS }) };
  const terms = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))].slice(0, MAX_TERMS);
  const results = new Map(); const checkedAt = (deps.now || (() => new Date()))().toISOString();
  if (!terms.length) return { results, available: true, reason: null };
  let token = null;
  try { token = await getToken(); } catch (e) { for (const t of terms) results.set(t, { status: 'UNAVAILABLE', match: null, alternatives: [], checkedAt, reason: 'Meta مش متصل' }); return { results, available: false, reason: e.message || 'Meta مش متصل' }; }
  let failed = 0; let reason = null; let i = 0;
  const worker = async () => {
    while (i < terms.length) {
      const t = terms[i++]; const key = requestHash({ feature: 'meta.adinterest', promptVersion: 'v1', parts: { q: t.toLowerCase() } });
      try {
        let list = await cache.get(key);
        if (!Array.isArray(list)) { list = await search(token, t); await cache.set(key, list); }
        results.set(t, { ...matchInterest(t, list), checkedAt });
      } catch (e) { failed++; reason = e.message || 'تعذّر البحث في Meta'; results.set(t, { status: 'UNAVAILABLE', match: null, alternatives: [], checkedAt, reason }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, terms.length) }, worker));
  return { results, available: failed < terms.length, reason };
}
