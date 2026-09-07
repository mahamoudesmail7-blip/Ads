// STEP 4 — DRY RUN (read-only) for ahmed samy -> Hady on a SAMPLE of campaigns.
// analyzeClone() only. No writes. Source untouched.
//   node src/scripts/cloneDryRunNewSetup.js
import 'dotenv/config';
import { analyzeClone } from '../services/amb/cloneAnalysis.js';

const SRC = 'act_1518142859790043';   // Ahmed Samy
const DST = 'act_877011384919552';    // Hady
// A representative sample (PAUSED "Test" campaigns + a couple of "scale" ones).
const SAMPLE = [
  '120249581983550205', // Laptop Stand - Test (PAUSED)
  '120249579979880205', // iphone - Test (PAUSED)
  '120249579131760205', // Translate-Earbuds - Test (PAUSED)
  '120252251185040205', // Neck Stretch _ scale 1 (PAUSED)
  '120252226587010205', // Hair-Remover _ scale 1 (PAUSED)
];
const P = (s = '') => process.stdout.write(s + '\n');

// No destination Page is passable (Hady has none) — run with what we have so
// the classifier shows exactly what input is missing.
const res = await analyzeClone({
  sourceAccountId: SRC,
  destinationAccountIds: [DST],
  campaignIds: SAMPLE,
  allowPageOnlyIg: true,
});

P('================ DRY RUN (SAMPLE) — ahmed samy → Hady — READ ONLY ================');
P(`Source: ${res.source.name} (${res.source.id})`);
P(`Dest:   ${res.destinations.map((d) => d.name + ' (' + d.id + ')').join(', ')}`);
P('OVERALL: ' + JSON.stringify(res.overallCopySummary));
P('');
for (const c of res.campaigns) {
  P('------------------------------------------------------------');
  P(`CAMPAIGN: ${c.campaignName} [${c.campaignId}]`);
  if (c.error) { P(`  READ ERROR: ${c.error}`); continue; }
  P(`  objective=${c.objective} buyingType=${c.buyingType} budgetMode=${c.budgetMode} adSets=${c.adSetCount} ads=${c.adCount}`);
  P(`  campaign copyStatus=${c.copyStatus}  canCopyCompletely=${c.canCopyCompletely}  copySummary=${JSON.stringify(c.copySummary)}`);
  P(`  identityRequired.pages=${JSON.stringify(c.identityRequired.pages)}  instagram=${JSON.stringify(c.identityRequired.instagram)}`);
  P(`  pixelRequired=${JSON.stringify(c.pixelRequired)}`);
  P(`  destinationPixels=${JSON.stringify((c.destinationPixels || []).map((p) => p.id + ':' + p.name))}`);
  P(`  destPages=${JSON.stringify((c.destinationIdentities.pages || []).map((p) => p.id))}  destIg=${JSON.stringify(c.destinationIdentities.instagram || [])}`);
  for (const ad of c.ads) {
    P(`   - ${ad.adName} [${ad.adId}]  ${ad.normalized?.format}  copyStatus=${ad.copyStatus}  assetAction=${ad.assetAction}`);
    P(`       page[${ad.identity?.pageStatus}] ig[${ad.identity?.igStatus}]  pixel src=${ad.pixel?.sourcePixelId || '-'} dest=${ad.pixel?.destPixelId || '-'} [${ad.pixel?.status}]`);
    P(`       cta=${ad.normalized?.ctaType || '-'}  url=${ad.normalized?.destinationUrl || '-'}  img=${ad.normalized?.imageCount} vid=${ad.normalized?.videoCount}`);
    for (const r of ad.copyReasons || []) P(`       reason: ${r}`);
  }
}
P('');
P('================ CLASSIFICATION ================');
let ready = 0; let needsInput = 0; let cannot = 0;
for (const c of res.campaigns) {
  const cls = c.copyStatus === 'READY' ? 'READY TO COPY' : c.copyStatus === 'NEEDS_MAPPING' ? 'NEEDS USER INPUT' : 'CANNOT COPY';
  if (cls === 'READY TO COPY') ready++; else if (cls === 'NEEDS USER INPUT') needsInput++; else cannot++;
  P(`  ${c.campaignName}: ${cls}  (ads ready ${c.copySummary.ready}/${c.copySummary.totalAds}, needs ${c.copySummary.needsMapping}, cannot ${c.copySummary.cannotCopy})`);
}
P(`\nSAMPLE totals — READY TO COPY: ${ready}  NEEDS USER INPUT: ${needsInput}  CANNOT COPY: ${cannot}  (of ${res.campaigns.length} sampled)`);
P('\nDONE — nothing written to Meta.');
process.exit(0);
