// 🤖 AI Media Buyer Operator — Task Engine HTTP surface. Mounted at
// /api/assistant-tasks. Same auth tier as scaleCenter.js/aiMediaBuyer.js
// (ADMIN|MANAGER for reads; the actual approve/execute action is ADMIN-only,
// matching /recommendations/:id/approve). Every handler here is thin — all
// real logic lives in services/assistantTasks/taskEngine.js, which itself
// reuses services/amb/executor.js's approveAndExecute() unmodified. No route
// here ever calls a Meta write endpoint directly.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { resolveTaskStatus, approveTask, transitionTask } from '../services/assistantTasks/taskEngine.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));

router.get('/:taskUuid', asyncRoute(async (req, res) => {
  res.json(await resolveTaskStatus({ taskId: req.params.taskUuid }));
}));

router.post('/:taskUuid/approve', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const result = await approveTask({ taskId: req.params.taskUuid, userId: req.user.id, approvalHash: req.body?.approvalHash });
  const status = result.ok ? 200 : (result.error === 'STALE_APPROVAL' || result.error === 'CONFLICT' ? 409 : 400);
  res.status(status).json(result);
}));

router.post('/:taskUuid/cancel', asyncRoute(async (req, res) => {
  const task = await transitionTask({ taskId: req.params.taskUuid, to: 'CANCELLED' });
  res.json((await resolveTaskStatus({ taskId: task.task_uuid })));
}));

export default router;
