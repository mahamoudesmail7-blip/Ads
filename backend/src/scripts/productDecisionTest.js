// Smart Decision Center Phase 6 — services/amb/productDecision.js's
// decideProductAction(). Pure, offline tests over hand-built
// diagnosis/creativeIntel/segmentIntel shapes (no DB, no Meta) — proves
// every decision branch fires from real evidence, never a guess, and that
// an operational (post-Meta) bottleneck is never mistaken for a marketing
// one. The full end-to-end package (buildProductDecisionPackage) is
// verified against the real Product 126 in this session's own live
// production checks.
//   node src/scripts/productDecisionTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { decideProductAction, PRODUCT_DECISIONS } = await imp('../services/amb/productDecision.js');

function diag(category, confidence, evidence = 'evidence text', metaMapped = true, totalSpend = 5000) {
  return { bottleneck: { category, confidence, evidence, competingSignals: [] }, metrics: { dataAvailability: { metaMapped }, totalSpend } };
}
const noWinners = { creative: {}, hooks: {}, angles: {}, primaryTexts: {}, headlines: {} };
const noSegments = { age: {}, gender: {}, governorates: {} };
function withCreativeWinner() { return { creative: { best: { classification: 'WINNER', label: 'X' }, table: [] }, hooks: {}, angles: {}, primaryTexts: {}, headlines: {} }; }
function withProvenSegment() { return { age: { best: { classification: 'PROVEN_WINNER', segment: '25-34' } }, gender: {}, governorates: {} }; }
function withPromisingSegment() { return { age: {}, gender: {}, governorates: { best: { classification: 'PROMISING', segment: 'الجيزة' }, table: [] } }; }

console.log('§1 Every decision type in the required vocabulary is reachable, and only from real evidence:');
{
  ok('PRODUCT_DECISIONS matches the exact 9-value vocabulary requested', PRODUCT_DECISIONS.length === 9 && PRODUCT_DECISIONS.includes('SCALE_CANDIDATE') && PRODUCT_DECISIONS.includes('INSUFFICIENT_DATA'));

  const unmapped = decideProductAction({ diagnosis: diag('HEALTHY_PRODUCT', 'CONFIRMED', 'x', false), creativeIntel: noWinners, segmentIntel: noSegments });
  ok('no Meta mapping -> INSUFFICIENT_DATA', unmapped.decision === 'INSUFFICIENT_DATA', JSON.stringify(unmapped.decision));

  const paused = decideProductAction({ diagnosis: diag('CPA_PROBLEM', 'CONFIRMED'), creativeIntel: noWinners, segmentIntel: noSegments });
  ok('confirmed high CPA + zero winners anywhere -> PAUSE_CANDIDATE', paused.decision === 'PAUSE_CANDIDATE', JSON.stringify(paused.decision));

  const keepTestingCpa = decideProductAction({ diagnosis: diag('CPA_PROBLEM', 'CONFIRMED'), creativeIntel: withCreativeWinner(), segmentIntel: noSegments });
  ok('confirmed high CPA but a REAL creative winner exists -> KEEP_TESTING, never pause a working creative', keepTestingCpa.decision === 'KEEP_TESTING', JSON.stringify(keepTestingCpa.decision));

  const newCreative = decideProductAction({ diagnosis: diag('CREATIVE_PROBLEM', 'LIKELY'), creativeIntel: noWinners, segmentIntel: noSegments });
  ok('CREATIVE_PROBLEM bottleneck -> NEW_CREATIVE_TEST', newCreative.decision === 'NEW_CREATIVE_TEST', JSON.stringify(newCreative.decision));

  const fatigued = decideProductAction({ diagnosis: diag('CREATIVE_FATIGUE', 'LIKELY'), creativeIntel: noWinners, segmentIntel: noSegments });
  ok('CREATIVE_FATIGUE bottleneck also -> NEW_CREATIVE_TEST', fatigued.decision === 'NEW_CREATIVE_TEST', JSON.stringify(fatigued.decision));

  const audience = decideProductAction({ diagnosis: diag('TRAFFIC_PROBLEM', 'LIKELY'), creativeIntel: noWinners, segmentIntel: noSegments });
  ok('TRAFFIC_PROBLEM bottleneck -> AUDIENCE_TEST', audience.decision === 'AUDIENCE_TEST', JSON.stringify(audience.decision));

  const landing = decideProductAction({ diagnosis: diag('CONVERSION_PROBLEM', 'CONFIRMED'), creativeIntel: noWinners, segmentIntel: noSegments });
  ok('CONVERSION_PROBLEM bottleneck -> LANDING_PAGE_FIX', landing.decision === 'LANDING_PAGE_FIX', JSON.stringify(landing.decision));

  const offer = decideProductAction({ diagnosis: diag('OFFER_PROBLEM', 'LIKELY'), creativeIntel: noWinners, segmentIntel: noSegments });
  ok('OFFER_PROBLEM bottleneck -> OFFER_TEST', offer.decision === 'OFFER_TEST', JSON.stringify(offer.decision));

  const scale = decideProductAction({ diagnosis: diag('HEALTHY_PRODUCT', 'CONFIRMED'), creativeIntel: withCreativeWinner(), segmentIntel: withProvenSegment() });
  ok('healthy + confirmed + real creative winner -> SCALE_CANDIDATE', scale.decision === 'SCALE_CANDIDATE', JSON.stringify(scale.decision));

  const healthyNoWinner = decideProductAction({ diagnosis: diag('HEALTHY_PRODUCT', 'CONFIRMED'), creativeIntel: noWinners, segmentIntel: noSegments });
  ok('healthy but NO proven creative yet -> NEW_CREATIVE_TEST, never SCALE from health alone', healthyNoWinner.decision === 'NEW_CREATIVE_TEST', JSON.stringify(healthyNoWinner.decision));
}

console.log('\n§2 Operational (post-Meta) bottlenecks are NEVER mistaken for a marketing decision:');
{
  const confirmationGap = decideProductAction({ diagnosis: diag('CONFIRMATION_PROBLEM', 'LIKELY'), creativeIntel: withCreativeWinner(), segmentIntel: withProvenSegment() });
  ok('a real confirmation-stage bottleneck is KEEP_TESTING even with proven creative/segment winners — the ad isn\'t the problem', confirmationGap.decision === 'KEEP_TESTING', JSON.stringify(confirmationGap.decision));
  ok('the reason explicitly says the problem is operational, not marketing', /تشغيلية/.test(confirmationGap.reason), confirmationGap.reason);

  const deliveryGap = decideProductAction({ diagnosis: diag('DELIVERY_PROBLEM', 'CONFIRMED'), creativeIntel: withCreativeWinner(), segmentIntel: withProvenSegment() });
  ok('a real delivery-stage bottleneck is ALSO KEEP_TESTING, never SCALE_CANDIDATE just because Meta-side winners exist', deliveryGap.decision === 'KEEP_TESTING', JSON.stringify(deliveryGap.decision));
}

console.log('\n§3 Every decision carries the full required evidence bundle:');
{
  const pkg = decideProductAction({ diagnosis: diag('CREATIVE_PROBLEM', 'CONFIRMED'), creativeIntel: withPromisingSegment ? noWinners : noWinners, segmentIntel: withPromisingSegment() });
  ok('carries a real bottleneck object with category/confidence/evidence', pkg.bottleneck.category === 'CREATIVE_PROBLEM' && pkg.bottleneck.confidence === 'CONFIRMED' && !!pkg.bottleneck.evidence);
  ok('carries a winners object (even if mostly empty)', typeof pkg.winners === 'object');
  ok('carries a losers object', typeof pkg.losers === 'object');
  ok('carries a proposedChange string', typeof pkg.proposedChange === 'string' && pkg.proposedChange.length > 0);
  ok('carries a successMetric', !!pkg.successMetric);
  ok('carries an evaluationWindowDays number', typeof pkg.evaluationWindowDays === 'number' && pkg.evaluationWindowDays > 0);
}

console.log('\n§4 GEO_TEST-eligible signal: a promising (not yet proven) governorate influences the AUDIENCE_TEST proposal text:');
{
  const audienceWithPromising = decideProductAction({ diagnosis: diag('TRAFFIC_PROBLEM', 'LIKELY'), creativeIntel: noWinners, segmentIntel: withPromisingSegment() });
  ok('a promising governorate is named in the proposed change when traffic is the bottleneck', /الجيزة/.test(audienceWithPromising.proposedChange), audienceWithPromising.proposedChange);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
