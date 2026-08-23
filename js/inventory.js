// inventory.js — Inventory Layer (V2). Pure functions, no DOM/IndexedDB.
// A product with no stock fields set simply produces null/'NO_DATA'
// everywhere — it is never assumed to be out of stock or in stock.

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * Daily average sales used for stock projections: prefers the 7D baseline
 * (most responsive to recent reality), falling back to longer windows only
 * when 7D has no data at all — never fabricates an average from nothing.
 */
export function dailyAverageSales(analysis) {
  if (analysis.avg7 !== null) return analysis.avg7;
  if (analysis.avg14 !== null) return analysis.avg14;
  if (analysis.avg30 !== null) return analysis.avg30;
  if (analysis.avgAllTime !== null) return analysis.avgAllTime;
  return null;
}

export function daysOfStockRemaining(currentStock, dailyAvg) {
  const stock = num(currentStock);
  if (stock === null || dailyAvg === null || dailyAvg <= 0) return null;
  return stock / dailyAvg;
}

/**
 * 'CRITICAL' <= criticalStockDays <= 'LOW' <= lowStockDays < 'OK'.
 * 'NO_DATA' when stock isn't tracked for this product at all (spec
 * section 13: absence of tracking is not the same as zero stock).
 */
export function stockStatus(daysRemaining, settings) {
  if (daysRemaining === null) return 'NO_DATA';
  if (daysRemaining <= settings.criticalStockDays) return 'CRITICAL';
  if (daysRemaining <= settings.lowStockDays) return 'LOW';
  return 'OK';
}

/**
 * Restock priority score (higher = more urgent to reorder), only computed
 * for products that are actually LOW or CRITICAL. Combines: how urgent the
 * stock-out is, how profitable the product is, whether it's trending up,
 * and its overall health — a low-stock product that's also a strong
 * performer should jump the queue ahead of a low-stock product nobody
 * wants anymore.
 */
export function restockPriorityScore({ status, profitRecent, trendCode, healthScore }) {
  if (status !== 'LOW' && status !== 'CRITICAL') return null;
  let score = status === 'CRITICAL' ? 50 : 25;
  if (profitRecent !== null && profitRecent > 0) score += Math.min(30, profitRecent / 50);
  if (trendCode === 'STRONG_UP') score += 20;
  else if (trendCode === 'STABLE') score += 8;
  if (healthScore !== null) score += healthScore * 0.15;
  return Math.round(score);
}

/**
 * Full inventory bundle for a product, given its `analyzeProduct()` result
 * (analytics.js), an optional `profitRecent` figure (profit.js), and
 * Settings thresholds.
 */
export function analyzeProductInventory(product, analysis, profitRecent, settings) {
  const avgSales = dailyAverageSales(analysis);
  const daysRemaining = daysOfStockRemaining(product.current_stock, avgSales);
  const status = stockStatus(daysRemaining, settings);
  const priorityScore = restockPriorityScore({
    status,
    profitRecent: profitRecent ?? null,
    trendCode: analysis.trend.code,
    healthScore: analysis.health.score,
  });

  return {
    currentStock: num(product.current_stock),
    minimumStock: num(product.minimum_stock),
    dailyAverageSales: avgSales,
    daysRemaining,
    status,
    priorityScore,
    supplier: product.supplier || null,
    restockQuantity: num(product.restock_quantity),
    lastRestockDate: product.last_restock_date || null,
    hasStockData: num(product.current_stock) !== null,
  };
}
