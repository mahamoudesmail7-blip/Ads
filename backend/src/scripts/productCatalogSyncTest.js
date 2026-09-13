// Easy Orders Catalog Sync — CREATE flow + cache-freshness tests
// (services/amb/productMarketing.js's createProductsFromEasyOrdersCatalog/
// auditEasyOrdersCatalog + the admin-only POST
// /api/product-marketing/easy-orders/catalog-audit/create route).
// Every prisma.product write is a fully in-memory mock (an array this file
// owns) — this file NEVER performs a real DB write. Every other write
// method on product/easyOrdersOrder/dailyOrder throws if called, so any
// accidental real-write path in the code under test fails the run loudly
// instead of silently reaching production.
//   node src/scripts/productCatalogSyncTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

process.env.EASYORDERS_API_KEY = 'test-trendy-key';

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

// ---------------------------------------------------------------------------
// Guard every write method EXCEPT product.create, which this test mocks with
// a real in-memory implementation (never touches the actual database).
// ---------------------------------------------------------------------------
let dbWriteAttempted = false;
for (const method of ['upsert', 'update', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
  const orig = prisma.product[method]?.bind(prisma.product);
  if (orig) prisma.product[method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.product.${method}() was called.`); };
}
for (const model of ['easyOrdersOrder', 'dailyOrder']) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const orig = prisma[model]?.[method]?.bind(prisma[model]);
    if (orig) prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called — this flow must never touch orders.`); };
  }
}

// ---------------------------------------------------------------------------
// In-memory "Product table" — the ONLY thing prisma.product.findMany/create
// read from and write to for the rest of this file.
// ---------------------------------------------------------------------------
let internalProducts = [
  { id: 1, product_name: 'منتج موجود بالفعل', sku: '', active: true, product_code: 'PRD-001' },
  { id: 2, product_name: 'منتج مكرر الاسم', sku: '', active: true, product_code: 'PRD-002' },
  { id: 3, product_name: 'منتج مكرر الاسم', sku: '', active: true, product_code: 'PRD-003' },
];
let nextInternalId = 100;

prisma.product.findMany = async (args = {}) => {
  let rows = internalProducts;
  if (args.where && 'active' in args.where) rows = rows.filter((p) => p.active === args.where.active);
  if (args.select) return rows.map((r) => Object.fromEntries(Object.keys(args.select).filter((k) => args.select[k]).map((k) => [k, r[k]])));
  return rows.map((r) => ({ ...r }));
};
prisma.product.create = async ({ data }) => {
  if (data.product_name === 'منتج يفشل عمدًا للاختبار') throw new Error('SIMULATED_DB_ERROR');
  const row = { id: nextInternalId++, sku: null, active: true, ...data };
  internalProducts.push(row);
  return { ...row };
};

// Never let a real network call reach Easy Orders' API. Counts how many
// times the /products endpoint is actually hit, so cache-hit vs cache-miss
// behavior can be asserted directly instead of inferred.
const originalFetch = globalThis.fetch;
let fetchCallCount = 0;
const FAKE_CATALOG = [
  { id: 'a1', name: 'منتج قابل للإنشاء (s1)', price: 500, created_at: '2026-01-01' },
  { id: 'a2', name: 'منتج موجود بالفعل (s2)', price: 300, created_at: '2026-01-01' }, // normalizes to internal id=1
  { id: 'a3', name: 'منتج مكرر الاسم (s3)', price: 100, created_at: '2026-01-01' }, // normalizes to internal ids 2 AND 3 -> ambiguous
  { id: 'a6', name: 'اسم صالح تمامًا (s6)', price: 10, created_at: '2026-01-01' },
  { id: 'a7', name: 'منتج جديد للسباق (s7)', price: 20, created_at: '2026-01-01' },
  { id: 'a10', name: 'منتج يفشل عمدًا للاختبار (s10)', price: 1, created_at: '2026-01-01' },
  { id: 'a11', name: 'منتج ينجح رغم فشل غيره في نفس الدفعة (s11)', price: 2, created_at: '2026-01-01' },
];
globalThis.fetch = async (url, ...rest) => {
  if (String(url).includes('easy-orders.net/api/v1/external-apps/products')) { fetchCallCount++; return { ok: true, status: 200, json: async () => FAKE_CATALOG, text: async () => '' }; }
  if (String(url).includes('easy-orders.net')) return { ok: false, status: 404, text: async () => '' };
  return originalFetch(url, ...rest);
};

const PM = await import(pathToFileURL(join(__dirname, '../services/amb/productMarketing.js')).href);

console.log('§1 catalog cache — a normal (no forceRefresh) call reuses the warm cache:');
{
  await PM.auditEasyOrdersCatalog('default'); // cold -> fetches once
  const afterFirst = fetchCallCount;
  ok('first call fetched the live catalog', afterFirst >= 1, String(afterFirst));
  await PM.auditEasyOrdersCatalog('default'); // warm cache -> should NOT fetch again
  ok('second normal call did NOT hit the network again (cache reused)', fetchCallCount === afterFirst, `before=${afterFirst} after=${fetchCallCount}`);
}

console.log('\n§2 forceRefresh bypasses the cache:');
{
  const before = fetchCallCount;
  await PM.auditEasyOrdersCatalog('default', { forceRefresh: true });
  ok('forceRefresh:true always hits the network even with a warm cache', fetchCallCount === before + 1, `before=${before} after=${fetchCallCount}`);
}

console.log('\n§3 a newly-added EasyOrders product is invisible under the stale cache, but appears immediately with forceRefresh (this is exactly "future product auto-discovery"):');
{
  FAKE_CATALOG.push({ id: 'a9', name: 'منتج جديد أُضيف على Easy Orders الآن (s9)', price: 777, created_at: '2026-02-01' });
  const staleReport = await PM.auditEasyOrdersCatalog('default'); // no forceRefresh -> still the cached snapshot from before a9 existed
  ok('a9 is NOT visible yet under the stale cache (proves the cache is real)', !staleReport.items.some((i) => i.eoId === 'a9'), String(staleReport.items.length));

  const freshReport = await PM.auditEasyOrdersCatalog('default', { forceRefresh: true });
  const a9 = freshReport.items.find((i) => i.eoId === 'a9');
  ok('a9 IS visible immediately with forceRefresh, classified MISSING', a9?.status === 'MISSING', JSON.stringify(a9));
}

console.log('\n§4 single create — a brand-new product, price taken from the real (fake) EasyOrders catalog, never client-supplied:');
{
  const before = internalProducts.length;
  const fetchBefore = fetchCallCount;
  const r = await PM.createProductsFromEasyOrdersCatalog('default', [{ eoId: 'a1' }]);
  ok('create ALWAYS re-fetches the fresh catalog, even with a warm cache (never trusts a stale snapshot)', fetchCallCount === fetchBefore + 1, `before=${fetchBefore} after=${fetchCallCount}`);
  ok('status CREATED', r.results[0].status === 'CREATED', JSON.stringify(r.results[0]));
  ok('name is the suffix-stripped real catalog name', r.results[0].product?.product_name === 'منتج قابل للإنشاء', JSON.stringify(r.results[0]));
  ok('price is exactly EasyOrders\' real price (500), not invented', r.results[0].product?.selling_price === 500, JSON.stringify(r.results[0]));
  ok('a product_code was auto-assigned (PRD-004, next after 001-003)', r.results[0].product?.product_code === 'PRD-004', JSON.stringify(r.results[0]));
  ok('exactly one new internal row was added', internalProducts.length === before + 1, String(internalProducts.length));
  ok('summary reflects 1 created', r.summary.created === 1, JSON.stringify(r.summary));
}

console.log('\n§5 repeated create for the SAME eoId (idempotency) — must SKIP, never duplicate:');
{
  const before = internalProducts.length;
  const r = await PM.createProductsFromEasyOrdersCatalog('default', [{ eoId: 'a1' }]);
  ok('status SKIPPED_EXISTS on the second attempt', r.results[0].status === 'SKIPPED_EXISTS', JSON.stringify(r.results[0]));
  ok('points at the product created in §4', r.results[0].existingProductName === 'منتج قابل للإنشاء', JSON.stringify(r.results[0]));
  ok('no new row was added', internalProducts.length === before, String(internalProducts.length));
}

console.log('\n§6 audit reflects the just-created product as EXACT_NAME_MATCH (refresh-after-create behavior), MISSING -> EXACT_NAME_MATCH:');
{
  const report = await PM.auditEasyOrdersCatalog('default', { forceRefresh: true });
  const item = report.items.find((i) => i.eoId === 'a1');
  ok('eoId=a1 is now EXACT_NAME_MATCH, not MISSING', item?.status === 'EXACT_NAME_MATCH', JSON.stringify(item));
  ok('productId points at the row created in §4', typeof item?.productId === 'number' && item.productId >= 100, JSON.stringify(item));
}

console.log('\n§7 an EasyOrders item whose normalized name already matches ONE internal product -> SKIPPED_EXISTS, never a duplicate:');
{
  const before = internalProducts.length;
  const r = await PM.createProductsFromEasyOrdersCatalog('default', [{ eoId: 'a2' }]);
  ok('status SKIPPED_EXISTS', r.results[0].status === 'SKIPPED_EXISTS' && r.results[0].existingProductId === 1, JSON.stringify(r.results[0]));
  ok('no new row was added', internalProducts.length === before, String(internalProducts.length));
}

console.log('\n§8 an EasyOrders item whose normalized name matches TWO internal products -> AMBIGUOUS, never guessed/created:');
{
  const before = internalProducts.length;
  const r = await PM.createProductsFromEasyOrdersCatalog('default', [{ eoId: 'a3' }]);
  ok('status AMBIGUOUS with both candidate ids', r.results[0].status === 'AMBIGUOUS' && JSON.stringify(r.results[0].candidateIds.sort()) === JSON.stringify([2, 3]), JSON.stringify(r.results[0]));
  ok('no new row was added', internalProducts.length === before, String(internalProducts.length));
}

console.log('\n§9 batch create — mixed outcomes in ONE call, processed one at a time:');
{
  const r = await PM.createProductsFromEasyOrdersCatalog('default', [{ eoId: 'a2' }, { eoId: 'a3' }, { eoId: 'does-not-exist' }]);
  ok('3 results in the same order as requested', r.results.length === 3, JSON.stringify(r.results.map((x) => x.eoId)));
  ok('a2 -> SKIPPED_EXISTS', r.results[0].status === 'SKIPPED_EXISTS', JSON.stringify(r.results[0]));
  ok('a3 -> AMBIGUOUS', r.results[1].status === 'AMBIGUOUS', JSON.stringify(r.results[1]));
  ok('does-not-exist -> NOT_FOUND (never invented from a stale client value)', r.results[2].status === 'NOT_FOUND', JSON.stringify(r.results[2]));
  ok('summary tallies match: 1 skippedExists, 1 ambiguous, 1 notFound', r.summary.skippedExists === 1 && r.summary.ambiguous === 1 && r.summary.notFound === 1, JSON.stringify(r.summary));
}

console.log('\n§10 an empty/whitespace-only name override -> INVALID_NAME, never created blank:');
{
  const before = internalProducts.length;
  const r = await PM.createProductsFromEasyOrdersCatalog('default', [{ eoId: 'a6', name: '   ' }]);
  ok('status INVALID_NAME', r.results[0].status === 'INVALID_NAME', JSON.stringify(r.results[0]));
  ok('no new row was added', internalProducts.length === before, String(internalProducts.length));
}

console.log('\n§11 double-click / concurrent repeated request for the SAME new name -> never two CREATED, never two rows:');
{
  const before = internalProducts.length;
  const [r1, r2] = await Promise.all([
    PM.createProductsFromEasyOrdersCatalog('default', [{ eoId: 'a7' }]),
    PM.createProductsFromEasyOrdersCatalog('default', [{ eoId: 'a7' }]),
  ]);
  const statuses = [r1.results[0].status, r2.results[0].status];
  const createdCount = statuses.filter((s) => s === 'CREATED').length;
  ok('exactly one of the two concurrent requests actually created it', createdCount === 1, JSON.stringify(statuses));
  ok('the other was skipped (IN_PROGRESS or EXISTS), never a second CREATED', statuses.some((s) => s === 'IN_PROGRESS' || s === 'SKIPPED_EXISTS'), JSON.stringify(statuses));
  const rowsForThisName = internalProducts.filter((p) => p.product_name === 'منتج جديد للسباق').length;
  ok('exactly one real row exists for this name after both requests settled', rowsForThisName === 1, String(rowsForThisName));
  ok('no new row was added beyond that one', internalProducts.length === before + 1, String(internalProducts.length));
}

console.log('\n§12 one item throwing an unexpected error -> FAILED for that item only, the rest of the batch still completes:');
{
  const before = internalProducts.length;
  const r = await PM.createProductsFromEasyOrdersCatalog('default', [{ eoId: 'a10' }, { eoId: 'a11' }]);
  ok('a10 -> FAILED with the underlying error message, batch not aborted', r.results[0].status === 'FAILED' && r.results[0].message === 'SIMULATED_DB_ERROR', JSON.stringify(r.results[0]));
  ok('a11 -> CREATED despite a10 failing right before it', r.results[1].status === 'CREATED', JSON.stringify(r.results[1]));
  ok('exactly one new row was added (only a11, not a10)', internalProducts.length === before + 1, String(internalProducts.length));
  ok('summary tallies 1 failed, 1 created', r.summary.failed === 1 && r.summary.created === 1, JSON.stringify(r.summary));
}

console.log('\n§13 route smoke test — POST /api/product-marketing/easy-orders/catalog-audit/create requires ADMIN, validates body, and matches the service result:');
{
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
  const jwt = (await import('jsonwebtoken')).default;
  const originalUserFindUnique = prisma.user.findUnique.bind(prisma.user);
  prisma.user.findUnique = async () => ({ id: 999, email: 'admin@test.local', name: 'Test Admin', role: 'ADMIN', status: 'ACTIVE', is_owner: false, permissions: '{}' });

  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const { default: pmRouter } = await import(pathToFileURL(join(__dirname, '../routes/productMarketing.js')).href);
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/product-marketing', pmRouter);
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api/product-marketing`;
  const token = jwt.sign({ id: 999 }, process.env.JWT_SECRET, { expiresIn: '5m' });

  const noAuthRes = await fetch(base + '/easy-orders/catalog-audit/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ eoId: 'a6' }] }) });
  ok('no auth cookie -> 401', noAuthRes.status === 401, String(noAuthRes.status));

  const emptyRes = await fetch(base + '/easy-orders/catalog-audit/create', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `token=${token}` }, body: JSON.stringify({ items: [] }) });
  ok('empty items array -> 400', emptyRes.status === 400, String(emptyRes.status));

  const noAuthAuditRes = await fetch(base + '/easy-orders/catalog-audit?force_refresh=true');
  ok('GET catalog-audit also requires auth -> 401', noAuthAuditRes.status === 401, String(noAuthAuditRes.status));

  const auditRes = await fetch(base + '/easy-orders/catalog-audit?force_refresh=true', { headers: { Cookie: `token=${token}` } });
  const auditBody = await auditRes.json();
  ok('GET catalog-audit with force_refresh=true -> 200, sees a9 (proves the route wires force_refresh through)', auditRes.status === 200 && auditBody.items?.some((i) => i.eoId === 'a9'), String(auditRes.status));

  const okRes = await fetch(base + '/easy-orders/catalog-audit/create', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `token=${token}` }, body: JSON.stringify({ items: [{ eoId: 'a6' }] }) });
  const okBody = await okRes.json();
  ok('valid admin cookie + real item -> 200 CREATED', okRes.status === 200 && okBody.results?.[0]?.status === 'CREATED', JSON.stringify(okBody));

  server.close();
  prisma.user.findUnique = originalUserFindUnique;
}

console.log('\n§14 zero real DB writes attempted anywhere in this file (only the in-memory mock was ever written to):');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

globalThis.fetch = originalFetch;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
