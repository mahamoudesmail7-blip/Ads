// 🧪 Post-Action Monitoring: 6/12/24/48h checkpoints, honest verdicts (improved / worse / insufficient evidence), rollback only SUGGESTED. No Meta call. Disposable __optest_ fixtures.
//   node src/scripts/postActionMonitoringTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const { prisma } = await imp('../prisma.js'); const M = await imp('../services/amb/postActionMonitoring.js');
const T = '__optest_'; const created = { recs: [] };
const ev = (key, cls, pb, pa, extra = {}) => ({ key, hours: +key.slice(1), state: 'EVALUATED', class: cls, purchasesBefore: pb, purchasesAfter: pa, actionType: 'DECREASE_BUDGET', ...extra });

try {
  console.log('\n1. Verdicts (pure)');
  ok('pending checkpoint → PENDING', M.checkpointVerdict({ state: 'PENDING' }).verdict === 'PENDING');
  ok('SUCCESSFUL with enough orders → IMPROVED', M.checkpointVerdict(ev('H24', 'SUCCESSFUL', 5, 6)).verdict === 'IMPROVED');
  ok('FAILED with enough orders → WORSE', M.checkpointVerdict(ev('H24', 'FAILED', 5, 2)).verdict === 'WORSE');
  ok('a budget action judged on < 3 orders is INSUFFICIENT — we do not claim a result or a cause', M.checkpointVerdict(ev('H6', 'SUCCESSFUL', 1, 1)).verdict === 'INSUFFICIENT' && M.checkpointVerdict(ev('H6', null, 9, 9)).verdict === 'INSUFFICIENT');
  ok('a PAUSE/RESUME is judged on spend, not order count', M.checkpointVerdict(ev('H6', 'SUCCESSFUL', 0, 0, { actionType: 'PAUSE' })).verdict === 'IMPROVED');
  ok('NEUTRAL → NO_CHANGE', M.checkpointVerdict(ev('H12', 'NEUTRAL', 5, 5)).verdict === 'NO_CHANGE');
  ok('overall: nothing evaluated yet → PENDING', M.overallVerdict([{ state: 'PENDING' }]).verdict === 'PENDING');
  ok('overall: a WORSE checkpoint that is not overturned by a later IMPROVED stays WORSE', M.overallVerdict([ev('H6', 'FAILED', 5, 1), ev('H12', 'NEUTRAL', 5, 5)]).verdict === 'WORSE');
  ok('overall: later IMPROVED overturns an earlier WORSE', M.overallVerdict([ev('H6', 'FAILED', 5, 1), ev('H24', 'SUCCESSFUL', 5, 8)]).verdict === 'IMPROVED');
  ok('overall: the latest checkpoint with enough evidence wins over insufficient ones', M.overallVerdict([ev('H6', 'SUCCESSFUL', 5, 6), ev('H12', null, 0, 0)]).verdict === 'IMPROVED');

  console.log('\n2. Rollback is a SUGGESTION only');
  const rb = M.rollbackSuggestion({ actionType: 'INCREASE_BUDGET', before: { budget: 300 }, verdict: 'WORSE', level: 'campaign', entityId: 'x', entityName: 'camp' });
  ok('worse budget increase → suggests restoring the old budget (300), executes:false', rb?.restoreTo === 300 && rb.executes === false && rb.type === 'RESTORE_LOWER_BUDGET');
  ok('worse budget reduction → suggests restoring the higher budget', M.rollbackSuggestion({ actionType: 'DECREASE_BUDGET', before: { budget: 300 }, verdict: 'WORSE' })?.type === 'RESTORE_HIGHER_BUDGET');
  ok('worse open → suggests pausing again; worse pause → suggests resuming (never executed)', M.rollbackSuggestion({ actionType: 'RESUME', verdict: 'WORSE', entityId: 'x' })?.type === 'PAUSE_AGAIN' && M.rollbackSuggestion({ actionType: 'PAUSE', verdict: 'WORSE', entityId: 'x' })?.type === 'RESUME_AGAIN');
  ok('no suggestion when improved / insufficient / pending / unknown before-budget', ['IMPROVED', 'INSUFFICIENT', 'PENDING', 'NO_CHANGE'].every((v) => M.rollbackSuggestion({ actionType: 'INCREASE_BUDGET', before: { budget: 300 }, verdict: v }) === null) && M.rollbackSuggestion({ actionType: 'INCREASE_BUDGET', before: {}, verdict: 'WORSE' }) === null);

  console.log('\n3. List from the database (fixture action executed 30h ago)');
  const rec = await prisma.ambRecommendation.create({ data: { batch_id: `${T}mon`, ad_account_id: `${T}acc`, level: 'campaign', entity_id: `${T}mon1`, entity_name: `${T}monitored`, campaign_id: `${T}mon1`, decision: 'SCALE', action_type: 'INCREASE_BUDGET', executable: true, status: 'EXECUTED', confidence: 'HIGH' } }); created.recs.push(rec.id);
  const at = new Date(Date.now() - 30 * 3_600_000);
  const act = await prisma.ambAction.create({ data: { recommendation_id: rec.id, mode: 'APPROVAL', action_type: 'INCREASE_BUDGET', ad_account_id: `${T}acc`, level: 'campaign', entity_id: `${T}mon1`, entity_name: `${T}monitored`, campaign_id: `${T}mon1`, approval_status: 'APPROVED', execution_status: 'EXECUTED', executed_at: at, verified_at: at, executed_by_id: 1, old_value_json: JSON.stringify({ budget: 300 }), new_value_json: JSON.stringify({ budget: 360 }), verify_json: JSON.stringify({ verified: true }) } });
  const mkR = (cp, h, cls, pb, pa) => prisma.ambActionResult.create({ data: { action_id: act.id, checkpoint: cp, due_at: new Date(at.getTime() + h * 3_600_000), evaluated_at: cls === undefined ? null : new Date(), result_class: cls ?? null, cpa_before: 70, cpa_after: 110, purchases_before: pb, purchases_after: pa, spend_before: 400, spend_after: 450, notes_json: JSON.stringify({ note: 'fixture' }) } });
  await mkR('H6', 6, 'SUCCESSFUL', 5, 6); await mkR('H12', 12, 'FAILED', 6, 2); await mkR('H24', 24, undefined, null, null);
  const list = await M.listMonitoredActions({ includeFixtures: true, limit: 100 }); const row = list.find((x) => x.actionId === act.id);
  ok('the action is listed with before → after budget, actor, confidence, Meta verification', !!row && row.before.budget === 300 && row.after.budget === 360 && row.verification.verified === true && row.confidence === 'HIGH' && row.executedAt);
  ok('four checkpoints 6/12/24/48; the missing 48h one was created (due 48h after execution)', row.checkpoints.map((c) => c.key).join() === 'H6,H12,H24,H48' && !!(await prisma.ambActionResult.findFirst({ where: { action_id: act.id, checkpoint: 'H48' } })));
  ok('H6 improved, H12 worse, H24 pending, H48 pending', row.checkpoints[0].verdict === 'IMPROVED' && row.checkpoints[1].verdict === 'WORSE' && row.checkpoints[2].verdict === 'PENDING' && row.checkpoints[3].verdict === 'PENDING');
  ok('overall verdict WORSE (latest evaluated) with a rollback SUGGESTION back to 300 that does not execute', row.verdict === 'WORSE' && row.rollback?.restoreTo === 300 && row.rollback.executes === false);
  ok('real fixtures (__optest_) never appear in the real list', !(await M.listMonitoredActions({ limit: 100 })).some((x) => x.actionId === act.id));
  ok('the same list a second time does not duplicate the 48h checkpoint', (await M.listMonitoredActions({ includeFixtures: true, limit: 100 }), (await prisma.ambActionResult.count({ where: { action_id: act.id, checkpoint: 'H48' } })) === 1));
  const src = fs.readFileSync(join(__dirname, '../services/amb/postActionMonitoring.js'), 'utf8');
  ok('the module has no way to execute: no executor / Meta client / permissions imports', !/executor|metaGraphClient|approveAndExecute|setEntity|graphPost/.test(src.split('\n').filter((l) => /^\s*import\b/.test(l)).join(' ')));
  const oe = fs.readFileSync(join(__dirname, '../services/amb/outcomeEval.js'), 'utf8'), ex = fs.readFileSync(join(__dirname, '../services/amb/executor.js'), 'utf8');
  ok('the outcome engine evaluates H48 and the executor schedules it for every new real action', /H48: 48/.test(oe) && /checkpoint: 'H48'/.test(ex));
} catch (e) {
  fail++; console.log('  ✗ UNEXPECTED', e.stack || e.message);
} finally {
  const recs = await prisma.ambRecommendation.findMany({ where: { OR: [{ id: { in: created.recs } }, { batch_id: `${T}mon` }] }, select: { id: true } });
  await prisma.ambActionResult.deleteMany({ where: { action: { recommendation_id: { in: recs.map((r) => r.id) } } } }).catch(() => {});
  await prisma.ambAction.deleteMany({ where: { recommendation_id: { in: recs.map((r) => r.id) } } }).catch(() => {});
  await prisma.ambRecommendation.deleteMany({ where: { id: { in: recs.map((r) => r.id) } } }).catch(() => {});
  console.log(`\n${fail === 0 ? '✅' : '❌'} postActionMonitoringTest: ${pass} passed, ${fail} failed`);
  await prisma.$disconnect(); process.exit(fail ? 1 : 0);
}
