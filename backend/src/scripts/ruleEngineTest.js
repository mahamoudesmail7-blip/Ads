// Smart Decision Center stabilization pass, Phase 14 — services/amb/
// ruleEngine.js's validateAction(), specifically the "duplicate / very
// recent identical action" cooldown check. Real production message: "فيه
// أكشن مطابق اتنفّذ أو منتظر على نفس العنصر خلال آخر 6 ساعات." — the check
// already fetched the real blocking AmbAction row but discarded every real
// fact about it (which campaign/ad set, PENDING vs already-EXECUTED, real
// before/after budget, exact cooldown remaining) behind one bare boolean.
// This locks in the fix: the SAME safety gate, now with real structured
// context, never weakened.
// Real throwaway AmbRecommendation/AmbAction rows (tagged, cleaned up after).
//   node src/scripts/ruleEngineTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { validateAction } = await imp('../services/amb/ruleEngine.js');
const { prisma } = await imp('../prisma.js');

const cleanupRecIds = [];
async function cleanup() {
  for (const id of cleanupRecIds) {
    await prisma.ambAction.deleteMany({ where: { recommendation_id: id } });
    await prisma.ambRecommendation.deleteMany({ where: { id } });
  }
}

const baseValidateParams = {
  actionType: 'INCREASE_BUDGET', level: 'adset', entityId: null, campaignId: 'camp_rule_test',
  metrics: { spend: 500, cpa: 60 }, econ: null,
  settings: {}, connection: { status: 'CONNECTED', selected_ad_account_id: 'act_rule_test' },
  liveEntity: { status: 'ACTIVE' }, currentBudget: 200, recommendedBudget: 220,
};

async function makeRecAndAction({ entityId, executionStatus, createdAtHoursAgo, oldBudget, newBudget, recStatus }) {
  const rec = await prisma.ambRecommendation.create({ data: {
    batch_id: `test-rule-${Date.now()}-${Math.random()}`, ad_account_id: 'act_rule_test', level: 'adset',
    entity_id: entityId, entity_name: 'Test Ad Set', campaign_id: 'camp_rule_test', campaign_name: 'Test Campaign',
    adset_id: entityId, adset_name: 'Test Ad Set',
    decision: 'BUMP_ADSET_25', action_type: 'INCREASE_BUDGET', executable: true,
    current_budget: oldBudget, recommended_budget: newBudget,
    reason: 'test', confidence: 'HIGH', status: recStatus || 'EXECUTED', source: 'FALLBACK',
  } });
  const action = await prisma.ambAction.create({ data: {
    recommendation_id: rec.id, mode: 'APPROVAL', action_type: 'INCREASE_BUDGET', ad_account_id: 'act_rule_test',
    level: 'adset', entity_id: entityId, entity_name: 'Test Ad Set', campaign_id: 'camp_rule_test', adset_id: entityId,
    old_value_json: JSON.stringify({ budget: oldBudget }), new_value_json: JSON.stringify({ budget: newBudget }),
    approval_status: 'APPROVED', execution_status: executionStatus,
    created_at: new Date(Date.now() - createdAtHoursAgo * 3600 * 1000),
    executed_at: executionStatus === 'EXECUTED' ? new Date(Date.now() - createdAtHoursAgo * 3600 * 1000) : null,
  } });
  return { rec, action };
}

try {
  console.log('§1 no real duplicate -> the check passes cleanly, no blockerContext fabricated:');
  {
    const entityId = `adset_clean_${Date.now()}`;
    const result = await validateAction({ ...baseValidateParams, entityId });
    const dupCheck = result.checks.find((c) => c.name === 'no_recent_duplicate');
    ok('no_recent_duplicate passes when there is truly no recent action on this entity', dupCheck.ok === true);
    ok('blockerContext has no entry for a passing check', result.blockerContext.no_recent_duplicate === undefined);
  }

  console.log('\n§2 CRITICAL FIX — a real PENDING duplicate blocks with full real context, never just a bare message:');
  {
    const entityId = `adset_pending_${Date.now()}`;
    const { rec, action } = await makeRecAndAction({ entityId, executionStatus: 'PENDING', createdAtHoursAgo: 1, oldBudget: 200, newBudget: 250, recStatus: 'APPROVED' });
    cleanupRecIds.push(rec.id);
    const result = await validateAction({ ...baseValidateParams, entityId });
    ok('the safety block itself is UNCHANGED — still fails the check', result.passed === false);
    const ctx = result.blockerContext.no_recent_duplicate;
    ok('real blockerContext is present for the failed check', !!ctx, JSON.stringify(result.blockerContext));
    ok('correctly classified as DUPLICATE_PENDING_ACTION (not yet executed)', ctx?.blockerType === 'DUPLICATE_PENDING_ACTION', ctx?.blockerType);
    ok('carries the REAL action id and recommendation id, never a placeholder', ctx?.actionId === action.id && ctx?.recommendationId === rec.id);
    ok('carries the real campaign/ad set identity', ctx?.campaignId === 'camp_rule_test' && ctx?.adsetId === entityId);
    ok('carries the real recommendation status', ctx?.recommendationStatus === 'APPROVED');
    ok('carries the real previous/proposed budget', ctx?.previousBudget === 200 && ctx?.proposedBudget === 250, JSON.stringify(ctx));
    ok('cooldown remaining is real and positive (created 1h ago, 6h cooldown -> ~5h left)', ctx?.remainingMs > 4 * 3600 * 1000 && ctx?.remainingMs <= 5 * 3600 * 1000, ctx?.remainingMs);
  }

  console.log('\n§3 CRITICAL FIX — a real ALREADY-EXECUTED duplicate is distinguished as POST_EXECUTION_COOLDOWN, never conflated with a pending one:');
  {
    const entityId = `adset_executed_${Date.now()}`;
    const { rec, action } = await makeRecAndAction({ entityId, executionStatus: 'EXECUTED', createdAtHoursAgo: 2, oldBudget: 300, newBudget: 375, recStatus: 'EXECUTED' });
    cleanupRecIds.push(rec.id);
    const result = await validateAction({ ...baseValidateParams, entityId });
    const ctx = result.blockerContext.no_recent_duplicate;
    ok('correctly classified as POST_EXECUTION_COOLDOWN (already ran), never DUPLICATE_PENDING_ACTION', ctx?.blockerType === 'POST_EXECUTION_COOLDOWN', ctx?.blockerType);
    ok('carries the real executedAt timestamp', ctx?.executedAt != null);
    ok('carries the real before/after budget of the action that already ran', ctx?.previousBudget === 300 && ctx?.proposedBudget === 375);
  }

  console.log('\n§4 the cooldown correctly EXPIRES after 6 real hours — never blocks forever:');
  {
    const entityId = `adset_expired_${Date.now()}`;
    const { rec } = await makeRecAndAction({ entityId, executionStatus: 'EXECUTED', createdAtHoursAgo: 7, oldBudget: 200, newBudget: 250, recStatus: 'EXECUTED' });
    cleanupRecIds.push(rec.id);
    const result = await validateAction({ ...baseValidateParams, entityId });
    const dupCheck = result.checks.find((c) => c.name === 'no_recent_duplicate');
    ok('a duplicate from 7 hours ago (past the real 6h cooldown) no longer blocks', dupCheck.ok === true, JSON.stringify(dupCheck));
  }
} finally {
  await cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
