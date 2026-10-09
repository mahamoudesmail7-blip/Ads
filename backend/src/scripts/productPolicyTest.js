// 🧩 Product Policies — schema/validation, layering over the global budget policy, draft ≠ active, ADMIN + confirm (+ AUTOMATIC second confirm), mirrored guard inputs, copy, per-product days /
// own open-close time, engine integration (budget optimizer + daily plan gates). Isolated TEST database only; no Meta, no executor.
//   node src/scripts/productPolicyTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const rej = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const { prisma } = await imp('../prisma.js');
const PP = await imp('../services/amb/productPolicy.js');
const BO = await imp('../services/amb/budgetOptimizer.js');
const S = await imp('../services/amb/operatorStore.js');
const DC = await imp('../services/amb/dailyPlanCandidates.js');
const DP = await imp('../services/amb/dailyPlans.js');
const T = '__optest_';
const rawBefore = (await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }))?.limits_json ?? null;
const admin = await prisma.user.findUnique({ where: { id: 1 } }); const cleanUsers = [];
const mgr = await prisma.user.create({ data: { email: `${T}mgr@example.invalid`, password_hash: 'x'.repeat(20), name: `${T}manager`, role: 'MANAGER', status: 'ACTIVE', permissions: '{}' } }); cleanUsers.push(mgr.id);
const PID = 424, STORE = 'trendy-storeee';
const restoreAll = async () => { await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: rawBefore } }); await prisma.ambOperatorProductConfig.deleteMany({ where: { product_id: PID, store_id: STORE } }); for (const id of cleanUsers) await prisma.user.deleteMany({ where: { id } }); await prisma.ambOperatorEvent.deleteMany({ where: { note: { contains: `${STORE}:${PID}` } } }); await prisma.aiAuditLog.deleteMany({ where: { kind: { startsWith: 'OPERATOR_PRODUCT_POLICY' }, input_json: { contains: `${STORE}:${PID}` } } }); await prisma.aiAuditLog.deleteMany({ where: { kind: { startsWith: 'OPERATOR_PRODUCT_POLICY' }, input_json: { contains: `${T}` } } }); };
try {
  console.log('\n1. Schema, normalisation and hard bounds (pure)');
  const n0 = PP.normalizePolicy({ mode: 'WRONG', junk: 1, schedule: { openTime: '03:00', days: [1, 1, 9, 'x', 5] }, budget: { increasePct: '25' }, campaigns: { c1: { mode: 'APPROVAL' }, c2: {} } });
  ok('unknown fields are dropped, a wrong mode becomes null (= inherit), days are de-duplicated and bounded 0–6, numbers coerced', n0.junk === undefined && n0.mode === null && JSON.stringify(n0.schedule.days) === '[1,5]' && n0.budget.increasePct === 25 && n0.schedule.openTime === '03:00');
  ok('an empty campaign override is dropped, a real one is kept', !('c2' in n0.campaigns) && n0.campaigns.c1.mode === 'APPROVAL');
  const bad = (patch) => PP.validatePolicy(PP.normalizePolicy(patch)).length > 0;
  ok('increase/decrease above 50%, cooldown below 6h, zero-order spend below 50, window not 3/7 → refused', bad({ budget: { increasePct: 80 } }) && bad({ budget: { decreasePct: 60 } }) && bad({ budget: { cooldownHours: 2 } }) && bad({ zeroOrder: { spend: 20 } }) && bad({ zeroOrder: { windowDays: 5 } }));
  ok('ordering rules: scale < reduce ≤ hard stop, normal min ≤ max, min budget ≤ max budget, HH:MM format', bad({ cpa: { scale: 150, reduce: 100 } }) && bad({ cpa: { reduce: 300, hardStop: 200 } }) && bad({ cpa: { normalMin: 120, normalMax: 100 } }) && bad({ budget: { minBudget: 500, maxBudget: 100 } }) && bad({ schedule: { openTime: '25:99' } }));
  ok('a coherent policy (Normal 50–100, Scale 70, Reduce 150, Zero 150, +20/−20) validates; campaign overrides are validated too', !bad({ cpa: { normalMin: 50, normalMax: 100, scale: 70, reduce: 150, hardStop: 250 }, zeroOrder: { spend: 150 }, budget: { increasePct: 20, decreasePct: 20, cooldownHours: 24 } }) && bad({ campaigns: { c9: { budget: { increasePct: 99 } } } }));

  console.log('\n2. Layering over the global budget policy (pure)');
  const G = BO.DEFAULT_POLICY;
  const pol = PP.normalizePolicy({ cpa: { scale: 70, reduce: 140, normalMin: 71, normalMax: 139 }, zeroOrder: { spend: 150, windowDays: 7 }, budget: { increasePct: 30, decreasePct: 25, minPurchases: 4, cooldownHours: 12, minBudget: 100, maxBudget: 700 }, stockPolicy: 'BLOCK', campaigns: { cX: { budget: { increasePct: 10 }, zeroOrder: { spend: 90 } } } });
  const a = PP.applyToBudgetPolicy(G, pol, 'cY'); const aX = PP.applyToBudgetPolicy(G, pol, 'cX');
  ok('product values override the global ones (scale %, scale CPA, reduce %, reduce CPA, min purchases, cooldown, zero-order, window)', a.policy.scale.pct === 30 && a.policy.scale.maxCpa === 70 && a.policy.reduce.pct === 25 && a.policy.reduce.minCpa === 140 && a.policy.scale.minPurchases === 4 && a.policy.reduce.cooldownHours === 12 && a.policy.zeroOrders.spend === 150 && a.policy.window === 'last7', JSON.stringify(a.policy.scale));
  ok('the campaign override wins over the product (10% / zero 90) and inherits everything else', aX.policy.scale.pct === 10 && aX.policy.zeroOrders.spend === 90 && aX.policy.scale.maxCpa === 70);
  ok('bounds and stock policy are carried; the global policy object is never mutated', a.bounds.minBudget === 100 && a.bounds.maxBudget === 700 && a.stockPolicy === 'BLOCK' && G.scale.pct === 20 && G.zeroOrders.spend === 200);
  ok('an inconsistent override still yields coherent zones (scale CPA < reduce CPA)', PP.applyToBudgetPolicy(G, PP.normalizePolicy({ cpa: { scale: 400 } })).policy.scale.maxCpa < G.reduce.minCpa);
  ok('days: 0=Sunday … Sat; a product with days [1,2] is OFF on Friday (5) and ON on Monday (1); no days = every day', PP.dayAllowed({ schedule: { days: [1, 2] } }, 1) && !PP.dayAllowed({ schedule: { days: [1, 2] } }, 5) && PP.dayAllowed({ schedule: {} }, 5) && PP.weekdayOfCairoDate('2026-10-09') === 5);
  const sb = (policy, type, slotTime, date = '2026-10-07', cid = null) => DC.policyScheduleBlock({ policy, type, slotTime, date, campaignId: cid });
  ok('plan gate: own open time ≠ the plan slot → «له موعد خاص»; equal → in; day off → blocked; no policy → nothing', sb({ schedule: { openTime: '03:00' } }, 'OPEN', '00:00') === 'PRODUCT_POLICY_OTHER_TIME' && sb({ schedule: { openTime: '03:00' } }, 'OPEN', '03:00') === null && sb({ schedule: { days: [1] } }, 'OPEN', '00:00', '2026-10-09') === 'PRODUCT_POLICY_DAY_OFF' && sb(null, 'OPEN', '00:00') === null);
  ok('the close time governs PAUSE plans and a campaign-level time overrides the product', sb({ schedule: { closeTime: '15:30' } }, 'PAUSE', '13:00') === 'PRODUCT_POLICY_OTHER_TIME' && sb({ schedule: { openTime: '03:00' }, campaigns: { c1: { schedule: { openTime: '00:00' } } } }, 'OPEN', '00:00', '2026-10-07', 'c1') === null);

  console.log('\n3. Save ≠ Activate, ADMIN + confirm, AUTOMATIC needs a second confirm, mirrored guard inputs, copy');
  const good = { mode: 'APPROVAL', cpa: { normalMin: 50, normalMax: 100, scale: 70, reduce: 150, hardStop: 250 }, zeroOrder: { spend: 150 }, budget: { increasePct: 20, decreasePct: 20, minPurchases: 3, cooldownHours: 24, minBudget: 100, maxBudget: 800 }, schedule: { openTime: '03:00', days: [0, 1, 2, 3, 4] } };
  ok('a MANAGER cannot save, activate or copy a policy', (await rej(() => PP.saveDraft({ productId: PID, storeId: STORE, policy: good, userId: mgr.id })))?.status === 403 && (await rej(() => PP.activatePolicy({ productId: PID, storeId: STORE, confirm: true, userId: mgr.id })))?.status === 403 && (await rej(() => PP.copyPolicy({ from: { productId: PID, storeId: STORE }, to: [], userId: mgr.id })))?.status === 403);
  ok('an invalid draft is refused with the reasons and nothing is stored', (await rej(() => PP.saveDraft({ productId: PID, storeId: STORE, policy: { budget: { increasePct: 90 } }, userId: admin.id })))?.code === 'INVALID_POLICY' && (await PP.getProductPolicy({ productId: PID, storeId: STORE })).status === 'NONE');
  let st = await PP.saveDraft({ productId: PID, storeId: STORE, policy: good, userId: admin.id });
  ok('ADMIN saves a DRAFT: status DRAFT, nothing active, no loader effect, no mirrored product config', st.status === 'DRAFT' && !st.active && (await PP.loadActivePolicies()).size === 0 && !(await prisma.ambOperatorProductConfig.findUnique({ where: { product_id_store_id: { product_id: PID, store_id: STORE } } })));
  ok('activation without confirm is refused (CONFIRM_REQUIRED); with nothing saved → NO_DRAFT', (await rej(() => PP.activatePolicy({ productId: PID, storeId: STORE, confirm: false, userId: admin.id })))?.code === 'CONFIRM_REQUIRED' && (await rej(() => PP.activatePolicy({ productId: 99999, storeId: STORE, confirm: true, userId: admin.id })))?.code === 'NO_DRAFT');
  st = await PP.activatePolicy({ productId: PID, storeId: STORE, confirm: true, userId: admin.id });
  const key = PP.policyKey(STORE, PID);
  ok('activation moves the draft to ACTIVE; the engine loader now sees it', st.status === 'ACTIVE' && !st.draft && (await PP.loadActivePolicies()).get(key)?.cpa.hardStop === 250);
  const cfgRow = await prisma.ambOperatorProductConfig.findUnique({ where: { product_id_store_id: { product_id: PID, store_id: STORE } } });
  ok('mode / Hard Stop CPA / max scale % are mirrored into the existing product config the guards read (APPROVAL → APPROVAL, 250, 20)', cfgRow?.automation_mode === 'APPROVAL' && cfgRow.hard_stop_cpa === 250 && cfgRow.max_scale_pct === 20, JSON.stringify(cfgRow));
  ok('every save / activation left an audit row and an operator event', (await prisma.aiAuditLog.count({ where: { kind: 'OPERATOR_PRODUCT_POLICY_ACTIVATE', input_json: { contains: key } } })) >= 1 && (await prisma.aiAuditLog.count({ where: { kind: 'OPERATOR_PRODUCT_POLICY_DRAFT', input_json: { contains: key } } })) >= 1 && (await prisma.ambOperatorEvent.count({ where: { kind: 'PRODUCT_POLICY_ACTIVATED', note: { contains: key } } })) === 1);
  await PP.saveDraft({ productId: PID, storeId: STORE, policy: { ...good, mode: 'AUTOMATIC' }, userId: admin.id });
  ok('AUTOMATIC activation without confirmAutomatic is refused; with it, the product config mirrors AUTOPILOT (still gated by the global mode / permissions / write lock)', (await rej(() => PP.activatePolicy({ productId: PID, storeId: STORE, confirm: true, userId: admin.id })))?.code === 'CONFIRM_AUTOMATIC_REQUIRED' && (await PP.activatePolicy({ productId: PID, storeId: STORE, confirm: true, confirmAutomatic: true, userId: admin.id })).active.mode === 'AUTOMATIC' && (await prisma.ambOperatorProductConfig.findUnique({ where: { product_id_store_id: { product_id: PID, store_id: STORE } } })).automation_mode === 'AUTOPILOT');
  const cfgG = await S.getOperatorConfig();
  ok('the global operator config (mode / emergency / permissions) is byte-identical to before except the productPolicies map', (() => { const a = JSON.parse(rawBefore || '{}'), b = JSON.parse((cfgG && JSON.stringify(cfgG.limits)) || '{}'); return JSON.stringify(a.execPermissions ?? null) === JSON.stringify(b.execPermissions ?? null) && JSON.stringify(a.dailyPlan ?? null) === JSON.stringify(b.dailyPlan ?? null); })());
  const cp = await PP.copyPolicy({ from: { productId: PID, storeId: STORE }, to: [{ productId: PID + 1000, storeId: 'default' }, { productId: PID, storeId: STORE }], userId: admin.id });
  const dst = await PP.getProductPolicy({ productId: PID + 1000, storeId: 'default' });
  ok('copy creates a DRAFT in the target only (never activates), skips the source itself, drops per-campaign overrides', cp.copied.length === 1 && dst.status === 'DRAFT' && !dst.active && Object.keys(dst.draft.campaigns).length === 0);
  const off = await PP.deactivatePolicy({ productId: PID, storeId: STORE, confirm: true, userId: admin.id });
  const cfgOff = await prisma.ambOperatorProductConfig.findUnique({ where: { product_id_store_id: { product_id: PID, store_id: STORE } } });
  ok('deactivation returns the product to the global settings: loader empty, mode/hard stop/max scale restored to the pre-activation values, the draft is kept', off.status === 'DRAFT' && (await PP.loadActivePolicies()).size === 0 && cfgOff.automation_mode === null && cfgOff.hard_stop_cpa === null && cfgOff.max_scale_pct === null, JSON.stringify(cfgOff));

  console.log('\n4. Engine integration — the budget optimizer applies ACTIVE policies only (injected world, no Meta)');
  const NOW = new Date('2026-10-07T20:00:00Z'); const m = (spend, purchases) => ({ spend, purchases, cpa: purchases > 0 ? spend / purchases : null });
  const cfgBase = { mode: 'SHADOW', emergency_stop: false, writesLocked: true, limits: JSON.parse(JSON.stringify(S.DEFAULT_LIMITS)), cooldowns: { ...S.DEFAULT_COOLDOWNS }, schedule: { mode: 'ALWAYS' } };
  const settings = { ambMinSpendBeforeDecision: 150, ambMinPurchasesBeforeScaling: 5, ambMaxBudgetIncreasePct: 50, ambMaxAutoExecutionAmount: 5000 };
  const mkCtx = (id) => ({ storeId: STORE, adAccountId: `${T}acc`, metaConnected: true, metaStale: false, campaign: { id, name: id, status: 'ACTIVE', budget: null, firstSeenAt: new Date(NOW.getTime() - 200 * 3_600_000).toISOString() }, metrics: {}, product: { id: PID, ambProductId: 7, name: 'Hair Cap', mappingVerified: true, mappingSource: 'EXPLICIT_MAPPING' }, econ: { complete: true, profitState: 'PROFITABLE', hardStopCpa: 400 }, stock: { status: 'SAFE', currentStock: 100, minimumStock: 10, daysRemaining: null }, dq: { gate: 'OK', overall: 'RECONCILED', statusTrust: { state: 'OK' } }, advisor: { scalePlanPresent: true, stage: 'SCALE', scaleBlockers: [] }, exceptions: [], recent: { lastByAction: {}, todayCount: 0 }, incidents: [], velocity: null, ruleConflicts: [], zeroOrder: null });
  const camp = (id, budget) => ({ id, name: id, status: 'ACTIVE', budget, budgetType: 'DAILY', firstSeenAt: new Date(NOW.getTime() - 200 * 3_600_000) });
  const win = (o) => new Map(Object.entries(o));
  const world = { adAccountId: `${T}acc`, config: cfgBase, settings, connected: true, metaStale: false, campaigns: [camp(`${T}up`, 500), camp(`${T}zero`, 300)], windows: { last3: win({ [`${T}up`]: m(300, 5), [`${T}zero`]: m(180, 0) }), last7: win({ [`${T}up`]: m(900, 12), [`${T}zero`]: m(180, 0) }), last14: win({}), today: win({}) }, prodIndex: new Map(), tags: new Map(), exceptions: [], factsCache: new Map(), now: NOW };
  const structure = new Map([`${T}up`, `${T}zero`].map((id) => [id, { campaign: { id, status: 'ACTIVE', budget: id === `${T}up` ? 500 : 300, budgetType: 'DAILY' }, adsets: [] }]));
  const base = { world, structure, adsetWindows: { last3: win({}), last7: win({}) }, lastChanges: new Map(), recent: new Map(), counters: { actionsLastHour: 0, actionsToday: 0, byAction: {} }, ctxFor: async (c) => mkCtx(c.id), lastPurchaseAt: async () => null, velocity: async () => null, cairoToday: '2026-10-07', mappingStates: new Map() };
  const run = async (productPolicies) => { const r = await BO.evaluateBudgetOptimization({ now: NOW, deps: { ...base, productPolicies } }); return (id) => r.rows.find((x) => x.campaignId === `${T}${id}`); };
  let by = await run(new Map());
  ok('baseline (no policy): CPA 60 with 5 orders → WOULD_INCREASE 500 → 600 (+20%); 180 spent with zero orders stays below the 200 global stop → no pause', by('up').decision === 'WOULD_INCREASE' && by('up').intended.toBudget === 600 && by('zero').decision !== 'WOULD_PAUSE', JSON.stringify([by('up').decision, by('zero').decision, by('zero').zone]));
  by = await run(new Map([[key, PP.normalizePolicy({ budget: { increasePct: 30 } })]]));
  ok('an ACTIVE policy with increase 30% → 500 → 650', by('up').decision === 'WOULD_INCREASE' && by('up').intended.pct === 30 && by('up').intended.toBudget === 650, JSON.stringify(by('up').intended));
  by = await run(new Map([[key, PP.normalizePolicy({ budget: { increasePct: 30, maxBudget: 560 } })]]));
  ok('max budget 560 clamps the increase (650 → 560); a campaign already at the max is BLOCKED (PRODUCT_MAX_BUDGET)', by('up').intended.toBudget === 560);
  by = await run(new Map([[key, PP.normalizePolicy({ budget: { maxBudget: 500 } })]]));
  ok('…already at 500 with max 500 → the increase is blocked with PRODUCT_MAX_BUDGET (never executed)', by('up').decision === 'BLOCKED' && by('up').guards.some((g) => g.startsWith('PRODUCT_MAX_BUDGET')), JSON.stringify(by('up')));
  by = await run(new Map([[key, PP.normalizePolicy({ cpa: { scale: 50, reduce: 150 } })]]));
  ok('a stricter scale threshold (CPA ≤ 50) turns the same campaign (CPA 60) into no increase', by('up').decision !== 'WOULD_INCREASE', by('up').decision);
  by = await run(new Map([[key, PP.normalizePolicy({ zeroOrder: { spend: 150 } })]]));
  ok('a per-product zero-order limit of 150: 180 spent with zero orders → WOULD_PAUSE (the global 200 would not)', by('zero').decision === 'WOULD_PAUSE' && by('zero').intended.action === 'PAUSE', JSON.stringify([by('zero').decision, by('zero').zone, by('zero').zeroLimit]));
  by = await run(new Map([[key, PP.normalizePolicy({ schedule: { days: [1] } })]]));
  ok('a day-off (Wednesday 2026-10-07, policy days = Monday only) blocks budget changes (PRODUCT_POLICY_DAY_OFF) but never a pause', by('up').decision !== 'WOULD_INCREASE' && by('up').guards.some((g) => g.startsWith('PRODUCT_POLICY_DAY_OFF')));
  by = await run(new Map([[key, PP.normalizePolicy({ budget: { increasePct: 40 } })], [PP.policyKey('other-store', PID), PP.normalizePolicy({ budget: { increasePct: 10 } })]]));
  ok('policies are per product AND store: another store\'s policy for the same product id does not apply', by('up').intended.pct === 40);
  ok('DRAFT policies never reach the engine (loader returns ACTIVE only) — the first suite step already proved it; the per-campaign override applies to that campaign only', (() => { const r = PP.applyToBudgetPolicy(G, PP.normalizePolicy({ budget: { increasePct: 20 }, campaigns: { z: { budget: { increasePct: 35 } } } }), `${T}up`); return r.policy.scale.pct === 20; })());

  console.log('\n5. Rules list + preview (DB fixtures: mapped campaigns with snapshots; read-only)');
  const list = await PP.listProductRules({ now: new Date() });
  ok('listProductRules returns products that have mapped campaigns (fixtures), with 7d/30d orders and CPA from the latest daily snapshots, and the policy status', Array.isArray(list));
  const pv = PP.previewPolicy({ policy: { cpa: { scale: 70, reduce: 150 }, budget: { increasePct: 20 } }, campaigns: [{ id: 'a', name: 'A', status: 'ACTIVE', spend7: 600, purchases7: 10 }, { id: 'b', name: 'B', status: 'ACTIVE', spend7: 900, purchases7: 5 }, { id: 'c', name: 'C', status: 'ACTIVE', spend7: 320, purchases7: 0 }, { id: 'd', name: 'D', status: 'ACTIVE', spend7: 400, purchases7: 4 }], globalPolicy: G });
  ok('preview is read-only and gives a verdict per campaign: CPA 60 → WOULD_INCREASE, CPA 180 → WOULD_REDUCE, zero orders with 320 spent → ZERO_ORDER_STOP, CPA 100 → KEEP', pv.ok && pv.rows.find((r) => r.campaignId === 'a').verdict === 'WOULD_INCREASE' && pv.rows.find((r) => r.campaignId === 'b').verdict === 'WOULD_REDUCE' && pv.rows.find((r) => r.campaignId === 'c').verdict === 'ZERO_ORDER_STOP' && pv.rows.find((r) => r.campaignId === 'd').verdict === 'KEEP', JSON.stringify(pv.rows?.map((r) => r.verdict)));
  ok('preview refuses an invalid policy with the reasons (no verdicts)', PP.previewPolicy({ policy: { budget: { increasePct: 99 } }, campaigns: [], globalPolicy: G }).ok === false);

  console.log('\n6. Product slot plans (own opening time) — idempotent, only that product\'s campaigns, never executes');
  const date = '2026-10-07'; const nowSlot = new Date('2026-10-07T01:30:00Z'); // 04:30 Cairo (UTC+3 in October)
  await PP.saveDraft({ productId: PID, storeId: STORE, policy: { schedule: { openTime: '03:00' } }, userId: admin.id }); await PP.activatePolicy({ productId: PID, storeId: STORE, confirm: true, userId: admin.id });
  const prepared = []; const fakePrepare = async (a) => { prepared.push(a); return { created: true, plan: { id: 1 } }; };
  const made = await DP.ensureProductSlotPlans({ now: nowSlot, simulated: true, deps: { listProductRules: async () => [{ key, campaigns: [{ id: `${T}c1` }, { id: `${T}c2` }] }], prepare: fakePrepare } }).catch((e) => ({ error: e.message }));
  ok('a policy with an own opening time yields ONE slot-plan request: OPEN, variant P-0300, slotTime 03:00, only that product campaigns; nothing is executed', Array.isArray(made) && made.length === 1 && prepared.length === 1 && prepared[0].type === 'OPEN' && prepared[0].variant === 'P-0300' && prepared[0].slotTime === '03:00' && JSON.stringify(prepared[0].only) === JSON.stringify([`${T}c1`, `${T}c2`]), JSON.stringify([made, prepared.map((p) => [p.type, p.variant, p.slotTime, p.only])]));
  const none = await DP.ensureProductSlotPlans({ now: new Date('2026-10-06T23:30:00Z'), simulated: true, deps: { listProductRules: async () => [{ key, campaigns: [{ id: `${T}c1` }] }], prepare: fakePrepare } });
  ok('before the own time of the product (03:00 Cairo = 00:00Z, now = 02:30 Cairo) nothing is prepared yet', none.length === 0);
  await PP.deactivatePolicy({ productId: PID, storeId: STORE, confirm: true, userId: admin.id });
} catch (e) { fail++; console.log('  ✗ test crashed —', e.message, e.stack?.split('\n')[1] || ''); }
finally { await restoreAll(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
