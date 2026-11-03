// 🧪 AMB Media pipeline: jobs, Apify normalisers/runner, yt-dlp guards, video finder, import, page images, AI videos, pool registration.
// Every provider is injected — NO network, NO real Meta/OpenAI/Apify/fal call. Isolated test database only.
//   node src/scripts/mediaPipelineTest.js
import './_testGuard.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
if (process.env.MP_LOG) { const orig = console.log; console.log = (...a) => { orig(...a); fs.appendFileSync(process.env.MP_LOG, a.join(' ') + '\n'); }; } // debugging aid: live progress when the runner buffers stdout
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 220) : ''}`); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

const { prisma } = await imp('../prisma.js');
const J = await imp('../services/amb/media/mediaJobs.js');
const AP = await imp('../services/amb/media/apify.js');
const YT = await imp('../services/amb/media/ytdlp.js');
const VF = await imp('../services/amb/media/videoFinder.js');
const PI = await imp('../services/amb/media/pageImages.js');
const MI = await imp('../services/amb/media/mediaImport.js');
const AV = await imp('../services/amb/media/aiVideos.js');
const LA = await imp('../services/amb/media/launchAssets.js');
const LB = await imp('../services/amb/launchBuilder.js');

const LJ = 'mediatest-job-0001';
const ctx = { progress: async () => {}, cost: () => {} };
const waitDone = async (id) => { for (let i = 0; i < 100; i++) { const j = await J.getJob(id); if (j && !['QUEUED', 'RUNNING'].includes(j.status)) return j; await new Promise((r) => setTimeout(r, 30)); } return J.getJob(id); };
const tmpFile = async (bytes = 'video-bytes') => { const d = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mp-test-')); const f = path.join(d, 'v.mp4'); await fs.promises.writeFile(f, bytes); return { f, d }; };

try {
  await prisma.ambLaunchImageAsset.deleteMany({ where: { job_id: LJ } }).catch(() => {});
  await prisma.ambLaunchVideoAsset.deleteMany({ where: { job_id: LJ } }).catch(() => {});
  await prisma.ambLaunchAudit.deleteMany({ where: { job_id: LJ } }).catch(() => {});
  await prisma.ambLaunchJob.deleteMany({ where: { job_id: LJ } }).catch(() => {});
  await LB.startLaunchJob({ jobId: LJ, userId: null, adAccountId: 'act_999', adAccountName: 'T', productId: null });

  console.log('\n[1] jobs');
  const j1 = await J.createJob({ kind: 'X', launchJobId: LJ, input: { a: 1 } });
  ok('created QUEUED with a dated id', j1.status === 'QUEUED' && /^\d{8}-[0-9a-f]{12}$/.test(j1.id));
  J.startJob(j1.id, async (c) => { await c.progress(50, 'نص الطريق'); c.cost('svc', 0.5, 2); c.cost('svc', 0.25, 1); return { hello: 'x' }; });
  let d = await waitDone(j1.id);
  ok('SUCCEEDED with result and merged costs', d.status === 'SUCCEEDED' && d.result.hello === 'x' && d.costs[0].usd === 0.75 && d.costs[0].count === 3, JSON.stringify(d));
  const j2 = await J.createJob({ kind: 'X', launchJobId: LJ });
  J.startJob(j2.id, async () => { throw new J.MediaError('رسالة للعميل', 'MY_CODE'); });
  d = await waitDone(j2.id);
  ok('failure keeps code + Arabic message', d.status === 'FAILED' && d.error.code === 'MY_CODE' && d.error.message === 'رسالة للعميل' && d.error.user === true);
  const j3 = await J.createJob({ kind: 'X', launchJobId: LJ });
  J.startJob(j3.id, async () => { throw new Error('boom internal secret'); });
  d = await waitDone(j3.id);
  ok('unexpected error is NOT leaked to the client', d.status === 'FAILED' && !/secret/.test(d.error.message));
  ok('bad job id → null (no DB read with arbitrary ids)', (await J.getJob('../etc')) === null && (await J.getJob('nope')) === null);
  const j4 = await J.createJob({ kind: 'X' });
  const row = await prisma.settings.findUnique({ where: { id: `mj:${j4.id}` } });
  const old = { ...JSON.parse(row.data), status: 'RUNNING', updatedAt: new Date(Date.now() - 40 * 60_000).toISOString() };
  await prisma.settings.update({ where: { id: `mj:${j4.id}` }, data: { data: JSON.stringify(old) } });
  d = await J.getJob(j4.id);
  ok('a RUNNING job silent for 25+ min (server restarted) is closed as INTERRUPTED', d.status === 'FAILED' && d.error.code === 'INTERRUPTED');
  let running = 0, peak = 0; const ids = [];
  for (let i = 0; i < 5; i++) { const j = await J.createJob({ kind: 'X' }); ids.push(j.id); J.startJob(j.id, async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 60)); running--; return {}; }); }
  for (const id of ids) await waitDone(id);
  ok(`at most ${J.MAX_PARALLEL} jobs run at once (peak ${peak})`, peak <= J.MAX_PARALLEL && peak >= 1);

  console.log('\n[2] apify');
  ok('tiktok: normal video kept with fields', (() => { const v = AP.normalizeTikTok({ webVideoUrl: 'https://www.tiktok.com/@a/video/1', text: 'hi', authorMeta: { name: 'a' }, playCount: 100, diggCount: 5, videoMeta: { duration: 23, coverUrl: 'https://c/1.jpg' } }); return v.source === 'TIKTOK' && v.views === 100 && v.durationSec === 23 && v.thumbnail === 'https://c/1.jpg'; })());
  ok('tiktok: slideshow / photo post dropped', AP.normalizeTikTok({ webVideoUrl: 'https://x', isSlideshow: true }) === null && AP.normalizeTikTok({ webVideoUrl: 'https://x', imagePost: true }) === null);
  ok('reel without file dropped, with file kept', AP.normalizeReel({ url: 'https://i/p/1' }) === null && AP.normalizeReel({ url: 'https://i/p/1', videoUrl: 'https://scontent.cdninstagram.com/v.mp4', ownerUsername: 'u' }).directUrl.includes('cdninstagram'));
  const ad = AP.normalizeAdLibrary({ adArchiveID: '55', pageName: 'P', startDate: Math.floor(Date.now() / 1000) - 10 * 86400, collationCount: 3, snapshot: { body: { text: 'b' }, videos: [{ videoHdUrl: 'https://v.fbcdn.net/x.mp4', videoPreviewImageUrl: 'https://p/1.jpg' }] } });
  ok('ad library: id, days running, duplicates', ad.url.endsWith('id=55') && ad.adDays === 10 && ad.adCount === 3 && ad.source === 'META_ADS');
  ok('ad without video dropped', AP.normalizeAdLibrary({ adArchiveID: '1', snapshot: {} }) === null);
  const calls = [];
  const fakeApify = async (url, init) => {
    calls.push(`${init?.method || 'GET'} ${url.replace('https://api.apify.com/v2', '')}`);
    const json = (b, s = 200) => ({ ok: s < 300, status: s, text: async () => JSON.stringify(b) });
    if (url.includes('/runs')) return json({ data: { id: 'r1', status: 'RUNNING', defaultDatasetId: 'd1' } });
    if (url.includes('/actor-runs/r1?')) return json({ data: { id: 'r1', status: 'SUCCEEDED', defaultDatasetId: 'd1' } });
    if (url.includes('/datasets/d1/items')) return json([{ webVideoUrl: 'https://www.tiktok.com/@a/video/9', text: 't' }]);
    if (url.endsWith('/actor-runs/r1')) return json({ data: { usageTotalUsd: 0.07 } });
    return json({}, 404);
  };
  const r = await AP.searchTikTok(['luma force'], { fetchImpl: fakeApify, token: 'tok' });
  ok('runActor: run → wait → items → usage', r.videos.length === 1 && r.usd === 0.07 && calls[0].startsWith('POST /acts/clockworks~tiktok-scraper/runs'), calls.join(' | '));
  let e = await rejects(AP.runActor('a/b', {}, { token: 'x', fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{}' }) }));
  ok('401 → APIFY_KEY', e?.code === 'APIFY_KEY');
  e = await rejects(AP.runActor('a/b', {}, { token: 'x', fetchImpl: async () => ({ ok: false, status: 402, text: async () => '{}' }) }));
  ok('402 → APIFY_LIMIT', e?.code === 'APIFY_LIMIT');
  e = await rejects(AP.runActor('a/b', {}, { token: 'x', fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'Monthly usage hard limit exceeded' } }) }) }));
  ok('"usage hard limit" message → APIFY_LIMIT', e?.code === 'APIFY_LIMIT');

  console.log('\n[3] yt-dlp guards');
  ok('allowed: tiktok / instagram / youtube / facebook https', ['https://www.tiktok.com/@a/video/1', 'https://vm.tiktok.com/abc', 'https://www.instagram.com/reel/x/', 'https://youtu.be/x', 'https://www.facebook.com/ads/library/?id=1'].every(YT.isAllowedVideoUrl));
  ok('blocked: http, other hosts, creds, look-alikes, internal', ['http://www.tiktok.com/x', 'https://evil.com/tiktok.com', 'https://tiktok.com.evil.com/x', 'https://user:pw@tiktok.com/x', 'https://localhost/x', 'https://169.254.169.254/latest', 'file:///etc/passwd', 'javascript:1'].every((u) => !YT.isAllowedVideoUrl(u)));
  e = await rejects(YT.downloadVideo('https://evil.com/x', { ensure: async () => 'bin', runner: async () => ({}) }));
  ok('downloadVideo refuses a non-allowed URL before spawning anything', e?.code === 'BAD_URL');
  let spawned = null;
  const dl = await YT.downloadVideo('https://www.tiktok.com/@a/video/1', { ensure: async () => 'yt-dlp', runner: async (bin, args) => { spawned = args; const out = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4'); await fs.promises.writeFile(out, 'x'); return {}; } });
  ok('downloadVideo: no shell, "--" before the URL, file returned', spawned.at(-2) === '--' && spawned.at(-1).startsWith('https://www.tiktok.com') && fs.existsSync(dl.filePath));
  await dl.cleanup();
  ok('cleanup removes the temp dir', !fs.existsSync(dl.dir));
  e = await rejects(YT.downloadDirect('https://evil.example.com/v.mp4', { fetchImpl: async () => { throw new Error('must not fetch'); } }));
  ok('downloadDirect refuses a non-CDN host without fetching', e?.code === 'BAD_URL');
  e = await rejects(YT.downloadDirect('http://scontent.cdninstagram.com/v.mp4', {}));
  ok('downloadDirect refuses http', e?.code === 'BAD_URL');
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(Buffer.from('hello video'))); c.close(); } });
  const dd = await YT.downloadDirect('https://scontent.cdninstagram.com/v.mp4', { fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': '11' }), body }) });
  ok('downloadDirect streams a CDN file to disk', fs.readFileSync(dd.filePath, 'utf8') === 'hello video');
  await dd.cleanup();
  e = await rejects(YT.downloadDirect('https://scontent.cdninstagram.com/v.mp4', { maxBytes: 5, fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': '999' }), body: new ReadableStream({ start(c) { c.close(); } }) }) }));
  ok('downloadDirect enforces the size cap', e?.code === 'TOO_BIG');

  console.log('\n[4] video finder');
  const fq = VF.fallbackQueries('Luma Force Massager');
  ok('fallback queries from the name + hashtags', fq.queries[0] === 'Luma Force Massager' && fq.hashtags.includes('Luma'));
  const sorted = VF.sortCandidates([
    { id: 'a', source: 'TIKTOK', matchScore: 90, views: 10 }, { id: 'b', source: 'TIKTOK', matchScore: 40, views: 999 }, { id: 'c', source: 'META_ADS', adDays: 5, adCount: 1 },
    { id: 'd', source: 'META_ADS', adDays: 50, adCount: 4 }, { id: 'e', source: 'MANUAL' }, { id: 'f', source: 'TIKTOK', matchScore: null, views: 5000 }]);
  ok('order: manual, ads (longest first), then score, then views', sorted.map((x) => x.id).join('') === 'edcabf', sorted.map((x) => x.id).join(''));
  const png = { buffer: Buffer.from('product'), mime: 'image/png' };
  const cands = [{ id: '1', thumbnail: 'https://t/1.jpg', matchScore: null }, { id: '2', thumbnail: 'https://t/2.jpg', matchScore: null }, { id: '3', thumbnail: null, matchScore: null }];
  await VF.scoreCovers({ name: 'P', image: png, candidates: cands, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, headers: new Headers({ 'content-type': 'image/jpeg' }) }), ask: async () => ({ results: [{ index: 0, score: 88, note: 'نفس المنتج' }, { index: 1, score: 150 }, { index: 7, score: 10 }] }) });
  ok('cover scores applied, clamped to 100, unknown index ignored, no thumbnail stays unscored', cands[0].matchScore === 88 && cands[1].matchScore === 100 && cands[2].matchScore === null);
  const c2 = [{ id: '1', thumbnail: 'https://t/1.jpg', matchScore: null }];
  await VF.scoreCovers({ name: 'P', image: png, candidates: c2, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer, headers: new Headers({ 'content-type': 'image/jpeg' }) }), ask: async () => { throw new Error('ai down'); } });
  ok('a failing AI batch leaves candidates unscored (never invented)', c2[0].matchScore === null);
  const v = (url, extra = {}) => ({ url, directUrl: null, source: 'TIKTOK', author: 'a', caption: '', views: 10, likes: 1, durationSec: 20, thumbnail: null, adDays: null, adCount: null, ...extra });
  const finder = await VF.runVideoFinder({
    launchJobId: LJ, target: 3, manualUrls: ['https://www.tiktok.com/@m/video/7', 'https://evil.com/x'], ctx,
    deps: { resolveProduct: async () => ({ product: { id: 1, name: 'Luma Force' }, image: null }), ai: false,
      apify: { searchTikTok: async () => ({ videos: [v('https://www.tiktok.com/@a/video/1'), v('https://www.tiktok.com/@a/video/1'), v('https://www.tiktok.com/@a/video/2', { durationSec: 300 })], usd: 0.1 }), searchInstagramReels: async () => { throw new J.MediaError('Apify: الرصيد خلص.', 'APIFY_LIMIT'); }, searchMetaAdLibrary: async () => ({ videos: [v('https://www.facebook.com/ads/library/?id=5', { source: 'META_ADS', adDays: 9 })], usd: 0.2 }) } },
  });
  ok('finder: failing source reported, others kept', finder.sources.find((s) => s.id === 'instagram').ok === false && finder.sources.find((s) => s.id === 'tiktok').count === 3);
  ok('finder: duplicates removed, >120 s videos dropped, bad manual URL ignored', finder.candidates.length === 3 && !finder.candidates.some((c) => c.url.includes('evil')) && !finder.candidates.some((c) => c.url.endsWith('/2')), finder.candidates.map((c) => c.url).join(','));
  ok('finder: manual link first, then the Meta ad', finder.candidates[0].source === 'MANUAL' && finder.candidates[1].source === 'META_ADS');
  ok('finder: candidates carry a stable id', finder.candidates.every((c) => /^[0-9a-f]{12}$/.test(c.id)) && finder.candidates[0].id === VF.candidateId(finder.candidates[0].url));
  e = await rejects(VF.runVideoFinder({ launchJobId: LJ, ctx, deps: { resolveProduct: async () => ({ product: { id: 1, name: 'Luma Force' }, image: null }), ai: false, apify: { searchTikTok: async () => { throw new J.MediaError('x1', 'A'); }, searchInstagramReels: async () => { throw new J.MediaError('x2', 'A'); }, searchMetaAdLibrary: async () => { throw new J.MediaError('x3', 'A'); } } } }));
  ok('all sources failing → ALL_SOURCES_FAILED with each reason', e?.code === 'ALL_SOURCES_FAILED' && /x1/.test(e.message) && /x3/.test(e.message));

  console.log('\n[5] import');
  const fj = await J.createJob({ kind: 'VIDEO_FIND', launchJobId: LJ });
  await J.patchJob(fj.id, { status: 'SUCCEEDED', result: { candidates: [{ id: 'aaaaaaaaaaaa', url: 'https://www.tiktok.com/@a/video/1', directUrl: null, source: 'TIKTOK', durationSec: 20 }, { id: 'bbbbbbbbbbbb', url: 'https://www.instagram.com/reel/x/', directUrl: 'https://scontent.cdninstagram.com/v.mp4', source: 'INSTAGRAM', durationSec: 11 }, { id: 'cccccccccccc', url: 'https://www.tiktok.com/@a/video/3', directUrl: null, source: 'TIKTOK' }] } });
  const used = [];
  const impDeps = { downloadVideo: async (u) => { if (u.endsWith('/3')) throw new J.MediaError('الفيديو خاص', 'YTDLP_FAIL'); const t = await tmpFile(); return { filePath: t.f, cleanup: async () => fs.promises.rm(t.d, { recursive: true, force: true }) }; }, downloadDirect: async () => { throw new J.MediaError('expired', 'DIRECT_FAIL'); }, addVideo: async (a) => { used.push(a.filename); return { slotKey: 'C10' + used.length, videoId: 'v' + used.length }; } };
  const imp1 = await MI.runImport({ launchJobId: LJ, findJobId: fj.id, ids: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'zzzzzzzzzzzz'], ctx, deps: impDeps });
  ok('import: picked ids only (unknown id ignored), failures listed', imp1.added.length === 2 && imp1.failed.length === 1 && imp1.failed[0].id === 'cccccccccccc' && used.length === 2);
  ok('import: Instagram falls back to yt-dlp when the direct link expired', imp1.added.some((a) => a.id === 'bbbbbbbbbbbb'));
  e = await rejects(MI.runImport({ launchJobId: 'another-launch-job', findJobId: fj.id, ids: ['aaaaaaaaaaaa'], ctx, deps: impDeps }));
  ok('import: a search from another launch job is refused', e?.code === 'BAD_INPUT');
  e = await rejects(MI.runImport({ launchJobId: LJ, findJobId: fj.id, ids: ['zzzzzzzzzzzz'], ctx, deps: impDeps }));
  ok('import: nothing valid picked → error', e?.code === 'BAD_INPUT');
  e = await rejects(MI.runImport({ launchJobId: LJ, findJobId: j1.id, ids: ['x'], ctx, deps: impDeps }));
  ok('import: a job that is not a finished search is refused', e?.code === 'BAD_INPUT');

  console.log('\n[6] page images');
  const prompts = PI.buildPagePrompts({ name: 'Luma Force', style: 'lifestyle', count: 5 });
  ok('prompts: n of them, product name + the keep-the-product rule, cycle scenes', prompts.length === 5 && prompts.every((p) => p.includes('Luma Force') && /EXACTLY/.test(p)) && prompts[0] !== prompts[1]);
  const pcOk = async () => ({ product: { id: 5, name: 'Luma Force' }, image: { buffer: Buffer.from('refimg'), mime: 'image/png' } });
  const fakeProvider = (impl) => () => ({ name: 'openai', generate: impl });
  const upDeps = (log) => ({ token: async () => 'tok', uploadImage: async (_t, acct, buf) => { log.push({ acct, bytes: buf.length }); return { hash: 'h' + log.length }; } });
  const uploads = []; let gens = 0;
  const pr = await PI.runPageImages({ launchJobId: LJ, count: 2, style: 'clean', ctx, deps: { resolveProduct: pcOk, provider: fakeProvider(async ({ referenceImages }) => { gens++; if (!referenceImages?.[0]?.b64) throw new Error('no reference'); return { images: [{ b64: Buffer.from('png' + gens).toString('base64'), mime: 'image/png' }], model: 'm', durationMs: 5 }; }), checkBudget: async () => ({ blocked: false }), estimateCost: async () => 0.04, logUsage: async () => {}, assets: upDeps(uploads) } });
  ok('page images: 2 generated with the product photo as reference, uploaded to the job account', pr.added.length === 2 && uploads.length === 2 && uploads[0].acct === 'act_999', JSON.stringify(pr));
  ok('slot keys are server-range I101+, rows UPLOADED with the Meta hash', pr.added[0] === 'I101' && pr.added[1] === 'I102' && (await prisma.ambLaunchImageAsset.findMany({ where: { job_id: LJ } })).every((r) => r.status === 'UPLOADED' && r.meta_image_hash));
  e = await rejects(PI.runPageImages({ launchJobId: LJ, count: 2, ctx, deps: { resolveProduct: pcOk, provider: () => ({ name: 'disabled' }), checkBudget: async () => ({ blocked: false }) } }));
  ok('no OpenAI key → NOT_CONFIGURED, nothing faked', e?.code === 'NOT_CONFIGURED');
  e = await rejects(PI.runPageImages({ launchJobId: LJ, count: 2, ctx, deps: { resolveProduct: pcOk, provider: fakeProvider(async () => { const x = new Error('quota'); x.httpStatus = 429; throw x; }), checkBudget: async () => ({ blocked: false }), estimateCost: async () => 0, logUsage: async () => {} } }));
  ok('OpenAI 429 on the first image → OPENAI_BALANCE', e?.code === 'OPENAI_BALANCE');
  e = await rejects(PI.runPageImages({ launchJobId: LJ, count: 1, ctx, deps: { resolveProduct: pcOk, provider: fakeProvider(async () => ({ images: [{ b64: 'AA' }] })), checkBudget: async () => ({ blocked: true, spentUsd: 5, budgetUsd: 5 }) } }));
  ok('monthly AI budget reached → BUDGET, no generation', e?.code === 'BUDGET');
  e = await rejects(PI.runPageImages({ launchJobId: LJ, count: 1, ctx, deps: { resolveProduct: async () => ({ product: { id: 5, name: 'P' }, image: null }), provider: fakeProvider(async () => ({})), checkBudget: async () => ({ blocked: false }) } }));
  ok('product without a photo → NO_PRODUCT_IMAGE (never a stock image)', e?.code === 'NO_PRODUCT_IMAGE');

  console.log('\n[7] AI videos (fal)');
  ok('motion prompt keeps the product + vertical + no text', /exactly as in the image/i.test(AV.buildMotionPrompt({ name: 'P' })) && /9:16/.test(AV.buildMotionPrompt({ name: 'P', style: 'demo' })));
  const seq = []; let polls = 0;
  const falFetch = async (url, init) => {
    seq.push(`${init?.method || 'GET'} ${url.replace(/^https:\/\//, '').slice(0, 40)}`);
    const js = (b, s = 200) => ({ ok: s < 300, status: s, text: async () => JSON.stringify(b), json: async () => b });
    if (url === 'https://queue.fal.run/s/1') return js({ status: ++polls < 3 ? 'IN_PROGRESS' : 'COMPLETED' });
    if (url === 'https://queue.fal.run/r/1') return js({ video: { url: 'https://v3.fal.media/files/x.mp4' } });
    if (url.startsWith('https://queue.fal.run/fal-ai/')) return js({ request_id: 'q1', status_url: 'https://queue.fal.run/s/1', response_url: 'https://queue.fal.run/r/1' });
    return js({}, 404);
  };
  const furl = await AV.falImageToVideo({ key: 'K', imageDataUri: 'data:image/png;base64,AA', prompt: 'p', seconds: 5, fetchImpl: falFetch, pollMs: 1 });
  ok('fal: submit → poll until COMPLETED → result url', furl === 'https://v3.fal.media/files/x.mp4' && polls === 3 && seq[0].startsWith('POST queue.fal.run/fal-ai/kling'), seq.join(' | '));
  e = await rejects(AV.falImageToVideo({ key: 'K', imageDataUri: 'd', prompt: 'p', seconds: 5, fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'User is locked. Reason: TOP_UP' }) }));
  ok('fal 403 TOP_UP → FAL_BALANCE (Arabic)', e?.code === 'FAL_BALANCE' && /الرصيد/.test(e.message));
  e = await rejects(AV.falImageToVideo({ key: 'K', imageDataUri: 'd', prompt: 'p', seconds: 5, fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'no' }) }));
  ok('fal 401 → FAL_KEY', e?.code === 'FAL_KEY');
  const avUp = [];
  const av = await AV.runAiVideos({ launchJobId: LJ, count: 2, seconds: 5, style: 'ugc', ctx, deps: { getKey: async () => 'K', resolveProduct: pcOk, scenes: async () => ['scene one'], falVideo: async ({ prompt }) => { avUp.push(prompt); return 'https://v3.fal.media/files/a.mp4'; }, fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }), addVideo: async () => ({ slotKey: 'C101', videoId: 'v1' }) } });
  ok('AI videos: 2 clips, first uses the AI scene, second the plain template', av.added.length === 2 && /scene one/.test(avUp[0]) && /Luma Force/.test(avUp[1]) && /بدون صوت/.test(av.note));
  e = await rejects(AV.runAiVideos({ launchJobId: LJ, ctx, deps: { getKey: async () => null } }));
  ok('no fal key → NOT_CONFIGURED', e?.code === 'NOT_CONFIGURED');
  e = await rejects(AV.runAiVideos({ launchJobId: LJ, count: 2, ctx, deps: { getKey: async () => 'K', resolveProduct: pcOk, scenes: async () => [], falVideo: async () => { throw new J.MediaError('fal.ai: الرصيد خلص', 'FAL_BALANCE'); } } }));
  ok('fal balance on the first clip stops the run with that error', e?.code === 'FAL_BALANCE');
  e = await rejects(AV.runAiVideos({ launchJobId: LJ, count: 1, ctx, deps: { getKey: async () => 'K', resolveProduct: pcOk, scenes: async () => [], falVideo: async () => 'https://evil.example.com/x.mp4', fetchImpl: async () => { throw new Error('must not fetch'); } } }));
  ok('a result URL outside fal hosts is never fetched', e?.code === 'NO_VIDEOS' && /fal/.test(e.message));

  console.log('\n[8] pool registration (real rows)');
  const t = await tmpFile('some video bytes');
  const upv = [];
  const vdeps = { token: async () => 'tok', uploadVideo: async (a) => { upv.push(a.fileSize); return { videoId: 'meta-vid-1' }; } };
  const v1 = await LA.addVideoFileToPool({ launchJobId: LJ, filePath: t.f, filename: 'a.mp4', durationSeconds: 12, deps: vdeps });
  ok('video registered under C101 and uploaded with the real size', v1.slotKey === 'C101' && v1.videoId === 'meta-vid-1' && upv[0] === 'some video bytes'.length);
  const v2 = await LA.addVideoFileToPool({ launchJobId: LJ, filePath: t.f, filename: 'same.mp4', deps: vdeps });
  ok('identical bytes are NOT uploaded twice (re-uses the Meta id)', v2.deduped === true && v2.videoId === 'meta-vid-1' && upv.length === 1);
  const rowV = await prisma.ambLaunchVideoAsset.findUnique({ where: { job_id_slot_key: { job_id: LJ, slot_key: 'C101' } } });
  ok('row UPLOADED with meta_video_id and duration', rowV.status === 'UPLOADED' && rowV.meta_video_id === 'meta-vid-1' && rowV.duration_seconds === 12);
  e = await rejects(LA.addVideoFileToPool({ launchJobId: LJ, filePath: (await tmpFile('zzz differ')).f, filename: 'b.mp4', deps: { token: async () => 'tok', uploadVideo: async () => { const x = new Error('meta says no'); x.metaError = { message: 'Video too long' }; throw x; } } }));
  const failedRow = await prisma.ambLaunchVideoAsset.findFirst({ where: { job_id: LJ, status: 'FAILED' } });
  ok('Meta upload failure → FAILED row with the Meta message, error surfaced', e?.code === 'META_UPLOAD' && failedRow?.error === 'Video too long');
  e = await rejects(LA.addImageToPool({ launchJobId: 'no-such-job', buffer: Buffer.from('x'), filename: 'x.png', deps: { token: async () => 't' } }));
  ok('unknown launch job → NOT_FOUND', e?.code === 'NOT_FOUND');
  await fs.promises.rm(t.d, { recursive: true, force: true });
} finally {
  await prisma.ambLaunchImageAsset.deleteMany({ where: { job_id: LJ } }).catch(() => {});
  await prisma.ambLaunchVideoAsset.deleteMany({ where: { job_id: LJ } }).catch(() => {});
  await prisma.ambLaunchAudit.deleteMany({ where: { job_id: LJ } }).catch(() => {});
  await prisma.ambLaunchJob.deleteMany({ where: { job_id: LJ } }).catch(() => {});
  await prisma.settings.deleteMany({ where: { id: { startsWith: 'mj:' } } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
