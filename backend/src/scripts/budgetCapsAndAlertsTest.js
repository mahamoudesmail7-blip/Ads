// 🧪 Budget Caps (campaign / product / account) + Smart Alerts (10 situations, deduped). No Meta call. The real config row is restored; alert fixtures are removed.
//   node src/scripts/budgetCapsAndAlertsTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
process.env.BUDGET_EXECUTION_TEST_HOOK = '1';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const { prisma } = await imp('../prisma.js'); const BC = await imp('../services/amb/budgetCaps.js'); const SA = await imp('../services/amb/smartAlerts.js'); const BX = await imp('../services/amb/budgetExecution.js'); const BO = await imp('../services/amb/budgetOptimizer.js');
const { default: operatorRoutes } = await imp('../routes/operator.js'); const { errorHandler } = await imp('../middleware/errorHandler.js');
const T = '__optest_'; const users = []; const keys = new Set(); const decisions = [];
const raw0 = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } });
const mkUser = async (role, tag) => { const u = await prisma.user.create({ data: { email: `${T}bc_${tag}_${Date.now()}@example.invalid`, password_hash: 'x'.repeat(20), name: `${T}bc ${tag}`, role, status: 'ACTIVE', permissions: '{}' } }); users.push(u.id); return u; };
try {
  const admin = await mkUser('ADMIN', 'a'), mgr = await mkUser('MANAGER', 'm');
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: raw0.limits_json } });

  console.log('\n1. Budget Caps — storage, ADMIN + confirm + audit');
  const stored0 = JSON.parse(raw0.limits_json || '{}').budgetCaps || {};
  ok('caps read back exactly what is stored; absent = null (no limit)', JSON.stringify(await BC.getBudgetCaps()) === JSON.stringify({ campaign: stored0.campaign ?? null, product: stored0.product ?? null, account: stored0.account ?? null }));
  let e1 = null; try { await BC.setBudgetCaps({ caps: { campaign: 800 }, confirm: true, userId: mgr.id }); } catch (e) { e1 = e; } ok('MANAGER cannot set caps (403)', e1?.status === 403);
  let e2 = null; try { await BC.setBudgetCaps({ caps: { campaign: 800 }, userId: admin.id }); } catch (e) { e2 = e; } ok('no explicit confirmation → refused', e2?.code === 'CONFIRM_REQUIRED');
  let e3 = null; try { await BC.setBudgetCaps({ caps: { campaign: -5 }, confirm: true, userId: admin.id }); } catch (e) { e3 = e; } ok('negative / junk cap refused (400)', e3?.status === 400);
  const set = await BC.setBudgetCaps({ caps: { campaign: 800, account: 5000 }, confirm: true, userId: admin.id });
  ok('ADMIN + confirm saves; unspecified level untouched (product stays null)', set.campaign === 800 && set.account === 5000 && set.product === null && (await BC.getBudgetCaps()).campaign === 800);
  ok('audited twice (AiAuditLog + operator event)', (await prisma.aiAuditLog.count({ where: { kind: 'OPERATOR_BUDGET_CAPS', actor_id: admin.id } })) === 1 && (await prisma.ambOperatorEvent.count({ where: { kind: 'BUDGET_CAPS_CHANGE', actor_id: admin.id } })) === 1);
  ok('empty string clears a cap', (await BC.setBudgetCaps({ caps: { campaign: '' }, confirm: true, userId: admin.id })).campaign === null);

  console.log('\n2. Cap check (increase only)');
  const caps = { campaign: 800, product: 2000, account: 5000 };
  const chk = (delta, totals, action = 'SCALE_UP', c = caps) => BC.checkBudgetCaps({ action, delta, adAccountId: 'x', campaignId: 'c', deps: { caps: c, totals } });
  ok('within every cap → ok', (await chk(100, { campaign: 600, product: 1500, account: 4000 })).ok === true);
  const v1 = await chk(300, { campaign: 600, product: 1500, account: 4000 }); ok('campaign cap exceeded (600+300 > 800) → violation named', !v1.ok && v1.violations.length === 1 && v1.violations[0].level === 'campaign' && v1.violations[0].after === 900);
  const v2 = await chk(100, { campaign: 100, product: 1950, account: 4000 }); ok('product cap exceeded', !v2.ok && v2.violations[0].level === 'product');
  const v3 = await chk(100, { campaign: 100, product: 100, account: 4950 }); ok('account cap exceeded', !v3.ok && v3.violations[0].level === 'account');
  const v4 = await chk(500, { campaign: 700, product: 1900, account: 4900 }); ok('several caps can be exceeded at once', !v4.ok && v4.violations.length === 3);
  ok('a REDUCTION never violates a cap, even when the totals are already above', (await chk(-100, { campaign: 900, product: 2500, account: 6000 }, 'SCALE_DOWN')).ok === true && (await chk(-100, { campaign: 900, product: 2500, account: 6000 }, 'SCALE_UP')).ok === true);
  ok('no caps configured → ok without even loading totals', (await BC.checkBudgetCaps({ action: 'SCALE_UP', delta: 999, adAccountId: 'x', campaignId: 'c', deps: { caps: { campaign: null, product: null, account: null } } })).ok === true);

  console.log('\n3. The bridge honours the caps (prepare + execute) — zero Meta requests');
  const cfgOk = { mode: 'APPROVAL', emergency_stop: false, writesLocked: false, limits: { manualOverrideCooldownHours: 24 }, execPermissions: { open: false, pause: false, budgetIncrease: true, budgetDecrease: true } };
  const row = { campaignId: `${T}bc_c1`, product: 'fixture', productId: null, m3: { spend: 900, purchases: 12, cpa: 70 }, entity: { level: 'campaign', id: `${T}bc_e1`, budget: 300, name: null }, decision: 'WOULD_INCREASE', intended: { action: 'SCALE_UP', pct: 20, fromBudget: 300, toBudget: 360 }, wouldBe: 'PREPARED', primaryBlock: null, guards: [], requiresApproval: false, evidence: { cpa: 70 } };
  const evalStub = async () => ({ policy: BO.DEFAULT_POLICY, adAccountId: `${T}acc`, structureSource: 'META_LIVE', rows: [row] });
  const tight = { caps: { campaign: 330, product: null, account: null }, totals: { campaign: 300, product: null, account: 300 } };
  const p1 = await BX.prepareBudgetDecision({ campaignId: row.campaignId, userId: 1, deps: { config: cfgOk, evaluate: evalStub, persist: async () => ({ created: 0 }), capsDeps: tight } });
  ok('prepare: an increase above the campaign cap is refused (BUDGET_CAP) before anything is stored', p1.ok === false && p1.reason === 'BUDGET_CAP' && p1.violations[0].level === 'campaign');
  const p2 = await BX.prepareBudgetDecision({ campaignId: row.campaignId, userId: 1, deps: { config: cfgOk, evaluate: evalStub, persist: async () => ({ created: 0 }), capsDeps: { caps: { campaign: 999, product: null, account: null }, totals: { campaign: 300, product: null, account: 300 } } } });
  ok('prepare: within the cap it proceeds to persistence', p2.reason !== 'BUDGET_CAP' && p2.reason !== 'PERMISSION_OFF' && p2.reason !== 'NOT_ACTIONABLE');
  const d = await prisma.ambOperatorDecision.create({ data: { decision_key: `${T}bc-${Date.now()}`, status: 'PREPARED', store_id: 'trendy-storeee', product_id: null, ad_account_id: `${T}acc`, campaign_id: row.campaignId, campaign_name: `${T}cap camp`, action: 'SCALE_UP', rule_id: null, rule_name: 'DYNAMIC_BUDGET:DYN_SCALE_UP', mode_at_decision: 'APPROVAL', confidence: 'HIGH', blocked_codes_json: '[]', evidence_json: JSON.stringify({ history: {}, evidence: { cpa: 70 }, m3: { spend: 900, purchases: 12, cpa: 70 } }), why_json: '{}', params_json: JSON.stringify({ pct: 20, fromBudget: 300, toBudget: 360, level: 'campaign', entityId: `${T}bc_e1`, window: 'last3' }), before_json: '{}' } }); decisions.push(d.id);
  let execCalls = 0; const execStub = async () => { execCalls++; return { ok: false, aborted: true, message: 'stub' }; };
  const x1 = await BX.executeBudgetDecision({ decisionId: d.id, userId: 1, deps: { config: cfgOk, evaluate: evalStub, policy: BO.DEFAULT_POLICY, approveAndExecute: execStub, capsDeps: tight } });
  ok('execute: re-checked at execution time → BLOCKED (BUDGET_CAP), decision stays PREPARED, the executor is never called', x1.blocked === 'BUDGET_CAP' && execCalls === 0 && (await prisma.ambOperatorDecision.findUnique({ where: { id: d.id } })).status === 'PREPARED');
  const x2 = await BX.executeBudgetDecision({ decisionId: d.id, userId: 1, deps: { config: cfgOk, evaluate: evalStub, policy: BO.DEFAULT_POLICY, approveAndExecute: execStub, capsDeps: { caps: { campaign: 999, product: null, account: null }, totals: { campaign: 300, product: null, account: 300 } } } });
  ok('execute: within the caps the normal path continues (reaches the executor, which here refuses — stub)', x2.blocked !== 'BUDGET_CAP' && execCalls === 1);

  console.log('\n4. HTTP surface');
  const tok = (u, role) => jwt.sign({ id: u.id, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const app = express(); app.use(cookieParser()); app.use(express.json()); app.use('/api/operator', operatorRoutes); app.use(errorHandler);
  const server = await new Promise((rs) => { const s = app.listen(0, '127.0.0.1', () => rs(s)); }); const base = `http://127.0.0.1:${server.address().port}/api/operator`;
  const call = async (method, path, body, u, role) => { const x = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(u ? { Cookie: `token=${tok(u, role)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); let json = null; try { json = await x.json(); } catch { /* */ } return { status: x.status, json }; };
  try {
    ok('MANAGER can read caps; cannot change (403)', (await call('GET', '/budget-caps', undefined, mgr, 'MANAGER')).status === 200 && (await call('PUT', '/budget-caps', { caps: { account: 1 }, confirm: true }, mgr, 'MANAGER')).status === 403);
    ok('ADMIN without confirm → 400; with confirm → 200', (await call('PUT', '/budget-caps', { caps: { account: 7000 } }, admin, 'ADMIN')).status === 400 && (await call('PUT', '/budget-caps', { caps: { account: 7000 }, confirm: true }, admin, 'ADMIN')).json.caps.account === 7000);
    ok('smart-alerts/run is ADMIN-only', (await call('POST', '/smart-alerts/run', {}, mgr, 'MANAGER')).status === 403);
  } finally { server.close(); }

  console.log('\n5. Smart Alerts — detection (pure)');
  const now = new Date('2031-06-10T10:00:00Z');
  const rows = [
    { campaign: 'spiky', campaignId: `${T}sa1`, m3: { spend: 900, purchases: 5, cpa: 180 }, m7: { cpa: 90 }, mapping: 'VERIFIED', guards: [] },
    { campaign: 'zero', campaignId: `${T}sa2`, m3: { spend: 450, purchases: 0, cpa: null }, m7: { cpa: 120 }, mapping: 'VERIFIED', guards: [] },
    { campaign: 'nomap', campaignId: `${T}sa3`, m3: { spend: 400, purchases: 4, cpa: 100 }, m7: { cpa: 100 }, mapping: 'UNMAPPED', guards: [] },
    { campaign: 'nostock', campaignId: `${T}sa4`, m3: { spend: 300, purchases: 3, cpa: 100 }, m7: { cpa: 100 }, mapping: 'VERIFIED', guards: ['STOCK_OUT[B]'] },
    { campaign: 'fine', campaignId: `${T}sa5`, m3: { spend: 600, purchases: 6, cpa: 100 }, m7: { cpa: 105 }, mapping: 'VERIFIED', guards: ['STOCK_UNKNOWN[W]'] },
  ];
  const all = SA.detectSmartAlerts({ now, rows, syncRuns: [{ status: 'FAILED', error: 'boom' }, { status: 'FAILED', error: 'boom' }], syncStatus: { lastSuccessAt: new Date(now.getTime() - 60 * 60_000) }, manualBudgetEvents: [{ id: 99, campaignId: `${T}sa5`, campaignName: 'fine', note: 'ميزانية 300 → 450' }], actions: [{ id: 7, type: 'PAUSE', failed: true, name: 'x', campaignId: `${T}sa1` }, { id: 8, type: 'INCREASE_BUDGET', failed: false, name: 'y', campaignId: `${T}sa2` }], caps: { account: 1000 }, accountBudgetTotal: 1500, external: { detected: true, changes: 57, campaigns: 16 } });
  const types = new Set(all.map((a) => a.type));
  ok('all ten situations are detected', SA.SMART_ALERT_TYPES.every((t) => types.has(t)), [...types].join());
  ok('CPA spike only for the real spike (3d ≥ 1.5× the 7d, ≥3 orders, ≥300 spend)', all.filter((a) => a.type === 'CPA_SPIKE').map((a) => a.campaignId).join() === `${T}sa1`);
  ok('zero orders with spend only for the campaign over the limit', all.filter((a) => a.type === 'ZERO_ORDERS_WITH_SPEND').map((a) => a.campaignId).join() === `${T}sa2`);
  ok('a healthy campaign with only a stock-UNKNOWN warning raises nothing', !all.some((a) => a.campaignId === `${T}sa5` && ['CPA_SPIKE', 'ZERO_ORDERS_WITH_SPEND', 'CONFIRMED_STOCK_OUT'].includes(a.type)));
  ok('failed action = CRITICAL, unverified = WARNING', all.find((a) => a.key === 'smart:ACTION:7:F').severity === 'CRITICAL' && all.find((a) => a.key === 'smart:ACTION:8:U').severity === 'WARNING');
  ok('sync failure needs TWO failed runs in a row; stale data only past 3× the interval', SA.detectSmartAlerts({ now, syncRuns: [{ status: 'FAILED' }, { status: 'SUCCESS' }] }).length === 0 && SA.detectSmartAlerts({ now, syncStatus: { lastSuccessAt: new Date(now.getTime() - 20 * 60_000) } }).length === 0);
  ok('account cap alert only when the total is above the cap', SA.detectSmartAlerts({ now, caps: { account: 2000 }, accountBudgetTotal: 1500 }).length === 0);
  ok('dedupe keys are stable for the same condition and day', JSON.stringify(SA.detectSmartAlerts({ now, rows }).map((a) => a.key)) === JSON.stringify(SA.detectSmartAlerts({ now: new Date(now.getTime() + 3_600_000), rows }).map((a) => a.key)));
  ok('the next day gets new keys (a persisting problem reminds once a day)', SA.detectSmartAlerts({ now, rows })[0].key !== SA.detectSmartAlerts({ now: new Date(now.getTime() + 86_400_000), rows })[0].key);
  ok('nothing detected from empty inputs', SA.detectSmartAlerts({ now }).length === 0);

  console.log('\n6. Smart Alerts — raised through AmbAlert, never duplicated');
  const inputs = { syncRuns: [{ status: 'FAILED', error: 'boom' }, { status: 'FAILED', error: 'boom' }], syncStatus: { lastSuccessAt: new Date(now.getTime() - 60 * 60_000), intervalMinutes: 15 }, manualBudgetEvents: [], actions: [], caps: { campaign: null, product: null, account: null }, accountBudgetTotal: null, external: null };
  const r1 = await SA.runSmartAlerts({ now, rows, deps: inputs }); (r1.keys || []).forEach((k) => keys.add(k));
  const c1 = await prisma.ambAlert.count({ where: { dedupe_key: { in: r1.keys || [] } } });
  const r2 = await SA.runSmartAlerts({ now: new Date(now.getTime() + 600_000), rows, deps: inputs });
  const c2 = await prisma.ambAlert.count({ where: { dedupe_key: { in: r1.keys || [] } } });
  ok('first run raises one alert per condition; the second run (10 min later) adds NONE (deduped)', r1.raised === r1.detected && c1 === r1.detected && c2 === c1 && r2.detected === r1.detected, `${r1.detected}/${c1}/${c2}`);
  const src = fs.readFileSync(join(__dirname, '../services/amb/smartAlerts.js'), 'utf8');
  ok('smart alerts can only raise alerts: no executor / Meta client imports', !/executor|metaGraphClient|approveAndExecute|setEntity|graphPost/.test(src.split('\n').filter((l) => /^\s*import\b/.test(l) || /await import\(/.test(l)).join(' ')));
  ok('the operator scheduler runs them each cycle (alerts only)', /runSmartAlerts/.test(fs.readFileSync(join(__dirname, '../services/amb/operatorScheduler.js'), 'utf8')));
} catch (e) {
  fail++; console.log('  ✗ UNEXPECTED', e.stack || e.message);
} finally {
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: raw0.limits_json } }).catch(() => {});
  await prisma.ambAlert.deleteMany({ where: { OR: [{ dedupe_key: { in: [...keys] } }, { dedupe_key: { contains: '2031-06' } }, { campaign_id: { startsWith: T } }, { entity_id: { startsWith: T } }, { title: { contains: T } }, { message: { contains: T } }, { ad_account_id: `${T}acc` }] } }).catch(() => {});
  const recs = await prisma.ambRecommendation.findMany({ where: { OR: [{ batch_id: { in: decisions.map((i) => `operator-budget-${i}`) } }, { ad_account_id: `${T}acc` }, { entity_id: { startsWith: T } }] }, select: { id: true } });
  await prisma.ambActionResult.deleteMany({ where: { action: { recommendation_id: { in: recs.map((r) => r.id) } } } }).catch(() => {});
  await prisma.ambAction.deleteMany({ where: { recommendation_id: { in: recs.map((r) => r.id) } } }).catch(() => {});
  await prisma.ambRecommendation.deleteMany({ where: { id: { in: recs.map((r) => r.id) } } }).catch(() => {});
  await prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ decision_id: { in: decisions } }, { actor_id: { in: users } }, { campaign_id: { startsWith: T } }] } }).catch(() => {});
  await prisma.ambOperatorDecision.deleteMany({ where: { OR: [{ id: { in: decisions } }, { campaign_id: { startsWith: T } }] } }).catch(() => {});
  await prisma.aiAuditLog.deleteMany({ where: { actor_id: { in: users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  const restored = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } });
  console.log(`\nSAFETY: operator config restored exactly: ${restored.limits_json === raw0.limits_json} | Meta calls in this test = 0`);
  console.log(`\n${fail === 0 ? '✅' : '❌'} budgetCapsAndAlertsTest: ${pass} passed, ${fail} failed`);
  await prisma.$disconnect(); process.exit(fail ? 1 : 0);
}
