// 🧪 AI Operator on EVERY ad account (owner decision 2026-10-28: each account has its OWN limits and plans). Isolated test database only.
//   · daily-limit counters and stale-decision sweeps are evaluated for ONE account;
//   · every account has its own daily plan (plan key suffix) and a plan can only be acted on from its own account;
//   · the scheduler passes run per extra account inside that account's scope — and only when the owner switched the setting on;
//   · inside another account's scope "the sync" and its freshness are that account's, never the connected account's.
//   node src/scripts/operatorAccountsTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
process.env.DAILY_PLAN_ALLOW_TEST_CLOCK = '1'; process.env.DAILY_PLAN_DISABLE_ALERTS = '1';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const { prisma } = await imp('../prisma.js');
const MA = await imp('../services/metaAuth.js');
const OC = await imp('../services/amb/operatorContext.js');
const OA = await imp('../services/amb/operatorAccounts.js');
const SS = await imp('../services/amb/snapshotSync.js');
const settingsMod = await imp('../services/amb/settings.js');
const DP = (await import('./_confirmWrap.js')).withAutoConfirm(await imp('../services/amb/dailyPlans.js'));

const PRIMARY = 'act_1518142859790043', HADY = 'act_877011384919552', YASSER = 'act_1370863561334304';
const T = '__optest_oa_'; const DATE = '2031-06-10';
const FRESH = { syncStatus: async () => ({ lastSuccessAt: new Date() }), refresh: async () => ({ ok: true }) };
let seq = 0;
const item = (o = {}) => { const n = ++seq; return { campaignId: `${T}c${n}`, campaignName: `${T}camp ${n}`, productId: null, productName: 'fixture', storeId: 'trendy-storeee', rank: n, selected: true, selectable: true, eligibility: 'ELIGIBLE', blockCodes: [], warnings: [], risk: 'LOW', riskScore: 1, evidence: { budget: 100 }, ...o }; };
let conn = null, prevAcc = null, prevStatus = null; let settingsBackup;
const decision = (acct, n, action = 'PAUSE', status = 'EXECUTED') => prisma.ambOperatorDecision.create({ data: { decision_key: `${T}d${n}_${Date.now()}`, store_id: 'trendy-storeee', ad_account_id: acct, campaign_id: `${T}dc${n}`, campaign_name: 'fixture', action, rule_name: 'AUTO:ZERO_ORDER', mode_at_decision: 'AUTOPILOT', status, executed_at: new Date(), params_json: '{}' } });
try {
  conn = await prisma.metaConnection.findFirst(); prevAcc = conn.selected_ad_account_id; prevStatus = conn.status;
  await prisma.metaConnection.update({ where: { id: conn.id }, data: { selected_ad_account_id: PRIMARY, status: 'CONNECTED' } });
  settingsBackup = (await prisma.settings.findUnique({ where: { id: 'default' } }))?.data;

  console.log('\n1. Daily-limit counters are PER ACCOUNT');
  await decision(PRIMARY, 1); await decision(PRIMARY, 2); await decision(HADY, 3); await decision(HADY, 4, 'SCALE_UP'); await decision(YASSER, 5);
  const cP = await OC.loadCounters({ now: new Date(), campaigns: [] });
  const cH = await MA.accountScope.run({ adAccountId: HADY }, () => OC.loadCounters({ now: new Date(), campaigns: [] }));
  const cY = await MA.accountScope.run({ adAccountId: YASSER }, () => OC.loadCounters({ now: new Date(), campaigns: [] }));
  const mineP = (await prisma.ambOperatorDecision.count({ where: { ad_account_id: PRIMARY, status: 'EXECUTED', executed_at: { gte: new Date(Date.now() - 86_400_000) } } }));
  ok('the connected account counts only its own executed decisions', cP.actionsToday === mineP && (cP.byAction.PAUSE || 0) >= 2, JSON.stringify([cP.actionsToday, mineP]));
  ok("Hady's counters = exactly Hady's 2 actions (1 pause + 1 scale-up), none of Ahmed Samy's", cH.actionsToday === 2 && cH.byAction.PAUSE === 1 && cH.byAction.SCALE_UP === 1, JSON.stringify(cH.byAction));
  ok("Yasser's counters = its own single action", cY.actionsToday === 1 && cY.byAction.PAUSE === 1, JSON.stringify(cY.byAction));
  ok('an explicit adAccountId wins over the scope', (await OC.loadCounters({ now: new Date(), campaigns: [], adAccountId: YASSER })).actionsToday === 1);

  console.log('\n2. Each account has its OWN daily plan; a plan can only be acted on from its own account');
  const mk = (type, its) => DP.preparePlan({ type, date: DATE, simulated: true, deps: { ...FRESH, build: async () => ({ items: its, policy: null }) } });
  const pPrimary = (await mk('OPEN', [item()])).plan;
  const pHady = (await MA.accountScope.run({ adAccountId: HADY }, () => mk('OPEN', [item(), item()]))).plan;
  const pYasser = (await MA.accountScope.run({ adAccountId: YASSER }, () => mk('OPEN', [item()]))).plan;
  ok("the connected account's plan keeps its historical key", pPrimary.plan_key === `SIM|OPEN|${DATE}`, pPrimary.plan_key);
  ok("Hady's and Yasser's plans are separate plans with their own keys", pHady.plan_key === `SIM|OPEN|${DATE}|A-${HADY}` && pYasser.plan_key === `SIM|OPEN|${DATE}|A-${YASSER}` && new Set([pPrimary.id, pHady.id, pYasser.id]).size === 3, [pHady.plan_key, pYasser.plan_key].join(' / '));
  const again = (await MA.accountScope.run({ adAccountId: HADY }, () => mk('OPEN', [item()])));
  ok('preparing again for the same account/day is idempotent (same plan, not a new one)', again.created === false && again.plan.id === pHady.id);
  const ovP = await DP.getDailyOverview({ now: new Date(`${DATE}T12:00:00Z`), simulated: true });
  const ovH = await MA.accountScope.run({ adAccountId: HADY }, () => DP.getDailyOverview({ now: new Date(`${DATE}T12:00:00Z`), simulated: true }));
  ok("each overview shows ITS OWN plan (1 item for the connected account, 2 for Hady)", ovP.plans.OPEN?.id === pPrimary.id && ovH.plans.OPEN?.id === pHady.id && ovP.plans.OPEN.items.length === 1 && ovH.plans.OPEN.items.length === 2, JSON.stringify([ovP.plans.OPEN?.id, ovH.plans.OPEN?.id]));
  let err = null; try { await DP.cancelPlan({ planId: pHady.id, userId: null }); } catch (e) { err = e; }
  ok("cancelling Hady's plan from the connected account's scope is refused (409)", err && err.status === 409, err?.message);
  err = null; try { await MA.accountScope.run({ adAccountId: HADY }, () => DP.cancelPlan({ planId: pPrimary.id, userId: null })); } catch (e) { err = e; }
  ok("…and the connected account's plan cannot be cancelled from Hady's scope", err && err.status === 409);
  await MA.accountScope.run({ adAccountId: HADY }, () => DP.cancelPlan({ planId: pHady.id, userId: null }));
  ok("Hady's plan is cancelled from its own scope, the other two plans are untouched", (await prisma.ambDailyPlan.findUnique({ where: { id: pHady.id } })).status === 'CANCELLED' && (await prisma.ambDailyPlan.findUnique({ where: { id: pPrimary.id } })).status === 'PREPARED' && (await prisma.ambDailyPlan.findUnique({ where: { id: pYasser.id } })).status === 'PREPARED');

  console.log('\n3. Scheduler passes: only when switched on, once per OTHER account, inside that account\'s scope');
  const seen = [];
  ok('OFF by default: no extra accounts', (await OA.operatorExtraAccounts()).length === 0 && Object.keys(await OA.forEachOperatorAccount(async (id) => { seen.push(id); })).length === 0 && seen.length === 0);
  await settingsMod.saveAmbSettings({ ambOperatorAllAccounts: true });
  const extra = await OA.operatorExtraAccounts();
  ok('ON: Hady and Yasser (never the connected account)', extra.length === 2 && extra.includes(HADY) && extra.includes(YASSER) && !extra.includes(PRIMARY), extra.join(','));
  const scopes = {};
  const res = await OA.forEachOperatorAccount(async (id) => { scopes[id] = (await MA.getConnection()).selected_ad_account_id; if (id === YASSER) throw new Error('boom'); return { ran: true }; });
  ok('each pass runs inside its own account scope', scopes[HADY] === HADY && scopes[YASSER] === YASSER, JSON.stringify(scopes));
  ok("one account failing never stops the next, and the error is reported", res[YASSER]?.error === 'boom' && res[HADY]?.ran === true, JSON.stringify(res));
  ok('after the passes the connection is the connected account again', (await MA.getConnection()).selected_ad_account_id === PRIMARY);

  console.log("\n4. Inside another account's scope, \"the sync\" and its freshness are THAT account's");
  const old = await prisma.ambSyncRun.create({ data: { trigger: 'MANUAL', status: 'SUCCESS', ad_account_id: PRIMARY, started_at: new Date(Date.now() - 3 * 3600e3), finished_at: new Date(Date.now() - 3 * 3600e3) } });
  const hv = await prisma.ambSyncRun.create({ data: { trigger: 'VIEW', status: 'SUCCESS', ad_account_id: HADY, started_at: new Date(Date.now() - 120e3), finished_at: new Date(Date.now() - 120e3) } });
  const stP = await SS.getSyncStatus(); const stH = await MA.accountScope.run({ adAccountId: HADY }, () => SS.getSyncStatus());
  ok("getSyncStatus(): the connected account sees its own run (3h old), Hady's scope sees Hady's (2 min old)", Math.abs(new Date(stP.lastSuccessAt) - old.finished_at) < 2000 && Math.abs(new Date(stH.lastSuccessAt) - hv.finished_at) < 2000, JSON.stringify([stP.lastSuccessAt, stH.lastSuccessAt]));
  const sy = await MA.accountScope.run({ adAccountId: HADY }, () => SS.runSnapshotSync({ trigger: 'SCHEDULED' }));
  ok("runSnapshotSync() inside Hady's scope is Hady's read-only sync (fresh → skipped), never the connected account's full cycle", sy.ok === true && sy.skipped === 'FRESH', JSON.stringify(sy));
  await prisma.ambSyncRun.deleteMany({ where: { id: { in: [old.id, hv.id] } } });
  console.log("\n5. The Operator screens list ONE account's decisions");
  const RP = await imp('../services/amb/operatorReports.js');
  const mine = (arr) => arr.filter((d) => String(d.campaignId || d.campaign_id || '').startsWith(T));
  const lp = await RP.listDecisions({ bucket: 'history', limit: 500 }); const lh = await MA.accountScope.run({ adAccountId: HADY }, () => RP.listDecisions({ bucket: 'history', limit: 500 }));
  const ids = (r) => (r.items || r.decisions || r.rows || r).map?.((d) => d.campaignId || d.campaign_id) || [];
  const idsP = ids(lp).filter((x) => String(x).startsWith(T)), idsH = ids(lh).filter((x) => String(x).startsWith(T));
  ok('the connected account lists its own finished decisions (and not the other accounts)', idsP.includes(`${T}dc1`) && idsP.includes(`${T}dc2`) && !idsP.includes(`${T}dc3`) && !idsP.includes(`${T}dc5`), JSON.stringify(idsP));
  ok("Hady's scope lists only Hady's", idsH.includes(`${T}dc3`) && idsH.includes(`${T}dc4`) && !idsH.includes(`${T}dc1`) && !idsH.includes(`${T}dc5`), JSON.stringify(idsH));
  await prisma.metaConnection.update({ where: { id: conn.id }, data: { status: prevStatus } });
} finally {
  if (conn) await prisma.metaConnection.update({ where: { id: conn.id }, data: { selected_ad_account_id: prevAcc ?? null, status: prevStatus } }).catch(() => {});
  if (settingsBackup !== undefined) await prisma.settings.update({ where: { id: 'default' }, data: { data: settingsBackup } }).catch(() => {});
  await prisma.ambDailyPlan.deleteMany({ where: { plan_date: DATE } }).catch(() => {});
  await prisma.ambOperatorDecision.deleteMany({ where: { decision_key: { startsWith: T } } }).catch(() => {});
  await prisma.ambOperatorEvent.deleteMany({ where: { kind: { in: ['DAILY_PLAN', 'DAILY_PLAN_ITEM'] }, created_at: { gte: new Date(Date.now() - 3600e3) } } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
