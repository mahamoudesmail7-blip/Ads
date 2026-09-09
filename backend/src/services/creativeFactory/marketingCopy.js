// AI Creative Factory — MarketingCopyService.
//
// Egyptian-Arabic copy for ONE creative, BEFORE image generation. Claude
// drafts SEVERAL candidate hooks, scores them (clarity / specificity /
// product relevance / Egyptian naturalness / curiosity / benefit / length)
// and returns the strongest — the owner never has to choose (spec §11/§12).
// Default is minimal: 1 hook + 0–1 support line + 2–4 short feature labels +
// CTA only when it fits. Stored SEPARATELY from the prompt; our text engine
// renders the EXACT string, so the image model never draws Arabic.
import { callAiJson } from './textAi.js';

const GENERIC_BAN = ['الحل المثالي', 'أفضل جودة', 'منتج لا غنى عنه', 'الأفضل على الإطلاق', 'جودة عالية'];

const SYSTEM = `أنت كاتب إعلانات تجارة إلكترونية مصري محترف (COD). لكل صورة:
1) اكتب 4 هوكات مرشّحة قصيرة بالعامية المصرية، محددة للمنتج ده بالذات (مش عبارات عامة).
2) قيّم كل هوك 0..10 على: الوضوح، التحديد، صلة المنتج، طبيعية اللهجة المصرية، الفضول، توصيل الفائدة، الطول (الأقصر أفضل).
3) اختَر الأقوى.
ممنوع: مزايا غير مدعومة، نِسب مئوية مخترعة، شهادات وهمية، تقييمات عملاء مُختلقة، مقاسات مخترعة، ادعاءات طبية غير مدعومة، ضمان نتائج، وعبارات مبتذلة زي «الحل المثالي / أفضل جودة».
النص على الصورة قليل جدًا: هوك واحد كبير + (اختياري) سطر مساند + 0..4 ليبل قصير جدًا + CTA لو مناسب.`;

function fallbackCopy(item, product) {
  const name = product?.name || 'المنتج';
  const feats = String(product?.benefits || product?.specifications || '')
    .split(/[,،\n;•\-]+/).map((s) => s.trim()).filter((s) => s.length > 2);
  return {
    hook: item.headline || (feats[0] ? feats[0].slice(0, 42) : `${name} — بشكل عملي`),
    supportingLine: item.supportingCopy || null,
    featureLabels: feats.slice(0, 3).map((f) => f.split(/\s+/).slice(0, 3).join(' ')),
    cta: item.cta || (item.angle && /CTA|FINAL/i.test(item.angle) ? 'اطلب دلوقتي' : null),
    headline: item.headline || null,
    subtitle: null,
    candidates: [],
    source: 'TEMPLATE',
  };
}

/** @returns {Promise<object>} copy object (not yet claim-guarded) */
export async function generateCopyForItem({ item, product, project, dna }) {
  const ai = await callAiJson({
    system: SYSTEM,
    user: `الصورة رقم ${item.position} — الغرض: ${item.purpose || '—'} | الزاوية: ${item.angle || '—'} | سؤال العميل: ${item.customerQuestion || '—'}
المشهد: ${item.scene || '—'}
هدف النص (copyGoal): ${item.copyGoal || 'توصيل الفكدة بأقصر جملة'}
المنتج: ${product?.name} | فئة: ${dna?.product_category || product?.category || '—'}
الفوائد المعتمدة: ${(product?.benefits || '—').slice(0, 700)}
المواصفات: ${(product?.specifications || '—').slice(0, 700)}
الادعاءات المسموح بها: ${(product?.allowed_claims || '—').slice(0, 300)}
كثافة النص: ${project?.text_density || 'MINIMAL'} | اللهجة: ${project?.dialect || 'egyptian'}
أعد JSON:
{
 "candidates": [ { "hook": "...", "scores": {"clarity":0,"specificity":0,"relevance":0,"natural":0,"curiosity":0,"benefit":0,"length":0}, "total": 0 } ],
 "hook": "<أقوى هوك>", "supportingLine": "... أو null",
 "featureLabels": ["ليبل قصير", "..."],
 "cta": "... أو null", "headline": "<= الهوك>", "subtitle": "... أو null"
}`,
    maxTokens: 900,
  });

  if (ai.ok && ai.data && (ai.data.hook || ai.data.headline)) {
    let hook = String(ai.data.hook || ai.data.headline || '').trim();
    // guard against a banned generic phrase slipping through
    if (GENERIC_BAN.some((g) => hook.includes(g))) {
      const alt = (ai.data.candidates || []).map((c) => c.hook).find((hk) => hk && !GENERIC_BAN.some((g) => hk.includes(g)));
      if (alt) hook = alt.trim();
    }
    return {
      hook,
      supportingLine: ai.data.supportingLine || null,
      featureLabels: (Array.isArray(ai.data.featureLabels) ? ai.data.featureLabels : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 4),
      cta: ai.data.cta || null,
      headline: ai.data.headline || hook,
      subtitle: ai.data.subtitle || null,
      candidates: Array.isArray(ai.data.candidates) ? ai.data.candidates.slice(0, 6) : [],
      source: 'AI',
    };
  }
  return fallbackCopy(item, product);
}
