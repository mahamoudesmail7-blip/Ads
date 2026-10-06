// 🤖 AI Operator — WRITE-PATH acceptance (2026-10-03). Exercises the real HTTP routes (/api/operator/*) of an IN-PROCESS express app with the real
// auth middleware, using DISPOSABLE fixtures ("__optest_" prefix: users, products, campaigns, rules) that are always cleaned up.
//   * NO Meta call of any kind: decisions are only ever approved while the mode is SHADOW or the Emergency Stop is ON, so the executor is never reached
//     (asserted: zero AmbRecommendation/AmbAction rows are created).
//   * Section 9 = COD / Confirmation / Delivery audit: such rules must stay BLOCKED while Easy Orders status quality is not trusted.
//   node src/scripts/operatorWritePathTest.js [--skip-world]
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };

if (!process.env.JWT_SECRET) { console.log('JWT_SECRET missing — cannot run the authenticated route tests.'); process.exit(2); }
const { prisma } = await imp('../prisma.js');
// the shared DB can drop for seconds (Neon): restoring the global Operator config in the cleanup must survive that, or a test would leave the production mode altered
const retryDb = async (fn) => { for (let i = 0; i < 10; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 4000)); } } return fn(); };
const { default: operatorRoutes } = await imp('../routes/operator.js');
const { errorHandler } = await imp('../middleware/errorHandler.js');
const S = await imp('../services/amb/operatorStore.js');
const R = await imp('../services/amb/operatorRules.js');
const G = await imp('../services/amb/operatorGuards.js');
const E = await imp('../services/amb/operatorEngine.js');
const CTX = await imp('../services/amb/operatorContext.js');
const { getConnection } = await imp('../services/metaAuth.js');
const { getStoreStatusTrust } = await imp('../services/easyOrdersStatus.js');

const __testStart = new Date();
const T = '__optest_';
const created = { users: [], products: [], decisions: [], maps: [] };
const origCfg = await S.getOperatorConfig();
const counts0 = { recs: await prisma.ambRecommendation.count(), actions: await prisma.ambAction.count() };

// ---- in-process app with the REAL auth middleware ----
const app = express(); app.use(cookieParser()); app.use(express.json({ limit: '5mb' })); app.use('/api/operator', operatorRoutes); app.use(errorHandler);
const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/operator`;
const call = async (method, path, body, token) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Cookie: `token=${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, json, text };
};
const mkUser = async (role, tag) => { const u = await prisma.user.create({ data: { email: `${T}${tag}_${Date.now()}@example.invalid`, password_hash: 'x'.repeat(20), name: `${T}${tag}`, role, status: 'ACTIVE', permissions: '{}' } }); created.users.push(u.id); return { user: u, token: jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '30m' }) }; };

try {
  const admin = await mkUser('ADMIN', 'admin'), manager = await mkUser('MANAGER', 'manager');
  const A = admin.token, M = manager.token;
  await S.setOperatorMode({ mode: 'SHADOW' }); await S.setEmergencyStop({ on: false });
  const mkProduct = async (store, name, extra = {}) => { const p = await prisma.product.create({ data: { product_name: `${T}${name}`, product_code: `${T}${name}_${Date.now()}`, store_id: store, selling_price: 0, product_cost: 0, ...extra } }); created.products.push(p.id); return p; };
  const pA = await mkProduct(`${T}storeA`, 'منتج أ'), pB = await mkProduct(`${T}storeB`, 'منتج ب');

  // =================================================================================================================
  console.log('\n1. authentication & permissions (real middleware)');
  ok('no cookie => 401', (await call('GET', '/overview')).status === 401);
  ok('invalid token => 401', (await call('GET', '/overview', undefined, 'garbage')).status === 401);
  ok('MANAGER can read the overview', (await call('GET', '/overview', undefined, M)).status === 200);
  ok('MANAGER cannot save a product profile (403)', (await call('PUT', `/products/${pA.id}/profile`, { selling_price: 100 }, M)).status === 403);
  ok('MANAGER cannot create a rule (403)', (await call('POST', '/rules', { rule: {} }, M)).status === 403);
  ok('MANAGER cannot change the mode (403)', (await call('PUT', '/mode', { mode: 'APPROVAL' }, M)).status === 403);
  ok('MANAGER cannot apply a CSV import (403)', (await call('POST', '/import/apply', { csv: 'product_id,purchase_cost\n1,1' }, M)).status === 403);
  ok('MANAGER cannot approve / reject (403)', (await call('POST', '/decisions/1/approve', {}, M)).status === 403 && (await call('POST', '/decisions/1/reject', {}, M)).status === 403);
  const es = await call('POST', '/emergency-stop', { reason: `${T}manager stop` }, M);
  ok('MANAGER CAN trigger Emergency Stop (stopping needs no more privilege than running)', es.status === 200 && es.json.emergency_stop === true);
  ok('MANAGER cannot lift it (403) — only ADMIN', (await call('DELETE', '/emergency-stop', undefined, M)).status === 403);
  ok('ADMIN lifts it', (await call('DELETE', '/emergency-stop', undefined, A)).json.emergency_stop === false);

  // =================================================================================================================
  console.log('\n2. Product Economics save (PUT /products/:id/profile)');
  let r = await call('PUT', `/products/${pA.id}/profile`, { target_cpa: 150, hard_stop_cpa: 100 }, A);
  ok('Hard Stop < Target => 400, nothing saved', r.status === 400 && (await prisma.ambProduct.count({ where: { product_id: pA.id } })) === 0, r.text);
  r = await call('PUT', `/products/${pA.id}/profile`, { product_cost: -5 }, A);
  ok('negative cost => 400', r.status === 400);
  r = await call('PUT', `/products/${pA.id}/profile`, { automation_mode: 'TURBO' }, A);
  ok('unknown automation mode => 400', r.status === 400);
  r = await call('PUT', `/products/9999999/profile`, { product_cost: 5 }, A);
  ok('unknown product => 404', r.status === 404);
  r = await call('PUT', `/products/${pA.id}/profile`, { selling_price: 100, product_cost: 120 }, A);
  ok('price <= cost saves but returns a loss WARNING', r.status === 200 && r.json.warnings.some((w) => /بيخسر/.test(w)));
  r = await call('PUT', `/products/${pA.id}/profile`, { selling_price: 300, product_cost: 100, shipping_cost: 30, packaging_cost: 10, target_cpa: 60, max_cpa: 150, hard_stop_cpa: 120, min_profit: 20, product_key: `${T}KEY`, automation_mode: 'APPROVAL', max_scale_pct: 15, testing_spend_allowance: 300, testing_min_sample: 8 }, A);
  ok('full economics + operator fields saved', r.status === 200, r.text);
  const amb = await prisma.ambProduct.findUnique({ where: { product_id: pA.id } });
  const cfg = await prisma.ambOperatorProductConfig.findUnique({ where: { product_id_store_id: { product_id: pA.id, store_id: `${T}storeA` } } });
  ok('economics → AmbProduct (canonical): price/cost/shipping/packaging/target/max/min-profit', amb && amb.actual_selling_price === 300 && amb.product_cost === 100 && amb.shipping_cost === 30 && amb.packaging_cost === 10 && amb.target_cpa === 60 && amb.max_cpa === 150 && amb.min_profit === 20, JSON.stringify(amb));
  ok('operator-only fields → operator config (Hard Stop, key, mode, scale cap, testing) — no duplicate of canonical values', cfg && cfg.hard_stop_cpa === 120 && cfg.product_key === `${T}KEY` && cfg.automation_mode === 'APPROVAL' && cfg.max_scale_pct === 15 && cfg.testing_spend_allowance === 300 && cfg.testing_min_sample === 8 && cfg.target_cpa == null && cfg.max_cpa == null);
  r = await call('GET', `/products/${pA.id}/profile`, undefined, A);
  ok('profile read-back: values + source + unit margin 160 + store isolation', r.status === 200 && r.json.economics.sellingPrice.value === 300 && r.json.economics.unitMargin === 160 && r.json.economics.purchaseCost.source === 'AMB' && r.json.store === `${T}storeA` && r.json.economics.hardStopCpa.value === 120);
  r = await call('PUT', `/products/${pA.id}/profile`, { target_cpa: '' }, A);
  ok('clearing a field stores NULL (unknown), never 0', r.status === 200 && (await prisma.ambProduct.findUnique({ where: { product_id: pA.id } })).target_cpa === null);
  const pBamb = await prisma.ambProduct.count({ where: { product_id: pB.id } });
  ok('the OTHER store\'s product was not touched', pBamb === 0 && (await prisma.ambOperatorProductConfig.count({ where: { product_id: pB.id } })) === 0);

  // =================================================================================================================
  console.log('\n3. Inventory save');
  r = await call('PUT', `/products/${pA.id}/profile`, { current_stock: 25, minimum_stock: 5 }, A);
  let pr = await prisma.product.findUnique({ where: { id: pA.id } });
  ok('stock saved on the catalog Product (canonical inventory)', r.status === 200 && pr.current_stock === 25 && pr.minimum_stock === 5);
  r = await call('PUT', `/products/${pA.id}/profile`, { current_stock: 0 }, A);
  pr = await prisma.product.findUnique({ where: { id: pA.id } });
  ok('stock 0 is saved as 0 (KNOWN, out of stock) — distinct from unknown', r.status === 200 && pr.current_stock === 0 && r.json.profile.stock.known === true);
  r = await call('PUT', `/products/${pA.id}/profile`, { current_stock: -3 }, A);
  ok('negative stock => 400', r.status === 400 && (await prisma.product.findUnique({ where: { id: pA.id } })).current_stock === 0);
  r = await call('PUT', `/products/${pA.id}/profile`, { current_stock: '' }, A);
  ok('clearing stock returns it to UNKNOWN (null)', r.status === 200 && (await prisma.product.findUnique({ where: { id: pA.id } })).current_stock === null);
  r = await call('PUT', `/products/${pA.id}/profile`, { current_stock: 40 }, A);
  const rd = (await call('GET', '/readiness', undefined, A)).json.products.find((p) => p.productId === pA.id);
  ok('readiness reflects the saved stock + economics; still BLOCKED because no VERIFIED campaign', rd && rd.stockKnown && rd.economicsComplete && rd.readiness.state === 'BLOCKED' && rd.readiness.missing.some((m) => m.key === 'MAPPING'), JSON.stringify(rd?.readiness?.missing));
  ok('stock of store A never changed product B', (await prisma.product.findUnique({ where: { id: pB.id } })).current_stock === null);

  // =================================================================================================================
  console.log('\n4. Campaign mapping confirmation');
  const conn = await getConnection(); const acc = conn?.status === 'CONNECTED' ? conn.selected_ad_account_id : null;
  const ambA = await prisma.ambProduct.findUnique({ where: { product_id: pA.id } });
  r = await call('POST', '/mapping/confirm', { campaignId: `${T}camp1` }, A);
  ok('missing product => 400', r.status === 400);
  if (acc) {
    created.maps.push(`${T}camp1`, `${T}camp2`);
    // a SUGGESTED row must never be executable
    await prisma.ambProductCampaignMap.create({ data: { amb_product_id: ambA.id, ad_account_id: acc, campaign_id: `${T}camp2`, campaign_name: `${T}camp2`, status: 'SUGGESTED', match_source: 'AI_SUGGESTED', match_confidence: 0.9 } });
    let idx = await CTX.buildCampaignProductIndex({ adAccountId: acc });
    ok('SUGGESTED mapping is NOT verified (automation never runs against it)', idx.get(`${T}camp2`)?.verified === false);
    r = await call('POST', '/mapping/confirm', { campaignId: `${T}camp2`, campaignName: `${T}camp2`, ambProductId: ambA.id }, A);
    idx = await CTX.buildCampaignProductIndex({ adAccountId: acc });
    ok('owner confirmation => MAPPED / VERIFIED', r.status === 200 && idx.get(`${T}camp2`)?.verified === true && idx.get(`${T}camp2`)?.ambProductId === ambA.id);
    r = await call('POST', '/mapping/confirm', { campaignId: `${T}camp1`, campaignName: `${T}camp1`, ambProductId: ambA.id }, A);
    ok('new explicit mapping saved with a human match source', r.status === 200 && (await prisma.ambProductCampaignMap.findFirst({ where: { campaign_id: `${T}camp1` } }))?.match_source === 'MANUAL');
    const rd2 = (await call('GET', '/readiness', undefined, A)).json.products.find((p) => p.productId === pA.id);
    ok('readiness now sees 2 VERIFIED campaigns; mapping no longer missing', rd2.campaignsMapped === 2 && !rd2.readiness.missing.some((m) => m.key === 'MAPPING'));
    r = await call('POST', '/mapping/exclude', { campaignId: `${T}camp1`, campaignName: `${T}camp1`, exclude: true }, A);
    const exc = (await call('GET', '/exceptions', undefined, A)).json.exceptions.find((e) => e.scope_id === `${T}camp1`);
    ok('exclude => CAMPAIGN-scoped NO_AUTOMATION exception', r.status === 200 && exc && exc.types.includes('NO_AUTOMATION'));
    r = await call('POST', '/mapping/exclude', { campaignId: `${T}camp1`, exclude: false }, A);
    ok('include again removes the exception', r.status === 200 && !(await call('GET', '/exceptions', undefined, A)).json.exceptions.some((e) => e.scope_id === `${T}camp1`));
    r = await call('DELETE', `/mapping/${T}camp1`, undefined, A);
    idx = await CTX.buildCampaignProductIndex({ adAccountId: acc });
    ok('unmap => campaign no longer mapped', r.status === 200 && !idx.has(`${T}camp1`));
    ok('MANAGER cannot confirm a mapping (403)', (await call('POST', '/mapping/confirm', { campaignId: `${T}camp1`, ambProductId: ambA.id }, M)).status === 403);
  } else console.log('  (no Meta ad account selected — mapping confirm skipped)');

  // =================================================================================================================
  console.log('\n5. Rule create / edit / disable');
  const good = { name: `${T}rule`, action: 'PAUSE', window: 'today', mode: 'SHADOW', cooldown_hours: 12, conditions: { all: [{ field: 'spend', op: '>=', value: 180 }, { field: 'purchases', op: '=', value: 0 }] } };
  r = await call('POST', '/rules', { rule: { ...good, conditions: { all: [{ field: 'purchases', op: '=', value: 0 }] } } }, A);
  ok('invalid rule (no spend gate) => 400 with a readable message, NOT saved', r.status === 400 && /حد صرف|Spend/.test(r.json.message) && (await prisma.ambOperatorRule.count({ where: { name: `${T}rule` } })) === 0, r.text);
  r = await call('POST', '/rules', { rule: good }, A);
  const rid = r.json?.rule?.id;
  ok('valid rule => 201, saved DISABLED + SHADOW', r.status === 201 && r.json.rule.enabled === false && r.json.rule.mode === 'SHADOW' && r.json.rule.version === 1);
  r = await call('PUT', `/rules/${rid}`, { rule: { ...good, conditions: { all: [{ field: 'spend', op: '>=', value: 220 }, { field: 'purchases', op: '=', value: 0 }] } } }, A);
  ok('edit => version 2 and new threshold persisted', r.status === 200 && r.json.rule.version === 2 && r.json.rule.conditions.all[0].value === 220);
  r = await call('POST', `/rules/${rid}/enabled`, { enabled: true }, A);
  ok('enable works for a valid rule', r.status === 200 && r.json.rule.enabled === true);
  r = await call('POST', `/rules/${rid}/enabled`, { enabled: false }, A);
  ok('disable works', r.status === 200 && r.json.rule.enabled === false);
  r = await call('PUT', `/rules/${rid}`, { rule: { ...good, mode: 'AUTOPILOT' } }, A);
  ok('an AUTOPILOT rule without a specific store is refused (400: no Autopilot across all stores)', r.status === 400 && /متجر/.test(r.json.message));
  r = await call('PUT', `/rules/${rid}`, { rule: { ...good, mode: 'AUTOPILOT', store_id: `${T}storeA`, scope: { excludeTags: ['TESTING'] } } }, A);
  ok('a store-scoped rule may be marked AUTOPILOT, but that alone does NOT start Autopilot (global mode stays SHADOW)', r.status === 200 && r.json.rule.mode === 'AUTOPILOT' && (await S.getOperatorConfig()).mode === 'SHADOW');
  r = await call('PUT', '/mode', { mode: 'AUTOPILOT', confirmAutopilot: true }, A);
  ok('global AUTOPILOT refused by the activation gate (409)', r.status === 409 && (await S.getOperatorConfig()).mode === 'SHADOW', r.text);
  r = await call('POST', '/rules', { rule: { ...good, name: `${T}cod`, conditions: { all: [{ field: 'spend', op: '>=', value: 100 }, { field: 'confirmation_rate', op: '<', value: 50 }] } } }, A);
  ok('a COD/confirmation rule cannot be created (400 COD_FIELD_UNSUPPORTED)', r.status === 400 && /COD|التأكيد/.test(r.json.message), r.text);
  r = await call('POST', '/rules/validate', { rule: { ...good, conditions: { all: [{ field: 'spend', op: '>=', value: 100 }, { field: 'delivery_rate', op: '<', value: 50 }] } } }, A);
  ok('validate endpoint reports COD_FIELD_UNSUPPORTED too', r.json.validation.errors.some((e) => e.code === 'COD_FIELD_UNSUPPORTED'));
  r = await call('POST', '/rules/parse', { text: 'اقفل الحملة لو صرفت 200 جنيه ونسبة التأكيد أقل من 50%' }, A);
  ok('Arabic rule with a confirmation clause is REFUSED (never silently dropped)', r.json.ok === false && r.json.rule === null && r.json.unparsed.includes('COD'));
  r = await call('POST', '/templates/ZERO_ORDER_STOP/instantiate', { params: { spend: 250 } }, A);
  ok('template => draft rule (disabled, validated)', r.status === 200 && r.json.rule.enabled === false && r.json.validation.ok);
  const aud = (await call('GET', `/audit?ruleId=${rid}`, undefined, A)).json.entries;
  ok('rule audit log: created/edited/toggled with WHO and WHEN', aud.length >= 4 && aud.every((a) => a.actor === `${T}admin` && a.at));
  r = await call('DELETE', `/rules/${rid}`, undefined, A);
  ok('delete works and is audited', r.status === 200 && (await prisma.ambOperatorRule.count({ where: { id: rid } })) === 0);

  // =================================================================================================================
  console.log('\n6. Exceptions');
  r = await call('POST', '/exceptions', { scopeType: 'CAMPAIGN', scopeId: `${T}c9`, types: ['DO_ANYTHING'] }, A);
  ok('unknown exception type => 400', r.status === 400);
  r = await call('POST', '/exceptions', { scopeType: 'GALAXY', scopeId: 'x', types: ['NO_AUTO_STOP'] }, A);
  ok('unknown scope => 400', r.status === 400);
  r = await call('POST', '/exceptions', { scopeType: 'CAMPAIGN', scopeId: `${T}c9`, scopeLabel: `${T}c9`, types: ['NO_AUTO_STOP'], reason: 'test', ttlHours: 2 }, A);
  const xid = r.json?.exception?.id;
  ok('temporary exception created (201) with expiry', r.status === 201 && r.json.exception.temporary === true);
  ok('exception listed', (await call('GET', '/exceptions', undefined, A)).json.exceptions.some((e) => e.id === xid));
  r = await call('POST', '/exceptions', { scopeType: 'PRODUCT', scopeId: String(pA.id), types: ['NO_AUTOMATION'], storeId: `${T}storeA` }, A);
  const xid2 = r.json?.exception?.id;
  ok('product-scoped exception created', r.status === 201);
  const g = G.evaluateGuards({ decision: { action: 'PAUSE', params: {}, ruleMode: 'APPROVAL', confidence: 'HIGH', needs: {}, ruleMinSpend: 100 }, ctx: { storeId: `${T}storeA`, campaign: { id: `${T}c9`, status: 'ACTIVE', budget: 100 }, metrics: { spend: 500, purchases: 0 }, product: { id: pA.id, mappingVerified: true }, dq: { gate: 'OK', overall: 'RECONCILED' }, exceptions: (await S.listExceptions({})).filter((e) => [xid, xid2].includes(e.id)), recent: { lastByAction: {} } }, config: { ...origCfg, mode: 'APPROVAL', limits: origCfg.limits, cooldowns: origCfg.cooldowns, schedule: { mode: 'ALWAYS' }, storeLimits: {} }, settings: { ambMinSpendBeforeDecision: 150 }, counters: {} });
  ok('the saved exceptions really block the action (campaign + product scope)', g.blocks.some((b) => b.code === 'EXCEPTION_NO_AUTO_STOP') && g.blocks.some((b) => b.code === 'EXCEPTION_NO_AUTOMATION') && g.blocks.some((b) => b.specCodes.includes('PRODUCT_EXCEPTION')) && g.blocks.some((b) => b.specCodes.includes('CAMPAIGN_EXCEPTION')) && !g.canExecute);
  ok('MANAGER cannot add / remove exceptions (403)', (await call('POST', '/exceptions', { scopeType: 'CAMPAIGN', scopeId: 'x', types: ['NO_AUTO_STOP'] }, M)).status === 403 && (await call('DELETE', `/exceptions/${xid}`, undefined, M)).status === 403);
  r = await call('DELETE', `/exceptions/${xid}`, undefined, A); await call('DELETE', `/exceptions/${xid2}`, undefined, A);
  ok('exception removal works', r.status === 200 && !(await call('GET', '/exceptions', undefined, A)).json.exceptions.some((e) => [xid, xid2].includes(e.id)));

  // =================================================================================================================
  console.log('\n7. CSV preview / apply validation');
  const hdr = 'product_id,purchase_cost,selling_price,shipping,packaging,target_cpa,hard_stop_cpa,minimum_stock,current_stock';
  const before = JSON.stringify(await prisma.ambProduct.findUnique({ where: { product_id: pB.id } }));
  r = await call('POST', '/import/preview', { csv: `${hdr}\n${pB.id},80,200,20,5,50,90,3,12` }, A);
  ok('preview is valid and WRITES NOTHING', r.status === 200 && r.json.rows[0].status === 'OK' && JSON.stringify(await prisma.ambProduct.findUnique({ where: { product_id: pB.id } })) === before && (await prisma.product.findUnique({ where: { id: pB.id } })).current_stock === null);
  r = await call('POST', '/import/preview', { csv: `${hdr}\n${pB.id},abc,200,20,5,50,90,3,12\n99999999,10,20,1,1,5,9,1,1\n${pB.id},50,100,1,1,60,40,1,1` }, A);
  ok('preview flags non-numeric / unknown product / duplicate / Hard Stop < Target', r.json.summary.error === 3 && r.json.rows.every((x) => x.status === 'ERROR'), JSON.stringify(r.json.summary));
  r = await call('POST', '/import/apply', { csv: `${hdr}\n${pB.id},80,200,20,5,50,90,3,12\n99999999,10,20,1,1,5,9,1,1` }, A);
  ok('apply with any invalid row => 400 and NOTHING saved', r.status === 400 && (await prisma.ambProduct.count({ where: { product_id: pB.id } })) === 0 && (await prisma.product.findUnique({ where: { id: pB.id } })).current_stock === null, r.text);
  r = await call('POST', '/import/apply', { csv: `${hdr}\n${pB.id},80,200,20,5,50,90,3,12\n99999999,10,20,1,1,5,9,1,1`, skipInvalid: true }, A);
  const ambB = await prisma.ambProduct.findUnique({ where: { product_id: pB.id } });
  ok('apply with skipInvalid saves ONLY the valid row, reports the skipped one', r.status === 200 && r.json.summary.saved === 1 && r.json.summary.skipped === 1 && ambB?.product_cost === 80 && ambB.actual_selling_price === 200 && (await prisma.product.findUnique({ where: { id: pB.id } })).current_stock === 12);
  ok('imported Hard Stop landed in operator config; product A (other store) untouched', (await prisma.ambOperatorProductConfig.findUnique({ where: { product_id_store_id: { product_id: pB.id, store_id: `${T}storeB` } } }))?.hard_stop_cpa === 90 && (await prisma.ambProduct.findUnique({ where: { product_id: pA.id } })).product_cost === 100);
  r = await call('POST', '/import/apply', { csv: `${hdr}\n${pB.id},80,200,20,5,50,90,3,12` }, A);
  ok('re-applying identical values => UNCHANGED (idempotent)', r.status === 200 && r.json.summary.unchanged === 1 && r.json.summary.saved === 0);
  r = await call('GET', '/import/template', undefined, A);
  ok('template CSV downloads with the real products', r.status === 200 && r.text.includes('product_id,product,store'));

  // =================================================================================================================
  console.log('\n8. Approval / Reject flow (executor can never be reached)');
  const mkDec = async (o = {}) => { const d = await prisma.ambOperatorDecision.create({ data: { decision_key: `${T}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, store_id: `${T}storeA`, ad_account_id: `${T}acc`, campaign_id: `${T}cd`, campaign_name: `${T}decision campaign`, action: 'SCALE_DOWN', rule_name: `${T}rollback`, mode_at_decision: 'APPROVAL', status: 'PREPARED', confidence: 'HIGH', params_json: JSON.stringify({ rollbackOf: 1, fromBudget: 230, toBudget: 200, pct: 13, window: 'today' }), evidence_json: '{}', why_json: JSON.stringify({ what: 'x', why: 'y' }), ...o } }); created.decisions.push(d.id); return d; };
  const d1 = await mkDec();
  r = await call('GET', `/decisions/${d1.id}`, undefined, M);
  ok('decision readable by MANAGER with the canonical object + lifecycle', r.status === 200 && r.json.decision.lifecycle === 'READY_FOR_APPROVAL' && r.json.decision.canonical.decisionId === d1.id && r.json.decision.canonical.budgetChange.to === 200);
  ok('mode is SHADOW (precondition for the safe approve test)', (await S.getOperatorConfig()).mode === 'SHADOW');
  r = await call('POST', `/decisions/${d1.id}/approve`, {}, A);
  const d1r = await prisma.ambOperatorDecision.findUnique({ where: { id: d1.id } });
  ok('approve in SHADOW => NOT executed (blocked: Shadow), reason stored, no recommendation/action created', r.status === 200 && r.json.executed === false && d1r.status === 'BLOCKED' && /Shadow/.test(d1r.error) && (await prisma.ambRecommendation.count({ where: { batch_id: `operator-${d1.id}` } })) === 0);
  const d2 = await mkDec();
  await S.setOperatorMode({ mode: 'APPROVAL' });
  await call('POST', '/emergency-stop', { reason: `${T}approval test` }, A);
  ok('precondition: APPROVAL mode + Emergency Stop ON (executor still unreachable)', (await S.getOperatorConfig()).mode === 'APPROVAL' && (await S.getOperatorConfig()).emergency_stop === true);
  r = await call('POST', `/decisions/${d2.id}/approve`, {}, A);
  const d2r = await prisma.ambOperatorDecision.findUnique({ where: { id: d2.id } });
  ok('Emergency Stop overrides an approved decision (not executed)', r.status === 200 && r.json.executed === false && /إيقاف الطوارئ/.test(d2r.error) && (await prisma.ambRecommendation.count({ where: { batch_id: `operator-${d2.id}` } })) === 0);
  const d3 = await mkDec();
  r = await call('POST', `/decisions/${d3.id}/reject`, { reason: 'مش وقته' }, A);
  const d3r = await prisma.ambOperatorDecision.findUnique({ where: { id: d3.id } });
  ok('reject stores the status + reason + who', r.json.ok === true && d3r.status === 'REJECTED' && d3r.reject_reason === 'مش وقته' && d3r.approved_by_id === admin.user.id);
  ok('reject twice => ok:false (terminal)', (await call('POST', `/decisions/${d3.id}/reject`, {}, A)).json.ok === false);
  const ev3 = (await call('GET', `/decisions/${d3.id}/events`, undefined, A)).json.events;
  ok('rejection transition persisted in the audit trail', ev3.some((e) => e.to === 'REJECTED' && e.actor === 'USER'));
  const d4 = await mkDec();
  r = await call('POST', `/decisions/${d4.id}/snooze`, { hours: 6 }, A);
  ok('snooze => SNOOZED until a future time', r.json.ok && (await prisma.ambOperatorDecision.findUnique({ where: { id: d4.id } })).status === 'SNOOZED');
  r = await call('POST', `/decisions/${d3.id}/approve`, {}, A);
  ok('approving a rejected decision => 409', r.status === 409);
  r = await call('POST', '/decisions/bulk-approve', { decisionIds: [d1.id, d2.id], confirmedIds: [d1.id] }, A);
  ok('bulk approve without per-item confirmation => 400', r.status === 400);
  const dOpen = await mkDec({ action: 'OPEN', params_json: JSON.stringify({ window: 'today' }) });
  r = await call('POST', '/decisions/bulk-approve', { decisionIds: [dOpen.id], confirmedIds: [dOpen.id] }, A);
  ok('bulk approve of OPEN => 400 (risky action)', r.status === 400);
  r = await call('POST', `/decisions/${d3.id}/retry`, {}, A);
  ok('retry of a non-failed decision => 409', r.status === 409);
  // the deployment-level lock: even APPROVAL mode with NO Emergency Stop cannot reach the executor
  ok('precondition: OPERATOR_ALLOW_META_WRITES is not set (locked)', S.metaWritesLocked() === true && (await call('GET', '/config', undefined, A)).json.config.writesLocked === true && (await call('GET', '/overview', undefined, A)).json.writesLocked === true);
  await call('DELETE', '/emergency-stop', undefined, A);
  const d5 = await mkDec();
  ok('precondition: APPROVAL mode, Emergency Stop OFF', (await S.getOperatorConfig()).mode === 'APPROVAL' && (await S.getOperatorConfig()).emergency_stop === false);
  r = await call('POST', `/decisions/${d5.id}/approve`, {}, A);
  const d5r = await prisma.ambOperatorDecision.findUnique({ where: { id: d5.id } });
  ok('APPROVAL mode + no Emergency Stop + approve => STILL not executed: Meta writes are locked at deployment level', r.status === 200 && r.json.executed === false && /مقفولة على مستوى النشر/.test(d5r.error) && (await prisma.ambRecommendation.count({ where: { batch_id: `operator-${d5.id}` } })) === 0);
  r = await call('PUT', '/mode', { mode: 'AUTOPILOT', confirmAutopilot: true }, A);
  ok('Autopilot activation refused (gate lists the write lock among the failing checks)', r.status === 409 && JSON.stringify(r.json).includes('OPERATOR_ALLOW_META_WRITES'));
  await call('DELETE', '/emergency-stop', undefined, A); await S.setOperatorMode({ mode: 'SHADOW' });
  ok('no Meta write path was reachable: zero recommendations/actions created by this test run', (await prisma.ambRecommendation.count()) === counts0.recs && (await prisma.ambAction.count()) === counts0.actions);

  // =================================================================================================================
  console.log('\n9. COD / Confirmation / Delivery audit (must stay BLOCKED while Easy Orders status quality is untrusted)');
  const src = (f) => readFileSync(join(__dirname, f), 'utf8');
  ok('no COD/confirmation/delivery field exists in the rule field catalogue', !R.COD_FIELDS.some((f) => f in R.FIELDS) && !Object.keys(R.FIELDS).some((k) => /confirm|deliver|return|cod/i.test(k)));
  for (const f of R.COD_FIELDS) ok(`validateRule rejects ${f}`, R.validateRule({ ...good, conditions: { all: [{ field: 'spend', op: '>=', value: 100 }, { field: f, op: '<', value: 50 }] } }).errors.some((e) => e.code === 'COD_FIELD_UNSUPPORTED'));
  const phrases = ['اقفل الحملة لو صرفت 200 ونسبة التأكيد قليلة', 'وقف الحملة لو صرفت 200 ونسبة التسليم أقل من 40', 'اقفل لو صرفت 150 والمرتجعات كتير', 'وقف لو صرفت 300 والأوردرات الكاش مش متأكدة', 'pause if spend 200 and confirmation rate low'];
  for (const p of phrases) { const x = R.parseArabicRule(p); ok(`NL refused (COD clause not dropped): "${p.slice(0, 40)}…"`, x.ok === false && x.rule === null); }
  ok('control: the same sentence WITHOUT a COD clause still parses', R.parseArabicRule('اقفل الحملة لو صرفت 200 جنيه من غير أوردرات').ok === true);
  // guard chain, every trust state x every consequential action
  const baseCfg = { mode: 'AUTOPILOT', emergency_stop: false, limits: JSON.parse(JSON.stringify(S.DEFAULT_LIMITS)), cooldowns: { ...S.DEFAULT_COOLDOWNS }, schedule: { mode: 'ALWAYS' }, storeLimits: {} };
  const baseSet = { ambMinSpendBeforeDecision: 150, ambMinPurchasesBeforeScaling: 5, ambAllowAutoPause: true, ambAllowAutoOpen: true, ambAllowAutoScale: true, ambAllowAutoBudgetIncrease: true, ambAllowAutoBudgetDecrease: true, ambMaxBudgetIncreasePct: 20, ambMaxAutoExecutionAmount: 500 };
  const NOW = new Date();
  const ctxFor = (action, trust) => ({ storeId: 's', campaign: { id: 'c', status: action === 'OPEN' ? 'PAUSED' : 'ACTIVE', budget: 500, firstSeenAt: new Date(NOW.getTime() - 200 * 3_600_000).toISOString() }, metrics: { spend: 600, purchases: 10 }, product: { id: 1, mappingVerified: true }, dq: { gate: 'OK', overall: 'RECONCILED', statusTrust: trust === undefined ? undefined : trust === null ? null : { state: trust } }, stock: { status: 'SAFE', currentStock: 100, daysRemaining: 30 }, econ: { complete: true, profitState: 'PROFITABLE', hardStopCpa: 200 }, exceptions: [], recent: { lastByAction: {}, pausedBySystemAt: NOW.toISOString() }, metaConnected: true, metaStale: false, incidents: [] });
  for (const trust of ['NO_STATUS_SIGNAL', 'PARTIAL', 'INSUFFICIENT_SAMPLE', null, undefined]) {
    for (const action of ['OPEN', 'PAUSE', 'SCALE_UP', 'SCALE_DOWN']) {
      const gg = G.evaluateGuards({ decision: { action, params: ['SCALE_UP', 'SCALE_DOWN'].includes(action) ? { pct: 10, fromBudget: 500, toBudget: action === 'SCALE_UP' ? 550 : 450 } : {}, ruleMode: 'AUTOPILOT', confidence: 'HIGH', needs: {}, usesCod: true, ruleMinSpend: 150, cooldownHours: 12 }, ctx: ctxFor(action, trust), config: baseCfg, settings: baseSet, counters: {}, now: NOW });
      ok(`COD-dependent ${action} is BLOCKED when status trust = ${trust === undefined ? 'undefined' : trust}`, gg.blocks.some((b) => b.code === 'COD_UNRELIABLE' && b.severity === 'BLOCK') && !gg.canExecute && !gg.canAutoExecute && gg.wouldBe === 'BLOCKED');
    }
  }
  ok('with trust OK the COD guard itself does not fire (the missing data source then blocks as DATA_UNKNOWN in the engine)', !G.evaluateGuards({ decision: { action: 'PAUSE', params: {}, ruleMode: 'AUTOPILOT', confidence: 'HIGH', needs: {}, usesCod: true, ruleMinSpend: 150, cooldownHours: 12 }, ctx: ctxFor('PAUSE', 'OK'), config: baseCfg, settings: baseSet, counters: {}, now: NOW }).blocks.some((b) => b.code === 'COD_UNRELIABLE'));
  ok('usesCodField detects a COD condition (engine feeds it into the guard chain)', R.usesCodField({ conditions: { all: [{ field: 'delivery_rate', op: '<', value: 1 }] } }) && !R.usesCodField({ conditions: { all: [{ field: 'spend', op: '>=', value: 1 }] } }));
  ok('profit/economics never read COD rates (source audit)', !/confirmation_rate|delivery_rate|rto_cost/.test(src('../services/amb/operatorGuards.js')) && !/confirmation_rate|delivery_rate/.test(src('../services/amb/operatorContext.js')));
  const e1 = G.computeOperatorEconomics({ product: { selling_price: 500, product_cost: 200 }, ambProduct: null, opCfg: null }), e2 = G.computeOperatorEconomics({ product: { selling_price: 500, product_cost: 200 }, ambProduct: { confirmation_rate: 0.1, delivery_rate: 0.1, rto_cost: 999 }, opCfg: null });
  ok('economics are identical whatever the (untrusted) confirmation/delivery rates say', e1.unitMargin === e2.unitMargin && e1.calculatedMaxCpa === e2.calculatedMaxCpa);
  if (!process.argv.includes('--skip-world')) {
    const trusts = {}; for (const sid of ['default', 'trendy-storeee']) trusts[sid] = (await getStoreStatusTrust(sid)).state;
    console.log(`  ℹ real Easy Orders status trust: ${JSON.stringify(trusts)}`);
    const codRule = { id: -77, name: `${T}cod-engine`, enabled: true, mode: 'AUTOPILOT', window: 'today', action: 'PAUSE', priority: 1, cooldown_hours: 12, scope: {}, store_id: null, conditions: { all: [{ field: 'spend', op: '>=', value: 1 }, { field: 'confirmation_rate', op: '<', value: 50 }, { field: 'campaign_status', op: '=', value: 'ACTIVE' }] } };
    const cnt = async () => (await prisma.ambOperatorDecision.count()) + (await prisma.ambRecommendation.count()) + (await prisma.ambAction.count());
    const c0 = await cnt();
    const res = await E.evaluateOperator({ rules: [codRule], persist: false });
    ok(`engine over the REAL world: ${res.candidates.length} COD-rule candidates, ALL blocked, none executable`, res.candidates.length > 0 && res.candidates.every((c) => c.wouldBe === 'BLOCKED' && !c.canAutoExecute));
    const untrusted = res.candidates.filter((c) => c.store && trusts[c.store] && trusts[c.store] !== 'OK');
    ok('every candidate in a store with untrusted statuses carries COD_UNRELIABLE (machine code COD_UNRELIABLE)', untrusted.every((c) => c.blocks.some((b) => b.code === 'COD_UNRELIABLE' && b.specCodes.includes('COD_UNRELIABLE'))), `untrusted=${untrusted.length}`);
    ok('every COD-rule candidate is also DATA_UNKNOWN (there is no verified COD data source at all)', res.candidates.every((c) => c.blocks.some((b) => b.code === 'DATA_UNKNOWN' || b.code === 'COD_UNRELIABLE')));
    ok('the real-world COD pass wrote nothing', (await cnt()) === c0);
  }
} catch (err) {
  fail++; console.log('  ✗ crashed —', err.stack || err.message);
} finally {
  server.close();
  try {
    const uids = created.users;
    await retryDb(() => prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { mode: origCfg.mode, emergency_stop: origCfg.emergency_stop, emergency_reason: origCfg.emergency_reason, emergency_at: origCfg.emergency_at } }));
    const decIds = (await prisma.ambOperatorDecision.findMany({ where: { OR: [{ store_id: { startsWith: T } }, { campaign_id: { startsWith: T } }, { decision_key: { startsWith: T } }] }, select: { id: true } })).map((x) => x.id);
    await prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ decision_id: { in: decIds } }, { campaign_id: { startsWith: T } }, { actor_id: { in: uids } }] } });
    await prisma.ambOperatorDecision.deleteMany({ where: { id: { in: decIds } } });
    await prisma.ambOperatorRule.deleteMany({ where: { name: { startsWith: T } } });
    await prisma.ambOperatorException.deleteMany({ where: { OR: [{ scope_id: { startsWith: T } }, { reason: { contains: T } }, { scope_id: { in: created.products.map(String) } }] } });
    await prisma.ambProductCampaignMap.deleteMany({ where: { campaign_id: { startsWith: T } } });
    await prisma.ambOperatorProductConfig.deleteMany({ where: { store_id: { startsWith: T } } });
    await prisma.ambAlert.deleteMany({ where: { OR: [{ title: { contains: T } }, { message: { contains: T } }, { entity_id: { startsWith: T } }] } });
    await prisma.ambProduct.deleteMany({ where: { OR: [{ product_id: { in: created.products } }, { product_name: { startsWith: T } }] } });
    await prisma.product.deleteMany({ where: { OR: [{ id: { in: created.products } }, { product_name: { startsWith: T } }] } });
    await prisma.aiAuditLog.deleteMany({ where: { OR: [{ actor_id: { in: uids } }, { kind: { startsWith: 'OPERATOR_' }, actor_id: null, created_at: { gte: __testStart } }] } });
    await prisma.ambOperatorEvent.deleteMany({ where: { actor_id: null, created_at: { gte: __testStart } } });
    await prisma.user.deleteMany({ where: { id: { in: uids } } });
    const left = {
      decisions: await prisma.ambOperatorDecision.count({ where: { store_id: { startsWith: T } } }), rules: await prisma.ambOperatorRule.count({ where: { name: { startsWith: T } } }),
      exceptions: await prisma.ambOperatorException.count({ where: { scope_id: { startsWith: T } } }), maps: await prisma.ambProductCampaignMap.count({ where: { campaign_id: { startsWith: T } } }),
      products: await prisma.product.count({ where: { product_name: { startsWith: T } } }), amb: await prisma.ambProduct.count({ where: { product_name: { startsWith: T } } }),
      users: await prisma.user.count({ where: { email: { startsWith: T } } }), alerts: await prisma.ambAlert.count({ where: { title: { contains: T } } }), opCfg: await prisma.ambOperatorProductConfig.count({ where: { store_id: { startsWith: T } } }),
    };
    const c2 = await S.getOperatorConfig();
    const dirty = Object.entries(left).filter(([, v]) => v !== 0);
    ok('cleanup: zero fixtures left (users/products/rules/exceptions/maps/decisions/alerts) + global config restored', dirty.length === 0 && c2.mode === origCfg.mode && c2.emergency_stop === origCfg.emergency_stop, JSON.stringify(dirty));
    ok('final: no recommendation/action rows were created by this run (no Meta write path used)', (await prisma.ambRecommendation.count()) === counts0.recs && (await prisma.ambAction.count()) === counts0.actions);
  } catch (e) { fail++; console.log('  ✗ cleanup failed —', e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
