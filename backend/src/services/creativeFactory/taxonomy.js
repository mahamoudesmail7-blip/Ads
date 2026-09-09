// AI Creative Factory — shared vocab. Deterministic fallbacks + the option
// lists the plan / UI both draw from, so nothing is invented ad-hoc.

export const PROJECT_TYPES = ['PRODUCT_PAGE', 'META_ADS', 'SOCIAL', 'RETARGETING', 'VARIATIONS', 'CUSTOM'];

export const PRODUCT_LOCK_MODES = ['STRICT', 'BALANCED', 'CREATIVE']; // صارم | متوازن | إبداعي

export const STYLE_PRESETS = [
  { key: 'APPLE_CLEAN', label: 'Apple Clean' },
  { key: 'PREMIUM_STUDIO', label: 'Premium Studio' },
  { key: 'EGY_ECOM', label: 'Egyptian E-commerce' },
  { key: 'LUXURY', label: 'Luxury' },
  { key: 'LIFESTYLE', label: 'Lifestyle' },
  { key: 'BEAUTY', label: 'Beauty' },
  { key: 'AUTOMOTIVE', label: 'Automotive' },
  { key: 'TECH', label: 'Tech' },
  { key: 'MEDICAL_CLEAN', label: 'Medical Clean' },
  { key: 'BOLD_PERF_AD', label: 'Bold Performance Ad' },
];

export const TEXT_DENSITIES = ['MINIMAL', 'LOW', 'MEDIUM']; // قليل جدًا | قليل | متوسط
export const PEOPLE_RULES = ['NONE', 'MEN', 'WOMEN', 'AI_CHOICE'];
export const ASPECT_RATIOS = ['1:1', '4:5', '9:16', '16:9', '1.91:1'];

// Product-page: a CONNECTED sequence. The planner picks the subset that fits.
export const PRODUCT_PAGE_CATEGORIES = [
  { key: 'HERO', label: 'Main Hero', purpose: 'تعريف سريع واضح بالمنتج' },
  { key: 'PROBLEM', label: 'Problem', purpose: 'إظهار المشكلة اللي بيحلها المنتج' },
  { key: 'PROBLEM_SOLUTION', label: 'Problem / Solution', purpose: 'المشكلة والحل جنب بعض' },
  { key: 'BEFORE_AFTER', label: 'Before / After', purpose: 'الفرق قبل وبعد (لو مناسب للمنتج)' },
  { key: 'DEMONSTRATION', label: 'Product demonstration', purpose: 'المنتج وهو بيشتغل' },
  { key: 'BENEFITS', label: 'Main benefits', purpose: 'أهم فوائد المنتج' },
  { key: 'FEATURE_INFOGRAPHIC', label: 'Feature infographic', purpose: 'إنفوجرافيك مواصفات' },
  { key: 'MULTI_ANGLE', label: 'Multi-angle product', purpose: 'زوايا متعددة للمنتج' },
  { key: 'MACRO_DETAILS', label: 'Macro details', purpose: 'تفاصيل قريبة ودقيقة' },
  { key: 'LIFESTYLE', label: 'Lifestyle use', purpose: 'المنتج في سياق استخدام حقيقي' },
  { key: 'HOW_TO_USE', label: 'How to use', purpose: 'خطوات الاستخدام' },
  { key: 'OBJECTION', label: 'Objection handling', purpose: 'الرد على اعتراض شائع' },
  { key: 'PRODUCT_PACKAGING', label: 'Product + packaging', purpose: 'المنتج مع العلبة' },
  { key: 'FINAL_CTA', label: 'Final CTA / conversion', purpose: 'صورة ختامية تحث على الشراء' },
];

// Meta ads: prioritise DIVERSITY of angle.
export const META_AD_ANGLES = [
  'PROBLEM', 'PROBLEM_SOLUTION', 'CURIOSITY', 'PRODUCT_DEMO', 'BENEFIT', 'FEATURE',
  'LIFESTYLE', 'BEFORE_AFTER', 'CONVENIENCE', 'COMPARISON', 'OBJECTION_HANDLING',
  'SOCIAL_PROOF_STYLE', 'PRODUCT_FOCUS', 'OFFER', 'DIRECT_RESPONSE', 'URGENCY',
  'GIFT', 'TRAVEL_PORTABLE', 'EMOTIONAL', 'PATTERN_INTERRUPT',
];

export const VARIATION_TYPES = [
  'SAME_CONCEPT', 'NEW_HOOK', 'NEW_COPY', 'NEW_BACKGROUND', 'NEW_CAMERA_ANGLE',
  'NEW_ENVIRONMENT', 'NEW_AUDIENCE', 'NEW_STYLE', 'NEW_ANGLE',
];

export const QUALITY_DIMENSIONS = [
  { key: 'product_accuracy_score', label: 'تطابق المنتج' },
  { key: 'identity_score', label: 'الحفاظ على هوية المنتج' },
  { key: 'visual_quality_score', label: 'الجودة البصرية' },
  { key: 'composition_score', label: 'التكوين' },
  { key: 'product_visibility_score', label: 'وضوح المنتج' },
  { key: 'marketing_score', label: 'وضوح الرسالة الإعلانية' },
  { key: 'arabic_text_score', label: 'جودة النص العربي' },
  { key: 'text_readability_score', label: 'سهولة قراءة النص' },
  { key: 'claim_score', label: 'سلامة الادعاءات' },
  { key: 'artifact_score', label: 'خلو من التشوهات' },
  { key: 'reference_consistency_score', label: 'الاتساق مع الصور المرجعية' },
  { key: 'plan_compliance_score', label: 'الالتزام بالخطة' },
];

// Empty, explicit Product DNA skeleton — used when AI is unavailable so the
// owner still gets a structured form to fill, never a fake filled profile.
export function emptyDnaSkeleton() {
  return {
    primary_colors: [],
    secondary_colors: [],
    product_shape: null,
    visible_materials: [],
    proportions: null,
    buttons: null,
    ports: null,
    display_screen: null,
    handles: null,
    attachments: [],
    cables: [],
    hoses: [],
    accessories: [],
    logos_branding: [],
    patterns: [],
    transparent_parts: null,
    metallic_parts: null,
    packaging_appearance: null,
    unique_design_details: [],
    features_visible_in_reference: [],
    never_invent: [],
    confidence: null,
  };
}
