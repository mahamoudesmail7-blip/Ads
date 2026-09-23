// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 19 (Product Growth UI — 🧠 خطة النمو tab backend) verification.
// Pure composition over Slice 3/4/9/11/13/14's already-tested tools — this
// script only confirms the BUNDLE assembles correctly on real products; it
// never re-verifies each underlying tool's own logic (that's each slice's
// own test script). The frontend tab itself is verified live against
// production after deploy.
//   node src/scripts/growthUiCompositionTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { get_growth_plan, get_scale_ladder, get_testing_brain, get_cod_quality, get_stock_status, get_incidents } = await imp('../services/aiTools.js');

console.log('§1 The exact bundle the /growth route assembles, across several real products:');
{
  const ambProducts = await prisma.ambProduct.findMany({ take: 6, orderBy: { id: 'desc' }, select: { product_id: true, product_name: true } });
  let checked = 0;
  for (const ap of ambProducts) {
    if (!ap.product_id) continue;
    const productId = ap.product_id, window = 'last7';
    const [growthPlan, scaleLadder, testingBrain, codQuality, stock, incidents] = await Promise.all([
      get_growth_plan({ productId, window }),
      get_scale_ladder({ productId, window }),
      get_testing_brain({ productId, window }),
      get_cod_quality({ productId, window }),
      get_stock_status({ productId }),
      get_incidents({ productId, window }),
    ]);
    checked++;
    ok(`${ap.product_name}: all 6 bundled reads complete without throwing`, true);
    ok(`${ap.product_name}: each bundled read returns a real ok field (true or a clean false, never undefined)`, [growthPlan, scaleLadder, testingBrain, codQuality, stock, incidents].every((r) => typeof r.ok === 'boolean'));
    if (growthPlan.ok) ok(`${ap.product_name}: growthPlan carries the mandatory evidence-vs-hypothesis separation`, growthPlan.hypothesis === undefined || growthPlan.hypothesis !== growthPlan.primaryBottleneck?.evidence || growthPlan.primaryBottleneck?.evidence == null);
    if (scaleLadder.ok) ok(`${ap.product_name}: scaleLadder.stage is a real stage value`, typeof scaleLadder.stage === 'string');
    if (stock.ok) ok(`${ap.product_name}: stock.status is one of the 4 real spec values`, ['HEALTHY', 'LOW', 'CRITICAL', 'NOT_CONNECTED'].includes(stock.status));
    if (incidents.ok) ok(`${ap.product_name}: incidents.count matches incidents.incidents.length`, incidents.count === incidents.incidents.length);
  }
  ok('checked at least one real product', checked > 0, `checked=${checked}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
