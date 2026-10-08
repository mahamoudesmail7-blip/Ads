// 🎯 AI Priority Score (0–100) per campaign — a transparent, additive score shown next to every campaign.
// It RANKS and EXPLAINS. It never allows, blocks or triggers an execution by itself: every action still needs its guards, its permission and an ADMIN approval (usedForExecution is always false).
// Higher = a healthier / stronger campaign (more deserving of budget and of staying on). Components are summed, then guards/warnings subtract.
import { sampleTier, cpaReference, cpaStability } from './dailyPlanCandidates.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r0 = (v) => Math.round(v);
export const SCORE_BANDS = [{ min: 75, key: 'STRONG', label: 'قوية' }, { min: 55, key: 'GOOD', label: 'جيدة' }, { min: 35, key: 'FAIR', label: 'متوسطة' }, { min: 0, key: 'WEAK', label: 'ضعيفة' }];
export const bandOf = (score) => SCORE_BANDS.find((b) => score >= b.min);

/**
 * m3 / m7 / m30: {spend, purchases, cpa, cvr} (any may be null/empty). ageHours: campaign age (null = unknown). dataAgeMin: minutes since the last successful Meta sync (null = unknown).
 * blocks: hard guard codes, warnings: soft ones. cpaFull / cpaZero: the CPA that earns full / zero CPA points (defaults = the policy's scale line 80 and the high-CPA line 200).
 */
export function priorityScore({ m3 = null, m7 = null, m30 = null, ageHours = null, dataAgeMin = null, blocks = [], warnings = [], cpaFull = 80, cpaZero = 200 } = {}) {
  const parts = [];
  const add = (key, label, points, max, detail) => parts.push({ key, label, points: r0(points), max, detail });
  const ref = cpaReference({ m7, m30 });
  // 1. CPA against the policy lines (30)
  if (ref == null) add('cpa', 'CPA مقابل الهدف', 0, 30, 'مفيش CPA موثوق (عينة غير كافية)');
  else add('cpa', 'CPA مقابل الهدف', clamp(30 * (cpaZero - ref) / (cpaZero - cpaFull), 0, 30), 30, `CPA المرجعي ${r0(ref)} (الخط الممتاز ≤ ${cpaFull}، الضعيف ≥ ${cpaZero})`);
  // 2. orders = sample size (15)
  const p30 = m30?.purchases ?? 0; add('orders', 'عدد الأوردرات (30 يوم)', clamp(p30 / 40, 0, 1) * 15, 15, `${p30} أوردر — عينة ${{ A: 'قوية', B: 'متوسطة', C: 'صغيرة', D: 'ضعيفة جدًا' }[sampleTier(p30)]}`);
  // 3. stability between 7d and 30d (15)
  const stab = cpaStability({ m7, m30 }); add('stability', 'ثبات الأداء (7 مقابل 30 يوم)', { STABLE: 15, UNKNOWN: 7, VOLATILE: 2 }[stab], 15, { STABLE: 'CPA مستقر', UNKNOWN: 'مفيش عينة كفاية لتقييم الثبات', VOLATILE: 'CPA متذبذب' }[stab]);
  // 4. recent trend: 3d vs 7d (10)
  let trend = 4, trendDetail = 'مفيش عينة 3 أيام كفاية';
  if (m3?.cpa > 0 && m7?.cpa > 0 && (m3.purchases ?? 0) >= 2) { const q = m3.cpa / m7.cpa; if (q <= 0.9) { trend = 10; trendDetail = 'آخر 3 أيام أحسن من الأسبوع'; } else if (q <= 1.15) { trend = 7; trendDetail = 'آخر 3 أيام مماثلة للأسبوع'; } else if (q <= 1.3) { trend = 3; trendDetail = 'آخر 3 أيام أضعف قليلًا'; } else { trend = 0; trendDetail = 'آخر 3 أيام أسوأ بوضوح من الأسبوع'; } }
  else if ((m3?.purchases ?? 0) === 0 && (m3?.spend ?? 0) >= 200) { trend = 0; trendDetail = `صرف ${r0(m3.spend)} في 3 أيام بدون أوردرات`; }
  add('trend', 'الاتجاه الحديث (3 أيام)', trend, 10, trendDetail);
  // 5. strength of the conversion evidence (10)
  const ev = p30 >= 20 ? 10 : p30 >= 8 ? 6 : p30 >= 3 ? 3 : 0; add('evidence', 'قوة أدلة التحويل', ev, 10, p30 >= 20 ? 'أدلة قوية (20+ أوردر)' : p30 >= 8 ? 'أدلة متوسطة' : p30 >= 3 ? 'أدلة ضعيفة' : 'مفيش أدلة كافية');
  // 6. spend volume = signal (5)
  const sp = m30?.spend ?? 0; add('spend', 'حجم الإنفاق (30 يوم)', sp >= 3000 ? 5 : sp >= 1000 ? 3 : sp >= 300 ? 1 : 0, 5, `${r0(sp)} صرف`);
  // 7. data freshness (5)
  add('freshness', 'حداثة البيانات', dataAgeMin == null ? 2 : dataAgeMin <= 30 ? 5 : dataAgeMin <= 90 ? 3 : 0, 5, dataAgeMin == null ? 'عمر البيانات غير معروف' : `آخر مزامنة Meta من ${r0(dataAgeMin)} دقيقة`);
  // 8. campaign age (5)
  add('age', 'عمر الحملة', ageHours == null ? 2 : ageHours < 72 ? 1 : ageHours <= 336 ? 3 : 5, 5, ageHours == null ? 'العمر غير معروف' : ageHours < 72 ? `حملة جديدة (${r0(ageHours)} ساعة) — لسه في فترة اختبار` : `${r0(ageHours / 24)} يوم`);
  const sum = parts.reduce((t, p) => t + p.points, 0);
  const hard = Math.min(20, (blocks || []).length * 10), soft = Math.min(6, (warnings || []).length * 2);
  const penalty = hard + soft;
  const score = clamp(sum - penalty, 0, 100);
  const band = bandOf(score);
  const reasons = parts.filter((p) => p.points >= p.max * 0.7).map((p) => `＋ ${p.label}: ${p.detail}`).concat(parts.filter((p) => p.points <= p.max * 0.3).map((p) => `－ ${p.label}: ${p.detail}`));
  if (penalty) reasons.push(`－ حواجز/تحذيرات: ${[...(blocks || []), ...(warnings || [])].join(' · ')} (خصم ${penalty})`);
  const confidence = p30 >= 20 && dataAgeMin != null && dataAgeMin <= 90 ? 'HIGH' : p30 >= 8 ? 'MEDIUM' : 'LOW';
  return { score, band: band.key, bandLabel: band.label, components: parts, penalty, reasons, confidence, caveat: 'Score للترتيب والشرح فقط — مبيسمحش بتنفيذ وحده. أي تنفيذ محتاج الحواجز والصلاحية واعتماد ADMIN.', usedForExecution: false };
}
