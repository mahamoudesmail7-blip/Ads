// profit.js — Profit Layer (V2). Pure functions, no DOM/IndexedDB/analytics
// mutation — this module only ever READS an analyzeProduct() result and a
// product record, and returns numbers or null. Every function returns null
// when a required input is missing rather than silently defaulting to 0
// (spec section 13: never let missing data pollute a real calculation).
//
// Design note on "Advertising Cost": there is no live ad-spend integration
// yet (Meta Ads is future work — see README "Future Integrations").
// `product.advertising_cost` is a manually-entered CURRENT CPA snapshot the
// user keeps up to date themselves. Every function that uses it accepts an
// optional override so a future Meta Ads layer can later pass in a real,
// day-specific CPA without changing this module's public shape.

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** True once the two mandatory pricing fields are set — everything else defaults to 0 if unset. */
function hasCoreCostData(product) {
  return num(product.selling_price) !== null && num(product.product_cost) !== null;
}

/**
 * Sum of every flat per-order cost EXCEPT advertising — the spec's worked
 * example calls this "Allowed before Ads".
 */
export function costsExcludingAds(product) {
  if (!hasCoreCostData(product)) return null;
  const shipping = num(product.shipping_cost) ?? 0;
  const packaging = num(product.packaging_cost) ?? 0;
  const other = num(product.other_cost) ?? 0;
  const returnCost = num(product.expected_return_cost) ?? 0;
  const commission = num(product.commission) ?? 0;
  return num(product.product_cost) + shipping + packaging + other + returnCost + commission;
}

/**
 * Break-even CPA = Selling Price − (Product Cost + Shipping + Packaging +
 * Other Costs + Expected Return Cost + Commission). The maximum that can be
 * spent acquiring one order before that order stops being profitable.
 */
export function breakEvenCPA(product) {
  const sp = num(product.selling_price);
  const costs = costsExcludingAds(product);
  if (sp === null || costs === null) return null;
  return sp - costs;
}

/** Profit on a single order at the given (or product-stored) CPA. */
export function profitPerOrder(product, cpaOverride) {
  const be = breakEvenCPA(product);
  if (be === null) return null;
  const cpa = num(cpaOverride !== undefined ? cpaOverride : product.advertising_cost);
  if (cpa === null) return null;
  return be - cpa;
}

/** 'PROFITABLE' / 'UNPROFITABLE', or null when there isn't enough data to judge. */
export function cpaStatus(product, cpaOverride) {
  const profit = profitPerOrder(product, cpaOverride);
  if (profit === null) return null;
  return profit >= 0 ? 'PROFITABLE' : 'UNPROFITABLE';
}

export function revenue(product, ordersCount) {
  const sp = num(product.selling_price);
  if (sp === null || ordersCount === null || ordersCount === undefined) return null;
  return sp * ordersCount;
}

export function grossProfit(product, ordersCount) {
  const sp = num(product.selling_price);
  const cost = num(product.product_cost);
  if (sp === null || cost === null || ordersCount === null || ordersCount === undefined) return null;
  return (sp - cost) * ordersCount;
}

/** Net profit for a given number of orders, at the product's current CPA snapshot (or an override). */
export function netProfit(product, ordersCount, cpaOverride) {
  const perOrder = profitPerOrder(product, cpaOverride);
  if (perOrder === null || ordersCount === null || ordersCount === undefined) return null;
  return perOrder * ordersCount;
}

/**
 * Actual return rate observed in daily_orders (returned / (delivered +
 * returned)) as a percentage. Only counts days where BOTH delivered_count
 * AND returned_count were explicitly recorded — a day where either is
 * missing is excluded entirely, never treated as 0. Returns null if no
 * such day exists yet.
 */
export function actualReturnRate(records) {
  let delivered = 0;
  let returned = 0;
  let counted = 0;
  for (const r of records) {
    if (r.delivered_count === null || r.delivered_count === undefined) continue;
    if (r.returned_count === null || r.returned_count === undefined) continue;
    delivered += r.delivered_count;
    returned += r.returned_count;
    counted++;
  }
  if (counted === 0) return null;
  const total = delivered + returned;
  if (total === 0) return 0;
  return (returned / total) * 100;
}

/**
 * Full profit bundle for a product, given its `analyzeProduct()` result
 * (analytics.js) and raw daily_orders records. Every field is null when the
 * underlying data isn't there; the UI must render that as "not enough
 * data", never as 0 or a fabricated chart point (spec section 12/13).
 */
export function analyzeProductProfit(product, analysis, records) {
  const be = breakEvenCPA(product);
  const perOrder = profitPerOrder(product);
  const status = cpaStatus(product);
  const returnRate = actualReturnRate(records);

  // avg * observed-data-point-count reconstructs the TRUE sum of only the
  // days that actually have data — deliberately not avg*7, which would
  // silently assume 7 full days even when some were missing.
  const recentOrders = analysis.avg7 !== null ? analysis.avg7 * analysis.dataPoints7 : null;

  return {
    breakEvenCPA: be,
    currentCPA: num(product.advertising_cost),
    profitPerOrder: perOrder,
    cpaStatus: status,
    returnRate,
    revenueToday: revenue(product, analysis.today),
    profitToday: netProfit(product, analysis.today),
    revenueRecent: recentOrders !== null ? revenue(product, recentOrders) : null,
    profitRecent: recentOrders !== null ? netProfit(product, recentOrders) : null,
    revenueTotal: revenue(product, analysis.totalOrders),
    profitTotal: netProfit(product, analysis.totalOrders),
    hasFinancialData: be !== null,
  };
}
