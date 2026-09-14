// Phase 1 Hook/Selling-Angle Intelligence, scoped per product. Zero real
// Meta calls, zero DB writes — mocks prisma.ambCreativeAnalysis.findMany
// (the only DB read in this path, via creativeLabelIndex) and
// hierarchyAnalysis.js's buildHierarchy (via a monkeypatched module import
// is not possible for ESM without a loader, so instead we test
// scopedAdsForProduct as a pure function against a hand-built fake tree,
// and hookAndAngleIntelForProduct end-to-end against a REAL buildHierarchy
// call is deliberately NOT exercised here — that full integration is
// covered when productMarketing.js's own integration test wires everything
// together in Phase E.
//   node src/scripts/productMarketingWinnerIntelTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { scopedAdsForProduct } = await import(pathToFileURL(join(__dirname, '../services/amb/productMarketingWinnerIntel.js')).href);

console.log('§1 scopedAdsForProduct — pure function over a hand-built tree, no mocking needed:');
{
  const fakeTree = {
    products: [
      {
        id: '48', name: 'جهاز قياس الضغط',
        children: [
          {
            level: 'campaign', id: 'c1', name: 'Campaign A',
            children: [
              {
                level: 'adset', id: 'as1', name: 'AdSet A1',
                children: [
                  { level: 'ad', id: 'ad1', name: 'Ad 1', creativeId: 'cr1', metrics: { spend: 500, purchases: 10 } },
                  { level: 'ad', id: 'ad2', name: 'Ad 2', creativeId: 'cr2', metrics: { spend: 100, purchases: 1 } },
                ],
              },
            ],
          },
        ],
      },
      { id: '99', name: 'منتج آخر', children: [{ level: 'campaign', id: 'c2', name: 'Other Campaign', children: [] }] },
    ],
    unmappedCampaigns: [],
  };

  const ads = scopedAdsForProduct(fakeTree, 48);
  ok('returns exactly the 2 ads under product 48', ads.length === 2, JSON.stringify(ads.map((a) => a.id)));
  ok('each ad is enriched with productName/ambProductId/campaignName/adsetName', ads[0].productName === 'جهاز قياس الضغط' && ads[0].ambProductId === 48 && ads[0].campaignName === 'Campaign A' && ads[0].adsetName === 'AdSet A1', JSON.stringify(ads[0]));
  ok('original ad fields (id, creativeId, metrics) are preserved', ads[0].id === 'ad1' && ads[0].creativeId === 'cr1' && ads[0].metrics.spend === 500);

  const adsForOther = scopedAdsForProduct(fakeTree, 99);
  ok('product 99 has no ad-level children -> empty array, not a crash', adsForOther.length === 0, JSON.stringify(adsForOther));

  const adsForUnknown = scopedAdsForProduct(fakeTree, 12345);
  ok('unknown ambProductId -> empty array, never throws', adsForUnknown.length === 0);

  const adsForEmptyTree = scopedAdsForProduct({}, 48);
  ok('empty/malformed tree -> empty array, never throws', adsForEmptyTree.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
