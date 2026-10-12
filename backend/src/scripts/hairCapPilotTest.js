// 🧪 HAIR-CAP #424 PILOT — the values the owner dictated (Scale 150 · Reduce 180 · Hard Stop 200 · product cap 600 · ±20% · cooldown 24h · ONE budget change a day · min 5 orders · zero-order stop 200 after 24h)
//   through the real policy validator, optimizer policy, budget caps, pause policy, readiness and the automation engine against a loopback Meta MOCK. No real Meta call anywhere.
//   node src/scripts/hairCapPilotTest.js
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

// ------------------------------------------------------------------ the Hair-Cap #424 pilot policy, exactly as the owner dictated it
const BO2 = await imp('../services/amb/budgetOptimizer.js'); const PPx = await imp('../services/amb/productPolicy.js'); const BC = await imp('../services/amb/budgetCaps.js'); const ARx = await imp('../services/amb/automationReadiness.js');
const PILOT = { mode: 'AUTOMATIC', schedule: { openTime: '00:00', closeTime: '13:00', days: null }, cpa: { scale: 150, reduce: 180, hardStop: 200 }, zeroOrder: { spend: 200, minAgeHours: 24 }, budget: { increasePct: 20, decreasePct: 20, cooldownHours: 24, minPurchases: 5, dailySpendCap: 600, maxChangesPerDay: 1 } };
const KEY = pk(424);
try {
  await cleanup();
  console.log('\n9. HAIR-CAP #424 PILOT — the dictated values through the real policy, optimizer, caps, readiness and engine (Meta mock)');
  ok('the pilot policy is valid as dictated (Scale 150 < Reduce 180 < Hard Stop 200, cap 600, ±20%, cooldown 24h, 1 budget change/day, 5 orders)', PPx.validatePolicy(PPx.normalizePolicy(PILOT)).length === 0);
  const eff = PPx.applyToBudgetPolicy(BO2.DEFAULT_POLICY, PPx.normalizePolicy(PILOT), 'c1');
  ok('the optimizer policy built from it carries exactly those numbers (scale ≤150 +20%, reduce ≥180 −20%, min 5 orders, cooldown 24h, high-CPA zone starts at the product Hard Stop 200, zero-order stop 200)', eff.policy.scale.maxCpa === 150 && eff.policy.scale.pct === 20 && eff.policy.reduce.minCpa === 180 && eff.policy.reduce.pct === 20 && eff.policy.scale.minPurchases === 5 && eff.policy.reduce.minPurchases === 5 && eff.policy.scale.cooldownHours === 24 && eff.policy.highCpa.above === 200 && eff.zeroSpend === 200 && eff.dailyCap === 600);
  const cls = (spend, purchases, extra = {}) => BO2.classifyBudget({ m: m(spend, purchases), m7: m(spend, purchases), ageHours: 300, policy: eff.policy, zeroSpendLimit: eff.zeroSpend, ...extra });
  const act = (r) => r.action || null;
  ok('CPA 130 with 6 orders → SCALE_UP +20%', act(cls(780, 6)) === 'SCALE_UP' && cls(780, 6).pct === 20, JSON.stringify(cls(780, 6)).slice(0, 200));
  ok('CPA 165 with 6 orders (between Scale and Reduce) → KEEP, nothing happens', act(cls(990, 6)) === null);
  ok('CPA 190 with 6 orders (≥ Reduce 180) → SCALE_DOWN −20%', act(cls(1140, 6)) === 'SCALE_DOWN' && cls(1140, 6).pct === 20);
  ok('CPA 130 but only 4 orders → no increase (minimum 5 orders)', act(cls(520, 4)) !== 'SCALE_UP');
  ok('zero orders: spend 250 ≥ 200 and age ≥ 24h → PAUSE; spend 150 → nothing; a campaign younger than 24h → nothing', act(cls(250, 0)) === 'PAUSE' && act(cls(150, 0)) === null && act(cls(250, 0, { ageHours: 10 })) !== 'PAUSE');
  const pol = PPx.normalizePolicy(PILOT); const dp = (o = {}) => PPol.decidePause({ policy: PPol.normalizePause({ enabled: true, version: 1, approved: { version: 1 }, highCpa: { enabled: true, above: null, minPurchases: 5, minSpend: 300 } }), campaignId: 'c1', productId: 424, storeId: ST, m3: m(1500, 5), stock: { status: 'IN_STOCK' }, winner: false, weekday: 3, productHighCpa: pol.cpa.hardStop, ...o });
  ok('pause by high CPA uses the product\'s own Hard Stop (200): CPA 300 with 5 orders → HIGH_CPA; CPA 190 → no pause', dp().trigger === 'HIGH_CPA' && dp({ m3: m(950, 5) }).trigger === null);
  ok('…but not when TODAY already recovered (3 orders at CPA 100) and never for a protected winner', dp({ mToday: m(300, 3) }).trigger === null && dp({ winner: true }).trigger === null);
  ok('OUT_OF_STOCK pauses (stock-out is a BLOCK); unknown stock does not', dp({ stock: { status: 'OUT_OF_STOCK' } }).trigger === 'STOCK_OUT' && dp({ stock: { status: 'STOCK_UNKNOWN' }, m3: m(400, 5) }).trigger === null);

  console.log('\n   product daily cap 600');
  const caps = { campaign: null, product: null, account: null };
  const c1 = await BC.checkBudgetCaps({ action: 'SCALE_UP', delta: 100, adAccountId: 'a', campaignId: 'c1', productId: 424, productCapOverride: pol.budget.dailySpendCap, deps: { caps, totals: { campaign: 500, product: 500, account: 3030 } } });
  ok('500 → 600 (+100) fits the product cap 600', c1.ok === true);
  const c2 = await BC.checkBudgetCaps({ action: 'SCALE_UP', delta: 120, adAccountId: 'a', campaignId: 'c1', productId: 424, productCapOverride: pol.budget.dailySpendCap, deps: { caps, totals: { campaign: 600, product: 600, account: 3130 } } });
  ok('600 → 720 is REFUSED by the product cap (level المنتج, cap 600)', c2.ok === false && c2.violations.some((v) => v.level === 'product' && v.cap === 600));
  const c3 = await BC.checkBudgetCaps({ action: 'SCALE_UP', delta: 500, adAccountId: 'a', campaignId: 'c2', productId: 424, productCapOverride: 600, deps: { caps, totals: { campaign: 0, product: 500, account: 3030 } } });
  ok('opening/raising a SECOND campaign of the product by 500 (500 + 500 > 600) is refused too', c3.ok === false);

  console.log('\n   the engine on the Meta mock (budget changes: ONE per day)');
  const hc = `${T}hc_a`; setEntity(hc, { daily_budget: '50000' });
  const scUp = scenario([{ id: hc, pid: 424, budget: 500, m3: m(780, 6), row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', to: 600 } }]); scUp.policies = new Map([[KEY, PILOT]]);
  const w0 = allWrites().length; const r1 = await tick(scUp, cfg(ALL), { policies: new Map([[KEY, PILOT]]), changesToday: async () => 0 });
  ok('first budget change of the day: 500 → 600 goes out as ONE write (mock 60000) and is VERIFIED by the independent read-back', allWrites().length === w0 + 1 && world.entities.get(hc).daily_budget === '60000' && (await dec(hc))?.status === 'VERIFIED', JSON.stringify(r1.deferred));
  const hc2 = `${T}hc_b`; setEntity(hc2, { daily_budget: '50000' });
  const scDn = scenario([{ id: hc2, pid: 424, budget: 500, m3: m(1140, 6), row: { action: 'SCALE_DOWN', decision: 'WOULD_REDUCE', to: 400 } }]); scDn.policies = new Map([[KEY, PILOT]]);
  const w1 = allWrites().length; const r2 = await tick(scDn, cfg(ALL), { policies: new Map([[KEY, PILOT]]), changesToday: async () => 1 });
  ok('a SECOND budget change the same day (a reduction) is deferred: PRODUCT_MAX_CHANGES_PER_DAY, ZERO requests, the mock budget is untouched', allWrites().length === w1 && r2.deferred.some((d) => d.code === 'PRODUCT_MAX_CHANGES_PER_DAY') && world.entities.get(hc2).daily_budget === '50000');
  const r3 = await tick(scDn, cfg(ALL), { policies: new Map([[KEY, PILOT]]), changesToday: async () => 0 });
  ok('the next day (counter back to 0) the same reduction 500 → 400 executes once and is VERIFIED', writes(hc2).length === 1 && world.entities.get(hc2).daily_budget === '40000' && (await dec(hc2))?.status === 'VERIFIED', JSON.stringify(r3.deferred));
  const hc3 = `${T}hc_c`; setEntity(hc3, { daily_budget: '50000' }); const scEm = scenario([{ id: hc3, pid: 424, budget: 500, m3: m(780, 6), row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', to: 600 } }]); scEm.policies = new Map([[KEY, PILOT]]);
  const w2 = allWrites().length; await tick(scEm, cfg(ALL, { emergency_stop: true }), { policies: new Map([[KEY, PILOT]]), changesToday: async () => 0 }); await tick(scEm, cfg(ALL, { writesLocked: true }), { policies: new Map([[KEY, PILOT]]), changesToday: async () => 0 }); await tick(scEm, cfg(OFF), { policies: new Map([[KEY, PILOT]]), changesToday: async () => 0 });
  ok('Emergency Stop / closed write-lock / all permissions OFF → ZERO requests for the pilot campaign', allWrites().length === w2 && world.entities.get(hc3).daily_budget === '50000');

  console.log('\n   TARGET CAMPAIGN ONLY (automaticOnly)');
  const tgt = `${T}hc_target`, oth = `${T}hc_other`; setEntity(tgt, { daily_budget: '50000' }); setEntity(oth, { daily_budget: '50000' });
  const ONLY = { ...PILOT, automaticOnly: [tgt] };
  ok('mergeEffective: the product is AUTOMATIC, the listed campaign is AUTOMATIC, every other campaign of the product falls back to APPROVAL', PPx.mergeEffective(ONLY).mode === 'AUTOMATIC' && PPx.mergeEffective(ONLY, tgt).mode === 'AUTOMATIC' && PPx.mergeEffective(ONLY, oth).mode === 'APPROVAL');
  ok('a campaign-level AUTOMATIC override cannot widen the list', PPx.mergeEffective({ ...ONLY, campaigns: { [oth]: { mode: 'AUTOMATIC' } } }, oth).mode === 'APPROVAL');
  const scT = scenario([{ id: tgt, pid: 424, budget: 500, m3: m(780, 6), row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', to: 600 } }, { id: oth, pid: 424, budget: 500, m3: m(780, 6), row: { action: 'SCALE_UP', decision: 'WOULD_INCREASE', to: 600 } }]);
  scT.policies = new Map([[KEY, ONLY]]);
  const wT = allWrites().length; await tick(scT, cfg(ALL), { policies: new Map([[KEY, ONLY]]), changesToday: async () => 0 });
  ok('with both campaigns wanting +20%, ONLY the listed campaign is executed (mock 60000); the other one is PREPARED for the owner and its Meta budget is untouched', writes(tgt).length === 1 && world.entities.get(tgt).daily_budget === '60000' && writes(oth).length === 0 && world.entities.get(oth).daily_budget === '50000' && allWrites().length === wT + 1 && (await dec(oth))?.status === 'PREPARED', JSON.stringify([writes(tgt).length, writes(oth).length, (await dec(oth))?.status]));
  console.log('\n   readiness of the pilot: exactly what is still missing');
  const row = { productId: 424, storeId: ST, name: 'كاب الليزر', economicsComplete: true, stockKnown: true, stock: 2000, campaignsMapped: 24 };
  const pauseOk = PPol.normalizePause({ enabled: true, version: 1, approved: { version: 1 } });
  const rd1 = ARx.evaluateReadiness({ row, policy: PPx.normalizePolicy(PILOT), pause: pauseOk, open: null });
  ok('with the dictated values ONLY, the pilot is NEEDS_CONFIGURATION: minimum and maximum campaign budget are not set (no number is invented)', rd1.ready === false && rd1.missing.length === 1 && rd1.missing[0].key === 'SPEND_LIMITS' && /أقل ميزانية/.test(rd1.missing[0].detail) && /أقصى ميزانية/.test(rd1.missing[0].detail), JSON.stringify(rd1.missing));
  const rd2 = ARx.evaluateReadiness({ row, policy: PPx.normalizePolicy({ ...PILOT, budget: { ...PILOT.budget, minBudget: 200, maxBudget: 600 } }), pause: pauseOk, open: null });
  ok('…and READY once min/max budget are supplied AND the pause policy is approved', rd2.ready === true);
  const rd3 = ARx.evaluateReadiness({ row, policy: PPx.normalizePolicy({ ...PILOT, budget: { ...PILOT.budget, minBudget: 200, maxBudget: 600 } }), pause: PPol.normalizePause({}), open: null });
  ok('…but never while the pause policy is not approved', rd3.ready === false && rd3.missing.some((x) => x.key === 'PAUSE_POLICY'));
} finally { try { await cleanup(); } catch (e) { console.log('cleanup failed', e.message); } server.close(); }
console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
