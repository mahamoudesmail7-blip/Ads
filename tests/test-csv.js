// test-csv.js — CSV import correctness (spec sections 3-4): column parsing,
// duplicate-safe matching by product name, and date validation.
import { test, assertEqual, assertTrue } from './test-runner.js';
import { parseCSV, normalizeDate, parseOrdersCSV } from '../js/csv.js';

test('parseCSV: splits a simple comma file into rows', () => {
  const rows = parseCSV('Date,Product,Orders\n2026-08-16,Widget,5\n2026-08-17,Widget,6');
  assertEqual(rows.length, 3);
  assertEqual(rows[1], ['2026-08-16', 'Widget', '5']);
});

test('parseCSV: handles quoted fields containing commas', () => {
  const rows = parseCSV('Date,Product,Orders\n2026-08-16,"Widget, Deluxe",5');
  assertEqual(rows[1][1], 'Widget, Deluxe');
});

test('normalizeDate: accepts ISO YYYY-MM-DD', () => {
  assertEqual(normalizeDate('2026-08-16'), '2026-08-16');
});

test('normalizeDate: accepts DD/MM/YYYY', () => {
  assertEqual(normalizeDate('16/08/2026'), '2026-08-16');
});

test('normalizeDate: rejects calendar-impossible dates (month 13)', () => {
  assertEqual(normalizeDate('2026-13-40'), null);
});

test('normalizeDate: rejects Feb 30', () => {
  assertEqual(normalizeDate('2026-02-30'), null);
});

test('normalizeDate: rejects garbage input', () => {
  assertEqual(normalizeDate('not a date'), null);
});

test('parseOrdersCSV: matches products by name and reports unknown products as errors', () => {
  const products = [{ id: 1, product_name: 'Widget' }];
  const csv = 'Date,Product,Orders\n2026-08-16,Widget,5\n2026-08-16,Unknown Thing,3';
  const { valid, errors, unmatchedProducts } = parseOrdersCSV(csv, products);
  assertEqual(valid.length, 1);
  assertEqual(valid[0], { product_id: 1, date: '2026-08-16', orders_count: 5 });
  assertEqual(errors.length, 1);
  assertEqual(unmatchedProducts, ['Unknown Thing']);
});

test('parseOrdersCSV: two rows for the same product+date both resolve to ONE upsert target (no duplicate)', () => {
  const products = [{ id: 1, product_name: 'Widget' }];
  const csv = 'Date,Product,Orders\n2026-08-16,Widget,5\n2026-08-16,Widget,9';
  const { valid } = parseOrdersCSV(csv, products);
  // Both rows parse (the importer doesn't silently drop the second one);
  // it's DailyOrders.upsert() that guarantees the second call updates
  // the same row instead of creating a duplicate — exercised end-to-end
  // in the browser, not re-derivable from parsing alone.
  assertEqual(valid.length, 2);
  assertTrue(valid.every((r) => r.product_id === 1 && r.date === '2026-08-16'));
});

test('parseOrdersCSV: invalid orders count is reported as an error, not silently coerced to 0', () => {
  const products = [{ id: 1, product_name: 'Widget' }];
  const csv = 'Date,Product,Orders\n2026-08-16,Widget,abc';
  const { valid, errors } = parseOrdersCSV(csv, products);
  assertEqual(valid.length, 0);
  assertEqual(errors.length, 1);
});
