// Smart Campaign → the campaign step. The builder UI uses the EXISTING launch engine (launchBuilder / launchPublish: validated config, mandatory landing-page proof,
// every campaign created PAUSED, publish only on an explicit confirmation). What is new here is the bridge from the journey to that engine:
//   · launchContext  — which internal Product the Easy Orders product is (the engine needs it), the store, a landing-page guess
//   · registerAssets — put the journey's READY images and AI videos into the launch job's pool (same rows / same Meta upload as the wizard's own uploads)
// Nothing here publishes; the owner's confirmation on the engine's publish endpoint is the only thing that creates anything on Meta.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { prisma } from '../../../prisma.js';
import { listStores } from '../../easyOrdersStores.js';
import { MediaError } from './mediaJobs.js';
import { getProject, getAsset, mutateProject } from './pageProjects.js';
import { addImageToPool, addVideoFileToPool } from './launchAssets.js';

/** Pure: the landing-page address the owner most likely sells from (store domain + product slug). A guess the owner edits — the engine still proves the page belongs to this product. */
export function landingGuess({ domain, slug }) {
  const d = String(domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const s = String(slug || '').trim();
  if (!d || !s) return '';
  return `https://${d}/products/${encodeURIComponent(s)}`;
}

export async function launchContext(projectId, { deps = {} } = {}) {
  const p = await getProject(projectId);
  if (!p) throw new MediaError('المشروع مش موجود.', 'NOT_FOUND');
  if (!p.eo?.id) return { linked: false, reason: 'الصفحة دي مش مربوطة بمنتج من إيزي أوردر — اربطها الأول (الخطوة 1) عشان الكامبين يعرف المنتج.' };
  const syncProducts = deps.listLaunchableProducts || (async (a) => (await import('../launchBuilder.js')).listLaunchableProducts(a));
  await syncProducts({ storeId: p.eo.storeId || null }).catch(() => {}); // auto-creates the internal Product for an Easy Orders item the system has not seen yet
  const product = await prisma.product.findFirst({ where: { easy_orders_uuid: p.eo.id, active: true, is_historical: false }, select: { id: true, product_name: true, store_id: true, easy_orders_uuid: true } });
  const store = listStores().find((s) => s.id === p.eo.storeId) || null;
  return {
    linked: true, found: !!product,
    productId: product?.id ?? null, productName: product?.product_name ?? null, storeId: product?.store_id ?? p.eo.storeId ?? null,
    storeName: store?.name ?? null, landingGuess: landingGuess({ domain: store?.domain, slug: p.eo.slug }),
    reason: product ? null : 'المنتج ده لسه مش في كتالوج السيستم — جرّب تحدّث قايمة المنتجات من «رفع الكامبين» وارجع.',
  };
}

const tmpFile = async (buf, ext) => { const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'smartvid-')); const f = path.join(dir, `v-${crypto.randomBytes(4).toString('hex')}${ext}`); await fs.promises.writeFile(f, buf); return { f, dir }; };

/**
 * Registers every READY image and every stored AI video of the journey in the launch job's creative pool. Idempotent: the same bytes are never uploaded to Meta twice
 * (addImageToPool / addVideoFileToPool dedupe by content hash). One bad asset never stops the rest.
 */
export async function runRegisterAssets({ projectId, launchJobId, ctx, deps = {} }) {
  const p = await getProject(projectId);
  if (!p) throw new MediaError('المشروع مش موجود.', 'NOT_FOUND');
  const job = await prisma.ambLaunchJob.findUnique({ where: { job_id: launchJobId }, select: { job_id: true } });
  if (!job) throw new MediaError('طلب الرفع مش موجود — ابدأ الكامبين الأول.', 'NOT_FOUND');
  const images = (p.images || []).filter((i) => i.status === 'READY');
  const videos = (p.videos || []).filter((v) => v.kind === 'AI');
  if (!images.length && !videos.length) throw new MediaError('مفيش صور أو فيديوهات جاهزة في الرحلة دي.', 'NOTHING_READY');
  const addImage = deps.addImage || addImageToPool, addVideo = deps.addVideo || addVideoFileToPool, getBlob = deps.getAsset || getAsset;
  const out = { images: [], videos: [], failed: [] }; const total = images.length + videos.length; let done = 0;
  for (const img of images) {
    await ctx.progress(Math.round((done / total) * 95), `صورة ${done + 1} من ${total}`);
    try {
      const a = await getBlob(projectId, img.id); if (!a) throw new Error('ملف الصورة مش موجود.');
      const r = await addImage({ launchJobId, buffer: a.data, filename: `page-${img.id}.${/jpe?g/.test(a.mime) ? 'jpg' : 'png'}`, mime: a.mime, deps: deps.assets });
      out.images.push({ id: img.id, slotKey: r.slotKey, deduped: !!r.deduped });
    } catch (e) { out.failed.push({ id: img.id, kind: 'image', error: e.message }); }
    done++;
  }
  for (const v of videos) {
    await ctx.progress(Math.round((done / total) * 95), `فيديو ${done - images.length + 1} من ${videos.length}`);
    let tmp = null;
    try {
      const a = await getBlob(projectId, v.id); if (!a) throw new Error('ملف الفيديو مش موجود.');
      tmp = await tmpFile(a.data, '.mp4');
      const r = await addVideo({ launchJobId, filePath: tmp.f, filename: `${v.id}.mp4`, durationSeconds: v.seconds || null, deps: deps.assets });
      out.videos.push({ id: v.id, slotKey: r.slotKey, deduped: !!r.deduped });
    } catch (e) { out.failed.push({ id: v.id, kind: 'video', error: e.message }); }
    finally { if (tmp) await fs.promises.rm(tmp.dir, { recursive: true, force: true }).catch(() => {}); }
    done++;
  }
  if (!out.images.length && !out.videos.length) throw new MediaError(out.failed[0]?.error || 'ما اتسجّلش أي ملف.', 'NO_ASSETS');
  await mutateProject(projectId, (proj) => { proj.smart = { ...(proj.smart || {}), launch: { ...(proj.smart?.launch || {}), jobId: launchJobId, assetsAt: new Date().toISOString(), assets: { images: out.images.length, videos: out.videos.length } } }; });
  return out;
}

/** Remember the launch job (and its latest known status) on the journey so the step bar and the "continue" button know where the campaign is. */
export function linkLaunch(projectId, { jobId, status = null }) {
  if (!/^[a-z0-9_-]{8,80}$/i.test(String(jobId || ''))) throw new MediaError('معرّف طلب الرفع غير صالح.', 'BAD_INPUT');
  return mutateProject(projectId, (proj) => { proj.smart = { ...(proj.smart || {}), launch: { ...(proj.smart?.launch || {}), jobId, status: status || proj.smart?.launch?.status || 'DRAFT', at: new Date().toISOString() } }; return proj.smart.launch; });
}
