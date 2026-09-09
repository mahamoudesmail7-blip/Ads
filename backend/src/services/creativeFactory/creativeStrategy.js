// AI Creative Factory — CreativeStrategyService.
//
// (1) recommendImageCount(): how many images this project should have, with a
//     short reason — from product complexity, project type, meaningful
//     feature count and reference coverage. Owner can override.
// (2) buildCreativePlan(): a CONNECTED plan — one structured card per image.
//     For PRODUCT_PAGE the cards complement each other (a real sequence); for
//     META_ADS they maximise angle diversity. AI when configured; otherwise a
//     deterministic template from taxonomy.js (never a blank plan).
import { callAiJson } from './textAi.js';
import {
  PRODUCT_PAGE_CATEGORIES, META_AD_ANGLES, emptyDnaSkeleton,
} from './taxonomy.js';

function meaningfulFeatureCount(product, dna) {
  const fromText = String(product?.benefits || '').split(/[,،\n;•\-]+/).map((s) => s.trim()).filter((s) => s.length > 2).length;
  const fromSpecs = String(product?.specifications || '').split(/[,،\n;•\-]+/).map((s) => s.trim()).filter((s) => s.length > 2).length;
  const fromDna = Array.isArray(dna?.features_visible_in_reference) ? dna.features_visible_in_reference.length : 0;
  return Math.max(fromText, Math.round((fromSpecs + fromDna) / 2), 1);
}

/** @returns {Promise<{count:number, reason:string, min:number, max:number, source:'AI'|'HEURISTIC'}>} */
export async function recommendImageCount({ product, dna, projectType, referenceCount = 0 }) {
  const feats = meaningfulFeatureCount(product, dna);
  const complexity = Math.min(3, 1 + Math.floor(feats / 4)); // 1..3
  const base = {
    PRODUCT_PAGE: 5 + complexity + (referenceCount >= 5 ? 1 : 0),
    META_ADS: 4 + complexity,
    SOCIAL: 3 + Math.floor(complexity / 2),
    RETARGETING: 3,
    VARIATIONS: 3,
    CUSTOM: 3,
  }[projectType] || 4;
  const heuristic = Math.max(1, Math.min(20, base));

  const ai = await callAiJson({
    system: 'أنت مدير إبداع للتجارة الإلكترونية في مصر. اقترح عدد الصور المناسب لهذا المشروع فقط، مع سبب قصير جدًا بالعربية المصرية.',
    user: `النوع: ${projectType}
عدد الفوائد/المزايا ذات المعنى: ${feats}
عدد الصور المرجعية المتاحة: ${referenceCount}
المواصفات: ${(product?.specifications || '—').slice(0, 600)}
الفوائد: ${(product?.benefits || '—').slice(0, 600)}
أعد JSON: { "count": <رقم من 1 إلى 20>, "reason": "<جملة قصيرة>" }`,
    maxTokens: 300,
  });

  if (ai.ok && Number.isFinite(Number(ai.data?.count))) {
    const count = Math.max(1, Math.min(20, Math.round(Number(ai.data.count))));
    return { count, reason: String(ai.data.reason || 'مبني على تعقيد المنتج ونوع المشروع.').slice(0, 200), min: 1, max: 20, source: 'AI' };
  }
  return {
    count: heuristic,
    reason: `مبني على ${feats} ميزة ذات معنى و${referenceCount} صورة مرجعية لنوع ${projectType}.`,
    min: 1, max: 20, source: 'HEURISTIC',
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------
function deterministicPlan({ projectType, count }) {
  const n = Math.max(1, count);
  if (projectType === 'PRODUCT_PAGE') {
    // A sensible connected order; take the first n, always leading with HERO
    // and (when n>2) ending with FINAL_CTA.
    const order = ['HERO', 'PROBLEM', 'PROBLEM_SOLUTION', 'DEMONSTRATION', 'BENEFITS', 'FEATURE_INFOGRAPHIC', 'MULTI_ANGLE', 'MACRO_DETAILS', 'LIFESTYLE', 'HOW_TO_USE', 'OBJECTION', 'PRODUCT_PACKAGING', 'BEFORE_AFTER', 'FINAL_CTA'];
    const picked = order.slice(0, n);
    if (n > 2 && !picked.includes('FINAL_CTA')) picked[picked.length - 1] = 'FINAL_CTA';
    return picked.map((key, i) => {
      const cat = PRODUCT_PAGE_CATEGORIES.find((c) => c.key === key) || { key, label: key, purpose: '' };
      return baseItem(i + 1, {
        purpose: cat.label, angle: key, reason: cat.purpose,
        scene: `${cat.purpose} — المنتج بارز وواضح`, camera_angle: key === 'MULTI_ANGLE' ? 'زوايا متعددة' : '3/4',
        composition: 'المنتج في المنتصف، مساحة نص آمنة أعلى أو أسفل',
        background: 'خلفية موحدة نظيفة ضمن نفس عائلة الألوان لباقي الصور',
        visual_style: 'اتساق بصري كامل مع باقي صور الصفحة',
      });
    });
  }
  // META_ADS / SOCIAL / RETARGETING / others: diversify angles.
  const angles = META_AD_ANGLES.slice();
  return Array.from({ length: n }, (_, i) => {
    const angle = angles[i % angles.length];
    return baseItem(i + 1, {
      purpose: `إعلان — ${angle}`, angle, reason: `تنويع زاوية الرسالة (${angle}) لتقليل تشابه الكرياتيفات`,
      scene: `زاوية ${angle} تبرز المنتج بوضوح`, camera_angle: '3/4',
      composition: 'المنتج بطل الكادر، نص قليل جدًا في منطقة آمنة',
      background: 'خلفية بسيطة عالية التباين',
      visual_style: 'إعلان أداء جريء وواضح',
    });
  });
}

function baseItem(position, over = {}) {
  return {
    position,
    purpose: null, angle: null, scene: null, product_placement: 'المنتج بطل الكادر',
    camera_angle: '3/4', composition: null, background: null,
    headline: null, supporting_copy: null, cta: null,
    features: [], reference_priority: [], visual_style: null, reason: null,
    ...over,
  };
}

/**
 * @returns {Promise<{items:Array, source:'AI'|'TEMPLATE'}>}
 */
export async function buildCreativePlan({ project, product, dna, count }) {
  const n = Math.max(1, Math.min(50, count || project.quantity || 1));
  const dnaObj = dna?.data || dna || emptyDnaSkeleton();

  const ai = await callAiJson({
    system: `أنت مدير إبداع (Creative Director) للتجارة الإلكترونية في مصر (الدفع عند الاستلام). صمّم خطة صور مترابطة.
- لو النوع PRODUCT_PAGE: الصور تكمّل بعضها كتسلسل (ليست تكرارًا لنفس الفكرة).
- لو النوع META_ADS: نوّع زوايا الرسالة قدر الإمكان، تجنّب صور متشابهة.
- صف فقط عناصر مدعومة بالـ DNA/المواصفات. لا تخترع تفاصيل في المنتج.
- النص على الصورة "قليل جدًا": هوك قوي كبير + سطر مساند اختياري.`,
    user: `النوع: ${project.project_type}
عدد الصور المطلوب: ${n}
نمط التصميم: ${project.style_preset || '—'} | اللهجة: ${project.dialect} | كثافة النص: ${project.text_density} | الأشخاص: ${project.people_rule}${project.hijab_required ? ' (حجاب إلزامي)' : ''}
Product DNA: ${JSON.stringify(dnaObj).slice(0, 2500)}
المنتج: ${product.name} | ${product.category || ''}
المواصفات: ${(product.specifications || '—').slice(0, 900)}
الفوائد: ${(product.benefits || '—').slice(0, 900)}
حالات الاستخدام: ${(product.use_cases || '—').slice(0, 500)}
الجمهور: ${(product.target_audience || '—').slice(0, 400)}
مشاكل العميل: ${(product.problems || '—').slice(0, 400)}

أعد JSON: { "items": [ {
  "position": 1, "purpose": "...", "angle": "...", "scene": "...",
  "product_placement": "...", "camera_angle": "...", "composition": "...",
  "background": "...", "headline": "...", "supporting_copy": "...", "cta": "...",
  "features": ["..."], "reference_priority": ["Front","3/4"], "visual_style": "...",
  "reason": "لماذا هذه الصورة موجودة في التسلسل"
} ] }  — بالضبط ${n} عنصر.`,
    maxTokens: 3200,
  });

  if (ai.ok && Array.isArray(ai.data?.items) && ai.data.items.length) {
    const items = ai.data.items.slice(0, n).map((raw, i) => ({ ...baseItem(i + 1), ...raw, position: i + 1 }));
    while (items.length < n) items.push(baseItem(items.length + 1, deterministicPlan({ projectType: project.project_type, count: n })[items.length]));
    return { items, source: 'AI' };
  }
  return { items: deterministicPlan({ projectType: project.project_type, count: n }), source: 'TEMPLATE' };
}
