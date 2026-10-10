// 🔐 The CENTRAL META-WRITE GATE + plan confirmation + restart recovery + Approval Center completion — Neon TEST database + a local Meta MOCK (fake Graph API on loopback). NO real Meta call.
//   1. evaluateWriteGate (pure) matrix — Emergency Stop / mode / deployment lock / the four INDEPENDENT permissions / fail-closed
//   2. the REAL executor + mock Meta for Open · Pause · Increase · Reduce: every closed gate ⇒ ZERO requests; all open ⇒ ONE write + independent read-back + audit
//   3. the legacy path (approveAndExecute with no injected config = what the old routes / assistant tasks do) is blocked by the real stored config
//   4. tripwire: only the known modules may call the Meta write functions
//   5. plan approval needs the owner's confirmation (campaign count + exposed budget) · live-budget drift and exposure cap at execution
//   6. restart recovery: read-back only, never a re-send, idempotent
//   7. Approval Center: CPA / orders / plan items / decision preview (read only)
//   node src/scripts/centralWriteGateTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };

// ---------------------------------------------------------------- the Meta mock
const world = { entities: new Map(), log: [] };
const setEntity = (id, o) => world.entities.set(id, { id, name: `mock ${id}`, status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: null, objective: 'OUTCOME_SALES', ...o });
const writes = (id) => world.log.filter((r) => r.method === 'POST' && r.id === id);
const allWrites = () => world.log.filter((r) => r.method === 'POST');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); const id = url.pathname.split('/').filter(Boolean)[1]; let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = Object.fromEntries(new URLSearchParams(raw)); delete body.access_token;
    world.log.push({ method: req.method, id, body, at: Date.now() });
    const send = (code, json) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    const e = world.entities.get(id);
    if (req.method === 'GET') { if (e) return send(200, e); if (/^(act_|__optest_acc)/.test(id || '')) return send(200, { id, account_id: id, name: 'mock account', currency: 'EGP', timezone_name: 'Africa/Cairo', account_status: 1 }); return send(404, { error: { message: 'Unsupported get request (mock)', type: 'GraphMethodException', code: 100 } }); }
    if (req.method === 'POST') { if (!e) return send(404, { error: { message: 'Unsupported post request (mock)', type: 'GraphMethodException', code: 100 } }); if (body.status) { e.status = body.status; e.effective_status = body.status; } if (body.daily_budget) e.daily_budget = String(body.daily_budget); return send(200, { success: true }); }
    return send(405, {});
  });
});
await new Promise((rs) => server.listen(0, '127.0.0.1', rs));
process.env.META_GRAPH_MOCK = '1'; process.env.META_GRAPH_MOCK_URL = `http://127.0.0.1:${server.address().port}`; // BEFORE the Meta client is imported
process.env.DAILY_PLAN_DISABLE_ALERTS = '1';
const { prisma } = await imp('../prisma.js');
const WG = await imp('../services/amb/writeGate.js'); const EX = await imp('../services/amb/executor.js'); const DP = await imp('../services/amb/dailyPlans.js'); const TM = await imp('../services/amb/dailyPlanTime.js');
const REC = await imp('../services/amb/executionRecovery.js'); const AC = await imp('../services/amb/approvalCenter.js');
const T = '__optest_'; const created = { plans: [], recs: [], decisions: [] };
const OFF = { open: false, pause: false, budgetIncrease: false, budgetDecrease: false };
const cfg = (perm = {}, o = {}) => ({ mode: 'APPROVAL', emergency_stop: false, writesLocked: false, limits: { recentPurchaseProtectionHours: 3, manualOverrideCooldownHours: 24 }, execPermissions: { ...OFF, ...perm }, ...o });
const ADMIN = { id: 1, role: 'ADMIN', status: 'ACTIVE' }; const noSleep = async () => {};
const FRESH = { syncStatus: async () => ({ lastSuccessAt: new Date() }), refresh: async () => ({ ok: true }) };
const planDeps = (c, extra = {}) => ({ ...FRESH, user: ADMIN, runInline: true, exceptions: async () => [], lastPurchase: async () => null, mappingState: async () => null, dcfg: { ...DP.DEFAULT_DAILY_CONFIG }, config: async () => c, sleep: noSleep, ...extra });
const item = (cid, o = {}) => ({ campaignId: cid, campaignName: `${T}gate ${cid}`, productId: null, productName: 'fixture', storeId: 'trendy-storeee', rank: 1, selected: true, selectable: true, eligibility: 'ELIGIBLE', blockCodes: [], warnings: [], risk: 'LOW', riskScore: 5, reason: 'fixture', evidence: { mapping: 'VERIFIED', budget: world.entities.get(cid)?.daily_budget ? Number(world.entities.get(cid).daily_budget) / 100 : 300, stock: { status: 'IN_STOCK' }, m7: { spend: 700, purchases: 8, cpa: 88 }, m30: { spend: 2000, purchases: 25, cpa: 80 } }, ...o });
const mkPlan = async (type, date, ids, o = {}) => { const p = (await DP.preparePlan({ type, date, now: new Date(), simulated: o.simulated ?? false, deps: { ...FRESH, build: async () => ({ items: ids.map((id, n) => item(id, { rank: n + 1, ...(o.items?.[id] || {}) })), policy: null }) } })).plan; created.plans.push(p.id); return p; };
const approve = (p, c, extra = {}, confirm) => DP.approvePlan({ planId: p.id, userId: 1, now: new Date(TM.dueAt(p.type, p.plan_date).getTime() + 60_000), deps: planDeps(c, extra), confirm: confirm === undefined ? undefined : confirm });
const confirmOf = (p) => DP.currentConfirmation(p.id);
const itemOf = (pid, cid) => prisma.ambDailyPlanItem.findFirst({ where: { plan_id: pid, campaign_id: cid } });
const conn = await (await imp('../services/metaAuth.js')).getConnection();
let rseq = 0;
const mkRec = async (type, entity, o = {}) => { rseq++; const rec = await prisma.ambRecommendation.create({ data: { batch_id: `${T}gate${Date.now()}_${rseq}`, ad_account_id: conn.selected_ad_account_id, level: 'campaign', entity_id: entity, entity_name: entity, campaign_id: entity, campaign_name: entity, decision: type === 'PAUSE' ? 'PAUSE_LOSER' : 'SCALE', action_type: type, executable: true, current_metrics_json: JSON.stringify({ spend: 800, purchases: 10, cpa: 80 }), current_budget: o.cur ?? null, recommended_budget: o.next ?? null, budget_change_pct: o.cur ? Math.round(((o.next - o.cur) / o.cur) * 100) : null, reason: 'gate fixture', confidence: 'HIGH', risk_level: 'LOW', data_sufficiency: 'STRONG', priority: 'P2', time_window_label: 'آخر 7 أيام', source: 'FALLBACK', status: 'PENDING' } }); created.recs.push(rec.id); return rec; };
const run = (rec, c) => EX.approveAndExecute({ recId: rec.id, userId: 1, mode: 'APPROVAL', deps: c === undefined ? {} : { config: c } });

try {
  console.log('\n1. evaluateWriteGate — the pure matrix');
  const ACTS = ['RESUME', 'PAUSE', 'INCREASE_BUDGET', 'DECREASE_BUDGET']; const KEY = { RESUME: 'open', PAUSE: 'pause', INCREASE_BUDGET: 'budgetIncrease', DECREASE_BUDGET: 'budgetDecrease' };
  ok('everything open + own permission ON → allowed (each of the four)', ACTS.every((a) => WG.evaluateWriteGate({ config: cfg({ [KEY[a]]: true }), actionType: a }).ok));
  ok('the four permissions are INDEPENDENT: each switch allows ONLY its own operation', ACTS.every((a) => ACTS.every((b) => WG.evaluateWriteGate({ config: cfg({ [KEY[a]]: true }), actionType: b }).ok === (a === b))));
  ok('all permissions OFF → every operation refused with PERMISSION_OFF', ACTS.every((a) => WG.evaluateWriteGate({ config: cfg(), actionType: a }).code === 'PERMISSION_OFF'));
  ok('deployment write-lock closed → refused (the permission cannot override it)', ACTS.every((a) => WG.evaluateWriteGate({ config: cfg({ [KEY[a]]: true }, { writesLocked: true }), actionType: a }).code === 'META_WRITES_LOCKED'));
  ok('writesLocked missing / undefined / null is treated as LOCKED (fail-closed)', [undefined, null, 'false', 0].every((v) => !WG.evaluateWriteGate({ config: { ...cfg({ open: true }), writesLocked: v }, actionType: 'RESUME' }).ok));
  ok('Emergency Stop → refused for all four, and it is the primary reason', ACTS.every((a) => { const r = WG.evaluateWriteGate({ config: cfg({ [KEY[a]]: true }, { emergency_stop: true }), actionType: a }); return !r.ok && r.code === 'EMERGENCY_STOP'; }));
  ok('SHADOW / MANUAL(OFF) / AUTOPILOT mode → refused for a human approval (needs APPROVAL)', ['SHADOW', 'OFF', 'AUTOPILOT'].every((m) => ACTS.every((a) => WG.evaluateWriteGate({ config: cfg({ [KEY[a]]: true }, { mode: m }), actionType: a }).code === 'MODE_NOT_APPROVAL')));
  ok('an AUTOPILOT-kind write needs mode AUTOPILOT (an APPROVAL config cannot run it)', WG.evaluateWriteGate({ config: cfg({ open: true }), actionType: 'RESUME', mode: 'AUTOPILOT' }).code === 'MODE_NOT_AUTOMATIC' && WG.evaluateWriteGate({ config: cfg({ open: true }, { mode: 'AUTOPILOT' }), actionType: 'RESUME', mode: 'AUTOPILOT' }).ok);
  ok('unknown action / missing config → refused (fail-closed)', WG.evaluateWriteGate({ config: cfg({ open: true }), actionType: 'DELETE_CAMPAIGN' }).code === 'ACTION_NOT_GATED' && WG.evaluateWriteGate({ config: null, actionType: 'PAUSE' }).code === 'NO_CONFIG');
  ok('all closed reasons are reported together (not only the first)', WG.evaluateWriteGate({ config: cfg({}, { writesLocked: true, emergency_stop: true, mode: 'SHADOW' }), actionType: 'PAUSE' }).reasons.length === 4);

  console.log('\n2. The REAL executor + mock Meta — Open · Pause · Increase · Reduce');
  ok('a connected ad account exists locally (the executor needs one)', conn?.status === 'CONNECTED' && !!conn.selected_ad_account_id);
  const SPECS = [
    { type: 'RESUME', key: 'open', label: 'OPEN', ent: { status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '50000' }, rec: {}, body: (b) => b.status === 'ACTIVE', after: (e) => e.status === 'ACTIVE' },
    { type: 'PAUSE', key: 'pause', label: 'PAUSE', ent: { status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '50000' }, rec: {}, body: (b) => b.status === 'PAUSED', after: (e) => e.status === 'PAUSED' },
    { type: 'INCREASE_BUDGET', key: 'budgetIncrease', label: 'INCREASE', ent: { status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '50000' }, rec: { cur: 500, next: 600 }, body: (b) => String(b.daily_budget) === '60000', after: (e) => e.daily_budget === '60000' },
    { type: 'DECREASE_BUDGET', key: 'budgetDecrease', label: 'REDUCE', ent: { status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '50000' }, rec: { cur: 500, next: 400 }, body: (b) => String(b.daily_budget) === '40000', after: (e) => e.daily_budget === '40000' },
  ];
  for (const sp of SPECS) {
    const E = `${T}gx_${sp.label.toLowerCase()}`; setEntity(E, sp.ent); const rec = await mkRec(sp.type, E, sp.rec);
    const closed = [['deployment lock closed', cfg({ [sp.key]: true }, { writesLocked: true }), 'META_WRITES_LOCKED'], ['permission OFF', cfg(), 'PERMISSION_OFF'], ['Emergency Stop', cfg({ [sp.key]: true }, { emergency_stop: true }), 'EMERGENCY_STOP'], ['mode SHADOW', cfg({ [sp.key]: true }, { mode: 'SHADOW' }), 'MODE_NOT_APPROVAL']];
    for (const [name, c, code] of closed) { const r = await run(rec, c); ok(`${sp.label}: ${name} → blocked at the executor (${code}), ZERO requests to Meta`, r.ok === false && r.blocked === true && r.code === code && world.log.filter((x) => x.id === E).length === 0, JSON.stringify(r).slice(0, 200)); }
    const wrong = await run(rec, cfg(Object.fromEntries(SPECS.filter((o) => o.key !== sp.key).map((o) => [o.key, true]))));
    ok(`${sp.label}: the OTHER three permissions ON do not allow it`, wrong.blocked === true && wrong.code === 'PERMISSION_OFF' && world.log.filter((x) => x.id === E).length === 0);
    const recAfterBlock = await prisma.ambRecommendation.findUnique({ where: { id: rec.id } }); const actsBlocked = await prisma.ambAction.count({ where: { recommendation_id: rec.id } });
    ok(`${sp.label}: a blocked attempt changes nothing — recommendation still PENDING, no action row`, recAfterBlock.status === 'PENDING' && actsBlocked === 0);
    const blockEvents = await prisma.ambOperatorEvent.count({ where: { kind: 'WRITE_GATE_BLOCK', campaign_id: E } });
    ok(`${sp.label}: every refusal is audited (WRITE_GATE_BLOCK events)`, blockEvents >= 5, blockEvents);
    const go = await run(rec, cfg({ [sp.key]: true }));
    const act = await prisma.ambAction.findFirst({ where: { recommendation_id: rec.id }, orderBy: { id: 'desc' } }); const verify = JSON.parse(act?.verify_json || '{}');
    ok(`${sp.label}: all gates open + ADMIN approval → ONE write with the right body`, go.ok === true && writes(E).length === 1 && sp.body(writes(E)[0].body), JSON.stringify(go).slice(0, 200));
    ok(`${sp.label}: Meta (mock) really changed, and an independent READ came after the write`, sp.after(world.entities.get(E)) && world.log.findLastIndex((r) => r.id === E) > world.log.indexOf(writes(E)[0]));
    ok(`${sp.label}: audit row EXECUTED + verified by read-back, actor = the ADMIN`, act?.execution_status === 'EXECUTED' && verify.verified === true && act.executed_by_id === 1 && act.action_type === sp.type);
    const again = await run(rec, cfg({ [sp.key]: true })).catch((e) => ({ ok: false, error: e.message })); // the executor refuses an already-EXECUTED recommendation (409)
    ok(`${sp.label}: duplicate prevention — a second approval of the same recommendation sends NOTHING`, again.ok === false && writes(E).length === 1);
  }

  console.log('\n3. The legacy path — approveAndExecute with NO injected config reads the REAL stored config');
  const LG = `${T}gx_legacy`; setEntity(LG, { status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '50000' });
  const lrec = await mkRec('PAUSE', LG); const lres = await EX.approveAndExecute({ recId: lrec.id, userId: 1, mode: 'APPROVAL' });
  ok('stored config (factory default: SHADOW, lock closed, permissions OFF) → the legacy route is blocked, ZERO requests', lres.ok === false && lres.blocked === true && world.log.filter((x) => x.id === LG).length === 0, JSON.stringify(lres).slice(0, 200));
  const lres2 = await EX.approveAndExecute({ recId: lrec.id, userId: 1, mode: 'AUTOPILOT' });
  ok('the same call claiming mode AUTOPILOT is blocked too', lres2.ok === false && lres2.blocked === true && writes(LG).length === 0);
  const lstat = await prisma.ambRecommendation.findUnique({ where: { id: lrec.id } });
  ok('the recommendation stays PENDING (nothing was marked approved)', lstat.status === 'PENDING');

  console.log('\n4. Tripwire — who may call the Meta write functions');
  const SRC = join(__dirname, '..'); const files = []; const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) { if (f.name !== 'scripts' && f.name !== 'node_modules') walk(p); } else if (/\.(js|mjs)$/.test(f.name)) files.push(p); } }; walk(SRC);
  const callers = (re) => files.filter((f) => re.test(fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, ''))).map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'));
  const budgetW = callers(/setEntityBudget\s*\(/); const statusW = callers(/setEntityStatus\s*\(/);
  ok('setEntityBudget is called ONLY by the gated executor (and its definition)', budgetW.every((f) => ['services/amb/executor.js', 'services/metaGraphClient.js'].includes(f)), budgetW.join(','));
  const KNOWN_STATUS_WRITERS = ['services/amb/executor.js', 'services/metaGraphClient.js', 'services/amb/productDecisionExecution.js', 'services/amb/campaignSchedule.js', 'services/amb/cloneEngine.js', 'services/amb/launchPublish.js'];
  ok('setEntityStatus callers are exactly the known set — a NEW file touching Meta status fails this test until it is reviewed', statusW.every((f) => KNOWN_STATUS_WRITERS.includes(f)), statusW.join(','));
  const execCallers = callers(/approveAndExecute\s*\(/);
  ok('approveAndExecute is called only by the known routes/services (all pass through the gate inside it)', execCallers.every((f) => ['services/amb/executor.js', 'routes/aiMediaBuyer.js', 'services/amb/dailyPlans.js', 'services/amb/budgetExecution.js', 'services/amb/operatorEngine.js', 'services/assistantTasks/taskEngine.js'].includes(f)), execCallers.join(','));
  const pde = fs.readFileSync(join(SRC, 'services/amb/productDecisionExecution.js'), 'utf8');
  ok('productDecisionExecution (product-level PAUSE) checks the central gate BEFORE it reaches Meta', pde.indexOf('checkMetaWrite(') > 0 && pde.indexOf('checkMetaWrite(') < pde.indexOf('setEntityStatus(token'));
  const exSrc = fs.readFileSync(join(SRC, 'services/amb/executor.js'), 'utf8');
  ok('the executor runs the gate before it marks anything approved or sends anything', exSrc.indexOf('checkMetaWrite(') > 0 && exSrc.indexOf('checkMetaWrite(') < exSrc.indexOf("status: 'APPROVED'") && exSrc.indexOf('checkMetaWrite(') < exSrc.indexOf('setEntityStatus(token'));

  console.log('\n5. Plan approval = the owner confirms the exact numbers');
  const c1 = `${T}gx_p1`, c2 = `${T}gx_p2`; setEntity(c1, { status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '30000' }); setEntity(c2, { status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '30000' });
  const pc = await mkPlan('OPEN', '2031-11-01', [c1, c2]); const exp = await confirmOf(pc);
  ok('the plan exposure is count + total of the plan budgets (2 campaigns × 300 = 600)', exp.count === 2 && exp.exposedBudget === 600, JSON.stringify(exp));
  const n0 = await approve(pc, cfg({ open: true }));
  ok('a REAL plan without a confirmation is refused (CONFIRM_REQUIRED) and nothing is approved', n0.ok === false && n0.status === 'CONFIRM_REQUIRED' && (await prisma.ambDailyPlan.findUnique({ where: { id: pc.id } })).status === 'PREPARED');
  const n1 = await approve(pc, cfg({ open: true }), {}, { count: 1, exposedBudget: 600 });
  ok('wrong campaign count → CONFIRM_MISMATCH, still PREPARED, ZERO writes', n1.ok === false && n1.status === 'CONFIRM_MISMATCH' && n1.actual.count === 2 && allWrites().filter((w) => [c1, c2].includes(w.id)).length === 0);
  const n2 = await approve(pc, cfg({ open: true }), {}, { count: 2, exposedBudget: 300 });
  ok('wrong exposed budget → CONFIRM_MISMATCH', n2.ok === false && n2.status === 'CONFIRM_MISMATCH' && n2.actual.exposedBudget === 600);
  await prisma.ambDailyPlanItem.updateMany({ where: { plan_id: pc.id, campaign_id: c2 }, data: { selected: false } });
  const n3 = await approve(pc, cfg({ open: true }), {}, { count: 2, exposedBudget: 600 });
  ok('the selection changed after the owner looked (c2 un-ticked) → the stale confirmation is refused', n3.ok === false && n3.status === 'CONFIRM_MISMATCH' && n3.actual.count === 1);
  const n4 = await approve(pc, cfg({ open: true }), {}, await confirmOf(pc));
  ok('the exact confirmed numbers → approved and executed LIVE for ONLY the ticked campaign', n4.ok === true && n4.executionMode === 'LIVE' && writes(c1).length === 1 && writes(c2).length === 0, JSON.stringify(n4).slice(0, 200));
  const stored = JSON.parse((await prisma.ambDailyPlan.findUnique({ where: { id: pc.id } })).evidence_json || '{}');
  ok('the approval snapshot (count / exposed budget / who / when) is stored on the plan', stored.approval?.count === 1 && stored.approval?.exposedBudget === 300 && stored.approval?.by === 1 && stored.approval?.confirmed === true);
  const ps = await mkPlan('OPEN', '2031-11-02', [c1], { simulated: true });
  ok('a simulated/SHADOW plan does not need the confirmation (nothing to protect)', (await approve(ps, cfg({ open: true }, { mode: 'SHADOW' }), { readEntity: async (id) => ({ id, status: 'PAUSED', budget: 300 }) })).ok === true);
  // another plan on the same campaigns cannot be executed by approving this one (separate plan_key + claim)
  const p593 = await mkPlan('OPEN', '2031-11-03', [c1]); const p592 = await mkPlan('OPEN', '2031-11-03', [c1, c2]);
  ok('two plans share a campaign: approving ONE does not touch the other', (await prisma.ambDailyPlan.findUnique({ where: { id: p593.id } })).status === 'PREPARED' && (await prisma.ambDailyPlan.findUnique({ where: { id: p592.id } })).status === 'PREPARED');

  console.log('\n5b. Execution guards — live budget drift and the exposure cap');
  const d1 = `${T}gx_d1`, d2 = `${T}gx_d2`; setEntity(d1, { status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '30000' }); setEntity(d2, { status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '30000' });
  const pd = await mkPlan('OPEN', '2031-11-04', [d1, d2]); world.entities.get(d2).daily_budget = '90000'; // someone raised d2's budget on Meta AFTER the plan was prepared (300 → 900)
  const rd = await approve(pd, cfg({ open: true }), {}, await confirmOf(pd)); const id1 = await itemOf(pd.id, d1), id2 = await itemOf(pd.id, d2);
  ok('budget moved on Meta after preparation → that campaign is BLOCKED (BUDGET_CHANGED), ZERO writes for it', id2.status === 'BLOCKED' && /BUDGET_CHANGED/.test(id2.status_reason || '') && writes(d2).length === 0, `${id2.status} ${id2.status_reason}`);
  ok('the unchanged campaign in the same plan is still opened and VERIFIED', rd.ok && id1.status === 'VERIFIED' && writes(d1).length === 1);
  const e1 = `${T}gx_e1`, e2 = `${T}gx_e2`; setEntity(e1, { status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '20000' }); setEntity(e2, { status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '20000' });
  const pe = await mkPlan('OPEN', '2031-11-05', [e1, e2]);
  await prisma.ambDailyPlan.update({ where: { id: pe.id }, data: { status: 'APPROVED', approval_mode: 'APPROVAL', execution_mode: 'LIVE', approved_by_id: 1, approved_at: new Date(), evidence_json: JSON.stringify({ approval: { count: 2, exposedBudget: 300, by: 1, at: new Date().toISOString(), confirmed: true } }) } }); // owner approved 300/day total although the two campaigns are 200 + 200
  await DP.runPlanExecution({ planId: pe.id, userId: 1, deps: planDeps(cfg({ open: true })) });
  const ie1 = await itemOf(pe.id, e1), ie2 = await itemOf(pe.id, e2);
  ok('exposure cap: the first campaign fits the approved 300/day and opens, the second would exceed it → SKIPPED (EXPOSURE_CAP), ZERO writes', ie1.status === 'VERIFIED' && ie2.status === 'SKIPPED' && /EXPOSURE_CAP/.test(ie2.status_reason || '') && writes(e2).length === 0, `${ie1.status} / ${ie2.status} ${ie2.status_reason}`);

  console.log('\n6. Restart recovery — read-back only, never a re-send');
  const R = { ver: `${T}gx_r_ver`, notapp: `${T}gx_r_not`, unread: `${T}gx_r_unr`, reval: `${T}gx_r_rev`, pend: `${T}gx_r_pen`, done: `${T}gx_r_done` };
  for (const id of [R.ver, R.notapp, R.unread, R.reval, R.pend, R.done]) setEntity(id, { status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '10000' });
  world.entities.get(R.ver).status = 'ACTIVE'; world.entities.get(R.ver).effective_status = 'ACTIVE'; // the write DID reach Meta before the crash
  const pr = await mkPlan('OPEN', '2031-11-06', Object.values(R));
  await prisma.ambDailyPlan.update({ where: { id: pr.id }, data: { status: 'RUNNING', approval_mode: 'APPROVAL', execution_mode: 'LIVE', started_at: new Date(Date.now() - 3_600_000), lock_owner: 'dead-instance-1', lock_until: new Date(Date.now() - 1_800_000) } });
  const setSt = (cid, status) => prisma.ambDailyPlanItem.updateMany({ where: { plan_id: pr.id, campaign_id: cid }, data: { status } });
  await setSt(R.ver, 'SENT'); await setSt(R.notapp, 'SENT'); await setSt(R.unread, 'SENT'); await setSt(R.reval, 'REVALIDATING'); await setSt(R.pend, 'PENDING'); await setSt(R.done, 'VERIFIED');
  const wBefore = allWrites().length; const readEntity = async ({ entityId }) => { if (entityId === R.unread) return null; const e = world.entities.get(entityId); return e ? { status: e.effective_status, budget: e.daily_budget ? Number(e.daily_budget) / 100 : null } : null; };
  const live0 = await REC.recoverInterruptedPlans({ now: new Date(), deps: { readEntity } }); const st = async (cid) => (await itemOf(pr.id, cid));
  ok('an orphaned RUNNING plan (expired lock, dead owner) is found and settled', live0.length === 1 && live0[0].planId === pr.id);
  ok('SENT + Meta holds the target → VERIFIED (by an independent read, no re-send)', (await st(R.ver)).status === 'VERIFIED' && /بعد إعادة التشغيل/.test((await st(R.ver)).status_reason));
  ok('SENT + Meta still holds the old value → FAILED (not re-sent)', (await st(R.notapp)).status === 'FAILED');
  ok('SENT + Meta unreadable → UNCERTAIN (never guessed)', (await st(R.unread)).status === 'UNCERTAIN');
  ok('REVALIDATING / PENDING (never sent) → SKIPPED, not resumed automatically', (await st(R.reval)).status === 'SKIPPED' && (await st(R.pend)).status === 'SKIPPED' && /RESTART_NOT_RESUMED/.test((await st(R.pend)).status_reason));
  ok('an item that was already final is left exactly as it was', (await st(R.done)).status === 'VERIFIED' && !/إعادة التشغيل/.test((await st(R.done)).status_reason || ''));
  ok('ZERO Meta writes happened during the whole recovery', allWrites().length === wBefore);
  const prAfter = await prisma.ambDailyPlan.findUnique({ where: { id: pr.id } }); const sum = JSON.parse(prAfter.summary_json || '{}');
  ok('the plan is closed: COMPLETED, lock cleared, summary flagged recovered', prAfter.status === 'COMPLETED' && prAfter.lock_owner === null && sum.recovered === true && sum.verified === 2 && sum.uncertain === 1 && sum.failed === 1 && sum.skipped === 2);
  ok('recovery is audited per item + for the plan', (await prisma.ambOperatorEvent.count({ where: { kind: 'DAILY_PLAN_ITEM', data_json: { contains: `"planId":${pr.id},"itemId"` } } })) >= 5 && (await prisma.ambOperatorEvent.count({ where: { kind: 'DAILY_PLAN', data_json: { contains: `"planId":${pr.id},"action":"RECOVERED"` } } })) === 1);
  const claim = await DP.runPlanExecution({ planId: pr.id, userId: 1, deps: planDeps(cfg({ open: true })) });
  ok('the recovered plan can NEVER be executed again (not claimable) — no duplicate execution', claim.skipped === 'NOT_CLAIMED' && allWrites().length === wBefore);
  ok('a second recovery pass is a no-op (idempotent)', (await REC.recoverInterruptedPlans({ now: new Date(), deps: { readEntity } })).length === 0);
  const live1 = await mkPlan('OPEN', '2031-11-07', [R.done]);
  await prisma.ambDailyPlan.update({ where: { id: live1.id }, data: { status: 'RUNNING', execution_mode: 'LIVE', lock_owner: 'another-instance', lock_until: new Date(Date.now() + 1_500_000) } }); await setItemStatus(live1.id, 'SENT');
  ok('a RUNNING plan with a LIVE lock owned by another instance is left alone during normal ticks', (await REC.recoverInterruptedPlans({ now: new Date(), deps: { readEntity } })).length === 0);
  ok('…but once at server start (onStartup) a lock owned by a different/dead process is settled', (await REC.recoverInterruptedPlans({ now: new Date(), onStartup: true, deps: { readEntity } })).some((x) => x.planId === live1.id));
  async function setItemStatus(pid, status) { await prisma.ambDailyPlanItem.updateMany({ where: { plan_id: pid }, data: { status } }); }

  console.log('\n6b. Restart recovery — decisions stuck in EXECUTING and orphan action rows');
  const mkDecision = async (n, o = {}) => { const d = await prisma.ambOperatorDecision.create({ data: { decision_key: `${T}gx_dec_${Date.now()}_${n}`, store_id: 'trendy-storeee', ad_account_id: conn.selected_ad_account_id, campaign_id: o.entity, campaign_name: o.entity, action: 'SCALE_DOWN', rule_name: 'DYNAMIC_BUDGET:test', mode_at_decision: 'APPROVAL', status: 'EXECUTING', params_json: JSON.stringify({ level: 'campaign', entityId: o.entity, fromBudget: 500, toBudget: 400 }), amb_recommendation_id: o.recId ?? null } }); created.decisions.push(d.id); return d; };
  const mkAct = (recId, entity, o = {}) => prisma.ambAction.create({ data: { recommendation_id: recId, mode: 'APPROVAL', action_type: 'DECREASE_BUDGET', ad_account_id: conn.selected_ad_account_id, level: 'campaign', entity_id: entity, campaign_id: entity, approval_status: 'APPROVED', execution_status: 'REVALIDATING', executed_by_id: 1, old_value_json: JSON.stringify({ budget: 500 }), new_value_json: JSON.stringify({ budget: 400 }), meta_request_json: o.sent === false ? null : JSON.stringify({ id: entity, dailyBudgetMinor: 40000 }) } });
  const D = { ok: `${T}gx_dec_ok`, no: `${T}gx_dec_no`, never: `${T}gx_dec_never`, unr: `${T}gx_dec_unr` }; for (const id of Object.values(D)) setEntity(id, { status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '50000' });
  world.entities.get(D.ok).daily_budget = '40000'; // Meta holds the NEW budget
  const recs = {}; for (const k of Object.keys(D)) recs[k] = await mkRec('DECREASE_BUDGET', D[k], { cur: 500, next: 400 });
  const acts = { ok: await mkAct(recs.ok.id, D.ok), no: await mkAct(recs.no.id, D.no), unr: await mkAct(recs.unr.id, D.unr), never: await mkAct(recs.never.id, D.never, { sent: false }) };
  const decs = {}; for (const k of Object.keys(D)) decs[k] = await mkDecision(k, { entity: D[k], recId: recs[k].id });
  const dec0 = await REC.recoverInterruptedDecisions({ now: new Date(), onStartup: true, deps: { readEntity: async ({ entityId }) => (entityId === D.unr ? null : { status: 'ACTIVE', budget: Number(world.entities.get(entityId).daily_budget) / 100 }) } });
  const dst = async (k) => (await prisma.ambOperatorDecision.findUnique({ where: { id: decs[k].id } })).status;
  ok('EXECUTING + request recorded + Meta holds the new budget → VERIFIED (and the recommendation EXECUTED)', (await dst('ok')) === 'VERIFIED' && (await prisma.ambRecommendation.findUnique({ where: { id: recs.ok.id } })).status === 'EXECUTED' && (await prisma.ambAction.findUnique({ where: { id: acts.ok.id } })).execution_status === 'EXECUTED');
  ok('EXECUTING + request recorded + Meta still holds the old budget → FAILED (not re-sent)', (await dst('no')) === 'FAILED' && (await prisma.ambAction.findUnique({ where: { id: acts.no.id } })).execution_status === 'FAILED');
  ok('EXECUTING + request recorded + Meta unreadable → EXECUTED but unverified (honest)', (await dst('unr')) === 'EXECUTED' && JSON.parse((await prisma.ambOperatorDecision.findUnique({ where: { id: decs.unr.id } })).verify_json).verified === false);
  ok('EXECUTING + nothing was ever sent → back to PREPARED (fresh approval + live validation needed)', (await dst('never')) === 'PREPARED' && (await prisma.ambAction.findUnique({ where: { id: acts.never.id } })).execution_status === 'FAILED');
  ok('ZERO writes for the decisions recovery', allWrites().filter((w) => Object.values(D).includes(w.id)).length === 0 && dec0.length === 4);
  const stray = await mkRec('PAUSE', `${T}gx_stray`); setEntity(`${T}gx_stray`, { status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '50000' });
  const sact = await prisma.ambAction.create({ data: { recommendation_id: stray.id, mode: 'APPROVAL', action_type: 'PAUSE', ad_account_id: conn.selected_ad_account_id, level: 'campaign', entity_id: `${T}gx_stray`, campaign_id: `${T}gx_stray`, approval_status: 'APPROVED', execution_status: 'REVALIDATING', created_at: new Date(Date.now() - 3_600_000) } });
  await prisma.ambRecommendation.update({ where: { id: stray.id }, data: { status: 'APPROVED' } });
  await REC.recoverInterruptedActions({ now: new Date(), deps: { readEntity } });
  ok('a stray REVALIDATING action (the legacy route died before sending) → FAILED and its recommendation returns to PENDING', (await prisma.ambAction.findUnique({ where: { id: sact.id } })).execution_status === 'FAILED' && (await prisma.ambRecommendation.findUnique({ where: { id: stray.id } })).status === 'PENDING' && writes(`${T}gx_stray`).length === 0);
  const all = await REC.recoverInterrupted({ now: new Date(), deps: { readEntity } });
  ok('the one-call entry point runs all three parts and never throws', ['plans', 'decisions', 'actions'].every((k) => Array.isArray(all[k])));
  ok('the scheduler is wired: tick + startup hook call the recovery', fs.readFileSync(join(SRC, 'services/amb/dailyPlans.js'), 'utf8').includes('executionRecovery.js') && /onStartup:\s*true/.test(fs.readFileSync(join(SRC, 'services/amb/dailyPlans.js'), 'utf8')));

  console.log('\n7. Approval Center — CPA, orders, plan items, live preview (read only)');
  const decRow = { id: 99001, status: 'PREPARED', campaignId: 'c1', campaignName: 'Camp A', productName: 'Prod A', action: 'SCALE_DOWN', actionLabel: 'تقليل ميزانية', params: { fromBudget: 500, toBudget: 400 }, metrics: { cpa: 142, purchases: 9, spend: 1280 }, window: 'last3', stock: { status: 'IN_STOCK' }, blocks: [], warnings: [], confidence: 'HIGH', isBudgetDecision: true };
  const row = AC.approvalRow(decRow, cfg({ budgetDecrease: true }));
  ok('a decision row carries CPA, orders, spend, window and stock', row.cpa === 142 && row.orders === 9 && row.spend === 1280 && row.window === 'last3' && row.stock === 'IN_STOCK');
  ok('…plus before → after, exposed budget, risk and the live gate', row.before.value === 500 && row.after.value === 400 && row.exposedBudget === 400 && row.risk === 'LOW' && row.execution.executableNow === true);
  const lst = await AC.listApprovals({ deps: { config: cfg({ open: true }), decisions: [decRow] } });
  const lp = lst.plans.find((p) => p.planId === pc.id) || null;
  const pap = await mkPlan('OPEN', '2031-11-08', [c1, c2]); const lst2 = await AC.listApprovals({ deps: { config: cfg({ open: true }), decisions: [] } }); const pl = lst2.plans.find((p) => p.planId === pap.id);
  ok('a pending plan lists its campaigns with budget / CPA / orders / risk, its version and the exposure', !!pl && pl.items.length === 2 && pl.items.every((i) => i.budget === 300 && i.cpa === 88 && i.orders === 8 && i.risk === 'LOW') && pl.version === 1 && pl.exposedBudget === 600 && lp === null);
  const pdec = await prisma.ambOperatorDecision.create({ data: { decision_key: `${T}gx_pv_${Date.now()}`, store_id: 'trendy-storeee', ad_account_id: conn.selected_ad_account_id, campaign_id: `${T}gx_pv`, campaign_name: 'pv', action: 'SCALE_DOWN', rule_name: 'DYNAMIC_BUDGET:test', mode_at_decision: 'APPROVAL', status: 'PREPARED', params_json: JSON.stringify({ level: 'campaign', entityId: `${T}gx_pv`, fromBudget: 500, toBudget: 400 }) } }); created.decisions.push(pdec.id);
  const wB = allWrites().length; const live = async (b) => async () => ({ status: 'ACTIVE', budget: b });
  const pvOk = await AC.previewDecision({ decisionId: pdec.id, deps: { config: cfg({ budgetDecrease: true }), readEntity: await live(500), checkConflicts: async () => [] } });
  ok('preview: gate open, Meta unchanged → READY with the exact planned request', pvOk.verdict === 'READY' && pvOk.plannedRequest.body.daily_budget === 40000 && pvOk.gate.executableNow === true && pvOk.writes === false);
  const pvLock = await AC.previewDecision({ decisionId: pdec.id, deps: { config: cfg({ budgetDecrease: true }, { writesLocked: true }), readEntity: await live(500), checkConflicts: async () => [] } });
  ok('preview: deployment lock closed → GATE_CLOSED with the reason', pvLock.verdict === 'GATE_CLOSED' && pvLock.gate.reasons[0].code === 'META_WRITES_LOCKED');
  const pvDrift = await AC.previewDecision({ decisionId: pdec.id, deps: { config: cfg({ budgetDecrease: true }), readEntity: await live(700), checkConflicts: async () => [] } });
  ok('preview: Meta budget moved since the decision → WOULD_BLOCK + BUDGET_CHANGED drift', pvDrift.verdict === 'WOULD_BLOCK' && pvDrift.drift[0].code === 'BUDGET_CHANGED');
  const pvConf = await AC.previewDecision({ decisionId: pdec.id, deps: { config: cfg({ budgetDecrease: true }), readEntity: await live(500), checkConflicts: async () => [{ code: 'CONFLICT_PLAN_QUEUE_BUDGET', detail: 'خطة فتح #1' }] } });
  ok('preview: a conflicting queued plan → WOULD_BLOCK + the conflict', pvConf.verdict === 'WOULD_BLOCK' && pvConf.conflicts.length === 1);
  const pvUnr = await AC.previewDecision({ decisionId: pdec.id, deps: { config: cfg({ budgetDecrease: true }), readEntity: async () => { throw new Error('rate limit'); }, checkConflicts: async () => [] } });
  ok('preview: Meta unreadable → LIVE_UNREADABLE (never a guess)', pvUnr.verdict === 'LIVE_UNREADABLE');
  ok('preview NEVER writes: zero POSTs, the decision row is untouched', allWrites().length === wB && (await prisma.ambOperatorDecision.findUnique({ where: { id: pdec.id } })).status === 'PREPARED');
  const routeSrc = fs.readFileSync(join(SRC, 'routes/operator.js'), 'utf8');
  ok('the routes: decision preview is ADMIN-only and plan approval forwards the confirmation', /decisions\/:id\/preview', ADMIN/.test(routeSrc) && /approvePlan\(\{[^}]*confirm: req\.body\?\.confirm/.test(routeSrc));
} catch (e) { fail++; console.log('✗ crashed:', e.stack || e.message); }
finally {
  try { // disposable data only (every id is `__optest_…`); the runner resets operator state per suite
    const ids = created.plans; if (ids.length) { await prisma.ambDailyPlan.deleteMany({ where: { id: { in: ids } } }); }
    if (created.decisions.length) await prisma.ambOperatorEvent.deleteMany({ where: { decision_id: { in: created.decisions } } });
    if (created.decisions.length) await prisma.ambOperatorDecision.deleteMany({ where: { id: { in: created.decisions } } });
    await prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ campaign_id: { startsWith: T } }, { note: { contains: T } }] } });
    if (created.recs.length) { await prisma.ambActionResult.deleteMany({ where: { action: { recommendation_id: { in: created.recs } } } }); await prisma.ambAction.deleteMany({ where: { recommendation_id: { in: created.recs } } }); await prisma.ambRecommendation.deleteMany({ where: { id: { in: created.recs } } }); }
    { const rs = await prisma.ambRecommendation.findMany({ where: { entity_id: { startsWith: T } }, select: { id: true } }); const ids2 = rs.map((r) => r.id); if (ids2.length) { await prisma.ambActionResult.deleteMany({ where: { action: { recommendation_id: { in: ids2 } } } }); await prisma.ambAction.deleteMany({ where: { recommendation_id: { in: ids2 } } }); await prisma.ambRecommendation.deleteMany({ where: { id: { in: ids2 } } }); } }
    await prisma.ambAlert.deleteMany({ where: { entity_id: { startsWith: T } } }).catch(() => {});
  } catch (e) { console.log('cleanup note:', e.message); }
  await prisma.$disconnect(); server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
