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

const TEXT_LAYOUT_KEYS = ['HEADLINE_TOP', 'HEADLINE_BOTTOM', 'EDITORIAL_SPLIT', 'CENTERED_HERO', 'FEATURE_CALLOUTS', 'BOTTOM_CTA', 'SIDE_INFOGRAPHIC', 'MINIMAL_HERO', 'NONE'];
function defaultLayoutFor(angle, i) {
  if (/HERO/i.test(angle || '')) return i === 0 ? 'CENTERED_HERO' : 'HEADLINE_TOP';
  if (/FEATURE|BENEFIT/i.test(angle || '')) return 'FEATURE_CALLOUTS';
  if (/INFOGRAPHIC/i.test(angle || '')) return 'SIDE_INFOGRAPHIC';
  if (/FINAL_CTA|OFFER|DIRECT/i.test(angle || '')) return 'BOTTOM_CTA';
  if (/MACRO|DETAIL|MULTI_ANGLE|PACKAGING/i.test(angle || '')) return 'MINIMAL_HERO';
  if (/LIFESTYLE|PROBLEM/i.test(angle || '')) return 'HEADLINE_BOTTOM';
  return 'HEADLINE_TOP';
}

function baseItem(position, over = {}) {
  return {
    position,
    purpose: null, angle: null, scene: null, product_placement: 'المنتج بطل الكادر',
    camera_angle: '3/4', composition: null, background: null,
    headline: null, supporting_copy: null, cta: null,
    features: [], reference_priority: [], visual_style: null, reason: null,
    // enriched purpose fields (spec §6)
    creative_goal: null, marketing_angle: null, customer_question: null,
    visual_concept: null, camera_plan: null, scene_plan: null, product_position: null,
    copy_goal: null, text_layout: null,
    ...over,
  };
}

/**
 * @returns {Promise<{items:Array, source:'AI'|'TEMPLATE'}>}
 */
export async function buildCreativePlan({ project, product, dna, count, feedbackHints = null }) {
  const n = Math.max(1, Math.min(50, count || project.quantity || 1));
  const dnaObj = dna?.data || dna || emptyDnaSkeleton();
  const fb = feedbackHints && feedbackHints.total
    ? `تعلّم من تقييمات سابقة لنفس الفئة: زوايا ناجحة ${JSON.stringify((feedbackHints.byAngle || []).filter((x) => x.score > 0).slice(0, 4).map((x) => x.key))}؛ زوايا ضعيفة ${JSON.stringify((feedbackHints.byAngle || []).filter((x) => x.score < 0).slice(0, 3).map((x) => x.key))}؛ أسباب رفض متكررة ${JSON.stringify(feedbackHints.byReason || {})}. رجّح الناجح وتجنّب الضعيف بدون فرض.`
    : '';

  const ai = await callAiJson({
    system: `أنت Creative Strategist + Art Director للتجارة الإلكترونية في مصر (COD). صمّم خطة صور مدروسة لمنتج بعينه — مش صور عشوائية.
قواعد:
- لكل صورة سبب واضح وسؤال عميل تجيب عليه. لا تكرّر نفس الفكرة.
- PRODUCT_PAGE: تسلسل مترابط (عائلة حملة واحدة، خلفيات ونمط خط متقارب، لكن كل صورة غرضها مختلف). META_ADS: نوّع زوايا الرسالة.
- اختَر الزوايا المناسبة للمنتج ده فقط. ممنوع تفرض Before/After أو Lifestyle أو وجود أشخاص إذا مش مناسبين للمنتج.
- صف فقط عناصر مدعومة بالـ DNA/المواصفات. ممنوع اختراع أي تفصيلة في المنتج، ولا مقاسات، ولا محتويات علبة، ولا وظائف.
- إذا scale_confidence منخفض في الـ DNA، تجنّب لقطات تكشف الحجم (يد ممسكة/مقارنة حجم).
- النص "قليل جدًا": هوك واحد + سطر مساند اختياري + ليبلات قصيرة.`,
    user: `النوع: ${project.project_type}
عدد الصور المطلوب: ${n}
نمط: ${project.style_preset || '—'} | اللهجة: ${project.dialect} | كثافة النص: ${project.text_density} | الأشخاص: ${project.people_rule}${project.hijab_required ? ' (حجاب إلزامي)' : ''}
${project.plan_notes ? `تفضيلات المالك: ${String(project.plan_notes).slice(0, 300)}` : ''}
${fb}
Product DNA: ${JSON.stringify(dnaObj).slice(0, 2600)}
المنتج: ${product.name} | فئة: ${dnaObj.product_category || product.category || '—'}
المواصفات: ${(product.specifications || '—').slice(0, 900)}
الفوائد: ${(product.benefits || '—').slice(0, 900)}
حالات الاستخدام: ${(product.use_cases || '—').slice(0, 500)}
الجمهور: ${(product.target_audience || '—').slice(0, 400)}
مشاكل العميل: ${(product.problems || '—').slice(0, 400)}

أعد JSON: { "items": [ {
  "position": 1,
  "creative_goal": "هدف الصورة", "marketing_angle": "الزاوية (Hero/Problem/Feature/...)",
  "customer_question": "السؤال اللي بتجيب عليه", "angle": "<= marketing_angle بمفتاح إنجليزي>",
  "purpose": "وصف مختصر", "visual_concept": "الفكرة البصرية",
  "camera_plan": "زاوية وبُعد الكاميرا", "camera_angle": "front|side|3/4|top|back|macro|multi",
  "scene_plan": "المشهد والبيئة", "scene": "<= scene_plan مختصر>",
  "product_position": "مكان وحجم المنتج في الكادر", "product_placement": "<= product_position>",
  "composition": "التكوين ومكان النص الآمن", "background": "الخلفية",
  "copy_goal": "هدف النص", "text_layout": "HEADLINE_TOP|HEADLINE_BOTTOM|EDITORIAL_SPLIT|CENTERED_HERO|FEATURE_CALLOUTS|BOTTOM_CTA|SIDE_INFOGRAPHIC|MINIMAL_HERO|NONE",
  "features": ["ميزة مدعومة"], "reference_priority": ["front","3/4"],
  "visual_style": "الأسلوب البصري المناسب للفئة", "reason": "ليه الصورة دي في التسلسل"
} ] }  — بالضبط ${n} عنصر.`,
    maxTokens: 3600,
  });

  let items;
  let source;
  if (ai.ok && Array.isArray(ai.data?.items) && ai.data.items.length) {
    items = ai.data.items.slice(0, n).map((raw, i) => ({ ...baseItem(i + 1), ...raw, position: i + 1 }));
    while (items.length < n) items.push(baseItem(items.length + 1, deterministicPlan({ projectType: project.project_type, count: n })[items.length]));
    source = 'AI';
  } else {
    items = deterministicPlan({ projectType: project.project_type, count: n });
    source = 'TEMPLATE';
  }
  // normalise the layout key + fill the enriched fields from their short aliases
  for (const it of items) {
    if (!TEXT_LAYOUT_KEYS.includes(it.text_layout)) it.text_layout = defaultLayoutFor(it.angle, it.position - 1);
    it.customer_question = it.customer_question || it.customerQuestion || null;
    it.creative_goal = it.creative_goal || it.purpose || null;
    it.marketing_angle = it.marketing_angle || it.angle || null;
    it.scene = it.scene || it.scene_plan || null;
    it.product_placement = it.product_placement || it.product_position || 'المنتج بطل الكادر';
    it.camera_angle = it.camera_angle || it.camera_plan || '3/4';
  }
  return { items, source };
}

// ---------------------------------------------------------------------------
// PRE-GENERATION intelligence (spec §23) — catch concepts that contradict the
// Product DNA BEFORE spending money on generation. Deterministic; only ever
// tightens a scene, never invents one.
// ---------------------------------------------------------------------------
export function validatePlanConcepts({ items, dna, product }) {
  const d = dna?.data || dna || {};
  const claims = String(product?.allowed_claims || '').toLowerCase() + ' ' + String(product?.specifications || '').toLowerCase();
  const hasWaterproof = /waterproof|ماء|مقاوم للماء|watertight|ضد الماء/.test(claims);
  const hasMotor = /motor|موتور|محرك|كهرب|battery|بطاري|شحن/.test(String(product?.specifications || '').toLowerCase() + ' ' + JSON.stringify(d).toLowerCase());
  const scaleKnown = Number(d.scale_confidence) >= 55 || !!d.physical_scale;
  const packageKnown = !!d.packaging_appearance || /علبة|كرتون|صندوق|package|box|محتويات/.test(claims);
  const beforeAfterFits = /قبل|بعد|فرد|تجعد|تفتيح|تنظيف|إزالة|before|after|whiten|remove|clean|straighten/.test(claims + ' ' + String(product?.benefits || '').toLowerCase());

  const notes = [];
  for (const it of items) {
    const s = `${it.scene || ''} ${it.visual_concept || ''} ${it.scene_plan || ''} ${it.marketing_angle || ''} ${it.angle || ''}`.toLowerCase();
    const flag = (msg, fix) => { notes.push({ position: it.position, msg }); if (fix) Object.assign(it, fix); };

    if (/under\s*water|تحت الماء|غاطس|بحر|حمام سباحة/.test(s) && !hasWaterproof) {
      flag('مشهد تحت الماء بدون ادعاء مقاوم للماء', { scene: it.scene?.replace(/تحت الماء|غاطس/gi, 'قريب من الماء بأمان') || null, visual_concept: 'تجنّب غمر المنتج في الماء' });
    }
    if (/(motor|حركة آلية|يدور|دوران ذاتي|يتحرك لوحده)/.test(s) && !hasMotor) {
      flag('حركة آلية بدون موتور مؤكد في المنتج', { visual_concept: 'اعرض المنتج ثابتًا — بدون إيحاء بحركة آلية' });
    }
    if (/(dimension|مقاس|قياس|سم\b|cm\b|inch|بوصة|أبعاد)/.test(s) && !scaleKnown) {
      flag('عرض أبعاد/مقاسات غير مؤكدة', { visual_concept: 'بدون أرقام أبعاد؛ استخدم لقطة لا تكشف المقياس' });
    }
    if (/(BEFORE_AFTER|قبل.*بعد|before.*after)/i.test(s) && !beforeAfterFits) {
      flag('Before/After غير مناسب للمنتج ده', { angle: 'BENEFITS', marketing_angle: 'Benefits', text_layout: it.text_layout === 'HEADLINE_BOTTOM' ? 'FEATURE_CALLOUTS' : it.text_layout, visual_concept: 'أبرز فائدة واضحة بدل مقارنة قبل/بعد' });
    }
    if (/(محتويات العلبة|package contents|ملحقات|accessor)/.test(s) && !packageKnown) {
      flag('محتويات علبة غير معروفة', { visual_concept: 'اعرض المنتج نفسه فقط بوضوح، بدون اختراع ملحقات' });
    }
    if ((d.scale_confidence != null && Number(d.scale_confidence) < 45) && /(يد ممسكة|held in hand|hand holding|مقارنة حجم|بجانب)/.test(s)) {
      flag('لقطة تكشف المقياس مع scale_confidence منخفض', { scene: 'لقطة منتج مقرّبة على خلفية نظيفة بدون مرجع حجم', product_placement: 'المنتج يملأ الكادر' });
    }
  }
  return { items, notes };
}
