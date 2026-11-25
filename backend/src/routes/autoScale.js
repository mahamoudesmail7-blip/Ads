// Auto scale («اسكيل أوتوماتيك») — mounted at /api/auto-scale. The status is readable by ADMIN|MANAGER (the media buyers see what the system is doing); everything that changes it
// or can write to Meta (switch on/off, config, run now, stop) is ADMIN only. The preview only READS from Meta.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import * as AS from '../services/amb/autoScale.js';

const router = Router();
router.use(requireAuth);

router.get('/', requireRole('ADMIN', 'MANAGER'), asyncRoute(async (req, res) => res.json(await AS.getAutoScaleStatus())));
router.get('/accounts', requireRole('ADMIN'), asyncRoute(async (req, res) => res.json(await AS.listAccountsForConfig())));
router.get('/preview', requireRole('ADMIN'), asyncRoute(async (req, res) => res.json(await AS.previewAutoScale())));
router.put('/config', requireRole('ADMIN'), asyncRoute(async (req, res) => { await AS.saveConfig(req.body || {}, { userId: req.user.id }); res.json(await AS.getAutoScaleStatus()); }));
router.post('/enabled', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'enabled لازم true أو false.' });
  await AS.setEnabled(req.body.enabled, { userId: req.user.id }); res.json(await AS.getAutoScaleStatus());
}));
// «شغّل دلوقتي»: the same pass as the daily run, started by the owner (it writes to Meta exactly like the daily run does). Needs an explicit confirm in the body.
router.post('/run-now', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'CONFIRM_REQUIRED', message: 'لازم تأكيد صريح قبل ما الاسكيل يبدأ.' });
  AS.runAutoScale({ force: true, trigger: 'MANUAL', userId: req.user.id }).catch(() => {}); // runs in the background: the screen polls the status
  res.status(202).json({ started: true });
}));
router.post('/stop', requireRole('ADMIN'), asyncRoute(async (req, res) => res.json({ stopped: AS.requestStop() })));

export default router;
