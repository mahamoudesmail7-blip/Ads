// AI Creative Factory — RegenerationService.
//
// A retry is NEVER a blind repeat call (spec §16). From the classified
// failure code + the judge's reasons, build a precise corrective note that
// names the specific reference image to preserve from, and gets folded into
// the next prompt as "تصحيحات إلزامية".
const CODE_FIX = {
  PRODUCT_SHAPE_WRONG: 'الشكل/الهيكل اختلف عن المرجع. طابِق شكل المنتج ونِسبه حرفيًا من REFERENCE 1.',
  PRODUCT_COLOR_WRONG: 'اللون اختلف. استخدم نفس ألوان المنتج بالضبط كما في الصور المرجعية، بدون أي تعديل لوني.',
  MISSING_DETAIL: 'تفصيلة مهمة ناقصة من المنتج. أعِد كل التفاصيل المرئية في المراجع (أزرار، منافذ، ملصقات، ملمس).',
  EXTRA_COMPONENT: 'أُضيف مكوّن غير موجود في المنتج. احذف أي زر/شاشة/لمبة/منفذ/ملحق مش موجود في المراجع.',
  WRONG_ORIENTATION: 'اتجاه المنتج غلط. ضَع المنتج في وضعه الصحيح كما يُستخدم فعليًا.',
  BAD_HAND: 'الأيدي غير واقعية. إمّا يد واحدة طبيعية تمامًا بأصابع صحيحة وحجم صحيح ملامسة للمنتج، أو احذف الأشخاص واعرض المنتج وحده.',
  WRONG_SCALE: 'مقياس المنتج غير واقعي. اضبط نسبة حجم المنتج للبيئة/اليد، أو استخدم لقطة مقرّبة لا تكشف المقياس.',
  BAD_COMPOSITION: 'أعِد التكوين: المنتج بطل الكادر بوضوح، ومنطقة نص آمنة واضحة، بدون قصّ للمنتج.',
  VISUAL_ARTIFACT: 'أزِل أي تشوّه/تكرار/حواف ذائبة/رموز عشوائية في المنتج أو الخلفية.',
  AI_LOOK: 'الصورة تبدو AI. اجعلها تصوير منتج تجاري واقعي: إضاءة طبيعية، خامات حقيقية، ظلال وانعكاسات معقولة، بدون لمعان CGI أو نيون أو بيئة مستقبلية.',
  TEXT_IN_IMAGE: 'ظهر نص/حروف/شعار في الصورة. لا تكتب أي نص أو أرقام أو شعار إطلاقًا؛ اترك منطقة النص فارغة نظيفة.',
  CLAIM_ISSUE: 'ظهر ادعاء/رقم غير مدعوم. احذف أي نص أو رمز يوحي بادعاء غير مذكور في المواصفات.',
  WRONG_USAGE: 'طريقة استخدام المنتج غير صحيحة. صوّره وهو يُستخدم بالطريقة الصحيحة الواقعية فقط.',
};

const REASON_HINTS = [
  { rx: /لون|colou?r/i, code: 'PRODUCT_COLOR_WRONG' },
  { rx: /شكل|هيكل|نِسب|نسب|proportion|shape/i, code: 'PRODUCT_SHAPE_WRONG' },
  { rx: /زر|button|شاشة|screen|منفذ|port|لمبة|led|ملصق|label|شعار|logo/i, code: 'EXTRA_COMPONENT' },
  { rx: /ناقص|مفقود|missing/i, code: 'MISSING_DETAIL' },
  { rx: /يد|أصابع|hand|finger/i, code: 'BAD_HAND' },
  { rx: /تشوه|artifact|distort|deform|ملتوي|تكرار|duplicate/i, code: 'VISUAL_ARTIFACT' },
  { rx: /نص|حروف|كتابة|text|typo|arabic/i, code: 'TEXT_IN_IMAGE' },
  { rx: /ادعاء|claim|نسبة|%/i, code: 'CLAIM_ISSUE' },
  { rx: /مقياس|حجم|scale|size/i, code: 'WRONG_SCALE' },
  { rx: /تكوين|composition|قص|crop/i, code: 'BAD_COMPOSITION' },
  { rx: /استخدام|usage|بالمقلوب|اتجاه|orientation/i, code: 'WRONG_ORIENTATION' },
  { rx: /AI|ذكاء اصطناعي|بلاستيك|نيون|CGI|مبالغ/i, code: 'AI_LOOK' },
];

/** @returns {string} concise corrective note for the next attempt */
export function buildCorrectiveNote(review) {
  const reasons = (review?.failure_reasons || []).filter(Boolean);
  const codes = new Set();
  if (review?.failure_code && review.failure_code !== 'OK') codes.add(review.failure_code);
  for (const r of reasons) for (const h of REASON_HINTS) if (h.rx.test(r)) codes.add(h.code);

  const s = review?.scores || {};
  if ((s.product_accuracy_score ?? 100) < 90) codes.add('PRODUCT_SHAPE_WRONG');
  if ((review?.realism ?? 100) < 72 || review?.looks_ai) codes.add('AI_LOOK');
  if ((s.artifact_score ?? 100) < 75) codes.add('VISUAL_ARTIFACT');
  if ((s.claim_score ?? 100) < 95) codes.add('CLAIM_ISSUE');
  if (review?.identity_mismatch) { codes.add('PRODUCT_SHAPE_WRONG'); codes.add('PRODUCT_COLOR_WRONG'); }

  const fixes = [...codes].map((c) => CODE_FIX[c]).filter(Boolean);
  const parts = [];
  if (reasons.length) parts.push(`عالج تحديدًا: ${reasons.slice(0, 3).join(' / ')}.`);
  parts.push(...fixes);
  parts.push('حافظ على هوية المنتج من الصور المرجعية كأولوية قصوى.');
  return parts.join(' ').slice(0, 900);
}
