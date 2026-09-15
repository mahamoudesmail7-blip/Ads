// Phase 11 — historical (deleted-from-source) product recovery. Offline
// tests against services/amb/productMarketing.js's
// recoverHistoricalProduct(). Zero real network calls (fetch mocked), and
// every write is against an in-memory mock so the exact before/after state
// can be asserted precisely.
//   node src/scripts/historicalRecoveryTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

process.env.EASYORDERS_STORES_JSON = JSON.stringify([{ id: 'default', name: 'Trendy Store', apiKeyEnv: 'EO_KEY' }]);
process.env.EO_KEY = 'test-key';

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

// Live catalog — deliberately does NOT contain the belt product (it was
// "deleted from the source"), and DOES contain one unrelated real product,
// proving the live-catalog-conflict guard checks by real name, not by
// coincidence.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes('easy-orders.net/api/v1/external-apps/products')) {
    return { ok: true, status: 200, json: async () => [{ id: 'eo-other', name: 'منتج آخر تمامًا', slug: 'other', thumb: 't', price: 100, created_at: null }] };
  }
  return originalFetch(url);
};

const BELT_NAME = 'حزام حراري كهربائي ومساج يساعد على حرق الدهون';

let PRODUCTS = [];
let nextProductId = 900;
prisma.product.create = async ({ data }) => { const row = { id: nextProductId++, active: true, store_id: null, is_historical: false, historical_note: null, ...data }; PRODUCTS.push(row); return { ...row }; };
prisma.product.findFirst = async ({ where }) => PRODUCTS.find((p) => (where.store_id === undefined || p.store_id === where.store_id) && (where.product_name === undefined || p.product_name === where.product_name) && (where.is_historical === undefined || p.is_historical === where.is_historical)) || null;

let ORDER_ROWS = [];
for (let i = 0; i < 206; i++) ORDER_ROWS.push({ id: i + 1, order_id: `belt-order-${i}`, store_id: 'default', matched: false, product_id: null, product_name_raw: BELT_NAME, status: 'PENDING', order_cost: 2009, date: '2026-09-01' });
for (let i = 0; i < 14; i++) ORDER_ROWS.push({ id: 300 + i, order_id: `belt-cancel-${i}`, store_id: 'default', matched: false, product_id: null, product_name_raw: BELT_NAME, status: 'CANCELLED', order_cost: 2009, date: '2026-09-05' });
// A row for an UNRELATED name in the same store, and one already-matched
// row for the SAME name — neither must ever be touched by the recovery.
ORDER_ROWS.push({ id: 999, order_id: 'unrelated-order', store_id: 'default', matched: false, product_id: null, product_name_raw: 'اسم مختلف تمامًا', status: 'PENDING', order_cost: 500, date: '2026-09-01' });
ORDER_ROWS.push({ id: 998, order_id: 'already-matched-order', store_id: 'default', matched: true, product_id: 48, product_name_raw: BELT_NAME, status: 'DELIVERED', order_cost: 2009, date: '2026-08-01' });
// Same exact name but in a DIFFERENT store — must never be touched by a
// recovery scoped to 'default'.
ORDER_ROWS.push({ id: 997, order_id: 'other-store-order', store_id: 'trendy-storeee', matched: false, product_id: null, product_name_raw: BELT_NAME, status: 'PENDING', order_cost: 2009, date: '2026-09-01' });

prisma.easyOrdersOrder.findMany = async ({ where }) => ORDER_ROWS.filter((r) =>
  (where.store_id === undefined || r.store_id === where.store_id) &&
  (where.matched === undefined || r.matched === where.matched) &&
  (where.product_id === undefined || r.product_id === where.product_id) &&
  (where.product_name_raw === undefined || r.product_name_raw === where.product_name_raw)
).map((r) => ({ ...r }));
prisma.easyOrdersOrder.updateMany = async ({ where, data }) => {
  const targets = ORDER_ROWS.filter((r) =>
    (where.store_id === undefined || r.store_id === where.store_id) &&
    (where.matched === undefined || r.matched === where.matched) &&
    (where.product_id === undefined || r.product_id === where.product_id) &&
    (where.product_name_raw === undefined || r.product_name_raw === where.product_name_raw)
  );
  for (const t of targets) Object.assign(t, data);
  return { count: targets.length };
};

// Every OTHER write method on every model must never be called.
let dbWriteAttempted = false;
for (const [model, methods] of [['product', ['upsert', 'update', 'updateMany', 'createMany', 'delete', 'deleteMany']], ['easyOrdersOrder', ['upsert', 'update', 'create', 'createMany', 'delete', 'deleteMany']]]) {
  for (const method of methods) {
    prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called — not part of this recovery's allowed write surface.`); };
  }
}

const PM = await import(pathToFileURL(join(__dirname, '../services/amb/productMarketing.js')).href);

console.log('§1 Dry run — reports exact real numbers, writes nothing:');
{
  const result = await PM.recoverHistoricalProduct({ storeId: 'default', productName: BELT_NAME });
  ok('ok:true, dryRun:true', result.ok === true && result.dryRun === true, JSON.stringify(result));
  ok('matchingRows:220 (206 PENDING + 14 CANCELLED, the already-matched row and the other store\'s row correctly excluded)', result.matchingRows === 220, String(result.matchingRows));
  ok('uniqueOrders:220 (one row per order, no double-counting)', result.uniqueOrders === 220, String(result.uniqueOrders));
  ok('statusBreakdown: 206 PENDING + 14 CANCELLED exactly', result.statusBreakdown.PENDING === 206 && result.statusBreakdown.CANCELLED === 14, JSON.stringify(result.statusBreakdown));
  ok('totalValue: 220 * 2009 = 441,980 (this fixture\'s own numbers — real production totalled 441,779 with slightly varying per-order costs)', result.totalValue === 220 * 2009, String(result.totalValue));
  ok('alreadyRecovered:false — no historical product exists yet', result.alreadyRecovered === false);
  ok('PRODUCTS array untouched by the dry run', PRODUCTS.length === 0);
  ok('ORDER_ROWS untouched by the dry run', ORDER_ROWS.filter((r) => r.matched).length === 1); // only the pre-seeded already-matched row
}

console.log('\n§2 Refuses when the exact name exists in the LIVE catalog right now:');
{
  const result = await PM.recoverHistoricalProduct({ storeId: 'default', productName: 'منتج آخر تمامًا' });
  ok('ok:false with a real reason naming the live eoId', result.ok === false && result.blockedByLiveCandidate?.id === 'eo-other', JSON.stringify(result));
}

console.log('\n§3 Refuses when there are no matching unmatched rows at all:');
{
  const result = await PM.recoverHistoricalProduct({ storeId: 'default', productName: 'اسم غير موجود إطلاقًا في أي طلب' });
  ok('ok:false, matchingRows:0', result.ok === false && result.matchingRows === 0, JSON.stringify(result));
}

console.log('\n§4 Apply — creates ONE historical product with NO invented fields, backfills exactly the 220 matching rows:');
{
  const result = await PM.recoverHistoricalProduct({ storeId: 'default', productName: BELT_NAME, dryRun: false });
  ok('applied:true', result.applied === true, JSON.stringify(result));
  ok('rowsBackfilled:220', result.rowsBackfilled === 220, String(result.rowsBackfilled));

  ok('exactly ONE new product created', PRODUCTS.length === 1, JSON.stringify(PRODUCTS));
  const p = PRODUCTS[0];
  ok('product_name is the EXACT real order name, nothing altered', p.product_name === BELT_NAME);
  ok('is_historical:true', p.is_historical === true);
  ok('store_id is default, never touches another store', p.store_id === 'default');
  ok('NO sku/price/category/image/slug/easy_orders_uuid invented — every one stays at the schema default (sku null, selling_price 0, category null, easy_orders_uuid null)', p.sku === undefined && p.selling_price === undefined && p.category === undefined && p.easy_orders_uuid === undefined, JSON.stringify(p));
  ok('historical_note is a real, honest explanation, not empty', typeof p.historical_note === 'string' && p.historical_note.length > 20);

  const beltRows = ORDER_ROWS.filter((r) => r.product_name_raw === BELT_NAME && r.store_id === 'default');
  ok('all 220 originally-unmatched belt rows are now matched to the new product', beltRows.filter((r) => r.matched && r.product_id === p.id).length === 220);
  ok('the ALREADY-matched row (product_id:48) was never touched/overwritten', ORDER_ROWS.find((r) => r.order_id === 'already-matched-order').product_id === 48);
  ok('the OTHER STORE\'s same-named row was never touched', ORDER_ROWS.find((r) => r.order_id === 'other-store-order').matched === false);
  ok('the unrelated-name row in the same store was never touched', ORDER_ROWS.find((r) => r.order_id === 'unrelated-order').matched === false);

  const totalPreserved = beltRows.filter((r) => r.status === 'PENDING' || r.status === 'CANCELLED').reduce((a, r) => a + r.order_cost, 0);
  ok('total order value exactly preserved after backfill (no row lost, no row duplicated)', totalPreserved === 220 * 2009, String(totalPreserved));
}

console.log('\n§5 Idempotent — running again finds the existing historical product, never creates a duplicate, backfills 0 more (already done):');
{
  const before = PRODUCTS.length;
  const result = await PM.recoverHistoricalProduct({ storeId: 'default', productName: BELT_NAME, dryRun: false });
  ok('applied:true, but rowsBackfilled:0 — nothing left to backfill', result.applied === true && result.rowsBackfilled === 0, JSON.stringify(result));
  ok('still exactly ONE product — no duplicate created', PRODUCTS.length === before, `before=${before} after=${PRODUCTS.length}`);
  ok('alreadyRecovered:true on the dry-run view of this same call', result.alreadyRecovered === true);
}

console.log('\n§6 zero writes outside the allowed surface (product.create/findFirst, easyOrdersOrder.findMany/updateMany only):');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

globalThis.fetch = originalFetch;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
