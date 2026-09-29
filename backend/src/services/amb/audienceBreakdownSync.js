// Live Campaign Intelligence Slice 2 — periodic audience-breakdown history
// capture. This is deliberately NOT a second Meta-polling pipeline: it calls
// the SAME fetchAudienceBreakdown() core metaAudienceBreakdown.js's on-demand
// PMC endpoint already uses, on its own much-longer interval
// (ambAudienceBreakdownIntervalMinutes, default 60 min, vs the core 15-min
// performance sync), and only for products with real recent Meta activity —
// never for a dormant product, and never more than
// ambAudienceBreakdownMaxProductsPerTick per tick, to stay well under Meta's
// rate limits (the same discipline easyOrdersReconcile.js's bounded batch and
// cloneEngine.js's activateDueJobs() take:50 already use elsewhere).
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getAmbSettings } from './settings.js';
import { resolveProductCampaigns } from './productPerformance.js';
import { resolveWindow } from './metricsEngine.js';
import { fetchAudienceBreakdown } from './metaAudienceBreakdown.js';

const CAPTURE_WINDOW = 'today'; // "live" capture — history is built from many "today" snapshots over time, one per tick

/** Every distinct Product id with a resolvable Meta campaign chain — the deterministic Launch chain OR a confirmed historical mapping. Same two sources productPerformance.js's resolveProductCampaigns() itself unions, just inverted to list candidate products instead of one product's campaigns. Exported so other Slice 2+ schedulers (e.g. Slice 4's alert tick) share the exact same "which products are live" definition instead of a second one drifting into existence. */
export async function candidateProductIds() {
  const [launched, mapped] = await Promise.all([
    prisma.ambLaunchJob.findMany({ where: { product_id: { not: null }, campaigns: { some: { meta_campaign_id: { not: null } } } }, distinct: ['product_id'], select: { product_id: true } }),
    prisma.ambProductCampaignMap.findMany({ where: { status: 'MAPPED' }, select: { amb_product: { select: { product_id: true } } } }),
  ]);
  const ids = new Set();
  for (const l of launched) if (l.product_id) ids.add(l.product_id);
  for (const m of mapped) if (m.amb_product?.product_id) ids.add(m.amb_product.product_id);
  return [...ids];
}

/** Real recent activity check — never spend a Meta breakdown call on a dormant product. */
async function hasRecentSpend(campaignIds) {
  if (!campaignIds.length) return false;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const row = await prisma.metaPerformanceSnapshot.findFirst({
    where: { level: 'campaign', campaign_id: { in: campaignIds }, date_start: { gte: since }, spend: { gt: 0 } },
    select: { id: true },
  });
  return !!row;
}

async function dueForCapture(productId, intervalMs) {
  const last = await prisma.ambAudienceBreakdownSnapshot.findFirst({ where: { product_id: productId, window_name: CAPTURE_WINDOW }, orderBy: { captured_at: 'desc' }, select: { captured_at: true } });
  if (!last) return true;
  return Date.now() - new Date(last.captured_at).getTime() >= intervalMs;
}

export async function runAudienceBreakdownSync() {
  const settings = await getAmbSettings();
  const intervalMs = Math.max(15, Number(settings.ambAudienceBreakdownIntervalMinutes) || 60) * 60 * 1000;
  const maxPerTick = Math.max(1, Number(settings.ambAudienceBreakdownMaxProductsPerTick) || 5);

  let captured = 0, skipped = 0, failed = 0;
  const productIds = await candidateProductIds();
  for (const productId of productIds) {
    if (captured >= maxPerTick) break;
    try {
      if (!(await dueForCapture(productId, intervalMs))) { skipped++; continue; }
      const campaigns = await resolveProductCampaigns(productId);
      if (!campaigns.length) { skipped++; continue; }
      if (!(await hasRecentSpend(campaigns.map((c) => c.campaignId)))) { skipped++; continue; } // §23 "don't overreact"/don't waste calls on a quiet product — it simply gets no new history point this tick

      const adAccountId = campaigns[0].adAccountId; // resolveProductCampaigns already groups by the product's own account(s); Slice 2 captures against the primary one, same simplification productPerformance.js's own aggregation already makes
      const window = resolveWindow(CAPTURE_WINDOW);
      const result = await fetchAudienceBreakdown({ adAccountId, campaignIds: campaigns.map((c) => c.campaignId), window });
      await prisma.ambAudienceBreakdownSnapshot.create({
        data: { product_id: productId, ad_account_id: adAccountId, window_name: CAPTURE_WINDOW, available: !!result.available, breakdown_json: JSON.stringify(result) },
      });
      captured++;
    } catch (err) {
      failed++;
      logger.warn('[audienceBreakdownSync] capture failed', { productId, message: err.message });
    }
  }
  if (captured || failed) logger.info('AMB audience-breakdown sync tick', { captured, skipped, failed, candidates: productIds.length });
  return { captured, skipped, failed, candidates: productIds.length };
}

let timer = null;
/** Called once from server.js — its own 5-min tick (breakdown captures are hourly-ish, no need for the core sync's 60s granularity), interval-gated the same way startAmbSnapshotScheduler() gates the core sync. */
export function startAmbAudienceBreakdownScheduler() {
  if (timer) return;
  const TICK_MS = 5 * 60 * 1000;
  timer = setInterval(() => { runAudienceBreakdownSync().catch((err) => logger.error('AMB audience-breakdown scheduler tick failed', { message: err.message })); }, TICK_MS);
  logger.info('AMB audience-breakdown scheduler started (5m tick, hourly-ish per-product capture)');
}

/**
 * Real trend: compares the LATEST capture against the closest real capture
 * at least `lookbackHours` old — never fabricates a data point. Returns null
 * fields wherever a real prior point doesn't exist yet, per the "insufficient
 * data stays insufficient" rule (never silently substitutes "now" for a
 * missing "then").
 */
export async function getAudienceBreakdownTrend({ productId, lookbackHours = 6 }) {
  const rows = await prisma.ambAudienceBreakdownSnapshot.findMany({
    where: { product_id: productId, window_name: CAPTURE_WINDOW, available: true },
    orderBy: { captured_at: 'desc' },
    take: 50,
  });
  if (!rows.length) return { available: false, reason: 'لا يوجد تاريخ محفوظ لتقسيمات الجمهور لهذا المنتج بعد.' };

  const latest = rows[0];
  const cutoff = new Date(latest.captured_at).getTime() - lookbackHours * 3600 * 1000;
  const prior = rows.find((r) => new Date(r.captured_at).getTime() <= cutoff) || null;

  const parse = (r) => { try { return JSON.parse(r.breakdown_json); } catch { return null; } };
  return {
    available: true,
    latest: { capturedAt: latest.captured_at, data: parse(latest) },
    prior: prior ? { capturedAt: prior.captured_at, data: parse(prior) } : null,
    priorReason: prior ? null : `لا يوجد التقاط حقيقي أقدم من ${lookbackHours} ساعة بعد — الاتجاه هيظهر بمجرد توفر نقطة تاريخية حقيقية.`,
  };
}
