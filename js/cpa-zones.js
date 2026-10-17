// cpa-zones.js — the four CPA points the owner sets per product (or globally) and the zone each CPA falls in. PURE, no DOM, shared by the screen and the server tests.
//
//   Bump Start CPA ── Bump End CPA ─────── Reduce Start CPA ──────── Hard Stop CPA
//   below Start : no automatic increase (an unusually low CPA is checked first, not celebrated)
//   Start … End : BUMP   (both ends inclusive: CPA ≤ Bump End increases)           ← the engine's `cpa <= scale.maxCpa`
//   End … Reduce: HOLD   (strictly between: nothing is changed)                     ← `cpa < reduce.minCpa`
//   Reduce … Stop: REDUCE (Reduce Start inclusive, Hard Stop inclusive)               ← `cpa <= reduce.maxCpa`
//   above Stop  : STOP   (strictly above the Hard Stop: pause per the approved pause policy — minimum purchases, winner protection, manual override, live preflight)
// These are the SAME boundaries budgetOptimizer.classifyBudget applies, so the preview on the screen can never disagree with what the engine decides.
export const ZONE_META = {
  NONE: { label: 'غير معروف', tone: 'gray' }, BELOW_BUMP: { label: 'أقل من بداية الزيادة — راجع الرقم', tone: 'gray' },
  BUMP: { label: 'زيادة الميزانية', tone: 'green' }, HOLD: { label: 'تثبيت', tone: 'gray' }, REDUCE: { label: 'تقليل الميزانية', tone: 'amber' }, STOP: { label: 'إيقاف (وفق شروط الأمان)', tone: 'red' },
};
const n = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);

/** r = { bumpStart, bumpEnd, reduceStart, hardStop } → the ordered problems in Arabic ([] = valid). Missing points are not errors (a product may inherit them). */
export function validateRanges(r = {}) {
  const e = []; const v = { bumpStart: n(r.bumpStart), bumpEnd: n(r.bumpEnd), reduceStart: n(r.reduceStart), hardStop: n(r.hardStop) };
  for (const [k, x] of Object.entries(v)) if (x !== null && (Number.isNaN(x) || x < 1)) e.push(`${LABEL[k]}: رقم أكبر من صفر.`);
  if (e.length) return e;
  if (v.bumpStart != null && v.bumpEnd != null && v.bumpStart >= v.bumpEnd) e.push('بداية الزيادة لازم تكون أقل من نهايتها.');
  if (v.bumpEnd != null && v.reduceStart != null && v.bumpEnd >= v.reduceStart) e.push('نهاية الزيادة لازم تكون أقل من بداية التقليل (غير كده مفيش منطقة تثبيت).');
  if (v.reduceStart != null && v.hardStop != null && v.reduceStart > v.hardStop) e.push('بداية التقليل لازم تكون ≤ بداية الإيقاف.');
  if (v.bumpEnd != null && v.hardStop != null && v.bumpEnd >= v.hardStop) e.push('نهاية الزيادة لازم تكون أقل من بداية الإيقاف.');
  return e;
}
const LABEL = { bumpStart: 'بداية الزيادة', bumpEnd: 'نهاية الزيادة', reduceStart: 'بداية التقليل', hardStop: 'بداية الإيقاف' };

/** The zone a CPA falls in. cpa null (no orders) → NONE: the zero-order rule is separate and never a CPA zone. */
export function classifyCpa(cpa, r = {}) {
  const c = n(cpa); if (c === null || Number.isNaN(c)) return 'NONE';
  const s = n(r.bumpStart), b = n(r.bumpEnd), rd = n(r.reduceStart), h = n(r.hardStop);
  if (b != null && c <= b) return s != null && c < s ? 'BELOW_BUMP' : 'BUMP';
  if (rd != null && c < rd) return 'HOLD';
  if (h != null && c <= h) return rd != null ? 'REDUCE' : 'HOLD';
  if (h != null) return 'STOP';
  return rd != null ? 'REDUCE' : 'HOLD';
}

/** The four zone cards with the exact inclusive wording (what the screen prints under the slider). */
export function describeZones(r = {}) {
  const s = n(r.bumpStart), b = n(r.bumpEnd), rd = n(r.reduceStart), h = n(r.hardStop); const f = (x) => (x == null ? '—' : x);
  return [
    { zone: 'BUMP', ...ZONE_META.BUMP, text: `${f(s)} – ${f(b)}` , note: 'من بداية الزيادة وحتى نهايتها (والحدّان داخل النطاق)' },
    { zone: 'HOLD', ...ZONE_META.HOLD, text: `${f(b)} – ${f(rd)}`, note: 'أكبر من نهاية الزيادة وأقل من بداية التقليل' },
    { zone: 'REDUCE', ...ZONE_META.REDUCE, text: `${f(rd)} – ${f(h)}`, note: 'من بداية التقليل وحتى بداية الإيقاف (والحدّان داخل النطاق)' },
    { zone: 'STOP', ...ZONE_META.STOP, text: `${f(h)}+`, note: 'أعلى من بداية الإيقاف' },
  ];
}
// ---- the product's PERFORMANCE STATUS: «did the campaigns reach the target / the excellent cost or not?» — PURE, from the same four points + the sample rule the engine uses.
//   Order of checks: no points → no spend → spend without orders (vs the zero-order limit) → too few orders to trust the CPA → the CPA zone.
export const PERF_META = {
  BUMP: { label: 'حقق الهدف — CPA ممتاز', short: 'حقق الهدف', tone: 'green', rank: 4 }, HOLD: { label: 'مقبول — تثبيت', short: 'مقبول', tone: 'gray', rank: 6 },
  REDUCE: { label: 'ضعيف — يتقلّل', short: 'ضعيف', tone: 'amber', rank: 2 }, STOP: { label: 'خسارة — يتوقف', short: 'خسارة', tone: 'red', rank: 0 },
  ZERO_ORDERS_OVER: { label: 'صرف بدون أوردرات', short: 'بدون أوردرات', tone: 'red', rank: 1 }, ZERO_ORDERS: { label: 'لسه بدون أوردرات', short: 'بدون أوردرات', tone: 'amber', rank: 3 },
  LOW_SAMPLE: { label: 'عينة قليلة', short: 'عينة قليلة', tone: 'blue', rank: 5 }, BELOW_BUMP: { label: 'CPA منخفض بشكل غريب', short: 'راجع الرقم', tone: 'blue', rank: 7 },
  NO_SPEND: { label: 'مفيش صرف', short: 'مفيش صرف', tone: 'gray', rank: 8 }, NO_RANGES: { label: 'حدود CPA غير محددة', short: 'غير محدد', tone: 'gray', rank: 9 },
};
export function performanceStatus({ cpa = null, orders = 0, spend = 0, ranges = {}, minOrders = null, zeroSpend = null } = {}) {
  const r = { bumpStart: n(ranges.bumpStart), bumpEnd: n(ranges.bumpEnd), reduceStart: n(ranges.reduceStart), hardStop: n(ranges.hardStop) }; const o = Number(orders) || 0, sp = Number(spend) || 0, c = n(cpa); const need = Math.max(1, Number(minOrders) || 1);
  const out = (code, detail) => ({ code, ...PERF_META[code], detail });
  if (r.bumpEnd == null && r.reduceStart == null && r.hardStop == null) return out('NO_RANGES', 'حدّد نقاط الـCPA عشان نقدر نحكم على الحملات.');
  if (!o && !sp) return out('NO_SPEND', 'مفيش صرف في الفترة دي.');
  if (!o) return zeroSpend != null && sp >= zeroSpend ? out('ZERO_ORDERS_OVER', `صرف ${Math.round(sp)} ج من غير أوردر — وصل حد ${zeroSpend} ج.`) : out('ZERO_ORDERS', `صرف ${Math.round(sp)} ج من غير أوردر${zeroSpend != null ? ` (حد الإيقاف ${zeroSpend} ج)` : ''}.`);
  const zone = classifyCpa(c, r);
  if (o < need) return out('LOW_SAMPLE', `${o} من ${need} أوردر مطلوبين — CPA ${c != null ? Math.round(c) : '—'} لسه مش مؤكد${zone === 'NONE' ? '' : ` (يميل لـ«${ZONE_META[zone].label}»)`}.`);
  const f = (x) => (x == null ? '—' : Math.round(x));
  if (zone === 'BUMP') return out('BUMP', `CPA ${f(c)} داخل نطاق الزيادة (${f(r.bumpStart)}–${f(r.bumpEnd)}).`);
  if (zone === 'BELOW_BUMP') return out('BELOW_BUMP', `CPA ${f(c)} أقل من بداية الزيادة (${f(r.bumpStart)}) — راجع الرقم قبل أي زيادة.`);
  if (zone === 'HOLD') return out('HOLD', `CPA ${f(c)} بين ${f(r.bumpEnd)} و${f(r.reduceStart)} — مفيش تغيير.`);
  if (zone === 'REDUCE') return out('REDUCE', `CPA ${f(c)} من ${f(r.reduceStart)} لحد ${f(r.hardStop)} — الميزانية تقل.`);
  return out('STOP', `CPA ${f(c)} أعلى من ${f(r.hardStop)} — يتوقف بشروط الأمان.`);
}
export { LABEL as RANGE_LABEL };
