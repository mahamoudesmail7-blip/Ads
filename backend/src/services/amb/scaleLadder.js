// AI Media Buyer — Scale Ladder (Product Growth & Profit Intelligence,
// Phase 3 Slice 11). An OPERATIONAL VISUALIZATION, deliberately not a rigid
// state machine (the spec's own words) — derived entirely from signals
// already computed elsewhere (the real decision, Testing Brain's matrix,
// Creative Fatigue Radar, Profit Brain). No new evidence threshold, no new
// persisted stage — recomputed fresh every read, so it can never drift out
// of sync with the real underlying data the way a separately-stored stage
// column could.
//
// Deliberate simplification: BUMP_1 vs BUMP_2 would need a real ad-set-
// level bump count for this product, which has no clean product-scoped
// query today (AmbRecommendation's bump rows are ad-set-level, and
// AssistantTask has no indexed product_id) — inventing one would be a new,
// untested query path. Both collapse into a single "already validated,
// ready for the existing prepare_bump/prepare_scale flow" reading instead
// of a false precision this file can't actually back with real evidence.
const STAGE_ORDER = ['NEW', 'TESTING', 'SIGNAL_FOUND', 'VALIDATED', 'SCALE_CAMPAIGN', 'STABLE', 'FATIGUE', 'REFRESH'];
const TESTING_DECISIONS = new Set(['NEW_CREATIVE_TEST', 'AUDIENCE_TEST', 'GEO_TEST', 'OFFER_TEST', 'KEEP_TESTING']);

export function resolveScaleLadderStage({ pkg, testMatrix, profitBrain, creativeFatigueStates = [] }) {
  const category = pkg?.diagnosis?.bottleneck?.category;
  const decision = pkg?.decision;
  const anyWon = (testMatrix || []).some((e) => e.status === 'WON');
  const anyFatigued = creativeFatigueStates.includes('FATIGUED');
  const anySoftening = creativeFatigueStates.some((s) => s === 'WATCH' || s === 'FATIGUING');

  if (category === 'TRACKING_MAPPING_PROBLEM' || category === 'INSUFFICIENT_DATA') {
    return { stage: 'NEW', reason: 'مفيش بيانات حقيقية كافية لسه — المنتج لسه في أول الطريق.', next: 'TESTING', blockers: ['صرف/أوردرات حقيقية كافية للحكم'] };
  }

  if (decision === 'PAUSE_CANDIDATE') {
    return { stage: 'REFRESH', reason: 'الأداء الحالي ضعيف بدون دليل واعد يبرر الاستمرار — يحتاج مراجعة كاملة قبل أي محاولة تانية.', next: 'TESTING', blockers: ['كرياتيف أو استهداف جديد قبل إعادة المحاولة'] };
  }

  if (decision === 'SCALE_CANDIDATE') {
    if (anyFatigued) {
      return { stage: 'FATIGUE', reason: 'المنتج مثبت الأداء، لكن الكرياتيف الفائز بدأ يتعب فعليًا.', next: 'REFRESH', blockers: ['كرياتيف/Hook بديل مع تثبيت نفس الزاوية والجمهور'] };
    }
    if (profitBrain?.state === 'PROFITABLE' && !anySoftening) {
      return { stage: 'STABLE', reason: 'الأداء والربح مستقرين حاليًا بدون علامات تعب أو خطر.', next: 'SCALE_CAMPAIGN', blockers: [] };
    }
    return {
      stage: 'VALIDATED', reason: 'المنتج وصل لقرار SCALE_CANDIDATE الحقيقي — جاهز لخطوة Scale/Bump.',
      next: 'SCALE_CAMPAIGN', blockers: profitBrain && !['PROFITABLE', 'MARGIN_THIN'].includes(profitBrain.state) ? [`الربح الحقيقي لسه ${profitBrain.state} — راجع قبل التوسع الكبير`] : [],
    };
  }

  if (anyWon) {
    return { stage: 'SIGNAL_FOUND', reason: 'فيه بُعد واحد أو أكتر أثبت نفسه فعلاً (WON)، لكن القرار الكلي لسه مش SCALE_CANDIDATE.', next: 'VALIDATED', blockers: ['المزيد من الأدلة على باقي الأبعاد', 'تأكيد العنق الحالي: ' + (category || 'غير محدد')] };
  }

  if (TESTING_DECISIONS.has(decision)) {
    return { stage: 'TESTING', reason: 'المنتج بيجمع أدلة حاليًا (قرار حالي: ' + decision + ').', next: 'SIGNAL_FOUND', blockers: ['نتيجة واضحة (WON) على بُعد واحد على الأقل'] };
  }

  return { stage: 'NEW', reason: 'مفيش دليل كافٍ لسه لتحديد مرحلة أوضح.', next: 'TESTING', blockers: ['صرف/أوردرات حقيقية كافية للحكم'] };
}

export { STAGE_ORDER };
