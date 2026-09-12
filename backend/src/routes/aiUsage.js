// AI Gateway — admin usage/cost dashboard + health check (§38/§58/§59/§60).
// ADMIN-only, same auth tier as every other admin-only surface in the app.
// Read-only: nothing here ever triggers a paid AI call except the explicit
// "اختبار الاتصال" health check, which itself only hits OpenAI's free
// model-list endpoint — never a generation call.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { usageSummary, checkBudget, healthCheck, allConfiguredModels, anthropicEnabled } from '../services/aiGateway/index.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN'));

router.get('/summary', asyncRoute(async (req, res) => {
  const [usage, budget] = await Promise.all([usageSummary(), checkBudget()]);
  res.json({ usage, budget, models: allConfiguredModels(), anthropicEnabled: anthropicEnabled() });
}));

router.get('/health', asyncRoute(async (req, res) => {
  res.json(await healthCheck());
}));

export default router;
