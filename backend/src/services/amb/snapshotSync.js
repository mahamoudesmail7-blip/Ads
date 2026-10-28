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
import { getConnection, getConnectionUnscoped, getDecryptedToken, accountScope } from '../metaAuth.js';
import { getAdAccountInfo, getInsightsByLevel, getEntitiesMeta } from '../metaGraphClient.js';
import { extractResults, runSync } from '../metaSync.js';
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

/** Meta's real `landing_page_view` action count from the SAME `actions` array already fetched for every insight row — never a substitute for Clicks/Impressions/Purchases. */
function extractLandingPageViews(row) {
  const entry = (row.actions || []).find((a) => a.action_type === 'landing_page_view');
  const n = entry ? Number(entry.value) : null;
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** One insight row (+ merged metadata) → a MetaPerformanceSnapshot create payload. */
function toSnapshotRow(row, level, meta, adAccountId) {
  const { results, resultIndicator, revenue, purchases: purchasesRaw } = extractResults(row);
  const spend = toNum(row.spend) ?? 0;
  const clicks = toNum(row.clicks);
  const purchases = purchasesRaw != null ? Math.round(purchasesRaw) : null;
  const landingPageViews = extractLandingPageViews(row);
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
    landing_page_views: landingPageViews,
    meta_revenue: revenue,
    cost_per_purchase: purchases && spend ? spend / purchases : null,
    conversion_rate: clicks && purchases !== null ? (purchases / clicks) * 100 : null,
    roas: roasRaw ?? (revenue && spend ? revenue / spend : null),
    results: results !== null ? Math.round(results) : null,
    result_indicator: resultIndicator,
    actions_json: row.actions ? JSON.stringify(row.actions) : null,
  };
}

// =====================================================================================================================
// METADATA CARRY-FORWARD (2026-10-07). Root cause fixed here: when an entity-metadata call failed / came back truncated, the cycle used to write the
// insight rows with status / budget = NULL ON TOP of the last good values (observed on production: ad-set budgets flapped value -> null -> value every
// few syncs, which produced false BUDGET_UNKNOWN and could hide a real manual budget change). A failed fetch is NOT a fact about the entity:
// for any id whose metadata is missing this cycle, the last known GOOD values (status present, <= 48h old) are carried forward. Nothing is invented:
// an entity with no earlier good row still gets null, exactly as before.
// =====================================================================================================================
export const META_CARRY_MAX_AGE_HOURS = 48;
/** Ids (per level) referenced by the insight rows whose metadata is absent from `meta`. Pure. */
export function missingMetaIds(insightRows, meta) {
  const miss = { campaign: new Set(), adset: new Set(), ad: new Set() };
  for (const r of insightRows) {
    if (r.campaign_id && !meta.campaign.has(r.campaign_id)) miss.campaign.add(r.campaign_id);
    if (r.adset_id && !meta.adset.has(r.adset_id)) miss.adset.add(r.adset_id);
    if (r.ad_id && !meta.ad.has(r.ad_id)) miss.ad.add(r.ad_id);
  }
  return miss;
}
/** Last known GOOD metadata (status present) per missing id, from the append-only snapshots. */
export async function loadMetaFallback({ adAccountId, missing, now = new Date(), maxAgeHours = META_CARRY_MAX_AGE_HOURS }) {
  const since = new Date(now.getTime() - maxAgeHours * 3_600_000); const base = { ad_account_id: adAccountId, snapshot_at: { gte: since } };
  const out = { campaign: new Map(), adset: new Map(), ad: new Map() };
  if (missing.campaign.size) for (const x of await prisma.metaPerformanceSnapshot.findMany({ where: { ...base, level: 'campaign', campaign_id: { in: [...missing.campaign] }, campaign_status: { not: null } }, distinct: ['campaign_id'], orderBy: [{ campaign_id: 'asc' }, { snapshot_at: 'desc' }], select: { campaign_id: true, campaign_status: true, campaign_objective: true, campaign_budget: true, campaign_budget_type: true } })) out.campaign.set(x.campaign_id, { status: x.campaign_status, objective: x.campaign_objective, campaignId: null, adsetId: null, creativeId: null, budget: x.campaign_budget ?? null, budgetType: x.campaign_budget_type || null });
  if (missing.adset.size) for (const x of await prisma.metaPerformanceSnapshot.findMany({ where: { ...base, level: 'adset', adset_id: { in: [...missing.adset] }, adset_status: { not: null } }, distinct: ['adset_id'], orderBy: [{ adset_id: 'asc' }, { snapshot_at: 'desc' }], select: { adset_id: true, campaign_id: true, adset_status: true, adset_budget: true, adset_budget_type: true } })) out.adset.set(x.adset_id, { status: x.adset_status, objective: null, campaignId: x.campaign_id, adsetId: null, creativeId: null, budget: x.adset_budget ?? null, budgetType: x.adset_budget_type || null });
  if (missing.ad.size) for (const x of await prisma.metaPerformanceSnapshot.findMany({ where: { ...base, level: 'ad', ad_id: { in: [...missing.ad] }, ad_status: { not: null } }, distinct: ['ad_id'], orderBy: [{ ad_id: 'asc' }, { snapshot_at: 'desc' }], select: { ad_id: true, adset_id: true, campaign_id: true, ad_status: true, creative_id: true } })) out.ad.set(x.ad_id, { status: x.ad_status, objective: null, campaignId: x.campaign_id, adsetId: x.adset_id, creativeId: x.creative_id || null, budget: null, budgetType: null });
  return out;
}
/** Fills ONLY the missing ids of `meta` from `fallback` (never overrides what Meta returned this cycle). Returns how many per level were carried. Pure. */
export function applyMetaFallback(meta, fallback) {
  const n = { campaign: 0, adset: 0, ad: 0 };
  for (const lvl of ['campaign', 'adset', 'ad']) for (const [id, v] of fallback[lvl]) if (!meta[lvl].has(id)) { meta[lvl].set(id, { ...v, carried: true }); n[lvl]++; }
  return n;
}
/**
 * insightsByLevel = {campaign:[], adset:[], ad:[]} (raw Meta rows). Builds the snapshot payloads; metadata missing for any referenced id is carried forward
 * (see above) via `loadFallback` (injectable for tests). Returns {rows, carried:{campaign,adset,ad}, missingBefore:{...}}.
 */
export async function buildCycleRows({ insightsByLevel, meta, adAccountId, loadFallback = (missing) => loadMetaFallback({ adAccountId, missing }) }) {
  const all = [];
  for (const level of LEVELS) for (const r of insightsByLevel[level] || []) all.push({ level, r });
  const miss = missingMetaIds(all.map((x) => x.r), meta);
  const missingBefore = { campaign: miss.campaign.size, adset: miss.adset.size, ad: miss.ad.size };
  let carried = { campaign: 0, adset: 0, ad: 0 };
  if (missingBefore.campaign || missingBefore.adset || missingBefore.ad) {
    try { carried = applyMetaFallback(meta, await loadFallback(miss)); } catch (e) { logger.warn('AMB sync: metadata carry-forward unavailable (rows keep null metadata for the missing ids)', { message: e.message }); }
  }
  return { rows: all.map((x) => toSnapshotRow(x.r, x.level, meta, adAccountId)), carried, missingBefore };
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
    ]); // a failure here is handled below by buildCycleRows: the last known good metadata is carried forward instead of writing NULL status/budget
    const meta = {
      campaign: indexEntitiesMeta(campMetaList, 'campaign', currency),
      adset: indexEntitiesMeta(adsetMetaList, 'adset', currency),
      ad: indexEntitiesMeta(adMetaList, 'ad', currency),
    };

    // Insights per level.
    const insightsByLevel = {};
    for (const level of LEVELS) insightsByLevel[level] = await getInsightsByLevel(token, adAccountId, level, dateFrom, dateTo);
    const built = await buildCycleRows({ insightsByLevel, meta, adAccountId });
    const snapshotRows = built.rows;
    if (built.carried.campaign || built.carried.adset || built.carried.ad) logger.warn('AMB sync: entity metadata was missing this cycle — last known good status/budget carried forward (no NULL written over a valid value)', { missing: built.missingBefore, carried: built.carried });

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

    // Opportunistic Media Asset Library discovery (cache-first, bounded,
    // non-fatal): fold every newly-seen creative for this account into the
    // deduplicated library so it's browsable + reusable by Clone & Schedule.
    if (settings.ambMediaLibraryAutoDiscover !== false) {
      try {
        const { syncMediaLibraryForAccount } = await import('./mediaLibrary.js');
        const ml = await syncMediaLibraryForAccount({ adAccountId, token, sinceDays: Number(settings.ambMediaLibraryScanDays) || 30, maxNew: 30 });
        if (ml.ok && (ml.newAssets || ml.newRefs)) logger.info('AMB media library discovery', ml);
      } catch (err) {
        logger.warn('AMB media library discovery (non-fatal) failed', { message: err.message });
      }
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
    prisma.ambSyncRun.findFirst({ where: { trigger: { not: 'VIEW' } }, orderBy: { started_at: 'desc' } }),
    prisma.ambSyncRun.findFirst({ where: { status: 'SUCCESS', trigger: { not: 'VIEW' } }, orderBy: { started_at: 'desc' } }),
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

// =====================================================================================================================
// VIEW-ONLY ACCOUNTS (2026-10-28). The Home dashboard can be switched to other ad accounts (Hady / Yasser …) without changing the connected account that the
// executor, the AI Operator and every automation run on. A view account gets the SAME append-only snapshot rows (so the existing hierarchy / overview /
// scale-winner readers work unchanged) but NOTHING else of a full cycle: no AdsDailyMetric piggy-back, no recommendation reconcile, no creative / media-library
// discovery, no alert. Its sync-run rows carry trigger 'VIEW' and are excluded from getSyncStatus (the connected account's freshness is never confused with them).
// =====================================================================================================================
export const VIEW_SYNC_STALE_MINUTES = 10;
const viewRunning = new Set();

/** The accounts the Home dashboard may be switched to (settings.ambViewAccountIds). The caller decides which one is "connected". */
export async function getViewAccountIds() {
  const s = await getAmbSettings();
  return (Array.isArray(s.ambViewAccountIds) ? s.ambViewAccountIds : []).map(String).filter((x) => /^act_\d+$/.test(x));
}

/** Last / next successful sync (any trigger) of one ad account. */
export async function getAccountSyncInfo(adAccountId) {
  const [last, lastOk, settings] = await Promise.all([
    prisma.ambSyncRun.findFirst({ where: { ad_account_id: adAccountId }, orderBy: { started_at: 'desc' } }),
    prisma.ambSyncRun.findFirst({ where: { ad_account_id: adAccountId, status: 'SUCCESS' }, orderBy: { started_at: 'desc' } }),
    getAmbSettings(),
  ]);
  const intervalMs = Math.max(5, Number(settings.ambSyncIntervalMinutes) || 15) * 60 * 1000;
  const base = lastOk?.finished_at || lastOk?.started_at || null;
  return {
    intervalMinutes: settings.ambSyncIntervalMinutes,
    lastRun: last ? { at: last.started_at, status: last.status, trigger: last.trigger, snapshotRows: last.snapshot_rows, error: last.error } : null,
    lastSuccessAt: base,
    nextSyncAt: base ? new Date(new Date(base).getTime() + intervalMs) : null,
  };
}

/**
 * Read-only sync of ONE view account. `force` skips the staleness gate. Never writes to Meta. The first sync of an account pulls 7 days so "آخر 7 أيام" works at once.
 * @returns {{ok:true, skipped?:string, snapshotRows?:number}|{ok:false, error:string}}
 */
export async function runViewAccountSync(adAccountId, { force = false, now = new Date(), extras = false } = {}) {
  const connection = await getConnectionUnscoped();
  if (!connection || connection.status !== 'CONNECTED') return { ok: false, error: 'NOT_CONNECTED' };
  if (adAccountId === connection.selected_ad_account_id) return { ok: true, skipped: 'PRIMARY_ACCOUNT' }; // the connected account has its own full cycle
  if (!(await getViewAccountIds()).includes(adAccountId)) return { ok: false, error: 'NOT_A_VIEW_ACCOUNT' };
  if (viewRunning.has(adAccountId)) return { ok: true, skipped: 'ALREADY_RUNNING' };

  const info = await getAccountSyncInfo(adAccountId);
  if (!force && info.lastSuccessAt && now.getTime() - new Date(info.lastSuccessAt).getTime() < VIEW_SYNC_STALE_MINUTES * 60_000) return { ok: true, skipped: 'FRESH', lastSuccessAt: info.lastSuccessAt };

  viewRunning.add(adAccountId);
  const syncRun = await prisma.ambSyncRun.create({ data: { trigger: 'VIEW', status: 'RUNNING', ad_account_id: adAccountId } });
  try {
    const token = await getDecryptedToken();
    let currency = 'EGP';
    try { currency = (await getAdAccountInfo(token, adAccountId))?.currency || 'EGP'; } catch { /* EGP assumed, same as the full cycle */ }
    const dateTo = addDaysISO(todayISO(), 1); // +1: the account's own "today" can already be a day ahead of UTC
    const dateFrom = addDaysISO(todayISO(), info.lastSuccessAt ? -1 : -7);

    const [campMetaList, adsetMetaList, adMetaList] = await Promise.all([
      getEntitiesMeta(token, adAccountId, 'campaign').catch(() => []),
      getEntitiesMeta(token, adAccountId, 'adset').catch(() => []),
      getEntitiesMeta(token, adAccountId, 'ad').catch(() => []),
    ]);
    const meta = { campaign: indexEntitiesMeta(campMetaList, 'campaign', currency), adset: indexEntitiesMeta(adsetMetaList, 'adset', currency), ad: indexEntitiesMeta(adMetaList, 'ad', currency) };
    const insightsByLevel = {};
    for (const level of LEVELS) insightsByLevel[level] = await getInsightsByLevel(token, adAccountId, level, dateFrom, dateTo);
    const built = await buildCycleRows({ insightsByLevel, meta, adAccountId });
    if (built.rows.length) await prisma.metaPerformanceSnapshot.createMany({ data: built.rows.map((r) => ({ ...r, sync_run_id: syncRun.id })) });
    await prisma.ambSyncRun.update({ where: { id: syncRun.id }, data: { status: 'SUCCESS', finished_at: new Date(), snapshot_rows: built.rows.length, account_currency: currency } });
    // keep this account's PENDING recommendations honest against what was just synced (same post-sync step the connected account gets; Meta reads + status updates only)
    try { const { reconcilePendingRecommendations } = await import('./reconcile.js'); await reconcilePendingRecommendations({ adAccountId }); } catch (err) { logger.warn('AMB view-account reconcile (non-fatal) failed', { message: err.message }); }
    if (extras) await runViewAccountExtras(adAccountId, token);
    logger.info('AMB view-account sync OK', { adAccountId, snapshotRows: built.rows.length });
    return { ok: true, snapshotRows: built.rows.length };
  } catch (err) {
    await prisma.ambSyncRun.update({ where: { id: syncRun.id }, data: { status: 'FAILED', finished_at: new Date(), error: err.message?.slice(0, 500) || String(err) } }).catch(() => {});
    logger.warn('AMB view-account sync failed (view only, no alert)', { adAccountId, message: err.message });
    return { ok: false, error: err.message };
  } finally {
    viewRunning.delete(adAccountId);
  }
}

/**
 * Background-only extras for a view account (never on the interactive sync, which must stay fast): the same cache-first, bounded, non-fatal discovery the connected account gets —
 * creative analysis (hooks / angles), media-library discovery (creative → landing URL), and STRONG campaign→product suggestions from that evidence (SUGGESTED rows only, never MAPPED).
 */
async function runViewAccountExtras(adAccountId, token) {
  const settings = await getAmbSettings();
  await accountScope.run({ adAccountId }, async () => { // services that read "the ad account" from the connection resolve to THIS account here
    try { const { analyzeAccountCreatives } = await import('./creativeAnalysis.js'); await analyzeAccountCreatives({ maxNew: 8 }); } catch (err) { logger.warn('AMB view-account creative analysis (non-fatal) failed', { message: err.message }); }
    if (settings.ambMediaLibraryAutoDiscover !== false) {
      try { const { syncMediaLibraryForAccount } = await import('./mediaLibrary.js'); await syncMediaLibraryForAccount({ adAccountId, token, sinceDays: Number(settings.ambMediaLibraryScanDays) || 30, maxNew: 20 }); } catch (err) { logger.warn('AMB view-account media-library discovery (non-fatal) failed', { message: err.message }); }
    }
    try {
      const rows = await prisma.$queryRawUnsafe("select distinct on (campaign_id) campaign_id as id, campaign_name as name from meta_performance_snapshots where level = 'campaign' and ad_account_id = $1 and snapshot_at > now() - interval '3 days' order by campaign_id, snapshot_at desc", adAccountId);
      const { persistStrongSuggestions } = await import('./operatorMappingResolver.js');
      const r = await persistStrongSuggestions({ adAccountId, campaigns: rows });
      if (r.created || r.updated) logger.info('AMB view-account mapping suggestions', { adAccountId, ...r });
    } catch (err) { logger.warn('AMB view-account mapping suggestions (non-fatal) failed', { message: err.message }); }
  });
}

let viewTimer = null;
/** Keeps the view accounts' snapshots warm in the background (same interval as the main sync); sequential, never throws. */
export function startAmbViewSyncScheduler() {
  if (viewTimer) return;
  viewTimer = setInterval(async () => {
    try {
      const connection = await getConnectionUnscoped();
      if (!connection || connection.status !== 'CONNECTED') return;
      for (const id of await getViewAccountIds()) {
        if (id === connection.selected_ad_account_id) continue;
        const info = await getAccountSyncInfo(id);
        if (info.nextSyncAt && new Date(info.nextSyncAt).getTime() > Date.now()) continue;
        await runViewAccountSync(id, { force: true, extras: true });
      }
    } catch (err) {
      logger.error('AMB view-account scheduler tick failed', { message: err.message });
    }
  }, 2 * 60 * 1000);
  logger.info('AMB view-account sync scheduler started (2 min tick, interval-gated)');
}
