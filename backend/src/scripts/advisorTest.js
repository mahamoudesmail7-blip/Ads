// 🧠 Smart Advisor regression (2026-10-02). Part A = pure (composePlan across the product states, judgeOutcome,
// confounders, hashing, decay). Part B = DB-backed on DISPOSABLE products/stores (cleaned up) with an injected
// metrics provider — no Meta/Easy Orders call, no real task execution.
//   node src/scripts/advisorTest.js
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); } };

const { prisma } = await imp('../prisma.js');
const P = await imp('../services/amb/advisorPlan.js');
const T = await imp('../services/amb/advisorTracking.js');

const settings = { ambDefaultTargetCpa: 120, ambMinSpendBeforeDecision: 150, ambMinPurchasesBeforeScaling: 5, ambAdvisorImprovePct: 10, ambAdvisorWorsePct: 15, ambAdvisorHarmfulCpaPct: 25, ambAdvisorStopAfterFailedAttempts: 3, ambAdvisorStopCpaMultiplier: 1.5 };
const metrics = (o = {}) => ({ totalSpend: 800, metaPurchases: 12, avgCpa: 200, cpm: 40, ctr: 1.2, cpc: 3, cvr: 3, ...o });
function mk(o = {}) {
  const pkg = { decision: 'KEEP_TESTING', confidence: 'MEDIUM', dataQuality: { status: 'VERIFIED', criticalFailures: [] }, health: { band: 'NEEDS_ATTENTION' }, winners: {}, businessConversionRate: { value: 4 }, priceTestOpportunity: { detected: false },
    diagnosis: { bottleneck: { category: 'CPA_PROBLEM', confidence: 'LIKELY', evidence: 'x' }, metrics: metrics(o.metrics) }, creativeIntel: {}, ...(o.pkg || {}) };
  if (!o.pkg?.diagnosis) pkg.diagnosis = { bottleneck: { category: 'CPA_PROBLEM', confidence: 'LIKELY', evidence: 'x' }, metrics: metrics(o.metrics) };
  if (o.bottleneck) pkg.diagnosis.bottleneck = { confidence: 'LIKELY', evidence: 'e', ...o.bottleneck };
  return { productId: 1, productName: 'منتج تجريبي', storeId: 's', windowName: 'last7', settings, pkg, matrix: [], growth: { whatIsWorking: [], whatIsNotWorking: [], whatShouldRemainUnchanged: [], nextTest: { candidates: [] }, ...(o.growth || {}) },
    ladder: o.ladder || { stage: 'TESTING' }, profit: o.profit || { state: 'PROFITABLE', configState: 'KNOWN' }, stock: o.stock || { status: 'SAFE' }, cod: o.cod || { productLevel: { orders: 30, confirmationRate: 0.8, deliveryRate: 0.7 }, codBlocksScale: false },
    fatigueStates: o.fatigue || [], actionPlan: o.actionPlan || { winningStack: {} }, incidents: [], learning: o.learning || { entries: [] },
    dq: o.dq || { ok: true, overallStatus: 'RECONCILED', age: { status: 'OK' }, gender: { status: 'OK' }, region: { status: 'UNAVAILABLE' }, campaignPurchases: { status: 'OK' }, mapping: { status: 'OK', includedCampaignIds: ['c1'] } },
    priorRecs: o.priorRecs || [], competitor: [], productRow: { selling_price: 300 } };
}

console.log('§1 composePlan — product states produce DIFFERENT, evidence-based plans:');
const states = {};
states.insufficient = P.composePlan(mk({ metrics: { totalSpend: 40, metaPurchases: 0, avgCpa: null }, bottleneck: { category: 'INSUFFICIENT_DATA' }, pkg: { decision: 'INSUFFICIENT_DATA' } }));
states.ctr = P.composePlan(mk({ bottleneck: { category: 'CREATIVE_PROBLEM' }, metrics: { ctr: 0.6 } }));
states.conversion = P.composePlan(mk({ bottleneck: { category: 'CONVERSION_PROBLEM' }, metrics: { ctr: 3, cvr: 1 } }));
states.highCpa = P.composePlan(mk({ bottleneck: { category: 'CPA_PROBLEM' }, metrics: { ctr: 1.5, cvr: 3, cpc: 3, avgCpa: 220 } }));
states.fatigue = P.composePlan(mk({ bottleneck: { category: 'CREATIVE_FATIGUE' }, fatigue: ['FATIGUED'], ladder: { stage: 'FATIGUE' } }));
states.cod = P.composePlan(mk({ bottleneck: { category: 'CONFIRMATION_PROBLEM' }, cod: { productLevel: { orders: 40, confirmationRate: 0.4, deliveryRate: 0.5 }, codBlocksScale: true }, metrics: { avgCpa: 90 } }));
states.noEconomics = P.composePlan(mk({ bottleneck: { category: 'HEALTHY_PRODUCT' }, pkg: { health: { band: 'GOOD' } }, profit: { state: 'PARTIAL_DATA', configState: 'NOT_CONFIGURED' }, metrics: { avgCpa: 80 } }));
states.dqBlocked = P.composePlan(mk({ pkg: { dataQuality: { status: 'DECISION_BLOCKED_DATA_QUALITY', criticalFailures: [{ message: 'ربط ناقص' }] } } }));
states.winner = P.composePlan(mk({ bottleneck: { category: 'HEALTHY_PRODUCT' }, pkg: { decision: 'SCALE_CANDIDATE', health: { band: 'GOOD' } }, ladder: { stage: 'VALIDATED' }, metrics: { avgCpa: 70, metaPurchases: 30, totalSpend: 2100 } }));
states.scaling = P.composePlan(mk({ bottleneck: { category: 'HEALTHY_PRODUCT' }, pkg: { decision: 'SCALE_CANDIDATE', health: { band: 'GOOD' } }, ladder: { stage: 'STABLE' }, metrics: { avgCpa: 70, metaPurchases: 30, totalSpend: 2100 } }));
const failedRec = { recommendation_id: 'r1', action_key: 'HOOK|hook|CURIOSITY', verdict: 'FAILED', status: 'EVALUATED', title: 'hook' };
states.failedRec = P.composePlan(mk({ bottleneck: { category: 'CREATIVE_PROBLEM' }, metrics: { ctr: 0.6 }, priorRecs: [failedRec] }));
const okRec = { recommendation_id: 'r2', action_key: 'x', verdict: 'VALIDATED', status: 'EVALUATED', title: 'ok', rec_type: 'HOOK', learning_json: null, evaluated_at: new Date() };
states.okRec = T.annotatePlan(P.composePlan(mk({ priorRecs: [okRec] })), { priorRecs: [okRec], learning: { entries: [] } });
const notExec = [{ recommendation_id: 'r3', action_key: 'y', verdict: null, status: 'RECOMMENDED', title: 'n', rec_type: 'HOOK' }, { recommendation_id: 'r4', action_key: 'z', verdict: 'MEASURING', status: 'MEASURING', title: 'm', rec_type: 'HOOK' }];
states.notExecuted = T.annotatePlan(P.composePlan(mk({ priorRecs: notExec })), { priorRecs: notExec, learning: { entries: [] } });

ok('insufficient data -> primary INSUFFICIENT_DATA, "⏳ لسه بنجمع بيانات" plan, ZERO optimisation actions', states.insufficient.status.primaryProblem === 'INSUFFICIENT_DATA' && !!states.insufficient.insufficientPlan && states.insufficient.actions.now.length === 0);
ok('insufficient data -> executive tells the owner not to change anything', /لسه بنجمع بيانات/.test(states.insufficient.executive) && /متغيّرش/.test(states.insufficient.executive));
ok('CTR problem -> hook action and every new hook direction is HYPOTHESIS — NOT WINNER YET', states.ctr.status.primaryProblem === 'CTR_PROBLEM' && states.ctr.actions.now[0]?.recType === 'HOOK' && states.ctr.hooks.newDirections.length > 0 && states.ctr.hooks.newDirections.every((h) => /HYPOTHESIS/.test(h.badge)));
ok('conversion problem -> names CVR and does NOT blame targeting', states.conversion.status.primaryProblem === 'CONVERSION_PROBLEM' && /CVR/.test(states.conversion.executive) && states.conversion.offerPage.relevant);
ok('high CPA with good CTR and weak CVR is reframed as conversion (symptom vs root cause)', P.composePlan(mk({ bottleneck: { category: 'CPA_PROBLEM' }, metrics: { ctr: 3, cvr: 1, avgCpa: 220 } })).status.primaryProblem === 'CONVERSION_PROBLEM');
ok('high CPA (undetermined cause) stays CPA_PROBLEM', states.highCpa.status.primaryProblem === 'CPA_PROBLEM');
ok('fatigue flag with STRONG CTR and weak CVR is reframed as a conversion problem (fatigue stays secondary)', (() => { const p = P.composePlan(mk({ bottleneck: { category: 'CREATIVE_FATIGUE' }, fatigue: ['FATIGUED'], metrics: { ctr: 5, cvr: 0.9 } })); return p.status.primaryProblem === 'CONVERSION_PROBLEM' && !p.fatiguePlan && p.notWorking.some((x) => x.problem === 'CREATIVE_FATIGUE'); })());
ok('fatigue -> stage FATIGUED + fatigue plan "المنتج مش المشكلة"', states.fatigue.status.stage === 'FATIGUED' && /المنتج مش المشكلة/.test(states.fatigue.fatiguePlan.statement));
ok('poor COD -> "المشكلة تشغيلية وليست إعلانية", HUMAN-owned COD action, Scale NOT proposed', states.cod.status.primaryProblem === 'COD_PROBLEM' && /تشغيلية وليست إعلانية/.test(states.cod.executive) && states.cod.actions.now[0].owner === 'HUMAN' && !states.cod.actions.now.some((a) => a.recType === 'SCALE'));
ok('missing economics -> profit UNKNOWN (not inferred) + "ضبط التكاليف" action', /UNKNOWN/.test(states.noEconomics.profit.note) && [...states.noEconomics.actions.now, ...states.noEconomics.actions.next].some((a) => /ضبط التكاليف/.test(a.title)));
ok('DQ blocked -> P0 is "إصلاح/انتظار البيانات" and NO test/hook/scale action is offered', states.dqBlocked.status.dataQuality.blocked && states.dqBlocked.actions.now.length === 1 && states.dqBlocked.actions.now[0].recType === 'DATA_FIX' && states.dqBlocked.actions.now[0].priority === 'P0' && !!states.dqBlocked.nextTest.none);
ok('winner -> WINNER stage, Scale plan with rollback + prepare_scale tool (still approval-gated)', states.winner.status.stage === 'WINNER' && !!states.winner.scalePlan?.rollback && states.winner.actions.now.some((a) => a.recType === 'SCALE' && a.tool?.name === 'prepare_scale'));
ok('scaling product -> SCALING stage', states.scaling.status.stage === 'SCALING');
ok('failed recommendation is NOT blindly repeated (HOOK CURIOSITY dropped from directions)', !states.failedRec.hooks.newDirections.some((h) => h.key === 'CURIOSITY'));
ok('successful recommendation appears in product memory with its verdict', states.okRec.memory.triedBefore.some((m) => m.verdict === 'VALIDATED'));
ok('NOT executed / still MEASURING recommendations are never presented as results', states.notExecuted.memory.triedBefore.length === 0);
const distinct = new Set(Object.values(states).map((p) => `${p.status.stage}|${p.status.primaryProblem}`));
ok('plans differ across states (not one generic template)', distinct.size >= 8, String(distinct.size));
ok('at most 3 NOW actions everywhere; every action has WHAT/WHY/HOW/STAYS-FIXED/SUCCESS/CHECKPOINT', Object.values(states).every((p) => p.actions.now.length <= 3 && [...p.actions.now, ...p.actions.next].every((a) => a.what && a.why && a.how && Array.isArray(a.staysFixed) && a.successMetric && a.failureCriteria && a.checkpoint)));
ok('state hash is deterministic', P.composePlan(mk({ bottleneck: { category: 'CREATIVE_PROBLEM' }, metrics: { ctr: 0.6 } })).stateHash === states.ctr.stateHash);
ok('state hash changes when the primary problem changes', states.ctr.stateHash !== states.conversion.stateHash);
ok('state hash ignores small metric noise (no version churn on ordinary syncs)', P.composePlan(mk({ bottleneck: { category: 'CREATIVE_PROBLEM' }, metrics: { ctr: 0.62, totalSpend: 830 } })).stateHash === states.ctr.stateHash);
const dqAudience = P.composePlan(mk({ bottleneck: { category: 'CPA_PROBLEM' }, dq: { ok: true, overallStatus: 'WARNING', age: { status: 'UNAVAILABLE' }, gender: { status: 'MISMATCH' }, region: { status: 'UNAVAILABLE' }, campaignPurchases: { status: 'OK' }, mapping: { status: 'OK', includedCampaignIds: ['c1'] } }, growth: { nextTest: { candidates: [{ dimension: 'AUDIENCE', key: '25-34' }] } } }));
ok('age/gender with bad Data Quality are EXCLUDED from decisions (never guessed)', dqAudience.audience.age.decision === 'EXCLUDED' && dqAudience.audience.gender.decision === 'EXCLUDED');
ok('an AUDIENCE test resting on an excluded age slice is dropped', dqAudience.nextTest.none === true || dqAudience.nextTest.variable !== 'AUDIENCE');
const stackPlan = P.composePlan(mk({ bottleneck: { category: 'HEALTHY_PRODUCT' }, actionPlan: { winningStack: { age: { targeting: { status: 'EARLY_SIGNAL', value: '25-34' }, observation: null } } } }));
ok('early-signal audience -> DO_NOT_NARROW', stackPlan.audience.age.decision === 'DO_NOT_NARROW');
const contra = T.annotatePlan(P.composePlan(mk({ bottleneck: { category: 'CREATIVE_PROBLEM' }, metrics: { ctr: 0.6 } })), { priorRecs: [], learning: { entries: [{ dimension: 'HOOK', key: 'PROBLEM_SOLUTION', verdict: 'DOES_NOT_WORK', state: 'REJECTED' }] } });
ok('an action contradicting a failed learning is flagged or already filtered', contra.contradictions.some((c) => /تعارض/.test(c.label)) || !contra.actions.now.some((a) => a.actionKey.endsWith('PROBLEM_SOLUTION')));
const recovery = P.composePlan(mk({ bottleneck: { category: 'CREATIVE_PROBLEM' }, metrics: { ctr: 0.6, avgCpa: 400 }, priorRecs: [1, 2, 3].map((i) => ({ recommendation_id: 'f' + i, action_key: 'k' + i, verdict: 'FAILED', status: 'EVALUATED', title: 't' })) }));
ok('Recovery plan has attempts + STOP condition and STOP triggers after 3 failed attempts with CPA > 1.5× target', !!recovery.recoveryPlan && /180/.test(recovery.recoveryPlan.stopCondition) && recovery.recoveryPlan.stopTriggered === true, JSON.stringify(recovery.recoveryPlan?.stopCondition));

console.log('\n§2 judgeOutcome — verdict engine (pure):');
const succ = (o = {}) => ({ primaryMetric: 'cpa', direction: 'DOWN', guardrails: ['ctr', 'confirmationRate'], minSpend: 150, minPurchases: 5, evaluationWindowDays: 7, ...o });
const base = { metrics: { spend: 500, purchases: 8, cpa: 100, ctr: 1.5, cvr: 3, confirmationRate: 0.8 } };
const post = (o = {}) => ({ spend: 600, purchases: 12, cpa: 80, ctr: 1.6, cvr: 3.5, confirmationRate: 0.8, ...o });
const valid = { valid: true };
const J = (o) => T.judgeOutcome({ success: succ(), recType: 'AUDIENCE', baseline: base, post: post(), dataState: valid, confounders: [], settings, elapsedDays: 5, ...o });
let r = J({ post: post({ spend: 100, purchases: 1 }), elapsedDays: 2 });
ok('insufficient sample -> MEASURING, not final (no verdict invented)', r.final === false && r.verdict === 'MEASURING');
r = J({ post: post({ spend: 100, purchases: 1 }), elapsedDays: 15 });
ok('sample never reached by window end -> final INCONCLUSIVE', r.final && r.verdict === 'INCONCLUSIVE');
r = J({ post: post({ spend: 400, purchases: 11 }), dataState: { valid: false, reason: 'STALE' }, elapsedDays: 3 });
ok('stale/mismatched post data -> WAITING_FOR_VALID_DATA, no verdict', r.final === false && r.state === 'WAITING_FOR_VALID_DATA');
r = J({ post: post({ spend: 400, purchases: 11 }) });
ok('strong sample + CPA improved + guardrails OK -> VALIDATED (before/after evidence kind stated)', r.final && r.verdict === 'VALIDATED' && r.evidenceKind === 'BEFORE_AFTER');
r = J({ post: post({ spend: 200, purchases: 6, cpa: 85 }) });
ok('weak sample but improved -> IMPROVED (not "validated")', r.verdict === 'IMPROVED');
r = J({ success: succ({ primaryMetric: 'ctr', direction: 'UP', guardrails: ['cpa', 'confirmationRate'] }), recType: 'HOOK', post: post({ ctr: 2.4, cpa: 118 }) });
ok('GUARDRAIL: CTR up but CPA worse -> NOT validated (PARTIAL)', r.verdict === 'PARTIAL' && r.guardrails.some((g) => g.metric === 'cpa' && g.status === 'FAILED'));
r = J({ success: succ({ primaryMetric: 'ctr', direction: 'UP', guardrails: ['cpa'] }), recType: 'HOOK', post: post({ ctr: 2.4, cpa: 140 }) });
ok('GUARDRAIL: CTR up but CPA +40% -> FAILED', r.verdict === 'FAILED');
r = J({ success: succ({ primaryMetric: 'ctr', direction: 'UP', guardrails: ['confirmationRate'] }), recType: 'HOOK', post: post({ ctr: 2.4, confirmationRate: 0.5 }) });
ok('GUARDRAIL: CTR up but COD confirmation collapsed -> PARTIAL', r.verdict === 'PARTIAL');
r = J({ post: post({ cpa: 135 }) });
ok('CPA worse by 35% -> HARMFUL', r.verdict === 'HARMFUL');
r = J({ post: post({ cpa: 105 }) });
ok('CPA essentially flat -> never VALIDATED/IMPROVED', !['VALIDATED', 'IMPROVED'].includes(r.verdict), r.verdict);
r = J({ confounders: [{ kind: 'PRICE_CHANGED', major: true, note: 'السعر اتغيّر' }] });
ok('CONFOUNDED: price changed during the window -> INCONCLUSIVE/CONFOUNDED, no causal credit', r.verdict === 'INCONCLUSIVE' && r.state === 'CONFOUNDED');
r = J({ control: { cpa: 120, ctr: 1.5, confirmationRate: 0.8 }, confounders: [{ kind: 'PRICE_CHANGED', major: true, note: 'x' }], post: post({ cpa: 80, spend: 400, purchases: 11 }) });
ok('CONTROL vs VARIANT beats confounding: VALIDATED with evidenceKind CONTROLLED_TEST', r.verdict === 'VALIDATED' && r.evidenceKind === 'CONTROLLED_TEST', JSON.stringify(r));
r = J({ baseline: { metrics: { spend: 0, purchases: 0, cpa: null } } });
ok('missing baseline metric -> INCONCLUSIVE (never fabricates a comparison)', r.verdict === 'INCONCLUSIVE');
ok('detectConfounders: price change is major, except when PRICE is the tested variable', T.detectConfounders({ recType: 'HOOK', baselineCtx: { price: 100 }, currentCtx: { price: 120 } }).some((c) => c.major) && !T.detectConfounders({ recType: 'PRICE', baselineCtx: { price: 100 }, currentCtx: { price: 120 } }).length);
ok('detectConfounders: a peer recommendation executed in the same window is major', T.detectConfounders({ recType: 'HOOK', baselineCtx: {}, currentCtx: {}, peers: [{ title: 'x' }] }).some((c) => c.kind === 'PEER_RECOMMENDATION_EXECUTED' && c.major));
ok('learning decay: PROVEN older than 45d -> NEEDS_REVALIDATION; fresh stays PROVEN', T.learningState({ state: 'PROVEN', lastValidatedAt: new Date(Date.now() - 60 * 864e5).toISOString() }).state === 'NEEDS_REVALIDATION' && T.learningState({ state: 'PROVEN', lastValidatedAt: new Date().toISOString() }).state === 'PROVEN');

// ============================ Part B — DB-backed, disposable ============================
console.log('\n§3 DB-backed lifecycle on disposable products (cleaned up):');
const STORE = 'advisor-test-store', OTHER = 'advisor-other-store';
// leftovers from a previously crashed run (disposable stores only) are removed first
{
  const old = await prisma.product.findMany({ where: { store_id: { in: [STORE, OTHER] } }, select: { id: true } });
  const oldIds = old.map((x) => x.id);
  if (oldIds.length) {
    const op = await prisma.productMarketingProfile.findMany({ where: { product_id: { in: oldIds } }, select: { id: true } });
    await prisma.productMarketingLearning.deleteMany({ where: { profile_id: { in: op.map((x) => x.id) } } });
    await prisma.ambAdvisorRecommendation.deleteMany({ where: { product_id: { in: oldIds } } });
    await prisma.ambAdvisorPlanVersion.deleteMany({ where: { product_id: { in: oldIds } } });
    await prisma.productMarketingProfile.deleteMany({ where: { id: { in: op.map((x) => x.id) } } });
    await prisma.product.deleteMany({ where: { id: { in: oldIds } } });
  }
}
const user = await prisma.user.findFirst({ select: { id: true } });
const prod = await prisma.product.create({ data: { product_name: '__advisor_test_product__', store_id: STORE, selling_price: 300 } });
const prod2 = await prisma.product.create({ data: { product_name: '__advisor_test_product_2__', store_id: OTHER, selling_price: 100 } });
const profile = await prisma.productMarketingProfile.create({ data: { product_id: prod.id, source: 'MANUAL_UPLOAD', locked_name: '__advisor_test_product__' } });
const profile2 = await prisma.productMarketingProfile.create({ data: { product_id: prod2.id, source: 'MANUAL_UPLOAD', locked_name: '__advisor_test_product_2__' } });
const taskIds = [];
const cleanup = async () => {
  const recs = await prisma.ambAdvisorRecommendation.findMany({ where: { product_id: { in: [prod.id, prod2.id] } }, select: { recommendation_id: true } });
  await prisma.ambAlert.deleteMany({ where: { dedupe_key: { in: recs.map((x) => `advisor:${x.recommendation_id}:final`) } } }).catch(() => {});
  await prisma.productMarketingLearning.deleteMany({ where: { profile_id: { in: [profile.id, profile2.id] } } }).catch(() => {});
  await prisma.assistantTask.deleteMany({ where: { task_uuid: { in: taskIds } } }).catch(() => {});
  await prisma.ambAdvisorRecommendation.deleteMany({ where: { product_id: { in: [prod.id, prod2.id] } } }).catch(() => {});
  await prisma.ambAdvisorPlanVersion.deleteMany({ where: { product_id: { in: [prod.id, prod2.id] } } }).catch(() => {});
  await prisma.productMarketingProfile.deleteMany({ where: { id: { in: [profile.id, profile2.id] } } }).catch(() => {});
  await prisma.product.deleteMany({ where: { id: { in: [prod.id, prod2.id] } } }).catch(() => {});
};
try {
  const mkInputs = (price = 300) => ({ ...mk({ bottleneck: { category: 'CREATIVE_PROBLEM' }, metrics: { ctr: 0.6 } }), productId: prod.id, storeId: STORE, productRow: { selling_price: price } });
  const inputs1 = mkInputs();
  const plan1 = P.composePlan(inputs1);
  const hookKey = plan1.trackableActions.find((a) => a.recType === 'HOOK')?.actionKey;
  ok('plan exposes a trackable HOOK action', !!hookKey, JSON.stringify(plan1.trackableActions.map((a) => a.actionKey)));
  const s1 = await T.syncRecommendations({ plan: plan1, inputs: inputs1 });
  ok('RECOMMENDED recommendation created with a stable recommendationId on the action', s1.created.length >= 1 && plan1.trackableActions.every((a) => a.recommendationId?.startsWith('adv_')));
  const s1b = await T.syncRecommendations({ plan: P.composePlan(inputs1), inputs: inputs1 });
  ok('idempotent: re-syncing the same plan creates no duplicate recommendations', s1b.created.length === 0 && s1b.expired.length === 0);
  const rec1 = await prisma.ambAdvisorRecommendation.findFirst({ where: { product_id: prod.id, action_key: hookKey } });
  ok('success criteria defined BEFORE execution (primary metric + guardrails + min sample)', (() => { const s = JSON.parse(rec1.success_json); return s.primaryMetric === 'ctr' && s.guardrails.includes('cpa') && s.minSpend === 150; })());
  ok('rec starts RECOMMENDED with no baseline and no verdict (never credited early)', rec1.status === 'RECOMMENDED' && !rec1.baseline_frozen_at && !rec1.verdict);

  const inputs2 = mkInputs(450);
  const s2 = await T.syncRecommendations({ plan: P.composePlan(inputs2), inputs: inputs2 });
  const expiredRec = await prisma.ambAdvisorRecommendation.findUnique({ where: { id: rec1.id } });
  ok('price changed -> un-executed recommendation EXPIRED with a reason, and a fresh one issued', expiredRec.status === 'EXPIRED' && /السعر/.test(expiredRec.expired_reason || '') && s2.created.length >= 1, String(expiredRec.expired_reason));
  const rec2 = await prisma.ambAdvisorRecommendation.findFirst({ where: { product_id: prod.id, action_key: hookKey, status: 'RECOMMENDED' } });

  const mkTask = async (status, extra = {}) => { const t = await prisma.assistantTask.create({ data: { user_id: user.id, kind: 'TEST_CAMPAIGN', tool_name: 'prepare_test', status, input_json: '{}', ...extra } }); taskIds.push(t.task_uuid); return t; };
  const task1 = await mkTask('WAITING_FOR_APPROVAL');
  const base1 = { capturedAt: new Date().toISOString(), window: { from: '2026-09-20', to: '2026-09-26' }, metrics: { spend: 500, purchases: 8, cpa: 100, ctr: 1.0, cvr: 3, confirmationRate: 0.8 }, context: { storeId: STORE, price: 450, stock: 'SAFE', campaignIds: ['c1'] } };
  const l1 = await T.linkTaskToRecommendation({ recommendationId: rec2.recommendation_id, task: task1, captureBaseline: async () => base1 });
  const afterLink = await prisma.ambAdvisorRecommendation.findUnique({ where: { id: rec2.id } });
  ok('linking a prepared task -> PREPARED and baseline FROZEN before execution', l1.ok && afterLink.status === 'PREPARED' && !!afterLink.baseline_frozen_at && JSON.parse(afterLink.baseline_json).metrics.ctr === 1.0);
  await T.linkTaskToRecommendation({ recommendationId: rec2.recommendation_id, task: task1, captureBaseline: async () => ({ ...base1, metrics: { ...base1.metrics, ctr: 9.9 } }) });
  ok('baseline is NEVER rewritten by a second link', JSON.parse((await prisma.ambAdvisorRecommendation.findUnique({ where: { id: rec2.id } })).baseline_json).metrics.ctr === 1.0);
  const linkedTask = await prisma.assistantTask.findUnique({ where: { task_uuid: task1.task_uuid } });
  ok('task input_json carries the stable recommendationId (traceability)', JSON.parse(linkedTask.input_json).advisorRecommendationId === rec2.recommendation_id);

  const e0 = await T.evaluateRecommendation(rec2.recommendation_id, { provider: async () => { throw new Error('must not be called'); } });
  ok('NOT executed -> evaluation skipped (no result credited to an unexecuted recommendation)', e0.skipped === 'NOT_EXECUTED');
  await prisma.assistantTask.update({ where: { task_uuid: task1.task_uuid }, data: { approved_at: new Date(), status: 'RUNNING' } });
  const synced = await T.syncRecLifecycle(await prisma.ambAdvisorRecommendation.findUnique({ where: { id: rec2.id } }));
  ok('approved + running -> APPROVED (still not executed)', synced.status === 'APPROVED' && !synced.executed_at);
  await prisma.assistantTask.update({ where: { task_uuid: task1.task_uuid }, data: { status: 'COMPLETED' } });

  const insuff = async () => ({ post: { spend: 80, purchases: 1, ctr: 1.5, cpa: 90, confirmationRate: 0.8 }, dataState: { valid: true }, context: base1.context });
  const m1 = await T.evaluateRecommendation(rec2.recommendation_id, { provider: insuff });
  const mrec = await prisma.ambAdvisorRecommendation.findUnique({ where: { id: rec2.id } });
  ok('EXECUTED + small sample -> MEASURING (no outcome, no evaluation_key, no learning)', m1.finalized === false && mrec.status === 'MEASURING' && !mrec.evaluation_key && !!mrec.executed_at, JSON.stringify(m1));
  const stale = async () => ({ post: { spend: 500, purchases: 9, ctr: 1.6, cpa: 90 }, dataState: { valid: false, reason: 'STALE' }, context: base1.context });
  const m2 = await T.evaluateRecommendation(rec2.recommendation_id, { provider: stale });
  ok('stale post-action data -> WAITING_FOR_VALID_DATA, still MEASURING', m2.state === 'WAITING_FOR_VALID_DATA' && (await prisma.ambAdvisorRecommendation.findUnique({ where: { id: rec2.id } })).status === 'MEASURING');
  const good = async () => ({ post: { spend: 400, purchases: 9, ctr: 1.6, cpa: 90, confirmationRate: 0.8 }, dataState: { valid: true }, context: base1.context });
  const [f1, f2] = await Promise.all([T.evaluateRecommendation(rec2.recommendation_id, { provider: good }), T.evaluateRecommendation(rec2.recommendation_id, { provider: good })]);
  ok('CONCURRENT evaluations produce exactly ONE outcome', [f1, f2].filter((x) => x.finalized).length === 1, JSON.stringify([f1, f2]));
  const done = await prisma.ambAdvisorRecommendation.findUnique({ where: { id: rec2.id } });
  ok('verdict VALIDATED persisted with evaluation_key, evidence kind and causal wording', done.status === 'EVALUATED' && done.verdict === 'VALIDATED' && !!done.evaluation_key && !!JSON.parse(done.evaluation_json).causalClaim, String(done.verdict));
  const again = await T.evaluateRecommendation(rec2.recommendation_id, { provider: good });
  ok('re-evaluating a finished recommendation is a no-op', again.skipped === 'ALREADY_FINAL');
  const alerts = await prisma.ambAlert.count({ where: { dedupe_key: `advisor:${rec2.recommendation_id}:final` } });
  ok('exactly one alert for the verdict (no duplicates)', alerts === 1, String(alerts));
  const learn = await prisma.productMarketingLearning.findMany({ where: { profile_id: profile.id } });
  ok('VALIDATED verdict persisted as product learning (WORKS) with evidence', learn.length === 1 && learn[0].verdict === 'WORKS' && JSON.parse(learn[0].evidence_json).source === 'SMART_ADVISOR', JSON.stringify(learn));
  ok('no cross-product learning leakage (other product profile untouched)', (await prisma.productMarketingLearning.count({ where: { profile_id: profile2.id } })) === 0);
  ok('learning_json records lastValidatedAt/evidenceWindow/sampleStrength for decay', (() => { const l = JSON.parse(done.learning_json || '{}'); return !!l.lastValidatedAt && !!l.evidenceWindow && !!l.sampleStrength; })());

  // cancelled task -> NOT_EXECUTED
  const plan3 = P.composePlan({ ...mk({ bottleneck: { category: 'CONVERSION_PROBLEM' }, metrics: { ctr: 3, cvr: 1 }, growth: { nextTest: { candidates: [{ dimension: 'GEO', key: 'القاهرة' }] } } }), productId: prod.id, storeId: STORE });
  await T.syncRecommendations({ plan: plan3, inputs: { ...mkInputs(450) } });
  const geoRec = await prisma.ambAdvisorRecommendation.findFirst({ where: { product_id: prod.id, status: 'RECOMMENDED', rec_type: 'GEO' } });
  if (geoRec) {
    const t = await mkTask('WAITING_FOR_APPROVAL');
    await T.linkTaskToRecommendation({ recommendationId: geoRec.recommendation_id, task: t, captureBaseline: async () => base1 });
    await prisma.assistantTask.update({ where: { task_uuid: t.task_uuid }, data: { status: 'CANCELLED' } });
    const c = await T.syncRecLifecycle(await prisma.ambAdvisorRecommendation.findUnique({ where: { id: geoRec.id } }));
    ok('task CANCELLED -> recommendation CANCELLED / NOT_EXECUTED (no credit taken)', c.status === 'CANCELLED' && c.verdict === 'NOT_EXECUTED');
  } else ok('GEO rec created for the cancellation test', false, JSON.stringify(plan3.trackableActions.map((a) => a.actionKey)));

  // manual (human-owned) execution path
  const offerPlan = P.composePlan({ ...mk({ bottleneck: { category: 'CONVERSION_PROBLEM' }, metrics: { ctr: 3, cvr: 1 } }), productId: prod.id, storeId: STORE });
  await T.syncRecommendations({ plan: offerPlan, inputs: { ...mkInputs(450) } });
  const offerRec = await prisma.ambAdvisorRecommendation.findFirst({ where: { product_id: prod.id, status: 'RECOMMENDED', rec_type: 'OFFER' } });
  if (offerRec) {
    const noStart = await T.confirmManualExecution({ recommendationId: offerRec.recommendation_id, storeId: STORE });
    ok('manual: cannot be marked executed before it was started (no baseline = no credit)', noStart.ok === false && noStart.code === 'NOT_STARTED');
    ok('manual: wrong store cannot start it', (await T.startManualExecution({ recommendationId: offerRec.recommendation_id, storeId: OTHER })).ok === false);
    const st = await T.startManualExecution({ recommendationId: offerRec.recommendation_id, storeId: STORE, captureBaseline: async () => base1 });
    const afterStart = await prisma.ambAdvisorRecommendation.findUnique({ where: { id: offerRec.id } });
    ok('manual: start freezes the baseline BEFORE the change and moves to PREPARED', st.ok && afterStart.status === 'PREPARED' && !!afterStart.baseline_frozen_at && !afterStart.executed_at);
    const dn = await T.confirmManualExecution({ recommendationId: offerRec.recommendation_id, storeId: STORE, note: 'غيّرت العرض' });
    const afterDone = await prisma.ambAdvisorRecommendation.findUnique({ where: { id: offerRec.id } });
    ok('manual: confirming execution sets EXECUTED + executed_at (measurement starts now)', dn.ok && afterDone.status === 'EXECUTED' && !!afterDone.executed_at);
    ok('manual: a second confirmation is refused', (await T.confirmManualExecution({ recommendationId: offerRec.recommendation_id, storeId: STORE })).ok === false);
  } else ok('OFFER rec created for the manual-execution test', false, JSON.stringify(offerPlan.trackableActions.map((q) => q.actionKey)));

  // confounded: two recs executed in the same window
  const mkExecuted = (recType, title, key) => prisma.ambAdvisorRecommendation.create({ data: { recommendation_id: `adv_t_${key}`, product_id: prod.id, store_id: STORE, plan_version: 1, action_key: `${recType}|${key}|x`, rec_type: recType, title, success_json: JSON.stringify(succ({ primaryMetric: 'ctr', direction: 'UP', guardrails: [] })), context_json: JSON.stringify({ target: key }), status: 'EXECUTED', executed_at: new Date(Date.now() - 2 * 864e5), baseline_json: JSON.stringify(base1), baseline_frozen_at: new Date() } });
  const ca = await mkExecuted('HOOK', 'A', 'ca'); await mkExecuted('CREATIVE', 'B', 'cb');
  const cr = await T.evaluateRecommendation(ca.recommendation_id, { provider: good });
  ok('CONFOUNDED: two recommendations executed together -> INCONCLUSIVE (CONFOUNDED), never "validated"', cr.verdict === 'INCONCLUSIVE' && cr.state === 'CONFOUNDED', JSON.stringify(cr));

  // failed-recommendation memory
  const failedAk = 'HOOK|hook|MEMTEST';
  const ctxA = { storeId: STORE, productId: prod.id, productRow: { selling_price: 300 }, stock: { status: 'SAFE' }, dq: { mapping: { includedCampaignIds: ['c1'] } }, pkg: { dataQuality: { status: 'VERIFIED' }, winners: {} }, profit: { configState: 'KNOWN' } };
  const hashSame = crypto.createHash('sha1').update(JSON.stringify(T.buildContext(ctxA))).digest('hex').slice(0, 16);
  await prisma.ambAdvisorRecommendation.create({ data: { recommendation_id: 'adv_t_failed', product_id: prod.id, store_id: STORE, plan_version: 1, action_key: failedAk, rec_type: 'HOOK', title: 'f', success_json: '{}', status: 'EVALUATED', verdict: 'FAILED', context_hash: hashSame } });
  const fakePlan = { trackableActions: [{ actionKey: failedAk, recType: 'HOOK', title: 'f', success: succ(), evidence: [], sources: [] }], actions: { now: [], next: [], later: [] }, status: { primaryProblem: 'CTR_PROBLEM', dataQuality: { gate: 'VERIFIED', overall: 'RECONCILED', blocked: false } } };
  const sf = await T.syncRecommendations({ plan: fakePlan, inputs: ctxA });
  ok('failed recommendation is NOT re-issued while context is unchanged (withheld with reason)', sf.created.length === 0 && sf.withheld.length === 1, JSON.stringify(sf.withheld));
  const sf2 = await T.syncRecommendations({ plan: { ...fakePlan, actions: { now: [], next: [], later: [] } }, inputs: { ...ctxA, productRow: { selling_price: 999 } } });
  ok('...but IS re-issued once the context changed (a new reason exists)', sf2.created.length === 1);

  // store isolation
  const hOther = await T.getAdvisorHistory({ productId: prod.id, storeId: OTHER });
  ok('store isolation: history for the wrong store is empty', hOther.recommendations.length === 0);
  const hOk = await T.getAdvisorHistory({ productId: prod.id, storeId: STORE });
  ok('history groups problem -> fix -> result and marks legacy history untracked', hOk.recommendations.length > 0 && hOk.problems.length > 0 && hOk.legacy.state === 'LEGACY_HISTORY_UNTRACKED');
  ok('cancel with the wrong store is refused', (await T.cancelRecommendation({ recommendationId: 'adv_t_failed', storeId: OTHER })).ok === false);
  ok('resolveAdvisorLink refuses a recommendation from another store/product', (await T.resolveAdvisorLink({ context: { recommendationId: sf2.open?.[0]?.recommendation_id, storeId: OTHER }, productId: prod.id })) === null && (await T.resolveAdvisorLink({ context: { recommendationId: sf2.open?.[0]?.recommendation_id, storeId: STORE }, productId: prod2.id })) === null);
  const gi = await P.gatherAdvisorInputs({ productId: prod.id, storeId: OTHER });
  ok('gatherAdvisorInputs refuses a cross-store request (STORE_CONTEXT_REQUIRED)', gi.ok === false && gi.code === 'STORE_CONTEXT_REQUIRED');
  const rel = await T.getAdvisorReliability({ storeId: STORE });
  ok('reliability: per-type breakdown, NO global accuracy % on a tiny sample', rel.byType.length >= 1 && rel.summary.hitRate === null && /عينة غير كافية/.test(rel.summary.hitRateNote));

  // plan versioning
  const pv = { productId: prod.id, storeId: STORE, stateHash: 'h1', status: { stage: 'LEARNING', primaryProblem: 'CPA_PROBLEM', dataQuality: {} }, actions: { now: [] }, sampleSufficient: true, profit: {}, cod: {}, trackableActions: [] };
  const v1 = await T.persistPlanVersion({ plan: pv }); const v1b = await T.persistPlanVersion({ plan: pv });
  const v2 = await T.persistPlanVersion({ plan: { ...pv, stateHash: 'h2', status: { stage: 'WINNER', primaryProblem: 'NONE', dataQuality: {} } } });
  ok('plan versions: same state -> no new version; meaningful change -> v+1 with change reasons', v1.created && !v1b.created && v2.created && v2.version === v1.version + 1 && v2.reasons.some((x) => /المرحلة/.test(x)), JSON.stringify({ v1, v1b, v2 }));
} finally { await cleanup(); }

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
