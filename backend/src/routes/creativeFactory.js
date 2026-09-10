// AI Creative Factory — HTTP surface. Mounted at /api/creative-factory.
// Reads / analysis: ADMIN | MANAGER (same tier as AI Media Buyer). Anything
// that spends the image provider, changes settings, or mutates catalog data
// is ADMIN-only. Handlers are thin; all logic is in services/creativeFactory.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';

import { getProviderStatus } from '../services/creativeFactory/config.js';
import { getCfSettings, saveCfSettings } from '../services/creativeFactory/settings.js';
import { getEffectiveThresholds } from '../services/creativeFactory/thresholds.js';
import { imageProviderCapabilities, getImageProvider, CfProviderError } from '../services/creativeFactory/imageProvider.js';
import {
  STYLE_PRESETS, PROJECT_TYPES, PRODUCT_LOCK_MODES, TEXT_DENSITIES, PEOPLE_RULES, ASPECT_RATIOS,
} from '../services/creativeFactory/taxonomy.js';
import * as P from '../services/creativeFactory/projects.js';
import { analyzeProductDna, saveDnaEdit, getDna } from '../services/creativeFactory/productDna.js';
import { recommendImageCount } from '../services/creativeFactory/creativeStrategy.js';
import { createGenerationJob, cancelJob, retryFailedItems, serializeJob } from '../services/creativeFactory/generationJob.js';
import { prisma } from '../prisma.js';
import { createVariations, familyTree } from '../services/creativeFactory/variations.js';
import { getInsights, recomputeInsights, linkPerformance } from '../services/creativeFactory/learning.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));
const admin = requireRole('ADMIN');

const idParam = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) { const e = new Error('معرّف غير صالح.'); e.status = 400; throw e; } return n; };

// ---------------------------------------------------------------------------
// Status / config / settings
// ---------------------------------------------------------------------------
router.get('/status', asyncRoute(async (req, res) => {
  const [thresholds, settings] = await Promise.all([getEffectiveThresholds(), getCfSettings()]);
  res.json({
    provider: getProviderStatus(),
    capabilities: imageProviderCapabilities(),
    thresholds,
    settings,
    options: {
      projectTypes: PROJECT_TYPES,
      productLockModes: PRODUCT_LOCK_MODES,
      stylePresets: STYLE_PRESETS,
      textDensities: TEXT_DENSITIES,
      peopleRules: PEOPLE_RULES,
      aspectRatios: ASPECT_RATIOS,
      imageCountButtons: [1, 2, 3, 4, 5, 10, 20, 50],
    },
    isAdmin: req.user.is_owner || req.user.role === 'ADMIN',
  });
}));

router.get('/settings', admin, asyncRoute(async (req, res) => res.json(await getCfSettings())));
router.patch('/settings', admin, asyncRoute(async (req, res) => res.json(await saveCfSettings(req.body || {}))));

// Safe backend-only provider connection test — never returns the key.
router.post('/provider/test', admin, asyncRoute(async (req, res) => {
  const status = getProviderStatus();
  if (!status.image.configured) return res.json({ ok: false, status: 'NOT_CONFIGURED', message: 'OPENAI_API_KEY مش متظبط.' });
  try {
    const caps = getImageProvider().getCapabilities();
    res.json({ ok: true, status: 'READY', model: caps.model, capabilities: caps });
  } catch (err) {
    res.json({ ok: false, status: 'ERROR', message: err instanceof CfProviderError ? err.message : 'تعذر التحقق من المزود.' });
  }
}));

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
router.get('/products', asyncRoute(async (req, res) => res.json({ products: await P.listProducts() })));
router.get('/products/catalog', asyncRoute(async (req, res) => res.json({ suggestions: await P.catalogSuggestions() })));
router.post('/products', admin, asyncRoute(async (req, res) => res.status(201).json(await P.createProduct(req.body || {}, req.user.id))));
router.get('/products/:id', asyncRoute(async (req, res) => res.json(await P.getProductFull(idParam(req.params.id)))));
router.patch('/products/:id', admin, asyncRoute(async (req, res) => res.json(await P.updateProduct(idParam(req.params.id), req.body || {}))));

router.post('/products/:id/reference-images', admin, asyncRoute(async (req, res) => {
  res.status(201).json(await P.addReferenceImage(idParam(req.params.id), { dataUrl: req.body?.dataUrl, angleLabel: req.body?.angleLabel }));
}));
router.delete('/products/:id/reference-images/:refId', admin, asyncRoute(async (req, res) => {
  res.json(await P.deleteReferenceImage(idParam(req.params.id), idParam(req.params.refId)));
}));
router.post('/products/:id/reference-images/reorder', admin, asyncRoute(async (req, res) => {
  res.json(await P.reorderReferenceImages(idParam(req.params.id), (req.body?.orderIds || []).map(Number)));
}));
router.get('/products/:id/reference-images/:refId/image', asyncRoute(async (req, res) => {
  const dataUrl = await P.referenceImageDataUrl(idParam(req.params.id), idParam(req.params.refId));
  const [, mime, b64] = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl) || [];
  res.set('Content-Type', mime || 'image/png').set('Cache-Control', 'private, max-age=300').send(Buffer.from(b64 || '', 'base64'));
}));

router.get('/products/:id/dna', asyncRoute(async (req, res) => res.json((await getDna(idParam(req.params.id))) || { productId: idParam(req.params.id), data: null })));
router.post('/products/:id/dna/analyze', admin, asyncRoute(async (req, res) => res.json(await analyzeProductDna(idParam(req.params.id)))));
router.patch('/products/:id/dna', admin, asyncRoute(async (req, res) => res.json(await saveDnaEdit(idParam(req.params.id), req.body?.data || {}))));

// ---------------------------------------------------------------------------
// Projects + plan
// ---------------------------------------------------------------------------
router.get('/projects', asyncRoute(async (req, res) => res.json({
  projects: await P.listProjects({
    productId: req.query.productId, projectType: req.query.projectType, status: req.query.status,
    includeArchived: req.query.includeArchived === '1',
  }),
})));
router.post('/projects', admin, asyncRoute(async (req, res) => res.status(201).json(await P.createProject(req.body || {}, req.user.id))));
router.patch('/projects/:id', admin, asyncRoute(async (req, res) => res.json(await P.updateProjectSettings(idParam(req.params.id), req.body || {}))));
router.post('/projects/estimate-cost', asyncRoute(async (req, res) => res.json(await P.estimateProjectCost({ count: req.body?.count, generationMode: req.body?.generationMode, aspectRatio: req.body?.aspectRatio }))));
router.get('/projects/:id', asyncRoute(async (req, res) => res.json(await P.getProjectFull(idParam(req.params.id)))));

router.post('/projects/:id/recommend-count', asyncRoute(async (req, res) => {
  const id = idParam(req.params.id);
  const project = await prisma.cfProject.findUnique({ where: { id }, include: { product: { include: { _count: { select: { reference_images: true } } } } } });
  if (!project) { const e = new Error('المشروع غير موجود.'); e.status = 404; throw e; }
  const dna = await getDna(project.product_id);
  res.json(await recommendImageCount({ product: project.product, dna: dna?.data, projectType: project.project_type, referenceCount: project.product._count.reference_images }));
}));

router.post('/projects/:id/plan', admin, asyncRoute(async (req, res) => res.json(await P.generatePlan(idParam(req.params.id), { count: req.body?.count }))));
router.patch('/projects/:id/plan/items/:itemId', admin, asyncRoute(async (req, res) => res.json(await P.updatePlanItem(idParam(req.params.id), idParam(req.params.itemId), req.body || {}))));
router.post('/projects/:id/plan/items', admin, asyncRoute(async (req, res) => res.status(201).json(await P.addPlanItem(idParam(req.params.id), req.body || {}))));
router.delete('/projects/:id/plan/items/:itemId', admin, asyncRoute(async (req, res) => res.json(await P.deletePlanItem(idParam(req.params.id), idParam(req.params.itemId)))));
router.post('/projects/:id/plan/reorder', admin, asyncRoute(async (req, res) => res.json(await P.reorderPlanItems(idParam(req.params.id), (req.body?.orderIds || []).map(Number)))));
router.post('/projects/:id/plan/approve', admin, asyncRoute(async (req, res) => res.json(await P.approvePlan(idParam(req.params.id)))));

router.post('/projects/:id/generate', admin, asyncRoute(async (req, res) => {
  res.status(202).json(await createGenerationJob({ projectId: idParam(req.params.id), itemIds: Array.isArray(req.body?.itemIds) ? req.body.itemIds.map(Number) : null, userId: req.user.id }));
}));
router.post('/projects/:id/retry-failed', admin, asyncRoute(async (req, res) => res.status(202).json(await retryFailedItems({ projectId: idParam(req.params.id), userId: req.user.id }))));
router.post('/projects/:id/archive', admin, asyncRoute(async (req, res) => res.json(await P.archiveProject(idParam(req.params.id)))));
router.post('/projects/:id/duplicate', admin, asyncRoute(async (req, res) => res.status(201).json(await P.duplicateProject(idParam(req.params.id), req.user.id))));

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
router.get('/jobs/:id', asyncRoute(async (req, res) => {
  const job = await prisma.cfJob.findUnique({ where: { id: idParam(req.params.id) } });
  if (!job) { const e = new Error('المهمة غير موجودة.'); e.status = 404; throw e; }
  res.json(serializeJob(job));
}));
router.post('/jobs/:id/cancel', admin, asyncRoute(async (req, res) => res.json(await cancelJob(idParam(req.params.id)))));

// ---------------------------------------------------------------------------
// Assets / gallery / variations / family tree
// ---------------------------------------------------------------------------
router.get('/assets', asyncRoute(async (req, res) => res.json(await P.listAssets({
  productId: req.query.productId, projectId: req.query.projectId, status: req.query.status,
  includeCandidates: req.query.includeCandidates === '1', limit: req.query.limit, cursor: req.query.cursor,
}))));
router.get('/assets/:id', asyncRoute(async (req, res) => res.json(await P.getAssetFull(idParam(req.params.id)))));
router.get('/assets/:id/image', asyncRoute(async (req, res) => {
  const { buffer, mime } = await P.assetImageResponse(idParam(req.params.id));
  res.set('Content-Type', mime || 'image/png').set('Cache-Control', 'private, max-age=600').send(buffer);
}));
router.post('/assets/:id/status', admin, asyncRoute(async (req, res) => res.json(await P.setAssetStatus(idParam(req.params.id), String(req.body?.status || '')))));
router.post('/assets/:id/feedback', asyncRoute(async (req, res) => res.status(201).json(await P.saveAssetFeedback(idParam(req.params.id), { verdict: req.body?.verdict, reason: req.body?.reason, note: req.body?.note }, req.user.id))));
router.post('/assets/:id/variations', admin, asyncRoute(async (req, res) => {
  res.status(202).json(await createVariations({
    parentAssetId: idParam(req.params.id), variationType: String(req.body?.variationType || ''),
    count: req.body?.count, instructions: req.body?.instructions, userId: req.user.id,
  }));
}));
router.get('/assets/:id/family', asyncRoute(async (req, res) => res.json((await familyTree(idParam(req.params.id))) || { rootId: null, edges: [] })));

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------
router.get('/learning', asyncRoute(async (req, res) => {
  const { getFeedbackHints } = await import('../services/creativeFactory/projects.js');
  const [insights, feedback] = await Promise.all([getInsights(), getFeedbackHints(req.query.category || null)]);
  res.json({ ...insights, feedback });
}));
router.post('/learning/recompute', admin, asyncRoute(async (req, res) => res.json(await recomputeInsights())));
router.post('/learning/link', admin, asyncRoute(async (req, res) => res.status(201).json(await linkPerformance(req.body || {}))));

export default router;
