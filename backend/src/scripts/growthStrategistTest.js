// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 4 (Product Growth Strategist / Recovery Plan) verification. Pure
// reads only — this slice adds no new write tool, so there is nothing to
// clean up.
//   node src/scripts/growthStrategistTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { get_growth_plan } = await imp('../services/aiTools.js');

const VALID_BOTTLENECK = ['CREATIVE_PROBLEM', 'CREATIVE_FATIGUE', 'TRAFFIC_PROBLEM', 'CONVERSION_PROBLEM', 'OFFER_PROBLEM', 'CPA_PROBLEM', 'CONFIRMATION_PROBLEM', 'DELIVERY_PROBLEM', 'TRACKING_MAPPING_PROBLEM', 'INSUFFICIENT_DATA', 'HEALTHY_PRODUCT', 'PROFIT_PROBLEM'];

console.log('§1 Real reads — get_growth_plan across real products:');
{
  const ambProducts = await prisma.ambProduct.findMany({ take: 15, orderBy: { id: 'desc' }, select: { product_id: true, product_name: true } });
  let checked = 0, sawProfitOverride = 0;
  for (const ap of ambProducts) {
    if (!ap.product_id) continue;
    const out = await get_growth_plan({ productId: ap.product_id, window: 'last7' });
    if (!out.ok || !out.hasData) continue;
    checked++;
    ok(`${ap.product_name} has a valid primaryBottleneck category`, VALID_BOTTLENECK.includes(out.primaryBottleneck?.category), out.primaryBottleneck?.category);
    ok(`${ap.product_name} hypothesis is NEVER the raw bottleneck evidence string (evidence-vs-hypothesis separation)`, out.hypothesis !== out.primaryBottleneck?.evidence || out.primaryBottleneck?.evidence == null, JSON.stringify({ hyp: out.hypothesis, ev: out.primaryBottleneck?.evidence }));
    ok(`${ap.product_name} evidence is a real array (never fabricated single string)`, Array.isArray(out.evidence));
    ok(`${ap.product_name} currentState carries a real decision + profitState`, typeof out.currentState?.decision === 'string' && (out.currentState.profitState === null || typeof out.currentState.profitState === 'string'));
    ok(`${ap.product_name} successMetric/evaluationWindowDays are real`, typeof out.evaluationWindowDays === 'number' && out.evaluationWindowDays > 0);
    if (out.primaryBottleneck?.category === 'PROFIT_PROBLEM') {
      sawProfitOverride++;
      ok(`${ap.product_name} PROFIT_PROBLEM only fires when the ad-funnel itself is healthy`, out.primaryBottleneck.evidence.includes('القمع الإعلاني نفسه سليم'));
    }
    // If the bottleneck implicates a real dimension, whatShouldRemainUnchanged must never ALSO list that same dimension.
    const implicated = out.controlledTestDesign?.variableChanged;
    if (implicated) ok(`${ap.product_name} whatShouldRemainUnchanged never contradicts the implicated test dimension`, !out.whatShouldRemainUnchanged.includes(implicated), JSON.stringify({ implicated, unchanged: out.whatShouldRemainUnchanged }));
  }
  ok('checked at least one real product', checked > 0, `checked=${checked}`);
  console.log(`  checked ${checked} products — ${sawProfitOverride} PROFIT_PROBLEM overrides seen.`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
