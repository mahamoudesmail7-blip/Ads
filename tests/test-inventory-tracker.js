// test-inventory-tracker.js
import { test, assertEqual, assertTrue } from './test-runner.js';
import {
  classifyMovement,
  lowStockAlert,
  outOfStockAlert,
  highDemandAlert,
  buildWarehouseSummary,
  reconcileOrdersVsInventory,
  topOutgoingProducts,
  guessColumnMapping,
  parseImportRows,
  findDuplicateNames,
  classifyProductStatus,
  computeNoMovementStreak,
  noMovementAlertLevel,
  isMeaningfulOutgoingDrop,
  combinedProductStatus,
} from '../js/inventory-tracker.js';

test('classifyMovement: decrease -> OUT with correct unitsOut (matches spec worked example 100->85)', () => {
  const r = classifyMovement(100, 85);
  assertEqual(r.type, 'OUT');
  assertEqual(r.unitsOut, 15);
  assertEqual(r.stockChange, -15);
});

test('classifyMovement: increase -> ADDED, never reported as negative units out (spec section 7)', () => {
  const r = classifyMovement(100, 120);
  assertEqual(r.type, 'ADDED');
  assertEqual(r.unitsOut, 0);
  assertEqual(r.stockChange, 20);
});

test('classifyMovement: equal -> NONE', () => {
  const r = classifyMovement(80, 80);
  assertEqual(r.type, 'NONE');
  assertEqual(r.unitsOut, 0);
});

test('classifyMovement: missing previous stock (new product) -> UNKNOWN, never a fabricated diff', () => {
  const r = classifyMovement(null, 50);
  assertEqual(r.type, 'UNKNOWN');
  assertEqual(r.unitsOut, null);
});

test('lowStockAlert: at or under threshold and above zero -> true', () => {
  assertTrue(lowStockAlert(10, 10));
  assertTrue(lowStockAlert(5, 10));
  assertTrue(!lowStockAlert(11, 10));
});

test('lowStockAlert: zero stock is NOT "low stock" — it is out of stock, a separate alert', () => {
  assertTrue(!lowStockAlert(0, 10));
});

test('outOfStockAlert: exactly zero -> true, null (not tracked) -> false', () => {
  assertTrue(outOfStockAlert(0));
  assertTrue(!outOfStockAlert(null));
  assertTrue(!outOfStockAlert(5));
});

test('highDemandAlert: matches spec worked example (5 -> 20 units out)', () => {
  assertTrue(highDemandAlert(5, 20));
});

test('highDemandAlert: small absolute jump on a small base does not trigger (avoids false alarms)', () => {
  assertTrue(!highDemandAlert(1, 2));
});

test('highDemandAlert: zero yesterday, meaningful volume today -> true', () => {
  assertTrue(highDemandAlert(0, 8));
  assertTrue(!highDemandAlert(0, 2));
});

test('buildWarehouseSummary: matches spec worked example shape', () => {
  const snapshots = [
    { closing_stock: 85, movement_type: 'OUT', units_out: 15 },
    { closing_stock: 42, movement_type: 'OUT', units_out: 8 },
    { closing_stock: 80, movement_type: 'NONE', units_out: 0 },
    { closing_stock: 3, movement_type: 'OUT', units_out: 2 },
  ];
  const s = buildWarehouseSummary(snapshots, 5);
  assertEqual(s.totalProducts, 4);
  assertEqual(s.productsWithMovement, 3);
  assertEqual(s.totalUnitsOutToday, 25);
  assertEqual(s.totalUnitsAvailable, 210);
  assertEqual(s.productsWithNoMovement, 1);
  assertEqual(s.lowStockProducts, 1);
  assertEqual(s.outOfStockProducts, 0);
});

test('reconcileOrdersVsInventory: matches spec worked example (20 orders, 18 out -> diff 2)', () => {
  const r = reconcileOrdersVsInventory(20, 18);
  assertEqual(r.diff, 2);
  assertTrue(r.message.includes('2'));
});

test('reconcileOrdersVsInventory: equal -> no message', () => {
  const r = reconcileOrdersVsInventory(10, 10);
  assertEqual(r.diff, 0);
  assertEqual(r.message, null);
});

test('reconcileOrdersVsInventory: missing data -> null diff, no message, never a fabricated comparison', () => {
  const r = reconcileOrdersVsInventory(null, 10);
  assertEqual(r.diff, null);
  assertEqual(r.message, null);
});

test('topOutgoingProducts: ranks by units_out descending, caps at max, ignores non-OUT rows', () => {
  const snapshots = [
    { product_name: 'A', movement_type: 'OUT', units_out: 12 },
    { product_name: 'B', movement_type: 'OUT', units_out: 25 },
    { product_name: 'C', movement_type: 'ADDED', units_out: 0 },
    { product_name: 'D', movement_type: 'OUT', units_out: 18 },
  ];
  const top = topOutgoingProducts(snapshots, 2);
  assertEqual(top.length, 2);
  assertEqual(top[0].product_name, 'B');
  assertEqual(top[1].product_name, 'D');
});

test('guessColumnMapping: finds Product/Quantity/SKU/Warehouse columns by keyword regardless of order', () => {
  const headers = ['Warehouse', 'SKU', 'Current Stock', 'Product Name'];
  const m = guessColumnMapping(headers);
  assertEqual(m.productName, 'Product Name');
  assertEqual(m.quantity, 'Current Stock');
  assertEqual(m.sku, 'SKU');
  assertEqual(m.warehouse, 'Warehouse');
});

test('guessColumnMapping: matches Arabic headers too', () => {
  const headers = ['اسم المنتج', 'الكمية'];
  const m = guessColumnMapping(headers);
  assertEqual(m.productName, 'اسم المنتج');
  assertEqual(m.quantity, 'الكمية');
});

test('guessColumnMapping: no matching header -> null, never a wrong guess', () => {
  const m = guessColumnMapping(['Column A', 'Column B']);
  assertEqual(m.productName, null);
  assertEqual(m.quantity, null);
});

test('parseImportRows: valid rows extracted correctly per mapping', () => {
  const headers = ['Product', 'Stock'];
  const rows = [['Water Flosser', '85'], ['Face Sculpting Device', '42']];
  const { valid, invalid } = parseImportRows(rows, headers, { productName: 'Product', quantity: 'Stock' });
  assertEqual(valid.length, 2);
  assertEqual(invalid.length, 0);
  assertEqual(valid[0].name, 'Water Flosser');
  assertEqual(valid[0].quantity, 85);
});

test('parseImportRows: missing name or invalid quantity -> invalid, not silently coerced', () => {
  const headers = ['Product', 'Stock'];
  const rows = [['', '10'], ['Electric Toothbrush', 'abc'], ['Facial Hair Remover', '-5']];
  const { valid, invalid } = parseImportRows(rows, headers, { productName: 'Product', quantity: 'Stock' });
  assertEqual(valid.length, 0);
  assertEqual(invalid.length, 3);
});

test('findDuplicateNames: flags a name appearing more than once in the same file (case-insensitive)', () => {
  const parsed = [{ name: 'Water Flosser' }, { name: 'water flosser' }, { name: 'Electric Toothbrush' }];
  const dupes = findDuplicateNames(parsed);
  assertEqual(dupes.length, 1);
  assertEqual(dupes[0], 'water flosser');
});

test('classifyProductStatus: out of stock always wins regardless of movement size', () => {
  assertEqual(classifyProductStatus(0, 30).code, 'OUT_OF_STOCK');
  assertEqual(classifyProductStatus(0, 0).code, 'OUT_OF_STOCK');
});

test('classifyProductStatus: matches spec worked example thresholds (18/15 High, 12/8/7 Normal, 5/4/3 Low, 0 None)', () => {
  assertEqual(classifyProductStatus(72, 18).code, 'HIGH_MOVEMENT');
  assertEqual(classifyProductStatus(105, 15).code, 'HIGH_MOVEMENT');
  assertEqual(classifyProductStatus(68, 12).code, 'NORMAL_MOVEMENT');
  assertEqual(classifyProductStatus(142, 8).code, 'NORMAL_MOVEMENT');
  assertEqual(classifyProductStatus(63, 7).code, 'NORMAL_MOVEMENT');
  assertEqual(classifyProductStatus(55, 5).code, 'LOW_MOVEMENT');
  assertEqual(classifyProductStatus(41, 4).code, 'LOW_MOVEMENT');
  assertEqual(classifyProductStatus(47, 3).code, 'LOW_MOVEMENT');
  assertEqual(classifyProductStatus(100, 0).code, 'NO_MOVEMENT');
});

test('computeNoMovementStreak: matches spec worked examples (3, 2, 1 consecutive days)', () => {
  const three = [
    { date: '2026-08-19', movement_type: 'ADDED' },
    { date: '2026-08-20', movement_type: 'NONE' },
    { date: '2026-08-21', movement_type: 'NONE' },
    { date: '2026-08-22', movement_type: 'NONE' },
  ];
  assertEqual(computeNoMovementStreak(three), 3);

  const two = [
    { date: '2026-08-20', movement_type: 'ADDED' },
    { date: '2026-08-21', movement_type: 'NONE' },
    { date: '2026-08-22', movement_type: 'NONE' },
  ];
  assertEqual(computeNoMovementStreak(two), 2);

  const one = [
    { date: '2026-08-21', movement_type: 'OUT' },
    { date: '2026-08-22', movement_type: 'NONE' },
  ];
  assertEqual(computeNoMovementStreak(one), 1);
});

test('computeNoMovementStreak: a single movement day in the middle breaks the streak (only counts from the end)', () => {
  const history = [
    { date: '2026-08-18', movement_type: 'NONE' },
    { date: '2026-08-19', movement_type: 'NONE' },
    { date: '2026-08-20', movement_type: 'OUT' },
    { date: '2026-08-21', movement_type: 'NONE' },
    { date: '2026-08-22', movement_type: 'NONE' },
  ];
  assertEqual(computeNoMovementStreak(history), 2);
});

test('noMovementAlertLevel: matches spec thresholds (0-1 Normal, 2-6 Needs Attention, 7+ High Priority)', () => {
  assertEqual(noMovementAlertLevel(0).code, 'NORMAL');
  assertEqual(noMovementAlertLevel(1).code, 'NORMAL');
  assertEqual(noMovementAlertLevel(2).code, 'NEEDS_ATTENTION');
  assertEqual(noMovementAlertLevel(6).code, 'NEEDS_ATTENTION');
  assertEqual(noMovementAlertLevel(7).code, 'HIGH_PRIORITY');
  assertEqual(noMovementAlertLevel(10).code, 'HIGH_PRIORITY');
});

test('isMeaningfulOutgoingDrop: matches spec worked example (15 -> 5)', () => {
  assertTrue(isMeaningfulOutgoingDrop(15, 5));
});

test('isMeaningfulOutgoingDrop: a small wobble on a busy product does not qualify', () => {
  assertTrue(!isMeaningfulOutgoingDrop(15, 13));
});

test('isMeaningfulOutgoingDrop: big absolute drop but still over half of yesterday does not qualify', () => {
  assertTrue(!isMeaningfulOutgoingDrop(100, 60));
});

test('isMeaningfulOutgoingDrop: missing data never fabricates a comparison', () => {
  assertTrue(!isMeaningfulOutgoingDrop(null, 5));
  assertTrue(!isMeaningfulOutgoingDrop(15, null));
});

test('combinedProductStatus: matches spec worked examples (Water Flosser / Face Sculpting / Lighthouse)', () => {
  assertEqual(combinedProductStatus(true, 5 - 9).code, 'DOWN'); // Water Flosser: orders 9->5
  assertEqual(combinedProductStatus(true, 16 - 12).code, 'GOOD'); // Face Sculpting: orders 12->16
  assertEqual(combinedProductStatus(false, 0 - 2).code, 'NEEDS_ATTENTION'); // Lighthouse: no movement, orders 2->0
});

test('combinedProductStatus: no order data at all -> NORMAL, never guessed', () => {
  assertEqual(combinedProductStatus(true, null).code, 'NORMAL');
});
