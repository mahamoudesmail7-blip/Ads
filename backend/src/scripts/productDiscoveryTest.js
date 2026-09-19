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
