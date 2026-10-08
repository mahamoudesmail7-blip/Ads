// 🛡️ Executor duplicate guard — the executor's OWN action row must not block itself, while every real duplicate (earlier PENDING / REVALIDATING / EXECUTED, same entity + action,
// within 6h) still blocks, and of several concurrent attempts only ONE can pass. Pure DB fixtures (`__optest_`); NO Meta call anywhere (the executor is never invoked, only the rule engine).
//   node src/scripts/executorDuplicateGuardTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const retryDb = async (fn) => { for (let i = 0; i < 10; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 4000)); } } return fn(); };
const { prisma } = await imp('../prisma.js');
const RE = await imp('../services/amb/ruleEngine.js');
const { getAmbSettings } = await imp('../services/amb/settings.js');
const T = '__optest_'; const ACC = `${T}acc`;
const settings = await getAmbSettings();
const c0 = { actions: await prisma.ambAction.count(), recs: await prisma.ambRecommendation.count() };
let n = 0;
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000);
const mkAction = async (entity, { type = 'DECREASE_BUDGET', status = 'REVALIDATING', createdH = 0 } = {}) => {
  n++;
  const rec = await retryDb(() => prisma.ambRecommendation.create({ data: { batch_id: `${T}b${n}`, ad_account_id: ACC, level: 'campaign', entity_id: entity, entity_name: entity, campaign_id: entity, decision: type, action_type: type, executable: true, current_budget: 300, recommended_budget: 240, reason: 'fixture', confidence: 'HIGH', risk_level: 'LOW', data_sufficiency: 'STRONG', priority: 'P2', source: 'OPERATOR', status: 'PENDING' } }));
  return retryDb(() => prisma.ambAction.create({ data: { recommendation_id: rec.id, mode: 'APPROVAL', action_type: type, ad_account_id: ACC, level: 'campaign', entity_id: entity, campaign_id: entity, approval_status: 'APPROVED', execution_status: status, created_at: hoursAgo(createdH), ...(status === 'EXECUTED' ? { executed_at: hoursAgo(createdH) } : {}) } }));
};
const connection = { status: 'CONNECTED', selected_ad_account_id: ACC, token_expires_at: null };
const validate = async (entity, o = {}) => RE.validateAction({ actionType: o.type || 'DECREASE_BUDGET', level: 'campaign', entityId: entity, campaignId: entity, metrics: { spend: 800, purchases: 4, cpa: 204 }, econ: null, settings, connection, liveEntity: { status: 'ACTIVE' }, currentBudget: 300, recommendedBudget: 240, ...(o.excludeActionId ? { excludeActionId: o.excludeActionId } : {}) });
const dupOf = (v) => v.checks.find((c) => c.name === 'no_recent_duplicate');

try {
  console.log('\n1. the current attempt must not block itself');
  let E = `${T}e1`; const cur = await mkAction(E);
  let v = await validate(E);
  ok('BEFORE the fix path (no excludeActionId, e.g. legacy callers): the row of the attempt itself is found => blocked (documents the bug precondition; unchanged for callers that have no action row)', dupOf(v).ok === false);
  v = await validate(E, { excludeActionId: cur.id });
  ok('with excludeActionId: the current REVALIDATING action does NOT block itself, and the whole validation passes', dupOf(v).ok === true && v.passed === true, JSON.stringify(v.blockers));

  console.log('\n2. a REAL earlier duplicate still blocks (same policy as before)');
  E = `${T}e2`; const prevExec = await mkAction(E, { status: 'EXECUTED', createdH: 1 }); const cur2 = await mkAction(E);
  v = await validate(E, { excludeActionId: cur2.id });
  ok('an EXECUTED identical action 1h ago blocks (POST_EXECUTION_COOLDOWN)', dupOf(v).ok === false && dupOf(v).context?.blockerType === 'POST_EXECUTION_COOLDOWN' && dupOf(v).context.actionId === prevExec.id && v.passed === false);
  E = `${T}e3`; const prevPend = await mkAction(E, { status: 'PENDING', createdH: 2 }); const cur3 = await mkAction(E);
  v = await validate(E, { excludeActionId: cur3.id });
  ok('an earlier PENDING identical action blocks (DUPLICATE_PENDING_ACTION)', dupOf(v).ok === false && dupOf(v).context?.blockerType === 'DUPLICATE_PENDING_ACTION' && dupOf(v).context.actionId === prevPend.id);
  E = `${T}e4`; await mkAction(E, { status: 'REVALIDATING', createdH: 1 }); const cur4 = await mkAction(E);
  v = await validate(E, { excludeActionId: cur4.id });
  ok('an earlier in-flight (REVALIDATING) identical action blocks', dupOf(v).ok === false);
  E = `${T}e5`; await mkAction(E, { status: 'EXECUTED', createdH: 7 }); const cur5 = await mkAction(E);
  v = await validate(E, { excludeActionId: cur5.id });
  ok('an EXECUTED action OLDER than the 6h window does not block', dupOf(v).ok === true);

  console.log('\n3. only actions that count today count (FAILED / ABORTED are not "executed")');
  E = `${T}e6`; await mkAction(E, { status: 'FAILED', createdH: 1 }); await mkAction(E, { status: 'ABORTED_REANALYSIS', createdH: 1 }); const cur6 = await mkAction(E);
  v = await validate(E, { excludeActionId: cur6.id });
  ok('FAILED and ABORTED_REANALYSIS actions are NOT treated as a successful/pending execution (policy unchanged)', dupOf(v).ok === true);
  E = `${T}e7`; await mkAction(E, { type: 'INCREASE_BUDGET', status: 'EXECUTED', createdH: 1 }); await mkAction(`${T}other-entity`, { status: 'EXECUTED', createdH: 1 }); const cur7 = await mkAction(E);
  v = await validate(E, { excludeActionId: cur7.id });
  ok('a different action type on the same entity, or the same action on another entity, does not block', dupOf(v).ok === true);

  console.log('\n4. concurrent duplicate attempts never pass together');
  E = `${T}e8`; const A = await mkAction(E); const Bx = await mkAction(E); const C = await mkAction(E);
  const [vA, vB, vC] = await Promise.all([validate(E, { excludeActionId: A.id }), validate(E, { excludeActionId: Bx.id }), validate(E, { excludeActionId: C.id })]);
  ok('three attempts created back-to-back: exactly ONE passes (the first-created), the other two are blocked by it', [vA, vB, vC].filter((x) => dupOf(x).ok).length === 1 && dupOf(vA).ok === true && dupOf(vB).ok === false && dupOf(vC).ok === false, JSON.stringify([dupOf(vA).ok, dupOf(vB).ok, dupOf(vC).ok]));
  ok('...and the blocker named is the first attempt', dupOf(vB).context.actionId === A.id && dupOf(vC).context.actionId === Bx.id);
  E = `${T}e9`; const first = await mkAction(E); const second = await mkAction(E);
  await prisma.ambAction.update({ where: { id: first.id }, data: { execution_status: 'ABORTED_REANALYSIS' } });
  v = await validate(E, { excludeActionId: second.id });
  ok('if the first attempt ends up ABORTED, a later attempt is no longer blocked by it (an aborted attempt is not an execution)', dupOf(v).ok === true);
  E = `${T}e10`; const exe = await mkAction(E, { status: 'EXECUTED' }); const late = await mkAction(E);
  const [vExe, vLate] = [await validate(E, { excludeActionId: exe.id }), await validate(E, { excludeActionId: late.id })];
  ok('an already-EXECUTED action and a later attempt: the later one is blocked (cannot execute twice), the executed one is not re-judged against the later one', dupOf(vLate).ok === false && dupOf(vExe).ok === true);

  console.log('\n5. wiring + safety');
  const exSrc = fs.readFileSync(join(__dirname, '../services/amb/executor.js'), 'utf8');
  const exec = exSrc.slice(exSrc.indexOf('export async function approveAndExecute'));
  ok('approveAndExecute passes excludeActionId: action.id to the revalidation', /validateAction\(\{[\s\S]*?excludeActionId: action\.id[\s\S]*?\}\);/.test(exec));
  const prev = exSrc.slice(exSrc.indexOf('export async function previewExecution'), exSrc.indexOf('export async function approveAndExecute'));
  ok('previewExecution (no action row) is unchanged: it passes no excludeActionId', !/excludeActionId/.test(prev));
  const rec = fs.readFileSync(join(__dirname, '../services/amb/recommendationEngine.js'), 'utf8');
  ok('recommendation generation (a third caller) is unchanged: no excludeActionId', !/excludeActionId/.test(rec));
  const own = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  ok('this test never imports the executor or the Meta client (no Meta write is even reachable)', !/^import[^\n]*(executor|metaGraphClient)/m.test(own) && !/await imp\('[^']*(executor|metaGraphClient)/.test(own));
} catch (e) { fail++; console.log('  ✗ test crashed —', e.stack || e.message); }
finally {
  try {
    await retryDb(() => prisma.ambAction.deleteMany({ where: { ad_account_id: ACC } }));
    await retryDb(() => prisma.ambRecommendation.deleteMany({ where: { ad_account_id: ACC } }));
    ok('cleanup: no fixture left; AMB actions and recommendations are back to their original counts (nothing was executed)', (await prisma.ambAction.count()) === c0.actions && (await prisma.ambRecommendation.count()) === c0.recs);
  } catch (e) { fail++; console.log('  ✗ cleanup failed —', e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
