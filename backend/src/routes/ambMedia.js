// AMB Media — HTTP surface for the smart media tools of the launch wizard. Mounted at /api/amb-media.
// Everything here is ADMIN-only: it spends provider credit or handles provider keys. Keys are write-only — never returned.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { getMediaKeysStatus, setMediaKey, clearMediaKey, testMediaKey } from '../services/amb/media/mediaKeys.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN'));

router.get('/keys', asyncRoute(async (_req, res) => res.json({ providers: await getMediaKeysStatus() })));
router.put('/keys/:provider', asyncRoute(async (req, res) => res.json(await setMediaKey(req.params.provider, req.body?.value))));
router.delete('/keys/:provider', asyncRoute(async (req, res) => res.json(await clearMediaKey(req.params.provider))));
router.post('/keys/:provider/test', asyncRoute(async (req, res) => res.json(await testMediaKey(req.params.provider))));

export default router;
