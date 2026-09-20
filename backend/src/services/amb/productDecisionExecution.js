// Smart Decision Center Phase 8 — Approval -> Execution. Connects an
// APPROVED product Decision Package to the EXISTING execution primitives
// (metaGraphClient.js's setEntityStatus — the SAME function executor.js's
// campaign/ad-level approve flow already uses — and Campaign Launch
// Builder's own wizard, prefilled) — never a new publisher, never a new
// Meta-write code path.
//
// SAFETY BOUNDARY (mandatory, never relaxed): buildExecutionPlan() is
// ALWAYS read-only — it never sends anything to Meta, regardless of who
// calls it. executeApprovedDecision() refuses to perform ANY real Meta
// write (PAUSE_CANDIDATE's campaign pause) unless BOTH (a) the
// recommendation is already APPROVED (Phase 6/7's separate, non-executing
// approval step) AND (b) the caller passes an explicit
// confirmRealExecution:true flag — a second, distinct confirmation a human
// must make deliberately, never inferred or defaulted. Every other decision
// type (NEW_CREATIVE_TEST/AUDIENCE_TEST/GEO_TEST/LANDING_PAGE_FIX/
// OFFER_TEST/KEEP_TESTING/INSUFFICIENT_DATA) has no direct one-click Meta
// action by design — they are exploratory human decisions routed to the
// existing tools (Creative Factory, Campaign Launch Builder), never
// auto-executed.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getDecryptedToken } from '../metaAuth.js';
import { setEntityStatus } from '../metaGraphClient.js';
import { resolveProductCampaigns } from './productPerformance.js';
import { buildWinningStack, resolveTrackingIdentity } from './productActionPlan.js';

function fail(msg, status = 400) { const e = new Error(msg); e.status = status; throw e; }

/**
 * Every executed decision — real Meta write or not — becomes a trackable
 * Experiment (Phase 9), using the EXACT same AmbActionResult H6/H12/H24
 * checkpoint convention executor.js already uses for campaign/ad-level
 * actions. This is what lets productExperiment.js's evaluator later find
 * and measure it; without this row, a decision would execute but never be
 * measured, which the user's Phase 9 requirement (every approved decision
 * becomes an Experiment) forbids.
 */
async function scheduleExperimentCheckpoints({ rec, actionType, executionStatus, metaResponseJson, userId, evaluationWindowDays }) {
  const action = await prisma.ambAction.create({
    data: {
      recommendation_id: rec.id, mode: 'APPROVAL', action_type: actionType, ad_account_id: rec.ad_account_id,
      level: 'product', entity_id: `product:${rec.amb_product_id}`, entity_name: rec.product_name,
      ai_reason: rec.reason, ai_confidence: rec.confidence,
      approval_status: 'APPROVED', execution_status: executionStatus, executed_by_id: userId || null, executed_at: new Date(),
      meta_response_json: metaResponseJson ?? null,
    },
  });
  const now = Date.now();
  const checkpoints = [
    { action_id: action.id, checkpoint: 'H6', due_at: new Date(now + 6 * 3600 * 1000) },
    { action_id: action.id, checkpoint: 'H12', due_at: new Date(now + 12 * 3600 * 1000) },
    { action_id: action.id, checkpoint: 'H24', due_at: new Date(now + 24 * 3600 * 1000) },
  ];
  // The decision's OWN configured evaluation window (e.g. 7 days for most
  // decisions) — a 4th, longer checkpoint alongside the fixed H6/H12/H24
  // ones, so a real trend has time to form before the final verdict. Same
  // table, same evaluator (evaluateProductExperiments() computes its own
  // before/after span from due_at - executed_at, so this needs no special
  // casing there), just a later due_at.
  const windowDays = Number(evaluationWindowDays) || 7;
  if (windowDays > 1) checkpoints.push({ action_id: action.id, checkpoint: 'EVAL_WINDOW', due_at: new Date(now + windowDays * 24 * 3600 * 1000) });
  await prisma.ambActionResult.createMany({ data: checkpoints, skipDuplicates: true });
  return action;
}

async function loadProductRec(recId) {
  const rec = await prisma.ambRecommendation.findUnique({ where: { id: Number(recId) } });
  if (!rec || rec.level !== 'product') fail('قرار المنتج غير موجود.', 404);
  return rec;
}

async function realProductIdFor(rec) {
  if (!rec.amb_product_id) return null;
  const ambProduct = await prisma.ambProduct.findUnique({ where: { id: rec.amb_product_id }, select: { product_id: true } });
  return ambProduct?.product_id || null;
}

/**
 * The mandatory pre-execution plan — read-only, always safe to call. Names
 * the EXACT real Meta objects a PAUSE_CANDIDATE would affect (never a vague
 * "some campaigns"), or the concrete next-step for every other decision
 * type. This is what the UI's "عرض الخطة قبل التنفيذ" step shows.
 */
/** Decisions that result in a REAL prepared campaign via the existing Launch Builder — a Scale, an Audience Test, a Geo Test, and a Creative Test are all, mechanically, "launch a campaign built from whatever evidence exists" — the ONLY difference is how much of the Winning Stack is proven (a test decision naturally has a sparser proven stack than a scale decision) and the framing text shown to the user. One shared code path, never duplicated per decision type. */
const LAUNCH_BUILDER_DECISIONS = { SCALE_CANDIDATE: 'SCALE', AUDIENCE_TEST: 'AUDIENCE_TEST', GEO_TEST: 'GEO_TEST', NEW_CREATIVE_TEST: 'CREATIVE_TEST' };
const CAMPAIGN_PURPOSE_SUMMARY = {
  SCALE: 'إنشاء مسودة "Scaling Campaign" في رفع الكامبين (Campaign Launch Builder) مبنية على Winning Stack المثبت.',
  AUDIENCE_TEST: 'إنشاء مسودة "اختبار جمهور" في رفع الكامبين — تستخدم أي جمهور مثبت/واعد متاح، وتترك الباقي Broad حتى تكتمل الأدلة.',
  GEO_TEST: 'إنشاء مسودة "اختبار محافظات" في رفع الكامبين — تستخدم أي محافظة مثبتة/واعدة متاحة، وتترك الباقي Broad حتى تكتمل الأدلة.',
  CREATIVE_TEST: 'إنشاء مسودة "اختبار كرياتيف" في رفع الكامبين — تستخدم أي كرياتيف/Hook مثبت متاح حاليًا كمرجع؛ لو محتاج كرياتيف جديد بالكامل، استخدم "مصنع الكرياتيف" بشكل صريح بعد كده — هذا الإجراء لا يشغّل أي توليد مدفوع بالـ AI تلقائيًا أبدًا.',
};

export async function buildExecutionPlan({ recId }) {
  const rec = await loadProductRec(recId);
  const facts = JSON.parse(rec.reason_facts_json || '{}');
  const realProductId = await realProductIdFor(rec);
  const evaluationWindowDays = facts.evaluationWindowDays || 7;

  const base = { decision: rec.decision, productName: rec.product_name, recommendationStatus: rec.status, proposedChange: facts.proposedChange || null, evaluationWindowDays };

  if (rec.decision === 'PAUSE_CANDIDATE') {
    const campaigns = realProductId ? await resolveProductCampaigns(realProductId) : [];
    return {
      ...base, actionKind: 'META_WRITE', realMetaWrite: true,
      summary: campaigns.length ? `إيقاف ${campaigns.length} حملة Meta حقيقية مرتبطة بهذا المنتج (PAUSED).` : 'مفيش حملات Meta حقيقية مرتبطة تُوقَف — القرار ده مش قابل للتنفيذ فعليًا.',
      targets: campaigns.map((c) => ({ campaignId: c.campaignId, adAccountId: c.adAccountId, via: c.via })),
    };
  }
  const campaignPurpose = LAUNCH_BUILDER_DECISIONS[rec.decision];
  if (campaignPurpose) {
    const stack = buildWinningStack(facts.winners);
    const tracking = await resolveTrackingIdentity({ productId: realProductId, adAccountId: rec.ad_account_id });
    const noProvenCreative = !stack.creative;
    return {
      ...base, actionKind: 'LAUNCH_BUILDER_PREFILL', realMetaWrite: false, campaignPurpose,
      summary: `${CAMPAIGN_PURPOSE_SUMMARY[campaignPurpose]} الميزانية/التاريخ/الـ Pixel/الصفحة تُعبّأ تلقائيًا لأنها حقول حقيقية في المعالج، والجمهور/الكرياتيف المثبت (لو موجود) يظهر كمرجع لتطبيقه يدويًا (المعالج الحالي لا يحتوي خطوة استهداف جمهور حقيقية). تحتاج مراجعتك واستكمال باقي خطوات المعالج ثم ضغط "نشر" بنفسك. لا يتم نشر أي حاجة تلقائيًا.`,
      needsCreativeFactory: campaignPurpose === 'CREATIVE_TEST' && noProvenCreative,
      prefill: {
        productId: realProductId,
        winningCreative: stack.creative?.value || null,
        winningHook: stack.hook?.value || null,
        winningAngle: stack.angle?.value || null,
        winningPrimaryText: stack.primaryText?.value || null,
        winningHeadline: stack.headline?.value || null,
        winningSegment: [stack.gender?.value, stack.age?.value].filter(Boolean).join(' / ') || stack.governorate?.value || null,
        winningGovernorate: stack.governorate?.value || null,
        pixelId: tracking.pixel_id || null, pixelName: tracking.pixel_name || null, conversionEvent: tracking.conversion_event || 'PURCHASE',
        pageId: tracking.page_id || null, pageName: tracking.page_name || null,
        instagramId: tracking.instagram_id || null, instagramUsername: tracking.instagram_username || null,
      },
    };
  }
  // KEEP_TESTING / INSUFFICIENT_DATA / LANDING_PAGE_FIX / OFFER_TEST — never
  // a fake campaign. Names the real missing evidence (already computed by
  // the Action Plan's own formingPlan) and states honestly WHEN this gets
  // re-evaluated: the existing 30-min auto-analysis scheduler, or sooner if
  // the human manually re-analyzes.
  return {
    ...base, actionKind: 'MANUAL_NEXT_STEP', realMetaWrite: false,
    summary: facts.proposedChange || 'مفيش إجراء مباشر على Meta لهذا القرار — الخطوة التالية يدوية.',
    nextEvaluation: 'هيتم إعادة تقييم هذا القرار تلقائيًا مع كل تحليل تشغيلي جديد للمنتج (كل ~30 دقيقة)، أو فورًا لو ضغطت "إعادة التحليل" — أي أدلة جديدة (مشتريات/أوردرات إضافية) هتظهر في المرة الجاية.',
  };
}

/**
 * The gated real step. Refuses unless the recommendation is already
 * APPROVED (a separate, earlier, non-executing step) AND the caller passes
 * confirmRealExecution:true explicitly for a real Meta write — this file
 * NEVER defaults that flag, NEVER infers it from approval alone.
 */
export async function executeApprovedDecision({ recId, userId, confirmRealExecution = false, budget = null, startDate = null, startTime = null }) {
  const rec = await loadProductRec(recId);
  if (rec.status !== 'APPROVED') fail(`القرار في حالة ${rec.status} — لازم تتم الموافقة عليه أولاً قبل التنفيذ.`, 409);

  const plan = await buildExecutionPlan({ recId });
  // User-entered budget/start date/time — the ONLY inputs the Action Plan
  // requires from a human — merged into the LAUNCH_BUILDER_PREFILL plan's
  // real prefill object. Never defaulted/guessed; a caller that omits them
  // simply leaves those specific wizard fields for the user to fill inside
  // Launch Builder as before.
  if (plan.actionKind === 'LAUNCH_BUILDER_PREFILL' && plan.prefill) {
    if (budget != null) plan.prefill.budget = Number(budget) || null;
    if (startDate) plan.prefill.startDate = String(startDate);
    if (startTime) plan.prefill.startTime = String(startTime);
  }

  if (plan.actionKind === 'META_WRITE') {
    if (!confirmRealExecution) {
      return { ok: false, requiresConfirmation: true, plan, message: 'هذا الإجراء هيوقف حملات حقيقية شغالة على Meta فعليًا — لازم تأكيد صريح إضافي (confirmRealExecution) قبل أي تنفيذ.' };
    }
    if (!plan.targets.length) fail('مفيش حملات Meta حقيقية مرتبطة — لا يوجد إجراء ممكن.', 400);
    const token = await getDecryptedToken();
    const results = [];
    for (const t of plan.targets) {
      try { await setEntityStatus(token, t.campaignId, 'PAUSED'); results.push({ campaignId: t.campaignId, ok: true }); }
      catch (err) { results.push({ campaignId: t.campaignId, ok: false, error: err.message }); logger.error('[productDecisionExecution] pause failed', { campaignId: t.campaignId, message: err.message }); }
    }
    const allOk = results.every((r) => r.ok);
    // A product-level pause affects MULTIPLE campaigns — AmbAction's
    // entity_id is a required single-entity field (designed for the
    // existing campaign/ad-level flow), so scheduleExperimentCheckpoints()
    // gives it a descriptive product marker; the real per-campaign detail
    // (every id + its own pause result) lives in meta_response_json.
    const action = await scheduleExperimentCheckpoints({ rec, actionType: 'PAUSE', executionStatus: allOk ? 'EXECUTED' : 'FAILED', metaResponseJson: JSON.stringify(results), userId, evaluationWindowDays: plan.evaluationWindowDays });
    await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: allOk ? 'EXECUTED' : rec.status } });
    return { ok: allOk, plan, results, actionId: action.id };
  }

  if (plan.actionKind === 'LAUNCH_BUILDER_PREFILL') {
    if (!confirmRealExecution) {
      return { ok: false, requiresConfirmation: true, plan, message: 'هيتم إنشاء مسودة رفع كامبين جديدة (بدون أي نشر فعلي على Meta) — تأكيد؟' };
    }
    if (!plan.prefill.productId) fail('تعذّر إيجاد المنتج الحقيقي المرتبط لعمل مسودة.', 400);
    const action = await scheduleExperimentCheckpoints({ rec, actionType: 'DRAFT_PRODUCT_DECISION', executionStatus: 'EXECUTED', metaResponseJson: JSON.stringify(plan.prefill), userId, evaluationWindowDays: plan.evaluationWindowDays });
    await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'EXECUTED' } });
    return { ok: true, plan, prefill: plan.prefill, actionId: action.id, message: 'الخطة جاهزة — افتح "رفع الكامبين" واختار نفس المنتج؛ بيانات الكرياتيف/الجمهور الفائز موضّحة هنا كمرجع، والنشر النهائي يدوي بالكامل.' };
  }

  // MANUAL_NEXT_STEP: nothing on Meta for this endpoint to do, but the decision itself still becomes a measurable Experiment (Phase 9) — before/after product performance is compared regardless of whether the human's manual follow-through was on Meta or elsewhere (creative, landing page, offer).
  const action = await scheduleExperimentCheckpoints({ rec, actionType: 'DRAFT_PRODUCT_DECISION', executionStatus: 'EXECUTED', metaResponseJson: null, userId, evaluationWindowDays: plan.evaluationWindowDays });
  await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'EXECUTED' } });
  return { ok: true, plan, actionId: action.id, message: 'تم تسجيل القرار — الخطوة الفعلية (كرياتيف/جمهور/عرض/صفحة) يدوية خارج هذا الإجراء.' };
}
