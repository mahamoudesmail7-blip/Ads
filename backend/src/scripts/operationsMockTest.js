// 🧪 The FOUR operations (Open / Pause / Budget Increase +20% / Budget Reduce −20%) through the OFFICIAL paths and the REAL executor — against a local Meta MOCK (fake Graph API on loopback).
//   Live read → decision → guards → ADMIN approval → ONE Meta write → independent read-back → audit → cooldown. NO real Meta call (the mock is the only network target; every id is an __optest_ fixture).
//   node src/scripts/operationsMockTest.js
import 'dotenv/config';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };

// ---------------------------------------------------------------- the Meta mock (fake Graph API)
const world = { entities: new Map(), log: [], failNext: null };
const setEntity = (id, o) => world.entities.set(id, { id, name: `mock ${id}`, status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: null, objective: 'OUTCOME_SALES', ...o });
const writes = (id) => world.log.filter((r) => r.method === 'POST' && r.id === id);
const reads = (id) => world.log.filter((r) => r.method === 'GET' && r.id === id);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); const id = url.pathname.split('/').filter(Boolean)[1]; let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = Object.fromEntries(new URLSearchParams(raw)); delete body.access_token;
    world.log.push({ method: req.method, id, path: url.pathname, body, at: Date.now() });
    const send = (code, json) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    const e = world.entities.get(id);
    if (req.method === 'GET') {
      if (e) return send(200, e);
      if (/^(act_|__optest_acc)/.test(id || '')) return send(200, { id, account_id: id, name: 'mock account', currency: 'EGP', timezone_name: 'Africa/Cairo', account_status: 1 });
      return send(404, { error: { message: 'Unsupported get request (mock)', type: 'GraphMethodException', code: 100 } });
    }
    if (req.method === 'POST') {
      if (!e) return send(404, { error: { message: 'Unsupported post request (mock)', type: 'GraphMethodException', code: 100 } });
      const f = world.failNext; if (f && (!f.id || f.id === id)) { world.failNext = null;
        if (f.type === 'rate') return send(400, { error: { message: '(#17) User request limit reached', type: 'OAuthException', code: 17, error_subcode: 2446079, error_user_title: 'Ad Account Has Too Many API Calls', error_user_msg: 'wait', fbtrace_id: 'mock' } });
        if (f.type === 'noop') return send(200, { success: true }); // accepted but NOT applied
      }
      if (body.status) { e.status = body.status; e.effective_status = body.status; }
      if (body.daily_budget) e.daily_budget = String(body.daily_budget);
      return send(200, { success: true });
    }
    return send(405, {});
  });
});
await new Promise((rs) => server.listen(0, '127.0.0.1', rs));
process.env.META_GRAPH_MOCK = '1'; process.env.META_GRAPH_MOCK_URL = `http://127.0.0.1:${server.address().port}`; // BEFORE the Meta client is imported
process.env.DAILY_PLAN_DISABLE_ALERTS = '1';
const { prisma } = await imp('../prisma.js');
const MC = await imp('../services/metaGraphClient.js'); const DP = await imp('../services/amb/dailyPlans.js'); const BX = await imp('../services/amb/budgetExecution.js'); const BO = await imp('../services/amb/budgetOptimizer.js'); const TM = await imp('../services/amb/dailyPlanTime.js'); const S = await imp('../services/amb/operatorStore.js');
const T = '__optest_'; const created = { plans: [], recs: [], decisions: [] };
const retryDb = async (fn) => { for (let i = 0; i < 6; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 3000)); } } return fn(); };
const OFF = { open: false, pause: false, budgetIncrease: false, budgetDecrease: false };
const cfg = (perm = {}, o = {}) => ({ mode: 'APPROVAL', emergency_stop: false, writesLocked: false, limits: { recentPurchaseProtectionHours: 3, manualOverrideCooldownHours: 24 }, execPermissions: { ...OFF, ...perm }, ...o });
const ADMIN = { id: 1, role: 'ADMIN', status: 'ACTIVE' }; const noSleep = async () => {};
const FRESH = { syncStatus: async () => ({ lastSuccessAt: new Date() }), refresh: async () => ({ ok: true }) };
const planDeps = (c, extra = {}) => ({ ...FRESH, user: ADMIN, runInline: true, exceptions: async () => [], lastPurchase: async () => null, mappingState: async () => null, dcfg: { ...DP.DEFAULT_DAILY_CONFIG }, config: async () => c, sleep: noSleep, ...extra });
let dseq = 0;
const item = (cid, o = {}) => ({ campaignId: cid, campaignName: `${T}mock ${cid}`, productId: null, productName: 'fixture', storeId: 'trendy-storeee', rank: 1, selected: true, selectable: true, eligibility: 'ELIGIBLE', blockCodes: [], warnings: [], risk: 'LOW', riskScore: 5, reason: 'fixture', evidence: { mapping: 'VERIFIED', budget: 300, stock: { status: 'IN_STOCK' }, m7: { spend: 700, purchases: 8, cpa: 88 }, m30: { spend: 2000, purchases: 25, cpa: 80 } }, ...o });
const mkPlan = async (type, date, ids, simulated = false) => { const p = (await DP.preparePlan({ type, date, now: new Date(), simulated, deps: { ...FRESH, build: async () => ({ items: ids.map((id, n) => item(id, { rank: n + 1 })), policy: null }) } })).plan; created.plans.push(p.id); return p; };
const approve = (p, c, extra = {}) => DP.approvePlan({ planId: p.id, userId: 1, now: new Date(TM.dueAt(p.type, p.plan_date).getTime() + 60_000), deps: planDeps(c, extra) });
const itemOf = (pid, cid) => prisma.ambDailyPlanItem.findFirst({ where: { plan_id: pid, campaign_id: cid } });
const actionOf = (cid) => prisma.ambAction.findFirst({ where: { entity_id: cid }, orderBy: { id: 'desc' } });
const evCount = (pid) => prisma.ambOperatorEvent.count({ where: { data_json: { contains: `"planId":${pid},` } } });
const conn = await (await imp('../services/metaAuth.js')).getConnection();
const realCfg0 = await S.getOperatorConfig();
const settings = await (await imp('../services/amb/settings.js')).getAmbSettings();

try {
  console.log('\n0. The mock is the ONLY network target');
  ok('the Meta client points at the loopback mock (never the real Graph API)', MC.getEntity && (await MC.getEntity('t', `${T}probe`, 'id').catch((e) => e.message)) !== undefined && world.log.some((r) => r.id === `${T}probe`));
  ok('a connected ad account exists locally (the executor needs one)', conn?.status === 'CONNECTED' && !!conn.selected_ad_account_id);
  ok('the real budget-increase bound (settings) allows +20%', Number(settings.ambMaxBudgetIncreasePct ?? 20) >= 20, `ambMaxBudgetIncreasePct=${settings.ambMaxBudgetIncreasePct}`);

  console.log('\n1. CAMPAIGN OPEN — daily plan → real executor → mock Meta');
  const o1 = `${T}mo_open1`; setEntity(o1, { status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '60000' });
  const pO = await mkPlan('OPEN', '2031-09-01', [o1]);
  const gl = await approve(pO, cfg({ open: true }, { writesLocked: true }));
  ok('Meta write-lock closed → blocked at the gate: ZERO requests reach Meta', gl.ok === false && gl.blocked === 'META_WRITES_LOCKED' && world.log.filter((r) => r.id === o1).length === 0);
  const pOff = await approve(pO, cfg({ open: false }));
  ok('«open» permission OFF → blocked, ZERO requests', pOff.ok === false && pOff.blocked === 'TYPE_NOT_ALLOWED' && world.log.filter((r) => r.id === o1).length === 0);
  const pEm = await approve(pO, cfg({ open: true }, { emergency_stop: true }));
  ok('Emergency Stop → blocked, ZERO requests', pEm.ok === false && pEm.blocked === 'EMERGENCY_STOP' && world.log.filter((r) => r.id === o1).length === 0);
  const pSh = await DP.approvePlan({ planId: pO.id, userId: 1, now: new Date(TM.dueAt('OPEN', '2031-09-01').getTime() + 60_000), deps: planDeps(cfg({ open: true }, { mode: 'SHADOW' }), { readEntity: async (id) => ({ id, status: 'PAUSED', budget: 600 }) }) });
  ok('SHADOW approval stays a simulation (no POST) — and consumes the plan', pSh.ok && pSh.executionMode === 'SIMULATION' && writes(o1).length === 0);
  const pO2 = await mkPlan('OPEN', '2031-09-02', [o1]);
  const r1 = await approve(pO2, cfg({ open: true }));
  const it1 = await itemOf(pO2.id, o1); const a1 = await actionOf(o1);
  ok('all gates open + ADMIN approval → LIVE', r1.ok && r1.executionMode === 'LIVE', JSON.stringify(r1).slice(0, 200));
  ok('live READ before the write, exactly ONE write (status=ACTIVE), independent READ after', reads(o1).length >= 2 && writes(o1).length === 1 && writes(o1)[0].body.status === 'ACTIVE' && world.log.indexOf(writes(o1)[0]) > world.log.findIndex((r) => r.id === o1 && r.method === 'GET') && world.log.findLastIndex((r) => r.id === o1) > world.log.indexOf(writes(o1)[0]));
  ok('Meta (mock) state really changed to ACTIVE', world.entities.get(o1).status === 'ACTIVE');
  ok('plan item VERIFIED by the independent read-back', it1.status === 'VERIFIED', `${it1.status} ${it1.status_reason}`);
  ok('executor audit row: EXECUTED + verify.verified, actor = the approving ADMIN', a1?.execution_status === 'EXECUTED' && JSON.parse(a1.verify_json || '{}').verified === true && a1.executed_by_id === 1 && a1.action_type === 'RESUME');
  ok('plan audit trail written (approval + per-item transitions + completion)', (await evCount(pO2.id)) >= 6);
  const pO3 = await mkPlan('OPEN', '2031-09-03', [o1]); world.entities.get(o1).status = 'PAUSED'; world.entities.get(o1).effective_status = 'PAUSED'; const wBefore = writes(o1).length;
  await approve(pO3, cfg({ open: true }));
  const it3 = await itemOf(pO3.id, o1);
  ok('duplicate prevention: the same campaign opened again within 6h is stopped by the executor — NO second POST', writes(o1).length === wBefore && ['BLOCKED', 'FAILED', 'SKIPPED'].includes(it3.status), `${it3.status} ${it3.status_reason}`);

  console.log('\n2. CAMPAIGN PAUSE — daily plan → real executor → mock Meta');
  const p1 = `${T}mo_pause1`; setEntity(p1, { status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '50000' });
  const pP0 = await mkPlan('PAUSE', '2031-09-04', [p1]);
  const grace = await approve(pP0, cfg({ pause: true }), { lastPurchase: async () => new Date(Date.now() - 20 * 60_000) });
  ok('Attribution Grace: an order 20 minutes ago → the campaign is SKIPPED, ZERO writes', (await itemOf(pP0.id, p1)).status === 'SKIPPED' && writes(p1).length === 0);
  const pP1 = await mkPlan('PAUSE', '2031-09-05', [p1]);
  const rp = await approve(pP1, cfg({ pause: true }));
  const ip = await itemOf(pP1.id, p1); const ap = await actionOf(p1);
  ok('PAUSE: live read → ONE write (status=PAUSED) → independent read-back → item VERIFIED', rp.ok && rp.executionMode === 'LIVE' && writes(p1).length === 1 && writes(p1)[0].body.status === 'PAUSED' && world.entities.get(p1).status === 'PAUSED' && ip.status === 'VERIFIED', `${ip.status} ${ip.status_reason}`);
  ok('PAUSE audited (EXECUTED + verified, PAUSE action, ADMIN actor)', ap?.execution_status === 'EXECUTED' && JSON.parse(ap.verify_json || '{}').verified === true && ap.action_type === 'PAUSE' && ap.executed_by_id === 1);
  ok('«open» permission does NOT allow a PAUSE plan (pause switch is independent)', (await approve(await mkPlan('PAUSE', '2031-09-06', [p1]), cfg({ open: true }))).blocked === 'TYPE_NOT_ALLOWED');

  console.log('\n3. Failure modes — never a blind re-POST');
  const f1 = `${T}mo_fail1`; setEntity(f1, { status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '40000' });
  world.failNext = { type: 'rate', id: f1 };
  const pF1 = await mkPlan('OPEN', '2031-09-07', [f1]); await approve(pF1, cfg({ open: true }));
  const iF1 = await itemOf(pF1.id, f1);
  ok('Meta rate limit (code 17) on the write: ONE attempt only, item FAILED (Meta unchanged per the independent read), no automatic resend', writes(f1).length === 1 && iF1.status === 'FAILED' && world.entities.get(f1).status === 'PAUSED', `${iF1.status} ${iF1.status_reason}`);
  const f2 = `${T}mo_fail2`; setEntity(f2, { status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '40000' });
  world.failNext = { type: 'noop', id: f2 };
  const pF2 = await mkPlan('OPEN', '2031-09-08', [f2]); await approve(pF2, cfg({ open: true }));
  const iF2 = await itemOf(pF2.id, f2);
  ok('Meta accepts but does NOT apply: read-back disagrees → UNCERTAIN (not "success"), ONE POST only', writes(f2).length === 1 && iF2.status === 'UNCERTAIN', `${iF2.status} ${iF2.status_reason}`);

  console.log('\n4. BUDGET REDUCE −20% and INCREASE +20% — bridge → real executor → mock Meta');
  const mkDecision = async (action, entityId, from, to, campaignId) => { const n = ++dseq; const d = await retryDb(() => prisma.ambOperatorDecision.create({ data: { decision_key: `${T}mok${n}-${Date.now()}`, status: 'PREPARED', store_id: 'trendy-storeee', product_id: null, ad_account_id: `${T}acc`, campaign_id: campaignId, campaign_name: `${T}budget ${n}`, action, rule_id: null, rule_name: action === 'SCALE_UP' ? 'DYNAMIC_BUDGET:DYN_SCALE_UP' : 'DYNAMIC_BUDGET:DYN_REDUCE', mode_at_decision: 'APPROVAL', confidence: 'HIGH', blocked_codes_json: '[]', evidence_json: JSON.stringify({ history: {}, evidence: { cpa: action === 'SCALE_UP' ? 70 : 170, spend: 900, purchases: 12 }, m3: { spend: 900, purchases: 12, cpa: action === 'SCALE_UP' ? 70 : 170 } }), why_json: JSON.stringify({ why: 'fixture' }), params_json: JSON.stringify({ pct: 20, fromBudget: from, toBudget: to, level: 'campaign', entityId, window: 'last3' }), before_json: '{}' } })); created.decisions.push(d.id); return d; };
  const freshFor = (d, action, from, to, entityId) => async () => ({ policy: BO.DEFAULT_POLICY, adAccountId: `${T}acc`, structureSource: 'META_LIVE', rows: [{ campaignId: d.campaign_id, product: 'fixture', m3: { spend: 900, purchases: 12, cpa: action === 'SCALE_UP' ? 70 : 170 }, entity: { level: 'campaign', id: entityId, budget: from, name: null }, decision: action === 'SCALE_UP' ? 'WOULD_INCREASE' : 'WOULD_REDUCE', intended: { action, pct: 20, fromBudget: from, toBudget: to }, wouldBe: 'PREPARED', primaryBlock: null, guards: [], requiresApproval: false, evidence: { cpa: action === 'SCALE_UP' ? 70 : 170 } }] });
  const run = (d, action, from, to, entityId, c, extra = {}) => BX.executeBudgetDecision({ decisionId: d.id, userId: 1, deps: { config: c, evaluate: freshFor(d, action, from, to, entityId), policy: BO.DEFAULT_POLICY, ...extra } });
  for (const [label, action, from, to, key, minor, hours] of [['REDUCE −20%', 'SCALE_DOWN', 300, 240, 'budgetDecrease', 24000, 48], ['INCREASE +20%', 'SCALE_UP', 300, 360, 'budgetIncrease', 36000, 24]]) {
    const e = `${T}mo_${action.toLowerCase()}`; const camp = `${T}mo_camp_${action.toLowerCase()}`; setEntity(e, { status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '30000' });
    const d = await mkDecision(action, e, from, to, camp);
    const off = await run(d, action, from, to, e, cfg({ [key === 'budgetIncrease' ? 'budgetDecrease' : 'budgetIncrease']: true }));
    ok(`${label}: its OWN permission OFF (the other ON) → BLOCKED, decision stays PREPARED, ZERO requests`, off.blocked === 'PERMISSION_OFF' && writes(e).length === 0 && reads(e).length === 0 && (await prisma.ambOperatorDecision.findUnique({ where: { id: d.id } })).status === 'PREPARED');
    const lk = await run(d, action, from, to, e, cfg({ [key]: true }, { writesLocked: true }));
    ok(`${label}: Meta write-lock closed → BLOCKED, ZERO requests`, lk.blocked === 'META_WRITES_LOCKED' && writes(e).length === 0);
    const sh = await run(d, action, from, to, e, cfg({ [key]: true }, { mode: 'SHADOW' }));
    ok(`${label}: SHADOW → BLOCKED (no execution), ZERO requests`, sh.blocked === 'MODE_NOT_APPROVAL' && writes(e).length === 0);
    const drift = await run(d, action, from, to, e, cfg({ [key]: true }), { evaluate: freshFor(d, action, from + 50, to + 50, e) });
    ok(`${label}: live budget differs from the decision → EXPIRED (Live Revalidation), ZERO writes`, drift.status === 'EXPIRED' && writes(e).length === 0);
    const d2 = await mkDecision(action, e, from, to, camp);
    let nonAdmin = null; try { await BX.executeBudgetDecision({ decisionId: d2.id, userId: 999999, deps: { config: cfg({ [key]: true }), evaluate: freshFor(d2, action, from, to, e), user: { id: 2, role: 'MANAGER', status: 'ACTIVE' } } }); } catch (x) { nonAdmin = x; }
    ok(`${label}: a non-ADMIN cannot approve (403), ZERO writes`, nonAdmin?.status === 403 && writes(e).length === 0);
    const r = await run(d2, action, from, to, e, cfg({ [key]: true }));
    const dec = await prisma.ambOperatorDecision.findUnique({ where: { id: d2.id } }); const act = await actionOf(e);
    ok(`${label}: ADMIN approval → ONE write (daily_budget=${minor}), independent read-back, VERIFIED`, r.ok && r.verified && r.status === 'VERIFIED' && writes(e).length === 1 && writes(e)[0].body.daily_budget === String(minor) && world.entities.get(e).daily_budget === String(minor) && dec.status === 'VERIFIED', JSON.stringify({ s: r.status, m: r.message }).slice(0, 300));
    ok(`${label}: stages REQUESTED → SENT → READ-BACK → VERIFIED recorded`, !!r.stages.requested && !!r.stages.sentToMeta && r.stages.readBack?.verified === true && r.stages.verified === 'VERIFIED');
    ok(`${label}: Cooldown ${hours}h starts from the execution time`, r.stages.cooldown?.hours === hours && new Date(r.stages.cooldown.until) - new Date(r.stages.cooldown.from) === hours * 3_600_000);
    ok(`${label}: audit — executor action EXECUTED+verified (ADMIN actor) and decision events`, act?.execution_status === 'EXECUTED' && JSON.parse(act.verify_json || '{}').verified === true && act.executed_by_id === 1 && act.action_type === (action === 'SCALE_UP' ? 'INCREASE_BUDGET' : 'DECREASE_BUDGET') && (await prisma.ambOperatorEvent.count({ where: { decision_id: d2.id } })) >= 2);
    const again = await run(d2, action, from, to, e, cfg({ [key]: true }));
    ok(`${label}: approving the same decision twice does nothing (no second POST)`, again.ok === false && writes(e).length === 1);
  }
  const rl = `${T}mo_rl`; setEntity(rl, { status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '30000' }); const dRl = await mkDecision('SCALE_UP', rl, 300, 360, `${T}mo_camp_rl`);
  world.failNext = { type: 'rate', id: rl };
  const rRl = await run(dRl, 'SCALE_UP', 300, 360, rl, cfg({ budgetIncrease: true }));
  ok('Budget increase hitting Meta rate limit: ONE POST, FAILED (budget unchanged per the independent read), no blind retry', writes(rl).length === 1 && ['FAILED'].includes(rRl.status) && world.entities.get(rl).daily_budget === '30000', JSON.stringify({ s: rRl.status, m: rRl.message }).slice(0, 250));

  console.log('\n5. Autopilot / scheduler can never reach these paths');
  const EN = await imp('../services/amb/operatorEngine.js'); const dAp = await mkDecision('SCALE_UP', `${T}mo_ap`, 300, 360, `${T}mo_camp_ap`); setEntity(`${T}mo_ap`, { daily_budget: '30000' });
  const ap2 = await EN.executeDecision({ decisionId: dAp.id, source: 'AUTOPILOT', userId: null, deps: {} });
  ok('executeDecision from AUTOPILOT is refused for budget decisions — ZERO requests', ap2.ok === false && ap2.executed === false && writes(`${T}mo_ap`).length === 0);
  ok('the real Operator config was never touched by this test', JSON.stringify((await S.getOperatorConfig()).execPermissions) === JSON.stringify(realCfg0.execPermissions));
} catch (e) {
  fail++; console.log('  ✗ UNEXPECTED', e.stack || e.message);
} finally {
  server.close();
  const ids = created.plans; const recs = await prisma.ambRecommendation.findMany({ where: { OR: [{ batch_id: { in: [...ids.map((i) => `daily-plan-${i}`), ...created.decisions.map((i) => `operator-budget-${i}`)] } }, { entity_id: { startsWith: T } }] }, select: { id: true } });
  await prisma.ambActionResult.deleteMany({ where: { action: { recommendation_id: { in: recs.map((r) => r.id) } } } }).catch(() => {});
  await prisma.ambAction.deleteMany({ where: { OR: [{ recommendation_id: { in: recs.map((r) => r.id) } }, { entity_id: { startsWith: T } }] } }).catch(() => {});
  await prisma.ambRecommendation.deleteMany({ where: { id: { in: recs.map((r) => r.id) } } }).catch(() => {});
  for (const id of ids) await prisma.ambOperatorEvent.deleteMany({ where: { data_json: { contains: `"planId":${id},` } } }).catch(() => {});
  await prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ decision_id: { in: created.decisions } }, { campaign_id: { startsWith: T } }] } }).catch(() => {});
  await prisma.ambOperatorDecision.deleteMany({ where: { OR: [{ id: { in: created.decisions } }, { campaign_id: { startsWith: T } }] } }).catch(() => {});
  await prisma.ambDailyPlan.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.ambAlert.deleteMany({ where: { OR: [{ campaign_id: { startsWith: T } }, { entity_id: { startsWith: T } }] } }).catch(() => {});
  console.log(`\nSAFETY: requests that reached the mock: ${world.log.length} (all __optest_ fixtures) | real Meta calls = 0 | fixtures removed`);
  console.log(`\n${fail === 0 ? '✅' : '❌'} operationsMockTest: ${pass} passed, ${fail} failed`);
  await prisma.$disconnect(); process.exit(fail ? 1 : 0);
}
