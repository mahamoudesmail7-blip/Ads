// AMB Media — the VIDEOS section of a product-page project: short AI clips (fal.ai) made from the project's photo, and a search for existing
// product videos (same finder as the launch wizard, fed with the project's name + photo instead of a launch job). Videos are kept in the project
// (AI clips as stored files, found ones as links) — nothing is uploaded to Meta from here.
import { getMediaKey } from './mediaKeys.js';
import { MediaError } from './mediaJobs.js';
import { falImageToVideo, buildMotionPrompt, saveRemote, AI_STYLES, MAX_AI_VIDEOS } from './aiVideos.js';
import { runVideoFinder } from './videoFinder.js';
import { getProject, loadReference, addVideoFile } from './pageProjects.js';
import fs from 'node:fs';

export async function runPageAiVideos({ projectId, count = 1, seconds = 5, style = 'ugc', ctx, deps = {} }) {
  const n = Math.max(1, Math.min(MAX_AI_VIDEOS, Number(count) || 1));
  const secs = Number(seconds) === 10 ? 10 : 5;
  const key = await (deps.getKey || getMediaKey)('fal');
  if (!key) throw new MediaError('fal.ai مش مربوط — حط المفتاح من لوحة «أدوات الميديا الذكية».', 'NOT_CONFIGURED');
  const p = await getProject(projectId); if (!p) throw new MediaError('المشروع مش موجود.', 'NOT_FOUND');
  const ref = await (deps.loadReference || loadReference)(projectId);
  if (!ref) throw new MediaError('ارفع صورة المنتج الأول (القسم 1).', 'NO_PRODUCT_IMAGE');
  const dataUri = `data:${ref.mime};base64,${ref.buffer.toString('base64')}`;
  const fetchImpl = deps.fetchImpl || fetch;
  const styleId = AI_STYLES[style] ? style : 'ugc';

  const added = [], failed = [];
  for (let i = 0; i < n; i++) {
    await ctx.progress((i / n) * 95, `فيديو ${i + 1} من ${n} — التوليد بياخد دقايق`);
    let file = null;
    try {
      const url = await (deps.falVideo || falImageToVideo)({ key, imageDataUri: dataUri, prompt: buildMotionPrompt({ name: p.name, style: styleId, scene: deps.scenes?.[i] || null }), seconds: secs, fetchImpl, pollMs: deps.pollMs });
      ctx.cost('fal-video (تقدير)', Number(deps.estimateUsd ?? 0.35 * (secs / 5)), 1);
      file = await saveRemote(url, fetchImpl);
      const v = await (deps.addFile || addVideoFile)(projectId, { buffer: await fs.promises.readFile(file.filePath), seconds: secs, style: styleId, prompt: '' });
      added.push(v.id);
    } catch (e) {
      failed.push({ index: i + 1, error: e.message });
      if (['FAL_BALANCE', 'FAL_KEY'].includes(e.code)) { if (!added.length) throw e; break; }
    } finally { await file?.cleanup?.(); }
  }
  if (!added.length) throw new MediaError(failed[0]?.error || 'ما اتولّدش أي فيديو.', 'NO_VIDEOS');
  return { added, failed, note: 'فيديو قصير من صورة المنتج بدون صوت أو ترجمة.' };
}

/** Search existing videos for the project's product — returns the finder's result (candidates to pick from; nothing is downloaded). */
export async function runPageVideoFinder({ projectId, target = 12, manualUrls = [], ctx, deps = {} }) {
  const p = await getProject(projectId); if (!p) throw new MediaError('المشروع مش موجود.', 'NOT_FOUND');
  const ref = await (deps.loadReference || loadReference)(projectId);
  return runVideoFinder({ launchJobId: projectId, target, manualUrls, ctx, deps: { ...deps, resolveProduct: async () => ({ product: { id: null, name: p.name }, image: ref }) } });
}
