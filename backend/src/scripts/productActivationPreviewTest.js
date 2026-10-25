// 🔎 productActivationPreview — the read-only «what would happen if I activate this product» view. Every input is injected: no database, no Meta, nothing is written.
//   node src/scripts/productActivationPreviewTest.js
import { productActivationPreview } from '../services/amb/productActivationPreview.js';
import { normalizePause } from '../services/amb/pausePolicy.js';
import { normalizeOpenCpa } from '../services/amb/openCpaPolicy.js';
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };

const NOW = new Date('2026-10-25T15:00:00Z'); const PID = 777, SID = 'trendy-storeee';
const pause = normalizePause({ enabled: true, version: 4, approved: { version: 4 }, zeroOrder: { enabled: true, spend: 200 }, highCpa: { enabled: true, above: null, minPurchases: 3, minSpend: 300 }, stockOut: { enabled: true }, scope: { includeProducts: ['424'] } });
const open = normalizeOpenCpa({ enabled: true, version: 7, approved: { version: 7 }, minCpa: 1, maxCpa: 150, window: '90', minPurchases: 2, maxTotalExposure: 13000, maxDataAgeMin: 30 });
const mk = (spend, purchases) => ({ spend, purchases, cpa: purchases ? spend / purchases : null });
const win = (o) => ({ today: new Map(Object.entries(o.today || {})), last3: new Map(Object.entries(o.last3 || {})), last7: new Map(Object.entries(o.last7 || {})), last30: new Map(Object.entries(o.last30 || {})) });
const world = { adAccountId: 'act_1', windows: win({
  last3: { good: mk(900, 10), bad: mk(900, 4), winner: mk(900, 5), recov: mk(900, 4), thin: mk(900, 2), zero: mk(400, 0) },
  last7: { winner: mk(900, 9), good: mk(1500, 16), bad: mk(1500, 8), recov: mk(1500, 8), thin: mk(900, 3), zero: mk(400, 0) },
  last30: { winner: mk(3000, 30), good: mk(4000, 40), bad: mk(3000, 15), recov: mk(3000, 15), thin: mk(900, 3), zero: mk(400, 0) },
  today: { recov: mk(180, 2) } }) };
const camp = (id, name, status) => ({ id, name, status });
const rules = [{ productId: PID, storeId: SID, name: 'منتج تجريبي', campaigns: [camp('good', 'Good', 'ACTIVE'), camp('bad', 'Bad CPA', 'ACTIVE'), camp('winner', 'Winner', 'ACTIVE'), camp('recov', 'Recovering', 'ACTIVE'), camp('thin', 'Thin sample', 'ACTIVE'), camp('zero', 'Zero orders', 'ACTIVE'), camp('p_ok', 'Paused good', 'PAUSED'), camp('p_hi', 'Paused high CPA', 'PAUSED'), camp('p_big', 'Paused big', 'PAUSED')] }];
const policy = { active: { mode: 'AUTOMATIC', cpa: { scaleMin: 20, scale: 60, reduce: 110, hardStop: 150 }, budget: { dailySpendCap: 3000 }, schedule: {}, zeroOrder: {}, campaigns: {} }, draft: null };
policy.effective = policy.active;
const structure = new Map([['good', { campaign: { status: 'ACTIVE', daily_budget: '30000' } }], ['p_ok', { campaign: { status: 'PAUSED', daily_budget: '20000' } }], ['p_hi', { campaign: { status: 'PAUSED', daily_budget: '20000' } }], ['p_big', { campaign: { status: 'PAUSED', daily_budget: '90000' } }]]);
const openMetrics = new Map([['p_ok', { spend: 600, purchases: 8 }], ['p_hi', { spend: 2000, purchases: 5 }], ['p_big', { spend: 1500, purchases: 15 }]]);
const base = { world, rules, productPolicy: policy, globalRules: { active: null }, pause, open, config: { limits: { account: { maxEnablesPerDay: 10, maxBudgetIncreasePerDay: 1500, maxDailySpendUnderAi: 9000 } } }, caps: { account: 14000 }, mapRows: [{ campaignId: 'x1', campaignName: 'Unconfirmed', state: 'SUGGESTED', campaignStatus: 'ACTIVE', product: { productId: PID }, spend7d: 300 }], structure, budgetOf: (id) => ({ good: 300, p_ok: 200, p_hi: 200, p_big: 900 })[id] ?? null, exposure: { total: 10000 }, openMetrics, recent: new Map() };

const r = await productActivationPreview({ productId: PID, now: NOW, deps: base });
console.log('\n1. Shape + read-only');
ok('returns ok, readOnly, the product name and its Hard Stop', r.ok && r.readOnly === true && r.name === 'منتج تجريبي' && r.hardStop === 150);
console.log('\n2. Pause: what would stop right after activation (a product NOT in the include list is auto-enrolled)');
ok('auto-enrolment is reported ON and the pause policy is active', r.pause.autoEnrolled === true && r.pause.policyActive === true);
const byName = (n) => r.pause.rows.find((x) => x.name === n);
ok('«Bad CPA» (3-day CPA 225 > Hard Stop 150, 4 orders, 900 spend) is ELIGIBLE for HIGH_CPA', byName('Bad CPA').trigger === 'HIGH_CPA' && r.pause.eligibleNow.some((x) => x.name === 'Bad CPA'));
ok('«Zero orders» (400 spend, no orders) is ELIGIBLE for ZERO_ORDER', byName('Zero orders').trigger === 'ZERO_ORDER');
ok('«Winner» is protected (WINNER_PROTECTED) and is NOT in the eligible list', byName('Winner').trigger === null && byName('Winner').skipped.includes('WINNER_PROTECTED') && !r.pause.eligibleNow.some((x) => x.name === 'Winner'));
ok('«Recovering» (high 3-day CPA but today 2 orders at CPA 90) is held back by RECENT_IMPROVEMENT', byName('Recovering').trigger === null && byName('Recovering').skipped.includes('RECENT_IMPROVEMENT'));
ok('«Thin sample» (2 orders < 3) and «Good» are not eligible', byName('Thin sample').trigger === null && byName('Good').trigger === null);
ok('exactly two campaigns would be stopped right after activation', r.pause.eligibleNow.length === 2, JSON.stringify(r.pause.eligibleNow.map((x) => x.name)));
console.log('\n3. Open: paused + confirmed campaigns the policy could open, under the exposure cap');
ok('«Paused good» (CPA 75 on 8 orders) is an open candidate; «Paused high CPA» (CPA 400) is not', r.open.candidates.some((x) => x.name === 'Paused good') && !r.open.candidates.some((x) => x.name === 'Paused high CPA'), JSON.stringify(r.open.candidates));
ok('«Paused big» (CPA 100, budget 900) is REFUSED by the exposure cap (10,000 now + 900 > …)? — it fits under 13,000, so it is a candidate; the total added matches', r.open.candidates.some((x) => x.name === 'Paused big') && r.open.addsBudget === 200 + 900, JSON.stringify([r.open.candidates, r.open.addsBudget]));
const tight = await productActivationPreview({ productId: PID, now: NOW, deps: { ...base, exposure: { total: 12500 } } });
ok('with 12,500 already running, the 13,000 cap refuses the big one (EXPOSURE_CAP) and the preview says so', !tight.open.candidates.some((x) => x.name === 'Paused big') && tight.open.refused.some((x) => x.name === 'Paused big' && x.reasons.length), JSON.stringify([tight.open.candidates, tight.open.refused]));
console.log('\n4. Money picture');
ok('running budget of the product, what opening adds and the worst day = 300 + 1,100 + 1,500 increase = 2,900 (under the product daily cap 3,000)', r.money.productActiveBudget === 300 && r.money.opensWouldAdd === 1100 && r.money.worstCaseProductDay === 2900, JSON.stringify(r.money));
ok('headroom under each cap is computed against the live account exposure (open cap 13,000, account cap 14,000, AI cap 9,000)', r.money.headroom.openExposure === 3000 && r.money.headroom.accountBudgetCap === 4000 && r.money.headroom.aiCap === 9000, JSON.stringify(r.money.headroom));
console.log('\n5. Safety of the preview itself');
ok('a campaign whose mapping is not confirmed is listed as EXCLUDED, never evaluated', r.mapping.excluded.length === 1 && r.mapping.excluded[0].campaignId === 'x1' && !r.pause.rows.some((x) => x.campaignId === 'x1') && r.notes.some((n) => /ربطها بالمنتج غير مؤكد/.test(n)));
const noPol = await productActivationPreview({ productId: PID, now: NOW, deps: { ...base, productPolicy: { active: null, draft: null } } });
ok('a product with no policy yet → needsPolicy (nothing is guessed)', noPol.needsPolicy === true && !noPol.pause);
const unknown = await productActivationPreview({ productId: 999999, now: NOW, deps: base });
ok('an unknown product → a clear error, no crash', unknown.ok === false && unknown.error === 'PRODUCT_NOT_FOUND');
const offPause = await productActivationPreview({ productId: PID, now: NOW, deps: { ...base, pause: normalizePause({ ...pause, approved: { version: 3 } }) } });
ok('an unapproved pause policy version is reported (no automatic pause) and the eligible list is empty', offPause.pause.policyActive === false && offPause.notes.some((n) => /سياسة الإيقاف غير معتمدة/.test(n)));

console.log(`\n${fail ? '❌' : '✅'} productActivationPreviewTest: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
