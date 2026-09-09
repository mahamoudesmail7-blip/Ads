// AI Creative Factory — MarketingCopyService.
//
// Generates Egyptian-Arabic marketing copy for ONE creative BEFORE image
// generation. Concise; strong big headline; no crowded text; no unsupported
// features / fake percentages / fake certifications / fake reviews / invented
// measurements / medical claims (unless explicitly supported) / guaranteed
// results. The copy is stored SEPARATELY from the final generation prompt
// (spec) so it can be edited on its own and later re-rendered as real text.
import { callAiJson } from './textAi.js';

const SYSTEM = `أنت كاتب إعلانات تجارة إلكترونية مصري محترف (COD). اكتب نصًا قصيرًا قويًا للصورة.
ممنوع: مزايا غير مدعومة، نِسب مئوية مخترعة، شهادات وهمية، تقييمات عملاء مُختلقة، مقاسات مخترعة، ادعاءات طبية غير مدعومة، ضمان نتائج غير مؤكد.
مطلوب: هوك كبير قصير + سطر مساند اختياري + CTA واضح. لهجة مصرية بسيطة.`;

function fallbackCopy(item, product) {
  const name = product?.name || 'المنتج';
  const benefit = String(product?.benefits || '').split(/[,،\n;]+/).map((s) => s.trim()).filter(Boolean)[0];
  return {
    hook: item.headline || (benefit ? benefit.slice(0, 40) : `${name} — الحل العملي`),
    supporting_line: item.supporting_copy || null,
    feature_callouts: Array.isArray(item.features) ? item.features.slice(0, 3) : [],
    cta: item.cta || 'اطلب دلوقتي',
    headline: item.headline || null,
    subtitle: null,
    alignment: 'center',
    priority: 'HEADLINE_FIRST',
    safe_area: 'top',
    source: 'TEMPLATE',
  };
}

/** @returns {Promise<object>} copy object (not yet claim-guarded) */
export async function generateCopyForItem({ item, product, project, dna }) {
  const ai = await callAiJson({
    system: SYSTEM,
    user: `الصورة رقم ${item.position} — الغرض: ${item.purpose || '—'} | الزاوية: ${item.angle || '—'}
المشهد: ${item.scene || '—'}
المنتج: ${product?.name} | ${product?.category || ''}
الفوائد المعتمدة: ${(product?.benefits || '—').slice(0, 700)}
المواصفات: ${(product?.specifications || '—').slice(0, 700)}
الادعاءات المسموح بها: ${(product?.allowed_claims || '—').slice(0, 400)}
كثافة النص: ${project?.text_density || 'MINIMAL'} | اللهجة: ${project?.dialect || 'egyptian'}
أعد JSON: {
 "hook": "...", "supporting_line": "... أو null", "feature_callouts": ["..."],
 "cta": "...", "headline": "...", "subtitle": "... أو null",
 "alignment": "center|right|left", "priority": "HEADLINE_FIRST", "safe_area": "top|bottom|center"
}`,
    maxTokens: 600,
  });

  if (ai.ok && ai.data && typeof ai.data === 'object' && (ai.data.hook || ai.data.headline)) {
    return {
      hook: ai.data.hook || ai.data.headline || null,
      supporting_line: ai.data.supporting_line || null,
      feature_callouts: Array.isArray(ai.data.feature_callouts) ? ai.data.feature_callouts.slice(0, 4) : [],
      cta: ai.data.cta || 'اطلب دلوقتي',
      headline: ai.data.headline || ai.data.hook || null,
      subtitle: ai.data.subtitle || null,
      alignment: ai.data.alignment || 'center',
      priority: ai.data.priority || 'HEADLINE_FIRST',
      safe_area: ai.data.safe_area || 'top',
      source: 'AI',
    };
  }
  return fallbackCopy(item, product);
}
