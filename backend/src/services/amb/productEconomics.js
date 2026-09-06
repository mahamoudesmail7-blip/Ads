// AI Media Buyer — Product Economics Engine. PURE, DETERMINISTIC functions.
// Claude never runs any of this; it only ever receives the outputs. Every
// function returns null (never a misleading 0) when a required input is
// missing — the UI must render that as "not enough data".
//
// Operates on an AmbProduct record (see prisma schema `amb_products`). Field
// semantics: product_cost = wholesale/COGS per unit; pricing_multiplier is
// per-product (never a global constant); actual_selling_price, when set,
// overrides the suggested price everywhere downstream; confirmation_rate /
// delivery_rate are 0..1 shares from the CRM when available.

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function n0(v) {
  return num(v) ?? 0;
}

/** product_cost × pricing_multiplier — the SUGGESTED price. */
export function suggestedSellingPrice(p) {
  const cost = num(p.product_cost);
  const mult = num(p.pricing_multiplier);
  if (cost === null || mult === null) return null;
  return cost * mult;
}

/** The price actually used for every downstream calc: manual override wins, else the stored suggested, else recomputed suggested. */
export function effectiveSellingPrice(p) {
  const actual = num(p.actual_selling_price);
  if (actual !== null && actual > 0) return actual;
  const stored = num(p.suggested_selling_price);
  if (stored !== null && stored > 0) return stored;
  return suggestedSellingPrice(p);
}

/** product_cost + packaging + shipping + other — the flat per-order cost before ads AND before RTO. */
export function baseOperationalCost(p) {
  if (num(p.product_cost) === null) return null;
  return n0(p.product_cost) + n0(p.packaging_cost) + n0(p.shipping_cost) + n0(p.other_cost);
}

/** Selling Price − Base Operational Cost (spec's "Gross Profit Before Ads"). */
export function grossProfitBeforeAds(p) {
  const sp = effectiveSellingPrice(p);
  const base = baseOperationalCost(p);
  if (sp === null || base === null) return null;
  return sp - base;
}

/**
 * Basic Break-even CPA = Selling Price − (Product Cost + Packaging +
 * Shipping + Other). The most that can be paid to acquire ONE order before
 * that order stops being profitable — ignoring COD confirmation/delivery
 * leakage (that's codBreakEvenCpa below).
 */
export function breakEvenCpa(p) {
  const sp = effectiveSellingPrice(p);
  if (sp === null) return null;
  const costs = n0(p.product_cost) + n0(p.packaging_cost) + n0(p.shipping_cost) + n0(p.other_cost);
  return sp - costs;
}

/**
 * COD-adjusted Break-even CPA — the real ceiling for a Meta PURCHASE event,
 * because not every Meta purchase becomes a delivered order. Given
 * confirmation_rate (c) and delivery_rate (d):
 *   delivered share of a Meta purchase   = c · d
 *   confirmed-but-returned (RTO) share    = c · (1 − d)
 *   expected contribution per Meta purchase
 *       = (c·d) · grossProfitBeforeAds − (c·(1−d)) · rto_cost
 * That expected contribution IS the max spend per Meta purchase before the
 * unit economics go negative. Returns null unless BOTH rates are present.
 */
export function codBreakEvenCpa(p) {
  const c = num(p.confirmation_rate);
  const d = num(p.delivery_rate);
  const gp = grossProfitBeforeAds(p);
  if (c === null || d === null || gp === null) return null;
  const deliveredShare = c * d;
  const rtoShare = c * (1 - d);
  return deliveredShare * gp - rtoShare * n0(p.rto_cost);
}

/** Meta CPA / Confirmed CPA / Delivered CPA from a spend + the three COD conversion counts. Each is null when its denominator is 0/absent. */
export function cpaTriplet({ spend, metaPurchases, confirmedOrders, deliveredOrders }) {
  const s = num(spend);
  return {
    metaCpa: s !== null && num(metaPurchases) ? s / metaPurchases : null,
    confirmedCpa: s !== null && num(confirmedOrders) ? s / confirmedOrders : null,
    deliveredCpa: s !== null && num(deliveredOrders) ? s / deliveredOrders : null,
  };
}

/**
 * Real Net Profit bundle when enough data is available. deliveredOrders
 * drive revenue + COGS/packaging/shipping/other; returnedOrders drive
 * rto_cost. adSpend is the real spend for the window. Every component is
 * returned so the UI can show the full P&L breakdown, not just the total.
 * netProfit/netMargin are null when the selling price or delivered count
 * is unknown.
 */
export function netProfitBundle(p, { adSpend, deliveredOrders, returnedOrders, actualRevenue }) {
  const sp = effectiveSellingPrice(p);
  const delivered = num(deliveredOrders);
  const returned = num(returnedOrders) ?? 0;
  const spend = n0(adSpend);
  if (sp === null || delivered === null) {
    return { revenue: null, adSpend: spend, cogs: null, shipping: null, packaging: null, rtoCost: null, otherCost: null, netProfit: null, netMarginPct: null };
  }
  const revenue = num(actualRevenue) ?? sp * delivered;
  const cogs = n0(p.product_cost) * delivered;
  const packaging = n0(p.packaging_cost) * delivered;
  const shipping = n0(p.shipping_cost) * delivered;
  const otherCost = n0(p.other_cost) * delivered;
  const rtoCost = n0(p.rto_cost) * returned;
  const netProfit = revenue - (cogs + packaging + shipping + otherCost + rtoCost + spend);
  const netMarginPct = revenue > 0 ? (netProfit / revenue) * 100 : null;
  return { revenue, adSpend: spend, cogs, shipping, packaging, rtoCost, otherCost, netProfit, netMarginPct };
}

/** One flat object with every headline economics figure for a product — what the Products section and the rule engine both read. */
export function economicsSummary(p) {
  return {
    currency: p.currency || 'EGP',
    productCost: num(p.product_cost),
    pricingMultiplier: num(p.pricing_multiplier),
    suggestedSellingPrice: suggestedSellingPrice(p),
    effectiveSellingPrice: effectiveSellingPrice(p),
    actualSellingPrice: num(p.actual_selling_price),
    baseOperationalCost: baseOperationalCost(p),
    grossProfitBeforeAds: grossProfitBeforeAds(p),
    breakEvenCpa: breakEvenCpa(p),
    codBreakEvenCpa: codBreakEvenCpa(p),
    targetCpa: num(p.target_cpa),
    warningCpa: num(p.warning_cpa),
    maxCpa: num(p.max_cpa),
    targetProfit: num(p.target_profit),
    minProfit: num(p.min_profit),
    confirmationRate: num(p.confirmation_rate),
    deliveryRate: num(p.delivery_rate),
  };
}
