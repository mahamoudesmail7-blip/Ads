// Landing-page PROOF shared by Campaign Mapping (operatorLandingAnalysis) and the Launch Wizard (launchLandingValidation).
// A landing page is only ever trusted through its OWN embedded identity (Easy Orders store_id + product uuid), checked against OUR stores' catalogues —
// never through the domain name. Reads only: a public storefront GET + our Easy Orders catalogue (cached) + our DB.
import { prisma } from '../../prisma.js';
import { loadStoreCatalogProducts } from './productPriceResolver.js';
import { listStores } from '../easyOrdersStores.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export function slugFromLandingUrl(url) {
  try { const p = new URL(url).pathname.split('/').filter(Boolean); const i = p.findIndex((x) => /^products?$/i.test(x)); return (decodeURIComponent((i >= 0 ? p[i + 1] : p[p.length - 1]) || '').toLowerCase()) || null; } catch { return null; }
}
/** Identity a storefront page embeds about itself. */
export function extractPageIdentity(html) {
  const s = String(html || '');
  return {
    title: (s.match(/<title>([^<]*)<\/title>/) || [])[1] || null,
    storeIds: [...new Set([...s.matchAll(/store_id"?\s*:\s*"([0-9a-f-]{36})"/g)].map((m) => m[1]))],
    uuids: [...new Set(s.match(UUID_RE) || [])],
  };
}
/**
 * `catalogues` = { storeId: { bySlug: Map(slug -> {id,name,slug}) } }. PROVEN only when, in exactly one of OUR stores, the catalogue product listed under
 * the URL's slug has its uuid embedded in the page itself.
 */
export function provePage({ url, page, catalogues }) {
  const slug = slugFromLandingUrl(url);
  if (!page) return { proven: false, reason: 'PAGE_UNREACHABLE', slug };
  if (!slug) return { proven: false, reason: 'NO_SLUG', slug };
  const hits = [];
  for (const [store, cat] of Object.entries(catalogues)) { const p = cat.bySlug.get(slug); if (p && page.uuids.includes(String(p.id))) hits.push({ store, eoProductId: String(p.id), name: p.name }); }
  if (hits.length === 1) return { proven: true, store: hits[0].store, eoProductId: hits[0].eoProductId, name: hits[0].name, slug, eoStoreIds: page.storeIds };
  if (hits.length > 1) return { proven: false, reason: 'PAGE_MATCHES_MORE_THAN_ONE_STORE', slug };
  const anyOurs = Object.values(catalogues).some((c) => [...c.bySlug.values()].some((p) => page.uuids.includes(String(p.id))));
  return { proven: false, reason: anyOurs ? 'SLUG_DOES_NOT_MATCH_PAGE_PRODUCT' : 'PAGE_BELONGS_TO_A_STORE_WE_DO_NOT_OWN', slug, eoStoreIds: page.storeIds };
}

const pageCache = new Map(); // url -> {at, page}
const PAGE_TTL = 60 * 60_000;
function safeUrl(u) { try { const x = new URL(u); if (x.protocol !== 'https:') return null; if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(x.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(x.hostname)) return null; return x; } catch { return null; } }
export function clearLandingPageCache() { pageCache.clear(); }
export async function fetchLandingPage(url, { fetchImpl = fetch, useCache = true } = {}) {
  const u = safeUrl(url); if (!u) return null;
  const key = u.origin + u.pathname; const hit = useCache ? pageCache.get(key) : null; if (hit && Date.now() - hit.at < PAGE_TTL) return hit.page;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetchImpl(key, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; OrderMonitor/1.0)' }, signal: AbortSignal.timeout(15000) });
      if (r.status !== 200) { pageCache.set(key, { at: Date.now(), page: null }); return null; }
      const html = (await r.text()).slice(0, 2_000_000); const page = extractPageIdentity(html); pageCache.set(key, { at: Date.now(), page }); return page;
    } catch { await new Promise((x) => setTimeout(x, 1500)); }
  }
  return null;
}

/** Our stores' Easy Orders catalogues (by slug) + our Product Master by Easy Orders uuid. Throws 503 when a store catalogue is unavailable (fail closed). */
export async function loadLandingCatalogues() {
  const catalogues = {}; const dbByUuid = {};
  for (const s of listStores().map((x) => x.id)) {
    const list = await loadStoreCatalogProducts(s);
    if (!list) throw Object.assign(new Error(`كتالوج Easy Orders للمتجر ${s} غير متاح الآن — أعد المحاولة.`), { status: 503 });
    catalogues[s] = { bySlug: new Map(list.map((p) => [String(p.slug || '').toLowerCase(), p])) };
    const rows = await prisma.product.findMany({ where: { store_id: s, active: true, is_historical: false, easy_orders_uuid: { not: null } }, select: { id: true, product_name: true, easy_orders_uuid: true } });
    dbByUuid[s] = new Map(rows.map((p) => [String(p.easy_orders_uuid), p]));
  }
  return { catalogues, dbByUuid };
}

/** One URL -> a verified { store, productId } or a precise reason it could not be verified. */
export async function resolveLandingIdentity(url, { catalogues, dbByUuid, fetchPage = fetchLandingPage }) {
  const page = await fetchPage(url);
  const pr = provePage({ url, page, catalogues });
  if (!pr.proven) return { status: 'UNVERIFIED', reason: pr.reason, url, slug: pr.slug };
  const p = dbByUuid[pr.store]?.get(pr.eoProductId);
  if (!p) return { status: 'UNVERIFIED', reason: 'EO_PRODUCT_NOT_IN_PRODUCT_MASTER', url, slug: pr.slug, store: pr.store, eoProductId: pr.eoProductId };
  return { status: 'VERIFIED', url, slug: pr.slug, store: pr.store, eoProductId: pr.eoProductId, productId: p.id, productName: p.product_name, eoStoreIds: pr.eoStoreIds || [] };
}
