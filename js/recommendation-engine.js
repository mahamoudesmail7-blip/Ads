// recommendation-engine.js — Centralized Recommendation Engine (V2, spec
// section 19-20). This is a wrapper/enrichment layer, not a replacement:
// analytics.js's `analyzeProduct()` and its KEEP/WATCH/SCALE/EXIT verdict
// (the exact logic covered by the 33 existing business-logic tests) is left
// completely untouched. This module takes that verdict plus profit.js and
// inventory.js signals and produces the wider V2 vocabulary —
// SCALE / WATCH / FIX / EXIT / RESTOCK / NORMAL / NEW — by cross-checking
// multiple metrics against each other (rule: never decide from one metric
// alone), always with a human-readable `reasons` list.

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function scoreFromMargin(profitPerOrder, breakEvenCPA) {
  if (profitPerOrder === null || breakEvenCPA === null || breakEvenCPA === 0) return null;
  const marginPct = (profitPerOrder / Math.abs(breakEvenCPA)) * 100;
  return clamp(50 + marginPct * 0.5, 0, 100);
}

function scoreFromReturnRate(pct) {
  if (pct === null) return null;
  return clamp(100 - pct * 4, 0, 100);
}

/**
 * Product Score (0-100, spec section 6): blends Health Score, profit
 * margin vs. break-even, and observed return rate. Any component whose
 * underlying data is missing is dropped entirely and the remaining
 * weights are renormalized — a product is never penalized (or credited)
 * for data it doesn't have yet.
 *   45% Health Score (already blends trend/baseline/streaks/zero-days)
 *   35% Profitability (profit-per-order relative to break-even CPA)
 *   20% Observed return rate
 */
export function productScore({ healthScore, profitPerOrder, breakEvenCPA, returnRatePct }) {
  const parts = [];
  if (healthScore !== null && healthScore !== undefined) parts.push({ w: 45, s: healthScore });
  const marginScore = scoreFromMargin(profitPerOrder, breakEvenCPA);
  if (marginScore !== null) parts.push({ w: 35, s: marginScore });
  const returnScore = scoreFromReturnRate(returnRatePct);
  if (returnScore !== null) parts.push({ w: 20, s: returnScore });

  if (parts.length === 0) return null;

  const totalW = parts.reduce((s, p) => s + p.w, 0);
  const raw = parts.reduce((s, p) => s + p.w * p.s, 0) / totalW;
  const score = clamp(Math.round(raw), 0, 100);

  let label;
  if (score >= 80) label = '🔥 Excellent';
  else if (score >= 60) label = 'Good';
  else if (score >= 40) label = 'Watch';
  else if (score >= 20) label = 'Danger';
  else label = 'Exit Candidate';

  return { score, label, componentsUsed: parts.length };
}

/**
 * @param {{analysis: object, profit: object|null, inventory: object|null}} bundle
 *   `analysis` is an analyzeProduct() result (required). `profit` is an
 *   analyzeProductProfit() result or null if the product has no cost data
 *   yet. `inventory` is an analyzeProductInventory() result or null.
 * @returns {{type: 'NEW'|'SCALE'|'WATCH'|'FIX'|'EXIT'|'RESTOCK'|'NORMAL', reasons: string[], coreType: string}}
 */
export function buildRecommendationV2({ analysis, profit, inventory }) {
  const core = analysis.recommendation;
  const reasons = [...core.reasons];

  if (core.type === 'NEW') {
    return { type: 'NEW', reasons, coreType: 'NEW' };
  }

  let type = core.type;

  const hasProfit = profit && profit.profitPerOrder !== null;
  const losing = hasProfit && profit.profitPerOrder < 0;
  const profitable = hasProfit && profit.profitPerOrder >= 0;

  // A rising-orders product that's losing money per order needs its
  // economics fixed before spend increases, not a Scale signal.
  if (type === 'SCALE' && losing) {
    type = 'FIX';
    reasons.push(`Losing ${Math.abs(Math.round(profit.profitPerOrder))} per order at current CPA — fix profitability before scaling spend`);
  } else if (type === 'SCALE' && hasProfit) {
    reasons.push(`Profitable: +${Math.round(profit.profitPerOrder)} per order`);
  }

  // A product that looks fine order-wise but is quietly losing money on
  // every sale still needs action — surface it as FIX rather than NORMAL/WATCH.
  if ((type === 'KEEP' || type === 'WATCH') && losing) {
    type = 'FIX';
    reasons.push(`Currently unprofitable: ${Math.round(profit.profitPerOrder)} per order at current CPA`);
  }

  // A declining product that is STILL clearly profitable and not critically
  // unhealthy is a candidate for a fix, not an exit — orders alone never
  // justify EXIT (rule 20).
  if (type === 'EXIT') {
    if (profitable && analysis.health.score >= 35) {
      type = 'FIX';
      reasons.push('Still profitable despite the decline — review before exiting');
    } else if (hasProfit) {
      reasons.push(losing ? 'Profit: Negative' : `Profit: +${Math.round(profit.profitPerOrder)}/order`);
    }
  }

  if (type === 'KEEP') type = 'NORMAL';

  // Stock is an orthogonal concern to performance, but a CRITICAL stock-out
  // on an otherwise-healthy product is today's most urgent action — it
  // takes over the headline label. EXIT/FIX already demand attention on
  // their own, so they keep priority over a restock nudge.
  if (inventory && inventory.status === 'CRITICAL' && (type === 'NORMAL' || type === 'WATCH')) {
    reasons.push(`Only ${inventory.daysRemaining.toFixed(1)} days of stock left`);
    type = 'RESTOCK';
  }

  return { type, reasons, coreType: core.type };
}
