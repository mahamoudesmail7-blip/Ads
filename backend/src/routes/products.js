// Mirrors js/db.js's Products repository 1:1 so the rewritten frontend
// db.js can call these endpoints and get back the exact same shapes.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

const productSchema = z.object({
  product_name: z.string().min(1),
  sku: z.string().optional().nullable(),
  product_code: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  selling_price: z.number().optional(),
  product_cost: z.number().optional(),
  active: z.boolean().optional(),
  is_demo: z.boolean().optional(),
  shipping_cost: z.number().nullable().optional(),
  packaging_cost: z.number().nullable().optional(),
  other_cost: z.number().nullable().optional(),
  advertising_cost: z.number().nullable().optional(),
  expected_return_cost: z.number().nullable().optional(),
  commission: z.number().nullable().optional(),
  current_stock: z.number().nullable().optional(),
  minimum_stock: z.number().nullable().optional(),
  supplier: z.string().nullable().optional(),
  restock_quantity: z.number().nullable().optional(),
  last_restock_date: z.string().nullable().optional(),
});

router.get('/', asyncRoute(async (req, res) => res.json(await prisma.product.findMany())));

router.get('/next-code', asyncRoute(async (req, res) => {
  const all = await prisma.product.findMany({ select: { product_code: true } });
  let max = 0;
  for (const p of all) {
    const m = /^PRD-(\d+)$/.exec(p.product_code || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  res.json({ code: `PRD-${String(max + 1).padStart(3, '0')}` });
}));

router.get('/by-sku/:sku', asyncRoute(async (req, res) => {
  const found = await prisma.product.findFirst({ where: { sku: req.params.sku } });
  res.json(found ?? null);
}));

router.get('/by-code/:code', asyncRoute(async (req, res) => {
  const found = await prisma.product.findUnique({ where: { product_code: req.params.code } });
  res.json(found ?? null);
}));

router.get('/find-duplicate', asyncRoute(async (req, res) => {
  const { product_name, sku } = req.query;
  const all = await prisma.product.findMany();
  const cleanSku = (sku || '').trim().toLowerCase();
  if (cleanSku) {
    const bySku = all.find((p) => (p.sku || '').trim().toLowerCase() === cleanSku);
    if (bySku) return res.json(bySku);
  }
  const cleanName = (product_name || '').trim().toLowerCase();
  res.json(all.find((p) => p.product_name.trim().toLowerCase() === cleanName) || null);
}));

router.get('/:id', asyncRoute(async (req, res) => {
  const found = await prisma.product.findUnique({ where: { id: Number(req.params.id) } });
  res.json(found ?? null);
}));

router.post('/', requireRole('ADMIN', 'MANAGER'), asyncRoute(async (req, res) => {
  const body = productSchema.parse(req.body);
  const created = await prisma.product.create({
    data: { ...body, product_name: body.product_name.trim(), sku: (body.sku || '').trim() },
  });
  res.status(201).json(created);
}));

router.patch('/:id', requireRole('ADMIN', 'MANAGER'), asyncRoute(async (req, res) => {
  const updated = await prisma.product.update({ where: { id: Number(req.params.id) }, data: req.body });
  res.json(updated);
}));

router.delete('/:id', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  await prisma.product.delete({ where: { id: Number(req.params.id) } });
  res.json({ ok: true });
}));

export default router;
