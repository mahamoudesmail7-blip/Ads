// Revenue-source honesty fix — Meta's own self-reported ad-conversion
// revenue must never render as confirmed revenue, and ROAS must be
// explicitly labeled by which revenue it's based on. Offline unit tests
// against services/amb/productMarketing.js's deriveRevenueHonesty(), a
// small pure function extracted specifically so this logic is testable
// without mocking computeSnapshot's entire dependency chain.
//   node src/scripts/revenueHonestyTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { deriveRevenueHonesty } = await import(pathToFileURL(join(__dirname, '../services/amb/productMarketing.js')).href);

console.log('§1 Real production case (product 212 / LumiMist, confirmed live) — Meta revenue never presented as confirmed:');
{
  const m = { revenue: 69048, revenueSource: null, roas: 7.88162495163019, totalSpend: 8760.63 };
  const customerQuality = { source: 'easyorders', revenue: 899 };
  const r = deriveRevenueHonesty({ m, customerQuality });
  ok('revenueSource is explicitly "meta", never left null (which the UI treats as "no tag" -> looks confirmed)', r.revenueSource === 'meta', JSON.stringify(r));
  ok('codRevenue is the real, separate Easy Orders figure (899), completely independent of Meta\'s 69048', r.codRevenue === 899, JSON.stringify(r));
  ok('realRoas computed from the REAL revenue only: 899 / 8760.63, nowhere near Meta\'s reported 7.88 ROAS', Math.abs(r.realRoas - (899 / 8760.63)) < 1e-9, JSON.stringify(r));
  ok('the two revenue figures are never merged/averaged — codRevenue stays exactly 899, not blended with 69048', r.codRevenue === 899);
}

console.log('\n§2 A confirmed AmbProduct with real COD-based revenue (netProfitBundle) — the existing real/estimated tag is preserved untouched:');
{
  const m = { revenue: 1798, revenueSource: 'real', roas: 12.97, totalSpend: 138.6 };
  const customerQuality = { source: 'easyorders', revenue: 1798 };
  const r = deriveRevenueHonesty({ m, customerQuality });
  ok('revenueSource stays "real" — never overwritten to "meta" just because a revenue value exists', r.revenueSource === 'real', JSON.stringify(r));
  ok('realRoas is still independently computed from customerQuality (not just copied from m.roas), and matches here since both are COD-based', Math.abs(r.realRoas - (1798 / 138.6)) < 1e-6, JSON.stringify(r));
}

console.log('\n§3 A COD-estimated revenue (price × delivered count, no real order total yet) — "estimated" tag preserved:');
{
  const m = { revenue: 3400, revenueSource: 'estimated', roas: 5, totalSpend: 680 };
  const customerQuality = { source: 'none', revenue: null };
  const r = deriveRevenueHonesty({ m, customerQuality });
  ok('revenueSource stays "estimated"', r.revenueSource === 'estimated', JSON.stringify(r));
  ok('realRoas is null — customerQuality has no real signal at all (source:none) to compute a real ROAS from, never fabricated', r.realRoas === null, JSON.stringify(r));
  ok('codRevenue is null — no real Easy Orders revenue exists here, never confused with the estimated figure', r.codRevenue === null, JSON.stringify(r));
}

console.log('\n§4 No revenue anywhere at all -> everything honestly null, never a fabricated 0:');
{
  const m = { revenue: null, revenueSource: null, roas: null, totalSpend: 0 };
  const customerQuality = { source: 'none', revenue: null };
  const r = deriveRevenueHonesty({ m, customerQuality });
  ok('revenueSource null (no revenue value to even tag)', r.revenueSource === null, JSON.stringify(r));
  ok('realRoas null (no spend, no real revenue)', r.realRoas === null, JSON.stringify(r));
  ok('codRevenue null', r.codRevenue === null, JSON.stringify(r));
}

console.log('\n§5 Real COD revenue exists but spend is 0 -> realRoas stays null (division by zero never silently produces Infinity/0):');
{
  const m = { revenue: null, revenueSource: null, roas: null, totalSpend: 0 };
  const customerQuality = { source: 'easyorders', revenue: 500 };
  const r = deriveRevenueHonesty({ m, customerQuality });
  ok('codRevenue reflects the real 500 regardless of Meta having nothing', r.codRevenue === 500, JSON.stringify(r));
  ok('realRoas is null, not Infinity or a fabricated number, when spend is 0', r.realRoas === null, JSON.stringify(r));
}

console.log('\n§6 Real COD revenue is genuinely ZERO (delivered nothing yet, but the query itself succeeded) -> realRoas is a real 0, not null (honest "confirmed zero" vs "not computable" distinction):');
{
  const m = { revenue: null, revenueSource: null, roas: null, totalSpend: 500 };
  const customerQuality = { source: 'easyorders', revenue: 0 };
  const r = deriveRevenueHonesty({ m, customerQuality });
  ok('codRevenue is 0 (a real, confirmed zero — not null)', r.codRevenue === 0, JSON.stringify(r));
  ok('realRoas is a real 0 (0/500), not null — the COD signal genuinely exists and says zero', r.realRoas === 0, JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
