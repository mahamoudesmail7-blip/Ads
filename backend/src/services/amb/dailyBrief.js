// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 15: Daily Media Buyer Brief ("لخصلي النهارده"). A pure rollup over
// data ALREADY computed elsewhere — never a second metrics engine:
//   - Account KPIs (spend/Meta purchases/revenue/avgCpa/netProfit-where-
//     verified/status buckets) reuse getOverview() verbatim.
//   - Business Conversion Rate reuses metricsEngine.js's own hardened
//     entityWindowMetrics() aggregation (the same OOM-incident-fixed code
//     path Scale Center relies on), summed account-wide.
//   - Easy Orders totals reuse codOrders.js's codCountsForProduct() per
//     active AmbProduct, scoped to each product's own store (the same
//     multi-store isolation loop getOverview() already uses for netProfit).
//   - Winning/attention products reuse the latest already-computed
//     AmbRecommendation batch — never a fresh per-product recompute here.
//   - Fatiguing creatives / incidents reuse whatever Slice 14's Incident
//     Center has already persisted to amb_alerts — this file never triggers
//     a fresh detection sweep (that stays on-demand, per product, via
//     get_incidents) so the brief stays fast.
//   - Active tests reuse ProductMarketingTest's own status field.
//   - Tasks waiting approval reuse AssistantTask's own FSM state verbatim.
//
// Every section carries its own real freshness signal — Meta sync age,
// Easy Orders sourcing, latest recommendation batch age, incident-scan
// recency — so windows/sources are NEVER silently mixed or assumed fresh.
import { prisma } from '../../prisma.js';
import { getConnection } from '../metaAuth.js';
import { resolveWindow, entityWindowMetrics } from './metricsEngine.js';
import { getOverview } from './overview.js';
import { codCountsForProduct } from './codOrders.js';
import { getSyncStatus } from './snapshotSync.js';

const INCIDENT_LOOKBACK_HOURS = 48;

export async function buildDailyBrief({ windowName } = {}) {
  const overview = await getOverview({ windowName: windowName || 'today' });
  if (!overview.connected) return { ok: false, connected: false, message: overview.message };

  const window = overview.window;
  const connection = await getConnection();
  const adAccountId = connection.selected_ad_account_id;
  const syncStatus = await getSyncStatus();

  // Business Conversion Rate — account-wide, from the same hardened
  // per-campaign aggregation Scale Center already relies on. minSpend/
  // minPurchases only annotate dataSufficiency on each row, never filter
  // which campaigns are included, so this sum is genuinely complete.
  const campaignMetrics = await entityWindowMetrics({ level: 'campaign', from: window.from, to: window.to, adAccountId }, { minSpend: 0, minPurchases: 0 }).catch(() => new Map());
  let totalLpv = 0, hasLpv = false, totalPurchaseResults = 0, hasPr = false;
  for (const m of campaignMetrics.values()) {
    if (m.landingPageViews != null) { totalLpv += m.landingPageViews; hasLpv = true; }
    if (m.purchaseResults != null) { totalPurchaseResults += m.purchaseResults; hasPr = true; }
  }
  const businessConversionRate = hasLpv && hasPr && totalLpv > 0 ? (totalPurchaseResults * 100) / totalLpv : null;

  // Easy Orders — real totals across every active AmbProduct, each scoped
  // to its OWN store (never cross-store leakage).
  const ambProducts = await prisma.ambProduct.findMany({ where: { active: true }, include: { product: { select: { store_id: true } } } });
  let eoOrders = 0, eoDelivered = 0, eoConfirmed = 0, eoReturned = 0, eoSourced = false;
  for (const ap of ambProducts) {
    if (!ap.product_id) continue;
    const cod = await codCountsForProduct({ productId: ap.product_id, storeId: ap.product?.store_id || undefined, from: window.from, to: window.to }).catch(() => ({ source: 'none' }));
    if (cod.source !== 'none') {
      eoSourced = true;
      eoOrders += cod.orders || 0;
      eoDelivered += cod.delivered || 0;
      eoConfirmed += cod.confirmed || 0;
      eoReturned += cod.returned || 0;
    }
  }

  // Winning / attention products — the latest AmbRecommendation batch
  // already computed by the periodic recommendation engine.
  const latestBatch = await prisma.ambRecommendation.findFirst({ where: { ad_account_id: adAccountId }, orderBy: { created_at: 'desc' }, select: { batch_id: true, created_at: true } });
  let winningProducts = [], attentionProducts = [];
  if (latestBatch) {
    const recs = await prisma.ambRecommendation.findMany({
      where: { batch_id: latestBatch.batch_id, level: 'product', status: 'PENDING' },
      select: { product_name: true, amb_product_id: true, decision: true, priority: true, reason: true, confidence: true },
    });
    winningProducts = recs.filter((r) => ['INCREASE_BUDGET', 'SCALE', 'DUPLICATE_WINNER'].includes(r.decision));
    attentionProducts = recs.filter((r) => ['PAUSE', 'PAUSE_LOSER', 'REDUCE_BUDGET'].includes(r.decision) || r.priority === 'P0');
  }

  // Fatiguing creatives + other incidents — whatever Slice 14's Incident
  // Center already persisted recently. A title-prefix split (both are
  // raised by the SAME incidentCenter.js with stable Arabic wording) rather
  // than a new DB column, to avoid a schema/migration change for this slice.
  const recentIncidents = await prisma.ambAlert.findMany({
    where: { category: 'INCIDENT', created_at: { gte: new Date(Date.now() - INCIDENT_LOOKBACK_HOURS * 3600 * 1000) } },
    orderBy: { created_at: 'desc' },
    take: 50,
  });
  const fatiguingCreatives = recentIncidents.filter((a) => a.title.includes('الكرياتيف'));
  const otherIncidents = recentIncidents.filter((a) => !a.title.includes('الكرياتيف'));

  // Active tests — real RUNNING ProductMarketingTest rows.
  const activeTests = await prisma.productMarketingTest.findMany({
    where: { status: 'RUNNING' },
    select: { id: true, test_type: true, hypothesis: true, priority: true, profile: { select: { product_id: true, locked_name: true } } },
    orderBy: { created_at: 'desc' },
    take: 20,
  });

  // Tasks waiting approval — the exact FSM state, no interpretation.
  const tasksWaitingApproval = await prisma.assistantTask.findMany({
    where: { status: 'WAITING_FOR_APPROVAL' },
    select: { task_uuid: true, kind: true, entity_name: true, created_at: true },
    orderBy: { created_at: 'desc' },
    take: 20,
  });

  return {
    ok: true, connected: true,
    window,
    freshness: {
      period: window,
      metaSyncIntervalMinutes: syncStatus.intervalMinutes,
      metaLastSuccessSyncAt: syncStatus.lastSuccessAt,
      easyOrdersSourced: eoSourced,
      analysisLastBatchAt: latestBatch?.created_at || null,
      incidentsScannedThroughHoursAgo: INCIDENT_LOOKBACK_HOURS,
      note: 'الحوادث والكرياتيف المتعب المعروضين هنا من آخر فحص متاح لكل منتج (get_incidents) — مش فحص لحظي لكل المنتجات دلوقتي.',
    },
    spend: overview.kpis.spend,
    metaPurchases: overview.kpis.orders,
    revenue: overview.kpis.revenue,
    netProfit: overview.kpis.netProfit,
    avgCpa: overview.kpis.avgCpa,
    businessConversionRate,
    easyOrders: eoSourced ? { orders: eoOrders, confirmed: eoConfirmed, delivered: eoDelivered, returned: eoReturned } : null,
    winningProducts,
    attentionProducts,
    scaleBumpOpportunities: overview.status.scaleOpportunities,
    fatiguingCreatives: fatiguingCreatives.map((a) => ({ title: a.title, message: a.message, severity: a.severity, at: a.created_at })),
    activeTests: activeTests.map((t) => ({ id: t.id, testType: t.test_type, hypothesis: t.hypothesis, priority: t.priority, productId: t.profile?.product_id, productName: t.profile?.locked_name })),
    incidents: otherIncidents.map((a) => ({ title: a.title, message: a.message, severity: a.severity, at: a.created_at })),
    tasksWaitingApproval,
    aiSays: overview.aiSays,
  };
}
