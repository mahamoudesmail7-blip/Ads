// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 14: Incident Center. Detects meaningful, evidence-backed anomalies
// for a product and raises them through the EXISTING amb_alerts pipeline
// (services/amb/alerts.js) rather than a new table — dedupeKey means a
// still-true condition upserts instead of spamming a fresh row every cycle.
//
// Every check here composes over data ALREADY computed elsewhere (the
// Decision Package, Creative Fatigue Radar, Data Quality Gate, Meta
// snapshots, task history) — never a new metrics fetch pipeline, never an
// invented threshold beyond what those modules already use. A condition
// this file cannot verify with real data (e.g. pixel/tracking health, which
// has no dedicated signal anywhere in this codebase yet) is NOT faked —
// it is simply not emitted, and is called out explicitly in the System
// Coverage Report as NO_TOOL_COVERAGE.
//
// This module is strictly READ + ALERT (raiseAlert is a passive DB write to
// the notification table, never a Meta write, never touches Money Guard,
// Data Quality Gate, or the approval pipeline) — it never bypasses any of
// those gates because it never executes anything.
import { prisma } from '../../prisma.js';
import { addDaysISO } from './metricsEngine.js';
import { getProductPerformance, resolveProductCampaigns, computeBusinessConversionRate } from './productPerformance.js';
import { raiseAlert } from './alerts.js';

export const INCIDENT_SEVERITY = ['INFO', 'WARNING', 'HIGH', 'CRITICAL'];

const SPEND_SPIKE_RATIO = 1.6; // spend up 60%+ vs prior equal-length window
const SPEND_SPIKE_MIN = 200; // ignore noise on tiny accounts
const ORDERS_COLLAPSE_RATIO = 0.5; // Meta purchases down 50%+ vs prior, with spend not similarly down
const ORDERS_COLLAPSE_MIN_PRIOR_PURCHASES = 5; // don't call a collapse on a near-zero base
const BUSINESS_CR_COLLAPSE_RATIO = 0.6; // Business CR down 40%+ vs prior
const REPEATED_FAILURE_WINDOW_DAYS = 7;
const REPEATED_FAILURE_THRESHOLD = 2; // >=2 FAILED tasks on the same entity in the window

function inc({ type, severity, category = 'INCIDENT', title, message, evidence }) {
  return { type, severity, category, title, message, evidence };
}

async function priorWindowPerformance(productId, window) {
  const spanDays = Math.max(1, Math.round((new Date(window.to) - new Date(window.from)) / 86_400_000));
  const priorTo = addDaysISO(window.from, -1);
  const priorFrom = addDaysISO(priorTo, -spanDays);
  try {
    return await getProductPerformance({ productId, from: priorFrom, to: priorTo });
  } catch {
    return null; // best-effort only — a failed prior lookup just disables trend-based incidents, never fabricated
  }
}

/**
 * @param {{productId:number, productName:string, pkg:object}} params — pkg is
 *   an already-built buildProductDecisionPackage() output (dataQuality,
 *   diagnosis.allSignals, winners.creative.fatigueRadar, window).
 */
export async function detectIncidentsForProduct({ productId, productName, pkg }) {
  const incidents = [];
  const pid = Number(productId);
  const name = productName || pkg.productName || `منتج #${pid}`;

  // 1) Meta/EasyOrders staleness + campaign mapping — reuse the Data Quality
  // Gate's own checks verbatim, never a second staleness threshold.
  for (const c of pkg.dataQuality?.criticalFailures || []) {
    if (c.name === 'CAMPAIGN_MAPPING' || c.name === 'DUPLICATE_CAMPAIGNS') {
      incidents.push(inc({ type: 'CAMPAIGN_MAPPING_MISSING', severity: 'CRITICAL', title: `ربط الحملة غير مؤكد: ${name}`, message: c.reason, evidence: c.name }));
    }
  }
  for (const w of pkg.dataQuality?.warnings || []) {
    if (w.name === 'META_FRESHNESS') incidents.push(inc({ type: 'META_STALE', severity: 'WARNING', title: `بيانات Meta قديمة: ${name}`, message: w.reason, evidence: w.name }));
    if (w.name === 'META_AVAILABILITY') incidents.push(inc({ type: 'META_STALE', severity: 'WARNING', title: `بيانات Meta غير متاحة: ${name}`, message: w.reason, evidence: w.name }));
    if (w.name === 'EASYORDERS_AVAILABILITY') incidents.push(inc({ type: 'EASYORDERS_UNAVAILABLE', severity: 'WARNING', title: `بيانات Easy Orders غير متاحة: ${name}`, message: w.reason, evidence: w.name }));
  }

  // 2) CPA spike / CTR collapse — reuse the funnel diagnosis's own signals,
  // never a second CPA/CTR threshold invented here.
  for (const s of pkg.diagnosis?.allSignals || []) {
    if (['CPA_PROBLEM', 'DELIVERY_PROBLEM'].includes(s.category)) {
      incidents.push(inc({ type: 'CPA_SPIKE', severity: s.severity === 'HIGH' ? 'HIGH' : 'WARNING', title: `${s.problem}: ${name}`, message: s.evidence, evidence: s.category }));
    }
    if (s.category === 'CREATIVE_PROBLEM') {
      incidents.push(inc({ type: 'CTR_COLLAPSE', severity: s.severity === 'HIGH' ? 'HIGH' : 'WARNING', title: `${s.problem}: ${name}`, message: s.evidence, evidence: s.category }));
    }
    if (s.category === 'CREATIVE_FATIGUE') {
      incidents.push(inc({ type: 'CTR_COLLAPSE', severity: 'WARNING', title: `اتجاه ضعف مؤكَّد بفترة سابقة: ${name}`, message: s.evidence, evidence: s.category }));
    }
  }

  // 3) Creative degradation — Slice 2's own Fatigue Radar, current winner only.
  const creativeState = pkg.winners?.creative?.fatigueRadar?.state;
  if (creativeState === 'FATIGUED') {
    incidents.push(inc({ type: 'CREATIVE_DEGRADATION', severity: 'HIGH', title: `الكرياتيف الفائز أنهك: ${name}`, message: pkg.winners.creative.fatigueRadar.evidence || 'الكرياتيف الفائز وصل لحالة FATIGUED.', evidence: 'FATIGUED' }));
  } else if (creativeState === 'FATIGUING' || creativeState === 'WATCH') {
    incidents.push(inc({ type: 'CREATIVE_DEGRADATION', severity: 'WARNING', title: `الكرياتيف الفائز بدأ يضعف: ${name}`, message: pkg.winners.creative.fatigueRadar.evidence || `حالة الرادار: ${creativeState}.`, evidence: creativeState }));
  }

  // 4) Trend incidents needing a real prior-window comparison (spend spike,
  // orders collapse, LPV disappearing, Business CR collapse) — one extra
  // read of the SAME unified performance dataset every other slice already
  // uses, scoped to the immediately preceding equal-length window.
  const prior = pkg.window?.from && pkg.window?.to ? await priorWindowPerformance(pid, pkg.window) : null;
  const curMeta = pkg.diagnosis?.metrics;
  if (prior?.meta?.dataState === 'AVAILABLE' && curMeta) {
    const priorSpend = prior.meta.spend;
    const priorPurchases = prior.meta.purchases;
    const priorLpv = prior.meta.landingPageViews;

    if (priorSpend != null && curMeta.totalSpend != null && priorSpend >= SPEND_SPIKE_MIN && curMeta.totalSpend >= priorSpend * SPEND_SPIKE_RATIO) {
      incidents.push(inc({
        type: 'SPEND_SPIKE', severity: 'WARNING', title: `ارتفاع مفاجئ في الصرف: ${name}`,
        message: `الصرف الحالي ${Math.round(curMeta.totalSpend)} جنيه مقابل ${Math.round(priorSpend)} جنيه في الفترة السابقة المماثلة.`,
        evidence: `ratio=${(curMeta.totalSpend / priorSpend).toFixed(2)}`,
      }));
    }

    if (priorPurchases != null && priorPurchases >= ORDERS_COLLAPSE_MIN_PRIOR_PURCHASES && curMeta.metaPurchases != null && curMeta.metaPurchases <= priorPurchases * ORDERS_COLLAPSE_RATIO) {
      incidents.push(inc({
        type: 'ORDERS_COLLAPSE', severity: 'HIGH', title: `انهيار في المشتريات: ${name}`,
        message: `مشتريات Meta الحالية ${curMeta.metaPurchases} مقابل ${priorPurchases} في الفترة السابقة المماثلة.`,
        evidence: `ratio=${priorPurchases ? (curMeta.metaPurchases / priorPurchases).toFixed(2) : 'n/a'}`,
      }));
    }

    if (priorLpv != null && priorLpv > 0 && (pkg.diagnosis?.metrics?.dataAvailability?.metaMapped) && prior.meta.dataState === 'AVAILABLE') {
      const curLpv = pkg.businessConversionRate?.lpvDenominator;
      if (curLpv === 0 || curLpv == null) {
        incidents.push(inc({
          type: 'LPV_DISAPPEARED', severity: 'HIGH', title: `Landing Page Views اختفت: ${name}`,
          message: `الفترة السابقة كانت فيها ${priorLpv} LPV، والفترة الحالية بدون أي LPV — مؤشر محتمل على مشكلة بكسل/تتبّع.`,
          evidence: `priorLpv=${priorLpv}, currentLpv=${curLpv ?? 'null'}`,
        }));
      }
    }

    const priorCvr = computeBusinessConversionRate({ meta: prior.meta });
    const curCvr = pkg.businessConversionRate;
    if (priorCvr?.dataState === 'AVAILABLE' && curCvr?.dataState === 'AVAILABLE' && priorCvr.value > 0 && curCvr.value <= priorCvr.value * BUSINESS_CR_COLLAPSE_RATIO) {
      incidents.push(inc({
        type: 'BUSINESS_CR_COLLAPSE', severity: 'HIGH', title: `انهيار في معدل التحويل الفعلي: ${name}`,
        message: `معدل التحويل الحالي ${curCvr.value.toFixed(2)}% مقابل ${priorCvr.value.toFixed(2)}% في الفترة السابقة المماثلة.`,
        evidence: `ratio=${(curCvr.value / priorCvr.value).toFixed(2)}`,
      }));
    }
  }

  // 5) Campaign unexpectedly inactive / budget changed — latest two synced
  // snapshots per mapped campaign, reusing meta_performance_snapshots
  // (already populated every sync cycle by snapshotSync.js) rather than a
  // fresh live Meta call.
  const campaigns = await resolveProductCampaigns(pid).catch(() => []);
  for (const c of campaigns) {
    const rows = await prisma.metaPerformanceSnapshot.findMany({
      where: { level: 'campaign', campaign_id: c.campaignId },
      orderBy: { snapshot_at: 'desc' },
      take: 2,
      select: { campaign_status: true, campaign_budget: true, campaign_name: true, snapshot_at: true },
    }).catch(() => []);
    if (rows.length < 2) continue;
    const [latest, prevRow] = rows;
    if (latest.campaign_status && prevRow.campaign_status && latest.campaign_status !== prevRow.campaign_status && ['PAUSED', 'ARCHIVED', 'DISAPPROVED', 'CAMPAIGN_PAUSED'].includes(latest.campaign_status)) {
      incidents.push(inc({
        type: 'CAMPAIGN_UNEXPECTEDLY_INACTIVE', severity: 'HIGH', title: `حملة توقفت بدون إجراء معروف: ${latest.campaign_name || c.campaignId}`,
        message: `الحالة اتغيرت من ${prevRow.campaign_status} إلى ${latest.campaign_status}.`,
        evidence: `campaignId=${c.campaignId}`,
      }));
    }
    if (latest.campaign_budget != null && prevRow.campaign_budget != null && latest.campaign_budget !== prevRow.campaign_budget) {
      const ratio = prevRow.campaign_budget > 0 ? latest.campaign_budget / prevRow.campaign_budget : null;
      if (ratio != null && (ratio >= 1.5 || ratio <= 0.5)) {
        incidents.push(inc({
          type: 'BUDGET_CHANGED_UNEXPECTEDLY', severity: 'WARNING', title: `تغيّر كبير في ميزانية الحملة: ${latest.campaign_name || c.campaignId}`,
          message: `الميزانية اتغيرت من ${Math.round(prevRow.campaign_budget)} إلى ${Math.round(latest.campaign_budget)} جنيه — تأكد إن ده إجراء معروف مش تغيير خارج AI Media Buyer.`,
          evidence: `campaignId=${c.campaignId}, ratio=${ratio.toFixed(2)}`,
        }));
      }
    }
  }

  // 6) Repeated task failure — same entity (campaign/adset/ad tied to this
  // product) failing more than once in the recent window.
  const campaignIds = campaigns.map((c) => c.campaignId).filter(Boolean);
  if (campaignIds.length) {
    const since = new Date(Date.now() - REPEATED_FAILURE_WINDOW_DAYS * 86_400_000);
    const failedTasks = await prisma.assistantTask.findMany({
      where: { entity_id: { in: campaignIds }, status: 'FAILED', created_at: { gte: since } },
      select: { entity_id: true, entity_name: true, kind: true, error: true, created_at: true },
      orderBy: { created_at: 'desc' },
    }).catch(() => []);
    const byEntity = new Map();
    for (const t of failedTasks) {
      const arr = byEntity.get(t.entity_id) || [];
      arr.push(t);
      byEntity.set(t.entity_id, arr);
    }
    for (const [entityId, tasks] of byEntity) {
      if (tasks.length >= REPEATED_FAILURE_THRESHOLD) {
        incidents.push(inc({
          type: 'REPEATED_TASK_FAILURE', severity: 'HIGH', title: `فشل متكرر في تنفيذ مهام: ${tasks[0].entity_name || entityId}`,
          message: `${tasks.length} مهام فشلت خلال ${REPEATED_FAILURE_WINDOW_DAYS} أيام — آخر خطأ: ${(tasks[0].error || 'غير محدد').slice(0, 200)}`,
          evidence: `kinds=${[...new Set(tasks.map((t) => t.kind))].join(',')}`,
        }));
      }
    }
  }

  return { productId: pid, productName: name, incidents, checkedAt: new Date().toISOString() };
}

/**
 * Persists every detected incident through the existing alerts pipeline.
 * dedupeKey is stable per (product, incident type) so a still-true
 * condition upserts the same row (refreshing created_at/read) instead of
 * spamming a new one every detection cycle — same convention every other
 * raiseAlert() caller in this codebase already relies on.
 */
export async function raiseIncidentAlerts({ productId, incidents }) {
  const raised = [];
  for (const i of incidents) {
    const row = await raiseAlert({
      severity: i.severity,
      category: 'INCIDENT',
      title: i.title,
      message: i.message,
      entityId: String(productId),
      entityName: i.title,
      dedupeKey: `incident:${productId}:${i.type}`,
    });
    if (row) raised.push(row);
  }
  return raised;
}
