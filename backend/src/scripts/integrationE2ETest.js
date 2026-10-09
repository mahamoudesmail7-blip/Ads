// 🔗 End-to-End: the AI Operator features are ONE system. Journey on the isolated Neon TEST database with a Meta MOCK (no Meta call anywhere):
//   add product → Smart Pricing → save policy → enable APPROVAL → prepare campaigns by CPA → edit selections → approve → mock execution → read-back verification → history + alert.
// Plus: a policy change while a plan is pending, conflicting schedules, Meta failures, restart. Disposable data: plans dated 2031-07-xx, one fixture product, ids prefixed "__optest_".
//   node src/scripts/integrationE2ETest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
process.env.DAILY_PLAN_ALLOW_TEST_CLOCK = '1'; delete process.env.DAILY_PLAN_DISABLE_ALERTS; // alerts ON: failures must reach the alert center
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };
const { prisma } = await imp('../prisma.js');
const TM = await imp('../services/amb/dailyPlanTime.js'); const DP = await imp('../services/amb/dailyPlans.js'); const OC = await imp('../services/amb/openCpaPolicy.js'); const SP = await imp('../services/amb/smartPricing.js');
const PP = await imp('../services/amb/productPolicy.js'); const AMBP = await imp('../services/amb/ambProducts.js'); const INT = await imp('../services/amb/integration.js'); const EH = await imp('../services/amb/executionHistory.js'); const ME = await imp('../services/amb/metricsEngine.js');
const BE = await imp('../services/amb/budgetExecution.js'); const CB = await imp('../services/amb/campaignBoard.js');
const T = '__optest_'; const STORE = 'e2e-store'; const ADMIN_ID = (await prisma.user.findFirst({ where: { role: 'ADMIN', status: 'ACTIVE' } }))?.id ?? 1; const ADMIN = { id: ADMIN_ID, role: 'ADMIN', status: 'ACTIVE' };
const cfg0 = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const limits0 = cfg0.limits_json; const c0 = { actions: await prisma.ambAction.count() };
const FRESH = { syncStatus: async () => ({ lastSuccessAt: new Date() }), refresh: async () => ({ ok: true }) };
const dcfg0 = await DP.getDailyPlanConfig(); const DC_OFF = { ...dcfg0, halted: false, scheduledExecution: { enabled: false } }; const DC_ON = { ...dcfg0, halted: false, scheduledExecution: { enabled: true } };
const OPEN_PERMS = { open: true, pause: true, budgetIncrease: true, budgetDecrease: true };
const cfgOf = (o = {}) => ({ mode: 'APPROVAL', emergency_stop: false, writesLocked: false, execPermissions: OPEN_PERMS, limits: {}, ...o }); // a MOCK config: nothing here changes the real operator config
let execCalls = 0, failMode = {};
const readPaused = async (id) => { if (failMode.readThrows?.includes(id)) throw new Error('Meta is down (mock)'); return { id, status: 'PAUSED', budget: 300 }; };
const mockExec = async ({ recId, mode }) => { execCalls++; const rec = await prisma.ambRecommendation.findUnique({ where: { id: recId } }); const bad = failMode.execFails?.includes(rec.entity_id); const unverified = failMode.unverified?.includes(rec.entity_id);
  const a = await prisma.ambAction.create({ data: { recommendation_id: rec.id, mode, action_type: rec.action_type, ad_account_id: rec.ad_account_id, level: rec.level, entity_id: rec.entity_id, entity_name: rec.entity_name, campaign_id: rec.campaign_id, ai_reason: rec.reason, approval_status: 'APPROVED', execution_status: bad ? 'FAILED' : 'EXECUTED', executed_by_id: null, executed_at: new Date(), meta_request_json: JSON.stringify({ id: rec.entity_id }), meta_error: bad ? 'Meta rejected (mock)' : null, verify_json: bad ? null : JSON.stringify({ verified: !unverified, observed: unverified ? 'PAUSED' : 'ACTIVE' }) } });
  if (bad) throw Object.assign(new Error('Meta rejected (mock)'), { actionId: a.id }); await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'EXECUTED' } }); return { ok: true, actionId: a.id }; };
const D0 = () => ({ ...FRESH, user: ADMIN, runInline: true, exceptions: async () => [], lastPurchase: async () => null, mappingState: async () => null, sleep: async () => {}, readEntity: readPaused, approveAndExecute: mockExec, readBack: async () => ({ status: 'PAUSED' }) });
const get = (id) => prisma.ambDailyPlan.findUnique({ where: { id }, include: { items: { orderBy: { rank: 'asc' } } } });
const planIds = []; let dayN = 0; const nextDate = () => `2031-07-${String(++dayN).padStart(2, '0')}`;
let PROD = null; const CAMPS = ['A', 'B', 'C', 'D', 'E', 'F']; // A,B,C in range; D too expensive; E no orders; F in range but guard-blocked
const M = new Map([['A', { spend: 800, purchases: 10 }], ['B', { spend: 1200, purchases: 12 }], ['C', { spend: 1000, purchases: 10 }], ['D', { spend: 2000, purchases: 10 }], ['E', { spend: 300, purchases: 0 }], ['F', { spend: 900, purchases: 9 }]].map(([n, m]) => [`${T}${n}`, m]));
const mkItem = (n, o = {}) => ({ campaignId: `${T}${n}`, campaignName: `${T}camp ${n}`, productId: PROD?.id ?? null, productName: 'E2E Product', storeId: STORE, rank: 1, selected: false, selectable: true, eligibility: 'ELIGIBLE', blockCodes: [], warnings: [], risk: 'LOW', riskScore: 10, reason: 'fixture', evidence: { mapping: 'VERIFIED', budget: 300, budgetLevel: 'CBO', status: 'PAUSED', stock: { status: 'IN_STOCK' } }, ...o });
const itemsOf = (names = CAMPS) => names.map((n, i) => mkItem(n, { rank: i + 1, ...(n === 'F' ? { eligibility: 'BLOCKED', selectable: false, blockCodes: ['MANUAL_OVERRIDE_COOLDOWN'] } : {}) }));
const mkPlan = async ({ type = 'OPEN', date, items = itemsOf(), now }) => { const p = (await DP.preparePlan({ type, date, now: now || new Date(TM.dueAt(type, date).getTime() + 60_000), simulated: false, deps: { ...FRESH, build: async () => ({ items, policy: null }) } })).plan; planIds.push(p.id); return p; };
const sel = async (id) => (await get(id)).items.filter((i) => i.selected).map((i) => i.campaign_id.replace(T, '')).sort();
const dueNow = (d, type = 'OPEN') => new Date(TM.dueAt(type, d).getTime() + 60_000);
const resetCfg = async () => { const r = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const l = JSON.parse(r.limits_json || '{}'); delete l.openCpa; delete l.pricing; if (l.productPolicies) for (const k of Object.keys(l.productPolicies)) if (k.startsWith(`${STORE}:`)) delete l.productPolicies[k]; await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify(l) } }); };
// a previous run that was killed (e.g. a Neon connection stall) may have left its disposable plans behind — start from a clean slate
{ const old = await prisma.ambDailyPlan.findMany({ where: { plan_date: { startsWith: '2031-07-' } }, select: { id: true } }); const oldIds = old.map((p) => p.id);
  if (oldIds.length) { const rs = await prisma.ambRecommendation.findMany({ where: { batch_id: { in: oldIds.map((id) => `daily-plan-${id}`) } }, select: { id: true } }); await prisma.ambActionResult.deleteMany({ where: { action: { recommendation_id: { in: rs.map((r) => r.id) } } } }).catch(() => {}); await prisma.ambAction.deleteMany({ where: { recommendation_id: { in: rs.map((r) => r.id) } } }).catch(() => {}); await prisma.ambRecommendation.deleteMany({ where: { id: { in: rs.map((r) => r.id) } } }).catch(() => {}); await prisma.ambDailyPlan.deleteMany({ where: { id: { in: oldIds } } }).catch(() => {}); }
  await prisma.ambOperatorDecision.deleteMany({ where: { decision_key: { startsWith: '__optest_' } } }).catch(() => {}); }
await resetCfg();
try {
  console.log('\nSTEP 1 — add a product');
  PROD = await prisma.product.create({ data: { product_name: `${T}E2E Product`, store_id: STORE, active: true } }); const amb = await AMBP.createFromCatalogProduct(PROD.id, ADMIN_ID);
  ok('the product exists in the catalog with an economics record (nothing assumed: cost 0, no CPA limits)', !!PROD.id && amb.productId === PROD.id && !(amb.productCost > 0) && !(amb.targetCpa > 0), JSON.stringify([amb.productCost, amb.targetCpa]));

  console.log('\nSTEP 2 — Smart Pricing (suggest only) → rules');
  const EX = { wholesale: 200, shipping: 50, other: 0, expectedCpa: 100, multiplier: 3, markupPct: 85 };
  const c = SP.computePricing(EX); ok('suggested price 1,017.50 (landed 250 · reserve 300 · reference 550 · markup 467.50)', c.steps.suggested === 1017.5 && c.steps.landed === 250 && c.steps.adReserve === 300);
  await SP.savePricingDraft({ productId: PROD.id, storeId: STORE, inputs: EX, userId: ADMIN_ID, deps: { user: ADMIN } }); const appr = await SP.approvePrice({ productId: PROD.id, storeId: STORE, inputs: EX, price: 1017.5, confirm: true, userId: ADMIN_ID, deps: { user: ADMIN } });
  ok('approving the price is recorded inside the Operator only — the product price is untouched', appr.approved.appliedToStore === false && !((await prisma.ambProduct.findUnique({ where: { product_id: PROD.id } })).actual_selling_price > 0));
  const prev = await SP.previewApplyToRules({ productId: PROD.id, storeId: STORE, inputs: EX, PP }); ok('"use pricing in the product rules" is a preview first; hard stop / target CPA are OFF by default', prev.ok && prev.changes.filter((x) => ['target_cpa', 'policy.cpa.hardStop'].includes(x.field)).every((x) => !x.defaultOn));
  await SP.applyToRules({ productId: PROD.id, storeId: STORE, inputs: EX, fields: ['product_cost', 'shipping_cost', 'other_cost', 'target_cpa', 'policy.cpa.hardStop'], confirm: true, userId: ADMIN_ID, PP, ambProducts: AMBP, deps: { user: ADMIN } });
  const ambA = await prisma.ambProduct.findUnique({ where: { product_id: PROD.id } }); const polD = await PP.getProductPolicy({ productId: PROD.id, storeId: STORE });
  ok('only the TICKED fields were saved: economics + target CPA 100; hard stop landed in a policy DRAFT (not active)', ambA.product_cost === 200 && ambA.shipping_cost === 50 && ambA.target_cpa === 100 && polD.draft?.cpa?.hardStop === 767.5 && polD.status === 'DRAFT' && !polD.active);
  const rD = await INT.resolvePolicy({ productId: PROD.id, storeId: STORE, deps: { config: cfgOf() } });
  ok('a DRAFT is not applied anywhere: the unified policy ignores it (no active product policy, draft flagged)', rD.hasActiveProductPolicy === false && rD.draftIgnored === true && rD.effective.cpa.hardStop === null && rD.policyRef.productPolicy.status === 'DRAFT');

  console.log('\nSTEP 3 — save the product policy → enable APPROVAL (one versioned source)');
  await PP.saveDraft({ productId: PROD.id, storeId: STORE, policy: { mode: 'APPROVAL', cpa: { normalMin: 50, normalMax: 150, scale: 80, reduce: 150, hardStop: 200 }, budget: { increasePct: 15, decreasePct: 40, minPurchases: 3, cooldownHours: 24 }, zeroOrder: { spend: 200 } }, userId: ADMIN_ID, deps: { user: ADMIN } });
  const stillDraft = await INT.resolvePolicy({ productId: PROD.id, storeId: STORE, deps: { config: cfgOf() } }); ok('saving the draft does NOT activate it', stillDraft.hasActiveProductPolicy === false);
  const act = await PP.activatePolicy({ productId: PROD.id, storeId: STORE, confirm: true, userId: ADMIN_ID, deps: { user: ADMIN, noReconcile: true } });
  const rA = await INT.resolvePolicy({ productId: PROD.id, storeId: STORE, deps: { config: cfgOf({ limits: { maxDecreasePct: 25 } }) } });
  ok('activated: ONE unified view with the policy VERSION and the effective values (CPA zones, %, cooldown, hard stop)', act.status === 'ACTIVE' && rA.hasActiveProductPolicy && rA.policyRef.productPolicy.version === act.version && rA.effective.cpa.hardStop === 200 && rA.effective.budget.increasePct === 15 && rA.effective.budget.cooldownHours === 24 && rA.effective.mode === 'APPROVAL', JSON.stringify(rA.policyRef.productPolicy));
  ok('the product policy never loosens a GLOBAL Safety Guard: decrease 40% is clamped to the global 25%', rA.effective.budget.decreasePct === 25 && rA.guards.clamps.some((x) => x.field === 'decreasePct' && x.product === 40 && x.appliedGlobalLimit === 25), JSON.stringify(rA.guards.clamps));
  ok('precedence is explicit: Emergency Stop > Safety Guards > product policy > global budget policy', rA.guards.precedence[0] === 'EMERGENCY_STOP' && rA.guards.precedence[1] === 'GLOBAL_SAFETY_GUARDS');
  const mirror = await prisma.ambOperatorProductConfig.findUnique({ where: { product_id_store_id: { product_id: PROD.id, store_id: STORE } } }); ok('the mode / hard stop are mirrored into the guard inputs (APPROVAL, 200) — never AUTOMATIC', mirror?.automation_mode === 'APPROVAL' && mirror?.hard_stop_cpa === 200);

  console.log('\nSTEP 4 — «الفتح حسب CPA»: save the range, enable (opens nothing)');
  await OC.saveOpenCpaPolicy({ patch: { minCpa: 50, maxCpa: 150, window: '7' }, userId: ADMIN_ID, deps: { user: ADMIN } }); await OC.setOpenCpaEnabled({ enabled: true, confirm: true, userId: ADMIN_ID, deps: { user: ADMIN } });
  const pol = await OC.getOpenCpaPolicy(); const rO = await INT.resolvePolicy({ productId: PROD.id, storeId: STORE, deps: { config: cfgOf() } });
  ok('the SAME range is visible in the unified view the other screens read (v, window, limits)', pol.enabled && rO.effective.openCpa.min === 50 && rO.effective.openCpa.max === 150 && rO.policyRef.openCpa.version === pol.version);

  console.log('\nSTEP 5-6 — prepare matching campaigns, then edit the selection');
  const d1 = nextDate(); const p1 = await mkPlan({ date: d1 }); const dep = { ...D0(), openCpaMetrics: M };
  const prep = await DP.prepareOpenCpaMatches({ planId: p1.id, userId: ADMIN_ID, now: dueNow(d1), simulated: false, deps: dep });
  ok('prepared by the policy: A, B, C ticked; D too expensive, E no orders (unknown CPA), F guard-blocked', JSON.stringify(await sel(p1.id)) === JSON.stringify(['A', 'B', 'C']) && prep.counts.eligible === 3 && prep.counts.outOfRange === 1 && prep.counts.unknownCpa === 1 && prep.counts.excluded === 1, JSON.stringify(prep.counts));
  await DP.updateSelection({ planId: p1.id, selections: { [`${T}B`]: false }, userId: ADMIN_ID });
  ok('un-ticking B is the owner\'s decision and survives another «prepare»', JSON.stringify(await sel(p1.id)) === JSON.stringify(['A', 'C']) && !(await (async () => { await DP.prepareOpenCpaMatches({ planId: p1.id, userId: ADMIN_ID, now: dueNow(d1), simulated: false, deps: dep }); return (await sel(p1.id)).includes('B'); })()));

  console.log('\nSTEP 7-9 — approve → mock execution → read-back verification → history');
  const before = execCalls; const ap = await DP.approvePlan({ planId: p1.id, userId: ADMIN_ID, now: dueNow(d1), deps: { ...D0(), dcfg: DC_OFF, config: async () => cfgOf() } });
  const done = await get(p1.id); const doneItems = done.items.filter((i) => i.selected);
  ok('APPROVAL: the plan runs only the ticked campaigns (A, C) — each revalidated live, written once, read back → VERIFIED', ap.ok && done.status === 'COMPLETED' && done.execution_mode === 'LIVE' && done.approval_mode === 'APPROVAL' && doneItems.length === 2 && doneItems.every((i) => i.status === 'VERIFIED') && execCalls - before === 2, JSON.stringify([ap.status, done.status, doneItems.map((i) => i.status)]));
  ok('the un-ticked / excluded campaigns were never touched', done.items.filter((i) => !i.selected).every((i) => !i.status || i.status === 'PENDING'));
  const hist = await EH.listExecutionHistory({ limit: 20 }); const hrow = hist.rows.find((r) => r.campaignId === `${T}A`);
  ok('Execution History: the action shows its REASON, the Meta read-back (verified) and the final stage', !!hrow && hrow.final === 'VERIFIED' && hrow.verify?.verified === true && /Daily Plan/.test(hrow.reason || ''), JSON.stringify(hrow && [hrow.final, hrow.verify, hrow.reason]));
  ok('…and the POLICY VERSIONS it was decided under: product policy vN, open-by-CPA vN, the plan version', hrow.policyRef?.productPolicy?.version === act.version && hrow.policyRef?.openCpa?.version === pol.version && hrow.policyRef?.planId === p1.id && hrow.cpaPolicy?.verdict === 'ELIGIBLE', JSON.stringify(hrow.policyRef));
  ok('the whole run changed no real configuration: mode / permissions of the real operator config are as before', (await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } })).mode === cfg0.mode);

  console.log('\nSTEP 10 — failures reach the alert center and the history (Meta mock)');
  const d2 = nextDate(); const p2 = await mkPlan({ date: d2, items: itemsOf(['A', 'B', 'C']).map((i) => ({ ...i, selected: true })) });
  failMode = { readThrows: [`${T}A`], execFails: [`${T}B`], unverified: [`${T}C`] };
  await DP.approvePlan({ planId: p2.id, userId: ADMIN_ID, now: dueNow(d2), deps: { ...D0(), dcfg: DC_OFF, config: async () => cfgOf() } }); failMode = {};
  const f2 = await get(p2.id); const st = (n) => f2.items.find((i) => i.campaign_id === `${T}${n}`);
  ok('Meta unreachable → SKIPPED (nothing sent) with the reason', st('A').status === 'SKIPPED' && /META_UNAVAILABLE/.test(st('A').status_reason), JSON.stringify([st('A').status, st('A').status_reason]));
  ok('executor error after a request went out, read-back says unchanged → FAILED (no blind retry)', st('B').status === 'FAILED', JSON.stringify([st('B').status, st('B').status_reason]));
  ok('request sent but the read-back did not confirm → UNCERTAIN (never reported as success)', st('C').status === 'UNCERTAIN', JSON.stringify([st('C').status, st('C').status_reason]));
  const alerts = await prisma.ambAlert.findMany({ where: { dedupe_key: { startsWith: `dailyplan-item:OPEN|${d2}` } } });
  ok('every failure / uncertain / Meta-down state raised an ALERT (3 alerts, right severities)', alerts.length === 3 && alerts.some((a) => a.severity === 'CRITICAL') && alerts.filter((a) => a.severity === 'WARNING').length === 2, JSON.stringify(alerts.map((a) => [a.severity, a.dedupe_key.slice(-12)])));
  const h2 = await EH.listExecutionHistory({ limit: 30 }); ok('and the history shows FAILED / UNCERTAIN rows with their error', h2.rows.some((r) => r.campaignId === `${T}B` && r.final === 'FAILED' && r.error) && h2.rows.some((r) => r.campaignId === `${T}C` && r.final === 'UNCERTAIN'));
  ok('the plan summary counts them (nothing hidden)', JSON.parse(f2.summary_json).failed === 1 && JSON.parse(f2.summary_json).uncertain === 1 && JSON.parse(f2.summary_json).skipped === 1);

  console.log('\nSTEP 11 — a POLICY CHANGE while a plan is pending (nothing executes)');
  const d3 = nextDate(); const p3 = await mkPlan({ date: d3, now: new Date(TM.dueAt('OPEN', d3).getTime() - 30 * 60_000), items: itemsOf(['A', 'B', 'C']) });
  await DP.prepareOpenCpaMatches({ planId: p3.id, userId: ADMIN_ID, now: new Date(TM.dueAt('OPEN', d3).getTime() - 20 * 60_000), simulated: false, deps: dep });
  const approvedEarly = await DP.approvePlan({ planId: p3.id, userId: ADMIN_ID, now: new Date(TM.dueAt('OPEN', d3).getTime() - 10 * 60_000), deps: { ...D0(), dcfg: DC_ON, config: async () => cfgOf() } });
  ok('approved ahead of the open time (scheduled) — waiting', approvedEarly.ok && approvedEarly.scheduled === true && (await get(p3.id)).status === 'APPROVED');
  const mkDec = (n, o = {}) => prisma.ambOperatorDecision.create({ data: { decision_key: `${T}dec-${n}-${Date.now()}`, store_id: STORE, product_id: PROD.id, ad_account_id: 'act_e2e', campaign_id: `${T}${n}`, action: 'SCALE_UP', rule_name: 'DYNAMIC_BUDGET:DYN_SCALE', mode_at_decision: 'APPROVAL', status: 'PREPARED', params_json: JSON.stringify({ level: 'campaign', entityId: `${T}${n}`, fromBudget: 300, toBudget: 345, pct: 15 }), ...o } });
  const dPrep = await mkDec('A'); const dOther = await prisma.ambOperatorDecision.create({ data: { decision_key: `${T}dec-other-${Date.now()}`, store_id: 'other-store', product_id: PROD.id + 100000, ad_account_id: 'act_e2e', campaign_id: `${T}Z`, action: 'SCALE_UP', rule_name: 'DYNAMIC_BUDGET:DYN_SCALE', mode_at_decision: 'APPROVAL', status: 'PREPARED' } });
  const chg = await INT.onProductPolicyChanged({ productId: PROD.id, storeId: STORE, kind: 'DEACTIVATED', userId: ADMIN_ID, now: dueNow(d3), simulated: false, deps: { noAlerts: true } });
  const old3 = await get(p3.id); const next3 = await prisma.ambDailyPlan.findFirst({ where: { plan_key: p3.plan_key }, orderBy: { version: 'desc' }, include: { items: true } }); planIds.push(next3.id);
  ok('the approved plan is SUPERSEDED and a NEW PREPARED version needs a fresh approval; the product\'s campaigns are un-ticked and flagged', old3.status === 'SUPERSEDED' && next3.version === 2 && next3.status === 'PREPARED' && next3.approved_by_id === null && next3.items.every((i) => !i.selected) && next3.items.every((i) => JSON.parse(i.evidence_json).policyChanged), JSON.stringify(chg.plans));
  const runOld = await DP.runPlanExecution({ planId: p3.id, userId: ADMIN_ID, now: dueNow(d3), deps: { ...D0(), dcfg: DC_ON, config: async () => cfgOf() } }); ok('the superseded version can never run (no surprise execution at the open time)', runOld.skipped === 'NOT_CLAIMED');
  ok('pending budget decisions of that product are expired for re-evaluation; other products are untouched', (await prisma.ambOperatorDecision.findUnique({ where: { id: dPrep.id } })).status === 'EXPIRED' && /POLICY_CHANGED/.test((await prisma.ambOperatorDecision.findUnique({ where: { id: dPrep.id } })).error) && (await prisma.ambOperatorDecision.findUnique({ where: { id: dOther.id } })).status === 'PREPARED' && chg.decisionsExpired.length === 1);
  const viaPP = await PP.deactivatePolicy({ productId: PROD.id, storeId: STORE, confirm: true, userId: ADMIN_ID, deps: { user: ADMIN } });
  ok('deactivating through the policy screen triggers the same reconciliation automatically', viaPP.reconcile && viaPP.reconcile.kind === 'DEACTIVATED');
  await PP.activatePolicy({ productId: PROD.id, storeId: STORE, confirm: true, userId: ADMIN_ID, deps: { user: ADMIN, noReconcile: true } });

  console.log('\nSTEP 12 — conflicting schedules are blocked, never raced');
  const d4 = nextDate(); const po = await mkPlan({ type: 'OPEN', date: d4, items: itemsOf(['A', 'B']).map((i) => ({ ...i, selected: true })) }); const pp = await mkPlan({ type: 'PAUSE', date: d4, items: itemsOf(['A', 'C']).map((i) => ({ ...i, selected: true, evidence: { ...i.evidence, status: 'ACTIVE' } })), now: dueNow(d4, 'PAUSE') });
  const pause = async (id, d, ty) => DP.approvePlan({ planId: id, userId: ADMIN_ID, now: dueNow(d, ty), deps: { ...D0(), dcfg: DC_ON, config: async () => cfgOf(), readEntity: async (cid) => ({ id: cid, status: ty === 'OPEN' ? 'PAUSED' : 'ACTIVE', budget: 300 }) } });
  await DP.approvePlan({ planId: po.id, userId: ADMIN_ID, now: new Date(TM.dueAt('OPEN', d4).getTime() - 60_000), deps: { ...D0(), dcfg: DC_ON, config: async () => cfgOf() } });
  await DP.approvePlan({ planId: pp.id, userId: ADMIN_ID, now: new Date(TM.dueAt('PAUSE', d4).getTime() - 60_000), deps: { ...D0(), dcfg: DC_ON, config: async () => cfgOf() } });
  const confs = await INT.checkConflicts({ campaignId: `${T}A`, want: 'OPEN', now: dueNow(d4) });
  ok('open vs pause: the same campaign in two APPROVED plans is detected', confs.some((x) => x.code === 'CONFLICT_OPEN_AND_PAUSE'), JSON.stringify(confs));
  const runPause = await DP.runPlanExecution({ planId: pp.id, userId: ADMIN_ID, now: dueNow(d4, 'PAUSE'), deps: { ...D0(), dcfg: DC_ON, config: async () => cfgOf(), readEntity: async (cid) => ({ id: cid, status: 'ACTIVE', budget: 300 }) } }); const ppItems = await prisma.ambDailyPlanItem.findMany({ where: { plan_id: pp.id } });
  ok('at execution: the pause of A is BLOCKED (CONFLICT_OPEN_AND_PAUSE) while C (no conflict) proceeds', ppItems.find((i) => i.campaign_id === `${T}A`).status === 'BLOCKED' && /CONFLICT_OPEN_AND_PAUSE/.test(ppItems.find((i) => i.campaign_id === `${T}A`).status_reason) && ppItems.find((i) => i.campaign_id === `${T}C`).status === 'VERIFIED', JSON.stringify(ppItems.map((i) => [i.campaign_id.replace(T, ''), i.status, i.status_reason])));
  const dUp = await mkDec('B', { status: 'APPROVED' }); const wantDown = await INT.checkConflicts({ campaignId: `${T}B`, want: 'SCALE_DOWN', now: dueNow(d4) });
  ok('scale-up vs scale-down on the same campaign at the same time is detected', wantDown.some((x) => x.code === 'CONFLICT_BUDGET_UP_DOWN'));
  const budgetVsPlan = await INT.checkConflicts({ campaignId: `${T}B`, want: 'SCALE_UP', now: dueNow(d4) }); ok('a budget change on a campaign inside an approved plan queue is detected', budgetVsPlan.some((x) => x.code === 'CONFLICT_PLAN_QUEUE_BUDGET'));
  const dRun = await mkDec('C', { status: 'EXECUTING' }); const planWhileBudget = await INT.checkConflicts({ campaignId: `${T}C`, want: 'PAUSE', now: dueNow(d4) }); ok('an open/pause while a budget change is executing on that campaign is detected', planWhileBudget.some((x) => x.code === 'CONFLICT_BUDGET_IN_FLIGHT'));
  const dExec = await mkDec('B', { status: 'PREPARED' }); const ex = await BE.executeBudgetDecision({ decisionId: dExec.id, userId: ADMIN_ID, now: dueNow(d4), deps: { user: ADMIN, config: cfgOf() } });
  ok('the budget bridge refuses to execute against a conflict (BLOCKED at the gate, decision stays PREPARED/APPROVED, no Meta call)', ex.status === 'BLOCKED' && /CONFLICT/.test(ex.blocked || ''), JSON.stringify([ex.status, ex.blocked, ex.message]));

  console.log('\nSTEP 13 — identity, one definition of «today», restart');
  const idx = new Map([[`${T}A`, { ambProductId: amb.id, via: 'EXPLICIT_MAPPING', verified: true }], [`${T}Q`, { ambProductId: amb.id, via: 'SUGGESTED', verified: false }]]);
  const idA = await INT.campaignIdentity(`${T}A`, { adAccountId: 'act_e2e', deps: { index: idx } }); const idQ = await INT.campaignIdentity(`${T}Q`, { adAccountId: 'act_e2e', deps: { index: idx } }); const idNone = await INT.campaignIdentity(`${T}none`, { adAccountId: 'act_e2e', deps: { index: idx } });
  ok('a campaign resolves to its product + store with the mapping state (verified / suggested / unmapped)', idA.productId === PROD.id && idA.storeId === STORE && idA.verified === true && idQ.verified === false && idNone.productId === null && idNone.verified === false, JSON.stringify([idA, idQ.verified, idNone.verified]));
  const d5 = nextDate(); const p5 = await mkPlan({ date: d5, items: itemsOf(['A']).map((i) => ({ ...i, selected: true })) });
  await DP.approvePlan({ planId: p5.id, userId: ADMIN_ID, now: dueNow(d5), deps: { ...D0(), dcfg: DC_OFF, config: async () => cfgOf(), mappingState: async () => 'SUGGESTED' } });
  ok('an unverified campaign↔product mapping blocks execution (MAPPING_SUGGESTED)', (await get(p5.id)).items[0].status === 'BLOCKED' && /MAPPING_SUGGESTED/.test((await get(p5.id)).items[0].status_reason));
  ok('Today / 7D / 30D use ONE definition everywhere: the Cairo calendar day (00:30 Cairo is already the next day)', ME.todayISO(new Date('2026-10-08T21:30:00Z')) === '2026-10-09' && TM.cairoDate(new Date('2026-10-08T21:30:00Z')) === '2026-10-09' && CB.boardWindows('2026-10-09').today.from === '2026-10-09' && ME.resolveWindow('last7').to === ME.todayISO());
  const e1 = await DP.ensureDuePlans({ now: dueNow('2031-07-28'), simulated: false, deps: { ...FRESH, build: async () => ({ items: itemsOf(['A']), policy: null }) } }); for (const x of e1.prepared) planIds.push(x.planId); const e2 = await DP.ensureDuePlans({ now: dueNow('2031-07-28'), simulated: false, deps: { ...FRESH, build: async () => ({ items: itemsOf(['A']), policy: null }) } });
  ok('restart: the scheduler tick is idempotent (one plan per day/type), and finished plans cannot be executed again', e1.prepared.filter((p) => p.type === 'OPEN').length === 1 && e2.prepared.filter((p) => p.type === 'OPEN' && !p.surfacedOnly).length === 0 && (await DP.runPlanExecution({ planId: p1.id, userId: ADMIN_ID, now: dueNow(d1), deps: { ...D0(), dcfg: DC_OFF, config: async () => cfgOf() } })).skipped === 'NOT_CLAIMED');
  const polR = await OC.getOpenCpaPolicy(); const pR = await PP.getProductPolicy({ productId: PROD.id, storeId: STORE }); const stR = await SP.getPricingState({ productId: PROD.id, storeId: STORE });
  ok('restart: policies (open-by-CPA, product) and the pricing record are read back from the database with their versions', polR.version >= 1 && polR.enabled && pR.version >= 3 && stR.approved?.price === 1017.5);
  const health = await INT.integrationHealth({ now: dueNow(d4), simulated: false });
  ok('the health check reports each link (identity, freshness, Cairo, policies, open-by-CPA, pending plans, conflicts, failures, safety) (read-only)', ['identity', 'freshness', 'cairo', 'policies', 'openCpa', 'pendingPlans', 'conflicts', 'failures', 'safety'].every((k) => health.checks.some((c) => c.key === k)) && typeof health.checks.find((c) => c.key === 'conflicts').ok === 'boolean' && health.checks.find((c) => c.key === 'cairo').ok === true, JSON.stringify(health.checks.map((c) => [c.key, c.ok])));
  ok('the map exposes all 10 features and the links between them', INT.INTEGRATION_MAP.nodes.length >= 12 && ['pricing', 'rules', 'open', 'pause', 'up', 'down', 'scheduler', 'approvals', 'history', 'alerts'].every((id) => INT.INTEGRATION_MAP.nodes.some((n) => n.id === id)) && INT.INTEGRATION_MAP.edges.some(([a, b]) => a === 'pricing' && b === 'rules') && INT.INTEGRATION_MAP.edges.some(([a, b]) => a === 'history' && b === 'alerts'));
  ok('AUTOMATIC was never used and Meta was never called: every executor call was the mock; no real operator setting changed', execCalls > 0 && (await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } })).mode === cfg0.mode && (await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } })).emergency_stop === cfg0.emergency_stop);
} finally {
  const extra = await prisma.ambDailyPlan.findMany({ where: { plan_date: { startsWith: '2031-07-' } }, select: { id: true } }); const all = [...new Set([...planIds, ...extra.map((p) => p.id)])];
  const recs = await prisma.ambRecommendation.findMany({ where: { batch_id: { in: all.map((id) => `daily-plan-${id}`) } }, select: { id: true } });
  await prisma.ambActionResult.deleteMany({ where: { action: { recommendation_id: { in: recs.map((r) => r.id) } } } }).catch(() => {}); await prisma.ambAction.deleteMany({ where: { recommendation_id: { in: recs.map((r) => r.id) } } }).catch(() => {}); await prisma.ambRecommendation.deleteMany({ where: { id: { in: recs.map((r) => r.id) } } }).catch(() => {});
  for (const id of all) await prisma.ambOperatorEvent.deleteMany({ where: { data_json: { contains: `"planId":${id},` } } }).catch(() => {});
  await prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ campaign_id: { startsWith: T } }, { kind: { in: ['POLICY_CHANGE_RECONCILED', 'PRICING_DRAFT_SAVED', 'PRICING_APPROVED', 'PRICING_APPLIED_TO_RULES', 'PRODUCT_POLICY_SAVED', 'PRODUCT_POLICY_ACTIVATED', 'PRODUCT_POLICY_DEACTIVATED'] } }, { kind: { startsWith: 'OPEN_CPA_POLICY' } }] } }).catch(() => {});
  await prisma.ambOperatorDecision.deleteMany({ where: { decision_key: { startsWith: T } } }).catch(() => {}); await prisma.ambDailyPlan.deleteMany({ where: { id: { in: all } } }).catch(() => {});
  await prisma.ambAlert.deleteMany({ where: { OR: [{ dedupe_key: { startsWith: 'dailyplan' }, AND: [{ dedupe_key: { contains: '2031-07' } }] }, { dedupe_key: { startsWith: 'policychange:' } }] } }).catch(() => {});
  if (PROD) { await prisma.ambOperatorProductConfig.deleteMany({ where: { product_id: PROD.id } }).catch(() => {}); await prisma.ambProduct.deleteMany({ where: { product_id: PROD.id } }).catch(() => {}); await prisma.product.deleteMany({ where: { id: PROD.id } }).catch(() => {}); }
  await prisma.aiAuditLog.deleteMany({ where: { OR: [{ kind: { startsWith: 'OPEN_CPA_POLICY' } }, { kind: { startsWith: 'OPERATOR_PRICING' } }, { kind: { startsWith: 'OPERATOR_PRODUCT_POLICY' } }] } }).catch(() => {});
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: limits0 } }).catch(() => {}); await prisma.$disconnect();
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
