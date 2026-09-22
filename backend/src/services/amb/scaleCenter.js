// 🚀 مركز التوسّع (Scale Center) — Phase 1. A NEW, narrow execution-only
// layer over systems that already exist and are already correct: the real
// CR formula (productPerformance.js's computeBusinessConversionRate), the
// real data-quality gate (dataQualityGate.js), the real product decision
// package (productDecision.js's buildProductDecisionPackage — already
// bundles decision/dataQuality/businessConversionRate/governorates in one
// call), and the real budget-bump math (budgetBumpEngine.js). This file adds
// ZERO new scoring logic — only a presentation-layer eligibility relabel
// (deriveScaleCenterEligibility) and an on-demand (not scheduler-only) Bump
// evaluation, both explicitly required by the spec. Never writes to Meta.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { resolveWindow, entityWindowMetrics } from './metricsEngine.js';
import { buildProductDecisionPackage } from './productDecision.js';
import { getProductPerformance, resolveProductCampaigns } from './productPerformance.js';
import { discoverRelevantProductIds, resolveProductImages } from './productDiscovery.js';
import { getConnection } from '../metaAuth.js';
import { getAmbSettings } from './settings.js';
import { evaluateAdSetForBump, resolveAdSetLifecycleState, computeBumpedBudget } from './budgetBumpEngine.js';
import { bumpSettingsFrom, latestBumpActionFor, bumpsInLast24h, persistBumpRecommendation } from './budgetBumpOrchestrator.js';

// ---------------------------------------------------------------------------
// A real production attempt at speeding this up (skip segmentIntelForProduct's
// Meta audience-breakdown call, since this page only needs governorates) was
// tried and REVERTED: dropping creativeIntel alongside it broke correctness —
// decideProductAction() can only ever reach SCALE_CANDIDATE when a real
// creative winner exists, so a stubbed creativeIntel made Scale permanently
// unreachable for every product. Adding creativeIntel back (via
// creativeIntelForProduct -> buildHierarchy) fixed correctness but made
// things SLOWER, not faster (217s for 20 products) — ad-level
// entityWindowMetrics per product turned out heavier than the very call this
// was meant to avoid. The user explicitly prioritized correctness over
// speed for this page, so this now uses the SAME real, already-verified
// buildProductDecisionPackage() Decision Center itself uses — no shortcuts,
// no second scoring path, no risk of a different verdict than مركز القرار
// الذكي would show for the same product+window. The genuinely safe part of
// the earlier attempt (a short in-process cache around entityWindowMetrics/
// resolveProductCampaigns, in metricsEngine.js/productPerformance.js) is
// kept — it changes no decision logic, only collapses real duplicate calls.
// ---------------------------------------------------------------------------

function resolveScaleWindow({ windowName, from, to }) {
  return (from || to) ? { from: from || null, to: to || null, label: 'فترة مخصصة' } : resolveWindow(windowName || 'last7');
}

/**
 * Relabels the EXISTING productDecision.js verdict + dataQuality gate into
 * the exact vocabulary the spec's section U requires. A presentation
 * mapping only — same pattern as productActionPlan.js's own relabeling of
 * PRODUCT_DECISIONS for the Action Plan UI. Never a second scoring engine.
 */
function deriveScaleCenterEligibility({ decision, dataQuality, canBump, bumpBlockedReason }) {
  const reasons = [];
  if (dataQuality?.status === 'DECISION_BLOCKED_DATA_QUALITY') {
    return { state: 'DATA_QUALITY_BLOCKED', canScale: false, canBump: false, reasons: dataQuality.criticalFailures.map((c) => c.reason) };
  }
  if (decision === 'SCALE_CANDIDATE') {
    reasons.push('CPA أقل من الهدف', 'حجم مشتريات كافٍ', 'Data Quality VERIFIED');
    if (dataQuality?.status === 'DATA_QUALITY_WARNING') reasons.push('⚠️ فيه تحذيرات بيانات — راجعها قبل التنفيذ.');
    return { state: 'ELIGIBLE_FOR_SCALE', canScale: true, canBump, reasons };
  }
  if (canBump) return { state: 'ELIGIBLE_FOR_BUMP', canScale: false, canBump: true, reasons: ['أداء Ad Set الحالي بيستاهل زيادة ميزانية.'] };
  if (decision === 'INSUFFICIENT_DATA' || dataQuality?.status === 'DATA_QUALITY_WARNING') {
    return { state: 'NEEDS_MORE_DATA', canScale: false, canBump: false, reasons: [dataQuality?.warnings?.[0]?.reason || 'البيانات لسه غير كافية لقرار موثوق.'] };
  }
  if (['KEEP_TESTING', 'AUDIENCE_TEST', 'GEO_TEST', 'NEW_CREATIVE_TEST', 'OFFER_TEST', 'LANDING_PAGE_FIX'].includes(decision)) {
    return { state: 'MONITORING', canScale: false, canBump: false, reasons: [bumpBlockedReason].filter(Boolean) };
  }
  return { state: 'NOT_ELIGIBLE', canScale: false, canBump: false, reasons: [bumpBlockedReason].filter(Boolean) };
}

/** Real ABO ad-set-level bump eligibility for one product's own resolved campaigns — same primitives budgetBumpOrchestrator.js already uses, just evaluated on-demand instead of by the 30-min scheduler, and against the product's OWN campaigns only. */
async function resolveBumpStateForProduct({ productId, adAccountId, campaignIds, settings }) {
  if (!adAccountId || !campaignIds.length) return { canBump: false, reason: 'مفيش حملة حقيقية مرتبطة بهذا المنتج.', adSets: [] };
  const window = resolveWindow('last3');
  const bumpCfg = bumpSettingsFrom(settings);
  let adsetMetrics, campaignMetrics;
  try {
    [campaignMetrics, adsetMetrics] = await Promise.all([
      entityWindowMetrics({ level: 'campaign', from: window.from, to: window.to, adAccountId }),
      entityWindowMetrics({ level: 'adset', from: window.from, to: window.to, adAccountId }),
    ]);
  } catch (err) {
    logger.warn('[scaleCenter] resolveBumpStateForProduct failed', { productId, message: err.message });
    return { canBump: false, reason: 'تعذّر قراءة بيانات Ad Sets الحية.', adSets: [] };
  }

  const campaignIdSet = new Set(campaignIds);
  const candidates = [];
  for (const adSet of adsetMetrics.values()) {
    if (!campaignIdSet.has(adSet.campaignId)) continue;
    if (adSet.status !== 'ACTIVE') continue;
    const campaign = adSet.campaignId ? campaignMetrics.get(adSet.campaignId) : null;
    if (campaign?.budget != null) continue; // CBO — campaign holds the budget, not this ad set
    if (adSet.budget == null) continue;
    candidates.push(adSet);
  }
  if (!candidates.length) return { canBump: false, reason: 'مفيش Ad Set نشط بميزانية ABO خاصة به لهذا المنتج.', adSets: [] };

  const evaluated = [];
  for (const adSet of candidates) {
    const [latestAction, recentBumps] = await Promise.all([
      latestBumpActionFor(adAccountId, adSet.entityId),
      bumpsInLast24h(adAccountId, adSet.entityId),
    ]);
    const lifecycle = resolveAdSetLifecycleState({ latestAction, bumpsInLast24h: recentBumps }, bumpCfg);
    const verdict = lifecycle.canEvaluateBump ? evaluateAdSetForBump({ cpa: adSet.cpa, spend: adSet.spend, purchases: adSet.purchases, currentBudget: adSet.budget }, bumpCfg) : { action: 'WAIT', reason: lifecycle.reason || 'محجوب بسبب حالة الدورة الحالية (cooldown / إجراء معلّق).' };
    evaluated.push({
      adSetId: adSet.entityId, adSetName: adSet.name, campaignId: adSet.campaignId, campaignName: adSet.campaignName,
      currentBudget: adSet.budget, cpa: adSet.cpa, spend: adSet.spend, purchases: adSet.purchases,
      lifecycleState: lifecycle.state, canEvaluateBump: lifecycle.canEvaluateBump,
      cooldownReason: lifecycle.canEvaluateBump ? null : (lifecycle.reason || 'فيه إجراء زيادة سابق لسه في فترة المراقبة/الانتظار.'),
      verdict: verdict.action, verdictReason: verdict.reason || null,
    });
  }
  const anyBumpable = evaluated.some((e) => e.canEvaluateBump && e.verdict === 'BUMP');
  return { canBump: anyBumpable, reason: anyBumpable ? null : (evaluated[0]?.cooldownReason || evaluated[0]?.verdictReason || 'الأداء الحالي مش مؤهل لزيادة ميزانية دلوقتي.'), adSets: evaluated };
}

// A CR (Orders x 100 / LPV) above this is almost certainly NOT a real
// customer conversion rate for e-commerce — it is a signal the denominator
// (Meta Landing Page Views) is under-counted (a common real pixel/attribution
// gap) and/or the numerator includes Easy Orders rows this window's ads
// never actually drove (no deterministic ad-click-to-order key exists — see
// productPerformance.js's own header comment). Never hidden or silently
// "corrected" — the real ordersNumerator/lpvDenominator are always exposed
// so the number can be audited, exactly like a real user flagged live.
const CR_SUSPICIOUS_THRESHOLD = 25;

function govRow(g) {
  return { governorate: g.segment, orders: g.orders, confirmed: g.confirmed, delivered: g.delivered, returned: g.returned, status: g.classification || null, evidence: g.evidence || null };
}

function toRow(pkg, perf, { storeId, image, adAccountId, bumpState, campaigns, campaignNames }) {
  const gov = pkg.segmentIntel?.governorates?.table || [];
  const eligibility = deriveScaleCenterEligibility({
    decision: pkg.decision, dataQuality: pkg.dataQuality,
    canBump: bumpState.canBump, bumpBlockedReason: bumpState.reason,
  });
  const cr = pkg.businessConversionRate;
  const crSuspicious = cr?.dataState === 'AVAILABLE' && (cr.value > CR_SUSPICIOUS_THRESHOLD || cr.lpvDenominator < 50);
  return {
    productId: pkg.productId, productName: pkg.productName, storeId: storeId || null, image: image || null, adAccountId: adAccountId || null,
    window: pkg.window,
    // Raw meta/easyOrders blocks come from getProductPerformance() directly
    // (never re-derived) — buildProductDecisionPackage()'s own `diagnosis`
    // field is a NARROWER reshape (toDiagnosisMetrics) for computeDiagnosis()
    // that drops impressions/dataState, so it is never used for display here.
    meta: perf.meta,
    easyOrders: perf.easyOrders,
    businessConversionRate: { ...cr, suspicious: crSuspicious, suspiciousReason: crSuspicious ? `العينة صغيرة أو غير موثوقة إحصائيًا (${cr.ordersNumerator} أوردر Easy Orders ÷ ${cr.lpvDenominator} LPV من Meta) — النسبة دي أعلى من المعتاد بكتير، غالبًا لأن LPV مش بيتسجل كامل (فجوة في الـ Pixel) أو لأن جزء من الأوردرات دي مش فعليًا جاي من نفس الإعلانات في نفس الفترة. راجع تفاصيل الأوردرات قبل ما تعتمد الرقم ده في قرار.` : null },
    dataQuality: pkg.dataQuality,
    campaigns: (campaigns || []).map((c) => ({ id: c.campaignId, name: campaignNames?.get(c.campaignId) || c.campaignId, via: c.via })),
    governoratesTop3: gov.slice(0, 3).map(govRow),
    governoratesAll: gov.map(govRow),
    bump: bumpState,
    eligibility,
    generatedAt: pkg.generatedAt,
  };
}

/** One product's full Scale Center row — real reuse of buildProductDecisionPackage() (the SAME decision/dataQuality/CR/governorates/creative-winner logic مركز القرار الذكي itself uses) + an on-demand ad-set bump check for that product's own real campaigns. */
export async function getScaleCenterProduct({ productId, storeId, windowName, from, to }) {
  const pid = Number(productId);
  const window = resolveScaleWindow({ windowName, from, to });
  const settings = await getAmbSettings();
  const connection = await getConnection();
  const adAccountId = connection?.selected_ad_account_id || null;

  const [pkg, perf, campaigns, images] = await Promise.all([
    buildProductDecisionPackage({ productId: pid, from: window.from, to: window.to, windowLabel: window.label, settings, adAccountId }),
    getProductPerformance({ productId: pid, from: window.from, to: window.to }),
    resolveProductCampaigns(pid).catch(() => []),
    resolveProductImages([pid]),
  ]);
  const campaignIds = campaigns.map((c) => c.campaignId);
  const resolvedAdAccountId = adAccountId || campaigns[0]?.adAccountId || null;
  const [bumpState, campaignNames] = await Promise.all([
    resolveBumpStateForProduct({ productId: pid, adAccountId: resolvedAdAccountId, campaignIds, settings }),
    resolveCampaignNames(campaignIds),
  ]);
  return toRow(pkg, perf, { storeId: storeId || null, image: images.get(pid) || null, adAccountId: resolvedAdAccountId, bumpState, campaigns, campaignNames });
}

/** Real campaign names for display (e.g. "Anti-suffocation _ scale") — a small, targeted DB read, never a second source of truth (the ids themselves already come from resolveProductCampaigns()). */
async function resolveCampaignNames(campaignIds) {
  if (!campaignIds.length) return new Map();
  const rows = await prisma.metaPerformanceSnapshot.findMany({
    where: { campaign_id: { in: campaignIds } }, distinct: ['campaign_id'], select: { campaign_id: true, campaign_name: true },
  }).catch(() => []);
  return new Map(rows.map((r) => [r.campaign_id, r.campaign_name]));
}

/**
 * The product list for the page — bulk-discovered (never N separate
 * discovery queries), each row built via getScaleCenterProduct's same real
 * pipeline. PAGINATED on purpose: this remains genuinely expensive (each row
 * does several real Meta/DB calls, including a real Meta audience-breakdown
 * fetch inside segmentIntelForProduct) — the user explicitly chose
 * correctness over speed here rather than a lighter, less-accurate path.
 * Defaults to a page the UI can render without an unbounded wait; the
 * caller can page through the rest via `offset`.
 */
export async function listScaleCenterProducts({ storeId, windowName, from, to, limit = 20, offset = 0 }) {
  const window = resolveScaleWindow({ windowName, from, to });
  const allIds = await discoverRelevantProductIds(storeId);
  const pageIds = allIds.slice(offset, offset + limit);
  if (!pageIds.length) return { window, products: [], total: allIds.length, offset, limit, hasMore: false };

  const BATCH = 5;
  const rows = [];
  for (let i = 0; i < pageIds.length; i += BATCH) {
    const batch = pageIds.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map((pid) => getScaleCenterProduct({ productId: pid, storeId, windowName, from, to })));
    for (const s of settled) if (s.status === 'fulfilled') rows.push(s.value);
      else logger.warn('[scaleCenter] product row failed', { message: s.reason?.message });
  }
  return { window, products: rows, total: allIds.length, offset, limit, hasMore: offset + pageIds.length < allIds.length };
}

/** Real Current→Proposed preview at a USER-CHOSEN percentage (never the scheduler's fixed 25%) — pure reuse of computeBumpedBudget + the same eligibility/cooldown primitives, just parameterized. No write. */
export async function previewBumpForAdSet({ adSetId, pct }) {
  const bumpPct = Number(pct);
  if (!Number.isFinite(bumpPct) || bumpPct <= 0) { const e = new Error('نسبة الزيادة غير صالحة.'); e.status = 400; throw e; }
  const connection = await getConnection();
  const adAccountId = connection?.selected_ad_account_id;
  if (!adAccountId) { const e = new Error('مفيش حساب إعلاني متصل.'); e.status = 400; throw e; }
  const settings = await getAmbSettings();
  const bumpCfg = bumpSettingsFrom(settings);
  const window = resolveWindow('last3');

  const adsetMetrics = await entityWindowMetrics({ level: 'adset', from: window.from, to: window.to, adAccountId });
  const adSet = adsetMetrics.get(adSetId);
  if (!adSet) { const e = new Error('الـ Ad Set غير موجود أو مش نشط حاليًا.'); e.status = 404; throw e; }

  const [latestAction, recentBumps] = await Promise.all([latestBumpActionFor(adAccountId, adSetId), bumpsInLast24h(adAccountId, adSetId)]);
  const lifecycle = resolveAdSetLifecycleState({ latestAction, bumpsInLast24h: recentBumps }, bumpCfg);
  const verdict = lifecycle.canEvaluateBump ? evaluateAdSetForBump({ cpa: adSet.cpa, spend: adSet.spend, purchases: adSet.purchases, currentBudget: adSet.budget }, bumpCfg) : null;
  const proposedBudget = adSet.budget != null ? computeBumpedBudget(adSet.budget, bumpPct) : null;

  return {
    campaignId: adSet.campaignId, campaignName: adSet.campaignName, adSetId, adSetName: adSet.name,
    currentBudget: adSet.budget, proposedBudget, bumpPct,
    cpa: adSet.cpa, spend: adSet.spend, purchases: adSet.purchases,
    lifecycleState: lifecycle.state, canEvaluateBump: lifecycle.canEvaluateBump, cooldownReason: lifecycle.canEvaluateBump ? null : lifecycle.reason,
    verdict: lifecycle.canEvaluateBump ? (verdict?.action || 'STABLE') : 'BLOCKED',
    verdictReason: lifecycle.canEvaluateBump ? verdict?.reason : lifecycle.reason,
    adAccountId,
  };
}

/** "تجهيز الزيادة" — creates the SAME PENDING AmbRecommendation shape budgetBumpOrchestrator.js already creates, just triggered on-demand at the user's chosen percentage instead of the scheduler's fixed one. No Meta write — approval/execution still goes through the existing /recommendations/:id/approve + executor.js pipeline untouched. */
export async function prepareBumpForAdSet({ adSetId, pct, ambProductId, productName }) {
  const preview = await previewBumpForAdSet({ adSetId, pct });
  if (!preview.canEvaluateBump) { const e = new Error(preview.cooldownReason || 'مش متاح تجهيز زيادة دلوقتي لهذا الـ Ad Set.'); e.status = 409; throw e; }
  const adSet = { entityId: adSetId, name: preview.adSetName, campaignId: preview.campaignId, campaignName: preview.campaignName, cpa: preview.cpa, spend: preview.spend, purchases: preview.purchases };
  const evalResult = { currentBudget: preview.currentBudget, proposedBudget: preview.proposedBudget, pct, evidence: `تجهيز يدوي من مركز التوسّع بنسبة ${pct}% — ${preview.verdictReason || ''}`.trim() };
  const rec = await persistBumpRecommendation({ adAccountId: preview.adAccountId, adSet, ambProductId: ambProductId || null, productName: productName || null, evalResult, batchId: `scale-center-bump-${Date.now()}` });
  return { ok: true, recommendationId: rec.id, preview };
}
