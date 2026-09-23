// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 5 (Targeting Strategy) verification. Pure reads only.
//   node src/scripts/targetingStrategyTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { get_targeting_strategy } = await imp('../services/aiTools.js');

console.log('§1 Real reads — get_targeting_strategy across real products:');
{
  const ambProducts = await prisma.ambProduct.findMany({ take: 15, orderBy: { id: 'desc' }, select: { product_id: true, product_name: true } });
  let checked = 0, sawScaleRestriction = 0, sawBroad = 0;
  for (const ap of ambProducts) {
    if (!ap.product_id) continue;
    const out = await get_targeting_strategy({ productId: ap.product_id, window: 'last7' });
    if (!out.ok || !out.hasData) continue;
    checked++;
    ok(`${ap.product_name} currentlyLeading covers all 3 dimensions`, ['gender', 'age', 'governorate'].every((d) => d in out.currentlyLeading));
    const isBroad = out.scaleTargeting?.mode === 'BROAD';
    if (isBroad) { sawBroad++; ok(`${ap.product_name} BROAD scaleTargeting carries a real reason`, typeof out.scaleTargeting.reason === 'string' && out.scaleTargeting.reason.length > 5); }
    else {
      sawScaleRestriction++;
      for (const [dim, entry] of Object.entries(out.scaleTargeting)) {
        ok(`${ap.product_name} scaleTargeting.${dim} is PROVEN-tier only, never PROMISING/EARLY_SIGNAL`, entry.status === 'PROVEN', JSON.stringify(entry));
      }
    }
    for (const [dim, entry] of Object.entries(out.testTargeting || {})) {
      ok(`${ap.product_name} testTargeting.${dim} is never PROVEN (that belongs in scaleTargeting, not here)`, entry.status !== 'PROVEN', JSON.stringify(entry));
    }
    // A dimension can never appear in BOTH scaleTargeting and testTargeting at once — same underlying winner, one status.
    const overlap = Object.keys(out.scaleTargeting || {}).filter((d) => d in (out.testTargeting || {}));
    ok(`${ap.product_name} no dimension appears in both scaleTargeting and testTargeting`, overlap.length === 0, JSON.stringify(overlap));
  }
  ok('checked at least one real product', checked > 0, `checked=${checked}`);
  console.log(`  checked ${checked} products — ${sawScaleRestriction} with a real PROVEN restriction, ${sawBroad} correctly left BROAD.`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
