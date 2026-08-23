// product-score.js — Product Score (0-100), a pure order-behavior score
// distinct from recommendation-engine.js's `productScore()` (which blends
// Health Score + PROFIT margin + return rate for the Ranking page). This
// one deliberately never touches money — it exists purely to answer "how
// is this product's ORDER activity doing right now", built entirely from
// fields analyzeProduct() (analytics.js) already computes and the 33
// original tests already cover: today, yesterday, avg7, trend,
// declineStreak, zeroDays14, baseline.pct. No random numbers, no new
// thresholds invented outside of the 0-100 weighting below.
//
// Weights (sum to 100), each independently explainable in the breakdown
// (spec section 17 — shown only on click, never inline):
//   25  Today vs Yesterday (day-over-day movement)
//   20  Today vs 7D baseline (sustained performance, not just today)
//   20  Trend shape (STRONG_UP/STABLE/VOLATILE/STRONG_DOWN)
//   15  Consistency (penalizes volatile/declining trend shapes)
//   10  No zero-order days in the last 14
//   10  No active day-over-day decline streak

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function dayOverDayComponent(a) {
  if (a.today === null) return 0;
  if (a.yesterday === null || a.yesterday === 0) {
    // No usable prior day to compare against — neutral credit if there's
    // at least some activity today, otherwise none.
    return a.today > 0 ? 15 : 0;
  }
  const pctChange = (a.change.abs / a.yesterday) * 100;
  return Math.round(clamp(12.5 + pctChange / 4, 0, 25));
}

function baselineComponent(a) {
  if (a.baseline.pct === null) return 10; // no baseline yet — neutral, not penalized
  return Math.round(clamp(10 + a.baseline.pct / 5, 0, 20));
}

function trendComponent(a) {
  const map = { STRONG_UP: 20, STABLE: 12, VOLATILE: 6, STRONG_DOWN: 0, INSUFFICIENT: 10 };
  return map[a.trend.code] ?? 10;
}

function consistencyComponent(a) {
  if (a.trend.code === 'VOLATILE') return 3;
  if (a.trend.code === 'STRONG_DOWN') return 6;
  return 15;
}

function zeroDaysComponent(a) {
  return Math.round(clamp(10 - a.zeroDays14 * 3, 0, 10));
}

function declineStreakComponent(a) {
  return Math.round(clamp(10 - a.declineStreak * 2.5, 0, 10));
}

const SCORE_LEVELS = [
  { min: 90, label: '🔥 ممتاز', color: 'green' },
  { min: 80, label: '🟢 قوي جدًا', color: 'green' },
  { min: 70, label: '🟢 جيد', color: 'green' },
  { min: 60, label: '🟡 متوسط', color: 'yellow' },
  { min: 40, label: '🟠 ضعيف', color: 'yellow' },
  { min: 20, label: '🔴 ضعيف جدًا', color: 'red' },
  { min: 0, label: '🚨 خطر', color: 'red' },
];

function levelFor(score) {
  return SCORE_LEVELS.find((l) => score >= l.min);
}

/**
 * @param {object} a an analyzeProduct() result (analytics.js) — never mutated, never re-derives its inputs
 * @returns {{score:number|null, label:string, color:string, breakdown:{label:string, points:number, max:number}[]}}
 */
export function calculateProductScore(a) {
  if (a.isNew) {
    return { score: null, label: '🆕 جديد', color: 'gray', breakdown: [] };
  }

  const breakdown = [
    { label: 'أداء اليوم مقارنة بأمس', points: dayOverDayComponent(a), max: 25 },
    { label: 'الأداء مقابل متوسط 7 أيام', points: baselineComponent(a), max: 20 },
    { label: 'الاتجاه العام', points: trendComponent(a), max: 20 },
    { label: 'ثبات الأداء (عدم التذبذب)', points: consistencyComponent(a), max: 15 },
    { label: 'عدم وجود أيام بدون أوردر', points: zeroDaysComponent(a), max: 10 },
    { label: 'عدم وجود تراجع متتالي', points: declineStreakComponent(a), max: 10 },
  ];

  const score = clamp(Math.round(breakdown.reduce((s, b) => s + b.points, 0)), 0, 100);
  const level = levelFor(score);

  return { score, label: level.label, color: level.color, breakdown };
}
