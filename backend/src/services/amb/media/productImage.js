// AMB Media — resolves the product a launch job is for: its name and its real reference photo (bytes).
// Reuses the product-image resolver the Scale Center already trusts (AmbProduct.image_url → Easy Orders thumb → research image → manual upload).
// Nothing is invented: no photo → a clear error asking for one, never a stock image.
import { prisma } from '../../../prisma.js';
import { resolveProductImage, getManualProductImage } from '../ambProducts.js';
import { MediaError } from './mediaJobs.js';

const MAX_BYTES = 8 * 1024 * 1024;

export async function fetchImageBytes(url, { fetchImpl = fetch, base = null } = {}) {
  let u;
  try { u = new URL(url, base || undefined); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_BYTES) return null;
  const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  return /^image\//.test(mime) ? { buffer, mime } : null;
}

/** { jobRow, product:{id,name}, image:{buffer,mime}|null } for the wizard job. Throws a user-facing MediaError when the job/product is missing. */
export async function resolveJobProduct(launchJobId, { fetchImpl = fetch, baseUrl = null } = {}) {
  const job = await prisma.ambLaunchJob.findUnique({ where: { job_id: String(launchJobId || '') }, select: { job_id: true, product_id: true, ad_account_id: true } });
  if (!job) throw new MediaError('طلب الرفع مش موجود — ارجع للخطوة الأولى.', 'NOT_FOUND');
  if (!job.product_id) throw new MediaError('اختار المنتج الأول (الخطوة 1).', 'BAD_INPUT');
  const product = await prisma.product.findUnique({ where: { id: job.product_id }, select: { id: true, product_name: true } });
  if (!product) throw new MediaError('المنتج مش موجود.', 'NOT_FOUND');

  let image = null;
  const amb = await prisma.ambProduct.findFirst({ where: { product_id: product.id }, orderBy: { id: 'desc' }, select: { id: true } });
  if (amb) {
    try {
      const r = await resolveProductImage(amb.id);
      if (r.data) image = { buffer: r.data, mime: r.contentType || 'image/jpeg' };
      else if (r.redirect) {
        image = await fetchImageBytes(r.redirect, { fetchImpl, base: baseUrl });
        if (image && /^https?:\/\//i.test(r.redirect)) image.url = r.redirect; // a PUBLIC url of the photo (CDN) — Google Lens can take it directly
      }
    } catch { /* fall through to the manual image */ }
  }
  if (!image) {
    const m = await getManualProductImage(product.id);
    if (m.data) image = { buffer: m.data, mime: m.contentType || 'image/png' };
  }
  return { job, product: { id: product.id, name: product.product_name }, image };
}

export function requireImage(ctx) {
  if (!ctx.image) throw new MediaError('مفيش صورة للمنتج ده في السيستم — اضغط «ارفع صورة المنتج» فوق وجرّب تاني.', 'NO_PRODUCT_IMAGE');
  return ctx.image;
}
