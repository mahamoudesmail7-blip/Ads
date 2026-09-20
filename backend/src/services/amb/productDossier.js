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

export async function getProductDossier({ productId, windowName, forceRefresh = false }) {
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
  const windowNameResolved = windowName || (Number(settings.ambAnalysisLookbackDays) >= 30 ? 'last30' : 'last7');

  let latestRec = ambProduct ? await prisma.ambRecommendation.findFirst({ where: { level: 'product', amb_product_id: ambProduct.id }, orderBy: { created_at: 'desc' } }) : null;
  let pkg;
  if (forceRefresh || !latestRec) {
    pkg = await buildProductDecisionPackage({ productId: pid, windowName: windowNameResolved, settings, adAccountId });
    latestRec = await persistProductDecision({ pkg, adAccountId, batchId: `dossier-${forceRefresh ? 'refresh' : 'first'}-${Date.now()}` });
    pkg = { ...pkg, recommendationId: latestRec.id, recommendationStatus: latestRec.status };
  } else {
    pkg = packageFromPersistedRow(latestRec, pid);
    // The persisted row only carries the final DECISION's own facts (winners/
    // bottleneck/health) — the Audience/Geo and Creative Leaderboard TABS are
    // read-only analysis views, exactly like the standalone Phase 3/4
    // endpoints, so they're always freshly recomputed here rather than
    // bloating every persisted recommendation with full segment/creative
    // tables it doesn't need for its own decision record.
    //
    // CRITICAL: this MUST use pkg.window's own frozen from/to (the exact
    // dates the persisted funnel/diagnosis/health were computed for), never
    // a freshly re-resolved windowName — resolveWindow('last7') shifts by a
    // day every midnight, so re-resolving here would silently drift this
    // tab's date range away from the Overview tab's the moment a day
    // boundary passes, producing mixed-window numbers in one dossier
    // without any label change to warn about it. A real incident this
    // caused: fixed by locking every dimension to the SAME window.
    const [segmentIntel, creativeIntel] = await Promise.all([
      segmentIntelForProduct({ productId: pid, storeId: product.store_id, adAccountId, from: pkg.window.from, to: pkg.window.to, windowLabel: pkg.window.label, settings }).catch(() => ({ metaAvailable: false })),
      ambProduct && adAccountId ? creativeIntelForProduct({ adAccountId, from: pkg.window.from, to: pkg.window.to, windowLabel: pkg.window.label, settings, ambProductId: ambProduct.id, compareToPrior: true }).catch(() => ({ dataAvailable: false })) : Promise.resolve({ dataAvailable: false }),
    ]);
    pkg.segmentIntel = segmentIntel;
    pkg.creativeIntel = creativeIntel;
  }

  const [history, learning, experiment] = await Promise.all([
    ambProduct ? prisma.ambRecommendation.findMany({ where: { level: 'product', amb_product_id: ambProduct.id }, orderBy: { created_at: 'desc' }, take: 20, select: { id: true, decision: true, confidence: true, status: true, created_at: true, reviewed_at: true } }) : Promise.resolve([]),
    getProductLearningMemory({ productId: pid }).catch(() => ({ hasProfile: false, entries: [] })),
    latestRec ? getProductExperiment({ recId: latestRec.id }).catch(() => ({ hasExperiment: false })) : Promise.resolve({ hasExperiment: false }),
  ]);

  return { ...base, linked: true, mappedCampaigns: campaigns.length, package: pkg, history, learning, experiment };
}
