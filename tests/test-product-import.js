// test-product-import.js — Product Import planning + duplicate detection +
// CSV parsing tests.
import { test, assertEqual, assertTrue } from './test-runner.js';
import { normalizeImportRow, buildImportPlan, parseProductsCsv } from '../js/product-import.js';

test('normalizeImportRow: trims fields, blank category becomes null', () => {
  const row = normalizeImportRow({ product_name: '  منتج  ', sku: ' S1 ', category: '  ' });
  assertEqual(row.product_name, 'منتج');
  assertEqual(row.sku, 'S1');
  assertEqual(row.category, null);
});

test('normalizeImportRow: preserves an explicitly supplied product_code (regression: real-catalog import was silently dropping it)', () => {
  const row = normalizeImportRow({ product_name: 'منتج', product_code: 'PRD-007' });
  assertEqual(row.product_code, 'PRD-007');
});

test('buildImportPlan: toCreate rows keep their product_code through the plan', () => {
  const plan = buildImportPlan([], [{ product_name: 'منتج أ', product_code: 'PRD-001' }]);
  assertEqual(plan.toCreate[0].product_code, 'PRD-001');
});

test('buildImportPlan: brand-new products with no existing match all go to toCreate', () => {
  const plan = buildImportPlan([], [{ product_name: 'منتج أ' }, { product_name: 'منتج ب' }]);
  assertEqual(plan.toCreate.length, 2);
  assertEqual(plan.toUpdate.length, 0);
});

test('buildImportPlan: exact name match (case/whitespace-insensitive) routes to toUpdate, not toCreate', () => {
  const existing = [{ id: 1, product_name: 'جهاز نحت الوجه', sku: '' }];
  const plan = buildImportPlan(existing, [{ product_name: '  جهاز نحت الوجه  ' }]);
  assertEqual(plan.toCreate.length, 0);
  assertEqual(plan.toUpdate.length, 1);
  assertEqual(plan.toUpdate[0].existing.id, 1);
});

test('buildImportPlan: non-empty SKU match wins over a name mismatch', () => {
  const existing = [{ id: 5, product_name: 'الاسم القديم', sku: 'S53' }];
  const plan = buildImportPlan(existing, [{ product_name: 'اسم جديد مختلف تمامًا', sku: 'S53' }]);
  assertEqual(plan.toUpdate.length, 1);
  assertEqual(plan.toUpdate[0].existing.id, 5);
});

test('buildImportPlan: two blank-SKU products with different names are NOT considered duplicates of each other', () => {
  const existing = [{ id: 1, product_name: 'منتج أ', sku: '' }];
  const plan = buildImportPlan(existing, [{ product_name: 'منتج ب', sku: '' }]);
  assertEqual(plan.toCreate.length, 1);
  assertEqual(plan.toUpdate.length, 0);
});

test('buildImportPlan: duplicate row WITHIN the same uploaded file is flagged, not created twice', () => {
  const plan = buildImportPlan([], [{ product_name: 'منتج أ' }, { product_name: 'منتج أ' }]);
  assertEqual(plan.toCreate.length, 1);
  assertEqual(plan.duplicatesInFile.length, 1);
});

test('buildImportPlan: missing product_name is an error, not silently skipped or created', () => {
  const plan = buildImportPlan([], [{ product_name: '' }, { product_name: '   ' }]);
  assertEqual(plan.errors.length, 2);
  assertEqual(plan.toCreate.length, 0);
});

test('parseProductsCsv: parses Arabic headers and rows correctly', () => {
  const csv = 'اسم المنتج,SKU,الفئة\nمنتج أ,S1,Beauty\nمنتج ب,,Home';
  const { rows, error } = parseProductsCsv(csv);
  assertEqual(error, null);
  assertEqual(rows.length, 2);
  assertEqual(rows[0].product_name, 'منتج أ');
  assertEqual(rows[0].sku, 'S1');
  assertEqual(rows[1].category, 'Home');
});

test('parseProductsCsv: quoted field containing a comma is parsed as one field', () => {
  const csv = 'اسم المنتج,SKU\n"منتج, به فاصلة",S9';
  const { rows } = parseProductsCsv(csv);
  assertEqual(rows[0].product_name, 'منتج, به فاصلة');
  assertEqual(rows[0].sku, 'S9');
});

test('parseProductsCsv: missing "اسم المنتج" column returns a clear error, not a crash', () => {
  const { rows, error } = parseProductsCsv('SKU,الفئة\nS1,Beauty');
  assertEqual(rows.length, 0);
  assertTrue(error !== null);
});

test('parseProductsCsv: empty file returns an error', () => {
  const { error } = parseProductsCsv('');
  assertTrue(error !== null);
});
