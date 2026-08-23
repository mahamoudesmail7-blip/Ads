// test-profit.js — Profit Layer tests (spec sections 2-4), using the
// spec's own worked examples so the numbers are independently verifiable.
import { test, assertEqual, assertClose } from './test-runner.js';
import { breakEvenCPA, profitPerOrder, cpaStatus, revenue, grossProfit, netProfit, actualReturnRate } from '../js/profit.js';

// Worked example from the spec: Selling 800, Product Cost 300, Shipping 60,
// Packaging 20, Other 20 -> Break-even/"Allowed before Ads" = 400.
const WORKED_PRODUCT = {
  selling_price: 800,
  product_cost: 300,
  shipping_cost: 60,
  packaging_cost: 20,
  other_cost: 20,
  expected_return_cost: 0,
  commission: 0,
};

test('breakEvenCPA: matches spec worked example (800-300-60-20-20=400)', () => {
  assertEqual(breakEvenCPA(WORKED_PRODUCT), 400);
});

test('profitPerOrder: CPA=100 -> profit=300 (matches spec)', () => {
  assertEqual(profitPerOrder({ ...WORKED_PRODUCT, advertising_cost: 100 }), 300);
});

test('profitPerOrder: CPA=450 -> profit=-50 (matches spec LOSS example)', () => {
  assertEqual(profitPerOrder({ ...WORKED_PRODUCT, advertising_cost: 450 }), -50);
});

test('cpaStatus: break-even 350, CPA 180 -> PROFITABLE (matches spec)', () => {
  const p = { selling_price: 350 + 300, product_cost: 300, advertising_cost: 180 };
  // constructed so breakEvenCPA = 350
  assertEqual(breakEvenCPA(p), 350);
  assertEqual(cpaStatus(p), 'PROFITABLE');
});

test('cpaStatus: break-even 350, CPA 380 -> UNPROFITABLE (matches spec)', () => {
  const p = { selling_price: 350 + 300, product_cost: 300, advertising_cost: 380 };
  assertEqual(cpaStatus(p), 'UNPROFITABLE');
});

test('breakEvenCPA: missing selling_price returns null, never a fake number', () => {
  assertEqual(breakEvenCPA({ product_cost: 100 }), null);
});

test('profitPerOrder: missing advertising_cost (no CPA set yet) returns null, not a false profit', () => {
  assertEqual(profitPerOrder(WORKED_PRODUCT), null);
});

test('revenue / grossProfit / netProfit: worked example over 10 orders', () => {
  assertEqual(revenue(WORKED_PRODUCT, 10), 8000);
  assertEqual(grossProfit(WORKED_PRODUCT, 10), (800 - 300) * 10);
  assertEqual(netProfit({ ...WORKED_PRODUCT, advertising_cost: 100 }, 10), 3000);
});

test('revenue: null orders count (No Data) returns null, not 0', () => {
  assertEqual(revenue(WORKED_PRODUCT, null), null);
});

// ---------------------------------------------------------------------------
// Return rate — must distinguish "no delivery data yet" from "0% returns"
// ---------------------------------------------------------------------------

test('actualReturnRate: computed only from days with BOTH delivered and returned recorded', () => {
  const records = [
    { delivered_count: 8, returned_count: 2 }, // counted: 20%
    { delivered_count: null, returned_count: null }, // No Data day, excluded
    { delivered_count: 10, returned_count: 0 }, // counted: 0%
  ];
  // total delivered=18, returned=2 -> 2/20 = 10%
  assertClose(actualReturnRate(records), 10, 0.01);
});

test('actualReturnRate: no day has delivery data at all -> null, not 0%', () => {
  const records = [
    { delivered_count: null, returned_count: null },
    { orders_count: 5 }, // delivered/returned simply absent from the record
  ];
  assertEqual(actualReturnRate(records), null);
});
