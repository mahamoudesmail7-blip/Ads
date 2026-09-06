// AI Media Buyer — Meta Data Collector (layer 1). Runs SERVER-SIDE on a
// timer (default every 15 min); never depends on a browser being open.
//
// What one cycle does:
//   1. Pull daily Insights at campaign + adset + ad level for a short window
//      (today + yesterday, so late-attributed conversions keep updating).
//   2. Pull live entity metadata (effective_status, objective, CBO/ABO
//      budget) and merge it onto the insight rows by id.
//   3. APPEND every row to meta_performance_snapshots — never delete/replace.
//      Each cycle is a new immutable point in the time series.
//   4. If enabled, ALSO run the existing metaSync.runSync() so the current
//      "AI Intelligence" page (which reads AdsDailyMetric) goes live too —
//      wrapped so its failure can never fail the snapshot write.
//   5. Record the whole thing in amb_sync_runs (Last/Next/Status for the UI)
//      and raise an AmbAlert on a hard failure (e.g. token expired).
//
// Everything is deterministic. No Claude call anywhere in this file.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection, getDecryptedToken } from '../metaAuth.js';
import { getAdAccountInfo, getInsightsByLevel, getEntitiesMeta } from '../metaGraphClient.js';
import { extractResults, PURCHASE_ACTION_TYPES, runSync } from '../metaSync.js';
import { getAmbSettings } from './settings.js';
import { raiseAlert } from './alerts.js';

const LEVELS = ['campaign', 'adset', 'ad'];
// Most currencies (EGP included) are 2-decimal, so Meta's minor-unit budget
// strings are ÷100. A handful (JPY, KRW, ...) are 0-decimal. This account is
// EGP; the map keeps it correct if that ever changes.
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD', 'UGX']);

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function addDaysISO(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Minor-unit Meta budget string → major account-currency number (EGP). */
export function budgetMinorToMajor(minorStr, currency) {
  const n = toNum(minorStr);
  if (n === null) return null;
  return ZERO_DECIMAL_CURRENCIES.has((currency || 'EGP').toUpperCase()) ? n : n / 100;
}
export function currencyFactor(currency) {
  return ZERO_DECIMAL_CURRENCIES.has((currency || 'EGP').toUpperCase()) ? 1 : 100;
}

/** Builds a { id -> {status,budget,objective,...} } lookup for one level from getEntitiesMeta. */
function indexEntitiesMeta(list, level, currency) {
  const map = new Map();
  for (const e of list) {
    const daily = budgetMinorToMajor(e.daily_budget, currency);
    const lifetime = budgetMinorToMajor(e.lifetime_budget, currency);
    map.set(e.id, {
      status: e.effective_status || e.status || null,
      objective: e.objective || null,
      campaignId: e.campaign_id || null,
      adsetId: e.adset_id || null,
      creativeId: e.creative?.id || null,
      budget: daily ?? lifetime ?? null,
      budgetType: daily != null ? 'DAILY' : lifetime != null ? 'LIFETIME' : null,
    });
  }
  return map;
}

/** One insight row (+ merged metadata) → a MetaPerformanceSnapshot create payload. */
function toSnapshotRow(row, level, meta, adAccountId) {
  const { results, resultIndicator, revenue } = extractResults(row);
  const spend = toNum(row.spend) ?? 0;
  const clicks = toNum(row.clicks);
  const purchases = PURCHASE_ACTION_TYPES.has(resultIndicator) ? Math.round(results ?? 0) : null;
  const roasRaw = row.purchase_roas?.[0]?.value ? toNum(row.purchase_roas[0].value) : null;

  const campMeta = level === 'campaign' ? meta.campaign.get(row.campaign_id) : meta.campaign.get(row.campaign_id);
  const adsetMeta = meta.adset.get(row.adset_id);
  const adMeta = meta.ad.get(row.ad_id);

  return {
    ad_account_id: adAccountId,
    level,
    date_start: row.date_start,
    date_stop: row.date_stop || row.date_start,
    campaign_id: row.campaign_id || null,
    campaign_name: row.campaign_name || null,
    campaign_status: campMeta?.status || null,
    campaign_objective: campMeta?.objective || null,
    campaign_budget: campMeta?.budget ?? null,
    campaign_budget_type: campMeta?.budgetType || null,
    adset_id: row.adset_id || null,
    adset_name: row.adset_name || null,
    adset_status: adsetMeta?.status || null,
    adset_budget: adsetMeta?.budget ?? null,
    adset_budget_type: adsetMeta?.budgetType || null,
    ad_id: row.ad_id || null,
    ad_name: row.ad_name || null,
    ad_status: adMeta?.status || null,
    creative_id: adMeta?.creativeId || null,
    spend,
    impressions: toNum(row.impressions),
    reach: toNum(row.reach),
    frequency: toNum(row.frequency),
    clicks,
    ctr: toNum(row.ctr),
    cpc: toNum(row.cpc),
    cpm: toNum(row.cpm),
    meta_purchases: purchases,
    meta_revenue: revenue,
    cost_per_purchase: purchases && spend ? spend / purchases : null,
    conversion_rate: clicks && purchases !== null ? (purchases / clicks) * 100 : null,
    roas: roasRaw ?? (revenue && spend ? revenue / spend : null),
    results: results !== null ? Math.round(results) : null,
    result_indicator: resultIndicator,
    actions_json: row.actions ? JSON.stringify(row.actions) : null,
  };
}

let running = false;

/**
 * Runs one full sync cycle. Safe to call concurrently — a second call while
 * one is in flight returns { skipped: 'ALREADY_RUNNING' } immediately.
 * @param {{trigger?: 'SCHEDULED'|'MANUAL'}} opts
 */
export async function runSnapshotSync({ trigger = 'SCHEDULED' } = {}) {
  if (running) return { skipped: 'ALREADY_RUNNING' };
  running = true;

  const connection = await getConnection();
  if (!connection || connection.status !== 'CONNECTED') {
    running = false;
    return { skipped: 'NOT_CONNECTED' };
  }
  if (!connection.selected_ad_account_id) {
    running = false;
    return { skipped: 'NO_AD_ACCOUNT' };
  }

  const adAccountId = connection.selected_ad_account_id;
  const syncRun = await prisma.ambSyncRun.create({ data: { trigger, status: 'RUNNING', ad_account_id: adAccountId } });

  try {
    const token = await getDecryptedToken();

    let currency = 'EGP';
    try {
      const info = await getAdAccountInfo(token, adAccountId);
      currency = info?.currency || 'EGP';
    } catch (err) {
      logger.warn('AMB sync: account info fetch failed, assuming EGP', { message: err.message });
    }

    const dateTo = todayISO();
    const dateFrom = addDaysISO(dateTo, -1); // today + yesterday

    // Entity metadata for all three levels (status / objective / budgets).
    const [campMetaList, adsetMetaList, adMetaList] = await Promise.all([
      getEntitiesMeta(token, adAccountId, 'campaign').catch((e) => { logger.warn('AMB campaign meta failed', { message: e.message }); return []; }),
      getEntitiesMeta(token, adAccountId, 'adset').catch((e) => { logger.warn('AMB adset meta failed', { message: e.message }); return []; }),
      getEntitiesMeta(token, adAccountId, 'ad').catch((e) => { logger.warn('AMB ad meta failed', { message: e.message }); return []; }),
    ]);
    const meta = {
      campaign: indexEntitiesMeta(campMetaList, 'campaign', currency),
      adset: indexEntitiesMeta(adsetMetaList, 'adset', currency),
      ad: indexEntitiesMeta(adMetaList, 'ad', currency),
    };

    // Insights per level.
    const snapshotRows = [];
    for (const level of LEVELS) {
      const rows = await getInsightsByLevel(token, adAccountId, level, dateFrom, dateTo);
      for (const r of rows) snapshotRows.push(toSnapshotRow(r, level, meta, adAccountId));
    }

    if (snapshotRows.length > 0) {
      await prisma.metaPerformanceSnapshot.createMany({
        data: snapshotRows.map((r) => ({ ...r, sync_run_id: syncRun.id })),
      });
    }

    // Piggy-back the EXISTING AdsDailyMetric refresh (opt-in via settings) so
    // the current AI Intelligence page becomes live. Never let it fail us.
    let adsDailyRefreshed = 0;
    const settings = await getAmbSettings();
    if (settings.ambAlsoRefreshAdsDailyMetric) {
      try {
        const r = await runSync({ dateFrom, dateTo, triggeredById: null });
        adsDailyRefreshed = r.rowsSynced || 0;
      } catch (err) {
        logger.warn('AMB sync: piggy-backed AdsDailyMetric refresh failed (non-fatal)', { message: err.message });
      }
    }

    await prisma.ambSyncRun.update({
      where: { id: syncRun.id },
      data: { status: 'SUCCESS', finished_at: new Date(), snapshot_rows: snapshotRows.length, adsdaily_refreshed: adsDailyRefreshed, account_currency: currency },
    });

    // Reconcile PENDING recommendations against the state we JUST synced —
    // resolve any that an owner already satisfied out-of-band in Meta Ads
    // Manager (paused a campaign, hit the target budget, ...) so the active
    // Action Plan only ever shows still-actionable items. Non-fatal.
    try {
      const { reconcilePendingRecommendations } = await import('./reconcile.js');
      const rec = await reconcilePendingRecommendations({ adAccountId });
      if (rec.ok && (rec.resolvedExternally || rec.noLongerApplicable)) logger.info('AMB post-sync reconciliation', rec);
    } catch (err) {
      logger.warn('AMB post-sync reconciliation (non-fatal) failed', { message: err.message });
    }

    // Opportunistic creative analysis (cache-first, bounded, non-fatal) so
    // the Winners hook/angle/offer intelligence has real labels to work with.
    try {
      const { analyzeAccountCreatives } = await import('./creativeAnalysis.js');
      const ca = await analyzeAccountCreatives({ maxNew: 12 });
      if (ca.ok && (ca.analyzed || ca.insufficient)) logger.info('AMB creative analysis', ca);
    } catch (err) {
      logger.warn('AMB creative analysis (non-fatal) failed', { message: err.message });
    }

    logger.info('AMB snapshot sync OK', { syncRunId: syncRun.id, snapshotRows: snapshotRows.length, adsDailyRefreshed });
    return { ok: true, syncRunId: syncRun.id, snapshotRows: snapshotRows.length, adsDailyRefreshed };
  } catch (err) {
    await prisma.ambSyncRun.update({
      where: { id: syncRun.id },
      data: { status: 'FAILED', finished_at: new Date(), error: err.message?.slice(0, 500) || String(err) },
    }).catch(() => {});
    logger.error('AMB snapshot sync FAILED', { syncRunId: syncRun.id, message: err.message });
    await raiseAlert({
      severity: 'CRITICAL',
      category: 'SYNC',
      title: 'مزامنة Meta فشلت',
      message: `آخر محاولة مزامنة فشلت: ${err.message?.slice(0, 200) || 'خطأ غير معروف'}`,
      dedupeKey: `sync-fail-${err.message?.slice(0, 60)}`,
    }).catch(() => {});
    return { ok: false, syncRunId: syncRun.id, error: err.message };
  } finally {
    running = false;
  }
}

/** Last run + computed next-due time + status, for the Overview / Settings header. */
export async function getSyncStatus() {
  const [last, lastSuccess, settings] = await Promise.all([
    prisma.ambSyncRun.findFirst({ orderBy: { started_at: 'desc' } }),
    prisma.ambSyncRun.findFirst({ where: { status: 'SUCCESS' }, orderBy: { started_at: 'desc' } }),
    getAmbSettings(),
  ]);
  const intervalMs = Math.max(5, Number(settings.ambSyncIntervalMinutes) || 15) * 60 * 1000;
  const base = lastSuccess?.finished_at || lastSuccess?.started_at || null;
  return {
    intervalMinutes: settings.ambSyncIntervalMinutes,
    lastRun: last ? { at: last.started_at, status: last.status, trigger: last.trigger, snapshotRows: last.snapshot_rows, adsDailyRefreshed: last.adsdaily_refreshed, error: last.error } : null,
    lastSuccessAt: base,
    nextSyncAt: base ? new Date(new Date(base).getTime() + intervalMs) : null,
  };
}

let timer = null;

/** Called once from server.js. A lightweight 60s tick that fires a real sync only when the configured interval has elapsed since the last SUCCESS — so a Settings change to the interval takes effect without a restart. */
export function startAmbSnapshotScheduler() {
  if (timer) return;
  const TICK_MS = 60 * 1000;
  timer = setInterval(async () => {
    try {
      const status = await getSyncStatus();
      const now = Date.now();
      const due = !status.nextSyncAt || new Date(status.nextSyncAt).getTime() <= now;
      if (!due) return;
      await runSnapshotSync({ trigger: 'SCHEDULED' });
    } catch (err) {
      logger.error('AMB scheduler tick failed', { message: err.message });
    }
  }, TICK_MS);
  logger.info('AMB snapshot scheduler started (60s tick, interval-gated)');
}
