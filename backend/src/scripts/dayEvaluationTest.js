// 📅 Day-based AUTOPILOT evaluation — pure rules (no database, no Meta). node src/scripts/dayEvaluationTest.js
//   · the evaluation day starts at Cairo 00:00 (DST-aware); a campaign opened later starts at its own opening time
//   · time / spend / orders gate (OBSERVATION) · the product's own Hard Stop decides HIGH_CPA on TODAY, never on the 3-day CPA
//   · Winner protection · the LAST active campaign of a product · urgent protections are untouched
import { dayStartUtc, evaluationStart, hoursSince, observationStatus, OBSERVATION_DEFAULT } from '../services/amb/dayEvaluation.js';
import { decidePause, normalizePause } from '../services/amb/pausePolicy.js';
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };

console.log('1. The evaluation day: Cairo 00:00, DST-aware');
ok('00:15 Cairo on 26/10 (UTC+3) → the day started at 25/10 21:00Z', dayStartUtc(new Date('2026-10-25T21:15:00Z')).toISOString() === '2026-10-25T21:00:00.000Z', dayStartUtc(new Date('2026-10-25T21:15:00Z')).toISOString());
ok('23:30 Cairo (still 25/10) → the same day started at 24/10 21:00Z', dayStartUtc(new Date('2026-10-25T20:30:00Z')).toISOString() === '2026-10-24T21:00:00.000Z');
ok('after the October DST change (UTC+2) → midnight is 22:00Z the evening before', dayStartUtc(new Date('2026-11-02T10:00:00Z')).toISOString() === '2026-11-01T22:00:00.000Z', dayStartUtc(new Date('2026-11-02T10:00:00Z')).toISOString());
const now = new Date('2026-10-26T09:00:00Z'); // 12:00 Cairo
ok('a campaign opened at 03:00 Cairo today starts its evaluation at 03:00 (not at midnight)', evaluationStart({ now, activationAt: new Date('2026-10-26T00:00:00Z') }).toISOString() === '2026-10-26T00:00:00.000Z');
ok('opened yesterday → the evaluation starts at today\'s midnight (yesterday is not today\'s evidence)', evaluationStart({ now, activationAt: new Date('2026-10-25T10:00:00Z') }).toISOString() === dayStartUtc(now).toISOString());
ok('no activation recorded → today\'s midnight', evaluationStart({ now }).toISOString() === dayStartUtc(now).toISOString());
ok('hoursSince: 12:00 Cairo is 12 hours after midnight', Math.abs(hoursSince(dayStartUtc(now), now) - 12) < 1e-9);

console.log('\n2. OBSERVATION: time + spend + orders (the product\'s minimum orders)');
const o = (e, mp = 2) => observationStatus({ evidence: e, minPurchases: mp });
ok('defaults: 3 hours and 100 spend', OBSERVATION_DEFAULT.minHours === 3 && OBSERVATION_DEFAULT.minSpend === 100);
ok('00:15 with nothing yet → missing TIME + SPEND + ORDERS', JSON.stringify(o({ hours: 0.25, spend: 0, purchases: 0 }).missing.map((x) => x.code)) === '["TIME","SPEND","ORDERS"]');
ok('6 hours, 400 spend, 1 order (product needs 2) → still observing: ORDERS', JSON.stringify(o({ hours: 6, spend: 400, purchases: 1 }).missing.map((x) => x.code)) === '["ORDERS"]');
ok('1 hour but 3 orders and 300 spend → observing: TIME only (a good start is not enough)', JSON.stringify(o({ hours: 1, spend: 300, purchases: 3 }).missing.map((x) => x.code)) === '["TIME"]');
ok('6 hours + 300 spend + 3 orders → enough evidence', o({ hours: 6, spend: 300, purchases: 3 }).ok === true);

console.log('\n3. Pause: HIGH_CPA stands on TODAY (the 159 case at 12:15 AM)');
const pol = normalizePause({ enabled: true, version: 4, approved: { version: 4 }, zeroOrder: { enabled: true, spend: 200 }, highCpa: { enabled: true, above: null, minPurchases: 3, minSpend: 300 }, stockOut: { enabled: true }, protections: { winnerProtection: true, precedence: 'PROTECTION_WINS', recentImprovement: { enabled: true, minPurchases: 2 } }, scope: { includeProducts: ['159'] } });
const base = { policy: pol, campaignId: 'selicon', productId: 159, storeId: 's', optimizer: null, productHighCpa: 150, stock: null, winner: false, weekday: 1, automatic: true, obsMinHours: 3, lastActive: false };
const m3bad = { spend: 625, purchases: 3, cpa: 208 }; // the HISTORICAL 3-day CPA that used to pause it
const d1 = decidePause({ ...base, m3: m3bad, mDay: { spend: 0, purchases: 0, cpa: null }, dayHours: 0.25 });
ok('12:15 AM, historical 3-day CPA far above the Hard Stop, NO data today → NO pause (the old behaviour paused here)', d1.trigger === null && d1.fired.length === 0, JSON.stringify(d1));
ok('the same campaign WITHOUT day evidence (legacy call) would have been paused — proves the change', decidePause({ ...base, m3: m3bad }).trigger === 'HIGH_CPA');
const d2 = decidePause({ ...base, m3: m3bad, mDay: { spend: 450, purchases: 3, cpa: 170 }, dayHours: 1 });
ok('1 hour into the day with a bad sample → OBSERVATION (skipped, not fired)', d2.trigger === null && d2.skipped.some((s) => s.trigger === 'HIGH_CPA' && s.code === 'OBSERVATION'), JSON.stringify(d2.skipped));
const d3 = decidePause({ ...base, m3: m3bad, mDay: { spend: 510, purchases: 3, cpa: 170 }, dayHours: 6 });
ok('6 hours in: today\'s CPA 170 > 150 on 3 orders / 510 spend → HIGH_CPA pause', d3.trigger === 'HIGH_CPA' && d3.threshold === 150);
const d4 = decidePause({ ...base, m3: { spend: 900, purchases: 5, cpa: 300 }, mDay: { spend: 400, purchases: 4, cpa: 100 }, dayHours: 8 });
ok('a terrible 3-day CPA does NOT pause a campaign that is fine TODAY (3-day data is analysis only)', d4.trigger === null && d4.fired.length === 0);
const d5 = decidePause({ ...base, m3: m3bad, mDay: { spend: 510, purchases: 3, cpa: 170 }, dayHours: 6, winner: true });
ok('Winner protection still wins over a bad today (WINNER_PROTECTED)', d5.trigger === null && d5.skipped.some((s) => s.code === 'WINNER_PROTECTED'));
ok('thin sample today (2 orders < 3) → no pause', decidePause({ ...base, m3: m3bad, mDay: { spend: 600, purchases: 2, cpa: 300 }, dayHours: 8 }).trigger === null);
ok('STOCK_OUT is urgent: it pauses even at 00:15 with no day data', decidePause({ ...base, stock: { status: 'OUT_OF_STOCK' }, m3: null, mDay: { spend: 0, purchases: 0, cpa: null }, dayHours: 0.25 }).trigger === 'STOCK_OUT');
ok('ZERO_ORDER (spend with no orders) stays an urgent protection: the optimizer\'s own row still fires it at 00:15', decidePause({ ...base, optimizer: { action: 'PAUSE' }, m3: { spend: 260, purchases: 0, cpa: null }, mDay: { spend: 0, purchases: 0, cpa: null }, dayHours: 0.25 }).trigger === 'ZERO_ORDER');

console.log('\n4. The LAST active campaign of a product is not paused in a hurry');
const L = { ...base, lastActive: true, m3: m3bad };
ok('last active + CPA 170 (1.13× the limit) on 3 orders → protected (LAST_ACTIVE_CAMPAIGN), the budget path handles it', (() => { const r = decidePause({ ...L, mDay: { spend: 510, purchases: 3, cpa: 170 }, dayHours: 6 }); return r.trigger === null && r.skipped.some((s) => s.code === 'LAST_ACTIVE_CAMPAIGN'); })());
ok('last active + a severe, well-sampled breach (CPA 240 ≥ 1.5× limit, 6 orders ≥ 2× minimum) → paused', decidePause({ ...L, mDay: { spend: 1440, purchases: 6, cpa: 240 }, dayHours: 6 }).trigger === 'HIGH_CPA');
ok('severe CPA but a thin sample (3 orders) → still protected', decidePause({ ...L, mDay: { spend: 720, purchases: 3, cpa: 240 }, dayHours: 6 }).trigger === null);
ok('another active campaign exists (not the last) → the normal rule applies', decidePause({ ...base, lastActive: false, m3: m3bad, mDay: { spend: 510, purchases: 3, cpa: 170 }, dayHours: 6 }).trigger === 'HIGH_CPA');
ok('stock-out still pauses the LAST active campaign (urgent)', decidePause({ ...L, stock: { status: 'OUT_OF_STOCK' }, mDay: { spend: 0, purchases: 0, cpa: null }, dayHours: 1 }).trigger === 'STOCK_OUT');

console.log(`\n${fail ? '❌' : '✅'} dayEvaluationTest: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
