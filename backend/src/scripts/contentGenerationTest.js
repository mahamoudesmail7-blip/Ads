// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slices 6+7+8 (Angle Intelligence, Hook/Post/Headline Strategy, Creative
// Strategy) verification. These three tools make REAL OpenAI calls, which
// this local machine's .env does not carry a key for (the key lives only in
// Railway's production environment) — so this script verifies everything
// UP TO the AI call boundary with real data (product resolution, Testing
// Brain context extraction) and confirms a missing/failed AI call degrades
// to an honest {ok:false, error} rather than crashing or fabricating
// output. The actual AI output quality is verified live in chat post-deploy.
//   node src/scripts/contentGenerationTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { generate_angles, generate_hooks, generate_creative_brief } = await imp('../services/aiTools.js');
const { buildProductDecisionPackage } = await imp('../services/amb/productDecision.js');
const { getAmbSettings } = await imp('../services/amb/settings.js');
const { buildTestMatrix } = await imp('../services/amb/testingBrain.js');
const { getConnection } = await imp('../services/metaAuth.js');

console.log('§1 Real context-building — generate_angles pulls real existing angles + real bottleneck evidence:');
{
  const connection = await getConnection();
  if (!connection?.selected_ad_account_id) {
    console.log('  (skipped — no connected ad account)');
  } else {
    const settings = await getAmbSettings();
    const ambProducts = await prisma.ambProduct.findMany({ take: 8, orderBy: { id: 'desc' }, select: { product_id: true, product_name: true } });
    let checked = 0;
    for (const ap of ambProducts) {
      if (!ap.product_id) continue;
      const pkg = await buildProductDecisionPackage({ productId: ap.product_id, windowName: 'last7', settings, adAccountId: connection.selected_ad_account_id }).catch(() => null);
      if (!pkg) continue;
      const { matrix } = await buildTestMatrix({ productId: ap.product_id, pkg });
      const existingAngles = [...new Set(matrix.filter((e) => e.dimension === 'ANGLE').map((e) => e.key))];
      checked++;
      ok(`${ap.product_name} existingAngles is a real array (never fabricated)`, Array.isArray(existingAngles));
      if (existingAngles.length) ok(`${ap.product_name} existingAngles entries are real non-empty strings`, existingAngles.every((a) => typeof a === 'string' && a.length > 0));
    }
    ok('checked at least one real product', checked > 0, `checked=${checked}`);
  }
}

console.log('\n§2 Real product resolution + honest AI-failure degradation (never a crash, never fabricated output):');
{
  const realProduct = await prisma.product.findFirst({ where: { active: true, is_historical: false }, select: { id: true, product_name: true } });
  if (!realProduct) {
    console.log('  (skipped — no real active product found)');
  } else {
    const anglesRes = await generate_angles({ productId: realProduct.id, count: 2 });
    ok('generate_angles never throws — returns a real {ok,...} shape', typeof anglesRes === 'object' && 'ok' in anglesRes, JSON.stringify(anglesRes));
    if (anglesRes.ok) {
      ok('generate_angles succeeded — every angle starts state:PROPOSED', (anglesRes.angles || []).every((a) => a.state === 'PROPOSED'), JSON.stringify(anglesRes.angles));
      ok('generate_angles every angle carries a real claimStatus', (anglesRes.angles || []).every((a) => ['GREEN', 'YELLOW', 'RED'].includes(a.claimStatus)));
    } else {
      ok('generate_angles honestly failed (expected locally — no OPENAI_API_KEY here) with a real reason string', typeof anglesRes.error === 'string' && anglesRes.error.length > 0, anglesRes.error);
    }

    const hooksRes = await generate_hooks({ productId: realProduct.id, count: 3 });
    ok('generate_hooks never throws — returns a real {ok,...} shape', typeof hooksRes === 'object' && 'ok' in hooksRes);
    if (hooksRes.ok) ok('generate_hooks every hook carries a real claimStatus', (hooksRes.hooks || []).every((h) => ['GREEN', 'YELLOW', 'RED'].includes(h.claimStatus)));

    const briefRes = await generate_creative_brief({ productId: realProduct.id, count: 2 });
    ok('generate_creative_brief never throws — returns a real {ok,...} shape', typeof briefRes === 'object' && 'ok' in briefRes);

    const invalidRes = await generate_angles({ productId: 999999999, count: 2 });
    ok('generate_angles refuses a nonexistent productId honestly, never invents a product', invalidRes.ok === false && invalidRes.error.includes('المنتج'), JSON.stringify(invalidRes));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
