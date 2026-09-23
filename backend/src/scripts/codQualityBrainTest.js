// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 9 (COD Quality Brain) verification. Pure reads only.
//   node src/scripts/codQualityBrainTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { get_cod_quality } = await imp('../services/aiTools.js');

const GOV_RANK = { PROVEN_WINNER: 3, PROMISING: 2, INSUFFICIENT_DATA: 1, PROVEN_WEAK: 0 };

console.log('§1 Real reads — get_cod_quality across real products:');
{
  const ambProducts = await prisma.ambProduct.findMany({ take: 15, orderBy: { id: 'desc' }, select: { product_id: true, product_name: true } });
  let checked = 0, sawBlocksScale = 0, sawSmallSample = 0;
  for (const ap of ambProducts) {
    if (!ap.product_id) continue;
    const out = await get_cod_quality({ productId: ap.product_id, window: 'last30' });
    if (!out.ok || !out.hasData) continue;
    checked++;
    const p = out.productLevel;
    ok(`${ap.product_name} orders = pending + confirmed + cancelled (real arithmetic, never a guessed count)`, p.pending + p.confirmed + p.cancelled === p.orders, JSON.stringify(p));
    ok(`${ap.product_name} confirmationRate/cancellationRate are null or in [0,1]`, [p.confirmationRate, p.cancellationRate].every((r) => r === null || (r >= 0 && r <= 1)));
    ok(`${ap.product_name} deliveryRate/returnRate are null or in [0,1]`, [p.deliveryRate, p.returnRate].every((r) => r === null || (r >= 0 && r <= 1)));
    // Governorates must be sorted by evidence tier first, raw orders only as a tiebreaker — never raw orders alone.
    const ranks = out.governorateRows.map((r) => GOV_RANK[r.classification] ?? -1);
    const sortedByRank = ranks.every((r, i) => i === 0 || ranks[i - 1] >= r);
    ok(`${ap.product_name} governorateRows are sorted by evidence tier, never raw orders alone`, sortedByRank, JSON.stringify(out.governorateRows.map((r) => ({ g: r.governorate, c: r.classification, o: r.orders }))));
    if (out.codBlocksScale) {
      sawBlocksScale++;
      ok(`${ap.product_name} codBlocksScale carries an explicit ⚠️ decisionNote`, typeof out.decisionNote === 'string' && out.decisionNote.startsWith('⚠️'));
    }
    if (p.orders < 20 && !out.codBlocksScale) {
      sawSmallSample++;
      ok(`${ap.product_name} small sample never gets a false "✅ COD is fine" reassurance`, out.decisionNote == null || out.decisionNote.startsWith('❔'), out.decisionNote);
    }
  }
  ok('checked at least one real product', checked > 0, `checked=${checked}`);
  console.log(`  checked ${checked} products — ${sawBlocksScale} COD-blocks-scale, ${sawSmallSample} honest small-sample notes.`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
