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

function fail(msg, status = 400) { const e = new Error(msg); e.status = status; throw e; }

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
export async function buildExecutionPlan({ recId }) {
  const rec = await loadProductRec(recId);
  const facts = JSON.parse(rec.reason_facts_json || '{}');
  const realProductId = await realProductIdFor(rec);

  const base = { decision: rec.decision, productName: rec.product_name, recommendationStatus: rec.status, proposedChange: facts.proposedChange || null };

  if (rec.decision === 'PAUSE_CANDIDATE') {
    const campaigns = realProductId ? await resolveProductCampaigns(realProductId) : [];
    return {
      ...base, actionKind: 'META_WRITE', realMetaWrite: true,
      summary: campaigns.length ? `إيقاف ${campaigns.length} حملة Meta حقيقية مرتبطة بهذا المنتج (PAUSED).` : 'مفيش حملات Meta حقيقية مرتبطة تُوقَف — القرار ده مش قابل للتنفيذ فعليًا.',
      targets: campaigns.map((c) => ({ campaignId: c.campaignId, adAccountId: c.adAccountId, via: c.via })),
    };
  }
  if (rec.decision === 'SCALE_CANDIDATE') {
    return {
      ...base, actionKind: 'LAUNCH_BUILDER_PREFILL', realMetaWrite: false,
      summary: 'إنشاء مسودة جديدة في رفع الكامبين (Campaign Launch Builder) مبنية على الكرياتيف/الجمهور الفائز — تحتاج مراجعتك واستكمال باقي خطوات المعالج ثم ضغط "نشر" بنفسك. لا يتم نشر أي حاجة تلقائيًا.',
      prefill: { productId: realProductId, winningCreative: facts.winners?.creative?.label || null, winningHook: facts.winners?.hook?.label || null, winningSegment: [facts.winners?.gender?.segment, facts.winners?.age?.segment].filter(Boolean).join(' / ') || facts.winners?.governorate?.segment || null },
    };
  }
  return {
    ...base, actionKind: 'MANUAL_NEXT_STEP', realMetaWrite: false,
    summary: facts.proposedChange || 'مفيش إجراء مباشر على Meta لهذا القرار — الخطوة التالية يدوية.',
  };
}

/**
 * The gated real step. Refuses unless the recommendation is already
 * APPROVED (a separate, earlier, non-executing step) AND the caller passes
 * confirmRealExecution:true explicitly for a real Meta write — this file
 * NEVER defaults that flag, NEVER infers it from approval alone.
 */
export async function executeApprovedDecision({ recId, userId, confirmRealExecution = false }) {
  const rec = await loadProductRec(recId);
  if (rec.status !== 'APPROVED') fail(`القرار في حالة ${rec.status} — لازم تتم الموافقة عليه أولاً قبل التنفيذ.`, 409);

  const plan = await buildExecutionPlan({ recId });

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
    const action = await prisma.ambAction.create({
      data: {
        recommendation_id: rec.id, mode: 'APPROVAL', action_type: 'PAUSE', ad_account_id: rec.ad_account_id,
        // A product-level pause affects MULTIPLE campaigns — AmbAction's
        // entity_id is a required single-entity field (designed for the
        // existing campaign/ad-level flow), so it holds a descriptive
        // product marker here; the real per-campaign detail (every id +
        // its own pause result) lives in meta_response_json below.
        level: 'product', entity_id: `product:${rec.amb_product_id}`, entity_name: rec.product_name,
        ai_reason: rec.reason, ai_confidence: rec.confidence,
        approval_status: 'APPROVED', execution_status: allOk ? 'EXECUTED' : 'FAILED', executed_by_id: userId || null,
        meta_response_json: JSON.stringify(results),
      },
    });
    await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: allOk ? 'EXECUTED' : rec.status } });
    return { ok: allOk, plan, results, actionId: action.id };
  }

  if (plan.actionKind === 'LAUNCH_BUILDER_PREFILL') {
    if (!confirmRealExecution) {
      return { ok: false, requiresConfirmation: true, plan, message: 'هيتم إنشاء مسودة رفع كامبين جديدة (بدون أي نشر فعلي على Meta) — تأكيد؟' };
    }
    if (!plan.prefill.productId) fail('تعذّر إيجاد المنتج الحقيقي المرتبط لعمل مسودة.', 400);
    await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'EXECUTED' } });
    return { ok: true, plan, prefill: plan.prefill, message: 'الخطة جاهزة — افتح "رفع الكامبين" واختار نفس المنتج؛ بيانات الكرياتيف/الجمهور الفائز موضّحة هنا كمرجع، والنشر النهائي يدوي بالكامل.' };
  }

  // MANUAL_NEXT_STEP: nothing on Meta for this endpoint to do — acknowledge and close the loop for Phase 9's experiment tracking to pick up later if the human acts on it elsewhere.
  await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'EXECUTED' } });
  return { ok: true, plan, message: 'تم تسجيل القرار — الخطوة الفعلية (كرياتيف/جمهور/عرض/صفحة) يدوية خارج هذا الإجراء.' };
}
