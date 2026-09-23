// AI Media Buyer — Product Playbook (Product Growth & Profit Intelligence,
// Phase 3 Slice 10). A pure READ composition — never a new persistence
// layer. "What has this product taught us over time" already has a real,
// durable home: productLearning.js's getProductLearningMemory() (PROVEN/
// PROMISING/REJECTED/STALE per dimension+key, fed by BOTH Smart Decision
// Center's automatic H24 evaluator AND PMC's manual Testing Lab — see
// testingBrain.js's own header for the same reasoning). This file adds two
// things on top, both reused from existing queries, never new ones:
//   - "Best of" per dimension — the highest-sample WORKS verdict per
//     dimension, answering "أنهي Angle كان أنجح؟"/"مين أفضل جمهور
//     تاريخيًا؟" directly instead of making the caller scan the raw list.
//   - Decision history — the same AmbRecommendation query productDossier.js
//     already runs (level:'product', last 20, ordered by created_at desc)
//     — this doubles as "scale/test/recovery history" since every
//     SCALE_CANDIDATE/NEW_CREATIVE_TEST/PAUSE_CANDIDATE/etc. decision this
//     product ever received is already one row here.
// Profit/COD are a CURRENT snapshot only (no historical trend table exists
// for either yet) — always labeled as such, never presented as a trend.
import { prisma } from '../../prisma.js';
import { getProductLearningMemory } from './productLearning.js';

const DIMENSION_LABEL_AR = { CREATIVE: 'الكرياتيف', HOOK: 'الـHook', ANGLE: 'الزاوية', AUDIENCE: 'الجمهور', MARKET: 'المحافظة', OFFER: 'العرض' };

export async function buildProductPlaybook({ productId, ambProductId, profitBrain, codReport }) {
  const learning = await getProductLearningMemory({ productId });

  const bestByDimension = {};
  for (const entry of learning.entries) {
    if (entry.state !== 'PROVEN' && entry.state !== 'PROMISING') continue;
    const current = bestByDimension[entry.dimension];
    if (!current || (entry.sampleSize || 0) > (current.sampleSize || 0)) {
      bestByDimension[entry.dimension] = { dimension: entry.dimension, dimensionLabel: DIMENSION_LABEL_AR[entry.dimension] || entry.dimension, key: entry.key, state: entry.state, sampleSize: entry.sampleSize, lastVerified: entry.computedAt, evidence: entry.evidence };
    }
  }

  const decisionHistory = ambProductId
    ? await prisma.ambRecommendation.findMany({
        where: { level: 'product', amb_product_id: ambProductId },
        orderBy: { created_at: 'desc' }, take: 20,
        select: { id: true, decision: true, confidence: true, status: true, created_at: true, reviewed_at: true },
      })
    : [];

  return {
    hasLearningProfile: learning.hasProfile,
    learnedEntries: learning.entries, // full chronology-respecting list — nothing deleted, staleness only ever relabeled, never erased
    bestByDimension,
    decisionHistory,
    currentProfitProfile: profitBrain ? { state: profitBrain.state, marginPct: profitBrain.marginPct, configState: profitBrain.configState, note: 'لقطة حالية — مش اتجاه تاريخي، مفيش جدول تتبّع ربح عبر الوقت لسه.' } : null,
    currentCodProfile: codReport ? { ...codReport.productLevel, note: 'لقطة حالية لفترة الاستعلام — مش اتجاه تاريخي كامل.' } : null,
  };
}
