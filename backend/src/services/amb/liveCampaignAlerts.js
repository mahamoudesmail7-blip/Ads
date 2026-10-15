// Live Campaign Intelligence Slice 4 — continuous alerting for live
// campaigns. Two things happen here, both opt-in (ambLiveAlertsEnabled,
// default false — see settings.js):
//
//   1. The EXISTING, unmodified incident pipeline (incidentCenter.js's
//      detectIncidentsForProduct/raiseIncidentAlerts, already wired together
//      by aiTools.js's get_incidents()) now also runs on a timer for every
//      live product, not just when someone happens to ask the AI Assistant.
//      This is what actually covers CTR drop / business-CR drop / creative
//      fatigue / COD deterioration / stale data / unexpected campaign state
//      — zero new detection logic, just a new scheduler calling the exact
//      same real function.
//   2. Two genuinely new, USER-CONFIGURABLE checks the existing Incident
//      Center doesn't have (it only has fixed relative-change thresholds):
//      an absolute CPA ceiling and a spend-with-zero-purchases ceiling, each
//      raised through the SAME generic raiseAlert() pipeline, under a
//      distinct 'LIVE_CAMPAIGN' category so they're never confused with
//      Incident Center's own 'INCIDENT' category rows.
import { logger } from '../../logger.js';
import { getAmbSettings } from './settings.js';
import { candidateProductIds } from './audienceBreakdownSync.js';
import { getLiveCampaignStatusByProductId } from './liveCampaignStatus.js';
import { raiseAlert } from './alerts.js';
import { get_incidents } from '../aiTools.js';
import { getEconomicsSummaryByProductId } from './liveCampaignStatus.js';
import { prisma } from '../../prisma.js';

/**
 * Pure. Spec §33 milestone signals from REAL numbers only (never assumed):
 *  - SAMPLE_REACHED: the last-7-day orders reached the minimum sample the engine itself requires before it trusts a CPA (ambMinPurchasesBeforeScaling).
 *  - SCALE_ELIGIBLE: sample reached AND the product's economics are complete AND the last-7-day CPA is at/below the SCALE line (0.6 × max CPA — the same suggestion line the economics screen shows)
 *    AND the product has a margin (break-even CPA known). If any of those is missing the signal is simply not raised (no guess).
 * It is information only — it never changes a campaign, a budget or a policy.
 */
export function evaluateLiveSignals({ economics, minSample }) {
  const out = []; const e = economics; if (!e || !e.available) return out;
  const orders7 = e.performance?.orders7; const cpa7 = e.performance?.cpa7; const need = Math.max(1, Number(minSample) || 5);
  if (orders7 == null || orders7 < need) return out;
  out.push({ kind: 'SAMPLE_REACHED', orders7, cpa7, need });
  const max = e.cpa?.max; if (e.economicsComplete && e.breakEvenCpa != null && max > 0 && cpa7 != null) {
    const scaleLine = Math.round(max * 0.6);
    if (cpa7 <= scaleLine) out.push({ kind: 'SCALE_ELIGIBLE', orders7, cpa7, scaleLine, max });
  }
  return out;
}

export async function raiseOnce(a) { // upsert would re-mark an already-read alert unread on every tick; a milestone is raised once per dedupe key
  const hit = await prisma.ambAlert.findUnique({ where: { dedupe_key: a.dedupeKey }, select: { id: true } }).catch(() => null);
  if (hit) return null; return raiseAlert(a);
}

async function checkMilestones({ productId, settings }) {
  const need = Math.max(1, Number(settings.ambMinPurchasesBeforeScaling) || 5);
  const economics = await getEconomicsSummaryByProductId({ productId });
  const day = new Date().toISOString().slice(0, 10);
  for (const sig of evaluateLiveSignals({ economics, minSample: need })) {
    if (sig.kind === 'SAMPLE_REACHED') await raiseOnce({ severity: 'INFO', category: 'LIVE_CAMPAIGN', title: `العينة كفاية للحكم: ${economics.name || productId}`, entityId: String(productId), dedupeKey: `live-sample:${productId}:${need}`,
      message: `وصل ${sig.orders7} أوردر في آخر 7 أيام (الحد الأدنى ${sig.need}) — الـ CPA ${sig.cpa7 != null ? Math.round(sig.cpa7) + ' ج.م' : 'غير متوفر'} بقى يتعتمد عليه في القرار. ده تنبيه معلومة بس — مفيش أي تنفيذ.` });
    if (sig.kind === 'SCALE_ELIGIBLE') await raiseOnce({ severity: 'INFO', category: 'LIVE_CAMPAIGN', title: `مؤهّل للـ scale: ${economics.name || productId}`, entityId: String(productId), dedupeKey: `live-scale:${productId}:${day}`,
      message: `الـ CPA ${Math.round(sig.cpa7)} ج.م في آخر 7 أيام (على ${sig.orders7} أوردر) تحت خط الـ scale (${sig.scaleLine} ج.م = 60% من أعلى CPA ${sig.max}) والاقتصاديات مكتملة. المنتج مؤهّل لزيادة الميزانية — القرار والتنفيذ حسب سياسة المنتج وموافقتك، التنبيه ده مش بينفّذ حاجة.` });
  }
}

async function checkCustomThresholds({ productId, live, settings }) {
  const k = live.kpis || {};
  const minSample = Math.max(1, Number(settings.ambMinPurchasesBeforeScaling) || 5);

  const cpaThreshold = Number(settings.ambLiveAlertCpaThreshold);
  if (cpaThreshold > 0 && k.cpa != null && (k.purchases || 0) >= minSample && k.cpa > cpaThreshold) {
    await raiseAlert({
      severity: 'WARNING', category: 'LIVE_CAMPAIGN',
      title: `CPA تخطّى الحد المحدد`, entityId: String(productId),
      message: `الـCPA الحالي ${Math.round(k.cpa)} ج.م تخطّى الحد اللي انت حدّده (${cpaThreshold} ج.م) — على عيّنة ${k.purchases} مشترية حقيقية.`,
      dedupeKey: `live-cpa:${productId}`,
    }).catch(() => {});
  }

  const spendThreshold = Number(settings.ambLiveAlertSpendNoPurchaseThreshold);
  if (spendThreshold > 0 && (k.purchases || 0) === 0 && (k.spend || 0) > spendThreshold) {
    await raiseAlert({
      severity: 'WARNING', category: 'LIVE_CAMPAIGN',
      title: `صرف بدون أي مشترية`, entityId: String(productId),
      message: `اتصرف ${Math.round(k.spend)} ج.م من غير أي مشترية مسجّلة على Meta — تخطّى الحد اللي انت حدّده (${spendThreshold} ج.م).`,
      dedupeKey: `live-spend-no-purchase:${productId}`,
    }).catch(() => {});
  }
}

export async function runLiveCampaignAlertsTick() {
  const settings = await getAmbSettings();
  if (!settings.ambLiveAlertsEnabled) return { skipped: 'DISABLED' };

  const maxPerTick = Math.max(1, Number(settings.ambLiveAlertMaxProductsPerTick) || 5);
  const productIds = (await candidateProductIds()).slice(0, maxPerTick);

  let checked = 0, failed = 0;
  for (const productId of productIds) {
    try {
      const live = await getLiveCampaignStatusByProductId({ productId, windowName: 'today' });
      if (live.linked) { await checkCustomThresholds({ productId, live, settings }); await checkMilestones({ productId, settings }).catch((e) => logger.warn('[liveCampaignAlerts] milestones failed', { productId, message: e.message })); }
      await get_incidents({ productId, window: 'last7' }).catch(() => {}); // reuses the real, existing, evidence-gated incident detection verbatim
      checked++;
    } catch (err) {
      failed++;
      logger.warn('[liveCampaignAlerts] tick failed for product', { productId, message: err.message });
    }
  }
  if (checked || failed) logger.info('AMB live-campaign alerts tick', { checked, failed, candidates: productIds.length });
  return { checked, failed, candidates: productIds.length };
}

let timer = null;
/** Called once from server.js — its own interval, gated by ambLiveAlertIntervalMinutes, so a Settings change takes effect without a restart (same pattern as startAmbSnapshotScheduler()'s own gating). */
export function startLiveCampaignAlertsScheduler() {
  if (timer) return;
  const TICK_MS = 60 * 1000;
  let lastRunAt = 0;
  timer = setInterval(async () => {
    try {
      const settings = await getAmbSettings();
      if (!settings.ambLiveAlertsEnabled) return;
      const intervalMs = Math.max(5, Number(settings.ambLiveAlertIntervalMinutes) || 30) * 60 * 1000;
      if (Date.now() - lastRunAt < intervalMs) return;
      lastRunAt = Date.now();
      await runLiveCampaignAlertsTick();
    } catch (err) {
      logger.error('AMB live-campaign alerts scheduler tick failed', { message: err.message });
    }
  }, TICK_MS);
  logger.info('AMB live-campaign alerts scheduler started (60s tick, interval-gated, disabled by default)');
}
