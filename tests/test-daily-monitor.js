// test-daily-monitor.js — Daily Product Monitor tests (spec sections
// 5-22, 27, 30-31). classifyDailyStatus is tested against hand-built
// analyzeProduct()-shaped objects so each branch can be isolated
// precisely; weekly/same-day comparisons are tested against real
// analyzeProduct-style daily_orders records.
import { test, assertEqual, assertClose, assertTrue } from './test-runner.js';
import {
  computeShare,
  rankByOrders,
  rankByGrowth,
  rankByPerformance,
  biggestAbsoluteChange,
  classifyDailyStatus,
  buildDailyFocus,
  weeklyComparison,
  sameDayLastWeek,
} from '../js/daily-monitor.js';
import { addDays, todayStr } from '../js/analytics.js';

const SETTINGS = { upThreshold: 15, downThreshold: -15, criticalThreshold: -35, consecutiveDeclineDays: 4 };
const TODAY = '2026-08-17';

function fakeA(overrides) {
  return {
    isNew: false,
    today: 5,
    yesterday: 5,
    avg7: 5,
    baseline: { pct: 0 },
    declineStreak: 0,
    change: { abs: 0 },
    trend: { code: 'STABLE' },
    ...overrides,
  };
}

function bundle(name, aOverrides, extra = {}) {
  return { product: { product_name: name }, a: fakeA(aOverrides), ...extra };
}

// ---------------------------------------------------------------------------
// Share %
// ---------------------------------------------------------------------------

test('computeShare: matches spec worked example (20/100 -> 20%)', () => {
  assertEqual(computeShare(20, 100), 20);
});

test('computeShare: total of 0 or missing today returns null, not a divide-by-zero artifact', () => {
  assertEqual(computeShare(5, 0), null);
  assertEqual(computeShare(null, 100), null);
});

// ---------------------------------------------------------------------------
// Rankings — three independent views (section 57)
// ---------------------------------------------------------------------------

test('rankByOrders: highest today first, no-data products sort last and unranked', () => {
  const bundles = [bundle('A', { today: 10 }), bundle('B', { today: 20 }), bundle('C', { today: null }), bundle('D', { today: 15 })];
  const ranked = rankByOrders(bundles);
  assertEqual(ranked.map((b) => b.product.product_name), ['B', 'D', 'A', 'C']);
  assertEqual(ranked[0].rank, 1);
  assertEqual(ranked[2].rank, 3);
  assertEqual(ranked[3].rank, null);
});

test('rankByGrowth: highest change% first, independent of raw order volume', () => {
  const bundles = [bundle('LowVolHighGrowth', { tableChange: { pct: 200 } }), bundle('HighVolLowGrowth', { tableChange: { pct: 20 } })];
  const ranked = rankByGrowth(bundles);
  assertEqual(ranked[0].product.product_name, 'LowVolHighGrowth');
});

test('rankByPerformance: uses Health Score, independent of order volume or share', () => {
  const bundles = [bundle('A', { health: { score: 40 } }), bundle('B', { health: { score: 90 } })];
  const ranked = rankByPerformance(bundles);
  assertEqual(ranked[0].product.product_name, 'B');
});

test('biggestAbsoluteChange: matches spec worked examples (3->10 = +7, 15->7 = -8)', () => {
  const bundles = [bundle('A', { change: { abs: 7 }, yesterday: 3 }), bundle('B', { change: { abs: -8 }, yesterday: 15 }), bundle('C', { change: { abs: 1 }, yesterday: 5 })];
  const up = biggestAbsoluteChange(bundles, 'up');
  const down = biggestAbsoluteChange(bundles, 'down');
  assertEqual(up.product.product_name, 'A');
  assertEqual(down.product.product_name, 'B');
});

// ---------------------------------------------------------------------------
// Daily status — all 9 states
// ---------------------------------------------------------------------------

test('classifyDailyStatus: NEW overrides everything else', () => {
  assertEqual(classifyDailyStatus(fakeA({ isNew: true, today: 0, avg7: 100 }), SETTINGS).code, 'NEW');
});

test('classifyDailyStatus: explicit zero after a real baseline -> STOPPED (not treated as missing data)', () => {
  assertEqual(classifyDailyStatus(fakeA({ today: 0, avg7: 8 }), SETTINGS).code, 'STOPPED');
});

test('classifyDailyStatus: sudden one-day collapse (>=50% day-over-day, >=35% below baseline) -> SHARP_DECLINE even with a streak of 1', () => {
  const a = fakeA({ today: 3, yesterday: 10, change: { abs: -7 }, baseline: { pct: -60 }, declineStreak: 1 });
  assertEqual(classifyDailyStatus(a, SETTINGS).code, 'SHARP_DECLINE');
});

test('classifyDailyStatus: matches spec worked example (12,11,13,12,4 -> -66.7%) as a sudden sharp decline', () => {
  const a = fakeA({ today: 4, yesterday: 12, change: { abs: -8 }, baseline: { pct: -55 }, declineStreak: 1 });
  assertEqual(classifyDailyStatus(a, SETTINGS).code, 'SHARP_DECLINE');
});

test('classifyDailyStatus: 4+ day decline streak -> SHARP_DECLINE (matches spec "تراجع تدريجي" escalating to حاد)', () => {
  const a = fakeA({ today: 6, yesterday: 7, change: { abs: -1 }, baseline: { pct: -20 }, declineStreak: 4 });
  assertEqual(classifyDailyStatus(a, SETTINGS).code, 'SHARP_DECLINE');
});

test('classifyDailyStatus: 2-3 day decline streak -> EARLY_DECLINE ("بداية تراجع")', () => {
  const a = fakeA({ today: 8, yesterday: 9, change: { abs: -1 }, baseline: { pct: -10 }, declineStreak: 2 });
  assertEqual(classifyDailyStatus(a, SETTINGS).code, 'EARLY_DECLINE');
});

test('classifyDailyStatus: strong uptrend + far above baseline -> STRONG_GROWTH', () => {
  const a = fakeA({ trend: { code: 'STRONG_UP' }, baseline: { pct: 45 } });
  assertEqual(classifyDailyStatus(a, SETTINGS).code, 'STRONG_GROWTH');
});

test('classifyDailyStatus: moderately above baseline -> IMPROVING', () => {
  const a = fakeA({ baseline: { pct: 20 } });
  assertEqual(classifyDailyStatus(a, SETTINGS).code, 'IMPROVING');
});

test('classifyDailyStatus: far below baseline (no streak yet) -> DECLINING', () => {
  const a = fakeA({ baseline: { pct: -40 } });
  assertEqual(classifyDailyStatus(a, SETTINGS).code, 'DECLINING');
});

test('classifyDailyStatus: mildly below baseline -> WATCH', () => {
  const a = fakeA({ baseline: { pct: -20 } });
  assertEqual(classifyDailyStatus(a, SETTINGS).code, 'WATCH');
});

test('classifyDailyStatus: low, quiet volume near its own (low) baseline -> WEAK', () => {
  const a = fakeA({ avg7: 2, today: 2, baseline: { pct: 0 } });
  assertEqual(classifyDailyStatus(a, SETTINGS).code, 'WEAK');
});

test('classifyDailyStatus: on-baseline, healthy volume -> STABLE', () => {
  const a = fakeA({ avg7: 10, today: 10, baseline: { pct: 2 } });
  assertEqual(classifyDailyStatus(a, SETTINGS).code, 'STABLE');
});

test('classifyDailyStatus: erratic trend but today near its own baseline -> VOLATILE, not STABLE', () => {
  const a = fakeA({ avg7: 6, today: 5, baseline: { pct: -9 }, declineStreak: 1, trend: { code: 'VOLATILE' } });
  assertEqual(classifyDailyStatus(a, SETTINGS).code, 'VOLATILE');
});

test('classifyDailyStatus: VOLATILE trend never overrides an already-urgent branch (e.g. a real sharp decline stays SHARP_DECLINE)', () => {
  const a = fakeA({ today: 3, yesterday: 10, change: { abs: -7 }, baseline: { pct: -60 }, declineStreak: 1, trend: { code: 'VOLATILE' } });
  assertEqual(classifyDailyStatus(a, SETTINGS).code, 'SHARP_DECLINE');
});

// ---------------------------------------------------------------------------
// Daily Focus (max 5, urgent + notable mix, never a flat single-metric top-N)
// ---------------------------------------------------------------------------

test('buildDailyFocus: caps at 5 even with more candidates', () => {
  const codes = ['STOPPED', 'SHARP_DECLINE', 'EARLY_DECLINE', 'STRONG_GROWTH', 'WATCH', 'DECLINING', 'WEAK'];
  const bundles = codes.map((c, i) => ({ product: { product_name: `P${i}` }, dailyStatus: { code: c } }));
  const focus = buildDailyFocus(bundles, 5);
  assertEqual(focus.length, 5);
});

test('buildDailyFocus: urgent negatives (STOPPED/SHARP_DECLINE) outrank a positive (STRONG_GROWTH)', () => {
  const bundles = [
    { product: { product_name: 'Growing' }, dailyStatus: { code: 'STRONG_GROWTH' } },
    { product: { product_name: 'Stopped' }, dailyStatus: { code: 'STOPPED' } },
  ];
  const focus = buildDailyFocus(bundles, 5);
  assertEqual(focus[0].product.product_name, 'Stopped');
});

test('buildDailyFocus: excludes STABLE and NEW products — focus is for things that need eyes on them', () => {
  const bundles = [
    { product: { product_name: 'Stable' }, dailyStatus: { code: 'STABLE' } },
    { product: { product_name: 'NewProd' }, dailyStatus: { code: 'NEW' } },
  ];
  assertEqual(buildDailyFocus(bundles, 5).length, 0);
});

// ---------------------------------------------------------------------------
// Weekly comparisons
// ---------------------------------------------------------------------------

function recordsForLastNDays(asOfDate, n, value) {
  const records = [];
  for (let i = 0; i < n; i++) records.push({ product_id: 1, date: addDays(asOfDate, -i), orders_count: value });
  return records;
}

test('weeklyComparison: this week vs last week totals and % change', () => {
  // days 0-6 (this week) = 10/day = 70; days 7-13 (last week) = 5/day = 35 -> +100%
  const records = [...recordsForLastNDays(TODAY, 7, 10), ...Array.from({ length: 7 }, (_, i) => ({ product_id: 1, date: addDays(TODAY, -(i + 7)), orders_count: 5 }))];
  const { thisWeek, lastWeek, changePct } = weeklyComparison(records, TODAY);
  assertEqual(thisWeek, 70);
  assertEqual(lastWeek, 35);
  assertClose(changePct, 100, 0.01);
});

test('weeklyComparison: no data at all for a week returns null, not a fabricated 0', () => {
  const { lastWeek, changePct } = weeklyComparison(recordsForLastNDays(TODAY, 7, 10), TODAY);
  assertEqual(lastWeek, null);
  assertEqual(changePct, null);
});

test('sameDayLastWeek: matches a specific weekday 7 days back, not just "yesterday"', () => {
  const records = [
    { product_id: 1, date: TODAY, orders_count: 12 },
    { product_id: 1, date: addDays(TODAY, -7), orders_count: 8 },
  ];
  const { today, lastWeekSameDay, changeAbs, changePct } = sameDayLastWeek(records, TODAY);
  assertEqual(today, 12);
  assertEqual(lastWeekSameDay, 8);
  assertEqual(changeAbs, 4);
  assertClose(changePct, 50, 0.01);
});

test('sameDayLastWeek: missing same-day-last-week data returns null change, not a false comparison', () => {
  const records = [{ product_id: 1, date: TODAY, orders_count: 12 }];
  const { changeAbs, changePct } = sameDayLastWeek(records, TODAY);
  assertEqual(changeAbs, null);
  assertEqual(changePct, null);
});
