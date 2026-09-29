// AI Media Buyer / Product Marketing Center — Live Campaign Intelligence,
// Slice 1: a live status header + a real-events timeline for one product's
// launched/mapped campaign(s).
//
// This is deliberately a pure COMPOSITION layer — every number here is
// computed by an already-existing, already-tested function elsewhere in the
// Smart Decision Center. Nothing here re-derives Meta/Easy Orders metrics,
// invents a new evidence-gating rule, or opens a second sync pipeline:
//   - getProductPerformance() (productPerformance.js) for the KPI block.
//   - getSyncStatus() (snapshotSync.js) for Meta freshness.
//   - resolveEffectiveProductId() (productMarketing.js) for profile->product,
//     the same self-healing resolver computeSnapshot() itself uses.
//   - incidentCenter.js's already-raised AmbAlert rows for the timeline.
import { prisma } from '../../prisma.js';
import { getProductPerformance, resolveProductCampaigns } from './productPerformance.js';
import { getSyncStatus } from './snapshotSync.js';
import { resolveEffectiveProductId } from './productMarketing.js';

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

async function resolveProductId(profileId) {
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);
  const productId = await resolveEffectiveProductId(profile);
  return { profile, productId };
}

/** Latest known Meta `effective_status` per resolved campaign, from the already-synced snapshot table — never a fresh Meta call. */
async function latestCampaignStatuses(campaigns) {
  const out = new Map();
  for (const c of campaigns) {
    const row = await prisma.metaPerformanceSnapshot.findFirst({
      where: { level: 'campaign', campaign_id: c.campaignId },
      orderBy: { snapshot_at: 'desc' },
      select: { campaign_status: true, campaign_name: true, snapshot_at: true },
    });
    if (row) out.set(c.campaignId, { status: row.campaign_status || null, name: row.campaign_name || null, asOf: row.snapshot_at });
  }
  return out;
}

/** Earliest known Meta activity (date_start) across the resolved campaigns — an honest fallback launch time, never presented as a real launch time. */
async function earliestKnownActivity(campaigns) {
  if (!campaigns.length) return null;
  const row = await prisma.metaPerformanceSnapshot.findFirst({
    where: { level: 'campaign', campaign_id: { in: campaigns.map((c) => c.campaignId) }, spend: { gt: 0 } },
    orderBy: { date_start: 'asc' },
    select: { date_start: true },
  });
  return row?.date_start || null;
}

/** Real Launch Job time when this product's campaigns were created via the wizard (deterministic chain), else null. */
async function launchJobTime(productId) {
  const job = await prisma.ambLaunchJob.findFirst({
    where: { product_id: productId, campaigns: { some: { meta_campaign_id: { not: null } } } },
    orderBy: { created_at: 'asc' },
    select: { created_at: true },
  });
  return job?.created_at || null;
}

const STALE_MULTIPLIER = 2; // Meta is 🟡 once its last successful sync is older than 2x its own configured interval

// Badge reflects SYNC HEALTH, never business activity — "no orders in the
// last hour" is not a data-freshness problem (§23 "don't overreact"), so
// Easy Orders' last-order timestamp is shown to the user but deliberately
// never downgrades this badge. Only a real provider/mapping problem (a
// dataState the rest of the app already treats as a real problem) or a
// genuinely overdue Meta sync does.
function freshnessBadge({ metaAgeMs, metaIntervalMs, metaDataState }) {
  if (metaDataState === 'PROVIDER_ERROR') return 'RED';
  if (metaDataState === 'META_UNMAPPED' || metaDataState === 'NOT_SYNCED') return 'YELLOW';
  const metaStale = metaAgeMs == null || (metaIntervalMs && metaAgeMs > metaIntervalMs * STALE_MULTIPLIER);
  return metaStale ? 'YELLOW' : 'GREEN';
}

/**
 * The Live Campaign Header (spec §5) for one Product Marketing Center
 * profile — current campaign state, time running, the same KPI block
 * `getProductPerformance()` already returns elsewhere, and per-source
 * freshness. `windowName` defaults to 'today' (this is a LIVE header, not a
 * historical report).
 */
export async function getLiveCampaignStatus({ profileId, windowName = 'today' }) {
  const { productId } = await resolveProductId(profileId);
  if (!productId) return { linked: false, reason: 'المنتج لسه مش مربوط بمنتج حقيقي في الكتالوج.' };

  const [perf, campaigns, syncStatus] = await Promise.all([
    getProductPerformance({ productId, windowName }),
    resolveProductCampaigns(productId),
    getSyncStatus(),
  ]);

  const [statuses, launchAt, earliestActivity, lastEasyOrderRow] = await Promise.all([
    latestCampaignStatuses(campaigns),
    launchJobTime(productId),
    earliestKnownActivity(campaigns),
    perf.storeId
      ? prisma.easyOrdersOrder.findFirst({ where: { product_id: productId, store_id: perf.storeId }, orderBy: { updated_at: 'desc' }, select: { updated_at: true } })
      : prisma.easyOrdersOrder.findFirst({ where: { product_id: productId }, orderBy: { updated_at: 'desc' }, select: { updated_at: true } }),
  ]);

  const launchTime = launchAt || (earliestActivity ? new Date(earliestActivity) : null);
  const launchTimeSource = launchAt ? 'LAUNCH_JOB' : earliestActivity ? 'EARLIEST_KNOWN_ACTIVITY' : null;
  const now = Date.now();
  const timeRunningMs = launchTime ? now - launchTime.getTime() : null;

  const metaAgeMs = syncStatus.lastSuccessAt ? now - new Date(syncStatus.lastSuccessAt).getTime() : null;
  const metaIntervalMs = Math.max(5, Number(syncStatus.intervalMinutes) || 15) * 60 * 1000;
  const easyOrdersAgeMs = lastEasyOrderRow?.updated_at ? now - new Date(lastEasyOrderRow.updated_at).getTime() : null;

  return {
    linked: true,
    productId,
    campaigns: campaigns.map((c) => ({ campaignId: c.campaignId, via: c.via, ...statuses.get(c.campaignId) })),
    launch: { at: launchTime, source: launchTimeSource, timeRunningMs },
    kpis: {
      spend: perf.meta.spend, impressions: perf.meta.impressions, reach: perf.meta.reach,
      clicks: perf.meta.clicks, ctr: perf.meta.ctr, cpc: perf.meta.cpc, cpm: perf.meta.cpm,
      landingPageViews: perf.meta.landingPageViews, purchases: perf.meta.purchases, cpa: perf.meta.cpa,
      revenue: perf.meta.revenue, metaDataState: perf.meta.dataState,
      easyOrdersConfirmationRate: perf.easyOrders.confirmationRate, easyOrdersDeliveryRate: perf.easyOrders.deliveryRate,
      easyOrdersSample: perf.easyOrders.sample, easyOrdersDelivered: perf.easyOrders.delivered, easyOrdersDataState: perf.easyOrders.dataState,
      businessConversionRate: perf.businessConversionRate,
    },
    freshness: {
      meta: { lastSuccessAt: syncStatus.lastSuccessAt, intervalMinutes: syncStatus.intervalMinutes, ageMs: metaAgeMs },
      easyOrders: { lastUpdatedAt: lastEasyOrderRow?.updated_at || null, ageMs: easyOrdersAgeMs },
      badge: freshnessBadge({ metaAgeMs, metaIntervalMs, metaDataState: perf.meta.dataState }),
    },
    window: perf.window,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * The Campaign Intelligence Timeline (spec §24) — merges only already-
 * persisted, already-timestamped real events. No fabricated "early signal"
 * entries yet (those need Slice 2's continuous audience-breakdown history).
 */
export async function buildProductTimeline({ profileId }) {
  const { productId } = await resolveProductId(profileId);
  if (!productId) return { linked: false, events: [] };

  const campaigns = await resolveProductCampaigns(productId);
  const [launchAt, firstSpendRow, firstOrderRow, incidents] = await Promise.all([
    launchJobTime(productId),
    campaigns.length
      ? prisma.metaPerformanceSnapshot.findFirst({ where: { level: 'campaign', campaign_id: { in: campaigns.map((c) => c.campaignId) }, spend: { gt: 0 } }, orderBy: { date_start: 'asc' }, select: { date_start: true } })
      : null,
    prisma.easyOrdersOrder.findFirst({ where: { product_id: productId }, orderBy: { created_at: 'asc' }, select: { created_at: true } }),
    prisma.ambAlert.findMany({ where: { category: 'INCIDENT', entity_id: String(productId) }, orderBy: { created_at: 'asc' }, take: 100, select: { severity: true, title: true, message: true, created_at: true } }),
  ]);

  const events = [];
  if (launchAt) events.push({ type: 'LAUNCH', at: launchAt, label: 'تم إطلاق الحملة' });
  if (firstSpendRow?.date_start) events.push({ type: 'FIRST_SPEND', at: new Date(firstSpendRow.date_start), label: 'أول صرف مسجل' });
  if (firstOrderRow?.created_at) events.push({ type: 'FIRST_ORDER', at: firstOrderRow.created_at, label: 'أول أوردر' });
  for (const i of incidents) events.push({ type: 'INCIDENT', at: i.created_at, label: i.title, severity: i.severity, message: i.message });

  events.sort((a, b) => new Date(a.at) - new Date(b.at));
  return { linked: true, events };
}
