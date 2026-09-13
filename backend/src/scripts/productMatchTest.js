// Product Matching fix for EasyOrders ingestion — offline tests against
// services/easyOrders.js's matchProduct/stripStoreTagSuffix/exactNameKey.
// Every case mocks prisma.product.findFirst/findMany with fake in-memory
// data and installs throw-on-call interceptors on every prisma write method
// so this file can never reach a real write, no matter what the code under
// test does.
//   node src/scripts/productMatchTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

// Any write anywhere in prisma during this file is a test-design bug, not an
// expected path — fail loudly instead of silently touching prod.
let dbWriteAttempted = false;
const guardedModels = ['product', 'easyOrdersOrder', 'dailyOrder'];
for (const model of guardedModels) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const original = prisma[model]?.[method]?.bind(prisma[model]);
    if (!original) continue;
    prisma[model][method] = async (...args) => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called — this test must never reach a real write.`); };
  }
}

// findFirst/findMany on `product` are swapped per-case below to serve fake
// in-memory candidates instead of hitting the real DB at all.
const originalProductFindFirst = prisma.product.findFirst.bind(prisma.product);
const originalProductFindMany = prisma.product.findMany.bind(prisma.product);

const { stripStoreTagSuffix, exactNameKey, matchProduct } = await import(pathToFileURL(join(__dirname, '../services/easyOrders.js')).href);

function mockCatalog({ bySku = {}, all = [] }) {
  prisma.product.findFirst = async ({ where }) => {
    if (where?.sku !== undefined) return bySku[where.sku] || null;
    throw new Error('unexpected findFirst call in test: ' + JSON.stringify(where));
  };
  prisma.product.findMany = async ({ where } = {}) => {
    if (where && 'active' in where) return all.filter((p) => (where.active === undefined ? true : p.active === where.active));
    return all;
  };
}

const PRODUCT_48 = { id: 48, product_name: 'جهاز قياس الضغط الذكي المنزلي', sku: '', active: true };

console.log('§1 exact SKU match:');
{
  const skuProduct = { id: 10, product_name: 'منتج آخر', sku: 'SKU-REAL-10', active: true };
  mockCatalog({ bySku: { 'SKU-REAL-10': skuProduct }, all: [skuProduct, PRODUCT_48] });
  const result = await matchProduct('SKU-REAL-10', 'اسم مختلف تمامًا');
  ok('resolves via SKU regardless of name', result?.id === 10, JSON.stringify(result));
}

console.log('\n§2 SKU missing + exact normalized name -> match:');
{
  mockCatalog({ bySku: {}, all: [PRODUCT_48] });
  const result = await matchProduct(null, 'جهاز قياس الضغط الذكي المنزلي');
  ok('resolves via exact name fallback', result?.id === 48, JSON.stringify(result));
}

console.log('\n§3 "(s48)" suffix stripped -> matches product 48 exactly (the real order case):');
{
  mockCatalog({ bySku: { 'SKU-NGVNUSUN': null }, all: [PRODUCT_48] });
  ok('stripStoreTagSuffix removes the tag', stripStoreTagSuffix('جهاز قياس الضغط الذكي المنزلي (s48)') === 'جهاز قياس الضغط الذكي المنزلي');
  const result = await matchProduct('SKU-NGVNUSUN', 'جهاز قياس الضغط الذكي المنزلي (s48)');
  ok('resolves to product 48', result?.id === 48, JSON.stringify(result));
}

console.log('\n§4 similar but not exact name -> no match:');
{
  mockCatalog({ bySku: {}, all: [PRODUCT_48] });
  const result = await matchProduct(null, 'جهاز قياس الضغط الذكي المنزلي الجديد');
  ok('extra word means NOT exact -> null (no contains/fuzzy)', result === null, JSON.stringify(result));
}

console.log('\n§5 duplicate normalized names across two+ products -> no match (UNMAPPED):');
{
  const dup1 = { id: 48, product_name: 'جهاز قياس الضغط الذكي المنزلي', sku: '', active: true };
  const dup2 = { id: 99, product_name: 'جهاز قياس الضغط الذكي المنزلي', sku: '', active: true };
  mockCatalog({ bySku: {}, all: [dup1, dup2] });
  const result = await matchProduct(null, 'جهاز قياس الضغط الذكي المنزلي (s48)');
  ok('ambiguous match -> null rather than guessing', result === null, JSON.stringify(result));
}

console.log('\n§6 empty product name (no usable SKU) -> no match:');
{
  mockCatalog({ bySku: {}, all: [PRODUCT_48] });
  const r1 = await matchProduct(null, '');
  ok('empty name, no sku -> null', r1 === null, JSON.stringify(r1));
  const r2 = await matchProduct('', null);
  ok('empty sku + null name -> null', r2 === null, JSON.stringify(r2));
}

console.log('\n§7 wrong/non-matching SKU present but an otherwise-exact name -> falls through to name match (documented behavior: a present-but-wrong SKU is treated the same as a missing one for the fallback tier):');
{
  mockCatalog({ bySku: { 'SKU-WRONG': null }, all: [PRODUCT_48] });
  const result = await matchProduct('SKU-WRONG', 'جهاز قياس الضغط الذكي المنزلي');
  ok('SKU lookup miss falls through to exact-name match', result?.id === 48, JSON.stringify(result));
}

console.log('\n§8 zero real DB writes attempted at any point in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

prisma.product.findFirst = originalProductFindFirst;
prisma.product.findMany = originalProductFindMany;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
