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
import { Prisma } from '@prisma/client';
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
    // Longer windows (additive) — a product's real performance is often
    // older than a week (confirmed in production: a real product's only
    // order/DailyOrder data was ~4 weeks old, invisible to PMC no matter
    // how correct the matching was, purely because no window could ever
    // reach it). Safe at this scale: entityWindowMetrics() already reduces
    // via a SQL-side DISTINCT ON per entity/day (see this file's own
    // 2026-09-14 OOM-incident note) rather than pulling every raw snapshot
    // into JS, so a wider date range costs proportionally more rows, not a
    // different (unbounded) query shape.
    case 'last14': return { from: addDaysISO(t, -13), to: t, label: 'آخر 14 يوم' };
    case 'last30': return { from: addDaysISO(t, -29), to: t, label: 'آخر 30 يوم' };
    case 'last90': return { from: addDaysISO(t, -89), to: t, label: 'آخر 90 يوم' };
    default: return { from: t, to: t, label: 'اليوم' };
  }
}

// INCIDENT (2026-09-14): this query used to fetch EVERY historical snapshot
// row in the window (one new row per entity per ~15-min sync cycle,
// forever) and reduce to "latest per entity per day" in JS afterward. On
// the real production account (meta_performance_snapshots has grown to
// ~218k rows after weeks of syncing) that meant a single `level:'ad'` call
// for a 7-day window fetched 97,904 full rows (~222MB of JSON) and took 88
// seconds — done 3x concurrently (campaign+adset+ad) inside buildHierarchy(),
// this reliably exhausted the server's memory and crashed the whole Node
// process (a hard OOM kill, which is why no try/catch, .catch(), or even a
// global unhandledRejection handler ever saw it — the OS kills the process
// directly, bypassing JS error handling entirely).
//
// Fixed by pushing the SAME "latest snapshot per entity per day" reduction
// that latestPerDayPerEntity() below already does in JS down into the SQL
// query itself — a Postgres DISTINCT ON, run as a genuine raw query rather
// than via Prisma's findMany({distinct, orderBy}) ORM sugar. UPDATE:
// findMany's distinct+orderBy was tried first and DID reduce the row count
// correctly (97,904 -> 669), but a second production test still crashed —
// EXPLAIN ANALYZE on the equivalent raw SQL showed the real query executes
// in ~400ms, while the exact same logical query through Prisma's client
// took 30-50 SECONDS. Prisma's `distinct` does not push a real DISTINCT ON
// down to Postgres the way this needed; it was still paying the full
// scan/transfer cost of every historical row under the hood. $queryRaw
// with the identical SQL EXPLAIN already proved fast is the fix — every
// value is parameterized (level/from/to/adAccountId), only the column NAME
// (campaign_id/adset_id/ad_id) is interpolated via Prisma.raw(), and that
// name only ever comes from this file's own hardcoded LEVEL_ID_FIELD map,
// never from external input. Return shape and every downstream function
// (latestPerDayPerEntity/aggregateRows/entityWindowMetrics) are unchanged
// — Prisma's raw-query result rows carry the same snake_case column names
// as the schema, same as a normal findMany() result.
export async function loadSnapshots({ level, from, to, adAccountId }) {
  const idField = LEVEL_ID_FIELD[level];
  const idCol = Prisma.raw(`"${idField}"`);
  // An explicit column list, never `SELECT *` — a `SELECT *` raw query is
  // vulnerable to Postgres/the connection pooler's cached-plan-by-exact-text
  // behavior: after a schema migration adds/removes a column, an already-
  // pooled backend connection that had this EXACT query text cached from
  // before the migration starts throwing "cached plan must not change
  // result type" for every request routed to it, until that connection is
  // torn down — a real production incident this caused once (fixed here by
  // making `*` never appear in this query again, so future additive
  // migrations can never trigger the same class of outage).
  return prisma.$queryRaw`
    SELECT DISTINCT ON (${idCol}, date_start)
      id, sync_run_id, snapshot_at, ad_account_id, level, date_start, date_stop,
      campaign_id, campaign_name, campaign_status, campaign_objective, campaign_budget, campaign_budget_type,
      adset_id, adset_name, adset_status, adset_budget, adset_budget_type,
      ad_id, ad_name, ad_status, creative_id,
      spend, impressions, reach, frequency, clicks, ctr, cpc, cpm,
      meta_purchases, landing_page_views, meta_revenue, cost_per_purchase, conversion_rate,
      roas, results, result_indicator, actions_json, created_at
    FROM "meta_performance_snapshots"
    WHERE level = ${level}
      AND date_start >= ${from}
      AND date_start <= ${to}
      AND ${idCol} IS NOT NULL
      ${adAccountId ? Prisma.sql`AND ad_account_id = ${adAccountId}` : Prisma.empty}
    ORDER BY ${idCol} ASC, date_start ASC, snapshot_at DESC
  `;
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
  let spend = 0, impressions = 0, reach = 0, clicks = 0, purchases = 0, revenue = 0, results = 0, landingPageViews = 0;
  let hasImpr = false, hasClicks = false, hasPurch = false, hasRev = false, hasResults = false, hasLpv = false;
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
    if (n(r.landing_page_views) !== null) { landingPageViews += n(r.landing_page_views); hasLpv = true; }
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
    landingPageViews: hasLpv ? landingPageViews : null,
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
