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
export { LABEL as RANGE_LABEL };
