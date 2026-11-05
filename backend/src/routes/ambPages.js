// AMB Media — PRODUCT PAGE projects (build a product page from A to Z). Mounted at /api/amb-media/pages. ADMIN only (spends AI credit).
// Long work (copy, images, videos, video search) runs as a job on the shared job runner; the screen polls GET /api/amb-media/jobs/:id.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { createJob, startJob } from '../services/amb/media/mediaJobs.js';
import * as PP from '../services/amb/media/pageProjects.js';
import { templateList } from '../services/amb/media/pageTemplates.js';
import { PAGE_STYLES, PAGE_PACK } from '../services/amb/media/pageStyles.js';
import { runPageAiVideos, runPageVideoFinder } from '../services/amb/media/pageVideos.js';
import * as SC from '../services/amb/media/smartCampaign.js';
import * as SL from '../services/amb/media/smartLaunch.js';
import * as EP from '../services/amb/media/eoPublish.js';
import { MAX_AI_VIDEOS, AI_STYLES } from '../services/amb/media/aiVideos.js';
import { runExplainerForPage, MAX_EXPLAINERS } from '../services/amb/media/explainerRuns.js';
import { isAllowedVideoUrl } from '../services/amb/media/ytdlp.js';
import { fetchImageBytes } from '../services/amb/media/productImage.js';
import { searchEasyOrdersProductsAllStores, getEasyOrdersProductDetail } from '../services/amb/easyOrdersProducts.js';

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
router.get('/templates', asyncRoute(async (_req, res) => res.json({ templates: templateList(), styles: Object.entries(PAGE_STYLES).map(([id, st]) => ({ id, label: st.label, hint: st.hint, hasRefs: Object.keys(st.refs).length > 0 })), pack: PAGE_PACK.map(({ template, label }) => ({ template, label })), videoStyles: Object.keys(AI_STYLES), maxAiVideos: MAX_AI_VIDEOS })));

router.get('/eo-products', asyncRoute(async (req, res) => {
  res.json({ products: await searchEasyOrdersProductsAllStores(req.query.q) });
}));
// everything Easy Orders knows about one product (description, every image, sale price, categories, stock) — used to pre-fill the new-page form
router.get('/eo-products/:storeId/:productId', asyncRoute(async (req, res) => {
  try { res.json(await getEasyOrdersProductDetail(String(req.params.storeId), String(req.params.productId))); }
  catch (e) { throw bad(e.message, 502); }
}));

// ---- Smart Campaign journey: research + readiness (the same project row, plus its `smart` section)
router.post('/:id/research', asyncRoute(async (req, res) => {
  const id = pid(req);
  if (!(await PP.getProject(id))) throw bad('المشروع مش موجود.', 404);
  const job = await startProjectJob('SMART_RESEARCH', id, req.user?.id ?? null, {}, async (ctx) => { await ctx.progress(10, 'بحلّل المنتج والجمهور'); const r = await SC.runResearch(id); await ctx.progress(100, 'خلص'); return { research: r }; });
  res.status(202).json({ job: publicJob(job) });
}));
router.get('/:id/journey', asyncRoute(async (req, res) => {
  const p = await PP.getProject(pid(req)); if (!p) throw bad('المشروع مش موجود.', 404);
  res.json({ steps: SC.stepStates(p), readiness: SC.readiness(p), research: p.smart?.research || null, suggestedTargeting: SC.suggestTargeting(p.smart?.research), smart: { publish: p.smart?.publish || null, launch: p.smart?.launch || null } });
}));

// ---- Smart Campaign → campaign step (the launch engine itself stays under /api/ai-media-buyer/launch/*)
router.get('/:id/launch-context', asyncRoute(async (req, res) => { try { res.json(await SL.launchContext(pid(req))); } catch (e) { throw bad(e.message, e.code === 'NOT_FOUND' ? 404 : 400); } }));
router.post('/:id/launch-assets', asyncRoute(async (req, res) => {
  const id = pid(req); const launchJobId = String(req.body?.launchJobId || '');
  if (!/^[a-z0-9_-]{8,80}$/i.test(launchJobId)) throw bad('معرّف طلب الرفع غير صالح.');
  if (!(await PP.getProject(id))) throw bad('المشروع مش موجود.', 404);
  const job = await startProjectJob('SMART_LAUNCH_ASSETS', id, req.user?.id ?? null, { launchJobId }, (ctx) => SL.runRegisterAssets({ projectId: id, launchJobId, ctx }));
  res.status(202).json(publicJob(job));
}));
router.post('/:id/launch-link', asyncRoute(async (req, res) => { try { res.json(await SL.linkLaunch(pid(req), { jobId: req.body?.jobId, status: req.body?.status ? String(req.body.status).slice(0, 20) : null })); } catch (e) { throw bad(e.message, e.code === 'NOT_FOUND' ? 404 : 400); } }));

// ---- Smart Campaign → «النشر على المتجر»: preview, then an explicit confirmed update of the linked Easy Orders product's TEXT (WRITES to the live store)
const pubOpts = (src) => ({ name: src?.name === true || src?.name === '1', description: src?.description === undefined ? true : (src.description === true || src.description === '1'), prices: src?.prices === true || src?.prices === '1' });
const mediaErr = (e) => bad(e.message, e.code === 'NOT_FOUND' ? 404 : e.code === 'EO_REJECTED' ? 502 : e.code === 'STALE_PREVIEW' || e.code === 'NOT_CONFIRMED' ? 409 : 400);
router.get('/:id/eo-publish/preview', asyncRoute(async (req, res) => { try { res.json(await EP.previewUpdate(pid(req), pubOpts(req.query))); } catch (e) { throw mediaErr(e); } }));
router.post('/:id/eo-publish', asyncRoute(async (req, res) => { try { res.json(await EP.applyUpdate(pid(req), pubOpts(req.body?.options), { hash: String(req.body?.hash || ''), confirm: req.body?.confirm })); } catch (e) { throw mediaErr(e); } }));

// ---- projects
router.get('/', asyncRoute(async (_req, res) => res.json({ projects: await PP.listProjects() })));

router.post('/', asyncRoute(async (req, res) => {
  const b = req.body || {};
  let eo = null, name = b.name, price = b.price, oldPrice = b.oldPrice, facts = b.facts, cover = null;
  if (b.eo?.id) { // the Easy Orders product is looked up on OUR side: the browser never supplies image URLs, prices or text for it
    let d;
    try { d = await getEasyOrdersProductDetail(String(b.eo.storeId || ''), String(b.eo.id)); } catch (e) { throw bad(e.message, 502); }
    eo = { id: d.id, storeId: d.storeId, slug: d.slug, name: d.name, categories: d.categories, quantity: d.quantity, trackStock: d.trackStock, freeShipping: d.freeShipping, images: d.images };
    name = name || d.name;
    if (price === undefined || price === null || price === '') { price = d.price; if (oldPrice === undefined || oldPrice === null || oldPrice === '') oldPrice = d.oldPrice; }
    if (!Array.isArray(facts) || !facts.length) facts = d.facts;
    cover = d.thumb || d.images[0] || null;
  }
  const project = await PP.createProject({ name, price, oldPrice, facts, eo });
  if (cover) { const img = await fetchImageBytes(cover).catch(() => null); if (img) await PP.setReference(project.id, img.buffer, img.mime).catch(() => {}); }
  res.status(201).json(await PP.getProject(project.id));
}));
// re-read the linked product from Easy Orders (stock, categories, images…); with overwrite:true the name / price / facts are replaced too
router.post('/:id/eo-sync', asyncRoute(async (req, res) => {
  const id = pid(req); const p = await PP.getProject(id);
  if (!p?.eo?.id) throw bad('الصفحة دي مش مربوطة بمنتج من Easy Orders.');
  let d;
  try { d = await getEasyOrdersProductDetail(String(p.eo.storeId || ''), String(p.eo.id)); } catch (e) { throw bad(e.message, 502); }
  await PP.applyEoSync(id, d, { overwrite: !!(req.body && req.body.overwrite) });
  res.json(await PP.getProject(id));
}));
// use one of the product's Easy Orders pictures as THE reference photo (the URL comes from our stored list, by index — never from the browser)
router.post('/:id/reference-from-eo', asyncRoute(async (req, res) => {
  const id = pid(req); const p = await PP.getProject(id);
  const url = p?.eo?.images?.[Number(req.body?.index)];
  if (!url) throw bad('الصورة دي مش موجودة في صور المنتج.');
  const img = await fetchImageBytes(url).catch(() => null);
  if (!img) throw bad('تعذّر تنزيل الصورة من Easy Orders.', 502);
  await PP.setReference(id, img.buffer, img.mime);
  res.json(await PP.getProject(id));
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
// the 5-image page pack: hero, problem, problem+solution, demonstration, final CTA — one design system, the product locked
router.post('/:id/images/pack', asyncRoute(async (req, res) => {
  const id = pid(req);
  const quality = ['low', 'medium', 'high'].includes(req.body?.quality) ? req.body.quality : 'high';
  if (req.body?.style) await PP.updateProject(id, { style: req.body.style });
  const added = await PP.addPack(id, { quality });
  const job = await startProjectJob('PAGE_IMAGES', id, req.user?.id ?? null, { count: added.length, pack: true }, (ctx) => PP.runImageBatch({ projectId: id, imageIds: added.map((a) => a.id), ctx }));
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
