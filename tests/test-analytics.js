// test-analytics.js — Business-logic test cases (spec section 28).
// Covers: daily change, 7D/14D averages, change %, trend detection,
// health score, exit/scale recommendation, missing data, zero orders,
// new products.

import { test, assertEqual, assertClose, assertTrue } from './test-runner.js';
import {
  addDays,
  buildOrdersMap,
  getValue,
  average,
  windowAverage,
  dailyChange,
  baselineChange,
  classifyStatus,
  detectTrend,
  dayOverDayDeclineStreak,
  belowBaselineStreak,
  aboveBaselineStreak,
  zeroOrderDaysInWindow,
  healthScore,
  isNewProduct,
  recommend,
  analyzeProduct,
  TREND,
} from '../js/analytics.js';

const TODAY = '2026-08-16';
const SETTINGS = {
  upThreshold: 15,
  downThreshold: -15,
  criticalThreshold: -35,
  consecutiveDeclineDays: 4,
  exitThreshold: -35,
  exitConsecutiveDays: 4,
  scaleThreshold: 15,
  scaleConsecutiveDays: 3,
  baselinePeriod: 7,
  minDataDaysForTrend: 7,
};

/** Build daily_orders-shaped records for a product. `valuesNewestFirst[0]` is asOfDate,
 * [1] is asOfDate-1, etc. `null` in the array means "no row" (missing data). */
function buildRecords(asOfDate, valuesNewestFirst, productId = 1) {
  const records = [];
  valuesNewestFirst.forEach((v, i) => {
    if (v === null) return; // no data that day
    records.push({ product_id: productId, date: addDays(asOfDate, -i), orders_count: v });
  });
  return records;
}

// ---------------------------------------------------------------------------
// Daily change (section 7)
// ---------------------------------------------------------------------------

test('dailyChange: increase shows +N', () => {
  assertEqual(dailyChange(6, 5), { abs: 1, pct: 20, label: '+1 Order' });
});

test('dailyChange: decrease shows -N', () => {
  const r = dailyChange(4, 5);
  assertEqual(r.abs, -1);
  assertEqual(r.label, '-1 Order');
});

test('dailyChange: no change shows 0', () => {
  const r = dailyChange(5, 5);
  assertEqual(r.abs, 0);
  assertEqual(r.label, '0');
});

test('dailyChange: missing yesterday data returns No Data, not a false -100%', () => {
  const r = dailyChange(6, null);
  assertEqual(r.abs, null);
  assertEqual(r.pct, null);
});

// ---------------------------------------------------------------------------
// Products-table Change/Change% columns (section 5 worked example): abs is
// Today-Yesterday, but the percent is expressed against the 7D baseline.
// ---------------------------------------------------------------------------

test('analyzeProduct.tableChange: matches spec worked example row 1 (6,5,5.1 -> +1, +19.6%)', () => {
  const asOf = TODAY;
  // today=6, yesterday=5, and a 7D baseline (days -1..-7) averaging 5.1
  const records = buildRecords(asOf, [6, 5, 5, 5, 5, 5, 6, 5]); // days -1..-7 sum=36 -> avg 5.142857 (~5.1)
  const analysis = analyzeProduct(records, asOf, SETTINGS);
  assertEqual(analysis.tableChange.abs, 1);
  assertClose(analysis.tableChange.pct, 19.5, 0.5);
});

test('analyzeProduct.tableChange: matches spec worked example row 2 (4,6,6.2 -> -2, -32.2%)', () => {
  const asOf = TODAY;
  const records = buildRecords(asOf, [4, 6, 6, 6, 6, 6, 7, 6]); // days -1..-7 sum=43 -> avg 6.142857 (~6.2)
  const analysis = analyzeProduct(records, asOf, SETTINGS);
  assertEqual(analysis.tableChange.abs, -2);
  assertClose(analysis.tableChange.pct, -32.5, 0.5);
});

// ---------------------------------------------------------------------------
// 7D / 14D averages (section 6) — matches the worked example in the spec:
// last 7 days 5,5,6,4,5,5,6 -> avg 5.142857; today 8 -> change +2.857 (+55.6%)
// ---------------------------------------------------------------------------

test('windowAverage: 7D average matches spec worked example', () => {
  const asOf = TODAY;
  // newest-first: today(8), then the 7 prior days 6,5,5,4,6,5,5
  const records = buildRecords(asOf, [8, 6, 5, 5, 4, 6, 5, 5]);
  const map = buildOrdersMap(records);
  const w7 = windowAverage(map, addDays(asOf, -1), 7); // the 7 days BEFORE today
  assertClose(w7.avg, 36 / 7, 0.001);
});

test('baselineChange: matches spec worked example (+2.86, +55.6%)', () => {
  const baseline = 36 / 7; // 5.142857...
  const r = baselineChange(8, baseline);
  assertClose(r.abs, 2.857, 0.01);
  assertClose(r.pct, 55.56, 0.05);
});

test('windowAverage: 14D average only uses available data when fewer than 14 days exist', () => {
  const asOf = TODAY;
  const records = buildRecords(asOf, [5, 6, 7]); // only 3 days of history
  const map = buildOrdersMap(records);
  const w14 = windowAverage(map, asOf, 14);
  assertEqual(w14.count, 3);
  assertClose(w14.avg, 6, 0.001);
});

// ---------------------------------------------------------------------------
// Change % edge cases
// ---------------------------------------------------------------------------

test('baselineChange: zero baseline does not divide by zero', () => {
  const r = baselineChange(5, 0);
  assertEqual(r.pct, null);
  assertEqual(r.abs, 5);
});

// ---------------------------------------------------------------------------
// Status classification (section 8)
// ---------------------------------------------------------------------------

test('classifyStatus: UP when pct7 >= upThreshold', () => {
  assertEqual(classifyStatus(20, 0, SETTINGS), 'UP');
});

test('classifyStatus: STABLE within -15%..+15%', () => {
  assertEqual(classifyStatus(5, 0, SETTINGS), 'STABLE');
  assertEqual(classifyStatus(-10, 0, SETTINGS), 'STABLE');
});

test('classifyStatus: DOWN when pct7 <= -15%', () => {
  assertEqual(classifyStatus(-20, 0, SETTINGS), 'DOWN');
});

test('classifyStatus: CRITICAL when pct7 <= -35%', () => {
  assertEqual(classifyStatus(-40, 0, SETTINGS), 'CRITICAL');
});

test('classifyStatus: CRITICAL when decline streak reaches threshold even if pct is only DOWN', () => {
  assertEqual(classifyStatus(-20, 4, SETTINGS), 'CRITICAL');
});

// ---------------------------------------------------------------------------
// Trend detection (section 9)
// ---------------------------------------------------------------------------

test('detectTrend: 5,6,7,8,9 -> Strong Uptrend', () => {
  assertEqual(detectTrend([5, 6, 7, 8, 9]), TREND.STRONG_UP);
});

test('detectTrend: 9,8,7,5,4 -> Strong Downtrend', () => {
  assertEqual(detectTrend([9, 8, 7, 5, 4]), TREND.STRONG_DOWN);
});

test('detectTrend: 5,8,4,9,3 -> Volatile / Unstable', () => {
  assertEqual(detectTrend([5, 8, 4, 9, 3]), TREND.VOLATILE);
});

test('detectTrend: fewer than 3 data points -> insufficient', () => {
  assertEqual(detectTrend([5, 6]), TREND.INSUFFICIENT);
});

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

test('dayOverDayDeclineStreak: 9->7->6->4->3 counts 4 consecutive declines', () => {
  const asOf = TODAY;
  const records = buildRecords(asOf, [3, 4, 6, 7, 9]); // newest-first: today=3
  const map = buildOrdersMap(records);
  assertEqual(dayOverDayDeclineStreak(map, asOf), 4);
});

test('dayOverDayDeclineStreak: stops at a missing day', () => {
  const asOf = TODAY;
  const records = buildRecords(asOf, [3, 4, null, 7, 9]);
  const map = buildOrdersMap(records);
  assertEqual(dayOverDayDeclineStreak(map, asOf), 1);
});

test('belowBaselineStreak: 4 days at -35% or worse vs baseline', () => {
  const asOf = TODAY;
  // baseline 10; values at or below 6.5 (-35%) for 4 consecutive days
  const records = buildRecords(asOf, [3, 3, 3, 3, 9, 10, 11]);
  const map = buildOrdersMap(records);
  assertEqual(belowBaselineStreak(map, asOf, 10, -35), 4);
});

test('aboveBaselineStreak: 3 days at +15% or better vs baseline', () => {
  const asOf = TODAY;
  const records = buildRecords(asOf, [8, 7, 6, 5, 5]); // baseline 5 -> +60%,+40%,+20% then breaks
  const map = buildOrdersMap(records);
  assertEqual(aboveBaselineStreak(map, asOf, 5, 15), 3);
});

test('zeroOrderDaysInWindow: counts explicit zeros, not missing days', () => {
  const asOf = TODAY;
  const records = buildRecords(asOf, [0, 5, 0, null, 5, 0, 5]);
  const map = buildOrdersMap(records);
  assertEqual(zeroOrderDaysInWindow(map, asOf, 7), 3);
});

// ---------------------------------------------------------------------------
// Missing data vs explicit zero (section 21)
// ---------------------------------------------------------------------------

test('getValue: distinguishes No Data (null) from an explicit 0', () => {
  const records = buildRecords(TODAY, [0]); // today explicitly logged as 0
  const map = buildOrdersMap(records);
  assertEqual(getValue(map, TODAY), 0);
  assertEqual(getValue(map, addDays(TODAY, -1)), null); // never logged
});

test('average: ignores missing days but includes explicit zeros', () => {
  assertEqual(average([5, null, 0, 5]), 10 / 3);
});

// ---------------------------------------------------------------------------
// New products (section 22)
// ---------------------------------------------------------------------------

test('isNewProduct: true when fewer data points than minDataDaysForTrend', () => {
  assertTrue(isNewProduct(3, 7));
  assertTrue(!isNewProduct(7, 7));
});

test('analyzeProduct: new product gets NEW recommendation, not a false EXIT/SCALE', () => {
  const records = buildRecords(TODAY, [5, 6, 4]); // only 3 days old
  const result = analyzeProduct(records, TODAY, SETTINGS);
  assertTrue(result.isNew);
  assertEqual(result.recommendation.type, 'NEW');
});

// ---------------------------------------------------------------------------
// Health score (section 12)
// ---------------------------------------------------------------------------

test('healthScore: strong uptrend with no decline/zero days scores Excellent', () => {
  const h = healthScore({ pct7: 50, pct14: 40, trendCode: 'STRONG_UP', declineStreak: 0, zeroDays14: 0 });
  assertTrue(h.score >= 80, `expected >=80, got ${h.score}`);
  assertEqual(h.label, 'Excellent');
});

test('healthScore: sustained critical decline scores Exit Candidate / Danger', () => {
  const h = healthScore({ pct7: -60, pct14: -50, trendCode: 'STRONG_DOWN', declineStreak: 5, zeroDays14: 4 });
  assertTrue(h.score < 40, `expected <40, got ${h.score}`);
});

// ---------------------------------------------------------------------------
// Exit recommendation (section 13) — must require SUSTAINED weakness, not one bad day
// ---------------------------------------------------------------------------

test('recommend: EXIT after 4+ consecutive days >=35% below baseline', () => {
  const asOf = TODAY;
  // baseline ~10 from days 5-11 back, then last 4 days crash to 2 (-80%)
  const records = buildRecords(asOf, [2, 2, 2, 2, 10, 10, 10, 10, 10, 10, 10]);
  const analysis = analyzeProduct(records, asOf, SETTINGS);
  assertEqual(analysis.recommendation.type, 'EXIT');
});

test('recommend: a single bad day does NOT trigger EXIT', () => {
  const asOf = TODAY;
  const records = buildRecords(asOf, [1, 10, 10, 10, 10, 10, 10, 10]);
  const analysis = analyzeProduct(records, asOf, SETTINGS);
  assertTrue(analysis.recommendation.type !== 'EXIT', `expected not EXIT, got ${analysis.recommendation.type}`);
});

// ---------------------------------------------------------------------------
// Scale recommendation (section 14) — consistent, not a one-day spike
// ---------------------------------------------------------------------------

test('recommend: SCALE after consistent performance above baseline', () => {
  const asOf = TODAY;
  // baseline ~5 from days 5-11, last 4 days at 8,7,7,8 (well above +15%)
  const records = buildRecords(asOf, [8, 7, 7, 8, 5, 5, 5, 5, 5, 5, 5]);
  const analysis = analyzeProduct(records, asOf, SETTINGS);
  assertEqual(analysis.recommendation.type, 'SCALE');
});

test('recommend: a single good day does NOT trigger SCALE', () => {
  const asOf = TODAY;
  const records = buildRecords(asOf, [20, 5, 5, 5, 5, 5, 5, 5]);
  const analysis = analyzeProduct(records, asOf, SETTINGS);
  assertTrue(analysis.recommendation.type !== 'SCALE', `expected not SCALE, got ${analysis.recommendation.type}`);
});

// ---------------------------------------------------------------------------
// Zero orders should not be treated as "no data" in the pipeline
// ---------------------------------------------------------------------------

test('analyzeProduct: explicit zero orders lowers health score via zeroDays14, distinct from missing data', () => {
  const asOf = TODAY;
  const withZeros = buildRecords(asOf, [0, 0, 0, 0, 5, 5, 5, 5, 5, 5, 5]);
  const withoutZeros = buildRecords(asOf, [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
  const a1 = analyzeProduct(withZeros, asOf, SETTINGS);
  const a2 = analyzeProduct(withoutZeros, asOf, SETTINGS);
  assertTrue(a1.health.score < a2.health.score, 'zero-order days should reduce health score');
});
