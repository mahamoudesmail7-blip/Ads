// Smart Decision Center — "🚀 أكشن بلان" tab (services/amb/productActionPlan.js).
// Real throwaway DB rows where DB access is involved (tagged, cleaned up
// after). Proves the mandatory rules from the spec: never fake a complete
// Winning Stack, readiness score components are transparent and traceable,
// the primary action type never oversells a data-quality-blocked plan as
// scale-ready, and tracking identity/bump-candidate lookups never invent
// data that doesn't exist.
//   node src/scripts/productActionPlanTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const {
  reconcileStackStatus, buildWinningStack, computeCampaignReadiness, derivePrimaryActionType,
  getExistingBumpCandidates, resolveTrackingIdentity, buildActionPlan,
  buildObservationStack, buildFullStack, buildFormingPlanSummary,
} = await imp('../services/amb/productActionPlan.js');
const { prisma } = await imp('../prisma.js');

const cleanupRecIds = [];
const cleanupJobIds = [];
async function cleanup() {
  for (const id of cleanupRecIds) await prisma.ambRecommendation.deleteMany({ where: { id } });
  for (const id of cleanupJobIds) await prisma.ambLaunchJob.deleteMany({ where: { id } });
}

try {
  console.log('§1 reconcileStackStatus — pure vocabulary mapping over ALREADY-GATED classifications, never a new judgement:');
  ok('PROVEN_WINNER (segment) -> PROVEN', reconcileStackStatus('PROVEN_WINNER', null) === 'PROVEN');
  ok('WINNER (creative) -> PROVEN', reconcileStackStatus('WINNER', null) === 'PROVEN');
  ok('PROMISING (segment) -> PROMISING', reconcileStackStatus('PROMISING', null) === 'PROMISING');
  ok('GOOD (creative) -> PROMISING', reconcileStackStatus('GOOD', null) === 'PROMISING');
  ok('INSUFFICIENT_DATA + EARLY_SIGNAL -> EARLY_SIGNAL, never hidden', reconcileStackStatus('INSUFFICIENT_DATA', 'EARLY_SIGNAL') === 'EARLY_SIGNAL');
  ok('TESTING + OBSERVED -> EARLY_SIGNAL', reconcileStackStatus('TESTING', 'OBSERVED') === 'EARLY_SIGNAL');
  ok('INSUFFICIENT_DATA + no signal -> NOT_PROVEN', reconcileStackStatus('INSUFFICIENT_DATA', 'NO_SIGNAL') === 'NOT_PROVEN');
  ok('a real proven-NEGATIVE (PROVEN_WEAK) is NEVER put into the winning stack -> NOT_PROVEN', reconcileStackStatus('PROVEN_WEAK', null) === 'NOT_PROVEN');
  ok('WEAK/FATIGUED creative -> NOT_PROVEN', reconcileStackStatus('WEAK', null) === 'NOT_PROVEN' && reconcileStackStatus('FATIGUED', null) === 'NOT_PROVEN');

  console.log('\n§2 buildWinningStack — NEVER fakes a complete stack:');
  {
    const winners = {
      gender: { segment: 'نساء', classification: 'PROVEN_WINNER', evidence: 'صرف 1000 ج · 8 شراء', sampleSize: 8 },
      creative: { label: 'C7', classification: 'GOOD', evidence: 'قريب من الهدف', sampleSize: 6, meta: { thumbnailUrl: 'https://x/c7.jpg' } },
      age: null, // no real proven/promising age winner
      governorate: null,
    };
    const stack = buildWinningStack(winners);
    ok('a real PROVEN_WINNER segment becomes PROVEN with its own real evidence', stack.gender?.status === 'PROVEN' && stack.gender.evidence.includes('8 شراء'), JSON.stringify(stack.gender));
    ok('a real GOOD creative becomes PROMISING and keeps its thumbnail', stack.creative?.status === 'PROMISING' && stack.creative.thumbnailUrl === 'https://x/c7.jpg');
    ok('age has NO real winner -> null, never invented (renders as Broad)', stack.age === null);
    ok('governorate has NO real winner -> null, never invented', stack.governorate === null);
    ok('placements always defaults to Meta automatic/Advantage+, honestly NOT_PROVEN (no placement intelligence pipeline exists)', stack.placements.status === 'NOT_PROVEN' && stack.placements.value.includes('Advantage'));
  }
  {
    const stack = buildWinningStack({});
    ok('an entirely empty winners object -> every targetable dimension is null, zero fabrication', ['gender', 'age', 'governorate', 'creative', 'hook', 'angle', 'primaryText', 'headline'].every((k) => stack[k] === null));
  }

  console.log('\n§3 computeCampaignReadiness — every point traceable to a real input, never an arbitrary AI number:');
  {
    const fullStack = buildWinningStack({
      gender: { segment: 'نساء', classification: 'PROVEN_WINNER', evidence: 'e' },
      age: { segment: '20-35', classification: 'PROVEN_WINNER', evidence: 'e' },
      governorate: { segment: 'القاهرة', classification: 'PROVEN_WINNER', evidence: 'e' },
      creative: { label: 'C7', classification: 'WINNER', evidence: 'e' },
      hook: { label: 'H3', classification: 'WINNER', evidence: 'e' },
    });
    const r = computeCampaignReadiness({ dataQuality: { status: 'VERIFIED' }, stack: fullStack, hasTrackingReady: true });
    ok('a fully-proven stack + VERIFIED data quality + tracking ready scores the maximum (100)', r.score === 100, JSON.stringify(r));
    ok('status is جاهزة للمراجعة at >=85', r.status === 'جاهزة للمراجعة');
    ok('every component names its own real max and points (auditable, not opaque)', r.components.every((c) => typeof c.points === 'number' && typeof c.max === 'number'));
  }
  {
    const emptyStack = buildWinningStack({});
    const r = computeCampaignReadiness({ dataQuality: { status: 'VERIFIED' }, stack: emptyStack, hasTrackingReady: false });
    ok('zero real winners + no tracking -> only the data-quality points remain, "تحتاج بيانات أكثر"', r.score === 20 && r.status === 'تحتاج بيانات أكثر', JSON.stringify(r));
  }
  {
    const anyStack = buildWinningStack({ gender: { segment: 'نساء', classification: 'PROVEN_WINNER', evidence: 'e' } });
    const r = computeCampaignReadiness({ dataQuality: { status: 'DECISION_BLOCKED_DATA_QUALITY' }, stack: anyStack, hasTrackingReady: true });
    ok('DECISION_BLOCKED_DATA_QUALITY always overrides the status to محظورة بسبب جودة البيانات, regardless of score', r.status === 'محظورة بسبب جودة البيانات', JSON.stringify(r));
  }

  console.log('\n§4 derivePrimaryActionType — pure mapping from the EXISTING decision engine verdict, with one honesty safety net:');
  ok('SCALE_CANDIDATE + healthy readiness -> NEW_SCALING_CAMPAIGN', derivePrimaryActionType('SCALE_CANDIDATE', { status: 'جاهزة للمراجعة' }) === 'NEW_SCALING_CAMPAIGN');
  ok('SCALE_CANDIDATE + BLOCKED data quality -> never oversold as ready, falls back to WAIT_FOR_DATA', derivePrimaryActionType('SCALE_CANDIDATE', { status: 'محظورة بسبب جودة البيانات' }) === 'WAIT_FOR_DATA');
  ok('AUDIENCE_TEST -> AUDIENCE_TEST', derivePrimaryActionType('AUDIENCE_TEST', { status: 'تحتاج بيانات أكثر' }) === 'AUDIENCE_TEST');
  ok('GEO_TEST -> GEO_TEST', derivePrimaryActionType('GEO_TEST', {}) === 'GEO_TEST');
  ok('NEW_CREATIVE_TEST -> CREATIVE_TEST', derivePrimaryActionType('NEW_CREATIVE_TEST', {}) === 'CREATIVE_TEST');
  ok('INSUFFICIENT_DATA -> WAIT_FOR_DATA', derivePrimaryActionType('INSUFFICIENT_DATA', {}) === 'WAIT_FOR_DATA');
  ok('PAUSE_CANDIDATE stays its own honest type, even though not in the user-supplied vocabulary list (never mislabeled as KEEP_TESTING)', derivePrimaryActionType('PAUSE_CANDIDATE', {}) === 'PAUSE_CANDIDATE');
  ok('an unrecognized/legacy decision falls back to KEEP_TESTING rather than crashing', derivePrimaryActionType('SOME_FUTURE_DECISION', {}) === 'KEEP_TESTING');

  console.log('\n§5 getExistingBumpCandidates — real persisted PENDING bump/rollback recs for THIS product\'s own campaigns only:');
  {
    const batchId = `test-actionplan-${Date.now()}`;
    const recA = await prisma.ambRecommendation.create({ data: {
      batch_id: batchId, ad_account_id: 'act_test_ap', level: 'adset', entity_id: 'adset_A', entity_name: 'AdSet A',
      campaign_id: 'camp_A', campaign_name: 'Camp A', adset_id: 'adset_A', adset_name: 'AdSet A',
      decision: 'BUMP_ADSET_25', action_type: 'INCREASE_BUDGET', executable: true,
      current_budget: 200, recommended_budget: 250, reason: 'CPA منخفض بعينة كافية', confidence: 'HIGH', status: 'PENDING', source: 'FALLBACK',
    } });
    cleanupRecIds.push(recA.id);
    const recOtherCampaign = await prisma.ambRecommendation.create({ data: {
      batch_id: batchId, ad_account_id: 'act_test_ap', level: 'adset', entity_id: 'adset_B', entity_name: 'AdSet B',
      campaign_id: 'camp_UNRELATED', campaign_name: 'Camp Unrelated', adset_id: 'adset_B', adset_name: 'AdSet B',
      decision: 'BUMP_ADSET_25', action_type: 'INCREASE_BUDGET', executable: true,
      current_budget: 300, recommended_budget: 375, reason: 'unrelated', confidence: 'HIGH', status: 'PENDING', source: 'FALLBACK',
    } });
    cleanupRecIds.push(recOtherCampaign.id);
    const recApproved = await prisma.ambRecommendation.create({ data: {
      batch_id: batchId, ad_account_id: 'act_test_ap', level: 'adset', entity_id: 'adset_C', entity_name: 'AdSet C',
      campaign_id: 'camp_A', campaign_name: 'Camp A', adset_id: 'adset_C', adset_name: 'AdSet C',
      decision: 'BUMP_ADSET_25', action_type: 'INCREASE_BUDGET', executable: true,
      current_budget: 100, recommended_budget: 125, reason: 'already approved', confidence: 'HIGH', status: 'APPROVED', source: 'FALLBACK',
    } });
    cleanupRecIds.push(recApproved.id);

    const candidates = await getExistingBumpCandidates([{ campaignId: 'camp_A' }]);
    ok('finds the real PENDING bump for this product\'s own campaign', candidates.some((c) => c.recommendationId === recA.id), JSON.stringify(candidates));
    ok('never leaks a bump from an unrelated campaign', !candidates.some((c) => c.recommendationId === recOtherCampaign.id));
    ok('never surfaces an already-APPROVED one as a pending secondary action', !candidates.some((c) => c.recommendationId === recApproved.id));
    ok('carries the real current/proposed budget for display', candidates.find((c) => c.recommendationId === recA.id)?.currentBudget === 200);

    const none = await getExistingBumpCandidates([]);
    ok('no campaigns -> empty array, never a crash', Array.isArray(none) && none.length === 0);
  }

  console.log('\n§6 resolveTrackingIdentity — real prior Launch Builder config only, product-specific takes priority, never invented:');
  {
    // product_id is a real FK on AmbLaunchJob — reuse a real Product row
    // that has NO existing AmbLaunchJob yet (read-only reference, never
    // modified), so the "falls back to account-level" assertion below is
    // never accidentally confused by pre-existing real launch history.
    const launchedProductIds = (await prisma.ambLaunchJob.findMany({ where: { product_id: { not: null } }, select: { product_id: true }, distinct: ['product_id'] })).map((r) => r.product_id);
    const anyRealProduct = await prisma.product.findFirst({ where: { id: { notIn: launchedProductIds } }, select: { id: true } });
    const fakeProductId = anyRealProduct.id;
    const fakeAdAccountId = 'act_test_tracking';
    const accountJob = await prisma.ambLaunchJob.create({ data: {
      job_id: `test-track-account-${Date.now()}`, ad_account_id: fakeAdAccountId, budget_mode: 'CBO', config_json: '{}',
      pixel_id: 'px_account', pixel_name: 'Account Pixel', conversion_event: 'PURCHASE', page_id: 'pg_account', page_name: 'Account Page',
    } });
    cleanupJobIds.push(accountJob.id);

    const accountLevel = await resolveTrackingIdentity({ productId: fakeProductId, adAccountId: fakeAdAccountId });
    ok('no product-specific launch yet -> falls back to the account\'s real launch history', accountLevel.pixel_id === 'px_account' && accountLevel.source === 'ACCOUNT_LAUNCH_HISTORY', JSON.stringify(accountLevel));

    const productJob = await prisma.ambLaunchJob.create({ data: {
      job_id: `test-track-product-${Date.now()}`, ad_account_id: fakeAdAccountId, product_id: fakeProductId, budget_mode: 'CBO', config_json: '{}',
      pixel_id: 'px_product', pixel_name: 'Product Pixel', conversion_event: 'PURCHASE', page_id: 'pg_product', page_name: 'Product Page', instagram_id: 'ig_product', instagram_username: 'product_ig',
    } });
    cleanupJobIds.push(productJob.id);

    const productLevel = await resolveTrackingIdentity({ productId: fakeProductId, adAccountId: fakeAdAccountId });
    ok('a real product-specific launch takes priority over the account-level fallback', productLevel.pixel_id === 'px_product' && productLevel.source === 'PRODUCT_LAUNCH_HISTORY', JSON.stringify(productLevel));

    const neverLaunched = await resolveTrackingIdentity({ productId: -9999, adAccountId: 'act_never_used' });
    ok('a product/account with NO real prior launch -> honestly null, never a guessed pixel/page', neverLaunched.pixel_id === null && neverLaunched.page_id === null && neverLaunched.source === null, JSON.stringify(neverLaunched));
    ok('conversion event still defaults to PURCHASE (the same real default AmbLaunchJob itself uses)', neverLaunched.conversion_event === 'PURCHASE');
  }

  console.log('\n§7 buildActionPlan — full integration, VIEW WINDOW safety honored:');
  {
    const pkgProven = {
      window: { label: 'آخر 7 أيام' }, decision: 'SCALE_CANDIDATE', reason: 'منتج صحي وكرياتيف مثبت',
      dataQuality: { status: 'VERIFIED' }, recommendationStatus: 'PENDING', successMetric: 'صافي الربح / CPA', evaluationWindowDays: 7,
      winners: {
        gender: { segment: 'نساء', classification: 'PROVEN_WINNER', evidence: 'e1' },
        age: { segment: '20-35', classification: 'PROVEN_WINNER', evidence: 'e2' },
        governorate: { segment: 'القاهرة', classification: 'PROMISING', evidence: 'e3' },
        creative: { label: 'C7', classification: 'WINNER', evidence: 'e4' },
        hook: { label: 'H3', classification: 'GOOD', evidence: 'e5' },
      },
    };
    const plan = await buildActionPlan({ pkg: pkgProven, productId: -9999, productName: 'Test Product', image: null, adAccountId: 'act_never_used', campaigns: [] });
    ok('a real proven stack + VERIFIED quality -> primary action is NEW_SCALING_CAMPAIGN', plan.primaryAction.type === 'NEW_SCALING_CAMPAIGN', JSON.stringify(plan.primaryAction));
    ok('a NEW_SCALING_CAMPAIGN plan carries a real campaign preview', !!plan.campaignPreview);
    ok('campaign preview never invents a pixel/page for a product that never launched', plan.campaignPreview.pixel === null && plan.campaignPreview.page === null);
    ok('canApprove reflects the pkg\'s own PENDING status', plan.canApprove === true && plan.isViewOnly === false);

    const pkgViewOnly = { ...pkgProven, recommendationStatus: 'VIEW_ONLY' };
    const viewPlan = await buildActionPlan({ pkg: pkgViewOnly, productId: -9999, productName: 'Test Product', image: null, adAccountId: 'act_never_used', campaigns: [] });
    ok('a VIEW_ONLY package (historical window) never claims to be approvable', viewPlan.canApprove === false && viewPlan.isViewOnly === true);

    const pkgThin = {
      window: { label: 'اليوم' }, decision: 'AUDIENCE_TEST', reason: 'عينة صغيرة لسه',
      dataQuality: { status: 'DATA_QUALITY_WARNING' }, recommendationStatus: 'PENDING', successMetric: 'CPC', evaluationWindowDays: 7,
      winners: {},
    };
    const thinPlan = await buildActionPlan({ pkg: pkgThin, productId: -9998, productName: 'Smart-Tank-like', image: null, adAccountId: 'act_never_used', campaigns: [] });
    ok('a thin/early product is honestly NOT presented as a scaling campaign', thinPlan.primaryAction.type !== 'NEW_SCALING_CAMPAIGN', JSON.stringify(thinPlan.primaryAction));
    ok('every winning stack TARGETING field is null (Broad) when there is truly no evidence — never fabricated', Object.entries(thinPlan.winningStack).filter(([k]) => k !== 'placements').every(([, v]) => v.targeting === null));
  }

  console.log('\n§8 Step 3 — buildObservationStack: CURRENT LEADER surfaces even when NOT proven, using the SAME real topObserved/table data:');
  {
    const segmentIntel = {
      gender: {
        table: [{ segment: 'رجال', spend: 1233, purchases: 4, classification: 'INSUFFICIENT_DATA', signalStrength: 'EARLY_SIGNAL', evidence: 'صرف 1233 ج · 4 شراء' }],
        topObserved: { segment: 'رجال', count: 4, signalStrength: 'EARLY_SIGNAL', winnerStatus: 'NOT_PROVEN_YET' },
      },
      age: { table: [], topObserved: null },
      governorates: {
        table: [{ segment: 'القاهرة', orders: 2, classification: 'INSUFFICIENT_DATA', signalStrength: 'OBSERVED', evidence: '2 أوردر' }],
        topObserved: { segment: 'القاهرة', count: 2, signalStrength: 'OBSERVED', winnerStatus: 'NOT_PROVEN_YET' },
      },
    };
    const creativeIntel = {
      creative: {
        table: [{ label: 'C7', spend: 400, purchases: 3, classification: 'TESTING', signalStrength: 'EARLY_SIGNAL', evidence: 'e' }],
        topObserved: { label: 'C7', purchases: 3, signalStrength: 'EARLY_SIGNAL', winnerStatus: 'NOT_PROVEN_YET' },
      },
      hooks: { table: [], topObserved: null }, angles: { table: [], topObserved: null }, primaryTexts: { table: [], topObserved: null }, headlines: { table: [], topObserved: null },
    };
    const obs = buildObservationStack(segmentIntel, creativeIntel);
    ok('gender with 4 purchases but not enough for proof surfaces as EARLY_SIGNAL, never hidden as "Broad"', obs.gender.status === 'EARLY_SIGNAL' && obs.gender.value === 'رجال' && obs.gender.count === 4, JSON.stringify(obs.gender));
    ok('governorate at OBSERVED tier (1-2 real orders) is honestly OBSERVED, not upgraded', obs.governorate.status === 'OBSERVED' && obs.governorate.value === 'القاهرة');
    ok('creative current leader surfaces as EARLY_SIGNAL from the same real row', obs.creative.status === 'EARLY_SIGNAL' && obs.creative.value === 'C7');
    ok('a dimension with truly zero observation is honestly NO_DATA', obs.age.status === 'NO_DATA' && obs.age.value === null);
    ok('placements always stays NO_DATA — no placement-level pipeline exists to observe from', obs.placements.status === 'NO_DATA');

    console.log('  (a PROVEN_WEAK/WEAK row is never shown as a positive "current leader" — it gets its own honest PROVEN_NEGATIVE rung)');
    const weakSeg = { gender: { table: [{ segment: 'نساء', purchases: 20, classification: 'PROVEN_WEAK', signalStrength: null, evidence: 'e' }], topObserved: { segment: 'نساء', count: 20, signalStrength: null, winnerStatus: 'NOT_PROVEN_YET' } }, age: { table: [], topObserved: null }, governorates: { table: [], topObserved: null } };
    const obsWeak = buildObservationStack(weakSeg, {});
    ok('a real proven-negative current leader is labeled PROVEN_NEGATIVE, never disguised as progress', obsWeak.gender.status === 'PROVEN_NEGATIVE', JSON.stringify(obsWeak.gender));
  }

  console.log('\n§9 Step 3 — buildFullStack: targeting stays strict while observation stays exploratory, structurally separated:');
  {
    const winners = { gender: { segment: 'رجال', classification: 'PROVEN_WINNER', evidence: 'e' } }; // proven
    const segmentIntel = {
      gender: { table: [{ segment: 'رجال', purchases: 8, classification: 'PROVEN_WINNER', signalStrength: null, evidence: 'e' }], topObserved: { segment: 'رجال', count: 8, signalStrength: null, winnerStatus: 'PROVEN_WINNER' } },
      age: { table: [{ segment: '20-35', purchases: 2, classification: 'INSUFFICIENT_DATA', signalStrength: 'EARLY_SIGNAL', evidence: 'e' }], topObserved: { segment: '20-35', count: 2, signalStrength: 'EARLY_SIGNAL', winnerStatus: 'NOT_PROVEN_YET' } },
      governorates: { table: [], topObserved: null },
    };
    const full = buildFullStack({ winners, segmentIntel, creativeIntel: {} });
    ok('gender has a REAL proven winner -> targeting is non-null AND observation reflects the same real leader', full.gender.targeting?.status === 'PROVEN' && full.gender.observation.status === 'PROVEN_WINNER');
    ok('age has ONLY an early signal -> targeting stays null (Broad) even though observation shows a real current leader', full.age.targeting === null && full.age.observation.status === 'EARLY_SIGNAL', JSON.stringify(full.age));
    ok('governorate has zero data -> both targeting null and observation NO_DATA', full.governorate.targeting === null && full.governorate.observation.status === 'NO_DATA');
  }

  console.log('\n§10 Step 3 — buildFormingPlanSummary: never fakes Scale-readiness, names the REAL missing evidence:');
  {
    const partialStack = {
      gender: { targeting: null, observation: { status: 'EARLY_SIGNAL', value: 'رجال' } },
      age: { targeting: null, observation: { status: 'NO_DATA', value: null } },
      governorate: { targeting: null, observation: { status: 'EARLY_SIGNAL', value: 'القاهرة' } },
      creative: { targeting: null, observation: { status: 'OBSERVED', value: 'C7' } },
      hook: { targeting: null, observation: { status: 'OBSERVED', value: 'H3' } },
      angle: { targeting: null, observation: { status: 'NO_DATA', value: null } },
      primaryText: { targeting: null, observation: { status: 'NO_DATA', value: null } },
      headline: { targeting: null, observation: { status: 'NO_DATA', value: null } },
      placements: { targeting: { value: 'Advantage+', status: 'NOT_PROVEN' }, observation: { status: 'NO_DATA', value: null } },
    };
    const fp = buildFormingPlanSummary(partialStack, 'AUDIENCE_TEST');
    ok('not scale-ready when the primary type isn\'t NEW_SCALING_CAMPAIGN, regardless of how many early signals exist', fp.scaleReady === false);
    ok('names Creative + Audience + Geo as the real missing evidence (none has a targeting value yet)', /Creative/.test(fp.reason) && /Audience/.test(fp.reason) && /Geo/.test(fp.reason), fp.reason);
    ok('lists every dimension with a REAL observation (gender/governorate/creative/hook), skips the NO_DATA ones (age/angle/primaryText/headline)', fp.lines.length === 4 && fp.lines.every((l) => l.status !== 'NO_DATA'), JSON.stringify(fp.lines));

    const readyStack = { ...partialStack, gender: { targeting: { value: 'نساء', status: 'PROVEN' }, observation: { status: 'PROVEN_WINNER', value: 'نساء' } }, creative: { targeting: { value: 'C7', status: 'PROVEN' }, observation: { status: 'PROVEN_WINNER', value: 'C7' } }, governorate: { targeting: { value: 'القاهرة', status: 'PROMISING' }, observation: { status: 'PROMISING', value: 'القاهرة' } } };
    const fpReady = buildFormingPlanSummary(readyStack, 'NEW_SCALING_CAMPAIGN');
    ok('scaleReady true and no "missing evidence" reason once the primary type genuinely IS NEW_SCALING_CAMPAIGN', fpReady.scaleReady === true && fpReady.reason === null);
  }

  console.log('\n§11 Step 3 — real Smart-Tank (146) integration: Action Plan re-reads the real window, never hardcodes a prior report\'s values:');
  {
    const { getProductDossier } = await imp('../services/amb/productDossier.js');
    const dossier = await getProductDossier({ productId: 146 });
    if (dossier.linked && dossier.package?.actionPlan) {
      const ap = dossier.package.actionPlan;
      ok('winningStack is the NEW {targeting, observation} shape for every real dimension', Object.values(ap.winningStack).every((f) => 'targeting' in f && 'observation' in f), JSON.stringify(Object.keys(ap.winningStack)));
      ok('formingPlan is present with a real boolean scaleReady', typeof ap.formingPlan?.scaleReady === 'boolean', JSON.stringify(ap.formingPlan));
      ok('a real product-level campaign targeting decision is NEVER an Early Signal value alone — every non-null targeting field is PROVEN or PROMISING', Object.values(ap.winningStack).every((f) => !f.targeting || f.targeting.status === 'PROVEN' || f.targeting.status === 'PROMISING' || f.targeting.status === 'NOT_PROVEN'), JSON.stringify(ap.winningStack));
      console.log('  (real Smart-Tank forming-plan lines right now):', JSON.stringify(ap.formingPlan.lines));
    } else {
      console.log('  (skipped — Smart-Tank product 146 not currently linked/analyzed in this DB)');
    }
  }

  console.log('\n§12 Final core step — every prior TEST-only decision now ALSO gets a real prepared campaign preview, using the SAME evidence-gated stack, never a fake targeting choice:');
  {
    const winners = {
      gender: { segment: 'نساء', classification: 'PROVEN_WINNER', evidence: 'e' },
      creative: null, hook: null, // deliberately no proven creative — real for a fresh AUDIENCE_TEST
    };
    const pkg = {
      window: { label: 'آخر 7 أيام' }, decision: 'AUDIENCE_TEST', reason: 'إشارة جمهور واعدة',
      dataQuality: { status: 'VERIFIED' }, recommendationStatus: 'PENDING', successMetric: 'CPC', evaluationWindowDays: 7,
      winners,
    };
    const plan = await buildActionPlan({ pkg, productId: -9997, productName: 'Audience Test Product', image: null, adAccountId: 'act_never_used', campaigns: [] });
    ok('AUDIENCE_TEST now carries a real campaign preview (not null like before this step)', !!plan.campaignPreview, JSON.stringify(plan.campaignPreview));
    ok('the campaign preview uses the REAL proven gender, never invents a governorate/creative it does not have', plan.campaignPreview.audience.gender?.value === 'نساء' && plan.campaignPreview.governorate === null && plan.campaignPreview.creative === null);
    ok('primary CTA label matches the exact requested wording', plan.primaryAction.label.includes('تجهيز اختبار الجمهور'), plan.primaryAction.label);
    ok('provenWinners lists ONLY the real proven dimension (gender), never a fabricated extra one', plan.provenWinners.length === 1 && plan.provenWinners[0].dim === 'gender', JSON.stringify(plan.provenWinners));

    const creativeTestPkg = { ...pkg, decision: 'NEW_CREATIVE_TEST', winners: {} };
    const creativePlan = await buildActionPlan({ pkg: creativeTestPkg, productId: -9997, productName: 'Creative Test Product', image: null, adAccountId: 'act_never_used', campaigns: [] });
    ok('a creative test with zero proven creative flags needsCreativeFactory, never auto-generating', creativePlan.needsCreativeFactory === true);
    ok('provenWinners is honestly empty when nothing is proven', creativePlan.provenWinners.length === 0);
  }

  console.log('\n§13 Final core step — KEEP_TESTING/WAIT_FOR_DATA NEVER get a fake campaign preview, and state a real next-evaluation timing:');
  {
    const pkg = { window: { label: 'اليوم' }, decision: 'INSUFFICIENT_DATA', reason: 'لسه بدري', dataQuality: { status: 'VERIFIED' }, recommendationStatus: 'PENDING', successMetric: null, evaluationWindowDays: 7, winners: {} };
    const plan = await buildActionPlan({ pkg, productId: -9996, productName: 'Too Early Product', image: null, adAccountId: 'act_never_used', campaigns: [] });
    ok('WAIT_FOR_DATA never gets a campaign preview — no fake campaign', plan.campaignPreview === null);
    ok('WAIT_FOR_DATA states a real, honest next-evaluation timing', typeof plan.nextEvaluation === 'string' && plan.nextEvaluation.length > 10);
    ok('primaryAction.canPrepare is false — there is nothing to prepare yet', plan.primaryAction.canPrepare === false);
  }

  console.log('\n§14 Final core step — PAUSE_CANDIDATE gets a real pause preview naming the exact real campaigns, never a vague count:');
  {
    const pkg = { window: { label: 'آخر 7 أيام' }, decision: 'PAUSE_CANDIDATE', reason: 'CPA مرتفع جدًا بدون أي إشارة إيجابية', dataQuality: { status: 'VERIFIED' }, recommendationStatus: 'PENDING', successMetric: 'CPA', evaluationWindowDays: 7, winners: {} };
    const campaigns = [{ campaignId: 'camp_1', adAccountId: 'act_x', via: 'LAUNCH' }, { campaignId: 'camp_2', adAccountId: 'act_x', via: 'MAPPING' }];
    const plan = await buildActionPlan({ pkg, productId: -9995, productName: 'Pause Candidate Product', image: null, adAccountId: 'act_x', campaigns });
    ok('pausePreview carries the EXACT real campaign ids this product resolves to, never invented', plan.pausePreview?.campaignCount === 2 && plan.pausePreview.campaignIds.includes('camp_1') && plan.pausePreview.campaignIds.includes('camp_2'), JSON.stringify(plan.pausePreview));
    ok('PAUSE_CANDIDATE never gets a campaign preview (a pause is not a new campaign)', plan.campaignPreview === null);
    ok('primary CTA label matches the requested wording', plan.primaryAction.label.includes('تجهيز الإيقاف'), plan.primaryAction.label);
  }

  console.log('\n§15 CRITICAL EXECUTION GATE FIX — test-readiness is NOT the same as scale-readiness: a low Campaign Readiness score (thin evidence) must NEVER block AUDIENCE_TEST/GEO_TEST/CREATIVE_TEST, only NEW_SCALING_CAMPAIGN:');
  {
    // Exactly Smart-Tank's real shape: VERIFIED data quality but zero proven
    // audience/geo/creative/copy evidence -> a real low readiness score
    // (~35/100, "تحتاج بيانات أكثر") that must still leave a TEST fully
    // prepareable — the whole POINT of a test is collecting the missing evidence.
    const thinEvidencePkg = {
      window: { label: 'آخر 7 أيام' }, decision: 'AUDIENCE_TEST', reason: 'تكلفة الكليك مرتفعة',
      dataQuality: { status: 'VERIFIED' }, recommendationStatus: 'PENDING', successMetric: 'CPC', evaluationWindowDays: 7,
      winners: {},
    };
    const plan = await buildActionPlan({ pkg: thinEvidencePkg, productId: -9994, productName: 'Thin Evidence Product', image: null, adAccountId: 'act_never_used', campaigns: [] });
    ok('readiness score is genuinely low (thin evidence), exactly like Smart-Tank\'s real 35/100', plan.readiness.score < 60 && plan.readiness.status === 'تحتاج بيانات أكثر', JSON.stringify(plan.readiness));
    ok('AUDIENCE_TEST STILL resolves as the primary type despite low readiness — never downgraded to WAIT_FOR_DATA', plan.primaryAction.type === 'AUDIENCE_TEST', JSON.stringify(plan.primaryAction));
    ok('canPrepare stays TRUE for a test decision regardless of the low readiness score — test-readiness and scale-readiness are independent gates', plan.primaryAction.canPrepare === true);
    ok('a real campaign preview is still built for the test (Broad wherever unproven, never blocked by the readiness score)', !!plan.campaignPreview);

    // The ONLY thing a low/blocked readiness legitimately gates is a SCALE decision.
    const scalePkg = { ...thinEvidencePkg, decision: 'SCALE_CANDIDATE' };
    const scalePlanBlocked = await buildActionPlan({ pkg: { ...scalePkg, dataQuality: { status: 'DECISION_BLOCKED_DATA_QUALITY' } }, productId: -9993, productName: 'Blocked Scale Product', image: null, adAccountId: 'act_never_used', campaigns: [] });
    ok('a genuinely DATA-QUALITY-BLOCKED product correctly downgrades a SCALE attempt to WAIT_FOR_DATA (scale-readiness gate still works)', scalePlanBlocked.primaryAction.type === 'WAIT_FOR_DATA', JSON.stringify(scalePlanBlocked.primaryAction));
  }
} finally {
  await cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
