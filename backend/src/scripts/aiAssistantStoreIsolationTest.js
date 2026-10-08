// AI Assistant store-isolation regression (2026-09-30). Closes the gap the
// user flagged AFTER storeIsolationTest.js (which only covers Live Campaign
// Intelligence/PMC): the AI Assistant's own product-name resolver and its
// ~25 productId-based tools must ALSO never return evidence, or prepare an
// action, for a product belonging to a store other than the one currently
// declared in the assistant's page context.
//
// Real data only — reuses the same real cross-store duplicate-name products
// storeIsolationTest.js already discovers in this DB, never a fabricated
// fixture. Covers exactly the categories the user asked for:
//   read tools (get_growth_plan) · write/prepare-adjacent resolution
//   (resolveProduct, the same helper prepare_campaign/scale/test call) ·
//   content generation (generate_angles/hooks/creative_brief/campaign_copy) ·
//   Live Campaign State (get_live_campaign_state).
//   node src/scripts/aiAssistantStoreIsolationTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const { prisma } = await imp('../prisma.js');
const { resolveProductByIdOrName } = await imp('../services/amb/productNameMatch.js');
const { verifyProductStoreScope, STORE_CONTEXT_REQUIRED } = await imp('../services/amb/storeScope.js');
const { resolveProduct } = await imp('../services/assistantTasks/launchCampaignPrepare.js');
const { generate_angles, generate_hooks, generate_creative_brief, get_live_campaign_state, get_growth_plan } = await imp('../services/aiTools.js');
const { generate_campaign_copy } = await imp('../services/aiToolsWrite.js');

console.log('§1 Find a real product NAME shared by two different real stores (no fabrication):');
const dupes = await prisma.$queryRaw`
  SELECT product_name, array_agg(DISTINCT store_id) AS store_ids
  FROM products
  WHERE active = true AND is_historical = false AND store_id IS NOT NULL
  GROUP BY product_name
  HAVING COUNT(DISTINCT store_id) > 1
  LIMIT 1
`;

let sharedName, storeA, storeB, productA, productB;
if (dupes.length) {
  sharedName = dupes[0].product_name;
  [storeA, storeB] = dupes[0].store_ids;
  [productA, productB] = await Promise.all([
    prisma.product.findFirst({ where: { product_name: sharedName, store_id: storeA, active: true }, select: { id: true, product_name: true, store_id: true } }),
    prisma.product.findFirst({ where: { product_name: sharedName, store_id: storeB, active: true }, select: { id: true, product_name: true, store_id: true } }),
  ]);
  ok(`found a real shared name ("${sharedName.slice(0, 30)}...") across store "${storeA}" (product #${productA?.id}) and store "${storeB}" (product #${productB?.id})`, !!productA && !!productB);
} else {
  console.log('  (no real product name is currently shared by two stores in this DB — falling back to two arbitrary real products from two different stores for the ID-based checks below; the name-based checks that need a genuine shared name will be skipped, not failed)');
  const storeCounts = await prisma.product.groupBy({ by: ['store_id'], where: { active: true, is_historical: false, store_id: { not: null } }, _count: true });
  if (storeCounts.length >= 2) {
    storeA = storeCounts[0].store_id; storeB = storeCounts[1].store_id;
    productA = await prisma.product.findFirst({ where: { store_id: storeA, active: true }, select: { id: true, product_name: true, store_id: true } });
    productB = await prisma.product.findFirst({ where: { store_id: storeB, active: true }, select: { id: true, product_name: true, store_id: true } });
  }
}

if (!productA || !productB) {
  console.log('\nFewer than two real store-tagged products exist in this DB — cannot run the cross-store proofs. Not a failure of the fix; just nothing real to test against right now.');
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

if (sharedName) {
  console.log('\n§2 Central name resolver — same name, different store contexts, never crosses over:');
  const rA = await resolveProductByIdOrName({ productName: sharedName, storeId: storeA });
  ok(`while "in" store A, resolving "${sharedName.slice(0, 24)}..." returns store A's own product (#${productA.id}), never store B's`, rA.ok === true && rA.product.id === productA.id, JSON.stringify(rA));
  const rB = await resolveProductByIdOrName({ productName: sharedName, storeId: storeB });
  ok(`while "in" store B, the SAME name returns store B's own product (#${productB.id}), never store A's`, rB.ok === true && rB.product.id === productB.id, JSON.stringify(rB));
  const rNone = await resolveProductByIdOrName({ productName: sharedName });
  ok('the SAME name with NO store declared is refused outright (never defaults to either store)', rNone.ok === false && rNone.code === STORE_CONTEXT_REQUIRED, JSON.stringify(rNone));
} else {
  console.log('\n§2 skipped (no genuine shared name found).');
}

console.log('\n§3 ID-based resolution + verifyProductStoreScope — the shared guard behind get_live_campaign_state/get_growth_plan/the AI-Assistant route\'s central gate:');
{
  const sameStore = await resolveProductByIdOrName({ productId: productA.id, storeId: storeA });
  ok('a real productId + its OWN real store resolves fine', sameStore.ok === true && sameStore.product.id === productA.id);
  const crossStore = await resolveProductByIdOrName({ productId: productA.id, storeId: storeB });
  ok('the SAME productId + a DIFFERENT real store is refused, never silently returned', crossStore.ok === false && crossStore.code === STORE_CONTEXT_REQUIRED, JSON.stringify(crossStore));
  const noStore = await resolveProductByIdOrName({ productId: productA.id });
  ok('the SAME productId with NO store declared still resolves (id-based backward compatibility for storeless callers)', noStore.ok === true && noStore.product.id === productA.id);
}

console.log('\n§4 Write/prepare-tool product resolution — resolveProduct(), the exact helper prepare_campaign/prepare_scale/prepare_test all call after their own initial lookup:');
{
  const own = await resolveProduct(productA.id, storeA);
  ok('resolveProduct(productA, storeA) — its own store — returns the product', own?.id === productA.id);
  const cross = await resolveProduct(productA.id, storeB);
  ok('resolveProduct(productA, storeB) — a DIFFERENT declared store — returns null (treated as "not found", never returned)', cross === null);
  const legacyCall = await resolveProduct(productA.id);
  ok('resolveProduct(productA) with NO storeId argument still resolves (storeless prepare_* callers keep working)', legacyCall?.id === productA.id);
}

console.log('\n§5 Content-generation tools (generate_angles/hooks/creative_brief/campaign_copy) never cross stores via context.storeId:');
{
  for (const [label, fn] of [['generate_angles', generate_angles], ['generate_hooks', generate_hooks], ['generate_creative_brief', generate_creative_brief], ['generate_campaign_copy', generate_campaign_copy]]) {
    const wrongStore = await fn({ productId: productA.id, context: { storeId: storeB } });
    ok(`${label}({productId: productA, context:{storeId: storeB}}) is refused, never generates content for the wrong store's product`, wrongStore.ok === false && wrongStore.code === STORE_CONTEXT_REQUIRED, JSON.stringify(wrongStore).slice(0, 200));
  }
}

console.log('\n§6 get_live_campaign_state — Live Campaign State never answers "عاملة إيه دلوقتي؟" for a different store\'s product:');
{
  const wrongStore = await get_live_campaign_state({ productId: productA.id, context: { storeId: storeB } });
  ok('get_live_campaign_state(productA, context:{storeId: storeB}) is refused', wrongStore.ok === false && wrongStore.code === STORE_CONTEXT_REQUIRED, JSON.stringify(wrongStore));
  const rightStore = await get_live_campaign_state({ productId: productA.id, context: { storeId: storeA } });
  ok('get_live_campaign_state(productA, context:{storeId: storeA}) is NOT refused for store reasons (whatever its own data-availability answer is)', rightStore.code !== STORE_CONTEXT_REQUIRED, JSON.stringify(rightStore).slice(0, 200));
}

console.log('\n§7 get_growth_plan — Product Growth never plans for a different store\'s product:');
{
  const wrongStore = await get_growth_plan({ productId: productA.id, context: { storeId: storeB } });
  ok('get_growth_plan(productA, context:{storeId: storeB}) is refused', wrongStore.ok === false && wrongStore.code === STORE_CONTEXT_REQUIRED, JSON.stringify(wrongStore));
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
