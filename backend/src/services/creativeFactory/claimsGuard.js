// AI Creative Factory — Claim Guard.
//
// Every factual statement used in a hook / benefit / on-image text / prompt
// must map to the product's specs, approved benefits or an allowed claim, OR
// be clearly non-factual marketing language. Unsupported claims are flagged
// BEFORE image generation and rewritten / stripped. Deterministic first (no
// AI needed); an optional AI pass only refines wording.
import { callAiJson } from './textAi.js';

// Phrases that are unsupported unless they literally appear in the product's
// allowed claims / specs. Egyptian-Arabic + English.
const RED_FLAGS = [
  { rx: /نتيج[ةه]\s*مضمون[ةه]|مضمون\s*100|ضمان\s*الشفاء|علاج\s*نهائي|يشفي|يعالج\s+تمامًا/i, reason: 'ادعاء نتيجة/شفاء مضمون غير مدعوم' },
  { rx: /\b\d{1,3}\s*%/, reason: 'نسبة مئوية رقمية — لازم تكون مذكورة في المواصفات' },
  { rx: /FDA|إف\s*دي\s*إيه|شهادة\s*(؟:طبية|دولية)|معتمد\s*طبيًا|certified|clinically\s*proven/i, reason: 'شهادة/اعتماد غير مُثبت' },
  { rx: /آلاف\s*العملاء|أكثر\s*من\s*\d+\s*عميل|تقييم\s*\d(?:\.\d)?\s*نجوم|reviews?\b|أفضل\s*منتج\s*في\s*مصر/i, reason: 'دليل اجتماعي/تقييمات مُختلقة' },
  { rx: /يخس(?:س|ك)\s*\d+\s*كيلو|ينبت\s*الشعر|يزيل\s*التجاعيد\s*نهائيًا/i, reason: 'ادعاء طبي/تجميلي غير مدعوم' },
  { rx: /رقم\s*1|الأول\s*عالميًا|#1\b/i, reason: 'ادعاء تفوق مطلق غير مُثبت' },
];

function corpusFrom(product) {
  return [
    product?.specifications, product?.benefits, product?.allowed_claims,
    product?.description, product?.use_cases,
  ].filter(Boolean).join(' \n ').toLowerCase();
}

function normalize(s) {
  return String(s || '').replace(/[ً-ٟـ]/g, '').replace(/[إأآ]/g, 'ا').toLowerCase();
}

/** Deterministic scan. Returns { status, issues:[{text,field,reason}], safeTexts } */
export function scanClaims({ items, product }) {
  const corpus = normalize(corpusFrom(product));
  const forbidden = normalize(product?.forbidden_claims || '');
  const issues = [];

  for (const { field, text } of items || []) {
    if (!text) continue;
    const t = String(text);
    for (const flag of RED_FLAGS) {
      if (flag.rx.test(t)) {
        // A percentage / number that IS present verbatim in the specs corpus is fine.
        if (flag.reason.includes('نسبة') && numbersIn(t).some((n) => corpus.includes(n))) continue;
        issues.push({ field, text: t, reason: flag.reason });
      }
    }
    // Explicit forbidden phrases from the product profile.
    if (forbidden) {
      for (const phrase of forbidden.split(/[,،\n;]+/).map((x) => x.trim()).filter((x) => x.length > 2)) {
        if (normalize(t).includes(phrase)) issues.push({ field, text: t, reason: `عبارة ممنوعة في ملف المنتج: "${phrase}"` });
      }
    }
  }
  return {
    status: issues.length ? 'BLOCKED' : 'PASSED',
    issues,
    checkedAt: new Date().toISOString(),
  };
}

function numbersIn(s) { return (String(s).match(/\d+(?:\.\d+)?/g) || []); }

/**
 * Full guard for one project item's copy. Deterministic scan; if it BLOCKS
 * and AI is available, ask AI to rewrite the offending lines using ONLY
 * supported language, then re-scan. Returns
 * { status:'PASSED'|'REWRITTEN'|'BLOCKED', copy, issues }.
 */
export async function guardCopy({ copy, product }) {
  const fields = ['hook', 'supporting_line', 'headline', 'subtitle', 'cta'];
  const items = fields.map((f) => ({ field: f, text: copy?.[f] })).filter((x) => x.text);
  const calls = Array.isArray(copy?.feature_callouts) ? copy.feature_callouts : [];
  calls.forEach((c, i) => items.push({ field: `feature_callouts[${i}]`, text: c }));

  let scan = scanClaims({ items, product });
  if (scan.status === 'PASSED') return { status: 'PASSED', copy, issues: [] };

  const ai = await callAiJson({
    system: 'أنت مدقق امتثال إعلاني. أعد صياغة النصوص المخالفة بحيث تستخدم فقط لغة تسويقية مدعومة بالمواصفات/الفوائد المتاحة، بدون أرقام أو نسب أو شهادات أو تقييمات مُختلقة. حافظ على قوة الرسالة والاختصار.',
    user: `المواصفات المتاحة: ${product?.specifications || '—'}
الفوائد المعتمدة: ${product?.benefits || '—'}
الادعاءات المسموح بها: ${product?.allowed_claims || '—'}
النص الحالي (JSON): ${JSON.stringify(copy)}
المخالفات: ${JSON.stringify(scan.issues)}
أعد JSON بنفس مفاتيح النص الحالي مع الصياغة المصححة فقط.`,
    maxTokens: 900,
  });

  if (ai.ok && ai.data && typeof ai.data === 'object') {
    const rewritten = { ...copy, ...ai.data };
    const items2 = fields.map((f) => ({ field: f, text: rewritten?.[f] })).filter((x) => x.text);
    (Array.isArray(rewritten.feature_callouts) ? rewritten.feature_callouts : []).forEach((c, i) => items2.push({ field: `feature_callouts[${i}]`, text: c }));
    const scan2 = scanClaims({ items: items2, product });
    if (scan2.status === 'PASSED') return { status: 'REWRITTEN', copy: rewritten, issues: scan.issues };
    return { status: 'BLOCKED', copy: rewritten, issues: scan2.issues };
  }

  // No AI to rewrite → strip the offending fields rather than ship a bad claim.
  const stripped = { ...copy };
  for (const iss of scan.issues) {
    if (iss.field && iss.field in stripped) stripped[iss.field] = null;
  }
  const rescanned = scanClaims({ items: fields.map((f) => ({ field: f, text: stripped?.[f] })).filter((x) => x.text), product });
  return { status: rescanned.status === 'PASSED' ? 'REWRITTEN' : 'BLOCKED', copy: stripped, issues: scan.issues };
}
