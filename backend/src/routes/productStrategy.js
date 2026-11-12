// AI Product Targeting & Creative Strategy — mounted at /api/product-strategy. ADMIN / MANAGER only. Read-mostly: it analyses photos + product data and WRITES TEXT into its own settings row.
// It never writes to Meta, never touches AUTOPILOT, budgets, pauses or any campaign.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import * as PS from '../services/amb/productStrategy/engine.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));

// StrategyError carries a real Arabic message + status — surfaced as-is (asyncRoute honours err.status)
const view = (req) => PS.getView(req.params.id);

router.get('/products', asyncRoute(async (req, res) => res.json({ products: await PS.listProductsLight({ storeId: req.query.storeId || null }) })));
router.get('/drafts', asyncRoute(async (req, res) => res.json({ drafts: await PS.listDrafts() })));
router.post('/drafts', asyncRoute(async (req, res) => res.status(201).json({ draft: await PS.createDraft(req.body || {}) })));
router.delete('/drafts/:id', asyncRoute(async (req, res) => res.json(await PS.deleteDraft(req.params.id))));
router.get('/products/:id', asyncRoute(async (req, res) => res.json(await view(req))));
router.post('/products/:id/page', asyncRoute(async (req, res) => { await PS.analyzePage(req.params.id, { url: req.body?.url }); res.json(await view(req)); }));
router.post('/products/:id/interests', asyncRoute(async (req, res) => { await PS.buildInterests(req.params.id, { force: !!req.body?.force }); res.json(await view(req)); }));
router.get('/products/:id/real-audience', asyncRoute(async (req, res) => res.json(await PS.realAudience(req.params.id, {}, String(req.query.window || 'last30')))));
router.get('/products/:id/images/:slot', asyncRoute(async (req, res) => {
  const b = await PS.getImageBlob(req.params.id, req.params.slot);
  if (!b) return res.status(404).json({ error: 'NOT_FOUND', message: 'الصورة مش موجودة.' });
  res.set('Content-Type', b.mime); res.set('Cache-Control', 'private, max-age=60'); res.send(b.data);
}));
router.post('/products/:id/images/:slot', asyncRoute(async (req, res) => { await PS.putImage(req.params.id, req.params.slot, req.body?.dataUrl); res.json(await view(req)); }));
router.delete('/products/:id/images/:slot', asyncRoute(async (req, res) => { await PS.removeImage(req.params.id, req.params.slot); res.json(await view(req)); }));
router.put('/products/:id/commercial', asyncRoute(async (req, res) => { await PS.saveCommercial(req.params.id, req.body || {}); res.json(await view(req)); }));

router.post('/products/:id/analyze', asyncRoute(async (req, res) => { await PS.analyze(req.params.id, { force: req.body?.force === true }); res.json(await view(req)); }));
router.post('/products/:id/targeting', asyncRoute(async (req, res) => { await PS.buildTargeting(req.params.id, { force: req.body?.force === true }); res.json(await view(req)); }));
router.post('/products/:id/posts', asyncRoute(async (req, res) => { await PS.generatePosts(req.params.id, { force: req.body?.force === true }); res.json(await view(req)); }));
router.post('/products/:id/posts/:type/regenerate', asyncRoute(async (req, res) => { await PS.regeneratePost(req.params.id, req.params.type, { instruction: req.body?.instruction }); res.json(await view(req)); }));
router.put('/products/:id/posts/:type', asyncRoute(async (req, res) => { await PS.savePost(req.params.id, req.params.type, req.body || {}); res.json(await view(req)); }));
router.post('/products/:id/posts/:type/revert', asyncRoute(async (req, res) => { await PS.revertPost(req.params.id, req.params.type); res.json(await view(req)); }));

export default router;
