// decision-engine.js — Smart Decision Engine (spec: "نظام عملي لاتخاذ قرارات
// يومية"). Pure functions, no DOM/IndexedDB, no percentages in any OUTPUT.
//
// This module invents no new thresholds and computes no orders/averages/
// trend itself — those numbers are already computed and tested in
// analytics.js (analyzeProduct) and layered by daily-monitor.js
// (classifyDailyStatus) and recommendation-engine.js (buildRecommendationV2).
// All this module does is map those already-tested signals onto ONE of five
// plain-Arabic suggested actions, plus a short human note and a confidence
// level. That mapping is itself multi-day by construction: dailyStatus and
// v2.type already fold in decline streaks / sustained-baseline comparisons,
// so a single good/bad day can never alone flip the action (spec worked
// example: today>yesterday but still below the 7D baseline must NOT read as
// an immediate "زوّد الميزانية").
//
// ABSOLUTE RULE (stated repeatedly by the user): this module only ever
// returns a suggested action as TEXT. Nothing in this codebase executes a
// budget change, pause, edit, or delete — the user always acts manually.

export const ACTION = {
  SCALE_UP: { code: 'SCALE_UP', label: '🔥 زوّد الميزانية' },
  REDUCE: { code: 'REDUCE', label: '🟡 قلل الميزانية' },
  REVIEW_NOW: { code: 'REVIEW_NOW', label: '🚨 راجع فورًا' },
  STOP_CANDIDATE: { code: 'STOP_CANDIDATE', label: '⛔ مرشح لإيقاف الحملة' },
  CONTINUE: { code: 'CONTINUE', label: '🟢 استمر كما أنت' },
  INSUFFICIENT_DATA: { code: 'INSUFFICIENT_DATA', label: '🆕 بيانات غير كافية' },
};

export const CONFIDENCE = {
  HIGH: 'عالية',
  MEDIUM: 'متوسطة',
  LOW: 'منخفضة',
};

function deriveAction(a, dailyStatusCode, v2Type) {
  if (a.isNew) return ACTION.INSUFFICIENT_DATA;

  // Explicit stop / exit-level signals take priority over everything else.
  if (v2Type === 'EXIT' || dailyStatusCode === 'STOPPED') return ACTION.STOP_CANDIDATE;

  // Sustained/sharp decline, or the profit layer flagging it needs a fix.
  if (dailyStatusCode === 'SHARP_DECLINE' || v2Type === 'FIX') return ACTION.REVIEW_NOW;

  // Early or ongoing weakness that isn't yet a crisis.
  if (dailyStatusCode === 'EARLY_DECLINE' || dailyStatusCode === 'DECLINING' || dailyStatusCode === 'WATCH') {
    return ACTION.REDUCE;
  }

  // Real, multi-day-confirmed growth (dailyStatus already requires this),
  // AND today specifically ticked up vs yesterday.
  if (
    (dailyStatusCode === 'STRONG_GROWTH' || dailyStatusCode === 'IMPROVING') &&
    a.change.abs !== null &&
    a.change.abs > 0
  ) {
    return ACTION.SCALE_UP;
  }

  return ACTION.CONTINUE;
}

/** Low when data is scarce (spec requirement) — never invents certainty it doesn't have. */
function confidenceLevel(a) {
  if (a.isNew) return CONFIDENCE.LOW;
  if (a.trend.code === 'VOLATILE') return CONFIDENCE.MEDIUM;
  if (a.totalDataPoints < 14) return CONFIDENCE.MEDIUM;
  return CONFIDENCE.HIGH;
}

function ordersWord(n) {
  return Math.abs(n) === 1 ? 'أوردر' : 'أوردرات';
}

/**
 * Short, plain-Arabic note. Deliberately never mentions a percentage —
 * percentages (a.baseline.pct) are read here only to DECIDE the wording,
 * never printed. Explicitly handles the "improved vs yesterday but still
 * below normal baseline" nuance so a one-day uptick on a still-weak product
 * isn't reported as an unqualified win.
 */
function buildNote(a, dailyStatusCode, action, inventoryStatus) {
  if (a.isNew) return 'منتج جديد — البيانات المتاحة غير كافية لاتخاذ قرار موثوق بعد.';

  const { today, yesterday } = a;
  const diff = a.change.abs;

  if (today === 0 && a.avg7 !== null && a.avg7 > 0) {
    return '🚨 المنتج لم يحقق أي أوردر النهارده رغم أن له نشاط طبيعي — يحتاج مراجعة فورية.';
  }
  if (today === null || yesterday === null || diff === null) {
    return 'البيانات غير مكتملة لمقارنة اليوم بالأمس.';
  }

  // Strong performance + low/critical stock is its own urgent signal (spec
  // section 17) — surfacing it here means a SCALE_UP suggestion never reads
  // as "just increase spend" while the product is about to run out.
  const stockWarning = action?.code === 'SCALE_UP' && (inventoryStatus === 'LOW' || inventoryStatus === 'CRITICAL')
    ? ' 🚨 لكن المخزون منخفض — راجع المخزون قبل زيادة الميزانية.'
    : '';

  const belowBaseline = a.baseline.pct !== null && a.baseline.pct < -10;

  if (diff > 0 && belowBaseline) {
    return `تحسن عن أمس بـ${diff} ${ordersWord(diff)}، لكن الأداء ما زال أقل من مستواه الطبيعي — راقب المنتج قبل زيادة الميزانية بقوة.`;
  }
  if (diff > 0) {
    return `المنتج تحسن اليوم بـ${diff} ${ordersWord(diff)} مقارنة بأمس.${stockWarning}`;
  }
  if (diff < 0) {
    const abs = Math.abs(diff);
    return `المنتج فقد ${abs} ${ordersWord(abs)} اليوم مقارنة بأمس ويحتاج متابعة.`;
  }
  if (dailyStatusCode === 'WEAK') {
    return 'المنتج ثابت لكنه بحجم أوردرات منخفض أصلاً.';
  }
  return 'المنتج ثابت اليوم بدون تغيير عن أمس.';
}

function buildReason(a, action) {
  const parts = [];
  if (a.declineStreak >= 2) parts.push(`تراجع لمدة ${a.declineStreak} أيام متتالية`);
  if (action.code === 'SCALE_UP') parts.push('أداء اليوم أعلى من أمس وعند مستواه الطبيعي أو أعلى منه');
  if (action.code === 'STOP_CANDIDATE' && a.today === 0) parts.push('توقف تام عن تحقيق أوردرات اليوم');
  if (parts.length === 0) parts.push('بناءً على مقارنة اليوم بأمس وبمتوسط آخر 7 أيام');
  return parts.join(' — ');
}

/**
 * @param {object} a analyzeProduct() result (analytics.js)
 * @param {{code:string,icon:string,label:string}} dailyStatus classifyDailyStatus() result (daily-monitor.js)
 * @param {string} v2Type buildRecommendationV2().type (recommendation-engine.js)
 * @param {object|null} [inventory] optional analyzeProductInventory() result (inventory.js) — enables the "strong performance but low stock" caution (spec section 17)
 * @returns {{status:object, trend:string, action:object, note:string, reason:string, confidence:string}}
 */
export function analyzeProductDecision(a, dailyStatus, v2Type, inventory = null) {
  const action = deriveAction(a, dailyStatus.code, v2Type);
  return {
    status: dailyStatus,
    trend: a.trend.code,
    action,
    note: buildNote(a, dailyStatus.code, action, inventory?.status ?? null),
    reason: buildReason(a, action),
    confidence: confidenceLevel(a),
  };
}

/**
 * Careful, NON-CAUSAL next-day follow-up (the system never claims a
 * decision caused an outcome — only that they coincided). Recomputed
 * retroactively from full order history rather than requiring a persisted
 * log of past suggestions: pass in the decision computed with
 * asOfDate = yesterday, and today's analyzeProduct() result.
 */
export function buildFollowUp(yesterdayDecision, todayA) {
  if (!yesterdayDecision || todayA.change.abs === null) return null;
  const diff = todayA.change.abs;
  const action = yesterdayDecision.action.code;

  if (action === 'SCALE_UP') {
    if (diff >= 0) return '✅ الأداء استمر أو تحسّن بعد قرار زيادة الميزانية بالأمس.';
    return '⚠️ تزامن التراجع اليوم مع قرار زيادة الميزانية بالأمس — راجع السبب قبل أي زيادة إضافية.';
  }
  if (action === 'REDUCE' || action === 'REVIEW_NOW') {
    if (diff > 0) return '✅ تحسّن الأداء اليوم بعد قرار تقليل الميزانية/المراجعة بالأمس.';
    if (diff < 0) return '⚠️ تزامن استمرار التراجع مع القرار السابق — قد يحتاج المنتج قرارًا أقوى.';
    return 'الأداء لم يتغير منذ القرار السابق.';
  }
  if (action === 'STOP_CANDIDATE') {
    if (todayA.today !== null && todayA.today > 0) {
      return 'ℹ️ المنتج رجع يسجل أوردرات بعد أن كان مرشحًا للإيقاف بالأمس — راقبه قبل اتخاذ قرار نهائي.';
    }
    return 'المنتج ما زال بدون أوردرات — القرار السابق (مرشح لإيقاف الحملة) ما زال قائمًا.';
  }
  return null;
}
