// AI Operator V2 — per-product facts for the campaign list, loaded IN BULK (a constant number of queries for any number of products).
// Before: every distinct product cost ~16 queries (getProductProfile + stockGuardForProduct, each re-reading the operator config, the product, its mapping, exceptions, inventory and Easy Orders velocity)
// → ~970 queries for one list of 368 campaigns / 54 products. The list needs only: profit limit (Max/Target CPA), unit margin, «economics complete», and the stock STATUS / quantity.
// Rules that keep the numbers identical to the single-product path (operatorReadiness.getProductProfile / stockGuard.resolveStockInputs):
//   · the same PURE functions do the work (resolveSellingPrice, computeOperatorEconomics, decideStockInputs, stockStatus) — nothing is re-implemented;
//   · the Easy Orders store catalogue is NEVER fetched while the screen waits: the cached copy (even an hour-old one) is used and a background refresh is started; until the first copy exists the
//     economics are computed WITHOUT the store-catalogue cross-check and flagged `provisional` (so the screen can say so) — the cache is then shortened so the next refresh picks the real numbers.
// READ-ONLY: findMany / pure functions only (the config read keeps its existing «create the GLOBAL row if it is missing» behaviour).
import { prisma } from '../../prisma.js';
import { computeOperatorEconomics } from './operatorGuards.js';
import { resolveSellingPrice, peekStoreCatalog } from './productPriceResolver.js';
import { getOperatorConfig, ownerPriceOf } from './operatorStore.js';
import { decideStockInputs, stockStatus } from './stockGuard.js';
import * as inventoryApi from './inventoryApi.js';

const PRODUCT_SELECT = { id: true, product_name: true, product_code: true, sku: true, store_id: true, selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true, current_stock: true, minimum_stock: true };

/** @returns {Promise<{ facts: Map<number, {info: object|null, stock: object|null}>, pendingStores: string[] }>} */
export async function loadProductFactsBatch(productIds, { now = new Date(), deps = {} } = {}) {
  const ids = [...new Set((productIds || []).map(Number).filter(Number.isInteger))]; const facts = new Map(); const pending = new Set();
  if (!ids.length) return { facts, pendingStores: [] };
  const [products, ambs, opCfgs, cfg] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: ids } }, select: PRODUCT_SELECT }),
    prisma.ambProduct.findMany({ where: { product_id: { in: ids } } }),
    prisma.ambOperatorProductConfig.findMany({ where: { product_id: { in: ids } } }),
    (deps.config || getOperatorConfig)(),
  ]);
  const ambBy = new Map(ambs.map((a) => [a.product_id, a])); const cfgBy = new Map(opCfgs.map((c) => [`${c.product_id}|${c.store_id}`, c]));
  // latest Inventory-API snapshot per product (same ordering as latestApiSnapshot: date desc, id desc) in ONE query
  const apiRows = await prisma.inventorySnapshot.findMany({ where: { product_id: { in: ids }, source: { startsWith: 'INVENTORY_API' } }, orderBy: [{ product_id: 'asc' }, { date: 'desc' }, { id: 'desc' }] });
  const latestBy = new Map(); for (const r of apiRows) if (!latestBy.has(r.product_id)) { let state = {}; try { state = (r.notes ? JSON.parse(r.notes) : {}) || {}; } catch { state = {}; } latestBy.set(r.product_id, { row: r, state }); }
  let staleHours = null, lastReconcile = null; if (latestBy.size) { staleHours = await inventoryApi.getStaleHours(); lastReconcile = await inventoryApi.lastReconcileResult(); }
  // the non-API fallback snapshot is only needed where the stock cannot come from the catalogue / the approved API
  const needSnap = products.filter((p) => p.current_stock == null && !(latestBy.has(p.id) && inventoryApi.primaryOf(cfg, p.id)?.primary)).map((p) => p.id);
  const snapBy = new Map();
  if (needSnap.length) { const snaps = await prisma.inventorySnapshot.findMany({ where: { product_id: { in: needSnap }, OR: [{ source: null }, { NOT: { source: { startsWith: 'INVENTORY_API' } } }] }, orderBy: [{ product_id: 'asc' }, { date: 'desc' }], select: { product_id: true, date: true, closing_stock: true, source: true } }); for (const s of snaps) if (!snapBy.has(s.product_id)) snapBy.set(s.product_id, s); }
  const catalogs = new Map(); const catalogOf = (storeId) => { if (!catalogs.has(storeId)) { const c = (deps.peekCatalog || peekStoreCatalog)(storeId, { now: now.getTime() }); catalogs.set(storeId, c); if (!c.ready) pending.add(storeId); } return catalogs.get(storeId); };
  for (const product of products) {
    const amb = ambBy.get(product.id) || null; const opCfg = cfgBy.get(`${product.id}|${product.store_id}`) || null; const cat = catalogOf(product.store_id);
    const priceResolution = resolveSellingPrice({ product, ambProduct: amb, storeCatalog: cat.index, ownerConfirmed: ownerPriceOf(cfg, product.id) });
    const econ = computeOperatorEconomics({ product, ambProduct: amb, opCfg, priceResolution });
    const maxCpa = opCfg?.max_cpa ?? amb?.max_cpa ?? econ.calculatedMaxCpa ?? null; const targetCpa = opCfg?.target_cpa ?? amb?.target_cpa ?? null;
    const info = { profitLimit: maxCpa ?? targetCpa ?? null, unitMargin: econ.unitMargin ?? null, complete: !!econ.complete, provisional: !cat.ready };
    const inputs = decideStockInputs({ productId: product.id, product, latest: latestBy.get(product.id) || null, cfg, staleHours, lastReconcile, snap: snapBy.get(product.id) || null, now, api: inventoryApi });
    const base = stockStatus({ current_stock: inputs.current, minimum_stock: inputs.minimum });
    facts.set(product.id, { info, stock: { status: base.status, current: base.currentStock ?? null, minimum: base.minimumStock ?? null } });
  }
  for (const id of ids) if (!facts.has(id)) facts.set(id, { info: null, stock: { status: 'STOCK_UNKNOWN', current: null, minimum: null } }); // a product that no longer exists: the same «unknown» the single path returned
  return { facts, pendingStores: [...pending] };
}
