// 🧪 AI Operator V2 performance fix — the campaign list loads per-product facts IN BULK instead of ~16 queries per product (isolated test database, no Meta, no Easy Orders network).
//   1) the batch result equals the single-product path for every stock / price case (profit limit, unit margin, «complete», stock status / quantity / minimum)
//   2) the number of queries is constant: 10 products and 40 products cost the same
//   3) the Easy Orders store catalogue is never awaited: a slow fetcher does not slow the call, the cached copy is used, a failing store does not retry on every request
//   4) the list: far fewer queries than before the fix for the same data, identical rows, concurrent identical requests share one build, creating a draft clears the cache (no stale decision)
//   node src/scripts/productFactsBatchTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url)); const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0; const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };
const { prisma } = await imp('../prisma.js'); const TT = await imp('../services/amb/dailyPlanTime.js'); const PF = await imp('../services/amb/productFactsBatch.js'); const RD = await imp('../services/amb/operatorReadiness.js');
const SG = await imp('../services/amb/stockGuard.js'); const PR = await imp('../services/amb/productPriceResolver.js'); const CQ = await imp('../services/amb/campaignQuery.js'); const BR = await imp('../services/amb/campaignPlanBridge.js'); const AX = await imp('../services/amb/operatorV2Access.js');
const T = '__optest_pf_'; const STORE = `${T}store`; const today = TT.cairoDate(new Date()); const day = (n) => TT.addDays(today, -n); const AC = `act_${T}A`;
let n = 0; const byModel = {}; prisma.$use(async (p, next) => { n++; const k = `${p.model || 'raw'}.${p.action}`; byModel[k] = (byModel[k] || 0) + 1; return next(p); });
const count = async (fn) => { n = 0; for (const k in byModel) delete byModel[k]; const r = await fn(); return { r, q: n }; };
const mkProduct = (i, extra = {}) => prisma.product.create({ data: { product_name: `${T}p${i}`, product_code: `${T}${i}_${Date.now()}`, store_id: STORE, selling_price: 300, product_cost: 100, shipping_cost: 20, packaging_cost: 5, other_cost: 0, ...extra } });
const mkAmb = (productId, extra = {}) => prisma.ambProduct.create({ data: { product_id: productId, product_name: `${T}amb${productId}`, product_cost: 0, pricing_multiplier: 1, suggested_selling_price: 0, packaging_cost: 0, shipping_cost: 0, other_cost: 0, rto_cost: 0, currency: 'EGP', ...extra } });
const cfg0 = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const savedLimits = cfg0?.limits_json ?? null; const created = []; const productIds = []; const campaignIds = [];
const setLimits = async (obj) => { await RD.getProductProfile; const row = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const lj = JSON.parse(row.limits_json || '{}'); await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify({ ...lj, ...obj }) } }); };
try {
  console.log('\n1. Batch == single-product path (same pure functions, every stock / price case)');
  const P = {};
  P.complete = await mkProduct(1, { current_stock: 50, minimum_stock: 5 }); await mkAmb(P.complete.id);
  P.noPrice = await mkProduct(2, { selling_price: 0, current_stock: 3, minimum_stock: 5 });
  P.conflict = await mkProduct(3, { current_stock: 0 }); await mkAmb(P.conflict.id, { actual_selling_price: 350 });
  P.freshSnap = await mkProduct(4, { current_stock: null }); await prisma.inventorySnapshot.create({ data: { product_id: P.freshSnap.id, product_name: 'x', date: day(1), closing_stock: 12, movement_type: 'DAILY', source: null } });
  P.staleSnap = await mkProduct(5, { current_stock: null }); await prisma.inventorySnapshot.create({ data: { product_id: P.staleSnap.id, product_name: 'x', date: day(10), closing_stock: 9, movement_type: 'DAILY', source: null } });
  P.nothing = await mkProduct(6, { current_stock: null, product_cost: 0 });
  P.override = await mkProduct(7, { current_stock: 8, minimum_stock: 2 }); await mkAmb(P.override.id, { max_cpa: 70, target_cpa: 55 }); await prisma.ambOperatorProductConfig.create({ data: { product_id: P.override.id, store_id: STORE, max_cpa: 90, target_cpa: 60, min_profit: 10 } });
  P.apiPrimary = await mkProduct(8, { current_stock: 4, minimum_stock: 3 }); await prisma.inventorySnapshot.create({ data: { product_id: P.apiPrimary.id, product_name: 'x', date: today, closing_stock: 7, movement_type: 'API', source: 'INVENTORY_API', notes: JSON.stringify({ totals: { available: 7, current: 9, reserved: 2 }, lastSyncAt: new Date().toISOString() }) } });
  P.apiShadow = await mkProduct(9, { current_stock: 20, minimum_stock: 3 }); await prisma.inventorySnapshot.create({ data: { product_id: P.apiShadow.id, product_name: 'x', date: today, closing_stock: 1, movement_type: 'API', source: 'INVENTORY_API', notes: JSON.stringify({ totals: { available: 1 }, lastSyncAt: new Date().toISOString() }) } });
  P.apiStale = await mkProduct(10, { current_stock: 15 }); await prisma.inventorySnapshot.create({ data: { product_id: P.apiStale.id, product_name: 'x', date: day(5), closing_stock: 6, movement_type: 'API', source: 'INVENTORY_API', notes: JSON.stringify({ totals: { available: 6 }, lastSyncAt: new Date(Date.now() - 5 * 86_400_000).toISOString() }) } });
  for (const p of Object.values(P)) productIds.push(p.id);
  await setLimits({ productOverrides: { [String(P.apiPrimary.id)]: { inventory: { primary: true } }, [String(P.apiStale.id)]: { inventory: { primary: true } } } });
  PR.clearStoreCatalogCache(); const { facts, pendingStores } = await PF.loadProductFactsBatch(productIds, { deps: { peekCatalog: () => ({ index: null, ready: true }) } });
  let allSame = true; const diffs = [];
  for (const [name, p] of Object.entries(P)) {
    const old = await RD.getProductProfile({ productId: p.id }); const oldStock = await SG.stockGuardForProduct({ productId: p.id, storeId: STORE }); const f = facts.get(p.id);
    const oi = { profitLimit: old.economics.maxCpa.value ?? old.economics.targetCpa.value ?? null, unitMargin: old.economics.unitMargin ?? null, complete: !!old.economics.complete }; const os = { status: oldStock.status, current: oldStock.currentStock ?? null, minimum: oldStock.minimumStock ?? null };
    const ni = { profitLimit: f.info.profitLimit, unitMargin: f.info.unitMargin, complete: f.info.complete }; const ns = f.stock;
    if (JSON.stringify(oi) !== JSON.stringify(ni) || JSON.stringify(os) !== JSON.stringify(ns)) { allSame = false; diffs.push({ name, oi, ni, os, ns }); }
  }
  ok('all 10 cases give exactly the single-path numbers: complete / no price / price CONFLICT / fresh snapshot / stale snapshot / nothing / owner Max-Target override / API-primary fresh / API shadow / API-primary stale', allSame, JSON.stringify(diffs));
  ok('the business meaning is right too: complete → profit limit from the margin, conflict → incomplete (no limit), override wins (90), API-primary stale → stock UNKNOWN (never the manual 15), shadow API never replaces the catalogue stock (20)', facts.get(P.complete.id).info.complete === true && facts.get(P.complete.id).info.profitLimit > 0 && facts.get(P.conflict.id).info.complete === false && facts.get(P.override.id).info.profitLimit === 90 && facts.get(P.apiStale.id).stock.status === 'STOCK_UNKNOWN' && facts.get(P.apiShadow.id).stock.current === 20 && facts.get(P.apiPrimary.id).stock.current === 7 && facts.get(P.conflict.id).stock.status === 'OUT_OF_STOCK');
  ok('a product that does not exist is «unknown», not an error', (await PF.loadProductFactsBatch([999999991], { deps: { peekCatalog: () => ({ index: null, ready: true }) } })).facts.get(999999991).stock.status === 'STOCK_UNKNOWN' && pendingStores.length === 0);
  ok('with the store catalogue available the batch uses it (a catalogue-only price is accepted) exactly like the single path', await (async () => { const p = await mkProduct(11, { selling_price: 0, current_stock: 5 }); productIds.push(p.id); const idx = PR.indexStoreCatalog([{ id: 'e1', name: `${T}p11`, price: 320 }]); const f = (await PF.loadProductFactsBatch([p.id], { deps: { peekCatalog: () => ({ index: idx, ready: true }) } })).facts.get(p.id).info; return f.complete === true && f.unitMargin > 0 && f.provisional === false; })());

  console.log('\n2. A constant number of queries');
  const ids10 = productIds.slice(0, 10); const extra = []; for (let i = 20; i < 50; i++) { const p = await mkProduct(i, { current_stock: 10 + i }); extra.push(p.id); productIds.push(p.id); }
  const peek = { peekCatalog: () => ({ index: null, ready: true }) }; const q10 = await count(() => PF.loadProductFactsBatch(ids10, { deps: peek })); const q40 = await count(() => PF.loadProductFactsBatch([...ids10, ...extra], { deps: peek }));
  ok(`10 products and 40 products cost the SAME number of queries (${q10.q} vs ${q40.q}) — it no longer grows with the number of products`, q10.q === q40.q && q10.q <= 12, JSON.stringify([q10.q, q40.q]));
  const oldCost = await count(async () => { for (const id of ids10) { await RD.getProductProfile({ productId: id }); await SG.stockGuardForProduct({ productId: id, storeId: STORE }); } });
  ok(`for reference: the old path needed ${oldCost.q} queries for the same 10 products (≈ ${Math.round(oldCost.q / 10)} per product); the batch needs ${q10.q}`, oldCost.q > q10.q * 8, `${oldCost.q} vs ${q10.q}`);

  console.log('\n3. The external Easy Orders catalogue is never awaited');
  PR.clearStoreCatalogCache(); let release; const gate = new Promise((r) => { release = r; }); let calls = 0; const slow = async () => { calls++; await gate; return { ok: true, products: [{ id: 'e1', name: 'something', price: 100 }], partial: false }; };
  const t0 = Date.now(); const first = PR.peekStoreCatalog(`${T}slow`, { fetcher: slow }); const ms = Date.now() - t0;
  ok('peek answers at once while the fetch is still running (ready = false, no index) and starts exactly ONE background fetch', ms < 100 && first.ready === false && first.index === null && calls === 1 && PR.peekStoreCatalog(`${T}slow`, { fetcher: slow }).ready === false && calls === 1, JSON.stringify([ms, first, calls]));
  release(); await new Promise((r) => setTimeout(r, 100)); const second = PR.peekStoreCatalog(`${T}slow`, { fetcher: slow });
  ok('after the fetch finished the cached copy is used (ready, index present) with no new fetch', second.ready === true && second.index instanceof Map && calls === 1);
  PR.clearStoreCatalogCache(); let fails = 0; const boom = async () => { fails++; throw new Error('EasyOrders down'); };
  PR.peekStoreCatalog(`${T}down`, { fetcher: boom }); await new Promise((r) => setTimeout(r, 60)); const a1 = PR.peekStoreCatalog(`${T}down`, { fetcher: boom }); const a2 = PR.peekStoreCatalog(`${T}down`, { fetcher: boom });
  ok('a store whose catalogue fails is treated as «not cross-checked» (ready, no index) and is NOT re-fetched on every request (one attempt in the 5-minute window)', a1.ready === true && a1.index === null && a2.ready === true && fails === 1, JSON.stringify([a1, a2, fails]));
  ok('a missing store id never fetches anything', PR.peekStoreCatalog(null).ready === true);

  console.log('\n4. The campaign list — queries, identical data, cache behaviour');
  const mkCamp = async (i, product) => { const cid = `${T}c${i}`; campaignIds.push(cid); await prisma.metaPerformanceSnapshot.createMany({ data: [0, 1, 2, 5, 9].map((d) => ({ sync_run_id: run.id, ad_account_id: AC, level: 'campaign', date_start: day(d), date_stop: day(d), campaign_id: cid, campaign_name: `camp ${i}`, campaign_status: 'ACTIVE', campaign_budget: 100, campaign_budget_type: 'DAILY', spend: 60 + i, meta_purchases: 1 + (i % 3), snapshot_at: new Date() })) }); if (product) { const amb = await prisma.ambProduct.findUnique({ where: { product_id: product.id } }) || await mkAmb(product.id); await prisma.ambProductCampaignMap.create({ data: { ad_account_id: AC, campaign_id: cid, amb_product_id: amb.id, status: 'MAPPED', match_source: 'MANUAL' } }); } };
  const run = await prisma.ambSyncRun.create({ data: { status: 'SUCCESS', ad_account_id: AC, finished_at: new Date() } }); created.push(run.id);
  const linked = [...Object.values(P), ...extra.slice(0, 18).map((id) => ({ id }))].slice(0, 28); for (let i = 0; i < 28; i++) await mkCamp(i, linked[i]); await mkCamp(100, null);
  const access = { ok: true, level: 'ADMIN', accounts: [AC], stores: null, capabilities: AX.CAPABILITIES.ADMIN }; await PR.clearStoreCatalogCache();
  CQ.__clearQueryCache(); const cold = await count(() => CQ.queryCampaigns({ access, body: { period: 'last7', pageSize: 50 } }));
  ok(`one cold list over 29 campaigns / 28 products: ${cold.q} queries (before the fix the same shape cost ≈ 16 per product, i.e. 450+) — and every row is there`, cold.r.total === 29 && cold.q < 110, JSON.stringify([cold.q, cold.r.total]));
  const rowsA = cold.r.rows.map((r) => ({ id: r.campaignId, stock: r.stock?.status, lim: r.limits, win: r.winner.status, profit: r.profit?.value ?? null, losing: r.losingDays })); const hitQ = await count(() => CQ.queryCampaigns({ access, body: { period: 'last7', pageSize: 50 } }));
  ok(`the next request inside the cache window costs ${hitQ.q} queries (served from the cache; provisional builds live only 5 s)`, hitQ.q <= 2 || cold.r.catalog.provisional, JSON.stringify([hitQ.q, cold.r.catalog]));
  CQ.__clearQueryCache(); const par = await count(() => Promise.all([CQ.queryCampaigns({ access, body: { period: 'last7', pageSize: 50 } }), CQ.queryCampaigns({ access, body: { period: 'last7', pageSize: 50 } }), CQ.queryCampaigns({ access, body: { period: 'last7', pageSize: 50 } })]));
  ok(`3 identical requests at the same moment share ONE build (${par.q} queries, not 3 × ${cold.q}) and get identical answers`, par.q <= cold.q + 8 && JSON.stringify(par.r[0].rows) === JSON.stringify(par.r[1].rows) && JSON.stringify(par.r[1].rows) === JSON.stringify(par.r[2].rows), JSON.stringify([par.q, cold.q]));
  CQ.__clearQueryCache(); const fresh = await CQ.queryCampaigns({ access, body: { period: 'last7', pageSize: 50 } }); const rowsB = fresh.rows.map((r) => ({ id: r.campaignId, stock: r.stock?.status, lim: r.limits, win: r.winner.status, profit: r.profit?.value ?? null, losing: r.losingDays }));
  ok('a rebuilt list is identical to the first one (stock, limits, Winner, profit, losing days per campaign)', JSON.stringify(rowsA) === JSON.stringify(rowsB));
  ok('the response says which data is provisional (Easy Orders catalogue not yet loaded) so the screen can warn', typeof cold.r.catalog === 'object' && Array.isArray(cold.r.catalog.pendingStores) && typeof cold.r.catalog.provisional === 'boolean');
  // the «latest row per campaign» is picked inside the database now — same answer as the old in-Node de-duplication
  { const OPC = await imp('../services/amb/operatorContext.js'); await prisma.metaPerformanceSnapshot.create({ data: { sync_run_id: run.id, ad_account_id: AC, level: 'campaign', date_start: day(0), date_stop: day(0), campaign_id: campaignIds[3], campaign_name: 'renamed later', campaign_status: 'PAUSED', campaign_budget: 222, campaign_budget_type: 'DAILY', spend: 1, snapshot_at: new Date(Date.now() + 1000) } }); await prisma.metaPerformanceSnapshot.create({ data: { sync_run_id: run.id, ad_account_id: AC, level: 'campaign', date_start: day(0), date_stop: day(0), campaign_id: campaignIds[4], campaign_name: 'null status later', campaign_status: null, spend: 1, snapshot_at: new Date(Date.now() + 2000) } });
    const oldL = await OPC.listCampaignsFromSnapshots({ adAccountId: AC, days: 90 }); const newL = await CQ.listCampaignsLatest({ adAccountId: AC, days: 90 }); const norm = (l) => JSON.stringify(l.map((c) => ({ ...c, lastSeenAt: new Date(c.lastSeenAt).getTime(), firstSeenAt: c.firstSeenAt ? new Date(c.firstSeenAt).getTime() : null })));
    ok(`the DB-side «latest row per campaign» equals the old Node-side de-duplication (${newL.length} campaigns; a later renamed / paused row wins; a later row with NULL status is ignored; first-seen day identical)`, norm(oldL) === norm(newL) && newL.find((c) => c.id === campaignIds[3]).status === 'PAUSED' && newL.find((c) => c.id === campaignIds[4]).name !== 'null status later', norm(oldL).slice(0, 200)); CQ.__clearQueryCache(); }
  { const ME = await imp('../services/amb/metricsEngine.js'); const ranges = { today: { from: day(0), to: day(0) }, d3: { from: day(2), to: day(0) }, d7: { from: day(6), to: day(0) }, d14: { from: day(13), to: day(0) }, prev: { from: day(13), to: day(7) } };
    const multi = await ME.entityWindowMetricsMulti({ level: 'campaign', adAccountId: AC, ranges }, { force: true }); let same = true; const bad = [];
    for (const [k, r] of Object.entries(ranges)) { const single = await ME.entityWindowMetrics({ level: 'campaign', from: r.from, to: r.to, adAccountId: AC }, { force: true }); const a = JSON.stringify([...single.entries()].sort()), b = JSON.stringify([...multi[k].entries()].sort()); if (a !== b) { same = false; bad.push(k); } }
    const qs = await count(() => ME.entityWindowMetricsMulti({ level: 'campaign', adAccountId: AC, ranges }, { force: true }));
    ok(`one read for ${Object.keys(ranges).length} windows (${qs.q} query) gives exactly what ${Object.keys(ranges).length} separate entityWindowMetrics calls gave, window by window`, same && qs.q === 1 && multi.today.size > 0, JSON.stringify([bad, qs.q])); }
  // stale decisions
  const cid = campaignIds[0]; await CQ.queryCampaigns({ access, body: { period: 'last7', pageSize: 50 } }); const dec = await prisma.ambOperatorDecision.create({ data: { decision_key: `${T}dk_${Date.now()}`, store_id: STORE, ad_account_id: AC, campaign_id: cid, campaign_name: cid, action: 'PAUSE', rule_name: 'AUTO:TEST', mode_at_decision: 'APPROVAL', status: 'PREPARED' } });
  const stale = (await CQ.queryCampaigns({ access, body: { period: 'last7', pageSize: 50 } })).rows.find((r) => r.campaignId === cid);
  ok('inside the cache window a brand-new decision is not shown yet (that is the cost of the cache)…', stale.pendingDecision === null);
  let threw = false; try { await BR.createBulkPlan({ user: { id: 1 }, access, body: { action: 'NOT_AN_ACTION' } }); } catch { threw = true; }
  const after = (await CQ.queryCampaigns({ access, body: { period: 'last7', pageSize: 50 } })).rows.find((r) => r.campaignId === cid);
  ok('…but ANY draft-creation attempt (even a refused one) clears the cache, so the list never keeps showing an old decision / plan / approval state', threw && after.pendingDecision?.id === dec.id);
  const nc = await CQ.queryCampaigns({ access, body: { period: 'last7', pageSize: 50 } }); ok('previews / snapshots / exports bypass the cache (noCache): the source check — buildRows is called with noCache from review, selection and export', true && (await import('node:fs')).readFileSync(join(__dirname, '..', 'services', 'amb', 'campaignReview.js'), 'utf8').includes('noCache: true') && nc.total === 29);
} finally {
  await prisma.ambOperatorDecision.deleteMany({ where: { campaign_id: { startsWith: T } } }); await prisma.ambProductCampaignMap.deleteMany({ where: { campaign_id: { startsWith: T } } }); await prisma.metaPerformanceSnapshot.deleteMany({ where: { ad_account_id: AC } }); await prisma.ambSyncRun.deleteMany({ where: { ad_account_id: AC } });
  await prisma.ambOperatorProductConfig.deleteMany({ where: { store_id: STORE } }); await prisma.inventorySnapshot.deleteMany({ where: { product_id: { in: productIds } } }); await prisma.ambProduct.deleteMany({ where: { product_id: { in: productIds } } }); await prisma.product.deleteMany({ where: { store_id: STORE } });
  if (cfg0) await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: savedLimits } }); await prisma.$disconnect();
}
console.log(`\n${pass} passed, ${fail} failed`); setTimeout(() => process.exit(fail ? 1 : 0), 50);
void created;
