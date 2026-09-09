// AI Creative Factory — ImageQualityService.
//
// Reviews ONE composed image against the plan item, the approved copy, the
// Product DNA and the REFERENCE photos. Quality priority (spec §17):
//   1 Product Accuracy  2 Product Identity  3 Realism  4 Composition
//   5 Marketing Clarity 6 Visual Quality    7 Correct Usage  8 Text Layout
//   9 Claim Safety
// A beautiful image with the WRONG product never passes. It also classifies
// the dominant failure (FAILURE_CODES) so retries are targeted, and applies
// "good enough" logic so we don't chase 96 when 91 with a correct product is
// already shippable. When the text AI is unavailable it never fabricates
// scores and never auto-approves.
import { callAiJson } from './textAi.js';
import { prisma } from '../../prisma.js';
import { QUALITY_DIMENSIONS, FAILURE_CODES } from './taxonomy.js';
import { getEffectiveThresholds } from './thresholds.js';

const SCORE_KEYS = QUALITY_DIMENSIONS.map((d) => d.key);

const SYSTEM = `أنت Quality Controller صارم لكرياتيفات التجارة الإلكترونية. تقارن الصورة المولّدة بالصور المرجعية للمنتج.
أولوية الحكم: (1) تطابق المنتج (2) هوية المنتج (3) الواقعية/عدم مظهر الـ AI (4) التكوين (5) وضوح الرسالة (6) الجودة البصرية (7) صحة الاستخدام (8) الادعاءات.
قواعد:
- لو المنتج في الصورة يختلف عن المرجع في الشكل/اللون/عدد الأزرار/التفاصيل/الملحقات/الاتجاه ⇒ درجات تطابق وهوية منخفضة و identity_mismatch=true. صورة جميلة بمنتج غلط = رسوب.
- realism_score: "هل عميل عادي هيشك فورًا إنها AI؟" ابحث عن: هندسة غريبة، بشرة بلاستيك، أيدي غلط، ظلال مستحيلة، انعكاسات وهمية، أجسام ملتوية، رموز عشوائية، تكرار أجسام، عناصر طايرة، مبالغة في المثالية.
- looks_ai_generated: true/false.
- صنّف السبب الأساسي للرسوب في failure_code من: ${FAILURE_CODES.join(', ')} (OK لو ناجحة).
- كن ناقدًا لكن لا تعاقب على فروق جمالية بسيطة إذا المنتج مطابق والواقعية عالية.
- النص العربي على الصورة يُضاف لاحقًا بمحرك خاص؛ قيّم فقط إن كانت هناك مساحة نص نظيفة (text_layout_ok) ولا تعاقب على غياب النص.`;

function neutralReview(reason) {
  const scores = Object.fromEntries(SCORE_KEYS.map((k) => [k, null]));
  return {
    scores, overall: null, realism: null, passed: false,
    identity_mismatch: null, looks_ai: null, failure_code: 'OK',
    failure_reasons: [reason], recommendation: 'NEEDS_HUMAN_REVIEW', judge_model: null,
  };
}

/**
 * @param {object} p
 * @param {Buffer} p.assetBuffer   the COMPOSED image bytes (product + our Arabic overlay)
 * @param {object} p.item          plan item
 * @param {object} p.copy          approved copy
 * @param {object} p.product
 * @param {object} p.dna
 * @param {object} p.project
 * @param {Array<{buffer,mime,label}>} [p.references]
 */
export async function reviewImage({ assetBuffer, assetMime = 'image/png', item, copy, product, dna, project, references = [] }) {
  if (!assetBuffer?.length) return neutralReview('لا توجد بيانات صورة للمراجعة.');
  const th = await getEffectiveThresholds();

  const images = [
    { buffer: assetBuffer, mime: assetMime, label: 'الصورة المولّدة (محل التقييم):' },
    ...references.slice(0, 4).map((r, i) => ({ ...r, label: `مرجع ${i + 1}: ${r.label || ''}` })),
  ];

  const ai = await callAiJson({
    system: SYSTEM,
    user: `عنصر الخطة: ${JSON.stringify({ purpose: item?.purpose, angle: item?.marketing_angle || item?.angle, scene: item?.scene, camera: item?.camera_plan || item?.camera_angle, product_position: item?.product_position })}
هوية المنتج (DNA): ${JSON.stringify(dna?.data || dna || {}).slice(0, 1900)}
المواصفات: ${(product?.specifications || '—').slice(0, 500)}
الادعاءات المسموح بها: ${(product?.allowed_claims || '—').slice(0, 300)}
قيود الفئة: ${((dna?.data || dna || {}).category_safety_rules || []).join(' / ') || '—'}
النوع: ${project?.project_type}

أعد JSON بالضبط:
{
 "scores": { ${SCORE_KEYS.map((k) => `"${k}": 0`).join(', ')} },
 "realism_score": 0,
 "looks_ai_generated": false,
 "identity_mismatch": false,
 "text_layout_ok": true,
 "failure_code": "OK",
 "failure_reasons": ["سبب مختصر واضح"],
 "recommendation": "APPROVE | REGENERATE | NEEDS_HUMAN_REVIEW"
}`,
    images,
    maxTokens: 950,
  });

  if (!ai.ok || !ai.data?.scores) return neutralReview(ai.reason || 'تعذّر تقييم الصورة آليًا.');

  const scores = {};
  for (const k of SCORE_KEYS) scores[k] = clamp(ai.data.scores[k]);
  const present = SCORE_KEYS.map((k) => scores[k]).filter((v) => v !== null);
  const overall = present.length ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) : null;
  const realism = clamp(ai.data.realism_score);
  const identityMismatch = ai.data.identity_mismatch === true;
  const looksAi = ai.data.looks_ai_generated === true;
  const failureCode = FAILURE_CODES.includes(ai.data.failure_code) ? ai.data.failure_code : 'OK';
  const productAcc = scores.product_accuracy_score ?? 0;
  const claimOk = (scores.claim_score ?? 0) >= 95;

  // ---- gate (spec §17) ----
  let passed =
    overall !== null &&
    productAcc >= th.productAccuracyThreshold &&
    !identityMismatch &&
    (realism === null || realism >= th.realismThreshold) &&
    !looksAi &&
    (!th.claimComplianceMustPass || claimOk) &&
    (scores.artifact_score ?? 100) >= 60;

  // ---- "good enough" (spec §18) — product + realism solid, only minor
  //      aesthetic/composition gap keeping overall a few points under bar ----
  const goodEnough =
    !passed &&
    !identityMismatch && !looksAi && claimOk &&
    productAcc >= th.productAccuracyThreshold &&
    (realism ?? 0) >= th.realismThreshold &&
    overall !== null && overall >= (th.qualityThreshold - th.goodEnoughMargin) &&
    ['OK', 'BAD_COMPOSITION', 'MISSING_DETAIL'].includes(failureCode);
  if (goodEnough) passed = true;

  return {
    scores, overall, realism,
    identity_mismatch: identityMismatch, looks_ai: looksAi,
    text_layout_ok: ai.data.text_layout_ok !== false,
    failure_code: passed ? 'OK' : failureCode,
    passed,
    good_enough: goodEnough,
    failure_reasons: Array.isArray(ai.data.failure_reasons) ? ai.data.failure_reasons.slice(0, 8) : [],
    recommendation: passed ? 'APPROVE' : (ai.data.recommendation || 'REGENERATE'),
    judge_model: 'anthropic',
  };
}

/** Persist a review row for an asset and return it. */
export async function saveReview(assetId, review) {
  const s = review.scores || {};
  const payload = {
    overall_score: review.overall ?? null,
    product_accuracy_score: s.product_accuracy_score ?? null,
    identity_score: s.identity_score ?? null,
    visual_quality_score: s.visual_quality_score ?? null,
    composition_score: s.composition_score ?? null,
    product_visibility_score: s.product_visibility_score ?? null,
    marketing_score: s.marketing_score ?? null,
    arabic_text_score: s.arabic_text_score ?? null,
    text_readability_score: s.text_readability_score ?? null,
    claim_score: s.claim_score ?? null,
    artifact_score: s.artifact_score ?? null,
    reference_consistency_score: s.reference_consistency_score ?? null,
    plan_compliance_score: s.plan_compliance_score ?? null,
    passed: !!review.passed,
    failure_reasons_json: JSON.stringify({ code: review.failure_code, realism: review.realism, identityMismatch: review.identity_mismatch, looksAi: review.looks_ai, goodEnough: review.good_enough, reasons: review.failure_reasons || [] }),
    recommendation: review.recommendation || null,
    review_output_json: JSON.stringify(review),
    judge_model: review.judge_model || null,
  };
  return prisma.cfQualityReview.upsert({
    where: { asset_id: assetId },
    create: { asset_id: assetId, ...payload },
    update: payload,
  });
}

function clamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}
