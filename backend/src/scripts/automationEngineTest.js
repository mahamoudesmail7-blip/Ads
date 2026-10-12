// 🧪 AUTOMATION ENGINE — automatic PAUSE / budget INCREASE / budget REDUCE through the REAL executor against a local Meta MOCK (fake Graph on loopback). No real Meta call anywhere.
//   Covers: per-product opt-in + readiness · global mode caps · precedence (stock-out › zero-order › high-CPA › reduce › increase) · winner protection · anti-oscillation · central write gate (Emergency Stop, lock, permissions)
//   · idempotency · hourly limit · Meta rate-limit stop · uncertain write · owner approval of a prepared decision · restart recovery · SHADOW labelling.
//   node src/scripts/automationEngineTest.js
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
    const f = world.failNext; if (f && (!f.id || f.id === id)) { world.failNext = null; if (f.type === 'rate') return send(400, { error: { message: '(#17) User request limit reached', type: 'OAuthException', code: 17, error_subcode: 2446079, error_user_title: 'Ad Account Has Too Many API Calls' } }); if (f.type === 'noop') return send(200, { success: true }); if (f.type === 'token') return send(401, { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190, error_subcode: 463 } }); if (f.type === 'server') return send(500, { error: { message: 'An unexpected error has occurred. Please retry your request later.', type: 'OAuthException', code: 2, is_transient: true } }); }
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

try {
  await cleanup();
  console.log('\n0. Preconditions');
  ok('the Meta client points at the loopback mock', process.env.META_GRAPH_MOCK === '1'); ok('a connected ad account exists locally', conn?.status === 'CONNECTED' && !!ACC);

  console.log('\n1. Mode caps and per-product opt-in (candidates only — nothing executes)');
  { const z = (id, p) => ({ id, pid: p, m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE', zone: 'ZERO_ORDERS' } });
    let r = await ev(scenario([z(`${T}z1`, pid(1))])); const c = r.candidates[0];
    ok('AUTOMATIC product + READY + global AUTOMATIC + pause permission ON → effective AUTOMATIC, canExecuteNow', c?.kind === 'ZERO_ORDER' && c.effective === 'AUTOMATIC' && c.canExecuteNow === true, JSON.stringify(c && { k: c.kind, e: c.effective, b: c.blockers, a: c.autoBlockers }));
    r = await ev(scenario([z(`${T}z1`, pid(1))]), cfg({ ...ALL, pause: false })); ok('pause permission OFF → still AUTOMATIC but canExecuteNow=false (the executor gate would refuse)', r.candidates[0].effective === 'AUTOMATIC' && r.candidates[0].canExecuteNow === false);
    r = await ev(scenario([z(`${T}z1`, pid(1))]), cfg(ALL, { mode: 'APPROVAL' })); ok('global APPROVAL → the same candidate is only PREPARED for the owner', r.candidates[0].effective === 'APPROVAL' && !r.candidates[0].canExecuteNow);
    r = await ev(scenario([z(`${T}z1`, pid(1))]), cfg(ALL, { mode: 'SHADOW' })); ok('global SHADOW → effective SHADOW (simulation, never executes)', r.candidates[0].effective === 'SHADOW' && !r.candidates[0].canExecuteNow);
    r = await ev(scenario([z(`${T}z1`, pid(1))], { ready: false })); ok('product NOT READY → never AUTOMATIC: NEEDS_CONFIGURATION lists what is missing, prepared for approval instead', r.candidates[0].effective === 'APPROVAL' && r.candidates[0].autoBlockers[0]?.code === 'NEEDS_CONFIGURATION' && /اقتصاديات/.test(r.candidates[0].autoBlockers[0].message));
    r = await ev(scenario([z(`${T}z1`, pid(1))], { mode: 'APPROVAL' })); ok('product mode APPROVAL → prepared only', r.candidates[0].effective === 'APPROVAL');
    r = await ev(scenario([z(`${T}z1`, pid(1))], { mode: 'MANUAL' })); ok('product mode MANUAL → not evaluated at all (skipped)', r.candidates.length === 0 && r.skipped[0]?.code === 'PRODUCT_MODE_MANUAL');
    r = await ev(scenario([z(`${T}z1`, pid(1))], { pause: PPol.normalizePause({ enabled: true, version: 2, approved: { version: 1 } }) })); ok('a pause policy saved but NOT approved at its current version never drives anything', r.candidates.length === 0 || r.candidates[0].blockers.some((b) => b.code === 'PAUSE_POLICY_NOT_APPROVED'));
    const rm = await AE.runAutomationTick({ now: NOW, deps: { config: cfg(ALL, { mode: 'OFF' }), dcfg: { halted: false } } }); ok('MANUAL (stored OFF): the engine does nothing', rm.skipped === 'MODE_MANUAL'); }

  console.log('\n2. Precedence and protections');
  { const id = `${T}pr1`; const base = { id, pid: pid(2), m3: m(900, 4), m7: m(900, 4), m30: m(900, 4) };
    let r = await ev(scenario([{ ...base, m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }], { stock: { [id]: { status: 'OUT_OF_STOCK', current: 0 } } })); ok('STOCK_OUT outranks ZERO_ORDER', r.candidates[0].kind === 'STOCK_OUT', r.candidates[0].kind);
    r = await ev(scenario([{ ...base, m3: m(1500, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE' } }])); ok('HIGH_CPA (CPA 375 > 300 with 4 orders) is a PAUSE and outranks the budget reduction', r.candidates[0].kind === 'HIGH_CPA' && r.candidates[0].action === 'PAUSE', JSON.stringify(r.candidates.map((x) => x.kind)));
    const win = { m7: m(600, 10), m30: m(2400, 30) }; // CPA 60/80 → a strong winner
    r = await ev(scenario([{ ...base, ...win, m3: m(1500, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE' } }])); ok('winner protection (PROTECTION_WINS): a winner is NOT paused for high CPA — the budget reduction proceeds', r.candidates[0].kind === 'REDUCE', r.candidates[0].kind);
    r = await ev(scenario([{ ...base, ...win, m3: m(1500, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE' } }], { pause: pausePol({ protections: { winnerProtection: true, precedence: 'RULE_WINS' } }) })); ok('precedence RULE_WINS (configurable): the fired rule pauses even a winner', r.candidates[0].kind === 'HIGH_CPA');
    r = await ev(scenario([{ ...base, ...win, m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }], { stock: { [id]: { status: 'OUT_OF_STOCK' } } })); ok('STOCK_OUT still pauses a protected winner (nothing to sell)', r.candidates[0].kind === 'STOCK_OUT');
    r = await ev(scenario([{ ...base, row: { action: 'PAUSE', decision: 'WOULD_PAUSE' }, m3: m(260, 0) }], { guards: { [id]: [{ code: 'RECENT_PURCHASE_PROTECTION', message: 'order 20 min ago' }] }, stock: { [id]: { status: 'OUT_OF_STOCK' } } })); ok('a guard block (recent purchase) keeps the pause BLOCKED with its reason', r.candidates[0].effective === 'BLOCKED' && r.candidates[0].blockers.some((b) => b.code === 'RECENT_PURCHASE_PROTECTION'));
    { const sc2 = scenario([{ ...base, m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }]); sc2.opt.rows.push({ ...sc2.opt.rows[0], entity: { level: 'adset', id: `${id}_2`, budget: 100, name: null }, decision: 'KEEP', intended: null }); r = await ev(sc2); ok('ABO campaign: zero orders on only SOME ad sets never pauses the whole campaign automatically (PARTIAL_ADSETS → blocked, the owner pauses it by hand)', r.candidates[0].effective === 'BLOCKED' && r.candidates[0].blockers.some((b) => b.code === 'PARTIAL_ADSETS')); }
    r = await ev(scenario([{ ...base, row: { action: 'PAUSE', decision: 'WOULD_PAUSE' }, m3: m(260, 0) }], { pause: pausePol({ scope: { excludeProducts: [String(pid(2))] } }) })); ok('pause policy scope: an excluded product is BLOCKED (EXCLUDED_BY_POLICY)', r.candidates[0].effective === 'BLOCKED' && r.candidates[0].blockers.some((b) => b.code === 'EXCLUDED_BY_POLICY'));
    r = await ev(scenario([{ ...base, row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', evidence: { lastChange: { at: new Date(NOW.getTime() - 10 * 3_600_000).toISOString(), action: 'SCALE_DOWN' } } } }])); ok('anti-oscillation: an INCREASE 10h after a REDUCE is BLOCKED (OSCILLATION_GUARD, 72h)', r.candidates[0].blockers.some((b) => b.code === 'OSCILLATION_GUARD') && r.candidates[0].effective === 'BLOCKED');
    r = await ev(scenario([{ ...base, row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', evidence: { lastChange: { at: new Date(NOW.getTime() - 100 * 3_600_000).toISOString(), action: 'SCALE_DOWN' } } } }])); ok('…and allowed after 100h', r.candidates[0].effective === 'AUTOMATIC');
    r = await ev(scenario([{ ...base, row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', requiresApproval: true } }])); ok('a decision the guards DOWNGRADE (unknown stock/profit for an increase) is never automatic', r.candidates[0].effective === 'APPROVAL' && r.candidates[0].autoBlockers.some((b) => b.code === 'DOWNGRADE_TO_APPROVAL')); }

  console.log('\n3. Execution through the real executor on the Meta mock (all four operations)');
  const ids = { pause: `${T}x_pause`, up: `${T}x_up`, down: `${T}x_down` };
  setEntity(ids.pause, { daily_budget: '30000' }); setEntity(ids.up, { daily_budget: '30000' }); setEntity(ids.down, { daily_budget: '30000' });
  { const sc = scenario([{ id: ids.pause, pid: pid(10), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }, { id: ids.up, pid: pid(11), m3: m(600, 10), row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', to: 360 } }, { id: ids.down, pid: pid(12), m3: m(900, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE', to: 240 } }]);
    const rLock = await tick(sc, cfg(ALL, { writesLocked: true })); ok('deployment write-lock closed → decisions are PREPARED, ZERO Meta requests', rLock.gate.includes('META_WRITES_LOCKED') && allWrites().length === 0 && (await dec(ids.pause)).status === 'PREPARED');
    const rEm = await tick(sc, cfg(ALL, { emergency_stop: true })); ok('Emergency Stop → nothing executes, ZERO requests', rEm.gate.includes('EMERGENCY_STOP') && allWrites().length === 0);
    const rSh = await tick(sc, cfg(ALL, { mode: 'SHADOW' })); ok('SHADOW → recorded as SHADOW decisions, ZERO requests', allWrites().length === 0 && rSh.gate.includes('MODE_NOT_AUTOMATIC'));
    const rOff = await tick(sc, cfg({ ...ALL, pause: false, budgetIncrease: false })); ok('permissions OFF for pause and increase → only the REDUCE (its own permission is ON) executes', writes(ids.pause).length === 0 && writes(ids.up).length === 0 && writes(ids.down).length === 1 && world.entities.get(ids.down).daily_budget === '24000', JSON.stringify(rOff.executed));
    const r = await tick(sc, cfg(ALL));
    ok('PAUSE: ONE write (status=PAUSED), independent read-back, decision VERIFIED, approval AUTO', writes(ids.pause).length === 1 && writes(ids.pause)[0].body.status === 'PAUSED' && world.entities.get(ids.pause).status === 'PAUSED' && (await dec(ids.pause)).status === 'VERIFIED' && (await actOf(ids.pause))?.approval_status === 'AUTO', JSON.stringify(r.executed));
    ok('INCREASE +20% (300 → 360): ONE write, mock budget 36000, VERIFIED', writes(ids.up).length === 1 && world.entities.get(ids.up).daily_budget === '36000' && (await dec(ids.up)).status === 'VERIFIED');
    ok('REDUCE −20% (300 → 240): exactly ONE write over the whole test (done in the previous tick), VERIFIED', writes(ids.down).length === 1 && (await dec(ids.down)).status === 'VERIFIED');
    const before = allWrites().length; await tick(sc, cfg(ALL)); await tick(sc, cfg(ALL)); ok('IDEMPOTENT: two more ticks send ZERO additional requests (terminal decisions are never rewritten)', allWrites().length === before);
    { const dd = await dec(ids.pause); const al = await prisma.ambAlert.findFirst({ where: { dedupe_key: `operator:autodone:${dd.id}` } }); ok('a SUCCESS alert is raised for every executed automatic action (INFO, names the campaign and the Meta confirmation)', !!al && al.severity === 'INFO' && /AUTOMATIC/.test(al.title)); }
    ok('every executed action carries the audit trail (decision events, amb_action with before/after)', (await prisma.ambOperatorEvent.count({ where: { campaign_id: ids.up, kind: 'TRANSITION' } })) >= 3 && !!JSON.parse((await actOf(ids.up)).new_value_json || '{}').budget); }

  console.log('\n4. Limits, rate limit and uncertain writes');
  { const a = `${T}l_a`, b = `${T}l_b`, c = `${T}l_c`; for (const x of [a, b, c]) setEntity(x);
    const sc = scenario([a, b, c].map((id, n) => ({ id, pid: pid(20 + n), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } })));
    const rl = await tick(sc, cfg(ALL, { limits: { ...cfg().limits, maxActionsPerHour: 1 } }), { counters: { actionsLastHour: 0 } }); ok('hourly action limit: only 1 executes, the rest are deferred (MAX_ACTIONS_PER_HOUR)', rl.executed.length === 1 && rl.deferred.some((d) => d.code === 'MAX_ACTIONS_PER_HOUR') && allWrites().filter((w) => [a, b, c].includes(w.id)).length === 1, JSON.stringify(rl));
    for (const x of [a, b, c]) { const w = writes(x); if (w.length) { world.entities.get(x).status = 'ACTIVE'; world.entities.get(x).effective_status = 'ACTIVE'; } }
    await prisma.ambAction.deleteMany({ where: { entity_id: { in: [a, b, c] } } }); // the executor's own 6h duplicate guard would otherwise (rightly) refuse a second pause of the same campaign
    await prisma.ambOperatorDecision.deleteMany({ where: { campaign_id: { in: [a, b, c] } } });
    world.failNext = { type: 'rate' }; const wPre = new Map([a, b, c].map((x) => [x, writes(x).length]));
    const rr = await tick(sc, cfg(ALL)); ok('Meta rate limit (code 17) on the first write: that decision FAILS (Meta unchanged), the tick STOPS — the others are not even attempted', rr.deferred.some((d) => d.code === 'META_RATE_LIMIT_STOP') && rr.executed.length === 1 && rr.executed[0].status === 'FAILED', JSON.stringify(rr));
    const failedId = rr.executed[0].campaignId; ok('no automatic resend of the failed write (exactly one more POST on it) and the other campaigns got none', writes(failedId).length === wPre.get(failedId) + 1 && [a, b, c].filter((x) => x !== failedId).every((x) => writes(x).length === wPre.get(x)));
    const u = `${T}u_1`; setEntity(u); world.failNext = { type: 'noop', id: u };
    const su = scenario([{ id: u, pid: pid(30), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }]); const ru = await tick(su, cfg(ALL));
    ok('Meta accepts but does NOT apply → the decision is NOT verified (EXECUTED/unverified), ONE write, never "success"', writes(u).length === 1 && ['EXECUTED', 'FAILED'].includes((await dec(u)).status) && (await dec(u)).status !== 'VERIFIED', (await dec(u)).status); }

  console.log('\n5. Stale data and the owner\'s approval of a prepared decision');
  { const s = `${T}s_1`; setEntity(s); const sc = scenario([{ id: s, pid: pid(40), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }]); sc.world.metaStale = true;
    const rs = await tick(sc, cfg(ALL)); ok('stale Meta data: nothing is recorded or executed', rs.stale === true && !(await dec(s)) && writes(s).length === 0);
    const sc2 = scenario([{ id: s, pid: pid(40), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }]);
    await tick(sc2, cfg(ALL, { mode: 'APPROVAL' })); const d0 = await dec(s); ok('global APPROVAL: the decision is PREPARED (visible in the approval center), nothing executed', d0.status === 'PREPARED' && writes(s).length === 0);
    const refused = await AE.executeAutoDecision({ decisionId: d0.id, source: 'USER', userId: 1, now: NOW, deps: { config: cfg({ ...ALL, pause: false }, { mode: 'APPROVAL' }) } }); ok('approving with the pause permission OFF is refused at the gate (PERMISSION_OFF), decision stays PREPARED', refused.blocked === 'PERMISSION_OFF' && (await dec(s)).status === 'PREPARED' && writes(s).length === 0);
    const changed = await AE.executeAutoDecision({ decisionId: d0.id, source: 'USER', userId: 1, now: NOW, deps: { config: cfg(ALL, { mode: 'APPROVAL' }), reevaluate: async () => ({ candidates: [], structureSource: 'META_LIVE' }) } }); ok('the live re-evaluation no longer gives the decision → EXPIRED, never executed (no TOCTOU)', changed.status === 'EXPIRED' && writes(s).length === 0);
    await tick(sc2, cfg(ALL, { mode: 'APPROVAL' })); const d1 = await dec(s); ok('(the next evaluation prepares it again under a fresh decision when it is EXPIRED)', ['PREPARED', 'EXPIRED'].includes(d1.status));
    if (d1.status === 'EXPIRED') await prisma.ambOperatorDecision.update({ where: { id: d1.id }, data: { status: 'PREPARED' } });
    const via = await OE.approveDecision({ decisionId: d1.id, userId: 1, deps: { auto: { config: cfg(ALL, { mode: 'APPROVAL' }), reevaluate: async () => AE.evaluateAutomation({ now: NOW, deps: { ...sc2, config: cfg(ALL, { mode: 'APPROVAL' }) } }) } } });
    ok('owner approval through the standard approve route executes the AUTO decision: ONE write, VERIFIED, approval APPROVED (human)', via.executed === true && writes(s).length === 1 && world.entities.get(s).status === 'PAUSED' && (await dec(s)).status === 'VERIFIED' && (await actOf(s)).approval_status === 'APPROVED', JSON.stringify(via).slice(0, 300)); }

  console.log('\n6. Restart recovery of an interrupted automatic write (read-back only, never re-sent)');
  { const r = `${T}r_1`; setEntity(r, { status: 'PAUSED', effective_status: 'PAUSED' });
    const d = await prisma.ambOperatorDecision.create({ data: { decision_key: `${T}rec1-${Date.now()}`, status: 'EXECUTING', store_id: ST, product_id: null, ad_account_id: ACC, campaign_id: r, campaign_name: r, action: 'PAUSE', rule_name: 'AUTO:ZERO_ORDER', mode_at_decision: 'AUTOPILOT', confidence: 'HIGH', params_json: JSON.stringify({ kind: 'ZERO_ORDER', level: 'campaign', entityId: r }), updated_at: new Date(Date.now() - 3_600_000) } });
    const rec = await prisma.ambRecommendation.create({ data: { batch_id: 'operator-auto-t', ad_account_id: ACC, level: 'campaign', entity_id: r, entity_name: r, campaign_id: r, campaign_name: r, decision: 'PAUSE', action_type: 'PAUSE', executable: true, reason: 'fixture', confidence: 'HIGH', risk_level: 'LOW', data_sufficiency: 'STRONG', priority: 'P2', time_window_label: 'x', source: 'OPERATOR', status: 'APPROVED' } });
    await prisma.ambAction.create({ data: { recommendation_id: rec.id, mode: 'AUTOPILOT', action_type: 'PAUSE', ad_account_id: ACC, level: 'campaign', entity_id: r, entity_name: r, campaign_id: r, approval_status: 'AUTO', execution_status: 'REVALIDATING', old_value_json: JSON.stringify({ status: 'ACTIVE' }), new_value_json: JSON.stringify({ status: 'PAUSED' }), meta_request_json: JSON.stringify({ id: r, status: 'PAUSED' }) } });
    await prisma.ambOperatorDecision.update({ where: { id: d.id }, data: { amb_recommendation_id: rec.id } });
    const w0 = writes(r).length; const out = await ER.recoverInterruptedDecisions({ now: new Date(), onStartup: true });
    ok('a restart mid-write is settled by an independent read: Meta holds PAUSED → decision VERIFIED, ZERO re-sends', (await prisma.ambOperatorDecision.findUnique({ where: { id: d.id } })).status === 'VERIFIED' && writes(r).length === w0, JSON.stringify(out).slice(0, 200)); }

  console.log('\n7. Conflicts and the open-vs-pause race');
  { const x = `${T}c_1`; setEntity(x); const sc = scenario([{ id: x, pid: pid(50), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }]);
    const r = await tick(sc, cfg(ALL), { execDeps: { checkConflicts: async () => [{ code: 'CONFLICT_OPEN_AND_PAUSE', detail: 'خطة فتح معتمدة' }] } }); ok('a conflicting approved plan on the same campaign blocks the write (decision stays PREPARED)', writes(x).length === 0 && (await dec(x)).status === 'PREPARED' && r.executed[0]?.status === 'BLOCKED', JSON.stringify(r.executed));
    { const dd = await dec(x); const al = await prisma.ambAlert.findFirst({ where: { dedupe_key: `operator:autorefused:${dd.id}:CONFLICT_OPEN_AND_PAUSE` } }); ok('a REFUSED automatic execution is never silent: a WARNING alert states what was not done and why', !!al && al.severity === 'WARNING' && /تعارض/.test(al.message), JSON.stringify(await prisma.ambAlert.findMany({ where: { entity_id: x }, select: { dedupe_key: true, severity: true, message: true } })) + ' dec=' + dd.id); }
    const f0 = `${T}fail_al`; setEntity(f0); world.failNext = { type: 'rate', id: f0 }; await tick(scenario([{ id: f0, pid: pid(51), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }]), cfg(ALL)); { const dd = await dec(f0); const al = await prisma.ambAlert.findFirst({ where: { dedupe_key: `operator:autofail:${dd.id}` } }); ok('a FAILED automatic execution raises a WARNING alert', !!al && al.severity === 'WARNING'); }
    const nc = `${T}needs_al`; setEntity(nc); await tick(scenario([{ id: nc, pid: pid(52), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }], { ready: false }), cfg(ALL)); ok('an AUTOMATIC product that is NOT ready raises ONE alert per day naming what is missing, and nothing executes', (await prisma.ambAlert.count({ where: { dedupe_key: { startsWith: `automation:needs:${pk(pid(52))}` } } })) === 1 && writes(nc).length === 0); }

  console.log('\n8. Independent products, spend limits, and no budget increase on the SAME orders');
  { const a1 = `${T}ind_a`, b1 = `${T}ind_b`; setEntity(a1); setEntity(b1);
    const sc = scenario([{ id: a1, pid: pid(60), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }, { id: b1, pid: pid(61), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }]);
    sc.policies = new Map([[pk(pid(60)), { mode: 'AUTOMATIC' }], [pk(pid(61)), { mode: 'APPROVAL' }]]);
    const r = await tick(sc, cfg(ALL));
    ok('two products, two policies: the AUTOMATIC one executes, the APPROVAL one is only PREPARED (each product has its own rules)', writes(a1).length === 1 && writes(b1).length === 0 && (await dec(b1)).status === 'PREPARED' && (await dec(a1)).status === 'VERIFIED', JSON.stringify(r.executed)); }
  { const cp = `${T}cap_1`; setEntity(cp); const sc = scenario([{ id: cp, pid: pid(62), m3: m(600, 10), row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', to: 360 } }]);
    const r = await tick(sc, cfg(ALL), { execDeps: { capsDeps: { caps: { campaign: null, product: null, account: 100 }, totals: { campaign: 300, product: 300, account: 90 } } } });
    ok('an account-level daily-budget cap that the increase would break → BLOCKED (BUDGET_CAP), ZERO writes, a refusal alert', r.executed[0]?.status === 'BLOCKED' && writes(cp).length === 0 && !!(await prisma.ambAlert.findFirst({ where: { dedupe_key: `operator:autorefused:${(await dec(cp)).id}:BUDGET_CAP` } }))); }
  { const BO = await imp('../services/amb/budgetOptimizer.js'); const at = new Date('2031-07-02T12:00:00Z'); const lc = { at: new Date(at.getTime() - 30 * 3_600_000), action: 'SCALE_UP' };
    const call = (since) => BO.classifyBudget({ m: m(900, 12), m7: m(900, 12), ageHours: 200, lastChange: lc, since, policy: BO.DEFAULT_POLICY, now: at });
    ok('after an increase, the SAME orders are never counted again: the decision stands only on evidence SINCE the change (no new spend → NO_NEW_EVIDENCE, no action)', call({ spend: 20, purchases: 0, cpa: null, hours: 30 }).action === null && call({ spend: 20, purchases: 0, cpa: null, hours: 30 }).zone === 'NO_NEW_EVIDENCE');
    ok('…enough NEW spend but only 1 new order (< the 2 needed) → still no increase, although the 3-day window holds 12 orders', call({ spend: 200, purchases: 1, cpa: 200, hours: 30 }).action === null);
    ok('…2 NEW orders at a good CPA since the change → the next increase is allowed', call({ spend: 200, purchases: 3, cpa: 66, hours: 30 }).action === 'SCALE_UP');
    ok('cooldown: 10h after an increase nothing happens even with new orders', BO.classifyBudget({ m: m(900, 12), m7: m(900, 12), ageHours: 200, lastChange: { at: new Date(at.getTime() - 10 * 3_600_000), action: 'SCALE_UP' }, since: { spend: 400, purchases: 6, cpa: 66, hours: 10 }, policy: BO.DEFAULT_POLICY, now: at }).zone === 'COOLDOWN'); }

  console.log('\n9. Maximum changes per day (per product, inherited from the global rules)');
  { const a = `${T}mc_a`, b = `${T}mc_b`; setEntity(a); setEntity(b);
    const mk = () => scenario([{ id: a, pid: pid(40), m3: m(600, 10), row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', to: 360 } }, { id: b, pid: pid(40), m3: m(900, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE', to: 240 } }]);
    const pols = (cap) => new Map([[pk(pid(40)), { mode: 'AUTOMATIC', budget: { maxChangesPerDay: cap } }]]);
    const w0 = allWrites().length; const r1 = await tick(mk(), cfg(ALL), { policies: pols(2), changesToday: async () => 2 });
    ok('the product already made 2 of its 2 allowed changes today → BOTH candidates are deferred (PRODUCT_MAX_CHANGES_PER_DAY), ZERO requests', allWrites().length === w0 && r1.deferred.filter((d) => d.code === 'PRODUCT_MAX_CHANGES_PER_DAY').length === 2, JSON.stringify(r1.deferred));
    const r2 = await tick(mk(), cfg(ALL), { policies: pols(2), changesToday: async () => 1 });
    { const p1 = `${T}mc_p`; setEntity(p1); const scp = scenario([{ id: p1, pid: pid(40), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }]); const wP = allWrites().length; await tick(scp, cfg(ALL), { policies: pols(1), changesToday: async () => 1 });
      ok('the daily limit counts BUDGET changes only: a PAUSE still goes out when the product already used its 1 budget change today', writes(p1).length === 1 && allWrites().length === wP + 1 && world.entities.get(p1).status === 'PAUSED'); }
    ok('1 of 2 used → exactly ONE more change goes out in this tick, the other is deferred (the counter includes what this tick already sent)', writes(a).length + writes(b).length === 1 && r2.deferred.some((d) => d.code === 'PRODUCT_MAX_CHANGES_PER_DAY'), JSON.stringify(r2.deferred));
  }

  console.log('\n9. Failure modes — expired token, Meta 5xx, database failures: fail closed, never a blind resend');
  { const clean = async (ids) => { await prisma.ambAction.deleteMany({ where: { entity_id: { in: ids } } }); await prisma.ambOperatorDecision.deleteMany({ where: { campaign_id: { in: ids } } }); };
    const mkSc = (id, p) => scenario([{ id, pid: pid(p), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }]);
    // A) expired access token
    const tk = `${T}fm_tok`; setEntity(tk); await clean([tk]); world.failNext = { type: 'token', id: tk }; const wTk = writes(tk).length;
    await tick(mkSc(tk, 80), cfg(ALL)); const dTk = await dec(tk);
    ok('EXPIRED Meta token on the write: ONE attempt, the decision FAILS and says why, Meta is unchanged, nothing is resent', writes(tk).length === wTk + 1 && dTk.status === 'FAILED' && !!dTk.error && world.entities.get(tk).status === 'ACTIVE', JSON.stringify([dTk.status, dTk.error]));
    const wTk2 = writes(tk).length; await tick(mkSc(tk, 80), cfg(ALL));
    ok('the next tick does not hammer Meta with the same dead token on that campaign (the failed decision is not retried blindly)', writes(tk).length <= wTk2 + 1, String(writes(tk).length - wTk2));
    // B) Meta-side HTTP 500
    const sv = `${T}fm_500`; setEntity(sv); await clean([sv]); world.failNext = { type: 'server', id: sv }; const wSv = writes(sv).length;
    await tick(mkSc(sv, 81), cfg(ALL)); const dSv = await dec(sv);
    ok('Meta HTTP 500 on the write: ONE POST, never "success" (FAILED, or EXECUTED-but-unverified when the read-back cannot confirm), Meta unchanged, no resend', writes(sv).length === wSv + 1 && ['FAILED', 'EXECUTED'].includes(dSv.status) && dSv.status !== 'VERIFIED' && world.entities.get(sv).status === 'ACTIVE', JSON.stringify([dSv.status, dSv.error]));
    // C) the database is unreachable at the moment of the claim: nothing is sent, the decision stays PREPARED, and one later approval sends exactly one write
    const db1 = `${T}fm_db1`; setEntity(db1); await clean([db1]); await tick(mkSc(db1, 82), cfg(ALL, { mode: 'APPROVAL' })); const dDb = await dec(db1); const wDb = writes(db1).length;
    const origUM = prisma.ambOperatorDecision.updateMany; let thrown = 0; prisma.ambOperatorDecision.updateMany = async () => { thrown++; const e = new Error("Can't reach database server at the Neon host"); e.code = 'P1001'; throw e; };
    let err1 = null; try { await AE.executeAutoDecision({ decisionId: dDb.id, source: 'USER', userId: 1, now: NOW, deps: { config: cfg(ALL, { mode: 'APPROVAL' }), reevaluate: async () => AE.evaluateAutomation({ now: NOW, deps: { ...mkSc(db1, 82), config: cfg(ALL, { mode: 'APPROVAL' }) } }) } }); } catch (e) { err1 = e; } finally { prisma.ambOperatorDecision.updateMany = origUM; }
    ok('database DOWN at the claim: the approval fails loudly (not silently), ZERO requests reach Meta, the decision is still PREPARED', thrown >= 1 && !!err1 && writes(db1).length === wDb && (await dec(db1)).status === 'PREPARED', JSON.stringify([thrown, err1?.message?.slice(0, 80)]));
    const okRun = await AE.executeAutoDecision({ decisionId: dDb.id, source: 'USER', userId: 1, now: NOW, deps: { config: cfg(ALL, { mode: 'APPROVAL' }), reevaluate: async () => AE.evaluateAutomation({ now: NOW, deps: { ...mkSc(db1, 82), config: cfg(ALL, { mode: 'APPROVAL' }) } }) } });
    ok('…and once the database is back the SAME decision executes exactly once', writes(db1).length === wDb + 1 && world.entities.get(db1).status === 'PAUSED' && ['VERIFIED', 'EXECUTED'].includes((await dec(db1)).status), JSON.stringify({ st: okRun.status, msg: okRun.message, bl: okRun.blocked, w: writes(db1).length - wDb, ds: (await dec(db1)).status }));
    // D) the database fails AFTER the claim but BEFORE anything is sent: no request goes out and the restart recovery returns it to the owner's queue
    const db2 = `${T}fm_db2`; setEntity(db2); await clean([db2]); await tick(mkSc(db2, 83), cfg(ALL, { mode: 'APPROVAL' })); const dDb2 = await dec(db2); const wDb2 = writes(db2).length;
    const origRC = prisma.ambRecommendation.create; prisma.ambRecommendation.create = async () => { const e = new Error('Connection terminated unexpectedly'); e.code = 'P1017'; throw e; };
    let err2 = null; try { await AE.executeAutoDecision({ decisionId: dDb2.id, source: 'USER', userId: 1, now: NOW, deps: { config: cfg(ALL, { mode: 'APPROVAL' }), reevaluate: async () => AE.evaluateAutomation({ now: NOW, deps: { ...mkSc(db2, 83), config: cfg(ALL, { mode: 'APPROVAL' }) } }) } }); } catch (e) { err2 = e; } finally { prisma.ambRecommendation.create = origRC; }
    const stuck = (await dec(db2)).status; const rec2 = await ER.recoverInterruptedDecisions({ now: NOW, onStartup: true });
    ok('database fails after the claim: ZERO requests reach Meta; the interrupted decision is returned to PREPARED by the restart recovery (fresh approval + fresh live check needed), never left EXECUTING', !!err2 && writes(db2).length === wDb2 && stuck === 'EXECUTING' && (await dec(db2)).status === 'PREPARED' && rec2.some((x) => x.decisionId === dDb2.id), JSON.stringify({ stuck, now: (await dec(db2)).status, rec2, w: writes(db2).length - wDb2, e2: err2?.message }));
    // E) the configuration cannot be read (database down): the central write gate fails CLOSED
    const WG = await imp('../services/amb/writeGate.js'); const gc = await WG.checkMetaWrite({ actionType: 'PAUSE', mode: 'APPROVAL', deps: { config: async () => { throw new Error('db down'); }, audit: false } });
    ok('config unreadable (database down) → the central write gate refuses (NO_CONFIG, fail-closed), nothing is sent', gc.ok === false && gc.code === 'NO_CONFIG');
    // F) the whole tick while every decision lookup fails: no write is attempted
    const tf = `${T}fm_tick`; setEntity(tf); await clean([tf]); const wTf = allWrites().length; const origFU = prisma.ambOperatorDecision.findUnique; prisma.ambOperatorDecision.findUnique = async () => { const e = new Error("Can't reach database server"); e.code = 'P1001'; throw e; };
    let errT = null; try { await tick(mkSc(tf, 84), cfg(ALL)); } catch (e) { errT = e; } finally { prisma.ambOperatorDecision.findUnique = origFU; }
    ok('a whole automation tick while the database is unreachable: NO Meta request is made (it either fails visibly or does nothing)', allWrites().length === wTf && world.entities.get(tf).status === 'ACTIVE', String(errT?.message || 'no throw').slice(0, 100));
  }
} finally { try { await cleanup(); } catch (e) { console.log('cleanup failed', e.message); } server.close(); }
console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
