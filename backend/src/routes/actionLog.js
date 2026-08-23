// Mirrors ActionLog — one row per (product_id, date), written only when a
// human actually acts (markCompleted/markNotCompleted), same as db.js.
import { Router } from 'express';
import { prisma } from '../prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncRoute(async (req, res) => {
  const { productId, date } = req.query;
  if (productId && date) {
    const found = await prisma.actionLog.findUnique({ where: { product_id_date: { product_id: Number(productId), date } } });
    return res.json(found ?? null);
  }
  if (productId) return res.json(await prisma.actionLog.findMany({ where: { product_id: Number(productId) }, orderBy: { date: 'desc' } }));
  if (date) return res.json(await prisma.actionLog.findMany({ where: { date } }));
  res.json(await prisma.actionLog.findMany());
}));

async function upsert(productId, date, patch) {
  const existing = await prisma.actionLog.findUnique({ where: { product_id_date: { product_id: Number(productId), date } } });
  if (existing) return prisma.actionLog.update({ where: { id: existing.id }, data: patch });
  return prisma.actionLog.create({ data: { product_id: Number(productId), date, ...patch } });
}

router.post('/complete', asyncRoute(async (req, res) => {
  const { productId, date, taskType, priority, actionLabel, reasonText } = req.body;
  const record = await upsert(productId, date, {
    status: 'COMPLETED',
    task_type: taskType ?? null,
    priority: priority ?? null,
    action_label: actionLabel ?? null,
    reason_text: reasonText ?? null,
    completed_at: new Date(),
    not_completed_reason: null,
    not_completed_note: null,
  });
  res.json(record);
}));

router.post('/not-completed', asyncRoute(async (req, res) => {
  const { productId, date, taskType, priority, actionLabel, reasonText, reason, note } = req.body;
  const record = await upsert(productId, date, {
    status: 'NOT_COMPLETED',
    task_type: taskType ?? null,
    priority: priority ?? null,
    action_label: actionLabel ?? null,
    reason_text: reasonText ?? null,
    not_completed_reason: reason ?? null,
    not_completed_note: note ?? null,
    completed_at: null,
  });
  res.json(record);
}));

export default router;
