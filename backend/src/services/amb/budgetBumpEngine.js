// Smart Decision Center — Budget Bump Engine. A NEW, precise business rule
// ("CPA < 80 -> +25% from the CURRENT budget; CPA > 100 after a bump ->
// restore the EXACT prior budget") layered on top of the EXISTING AI Media
// Buyer recommendation/execution pipeline — NOT a new publisher, NOT a new
// approval flow. A bump/rollback recommendation this file computes is
// persisted as an ordinary AmbRecommendation with action_type
// INCREASE_BUDGET/DECREASE_BUDGET (the exact same executable action types
// recommendationEngine.js's own scale logic already produces), so
// executor.js's already-built, already-tested approve/revalidate/execute/
// H6-H12-H24 pipeline runs it completely unmodified. This file only decides
// WHEN and WHAT to recommend — never writes to Meta itself.
//
// Every function here is pure (no DB, no Meta) and independently testable
// against the exact business-rule test cases in the spec: compounding +25%
// from whatever the CURRENT budget really is (never a fixed increment),
// rollback that restores the precise pre-bump value (never a generic
// -25%), evidence gates that block a recommendation from a lucky handful
// of results, and per-Ad-Set isolation (a healthy Product-level CPA never
// justifies bumping a DIFFERENT Ad Set that is itself over threshold).

export const BUMP_DEFAULTS = {
  cpaSuccessThreshold: 80, // EGP — below this, with enough evidence, propose +25%
  bumpPct: 25,
  rollbackCpaThreshold: 100, // EGP — above this post-bump, with enough evidence, propose restoring the exact prior budget
  minPurchases: 5, // "minimum results" — mirrors segmentIntel/creativeIntel's own evidence-gate convention
  minSpend: 150, // "minimum post-bump spend" — mirrors settings.ambMinSpendBeforeDecision's existing default
  minEvalHours: 6, // matches the existing H6 checkpoint convention — never judge a bump before its first real checkpoint
  maxBumpsPerDay: 1,
  cooldownHoursAfterBump: 24,
  cooldownHoursAfterRollback: 48,
  maxDailyBudget: null, // no cap unless the user configures one
};

function mergeSettings(settings) {
  return { ...BUMP_DEFAULTS, ...Object.fromEntries(Object.entries(settings || {}).filter(([, v]) => v != null)) };
}

/** Exact +25% (or configured pct) from the CURRENT budget — compounding, never a fixed increment. Rounded to 2dp (real currency precision). */
export function computeBumpedBudget(currentBudget, bumpPct = BUMP_DEFAULTS.bumpPct) {
  return Math.round(currentBudget * (1 + bumpPct / 100) * 100) / 100;
}

/**
 * Decides whether ONE ad set, evaluated entirely on its OWN metrics
 * (never a Product-level average), is eligible for a bump right now.
 * Returns {action:'BUMP', proposedBudget, ...} | {action:'WAIT'|'STABLE', reason}.
 */
export function evaluateAdSetForBump({ cpa, spend, purchases, currentBudget }, settings) {
  const cfg = mergeSettings(settings);
  if (!(currentBudget > 0)) return { action: 'WAIT', reason: 'مفيش ميزانية حالية معروفة لهذا الـ Ad Set.' };
  if (cpa == null || spend == null || purchases == null || spend < cfg.minSpend || purchases < cfg.minPurchases) {
    return { action: 'WAIT', reason: `عينة غير كافية (${purchases ?? 0} نتيجة / ${Math.round(spend || 0)} ج صرف) — الحد الأدنى (${cfg.minPurchases} نتيجة / ${cfg.minSpend} ج صرف).` };
  }
  if (cpa >= cfg.cpaSuccessThreshold) {
    return { action: 'STABLE', reason: `CPA ${cpa.toFixed(2)} ج عند أو أعلى من حد النجاح (${cfg.cpaSuccessThreshold} ج) — مفيش داعي لزيادة الآن.` };
  }
  const proposedBudget = computeBumpedBudget(currentBudget, cfg.bumpPct);
  if (cfg.maxDailyBudget != null && proposedBudget > cfg.maxDailyBudget) {
    return { action: 'STABLE', reason: `الميزانية المقترحة (${proposedBudget} ج) هتتخطى الحد الأقصى المسموح (${cfg.maxDailyBudget} ج).` };
  }
  return {
    action: 'BUMP', currentBudget, proposedBudget, pct: cfg.bumpPct,
    evidence: `CPA ${cpa.toFixed(2)} ج أقل من حد النجاح (${cfg.cpaSuccessThreshold} ج) بعينة كافية (${purchases} نتيجة، ${Math.round(spend)} ج صرف).`,
  };
}

/**
 * Decides whether a PREVIOUSLY BUMPED ad set should be rolled back, using
 * its post-bump metrics. Rollback ALWAYS restores the exact `budgetBefore`
 * of that specific bump — never a fresh -25% off the current (post-bump)
 * budget, which would not reconstruct the original value after 2+ bumps.
 */
export function evaluateAdSetForRollback({ cpa, spend, purchases, budgetBefore, budgetAfter }, settings) {
  const cfg = mergeSettings(settings);
  if (cpa == null || spend == null || purchases == null || spend < cfg.minSpend || purchases < cfg.minPurchases) {
    return { action: 'OBSERVING', reason: 'بيانات بعد الزيادة غير كافية لسه لتقييم الرجوع.' };
  }
  if (cpa > cfg.rollbackCpaThreshold) {
    return {
      action: 'ROLLBACK', currentBudget: budgetAfter, proposedBudget: budgetBefore,
      evidence: `CPA بعد الزيادة ${cpa.toFixed(2)} ج تعدّى حد الرجوع (${cfg.rollbackCpaThreshold} ج) بعينة كافية (${purchases} نتيجة، ${Math.round(spend)} ج صرف) — الرجوع بالظبط للميزانية قبل هذه الزيادة (${budgetBefore} ج).`,
    };
  }
  return { action: 'BUMP_SUCCESS', reason: `CPA ${cpa.toFixed(2)} ج لسه تحت حد الرجوع (${cfg.rollbackCpaThreshold} ج) — الزيادة الأخيرة نجحت.` };
}

/**
 * The lifecycle/hysteresis gate — decides whether the ad set is even
 * eligible to be RE-evaluated for a new bump/rollback right now, given its
 * most recent bump/rollback action (if any). This is what prevents
 * oscillation (+25% / -25% / +25% ...) from noisy short-window CPA swings:
 * a pending/approved action blocks a duplicate recommendation, an executed
 * bump enters a mandatory observation window before any rollback judgement,
 * and both bump and rollback carry their own cooldown before the NEXT bump
 * can even be considered.
 */
export function resolveAdSetLifecycleState({ latestAction, bumpsInLast24h = 0 }, settings, now = Date.now()) {
  const cfg = mergeSettings(settings);
  if (!latestAction) return { state: 'STABLE', canEvaluateBump: true, canEvaluateRollback: false };

  if (['PENDING', 'APPROVED'].includes(latestAction.status)) {
    return { state: latestAction.status === 'PENDING' ? 'BUMP_RECOMMENDED' : 'BUMP_APPROVED', canEvaluateBump: false, canEvaluateRollback: false };
  }

  const hoursSince = (now - new Date(latestAction.at).getTime()) / 3600000;

  if (latestAction.type === 'BUMP' && latestAction.status === 'EXECUTED') {
    if (hoursSince < cfg.minEvalHours) return { state: 'OBSERVING_AFTER_BUMP', canEvaluateBump: false, canEvaluateRollback: false, reason: 'لسه بدري على تقييم نتيجة الزيادة الأخيرة.' };
    return { state: 'OBSERVING_AFTER_BUMP', canEvaluateBump: hoursSince >= cfg.cooldownHoursAfterBump, canEvaluateRollback: true };
  }
  if (latestAction.type === 'ROLLBACK' && latestAction.status === 'EXECUTED') {
    if (hoursSince < cfg.cooldownHoursAfterRollback) return { state: 'COOLDOWN', canEvaluateBump: false, canEvaluateRollback: false, reason: 'فترة تهدئة بعد آخر Rollback.' };
    return { state: 'STABLE', canEvaluateBump: true, canEvaluateRollback: false };
  }
  return { state: 'STABLE', canEvaluateBump: bumpsInLast24h < cfg.maxBumpsPerDay, canEvaluateRollback: false };
}
