// AMB Media — HTTP surface for the smart media tools of the launch wizard. Mounted at /api/amb-media.
// Everything here is ADMIN-only: it spends provider credit, downloads media or handles provider keys. Keys are write-only — never returned.
// Long work (search, import, generation) runs as a job (services/amb/media/mediaJobs.js); the wizard polls GET /jobs/:id.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { getMediaKeysStatus, setMediaKey, clearMediaKey, testMediaKey } from '../services/amb/media/mediaKeys.js';
import { createJob, getJob, startJob, MediaError } from '../services/amb/media/mediaJobs.js';
import { runPageImages, PAGE_IMAGE_STYLES, MAX_PAGE_IMAGES } from '../services/amb/media/pageImages.js';
import { runVideoFinder } from '../services/amb/media/videoFinder.js';
import { runImport, MAX_IMPORT } from '../services/amb/media/mediaImport.js';
import { runAiVideos, AI_STYLES, MAX_AI_VIDEOS } from '../services/amb/media/aiVideos.js';
import { runExplainerForPool, MAX_EXPLAINERS } from '../services/amb/media/explainerRuns.js';
import { isAllowedVideoUrl } from '../services/amb/media/ytdlp.js';
import { prisma } from '../prisma.js';
import { requireLaunchToken, getMetaVideoThumbnailUrl, getMetaVideoStatus } from '../services/amb/launchVideoUpload.js';
import { getVideoSourceUrl } from '../services/metaGraphClient.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN'));

const bad = (message) => { const e = new Error(message); e.status = 400; return e; };
const launchJobIdOf = (req) => { const id = String(req.body?.launchJobId || ''); if (!/^[a-z0-9_-]{8,80}$/i.test(id)) throw bad('طلب الرفع غير صالح — ارجع للخطوة الأولى.'); return id; };
const publicJob = (j) => (j ? { id: j.id, kind: j.kind, status: j.status, progress: j.progress, message: j.message, result: j.result, error: j.error, costs: j.costs, createdAt: j.createdAt, updatedAt: j.updatedAt, launchJobId: j.launchJobId } : null);

router.get('/keys', asyncRoute(async (_req, res) => res.json({ providers: await getMediaKeysStatus() })));
router.put('/keys/:provider', asyncRoute(async (req, res) => res.json(await setMediaKey(req.params.provider, req.body?.value))));
router.delete('/keys/:provider', asyncRoute(async (req, res) => res.json(await clearMediaKey(req.params.provider))));
router.post('/keys/:provider/test', asyncRoute(async (req, res) => res.json(await testMediaKey(req.params.provider))));

/** What the wizard buttons can do right now (so a button is disabled with a reason instead of failing after a click). */
router.get('/capabilities', asyncRoute(async (_req, res) => {
  const k = await getMediaKeysStatus();
  res.json({
    pageImages: { ready: k.openai.configured, reason: k.openai.configured ? null : 'مفتاح OpenAI مش متظبط على السيرفر', styles: Object.fromEntries(Object.entries(PAGE_IMAGE_STYLES).map(([id, s]) => [id, s.label])), max: MAX_PAGE_IMAGES },
    finder: { ready: k.apify.configured || k.serpapi.configured, reason: k.apify.configured || k.serpapi.configured ? null : 'اربط Apify أو SerpApi الأول', lens: k.serpapi.configured, ranking: k.openai.configured, maxImport: MAX_IMPORT },
    aiVideos: { ready: k.fal.configured, reason: k.fal.configured ? null : 'اربط fal.ai الأول', styles: Object.keys(AI_STYLES), max: MAX_AI_VIDEOS },
  });
}));

const launch = (kind, run) => asyncRoute(async (req, res) => {
  const launchJobId = launchJobIdOf(req);
  const input = run.input(req);
  const job = await createJob({ kind, launchJobId, userId: req.user?.id ?? null, input });
  startJob(job.id, (ctx) => run.exec({ launchJobId, input, ctx }));
  res.status(202).json(publicJob(job));
});

router.post('/page-images', launch('PAGE_IMAGES', {
  input: (req) => ({ count: Math.max(1, Math.min(MAX_PAGE_IMAGES, Number(req.body?.count) || 3)), style: PAGE_IMAGE_STYLES[req.body?.style] ? req.body.style : 'clean' }),
  exec: ({ launchJobId, input, ctx }) => runPageImages({ launchJobId, ...input, ctx }),
}));

router.post('/videos/find', launch('VIDEO_FIND', {
  input: (req) => ({ target: Math.max(3, Math.min(30, Number(req.body?.target) || 12)), manualUrls: (Array.isArray(req.body?.manualUrls) ? req.body.manualUrls : []).map(String).slice(0, 20).filter(isAllowedVideoUrl) }),
  exec: ({ launchJobId, input, ctx }) => runVideoFinder({ launchJobId, target: input.target, manualUrls: input.manualUrls, ctx }),
}));

router.post('/videos/import', launch('VIDEO_IMPORT', {
  input: (req) => { const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).slice(0, MAX_IMPORT); if (!ids.length) throw bad('اختار فيديو واحد على الأقل.'); const findJobId = String(req.body?.findJobId || ''); if (!findJobId) throw bad('نتيجة البحث مطلوبة.'); return { ids, findJobId }; },
  exec: ({ launchJobId, input, ctx }) => runImport({ launchJobId, findJobId: input.findJobId, ids: input.ids, ctx }),
}));

router.post('/ai-videos', launch('AI_VIDEOS', {
  input: (req) => {
    const explainer = req.body?.mode === 'explainer'; // a real explainer: usage scenes + Egyptian voice-over + Arabic captions (expensive — max 2 per run)
    return { mode: explainer ? 'explainer' : 'clip', count: Math.max(1, Math.min(explainer ? MAX_EXPLAINERS : MAX_AI_VIDEOS, Number(req.body?.count) || 1)), scenes: Number(req.body?.scenes) === 4 ? 4 : 3, captions: req.body?.captions !== false, facts: (Array.isArray(req.body?.facts) ? req.body.facts : []).map((x) => String(x).slice(0, 200)).slice(0, 20), seconds: Number(req.body?.seconds) === 10 ? 10 : 5, style: AI_STYLES[req.body?.style] ? req.body.style : 'ugc' };
  },
  exec: ({ launchJobId, input, ctx }) => (input.mode === 'explainer'
    ? runExplainerForPool({ launchJobId, count: input.count, scenes: input.scenes, facts: input.facts, captions: input.captions, ctx })
    : runAiVideos({ launchJobId, count: input.count, seconds: input.seconds, style: input.style, ctx })),
}));

/** Playable preview of a video already in a launch job's pool: Meta's own copy (a signed CDN URL that expires) — read-only. */
router.get('/video-preview', asyncRoute(async (req, res) => {
  const jobId = String(req.query.launchJobId || ''), slotKey = String(req.query.slotKey || '');
  if (!/^[a-z0-9_-]{8,80}$/i.test(jobId) || !/^C\d{1,4}$/.test(slotKey)) throw bad('بيانات الفيديو غير صالحة.');
  const row = await prisma.ambLaunchVideoAsset.findUnique({ where: { job_id_slot_key: { job_id: jobId, slot_key: slotKey } }, select: { meta_video_id: true, status: true } });
  if (!row?.meta_video_id) throw Object.assign(new Error('الفيديو لسه ما اترفعش على Meta.'), { status: 404 });
  const token = await requireLaunchToken();
  const [source, picture, status] = await Promise.all([getVideoSourceUrl(token, row.meta_video_id).catch(() => null), getMetaVideoThumbnailUrl(token, row.meta_video_id), getMetaVideoStatus(token, row.meta_video_id)]);
  res.json({ source, picture, status });
}));

router.get('/jobs/:id', asyncRoute(async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) throw Object.assign(new Error('الشغل مش موجود أو انتهت صلاحيته.'), { status: 404 });
  res.json(publicJob(job));
}));

export { MediaError };
export default router;
