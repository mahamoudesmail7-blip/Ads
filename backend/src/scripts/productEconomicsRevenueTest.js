// Regression test for Block A's real-revenue fix: netProfitBundle() used to
// ALWAYS estimate revenue as `effectiveSellingPrice(p) * deliveredOrders`
// because productDashboard() never passed real actualRevenue at all — even
// though real per-order revenue (order_cost) was already being computed
// elsewhere (customerQuality.js/codOrders.js). Fixed by having
// codCountsForProduct() return real deliveredRevenue and productDashboard()
// pass it through as actualRevenue. This test locks in netProfitBundle()'s
// contract: real revenue when available, an explicitly-labeled estimate
// only when it truly isn't, and NEVER a silent -adSpend from a missing-
// revenue bug.
//   node src/scripts/productEconomicsRevenueTest.js
import { netProfitBundle } from '../services/amb/productEconomics.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const product = { product_cost: 50, packaging_cost: 5, shipping_cost: 20, other_cost: 0, rto_cost: 30, actual_selling_price: 300, pricing_multiplier: 3, suggested_selling_price: 0 };

console.log('§1 real revenue is used verbatim when the caller provides it, never overridden by the price×count estimate:');
{
  const bundle = netProfitBundle(product, { adSpend: 500, deliveredOrders: 10, returnedOrders: 1, actualRevenue: 2450 }); // real summed order_cost, NOT 300*10=3000
  ok('revenue is the real 2450, not the estimated 3000', bundle.revenue === 2450, String(bundle.revenue));
  ok('revenueSource is "real"', bundle.revenueSource === 'real', bundle.revenueSource);
  ok('netProfit is computed off the REAL revenue: 2450 - (cogs 500 + packaging 50 + shipping 200 + rto 30 + spend 500) = 1170', bundle.netProfit === 1170, String(bundle.netProfit));
}

console.log('\n§2 falls back to the price×count estimate ONLY when real revenue is genuinely unavailable, and says so explicitly:');
{
  const bundle = netProfitBundle(product, { adSpend: 500, deliveredOrders: 10, returnedOrders: 1 }); // no actualRevenue at all
  ok('revenue falls back to sellingPrice(300) * delivered(10) = 3000', bundle.revenue === 3000, String(bundle.revenue));
  ok('revenueSource is explicitly "estimated" — never silently presented as real', bundle.revenueSource === 'estimated', bundle.revenueSource);
}

console.log('\n§3 a real revenue of exactly 0 is still trusted as real (a genuine "sold but not paid yet" case), never silently replaced by the estimate:');
{
  const bundle = netProfitBundle(product, { adSpend: 100, deliveredOrders: 2, returnedOrders: 0, actualRevenue: 0 });
  ok('revenue stays the real 0, not the estimated 600', bundle.revenue === 0, String(bundle.revenue));
  ok('revenueSource is "real" even though the value is 0', bundle.revenueSource === 'real');
}

console.log('\n§4 SAFETY — netProfit is never silently -adSpend from a missing-revenue bug; it is null whenever deliveredOrders itself is unknown:');
{
  const bundle = netProfitBundle(product, { adSpend: 500 }); // deliveredOrders omitted entirely
  ok('netProfit is null (never -500) when deliveredOrders is genuinely unknown', bundle.netProfit === null, String(bundle.netProfit));
  ok('revenue is also null, never a fabricated 0', bundle.revenue === null);
  ok('revenueSource is null too (nothing to label)', bundle.revenueSource === null);
}

console.log('\n§5 zero delivered orders (a real, checked "nothing delivered yet" state) correctly nets to -adSpend — this is honest, not a bug:');
{
  const bundle = netProfitBundle(product, { adSpend: 500, deliveredOrders: 0, returnedOrders: 0 });
  ok('revenue is 0 (real: 0 delivered orders means 0 revenue)', bundle.revenue === 0);
  ok('netProfit correctly equals -adSpend in this specific, real, zero-delivered case', bundle.netProfit === -500, String(bundle.netProfit));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
