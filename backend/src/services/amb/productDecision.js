// Smart Decision Center Phase 6 — Final Product Decision Engine. Combines
// Phase 2 (Unified Product Performance), Phase 3 (Creative/Hook/Angle/Copy
// intelligence), Phase 4 (Audience/Segment intelligence), and Phase 5 (Full
// Funnel Diagnosis) into ONE structured Decision Package per product.
// Deterministic rule-based classification only — no AI call decides the
// verdict itself (matching recommendationEngine.js's own established
// convention: Claude may narrate a reason in a LATER phase, never choose
// the decision). No Meta write anywhere in this file.
import { prisma } from '../../prisma.js';
import { getProductDiagnosis } from './productPerformance.js';
import { creativeIntelForProduct } from './creativeIntel.js';
import { segmentIntelForProduct } from './segmentIntel.js';
import { computeOpportunityScore, healthBand } from './productMarketingScoring.js';

export const PRODUCT_DECISIONS = [
  'SCALE_CANDIDATE', 'KEEP_TESTING', 'NEW_CREATIVE_TEST', 'AUDIENCE_TEST',
  'GEO_TEST', 'LANDING_PAGE_FIX', 'OFFER_TEST', 'PAUSE_CANDIDATE', 'INSUFFICIENT_DATA',
];

function hasWinner(dim) {
  const cls = dim?.best?.classification;
  return cls === 'WINNER' || cls === 'PROVEN_WINNER';
}
function hasPromising(dim) {
  const cls = dim?.best?.classification;
  return cls === 'GOOD' || cls === 'PROMISING';
}

/** A deliberately modest, evidence-grounded proposal — never a full budget-optimization algorithm (out of scope; the real budget change, if approved, is computed at execution time in Phase 8 from the actual current budget). */
function buildScaleProposal(winners, currentSpend) {
  const parts = [];
  if (winners.creative) parts.push(`استمرار على نفس الكرياتيف الفائز (${winners.creative.label?.slice(0, 40) || ''})`);
  if (winners.hook) parts.push(`Hook: ${winners.hook.label?.slice(0, 40) || ''}`);
  if (winners.gender || winners.age) parts.push(`استهداف مشابه لـ${[winners.gender?.segment, winners.age?.segment].filter(Boolean).join(' / ')}`);
  if (winners.governorate) parts.push(`أولوية جغرافية: ${winners.governorate.segment}`);
  const budgetNote = currentSpend > 0 ? `زيادة تدريجية للميزانية (مقترح +30% كبداية، مش قفزة كبيرة) عن الصرف الحالي (${Math.round(currentSpend)} ج/الفترة).` : 'تحديد ميزانية بدء مناسبة بناءً على أداء الاختبار الحالي.';
  return `${parts.join(' + ')}${parts.length ? ' — ' : ''}${budgetNote}`;
}

/**
 * The deterministic decision rule engine — every branch cites the REAL
 * bottleneck/winner/segment evidence that produced it, never a guess.
 * Ordered so an operational (post-Meta) problem is never confused with a
 * marketing problem, and a real winner is never proposed for scale without
 * CONFIRMED-level bottleneck confidence.
 */
export function decideProductAction({ diagnosis, creativeIntel, segmentIntel }) {
  const bottleneck = diagnosis.bottleneck;
  const metaMapped = diagnosis.metrics?.dataAvailability?.metaMapped;
  const spend = diagnosis.metrics?.totalSpend || 0;

  const winners = {
    creative: creativeIntel?.creative?.best || null,
    hook: creativeIntel?.hooks?.best || null,
    angle: creativeIntel?.angles?.best || null,
    primaryText: creativeIntel?.primaryTexts?.best || null,
    headline: creativeIntel?.headlines?.best || null,
    age: segmentIntel?.age?.best || null,
    gender: segmentIntel?.gender?.best || null,
    governorate: segmentIntel?.governorates?.best || null,
  };
  const losers = {
    weakGovernorates: (segmentIntel?.governorates?.table || []).filter((r) => r.classification === 'PROVEN_WEAK').map((r) => ({ segment: r.segment, evidence: r.evidence })),
    weakOrFatiguedCreatives: (creativeIntel?.creative?.table || []).filter((r) => r.classification === 'WEAK' || r.classification === 'FATIGUED').map((r) => ({ label: r.label, classification: r.classification, evidence: r.evidence })),
  };

  const anyCreativeWinner = hasWinner(creativeIntel?.creative) || hasWinner(creativeIntel?.hooks) || hasWinner(creativeIntel?.angles);
  const anyProvenSegment = hasWinner(segmentIntel?.age) || hasWinner(segmentIntel?.gender) || hasWinner(segmentIntel?.governorates);
  const anyPromisingSegment = hasPromising(segmentIntel?.age) || hasPromising(segmentIntel?.gender) || hasPromising(segmentIntel?.governorates);

  let decision, confidence, reason, proposedChange, successMetric;
  const evaluationWindowDays = 7;

  if (!metaMapped) {
    decision = 'INSUFFICIENT_DATA'; confidence = 'LOW';
    reason = 'المنتج غير مربوط بحملات Meta حقيقية بعد — مفيش بيانات أداء تُبنى عليها أي قرار.';
    proposedChange = 'اربط المنتج بحملة Meta حقيقية (رفع كامبين جديد أو تأكيد ربط حملة موجودة) قبل أي قرار.';
    successMetric = null;
  } else if (bottleneck.category === 'CONFIRMATION_PROBLEM' || bottleneck.category === 'DELIVERY_PROBLEM') {
    decision = 'KEEP_TESTING';
    confidence = bottleneck.confidence === 'CONFIRMED' ? 'MEDIUM' : 'LOW';
    reason = `المشكلة الأساسية تشغيلية بعد Meta (${bottleneck.bottleneck}) — مش قرار تسويقي، والتغيير في الإعلان أو الميزانية مش هيحل المشكلة الحقيقية.`;
    proposedChange = bottleneck.action || 'راجع فريق تأكيد/تسليم الأوردرات قبل أي تغيير تسويقي.';
    successMetric = bottleneck.category === 'CONFIRMATION_PROBLEM' ? 'معدل التأكيد الحقيقي' : 'معدل التسليم الحقيقي';
  } else if (bottleneck.category === 'CPA_PROBLEM' && bottleneck.confidence === 'CONFIRMED' && !anyCreativeWinner && !anyProvenSegment && !anyPromisingSegment) {
    decision = 'PAUSE_CANDIDATE'; confidence = 'HIGH';
    reason = `${bottleneck.evidence} — وبدون أي كرياتيف أو شريحة عمر/نوع/جغرافيا مثبتة أو حتى واعدة تبرر استمرار الصرف الحالي.`;
    proposedChange = 'إيقاف الإنفاق الحالي مؤقتًا، وعدم إعادة التشغيل إلا باختبار صغير جديد (كرياتيف أو استهداف مختلف).';
    successMetric = 'CPA';
  } else if (['CREATIVE_PROBLEM', 'CREATIVE_FATIGUE'].includes(bottleneck.category)) {
    decision = 'NEW_CREATIVE_TEST'; confidence = bottleneck.confidence === 'CONFIRMED' ? 'HIGH' : 'MEDIUM';
    reason = bottleneck.evidence;
    proposedChange = 'اختبار Hook/كرياتيف جديد بدون تغيير الاستهداف أو الميزانية الأساسية أولاً.';
    successMetric = 'CTR';
  } else if (bottleneck.category === 'TRAFFIC_PROBLEM') {
    decision = 'AUDIENCE_TEST'; confidence = 'MEDIUM';
    reason = bottleneck.evidence;
    proposedChange = anyPromisingSegment ? `اختبار الاستهداف نحو الشريحة الواعدة (${[winners.gender?.segment, winners.age?.segment].filter(Boolean).join('/') || winners.governorate?.segment || '—'}).` : 'اختبار استهداف/جمهور مختلف قبل زيادة الميزانية.';
    successMetric = 'CPC';
  } else if (bottleneck.category === 'CONVERSION_PROBLEM') {
    decision = 'LANDING_PAGE_FIX'; confidence = bottleneck.confidence === 'CONFIRMED' ? 'HIGH' : 'MEDIUM';
    reason = bottleneck.evidence;
    proposedChange = 'مراجعة صفحة المنتج/وضوح العرض — التوقف الحقيقي بعد الإعلان، مش فيه.';
    successMetric = 'معدل التحويل (Conversion Rate)';
  } else if (bottleneck.category === 'OFFER_PROBLEM') {
    decision = 'OFFER_TEST'; confidence = 'MEDIUM';
    reason = bottleneck.evidence;
    proposedChange = 'اختبار عرض/فايدة أساسية مختلفة موضحة في الكرياتيف.';
    successMetric = 'معدل التحويل';
  } else if (bottleneck.category === 'CPA_PROBLEM') {
    decision = 'KEEP_TESTING'; confidence = 'MEDIUM';
    reason = `${bottleneck.evidence} — لكن يوجد كرياتيف أو شريحة بإشارة إيجابية (${anyCreativeWinner ? 'كرياتيف' : ''}${anyCreativeWinner && (anyProvenSegment || anyPromisingSegment) ? ' و' : ''}${(anyProvenSegment || anyPromisingSegment) ? 'شريحة' : ''}) تستحق استمرار الاختبار قبل الإيقاف.`;
    proposedChange = 'الاستمرار بنفس الميزانية مع التركيز على العناصر الأفضل أداءً، ومراجعة تانية بعد فترة التقييم.';
    successMetric = 'CPA';
  } else if (bottleneck.category === 'HEALTHY_PRODUCT' || !bottleneck.category) {
    if (anyCreativeWinner && bottleneck.confidence === 'CONFIRMED') {
      decision = 'SCALE_CANDIDATE'; confidence = 'HIGH';
      reason = `المنتج صحي (${bottleneck.evidence || 'لا توجد مشكلة واضحة من الأرقام الحالية'}) ويوجد كرياتيف و/أو شريحة مثبتة الأداء بعينة قوية.`;
      proposedChange = buildScaleProposal(winners, spend);
      successMetric = 'صافي الربح / CPA';
    } else if (!anyCreativeWinner) {
      decision = 'NEW_CREATIVE_TEST'; confidence = 'LOW';
      reason = 'المنتج صحي على مستوى الأرقام العامة، لكن مفيش كرياتيف مثبت بأداء قوي كفاية للتوسع عليه بثقة.';
      proposedChange = 'اختبار كرياتيفات/Hooks جديدة لبناء عينة أقوى قبل أي توسع.';
      successMetric = 'عدد الكرياتيفات اللي توصل WINNER';
    } else {
      decision = 'KEEP_TESTING'; confidence = 'MEDIUM';
      reason = 'إشارات إيجابية موجودة لكن العينة أو ثقة التشخيص لسه مش كافية لقرار توسع واثق.';
      proposedChange = 'الاستمرار بنفس الإعدادات لفترة تقييم إضافية قبل أي قرار توسع أو إيقاف.';
      successMetric = 'حجم العينة (صرف/مشتريات)';
    }
  } else {
    decision = 'KEEP_TESTING'; confidence = 'LOW';
    reason = bottleneck.evidence || 'لا يوجد نمط واضح كافٍ لقرار أقوى من المتابعة.';
    proposedChange = 'الاستمرار مع المراقبة.';
    successMetric = 'CPA';
  }

  return {
    decision, confidence, reason,
    bottleneck: { category: bottleneck.category, confidence: bottleneck.confidence, evidence: bottleneck.evidence, competingSignals: bottleneck.competingSignals || [] },
    winners, losers,
    proposedChange, successMetric, failureMetric: successMetric,
    evaluationWindowDays,
  };
}

/**
 * The full Phase 6 Decision Package for one product: Health Score (existing
 * computeOpportunityScore/healthBand), Phase 5's funnel diagnosis, Phase 3's
 * creative/hook/angle winners, Phase 4's segment winners, and the final
 * deterministic decision — everything the Smart Decision Center UI (Phase
 * 7) needs in one call. Never persists anything by itself; see
 * persistProductDecision() below for that, kept separate so a caller can
 * preview a package without writing a row.
 */
export async function buildProductDecisionPackage({ productId, windowName, settings, adAccountId }) {
  const diagnosis = await getProductDiagnosis({ productId, windowName, settings });

  const ambProduct = await prisma.ambProduct.findUnique({ where: { product_id: Number(productId) }, select: { id: true } });
  const product = await prisma.product.findUnique({ where: { id: Number(productId) }, select: { store_id: true } });

  const [creativeIntel, segmentIntel] = await Promise.all([
    ambProduct && adAccountId
      ? creativeIntelForProduct({ adAccountId, windowName, settings, ambProductId: ambProduct.id, compareToPrior: true }).catch(() => ({ dataAvailable: false }))
      : Promise.resolve({ dataAvailable: false }),
    segmentIntelForProduct({ productId: Number(productId), storeId: product?.store_id || null, adAccountId, windowName, settings }).catch(() => ({ metaAvailable: false, age: {}, gender: {}, governorates: {} })),
  ]);

  const opportunity = computeOpportunityScore({ metrics: diagnosis.metrics, settings });
  const health = { score: opportunity.score, label: opportunity.label, band: healthBand(opportunity.score, opportunity.dataSufficient), components: opportunity.components, dataSufficient: opportunity.dataSufficient };

  const action = decideProductAction({ diagnosis, creativeIntel, segmentIntel });

  return {
    productId: diagnosis.productId,
    productName: diagnosis.productName,
    window: diagnosis.window,
    health,
    diagnosis: { bottleneck: diagnosis.bottleneck, allSignals: diagnosis.diagnosis, metrics: diagnosis.metrics },
    creativeIntel,
    segmentIntel,
    decision: action.decision,
    confidence: action.confidence,
    reason: action.reason,
    evidence: action.bottleneck.evidence || action.reason,
    sampleSize: diagnosis.metrics.metaPurchases ?? 0,
    winners: action.winners,
    losers: action.losers,
    proposedChange: action.proposedChange,
    successMetric: action.successMetric,
    failureMetric: action.failureMetric,
    evaluationWindowDays: action.evaluationWindowDays,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Persists a Decision Package as an AmbRecommendation row at level='product'
 * — reuses the EXISTING model/lifecycle rather than a new table. Never
 * executable at this phase (action_type stays a DRAFT_* value); Phase 8
 * translates an APPROVED package into a real, separately-approved AmbAction
 * through the existing execution pipeline.
 */
/**
 * Smart Decision Center Phase 7 — the inbox listing. Groups every persisted
 * product-level AmbRecommendation by the exact 6 views requested:
 * جاهز للقرار / قيد جمع البيانات / تمت الموافقة / مرفوض / قيد القياس / مكتمل.
 * Read-only, reuses the existing AmbRecommendation model — no new table.
 */
export async function listDecisionCenter() {
  const rows = await prisma.ambRecommendation.findMany({
    where: { level: 'product' },
    orderBy: { created_at: 'desc' },
    include: { actions: { include: { results: true }, orderBy: { created_at: 'desc' }, take: 1 } },
  });

  const buckets = { ready: [], collecting: [], approved: [], rejected: [], measuring: [], completed: [] };
  for (const r of rows) {
    const facts = JSON.parse(r.reason_facts_json || '{}');
    const card = {
      id: r.id,
      productName: r.product_name,
      ambProductId: r.amb_product_id,
      decision: r.decision,
      confidence: r.confidence,
      reason: r.reason,
      health: facts.health || null,
      bottleneck: facts.bottleneck || null,
      winners: facts.winners || null,
      losers: facts.losers || null,
      proposedChange: facts.proposedChange || null,
      successMetric: facts.successMetric || null,
      evaluationWindowDays: facts.evaluationWindowDays || null,
      status: r.status,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at,
      lastAction: r.actions[0] ? { id: r.actions[0].id, executionStatus: r.actions[0].execution_status, resultsCount: r.actions[0].results.length } : null,
    };
    const hasExperimentOutcome = r.actions[0]?.results?.some((res) => res.result_class != null);
    if (r.status === 'PENDING' && r.decision === 'INSUFFICIENT_DATA') buckets.collecting.push(card);
    else if (r.status === 'PENDING') buckets.ready.push(card);
    else if (r.status === 'APPROVED') buckets.approved.push(card);
    else if (r.status === 'REJECTED') buckets.rejected.push(card);
    else if (r.status === 'EXECUTED' && hasExperimentOutcome) buckets.completed.push(card);
    else if (r.status === 'EXECUTED') buckets.measuring.push(card);
  }
  return buckets;
}

/** Approve ONLY — never executes. The mandatory approval gate before Phase 8's execution-plan step even becomes reachable. */
export async function approveProductDecision({ recId, userId }) {
  const rec = await prisma.ambRecommendation.findUnique({ where: { id: Number(recId) } });
  if (!rec || rec.level !== 'product') { const e = new Error('قرار المنتج غير موجود.'); e.status = 404; throw e; }
  if (rec.status !== 'PENDING') { const e = new Error(`القرار في حالة ${rec.status} — مش قابل للموافقة.`); e.status = 409; throw e; }
  return prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'APPROVED', reviewed_by_id: userId || null, reviewed_at: new Date() } });
}

/** Owner "تعديل الخطة" — free-text edits to the proposed change / success metric, stored the same way applyEdit() stores budget edits (edited_json), but for product-decision fields instead of a budget. */
export async function editProductDecision({ recId, patch, userId }) {
  const rec = await prisma.ambRecommendation.findUnique({ where: { id: Number(recId) } });
  if (!rec || rec.level !== 'product') { const e = new Error('قرار المنتج غير موجود.'); e.status = 404; throw e; }
  if (rec.status !== 'PENDING') { const e = new Error('القرار مش قابل للتعديل في حالته الحالية.'); e.status = 409; throw e; }
  const facts = JSON.parse(rec.reason_facts_json || '{}');
  if (patch.proposedChange != null) facts.proposedChange = String(patch.proposedChange).slice(0, 1000);
  if (patch.successMetric != null) facts.successMetric = String(patch.successMetric).slice(0, 200);
  return prisma.ambRecommendation.update({
    where: { id: rec.id },
    data: { reason_facts_json: JSON.stringify(facts), edited_json: JSON.stringify({ patch, by: userId, at: new Date().toISOString() }) },
  });
}

export async function persistProductDecision({ pkg, adAccountId, batchId, changeReasons }) {
  const ambProduct = await prisma.ambProduct.findUnique({ where: { product_id: pkg.productId }, select: { id: true } });
  return prisma.ambRecommendation.create({
    data: {
      batch_id: batchId || `product-decision-${Date.now()}`,
      ad_account_id: adAccountId || 'unknown',
      amb_product_id: ambProduct?.id || null,
      product_name: pkg.productName,
      level: 'product',
      decision: pkg.decision,
      action_type: 'DRAFT_PRODUCT_DECISION',
      executable: false,
      current_metrics_json: JSON.stringify(pkg.diagnosis.metrics),
      reason: pkg.reason,
      reason_facts_json: JSON.stringify({
        bottleneck: pkg.diagnosis.bottleneck, winners: pkg.winners, losers: pkg.losers,
        health: pkg.health, proposedChange: pkg.proposedChange, successMetric: pkg.successMetric,
        evaluationWindowDays: pkg.evaluationWindowDays, sampleSize: pkg.sampleSize,
        ...(changeReasons?.length ? { changeReasons } : {}),
      }),
      confidence: pkg.confidence,
      data_sufficiency: pkg.health.dataSufficient ? 'STRONG' : 'WEAK',
      priority: pkg.decision === 'PAUSE_CANDIDATE' ? 'P0' : pkg.decision === 'SCALE_CANDIDATE' ? 'P1' : 'P2',
      time_window_from: pkg.window.from, time_window_to: pkg.window.to, time_window_label: pkg.window.label,
      source: 'FALLBACK', // deterministic rule engine, not a Claude call — matches recommendationEngine.js's own vocabulary for a non-AI-authored decision
      status: 'PENDING',
    },
  });
}
