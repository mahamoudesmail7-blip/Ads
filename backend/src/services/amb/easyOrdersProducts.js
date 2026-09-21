// AI Media Buyer — pulls the store's product catalogue (with real image
// URLs) from the EXISTING EasyOrders integration so a recommendation card
// can show the actual product photo. Read-only, same Api-Key + base URL the
// order-sync path already uses (services/easyOrders.js). Cached in-memory
// for an hour — never fetched per dashboard render.
//
// EasyOrders' /products list returns { id, name, slug, thumb, ... } where
// `thumb` is a stable CDN URL (e.g.
// https://easyorders.fra1.digitaloceanspaces.com/<n>.png). We match an
// AmbProduct to one of those and hand back the thumb; the caller caches the
// resolved URL onto AmbProduct.image_url so it survives an EasyOrders
// outage and needs no further lookups.
import { logger } from '../../logger.js';
import { EASYORDERS_API_BASE } from '../easyOrders.js';
import { getStoreApiKey, defaultStoreId } from '../easyOrdersStores.js';

// Multi-store (Product Marketing Center): both caches are now keyed by
// store_id so two different stores' catalogues can never collide or
// overwrite each other. Every existing call site that doesn't pass a
// storeId keeps working exactly as before — it implicitly resolves to
// defaultStoreId() (today: the one store backed by EASYORDERS_API_KEY),
// which is the SAME single-store behavior this always had.
let cache = new Map(); // storeId -> { at, list } — thumb-only (existing consumers: easyOrdersImageFor)
let fullCache = new Map(); // storeId -> { at, list } — UN-filtered full catalogue (getAllEasyOrdersProductsStatus), kept apart from `cache` so neither invalidates the other
const TTL_MS = 60 * 60 * 1000;

// Real production incident fix: a page of N product cards each independently
// resolves its own image via GET /products/:id/image -> getEasyOrdersProducts()
// -> a cold 1h-TTL cache miss. Before this fix, EVERY one of those N
// concurrent requests independently started its OWN full paginated crawl of
// EasyOrders' real /products endpoint the instant the cache went cold —
// instantly blowing past EasyOrders' ~40 req/min cap and producing
// "EasyOrders /products 429 (page 1, after 3 attempts)" for most of them.
// Single-flight: while a real crawl for a given storeId is already running,
// every other concurrent caller AWAITS THAT SAME PROMISE instead of starting
// a second one — N concurrent callers on a cold cache now produce exactly
// ONE real HTTP crawl, not N.
const inFlight = new Map(); // storeId -> Promise<thumb-only list>
const fullInFlight = new Map(); // storeId -> Promise<{ok,products,source,error}>

// Lightweight internal diagnostics (Phase 22 — never a customer-facing
// dashboard, just enough to diagnose a future incident like this one
// quickly): requests/min, cache hit/miss, 429 count, retry count, last
// successful fetch per store, and current cache age per store.
const diagStats = { requestTimestamps: [], cacheHits: 0, cacheMisses: 0, status429Count: 0, retryCount: 0, lastSuccessAt: {} };
function pruneOldRequestTimestamps() {
  const cutoff = Date.now() - 60_000;
  diagStats.requestTimestamps = diagStats.requestTimestamps.filter((t) => t >= cutoff);
}

function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

// Pagination — EasyOrders' public docs for this endpoint (confirmed live,
// 2026-09-15) document NO page/limit parameters and show a plain-array
// response, but the endpoint's OWN filter syntax (`field||operator||value`)
// is the exact signature of the @nestjsx/crud library, whose standard
// convention is `page`/`limit` query params and an optional
// `{data,count,total,page,pageCount}` envelope. We must not assume either
// way — see fetchEasyOrdersProductsRaw below, which handles BOTH
// possibilities correctly without knowing in advance which is true:
//   - if the API ignores page/limit and always returns the whole catalogue,
//     page 1 already contains everything and the loop stops immediately
//     (a response shorter than PAGE_LIMIT is always treated as the last
//     page, regardless of how many total items that turns out to be).
//   - if the API genuinely paginates, this walks every page until a short
//     page signals the end.
const EASYORDERS_PAGE_LIMIT = 100;
const EASYORDERS_MAX_PAGES = 50; // hard safety bound (5,000 products ceiling) — never an unbounded loop even if the API misbehaves
// Paces sequential page requests safely under EasyOrders' documented 40
// req/min cap (~37/min at 1600ms). Overridable ONLY for tests, which mock
// fetch entirely and would otherwise spend real wall-clock time on a delay
// that's pointless against a mock — production never sets this env var.
const EASYORDERS_PAGE_DELAY_MS = Number(process.env.EASYORDERS_PAGE_DELAY_MS_TEST_OVERRIDE) || 1600;

async function fetchOnePageWithRetry(key, page, attempt = 1) {
  const url = `${EASYORDERS_API_BASE}/products?page=${page}&limit=${EASYORDERS_PAGE_LIMIT}`;
  diagStats.requestTimestamps.push(Date.now());
  const res = await fetch(url, { headers: { 'Api-Key': key } });
  if (res.status === 429 || res.status >= 500) {
    if (res.status === 429) diagStats.status429Count++;
    if (attempt >= 3) {
      const err = new Error(`EasyOrders /products ${res.status} (page ${page}, after ${attempt} attempts)`);
      err.httpStatus = res.status;
      throw err;
    }
    diagStats.retryCount++;
    // Honor a real Retry-After header when EasyOrders sends one (seconds,
    // per HTTP spec) instead of always guessing our own fixed delay; add a
    // small random jitter either way so several already-collided retries
    // don't re-collide again in lockstep.
    const retryAfterHeader = res.headers?.get?.('retry-after');
    const retryAfterMs = retryAfterHeader && Number.isFinite(Number(retryAfterHeader)) ? Math.min(30_000, Number(retryAfterHeader) * 1000) : null;
    const baseDelayMs = retryAfterMs ?? (1000 * attempt); // unchanged 1s/2s fallback when EasyOrders gives no guidance
    const jitterMs = Math.round(Math.random() * 300);
    await new Promise((r) => setTimeout(r, baseDelayMs + jitterMs));
    return fetchOnePageWithRetry(key, page, attempt + 1);
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const err = new Error(`EasyOrders /products ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ''}`);
    err.httpStatus = res.status;
    throw err;
  }
  return res.json();
}

/** The ONE real fetch — no Api-Key handling beyond the header, no caching, just the live HTTP call(s) + shape mapping. Both getEasyOrdersProducts() (below, thumb-only, for image matching) and getAllEasyOrdersProductsStatus() (full catalogue, for the Product Marketing Center picker) build on this — one real integration, two views over it. Walks every page (see pagination note above), bounded, rate-limited, retried, and deduplicated by EasyOrders' own stable product id — a page overlap or retry must never double-count a product. */
async function fetchEasyOrdersProductsRaw(key) {
  let allRows = [];
  let page = 1;
  let pagesFetched = 0;
  let sawPaginationEnvelope = false;

  while (page <= EASYORDERS_MAX_PAGES) {
    let raw;
    try {
      raw = await fetchOnePageWithRetry(key, page);
    } catch (err) {
      if (page === 1) throw err; // first page failing is a real, surfaced error — unchanged from before
      logger.warn('EasyOrders products: a later page failed after retries — stopping with what was already fetched, not discarding it', { page, message: err.message });
      break;
    }
    pagesFetched++;
    const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : null);
    if (!rows) {
      logger.warn('AMB EasyOrders products: unexpected response shape (not an array)', { sample: JSON.stringify(raw).slice(0, 300) });
      break;
    }
    if (!Array.isArray(raw)) sawPaginationEnvelope = true;
    allRows = allRows.concat(rows);
    const gotFullPage = rows.length === EASYORDERS_PAGE_LIMIT;
    if (!gotFullPage) break; // a short (including empty) page always means this was the last one, whatever the total turns out to be
    page++;
    if (page <= EASYORDERS_MAX_PAGES) await new Promise((r) => setTimeout(r, EASYORDERS_PAGE_DELAY_MS));
  }
  logger.info('EasyOrders products: catalogue fetch complete', { pagesFetched, totalRawRows: allRows.length, sawPaginationEnvelope, hitMaxPages: page > EASYORDERS_MAX_PAGES });

  const seenIds = new Set();
  const deduped = [];
  for (const p of allRows) {
    if (p?.id && seenIds.has(p.id)) continue;
    if (p?.id) seenIds.add(p.id);
    deduped.push(p);
  }

  // A single malformed row (missing id/name, whatever) must never take the whole catalogue down — map defensively, skip only that row.
  const mapped = [];
  for (const p of deduped) {
    try {
      mapped.push({
        id: p.id, name: p.name || '', slug: p.slug || '', thumb: p.thumb || null,
        price: Number.isFinite(Number(p.price)) && p.price !== null ? Number(p.price) : null,
        createdAt: p.created_at || null,
        // Best-effort — EasyOrders' order payloads carry a per-cart-item sku
        // (services/easyOrders.js's ingestion path), but it's undocumented
        // whether the catalog /products listing itself carries a stable
        // per-product one under `sku` or `code`; surfaced here, additively,
        // so a caller (e.g. the catalog/internal-catalog audit) can see
        // whatever EasyOrders actually returns instead of assuming.
        sku: p.sku || p.code || null,
        // Same best-effort caveat as sku above — EasyOrders hasn't documented
        // an enabled/active flag on this endpoint; surfaced only if present.
        enabled: typeof p.enabled === 'boolean' ? p.enabled : (typeof p.active === 'boolean' ? p.active : null),
      });
    } catch (rowErr) {
      logger.warn('AMB EasyOrders products: skipped one malformed row', { message: rowErr.message });
    }
  }
  return mapped;
}

/**
 * All EasyOrders products: {id, name, slug, thumb, price, createdAt}. Cached
 * 1h. [] when not configured / on error.
 *
 * `price` and `createdAt` are real fields EasyOrders' /products response
 * already carries (confirmed against the live API) — surfaced here in
 * addition to the original id/name/slug/thumb so AI Product Marketing
 * Center's Easy Orders picker can show a real price and sort by real
 * creation date. Purely additive: the original 4 fields are unchanged, so
 * the existing easyOrdersImageFor() match logic below (and any other
 * caller reading only those 4) is unaffected.
 */
export async function getEasyOrdersProducts(storeId = defaultStoreId()) {
  const key = getStoreApiKey(storeId);
  if (!key) return [];
  const entry = cache.get(storeId);
  if (entry?.list && Date.now() - entry.at < TTL_MS) { diagStats.cacheHits++; return entry.list; }
  diagStats.cacheMisses++;
  if (inFlight.has(storeId)) return inFlight.get(storeId); // single-flight — see inFlight's own comment above
  const p = (async () => {
    try {
      const list = (await fetchEasyOrdersProductsRaw(key)).filter((p) => p.thumb);
      cache.set(storeId, { at: Date.now(), list });
      diagStats.lastSuccessAt[storeId] = Date.now();
      logger.info('AMB EasyOrders products cached', { storeId, count: list.length });
      return list;
    } catch (err) {
      logger.warn('AMB EasyOrders products fetch failed (non-fatal)', { storeId, message: err.message });
      return entry?.list || [];
    } finally {
      inFlight.delete(storeId);
    }
  })();
  inFlight.set(storeId, p);
  return p;
}

/**
 * The FULL real catalogue (no thumb filter — a product missing an image is
 * still a real, selectable product; the caller shows a placeholder) WITH an
 * honest status so a real API/network/config failure is never silently
 * presented as "zero products" (Product Marketing Center bug: a transient
 * EasyOrders error was being shown as "لم يتم العثور على منتجات" — this is
 * the fix). Cached 1h separately from getEasyOrdersProducts()'s own
 * thumb-only cache so neither list's staleness affects the other.
 * `forceRefresh` (default false) skips the cache READ for this one call and
 * always hits the live API — used only by the Catalog Sync page and the
 * product-creation flow, where "did a product just get added on Easy
 * Orders" must never wait out the 1h TTL. It still WRITES the fresh result
 * back into the same cache afterward, so every other consumer (the
 * Easy-Orders product picker, this same function's own default calls
 * elsewhere) immediately benefits from the same fresh data too — this is
 * a one-time bypass of a stale READ, not a second parallel cache.
 * @returns {Promise<{ok:boolean, products:object[], source:'live'|'stale_cache'|'error', error:string|null}>}
 */
export async function getAllEasyOrdersProductsStatus(storeId = defaultStoreId(), { forceRefresh = false } = {}) {
  const key = getStoreApiKey(storeId);
  if (!key) return { ok: false, products: [], source: 'error', error: 'هذا المتجر غير مربوط بـ Easy Orders — تأكد من ضبط مفتاح API الخاص به في متغيرات البيئة.' };
  const entry = fullCache.get(storeId);
  if (!forceRefresh && entry?.list && Date.now() - entry.at < TTL_MS) { diagStats.cacheHits++; return { ok: true, products: entry.list, source: 'live', error: null }; }
  diagStats.cacheMisses++;
  // Single-flight even for forceRefresh: a caller that explicitly asked for
  // fresh data still joins an ALREADY-RUNNING real crawl rather than
  // starting a second concurrent one — the freshness guarantee (this call
  // never reads a stale cache entry) is unaffected; only redundant duplicate
  // HTTP traffic is avoided.
  if (fullInFlight.has(storeId)) return fullInFlight.get(storeId);
  const p = (async () => {
    try {
      const list = await fetchEasyOrdersProductsRaw(key);
      fullCache.set(storeId, { at: Date.now(), list });
      diagStats.lastSuccessAt[storeId] = Date.now();
      logger.info('AMB EasyOrders full catalogue cached', { storeId, count: list.length });
      return { ok: true, products: list, source: 'live', error: null };
    } catch (err) {
      logger.error('AMB EasyOrders full catalogue fetch FAILED', { storeId, message: err.message, httpStatus: err.httpStatus || null });
      if (entry?.list) return { ok: true, products: entry.list, source: 'stale_cache', error: err.message };
      return { ok: false, products: [], source: 'error', error: err.message };
    } finally {
      fullInFlight.delete(storeId);
    }
  })();
  fullInFlight.set(storeId, p);
  return p;
}

/** Internal diagnostics only (Phase 22) — never a customer-facing dashboard. Lets a future incident like the real 429 stampede this fixes be diagnosed in seconds instead of re-derived from scratch. */
export function getEasyOrdersDiagnostics() {
  pruneOldRequestTimestamps();
  const now = Date.now();
  return {
    requestsLastMinute: diagStats.requestTimestamps.length,
    cacheHits: diagStats.cacheHits,
    cacheMisses: diagStats.cacheMisses,
    status429Count: diagStats.status429Count,
    retryCount: diagStats.retryCount,
    lastSuccessAtByStore: { ...diagStats.lastSuccessAt },
    thumbCacheAgeMsByStore: Object.fromEntries([...cache.entries()].map(([sid, e]) => [sid, now - e.at])),
    fullCacheAgeMsByStore: Object.fromEntries([...fullCache.entries()].map(([sid, e]) => [sid, now - e.at])),
    inFlightCrawls: inFlight.size,
    fullInFlightCrawls: fullInFlight.size,
  };
}

/**
 * Match one AMB product to an EasyOrders product and return its image URL.
 * Match order (all exact, whitespace/underscore/hyphen-insensitive):
 *   external_product_ref == slug  →  catalog name == EO name  →
 *   amb name == EO name  →  amb name == slug
 * Returns null when there's no confident match (never a fuzzy guess — a
 * wrong product image is worse than a placeholder).
 */
export async function easyOrdersImageFor({ ambProduct, catalogProduct, storeId = defaultStoreId() }) {
  const list = await getEasyOrdersProducts(storeId);
  if (!list.length) return null;
  const ref = norm(ambProduct?.external_product_ref);
  const catName = norm(catalogProduct?.product_name);
  const ambName = norm(ambProduct?.product_name);

  const hit =
    (ref && list.find((p) => norm(p.slug) === ref)) ||
    (catName && list.find((p) => norm(p.name) === catName)) ||
    (ambName && list.find((p) => norm(p.name) === ambName)) ||
    (ambName && list.find((p) => norm(p.slug) === ambName)) ||
    null;
  return hit ? { url: hit.thumb, eoName: hit.name, eoSlug: hit.slug } : null;
}
