// Phase 1 Testing Lab / Marketing Memory — createTest/listTests/
// updateTestStatus/recordTestResult/recordLearning/hasBeenTriedAndFailed.
// In-memory mocks for pmc_tests/pmc_test_results/pmc_learning; every OTHER
// model's write methods are guarded to prove zero unintended writes.
//   node src/scripts/productMarketingTestsTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

let dbWriteAttempted = false;
for (const model of ['easyOrdersOrder', 'customer', 'product', 'ambProduct']) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const orig = prisma[model]?.[method]?.bind(prisma[model]);
    if (!orig) continue;
    prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called.`); };
  }
}

let PROFILES = [{ id: 1 }];
let TESTS = [];
let RESULTS = [];
let LEARNING = [];
let nextTestId = 1, nextResultId = 1, nextLearningId = 1;

prisma.productMarketingProfile.findUnique = async ({ where }) => PROFILES.find((p) => p.id === where.id) || null;

prisma.productMarketingTest.create = async ({ data }) => {
  const row = { id: nextTestId++, results: [], created_at: new Date(), updated_at: new Date(), ...data };
  TESTS.push(row);
  return { ...row };
};
prisma.productMarketingTest.findUnique = async ({ where }) => TESTS.find((t) => t.id === where.id) || null;
prisma.productMarketingTest.findMany = async ({ where = {} } = {}) => {
  let rows = TESTS.filter((t) => t.profile_id === where.profile_id);
  if (where.status) rows = rows.filter((t) => t.status === where.status);
  return rows.map((t) => ({ ...t, results: RESULTS.filter((r) => r.test_id === t.id) }));
};
prisma.productMarketingTest.update = async ({ where, data }) => {
  const row = TESTS.find((t) => t.id === where.id);
  Object.assign(row, data);
  return { ...row };
};

prisma.productMarketingTestResult.create = async ({ data }) => {
  const row = { id: nextResultId++, created_at: new Date(), ...data };
  RESULTS.push(row);
  return { ...row };
};

prisma.productMarketingLearning.findUnique = async ({ where }) => {
  const k = where.profile_id_dimension_key;
  return LEARNING.find((l) => l.profile_id === k.profile_id && l.dimension === k.dimension && l.key === k.key) || null;
};
prisma.productMarketingLearning.upsert = async ({ where, create, update }) => {
  const k = where.profile_id_dimension_key;
  const existing = LEARNING.find((l) => l.profile_id === k.profile_id && l.dimension === k.dimension && l.key === k.key);
  if (existing) { Object.assign(existing, update); return { ...existing }; }
  const row = { id: nextLearningId++, computed_at: new Date(), ...create };
  LEARNING.push(row);
  return { ...row };
};
prisma.productMarketingLearning.findMany = async ({ where = {} } = {}) => LEARNING.filter((l) => l.profile_id === where.profile_id);

const { createTest, listTests, updateTestStatus, recordTestResult, recordLearning, hasBeenTriedAndFailed, listLearning } =
  await import(pathToFileURL(join(__dirname, '../services/amb/productMarketingTests.js')).href);

console.log('§1 createTest — validates required fields, defaults priority/status:');
{
  const test = await createTest({ profileId: 1, testType: 'HOOK', hypothesis: 'Hook سؤال يزود CTR', variable: 'Hook', control: 'Hook حالي', variation: 'Hook سؤال جديد', successMetric: 'ctr', userId: 7 });
  ok('created with PLANNED status by default', test.status === 'PLANNED', JSON.stringify(test));
  ok('created with P2 priority by default', test.priority === 'P2');
  ok('created_by_id recorded', test.created_by_id === 7);

  let threw = false;
  try { await createTest({ profileId: 1, testType: 'NOT_A_TYPE', hypothesis: 'x', variable: 'x', control: 'x', variation: 'x', successMetric: 'ctr' }); } catch { threw = true; }
  ok('unknown test_type is rejected', threw);

  let threw2 = false;
  try { await createTest({ profileId: 999, testType: 'HOOK', hypothesis: 'x', variable: 'x', control: 'x', variation: 'x', successMetric: 'ctr' }); } catch { threw2 = true; }
  ok('unknown profileId is rejected', threw2);
}

console.log('\n§2 listTests + updateTestStatus:');
{
  const list = await listTests(1);
  ok('lists the created test with its (empty) results', list.length === 1 && Array.isArray(list[0].results));
  const updated = await updateTestStatus({ testId: list[0].id, status: 'RUNNING', userId: 7 });
  ok('status updated to RUNNING', updated.status === 'RUNNING');
  const runningOnly = await listTests(1, { status: 'RUNNING' });
  ok('filter by status works', runningOnly.length === 1);
}

console.log('\n§3 recordTestResult — deterministic classification from real numbers, never AI:');
{
  const test = TESTS[0];
  const winnerResult = await recordTestResult({
    testId: test.id, window: { from: '2026-09-01', to: '2026-09-07' },
    metrics: { spend: 500, metaPurchases: 10, orders: 10, ctr: 3.5 }, controlValue: 2.0, // ctr improved from 2.0 to 3.5, huge improvement
    whatDidWeLearn: 'Hook السؤال شغال كويس', whatNext: 'وسّع الميزانية',
  });
  ok('CTR massively better than control, enough sample -> WINNER', winnerResult.classification === 'WINNER', JSON.stringify(winnerResult));

  const inconclusiveResult = await recordTestResult({
    testId: test.id, window: { from: '2026-09-08', to: '2026-09-14' },
    metrics: { spend: 50, metaPurchases: 1, ctr: 3.5 }, controlValue: 2.0, // same improvement but sample too small
  });
  ok('same metric improvement but purchases below min sample -> INCONCLUSIVE, never a premature WINNER', inconclusiveResult.classification === 'INCONCLUSIVE', JSON.stringify(inconclusiveResult));

  const neutralResult = await recordTestResult({
    testId: test.id, window: { from: '2026-09-15', to: '2026-09-21' },
    metrics: { spend: 500, metaPurchases: 10, ctr: 2.1 }, controlValue: 2.0, // barely different
  });
  ok('marginal difference -> NEUTRAL, not WINNER or LOSER', neutralResult.classification === 'NEUTRAL', JSON.stringify(neutralResult));
}

console.log('\n§3b regression — a "lower is better" metric (CPA) must classify a LOWER value as WINNER, not LOSER (the exact bug this test caught before the fix):');
{
  const cpaTest = await createTest({ profileId: 1, testType: 'CREATIVE', hypothesis: 'كرياتيف جديد يقلل الـCPA', variable: 'Creative', control: 'Creative حالي', variation: 'Creative جديد', successMetric: 'cpa' });
  const lowerCpaResult = await recordTestResult({
    testId: cpaTest.id, window: { from: '2026-09-01', to: '2026-09-07' },
    metrics: { spend: 500, metaPurchases: 10, cpa: 50 }, controlValue: 100, // CPA dropped from 100 to 50 — a real win
  });
  ok('CPA dropped by 50% (lower is better) -> WINNER, not LOSER', lowerCpaResult.classification === 'WINNER', JSON.stringify(lowerCpaResult));

  const higherCpaResult = await recordTestResult({
    testId: cpaTest.id, window: { from: '2026-09-08', to: '2026-09-14' },
    metrics: { spend: 500, metaPurchases: 10, cpa: 150 }, controlValue: 100, // CPA rose from 100 to 150 — a real loss
  });
  ok('CPA rose by 50% -> LOSER, not WINNER', higherCpaResult.classification === 'LOSER', JSON.stringify(higherCpaResult));
}

console.log('\n§4 recordTestResult with a WINNER/LOSER classification writes a Marketing Memory entry (recordLearning), INCONCLUSIVE/NEUTRAL do not overwrite a stronger verdict:');
{
  const learningRows = await listLearning(1);
  const hookRow = learningRows.find((l) => l.dimension === 'HOOK');
  const creativeRow = learningRows.find((l) => l.dimension === 'CREATIVE');
  ok('exactly 2 learning rows (one per distinct test variation, HOOK + CREATIVE)', learningRows.length === 2, JSON.stringify(learningRows));
  ok('HOOK row verdict WORKS from the WINNER result, never downgraded by the later NEUTRAL result on the same test', hookRow?.verdict === 'WORKS', JSON.stringify(hookRow));
  ok('CREATIVE row verdict DOES_NOT_WORK — the later LOSER result correctly overwrote the earlier WINNER (both are real, decisive signals, latest wins)', creativeRow?.verdict === 'DOES_NOT_WORK', JSON.stringify(creativeRow));
}

console.log('\n§5 hasBeenTriedAndFailed — duplicate-test prevention:');
{
  await recordLearning({ profileId: 1, dimension: 'ANGLE', key: 'راحة/سهولة', verdict: 'DOES_NOT_WORK', sampleSize: 20, evidence: { note: 'CPA اتضاعف' } });
  ok('a DOES_NOT_WORK verdict is correctly flagged as tried-and-failed', await hasBeenTriedAndFailed(1, 'ANGLE', 'راحة/سهولة') === true);
  ok('a dimension/key never tested returns false, not a false positive', await hasBeenTriedAndFailed(1, 'ANGLE', 'شيء لم يُختبر أبدًا') === false);
  ok('a WORKS verdict is never flagged as tried-and-failed', await hasBeenTriedAndFailed(1, 'HOOK', 'Hook سؤال جديد') === false);
}

console.log('\n§6 zero writes to any unrelated table anywhere in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
