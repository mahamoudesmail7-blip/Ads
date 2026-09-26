// Winner Products Discovery Engine — routes. ADMIN/MANAGER only, same tier
// as Settings/Meta/Product Research (no separate "Media Buyer" role exists
// yet — see productResearch.js's own note on this).
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import * as winnerProducts from '../services/winnerProducts.js';
import { runProviderSearch } from '../services/searchProviders/index.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));

router.get('/provider-status', asyncRoute(async (req, res) => {
  res.json({ providers: await winnerProducts.getProviderStatus() });
}));

// Temporary diagnostic route — one real, isolated request per platform
// through the ACTUAL code path (runProviderSearch), returning the raw,
// unclassified error exactly as thrown (httpStatus + message text) instead
// of the pre-classified label getProviderStatus() shows. Added to answer a
// direct request to see SerpApi's literal response rather than assume
// "Quota" — safe to remove once the live diagnosis is done (admin/manager
// only, read-only, no writes).
router.get('/debug/test-provider', asyncRoute(async (req, res) => {
  const platform = String(req.query.platform || '');
  if (!['instagram', 'facebook', 'tiktok'].includes(platform)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'platform لازم يكون instagram أو facebook أو tiktok' });
  }
  const query = String(req.query.query || 'شحن مجاني');
  const endpoint = 'https://serpapi.com/search.json';
  try {
    const result = await runProviderSearch({ platform, query, resultsLimit: 5 });
    return res.json({
      ok: true,
      platform,
      provider: result.providerName,
      endpoint,
      itemCount: result.items.length,
      sampleItem: result.items[0] || null,
    });
  } catch (err) {
    return res.json({
      ok: false,
      platform,
      endpoint,
      httpStatus: err.httpStatus ?? null,
      errorName: err.name || null,
      errorMessage: err.message || String(err),
    });
  }
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
