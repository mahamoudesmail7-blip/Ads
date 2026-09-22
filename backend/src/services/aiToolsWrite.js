// aiToolsWrite.js — the AI Media Buyer Operator's WRITE tool layer (Phase 2,
// Slice 1). Deliberately a SEPARATE file from aiTools.js: that file's own
// header comment says "read-only for Phase 1... Write tools are a later
// phase, deliberately not built yet" and every existing consumer relies on
// that being literally true. Every tool here is a thin wrapper around an
// EXISTING, unmodified function (prepareBumpForAdSet, the pause/resume
// finder, the Task Engine) — never new business logic beyond the one small
// pauseResumePrepare.js file. No tool here EVER calls a Meta write endpoint
// directly; PREPARE-tier tools only ever create an AssistantTask +
// AmbRecommendation pair the human must approve from the Task Card
// (services/routes/assistantTasks.js does the one real approve/execute call).
import { getAmbSettings } from './amb/settings.js';
import { previewBumpForAdSet, prepareBumpForAdSet } from './amb/scaleCenter.js';
import { checkEntityForPauseResume, findOrCreatePauseResumeRecommendation } from './assistantTasks/pauseResumePrepare.js';
import { createTask, transitionTask, patchTask, failTaskSafely, enterWaitingForApproval, findActiveTaskForEntity, listRecentTasksForUser, resolveTaskStatus } from './assistantTasks/taskEngine.js';
import { prisma } from '../prisma.js';

export const WRITE_TOOL_META = {
  prepare_bump: { tier: 'PREPARE', requiresApproval: true, writesToMeta: false },
  prepare_pause: { tier: 'PREPARE', requiresApproval: true, writesToMeta: false },
  prepare_resume: { tier: 'PREPARE', requiresApproval: true, writesToMeta: false },
  get_my_recent_tasks: { tier: 'READ', requiresApproval: false, writesToMeta: false },
};

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

export async function prepare_bump({ adSetId, pct, userId, conversationRef } = {}) {
  let taskUuid = null;
  try {
    if (!adSetId) return { ok: false, error: 'adSetId مطلوب.' };
    const settings = await getAmbSettings();
    const maxPct = n(settings.ambMaxBudgetIncreasePct) ?? 20;
    const requestedPct = n(pct) ?? n(settings.ambBumpPct) ?? 25;
    // Fixes a confirmed gap: previewBumpForAdSet/prepareBumpForAdSet only
    // validate pct>0, never an upper bound — clamp here, at PREPARE time,
    // rather than letting an unsafe value reach the rule engine's own
    // budget_change_bounds check for the first time only at approve.
    const clampedPct = Math.min(requestedPct, maxPct);

    const existing = await findActiveTaskForEntity(String(adSetId));
    if (existing) return { ok: true, task: (await resolveTaskStatus({ taskId: existing.task_uuid })).task, note: 'فيه تاسك شغال بالفعل على الـ Ad Set ده.' };

    const task = await createTask({ userId, kind: 'BUMP', toolName: 'prepare_bump', entityId: String(adSetId), entityType: 'adset', inputJson: { adSetId, pct: clampedPct }, conversationRef });
    taskUuid = task.task_uuid;
    await transitionTask({ taskId: taskUuid, to: 'PREPARING', patch: { progress: 20 } });

    const preview = await previewBumpForAdSet({ adSetId, pct: clampedPct });
    if (!preview.canEvaluateBump) {
      await transitionTask({ taskId: taskUuid, to: 'BLOCKED', patch: { blocked_reason: preview.cooldownReason || 'مش متاح دلوقتي.', entity_name: preview.adSetName || null } });
      return { ok: false, error: 'BLOCKED', message: preview.cooldownReason || 'مش متاح تجهيز زيادة دلوقتي لهذا الـ Ad Set.' };
    }

    const prepared = await prepareBumpForAdSet({ adSetId, pct: clampedPct });
    const rec = await prisma.ambRecommendation.findUnique({ where: { id: prepared.recommendationId } });
    await patchTask({ taskId: taskUuid, patch: { entity_name: preview.adSetName } });
    const finalTask = await enterWaitingForApproval({
      taskId: taskUuid, ambRecommendationId: rec.id, preparedPayload: preview, actionType: rec.action_type, recUpdatedAt: rec.updated_at,
    });
    return { ok: true, task: (await resolveTaskStatus({ taskId: finalTask.task_uuid })).task };
  } catch (err) {
    if (taskUuid) await failTaskSafely({ taskId: taskUuid, error: err });
    return { ok: false, error: err.message };
  }
}

async function preparePauseResume({ entityId, entityType, kind, userId, conversationRef }) {
  let taskUuid = null;
  try {
    if (!entityId) return { ok: false, error: 'entityId مطلوب.' };
    const existing = await findActiveTaskForEntity(String(entityId));
    if (existing) return { ok: true, task: (await resolveTaskStatus({ taskId: existing.task_uuid })).task, note: 'فيه تاسك شغال بالفعل على العنصر ده.' };

    const task = await createTask({ userId, kind, toolName: kind === 'PAUSE' ? 'prepare_pause' : 'prepare_resume', entityId: String(entityId), entityType: entityType || null, conversationRef, inputJson: { entityId, entityType } });
    taskUuid = task.task_uuid;
    await transitionTask({ taskId: taskUuid, to: 'PREPARING', patch: { progress: 20 } });

    const { connection, live } = await checkEntityForPauseResume({ entityId, kind });
    const rec = await findOrCreatePauseResumeRecommendation({ entityId: String(entityId), entityType, kind, live, adAccountId: connection.selected_ad_account_id });
    await patchTask({ taskId: taskUuid, patch: { entity_name: live.name || entityId } });

    const preview = { entityId, entityName: live.name || entityId, currentStatus: live.effectiveStatus || live.status, targetStatus: kind === 'PAUSE' ? 'PAUSED' : 'ACTIVE' };
    const finalTask = await enterWaitingForApproval({
      taskId: taskUuid, ambRecommendationId: rec.id, preparedPayload: preview, actionType: rec.action_type, recUpdatedAt: rec.updated_at,
    });
    return { ok: true, task: (await resolveTaskStatus({ taskId: finalTask.task_uuid })).task };
  } catch (err) {
    if (taskUuid) await failTaskSafely({ taskId: taskUuid, error: err });
    return { ok: false, error: err.message };
  }
}

export async function prepare_pause({ entityId, entityType, userId, conversationRef } = {}) {
  return preparePauseResume({ entityId, entityType, kind: 'PAUSE', userId, conversationRef });
}
export async function prepare_resume({ entityId, entityType, userId, conversationRef } = {}) {
  return preparePauseResume({ entityId, entityType, kind: 'RESUME', userId, conversationRef });
}

export async function get_my_recent_tasks({ userId } = {}) {
  try {
    if (!userId) return { ok: false, error: 'userId مطلوب.' };
    return await listRecentTasksForUser({ userId, limit: 5 });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export const WRITE_TOOL_DEFINITIONS = [
  {
    name: 'prepare_bump',
    description: '[تجهيز — لا يغيّر أي ميزانية فعليًا] يجهّز زيادة ميزانية حقيقية لـ Ad Set معيّن بنسبة معينة، وينشئ تاسك يظهر للمستخدم كارت موافقة. لازم Ad Set ID حقيقي (مش اسم منتج). النسبة بتتقص تلقائيًا لأقصى حد مسموح به في إعدادات النظام.',
    input_schema: {
      type: 'object',
      properties: {
        adSetId: { type: 'string', description: 'رقم Ad Set الحقيقي في Meta' },
        pct: { type: 'number', description: 'نسبة الزيادة المطلوبة، افتراضي حسب إعدادات النظام (عادة 25)' },
      },
      required: ['adSetId'],
    },
  },
  {
    name: 'prepare_pause',
    description: '[تجهيز — لا يوقف أي حاجة فعليًا] يجهّز إيقاف حملة/Ad Set/إعلان حقيقي (لازم يكون نشط ACTIVE دلوقتي)، وينشئ تاسك يظهر كارت موافقة.',
    input_schema: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'رقم الحملة/الـ Ad Set/الإعلان الحقيقي في Meta' },
        entityType: { type: 'string', description: 'campaign أو adset أو ad', enum: ['campaign', 'adset', 'ad'] },
      },
      required: ['entityId'],
    },
  },
  {
    name: 'prepare_resume',
    description: '[تجهيز — لا يستأنف أي حاجة فعليًا] يجهّز استئناف حملة/Ad Set/إعلان حقيقي متوقف (لازم يكون موقوف PAUSED دلوقتي)، وينشئ تاسك يظهر كارت موافقة.',
    input_schema: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'رقم الحملة/الـ Ad Set/الإعلان الحقيقي في Meta' },
        entityType: { type: 'string', description: 'campaign أو adset أو ad', enum: ['campaign', 'adset', 'ad'] },
      },
      required: ['entityId'],
    },
  },
  {
    name: 'get_my_recent_tasks',
    description: '[قراءة فقط] يجيب آخر 5 تاسكات حقيقية للمستخدم الحالي وحالتها الفعلية (PLANNED/PREPARING/WAITING_FOR_APPROVAL/RUNNING/VERIFYING/COMPLETED/PARTIALLY_COMPLETED/FAILED/CANCELLED/BLOCKED). استخدمه دايمًا قبل الرد على أي سؤال زي "بتعمل إيه دلوقتي؟" أو "خلصت؟" — ممنوع تجاوب من الذاكرة.',
    input_schema: { type: 'object', properties: {} },
  },
];

export const WRITE_TOOL_IMPLS = { prepare_bump, prepare_pause, prepare_resume, get_my_recent_tasks };
