// Meta quota — who uses it? ADMIN only, read only. Shows Meta's own latest reading per ad account (CPU / time % of the limit, minutes to regain) and the heaviest callers of the last N minutes
// (the code path that made each Graph call, by Graph time). Nothing here calls Meta.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { usageReadings, topConsumers } from '../services/metaUsage.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN'));
router.get('/', asyncRoute(async (req, res) => {
  const minutes = Math.min(120, Math.max(5, Number(req.query.minutes) || 60));
  const account = req.query.account ? String(req.query.account) : null;
  res.json({ minutes, account, readings: usageReadings(), consumers: topConsumers({ minutes, account }), note: 'in-memory since the last server start; Graph time (ms) is the measure that tracks Meta\'s CPU/time limit' });
}));
export default router;
