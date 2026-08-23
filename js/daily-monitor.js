// daily-monitor.js — Daily Product Monitor layer. Pure functions, no
// DOM/IndexedDB. Composes over analyzeProduct() results (analytics.js,
// untouched) across ALL of today's products to answer questions a single
// product's analysis can't: how big a slice of today is this product,
// where does it rank, and a richer day-to-day status vocabulary than the
// four-state UP/STABLE/DOWN/CRITICAL used for the core recommendation
// engine. This module is purely additive — nothing here feeds back into
// analytics.js, profit.js, inventory.js, or recommendation-engine.js, so
// none of their tests are affected.
import { addDays, buildOrdersMap, getValue } from './analytics.js';

// ---------------------------------------------------------------------------
// Share of today's total
// ---------------------------------------------------------------------------

export function computeShare(todayValue, totalToday) {
  if (todayValue === null || totalToday === null || totalToday === 0) return null;
  return (todayValue / totalToday) * 100;
}

// ---------------------------------------------------------------------------
// Rankings — kept as three DISTINCT views on purpose (spec section 57):
// orders volume, growth %, and quality-of-performance are different
// questions and answering one does not answer the others.
// ---------------------------------------------------------------------------

/** Ranked by raw orders today, highest first. Products with no data today sort last, unranked. */
export function rankByOrders(bundles) {
  const withToday = bundles.filter((b) => b.a.today !== null).sort((x, y) => y.a.today - x.a.today);
  const withoutToday = bundles.filter((b) => b.a.today === null);
  return [...withToday.map((b, i) => ({ ...b, rank: i + 1 })), ...withoutToday.map((b) => ({ ...b, rank: null }))];
}

/** Ranked by day-over-day change %, highest first (spec section 12: shown alongside the absolute change so a 1→3 move can't outrank a 15→18 move misleadingly). */
export function rankByGrowth(bundles) {
  return bundles.filter((b) => b.a.tableChange.pct !== null).sort((x, y) => y.a.tableChange.pct - x.a.tableChange.pct);
}

/** Ranked by the existing Health Score (analytics.js) — reused as-is as the "Performance Score" (spec section 51 deliberately keeps this distinct from Share % and from raw Change %). */
export function rankByPerformance(bundles) {
  return [...bundles].sort((x, y) => y.a.health.score - x.a.health.score);
}

export function biggestAbsoluteChange(bundles, direction) {
  const withChange = bundles.filter((b) => b.a.change.abs !== null && b.a.yesterday !== null);
  if (withChange.length === 0) return null;
  const sorted = [...withChange].sort((x, y) => (direction === 'up' ? y.a.change.abs - x.a.change.abs : x.a.change.abs - y.a.change.abs));
  const top = sorted[0];
  const abs = top.a.change.abs;
  if (direction === 'up' && abs <= 0) return null;
  if (direction === 'down' && abs >= 0) return null;
  return top;
}

// ---------------------------------------------------------------------------
// Daily status — a richer 9-state vocabulary for the day-to-day monitor
// (spec section 27), layered on top of analyzeProduct()'s existing
// status/trend/streak fields rather than replacing them.
// ---------------------------------------------------------------------------

export const DAILY_STATUS = {
  STRONG_GROWTH: { code: 'STRONG_GROWTH', icon: '🔥', label: 'نمو قوي' },
  IMPROVING: { code: 'IMPROVING', icon: '🟢', label: 'تحسن' },
  STABLE: { code: 'STABLE', icon: '⚪', label: 'ثابت' },
  WATCH: { code: 'WATCH', icon: '🟡', label: 'يحتاج متابعة' },
  EARLY_DECLINE: { code: 'EARLY_DECLINE', icon: '🟠', label: 'بدأ يضعف' },
  DECLINING: { code: 'DECLINING', icon: '🔴', label: 'متراجع' },
  SHARP_DECLINE: { code: 'SHARP_DECLINE', icon: '🚨', label: 'تراجع حاد' },
  STOPPED: { code: 'STOPPED', icon: '🚨', label: 'توقف اليوم' },
  WEAK: { code: 'WEAK', icon: '💤', label: 'ضعيف' },
  VOLATILE: { code: 'VOLATILE', icon: '⚠️', label: 'متذبذب' },
  NEW: { code: 'NEW', icon: '🆕', label: 'جديد' },
};

/**
 * @param {object} a an analyzeProduct() result
 * @param {object} settings
 */
export function classifyDailyStatus(a, settings) {
  if (a.isNew) return DAILY_STATUS.NEW;

  // Explicit zero after a real baseline of activity — spec section 9: this
  // is NOT missing data, it's a real, alarming data point on its own.
  if (a.today === 0 && a.avg7 !== null && a.avg7 > 0) return DAILY_STATUS.STOPPED;

  const pct = a.baseline.pct; // vs the configured baseline (7D by default)
  const declineStreak = a.declineStreak;

  // Sudden single-day shock (spec section 17): a sharp one-day collapse
  // shouldn't have to wait for a multi-day streak to be flagged.
  if (a.yesterday !== null && a.yesterday > 0 && a.change.abs !== null) {
    const dayOverDayPct = (a.change.abs / a.yesterday) * 100;
    if (dayOverDayPct <= -50 && pct !== null && pct <= -35) return DAILY_STATUS.SHARP_DECLINE;
  }

  if (declineStreak >= (settings.consecutiveDeclineDays || 4)) return DAILY_STATUS.SHARP_DECLINE;
  if (declineStreak >= 2) return DAILY_STATUS.EARLY_DECLINE;

  if (pct === null) return DAILY_STATUS.STABLE;

  if (a.trend.code === 'STRONG_UP' && pct >= 30) return DAILY_STATUS.STRONG_GROWTH;
  if (pct >= (settings.upThreshold || 15)) return DAILY_STATUS.IMPROVING;
  if (pct <= (settings.criticalThreshold || -35)) return DAILY_STATUS.DECLINING;
  if (pct <= (settings.downThreshold || -15)) return DAILY_STATUS.WATCH;

  // Quiet/low-volume product sitting near its (already low) baseline —
  // technically "stable" but not worth celebrating either.
  if (a.avg7 !== null && a.avg7 > 0 && a.avg7 < 3 && Math.abs(pct) < 15) return DAILY_STATUS.WEAK;

  // Erratic day-to-day swings with no clear direction and today itself
  // near baseline (every more urgent/positive branch above already ruled
  // out an actual event today) — worth flagging distinctly so a choppy
  // product doesn't get judged off a single quiet day (spec: "متذبذب").
  if (a.trend.code === 'VOLATILE') return DAILY_STATUS.VOLATILE;

  return DAILY_STATUS.STABLE;
}

/**
 * Curates at most `max` products worth calling out today (spec section 22),
 * mixing urgent negatives and notable positives — never just a flat top-N
 * by one metric.
 */
export function buildDailyFocus(bundlesWithDailyStatus, max = 5) {
  const priority = {
    STOPPED: 0,
    SHARP_DECLINE: 1,
    EARLY_DECLINE: 2,
    STRONG_GROWTH: 3,
    WATCH: 4,
    DECLINING: 5,
    WEAK: 6,
    IMPROVING: 7,
  };
  return bundlesWithDailyStatus
    .filter((b) => b.dailyStatus.code in priority)
    .sort((x, y) => priority[x.dailyStatus.code] - priority[y.dailyStatus.code])
    .slice(0, max);
}

// ---------------------------------------------------------------------------
// Week-over-week comparisons (spec sections 30-31)
// ---------------------------------------------------------------------------

function sumAvailable(map, dates) {
  const values = dates.map((d) => getValue(map, d)).filter((v) => v !== null);
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0);
}

/** This week (last 7 days incl. today) vs the 7 days before that. */
export function weeklyComparison(records, asOfDate) {
  const map = buildOrdersMap(records);
  const thisWeekDates = Array.from({ length: 7 }, (_, i) => addDays(asOfDate, -i));
  const lastWeekDates = Array.from({ length: 7 }, (_, i) => addDays(asOfDate, -(i + 7)));

  const thisWeek = sumAvailable(map, thisWeekDates);
  const lastWeek = sumAvailable(map, lastWeekDates);
  const changePct = thisWeek !== null && lastWeek !== null && lastWeek > 0 ? ((thisWeek - lastWeek) / lastWeek) * 100 : null;

  return { thisWeek, lastWeek, changePct };
}

/** Today vs the same weekday last week — a same-day comparison is often more meaningful than yesterday alone (spec section 31). */
export function sameDayLastWeek(records, asOfDate) {
  const map = buildOrdersMap(records);
  const today = getValue(map, asOfDate);
  const lastWeekSameDay = getValue(map, addDays(asOfDate, -7));
  const changeAbs = today !== null && lastWeekSameDay !== null ? today - lastWeekSameDay : null;
  const changePct = changeAbs !== null && lastWeekSameDay > 0 ? (changeAbs / lastWeekSameDay) * 100 : null;
  return { today, lastWeekSameDay, changeAbs, changePct };
}
