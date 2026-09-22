// Smart Decision Center Phase 2 — services/amb/productPerformance.js's
// getProductPerformance(). Proves: (1) both campaign-resolution paths (the
// new deterministic Launch chain AND the pre-existing historical mapping)
// feed the same unified dataset, (2) every honest data-state
// (META_UNMAPPED/NOT_SYNCED/AVAILABLE) is reported rather than a fabricated
// zero, (3) mandatory multi-store isolation — a product's Easy Orders never
// leak another store's rows even when they share a product_id. Real
// throwaway DB rows (tagged, cleaned up after), zero Meta calls.
//   node src/scripts/productPerformanceTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { getProductPerformance, computeBusinessConversionRate } = await imp('../services/amb/productPerformance.js');
const { prisma } = await imp('../prisma.js');

const cleanup = { productIds: [], jobIds: [], ambProductIds: [] };
async function cleanupAll() {
  for (const jobId of cleanup.jobIds) {
    await prisma.ambLaunchCampaign.deleteMany({ where: { job_id: jobId } });
    await prisma.ambLaunchJob.deleteMany({ where: { job_id: jobId } });
  }
  for (const ambProductId of cleanup.ambProductIds) {
    await prisma.ambProductCampaignMap.deleteMany({ where: { amb_product_id: ambProductId } });
    await prisma.ambProduct.deleteMany({ where: { id: ambProductId } });
  }
  await prisma.easyOrdersOrder.deleteMany({ where: { product_id: { in: cleanup.productIds } } });
  await prisma.product.deleteMany({ where: { id: { in: cleanup.productIds } } });
}

try {
  console.log('§1 META_UNMAPPED — a product with no Launch link and no historical mapping never fabricates a zero:');
  {
    const product = await prisma.product.create({ data: { product_name: '__test_perf_unmapped__', active: true } });
    cleanup.productIds.push(product.id);
    const result = await getProductPerformance({ productId: product.id, windowName: 'last7' });
    ok('meta.dataState is META_UNMAPPED, not AVAILABLE with zeros', result.meta.dataState === 'META_UNMAPPED', result.meta.dataState);
    ok('meta.spend stays null — never a fabricated 0', result.meta.spend === null);
    ok('resolvedVia is empty', Array.isArray(result.resolvedVia) && result.resolvedVia.length === 0);
    ok('easyOrders.dataState is NO_DATA — genuinely no orders for this brand-new product', result.easyOrders.dataState === 'NO_DATA');
  }

  console.log('\n§2 LAUNCH resolution path — the new deterministic Product->Launch->Campaign chain feeds the dataset:');
  {
    const product = await prisma.product.create({ data: { product_name: '__test_perf_launch__', active: true } });
    cleanup.productIds.push(product.id);
    const jobId = `test-perf-launch-${Date.now()}`;
    cleanup.jobIds.push(jobId);
    await prisma.ambLaunchJob.create({ data: { job_id: jobId, product_id: product.id, ad_account_id: 'act_test_perf', budget_mode: 'CBO', config_json: '{}', status: 'DRAFT' } });
    await prisma.ambLaunchCampaign.create({ data: { job_id: jobId, index: 0, name: 'Perf Test Campaign', status: 'COMPLETE', meta_campaign_id: 'fake_campaign_launch_1' } });

    const result = await getProductPerformance({ productId: product.id, windowName: 'last7' });
    ok('resolvedVia includes LAUNCH', result.resolvedVia.includes('LAUNCH'), JSON.stringify(result.resolvedVia));
    ok('campaignIds includes the real linked meta_campaign_id', result.meta.campaignIds.includes('fake_campaign_launch_1'), JSON.stringify(result.meta.campaignIds));
    ok('a genuinely never-synced campaign id is honestly NOT_SYNCED, never a fabricated zero-spend AVAILABLE', result.meta.dataState === 'NOT_SYNCED', result.meta.dataState);
  }

  console.log('\n§3 MAPPING resolution path — the pre-existing historical AmbProductCampaignMap still feeds the same dataset:');
  {
    const product = await prisma.product.create({ data: { product_name: '__test_perf_mapping__', active: true } });
    cleanup.productIds.push(product.id);
    const ambProduct = await prisma.ambProduct.create({ data: { product_id: product.id, product_name: product.product_name } });
    cleanup.ambProductIds.push(ambProduct.id);
    await prisma.ambProductCampaignMap.create({ data: { amb_product_id: ambProduct.id, ad_account_id: 'act_test_perf', campaign_id: 'fake_campaign_map_1', status: 'MAPPED', match_source: 'MANUAL' } });

    const result = await getProductPerformance({ productId: product.id, windowName: 'last7' });
    ok('resolvedVia includes MAPPING', result.resolvedVia.includes('MAPPING'), JSON.stringify(result.resolvedVia));
    ok('campaignIds includes the real mapped campaign', result.meta.campaignIds.includes('fake_campaign_map_1'), JSON.stringify(result.meta.campaignIds));

    // A SUGGESTED (not yet confirmed) mapping must NEVER be treated as real.
    await prisma.ambProductCampaignMap.create({ data: { amb_product_id: ambProduct.id, ad_account_id: 'act_test_perf', campaign_id: 'fake_campaign_suggested_1', status: 'SUGGESTED', match_source: 'AI_SUGGESTED' } });
    const result2 = await getProductPerformance({ productId: product.id, windowName: 'last7' });
    ok('a SUGGESTED (unconfirmed) mapping is never included — only MAPPED rows are real', !result2.meta.campaignIds.includes('fake_campaign_suggested_1'), JSON.stringify(result2.meta.campaignIds));
  }

  console.log('\n§4 Both resolution paths together — deduped, both surfaced honestly:');
  {
    const product = await prisma.product.create({ data: { product_name: '__test_perf_both__', active: true } });
    cleanup.productIds.push(product.id);
    const jobId = `test-perf-both-${Date.now()}`;
    cleanup.jobIds.push(jobId);
    await prisma.ambLaunchJob.create({ data: { job_id: jobId, product_id: product.id, ad_account_id: 'act_test_perf', budget_mode: 'CBO', config_json: '{}', status: 'DRAFT' } });
    await prisma.ambLaunchCampaign.create({ data: { job_id: jobId, index: 0, name: 'Both Test Campaign', status: 'COMPLETE', meta_campaign_id: 'fake_campaign_both_launch' } });
    const ambProduct = await prisma.ambProduct.create({ data: { product_id: product.id, product_name: product.product_name } });
    cleanup.ambProductIds.push(ambProduct.id);
    await prisma.ambProductCampaignMap.create({ data: { amb_product_id: ambProduct.id, ad_account_id: 'act_test_perf', campaign_id: 'fake_campaign_both_mapping', status: 'MAPPED', match_source: 'MANUAL' } });

    const result = await getProductPerformance({ productId: product.id, windowName: 'last7' });
    ok('resolvedVia contains both LAUNCH and MAPPING', result.resolvedVia.includes('LAUNCH') && result.resolvedVia.includes('MAPPING'), JSON.stringify(result.resolvedVia));
    ok('campaignIds contains both real campaign ids', result.meta.campaignIds.includes('fake_campaign_both_launch') && result.meta.campaignIds.includes('fake_campaign_both_mapping'), JSON.stringify(result.meta.campaignIds));
    ok('no duplicate campaign ids', new Set(result.meta.campaignIds).size === result.meta.campaignIds.length);
  }

  console.log('\n§5 MANDATORY multi-store isolation — a product\'s Easy Orders can never leak another store\'s rows:');
  {
    const product = await prisma.product.create({ data: { product_name: '__test_perf_storeA__', active: true, store_id: '__test_store_a_perf__' } });
    cleanup.productIds.push(product.id);
    // Real-world-shaped leak scenario: rows sharing the SAME product_id but
    // tagged to a DIFFERENT store — must be excluded once store_id scoping
    // is applied, exactly as codOrders.js already guarantees.
    for (let i = 0; i < 3; i++) {
      await prisma.easyOrdersOrder.create({ data: { order_id: `perf-a-${product.id}-${i}`, cart_item_id: `ci-a-${i}`, product_id: product.id, date: '2026-09-15', status: 'CONFIRMED', store_id: '__test_store_a_perf__', order_cost: 100 } });
    }
    for (let i = 0; i < 2; i++) {
      await prisma.easyOrdersOrder.create({ data: { order_id: `perf-b-${product.id}-${i}`, cart_item_id: `ci-b-${i}`, product_id: product.id, date: '2026-09-15', status: 'CONFIRMED', store_id: '__test_store_b_perf__', order_cost: 999 } });
    }

    const result = await getProductPerformance({ productId: product.id, windowName: 'last30' });
    ok('only the product\'s OWN store\'s 3 orders are counted, never the other store\'s 2', result.easyOrders.orders === 3, result.easyOrders.orders);
    ok('revenue reflects only the 3 real store-A orders (300), never the store-B leak (999 each)', result.easyOrders.revenue === 300, result.easyOrders.revenue);
    ok('storeId on the dataset is the product\'s real store', result.storeId === '__test_store_a_perf__');
  }
  console.log('\n§ Business Conversion Rate — EXACT formula (Meta Purchase Results × 100 / Landing Page Views), never a substitute metric (formula changed 2026-09-22 from an Easy-Orders-based numerator — see productPerformance.js header):');
  {
    // Test case F re-based on Meta Purchase Results: purchaseResults=70, LPV=1000 -> 7%.
    const r1 = computeBusinessConversionRate({ meta: { dataState: 'AVAILABLE', landingPageViews: 1000, purchaseResults: 70 } });
    ok('purchaseResults=70 / LPV=1000 -> exactly 7%', r1.dataState === 'AVAILABLE' && r1.value === 7, JSON.stringify(r1));
    ok('carries the real numerator/denominator/formula for auditability', r1.resultsNumerator === 70 && r1.lpvDenominator === 1000 && typeof r1.formula === 'string');

    // The worked example from the spec: purchaseResults=60, LPV=1000 -> 6%.
    const r2 = computeBusinessConversionRate({ meta: { dataState: 'AVAILABLE', landingPageViews: 1000, purchaseResults: 60 } });
    ok('purchaseResults=60 / LPV=1000 -> exactly 6%', r2.dataState === 'AVAILABLE' && r2.value === 6, r2.value);

    // LPV missing entirely (Meta block not AVAILABLE) -> UNAVAILABLE, never 0%.
    const r3 = computeBusinessConversionRate({ meta: { dataState: 'META_UNMAPPED', landingPageViews: null, purchaseResults: null } });
    ok('missing LPV -> CONVERSION_RATE_UNAVAILABLE, never a fabricated 0%', r3.dataState === 'CONVERSION_RATE_UNAVAILABLE' && r3.value === null, JSON.stringify(r3));

    // LPV present but zero -> still UNAVAILABLE (can't divide by zero into a meaningful rate).
    const r4 = computeBusinessConversionRate({ meta: { dataState: 'AVAILABLE', landingPageViews: 0, purchaseResults: 5 } });
    ok('LPV=0 -> CONVERSION_RATE_UNAVAILABLE, never a division-by-zero fabrication', r4.dataState === 'CONVERSION_RATE_UNAVAILABLE');

    // No purchase-type-indicator campaign in the window -> UNAVAILABLE, never a fabricated 0%.
    const r5 = computeBusinessConversionRate({ meta: { dataState: 'AVAILABLE', landingPageViews: 1000, purchaseResults: null } });
    ok('no purchase-indicator results -> CONVERSION_RATE_UNAVAILABLE, never 0%', r5.dataState === 'CONVERSION_RATE_UNAVAILABLE' && r5.value === null);

    // Never silently substitutes clicks/raw results for LPV or for purchase-filtered results.
    const r6 = computeBusinessConversionRate({ meta: { dataState: 'AVAILABLE', landingPageViews: null, clicks: 5000, purchaseResults: 60 } });
    ok('a real clicks figure is NEVER substituted for a missing LPV', r6.dataState === 'CONVERSION_RATE_UNAVAILABLE', JSON.stringify(r6));

    // A genuine zero purchase results with real LPV is a real, honest 0% — not "unavailable".
    const r7 = computeBusinessConversionRate({ meta: { dataState: 'AVAILABLE', landingPageViews: 500, purchaseResults: 0 } });
    ok('zero real purchase results against real LPV is an honest 0%, not UNAVAILABLE', r7.dataState === 'AVAILABLE' && r7.value === 0, JSON.stringify(r7));

    // A campaign whose result_indicator is post_engagement (not purchase-type) must contribute 0 to the numerator, never its raw (irrelevant) results count.
    const r8 = computeBusinessConversionRate({ meta: { dataState: 'AVAILABLE', landingPageViews: 100, purchaseResults: 3, hasNonPurchaseResultCampaigns: true } });
    ok('a mix of purchase + non-purchase-indicator campaigns only counts the purchase-type results, and surfaces a note about the exclusion', r8.value === 3 && typeof r8.note === 'string', JSON.stringify(r8));
  }

  console.log('\n§ getProductPerformance — businessConversionRate is bundled into the real dataset call:');
  {
    const p126Result = await getProductPerformance({ productId: 126, windowName: 'last30' });
    ok('businessConversionRate is present on the real dataset response with a valid dataState', ['AVAILABLE', 'CONVERSION_RATE_UNAVAILABLE'].includes(p126Result.businessConversionRate?.dataState), JSON.stringify(p126Result.businessConversionRate));
  }
} finally {
  await cleanupAll();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
