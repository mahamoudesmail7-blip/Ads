// Offline tests for backfillProductEasyOrdersUuids()
// (services/amb/productMarketing.js) — dry-run-by-default backfill of
// Product.easy_orders_uuid onto already-matched existing products. Zero
// real network calls (fetch mocked) and zero real DB writes unless a test
// explicitly opts into dryRun:false against the in-memory mock.
//   node src/scripts/backfillEasyOrdersUuidTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

process.env.EASYORDERS_API_KEY = 'test-key';

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

const PRODUCTS = [
  { id: 48, product_name: 'جهاز قياس الضغط الذكي المنزلي', sku: '', active: true, easy_orders_uuid: null },
  { id: 10, product_name: 'منتج له SKU حقيقي', sku: 'SKU-REAL-10', active: true, easy_orders_uuid: null },
  { id: 77, product_name: 'منتج له UUID بالفعل', sku: '', active: true, easy_orders_uuid: 'already-set-uuid' },
];
let updateManyCalls = [];
prisma.product.findMany = async ({ where } = {}) => {
  if (where?.id?.in) return PRODUCTS.filter((p) => where.id.in.includes(p.id));
  if (where && 'active' in where) return PRODUCTS.filter((p) => p.active === where.active);
  return PRODUCTS;
};
prisma.product.updateMany = async ({ where, data }) => {
  updateManyCalls.push({ where, data });
  const target = PRODUCTS.find((p) => p.id === where.id && p.easy_orders_uuid === where.easy_orders_uuid);
  if (!target) return { count: 0 };
  target.easy_orders_uuid = data.easy_orders_uuid; // simulate the write for chained assertions
  return { count: 1 };
};
for (const method of ['upsert', 'update', 'create', 'createMany', 'delete', 'deleteMany']) {
  const orig = prisma.product[method]?.bind(prisma.product);
  if (!orig) continue;
  prisma.product[method] = async () => { throw new Error(`TEST DESIGN VIOLATION: prisma.product.${method}() was called — must never reach a real write in this file.`); };
}

const originalFetch = globalThis.fetch;
const CATALOG = [
  { id: 'eo-48', name: 'جهاز قياس الضغط الذكي المنزلي (s48)', slug: 'p48', thumb: 't', price: 6500, created_at: null }, // -> EXACT_NAME_MATCH product 48
  { id: 'eo-10', name: 'منتج مختلف تمامًا', slug: 'p10', thumb: 't', price: 100, sku: 'SKU-REAL-10', created_at: null }, // -> EXACT_SKU_MATCH product 10
  { id: 'eo-77', name: 'منتج له UUID بالفعل', slug: 'p77', thumb: 't', price: 50, created_at: null }, // -> EXACT_NAME_MATCH product 77, but it ALREADY has a uuid
  { id: 'eo-missing', name: 'منتج غير موجود داخليًا', slug: 'pm', thumb: 't', price: 20, created_at: null }, // -> MISSING, never proposed
];
globalThis.fetch = async (url) => {
  if (String(url).includes('easy-orders.net/api/v1/external-apps/products')) return { ok: true, status: 200, json: async () => CATALOG };
  return originalFetch(url);
};

const PM = await import(pathToFileURL(join(__dirname, '../services/amb/productMarketing.js')).href);

console.log('§1 Dry run (default) — proposes changes but writes nothing:');
{
  const result = await PM.backfillProductEasyOrdersUuids('default');
  ok('ok:true', result.ok === true, JSON.stringify(result));
  ok('dryRun:true by default', result.dryRun === true);
  ok('proposes exactly 2 (product 48 via name, product 10 via sku) — never product 77 (already has a uuid) or the missing one', result.proposedCount === 2, JSON.stringify(result.proposed));
  ok('product 48 proposal carries the right eoId and match method', result.proposed.some((p) => p.productId === 48 && p.eoId === 'eo-48' && p.matchMethod === 'EXACT_NAME_MATCH'), JSON.stringify(result.proposed));
  ok('product 10 proposal carries the right eoId and match method', result.proposed.some((p) => p.productId === 10 && p.eoId === 'eo-10' && p.matchMethod === 'EXACT_SKU_MATCH'), JSON.stringify(result.proposed));
  ok('applied:0 in dry-run', result.applied === 0);
  ok('zero real writes attempted during dry-run', updateManyCalls.length === 0, JSON.stringify(updateManyCalls));
}

console.log('\n§2 Applying (dryRun:false) — writes only the proposed, unambiguous changes, never overwrites an existing value:');
{
  updateManyCalls = [];
  const result = await PM.backfillProductEasyOrdersUuids('default', { dryRun: false });
  ok('applied exactly 2', result.applied === 2, JSON.stringify(result));
  ok('product 48 now has its uuid set', PRODUCTS.find((p) => p.id === 48).easy_orders_uuid === 'eo-48');
  ok('product 10 now has its uuid set', PRODUCTS.find((p) => p.id === 10).easy_orders_uuid === 'eo-10');
  ok('product 77\'s pre-existing uuid was never touched', PRODUCTS.find((p) => p.id === 77).easy_orders_uuid === 'already-set-uuid');
  ok('every write was guarded by easy_orders_uuid:null in its WHERE clause (never a blind overwrite)', updateManyCalls.every((c) => c.where.easy_orders_uuid === null));
}

console.log('\n§3 Re-running after a successful backfill proposes nothing further (idempotent):');
{
  const result = await PM.backfillProductEasyOrdersUuids('default');
  ok('proposedCount:0 — products 48 and 10 already have their uuid, nothing left to propose', result.proposedCount === 0, JSON.stringify(result.proposed));
}

globalThis.fetch = originalFetch;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
