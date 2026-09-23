// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 10 (Product Playbook) verification. Pure reads only.
//   node src/scripts/productPlaybookTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { get_product_playbook } = await imp('../services/aiTools.js');

console.log('§1 Real reads — get_product_playbook across real products:');
{
  const ambProducts = await prisma.ambProduct.findMany({ take: 15, orderBy: { id: 'desc' }, select: { product_id: true, product_name: true } });
  let checked = 0, sawLearning = 0, sawHistory = 0;
  for (const ap of ambProducts) {
    if (!ap.product_id) continue;
    const out = await get_product_playbook({ productId: ap.product_id, window: 'last7' });
    if (!out.ok || !out.hasData) continue;
    checked++;
    ok(`${ap.product_name} learnedEntries is a real array`, Array.isArray(out.learnedEntries));
    ok(`${ap.product_name} decisionHistory is a real array, newest first`, Array.isArray(out.decisionHistory) && out.decisionHistory.every((r, i) => i === 0 || new Date(out.decisionHistory[i - 1].created_at) >= new Date(r.created_at)));
    ok(`${ap.product_name} currentProfitProfile carries the honest "snapshot not trend" note`, out.currentProfitProfile === null || out.currentProfitProfile.note.includes('لقطة حالية'));
    ok(`${ap.product_name} currentCodProfile carries the honest "snapshot not trend" note`, out.currentCodProfile === null || out.currentCodProfile.note.includes('لقطة حالية'));
    if (Object.keys(out.bestByDimension).length) {
      sawLearning++;
      for (const [dim, best] of Object.entries(out.bestByDimension)) {
        ok(`${ap.product_name} bestByDimension.${dim} is PROVEN or PROMISING only (never REJECTED/STALE)`, ['PROVEN', 'PROMISING'].includes(best.state), JSON.stringify(best));
      }
    }
    if (out.decisionHistory.length) sawHistory++;
  }
  ok('checked at least one real product', checked > 0, `checked=${checked}`);
  console.log(`  checked ${checked} products — ${sawLearning} with real learned bests, ${sawHistory} with real decision history.`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
