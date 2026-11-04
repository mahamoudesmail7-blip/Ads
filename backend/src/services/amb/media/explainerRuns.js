// AMB Media — runs the EXPLAINER video for a launch job's creative pool, or for a product-page project. (Kept apart from aiVideos.js /
// pageVideos.js, which explainerVideo.js itself imports from.) Each finished video is uploaded/stored, then its temp folder removed.
import fs from 'node:fs';
import { getMediaKey } from './mediaKeys.js';
import { MediaError } from './mediaJobs.js';
import { resolveJobProduct, requireImage } from './productImage.js';
import { addVideoFileToPool } from './launchAssets.js';
import { getProject, loadReference, addVideoFile } from './pageProjects.js';
import { runExplainer, sceneCount } from './explainerVideo.js';

export const MAX_EXPLAINERS = 2;
const clampCount = (n) => Math.max(1, Math.min(MAX_EXPLAINERS, Number(n) || 1));
const cleanFacts = (f) => (Array.isArray(f) ? f : String(f || '').split(/\r?\n/)).map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 20);

async function falKeyOrThrow(deps) {
  const key = await (deps.getKey || getMediaKey)('fal');
  if (!key) throw new MediaError('fal.ai مش مربوط — حط المفتاح من لوحة «أدوات الميديا الذكية».', 'NOT_CONFIGURED');
  return key;
}

/** Generic loop: make `count` explainers, hand each file to `store(file)`, collect added/failed; a billing/key error stops the run. */
async function loop({ count, make, store, ctx }) {
  const added = [], failed = [];
  for (let i = 0; i < count; i++) {
    await ctx.progress((i / count) * 95, `فيديو شرح ${i + 1} من ${count} — بياخد عدة دقايق`);
    let out = null;
    try {
      out = await make(i);
      added.push(await store(out, i));
    } catch (e) {
      failed.push({ index: i + 1, error: e.message });
      if (['FAL_BALANCE', 'FAL_KEY', 'OPENAI_BALANCE', 'NOT_CONFIGURED', 'FFMPEG_MISSING', 'CLAIMS'].includes(e.code)) { if (!added.length) throw e; break; }
    } finally { await out?.cleanup?.(); }
  }
  if (!added.length) throw new MediaError(failed[0]?.error || 'ما اتعملش أي فيديو شرح.', 'NO_VIDEOS');
  return { added, failed, note: 'فيديو شرح: مشاهد استخدام + تعليق صوتي بالمصري + ترجمة عربي.' };
}

export async function runExplainerForPool({ launchJobId, count = 1, scenes = 3, facts = [], captions = true, ctx, deps = {} }) {
  const falKey = await falKeyOrThrow(deps);
  const pc = await (deps.resolveProduct || resolveJobProduct)(launchJobId);
  const ref = requireImage(pc);
  const f = cleanFacts(facts);
  return loop({ count: clampCount(count), ctx,
    make: () => runExplainer({ name: pc.product.name, facts: f, ref, scenes: sceneCount(scenes), captions, ctx, deps: { ...deps, falKey } }),
    store: async (out, i) => { const r = await (deps.addVideo || addVideoFileToPool)({ launchJobId, filePath: out.filePath, filename: `explainer-${i + 1}.mp4`, durationSeconds: Math.round(out.seconds) }); return { slotKey: r.slotKey, videoId: r.videoId, seconds: out.seconds }; } });
}

export async function runExplainerForPage({ projectId, count = 1, scenes = 3, captions = true, ctx, deps = {} }) {
  const falKey = await falKeyOrThrow(deps);
  const p = await getProject(projectId); if (!p) throw new MediaError('المشروع مش موجود.', 'NOT_FOUND');
  const ref = await (deps.loadReference || loadReference)(projectId);
  if (!ref) throw new MediaError('ارفع صورة المنتج الأول (القسم 1).', 'NO_PRODUCT_IMAGE');
  return loop({ count: clampCount(count), ctx,
    make: () => runExplainer({ name: p.name, facts: p.facts || [], ref, scenes: sceneCount(scenes), captions, ctx, deps: { ...deps, falKey } }),
    store: async (out) => { const v = await (deps.addFile || addVideoFile)(projectId, { buffer: await fs.promises.readFile(out.filePath), seconds: Math.round(out.seconds), style: 'explainer', prompt: out.scenes.map((s) => s.voice).join(' ') }); return v.id; } });
}
