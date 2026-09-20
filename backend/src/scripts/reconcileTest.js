// Real production incident fix — services/amb/reconcile.js's
// reconcilePendingRecommendations() used to collapse ANY pending
// recommendation whose batch_id differed from the account's newest one to
// SUPERSEDED, with NO `level` filter. Since Smart Decision Center's
// product-level decisions (level:'product') use their own independent
// per-product batch_id scheme (never the classic engine's shared
// per-account batch_id), every classic-engine run silently superseded
// EVERY pending product decision account-wide — which then hid the Action
// Plan tab's "تجهيز" CTA everywhere (canApprove requires status==='PENDING').
// Confirmed live: 7 of 8 real products in production had their latest
// product-level decision incorrectly stuck at SUPERSEDED this way.
// Real throwaway AmbRecommendation rows (tagged, cleaned up after).
//   node src/scripts/reconcileTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { reconcilePendingRecommendations } = await imp('../services/amb/reconcile.js');
const { prisma } = await imp('../prisma.js');

const cleanupIds = [];
async function cleanup() {
  for (const id of cleanupIds) await prisma.ambRecommendation.deleteMany({ where: { id } });
}

function baseData(overrides = {}) {
  return {
    batch_id: `test-reconcile-${Date.now()}-${Math.random()}`,
    ad_account_id: 'act_test_reconcile',
    level: 'product',
    decision: 'AUDIENCE_TEST',
    action_type: 'DRAFT_PRODUCT_DECISION',
    executable: false,
    reason: 'test',
    confidence: 'MEDIUM',
    status: 'PENDING',
    ...overrides,
  };
}

try {
  console.log('§1 CRITICAL FIX — a product-level PENDING decision is NEVER superseded just because a newer, unrelated CLASSIC batch exists for the same ad account:');
  {
    const adAccountId = 'act_test_reconcile';
    const oldProductBatch = `product-batch-old-${Date.now()}`;
    const productRec = await prisma.ambRecommendation.create({ data: baseData({ ad_account_id: adAccountId, batch_id: oldProductBatch, product_name: 'Test Product', amb_product_id: null }) });
    cleanupIds.push(productRec.id);

    // A NEWER classic (campaign-level) batch for the SAME ad account — this
    // is exactly the real-world trigger (a classic recommendation run)
    // that used to wrongly supersede the product-level row above.
    const newClassicRec = await prisma.ambRecommendation.create({ data: baseData({
      ad_account_id: adAccountId, level: 'campaign', decision: 'SCALE', status: 'PENDING',
      batch_id: `classic-batch-new-${Date.now()}`, entity_id: 'camp_test_reconcile', entity_name: 'Test Campaign',
    }) });
    cleanupIds.push(newClassicRec.id);

    await reconcilePendingRecommendations({ adAccountId });

    const after = await prisma.ambRecommendation.findUnique({ where: { id: productRec.id } });
    ok('the product-level decision STAYS PENDING — never superseded by an unrelated classic batch', after.status === 'PENDING', JSON.stringify(after));
  }

  console.log('\n§2 the classic engine\'s OWN batch-collapse behavior is UNCHANGED — a stale classic-level PENDING rec still gets superseded by a newer classic batch:');
  {
    const adAccountId = 'act_test_reconcile_2';
    const oldClassicRec = await prisma.ambRecommendation.create({ data: baseData({
      ad_account_id: adAccountId, level: 'campaign', decision: 'SCALE', status: 'PENDING',
      batch_id: `classic-batch-old-${Date.now()}`, entity_id: 'camp_test_old', entity_name: 'Old Campaign',
    }) });
    cleanupIds.push(oldClassicRec.id);
    const newClassicRec = await prisma.ambRecommendation.create({ data: baseData({
      ad_account_id: adAccountId, level: 'campaign', decision: 'SCALE', status: 'PENDING',
      batch_id: `classic-batch-new2-${Date.now()}`, entity_id: 'camp_test_new', entity_name: 'New Campaign',
    }) });
    cleanupIds.push(newClassicRec.id);

    await reconcilePendingRecommendations({ adAccountId });

    const afterOld = await prisma.ambRecommendation.findUnique({ where: { id: oldClassicRec.id } });
    ok('the OLD classic-level rec from a stale batch is correctly superseded — original behavior preserved', afterOld.status === 'SUPERSEDED', JSON.stringify(afterOld));
  }

  console.log('\n§3 a product-level decision from an OLDER batch also survives, even when a newer PRODUCT batch exists for a DIFFERENT product (never cross-product contamination either):');
  {
    const adAccountId = 'act_test_reconcile_3';
    const productA = await prisma.ambRecommendation.create({ data: baseData({ ad_account_id: adAccountId, batch_id: `product-a-${Date.now()}`, product_name: 'Product A' }) });
    cleanupIds.push(productA.id);
    const productB = await prisma.ambRecommendation.create({ data: baseData({ ad_account_id: adAccountId, batch_id: `product-b-${Date.now()}`, product_name: 'Product B' }) });
    cleanupIds.push(productB.id);

    await reconcilePendingRecommendations({ adAccountId });

    const afterA = await prisma.ambRecommendation.findUnique({ where: { id: productA.id } });
    const afterB = await prisma.ambRecommendation.findUnique({ where: { id: productB.id } });
    ok('Product A stays PENDING despite Product B\'s different batch_id existing', afterA.status === 'PENDING', JSON.stringify(afterA));
    ok('Product B stays PENDING too — product-level rows are never batch-collapsed against each other', afterB.status === 'PENDING', JSON.stringify(afterB));
  }
} finally {
  await cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
