// 🧪 AMB Media — the EXPLAINER video: script validation (claims), TTS errors, per-scene assembly with the REAL ffmpeg (synthetic clips + tone "voice"),
// caption rendering, the pool / page runners and temp-folder cleanup. Every provider is injected — no network, no OpenAI/fal call.
//   node src/scripts/explainerVideoTest.js
import './_testGuard.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0, skipped = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 220) : ''}`); } };
const skip = (label) => { skipped++; console.log(`  - skipped: ${label}`); };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

const { prisma } = await imp('../prisma.js');
const FF = await imp('../services/amb/media/ffmpegTools.js');
const CAP = await imp('../services/amb/media/captions.js');
const EX = await imp('../services/amb/media/explainerVideo.js');
const ER = await imp('../services/amb/media/explainerRuns.js');
const PP = await imp('../services/amb/media/pageProjects.js');
const J = await imp('../services/amb/media/mediaJobs.js');
const ctx = { progress: async () => {}, cost: () => {} };
const hasFfmpeg = spawnSync(FF.ffmpegPath(), ['-version']).status === 0;
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'exp-test-'));
const made = [];

const scriptOk = { scenes: [{ visual: 'A woman uses the device at home', voice: 'ده الجهاز اللي هيسهّل عليك روتينك اليومي', caption: 'سهل الاستخدام' }, { visual: 'Close-up of the feature working', voice: 'بزرار واحد بتشغّله وبيشتغل على طول', caption: 'تشغيل بزرار' }, { visual: 'Smiling result moment', voice: 'اطلبه دلوقتي وخليه عندك', caption: 'اطلبه دلوقتي' }] };

try {
  console.log('\n[1] pure helpers');
  ok('scene count is clamped to 3..4', EX.sceneCount(1) === 3 && EX.sceneCount(9) === 4 && EX.sceneCount(4) === 4 && EX.sceneCount('x') === 3);
  ok('parseDuration reads ffmpeg output', FF.parseDuration('  Duration: 00:01:05.50, start: 0.0') === 65.5 && FF.parseDuration('nothing') === null);
  const widths = (s) => s.length * 10;
  ok('wrapWords: fits → one line; long → at most 2 lines, no word lost', (() => { const w = 'كلمة '.repeat(12).trim().split(' '); const l = CAP.wrapWords(w, widths, 150, 2); return CAP.wrapWords(['أ', 'ب'], widths, 150).length === 1 && l.length === 2 && l.join(' ').split(' ').length === 12; })());

  console.log('\n[2] script');
  let s = await EX.writeScript({ name: 'جهاز', facts: ['بطارية قابلة للشحن'], scenes: 3, deps: { generate: async () => ({ text: JSON.stringify(scriptOk) }) } });
  ok('valid script accepted (3 scenes with visual / voice / caption)', s.scenes.length === 3 && s.scenes.every((x) => x.visual && x.voice && x.caption));
  let seenPrompt = null;
  await EX.writeScript({ name: 'فرشاة', facts: ['رشاش مدمج', 'بطارية'], scenes: 4, deps: { generate: async (a) => { seenPrompt = a; return { text: JSON.stringify({ scenes: [...scriptOk.scenes, scriptOk.scenes[0]] }) }; } } });
  const up = seenPrompt.messages[0].content[0].text;
  ok('the prompt carries the real facts, asks for a usage scene first and forbids invented claims', /رشاش مدمج/.test(up) && /بيستخدم الجهاز فعلاً/.test(up) && /ممنوع/.test(seenPrompt.system) && /4 مشاهد/.test(up) && /4\) /.test(up));
  let e = await rejects(EX.writeScript({ name: 'x', facts: [], scenes: 3, deps: { generate: async () => ({ text: JSON.stringify({ scenes: [scriptOk.scenes[0]] }) }) } }));
  ok('a script with fewer than 3 usable scenes → SCRIPT_FAILED', e?.code === 'SCRIPT_FAILED');
  e = await rejects(EX.writeScript({ name: 'x', facts: [], scenes: 3, deps: { generate: async () => ({ text: 'garbage' }) } }));
  ok('garbage from the model → SCRIPT_FAILED', e?.code === 'SCRIPT_FAILED');
  e = await rejects(EX.writeScript({ name: 'x', facts: ['بلوتوث'], scenes: 3, deps: { generate: async () => ({ text: JSON.stringify({ scenes: scriptOk.scenes.map((x, i) => (i === 1 ? { ...x, voice: 'نتيجة مضمونة 100% من أول مرة' } : x)) }) }) } }));
  ok('an unsupported claim in the voice-over blocks the video (CLAIMS)', e?.code === 'CLAIMS');

  console.log('\n[3] voice-over');
  e = await rejects(EX.speak({ text: 'مرحبا', key: '' }));
  ok('no OpenAI key → NOT_CONFIGURED', e?.code === 'NOT_CONFIGURED');
  e = await rejects(EX.speak({ text: 'مرحبا', key: 'k', fetchImpl: async () => ({ ok: false, status: 429, text: async () => '' }) }));
  ok('429 → OPENAI_BALANCE (Arabic)', e?.code === 'OPENAI_BALANCE' && /الرصيد/.test(e.message));
  let ttsBody = null;
  const mp3 = await EX.speak({ text: 'مرحبا بيك', key: 'k', fetchImpl: async (url, init) => { ttsBody = JSON.parse(init.body); return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; } });
  ok('TTS request: mp3, Egyptian-Arabic instructions, the scene sentence as input', mp3.length === 3 && ttsBody.response_format === 'mp3' && /Egyptian/.test(ttsBody.instructions) && ttsBody.input === 'مرحبا بيك' && !!ttsBody.model);
  e = await rejects(EX.speak({ text: 'x', key: 'k', fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }) }));
  ok('an empty audio response → TTS_FAILED', e?.code === 'TTS_FAILED');

  console.log('\n[4] captions');
  if (CAP.captionsAvailable()) {
    const c = CAP.renderCaptionPng('سهل الاستخدام وبسيط جداً في كل مكان');
    ok('caption PNG rendered (valid PNG, width 640, grows with lines)', c && c.png.subarray(1, 4).toString() === 'PNG' && c.width === 640 && c.height > 60, c && JSON.stringify([c.width, c.height]));
    ok('empty text → no caption', CAP.renderCaptionPng('   ') === null);
  } else { skip('captions (canvas/font stack not available here)'); ok('captionsAvailable() reports false without throwing', CAP.captionsAvailable() === false); }

  console.log('\n[5] real ffmpeg assembly');
  const info = (file) => { const r = spawnSync(FF.ffmpegPath(), ['-hide_banner', '-i', file], { encoding: 'utf8' }); return r.stderr || ''; };
  const synth = async (file, secs, { audio = false } = {}) => FF.runFfmpeg(['-f', 'lavfi', '-i', `testsrc=size=540x960:rate=24:duration=${secs}`, ...(audio ? ['-f', 'lavfi', '-i', `anoisesrc=d=${secs}`, '-c:a', 'aac'] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(secs), file]);
  const tone = async (file, secs) => FF.runFfmpeg(['-f', 'lavfi', '-i', `sine=frequency=330:duration=${secs}`, '-c:a', 'libmp3lame', file]);
  if (!hasFfmpeg) { skip('ffmpeg binary not available — assembly tests'); } else {
    const clip = path.join(tmp, 'c.mp4'), v1 = path.join(tmp, 'v1.mp3'), v2 = path.join(tmp, 'v2.mp3');
    await synth(clip, 5, { audio: true }); await tone(v1, 3.2); await tone(v2, 6.1);
    ok('probeDuration on real files', Math.abs((await FF.probeDuration(clip)) - 5) < 0.2 && Math.abs((await FF.probeDuration(v1)) - 3.2) < 0.2);
    const capPng = CAP.captionsAvailable() ? path.join(tmp, 'cap.png') : null; if (capPng) await fs.promises.writeFile(capPng, CAP.renderCaptionPng('اطلبه دلوقتي').png);
    const seg1 = path.join(tmp, 's1.mp4'), seg2 = path.join(tmp, 's2.mp4');
    const r1 = await EX.buildSegment({ clipPath: clip, voicePath: v1, captionPath: capPng, outPath: seg1, clipSeconds: 5, voiceSeconds: 3.2 });
    const r2 = await EX.buildSegment({ clipPath: clip, voicePath: v2, captionPath: null, outPath: seg2, clipSeconds: 5, voiceSeconds: 6.1 });
    ok('voice shorter than the clip → the segment keeps the clip length (5 s)', Math.abs(r1.seconds - 5) < 0.01 && Math.abs((await FF.probeDuration(seg1)) - 5) < 0.3);
    ok('voice LONGER than the clip → the last frame is held so the voice is never cut (≈ 6.45 s)', Math.abs(r2.seconds - 6.45) < 0.01 && Math.abs((await FF.probeDuration(seg2)) - 6.45) < 0.3);
    const i1 = info(seg1);
    ok('segment: H.264 720x1280 + AAC audio (the clip\'s own noise track is replaced)', /Video: h264/.test(i1) && /720x1280/.test(i1) && /Audio: aac/.test(i1), i1.split('\n').filter((l) => /Stream/.test(l)).join(' | '));
    const joined = path.join(tmp, 'joined.mp4');
    await EX.joinSegments({ segments: [seg1, seg2], listPath: path.join(tmp, 'l.txt'), outPath: joined });
    ok('join: one file, length = sum of segments', Math.abs((await FF.probeDuration(joined)) - 11.45) < 0.5 && /Audio: aac/.test(info(joined)));
    e = await rejects(FF.runFfmpeg(['-i', path.join(tmp, 'nope.mp4'), path.join(tmp, 'x.mp4')]));
    ok('a failing ffmpeg run → FFMPEG_FAIL with its message', e?.code === 'FFMPEG_FAIL');
    e = await rejects(FF.runFfmpeg(['-version'], { bin: path.join(tmp, 'no-such-ffmpeg') }));
    ok('a missing binary → FFMPEG_MISSING (clear Arabic message)', e?.code === 'FFMPEG_MISSING' && /ffmpeg/.test(e.message));
  }

  console.log('\n[6] whole run (providers faked, ffmpeg real)');
  const fakeDeps = (over = {}) => ({
    falKey: 'K', provider: () => ({ name: 'openai' }), captionsAvailable: () => CAP.captionsAvailable(),
    writeScript: async () => scriptOk, makeStill: async () => ({ buffer: Buffer.from('png'), mime: 'image/png', model: 'm' }),
    falVideo: async () => 'https://v3.fal.media/files/a.mp4',
    saveRemote: async () => { const f = path.join(tmp, `rc${Math.random().toString(16).slice(2)}.mp4`); await synth(f, 5); return { filePath: f, cleanup: async () => fs.promises.rm(f, { force: true }) }; },
    speak: async ({ text }) => { const f = path.join(tmp, `sv${Math.random().toString(16).slice(2)}.mp3`); await tone(f, text.length > 30 ? 4.5 : 3); const b = await fs.promises.readFile(f); await fs.promises.rm(f, { force: true }); return b; }, ...over });
  const ref = { buffer: Buffer.from('ref'), mime: 'image/png' };
  if (hasFfmpeg) {
    const costs = []; const steps = [];
    const out = await EX.runExplainer({ name: 'فرشاة', facts: ['رشاش'], ref, scenes: 3, ctx: { progress: async (p, m) => steps.push(m), cost: (s, u, n) => costs.push(s) }, deps: fakeDeps() });
    const oi = info(out.filePath);
    ok('explainer: one 720x1280 H.264 + AAC file ≈ 15-17 s with 3 scenes', /720x1280/.test(oi) && /Audio: aac/.test(oi) && out.seconds > 14 && out.seconds < 18 && out.scenes.length === 3, `${out.seconds}`);
    ok('progress reports every scene and the join; costs are recorded', steps.some((m) => /مشهد 1/.test(m)) && steps.some((m) => /مشهد 3/.test(m)) && steps.includes('بجمّع الفيديو') && costs.includes('openai-image') && costs.includes('fal-video (تقدير)') && costs.includes('openai-tts'));
    const dir = out.dir; await out.cleanup();
    ok('cleanup removes the working folder', !fs.existsSync(dir));
    let madeDir = null;
    e = await rejects(EX.runExplainer({ name: 'x', ref, scenes: 3, ctx, deps: fakeDeps({ speak: async () => { throw new J.MediaError('OpenAI: الرصيد خلص', 'OPENAI_BALANCE'); } }) }));
    ok('a failing step fails the video with ITS message', e?.code === 'OPENAI_BALANCE');
    const leftovers = (await fs.promises.readdir(os.tmpdir())).filter((n) => n.startsWith('amb-explainer-')).length;
    ok('a failed run leaves no working folder behind', leftovers === 0, String(leftovers)); void madeDir;
  } else skip('whole explainer run (no ffmpeg)');
  e = await rejects(EX.runExplainer({ name: 'x', ref: null, ctx, deps: {} }));
  ok('no product photo → NO_PRODUCT_IMAGE', e?.code === 'NO_PRODUCT_IMAGE');
  e = await rejects(EX.runExplainer({ name: 'x', ref, ctx, deps: { falKey: null } }));
  ok('no fal key → NOT_CONFIGURED', e?.code === 'NOT_CONFIGURED');
  e = await rejects(EX.runExplainer({ name: 'x', ref, ctx, deps: { falKey: 'K', provider: () => ({ name: 'disabled' }) } }));
  ok('image provider off → NOT_CONFIGURED', e?.code === 'NOT_CONFIGURED');

  console.log('\n[7] runners');
  e = await rejects(ER.runExplainerForPool({ launchJobId: 'x', ctx, deps: { getKey: async () => null } }));
  ok('pool runner without fal → NOT_CONFIGURED', e?.code === 'NOT_CONFIGURED');
  const stored = []; const made2 = [];
  const fakeExplainer = async (n) => { const f = path.join(tmp, `ex${n}.mp4`); await fs.promises.writeFile(f, 'v'); return f; };
  void fakeExplainer;
  if (hasFfmpeg) {
    const pool = await ER.runExplainerForPool({ launchJobId: 'job-12345678', count: 2, scenes: 3, facts: 'رشاش\nبطارية', ctx, deps: { ...fakeDeps(), getKey: async () => 'K', resolveProduct: async () => ({ product: { id: 1, name: 'فرشاة' }, image: ref }), addVideo: async (a) => { stored.push({ name: a.filename, size: fs.statSync(a.filePath).size, dur: a.durationSeconds }); return { slotKey: `C10${stored.length}`, videoId: `v${stored.length}` }; } } });
    ok('pool runner: 2 explainers uploaded as explainer-N.mp4 with their duration', pool.added.length === 2 && stored[0].name === 'explainer-1.mp4' && stored[1].name === 'explainer-2.mp4' && stored[0].size > 1000 && stored[0].dur >= 14, JSON.stringify(stored));
    const wf = (await fs.promises.readdir(os.tmpdir())).filter((n) => n.startsWith('amb-explainer-')).length;
    ok('each explainer\'s temp folder is removed after the upload', wf === 0);
    const pg = await PP.createProject({ name: 'جهاز الصفحة', facts: ['رشاش'] }); made.push(pg.id);
    await PP.setReference(pg.id, Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png');
    const pr = await ER.runExplainerForPage({ projectId: pg.id, count: 1, scenes: 3, ctx, deps: { ...fakeDeps(), getKey: async () => 'K' } });
    const proj = await PP.getProject(pg.id);
    const asset = await PP.getAsset(pg.id, pr.added[0]);
    ok('page runner: the explainer is stored in the project as a video file', proj.videos.length === 1 && proj.videos[0].style === 'explainer' && asset && asset.mime === 'video/mp4' && asset.data.length > 1000);
    const one = await ER.runExplainerForPool({ launchJobId: 'job-12345678', count: 2, ctx, deps: { ...fakeDeps({ speak: (() => { let n = 0; return async (a) => { n++; if (n > 3) throw new J.MediaError('OpenAI: الرصيد خلص', 'OPENAI_BALANCE'); return fakeDeps().speak(a); }; })() }), getKey: async () => 'K', resolveProduct: async () => ({ product: { id: 1, name: 'فرشاة' }, image: ref }), addVideo: async () => ({ slotKey: 'C1', videoId: 'v' }) } });
    ok('a billing error on the 2nd video keeps the 1st and reports the failure', one.added.length === 1 && one.failed.length === 1 && /الرصيد/.test(one.failed[0].error));
  } else skip('runner tests need ffmpeg');
  ok('count is capped (max 2 per run — each costs real money)', ER.MAX_EXPLAINERS === 2);
} finally {
  await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  for (const id of made) { await prisma.cfBlob.deleteMany({ where: { key: { startsWith: `pp/${id}/` } } }).catch(() => {}); await prisma.settings.deleteMany({ where: { id: `pp:${id}` } }).catch(() => {}); }
  await prisma.$disconnect();
}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail ? 1 : 0);
