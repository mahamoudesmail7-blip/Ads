import { Router } from 'express';
import { prisma } from '../prisma.js';

const router = Router();
const startedAt = Date.now();

router.get('/', async (req, res) => {
  let db = 'connected';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    db = 'error';
  }
  res.status(db === 'connected' ? 200 : 503).json({
    status: db === 'connected' ? 'ok' : 'degraded',
    db,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  });
});

export default router;
