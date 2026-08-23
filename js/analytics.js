// analytics.js — Pure business-logic engine. No DOM, no IndexedDB, no I/O.
//
// Every function here takes plain data in and returns plain data out, so the
// exact same code can be exercised by the in-browser test suite
// (tests/test-analytics.js) and by every page controller. Keep it that way:
// if a function starts needing `document` or `db.js`, it belongs elsewhere.
//
// Convention used everywhere in this file: a day with NO row in daily_orders
// is represented as `null` ("No Data"). A day that was explicitly logged as
// zero orders is the number `0`. Averages and streaks must never silently
// treat one as the other (see spec section 21).

// ---------------------------------------------------------------------------
// Date helpers (plain 'YYYY-MM-DD' strings, UTC-based to avoid DST/timezone
// drift when a user simply adds/subtracts days).
// ---------------------------------------------------------------------------

export function toDateStr(d) {
  if (typeof d === 'string') return d;
  return d.toISOString().slice(0, 10);
}

export function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(dateStr, n) {
  const d = parseDateStr(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return toDateStr(d);
}

export function todayStr() {
  return toDateStr(new Date());
}

// ---------------------------------------------------------------------------
// Series helpers
// ---------------------------------------------------------------------------

/** Build a Map<date, orders_count> from raw daily_orders rows for one product. */
export function buildOrdersMap(records) {
  const map = new Map();
  for (const r of records) map.set(r.date, r.orders_count);
  return map;
}

/** null = No Data. A number (including 0) = an explicitly logged value. */
export function getValue(map, date) {
  return map.has(date) ? map.get(date) : null;
}

export function average(values) {
  const nums = values.filter((v) => v !== null && v !== undefined);
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Window average ending at (and including) asOfDate, going back `days` days. */
export function windowAverage(map, asOfDate, days) {
  const values = [];
  for (let i = 0; i < days; i++) {
    values.push(getValue(map, addDays(asOfDate, -i)));
  }
  const nonNull = values.filter((v) => v !== null);
  return {
    avg: average(values),
    count: nonNull.length,
    values, // most-recent-first
  };
}

// ---------------------------------------------------------------------------
// Daily change (today vs yesterday) — spec section 7
// ---------------------------------------------------------------------------

export function dailyChange(todayVal, yesterdayVal) {
  if (todayVal === null || yesterdayVal === null) {
    return { abs: null, pct: null, label: 'No Data' };
  }
  const abs = todayVal - yesterdayVal;
  const pct = yesterdayVal === 0 ? (todayVal === 0 ? 0 : null) : (abs / yesterdayVal) * 100;
  const label = abs > 0 ? `+${abs} Order${abs === 1 ? '' : 's'}` : abs < 0 ? `${abs} Order${abs === -1 ? '' : 's'}` : '0';
  return { abs, pct, label };
}

// ---------------------------------------------------------------------------
// Change vs a baseline average (used for 7D baseline comparisons) — section 6
// ---------------------------------------------------------------------------

export function baselineChange(todayVal, baselineAvg) {
  if (todayVal === null || baselineAvg === null) return { abs: null, pct: null };
  const abs = todayVal - baselineAvg;
  if (baselineAvg === 0) {
    // No historical baseline to divide by. Report the raw delta only.
    return { abs, pct: null };
  }
  return { abs, pct: (abs / baselineAvg) * 100 };
}

// ---------------------------------------------------------------------------
// Status classification — spec section 8. Thresholds come from Settings.
// ---------------------------------------------------------------------------

export function classifyStatus(pct7, declineStreak, settings) {
  if (pct7 === null) return 'NO_DATA';
  if (pct7 <= settings.criticalThreshold || declineStreak >= settings.consecutiveDeclineDays) return 'CRITICAL';
  if (pct7 <= settings.downThreshold) return 'DOWN';
  if (pct7 >= settings.upThreshold) return 'UP';
  return 'STABLE';
}

export const STATUS_META = {
  UP: { color: 'green', icon: '📈' },
  STABLE: { color: 'gray', icon: '➖' },
  DOWN: { color: 'yellow', icon: '⚠️' },
  CRITICAL: { color: 'red', icon: '🚨' },
  NO_DATA: { color: 'gray', icon: '—' },
};

// ---------------------------------------------------------------------------
// Trend detection — spec section 9
// ---------------------------------------------------------------------------

export const TREND = {
  STRONG_UP: { code: 'STRONG_UP', label: 'Strong Uptrend', icon: '📈' },
  STRONG_DOWN: { code: 'STRONG_DOWN', label: 'Strong Downtrend', icon: '📉' },
  VOLATILE: { code: 'VOLATILE', label: 'Volatile / Unstable', icon: '↔️' },
  STABLE: { code: 'STABLE', label: 'Stable', icon: '➖' },
  INSUFFICIENT: { code: 'INSUFFICIENT', label: 'Not enough data', icon: '🆕' },
};

/**
 * `valuesOldToNew` is a chronological array (oldest first) of the most
 * recent available (non-null) data points — typically the last 5 logged
 * days. Simple, explainable algorithm:
 *   - all consecutive diffs positive  -> Strong Uptrend
 *   - all consecutive diffs negative  -> Strong Downtrend
 *   - diffs flip sign frequently      -> Volatile / Unstable
 *   - otherwise                       -> Stable
 */
export function detectTrend(valuesOldToNew) {
  const vals = valuesOldToNew.filter((v) => v !== null && v !== undefined);
  if (vals.length < 3) return TREND.INSUFFICIENT;

  const diffs = [];
  for (let i = 1; i < vals.length; i++) diffs.push(vals[i] - vals[i - 1]);

  if (diffs.every((d) => d > 0)) return TREND.STRONG_UP;
  if (diffs.every((d) => d < 0)) return TREND.STRONG_DOWN;

  let signChanges = 0;
  for (let i = 1; i < diffs.length; i++) {
    const prevSign = Math.sign(diffs[i - 1]);
    const curSign = Math.sign(diffs[i]);
    if (prevSign !== 0 && curSign !== 0 && prevSign !== curSign) signChanges++;
  }
  const volatilityRatio = diffs.length > 1 ? signChanges / (diffs.length - 1) : 0;
  if (volatilityRatio >= 0.5) return TREND.VOLATILE;
  return TREND.STABLE;
}

/** Convenience: pulls the last `n` available data points (oldest-first) ending at asOfDate. */
export function lastNAvailable(map, asOfDate, n, lookbackDays = 60) {
  const out = [];
  for (let i = 0; i < lookbackDays && out.length < n; i++) {
    const d = addDays(asOfDate, -i);
    const v = getValue(map, d);
    if (v !== null) out.unshift(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

/** Consecutive trailing days (ending asOfDate) where each day strictly declined vs the previous day. */
export function dayOverDayDeclineStreak(map, asOfDate, maxLookback = 30) {
  let streak = 0;
  let cur = getValue(map, asOfDate);
  if (cur === null) return 0;
  for (let i = 1; i < maxLookback; i++) {
    const prevDate = addDays(asOfDate, -i);
    const prev = getValue(map, prevDate);
    if (prev === null || !(cur < prev)) break;
    streak++;
    cur = prev;
  }
  return streak;
}

/** Consecutive trailing days (ending asOfDate) at least `thresholdPct` below a fixed baseline. thresholdPct is negative, e.g. -35. */
export function belowBaselineStreak(map, asOfDate, baselineAvg, thresholdPct, maxLookback = 30) {
  if (baselineAvg === null || baselineAvg <= 0) return 0;
  let streak = 0;
  for (let i = 0; i < maxLookback; i++) {
    const d = addDays(asOfDate, -i);
    const v = getValue(map, d);
    if (v === null) break;
    const pct = ((v - baselineAvg) / baselineAvg) * 100;
    if (pct > thresholdPct) break;
    streak++;
  }
  return streak;
}

/** Consecutive trailing days (ending asOfDate) at least `thresholdPct` above a fixed baseline. thresholdPct is positive, e.g. +15. */
export function aboveBaselineStreak(map, asOfDate, baselineAvg, thresholdPct, maxLookback = 30) {
  if (baselineAvg === null || baselineAvg <= 0) return 0;
  let streak = 0;
  for (let i = 0; i < maxLookback; i++) {
    const d = addDays(asOfDate, -i);
    const v = getValue(map, d);
    if (v === null) break;
    const pct = ((v - baselineAvg) / baselineAvg) * 100;
    if (pct < thresholdPct) break;
    streak++;
  }
  return streak;
}

export function zeroOrderDaysInWindow(map, asOfDate, days) {
  let count = 0;
  for (let i = 0; i < days; i++) {
    if (getValue(map, addDays(asOfDate, -i)) === 0) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Health Score — spec section 12 (0-100)
// ---------------------------------------------------------------------------

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function scoreFromPct(pct) {
  if (pct === null) return 60; // neutral: no baseline to compare against yet
  return clamp(60 + pct * 0.8, 0, 100);
}

function scoreFromTrend(trendCode) {
  return { STRONG_UP: 100, STABLE: 70, VOLATILE: 45, STRONG_DOWN: 15, INSUFFICIENT: 60 }[trendCode] ?? 60;
}

function scoreFromDeclineStreak(days) {
  return clamp(100 - days * 20, 0, 100);
}

function scoreFromZeroDays(zeroDays) {
  return clamp(100 - zeroDays * 15, 0, 100);
}

/**
 * Weighted blend documented here so the formula can be tuned in one place:
 *   30% 7D performance vs baseline
 *   20% 14D performance vs baseline
 *   20% short-term trend shape
 *   15% consecutive day-over-day decline streak
 *   15% zero-order days in the last 14 days
 */
export function healthScore({ pct7, pct14, trendCode, declineStreak, zeroDays14 }) {
  const score = Math.round(
    0.3 * scoreFromPct(pct7) +
      0.2 * scoreFromPct(pct14) +
      0.2 * scoreFromTrend(trendCode) +
      0.15 * scoreFromDeclineStreak(declineStreak) +
      0.15 * scoreFromZeroDays(zeroDays14)
  );
  const clamped = clamp(score, 0, 100);
  let label;
  if (clamped >= 80) label = 'Excellent';
  else if (clamped >= 60) label = 'Good';
  else if (clamped >= 40) label = 'Watch';
  else if (clamped >= 20) label = 'Danger';
  else label = 'Exit Candidate';
  return { score: clamped, label };
}

// ---------------------------------------------------------------------------
// New product detection — spec section 22
// ---------------------------------------------------------------------------

export function isNewProduct(totalDataPoints, minDataDaysForTrend) {
  return totalDataPoints < minDataDaysForTrend;
}

// ---------------------------------------------------------------------------
// Recommendation engine — KEEP / WATCH / SCALE / EXIT (sections 13-14)
// ---------------------------------------------------------------------------

export function recommend(data, settings) {
  const { pct7: pctBaseline, status, trend, declineStreak, belowStreak, aboveStreak, health, isNew, baselineDays } = data;
  const periodLabel = `${baselineDays || settings.baselinePeriod || 7}D`;

  if (isNew) {
    return { type: 'NEW', reasons: ['Not enough data for reliable trend analysis.'] };
  }

  // EXIT: sustained weakness, not a single bad day (section 13).
  if (pctBaseline !== null && pctBaseline <= settings.exitThreshold && belowStreak >= settings.exitConsecutiveDays) {
    return {
      type: 'EXIT',
      reasons: [
        `${belowStreak} days declining`,
        `${periodLabel} performance: ${pctBaseline.toFixed(1)}%`,
        `Health Score: ${health.score}/100`,
        'Orders below normal',
      ],
    };
  }

  // SCALE: consistently above baseline, not a one-day spike (section 14).
  if (
    pctBaseline !== null &&
    pctBaseline >= settings.scaleThreshold &&
    aboveStreak >= settings.scaleConsecutiveDays &&
    trend.code !== 'STRONG_DOWN'
  ) {
    return {
      type: 'SCALE',
      reasons: ['Strong upward trend', 'Orders above baseline', 'Consistent performance'],
    };
  }

  // WATCH: showing weakness or instability but not (yet) exit-worthy.
  if (status === 'CRITICAL' || status === 'DOWN' || trend.code === 'VOLATILE' || declineStreak >= 2) {
    return { type: 'WATCH', reasons: ['Performance below normal — monitor closely'] };
  }

  return { type: 'KEEP', reasons: ['Performance within normal range'] };
}

// ---------------------------------------------------------------------------
// Top-level orchestrator — builds the full analysis bundle for one product.
// This is what every page (dashboard, alerts, product details, compare)
// should call rather than re-deriving stats by hand.
// ---------------------------------------------------------------------------

export function analyzeProduct(records, asOfDate, settings) {
  const map = buildOrdersMap(records);
  const totalDataPoints = records.filter((r) => r.orders_count !== null && r.orders_count !== undefined).length;

  const today = getValue(map, asOfDate);
  const yesterday = getValue(map, addDays(asOfDate, -1));

  // Baselines (7D/14D/30D averages) are computed over the period ENDING
  // YESTERDAY, deliberately excluding today. This matches the worked
  // example in the spec (section 6): "today" is compared against a true
  // prior baseline instead of being averaged into its own comparison
  // point, which would understate how far today deviates from normal.
  const baselineEnd = addDays(asOfDate, -1);
  const w7 = windowAverage(map, baselineEnd, 7);
  const w14 = windowAverage(map, baselineEnd, 14);
  const w30 = windowAverage(map, baselineEnd, 30);

  // Settings section 23 exposes an editable "Baseline period" — this is the
  // window actually used to drive Status/Health/Recommendation, decoupled
  // from the always-visible 7D/14D/30D display columns above. Defaults to 7
  // days, matching the worked example in section 6.
  const baselineDays = settings.baselinePeriod || 7;
  const wBase = baselineDays === 7 ? w7 : baselineDays === 14 ? w14 : baselineDays === 30 ? w30 : windowAverage(map, baselineEnd, baselineDays);

  const change = dailyChange(today, yesterday);
  const base7 = baselineChange(today, w7.avg);
  const base14 = baselineChange(today, w14.avg);
  const baseline = baselineChange(today, wBase.avg); // drives status/health/recommendation

  // Products-table "Change / Change %" columns (spec section 5 worked
  // example): the absolute delta is Today-Yesterday, but it's expressed as
  // a PERCENT OF THE 7D BASELINE (not of yesterday) so a swing reads as
  // "% of normal volume" rather than being distorted by an atypical
  // yesterday. Verified against the spec's own numbers: (6,5,5.1)->+1/+19.6%
  // and (4,6,6.2)->-2/-32.2% only reconcile under this formula.
  const tableChange = {
    abs: change.abs,
    pct: change.abs !== null && w7.avg ? (change.abs / w7.avg) * 100 : null,
  };

  const declineStreak = dayOverDayDeclineStreak(map, asOfDate);
  const belowStreak = belowBaselineStreak(map, asOfDate, wBase.avg, settings.exitThreshold);
  const aboveStreak = aboveBaselineStreak(map, asOfDate, wBase.avg, settings.scaleThreshold);
  const zeroDays14 = zeroOrderDaysInWindow(map, asOfDate, 14);

  const trendInput = lastNAvailable(map, asOfDate, 5);
  const trend = detectTrend(trendInput);

  const isNew = isNewProduct(totalDataPoints, settings.minDataDaysForTrend);
  const status = isNew ? 'NEW' : classifyStatus(baseline.pct, declineStreak, settings);

  const health = healthScore({
    pct7: baseline.pct,
    pct14: base14.pct,
    trendCode: trend.code,
    declineStreak,
    zeroDays14,
  });

  const recommendation = recommend(
    { pct7: baseline.pct, status, trend, declineStreak, belowStreak, aboveStreak, health, isNew, baselineDays },
    settings
  );

  // Best/worst day over all recorded (non-null) history.
  const nonNull = records.filter((r) => r.orders_count !== null && r.orders_count !== undefined);
  const best = nonNull.reduce((a, b) => (!a || b.orders_count > a.orders_count ? b : a), null);
  const worst = nonNull.reduce((a, b) => (!a || b.orders_count < a.orders_count ? b : a), null);

  return {
    asOfDate,
    today,
    yesterday,
    avg7: w7.avg,
    avg14: w14.avg,
    avg30: w30.avg,
    dataPoints7: w7.count,
    dataPoints14: w14.count,
    dataPoints30: w30.count,
    change, // vs yesterday, pure day-over-day: {abs, pct, label}
    tableChange, // Products-table Change/Change% columns: {abs, pct} — see comment above
    baselineChange: base7, // vs 7D avg: {abs, pct} — always shown in the table
    baselineChange14: base14,
    baseline, // vs the configured Settings baseline period: {abs, pct} — drives status/health/recommendation
    baselineDays,
    status,
    trend,
    declineStreak,
    belowStreak,
    aboveStreak,
    zeroDays14,
    health,
    recommendation,
    isNew,
    totalDataPoints,
    bestDay: best,
    worstDay: worst,
    totalOrders: nonNull.reduce((s, r) => s + r.orders_count, 0),
    avgAllTime: average(nonNull.map((r) => r.orders_count)),
  };
}
