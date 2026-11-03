// AMB Media — Phase 1: AI product images for the launch wizard's creative pool.
// Reuses the Creative Factory image provider (OpenAI images edit with the REAL product photo as the reference), the gateway's monthly
// budget guard and usage log, and uploads each result straight to the job's ad account. Mock-safe: with no OpenAI key/credit the job
// FAILS with a clear Arabic message and nothing is ever faked.
import { getImageProvider } from '../../creativeFactory/imageProvider.js';
import { checkImageBudget, logImageUsage, estimateImageCostUsd } from '../../aiGateway/index.js';
import { MediaError } from './mediaJobs.js';
import { resolveJobProduct, requireImage } from './productImage.js';
import { addImageToPool } from './launchAssets.js';

export const MAX_PAGE_IMAGES = 6;
export const PAGE_IMAGE_STYLES = {
  clean: { label: 'خلفية نضيفة', scenes: ['the product centered on a clean soft-gradient studio background, premium e-commerce hero shot', 'the product on a light surface with soft natural shadow, minimal, bright', 'a tight close-up of the product showing its main feature, shallow depth of field'] },
  lifestyle: { label: 'استخدام حقيقي', scenes: ['the product in a realistic Egyptian home setting, natural daylight, lifestyle photo', 'a person using the product naturally at home, candid, warm light', 'the product on a living-room table with everyday items around it, lifestyle photo'] },
  benefit: { label: 'مميزات', scenes: ['the product with 3 simple callout zones around it (leave clean empty space for Arabic text), bright background', 'the product in a before/after style composition (leave empty space for text), clean look', 'the product shown with the key accessory or package contents laid out neatly, top view'] },
};
const RULES = 'Keep the product EXACTLY as in the reference photo: same shape, color, buttons, logo and proportions. Do not add any text, watermark or logo. Photorealistic, sharp, 1:1 square.';

/** Pure: n distinct prompts for a product + style (cycles the scene list). */
export function buildPagePrompts({ name, style = 'clean', count = 3 }) {
  const st = PAGE_IMAGE_STYLES[style] || PAGE_IMAGE_STYLES.clean;
  return Array.from({ length: count }, (_, i) => `Product advertising image of "${name}": ${st.scenes[i % st.scenes.length]}. ${RULES}`);
}

export async function runPageImages({ launchJobId, count = 3, style = 'clean', ctx, deps = {} }) {
  const n = Math.max(1, Math.min(MAX_PAGE_IMAGES, Number(count) || 3));
  const pc = await (deps.resolveProduct || resolveJobProduct)(launchJobId);
  const ref = requireImage(pc);
  const provider = (deps.provider || getImageProvider)();
  if (provider.name === 'disabled') throw new MediaError('توليد الصور مش متصل: مفتاح OpenAI مش متظبط (OPENAI_API_KEY) أو الرصيد خلص. اشحن الرصيد وجرّب تاني.', 'NOT_CONFIGURED');
  const budget = await (deps.checkBudget || checkImageBudget)();
  if (budget.blocked) throw new MediaError(`وصلت للحد الشهري لميزانية الذكاء الاصطناعي (${budget.spentUsd}$ من ${budget.budgetUsd}$).`, 'BUDGET');

  const prompts = buildPagePrompts({ name: pc.product.name, style, count: n });
  const added = []; const failed = [];
  for (let i = 0; i < prompts.length; i++) {
    await ctx.progress((i / prompts.length) * 95, `صورة ${i + 1} من ${prompts.length}`);
    try {
      const out = await provider.generate({ prompt: prompts[i], size: '1024x1024', n: 1, referenceImages: [{ b64: ref.buffer.toString('base64'), mime: ref.mime }] });
      const img = out.images[0];
      const usd = Number(await (deps.estimateCost || estimateImageCostUsd)({ size: '1024x1024', count: 1 }).catch(() => 0)) || 0;
      ctx.cost('openai-image', usd, 1);
      Promise.resolve((deps.logUsage || logImageUsage)({ feature: 'amb_media_page_image', model: out.model, productId: pc.product.id, generationType: 'edit', imageCount: 1, size: '1024x1024', status: 'SUCCESS', estimatedCostUsd: usd || null, durationMs: out.durationMs })).catch(() => {});
      const a = await addImageToPool({ launchJobId, buffer: Buffer.from(img.b64, 'base64'), filename: `ai-page-${i + 1}.png`, mime: img.mime || 'image/png', width: 1024, height: 1024, deps: deps.assets });
      added.push(a.slotKey);
    } catch (e) {
      failed.push({ index: i + 1, error: e.message });
      if (e.code === 'PROVIDER_NOT_CONFIGURED' || e.httpStatus === 401 || e.httpStatus === 429) { if (!added.length) throw new MediaError(e.httpStatus === 429 ? 'OpenAI: الرصيد خلص أو الحد وصل — اشحن وجرّب تاني.' : e.message, e.httpStatus === 429 ? 'OPENAI_BALANCE' : (e.code || 'PROVIDER'), {}); break; }
    }
  }
  if (!added.length) throw new MediaError(failed[0]?.error || 'ما اتولّدتش أي صورة.', 'NO_IMAGES');
  return { added, failed, product: pc.product.name };
}
