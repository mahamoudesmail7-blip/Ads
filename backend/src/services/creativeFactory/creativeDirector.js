// AI Creative Factory — CreativeDirectorService.
//
// Turns a plan item + copy + DNA into a STRUCTURED visual direction
// (subject hierarchy, product size in frame, angle, photography type,
// lens concept, lighting, environment, background, depth, shadows,
// reflections, supporting objects, people, infographic elements, text safe
// area, reference priority, continuity rules). For PRODUCT_PAGE projects it
// also carries visual-continuity fields shared across every image.
import { callAiJson } from './textAi.js';

const CONTINUITY_KEYS = ['background_family', 'typography_style', 'spacing', 'visual_tone', 'lighting_family', 'icon_style', 'product_scale_style'];

export function defaultContinuity(project) {
  return {
    background_family: 'خلفية فاتحة نظيفة بنفس درجة اللون',
    typography_style: `عربي واضح، ${project?.text_density === 'MEDIUM' ? 'متوسط' : 'قليل جدًا'}`,
    spacing: 'هوامش مريحة ومنطقة نص آمنة ثابتة',
    visual_tone: project?.style_preset || 'Egyptian E-commerce',
    lighting_family: 'إضاءة استوديو ناعمة',
    icon_style: 'أيقونات خطية بسيطة',
    product_scale_style: 'المنتج يملأ 55–70% من الكادر',
  };
}

function fallbackDirection(item, project) {
  return {
    subject_hierarchy: ['المنتج', 'الهوك النصي', 'عناصر مساندة'],
    product_size_in_frame: '60%',
    product_angle: item.camera_angle || '3/4',
    photography_type: 'product studio',
    lens_concept: '50mm، منظور طبيعي',
    lighting: 'إضاءة استوديو ناعمة مع ظل خفيف',
    environment: item.background || 'خلفية موحدة نظيفة',
    background: item.background || 'لون واحد هادئ',
    depth: 'عمق ميدان متوسط',
    shadows: 'ظل ناعم أسفل المنتج',
    reflections: 'انعكاس خفيف على السطح',
    supporting_objects: [],
    people: project?.people_rule === 'NONE' ? 'بدون أشخاص' : project?.people_rule,
    infographic_elements: item.angle === 'FEATURE_INFOGRAPHIC' ? ['أيقونات مواصفات', 'أسهم توضيح'] : [],
    text_safe_area: 'أعلى الكادر',
    reference_priority: Array.isArray(item.reference_priority) ? item.reference_priority : ['Front', '3/4'],
    continuity_rules: 'التزام كامل بعائلة الخلفية والإضاءة ونمط الخط',
    source: 'TEMPLATE',
  };
}

/** @returns {Promise<{direction:object, continuity:object}>} */
export async function directItem({ item, copy, product, dna, project, continuity }) {
  const cont = continuity || defaultContinuity(project);
  const ai = await callAiJson({
    system: 'أنت مدير تصوير وإخراج فني. أعطِ توجيهًا بصريًا منظمًا لصورة واحدة، متسقًا مع قواعد الاستمرارية المعطاة. لا تضف تفاصيل غير موجودة في DNA المنتج.',
    user: `عنصر الخطة: ${JSON.stringify({ position: item.position, purpose: item.purpose, angle: item.angle, scene: item.scene, camera_angle: item.camera_angle, composition: item.composition, background: item.background })}
النص: ${JSON.stringify({ hook: copy?.hook, supporting_line: copy?.supporting_line, cta: copy?.cta })}
Product DNA: ${JSON.stringify(dna?.data || dna || {}).slice(0, 1800)}
نمط: ${project?.style_preset || '—'} | أشخاص: ${project?.people_rule}${project?.hijab_required ? ' (حجاب إلزامي)' : ''}
قواعد الاستمرارية: ${JSON.stringify(cont)}
أعد JSON بالمفاتيح: subject_hierarchy, product_size_in_frame, product_angle, photography_type, lens_concept, lighting, environment, background, depth, shadows, reflections, supporting_objects, people, infographic_elements, text_safe_area, reference_priority, continuity_rules`,
    maxTokens: 1100,
  });

  if (ai.ok && ai.data && typeof ai.data === 'object') {
    return { direction: { ...fallbackDirection(item, project), ...ai.data, source: 'AI' }, continuity: cont };
  }
  return { direction: fallbackDirection(item, project), continuity: cont };
}

export { CONTINUITY_KEYS };
