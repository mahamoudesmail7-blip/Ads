// Mirrors DailyOrders — all()/forProduct()/forDate()/find()/upsert()/remove()/clearDemoOrders().
import { Router } from 'express';
import { prisma } from '../prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

// GET /api/orders?productId=&date=  — supports all three lookup shapes db.js had as separate methods.
router.get('/', asyncRoute(async (req, res) => {
  const { productId, date } = req.query;
  if (productId && date) {
    const found = await prisma.dailyOrder.findUnique({ where: { product_id_date: { product_id: Number(productId), date } } });
    return res.json(found ?? null);
  }
  if (productId) {
    const rows = await prisma.dailyOrder.findMany({ where: { product_id: Number(productId) }, orderBy: { date: 'asc' } });
    return res.json(rows);
  }
  if (date) {
    const rows = await prisma.dailyOrder.findMany({ where: { date } });
    return res.json(rows);
  }
  res.json(await prisma.dailyOrder.findMany());
}));

router.post('/upsert', asyncRoute(async (req, res) => {
  const { product_id, date, orders_count, delivered_count, returned_count, notes, is_demo = false, source } = req.body;
  const resolvedSource = source || (is_demo ? 'demo' : 'manual');
  const existing = await prisma.dailyOrder.findUnique({ where: { product_id_date: { product_id: Number(product_id), date } } });

  if (existing) {
    const updated = await prisma.dailyOrder.update({
      where: { id: existing.id },
      data: {
        orders_count: orders_count === undefined || orders_count === null ? existing.orders_count : Number(orders_count),
        delivered_count: delivered_count === undefined ? existing.delivered_count : delivered_count === null ? null : Number(delivered_count),
        returned_count: returned_count === undefined ? existing.returned_count : returned_count === null ? null : Number(returned_count),
        notes: notes === undefined ? existing.notes : notes,
        is_demo,
        source: resolvedSource,
      },
    });
    return res.json({ record: updated, created: false });
  }

  const created = await prisma.dailyOrder.create({
    data: {
      product_id: Number(product_id),
      date,
      orders_count: Number(orders_count),
      delivered_count: delivered_count === undefined || delivered_count === null || delivered_count === '' ? null : Number(delivered_count),
      returned_count: returned_count === undefined || returned_count === null || returned_count === '' ? null : Number(returned_count),
      notes: notes || '',
      is_demo,
      source: resolvedSource,
    },
  });
  res.status(201).json({ record: created, created: true });
}));

router.post('/clear-demo', asyncRoute(async (req, res) => {
  const result = await prisma.dailyOrder.deleteMany({ where: { is_demo: true } });
  res.json({ removed: result.count });
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  await prisma.dailyOrder.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
}));

export default router;
