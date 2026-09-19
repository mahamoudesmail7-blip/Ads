// Smart Decision Center Phase 4 — services/amb/segmentIntel.js. Pure,
// offline tests for the two classifiers plus the MANDATORY guardrail: a
// segment is never called weak just for having fewer raw orders than
// another — under-exposed segments are always INSUFFICIENT_DATA.
//   node src/scripts/segmentIntelTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { classifyMetaSegment, classifyCodSegment } = await imp('../services/amb/segmentIntel.js');

const GATE = { targetCpa: 120, minSpend: 150, minPurchases: 5 };

console.log('§1 classifyCodSegment — the MANDATORY guardrail: low order count is NEVER "weak", always INSUFFICIENT_DATA:');
{
  // The exact real-world example from the standing project rule.
  const cairo = classifyCodSegment({ orders: 20, confirmed: 15, delivered: 12 }, { minOrders: 10 });
  const minya = classifyCodSegment({ orders: 1, confirmed: 0, delivered: 0 }, { minOrders: 10 });
  ok('Cairo (20 orders, real evidence) is classified normally, not blocked', cairo.classification !== 'INSUFFICIENT_DATA' || cairo.classification === 'PROMISING', JSON.stringify(cairo));
  ok('Minya (1 order) is INSUFFICIENT_DATA — NEVER PROVEN_WEAK just for having almost no orders', minya.classification === 'INSUFFICIENT_DATA', JSON.stringify(minya));
  ok('Minya\'s evidence explicitly says the sample is too small, never implies it performed badly', /أقل من الحد الأدنى/.test(minya.evidence), minya.evidence);

  const alexandria = classifyCodSegment({ orders: 2, confirmed: 0, delivered: 0 }, { minOrders: 10 });
  ok('a tiny 2-order segment is also INSUFFICIENT_DATA, not compared against Cairo\'s absolute count at all', alexandria.classification === 'INSUFFICIENT_DATA');
}

console.log('\n§2 classifyCodSegment — PROVEN_WEAK requires REAL negative evidence at a SUFFICIENT sample, never just low volume:');
{
  const genuinelyBad = classifyCodSegment({ orders: 30, confirmed: 25, delivered: 3 }, { minOrders: 10 });
  ok('30 orders with a genuinely terrible 12% delivery rate is PROVEN_WEAK — real evidence, real sample', genuinelyBad.classification === 'PROVEN_WEAK', JSON.stringify(genuinelyBad));

  const genuinelyGood = classifyCodSegment({ orders: 25, confirmed: 20, delivered: 15 }, { minOrders: 10 });
  ok('25 orders with a strong 75% delivery rate is PROVEN_WINNER', genuinelyGood.classification === 'PROVEN_WINNER', JSON.stringify(genuinelyGood));

  const borderline = classifyCodSegment({ orders: 12, confirmed: 8, delivered: 4 }, { minOrders: 10 });
  ok('borderline sample just above the minimum with a moderate rate is PROMISING, not yet PROVEN', borderline.classification === 'PROMISING', JSON.stringify(borderline));
}

console.log('\n§3 classifyMetaSegment — a low CPA from a tiny spend is never a winner (same discipline as Phase 3):');
{
  const tiny = classifyMetaSegment({ spend: 20, purchases: 1, cpa: 15 }, GATE);
  ok('tiny spend + suspiciously cheap CPA is INSUFFICIENT_DATA, never PROVEN_WINNER', tiny.classification === 'INSUFFICIENT_DATA', JSON.stringify(tiny));

  const realWinner = classifyMetaSegment({ spend: 5000, purchases: 50, cpa: 85 }, GATE);
  ok('real spend + real sample + cheap CPA is PROVEN_WINNER', realWinner.classification === 'PROVEN_WINNER', JSON.stringify(realWinner));

  const realWeak = classifyMetaSegment({ spend: 4000, purchases: 20, cpa: 400 }, GATE);
  ok('real spend + real sample + genuinely bad CPA is PROVEN_WEAK', realWeak.classification === 'PROVEN_WEAK', JSON.stringify(realWeak));
}

console.log('\n§4 classifyMetaSegment — exposure gate runs before any ratio math, exactly like Phase 3:');
{
  const zeroPurchases = classifyMetaSegment({ spend: 1000, purchases: 0, cpa: null }, GATE);
  ok('zero purchases is INSUFFICIENT_DATA regardless of spend', zeroPurchases.classification === 'INSUFFICIENT_DATA');
}

console.log('\n§5 classifyCodSegment — a SECOND guardrail: never blame one governorate for a product-wide confirmation backlog:');
{
  // The exact real scenario found while testing Product 126: near-zero
  // confirmation EVERYWHERE (a fresh order batch, not yet called), and a
  // governorate with a real, meaningful sample also showing 0% confirmed —
  // without this guardrail it would wrongly look PROVEN_WEAK.
  const cairoDuringBacklog = classifyCodSegment({ orders: 138, confirmed: 0, delivered: 0 }, { minOrders: 10, globalConfirmationRate: 0.002 });
  ok('a governorate with 0% confirmation is NOT proven_weak when the WHOLE product is stalled (systemic backlog)', cairoDuringBacklog.classification === 'INSUFFICIENT_DATA', JSON.stringify(cairoDuringBacklog));
  ok('the evidence explicitly names it as a product-wide issue, not this governorate\'s fault', /تراكم عام/.test(cairoDuringBacklog.evidence), cairoDuringBacklog.evidence);

  // The SAME governorate, SAME numbers, but the product overall confirms
  // normally — NOW a real 0% confirmation rate for just this one
  // governorate genuinely is meaningful evidence of a real problem.
  const cairoNormalConfirmation = classifyCodSegment({ orders: 138, confirmed: 0, delivered: 0 }, { minOrders: 10, globalConfirmationRate: 0.6 });
  ok('the SAME 0%-confirmed governorate IS proven_weak once we know confirmation works fine elsewhere on this product', cairoNormalConfirmation.classification === 'PROVEN_WEAK', JSON.stringify(cairoNormalConfirmation));

  // A genuinely bad DELIVERY rate is never suppressed by the backlog guard — confirmation and delivery are different funnel stages.
  const badDeliveryDuringBacklog = classifyCodSegment({ orders: 30, confirmed: 25, delivered: 3 }, { minOrders: 10, globalConfirmationRate: 0.05 });
  ok('a genuinely bad DELIVERY rate still reaches PROVEN_WEAK even during a product-wide confirmation backlog — different funnel stage, real evidence', badDeliveryDuringBacklog.classification === 'PROVEN_WEAK', JSON.stringify(badDeliveryDuringBacklog));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
