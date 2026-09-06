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
const TTL_MS = 60 * 60 * 1000;

function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** All EasyOrders products (id, name, slug, thumb). Cached 1h. [] when not configured / on error. */
export async function getEasyOrdersProducts() {
  const key = process.env.EASYORDERS_API_KEY;
  if (!key) return [];
  if (cache.list && Date.now() - cache.at < TTL_MS) return cache.list;
  try {
    const res = await fetch(`${EASYORDERS_API_BASE}/products`, { headers: { 'Api-Key': key } });
    if (!res.ok) throw new Error(`EasyOrders /products ${res.status}`);
    const raw = await res.json();
    const list = (Array.isArray(raw) ? raw : []).map((p) => ({
      id: p.id, name: p.name || '', slug: p.slug || '', thumb: p.thumb || null,
    })).filter((p) => p.thumb);
    cache = { at: Date.now(), list };
    logger.info('AMB EasyOrders products cached', { count: list.length });
    return list;
  } catch (err) {
    logger.warn('AMB EasyOrders products fetch failed (non-fatal)', { message: err.message });
    return cache.list || [];
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
