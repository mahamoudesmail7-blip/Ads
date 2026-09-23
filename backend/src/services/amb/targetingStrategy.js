// AI Media Buyer — Targeting Strategy (Product Growth & Profit
// Intelligence, Phase 3 Slice 5). A pure presentation/composition layer —
// every number here is already computed by segmentIntel.js
// (topObserved/best) and reconciled via productActionPlan.js's own
// reconcileStackStatus(); never a new evidence threshold. Splits the
// existing Winning Stack into the THREE views the spec asks for:
//   1. الأعلى حاليًا (Currently Leading) — segmentIntel's topObserved, the
//      real current leader by raw purchases, however early — NEVER used
//      for Scale targeting on its own (that would silently promote an
//      Early Signal), only ever shown as "what's leading right now".
//   2. Scale Targeting — ONLY the strictest tier (PROVEN, via
//      reconcileStackStatus) may restrict Scale targeting. Broad (Meta's
//      own default) whenever nothing clears that bar — restriction is
//      never the default, only an evidence-earned option.
//   3. Test Targeting — PROMISING/EARLY_SIGNAL picks worth testing next,
//      never silently promoted into a Scale decision.
import { reconcileStackStatus } from './productActionPlan.js';

const DIM_FIELD = { gender: 'gender', age: 'age', governorate: 'governorates' };

export function buildTargetingStrategy({ pkg }) {
  const currentlyLeading = {};
  const scaleTargeting = {};
  const testTargeting = {};

  for (const [dim, segmentField] of Object.entries(DIM_FIELD)) {
    const dimData = pkg?.segmentIntel?.[segmentField];
    const topObserved = dimData?.topObserved || null;
    currentlyLeading[dim] = topObserved
      ? { segment: topObserved.segment, count: topObserved.count ?? null, signalStrength: topObserved.signalStrength, winnerStatus: topObserved.winnerStatus }
      : { segment: null, status: 'NO_DATA' };

    const winner = pkg?.winners?.[dim];
    if (winner) {
      const status = reconcileStackStatus(winner.classification, winner.signalStrength);
      const entry = { segment: winner.segment, status, evidence: winner.evidence };
      if (status === 'PROVEN') scaleTargeting[dim] = entry;
      else if (status === 'PROMISING' || status === 'EARLY_SIGNAL') testTargeting[dim] = entry;
    }
  }

  const hasScaleRestriction = Object.keys(scaleTargeting).length > 0;
  return {
    currentlyLeading,
    scaleTargeting: hasScaleRestriction
      ? scaleTargeting
      : { mode: 'BROAD', reason: 'مفيش دليل قوي كفاية (PROVEN) يبرر تقييد الاستهداف حاليًا — الأفضل تسيبه Broad (وضع Meta الافتراضي) لحد ما تتوفر أدلة أقوى.' },
    testTargeting,
  };
}
