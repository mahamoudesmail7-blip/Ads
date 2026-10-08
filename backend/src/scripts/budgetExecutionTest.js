// 🧪 Budget-decision execution bridge — every gate fails closed; the Meta write is ALWAYS a stub here (no Meta call). Disposable "__optest_" fixtures, always cleaned up.
//   node src/scripts/budgetExecutionTest.js
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
const BX = await imp('../services/amb/budgetExecution.js');
const BO = await imp('../services/amb/budgetOptimizer.js');
const S = await imp('../services/amb/operatorStore.js');
const T = '__optest_';
const realCfg = await S.getOperatorConfig();
const c0 = { actions: await prisma.ambAction.count(), decisions: await prisma.ambOperatorDecision.count() };
const cfg = (o = {}) => ({ mode: 'APPROVAL', emergency_stop: false, writesLocked: false, limits: realCfg.limits, ...o });
let seq = 0;
const mkDecision = async (o = {}) => {
  const n = ++seq; const level = o.level || 'campaign'; const entityId = o.entityId || `${T}e${n}`; const campaignId = o.campaignId || `${T}c${n}`;
  const d = await retryDb(() => prisma.ambOperatorDecision.create({ data: { decision_key: `${T}k${n}-${Date.now()}`, status: o.status || 'PREPARED', store_id: 'trendy-storeee', product_id: null, ad_account_id: `${T}acc`, campaign_id: campaignId, campaign_name: `${T}campaign ${n}`, action: o.action || 'SCALE_DOWN', rule_id: null, rule_name: o.rule_name || 'DYNAMIC_BUDGET:DYN_HIGH_CPA_REDUCE', mode_at_decision: 'APPROVAL', confidence: 'HIGH', blocked_codes_json: '[]', evidence_json: JSON.stringify({ history: {}, evidence: { cpa: 204, spend: 611, purchases: 3 }, m3: { spend: 815, purchases: 4, cpa: 204 } }), why_json: JSON.stringify({ why: 'fixture' }), params_json: JSON.stringify({ pct: 20, fromBudget: 300, toBudget: 240, level, entityId, window: 'last3' }), before_json: '{}' } }));
  return { d, campaignId, entityId, level };
};
const freshRow = (m, o = {}) => ({ campaignId: m.campaignId, product: 'fixture product', m3: { spend: 815, purchases: 4, cpa: 204 }, entity: { level: m.level, id: m.entityId, budget: 300, name: null }, decision: 'WOULD_REDUCE', intended: { action: 'SCALE_DOWN', pct: 20, fromBudget: 300, toBudget: 240 }, wouldBe: 'PREPARED', primaryBlock: null, guards: ['ECONOMICS_INCOMPLETE[W]'], requiresApproval: false, evidence: { cpa: 204 }, ...o });
const evalWith = (m, o = {}, src = 'META_LIVE') => async () => ({ policy: BO.DEFAULT_POLICY, adAccountId: `${T}acc`, structureSource: src, rows: [freshRow(m, o)] });
let execCalls = 0, lastExecArgs = null;
const stubExec = (kind = 'verified', m) => async (args) => {
  execCalls++; lastExecArgs = args;
  if (kind === 'throw') throw new Error('Meta unreachable (stub)');
  const rec = await prisma.ambRecommendation.findUnique({ where: { id: args.recId } });
  if (kind === 'aborted') return { ok: false, aborted: true, message: 'revalidation refused (stub)' };
  const a = await prisma.ambAction.create({ data: { recommendation_id: rec.id, mode: args.mode, action_type: rec.action_type, ad_account_id: rec.ad_account_id, level: rec.level, entity_id: rec.entity_id, entity_name: rec.entity_name, campaign_id: rec.campaign_id, adset_id: rec.adset_id, approval_status: 'APPROVED', execution_status: 'EXECUTED', executed_at: new Date(), verified_at: new Date(), old_value_json: JSON.stringify({ budget: 300, budgetType: 'DAILY' }), new_value_json: JSON.stringify({ budget: 240, budgetType: 'DAILY' }), meta_request_json: JSON.stringify({ id: rec.entity_id, dailyBudgetMinor: 24000 }), verify_json: JSON.stringify({ verified: kind === 'verified', live: { budgetMajor: kind === 'verified' ? 240 : 300 } }) } });
  await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'EXECUTED' } });
  return { ok: true, actionId: a.id };
};
const run = (m, o = {}) => BX.executeBudgetDecision({ decisionId: m.d.id, userId: 1, deps: { config: cfg(), evaluate: evalWith(m), approveAndExecute: stubExec('verified', m), policy: BO.DEFAULT_POLICY, ...o } });
const statusOf = async (m) => (await prisma.ambOperatorDecision.findUnique({ where: { id: m.d.id } })).status;

try {
  console.log('\n1. gates (nothing is sent; the decision stays PREPARED when only the configuration refuses)');
  let m = await mkDecision(); let r;
  for (const [label, c, code] of [['mode SHADOW', cfg({ mode: 'SHADOW' }), 'MODE_NOT_APPROVAL'], ['mode OFF (MANUAL)', cfg({ mode: 'OFF' }), 'MODE_NOT_APPROVAL'], ['mode AUTOPILOT (never from this bridge)', cfg({ mode: 'AUTOPILOT' }), 'AUTOPILOT_NOT_ALLOWED_HERE'], ['Emergency Stop', cfg({ emergency_stop: true }), 'EMERGENCY_STOP'], ['deployment write-lock', cfg({ writesLocked: true }), 'META_WRITES_LOCKED']]) {
    execCalls = 0; r = await run(m, { config: c });
    ok(`${label} => BLOCKED (${code}), no executor call, decision still PREPARED`, r.status === 'BLOCKED' && r.blocked === code && execCalls === 0 && (await statusOf(m)) === 'PREPARED', JSON.stringify(r));
  }
  ok('no recommendation / action was created by the refused attempts', (await prisma.ambRecommendation.count({ where: { ad_account_id: `${T}acc` } })) === 0 && (await prisma.ambAction.count({ where: { ad_account_id: `${T}acc` } })) === 0);
  try { await BX.executeBudgetDecision({ decisionId: m.d.id, userId: null, deps: { config: cfg() } }); ok('a call without a human user id is refused', false); } catch (e) { ok('a call without a human user id is refused (no Autopilot path)', e.status === 400); }
  const up = await mkDecision({ action: 'SCALE_UP' }); r = await run(up, { config: cfg({ execPermissions: { open: false, pause: false, budgetIncrease: false, budgetDecrease: true } }) });
  ok('an INCREASE needs its OWN permission (budgetIncrease OFF, even with budgetDecrease ON) — refused, still PREPARED', r.blocked === 'PERMISSION_OFF' && (await statusOf(up)) === 'PREPARED' && execCalls === 0);
  const pz = await mkDecision({ action: 'PAUSE' }); r = await run(pz);
  ok('a PAUSE is not enabled for execution either', r.status === 'ACTION_NOT_ENABLED');
  const notBudget = await mkDecision({ rule_name: 'some user rule' }); r = await run(notBudget);
  ok('a decision that is not a Dynamic Budget decision is refused', r.status === 'NOT_A_BUDGET_DECISION');
  const sh = await mkDecision({ status: 'SHADOW' }); r = await run(sh);
  ok('only a PREPARED decision can execute (a SHADOW row cannot)', r.status === 'SHADOW' && execCalls === 0);

  console.log('\n2. fresh LIVE re-evaluation — the same decision or nothing (EXPIRES, nothing written to Meta)');
  const cases = [
    ['live budget moved (300 → 250 by the owner)', { entity: { level: 'campaign', id: null, budget: 250 } }, 'BUDGET_CHANGED'],
    ['the decision is no longer a reduction (KEEP)', { decision: 'KEEP', intended: null }, 'DECISION_CHANGED'],
    ['a BLOCK guard appeared (manual-override cooldown)', { decision: 'PROTECTED', primaryBlock: 'MANUAL_OVERRIDE_COOLDOWN', guards: ['MANUAL_OVERRIDE_COOLDOWN[B]:24h'] }, 'GUARD_BLOCK'],
    ['the proposed budget changed (300 → 270)', { intended: { action: 'SCALE_DOWN', pct: 10, fromBudget: 300, toBudget: 270 } }, 'PROPOSAL_CHANGED'],
    ['the evidence drifted (CPA 204 → 290)', { evidence: { cpa: 290 } }, 'EVIDENCE_DRIFT'],
  ];
  for (const [label, o, code] of cases) {
    m = await mkDecision(); execCalls = 0; const oo = { ...o }; if (oo.entity) oo.entity = { ...oo.entity, id: m.entityId };
    r = await run(m, { evaluate: evalWith(m, oo) });
    ok(`${label} => EXPIRED (${code}), executor never called`, r.status === 'EXPIRED' && r.reasons.some((x) => x.code === code) && (await statusOf(m)) === 'EXPIRED' && execCalls === 0, JSON.stringify(r.reasons));
  }
  m = await mkDecision(); execCalls = 0; r = await run(m, { evaluate: evalWith(m, {}, 'META_SYNC_SNAPSHOT (live unavailable)') });
  ok('Meta could not be read live (fell back to the synced copy) => EXPIRED (NO_LIVE_DATA), executor never called', r.status === 'EXPIRED' && r.reasons.some((x) => x.code === 'NO_LIVE_DATA') && execCalls === 0, JSON.stringify(r.reasons));
  m = await mkDecision(); execCalls = 0; r = await run(m, { evaluate: async () => ({ policy: BO.DEFAULT_POLICY, structureSource: 'META_LIVE', rows: [] }) });
  ok('the entity disappeared from the live data => EXPIRED (ENTITY_NOT_FOUND)', r.status === 'EXPIRED' && r.reasons[0].code === 'ENTITY_NOT_FOUND' && execCalls === 0);

  console.log('\n3. the owner-approved execution (stubbed Meta): REQUESTED → SENT → READ-BACK → VERIFIED → COOLDOWN');
  m = await mkDecision(); execCalls = 0; r = await run(m);
  const dec = await prisma.ambOperatorDecision.findUnique({ where: { id: m.d.id } }); const rec = await prisma.ambRecommendation.findUnique({ where: { id: dec.amb_recommendation_id } }); const act = await prisma.ambAction.findFirst({ where: { recommendation_id: rec.id } });
  ok('exactly ONE executor call, in APPROVAL mode, by the human user', execCalls === 1 && lastExecArgs.mode === 'APPROVAL' && lastExecArgs.userId === 1);
  ok('the CBO recommendation targets the CAMPAIGN: DECREASE_BUDGET 300 → 240 (−20%), level campaign, executable', rec.level === 'campaign' && rec.entity_id === m.entityId && rec.action_type === 'DECREASE_BUDGET' && rec.current_budget === 300 && rec.recommended_budget === 240 && rec.budget_change_pct === -20 && rec.executable === true && rec.source === 'OPERATOR', JSON.stringify(rec).slice(0, 300));
  ok('VERIFIED only because the read-back confirmed it: decision VERIFIED with before → after, approver, verify json', dec.status === 'VERIFIED' && dec.approved_by_id === 1 && dec.approval_source === 'USER' && dec.verified_at && JSON.parse(dec.before_json).budget === 300 && JSON.parse(dec.after_json).budget === 240 && JSON.parse(dec.verify_json).verified === true && dec.amb_action_id === act.id);
  ok('the stage report: requested, sent (with the exact request), read-back (live budget 240), VERIFIED, cooldown 48h', !!r.stages.requested && r.stages.sentToMeta?.request?.dailyBudgetMinor === 24000 && r.stages.readBack?.liveBudgetAfter === 240 && r.stages.verified === 'VERIFIED' && r.stages.cooldown.hours === 48 && new Date(r.stages.cooldown.until) - new Date(r.stages.cooldown.from) === 48 * 3_600_000, JSON.stringify(r.stages));
  ok('rollback data captured before the write (previous 300)', JSON.parse(dec.rollback_json).previous.budget === 300);
  const ev = await prisma.ambOperatorEvent.findMany({ where: { decision_id: m.d.id }, orderBy: { id: 'asc' } });
  ok('audit trail: PREPARED→EXECUTING→VERIFIED transitions with the actor', ev.map((e) => e.to_status).join() === 'EXECUTING,VERIFIED' && ev.every((e) => e.actor_id === 1));
  const r2 = await run(m);
  ok('a second call on the same decision is refused (executes once, never twice)', r2.status === 'VERIFIED' && r2.executed === false && execCalls === 1);
  const lc = await BO.loadLastBudgetChanges({ entityIds: [m.entityId], campaignIds: [m.campaignId] });
  ok('COOLDOWN is automatic: the optimizer now sees SCALE_DOWN 300→240 as the entity\'s last change', lc.get(m.entityId)?.action === 'SCALE_DOWN' && lc.get(m.entityId).to === 240, JSON.stringify([...lc]));
  const cl = BO.classifyBudget({ m: { spend: 900, purchases: 4, cpa: 225 }, lastChange: lc.get(m.entityId), since: { spend: 500, purchases: 1, cpa: 500 }, now: new Date() });
  ok('...and the next decision on this entity is a COOLDOWN (no second change inside 48h)', cl.zone === 'COOLDOWN' && cl.action === null);

  console.log('\n4. ABO: the write targets the AD SET');
  m = await mkDecision({ level: 'adset' }); execCalls = 0; r = await run(m);
  const decA = await prisma.ambOperatorDecision.findUnique({ where: { id: m.d.id } }); const recA = await prisma.ambRecommendation.findUnique({ where: { id: decA.amb_recommendation_id } });
  ok('ABO: level adset, entity = adset id, adset_id set, campaign_id kept', recA.level === 'adset' && recA.entity_id === m.entityId && recA.adset_id === m.entityId && recA.campaign_id === m.campaignId && decA.status === 'VERIFIED');

  console.log('\n5. honesty when Meta does not confirm');
  m = await mkDecision(); execCalls = 0; r = await run(m, { approveAndExecute: stubExec('unverified', m) });
  ok('read-back did NOT confirm => status EXECUTED / "Unverified", verified=false, never claimed as VERIFIED', r.ok === true && r.verified === false && r.status === 'EXECUTED' && r.stages.verified === 'UNVERIFIED' && (await statusOf(m)) === 'EXECUTED' && /Unverified/.test(r.message), JSON.stringify([r.status, r.verified, r.message]));
  m = await mkDecision(); r = await run(m, { approveAndExecute: stubExec('throw', m) });
  ok('the executor throws (Meta unreachable) => FAILED, not executed, no cooldown, no success claim', r.ok === false && r.status === 'FAILED' && r.executed === false && r.stages.cooldown === null && (await statusOf(m)) === 'FAILED');
  m = await mkDecision(); r = await run(m, { approveAndExecute: stubExec('aborted', m) });
  ok('the executor\'s own revalidation refuses => BLOCKED, nothing sent', r.ok === false && r.status === 'BLOCKED' && (await statusOf(m)) === 'BLOCKED');

  console.log('\n5b. the executor errors AFTER a request may have gone out (e.g. the verification read is rate-limited): Meta is read independently, the truth is reported');
  const stubSentThenThrow = (m) => async (args) => { execCalls++; const rec0 = await prisma.ambRecommendation.findUnique({ where: { id: args.recId } }); await prisma.ambAction.create({ data: { recommendation_id: rec0.id, mode: args.mode, action_type: rec0.action_type, ad_account_id: rec0.ad_account_id, level: rec0.level, entity_id: rec0.entity_id, campaign_id: rec0.campaign_id, approval_status: 'APPROVED', execution_status: 'FAILED', old_value_json: JSON.stringify({ budget: 300 }), new_value_json: JSON.stringify({ budget: 240 }), meta_request_json: JSON.stringify({ id: rec0.entity_id, dailyBudgetMinor: 24000 }), meta_error: 'User request limit reached (rate limit)' } }); throw new Error('rate limit during verification (stub)'); };
  m = await mkDecision(); execCalls = 0; r = await run(m, { approveAndExecute: stubSentThenThrow(m), readBack: async () => ({ budget: 240, status: 'ACTIVE' }) });
  const dR = await prisma.ambOperatorDecision.findUnique({ where: { id: m.d.id } }); const aR = await prisma.ambAction.findFirst({ where: { recommendation_id: dR.amb_recommendation_id } });
  ok('Meta HAD applied it (independent read-back = 240): reported as applied + verified by the independent read, flagged reconciled, the failed AMB action row corrected', r.ok === true && r.verified === true && r.reconciled === true && r.status === 'VERIFIED' && r.stages.readBack.independent === true && r.stages.readBack.liveBudgetAfter === 240 && dR.status === 'VERIFIED' && aR.execution_status === 'EXECUTED' && !!aR.executed_at, JSON.stringify([r.status, r.reconciled, aR.execution_status]));
  m = await mkDecision(); r = await run(m, { approveAndExecute: stubSentThenThrow(m), readBack: async () => ({ budget: 300, status: 'ACTIVE' }) });
  ok('Meta did NOT apply it (read-back still 300): FAILED, says so, no cooldown, no success claim', r.ok === false && r.status === 'FAILED' && /الميزانية الحالية 300/.test(r.message) && r.stages.cooldown === null && r.metaState.budget === 300);
  m = await mkDecision(); r = await run(m, { approveAndExecute: stubSentThenThrow(m), readBack: async () => null });
  ok('Meta cannot be read: FAILED with "state unknown — check manually" (never a guess)', r.ok === false && r.status === 'FAILED' && /غير مؤكدة/.test(r.message) && r.stages.readBack.unreadable === true);

  console.log('\n6. prepareBudgetDecision persists ONLY the one actionable row');
  const other = await mkDecision({ status: 'SHADOW' });
  const pm = { campaignId: `${T}cp`, entityId: `${T}ep`, level: 'campaign' };
  const row = freshRow(pm, { storeId: 'trendy-storeee', productId: null, campaign: `${T}prep`, rule: 'DYN_HIGH_CPA_REDUCE', zone: 'HIGH_CPA', reason: 'fixture', confidence: 'HIGH' });
  let p = await BX.prepareBudgetDecision({ campaignId: pm.campaignId, userId: 1, deps: { config: cfg({ mode: 'SHADOW' }), evaluate: async () => ({ adAccountId: `${T}acc`, structureSource: 'META_LIVE', rows: [row] }) } });
  ok('prepare in SHADOW mode is refused', p.ok === false && p.reason === 'MODE_NOT_APPROVAL');
  p = await BX.prepareBudgetDecision({ campaignId: pm.campaignId, userId: 1, deps: { config: cfg(), evaluate: async () => ({ adAccountId: `${T}acc`, structureSource: 'META_LIVE', rows: [row] }) } });
  ok('prepare in APPROVAL mode persists one PREPARED DYNAMIC_BUDGET decision (with the 3-day metrics for the executor drift check)', p.ok === true && (await statusOfId(p.decisionId)) === 'PREPARED' && JSON.parse((await prisma.ambOperatorDecision.findUnique({ where: { id: p.decisionId } })).evidence_json).m3.cpa === 204);
  ok('it did not touch the other open decision (no stale-expiry side effect)', (await prisma.ambOperatorDecision.findUnique({ where: { id: other.d.id } })).status === 'SHADOW');
  p = await BX.prepareBudgetDecision({ campaignId: pm.campaignId, userId: 1, deps: { config: cfg(), evaluate: async () => ({ adAccountId: `${T}acc`, structureSource: 'META_SYNC_SNAPSHOT (live unavailable)', rows: [row] }) } });
  ok('prepare refuses to work from the synced copy when live Meta could not be read (NO_LIVE_DATA)', p.ok === false && p.reason === 'NO_LIVE_DATA');
  p = await BX.prepareBudgetDecision({ campaignId: pm.campaignId, userId: 1, deps: { config: cfg(), evaluate: async () => ({ adAccountId: `${T}acc`, structureSource: 'META_LIVE', rows: [{ ...row, decision: 'KEEP', intended: null }] }) } });
  ok('a campaign whose live decision is KEEP prepares nothing', p.ok === false && p.reason === 'NO_ACTION');
  p = await BX.prepareBudgetDecision({ campaignId: pm.campaignId, userId: 1, deps: { config: cfg({ execPermissions: { open: false, pause: false, budgetIncrease: false, budgetDecrease: true } }), evaluate: async () => ({ adAccountId: `${T}acc`, structureSource: 'META_LIVE', rows: [{ ...row, decision: 'WOULD_INCREASE', intended: { action: 'SCALE_UP', toBudget: 360, fromBudget: 300 } }] }) } });
  ok('increase permission OFF (decrease ON) → PERMISSION_OFF', p.ok === false && p.reason === 'PERMISSION_OFF');
  p = await BX.prepareBudgetDecision({ campaignId: pm.campaignId, userId: 1, deps: { config: cfg({ execPermissions: { open: false, pause: false, budgetIncrease: true, budgetDecrease: false } }), persist: async () => ({ created: 0 }), evaluate: async () => ({ adAccountId: `${T}acc`, structureSource: 'META_LIVE', rows: [{ ...row, decision: 'WOULD_INCREASE', wouldBe: 'PREPARED', primaryBlock: null, intended: { action: 'SCALE_UP', toBudget: 360, fromBudget: 300 } }] }) } });
  ok('increase permission ON → the would-increase row passes the actionable gate (reaches persistence)', p.reason !== 'NOT_ACTIONABLE' && p.reason !== 'PERMISSION_OFF', JSON.stringify(p).slice(0, 200));

  console.log('\n7. safety');
  const cfg2 = await S.getOperatorConfig();
  ok('the real global mode / emergency stop / write lock were not touched by this test', cfg2.mode === realCfg.mode && cfg2.emergency_stop === realCfg.emergency_stop && cfg2.writesLocked === realCfg.writesLocked);
  ok('the module imports no Meta write helper directly (only the existing executor, injected here as a stub)', !/setEntityBudget|setEntityStatus|graphPost/.test(fs.readFileSync(join(__dirname, '../services/amb/budgetExecution.js'), 'utf8').replace(/\/\/.*$/gm, '')));
} catch (e) { fail++; console.log('  ✗ test crashed —', e.stack || e.message); }
finally {
  try {
    await retryDb(() => prisma.ambOperatorEvent.deleteMany({ where: { campaign_id: { startsWith: T } } }));
    await retryDb(() => prisma.ambAction.deleteMany({ where: { ad_account_id: `${T}acc` } }));
    await retryDb(() => prisma.ambOperatorDecision.deleteMany({ where: { OR: [{ decision_key: { startsWith: T } }, { ad_account_id: `${T}acc` }] } }));
    await retryDb(() => prisma.ambRecommendation.deleteMany({ where: { ad_account_id: `${T}acc` } }));
    await retryDb(() => prisma.ambAlert.deleteMany({ where: { OR: [{ entity_id: { startsWith: T } }, { ad_account_id: `${T}acc` }] } }));
    ok('cleanup: no fixture left; AMB actions and operator decisions are back to their original counts', (await prisma.ambAction.count()) === c0.actions && (await prisma.ambOperatorDecision.count()) === c0.decisions);
  } catch (e) { fail++; console.log('  ✗ cleanup failed —', e.message); }
}
async function statusOfId(id) { return (await prisma.ambOperatorDecision.findUnique({ where: { id } })).status; }
console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
