// 🧪 Production Readiness Dashboard + execution-failure alerts + Manual/Emergency guarantees. No Meta call anywhere.
//   node src/scripts/productionReadinessTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
process.env.DAILY_PLAN_ALLOW_TEST_CLOCK = '1';
delete process.env.DAILY_PLAN_DISABLE_ALERTS;
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const { prisma } = await imp('../prisma.js');
const PR = await imp('../services/amb/productionReadiness.js'); const DP = await imp('../services/amb/dailyPlans.js'); const BO = await imp('../services/amb/budgetOptimizer.js'); const S = await imp('../services/amb/operatorStore.js'); const TM = await imp('../services/amb/dailyPlanTime.js');
const T = '__optest_';
const baseDeps = (o = {}) => ({ config: { mode: 'SHADOW', emergency_stop: false, writesLocked: true, autopilotAttest: {} }, settings: { ambAllowAutoOpen: false, ambAllowAutoPause: false, ambAllowAutoScale: false, ambAllowAutoBudgetIncrease: false, ambAllowAutoBudgetDecrease: false }, dcfg: { ...DP.DEFAULT_DAILY_CONFIG }, policy: { enabled: false }, executed: [], todayPlans: [], schedulerStarted: false, approvedDecision: 0, advisorPlans: 0, inventoryProducts: 0, ...o });
const by = (r, k) => r.functions.find((f) => f.key === k);
const created = { plans: [] };
try {
  console.log('\n1. Dashboard logic (stubbed evidence)');
  let r = await PR.buildProductionReadiness({ deps: baseDeps() });
  ok('10 functions: Open, Pause, Increase, Reduce, Scheduler, Approval, Autopilot, Inventory, Smart Advisor, Meta Verification', ['CAMPAIGN_OPEN', 'CAMPAIGN_PAUSE', 'BUDGET_INCREASE', 'BUDGET_REDUCE', 'DAILY_SCHEDULER', 'APPROVAL', 'AUTOPILOT', 'INVENTORY', 'SMART_ADVISOR', 'META_VERIFICATION'].every((k) => by(r, k)));
  ok('no real execution anywhere ⇒ Open/Pause/Increase/Reduce are UNVERIFIED (code existing is not proof)', ['CAMPAIGN_OPEN', 'CAMPAIGN_PAUSE', 'BUDGET_INCREASE', 'BUDGET_REDUCE'].every((k) => by(r, k).status === 'UNVERIFIED'));
  ok('Autopilot is BLOCKED', by(r, 'AUTOPILOT').status === 'BLOCKED' && by(r, 'AUTOPILOT').needsApproval);
  ok('summary counts add up', r.summary.READY + r.summary.BLOCKED + r.summary.UNVERIFIED === r.functions.length);
  ok('gates list what is closed now (mode, write-lock, per-type permission)', by(r, 'CAMPAIGN_OPEN').gates.some((g) => /SHADOW/.test(g)) && by(r, 'CAMPAIGN_OPEN').gates.some((g) => /مقفولة على مستوى النشر/.test(g)) && by(r, 'CAMPAIGN_OPEN').gates.some((g) => /فتح الحملات/.test(g)));
  ok('Budget Increase is executable through the bridge now: no "reductions only" gate — it stays UNVERIFIED (never run on Meta) and needs its own permission', !by(r, 'BUDGET_INCREASE').gates.some((g) => /بالتقليل فقط/.test(g)) && by(r, 'BUDGET_INCREASE').status === 'UNVERIFIED' && by(r, 'BUDGET_INCREASE').mockTested?.action === 'INCREASE_BUDGET');
  ok('the four operations carry the Meta-mock suite marker (code-level readiness shown separately from proof on Meta)', ['CAMPAIGN_OPEN', 'CAMPAIGN_PAUSE', 'BUDGET_INCREASE', 'BUDGET_REDUCE'].every((k) => by(r, k).mockTested?.suite === 'operationsMockTest') && !by(r, 'AUTOPILOT').mockTested);
  r = await PR.buildProductionReadiness({ deps: baseDeps({ executed: [{ id: 1, action_type: 'DECREASE_BUDGET', entity_name: 'x', executed_at: new Date(), verify_json: '{"verified":true}' }] }) });
  ok('a real executed + read-back-VERIFIED reduction ⇒ Budget Reduce READY, Meta Verification READY, others still UNVERIFIED', by(r, 'BUDGET_REDUCE').status === 'READY' && by(r, 'META_VERIFICATION').status === 'READY' && by(r, 'CAMPAIGN_OPEN').status === 'UNVERIFIED' && by(r, 'BUDGET_INCREASE').status === 'UNVERIFIED');
  r = await PR.buildProductionReadiness({ deps: baseDeps({ executed: [{ id: 2, action_type: 'RESUME', entity_name: 'y', executed_at: new Date(), verify_json: '{"verified":false}' }] }) });
  ok('an executed action whose read-back did NOT confirm is NOT proof', by(r, 'CAMPAIGN_OPEN').status === 'UNVERIFIED' && by(r, 'META_VERIFICATION').status === 'UNVERIFIED');
  r = await PR.buildProductionReadiness({ deps: baseDeps({ schedulerStarted: true, todayPlans: [{ id: 1, type: 'OPEN', status: 'PREPARED' }] }) });
  ok('Daily Scheduler READY only when started AND a real plan exists today', by(r, 'DAILY_SCHEDULER').status === 'READY' && by(r, 'DAILY_SCHEDULER').gates.some((g) => /التنفيذ المجدول/.test(g)));
  r = await PR.buildProductionReadiness({ deps: baseDeps({ schedulerStarted: true, todayPlans: [{ id: 1, type: 'OPEN', status: 'PREPARED' }], dcfg: { ...DP.DEFAULT_DAILY_CONFIG, halted: true } }) });
  ok('halted queue ⇒ Daily Scheduler BLOCKED', by(r, 'DAILY_SCHEDULER').status === 'BLOCKED');
  ok('Emergency Stop appears as a gate everywhere', (await PR.buildProductionReadiness({ deps: baseDeps({ config: { mode: 'APPROVAL', emergency_stop: true, writesLocked: false, autopilotAttest: {} } }) })).functions.filter((f) => f.needsApproval).every((f) => f.status === 'AUTOPILOT' || f.gates.some((g) => /Emergency/.test(g)) || f.key === 'AUTOPILOT'));

  console.log('\n2. Dashboard on the REAL system (evidence from the database)');
  const real = await PR.buildProductionReadiness({});
  const exec = await prisma.ambAction.findMany({ where: { execution_status: 'EXECUTED', action_type: { in: ['RESUME', 'PAUSE', 'INCREASE_BUDGET', 'DECREASE_BUDGET'] }, NOT: { OR: [{ entity_id: { startsWith: '__optest_' } }, { ad_account_id: { startsWith: '__optest_' } }] } }, select: { action_type: true, verify_json: true } });
  const proven = (t) => exec.some((a) => a.action_type === t && JSON.parse(a.verify_json || '{}').verified === true);
  ok('real statuses follow the real proof (Open/Pause/Increase/Reduce)', [['CAMPAIGN_OPEN', 'RESUME'], ['CAMPAIGN_PAUSE', 'PAUSE'], ['BUDGET_INCREASE', 'INCREASE_BUDGET'], ['BUDGET_REDUCE', 'DECREASE_BUDGET']].every(([k, t]) => by(real, k).status === (proven(t) ? 'READY' : 'UNVERIFIED')), JSON.stringify(real.functions.map((f) => [f.key, f.status])));
  ok('real control state is reported (mode, write-lock, toggles)', typeof real.control.mode === 'string' && typeof real.control.writesLocked === 'boolean' && Object.keys(real.control.autoToggles).length === 5);

  // a stubbed executor writing an EXECUTED+verified fixture row must never count as proof of a real Meta execution
  const fxRec = await prisma.ambRecommendation.create({ data: { batch_id: `${T}proof`, ad_account_id: `${T}acc`, level: 'campaign', entity_id: `${T}proof1`, entity_name: `${T}proof`, campaign_id: `${T}proof1`, decision: 'SCALE', action_type: 'PAUSE', executable: true, status: 'EXECUTED' } }); created.recs = [fxRec.id];
  const fxAct = await prisma.ambAction.create({ data: { recommendation_id: fxRec.id, mode: 'APPROVAL', action_type: 'PAUSE', ad_account_id: `${T}acc`, level: 'campaign', entity_id: `${T}proof1`, entity_name: `${T}proof`, campaign_id: `${T}proof1`, approval_status: 'APPROVED', execution_status: 'EXECUTED', executed_at: new Date(), verify_json: '{"verified":true}' } }); created.acts = [fxAct.id];
  const withFixture = await PR.buildProductionReadiness({});
  ok('test fixtures (stubbed executors, __optest_) are NEVER counted as proof — Pause stays as the real evidence says', by(withFixture, 'CAMPAIGN_PAUSE').status === (proven('PAUSE') ? 'READY' : 'UNVERIFIED'));

  console.log('\n3. A FAILED / UNCERTAIN live execution raises a clear alert');
  const items = (n) => Array.from({ length: n }, (_, i) => ({ campaignId: `${T}ra${i + 1}`, campaignName: `${T}alert camp ${i + 1}`, productId: null, productName: 'fixture', storeId: 'trendy-storeee', rank: i + 1, selected: true, selectable: true, eligibility: 'ELIGIBLE', blockCodes: [], warnings: [], risk: 'LOW', riskScore: 5, reason: 'fixture', evidence: { mapping: 'VERIFIED', budget: 300, stock: { status: 'IN_STOCK' }, recommended: true } }));
  const date = '2031-07-01'; const FRESH = { syncStatus: async () => ({ lastSuccessAt: new Date() }), refresh: async () => ({ ok: true }) };
  const plan = (await DP.preparePlan({ type: 'OPEN', date, now: new Date(), simulated: false, deps: { ...FRESH, build: async () => ({ items: items(2), policy: null }) } })).plan; created.plans.push(plan.id);
  const lateOk = new Date(TM.dueAt('OPEN', date).getTime() + 60_000);
  const throwing = async ({ recId }) => { const rec = await prisma.ambRecommendation.findUnique({ where: { id: recId } }); await prisma.ambAction.create({ data: { recommendation_id: rec.id, mode: 'APPROVAL', action_type: rec.action_type, ad_account_id: rec.ad_account_id, level: rec.level, entity_id: rec.entity_id, entity_name: rec.entity_name, campaign_id: rec.campaign_id, approval_status: 'APPROVED', execution_status: 'FAILED', meta_request_json: JSON.stringify({ id: rec.entity_id }), meta_error: 'boom' } }); throw new Error('boom'); };
  await DP.approvePlan({ planId: plan.id, userId: 1, now: lateOk, deps: { ...FRESH, user: { id: 1, role: 'ADMIN', status: 'ACTIVE' }, runInline: true, exceptions: async () => [], lastPurchase: async () => null, mappingState: async () => null, dcfg: { ...DP.DEFAULT_DAILY_CONFIG, allowOpen: true }, config: async () => ({ mode: 'APPROVAL', emergency_stop: false, writesLocked: false, limits: { recentPurchaseProtectionHours: 3 } }), readEntity: async (id) => ({ id, status: 'PAUSED', budget: 300 }), approveAndExecute: throwing, readBack: async (a) => ({ status: a.campaignId === `${T}ra1` ? 'PAUSED' : null }), sleep: async () => {} } });
  const alerts = await prisma.ambAlert.findMany({ where: { dedupe_key: { startsWith: `dailyplan-item:OPEN|${date}` } } });
  ok('FAILED item (Meta still PAUSED) ⇒ CRITICAL alert naming the campaign', alerts.some((a) => a.severity === 'CRITICAL' && a.campaign_id === `${T}ra1` && /فشل/.test(a.title)), JSON.stringify(alerts.map((a) => [a.severity, a.title])));
  ok('UNCERTAIN item (read-back impossible) ⇒ WARNING alert, no automatic resend', alerts.some((a) => a.severity === 'WARNING' && a.campaign_id === `${T}ra2` && /غير مؤكد/.test(a.title)));
  const simPlan = (await DP.preparePlan({ type: 'PAUSE', date, now: new Date(), simulated: true, deps: { ...FRESH, build: async () => ({ items: items(1).map((i) => ({ ...i, campaignId: `${T}rb1` })), policy: null }) } })).plan; created.plans.push(simPlan.id);
  const before = await prisma.ambAlert.count({ where: { campaign_id: `${T}rb1` } });
  await DP.approvePlan({ planId: simPlan.id, userId: 1, now: new Date(TM.dueAt('PAUSE', date).getTime() + 60_000), deps: { ...FRESH, user: { id: 1, role: 'ADMIN', status: 'ACTIVE' }, runInline: true, exceptions: async () => [], lastPurchase: async () => null, mappingState: async () => null, dcfg: DP.DEFAULT_DAILY_CONFIG, config: async () => ({ mode: 'SHADOW', emergency_stop: false, writesLocked: true, limits: {} }), readEntity: async (id) => ({ id, status: 'ACTIVE', budget: 300 }), sleep: async () => {} } });
  ok('simulated (SHADOW) runs raise no alerts', (await prisma.ambAlert.count({ where: { campaign_id: `${T}rb1` } })) === before);

  console.log('\n4. Manual / Emergency Stop guarantees');
  const storeSrc = fs.readFileSync(join(__dirname, '../services/amb/operatorStore.js'), 'utf8');
  const stopFn = storeSrc.slice(storeSrc.indexOf('export async function setEmergencyStop'), storeSrc.indexOf('const LIMIT_KEYS_ACCOUNT'));
  ok('Emergency Stop only flips the flag + audit — it never rolls anything back', !/prepareRollback|executeRollback|rollbackDecision|setEntity|graphPost|approveAndExecute/.test(stopFn));
  ok('auto-rollback is OFF by default', S.DEFAULT_LIMITS.allowAutoRollback === false);
  const modeSrc = storeSrc.slice(storeSrc.indexOf('export async function setOperatorMode'), storeSrc.indexOf('export async function setOperatorMode') + 2500);
  ok('switching mode (incl. to MANUAL) does not trigger a rollback or Meta call', !/prepareRollback|executeRollback|rollbackDecision|setEntity|graphPost|approveAndExecute/.test(modeSrc));
  // switching to MANUAL in the middle of an approved LIVE queue stops the remaining items; the one already sent stays as it is (no rollback)
  const dM = '2031-07-02'; const planM = (await DP.preparePlan({ type: 'OPEN', date: dM, now: new Date(), simulated: false, deps: { ...FRESH, build: async () => ({ items: items(3).map((i, n) => ({ ...i, campaignId: `${T}rm${n + 1}` })), policy: null }) } })).plan; created.plans.push(planM.id);
  let cfgCalls = 0; let sent = 0; const okExec = async ({ recId }) => { sent++; const rec = await prisma.ambRecommendation.findUnique({ where: { id: recId } }); const a = await prisma.ambAction.create({ data: { recommendation_id: rec.id, mode: 'APPROVAL', action_type: rec.action_type, ad_account_id: rec.ad_account_id, level: rec.level, entity_id: rec.entity_id, entity_name: rec.entity_name, campaign_id: rec.campaign_id, approval_status: 'APPROVED', execution_status: 'EXECUTED', executed_at: new Date(), meta_request_json: '{}', verify_json: '{"verified":true}' } }); return { ok: true, actionId: a.id }; };
  process.env.DAILY_PLAN_DISABLE_ALERTS = '1';
  await DP.approvePlan({ planId: planM.id, userId: 1, now: new Date(TM.dueAt('OPEN', dM).getTime() + 60_000), deps: { ...FRESH, user: { id: 1, role: 'ADMIN', status: 'ACTIVE' }, runInline: true, exceptions: async () => [], lastPurchase: async () => null, mappingState: async () => null, dcfg: { ...DP.DEFAULT_DAILY_CONFIG, allowOpen: true }, config: async () => { cfgCalls++; return { mode: cfgCalls <= 2 ? 'APPROVAL' : 'OFF', emergency_stop: false, writesLocked: false, limits: {} }; }, readEntity: async (id) => ({ id, status: 'PAUSED', budget: 300 }), approveAndExecute: okExec, sleep: async () => {} } });
  const stM = (await prisma.ambDailyPlanItem.findMany({ where: { plan_id: planM.id }, orderBy: { rank: 'asc' } })).map((i) => `${i.status}${i.status_reason ? ':' + i.status_reason : ''}`);
  ok('MANUAL pressed mid-queue: the sent item stays VERIFIED, the rest are SKIPPED (MODE_CHANGED_MANUAL), nothing is rolled back', stM[0].startsWith('VERIFIED') && stM.slice(1).every((x) => x.startsWith('SKIPPED:MODE_CHANGED_MANUAL')) && sent === 1, stM.join(' | '));
  ok('MANUAL (OFF) never executes daily plans for real; Emergency Stop blocks even simulation', DP.executionGate({ config: { mode: 'OFF', emergency_stop: false }, dcfg: { allowOpen: true, allowPause: true, halted: false }, type: 'OPEN', simulatedPlan: false }).mode === 'SIMULATION' && DP.executionGate({ config: { mode: 'APPROVAL', emergency_stop: true, writesLocked: false }, dcfg: { allowOpen: true, halted: false }, type: 'OPEN', simulatedPlan: false }).blocked?.code === 'EMERGENCY_STOP');

  console.log('\n5. Budget policy matches the owner rules');
  const P = BO.DEFAULT_POLICY;
  ok('zero orders ≥ 200 spend → pause candidate; scale ≤ 80 CPA +20% (24h cooldown); keep 81–149; reduce 150–200 −20% (48h); high CPA > 200 reduce first', P.zeroOrders.spend === 200 && P.scale.maxCpa === 80 && P.scale.pct === 20 && P.scale.cooldownHours === 24 && P.reduce.minCpa === 150 && P.reduce.maxCpa === 200 && P.reduce.pct === 20 && P.reduce.cooldownHours === 48 && P.highCpa.above === 200 && P.highCpa.pct === 20, JSON.stringify(P));
} catch (e) {
  fail++; console.log('  ✗ UNEXPECTED', e.stack || e.message);
} finally {
  for (const id of created.plans) await prisma.ambOperatorEvent.deleteMany({ where: { data_json: { contains: `"planId":${id},` } } }).catch(() => {});
  await prisma.ambAction.deleteMany({ where: { id: { in: created.acts || [] } } }).catch(() => {}); await prisma.ambRecommendation.deleteMany({ where: { id: { in: created.recs || [] } } }).catch(() => {});
  const ids = created.plans; const recs = await prisma.ambRecommendation.findMany({ where: { batch_id: { in: ids.map((i) => `daily-plan-${i}`) } }, select: { id: true } });
  await prisma.ambAction.deleteMany({ where: { recommendation_id: { in: recs.map((r) => r.id) } } }).catch(() => {});
  await prisma.ambRecommendation.deleteMany({ where: { id: { in: recs.map((r) => r.id) } } }).catch(() => {});
  await prisma.ambDailyPlan.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.ambAlert.deleteMany({ where: { OR: [{ campaign_id: { startsWith: T } }, { dedupe_key: { contains: '2031-07' } }] } }).catch(() => {});
  console.log(`\n${fail === 0 ? '✅' : '❌'} productionReadinessTest: ${pass} passed, ${fail} failed`);
  await prisma.$disconnect(); process.exit(fail ? 1 : 0);
}
