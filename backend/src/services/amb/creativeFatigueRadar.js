// AI Media Buyer — Creative Fatigue Radar (Product Growth & Profit
// Intelligence, Phase 3 Slice 2). Answers "الكرياتيف بدأ يتعب؟" with a
// graduated state instead of creativeIntel.js's binary FATIGUED verdict.
// Pure relabeling over ALREADY-computed evidence — classifyCandidate()'s own
// classification/signalStrength and the SAME prior-window CTR ratio its
// FATIGUED gate already uses — never a new threshold invented from scratch.
// Same house pattern as productActionPlan.js's ladderStatus(): a richer,
// progressive display over a verdict that's already fully evidence-gated.

/**
 * @param {{ctr:number|null}} row current-window row (ctr already computed by groupAdsByKey)
 * @param {{ctr:number|null, dataSufficiency:string}|null} priorRow same-shape prior-window row, or null when unavailable
 * @param {{classification:string, signalStrength:string, evidence:string}} verdict classifyCandidate()'s own already-computed result for this row
 * @returns {{state:string, evidence:string}}
 */
export function classifyFatigueRadar(row, priorRow, verdict) {
  const { classification, signalStrength } = verdict;

  // The two states classifyCandidate() already evidence-gates hard — never re-derived, just passed through.
  if (classification === 'INSUFFICIENT_DATA') return { state: 'INSUFFICIENT_DATA', evidence: verdict.evidence };
  if (classification === 'FATIGUED') return { state: 'FATIGUED', evidence: verdict.evidence };

  if (!priorRow) {
    // No trend data yet — only a current-snapshot read is possible.
    if (classification === 'WINNER' || classification === 'GOOD') {
      return { state: 'HEALTHY', evidence: 'أداء جيد حاليًا، لسه مفيش بيانات فترة سابقة للمقارنة.' };
    }
    if (signalStrength === 'EARLY_SIGNAL' || signalStrength === 'OBSERVED') {
      return { state: 'NEW', evidence: 'كرياتيف جديد نسبيًا — لسه بيجمع بيانات كافية للحكم عليه.' };
    }
    return { state: 'LEARNING', evidence: 'لسه بيتجمع بيانات كافية للحكم على الأداء.' };
  }

  const ctrRatio = (row?.ctr != null && priorRow.ctr) ? row.ctr / priorRow.ctr : null;
  const softening = ctrRatio != null && ctrRatio < 0.95; // a real early decline, still short of the hard 15%-drop FATIGUED cliff

  if (classification === 'WINNER' || classification === 'GOOD') {
    if (softening) {
      return { state: 'WATCH', evidence: `CTR بدأ يقل شوية عن الفترة اللي فاتت (${Math.round(ctrRatio * 100)}% من قبل) — لسه فايز، بس يستاهل متابعة.` };
    }
    return { state: 'HEALTHY', evidence: 'الأداء مستقر أو بيتحسن مقارنة بالفترة اللي فاتت.' };
  }

  // classification is TESTING or WEAK here (FATIGUED/INSUFFICIENT_DATA already returned above).
  if (softening) {
    return { state: 'FATIGUING', evidence: `الأداء بيتراجع مقارنة بالفترة اللي فاتت (CTR ${Math.round(ctrRatio * 100)}% من قبل) — لسه مش وصل لحد الإجهاد الكامل.` };
  }
  return { state: 'LEARNING', evidence: 'لسه بيتجمع بيانات كافية للحكم على الأداء.' };
}
