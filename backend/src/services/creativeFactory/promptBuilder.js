// AI Creative Factory — PromptBuilderService.
//
// Deterministic assembly of the FINAL image prompt. The owner never writes
// prompts. Key guarantees baked in here:
//   • PRODUCT IDENTITY LOCK — the uploaded product is the SOURCE OF TRUTH;
//     preservation beats creativity. An exhaustive, DNA-derived NEVER list.
//   • REFERENCE-AWARE — each attached reference is labelled by what it shows,
//     and the model is told which one is authoritative for this shot.
//   • TEXT-FREE — the model renders NO text/logos it can't see in the refs,
//     and leaves a clean zone; our own engine adds the Arabic afterwards.
//   • NO AI LOOK — realistic commercial product photography direction, with
//     an explicit list of AI tells to avoid.
//   • Category safety rules + scale intelligence from the DNA.
import { emptyDnaSkeleton, referenceHintFor } from './taxonomy.js';

const LOCK_RULES = {
  STRICT: 'ابدأ من هوية المنتج في الصور المرجعية باعتبارها المصدر الوحيد للحقيقة. الحفاظ على المنتج أهم من الإبداع. طابِق بدقة قصوى: نفس الجسم والشكل، نفس النِسب، نفس الألوان بالضبط، نفس عدد الأزرار ومواضعها، نفس الشاشة، نفس المنافذ، نفس الملحقات، نفس تفاصيل السطح والخامات، نفس العبوة والعلامات المقروءة. لا تُعِد تصميم المنتج ولا تُجمّله بتغييره.',
  BALANCED: 'حافظ على هوية المنتج الأساسية من المرجع (الشكل، الألوان، المكوّنات المرئية، النِسب) مع حرية في الإضاءة والخلفية والتكوين فقط.',
  CREATIVE: 'حافظ على فكرة المنتج ولونه العام وشكله العام من المرجع؛ يُسمح بتفسير فني أوسع للمشهد والأسلوب مع بقاء المنتج معروفًا فورًا.',
};

const STYLE_PRESET_PROMPT = {
  APPLE_CLEAN: 'minimalist Apple-style product photography, seamless light background, crisp soft light, generous negative space',
  PREMIUM_STUDIO: 'premium studio product photography, controlled gradient background, soft key light plus subtle rim light',
  EGY_ECOM: 'high-converting Egyptian e-commerce product photography, bright even lighting, simple high-contrast background, clean and trustworthy',
  LUXURY: 'restrained luxury product photography, deep tones, controlled directional light, refined natural reflections',
  LIFESTYLE: 'authentic lifestyle photography, natural window light, real in-use context, believable everyday Egyptian setting, shallow depth of field',
  BEAUTY: 'clean beauty product photography, soft diffused light, pastel or white background, gentle natural highlights',
  AUTOMOTIVE: 'realistic automotive product photography, honest surfaces, believable garage or roadside context, controlled highlights',
  TECH: 'modern realistic tech product photography, cool neutral tones, precise edges, restrained subtle glow',
  MEDICAL_CLEAN: 'clean clinical product photography, pure white background, flat even light, calm and trustworthy',
  BOLD_PERF_AD: 'bold but realistic performance-ad product photography, punchy contrast, one strong focal point, clear space for a headline',
};

const AI_TELLS = [
  'plastic-looking CGI surfaces', 'waxy or plastic skin', 'extra or fused fingers', 'warped or asymmetric geometry',
  'impossible shadows or reflections', 'random glowing particles', 'neon rim lighting', 'fake futuristic environment',
  'floating objects with no support', 'duplicated objects', 'nonsensical background props', 'unreadable fake symbols or text',
  'over-perfect airbrushed everything', 'melted edges', 'gradient soup backgrounds',
].join(', ');

function dnaLine(dnaData) {
  const d = { ...emptyDnaSkeleton(), ...(dnaData || {}) };
  const parts = [];
  const push = (label, v) => {
    if (Array.isArray(v) && v.length) parts.push(`${label}: ${v.join('، ')}`);
    else if (v && !Array.isArray(v)) parts.push(`${label}: ${v}`);
  };
  push('الفئة', d.product_category || d.product_type);
  push('الشكل', d.exact_shape || d.product_shape);
  push('النِسب', d.proportions);
  push('اللون الأساسي', d.primary_colors);
  push('ألوان ثانوية', d.secondary_colors);
  push('الخامات', d.visible_materials);
  push('السطح', d.surface_texture);
  push('الأزرار', d.buttons);
  push('المنافذ', d.ports);
  push('الشاشة', d.display_screen);
  push('لمبات/مؤشرات', d.lights_indicators);
  push('فتحات', d.openings);
  push('مقابض', d.handles);
  push('ملحقات', d.accessories);
  push('كابلات', d.cables);
  push('خراطيم', d.hoses);
  push('نصوص/علامات على المنتج', d.printed_elements);
  push('شعارات', d.logos_branding);
  push('أجزاء شفافة', d.transparent_parts);
  push('أجزاء معدنية', d.metallic_parts);
  push('العبوة', d.packaging_appearance);
  push('تفاصيل مميزة', d.unique_design_details);
  return parts.join(' | ');
}

function neverList(dnaData, project) {
  const d = { ...emptyDnaSkeleton(), ...(dnaData || {}) };
  const base = [
    'إضافة أو حذف أي زر', 'تغيير عدد الأزرار أو أماكنها', 'تغيير أي لون', 'تغيير النِسب أو الأبعاد',
    'اختراع شاشة أو لمبة أو منفذ غير موجود في المرجع', 'اختراع ملحقات أو كابلات', 'اختراع شعار أو ملصق أو رقم موديل',
    'كتابة أي نص أو أرقام أو ادعاءات على الصورة', 'تغيير شكل أو ألوان العبوة', 'إنشاء نسخة مختلفة أو موديل مختلف من المنتج',
    'تجميل المنتج بإعادة تصميمه',
  ];
  const fromDna = Array.isArray(d.never_invent) ? d.never_invent.map((x) => `اختراع: ${x}`) : [];
  return [...base, ...fromDna].join(' — ');
}

/**
 * @param {object} p
 * @param {object} p.item          plan item (enriched)
 * @param {object} p.copy          approved copy (used ONLY to size the safe text zone; text is NOT rendered by the model)
 * @param {object} p.direction     creative director output (optional)
 * @param {object} p.product
 * @param {object} p.dna           { data: {...} } or the raw dna object
 * @param {object} p.project
 * @param {Array<{label:string}>} p.references   reference images actually attached, in order, with a label
 * @param {string} [p.correctiveNote]
 * @param {number} [p.promptVersion]
 * @param {boolean} [p.textOverlay]  true → model produces a TEXT-FREE composition
 * @returns {{ prompt:string, promptVersion:number, meta:object }}
 */
export function buildPrompt({ item, copy, direction, product, dna, project, references = [], lockMode, correctiveNote, promptVersion = 1, textOverlay = true }) {
  const dnaData = dna?.data || dna || {};
  const lock = LOCK_RULES[lockMode || project?.product_lock_mode || 'STRICT'] || LOCK_RULES.STRICT;
  const style = STYLE_PRESET_PROMPT[project?.style_preset] || STYLE_PRESET_PROMPT.EGY_ECOM;
  const dnaTxt = dnaLine(dnaData);
  const dir = direction || {};

  // ---- reference-aware block ----
  const wantHints = referenceHintFor(item?.camera_angle || item?.camera_plan);
  const refLines = references.map((r, i) => {
    const lab = String(r.label || `مرجع ${i + 1}`);
    const relevant = wantHints.some((hkw) => lab.toLowerCase().includes(hkw));
    return `- REFERENCE ${i + 1} = ${lab}${relevant ? ' ← الأهم لهذه اللقطة (طابِق منه الشكل واللون والتفاصيل)' : ''}`;
  });
  const refBlock = references.length
    ? `الصور المرجعية (هوية المنتج، مش إلهام):\n${refLines.join('\n')}\nاستخدمها لتثبيت هوية المنتج بالضبط.`
    : 'لا توجد صور مرجعية مرفقة — التزم بوصف هوية المنتج أدناه حرفيًا.';

  // ---- people / hijab / scale ----
  const peopleRule = {
    NONE: 'بدون أي أشخاص في الصورة.',
    MEN: 'يمكن ظهور رجل واحد بتفاعل واقعي وأيدي طبيعية وحجم صحيح مع المنتج.',
    WOMEN: project?.hijab_required
      ? 'يمكن ظهور سيدة مُحجّبة بملابس محتشمة، بتفاعل واقعي وأيدي طبيعية وحجم صحيح مع المنتج.'
      : 'يمكن ظهور سيدة بملابس محتشمة، بتفاعل واقعي وأيدي طبيعية.',
    AI_CHOICE: 'وجود الأشخاص فقط إذا حسّن توصيل الفكرة، وبتفاعل واقعي.',
  }[project?.people_rule] || 'بدون أشخاص.';
  const scaleConf = Number(dnaData.scale_confidence);
  const scaleRule = Number.isFinite(scaleConf) && scaleConf < 50
    ? 'الحجم الفيزيائي غير مؤكد — استخدم لقطة مقرّبة نظيفة بلا مرجع حجم (بدون يد ممسكة أو مقارنة حجم).'
    : dnaData.physical_scale ? `الحجم الواقعي: ${dnaData.physical_scale} — حافظ على نسبة صحيحة بين المنتج وأي يد/بيئة.` : 'حافظ على مقياس واقعي للمنتج بالنسبة لأي بيئة.';

  const safety = Array.isArray(dnaData.category_safety_rules) && dnaData.category_safety_rules.length
    ? `قيود الفئة: ${dnaData.category_safety_rules.join(' — ')}.` : '';

  // ---- text zone (model leaves it clean; we add Arabic later) ----
  const layout = item?.text_layout || 'HEADLINE_TOP';
  const zone = layout === 'NONE' ? null
    : /BOTTOM/.test(layout) ? 'الثلث السفلي'
    : /CENTERED/.test(layout) ? 'شريط أفقي وسط الكادر'
    : /SIDE|CALLOUTS|INFOGRAPHIC/.test(layout) ? 'الثلث العلوي + جانب واحد'
    : 'الثلث العلوي';
  const textRule = !textOverlay
    ? `النص على الصورة قليل جدًا وباللغة العربية الصحيحة: «${copy?.hook || ''}»${copy?.cta ? ` وزر «${copy.cta}»` : ''}.`
    : `لا تكتب أي نص أو حروف أو أرقام أو شعارات في الصورة إطلاقًا. اترك ${zone || 'أعلى الكادر'} مساحة نظيفة هادئة بدون تفاصيل مشتّتة، مخصّصة لإضافة النص لاحقًا. لا تضع علامة مائية.`;

  const lines = [
    `تصوير منتج تجاري واقعي عالي الاحتراف للتجارة الإلكترونية في مصر. الأسلوب: ${style}. المنتج هو البطل البصري.`,
    `المنتج: ${product?.name}${dnaData.product_type ? ` (${dnaData.product_type})` : (product?.category ? ` (${product.category})` : '')}.`,
    refBlock,
    dnaTxt ? `هوية المنتج (التزم بها حرفيًا): ${dnaTxt}.` : '',
    `قفل هوية المنتج: ${lock}`,
    `ممنوع منعًا باتًا: ${neverList(dnaData, project)}.`,
    `الغرض: ${item?.creative_goal || item?.purpose || '—'} — الزاوية: ${item?.marketing_angle || item?.angle || '—'} — يجيب على سؤال العميل: «${item?.customer_question || '—'}».`,
    item?.visual_concept ? `الفكرة البصرية: ${item.visual_concept}.` : (item?.scene ? `المشهد: ${item.scene}.` : ''),
    `التكوين: ${dir.composition || item?.composition || 'المنتج بطل الكادر مع منطقة نص آمنة'}. مكان وحجم المنتج: ${item?.product_position || dir.product_size_in_frame || 'يملأ 55–70% من الكادر'}. زاوية الكاميرا: ${item?.camera_plan || item?.camera_angle || '3/4'}, منظور عدسة طبيعي (~50mm).`,
    `إضاءة: ${dir.lighting || 'إضاءة طبيعية/استوديو ناعمة واقعية'}. خلفية: ${dir.background || item?.background || 'موحّدة نظيفة'}. ظلال طبيعية واقعية، انعكاسات معقولة فقط، خامات حقيقية، مقياس صحيح.`,
    `الأشخاص: ${peopleRule}`,
    scaleRule,
    safety,
    textRule,
    `تجنّب أي مظهر ذكاء اصطناعي: ${AI_TELLS}. النتيجة يجب أن تبدو كأن مصوّر منتجات محترف التقطها، وليست صورة AI.`,
    project?.project_type === 'PRODUCT_PAGE' ? 'حافظ على اتساق بصري مع باقي صور صفحة المنتج (نفس عائلة الخلفية والإضاءة والمزاج) مع اختلاف الغرض لكل صورة.' : '',
    correctiveNote ? `تصحيحات إلزامية من مراجعة سابقة: ${correctiveNote}` : '',
  ].filter(Boolean);

  return {
    prompt: lines.join('\n'),
    promptVersion,
    meta: {
      lockMode: lockMode || project?.product_lock_mode || 'STRICT',
      stylePreset: project?.style_preset || 'EGY_ECOM',
      textLayout: layout,
      textOverlay: !!textOverlay,
      hasCorrective: !!correctiveNote,
      referencesUsed: references.length,
    },
  };
}

/**
 * Pick which reference images to attach for a given plan item (spec §3).
 * @param {Array<{buffer,mime,label}>} allRefs
 * @param {object} item
 * @param {number} max
 * @returns {Array} a prioritised subset (always ≥1 when refs exist)
 */
export function selectReferencesForItem(allRefs, item, max = 4) {
  if (!allRefs?.length) return [];
  const hints = referenceHintFor(item?.camera_angle || item?.camera_plan);
  const scored = allRefs.map((r, idx) => {
    const lab = String(r.label || '').toLowerCase();
    let score = 0;
    hints.forEach((hkw, hi) => { if (lab.includes(hkw)) score += (hints.length - hi) * 3; });
    if (Array.isArray(item?.reference_priority)) {
      item.reference_priority.forEach((rp) => { if (lab && String(rp).toLowerCase().includes(lab)) score += 4; });
    }
    return { r, score, idx };
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  let pick = scored.filter((s) => s.score > 0).slice(0, max).map((s) => s.r);
  if (!pick.length) pick = allRefs.slice(0, Math.min(max, allRefs.length)); // identity from all when nothing matched
  // always keep at least one identity-defining front-ish ref
  if (!pick.some((r) => /front|أمام|3\/4/.test(String(r.label || '').toLowerCase())) && allRefs[0] && !pick.includes(allRefs[0])) {
    pick = [allRefs[0], ...pick].slice(0, max);
  }
  return pick;
}
