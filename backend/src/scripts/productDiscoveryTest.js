// Smart Decision Center UX overhaul — services/amb/productDiscovery.js.
// Runs against real production data (no throwaway rows needed — this file
// is pure read/aggregation) and asserts real, previously-confirmed facts
// about Product 126/90 rather than fabricated expectations.
//   node src/scripts/productDiscoveryTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { listSmartDecisionProducts, decisionFilterBucket } = await imp('../services/amb/productDiscovery.js');

console.log('§1 listSmartDecisionProducts — never the raw 400+ SKU catalog, only products with a real signal:');
{
  const cards = await listSmartDecisionProducts({});
  ok('returns a bounded, signal-based list (well under the full 461-row catalog)', cards.length > 0 && cards.length < 400, cards.length);
  ok('every card has a real productId and productName, never a placeholder', cards.every((c) => Number.isInteger(c.productId) && typeof c.productName === 'string' && c.productName.length > 0));

  const p126 = cards.find((c) => c.productId === 126);
  ok('Product 126 (known real, mapped, previously-analyzed product) is discovered', Boolean(p126), JSON.stringify(p126));
  if (p126) {
    ok('126 shows real mapped campaigns (> 0), never zero for a known-mapped product', p126.mappedCampaigns > 0, p126.mappedCampaigns);
    ok('126 shows a real spend/CPA figure, not null, since it has real Meta data', p126.spend > 0 && p126.cpa > 0, JSON.stringify({ spend: p126.spend, cpa: p126.cpa }));
    ok('126 shows a real health score from its persisted decision', typeof p126.healthScore === 'number');
    ok('126\'s decisionStatus is a recognized Smart Decision Center state, not UNMAPPED', p126.decisionStatus !== 'UNMAPPED', p126.decisionStatus);
  }

  const p90 = cards.find((c) => c.productId === 90);
  ok('Product 90 (known real product with zero resolvable campaigns) is discovered as UNMAPPED, never fabricated numbers', Boolean(p90) && p90.decisionStatus === 'UNMAPPED' && p90.spend === null && p90.cpa === null, JSON.stringify(p90));

  ok('every card carries a resolvable filterBucket, never undefined', cards.every((c) => typeof c.filterBucket === 'string' && c.filterBucket.length > 0));

  console.log('  (real production audit — 165-product screen breakdown, never guessed):');
  const byStatus = {};
  for (const c of cards) byStatus[c.decisionStatus] = (byStatus[c.decisionStatus] || 0) + 1;
  console.log('  ', JSON.stringify(byStatus));

  ok('every card exposes a non-null `reason` string — Phase 6/7: never an unexplained "--" field', cards.every((c) => typeof c.reason === 'string' && c.reason.length > 0), cards.filter((c) => !c.reason).length);

  console.log('\n§3 CRITICAL FIX — unmapped products are no longer one undifferentiated bucket: a product with REAL Easy Orders but no campaign mapping is EASY_ORDERS_ONLY, never lumped in with a product that has genuinely nothing:');
  const eoOnly = cards.find((c) => c.decisionStatus === 'EASY_ORDERS_ONLY');
  ok('at least one real product in this account is EASY_ORDERS_ONLY (has real orders, no mapping)', Boolean(eoOnly), JSON.stringify(eoOnly));
  if (eoOnly) {
    ok('its reason cites the REAL order count, never a placeholder', new RegExp(`${eoOnly.orders} Easy Orders`).test(eoOnly.reason), eoOnly.reason);
    ok('it carries a real actionable next step', eoOnly.action === '🔗 مراجعة ربط الحملات');
    ok('it still filters into the same "unmapped" bucket as a fully-unmapped product (same tab, different card explanation)', decisionFilterBucket(eoOnly.decisionStatus) === 'unmapped');
  }
  const trulyUnmapped = cards.find((c) => c.decisionStatus === 'UNMAPPED');
  if (trulyUnmapped) {
    ok('a genuinely inactive product (no mapping, no orders) gets the honest "no real activity" reason, never claims orders it does not have', !/Easy Orders/.test(trulyUnmapped.reason) || /لا توجد/.test(trulyUnmapped.reason), trulyUnmapped.reason);
  }

  console.log('\n§4 decisionFilterBucket now also covers the new EASY_ORDERS_ONLY/NO_AD_SPEND states:');
  ok('EASY_ORDERS_ONLY -> unmapped (same tab as UNMAPPED, distinguished by its own card reason)', decisionFilterBucket('EASY_ORDERS_ONLY') === 'unmapped');
  ok('NO_AD_SPEND -> insufficientData', decisionFilterBucket('NO_AD_SPEND') === 'insufficientData');
}

console.log('\n§2 decisionFilterBucket — pure vocabulary mapping, exhaustive over every real PRODUCT_DECISIONS + operational value:');
{
  ok('UNMAPPED -> unmapped', decisionFilterBucket('UNMAPPED') === 'unmapped');
  ok('NEEDS_MAPPING_REVIEW -> needsReview', decisionFilterBucket('NEEDS_MAPPING_REVIEW') === 'needsReview');
  ok('PENDING_ANALYSIS -> insufficientData', decisionFilterBucket('PENDING_ANALYSIS') === 'insufficientData');
  ok('SCALE_CANDIDATE -> scale', decisionFilterBucket('SCALE_CANDIDATE') === 'scale');
  ok('NEW_CREATIVE_TEST -> needsCreative', decisionFilterBucket('NEW_CREATIVE_TEST') === 'needsCreative');
  ok('LANDING_PAGE_FIX -> needsImprovement', decisionFilterBucket('LANDING_PAGE_FIX') === 'needsImprovement');
  ok('OFFER_TEST -> needsImprovement', decisionFilterBucket('OFFER_TEST') === 'needsImprovement');
  ok('KEEP_TESTING -> testing', decisionFilterBucket('KEEP_TESTING') === 'testing');
  ok('AUDIENCE_TEST -> testing', decisionFilterBucket('AUDIENCE_TEST') === 'testing');
  ok('GEO_TEST -> testing', decisionFilterBucket('GEO_TEST') === 'testing');
  ok('PAUSE_CANDIDATE -> pauseCandidate', decisionFilterBucket('PAUSE_CANDIDATE') === 'pauseCandidate');
  ok('MEASURING -> measuring', decisionFilterBucket('MEASURING') === 'measuring');
  ok('an unrecognized value falls back to ready rather than crashing', decisionFilterBucket('SOMETHING_NEW') === 'ready');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
