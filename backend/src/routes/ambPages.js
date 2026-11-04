// AMB Media — PRODUCT PAGE projects (build a product page from A to Z). Mounted at /api/amb-media/pages. ADMIN only (spends AI credit).
// Long work (copy, images, videos, video search) runs as a job on the shared job runner; the screen polls GET /api/amb-media/jobs/:id.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { createJob, startJob } from '../services/amb/media/mediaJobs.js';
import * as PP from '../services/amb/media/pageProjects.js';
import { templateList } from '../services/amb/media/pageTemplates.js';
import { runPageAiVideos, runPageVideoFinder } from '../services/amb/media/pageVideos.js';
import { MAX_AI_VIDEOS, AI_STYLES } from '../services/amb/media/aiVideos.js';
import { runExplainerForPage, MAX_EXPLAINERS } from '../services/amb/media/explainerRuns.js';
import { isAllowedVideoUrl } from '../services/amb/media/ytdlp.js';
import { fetchImageBytes } from '../services/amb/media/productImage.js';
import { getEasyOrdersProducts } from '../services/amb/easyOrdersProducts.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN'));

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const pid = (req) => { if (!PP.validProjectId(req.params.id)) throw bad('معرّف المشروع غير صالح.'); return req.params.id; };
const publicJob = (j) => ({ id: j.id, kind: j.kind, status: j.status, progress: j.progress, message: j.message, result: j.result, error: j.error, costs: j.costs, createdAt: j.createdAt, updatedAt: j.updatedAt });
const readBody = async (req, max) => { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > max) throw bad('الملف كبير.'); chunks.push(c); } return Buffer.concat(chunks); };

async function startProjectJob(kind, projectId, userId, input, exec) {
  const job = await createJob({ kind, launchJobId: null, userId, input: { projectId, ...input } });
  startJob(job.id, (ctx) => exec(ctx));
  return job;
}

// ---- reference data
router.get('/templates', asyncRoute(async (_req, res) => res.json({ templates: templateList(), videoStyles: Object.keys(AI_STYLES), maxAiVideos: MAX_AI_VIDEOS })));

router.get('/eo-products', asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const list = await getEasyOrdersProducts().catch(() => []);
  res.json({ products: list.filter((p) => !q || `${p.name} ${p.slug}`.toLowerCase().includes(q)).slice(0, 40).map((p) => ({ id: p.id, name: p.name, slug: p.slug, price: p.price ?? null, thumb: p.thumb || null })) });
}));

// ---- projects
router.get('/', asyncRoute(async (_req, res) => res.json({ projects: await PP.listProjects() })));

router.post('/', asyncRoute(async (req, res) => {
  const b = req.body || {};
  let eo = null, thumb = null, name = b.name, price = b.price;
  if (b.eo?.id) { // the Easy Orders product is looked up on OUR side: the browser never supplies the image URL
    const found = (await getEasyOrdersProducts().catch(() => [])).find((p) => String(p.id) === String(b.eo.id));
    if (!found) throw bad('المنتج ده مش موجود في كتالوج إيزي أوردر.');
    eo = { id: found.id, slug: found.slug, name: found.name }; thumb = found.thumb || null;
    name = name || found.name; if (price === undefined || price === null || price === '') price = found.price ?? null;
  }
  const project = await PP.createProject({ name, price, oldPrice: b.oldPrice, facts: b.facts, eo });
  if (thumb) { const img = await fetchImageBytes(thumb).catch(() => null); if (img) await PP.setReference(project.id, img.buffer, img.mime).catch(() => {}); }
  res.status(201).json(await PP.getProject(project.id));
}));

router.get('/:id', asyncRoute(async (req, res) => { const p = await PP.getProject(pid(req)); if (!p) throw bad('المشروع مش موجود.', 404); res.json(p); }));
router.put('/:id', asyncRoute(async (req, res) => res.json(await PP.updateProject(pid(req), req.body || {}))));
router.delete('/:id', asyncRoute(async (req, res) => res.json(await PP.deleteProject(pid(req)))));

router.post('/:id/reference', asyncRoute(async (req, res) => {
  const id = pid(req);
  res.status(201).json(await PP.setReference(id, await readBody(req, 8 * 1024 * 1024 + 1), req.get('Content-Type')));
}));

router.get('/:id/assets/:asset', asyncRoute(async (req, res) => {
  const a = await PP.getAsset(pid(req), req.params.asset);
  if (!a) return res.status(404).end();
  res.set('Content-Type', a.mime); res.set('Cache-Control', 'private, max-age=300'); res.send(a.data);
}));

// ---- AI copy
router.post('/:id/copy', asyncRoute(async (req, res) => {
  const id = pid(req);
  res.status(202).json(publicJob(await startProjectJob('PAGE_COPY', id, req.user?.id ?? null, {}, () => PP.generateCopy(id))));
}));

// ---- images
router.post('/:id/images', asyncRoute(async (req, res) => {
  const id = pid(req);
  const quality = ['low', 'medium', 'high'].includes(req.body?.quality) ? req.body.quality : 'medium';
  const added = await PP.addImages(id, (Array.isArray(req.body?.items) ? req.body.items : []).map((i) => ({ ...i, quality })));
  const job = await startProjectJob('PAGE_IMAGES', id, req.user?.id ?? null, { count: added.length }, (ctx) => PP.runImageBatch({ projectId: id, imageIds: added.map((a) => a.id), ctx }));
  res.status(202).json({ job: publicJob(job), images: added });
}));
router.post('/:id/images/:imgId/regenerate', asyncRoute(async (req, res) => {
  const id = pid(req); const imgId = String(req.params.imgId);
  const p = await PP.getProject(id); const e = p?.images.find((x) => x.id === imgId); if (!e) throw bad('الصورة مش موجودة.', 404);
  await PP.updateImage(id, imgId, req.body || {});
  const job = await startProjectJob('PAGE_IMAGES', id, req.user?.id ?? null, { count: 1 }, (ctx) => PP.runImageBatch({ projectId: id, imageIds: [imgId], ctx }));
  res.status(202).json({ job: publicJob(job) });
}));
router.put('/:id/images-order', asyncRoute(async (req, res) => res.json({ order: await PP.reorderImages(pid(req), req.body?.order) })));
router.put('/:id/images/:imgId', asyncRoute(async (req, res) => res.json(await PP.updateImage(pid(req), String(req.params.imgId), req.body || {}))));
router.delete('/:id/images/:imgId', asyncRoute(async (req, res) => res.json(await PP.removeImage(pid(req), String(req.params.imgId)))));

// ---- videos
router.post('/:id/videos/ai', asyncRoute(async (req, res) => {
  const id = pid(req);
  const explainer = req.body?.mode === 'explainer';
  const input = { mode: explainer ? 'explainer' : 'clip', count: Math.max(1, Math.min(explainer ? MAX_EXPLAINERS : MAX_AI_VIDEOS, Number(req.body?.count) || 1)), scenes: Number(req.body?.scenes) === 4 ? 4 : 3, captions: req.body?.captions !== false, seconds: Number(req.body?.seconds) === 10 ? 10 : 5, style: AI_STYLES[req.body?.style] ? req.body.style : 'ugc' };
  res.status(202).json(publicJob(await startProjectJob('PAGE_AI_VIDEOS', id, req.user?.id ?? null, input, (ctx) => (explainer
    ? runExplainerForPage({ projectId: id, count: input.count, scenes: input.scenes, captions: input.captions, ctx })
    : runPageAiVideos({ projectId: id, count: input.count, seconds: input.seconds, style: input.style, ctx })))));
}));
router.post('/:id/videos/find', asyncRoute(async (req, res) => {
  const id = pid(req);
  const manualUrls = (Array.isArray(req.body?.manualUrls) ? req.body.manualUrls : []).map(String).slice(0, 20).filter(isAllowedVideoUrl);
  const target = Math.max(3, Math.min(30, Number(req.body?.target) || 12));
  res.status(202).json(publicJob(await startProjectJob('PAGE_VIDEO_FIND', id, req.user?.id ?? null, { target }, (ctx) => runPageVideoFinder({ projectId: id, target, manualUrls, ctx }))));
}));
router.post('/:id/videos/link', asyncRoute(async (req, res) => res.status(201).json(await PP.addVideoLink(pid(req), { url: req.body?.url, title: req.body?.title, source: req.body?.source }))));
router.delete('/:id/videos/:vidId', asyncRoute(async (req, res) => res.json(await PP.removeVideo(pid(req), String(req.params.vidId)))));

// ---- export
router.get('/:id/export.zip', asyncRoute(async (req, res) => {
  const { zip, name } = await PP.exportZip(pid(req));
  res.set('Content-Type', 'application/zip'); res.set('Content-Disposition', `attachment; filename="${name}"`); res.send(zip);
}));
router.get('/:id/export.txt', asyncRoute(async (req, res) => {
  const p = await PP.getProject(pid(req)); if (!p) throw bad('المشروع مش موجود.', 404);
  res.set('Content-Type', 'text/plain; charset=utf-8'); res.send(PP.exportCopyText(p));
}));

export default router;
