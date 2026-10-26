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
const AE = await imp('../services/amb/automationEngine.js'); const OC = await imp('../services/amb/operatorContext.js'); const PPol = await imp('../services/amb/pausePolicy.js'); const PP = await imp('../services/amb/productPolicy.js'); const ER = await imp('../services/amb/executionRecovery.js'); const OE = await imp('../services/amb/operatorEngine.js');
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
function scenario(list, { mode = 'AUTOMATIC', ready = true, pause = pausePol(), stock = {}, guards = {}, realLastActive = false } = {}) {
  const camps = list.map((c) => ({ id: c.id, name: c.id, status: 'ACTIVE', budget: c.budget ?? 300, firstSeenAt: new Date(NOW.getTime() - 10 * 86_400_000) }));
  const win = (key) => new Map(list.map((c) => [c.id, c[key] || (key === 'today' ? c.m3 : null) || m(0, 0)])); // fixtures that only give a 3-day figure get the SAME figure for «today» (the day-based engine reads today)
  const w = { adAccountId: ACC, config: cfg(), settings, connected: true, metaStale: false, campaigns: camps, windows: { today: win('today'), last3: win('m3'), last7: win('m7'), last14: win('m14'), last30: win('m30') }, prodIndex: new Map(), tags: new Map(), exceptions: [], factsCache: new Map(), now: NOW };
  const rows = list.filter((c) => c.row).map((c) => ({ campaignId: c.id, product: 'fixture', productId: c.pid, storeId: ST, campaign: c.id, status: 'ACTIVE', entity: { level: 'campaign', id: c.id, budget: c.budget ?? 300, name: null }, decision: c.row.decision, zone: c.row.zone || 'X', rule: c.row.rule || 'X', reason: c.row.reason || 'fixture', guards: c.row.guards || [], evidence: c.row.evidence || {}, m3: c.m3 || null, m7: c.m7 || null, requiresApproval: !!c.row.requiresApproval, flagReview: false, primaryBlock: null,
    intended: { action: c.row.action, pct: c.row.pct ?? (c.row.action === 'SCALE_UP' ? 20 : c.row.action === 'SCALE_DOWN' ? 20 : null), fromBudget: c.row.action === 'PAUSE' ? null : (c.budget ?? 300), toBudget: c.row.action === 'PAUSE' ? null : (c.row.to ?? (c.row.action === 'SCALE_UP' ? Math.round((c.budget ?? 300) * 1.2) : Math.round((c.budget ?? 300) * 0.8))) } }));
  const pids = [...new Set(list.map((c) => c.pid))];
  return { world: w, opt: { structureSource: 'META_LIVE', adAccountId: ACC, rows }, policies: new Map(pids.map((p) => [pk(p), { mode }])), readiness: new Map(pids.map((p) => [pk(p), ready ? READY(p) : NOT_READY(p)])), pause, budgetPolicy: BP,
    ...(realLastActive ? {} : { lastActiveOf: () => false }), // the older scenarios are single-campaign fixtures: they are NOT «the last active campaign» unless a scenario asks for the real count (section 14)
    evalStartOf: (id) => new Date(NOW.getTime() - (list.find((c) => c.id === id)?.dayHours ?? 12) * 3_600_000), // hours observed today (default 12h = a fully observed day)
    stockOf: async (id) => stock[id] || { status: 'IN_STOCK', current: 50 }, guardsOf: async ({ campaignId }) => guards[campaignId] || [], recent: new Map(), counters: { actionsLastHour: 0, actionsToday: 0, byAction: {} } };
}
const ev = (sc, config = cfg()) => AE.evaluateAutomation({ now: NOW, deps: { ...sc, config } });
const tick = (sc, config = cfg(), extra = {}) => AE.runAutomationTick({ now: NOW, deps: { config, dcfg: { halted: false }, autopilotOk: true, noSleep: true, evalDeps: { ...sc, config }, ...extra, execDeps: { config, reevaluate: async () => AE.evaluateAutomation({ now: NOW, deps: { ...sc, config } }), ...(extra.execDeps || {}) } } });
const dec = (campaignId) => prisma.ambOperatorDecision.findFirst({ where: { campaign_id: campaignId, rule_name: { startsWith: 'AUTO:' } }, orderBy: { id: 'desc' } });
const actOf = (id) => prisma.ambAction.findFirst({ where: { entity_id: id }, orderBy: { id: 'desc' } });
const cleanup = async () => { const ds = await prisma.ambOperatorDecision.findMany({ where: { campaign_id: { startsWith: T } }, select: { id: true, amb_recommendation_id: true } }); const recIds = ds.map((d) => d.amb_recommendation_id).filter(Boolean);
  await prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ campaign_id: { startsWith: T } }, { decision_id: { in: ds.map((d) => d.id) } }] } }); await prisma.ambAction.deleteMany({ where: { OR: [{ entity_id: { startsWith: T } }, { recommendation_id: { in: recIds } }] } }); await prisma.ambOperatorDecision.deleteMany({ where: { campaign_id: { startsWith: T } } }); await prisma.ambRecommendation.deleteMany({ where: { OR: [{ id: { in: recIds } }, { entity_id: { startsWith: T } }] } }); await prisma.ambAlert.deleteMany({ where: { entity_id: { startsWith: T } } }).catch(() => {}); };
const pid = (n) => 880000 + n;
const cairoToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10); // Cairo = UTC+3 in October (the engine uses cairoDate(now))

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
    ok('the HIGH_CPA reason prints the EFFECTIVE limit (300) and the orders — never «null» (the owner reads this reason in the alert and the log)', /CPA 375 > 300/.test(r.candidates[0].reason) && !/null/.test(r.candidates[0].reason) && /4 أوردر/.test(r.candidates[0].reason), r.candidates[0].reason);
    const win = { m7: m(600, 10), m30: m(2400, 30) }; // CPA 60/80 → a strong winner
    r = await ev(scenario([{ ...base, ...win, m3: m(1500, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE' } }])); ok('winner protection (PROTECTION_WINS): a winner is NOT paused for high CPA — the budget reduction proceeds', r.candidates[0].kind === 'REDUCE', r.candidates[0].kind);
    r = await ev(scenario([{ ...base, ...win, m3: m(1500, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE' } }], { pause: pausePol({ protections: { winnerProtection: true, precedence: 'RULE_WINS' } }) })); ok('precedence RULE_WINS (configurable): the fired rule pauses even a winner', r.candidates[0].kind === 'HIGH_CPA');
    r = await ev(scenario([{ ...base, ...win, m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }], { stock: { [id]: { status: 'OUT_OF_STOCK' } } })); ok('STOCK_OUT still pauses a protected winner (nothing to sell)', r.candidates[0].kind === 'STOCK_OUT');
    r = await ev(scenario([{ ...base, row: { action: 'PAUSE', decision: 'WOULD_PAUSE' }, m3: m(260, 0) }], { guards: { [id]: [{ code: 'RECENT_PURCHASE_PROTECTION', message: 'order 20 min ago' }] }, stock: { [id]: { status: 'OUT_OF_STOCK' } } })); ok('a guard block (recent purchase) keeps the pause BLOCKED with its reason', r.candidates[0].effective === 'BLOCKED' && r.candidates[0].blockers.some((b) => b.code === 'RECENT_PURCHASE_PROTECTION'));
    { const sc2 = scenario([{ ...base, m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }]); sc2.opt.rows.push({ ...sc2.opt.rows[0], entity: { level: 'adset', id: `${id}_2`, budget: 100, name: null }, decision: 'KEEP', intended: null }); r = await ev(sc2); ok('ABO campaign: zero orders on only SOME ad sets never pauses the whole campaign automatically (PARTIAL_ADSETS → blocked, the owner pauses it by hand)', r.candidates[0].effective === 'BLOCKED' && r.candidates[0].blockers.some((b) => b.code === 'PARTIAL_ADSETS')); }
    r = await ev(scenario([{ ...base, row: { action: 'PAUSE', decision: 'WOULD_PAUSE' }, m3: m(260, 0) }], { pause: pausePol({ scope: { excludeProducts: [String(pid(2))] } }) })); ok('pause policy scope: an excluded product is BLOCKED (EXCLUDED_BY_POLICY)', r.candidates[0].effective === 'BLOCKED' && r.candidates[0].blockers.some((b) => b.code === 'EXCLUDED_BY_POLICY'));
    r = await ev(scenario([{ ...base, row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', evidence: { lastChange: { at: new Date(NOW.getTime() - 10 * 3_600_000).toISOString(), action: 'SCALE_DOWN' } } } }])); ok('anti-oscillation: an INCREASE 10h after a REDUCE is BLOCKED (OSCILLATION_GUARD, 72h)', r.candidates[0].blockers.some((b) => b.code === 'OSCILLATION_GUARD') && r.candidates[0].effective === 'BLOCKED');
    r = await ev(scenario([{ ...base, row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', evidence: { lastChange: { at: new Date(NOW.getTime() - 100 * 3_600_000).toISOString(), action: 'SCALE_DOWN' } } } }])); ok('…and allowed after 100h', r.candidates[0].effective === 'AUTOMATIC');
    r = await ev(scenario([{ ...base, row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', requiresApproval: true } }])); ok('a decision the guards DOWNGRADE (unknown stock/profit for an increase) is never automatic', r.candidates[0].effective === 'APPROVAL' && r.candidates[0].autoBlockers.some((b) => b.code === 'DOWNGRADE_TO_APPROVAL'));
    { const rd = await ev(scenario([{ ...base, row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', requiresApproval: true, guards: ['COD_UNVERIFIED_WARN[W]', 'ADVISOR_DISAGREES[D]:CONVERSION_PROBLEM'] } }])); const msg = rd.candidates[0].autoBlockers.find((b) => b.code === 'DOWNGRADE_TO_APPROVAL')?.message || '';
      ok('the downgrade message names the REAL guard (the Smart Advisor disagrees: CONVERSION_PROBLEM) — not a generic «stock/profit unknown» guess, and not the warning-only guard', /المستشار الذكي مش موافق/.test(msg) && /CONVERSION_PROBLEM/.test(msg) && !/COD_UNVERIFIED/.test(msg) && !/مخزون\/ربحية غير مؤكدين/.test(msg), msg);
      const rg = await ev(scenario([{ ...base, row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', requiresApproval: true, guards: [] } }])); ok('with no [D] guard to quote it falls back to the generic wording (never an empty reason)', /محتاج موافقتك/.test(rg.candidates[0].autoBlockers.find((b) => b.code === 'DOWNGRADE_TO_APPROVAL')?.message || '')); } }

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

  console.log('\n10. Duplicate decisions: never applied twice, old ones are closed, every old row is re-checked on Meta LIVE before it can execute');
  { const mkRow = (campaignId, key, o = {}) => prisma.ambOperatorDecision.create({ data: { decision_key: `${T}${key}`, status: 'PREPARED', store_id: ST, product_id: null, ad_account_id: ACC, campaign_id: campaignId, campaign_name: campaignId, action: 'SCALE_DOWN', rule_name: 'AUTO:REDUCE', mode_at_decision: 'AUTOPILOT', confidence: 'HIGH', params_json: JSON.stringify({ kind: 'REDUCE', level: 'campaign', entityId: campaignId, fromBudget: 300, toBudget: 240, pct: 20 }), ...o } });
    const statusOf = async (id) => (await prisma.ambOperatorDecision.findUnique({ where: { id } })).status;
    const errorOf = async (id) => (await prisma.ambOperatorDecision.findUnique({ where: { id } })).error;
    // a) three windows produced three PREPARED rows for the same change; the newest evaluation closes the older two
    const a = `${T}dup_a`; setEntity(a); const o1 = await mkRow(a, 'dupa1'), o2 = await mkRow(a, 'dupa2');
    const scA = scenario([{ id: a, pid: pid(90), m3: m(900, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE', to: 240 } }]);
    await tick(scA, cfg(ALL, { mode: 'APPROVAL' }));
    const cur = await dec(a);
    ok('APPROVAL: the newest evaluation leaves exactly ONE open decision for the change; the two older duplicates are EXPIRED (SUPERSEDED_BY the newer one) — nothing piles up in «الموافقات»', cur.status === 'PREPARED' && cur.id > o2.id && (await statusOf(o1.id)) === 'EXPIRED' && (await statusOf(o2.id)) === 'EXPIRED' && (await errorOf(o1.id)) === `SUPERSEDED_BY:${cur.id}` && (await errorOf(o2.id)) === `SUPERSEDED_BY:${cur.id}` && writes(a).length === 0, JSON.stringify([cur.id, cur.status]));
    ok('…and each closure is audited (a TRANSITION event per superseded row)', (await prisma.ambOperatorEvent.count({ where: { decision_id: { in: [o1.id, o2.id] }, kind: 'TRANSITION', to_status: 'EXPIRED' } })) === 2);
    // b) AUTOMATIC with the same duplicates: ONE Meta write for the campaign
    const b = `${T}dup_b`; setEntity(b, { daily_budget: '30000' }); const p1 = await mkRow(b, 'dupb1'), p2 = await mkRow(b, 'dupb2');
    const scB = scenario([{ id: b, pid: pid(91), m3: m(900, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE', to: 240 } }]);
    await tick(scB, cfg(ALL)); await tick(scB, cfg(ALL));
    ok('AUTOMATIC with 2 older duplicate rows: exactly ONE write reaches Meta (300 → 240), the duplicates are EXPIRED and never executed, a second tick sends nothing', writes(b).length === 1 && world.entities.get(b).daily_budget === '24000' && (await statusOf(p1.id)) === 'EXPIRED' && (await statusOf(p2.id)) === 'EXPIRED' && (await dec(b)).status === 'VERIFIED');
    // c) the SAME change was already applied by another decision (another rule family): the explicit idempotency guard refuses the second write
    const c = `${T}dup_c`; setEntity(c); const scC = scenario([{ id: c, pid: pid(92), m3: m(900, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE', to: 240 } }]);
    await tick(scC, cfg(ALL, { mode: 'APPROVAL' })); const dc = await dec(c);
    await mkRow(c, 'dupc_done', { status: 'VERIFIED', rule_name: 'DYNAMIC_BUDGET:DYN_HIGH_CPA_REDUCE', executed_at: new Date() });
    const rc = await AE.executeAutoDecision({ decisionId: dc.id, source: 'USER', userId: 1, now: NOW, deps: { config: cfg(ALL, { mode: 'APPROVAL' }), reevaluate: async () => AE.evaluateAutomation({ now: NOW, deps: { ...scC, config: cfg(ALL, { mode: 'APPROVAL' }) } }) } });
    ok('the same 300 → 240 already VERIFIED by another decision (dynamic-budget family) → this one is EXPIRED with DUPLICATE_ALREADY_APPLIED, ZERO writes', rc.status === 'EXPIRED' && (rc.reasons || []).some((r) => r.code === 'DUPLICATE_ALREADY_APPLIED') && writes(c).length === 0, JSON.stringify(rc).slice(0, 300));
    // d) an OLD prepared row whose live budget moved: re-checked on Meta LIVE -> expired, never sent
    const d = `${T}dup_d`; setEntity(d, { daily_budget: '24000' }); const old = await mkRow(d, 'dupd_old', { created_at: new Date(Date.now() - 3 * 86_400_000) });
    const scD = scenario([{ id: d, pid: pid(93), budget: 240, m3: m(900, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE', to: 192 } }]);
    const rd = await AE.executeAutoDecision({ decisionId: old.id, source: 'USER', userId: 1, now: NOW, deps: { config: cfg(ALL, { mode: 'APPROVAL' }), reevaluate: async () => AE.evaluateAutomation({ now: NOW, deps: { ...scD, config: cfg(ALL, { mode: 'APPROVAL' }) } }) } });
    ok('a 3-day-old PREPARED reduce (300 → 240) whose live budget is already 240 → EXPIRED by the live re-evaluation (BUDGET_CHANGED), ZERO writes', rd.status === 'EXPIRED' && (rd.reasons || []).some((r) => r.code === 'BUDGET_CHANGED') && writes(d).length === 0, JSON.stringify(rd.reasons));
    const rd2 = await AE.executeAutoDecision({ decisionId: (await mkRow(d, 'dupd_old2')).id, source: 'USER', userId: 1, now: NOW, deps: { config: cfg(ALL, { mode: 'APPROVAL' }), reevaluate: async () => ({ candidates: [], structureSource: 'META_LIVE' }) } });
    ok('an old row the live evaluation no longer produces → EXPIRED (DECISION_CHANGED), ZERO writes', rd2.status === 'EXPIRED' && (rd2.reasons || []).some((r) => r.code === 'DECISION_CHANGED') && writes(d).length === 0);
    // e) stale sweep after a FULL evaluation: rows the engine no longer produces are closed; zero-spend rows of a past day are closed; today's stay
    const e = `${T}dup_e`; const z1 = await mkRow(e, 'swp_engine', { action: 'PAUSE', rule_name: 'AUTO:HIGH_CPA', params_json: JSON.stringify({ kind: 'HIGH_CPA', level: 'campaign', entityId: e }) });
    const zs = (date, k) => mkRow(e, k, { action: 'PAUSE', rule_name: 'AUTO:DAILY_ZERO_SPEND', params_json: JSON.stringify({ kind: 'DAILY_ZERO_SPEND', level: 'campaign', entityId: e }), evidence_json: JSON.stringify({ zeroSpend: { date } }) });
    const zOld = await zs('2000-01-01', 'swp_zs_old'); const zNow = await zs(cairoToday(), 'swp_zs_now'); const man = await mkRow(e, 'swp_manual', { action: 'PAUSE', rule_name: 'AUTO:MANUAL_PAUSE' });
    const rSw = await tick(scenario([]), cfg(ALL, { mode: 'APPROVAL' }), { sweepStale: true });
    ok('full tick: an open engine decision it no longer produces is EXPIRED (NO_LONGER_APPLICABLE); a past-day zero-spend decision is EXPIRED (DECISION_DAY_PASSED); today\'s zero-spend and MANUAL operations are untouched', (await statusOf(z1.id)) === 'EXPIRED' && (await errorOf(z1.id)) === 'NO_LONGER_APPLICABLE' && (await statusOf(zOld.id)) === 'EXPIRED' && (await errorOf(zOld.id)) === 'DECISION_DAY_PASSED' && (await statusOf(zNow.id)) === 'PREPARED' && (await statusOf(man.id)) === 'PREPARED', JSON.stringify(rSw.persisted));
    const rNo = await tick(scenario([]), cfg(ALL, { mode: 'APPROVAL' })); ok('a tick with an injected (partial) world never sweeps — the sweep is only for full evaluations', rNo.persisted?.expiredStale === undefined); }

  console.log('\n11. Scope consistency: evaluation, preview and execution apply the SAME approved pause scope (and budget operations are independent of it)');
  { const inP = `${T}sc_in`, outP = `${T}sc_out`, redP = `${T}sc_red`; for (const x of [inP, outP, redP]) setEntity(x, { daily_budget: '30000' });
    const hi = (id, p) => ({ id, pid: p, m3: m(1500, 4), m7: m(1500, 4), m30: m(1500, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE' } });
    const scope = { includeProducts: [String(pid(95))] }; const sc = scenario([hi(inP, pid(95)), hi(outP, pid(96))], { pause: pausePol({ scope, autoEnrollAutomatic: false }) }); // strict include list = the explicit opt-out of auto-enrolment
    const e = await ev(sc); const cIn = e.candidates.find((c) => c.campaignId === inP), cOut = e.candidates.find((c) => c.campaignId === outP);
    ok('evaluation: the in-scope product gets the HIGH_CPA pause (AUTOMATIC); the out-of-scope one is BLOCKED with OUT_OF_SCOPE', cIn.kind === 'HIGH_CPA' && cIn.effective === 'AUTOMATIC' && cOut.kind === 'HIGH_CPA' && cOut.effective === 'BLOCKED' && cOut.blockers.some((b) => b.code === 'OUT_OF_SCOPE'));
    ok('…and the blocker explains the real scope and who decides (not a bare code)', /منتجات مضمّنة: 1/.test(cOut.blockers.find((b) => b.code === 'OUT_OF_SCOPE').message) && /قرارك|بنفسك/.test(cOut.blockers.find((b) => b.code === 'OUT_OF_SCOPE').message));
    const w0 = allWrites().length; const r = await tick(sc, cfg(ALL));
    ok('execution: ONLY the in-scope campaign is paused on Meta; the out-of-scope one is persisted BLOCKED and is never sent', writes(inP).length === 1 && writes(outP).length === 0 && allWrites().length === w0 + 1 && (await dec(outP)).status === 'BLOCKED' && (await dec(inP)).status === 'VERIFIED', JSON.stringify(r.executed));
    const refused = await AE.executeAutoDecision({ decisionId: (await dec(outP)).id, source: 'USER', userId: 1, now: NOW, deps: { config: cfg(ALL), reevaluate: async () => AE.evaluateAutomation({ now: NOW, deps: { ...sc, config: cfg(ALL) } }) } });
    ok('forcing the BLOCKED out-of-scope decision (owner click) is refused, ZERO writes — the approved scope cannot be bypassed from the approval path', refused.executed !== true && writes(outP).length === 0, JSON.stringify(refused).slice(0, 200));
    const scBud = scenario([{ id: redP, pid: pid(96), m3: m(900, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE', to: 240 } }], { pause: pausePol({ scope, autoEnrollAutomatic: false }) }); await tick(scBud, cfg(ALL));
    ok('the pause scope does NOT gate budget operations: a product outside the pause scope still gets its REDUCE (300 → 240) — each policy governs its own operation', writes(redP).length === 1 && world.entities.get(redP).daily_budget === '24000' && (await dec(redP)).status === 'VERIFIED');
    ok('the saved scope was never widened by any of this (still only product ' + pid(95) + ')', JSON.stringify(scope.includeProducts) === JSON.stringify([String(pid(95))])); }

  console.log('\n11b. Auto-enrolment (default): an AUTOMATIC product enters the pause scope by itself — no list to edit, no approval per action');
  { const inP = `${T}en_in`, newP = `${T}en_new`, exP = `${T}en_ex`; for (const x of [inP, newP, exP]) setEntity(x, { daily_budget: '30000' });
    const hi = (id, p) => ({ id, pid: p, m3: m(1500, 4), m7: m(1500, 4), m30: m(1500, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE' } });
    const scope = { includeProducts: [String(pid(95))], excludeProducts: [String(pid(98))] }; const sc = scenario([hi(inP, pid(95)), hi(newP, pid(97)), hi(exP, pid(98))], { pause: pausePol({ scope }) });
    const e = await ev(sc); const cIn = e.candidates.find((c) => c.campaignId === inP), cNew = e.candidates.find((c) => c.campaignId === newP), cEx = e.candidates.find((c) => c.campaignId === exP);
    ok('a NEW AUTOMATIC product (not in the include list) is evaluated for the HIGH_CPA pause as AUTOMATIC — scope no longer blocks it', cNew.kind === 'HIGH_CPA' && cNew.effective === 'AUTOMATIC' && !cNew.blockers.some((b) => b.code === 'OUT_OF_SCOPE'), JSON.stringify([cNew.kind, cNew.effective, cNew.blockers]));
    ok('an EXCLUDED product still wins over the enrolment (EXCLUDED_BY_POLICY → BLOCKED)', cEx.effective === 'BLOCKED' && cEx.blockers.some((b) => b.code === 'EXCLUDED_BY_POLICY'), JSON.stringify([cEx.effective, cEx.blockers.map((b) => b.code)]));
    const w0 = allWrites().length; await tick(sc, cfg(ALL));
    ok('execution on the Meta mock: the listed AND the new AUTOMATIC product are each paused with exactly ONE write; the excluded one is never sent', writes(inP).length === 1 && writes(newP).length === 1 && writes(exP).length === 0 && allWrites().length === w0 + 2 && (await dec(newP)).status === 'VERIFIED' && (await dec(exP)).status === 'BLOCKED');
    ok('no approval was needed: the new product\'s decision was executed by the engine itself (rule AUTO:*), not by a user', (await dec(newP)).rule_name?.startsWith('AUTO:'));
    const scAPPR = scenario([hi(`${T}en_appr`, pid(97))], { pause: pausePol({ scope }), mode: 'APPROVAL' }); const eA = await ev(scAPPR); const cA = eA.candidates.find((c) => c.campaignId === `${T}en_appr`);
    ok('enrolment is ONLY for AUTOMATIC products: an APPROVAL-mode product that is not in the include list stays OUT_OF_SCOPE (behaviour unchanged for everything that is not AUTOMATIC)', cA?.effective === 'BLOCKED' && cA.blockers.some((x) => x.code === 'OUT_OF_SCOPE'), JSON.stringify([cA?.effective, cA?.blockers?.map((x) => x.code)])); }

  console.log('\n12. ABO and CBO: REDUCE / INCREASE / PAUSE through the real executor on the Meta mock (ad-set level writes), one real change = one count');
  { const asC = `${T}abo_c`, asS = `${T}abo_s`, cbo = `${T}cbo_c`; const adset = `${T}abo_adset`; setEntity(asC, { daily_budget: undefined }); setEntity(adset, { daily_budget: '30000' }); setEntity(cbo, { daily_budget: '30000' });
    const abo = (id, ad, action, to) => { const s = scenario([{ id, pid: pid(97), m3: m(900, 4), row: { action, decision: action === 'SCALE_UP' ? 'WOULD_INCREASE' : 'WOULD_REDUCE', to } }]); for (const r of s.opt.rows) r.entity = { level: 'adset', id: ad, budget: 300, name: 'adset' }; return s; };
    await tick(abo(asC, adset, 'SCALE_DOWN', 240), cfg(ALL));
    const dA = await dec(asC); const prm = JSON.parse(dA.params_json || '{}');
    ok('ABO REDUCE: the write goes to the AD SET (not the campaign) — 300 → 240 on the mock, decision VERIFIED, level=adset recorded', writes(adset).length === 1 && writes(asC).length === 0 && world.entities.get(adset).daily_budget === '24000' && dA.status === 'VERIFIED' && prm.level === 'adset' && prm.entityId === adset, JSON.stringify([dA.status, prm]));
    const rc = await OC.loadRecentActions({ campaignIds: [asC], now: new Date() });
    ok('…and that ONE ABO write counts as ONE change for the campaign daily limit (decision + ad-set action are the same change)', rc.get(asC)?.todayCount === 1, rc.get(asC)?.todayCount);
    const adset2 = `${T}abo_adset2`; setEntity(adset2, { daily_budget: '30000' }); await tick(abo(asS, adset2, 'SCALE_UP', 360), cfg(ALL));
    ok('ABO INCREASE +20% (300 → 360) on the ad set: ONE write, mock 36000, VERIFIED', writes(adset2).length === 1 && world.entities.get(adset2).daily_budget === '36000' && (await dec(asS)).status === 'VERIFIED');
    await tick(scenario([{ id: cbo, pid: pid(98), m3: m(900, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE', to: 240 } }]), cfg(ALL));
    ok('CBO REDUCE: the write goes to the CAMPAIGN (300 → 240), VERIFIED, and counts as ONE change', writes(cbo).length === 1 && world.entities.get(cbo).daily_budget === '24000' && (await dec(cbo)).status === 'VERIFIED' && (await OC.loadRecentActions({ campaignIds: [cbo], now: new Date() })).get(cbo)?.todayCount === 1);
    const pa = `${T}abo_pause`; setEntity(pa); await tick(scenario([{ id: pa, pid: pid(99), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }]), cfg(ALL));
    ok('PAUSE of a campaign: ONE write status=PAUSED, VERIFIED (OPEN is executed by the daily-plan scheduler — covered by dailyPlanTest)', writes(pa).length === 1 && world.entities.get(pa).status === 'PAUSED' && (await dec(pa)).status === 'VERIFIED');
    const wBefore = allWrites().length; const sc2 = abo(asC, adset, 'SCALE_DOWN', 240); await tick(sc2, cfg(ALL)); await tick(sc2, cfg(ALL));
    ok('re-running the same ABO tick twice sends ZERO additional requests (idempotent)', allWrites().length === wBefore); }

  console.log('\n13. Concurrency: two schedulers / two approvals never write twice');
  { const c1 = `${T}cc_1`; setEntity(c1, { daily_budget: '30000' }); const sc = scenario([{ id: c1, pid: pid(100), m3: m(900, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE', to: 240 } }]);
    await tick(sc, cfg(ALL, { mode: 'APPROVAL' })); const d = await dec(c1); const w0 = writes(c1).length;
    const run = () => AE.executeAutoDecision({ decisionId: d.id, source: 'USER', userId: 1, now: NOW, deps: { config: cfg(ALL, { mode: 'APPROVAL' }), reevaluate: async () => AE.evaluateAutomation({ now: NOW, deps: { ...sc, config: cfg(ALL, { mode: 'APPROVAL' }) } }) } });
    const res = await Promise.all([run(), run(), run()]);
    ok('three simultaneous approvals of ONE prepared decision → exactly ONE write on Meta, the others refused (RACE / not executable)', writes(c1).length === w0 + 1 && res.filter((x) => x.executed === true).length === 1, JSON.stringify(res.map((x) => x.status)));
    const c2 = `${T}cc_2`; setEntity(c2, { daily_budget: '30000' }); const sc2 = scenario([{ id: c2, pid: pid(101), m3: m(900, 4), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE', to: 240 } }]);
    const t1 = tick(sc2, cfg(ALL)); const t2 = AE.runAutomationTick({ now: NOW, deps: { config: cfg(ALL), dcfg: { halted: false }, autopilotOk: true, noSleep: true, evalDeps: { ...sc2, config: cfg(ALL) } } });
    const [a, b] = await Promise.all([t1, t2]);
    ok('two overlapping ticks (two schedulers): the second is skipped (ALREADY_RUNNING) and the campaign is written exactly ONCE', (a.skipped === 'ALREADY_RUNNING' || b.skipped === 'ALREADY_RUNNING') && writes(c2).length === 1 && world.entities.get(c2).daily_budget === '24000', JSON.stringify([a.skipped, b.skipped, writes(c2).length])); }
  console.log('\n14. DAY-BASED evaluation on the Meta mock: OBSERVATION, today\'s CPA, the last active campaign, stale decisions (owner decision 2026-10-26)');
  { // the pause policy of this suite stops at CPA 300 (3 orders, 300 spend). m3 = 3-day CPA 375 → the OLD logic would pause on it; today decides now.
    const KEEP = { decision: 'KEEP' }; const sel = (id, pid_, o = {}) => ({ id, pid: pid_, m3: m(1500, 4), m7: m(900, 4), m30: m(3000, 12), row: KEEP, ...o });
    // (a) the 159 case: 12:15 AM, a high HISTORICAL CPA, no data today → NO pause (a second active campaign exists, so it is not the last one)
    const a1 = `${T}dy_a1`, a2 = `${T}dy_a2`; for (const x of [a1, a2]) setEntity(x, { daily_budget: '30000' });
    const scA = scenario([sel(a1, pid(110), { today: m(0, 0), dayHours: 0.25 }), sel(a2, pid(110), { today: m(300, 4), dayHours: 0.25, m3: m(300, 4) })], { realLastActive: true });
    const eA = await ev(scA); const cA = eA.candidates.find((c) => c.campaignId === a1);
    ok('00:15 AM, 3-day CPA 375 > the limit 300 on 4 orders, ZERO data today → NO HIGH_CPA pause candidate (the old logic paused here)', !cA, JSON.stringify(cA && [cA.kind, cA.effective]));
    const wA = allWrites().length; await tick(scA, cfg(ALL));
    ok('executing that tick sends NOTHING to Meta for the campaign', writes(a1).length === 0 && allWrites().length === wA, String(writes(a1).length));
    // (b) the same campaign once TODAY has evidence: 6 hours, CPA 450 > 300, 3 orders, 1,350 spend → paused automatically
    const b1 = `${T}dy_b1`, b2 = `${T}dy_b2`; for (const x of [b1, b2]) setEntity(x, { daily_budget: '30000' });
    const scB = scenario([sel(b1, pid(111), { today: m(1350, 3), dayHours: 6 }), sel(b2, pid(111), { today: m(300, 4), dayHours: 6, m3: m(300, 4) })], { realLastActive: true });
    const eB = await ev(scB); const cB = eB.candidates.find((c) => c.campaignId === b1);
    ok('6 hours in, TODAY CPA 450 > 300 on 3 orders → HIGH_CPA is an AUTOMATIC pause candidate whose reason quotes TODAY\'s numbers', cB?.kind === 'HIGH_CPA' && cB.effective === 'AUTOMATIC' && /450/.test(cB.reason) && /النهارده/.test(cB.reason), JSON.stringify(cB && [cB.kind, cB.effective, cB.reason]));
    await tick(scB, cfg(ALL));
    ok('executed on the Meta mock with exactly ONE write for the bad campaign, none for its healthy sibling', writes(b1).length === 1 && writes(b2).length === 0 && (await dec(b1))?.status === 'VERIFIED');
    // (c) a campaign that is fine TODAY is never paused for a terrible 3-day CPA
    const c1 = `${T}dy_c1`, c2 = `${T}dy_c2`; for (const x of [c1, c2]) setEntity(x, { daily_budget: '30000' });
    const scC = scenario([sel(c1, pid(112), { today: m(400, 4), dayHours: 8 }), sel(c2, pid(112), { today: m(300, 4), dayHours: 8, m3: m(300, 4) })], { realLastActive: true });
    await tick(scC, cfg(ALL));
    ok('3-day CPA 375 but TODAY CPA 100 (4 orders) → NOT paused: 3-day numbers are analysis, not a trigger', writes(c1).length === 0 && writes(c2).length === 0);
    // (d) the LAST active campaign of a product
    const d1 = `${T}dy_d1`; setEntity(d1, { daily_budget: '30000' });
    const scD = scenario([sel(d1, pid(113), { today: m(1080, 3), dayHours: 6 })], { realLastActive: true }); const eD = await ev(scD);
    ok('the only active campaign of its product + a moderate breach (CPA 360 on 3 orders) → NOT a pause candidate (LAST_ACTIVE_CAMPAIGN)', !eD.candidates.some((c) => c.campaignId === d1 && c.kind === 'HIGH_CPA') && eD.skipped.some((s) => s.campaignId === d1 && s.code === 'LAST_ACTIVE_CAMPAIGN'), JSON.stringify(eD.skipped.filter((s) => s.campaignId === d1)));
    await tick(scD, cfg(ALL)); ok('…and nothing reaches Meta for it', writes(d1).length === 0);
    const d2 = `${T}dy_d2`; setEntity(d2, { daily_budget: '30000' });
    const scD2 = scenario([sel(d2, pid(114), { today: m(3000, 6), dayHours: 6 })], { realLastActive: true }); await tick(scD2, cfg(ALL));
    ok('…but a SEVERE, well-sampled breach (CPA 500 ≥ 1.5× the limit on 6 orders) pauses even the last active campaign', writes(d2).length === 1 && (await dec(d2))?.status === 'VERIFIED');
    // (e) stale decisions: a PREPARED HIGH_CPA row built from OLD 3-day numbers is re-evaluated LIVE and never executed on those numbers
    const e1 = `${T}dy_e1`, e2 = `${T}dy_e2`; for (const x of [e1, e2]) setEntity(x, { daily_budget: '30000' });
    const stale = await prisma.ambOperatorDecision.create({ data: { decision_key: `${T}dy_stale_${Date.now()}`, status: 'PREPARED', store_id: ST, product_id: pid(115), ad_account_id: ACC, campaign_id: e1, campaign_name: e1, action: 'PAUSE', rule_name: 'AUTO:HIGH_CPA', mode_at_decision: 'AUTOPILOT', confidence: 'HIGH', created_at: new Date(Date.now() - 2 * 86_400_000), params_json: JSON.stringify({ kind: 'HIGH_CPA', level: 'campaign', entityId: e1 }), evidence_json: JSON.stringify({ m3: { spend: 1500, purchases: 4, cpa: 375 } }) } });
    const scE = scenario([sel(e1, pid(115), { today: m(0, 0), dayHours: 0.5 }), sel(e2, pid(115), { today: m(300, 4), dayHours: 0.5, m3: m(300, 4) })], { realLastActive: true });
    const rs = await AE.executeAutoDecision({ decisionId: stale.id, source: 'USER', userId: 1, now: NOW, deps: { config: cfg(ALL), reevaluate: async () => AE.evaluateAutomation({ now: NOW, deps: { ...scE, config: cfg(ALL) } }) } });
    ok('a 2-day-old PREPARED pause built on the 3-day CPA is re-evaluated live: today is only 30 minutes old → EXPIRED (DECISION_CHANGED), ZERO writes', rs.status === 'EXPIRED' && (rs.reasons || []).some((r) => r.code === 'DECISION_CHANGED') && writes(e1).length === 0, JSON.stringify(rs).slice(0, 260)); }
} finally { try { await cleanup(); } catch (e) { console.log('cleanup failed', e.message); } server.close(); }
console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
