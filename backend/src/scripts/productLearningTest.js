// Smart Decision Center Phase 10 — services/amb/productLearning.js. Real
// throwaway pmc_learning/pmc_memory rows, all keyed under a test-only
// dimension/key prefix so cleanup can never touch real production learning
// data for the real product (126) this test reads against.
//   node src/scripts/productLearningTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { resolveProfileForProduct, applyLearningFromExperiment, getProductLearningMemory } = await imp('../services/amb/productLearning.js');
const { prisma } = await imp('../prisma.js');

const TEST_KEY = `TEST_XP_${Date.now()}`;

async function cleanup(profileId) {
  await prisma.productMarketingMemoryEntry.deleteMany({ where: { profile_id: profileId, field: { contains: TEST_KEY } } });
  await prisma.productMarketingLearning.deleteMany({ where: { profile_id: profileId, key: TEST_KEY } });
}

try {
  console.log('§1 resolveProfileForProduct — real linked profile vs. genuinely unlinked product:');
  const realProfile = await resolveProfileForProduct(126);
  ok('resolves a real profile for a product known to have one (126)', realProfile && realProfile.id > 0, JSON.stringify(realProfile));
  const noProfile = await resolveProfileForProduct(999999999);
  ok('resolves null for a product with no PMC profile — never fabricates one', noProfile === null);

  if (realProfile) {
    try {
      console.log('\n§2 applyLearningFromExperiment — a NEUTRAL/INCONCLUSIVE outcome writes nothing (mirrors the pre-existing PMC rule):');
      {
        const r1 = await applyLearningFromExperiment({ productId: 126, facts: { winners: { creative: { label: TEST_KEY, purchases: 5 } } }, resultClass: 'NEUTRAL', evidence: {} });
        ok('NEUTRAL writes zero learning rows', r1.written.length === 0, JSON.stringify(r1));
        const row = await prisma.productMarketingLearning.findUnique({ where: { profile_id_dimension_key: { profile_id: realProfile.id, dimension: 'CREATIVE', key: TEST_KEY } } });
        ok('confirmed: no row was actually created', row === null);
      }

      console.log('\n§3 applyLearningFromExperiment — SUCCESSFUL writes a real WORKS verdict for the decision\'s own named winner:');
      {
        const r2 = await applyLearningFromExperiment({ productId: 126, facts: { winners: { creative: { label: TEST_KEY, purchases: 5 } } }, resultClass: 'SUCCESSFUL', evidence: { note: 'test' } });
        ok('writes exactly one CREATIVE learning row', r2.written.length === 1 && r2.written[0].dimension === 'CREATIVE' && r2.written[0].verdict === 'WORKS', JSON.stringify(r2));
        const row = await prisma.productMarketingLearning.findUnique({ where: { profile_id_dimension_key: { profile_id: realProfile.id, dimension: 'CREATIVE', key: TEST_KEY } } });
        ok('the row is really persisted with verdict WORKS and the real sample size', row && row.verdict === 'WORKS' && row.sample_size === 5, JSON.stringify(row));
      }

      console.log('\n§4 applyLearningFromExperiment — new contradictory evidence downgrades the old conclusion, with a full audit trail:');
      {
        const r3 = await applyLearningFromExperiment({ productId: 126, facts: { winners: { creative: { label: TEST_KEY, purchases: 2 } } }, resultClass: 'FAILED', evidence: { note: 'later contradicting test' } });
        ok('writes DOES_NOT_WORK, overwriting the earlier WORKS', r3.written[0].verdict === 'DOES_NOT_WORK', JSON.stringify(r3));
        const row = await prisma.productMarketingLearning.findUnique({ where: { profile_id_dimension_key: { profile_id: realProfile.id, dimension: 'CREATIVE', key: TEST_KEY } } });
        ok('the CURRENT verdict is now the new one (WORKS never stays stuck once contradicted)', row.verdict === 'DOES_NOT_WORK');
        const memEntries = await prisma.productMarketingMemoryEntry.findMany({ where: { profile_id: realProfile.id, field: `CREATIVE:${TEST_KEY}` }, orderBy: { created_at: 'asc' } });
        ok('the audit trail kept BOTH the original WORKS write and the downgrade — nothing silently lost', memEntries.length === 2, JSON.stringify(memEntries));
        ok('the downgrade entry\'s previous_json correctly captured the old WORKS verdict', JSON.parse(memEntries[1].previous_json).verdict === 'WORKS', memEntries[1].previous_json);
      }

      console.log('\n§5 getProductLearningMemory — presentation-layer PROVEN/PROMISING/REJECTED/STALE reconciliation:');
      {
        // REJECTED — the row from §4 is DOES_NOT_WORK.
        const mem = await getProductLearningMemory({ productId: 126 });
        const entry = mem.entries.find((e) => e.key === TEST_KEY);
        ok('a DOES_NOT_WORK verdict is exposed as REJECTED', entry?.state === 'REJECTED', JSON.stringify(entry));

        // PROVEN — force a fresh WORKS row with a high sample size directly (bypassing the NEUTRAL-skip rule, this is a direct fixture write).
        await prisma.productMarketingLearning.update({ where: { profile_id_dimension_key: { profile_id: realProfile.id, dimension: 'CREATIVE', key: TEST_KEY } }, data: { verdict: 'WORKS', sample_size: 25, computed_at: new Date() } });
        const mem2 = await getProductLearningMemory({ productId: 126 });
        ok('WORKS with sample_size >= threshold is exposed as PROVEN', mem2.entries.find((e) => e.key === TEST_KEY)?.state === 'PROVEN');

        // PROMISING — same WORKS verdict, but thin sample.
        await prisma.productMarketingLearning.update({ where: { profile_id_dimension_key: { profile_id: realProfile.id, dimension: 'CREATIVE', key: TEST_KEY } }, data: { verdict: 'WORKS', sample_size: 3, computed_at: new Date() } });
        const mem3 = await getProductLearningMemory({ productId: 126 });
        ok('WORKS with a thin sample is exposed as PROMISING, not yet PROVEN', mem3.entries.find((e) => e.key === TEST_KEY)?.state === 'PROMISING');

        // STALE — same WORKS+high-sample row, but not reconfirmed in a long time.
        await prisma.productMarketingLearning.update({ where: { profile_id_dimension_key: { profile_id: realProfile.id, dimension: 'CREATIVE', key: TEST_KEY } }, data: { verdict: 'WORKS', sample_size: 25, computed_at: new Date(Date.now() - 60 * 86400000) } });
        const mem4 = await getProductLearningMemory({ productId: 126 });
        ok('an old, long-unconfirmed conclusion is exposed as STALE regardless of its stored verdict', mem4.entries.find((e) => e.key === TEST_KEY)?.state === 'STALE');
      }
    } finally {
      await cleanup(realProfile.id);
    }
  }

  console.log('\n§6 getProductLearningMemory — a product with no PMC profile returns an honest empty state, never fabricated entries:');
  {
    const mem = await getProductLearningMemory({ productId: 999999999 });
    ok('hasProfile:false and zero entries', mem.hasProfile === false && mem.entries.length === 0, JSON.stringify(mem));
  }
} catch (err) {
  fail++;
  console.error('UNEXPECTED ERROR:', err);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
