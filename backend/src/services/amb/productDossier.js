// Smart Decision Center — Product Decision Dossier. A pure composition
// layer: bundles every EXISTING Phase 2/3/4/5/6/9/10 read into ONE response
// so the dossier UI never has to fire eight separate requests. No new
// analysis logic lives here — every number/classification is delegated to
// the already-built, already-tested functions those phases shipped.
//
// Opening a product for the FIRST time (no persisted decision yet) is
// itself the "analyze automatically" trigger the UX spec requires — the
// user never presses a manual "analyze" button for that. Every later open
// reads the latest PERSISTED decision (fast); a separate, explicit
// "إعادة التحليل" action (the existing POST /product-decision/:id) forces a
// fresh recompute on demand.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection } from '../metaAuth.js';
import { getAmbSettings } from './settings.js';
import { resolveProductCampaigns } from './productPerformance.js';
import { buildProductDecisionPackage, persistProductDecision } from './productDecision.js';
import { getProductLearningMemory } from './productLearning.js';
import { getProductExperiment } from './productExperiment.js';
import { segmentIntelForProduct } from './segmentIntel.js';
import { creativeIntelForProduct } from './creativeIntel.js';
import { resolveWindow } from './metricsEngine.js';
import { getSyncStatus } from './snapshotSync.js';

/** The SAME window productAutoAnalysis.js's scheduler uses to compute/persist the LIVE operational decision — exported so both files derive it from one place and can never drift apart. */
export function resolveOperationalWindowName(settings) {
  return Number(settings.ambAnalysisLookbackDays) >= 30 ? 'last30' : 'last7';
}

/** "منذ الإطلاق" — the real earliest Launch Builder activation for this product, never an invented date. Returns null (never a guess) when this product has no real Launch job. */
async function resolveSinceLaunchWindow(productId) {
  const job = await prisma.ambLaunchJob.findFirst({
    where: { product_id: productId },
    orderBy: { created_at: 'asc' },
    select: { created_at: true, campaigns: { orderBy: { natively_activated_at: 'asc' }, select: { natively_activated_at: true }, take: 1 } },
  });
  if (!job) return null;
  const activatedAt = job.campaigns[0]?.natively_activated_at || job.created_at;
  return { from: new Date(activatedAt).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10), label: 'منذ الإطلاق' };
}

function stockSummary(product) {
  if (product.current_stock == null) return { status: 'STOCK_UNKNOWN', currentStock: null, minimumStock: product.minimum_stock ?? null };
  const min = product.minimum_stock ?? 0;
  const status = product.current_stock <= 0 ? 'OUT_OF_STOCK' : product.current_stock <= min ? 'LOW' : 'SAFE';
  return { status, currentStock: product.current_stock, minimumStock: product.minimum_stock ?? null };
}

function packageFromPersistedRow(row, productId) {
  const facts = JSON.parse(row.reason_facts_json || '{}');
  const metrics = JSON.parse(row.current_metrics_json || '{}');
  return {
    productId, productName: row.product_name,
    window: { from: row.time_window_from, to: row.time_window_to, label: row.time_window_label },
    health: facts.health || null,
    diagnosis: { bottleneck: facts.bottleneck || null, metrics },
    decision: row.decision, confidence: row.confidence, reason: row.reason,
    winners: facts.winners || null, losers: facts.losers || null,
    proposedChange: facts.proposedChange || null, successMetric: facts.successMetric || null,
    evaluationWindowDays: facts.evaluationWindowDays || null,
    businessConversionRate: facts.businessConversionRate || null, priceTestOpportunity: facts.priceTestOpportunity || null,
    dataQuality: facts.dataQuality || null,
    changeReasons: facts.changeReasons || null,
    recommendationId: row.id, recommendationStatus: row.status,
    generatedAt: row.created_at,
  };
}

/**
 * @param {{productId:number, windowName?:string, from?:string, to?:string, forceRefresh?:boolean}} params
 *
 * VIEW WINDOW vs OPERATIONAL DECISION WINDOW — a mandatory, explicit
 * separation. `windowName`/`from`/`to` control what this ONE response
 * shows (the "VIEW WINDOW"); the product's real, persisted, currently-live
 * decision (the "CURRENT OPERATIONAL DECISION") is a SEPARATE thing that
 * only ever changes via the 30-min auto-analysis scheduler or an explicit
 * `forceRefresh` — never merely by a human looking at a different date
 * range. Opening the dossier with NO windowName/from/to (a normal open) is
 * the one case that also doubles as "first analysis" / respects
 * forceRefresh, because that IS a request for the current operational
 * view. Any OTHER explicit window (يوم مخصص / آخر 30 يوم / منذ الإطلاق /
 * anything not equal to the real operational window) always computes a
 * fresh, honest, read-only package and NEVER writes a new AmbRecommendation
 * — so casually inspecting history can never overwrite today's live
 * decision.
 */
export async function getProductDossier({ productId, windowName, from, to, forceRefresh = false }) {
  const pid = Number(productId);
  const product = await prisma.product.findUnique({
    where: { id: pid },
    select: { id: true, product_name: true, store_id: true, sku: true, category: true, current_stock: true, minimum_stock: true, active: true },
  });
  if (!product) { const e = new Error('المنتج غير موجود.'); e.status = 404; throw e; }

  const ambProduct = await prisma.ambProduct.findUnique({ where: { product_id: pid }, select: { id: true, image_url: true } });
  const stock = stockSummary(product);
  const base = { productId: pid, productName: product.product_name, storeId: product.store_id, sku: product.sku, category: product.category, image: ambProduct?.image_url || null, stock };

  const campaigns = await resolveProductCampaigns(pid);
  if (!campaigns.length) {
    return { ...base, linked: false, message: 'المنتج غير مربوط بأي حملة حالياً — اربطه من رفع الكامبين أو من صفحة ربط الحملات.' };
  }

  const connection = await getConnection();
  const adAccountId = connection?.selected_ad_account_id || null;
  const settings = await getAmbSettings();
  const operationalWindowName = resolveOperationalWindowName(settings);

  const isCustomRange = !!(from || to);
  const isSinceLaunch = windowName === 'since_launch';
  const isViewingOperational = !isCustomRange && !isSinceLaunch && (!windowName || windowName === operationalWindowName);

  // The CURRENT OPERATIONAL DECISION — fetched unconditionally, regardless
  // of what window is being viewed, so the UI can always show "this is the
  // real live decision" separately from "this is what you're looking at".
  const latestOperationalRec = ambProduct ? await prisma.ambRecommendation.findFirst({ where: { level: 'product', amb_product_id: ambProduct.id }, orderBy: { created_at: 'desc' } }) : null;

  let pkg;
  if (isViewingOperational) {
    if (forceRefresh || !latestOperationalRec) {
      pkg = await buildProductDecisionPackage({ productId: pid, windowName: operationalWindowName, settings, adAccountId });
      const persisted = await persistProductDecision({ pkg, adAccountId, batchId: `dossier-${forceRefresh ? 'refresh' : 'first'}-${Date.now()}` });
      pkg = { ...pkg, recommendationId: persisted.id, recommendationStatus: persisted.status };
    } else {
      pkg = packageFromPersistedRow(latestOperationalRec, pid);
      // The persisted row only carries the final DECISION's own facts
      // (winners/bottleneck/health) — the Audience/Geo and Creative
      // Leaderboard TABS are read-only analysis views, so they're always
      // freshly recomputed here. CRITICAL: locked to pkg.window's own
      // frozen from/to, never a freshly re-resolved windowName — this is
      // the exact window-drift bug fixed earlier in this same file.
      const [segmentIntel, creativeIntel] = await Promise.all([
        segmentIntelForProduct({ productId: pid, storeId: product.store_id, adAccountId, from: pkg.window.from, to: pkg.window.to, windowLabel: pkg.window.label, settings }).catch(() => ({ metaAvailable: false })),
        ambProduct && adAccountId ? creativeIntelForProduct({ adAccountId, from: pkg.window.from, to: pkg.window.to, windowLabel: pkg.window.label, settings, ambProductId: ambProduct.id, compareToPrior: true }).catch(() => ({ dataAvailable: false })) : Promise.resolve({ dataAvailable: false }),
      ]);
      pkg.segmentIntel = segmentIntel;
      pkg.creativeIntel = creativeIntel;
    }
  } else {
    // An explicit, NON-operational VIEW (custom range / since-launch / any
    // named window other than the real operational one) — always computed
    // fresh, NEVER persisted as a new AmbRecommendation. Every tab
    // (funnel/diagnosis/health/segments/creatives/decision) is recalculated
    // for this exact window via buildProductDecisionPackage's own single
    // window-resolution point, so nothing here can drift internally either.
    let viewFrom = from, viewTo = to;
    if (isSinceLaunch) {
      const sinceLaunch = await resolveSinceLaunchWindow(pid);
      if (sinceLaunch) { viewFrom = sinceLaunch.from; viewTo = sinceLaunch.to; }
      else { const w = resolveWindow('last30'); viewFrom = w.from; viewTo = w.to; } // no real Launch job found — never invented, falls back to a clearly-different, honest window
    }
    pkg = isCustomRange || isSinceLaunch
      ? await buildProductDecisionPackage({ productId: pid, from: viewFrom, to: viewTo, windowLabel: isSinceLaunch ? 'منذ الإطلاق' : 'فترة مخصصة', settings, adAccountId })
      : await buildProductDecisionPackage({ productId: pid, windowName, settings, adAccountId });
    pkg.recommendationId = null;
    pkg.recommendationStatus = 'VIEW_ONLY';
  }

  const [history, learning, experiment, easyOrdersLastOrder, ambSyncStatus] = await Promise.all([
    ambProduct ? prisma.ambRecommendation.findMany({ where: { level: 'product', amb_product_id: ambProduct.id }, orderBy: { created_at: 'desc' }, take: 20, select: { id: true, decision: true, confidence: true, status: true, created_at: true, reviewed_at: true } }) : Promise.resolve([]),
    getProductLearningMemory({ productId: pid }).catch(() => ({ hasProfile: false, entries: [] })),
    latestOperationalRec ? getProductExperiment({ recId: latestOperationalRec.id }).catch(() => ({ hasExperiment: false })) : Promise.resolve({ hasExperiment: false }),
    prisma.easyOrdersOrder.findFirst({ where: { product_id: pid, ...(product.store_id ? { store_id: product.store_id } : {}) }, orderBy: { updated_at: 'desc' }, select: { updated_at: true } }),
    getSyncStatus().catch(() => null),
  ]);

  const sinceLaunchAvailable = await resolveSinceLaunchWindow(pid).then((w) => !!w).catch(() => false);

  return {
    ...base, linked: true, mappedCampaigns: campaigns.length, package: pkg, history, learning, experiment,
    isViewingOperational,
    sinceLaunchAvailable,
    operationalDecision: latestOperationalRec ? {
      recommendationId: latestOperationalRec.id,
      decision: latestOperationalRec.decision,
      confidence: latestOperationalRec.confidence,
      status: latestOperationalRec.status,
      window: { from: latestOperationalRec.time_window_from, to: latestOperationalRec.time_window_to, label: latestOperationalRec.time_window_label },
      lastRecalculatedAt: latestOperationalRec.created_at,
    } : null,
    freshness: {
      metaLastSync: ambSyncStatus?.lastSuccessAt || null,
      easyOrdersLastSync: easyOrdersLastOrder?.updated_at || null,
    },
  };
}
