// 🧪 ACTIVATION SHEET — the owner's one-screen decision sheet. Read-only by construction: confirmed values come from what is saved, the CPA mapping is only a PROPOSAL,
//   campaigns are ranked by 7-day orders then CPA, open candidates carry their live budget + guards, and every value still missing is listed (never defaulted).
//   node src/scripts/activationSheetTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };
const { prisma } = await imp('../prisma.js'); const AS = await imp('../services/amb/activationSheet.js'); const PP = await imp('../services/amb/productPolicy.js');

// ---- the saved values of the pilot product (as the owner confirmed them)
const v = (value, source = 'AMB') => ({ value, source });
const profile = { product: { id: 424, name: 'كاب الليزر' }, store: 'trendy-storeee', economics: { sellingPrice: v(3000), purchaseCost: v(900), shipping: v(50), packaging: v(50), other: v(1000), unitMargin: 1000, targetCpa: v(150), maxCpa: v(180), hardStopCpa: v(200, 'MANUAL'), minProfit: v(null, null), complete: true }, stock: { current: 2000, minimum: 600, source: 'MANUAL', known: true } };
const draft = { mode: 'APPROVAL', schedule: { openTime: null, closeTime: null, days: null }, cpa: { normalMin: null, normalMax: null, scale: null, reduce: null, hardStop: 200 }, zeroOrder: { spend: null, minAgeHours: null, windowDays: null }, budget: { increasePct: null, decreasePct: null, minPurchases: null, cooldownHours: null, minBudget: null, maxBudget: null, dailySpendCap: null }, manualOverrideHours: null, stockPolicy: null, campaigns: {} };
const policy = { key: 'trendy-storeee:424', productId: 424, active: null, draft, status: 'DRAFT', version: 1 };
const mk = (id, name, status, budget, m3, m7, m30) => ({ id, name, status, budget, m3, m7, m30 });
const C = [mk('c_a', 'Hair-Cap _ new _ scale 2', 'PAUSED', 500, [380, 3], [3311, 26], [9119, 75]), mk('c_b', 'Hair-Cap _ scale 4', 'PAUSED', 500, [200, 0], [767, 4], [8803, 55]), mk('c_c', 'Hair-Cap _ scale 7', 'PAUSED', 500, [0, 0], [956, 1], [2441, 10]), mk('c_d', 'Hair-Cap _ scale 1', 'PAUSED', null, [0, 0], [600, 4], [3114, 19]), mk('c_x', 'Other product', 'ACTIVE', 300, [100, 1], [700, 7], [1000, 10])];
const win = (i) => new Map(C.map((c) => [c.id, { spend: c[i][0], purchases: c[i][1] }]));
const world = { campaigns: C.map((c) => ({ id: c.id, name: c.name, status: c.status, budget: c.budget })), windows: { last3: win('m3'), last7: win('m7'), last30: win('m30'), today: new Map() } };
const identity = async (id) => (id === 'c_x' ? { productId: 999, verified: true } : id === 'c_d' ? { productId: 424, verified: false } : { productId: 424, verified: true });
const openCandidates = { items: [{ campaignId: 'c_a', campaignName: 'Hair-Cap _ new _ scale 2', eligibility: 'ELIGIBLE', blockCodes: [], warnings: ['STOCK_UNKNOWN', 'ECONOMICS_INCOMPLETE', 'DATA_STALE'], selected: true, risk: 'LOW', reason: 'CPA 127 داخل النطاق', evidence: { budget: 500 } }, { campaignId: 'c_b', campaignName: 'Hair-Cap _ scale 4', eligibility: 'BLOCKED', blockCodes: ['MANUAL_OVERRIDE_COOLDOWN'], warnings: [], selected: false, risk: 'MEDIUM', reason: 'x', evidence: { budget: 500 } }, { campaignId: 'c_x', campaignName: 'Other', eligibility: 'ELIGIBLE', blockCodes: [], selected: true, evidence: { budget: 300 } }] };
const reads = []; const structureOf = async (id) => { reads.push(id); return { level: 'CBO', campaignStatus: 'PAUSED', totals: { campaignBudget: 500 }, entities: [{ level: 'campaign', id, name: 'x', status: 'PAUSED', budget: 500 }] }; };
const cfg = { writesLocked: true, mode: 'APPROVAL', emergency_stop: false, execPermissions: { open: false, pause: false, budgetIncrease: false, budgetDecrease: false }, limits: { account: { maxEnablesPerDay: null, maxPausesPerDay: null, maxBudgetIncreasePerDay: null, maxDailySpendUnderAi: null }, manualOverrideCooldownHours: 24 } };
const pause = { enabled: false, version: 0, approved: null }; const open = { enabled: true, version: 1, approved: { version: 1 }, minCpa: 20, maxCpa: 150, window: '7', minPurchases: 5, maxTotalExposure: null, minStock: null, protectManualPause: { hours: 48 } };
const counts0 = { actions: await prisma.ambAction.count(), decisions: await prisma.ambOperatorDecision.count() }; const limits0 = (await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }))?.limits_json;

console.log('\n1. The CPA mapping is a proposal — nothing is applied');
{ const m = AS.proposeCpaMapping({ targetCpa: 150, maxCpa: 180, hardStopCpa: 200 });
  ok('Target 150 → proposed Scale, Maximum 180 → proposed Reduce, Hard Stop 200 → Hard Stop', m.rows.find((r) => r.field === 'scale').value === 150 && m.rows.find((r) => r.field === 'reduce').value === 180 && m.rows.find((r) => r.field === 'hardStop').value === 200);
  ok('status is PROPOSAL_REQUIRES_APPROVAL, applied=false, every row approved=false (the owner approves each line)', m.status === 'PROPOSAL_REQUIRES_APPROVAL' && m.applied === false && m.rows.every((r) => r.approved === false));
  ok('an inconsistent set is flagged (Target ≥ Maximum, Maximum ≥ Hard Stop)', AS.proposeCpaMapping({ targetCpa: 190, maxCpa: 180, hardStopCpa: 200 }).problems.length === 1 && AS.proposeCpaMapping({ targetCpa: 100, maxCpa: 210, hardStopCpa: 200 }).problems.length === 1);
  ok('a missing saved value is never invented: no Target → the Scale row has no value and proposed=false', AS.proposeCpaMapping({ maxCpa: 180 }).rows.find((r) => r.field === 'scale').proposed === false); }

console.log('\n2. The sheet for the pilot product');
const s = await AS.activationSheet({ productId: 424, storeId: 'trendy-storeee', now: new Date('2026-10-11T20:00:00Z'), deps: { profile, policy, world, identity, openCandidates, structureOf, config: cfg, pause, open } });
ok('confirmed values are exactly the saved ones (3000 / 900 / 50 / stock 2000 / min 600 / target 150 / max 180 / hard stop 200)', s.confirmed.sellingPrice.value === 3000 && s.confirmed.purchaseCost.value === 900 && s.confirmed.shipping.value === 50 && s.confirmed.stock.current === 2000 && s.confirmed.stock.minimum === 600 && s.confirmed.targetCpa.value === 150 && s.confirmed.maxCpa.value === 180 && s.confirmed.hardStopCpa.value === 200);
ok('the saved packaging (50) and other cost (1000) are shown too, so the 1000 unit margin is explained', s.confirmed.packaging.value === 50 && s.confirmed.other.value === 1000 && s.confirmed.unitMargin === 1000);
ok('the policy draft prefill contains ONLY the confirmed Hard Stop — Scale/Reduce stay empty until approved', s.policy.draftValuesFromConfirmedOnly.cpa.hardStop === 200 && s.policy.effective.cpa.scale == null && s.policy.effective.cpa.reduce == null);
ok('campaigns: only the product\'s VERIFIED mapped campaigns (the other product and the unverified mapping are excluded)', s.campaigns.count === 3 && !s.campaigns.rows.some((r) => r.id === 'c_x' || r.id === 'c_d'));
ok('campaigns are ranked by 7-day orders (26 → 4 → 1), with 3 / 7 / 30-day orders + CPA each', s.campaigns.rows.map((r) => r.id).join() === 'c_a,c_b,c_c' && s.campaigns.rows[0].d3.cpa === 127 && s.campaigns.rows[0].d7.cpa === 127 && s.campaigns.rows[0].d30.cpa === 122 && s.campaigns.rows[1].d3.cpa === null);
ok('product totals per window are the sum of its campaigns', s.campaigns.totals.d7.orders === 31 && s.campaigns.totals.d7.spend === 5034 && s.campaigns.totals.d30.orders === 140);
ok('open candidates are limited to the product\'s campaigns and keep their guards (MANUAL_OVERRIDE_COOLDOWN on scale 4)', s.openCandidates.length === 2 && s.openCandidates.find((o) => o.campaignId === 'c_b').blocks.includes('MANUAL_OVERRIDE_COOLDOWN') && !s.openCandidates.some((o) => o.campaignId === 'c_x'));
ok('a «stock unknown / economics incomplete» warning that contradicts the SAVED values is dropped; other warnings are kept', JSON.stringify(s.openCandidates.find((o) => o.campaignId === 'c_a').warnings) === JSON.stringify(['DATA_STALE']));
  ok('only ELIGIBLE/selected candidates get a LIVE Meta read (c_a); the blocked one is not read', reads.join() === 'c_a' && s.openCandidates.find((o) => o.campaignId === 'c_a').live.campaignBudget === 500 && s.openCandidates.find((o) => o.campaignId === 'c_b').live === null);
ok('exposure is explicit: one eligible candidate = 500/day, product cap, account cap and open-policy cap are all NOT SET (null)', s.exposure.openCandidatesWithBudget === 500 && s.exposure.productDailyCap === null && s.exposure.accountCap === null && s.exposure.openPolicyCap === null);
ok('global state: Meta writes locked, four permissions OFF, no emergency stop', s.global.writesLocked === true && s.global.allPermissionsOff === true && s.global.emergencyStop === false);

console.log('\n3. The missing decisions are explicit and nothing is defaulted');
const miss = s.missing.filter((m) => m.missing).map((m) => m.key);
ok('missing includes mode, scale, reduce, zero-order spend, % up/down, min orders, cooldown, min/max budget, daily cap, times, days, manual protection', ['mode', 'cpa.scale', 'cpa.reduce', 'zeroOrder.spend', 'budget.increasePct', 'budget.decreasePct', 'budget.minPurchases', 'budget.cooldownHours', 'budget.minBudget', 'budget.maxBudget', 'budget.dailySpendCap', 'schedule.openTime', 'schedule.closeTime', 'schedule.days', 'manualOverrideHours'].every((k) => miss.includes(k)), miss.join());
ok('Hard Stop, economics, stock minimum and mapping are NOT missing (they are saved)', !miss.includes('cpa.hardStop') && !miss.includes('economics') && !miss.includes('stock.minimum') && !miss.includes('mapping'));
ok('account caps, the pause-policy approval and the open-policy exposure cap are listed as missing', ['account.maxDailySpendUnderAi', 'account.maxEnablesPerDay', 'account.maxPausesPerDay', 'account.maxBudgetIncreasePerDay', 'pause.approved', 'open.maxTotalExposure'].every((k) => miss.includes(k)));
ok('verdict is NEEDS_CONFIGURATION while anything is missing', s.verdict === 'NEEDS_CONFIGURATION' && s.missingCount === miss.length);
{ const full = { ...draft, mode: 'AUTOMATIC', schedule: { openTime: '00:00', closeTime: '13:00', days: [0, 1] }, cpa: { ...draft.cpa, scale: 130, reduce: 170 }, zeroOrder: { spend: 150, minAgeHours: 6, windowDays: 3 }, budget: { increasePct: 20, decreasePct: 20, minPurchases: 3, cooldownHours: 24, minBudget: 200, maxBudget: 600, dailySpendCap: 1000 }, manualOverrideHours: 24 };
  const all = AS.missingDecisions({ eff: PP.mergeEffective(full), econ: profile.economics, stock: profile.stock, pause: { enabled: true, version: 1, approved: { version: 1 } }, open: { ...open, maxTotalExposure: 2000, minStock: 600 }, account: { maxDailySpendUnderAi: 3000, maxEnablesPerDay: 5, maxPausesPerDay: 5, maxBudgetIncreasePerDay: 600 }, mappedCampaigns: 3 });
  ok('with every value supplied nothing is missing (the checker is not stuck on «missing»)', all.every((m) => !m.missing), all.filter((m) => m.missing).map((m) => m.key).join()); }

console.log('\n4. Strictly read-only');
ok('no Meta action, no operator decision, no policy or limits change was written by building the sheet', (await prisma.ambAction.count()) === counts0.actions && (await prisma.ambOperatorDecision.count()) === counts0.decisions && (await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }))?.limits_json === limits0);
ok('the module contains no write call (no Prisma create/update/delete/upsert, no Meta POST)', !/prisma\.[a-zA-Z]+\.(create|update|delete|upsert)/.test((await import('node:fs')).readFileSync(join(__dirname, '../services/amb/activationSheet.js'), 'utf8')) && !/graphPost|\.post\(/.test((await import('node:fs')).readFileSync(join(__dirname, '../services/amb/activationSheet.js'), 'utf8')));
console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
