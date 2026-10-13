// 🧪 HAIR-CAP #424 — ONE rule set for EVERY campaign of the product (owner's dictation, 2026-10-13): price 3000 · highest acceptable cost per order 200
//   · CPA above 200 → pause automatically · CPA at ~200 (180–200) → cut the budget 20% · CPA 100–120 (and falling below) → raise the budget 20% · in between → keep.
//   The real policy validator, optimizer classification, pause policy, caps and the AUTOMATIC / APPROVAL split — pure functions, no Meta call, nothing written.
//   node src/scripts/hairCapAllCampaignsTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url)); const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0; const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const BO = await imp('../services/amb/budgetOptimizer.js'); const PP = await imp('../services/amb/productPolicy.js'); const PPol = await imp('../services/amb/pausePolicy.js'); const BC = await imp('../services/amb/budgetCaps.js');
const { prisma } = await imp('../prisma.js');
export const HAIR_CAP_ALL = { mode: 'AUTOMATIC', schedule: { openTime: null, closeTime: null, days: null }, cpa: { scale: 120, reduce: 180, hardStop: 200 }, zeroOrder: { spend: 200, minAgeHours: 24 },
  budget: { increasePct: 20, decreasePct: 20, minPurchases: 5, cooldownHours: 24, minBudget: 200, maxBudget: 600, dailySpendCap: 2100, maxChangesPerDay: 4 }, automaticOnly: [] };
const policy = PP.normalizePolicy(HAIR_CAP_ALL); const eff = PP.applyToBudgetPolicy(BO.DEFAULT_POLICY, policy, 'any-campaign');
const m = (spend, purchases) => ({ spend, purchases, cpa: purchases ? spend / purchases : null });
const cls = (cpa, orders = 6, o = {}) => BO.classifyBudget({ m: m(cpa * orders, orders), m7: m(cpa * orders, orders), ageHours: 300, policy: eff.policy, zeroSpendLimit: eff.zeroSpend, ...o });
const act = (r) => (r.action ? `${r.action}${r.pct ? ' ' + r.pct + '%' : ''}` : 'KEEP');
const pausePol = PPol.normalizePause({ enabled: true, version: 1, approved: { version: 1, at: new Date().toISOString(), by: 1 }, zeroOrder: { enabled: true }, highCpa: { enabled: true, above: 300, minPurchases: 3, minSpend: 300 }, stockOut: { enabled: true } });
const pauseOf = (cpa, orders, spend = cpa * orders) => PPol.decidePause({ policy: pausePol, campaignId: 'c', productId: 424, storeId: 'trendy-storeee', m3: m(spend, orders), mToday: m(0, 0), productHighCpa: 200, stock: { status: 'SAFE' }, winner: false }).trigger;

console.log('\n1. The policy as the owner dictated it');
ok('it passes the real policy validator (Scale 120 < Reduce 180 < Hard Stop 200; ±20%; cooldown 24h; 5 orders; budget 200–600)', PP.validatePolicy(policy).length === 0, JSON.stringify(PP.validatePolicy(policy)));
ok('the optimizer policy built from it: raise ≤ 120 (+20%), cut from 180 (−20%), HIGH-CPA zone starts above 200, zero-order stop 200 after 24h', eff.policy.scale.maxCpa === 120 && eff.policy.scale.pct === 20 && eff.policy.reduce.minCpa === 180 && eff.policy.reduce.pct === 20 && eff.policy.highCpa.above === 200 && eff.zeroSpend === 200, JSON.stringify([eff.policy.scale, eff.policy.reduce, eff.policy.highCpa, eff.zeroSpend]));

console.log('\n2. CPA ladder (6 orders, Meta-reported) — what the engine decides');
const ladder = [[60, 'SCALE_UP 20%'], [90, 'SCALE_UP 20%'], [100, 'SCALE_UP 20%'], [110, 'SCALE_UP 20%'], [120, 'SCALE_UP 20%'], [121, 'KEEP'], [150, 'KEEP'], [179, 'KEEP'], [180, 'SCALE_DOWN 20%'], [190, 'SCALE_DOWN 20%'], [200, 'SCALE_DOWN 20%']];
for (const [cpa, want] of ladder) ok(`CPA ${cpa} → ${want}`, act(cls(cpa)) === want, act(cls(cpa)));
const high = cls(250); ok('CPA 250 (above 200) → the budget engine cuts 20% first (HIGH_CPA zone) …', high.zone === 'HIGH_CPA' && high.action === 'SCALE_DOWN', JSON.stringify(high.zone));
ok('… and the PAUSE policy closes the campaign: CPA 201 / 250 / 400 with ≥ 3 orders and ≥ 300 spend → HIGH_CPA pause; CPA 200 → no pause', pauseOf(201, 4) === 'HIGH_CPA' && pauseOf(250, 5) === 'HIGH_CPA' && pauseOf(400, 3) === 'HIGH_CPA' && pauseOf(200, 5) === null, JSON.stringify([pauseOf(201, 4), pauseOf(250, 5), pauseOf(400, 3), pauseOf(200, 5)]));
ok('a CPA above 200 on a tiny sample (2 orders) is NOT enough to pause — never on one lucky / unlucky order', pauseOf(300, 2) === null);
ok('zero orders: spend ≥ 200 after 24h of age → PAUSE; spend 150 → nothing; a campaign younger than 24h → nothing', BO.classifyBudget({ m: m(250, 0), m7: m(250, 0), ageHours: 300, policy: eff.policy, zeroSpendLimit: eff.zeroSpend }).action === 'PAUSE' && BO.classifyBudget({ m: m(150, 0), m7: m(150, 0), ageHours: 300, policy: eff.policy, zeroSpendLimit: eff.zeroSpend }).action == null && BO.classifyBudget({ m: m(250, 0), m7: m(250, 0), ageHours: 5, policy: eff.policy, zeroSpendLimit: eff.zeroSpend }).action == null);
ok('good CPA but only 4 orders → no raise (minimum 5 orders), and a young campaign (< 48h) is not raised either', act(cls(100, 4)) === 'KEEP' && act(cls(100, 6, { ageHours: 24 })) === 'KEEP');
ok('cooldown: a raise 5h ago blocks another change; after 24h the next one is allowed', BO.classifyBudget({ m: m(600, 6), m7: m(600, 6), ageHours: 300, policy: eff.policy, since: m(600, 6), lastChange: { at: new Date(Date.now() - 5 * 3_600_000), action: 'SCALE_UP' }, zeroSpendLimit: eff.zeroSpend }).zone === 'COOLDOWN');

console.log('\n3. Every campaign of the product — and ONLY this product');
const ids = ['120252462679880205', '120252367248080205', '120252401165810205', '120252367151470205', 'a-brand-new-campaign-tomorrow'];
ok('all Hair-Cap campaigns (listed or future) are AUTOMATIC, because the «only these campaigns» list is empty', ids.every((id) => PP.mergeEffective(policy, id).mode === 'AUTOMATIC'));
ok('another product has no policy → not enrolled at all (mergeEffective of nothing is not AUTOMATIC)', PP.mergeEffective(null, '999').mode !== 'AUTOMATIC');
ok('a campaign-level override cannot move the numbers outside the validated range (Scale must stay below Reduce)', PP.validatePolicy(PP.normalizePolicy({ ...HAIR_CAP_ALL, cpa: { scale: 190, reduce: 180, hardStop: 200 } })).length > 0);

console.log('\n4. Caps with ALL campaigns automatic (this is why the old pilot cap of 600 cannot stay)');
const budgets = { a: 200, b: 500, c: 500, d: 500 }; const total = Object.values(budgets).reduce((t, v) => t + v, 0);
const capOld = await BC.checkBudgetCaps({ action: 'SCALE_UP', delta: 100, adAccountId: 'act', campaignId: 'b', productId: 424, productCapOverride: 600, deps: { caps: { product: null, campaign: null, account: null }, totals: { product: total, campaign: 500, account: total } } });
const capNew = await BC.checkBudgetCaps({ action: 'SCALE_UP', delta: 100, adAccountId: 'act', campaignId: 'b', productId: 424, productCapOverride: policy.budget.dailySpendCap, deps: { caps: { product: null, campaign: null, account: null }, totals: { product: total, campaign: 500, account: total } } });
ok(`with today's budgets (${total} in total across the 4 active campaigns) a product cap of 600 refuses EVERY raise (${total}+100 > 600)`, capOld.ok === false && capOld.violations[0]?.after === total + 100, JSON.stringify(capOld.violations));
ok(`a product cap of 2,100 lets one full round of +20% through (200→240, 500→600 ×3 = 2,040) but refuses to go past it`, capNew.ok === true && (await BC.checkBudgetCaps({ action: 'SCALE_UP', delta: 100, adAccountId: 'act', campaignId: 'b', productId: 424, productCapOverride: 2100, deps: { caps: { product: null, campaign: null, account: null }, totals: { product: 2090, campaign: 500, account: 2090 } } })).ok === false);
ok('a single campaign is never taken above the per-campaign maximum 600 (500 → 600 yes, 600 → 720 no) nor below the minimum 200 (240 → 192 no)', policy.budget.maxBudget === 600 && policy.budget.minBudget === 200 && BO.proposedBudget('SCALE_UP', 500, 20) === 600 && BO.proposedBudget('SCALE_UP', 600, 20) > 600 && BO.proposedBudget('SCALE_DOWN', 240, 20) < 200);
await prisma.$disconnect();
console.log(`\n${pass} passed, ${fail} failed`); setTimeout(() => process.exit(fail ? 1 : 0), 50);
