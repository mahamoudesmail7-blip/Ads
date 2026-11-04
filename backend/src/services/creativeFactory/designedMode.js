// AI Creative Factory — DESIGNED mode for product-page images.
// The classic factory path makes a text-free photograph and adds the Arabic with its own canvas engine. A DESIGNED project instead asks the image
// model for a FINISHED designed page image (Arabic headline, icon cards, steps, price, CTA button) in ONE design system shared by the whole set,
// with the product locked to the owner's reference photos — the look of the owner's own finished product pages.
// It is selected through the project's existing `style_preset` (DESIGNED_CLEAN_BLUE | DESIGNED_CREAM_GOLD | DESIGNED_AUTO), so no schema change.
// Reuses the templates / design systems of the AMB «صفحة المنتج» tab (services/amb/media).
import { buildTemplatePrompt, PAGE_TEMPLATES } from '../amb/media/pageTemplates.js';
import { styleRefsFor, validStyle } from '../amb/media/pageStyles.js';

export const DESIGNED_PRESETS = {
  DESIGNED_CLEAN_BLUE: 'clean_blue',
  DESIGNED_CREAM_GOLD: 'cream_gold',
  DESIGNED_AUTO: 'auto',
};
export const DESIGNED_PRESET_OPTIONS = [
  { key: 'DESIGNED_CLEAN_BLUE', label: 'مصمّم — أبيض وأزرق نظيف (زي صفحات الفرشة)' },
  { key: 'DESIGNED_CREAM_GOLD', label: 'مصمّم — كريمي وكحلي وذهبي (زي صفحات جهاز الأذن)' },
  { key: 'DESIGNED_AUTO', label: 'مصمّم — تلقائي من لون المنتج' },
];

/** The design-system id for a project's style_preset, or null when the project is a classic (photo + canvas text) one. */
export const designedStyleOf = (stylePreset) => DESIGNED_PRESETS[String(stylePreset || '')] || null;

/** Plan-item angle → designed template. null = no designed version (the classic path is used for that one image). */
export const ANGLE_TO_TEMPLATE = {
  HERO: 'hero_hook', PROBLEM: 'problem', PROBLEM_SOLUTION: 'problem_solution', BEFORE_AFTER: 'before_after',
  DEMONSTRATION: 'demonstration', BENEFITS: 'features_hero', FEATURE_INFOGRAPHIC: 'feature_grid', MACRO_DETAILS: 'parts_breakdown',
  LIFESTYLE: 'lifestyle_home', HOW_TO_USE: 'demonstration', OBJECTION: 'problem', FINAL_CTA: 'final_cta',
};
export const designedTemplateFor = (angle) => ANGLE_TO_TEMPLATE[String(angle || '').toUpperCase().trim()] || null;

// The AI plan names angles in free text (hero, feature, display, interface, design_detail…), not the taxonomy keys. In designed mode EVERY image of
// the page must be designed, so a free-text item is mapped by keyword, then by its place in the sequence (first = hero, last = closing CTA).
const KEYWORDS = [
  [/before.?after|قبل.*بعد/i, 'before_after'],
  [/problem.?solution|مشكلة.*حل/i, 'problem_solution'],
  [/problem|pain|objection|مشكل|اعتراض/i, 'problem'],
  [/final|cta|closing|buy|order|offer|اشتر|اطلب|عرض/i, 'final_cta'],
  [/hero|main|opening|رئيس/i, 'hero_hook'],
  [/demo|use|usage|how|step|action|interface|display|screen|استخدام|شرح|واجه|شاشة/i, 'demonstration'],
  [/detail|macro|part|close.?up|design|material|quality|تفصيل|خامة|جودة/i, 'parts_breakdown'],
  [/lifestyle|home|family|scene|حياة|بيت/i, 'lifestyle_home'],
  [/feature|benefit|spec|infograph|ميزة|مميزات|فوائد|مواصفات/i, 'features_hero'],
];
/** Always returns a template (never null): taxonomy key → keywords in angle/purpose → position in the sequence → features. */
export function designedTemplateForItem(item = {}, position = null, total = null) {
  const exact = designedTemplateFor(item.angle) || designedTemplateFor(item.marketing_angle);
  if (exact) return exact;
  const text = [item.angle, item.marketing_angle, item.purpose].filter(Boolean).join(' ');
  for (const [re, tpl] of KEYWORDS) if (re.test(text)) return tpl;
  const pos = Number(position ?? item.position) || 0; const n = Number(total) || 0;
  if (pos === 1) return 'hero_hook';
  if (n > 2 && pos === n) return 'final_cta';
  return 'features_hero';
}

const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The prompt + the reference list for one designed image.
 *   copy = the item's approved copy { headline, hook, supportingLine, subtitle, cta, featureLabels }
 *   productRefs = [{ b64, mime }] (the owner's product photos, best first) — they go FIRST; style references go after them.
 */
export function buildDesignedRequest({ templateId, styleId, product, copy, productRefs = [], styleRefsImpl = styleRefsFor }) {
  if (!PAGE_TEMPLATES[templateId]) return null;
  const style = validStyle(styleId);
  const sref = styleRefsImpl(style, templateId);
  const price = Number(product?.selling_price);
  const ctx = {
    name: product?.name || 'the product', style, styleRefCount: sref.length,
    headline: clean(copy?.headline || copy?.hook, 80), subtitle: clean(copy?.subtitle || copy?.supportingLine, 100),
    labels: (copy?.featureLabels || []).map((x) => clean(x, 40)).filter(Boolean),
    cta: clean(copy?.cta, 40) || 'اطلبه دلوقتي',
    priceText: Number.isFinite(price) && price > 0 ? `${price} جنيه` : '', // ONLY the product's real price — the template forbids any other number
    steps: [],
  };
  return { prompt: buildTemplatePrompt(templateId, ctx), referenceImages: [...productRefs.slice(0, 3), ...sref], styleRefCount: sref.length, ctx };
}

/** Pure: the text a designed image is expected to show (for the judge's Arabic-spelling check). */
export function expectedTexts(ctx) {
  return [ctx.headline, ctx.subtitle, ...(ctx.labels || []), ctx.cta, ctx.priceText].filter(Boolean);
}
