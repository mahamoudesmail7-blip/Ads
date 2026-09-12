// AI Gateway — request-hash cache (§32/§33/§34). Keyed on exactly the
// inputs that should invalidate a cached result: feature + model + prompt
// version + whatever the caller says actually determines the answer
// (product id, image hash, date range, metric version...). No AI call runs
// on a plain page load if a live, non-expired cache row already answers it.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';

/** Deterministic cache key — order-independent (keys are sorted before hashing) so callers never have to worry about field order. */
export function requestHash({ feature, model, promptVersion, parts }) {
  const payload = JSON.stringify({ feature, model, promptVersion: promptVersion || null, parts: sortDeep(parts || {}) });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}

export async function cacheGet(cacheKey) {
  try {
    const row = await prisma.aiCacheEntry.findUnique({ where: { cache_key: cacheKey } });
    if (!row) return null;
    if (row.expires_at && row.expires_at.getTime() < Date.now()) return null; // expired — treated as a miss, not deleted here (a background sweep is optional, never required for correctness)
    return JSON.parse(row.data_json);
  } catch (err) {
    logger.warn('AI_CACHE_READ_FAILED', { message: err.message });
    return null; // a cache failure must never block a real AI call
  }
}

export async function cacheSet({ cacheKey, feature, promptVersion, data, ttlMs }) {
  try {
    await prisma.aiCacheEntry.upsert({
      where: { cache_key: cacheKey },
      create: { cache_key: cacheKey, feature, prompt_version: promptVersion || null, data_json: JSON.stringify(data), expires_at: ttlMs ? new Date(Date.now() + ttlMs) : null },
      update: { data_json: JSON.stringify(data), prompt_version: promptVersion || null, expires_at: ttlMs ? new Date(Date.now() + ttlMs) : null, created_at: new Date() },
    });
  } catch (err) {
    logger.warn('AI_CACHE_WRITE_FAILED', { message: err.message }); // never blocks the caller — the fresh result is still returned even if caching it failed
  }
}

/** Explicit invalidation — used by "إعادة التحليل" / "إنشاء أفكار جديدة" (§77) so a user-triggered regenerate always bypasses a stale cache row. */
export async function cacheInvalidate(cacheKey) {
  try { await prisma.aiCacheEntry.delete({ where: { cache_key: cacheKey } }); } catch { /* already gone — fine */ }
}

// Common TTLs (§32), named so a call site reads as intent, not a magic number.
export const TTL = {
  PRODUCT_UNDERSTANDING: 7 * 24 * 3600 * 1000, // days, until the product image changes (new hash = new key anyway)
  PERFORMANCE_EXPLANATION: 30 * 60 * 1000,
  AUDIENCE_ANALYSIS: 24 * 3600 * 1000,
  MARKETING_ANGLES: 24 * 3600 * 1000,
  COMPETITOR_ANALYSIS: 24 * 3600 * 1000,
  PERSISTENT: null, // hooks/posts/image-understanding — until the user explicitly regenerates
};
