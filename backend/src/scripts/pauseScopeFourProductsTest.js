// 🛡️ Pause policy widened to the four AUTOMATIC products (442 · 1391 · 159 · 424): the scope grows, every protection stays exactly as it is.
//   Pure test (no database, no Meta): decidePause is the one function the engine asks «may this campaign be paused?».
//   node src/scripts/pauseScopeFourProductsTest.js
import { decidePause, normalizePause, validatePause, pausePolicyActive } from '../services/amb/pausePolicy.js';
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };

const base = normalizePause({ enabled: true, version: 4, zeroOrder: { enabled: true, spend: 200 }, highCpa: { enabled: true, above: null, minPurchases: 3, minSpend: 300 }, stockOut: { enabled: true }, protections: { winnerProtection: true, precedence: 'PROTECTION_WINS', recentImprovement: { enabled: true, minPurchases: 2 } }, scope: { includeProducts: ['424'] } });
const wide = normalizePause({ ...base, scope: { ...base.scope, includeProducts: ['424', '442', '1391', '159'] } });
ok('the widened policy is valid (a trigger is still required and present)', validatePause(wide, { requireTrigger: true }).length === 0);
ok('ONLY the scope changed: zero-order, high-CPA, stock-out and the protections are identical', JSON.stringify({ z: wide.zeroOrder, h: wide.highCpa, s: wide.stockOut, p: wide.protections }) === JSON.stringify({ z: base.zeroOrder, h: base.highCpa, s: base.stockOut, p: base.protections }));
ok('scope = exactly the four products (no store / campaign widening)', JSON.stringify(wide.scope.includeProducts) === JSON.stringify(['1391', '159', '424', '442']) && !wide.scope.includeStores.length && !wide.scope.includeCampaigns.length, JSON.stringify(wide.scope));

const d = (policy, o) => decidePause({ policy, campaignId: 'c1', productId: 442, storeId: 'trendy-storeee', optimizer: null, m3: { spend: 0, purchases: 0, cpa: null }, mToday: { spend: 0, purchases: 0, cpa: null }, productHighCpa: 150, stock: null, winner: false, weekday: 1, ...o });
console.log('\n1. Scope: before vs after');
ok('442 under the OLD policy → OUT_OF_SCOPE (blocked, nothing paused)', d(base, { m3: { spend: 900, purchases: 0, cpa: null } }).blockers.includes('OUT_OF_SCOPE'));
ok('442 under the WIDENED policy → in scope', !d(wide, { m3: { spend: 900, purchases: 0, cpa: null } }).blockers.length);
ok('1391 and 159 are in scope too, an unrelated product (999) is still OUT_OF_SCOPE', !d(wide, { productId: 1391 }).blockers.length && !d(wide, { productId: 159 }).blockers.length && d(wide, { productId: 999 }).blockers.includes('OUT_OF_SCOPE'));

console.log('\n2. The triggers still need real evidence (CPA / orders / spend)');
ok('HIGH_CPA fires only above the product\'s own Hard Stop with ≥3 orders and ≥300 spend', d(wide, { m3: { spend: 900, purchases: 5, cpa: 180 } }).trigger === 'HIGH_CPA' && d(wide, { m3: { spend: 900, purchases: 5, cpa: 140 } }).trigger === null && d(wide, { m3: { spend: 900, purchases: 2, cpa: 400 } }).trigger === null && d(wide, { m3: { spend: 250, purchases: 5, cpa: 400 } }).trigger === null);
ok('the PRODUCT Hard Stop wins over the global figure (159: 150 → 140 CPA is fine, 160 is not)', d(wide, { productId: 159, productHighCpa: 150, m3: { spend: 900, purchases: 5, cpa: 140 } }).trigger === null && d(wide, { productId: 159, productHighCpa: 150, m3: { spend: 900, purchases: 5, cpa: 160 } }).trigger === 'HIGH_CPA');
ok('ZERO_ORDER: 200+ spend with no orders fires, under 200 does not', d(wide, { m3: { spend: 260, purchases: 0, cpa: null } }).trigger === 'ZERO_ORDER' && d(wide, { m3: { spend: 150, purchases: 0, cpa: null } }).trigger === null);

console.log('\n3. Winner protection and recent improvement still win');
const bad = { spend: 900, purchases: 5, cpa: 180 };
ok('a WINNER campaign is NOT paused on HIGH_CPA / ZERO_ORDER (WINNER_PROTECTED) — protection wins over the rule', (() => { const r = d(wide, { winner: true, m3: bad }); return r.trigger === null && r.skipped.some((s) => s.code === 'WINNER_PROTECTED'); })());
ok('a winner IS still paused when the stock is out (the only thing that beats the protection)', d(wide, { winner: true, stock: { status: 'OUT_OF_STOCK' } }).trigger === 'STOCK_OUT');
ok('recent improvement (today ≥2 orders at/below the Hard Stop) holds a HIGH_CPA pause back (RECENT_IMPROVEMENT)', (() => { const r = d(wide, { m3: bad, mToday: { spend: 177, purchases: 2, cpa: 89 } }); return r.trigger === null && r.skipped.some((s) => s.code === 'RECENT_IMPROVEMENT'); })());
ok('without improvement the same campaign IS eligible (so the protection above is what saved it)', d(wide, { m3: bad, mToday: { spend: 177, purchases: 1, cpa: 177 } }).trigger === 'HIGH_CPA');

console.log('\n4. An unapproved newer version never acts (fail-closed)');
ok('a saved-but-unapproved version is NOT active: auto-pause is OFF for every product (424 included) until the owner approves that exact version — it never falls back silently', pausePolicyActive({ ...wide, enabled: true, version: 4, approved: { version: 3 } }) === false && pausePolicyActive({ ...wide, enabled: true, version: 4, approved: { version: 4 } }) === true);

console.log(`\n${fail ? '❌' : '✅'} pauseScopeFourProductsTest: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
