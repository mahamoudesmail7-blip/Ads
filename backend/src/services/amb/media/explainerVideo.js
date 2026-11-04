// AMB Media — EXPLAINER video: a real ~15-20 s product video that SHOWS the device being used and EXPLAINS it, instead of animating one still image.
//   1) script (OpenAI, Egyptian Arabic): per scene a visual to film, a spoken sentence, a short on-screen caption — only from the product facts
//   2) one still per scene (OpenAI image edit of the real product photo; the reference's own text/graphics are ignored)
//   3) each still → a 5 s clip (fal.ai Kling image-to-video)
//   4) one voice-over file per scene (OpenAI text-to-speech) so picture and speech are aligned scene by scene
//   5) ffmpeg: every scene is cut to its voice length (last frame held if the voice is longer), the Arabic caption overlaid, then joined
// Every provider is injectable; nothing is faked — a failing step fails the video with its own message.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateText, TIERS } from '../../aiGateway/index.js';
import { openAiApiKey } from '../../aiGateway/openaiClient.js';
import { getImageProvider } from '../../creativeFactory/imageProvider.js';
import { scanClaims } from '../../creativeFactory/claimsGuard.js';
import { MediaError } from './mediaJobs.js';
import { falImageToVideo, saveRemote } from './aiVideos.js';
import { runFfmpeg, probeDuration } from './ffmpegTools.js';
import { renderCaptionPng, captionsAvailable } from './captions.js';

export const MIN_SCENES = 3, MAX_SCENES = 4;
export const CLIP_SECONDS = 5;
export const OUT_W = 720, OUT_H = 1280;
const TTS_URL = 'https://api.openai.com/v1/audio/speech';
const SCENE_ROLES = ['شخص بيستخدم الجهاز فعلاً في مكان حقيقي (ده أهم مشهد: لازم يبان إزاي بيتستخدم)', 'لقطة قريبة للميزة الأساسية وهي شغّالة', 'اللحظة اللي بيبان فيها الفايدة أو النتيجة بإحساس مريح', 'شكل المنتج كامل بشكل جذاب مع دعوة للطلب'];

/** Pure: how many scenes (clamped 3-4). */
export const sceneCount = (n) => Math.max(MIN_SCENES, Math.min(MAX_SCENES, Number(n) || MIN_SCENES));

const SCRIPT_SYSTEM = 'أنت كاتب فيديوهات إعلانية قصيرة لمتجر مصري. بتكتب بالعامية المصرية الطبيعية. ممنوع: أي ادعاء طبي أو علاجي أو ضمان نتيجة، أي رقم أو نسبة أو مواصفة مش موجودة في المعلومات المعطاة. الفيديو لازم يشرح الجهاز ويوريّ استخدامه. رجّع JSON فقط.';

/** The script. Returns { scenes:[{ visual, voice, caption }] } — validated; throws a MediaError when unusable. */
export async function writeScript({ name, facts = [], scenes, deps = {} }) {
  const n = sceneCount(scenes);
  const user = `المنتج: ${name}\nمعلومات حقيقية عنه (ممنوع تزود عليها):\n${(facts.length ? facts : ['(مفيش معلومات — اشرح بس اللي واضح من اسم المنتج)']).map((f) => `- ${f}`).join('\n')}\n\nاكتب فيديو من ${n} مشاهد (كل مشهد ٥ ثواني). كل مشهد بالترتيب ده:\n${SCENE_ROLES.slice(0, n).map((r, i) => `${i + 1}) ${r}`).join('\n')}\nلكل مشهد: "visual" وصف إنجليزي محدد للي الكاميرا بتصوره (لا يزيد عن ٣٥ كلمة، بدون أي كتابة على الصورة)، "voice" جملة واحدة بالمصري بيقولها المعلّق (من ١٠ لـ ١٦ كلمة) بتشرح الجهاز أو استخدامه، "caption" عنوان قصير على الشاشة (٢ لـ ٥ كلمات). آخر مشهد voice فيه دعوة للطلب.\nJSON: {"scenes":[{"visual":"...","voice":"...","caption":"..."}]}`;
  let j;
  try {
    const out = await (deps.generate || generateText)({ feature: 'amb_media_explainer_script', tier: TIERS.BALANCED, system: SCRIPT_SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: 1200, jsonMode: true });
    j = JSON.parse(out.text);
  } catch (e) { throw new MediaError(e.budgetBlocked ? e.message : 'تعذّر كتابة سكريبت الفيديو — جرّب تاني.', 'SCRIPT_FAILED'); }
  const list = (Array.isArray(j.scenes) ? j.scenes : []).map((s) => ({ visual: String(s.visual || '').replace(/\s+/g, ' ').trim().slice(0, 300), voice: String(s.voice || '').replace(/\s+/g, ' ').trim().slice(0, 200), caption: String(s.caption || '').replace(/\s+/g, ' ').trim().slice(0, 60) })).filter((s) => s.visual && s.voice).slice(0, n);
  if (list.length < MIN_SCENES) throw new MediaError('السكريبت رجع ناقص — جرّب تاني.', 'SCRIPT_FAILED');
  const issues = scanClaims({ items: list.flatMap((s, i) => [{ field: `voice${i + 1}`, text: s.voice }, { field: `caption${i + 1}`, text: s.caption }]), product: { specifications: facts.join('\n'), benefits: facts.join('\n') } }).issues;
  if (issues.length) throw new MediaError(`السكريبت فيه ادعاء محتاج مراجعة (${issues[0].reason}). أضف الميزة الحقيقية في معلومات المنتج وجرّب تاني.`, 'CLAIMS');
  return { scenes: list };
}

const STILL_RULES = 'Photorealistic vertical 9:16 lifestyle photo, natural lighting, realistic Egyptian/Arab person where a person is needed, modest everyday clothing. The device must look EXACTLY like the physical product in the reference photo (shape, color, buttons, proportions). IGNORE any text, icons, graphics, collage or background in the reference photo — use only the physical product itself. No text, captions, watermark or logo in the image.';

export async function makeStill({ visual, name, ref, provider }) {
  const out = await provider.generate({ prompt: `Scene for a product video of "${name}": ${visual}. ${STILL_RULES}`, size: '1024x1536', n: 1, quality: 'medium', referenceImages: [{ b64: ref.buffer.toString('base64'), mime: ref.mime }] });
  const img = out.images[0];
  return { buffer: Buffer.from(img.b64, 'base64'), mime: img.mime || 'image/png', model: out.model };
}

/** OpenAI text-to-speech → mp3 bytes. */
export async function speak({ text, fetchImpl = fetch, key = openAiApiKey() }) {
  if (!key) throw new MediaError('OpenAI مش متظبط — مفيش تعليق صوتي.', 'NOT_CONFIGURED');
  const res = await fetchImpl(TTS_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.AI_TTS_MODEL || 'gpt-4o-mini-tts', voice: process.env.AI_TTS_VOICE || 'ash', input: text, instructions: 'Speak in warm, natural Egyptian Arabic, like a friendly salesperson explaining a product to a customer. Clear and unhurried, smiling tone.', response_format: 'mp3' }), signal: AbortSignal.timeout(90_000) });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    if (res.status === 429) throw new MediaError('OpenAI: الرصيد خلص أو الحد وصل — اشحن وجرّب تاني.', 'OPENAI_BALANCE');
    throw new MediaError(`التعليق الصوتي فشل (${res.status}): ${t.slice(0, 160)}`, 'TTS_FAILED');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new MediaError('التعليق الصوتي رجع فاضي.', 'TTS_FAILED');
  return buf;
}

/** One scene segment: the clip scaled/cropped to 720×1280 and cut (or its last frame held) to the voice length, voice mixed in, caption overlaid. Returns { seconds }. */
export async function buildSegment({ clipPath, voicePath, captionPath = null, outPath, clipSeconds, voiceSeconds, deps = {} }) {
  const seg = Math.max(clipSeconds, voiceSeconds + 0.35);
  const pad = Math.max(0, seg - clipSeconds);
  const vf = `[0:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},fps=30,tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)},format=yuv420p`;
  const filter = captionPath
    ? `${vf}[bg];[bg][2:v]overlay=(W-w)/2:H-h-170:enable='gte(t,0.25)'[v];[1:a]apad,atrim=0:${seg.toFixed(3)}[a]`
    : `${vf}[v];[1:a]apad,atrim=0:${seg.toFixed(3)}[a]`;
  const args = ['-i', clipPath, '-i', voicePath, ...(captionPath ? ['-i', captionPath] : []), '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-t', seg.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', '30', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-movflags', '+faststart', outPath];
  await (deps.runFfmpeg || runFfmpeg)(args);
  return { seconds: seg };
}

/** Join the segments (same codec/size/fps, so a stream copy). */
export async function joinSegments({ segments, listPath, outPath, deps = {} }) {
  const esc = (s) => s.replace(/\\/g, '/').replace(/'/g, "'\\''"); // forward slashes first, THEN quote-escaping (which adds a backslash of its own)
  await fs.promises.writeFile(listPath, segments.map((s) => `file '${esc(s)}'`).join('\n'));
  await (deps.runFfmpeg || runFfmpeg)(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', outPath]);
}

/**
 * The whole explainer. Returns { filePath, dir, cleanup, seconds, scenes, captions } — the caller uploads/stores the file and MUST call cleanup().
 * ref = { buffer, mime } (the real product photo).
 */
export async function runExplainer({ name, facts = [], ref, scenes = 3, captions = true, ctx, deps = {} }) {
  if (!ref) throw new MediaError('ارفع صورة المنتج الأول.', 'NO_PRODUCT_IMAGE');
  const key = deps.falKey;
  if (!key) throw new MediaError('fal.ai مش مربوط — حط المفتاح من لوحة «أدوات الميديا الذكية».', 'NOT_CONFIGURED');
  const provider = (deps.provider || getImageProvider)();
  if (provider.name === 'disabled') throw new MediaError('توليد الصور مش متصل: مفتاح OpenAI مش متظبط أو الرصيد خلص.', 'NOT_CONFIGURED');
  const fetchImpl = deps.fetchImpl || fetch;
  const n = sceneCount(scenes);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'amb-explainer-'));
  const cleanup = () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  const useCaptions = captions && (deps.captionsAvailable ? deps.captionsAvailable() : captionsAvailable());
  try {
    await ctx.progress(4, 'بكتب سكريبت الشرح');
    const script = await (deps.writeScript || writeScript)({ name, facts, scenes: n, deps });
    const parts = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const s = script.scenes[i]; const base = 8 + (i / script.scenes.length) * 80; const span = 80 / script.scenes.length;
      await ctx.progress(base, `مشهد ${i + 1}: بصوّر الصورة`);
      const still = await (deps.makeStill || makeStill)({ visual: s.visual, name, ref, provider });
      ctx.cost('openai-image', Number(deps.stillCostUsd ?? 0.06), 1);
      await ctx.progress(base + span * 0.25, `مشهد ${i + 1}: بحرّك المشهد (بياخد دقايق)`);
      const url = await (deps.falVideo || falImageToVideo)({ key, imageDataUri: `data:${still.mime};base64,${still.buffer.toString('base64')}`, prompt: `${s.visual}. Natural handheld motion, the person demonstrates the device naturally. Keep the product exactly as in the image. Vertical 9:16, no text, no subtitles.`, seconds: CLIP_SECONDS, fetchImpl, pollMs: deps.pollMs });
      ctx.cost('fal-video (تقدير)', Number(deps.clipCostUsd ?? 0.35), 1);
      const clip = await (deps.saveRemote || saveRemote)(url, fetchImpl);
      const clipPath = path.join(dir, `clip${i}.mp4`); await fs.promises.copyFile(clip.filePath, clipPath); await clip.cleanup?.();
      await ctx.progress(base + span * 0.8, `مشهد ${i + 1}: بسجّل الصوت`);
      const voicePath = path.join(dir, `voice${i}.mp3`);
      await fs.promises.writeFile(voicePath, await (deps.speak || speak)({ text: s.voice, fetchImpl }));
      ctx.cost('openai-tts', 0.01, 1);
      let captionPath = null;
      if (useCaptions && s.caption) { const c = (deps.renderCaption || renderCaptionPng)(s.caption); if (c) { captionPath = path.join(dir, `cap${i}.png`); await fs.promises.writeFile(captionPath, c.png); } }
      parts.push({ clipPath, voicePath, captionPath });
    }
    await ctx.progress(90, 'بجمّع الفيديو');
    const segPaths = []; let total = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const clipSeconds = (await (deps.probeDuration || probeDuration)(p.clipPath)) || CLIP_SECONDS;
      const voiceSeconds = (await (deps.probeDuration || probeDuration)(p.voicePath)) || 3;
      const outPath = path.join(dir, `seg${i}.mp4`);
      const { seconds } = await buildSegment({ ...p, outPath, clipSeconds, voiceSeconds, deps });
      total += seconds; segPaths.push(outPath);
    }
    const filePath = path.join(dir, 'explainer.mp4');
    await joinSegments({ segments: segPaths, listPath: path.join(dir, 'list.txt'), outPath: filePath, deps });
    return { filePath, dir, cleanup, seconds: Math.round(total * 10) / 10, scenes: script.scenes, captions: useCaptions };
  } catch (e) { await cleanup(); throw e; }
}
