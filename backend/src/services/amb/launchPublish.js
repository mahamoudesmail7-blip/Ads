// Campaign Launch Builder — Phase F/G: real Meta writes. Creates real
// Campaign/AdSet/AdCreative/Ad objects on Meta from a finalized
// AmbLaunchJob, always PAUSED on create (never activated here — activation
// is a distinct, later, explicit action this file does not perform).
// Idempotent via the AmbLaunchObjectMap pattern Phase B built for exactly
// this purpose: every object is looked up by its deterministic local_key
// before creating anything, so a retry, a resumed session, or a Railway
// restart never creates a duplicate Meta object.
//
// publishSingleTestItem() — the narrow 1/1/1/1 controlled safety test
// (Phase F, already run for real against job bfad0a63's Campaign 1).
// publishCampaignFull() — the general per-campaign engine (Phase G): every
// ad set/ad the job's own persisted config calls for, resuming correctly
// from whatever a previous partial run already created (e.g. Campaign 1's
// first ad set/ad from the Phase F test — never recreated).
// runDueLaunchQueueTick() — the durable, DB-backed multi-campaign queue:
// campaign N+1 never starts until campaign N reaches COMPLETE AND the
// 5-minute gate (AmbLaunchJob.next_campaign_at, a plain column, not an
// in-process timer) has passed. Wired into launchScheduler.js exactly like
// cloneScheduler.js's existing 60s tick — survives a Railway restart.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { requireLaunchToken, getMetaVideoThumbnailUrl } from './launchVideoUpload.js';
import { createCampaign, createAdSet, createAdCreative, createAd, getEntityLive } from '../metaGraphClient.js';
import { getOrCreateObjectMapRow, markObjectResult, canTransitionCampaignStatus, canTransitionJobStatus } from './launchBuilder.js';

function fail(msg) { const e = new Error(msg); e.status = 400; throw e; }

// ---------------------------------------------------------------------------
// Status transition helpers — thin wrappers around the Phase B state
// machines so every write here goes through the same adjacency checks
// everything else does. advanceCampaignStatus walks forward one legal step
// at a time (never skips, never regresses) so a resume from any point
// (including straight after a FAILED run) always lands on a valid status.
// ---------------------------------------------------------------------------
const CAMPAIGN_STATUS_ORDER = ['PENDING', 'QUEUED', 'PUBLISHING', 'CAMPAIGN_CREATED', 'ADSETS_CREATED', 'ADS_CREATED', 'COMPLETE'];

async function setCampaignStatus(campaignId, status) {
  const row = await prisma.ambLaunchCampaign.findUnique({ where: { id: campaignId } });
  if (!row || row.status === status) return;
  if (!canTransitionCampaignStatus(row.status, status)) return; // never force an invalid jump — leave the row honestly where it is
  await prisma.ambLaunchCampaign.update({ where: { id: campaignId }, data: { status } });
}
/** Only ever moves a campaign FORWARD along the normal progress order — safe to call repeatedly with the same or an already-passed target (a no-op then). */
async function advanceCampaignStatus(campaignId, targetStatus) {
  const row = await prisma.ambLaunchCampaign.findUnique({ where: { id: campaignId } });
  if (!row) return;
  const curIdx = CAMPAIGN_STATUS_ORDER.indexOf(row.status);
  const targetIdx = CAMPAIGN_STATUS_ORDER.indexOf(targetStatus);
  if (curIdx === -1 || targetIdx === -1 || targetIdx <= curIdx) return;
  let cur = row.status;
  for (let i = curIdx + 1; i <= targetIdx; i++) {
    const next = CAMPAIGN_STATUS_ORDER[i];
    if (!canTransitionCampaignStatus(cur, next)) break;
    await prisma.ambLaunchCampaign.update({ where: { id: campaignId }, data: { status: next } });
    cur = next;
  }
}
/** Gets a campaign into PUBLISHING from wherever it currently is (PENDING, QUEUED, or a resumed FAILED) without ever attempting an invalid jump. A campaign already past PUBLISHING (CAMPAIGN_CREATED or later) is left alone — it's mid-flight, not starting fresh. */
async function ensurePublishingStatus(campaignId) {
  const row = await prisma.ambLaunchCampaign.findUnique({ where: { id: campaignId } });
  if (!row) return;
  if (row.status === 'PENDING') { await setCampaignStatus(campaignId, 'QUEUED'); await setCampaignStatus(campaignId, 'PUBLISHING'); return; }
  if (row.status === 'QUEUED' || row.status === 'FAILED') { await setCampaignStatus(campaignId, 'PUBLISHING'); return; }
  // PUBLISHING/CAMPAIGN_CREATED/ADSETS_CREATED/ADS_CREATED/COMPLETE — already there or past it, nothing to do.
}

export async function setJobStatus(jobId, status) {
  const row = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId } });
  if (!row || row.status === status) return;
  if (!canTransitionJobStatus(row.status, status)) return;
  await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { status } });
}

// ---------------------------------------------------------------------------
// Payload builders — every field here was verified against either Meta's
// own documentation or (for the three marked below) a REAL rejection from
// Meta during Phase F development, never guessed.
// ---------------------------------------------------------------------------

/** Minimal valid targeting for a fresh (non-cloned) ad set — geo_locations is the one genuinely required field; age/gender/interests are deliberately left unset (Meta's own broad Advantage+ default) since the wizard never collected them. Country fixed to Egypt to match this business. */
export function buildTargeting(job) {
  const platforms = JSON.parse(job.platforms_json || '["facebook"]');
  return {
    geo_locations: { countries: ['EG'] },
    publisher_platforms: platforms,
  };
}

export function buildCampaignPayload(job, campaign) {
  const payload = {
    name: campaign.name,
    objective: job.objective || 'OUTCOME_SALES',
    status: 'PAUSED',
    special_ad_categories: [],
    buying_type: 'AUCTION',
  };
  if (job.budget_mode === 'CBO') {
    const cfg = JSON.parse(job.config_json || '{}');
    const minor = cfg.budget?.cbo?.dailyBudgetMinor;
    if (minor > 0) payload.daily_budget = minor;
  } else {
    // ABO — Meta REJECTS campaign creation without this whenever the campaign itself carries no
    // budget (confirmed live, Phase F). false = ad sets never share budget, matching this
    // wizard's own independent per-ad-set budget amounts, which never offered a sharing opt-in.
    payload.is_adset_budget_sharing_enabled = false;
  }
  return payload;
}

export function buildAdSetPayload(job, campaign, metaCampaignId, adSetIndex, dailyBudgetMinor) {
  const payload = {
    name: `${campaign.name} - Ad Set ${adSetIndex + 1}`,
    campaign_id: metaCampaignId,
    status: 'PAUSED',
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'OFFSITE_CONVERSIONS',
    // Confirmed live (Phase F): this ad account's default bid strategy requires an explicit bid
    // amount/constraint unless told otherwise. LOWEST_COST_WITHOUT_CAP = Meta's auction fully
    // automatic, no manual cap, the simplest valid strategy needing no extra bid_amount/roas field.
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    promoted_object: { pixel_id: campaign.pixel_id || job.pixel_id, custom_event_type: job.conversion_event || 'PURCHASE' },
    targeting: buildTargeting(job),
  };
  if (job.budget_mode === 'ABO' && dailyBudgetMinor > 0) payload.daily_budget = dailyBudgetMinor;
  if (job.start_mode === 'SCHEDULED' && job.start_at && job.start_at.getTime() > Date.now()) {
    payload.start_time = job.start_at.toISOString();
  }
  return payload;
}

export function buildCreativePayload(job, campaign, adSetIndex, adIndex, videoId, thumbnailUrl) {
  const cfg = JSON.parse(job.config_json || '{}');
  return {
    name: `${campaign.name} - Creative ${adSetIndex + 1}.${adIndex + 1}`,
    object_story_spec: {
      page_id: job.page_id,
      video_data: {
        video_id: videoId,
        image_url: thumbnailUrl, // required by Meta (confirmed live, Phase F: "Your ad needs a video thumbnail") — reused from the video's own Meta-auto-generated picture, never a fabricated/external image
        message: campaign.primary_text || undefined,
        title: campaign.headline || undefined,
        call_to_action: { type: cfg.cta || 'ORDER_NOW', value: { link: campaign.website_url } },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Per-object "ensure it exists" primitives — idempotent, shared by both the
// single-item test and the full campaign engine below. Each one: looks up
// (or creates) its AmbLaunchObjectMap row, does nothing further if that row
// already shows CREATED (the real resumability guarantee), otherwise calls
// Meta once and persists the result immediately.
// ---------------------------------------------------------------------------

async function ensureCampaign({ job, campaign, token, audit }) {
  if (campaign.meta_campaign_id) return campaign.meta_campaign_id;
  await ensurePublishingStatus(campaign.id);
  const payload = buildCampaignPayload(job, campaign);
  const res = await createCampaign(token, job.ad_account_id, payload);
  await prisma.ambLaunchCampaign.update({ where: { id: campaign.id }, data: { meta_campaign_id: res.id } });
  await advanceCampaignStatus(campaign.id, 'CAMPAIGN_CREATED');
  await audit('CAMPAIGN_CREATED', `تم إنشاء الكامبين PAUSED: ${campaign.name}`, { metaCampaignId: res.id, payload });
  return res.id;
}

async function ensureAdSet({ job, campaign, metaCampaignId, adSetIndex, token, audit }) {
  const localKey = `adset:${adSetIndex}`;
  const row = await getOrCreateObjectMapRow({ campaignId: campaign.id, level: 'ADSET', localKey });
  if (row.status === 'CREATED') return row.destination_id;
  const cfg = JSON.parse(job.config_json || '{}');
  const dailyBudgetMinor = cfg.budget?.abo?.adSets?.[adSetIndex]?.dailyBudgetMinor || null;
  const payload = buildAdSetPayload(job, campaign, metaCampaignId, adSetIndex, dailyBudgetMinor);
  try {
    const res = await createAdSet(token, job.ad_account_id, payload);
    await markObjectResult({ campaignId: campaign.id, level: 'ADSET', localKey, destinationId: res.id, status: 'CREATED', payload });
    await audit('OBJECT_CREATED', `Ad Set ${adSetIndex + 1} PAUSED`, { level: 'ADSET', metaAdSetId: res.id, payload });
    return res.id;
  } catch (err) {
    await markObjectResult({ campaignId: campaign.id, level: 'ADSET', localKey, status: 'FAILED', error: err.message });
    await audit('OBJECT_FAILED', err.message, { level: 'ADSET', localKey });
    throw err;
  }
}

async function ensureCreative({ job, campaign, adSetIndex, adIndex, video, token, audit }) {
  const localKey = `creative:${adSetIndex}:${adIndex}`;
  const row = await getOrCreateObjectMapRow({ campaignId: campaign.id, level: 'CREATIVE', localKey, parentLocalKey: `adset:${adSetIndex}` });
  if (row.status === 'CREATED') return row.destination_id;
  const thumbnailUrl = await getMetaVideoThumbnailUrl(token, video.meta_video_id);
  if (!thumbnailUrl) { const e = new Error(`فيديو ${video.slot_key} لسه مفيهوش صورة مصغّرة جاهزة من Meta — جرب تاني بعد شوية.`); e.status = 409; throw e; }
  const payload = buildCreativePayload(job, campaign, adSetIndex, adIndex, video.meta_video_id, thumbnailUrl);
  try {
    const res = await createAdCreative(token, job.ad_account_id, payload);
    await markObjectResult({ campaignId: campaign.id, level: 'CREATIVE', localKey, destinationId: res.id, status: 'CREATED', payload });
    await audit('OBJECT_CREATED', `Creative ${adSetIndex + 1}.${adIndex + 1} — فيديو ${video.slot_key} (${video.meta_video_id})`, { level: 'CREATIVE', metaCreativeId: res.id, payload });
    return res.id;
  } catch (err) {
    await markObjectResult({ campaignId: campaign.id, level: 'CREATIVE', localKey, status: 'FAILED', error: err.message });
    await audit('OBJECT_FAILED', err.message, { level: 'CREATIVE', localKey });
    throw err;
  }
}

async function ensureAd({ job, campaign, metaAdSetId, metaCreativeId, adSetIndex, adIndex, token, audit }) {
  const localKey = `ad:${adSetIndex}:${adIndex}`;
  const row = await getOrCreateObjectMapRow({ campaignId: campaign.id, level: 'AD', localKey, parentLocalKey: `adset:${adSetIndex}` });
  if (row.status === 'CREATED') return row.destination_id;
  const payload = { name: `${campaign.name} - Ad ${adSetIndex + 1}.${adIndex + 1}`, adset_id: metaAdSetId, creative: { creative_id: metaCreativeId }, status: 'PAUSED' };
  try {
    const res = await createAd(token, job.ad_account_id, payload);
    await markObjectResult({ campaignId: campaign.id, level: 'AD', localKey, destinationId: res.id, status: 'CREATED', payload });
    await audit('OBJECT_CREATED', `Ad ${adSetIndex + 1}.${adIndex + 1} PAUSED`, { level: 'AD', metaAdId: res.id, payload });
    return res.id;
  } catch (err) {
    await markObjectResult({ campaignId: campaign.id, level: 'AD', localKey, status: 'FAILED', error: err.message });
    await audit('OBJECT_FAILED', err.message, { level: 'AD', localKey });
    throw err;
  }
}

/**
 * The narrow, explicit "controlled safety test": exactly 1 campaign -> 1 ad
 * set -> 1 creative (an already-uploaded real video) -> 1 ad, all PAUSED.
 * This is the exact function real-tested against job bfad0a63's Campaign 1
 * during Phase F. Kept as a thin, explicit wrapper over the same ensure*
 * primitives publishCampaignFull uses below, for any future one-off check.
 */
export async function publishSingleTestItem({ jobId, campaignIndex = 0, videoSlotKey }) {
  const job = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId }, include: { campaigns: { orderBy: { index: 'asc' } } } });
  if (!job) fail('طلب الرفع غير موجود.');
  const campaign = job.campaigns.find((c) => c.index === campaignIndex);
  if (!campaign) fail(`الكامبين رقم ${campaignIndex} غير موجود في هذا الطلب.`);
  if (!job.page_id) fail('لازم Facebook Page محدد قبل النشر.');
  if (!(campaign.pixel_id || job.pixel_id)) fail('لازم Meta Pixel محدد قبل النشر.');

  const video = videoSlotKey
    ? await prisma.ambLaunchVideoAsset.findUnique({ where: { job_id_slot_key: { job_id: jobId, slot_key: videoSlotKey } } })
    : await prisma.ambLaunchVideoAsset.findFirst({ where: { job_id: jobId, status: 'UPLOADED' }, orderBy: { slot_key: 'asc' } });
  if (!video || video.status !== 'UPLOADED' || !video.meta_video_id) fail('مفيش فيديو مرفوع وجاهز (UPLOADED) في هذا الطلب لاستخدامه في الاختبار.');

  const token = await requireLaunchToken();
  const audit = async (event, detail, extra = {}) => prisma.ambLaunchAudit.create({ data: { job_id: jobId, campaign_id: campaign.id, event, detail, data_json: JSON.stringify(extra) } });

  const metaCampaignId = await ensureCampaign({ job, campaign, token, audit });
  const metaAdSetId = await ensureAdSet({ job, campaign, metaCampaignId, adSetIndex: 0, token, audit });
  const metaCreativeId = await ensureCreative({ job, campaign, adSetIndex: 0, adIndex: 0, video, token, audit });
  const metaAdId = await ensureAd({ job, campaign, metaAdSetId, metaCreativeId, adSetIndex: 0, adIndex: 0, token, audit });

  const [campaignLive, adSetLive, adLive] = await Promise.all([
    getEntityLive(token, metaCampaignId), getEntityLive(token, metaAdSetId), getEntityLive(token, metaAdId),
  ]);
  return { jobId, campaignIndex, videoSlotKey: video.slot_key, videoId: video.meta_video_id, metaCampaignId, metaAdSetId, metaCreativeId, metaAdId, live: { campaign: campaignLive, adSet: adSetLive, ad: adLive } };
}

/**
 * The FULL per-campaign engine (Phase G): creates every ad set and ad the
 * job's own persisted config calls for (job.ad_sets_per_campaign x
 * job.ads_per_ad_set), resuming correctly from whatever a previous partial
 * run already created — including Campaign 1's Phase F test objects, which
 * are found already CREATED and never recreated. Videos are assigned
 * round-robin across the job's uploaded videos using a job-wide index, so a
 * job with more ad slots than videos reuses videos rather than failing.
 * Throws (never silently swallows) on the first object that fails to
 * create — the campaign is left exactly where it got to, safely resumable.
 */
export async function publishCampaignFull({ jobId, campaignIndex }) {
  const job = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId }, include: { campaigns: { orderBy: { index: 'asc' } } } });
  if (!job) fail('طلب الرفع غير موجود.');
  const campaign = job.campaigns.find((c) => c.index === campaignIndex);
  if (!campaign) fail(`الكامبين رقم ${campaignIndex} غير موجود في هذا الطلب.`);
  if (campaign.status === 'COMPLETE') return { alreadyComplete: true, campaignIndex };
  if (!job.page_id) fail('لازم Facebook Page محدد قبل النشر.');
  if (!(campaign.pixel_id || job.pixel_id)) fail('لازم Meta Pixel محدد قبل النشر.');

  const videos = await prisma.ambLaunchVideoAsset.findMany({ where: { job_id: jobId, status: 'UPLOADED' }, orderBy: { slot_key: 'asc' } });
  if (!videos.length) fail('مفيش فيديوهات مرفوعة وجاهزة (UPLOADED) في هذا الطلب.');

  const token = await requireLaunchToken();
  const audit = async (event, detail, extra = {}) => prisma.ambLaunchAudit.create({ data: { job_id: jobId, campaign_id: campaign.id, event, detail, data_json: JSON.stringify(extra) } });

  try {
    const metaCampaignId = await ensureCampaign({ job, campaign, token, audit });

    for (let adSetIndex = 0; adSetIndex < job.ad_sets_per_campaign; adSetIndex++) {
      const metaAdSetId = await ensureAdSet({ job, campaign, metaCampaignId, adSetIndex, token, audit });
      await advanceCampaignStatus(campaign.id, 'ADSETS_CREATED');
      for (let adIndex = 0; adIndex < job.ads_per_ad_set; adIndex++) {
        const globalAdIndex = campaignIndex * job.ad_sets_per_campaign * job.ads_per_ad_set + adSetIndex * job.ads_per_ad_set + adIndex;
        const video = videos[globalAdIndex % videos.length];
        const metaCreativeId = await ensureCreative({ job, campaign, adSetIndex, adIndex, video, token, audit });
        await ensureAd({ job, campaign, metaAdSetId, metaCreativeId, adSetIndex, adIndex, token, audit });
        await advanceCampaignStatus(campaign.id, 'ADS_CREATED');
      }
    }

    // Live verification straight from Meta before declaring COMPLETE — never trust our own DB alone.
    const objects = await prisma.ambLaunchObjectMap.findMany({ where: { campaign_id: campaign.id } });
    const adRows = objects.filter((o) => o.level === 'AD' && o.status === 'CREATED');
    const liveAds = await Promise.all(adRows.map((r) => getEntityLive(token, r.destination_id)));
    const allPaused = liveAds.every((a) => a?.status === 'PAUSED');
    if (!allPaused) { const e = new Error('بعض الإعلانات لم تُتحقق كـ PAUSED فعليًا على Meta بعد الإنشاء.'); e.status = 409; throw e; }

    await advanceCampaignStatus(campaign.id, 'COMPLETE');
    await audit('JOB_COMPLETE', `اكتمل الكامبين ${campaign.name} بالكامل: ${job.ad_sets_per_campaign} Ad Set، ${job.ad_sets_per_campaign * job.ads_per_ad_set} إعلان — كله PAUSED.`);

    const hasNextCampaign = job.campaigns.some((c) => c.index === campaignIndex + 1);
    if (hasNextCampaign) {
      await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { next_campaign_at: new Date(Date.now() + 5 * 60 * 1000) } });
    }
    return { campaignIndex, metaCampaignId, adSetsCreated: job.ad_sets_per_campaign, adsCreated: job.ad_sets_per_campaign * job.ads_per_ad_set, complete: true };
  } catch (err) {
    await setCampaignStatus(campaign.id, 'FAILED');
    await prisma.ambLaunchCampaign.update({ where: { id: campaign.id }, data: { error: err.message, attempts: { increment: 1 }, last_attempt_at: new Date() } });
    throw err;
  }
}

/** Real-time progress for the UI — computed fresh from amb_launch_object_map on every call, never cached client-side. */
export async function getQueueProgress(jobId) {
  const job = await prisma.ambLaunchJob.findUnique({
    where: { job_id: jobId },
    include: { campaigns: { orderBy: { index: 'asc' }, include: { objects: true } } },
  });
  if (!job) return null;
  const campaigns = job.campaigns.map((c) => {
    const adSetsCreated = c.objects.filter((o) => o.level === 'ADSET' && o.status === 'CREATED').length;
    const adsCreated = c.objects.filter((o) => o.level === 'AD' && o.status === 'CREATED').length;
    return {
      index: c.index, name: c.name, status: c.status, error: c.error, metaCampaignId: c.meta_campaign_id,
      adSetsCreated, adSetsTotal: job.ad_sets_per_campaign,
      adsCreated, adsTotal: job.ad_sets_per_campaign * job.ads_per_ad_set,
    };
  });
  return { jobId, jobStatus: job.status, jobError: job.error, nextCampaignAt: job.next_campaign_at, campaigns };
}

/**
 * Explicit entry point for the "🚀 نشر الحملات" confirmation — re-validates
 * everything server-side (never trusts the frontend's own checklist alone),
 * then flips the job into PUBLISHING so the durable scheduler tick below
 * picks it up. Idempotent: calling this on an already-PUBLISHING or
 * already-COMPLETE job is a safe no-op (a double-click never restarts
 * anything or creates a second run).
 */
export async function startLaunchQueue({ jobId, userId }) {
  const job = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId }, include: { campaigns: true, videos: true } });
  if (!job) fail('طلب الرفع غير موجود.');
  if (job.status === 'PUBLISHING' || job.status === 'COMPLETE') return job;
  if (!['DRAFT', 'VALIDATING', 'READY', 'PARTIAL'].includes(job.status)) fail(`لا يمكن بدء النشر وهو في حالة ${job.status}.`);

  if (!job.ad_account_id) fail('لازم حساب إعلاني.');
  if (!job.page_id) fail('لازم Facebook Page.');
  if (!job.pixel_id && !job.campaigns.some((c) => c.pixel_id)) fail('لازم Meta Pixel.');
  if (!job.campaigns.length) fail('لازم كامبين واحد على الأقل.');
  for (const c of job.campaigns) {
    if (!c.name?.trim() || !c.website_url?.trim()) fail(`الكامبين "${c.name || c.index}" ناقصه اسم أو رابط الموقع.`);
  }
  if (!job.videos.some((v) => v.status === 'UPLOADED')) fail('لازم فيديو واحد مرفوع وجاهز (UPLOADED) على الأقل.');
  const cfg = JSON.parse(job.config_json || '{}');
  if (job.budget_mode === 'CBO') {
    if (!(cfg.budget?.cbo?.dailyBudgetMinor > 0)) fail('لازم ميزانية كامبين صحيحة (CBO).');
  } else {
    const adSets = cfg.budget?.abo?.adSets || [];
    if (adSets.length !== job.ad_sets_per_campaign || adSets.some((a) => !(a.dailyBudgetMinor > 0))) fail('لازم ميزانية صحيحة لكل Ad Set (ABO).');
  }

  if (job.status === 'DRAFT') { await setJobStatus(jobId, 'VALIDATING'); await setJobStatus(jobId, 'READY'); }
  else if (job.status === 'VALIDATING') { await setJobStatus(jobId, 'READY'); }
  await setJobStatus(jobId, 'PUBLISHING');
  await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { approved_by_id: userId || null, approved_at: new Date(), error: null } });
  await prisma.ambLaunchAudit.create({ data: { job_id: jobId, event: 'PUBLISH_APPROVED', actor_id: userId || null, detail: 'تم تأكيد النشر — بدء طابور النشر الدائم.' } });

  return prisma.ambLaunchJob.findUnique({ where: { job_id: jobId } });
}

// In-memory re-entrancy guard only — prevents two overlapping scheduler
// ticks from starting a SECOND publishCampaignFull() call for the same
// campaign while one is already mid-flight in this same process. The REAL
// duplicate-prevention guarantee is the AmbLaunchObjectMap idempotency
// above, which holds even across a full process restart; this is purely an
// efficiency/tidiness guard for the common case.
const processingCampaigns = new Set();

/** The durable heartbeat step — see launchScheduler.js for how this is wired into the existing 60s AMB tick. Every real Meta write for the bulk queue ultimately happens from inside this function's call to publishCampaignFull(). */
export async function runDueLaunchQueueTick() {
  const jobs = await prisma.ambLaunchJob.findMany({ where: { status: 'PUBLISHING' }, include: { campaigns: { orderBy: { index: 'asc' } } } });
  for (const job of jobs) {
    try {
      const active = job.campaigns.find((c) => !['COMPLETE', 'CANCELLED'].includes(c.status));
      if (!active) {
        await setJobStatus(job.job_id, 'COMPLETE');
        await prisma.ambLaunchAudit.create({ data: { job_id: job.job_id, event: 'JOB_COMPLETE', detail: 'اكتمل نشر كل الحملات في الطلب.' } });
        continue;
      }
      if (active.index > 0) {
        const prev = job.campaigns.find((c) => c.index === active.index - 1);
        if (prev && prev.status === 'COMPLETE' && job.next_campaign_at && job.next_campaign_at.getTime() > Date.now()) {
          continue; // still inside the durable 5-minute gate — try again next tick
        }
      }
      const lockKey = `${job.job_id}:${active.index}`;
      if (processingCampaigns.has(lockKey)) continue;
      processingCampaigns.add(lockKey);
      publishCampaignFull({ jobId: job.job_id, campaignIndex: active.index })
        .catch(async (err) => {
          await prisma.ambLaunchJob.update({ where: { job_id: job.job_id }, data: { status: 'PARTIAL', error: err.message } }).catch(() => {});
          logger.error('Launch queue campaign failed', { jobId: job.job_id, campaignIndex: active.index, message: err.message });
        })
        .finally(() => { processingCampaigns.delete(lockKey); });
    } catch (err) {
      logger.error('Launch queue tick failed for job', { jobId: job.job_id, message: err.message });
    }
  }
}
