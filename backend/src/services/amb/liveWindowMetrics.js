// Live Campaign Intelligence §4 — post-launch windows (آخر ساعة · 3 · 6 · 12 · 24 ساعة) computed from REAL snapshot granularity, never invented.
// The Meta sync appends a snapshot of each campaign's DAY-TO-DATE totals every sync interval (default 15 min). The activity inside the last N hours is therefore the DIFFERENCE between the latest snapshot and the snapshot
// taken N hours earlier (summed across the day boundary). A window is offered ONLY when a snapshot exists close enough to the window start (tolerance = 0.75 × the sync interval, at least 20 min) — otherwise it is reported as
// unavailable with the reason; an hourly history is never fabricated from daily totals. Reach is not additive and is deliberately not derived. Everything here is read-only (findMany) and calls nothing external.
import { prisma } from '../../prisma.js';

export const HOUR_WINDOWS = Object.freeze({ '1h': 1, '3h': 3, '6h': 6, '12h': 12, '24h': 24 });
export const WINDOW_LABEL_AR = Object.freeze({ '1h': 'آخر ساعة', '3h': 'آخر 3 ساعات', '6h': 'آخر 6 ساعات', '12h': 'آخر 12 ساعة', '24h': 'آخر 24 ساعة', launch: 'منذ الإطلاق' });
const ADDITIVE = ['spend', 'impressions', 'clicks', 'meta_purchases', 'landing_page_views'];
const num = (v) => (v == null || Number.isNaN(Number(v)) ? 0 : Number(v));

/** Pure. rows = snapshots of ONE campaign [{snapshot_at, date_start, spend, impressions, clicks, meta_purchases, landing_page_views}] → day-to-date totals summed over every date, as known at time t (null = no snapshot at or before t). */
export function totalsAt(rows, t) {
  const latestByDate = new Map();
  for (const r of rows) { const at = new Date(r.snapshot_at).getTime(); if (at > t) continue; const cur = latestByDate.get(r.date_start); if (!cur || at > cur.at) latestByDate.set(r.date_start, { at, r }); }
  if (!latestByDate.size) return null;
  const out = Object.fromEntries(ADDITIVE.map((k) => [k, 0])); for (const { r } of latestByDate.values()) for (const k of ADDITIVE) out[k] += num(r[k]);
  return out;
}
/** Pure. One campaign's activity in [now−hours, now]. Returns {ok:false, reason} when the window start has no snapshot close enough (never guesses). */
export function campaignWindowDelta(rows, { hours, tolMs }) {
  if (!rows.length) return { ok: false, reason: 'NO_SNAPSHOTS' };
  const tNow = Math.max(...rows.map((r) => new Date(r.snapshot_at).getTime())); const tStart = tNow - hours * 3_600_000;
  const anchor = rows.reduce((best, r) => { const d = Math.abs(new Date(r.snapshot_at).getTime() - tStart); return !best || d < best.d ? { d, at: new Date(r.snapshot_at).getTime() } : best; }, null);
  const before = rows.some((r) => new Date(r.snapshot_at).getTime() <= tStart);
  // an anchor is valid when a snapshot lies within the tolerance of the start (or earlier snapshots exist and the campaign simply had none that day — covered by totalsAt()), and the start is not before our first snapshot
  if (!before) return { ok: false, reason: 'WINDOW_STARTS_BEFORE_FIRST_SNAPSHOT' };
  if (!anchor || anchor.d > tolMs) return { ok: false, reason: 'NO_SNAPSHOT_NEAR_WINDOW_START', nearestMin: anchor ? Math.round(anchor.d / 60000) : null };
  const a = totalsAt(rows, tStart); const b = totalsAt(rows, tNow); if (!b) return { ok: false, reason: 'NO_SNAPSHOTS' };
  const base = a || Object.fromEntries(ADDITIVE.map((k) => [k, 0])); const delta = {}; const negative = [];
  for (const k of ADDITIVE) { const d = b[k] - base[k]; if (d < -0.0001) { negative.push(k); delta[k] = null; } else delta[k] = Math.round(d * 100) / 100; }
  return { ok: true, delta, negative, from: new Date(tStart).toISOString(), to: new Date(tNow).toISOString(), anchorOffsetMin: Math.round(anchor.d / 60000) };
}
const ratio = (a, b, m = 1) => (a == null || b == null || !(b > 0) ? null : Math.round((a / b) * m * 100) / 100);
/** Pure. Sum the per-campaign deltas and derive CTR / CPC / CPM / CPA. A metric is null (not 0) whenever it cannot be known. */
export function summarizeDeltas(results) {
  const good = results.filter((r) => r.ok); const sum = (k) => (good.some((r) => r.delta[k] == null) ? null : Math.round(good.reduce((t, r) => t + r.delta[k], 0) * 100) / 100);
  const m = { spend: sum('spend'), impressions: sum('impressions'), clicks: sum('clicks'), purchases: sum('meta_purchases'), landingPageViews: sum('landing_page_views') };
  m.ctr = ratio(m.clicks, m.impressions, 100); m.cpc = ratio(m.spend, m.clicks); m.cpm = ratio(m.spend, m.impressions, 1000); m.cpa = m.purchases > 0 ? ratio(m.spend, m.purchases) : null;
  return m;
}

/** @returns {{available, windowKey, label, hours, from, to, coverage, metrics, source, note, reason?}} */
export async function liveWindow({ campaignIds, windowKey, now = new Date(), intervalMinutes = 15, deps = {} }) {
  const hours = HOUR_WINDOWS[windowKey]; const label = WINDOW_LABEL_AR[windowKey];
  if (!hours) return { available: false, windowKey, reason: 'UNKNOWN_WINDOW', note: 'فترة غير مدعومة.' };
  const ids = [...new Set((campaignIds || []).map(String))]; if (!ids.length) return { available: false, windowKey, label, reason: 'NO_CAMPAIGNS', note: 'مفيش حملات مربوطة بالمنتج.' };
  const tolMs = Math.max(20, Math.round(Number(intervalMinutes) * 0.75)) * 60_000;   const all = deps.rows || await prisma.metaPerformanceSnapshot.findMany({ where: { level: 'campaign', campaign_id: { in: ids }, snapshot_at: { gte: new Date(now.getTime() - (hours + 27) * 3_600_000), lte: now } }, orderBy: { snapshot_at: 'asc' }, select: { campaign_id: true, snapshot_at: true, date_start: true, spend: true, impressions: true, clicks: true, meta_purchases: true, landing_page_views: true } });
  const by = new Map(); for (const r of all) (by.get(r.campaign_id) || by.set(r.campaign_id, []).get(r.campaign_id)).push(r);
  // a campaign with NO snapshot at all in the horizon was not running (paused / never delivered): it is INACTIVE, not «missing» — coverage is counted over the campaigns that were actually delivering
  const active = ids.filter((id) => by.has(id)); const inactive = ids.length - active.length;
  const results = active.map((id) => ({ id, ...campaignWindowDelta(by.get(id), { hours, tolMs }) })); const good = results.filter((r) => r.ok);
  if (!active.length) return { available: false, windowKey, label, hours, reason: 'NO_SNAPSHOTS', coverage: { campaigns: 0, covered: 0, inactive }, note: 'مفيش حملة من حملات المنتج كانت شغالة في الفترة دي (مفيش لقطات).' };
  if (!good.length) { const why = results.find((r) => r.reason === 'NO_SNAPSHOT_NEAR_WINDOW_START') ? 'NO_SNAPSHOT_NEAR_WINDOW_START' : results[0]?.reason || 'NO_SNAPSHOTS'; return { available: false, windowKey, label, hours, reason: why, coverage: { campaigns: active.length, covered: 0, inactive }, note: why === 'NO_SNAPSHOT_NEAR_WINDOW_START' ? 'مفيش لقطة من Meta قريبة من بداية الفترة دي — مش هنخمّن أرقام الساعات من إجماليات اليوم.' : 'مفيش لقطات كفاية للفترة دي.' }; }
  const from = good.map((r) => r.from).sort()[0]; const to = good.map((r) => r.to).sort().slice(-1)[0];
  return { available: true, windowKey, label, hours, from, to, coverage: { campaigns: active.length, covered: good.length, inactive, missing: results.filter((r) => !r.ok).map((r) => ({ campaignId: r.id, reason: r.reason })) }, partial: good.length < active.length, metrics: summarizeDeltas(good), negativeAdjustments: [...new Set(good.flatMap((r) => r.negative))],
    source: 'META_SNAPSHOT_DIFF', note: 'الفرق بين لقطتين من Meta (أحدث لقطة − لقطة قبلها بـ' + hours + ' ساعة تقريبًا). مش بيانات ساعية حقيقية من Meta، والدقة بقدر فاصل المزامنة.' };
}
