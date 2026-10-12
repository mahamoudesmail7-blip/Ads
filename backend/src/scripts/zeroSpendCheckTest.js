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
  const runDeps = (day, hhmm, o = {}) => { const ev = mkEval({ syncAt: o.syncAt === undefined ? new Date(atZ(day, hhmm).getTime() - 3 * 60_000) : o.syncAt, campaigns: [{ id: cA }, { id: cB }, { id: cC }], metrics: o.metrics || RUN_METRICS }); return { now: atZ(day, hhmm), deps: { config: o.config, noSleep: true, guardsOf: o.guardsOf || (async () => []), fresh: FRESHz(), eval: ev, execDeps: { config: o.config, zeroSpendDeps: { eval: ev } }, autopilotOk: true, dcfg: { halted: false, scheduledExecution: { enabled: false } } } }; };
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
} finally { try { await zsCleanup(); await cleanup(); } catch (e) { console.log('cleanup failed', e.message); } server.close(); }
console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
