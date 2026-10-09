// 🧪 Per-product scheduling: products with DIFFERENT opening / closing times get their own slot plans (P-HHMM) at their own Cairo time, once, only with their own campaigns — restart-safe, popup-visible,
// approvable and executable (SHADOW simulation, Meta mock = injected read/exec stubs), with a Meta rate-limit stop. Isolated TEST database only; virtual dates in 2031 so nothing real is touched.
//   node src/scripts/productSchedulingTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const { prisma } = await imp('../prisma.js');
const TM = await imp('../services/amb/dailyPlanTime.js'); const DP = await imp('../services/amb/dailyPlans.js'); const PP = await imp('../services/amb/productPolicy.js');
const T = '__optest_'; const DATE = '2031-06-10'; const rawBefore = (await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }))?.limits_json ?? null;
const at = (hhmm) => TM.dueAtTime(DATE, hhmm); const plus = (d, min) => new Date(d.getTime() + min * 60_000);
const KA = PP.policyKey('trendy-storeee', 9001), KB = PP.policyKey('trendy-storeee', 9002);
const FRESH = { syncStatus: async () => ({ lastSuccessAt: new Date() }), refresh: async () => ({ ok: true }) };
const ADMIN = { id: 1, role: 'ADMIN', status: 'ACTIVE' }; const cfgOf = (o = {}) => ({ mode: 'SHADOW', emergency_stop: false, writesLocked: true, limits: { recentPurchaseProtectionHours: 3 }, ...o });
const dcfg0 = await DP.getDailyPlanConfig(); const DC_ON = { ...dcfg0, allowOpen: true, allowPause: true, halted: false, scheduledExecution: { enabled: false } };
const rules = async () => [{ key: KA, campaigns: [{ id: `${T}a1` }, { id: `${T}a2` }] }, { key: KB, campaigns: [{ id: `${T}b1` }] }];
const mkItems = (ids) => ids.map((id, n) => ({ campaignId: id, campaignName: `${T}${id}`, productId: null, productName: 'fixture', storeId: 'trendy-storeee', rank: n + 1, selected: true, selectable: true, eligibility: 'ELIGIBLE', blockCodes: [], warnings: [], risk: 'LOW', riskScore: 10, rankScore: 10, reason: 'fixture', evidence: { budget: 200, m7: { spend: 700, purchases: 8, cpa: 88 }, m30: { spend: 2000, purchases: 24, cpa: 83 } } }));
const ALL_IDS = [`${T}a1`, `${T}a2`, `${T}b1`, `${T}c1`];
const deps = { ...FRESH, listProductRules: rules, build: async () => ({ items: mkItems(ALL_IDS), policy: null }) };
const tick = (now) => DP.ensureProductSlotPlans({ now, simulated: true, deps });
const planOf = (type, hhmm) => prisma.ambDailyPlan.findFirst({ where: { plan_key: TM.planKey(type, DATE, true, TM.slotVariant(hhmm)) }, include: { items: { orderBy: { rank: 'asc' } } } });
const cleanup = async () => { await prisma.ambDailyPlan.deleteMany({ where: { plan_date: DATE } }); await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: rawBefore } }); await prisma.ambOperatorEvent.deleteMany({ where: { note: { contains: 'trendy-storeee:900' } } }); await prisma.aiAuditLog.deleteMany({ where: { input_json: { contains: 'trendy-storeee:900' }, kind: { startsWith: 'OPERATOR_PRODUCT_POLICY' } } }); await prisma.aiAuditLog.deleteMany({ where: { input_json: { contains: `${T}` } } }); };
try {
  console.log('\n1. Policies: A opens 03:00 and closes 15:30, B opens 06:30, C (no policy) uses the standard 00:00 / 13:00');
  await PP.saveDraft({ productId: 9001, storeId: 'trendy-storeee', policy: { schedule: { openTime: '03:00', closeTime: '15:30', days: [0, 1, 2, 3, 4, 5, 6] } }, userId: 1 });
  await PP.saveDraft({ productId: 9002, storeId: 'trendy-storeee', policy: { schedule: { openTime: '06:30' } }, userId: 1 });
  ok('drafts alone create nothing (save ≠ activate)', (await tick(plus(at('03:00'), 5))).length === 0);
  await PP.activatePolicy({ productId: 9001, storeId: 'trendy-storeee', confirm: true, userId: 1 }); await PP.activatePolicy({ productId: 9002, storeId: 'trendy-storeee', confirm: true, userId: 1 });

  console.log('\n2. Each product slot is prepared at ITS OWN time, once, with ONLY its campaigns');
  ok('02:30 Cairo: nothing is due yet', (await tick(plus(at('03:00'), -30))).length === 0);
  const m1 = await tick(plus(at('03:00'), 5));
  ok('03:05: ONE plan is made — OPEN P-0300 for product A only', m1.length === 1 && m1[0].type === 'OPEN' && m1[0].time === '03:00' && m1[0].campaigns === 2, JSON.stringify(m1));
  const pA = await planOf('OPEN', '03:00');
  ok('its due instant is 03:00 Cairo (= 00:00Z in summer), it holds exactly A\'s two campaigns, expires at Cairo midnight, and is a PREPARED virtual plan', pA && pA.scheduled_at.toISOString() === '2031-06-10T00:00:00.000Z' && pA.items.map((i) => i.campaign_id).join() === `${T}a1,${T}a2` && pA.status === 'PREPARED' && pA.simulated === true && pA.expires_at.toISOString() === '2031-06-10T21:00:00.000Z', JSON.stringify([pA?.scheduled_at, pA?.items?.map((i) => i.campaign_id)]));
  const m2 = await tick(plus(at('06:30'), 10));
  const pB = await planOf('OPEN', '06:30');
  ok('06:40: product B gets its own OPEN P-0630 plan (only B\'s campaign); A\'s plan is not duplicated', m2.length === 1 && m2[0].time === '06:30' && pB.items.map((i) => i.campaign_id).join() === `${T}b1` && (await prisma.ambDailyPlan.count({ where: { plan_key: TM.planKey('OPEN', DATE, true, 'P-0300') } })) === 1);
  ok('product C (no policy) never gets a slot plan — it stays in the standard 00:00 / 13:00 plans', !(await prisma.ambDailyPlanItem.count({ where: { campaign_id: `${T}c1`, plan: { plan_date: DATE } } })));
  ok('15:00: the close time of A (15:30) is not due yet; 15:31 → a PAUSE P-1530 plan for A only', (await tick(plus(at('15:30'), -30))).length === 0 && (await tick(plus(at('15:30'), 1))).some((x) => x.type === 'PAUSE' && x.time === '15:30') && (await planOf('PAUSE', '15:30')).items.map((i) => i.campaign_id).join() === `${T}a1,${T}a2`);

  console.log('\n3. Restart recovery — the scheduler keeps no memory: a restarted server neither duplicates nor loses a slot');
  const again = await tick(plus(at('15:30'), 300)); // "after a restart" (fresh call, later in the day)
  ok('a later tick after a restart creates nothing new (3 slot plans, all unique)', again.length === 0 && (await prisma.ambDailyPlan.count({ where: { plan_date: DATE, plan_key: { contains: '|P-' } } })) === 3);
  const racers = await Promise.all([0, 1, 2].map(() => tick(plus(at('03:00'), 400))));
  ok('three concurrent ticks (two server instances) still leave exactly ONE plan per slot', (await prisma.ambDailyPlan.count({ where: { plan_date: DATE, plan_key: { contains: '|P-' } } })) === 3 && racers.flat().length === 0);
  await prisma.ambDailyPlan.deleteMany({ where: { plan_key: TM.planKey('OPEN', DATE, true, 'P-0630') } });
  const recovered = await tick(plus(at('15:30'), 120));
  ok('a slot plan that was missing (server was down at 06:30) is created as soon as a tick runs later the same Cairo day', recovered.length === 1 && recovered[0].time === '06:30');

  console.log('\n4. Visibility — overview, popup, and the standard plans stay independent');
  const ov = await DP.getDailyOverview({ now: plus(at('15:30'), 30), simulated: true });
  ok('the overview lists the product slot plans next to the standard ones (3 of them)', ov.oneOffPlans.filter((p) => p.key.includes('|P-')).length === 3, JSON.stringify(ov.oneOffPlans.map((p) => p.key)));
  const pop = await DP.getDuePopups({ now: plus(at('03:00'), 10), simulated: true });
  ok('the popup list at 03:10 contains A\'s 03:00 plan but not B\'s 06:30 plan (not due) — closing a popup is never an approval', pop.some((p) => p.productSlot && p.plan.key.includes('P-0300')) && !pop.some((p) => p.productSlot && p.plan.key.includes('P-0630')));

  console.log('\n5. Approve + execute a slot plan (SHADOW simulation) and the Meta rate-limit stop (mock read / exec)');
  const planA = await planOf('OPEN', '03:00'); const readCalls = []; const execCalls = [];
  const D0 = { ...FRESH, user: ADMIN, runInline: true, exceptions: async () => [], lastPurchase: async () => null, mappingState: async () => null, readEntity: async (id) => { readCalls.push(id); return { id, status: 'PAUSED', budget: 200 }; }, sleep: async () => {} };
  const ap = await DP.approvePlan({ planId: planA.id, userId: 1, now: plus(at('03:00'), 6), deps: { ...D0, dcfg: DC_ON, config: async () => cfgOf() } });
  const after = await prisma.ambDailyPlanItem.findMany({ where: { plan_id: planA.id }, orderBy: { rank: 'asc' } });
  ok('approval in SHADOW → a SIMULATION: both items SIMULATED after a live read each, no executor call, no Meta write', ap.ok && ap.executionMode === 'SIMULATION' && after.every((i) => i.status === 'SIMULATED') && readCalls.length === 2 && execCalls.length === 0, JSON.stringify([ap.ok, ap.executionMode, after.map((i) => i.status), readCalls.length]));
  ok('approving a plan never touched the global mode / emergency / permissions', (await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } })).emergency_stop === false);
  const planB = await planOf('OPEN', '06:30') || (await tick(plus(at('15:30'), 150)), await planOf('OPEN', '06:30'));
  const rateExec = async () => { const e = new Error('(#17) User request limit reached'); e.isMetaRateLimit = true; execCalls.push(1); throw e; };
  const live = await DP.approvePlan({ planId: planB.id, userId: 1, now: plus(at('06:30'), 6), deps: { ...D0, dcfg: DC_ON, config: async () => cfgOf({ mode: 'APPROVAL', writesLocked: false, execPermissions: { open: true, pause: true } }), approveAndExecute: rateExec, readBack: async () => ({ status: 'PAUSED' }) } });
  const st = (await prisma.ambDailyPlanItem.findMany({ where: { plan_id: planB.id } })).map((i) => i.status);
  ok('LIVE gate with a Meta rate-limit (#17) during the first write: the item is not marked verified, the run stops (nothing is blindly re-sent)', st.every((s) => s !== 'VERIFIED') && execCalls.length <= 1, JSON.stringify([live.ok, st, execCalls.length]));
} catch (e) { fail++; console.log('  ✗ test crashed —', e.message, e.stack?.split('\n')[1] || ''); }
finally { await cleanup(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
