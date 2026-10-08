// 🧪 The OFFICIAL approval path for budget decisions: real Express routes (POST /decisions/:id/approve, /budget-optimizer/prepare, history) with real JWT users; only the Meta write is a stub.
// ADMIN-only, revalidation before the write, read-back after, VERIFIED + 48h cooldown visible, Autopilot impossible. No Meta call anywhere. Disposable "__optest_" fixtures.
//   node src/scripts/budgetApprovalRouteTest.js
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
const retryDb = async (fn) => { for (let i = 0; i < 10; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 4000)); } } return fn(); };
if (!process.env.JWT_SECRET) { console.log('JWT_SECRET missing'); process.exit(2); }
const { prisma } = await imp('../prisma.js');
const BX = await imp('../services/amb/budgetExecution.js'); const BO = await imp('../services/amb/budgetOptimizer.js'); const S = await imp('../services/amb/operatorStore.js'); const EN = await imp('../services/amb/operatorEngine.js');
const { default: operatorRoutes } = await imp('../routes/operator.js'); const { errorHandler } = await imp('../middleware/errorHandler.js');
const T = '__optest_'; const created = { users: [] };
const realCfg = await S.getOperatorConfig();
const c0 = { actions: await prisma.ambAction.count(), decisions: await prisma.ambOperatorDecision.count(), recs: await prisma.ambRecommendation.count() };
const cfg = (o = {}) => ({ mode: 'APPROVAL', emergency_stop: false, writesLocked: false, limits: realCfg.limits, ...o });
let seq = 0, execCalls = 0, lastArgs = null;
const mkDecision = async (o = {}) => {
  const n = ++seq; const entityId = `${T}e${n}`, campaignId = `${T}c${n}`;
  const d = await retryDb(() => prisma.ambOperatorDecision.create({ data: { decision_key: `${T}k${n}-${Date.now()}`, status: 'PREPARED', store_id: 'trendy-storeee', product_id: null, ad_account_id: `${T}acc`, campaign_id: campaignId, campaign_name: `${T}campaign ${n}`, action: o.action || 'SCALE_DOWN', rule_id: null, rule_name: 'DYNAMIC_BUDGET:DYN_HIGH_CPA_REDUCE', mode_at_decision: 'APPROVAL', confidence: 'HIGH', blocked_codes_json: '[]', evidence_json: JSON.stringify({ history: {}, evidence: { cpa: 204, spend: 611, purchases: 3 }, m3: { spend: 815, purchases: 4, cpa: 204 } }), why_json: JSON.stringify({ why: 'fixture' }), params_json: JSON.stringify({ pct: 20, fromBudget: 300, toBudget: 240, level: 'campaign', entityId, window: 'last3' }), before_json: '{}' } }));
  return { d, entityId, campaignId };
};
const freshRow = (m) => ({ campaignId: m.campaignId, product: 'fixture', m3: { spend: 815, purchases: 4, cpa: 204 }, entity: { level: 'campaign', id: m.entityId, budget: 300, name: null }, decision: 'WOULD_REDUCE', intended: { action: 'SCALE_DOWN', pct: 20, fromBudget: 300, toBudget: 240 }, wouldBe: 'PREPARED', primaryBlock: null, guards: [], requiresApproval: false, evidence: { cpa: 204 } });
const stubExec = async (args) => {
  execCalls++; lastArgs = args; const rec = await prisma.ambRecommendation.findUnique({ where: { id: args.recId } });
  const a = await prisma.ambAction.create({ data: { recommendation_id: rec.id, mode: args.mode, action_type: rec.action_type, ad_account_id: rec.ad_account_id, level: rec.level, entity_id: rec.entity_id, campaign_id: rec.campaign_id, approval_status: 'APPROVED', execution_status: 'EXECUTED', executed_at: new Date(), verified_at: new Date(), old_value_json: JSON.stringify({ budget: 300 }), new_value_json: JSON.stringify({ budget: 240 }), meta_request_json: JSON.stringify({ id: rec.entity_id, dailyBudgetMinor: 24000 }), verify_json: JSON.stringify({ verified: true, live: { budgetMajor: 240 } }) } });
  await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'EXECUTED' } }); return { ok: true, actionId: a.id };
};
const hook = (m, c = cfg()) => BX.__setBudgetExecutionTestDeps({ config: c, evaluate: async () => ({ policy: BO.DEFAULT_POLICY, adAccountId: `${T}acc`, structureSource: 'META_LIVE', rows: m ? [freshRow(m)] : [] }), approveAndExecute: stubExec, policy: BO.DEFAULT_POLICY });
const app = express(); app.use(cookieParser()); app.use(express.json()); app.use('/api/operator', operatorRoutes); app.use(errorHandler);
const server = await new Promise((rs) => { const s = app.listen(0, '127.0.0.1', () => rs(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/operator`;
const call = async (method, path, body, token) => { const x = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Cookie: `token=${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); let json = null; try { json = await x.json(); } catch { /* */ } return { status: x.status, json }; };
const mkUser = async (role, tag) => { const u = await prisma.user.create({ data: { email: `${T}ba_${tag}_${Date.now()}@example.invalid`, password_hash: 'x'.repeat(20), name: `${T}${tag}`, role, status: 'ACTIVE', permissions: '{}' } }); created.users.push(u.id); return { user: u, token: jwt.sign({ id: u.id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' }) }; };
const stat = async (m) => (await prisma.ambOperatorDecision.findUnique({ where: { id: m.d.id } })).status;

try {
  const admin = await mkUser('ADMIN', 'admin'), mgr = await mkUser('MANAGER', 'mgr');
  console.log('\n1. who may approve a budget action');
  let m = await mkDecision(); hook(m); execCalls = 0;
  let r = await call('POST', `/decisions/${m.d.id}/approve`, {});
  ok('no login => 401, nothing happens', r.status === 401 && (await stat(m)) === 'PREPARED' && execCalls === 0);
  r = await call('POST', `/decisions/${m.d.id}/approve`, {}, mgr.token);
  ok('a MANAGER cannot approve a budget action (403), the decision stays PREPARED, no Meta stub call', r.status === 403 && (await stat(m)) === 'PREPARED' && execCalls === 0, JSON.stringify(r));
  try { await BX.executeBudgetDecision({ decisionId: m.d.id, userId: mgr.user.id, deps: { config: cfg() } }); ok('defence in depth: the service itself refuses a non-ADMIN user', false); } catch (e) { ok('defence in depth: calling the service directly with a non-ADMIN user is refused too (403)', e.status === 403 && execCalls === 0); }
  const inactive = await prisma.user.create({ data: { email: `${T}ba_off_${Date.now()}@example.invalid`, password_hash: 'x'.repeat(20), name: `${T}off`, role: 'ADMIN', status: 'DISABLED', permissions: '{}' } }); created.users.push(inactive.id);
  try { await BX.executeBudgetDecision({ decisionId: m.d.id, userId: inactive.id, deps: { config: cfg() } }); ok('a disabled ADMIN account is refused', false); } catch (e) { ok('a disabled ADMIN account is refused (403)', e.status === 403); }

  console.log('\n2. the gates still apply on the official route (global mode SHADOW / write lock) — NO Meta write');
  hook(m, cfg({ mode: 'SHADOW' })); execCalls = 0;
  r = await call('POST', `/decisions/${m.d.id}/approve`, {}, admin.token);
  ok('ADMIN approves while the global mode is SHADOW => BLOCKED (MODE_NOT_APPROVAL), decision stays PREPARED, nothing sent, nothing created', r.status === 200 && r.json.status === 'BLOCKED' && r.json.blocked === 'MODE_NOT_APPROVAL' && r.json.executed === false && (await stat(m)) === 'PREPARED' && execCalls === 0 && (await prisma.ambRecommendation.count({ where: { ad_account_id: `${T}acc` } })) === 0, JSON.stringify(r.json));
  hook(m, cfg({ writesLocked: true }));
  r = await call('POST', `/decisions/${m.d.id}/approve`, {}, admin.token);
  ok('ADMIN approves with the write lock closed => BLOCKED (META_WRITES_LOCKED)', r.json.status === 'BLOCKED' && r.json.blocked === 'META_WRITES_LOCKED' && execCalls === 0 && (await stat(m)) === 'PREPARED');
  hook(m, cfg({ mode: 'AUTOPILOT' }));
  r = await call('POST', `/decisions/${m.d.id}/approve`, {}, admin.token);
  ok('global mode AUTOPILOT can never execute through this path', r.json.status === 'BLOCKED' && r.json.blocked === 'AUTOPILOT_NOT_ALLOWED_HERE' && execCalls === 0);
  hook(m, cfg({ emergency_stop: true }));
  r = await call('POST', `/decisions/${m.d.id}/approve`, {}, admin.token);
  ok('Emergency Stop blocks it', r.json.blocked === 'EMERGENCY_STOP' && execCalls === 0);
  const up = await mkDecision({ action: 'SCALE_UP' }); hook(up, cfg({ execPermissions: { open: false, pause: false, budgetIncrease: false, budgetDecrease: true } }));
  r = await call('POST', `/decisions/${up.d.id}/approve`, {}, admin.token);
  ok('an INCREASE budget decision is refused until the budgetIncrease permission is ON', r.json.blocked === 'PERMISSION_OFF' && (await stat(up)) === 'PREPARED' && execCalls === 0);
  const ap = await EN.executeDecision({ decisionId: m.d.id, source: 'AUTOPILOT', userId: null, deps: {} });
  ok('executeDecision from AUTOPILOT / the scheduler is refused for budget decisions', ap.ok === false && ap.executed === false && execCalls === 0 && (await stat(m)) === 'PREPARED', JSON.stringify(ap));

  console.log('\n3. the approved flow (APPROVAL mode, lock open for the stubbed run): revalidate -> write -> read-back -> VERIFIED + 48h cooldown');
  hook(m); execCalls = 0;
  r = await call('POST', `/decisions/${m.d.id}/approve`, {}, admin.token);
  ok('ADMIN approval executes ONE stubbed write in APPROVAL mode by that admin; result VERIFIED', r.status === 200 && r.json.ok === true && r.json.status === 'VERIFIED' && r.json.verified === true && execCalls === 1 && lastArgs.mode === 'APPROVAL' && lastArgs.userId === admin.user.id, JSON.stringify(r.json).slice(0, 300));
  ok('stages: requested → sent (exact request 24000) → read-back (240) → VERIFIED → cooldown 48h', !!r.json.stages.requested && r.json.stages.sentToMeta.request.dailyBudgetMinor === 24000 && r.json.stages.readBack.liveBudgetAfter === 240 && r.json.stages.verified === 'VERIFIED' && r.json.stages.cooldown.hours === 48);
  let g = await call('GET', `/decisions/${m.d.id}`, undefined, mgr.token);
  const dd = g.json.decision || g.json;
  ok('GET /decisions/:id shows VERIFIED, approver, before → after, and the 48h cooldown (active)', dd.status === 'VERIFIED' && dd.approvedById === admin.user.id && dd.before?.budget === 300 && dd.after?.budget === 240 && dd.cooldown?.hours === 48 && dd.cooldown.active === true && Math.abs(new Date(dd.cooldown.until) - new Date(dd.executedAt) - 48 * 3_600_000) < 1000, JSON.stringify([dd.status, dd.cooldown]));
  g = await call('GET', '/decisions?bucket=history&limit=200', undefined, mgr.token);
  const inHist = (g.json.decisions || []).find((x) => x.id === m.d.id);
  ok('it appears in the execution history (سجل التنفيذ) as VERIFIED with its cooldown', inHist?.status === 'VERIFIED' && inHist.isBudgetDecision === true && inHist.cooldown?.hours === 48);
  g = await call('GET', '/budget-optimizer/history?limit=200', undefined, mgr.token);
  const inBo = g.json.history.find((x) => x.id === m.d.id);
  ok('the budget action history shows verified=true, the approver and cooldownUntil (executed + 48h)', inBo?.verified === true && inBo.approvedById === admin.user.id && inBo.cooldownHours === 48 && Math.abs(new Date(inBo.cooldownUntil) - new Date(inBo.executedAt) - 48 * 3_600_000) < 1000 && inBo.beforeBudget === 300 && inBo.afterBudget === 240);
  r = await call('POST', `/decisions/${m.d.id}/approve`, {}, admin.token);
  ok('approving it a second time does nothing (executes once)', r.json.executed === false && execCalls === 1);
  const lc = await BO.loadLastBudgetChanges({ entityIds: [m.entityId], campaignIds: [m.campaignId] });
  ok('the optimizer treats it as the entity\'s last change => the next decision is a COOLDOWN', BO.classifyBudget({ m: { spend: 900, purchases: 4, cpa: 225 }, lastChange: lc.get(m.entityId), since: { spend: 500, purchases: 1, cpa: 500 }, now: new Date() }).zone === 'COOLDOWN');

  console.log('\n4. revalidation before the write (official route)');
  const m2 = await mkDecision(); BX.__setBudgetExecutionTestDeps({ config: cfg(), evaluate: async () => ({ policy: BO.DEFAULT_POLICY, adAccountId: `${T}acc`, structureSource: 'META_LIVE', rows: [{ ...freshRow(m2), entity: { level: 'campaign', id: m2.entityId, budget: 250 } }] }), approveAndExecute: stubExec, policy: BO.DEFAULT_POLICY }); execCalls = 0;
  r = await call('POST', `/decisions/${m2.d.id}/approve`, {}, admin.token);
  ok('the live budget moved (250 instead of 300) => EXPIRED at approval time, nothing sent', r.json.status === 'EXPIRED' && r.json.reasons.some((x) => x.code === 'BUDGET_CHANGED') && execCalls === 0 && (await stat(m2)) === 'EXPIRED');
  const m3 = await mkDecision(); BX.__setBudgetExecutionTestDeps({ config: cfg(), evaluate: async () => ({ policy: BO.DEFAULT_POLICY, adAccountId: `${T}acc`, structureSource: 'META_SYNC_SNAPSHOT (live unavailable)', rows: [freshRow(m3)] }), approveAndExecute: stubExec, policy: BO.DEFAULT_POLICY });
  r = await call('POST', `/decisions/${m3.d.id}/approve`, {}, admin.token);
  ok('Meta could not be read live => EXPIRED (NO_LIVE_DATA), nothing sent', r.json.status === 'EXPIRED' && r.json.reasons.some((x) => x.code === 'NO_LIVE_DATA') && execCalls === 0);

  console.log('\n5. preparing a budget decision');
  BX.__setBudgetExecutionTestDeps({ config: cfg({ mode: 'SHADOW' }), evaluate: async () => ({ rows: [] }) });
  r = await call('POST', '/budget-optimizer/prepare', { campaignId: `${T}cx` }, mgr.token);
  ok('a MANAGER cannot prepare (403)', r.status === 403);
  r = await call('POST', '/budget-optimizer/prepare', { campaignId: `${T}cx` }, admin.token);
  ok('ADMIN in SHADOW mode: prepare is refused (MODE_NOT_APPROVAL) — the global mode must be switched by the owner first', r.status === 200 && r.json.ok === false && r.json.reason === 'MODE_NOT_APPROVAL');

  console.log('\n6. safety');
  BX.__setBudgetExecutionTestDeps(null);
  const cfg2 = await S.getOperatorConfig();
  ok('real mode / emergency stop / write lock untouched; this test cannot reach Meta (executor is a stub)', cfg2.mode === realCfg.mode && cfg2.emergency_stop === realCfg.emergency_stop && cfg2.writesLocked === realCfg.writesLocked && S.metaWritesLocked() === true);
  const own = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  ok('the test imports neither the executor nor the Meta client', !/^import[^\n]*(executor|metaGraphClient)/m.test(own) && !/await imp\('[^']*(executor|metaGraphClient)/.test(own));
} catch (e) { fail++; console.log('  ✗ test crashed —', e.stack || e.message); }
finally {
  try {
    server.close();
    await retryDb(() => prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ campaign_id: { startsWith: T } }, { actor_id: { in: created.users } }] } }));
    await retryDb(() => prisma.ambAction.deleteMany({ where: { ad_account_id: `${T}acc` } }));
    await retryDb(() => prisma.ambOperatorDecision.deleteMany({ where: { OR: [{ decision_key: { startsWith: T } }, { campaign_id: { startsWith: T } }] } }));
    await retryDb(() => prisma.ambRecommendation.deleteMany({ where: { ad_account_id: `${T}acc` } }));
    await retryDb(() => prisma.ambAlert.deleteMany({ where: { OR: [{ entity_id: { startsWith: T } }, { ad_account_id: `${T}acc` }] } }));
    await retryDb(() => prisma.aiAuditLog.deleteMany({ where: { actor_id: { in: created.users } } }));
    await retryDb(() => prisma.user.deleteMany({ where: { id: { in: created.users } } }));
    ok('cleanup: fixtures gone; AMB actions / decisions / recommendations are back to their original counts', (await prisma.ambAction.count()) === c0.actions && (await prisma.ambOperatorDecision.count()) === c0.decisions && (await prisma.ambRecommendation.count()) === c0.recs);
  } catch (e) { fail++; console.log('  ✗ cleanup failed —', e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
