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

let cache = { at: 0, list: null };
let fullCache = { at: 0, list: null }; // separate cache: the UN-filtered full catalogue (getAllEasyOrdersProductsStatus) — kept apart from `cache` (thumb-only, existing consumers) so neither invalidates the other
const TTL_MS = 60 * 60 * 1000;

function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** The ONE real fetch — no Api-Key handling, no caching, just the live HTTP call + shape mapping. Both getEasyOrdersProducts() (below, thumb-only, for image matching) and getAllEasyOrdersProductsStatus() (full catalogue, for the Product Marketing Center picker) build on this — one real integration, two views over it. */
async function fetchEasyOrdersProductsRaw(key) {
  const res = await fetch(`${EASYORDERS_API_BASE}/products`, { headers: { 'Api-Key': key } });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const err = new Error(`EasyOrders /products ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ''}`);
    err.httpStatus = res.status;
    throw err;
  }
  const raw = await res.json();
  if (!Array.isArray(raw)) {
    logger.warn('AMB EasyOrders products: unexpected response shape (not an array)', { sample: JSON.stringify(raw).slice(0, 300) });
    return [];
  }
  // A single malformed row (missing id/name, whatever) must never take the whole catalogue down — map defensively, skip only that row.
  const mapped = [];
  for (const p of raw) {
    try {
      mapped.push({
        id: p.id, name: p.name || '', slug: p.slug || '', thumb: p.thumb || null,
        price: Number.isFinite(Number(p.price)) && p.price !== null ? Number(p.price) : null,
        createdAt: p.created_at || null,
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
export async function getEasyOrdersProducts() {
  const key = process.env.EASYORDERS_API_KEY;
  if (!key) return [];
  if (cache.list && Date.now() - cache.at < TTL_MS) return cache.list;
  try {
    const list = (await fetchEasyOrdersProductsRaw(key)).filter((p) => p.thumb);
    cache = { at: Date.now(), list };
    logger.info('AMB EasyOrders products cached', { count: list.length });
    return list;
  } catch (err) {
    logger.warn('AMB EasyOrders products fetch failed (non-fatal)', { message: err.message });
    return cache.list || [];
  }
}

/**
 * The FULL real catalogue (no thumb filter — a product missing an image is
 * still a real, selectable product; the caller shows a placeholder) WITH an
 * honest status so a real API/network/config failure is never silently
 * presented as "zero products" (Product Marketing Center bug: a transient
 * EasyOrders error was being shown as "لم يتم العثور على منتجات" — this is
 * the fix). Cached 1h separately from getEasyOrdersProducts()'s own
 * thumb-only cache so neither list's staleness affects the other.
 * @returns {Promise<{ok:boolean, products:object[], source:'live'|'stale_cache'|'error', error:string|null}>}
 */
export async function getAllEasyOrdersProductsStatus() {
  const key = process.env.EASYORDERS_API_KEY;
  if (!key) return { ok: false, products: [], source: 'error', error: 'EASYORDERS_API_KEY غير مضبوط في متغيرات البيئة.' };
  if (fullCache.list && Date.now() - fullCache.at < TTL_MS) return { ok: true, products: fullCache.list, source: 'live', error: null };
  try {
    const list = await fetchEasyOrdersProductsRaw(key);
    fullCache = { at: Date.now(), list };
    logger.info('AMB EasyOrders full catalogue cached', { count: list.length });
    return { ok: true, products: list, source: 'live', error: null };
  } catch (err) {
    logger.error('AMB EasyOrders full catalogue fetch FAILED', { message: err.message, httpStatus: err.httpStatus || null });
    if (fullCache.list) return { ok: true, products: fullCache.list, source: 'stale_cache', error: err.message };
    return { ok: false, products: [], source: 'error', error: err.message };
  }
}

/**
 * Match one AMB product to an EasyOrders product and return its image URL.
 * Match order (all exact, whitespace/underscore/hyphen-insensitive):
 *   external_product_ref == slug  →  catalog name == EO name  →
 *   amb name == EO name  →  amb name == slug
 * Returns null when there's no confident match (never a fuzzy guess — a
 * wrong product image is worse than a placeholder).
 */
export async function easyOrdersImageFor({ ambProduct, catalogProduct }) {
  const list = await getEasyOrdersProducts();
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
