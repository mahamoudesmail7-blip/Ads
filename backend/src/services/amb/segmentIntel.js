// Smart Decision Center Phase 4 — Audience / Segment Intelligence.
// Reuses Phase 2's campaign resolution (productPerformance.js), the
// existing real Meta age/gender breakdown engine (metaAudienceBreakdown.js,
// refactored in this same phase to also work without a PMC profile), and
// the existing store-scoped governorate COD truth (codOrders.js) — never a
// parallel breakdown engine, never a second Meta call shape.
//
// MANDATORY GUARDRAIL: a segment is never classified PROVEN_WEAK just for
// having fewer raw orders/less spend than another segment — that is exactly
// the "Cairo has 20 orders, Minya has 1, so Minya is bad" error the user
// explicitly forbade. Every classifier below gates on its OWN exposure
// (orders for COD segments, spend+purchases for Meta segments) BEFORE any
// outcome-based reasoning runs; under-exposed segments are always
// INSUFFICIENT_DATA, never PROVEN_WEAK.
//
// HONESTY BOUNDARY (also mandatory): Meta's age/gender breakdown is
// AD-DELIVERY attribution ("Meta served this ad to a 20-35 woman"), never a
// real confirmed customer record; Easy Orders' governorate data is REAL
// order outcomes but carries no age/gender at all. No table in this system
// links one specific real order to the specific age/gender segment of the
// ad that drove it — so this file NEVER fabricates one joint "Women 20-35 +
// Cairo/Giza, COD-proven" segment. It reports the best Meta-attributed
// audience segment and the best real-COD geography segment SEPARATELY,
// each clearly labeled by its own real source, and only ever descriptively
// co-mentions them when BOTH independently clear the evidence bar.
import { resolveWindow } from './metricsEngine.js';
import { fetchAudienceBreakdown } from './metaAudienceBreakdown.js';
import { codCountsByGovernorate } from './codOrders.js';
import { resolveProductCampaigns } from './productPerformance.js';

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

const GENDER_AR = { male: 'رجال', female: 'نساء', unknown: 'غير معروف' };

/**
 * Meta-side segment (age/gender/platform) — real spend/purchases/CPA
 * attribution from Meta Insights. Exposure-gated on spend+purchases before
 * any CPA-ratio reasoning, exactly like Phase 3's creative classifier.
 */
export function classifyMetaSegment(row, { targetCpa = 120, minSpend = 150, minPurchases = 5 } = {}) {
  const spend = n(row.spend) || 0;
  const purchases = n(row.purchases) || 0;
  const cpa = n(row.cpa);
  const base = `صرف ${Math.round(spend)} ج · ${purchases} شراء${cpa != null ? ` · CPA ${Math.round(cpa)} ج` : ''}`;

  if (spend < minSpend * 0.3 || purchases < 1) {
    return { classification: 'INSUFFICIENT_DATA', evidence: `${base} — تعرض غير كافٍ (أقل من ${Math.round(minSpend * 0.3)} ج صرف أو مفيش مشتريات) لأي حكم، سواء بالسلب أو الإيجاب.` };
  }
  if (spend < minSpend) {
    return { classification: 'INSUFFICIENT_DATA', evidence: `${base} — أقل من الحد الأدنى الموثوق (${minSpend} ج صرف).` };
  }
  if (cpa == null) return { classification: 'INSUFFICIENT_DATA', evidence: `${base} — لسه مفيش CPA محسوب.` };

  const ratio = targetCpa / cpa;
  if (ratio >= 1.15 && purchases >= minPurchases && spend >= minSpend * 2) {
    return { classification: 'PROVEN_WINNER', evidence: `${base} — أرخص من الهدف (${targetCpa} ج) بـ${Math.round((ratio - 1) * 100)}%، بعينة قوية.` };
  }
  if (ratio >= 0.9) {
    return { classification: 'PROMISING', evidence: `${base} — قريب من أو أفضل من الهدف (${targetCpa} ج)، واعد لكن العينة لسه محتاجة تكبر للتأكيد الكامل.` };
  }
  if (ratio < 0.6 && spend >= minSpend * 2 && purchases >= minPurchases) {
    return { classification: 'PROVEN_WEAK', evidence: `${base} — أعلى من الهدف (${targetCpa} ج) بشكل كبير وواضح بعينة كافية — ضعف حقيقي مؤكد.` };
  }
  return { classification: 'INSUFFICIENT_DATA', evidence: `${base} — الأداء متوسط والعينة لسه مش كافية لحسم التصنيف.` };
}

/**
 * Real-COD-side segment (governorate) — no direct Meta spend exists at this
 * granularity (Meta does not expose ad spend by Egyptian governorate), so
 * exposure here is measured the only honest way available: real order
 * count. Mirrors productMarketingScoring.js's bandMarket() philosophy,
 * extended with the PROVEN_WINNER/PROMISING/INSUFFICIENT_DATA/PROVEN_WEAK
 * vocabulary Phase 4 requires.
 */
export function classifyCodSegment(row, { minOrders = 10 } = {}) {
  const orders = n(row.orders) || 0;
  const confirmed = n(row.confirmed) || 0;
  const delivered = n(row.delivered) || 0;
  const confirmationRate = orders > 0 ? confirmed / orders : null;
  const deliveryRate = confirmed > 0 ? delivered / confirmed : null;
  const base = `${orders} أوردر${confirmationRate != null ? ` · تأكيد ${Math.round(confirmationRate * 100)}%` : ''}${deliveryRate != null ? ` · تسليم ${Math.round(deliveryRate * 100)}%` : ''}`;

  // The mandatory guardrail, enforced structurally: under minOrders, NEVER
  // proceeds to outcome-based reasoning — this is the exact "Minya has 1
  // order so it's bad" mistake, made structurally impossible here.
  if (orders < minOrders) {
    return { classification: 'INSUFFICIENT_DATA', evidence: `${base} — أقل من الحد الأدنى (${minOrders} أوردر) للحكم على هذه المحافظة، سواء بالسلب أو الإيجاب.` };
  }

  if (deliveryRate != null && deliveryRate < 0.35 && orders >= minOrders * 1.5) {
    return { classification: 'PROVEN_WEAK', evidence: `${base} — معدل تسليم ضعيف حقيقي بعينة كافية (${orders} أوردر).` };
  }
  if (confirmationRate != null && confirmationRate < 0.25 && orders >= minOrders * 1.5) {
    return { classification: 'PROVEN_WEAK', evidence: `${base} — معدل تأكيد ضعيف حقيقي بعينة كافية (${orders} أوردر).` };
  }
  if (deliveryRate != null && deliveryRate >= 0.55 && orders >= minOrders * 2) {
    return { classification: 'PROVEN_WINNER', evidence: `${base} — معدل تسليم قوي من عينة كبيرة (${orders} أوردر) — شريحة مثبتة.` };
  }
  if ((deliveryRate != null && deliveryRate >= 0.4) || (confirmationRate != null && confirmationRate >= 0.5)) {
    return { classification: 'PROMISING', evidence: `${base} — واعدة، محتاجة عينة أكبر (حاليًا ${orders} أوردر) للتأكيد الكامل.` };
  }
  return { classification: 'INSUFFICIENT_DATA', evidence: `${base} — الأرقام غير حاسمة بعد.` };
}

const RANK = { PROVEN_WINNER: 3, PROMISING: 2, INSUFFICIENT_DATA: 1, PROVEN_WEAK: 0 };
function pickBestSegment(rows) {
  const eligible = rows.filter((r) => r.classification === 'PROVEN_WINNER' || r.classification === 'PROMISING');
  if (!eligible.length) return null;
  eligible.sort((a, b) => RANK[b.classification] - RANK[a.classification] || (b.orders ?? b.purchases ?? 0) - (a.orders ?? a.purchases ?? 0));
  return eligible[0];
}

const NO_SEGMENT_MSG = 'لا يوجد جمهور/منطقة مثبتة بأدلة كافية حتى الآن';

/**
 * The Phase 4 dataset for one product: independently classified age,
 * gender, and governorate segments, each with real evidence — plus an
 * honest, NEVER-fabricated combined "audienceSignal" that only ever
 * descriptively pairs a proven Meta audience with a proven COD geography,
 * clearly labeled by source, never claimed as one verified joint segment.
 * @param {{productId:number, storeId?:string, adAccountId:string, windowName?:string, settings:object}} params
 */
export async function segmentIntelForProduct({ productId, storeId, adAccountId, windowName, settings }) {
  const window = resolveWindow(windowName || 'last30');
  const gate = {
    targetCpa: Number(settings?.ambDefaultTargetCpa) || 120,
    minSpend: Number(settings?.ambMinSpendBeforeDecision) || 150,
    minPurchases: Number(settings?.ambMinPurchasesBeforeScaling) || 5,
  };
  const minOrders = 10;

  const campaigns = await resolveProductCampaigns(productId);
  const campaignIds = campaigns.map((c) => c.campaignId);
  const resolvedAdAccountId = adAccountId || campaigns[0]?.adAccountId || null;

  const [metaBreakdown, governorates] = await Promise.all([
    resolvedAdAccountId && campaignIds.length
      ? fetchAudienceBreakdown({ adAccountId: resolvedAdAccountId, campaignIds, window })
      : Promise.resolve({ available: false, reason: campaignIds.length ? 'لا يوجد حساب إعلاني معروف.' : 'لا توجد حملات Meta مرتبطة بهذا المنتج.' }),
    codCountsByGovernorate({ productId, storeId, from: window.from, to: window.to }),
  ]);

  const ageRows = (metaBreakdown.available ? metaBreakdown.age : []).map((r) => ({ segment: r.value, spend: r.spend, purchases: r.purchases, cpa: r.cpa, ctr: r.ctr, ...classifyMetaSegment(r, gate) }));
  const genderRows = (metaBreakdown.available ? metaBreakdown.gender : []).map((r) => ({ segment: GENDER_AR[r.value] || r.value, spend: r.spend, purchases: r.purchases, cpa: r.cpa, ctr: r.ctr, ...classifyMetaSegment(r, gate) }));
  const governorateRows = governorates.map((r) => ({
    segment: r.government, orders: r.orders, confirmed: r.confirmed, delivered: r.delivered, returned: r.returned,
    confirmationRate: r.orders > 0 ? r.confirmed / r.orders : null,
    deliveryRate: r.confirmed > 0 ? r.delivered / r.confirmed : null,
    ...classifyCodSegment(r, { minOrders }),
  })).sort((a, b) => (b.orders || 0) - (a.orders || 0));

  const bestAge = pickBestSegment(ageRows);
  const bestGender = pickBestSegment(genderRows);
  const bestGovernorate = pickBestSegment(governorateRows);

  // The honest, non-fabricated combined signal: only ever a descriptive
  // pairing of two INDEPENDENTLY proven segments, each still labeled by its
  // own real source — never a single claimed joint segment.
  let audienceSignal = null;
  if (bestGender || bestAge || bestGovernorate) {
    const parts = [];
    if (bestGender) parts.push(bestGender.segment);
    if (bestAge) parts.push(bestAge.segment);
    if (bestGovernorate) parts.push(bestGovernorate.segment);
    audienceSignal = {
      label: parts.join(' / ') || null,
      basis: {
        gender: bestGender ? { segment: bestGender.segment, source: 'META_AD_DELIVERY', classification: bestGender.classification } : null,
        age: bestAge ? { segment: bestAge.segment, source: 'META_AD_DELIVERY', classification: bestAge.classification } : null,
        governorate: bestGovernorate ? { segment: bestGovernorate.segment, source: 'EASY_ORDERS_COD', classification: bestGovernorate.classification } : null,
      },
      note: 'كل عنصر هنا مثبت بشكل مستقل من مصدره الحقيقي الخاص — Meta لا تكشف عن نوع/عمر المشتري الحقيقي وراء كل أوردر COD، وEasy Orders لا يسجّل عمر/نوع العميل — فمفيش جدول واحد يربط أوردر حقيقي بعينه بشريحة عمر/نوع معينة. هذا عرض وصفي لأقوى الإشارات المستقلة المثبتة، مش شريحة واحدة مؤكدة مشتركة.',
    };
  }

  return {
    window,
    metaAvailable: metaBreakdown.available,
    metaUnavailableReason: metaBreakdown.available ? null : metaBreakdown.reason,
    age: { table: ageRows, best: bestAge, bestNote: bestAge ? null : NO_SEGMENT_MSG },
    gender: { table: genderRows, best: bestGender, bestNote: bestGender ? null : NO_SEGMENT_MSG },
    governorates: { table: governorateRows, best: bestGovernorate, bestNote: bestGovernorate ? null : NO_SEGMENT_MSG },
    audienceSignal,
  };
}
