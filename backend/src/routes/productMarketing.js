// AI Product Marketing Center — "مركز التسويق الذكي للمنتج". Mounted at
// /api/product-marketing. Fully additive/isolated module — same auth tier as
// AI Media Buyer (ADMIN|MANAGER read/analyze; ADMIN for decisions). Never
// writes to Meta: every handler here is read/analyze/decide-a-recommendation
// only. See services/amb/productMarketing.js for the real logic.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import * as PM from '../services/amb/productMarketing.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));

function idParam(v) { const n = Number(v); if (!Number.isInteger(n) || n <= 0) { const e = new Error('مُعرّف غير صالح.'); e.status = 400; throw e; } return n; }

// ---- Product source / lock ----
router.get('/easy-orders/search', asyncRoute(async (req, res) => {
  res.json({ products: await PM.searchEasyOrdersProducts(req.query.q) });
}));
router.post('/profiles/from-easy-orders', asyncRoute(async (req, res) => {
  res.status(201).json(await PM.lockFromEasyOrders({ eoProductId: req.body?.eoProductId, userId: req.user.id }));
}));
router.post('/profiles/from-images', asyncRoute(async (req, res) => {
  const images = Array.isArray(req.body?.images) ? req.body.images : [];
  res.status(201).json(await PM.lockFromImages({ images, userId: req.user.id }));
}));
router.get('/profiles', asyncRoute(async (req, res) => res.json({ profiles: await PM.listProfiles() })));
router.get('/profiles/:id', asyncRoute(async (req, res) => res.json(await PM.getProfile(idParam(req.params.id)))));
router.get('/profiles/:id/images/:imageId', asyncRoute(async (req, res) => {
  const dataUrl = await PM.getProfileImage(idParam(req.params.id), idParam(req.params.imageId));
  const [, mime, b64] = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl) || [];
  res.set('Content-Type', mime || 'image/png').set('Cache-Control', 'private, max-age=300').send(Buffer.from(b64 || '', 'base64'));
}));

// ---- Snapshot ("the brain") ----
router.get('/profiles/:id/snapshot', asyncRoute(async (req, res) => {
  const snap = await PM.getSnapshot({ profileId: idParam(req.params.id), windowName: req.query.window });
  res.json({ snapshot: snap, stale: !snap });
}));
router.post('/profiles/:id/analyze', asyncRoute(async (req, res) => {
  res.json(await PM.computeSnapshot({ profileId: idParam(req.params.id), windowName: req.body?.window, force: req.body?.force === true }));
}));

// ---- Memory (§22) ----
router.get('/profiles/:id/memory', asyncRoute(async (req, res) => res.json({ entries: await PM.getMemory(idParam(req.params.id)) })));

// ---- AI Actions (§21) ----
router.get('/profiles/:id/actions', asyncRoute(async (req, res) => res.json({ actions: await PM.listActions(idParam(req.params.id)) })));
router.post('/actions/:actionId/decide', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  res.json(await PM.decideAction({ actionId: idParam(req.params.actionId), status: req.body?.status, note: req.body?.note, userId: req.user.id }));
}));

// ---- Hook Lab / Post Generator / Creative Ideas / Test Pack (§15–17, §24) — on demand only ----
router.post('/profiles/:id/hooks', asyncRoute(async (req, res) => {
  res.json(await PM.hookLab({ profileId: idParam(req.params.id), angle: req.body?.angle, category: req.body?.category, count: req.body?.count }));
}));
router.post('/profiles/:id/posts', asyncRoute(async (req, res) => {
  res.json(await PM.postGenerator({ profileId: idParam(req.params.id), angle: req.body?.angle, tone: req.body?.tone }));
}));
router.post('/profiles/:id/creative-ideas', asyncRoute(async (req, res) => {
  res.json(await PM.creativeIdeas({ profileId: idParam(req.params.id), angle: req.body?.angle, count: req.body?.count }));
}));
router.post('/profiles/:id/test-pack', asyncRoute(async (req, res) => {
  res.json(await PM.testPack({ profileId: idParam(req.params.id), angle: req.body?.angle }));
}));

// ---- Creative Factory handoff (§17 button) — read-only readiness check; the actual send re-uses the Creative Factory UI/API as-is ----
router.get('/profiles/:id/creative-factory-readiness', asyncRoute(async (req, res) => {
  res.json(await PM.creativeFactoryReadiness(idParam(req.params.id)));
}));

// ---- Competitor Intelligence (§18) — read-only reuse of Product Research data ----
router.get('/profiles/:id/competitors', asyncRoute(async (req, res) => res.json(await PM.competitorIntel(idParam(req.params.id)))));

export default router;
