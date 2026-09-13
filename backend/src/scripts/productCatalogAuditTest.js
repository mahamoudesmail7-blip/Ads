// READ-ONLY catalog-vs-internal-Product audit — offline tests against
// services/amb/productMarketing.js's classifyCatalogProductMatch/
// auditEasyOrdersCatalog and the new admin-only route
// GET /api/product-marketing/easy-orders/catalog-audit.
// Zero real network calls (global fetch mocked for easy-orders.net only)
// and zero real DB writes (every prisma write method on product/
// easyOrdersOrder/dailyOrder throws if called; product reads are mocked
// in-memory).
//   node src/scripts/productCatalogAuditTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

process.env.EASYORDERS_API_KEY = 'test-trendy-key';

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

let dbWriteAttempted = false;
for (const model of ['product', 'easyOrdersOrder', 'dailyOrder']) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const original = prisma[model]?.[method]?.bind(prisma[model]);
    if (!original) continue;
    prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called — must never reach a real write.`); };
  }
}

const INTERNAL_PRODUCTS = [
  { id: 48, product_name: 'جهاز قياس الضغط الذكي المنزلي', sku: '', active: true },
  { id: 10, product_name: 'منتج له SKU حقيقي', sku: 'SKU-REAL-10', active: true },
  { id: 60, product_name: 'منتج مكرر الاسم', sku: '', active: true },
  { id: 61, product_name: 'منتج مكرر الاسم', sku: '', active: true },
];
prisma.product.findMany = async ({ where } = {}) => {
  if (where && 'active' in where) return INTERNAL_PRODUCTS.filter((p) => p.active === where.active);
  return INTERNAL_PRODUCTS;
};

// Never let a real network call reach Easy Orders' API — intercept ONLY
// requests to their real API base URL.
const originalFetch = globalThis.fetch;
const FAKE_CATALOG = [
  { id: 1, name: 'جهاز قياس الضغط الذكي المنزلي (s48)', slug: 'p1', thumb: 't1', price: 3699, created_at: '2026-01-01' }, // -> exact name match (product 48), no catalog sku
  { id: 2, name: 'منتج آخر تمامًا', slug: 'p2', thumb: 't2', price: 199, sku: 'SKU-REAL-10', created_at: '2026-01-01' }, // -> exact SKU match (product 10) even though name differs
  { id: 3, name: 'فرشاة تنظيف البشرة الكهربائية بالسيليكون (s259)', slug: 'p3', thumb: 't3', price: 699, created_at: '2026-01-01' }, // -> MISSING (no internal product)
  { id: 4, name: 'منتج مكرر الاسم (s99)', slug: 'p4', thumb: 't4', price: 99, created_at: '2026-01-01' }, // -> AMBIGUOUS (products 60 and 61 share this normalized name)
];
globalThis.fetch = async (url, ...rest) => {
  if (String(url).includes('easy-orders.net/api/v1/external-apps/products')) {
    return { ok: true, status: 200, json: async () => FAKE_CATALOG, text: async () => '' };
  }
  if (String(url).includes('easy-orders.net')) return { ok: false, status: 404, text: async () => '' };
  return originalFetch(url, ...rest);
};

const PM = await import(pathToFileURL(join(__dirname, '../services/amb/productMarketing.js')).href);

console.log('§1 classifyCatalogProductMatch — direct unit checks:');
{
  const r1 = PM.classifyCatalogProductMatch(null, 'جهاز قياس الضغط الذكي المنزلي (s48)', INTERNAL_PRODUCTS);
  ok('EXACT_NAME_MATCH after suffix-strip -> product 48', r1.status === 'EXACT_NAME_MATCH' && r1.product?.id === 48, JSON.stringify(r1));

  const r2 = PM.classifyCatalogProductMatch('SKU-REAL-10', 'اسم مختلف كليًا', INTERNAL_PRODUCTS);
  ok('EXACT_SKU_MATCH takes priority over name', r2.status === 'EXACT_SKU_MATCH' && r2.product?.id === 10, JSON.stringify(r2));

  const r3 = PM.classifyCatalogProductMatch(null, 'منتج غير موجود إطلاقًا', INTERNAL_PRODUCTS);
  ok('MISSING when nothing matches', r3.status === 'MISSING' && r3.product === null, JSON.stringify(r3));

  const r4 = PM.classifyCatalogProductMatch(null, 'منتج مكرر الاسم (s99)', INTERNAL_PRODUCTS);
  ok('AMBIGUOUS when two internal products share the normalized name', r4.status === 'AMBIGUOUS' && r4.product === null && r4.candidates?.length === 2, JSON.stringify(r4));

  const r5 = PM.classifyCatalogProductMatch(null, 'جهاز قياس الضغط الذكي المنزلي الجديد', INTERNAL_PRODUCTS);
  ok('a similar-but-not-exact name is NOT matched (no contains/fuzzy)', r5.status === 'MISSING', JSON.stringify(r5));
}

console.log('\n§2 auditEasyOrdersCatalog — full pipeline over the fake catalog:');
{
  const report = await PM.auditEasyOrdersCatalog('default');
  ok('ok:true, source:live (mocked fetch succeeded)', report.ok === true && report.source === 'live', JSON.stringify({ ok: report.ok, source: report.source }));
  ok('total = 4', report.summary.total === 4, JSON.stringify(report.summary));
  ok('summary: 1 EXACT_SKU_MATCH, 1 EXACT_NAME_MATCH, 1 MISSING, 1 AMBIGUOUS', report.summary.EXACT_SKU_MATCH === 1 && report.summary.EXACT_NAME_MATCH === 1 && report.summary.MISSING === 1 && report.summary.AMBIGUOUS === 1, JSON.stringify(report.summary));

  const s48Item = report.items.find((i) => i.eoId === 1);
  ok('item for eoId=1 (s48) resolves to productId 48 via EXACT_NAME_MATCH', s48Item?.status === 'EXACT_NAME_MATCH' && s48Item?.productId === 48, JSON.stringify(s48Item));

  const s259Item = report.items.find((i) => i.eoId === 3);
  ok('item for eoId=3 (s259) is MISSING with productId null', s259Item?.status === 'MISSING' && s259Item?.productId === null, JSON.stringify(s259Item));
  ok('MISSING item carries a suggested displayName with the suffix stripped (original casing, not the lowercased normalizedName)', s259Item?.displayName === 'فرشاة تنظيف البشرة الكهربائية بالسيليكون', JSON.stringify(s259Item));

  const ambiguousItem = report.items.find((i) => i.eoId === 4);
  ok('item for eoId=4 is AMBIGUOUS and lists both candidate ids', ambiguousItem?.status === 'AMBIGUOUS' && JSON.stringify(ambiguousItem.ambiguousCandidateIds?.sort()) === JSON.stringify([60, 61]), JSON.stringify(ambiguousItem));
}

console.log('\n§3 route smoke test — GET /api/product-marketing/easy-orders/catalog-audit requires ADMIN and returns the same audit:');
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

  const noAuthRes = await fetch(base + '/easy-orders/catalog-audit');
  ok('no auth cookie -> 401', noAuthRes.status === 401, String(noAuthRes.status));

  const authRes = await fetch(base + '/easy-orders/catalog-audit', { headers: { Cookie: `token=${token}` } });
  const authBody = await authRes.json();
  ok('valid admin cookie -> 200 with the same summary shape', authRes.status === 200 && authBody.summary?.total === 4, JSON.stringify(authBody.summary));

  server.close();
  prisma.user.findUnique = originalUserFindUnique;
}

console.log('\n§4 zero real DB writes attempted at any point in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

globalThis.fetch = originalFetch;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
