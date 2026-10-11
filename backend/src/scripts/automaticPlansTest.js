// 🧪 AUTOMATIC daily plans — the unattended OPEN and the new SCHEDULED CLOSING, both behind the per-product gate (ACTIVE policy in mode AUTOMATIC + READY), the pause policy (approved version, scope, weekday)
//   and every central gate; real executor against a local Meta MOCK. No real Meta call.   node src/scripts/automaticPlansTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
process.env.OPERATOR_ALLOW_META_WRITES = 'true'; process.env.DAILY_PLAN_DISABLE_ALERTS = '1'; process.env.DAILY_PLAN_ALLOW_TEST_CLOCK = '1';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };
const world = { entities: new Map(), log: [] };
const setEntity = (id, o) => world.entities.set(id, { id, name: `mock ${id}`, status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '30000', objective: 'OUTCOME_SALES', ...o });
const writes = (id) => world.log.filter((r) => r.method === 'POST' && r.id === id);
const server = http.createServer((req, res) => { const url = new URL(req.url, 'http://x'); const id = url.pathname.split('/').filter(Boolean)[1]; let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => { const body = Object.fromEntries(new URLSearchParams(raw)); delete body.access_token; world.log.push({ method: req.method, id, body }); const send = (c, j) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); }; const e = world.entities.get(id);
    if (req.method === 'GET') return e ? send(200, e) : (/^(act_|__optest_acc)/.test(id || '') ? send(200, { id, name: 'acc', currency: 'EGP', account_status: 1 }) : send(404, { error: { message: 'Unsupported get request (mock)', code: 100 } }));
    if (!e) return send(404, { error: { message: 'Unsupported post request (mock)', code: 100 } }); if (body.status) { e.status = body.status; e.effective_status = body.status; } if (body.daily_budget) e.daily_budget = String(body.daily_budget); return send(200, { success: true }); }); });
await new Promise((rs) => server.listen(0, '127.0.0.1', rs)); process.env.META_GRAPH_MOCK = '1'; process.env.META_GRAPH_MOCK_URL = `http://127.0.0.1:${server.address().port}`;
const { prisma } = await imp('../prisma.js'); const TM = await imp('../services/amb/dailyPlanTime.js'); const DP = (await import('./_confirmWrap.js')).withAutoConfirm(await imp('../services/amb/dailyPlans.js')); const PPol = await imp('../services/amb/pausePolicy.js');
const T = '__optest_ap_'; const ADMIN = { id: 1, role: 'ADMIN', status: 'ACTIVE' }; const created = [];
const cfg0 = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const limits0 = cfg0.limits_json;
const OFF = { open: false, pause: false, budgetIncrease: false, budgetDecrease: false };
const cfg = (perm = {}, o = {}) => ({ mode: 'AUTOPILOT', emergency_stop: false, writesLocked: false, limits: { recentPurchaseProtectionHours: 3, manualOverrideCooldownHours: 24 }, execPermissions: { ...OFF, ...perm }, ...o });
const FRESH = { syncStatus: async () => ({ lastSuccessAt: new Date() }), refresh: async () => ({ ok: true }) }; const noSleep = async () => {};
const dcfg = (sched = true) => ({ ...DP.DEFAULT_DAILY_CONFIG, halted: false, scheduledExecution: { enabled: sched } });
const item = (cid, o = {}) => ({ campaignId: cid, campaignName: `${T}${cid}`, productId: null, productName: 'fixture', storeId: 'trendy-storeee', rank: 1, selected: true, selectable: true, eligibility: 'ELIGIBLE', blockCodes: [], warnings: [], risk: 'LOW', riskScore: 5, reason: 'fixture', evidence: { mapping: 'VERIFIED', budget: 300, stock: { status: 'IN_STOCK' }, policyPause: true, m7: { spend: 700, purchases: 0, cpa: null } }, ...o });
const mkPlan = async (date, items) => { const p = (await DP.preparePlan({ type: 'PAUSE', date, now: new Date(), simulated: false, deps: { ...FRESH, build: async () => ({ items: items.map((x, n) => ({ ...x, rank: n + 1 })), policy: null }) } })).plan; created.push(p.id); return p; };
const at = (date) => new Date(TM.dueAt('PAUSE', date).getTime() + 60_000);
const run = (date, perm, over = {}, c = {}) => DP.runPauseAutomatic({ now: at(date), deps: { ...FRESH, config: async () => cfg(perm, c), dcfg: dcfg(), autopilotGate: async () => ({ ok: true }), automaticGate: (it) => ([String(880101)].includes(String(it.product_id)) ? { ok: true } : { ok: false, reason: 'PRODUCT_NOT_AUTOMATIC' }), exceptions: async () => [], lastPurchase: async () => null, mappingState: async () => null, sleep: noSleep, ...over } });
const planOf = (id) => prisma.ambDailyPlan.findUnique({ where: { id } }); const itemOf = (pid, cid) => prisma.ambDailyPlanItem.findFirst({ where: { plan_id: pid, campaign_id: cid } });
const savePol = async (patch = {}, enable = true) => { await PPol.savePausePolicy({ patch: { scheduledClose: { enabled: true }, ...patch }, userId: 1, deps: { user: ADMIN } }); if (enable) await PPol.setPausePolicyEnabled({ enabled: true, confirm: true, userId: 1, deps: { user: ADMIN } }); };
const resetPolicy = () => prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: limits0 } });

try {
  console.log('\n1. Gates: nothing runs unless the pause policy is approved and scheduled closing is switched on');
  const d1 = '2031-10-01'; const c1 = `${T}a1`, c2 = `${T}a2`, c3 = `${T}a3`; for (const x of [c1, c2, c3]) setEntity(x);
  const p1 = await mkPlan(d1, [item(c1, { productId: 880101 }), item(c2, { productId: 880102 }), item(c3, { productId: 880101, evidence: { ...item('x').evidence, policyPause: false } })]);
  let r = await run(d1, { pause: true }); ok('no pause policy at all → ran:false (PAUSE_POLICY_NOT_APPROVED_AT_CURRENT_VERSION)', r.ran === false && r.why.includes('PAUSE_POLICY_NOT_APPROVED_AT_CURRENT_VERSION'));
  await savePol({}, false); r = await run(d1, { pause: true }); ok('saved but NOT approved → still ran:false', r.ran === false);
  await savePol({}, true);
  r = await run(d1, { pause: false }); ok('«pause» permission OFF → ran:false', r.why.includes('PAUSE_PERMISSION_OFF'));
  r = await run(d1, { pause: true }, { dcfg: dcfg(false) }); ok('scheduled execution OFF → ran:false', r.why.includes('SCHEDULED_EXECUTION_OFF'));
  r = await run(d1, { pause: true }, {}, { mode: 'APPROVAL' }); ok('global mode APPROVAL → ran:false (MODE_NOT_AUTOMATIC)', r.why.includes('MODE_NOT_AUTOMATIC'));
  r = await run(d1, { pause: true }, {}, { emergency_stop: true }); ok('Emergency Stop → ran:false', r.why.includes('EMERGENCY_STOP'));
  r = await run(d1, { pause: true }, {}, { writesLocked: true }); ok('write-lock closed → ran:false', r.why.includes('META_WRITES_LOCKED'));
  r = await run(d1, { pause: true }, { autopilotGate: async () => ({ ok: false }) }); ok('autopilot readiness gate not green → ran:false', r.why.includes('AUTOPILOT_GATE_NOT_READY'));
  ok('after all those refusals: ZERO Meta requests and the plan is untouched', world.log.filter((x) => x.method === 'POST').length === 0 && (await planOf(p1.id)).status === 'PREPARED');

  console.log('\n2. All gates open: only the policy-selected, AUTOMATIC+READY product runs');
  r = await run(d1, { pause: true }); const pl = await planOf(p1.id);
  ok('plan executed by the automation (approval_mode AUTOPILOT, COMPLETED)', r.ran === true && pl.status === 'COMPLETED' && pl.approval_mode === 'AUTOPILOT', JSON.stringify(r).slice(0, 300));
  ok('campaign of the AUTOMATIC+READY product: ONE write (PAUSED), item VERIFIED', writes(c1).length === 1 && world.entities.get(c1).status === 'PAUSED' && (await itemOf(p1.id, c1)).status === 'VERIFIED');
  ok('campaign of a product that is NOT automatic: untouched (ZERO writes), un-selected with the reason', writes(c2).length === 0 && (await itemOf(p1.id, c2)).selected === false && /PRODUCT|NEEDS|NO_/.test((await itemOf(p1.id, c2)).status_reason || ''), (await itemOf(p1.id, c2)).status_reason);
  ok('campaign the policy did NOT pre-select for pausing: untouched', writes(c3).length === 0 && world.entities.get(c3).status === 'ACTIVE');
  ok('audit says which campaigns were dropped and why (notAutomatic)', (await prisma.ambOperatorEvent.count({ where: { kind: 'DAILY_PLAN', data_json: { contains: 'notAutomatic' } } })) >= 1);
  const wAll = world.log.filter((x) => x.method === 'POST').length; await run(d1, { pause: true }); ok('idempotent: a second call finds the plan COMPLETED — no additional request', world.log.filter((x) => x.method === 'POST').length === wAll);

  console.log('\n3. Pause-policy scope and weekdays are honoured');
  const d2 = '2031-10-02'; const e1 = `${T}b1`; setEntity(e1); const p2 = await mkPlan(d2, [item(e1, { productId: 880101 })]);
  await savePol({ scope: { excludeProducts: ['880101'] } }); r = await run(d2, { pause: true }); ok('product excluded in the (re-approved) pause policy → nothing runs, ZERO writes', writes(e1).length === 0 && (r.plans[0]?.skipped === 'NOTHING_ELIGIBLE'), JSON.stringify(r));
  const d3 = '2031-10-03'; const e2 = `${T}b2`; setEntity(e2); const wd = new Date(`${d3}T12:00:00Z`).getUTCDay(); const p3 = await mkPlan(d3, [item(e2, { productId: 880101 })]);
  await savePol({ scope: { excludeProducts: [] }, days: [(wd + 1) % 7] }); r = await run(d3, { pause: true }); ok('weekday not allowed by the policy → skipped DAY_NOT_ALLOWED, ZERO writes', writes(e2).length === 0 && r.plans[0]?.skipped === 'DAY_NOT_ALLOWED', JSON.stringify(r));
  await savePol({ days: [wd] }); r = await run(d3, { pause: true }); ok('allowed weekday → runs and pauses', writes(e2).length === 1 && world.entities.get(e2).status === 'PAUSED');

  console.log('\n4. The per-product gate itself (real function)');
  const g = await DP.automaticProductGate({});
  ok('an item without a product is never unattended', g({ product_id: null, store_id: 'x', campaign_id: 'c' }).ok === false && g({ product_id: null }).reason === 'NO_PRODUCT');
  ok('a product with no ACTIVE policy is never unattended', g({ product_id: 999999, store_id: 'trendy-storeee', campaign_id: 'c' }).reason === 'NO_ACTIVE_PRODUCT_POLICY');
} finally {
  try { await resetPolicy(); await prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ campaign_id: { startsWith: T } }, { kind: { in: ['PAUSE_POLICY_SAVED', 'PAUSE_POLICY_ENABLED'] } }] } }); await prisma.ambAction.deleteMany({ where: { entity_id: { startsWith: T } } }); await prisma.ambRecommendation.deleteMany({ where: { entity_id: { startsWith: T } } }); await prisma.ambDailyPlanItem.deleteMany({ where: { plan_id: { in: created } } }); await prisma.ambDailyPlan.deleteMany({ where: { id: { in: created } } }); } catch (e) { console.log('cleanup failed', e.message); }
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
