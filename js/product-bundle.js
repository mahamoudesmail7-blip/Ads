// product-bundle.js — thin composition helper (UI Layer glue, not a layer
// itself). Every V2 page needs the same thing: analyze a product's orders,
// then layer profit + inventory + the V2 recommendation on top. Rather than
// repeating that wiring in dashboard.js, alerts.js, ranking.js and
// product-details.js, it lives here once. None of the underlying layers
// (analytics.js, profit.js, inventory.js, recommendation-engine.js) import
// this file or each other — they stay independent and independently
// testable; this is purely UI-side orchestration.
import { analyzeProduct } from './analytics.js';
import { analyzeProductProfit } from './profit.js';
import { analyzeProductInventory } from './inventory.js';
import { buildRecommendationV2, productScore } from './recommendation-engine.js';

/**
 * @param {object} product
 * @param {object[]} records this product's daily_orders rows
 * @param {string} asOfDate
 * @param {object} settings
 */
export function buildProductBundle(product, records, asOfDate, settings) {
  const a = analyzeProduct(records, asOfDate, settings);
  const profit = analyzeProductProfit(product, a, records);
  const inventory = analyzeProductInventory(product, a, profit.profitRecent, settings);
  const v2 = buildRecommendationV2({ analysis: a, profit, inventory });
  const score = productScore({
    healthScore: a.health.score,
    profitPerOrder: profit.profitPerOrder,
    breakEvenCPA: profit.breakEvenCPA,
    returnRatePct: profit.returnRate,
  });

  return { product, a, profit, inventory, v2, score };
}
