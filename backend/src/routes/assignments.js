import { Router } from 'express';
import { prisma } from '../prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncRoute(async (req, res) => {
  const { date, productId } = req.query;
  if (productId && date) {
    const found = await prisma.taskAssignment.findUnique({ where: { product_id_date: { product_id: Number(productId), date } } });
    return res.json(found ?? null);
  }
  res.json(await prisma.taskAssignment.findMany({ where: date ? { date } : undefined }));
}));

router.post('/assign', requireRole('ADMIN', 'MANAGER'), asyncRoute(async (req, res) => {
  const { productId, date, employeeId } = req.body;
  const existing = await prisma.taskAssignment.findUnique({ where: { product_id_date: { product_id: Number(productId), date } } });
  const saved = existing
    ? await prisma.taskAssignment.update({ where: { id: existing.id }, data: { employee_id: Number(employeeId) } })
    : await prisma.taskAssignment.create({ data: { product_id: Number(productId), date, employee_id: Number(employeeId) } });
  res.json(saved);
}));

// Bulk-assign: { date, assignments: [[productId, employeeId], ...], alreadyAssignedProductIds: [...] }
router.post('/bulk', requireRole('ADMIN', 'MANAGER'), asyncRoute(async (req, res) => {
  const { date, assignments, alreadyAssignedProductIds = [] } = req.body;
  const already = new Set(alreadyAssignedProductIds);
  let created = 0;
  for (const [productId, employeeId] of assignments) {
    if (already.has(productId)) continue;
    await prisma.taskAssignment.upsert({
      where: { product_id_date: { product_id: Number(productId), date } },
      create: { product_id: Number(productId), date, employee_id: Number(employeeId) },
      update: { employee_id: Number(employeeId) },
    });
    created++;
  }
  res.json({ created });
}));

export default router;
