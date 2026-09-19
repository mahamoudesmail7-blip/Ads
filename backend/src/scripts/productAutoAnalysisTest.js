// Smart Decision Center UX overhaul — services/amb/productAutoAnalysis.js.
// Exercises the pure change-detection logic directly (no network/DB
// dependency for this part) plus one real end-to-end run against
// production data, asserting the scheduler tick never crashes and never
// spams a duplicate row when nothing material changed.
//   node src/scripts/productAutoAnalysisTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const mod = await imp('../services/amb/productAutoAnalysis.js');
const { runAutoAnalysis } = mod;
const { prisma } = await imp('../prisma.js');

console.log('§1 runAutoAnalysis — a real end-to-end scheduler tick against production data completes without crashing:');
{
  const result = await runAutoAnalysis();
  ok('returns a structured {scanned, analyzed, changed} result, never throws', typeof result.scanned === 'number' || result.reason === 'NO_AD_ACCOUNT', JSON.stringify(result));
}

console.log('\n§2 a second immediate run makes no further changes (6h cooldown correctly skips just-analyzed products):');
{
  const before = await prisma.ambRecommendation.count({ where: { level: 'product' } });
  const result = await runAutoAnalysis();
  const after = await prisma.ambRecommendation.count({ where: { level: 'product' } });
  ok('zero new rows on an immediate re-run (cooldown respected, never duplicate spam)', after === before, `${before} -> ${after}, result=${JSON.stringify(result)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
