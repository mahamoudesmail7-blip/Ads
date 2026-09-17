// Campaign Launch Builder ("رفع الكامبين") — Phase B service skeleton.
//
// This file owns the launch-job state machine, idempotent job/campaign
// creation, and the per-object idempotency map that a LATER phase's real
// Meta-writing code will build on. NOTHING in this file calls Meta's Graph
// API — every function here is pure validation/state-transition logic or a
// plain Prisma read/write against the amb_launch_* tables added in this
// same phase's migration. Deliberately separate from cloneEngine.js's
// amb_clone_* tables (a launch job creates brand-new campaigns; a clone job
// copies an existing one) — see schema.prisma's header comment on
// AmbLaunchJob for the full rationale.
import { prisma } from '../../prisma.js';

export const JOB_STATUSES = ['DRAFT', 'VALIDATING', 'READY', 'PUBLISHING', 'PARTIAL', 'COMPLETE', 'FAILED', 'CANCELLED'];
export const CAMPAIGN_STATUSES = ['PENDING', 'QUEUED', 'PUBLISHING', 'CAMPAIGN_CREATED', 'ADSETS_CREATED', 'ADS_CREATED', 'COMPLETE', 'FAILED', 'CANCELLED'];
export const OBJECT_LEVELS = ['ADSET', 'AD', 'CREATIVE'];
export const OBJECT_STATUSES = ['PENDING', 'CREATED', 'FAILED', 'SKIPPED'];
export const VIDEO_STATUSES = ['PENDING', 'VALIDATING', 'UPLOADING', 'UPLOADED', 'FAILED'];

// Verified real Meta custom_event_type values (developers.facebook.com,
// checked 2026-09 against the current Graph API version this app uses,
// v21.0) — never invented, never the casual "InitiateCheckout"/"ViewContent"
// spelling. PURCHASE is the default for a normal e-commerce Sales campaign.
export const ALLOWED_CONVERSION_EVENTS = ['PURCHASE', 'INITIATED_CHECKOUT', 'ADD_TO_CART', 'CONTENT_VIEW'];
export const ALLOWED_PLATFORMS = ['facebook', 'instagram'];
export const ALLOWED_BUDGET_MODES = ['CBO', 'ABO'];

// Finite state machine — every legal transition, nothing else. Used by both
// this file and every later phase that moves a job/campaign forward, so an
// invalid jump (e.g. COMPLETE -> DRAFT, or skipping straight to PUBLISHING
// without READY) is refused at the data layer, not just by UI discipline.
const JOB_TRANSITIONS = {
  DRAFT: ['VALIDATING', 'CANCELLED'],
  VALIDATING: ['READY', 'DRAFT', 'FAILED', 'CANCELLED'],
  READY: ['PUBLISHING', 'DRAFT', 'CANCELLED'],
  PUBLISHING: ['PARTIAL', 'COMPLETE', 'FAILED'],
  PARTIAL: ['PUBLISHING', 'COMPLETE', 'FAILED'],
  COMPLETE: [],
  FAILED: ['PUBLISHING'], // retry re-enters PUBLISHING, never silently becomes COMPLETE
  CANCELLED: [],
};
const CAMPAIGN_TRANSITIONS = {
  PENDING: ['QUEUED', 'CANCELLED'],
  QUEUED: ['PUBLISHING', 'CANCELLED'],
  PUBLISHING: ['CAMPAIGN_CREATED', 'FAILED'],
  CAMPAIGN_CREATED: ['ADSETS_CREATED', 'FAILED'],
  ADSETS_CREATED: ['ADS_CREATED', 'FAILED'],
  ADS_CREATED: ['COMPLETE', 'FAILED'],
  COMPLETE: [],
  FAILED: ['PUBLISHING'], // resume-from-failure re-enters PUBLISHING; the object map decides what's actually re-created
  CANCELLED: [],
};

export function canTransitionJobStatus(from, to) {
  return Array.isArray(JOB_TRANSITIONS[from]) && JOB_TRANSITIONS[from].includes(to);
}
export function canTransitionCampaignStatus(from, to) {
  return Array.isArray(CAMPAIGN_TRANSITIONS[from]) && CAMPAIGN_TRANSITIONS[from].includes(to);
}

function fail(msg) {
  const e = new Error(msg);
  e.status = 400;
  throw e;
}

/**
 * Validates a wizard submission and returns the normalized shape this
 * service persists. Never touches Meta — purely a shape/range check, so a
 * bad submission fails fast and in Arabic before any DB write. A LATER
 * phase's real publish step re-validates everything server-side again
 * against live Meta state (an ad account/pixel/page id existing here just
 * means the wizard's own math is internally consistent, not that Meta will
 * accept it).
 */
export function validateLaunchConfig(input) {
  const cfg = input && typeof input === 'object' ? input : {};
  if (!cfg.adAccountId || typeof cfg.adAccountId !== 'string') fail('لازم تختار حساب إعلاني.');
  if (!ALLOWED_BUDGET_MODES.includes(cfg.budgetMode)) fail('نوع الميزانية لازم يكون CBO أو ABO.');
  if (!ALLOWED_CONVERSION_EVENTS.includes(cfg.conversionEvent || 'PURCHASE')) fail('حدث التحويل غير مدعوم.');

  const platforms = Array.isArray(cfg.platforms) && cfg.platforms.length ? cfg.platforms : ['facebook', 'instagram'];
  if (!platforms.every((p) => ALLOWED_PLATFORMS.includes(p))) fail('المنصات المسموح بها فيسبوك وإنستجرام فقط في هذه النسخة.');

  const adSetsPerCampaign = Number(cfg.adSetsPerCampaign);
  if (!Number.isInteger(adSetsPerCampaign) || adSetsPerCampaign < 1) fail('عدد الـ Ad Sets لازم يكون رقم صحيح 1 أو أكتر.');
  const adsPerAdSet = Number(cfg.adsPerAdSet);
  if (!Number.isInteger(adsPerAdSet) || adsPerAdSet < 1) fail('عدد الإعلانات داخل كل Ad Set لازم يكون رقم صحيح 1 أو أكتر.');

  const campaigns = Array.isArray(cfg.campaigns) ? cfg.campaigns : [];
  const campaignCount = Number(cfg.campaignCount) || campaigns.length;
  if (!Number.isInteger(campaignCount) || campaignCount < 1 || campaignCount > 10) fail('عدد الكامبينات لازم يكون بين 1 و 10.');
  if (campaigns.length !== campaignCount) fail('عدد بيانات الكامبينات المُرسلة لا يطابق عدد الكامبينات المطلوب.');
  for (const [i, c] of campaigns.entries()) {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) fail(`اسم الكامبين رقم ${i + 1} مطلوب.`);
    if (!c.websiteUrl || typeof c.websiteUrl !== 'string') fail(`رابط الموقع للكامبين "${c.name || i + 1}" مطلوب.`);
    try { const u = new URL(c.websiteUrl); if (!/^https?:$/.test(u.protocol)) throw new Error('bad'); } catch { fail(`رابط الموقع للكامبين "${c.name || i + 1}" غير صالح.`); }
  }

  const perCampaignPixel = cfg.perCampaignPixel === true;
  if (!perCampaignPixel && !cfg.pixelId) fail('لازم تختار Meta Pixel.');
  if (perCampaignPixel && campaigns.some((c) => !c.pixelId)) fail('في وضع "بيكسل مختلف لكل Campaign" لازم كل كامبين يكون له Pixel محدد.');

  if (cfg.budgetMode === 'CBO') {
    const dailyMinor = Number(cfg.budget?.cbo?.dailyBudgetMinor);
    if (!Number.isFinite(dailyMinor) || dailyMinor <= 0) fail('ميزانية الكامبين اليومية (CBO) مطلوبة ولازم تكون أكبر من صفر.');
  } else {
    const adSets = cfg.budget?.abo?.adSets;
    if (!Array.isArray(adSets) || adSets.length !== adSetsPerCampaign) fail('لازم تحدد ميزانية لكل Ad Set في وضع ABO.');
    for (const [i, a] of adSets.entries()) {
      if (!Number.isFinite(Number(a?.dailyBudgetMinor)) || Number(a.dailyBudgetMinor) <= 0) fail(`ميزانية الـ Ad Set رقم ${i + 1} مطلوبة ولازم تكون أكبر من صفر.`);
    }
  }

  const startMode = cfg.startMode === 'NOW' ? 'NOW' : 'SCHEDULED';
  let startAt = null;
  if (startMode === 'SCHEDULED') {
    if (!cfg.startAt) fail('لازم تحدد تاريخ ووقت بدء الاختبار، أو تختار "تشغيل الآن".');
    startAt = new Date(cfg.startAt);
    if (Number.isNaN(startAt.getTime())) fail('تاريخ/وقت البدء غير صالح.');
  }

  return {
    adAccountId: cfg.adAccountId,
    adAccountName: cfg.adAccountName || null,
    pageId: cfg.pageId || null,
    pageName: cfg.pageName || null,
    instagramId: cfg.instagramId || null,
    instagramUsername: cfg.instagramUsername || null,
    objective: cfg.objective || 'OUTCOME_SALES',
    budgetMode: cfg.budgetMode,
    pixelId: cfg.pixelId || null,
    pixelName: cfg.pixelName || null,
    conversionEvent: cfg.conversionEvent || 'PURCHASE',
    perCampaignPixel,
    platforms,
    adSetsPerCampaign,
    adsPerAdSet,
    campaignCount,
    startMode,
    startAt,
    timezone: cfg.timezone || 'Africa/Cairo',
    campaigns: campaigns.map((c, i) => ({
      index: i,
      name: String(c.name).trim(),
      pixelId: perCampaignPixel ? c.pixelId : null,
      pixelName: perCampaignPixel ? (c.pixelName || null) : null,
      primaryText: c.primaryText || null,
      headline: c.headline || null,
      websiteUrl: c.websiteUrl,
    })),
    // Kept verbatim inside config_json for the phase that builds the actual
    // Meta payloads — budget amounts, CTA, and video-to-adset/ad slot plan
    // don't need their own typed columns to be usable/idempotent.
    raw: {
      budget: cfg.budget || null,
      cta: cfg.cta || 'ORDER_NOW',
      videoPlan: cfg.videoPlan || null,
    },
  };
}

/**
 * Idempotent by jobId — a double-click, a refreshed page re-submitting the
 * same wizard state, or a resumed session all land here with the SAME
 * client-generated jobId and get back the exact same job untouched, never a
 * second row. Only a genuinely new jobId creates anything.
 */
export async function createDraftJob({ jobId, userId, input }) {
  if (!jobId || typeof jobId !== 'string' || !/^[a-z0-9_-]{8,80}$/i.test(jobId)) fail('jobId غير صالح.');

  const existing = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId }, include: { campaigns: true } });
  if (existing) return existing;

  const v = validateLaunchConfig(input);

  return prisma.$transaction(async (tx) => {
    const job = await tx.ambLaunchJob.create({
      data: {
        job_id: jobId,
        ad_account_id: v.adAccountId,
        ad_account_name: v.adAccountName,
        page_id: v.pageId,
        page_name: v.pageName,
        instagram_id: v.instagramId,
        instagram_username: v.instagramUsername,
        objective: v.objective,
        budget_mode: v.budgetMode,
        pixel_id: v.pixelId,
        pixel_name: v.pixelName,
        conversion_event: v.conversionEvent,
        per_campaign_pixel: v.perCampaignPixel,
        platforms_json: JSON.stringify(v.platforms),
        ad_sets_per_campaign: v.adSetsPerCampaign,
        ads_per_ad_set: v.adsPerAdSet,
        campaign_count: v.campaignCount,
        start_mode: v.startMode,
        start_at: v.startAt,
        timezone: v.timezone,
        config_json: JSON.stringify(v.raw),
        status: 'DRAFT',
        created_by_id: userId || null,
      },
    });
    for (const c of v.campaigns) {
      await tx.ambLaunchCampaign.create({
        data: {
          job_id: job.job_id,
          index: c.index,
          name: c.name,
          pixel_id: c.pixelId,
          pixel_name: c.pixelName,
          primary_text: c.primaryText,
          headline: c.headline,
          website_url: c.websiteUrl,
          status: 'PENDING',
        },
      });
    }
    await tx.ambLaunchAudit.create({
      data: { job_id: job.job_id, event: 'JOB_CREATED', actor_id: userId || null, detail: `تم إنشاء طلب رفع كامبين بـ ${v.campaignCount} كامبين(ات).` },
    });
    return tx.ambLaunchJob.findUnique({ where: { job_id: job.job_id }, include: { campaigns: { orderBy: { index: 'asc' } } } });
  });
}

export async function getJob(jobId) {
  return prisma.ambLaunchJob.findUnique({
    where: { job_id: jobId },
    include: {
      campaigns: { orderBy: { index: 'asc' }, include: { objects: true } },
      videos: { orderBy: { slot_key: 'asc' } },
      audits: { orderBy: { created_at: 'desc' }, take: 100 },
    },
  });
}

export async function listJobs({ limit = 25, cursor } = {}) {
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return prisma.ambLaunchJob.findMany({
    take,
    ...(cursor ? { skip: 1, cursor: { id: Number(cursor) } } : {}),
    orderBy: { created_at: 'desc' },
    include: { campaigns: { select: { id: true, status: true } } },
  });
}

/** Only allowed before publishing has actually started — matches the spec's own "Cancel" rule (never touches anything already created on Meta). */
export async function cancelJob(jobId, userId) {
  const job = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId } });
  if (!job) fail('طلب الرفع غير موجود.');
  if (!canTransitionJobStatus(job.status, 'CANCELLED')) fail(`لا يمكن إلغاء الطلب وهو في حالة ${job.status}.`);

  return prisma.$transaction(async (tx) => {
    await tx.ambLaunchJob.update({ where: { job_id: jobId }, data: { status: 'CANCELLED' } });
    await tx.ambLaunchCampaign.updateMany({ where: { job_id: jobId, status: { in: ['PENDING', 'QUEUED'] } }, data: { status: 'CANCELLED' } });
    await tx.ambLaunchAudit.create({ data: { job_id: jobId, event: 'CANCELLED', actor_id: userId || null } });
    return tx.ambLaunchJob.findUnique({ where: { job_id: jobId } });
  });
}

/**
 * Idempotency foundation for the phase that actually creates Meta objects:
 * before creating an ad set/ad/creative, call this first. If a row already
 * exists (any status), return it — the caller checks `.status === 'CREATED'`
 * to decide whether to skip re-creating it. Never silently overwrites an
 * existing row's destination_id.
 */
export async function getOrCreateObjectMapRow({ campaignId, level, localKey, parentLocalKey = null }) {
  if (!OBJECT_LEVELS.includes(level)) fail(`مستوى غير معروف: ${level}`);
  const existing = await prisma.ambLaunchObjectMap.findUnique({ where: { campaign_id_level_local_key: { campaign_id: campaignId, level, local_key: localKey } } });
  if (existing) return existing;
  return prisma.ambLaunchObjectMap.create({ data: { campaign_id: campaignId, level, local_key: localKey, parent_local_key: parentLocalKey, status: 'PENDING' } });
}

export async function markObjectResult({ campaignId, level, localKey, destinationId = null, status, error = null, payload = null }) {
  if (!OBJECT_STATUSES.includes(status)) fail(`حالة غير معروفة: ${status}`);
  const row = await prisma.ambLaunchObjectMap.update({
    where: { campaign_id_level_local_key: { campaign_id: campaignId, level, local_key: localKey } },
    data: { destination_id: destinationId, status, error, payload_json: payload ? JSON.stringify(payload) : undefined },
  });
  await prisma.ambLaunchAudit.create({
    data: {
      job_id: (await prisma.ambLaunchCampaign.findUnique({ where: { id: campaignId }, select: { job_id: true } })).job_id,
      campaign_id: campaignId,
      event: status === 'CREATED' ? 'OBJECT_CREATED' : 'OBJECT_FAILED',
      level,
      local_key: localKey,
      destination_id: destinationId,
      detail: error || undefined,
    },
  });
  return row;
}

/**
 * Idempotent by (job_id, slot_key) — re-registering the same slot (e.g. a
 * retried upload) never creates a duplicate row. Flags a same-job duplicate
 * upload by content hash so a later phase can reuse one Meta video_id
 * instead of uploading the identical file twice (spec's own dedup + "upload
 * once, reuse" requirements), without deciding that policy here.
 */
export async function registerVideoSlot({ jobId, slotKey, originalFilename, contentHash = null, sizeBytes = null, mimeType = null }) {
  const existing = await prisma.ambLaunchVideoAsset.findUnique({ where: { job_id_slot_key: { job_id: jobId, slot_key: slotKey } } });
  const row = existing || await prisma.ambLaunchVideoAsset.create({
    data: { job_id: jobId, slot_key: slotKey, original_filename: originalFilename, content_hash: contentHash, size_bytes: sizeBytes, mime_type: mimeType, status: 'PENDING' },
  });
  let duplicateOfSlotKey = null;
  if (contentHash) {
    const dup = await prisma.ambLaunchVideoAsset.findFirst({ where: { job_id: jobId, content_hash: contentHash, slot_key: { not: slotKey } }, orderBy: { id: 'asc' } });
    if (dup) duplicateOfSlotKey = dup.slot_key;
  }
  return { row, duplicateOfSlotKey };
}

export async function markVideoResult({ jobId, slotKey, status, metaVideoId = null, error = null }) {
  if (!VIDEO_STATUSES.includes(status)) fail(`حالة غير معروفة: ${status}`);
  return prisma.ambLaunchVideoAsset.update({
    where: { job_id_slot_key: { job_id: jobId, slot_key: slotKey } },
    data: { status, meta_video_id: metaVideoId, error },
  });
}
