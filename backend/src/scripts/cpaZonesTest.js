// 🧪 CPA zones (the four points) — the shared pure module + the engine really agreeing with it (Bump Start, four zones, no gap between reduce and stop).
//   node src/scripts/cpaZonesTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url)); const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0; const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 220) : ''}`); } };
const Z = await imp('../../../js/cpa-zones.js'); const BO = await imp('../services/amb/budgetOptimizer.js'); const PP = await imp('../services/amb/productPolicy.js');
const R = { bumpStart: 20, bumpEnd: 100, reduceStart: 130, hardStop: 200 };

console.log('\n1. Boundaries are explicit (the example numbers are a preview only)');
{
  const c = (x) => Z.classifyCpa(x, R);
  ok('19 → BELOW_BUMP (below Bump Start: no automatic increase)', c(19) === 'BELOW_BUMP'); ok('20 → BUMP (Bump Start is inside the bump zone)', c(20) === 'BUMP'); ok('100 → BUMP (Bump End is inside the bump zone)', c(100) === 'BUMP');
  ok('100.01 → HOLD and 129.99 → HOLD', c(100.01) === 'HOLD' && c(129.99) === 'HOLD'); ok('130 → REDUCE (Reduce Start is inside the reduce zone)', c(130) === 'REDUCE'); ok('200 → REDUCE (the Hard Stop value itself is still «reduce»)', c(200) === 'REDUCE');
  ok('200.01 → STOP (strictly above the Hard Stop)', c(200.01) === 'STOP'); ok('no orders (null) → NONE, never a zone', c(null) === 'NONE' && c('') === 'NONE');
  ok('describeZones prints the four cards with the exact numbers', Z.describeZones(R).map((x) => x.text).join(' | ') === '20 – 100 | 100 – 130 | 130 – 200 | 200+');
}
console.log('\n2. Overlaps and wrong order are refused');
{
  const v = (o) => Z.validateRanges({ ...R, ...o });
  ok('the example is valid', v({}).length === 0);
  ok('Bump Start ≥ Bump End → refused', v({ bumpStart: 100 }).length === 1 && v({ bumpStart: 120 }).length >= 1);
  ok('Bump End ≥ Reduce Start → refused (no hold zone left)', v({ bumpEnd: 130 }).length >= 1 && v({ bumpEnd: 140 }).length >= 1);
  ok('Reduce Start > Hard Stop → refused', v({ reduceStart: 210 }).length >= 1); ok('Reduce Start = Hard Stop is allowed (a one-point reduce zone)', v({ reduceStart: 200 }).length === 0);
  ok('zero / negative / text → refused', v({ bumpStart: 0 }).length === 1 && v({ hardStop: -5 }).length === 1 && v({ hardStop: 'abc' }).length === 1);
  ok('missing points are not errors (a product may inherit them)', Z.validateRanges({ bumpEnd: 80 }).length === 0 && Z.validateRanges({}).length === 0);
}
console.log('\n3. The engine decides exactly like the preview');
{
  const base = BO.mergePolicy({}); const P = BO.mergePolicy({ scale: { minCpa: 20, maxCpa: 100, minPurchases: 2, minSpend: 0 }, reduce: { minCpa: 130, maxCpa: 200, min7dCpa: 0, minPurchases: 1, minSpend: 0 }, highCpa: { above: 200, minPurchases: 1, minSpend: 0 }, keep: { minCpa: 101, maxCpa: 129 } });
  const NOW = new Date('2026-10-17T12:00:00Z');
  const cls = (cpa) => BO.classifyBudget({ policy: P, now: NOW, ageHours: 100, m: { spend: cpa * 5, purchases: 5, cpa }, m7: { cpa, spend: cpa * 5, purchases: 5 } });
  ok('CPA 19 → SCALE_CPA_BELOW_BUMP_START, no action', cls(19).zone === 'SCALE_CPA_BELOW_BUMP_START' && cls(19).action === null);
  ok('CPA 20 → SCALE (increase)', cls(20).zone === 'SCALE' && cls(20).action === 'SCALE_UP'); ok('CPA 100 → SCALE', cls(100).zone === 'SCALE');
  ok('CPA 110 → KEEP (hold), no action', cls(110).zone === 'KEEP' && cls(110).action === null);
  ok('CPA 130 → REDUCE', cls(130).zone === 'REDUCE' && cls(130).action === 'SCALE_DOWN'); ok('CPA 200 → REDUCE (not stop)', cls(200).zone === 'REDUCE');
  ok('CPA 201 → HIGH_CPA (above the Hard Stop)', cls(201).zone === 'HIGH_CPA');
  const old = BO.classifyBudget({ policy: base, now: NOW, ageHours: 100, m: { spend: 200, purchases: 5, cpa: 10 }, m7: { cpa: 10, spend: 200, purchases: 5 } }); ok('a policy WITHOUT Bump Start behaves as before (CPA 10 still scales)', old.zone === 'SCALE');
  ok('policy validation: Bump Start must be below the scale line', BO.validatePolicy(BO.mergePolicy({ scale: { minCpa: 90, maxCpa: 80 } })).length >= 1 && BO.validatePolicy(BO.mergePolicy({ scale: { minCpa: 20 } })).length === 0);
}
console.log('\n4. Product policy: the four points flow from the screen into the engine');
{
  const pol = PP.normalizePolicy({ cpa: { scaleMin: 20, scale: 100, reduce: 130, hardStop: 200 } });
  ok('scaleMin survives normalisation', pol.cpa.scaleMin === 20 && PP.validatePolicy(pol).length === 0);
  ok('scaleMin ≥ scale is refused by the product policy too', PP.validatePolicy(PP.normalizePolicy({ cpa: { scaleMin: 100, scale: 100 } })).length === 1);
  const out = PP.applyToBudgetPolicy(BO.mergePolicy({}), pol); const p = out.policy;
  ok('applied to the engine: Bump Start 20 · Bump End 100 · Reduce 130 · reduce zone ends at the Hard Stop 200 · stop above 200', p.scale.minCpa === 20 && p.scale.maxCpa === 100 && p.reduce.minCpa === 130 && p.reduce.maxCpa === 200 && p.highCpa.above === 200, JSON.stringify([p.scale, p.reduce, p.highCpa.above]));
  const src = PP.resolveSources({ global: { cpa: { scaleMin: 10 } }, globalVersion: 3, product: { cpa: { scale: 100 } } });
  ok('the source of Bump Start is shown (GLOBAL v3) and Bump End is PRODUCT', src['cpa.scaleMin'].source === 'GLOBAL' && src['cpa.scaleMin'].version === 3 && src['cpa.scale'].source === 'PRODUCT');
  const ov = PP.overlayGlobal(PP.normalizeGlobal({ cpa: { scaleMin: 15, scale: 90, reduce: 140, hardStop: 210 } }), PP.normalizePolicy({ cpa: { scale: 100 } })); ok('a product overrides only what it sets; the rest comes from the global rules', ov.cpa.scale === 100 && ov.cpa.scaleMin === 15 && ov.cpa.hardStop === 210);
}
console.log('\n5. Performance status per product: «did the campaigns reach the target / the excellent cost?»');
{
  const ps = (o) => Z.performanceStatus({ ranges: R, minOrders: 5, zeroSpend: 200, ...o });
  ok('CPA 85 with 8 orders → BUMP «حقق الهدف» (green)', ps({ cpa: 85, orders: 8, spend: 680 }).code === 'BUMP' && ps({ cpa: 85, orders: 8, spend: 680 }).tone === 'green');
  ok('CPA 110 → HOLD · 150 → REDUCE (amber) · 230 → STOP (red)', ps({ cpa: 110, orders: 8, spend: 900 }).code === 'HOLD' && ps({ cpa: 150, orders: 8, spend: 1200 }).code === 'REDUCE' && ps({ cpa: 150, orders: 8, spend: 1200 }).tone === 'amber' && ps({ cpa: 230, orders: 8, spend: 1840 }).code === 'STOP' && ps({ cpa: 230, orders: 8, spend: 1840 }).tone === 'red');
  ok('the boundary values follow the engine: 100 → BUMP, 200 → REDUCE, 200.01 → STOP', ps({ cpa: 100, orders: 6, spend: 600 }).code === 'BUMP' && ps({ cpa: 200, orders: 6, spend: 1200 }).code === 'REDUCE' && ps({ cpa: 200.01, orders: 6, spend: 1200 }).code === 'STOP');
  ok('too few orders (3 < 5) → LOW_SAMPLE even with a great CPA (never «reached the target» on a thin sample)', ps({ cpa: 40, orders: 3, spend: 120 }).code === 'LOW_SAMPLE' && /3 من 5/.test(ps({ cpa: 40, orders: 3, spend: 120 }).detail));
  ok('spend without orders: under the limit → ZERO_ORDERS (amber) · at/over → ZERO_ORDERS_OVER (red)', ps({ orders: 0, spend: 120 }).code === 'ZERO_ORDERS' && ps({ orders: 0, spend: 200 }).code === 'ZERO_ORDERS_OVER' && ps({ orders: 0, spend: 350 }).tone === 'red');
  ok('no spend at all → NO_SPEND · no points set → NO_RANGES (never a verdict on invented limits)', ps({ orders: 0, spend: 0 }).code === 'NO_SPEND' && Z.performanceStatus({ cpa: 90, orders: 9, spend: 800, ranges: {}, minOrders: 5 }).code === 'NO_RANGES');
  ok('CPA below Bump Start → BELOW_BUMP (check the number first)', ps({ cpa: 12, orders: 9, spend: 108 }).code === 'BELOW_BUMP');
  ok('the attention order: STOP first, then spend-without-orders, then REDUCE … BUMP … HOLD', Z.PERF_META.STOP.rank < Z.PERF_META.ZERO_ORDERS_OVER.rank && Z.PERF_META.ZERO_ORDERS_OVER.rank < Z.PERF_META.REDUCE.rank && Z.PERF_META.REDUCE.rank < Z.PERF_META.BUMP.rank && Z.PERF_META.BUMP.rank < Z.PERF_META.HOLD.rank);
}
console.log(`\n${fail ? '❌' : '✅'} cpaZonesTest: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
