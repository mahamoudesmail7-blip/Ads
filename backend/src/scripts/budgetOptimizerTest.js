// 💰 Dynamic Budget Optimizer acceptance — policy zones, CBO/ABO discovery, new-evidence-since-change, cooldowns, guards, action history. SHADOW only:
// no Meta call, no executor, disposable "__optest_" fixtures that are always cleaned up.
//   node src/scripts/budgetOptimizerTest.js
import 'dotenv/config';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const retryDb = async (fn) => { for (let i = 0; i < 10; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 4000)); } } return fn(); };
if (!process.env.JWT_SECRET) { console.log('JWT_SECRET missing'); process.exit(2); }
const { prisma } = await imp('../prisma.js');
const BO = await imp('../services/amb/budgetOptimizer.js');
const S = await imp('../services/amb/operatorStore.js');
const { default: operatorRoutes } = await imp('../routes/operator.js');
const { errorHandler } = await imp('../middleware/errorHandler.js');

const T = '__optest_';
const t0 = new Date();
const origCfg = await S.getOperatorConfig();
const origLimits = JSON.parse(JSON.stringify(origCfg.limits));
const counts0 = { recs: await prisma.ambRecommendation.count(), actions: await prisma.ambAction.count(), decisions: await prisma.ambOperatorDecision.count() };
const created = { users: [], runs: [] };
const P = BO.DEFAULT_POLICY;
const NOW = new Date('2026-10-06T20:00:00Z');
const m = (spend, purchases) => ({ spend, purchases, cpa: purchases > 0 ? spend / purchases : null });
const cls = (o) => BO.classifyBudget({ policy: P, now: NOW, ageHours: 100, ...o });
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000);

try {
  // ===================================================================================================================
  console.log('\n1. policy');
  ok('defaults are the owner policy and the optimizer is DISABLED', P.enabled === false && P.zeroOrders.spend === 200 && P.scale.minPurchases === 2 && P.scale.maxCpa === 80 && P.scale.pct === 20 && P.scale.cooldownHours === 24 && P.scale.minAgeHours === 48 && P.reduce.minPurchases === 3 && P.reduce.minSpend === 450 && P.reduce.minCpa === 150 && P.reduce.maxCpa === 200 && P.reduce.min7dCpa === 150 && P.reduce.pct === 20 && P.reduce.cooldownHours === 48 && P.highCpa.above === 200 && P.directPauseAbove === undefined);
  ok('no direct pause at CPA > 300 exists in the policy (it needs its own preview first)', !JSON.stringify(P).includes('300'));
  ok('mergePolicy overlays nested values without losing defaults', BO.mergePolicy({ scale: { pct: 15 } }).scale.maxCpa === 80 && BO.mergePolicy({ scale: { pct: 15 } }).scale.pct === 15);
  ok('minAgeHours is validated (negative rejected)', BO.validatePolicy(BO.mergePolicy({ scale: { minAgeHours: -1 } })).length > 0);
  ok('validation: defaults pass; scale line above reduce start fails; bad numbers fail', BO.validatePolicy(P).length === 0 && BO.validatePolicy(BO.mergePolicy({ scale: { maxCpa: 160 } })).length > 0 && BO.validatePolicy(BO.mergePolicy({ reduce: { pct: -5 } })).length > 0 && BO.validatePolicy(BO.mergePolicy({ reduce: { maxCpa: 250 } })).length > 0);

  // ===================================================================================================================
  console.log('\n2. budget-level discovery (CBO vs ABO) — never guessed');
  let d = BO.discoverBudgetEntities({ campaign: { id: 'c1', status: 'ACTIVE', budget: 500, budgetType: 'DAILY' }, adsets: [{ id: 'a1', status: 'ACTIVE', budget: null }] });
  ok('CBO: the campaign carries the budget => level campaign', d.level === 'campaign' && d.entities.length === 1 && d.entities[0].id === 'c1' && d.entities[0].budget === 500);
  d = BO.discoverBudgetEntities({ campaign: { id: 'c2', status: 'ACTIVE', budget: null }, adsets: [{ id: 'a1', status: 'ACTIVE', budget: 200, budgetType: 'DAILY' }, { id: 'a2', status: 'PAUSED', budget: 200, budgetType: 'DAILY' }] });
  ok('ABO: only the ACTIVE ad set is the target (paused ad sets ignored) => level adset', d.level === 'adset' && d.entities.length === 1 && d.entities[0].id === 'a1' && d.entities[0].budget === 200);
  d = BO.discoverBudgetEntities({ campaign: { id: 'c3', status: 'ACTIVE', budget: null }, adsets: [{ id: 'a1', status: 'ACTIVE', budget: 200 }, { id: 'a2', status: 'ACTIVE', budget: 300 }] });
  ok('ABO with two active ad sets => two targets, each with its own budget', d.entities.length === 2 && d.entities.map((e) => e.budget).join() === '200,300');
  d = BO.discoverBudgetEntities({ campaign: { id: 'c4', status: 'ACTIVE', budget: 500 }, adsets: [{ id: 'a1', status: 'ACTIVE', budget: 200 }] });
  ok('budget on BOTH levels (impossible on Meta) => UNKNOWN, nothing guessed', d.level === 'UNKNOWN' && d.entities.length === 0 && d.reason === 'BUDGET_ON_BOTH_LEVELS');
  d = BO.discoverBudgetEntities({ campaign: { id: 'c5', status: 'ACTIVE', budget: null }, adsets: [{ id: 'a1', status: 'ACTIVE', budget: null }] });
  ok('no budget anywhere => UNKNOWN', d.level === 'UNKNOWN' && d.reason === 'ACTIVE_ADSETS_WITHOUT_BUDGET');
  d = BO.discoverBudgetEntities({ campaign: { id: 'c6', status: 'ACTIVE', budget: null }, adsets: [] });
  ok('no ad sets => UNKNOWN', d.level === 'UNKNOWN');
  d = BO.discoverBudgetEntities({ campaign: { id: 'c7', status: 'ACTIVE', budget: 500, budgetType: 'LIFETIME' }, adsets: [] });
  ok('lifetime budgets are flagged unsupported (never treated as daily)', d.unsupported === 'BUDGET_TYPE_NOT_DAILY');

  // ===================================================================================================================
  console.log('\n3. policy zones (pure) — boundaries and sample gates');
  let r = cls({ m: m(199, 0) });
  ok('spend 199 and no orders => no action', r.action === null && r.zone === 'NO_ORDERS_YET');
  r = cls({ m: m(200, 0) });
  ok('spend 200 and no orders => PAUSE (zero orders)', r.action === 'PAUSE' && r.zone === 'ZERO_ORDERS' && r.rule === 'DYN_ZERO_ORDERS');
  r = cls({ m: m(900, 0), ageHours: 10 });
  ok('zero orders on a campaign younger than 24h => protected, no pause', r.action === null && r.zone === 'ZERO_ORDERS_TOO_YOUNG');
  r = cls({ m: m(300, 4) });
  ok('CPA 75 with 4 orders => SCALE_UP +20% (HIGH needs economics + stock)', r.action === 'SCALE_UP' && r.pct === 20 && r.needs.profit && r.needs.stock);
  r = cls({ m: m(300, 4), ageHours: 47 });
  ok('Scale needs a campaign age >= 48h: 47h => SCALE_TOO_YOUNG, no change', r.action === null && r.zone === 'SCALE_TOO_YOUNG');
  r = cls({ m: m(300, 4), ageHours: 48 });
  ok('...and exactly 48h => SCALE_UP', r.action === 'SCALE_UP');
  r = cls({ m: m(700, 0), ageHours: 30 });
  ok('the 48h age gate is for SCALE only: pause keeps its own 24h gate, reduce has none', r.action === 'PAUSE' && cls({ m: m(603, 3), m7: m(603, 3), ageHours: 30 }).action === 'SCALE_DOWN');
  r = cls({ m: m(80, 1) });
  ok('CPA 80 with ONE order => no scale (never from one random purchase)', r.action === null && r.zone === 'SCALE_SAMPLE_INSUFFICIENT');
  r = cls({ m: m(100, 2) });
  ok('2 orders but spend 100 < 150 => no scale', r.action === null);
  r = cls({ m: m(160, 2) });
  ok('CPA exactly 80, 2 orders, spend 160 => SCALE_UP (inclusive)', r.action === 'SCALE_UP');
  r = cls({ m: m(243, 3) });
  ok('CPA 81 => KEEP', r.action === null && r.zone === 'KEEP');
  r = cls({ m: m(447, 3) });
  ok('CPA 149 => KEEP', r.zone === 'KEEP' && r.action === null);
  r = cls({ m: m(1, 0.0001 * 0 + 1) }); // cpa 1 -> scale zone but spend small
  ok('tiny sample is never actionable', r.action === null);
  r = cls({ m: m(450, 3), m7: m(900, 6) });
  ok('CPA 150 + sample (3 orders, 450) + 7d CPA 150 => REDUCE -20% (inclusive lower bound)', r.action === 'SCALE_DOWN' && r.pct === 20 && r.zone === 'REDUCE' && r.rule === 'DYN_REDUCE');
  r = cls({ m: m(600, 3), m7: m(750, 5) });
  ok('CPA 200 + sample + 7d CPA 150 => REDUCE (inclusive upper bound)', r.action === 'SCALE_DOWN' && r.zone === 'REDUCE');
  r = cls({ m: m(560, 3), m7: m(900, 9) });
  ok('7d CPA 100 (< 150): the bad window is a bad DAY, not a trend => KEEP', r.action === null && r.zone === 'REDUCE_7D_NOT_CONFIRMED');
  r = cls({ m: m(560, 3), m7: null });
  ok('7d CPA unknown => no reduce', r.action === null && r.zone === 'REDUCE_7D_NOT_CONFIRMED');
  r = cls({ m: m(400, 2), m7: m(800, 4) });
  ok('reduce zone but only 2 orders / spend 400 => sample too small, KEEP', r.action === null && r.zone === 'REDUCE_SAMPLE_INSUFFICIENT');
  r = cls({ m: m(603, 3), m7: m(603, 3) });
  ok('CPA 201 with sample => HIGH_CPA: REDUCE first (never pause)', r.zone === 'HIGH_CPA' && r.action === 'SCALE_DOWN' && r.rule === 'DYN_HIGH_CPA_REDUCE');
  r = cls({ m: m(1400, 4), m7: m(1400, 4) });
  ok('CPA 350 with a strong sample is STILL reduce -20%: no direct pause at > 300', r.action === 'SCALE_DOWN' && r.action !== 'PAUSE' && r.zone === 'HIGH_CPA');
  r = cls({ m: m(444, 2) });
  ok('CPA 222 from 2 orders => HIGH_CPA but the sample is too small: KEEP', r.action === null && r.zone === 'HIGH_CPA_SAMPLE_INSUFFICIENT');
  r = cls({ m: m(402, 1) });
  ok('CPA 402 from ONE order => KEEP (no decision from one purchase)', r.action === null);
  r = cls({ m: null });
  ok('no data => KEEP/NO_DATA (unknown is never zero)', r.action === null && r.zone === 'NO_DATA');
  ok('flagged for human review after the 3rd consecutive reduction (never an automatic pause)', cls({ m: m(603, 3), m7: m(603, 3), reductionStreak: 2 }).flagReview === true && cls({ m: m(603, 3), m7: m(603, 3), reductionStreak: 0 }).flagReview === false);

  // ===================================================================================================================
  console.log('\n4. cooldown + NEW evidence since the last change + compounding protection');
  r = cls({ m: m(300, 4), lastChange: { at: hoursAgo(10), action: 'SCALE_UP' }, since: { spend: 400, purchases: 6, cpa: 66 } });
  ok('10h after a scale: COOLDOWN (24h) — no second +20% even though the new CPA is 66', r.action === null && r.zone === 'COOLDOWN' && r.cooldownRemainingH === 14);
  r = cls({ m: m(300, 4), lastChange: { at: hoursAgo(30), action: 'SCALE_DOWN' }, since: { spend: 400, purchases: 6, cpa: 66 } });
  ok('30h after a REDUCE: still in the 48h cooldown', r.zone === 'COOLDOWN' && r.cooldownRemainingH === 18);
  r = cls({ m: m(300, 4), lastChange: { at: hoursAgo(30), action: 'SCALE_UP' }, since: { spend: 100, purchases: 3, cpa: 33 } });
  ok('cooldown over but only 100 spend since the change (< 150): NO new evidence => no change', r.action === null && r.zone === 'NO_NEW_EVIDENCE');
  r = cls({ m: m(300, 4), lastChange: { at: hoursAgo(30), action: 'SCALE_UP' }, since: null });
  ok('cooldown over and no data since the change => no change', r.zone === 'NO_NEW_EVIDENCE');
  r = cls({ m: m(2000, 8), lastChange: { at: hoursAgo(30), action: 'SCALE_UP' }, since: { spend: 280, purchases: 4, cpa: 70 } });
  ok('after the cooldown with NEW evidence CPA 70 (4 orders) => +20% AGAIN, decided ONLY from the data since the change (the old window is ignored)', r.action === 'SCALE_UP' && r.sample.cpa === 70 && r.sample.purchases === 4 && r.evidence.kind === 'SINCE_LAST_CHANGE', JSON.stringify(r));
  r = cls({ m: m(100, 5), lastChange: { at: hoursAgo(60), action: 'SCALE_DOWN' }, since: { spend: 620, purchases: 3, cpa: 207 }, m7: m(900, 3) });
  ok('after a reduce + cooldown, CPA still > 200 on NEW data with sample => re-evaluated (reduce again), not paused', r.zone === 'HIGH_CPA' && r.action === 'SCALE_DOWN');
  r = cls({ m: m(100, 5), lastChange: { at: hoursAgo(60), action: 'SCALE_DOWN' }, since: { spend: 260, purchases: 0, cpa: null } });
  ok('after a reduce + cooldown, 260 spent since then with ZERO orders => zero-orders PAUSE on the new data', r.action === 'PAUSE' && r.zone === 'ZERO_ORDERS');
  ok('budget arithmetic: 500 → 600, 500 → 400, 200 → 240, 333 → 400 (rounded), PAUSE keeps budget, unknown stays null', BO.proposedBudget('SCALE_UP', 500, 20) === 600 && BO.proposedBudget('SCALE_DOWN', 500, 20) === 400 && BO.proposedBudget('SCALE_UP', 200, 20) === 240 && BO.proposedBudget('SCALE_UP', 333, 20) === 400 && BO.proposedBudget('PAUSE', 500, 0) === 500 && BO.proposedBudget('SCALE_UP', null, 20) === null);

  // ===================================================================================================================
  console.log('\n5. metrics SINCE a change (cumulative snapshots) — pure + DB fixture');
  const snap = (date, at, spend, p) => ({ date_start: date, snapshot_at: new Date(at), spend, meta_purchases: p });
  const rows = [snap('2026-10-05', '2026-10-05T23:50:00Z', 400, 4), snap('2026-10-06', '2026-10-06T06:00:00Z', 100, 1), snap('2026-10-06', '2026-10-06T12:00:00Z', 250, 3), snap('2026-10-06', '2026-10-06T19:50:00Z', 500, 5)];
  let sm = BO.sinceFromSnapshots(rows, new Date('2026-10-06T12:00:00Z'), NOW);
  ok('change at 12:00 (same day): since = day total 500 − the 12:00 baseline 250 = 250 spend, 2 orders, CPA 125', sm.spend === 250 && sm.purchases === 2 && sm.cpa === 125 && Math.round(sm.hours) === 8, JSON.stringify(sm));
  sm = BO.sinceFromSnapshots(rows, new Date('2026-10-05T10:00:00Z'), NOW);
  ok('change on the previous day (no baseline snapshot before it): both days count in full', sm.spend === 900 && sm.purchases === 9);
  const run = await retryDb(() => prisma.ambSyncRun.create({ data: { trigger: 'MANUAL', status: 'SUCCESS', ad_account_id: `${T}acc` } })); created.runs.push(run.id);
  const mk = (date, at, spend, p) => ({ sync_run_id: run.id, snapshot_at: new Date(at), ad_account_id: `${T}acc`, level: 'adset', date_start: date, date_stop: date, campaign_id: `${T}c1`, adset_id: `${T}as1`, spend, meta_purchases: p });
  await retryDb(() => prisma.metaPerformanceSnapshot.createMany({ data: [mk('2026-10-05', '2026-10-05T23:55:00Z', 300, 3), mk('2026-10-06', '2026-10-06T08:00:00Z', 120, 1), mk('2026-10-06', '2026-10-06T14:00:00Z', 330, 4), mk('2026-10-06', '2026-10-06T19:55:00Z', 520, 6)] }));
  sm = await BO.metricsSince({ level: 'adset', id: `${T}as1`, since: new Date('2026-10-06T14:00:00Z'), now: NOW, adAccountId: `${T}acc` });
  ok('DB: metrics since 14:00 = (520−330)=190 spend, 2 orders — from the real snapshot table', sm.spend === 190 && sm.purchases === 2 && Math.round(sm.cpa) === 95, JSON.stringify(sm));
  ok('DB: no snapshots for an unknown entity => null', (await BO.metricsSince({ level: 'adset', id: `${T}none`, since: NOW, now: NOW })) === null);

  // ===================================================================================================================
  console.log('\n6. orchestration through the REAL guard chain (injected world / contexts — no Meta, no writes)');
  const cfgBase = { mode: 'SHADOW', emergency_stop: false, writesLocked: true, limits: JSON.parse(JSON.stringify(S.DEFAULT_LIMITS)), cooldowns: { ...S.DEFAULT_COOLDOWNS }, schedule: { mode: 'ALWAYS' } };
  const settings = { ambMinSpendBeforeDecision: 150, ambMinPurchasesBeforeScaling: 5, ambMaxBudgetIncreasePct: 20, ambMaxAutoExecutionAmount: 500 };
  const mkCtx = (id, o = {}) => ({ storeId: 'trendy-storeee', adAccountId: `${T}acc`, metaConnected: true, metaStale: false, campaign: { id, name: id, status: 'ACTIVE', budget: null, firstSeenAt: new Date(NOW.getTime() - 200 * 3_600_000).toISOString() }, metrics: {}, product: { id: 7, ambProductId: 7, name: 'منتج', mappingVerified: true, mappingSource: 'EXPLICIT_MAPPING' }, econ: { complete: true, profitState: 'PROFITABLE', hardStopCpa: 200 }, stock: { status: 'SAFE', currentStock: 100, minimumStock: 10, daysRemaining: null }, dq: { gate: 'OK', overall: 'RECONCILED', statusTrust: { state: 'OK' } }, advisor: { scalePlanPresent: true, stage: 'SCALE', scaleBlockers: [] }, exceptions: [], recent: { lastByAction: {}, todayCount: 0 }, incidents: [], velocity: null, ruleConflicts: [], zeroOrder: null, ...o });
  const camp = (id, status, budget) => ({ id, name: id, status, budget, budgetType: budget ? 'DAILY' : null, firstSeenAt: new Date(NOW.getTime() - 200 * 3_600_000) });
  const camps = [camp(`${T}cbo`, 'ACTIVE', 500), camp(`${T}abo`, 'ACTIVE', null), camp(`${T}zero`, 'ACTIVE', null), camp(`${T}unk`, 'ACTIVE', null), camp(`${T}ext`, 'ACTIVE', 500), camp(`${T}pausedc`, 'PAUSED', 500)];
  const win = (o) => new Map(Object.entries(o));
  const world = { adAccountId: `${T}acc`, config: cfgBase, settings, connected: true, metaStale: false, campaigns: camps, windows: { last3: win({ [`${T}cbo`]: m(300, 5), [`${T}ext`]: m(300, 5), [`${T}pausedc`]: m(900, 0) }), last7: win({ [`${T}cbo`]: m(900, 12) }), last14: win({}), today: win({}) }, prodIndex: new Map(), tags: new Map(), exceptions: [], factsCache: new Map(), now: NOW };
  const structure = new Map([[`${T}cbo`, { campaign: { id: `${T}cbo`, status: 'ACTIVE', budget: 500, budgetType: 'DAILY' }, adsets: [] }], [`${T}abo`, { campaign: { id: `${T}abo`, status: 'ACTIVE', budget: null }, adsets: [{ id: `${T}as-abo`, name: 'AS', status: 'ACTIVE', budget: 200, budgetType: 'DAILY' }, { id: `${T}as-old`, status: 'PAUSED', budget: 200 }] }], [`${T}zero`, { campaign: { id: `${T}zero`, status: 'ACTIVE', budget: null }, adsets: [{ id: `${T}as-zero`, name: 'AZ', status: 'ACTIVE', budget: 200, budgetType: 'DAILY' }] }], [`${T}unk`, { campaign: { id: `${T}unk`, status: 'ACTIVE', budget: null }, adsets: [{ id: `${T}as-unk`, status: 'ACTIVE', budget: null }] }], [`${T}ext`, { campaign: { id: `${T}ext`, status: 'ACTIVE', budget: 500, budgetType: 'DAILY' }, adsets: [] }]]);
  const adsetWindows = { last3: win({ [`${T}as-abo`]: m(603, 3), [`${T}as-zero`]: m(260, 0) }), last7: win({ [`${T}as-abo`]: m(1200, 6), [`${T}as-zero`]: m(260, 0) }) };
  const ctxFor = async (c) => (c.id === `${T}ext` ? mkCtx(c.id, { exceptions: [{ id: 1, types: ['NO_AUTOMATION'] }], product: { id: 8, ambProductId: 8, name: 'منتج خارجي', mappingVerified: true } }) : mkCtx(c.id));
  const base = { world, structure, adsetWindows, lastChanges: new Map(), recent: new Map(), counters: { actionsLastHour: 0, actionsToday: 0, byAction: {} }, ctxFor, lastPurchaseAt: async () => null, velocity: async () => null };
  let res = await BO.evaluateBudgetOptimization({ now: NOW, deps: base });
  const by = (id) => res.rows.find((x) => x.campaignId === `${T}${id}`);
  ok('read-only: nothing persisted, SHADOW, 5 active + 1 paused counted', res.mode === 'SHADOW' && res.activeCampaigns === 5 && res.pausedCampaigns === 1 && (await prisma.ambOperatorDecision.count()) === counts0.decisions);
  ok('CBO campaign: CPA 60 with 5 orders => WOULD_INCREASE 500 → 600 at the CAMPAIGN level, via the full guard chain', by('cbo').budgetLevel === 'campaign' && by('cbo').decision === 'WOULD_INCREASE' && by('cbo').intended.fromBudget === 500 && by('cbo').intended.toBudget === 600 && by('cbo').entity.level === 'campaign', JSON.stringify(by('cbo')));
  ok('ABO campaign: the decision targets the ACTIVE AD SET (200 → 160) using the AD-SET metrics (CPA 201 over 3 orders = HIGH_CPA reduce first)', by('abo').budgetLevel === 'adset' && by('abo').entity.id === `${T}as-abo` && by('abo').zone === 'HIGH_CPA' && by('abo').decision === 'WOULD_REDUCE' && by('abo').intended.fromBudget === 200 && by('abo').intended.toBudget === 160 && by('abo').intended.action === 'SCALE_DOWN', JSON.stringify(by('abo')));
  ok('ABO zero orders (260 spend, 0 orders) => WOULD_PAUSE (no budget change involved)', by('zero').decision === 'WOULD_PAUSE' && by('zero').intended.action === 'PAUSE' && by('zero').intended.toBudget === null, JSON.stringify(by('zero')));
  ok('unknown budget level => BLOCKED (BUDGET_UNKNOWN), nothing guessed', by('unk').decision === 'BLOCKED' && by('unk').guards.includes('BUDGET_UNKNOWN'));
  ok('an exception (NO_AUTOMATION) turns the would-increase into PROTECTED with the guard shown', by('ext').decision === 'PROTECTED' && by('ext').guards.some((g) => g.startsWith('EXCEPTION_NO_AUTOMATION')) && by('ext').intended.action === 'SCALE_UP');
  ok('counts: 1 increase, 1 reduce, 1 pause, 1 protected, 1 blocked, 1 paused campaign not evaluated', res.counts.WOULD_INCREASE === 1 && res.counts.WOULD_REDUCE === 1 && res.counts.WOULD_PAUSE === 1 && res.counts.PROTECTED === 1 && res.counts.BLOCKED === 1 && res.counts.NO_ACTION_PAUSED === 1 && res.counts.HIGH_CPA_REDUCE === 1, JSON.stringify(res.counts));
  // guards stay
  const gv = async (o) => (await BO.evaluateBudgetOptimization({ now: NOW, deps: { ...base, ...o } })).rows.find((x) => x.campaignId === `${T}cbo`);
  let row = await gv({ ctxFor: async (c) => mkCtx(c.id, { stock: { status: 'STOCK_UNKNOWN' } }) });
  ok('Stock unknown => the scale is BLOCKED (STOCK_UNKNOWN)', row.decision === 'BLOCKED' && row.guards.some((g) => g.startsWith('STOCK_UNKNOWN')));
  row = await gv({ ctxFor: async (c) => mkCtx(c.id, { econ: { complete: false, profitState: 'UNKNOWN' } }) });
  ok('Economics incomplete => BLOCKED', row.decision === 'BLOCKED' && row.guards.some((g) => g.startsWith('ECONOMICS_INCOMPLETE')));
  row = await gv({ ctxFor: async (c) => mkCtx(c.id, { product: { id: 7, ambProductId: 7, name: 'x', mappingVerified: false, mappingSource: 'SUGGESTED' } }) });
  ok('Mapping not VERIFIED => BLOCKED', row.decision === 'BLOCKED' && row.guards.some((g) => g.startsWith('MAPPING_UNRELIABLE')));
  row = await gv({ ctxFor: async (c) => mkCtx(c.id, { dq: { gate: 'DECISION_BLOCKED_DATA_QUALITY' } }) });
  ok('Data quality blocked => BLOCKED', row.decision === 'BLOCKED' && row.guards.some((g) => g.startsWith('DATA_QUALITY_BLOCKED')));
  row = await gv({ ctxFor: async (c) => mkCtx(c.id, { recent: { lastByAction: {}, todayCount: 0, manualOverrideAt: new Date(NOW.getTime() - 3_600_000) } }) });
  ok('a manual change by the owner an hour ago => no automatic change (MANUAL_OVERRIDE_COOLDOWN)', ['PROTECTED', 'BLOCKED'].includes(row.decision) && row.guards.some((g) => g.startsWith('MANUAL_OVERRIDE_COOLDOWN')), JSON.stringify(row.guards));
  row = await gv({ ctxFor: async (c) => mkCtx(c.id, { advisor: null }) });
  ok('no Smart Advisor plan => scale BLOCKED (ADVISOR_PLAN_MISSING)', row.decision === 'BLOCKED' && row.guards.some((g) => g.startsWith('ADVISOR_PLAN_MISSING')));
  row = await gv({ ctxFor: async (c) => mkCtx(c.id, { advisor: { scalePlanPresent: false, stage: 'NEEDS_FIX', primaryProblem: 'CONVERSION_PROBLEM', scaleBlockers: [] } }) });
  ok('Advisor sees no scale plan => ADVISOR_DISAGREES is a DOWNGRADE (needs approval), NOT a block — the severity is untouched', row.decision === 'WOULD_INCREASE' && row.requiresApproval === true && row.guards.some((g) => g.startsWith('ADVISOR_DISAGREES[D]')));
  const resStop = await BO.evaluateBudgetOptimization({ now: NOW, deps: { ...base, world: { ...world, config: { ...cfgBase, emergency_stop: true } } } });
  ok('Emergency Stop => nothing is allowed (every intended action is blocked)', resStop.rows.filter((x) => x.intended).every((x) => ['BLOCKED', 'PROTECTED'].includes(x.decision)) && resStop.counts.WOULD_INCREASE + resStop.counts.WOULD_REDUCE + resStop.counts.WOULD_PAUSE === 0);
  const resMan = await BO.evaluateBudgetOptimization({ now: NOW, deps: { ...base, world: { ...world, config: { ...cfgBase, mode: 'OFF' } } } });
  ok('MANUAL (OFF) => every intended action carries MODE_OFF and none is allowed', resMan.rows.filter((x) => x.intended).every((x) => x.guards.some((g) => g.startsWith('MODE_OFF')) && ['BLOCKED', 'PROTECTED'].includes(x.decision)));
  row = await gv({ lastChanges: new Map([[`${T}cbo`, { at: new Date(NOW.getTime() - 5 * 3_600_000), action: 'SCALE_UP', from: 400, to: 500, source: 'AMB_ACTION' }]]), since: async () => ({ spend: 500, purchases: 8, cpa: 62 }) });
  ok('5h after a previous scale on the same campaign => PROTECTED by cooldown, no compounding', row.decision === 'PROTECTED' && row.zone === 'COOLDOWN' && row.intended === null);
  row = await gv({ lastChanges: new Map([[`${T}cbo`, { at: new Date(NOW.getTime() - 30 * 3_600_000), action: 'SCALE_UP', from: 400, to: 500, source: 'AMB_ACTION' }]]), since: async () => ({ spend: 280, purchases: 4, cpa: 70 }) });
  ok('30h later with NEW evidence (CPA 70, 4 orders): +20% again — 500 → 600 — decided from the since-change data', row.decision === 'WOULD_INCREASE' && row.evidence.window.kind === 'SINCE_LAST_CHANGE' && row.evidence.cpa === 70 && row.evidence.lastChange.from === 400 && row.intended.toBudget === 600, JSON.stringify(row));
  // gate for the scale sample: the policy's 2 (not the global 5) is used for THIS evaluation only
  const gset = await prisma.settings.findUnique({ where: { id: 'default' } });
  ok('the global sample setting (5) was not touched by the policy override', (JSON.parse(gset?.data || '{}').ambMinPurchasesBeforeScaling ?? 5) === 5);

  // ===================================================================================================================
  console.log('\n7. action history (SHADOW rows only; never executed from here)');
  res = await BO.evaluateBudgetOptimization({ now: NOW, deps: base, persist: true });
  ok('persist=true writes SHADOW/BLOCKED decision rows named DYNAMIC_BUDGET:* (the 4 rows with an intended action; the unknown-budget one has none)', res.persisted.created === 4 && (await prisma.ambOperatorDecision.count({ where: { rule_name: { startsWith: 'DYNAMIC_BUDGET:' }, campaign_id: { startsWith: T } } })) === 4, JSON.stringify(res.persisted));
  const hist = (await BO.budgetActionHistory({ limit: 50 })).filter((h) => String(h.campaignId).startsWith(T));
  const hCbo = hist.find((h) => h.campaignId === `${T}cbo`);
  ok('history record: before → after budget, level, CPA, purchases, spend, rule, evidence window, timestamp', hCbo.beforeBudget === 500 && hCbo.afterBudget === 600 && hCbo.level === 'campaign' && hCbo.cpa === 60 && hCbo.purchases === 5 && hCbo.spend === 300 && hCbo.rule === 'DYN_SCALE_UP' && hCbo.evidenceWindow.window === 'last3' && !!hCbo.timestamp && hCbo.status === 'SHADOW', JSON.stringify(hCbo));
  const hAbo = hist.find((h) => h.campaignId === `${T}abo`);
  ok('the ad-set decision is recorded at level adset with the ad set id', hAbo.level === 'adset' && hAbo.entityId === `${T}as-abo` && hAbo.beforeBudget === 200 && hAbo.afterBudget === 160 && hAbo.zone === 'HIGH_CPA');
  ok('blocked / protected rows keep their guards for the audit', hist.find((h) => h.campaignId === `${T}ext`).status === 'BLOCKED' && hist.find((h) => h.campaignId === `${T}ext`).blocked.some((b) => String(b).startsWith('EXCEPTION_NO_AUTOMATION')));
  res = await BO.evaluateBudgetOptimization({ now: NOW, deps: base, persist: true });
  ok('re-running in the same cooldown bucket is idempotent (updated, not duplicated)', res.persisted.created === 0 && res.persisted.updated === 4 && (await prisma.ambOperatorDecision.count({ where: { rule_name: { startsWith: 'DYNAMIC_BUDGET:' }, campaign_id: { startsWith: T } } })) === 4);
  const worldNow = { ...world, windows: { ...world.windows, last3: win({ [`${T}cbo`]: m(300, 3) }) } }; // cbo now CPA 100 (keep zone) => its old SCALE row is stale
  res = await BO.evaluateBudgetOptimization({ now: NOW, deps: { ...base, world: worldNow }, persist: true });
  ok('a row whose evidence changed (no longer qualifies) is EXPIRED by the optimizer itself', (await prisma.ambOperatorDecision.findFirst({ where: { campaign_id: `${T}cbo`, rule_name: { startsWith: 'DYNAMIC_BUDGET:' } } })).status === 'EXPIRED' && res.persisted.expired >= 1, JSON.stringify(res.persisted));
  const dec = await prisma.ambOperatorDecision.findFirst({ where: { campaign_id: `${T}abo` } });
  ok('nothing is ever executed from the optimizer (status never EXECUTING/EXECUTED, no executed_at)', !['EXECUTING', 'EXECUTED', 'VERIFIED'].includes(dec.status) && dec.executed_at === null);
  const engineSrc = fs.readFileSync(join(__dirname, '../services/amb/operatorEngine.js'), 'utf8');
  ok("the engine's own stale-expiry leaves DYNAMIC_BUDGET rows alone", /NOT: \{ rule_name: \{ startsWith: 'DYNAMIC_BUDGET:' \} \}/.test(engineSrc));
  const srcTxt = fs.readFileSync(join(__dirname, '../services/amb/budgetOptimizer.js'), 'utf8');
  const importLines = srcTxt.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l) || /await import\(/.test(l)).join(' | ');
  ok('the optimizer imports no executor and never calls setEntityBudget / graphPost (Meta writes impossible from here)', !/executor|launchPublish/.test(importLines) && !/setEntityBudget|graphPost|setEntityStatus/.test(srcTxt));

  // ===================================================================================================================
  console.log('\n8. routes: policy is ADMIN-only, validated, disabled by default');
  const app = express(); app.use(cookieParser()); app.use(express.json()); app.use('/api/operator', operatorRoutes); app.use(errorHandler);
  const server = await new Promise((rs) => { const s = app.listen(0, '127.0.0.1', () => rs(s)); });
  const base_ = `http://127.0.0.1:${server.address().port}/api/operator`;
  const call = async (method, path, body, token) => { const x = await fetch(base_ + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Cookie: `token=${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); let json = null; try { json = await x.json(); } catch { /* */ } return { status: x.status, json }; };
  const mkUser = async (role, tag) => { const u = await prisma.user.create({ data: { email: `${T}bo_${tag}_${Date.now()}@example.invalid`, password_hash: 'x'.repeat(20), name: `${T}${tag}`, role, status: 'ACTIVE', permissions: '{}' } }); created.users.push(u.id); return { user: u, token: jwt.sign({ id: u.id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' }) }; };
  const admin = await mkUser('ADMIN', 'admin'), mgr = await mkUser('MANAGER', 'mgr');
  let c = await call('GET', '/budget-optimizer/policy', undefined, mgr.token);
  ok('MANAGER reads the policy; it is DISABLED on a fresh system', c.status === 200 && c.json.policy.enabled === false && c.json.policy.scale.maxCpa === 80);
  c = await call('PUT', '/budget-optimizer/policy', { scale: { pct: 15 } }, mgr.token);
  ok('MANAGER cannot change it (403)', c.status === 403);
  c = await call('PUT', '/budget-optimizer/policy', { scale: { maxCpa: 170 } }, admin.token);
  ok('an invalid policy (scale line above the reduce zone) => 400, nothing saved', c.status === 400 && (await BO.getBudgetPolicy()).scale.maxCpa === 80);
  c = await call('PUT', '/budget-optimizer/policy', { scale: { pct: 15 } }, admin.token);
  ok('ADMIN edits a threshold (audited); other defaults stay; still disabled', c.status === 200 && c.json.policy.scale.pct === 15 && c.json.policy.scale.maxCpa === 80 && c.json.policy.enabled === false);
  c = await call('GET', '/budget-optimizer/history?limit=5', undefined, mgr.token);
  ok('history route is readable', c.status === 200 && Array.isArray(c.json.history));
  server.close();
  ok('safety: no Meta recommendation/action rows, mode and write-lock unchanged', (await prisma.ambRecommendation.count()) === counts0.recs && (await prisma.ambAction.count()) === counts0.actions && (await S.getOperatorConfig()).mode === origCfg.mode && S.metaWritesLocked() === true);
} catch (e) { fail++; console.log('  ✗ test crashed —', e.stack || e.message); }
finally {
  try {
    await retryDb(() => prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: origCfg.limitsConfigured ? JSON.stringify(origLimits) : null } }));
    await retryDb(() => prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ campaign_id: { startsWith: T } }, { actor_id: { in: created.users } }] } }));
    await retryDb(() => prisma.ambOperatorDecision.deleteMany({ where: { campaign_id: { startsWith: T } } }));
    await retryDb(() => prisma.metaPerformanceSnapshot.deleteMany({ where: { ad_account_id: `${T}acc` } }));
    await retryDb(() => prisma.ambSyncRun.deleteMany({ where: { id: { in: created.runs } } }));
    await retryDb(() => prisma.aiAuditLog.deleteMany({ where: { OR: [{ actor_id: { in: created.users } }, { kind: 'OPERATOR_BUDGET_POLICY', created_at: { gte: t0 } }] } }));
    await retryDb(() => prisma.user.deleteMany({ where: { id: { in: created.users } } }));
    const c2 = await S.getOperatorConfig();
    ok('cleanup: fixtures gone, policy restored to the original (disabled), decision count unchanged', JSON.stringify(c2.limits.dynamicBudget || null) === JSON.stringify(origLimits.dynamicBudget || null) && (await prisma.ambOperatorDecision.count()) === counts0.decisions && (await prisma.metaPerformanceSnapshot.count({ where: { ad_account_id: `${T}acc` } })) === 0);
  } catch (e) { fail++; console.log('  ✗ cleanup failed —', e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
