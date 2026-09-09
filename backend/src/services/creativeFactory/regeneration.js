// AI Creative Factory — RegenerationService.
//
// When an image fails quality review, build a TARGETED corrective note that
// gets folded into the next prompt (see promptBuilder buildPrompt's
// correctiveNote). It never regenerates the whole project — only the failed
// item — and every attempt is stored (cf_generation_attempts) so the history
// is auditable.
const REASON_HINTS = [
  { rx: /لون|colour|color/i, hint: 'طابق ألوان المنتج مع الصور المرجعية بدقة.' },
  { rx: /شكل|هيكل|proportion|نِسب|نسب/i, hint: 'صحّح شكل المنتج ونِسبه ليطابق المرجع تمامًا.' },
  { rx: /نص|خط|كتابة|arabic|typo/i, hint: 'اكتب النص العربي بشكل صحيح ومقروء 100%، بدون حروف مكسورة.' },
  { rx: /تشوه|artifact|distort|deform/i, hint: 'أزل أي تشوهات أو تكرار غير طبيعي في المنتج.' },
  { rx: /شعار|logo|منفذ|port|زر|button|ملصق|label/i, hint: 'لا تُظهر أي شعار/منفذ/زر/ملصق غير موجود في هوية المنتج.' },
  { rx: /خلفي|background|بيئة/i, hint: 'بسّط الخلفية والتزم بعائلة الخلفية الموحدة.' },
  { rx: /ادعاء|claim|نسبة|%/i, hint: 'احذف أي نص أو رقم أو ادعاء غير مدعوم بالمواصفات.' },
  { rx: /تكوين|composition|قص|crop/i, hint: 'أعد التكوين بحيث يكون المنتج بطل الكادر مع منطقة نص آمنة واضحة.' },
  { rx: /وضوح|visib|صغير/i, hint: 'كبّر المنتج في الكادر واجعله أوضح.' },
];

/** @returns {string} a concise corrective note for the next attempt */
export function buildCorrectiveNote(review) {
  const reasons = (review?.failure_reasons || []).filter(Boolean);
  const hints = new Set();
  for (const r of reasons) {
    for (const h of REASON_HINTS) if (h.rx.test(r)) hints.add(h.hint);
  }
  // Low individual scores also drive hints even when the text reason is vague.
  const s = review?.scores || {};
  if ((s.product_accuracy_score ?? 100) < 90) hints.add('ارفع تطابق المنتج مع المرجع (شكل/لون/مكوّنات).');
  if ((s.arabic_text_score ?? 100) < 85) hints.add('اكتب النص العربي بشكل صحيح ومقروء تمامًا.');
  if ((s.artifact_score ?? 100) < 85) hints.add('أزل التشوهات البصرية.');
  if ((s.claim_score ?? 100) < 95) hints.add('احذف أي ادعاء غير مدعوم.');

  const parts = [...hints];
  if (reasons.length) parts.unshift(`عالج تحديدًا: ${reasons.slice(0, 4).join(' / ')}`);
  return parts.join(' ').slice(0, 700) || 'حسّن الجودة العامة والتطابق مع المرجع.';
}
