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
  // FAILED->RUNNING (Slice 17, Operator Recovery): resuming a LAUNCH/SCALE/
  // TEST_CAMPAIGN task whose launch_job_id already exists — retrying there
  // means nudging the SAME already-approved AmbLaunchJob's stuck campaigns
  // (retry_task in aiToolsWrite.js), never re-preparing a fresh plan, so the
  // task re-enters RUNNING (work resumes) rather than PREPARING (which would
  // imply a new plan needs a new approval it does not need).
  FAILED: ['PREPARING', 'RUNNING'],
  BLOCKED: ['PREPARING', 'CANCELLED'],
};

// A task is "active" (blocks a new task on the same entity, and is what
// resumability re-fetches on page load) in any non-terminal status.
const ACTIVE_STATUSES = ['PLANNED', 'PREPARING', 'WAITING_FOR_INPUT', 'WAITING_FOR_APPROVAL', 'RUNNING', 'VERIFYING'];

export function canTransitionTask(from, to) {
  return Array.isArray(TASK_TRANSITIONS[from]) && TASK_TRANSITIONS[from].includes(to);
}

function serializeTask(task, extra = {}) {
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
    launchJobId: task.launch_job_id,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    ...extra,
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

/**
 * A fresh multi-turn task (like LAUNCH_CAMPAIGN) has no stable external
 * entity_id until it creates one (a jobId) on its first successful step —
 * so "is this chat message continuing an existing in-flight request, or
 * starting a new one" can't be answered by findActiveTaskForEntity alone
 * for that first turn. Scoped by user+kind instead: the same user can only
 * ever have ONE in-flight task of a given multi-turn kind at a time, which
 * also naturally supports "edit after prepare" (خليها 2000 بدل 1500) by
 * letting the caller reuse/update the same row rather than spawning a
 * second one.
 */
export async function findActiveTaskForUserKind({ userId, kind }) {
  if (!userId || !kind) return null;
  return prisma.assistantTask.findFirst({
    where: { user_id: userId, kind, status: { in: ACTIVE_STATUSES } },
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

/**
 * Plain read of real persisted state — the literal implementation of "what
 * are you doing right now." Never invents progress. For a LAUNCH_CAMPAIGN
 * task mid-publish, this is ALSO where verify-after-write lives: there's no
 * single Meta object to re-read the way Bump/Pause do, so instead this
 * calls the real, unmodified getQueueProgress() (launchPublish.js) — never
 * cached — and reconciles the task's own status to it before returning,
 * converging to a real terminal state the next time anyone polls or
 * reopens the chat, with no separate scheduler needed.
 */
export async function resolveTaskStatus({ taskId }) {
  let task = await prisma.assistantTask.findUnique({ where: { task_uuid: taskId }, include: { user: { select: { name: true } }, approved_by: { select: { name: true } } } });
  if (!task) { const e = new Error('التاسك مش موجود.'); e.status = 404; throw e; }

  let launchProgress = null;
  if (['LAUNCH_CAMPAIGN', 'SCALE_CAMPAIGN', 'TEST_CAMPAIGN'].includes(task.kind) && task.launch_job_id && ['RUNNING', 'VERIFYING'].includes(task.status)) {
    const { getQueueProgress } = await import('../amb/launchPublish.js');
    const progress = await getQueueProgress(task.launch_job_id).catch(() => null);
    if (progress) {
      launchProgress = progress;
      if (progress.jobStatus === 'COMPLETE') {
        task = await transitionTask({ taskId, to: 'COMPLETED', patch: { progress: 100 } });
      } else if (progress.jobStatus === 'PARTIAL') {
        task = await transitionTask({ taskId, to: 'PARTIALLY_COMPLETED', patch: { progress: 100, error: 'بعض الكامبينات نجحت وبعضها فشل — راجع التفاصيل.' } });
      } else if (progress.jobStatus === 'FAILED') {
        task = await transitionTask({ taskId, to: 'FAILED', patch: { error: progress.jobError || 'فشل النشر.' } });
      } else {
        const total = progress.campaigns.length || 1;
        const done = progress.campaigns.filter((c) => c.phase === 'COMPLETE').length;
        task = await patchTask({ taskId, patch: { progress: Math.min(99, Math.round((done / total) * 100)) } });
      }
    }
  }

  const timeline = await buildTaskTimeline(task).catch(() => []);
  return { ok: true, task: serializeTask(task, { launchProgress, timeline, createdByName: task.user?.name || null, approvedByName: task.approved_by?.name || null }) };
}

export async function listRecentTasksForUser({ userId, limit = 5 }) {
  const tasks = await prisma.assistantTask.findMany({
    where: { user_id: userId },
    orderBy: { updated_at: 'desc' },
    take: limit,
  });
  return { ok: true, tasks: tasks.map(serializeTask) };
}

// Slice 16 — Task History UI. Five real, mutually-exclusive views over the
// SAME status vocabulary the FSM already uses (never a new status). "active"
// deliberately excludes WAITING_FOR_APPROVAL — the spec treats "still being
// worked on" and "sitting on YOUR approval" as two separate views a human
// checks for different reasons.
export const TASK_VIEW_STATUSES = {
  active: ['PLANNED', 'PREPARING', 'WAITING_FOR_INPUT', 'RUNNING', 'VERIFYING'],
  waiting_approval: ['WAITING_FOR_APPROVAL'],
  completed: ['COMPLETED', 'PARTIALLY_COMPLETED'],
  failed: ['FAILED', 'BLOCKED'],
  cancelled: ['CANCELLED'],
};

export async function listTasksByView({ view, limit = 50 } = {}) {
  const statuses = TASK_VIEW_STATUSES[view];
  if (!statuses) { const e = new Error(`Unknown task view: ${view}`); e.status = 400; throw e; }
  const tasks = await prisma.assistantTask.findMany({
    where: { status: { in: statuses } },
    orderBy: { updated_at: 'desc' },
    take: Math.min(limit, 200),
    include: { user: { select: { name: true } }, approved_by: { select: { name: true } } },
  });
  const counts = await prisma.assistantTask.groupBy({ by: ['status'], _count: true });
  const countByView = {};
  for (const [v, sts] of Object.entries(TASK_VIEW_STATUSES)) {
    countByView[v] = counts.filter((c) => sts.includes(c.status)).reduce((a, c) => a + c._count, 0);
  }
  return {
    ok: true,
    view,
    counts: countByView,
    tasks: tasks.map((t) => ({ ...serializeTask(t), createdByName: t.user?.name || null, approvedByName: t.approved_by?.name || null })),
  };
}

/**
 * A real, never-fabricated timeline built ONLY from timestamps the row
 * itself already carries (created_at/approved_at/updated_at) plus, for
 * LAUNCH/SCALE/TEST_CAMPAIGN tasks with a real launch_job_id, the genuine
 * AmbLaunchAudit event trail already written by launchPublish.js — never a
 * second, invented per-transition log.
 */
export async function buildTaskTimeline(task) {
  const points = [{ at: task.created_at, label: 'تم إنشاء التاسك', kind: 'CREATED' }];
  if (task.approved_at) points.push({ at: task.approved_at, label: `تمت الموافقة${task.approved_by?.name ? ' — ' + task.approved_by.name : ''}`, kind: 'APPROVED' });
  if (task.launch_job_id) {
    const audits = await prisma.ambLaunchAudit.findMany({
      where: { job_id: task.launch_job_id },
      orderBy: { created_at: 'asc' },
      select: { event: true, detail: true, created_at: true, level: true, destination_id: true },
    }).catch(() => []);
    for (const a of audits) points.push({ at: a.created_at, label: a.detail || a.event, kind: a.event });
  }
  if (task.blocked_reason) points.push({ at: task.updated_at, label: `محظور: ${task.blocked_reason}`, kind: 'BLOCKED' });
  if (task.error) points.push({ at: task.updated_at, label: `خطأ: ${task.error}`, kind: 'ERROR' });
  if (['COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED'].includes(task.status)) points.push({ at: task.updated_at, label: task.status === 'CANCELLED' ? 'تم الإلغاء' : 'اكتمل التنفيذ', kind: task.status });
  return points.sort((a, b) => new Date(a.at) - new Date(b.at));
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
  const task = await prisma.assistantTask.findUnique({ where: { task_uuid: taskId } });
  if (!task) { const e = new Error('التاسك مش موجود.'); e.status = 404; throw e; }

  if (task.status !== 'WAITING_FOR_APPROVAL') {
    // Idempotent double-click: return the current state rather than erroring.
    return { ok: task.status === 'COMPLETED', task: serializeTask(task) };
  }

  if (['LAUNCH_CAMPAIGN', 'SCALE_CAMPAIGN', 'TEST_CAMPAIGN'].includes(task.kind)) return approveLaunchCampaignTask({ task, userId, approvalHash });
  if (task.kind === 'PRICE_TEST') return approvePriceTestTask({ task, userId, approvalHash });
  if (task.kind === 'SCALE_WINNER') return approveScaleWinnerTask({ task, userId, approvalHash });

  const { approveAndExecute } = await import('../amb/executor.js');

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

/**
 * LAUNCH_CAMPAIGN/SCALE_CAMPAIGN's shared approve path — no AmbRecommendation
 * exists for either kind, so the hash is self-contained over the prepared
 * snapshot (recUpdatedAt null) rather than bound to a live row's updated_at
 * (media uploads write to AmbLaunchVideoAsset/AmbLaunchImageAsset, never
 * AmbLaunchJob itself, so there'd be nothing to bind to even if we wanted
 * to). startLaunchQueue() returns almost immediately — it hands off to the
 * existing durable scheduler, which is why this lands in VERIFYING rather
 * than a terminal state; resolveTaskStatus() converges it from there. Both
 * kinds share this exact function since both ultimately hand a fully-built
 * AmbLaunchJob to the same publish queue — the only difference is how the
 * job's fields were populated (a hand-described campaign vs. a proven
 * Winning Stack), which is entirely decided at prepare time.
 */
async function approveLaunchCampaignTask({ task, userId, approvalHash }) {
  const expectedHash = computeApprovalHash({
    taskUuid: task.task_uuid, toolName: task.tool_name, entityId: task.entity_id, actionType: task.kind,
    preparedPayload: task.prepared_payload_json ? JSON.parse(task.prepared_payload_json) : null,
    recUpdatedAt: null,
  });
  if (!approvalHash || approvalHash !== expectedHash) {
    await transitionTask({ taskId: task.task_uuid, to: 'PREPARING', patch: { error: 'الخطة اتغيرت بعد التجهيز — جهّزها تاني.' } });
    return { ok: false, error: 'STALE_APPROVAL', message: 'الخطة اتغيرت بعد التجهيز — محتاجة موافقة جديدة.' };
  }

  const conflicting = await findActiveTaskForEntity(task.entity_id);
  if (conflicting && conflicting.task_uuid !== task.task_uuid) {
    await transitionTask({ taskId: task.task_uuid, to: 'BLOCKED', patch: { blocked_reason: 'فيه تاسك تاني شغال بالفعل على نفس طلب الإطلاق.' } });
    return { ok: false, error: 'CONFLICT', message: 'فيه إجراء تاني شغال على نفس الكامبين دلوقتي.' };
  }

  await transitionTask({ taskId: task.task_uuid, to: 'RUNNING', patch: { approved_at: new Date(), approved_by_id: userId || null, progress: 75 } });

  const { startLaunchQueue } = await import('../amb/launchPublish.js');
  try {
    await startLaunchQueue({ jobId: task.launch_job_id, userId });
  } catch (err) {
    await transitionTask({ taskId: task.task_uuid, to: 'FAILED', patch: { error: err.message || String(err) } });
    return { ok: false, error: 'EXECUTION_FAILED', message: err.message || 'فشل بدء النشر.' };
  }

  const verifyingTask = await transitionTask({ taskId: task.task_uuid, to: 'VERIFYING', patch: { progress: 80 } });
  return { ok: true, task: serializeTask(verifyingTask) };
}

/**
 * PRICE_TEST's approve path — deliberately NOT the Launch-family's Meta
 * queue: the consequential action here is a single, synchronous LOCAL
 * database write (Product.selling_price), never Meta, never Easy Orders.
 * Still hash-bound, still conflict-checked, still verified by re-reading
 * the row after the write — "never trust a write as proof" applies to a
 * local DB write exactly as much as a Meta call, even though it can't fail
 * the way a network call can.
 */
async function approvePriceTestTask({ task, userId, approvalHash }) {
  const preview = task.prepared_payload_json ? JSON.parse(task.prepared_payload_json) : null;
  const expectedHash = computeApprovalHash({
    taskUuid: task.task_uuid, toolName: task.tool_name, entityId: task.entity_id, actionType: task.kind,
    preparedPayload: preview, recUpdatedAt: null,
  });
  if (!approvalHash || approvalHash !== expectedHash) {
    await transitionTask({ taskId: task.task_uuid, to: 'PREPARING', patch: { error: 'الخطة اتغيرت بعد التجهيز — جهّزها تاني.' } });
    return { ok: false, error: 'STALE_APPROVAL', message: 'الخطة اتغيرت بعد التجهيز — محتاجة موافقة جديدة.' };
  }

  const conflicting = await findActiveTaskForEntity(task.entity_id);
  if (conflicting && conflicting.task_uuid !== task.task_uuid) {
    await transitionTask({ taskId: task.task_uuid, to: 'BLOCKED', patch: { blocked_reason: 'فيه تاسك تاني شغال بالفعل على نفس المنتج.' } });
    return { ok: false, error: 'CONFLICT', message: 'فيه إجراء تاني شغال على نفس المنتج دلوقتي.' };
  }

  await transitionTask({ taskId: task.task_uuid, to: 'RUNNING', patch: { approved_at: new Date(), approved_by_id: userId || null, progress: 75 } });

  const productId = Number(task.entity_id);
  let updated;
  try {
    updated = await prisma.product.update({ where: { id: productId }, data: { selling_price: preview.newPrice } });
  } catch (err) {
    await transitionTask({ taskId: task.task_uuid, to: 'FAILED', patch: { error: err.message || String(err) } });
    return { ok: false, error: 'EXECUTION_FAILED', message: err.message || 'فشل تحديث السعر.' };
  }

  await transitionTask({ taskId: task.task_uuid, to: 'VERIFYING', patch: { progress: 90 } });

  // Verify-after-write — re-read the row rather than trusting the update() call's own return value.
  const reread = await prisma.product.findUnique({ where: { id: productId }, select: { selling_price: true } });
  const verified = reread?.selling_price === preview.newPrice;
  const finalTask = await transitionTask({
    taskId: task.task_uuid, to: verified ? 'COMPLETED' : 'PARTIALLY_COMPLETED',
    patch: { progress: 100, error: verified ? null : 'السعر اتحدّث لكن القراءة الفورية بعده مش مطابقة — راجعه يدويًا.' },
  });
  return { ok: true, task: serializeTask(finalTask), oldValue: preview.currentPrice, newValue: updated.selling_price };
}

/**
 * "اعمل اسكيل" via the real Winner→Scale system (services/amb/scaleWinners.js
 * — the SAME engine + eligibility (orders>=1, CPA<=WINNER_CPA_EGP) the
 * dashboard's own "🚀 جاهزة للاسكيل" cards use, never a second criterion).
 * executeScale() itself already creates the new campaign via the existing
 * clone engine AND blocks until waitAndVerifyScale() proves the whole tree
 * exists (up to 2 minutes) — the same synchronous-wait precedent the
 * dashboard's own "Approve Scale" button already relies on, so this task
 * simply awaits the SAME call rather than inventing a second execution path.
 */
async function approveScaleWinnerTask({ task, userId, approvalHash }) {
  const preview = task.prepared_payload_json ? JSON.parse(task.prepared_payload_json) : null;
  const expectedHash = computeApprovalHash({
    taskUuid: task.task_uuid, toolName: task.tool_name, entityId: task.entity_id, actionType: task.kind,
    preparedPayload: preview, recUpdatedAt: null,
  });
  if (!approvalHash || approvalHash !== expectedHash) {
    await transitionTask({ taskId: task.task_uuid, to: 'PREPARING', patch: { error: 'الخطة اتغيرت بعد التجهيز — جهّزها تاني.' } });
    return { ok: false, error: 'STALE_APPROVAL', message: 'الخطة اتغيرت بعد التجهيز — محتاجة موافقة جديدة.' };
  }

  const conflicting = await findActiveTaskForEntity(task.entity_id);
  if (conflicting && conflicting.task_uuid !== task.task_uuid) {
    await transitionTask({ taskId: task.task_uuid, to: 'BLOCKED', patch: { blocked_reason: 'فيه تاسك تاني شغال بالفعل على نفس الحملة.' } });
    return { ok: false, error: 'CONFLICT', message: 'فيه إجراء تاني شغال على نفس الحملة دلوقتي.' };
  }

  await transitionTask({ taskId: task.task_uuid, to: 'RUNNING', patch: { approved_at: new Date(), approved_by_id: userId || null, progress: 50 } });

  const { executeScale } = await import('../amb/scaleWinners.js');
  let result;
  try {
    result = await executeScale({
      sourceCampaignId: task.entity_id,
      budgetMode: preview.budgetMode,
      campaignBudgetEgp: preview.campaignBudgetEgp,
      selectedAdIds: preview.selectedAdIds,
      adSets: preview.adSets,
      startMode: preview.startMode,
      startAt: preview.startAt,
      windowName: preview.windowName || 'today',
      userId,
    });
  } catch (err) {
    // executeScale() itself already marks the AmbScaleDecision row FAILED
    // with the real reason (including a partial-tree proof failure) —
    // never a second, invented error here.
    await transitionTask({ taskId: task.task_uuid, to: 'FAILED', patch: { error: err.message || String(err) } });
    return { ok: false, error: 'EXECUTION_FAILED', message: err.message || 'فشل تنفيذ الاسكيل.' };
  }

  // executeScale() only ever returns after waitAndVerifyScale() has proven
  // the destination campaign + every required ad set/ad genuinely exists —
  // trusting that real proof here rather than re-verifying a third time.
  const finalTask = await transitionTask({ taskId: task.task_uuid, to: 'COMPLETED', patch: { progress: 100 } });
  return { ok: true, task: serializeTask(finalTask), newValue: result };
}

export { serializeTask, ACTIVE_STATUSES };
