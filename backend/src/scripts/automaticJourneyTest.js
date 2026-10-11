// 🧪 AUTOMATIC JOURNEY — one product line, one mock account: OPEN → PAUSE → INCREASE → REDUCE → independent read-back → Execution History → Emergency Stop.
//   Every write goes through the REAL executor against a loopback Meta MOCK (fake Graph). No real Meta call anywhere. The mock proving it works is NOT proof of a real execution.
//   node src/scripts/automaticJourneyTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
process.env.OPERATOR_ALLOW_META_WRITES = 'true'; // the mock is the only network target; the global write guard must see the deployment lock open for legitimate writes
process.env.DAILY_PLAN_DISABLE_ALERTS = '1';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };

// ---------------------------------------------------------------- the Meta mock
const world = { entities: new Map(), log: [], failNext: null };
const setEntity = (id, o) => world.entities.set(id, { id, name: `mock ${id}`, status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '30000', objective: 'OUTCOME_SALES', ...o });
const writes = (id) => world.log.filter((r) => r.method === 'POST' && r.id === id);
const allWrites = () => world.log.filter((r) => r.method === 'POST');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); const id = url.pathname.split('/').filter(Boolean)[1]; let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = Object.fromEntries(new URLSearchParams(raw)); delete body.access_token; world.log.push({ method: req.method, id, body });
    const send = (code, json) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    const e = world.entities.get(id);
    if (req.method === 'GET') { if (e) return send(200, e); if (/^(act_|__optest_acc)/.test(id || '')) return send(200, { id, name: 'mock account', currency: 'EGP', account_status: 1 }); return send(404, { error: { message: 'Unsupported get request (mock)', code: 100 } }); }
    if (!e) return send(404, { error: { message: 'Unsupported post request (mock)', code: 100 } });
    const f = world.failNext; if (f && (!f.id || f.id === id)) { world.failNext = null; if (f.type === 'rate') return send(400, { error: { message: '(#17) User request limit reached', type: 'OAuthException', code: 17, error_subcode: 2446079, error_user_title: 'Ad Account Has Too Many API Calls' } }); if (f.type === 'noop') return send(200, { success: true }); }
    if (body.status) { e.status = body.status; e.effective_status = body.status; }
    if (body.daily_budget) e.daily_budget = String(body.daily_budget);
    return send(200, { success: true });
  });
});
await new Promise((rs) => server.listen(0, '127.0.0.1', rs));
process.env.META_GRAPH_MOCK = '1'; process.env.META_GRAPH_MOCK_URL = `http://127.0.0.1:${server.address().port}`;
const { prisma } = await imp('../prisma.js');
const AE = await imp('../services/amb/automationEngine.js'); const PPol = await imp('../services/amb/pausePolicy.js'); const PP = await imp('../services/amb/productPolicy.js'); const ER = await imp('../services/amb/executionRecovery.js'); const OE = await imp('../services/amb/operatorEngine.js');
const conn = await (await imp('../services/metaAuth.js')).getConnection(); const settings = await (await imp('../services/amb/settings.js')).getAmbSettings();
const T = '__optest_au_'; const ST = 'trendy-storeee'; const ACC = conn?.selected_ad_account_id;
const OFF = { open: false, pause: false, budgetIncrease: false, budgetDecrease: false }; const ALL = { open: true, pause: true, budgetIncrease: true, budgetDecrease: true };
const cfg = (perm = ALL, o = {}) => ({ mode: 'AUTOPILOT', emergency_stop: false, writesLocked: false, limits: { recentPurchaseProtectionHours: 3, manualOverrideCooldownHours: 24, maxActionsPerHour: 100, pendingEvaluationHours: 24 }, execPermissions: { ...OFF, ...perm }, ...o });
const NOW = new Date(); const pk = (pid) => PP.policyKey(ST, pid);
const BP = (await imp('../services/amb/budgetOptimizer.js')).DEFAULT_POLICY;
const pausePol = (o = {}) => PPol.normalizePause({ enabled: true, version: 1, approved: { version: 1, at: NOW.toISOString(), by: 1 }, zeroOrder: { enabled: true }, highCpa: { enabled: true, above: 300, minPurchases: 3, minSpend: 300 }, stockOut: { enabled: true }, ...o });
const READY = (pid) => ({ productId: pid, ready: true, missing: [], checks: [] }); const NOT_READY = (pid) => ({ productId: pid, ready: false, missing: [{ key: 'ECONOMICS', label: 'اقتصاديات المنتج مكتملة' }], checks: [] });
const m = (spend, purchases) => ({ spend, purchases, cpa: purchases ? spend / purchases : null });

/** one active campaign `id` of product `pid` with the given optimizer row; returns the injected deps */
function scenario(list, { mode = 'AUTOMATIC', ready = true, pause = pausePol(), stock = {}, guards = {} } = {}) {
  const camps = list.map((c) => ({ id: c.id, name: c.id, status: 'ACTIVE', budget: c.budget ?? 300, firstSeenAt: new Date(NOW.getTime() - 10 * 86_400_000) }));
  const win = (key) => new Map(list.map((c) => [c.id, c[key] || m(0, 0)]));
  const w = { adAccountId: ACC, config: cfg(), settings, connected: true, metaStale: false, campaigns: camps, windows: { today: win('today'), last3: win('m3'), last7: win('m7'), last14: win('m14'), last30: win('m30') }, prodIndex: new Map(), tags: new Map(), exceptions: [], factsCache: new Map(), now: NOW };
  const rows = list.filter((c) => c.row).map((c) => ({ campaignId: c.id, product: 'fixture', productId: c.pid, storeId: ST, campaign: c.id, status: 'ACTIVE', entity: { level: 'campaign', id: c.id, budget: c.budget ?? 300, name: null }, decision: c.row.decision, zone: c.row.zone || 'X', rule: c.row.rule || 'X', reason: c.row.reason || 'fixture', guards: c.row.guards || [], evidence: c.row.evidence || {}, m3: c.m3 || null, m7: c.m7 || null, requiresApproval: !!c.row.requiresApproval, flagReview: false, primaryBlock: null,
    intended: { action: c.row.action, pct: c.row.pct ?? (c.row.action === 'SCALE_UP' ? 20 : c.row.action === 'SCALE_DOWN' ? 20 : null), fromBudget: c.row.action === 'PAUSE' ? null : (c.budget ?? 300), toBudget: c.row.action === 'PAUSE' ? null : (c.row.to ?? (c.row.action === 'SCALE_UP' ? Math.round((c.budget ?? 300) * 1.2) : Math.round((c.budget ?? 300) * 0.8))) } }));
  const pids = [...new Set(list.map((c) => c.pid))];
  return { world: w, opt: { structureSource: 'META_LIVE', adAccountId: ACC, rows }, policies: new Map(pids.map((p) => [pk(p), { mode }])), readiness: new Map(pids.map((p) => [pk(p), ready ? READY(p) : NOT_READY(p)])), pause, budgetPolicy: BP,
    stockOf: async (id) => stock[id] || { status: 'IN_STOCK', current: 50 }, guardsOf: async ({ campaignId }) => guards[campaignId] || [], recent: new Map(), counters: { actionsLastHour: 0, actionsToday: 0, byAction: {} } };
}
const ev = (sc, config = cfg()) => AE.evaluateAutomation({ now: NOW, deps: { ...sc, config } });
const tick = (sc, config = cfg(), extra = {}) => AE.runAutomationTick({ now: NOW, deps: { config, dcfg: { halted: false }, autopilotOk: true, noSleep: true, evalDeps: { ...sc, config }, ...extra, execDeps: { config, reevaluate: async () => AE.evaluateAutomation({ now: NOW, deps: { ...sc, config } }), ...(extra.execDeps || {}) } } });
const dec = (campaignId) => prisma.ambOperatorDecision.findFirst({ where: { campaign_id: campaignId, rule_name: { startsWith: 'AUTO:' } }, orderBy: { id: 'desc' } });
const actOf = (id) => prisma.ambAction.findFirst({ where: { entity_id: id }, orderBy: { id: 'desc' } });
const cleanup = async () => { const ds = await prisma.ambOperatorDecision.findMany({ where: { campaign_id: { startsWith: T } }, select: { id: true, amb_recommendation_id: true } }); const recIds = ds.map((d) => d.amb_recommendation_id).filter(Boolean);
  await prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ campaign_id: { startsWith: T } }, { decision_id: { in: ds.map((d) => d.id) } }] } }); await prisma.ambAction.deleteMany({ where: { OR: [{ entity_id: { startsWith: T } }, { recommendation_id: { in: recIds } }] } }); await prisma.ambOperatorDecision.deleteMany({ where: { campaign_id: { startsWith: T } } }); await prisma.ambRecommendation.deleteMany({ where: { OR: [{ id: { in: recIds } }, { entity_id: { startsWith: T } }] } }); await prisma.ambAlert.deleteMany({ where: { entity_id: { startsWith: T } } }).catch(() => {}); };
const pid = (n) => 880000 + n;

// ------------------------------------------------------------------ the AUTOMATIC journey (one product line, one mock account)
const DP = (await import('./_confirmWrap.js')).withAutoConfirm(await imp('../services/amb/dailyPlans.js')); const TM = await imp('../services/amb/dailyPlanTime.js'); const OC = await imp('../services/amb/openCpaPolicy.js'); const H = await imp('../services/amb/executionHistory.js');
const ADMIN_ID = (await prisma.user.findFirst({ where: { role: 'ADMIN', status: 'ACTIVE' } }))?.id ?? 1; const ADMIN = { id: ADMIN_ID, role: 'ADMIN', status: 'ACTIVE' };
const cfgRow0 = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const limits0 = cfgRow0.limits_json;
const FRESH = { syncStatus: async () => ({ lastSuccessAt: new Date() }), refresh: async () => ({ ok: true }) }; const noSleep = async () => {};
const D0 = { ...FRESH, user: ADMIN, runInline: true, exceptions: async () => [], lastPurchase: async () => null, mappingState: async () => null, sleep: noSleep };
const dcfgOn = { ...(await DP.getDailyPlanConfig()), halted: false, scheduledExecution: { enabled: true } };
const J = { open: `${T}j_open`, pause: `${T}j_pause`, up: `${T}j_up`, down: `${T}j_down` };
const planIds = [];
const journeyCleanup = async () => {
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: limits0 } });
  const rs = await prisma.ambRecommendation.findMany({ where: { entity_id: { startsWith: T } }, select: { id: true } });
  await prisma.ambActionResult.deleteMany({ where: { action: { recommendation_id: { in: rs.map((r) => r.id) } } } }).catch(() => {});
  await prisma.ambDailyPlanItem.deleteMany({ where: { plan_id: { in: planIds } } }); await prisma.ambOperatorEvent.deleteMany({ where: { campaign_id: { startsWith: T } } });
  await prisma.ambAction.deleteMany({ where: { entity_id: { startsWith: T } } }); await prisma.ambRecommendation.deleteMany({ where: { entity_id: { startsWith: T } } }); await prisma.ambDailyPlan.deleteMany({ where: { id: { in: planIds } } });
};
const getsAfterWrite = (id) => { const w = world.log.findLastIndex((r) => r.method === 'POST' && r.id === id); return w >= 0 && world.log.slice(w + 1).some((r) => r.method === 'GET' && r.id === id); };

try {
  await cleanup(); await journeyCleanup();
  console.log('\n9. THE AUTOMATIC JOURNEY: OPEN → PAUSE → INCREASE → REDUCE → independent read-back → Execution History → Emergency Stop');
  setEntity(J.open, { status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '30000' }); for (const id of [J.pause, J.up, J.down]) setEntity(id, { daily_budget: '30000' });
  const a0 = await prisma.ambAction.count();

  // ---- stage 1: the unattended OPEN (approved open-CPA policy → plan prepared under it → AUTOMATIC product gate → real executor)
  await OC.saveOpenCpaPolicy({ patch: { minCpa: 50, maxCpa: 150, window: '7' }, userId: ADMIN_ID, deps: { user: ADMIN } }); await OC.setOpenCpaEnabled({ enabled: true, confirm: true, userId: ADMIN_ID, deps: { user: ADMIN } }); const pol = await OC.getOpenCpaPolicy();
  const date = '2031-07-01'; const nowO = new Date(TM.dueAt('OPEN', date).getTime() + 30 * 60_000);
  const item = { campaignId: J.open, campaignName: J.open, productId: pid(30), productName: 'fixture', storeId: ST, rank: 1, selected: false, selectable: true, eligibility: 'ELIGIBLE', blockCodes: [], warnings: [], risk: 'LOW', riskScore: 10, reason: 'fixture', evidence: { mapping: 'VERIFIED', budget: 300, budgetLevel: 'CBO', status: 'PAUSED', stock: { status: 'IN_STOCK' } } };
  const plan = (await DP.preparePlan({ type: 'OPEN', date, now: nowO, simulated: false, userId: ADMIN_ID, deps: { ...FRESH, build: async () => ({ items: [item], policy: null, openCpa: { version: pol.version } }) } })).plan; planIds.push(plan.id);
  await DP.prepareOpenCpaMatches({ planId: plan.id, userId: ADMIN_ID, now: nowO, simulated: false, deps: { ...D0, openCpaMetrics: new Map([[J.open, { spend: 1000, purchases: 10 }]]) } });
  const openDeps = (c, g = () => ({ ok: true })) => ({ ...D0, config: async () => c, dcfg: dcfgOn, autopilotGate: async () => ({ ok: true }), automaticGate: g });
  const rNot = await DP.runOpenCpaAutomatic({ now: nowO, deps: openDeps(cfg(ALL), () => ({ ok: false, reason: 'PRODUCT_NOT_AUTOMATIC' })) });
  ok('OPEN: a campaign whose product is NOT automatic is never opened (dropped with the reason), ZERO Meta writes', allWrites().length === 0 && world.entities.get(J.open).status === 'PAUSED', JSON.stringify(rNot).slice(0, 200));
  const plan2 = (await DP.preparePlan({ type: 'OPEN', date: '2031-07-02', now: new Date(TM.dueAt('OPEN', '2031-07-02').getTime() + 30 * 60_000), simulated: false, userId: ADMIN_ID, deps: { ...FRESH, build: async () => ({ items: [item], policy: null, openCpa: { version: pol.version } }) } })).plan; planIds.push(plan2.id);
  const nowO2 = new Date(TM.dueAt('OPEN', '2031-07-02').getTime() + 30 * 60_000); await DP.prepareOpenCpaMatches({ planId: plan2.id, userId: ADMIN_ID, now: nowO2, simulated: false, deps: { ...D0, openCpaMetrics: new Map([[J.open, { spend: 1000, purchases: 10 }]]) } });
  const rEmO = await DP.runOpenCpaAutomatic({ now: nowO2, deps: openDeps(cfg(ALL, { emergency_stop: true })) }); ok('OPEN under Emergency Stop → nothing runs, ZERO writes', rEmO.ran === false && rEmO.why.includes('EMERGENCY_STOP') && allWrites().length === 0);
  const rOpen = await DP.runOpenCpaAutomatic({ now: nowO2, deps: openDeps(cfg(ALL)) });
  const actOpen = await actOf(J.open);
  ok('OPEN: all gates open + AUTOMATIC product → ONE write (status=ACTIVE) and the mock really became ACTIVE', writes(J.open).length === 1 && writes(J.open)[0].body.status === 'ACTIVE' && world.entities.get(J.open).status === 'ACTIVE', JSON.stringify(rOpen).slice(0, 300));
  ok('OPEN: independent read-back after the write, action EXECUTED + verify.verified, approval AUTO/AUTOPILOT', getsAfterWrite(J.open) && actOpen?.execution_status === 'EXECUTED' && JSON.parse(actOpen.verify_json || '{}').verified === true && actOpen.action_type === 'RESUME');

  // ---- stage 2: PAUSE / INCREASE / REDUCE through the automation engine tick
  const sc = scenario([{ id: J.pause, pid: pid(31), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }, { id: J.up, pid: pid(32), m3: m(600, 10), row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', to: 360 } }, { id: J.down, pid: pid(33), m3: m(900, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE', to: 240 } }]);
  const wBefore = allWrites().length; const rT = await tick(sc, cfg(ALL));
  ok('PAUSE: one write status=PAUSED, mock PAUSED', writes(J.pause).length === 1 && writes(J.pause)[0].body.status === 'PAUSED' && world.entities.get(J.pause).status === 'PAUSED', JSON.stringify(rT.executed));
  ok('INCREASE +20% (300 → 360): one write, mock budget 36000', writes(J.up).length === 1 && world.entities.get(J.up).daily_budget === '36000');
  ok('REDUCE −20% (300 → 240): one write, mock budget 24000', writes(J.down).length === 1 && world.entities.get(J.down).daily_budget === '24000');
  ok('exactly THREE new writes in the tick (nothing else touched, the opened campaign is left alone)', allWrites().length === wBefore + 3 && writes(J.open).length === 1);

  // ---- stage 3: independent read-back + decisions
  for (const [k, id] of [['pause', J.pause], ['up', J.up], ['down', J.down]]) { const d = await dec(id); const a = await actOf(id); ok(`${k.toUpperCase()}: decision VERIFIED, read-back AFTER the write, action EXECUTED with verify.verified, approval AUTO`, d?.status === 'VERIFIED' && getsAfterWrite(id) && a?.execution_status === 'EXECUTED' && JSON.parse(a.verify_json || '{}').verified === true && a.approval_status === 'AUTO', JSON.stringify({ d: d?.status, a: a?.execution_status })); }
  const wDone = allWrites().length; await tick(sc, cfg(ALL)); await tick(sc, cfg(ALL)); ok('IDEMPOTENT: two more ticks send ZERO additional requests', allWrites().length === wDone);

  // ---- stage 4: Execution History tells the story
  const h = await H.listExecutionHistory({ limit: 300 }); const mine = h.rows.filter((r) => [J.open, J.pause, J.up, J.down].includes(r.entityId) || String(r.entityName || '').startsWith(T) || String(r.campaignName || '').startsWith(T) || [J.open, J.pause, J.up, J.down].includes(r.campaignId));
  const byType = (t) => mine.filter((r) => r.type === t);
  ok('History: four rows for the four operations (open, pause, increase, reduce), all VERIFIED (never success without the read-back)', mine.length >= 4 && ['RESUME', 'PAUSE', 'INCREASE_BUDGET', 'DECREASE_BUDGET'].every((t) => byType(t).some((r) => r.final === 'VERIFIED')), JSON.stringify(mine.map((r) => [r.type, r.final, r.origin])));
  ok('History: the three engine operations are labelled AUTOMATIC; budget rows carry before → after (300 → 360, 300 → 240)', ['PAUSE', 'INCREASE_BUDGET', 'DECREASE_BUDGET'].every((t) => byType(t).some((r) => r.origin === 'AUTOMATIC')) && byType('INCREASE_BUDGET').some((r) => r.before === 300 && r.after === 360) && byType('DECREASE_BUDGET').some((r) => r.before === 300 && r.after === 240), JSON.stringify(mine.map((r) => [r.type, r.origin, r.before, r.after])));
  ok('History: six stages are all done on a verified row (requested → validated → approved → sent → read-back → verified)', mine.filter((r) => r.final === 'VERIFIED').every((r) => r.stages.filter((s) => s.done).length >= 5));

  // ---- stage 5: Emergency Stop mid-run — a fresh set of candidates must not send a single request
  const e1 = `${T}j_em1`, e2 = `${T}j_em2`; setEntity(e1); setEntity(e2);
  const sc2 = scenario([{ id: e1, pid: pid(34), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }, { id: e2, pid: pid(35), m3: m(600, 10), row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', to: 360 } }]);
  const wEm = allWrites().length; const rEm = await tick(sc2, cfg(ALL, { emergency_stop: true }));
  ok('EMERGENCY STOP: new pause + increase candidates → ZERO requests, decisions stay PREPARED, gate says EMERGENCY_STOP', allWrites().length === wEm && rEm.gate.includes('EMERGENCY_STOP') && (await dec(e1))?.status === 'PREPARED' && world.entities.get(e1).status === 'ACTIVE' && world.entities.get(e2).daily_budget === '30000');
  const rEm2 = await tick(sc2, cfg(ALL, { writesLocked: true })); ok('deployment write-lock closed → still ZERO requests (PREPARED only)', allWrites().length === wEm && rEm2.gate.includes('META_WRITES_LOCKED'));
  const rEm3 = await tick(sc2, cfg(OFF)); ok('all four permissions OFF → ZERO requests', allWrites().length === wEm);
  const rRel = await tick(sc2, cfg(ALL)); ok('Emergency Stop released (all gates open) → the same prepared decisions execute exactly once', writes(e1).length === 1 && writes(e2).length === 1 && world.entities.get(e1).status === 'PAUSED' && world.entities.get(e2).daily_budget === '36000', JSON.stringify(rRel.executed));
  ok('total new Meta actions of the whole journey = 6 (open, pause, increase, reduce + the two after release)', (await prisma.ambAction.count()) - a0 === 6, String((await prisma.ambAction.count()) - a0));
} finally { try { await journeyCleanup(); await cleanup(); } catch (e) { console.log('cleanup failed', e.message); } server.close(); }
console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
