// READ-ONLY dry run for the simplified "Duplicate campaigns to another ad
// account" flow. Calls analyzeClone() — no Meta writes, source untouched.
//   node src/scripts/cloneDryRun.js
import 'dotenv/config';
import { analyzeClone } from '../services/amb/cloneAnalysis.js';
import { getAccountIdentities, getAccountAssetsForClone, getAllAccessibleAdAccounts } from '../services/metaGraphClient.js';
import { getDecryptedToken } from '../services/metaAuth.js';

const SOURCE = 'act_1688438875190730';      // Rosy Dose
const DEST = 'act_874732772237565';         // Eimo
const DEST_PAGE = '1258315710689452';       // Rosy Dose Page assigned to Eimo
const CAMPAIGNS = ['120248477396130714', '120248368642840714']; // Heating-Belt - Test Ai - Scale - 2 / Heating-Belt - SCale (1)

function line(s = '') { process.stdout.write(s + '\n'); }

const res = await analyzeClone({
  sourceAccountId: SOURCE,
  destinationAccountIds: [DEST],
  campaignIds: CAMPAIGNS,
  destinationPageId: DEST_PAGE,
  allowPageOnlyIg: true,
});

line('================ DRY RUN — READ ONLY (no Meta writes) ================');
line(`Source:      ${res.source.name} (${res.source.id})`);
line(`Destination: ${res.destinations.map((d) => `${d.name} (${d.id})`).join(', ')}`);
line('');
line('OVERALL: ' + JSON.stringify(res.overallCopySummary));
line('');

for (const c of res.campaigns) {
  line('------------------------------------------------------------');
  line(`CAMPAIGN: ${c.campaignName}  [${c.campaignId}]`);
  if (c.error) { line(`  READ ERROR: ${c.error}`); continue; }
  line(`  objective=${c.objective}  buyingType=${c.buyingType}  budgetMode=${c.budgetMode}`);
  line(`  adSets=${c.adSetCount}  ads=${c.adCount}`);
  line(`  copyStatus=${c.copyStatus}  canCopyCompletely=${c.canCopyCompletely}`);
  line(`  copySummary=${JSON.stringify(c.copySummary)}`);
  line(`  identityRequired.pages=${JSON.stringify(c.identityRequired.pages)}  instagram=${JSON.stringify(c.identityRequired.instagram)}`);
  line(`  pixelRequired=${JSON.stringify(c.pixelRequired)}`);
  line(`  destinationPixels=${JSON.stringify((c.destinationPixels || []).map((p) => ({ id: p.id, name: p.name })))}`);
  line(`  destinationIdentities.pages=${JSON.stringify((c.destinationIdentities.pages || []).map((p) => ({ id: p.id, name: p.name, source: p.source, verified: p.verified })))}`);
  line(`  destinationIdentities.instagram=${JSON.stringify(c.destinationIdentities.instagram || [])}`);
  line('  ADS:');
  for (const ad of c.ads) {
    line(`   - ${ad.adName}  [${ad.adId}]`);
    line(`       copyStatus=${ad.copyStatus}  assetAction=${ad.assetAction}  transferMode=${ad.transferMode}  readiness=${ad.readiness}`);
    line(`       format=${ad.normalized?.format}  img=${ad.normalized?.imageCount}  vid=${ad.normalized?.videoCount}  carousel=${ad.normalized?.carouselCards}  hasOSS=${ad.normalized?.hasObjectStorySpec}  objectStoryId=${ad.normalized?.objectStoryId || '-'}`);
    line(`       cta=${ad.normalized?.ctaType || '-'}  url=${ad.normalized?.destinationUrl || '-'}`);
    line(`       identity: page=${ad.identity?.destPageId || '-'} [${ad.identity?.pageStatus}]  ig=${ad.identity?.destInstagramId || '-'} [${ad.identity?.igStatus}]`);
    line(`       pixel: src=${ad.pixel?.sourcePixelId || '-'}  dest=${ad.pixel?.destPixelId || '-'} [${ad.pixel?.status}]  event=${ad.pixel?.customEventType || '-'}`);
    line(`       media.images=${JSON.stringify(ad.media?.images)}`);
    line(`       media.videos=${JSON.stringify(ad.media?.videos)}`);
    line(`       conversionDomain=${JSON.stringify(ad.conversionDomain)}`);
    if (ad.copyReasons?.length) for (const r of ad.copyReasons) line(`       reason: ${r}`);
    for (const ck of ad.checks || []) line(`       check[${ck.level}] ${ck.field}: ${ck.detail}`);
  }
}

// Extra: what is already shared between Rosy Dose and Eimo?
line('');
line('================ SHARED-RESOURCE PROBE (Rosy Dose ↔ Eimo) ================');
const token = await getDecryptedToken();
const accts = await getAllAccessibleAdAccounts(token);
const byId = new Map(accts.map((a) => [a.id, a]));
line(`Source acct: currency=${byId.get(SOURCE)?.currency}  tz=${byId.get(SOURCE)?.timezoneName}`);
line(`Dest acct:   currency=${byId.get(DEST)?.currency}  tz=${byId.get(DEST)?.timezoneName}`);
const [srcId, dstId] = await Promise.all([getAccountIdentities(token, SOURCE), getAccountIdentities(token, DEST)]);
const [srcAssets, dstAssets] = await Promise.all([getAccountAssetsForClone(token, SOURCE), getAccountAssetsForClone(token, DEST)]);
line(`Source pages:      ${JSON.stringify(srcId.pages.map((p) => ({ id: p.id, name: p.name })))}`);
line(`Dest pages:        ${JSON.stringify(dstId.pages.map((p) => ({ id: p.id, name: p.name })))}`);
line(`Source instagram:  ${JSON.stringify(srcId.instagram)}`);
line(`Dest instagram:    ${JSON.stringify(dstId.instagram)}`);
line(`Source pixels:     ${JSON.stringify((srcAssets.pixels || []).map((p) => ({ id: p.id, name: p.name })))}`);
line(`Dest pixels:       ${JSON.stringify((dstAssets.pixels || []).map((p) => ({ id: p.id, name: p.name })))}`);
const srcPx = new Set((srcAssets.pixels || []).map((p) => String(p.id)));
const shared = (dstAssets.pixels || []).filter((p) => srcPx.has(String(p.id)));
line(`SHARED pixels:     ${JSON.stringify(shared.map((p) => ({ id: p.id, name: p.name })))}`);
const srcPg = new Set(srcId.pages.map((p) => String(p.id)));
line(`SHARED pages:      ${JSON.stringify(dstId.pages.filter((p) => srcPg.has(String(p.id))).map((p) => ({ id: p.id, name: p.name })))}`);

line('');
line('DONE — nothing was written to Meta.');
process.exit(0);
