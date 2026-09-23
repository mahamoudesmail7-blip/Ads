// AI Media Buyer — Product Growth Strategist (Product Growth & Profit
// Intelligence, Phase 3 Slice 4). Answers "المنتج ده مش عارف أطلعه، أعمل
// إيه؟" — a pure READ/COMPOSITION layer over EVERY already-built brain
// (bottleneck waterfall, Profit Brain, Stock Guard, Creative Fatigue Radar,
// Testing Brain, Winning Stack). Never a new evidence threshold: every
// number/verdict here is read from something another module already
// computed. Mandatory EVIDENCE vs HYPOTHESIS separation throughout — a
// hypothesis is always labeled as one, never presented as settled fact.
//
// Root-cause order requested: Auction/CPM -> CTR -> CPC -> LPV -> Business
// Conversion -> CPA -> COD Confirmation -> Delivery -> Returns -> Profit.
// The existing productMarketingScoring.js waterfall already covers CTR
// through Delivery (8 of these stages) via diagnosis.bottleneck — reused
// AS-IS here, never re-derived. Two additions, both deliberately layered on
// TOP rather than edited into that shared core engine (keeps this file's
// blast radius to itself):
//   - CPM/auction health is surfaced as CONTEXT ONLY, never a verdict —
//     productMarketingScoring.js's own header comment explains why: no
//     reviewed CPM threshold exists in this codebase, so calling one
//     "good"/"bad" would be an invented judgement. Never invented here either.
//   - A terminal PROFIT check: when the ad-funnel bottleneck itself finds
//     nothing wrong (HEALTHY_PRODUCT/KEEP_TESTING) but Profit Brain (Slice 1)
//     says the real numbers are still UNPROFITABLE/MARGIN_THIN, THAT becomes
//     the real primary bottleneck — the exact gap that motivated Slice 1's
//     retrofit of prepare_scale in the first place, now surfaced for a
//     product that isn't even being scaled yet.
import { buildTestMatrix, nextBestTest, buildControlledTestDesign } from './testingBrain.js';

const BOTTLENECK_LABEL_AR = {
  CREATIVE_PROBLEM: 'الكرياتيف/جذب الانتباه (CTR)', CREATIVE_FATIGUE: 'إجهاد الكرياتيف',
  TRAFFIC_PROBLEM: 'تكلفة الوصول (CPC)', CONVERSION_PROBLEM: 'التحويل بعد الكليك',
  OFFER_PROBLEM: 'وضوح العرض', CPA_PROBLEM: 'الـCPA الإجمالي',
  CONFIRMATION_PROBLEM: 'تأكيد الأوردرات (COD)', DELIVERY_PROBLEM: 'التسليم (COD)',
  TRACKING_MAPPING_PROBLEM: 'ربط المنتج بحملة حقيقية', INSUFFICIENT_DATA: 'بيانات غير كافية',
  HEALTHY_PRODUCT: 'لا توجد مشكلة واضحة في القمع الإعلاني', PROFIT_PROBLEM: 'الربح الحقيقي رغم سلامة القمع الإعلاني',
};

/** The dimensions the CURRENT bottleneck implicates — reused verbatim from testingBrain.js's own mapping so the Growth Strategist and "أختبر إيه بعد كده؟" never give two different answers to the same question. */
function implicatedDimensions(category) {
  const map = { CREATIVE_PROBLEM: ['CREATIVE', 'HOOK', 'ANGLE'], CREATIVE_FATIGUE: ['CREATIVE', 'HOOK'], TRAFFIC_PROBLEM: ['AUDIENCE'], CONVERSION_PROBLEM: ['OFFER'], OFFER_PROBLEM: ['OFFER'], CPA_PROBLEM: ['CREATIVE', 'AUDIENCE'] };
  return map[category] || [];
}

/**
 * @param {{pkg:object, profitBrain:object, stockGuard:object|null}} params
 *   `pkg` = an already-built buildProductDecisionPackage() result.
 *   `profitBrain` = an already-built classifyProfitState()-shaped result (or null if not computed by the caller).
 * @returns {Promise<object>} the full Recovery Plan structure.
 */
export async function buildGrowthPlan({ productId, pkg, profitBrain, stockGuard }) {
  const { matrix, hasProfile } = await buildTestMatrix({ productId, pkg });
  const next = nextBestTest({ pkg, testMatrix: matrix });
  const design = buildControlledTestDesign({ pkg, next });

  const rawBottleneck = pkg?.diagnosis?.bottleneck;
  // Terminal profit check — only reachable when the ad-funnel itself found nothing wrong.
  const profitOverride = (!rawBottleneck || rawBottleneck.category === 'HEALTHY_PRODUCT')
    && profitBrain && ['UNPROFITABLE', 'MARGIN_THIN'].includes(profitBrain.state);

  const primaryBottleneck = profitOverride
    ? { category: 'PROFIT_PROBLEM', label: BOTTLENECK_LABEL_AR.PROFIT_PROBLEM, confidence: 'HIGH', evidence: `القمع الإعلاني نفسه سليم (${BOTTLENECK_LABEL_AR.HEALTHY_PRODUCT})، لكن الأرقام الحقيقية (إيرادات - تكاليف - صرف) بتقول الحالة ${profitBrain.state === 'UNPROFITABLE' ? 'خسران' : 'هامش ضيق جدًا'}${profitBrain.marginPct != null ? ` (هامش ${profitBrain.marginPct.toFixed(1)}%)` : ''}.` }
    : { category: rawBottleneck?.category || 'INSUFFICIENT_DATA', label: BOTTLENECK_LABEL_AR[rawBottleneck?.category] || rawBottleneck?.category || 'غير محدد', confidence: rawBottleneck?.confidence || 'LOW', evidence: rawBottleneck?.evidence || null };

  // EVIDENCE — every real number already computed elsewhere, never re-derived.
  const evidence = [];
  const m = pkg?.diagnosis?.metrics;
  if (m?.cpm != null) evidence.push(`CPM الحالي ${Math.round(m.cpm)} ج (بدون حكم جودة — مفيش threshold معتمد لـCPM في النظام حتى الآن).`);
  if (m?.ctr != null) evidence.push(`CTR الحالي ${m.ctr.toFixed(2)}%.`);
  if (m?.cpc != null) evidence.push(`CPC الحالي ${m.cpc.toFixed(2)} ج.`);
  if (pkg?.businessConversionRate?.dataState === 'AVAILABLE') evidence.push(`معدل التحويل الحقيقي (Purchase Results/LPV) ${pkg.businessConversionRate.value.toFixed(1)}%.`);
  if (m?.avgCpa != null) evidence.push(`الـCPA الحالي ${Math.round(m.avgCpa)} ج.`);
  if (m?.confirmationRate != null) evidence.push(`نسبة تأكيد الأوردرات ${Math.round(m.confirmationRate * 100)}%.`);
  if (m?.deliveryRate != null) evidence.push(`نسبة التسليم ${Math.round(m.deliveryRate * 100)}%.`);
  if (profitBrain) evidence.push(`حالة الربح الحقيقية: ${profitBrain.state}${profitBrain.marginPct != null ? ` (هامش ${profitBrain.marginPct.toFixed(1)}%)` : ''}.`);

  const whatIsWorking = matrix.filter((e) => e.status === 'WON').map((e) => ({ dimension: e.dimension, key: e.key, evidence: e.evidence }));
  const whatIsNotWorking = matrix.filter((e) => e.status === 'LOST').map((e) => ({ dimension: e.dimension, key: e.key, evidence: e.evidence }));
  const implicated = profitOverride ? ['OFFER'] : implicatedDimensions(primaryBottleneck.category);
  const whatShouldRemainUnchanged = [...new Set(matrix.filter((e) => e.status === 'WON' && !implicated.includes(e.dimension)).map((e) => e.dimension))];

  return {
    productId: pkg.productId, productName: pkg.productName, window: pkg.window,
    currentState: { decision: pkg.decision, health: pkg.health, profitState: profitBrain?.state || null, stockStatus: stockGuard?.status || null },
    primaryBottleneck,
    evidence,
    whatIsWorking, whatIsNotWorking, whatShouldRemainUnchanged,
    // Never leaks raw EVIDENCE text into the HYPOTHESIS field — when there's
    // no proposed test (design is null), there is honestly no unproven
    // hypothesis to state yet; next.note already carries the correctly-
    // worded status ("healthy, no urgent test" / "operational, not a
    // marketing test" / etc.) instead of a fabricated one.
    hypothesis: design?.hypothesis || (profitOverride ? 'المشكلة غالبًا في العرض/السعر/تكلفة المنتج — مش في الإعلان نفسه، لأن القمع الإعلاني سليم.' : next.note || 'محتاج مزيد من الأدلة قبل تحديد فرضية واضحة.'),
    nextTest: next,
    controlledTestDesign: design,
    targeting: { gender: pkg?.winners?.gender || null, age: pkg?.winners?.age || null, governorate: pkg?.winners?.governorate || null },
    angle: pkg?.winners?.angle || null,
    hooks: pkg?.winners?.hook || null,
    offerPriceHypothesis: pkg?.priceTestOpportunity?.detected ? { evidence: pkg.priceTestOpportunity.evidence, proposedChange: pkg.priceTestOpportunity.proposedChange } : null,
    successMetric: pkg.successMetric || design?.successMetric || null,
    sampleRequirement: design?.sampleRequirement || 'على الأقل 5 مشتريات حقيقية قبل أي حكم',
    evaluationWindowDays: pkg.evaluationWindowDays || 7,
    nextPossibleState: profitOverride
      ? 'لو اتحل موضوع العرض/التكلفة وبقى الهامش صحي، ينفع نفكر في Scale أو استمرار عادي.'
      : pkg.decision === 'SCALE_CANDIDATE' ? 'المنتج جاهز فعليًا لـ Scale لو الأدلة والربح والمخزون سليمين.'
      : pkg.decision === 'PAUSE_CANDIDATE' ? 'لو مفيش تحسن حقيقي بعد الاختبار المقترح، الخطوة التالية إيقاف مؤقت.'
      : 'استمر في المراقبة والاختبار المقترح، وأعد التقييم بعد فترة القياس.',
    hasTestingProfile: hasProfile,
  };
}
