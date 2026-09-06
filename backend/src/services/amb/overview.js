// AI Media Buyer — Overview. Executive KPI cards + status buckets + the
// "AI Media Buyer Says" line. Every KPI is deterministic (today's snapshots
// joined to real COD data). The narrative line reuses the most recent
// recommendation batch's Claude executive summary when it's fresh, else a
// deterministic sentence.
import { prisma } from '../../prisma.js';
import { getConnection } from '../metaAuth.js';
import { getAmbSettings } from './settings.js';
import { resolveWindow } from './metricsEngine.js';
import { buildHierarchy } from './hierarchyAnalysis.js';
import { netProfitBundle } from './productEconomics.js';
import { codCountsForProduct } from './codOrders.js';
import { getSyncStatus } from './snapshotSync.js';

// `all` counts every node (for the tree's own colour legend); `actionable`
// counts only nodes that are still ACTIVE in Meta — a paused RED campaign is
// historical context, not something that "needs immediate action" today.
function countByColor(tree) {
  const all = { GREEN: 0, YELLOW: 0, RED: 0, BLUE: 0, GRAY: 0 };
  const actionable = { GREEN: 0, YELLOW: 0, RED: 0, BLUE: 0, GRAY: 0 };
  const visit = (node) => {
    const col = node.status?.color;
    if (col) {
      all[col] = (all[col] || 0) + 1;
      if (node.metrics?.metaStatus === 'ACTIVE') actionable[col] = (actionable[col] || 0) + 1;
    }
    for (const ch of node.children || []) visit(ch);
    for (const cr of node.creatives || []) visit(cr);
  };
  for (const p of tree.products || []) for (const ch of p.children || []) visit(ch);
  for (const ch of tree.unmappedCampaigns || []) visit(ch);
  return { all, actionable };
}

export async function getOverview({ windowName } = {}) {
  const connection = await getConnection();
  const settings = await getAmbSettings();
  const syncStatus = await getSyncStatus();

  if (!connection || connection.status !== 'CONNECTED' || !connection.selected_ad_account_id) {
    return { connected: false, syncStatus, message: 'اربط حساب Meta Ads واختار Ad Account عشان تشغّل AI Media Buyer.' };
  }
  const adAccountId = connection.selected_ad_account_id;
  const todayW = resolveWindow('today');
  const window = resolveWindow(windowName || 'today');

  const [treeToday, tree, ambProducts, latestBatch] = await Promise.all([
    buildHierarchy({ adAccountId, window: todayW, settings }),
    buildHierarchy({ adAccountId, window, settings }),
    prisma.ambProduct.findMany({ where: { active: true } }),
    prisma.ambRecommendation.findFirst({ where: { ad_account_id: adAccountId }, orderBy: { created_at: 'desc' }, select: { batch_id: true, created_at: true } }),
  ]);

  // Today KPIs.
  let spend = 0, revenue = 0, purchases = 0, deliveredNet = 0, deliveredOrders = 0, netProfit = 0, hasNet = false;
  const activeCampaigns = new Set();
  const activeAds = new Set();
  for (const p of treeToday.products || []) {
    spend += p.metrics?.spend || 0;
    purchases += p.metrics?.purchases || 0;
    revenue += p.metrics?.revenue || 0;
    const prod = ambProducts.find((x) => String(x.id) === String(p.id));
    if (prod?.product_id) {
      const cod = await codCountsForProduct({ productId: prod.product_id, from: todayW.from, to: todayW.to });
      const bundle = netProfitBundle(prod, { adSpend: p.metrics?.spend || 0, deliveredOrders: cod.delivered, returnedOrders: cod.returned });
      if (bundle.netProfit !== null) { netProfit += bundle.netProfit; hasNet = true; deliveredOrders += cod.delivered || 0; }
    }
    for (const c of p.children || []) {
      if ((c.metrics?.spend || 0) > 0 || c.metrics?.metaStatus === 'ACTIVE') activeCampaigns.add(c.id);
      for (const as of c.children || []) for (const ad of as.children || []) {
        if ((ad.metrics?.spend || 0) > 0 || ad.metrics?.metaStatus === 'ACTIVE') activeAds.add(ad.id);
      }
    }
  }
  for (const c of treeToday.unmappedCampaigns || []) {
    spend += c.metrics?.spend || 0;
    purchases += c.metrics?.purchases || 0;
    revenue += c.metrics?.revenue || 0;
    if ((c.metrics?.spend || 0) > 0) activeCampaigns.add(c.id);
    for (const as of c.children || []) for (const ad of as.children || []) if ((ad.metrics?.spend || 0) > 0) activeAds.add(ad.id);
  }

  const { all: colors, actionable } = countByColor(tree);
  // Scope the "critical PENDING recs" count to the newest batch only — older
  // batches are stale by definition once a newer analysis exists.
  const p0 = latestBatch
    ? await prisma.ambRecommendation.count({ where: { batch_id: latestBatch.batch_id, status: 'PENDING', priority: 'P0' } })
    : 0;

  let aiSays = null;
  if (latestBatch) {
    const fresh = Date.now() - new Date(latestBatch.created_at).getTime() < 6 * 3600 * 1000;
    if (fresh) {
      // Only PENDING recs count toward "AI Media Buyer says" — reconciled/executed ones are done.
      const recs = await prisma.ambRecommendation.findMany({ where: { batch_id: latestBatch.batch_id, status: 'PENDING' }, select: { decision: true, priority: true, entity_name: true, reason: true } });
      const scale = recs.filter((r) => ['INCREASE_BUDGET', 'SCALE', 'DUPLICATE_WINNER'].includes(r.decision)).length;
      const stop = recs.filter((r) => ['PAUSE', 'PAUSE_LOSER', 'REDUCE_BUDGET'].includes(r.decision)).length;
      aiSays = [
        p0 > 0 ? `فيه ${p0} حالة حرجة محتاجة تدخل فوري.` : 'صحة الحساب حاليًا كويسة، مفيش حالات حرجة.',
        scale > 0 ? `${scale} فرصة توسّع اتكشفت.` : null,
        stop > 0 ? `${stop} عنصر بيستهلك ميزانية من غير نتيجة كافية.` : null,
      ].filter(Boolean).join(' ');
    }
  }

  return {
    connected: true,
    syncStatus,
    executionMode: settings.ambExecutionMode,
    window,
    kpis: {
      spendToday: spend,
      revenueToday: revenue,
      netProfitToday: hasNet ? netProfit : null,
      avgCpa: purchases ? spend / purchases : null,
      deliveredCpa: deliveredOrders ? spend / deliveredOrders : null,
      roas: spend > 0 && revenue ? revenue / spend : null,
      activeCampaigns: activeCampaigns.size,
      activeAds: activeAds.size,
    },
    status: {
      // "winners" and "monitoring" reflect the whole account; "immediate
      // action" and "scale opportunities" only count entities still ACTIVE
      // in Meta — you can't act on a paused one.
      winners: actionable.GREEN + actionable.BLUE,
      needsMonitoring: actionable.YELLOW + actionable.GRAY,
      needsImmediateAction: actionable.RED,
      scaleOpportunities: actionable.BLUE,
      pendingCriticalRecs: p0,
    },
    aiSays,
    latestBatchId: latestBatch?.batch_id || null,
    latestBatchAt: latestBatch?.created_at || null,
  };
}
