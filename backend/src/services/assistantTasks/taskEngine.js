// AI Media Buyer Operator — Task Engine (Phase 2, Slice 1). Tracks WHICH
// chat-originated write request is in flight and what state it's in. Never
// a second business system: every real number/decision still lives on
// AmbRecommendation/AmbAction (services/amb/executor.js, scaleCenter.js) —
// this file only manages the task's own lifecycle (prepare → approve →
// execute → verify), conflict detection, and approval-binding.
import crypto from 'crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';

// Whitelisted transitions — same pattern as launchBuilder.js's JOB_TRANSITIONS.
// FAILED/BLOCKED can both re-enter PREPARING for a safe retry (mirrors
// executor.js's own "reset a failed execution back to PENDING" convention).
const TASK_TRANSITIONS = {
  PLANNED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['WAITING_FOR_INPUT', 'WAITING_FOR_APPROVAL', 'BLOCKED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_INPUT: ['PREPARING', 'CANCELLED'],
  WAITING_FOR_APPROVAL: ['RUNNING', 'PREPARING', 'CANCELLED', 'BLOCKED'],
  RUNNING: ['VERIFYING', 'FAILED'],
  VERIFYING: ['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED'],
  COMPLETED: [],
  PARTIALLY_COMPLETED: [],
  CANCELLED: [],
  FAILED: ['PREPARING'],
  BLOCKED: ['PREPARING', 'CANCELLED'],
};

// A task is "active" (blocks a new task on the same entity, and is what
// resumability re-fetches on page load) in any non-terminal status.
const ACTIVE_STATUSES = ['PLANNED', 'PREPARING', 'WAITING_FOR_INPUT', 'WAITING_FOR_APPROVAL', 'RUNNING', 'VERIFYING'];

export function canTransitionTask(from, to) {
  return Array.isArray(TASK_TRANSITIONS[from]) && TASK_TRANSITIONS[from].includes(to);
}

function serializeTask(task) {
  if (!task) return null;
  return {
    taskUuid: task.task_uuid,
    kind: task.kind,
    toolName: task.tool_name,
    entityId: task.entity_id,
    entityType: task.entity_type,
    entityName: task.entity_name,
    status: task.status,
    progress: task.progress,
    error: task.error,
    blockedReason: task.blocked_reason,
    preparedPayload: task.prepared_payload_json ? JSON.parse(task.prepared_payload_json) : null,
    approvalHash: task.approval_hash,
    ambRecommendationId: task.amb_recommendation_id,
    ambActionId: task.amb_action_id,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

/** Any task still in flight for this Meta entity — the whole conflict-detection mechanism (one active task per entity_id). */
export async function findActiveTaskForEntity(entityId) {
  if (!entityId) return null;
  return prisma.assistantTask.findFirst({
    where: { entity_id: entityId, status: { in: ACTIVE_STATUSES } },
    orderBy: { created_at: 'desc' },
  });
}

export async function createTask({ userId, kind, toolName, entityId, entityType, entityName, inputJson, conversationRef }) {
  const task = await prisma.assistantTask.create({
    data: {
      user_id: userId,
      kind,
      tool_name: toolName,
      entity_id: entityId || null,
      entity_type: entityType || null,
      entity_name: entityName || null,
      input_json: inputJson ? JSON.stringify(inputJson) : null,
      conversation_ref: conversationRef || null,
      status: 'PLANNED',
      heartbeat_at: new Date(),
    },
  });
  return task;
}

export async function transitionTask({ taskId, to, patch = {} }) {
  const task = await prisma.assistantTask.findUnique({ where: { task_uuid: taskId } });
  if (!task) { const e = new Error('التاسك مش موجود.'); e.status = 404; throw e; }
  if (!canTransitionTask(task.status, to)) {
    const e = new Error(`مينفعش تنقل التاسك من ${task.status} لـ ${to}.`);
    e.status = 409;
    throw e;
  }
  return prisma.assistantTask.update({
    where: { task_uuid: taskId },
    data: { status: to, heartbeat_at: new Date(), ...patch },
  });
}

/** Updates fields WITHOUT a status change (e.g. filling in entity_name once it's resolved) — transitionTask is only for real FSM moves, this is for same-state metadata updates. */
export async function patchTask({ taskId, patch = {} }) {
  return prisma.assistantTask.update({
    where: { task_uuid: taskId },
    data: { heartbeat_at: new Date(), ...patch },
  });
}

/** Best-effort: mark a task FAILED from an unexpected mid-flight error, so it never sits dangling in a non-terminal state when the caller's own try/catch swallows the error. Never throws itself. */
export async function failTaskSafely({ taskId, error }) {
  try {
    const task = await prisma.assistantTask.findUnique({ where: { task_uuid: taskId } });
    if (!task || !canTransitionTask(task.status, 'FAILED')) return;
    await transitionTask({ taskId, to: 'FAILED', patch: { error: String(error?.message || error || 'حصل خطأ غير متوقع.').slice(0, 500) } });
  } catch (err) {
    logger.error('failTaskSafely itself failed', { taskId, message: err.message });
  }
}

/** sha256 binding the exact prepared plan to the recommendation's freshness marker — see enterWaitingForApproval/approveTask. */
export function computeApprovalHash({ taskUuid, toolName, entityId, actionType, preparedPayload, recUpdatedAt }) {
  const payload = JSON.stringify({
    taskUuid, toolName, entityId: entityId || null, actionType: actionType || null,
    preparedPayload: preparedPayload || null,
    recUpdatedAt: recUpdatedAt ? new Date(recUpdatedAt).toISOString() : null,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/** Enters WAITING_FOR_APPROVAL with the exact plan the human will see, hash-bound to the recommendation's current updated_at. */
export async function enterWaitingForApproval({ taskId, ambRecommendationId, preparedPayload, actionType, recUpdatedAt }) {
  const task = await prisma.assistantTask.findUnique({ where: { task_uuid: taskId } });
  if (!task) { const e = new Error('التاسك مش موجود.'); e.status = 404; throw e; }
  const approvalHash = computeApprovalHash({
    taskUuid: task.task_uuid, toolName: task.tool_name, entityId: task.entity_id, actionType, preparedPayload, recUpdatedAt,
  });
  return transitionTask({
    taskId,
    to: 'WAITING_FOR_APPROVAL',
    patch: {
      amb_recommendation_id: ambRecommendationId,
      prepared_payload_json: JSON.stringify(preparedPayload),
      approval_hash: approvalHash,
      progress: 60,
    },
  });
}

/** Plain read of real persisted state — the literal implementation of "what are you doing right now." Never invents progress. */
export async function resolveTaskStatus({ taskId }) {
  const task = await prisma.assistantTask.findUnique({ where: { task_uuid: taskId } });
  if (!task) { const e = new Error('التاسك مش موجود.'); e.status = 404; throw e; }
  return { ok: true, task: serializeTask(task) };
}

export async function listRecentTasksForUser({ userId, limit = 5 }) {
  const tasks = await prisma.assistantTask.findMany({
    where: { user_id: userId },
    orderBy: { updated_at: 'desc' },
    take: limit,
  });
  return { ok: true, tasks: tasks.map(serializeTask) };
}

/**
 * Approve → execute → verify. Recomputes the approval hash from the
 * recommendation's CURRENT updated_at before doing anything else — any edit
 * since prepare (a re-prepare, a manual Scale Center edit) changes
 * updated_at, so the hash won't match and nothing reaches Meta. This is
 * independent from executor.js's own live-Meta materiality/rule-engine
 * revalidation: this checks "did the plan the human saw change", executor.js
 * checks "did the real world change" — both stay, neither duplicates the other.
 */
export async function approveTask({ taskId, userId, approvalHash }) {
  const { approveAndExecute } = await import('../amb/executor.js');

  const task = await prisma.assistantTask.findUnique({ where: { task_uuid: taskId } });
  if (!task) { const e = new Error('التاسك مش موجود.'); e.status = 404; throw e; }

  if (task.status !== 'WAITING_FOR_APPROVAL') {
    // Idempotent double-click: return the current state rather than erroring.
    return { ok: task.status === 'COMPLETED', task: serializeTask(task) };
  }

  const rec = task.amb_recommendation_id
    ? await prisma.ambRecommendation.findUnique({ where: { id: task.amb_recommendation_id } })
    : null;
  if (!rec) { const e = new Error('التوصية المرتبطة بالتاسك مش موجودة.'); e.status = 404; throw e; }

  const expectedHash = computeApprovalHash({
    taskUuid: task.task_uuid, toolName: task.tool_name, entityId: task.entity_id, actionType: rec.action_type,
    preparedPayload: task.prepared_payload_json ? JSON.parse(task.prepared_payload_json) : null,
    recUpdatedAt: rec.updated_at,
  });
  if (!approvalHash || approvalHash !== expectedHash) {
    await transitionTask({ taskId, to: 'PREPARING', patch: { error: 'الخطة اتغيرت بعد التجهيز — جهّزها تاني.' } });
    return { ok: false, error: 'STALE_APPROVAL', message: 'الخطة اتغيرت بعد التجهيز — محتاجة موافقة جديدة.' };
  }

  const conflicting = await findActiveTaskForEntity(task.entity_id);
  if (conflicting && conflicting.task_uuid !== task.task_uuid) {
    await transitionTask({ taskId, to: 'BLOCKED', patch: { blocked_reason: 'فيه تاسك تاني شغال بالفعل على نفس الـ Ad Set/الحملة.' } });
    return { ok: false, error: 'CONFLICT', message: 'فيه إجراء تاني شغال على نفس الهدف دلوقتي.' };
  }

  await transitionTask({ taskId, to: 'RUNNING', patch: { approved_at: new Date(), approved_by_id: userId || null, progress: 75 } });

  let result;
  try {
    result = await approveAndExecute({ recId: rec.id, userId, mode: 'APPROVAL' });
  } catch (err) {
    await transitionTask({ taskId, to: 'FAILED', patch: { error: err.message || String(err) } });
    return { ok: false, error: 'EXECUTION_FAILED', message: err.message || 'فشل التنفيذ.' };
  }

  if (!result.ok) {
    // executor.js's own "aborted, needs re-analysis" path — real, not a crash.
    await transitionTask({ taskId, to: 'FAILED', patch: { error: result.message || 'اتوقف التنفيذ — محتاج إعادة تحليل.' } });
    return { ok: false, error: 'ABORTED', message: result.message, staleContext: result.staleContext };
  }

  await transitionTask({ taskId, to: 'VERIFYING', patch: { progress: 90, amb_action_id: result.actionId } });

  const action = await prisma.ambAction.findUnique({ where: { id: result.actionId } });
  const verify = action?.verify_json ? JSON.parse(action.verify_json) : null;
  const finalStatus = verify?.verified === false ? 'PARTIALLY_COMPLETED' : 'COMPLETED';
  const finalTask = await transitionTask({
    taskId,
    to: finalStatus,
    patch: {
      progress: 100,
      error: finalStatus === 'PARTIALLY_COMPLETED'
        ? 'Meta قبلت الطلب لكن القراءة الفورية بعده لسه بتُظهر القيمة القديمة — راجع الحالة يدويًا بعد شوية.'
        : null,
    },
  });

  logger.info('AssistantTask executed', { taskUuid: task.task_uuid, actionId: result.actionId, finalStatus });
  return { ok: true, task: serializeTask(finalTask), oldValue: result.oldValue, newValue: result.newValue };
}

export { serializeTask, ACTIVE_STATUSES };
