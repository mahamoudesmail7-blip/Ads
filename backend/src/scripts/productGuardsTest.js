// 🧪 Product guards + period/images backend: Daily Spend Cap per product (optimizer, bridge caps, OPEN plan), Manual Override protection (a policy can only EXTEND the global window), any-window campaign
// metrics (90 days / custom range) and product images. Isolated TEST database only; no Meta, no executor.
//   node src/scripts/productGuardsTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const { prisma } = await imp('../prisma.js');
const PP = await imp('../services/amb/productPolicy.js'); const BO = await imp('../services/amb/budgetOptimizer.js'); const S = await imp('../services/amb/operatorStore.js');
const G = await imp('../services/amb/operatorGuards.js'); const BC = await imp('../services/amb/budgetCaps.js'); const DC = await imp('../services/amb/dailyPlanCandidates.js'); const PM = await imp('../services/amb/periodMetrics.js');
const T = '__optest_'; const STORE = 'trendy-storeee', PID = 424; const key = PP.policyKey(STORE, PID);
const NOW = new Date('2026-10-07T20:00:00Z'); const m = (spend, purchases) => ({ spend, purchases, cpa: purchases > 0 ? spend / purchases : null });
const created = { runs: [], amb: [] };
try {
  console.log('\n1. Policy fields (Daily Spend Cap + manual-override hours): validation and effective values (pure)');
  const bad = (p) => PP.validatePolicy(PP.normalizePolicy(p)).length > 0;
  ok('daily spend cap must be positive; a campaign max budget above the product cap is refused', bad({ budget: { dailySpendCap: 0 } }) && bad({ budget: { dailySpendCap: 500, maxBudget: 800 } }) && !bad({ budget: { dailySpendCap: 1000, maxBudget: 600 } }));
  ok('manual-override hours: 1–720 only', bad({ manualOverrideHours: 0 }) && bad({ manualOverrideHours: 1000 }) && !bad({ manualOverrideHours: 72 }));
  const limits = { manualOverrideCooldownHours: 24, productPolicies: { [key]: { active: PP.normalizePolicy({ manualOverrideHours: 72, budget: { dailySpendCap: 900 }, campaigns: { cx: { manualOverrideHours: 12, budget: { dailySpendCap: 400 } } } }) } } };
  ok('effective manual-override hours = max(global 24, product 72) = 72; the campaign override 12 can NEVER shorten the global window (stays 24)', PP.effectiveManualOverrideHours(limits, STORE, PID) === 72 && PP.effectiveManualOverrideHours(limits, STORE, PID, 'cx') === 24 && PP.effectiveManualOverrideHours(limits, 'other', PID) === 24 && PP.effectiveManualOverrideHours({}, STORE, PID) === 24);
  ok('daily cap lookup: product 900, campaign override 400, other store/product none', PP.dailyCapFromLimits(limits, STORE, PID) === 900 && PP.dailyCapFromLimits(limits, STORE, PID, 'cx') === 400 && PP.dailyCapFromLimits(limits, 'other', PID) === null && PP.dailyCapFromLimits(limits, STORE, 999) === null);

  console.log('\n2. Manual Override protection in the REAL guard chain');
  const cfg = { mode: 'APPROVAL', emergency_stop: false, writesLocked: true, limits: JSON.parse(JSON.stringify(S.DEFAULT_LIMITS)), cooldowns: { ...S.DEFAULT_COOLDOWNS }, schedule: { mode: 'ALWAYS' } };
  const settings = { ambMinSpendBeforeDecision: 150, ambMinPurchasesBeforeScaling: 2, ambMaxBudgetIncreasePct: 50, ambMaxAutoExecutionAmount: 5000 };
  const ctx = (o = {}) => ({ storeId: STORE, adAccountId: `${T}acc`, metaConnected: true, metaStale: false, campaign: { id: `${T}c`, name: 'c', status: 'ACTIVE', budget: 500, firstSeenAt: new Date(NOW.getTime() - 300 * 3_600_000).toISOString() }, metrics: {}, product: { id: PID, ambProductId: 7, name: 'p', mappingVerified: true }, econ: { complete: true, profitState: 'PROFITABLE', hardStopCpa: 400 }, stock: { status: 'SAFE', currentStock: 100, minimumStock: 10 }, dq: { gate: 'OK', overall: 'RECONCILED', statusTrust: { state: 'OK' } }, advisor: { scalePlanPresent: true, stage: 'SCALE', scaleBlockers: [] }, exceptions: [], recent: { lastByAction: {}, todayCount: 0 }, incidents: [], velocity: null, ruleConflicts: [], zeroOrder: null, ...o });
  const ago = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  const codes = (c) => G.evaluateGuards({ decision: { action: 'SCALE_UP', needs: {}, ruleMode: 'AUTOPILOT' }, ctx: c, config: cfg, settings, counters: { actionsLastHour: 0, actionsToday: 0, byAction: {} }, now: NOW }).blocks.map((g) => g.code);
  ok('a manual change 30h ago: outside the global 24h window → no MANUAL_OVERRIDE_COOLDOWN', !codes(ctx({ recent: { lastByAction: {}, todayCount: 0, manualOverrideAt: ago(30) } })).includes('MANUAL_OVERRIDE_COOLDOWN'));
  ok('…the SAME change with a product protection of 72h → blocked', codes(ctx({ policyManualOverrideHours: 72, recent: { lastByAction: {}, todayCount: 0, manualOverrideAt: ago(30) } })).includes('MANUAL_OVERRIDE_COOLDOWN'));
  ok('a manual change 20h ago stays blocked even if a policy says 10h (a policy cannot shorten the global protection)', codes(ctx({ policyManualOverrideHours: 10, recent: { lastByAction: {}, todayCount: 0, manualOverrideAt: ago(20) } })).includes('MANUAL_OVERRIDE_COOLDOWN'));
  ok('a manual change 80h ago is outside even the 72h policy window → not blocked', !codes(ctx({ policyManualOverrideHours: 72, recent: { lastByAction: {}, todayCount: 0, manualOverrideAt: ago(80) } })).includes('MANUAL_OVERRIDE_COOLDOWN'));

  console.log('\n3. Daily Spend Cap — budget optimizer (two campaigns of one product: 500 + 400 = 900/day)');
  const camp = (id, budget) => ({ id, name: id, status: 'ACTIVE', budget, budgetType: 'DAILY', firstSeenAt: new Date(NOW.getTime() - 300 * 3_600_000) });
  const win = (o) => new Map(Object.entries(o));
  const world = { adAccountId: `${T}acc`, config: { ...cfg, mode: 'SHADOW' }, settings, connected: true, metaStale: false, campaigns: [camp(`${T}a`, 500), camp(`${T}b`, 400)], windows: { last3: win({ [`${T}a`]: m(300, 5), [`${T}b`]: m(600, 4) }), last7: win({ [`${T}a`]: m(900, 12), [`${T}b`]: m(900, 8) }), last14: win({}), today: win({}) }, prodIndex: new Map(), tags: new Map(), exceptions: [], factsCache: new Map(), now: NOW };
  const structure = new Map([[`${T}a`, { campaign: { id: `${T}a`, status: 'ACTIVE', budget: 500, budgetType: 'DAILY' }, adsets: [] }], [`${T}b`, { campaign: { id: `${T}b`, status: 'ACTIVE', budget: 400, budgetType: 'DAILY' }, adsets: [] }]]);
  const base = { world, structure, adsetWindows: { last3: win({}), last7: win({}) }, lastChanges: new Map(), recent: new Map(), counters: { actionsLastHour: 0, actionsToday: 0, byAction: {} }, ctxFor: async (c) => ctx({ campaign: { id: c.id, name: c.id, status: 'ACTIVE', budget: null, firstSeenAt: new Date(NOW.getTime() - 300 * 3_600_000).toISOString() } }), lastPurchaseAt: async () => null, velocity: async () => null, cairoToday: '2026-10-07', mappingStates: new Map() };
  const run = async (pol) => { const r = await BO.evaluateBudgetOptimization({ now: NOW, deps: { ...base, productPolicies: new Map(pol ? [[key, PP.normalizePolicy(pol)]] : []) } }); return (id) => r.rows.find((x) => x.campaignId === `${T}${id}`); };
  let by = await run(null);
  ok('baseline: campaign A (CPA 60, 5 orders) → WOULD_INCREASE 500 → 600', by('a').decision === 'WOULD_INCREASE' && by('a').intended.toBudget === 600, JSON.stringify([by('a').decision, by('a').guards]));
  by = await run({ budget: { dailySpendCap: 1000 } });
  ok('cap 1000: 900 + 100 = 1000 ≤ cap → the increase is allowed', by('a').decision === 'WOULD_INCREASE');
  by = await run({ budget: { dailySpendCap: 950 } });
  ok('cap 950: 900 + 100 = 1000 > cap → BLOCKED with PRODUCT_DAILY_CAP (never reaches the executor)', by('a').decision === 'BLOCKED' && by('a').guards.some((g) => g.startsWith('PRODUCT_DAILY_CAP')), JSON.stringify(by('a').guards));
  by = await run({ budget: { dailySpendCap: 950, increasePct: 5 } });
  ok('a smaller step fits the cap again (+5% = +25 → 925 ≤ 950)', by('a').decision === 'WOULD_INCREASE' && by('a').intended.toBudget === 525, JSON.stringify([by('a').decision, by('a').intended]));
  by = await run({ budget: { dailySpendCap: 700 } });
  ok('a cap BELOW today\'s total (700 < 900) blocks every increase; reductions/pauses are never blocked by a cap', by('a').decision === 'BLOCKED' && by('b').decision !== 'WOULD_INCREASE');

  console.log('\n4. Daily Spend Cap — bridge caps (prepare + execute use the same check)');
  const totals = { campaign: 500, product: 900, account: 2000 };
  let r = await BC.checkBudgetCaps({ action: 'SCALE_UP', delta: 150, adAccountId: 'a', campaignId: 'c', productId: PID, productCapOverride: 1000, deps: { caps: { campaign: null, product: null, account: null }, totals } });
  ok('product cap override 1000: +150 on a 900 product → violation (1050 > 1000), global caps untouched', !r.ok && r.violations.some((v) => v.level === 'product' && v.cap === 1000), JSON.stringify(r.violations));
  r = await BC.checkBudgetCaps({ action: 'SCALE_UP', delta: 90, adAccountId: 'a', campaignId: 'c', productId: PID, productCapOverride: 1000, deps: { caps: { campaign: null, product: null, account: null }, totals } });
  ok('+90 → 990 ≤ 1000 → allowed', r.ok);
  r = await BC.checkBudgetCaps({ action: 'SCALE_UP', delta: 150, adAccountId: 'a', campaignId: 'c', productId: PID, productCapOverride: 5000, deps: { caps: { campaign: null, product: 950, account: null }, totals } });
  ok('the policy cap REPLACES the global product cap for that product (5000 replaces 950 → allowed)', r.ok);
  r = await BC.checkBudgetCaps({ action: 'SCALE_DOWN', delta: -100, adAccountId: 'a', campaignId: 'c', productId: PID, productCapOverride: 100, deps: { caps: { campaign: null, product: null, account: null }, totals } });
  ok('a reduction can never violate a cap', r.ok);
  r = await BC.checkBudgetCaps({ action: 'SCALE_UP', delta: 150, adAccountId: 'a', campaignId: 'c', productId: PID, productCapOverride: null, deps: { caps: { campaign: null, product: 1000, account: null }, totals } });
  ok('no override → the global product cap applies as before', !r.ok);

  console.log('\n5. Daily Spend Cap — the OPEN plan (opening must not push the product above its cap)');
  const pcamp = (id, status) => ({ id, name: id, status, budget: null, budgetType: null, firstSeenAt: new Date(NOW.getTime() - 400 * 3_600_000) });
  const owld = { adAccountId: `${T}acc`, config: { ...cfg }, settings, connected: true, metaStale: false, campaigns: [pcamp(`${T}open1`, 'PAUSED'), pcamp(`${T}live1`, 'ACTIVE')], windows: { last3: win({}), last7: win({ [`${T}open1`]: m(900, 12) }), last14: win({}), last30: win({ [`${T}open1`]: m(2400, 32) }), today: win({}) }, prodIndex: new Map([[`${T}open1`, { ambProductId: 7, via: 'EXPLICIT_MAPPING' }], [`${T}live1`, { ambProductId: 7, via: 'EXPLICIT_MAPPING' }]]), tags: new Map(), exceptions: [], factsCache: new Map(), now: NOW };
  const ostruct = new Map([[`${T}open1`, { campaign: { id: `${T}open1`, status: 'PAUSED', budget: 400, budgetType: 'DAILY' }, adsets: [] }]]);
  const live = new Map([[`${T}live1`, { campaign: { id: `${T}live1`, status: 'ACTIVE', budget: 700, budgetType: 'DAILY' }, adsets: [] }]]);
  const buildOpen = async (cap) => { const o = await DC.buildOpenCandidates({ now: NOW, deps: { world: owld, mapStates: new Map([[`${T}open1`, { state: 'VERIFIED' }]]), recent: new Map(), origin: new Map(), lastActive: new Map([[`${T}open1`, '2026-10-05']]), structure: ostruct, activeStructure: live, syncStatus: async () => ({ lastSuccessAt: NOW }), ctxFor: async (c) => ctx({ campaign: { id: c.id, name: c.id, status: 'PAUSED', budget: null, firstSeenAt: new Date(NOW.getTime() - 400 * 3_600_000).toISOString() } }), productPolicies: new Map(cap == null ? [] : [[key, PP.normalizePolicy({ budget: { dailySpendCap: cap } })]]) } }); return o.items.find((i) => i.campaignId === `${T}open1`); };
  let it = await buildOpen(null);
  ok('no cap: the paused campaign is a normal, selectable candidate', it && it.selectable && !it.blockCodes.includes('PRODUCT_DAILY_CAP'), JSON.stringify(it?.blockCodes));
  it = await buildOpen(1200);
  ok('cap 1200: active 700 + opening 400 = 1100 ≤ 1200 → still allowed', it && !it.blockCodes.includes('PRODUCT_DAILY_CAP'));
  it = await buildOpen(1000);
  ok('cap 1000: 700 + 400 = 1100 > 1000 → BLOCKED (PRODUCT_DAILY_CAP) and not selectable', it && it.blockCodes.includes('PRODUCT_DAILY_CAP') && !it.selectable && it.eligibility === 'BLOCKED', JSON.stringify(it?.blockCodes));
  const ctxMan = (h) => async (c) => ctx({ policyManualOverrideHours: h, recent: { lastByAction: {}, todayCount: 0, manualOverrideAt: ago(30) }, campaign: { id: c.id, name: c.id, status: 'PAUSED', budget: null, firstSeenAt: new Date(NOW.getTime() - 400 * 3_600_000).toISOString() } });
  const openMan = async (h) => (await DC.buildOpenCandidates({ now: NOW, deps: { world: owld, mapStates: new Map([[`${T}open1`, { state: 'VERIFIED' }]]), recent: new Map(), origin: new Map(), lastActive: new Map([[`${T}open1`, '2026-10-05']]), structure: ostruct, activeStructure: live, syncStatus: async () => ({ lastSuccessAt: NOW }), ctxFor: ctxMan(h), productPolicies: new Map() } })).items.find((i) => i.campaignId === `${T}open1`);
  ok('OPEN plan + Manual Override: a manual change 30h ago is OK under the global 24h, blocked when the product protects 72h', !(await openMan(0)).blockCodes.includes('MANUAL_OVERRIDE_COOLDOWN') && (await openMan(72)).blockCodes.includes('MANUAL_OVERRIDE_COOLDOWN'));

  console.log('\n6. Metrics over ANY window (7 / 30 / 90 days / custom) — the last snapshot of each day wins');
  const run0 = await prisma.ambSyncRun.create({ data: { status: 'SUCCESS', ad_account_id: `${T}acc` } }); created.runs.push(run0.id);
  const snap = (cid, day, at, spend, p) => ({ sync_run_id: run0.id, snapshot_at: new Date(at), ad_account_id: `${T}acc`, level: 'campaign', date_start: day, date_stop: day, campaign_id: cid, spend, meta_purchases: p });
  await prisma.metaPerformanceSnapshot.createMany({ data: [snap(`${T}m1`, '2026-10-01', '2026-10-01T10:00:00Z', 100, 1), snap(`${T}m1`, '2026-10-01', '2026-10-01T22:00:00Z', 300, 3), snap(`${T}m1`, '2026-10-05', '2026-10-05T23:00:00Z', 500, 5), snap(`${T}m1`, '2026-08-01', '2026-08-01T23:00:00Z', 900, 3), snap(`${T}m2`, '2026-10-05', '2026-10-05T23:00:00Z', 200, 0)] });
  const wm = await PM.campaignWindowMetrics({ campaignIds: [`${T}m1`, `${T}m2`, `${T}none`], from: '2026-10-01', to: '2026-10-07' });
  ok('a day with two snapshots counts ONCE (the later one): 10-01 = 300/3 + 10-05 = 500/5 → 800 spend, 8 orders, CPA 100, 2 days', wm[`${T}m1`].spend === 800 && wm[`${T}m1`].purchases === 8 && wm[`${T}m1`].cpa === 100 && wm[`${T}m1`].days === 2, JSON.stringify(wm[`${T}m1`]));
  ok('spend with zero orders → CPA null (never a fake 0); an unknown campaign → zeros', wm[`${T}m2`].spend === 200 && wm[`${T}m2`].purchases === 0 && wm[`${T}m2`].cpa === null && wm[`${T}none`].spend === 0);
  const wm90 = await PM.campaignWindowMetrics({ campaignIds: [`${T}m1`], from: '2026-07-10', to: '2026-10-07' });
  ok('a 90-day window includes the old August row too (1700 spend, 11 orders); a narrow window excludes it', wm90[`${T}m1`].spend === 1700 && wm90[`${T}m1`].purchases === 11 && wm[`${T}m1`].spend === 800);
  ok('the window bounds are inclusive on both ends (10-05 only)', (await PM.campaignWindowMetrics({ campaignIds: [`${T}m1`], from: '2026-10-05', to: '2026-10-05' }))[`${T}m1`].spend === 500);
  const bw = (o) => { try { PM.parseWindow({ today: '2026-10-07', ...o }); return null; } catch (e) { return e.status; } };
  ok('window validation: bad dates, from > to, future, > 366 days, 0 / 400 days are all refused (400)', bw({ from: 'x', to: '2026-10-01' }) === 400 && bw({ from: '2026-10-05', to: '2026-10-01' }) === 400 && bw({ from: '2026-10-01', to: '2026-12-01' }) === 400 && bw({ from: '2025-01-01', to: '2026-10-01' }) === 400 && bw({ days: 0 }) === 400 && bw({ days: 400 }) === 400 && bw({ from: '2026-02-30', to: '2026-03-01' }) === 400);
  ok('a valid window is accepted: days=90 ends today and starts 89 days before; a custom range keeps its day count', PM.parseWindow({ today: '2026-10-07', days: 90 }).from === '2026-07-10' && PM.parseWindow({ today: '2026-10-07', from: '2026-10-01', to: '2026-10-07' }).days === 7);

  console.log('\n7. Product images (with fallback = no entry)');
  const ap = await prisma.ambProduct.create({ data: { product_id: null, product_name: `${T}img`, image_url: 'https://cdn.example.test/a.jpg' } }).catch(() => null);
  const real = await prisma.ambProduct.findFirst({ where: { product_id: 9001 } });
  if (real) { await prisma.ambProduct.update({ where: { id: real.id }, data: { image_url: 'https://cdn.example.test/p9001.jpg' } }); }
  const p2 = await prisma.ambProduct.findFirst({ where: { product_id: 9002 } }); if (p2) await prisma.ambProduct.update({ where: { id: p2.id }, data: { image_url: 'javascript:alert(1)' } });
  const imgs = await PM.productImages([9001, 9002, 424, 777777, 'x']);
  ok('a real https image is returned; an unsafe URL (javascript:) is dropped; a product without an image has no entry (the UI shows the initial)', imgs[9001] === 'https://cdn.example.test/p9001.jpg' && !(9002 in imgs) && !(777777 in imgs));
  if (ap) created.amb.push(ap.id);
  if (real) await prisma.ambProduct.update({ where: { id: real.id }, data: { image_url: null } }); if (p2) await prisma.ambProduct.update({ where: { id: p2.id }, data: { image_url: null } });
} catch (e) { fail++; console.log('  ✗ test crashed —', e.message, e.stack?.split('\n')[1] || ''); }
finally {
  await prisma.metaPerformanceSnapshot.deleteMany({ where: { ad_account_id: `${T}acc` } }); for (const id of created.runs) await prisma.ambSyncRun.deleteMany({ where: { id } }); for (const id of created.amb) await prisma.ambProduct.deleteMany({ where: { id } });
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
