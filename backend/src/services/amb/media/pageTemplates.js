// AMB Media — product-page image TEMPLATES. Each one reproduces a layout from the owner's reference creatives (RetroSound, Vision-Door, NeckEase …):
// a real product photo as the reference, an Arabic headline rendered INSIDE the image, icon callouts / steps / before-after / CTA.
// The text that must appear is passed in quotes and the model is told to render it exactly (right-to-left) and add nothing else; the page
// project later reads the finished image back to check the text (pageProjects.checkImageText) because image models do slip on Arabic spelling.
export const PAGE_IMAGE_SIZE = '1024x1024';

const KEEP = 'Keep the product EXACTLY as in the reference photo (same shape, colors, buttons, proportions and any marking on it). Photorealistic, sharp, 1:1 square, high-end e-commerce advertising quality.';
const TEXT = 'Render the quoted Arabic text EXACTLY as written, right-to-left, correctly spelled and connected, in a clean bold modern Arabic font with strong contrast. Do NOT add any other words, numbers, watermark or logo besides the quoted text and the simple icons described.';
const PEOPLE = 'People look Egyptian/Arab, natural and relaxed, modest everyday clothing, no exaggerated expressions.';

const q = (s) => `"${String(s || '').replace(/"/g, '”').trim()}"`;
const labelsLine = (labels) => (labels || []).filter(Boolean).map(q).join(', ');

/**
 * id → { label, hint, fields, build(ctx) → prompt }.
 *   ctx = { name, headline, subtitle, labels:[…], steps:[{title,text}], cta }
 *   fields = which inputs the UI shows: headline | subtitle | labels | steps | cta
 */
export const PAGE_TEMPLATES = {
  features_hero: {
    label: 'مميزات حول المنتج', hint: 'المنتج في النص وحواليه أيقونات مميزات بخطوط رفيعة وعنوان فوق', fields: ['headline', 'labels'], minLabels: 3, maxLabels: 6,
    build: ({ name, headline, labels }) => `Product advertising image of "${name}": the product centered at a slight angle on a warm dark-wood/neutral studio background with soft rim light. Headline at the top: ${q(headline)}. Around the product place ${(labels || []).length} circular thin-outline icons, each connected to the product by a thin line, each with a short label under it: ${labelsLine(labels)}. ${KEEP} ${TEXT}`,
  },
  feature_grid: {
    label: 'شبكة مميزات (إنفوجرافيك)', hint: 'المنتج على منصة بيضاء وحواليه كروت مميزات مرتبة', fields: ['headline', 'labels'], minLabels: 4, maxLabels: 6,
    build: ({ name, headline, labels }) => `Clean white infographic advertising image of "${name}": the product centered on a soft white podium, headline at the top in two lines with the key word highlighted in brand blue: ${q(headline)}. ${(labels || []).length} rounded feature cards around the product (3 left, 3 right), each with a small icon and one short label: ${labelsLine(labels)}. ${KEEP} ${TEXT}`,
  },
  lifestyle_home: {
    label: 'استخدام داخل البيت', hint: 'مشهد دافي في بيت مصري، العنوان فوق وأيقونات صغيرة تحت', fields: ['headline', 'subtitle', 'labels'], minLabels: 0, maxLabels: 5,
    build: ({ name, headline, subtitle, labels }) => `Warm lifestyle advertising photo: a cozy Egyptian living room with soft evening lamp light, a person or a couple naturally enjoying / using "${name}" which is clearly visible in the foreground. Headline at the top: ${q(headline)}${subtitle ? `, and below it a smaller subtitle: ${q(subtitle)}` : ''}. ${(labels || []).length ? `At the bottom a row of small icons with tiny labels: ${labelsLine(labels)}.` : ''} ${PEOPLE} ${KEEP} ${TEXT}`,
  },
  family_scene: {
    label: 'مشهد عائلي', hint: 'أسرة مبسوطة حوالين المنتج في الصالة', fields: ['headline', 'subtitle', 'labels'], minLabels: 0, maxLabels: 5,
    build: ({ name, headline, subtitle, labels }) => `Warm family advertising photo: an Egyptian family (parents and two children) sitting together in a bright cozy living room, smiling, with "${name}" clearly visible on the coffee table in front of them. Headline at the top: ${q(headline)}${subtitle ? `, subtitle: ${q(subtitle)}` : ''}. ${(labels || []).length ? `A row of small icons with tiny labels near the top or bottom: ${labelsLine(labels)}.` : ''} ${PEOPLE} ${KEEP} ${TEXT}`,
  },
  night_outdoor: {
    label: 'مشهد ليلي / خارجي', hint: 'سهرة على البحر أو في الجنينة، إضاءة دافية', fields: ['headline', 'subtitle', 'labels'], minLabels: 0, maxLabels: 5,
    build: ({ name, headline, subtitle, labels }) => `Cinematic night advertising photo: a couple sitting by the sea at night with a bonfire, a full moon and city lights across the water, warm lantern light, with "${name}" clearly visible on a wooden table in the foreground. Headline at the top: ${q(headline)}${subtitle ? `, subtitle: ${q(subtitle)}` : ''}. ${(labels || []).length ? `Small icons with tiny labels in a row at the bottom: ${labelsLine(labels)}.` : ''} ${PEOPLE} ${KEEP} ${TEXT}`,
  },
  before_after: {
    label: 'قبل / بعد', hint: 'الصورة منقسمة نصين: من غير المنتج ومعاه', fields: ['headline', 'subtitle', 'labels'], minLabels: 0, maxLabels: 5,
    build: ({ name, headline, subtitle, labels }) => `Split-screen advertising image, two halves of the same room: LEFT half dimmer and plain WITHOUT the product with the caption ${q(headline)}; RIGHT half warm and inviting WITH "${name}" placed on the table with the caption ${q(subtitle || headline)}. A thin vertical divider in the middle. ${(labels || []).length ? `A translucent bar at the bottom with small icons and labels: ${labelsLine(labels)}.` : ''} ${KEEP} ${TEXT}`,
  },
  how_to_steps: {
    label: 'طريقة الاستخدام / التركيب (3 خطوات)', hint: 'ثلاث كروت مرقمة بصورة صغيرة وجملة لكل خطوة', fields: ['headline', 'subtitle', 'steps'], minSteps: 3, maxSteps: 3,
    build: ({ name, headline, subtitle, steps }) => `Clean bright advertising infographic for "${name}": headline at the top in two lines: ${q(headline)}${subtitle ? `, with a small rounded subtitle pill under it: ${q(subtitle)}` : ''}. Below, three equal rounded cards side by side, numbered 1, 2, 3 in blue circles. ${(steps || []).slice(0, 3).map((s, i) => `Card ${i + 1}: a small realistic illustration of this step and the text ${q(s.title)}${s.text ? ` with a short line under it ${q(s.text)}` : ''}.`).join(' ')} ${KEEP} ${TEXT}`,
  },
  parts_breakdown: {
    label: 'شرح أجزاء المنتج', hint: 'المنتج في النص وحواليه دوائر تكبير لكل جزء باسمه', fields: ['headline', 'labels', 'cta'], minLabels: 4, maxLabels: 6,
    build: ({ name, headline, labels, cta }) => `White-background product breakdown image of "${name}": large bold headline at the top: ${q(headline)}. The full product in the center; around it ${(labels || []).length} circular zoom bubbles, each showing a close-up of one real part of the product, connected by a thin line, each with a rounded label pill: ${labelsLine(labels)}. ${cta ? `A wide green rounded banner at the bottom with the text ${q(cta)}.` : ''} ${KEEP} ${TEXT}`,
  },
  app_control: {
    label: 'تحكم من الموبايل', hint: 'شخص ماسك موبايل شاشته فيها المنتج وبالونات كلام', fields: ['headline', 'subtitle', 'labels'], minLabels: 0, maxLabels: 3,
    build: ({ name, headline, subtitle, labels }) => `Bright modern home advertising photo: a man holding a smartphone whose screen shows the live view / app of "${name}", speech bubbles in Egyptian Arabic. Headline at the top in bold: ${q(headline)}${subtitle ? `, subtitle: ${q(subtitle)}` : ''}. ${(labels || []).length ? `Bottom translucent panel with two or three icon + label pairs: ${labelsLine(labels)}.` : ''} The product itself is clearly visible mounted or placed in the scene. ${PEOPLE} ${KEEP} ${TEXT}`,
  },
  problem_solution: {
    label: 'المشكلة والحل', hint: 'سؤال في العنوان وشخص في موقف المشكلة والمنتج هو الحل', fields: ['headline', 'subtitle', 'labels', 'cta'], minLabels: 0, maxLabels: 3,
    build: ({ name, headline, subtitle, labels, cta }) => `Bright advertising image: a person in a realistic everyday situation that shows the problem, and "${name}" clearly shown as the solution in use. Large bold headline as a question at the top left: ${q(headline)}${subtitle ? `, subtitle: ${q(subtitle)}` : ''}. ${(labels || []).length ? `Three small round icons with short labels: ${labelsLine(labels)}.` : ''} ${cta ? `A red rounded call-to-action button at the bottom with an arrow and the text ${q(cta)}.` : ''} ${PEOPLE} ${KEEP} ${TEXT}`,
  },
  offer_cta: {
    label: 'صورة الطلب (زرار أحمر)', hint: 'المنتج وكام ميزة وزرار «اطلبه دلوقتي» أحمر', fields: ['headline', 'subtitle', 'labels', 'cta'], minLabels: 0, maxLabels: 3,
    build: ({ name, headline, subtitle, labels, cta }) => `Bright advertising image for "${name}": the product large and clear on the right side of a clean light-blue/white scene, headline top left in bold with the key words in blue: ${q(headline)}${subtitle ? `, thin subtitle under it: ${q(subtitle)}` : ''}. ${(labels || []).length ? `A row of ${labels.length} rounded benefit chips with icons: ${labelsLine(labels)}.` : ''} A big red rounded button at the bottom with a small arrow and the text ${q(cta || 'اطلبه دلوقتي')}. ${KEEP} ${TEXT}`,
  },
};

export const templateList = () => Object.entries(PAGE_TEMPLATES).map(([id, t]) => ({ id, label: t.label, hint: t.hint, fields: t.fields, minLabels: t.minLabels ?? 0, maxLabels: t.maxLabels ?? 0 }));

/** Pure: the prompt for one image entry. Throws on an unknown template. */
export function buildTemplatePrompt(templateId, ctx) {
  const t = PAGE_TEMPLATES[templateId];
  if (!t) throw new Error(`قالب غير معروف: ${templateId}`);
  return t.build({ ...ctx, labels: (ctx.labels || []).slice(0, t.maxLabels ?? 6), name: ctx.name || 'the product' });
}
