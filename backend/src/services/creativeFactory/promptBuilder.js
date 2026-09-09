// AI Creative Factory — PromptBuilderService.
//
// Assembles the FINAL image-generation prompt programmatically (no AI call
// here — it's deterministic composition) from:
//   Product DNA + Product Lock rules + Creative Plan + approved copy +
//   Creative Director direction + style preset + project rules + Claim Guard
//   output.
// The owner normally never sees this; an advanced drawer ("عرض البرومبت")
// can reveal it. Prompt version history lives on cf_generation_attempts.
import { emptyDnaSkeleton } from './taxonomy.js';

const LOCK_RULES = {
  STRICT: 'حافظ بدقة قصوى على هوية المنتج: نفس الشكل، الألوان، النِسب، المكوّنات المرئية، عدد/ترتيب الأزرار، شكل الشاشة، المنافذ، الملحقات، الشعارات، والعبوة. لا تغيّر أي تفصيلة تصميمية.',
  BALANCED: 'حافظ على هوية المنتج الأساسية (الشكل، الألوان، المكوّنات الرئيسية) مع حرية بسيطة في الإضاءة والخلفية والتكوين.',
  CREATIVE: 'حافظ على فكرة المنتج ولونه العام؛ يُسمح بتفسير فني أوسع للمشهد والأسلوب.',
};

const STYLE_PRESET_PROMPT = {
  APPLE_CLEAN: 'minimalist Apple-style product photography, seamless light background, crisp soft light, generous negative space',
  PREMIUM_STUDIO: 'premium studio product photography, controlled gradient background, soft key light + rim light',
  EGY_ECOM: 'high-converting Egyptian e-commerce product shot, bright even lighting, simple high-contrast background, bold clear layout',
  LUXURY: 'luxury product photography, deep tones, dramatic directional light, refined reflections',
  LIFESTYLE: 'authentic lifestyle scene, natural light, real-use context, shallow depth of field',
  BEAUTY: 'clean beauty product photography, soft diffused light, pastel or white background, dewy highlights',
  AUTOMOTIVE: 'automotive-grade product photography, glossy surfaces, strong specular highlights, dark studio',
  TECH: 'modern tech product photography, cool neutral tones, precise edges, subtle glow',
  MEDICAL_CLEAN: 'clinical clean product photography, pure white background, flat even light, trustworthy and sterile feel',
  BOLD_PERF_AD: 'bold performance-ad creative, punchy contrast, single strong focal point, space reserved for large headline',
};

function dnaLines(dnaData) {
  const d = { ...emptyDnaSkeleton(), ...(dnaData || {}) };
  const parts = [];
  const push = (label, v) => {
    if (Array.isArray(v) && v.length) parts.push(`${label}: ${v.join(', ')}`);
    else if (v && !Array.isArray(v)) parts.push(`${label}: ${v}`);
  };
  push('الألوان الأساسية', d.primary_colors);
  push('ألوان ثانوية', d.secondary_colors);
  push('الشكل', d.product_shape);
  push('الخامات', d.visible_materials);
  push('النِسب', d.proportions);
  push('الأزرار', d.buttons);
  push('المنافذ', d.ports);
  push('الشاشة', d.display_screen);
  push('المقابض', d.handles);
  push('ملحقات', d.accessories);
  push('كابلات', d.cables);
  push('خراطيم', d.hoses);
  push('الشعارات/العلامة', d.logos_branding);
  push('أجزاء شفافة', d.transparent_parts);
  push('أجزاء معدنية', d.metallic_parts);
  push('مظهر العبوة', d.packaging_appearance);
  push('تفاصيل مميزة', d.unique_design_details);
  return parts.join(' | ');
}

/**
 * @returns {{ prompt: string, promptVersion: number, meta: object }}
 */
export function buildPrompt({ item, copy, direction, product, dna, project, lockMode, correctiveNote, promptVersion = 1 }) {
  const lock = LOCK_RULES[lockMode || project?.product_lock_mode || 'STRICT'] || LOCK_RULES.STRICT;
  const style = STYLE_PRESET_PROMPT[project?.style_preset] || STYLE_PRESET_PROMPT.EGY_ECOM;
  const dnaText = dnaLines(dna?.data || dna);

  const textDensity = { MINIMAL: 'نص قليل جدًا (هوك واحد كبير فقط)', LOW: 'نص قليل', MEDIUM: 'نص متوسط منظّم' }[project?.text_density] || 'نص قليل جدًا';
  const peopleRule = {
    NONE: 'بدون أي أشخاص في الصورة',
    MEN: 'يمكن ظهور رجل واحد بشكل طبيعي',
    WOMEN: project?.hijab_required ? 'يمكن ظهور سيدة مُحجّبة بشكل محترم (الحجاب إلزامي)' : 'يمكن ظهور سيدة بشكل محترم',
    AI_CHOICE: 'وجود الأشخاص حسب ملاءمة الفكرة',
  }[project?.people_rule] || 'بدون أشخاص';

  const onImageText = [];
  if (copy?.hook) onImageText.push(`الهوك (كبير وواضح): «${copy.hook}»`);
  if (copy?.supporting_line) onImageText.push(`سطر مساند صغير: «${copy.supporting_line}»`);
  if (copy?.cta && project?.project_type !== 'PRODUCT_PAGE') onImageText.push(`زر/‏CTA: «${copy.cta}»`);

  const dir = direction || {};
  const lines = [
    `صورة منتج احترافية للتجارة الإلكترونية — السوق: مصر. النوع: ${project?.project_type}. أسلوب: ${style}.`,
    `المنتج: ${product?.name}${product?.category ? ` (${product.category})` : ''}.`,
    dnaText ? `هوية المنتج (يجب الالتزام بها حرفيًا): ${dnaText}.` : '',
    `قفل المنتج: ${lock}`,
    `الغرض من الصورة: ${item?.purpose || '—'} — الزاوية: ${item?.angle || '—'}.`,
    item?.scene ? `المشهد: ${item.scene}.` : '',
    `تكوين: ${dir.composition || item?.composition || 'المنتج بطل الكادر مع منطقة نص آمنة'}. حجم المنتج في الكادر: ${dir.product_size_in_frame || '60%'}. زاوية الكاميرا: ${dir.product_angle || item?.camera_angle || '3/4'}.`,
    `إضاءة: ${dir.lighting || 'استوديو ناعمة'}. خلفية: ${dir.background || item?.background || 'موحدة نظيفة'}. ظلال: ${dir.shadows || 'ناعمة'}. انعكاسات: ${dir.reflections || 'خفيفة'}.`,
    Array.isArray(dir.infographic_elements) && dir.infographic_elements.length ? `عناصر إنفوجرافيك: ${dir.infographic_elements.join(', ')}.` : '',
    `الأشخاص: ${peopleRule}.`,
    `النص على الصورة: ${textDensity}. اكتب النص العربي بشكل صحيح وواضح وقابل للقراءة، في ${dir.text_safe_area || copy?.safe_area || 'أعلى الكادر'}.`,
    onImageText.length ? onImageText.join(' | ') : 'بدون نص إضافي.',
    Array.isArray(item?.features) && item.features.length ? `مزايا يجب إبرازها بصريًا فقط إن دعمتها المواصفات: ${item.features.slice(0, 4).join(', ')}.` : '',
    'ممنوع: اختراع شعارات أو منافذ أو أزرار أو ملصقات أو أرقام موديل غير موجودة في هوية المنتج. ممنوع أي نص أو ادعاء غير مذكور أعلاه. ممنوع علامات مائية.',
    project?.project_type === 'PRODUCT_PAGE' ? 'اتساق بصري كامل مع باقي صور صفحة المنتج (نفس عائلة الخلفية والإضاءة ونمط الخط).' : '',
    correctiveNote ? `تصحيحات مطلوبة من مراجعة الجودة: ${correctiveNote}` : '',
  ].filter(Boolean);

  return {
    prompt: lines.join('\n'),
    promptVersion,
    meta: {
      lockMode: lockMode || project?.product_lock_mode || 'STRICT',
      stylePreset: project?.style_preset || 'EGY_ECOM',
      hasCorrective: !!correctiveNote,
      referencePriority: dir.reference_priority || item?.reference_priority || [],
    },
  };
}
