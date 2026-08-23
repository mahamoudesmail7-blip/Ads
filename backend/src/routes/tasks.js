// Task Records + Activity Log. Field names deliberately match
// js/task-store.js's existing shape exactly (product_name, details, source,
// assignment_source, assigned_by, manager_note, related_campaign,
// today/yesterday/diff, cancelled_by/cancel_reason, not_completed_*,
// action_type/employee_to/employee_from/details_text) — that module is
// unchanged, so it must be able to keep calling TaskRecords.create/update
// and TaskActivityLog.log with the same field names it always has.
//
// Role rules (new): ADMIN/MANAGER can create/edit/reassign any task and
// cancel any task. An EMPLOYEE may only PATCH a task currently assigned to
// them, and only into COMPLETED/NOT_COMPLETED/CANCELLED — matching
// task-store.js's completeTask/failTask/cancelTaskByEmployee. Every mutation
// still goes through the generic PATCH — task-store.js itself decides which
// fields to send and separately calls POST /activity to log it, exactly as
// it already does against the old IndexedDB-backed db.js.
import { Router } from 'express';
import { prisma } from '../prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

const TERMINAL = new Set(['COMPLETED', 'CANCELLED']);
const EMPLOYEE_ALLOWED_STATUSES = new Set(['COMPLETED', 'NOT_COMPLETED', 'CANCELLED']);
// Fields task-store.js's employee-facing mutations (completeTask/failTask/cancelTaskByEmployee) actually send.
const EMPLOYEE_ALLOWED_FIELDS = new Set([
  'status', 'completed_at', 'not_completed_reason', 'not_completed_note', 'cancelled_at', 'cancelled_by', 'cancel_reason',
]);

router.get('/', asyncRoute(async (req, res) => {
  const { date, productId, id } = req.query;
  if (id) return res.json(await prisma.taskRecord.findUnique({ where: { id: Number(id) } }));
  if (productId && date) return res.json(await prisma.taskRecord.findMany({ where: { product_id: Number(productId), date } }));
  if (date) return res.json(await prisma.taskRecord.findMany({ where: { date } }));
  res.json(await prisma.taskRecord.findMany());
}));

router.get('/pending-before/:date', asyncRoute(async (req, res) => {
  const rows = await prisma.taskRecord.findMany({ where: { date: { lt: req.params.date }, NOT: { status: { in: [...TERMINAL] } } } });
  res.json(rows);
}));

router.post('/', requireRole('ADMIN', 'MANAGER'), asyncRoute(async (req, res) => {
  const b = req.body;
  const created = await prisma.taskRecord.create({
    data: {
      date: b.date,
      product_id: b.product_id ?? null,
      product_name: b.product_name ?? null,
      employee_id: b.employee_id ?? null,
      created_by_id: req.user.id,
      status: b.status || 'PENDING',
      task_type: b.task_type ?? null,
      priority: b.priority ?? null,
      title: b.title ?? null,
      details: b.details ?? null,
      manager_note: b.manager_note ?? null,
      related_campaign: b.related_campaign ?? null,
      source: b.source ?? null,
      assignment_source: b.assignment_source ?? null,
      assigned_by: b.assigned_by ?? null,
      assigned_at: b.assigned_at ? new Date(b.assigned_at) : null,
      today: b.today ?? null,
      yesterday: b.yesterday ?? null,
      diff: b.diff ?? null,
      due_date: b.due_date ?? null,
      execution_date: b.execution_date ?? null,
    },
  });
  res.status(201).json(created);
}));

// Generic edit — used by every task-store.js mutation (add/move/cancel/priority/note/complete/fail).
// Managers can send any field; an employee may only touch their own task and only the completion/cancel fields.
router.patch('/:id', asyncRoute(async (req, res) => {
  const existing = await prisma.taskRecord.findUnique({ where: { id: Number(req.params.id) } });
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  const isManager = req.user.role === 'ADMIN' || req.user.role === 'MANAGER';
  if (!isManager) {
    if (existing.employee_id !== req.user.id) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'ده مش تاسك بتاعك.' });
    }
    const fields = Object.keys(req.body);
    const disallowed = fields.filter((f) => !EMPLOYEE_ALLOWED_FIELDS.has(f));
    if (disallowed.length) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'مسموح بس تكمل/تلغي التاسك بتاعك.' });
    }
    if (req.body.status && !EMPLOYEE_ALLOWED_STATUSES.has(req.body.status)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'حالة غير مسموح بيها.' });
    }
    if (req.body.status === 'CANCELLED' && (!req.body.cancel_reason || !String(req.body.cancel_reason).trim())) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'لازم تكتب سبب الإلغاء.' });
    }
  }

  const data = { ...req.body };
  if (data.completed_at) data.completed_at = new Date(data.completed_at);
  if (data.cancelled_at) data.cancelled_at = new Date(data.cancelled_at);
  if (data.assigned_at) data.assigned_at = new Date(data.assigned_at);

  const updated = await prisma.taskRecord.update({ where: { id: existing.id }, data });
  res.json(updated);
}));

router.get('/activity', asyncRoute(async (req, res) => {
  const { date } = req.query;
  const rows = await prisma.taskActivityLog.findMany({ where: date ? { date } : undefined, orderBy: { created_at: 'desc' } });
  res.json(rows);
}));

router.post('/activity', asyncRoute(async (req, res) => {
  const b = req.body;
  const created = await prisma.taskActivityLog.create({
    data: {
      date: b.date,
      task_id: b.task_id ?? null,
      action_type: b.action_type ?? null,
      employee_to: b.employee_to ?? null,
      employee_from: b.employee_from ?? null,
      details_text: b.details_text ?? null,
      actor_id: req.user.id,
    },
  });
  res.status(201).json(created);
}));

export default router;
