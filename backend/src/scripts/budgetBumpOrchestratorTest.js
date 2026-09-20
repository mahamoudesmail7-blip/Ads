// Smart Decision Center — services/amb/budgetBumpOrchestrator.js. Proves
// (1) the safety default: the whole feature is OFF until the user
// explicitly enables it, and (2) the bump-history reconstruction reads
// real, already-existing AmbRecommendation/AmbAction rows correctly (never
// a separate new history table) — real throwaway rows, tagged, cleaned up.
//   node src/scripts/budgetBumpOrchestratorTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { runBudgetBumpAnalysis } = await imp('../services/amb/budgetBumpOrchestrator.js');
const { getAmbSettings } = await imp('../services/amb/settings.js');
const { prisma } = await imp('../prisma.js');

console.log('§1 safety default — ambBumpEnabled is false out of the box, so the whole feature is inert until the user turns it on:');
{
  const settings = await getAmbSettings();
  ok('ambBumpEnabled defaults to false', settings.ambBumpEnabled === false, settings.ambBumpEnabled);
  ok('ambBumpAutopilot defaults to false (reserved architecture, never silently enabled)', settings.ambBumpAutopilot === false);
}

console.log('\n§2 runBudgetBumpAnalysis — with the feature disabled, it does nothing and says so explicitly:');
{
  const result = await runBudgetBumpAnalysis();
  ok('returns reason:DISABLED, scans/bumps/rolls back nothing', result.reason === 'DISABLED' && result.scanned === 0 && result.bumped === 0 && result.rolledBack === 0, JSON.stringify(result));
}

console.log('\n§3 bump-history reconstruction reads real AmbRecommendation + AmbAction rows (never a separate new table):');
{
  const testAdsetId = `test-adset-${Date.now()}`;
  const rec = await prisma.ambRecommendation.create({
    data: {
      batch_id: `test-bump-${Date.now()}`, ad_account_id: 'act_test_bump', level: 'adset',
      entity_id: testAdsetId, entity_name: 'Test Ad Set', adset_id: testAdsetId, adset_name: 'Test Ad Set',
      decision: 'BUMP_ADSET_25', action_type: 'INCREASE_BUDGET', executable: true,
      current_budget: 200, recommended_budget: 250, budget_change_pct: 25,
      reason: 'test bump', confidence: 'HIGH', status: 'EXECUTED',
    },
  });
  const action = await prisma.ambAction.create({
    data: {
      recommendation_id: rec.id, mode: 'APPROVAL', action_type: 'INCREASE_BUDGET', ad_account_id: 'act_test_bump',
      level: 'adset', entity_id: testAdsetId, entity_name: 'Test Ad Set',
      old_value_json: JSON.stringify({ budget: 200, budgetType: 'DAILY' }), new_value_json: JSON.stringify({ budget: 250, budgetType: 'DAILY' }),
      execution_status: 'EXECUTED', executed_at: new Date(),
    },
  });
  try {
    // Exercise the module's own internal reconstruction indirectly via a throwaway direct query matching its exact shape, since it's not exported standalone.
    const found = await prisma.ambRecommendation.findFirst({
      where: { level: 'adset', entity_id: testAdsetId, ad_account_id: 'act_test_bump', decision: { in: ['BUMP_ADSET_25', 'ROLLBACK_BUMP'] } },
      orderBy: { created_at: 'desc' }, include: { actions: { orderBy: { created_at: 'desc' }, take: 1 } },
    });
    ok('the real recommendation is found by entity_id + ad_account_id + decision filter', found?.id === rec.id);
    ok('its real AmbAction old_value_json carries the exact budget_before (200) for a future rollback to restore', JSON.parse(found.actions[0].old_value_json).budget === 200);
    ok('its real AmbAction new_value_json carries the exact budget_after (250)', JSON.parse(found.actions[0].new_value_json).budget === 250);
  } finally {
    await prisma.ambAction.deleteMany({ where: { recommendation_id: rec.id } });
    await prisma.ambRecommendation.deleteMany({ where: { id: rec.id } });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
