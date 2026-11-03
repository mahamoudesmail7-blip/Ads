// AMB Media — Phase 3: short AI videos made FROM the product photo (fal.ai image-to-video, Kling), uploaded into the wizard's pool.
// SCOPE (honest): one 5/10 s vertical clip per video, no voice-over, subtitles or edited montage — those need the full UGC pipeline of the spec
// (script + TTS + lip-sync + ffmpeg editing), which is not built. fal.ai's request format here follows its public queue API but could NOT be
// exercised without a real key: the first live run is the real test, and every failure is reported as-is (never faked).
import { generateText, TIERS, isAiConfigured } from '../../aiGateway/index.js';
import { getMediaKey } from './mediaKeys.js';
import { MediaError } from './mediaJobs.js';
import { resolveJobProduct, requireImage } from './productImage.js';
import { addVideoFileToPool } from './launchAssets.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_AI_VIDEOS = 3;
export const AI_STYLES = { ugc: 'handheld smartphone UGC style, natural light', demo: 'clean product demo, close-ups of the product being used', lifestyle: 'cozy lifestyle scene at home' };
const FAL_MODEL = () => process.env.FAL_VIDEO_MODEL || 'fal-ai/kling-video/v3/pro/image-to-video';
const FAL_HOSTS = /(^|\.)(fal\.media|fal\.run|googleapis\.com)$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function falError(status, text) {
  const t = String(text || '').slice(0, 200);
  if (status === 402 || /TOP_UP|locked|balance/i.test(t)) return new MediaError('fal.ai: الرصيد خلص — اشحن من fal.ai/dashboard/billing.', 'FAL_BALANCE');
  if (status === 401 || status === 403) return new MediaError('fal.ai: المفتاح غلط أو مرفوض.', 'FAL_KEY');
  if (status === 429) return new MediaError('fal.ai: طلبات كتير — جرّب بعد شوية.', 'FAL_RATE');
  return new MediaError(`fal.ai ردّ بخطأ ${status}: ${t}`, 'FAL_HTTP');
}

/** Pure: the motion prompt for one clip (the AI-written scene when available, else a plain template). */
export function buildMotionPrompt({ name, style = 'ugc', scene = null }) {
  const base = scene || `A person naturally showing and using the product "${name}"`;
  return `${base}. ${AI_STYLES[style] || AI_STYLES.ugc}. Keep the product exactly as in the image (shape, color, logo). Vertical 9:16, no text overlays, no subtitles.`;
}

async function sceneIdeas({ name, count, style }) {
  if (!isAiConfigured()) return [];
  try {
    const out = await generateText({ feature: 'amb_media_ai_video_scenes', tier: TIERS.ROUTINE, messages: [{ role: 'user', content: [{ type: 'text', text: `Product: ${name}. Write ${count} DIFFERENT one-sentence video scene descriptions (what the camera sees, what the person does with the product), style: ${AI_STYLES[style] || AI_STYLES.ugc}. JSON only: {"scenes":["..."]}` }] }], maxTokens: 500, jsonMode: true });
    return (JSON.parse(out.text).scenes || []).map(String).filter(Boolean);
  } catch { return []; }
}

/** One fal queue job: submit → poll → returns the result video URL. `fetchImpl` is injectable for tests. */
export async function falImageToVideo({ key, imageDataUri, prompt, seconds, fetchImpl = fetch, pollMs = 5000, maxWaitMs = 12 * 60_000 }) {
  const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
  const sub = await fetchImpl(`https://queue.fal.run/${FAL_MODEL()}`, { method: 'POST', headers, body: JSON.stringify({ prompt, image_url: imageDataUri, duration: String(seconds), aspect_ratio: '9:16' }), signal: AbortSignal.timeout(60_000) });
  const subText = await sub.text();
  if (!sub.ok) throw falError(sub.status, subText);
  const q = JSON.parse(subText);
  if (!q.status_url || !q.response_url) throw new MediaError('رد غير مفهوم من fal.ai.', 'FAL_BAD_RESPONSE');
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const st = await fetchImpl(q.status_url, { headers, signal: AbortSignal.timeout(30_000) });
    const stj = await st.json().catch(() => ({}));
    if (!st.ok) throw falError(st.status, JSON.stringify(stj));
    if (stj.status === 'COMPLETED') break;
    if (stj.status === 'FAILED' || stj.status === 'ERROR') throw new MediaError('fal.ai: التوليد فشل.', 'FAL_FAILED');
    if (Date.now() > deadline) throw new MediaError('fal.ai: التوليد أخد وقت طويل وانلغى.', 'FAL_TIMEOUT');
    await sleep(pollMs);
  }
  const res = await fetchImpl(q.response_url, { headers, signal: AbortSignal.timeout(30_000) });
  const resText = await res.text();
  if (!res.ok) throw falError(res.status, resText);
  const url = JSON.parse(resText)?.video?.url;
  if (!url) throw new MediaError('fal.ai ما رجّعش فيديو.', 'FAL_EMPTY');
  return url;
}

export async function saveRemote(url, fetchImpl) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !FAL_HOSTS.test(u.hostname)) throw new MediaError('رابط الفيديو الناتج مش من سيرفرات fal المعروفة.', 'BAD_URL');
  const res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new MediaError(`تنزيل الفيديو الناتج فشل (${res.status}).`, 'DOWNLOAD_FAIL');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'amb-ai-'));
  const filePath = path.join(dir, 'video.mp4');
  await fs.promises.writeFile(filePath, Buffer.from(await res.arrayBuffer()));
  return { filePath, cleanup: () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}) };
}

export async function runAiVideos({ launchJobId, count = 1, seconds = 5, style = 'ugc', ctx, deps = {} }) {
  const n = Math.max(1, Math.min(MAX_AI_VIDEOS, Number(count) || 1));
  const secs = Number(seconds) === 10 ? 10 : 5;
  const key = await (deps.getKey || getMediaKey)('fal');
  if (!key) throw new MediaError('fal.ai مش مربوط — حط المفتاح من لوحة «أدوات الميديا الذكية».', 'NOT_CONFIGURED');
  const pc = await (deps.resolveProduct || resolveJobProduct)(launchJobId);
  const img = requireImage(pc);
  const dataUri = `data:${img.mime};base64,${img.buffer.toString('base64')}`;
  const scenes = await (deps.scenes || sceneIdeas)({ name: pc.product.name, count: n, style });
  const fetchImpl = deps.fetchImpl || fetch;

  const added = [], failed = [];
  for (let i = 0; i < n; i++) {
    await ctx.progress((i / n) * 95, `فيديو ${i + 1} من ${n} — التوليد بياخد دقايق`);
    let file = null;
    try {
      const url = await (deps.falVideo || falImageToVideo)({ key, imageDataUri: dataUri, prompt: buildMotionPrompt({ name: pc.product.name, style, scene: scenes[i] || null }), seconds: secs, fetchImpl, pollMs: deps.pollMs });
      ctx.cost('fal-video (تقدير)', Number(deps.estimateUsd ?? 0.35 * (secs / 5)), 1);
      file = await saveRemote(url, fetchImpl);
      const r = await (deps.addVideo || addVideoFileToPool)({ launchJobId, filePath: file.filePath, filename: `ai-video-${i + 1}.mp4`, durationSeconds: secs });
      added.push({ slotKey: r.slotKey, videoId: r.videoId });
    } catch (e) {
      failed.push({ index: i + 1, error: e.message });
      if (['FAL_BALANCE', 'FAL_KEY'].includes(e.code)) { if (!added.length) throw e; break; }
    } finally { await file?.cleanup?.(); }
  }
  if (!added.length) throw new MediaError(failed[0]?.error || 'ما اتولّدش أي فيديو.', 'NO_VIDEOS');
  return { added, failed, product: pc.product.name, seconds: secs, note: 'فيديو قصير من صورة المنتج بدون صوت أو ترجمة.' };
}
