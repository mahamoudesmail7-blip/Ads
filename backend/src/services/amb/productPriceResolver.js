// AI Media Buyer — Selling Price RESOLUTION with provenance (pure + a cached store-catalogue reader). Used by AI Operator and the integration audit.
//
// Business data is NEVER duplicated or invented here: this only decides which EXISTING, VERIFIED source supplies the number and flags disagreements.
//   1. AmbProduct.actual_selling_price (the owner's explicit AMB value)          -> OWNER_ENTERED
//   2. Product.selling_price (the catalogue master)                              -> CATALOG
//   3. the store's live Easy Orders catalogue, matched by EXACT normalised name (the "(s24)"-style SKU suffix is ignored) inside the SAME store,
//      only when exactly one product matches                                    -> STORE_CATALOG
//   0. an OWNER-CONFIRMED price (operatorStore.setOwnerConfirmedPrice: who/when/source on record, scoped to ONE product) — it settles a disagreement with the
//      store catalogue (Easy Orders is never edited) but ONLY while AmbProduct and the catalogue Product carry that same number; a stale confirmation is ignored.
// A suggested price (cost x multiplier) is NOT a source. When two real sources disagree the result is CONFLICT (profit-dependent actions stay blocked until
// a human decides) — the Operator never picks a winner silently.
import { normalizeName } from '../../../../js/product-mapping.js';
import { getAllEasyOrdersProductsStatus } from './easyOrdersProducts.js';

const pos = (v) => { const n = Number(v); return v != null && Number.isFinite(n) && n > 0 ? n : null; };
/** "جهاز X (s24)" -> normalised "جهاز x": Easy Orders appends its internal SKU code to the display name. */
export const catalogKey = (name) => normalizeName(String(name || '').replace(/\(\s*s\s*\d+\s*\)/gi, ' ').replace(/\s+/g, ' ').trim());

/** Pure: index a store catalogue (array of {id,name,slug,price}) by catalogKey. */
export function indexStoreCatalog(products) {
  const byKey = new Map();
  for (const p of products || []) { const k = catalogKey(p.name); if (!k) continue; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(p); }
  return byKey;
}

/** Pure resolver. `storeCatalog` = Map from indexStoreCatalog (or null when the store catalogue is unavailable). */
export function resolveSellingPrice({ product, ambProduct, storeCatalog, ownerConfirmed = null }) {
  const amb = pos(ambProduct?.actual_selling_price);
  const cat = pos(product?.selling_price);
  const matches = storeCatalog ? (storeCatalog.get(catalogKey(product?.product_name)) || []) : [];
  const eoMatch = matches.length === 1 ? matches[0] : null;
  const eo = eoMatch ? pos(eoMatch.price) : null;
  const sources = { owner: amb, catalog: cat, storeCatalog: eo, storeCatalogMatches: matches.length };
  const eoRef = eoMatch ? { id: eoMatch.id, name: eoMatch.name, slug: eoMatch.slug || null } : null;
  const differs = (a, b) => a != null && b != null && Math.abs(a - b) > 0.5;
  const oc = pos(ownerConfirmed?.value);
  if (oc != null && amb != null && !differs(oc, amb) && (cat == null || !differs(oc, cat))) {
    // the owner confirmed this number for THIS product: a different Easy Orders catalogue price is reported (never edited, never silently ignored)
    return { value: oc, source: 'OWNER_CONFIRMED', status: 'VERIFIED', sources, eoRef, ownerConfirmed: { value: oc, by: ownerConfirmed.by ?? null, at: ownerConfirmed.at ?? null, source: ownerConfirmed.source || 'USER_CONFIRMED', note: ownerConfirmed.note || null }, overriddenStoreCatalogPrice: differs(oc, eo) ? eo : null };
  }
  if (amb != null) {
    if (differs(amb, cat)) return { value: null, source: null, status: 'CONFLICT', conflict: { owner: amb, catalog: cat }, sources, eoRef, reason: 'سعر AMB يختلف عن سعر الكتالوج.' };
    if (differs(amb, eo)) return { value: null, source: null, status: 'CONFLICT', conflict: { owner: amb, storeCatalog: eo }, sources, eoRef, reason: 'سعر AMB يختلف عن سعر كتالوج المتجر في Easy Orders.' };
    return { value: amb, source: 'OWNER_ENTERED', status: 'VERIFIED', sources, eoRef };
  }
  if (cat != null) {
    if (differs(cat, eo)) return { value: null, source: null, status: 'CONFLICT', conflict: { catalog: cat, storeCatalog: eo }, sources, eoRef, reason: 'سعر الكتالوج يختلف عن سعر نفس المنتج في كتالوج المتجر (Easy Orders).' };
    return { value: cat, source: 'CATALOG', status: eo != null ? 'VERIFIED' : 'UNCROSSCHECKED', sources, eoRef };
  }
  if (eo != null) return { value: eo, source: 'STORE_CATALOG', status: 'FROM_STORE_CATALOG', sources, eoRef, reason: 'السعر مأخوذ من كتالوج المتجر في Easy Orders (مطابقة اسم دقيقة وفريدة داخل نفس المتجر).' };
  return { value: null, source: null, status: 'MISSING', sources, eoRef: null, reason: matches.length > 1 ? 'أكتر من منتج في كتالوج المتجر بنفس الاسم — محتاج مراجعة.' : 'لا يوجد سعر في أي مصدر.' };
}

// ---- cached store catalogue reader (the app's own existing reader, 1h cache, read-only; failure => null, never throws)
const TTL_MS = 60 * 60_000;
const cache = new Map(); // storeId -> {at, index, products}
export function clearStoreCatalogCache() { cache.clear(); }
const inflight = new Map(); // storeId -> Promise — concurrent callers (several screens at once) share ONE catalogue fetch
async function loadEntry(storeId, opts = {}) {
  if (!storeId) return null;
  const hit = cache.get(storeId);
  if (hit && (opts.now ?? Date.now()) - hit.at < TTL_MS) return hit;
  if (inflight.has(storeId)) return inflight.get(storeId);
  const p = loadEntryUncached(storeId, opts).finally(() => inflight.delete(storeId));
  inflight.set(storeId, p);
  return p;
}
async function loadEntryUncached(storeId, { fetcher = getAllEasyOrdersProductsStatus, now = Date.now() } = {}) {
  try {
    const r = await fetcher(storeId);
    if (!r?.ok || !Array.isArray(r.products) || !r.products.length || r.partial) { const e = { at: now - TTL_MS + 5 * 60_000, index: null, products: null }; cache.set(storeId, e); return e; } // incomplete/unavailable: retry in 5 minutes
    const e = { at: now, index: indexStoreCatalog(r.products), products: r.products };
    cache.set(storeId, e);
    return e;
  } catch { return null; }
}
export async function loadStoreCatalogIndex(storeId, opts) { return (await loadEntry(storeId, opts))?.index || null; }
/** Raw complete catalogue of a store ({id,name,slug,price,...}) or null. */
export async function loadStoreCatalogProducts(storeId, opts) { return (await loadEntry(storeId, opts))?.products || null; }
