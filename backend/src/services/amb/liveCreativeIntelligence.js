// Live Campaign Intelligence — closing the Creative/Hooks/Angles gap so they
// join the SAME continuous auto-refresh architecture as the Overview live
// header, WITHOUT a parallel analytics pipeline and WITHOUT touching any
// existing classification/threshold logic. Every function called here is
// already-exported, already-tested, and already reads exclusively from the
// canonical SYNCED data (MetaPerformanceSnapshot via entityWindowMetrics) —
// buildHierarchy() never makes a live Meta call, so polling this on a timer
// never triggers a new Meta/EasyOrders fetch, exactly as required.
//
//   - hooks/angles: hookAndAngleIntelForProduct() verbatim — the EXACT same
//     function PMC's own Hooks/Angles tabs already source from
//     (productMarketing.js's computeSnapshot(), confirmed by reading it) —
//     so the live view and the analyzed snapshot can never show two
//     different numbers for the same hook/angle.
//   - per-Ad/Creative rows: NEW granularity (creativeIntelForProduct groups
//     by Media-Library asset, which can span many ads — the spec asked for
//     per-Ad/Creative rows), built by calling classifyCandidate()/
//     classifyFatigueRadar()/dataSufficiencyOf() — creativeIntel.js's own
//     exported classification building blocks — directly on each ad's
//     already-computed metrics. Same gates, same evidence text, same
//     WINNER/GOOD/TESTING/WEAK/FATIGUED/INSUFFICIENT_DATA vocabulary as
//     every other creative view in this app; never CTR alone (classifyCandidate
//     gates on spend/purchases sample size before any ratio logic runs).
import { prisma } from '../../prisma.js';
import { getAmbSettings } from './settings.js';
import { getConnection } from '../metaAuth.js';
import { getSyncStatus } from './snapshotSync.js';
import { resolveWindow, addDaysISO } from './metricsEngine.js';
import { buildHierarchy } from './hierarchyAnalysis.js';
import { scopedAdsForProduct, hookAndAngleIntelForProduct } from './productMarketingWinnerIntel.js';
import { creativeLabelIndex } from './creativeAnalysis.js';
import { classifyCandidate } from './creativeIntel.js';
import { classifyFatigueRadar } from './creativeFatigueRadar.js';
import { dataSufficiencyOf } from './productMarketingScoring.js';
import { resolveEffectiveProductId } from './productMarketing.js';
import { verifyProductStoreScope } from './storeScope.js';

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

async function resolveAmbProduct(profileId, storeId) {
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);
  const productId = await resolveEffectiveProductId(profile);
  if (!productId) return { productId: null, ambProduct: null };
  const scope = await verifyProductStoreScope({ productId, storeId });
  if (!scope.ok) return { productId: null, ambProduct: null, storeError: scope };
  const ambProduct = await prisma.ambProduct.findUnique({ where: { product_id: productId } });
  return { productId, ambProduct };
}

function adRow(m) {
  return { spend: m.spend || 0, purchases: m.purchases || 0, cpa: m.cpa, ctr: m.ctr, dataSufficiency: m.dataSufficiency || dataSufficiencyOf({ spend: m.spend, purchases: m.purchases }) };
}

/**
 * Per-Ad/Creative live rows + the SAME hooks/angles tables PMC's own tabs
 * already show — one composition, one freshness story, for the new
 * continuous Creative/Hooks/Angles tab refresh.
 */
export async function getLiveCreativeIntelligence({ profileId, storeId, windowName = 'last7' }) {
  const { productId, ambProduct, storeError } = await resolveAmbProduct(profileId, storeId);
  if (storeError) return { linked: false, ...storeError };
  if (!productId) return { linked: false, reason: 'المنتج لسه مش مربوط بمنتج حقيقي في الكتالوج.' };
  if (!ambProduct) return { linked: true, mapped: false, reason: 'لا يوجد ربط Meta لهذا المنتج بعد — لازم تأكيد ربط حملة واحدة على الأقل أولاً.' };

  const connection = await getConnection();
  const adAccountId = connection?.selected_ad_account_id || null;
  if (!adAccountId) return { linked: true, mapped: true, reason: 'لا يوجد حساب إعلانات Meta متصل حاليًا.' };

  const settings = await getAmbSettings();
  const window = resolveWindow(windowName);
  const gate = {
    targetCpa: Number(settings.ambDefaultTargetCpa) || 120,
    minSpend: Number(settings.ambMinSpendBeforeDecision) || 150,
    minPurchases: Number(settings.ambMinPurchasesBeforeScaling) || 5,
  };

  // Sequenced, not Promise.all'd: buildHierarchy() alone runs several
  // parallel queries, and hookAndAngleIntelForProduct() calls buildHierarchy()
  // AGAIN internally — running all of this concurrently (plus this server's
  // many other 30-60s scheduler ticks sharing the SAME small Prisma
  // connection pool) exhausted it in testing. Sequencing trades a little
  // latency for staying well under the pool limit; zero change to what any
  // of these functions compute.
  const syncStatus = await getSyncStatus();
  const tree = await buildHierarchy({ adAccountId, window, settings });
  const hookAngle = await hookAndAngleIntelForProduct({ adAccountId, window, settings, ambProductId: ambProduct.id });
  const ads = scopedAdsForProduct(tree, ambProduct.id);

  // Same "immediately-preceding equal-length window" fatigue comparison
  // creativeIntelForProduct() itself uses — never a second/different rule.
  let priorById = new Map();
  try {
    const spanDays = (new Date(window.to) - new Date(window.from)) / 86_400_000;
    const priorTo = addDaysISO(window.from, -1);
    const priorFrom = addDaysISO(priorTo, -Math.round(spanDays));
    const priorTree = await buildHierarchy({ adAccountId, window: { from: priorFrom, to: priorTo }, settings });
    const priorAds = scopedAdsForProduct(priorTree, ambProduct.id);
    priorById = new Map(priorAds.map((a) => [a.id, adRow(a.metrics || {})]));
  } catch { priorById = new Map(); } // best-effort only, same as creativeIntelForProduct's own fatigue lookup

  const creativeIds = [...new Set(ads.map((a) => a.creativeId).filter(Boolean))];
  const labelIdx = await creativeLabelIndex(creativeIds);

  const creative = ads.map((ad) => {
    const m = ad.metrics || {};
    const row = adRow(m);
    const verdict = classifyCandidate(row, { ...gate, priorRow: priorById.get(ad.id) || null });
    const fatigue = classifyFatigueRadar(row, priorById.get(ad.id) || null, verdict);
    const ca = ad.creativeId ? labelIdx.get(ad.creativeId) : null;
    const hook = ca?.status === 'ANALYZED' ? (ca.hook || (JSON.parse(ca.hook_types_json || '[]')[0] || null)) : null;
    const angle = ca?.status === 'ANALYZED' ? ca.selling_angle : null;
    return {
      adId: ad.id, adName: ad.name, adsetName: ad.adsetName, campaignName: ad.campaignName,
      spend: m.spend, impressions: m.impressions, ctr: m.ctr, cpc: m.cpc, purchases: m.purchases,
      cpa: m.cpa, frequency: m.frequency,
      hook, angle,
      classification: verdict.classification, confidence: verdict.confidence, evidence: verdict.evidence,
      fatigueState: fatigue.state, fatigueEvidence: fatigue.evidence,
    };
  }).sort((a, b) => (a.cpa == null) - (b.cpa == null) || (a.cpa || 0) - (b.cpa || 0));

  return {
    linked: true, mapped: true, productId, window,
    creative,
    hooks: hookAngle.hooks,
    angles: hookAngle.angles,
    freshness: { meta: { lastSuccessAt: syncStatus.lastSuccessAt, intervalMinutes: syncStatus.intervalMinutes } },
    generatedAt: new Date().toISOString(),
  };
}
