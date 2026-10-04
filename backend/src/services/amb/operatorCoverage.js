// 🤖 AI Operator — PRODUCT UNIVERSE + COVERAGE AUDIT (read-only).
// ONE place that answers "which products exist, in which store, and how does each source see them?". The Setup Grid and the coverage report both read it,
// so no screen can silently drop a product again.
//
//   Product Master  = the catalogue `Product` table (store-scoped). A REAL product = active, not demo, not historical, with a resolvable store.
//   AMB             = `AmbProduct` — the Operator's ACTING layer. A product without an AMB row is still a real product (it is shown, marked NOT linked);
//                     the AMB row is created ONLY by an explicit Apply in the grid (saveProductProfile) — never here, never automatically.
//   Easy Orders     = the store's live catalogue (cached read). Matched by Easy Orders uuid first, then by exact normalised name inside the SAME store.
//   Store isolation = every comparison is made inside one store; a product is never matched to another store's catalogue/campaign/order.
import { prisma } from '../../prisma.js';
import { listStores } from '../easyOrdersStores.js';
import { getConnection } from '../metaAuth.js';
import { catalogKey, indexStoreCatalog, loadStoreCatalogProducts } from './productPriceResolver.js';

const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Loads every catalogue product with the facts the grid/audit need. Pure reads, a fixed number of batched queries (no N+1). */
export async function loadProductUniverse() {
  const stores = listStores().map((s) => ({ id: s.id, name: s.name, enabled: s.enabled }));
  const storeIds = new Set(stores.map((s) => s.id));
  const all = await prisma.product.findMany({ select: { id: true, product_name: true, product_code: true, store_id: true, active: true, is_demo: true, is_historical: true, easy_orders_uuid: true, selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true, current_stock: true, minimum_stock: true } });
  const unresolved = all.filter((p) => !p.store_id || !storeIds.has(p.store_id));
  const legacy = all.filter((p) => p.store_id && storeIds.has(p.store_id) && (!p.active || p.is_demo || p.is_historical));
  const real = all.filter((p) => p.store_id && storeIds.has(p.store_id) && p.active && !p.is_demo && !p.is_historical);
  const realIds = real.map((p) => p.id);

  const ambs = new Map((await prisma.ambProduct.findMany({ where: { product_id: { not: null } } })).map((a) => [a.product_id, a]));
  const cfgs = new Map((await prisma.ambOperatorProductConfig.findMany()).map((c) => [`${c.product_id}:${c.store_id}`, c]));
  // campaigns are counted for the CONNECTED Meta ad account only (same scope as the Operator's campaign index)
  const conn = await getConnection();
  const adAccountId = conn?.status === 'CONNECTED' ? conn.selected_ad_account_id || null : null;
  const maps = adAccountId ? await prisma.ambProductCampaignMap.findMany({ where: { ad_account_id: adAccountId }, select: { amb_product_id: true, campaign_id: true, status: true } }) : [];
  const ambToProduct = new Map([...ambs.values()].map((a) => [a.id, a.product_id]));
  const launched = adAccountId ? await prisma.ambLaunchCampaign.findMany({ where: { meta_campaign_id: { not: null }, job: { ad_account_id: adAccountId, product_id: { not: null } } }, select: { meta_campaign_id: true, job: { select: { product_id: true } } } }) : [];
  const verified = new Map(), suggested = new Map(); // productId -> Set(campaignId)
  const add = (m, pid, cid) => { if (!pid) return; (m.get(pid) || m.set(pid, new Set()).get(pid)).add(cid); };
  for (const m of maps) { const pid = ambToProduct.get(m.amb_product_id); if (m.status === 'MAPPED') add(verified, pid, m.campaign_id); else add(suggested, pid, m.campaign_id); }
  for (const l of launched) add(verified, l.job.product_id, l.meta_campaign_id);
  const orders30 = new Map((await prisma.easyOrdersOrder.groupBy({ by: ['product_id'], where: { product_id: { in: realIds }, date: { gte: day(30) } }, _count: { _all: true } })).map((g) => [g.product_id, g._count._all]));
  const ordersAll = new Map((await prisma.easyOrdersOrder.groupBy({ by: ['product_id'], where: { product_id: { in: realIds } }, _count: { _all: true } })).map((g) => [g.product_id, g._count._all]));
  const pmcRows = await prisma.productMarketingProfile.groupBy({ by: ['product_id'], where: { product_id: { not: null } }, _count: { _all: true } });
  const pmc = new Map(pmcRows.map((r) => [r.product_id, r._count._all]));
  const pmcUnlinked = await prisma.productMarketingProfile.count({ where: { product_id: null } });

  const eo = {};
  for (const s of stores) {
    const list = await loadStoreCatalogProducts(s.id); // cached 1h; null when the store catalogue is unavailable/partial
    eo[s.id] = list ? { list, byId: new Map(list.map((p) => [String(p.id), p])), byKey: indexStoreCatalog(list) } : null;
  }
  const products = real.map((p) => {
    const e = eo[p.store_id];
    let catalogLink = 'EO_UNAVAILABLE', eoId = null;
    if (e) {
      if (p.easy_orders_uuid && e.byId.has(String(p.easy_orders_uuid))) { catalogLink = 'EO_UUID'; eoId = String(p.easy_orders_uuid); }
      else { const m = e.byKey.get(catalogKey(p.product_name)) || []; if (m.length === 1) { catalogLink = 'EO_NAME'; eoId = String(m[0].id); } else catalogLink = m.length > 1 ? 'EO_AMBIGUOUS' : 'NOT_IN_EO_CATALOG'; }
    }
    const amb = ambs.get(p.id) || null;
    const v = verified.get(p.id)?.size || 0, sg = suggested.get(p.id)?.size || 0;
    return { product: p, amb, cfg: cfgs.get(`${p.id}:${p.store_id}`) || null, catalogLink, eoId, verifiedCampaigns: v, suggestedCampaigns: sg, advertising: v ? 'ADVERTISED' : sg ? 'SUGGESTED_ONLY' : 'NOT_ADVERTISED', orders30d: orders30.get(p.id) || 0, ordersTotal: ordersAll.get(p.id) || 0, pmcProfiles: pmc.get(p.id) || 0 };
  });
  return { stores, products, legacy, unresolved, all, eo, pmcUnlinked, ambTotal: ambs.size, pmcLinkedProfiles: [...pmc.values()].reduce((a, b) => a + b, 0) };
}

/** Store-by-store coverage. Every number is derived from the universe above — nothing is estimated. */
export async function coverageAudit() {
  const u = await loadProductUniverse();
  const perStore = {};
  for (const s of u.stores) {
    const rows = u.products.filter((r) => r.product.store_id === s.id);
    const dbRows = u.all.filter((p) => p.store_id === s.id);
    const keys = new Map(); for (const r of rows) { const k = catalogKey(r.product.product_name); keys.set(k, (keys.get(k) || 0) + 1); }
    const dupGroups = [...keys.values()].filter((n) => n > 1).length;
    const e = u.eo[s.id];
    const eoDupGroups = e ? [...e.byKey.values()].filter((g) => g.length > 1).length : null;
    const matchedEo = new Set(rows.map((r) => r.eoId).filter(Boolean));
    const eoNotInCatalogue = e ? e.list.filter((p) => !matchedEo.has(String(p.id))) : null;
    perStore[s.id] = {
      store: s.id, name: s.name,
      eoCatalogProducts: e ? e.list.length : null, eoDuplicateNameGroups: eoDupGroups, eoNotInCatalogue: eoNotInCatalogue ? eoNotInCatalogue.length : null, eoNotInCatalogueSamples: eoNotInCatalogue ? eoNotInCatalogue.slice(0, 5).map((p) => p.name) : [],
      totalCatalogRows: dbRows.length, totalCatalogProducts: rows.length,
      operatorProducts: rows.length, // the Setup Grid lists EVERY real catalogue product of the store
      operatorLinked: rows.filter((r) => r.amb).length, missingFromOperatorActingLayer: rows.filter((r) => !r.amb).length,
      withCampaigns: rows.filter((r) => r.advertising === 'ADVERTISED').length, withSuggestedOnly: rows.filter((r) => r.advertising === 'SUGGESTED_ONLY').length, withoutCampaigns: rows.filter((r) => r.advertising === 'NOT_ADVERTISED').length,
      advertisedButNotLinked: rows.filter((r) => r.advertising === 'ADVERTISED' && !r.amb).length,
      duplicates: dupGroups, legacyInactive: dbRows.length - rows.length,
      linkedToEoByUuid: rows.filter((r) => r.catalogLink === 'EO_UUID').length, linkedToEoByName: rows.filter((r) => r.catalogLink === 'EO_NAME').length, notInEoCatalog: rows.filter((r) => r.catalogLink === 'NOT_IN_EO_CATALOG').length,
      notInEoCatalogWithOrders30d: rows.filter((r) => r.catalogLink === 'NOT_IN_EO_CATALOG' && r.orders30d > 0).length,
      withOrders30d: rows.filter((r) => r.orders30d > 0).length, withPmcProfile: rows.filter((r) => r.pmcProfiles > 0).length,
    };
  }
  const totals = Object.values(perStore).reduce((t, s) => { for (const k of ['totalCatalogProducts', 'operatorProducts', 'operatorLinked', 'missingFromOperatorActingLayer', 'withCampaigns', 'withoutCampaigns', 'duplicates', 'legacyInactive', 'advertisedButNotLinked']) t[k] = (t[k] || 0) + s[k]; return t; }, {});
  totals.unresolvedStore = u.unresolved.length;
  return { generatedAt: new Date().toISOString(), stores: perStore, totals, unresolvedStore: u.unresolved.slice(0, 20).map((p) => ({ id: p.id, name: p.product_name, store: p.store_id })), ambRows: u.ambTotal, pmc: { linkedProfiles: u.pmcLinkedProfiles, unlinkedProfiles: u.pmcUnlinked }, readOnly: true };
}
