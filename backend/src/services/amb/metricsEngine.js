// AI Media Buyer — Performance Metrics Engine (layer 2). DETERMINISTIC.
// Reads the append-only meta_performance_snapshots time series and produces:
//   • window aggregates per entity at any level (campaign / adset / ad)
//   • intra-day trend + velocity (last 1h / 3h / 6h) from successive snapshots
//   • period-over-period comparison windows (today / yesterday / 3d / 7d)
//   • a creative-fatigue signal built from MULTIPLE metrics, never one
//
// Snapshot rows are CUMULATIVE-per-day: each 15-min cycle appends a fresh
// row holding that day's running totals. So "the value for day D" is the
// LATEST snapshot for (entity, date_start=D); a multi-day window sums those
// latest-per-day rows; an intra-day trend diffs two snapshots of the same
// (entity, today) row.
import { prisma } from '../../prisma.js';

const LEVEL_ID_FIELD = { campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' };
const DIR_THRESHOLD = 0.05; // ±5% => UP / DOWN, else FLAT

function n(v) {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
function direction(now, then) {
  if (now === null || then === null || then === 0) return 'FLAT';
  const chg = (now - then) / Math.abs(then);
  if (chg > DIR_THRESHOLD) return 'UP';
  if (chg < -DIR_THRESHOLD) return 'DOWN';
  return 'FLAT';
}
export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
export function addDaysISO(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Named comparison windows → {from,to} (inclusive, YYYY-MM-DD). */
export function resolveWindow(name) {
  const t = todayISO();
  switch (name) {
    case 'today': return { from: t, to: t, label: 'اليوم' };
    case 'yesterday': return { from: addDaysISO(t, -1), to: addDaysISO(t, -1), label: 'أمس' };
    case 'last3': return { from: addDaysISO(t, -2), to: t, label: 'آخر 3 أيام' };
    case 'last7': return { from: addDaysISO(t, -6), to: t, label: 'آخر 7 أيام' };
    default: return { from: t, to: t, label: 'اليوم' };
  }
}

export async function loadSnapshots({ level, from, to, adAccountId }) {
  return prisma.metaPerformanceSnapshot.findMany({
    where: {
      level,
      date_start: { gte: from, lte: to },
      ...(adAccountId ? { ad_account_id: adAccountId } : {}),
    },
    orderBy: { snapshot_at: 'asc' },
  });
}

/** Map<entityId, Map<date_start, latest-snapshot-row-for-that-day>>. Latest = max snapshot_at (rows arrive ordered asc, so last write wins). */
export function latestPerDayPerEntity(rows, level) {
  const idField = LEVEL_ID_FIELD[level];
  const byEntity = new Map();
  for (const r of rows) {
    const id = r[idField];
    if (!id) continue;
    if (!byEntity.has(id)) byEntity.set(id, new Map());
    byEntity.get(id).set(r.date_start, r); // asc order => later snapshot_at overwrites
  }
  return byEntity;
}

/** Aggregate an array of (already latest-per-day) snapshot rows into one metrics object. Ratios are null when their inputs are absent — never a misleading 0. */
export function aggregateRows(dayRows) {
  if (!dayRows || dayRows.length === 0) return null;
  let spend = 0, impressions = 0, reach = 0, clicks = 0, purchases = 0, revenue = 0, results = 0;
  let hasImpr = false, hasClicks = false, hasPurch = false, hasRev = false, hasResults = false;
  let lastFreq = null;
  const sorted = [...dayRows].sort((a, b) => (a.date_start < b.date_start ? -1 : 1));
  for (const r of sorted) {
    spend += n(r.spend) ?? 0;
    if (n(r.impressions) !== null) { impressions += n(r.impressions); hasImpr = true; }
    if (n(r.reach) !== null) reach += n(r.reach);
    if (n(r.clicks) !== null) { clicks += n(r.clicks); hasClicks = true; }
    if (n(r.meta_purchases) !== null) { purchases += n(r.meta_purchases); hasPurch = true; }
    if (n(r.meta_revenue) !== null) { revenue += n(r.meta_revenue); hasRev = true; }
    if (n(r.results) !== null) { results += n(r.results); hasResults = true; }
    if (n(r.frequency) !== null) lastFreq = n(r.frequency);
  }
  const last = sorted[sorted.length - 1];
  return {
    days: sorted.length,
    spend,
    impressions: hasImpr ? impressions : null,
    reach: reach || null,
    clicks: hasClicks ? clicks : null,
    purchases: hasPurch ? purchases : null,
    revenue: hasRev ? revenue : null,
    results: hasResults ? results : null,
    frequency: lastFreq,
    cpa: hasPurch && purchases > 0 ? spend / purchases : null,
    cpr: hasResults && results > 0 ? spend / results : null,
    ctr: hasClicks && hasImpr && impressions > 0 ? (clicks / impressions) * 100 : null,
    cpc: hasClicks && clicks > 0 ? spend / clicks : null,
    cpm: hasImpr && impressions > 0 ? (spend / impressions) * 1000 : null,
    roas: hasRev && spend > 0 ? revenue / spend : null,
    conversionRate: hasClicks && hasPurch && clicks > 0 ? (purchases / clicks) * 100 : null,
    name: last.ad_name || last.adset_name || last.campaign_name || null,
    status: last.ad_status || last.adset_status || last.campaign_status || null,
    campaignId: last.campaign_id || null,
    campaignName: last.campaign_name || null,
    adsetId: last.adset_id || null,
    adsetName: last.adset_name || null,
    adId: last.ad_id || null,
    adName: last.ad_name || null,
    creativeId: last.creative_id || null,
    budget: last.campaign_budget ?? last.adset_budget ?? null,
    budgetType: last.campaign_budget_type ?? last.adset_budget_type ?? null,
    budgetLevel: last.campaign_budget != null ? 'campaign' : last.adset_budget != null ? 'adset' : null,
  };
}

/**
 * Per-entity window aggregates for a level. Returns
 * Map<entityId, { ...aggregateRows(), dataSufficiency }>. dataSufficiency is
 * a plain read on spend + purchases (thresholds passed by the caller from
 * settings) — STRONG / MODERATE / WEAK.
 */
export async function entityWindowMetrics({ level, from, to, adAccountId }, { minSpend = 150, minPurchases = 5 } = {}) {
  const rows = await loadSnapshots({ level, from, to, adAccountId });
  const byEntity = latestPerDayPerEntity(rows, level);
  const out = new Map();
  for (const [id, dayMap] of byEntity.entries()) {
    const agg = aggregateRows([...dayMap.values()]);
    if (!agg) continue;
    const strong = agg.spend >= minSpend * 2 && (agg.purchases || 0) >= minPurchases;
    const moderate = agg.spend >= minSpend && (agg.purchases || 0) >= Math.max(1, Math.round(minPurchases / 2));
    out.set(id, { entityId: id, ...agg, dataSufficiency: strong ? 'STRONG' : moderate ? 'MODERATE' : 'WEAK' });
  }
  return out;
}

/**
 * Intra-day trend for ONE entity: diff the most recent snapshot of today's
 * cumulative row against the snapshot closest to `hoursAgo` earlier.
 * Returns null when there aren't at least two snapshots spanning the window.
 */
export async function entityIntradayTrend({ level, entityId, hoursAgo = 6, adAccountId }) {
  const idField = LEVEL_ID_FIELD[level];
  const t = todayISO();
  const series = await prisma.metaPerformanceSnapshot.findMany({
    where: { level, date_start: t, [idField]: entityId, ...(adAccountId ? { ad_account_id: adAccountId } : {}) },
    orderBy: { snapshot_at: 'asc' },
  });
  if (series.length < 2) return null;

  const now = series[series.length - 1];
  const cutoff = new Date(new Date(now.snapshot_at).getTime() - hoursAgo * 3600 * 1000);
  let then = series[0];
  for (const r of series) {
    if (new Date(r.snapshot_at) <= cutoff) then = r; else break;
  }
  const elapsedH = Math.max(0.25, (new Date(now.snapshot_at) - new Date(then.snapshot_at)) / 3600000);

  const spendDelta = (n(now.spend) ?? 0) - (n(then.spend) ?? 0);
  const purchDelta = (n(now.meta_purchases) ?? 0) - (n(then.meta_purchases) ?? 0);
  const sliceCpa = purchDelta > 0 ? spendDelta / purchDelta : null;

  const pick = (row, f) => n(row[f]);
  return {
    windowHours: Math.round(elapsedH * 10) / 10,
    fromSnapshotAt: then.snapshot_at,
    toSnapshotAt: now.snapshot_at,
    spendDelta,
    purchasesDelta: purchDelta,
    spendPerHour: spendDelta / elapsedH,
    purchasesPerHour: purchDelta / elapsedH,
    sliceCpa,
    cpa: { now: pick(now, 'cost_per_purchase'), then: pick(then, 'cost_per_purchase'), direction: direction(pick(now, 'cost_per_purchase'), pick(then, 'cost_per_purchase')) },
    ctr: { now: pick(now, 'ctr'), then: pick(then, 'ctr'), direction: direction(pick(now, 'ctr'), pick(then, 'ctr')) },
    cpc: { now: pick(now, 'cpc'), then: pick(then, 'cpc'), direction: direction(pick(now, 'cpc'), pick(then, 'cpc')) },
    cpm: { now: pick(now, 'cpm'), then: pick(then, 'cpm'), direction: direction(pick(now, 'cpm'), pick(then, 'cpm')) },
    roas: { now: pick(now, 'roas'), then: pick(then, 'roas'), direction: direction(pick(now, 'roas'), pick(then, 'roas')) },
    conversionRate: { now: pick(now, 'conversion_rate'), then: pick(then, 'conversion_rate'), direction: direction(pick(now, 'conversion_rate'), pick(then, 'conversion_rate')) },
    frequency: { now: pick(now, 'frequency'), then: pick(then, 'frequency'), direction: direction(pick(now, 'frequency'), pick(then, 'frequency')) },
  };
}

/**
 * Creative fatigue from MULTIPLE signals (never one). Inputs: an intra-day
 * (or day-over-day) trend object + the current frequency + a configurable
 * frequency ceiling. Signals counted:
 *   frequency rising AND above ceiling · CTR falling · CPC rising ·
 *   CPA rising · conversion rate falling
 * 0–1 signals → HEALTHY, 2 → EARLY_FATIGUE, 3+ → FATIGUED.
 */
export function assessCreativeFatigue(trend, { frequency, freqCeiling = 3.5 } = {}) {
  if (!trend) return { status: 'UNKNOWN', signals: [], signalCount: 0 };
  const signals = [];
  if (trend.frequency?.direction === 'UP' && (n(frequency) ?? 0) >= freqCeiling) signals.push('التكرار بيرتفع وفوق الحد');
  if (trend.ctr?.direction === 'DOWN') signals.push('CTR بينزل');
  if (trend.cpc?.direction === 'UP') signals.push('CPC بيرتفع');
  if (trend.cpa?.direction === 'UP') signals.push('CPA بيرتفع');
  if (trend.conversionRate?.direction === 'DOWN') signals.push('معدل التحويل بينزل');
  const status = signals.length >= 3 ? 'FATIGUED' : signals.length === 2 ? 'EARLY_FATIGUE' : 'HEALTHY';
  return { status, signals, signalCount: signals.length };
}
