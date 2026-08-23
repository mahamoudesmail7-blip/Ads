// test-product-mapping.js — EasyOrders Product Mapping Layer tests.
import { test, assertEqual, assertTrue } from './test-runner.js';
import { normalizeName, mapProductByName } from '../js/product-mapping.js';

const PRODUCTS = [
  { id: 1, product_name: 'جهاز مساج الرقبة والظهر', sku: 'PRD-080' },
  { id: 2, product_name: 'نظارة شمس', sku: '' },
  { id: 3, product_name: 'نظارة علاج بالضوء الاحمر لتجاعيد العين', sku: 'S53' },
];

test('normalizeName: unifies alef/ya/ta-marbuta variants and whitespace', () => {
  assertEqual(normalizeName('  إجهاز   الأذن  '), normalizeName('اجهاز الاذن'));
  assertEqual(normalizeName('نظاره'), normalizeName('نظارة'));
});

test('mapProductByName: exact normalized name match', () => {
  const r = mapProductByName('جهاز مساج الرقبة والظهر', PRODUCTS);
  assertEqual(r.productId, 1);
  assertEqual(r.method, 'exact_name');
});

test('mapProductByName: exact SKU match', () => {
  const r = mapProductByName('S53', PRODUCTS);
  assertEqual(r.productId, 3);
  assertEqual(r.method, 'exact_sku');
});

test('mapProductByName: near-miss wording still matches via token overlap (fuzzy)', () => {
  // EasyOrders example from the spec: "جهاز مساج الرقبة" -> PRD-080
  const r = mapProductByName('جهاز مساج الرقبة', PRODUCTS);
  assertEqual(r.productId, 1);
  assertEqual(r.method, 'fuzzy');
  assertTrue(r.confidence >= 0.6);
});

test('mapProductByName: unrelated text returns unmatched, never a wrong guess', () => {
  const r = mapProductByName('شيء غير موجود إطلاقًا في الكتالوج', PRODUCTS);
  assertEqual(r.productId, null);
  assertEqual(r.method, 'unmatched');
});

test('mapProductByName: empty external name returns unmatched immediately', () => {
  const r = mapProductByName('', PRODUCTS);
  assertEqual(r.productId, null);
  assertEqual(r.method, 'unmatched');
});
