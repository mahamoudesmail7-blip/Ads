// AI Media Buyer — COD Quality Brain (Product Growth & Profit Intelligence,
// Phase 3 Slice 9). A pure composition layer over codOrders.js's real
// counts and segmentIntel.js's already-evidence-classified governorate
// rows — never a new COD data source, never a new classification
// threshold. The one real, worth-fixing gap this closes: the EXISTING
// get_amb_governorate_breakdown tool sorts governorates by raw order count
// (`rows.sort((a,b) => b.orders - a.orders)`), which is exactly what the
// spec explicitly forbids ("never rank governorates only by raw Orders").
// This tool instead reuses segmentIntel's classification-first ordering
// (PROVEN_WINNER > PROMISING > INSUFFICIENT_DATA > PROVEN_WEAK, real orders
// only as a tiebreaker) — the SAME evidence gate Targeting Strategy (Slice
// 5) and the Winning Stack already trust.
import { codCountsForProduct } from './codOrders.js';

function rate(numerator, denominator) {
  if (!denominator) return null;
  return numerator / denominator;
}

const GOV_RANK = { PROVEN_WINNER: 3, PROMISING: 2, INSUFFICIENT_DATA: 1, PROVEN_WEAK: 0 };

/**
 * @param {{productId:number, storeId?:string, from?:string, to?:string, pkg:object}} params
 *   `pkg` = an already-built buildProductDecisionPackage() result — its
 *   `segmentIntel.governorates.table` is reused as-is for the per-geo view.
 */
export async function buildCodQualityReport({ productId, storeId, from, to, pkg }) {
  const counts = await codCountsForProduct({ productId, storeId, from, to });
  const orders = counts.orders ?? 0;
  const confirmed = counts.confirmed ?? 0;
  const delivered = counts.delivered ?? 0;
  const returned = counts.returned ?? 0;
  const cancelled = counts.cancelled ?? 0;
  const pending = Math.max(0, orders - confirmed - cancelled); // real remainder — never a guessed count

  const productLevel = {
    source: counts.source,
    orders, pending, confirmed, cancelled, delivered, returned,
    confirmationRate: rate(confirmed, orders),
    cancellationRate: rate(cancelled, orders),
    deliveryRate: rate(delivered, confirmed),
    returnRate: rate(returned, confirmed),
    revenue: counts.revenue ?? null,
    deliveredRevenue: counts.deliveredRevenue ?? null,
  };

  const governorateRows = (pkg?.segmentIntel?.governorates?.table || [])
    .map((r) => ({
      governorate: r.segment, orders: r.orders ?? null, confirmed: r.confirmed ?? null, delivered: r.delivered ?? null, returned: r.returned ?? null,
      confirmationRate: r.confirmationRate ?? null, deliveryRate: r.deliveryRate ?? null,
      classification: r.classification, signalStrength: r.signalStrength, evidence: r.evidence,
    }))
    .sort((a, b) => (GOV_RANK[b.classification] ?? -1) - (GOV_RANK[a.classification] ?? -1) || (b.orders || 0) - (a.orders || 0));

  // The exact "Meta CPA strong but COD quality poor -> don't blindly Scale" check the spec asks for — reuses the SAME bottleneck category the Growth Strategist/prepare_scale's SCALE_CANDIDATE gate already relies on, never a second threshold.
  const bottleneckCategory = pkg?.diagnosis?.bottleneck?.category;
  const codBlocksScale = bottleneckCategory === 'CONFIRMATION_PROBLEM' || bottleneckCategory === 'DELIVERY_PROBLEM';
  // Mirrors productMarketingScoring.js's own codSample>=20 gate before CONFIRMATION_PROBLEM can even fire — below that, the bottleneck engine stays honestly silent on COD rather than clearing it, so this must too (never read silence as "COD is fine").
  const sampleSufficient = orders >= 20;
  const decisionNote = codBlocksScale
    ? `⚠️ جودة الـCOD هي العنق الحقيقي حاليًا (${bottleneckCategory === 'CONFIRMATION_PROBLEM' ? 'التأكيد' : 'التسليم'}) — مينفعش تعتمد على CPA كويس بس عشان تكبّر، المشكلة قبل ما توصل لمرحلة الصرف الإعلاني.`
    : !sampleSufficient
      ? `❔ عدد الأوردرات (${orders}) لسه قليل جدًا للحكم على جودة الـCOD بثقة — لسه من المبكر التأكيد إنها مش مشكلة.`
      : pkg?.decision === 'SCALE_CANDIDATE'
        ? '✅ جودة الـCOD مش هي العنق الحالي — مفيش مؤشر إنها بتمنع التوسع.'
        : null;

  return { productLevel, governorateRows, codBlocksScale, decisionNote };
}
