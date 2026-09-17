// Campaign Launch Builder — Phase F: the FIRST real Meta write phase.
// Creates real Campaign/AdSet/AdCreative/Ad objects on Meta from a
// finalized AmbLaunchJob, always PAUSED on create (never activated here —
// activation is a distinct, later, explicit action this file does not
// perform). Idempotent via the SAME AmbLaunchObjectMap pattern Phase B
// built for exactly this purpose: every object is looked up by its
// deterministic local_key before creating anything, so a retry or a
// resumed session never creates a duplicate Meta object.
//
// publishSingleTestItem() is deliberately narrow — exactly one campaign,
// one ad set, one ad, reusing one already-uploaded video — for the
// explicit controlled safety test requested before any full publish.
// publishCampaign() (the general N-ad-set/M-ad engine a future full
// publish will call) is built on the same primitives but is NOT invoked
// by anything yet.
import { prisma } from '../../prisma.js';
import { requireLaunchToken, getMetaVideoThumbnailUrl } from './launchVideoUpload.js';
import { createCampaign, createAdSet, createAdCreative, createAd, getEntityLive } from '../metaGraphClient.js';
import { getOrCreateObjectMapRow, markObjectResult, canTransitionCampaignStatus } from './launchBuilder.js';

function fail(msg) { const e = new Error(msg); e.status = 400; throw e; }

async function setCampaignStatus(campaignId, status) {
  const row = await prisma.ambLaunchCampaign.findUnique({ where: { id: campaignId } });
  if (!row) return;
  if (row.status === status) return;
  if (!canTransitionCampaignStatus(row.status, status)) return; // never force an invalid jump — leave the row honestly where it is
  await prisma.ambLaunchCampaign.update({ where: { id: campaignId }, data: { status } });
}

/** Minimal valid targeting for a fresh (non-cloned) ad set — geo_locations is the one genuinely required field; age/gender/interests are deliberately left unset (Meta's own broad default) since the wizard never collected them. Country is fixed to Egypt to match this business — a real product decision for a future phase, not guessed per-job here. */
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
    // ABO — Meta now requires this explicitly whenever the campaign itself carries no budget
    // (confirmed live: campaign creation is REJECTED with a real 400 error otherwise). false =
    // ad sets never share budget, matching this wizard's own per-ad-set budget amounts, which
    // were entered as independent values with no sharing opt-in ever offered.
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
    // Confirmed live: this ad account's default bid strategy requires an explicit bid
    // amount/constraint unless told otherwise. LOWEST_COST_WITHOUT_CAP = let Meta's
    // auction fully optimize with no manual bid cap, the simplest valid strategy that
    // needs no additional bid_amount/roas field.
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
        image_url: thumbnailUrl, // required by Meta — confirmed live ("Your ad needs a video thumbnail"); reused from the video's own Meta-auto-generated picture, never a fabricated/external image
        message: campaign.primary_text || undefined,
        title: campaign.headline || undefined,
        call_to_action: { type: cfg.cta || 'ORDER_NOW', value: { link: campaign.website_url } },
      },
    },
  };
}

/**
 * The narrow, explicit "controlled safety test" the owner approved before
 * any full publish: exactly 1 campaign -> 1 ad set -> 1 creative (using one
 * already-uploaded, real video) -> 1 ad, all PAUSED. Never touches the
 * job's other campaigns/ad-sets, never uploads a video (reuses an existing
 * meta_video_id), never activates anything.
 */
export async function publishSingleTestItem({ jobId, campaignIndex = 0, videoSlotKey }) {
  const job = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId }, include: { campaigns: { orderBy: { index: 'asc' } } } });
  if (!job) fail('طلب الرفع غير موجود.');
  const campaign = job.campaigns.find((c) => c.index === campaignIndex);
  if (!campaign) fail(`الكامبين رقم ${campaignIndex} غير موجود في هذا الطلب.`);
  if (!job.page_id) fail('لازم Facebook Page محدد قبل النشر.');
  if (!(campaign.pixel_id || job.pixel_id)) fail('لازم Meta Pixel محدد قبل النشر.');

  let video;
  if (videoSlotKey) {
    video = await prisma.ambLaunchVideoAsset.findUnique({ where: { job_id_slot_key: { job_id: jobId, slot_key: videoSlotKey } } });
  } else {
    video = await prisma.ambLaunchVideoAsset.findFirst({ where: { job_id: jobId, status: 'UPLOADED' }, orderBy: { slot_key: 'asc' } });
  }
  if (!video || video.status !== 'UPLOADED' || !video.meta_video_id) fail('مفيش فيديو مرفوع وجاهز (UPLOADED) في هذا الطلب لاستخدامه في الاختبار.');

  const token = await requireLaunchToken();
  const audit = async (event, detail, extra = {}) => {
    await prisma.ambLaunchAudit.create({ data: { job_id: jobId, campaign_id: campaign.id, event, detail, data_json: JSON.stringify(extra) } });
  };

  // ---- 1. Campaign ----
  let metaCampaignId = campaign.meta_campaign_id;
  if (!metaCampaignId) {
    await setCampaignStatus(campaign.id, 'PUBLISHING').catch(() => {});
    const payload = buildCampaignPayload(job, campaign);
    const res = await createCampaign(token, job.ad_account_id, payload);
    metaCampaignId = res.id;
    await prisma.ambLaunchCampaign.update({ where: { id: campaign.id }, data: { meta_campaign_id: metaCampaignId } });
    await setCampaignStatus(campaign.id, 'CAMPAIGN_CREATED');
    await audit('CAMPAIGN_CREATED', `كامبين اختبار PAUSED: ${campaign.name}`, { metaCampaignId, payload });
  }

  // ---- 2. Ad Set (local_key adset:<campaignIndex-scoped 0> — the FIRST ad set of this campaign's real plan) ----
  const adSetKey = 'adset:0';
  let adSetRow = await getOrCreateObjectMapRow({ campaignId: campaign.id, level: 'ADSET', localKey: adSetKey });
  let metaAdSetId = adSetRow.destination_id;
  if (adSetRow.status !== 'CREATED') {
    const cfg = JSON.parse(job.config_json || '{}');
    const dailyBudgetMinor = cfg.budget?.abo?.adSets?.[0]?.dailyBudgetMinor || null;
    const payload = buildAdSetPayload(job, campaign, metaCampaignId, 0, dailyBudgetMinor);
    try {
      const res = await createAdSet(token, job.ad_account_id, payload);
      metaAdSetId = res.id;
      await markObjectResult({ campaignId: campaign.id, level: 'ADSET', localKey: adSetKey, destinationId: metaAdSetId, status: 'CREATED', payload });
      await audit('OBJECT_CREATED', `Ad Set اختبار PAUSED`, { level: 'ADSET', metaAdSetId, payload });
    } catch (err) {
      await markObjectResult({ campaignId: campaign.id, level: 'ADSET', localKey: adSetKey, status: 'FAILED', error: err.message });
      await audit('OBJECT_FAILED', err.message, { level: 'ADSET' });
      throw err;
    }
  }

  // ---- 3. Ad Creative (reusing the existing uploaded video — never re-uploads) ----
  const creativeKey = 'creative:0:0';
  let creativeRow = await getOrCreateObjectMapRow({ campaignId: campaign.id, level: 'CREATIVE', localKey: creativeKey, parentLocalKey: adSetKey });
  let metaCreativeId = creativeRow.destination_id;
  if (creativeRow.status !== 'CREATED') {
    const thumbnailUrl = await getMetaVideoThumbnailUrl(token, video.meta_video_id);
    if (!thumbnailUrl) fail(`فيديو ${video.slot_key} لسه مفيهوش صورة مصغّرة جاهزة من Meta — جرب تاني بعد شوية.`);
    const payload = buildCreativePayload(job, campaign, 0, 0, video.meta_video_id, thumbnailUrl);
    try {
      const res = await createAdCreative(token, job.ad_account_id, payload);
      metaCreativeId = res.id;
      await markObjectResult({ campaignId: campaign.id, level: 'CREATIVE', localKey: creativeKey, destinationId: metaCreativeId, status: 'CREATED', payload });
      await audit('OBJECT_CREATED', `Creative اختبار — فيديو ${video.slot_key} (${video.meta_video_id})`, { level: 'CREATIVE', metaCreativeId, payload });
    } catch (err) {
      await markObjectResult({ campaignId: campaign.id, level: 'CREATIVE', localKey: creativeKey, status: 'FAILED', error: err.message });
      await audit('OBJECT_FAILED', err.message, { level: 'CREATIVE' });
      throw err;
    }
  }

  // ---- 4. Ad ----
  const adKey = 'ad:0:0';
  let adRow = await getOrCreateObjectMapRow({ campaignId: campaign.id, level: 'AD', localKey: adKey, parentLocalKey: adSetKey });
  let metaAdId = adRow.destination_id;
  if (adRow.status !== 'CREATED') {
    const payload = { name: `${campaign.name} - Ad 1.1`, adset_id: metaAdSetId, creative: { creative_id: metaCreativeId }, status: 'PAUSED' };
    try {
      const res = await createAd(token, job.ad_account_id, payload);
      metaAdId = res.id;
      await markObjectResult({ campaignId: campaign.id, level: 'AD', localKey: adKey, destinationId: metaAdId, status: 'CREATED', payload });
      await audit('OBJECT_CREATED', `Ad اختبار PAUSED`, { level: 'AD', metaAdId, payload });
    } catch (err) {
      await markObjectResult({ campaignId: campaign.id, level: 'AD', localKey: adKey, status: 'FAILED', error: err.message });
      await audit('OBJECT_FAILED', err.message, { level: 'AD' });
      throw err;
    }
  }

  // ---- Live verification straight from Meta (never trust our own DB alone for the final report) ----
  const [campaignLive, adSetLive, adLive] = await Promise.all([
    getEntityLive(token, metaCampaignId),
    getEntityLive(token, metaAdSetId),
    getEntityLive(token, metaAdId),
  ]);

  return {
    jobId, campaignIndex, videoSlotKey: video.slot_key, videoId: video.meta_video_id,
    metaCampaignId, metaAdSetId, metaCreativeId, metaAdId,
    live: { campaign: campaignLive, adSet: adSetLive, ad: adLive },
  };
}
