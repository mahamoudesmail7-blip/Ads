// AMB Media — DESIGN SYSTEMS for product-page image sets. A page's images must look like ONE family (same palette, typography, card and icon
// language) and show the product EXACTLY as it is. Two built-in systems come from the owner's own finished pages (shower brush / ear washer);
// each ships a few of those pages as STYLE REFERENCES that are sent to the image model together with the product photo (image 1 = the product,
// images 2.. = style only). 'auto' = no style references: the model derives one palette from the product's own colors and keeps it for the set.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/page-styles');

export const PAGE_STYLES = {
  clean_blue: {
    label: 'أبيض وأزرق نظيف', hint: 'خلفية فاتحة، عناوين كحلي وأزرق، كروت بيضاء مدوّرة بأيقونات زرقا (زي صفحة فرشة الاستحمام)',
    palette: 'white / very light grey backgrounds, deep navy headlines (#0B2A5B) with ONE key word highlighted in bright blue (#2F6FED), white rounded cards with thin blue outline icons and blue check marks, a navy rounded call-to-action button',
    type: 'very bold modern Arabic display font for headlines, medium weight for supporting lines, high contrast, generous spacing',
    cards: 'rounded white cards with soft shadow, thin-outline icons, small circular zoom bubbles with thin white borders',
    mood: 'clean, bright, trustworthy, premium e-commerce',
    refs: { hero: ['hero_blue'], features: ['features_blue'], problem: ['problem_blue'], problem_solution: ['problem_solution_blue'], demonstration: ['demo_blue'], final_cta: ['hero_blue'] },
  },
  cream_gold: {
    label: 'كريمي وكحلي وذهبي', hint: 'رخام كريمي ناعم، عناوين كحلي، خط ذهبي رفيع، كبسولات كريمي (زي صفحة جهاز غسيل الأذن)',
    palette: 'soft cream / beige marble backgrounds, deep navy headlines (#14306B), thin gold divider lines with a small diamond, cream rounded pill cards with thin dark outline icons, a navy rounded call-to-action',
    type: 'bold elegant Arabic display font for the headline, regular weight for supporting lines, calm and premium',
    cards: 'cream rounded pills and cards with soft shadow, thin-outline icons, circular detail insets',
    mood: 'warm, calm, premium home-care',
    refs: { hero: ['hero_cream'], features: ['features_cream'], problem: ['hero_cream'], problem_solution: ['hero_cream'], demonstration: ['demo_cream'], final_cta: ['cta_cream'] },
  },
  auto: {
    label: 'تلقائي من لون المنتج', hint: 'من غير صور أسلوب: الموديل يختار لوحة ألوان من ألوان المنتج نفسه ويثبّتها على كل الصور',
    palette: "ONE palette derived from the product's own colors (a light neutral background + the product's main color as the accent + deep navy or charcoal for headlines), the SAME in every image of the set",
    type: 'very bold modern Arabic display font for headlines, medium weight for supporting lines, high contrast',
    cards: 'rounded cards with soft shadow and thin-outline icons',
    mood: 'clean and trustworthy e-commerce',
    refs: {},
  },
};
export const DEFAULT_STYLE = 'clean_blue';
export const validStyle = (s) => (PAGE_STYLES[s] ? s : DEFAULT_STYLE);

/** The role a template plays in a page (decides which style reference is relevant). */
export const ROLE_OF = {
  hero_hook: 'hero', lifestyle_home: 'hero', family_scene: 'hero', night_outdoor: 'hero',
  features_hero: 'features', feature_grid: 'features', parts_breakdown: 'features',
  problem: 'problem', problem_solution: 'problem_solution', before_after: 'problem_solution',
  demonstration: 'demonstration', how_to_steps: 'demonstration', app_control: 'demonstration',
  final_cta: 'final_cta', offer_cta: 'final_cta',
};

/** The 5-image page pack, in page order (the same sequence the Creative Factory plans for a product page). */
export const PAGE_PACK = [
  { role: 'hero', template: 'hero_hook', label: 'الصورة الرئيسية (هوك قوي)' },
  { role: 'problem', template: 'problem', label: 'المشكلة اللي بيحلها المنتج' },
  { role: 'problem_solution', template: 'problem_solution', label: 'المشكلة والحل' },
  { role: 'demonstration', template: 'demonstration', label: 'المنتج أثناء الاستخدام' },
  { role: 'final_cta', template: 'final_cta', label: 'صورة ختامية للشراء' },
];

const cache = new Map();
function asset(name) {
  if (cache.has(name)) return cache.get(name);
  let v = null;
  try { v = { b64: fs.readFileSync(path.join(ASSETS, `${name}.jpg`)).toString('base64'), mime: 'image/jpeg' }; } catch { /* asset missing → generation continues without that style reference */ }
  cache.set(name, v);
  return v;
}

/** Style reference images ([{ b64, mime }], at most 2) for a template under a style. [] for 'auto' / unknown. */
export function styleRefsFor(styleId, templateId) {
  const st = PAGE_STYLES[styleId]; const role = ROLE_OF[templateId];
  if (!st || !role) return [];
  return (st.refs[role] || []).slice(0, 2).map(asset).filter(Boolean);
}

/** The text block that locks the SET together and tells the model what each attached image is. */
export function designSystemBlock(styleId, styleRefCount = 0) {
  const st = PAGE_STYLES[styleId] || PAGE_STYLES[DEFAULT_STYLE];
  const lines = [
    `DESIGN SYSTEM — use EXACTLY the same system in every image of this product page so they look like one family: palette: ${st.palette}. Typography: ${st.type}. Cards and icons: ${st.cards}. Mood: ${st.mood}.`,
    'PRODUCT LOCK — the FIRST attached image is the only source of truth for the product. The product must be IDENTICAL in every image of the set: same shape, colors, buttons, screen, ports, accessories, proportions and any printing or logo on it. Never redesign, restyle, recolor, add or remove parts, or turn it into a different model.',
  ];
  if (styleRefCount > 0) lines.push(`STYLE REFERENCES — the ${styleRefCount === 1 ? 'second' : 'second and third'} attached image${styleRefCount === 1 ? ' is' : 's are'} finished product-page images of OTHER products, given ONLY to show the visual style (layout language, colors, typography, card style). Copy that design language; NEVER copy their product, their text or their people.`);
  return lines.join(' ');
}
