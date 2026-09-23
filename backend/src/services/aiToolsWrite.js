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
import { checkEntityForPauseResume, findOrCreatePauseResumeRecommendation } from './assistantTasks/pauseResumePrepare.js';
import { resolveMultiGeoTargeting, requireAdAccount, autoResolveAccountAssets, resolveProduct, createDraftJob, getJob } from './assistantTasks/launchCampaignPrepare.js';
import { loadWinningStackForProduct, resolveWinningCreativeAsset } from './assistantTasks/scalePrepare.js';
import { registerVideoSlot, markVideoResult, registerImageSlot, markImageResult } from './amb/launchBuilder.js';
import { createTask, transitionTask, patchTask, failTaskSafely, enterWaitingForApproval, findActiveTaskForEntity, findActiveTaskForUserKind, listRecentTasksForUser, resolveTaskStatus } from './assistantTasks/taskEngine.js';
import { prisma } from '../prisma.js';

export const WRITE_TOOL_META = {
  prepare_bump: { tier: 'PREPARE', requiresApproval: true, writesToMeta: false },
  prepare_pause: { tier: 'PREPARE', requiresApproval: true, writesToMeta: false },
  prepare_resume: { tier: 'PREPARE', requiresApproval: true, writesToMeta: false },
  prepare_campaign: { tier: 'PREPARE', requiresApproval: true, writesToMeta: false },
  prepare_scale: { tier: 'PREPARE', requiresApproval: true, writesToMeta: false },
  generate_campaign_copy: { tier: 'READ', requiresApproval: false, writesToMeta: false },
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
      sourceWinner: { assetId: winStack.creativeAssetId, label: winStack.creativeLabel, cpa: winStack.creativeCpa, purchases: winStack.creativePurchases, reusedFromMediaLibrary: reusedAsset },
    };

    const finalTask = await enterWaitingForApproval({ taskId: taskUuid, ambRecommendationId: null, preparedPayload: preview, actionType: 'SCALE_CAMPAIGN', recUpdatedAt: null });
    return { ok: true, task: (await resolveTaskStatus({ taskId: finalTask.task_uuid })).task };
  } catch (err) {
    if (taskUuid) await failTaskSafely({ taskId: taskUuid, error: err });
    return { ok: false, error: err.message };
  }
}

export async function generate_campaign_copy({ productId, angle, tone } = {}) {
  try {
    if (!productId) return { ok: false, error: 'productId مطلوب.' };
    const product = await prisma.product.findUnique({ where: { id: Number(productId) }, select: { product_name: true } });
    if (!product) return { ok: false, error: 'المنتج غير موجود.' };
    const { generatePost } = await import('./amb/productMarketingAI.js');
    const res = await generatePost({ productName: product.product_name, angle, tone });
    if (!res.ok) return { ok: false, error: res.reason };
    return { ok: true, post: res.post };
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
    name: 'generate_campaign_copy',
    description: '[قراءة فقط — لا يستخدم النص تلقائيًا] يكتب نص إعلاني مصري حقيقي (Primary Text, Headline, Hook, CTA) لمنتج معين، مع تصنيف أمان الادّعاءات. اعرضه على المستخدم كمسودة يوافق عليها قبل ما تحطه في prepare_campaign.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'integer' },
        angle: { type: 'string', description: 'زاوية تسويقية، اختياري' },
        tone: { type: 'string', description: 'نبرة الكتابة، اختياري' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'get_my_recent_tasks',
    description: '[قراءة فقط] يجيب آخر 5 تاسكات حقيقية للمستخدم الحالي وحالتها الفعلية (PLANNED/PREPARING/WAITING_FOR_APPROVAL/RUNNING/VERIFYING/COMPLETED/PARTIALLY_COMPLETED/FAILED/CANCELLED/BLOCKED). استخدمه دايمًا قبل الرد على أي سؤال زي "بتعمل إيه دلوقتي؟" أو "خلصت؟" — ممنوع تجاوب من الذاكرة.',
    input_schema: { type: 'object', properties: {} },
  },
];

export const WRITE_TOOL_IMPLS = { prepare_bump, prepare_pause, prepare_resume, prepare_campaign, prepare_scale, generate_campaign_copy, get_my_recent_tasks };
