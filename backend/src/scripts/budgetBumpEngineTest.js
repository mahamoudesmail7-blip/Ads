// Smart Decision Center — services/amb/budgetBumpEngine.js. Pure logic,
// zero DB dependency — every test case here is taken VERBATIM from the
// spec's own explicit business-rule test list (A-E), plus the hysteresis/
// lifecycle guardrails the spec separately requires.
//   node src/scripts/budgetBumpEngineTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { computeBumpedBudget, evaluateAdSetForBump, evaluateAdSetForRollback, resolveAdSetLifecycleState } = await imp('../services/amb/budgetBumpEngine.js');

console.log('§A CPA=70, sufficient evidence, budget=200 -> recommend 250:');
{
  const r = evaluateAdSetForBump({ cpa: 70, spend: 500, purchases: 8, currentBudget: 200 });
  ok('action is BUMP', r.action === 'BUMP', JSON.stringify(r));
  ok('proposed budget is EXACTLY 250 (200 * 1.25)', r.proposedBudget === 250, r.proposedBudget);
}

console.log('\n§B After a successful bump: current budget=250, CPA=65, sufficient evidence -> recommend 312.50 (compounding from CURRENT, never a fixed +50):');
{
  const r = evaluateAdSetForBump({ cpa: 65, spend: 600, purchases: 10, currentBudget: 250 });
  ok('action is BUMP', r.action === 'BUMP');
  ok('proposed budget is EXACTLY 312.50 (250 * 1.25), never 250+50=300', r.proposedBudget === 312.5, r.proposedBudget);
}

console.log('\n§ compounding chain sanity — 200 -> 250 -> 312.50 -> 390.63 (never +50 flat each time):');
{
  let b = 200;
  const steps = [250, 312.5, 390.63];
  for (const expected of steps) {
    b = computeBumpedBudget(b, 25);
    ok(`step lands on ${expected}`, b === expected, b);
  }
}

console.log('\n§C budget_before=250, budget_after=312.50, CPA rises above 100 with sufficient evidence -> rollback candidate EXACTLY 250 (never -25% off 312.50):');
{
  const r = evaluateAdSetForRollback({ cpa: 115, spend: 400, purchases: 6, budgetBefore: 250, budgetAfter: 312.5 });
  ok('action is ROLLBACK', r.action === 'ROLLBACK', JSON.stringify(r));
  ok('proposed budget is EXACTLY 250, never 312.50 * 0.75 = 234.375', r.proposedBudget === 250, r.proposedBudget);
  ok('never miscalculated as a generic -25% off the post-bump budget', r.proposedBudget !== Math.round(312.5 * 0.75 * 100) / 100);
}

console.log('\n§D CPA=70 but insufficient spend/results -> WAIT, no bump:');
{
  const r1 = evaluateAdSetForBump({ cpa: 70, spend: 40, purchases: 1, currentBudget: 200 });
  ok('too little spend/results -> WAIT, never BUMP', r1.action === 'WAIT', JSON.stringify(r1));
  const r2 = evaluateAdSetForBump({ cpa: 70, spend: 500, purchases: 2, currentBudget: 200 });
  ok('enough spend but too few results -> still WAIT', r2.action === 'WAIT', JSON.stringify(r2));
}

console.log('\n§E Product CPA < 80 overall but THIS Ad Set\'s own CPA > threshold -> do NOT bump this ad set (pure per-ad-set evaluation):');
{
  // The function only ever receives ONE ad set's own numbers — proving
  // isolation means proving a good number elsewhere cannot leak in: this
  // ad set's own CPA of 95 must never be bumped no matter what a sibling
  // ad set or the product rollup looks like.
  const adSetB = evaluateAdSetForBump({ cpa: 95, spend: 500, purchases: 10, currentBudget: 200 });
  ok('Ad Set B (its own CPA 95 >= 80) is never recommended for a bump', adSetB.action !== 'BUMP', JSON.stringify(adSetB));
  ok('reason cites Ad Set B\'s own CPA, not a product-level figure', /95/.test(adSetB.reason));
}

console.log('\n§ evaluateAdSetForBump — never bumps at/above the exact threshold (strict <), never fabricates from a null CPA:');
{
  ok('CPA exactly at threshold (80) does not bump', evaluateAdSetForBump({ cpa: 80, spend: 500, purchases: 10, currentBudget: 200 }).action !== 'BUMP');
  ok('a null CPA (no real data) never bumps', evaluateAdSetForBump({ cpa: null, spend: 500, purchases: 10, currentBudget: 200 }).action === 'WAIT');
  ok('no known current budget -> WAIT, never a fabricated budget change', evaluateAdSetForBump({ cpa: 50, spend: 500, purchases: 10, currentBudget: null }).action === 'WAIT');
}

console.log('\n§ evaluateAdSetForRollback — never rolls back on thin post-bump evidence, never below the exact threshold:');
{
  const thin = evaluateAdSetForRollback({ cpa: 150, spend: 30, purchases: 1, budgetBefore: 200, budgetAfter: 250 });
  ok('CPA 150 but far too little post-bump evidence -> OBSERVING, never a premature rollback', thin.action === 'OBSERVING', JSON.stringify(thin));
  const healthy = evaluateAdSetForRollback({ cpa: 90, spend: 400, purchases: 8, budgetBefore: 200, budgetAfter: 250 });
  ok('CPA 90 (under the 100 rollback threshold) with real evidence -> BUMP_SUCCESS, not a rollback', healthy.action === 'BUMP_SUCCESS', JSON.stringify(healthy));
}

console.log('\n§ resolveAdSetLifecycleState — hysteresis/cooldown prevents +25%/-25%/+25% oscillation:');
{
  const pending = resolveAdSetLifecycleState({ latestAction: { type: 'BUMP', status: 'PENDING', at: new Date().toISOString() } });
  ok('a PENDING recommendation blocks a duplicate new one', pending.canEvaluateBump === false && pending.state === 'BUMP_RECOMMENDED');

  const justExecuted = resolveAdSetLifecycleState({ latestAction: { type: 'BUMP', status: 'EXECUTED', at: new Date().toISOString() } });
  ok('a just-executed bump (0h old) cannot be rolled back yet — mandatory observation window', justExecuted.canEvaluateRollback === false && justExecuted.state === 'OBSERVING_AFTER_BUMP');

  const sixHoursAgo = new Date(Date.now() - 6.5 * 3600000).toISOString();
  const pastEvalWindow = resolveAdSetLifecycleState({ latestAction: { type: 'BUMP', status: 'EXECUTED', at: sixHoursAgo } });
  ok('past the minimum evaluation window, rollback CAN now be evaluated', pastEvalWindow.canEvaluateRollback === true);
  ok('but a fresh re-bump is still blocked by the 24h cooldown', pastEvalWindow.canEvaluateBump === false);

  const oneDayAgo = new Date(Date.now() - 25 * 3600000).toISOString();
  const pastCooldown = resolveAdSetLifecycleState({ latestAction: { type: 'BUMP', status: 'EXECUTED', at: oneDayAgo } });
  ok('past the 24h bump cooldown, a new bump CAN be evaluated again', pastCooldown.canEvaluateBump === true);

  const justRolledBack = resolveAdSetLifecycleState({ latestAction: { type: 'ROLLBACK', status: 'EXECUTED', at: new Date().toISOString() } });
  ok('a fresh rollback blocks an immediate re-bump (48h cooldown, prevents +25%/-25%/+25% thrash)', justRolledBack.canEvaluateBump === false && justRolledBack.state === 'COOLDOWN');

  const longAfterRollback = resolveAdSetLifecycleState({ latestAction: { type: 'ROLLBACK', status: 'EXECUTED', at: new Date(Date.now() - 49 * 3600000).toISOString() } });
  ok('well past the rollback cooldown, bumping can resume', longAfterRollback.canEvaluateBump === true && longAfterRollback.state === 'STABLE');

  const neverActed = resolveAdSetLifecycleState({ latestAction: null });
  ok('an ad set with no bump history at all starts STABLE and evaluable', neverActed.state === 'STABLE' && neverActed.canEvaluateBump === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
