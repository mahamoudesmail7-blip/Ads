// Smart Decision Center — Product Dossier "🚀 أكشن بلان" tab. A pure
// PRESENTATION/SYNTHESIS layer over data that already exists and is already
// evidence-gated: productDecision.js's `winners` (segmentIntel/creativeIntel
// "best" picks, each carrying its own real classification/signalStrength/
// evidence), dataQualityGate.js's VERIFIED/WARNING/BLOCKED gate, and any
// already-persisted Budget Bump recommendation for this product's own ad
// sets. NOTHING here re-runs classification or invents a new evidence
// threshold — it only translates already-gated verdicts into the plan's own
// PROVEN/PROMISING/EARLY_SIGNAL/NOT_PROVEN vocabulary and assembles them
// into one approval-ready package.
//
// MANDATORY "NEVER FAKE A COMPLETE STACK" RULE: a Winning Stack field is
// only ever populated from a REAL best-pick (PROVEN/PROMISING) or a REAL
// topObserved row (EARLY_SIGNAL, honestly labeled as such) — never invented.
// A dimension with no real signal at all is `null` (rendered "Broad"/
// unspecified in the UI), exactly matching decideProductAction()'s own
// `winners.<dim> = null` when nothing clears the bar.
import { prisma } from '../../prisma.js';

/** PROVEN/PROMISING/EARLY_SIGNAL/NOT_PROVEN — the Action Plan's own unified vocabulary, reconciling segmentIntel's PROVEN_WINNER/PROMISING/INSUFFICIENT_DATA/PROVEN_WEAK and creativeIntel's WINNER/GOOD/TESTING/WEAK/FATIGUED/INSUFFICIENT_DATA with BOTH files' signalStrength — never a new classification decision, purely a label mapping over decisions already made. */
export function reconcileStackStatus(classification, signalStrength) {
  if (classification === 'PROVEN_WINNER' || classification === 'WINNER') return 'PROVEN';
  if (classification === 'PROMISING' || classification === 'GOOD') return 'PROMISING';
  if (signalStrength === 'OBSERVED' || signalStrength === 'EARLY_SIGNAL') return 'EARLY_SIGNAL';
  return 'NOT_PROVEN'; // covers INSUFFICIENT_DATA/TESTING with no real signal at all, and PROVEN_WEAK/WEAK/FATIGUED — a proven-negative is never put INTO a winning stack
}

const STACK_RANK = { PROVEN: 3, PROMISING: 2, EARLY_SIGNAL: 1, NOT_PROVEN: 0 };

/**
 * ONE winning-stack field from an ALREADY-COMPUTED `winners.<dim>` pick
 * (decideProductAction()'s `best`, itself either null or a real classified
 * row — see productDecision.js). Never fabricates a value for a null pick;
 * returns null so the caller renders "Broad"/unspecified, per the mandatory
 * "never fake a complete stack" rule.
 */
function stackFieldFromWinner(winner, { labelField = 'segment' } = {}) {
  if (!winner) return null;
  const value = winner[labelField] ?? winner.label ?? winner.segment ?? null;
  if (!value) return null;
  return {
    value,
    status: reconcileStackStatus(winner.classification, winner.signalStrength),
    evidence: winner.evidence || null,
    sampleSize: winner.sampleSize ?? winner.purchases ?? winner.orders ?? null,
    source: 'Product Intelligence',
    thumbnailUrl: winner.meta?.thumbnailUrl || winner.thumbnailUrl || null,
  };
}

/**
 * The Winning Stack — one entry per targetable dimension, built ONLY from
 * `winners` (already the decision engine's own "best" picks). `winners` is
 * accepted directly (not the whole package) so this same function works
 * identically from a LIVE package (pkg.winners) and from an already-
 * PERSISTED recommendation's reason_facts_json.winners — one shared
 * reconciliation path, no duplicated logic between dossier view and
 * execution handoff.
 */
export function buildWinningStack(winners) {
  const w = winners || {};
  return {
    gender: stackFieldFromWinner(w.gender),
    age: stackFieldFromWinner(w.age),
    governorate: stackFieldFromWinner(w.governorate),
    creative: stackFieldFromWinner(w.creative, { labelField: 'label' }),
    hook: stackFieldFromWinner(w.hook, { labelField: 'label' }),
    angle: stackFieldFromWinner(w.angle, { labelField: 'label' }),
    primaryText: stackFieldFromWinner(w.primaryText, { labelField: 'label' }),
    headline: stackFieldFromWinner(w.headline, { labelField: 'label' }),
    // Placements: no dedicated placement-level breakdown pipeline exists
    // anywhere in this system yet (Meta's placement data was never broken
    // out per-segment) — never invented. Meta's own automatic/Advantage+
    // placements is the honest, sensible default until that intelligence
    // exists, so this is NOT_PROVEN by construction, always.
    placements: {
      value: 'المواضع التلقائية (Advantage+)',
      status: 'NOT_PROVEN',
      evidence: 'لا يوجد تحليل مواضع إعلانية مخصص لهذا المنتج حتى الآن — الوضع الافتراضي الأكثر أمانًا هو ترك Meta تختار المواضع تلقائيًا.',
      sampleSize: null,
      source: 'Meta Default',
    },
  };
}

// ---- Step 3: CURRENT LEADER / EARLY SIGNAL vs PROVEN WINNER ----
// A second, purely ADDITIVE view over the SAME real data: `targeting`
// (built above by buildWinningStack — UNCHANGED, still only ever
// PROVEN/PROMISING/NOT_PROVEN, still the only thing ever used for actual
// campaign targeting) tells you what will be BUILT INTO the campaign.
// `observation` (built below) tells you what is CURRENTLY LEADING, even
// when it is far too early to trust for targeting — sourced from the same
// topObserved/table rows segmentIntel.js/creativeIntel.js already compute
// (Step 1's "OBSERVATION vs WINNER CLASSIFICATION" split), never a new
// threshold and never a new classification decision. The two are ALWAYS
// kept visually and structurally separate so an Early Signal can never be
// mistaken for — or silently promoted into — a targeting decision.
const LADDER_LABEL_AR = {
  NO_DATA: 'لا توجد بيانات',
  OBSERVED: 'تم رصده',
  EARLY_SIGNAL: 'إشارة مبكرة',
  PROMISING: 'واعد',
  PROVEN_WINNER: 'فائز مثبت',
  PROVEN_NEGATIVE: 'ضعف مؤكد',
};

/** Same 5-rung ladder (+ an honest 6th rung for a real proven NEGATIVE) computed from the row's OWN already-gated classification/signalStrength — never a new evidence threshold, purely relabeling for progressive display. */
function ladderStatus({ classification, signalStrength }) {
  if (classification === 'PROVEN_WINNER' || classification === 'WINNER') return 'PROVEN_WINNER';
  if (classification === 'PROMISING' || classification === 'GOOD') return 'PROMISING';
  if (classification === 'PROVEN_WEAK' || classification === 'WEAK' || classification === 'FATIGUED') return 'PROVEN_NEGATIVE';
  if (signalStrength === 'EARLY_SIGNAL') return 'EARLY_SIGNAL';
  if (signalStrength === 'OBSERVED') return 'OBSERVED';
  return 'OBSERVED'; // a real observation exists (caller only reaches here when topObserved is non-null) but neither label above applies — an honest, conservative fallback, never a claim of proof
}

function findObservedRow(table, keyValue, labelField) {
  return (table || []).find((r) => (r[labelField] ?? r.label ?? r.segment) === keyValue) || null;
}

/**
 * The CURRENT LEADER for one dimension — the real topObserved row
 * segmentIntel.js/creativeIntel.js already compute (highest raw
 * purchases/orders right now), regardless of whether it has cleared the
 * evidence bar. Returns an honest NO_DATA object (never null/undefined —
 * the UI always has something concrete to render) when there is truly zero
 * observation yet.
 */
function buildObservationField(dim, { labelField = 'segment', countLabel = 'Purchases' } = {}) {
  const topObserved = dim?.topObserved;
  if (!topObserved) return { status: 'NO_DATA', value: null, count: null, countLabel, spend: null, evidence: null };
  const keyValue = topObserved.segment ?? topObserved.label;
  const row = findObservedRow(dim?.table, keyValue, labelField);
  return {
    status: ladderStatus({ classification: row?.classification, signalStrength: topObserved.signalStrength }),
    value: keyValue,
    count: topObserved.count ?? topObserved.purchases ?? null,
    countLabel,
    spend: row?.spend ?? null,
    evidence: row?.evidence || null,
    thumbnailUrl: row?.meta?.thumbnailUrl || null,
  };
}

/** The full "current leader" view across every dimension — placements has no dedicated breakdown pipeline anywhere in this system, so it honestly stays NO_DATA here (its `targeting` side already defaults to Meta's own automatic placements). */
export function buildObservationStack(segmentIntel, creativeIntel) {
  const seg = segmentIntel || {};
  const ci = creativeIntel || {};
  return {
    gender: buildObservationField(seg.gender, { labelField: 'segment', countLabel: 'Purchases' }),
    age: buildObservationField(seg.age, { labelField: 'segment', countLabel: 'Purchases' }),
    governorate: buildObservationField(seg.governorates, { labelField: 'segment', countLabel: 'Orders' }),
    creative: buildObservationField(ci.creative, { labelField: 'label', countLabel: 'Purchases' }),
    hook: buildObservationField(ci.hooks, { labelField: 'label', countLabel: 'Purchases' }),
    angle: buildObservationField(ci.angles, { labelField: 'label', countLabel: 'Purchases' }),
    primaryText: buildObservationField(ci.primaryTexts, { labelField: 'label', countLabel: 'Purchases' }),
    headline: buildObservationField(ci.headlines, { labelField: 'label', countLabel: 'Purchases' }),
    placements: { status: 'NO_DATA', value: null, count: null, countLabel: null, spend: null, evidence: 'لا يوجد تحليل مواضع إعلانية مخصص لهذا المنتج حتى الآن.' },
  };
}

const STACK_DIMS = ['gender', 'age', 'governorate', 'placements', 'creative', 'hook', 'angle', 'primaryText', 'headline'];

/** Merges the strict `targeting` stack (buildWinningStack — unchanged, PROVEN/PROMISING only) with the exploratory `observation` stack (current leader, however early) into one {targeting, observation} pair per dimension. This is the ONLY new structural change to the Winning Stack's shape — every existing consumer of the flat targeting-only shape (Campaign Preview, Campaign Readiness, the Launch Builder handoff) keeps reading `.targeting` exactly as it read the old flat object, so nothing downstream of a real campaign decision is weakened. */
export function buildFullStack({ winners, segmentIntel, creativeIntel }) {
  const targeting = buildWinningStack(winners);
  const observation = buildObservationStack(segmentIntel, creativeIntel);
  const merged = {};
  for (const dim of STACK_DIMS) merged[dim] = { targeting: targeting[dim], observation: observation[dim] };
  return merged;
}

const FORMING_PLAN_DIMS = {
  gender: ['👨', 'Gender'], age: ['🎂', 'Age'], governorate: ['📍', 'Geo'],
  creative: ['🎥', 'Creative'], hook: ['🪝', 'Hook'], angle: ['🧭', 'Angle'],
  primaryText: ['📝', 'Post'], headline: ['🏷️', 'Headline'],
};

/**
 * "🧩 الخطة تتكوّن حاليًا" — a live, honest snapshot of every dimension that
 * has ANY real observation yet (regardless of proof), plus the ONE thing
 * that actually gates NEW_SCALING_CAMPAIGN: which of Creative/Audience/Geo
 * still lack a PROVEN/PROMISING `targeting` value. Never invents a reason —
 * every missing item named here is a real null on the strict targeting
 * stack, the exact same gate computeCampaignReadiness/derivePrimaryActionType
 * already enforce.
 */
export function buildFormingPlanSummary(fullStack, primaryType) {
  const lines = [];
  for (const [key, [icon, label]] of Object.entries(FORMING_PLAN_DIMS)) {
    const obs = fullStack[key]?.observation;
    if (!obs || obs.status === 'NO_DATA') continue;
    lines.push({ icon, label, value: obs.value, status: obs.status, statusAr: LADDER_LABEL_AR[obs.status] || obs.status });
  }
  const scaleReady = primaryType === 'NEW_SCALING_CAMPAIGN';
  const missing = [];
  if (!fullStack.creative?.targeting) missing.push('Creative');
  if (!fullStack.gender?.targeting && !fullStack.age?.targeting) missing.push('Audience');
  if (!fullStack.governorate?.targeting) missing.push('Geo');
  return {
    lines, scaleReady,
    reason: scaleReady ? null : (missing.length ? `نحتاج أدلة أقوى على ${missing.join(' + ')}` : 'التشخيص العام لسه محتاج وقت/عينة أكبر لتأكيد قرار Scale.'),
  };
}

const READINESS_WEIGHTS = { dataQuality: 20, audience: 15, geo: 15, creative: 20, copy: 15, tracking: 15 };

function tierPoints(field, max) {
  if (!field) return 0;
  const rank = STACK_RANK[field.status] || 0;
  return Math.round((rank / 3) * max);
}
function bestOf(fields) {
  return fields.filter(Boolean).reduce((best, f) => (!best || STACK_RANK[f.status] > STACK_RANK[best.status] ? f : best), null);
}

/**
 * Campaign Readiness Score — NOT an arbitrary AI number. Every point is
 * traceable to a real, already-computed input: the SAME dataQualityGate.js
 * verdict used everywhere else in this system, and the SAME Winning Stack
 * fields the UI shows with their own evidence. `hasTrackingReady` comes from
 * `resolveTrackingIdentity()` below — a real prior Launch Builder
 * pixel/page/IG configuration, never assumed.
 */
export function computeCampaignReadiness({ dataQuality, stack, hasTrackingReady }) {
  const dqPoints = dataQuality?.status === 'VERIFIED' ? READINESS_WEIGHTS.dataQuality
    : dataQuality?.status === 'DATA_QUALITY_WARNING' ? Math.round(READINESS_WEIGHTS.dataQuality / 2) : 0;

  const components = [
    { key: 'dataQuality', label: 'جودة البيانات', points: dqPoints, max: READINESS_WEIGHTS.dataQuality },
    { key: 'audience', label: 'أدلة الجمهور (النوع/العمر)', points: tierPoints(bestOf([stack.gender, stack.age]), READINESS_WEIGHTS.audience), max: READINESS_WEIGHTS.audience },
    { key: 'geo', label: 'أدلة المحافظات', points: tierPoints(stack.governorate, READINESS_WEIGHTS.geo), max: READINESS_WEIGHTS.geo },
    { key: 'creative', label: 'أدلة الكرياتيف', points: tierPoints(stack.creative, READINESS_WEIGHTS.creative), max: READINESS_WEIGHTS.creative },
    { key: 'copy', label: 'أدلة Hook/زاوية البيع/النصوص', points: tierPoints(bestOf([stack.hook, stack.angle, stack.primaryText, stack.headline]), READINESS_WEIGHTS.copy), max: READINESS_WEIGHTS.copy },
    { key: 'tracking', label: 'جاهزية التتبع (Pixel/Page/Instagram)', points: hasTrackingReady ? READINESS_WEIGHTS.tracking : 0, max: READINESS_WEIGHTS.tracking },
  ];
  const score = components.reduce((s, c) => s + c.points, 0);

  let status;
  if (dataQuality?.status === 'DECISION_BLOCKED_DATA_QUALITY') status = 'محظورة بسبب جودة البيانات';
  else if (score >= 85) status = 'جاهزة للمراجعة';
  else if (score >= 60) status = 'جاهزة مع بعض الافتراضات';
  else status = 'تحتاج بيانات أكثر';

  return { score, status, components };
}

const PRIMARY_ACTION_MAP = {
  SCALE_CANDIDATE: 'NEW_SCALING_CAMPAIGN',
  AUDIENCE_TEST: 'AUDIENCE_TEST',
  GEO_TEST: 'GEO_TEST',
  NEW_CREATIVE_TEST: 'CREATIVE_TEST',
  INSUFFICIENT_DATA: 'WAIT_FOR_DATA',
  PAUSE_CANDIDATE: 'PAUSE_CANDIDATE',
  KEEP_TESTING: 'KEEP_TESTING',
  LANDING_PAGE_FIX: 'KEEP_TESTING',
  OFFER_TEST: 'KEEP_TESTING',
};

const PRIMARY_ACTION_LABEL_AR = {
  NEW_SCALING_CAMPAIGN: '🚀 إنشاء Scaling Campaign جديدة',
  AUDIENCE_TEST: '🎯 اختبار جمهور',
  GEO_TEST: '🗺️ اختبار جغرافي',
  CREATIVE_TEST: '🎨 اختبار كرياتيف',
  PAUSE_CANDIDATE: '⏸️ إيقاف مؤقت',
  KEEP_TESTING: '🔬 الاستمرار في الاختبار',
  WAIT_FOR_DATA: '⏳ انتظار المزيد من البيانات',
};

/**
 * The primary action type — derived ONLY from the decision engine's own
 * `decision` (never a second, competing verdict). The one safety net: even
 * a real SCALE_CANDIDATE decision never presents as "ready to launch" if
 * the SAME data quality gate that already blocks approval elsewhere says
 * DECISION_BLOCKED — this never changes the underlying `decision` value
 * itself (still SCALE_CANDIDATE in history/approval), it only keeps the
 * Action Plan's own presentation honest.
 */
export function derivePrimaryActionType(decision, readiness) {
  let type = PRIMARY_ACTION_MAP[decision] || 'KEEP_TESTING';
  if (type === 'NEW_SCALING_CAMPAIGN' && readiness.status === 'محظورة بسبب جودة البيانات') type = 'WAIT_FOR_DATA';
  return type;
}

/** Real, already-persisted PENDING Budget Bump/Rollback recommendations for THIS product's own ad sets — zero new Meta calls, reuses budgetBumpOrchestrator.js's existing persistence exactly as-is. Detection-only surface; approval goes through the EXISTING generic /recommendations/:id/approve endpoint, never a new execution path. */
export async function getExistingBumpCandidates(campaigns) {
  const campaignIds = (campaigns || []).map((c) => c.campaignId).filter(Boolean);
  if (!campaignIds.length) return [];
  const recs = await prisma.ambRecommendation.findMany({
    where: { level: 'adset', campaign_id: { in: campaignIds }, decision: { in: ['BUMP_ADSET_25', 'ROLLBACK_BUMP'] }, status: 'PENDING' },
    orderBy: { created_at: 'desc' },
    select: { id: true, adset_name: true, decision: true, reason: true, current_budget: true, recommended_budget: true, created_at: true },
  });
  return recs.map((r) => ({
    recommendationId: r.id,
    type: r.decision === 'BUMP_ADSET_25' ? 'ADSET_BUDGET_BUMP' : 'ROLLBACK_BUMP',
    label: r.decision === 'BUMP_ADSET_25' ? `📈 زيادة ميزانية Ad Set: ${r.adset_name}` : `↩️ إرجاع ميزانية Ad Set: ${r.adset_name}`,
    adsetName: r.adset_name,
    evidence: r.reason,
    currentBudget: r.current_budget,
    proposedBudget: r.recommended_budget,
    createdAt: r.created_at,
  }));
}

/**
 * Real, already-verified Pixel/Page/Instagram identity — sourced from the
 * most recent REAL Campaign Launch Builder job that actually carries them
 * (this product's own launch history first, falling back to any other
 * product's launch under the SAME ad account, since Pixel/Page/IG are
 * account-level Meta identities, not per-product). Never a fresh Meta Graph
 * call (that infrastructure — getLaunchAccountAssets — is a live,
 * per-account fetch meant for the wizard itself, not for a read-heavy
 * dossier load) and never invented when no real prior launch exists.
 */
export async function resolveTrackingIdentity({ productId, adAccountId }) {
  const productJob = await prisma.ambLaunchJob.findFirst({
    where: { product_id: productId, pixel_id: { not: null } },
    orderBy: { created_at: 'desc' },
    select: { pixel_id: true, pixel_name: true, conversion_event: true, page_id: true, page_name: true, instagram_id: true, instagram_username: true },
  });
  if (productJob) return { ...productJob, source: 'PRODUCT_LAUNCH_HISTORY' };

  if (adAccountId) {
    const accountJob = await prisma.ambLaunchJob.findFirst({
      where: { ad_account_id: adAccountId, pixel_id: { not: null } },
      orderBy: { created_at: 'desc' },
      select: { pixel_id: true, pixel_name: true, conversion_event: true, page_id: true, page_name: true, instagram_id: true, instagram_username: true },
    });
    if (accountJob) return { ...accountJob, source: 'ACCOUNT_LAUNCH_HISTORY' };
  }
  return { pixel_id: null, pixel_name: null, conversion_event: 'PURCHASE', page_id: null, page_name: null, instagram_id: null, instagram_username: null, source: null };
}

/** The Campaign Preview — every field cites its own real source; a field with no real winner shows the Winning Stack's own honest "Broad"/default value, never a guess. */
function buildCampaignPreview({ productId, productName, image, stack, tracking }) {
  return {
    productId, productName, image,
    objective: 'OUTCOME_SALES',
    conversionEvent: tracking.conversion_event || 'PURCHASE',
    audience: { gender: stack.gender, age: stack.age },
    governorate: stack.governorate,
    placements: stack.placements,
    creative: stack.creative,
    hook: stack.hook,
    angle: stack.angle,
    primaryText: stack.primaryText,
    headline: stack.headline,
    pixel: tracking.pixel_id ? { id: tracking.pixel_id, name: tracking.pixel_name, source: tracking.source } : null,
    page: tracking.page_id ? { id: tracking.page_id, name: tracking.page_name, source: tracking.source } : null,
    instagram: tracking.instagram_id ? { id: tracking.instagram_id, username: tracking.instagram_username, source: tracking.source } : null,
    // User-entered only — never pre-guessed.
    budget: null, startDate: null, startTime: null,
  };
}

/**
 * The full Action Plan for one product's Decision Package. Never persists
 * anything itself (the dossier's own VIEW WINDOW safety already decides
 * whether `pkg` came from a live operational recommendation or a read-only
 * historical view — this function just describes whichever `pkg` it's
 * given, honestly).
 */
export async function buildActionPlan({ pkg, productId, productName, image, adAccountId, campaigns }) {
  const fullStack = buildFullStack({ winners: pkg.winners, segmentIntel: pkg.segmentIntel, creativeIntel: pkg.creativeIntel });
  // The strict, targeting-only flat shape — EXACTLY what computeCampaignReadiness/
  // buildCampaignPreview/the Launch Builder handoff have always consumed.
  // Readiness and the real campaign preview NEVER see the observation side.
  const targetingStack = Object.fromEntries(STACK_DIMS.map((d) => [d, fullStack[d].targeting]));

  const tracking = await resolveTrackingIdentity({ productId, adAccountId });
  const readiness = computeCampaignReadiness({ dataQuality: pkg.dataQuality, stack: targetingStack, hasTrackingReady: !!(tracking.pixel_id && tracking.page_id) });
  const primaryType = derivePrimaryActionType(pkg.decision, readiness);
  const bumpCandidates = await getExistingBumpCandidates(campaigns).catch(() => []);
  const formingPlan = buildFormingPlanSummary(fullStack, primaryType);

  const secondaryActions = bumpCandidates.map((b) => ({ ...b }));
  const campaignPreview = primaryType === 'NEW_SCALING_CAMPAIGN' || primaryType === 'WAIT_FOR_DATA'
    ? buildCampaignPreview({ productId, productName, image, stack: targetingStack, tracking })
    : null;

  return {
    windowLabel: pkg.window?.label || null,
    winningStack: fullStack, // { <dim>: { targeting, observation } }
    formingPlan,
    readiness,
    primaryAction: { type: primaryType, label: PRIMARY_ACTION_LABEL_AR[primaryType] || primaryType, reason: pkg.reason },
    secondaryActions,
    campaignPreview,
    successMetric: pkg.successMetric || null,
    evaluationWindowDays: pkg.evaluationWindowDays || 7,
    canApprove: pkg.recommendationStatus === 'PENDING',
    isViewOnly: pkg.recommendationStatus === 'VIEW_ONLY',
  };
}
