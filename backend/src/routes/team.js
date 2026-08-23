import { Router } from 'express';
import { prisma } from '../prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncRoute(async (req, res) => res.json(await prisma.teamMember.findMany())));

router.post('/', requireRole('ADMIN', 'MANAGER'), asyncRoute(async (req, res) => {
  const { name, active = true, daily_task_target = 10 } = req.body;
  const created = await prisma.teamMember.create({ data: { name, active, daily_task_target } });
  res.status(201).json(created);
}));

router.post('/seed-default', requireRole('ADMIN', 'MANAGER'), asyncRoute(async (req, res) => {
  const names = ['محمود', 'احمد', 'سامي', 'عصام', 'حسن'];
  const existing = await prisma.teamMember.findMany({ select: { name: true } });
  const existingNames = new Set(existing.map((m) => m.name));
  let created = 0;
  for (const name of names) {
    if (existingNames.has(name)) continue;
    await prisma.teamMember.create({ data: { name } });
    created++;
  }
  res.json({ created });
}));

export default router;
