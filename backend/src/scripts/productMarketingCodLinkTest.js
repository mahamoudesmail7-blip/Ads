// Product Marketing Center — COD linkage bug fix tests.
// Root cause: a locked EASY_ORDERS profile's product_id was resolved ONCE
// at lock time via js/product-mapping.js's plain normalizeName (which does
// NOT strip the "(s<number>)" Easy-Orders store-tag suffix), and never
// re-resolved afterward. A profile locked before its matching internal
// Product existed (e.g. created later via Catalog Sync) stayed stuck at
// product_id=null forever, silently hiding real COD data. Fixed by (1)
// making findInternalProductByName strip the suffix first — same rule as
// services/easyOrders.js's matchProduct/exactNameKey — and (2) adding
// resolveEffectiveProductId(), called fresh on every real computeSnapshot(),
// which falls back to a name-based lookup when product_id is null, WITHOUT
// ever writing that resolution back onto the profile row.
//   node src/scripts/productMarketingCodLinkTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

// Guard every write method on every model this fix must NEVER touch —
// resolveEffectiveProductId is documented as in-memory-only, and this test
// proves it: no write, anywhere, ever, for any scenario below.
let dbWriteAttempted = false;
for (const model of ['product', 'productMarketingProfile', 'easyOrdersOrder', 'dailyOrder']) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const orig = prisma[model]?.[method]?.bind(prisma[model]);
    if (!orig) continue;
    prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called — this fix must never write anywhere.`); };
  }
}

const INTERNAL_PRODUCTS = [
  { id: 141, product_name: 'فرشاة تنظيف البشرة الكهربائية بالسيليكون', sku: null, active: true },
  { id: 48, product_name: 'جهاز قياس الضغط الذكي المنزلي', sku: '', active: true },
];
let findManyCalls = 0;
prisma.product.findMany = async ({ where } = {}) => {
  findManyCalls++;
  if (where && 'active' in where) return INTERNAL_PRODUCTS.filter((p) => p.active === where.active);
  return INTERNAL_PRODUCTS;
};
prisma.product.findUnique = async ({ where }) => INTERNAL_PRODUCTS.find((p) => p.id === where.id) || null;

const PM = await import(pathToFileURL(join(__dirname, '../services/amb/productMarketing.js')).href);

console.log('§1 findInternalProductByName strips the "(s<number>)" suffix before matching (the actual production bug):');
{
  const found = await PM.findInternalProductByName('فرشاة تنظيف البشرة الكهربائية بالسيليكون (s259)');
  ok('resolves to internal Product 141 despite the raw Easy Orders name carrying (s259)', found?.id === 141, JSON.stringify(found));
}

console.log('\n§2 findInternalProductByName returns null when no internal product matches at all:');
{
  const found = await PM.findInternalProductByName('منتج غير موجود إطلاقًا (s999)');
  ok('null, never a guess', found === null, JSON.stringify(found));
}

console.log('\n§3 resolveEffectiveProductId returns the already-set product_id immediately, WITHOUT any extra DB lookup:');
{
  const before = findManyCalls;
  const id = await PM.resolveEffectiveProductId({ product_id: 48, locked_name: 'اسم لا علاقة له بأي شيء' });
  ok('returns the existing product_id as-is', id === 48, String(id));
  ok('never queried the Product table when product_id was already set', findManyCalls === before, `before=${before} after=${findManyCalls}`);
}

console.log('\n§4 resolveEffectiveProductId self-heals a profile locked before its product existed (the exact reported production bug — order 256 / product 141 / eoId s259):');
{
  const id = await PM.resolveEffectiveProductId({ product_id: null, locked_name: 'فرشاة تنظيف البشرة الكهربائية بالسيليكون (s259)' });
  ok('resolves to internal Product 141 via the name fallback', id === 141, String(id));
}

console.log('\n§5 resolveEffectiveProductId returns null when product_id is null and no internal product matches — stays honestly unmapped, never guessed:');
{
  const id = await PM.resolveEffectiveProductId({ product_id: null, locked_name: 'منتج جديد لم يُنشأ داخليًا بعد (s777)' });
  ok('null', id === null, String(id));
}

console.log('\n§6 zero real DB writes anywhere in this file — the fix is proven in-memory-only:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
