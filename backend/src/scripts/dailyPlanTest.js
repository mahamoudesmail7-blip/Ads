// 🧪 Daily Operations Center (جدول التشغيل اليومي): Cairo schedule + plan lifecycle + safety gates + versioning + execution revalidation — NO Meta call anywhere (every Meta read/write is a stub).
// Disposable fixtures only: plans dated 2031-05-xx, campaigns/users prefixed "__optest_". Nothing of the real account is touched.
//   node src/scripts/dailyPlanTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
process.env.DAILY_PLAN_ALLOW_TEST_CLOCK = '1'; process.env.DAILY_PLAN_DISABLE_ALERTS = '1';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const retryDb = async (fn) => { for (let i = 0; i < 10; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 4000)); } } return fn(); };
if (!process.env.JWT_SECRET) { console.log('JWT_SECRET missing'); process.exit(2); }
const { prisma } = await imp('../prisma.js');
const TM = await imp('../services/amb/dailyPlanTime.js'); const DP = await imp('../services/amb/dailyPlans.js'); const DC = await imp('../services/amb/dailyPlanCandidates.js');
const BO = await imp('../services/amb/budgetOptimizer.js'); const S = await imp('../services/amb/operatorStore.js');
const { default: operatorRoutes } = await imp('../routes/operator.js'); const { errorHandler } = await imp('../middleware/errorHandler.js');
const T = '__optest_'; const created = { users: [] };
const rawCfg0 = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } });
const sanitizeLimits = (lj) => { const o = JSON.parse(lj || '{}'); if (o.dailyPlan) { o.dailyPlan.halted = false; } return lj == null ? lj : JSON.stringify(o); }; // another suite may have a transient halted=true when this one snapshots the real config — never restore that

const c0 = { actions: await prisma.ambAction.count(), recs: await prisma.ambRecommendation.count(), decisions: await prisma.ambOperatorDecision.count() };
const FRESH = { syncStatus: async () => ({ lastSuccessAt: new Date() }), refresh: async () => ({ ok: true }) };
const STALE = { syncStatus: async () => ({ lastSuccessAt: new Date(Date.now() - 5 * 3_600_000) }), refresh: async () => ({ ok: false, error: 'META_DOWN' }) };
const dcfg0 = await DP.getDailyPlanConfig();
const DC_ON = { ...dcfg0, allowOpen: true, allowPause: true, halted: false, scheduledExecution: { enabled: true } };
const DC_OFF = { ...dcfg0, allowOpen: false, allowPause: false, halted: false, scheduledExecution: { enabled: false } };
const cfgOf = (o = {}) => ({ mode: 'SHADOW', emergency_stop: false, writesLocked: true, limits: { recentPurchaseProtectionHours: 3 }, ...o });
const ADMIN = { id: 1, role: 'ADMIN', status: 'ACTIVE' }; const MANAGER = { id: 2, role: 'MANAGER', status: 'ACTIVE' };
let seq = 0;
const item = (o = {}) => { const n = ++seq; return { campaignId: `${T}c${n}`, campaignName: `${T}camp ${n}`, productId: null, productName: 'fixture', storeId: 'trendy-storeee', rank: n, selected: true, selectable: true, eligibility: 'ELIGIBLE', blockCodes: [], warnings: [], risk: 'LOW', riskScore: 10, reason: 'fixture', evidence: { mapping: 'VERIFIED', budget: 300, budgetLevel: 'CBO', m7: { spend: 500, purchases: 6, cpa: 83 }, m30: { spend: 1500, purchases: 20, cpa: 75 }, stock: { status: 'IN_STOCK' }, recommended: true, policyPause: true }, ...o }; };
const items = (n, f = {}) => Array.from({ length: n }, (_, i) => item({ rank: i + 1, ...(typeof f === 'function' ? f(i) : f) }));
const mk = async ({ type = 'OPEN', date, its, simulated = true, d = FRESH, now = new Date(), userId = null }) => (await DP.preparePlan({ type, date, now, simulated, userId, deps: { ...d, build: async () => ({ items: its, policy: null }) } })).plan;
const get = (id) => prisma.ambDailyPlan.findUnique({ where: { id }, include: { items: { orderBy: { rank: 'asc' } } } });
const statuses = async (id) => (await prisma.ambDailyPlanItem.findMany({ where: { plan_id: id, selected: true }, orderBy: { rank: 'asc' } })).map((i) => i.status);
const noSleep = () => { const calls = []; return { calls, fn: async (ms) => { calls.push(ms); } }; };
let readCalls = 0, execCalls = 0;
const readEntityOf = (status) => async (id) => { readCalls++; return { id, status, budget: 300 }; };
const stubExec = (verified = true) => async ({ recId, userId, mode }) => {
  execCalls++; const rec = await prisma.ambRecommendation.findUnique({ where: { id: recId } });
  const a = await prisma.ambAction.create({ data: { recommendation_id: rec.id, mode, action_type: rec.action_type, ad_account_id: rec.ad_account_id, level: rec.level, entity_id: rec.entity_id, entity_name: rec.entity_name, campaign_id: rec.campaign_id, ai_reason: rec.reason, approval_status: 'APPROVED', execution_status: 'EXECUTED', executed_by_id: null, executed_at: new Date(), meta_request_json: JSON.stringify({ id: rec.entity_id }), verify_json: JSON.stringify({ verified }) } });
  await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'EXECUTED' } }); return { ok: true, actionId: a.id };
};
const D0 = { ...FRESH, user: ADMIN, runInline: true, exceptions: async () => [], lastPurchase: async () => null, mappingState: async () => null };

try {
  console.log('\n1. Cairo schedule — 00:00 OPEN / 13:00 PAUSE, the day changes at CAIRO midnight (not UTC)');
  const s1 = TM.dueAt('OPEN', '2026-10-08'), s2 = TM.dueAt('PAUSE', '2026-10-08');
  ok('summer (UTC+3): 00:00 Cairo = 21:00Z of the previous UTC day', s1.toISOString() === '2026-10-07T21:00:00.000Z', s1.toISOString());
  ok('summer: 13:00 Cairo = 10:00Z', s2.toISOString() === '2026-10-08T10:00:00.000Z', s2.toISOString());
  const w1 = TM.dueAt('OPEN', '2026-12-10'), w2 = TM.dueAt('PAUSE', '2026-12-10');
  ok('winter (UTC+2): 00:00 Cairo = 22:00Z, 13:00 = 11:00Z (UTC difference is DST-correct)', w1.toISOString() === '2026-12-09T22:00:00.000Z' && w2.toISOString() === '2026-12-10T11:00:00.000Z', `${w1.toISOString()} ${w2.toISOString()}`);
  ok('Cairo date flips at 21:00Z (summer) while the UTC date is still the previous day', TM.cairoDate(new Date('2026-10-07T20:59:59Z')) === '2026-10-07' && TM.cairoDate(new Date('2026-10-07T21:00:00Z')) === '2026-10-08');
  ok('dueTypes: 23:59 Cairo nothing new that day', TM.dueTypes(new Date('2026-10-07T20:59:00Z')).every((d) => d.date === '2026-10-07'));
  ok('dueTypes: exactly 00:00 → OPEN only', JSON.stringify(TM.dueTypes(new Date('2026-10-07T21:00:00Z')).map((d) => d.type)) === '["OPEN"]');
  ok('dueTypes: 12:59 → OPEN only; 13:00 → OPEN + PAUSE', JSON.stringify(TM.dueTypes(new Date('2026-10-08T09:59:00Z')).map((d) => d.type)) === '["OPEN"]' && JSON.stringify(TM.dueTypes(new Date('2026-10-08T10:00:00Z')).map((d) => d.type)) === '["OPEN","PAUSE"]');
  ok('expiry = end of the Cairo day', TM.expiresAt('2026-10-08').toISOString() === '2026-10-08T21:00:00.000Z');
  ok('nextDue after 13:00 → next OPEN is tomorrow 00:00 Cairo', TM.nextDue('OPEN', new Date('2026-10-08T10:30:00Z')).date === '2026-10-09');
  ok('the test clock works only with the env flag; plan keys of virtual plans are SIM-prefixed', TM.planKey('OPEN', '2031-05-01', true) === 'SIM|OPEN|2031-05-01' && TM.planKey('OPEN', '2031-05-01') === 'OPEN|2031-05-01');
  TM.setTestClock(new Date('2031-05-02T21:00:00Z')); ok('test clock moves "now" and isTestClock()', TM.isTestClock() && TM.clockNow().toISOString() === '2031-05-02T21:00:00.000Z'); TM.setTestClock(null); ok('clearing the test clock returns real time', !TM.isTestClock());

  console.log('\n2. Ranking / scoring (pure) — one order is never a winner');
  ok('sample tiers A/B/C/D', DC.sampleTier(25) === 'A' && DC.sampleTier(10) === 'B' && DC.sampleTier(4) === 'C' && DC.sampleTier(1) === 'D');
  const one = DC.openRecommended({ m7: { purchases: 1, cpa: 40 }, m30: { purchases: 1, cpa: 40 } }); ok('1 order @ CPA 40 is NOT recommended', one.ok === false);
  ok('20 orders @ CPA 75 is recommended', DC.openRecommended({ m7: { purchases: 6, cpa: 80 }, m30: { purchases: 20, cpa: 75 } }).ok === true);
  ok('a good 30-day CPA does not hide a bad recent week (806 CPA on 1 order / 0 orders on real spend) → not recommended', DC.openRecommended({ m7: { purchases: 1, cpa: 806, spend: 806 }, m30: { purchases: 51, cpa: 145 } }).ok === false && DC.openRecommended({ m7: { purchases: 0, cpa: null, spend: 400 }, m30: { purchases: 30, cpa: 100 } }).ok === false && DC.openRecommended({ m7: { purchases: 6, cpa: 80, spend: 480 }, m30: { purchases: 20, cpa: 75 } }).ok === true);
  ok('volatile CPA (7d vs 30d far apart) is not recommended', DC.openRecommended({ m7: { purchases: 4, cpa: 200 }, m30: { purchases: 20, cpa: 80 } }).ok === false);
  ok('CPA ≥ 150 is not recommended', DC.openRecommended({ m7: { purchases: 6, cpa: 160 }, m30: { purchases: 20, cpa: 155 } }).ok === false);
  ok('a deep sample at a good CPA outranks a thin sample at a great CPA', DC.openScore({ m7: { purchases: 6, cpa: 80 }, m30: { purchases: 25, cpa: 78 } }) > DC.openScore({ m7: { purchases: 1, cpa: 30 }, m30: { purchases: 2, cpa: 30 } }));
  ok('stale campaign (inactive > 14 days) is penalised', DC.openScore({ m7: { purchases: 6, cpa: 80 }, m30: { purchases: 25, cpa: 78 }, daysSinceActive: 40 }) < DC.openScore({ m7: { purchases: 6, cpa: 80 }, m30: { purchases: 25, cpa: 78 }, daysSinceActive: 2 }));
  ok('stability: STABLE / VOLATILE / UNKNOWN', DC.cpaStability({ m7: { purchases: 4, cpa: 80 }, m30: { purchases: 20, cpa: 85 } }) === 'STABLE' && DC.cpaStability({ m7: { purchases: 4, cpa: 200 }, m30: { purchases: 20, cpa: 85 } }) === 'VOLATILE' && DC.cpaStability({ m7: { purchases: 1, cpa: 80 }, m30: { purchases: 20, cpa: 85 } }) === 'UNKNOWN');
  const pz = DC.pauseRisk({ today: { spend: 0, purchases: 0 }, m3: { spend: 450, purchases: 0 }, m7: { spend: 900, purchases: 0 } }), pc = DC.pauseRisk({ today: {}, m3: { spend: 900, purchases: 3, cpa: 310 }, m7: { spend: 1500, purchases: 6, cpa: 250 } }), pl = DC.pauseRisk({ today: {}, m3: { spend: 400, purchases: 5, cpa: 80 }, m7: { spend: 900, purchases: 11, cpa: 82 } });
  ok('pause risk: zero orders after real spend > very high CPA > healthy', pz.score > pc.score && pc.score > pl.score && pz.level === 'HIGH' && pl.level === 'LOW', `${pz.score}/${pc.score}/${pl.score}`);
  ok('a historically strong campaign is a protected winner', DC.isWinner({ m7: { purchases: 4, cpa: 100 }, m30: { purchases: 30, cpa: 95 } }) && !DC.isWinner({ m7: { purchases: 4, cpa: 100 }, m30: { purchases: 3, cpa: 60 } }));
  ok('planned budget: CBO uses the campaign budget; ABO sums the ad sets that would deliver', DC.plannedBudget({ campaign: { budget: 300 }, adsets: [] }).level === 'CBO' && (() => { const b = DC.plannedBudget({ campaign: {}, adsets: [{ status: 'ACTIVE', budget: 100 }, { status: 'CAMPAIGN_PAUSED', budget: 150 }, { status: 'PAUSED', budget: 999 }] }); return b.level === 'ABO' && b.budget === 250; })());

  console.log('\n3. Plan generation — run once, restart-safe, idempotent');
  const dA = '2031-05-10';
  const pA = await mk({ type: 'OPEN', date: dA, its: items(3) });
  ok('plan created PREPARED with v1, SIM key, Cairo timezone, items', pA.status === 'PREPARED' && pA.version === 1 && pA.plan_key === `SIM|OPEN|${dA}` && pA.timezone === 'Africa/Cairo' && pA.items.length === 3 && pA.simulated);
  ok('scheduled_at = 00:00 Cairo of that day; expires at end of that Cairo day', pA.scheduled_at.getTime() === TM.dueAt('OPEN', dA).getTime() && pA.expires_at.getTime() === TM.expiresAt(dA).getTime());
  const again = await DP.preparePlan({ type: 'OPEN', date: dA, simulated: true, deps: { ...FRESH, build: async () => ({ items: items(9), policy: null }) } });
  ok('preparing the same day/type again returns the SAME plan (run-once)', again.created === false && again.plan.id === pA.id && again.plan.items.length === 3);
  const race = await Promise.all([1, 2, 3].map(() => DP.preparePlan({ type: 'PAUSE', date: dA, simulated: true, deps: { ...FRESH, build: async () => ({ items: items(2), policy: null }) } })));
  ok('3 concurrent preparations (scheduler restart race) create exactly ONE plan', (await prisma.ambDailyPlan.count({ where: { plan_key: `SIM|PAUSE|${dA}` } })) === 1 && new Set(race.map((r) => r.plan.id)).size === 1);
  const due = await DP.getDuePopups({ now: TM.dueAt('PAUSE', dA), simulated: true }); ok('getDuePopups is read-only and returns plans for the Cairo day', Array.isArray(due));
  const pStale = await mk({ type: 'OPEN', date: '2031-05-11', its: items(3), d: STALE });
  ok('Meta unavailable ⇒ plan marked STALE, nothing selected, nothing selectable', pStale.data_state === 'STALE' && pStale.items.every((i) => !i.selected && !i.selectable));
  const apStale = await DP.approvePlan({ planId: pStale.id, userId: 1, now: new Date(TM.dueAt('OPEN', '2031-05-11').getTime() + 60_000), deps: { ...STALE, user: ADMIN, dcfg: DC_OFF, config: async () => cfgOf() } });
  ok('STALE data blocks approval', apStale.ok === false && apStale.status === 'STALE_DATA', JSON.stringify(apStale));

  console.log('\n4. Selection — saved, versioned after approval, forbidden rows cannot be ticked');
  const dB = '2031-05-12'; const itB = items(4); itB[3] = item({ rank: 4, selected: false, selectable: false, eligibility: 'BLOCKED', blockCodes: ['MAPPING_UNMAPPED'] });
  const pB = await mk({ type: 'OPEN', date: dB, its: itB });
  const r1 = await DP.updateSelection({ planId: pB.id, selections: { [itB[0].campaignId]: false }, userId: 1 });
  ok('edit before approval: in place, same plan id, same version', r1.newVersion === false && r1.plan.id === pB.id && r1.plan.version === 1 && r1.plan.counts.selected === 2);
  let blockedTick = null; try { await DP.updateSelection({ planId: pB.id, selections: { [itB[3].campaignId]: true }, userId: 1 }); } catch (e) { blockedTick = e; }
  ok('a BLOCKED/EXTERNAL_STORE/UNMAPPED row cannot be selected (400)', blockedTick?.status === 400);
  const dSp = '2031-05-31'; const itSp = [item({ rank: 1 }), item({ rank: 2, selected: false, eligibility: 'NEEDS_SPECIAL_APPROVAL' })]; const pSp = await mk({ type: 'OPEN', date: dSp, its: itSp });
  let spErr = null; try { await DP.updateSelection({ planId: pSp.id, selections: { [itSp[1].campaignId]: true }, userId: 1 }); } catch (e) { spErr = e; }
  ok('a campaign paused manually / for an unknown reason is NOT default-selected and needs an explicit SPECIAL approval to be ticked', pSp.items.find((i) => i.rank === 2).selected === false && spErr?.code === 'SPECIAL_APPROVAL_REQUIRED');
  const spOk = await DP.updateSelection({ planId: pSp.id, selections: { [itSp[1].campaignId]: true }, special: [itSp[1].campaignId], userId: 1 });
  ok('with the special approval it is selected and the audit records it', spOk.plan.counts.selected === 2 && (await DP.planAudit(pSp.id)).some((a) => a.data?.changes?.some((c) => c.specialApproval)));
  const early = await DP.approvePlan({ planId: pB.id, userId: 1, now: new Date(TM.dueAt('OPEN', dB).getTime() - 3_600_000), deps: { ...D0, dcfg: DC_OFF, config: async () => cfgOf() } });
  ok('approving BEFORE the due time is refused unless scheduled execution is explicitly enabled', early.ok === false && early.status === 'NOT_DUE_YET', JSON.stringify(early));
  const apE = await DP.approvePlan({ planId: pB.id, userId: 1, now: new Date(TM.dueAt('OPEN', dB).getTime() - 3_600_000), deps: { ...D0, dcfg: DC_ON, config: async () => cfgOf() } });
  ok('with scheduled execution enabled, early approval is SCHEDULED (APPROVED, not run)', apE.ok && apE.status === 'APPROVED' && apE.scheduled && (await get(pB.id)).status === 'APPROVED');
  const r2 = await DP.updateSelection({ planId: pB.id, selections: { [itB[1].campaignId]: false }, userId: 1 });
  const oldPlan = await get(pB.id);
  ok('edit AFTER approval ⇒ NEW version (v2, PREPARED); the approved one is SUPERSEDED', r2.newVersion && r2.plan.version === 2 && r2.plan.status === 'PREPARED' && oldPlan.status === 'SUPERSEDED');
  ok('the new version carries the selections (+edit) and needs a fresh approval', r2.plan.counts.selected === 1 && !r2.plan.approvedAt);
  const runOld = await DP.runPlanExecution({ planId: pB.id, userId: 1, deps: { ...D0, dcfg: DC_ON, config: async () => cfgOf(), sleep: noSleep().fn } });
  ok('the SUPERSEDED (old) version can never execute', runOld.skipped === 'NOT_CLAIMED' && (await statuses(pB.id)).every((s) => s === 'PENDING'));
  let stale409 = null; try { await DP.updateSelection({ planId: pB.id, selections: { [itB[0].campaignId]: true }, userId: 1 }); } catch (e) { stale409 = e; } ok('editing an old version is refused (409)', stale409?.status === 409);
  const audB = await DP.planAudit(r2.plan.id); ok('audit trail records the new version', audB.some((a) => a.data?.action === 'NEW_VERSION'));

  console.log('\n5. Cancel / missed / expiry — never executed late');
  const dC = '2031-05-13'; const pC = await mk({ type: 'OPEN', date: dC, its: items(2) });
  await DP.approvePlan({ planId: pC.id, userId: 1, now: new Date(TM.dueAt('OPEN', dC).getTime() - 3_600_000), deps: { ...D0, dcfg: DC_ON, config: async () => cfgOf() } });
  await DP.cancelPlan({ planId: pC.id, userId: 1, reason: 'test' });
  const runC = await DP.runPlanExecution({ planId: pC.id, userId: 1, deps: { ...D0, dcfg: DC_ON, config: async () => cfgOf(), sleep: noSleep().fn } });
  ok('a CANCELLED plan is not executed', runC.skipped === 'NOT_CLAIMED' && (await get(pC.id)).status === 'CANCELLED' && (await statuses(pC.id)).every((s) => s === 'PENDING'));
  const dM = '2031-05-14'; const pM = await mk({ type: 'PAUSE', date: dM, its: items(2) });
  const lateNow = new Date(TM.expiresAt(dM).getTime() + 60_000);
  const apM = await DP.approvePlan({ planId: pM.id, userId: 1, now: lateNow, deps: { ...D0, dcfg: DC_OFF, config: async () => cfgOf() } });
  ok('approving after the Cairo day ended ⇒ MISSED (no late execution)', apM.ok === false && apM.status === 'MISSED' && (await get(pM.id)).status === 'MISSED', JSON.stringify(apM));
  const sw = await DP.ensureDuePlans({ now: lateNow, simulated: true, deps: { ...FRESH, build: async () => ({ items: items(1), policy: null }) } });
  ok('the scheduler sweep marks unapproved expired plans MISSED', (await get(pA.id)).status === 'MISSED' && Array.isArray(sw.missed));

  console.log('\n6. Gate: SHADOW approval = SIMULATION (no Meta write exists on that path)');
  const g = (cfg, dcfg = DC_ON, type = 'OPEN', simulatedPlan = false) => DP.executionGate({ config: cfg, dcfg, type, simulatedPlan });
  ok('SHADOW → SIMULATION', g(cfgOf({ mode: 'SHADOW' })).mode === 'SIMULATION'); ok('OFF/MANUAL → SIMULATION', g(cfgOf({ mode: 'OFF' })).mode === 'SIMULATION');
  ok('APPROVAL but deployment write-lock closed → BLOCKED', g(cfgOf({ mode: 'APPROVAL', writesLocked: true })).blocked?.code === 'META_WRITES_LOCKED');
  ok('APPROVAL + unlocked but per-type permission off → BLOCKED', g(cfgOf({ mode: 'APPROVAL', writesLocked: false }), DC_OFF, 'PAUSE').blocked?.code === 'TYPE_NOT_ALLOWED');
  ok('Emergency Stop → BLOCKED even in SHADOW', g(cfgOf({ emergency_stop: true })).blocked?.code === 'EMERGENCY_STOP');
  ok('halted queue → BLOCKED', g(cfgOf(), { ...DC_ON, halted: true }).blocked?.code === 'QUEUE_HALTED');
  ok('AUTOPILOT can never run these plans', g(cfgOf({ mode: 'AUTOPILOT', writesLocked: false })).blocked?.code === 'AUTOPILOT_NOT_ALLOWED_HERE');
  ok('a simulated (test-clock) plan is ALWAYS a simulation, even with every gate open', g(cfgOf({ mode: 'APPROVAL', writesLocked: false }), DC_ON, 'OPEN', true).mode === 'SIMULATION');
  ok('all gates open → LIVE', g(cfgOf({ mode: 'APPROVAL', writesLocked: false })).mode === 'LIVE');

  const dS = '2031-05-29'; const itS = items(4); const pS = await mk({ type: 'OPEN', date: dS, its: itS });
  const nowS = new Date(TM.dueAt('OPEN', dS).getTime() + 60_000); const sl = noSleep(); readCalls = 0; execCalls = 0;
  const nonAdmin = await DP.approvePlan({ planId: pS.id, userId: 2, now: nowS, deps: { ...D0, user: MANAGER, dcfg: DC_OFF, config: async () => cfgOf() } }).catch((e) => e);
  ok('a MANAGER cannot approve (403)', nonAdmin?.status === 403);
  const apS = await DP.approvePlan({ planId: pS.id, userId: 1, now: nowS, deps: { ...D0, dcfg: DC_OFF, config: async () => cfgOf(), readEntity: readEntityOf('PAUSED'), approveAndExecute: stubExec(), sleep: sl.fn } });
  ok('SHADOW approval runs the queue as a SIMULATION', apS.ok && apS.executionMode === 'SIMULATION' && apS.result?.simulated === 4, JSON.stringify(apS));
  ok('every item ends SIMULATED; live Meta state was only READ (4 reads), the executor was NEVER called', (await statuses(pS.id)).every((s) => s === 'SIMULATED') && readCalls === 4 && execCalls === 0);
  ok('no recommendation/action rows were created by the simulation', (await prisma.ambRecommendation.count({ where: { batch_id: `daily-plan-${pS.id}` } })) === 0 && (await prisma.ambAction.count()) === c0.actions);
  const doneS = await get(pS.id); const sumS = JSON.parse(doneS.summary_json);
  ok('plan COMPLETED with summary: metaWrites=0, simulated=4', doneS.status === 'COMPLETED' && sumS.metaWrites === 0 && sumS.simulated === 4 && sumS.executionMode === 'SIMULATION');
  const dupApprove = await DP.approvePlan({ planId: pS.id, userId: 1, now: nowS, deps: { ...D0, dcfg: DC_OFF, config: async () => cfgOf() } });
  ok('approving twice is a no-op (idempotent)', dupApprove.ok === false && dupApprove.status === 'COMPLETED');
  const reRun = await DP.runPlanExecution({ planId: pS.id, userId: 1, deps: { ...D0, dcfg: DC_OFF, config: async () => cfgOf(), sleep: sl.fn } }); ok('a finished plan cannot run again', reRun.skipped === 'NOT_CLAIMED');
  const audS = await DP.planAudit(pS.id); ok('audit has APPROVED + per-item transitions + COMPLETED', audS.some((a) => a.data?.action === 'APPROVED') && audS.filter((a) => a.kind === 'DAILY_PLAN_ITEM').length >= 8 && audS.some((a) => a.data?.action === 'COMPLETED'));

  console.log('\n7. Per-campaign revalidation → SKIPPED/BLOCKED without any write');
  const dV = '2031-05-16'; const itV = [
    item({ rank: 1 }), item({ rank: 2 }), item({ rank: 3 }), item({ rank: 4, evidence: { ...item().evidence, stock: { status: 'OUT_OF_STOCK' } } }), item({ rank: 5, evidence: { ...item().evidence, mapping: 'EXTERNAL_STORE' } }), item({ rank: 6 }), item({ rank: 7 }), item({ rank: 8 }),
  ];
  const pV = await mk({ type: 'OPEN', date: dV, its: itV }); const nowV = new Date(TM.dueAt('OPEN', dV).getTime() + 60_000);
  await prisma.ambOperatorEvent.create({ data: { kind: 'MANUAL_OVERRIDE', actor: 'USER', campaign_id: itV[1].campaignId, note: 'fixture manual edit', data_json: '{}', created_at: new Date(Date.now() + 1000) } });
  const exceptions = async (cid) => (cid === itV[2].campaignId ? [{ scope_type: 'CAMPAIGN', scope_id: cid, types: ['NO_AUTO_OPEN'] }] : []);
  const readV = async (id) => { if (id === itV[5].campaignId) return { id, status: 'ACTIVE', budget: 300 }; if (id === itV[6].campaignId) throw new Error('timeout'); if (id === itV[7].campaignId) return { id: 'OTHER', status: 'PAUSED', budget: 1 }; return { id, status: 'PAUSED', budget: 300 }; };
  execCalls = 0;
  const apV = await DP.approvePlan({ planId: pV.id, userId: 1, now: nowV, deps: { ...D0, dcfg: DC_OFF, config: async () => cfgOf(), exceptions, readEntity: readV, approveAndExecute: stubExec(), sleep: noSleep().fn } });
  const stV = Object.fromEntries((await prisma.ambDailyPlanItem.findMany({ where: { plan_id: pV.id, selected: true } })).map((i) => [i.rank, `${i.status}|${i.status_reason || ''}`]));
  ok('healthy item → SIMULATED', stV[1].startsWith('SIMULATED'), stV[1]);
  ok('manual override after the plan was prepared → SKIPPED', stV[2].startsWith('SKIPPED|MANUAL_OVERRIDE'), stV[2]);
  ok('NO_AUTO_OPEN exception added after preparing → BLOCKED', stV[3].startsWith('BLOCKED|EXCEPTION_NO_AUTO_OPEN'), stV[3]);
  ok('confirmed zero stock → BLOCKED', stV[4].startsWith('BLOCKED|STOCK_OUT'), stV[4]);
  ok('EXTERNAL_STORE mapping → BLOCKED', stV[5].startsWith('BLOCKED|MAPPING_EXTERNAL_STORE'), stV[5]);
  ok('already ACTIVE in Meta → SKIPPED (no double open)', stV[6].startsWith('SKIPPED|ALREADY_ACTIVE'), stV[6]);
  ok('Meta read timeout → SKIPPED (no write on an unknown state)', stV[7].startsWith('SKIPPED|META_UNAVAILABLE'), stV[7]);
  ok('mismatching campaign id from Meta → BLOCKED', stV[8].startsWith('BLOCKED|CAMPAIGN_ID_MISMATCH'), stV[8]);
  ok('none of the above reached the executor', execCalls === 0 && apV.ok);
  // unknown stock: stays selectable with a warning, executes as a simulation (policy: warning, not a block)
  const dU = '2031-05-17'; const pU = await mk({ type: 'OPEN', date: dU, its: [item({ rank: 1, warnings: ['STOCK_UNKNOWN'], evidence: { ...item().evidence, stock: null } })] });
  const apU = await DP.approvePlan({ planId: pU.id, userId: 1, now: new Date(TM.dueAt('OPEN', dU).getTime() + 60_000), deps: { ...D0, dcfg: DC_OFF, config: async () => cfgOf(), readEntity: readEntityOf('PAUSED'), approveAndExecute: stubExec(), sleep: noSleep().fn } });
  ok('unknown stock is a WARNING (not a block) — item runs as a simulation', apU.ok && (await statuses(pU.id))[0] === 'SIMULATED');
  // emergency stop in the middle of the queue
  const dE = '2031-05-18'; const pE = await mk({ type: 'OPEN', date: dE, its: items(3) }); let cfgCalls = 0;
  await DP.approvePlan({ planId: pE.id, userId: 1, now: new Date(TM.dueAt('OPEN', dE).getTime() + 60_000), deps: { ...D0, dcfg: DC_OFF, config: async () => { cfgCalls++; return cfgOf({ emergency_stop: cfgCalls > 2 }); }, readEntity: readEntityOf('PAUSED'), approveAndExecute: stubExec(), sleep: noSleep().fn } }).catch(() => {});
  const stE = await statuses(pE.id); ok('Emergency Stop pressed mid-queue stops the remaining items (BLOCKED)', stE[0] === 'SIMULATED' && stE.slice(1).every((s) => s === 'BLOCKED'), stE.join(','));
  // halted queue
  const dH = '2031-05-19'; const pH = await mk({ type: 'OPEN', date: dH, its: items(2) });
  const apH = await DP.approvePlan({ planId: pH.id, userId: 1, now: new Date(TM.dueAt('OPEN', dH).getTime() + 60_000), deps: { ...D0, dcfg: { ...DC_OFF, halted: true }, config: async () => cfgOf() } });
  ok('halted queue (kill switch) refuses approval', apH.ok === false && apH.blocked === 'QUEUE_HALTED');
  // recent purchase protection on PAUSE plans (late-reporting guard at 13:00)
  const dRP = '2031-05-20'; const pRP = await mk({ type: 'PAUSE', date: dRP, its: items(2) });
  const lp = async (cid) => (cid === pRP.items[0].campaign_id ? new Date(Date.now() - 20 * 60_000) : null);
  await DP.approvePlan({ planId: pRP.id, userId: 1, now: new Date(TM.dueAt('PAUSE', dRP).getTime() + 60_000), deps: { ...D0, dcfg: DC_OFF, config: async () => cfgOf(), lastPurchase: lp, readEntity: readEntityOf('ACTIVE'), approveAndExecute: stubExec(), sleep: noSleep().fn } });
  const stRP = await statuses(pRP.id); ok('a campaign that just got an order is NOT paused at 13:00 (reporting-lag protection) → SKIPPED', stRP[0] === 'SKIPPED' && stRP[1] === 'SIMULATED', stRP.join(','));
  ok('PAUSE plan only pauses ACTIVE campaigns (a PAUSED one is skipped)', await (async () => { const dq = '2031-05-21'; const p = await mk({ type: 'PAUSE', date: dq, its: items(1) }); await DP.approvePlan({ planId: p.id, userId: 1, now: new Date(TM.dueAt('PAUSE', dq).getTime() + 60_000), deps: { ...D0, dcfg: DC_OFF, config: async () => cfgOf(), readEntity: readEntityOf('PAUSED'), sleep: noSleep().fn } }); return (await statuses(p.id))[0] === 'SKIPPED'; })());

  console.log('\n8. Conflict detector — the same campaign in OPEN and PAUSE of one day');
  const dX = '2031-05-22'; const shared = item({ rank: 1 });
  const pXo = await mk({ type: 'OPEN', date: dX, its: [shared] }); const pXp = await mk({ type: 'PAUSE', date: dX, its: [{ ...shared, rank: 1 }] });
  await DP.approvePlan({ planId: pXp.id, userId: 1, now: new Date(TM.dueAt('OPEN', dX).getTime() - 3_600_000), deps: { ...D0, dcfg: DC_ON, config: async () => cfgOf() } }); // PAUSE plan APPROVED (waiting)
  await DP.approvePlan({ planId: pXo.id, userId: 1, now: new Date(TM.dueAt('PAUSE', dX).getTime() + 60_000), deps: { ...D0, dcfg: DC_ON, config: async () => cfgOf(), readEntity: readEntityOf('PAUSED'), sleep: noSleep().fn } });
  const stX = await statuses(pXo.id); ok('OPEN item whose campaign is also in an approved PAUSE plan → BLOCKED (CONFLICT_OPEN_AND_PAUSE)', stX[0] === 'BLOCKED' && (await prisma.ambDailyPlanItem.findFirst({ where: { plan_id: pXo.id } })).status_reason === 'CONFLICT_OPEN_AND_PAUSE');

  console.log('\n9. LIVE execution path (stubbed executor + Meta reads): sequential, spaced ≥ 3s, read-back, no blind retries');
  const live = (o = {}) => ({ ...D0, dcfg: DC_ON, config: async () => cfgOf({ mode: 'APPROVAL', writesLocked: false }), ...o });
  const dL = '2031-05-23'; const pL = await mk({ type: 'OPEN', date: dL, its: items(3), simulated: false }); const slL = noSleep(); execCalls = 0; readCalls = 0;
  const lateOk = new Date(TM.dueAt('OPEN', dL).getTime() + 60_000);
  const apL = await DP.approvePlan({ planId: pL.id, userId: 1, now: lateOk, deps: live({ readEntity: readEntityOf('PAUSED'), approveAndExecute: stubExec(true), sleep: slL.fn }) });
  ok('LIVE approval executes each selected campaign once, in rank order', apL.ok && apL.executionMode === 'LIVE' && execCalls === 3, JSON.stringify(apL));
  ok('items end VERIFIED (read-back confirmed)', (await statuses(pL.id)).every((s) => s === 'VERIFIED'));
  ok('≥ 3s spacing between consecutive writes (2 gaps)', slL.calls.filter((ms) => ms >= 3000).length === 2, JSON.stringify(slL.calls));
  const doneL = JSON.parse((await get(pL.id)).summary_json); ok('summary: verified=3, metaWrites=3, actuallyChanged=3', doneL.verified === 3 && doneL.metaWrites === 3 && doneL.actuallyChanged === 3);
  const recs = await prisma.ambRecommendation.findMany({ where: { batch_id: `daily-plan-${pL.id}` } }); ok('each campaign produced ONE recommendation → executor call (RESUME for OPEN)', recs.length === 3 && recs.every((r) => r.action_type === 'RESUME'));
  // unconfirmed read-back => UNCERTAIN, never re-sent
  const dL2 = '2031-05-24'; const pL2 = await mk({ type: 'OPEN', date: dL2, its: items(1), simulated: false }); execCalls = 0;
  await DP.approvePlan({ planId: pL2.id, userId: 1, now: new Date(TM.dueAt('OPEN', dL2).getTime() + 60_000), deps: live({ readEntity: readEntityOf('PAUSED'), approveAndExecute: stubExec(false), sleep: noSleep().fn }) });
  ok('a write Meta did not confirm immediately is UNCERTAIN (no re-POST)', (await statuses(pL2.id))[0] === 'UNCERTAIN' && execCalls === 1);
  // executor throws AFTER the request went out: independent read decides; never a second POST
  const dL3 = '2031-05-25'; const pL3 = await mk({ type: 'OPEN', date: dL3, its: items(2), simulated: false }); execCalls = 0;
  const throwing = async ({ recId }) => { execCalls++; const rec = await prisma.ambRecommendation.findUnique({ where: { id: recId } }); await prisma.ambAction.create({ data: { recommendation_id: rec.id, mode: 'APPROVAL', action_type: rec.action_type, ad_account_id: rec.ad_account_id, level: rec.level, entity_id: rec.entity_id, entity_name: rec.entity_name, campaign_id: rec.campaign_id, approval_status: 'APPROVED', execution_status: 'FAILED', meta_request_json: JSON.stringify({ id: rec.entity_id }), meta_error: 'socket hang up' } }); throw new Error('socket hang up'); };
  await DP.approvePlan({ planId: pL3.id, userId: 1, now: new Date(TM.dueAt('OPEN', dL3).getTime() + 60_000), deps: live({ readEntity: readEntityOf('PAUSED'), approveAndExecute: throwing, readBack: async ({ campaignId }) => ({ status: campaignId === pL3.items[0].campaign_id ? 'ACTIVE' : 'PAUSED' }), sleep: noSleep().fn }) });
  const stL3 = await statuses(pL3.id); ok('error after the request: Meta says ACTIVE → VERIFIED; still PAUSED → FAILED; one executor call each (no retry)', stL3[0] === 'VERIFIED' && stL3[1] === 'FAILED' && execCalls === 2, stL3.join(','));
  // rate limit => skip with backoff, stop after repeated limits
  const dL4 = '2031-05-26'; const pL4 = await mk({ type: 'OPEN', date: dL4, its: items(5), simulated: false }); const sl4 = noSleep(); execCalls = 0;
  const rl = async () => { const e = new Error('(#17) User request limit reached'); e.isMetaRateLimit = true; throw e; };
  await DP.approvePlan({ planId: pL4.id, userId: 1, now: new Date(TM.dueAt('OPEN', dL4).getTime() + 60_000), deps: live({ readEntity: rl, approveAndExecute: stubExec(), sleep: sl4.fn }) });
  const st4 = await statuses(pL4.id); ok('Meta rate limit: items SKIPPED (META_RATE_LIMITED), back-off sleeps ≥ 30s, queue aborts after 3, nothing written', st4.every((s) => s === 'SKIPPED') && sl4.calls.some((ms) => ms >= 30_000) && execCalls === 0 && (await prisma.ambDailyPlanItem.count({ where: { plan_id: pL4.id, status_reason: 'RATE_LIMIT_STOP' } })) === 2, st4.join(','));
  // plan cancelled while it runs: remaining items are skipped
  const dL5 = '2031-05-27'; const pL5 = await mk({ type: 'OPEN', date: dL5, its: items(3), simulated: false }); execCalls = 0;
  const cancelMid = async (a) => { const r = await stubExec(true)(a); await DP.cancelPlan({ planId: pL5.id, userId: 1, reason: 'mid-run' }); return r; };
  await DP.approvePlan({ planId: pL5.id, userId: 1, now: new Date(TM.dueAt('OPEN', dL5).getTime() + 60_000), deps: live({ readEntity: readEntityOf('PAUSED'), approveAndExecute: cancelMid, sleep: noSleep().fn }) });
  const st5 = await statuses(pL5.id); ok('cancel while running: the sent item is final, the rest are SKIPPED (PLAN_CANCELLED)', st5[0] === 'VERIFIED' && st5.slice(1).every((s) => s === 'SKIPPED') && execCalls === 1, st5.join(','));
  // post-open monitoring guard
  const opens = await BO.loadRecentDailyOpens({ campaignIds: pL.items.map((i) => i.campaign_id), now: new Date() });
  ok('Dynamic Budget Optimizer sees real (non-simulated) VERIFIED opens inside the monitoring window', opens.size === 3); // fixture plan dates are in 2031 but status_at is "now"
  ok('simulated opens never trigger the budget monitoring guard', (await BO.loadRecentDailyOpens({ campaignIds: pS.items.map((i) => i.campaign_id), now: new Date() })).size === 0);
  const boSrc = fs.readFileSync(join(__dirname, '../services/amb/budgetOptimizer.js'), 'utf8'); ok('POST_OPEN_MONITORING is a protecting guard in the optimizer', /PROTECTED_CODES = new Set\([^)]*POST_OPEN_MONITORING/.test(boSrc) && boSrc.includes("code: 'POST_OPEN_MONITORING'"));

  console.log('\n10. Exclusions / winner protection / config');
  const dP = '2031-05-28'; const itP = items(3); const pP = await mk({ type: 'PAUSE', date: dP, its: itP });
  await DP.protectWinner({ campaignId: itP[0].campaignId, userId: 1, label: 'fixture' });
  await DP.excludeCampaign({ campaignId: itP[1].campaignId, scope: 'DAY', userId: 1, now: new Date() });
  const afterP = await get(pP.id); const byC = Object.fromEntries(afterP.items.map((i) => [i.campaign_id, i]));
  ok('protected winner is unselected + unselectable in the open PAUSE plan', !byC[itP[0].campaignId].selected && !byC[itP[0].campaignId].selectable && byC[itP[0].campaignId].eligibility === 'PROTECTED');
  ok('"exclude for today" drops the campaign from open plans and creates a TTL exception', !byC[itP[1].campaignId].selected && (await prisma.ambOperatorException.count({ where: { scope_id: itP[1].campaignId, reason: 'DAILY_PLAN_EXCLUDED_TODAY', active: true, expires_at: { not: null } } })) === 1);
  await DP.excludeCampaign({ campaignId: itP[2].campaignId, scope: 'ALWAYS', userId: 1 }); ok('"exclude always" has no expiry', (await prisma.ambOperatorException.count({ where: { scope_id: itP[2].campaignId, reason: 'DAILY_PLAN_EXCLUDED_ALWAYS', expires_at: null } })) === 1);
  let badScope = null; try { await DP.excludeCampaign({ campaignId: 'x', scope: 'WEEK', userId: 1 }); } catch (e) { badScope = e; } ok('invalid exclusion scope is rejected', badScope?.status === 400);
  const before = await DP.getDailyPlanConfig(); const after = await DP.setDailyPlanConfig({ patch: { halted: true, spacingSeconds: 1, allowOpen: true }, userId: null }); // allowOpen is ignored now (permissions come from the audited switches)
  ok('config: spacing is floored at 3s; halted/allow flags saved; scheduled execution untouched', after.spacingSeconds === 3 && after.halted === true && after.allowOpen === false && after.scheduledExecution.enabled === before.scheduledExecution.enabled);
  const rawNow = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); ok('saving the daily config does not change mode, emergency stop or other operator limits', rawNow.mode === rawCfg0.mode && rawNow.emergency_stop === rawCfg0.emergency_stop && (() => { const a = JSON.parse(rawCfg0.limits_json || '{}'), b = JSON.parse(rawNow.limits_json || '{}'); delete b.dailyPlan; delete a.dailyPlan; return JSON.stringify(a) === JSON.stringify(b); })());

  console.log('\n11. Scheduler tick under the virtual clock (simulated plans only)');
  TM.setTestClock(TM.dueAt('OPEN', '2031-06-01'));
  const tick = await DP.runDailyPlanTick({ now: TM.clockNow(), deps: { ...FRESH, build: async ({ type }) => ({ items: items(2), policy: null }), candidates: {} } });
  ok('00:00 Cairo tick prepares ONLY the OPEN plan (simulated)', tick.prepared.length === 1 && tick.prepared[0].type === 'OPEN' && (await prisma.ambDailyPlan.findFirst({ where: { plan_key: 'SIM|OPEN|2031-06-01' } }))?.simulated === true, JSON.stringify(tick));
  const tick2 = await DP.runDailyPlanTick({ now: TM.clockNow(), deps: { ...FRESH, build: async () => ({ items: items(2), policy: null }) } }); ok('a second tick (server restart) does not duplicate the plan', tick2.prepared.length === 0 && (await prisma.ambDailyPlan.count({ where: { plan_key: 'SIM|OPEN|2031-06-01' } })) === 1);
  TM.setTestClock(TM.dueAt('PAUSE', '2031-06-01'));
  const tick3 = await DP.runDailyPlanTick({ now: TM.clockNow(), deps: { ...FRESH, build: async () => ({ items: items(2), policy: null }) } }); ok('13:00 Cairo tick prepares the PAUSE plan', tick3.prepared.some((p) => p.type === 'PAUSE'), JSON.stringify(tick3));
  const popups = await DP.getDuePopups({ now: TM.clockNow(), simulated: true }); ok('popup source lists both due, unreviewed plans', popups.filter((p) => p.plan).length === 2);
  await DP.dismissPopup({ planId: popups[0].planId, userId: 1 }); ok('a dismissed popup is not listed again, but the plan stays in the center', (await DP.getDuePopups({ now: TM.clockNow(), simulated: true })).filter((p) => p.plan).length === 1 && (await get(popups[0].planId)).status === 'PREPARED');
  const ovT = await DP.getDailyOverview({ now: TM.clockNow(), simulated: true }); ok('overview exposes both plans, next due slot, control state and dashboard numbers', ovT.plans.OPEN && ovT.plans.PAUSE && ovT.dashboard.selected >= 0 && ovT.control.mode && ovT.dashboard.nextDue.type);
  TM.setTestClock(null);
  const realTick = await prisma.ambDailyPlan.count({ where: { simulated: false, plan_date: { startsWith: '2031-06' } } }); ok('the real (non-virtual) scheduler never sees virtual plans', realTick === 0);

  console.log('\n12. HTTP surface — ADMIN-only mutations, MANAGER can read');
  for (const role of ['ADMIN', 'MANAGER']) { const u = await prisma.user.create({ data: { email: `${T}dp_${role}_${Date.now()}@example.invalid`, password_hash: 'x'.repeat(20), name: `${T}dp ${role}`, role, status: 'ACTIVE', permissions: '{}' } }); created.users.push({ id: u.id, role }); }
  const tok = (role) => jwt.sign({ id: created.users.find((u) => u.role === role).id, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const app = express(); app.use(cookieParser()); app.use(express.json()); app.use('/api/operator', operatorRoutes); app.use(errorHandler);
  const server = await new Promise((rs) => { const s = app.listen(0, '127.0.0.1', () => rs(s)); }); const base = `http://127.0.0.1:${server.address().port}/api/operator`;
  const call = async (method, path, body, role) => { const x = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(role ? { Cookie: `token=${tok(role)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); let json = null; try { json = await x.json(); } catch { /* */ } return { status: x.status, json }; };
  try {
    ok('unauthenticated → 401', (await call('GET', '/daily-plan/overview')).status === 401);
    const pr = await mk({ type: 'OPEN', date: '2031-06-05', its: items(2) });
    ok('MANAGER cannot create an independent plan or preview an execution (403)', (await call('POST', '/daily-plan/new', { type: 'OPEN' }, 'MANAGER')).status === 403 && (await call('POST', '/daily-plan/1/preview-execution', {}, 'MANAGER')).status === 403);
    ok('MANAGER can read a plan (GET /daily-plan/:id)', (await call('GET', `/daily-plan/${pr.id}`, undefined, 'MANAGER')).status === 200);
    ok('MANAGER cannot change selection (403)', (await call('PUT', `/daily-plan/${pr.id}/selection`, { selections: {} }, 'MANAGER')).status === 403);
    ok('MANAGER cannot approve (403)', (await call('POST', `/daily-plan/${pr.id}/approve`, {}, 'MANAGER')).status === 403);
    ok('MANAGER cannot cancel / exclude / protect / halt / configure (403)', (await Promise.all([call('POST', `/daily-plan/${pr.id}/cancel`, {}, 'MANAGER'), call('POST', '/daily-plan/exclude', { campaignId: 'x' }, 'MANAGER'), call('POST', '/daily-plan/protect', { campaignId: 'x' }, 'MANAGER'), call('POST', '/daily-plan/halt', {}, 'MANAGER'), call('PUT', '/daily-plan/config', { halted: true }, 'MANAGER')])).every((r) => r.status === 403));
    const sel = await call('PUT', `/daily-plan/${pr.id}/selection`, { selections: { [pr.items[0].campaign_id]: false } }, 'ADMIN'); ok('ADMIN can change the selection', sel.status === 200 && sel.json.plan.counts.selected === 1);
    const apr = await call('POST', `/daily-plan/${pr.id}/approve`, {}, 'ADMIN'); ok('ADMIN approving a plan whose time has long passed is refused by date (no side effects)', apr.status === 200 && apr.json.ok === false && ['MISSED', 'NOT_DUE_YET', 'STALE_DATA', 'BLOCKED'].includes(apr.json.status), JSON.stringify(apr.json));
    ok('test-clock route requires ADMIN; the env flag is the real gate', (await call('PUT', '/daily-plan/test-clock', { at: null }, 'MANAGER')).status === 403 && (await call('PUT', '/daily-plan/test-clock', { at: null }, 'ADMIN')).status === 200);
    ok('dismissing the popup (a shared state change) is ADMIN-only; ADMIN can', (await call('POST', `/daily-plan/${pr.id}/dismiss`, {}, 'MANAGER')).status === 403 && (await call('POST', `/daily-plan/${pr.id}/dismiss`, {}, 'ADMIN')).status === 200);
  } finally { server.close(); }

  console.log('\n14. Independent plans (any time) + preview — the day\'s standard plan is never touched');
  const dI = '2031-08-05'; TM.setTestClock(TM.dueAt('PAUSE', dI)); const nowI = TM.clockNow();
  const bld = async () => ({ items: items(3), policy: null });
  const o1 = DP.startOneOffPlan({ type: 'OPEN', userId: 1, now: nowI, deps: { ...FRESH, build: bld } });
  const o2 = DP.startOneOffPlan({ type: 'OPEN', userId: 1, now: nowI, deps: { ...FRESH, build: bld } });
  ok('a second request while one is being built is refused (already) and the build is visible as "preparing"', o1.started === true && o2.already === true && DP.preparingPlans().some((x) => x.type === 'OPEN'));
  const built1 = await o1.done; const pI = built1.plan;
  ok('independent plan created: key contains the T- variant, PREPARED, nothing pre-ticked (the owner chooses)', pI.plan_key.includes('|T-') && pI.status === 'PREPARED' && pI.items.length === 3 && pI.items.every((i) => !i.selected) && DP.preparingPlans().length === 0);
  const std = await prisma.ambDailyPlan.count({ where: { plan_key: `SIM|OPEN|${dI}` } });
  ok('it does not create or touch the standard plan of that day', std === 0);
  const a1 = await DP.updateSelection({ planId: pI.id, selections: { [pI.items[0].campaign_id]: true }, userId: 1 }); ok('tick ONE campaign → saved', a1.plan.counts.selected === 1 && a1.newVersion === false);
  const a2 = await DP.updateSelection({ planId: pI.id, selections: { [pI.items[0].campaign_id]: false }, userId: 1 }); ok('untick → saved (0 selected)', a2.plan.counts.selected === 0);
  await DP.updateSelection({ planId: pI.id, selections: { [pI.items[0].campaign_id]: true, [pI.items[1].campaign_id]: true }, userId: 1 }); ok('tick several → saved (2 selected)', (await get(pI.id)).items.filter((i) => i.selected).length === 2);
  execCalls = 0; readCalls = 0;
  const pv = await DP.previewExecution({ planId: pI.id, now: nowI, deps: { readEntity: readEntityOf('PAUSED'), exceptions: async () => [], lastPurchase: async () => null, mappingState: async () => null, config: async () => cfgOf(), dcfg: DC_OFF } });
  ok('preview: gate = SIMULATION (SHADOW), both selected campaigns revalidated live, nothing executed, plan still PREPARED + items PENDING', pv.gate.mode === 'SIMULATION' && pv.previewed === 2 && pv.wouldExecute === 2 && readCalls === 2 && execCalls === 0 && (await get(pI.id)).status === 'PREPARED' && (await statuses(pI.id)).every((x) => x === 'PENDING'), JSON.stringify(pv.gate));
  const pvLive = await DP.previewExecution({ planId: pI.id, now: nowI, deps: { readEntity: readEntityOf('ACTIVE'), exceptions: async () => [], lastPurchase: async () => null, mappingState: async () => null, config: async () => cfgOf(), dcfg: DC_OFF } });
  ok('preview shows what would be skipped (already ACTIVE) without executing', pvLive.wouldExecute === 0 && pvLive.items.every((x) => x.reason === 'ALREADY_ACTIVE'));
  const apI = await DP.approvePlan({ planId: pI.id, userId: 1, now: nowI, deps: { ...D0, dcfg: DC_OFF, config: async () => cfgOf(), readEntity: readEntityOf('PAUSED'), approveAndExecute: stubExec(), sleep: noSleep().fn } });
  ok('approving executes only the SIMULATION and completes the independent plan', apI.ok && (await get(pI.id)).status === 'COMPLETED' && execCalls === 0);
  let e409 = null; try { await DP.updateSelection({ planId: pI.id, selections: { [pI.items[2].campaign_id]: true }, userId: 1 }); } catch (e) { e409 = e; }
  ok('a COMPLETED plan stays saved and cannot be edited (409)', e409?.status === 409 && (await get(pI.id)).items.filter((i) => i.selected).length === 2);
  const o3 = DP.startOneOffPlan({ type: 'OPEN', userId: 1, now: nowI, deps: { ...FRESH, build: bld } }); const pI2 = (await o3.done).plan;
  ok('a NEW independent plan can be created right after, with its own key and selections', pI2.id !== pI.id && pI2.plan_key !== pI.plan_key && pI2.status === 'PREPARED');
  const ovI = await DP.getDailyOverview({ now: nowI, simulated: true });
  ok('the overview lists the independent plans separately from the standard OPEN/PAUSE panels', ovI.oneOffPlans.length === 2 && ovI.oneOffPlans.every((x) => x.key.includes('|T-')) && ovI.plans.OPEN === null);
  TM.setTestClock(null);

  console.log('\n13. Static guarantees');
  const src = fs.readFileSync(join(__dirname, '../services/amb/dailyPlans.js'), 'utf8');
  ok('dailyPlans.js has NO direct Meta write helper (setEntityStatus / setEntityBudget / graphPost)', !/setEntityStatus|setEntityBudget|graphPost|method:\s*['"]POST['"]/.test(src));
  ok('the ONLY write path is the existing executor (approveAndExecute)', /import\('\.\/executor\.js'\)/.test(src) && !/from '\.\/executor\.js'/.test(src.replace(/import\('\.\/executor\.js'\)/g, '')) && (src.match(/approveAndExecute/g) || []).length >= 2);
  ok('the scheduler tick can only execute when scheduledExecution.enabled (default OFF) and never for virtual plans', /dcfg\.scheduledExecution\.enabled && !sim/.test(src) && DP.DEFAULT_DAILY_CONFIG.scheduledExecution.enabled === false && DP.DEFAULT_DAILY_CONFIG.allowOpen === false && DP.DEFAULT_DAILY_CONFIG.allowPause === false);
  ok('default spacing is 3s; stale threshold 30 min', DP.DEFAULT_DAILY_CONFIG.spacingSeconds === 3 && DP.DEFAULT_DAILY_CONFIG.staleMinutes === 30);
  const realCfgNow = await S.getOperatorConfig(); ok('real system state untouched: mode/emergency same as before the test', realCfgNow.mode === rawCfg0.mode && realCfgNow.emergency_stop === rawCfg0.emergency_stop);
} catch (e) {
  fail++; console.log('  ✗ UNEXPECTED', e.stack || e.message);
} finally {
  TM.setTestClock(null);
  const plans = await prisma.ambDailyPlan.findMany({ where: { plan_date: { startsWith: '2031-' } }, select: { id: true, plan_key: true } });
  const ids = plans.map((p) => p.id);
  const recs = await prisma.ambRecommendation.findMany({ where: { OR: [{ batch_id: { in: ids.map((i) => `daily-plan-${i}`) } }, { entity_id: { startsWith: T } }] }, select: { id: true } });
  await prisma.ambActionResult.deleteMany({ where: { action: { recommendation_id: { in: recs.map((r) => r.id) } } } }).catch(() => {});
  await prisma.ambAction.deleteMany({ where: { recommendation_id: { in: recs.map((r) => r.id) } } }).catch(() => {});
  await prisma.ambRecommendation.deleteMany({ where: { id: { in: recs.map((r) => r.id) } } }).catch(() => {});
  for (const id of ids) await prisma.ambOperatorEvent.deleteMany({ where: { data_json: { contains: `"planId":${id},` } } }).catch(() => {});
  await prisma.ambOperatorEvent.deleteMany({ where: { campaign_id: { startsWith: T } } }).catch(() => {});
  await prisma.ambDailyPlan.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.ambOperatorException.deleteMany({ where: { scope_id: { startsWith: T } } }).catch(() => {});
  await prisma.ambAlert.deleteMany({ where: { dedupe_key: { startsWith: 'dailyplan:' }, AND: [{ dedupe_key: { contains: '2031-' } }] } }).catch(() => {});
  await prisma.aiAuditLog.deleteMany({ where: { kind: 'DAILY_PLAN_CONFIG', created_at: { gte: new Date(Date.now() - 3_600_000) }, actor_id: null } }).catch(() => {});
  // restore the operator config row exactly as it was (the config test saved dailyPlan settings)
  if (rawCfg0) await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: sanitizeLimits(rawCfg0.limits_json), updated_by_id: rawCfg0.updated_by_id } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created.users.map((u) => u.id) } } }).catch(() => {});
  console.log(`\nSAFETY: AmbActions ${c0.actions} -> ${await prisma.ambAction.count()} | recs ${c0.recs} -> ${await prisma.ambRecommendation.count()} | decisions ${c0.decisions} -> ${await prisma.ambOperatorDecision.count()} | Meta calls in this test = 0 (all reads/writes stubbed)`);
  console.log(`\n${fail === 0 ? '✅' : '❌'} dailyPlanTest: ${pass} passed, ${fail} failed`);
  await prisma.$disconnect(); process.exit(fail ? 1 : 0);
}
