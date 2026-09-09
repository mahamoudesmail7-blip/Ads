// AI Creative Factory — ImageQualityService.
//
// Automatic evaluation of ONE generated image across 12 dimensions (0–100),
// against the plan item, the approved copy, the Product DNA and the
// reference photos. Uses Claude vision when configured. When AI is NOT
// available it does NOT invent scores and does NOT auto-approve — it returns
// passed:false with recommendation 'NEEDS_HUMAN_REVIEW' so nothing ships
// unverified.
import { callAiJson } from './textAi.js';
import { StorageService } from './storage.js';
import { prisma } from '../../prisma.js';
import { QUALITY_DIMENSIONS } from './taxonomy.js';
import { getEffectiveThresholds } from './thresholds.js';

const SCORE_KEYS = QUALITY_DIMENSIONS.map((d) => d.key);

const SYSTEM = `أنت مراجع جودة كرياتيفات صارم. قيّم الصورة المولّدة مقابل: عناصر الخطة، النص المعتمد، هوية المنتج (DNA)، والصور المرجعية.
أعطِ لكل بُعد درجة من 0 إلى 100. كن ناقدًا: أي تشويه في المنتج، اختلاف لون/شكل عن المرجع، نص عربي مكسور، أو ادعاء غير مدعوم = درجة منخفضة.
لا تجامل. اذكر أسباب الرسوب بوضوح وباختصار.`;

function neutralReview(reason) {
  const scores = Object.fromEntries(SCORE_KEYS.map((k) => [k, null]));
  return {
    scores,
    overall: null,
    passed: false,
    failure_reasons: [reason],
    recommendation: 'NEEDS_HUMAN_REVIEW',
    judge_model: null,
  };
}

/**
 * @param {object} p
 * @param {Buffer} p.assetBuffer   the generated image bytes
 * @param {string} p.assetMime
 * @param {object} p.item          plan item
 * @param {object} p.copy          approved copy
 * @param {object} p.product
 * @param {object} p.dna
 * @param {object} p.project
 * @param {Array<{buffer,mime,label}>} [p.references]
 * @returns {Promise<{scores,overall,passed,failure_reasons,recommendation,judge_model}>}
 */
export async function reviewImage({ assetBuffer, assetMime = 'image/png', item, copy, product, dna, project, references = [] }) {
  if (!assetBuffer?.length) return neutralReview('لا توجد بيانات صورة للمراجعة.');

  const th = await getEffectiveThresholds();
  const images = [
    { buffer: assetBuffer, mime: assetMime, label: 'الصورة المولّدة (محل التقييم):' },
    ...references.slice(0, 4).map((r) => ({ ...r, label: `مرجع: ${r.label || ''}` })),
  ];

  const ai = await callAiJson({
    system: SYSTEM,
    user: `عنصر الخطة: ${JSON.stringify({ purpose: item?.purpose, angle: item?.angle, scene: item?.scene, camera_angle: item?.camera_angle, composition: item?.composition })}
النص المعتمد: ${JSON.stringify({ hook: copy?.hook, supporting_line: copy?.supporting_line, cta: copy?.cta })}
هوية المنتج (DNA): ${JSON.stringify(dna?.data || dna || {}).slice(0, 1800)}
المواصفات: ${(product?.specifications || '—').slice(0, 500)}
الادعاءات المسموح بها: ${(product?.allowed_claims || '—').slice(0, 300)}
النوع: ${project?.project_type} | كثافة النص: ${project?.text_density}

أعد JSON بالضبط:
{ "scores": { ${SCORE_KEYS.map((k) => `"${k}": 0`).join(', ')} },
  "failure_reasons": ["..."],
  "recommendation": "APPROVE | REGENERATE | NEEDS_HUMAN_REVIEW" }`,
    images,
    maxTokens: 900,
  });

  if (!ai.ok || !ai.data?.scores) return neutralReview(ai.reason || 'تعذّر تقييم الصورة آليًا.');

  const scores = {};
  for (const k of SCORE_KEYS) scores[k] = clamp(ai.data.scores[k]);
  const present = SCORE_KEYS.map((k) => scores[k]).filter((v) => v !== null);
  const overall = present.length ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) : null;

  const claimOk = scores.claim_score === null ? false : scores.claim_score >= 100 - 1e-9 || scores.claim_score >= 95;
  const passed =
    overall !== null &&
    overall >= th.qualityThreshold &&
    (scores.product_accuracy_score ?? 0) >= th.productAccuracyThreshold &&
    (!th.claimComplianceMustPass || claimOk);

  return {
    scores,
    overall,
    passed,
    failure_reasons: Array.isArray(ai.data.failure_reasons) ? ai.data.failure_reasons.slice(0, 8) : [],
    recommendation: passed ? 'APPROVE' : (ai.data.recommendation || 'REGENERATE'),
    judge_model: 'anthropic',
  };
}

/** Persist a review row for an asset and return it. */
export async function saveReview(assetId, review) {
  const s = review.scores || {};
  return prisma.cfQualityReview.upsert({
    where: { asset_id: assetId },
    create: {
      asset_id: assetId,
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
      failure_reasons_json: JSON.stringify(review.failure_reasons || []),
      recommendation: review.recommendation || null,
      review_output_json: JSON.stringify(review),
      judge_model: review.judge_model || null,
    },
    update: {
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
      failure_reasons_json: JSON.stringify(review.failure_reasons || []),
      recommendation: review.recommendation || null,
      review_output_json: JSON.stringify(review),
      judge_model: review.judge_model || null,
    },
  });
}

function clamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}
