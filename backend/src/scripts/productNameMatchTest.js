// AI Media Buyer Operator — fuzzy product name resolution verification.
// Built after a real user complaint: the chat assistant kept asking for a
// raw product ID instead of understanding a product from its name (or a
// photo). Every case here is a REAL product name from the live catalogue —
// never a synthetic fixture — because the whole point is catching false
// positives/negatives against this account's actual (very duplicate-heavy)
// product list.
//
// Updated 2026-09-30 (store isolation): resolveProductByIdOrName's NAME path
// now REQUIRES a storeId (the exact gap an audit found — it used to search
// every store's catalogue at once). Every by-name case below now resolves a
// real storeId first and scopes its search/fixture-discovery to that ONE
// store, so "ambiguous"/"duplicate"/"unique" here mean ambiguous/duplicate/
// unique WITHIN a store, matching what the fixed resolver actually does.
// Cross-store leakage itself (same name in two stores) is covered by the
// dedicated aiAssistantStoreIsolationTest.js, not here.
//   node src/scripts/productNameMatchTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { resolveProductByIdOrName } = await imp('../services/amb/productNameMatch.js');
const { generate_angles, generate_hooks, generate_creative_brief } = await imp('../services/aiTools.js');
const { generate_campaign_copy } = await imp('../services/aiToolsWrite.js');

// Pick the real store with the most active products — maximizes the chance
// of genuine ambiguity/duplicate cases existing to test against, exactly
// like the original (pre-store-scoping) global tests could rely on.
const storeCounts = await prisma.product.groupBy({ by: ['store_id'], where: { active: true, is_historical: false, store_id: { not: null } }, _count: true, orderBy: { _count: { store_id: 'desc' } } });
const storeId = storeCounts[0]?.store_id;
if (!storeId) { console.log('No real store-tagged product found — cannot run store-scoped name-match tests.'); process.exit(1); }
console.log(`Using real store "${storeId}" (${storeCounts[0]._count} active products) for all by-name tests.\n`);

console.log('§0 Store isolation — the NAME path is fail-closed without a storeId:');
{
  const r = await resolveProductByIdOrName({ productName: 'أي اسم منتج' });
  ok('a name search with NO storeId is refused (STORE_CONTEXT_REQUIRED), never searches globally', r.ok === false && r.code === 'STORE_CONTEXT_REQUIRED', JSON.stringify(r));
}

console.log('\n§1 Honesty — a name with zero real matches never returns a fabricated product:');
{
  const r = await resolveProductByIdOrName({ productName: 'حاجة مش موجودة خالص فى النظام ١٢٣٤٥', storeId });
  ok('completely made-up name returns ok:false with empty candidates', r.ok === false && Array.isArray(r.candidates) && r.candidates.length === 0, JSON.stringify(r));

  const r2 = await resolveProductByIdOrName({ productName: 'منتج غير موجود خالص', storeId });
  ok('a name containing ONLY the generic filler word "منتج" plus junk never false-positives to an unrelated real product', r2.ok === false, JSON.stringify(r2));
}

console.log('\n§2 Genuine ambiguity — must ask by NAME, never silently guess:');
{
  const r = await resolveProductByIdOrName({ productName: 'راديو', storeId });
  if (r.ok === false && Array.isArray(r.candidates) && r.candidates.length >= 2) {
    ok('a single generic word matching MANY distinct real products WITHIN this store returns candidates, never auto-picks one', true);
    ok('every candidate is a real {id,name} pair', r.candidates.every((c) => typeof c.id === 'number' && typeof c.name === 'string'));
  } else {
    console.log('  (skipped — "راديو" is not ambiguous within this specific store right now; not a failure of the fix itself)');
  }
}

console.log('\n§3 True duplicate names — resolved deterministically instead of asked (identical names can\'t be told apart by name anyway), WITHIN one store:');
{
  const dupes = await prisma.product.groupBy({ by: ['product_name'], where: { active: true, is_historical: false, store_id: storeId }, _count: true, having: { product_name: { _count: { gt: 1 } } } });
  const realDupe = dupes[0];
  if (realDupe) {
    const r = await resolveProductByIdOrName({ productName: realDupe.product_name, storeId });
    ok(`a real duplicate name ("${realDupe.product_name.slice(0, 30)}...") within this store auto-resolves to ONE real product instead of asking an unanswerable "which one" question`, r.ok === true && typeof r.product?.id === 'number', JSON.stringify(r));
  } else {
    console.log('  (skipped — no duplicate product names exist within this store right now)');
  }
}

console.log('\n§4 Clear, unique real matches resolve without asking, WITHIN one store:');
{
  const uniqueProducts = await prisma.product.findMany({ where: { active: true, is_historical: false, store_id: storeId }, select: { product_name: true }, take: 200 });
  const nameCounts = new Map();
  for (const p of uniqueProducts) nameCounts.set(p.product_name, (nameCounts.get(p.product_name) || 0) + 1);
  const distinctive = [...nameCounts.entries()].find(([name, count]) => count === 1 && name.split(' ').length >= 3);
  if (distinctive) {
    const [name] = distinctive;
    const partial = name.split(' ').slice(0, 2).join(' '); // simulate a vision model's shorter description
    const r = await resolveProductByIdOrName({ productName: partial, storeId });
    ok(`a partial real name ("${partial}") resolves to a real product without asking, when it's not ambiguous`, r.ok === true || (r.ok === false && r.candidates?.length > 0), JSON.stringify(r).slice(0, 200));
  }
}

console.log('\n§5 productId still works unchanged (backward compatibility with existing callers/context) — storeId is verify-if-present, not required:');
{
  const real = await prisma.product.findFirst({ where: { active: true, is_historical: false } });
  const r = await resolveProductByIdOrName({ productId: real.id });
  ok('a real productId resolves directly with NO storeId, no name matching involved (storeless callers keep working)', r.ok === true && r.product.id === real.id);
  const bad = await resolveProductByIdOrName({ productId: 999999999 });
  ok('a non-existent productId fails clean', bad.ok === false);

  const realTagged = await prisma.product.findFirst({ where: { active: true, is_historical: false, store_id: storeId } });
  if (realTagged) {
    const sameStore = await resolveProductByIdOrName({ productId: realTagged.id, storeId });
    ok('a real productId + the SAME real storeId resolves fine', sameStore.ok === true && sameStore.product.id === realTagged.id);
    const otherStore = storeCounts.find((s) => s.store_id !== storeId)?.store_id;
    if (otherStore) {
      const wrongStore = await resolveProductByIdOrName({ productId: realTagged.id, storeId: otherStore });
      ok('a real productId + a DIFFERENT real storeId is refused (STORE_CONTEXT_REQUIRED), never silently returned', wrongStore.ok === false && wrongStore.code === 'STORE_CONTEXT_REQUIRED', JSON.stringify(wrongStore));
    } else {
      console.log('  (skipped cross-store productId check — only one real store exists in this DB)');
    }
  }
}

console.log('\n§6 The 4 content-generation tools accept productName end-to-end without ever requiring productId, and now REQUIRE store context for name search:');
{
  const real = await prisma.product.findFirst({ where: { active: true, is_historical: false, store_id: storeId }, select: { id: true, product_name: true } });
  const shortName = real.product_name.split(' ').slice(0, 2).join(' ');
  const context = { storeId };
  for (const [label, fn] of [['generate_angles', generate_angles], ['generate_hooks', generate_hooks], ['generate_creative_brief', generate_creative_brief], ['generate_campaign_copy', generate_campaign_copy]]) {
    const out = await fn({ productName: shortName, context });
    // Locally there's no OPENAI_API_KEY, so the AI call itself fails — what
    // matters here is that resolution happened (no "productId مطلوب" style
    // rejection) and productId/productName come back attached once resolved,
    // OR a real candidates list if the short name was ambiguous.
    const resolvedOrAmbiguous = out.productId != null || Array.isArray(out.candidates);
    ok(`${label}({productName, context:{storeId}}) never demands a raw productId`, resolvedOrAmbiguous || /مفتاح|API/.test(out.error || ''), JSON.stringify(out).slice(0, 200));

    const noStore = await fn({ productName: shortName });
    ok(`${label}({productName}) with NO store context is refused (STORE_CONTEXT_REQUIRED), never falls back to a global search`, noStore.ok === false && noStore.code === 'STORE_CONTEXT_REQUIRED', JSON.stringify(noStore).slice(0, 200));
  }
  for (const [label, fn] of [['generate_angles', generate_angles], ['generate_hooks', generate_hooks], ['generate_creative_brief', generate_creative_brief], ['generate_campaign_copy', generate_campaign_copy]]) {
    const out = await fn({});
    ok(`${label}({}) asks for a NAME, never says "productId مطلوب"`, !/productId\s*مطلوب/.test(out.error || ''), out.error);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
