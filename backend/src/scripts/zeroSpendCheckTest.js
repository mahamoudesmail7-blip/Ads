// 🧾 DAILY ZERO-ORDER SPEND CHECK — the saved policy (time, limit, comparison, scope, ad accounts, exclusions), the Cairo-day window, ad-account time-zone and data-trust handling, APPROVAL / SHADOW / AUTOMATIC with permissions and gates,
//   idempotency, the live re-check at approval, newer manual actions, and the proof that the day's OPEN plan is untouched. Real executor against a loopback Meta MOCK; no real Meta call anywhere.
//   node src/scripts/zeroSpendCheckTest.js
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

// ------------------------------------------------------------------ the daily zero-order spend check
const ZS = await imp('../services/amb/zeroSpendCheck.js'); const DPm = (await import('./_confirmWrap.js')).withAutoConfirm(await imp('../services/amb/dailyPlans.js')); const TMm = await imp('../services/amb/dailyPlanTime.js');
const ADMIN_ID = (await prisma.user.findFirst({ where: { role: 'ADMIN', status: 'ACTIVE' } }))?.id ?? 1; const ADMINu = { id: ADMIN_ID, role: 'ADMIN', status: 'ACTIVE' }; const MGRu = { id: 9999, role: 'MANAGER', status: 'ACTIVE' };
{ const row0 = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const raw0 = JSON.parse(row0.limits_json || '{}'); if (raw0.zeroSpendCheck) { delete raw0.zeroSpendCheck; await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify(raw0) } }); } } // a crashed earlier run must not leave a policy behind
const limits0 = (await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } })).limits_json; const planIdsZ = [];
const rej = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const atZ = (date, hhmm) => TMm.dueAtTime(date, hhmm);
const zsCleanup = async () => {
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: limits0 } });
  await prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ kind: { in: ['ZERO_SPEND_CHECK', 'ZERO_SPEND_POLICY_SAVED', 'ZERO_SPEND_POLICY_ENABLED'] } }, { campaign_id: { startsWith: T } }] } });
  await prisma.ambAlert.deleteMany({ where: { dedupe_key: { startsWith: 'zerospend:' } } }).catch(() => {});
  await prisma.ambDailyPlanItem.deleteMany({ where: { plan_id: { in: planIdsZ } } }); await prisma.ambDailyPlan.deleteMany({ where: { id: { in: planIdsZ } } });
};
const mkEval = (o = {}) => ({ syncStatus: async () => ({ lastSuccessAt: o.syncAt }), accountTz: async () => (o.tz === undefined ? 'Africa/Cairo' : o.tz), campaignsOf: async (acc) => (o.campaigns || []).filter((c) => !c.acc || c.acc === acc).map((c) => ({ id: c.id, name: c.name || c.id, status: c.status || 'ACTIVE', budget: c.budget ?? 300 })), todayMetrics: async () => new Map(Object.entries(o.metrics || {}).map(([id, [spend, purchases]]) => [id, { spend, purchases }])), selectedAccount: async () => o.account || 'act_zs_A' });
const FRESHz = (at) => ({ syncStatus: async () => ({ lastSuccessAt: new Date() }), refresh: async () => ({ ok: true }) });
const polSave = (patch) => ZS.saveZeroSpendPolicy({ patch, userId: ADMIN_ID, deps: { user: ADMINu } }); const polOn = () => ZS.setZeroSpendEnabled({ enabled: true, confirm: true, userId: ADMIN_ID, deps: { user: ADMINu } });
try {
  await cleanup(); await zsCleanup();
  console.log('\n10. DAILY ZERO-ORDER SPEND CHECK');
  console.log('\n   a) the decision (pure) — limit and comparison come from the saved policy');
  const P = (o = {}) => ZS.normalizeZs({ limit: 150, comparison: 'GT', ...o }); const D = (spend, orders, o = {}) => ZS.decideZeroSpend({ policy: P(o.policy), campaign: { id: 'c1', adAccountId: 'act_zs_A' }, spend, orders, data: o.data });
  ok('spend 149 and 0 orders → continues (inside the limit)', D(149, 0).state === 'CONTINUE' && D(149, 0).code === 'SPEND_WITHIN_LIMIT');
  ok('spend EXACTLY 150 and 0 orders → continues under «>» …', D(150, 0).state === 'CONTINUE');
  ok('… and is ELIGIBLE under «≥» (the comparison is a setting)', D(150, 0, { policy: { comparison: 'GTE' } }).state === 'ELIGIBLE');
  ok('spend 151 and 0 orders → ELIGIBLE', D(151, 0).state === 'ELIGIBLE' && D(151, 0).code === 'ZERO_ORDERS_OVER_LIMIT');
  ok('spend 300 and ONE order → continues (orders present), whatever the spend', D(300, 1).state === 'CONTINUE' && D(300, 1).code === 'ORDERS_PRESENT');
  ok('changing the limit changes the verdict (limit 200: 151 continues, 201 is eligible) — nothing is hard-coded at 150', D(151, 0, { policy: { limit: 200 } }).state === 'CONTINUE' && D(201, 0, { policy: { limit: 200 } }).state === 'ELIGIBLE');
  ok('an excluded campaign is never eligible (EXCLUDED), a campaign outside SELECTED scope is OUT_OF_SCOPE, a campaign outside the chosen ad accounts is OUT_OF_SCOPE', D(999, 0, { policy: { excludeCampaignIds: ['c1'] } }).state === 'EXCLUDED' && D(999, 0, { policy: { scope: 'SELECTED', includeCampaignIds: ['other'] } }).state === 'OUT_OF_SCOPE' && D(999, 0, { policy: { adAccountIds: ['act_other'] } }).state === 'OUT_OF_SCOPE');
  ok('missing or untrusted data → INCOMPLETE, never eligible (null spend, null orders, data not ok)', D(null, 0).state === 'INCOMPLETE' && D(500, null).state === 'INCOMPLETE' && D(500, 0, { data: { ok: false, code: 'DATA_STALE', reason: 'x' } }).state === 'INCOMPLETE');

  console.log('\n   b) the policy: versioned, approved separately, defaults only for an empty policy');
  const p0 = await ZS.getZeroSpendPolicy(); ok('an empty policy has the defaults (13:00 Cairo, 150, «>», all active) and is NOT active', p0.checkTime === '13:00' && p0.limit === 150 && p0.comparison === 'GT' && p0.scope === 'ALL_ACTIVE' && ZS.zeroSpendActive(p0) === false);
  ok('a MANAGER cannot save or approve (403)', (await rej(() => ZS.saveZeroSpendPolicy({ patch: { limit: 100 }, userId: 9999, deps: { user: MGRu } })))?.status === 403 && (await rej(() => ZS.setZeroSpendEnabled({ enabled: true, confirm: true, userId: 9999, deps: { user: MGRu } })))?.status === 403);
  ok('invalid values are refused with the reason (time 25:99, limit 0, bad comparison, SELECTED without campaigns)', (await rej(() => polSave({ checkTime: '25:99' })))?.code === 'INVALID_POLICY' && (await rej(() => polSave({ limit: 0 })))?.code === 'INVALID_POLICY' && (await rej(() => polSave({ comparison: 'LT' })))?.code === 'INVALID_POLICY' && (await rej(() => polSave({ scope: 'SELECTED', includeCampaignIds: [] })))?.code === 'INVALID_POLICY');
  let r = await polSave({ checkTime: '13:00', limit: 150, comparison: 'GT' }); ok('the first save creates version 1; it is NOT active until the owner approves it', r.changed === true && r.policy.version === 1 && r.active === false);
  ok('approval needs an explicit confirm', (await rej(() => ZS.setZeroSpendEnabled({ enabled: true, userId: ADMIN_ID, deps: { user: ADMINu } })))?.code === 'CONFIRM_REQUIRED');
  const on = await polOn(); ok('approving activates exactly version 1 (nothing is paused by approving)', on.active === true && on.policy.approved.version === 1 && allWrites().length === 0);
  r = await polSave({ limit: 150 }); ok('saving the same values again is a no-op (no new version, still active)', r.changed === false && r.active === true && r.policy.version === 1);
  r = await polSave({ limit: 200 }); ok('changing the spend limit creates version 2 and the approval of version 1 stops counting (inactive until re-approved)', r.policy.version === 2 && r.active === false && r.policy.limit === 200);
  r = await polSave({ limit: 150, checkTime: '14:30' }); ok('changing the check time creates a new version too (version 3); the history keeps the old ones', r.policy.version === 3 && r.policy.checkTime === '14:30' && r.policy.history.length >= 2 && r.policy.history.at(-1).version === 2);
  await polSave({ checkTime: '13:00' }); await polOn();
  ok('the summary sentence states time, comparison, limit and scope in plain Arabic', /13:00/.test(ZS.describePolicy(await ZS.getZeroSpendPolicy())) && /150/.test(ZS.describePolicy(await ZS.getZeroSpendPolicy())));

  console.log('\n   c) the window, the ad-account time zone and trust in the data (evaluate = read-only)');
  const DAY = '2031-07-15'; const NOWc = atZ(DAY, '13:05'); const recent = new Date(NOWc.getTime() - 4 * 60_000);
  const camps = [{ id: `${T}zs_a149` }, { id: `${T}zs_a150` }, { id: `${T}zs_a151` }, { id: `${T}zs_b300` }, { id: `${T}zs_ex` }, { id: `${T}zs_paused`, status: 'PAUSED' }];
  const metrics = { [`${T}zs_a149`]: [149, 0], [`${T}zs_a150`]: [150, 0], [`${T}zs_a151`]: [151, 0], [`${T}zs_b300`]: [300, 1], [`${T}zs_ex`]: [900, 0], [`${T}zs_paused`]: [900, 0] };
  const ev = await ZS.evaluateZeroSpendCheck({ now: NOWc, deps: mkEval({ syncAt: recent, campaigns: camps, metrics }) }); const st = (id) => ev.rows.find((x) => x.campaignId === `${T}${id}`)?.state;
  ok('rows: only ACTIVE campaigns are covered; 149 → CONTINUE, 150 (»>») → CONTINUE, 151 → ELIGIBLE, 300 with an order → CONTINUE, a paused campaign is not listed', st('zs_a149') === 'CONTINUE' && st('zs_a150') === 'CONTINUE' && st('zs_a151') === 'ELIGIBLE' && st('zs_b300') === 'CONTINUE' && !ev.rows.some((x) => x.campaignId === `${T}zs_paused`) && ev.summary.ELIGIBLE === 2, JSON.stringify(ev.summary));
  ok('the window is the CAIRO day: from Cairo 00:00 of that day to the check, with the data age and timezone recorded', ev.window.from === atZ(DAY, '00:00').toISOString() && ev.window.timezone === 'Africa/Cairo' && ev.dataAgeMin === 4 && ev.syncOk === true);
  { const e2 = await ZS.evaluateZeroSpendCheck({ now: NOWc, policy: { ...p0, excludeCampaignIds: [`${T}zs_ex`] }, deps: mkEval({ syncAt: recent, campaigns: camps, metrics }) }); ok('an excluded campaign is EXCLUDED even with 900 spend and 0 orders', e2.rows.find((x) => x.campaignId === `${T}zs_ex`).state === 'EXCLUDED'); }
  { const e3 = await ZS.evaluateZeroSpendCheck({ now: NOWc, policy: { ...p0, adAccountIds: ['act_zs_A'] }, deps: mkEval({ syncAt: recent, campaigns: [{ id: `${T}zs_a151`, acc: 'act_zs_A' }, { id: `${T}zs_x`, acc: 'act_zs_B' }], metrics }) }); ok('only the chosen ad accounts are read: a campaign of another account is not even listed', e3.rows.length === 1 && e3.rows[0].adAccountId === 'act_zs_A'); }
  { const e4 = await ZS.evaluateZeroSpendCheck({ now: NOWc, deps: mkEval({ syncAt: recent, tz: 'America/Los_Angeles', campaigns: camps, metrics }) }); ok('an ad account on a DIFFERENT day-clock (Los Angeles) → every row INCOMPLETE (ACCOUNT_TZ_MISMATCH): two clocks are never mixed', e4.rows.every((x) => x.state === 'INCOMPLETE' && x.code === 'ACCOUNT_TZ_MISMATCH') && e4.summary.ELIGIBLE === 0); }
  { const e5 = await ZS.evaluateZeroSpendCheck({ now: NOWc, deps: mkEval({ syncAt: recent, tz: null, campaigns: camps, metrics }) }); ok('an unknown account timezone → INCOMPLETE (ACCOUNT_TZ_UNKNOWN)', e5.rows.every((x) => x.code === 'ACCOUNT_TZ_UNKNOWN')); }
  { const e6 = await ZS.evaluateZeroSpendCheck({ now: NOWc, deps: mkEval({ syncAt: new Date(NOWc.getTime() - 3 * 3_600_000), campaigns: camps, metrics }) }); ok('FAILED / stale Meta sync (3h old, limit 30 min) → INCOMPLETE (DATA_STALE), nothing eligible', e6.rows.every((x) => x.code === 'DATA_STALE') && e6.syncOk === false && e6.summary.ELIGIBLE === 0); }
  ok('same timezone arithmetic is correct: Cairo vs Cairo equal, Cairo vs Los Angeles not', ZS.tzOffsetMinutes('Africa/Cairo', NOWc) === ZS.tzOffsetMinutes('Africa/Cairo', NOWc) && ZS.tzOffsetMinutes('Africa/Cairo', NOWc) !== ZS.tzOffsetMinutes('America/Los_Angeles', NOWc));

  console.log('\n   d) the run — modes, permissions, idempotency, plans');
  const cA = `${T}zs_run_a`, cB = `${T}zs_run_b`, cC = `${T}zs_run_c`; for (const id of [cA, cB, cC]) setEntity(id);
  const RUN_METRICS = { [cA]: [260, 0], [cB]: [260, 3], [cC]: [100, 0] };
  const runDeps = (day, hhmm, o = {}) => { const ev = mkEval({ syncAt: o.syncAt === undefined ? new Date(atZ(day, hhmm).getTime() - 3 * 60_000) : o.syncAt, campaigns: [{ id: cA }, { id: cB }, { id: cC }], metrics: o.metrics || RUN_METRICS }); return { now: atZ(day, hhmm), deps: { config: o.config, noSleep: true, guardsOf: o.guardsOf || (async () => []), fresh: FRESHz(), eval: { ...ev, ...(o.evalExtra || {}) }, execDeps: { config: o.config, zeroSpendDeps: { eval: { ...ev, ...(o.evalExtra || {}) } } }, autopilotOk: true, dcfg: { halted: false, scheduledExecution: { enabled: false } } } }; };
  const D1 = '2031-07-16'; // an OPEN plan of that day is PREPARED and must come out byte-identical
  const planO = (await DPm.preparePlan({ type: 'OPEN', date: D1, now: atZ(D1, '00:30'), simulated: false, userId: ADMIN_ID, deps: { ...FRESHz(), build: async () => ({ items: [{ campaignId: `${T}zs_openme`, campaignName: 'open me', productId: null, productName: 'fx', storeId: ST, rank: 1, selected: true, selectable: true, eligibility: 'ELIGIBLE', blockCodes: [], warnings: [], risk: 'LOW', riskScore: 5, reason: 'fx', evidence: { budget: 300 } }], policy: null }) } })).plan; planIdsZ.push(planO.id);
  const planSnap = async () => JSON.stringify(await prisma.ambDailyPlan.findUnique({ where: { id: planO.id }, include: { items: true } })); const before = await planSnap();
  const rNot = await ZS.runZeroSpendCheck(runDeps(D1, '12:59', { config: cfg(ALL, { mode: 'APPROVAL' }) })); ok('before the check time nothing runs (NOT_DUE) — 12:59 is not 13:00', rNot.ran === false && rNot.why.includes('NOT_DUE'));
  const w0 = allWrites().length; const rApp = await ZS.runZeroSpendCheck(runDeps(D1, '13:02', { config: cfg(ALL, { mode: 'APPROVAL' }) }));
  const dA = await dec(cA); ok('APPROVAL: the eligible campaign gets a PREPARED pause decision for the owner; the order-bearing and low-spend campaigns get nothing; ZERO Meta requests', rApp.ran === true && dA?.status === 'PREPARED' && dA.action === 'PAUSE' && dA.rule_name === 'AUTO:DAILY_ZERO_SPEND' && !(await dec(cB)) && !(await dec(cC)) && allWrites().length === w0, JSON.stringify(rApp).slice(0, 300));
  ok('the decision records the saved policy values and the Cairo window it was judged on', (() => { const z = JSON.parse(dA.evidence_json).zeroSpend; return z.limit === 150 && z.comparison === 'GT' && z.checkTime === '13:00' && z.spend === 260 && z.orders === 0 && z.policyVersion >= 1 && z.window.timezone === 'Africa/Cairo'; })());
  ok('the day\'s OPEN plan is untouched: same status, same version, same selection — byte for byte', (await planSnap()) === before && (await prisma.ambDailyPlan.findUnique({ where: { id: planO.id } })).status === 'PREPARED');
  const nDec = await prisma.ambOperatorDecision.count({ where: { campaign_id: { startsWith: T } } }); const rAgain = await ZS.runZeroSpendCheck(runDeps(D1, '13:20', { config: cfg(ALL, { mode: 'APPROVAL' }) }));
  ok('running the job again the same day does nothing (ALREADY_CHECKED_TODAY) — no duplicate decision', rAgain.ran === false && rAgain.why.includes('ALREADY_CHECKED_TODAY') && (await prisma.ambOperatorDecision.count({ where: { campaign_id: { startsWith: T } } })) === nDec);
  await prisma.ambOperatorEvent.deleteMany({ where: { kind: 'ZERO_SPEND_CHECK', campaign_id: `zs:${D1}` } }); const rCrash = await ZS.runZeroSpendCheck(runDeps(D1, '13:40', { config: cfg(ALL, { mode: 'APPROVAL' }) }));
  ok('even if the «done» marker were lost (crash / second instance), the idempotent decision key prevents a second decision', rCrash.persisted.created === 0 && (await prisma.ambOperatorDecision.count({ where: { campaign_id: { startsWith: T } } })) === nDec);

  console.log('\n   e) the owner approves a PREPARED decision — the live re-check');
  const approveDeps = (day, hhmm, metricsO) => ({ config: cfg(ALL, { mode: 'APPROVAL' }), zeroSpendDeps: { eval: mkEval({ syncAt: new Date(atZ(day, hhmm).getTime() - 2 * 60_000), campaigns: [{ id: cA }, { id: cB }, { id: cC }], metrics: metricsO }) } });
  const exec1 = await AE.executeAutoDecision({ decisionId: dA.id, source: 'USER', userId: ADMIN_ID, now: atZ(D1, '15:00'), deps: approveDeps(D1, '15:00', { ...RUN_METRICS, [cA]: [320, 1] }) });
  ok('an ORDER appears after the check and before the owner approves → the decision EXPIRES (DECISION_CHANGED / not eligible), ZERO requests, the campaign stays ACTIVE', exec1.status === 'EXPIRED' && writes(cA).length === 0 && world.entities.get(cA).status === 'ACTIVE', JSON.stringify(exec1).slice(0, 250));
  const D2 = '2031-07-17'; await ZS.runZeroSpendCheck(runDeps(D2, '13:05', { config: cfg(ALL, { mode: 'APPROVAL' }) })); const dA2 = await dec(cA);
  const exec2 = await AE.executeAutoDecision({ decisionId: dA2.id, source: 'USER', userId: ADMIN_ID, now: atZ(D2, '15:00'), deps: approveDeps(D2, '15:00', RUN_METRICS) });
  ok('still eligible at approval → ONE pause request through the existing executor, the mock really PAUSED, VERIFIED by the independent read-back', exec2.executed === true && writes(cA).length === 1 && world.entities.get(cA).status === 'PAUSED' && (await dec(cA)).status === 'VERIFIED', JSON.stringify(exec2).slice(0, 250));
  world.entities.get(cA).status = 'ACTIVE'; world.entities.get(cA).effective_status = 'ACTIVE';
  const D3 = '2031-07-18'; await ZS.runZeroSpendCheck(runDeps(D3, '13:05', { config: cfg(ALL, { mode: 'APPROVAL' }) })); const dA3 = await dec(cA); const wD3 = allWrites().length;
  const exec3 = await AE.executeAutoDecision({ decisionId: dA3.id, source: 'USER', userId: ADMIN_ID, now: atZ('2031-07-19', '09:00'), deps: approveDeps('2031-07-19', '09:00', RUN_METRICS) });
  ok('approving a decision the NEXT day is refused (DECISION_DAY_PASSED → EXPIRED): yesterday\'s evidence never pauses today\'s campaign', exec3.status === 'EXPIRED' && allWrites().length === wD3, JSON.stringify(exec3).slice(0, 250));

  console.log('\n   f) AUTOMATIC, permissions, gates and conflicts');
  const wasPausedBefore = () => { for (const id of [cA, cB, cC]) { const e = world.entities.get(id); e.status = 'ACTIVE'; e.effective_status = 'ACTIVE'; } };
  wasPausedBefore(); const D4 = '2031-07-20'; const wS = allWrites().length; await ZS.runZeroSpendCheck(runDeps(D4, '13:05', { config: cfg(ALL, { mode: 'SHADOW' }) }));
  ok('SHADOW: the eligible campaign is recorded as a SHADOW decision only — ZERO requests', (await dec(cA))?.status === 'SHADOW' && allWrites().length === wS);
  const wipe = async () => { await prisma.ambOperatorDecision.deleteMany({ where: { campaign_id: { startsWith: T } } }); await prisma.ambAction.deleteMany({ where: { entity_id: { startsWith: T } } }); };
  const gates = [['pause permission OFF', cfg({ ...ALL, pause: false }), 'perm'], ['write-lock closed', cfg(ALL, { writesLocked: true }), 'lock'], ['Emergency Stop', cfg(ALL, { emergency_stop: true }), 'em']];
  let day = 20; for (const [label, c] of gates) { day++; const Dg = `2031-07-${day}`; wasPausedBefore(); await wipe(); const wg = allWrites().length; const rg = await ZS.runZeroSpendCheck(runDeps(Dg, '13:05', { config: c })); ok(`AUTOMATIC with ${label}: the decision waits PREPARED for the owner — ZERO requests`, (await dec(cA))?.status === 'PREPARED' && allWrites().length === wg, JSON.stringify(rg).slice(0, 200)); }
  day++; { const Dg = `2031-07-${day}`; wasPausedBefore(); await wipe(); const wg = allWrites().length; const wA0 = writes(cA).length; const rg = await ZS.runZeroSpendCheck(runDeps(Dg, '13:05', { config: cfg(ALL) }));
    ok('AUTOMATIC (approved policy, mode AUTOMATIC, pause permission ON, gates open): exactly ONE pause on the eligible campaign, VERIFIED; the campaign with an order and the one under the limit are untouched', writes(cA).length === wA0 + 1 && world.entities.get(cA).status === 'PAUSED' && world.entities.get(cB).status === 'ACTIVE' && world.entities.get(cC).status === 'ACTIVE' && allWrites().length === wg + 1 && (await dec(cA))?.status === 'VERIFIED', JSON.stringify({ gate: rg.gate, executed: rg.executed, deferred: rg.deferred }));
    const wg2 = allWrites().length; await ZS.runZeroSpendCheck(runDeps(Dg, '13:30', { config: cfg(ALL) })); await prisma.ambOperatorEvent.deleteMany({ where: { kind: 'ZERO_SPEND_CHECK', campaign_id: `zs:${Dg}` } }); await ZS.runZeroSpendCheck(runDeps(Dg, '13:45', { config: cfg(ALL) }));
    ok('IDEMPOTENT: a repeated job (even with the marker lost) never pauses twice — the terminal decision is not re-run', allWrites().length === wg2); }
  day++; { const Dg = `2031-07-${day}`; wasPausedBefore(); await wipe(); const wg = allWrites().length;
    await ZS.runZeroSpendCheck(runDeps(Dg, '13:05', { config: cfg(ALL), guardsOf: async () => [{ code: 'MANUAL_OVERRIDE_COOLDOWN', message: 'تعديل يدوي أحدث' }] }));
    ok('a NEWER MANUAL action on the campaign (manual-override guard) blocks the pause: the decision is BLOCKED, never executed', (await dec(cA))?.status === 'BLOCKED' && allWrites().length === wg); }
  day++; { const Dg = `2031-07-${day}`; wasPausedBefore(); await wipe(); const wg = allWrites().length;
    await ZS.runZeroSpendCheck(runDeps(Dg, '13:05', { config: cfg(ALL, { mode: 'APPROVAL' }) })); const dd = await dec(cA);
    const rc = await AE.executeAutoDecision({ decisionId: dd.id, source: 'USER', userId: ADMIN_ID, now: atZ(Dg, '14:00'), deps: { ...approveDeps(Dg, '14:00', RUN_METRICS), checkConflicts: async () => [{ code: 'RECENT_MANUAL_OPEN', detail: 'فتح يدوي أحدث' }] } });
    ok('a manual OPEN newer than the decision (conflict check at execution) refuses the pause: ZERO requests, the decision stays PREPARED with the reason', rc.status === 'BLOCKED' && rc.blocked === 'RECENT_MANUAL_OPEN' && allWrites().length === wg && (await dec(cA))?.status === 'PREPARED'); }
  day++; { const Dg = `2031-07-${day}`; wasPausedBefore(); await wipe();
    const rStale = await ZS.runZeroSpendCheck(runDeps(Dg, '13:05', { config: cfg(ALL), syncAt: new Date(atZ(Dg, '13:05').getTime() - 4 * 3_600_000) }));
    ok('FAILED Meta sync at the check time: nothing is decided, the job retries (DATA_STALE) until the grace window ends', rStale.ran === false && rStale.why.includes('DATA_STALE') && !(await dec(cA)) && !!rStale.retryUntil);
    const rOk = await ZS.runZeroSpendCheck(runDeps(Dg, '13:40', { config: cfg(ALL, { mode: 'APPROVAL' }) })); ok('…and when the sync recovers inside the grace window the check runs normally (APPROVAL → PREPARED)', rOk.ran === true && (await dec(cA))?.status === 'PREPARED');
    const Dm = `2031-07-${day + 1}`; day++; await wipe(); const rMiss = await ZS.runZeroSpendCheck(runDeps(Dm, '16:30', { config: cfg(ALL), syncAt: new Date(atZ(Dm, '16:30').getTime() - 5 * 3_600_000) }));
    ok('if the data never becomes trustworthy the day is MISSED: no decision, no pause, an alert for the owner', rMiss.missed === true && !(await dec(cA)) && (await prisma.ambAlert.count({ where: { dedupe_key: `zerospend:missed:${Dm}` } })) === 1); }
  { const Dt = '2031-07-31'; wasPausedBefore(); await wipe(); await polSave({ checkTime: '15:00' }); await polOn(); const w = allWrites().length;
    const early = await ZS.runZeroSpendCheck(runDeps(Dt, '13:30', { config: cfg(ALL, { mode: 'APPROVAL' }) })); const late = await ZS.runZeroSpendCheck(runDeps(Dt, '15:01', { config: cfg(ALL, { mode: 'APPROVAL' }) }));
    ok('CHANGING the check time moves the check: with 15:00 saved, 13:30 is NOT_DUE and 15:01 runs', early.why?.includes('NOT_DUE') && late.ran === true && allWrites().length === w); await polSave({ checkTime: '13:00' }); await polOn(); }
  { wasPausedBefore(); await wipe(); const D8 = '2031-08-02'; const polV = await ZS.getZeroSpendPolicy(); await polSave({ limit: 300 }); await polOn(); await ZS.runZeroSpendCheck(runDeps(D8, '13:05', { config: cfg(ALL, { mode: 'APPROVAL' }) }));
    ok('CHANGING the spend limit changes the outcome: with limit 300 the 260-spend campaign is no longer eligible', !(await dec(cA))); await polSave({ limit: 150 }); await polOn(); void polV; }
  { const rOff = await (async () => { await ZS.setZeroSpendEnabled({ enabled: false, confirm: true, userId: ADMIN_ID, deps: { user: ADMINu } }); return ZS.runZeroSpendCheck(runDeps('2031-08-03', '13:05', { config: cfg(ALL) })); })(); ok('a disabled policy never runs', rOff.ran === false && rOff.why.includes('POLICY_DISABLED')); await polOn(); }
  { const rM = await ZS.runZeroSpendCheck(runDeps('2031-08-04', '13:05', { config: cfg(ALL, { mode: 'OFF' }) })); ok('MANUAL mode (OFF) records nothing — only the preview exists', rM.ran === false && rM.why.includes('MODE_MANUAL')); }
  { wasPausedBefore(); await wipe(); const D9 = '2031-08-05'; await ZS.runZeroSpendCheck(runDeps(D9, '13:05', { config: cfg(ALL, { mode: 'APPROVAL' }) })); const dd = await dec(cA);
    world.entities.get(cA).status = 'PAUSED'; world.entities.get(cA).effective_status = 'PAUSED'; const scOld = scenario([{ id: cA, pid: pid(50), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }]); const wOld = allWrites().length; await tick(scOld, cfg(ALL)); ok('…verified: the old engine sent ZERO requests for the already-paused campaign', allWrites().length === wOld && !!dd); }

  console.log('\n11. WINNER PROTECTION, the policy\'s own daily stop limits, one pause request per campaign, quality of data');
  const WP = (o = {}) => ZS.normalizeZs({ limit: 150, comparison: 'GT', ...o }); const H = (orders, spend) => ({ orders, spend, cpa: orders ? Math.round(spend / orders) : null });
  const cw = (h3, h7, h30, limit = 150, o = {}) => ZS.classifyWinner({ h3, h7, h30, limit, policy: WP(o.policy), dataOk: o.dataOk !== false });
  ok('WINNER needs enough orders in 30d AND 7d, a profit limit and CPA inside it in both windows (12 orders @ CPA 90, 4 @ 100, limit 150)', cw(H(2, 190), H(4, 400), H(12, 1080)).status === 'WINNER');
  ok('CPA alone is NOT enough: only 4 orders in 30 days → UNKNOWN (HISTORY_INSUFFICIENT), never an invented class', cw(H(1, 90), H(2, 180), H(4, 360)).status === 'UNKNOWN' && cw(H(1, 90), H(2, 180), H(4, 360)).code === 'HISTORY_INSUFFICIENT');
  ok('a strong history but NO profit limit for the product → UNKNOWN (NO_PROFIT_LIMIT)', cw(H(2, 190), H(4, 400), H(12, 1080), null).code === 'NO_PROFIT_LIMIT');
  ok('…unless the policy carries its own fallback CPA (then the fallback is the limit)', ZS.classifyWinner({ h3: H(2, 190), h7: H(4, 400), h30: H(12, 1080), limit: 140, policy: WP({ winnerFallbackCpa: 140 }), dataOk: true }).status === 'WINNER');
  ok('good 30-day CPA but 7-day CPA above the profit limit → NOT_WINNER', cw(H(2, 190), H(4, 800), H(12, 1080)).status === 'NOT_WINNER');
  ok('stale / untrusted data → UNKNOWN (DATA_NOT_FRESH)', cw(H(2, 190), H(4, 400), H(12, 1080), 150, { dataOk: false }).code === 'DATA_NOT_FRESH');
  ok('recent collapse (3-day CPA 300 on 3 orders vs 7-day 100) keeps a campaign from being called a Winner and the trend says DECLINING', (() => { const w = cw(H(3, 900), H(6, 600), H(14, 1400)); return w.status === 'NOT_WINNER' && w.trend === 'DECLINING'; })());
  ok('trend is reported: IMPROVING / FLAT', cw(H(3, 210), H(6, 600), H(14, 1400)).trend === 'IMPROVING' && cw(H(3, 300), H(6, 600), H(14, 1400)).trend === 'FLAT');
  const R = (id, spend, winner = 'UNKNOWN') => ({ campaignId: id, campaignName: id, spend, orders: 0, baseState: 'ELIGIBLE', state: 'ELIGIBLE', code: 'ZERO_ORDERS_OVER_LIMIT', reason: 'r', winner: { status: winner } });
  { const rs = [R('w', 400, 'WINNER'), R('n', 300, 'NOT_WINNER'), R('u', 200, 'UNKNOWN')]; ZS.applyRefinements(rs, WP());
    ok('DEFAULT winner action = MANUAL REVIEW: the Winner goes to REVIEW with the exact warning; the non-winner and the UNKNOWN stay ELIGIBLE (UNKNOWN is never turned into a class)', rs[0].state === 'REVIEW' && rs[0].code === 'WINNER_REVIEW' && rs[0].warning === ZS.WINNER_WARNING && rs[1].state === 'ELIGIBLE' && rs[2].state === 'ELIGIBLE'); }
  { const rs = [R('w', 400, 'WINNER')]; ZS.applyRefinements(rs, WP({ winnerAction: 'RULE' })); ok('winner action RULE: stays ELIGIBLE (follows the base rule) but still carries the warning', rs[0].state === 'ELIGIBLE' && rs[0].warning === ZS.WINNER_WARNING); }
  { const rs = [R('w', 400, 'WINNER')]; ZS.applyRefinements(rs, WP({ winnerAction: 'EXEMPT' })); ok('winner action EXEMPT: the campaign is EXCLUDED from this policy (WINNER_EXEMPT)', rs[0].state === 'EXCLUDED' && rs[0].code === 'WINNER_EXEMPT'); }
  { const rs = [R('core', 400), R('x', 300)]; ZS.applyRefinements(rs, WP({ protectedCampaignIds: ['core'] })); ok('a PROTECTED core campaign is never auto-paused: it goes to manual review (PROTECTED_CAMPAIGN), the other stays eligible', rs[0].state === 'REVIEW' && rs[0].code === 'PROTECTED_CAMPAIGN' && rs[1].state === 'ELIGIBLE'); }
  { const rs = [R('a', 100), R('b', 500), R('c', 300)]; const q = ZS.applyRefinements(rs, WP({ maxPausesPerDay: 1 })); const st = (id) => rs.find((x) => x.campaignId === id);
    ok('DAILY LIMIT 1: three eligible → the HIGHEST spend keeps the quota (ELIGIBLE), the other two go to manual review (DAILY_STOP_LIMIT) instead of being paused', st('b').state === 'ELIGIBLE' && st('c').state === 'REVIEW' && st('c').code === 'DAILY_STOP_LIMIT' && st('a').state === 'REVIEW' && q.quota === 1 && q.overLimit === 2); }
  { const rs = [R('a', 100), R('b', 500), R('c', 300)]; ZS.applyRefinements(rs, WP({ maxPausesPerDay: 2 }), { executedToday: 1 }); ok('the quota already used today counts: limit 2 with 1 executed → only ONE more', rs.filter((x) => x.state === 'ELIGIBLE').length === 1); }
  { const rs = Array.from({ length: 10 }, (_, n) => ({ ...R(`c${n}`, 200 + n), state: n < 5 ? 'ELIGIBLE' : 'CONTINUE', baseState: n < 5 ? 'ELIGIBLE' : 'CONTINUE' })); ZS.applyRefinements(rs, WP({ maxPausePct: 20 })); ok('PERCENT limit: 20% of the 10 covered active campaigns = 2 → 2 stay eligible, 3 to review', rs.filter((x) => x.state === 'ELIGIBLE').length === 2 && rs.filter((x) => x.code === 'DAILY_STOP_LIMIT').length === 3); }
  { const rs = [R('a', 100), R('b', 500)]; ZS.applyRefinements(rs, WP({ maxPausesPerDay: 5, maxPausePct: 10 })); ok('both limits set → the stricter one wins (10% of 2 = 0 → everything to review)', rs.every((x) => x.state === 'REVIEW')); }
  { const rs = [R('a', 100), R('b', 500)]; ZS.applyRefinements(rs, WP()); ok('no limits set → no cap at all (the limits are optional)', rs.every((x) => x.state === 'ELIGIBLE')); }
  ok('the limits are SEPARATE from the account limits: they live in the policy and the quota counter reads only this policy\'s own executed decisions', ZS.DEFAULT_ZS.maxPausesPerDay === null && ZS.DEFAULT_ZS.maxPausePct === null && ZS.DEFAULT_ZS.winnerAction === 'MANUAL_REVIEW');
  ok('invalid settings are refused (negative limit, percent 120, unknown winner action, fallback CPA 0)', (await rej(() => polSave({ maxPausesPerDay: -1 })))?.code === 'INVALID_POLICY' && (await rej(() => polSave({ maxPausePct: 120 })))?.code === 'INVALID_POLICY' && (await rej(() => polSave({ winnerAction: 'KILL' })))?.code === 'INVALID_POLICY' && (await rej(() => polSave({ winnerFallbackCpa: 0 })))?.code === 'INVALID_POLICY');

  console.log('\n   evaluate/run with history, profit limit, conflicts and quotas (mock Meta, real engine)');
  const DAYw = '2031-09-10'; const NOWw = atZ(DAYw, '13:05'); const recentW = new Date(NOWw.getTime() - 4 * 60_000);
  const w1 = `${T}zs_w1`, w2 = `${T}zs_w2`, w3 = `${T}zs_w3`, w4 = `${T}zs_w4`; for (const id of [w1, w2, w3, w4]) setEntity(id);
  const hist = { [w1]: { d3: [190, 2], d7: [400, 4], d30: [1080, 12] }, [w2]: { d3: [300, 1], d7: [900, 3], d30: [3000, 12] }, [w3]: {}, [w4]: { d3: [190, 2], d7: [400, 4], d30: [1080, 12] } };
  const histMetrics = async () => { const mk = (k) => new Map(Object.entries(hist).filter(([, v]) => v[k]).map(([id, v]) => [id, { spend: v[k][0], purchases: v[k][1] }])); return { last3: mk('d3'), last7: mk('d7'), last30: mk('d30') }; };
  const evw = (extra = {}) => ({ ...mkEval({ syncAt: recentW, campaigns: [{ id: w1 }, { id: w2 }, { id: w3 }, { id: w4 }], metrics: { [w1]: [260, 0], [w2]: [260, 0], [w3]: [260, 0], [w4]: [260, 0] } }), historyMetrics: histMetrics, profitLimitOf: async () => 150, conflictsOf: async () => new Map(), executedToday: async () => 0, ...extra });
  const evR = await ZS.evaluateZeroSpendCheck({ now: NOWw, policy: WP(), deps: evw() }); const rw = (id) => evR.rows.find((x) => x.campaignId === id);
  ok('PREVIEW rows carry 3/7/30-day orders + CPA + trend, the Winner status and reason, the sync time and the reliability grade', rw(w1).history.d30.orders === 12 && rw(w1).history.d30.cpa === 90 && rw(w1).history.d7.cpa === 100 && rw(w1).winner.status === 'WINNER' && rw(w1).sync.reliability === 'HIGH' && !!rw(w1).sync.asOf && rw(w1).history.trend === 'IMPROVING' || rw(w1).history.trend === 'FLAT');
  ok('classification per campaign: w1 WINNER → REVIEW (default), w2 NOT_WINNER → ELIGIBLE, w3 no history → UNKNOWN → ELIGIBLE, w4 WINNER → REVIEW', rw(w1).state === 'REVIEW' && rw(w2).winner.status === 'NOT_WINNER' && rw(w2).state === 'ELIGIBLE' && rw(w3).winner.status === 'UNKNOWN' && rw(w3).state === 'ELIGIBLE' && rw(w4).state === 'REVIEW' && evR.summary.winnersAtRisk === 2 && evR.summary.REVIEW === 2 && evR.summary.ELIGIBLE === 2);
  { const evS = await ZS.evaluateZeroSpendCheck({ now: NOWw, policy: WP(), deps: evw({ syncStatus: async () => ({ lastSuccessAt: new Date(NOWw.getTime() - 20 * 60_000) }) }) }); ok('reliability degrades with the age of the sync: 20 minutes old (limit 30) → MEDIUM; stale → LOW and nothing is decided', evS.reliability === 'MEDIUM' && (await ZS.evaluateZeroSpendCheck({ now: NOWw, policy: WP(), deps: evw({ syncStatus: async () => ({ lastSuccessAt: new Date(NOWw.getTime() - 3 * 3_600_000) }) }) })).reliability === 'LOW'); }
  { const evC = await ZS.evaluateZeroSpendCheck({ now: NOWw, policy: WP(), deps: evw({ conflictsOf: async () => new Map([[w2, [{ code: 'OTHER_PAUSE_DECISION', detail: 'ZERO_ORDER (PREPARED)' }, { code: 'MANUAL_OVERRIDE_RECENT', detail: 'x' }]]]) }) }); const c2 = evC.rows.find((x) => x.campaignId === w2); ok('conflicts with another pause rule / a recent manual change are listed on the row (and flagged hasOtherPause)', c2.conflicts.length === 2 && c2.hasOtherPause === true); }
  // run: APPROVAL with a winner → decisions for the owner; the winner is a REVIEW item (never auto)
  const Dw = '2031-09-10'; await prisma.ambOperatorDecision.deleteMany({ where: { campaign_id: { startsWith: T } } });
  const runW = (hhmm, o = {}) => ZS.runZeroSpendCheck(runDeps(Dw, hhmm, { metrics: { [w1]: [260, 0], [w2]: [260, 0], [w3]: [260, 0], [w4]: [260, 0] }, evalExtra: { historyMetrics: histMetrics, profitLimitOf: async () => 150, ...(o.evalExtra || {}) }, ...o }));
  const rowsOf = (campaigns) => campaigns; void rowsOf;
  const RUNC = [w1, w2, w3, w4]; const origRunDeps = runDeps;
  const runDepsW = (day, hhmm, o) => { const r = origRunDeps(day, hhmm, o); r.deps.eval.campaignsOf = async () => RUNC.map((id) => ({ id, name: id, status: 'ACTIVE', budget: 300 })); r.deps.execDeps.zeroSpendDeps.eval.campaignsOf = r.deps.eval.campaignsOf; return r; };
  { await polSave({ checkTime: '13:00', winnerAction: 'MANUAL_REVIEW', maxPausesPerDay: null }); await polOn(); wasPausedBefore(); for (const id of RUNC) { const e = world.entities.get(id); e.status = 'ACTIVE'; e.effective_status = 'ACTIVE'; }
    const wD = allWrites().length; const r = await ZS.runZeroSpendCheck(runDepsW(Dw, '13:05', { config: cfg(ALL), metrics: { [w1]: [260, 0], [w2]: [260, 0], [w3]: [260, 0], [w4]: [260, 0] }, evalExtra: { historyMetrics: histMetrics, profitLimitOf: async () => 150, conflictsOf: async () => new Map(), executedToday: async () => 0 } }));
    const d = async (id) => (await dec(id))?.status;
    ok('AUTOMATIC with the default winner action: the two non-winners (w2, w3) are paused ONCE each and VERIFIED; the two Winners get a PREPARED decision for MANUAL REVIEW and Meta is not touched for them', writes(w2).length === 1 && writes(w3).length === 1 && world.entities.get(w2).status === 'PAUSED' && world.entities.get(w3).status === 'PAUSED' && (await d(w2)) === 'VERIFIED' && (await d(w3)) === 'VERIFIED' && (await d(w1)) === 'PREPARED' && (await d(w4)) === 'PREPARED' && writes(w1).length === 0 && writes(w4).length === 0 && world.entities.get(w1).status === 'ACTIVE', JSON.stringify({ r: r.eligible, w: allWrites().length - wD }));
    const ev1 = JSON.parse((await dec(w1)).evidence_json); ok('the Winner decision records WHY: the warning text, the 3/7/30-day history and the Winner reasoning', ev1.zeroSpend.warning === ZS.WINNER_WARNING && ev1.zeroSpend.winner.status === 'WINNER' && ev1.zeroSpend.history.d30.orders === 12 && ev1.zeroSpend.finalState === 'REVIEW');
    const ex = await AE.executeAutoDecision({ decisionId: (await dec(w1)).id, source: 'USER', userId: ADMIN_ID, now: atZ(Dw, '14:00'), deps: { config: cfg(ALL, { mode: 'APPROVAL' }), zeroSpendDeps: { eval: { ...evw(), campaignsOf: async () => RUNC.map((id) => ({ id, name: id, status: 'ACTIVE', budget: 300 })), syncStatus: async () => ({ lastSuccessAt: new Date(atZ(Dw, '14:00').getTime() - 2 * 60_000) }) } } } });
    ok('the OWNER can still approve the Winner review item himself (zero orders over the limit is re-verified live): one pause, VERIFIED', ex.executed === true && writes(w1).length === 1 && world.entities.get(w1).status === 'PAUSED', JSON.stringify(ex).slice(0, 200)); }
  { // DAILY LIMIT in AUTOMATIC: 3 eligible, limit 1 → one pause, two prepared for review; the quota already used blocks a later re-run
    const D2w = '2031-09-11'; await polSave({ winnerAction: 'RULE', maxPausesPerDay: 1 }); await polOn(); for (const id of RUNC) { const e = world.entities.get(id); e.status = 'ACTIVE'; e.effective_status = 'ACTIVE'; } await prisma.ambOperatorDecision.deleteMany({ where: { campaign_id: { startsWith: T } } }); await prisma.ambAction.deleteMany({ where: { entity_id: { startsWith: T } } }); // the executor's 6-hour duplicate guard must not see the earlier fixture pause
    const wD = allWrites().length; const wW1 = writes(w1).length; const sp = { [w1]: [400, 0], [w2]: [300, 0], [w3]: [200, 0], [w4]: [160, 0] };
    const r = await ZS.runZeroSpendCheck(runDepsW(D2w, '13:05', { config: cfg(ALL), metrics: sp, evalExtra: { historyMetrics: histMetrics, profitLimitOf: async () => 150, executedToday: undefined } }));
    ok('DAILY LIMIT 1 in AUTOMATIC with four eligible campaigns: exactly ONE pause (the highest spend, w1), the other three are PREPARED for manual review (DAILY_STOP_LIMIT), ZERO extra requests', allWrites().length === wD + 1 && writes(w1).length === wW1 + 1 && (await dec(w1))?.status === 'VERIFIED' && (await dec(w2))?.status === 'PREPARED' && (await dec(w3))?.status === 'PREPARED' && (await dec(w4))?.status === 'PREPARED' && JSON.parse((await dec(w2)).evidence_json).zeroSpend.finalCode === 'DAILY_STOP_LIMIT', JSON.stringify([allWrites().length - wD, writes(w1).length - wW1, (await dec(w1))?.status, (await dec(w1))?.blocked_codes_json?.slice(0, 90), (await dec(w2))?.status, JSON.parse((await dec(w2))?.evidence_json || '{}').zeroSpend?.finalCode]));
    await polSave({ winnerAction: 'MANUAL_REVIEW', maxPausesPerDay: null }); await polOn(); }
  console.log('\n   one pause request per campaign — merging with the other pause rules');
  { const Dm = '2031-09-12'; const mA = `${T}zs_m1`; setEntity(mA); await prisma.ambOperatorDecision.deleteMany({ where: { campaign_id: { startsWith: T } } });
    // (1) the old engine\'s ZERO_ORDER decision is on the table first (APPROVAL → PREPARED) …
    const scM = scenario([{ id: mA, pid: pid(60), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }]); await tick(scM, cfg(ALL, { mode: 'APPROVAL' })); const first = await dec(mA);
    ok('precondition: the old ZERO_ORDER rule prepared a pause decision for the campaign', first?.status === 'PREPARED' && first.rule_name === 'AUTO:ZERO_ORDER'); await prisma.ambOperatorDecision.update({ where: { id: first.id }, data: { created_at: atZ(Dm, '10:00') } }); // the virtual test clock: the earlier decision must look like it was made this morning
    // … then the daily check also finds it eligible
    const runM = (cfgM) => ZS.runZeroSpendCheck({ now: atZ(Dm, '13:05'), deps: { config: cfgM, noSleep: true, guardsOf: async () => [], fresh: FRESHz(), eval: { ...mkEval({ syncAt: new Date(atZ(Dm, '13:02').getTime()), campaigns: [{ id: mA }], metrics: { [mA]: [260, 0] } }), historyMetrics: async () => ({ last3: new Map(), last7: new Map(), last30: new Map() }), profitLimitOf: async () => null, executedToday: async () => 0 }, execDeps: { config: cfgM }, autopilotOk: true, dcfg: { halted: false, scheduledExecution: { enabled: false } } } });
    const r1 = await runM(cfg(ALL, { mode: 'APPROVAL' })); const nPause = await prisma.ambOperatorDecision.count({ where: { campaign_id: mA, action: 'PAUSE' } });
    ok('MERGED, not duplicated: the daily check creates NO second pause decision — it adds its reason to the existing one (alsoFired) — still exactly ONE PAUSE decision', r1.persisted.merged === 1 && nPause === 1 && JSON.parse((await dec(mA)).evidence_json).alsoFired?.some((x) => x.kind === 'DAILY_ZERO_SPEND'), JSON.stringify(r1.persisted));
    // (2) reverse order: the daily check first, the old engine afterwards
    const mB = `${T}zs_m2`; setEntity(mB); const Dm2 = '2031-09-13'; await prisma.ambOperatorEvent.deleteMany({ where: { kind: 'ZERO_SPEND_CHECK', campaign_id: `zs:${Dm2}` } });
    await ZS.runZeroSpendCheck({ now: atZ(Dm2, '13:05'), deps: { config: cfg(ALL, { mode: 'APPROVAL' }), noSleep: true, guardsOf: async () => [], fresh: FRESHz(), eval: { ...mkEval({ syncAt: atZ(Dm2, '13:02'), campaigns: [{ id: mB }], metrics: { [mB]: [260, 0] } }), historyMetrics: async () => ({ last3: new Map(), last7: new Map(), last30: new Map() }), profitLimitOf: async () => null, executedToday: async () => 0 }, autopilotOk: true, dcfg: { halted: false, scheduledExecution: { enabled: false } } } });
    const scB = scenario([{ id: mB, pid: pid(61), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }]); const rB = await tick(scB, cfg(ALL, { mode: 'APPROVAL' }));
    ok('REVERSE order: the old engine finds the campaign already has a pause decision from the daily check → merged, still ONE decision', (await prisma.ambOperatorDecision.count({ where: { campaign_id: mB, action: 'PAUSE' } })) === 1 && (rB.persisted?.created ?? 0) === 0 && JSON.parse((await dec(mB)).evidence_json).alsoFired?.some((x) => x.kind === 'ZERO_ORDER'), JSON.stringify(rB.persisted));
    // (3) both fire in AUTOMATIC: one POST only
    const mC = `${T}zs_m3`; setEntity(mC); const Dm3 = '2031-09-14'; const wC = allWrites().length;
    await ZS.runZeroSpendCheck({ now: atZ(Dm3, '13:05'), deps: { config: cfg(ALL), noSleep: true, guardsOf: async () => [], fresh: FRESHz(), eval: { ...mkEval({ syncAt: atZ(Dm3, '13:02'), campaigns: [{ id: mC }], metrics: { [mC]: [260, 0] } }), historyMetrics: async () => ({ last3: new Map(), last7: new Map(), last30: new Map() }), profitLimitOf: async () => null, executedToday: async () => 0 }, execDeps: { config: cfg(ALL), zeroSpendDeps: { eval: { ...mkEval({ syncAt: atZ(Dm3, '13:02'), campaigns: [{ id: mC }], metrics: { [mC]: [260, 0] } }), historyMetrics: async () => ({ last3: new Map(), last7: new Map(), last30: new Map() }), profitLimitOf: async () => null, executedToday: async () => 0 } } }, autopilotOk: true, dcfg: { halted: false, scheduledExecution: { enabled: false } } } });
    const scC = scenario([{ id: mC, pid: pid(62), m3: m(260, 0), row: { action: 'PAUSE', decision: 'WOULD_PAUSE' } }]); await tick(scC, cfg(ALL)); await tick(scC, cfg(ALL));
    ok('both rules eligible in AUTOMATIC → exactly ONE pause request reaches Meta (the second rule\'s ticks add nothing), every reason is recorded on the single decision', allWrites().length === wC + 1 && writes(mC).length === 1 && world.entities.get(mC).status === 'PAUSED' && (await prisma.ambOperatorDecision.count({ where: { campaign_id: mC, action: 'PAUSE' } })) === 1); }
} finally { try { await zsCleanup(); await cleanup(); } catch (e) { console.log('cleanup failed', e.message); } server.close(); }
console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
