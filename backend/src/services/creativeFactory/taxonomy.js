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

// Classified image-generation failure reasons — drive TARGETED retries
// (regeneration.js), never a blind repeat call.
export const FAILURE_CODES = [
  'PRODUCT_SHAPE_WRONG', 'PRODUCT_COLOR_WRONG', 'MISSING_DETAIL', 'EXTRA_COMPONENT',
  'WRONG_ORIENTATION', 'BAD_HAND', 'WRONG_SCALE', 'BAD_COMPOSITION',
  'VISUAL_ARTIFACT', 'AI_LOOK', 'TEXT_IN_IMAGE', 'CLAIM_ISSUE', 'WRONG_USAGE', 'OK',
];

// Which reference angles matter for a given planned camera angle (spec §3).
export function referenceHintFor(cameraAngle = '') {
  const a = String(cameraAngle).toLowerCase();
  if (/front|أمام|واجهة/.test(a)) return ['front', '3/4', 'front 3/4'];
  if (/side|جانب/.test(a)) return ['side', '3/4'];
  if (/top|أعلى|فوق/.test(a)) return ['top', 'front'];
  if (/back|خلف/.test(a)) return ['back', '3/4'];
  if (/macro|detail|قريب|تفاصيل|زوم/.test(a)) return ['detail', 'macro', 'front'];
  if (/multi|زوايا/.test(a)) return ['front', 'side', '3/4', 'back', 'top'];
  if (/pack|علبة|كرتون|صندوق/.test(a)) return ['packaging', 'front'];
  return ['front', '3/4', 'side']; // lifestyle / hero / generic → identity from several
}

// Empty, explicit Product DNA skeleton — used when AI is unavailable so the
// owner still gets a structured form to fill, never a fake filled profile.
export function emptyDnaSkeleton() {
  return {
    // WHAT IS IT?
    product_category: null,          // e.g. "hair care appliance", "fishing reel"
    product_type: null,              // e.g. "steam hair straightener"
    primary_purpose: null,
    secondary_purposes: [],
    // WHAT DOES IT LOOK LIKE?
    exact_shape: null,
    proportions: null,               // relative proportions readable from the refs
    primary_colors: [],
    secondary_colors: [],
    visible_materials: [],
    surface_texture: null,
    buttons: null,                   // count + shape + placement, as text
    ports: null,
    display_screen: null,
    lights_indicators: null,
    openings: null,
    handles: null,
    accessories: [],
    cables: [],
    hoses: [],
    printed_elements: null,          // readable text/markings actually on the product
    logos_branding: [],
    patterns: [],
    transparent_parts: null,
    metallic_parts: null,
    packaging_appearance: null,
    unique_design_details: [],
    // HOW IS IT USED?
    correct_orientation: null,
    held_where: null,
    interaction_with_people: null,
    typical_placement: null,
    realistic_environment: null,
    physical_scale: null,            // e.g. "fits in one hand ~25cm"
    scale_confidence: null,          // 0..100 — low → avoid scale-exposing shots
    // WHO IS IT FOR?
    likely_audience: null,
    lifestyle_context: null,
    // SAFETY
    features_visible_in_reference: [],
    never_invent: [],                // components/text the generator must NOT add
    category_safety_rules: [],       // inferred: "no medical cure claims", "no underwater unless waterproof", ...
    confidence: null,
  };
}
