// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 11 (Scale Ladder) verification. Pure reads only.
//   node src/scripts/scaleLadderTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { resolveScaleLadderStage, STAGE_ORDER } = await imp('../services/amb/scaleLadder.js');
const { prisma } = await imp('../prisma.js');
const { get_scale_ladder } = await imp('../services/aiTools.js');

console.log('§1 Pure fixture assertions — resolveScaleLadderStage:');
{
  const r1 = resolveScaleLadderStage({ pkg: { decision: 'INSUFFICIENT_DATA', diagnosis: { bottleneck: { category: 'INSUFFICIENT_DATA' } } }, testMatrix: [], profitBrain: null, creativeFatigueStates: [] });
  ok('INSUFFICIENT_DATA bottleneck -> NEW', r1.stage === 'NEW');

  const r2 = resolveScaleLadderStage({ pkg: { decision: 'PAUSE_CANDIDATE', diagnosis: { bottleneck: { category: 'CPA_PROBLEM' } } }, testMatrix: [], profitBrain: null, creativeFatigueStates: [] });
  ok('PAUSE_CANDIDATE -> REFRESH', r2.stage === 'REFRESH');

  const r3 = resolveScaleLadderStage({ pkg: { decision: 'SCALE_CANDIDATE', diagnosis: { bottleneck: { category: 'HEALTHY_PRODUCT' } } }, testMatrix: [], profitBrain: { state: 'PROFITABLE' }, creativeFatigueStates: ['FATIGUED'] });
  ok('SCALE_CANDIDATE + a real FATIGUED creative -> FATIGUE (never silently STABLE)', r3.stage === 'FATIGUE', r3.stage);

  const r4 = resolveScaleLadderStage({ pkg: { decision: 'SCALE_CANDIDATE', diagnosis: { bottleneck: { category: 'HEALTHY_PRODUCT' } } }, testMatrix: [], profitBrain: { state: 'PROFITABLE' }, creativeFatigueStates: ['HEALTHY'] });
  ok('SCALE_CANDIDATE + profitable + no fatigue -> STABLE', r4.stage === 'STABLE');

  const r5 = resolveScaleLadderStage({ pkg: { decision: 'SCALE_CANDIDATE', diagnosis: { bottleneck: { category: 'HEALTHY_PRODUCT' } } }, testMatrix: [], profitBrain: { state: 'UNPROFITABLE' }, creativeFatigueStates: [] });
  ok('SCALE_CANDIDATE but UNPROFITABLE -> VALIDATED with an explicit profit blocker (never STABLE)', r5.stage === 'VALIDATED' && r5.blockers.some((b) => b.includes('UNPROFITABLE')), JSON.stringify(r5));

  const r6 = resolveScaleLadderStage({ pkg: { decision: 'KEEP_TESTING', diagnosis: { bottleneck: { category: 'CPA_PROBLEM' } } }, testMatrix: [{ status: 'WON', dimension: 'CREATIVE' }], profitBrain: null, creativeFatigueStates: [] });
  ok('a real WON dimension but no SCALE_CANDIDATE decision -> SIGNAL_FOUND', r6.stage === 'SIGNAL_FOUND');

  const r7 = resolveScaleLadderStage({ pkg: { decision: 'NEW_CREATIVE_TEST', diagnosis: { bottleneck: { category: 'CREATIVE_PROBLEM' } } }, testMatrix: [], profitBrain: null, creativeFatigueStates: [] });
  ok('an active test decision, no WON yet -> TESTING', r7.stage === 'TESTING');

  ok('every stage returned so far is a real member of STAGE_ORDER', [r1, r2, r3, r4, r5, r6, r7].every((r) => STAGE_ORDER.includes(r.stage)));
}

console.log('\n§2 Real reads — get_scale_ladder across real products:');
{
  const ambProducts = await prisma.ambProduct.findMany({ take: 15, orderBy: { id: 'desc' }, select: { product_id: true, product_name: true } });
  let checked = 0;
  const seenStages = new Set();
  for (const ap of ambProducts) {
    if (!ap.product_id) continue;
    const out = await get_scale_ladder({ productId: ap.product_id, window: 'last7' });
    if (!out.ok || !out.hasData) continue;
    checked++;
    ok(`${ap.product_name} stage is a real member of STAGE_ORDER`, STAGE_ORDER.includes(out.stage), out.stage);
    ok(`${ap.product_name} carries a real, non-empty reason`, typeof out.reason === 'string' && out.reason.length > 5);
    ok(`${ap.product_name} blockers is a real array`, Array.isArray(out.blockers));
    seenStages.add(out.stage);
  }
  ok('checked at least one real product', checked > 0, `checked=${checked}`);
  console.log(`  checked ${checked} products across stages: ${[...seenStages].join(', ')}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
