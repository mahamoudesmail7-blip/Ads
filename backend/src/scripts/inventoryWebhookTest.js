// 📦 Inventory webhook + API feed acceptance. LOCAL, disposable fixtures ("__optest_" products / stores / snapshots) — NO production stock write, NO Meta call.
// The only real product touched is #424 and ONLY through ?dryRun=1 (asserted: nothing changes).
//   node src/scripts/inventoryWebhookTest.js
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const retryDb = async (fn) => { for (let i = 0; i < 10; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 4000)); } } return fn(); };
if (!process.env.JWT_SECRET) { console.log('JWT_SECRET missing'); process.exit(2); }

const { prisma } = await imp('../prisma.js');
const API = await imp('../services/amb/inventoryApi.js');
const REC = await imp('../services/amb/inventoryReconcile.js');
const SG = await imp('../services/amb/stockGuard.js');
const S = await imp('../services/amb/operatorStore.js');
const G = await imp('../services/amb/operatorGuards.js');
const { createInventoryWebhookRouter } = await imp('../routes/inventoryWebhook.js');
const { default: operatorRoutes } = await imp('../routes/operator.js');
const { errorHandler } = await imp('../middleware/errorHandler.js');

const T = '__optest_';
const t0 = new Date();
const SECRET = `${T}whsec_${crypto.randomBytes(12).toString('hex')}`; // test-only, never a real secret
const origEnv = { s: process.env.INVENTORY_WEBHOOK_SECRET, m: process.env.INVENTORY_WEBHOOK_AUTH_MODE, t: process.env.INVENTORY_WEBHOOK_EVENT_TYPES };
process.env.INVENTORY_WEBHOOK_SECRET = SECRET; delete process.env.INVENTORY_WEBHOOK_AUTH_MODE; delete process.env.INVENTORY_WEBHOOK_EVENT_TYPES;
const created = { products: [], users: [] };
const origCfg = await S.getOperatorConfig();
const origLimits = JSON.parse(JSON.stringify(origCfg.limits));
const counts0 = { recs: await prisma.ambRecommendation.count(), actions: await prisma.ambAction.count(), products: await prisma.product.count() };
const p424 = await prisma.product.findUnique({ where: { id: 424 }, select: { current_stock: true, minimum_stock: true } });
const api424Before = await prisma.inventorySnapshot.count({ where: { product_id: 424, source: { startsWith: 'INVENTORY_API' } } });

const logCalls = [];
const spyLogger = { info: (m, f) => logCalls.push(['info', m, f]), warn: (m, f) => logCalls.push(['warn', m, f]), error: (m, f) => logCalls.push(['error', m, f]) };
const mkApp = (overrides = {}) => { const app = express(); app.use(cookieParser()); app.use('/api/webhooks/inventory', createInventoryWebhookRouter({ logger: spyLogger, ...overrides })); app.use(express.json()); app.use('/api/operator', operatorRoutes); app.use(errorHandler); return app; };
const listen = (app) => new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const hmac = (raw, ts, secret = SECRET) => crypto.createHmac('sha256', secret).update(ts ? `${ts}.${raw}` : raw).digest('hex');
let base = '';
const post = async (body, { headers = {}, query = '', sign = true, ts = null, raw = null } = {}) => {
  const text = raw ?? JSON.stringify(body);
  const h = { 'Content-Type': 'application/json', ...headers };
  if (sign === true) { if (ts) h['x-inventory-timestamp'] = String(ts); h['x-inventory-signature'] = `sha256=${hmac(text, ts)}`; }
  else if (sign === 'secret') h['x-inventory-secret'] = SECRET;
  const r = await fetch(`${base}/api/webhooks/inventory${query}`, { method: 'POST', headers: h, body: text });
  const t = await r.text(); let json = null; try { json = JSON.parse(t); } catch { /* */ }
  return { status: r.status, json, text: t };
};
const evt = (items, o = {}) => ({ event_id: `${T}evt_${Math.random().toString(36).slice(2, 10)}`, event_type: 'stock.updated', occurred_at: new Date().toISOString(), items, ...o });
const mkProduct = async (store, name, extra = {}) => { const p = await prisma.product.create({ data: { product_name: `${T}${name}`, product_code: `${T}${name}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, store_id: store, selling_price: 0, product_cost: 0, ...extra } }); created.products.push(p.id); return p; };
const snaps = (pid) => prisma.inventorySnapshot.findMany({ where: { product_id: pid, source: { startsWith: 'INVENTORY_API' } } });
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
let server;

try {
  const pA = await mkProduct(`${T}storeA`, 'منتج أ', { sku: `${T}SKU-1`, current_stock: 50, minimum_stock: 10 });
  const pB = await mkProduct(`${T}storeB`, 'منتج ب', { sku: `${T}SKU-1` });
  const pC = await mkProduct(`${T}storeA`, 'منتج ج', { easy_orders_uuid: `${T}uuid-c` });
  const pD = await mkProduct(`${T}storeA`, 'منتج د اسم فقط');
  server = await listen(mkApp()); base = `http://127.0.0.1:${server.address().port}`;

  // ===================================================================================================================
  console.log('\n1. authentication / replay / size / schema (no stock is touched)');
  let r = await post(evt([{ sku: `${T}SKU-1`, store_id: `${T}storeA`, current_stock: 5 }]), { sign: false });
  ok('no credentials => 401, nothing written', r.status === 401 && (await snaps(pA.id)).length === 0);
  r = await post(evt([{ sku: `${T}SKU-1`, current_stock: 5 }]), { headers: { 'x-inventory-signature': 'sha256=' + 'a'.repeat(64) }, sign: false });
  ok('wrong HMAC signature => 401 (a present-but-wrong signature is never downgraded to the secret path)', r.status === 401 && r.json.reason === 'INVALID_SIGNATURE');
  r = await post(evt([{ sku: `${T}SKU-1`, current_stock: 5 }]), { headers: { 'x-inventory-secret': 'nope' }, sign: false });
  ok('wrong shared secret => 401', r.status === 401 && r.json.reason === 'INVALID_SECRET');
  const oldTs = Math.floor((Date.now() - 20 * 60_000) / 1000);
  r = await post(evt([{ sku: `${T}SKU-1`, current_stock: 5 }]), { ts: oldTs });
  ok('valid signature but a 20-minute-old timestamp => 401 (replay protection)', r.status === 401 && r.json.reason === 'TIMESTAMP_OUT_OF_TOLERANCE');
  r = await post(evt([{ sku: `${T}SKU-1`, store_id: `${T}storeA`, current_stock: 5 }]), { ts: Math.floor(Date.now() / 1000), query: '?dryRun=1' });
  ok('valid HMAC with a fresh timestamp => 200 and replayProtected', r.status === 200 && r.json.ok && r.json.replayProtected === true);
  r = await post(evt([{ sku: `${T}SKU-1`, store_id: `${T}storeA`, current_stock: 5 }]), { sign: 'secret', query: '?dryRun=1' });
  ok('valid shared-secret header => 200 (replayProtected false)', r.status === 200 && r.json.replayProtected === false);
  delete process.env.INVENTORY_WEBHOOK_SECRET;
  r = await post(evt([{ sku: 'x', current_stock: 1 }]), { sign: false });
  ok('no secret configured on the server => 503 (it never accepts)', r.status === 503 && r.json.error === 'WEBHOOK_NOT_CONFIGURED');
  process.env.INVENTORY_WEBHOOK_SECRET = SECRET;
  r = await post(null, { raw: '{not json', sign: true });
  ok('invalid JSON (valid signature) => 400', r.status === 400 && r.json.error === 'INVALID_JSON');
  r = await post(null, { raw: 'x'.repeat(300 * 1024), sign: true });
  ok('300 KB body => 413', r.status === 413, r.status);
  r = await post({ event_type: 'stock.updated', items: [] });
  ok('empty items => 400', r.status === 400 && r.json.error === 'INVALID_PAYLOAD');
  r = await post({ items: [{ sku: 'a', current_stock: 1 }] });
  ok('missing event type => 400', r.status === 400);
  r = await post(evt(Array.from({ length: 201 }, (_, i) => ({ sku: `s${i}`, current_stock: 1 }))));
  ok('201 items => 413 (max 200)', r.status === 413);
  r = await post(evt([{ sku: 'a', current_stock: 1 }], { event_type: 'order.created' }));
  ok('an unsupported event type is acknowledged and IGNORED (no retry storm, no write)', r.status === 200 && r.json.ignored === true);
  for (const t of ['inventory.updated', 'product.updated']) { r = await post(evt([{ sku: `${T}SKU-1`, store_id: `${T}storeA`, current_stock: 5 }], { event_type: t }), { query: '?dryRun=1' }); ok(`${t} is supported`, r.status === 200 && !r.json.ignored); }
  process.env.INVENTORY_WEBHOOK_EVENT_TYPES = 'custom.stock';
  r = await post(evt([{ sku: 'a', current_stock: 1 }], { event_type: 'stock.updated' }));
  ok('INVENTORY_WEBHOOK_EVENT_TYPES overrides the allow-list (names are not hard-coded)', r.json.ignored === true);
  r = await post(evt([{ sku: `${T}SKU-1`, store_id: `${T}storeA`, current_stock: 5 }], { event_type: 'custom.stock' }), { query: '?dryRun=1' });
  ok('...and the configured name is accepted', r.status === 200 && !r.json.ignored);
  delete process.env.INVENTORY_WEBHOOK_EVENT_TYPES;
  r = await post(evt([{ sku: `${T}SKU-1`, store_id: `${T}storeA`, current_stock: -3 }, { sku: `${T}SKU-1`, store_id: `${T}storeA` }, { current_stock: 4 }, { sku: `${T}SKU-1`, current_stock: 'abc' }]), { query: '?dryRun=1' });
  ok('items with negative / missing / no identity / non-numeric stock are INVALID_ITEM', r.json.counts.INVALID_ITEM === 4, JSON.stringify(r.json.counts));
  ok('nothing was written by all of the above', (await snaps(pA.id)).length === 0 && (await snaps(pB.id)).length === 0);

  // ===================================================================================================================
  console.log('\n2. product matching — store isolation, evidence order, name never VERIFIED, nothing auto-created');
  r = await post(evt([{ sku: `${T}sku-1`, current_stock: 5 }]), { query: '?dryRun=1' });
  ok('same SKU in two stores with no store hint => CONFLICT (never merged, never guessed)', r.json.results[0].status === 'CONFLICT' && r.json.results[0].candidates.length === 2);
  r = await post(evt([{ sku: `${T}SKU-1`, store_id: `${T}storeA`, current_stock: 5 }]), { query: '?dryRun=1' });
  ok('with the store hint => VERIFIED via SKU, product A only', r.json.results[0].match === 'VERIFIED' && r.json.results[0].via === 'SKU' && r.json.results[0].productId === pA.id);
  r = await post(evt([{ sku: `${T}SKU-1`, store_id: `${T}storeZ`, current_stock: 5 }]), { query: '?dryRun=1' });
  ok('a store hint that matches no product => UNMAPPED (no cross-store fallback)', r.json.results[0].status === 'UNMAPPED');
  r = await post(evt([{ easy_orders_uuid: `${T}uuid-c`, current_stock: 5 }]), { query: '?dryRun=1' });
  ok('Easy Orders UUID => VERIFIED', r.json.results[0].match === 'VERIFIED' && r.json.results[0].via === 'EASY_ORDERS_UUID' && r.json.results[0].productId === pC.id);
  r = await post(evt([{ external_product_id: `${T}uuid-c`, current_stock: 5 }]), { query: '?dryRun=1' });
  ok('external product id equal to an Easy Orders UUID => VERIFIED', r.json.results[0].match === 'VERIFIED' && r.json.results[0].productId === pC.id);
  r = await post(evt([{ name: `${T}منتج د اسم فقط`, current_stock: 5 }]), { query: '?dryRun=1' });
  ok('name only => SUGGESTED (never VERIFIED, never applied)', r.json.results[0].status === 'SUGGESTED' && r.json.results[0].candidates[0].productId === pD.id);
  const nameLink = await post(evt([{ name: `${T}منتج د اسم فقط`, current_stock: 5 }]));
  ok('...and a real (non dry-run) SUGGESTED event changes no stock', nameLink.json.results[0].status === 'SUGGESTED' && (await snaps(pD.id)).length === 0);
  const unk = evt([{ sku: `${T}NOPE-404`, name: `${T}no such product`, current_stock: 9 }]);
  const before = await prisma.product.count();
  r = await post(unk); await post({ ...unk, event_id: `${T}evt_again` });
  ok('unknown product => UNMAPPED, NO product is created', r.json.results[0].status === 'UNMAPPED' && (await prisma.product.count()) === before);
  const logs = await prisma.aiAuditLog.findMany({ where: { kind: 'INVENTORY_WEBHOOK_UNMAPPED', created_at: { gte: t0 }, input_json: { contains: 'NOPE-404' } } });
  ok('the unresolved item is logged for review once (deduped for 24h)', logs.length === 1 && logs[0].error === 'UNMAPPED' && !JSON.stringify(logs).includes(SECRET));
  const pcode = (await prisma.product.findUnique({ where: { id: pA.id } })).product_code;
  await S.getOperatorConfig();
  await API.setInventoryLink({ kind: 'ext', value: 'EXT-999', productId: pD.id });
  await API.setInventoryLink({ kind: 'barcode', value: '6221234567890', productId: pC.id });
  await API.setInventoryLink({ kind: 'sku', value: `${T}SKU-1`, productId: pA.id });
  r = await post(evt([{ external_product_id: 'EXT-999', name: 'whatever', current_stock: 5 }]), { query: '?dryRun=1' });
  ok('explicit mapping on the external id => VERIFIED via EXPLICIT', r.json.results[0].match === 'VERIFIED' && r.json.results[0].via === 'EXPLICIT' && r.json.results[0].productId === pD.id);
  r = await post(evt([{ barcode: '6221234567890', current_stock: 5 }]), { query: '?dryRun=1' });
  ok('barcode resolves ONLY through an explicit link (Product has no barcode column)', r.json.results[0].via === 'EXPLICIT' && r.json.results[0].productId === pC.id);
  r = await post(evt([{ barcode: '0000000000000', current_stock: 5 }]), { query: '?dryRun=1' });
  ok('an unlinked barcode is UNMAPPED', r.json.results[0].status === 'UNMAPPED');
  r = await post(evt([{ sku: `${T}SKU-1`, current_stock: 5 }]), { query: '?dryRun=1' });
  ok('explicit link beats the ambiguous SKU (no store hint needed)', r.json.results[0].match === 'VERIFIED' && r.json.results[0].via === 'EXPLICIT' && r.json.results[0].productId === pA.id);
  r = await post(evt([{ sku: `${T}SKU-1`, store_id: `${T}storeB`, current_stock: 5 }]), { query: '?dryRun=1' });
  ok('explicit link + a conflicting store hint => CONFLICT (never crosses stores)', r.json.results[0].status === 'CONFLICT');
  await API.removeInventoryLink({ kind: 'sku', value: `${T}SKU-1` });
  r = await post(evt([{ sku: `${T}SKU-1`, current_stock: 5 }]), { query: '?dryRun=1' });
  ok('removing the link restores the CONFLICT', r.json.results[0].status === 'CONFLICT');
  void pcode;

  // ===================================================================================================================
  console.log('\n3. applying a verified update into InventorySnapshot');
  const t1 = iso(60_000);
  r = await post(evt([{ sku: `${T}SKU-1`, store_id: `${T}storeA`, current_stock: 100, reserved: 30, minimum_stock: 7, warehouse: undefined, updated_at: t1 }], { event_id: `${T}e1`, occurred_at: t1 }));
  let rows = await snaps(pA.id);
  const n1 = JSON.parse(rows[0]?.notes || '{}');
  ok('APPLIED: one snapshot, source INVENTORY_API/WEBHOOK, closing_stock = AVAILABLE (100 − 30 = 70)', r.json.results[0].status === 'APPLIED' && rows.length === 1 && rows[0].source === 'INVENTORY_API/WEBHOOK' && rows[0].closing_stock === 70, JSON.stringify(r.json.results[0]));
  ok('notes carry current / reserved / available / minimum / sku / lastSyncAt / event id', n1.totals.current === 100 && n1.totals.reserved === 30 && n1.totals.available === 70 && n1.minimumStock === 7 && n1.sku === `${T}SKU-1` && !!n1.lastSyncAt && n1.warehouses['*'].eventIds[0] === `${T}e1`);
  ok('the catalogue/manual stock (50) is untouched and no Product / AMB row was written', (await prisma.product.findUnique({ where: { id: pA.id } })).current_stock === 50);
  r = await post(evt([{ sku: `${T}SKU-1`, store_id: `${T}storeA`, available: 40, updated_at: iso(30_000) }], { event_id: `${T}e1b`, occurred_at: iso(30_000) }));
  rows = await snaps(pA.id);
  ok('only "available" given => current derived from it, reserved unknown flagged', r.json.results[0].status === 'APPLIED' && rows.length === 1 && rows[0].closing_stock === 40 && JSON.parse(rows[0].notes).warehouses['*'].reserved === null);

  // ===================================================================================================================
  console.log('\n4. idempotency + out-of-order protection');
  const e2 = evt([{ sku: `${T}SKU-1`, store_id: `${T}storeA`, current_stock: 25, reserved: 5, updated_at: iso(10_000) }], { event_id: `${T}e2`, occurred_at: iso(10_000) });
  r = await post(e2); ok('a newer event is APPLIED (available 20)', r.json.results[0].status === 'APPLIED' && (await snaps(pA.id))[0].closing_stock === 20);
  r = await post(e2); ok('the SAME event delivered twice => DUPLICATE, stock not doubled / changed', r.json.results[0].status === 'DUPLICATE' && (await snaps(pA.id)).length === 1 && (await snaps(pA.id))[0].closing_stock === 20);
  r = await post({ ...e2, event_id: `${T}e2-retry` }); ok('a retried event with a NEW id but the same timestamp + numbers => DUPLICATE', r.json.results[0].status === 'DUPLICATE' && (await snaps(pA.id))[0].closing_stock === 20);
  r = await post(evt([{ sku: `${T}SKU-1`, store_id: `${T}storeA`, current_stock: 999, updated_at: iso(5 * 60_000) }], { event_id: `${T}e-old`, occurred_at: iso(5 * 60_000) }));
  ok('an OLDER update arriving late => STALE_EVENT, stock never goes backwards', r.json.results[0].status === 'STALE_EVENT' && (await snaps(pA.id))[0].closing_stock === 20);
  const pV = await mkProduct(`${T}storeA`, 'منتج نسخة', { sku: `${T}SKU-V` });
  r = await post(evt([{ sku: `${T}SKU-V`, store_id: `${T}storeA`, current_stock: 10 }], { version: 5, occurred_at: undefined }));
  ok('version-based: v5 applied', r.json.results[0].status === 'APPLIED');
  r = await post(evt([{ sku: `${T}SKU-V`, store_id: `${T}storeA`, current_stock: 99 }], { version: 4, occurred_at: undefined }));
  ok('version-based: v4 after v5 => STALE_EVENT', r.json.results[0].status === 'STALE_EVENT' && (await snaps(pV.id))[0].closing_stock === 10);
  r = await post(evt([{ sku: `${T}SKU-V`, store_id: `${T}storeA`, current_stock: 11 }], { version: 6, occurred_at: undefined }));
  ok('version-based: v6 => APPLIED', r.json.results[0].status === 'APPLIED' && (await snaps(pV.id))[0].closing_stock === 11);
  const burst = await Promise.all([1, 2, 3, 4].map((i) => post(evt([{ sku: `${T}SKU-V`, store_id: `${T}storeA`, current_stock: 100 + i }], { version: 10 + i, occurred_at: undefined }))));
  ok('4 concurrent updates for one product serialise: highest version wins, one row', (await snaps(pV.id)).length === 1 && (await snaps(pV.id))[0].closing_stock === 104 && burst.every((b) => b.status === 200));

  // ===================================================================================================================
  console.log('\n5. warehouses (aggregated per product, each ordered on its own)');
  const w1 = iso(40_000), w2 = iso(30_000);
  await post(evt([{ easy_orders_uuid: `${T}uuid-c`, current_stock: 5, warehouse: 'W1', updated_at: w1 }], { occurred_at: w1 }));
  await post(evt([{ easy_orders_uuid: `${T}uuid-c`, current_stock: 7, reserved: 1, warehouse: 'W2', updated_at: w2 }], { occurred_at: w2 }));
  let rc = (await snaps(pC.id))[0];
  ok('two warehouses => total available 5 + 6 = 11, both stored', rc.closing_stock === 11 && Object.keys(JSON.parse(rc.notes).warehouses).sort().join() === 'W1,W2');
  r = await post(evt([{ easy_orders_uuid: `${T}uuid-c`, current_stock: 3, warehouse: 'W1', updated_at: iso(5_000) }], { occurred_at: iso(5_000) }));
  ok('W1 updated => total 3 + 6 = 9', r.json.results[0].status === 'APPLIED' && (await snaps(pC.id))[0].closing_stock === 9);
  r = await post(evt([{ easy_orders_uuid: `${T}uuid-c`, current_stock: 500, warehouse: 'W2', updated_at: iso(3_600_000) }], { occurred_at: iso(3_600_000) }));
  ok('an old W2 update is ignored without touching W1', r.json.results[0].status === 'STALE_EVENT' && (await snaps(pC.id))[0].closing_stock === 9);

  // ===================================================================================================================
  console.log('\n6. Stock Guard: the API is the official source ONLY after the owner approves; stale/error is UNKNOWN, never zero');
  let sg = await SG.stockGuardForProduct({ productId: pA.id, storeId: pA.store_id });
  ok('before approval: manual (50) stays authoritative; the API figure is only shown for comparison (apiShadow)', sg.source === 'CATALOG' && sg.currentStock === 50 && sg.apiShadow?.available === 20 && sg.apiShadow?.apiState === 'VERIFIED', JSON.stringify(sg));
  let bad = null; try { await API.setInventoryPrimary({ productId: pB.id, on: true }); } catch (e) { bad = e; }
  ok('approving a product with NO API data is refused (409)', bad && bad.status === 409);
  const cmp = await API.compareManualVsApi(pA.id);
  ok('the comparison shows manual 50 vs API 20 and the difference (−30)', cmp.manual === 50 && cmp.api.available === 20 && cmp.difference === -30 && cmp.primary === false);
  await API.setInventoryPrimary({ productId: pA.id, on: true });
  sg = await SG.stockGuardForProduct({ productId: pA.id, storeId: pA.store_id });
  ok('after approval: source INVENTORY_API, Available Stock 20, reserved/onHand/lastSync exposed, minimum stays the manual 10 (USER_CONFIGURED wins)', sg.source === 'INVENTORY_API' && sg.currentStock === 20 && sg.minimumStock === 10 && sg.onHand === 25 && sg.reserved === 5 && !!sg.lastSyncAt && sg.status === 'SAFE', JSON.stringify(sg));
  const ctxWith = (stock, status = 'PAUSED') => ({ storeId: `${T}storeA`, campaign: { id: 'c1', status, budget: 200, firstSeenAt: new Date(Date.now() - 200 * 3_600_000).toISOString() }, metrics: { spend: 600, purchases: 10 }, product: { id: pA.id, mappingVerified: true }, dq: { gate: 'OK', overall: 'RECONCILED', statusTrust: { state: 'OK' } }, stock, econ: { complete: true, profitState: 'PROFITABLE', hardStopCpa: 200 }, exceptions: [], recent: { lastByAction: {}, todayCount: 0 }, metaConnected: true, metaStale: false, advisor: { scalePlanPresent: true, stage: 'SCALE' }, incidents: [] });
  const cfg0 = { mode: 'SHADOW', emergency_stop: false, limits: JSON.parse(JSON.stringify(S.DEFAULT_LIMITS)), cooldowns: { ...S.DEFAULT_COOLDOWNS }, schedule: { mode: 'ALWAYS' } };
  const gd = (action, stock) => G.evaluateGuards({ decision: { action, params: { pct: 10, fromBudget: 200, toBudget: 220 }, ruleMode: 'SHADOW', confidence: 'HIGH', needs: { stock: true, profit: true } }, ctx: ctxWith(stock, action === 'OPEN' ? 'PAUSED' : 'ACTIVE'), config: cfg0, settings: { ambMinSpendBeforeDecision: 150, ambMinPurchasesBeforeScaling: 5 }, now: new Date() }).blocks.map((b) => b.code);
  ok('healthy API stock does NOT block (the remaining guards decide — a good stock never means "scale")', !gd('OPEN', sg).some((c) => c.startsWith('STOCK')) && !gd('SCALE_UP', sg).some((c) => c.startsWith('STOCK')));
  // available 0
  const tz = iso(1_000);
  await post(evt([{ sku: `${T}SKU-1`, store_id: `${T}storeA`, current_stock: 4, reserved: 4, updated_at: tz }], { occurred_at: tz }));
  sg = await SG.stockGuardForProduct({ productId: pA.id, storeId: pA.store_id });
  ok('Available = 0 (4 on hand, 4 reserved) => OUT_OF_STOCK: OPEN and SCALE blocked', sg.currentStock === 0 && sg.status === 'OUT_OF_STOCK' && gd('OPEN', sg).includes('STOCK_OUT') && gd('SCALE_UP', sg).includes('STOCK_OUT'), JSON.stringify(gd('SCALE_UP', sg)));
  const tm = iso(500);
  await post(evt([{ sku: `${T}SKU-1`, store_id: `${T}storeA`, current_stock: 10, reserved: 0, updated_at: tm }], { occurred_at: tm }));
  sg = await SG.stockGuardForProduct({ productId: pA.id, storeId: pA.store_id });
  ok('Available (10) <= Minimum (10) => LOW: SCALE blocked (and OPEN)', sg.status === 'LOW' && gd('SCALE_UP', sg).includes('STOCK_TOO_LOW') && gd('OPEN', sg).includes('STOCK_TOO_LOW'));
  // stale
  const row = (await snaps(pA.id))[0]; const nn = JSON.parse(row.notes); nn.lastSyncAt = new Date(Date.now() - 100 * 3_600_000).toISOString();
  await prisma.inventorySnapshot.update({ where: { id: row.id }, data: { notes: JSON.stringify(nn) } });
  sg = await SG.stockGuardForProduct({ productId: pA.id, storeId: pA.store_id });
  ok('approved but 100h old => STALE: current is UNKNOWN (null), NOT 0 and NOT the manual 50 → OPEN/SCALE blocked as STOCK_UNKNOWN', sg.apiState === 'STALE' && sg.currentStock === null && sg.status === 'STOCK_UNKNOWN' && sg.staleValue === 10 && sg.source === 'INVENTORY_API_STALE' && gd('SCALE_UP', sg).includes('STOCK_UNKNOWN'), JSON.stringify(sg));
  const st = API.apiStateOf({ snapshot: { row: { updated_at: new Date() }, state: { lastSyncAt: new Date(Date.now() - 100 * 3_600_000).toISOString() } }, lastReconcile: { ok: false, at: Date.now() } });
  ok('stale + the last reconciliation failed => API_ERROR state (still not zero)', st.state === 'API_ERROR');
  ok('no data + failed reconcile => API_ERROR; no data + no reconcile => UNKNOWN', API.apiStateOf({ snapshot: null, lastReconcile: { ok: false, at: 1 } }).state === 'API_ERROR' && API.apiStateOf({ snapshot: null }).state === 'UNKNOWN');
  await API.setInventoryPrimary({ productId: pA.id, on: false });
  sg = await SG.stockGuardForProduct({ productId: pA.id, storeId: pA.store_id });
  ok('approval removed => manual (50) is the fallback again', sg.source === 'CATALOG' && sg.currentStock === 50);
  const mp = await API.inventoryStateMap([pA.id, pB.id]);
  ok('state map: A has API data, B (never received) is UNKNOWN', mp.get(pA.id).state === 'STALE' && mp.get(pB.id).state === 'UNKNOWN');
  const eff = API.effectiveStock({ manual: 50, api: { primary: false, state: 'VERIFIED', available: 20 } });
  ok('effectiveStock (readiness/grid): unapproved API never replaces the manual number; approved+stale is null, not 0', eff.value === 50 && API.effectiveStock({ manual: 50, api: { primary: true, state: 'STALE', available: 20 } }).value === null && API.effectiveStock({ manual: 50, api: { primary: true, state: 'VERIFIED', available: 0 } }).value === 0);

  // ===================================================================================================================
  console.log('\n7. Hair Cap #424 — dry-run with a TEST payload only (no stock write, 2000 untouched)');
  r = await post(evt([{ easy_orders_uuid: '87163ecd-4260-498f-86ff-a07156a56f96', store_id: 'trendy-storeee', current_stock: 1234, reserved: 34, updated_at: new Date().toISOString() }], { event_id: `${T}hair-cap-test` }), { query: '?dryRun=1' });
  ok('#424 resolves VERIFIED via the Easy Orders UUID inside trendy-storeee', r.json.results[0].match === 'VERIFIED' && r.json.results[0].productId === 424 && r.json.results[0].store === 'trendy-storeee' && r.json.results[0].via === 'EASY_ORDERS_UUID', JSON.stringify(r.json.results[0]));
  ok('dry-run reports the outcome (WOULD_APPLY, available 1200) and writes nothing', r.json.dryRun === true && r.json.results[0].status === 'WOULD_APPLY' && r.json.results[0].after.available === 1200);
  r = await post(evt([{ easy_orders_uuid: '87163ecd-4260-498f-86ff-a07156a56f96', store_id: 'default', current_stock: 1 }]), { query: '?dryRun=1' });
  ok('the same UUID with the WRONG store hint is not matched (store isolation)', r.json.results[0].status === 'UNMAPPED');
  const p424After = await prisma.product.findUnique({ where: { id: 424 }, select: { current_stock: true, minimum_stock: true } });
  ok('Manual Stock of #424 is still 2000 / minimum 600 and it has no API snapshot', p424After.current_stock === p424.current_stock && p424After.current_stock === 2000 && p424After.minimum_stock === p424.minimum_stock && (await prisma.inventorySnapshot.count({ where: { product_id: 424, source: { startsWith: 'INVENTORY_API' } } })) === api424Before);

  // ===================================================================================================================
  console.log('\n8. reconciliation (injected fetcher — no real API, no URL)');
  let rec = await REC.runInventoryReconcile();
  ok('with no provider configured => NOT_CONFIGURED, no network call', rec.skipped === 'NOT_CONFIGURED');
  const pR = await mkProduct(`${T}storeA`, 'منتج مطابقة', { sku: `${T}SKU-R`, current_stock: 8 });
  rec = await REC.runInventoryReconcile({ fetchAll: async () => [{ sku: `${T}SKU-R`, store_id: `${T}storeA`, current_stock: 33, reserved: 3 }, { sku: `${T}NOPE-R`, current_stock: 1 }, { sku: `${T}SKU-R`, store_id: `${T}storeA`, current_stock: -1 }] });
  ok('reconcile applies the verified item (available 30), reports the unmapped one and the invalid one', rec.ok && rec.counts.APPLIED === 1 && rec.counts.UNMAPPED === 1 && rec.counts.INVALID_ITEM === 1 && (await snaps(pR.id))[0].closing_stock === 30 && (await snaps(pR.id))[0].source === 'INVENTORY_API/RECONCILE', JSON.stringify(rec));
  const before2 = (await snaps(pR.id))[0].closing_stock;
  rec = await REC.runInventoryReconcile({ fetchAll: async () => { const e = new Error('boom'); e.status = 502; throw e; }, deps: { retry: { attempts: 2, baseMs: 1, sleepFn: async () => {} } } });
  ok('an API failure => API_ERROR, stock UNCHANGED (never zero), failure audited', rec.ok === false && rec.state === 'API_ERROR' && rec.stockChanged === false && (await snaps(pR.id))[0].closing_stock === before2 && (await API.lastReconcileResult()).ok === false);
  let attempts = 0;
  rec = await REC.runInventoryReconcile({ fetchAll: async () => { attempts++; if (attempts < 3) { const e = new Error('503'); e.status = 503; throw e; } return [{ sku: `${T}SKU-R`, store_id: `${T}storeA`, current_stock: 40 }]; }, deps: { retry: { attempts: 3, baseMs: 1, sleepFn: async () => {} } } });
  ok('retry with backoff: two 503s then success => applied on attempt 3', rec.ok && attempts === 3 && (await snaps(pR.id))[0].closing_stock === 40 && (await API.lastReconcileResult()).ok === true);
  attempts = 0;
  rec = await REC.runInventoryReconcile({ fetchAll: async () => { attempts++; const e = new Error('401'); e.status = 401; throw e; }, deps: { retry: { attempts: 3, baseMs: 1, sleepFn: async () => {} } } });
  ok('a 401 is not retried (it will not fix itself)', rec.ok === false && attempts === 1);
  rec = await REC.runInventoryReconcile({ fetchAll: () => new Promise(() => {}), deps: { retry: { attempts: 1, timeoutMs: 30 } } });
  ok('a hung API times out instead of blocking the job', rec.ok === false && /TIMEOUT/.test(rec.error));
  const slow = REC.runInventoryReconcile({ fetchAll: () => new Promise((res) => setTimeout(() => res([]), 150)) });
  await new Promise((res) => setTimeout(res, 20));
  const overlap = await REC.runInventoryReconcile({ fetchAll: async () => [] });
  await slow;
  ok('no overlap: a second run while one is in progress is refused', overlap.skipped === 'ALREADY_RUNNING' && REC.isReconcileRunning() === false);
  const row2 = (await snaps(pR.id))[0]; const nn2 = JSON.parse(row2.notes); nn2.lastSyncAt = new Date(Date.now() - 90 * 3_600_000).toISOString();
  await prisma.inventorySnapshot.update({ where: { id: row2.id }, data: { notes: JSON.stringify(nn2) } });
  const old = new Date(Date.now() - 3_600_000);
  rec = await REC.runInventoryReconcile({ now: old, fetchAll: async () => [{ sku: `${T}SKU-R`, store_id: `${T}storeA`, current_stock: 40 }] });
  const nn3 = JSON.parse((await snaps(pR.id))[0].notes);
  ok('an older reconcile that confirms the SAME number refreshes freshness only (stock unchanged, still not rolled back)', (await snaps(pR.id))[0].closing_stock === 40 && Math.abs(Date.parse(nn3.lastSyncAt) - old.getTime()) < 1000 && rec.counts.STALE_EVENT === 1, JSON.stringify(nn3.lastSyncAt) + ' ' + JSON.stringify(rec));

  // ===================================================================================================================
  console.log('\n9. owner routes (ADMIN) + safety');
  const mkUser = async (role, tag) => { const u = await prisma.user.create({ data: { email: `${T}inv_${tag}_${Date.now()}@example.invalid`, password_hash: 'x'.repeat(20), name: `${T}${tag}`, role, status: 'ACTIVE', permissions: '{}' } }); created.users.push(u.id); return { user: u, token: jwt.sign({ id: u.id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' }) }; };
  const admin = await mkUser('ADMIN', 'admin'), mgr = await mkUser('MANAGER', 'mgr');
  const call = async (method, path, body, token) => { const x = await fetch(`${base}/api/operator${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Cookie: `token=${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); let json = null; try { json = await x.json(); } catch { /* */ } return { status: x.status, json }; };
  let c = await call('GET', '/inventory', undefined, mgr.token);
  ok('MANAGER can read the inventory status (feed configured, products with API data, unresolved list) without any secret value', c.status === 200 && c.json.configured.webhookSecret === true && c.json.counts.productsWithApiData >= 1 && Array.isArray(c.json.unresolved) && !JSON.stringify(c.json).includes(SECRET));
  c = await call('PUT', `/inventory/products/${pA.id}/primary`, { on: true }, mgr.token);
  ok('MANAGER cannot approve a source (403)', c.status === 403);
  c = await call('POST', '/inventory/links', { kind: 'ext', value: 'EXT-ROUTE', productId: pC.id }, mgr.token);
  ok('MANAGER cannot create a mapping (403)', c.status === 403);
  c = await call('POST', '/inventory/links', { kind: 'ext', value: 'EXT-ROUTE', productId: pC.id }, admin.token);
  ok('ADMIN creates an explicit mapping (who/when stored)', c.status === 200 && (await API.loadInventoryLinks())['ext:ext-route'].productId === pC.id);
  c = await call('DELETE', '/inventory/links', { kind: 'ext', value: 'EXT-ROUTE' }, admin.token);
  ok('ADMIN removes it', c.status === 200 && !(await API.loadInventoryLinks())['ext:ext-route']);
  c = await call('POST', '/inventory/links', { kind: 'foo', value: 'x', productId: pC.id }, admin.token);
  ok('bad link kind => 400', c.status === 400);
  c = await call('PUT', `/inventory/products/${pB.id}/primary`, { on: true }, admin.token);
  ok('approving without verified API data => 409', c.status === 409);
  c = await call('POST', '/inventory/reconcile', {}, admin.token);
  ok('POST /inventory/reconcile => NOT_CONFIGURED (no provider known)', c.status === 200 && c.json.skipped === 'NOT_CONFIGURED');
  const srcTxt = fs.readFileSync(join(__dirname, '../services/amb/inventoryApi.js'), 'utf8') + fs.readFileSync(join(__dirname, '../routes/inventoryWebhook.js'), 'utf8') + fs.readFileSync(join(__dirname, '../services/amb/inventoryReconcile.js'), 'utf8');
  const importLines = srcTxt.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l) || /await import\(/.test(l)).join(' | ');
  ok('the inventory modules import no executor / Meta client (a stock update cannot cause a Meta write)', !/executor|metaGraphClient|metaAuth|approveAndExecute|launchPublish/.test(importLines) && !/approveAndExecute\(/.test(srcTxt), importLines);
  const cfgNow = await S.getOperatorConfig();
  ok('safety: mode unchanged (SHADOW), write-lock closed, no recommendation/action created', cfgNow.mode === origCfg.mode && S.metaWritesLocked() === true && (await prisma.ambRecommendation.count()) === counts0.recs && (await prisma.ambAction.count()) === counts0.actions);
  const leaked = JSON.stringify(logCalls).includes(SECRET) || logCalls.some(([, , f]) => JSON.stringify(f || {}).includes(SECRET));
  ok('the secret never appears in any log line (only header PRESENCE is logged)', !leaked && logCalls.some(([l, m]) => l === 'warn' && /REJECTED/.test(m)));
  server.close();

  // ===================================================================================================================
  console.log('\n10. rate limiting');
  const app2 = mkApp(); const s2 = await listen(app2); const b2 = `http://127.0.0.1:${s2.address().port}`;
  let limited = 0; for (let i = 0; i < 130; i++) { const x = await fetch(`${b2}/api/webhooks/inventory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (x.status === 429) limited++; }
  ok('more than 120 requests/minute => 429', limited > 0, `limited=${limited}`);
  s2.close();
} catch (e) { fail++; console.log('  ✗ test crashed —', e.stack || e.message); }
finally {
  try {
    if (server) server.close();
    if (origEnv.s === undefined) delete process.env.INVENTORY_WEBHOOK_SECRET; else process.env.INVENTORY_WEBHOOK_SECRET = origEnv.s;
    if (origEnv.m !== undefined) process.env.INVENTORY_WEBHOOK_AUTH_MODE = origEnv.m; if (origEnv.t !== undefined) process.env.INVENTORY_WEBHOOK_EVENT_TYPES = origEnv.t;
    await retryDb(() => prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: origCfg.limitsConfigured ? JSON.stringify(origLimits) : null } }));
    await retryDb(() => prisma.inventorySnapshot.deleteMany({ where: { OR: [{ product_id: { in: created.products } }, { product_name: { startsWith: T } }] } }));
    await retryDb(() => prisma.aiAuditLog.deleteMany({ where: { OR: [{ actor_id: { in: created.users } }, { kind: { in: ['INVENTORY_WEBHOOK_UNMAPPED', 'INVENTORY_RECONCILE'] }, created_at: { gte: t0 } }, { kind: 'OPERATOR_INVENTORY', created_at: { gte: t0 } }] } }));
    await retryDb(() => prisma.product.deleteMany({ where: { OR: [{ id: { in: created.products } }, { product_name: { startsWith: T } }] } }));
    await retryDb(() => prisma.user.deleteMany({ where: { id: { in: created.users } } }));
    const c2 = await S.getOperatorConfig();
    ok('cleanup: fixtures removed, config (links / approvals) restored, #424 untouched', (await prisma.product.count({ where: { product_name: { startsWith: T } } })) === 0 && (await prisma.inventorySnapshot.count({ where: { product_name: { startsWith: T } } })) === 0 && JSON.stringify(c2.limits.inventoryLinks || {}) === JSON.stringify(origLimits.inventoryLinks || {}) && JSON.stringify(c2.limits.productOverrides || {}) === JSON.stringify(origLimits.productOverrides || {}) && (await prisma.product.count()) === counts0.products && (await prisma.inventorySnapshot.count({ where: { product_id: 424, source: { startsWith: 'INVENTORY_API' } } })) === api424Before);
  } catch (e) { fail++; console.log('  ✗ cleanup failed —', e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
