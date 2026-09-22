// 🚀 مركز التوسّع (Scale Center) — HTTP surface. Mounted at /api/scale-center.
// Same auth tier as AI Media Buyer (requireRole ADMIN|MANAGER for reads;
// preparing a Bump recommendation is ADMIN-only, matching every other
// executable-action route in this app). Every handler here is thin — all
// real logic lives in services/amb/scaleCenter.js, which itself reuses
// productDecision.js/dataQualityGate.js/budgetBumpEngine.js rather than
// reimplementing any of them. No route here ever writes to Meta.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { listScaleCenterProducts, getScaleCenterProduct, getScaleCenterTotals, getScaleCenterProductAudience, previewBumpForAdSet, prepareBumpForAdSet } from '../services/amb/scaleCenter.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));

router.get('/products', asyncRoute(async (req, res) => {
  const { storeId, window, from, to, limit, offset } = req.query;
  res.json(await listScaleCenterProducts({
    storeId: storeId || undefined, windowName: window, from, to,
    limit: limit ? Math.min(50, Math.max(1, Number(limit) || 20)) : undefined,
    offset: offset ? Math.max(0, Number(offset) || 0) : undefined,
  }));
}));

router.get('/totals', asyncRoute(async (req, res) => {
  const { storeId, window, from, to } = req.query;
  res.json(await getScaleCenterTotals({ storeId: storeId || undefined, windowName: window, from, to }));
}));

router.get('/products/:productId', asyncRoute(async (req, res) => {
  const { storeId, window, from, to } = req.query;
  res.json(await getScaleCenterProduct({ productId: req.params.productId, storeId: storeId || undefined, windowName: window, from, to }));
}));

router.get('/products/:productId/audience', asyncRoute(async (req, res) => {
  const { window, from, to } = req.query;
  res.json(await getScaleCenterProductAudience({ productId: req.params.productId, windowName: window, from, to }));
}));

router.get('/bump-preview', asyncRoute(async (req, res) => {
  res.json(await previewBumpForAdSet({ adSetId: req.query.adSetId, pct: req.query.pct }));
}));

router.post('/bump-prepare', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { adSetId, pct, ambProductId, productName } = req.body || {};
  res.status(201).json(await prepareBumpForAdSet({ adSetId, pct, ambProductId, productName }));
}));

export default router;
