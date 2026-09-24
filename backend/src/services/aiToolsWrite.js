// aiToolsWrite.js — the AI Media Buyer Operator's WRITE tool layer (Phase 2
// — Slice 1: prepare_bump/prepare_pause/prepare_resume; Slice 2:
// prepare_campaign/generate_campaign_copy). Deliberately a SEPARATE file
// from aiTools.js: that file's own header comment says "read-only for
// Phase 1... Write tools are a later phase, deliberately not built yet" and
// every existing consumer relies on that being literally true. Every tool
// here is a thin wrapper around an EXISTING, unmodified function
// (prepareBumpForAdSet, the pause/resume finder, createDraftJob, the Task
// Engine) — never new business logic beyond the small
// pauseResumePrepare.js/launchCampaignPrepare.js files. No tool here EVER
// calls a Meta write endpoint directly; PREPARE-tier tools only ever create
// an AssistantTask (+ AmbRecommendation for Slice 1 kinds, or an
// AmbLaunchJob for LAUNCH_CAMPAIGN) the human must approve from the Task
// Card (routes/assistantTasks.js does the one real approve/execute call).
import crypto from 'crypto';
import { getAmbSettings } from './amb/settings.js';
import { previewBumpForAdSet, prepareBumpForAdSet } from './amb/scaleCenter.js';
import { cumulativeBumpPctLast24h } from './amb/budgetBumpOrchestrator.js';
import { evaluateBudgetCap, evaluateDailyCumulativeCap, evaluateMoneyGuardForScale } from './amb/moneyGuard.js';
import { getProductProfitBrain } from './amb/profitBrain.js';
import { stockGuardForProduct } from './amb/stockGuard.js';
import { resolveWindow } from './amb/metricsEngine.js';
import { resolveOperationalWindowName } from './amb/productDossier.js';
import { checkEntityForPauseResume, findOrCreatePauseResumeRecommendation } from './assistantTasks/pauseResumePrepare.js';
import { resolveMultiGeoTargeting, requireAdAccount, autoResolveAccountAssets, resolveProduct, createDraftJob, getJob } from './assistantTasks/launchCampaignPrepare.js';
import { loadWinningStackForProduct, resolveWinningCreativeAsset } from './assistantTasks/scalePrepare.js';
import { loadTestContext, parseAudienceTestValue } from './assistantTasks/testPrepare.js';
import { capturePriceTestBaseline } from './assistantTasks/pricePrepare.js';
import { createTest as createPmcTest } from './amb/productMarketingTests.js';
import { resolveProductByIdOrName } from './amb/productNameMatch.js';
import { registerVideoSlot, markVideoResult, registerImageSlot, markImageResult } from './amb/launchBuilder.js';
import { createTask, transitionTask, patchTask, failTaskSafely, enterWaitingForApproval, findActiveTaskForEntity, findActiveTaskForUserKind, listRecentTasksForUser, resolveTaskStatus, canTransitionTask } from './assistantTasks/taskEngine.js';
import { prisma } from '../prisma.js';

export const WRITE_TOOL_META = {
  prepare_bump: { tier: 'PREPARE', requiresApproval: true, writesToMeta: false },
  prepare_pause: { tier: 'PREPARE', requiresApproval: true, writesToMeta: false },
  prepare_resume: { tier: 'PREPARE', requiresApproval: true, writesToMeta: false },
  prepare_campaign: { tier: 'PREPARE', requiresApproval: true, writesToMeta: false },
  prepare_scale: { tier: 'PREPARE', requiresApproval: true, writesToMeta: false },
  prepare_test: { tier: 'PREPARE', requiresApproval: true, writesToMeta: false },
  prepare_price_test: { tier: 'PREPARE', requiresApproval: true, writesToMeta: false },
  generate_campaign_copy: { tier: 'READ', requiresApproval: false, writesToMeta: false },
  get_my_recent_tasks: { tier: 'READ', requiresApproval: false, writesToMeta: false },
  get_task_progress: { tier: 'READ', requiresApproval: false, writesToMeta: false },
  // retry_task never writes to Meta directly — it either nudges an ALREADY-
  // approved launch job's scheduler (no new approval needed, same plan) or
  // re-runs prepare_* (which itself requires a fresh approval before any write).
  retry_task: { tier: 'EXECUTE', requiresApproval: false, writesToMeta: false },
  cancel_task: { tier: 'EXECUTE', requiresApproval: false, writesToMeta: false },
};

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

export async function prepare_bump({ adSetId, pct, userId, conversationRef } = {}) {
  let taskUuid = null;
  try {
    if (!adSetId) return { ok: false, error: 'adSetId مطلوب.' };
    const settings = await getAmbSettings();
    const maxPct = n(settings.ambMaxBudgetIncreasePct) ?? 20;
    const requestedPct = n(pct) ?? n(settings.ambBumpPct) ?? 25;

    const existing = await findActiveTaskForEntity(String(adSetId));
    if (existing) return { ok: true, task: (await resolveTaskStatus({ taskId: existing.task_uuid })).task, note: 'فيه تاسك شغال بالفعل على الـ Ad Set ده.' };

    const task = await createTask({ userId, kind: 'BUMP', toolName: 'prepare_bump', entityId: String(adSetId), entityType: 'adset', inputJson: { adSetId, pct: requestedPct }, conversationRef });
    taskUuid = task.task_uuid;
    await transitionTask({ taskId: taskUuid, to: 'PREPARING', patch: { progress: 20 } });

    // Money Guard — never silently clamps a requested % down to the allowed
    // ceiling anymore; a request over the single-action cap is refused
    // outright with the exact conflict (both numbers) shown to the human.
    const capGuard = evaluateBudgetCap({ requestedPct, maxSingleActionPct: maxPct });
    if (capGuard.decision === 'BLOCKED') {
      await transitionTask({ taskId: taskUuid, to: 'BLOCKED', patch: { blocked_reason: capGuard.reason } });
      return { ok: false, error: 'BLOCKED', message: capGuard.reason };
    }

    const preview = await previewBumpForAdSet({ adSetId, pct: requestedPct });
    if (!preview.canEvaluateBump) {
      await transitionTask({ taskId: taskUuid, to: 'BLOCKED', patch: { blocked_reason: preview.cooldownReason || 'مش متاح دلوقتي.', entity_name: preview.adSetName || null } });
      return { ok: false, error: 'BLOCKED', message: preview.cooldownReason || 'مش متاح تجهيز زيادة دلوقتي لهذا الـ Ad Set.' };
    }

    // Money Guard — cumulative 24h cap across every bump on this SAME ad
    // set (scheduler-originated and chat-prepared bumps both count).
    const cumulativePct = await cumulativeBumpPctLast24h(preview.adAccountId, String(adSetId));
    const dailyGuard = evaluateDailyCumulativeCap({ cumulativePctLast24h: cumulativePct, requestedPct, maxDailyPct: n(settings.ambMaxDailyBudgetIncreasePct) ?? 50 });
    if (dailyGuard.decision === 'BLOCKED') {
      await transitionTask({ taskId: taskUuid, to: 'BLOCKED', patch: { blocked_reason: dailyGuard.reason, entity_name: preview.adSetName || null } });
      return { ok: false, error: 'BLOCKED', message: dailyGuard.reason };
    }

    const prepared = await prepareBumpForAdSet({ adSetId, pct: requestedPct });
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

/**
 * Campaign creation from chat (Phase 2 Slice 2). Re-callable across
 * multiple chat turns — each call finds-or-creates ONE in-flight
 * LAUNCH_CAMPAIGN task for this user (findActiveTaskForUserKind, since a
 * fresh campaign has no stable Meta id to key conflict detection on until a
 * job exists) and MERGES newly-supplied fields into what's already stored,
 * so "خليها 2000 بدل 1500" on a later turn updates the same task rather
 * than starting a second one. Refuses to guess product/page/pixel/
 * instagram/geo whenever genuinely ambiguous — lands in WAITING_FOR_INPUT
 * with a specific question instead.
 */
export async function prepare_campaign(args = {}) {
  const { userId, conversationRef, context } = args;
  let taskUuid = null;
  try {
    const existingTask = await findActiveTaskForUserKind({ userId, kind: 'LAUNCH_CAMPAIGN' });
    const priorInput = existingTask?.input_json ? JSON.parse(existingTask.input_json) : {};
    // New, explicitly-supplied fields win; anything omitted this turn keeps
    // its previously-supplied value — never regress data the user already gave.
    const merged = { ...priorInput };
    for (const [k, v] of Object.entries(args)) {
      if (['userId', 'conversationRef', 'context'].includes(k)) continue;
      if (v !== undefined && v !== null && v !== '') merged[k] = v;
    }

    const task = existingTask || await createTask({ userId, kind: 'LAUNCH_CAMPAIGN', toolName: 'prepare_campaign', inputJson: merged, conversationRef });
    taskUuid = task.task_uuid;
    if (task.status !== 'PREPARING') await transitionTask({ taskId: taskUuid, to: 'PREPARING', patch: { input_json: JSON.stringify(merged), progress: 15 } });
    else await patchTask({ taskId: taskUuid, patch: { input_json: JSON.stringify(merged) } });

    // Always re-persists the CURRENT `merged` (which may have gained
    // resolved-but-derived fields like productId since the top-of-function
    // save) — every WAITING_FOR_INPUT exit point goes through here, so
    // nothing resolved so far is ever lost even if the next chat turn
    // doesn't re-send page context.
    const needInput = async (message, patch = {}) => {
      await transitionTask({ taskId: taskUuid, to: 'WAITING_FOR_INPUT', patch: { error: message, input_json: JSON.stringify(merged), ...patch } });
      return { ok: true, task: (await resolveTaskStatus({ taskId: taskUuid })).task };
    };

    // 1. Required structural fields.
    const missing = ['campaignName', 'budgetEgp', 'budgetMode', 'adSetCount', 'adsPerAdSet', 'websiteUrl']
      .filter((k) => merged[k] === undefined || merged[k] === null || merged[k] === '');
    if (missing.length) return needInput(`محتاج منك: ${missing.join('، ')}.`);

    // 2. Product — prefer explicit page context, never guessed from the campaign name.
    let productId = merged.productId || context?.productId || null;
    if (!productId && merged.productName) {
      const p = await prisma.product.findFirst({ where: { product_name: { contains: merged.productName }, active: true, is_historical: false }, select: { id: true } });
      if (p) productId = p.id;
    }
    if (!productId) return needInput('عايز تطلق الكامبين ده لأنهي منتج بالظبط؟');
    const product = await resolveProduct(productId);
    if (!product) return needInput('المنتج ده مش موجود أو مش نشط — عايز تطلق لأنهي منتج؟');
    merged.productId = product.id;

    // 3. Ad account + page/pixel/instagram auto-resolution.
    const connection = await requireAdAccount();
    const resolved = await autoResolveAccountAssets(connection.selected_ad_account_id, {
      pageName: merged.pageName, pixelName: merged.pixelName, instagramUsername: merged.instagramUsername,
    });
    if (!resolved.ok) {
      const opts = resolved.options ? ' خيارات: ' + resolved.options.map((o) => o.name || o.username).join('، ') : '';
      return needInput(`${resolved.message}${opts}`);
    }

    // 4. Multi-governorate targeting (only if requested).
    let targeting = null;
    if (merged.targeting && (merged.targeting.governorates?.length || merged.targeting.genders || merged.targeting.ageMin || merged.targeting.ageMax)) {
      let geoRegions = [];
      if (merged.targeting.governorates?.length) {
        const geo = await resolveMultiGeoTargeting(merged.targeting.governorates);
        if (!geo.ok) return needInput(`مقدرتش أتعرف على المحافظة "${geo.unresolved}" — اكتبها بشكل تاني أو اختار محافظة تانية.`);
        geoRegions = geo.geoRegions;
      }
      targeting = { mode: 'CUSTOM', genders: merged.targeting.genders || 'ALL', ageMin: merged.targeting.ageMin || 18, ageMax: merged.targeting.ageMax || 65, geoRegions, placementsMode: 'AUTOMATIC' };
    }

    // 5. jobId — generated once, reused across every re-entry for this task.
    const jobId = task.launch_job_id || crypto.randomUUID();
    if (!task.launch_job_id) await patchTask({ taskId: taskUuid, patch: { launch_job_id: jobId, entity_id: jobId, entity_type: 'launch_job', entity_name: merged.campaignName } });

    const campaignCount = Number(merged.campaignCount) || 1;
    const budgetMinor = Math.round(Number(merged.budgetEgp) * 100);
    const launchInput = {
      adAccountId: connection.selected_ad_account_id,
      adAccountName: resolved.adAccountName,
      productId: merged.productId,
      pageId: resolved.pageId, pageName: resolved.pageName,
      pixelId: resolved.pixelId, pixelName: resolved.pixelName,
      instagramId: resolved.instagramId, instagramUsername: resolved.instagramUsername,
      platforms: resolved.platforms,
      budgetMode: merged.budgetMode,
      adSetsPerCampaign: Number(merged.adSetCount),
      adsPerAdSet: Number(merged.adsPerAdSet),
      campaignCount,
      campaigns: Array.from({ length: campaignCount }, (_, i) => ({
        name: campaignCount > 1 ? `${merged.campaignName} — ${i + 1}` : merged.campaignName,
        websiteUrl: merged.websiteUrl,
        primaryText: merged.primaryText || null,
        headline: merged.headline || null,
      })),
      budget: merged.budgetMode === 'CBO'
        ? { cbo: { dailyBudgetMinor: budgetMinor } }
        : { abo: { adSets: Array.from({ length: Number(merged.adSetCount) }, () => ({ dailyBudgetMinor: Math.round(budgetMinor / Number(merged.adSetCount)) })) } },
      startMode: merged.startMode === 'SCHEDULED' ? 'SCHEDULED' : 'NOW',
      startDate: merged.startDate || null,
      startTime: merged.startTime || null,
      timezone: resolved.timezone,
      launchMode: 'PAUSED_REVIEW', // always — never let the model choose NOW/SCHEDULED launch_mode in this slice
      targeting,
    };

    let job;
    try {
      job = await createDraftJob({ jobId, userId, input: launchInput });
    } catch (err) {
      if (err.status === 400) return needInput(err.message);
      throw err;
    }

    // 6. Media gate.
    const fullJob = await getJob(jobId);
    const hasMedia = (fullJob.videos || []).some((v) => v.status === 'UPLOADED') || (fullJob.images || []).some((i) => i.status === 'UPLOADED');
    if (!hasMedia) return needInput('جهزت الكامبين — دلوقتي ارفق الفيديوهات أو الصور من 📎 في الشات، وبعدين قولّي "كمّل".', { progress: 50 });

    // 7. All resolved — build the approval preview.
    const preview = {
      productName: product.product_name,
      campaignName: merged.campaignName,
      adAccountName: resolved.adAccountName,
      objective: 'OUTCOME_SALES',
      budgetEgp: Number(merged.budgetEgp),
      budgetMode: merged.budgetMode,
      adSetsPerCampaign: Number(merged.adSetCount),
      adsPerAdSet: Number(merged.adsPerAdSet),
      campaignCount,
      pixelName: resolved.pixelName,
      pageName: resolved.pageName,
      instagramUsername: resolved.instagramUsername,
      mediaCount: { videos: (fullJob.videos || []).filter((v) => v.status === 'UPLOADED').length, images: (fullJob.images || []).filter((i) => i.status === 'UPLOADED').length },
      startMode: launchInput.startMode,
      startAt: fullJob.start_at,
      targeting: targeting ? { genders: targeting.genders, ageMin: targeting.ageMin, ageMax: targeting.ageMax, governorates: targeting.geoRegions.map((g) => g.name) } : { mode: 'BROAD' },
      primaryText: merged.primaryText || null,
      headline: merged.headline || null,
      dataQuality: { productActive: true, pixelResolved: true, pageResolved: true, instagramResolved: !!resolved.instagramId, mediaReady: true },
    };

    const finalTask = await enterWaitingForApproval({ taskId: taskUuid, ambRecommendationId: null, preparedPayload: preview, actionType: 'LAUNCH_CAMPAIGN', recUpdatedAt: null });
    return { ok: true, task: (await resolveTaskStatus({ taskId: finalTask.task_uuid })).task };
  } catch (err) {
    if (taskUuid) await failTaskSafely({ taskId: taskUuid, error: err });
    return { ok: false, error: err.message };
  }
}

/**
 * Scale-from-chat (Phase 2 Slice 3). Re-callable across multiple chat turns
 * exactly like prepare_campaign (findActiveTaskForUserKind, merge fields).
 * NEVER calls persistProductDecision/approveProductDecision/
 * executeApprovedDecision (ADMIN-only routes — see scalePrepare.js's header
 * for why) — only reads the real Winning Stack via loadWinningStackForProduct
 * and builds a draft job through the same safe createDraftJob() prepare_campaign
 * uses. Refuses outright (BLOCKED, not WAITING_FOR_INPUT — no chat answer can
 * fix "not a proven winner yet") for anything short of a real SCALE_CANDIDATE
 * verdict from the actual decision engine.
 */
export async function prepare_scale(args = {}) {
  const { userId, conversationRef, context } = args;
  let taskUuid = null;
  try {
    const existingTask = await findActiveTaskForUserKind({ userId, kind: 'SCALE_CAMPAIGN' });
    const priorInput = existingTask?.input_json ? JSON.parse(existingTask.input_json) : {};
    const merged = { ...priorInput };
    for (const [k, v] of Object.entries(args)) {
      if (['userId', 'conversationRef', 'context'].includes(k)) continue;
      if (v !== undefined && v !== null && v !== '') merged[k] = v;
    }

    const task = existingTask || await createTask({ userId, kind: 'SCALE_CAMPAIGN', toolName: 'prepare_scale', inputJson: merged, conversationRef });
    taskUuid = task.task_uuid;
    if (task.status !== 'PREPARING') await transitionTask({ taskId: taskUuid, to: 'PREPARING', patch: { input_json: JSON.stringify(merged), progress: 15 } });
    else await patchTask({ taskId: taskUuid, patch: { input_json: JSON.stringify(merged) } });

    const needInput = async (message, patch = {}) => {
      await transitionTask({ taskId: taskUuid, to: 'WAITING_FOR_INPUT', patch: { error: message, input_json: JSON.stringify(merged), ...patch } });
      return { ok: true, task: (await resolveTaskStatus({ taskId: taskUuid })).task };
    };

    // 1. Product — same convention as prepare_campaign, never guessed.
    let productId = merged.productId || context?.productId || null;
    if (!productId && merged.productName) {
      const p = await prisma.product.findFirst({ where: { product_name: { contains: merged.productName }, active: true, is_historical: false }, select: { id: true } });
      if (p) productId = p.id;
    }
    if (!productId) return needInput('عايز تعمل Scale لأنهي منتج بالظبط؟');
    const product = await resolveProduct(productId);
    if (!product) return needInput('المنتج ده مش موجود أو مش نشط — عايز تعمل Scale لأنهي منتج؟');
    merged.productId = product.id;

    // 2. Required fields the tool never invents.
    const missing = ['budgetEgp', 'websiteUrl'].filter((k) => merged[k] === undefined || merged[k] === null || merged[k] === '');
    if (missing.length) return needInput(`محتاج منك: ${missing.join('، ')}.`);

    // 3. Real Winning Stack — the actual evidence/security gate.
    const connection = await requireAdAccount();
    const adAccountId = connection.selected_ad_account_id;
    const winStack = await loadWinningStackForProduct({ productId: merged.productId, adAccountId });
    if (!winStack.ok) {
      await transitionTask({ taskId: taskUuid, to: 'BLOCKED', patch: { blocked_reason: winStack.message, entity_name: winStack.productName || product.product_name } });
      return { ok: false, error: 'NOT_A_PROVEN_WINNER', message: winStack.message };
    }

    // 3.5. Money Guard — real profit + stock gates, independent of the
    // CPA-vs-target SCALE_CANDIDATE verdict above (a product can look
    // CPA-healthy vs an arbitrary target while actually losing money on
    // real break-even math). Refuses outright (BLOCKED) for genuinely
    // unprofitable or out-of-stock products — no amount of approval should
    // paper over those two. Anything else short of fully clean data becomes
    // an honest WARN flag carried into the preview, never a silent pass.
    const settings = await getAmbSettings();
    const opWindow = resolveWindow(resolveOperationalWindowName(settings));
    const profitBrain = await getProductProfitBrain({ productId: merged.productId, dateFrom: opWindow.from, dateTo: opWindow.to });
    const stock = await stockGuardForProduct({ productId: merged.productId, storeId: product.store_id, days: settings.ambStockGuardVelocityWindowDays });
    const moneyGuard = evaluateMoneyGuardForScale({ profitState: profitBrain.state, stockGuard: stock, creativeFatigueState: winStack.creativeFatigueState, settings });
    if (moneyGuard.decision === 'BLOCKED') {
      await transitionTask({ taskId: taskUuid, to: 'BLOCKED', patch: { blocked_reason: moneyGuard.reason, entity_name: product.product_name } });
      return { ok: false, error: 'BLOCKED', message: moneyGuard.reason };
    }

    // 4. Page/Pixel/Instagram — prefer this product's own real launch history (resolveTrackingIdentity), fall back to the same auto-resolve prepare_campaign uses when history is incomplete (never guessed either way).
    let resolved;
    if (winStack.tracking.pixel_id && winStack.tracking.page_id) {
      resolved = {
        ok: true, adAccountName: connection.selected_ad_account_name || null,
        timezone: 'Africa/Cairo',
        pageId: winStack.tracking.page_id, pageName: winStack.tracking.page_name,
        pixelId: winStack.tracking.pixel_id, pixelName: winStack.tracking.pixel_name,
        instagramId: winStack.tracking.instagram_id, instagramUsername: winStack.tracking.instagram_username,
        platforms: winStack.tracking.instagram_id ? ['facebook', 'instagram'] : ['facebook'],
      };
    } else {
      resolved = await autoResolveAccountAssets(adAccountId, {
        pageName: merged.pageName, pixelName: merged.pixelName, instagramUsername: merged.instagramUsername,
      });
      if (!resolved.ok) {
        const opts = resolved.options ? ' خيارات: ' + resolved.options.map((o) => o.name || o.username).join('، ') : '';
        return needInput(`${resolved.message}${opts}`);
      }
    }

    // 5. jobId — generated once, reused across every re-entry for this task.
    const jobId = task.launch_job_id || crypto.randomUUID();
    const campaignName = merged.campaignName || `${winStack.productName} — Scale`;
    if (!task.launch_job_id) await patchTask({ taskId: taskUuid, patch: { launch_job_id: jobId, entity_id: jobId, entity_type: 'launch_job', entity_name: campaignName } });

    const budgetMinor = Math.round(Number(merged.budgetEgp) * 100);
    const launchInput = {
      adAccountId,
      adAccountName: resolved.adAccountName,
      productId: merged.productId,
      pageId: resolved.pageId, pageName: resolved.pageName,
      pixelId: resolved.pixelId, pixelName: resolved.pixelName,
      instagramId: resolved.instagramId, instagramUsername: resolved.instagramUsername,
      platforms: resolved.platforms,
      budgetMode: 'CBO',
      adSetsPerCampaign: 1,
      adsPerAdSet: 1,
      campaignCount: 1,
      campaigns: [{ name: campaignName, websiteUrl: merged.websiteUrl, primaryText: merged.primaryText || winStack.stack.primaryText?.value || null, headline: merged.headline || winStack.stack.headline?.value || null }],
      budget: { cbo: { dailyBudgetMinor: budgetMinor } },
      startMode: 'NOW',
      startDate: null,
      startTime: null,
      timezone: resolved.timezone,
      launchMode: 'PAUSED_REVIEW', // always — never let the model choose NOW/SCHEDULED launch_mode
      targeting: winStack.targeting,
    };

    let job;
    try {
      job = await createDraftJob({ jobId, userId, input: launchInput });
    } catch (err) {
      if (err.status === 400) return needInput(err.message);
      throw err;
    }

    // 6. Zero-upload media reuse — if the winning creative's real Meta asset is registered for THIS ad account, write it straight into the job's media slot (no upload, no new Meta call). Otherwise fall back to the same 📎-attach gate prepare_campaign uses.
    const fullJob = await getJob(jobId);
    const alreadyHasMedia = (fullJob.videos || []).some((v) => v.status === 'UPLOADED') || (fullJob.images || []).some((i) => i.status === 'UPLOADED');
    let reusedAsset = false;
    if (!alreadyHasMedia) {
      const asset = await resolveWinningCreativeAsset(winStack.creativeAssetId, adAccountId);
      if (asset?.kind === 'video') {
        await registerVideoSlot({ jobId, slotKey: 'C1', originalFilename: winStack.creativeLabel || 'winning-creative' });
        await markVideoResult({ jobId, slotKey: 'C1', status: 'UPLOADED', metaVideoId: asset.metaId });
        reusedAsset = true;
      } else if (asset?.kind === 'image') {
        await registerImageSlot({ jobId, slotKey: 'I1', originalFilename: winStack.creativeLabel || 'winning-creative' });
        await markImageResult({ jobId, slotKey: 'I1', status: 'UPLOADED', metaImageHash: asset.metaId });
        reusedAsset = true;
      }
    }

    const fullJob2 = reusedAsset ? await getJob(jobId) : fullJob;
    const hasMedia = (fullJob2.videos || []).some((v) => v.status === 'UPLOADED') || (fullJob2.images || []).some((i) => i.status === 'UPLOADED');
    if (!hasMedia) return needInput('الكرييتيف الرابح مش متسجل على الحساب الإعلاني ده — ارفق فيديو أو صورة من 📎 في الشات، وبعدين قولّي "كمّل".', { progress: 50 });

    // 7. All resolved — build the approval preview.
    const preview = {
      productName: winStack.productName,
      campaignName,
      adAccountName: resolved.adAccountName,
      objective: 'OUTCOME_SALES',
      budgetEgp: Number(merged.budgetEgp),
      budgetMode: 'CBO',
      adSetsPerCampaign: 1,
      adsPerAdSet: 1,
      campaignCount: 1,
      pixelName: resolved.pixelName,
      pageName: resolved.pageName,
      instagramUsername: resolved.instagramUsername,
      mediaCount: { videos: (fullJob2.videos || []).filter((v) => v.status === 'UPLOADED').length, images: (fullJob2.images || []).filter((i) => i.status === 'UPLOADED').length },
      startMode: 'NOW',
      startAt: fullJob2.start_at,
      targeting: winStack.targeting ? { genders: winStack.targeting.genders, ageMin: winStack.targeting.ageMin, ageMax: winStack.targeting.ageMax, governorates: winStack.targeting.geoRegions.map((g) => g.name) } : { mode: 'BROAD' },
      primaryText: launchInput.campaigns[0].primaryText,
      headline: launchInput.campaigns[0].headline,
      dataQuality: { productActive: true, pixelResolved: !!resolved.pixelId, pageResolved: !!resolved.pageId, instagramResolved: !!resolved.instagramId, mediaReady: true },
      sourceWinner: { assetId: winStack.creativeAssetId, label: winStack.creativeLabel, cpa: winStack.creativeCpa, purchases: winStack.creativePurchases, reusedFromMediaLibrary: reusedAsset, fatigueState: winStack.creativeFatigueState, fatigueEvidence: winStack.creativeFatigueEvidence },
      profitBrain: { state: profitBrain.state, marginPct: profitBrain.marginPct, configState: profitBrain.configState },
      stockGuard: { status: stock.status, currentStock: stock.currentStock, daysRemaining: stock.daysRemaining },
      moneyGuardWarning: moneyGuard.decision === 'WARN' ? moneyGuard.reason : null,
    };

    const finalTask = await enterWaitingForApproval({ taskId: taskUuid, ambRecommendationId: null, preparedPayload: preview, actionType: 'SCALE_CAMPAIGN', recUpdatedAt: null });
    return { ok: true, task: (await resolveTaskStatus({ taskId: finalTask.task_uuid })).task };
  } catch (err) {
    if (taskUuid) await failTaskSafely({ taskId: taskUuid, error: err });
    return { ok: false, error: err.message };
  }
}

/**
 * Testing Brain's "اعمل الاختبار المقترح" (Phase 3 Slice 3). A controlled
 * AUDIENCE or GEO test: targeting varies by exactly the one dimension being
 * tested, the product's current best creative is held CONSTANT (zero-upload
 * reuse, same mechanism prepare_scale already built) so the test actually
 * isolates one variable. CREATIVE-dimension tests are deliberately not
 * supported here yet — that needs a genuinely new creative asset (Creative
 * Brief/generation, a later slice), not a re-targeted reuse of the winner.
 */
export async function prepare_test(args = {}) {
  const { userId, conversationRef, context } = args;
  let taskUuid = null;
  try {
    const existingTask = await findActiveTaskForUserKind({ userId, kind: 'TEST_CAMPAIGN' });
    const priorInput = existingTask?.input_json ? JSON.parse(existingTask.input_json) : {};
    const merged = { ...priorInput };
    for (const [k, v] of Object.entries(args)) {
      if (['userId', 'conversationRef', 'context'].includes(k)) continue;
      if (v !== undefined && v !== null && v !== '') merged[k] = v;
    }

    const task = existingTask || await createTask({ userId, kind: 'TEST_CAMPAIGN', toolName: 'prepare_test', inputJson: merged, conversationRef });
    taskUuid = task.task_uuid;
    if (task.status !== 'PREPARING') await transitionTask({ taskId: taskUuid, to: 'PREPARING', patch: { input_json: JSON.stringify(merged), progress: 15 } });
    else await patchTask({ taskId: taskUuid, patch: { input_json: JSON.stringify(merged) } });

    const needInput = async (message, patch = {}) => {
      await transitionTask({ taskId: taskUuid, to: 'WAITING_FOR_INPUT', patch: { error: message, input_json: JSON.stringify(merged), ...patch } });
      return { ok: true, task: (await resolveTaskStatus({ taskId: taskUuid })).task };
    };

    // 1. Product — same convention as prepare_campaign/prepare_scale, never guessed.
    let productId = merged.productId || context?.productId || null;
    if (!productId && merged.productName) {
      const p = await prisma.product.findFirst({ where: { product_name: { contains: merged.productName }, active: true, is_historical: false }, select: { id: true } });
      if (p) productId = p.id;
    }
    if (!productId) return needInput('عايز تعمل الاختبار ده لأنهي منتج بالظبط؟');
    const product = await resolveProduct(productId);
    if (!product) return needInput('المنتج ده مش موجود أو مش نشط — عايز تعمل الاختبار لأنهي منتج؟');
    merged.productId = product.id;

    // 2. Required fields the tool never invents.
    if (!['AUDIENCE', 'GEO'].includes(merged.testDimension)) return needInput('الاختبار ده لأنهي بُعد؟ (AUDIENCE للجمهور، أو GEO للمحافظات — اختبار الكرياتيف لسه مش متاح من الشات).');
    const missing = ['testValue', 'budgetEgp', 'websiteUrl'].filter((k) => merged[k] === undefined || merged[k] === null || merged[k] === '');
    if (missing.length) return needInput(`محتاج منك: ${missing.join('، ')}.`);

    // 3. Targeting for the dimension being tested — the ONE variable that changes.
    let targeting;
    if (merged.testDimension === 'AUDIENCE') {
      const parsed = parseAudienceTestValue(merged.testValue);
      if (!parsed) return needInput('قيمة الجمهور دي مش واضحة — اكتب فئة عمرية بصيغة Meta زي "25-34" أو "65+"، أو "رجال"/"نساء".');
      targeting = {
        mode: 'CUSTOM', genders: parsed.mode === 'GENDER' ? parsed.gender : 'ALL',
        ageMin: parsed.mode === 'AGE' ? parsed.ageMin : 18, ageMax: parsed.mode === 'AGE' ? parsed.ageMax : 65,
        geoRegions: [], placementsMode: 'AUTOMATIC',
      };
    } else {
      const geo = await resolveMultiGeoTargeting([merged.testValue]);
      if (!geo.ok) return needInput(`مقدرتش أتعرف على المحافظة "${geo.unresolved}" — اكتبها بشكل تاني.`);
      targeting = { mode: 'CUSTOM', genders: 'ALL', ageMin: 18, ageMax: 65, geoRegions: geo.geoRegions, placementsMode: 'AUTOMATIC' };
    }

    // 4. Real Winning Stack context — the creative to hold constant + duplicate-test guard against durable learning memory.
    const connection = await requireAdAccount();
    const adAccountId = connection.selected_ad_account_id;
    const testCtx = await loadTestContext({ productId: merged.productId, adAccountId, testDimension: merged.testDimension, testValue: merged.testValue });
    if (!testCtx.ok) {
      await transitionTask({ taskId: taskUuid, to: 'BLOCKED', patch: { blocked_reason: testCtx.message, entity_name: product.product_name } });
      return { ok: false, error: 'BLOCKED', message: testCtx.message };
    }

    // 5. Money Guard — profit gate only (a test's small budget doesn't warrant a stock/fatigue check the way a Scale does).
    const settings = await getAmbSettings();
    const opWindow = resolveWindow(resolveOperationalWindowName(settings));
    const profitBrain = await getProductProfitBrain({ productId: merged.productId, dateFrom: opWindow.from, dateTo: opWindow.to });
    const moneyGuard = evaluateMoneyGuardForScale({ profitState: profitBrain.state, stockGuard: null, creativeFatigueState: null, settings });
    if (moneyGuard.decision === 'BLOCKED') {
      await transitionTask({ taskId: taskUuid, to: 'BLOCKED', patch: { blocked_reason: moneyGuard.reason, entity_name: product.product_name } });
      return { ok: false, error: 'BLOCKED', message: moneyGuard.reason };
    }

    // 6. Page/Pixel/Instagram — same auto-resolve every launch-family prepare tool uses.
    const resolved = await autoResolveAccountAssets(adAccountId, { pageName: merged.pageName, pixelName: merged.pixelName, instagramUsername: merged.instagramUsername });
    if (!resolved.ok) {
      const opts = resolved.options ? ' خيارات: ' + resolved.options.map((o) => o.name || o.username).join('، ') : '';
      return needInput(`${resolved.message}${opts}`);
    }

    // 7. jobId — generated once, reused across every re-entry for this task.
    const jobId = task.launch_job_id || crypto.randomUUID();
    const dimLabel = merged.testDimension === 'AUDIENCE' ? 'اختبار جمهور' : 'اختبار محافظة';
    const campaignName = merged.campaignName || `${testCtx.productName} — ${dimLabel} (${merged.testValue})`;
    if (!task.launch_job_id) await patchTask({ taskId: taskUuid, patch: { launch_job_id: jobId, entity_id: jobId, entity_type: 'launch_job', entity_name: campaignName } });

    const budgetMinor = Math.round(Number(merged.budgetEgp) * 100);
    const launchInput = {
      adAccountId, adAccountName: resolved.adAccountName, productId: merged.productId,
      pageId: resolved.pageId, pageName: resolved.pageName, pixelId: resolved.pixelId, pixelName: resolved.pixelName,
      instagramId: resolved.instagramId, instagramUsername: resolved.instagramUsername, platforms: resolved.platforms,
      budgetMode: 'CBO', adSetsPerCampaign: 1, adsPerAdSet: 1, campaignCount: 1,
      campaigns: [{ name: campaignName, websiteUrl: merged.websiteUrl, primaryText: merged.primaryText || null, headline: merged.headline || null }],
      budget: { cbo: { dailyBudgetMinor: budgetMinor } },
      startMode: 'NOW', startDate: null, startTime: null, timezone: resolved.timezone,
      launchMode: 'PAUSED_REVIEW', // always — never let the model choose NOW/SCHEDULED launch_mode
      targeting,
    };

    let job;
    try {
      job = await createDraftJob({ jobId, userId, input: launchInput });
    } catch (err) {
      if (err.status === 400) return needInput(err.message);
      throw err;
    }

    // 8. Hold the creative constant — zero-upload reuse of the SAME winning asset prepare_scale uses, so this test isolates ONLY the targeting variable.
    const fullJob = await getJob(jobId);
    const alreadyHasMedia = (fullJob.videos || []).some((v) => v.status === 'UPLOADED') || (fullJob.images || []).some((i) => i.status === 'UPLOADED');
    let reusedAsset = false;
    if (!alreadyHasMedia && testCtx.creativeAssetId) {
      const asset = await resolveWinningCreativeAsset(testCtx.creativeAssetId, adAccountId);
      if (asset?.kind === 'video') {
        await registerVideoSlot({ jobId, slotKey: 'C1', originalFilename: testCtx.controlCreativeLabel || 'control-creative' });
        await markVideoResult({ jobId, slotKey: 'C1', status: 'UPLOADED', metaVideoId: asset.metaId });
        reusedAsset = true;
      } else if (asset?.kind === 'image') {
        await registerImageSlot({ jobId, slotKey: 'I1', originalFilename: testCtx.controlCreativeLabel || 'control-creative' });
        await markImageResult({ jobId, slotKey: 'I1', status: 'UPLOADED', metaImageHash: asset.metaId });
        reusedAsset = true;
      }
    }

    const fullJob2 = reusedAsset ? await getJob(jobId) : fullJob;
    const hasMedia = (fullJob2.videos || []).some((v) => v.status === 'UPLOADED') || (fullJob2.images || []).some((i) => i.status === 'UPLOADED');
    if (!hasMedia) return needInput('الكرياتيف اللي هنثبته للاختبار مش متسجل على الحساب ده — ارفق فيديو أو صورة من 📎 في الشات، وبعدين قولّي "كمّل".', { progress: 50 });

    // 9. Track this as a real PMC test row when a marketing profile exists — never auto-creates one (matches resolveProfileForProduct's own "never fabricate" rule). Non-fatal if it fails.
    let pmcTestId = null;
    try {
      const profile = await prisma.productMarketingProfile.findFirst({ where: { product_id: merged.productId }, select: { id: true } });
      if (profile) {
        const pmcTest = await createPmcTest({
          profileId: profile.id,
          testType: merged.testDimension === 'AUDIENCE' ? 'AUDIENCE' : 'MARKET_AREA',
          hypothesis: `تغيير ${dimLabel === 'اختبار جمهور' ? 'الجمهور' : 'المحافظة'} لـ"${merged.testValue}" ممكن يحسّن ${testCtx.successMetric} مقارنة بالوضع الحالي.`,
          variable: merged.testDimension, control: testCtx.controlCreativeLabel || 'الوضع الحالي', variation: merged.testValue,
          recommendedBudget: Number(merged.budgetEgp), successMetric: testCtx.successMetric,
          expectedLearning: `هل ${merged.testValue} بيحسن ${testCtx.successMetric} عن الوضع الحالي، مع تثبيت نفس الكرياتيف؟`,
          userId,
        });
        pmcTestId = pmcTest.id;
      }
    } catch (err) {
      // Tracking-only — never blocks the actual test campaign preparation.
    }

    // 10. All resolved — build the approval preview.
    const preview = {
      productName: testCtx.productName, campaignName, adAccountName: resolved.adAccountName, objective: 'OUTCOME_SALES',
      budgetEgp: Number(merged.budgetEgp), budgetMode: 'CBO', adSetsPerCampaign: 1, adsPerAdSet: 1, campaignCount: 1,
      pixelName: resolved.pixelName, pageName: resolved.pageName, instagramUsername: resolved.instagramUsername,
      mediaCount: { videos: (fullJob2.videos || []).filter((v) => v.status === 'UPLOADED').length, images: (fullJob2.images || []).filter((i) => i.status === 'UPLOADED').length },
      startMode: 'NOW', startAt: fullJob2.start_at,
      targeting: { genders: targeting.genders, ageMin: targeting.ageMin, ageMax: targeting.ageMax, governorates: targeting.geoRegions.map((g) => g.name) },
      primaryText: launchInput.campaigns[0].primaryText, headline: launchInput.campaigns[0].headline,
      dataQuality: { productActive: true, pixelResolved: !!resolved.pixelId, pageResolved: !!resolved.pageId, instagramResolved: !!resolved.instagramId, mediaReady: true },
      testDesign: {
        dimension: merged.testDimension, variant: merged.testValue, control: testCtx.controlCreativeLabel || 'الوضع الحالي',
        heldConstant: 'نفس الكرياتيف الحالي' + (reusedAsset ? ' (تم إعادة استخدامه من غير رفع جديد)' : ''),
        successMetric: testCtx.successMetric, evaluationWindowDays: testCtx.evaluationWindowDays, pmcTestId,
      },
      profitBrain: { state: profitBrain.state, marginPct: profitBrain.marginPct, configState: profitBrain.configState },
      moneyGuardWarning: moneyGuard.decision === 'WARN' ? moneyGuard.reason : null,
    };

    const finalTask = await enterWaitingForApproval({ taskId: taskUuid, ambRecommendationId: null, preparedPayload: preview, actionType: 'TEST_CAMPAIGN', recUpdatedAt: null });
    return { ok: true, task: (await resolveTaskStatus({ taskId: finalTask.task_uuid })).task };
  } catch (err) {
    if (taskUuid) await failTaskSafely({ taskId: taskUuid, error: err });
    return { ok: false, error: err.message };
  }
}

/**
 * Price Testing Engine (Phase 3 Slice 12). Unlike every other prepare_*
 * tool, the write here is a LOCAL database field (Product.selling_price) —
 * never Meta, never Easy Orders. Still goes through the exact same
 * PREPARE -> approval-hash -> conflict-check -> EXECUTE -> verify-after-
 * write discipline (see taskEngine.js's approvePriceTestTask). Captures a
 * real baseline snapshot at prepare time so get_price_test_status can later
 * compare honestly instead of guessing "before" state.
 */
export async function prepare_price_test({ productId, productName, newPrice, userId, conversationRef, context } = {}) {
  let taskUuid = null;
  try {
    let pid = productId || context?.productId || null;
    if (!pid && productName) {
      const p = await prisma.product.findFirst({ where: { product_name: { contains: productName }, active: true, is_historical: false }, select: { id: true } });
      if (p) pid = p.id;
    }
    if (!pid) return { ok: false, error: 'عايز تختبر سعر لأنهي منتج بالظبط؟' };
    if (newPrice === undefined || newPrice === null || Number(newPrice) <= 0) return { ok: false, error: 'محتاج السعر الجديد المقترح (رقم أكبر من صفر).' };

    const existing = await findActiveTaskForEntity(String(pid));
    if (existing) return { ok: true, task: (await resolveTaskStatus({ taskId: existing.task_uuid })).task, note: 'فيه تاسك شغال بالفعل على المنتج ده.' };

    const baseline = await capturePriceTestBaseline({ productId: pid });
    if (!baseline.ok) return { ok: false, error: baseline.message };

    const task = await createTask({ userId, kind: 'PRICE_TEST', toolName: 'prepare_price_test', entityId: String(pid), entityType: 'product', entityName: baseline.productName, inputJson: { productId: pid, newPrice }, conversationRef });
    taskUuid = task.task_uuid;
    await transitionTask({ taskId: taskUuid, to: 'PREPARING', patch: { progress: 30 } });

    // Track as a real PMC PRICE test when a marketing profile exists — same graceful, non-fatal fallback prepare_test uses.
    let pmcTestId = null;
    try {
      const profile = await prisma.productMarketingProfile.findFirst({ where: { product_id: pid }, select: { id: true } });
      if (profile) {
        const pmcTest = await createPmcTest({
          profileId: profile.id, testType: 'PRICE',
          hypothesis: `تغيير السعر من ${baseline.currentPrice} لـ${newPrice} ممكن يحسّن/يحافظ على الربح الحقيقي.`,
          variable: 'price', control: String(baseline.currentPrice), variation: String(newPrice),
          successMetric: 'netProfit', expectedLearning: 'هل السعر الجديد بيحسّن صافي الربح الحقيقي مقارنة بالسعر الحالي؟',
          userId,
        });
        pmcTestId = pmcTest.id;
      }
    } catch { /* tracking-only — never blocks the actual price test */ }

    const preview = {
      productName: baseline.productName,
      currentPrice: baseline.currentPrice,
      newPrice: Number(newPrice),
      priceChangePct: baseline.currentPrice > 0 ? Math.round(((Number(newPrice) - baseline.currentPrice) / baseline.currentPrice) * 1000) / 10 : null,
      baseline: baseline.baseline,
      pmcTestId,
      warning: 'السعر هيتغير فعليًا في قاعدة البيانات لحظة الموافقة (بيأثر على أي عرض للمنتج) — راجعه كويس.',
    };

    const finalTask = await enterWaitingForApproval({ taskId: taskUuid, ambRecommendationId: null, preparedPayload: preview, actionType: 'PRICE_TEST', recUpdatedAt: null });
    return { ok: true, task: (await resolveTaskStatus({ taskId: finalTask.task_uuid })).task };
  } catch (err) {
    if (taskUuid) await failTaskSafely({ taskId: taskUuid, error: err });
    return { ok: false, error: err.message };
  }
}

export async function generate_campaign_copy({ productId, productName, angle, tone } = {}) {
  try {
    if (!productId && !productName) return { ok: false, error: 'محتاج اسم المنتج على الأقل.' };
    const resolved = await resolveProductByIdOrName({ productId, productName });
    if (!resolved.ok) return resolved;
    const { generatePost } = await import('./amb/productMarketingAI.js');
    const res = await generatePost({ productName: resolved.product.product_name, angle, tone });
    if (!res.ok) return { ok: false, error: res.reason };
    return { ok: true, productId: resolved.product.id, productName: resolved.product.product_name, post: res.post };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function get_my_recent_tasks({ userId } = {}) {
  try {
    if (!userId) return { ok: false, error: 'userId مطلوب.' };
    return await listRecentTasksForUser({ userId, limit: 5 });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Slice 17 — Operator Recovery. "فاضل إيه؟" / "وقفت ليه؟" for a
// LAUNCH/SCALE/TEST_CAMPAIGN task — reads the SAME real per-campaign queue
// progress the Task Card already polls (getQueueProgress), never a second
// progress model. Distinguishes a genuinely stuck/unknown state (no
// heartbeat for a while, nothing left retrying) from real, ongoing work —
// a stalled task is reported as "الحالة الحقيقية مش معروفة", never silently
// claimed COMPLETED/FAILED without evidence.
const STALE_HEARTBEAT_MS = 10 * 60 * 1000;
export async function get_task_progress({ taskUuid } = {}) {
  try {
    if (!taskUuid) return { ok: false, error: 'taskUuid مطلوب.' };
    const task = await prisma.assistantTask.findUnique({ where: { task_uuid: taskUuid } });
    if (!task) return { ok: false, error: 'التاسك مش موجود.' };

    if (!task.launch_job_id) {
      return { ok: true, hasLaunchJob: false, status: task.status, error: task.error, blockedReason: task.blocked_reason, updatedAt: task.updated_at };
    }
    const { getQueueProgress } = await import('./amb/launchPublish.js');
    const progress = await getQueueProgress(task.launch_job_id);
    if (!progress) return { ok: false, error: 'مفيش تقدّم حقيقي مسجّل لهذا التاسك.' };

    const stale = ['RUNNING', 'VERIFYING'].includes(task.status) && (Date.now() - new Date(task.heartbeat_at || task.updated_at).getTime()) > STALE_HEARTBEAT_MS;
    const done = progress.campaigns.filter((c) => c.phase === 'COMPLETE');
    const stuckNeedsHuman = progress.campaigns.filter((c) => c.humanActionRequired);
    const stillWorking = progress.campaigns.filter((c) => !['COMPLETE'].includes(c.phase) && !c.humanActionRequired);

    return {
      ok: true, hasLaunchJob: true, status: task.status,
      effectiveStatus: stale ? 'UNKNOWN' : task.status,
      staleNote: stale ? `التاسك من غير أي تحديث حقيقي من ${Math.round((Date.now() - new Date(task.heartbeat_at || task.updated_at).getTime()) / 60000)} دقيقة — الحالة الحقيقية مش معروفة دلوقتي، ينصح تتأكد من Meta مباشرة أو تجرب "جرب تاني".` : null,
      totalCampaigns: progress.campaigns.length,
      completedCampaigns: done.length,
      remainingCampaigns: stillWorking.map((c) => ({ name: c.name, phase: c.phase, adSetsCreated: c.adSetsCreated, adSetsTotal: c.adSetsTotal, adsCreated: c.adsCreated, adsTotal: c.adsTotal })),
      blockedCampaigns: stuckNeedsHuman.map((c) => ({ name: c.name, error: c.error, errorClassification: c.errorClassification })),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * "جرب تاني" — Slice 17. Two SAFE, distinct paths, never a duplicate write:
 *   1. Task already has a real launch_job_id (it reached Meta publishing at
 *      least once) — the plan is already approved and campaigns may already
 *      be LIVE on Meta. Retrying here NEVER re-prepares a new plan (that
 *      would risk a second, duplicate campaign); it only nudges the SAME
 *      job's already-scheduled-but-not-yet-human-blocked campaigns via the
 *      existing retryLaunchCampaignNow(), exactly what the Launch UI's own
 *      "إعادة محاولة الآن" button does. A campaign genuinely ACTION_REQUIRED
 *      is never silently retried — its real blocking reason is returned so
 *      the human fixes it first.
 *   2. Task never reached Meta (no launch_job_id — a pure prepare-time
 *      failure/block, e.g. Money Guard, Data Quality, missing input) — the
 *      ONLY safe retry is to re-run the ORIGINAL prepare_* call with its
 *      ORIGINAL input, which is exactly the established "call prepare_x
 *      again" convention every other slice already relies on. This always
 *      creates a fresh task with a fresh approval — nothing stale is reused.
 */
export async function retry_task({ taskUuid, userId, conversationRef } = {}) {
  try {
    if (!taskUuid) return { ok: false, error: 'taskUuid مطلوب.' };
    const task = await prisma.assistantTask.findUnique({ where: { task_uuid: taskUuid } });
    if (!task) return { ok: false, error: 'التاسك مش موجود.' };
    if (!['FAILED', 'BLOCKED'].includes(task.status)) return { ok: false, error: `التاسك ده حالته ${task.status} — إعادة المحاولة متاحة بس للتاسكات اللي فشلت أو اتوقفت.` };

    if (task.launch_job_id) {
      const { getQueueProgress, retryLaunchCampaignNow } = await import('./amb/launchPublish.js');
      const progress = await getQueueProgress(task.launch_job_id);
      if (!progress) return { ok: false, error: 'مفيش تقدّم حقيقي مسجّل لهذا التاسك — مينفعش نعيد المحاولة من غيره.' };

      const blocked = progress.campaigns.filter((c) => c.humanActionRequired);
      if (blocked.length) {
        return {
          ok: true, retried: false,
          note: 'فيه كامبينات محتاجة تدخل يدوي قبل إعادة المحاولة — مش هينفع نعيد المحاولة تلقائيًا.',
          blockedCampaigns: blocked.map((c) => ({ name: c.name, error: c.error, errorClassification: c.errorClassification })),
        };
      }
      const retryable = progress.campaigns.filter((c) => !['COMPLETE'].includes(c.phase));
      if (!retryable.length) return { ok: true, retried: false, note: 'كل الكامبينات خلصت بالفعل — مفيش حاجة تتعاد.' };

      for (const c of retryable) await retryLaunchCampaignNow({ jobId: task.launch_job_id, campaignIndex: c.index }).catch(() => {});
      if (task.status === 'FAILED') await transitionTask({ taskId: taskUuid, to: 'RUNNING', patch: { error: null, progress: Math.round((progress.campaigns.length - retryable.length) / progress.campaigns.length * 100) } });
      return { ok: true, retried: true, nudgedCampaigns: retryable.map((c) => c.name), note: 'المفروض الكامبينات دي تستأنف خلال ثواني — استخدم get_task_progress للمتابعة.' };
    }

    // No launch_job_id — safe to re-run the original prepare_* call verbatim.
    const originalInput = task.input_json ? JSON.parse(task.input_json) : {};
    const impl = WRITE_TOOL_IMPLS[task.tool_name];
    if (!impl) return { ok: false, error: `مفيش أداة تجهيز معروفة اسمها ${task.tool_name} — مينفعش نعيد المحاولة تلقائيًا.` };
    const result = await impl({ ...originalInput, userId, conversationRef });
    return { ok: true, retried: true, reprepared: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** "الغِ التاسك" — a thin chat-facing wrapper over the SAME cancel transition the Task History page's own cancel button already uses. Only ever cancels a task still in a non-terminal, non-launched state. */
export async function cancel_task({ taskUuid } = {}) {
  try {
    if (!taskUuid) return { ok: false, error: 'taskUuid مطلوب.' };
    const task = await prisma.assistantTask.findUnique({ where: { task_uuid: taskUuid } });
    if (!task) return { ok: false, error: 'التاسك مش موجود.' };
    if (!canTransitionTask(task.status, 'CANCELLED')) return { ok: false, error: `التاسك ده حالته ${task.status} — مينفعش يتلغي دلوقتي.` };
    const cancelled = await transitionTask({ taskId: taskUuid, to: 'CANCELLED' });
    return { ok: true, task: { taskUuid: cancelled.task_uuid, status: cancelled.status } };
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
    name: 'prepare_campaign',
    description: '[تجهيز — لا ينشئ أي كامبين فعليًا على Meta] يجهّز كامبين إعلاني حقيقي (Draft Job) من وصف طبيعي — اسم، ميزانية، CBO/ABO، عدد Ad Sets وإعلانات، استهداف. ينشئ تاسك يظهر كارت معاينة. المستخدم لازم يرفق ميديا (📎 في الشات) ويوافق قبل أي إنشاء فعلي. قابل للاستدعاء أكتر من مرة في نفس المحادثة — كل استدعاء بيحدّث نفس التاسك النشط بدل ما ينشئ واحد جديد (مفيد لو المستخدم غيّر رأيه في تفصيلة زي الميزانية).',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج الحقيقي، لو معروف' },
        productName: { type: 'string', description: 'اسم المنتج لو productId مش معروف — هيتحاول يتلاقى، ولو مش واضح هيسأل' },
        campaignName: { type: 'string' },
        websiteUrl: { type: 'string', description: 'رابط الموقع/صفحة المنتج — لازم من المستخدم، ممنوع تخترعه' },
        pageName: { type: 'string', description: 'اسم صفحة الفيسبوك المطلوبة — بس لو المستخدم حدد واحدة (مثلاً ردًا على سؤال الـ Tool)، وإلا سيبه فاضي' },
        pixelName: { type: 'string', description: 'اسم الـ Pixel المطلوب — بس لو المستخدم حدد واحد، وإلا سيبه فاضي' },
        instagramUsername: { type: 'string', description: 'اسم حساب الإنستجرام المطلوب — بس لو المستخدم حدد واحد، وإلا سيبه فاضي' },
        budgetEgp: { type: 'number', description: 'الميزانية اليومية بالجنيه' },
        budgetMode: { type: 'string', enum: ['CBO', 'ABO'] },
        adSetCount: { type: 'integer' },
        adsPerAdSet: { type: 'integer' },
        campaignCount: { type: 'integer', description: 'افتراضي 1' },
        targeting: {
          type: 'object',
          properties: {
            genders: { type: 'string', enum: ['ALL', 'MALE', 'FEMALE'] },
            ageMin: { type: 'integer' },
            ageMax: { type: 'integer' },
            governorates: { type: 'array', items: { type: 'string' }, description: 'أسماء محافظات مصرية بالعربي' },
          },
        },
        startMode: { type: 'string', enum: ['NOW', 'SCHEDULED'] },
        startDate: { type: 'string' },
        startTime: { type: 'string' },
        primaryText: { type: 'string' },
        headline: { type: 'string' },
      },
    },
  },
  {
    name: 'prepare_scale',
    description: '[تجهيز — لا ينشئ أي كامبين فعليًا على Meta] يجهّز كامبين "Scale" حقيقي (Draft Job بـ Ad Set واحد وإعلان واحد) لمنتج وصل فعليًا لقرار SCALE_CANDIDATE في مركز القرار الذكي — يعيد استخدام الكرييتيف والاستهداف الفائز المُثبت تلقائيًا (بدون رفع ميديا جديدة لو الكرييتيف مسجل على نفس الحساب الإعلاني). يرفض صراحة لو المنتج لسه مش فائز مثبت بالأدلة الحالية. ينشئ تاسك يظهر كارت معاينة موضّح فيه الكرييتيف/CPA/عدد المشتريات اللي اتبنى عليهم القرار. المستخدم لازم يوافق قبل أي إنشاء فعلي. قابل للاستدعاء أكتر من مرة في نفس المحادثة زي prepare_campaign.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج الحقيقي، لو معروف' },
        productName: { type: 'string', description: 'اسم المنتج لو productId مش معروف' },
        campaignName: { type: 'string', description: 'اختياري — افتراضي "<اسم المنتج> — Scale"' },
        websiteUrl: { type: 'string', description: 'رابط الموقع/صفحة المنتج — لازم من المستخدم، ممنوع تخترعه' },
        pageName: { type: 'string', description: 'بس لو المستخدم حدد صفحة معينة ردًا على سؤال الـ Tool' },
        pixelName: { type: 'string', description: 'بس لو المستخدم حدد Pixel معين ردًا على سؤال الـ Tool' },
        instagramUsername: { type: 'string', description: 'بس لو المستخدم حدد حساب إنستجرام معين ردًا على سؤال الـ Tool' },
        budgetEgp: { type: 'number', description: 'الميزانية اليومية بالجنيه للكامبين الجديد' },
        primaryText: { type: 'string', description: 'اختياري — لو مش موجود بيستخدم النص الفائز المثبت لو موجود' },
        headline: { type: 'string', description: 'اختياري — لو مش موجود بيستخدم العنوان الفائز المثبت لو موجود' },
      },
    },
  },
  {
    name: 'prepare_test',
    description: '[تجهيز — لا ينشئ أي كامبين فعليًا على Meta] يجهّز اختبار مُتحكَّم فيه (Controlled Test) لمنتج — يغيّر بُعد واحد بس (AUDIENCE: جمهور/فئة عمرية، أو GEO: محافظة) ويثبّت نفس الكرياتيف الفائز الحالي (بدون رفع جديد لو مسجل). استخدمه لما المستخدم يقول "اعمل الاختبار المقترح" أو يطلب اختبار جمهور/محافظة معينة صراحة. اختبار الكرياتيف نفسه (CREATIVE) لسه مش متاح من الشات. يرفض لو الاختبار ده اتجرب قبل كده وفشل (DOES_NOT_WORK) في ذاكرة التعلم. ينشئ تاسك كارت معاينة يوضّح المتغيّر اللي بيتغيّر والمتغيّرات الثابتة ومقياس النجاح — المستخدم لازم يوافق قبل أي إنشاء فعلي.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج الحقيقي، لو معروف' },
        productName: { type: 'string', description: 'اسم المنتج لو productId مش معروف' },
        testDimension: { type: 'string', enum: ['AUDIENCE', 'GEO'], description: 'البُعد المطلوب اختباره' },
        testValue: { type: 'string', description: 'قيمة الاختبار — لـAUDIENCE: فئة عمرية بصيغة Meta ("25-34"، "65+") أو "رجال"/"نساء"؛ لـGEO: اسم محافظة مصرية بالعربي' },
        campaignName: { type: 'string', description: 'اختياري — افتراضي "<اسم المنتج> — اختبار <البُعد> (<القيمة>)"' },
        websiteUrl: { type: 'string', description: 'رابط الموقع/صفحة المنتج — لازم من المستخدم، ممنوع تخترعه' },
        pageName: { type: 'string', description: 'بس لو المستخدم حدد صفحة معينة ردًا على سؤال الـ Tool' },
        pixelName: { type: 'string', description: 'بس لو المستخدم حدد Pixel معين ردًا على سؤال الـ Tool' },
        instagramUsername: { type: 'string', description: 'بس لو المستخدم حدد حساب إنستجرام معين ردًا على سؤال الـ Tool' },
        budgetEgp: { type: 'number', description: 'الميزانية اليومية بالجنيه — عادة أصغر من ميزانية Scale لأنه اختبار' },
        primaryText: { type: 'string' },
        headline: { type: 'string' },
      },
    },
  },
  {
    name: 'prepare_price_test',
    description: '[تجهيز — لا يغيّر السعر فعليًا] يجهّز اختبار سعر حقيقي لمنتج — يلتقط لقطة حقيقية من الأداء الحالي (CPA/تأكيد/تسليم/صافي ربح) كمرجع قبل أي تغيير، ثم يعرض السعر الحالي مقابل المقترح. التغيير الفعلي في قاعدة البيانات بيحصل بس بعد موافقة صريحة. استخدمه لما المستخدم يطلب اختبار سعر جديد صراحة — ممنوع تقترح رقم سعر من عندك، لازم ييجي من المستخدم.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج' },
        productName: { type: 'string', description: 'اسم المنتج لو productId مش معروف' },
        newPrice: { type: 'number', description: 'السعر الجديد المقترح — لازم ييجي من المستخدم صراحة' },
      },
      required: ['newPrice'],
    },
  },
  {
    name: 'generate_campaign_copy',
    description: '[قراءة فقط — لا يستخدم النص تلقائيًا] يكتب بوست/نص إعلاني مصري حقيقي (Primary Text, Headline, Hook, CTA) لمنتج معين، مع تصنيف أمان الادّعاءات. اعرضه على المستخدم كمسودة يوافق عليها قبل ما تحطه في prepare_campaign. لتحديد المنتج: ابعت productId لو معروف من سياق الصفحة، وإلا ابعت productName بالاسم اللي وصلك — من كلام المستخدم، أو من وصفك أنت للمنتج في صورة أرسلها (شوف الصورة واكتب اسم المنتج الظاهر فيها بوضوح، من غير ما تسأل المستخدم عن رقم). ممنوع تمامًا تطلب من المستخدم "رقم المنتج" — لو الأداة رجعت candidates، اسأله يختار بالاسم من القائمة دي فقط.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer', description: 'رقم المنتج، لو معروف بالفعل من سياق الصفحة' },
        productName: { type: 'string', description: 'اسم المنتج كما وصله المستخدم أو كما تراه في صورة مرفقة — استخدمه دايمًا لو مفيش productId جاهز' },
        angle: { type: 'string', description: 'زاوية تسويقية، اختياري (مثلًا: الخوف، الفضول، توفير الوقت، السعر)' },
        tone: { type: 'string', description: 'نبرة الكتابة، اختياري' },
      },
    },
  },
  {
    name: 'get_my_recent_tasks',
    description: '[قراءة فقط] يجيب آخر 5 تاسكات حقيقية للمستخدم الحالي وحالتها الفعلية (PLANNED/PREPARING/WAITING_FOR_APPROVAL/RUNNING/VERIFYING/COMPLETED/PARTIALLY_COMPLETED/FAILED/CANCELLED/BLOCKED). استخدمه دايمًا قبل الرد على أي سؤال زي "بتعمل إيه دلوقتي؟" أو "خلصت؟" — ممنوع تجاوب من الذاكرة.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_task_progress',
    description: '[قراءة فقط] لسؤال "فاضل إيه؟" أو "وقفت ليه؟" عن تاسك إطلاق/سكيل/اختبار معين — بيرجع تفصيل حقيقي لكل كامبين لسه شغال (وصل لفين: Ad Sets/Ads اتعملت)، أي كامبين محتاج تدخل يدوي وليه، ولو التاسك واقف من غير أي تحديث لفترة طويلة بيقول بصراحة إن الحالة الحقيقية "غير معروفة" (effectiveStatus=UNKNOWN) بدل ما يدّعي إنه لسه شغال أو إنه فشل من غير دليل.',
    input_schema: {
      type: 'object',
      properties: { taskUuid: { type: 'string', description: 'رقم التاسك الحقيقي (من get_my_recent_tasks)' } },
      required: ['taskUuid'],
    },
  },
  {
    name: 'retry_task',
    description: '[تجهيز/تنفيذ حسب الحالة] لطلب "جرب تاني" على تاسك فشل أو اتوقف. لو التاسك وصل لـ Meta فعلاً (فيه كامبينات جزئيًا شغالة)، بيعيد تشغيل بس الكامبينات اللي لسه مش خلصت من غير ما يلمس اللي خلص أو يكرر أي حاجة على Meta؛ لو فيه كامبين محتاج تدخل يدوي، بيقولك السبب الحقيقي بدل ما يحاول يتخطاه. لو التاسك فشل قبل ما يوصل لـ Meta خالص، بيعيد تجهيز نفس الخطة بنفس البيانات من الأول (تاسك جديد، محتاج موافقة جديدة).',
    input_schema: {
      type: 'object',
      properties: { taskUuid: { type: 'string', description: 'رقم التاسك الحقيقي (من get_my_recent_tasks)' } },
      required: ['taskUuid'],
    },
  },
  {
    name: 'cancel_task',
    description: '[تنفيذ فوري — إلغاء بس، لا يغيّر أي حاجة على Meta] لطلب "الغِ التاسك" أو "سيبها" — يلغي تاسك لسه في حالة غير نهائية (قبل التنفيذ أو محتاج موافقة). مينفعش يلغي تاسك خلص أو بيتنفذ فعليًا على Meta دلوقتي.',
    input_schema: {
      type: 'object',
      properties: { taskUuid: { type: 'string', description: 'رقم التاسك الحقيقي (من get_my_recent_tasks)' } },
      required: ['taskUuid'],
    },
  },
];

export const WRITE_TOOL_IMPLS = { prepare_bump, prepare_pause, prepare_resume, prepare_campaign, prepare_scale, prepare_test, prepare_price_test, generate_campaign_copy, get_my_recent_tasks, get_task_progress, retry_task, cancel_task };
