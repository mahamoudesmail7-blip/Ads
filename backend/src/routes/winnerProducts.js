// Winner Products Discovery Engine — routes. ADMIN/MANAGER only, same tier
// as Settings/Meta/Product Research (no separate "Media Buyer" role exists
// yet — see productResearch.js's own note on this).
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import * as winnerProducts from '../services/winnerProducts.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));

router.get('/provider-status', asyncRoute(async (req, res) => {
  res.json({ providers: await winnerProducts.getProviderStatus() });
}));

router.get('/categories', asyncRoute(async (req, res) => {
  res.json({ categories: await winnerProducts.listCategories() });
}));

router.post('/search', asyncRoute(async (req, res) => {
  const { category, market, timeRange, mode } = req.body || {};
  if (!category) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'اختار قسم المنتج الأول.' });
  const search = await winnerProducts.startSearch({ userId: req.user.id, category, market, timeRange, mode });
  res.status(202).json({ searchId: search.id, status: search.status });
}));

router.get('/search/:id', asyncRoute(async (req, res) => {
  const result = await winnerProducts.getSearch(Number(req.params.id));
  if (!result) return res.status(404).json({ error: 'NOT_FOUND', message: 'البحث غير موجود.' });
  res.json(result);
}));

router.post('/saved/:productId', asyncRoute(async (req, res) => {
  const row = await winnerProducts.saveProduct(req.user.id, Number(req.params.productId));
  res.status(201).json(row);
}));

router.delete('/saved/:productId', asyncRoute(async (req, res) => {
  await winnerProducts.unsaveProduct(req.user.id, Number(req.params.productId));
  res.json({ ok: true });
}));

router.get('/saved', asyncRoute(async (req, res) => {
  res.json({ products: await winnerProducts.listSaved(req.user.id) });
}));

export default router;
