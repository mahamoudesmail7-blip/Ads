import { Router } from 'express';
import { prisma } from '../prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncRoute(async (req, res) => {
  const { productId } = req.query;
  const rows = await prisma.productNote.findMany({ where: { product_id: Number(productId) }, orderBy: { created_at: 'desc' } });
  res.json(rows);
}));

router.post('/', asyncRoute(async (req, res) => {
  const { product_id, text } = req.body;
  const created = await prisma.productNote.create({ data: { product_id: Number(product_id), text: String(text).trim() } });
  res.status(201).json(created);
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  await prisma.productNote.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
}));

export default router;
