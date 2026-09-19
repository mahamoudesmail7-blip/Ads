// Smart Decision Center Phase 9 — services/amb/productExperiment.js.
// Real throwaway AmbRecommendation/AmbAction/AmbActionResult rows (tagged,
// cleaned up after), backdated due_at so evaluateProductExperiments() finds
// them as due right away. Never asserts a SPECIFIC SUCCESSFUL/FAILED verdict
// against real product 90's real Meta/COD data (that data changes over
// time) — only that the evaluator runs, writes a real evaluated_at +
// structurally valid result, and NEVER touches a non-product-level action
// (outcomeEval.js's exclusive territory).
//   node src/scripts/productExperimentTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { evaluateProductExperiments, experimentOutcomeLabel, getProductExperiment } = await imp('../services/amb/productExperiment.js');
const { prisma } = await imp('../prisma.js');

const recIds = [];
async function cleanup() {
  for (const id of recIds) {
    await prisma.ambAction.deleteMany({ where: { recommendation_id: id } }); // cascades to AmbActionResult
    await prisma.ambRecommendation.deleteMany({ where: { id } });
  }
}

function baseRecData(overrides = {}) {
  return {
    batch_id: `test-xp-${Date.now()}-${Math.random()}`,
    ad_account_id: 'act_test_xp',
    level: 'product',
    decision: 'KEEP_TESTING',
    action_type: 'DRAFT_PRODUCT_DECISION',
    executable: false,
    reason: 'test experiment reason',
    reason_facts_json: JSON.stringify({ proposedChange: 'test', successMetric: 'CPA' }),
    confidence: 'LOW',
    status: 'EXECUTED',
    ...overrides,
  };
}

async function createDueAction({ rec, level = 'product', hoursAgoExecuted = 7, hoursAgoDue = 1 }) {
  const action = await prisma.ambAction.create({
    data: {
      recommendation_id: rec.id, mode: 'APPROVAL', action_type: 'DRAFT_PRODUCT_DECISION', ad_account_id: rec.ad_account_id,
      level, entity_id: `product:${rec.amb_product_id}`, entity_name: rec.product_name,
      approval_status: 'APPROVED', execution_status: 'EXECUTED',
      executed_at: new Date(Date.now() - hoursAgoExecuted * 3600 * 1000),
    },
  });
  const result = await prisma.ambActionResult.create({
    data: { action_id: action.id, checkpoint: 'H6', due_at: new Date(Date.now() - hoursAgoDue * 3600 * 1000) },
  });
  return { action, result };
}

try {
  console.log('§1 evaluateProductExperiments — finds and evaluates a due, unevaluated product-level checkpoint:');
  {
    const realAmbProduct = await prisma.ambProduct.findFirst({ where: { product_id: { not: null } }, select: { id: true, product_name: true } });
    if (!realAmbProduct) {
      console.log('  (skipped — no real AmbProduct linked to a Product exists in this DB)');
    } else {
      const rec = await prisma.ambRecommendation.create({ data: baseRecData({ amb_product_id: realAmbProduct.id, product_name: realAmbProduct.product_name }) });
      recIds.push(rec.id);
      const { result } = await createDueAction({ rec });
      const { evaluated } = await evaluateProductExperiments();
      ok('at least this one due row was evaluated', evaluated >= 1);
      const after = await prisma.ambActionResult.findUnique({ where: { id: result.id } });
      ok('evaluated_at is now set (retroactive evaluation ran)', after.evaluated_at !== null);
      ok('result_class is either a real verdict or explicitly null (never a fabricated guess)', after.result_class === null || ['SUCCESSFUL', 'NEUTRAL', 'FAILED'].includes(after.result_class), after.result_class);
      const notes = JSON.parse(after.notes_json || '{}');
      ok('notes explain which field/direction were used for this decision\'s own successMetric', notes.field === 'cpa' && notes.direction === 'LOWER_BETTER', JSON.stringify(notes));

      console.log('\n§2 experimentOutcomeLabel — pure vocabulary translation, never a second classification:');
      ok('SUCCESSFUL -> IMPROVED', experimentOutcomeLabel('SUCCESSFUL') === 'IMPROVED');
      ok('NEUTRAL -> NO_CHANGE', experimentOutcomeLabel('NEUTRAL') === 'NO_CHANGE');
      ok('FAILED -> WORSE', experimentOutcomeLabel('FAILED') === 'WORSE');
      ok('null/unknown -> INCONCLUSIVE, never a crash', experimentOutcomeLabel(null) === 'INCONCLUSIVE' && experimentOutcomeLabel('garbage') === 'INCONCLUSIVE');

      console.log('\n§3 getProductExperiment — the full checkpoint view for one decision:');
      const view = await getProductExperiment({ recId: rec.id });
      ok('hasExperiment true once an action+checkpoints exist', view.hasExperiment === true, JSON.stringify(view));
      ok('all 3 checkpoint slots are represented even though only H6 was scheduled', view.checkpoints.length === 3);
      const h6 = view.checkpoints.find((c) => c.checkpoint === 'H6');
      ok('H6 shows as EVALUATED with a translated outcome', h6.status === 'EVALUATED' && ['IMPROVED', 'NO_CHANGE', 'WORSE', 'INCONCLUSIVE'].includes(h6.outcome), JSON.stringify(h6));
      const h12 = view.checkpoints.find((c) => c.checkpoint === 'H12');
      ok('H12 (never scheduled) correctly shows NOT_SCHEDULED, not a fabricated result', h12.status === 'NOT_SCHEDULED');
    }
  }

  console.log('\n§4 evaluateProductExperiments NEVER touches a non-product-level action (outcomeEval.js\'s exclusive territory):');
  {
    const rec = await prisma.ambRecommendation.create({ data: baseRecData({ level: 'campaign', amb_product_id: null }) });
    recIds.push(rec.id);
    const { result } = await createDueAction({ rec, level: 'campaign' });
    await evaluateProductExperiments();
    const after = await prisma.ambActionResult.findUnique({ where: { id: result.id } });
    ok('a campaign-level due row is left untouched (evaluated_at still null)', after.evaluated_at === null, JSON.stringify(after));
  }

  console.log('\n§5 evaluateProductExperiments handles an unresolvable product gracefully, never crashes:');
  {
    const rec = await prisma.ambRecommendation.create({ data: baseRecData({ amb_product_id: null }) });
    recIds.push(rec.id);
    const { result } = await createDueAction({ rec });
    const { evaluated } = await evaluateProductExperiments();
    ok('the unresolvable row is still marked evaluated (closed out, not stuck forever)', evaluated >= 1);
    const after = await prisma.ambActionResult.findUnique({ where: { id: result.id } });
    ok('evaluated_at set, result_class explicitly null (no real product to measure against)', after.evaluated_at !== null && after.result_class === null, JSON.stringify(after));
  }

  console.log('\n§6 evaluateProductExperiments is idempotent — an already-evaluated row is never re-processed on a second run:');
  {
    // Scoped to THIS test's own rows only — never a global due-count assertion,
    // since real production checkpoints from other decisions may legitimately
    // be due at the same wall-clock moment (the launchQueueTest.js global-state
    // flakiness lesson from Phase 1 applies here too).
    const ourResultIds = recIds.length ? (await prisma.ambActionResult.findMany({ where: { action: { recommendation_id: { in: recIds } } }, select: { id: true, evaluated_at: true } })) : [];
    await evaluateProductExperiments();
    const after = ourResultIds.length ? await prisma.ambActionResult.findMany({ where: { id: { in: ourResultIds.map((r) => r.id) } }, select: { id: true, evaluated_at: true } }) : [];
    const unchanged = ourResultIds.every((before) => after.find((a) => a.id === before.id)?.evaluated_at?.getTime() === before.evaluated_at?.getTime());
    ok('this test\'s own already-evaluated rows keep the exact same evaluated_at (not silently re-evaluated)', unchanged, JSON.stringify({ ourResultIds, after }));
  }
} finally {
  await cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
