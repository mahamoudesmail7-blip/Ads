// Product-first decision engine — AI Intelligence Phase 2, spec sections
// 7-19. Classifies each entity (product or standalone campaign, from
// productAnalysis.js) into SCALE / OPTIMIZE / STOP / COLLECT_MORE_DATA using
// configurable EGP-CPA thresholds, never on insufficient data (explicit user
// rule: one order at 50 EGP is never a SCALE signal). Every classification
// carries WHY it was made — for a product whose overall CPA is bad, this
// drills into its campaign breakdown before recommending a full stop, so a
// strong campaign inside a weak product is protected rather than killed
// alongside it (spec's worked example, section 7/19 scenario A).
//
// Everything here is deterministic and pure — no AI call. This IS the
// structured input the AI agent (aiActionPlan.js) is handed; it never
// invents a classification or a number, only writes the natural-language
// reason/action text on top of what's computed here.

export const DEFAULT_THRESHOLDS = {
  aiScaleCpaThreshold: 100,
  aiOptimizeCpaThreshold: 130,
  aiMinSpendForDecision: 150,
  aiMinOrdersForDecision: 2,
};

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/** Classifies one entity, drilling into its campaign breakdown when a product's overall CPA is in the danger zone (spec §7). */
function classifyOne(entity, thresholds) {
  const { aiScaleCpaThreshold: scaleT, aiOptimizeCpaThreshold: optT, aiMinSpendForDecision: minSpend, aiMinOrdersForDecision: minOrders } = thresholds;
  const { spend, results, cpa } = entity;

  if (spend >= minSpend && (results || 0) === 0) {
    return {
      classification: 'STOP',
      severity: 'CRITICAL',
      problem: 'صرف بدون أي نتيجة واحدة',
      reasonFacts: { spend, results: 0 },
      drillDown: null,
    };
  }

  if (spend < minSpend || (results || 0) < minOrders) {
    return {
      classification: 'COLLECT_MORE_DATA',
      severity: 'INFO',
      problem: null,
      reasonFacts: { spend, results, cpa, minSpend, minOrders },
      drillDown: null,
      promising: cpa !== null && cpa <= scaleT,
    };
  }

  if (cpa < scaleT) {
    return { classification: 'SCALE', severity: 'INFO', problem: null, reasonFacts: { cpa, scaleT, spend, results }, drillDown: null };
  }

  if (cpa <= optT) {
    return { classification: 'OPTIMIZE', severity: 'WARNING', problem: 'الأداء داخل نطاق التحسين', reasonFacts: { cpa, scaleT, optT }, drillDown: null };
  }

  // cpa > optT — the danger zone. For a product with a campaign breakdown,
  // never blanket-stop it if at least one campaign inside is still healthy.
  if (entity.entityType === 'product' && entity.campaigns && entity.campaigns.length > 0) {
    const strong = entity.campaigns.filter((c) => c.spend >= minSpend && c.cpa !== null && c.cpa <= optT);
    if (strong.length > 0) {
      const weak = entity.campaigns.filter((c) => !strong.includes(c));
      return {
        classification: 'OPTIMIZE',
        severity: 'WARNING',
        problem: 'المتوسط العام ضعيف بس فيه حملات جوه المنتج شغالة كويس',
        reasonFacts: { cpa, optT },
        drillDown: { protect: strong, reduce: weak },
      };
    }
  }

  return {
    classification: 'STOP',
    severity: 'CRITICAL',
    problem: 'كل الأداء النشط فوق الحد المسموح',
    reasonFacts: { cpa, optT, spend },
    drillDown: null,
  };
}

function priorityScore(entity, decision, maxSpend, thresholds) {
  const normSpend = maxSpend > 0 ? clamp01(entity.spend / maxSpend) : 0;
  const { aiScaleCpaThreshold: scaleT, aiOptimizeCpaThreshold: optT } = thresholds;

  if (decision.classification === 'STOP') {
    if (decision.severity === 'CRITICAL' && (entity.results || 0) === 0) return 1; // zero-result money burn always ranks first
    const dist = entity.cpa ? clamp01((entity.cpa - optT) / optT) : 0.5;
    return dist * 0.6 + normSpend * 0.4;
  }
  if (decision.classification === 'SCALE') {
    const dist = entity.cpa !== null ? clamp01((scaleT - entity.cpa) / scaleT) : 0;
    const normResults = clamp01((entity.results || 0) / 20);
    return dist * 0.5 + normSpend * 0.3 + normResults * 0.2;
  }
  if (decision.classification === 'OPTIMIZE') {
    return normSpend * 0.6 + (decision.drillDown ? 0.4 : 0.2);
  }
  if (decision.classification === 'COLLECT_MORE_DATA') {
    return decision.promising ? 0.5 : 0.2;
  }
  return 0;
}

function priorityLabel(score) {
  if (score >= 0.66) return 'HIGH';
  if (score >= 0.33) return 'MEDIUM';
  return 'LOW';
}

/**
 * Classifies and prioritizes every entity, plus tags the "hidden opportunity"
 * subset (spec §18): a SCALE-classified entity whose spend is still below
 * the median spend of all SCALE entities — strong efficiency, room to grow.
 * Returns {entities: [...], buckets: {scale, optimize, stop, collectMoreData, opportunities}}
 * where each entity in the returned arrays carries classification, priority,
 * confidence, and (for products in the danger zone) a drillDown showing
 * which internal campaign to protect vs. reduce.
 */
export function classifyEntities(rawEntities, thresholds = DEFAULT_THRESHOLDS) {
  const maxSpend = Math.max(0, ...rawEntities.map((e) => e.spend || 0));
  const classified = rawEntities.map((entity) => {
    const decision = classifyOne(entity, thresholds);
    const score = priorityScore(entity, decision, maxSpend, thresholds);
    return {
      ...entity,
      classification: decision.classification,
      severity: decision.severity,
      problem: decision.problem,
      reasonFacts: decision.reasonFacts,
      drillDown: decision.drillDown,
      promising: decision.promising || false,
      priorityScore: score,
      priority: priorityLabel(score),
      confidence: entity.spend >= thresholds.aiMinSpendForDecision * 2 && (entity.results || 0) >= thresholds.aiMinOrdersForDecision * 2 ? 'HIGH' : entity.spend >= thresholds.aiMinSpendForDecision ? 'MEDIUM' : 'LOW',
    };
  });

  const scaleEntities = classified.filter((e) => e.classification === 'SCALE');
  const scaleSpends = scaleEntities.map((e) => e.spend).sort((a, b) => a - b);
  const medianScaleSpend = scaleSpends.length > 0 ? scaleSpends[Math.floor(scaleSpends.length / 2)] : 0;

  const opportunities = scaleEntities
    .filter((e) => e.spend < medianScaleSpend)
    .map((e) => ({ ...e, opportunityReason: `كفاءة عالية (CPA ${e.cpa.toFixed(1)} جنيه) بصرف لسه أقل من نص الحملات الناجحة التانية` }));

  const sortDesc = (a, b) => b.priorityScore - a.priorityScore;
  const buckets = {
    scale: scaleEntities.sort(sortDesc),
    optimize: classified.filter((e) => e.classification === 'OPTIMIZE').sort(sortDesc),
    stop: classified.filter((e) => e.classification === 'STOP').sort(sortDesc),
    collectMoreData: classified.filter((e) => e.classification === 'COLLECT_MORE_DATA').sort(sortDesc),
    opportunities: opportunities.sort(sortDesc),
  };

  return { entities: classified, buckets };
}
