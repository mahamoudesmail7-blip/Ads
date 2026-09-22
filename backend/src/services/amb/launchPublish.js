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
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { requireLaunchToken, getMetaVideoThumbnailUrl, getMetaVideoStatus } from './launchVideoUpload.js';
import { createCampaign, createAdSet, createAdCreative, createAd, getEntity, getEntityLive, getAdSetNodes, getAdNodes, getEntitiesMeta, setEntityStatus, getCloneJobLiveState } from '../metaGraphClient.js';
import { getOrCreateObjectMapRow, markObjectResult, canTransitionCampaignStatus, canTransitionJobStatus, LAUNCH_CONCURRENCY_LIMIT } from './launchBuilder.js';
import { classifyError, backoffMsFor, ERROR_CLASSES } from './launchErrorPlaybook.js';
import { registerLaunchCreativeRef } from './mediaLibrary.js';

function fail(msg) { const e = new Error(msg); e.status = 400; throw e; }

// Bounded-concurrency batch runner: up to `limit` items in flight at once,
// every item always runs to settlement (success or its own caught error) —
// never a fail-fast Promise.all, so one stuck item (e.g. a video still
// processing on Meta) can never prevent the OTHER independent items in the
// same batch from finishing. Used for ad sets/ads WITHIN one campaign only;
// the 5-minute gate BETWEEN campaigns is untouched and lives elsewhere.
export async function runBounded(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try { results[i] = { ok: true, value: await fn(items[i], i) }; }
      catch (error) { results[i] = { ok: false, error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * A cheap, genuinely read-only Graph call (never a write) used ONLY to
 * verify a token that was previously flagged AUTH_REFRESH_REQUIRED is
 * really working again before spending a real object-creation attempt on
 * it. Every real Meta write already resolves its token completely fresh
 * from the single MetaConnection row on every call (getConnection() has no
 * caching, no module-level token variable — see metaAuth.js) — this probe
 * is not a workaround for a stale-token bug (there isn't one); it's a
 * cheap way to distinguish "still genuinely broken" from "fixed" WITHOUT
 * attempting a real write first, so a still-broken connection doesn't
 * silently consume a retry attempt or get misreported as a different
 * failure.
 */
async function probeMetaAuth(token) {
  try {
    const me = await getEntity(token, 'me', 'id,name');
    return !!me?.id;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Status transition helpers — thin wrappers around the Phase B state
// machines so every write here goes through the same adjacency checks
// everything else does. advanceCampaignStatus walks forward one legal step
// at a time (never skips, never regresses) so a resume from any point
// (including straight after a FAILED run) always lands on a valid status.
// ---------------------------------------------------------------------------
const CAMPAIGN_STATUS_ORDER = ['PENDING', 'QUEUED', 'PUBLISHING', 'CAMPAIGN_CREATED', 'ADSETS_CREATED', 'ADS_CREATED', 'COMPLETE'];

// ---------------------------------------------------------------------------
// DB-write resilience: if a Meta write just SUCCEEDED and persisting its
// result hits a transient DB blip, we must retry the DB WRITE, never repeat
// the Meta call (that would create a real duplicate). Bounded, short —
// covers the same class of Neon blip already observed live in this project
// (P1001/P2024), never used for anything except the save-immediately-after-
// a-successful-Meta-write step.
// ---------------------------------------------------------------------------
async function withDbRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (classifyError(err).classification !== ERROR_CLASSES.DATABASE_TRANSIENT) throw err;
      logger.warn('Launch queue DB write retry (Meta write already succeeded — never repeating it)', { label, attempt, message: err.message });
      await new Promise((r) => setTimeout(r, 300 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Reconciliation-by-name: the ONLY safe response to a genuinely ambiguous
// outcome (a network/provider/DB error while CREATING an object — we don't
// know if Meta's write landed before the error). Never blindly retries a
// create in that situation; looks the object up by its own deterministic
// name first, scoped to the exact parent (campaign/ad-account), and adopts
// its real id if found instead of creating a duplicate.
// ---------------------------------------------------------------------------
async function reconcileCampaignByName(token, adAccountId, name) {
  try {
    const rows = await getEntitiesMeta(token, adAccountId, 'campaign');
    return rows.find((r) => r.name === name)?.id || null;
  } catch { return null; }
}
async function reconcileAdSetByName(token, metaCampaignId, name) {
  try {
    const rows = await getAdSetNodes(token, metaCampaignId);
    return rows.find((r) => r.name === name)?.id || null;
  } catch { return null; }
}
async function reconcileAdByName(token, metaCampaignId, name) {
  try {
    const rows = await getAdNodes(token, metaCampaignId);
    return rows.find((r) => r.name === name)?.id || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Cross-instance scheduler lease (§11): whichever Railway worker's tick gets
// here first atomically wins the right to act on this job for LEASE_TTL_MS.
// The UPDATE's WHERE clause (lock_expires_at IS NULL OR < now()) is what
// makes this safe under real concurrency — Postgres serializes concurrent
// UPDATEs targeting the same row, so only one caller's statement can ever
// still see the condition true; the loser's updateMany simply matches zero
// rows. A worker that crashes mid-lease never wedges the job: the lease
// itself expires and the next tick (from any worker) can take it.
// ---------------------------------------------------------------------------
const WORKER_ID = `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const LEASE_TTL_MS = 90 * 1000; // comfortably longer than one tick's real work (a handful of Meta calls)

/** Exported for direct testing of cross-instance concurrency safety — see launchQueueTest.js. */
export async function acquireJobLease(jobId) {
  const now = new Date();
  const res = await prisma.ambLaunchJob.updateMany({
    where: { job_id: jobId, OR: [{ lock_expires_at: null }, { lock_expires_at: { lt: now } }] },
    data: { locked_by: WORKER_ID, lock_expires_at: new Date(now.getTime() + LEASE_TTL_MS) },
  });
  return res.count === 1;
}
/** Exported for direct testing — see launchQueueTest.js. */
export async function releaseJobLease(jobId) {
  await prisma.ambLaunchJob.updateMany({ where: { job_id: jobId, locked_by: WORKER_ID }, data: { locked_by: null, lock_expires_at: null } }).catch(() => {});
}

async function setCampaignStatus(campaignId, status) {
  const row = await prisma.ambLaunchCampaign.findUnique({ where: { id: campaignId } });
  if (!row || row.status === status) return;
  if (!canTransitionCampaignStatus(row.status, status)) return; // never force an invalid jump — leave the row honestly where it is
  await prisma.ambLaunchCampaign.update({ where: { id: campaignId }, data: { status } });
}
/** Only ever moves a campaign FORWARD along the normal progress order — safe to call repeatedly with the same or an already-passed target (a no-op then). Exported for direct testing of the FAILED-stuck bug fix — see launchQueueTest.js. */
export async function advanceCampaignStatus(campaignId, targetStatus) {
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
/** Gets a campaign into PUBLISHING from wherever it currently is (PENDING, QUEUED, or a resumed FAILED) without ever attempting an invalid jump. A campaign already past PUBLISHING (CAMPAIGN_CREATED or later) is left alone — it's mid-flight, not starting fresh. Exported for direct testing — see launchQueueTest.js. */
export async function ensurePublishingStatus(campaignId) {
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

/**
 * Targeting for a fresh (non-cloned) ad set. Default (job.config_json has no
 * CUSTOM targeting — every job before this feature existed, and every new
 * job that leaves this wizard step untouched) is EXACTLY what this function
 * has always returned: Egypt-wide, age/gender/interests unset (Meta's own
 * broad Advantage+ default), platforms from the wizard's own platform
 * choice. A CUSTOM override (final core execution step) only ever narrows
 * what was already validated server-side in launchBuilder.js's
 * validateTargeting() — genders/age/geoRegions/placementsMode — never
 * something invented here.
 */
export function buildTargeting(job) {
  const platforms = JSON.parse(job.platforms_json || '["facebook"]');
  const base = {
    geo_locations: { countries: ['EG'] },
    publisher_platforms: platforms,
  };
  const cfg = JSON.parse(job.config_json || '{}');
  const t = cfg.targeting;
  if (!t || t.mode !== 'CUSTOM') return base;

  const out = { ...base };
  if (t.geoRegions?.length) out.geo_locations = { regions: t.geoRegions.map((r) => ({ key: r.key, country: 'EG' })) };
  if (t.genders === 'MALE') out.genders = [1];
  else if (t.genders === 'FEMALE') out.genders = [2];
  // 'ALL' -> genders omitted entirely, Meta's own Broad default.
  if (Number.isInteger(t.ageMin)) out.age_min = t.ageMin;
  if (Number.isInteger(t.ageMax)) out.age_max = t.ageMax;
  if (t.placementsMode === 'FEED_ONLY') {
    out.facebook_positions = ['feed'];
    out.instagram_positions = ['stream'];
  }
  // 'AUTOMATIC' -> no facebook_positions/instagram_positions keys at all, Meta's own Advantage+ default.
  return out;
}

/**
 * The wizard's bidding config (job.config_json.bidding), normalized. Default
 * is always AUTOMATIC (Meta's own "Highest volume / no cap" auction) —
 * BID_CAP is only ever used when explicitly chosen, and even then never
 * derives the cap from the daily budget (a real production bug: a 200 EGP
 * daily budget silently became a 200 EGP bid cap on every result, which is
 * a completely different, unrequested restriction).
 */
function resolveBidding(job) {
  const cfg = JSON.parse(job.config_json || '{}');
  const bidding = cfg.bidding || {};
  if (bidding.mode === 'BID_CAP' && Number(bidding.bidCapMinor) > 0) {
    return { mode: 'BID_CAP', bidCapMinor: Number(bidding.bidCapMinor) };
  }
  return { mode: 'AUTOMATIC' };
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
    // Confirmed live against this real ad account: for a CBO campaign, bid
    // strategy belongs on the CAMPAIGN, not the ad set — dozens of real
    // working ACTIVE/PAUSED campaigns in this account carry
    // LOWEST_COST_WITHOUT_CAP here with NO bid_amount at all. Putting it on
    // the ad set instead (the earlier bug) made Meta demand an explicit
    // bid_amount, which is where the unwanted "200 EGP Bid Cap" came from —
    // this wizard must never invent a bid cap equal to the daily budget.
    const bidding = resolveBidding(job);
    if (bidding.mode === 'BID_CAP') {
      payload.bid_strategy = 'LOWEST_COST_WITH_BID_CAP';
      payload.bid_amount = bidding.bidCapMinor;
    } else {
      payload.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
    }
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
    promoted_object: { pixel_id: campaign.pixel_id || job.pixel_id, custom_event_type: job.conversion_event || 'PURCHASE' },
    targeting: buildTargeting(job),
    // Real Meta Ads Manager field (confirmed via developers.facebook.com's
    // AdSet reference: existing_customer_budget_percentage, int64) behind
    // the "Customer lifecycle strategy" UI control. 100 = no restriction on
    // how much budget may go to existing customers = "Get conversions from
    // all audiences" — the default this wizard must always use. Never a
    // lower value: that would enable new-customer-only/retention-style
    // budget restriction, which the wizard has no UI for and must never
    // apply implicitly.
    existing_customer_budget_percentage: 100,
  };
  if (job.budget_mode === 'ABO' && dailyBudgetMinor > 0) {
    payload.daily_budget = dailyBudgetMinor;
    // Confirmed live (Phase F, ABO ad set carrying its own budget):
    // LOWEST_COST_WITHOUT_CAP — Meta's auction fully automatic, no manual
    // cap, no bid_amount needed by default. BID_CAP is only ever applied
    // when the wizard's bidding mode is explicitly set to it.
    const bidding = resolveBidding(job);
    if (bidding.mode === 'BID_CAP') {
      payload.bid_strategy = 'LOWEST_COST_WITH_BID_CAP';
      payload.bid_amount = bidding.bidCapMinor;
    } else {
      payload.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
    }
  }
  // CBO: bid_strategy/bid_amount deliberately NEVER set here — they live on
  // the campaign (buildCampaignPayload above). Confirmed live: an ad set
  // under a CBO campaign that already carries a campaign-level bid_strategy
  // needs no bid fields of its own at all; it correctly inherits.
  // Always send the exact requested SCHEDULED start — never conditionally
  // omit it once it's in the past by creation time. That silent omission
  // was a real production bug: a durable queue can create later ad sets
  // well after the originally-requested moment has already elapsed, and
  // Meta defaults a start_time-less ad set to "start now" — silently
  // replacing the user's actual requested schedule with the wall-clock
  // moment of API creation. Sending the true value honestly preserves what
  // was asked for even if that moment has already passed (harmless: every
  // object here is created PAUSED, so this never affects real delivery).
  if (job.start_mode === 'SCHEDULED' && job.start_at) {
    payload.start_time = job.start_at.toISOString();
  }
  return payload;
}

/** Static-image counterpart to buildCreativePayload — object_story_spec.link_data with image_hash, the exact field shape already proven working against Meta by cloneEngine.js's own image-creative path (cloneEngine.js:1418-1422). Requires campaign.website_url (link_data has no thumbnail-from-Meta fallback the way video_data does — an image ad IS the picture, there is nothing to derive a link from). */
export function buildImageCreativePayload(job, campaign, adSetIndex, adIndex, imageHash) {
  const cfg = JSON.parse(job.config_json || '{}');
  return {
    name: `${campaign.name} - Creative ${adSetIndex + 1}.${adIndex + 1}`,
    object_story_spec: {
      page_id: job.page_id,
      instagram_user_id: job.instagram_id || undefined,
      link_data: {
        link: campaign.website_url,
        image_hash: imageHash,
        message: campaign.primary_text || undefined,
        name: campaign.headline || undefined,
        call_to_action: { type: cfg.cta || 'ORDER_NOW', value: { link: campaign.website_url } },
      },
    },
  };
}

export function buildCreativePayload(job, campaign, adSetIndex, adIndex, videoId, thumbnailUrl) {
  const cfg = JSON.parse(job.config_json || '{}');
  return {
    name: `${campaign.name} - Creative ${adSetIndex + 1}.${adIndex + 1}`,
    object_story_spec: {
      page_id: job.page_id,
      // Confirmed field placement from this codebase's own already-working
      // Clone & Schedule engine (cloneEngine.js: `applyIdentity({ page_id,
      // instagram_user_id })`) — a sibling of page_id inside
      // object_story_spec, current field name (instagram_actor_id is
      // deprecated). Omitted entirely when no Instagram identity was
      // selected — never sent as an empty/placeholder value. Without this,
      // Meta creates the ad using only the Facebook Page identity and
      // Ads Manager prompts to "Add Instagram placement" manually, which
      // is exactly the real production issue this fixes at the root.
      instagram_user_id: job.instagram_id || undefined,
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
  const payload = buildCampaignPayload(job, campaign);
  // Only reconcile when a PRIOR real attempt at creating THIS specific
  // campaign object already happened (attempts > 0) — never on a fresh
  // first-ever attempt. Unlike ad sets/ads (scoped to one campaign, so a
  // deterministic name match can only ever be this same logical object),
  // a campaign name lookup is ACCOUNT-WIDE: doing it unconditionally risks
  // silently adopting a real, unrelated, pre-existing campaign that just
  // happens to share the same human-chosen name (e.g. a re-run of the
  // wizard with the same product name). Gating on attempts>0 keeps this to
  // its only safe use — resolving a genuinely ambiguous earlier outcome.
  if (campaign.attempts > 0) {
    const existingId = await reconcileCampaignByName(token, job.ad_account_id, payload.name);
    if (existingId) {
      await withDbRetry(() => prisma.ambLaunchCampaign.update({ where: { id: campaign.id }, data: { meta_campaign_id: existingId } }), 'campaign.meta_campaign_id');
      await advanceCampaignStatus(campaign.id, 'CAMPAIGN_CREATED');
      await audit('RECONCILED', `الكامبين موجود بالفعل على Meta من محاولة سابقة غامضة النتيجة — لم يتم إنشاء تكرار.`, { metaCampaignId: existingId });
      return existingId;
    }
  }
  const res = await createCampaign(token, job.ad_account_id, payload);
  await withDbRetry(() => prisma.ambLaunchCampaign.update({ where: { id: campaign.id }, data: { meta_campaign_id: res.id } }), 'campaign.meta_campaign_id');
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
  // Transparency for a long-running durable queue: startLaunchQueue() already
  // blocks publishing when the schedule has already passed, but a schedule
  // that was still valid AT publish time can still elapse before a LATER ad
  // set (deep in a multi-campaign queue) actually gets created — Meta itself
  // then silently uses "now" for that one object (confirmed live; sending a
  // past start_time is not honored). Recorded here so it's visible in the
  // audit trail rather than a silent surprise.
  if (job.start_mode === 'SCHEDULED' && job.start_at && job.start_at.getTime() <= Date.now() && payload.start_time) {
    await audit('SCHEDULE_ELAPSED', `الموعد المطلوب (${job.start_at.toISOString()}) فات وقت إنشاء Ad Set ${adSetIndex + 1} — Meta هيستخدم وقت الإنشاء الفعلي بدل منه (هذا سلوك حقيقي من Meta نفسها، مش تقصير في الكود).`, { requestedStartAt: job.start_at.toISOString() });
  }
  // ALWAYS reconcile by the deterministic name before creating — cheap (one
  // list call scoped to this single campaign) and the only safe response to
  // "did an earlier ambiguous-outcome attempt actually land on Meta or not."
  // On a genuine first-ever attempt this simply finds nothing and falls
  // through to create normally.
  const existingId = await reconcileAdSetByName(token, metaCampaignId, payload.name);
  if (existingId) {
    await withDbRetry(() => markObjectResult({ campaignId: campaign.id, level: 'ADSET', localKey, destinationId: existingId, status: 'CREATED', payload }), 'adset.map');
    if (row.status === 'FAILED') await audit('RECONCILED', `Ad Set ${adSetIndex + 1} موجود بالفعل من محاولة سابقة غامضة — لم يتم إنشاء تكرار.`, { level: 'ADSET', metaAdSetId: existingId });
    else await audit('OBJECT_CREATED', `Ad Set ${adSetIndex + 1} PAUSED`, { level: 'ADSET', metaAdSetId: existingId, payload });
    return existingId;
  }
  try {
    const res = await createAdSet(token, job.ad_account_id, payload);
    await withDbRetry(() => markObjectResult({ campaignId: campaign.id, level: 'ADSET', localKey, destinationId: res.id, status: 'CREATED', payload }), 'adset.map');
    await audit('OBJECT_CREATED', `Ad Set ${adSetIndex + 1} PAUSED`, { level: 'ADSET', metaAdSetId: res.id, payload });
    return res.id;
  } catch (err) {
    await markObjectResult({ campaignId: campaign.id, level: 'ADSET', localKey, status: 'FAILED', error: err.message });
    await audit('OBJECT_FAILED', err.message, { level: 'ADSET', localKey });
    throw err;
  }
}

/** `creative` is a row from either ambLaunchVideoAsset or ambLaunchImageAsset, tagged with `_kind: 'video'|'image'` by the caller (publishCampaignFull's combined round-robin pool) — never guessed here from field presence, so a malformed/legacy row can never be silently misrouted. */
async function ensureCreative({ job, campaign, adSetIndex, adIndex, creative, token, audit }) {
  const localKey = `creative:${adSetIndex}:${adIndex}`;
  const row = await getOrCreateObjectMapRow({ campaignId: campaign.id, level: 'CREATIVE', localKey, parentLocalKey: `adset:${adSetIndex}` });
  if (row.status === 'CREATED') return row.destination_id;

  let payload, sourceLabel;
  if (creative._kind === 'image') {
    // An image asset is already fully UPLOADED (its own POST route only
    // marks it UPLOADED once Meta's /adimages call already returned a real
    // hash) — no async "still processing" wait like video needs, so this
    // branch never throws a transient error the way the video one can.
    payload = buildImageCreativePayload(job, campaign, adSetIndex, adIndex, creative.meta_image_hash);
    sourceLabel = `صورة ${creative.slot_key} (${creative.meta_image_hash})`;
  } else {
    // Check Meta's own real processing status BEFORE asking for a thumbnail —
    // "still processing" is expected and transient (Meta can take anywhere
    // from seconds to a couple of hours per video); only a real 'error'
    // status on the video itself is a genuine, non-retryable problem.
    const videoStatus = await getMetaVideoStatus(token, creative.meta_video_id);
    if (videoStatus === 'error') {
      const e = new Error(`فيديو ${creative.slot_key} فشلت معالجته على Meta بشكل نهائي — محتاج إعادة رفع.`);
      e.status = 422;
      throw e; // terminal — no amount of waiting fixes a video Meta itself rejected
    }
    const thumbnailUrl = await getMetaVideoThumbnailUrl(token, creative.meta_video_id);
    if (!thumbnailUrl) {
      const e = new Error(`فيديو ${creative.slot_key} لسه Meta بيعالجه (${videoStatus || 'processing'}) — هيتعاد المحاولة تلقائيًا لحد ما يجهز.`);
      e.transient = true; // never a terminal failure by itself — see publishCampaignFull's bounded-retry handling
      throw e;
    }
    payload = buildCreativePayload(job, campaign, adSetIndex, adIndex, creative.meta_video_id, thumbnailUrl);
    sourceLabel = `فيديو ${creative.slot_key} (${creative.meta_video_id})`;
  }
  try {
    // No cheap "list creatives for this campaign" Graph endpoint exists (creatives
    // live on the ad account, not the campaign), so unlike campaign/ad-set/ad there
    // is no reconciliation-by-name safety net here — an ambiguous-outcome timeout on
    // THIS specific call is the one residual duplicate-creative risk in this engine
    // (a wasted, unused, PAUSED-parent-less creative object, never itself spend-bearing).
    // withDbRetry below at least removes the "Meta succeeded, DB write failed" case.
    const res = await createAdCreative(token, job.ad_account_id, payload);
    await withDbRetry(() => markObjectResult({ campaignId: campaign.id, level: 'CREATIVE', localKey, destinationId: res.id, status: 'CREATED', payload }), 'creative.map');
    await audit('OBJECT_CREATED', `Creative ${adSetIndex + 1}.${adIndex + 1} — ${sourceLabel}`, { level: 'CREATIVE', metaCreativeId: res.id, payload });
    // Smart Decision Center Phase 1 — stable cross-job creative identity via
    // the existing Media Library, not a new table. Best-effort, non-fatal
    // (registerLaunchCreativeRef never throws): a linking failure must never
    // fail or roll back an already-created real Meta creative.
    await registerLaunchCreativeRef({ payload, adAccountId: job.ad_account_id, creativeId: res.id, productId: job.product_id || null, hook: creative.hook || null, sellingAngle: creative.selling_angle || null });
    return res.id;
  } catch (err) {
    await markObjectResult({ campaignId: campaign.id, level: 'CREATIVE', localKey, status: 'FAILED', error: err.message });
    await audit('OBJECT_FAILED', err.message, { level: 'CREATIVE', localKey });
    throw err;
  }
}

async function ensureAd({ job, campaign, metaCampaignId, metaAdSetId, metaCreativeId, adSetIndex, adIndex, token, audit }) {
  const localKey = `ad:${adSetIndex}:${adIndex}`;
  const row = await getOrCreateObjectMapRow({ campaignId: campaign.id, level: 'AD', localKey, parentLocalKey: `adset:${adSetIndex}` });
  if (row.status === 'CREATED') return row.destination_id;
  const payload = { name: `${campaign.name} - Ad ${adSetIndex + 1}.${adIndex + 1}`, adset_id: metaAdSetId, creative: { creative_id: metaCreativeId }, status: 'PAUSED' };
  // Always reconcile first — scoped to this one campaign, and the name is
  // deterministic per (adSetIndex, adIndex), so a match can only ever be
  // this same logical ad recovering from an earlier ambiguous outcome.
  const existingId = await reconcileAdByName(token, metaCampaignId, payload.name);
  if (existingId) {
    await withDbRetry(() => markObjectResult({ campaignId: campaign.id, level: 'AD', localKey, destinationId: existingId, status: 'CREATED', payload }), 'ad.map');
    if (row.status === 'FAILED') await audit('RECONCILED', `Ad ${adSetIndex + 1}.${adIndex + 1} موجود بالفعل من محاولة سابقة غامضة — لم يتم إنشاء تكرار.`, { level: 'AD', metaAdId: existingId });
    else await audit('OBJECT_CREATED', `Ad ${adSetIndex + 1}.${adIndex + 1} PAUSED`, { level: 'AD', metaAdId: existingId, payload });
    return existingId;
  }
  try {
    const res = await createAd(token, job.ad_account_id, payload);
    await withDbRetry(() => markObjectResult({ campaignId: campaign.id, level: 'AD', localKey, destinationId: res.id, status: 'CREATED', payload }), 'ad.map');
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
  const metaCreativeId = await ensureCreative({ job, campaign, adSetIndex: 0, adIndex: 0, creative: { ...video, _kind: 'video' }, token, audit });
  const metaAdId = await ensureAd({ job, campaign, metaCampaignId, metaAdSetId, metaCreativeId, adSetIndex: 0, adIndex: 0, token, audit });

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

  // Unconditional — unlike ensureCampaign (which short-circuits instantly
  // whenever meta_campaign_id already exists, e.g. every resume of this
  // exact campaign), this must run on EVERY entry so a campaign resumed
  // from a FAILED state (not in the linear progress order) always gets
  // walked back onto it before advanceCampaignStatus() is asked to move it
  // forward again. Without this, a campaign that ever failed once could
  // finish creating 100% of its real objects on Meta and still stay
  // stuck showing FAILED forever, because advanceCampaignStatus() only
  // ever moves a campaign forward along that order and treats an unknown
  // (off-order) current status as nothing to do.
  await ensurePublishingStatus(campaign.id);

  // Prisma's orderBy on slot_key is a plain string sort ("C1","C10","C11",
  // …,"C2",…), not the natural numeric order the slot_keys ("C1".."C15")
  // imply — sort numerically here so round-robin video assignment is
  // predictable (C1, C2, C3, … C15) rather than silently scrambled. Images
  // (own slot_key namespace "I1".."In") are appended after every video in
  // the round-robin pool, sorted the same numeric way — a mixed job cycles
  // through all its videos first, then its images, then wraps around, never
  // interleaved in an unpredictable order.
  const [videos, images] = await Promise.all([
    prisma.ambLaunchVideoAsset.findMany({ where: { job_id: jobId, status: 'UPLOADED' } }),
    prisma.ambLaunchImageAsset.findMany({ where: { job_id: jobId, status: 'UPLOADED' } }),
  ]);
  const bySlotNum = (a, b) => (parseInt(a.slot_key.slice(1), 10) || 0) - (parseInt(b.slot_key.slice(1), 10) || 0);
  const creativePool = [
    ...videos.sort(bySlotNum).map((v) => ({ ...v, _kind: 'video' })),
    ...images.sort(bySlotNum).map((i) => ({ ...i, _kind: 'image' })),
  ];
  if (!creativePool.length) fail('مفيش فيديوهات أو صور مرفوعة وجاهزة (UPLOADED) في هذا الطلب.');

  const token = await requireLaunchToken();
  const audit = async (event, detail, extra = {}) => prisma.ambLaunchAudit.create({ data: { job_id: jobId, campaign_id: campaign.id, event, detail, data_json: JSON.stringify(extra) } });

  // Self-heal auth recovery: resuming a campaign that was previously parked
  // ACTION_REQUIRED specifically because of a (real or misclassified) auth
  // problem — verify the connection genuinely works BEFORE spending a real
  // write attempt on it. A stale "reconnect Meta" banner must never survive
  // a successful probe; if it's still genuinely broken, fail fast with the
  // real reason instead of a confusing write-side error.
  if (campaign.error_classification === ERROR_CLASSES.AUTH_REFRESH_REQUIRED) {
    const authOk = await probeMetaAuth(token);
    if (!authOk) {
      const e = new Error('اتصال Meta لسه مش شغال — التوكن الحالي رفضته Meta فعليًا. أعد الربط من الإعدادات ثم استأنف النشر.');
      e.classification = ERROR_CLASSES.AUTH_REFRESH_REQUIRED; // pre-classified — the catch below trusts this directly instead of re-running classifyError() on a plain local Error with no Meta diagnostic fields
      throw e;
    }
    await prisma.ambLaunchCampaign.update({ where: { id: campaign.id }, data: { error: null, error_classification: null, human_action_required: false } });
    await audit('RECONCILED', 'اتصال Meta اتأكد إنه شغال (auth probe نجح) — تم مسح حالة "محتاج تدخل" القديمة، واستؤنف النشر من نفس النقطة.');
  }

  try {
    const metaCampaignId = await ensureCampaign({ job, campaign, token, audit });

    // Ad sets are independent of each other (each only needs metaCampaignId,
    // already known) — create them with bounded concurrency instead of one
    // at a time. Ad sets never depend on video processing, so a plain
    // fail-fast is fine here: a real ad-set failure is rare and, unlike a
    // stuck video, has no "unrelated work that could still proceed" to protect.
    const adSetIndices = Array.from({ length: job.ad_sets_per_campaign }, (_, i) => i);
    const adSetResults = await runBounded(adSetIndices, LAUNCH_CONCURRENCY_LIMIT, (adSetIndex) =>
      ensureAdSet({ job, campaign, metaCampaignId, adSetIndex, token, audit }));
    const firstAdSetFailure = adSetResults.find((r) => !r.ok);
    if (firstAdSetFailure) throw firstAdSetFailure.error;
    const metaAdSetIds = adSetResults.map((r) => r.value);
    await advanceCampaignStatus(campaign.id, 'ADSETS_CREATED');

    // Ads (creative+ad) across ALL ad sets in this campaign, also bounded-
    // concurrent. Critically: every slot in the batch always runs to
    // settlement, so one video still WAITING_FOR_META on Meta's side can
    // never block unrelated, already-ready videos' ads from being created in
    // this same pass — they no longer have to wait for the next retry tick.
    const adSlots = [];
    for (let adSetIndex = 0; adSetIndex < job.ad_sets_per_campaign; adSetIndex++) {
      for (let adIndex = 0; adIndex < job.ads_per_ad_set; adIndex++) adSlots.push({ adSetIndex, adIndex });
    }
    const adResults = await runBounded(adSlots, LAUNCH_CONCURRENCY_LIMIT, async ({ adSetIndex, adIndex }) => {
      const globalAdIndex = campaignIndex * job.ad_sets_per_campaign * job.ads_per_ad_set + adSetIndex * job.ads_per_ad_set + adIndex;
      const creative = creativePool[globalAdIndex % creativePool.length];
      const metaCreativeId = await ensureCreative({ job, campaign, adSetIndex, adIndex, creative, token, audit });
      return ensureAd({ job, campaign, metaCampaignId, metaAdSetId: metaAdSetIds[adSetIndex], metaCreativeId, adSetIndex, adIndex, token, audit });
    });
    const adFailures = adResults.filter((r) => !r.ok);
    if (adFailures.length) {
      // Everything that succeeded this batch is already safely persisted
      // (idempotent object-map rows) and will be skipped instantly on the
      // next pass — only genuinely still-pending slots get retried. A hard
      // (non-retryable) failure still stops the campaign, exactly matching
      // the existing single-object policy the outer catch below applies.
      const hardFailure = adFailures.find((r) => { const p = classifyError(r.error); return !(p.retryable && !p.humanActionRequired); });
      throw (hardFailure || adFailures[0]).error;
    }
    await advanceCampaignStatus(campaign.id, 'ADS_CREATED');

    // Live verification straight from Meta before declaring COMPLETE — never trust our own DB alone.
    const objects = await prisma.ambLaunchObjectMap.findMany({ where: { campaign_id: campaign.id } });
    const adRows = objects.filter((o) => o.level === 'AD' && o.status === 'CREATED');
    const liveAds = await Promise.all(adRows.map((r) => getEntityLive(token, r.destination_id)));
    const allPaused = liveAds.every((a) => a?.status === 'PAUSED');
    if (!allPaused) { const e = new Error('بعض الإعلانات لم تُتحقق كـ PAUSED فعليًا على Meta بعد الإنشاء.'); e.status = 409; throw e; }

    await advanceCampaignStatus(campaign.id, 'COMPLETE');
    // Clear every trace of an earlier failure/wait now that it genuinely succeeded —
    // a completed campaign must never still show as ACTION_REQUIRED or mid-retry.
    await prisma.ambLaunchCampaign.update({ where: { id: campaign.id }, data: { error: null, next_retry_at: null, error_classification: null, human_action_required: false } });
    await audit('JOB_COMPLETE', `اكتمل الكامبين ${campaign.name} بالكامل: ${job.ad_sets_per_campaign} Ad Set، ${job.ad_sets_per_campaign * job.ads_per_ad_set} إعلان — كله PAUSED.`);

    // Native Meta scheduling (launch_mode=SCHEDULED only, confirmed with the
    // user before adding this — NOW/PAUSED_REVIEW never reach here and stay
    // PAUSED forever). The structure is now 100% verified complete; flip
    // campaign → ad sets → ads to ACTIVE top-down in one pass. Every ad set
    // already carries the real future start_time from creation, so Meta
    // reviews now and withholds all delivery/spend until that exact moment
    // — no manual Resume/Activate needed. Re-running this on an already
    // partially-activated campaign is safe: setting an object that's
    // already ACTIVE to ACTIVE again is a harmless no-op on Meta's side.
    if (job.launch_mode === 'SCHEDULED' && !campaign.natively_activated_at) {
      const adsetRows = objects.filter((o) => o.level === 'ADSET' && o.status === 'CREATED');
      const orderedIds = [metaCampaignId, ...adsetRows.map((r) => r.destination_id), ...adRows.map((r) => r.destination_id)];
      const activationErrors = [];
      for (const id of orderedIds) {
        try { await setEntityStatus(token, id, 'ACTIVE'); }
        catch (activationErr) { activationErrors.push(`${id}: ${activationErr.message}`); }
      }
      if (activationErrors.length) {
        await audit('ACTIVATION_FAILED', `فشل تفعيل الجدولة الأصلية جزئيًا: ${activationErrors.join(' | ')}`);
        throw new Error(`تم بناء الكامبين بالكامل PAUSED بنجاح، لكن فشل تفعيله للجدولة الأصلية: ${activationErrors[0]}`);
      }
      await prisma.ambLaunchCampaign.update({ where: { id: campaign.id }, data: { natively_activated_at: new Date() } });
      await audit('SCHEDULE_NATIVE_ARMED', `تم تفعيل الكامبين + ${adsetRows.length} Ad Set + ${adRows.length} إعلان (ACTIVE) — موعد البدء الحقيقي ${job.start_at?.toISOString() || ''}. Meta يراجع الآن ويحجز التسليم حتى الموعد بدون أي إجراء يدوي.`);
    }

    const hasNextCampaign = job.campaigns.some((c) => c.index === campaignIndex + 1);
    if (hasNextCampaign) {
      await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { next_campaign_at: new Date(Date.now() + 5 * 60 * 1000) } });
    }
    return { campaignIndex, metaCampaignId, adSetsCreated: job.ad_sets_per_campaign, adsCreated: job.ad_sets_per_campaign * job.ads_per_ad_set, complete: true };
  } catch (err) {
    // The Error Playbook Registry decides everything from here — classify
    // once, centrally, and apply exactly the policy that classification
    // carries. Never a blind "retry everything" or "fail everything".
    const policy = classifyError(err);
    const firstFailureAt = campaign.first_failure_at || new Date();
    logger.error('Launch queue campaign step failed', { jobId, campaignIndex, classification: policy.classification, code: policy.code, subcode: policy.subcode, message: err.message });

    if (policy.retryable && !policy.humanActionRequired) {
      const nextCount = (campaign.transient_retry_count || 0) + 1;
      const maxRetries = policy.maxRetries || 20;
      if (nextCount > maxRetries) {
        // Bounded — stop waiting on Meta forever and surface a real, actionable failure.
        await setCampaignStatus(campaign.id, 'FAILED');
        await prisma.ambLaunchCampaign.update({
          where: { id: campaign.id },
          data: {
            error: `${err.message} — تجاوزنا الحد الأقصى لإعادة المحاولة التلقائية (${maxRetries} مرة) — محتاج تدخل يدوي.`,
            error_classification: policy.classification, human_action_required: true,
            attempts: { increment: 1 }, transient_retry_count: nextCount, last_attempt_at: new Date(), next_retry_at: null, first_failure_at: firstFailureAt,
          },
        });
        await audit('OBJECT_FAILED', 'تجاوزنا الحد الأقصى لإعادة المحاولة التلقائية', { classification: policy.classification, transientRetryCount: nextCount });
        throw err;
      }
      // Meta's Graph API rate-limit errors don't carry a standard Retry-After
      // header today, so this is always null in practice — backoffMsFor()
      // already falls back to its own computed bounded backoff, and the
      // parameter stays here so a real Retry-After becomes a one-line change
      // the moment Meta (or a future retryable dependency) ever sends one.
      const delayMs = backoffMsFor(nextCount, err.retryAfterSeconds ?? null);
      await prisma.ambLaunchCampaign.update({
        where: { id: campaign.id },
        data: { error: err.message, error_classification: policy.classification, attempts: { increment: 1 }, transient_retry_count: nextCount, last_attempt_at: new Date(), next_retry_at: new Date(Date.now() + delayMs), first_failure_at: firstFailureAt },
      });
      // Deliberately NOT re-thrown — this is a bounded wait, not a job-level
      // failure, so the scheduler must not flip the whole job to PARTIAL over
      // a condition (video processing, rate limit, a network/DB blip) that
      // resolves itself given time.
      return { campaignIndex, retryScheduled: true, classification: policy.classification, attempt: nextCount, retryInMs: delayMs, error: err.message };
    }

    // Everything else — AUTH_REFRESH_REQUIRED, CONFIGURATION_REQUIRED,
    // PERMISSION_ERROR, VALIDATION_ERROR, or a genuinely unknown TERMINAL —
    // stops here. Never auto-retried, never auto-"fixed" by substituting a
    // different Page/Pixel/account: that is a content decision only a human
    // makes. Every object already created stays exactly as it is.
    await setCampaignStatus(campaign.id, 'FAILED');
    await prisma.ambLaunchCampaign.update({
      where: { id: campaign.id },
      data: { error: policy.arabicMessage || err.message, error_classification: policy.classification, human_action_required: true, attempts: { increment: 1 }, last_attempt_at: new Date(), next_retry_at: null, first_failure_at: firstFailureAt },
    });
    await audit('OBJECT_FAILED', policy.arabicMessage || err.message, { classification: policy.classification, humanActionRequired: true });
    throw err;
  }
}

// Computed, UI-facing "queue phase" vocabulary (§10) layered on top of the
// existing, already-tested durable status enums (JOB_STATUSES/
// CAMPAIGN_STATUSES) rather than replacing them — the persisted FSM stays
// exactly as validated; this just names what it means for a human right now.
function campaignPhase(c) {
  if (c.status === 'COMPLETE') return 'COMPLETE';
  if (c.status === 'CANCELLED') return 'CANCELLED';
  if (c.human_action_required) return 'ACTION_REQUIRED';
  if (c.status === 'FAILED') return 'FAILED_TERMINAL';
  if (c.next_retry_at && c.next_retry_at.getTime() > Date.now()) {
    return c.error_classification === ERROR_CLASSES.PROCESSING_WAIT ? 'WAITING_FOR_META' : 'RETRY_SCHEDULED';
  }
  if (c.status === 'PENDING' || c.status === 'QUEUED') return 'QUEUED';
  return 'PUBLISHING';
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
      nextRetryAt: c.next_retry_at, transientRetryCount: c.transient_retry_count,
      errorClassification: c.error_classification, humanActionRequired: c.human_action_required, firstFailureAt: c.first_failure_at,
      phase: campaignPhase(c),
      nativelyActivatedAt: c.natively_activated_at,
    };
  });
  return { jobId, jobStatus: job.status, jobError: job.error, launchMode: job.launch_mode, startAt: job.start_at, nextCampaignAt: job.next_campaign_at, lockedBy: job.locked_by, campaigns };
}

/**
 * "إعادة المحاولة الآن" — clears a pending bounded-backoff wait on the
 * job's currently-active campaign so the next scheduler tick (≤30s) acts
 * immediately instead of waiting out the remainder of the timer. Never
 * creates anything itself — purely a scheduling nudge, so it is always
 * safe to call repeatedly. Refuses when the campaign is actually parked in
 * ACTION_REQUIRED (a human decision is what's blocking it, not time).
 */
export async function retryLaunchCampaignNow({ jobId, campaignIndex }) {
  const campaign = await prisma.ambLaunchCampaign.findFirst({ where: { job_id: jobId, index: campaignIndex } });
  if (!campaign) fail('الكامبين غير موجود.');
  if (campaign.human_action_required) fail('الكامبين محتاج تدخل يدوي أولًا — راجع الخطأ الموضح قبل إعادة المحاولة.');
  await prisma.ambLaunchCampaign.update({ where: { id: campaign.id }, data: { next_retry_at: null } });
  await prisma.ambLaunchAudit.create({ data: { job_id: jobId, campaign_id: campaign.id, event: 'RETRY', detail: 'المستخدم طلب إعادة محاولة فورية.' } });
  return { ok: true };
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
  const job = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId }, include: { campaigns: true, videos: true, images: true } });
  if (!job) fail('طلب الرفع غير موجود.');
  if (job.status === 'PUBLISHING' || job.status === 'COMPLETE') return job;
  if (!['DRAFT', 'VALIDATING', 'READY', 'PARTIAL'].includes(job.status)) fail(`لا يمكن بدء النشر وهو في حالة ${job.status}.`);

  if (!job.ad_account_id) fail('لازم حساب إعلاني.');
  if (!job.page_id) fail('لازم Facebook Page.');
  if (!job.pixel_id && !job.campaigns.some((c) => c.pixel_id)) fail('لازم Meta Pixel.');
  // Instagram checked but no real identity resolved must block publish —
  // never silently fall back to Facebook-only (the real production bug this fixes).
  const platforms = JSON.parse(job.platforms_json || '["facebook"]');
  if (platforms.includes('instagram') && !job.instagram_id) fail('اخترت إنستجرام كمنصة لكن لسه معملتش اختيار حساب إنستجرام حقيقي متصل بالصفحة.');
  if (!job.campaigns.length) fail('لازم كامبين واحد على الأقل.');
  for (const c of job.campaigns) {
    if (!c.name?.trim() || !c.website_url?.trim()) fail(`الكامبين "${c.name || c.index}" ناقصه اسم أو رابط الموقع.`);
  }
  if (!job.videos.some((v) => v.status === 'UPLOADED') && !job.images.some((i) => i.status === 'UPLOADED')) fail('لازم فيديو أو صورة واحدة على الأقل مرفوعة وجاهزة (UPLOADED).');
  const cfg = JSON.parse(job.config_json || '{}');
  if (job.budget_mode === 'CBO') {
    if (!(cfg.budget?.cbo?.dailyBudgetMinor > 0)) fail('لازم ميزانية كامبين صحيحة (CBO).');
  } else {
    const adSets = cfg.budget?.abo?.adSets || [];
    if (adSets.length !== job.ad_sets_per_campaign || adSets.some((a) => !(a.dailyBudgetMinor > 0))) fail('لازم ميزانية صحيحة لكل Ad Set (ABO).');
  }
  // Confirmed live against real Meta: a SCHEDULED start_time already in the
  // past is NOT honored by Meta itself — it silently substitutes the actual
  // object-creation moment instead, regardless of what we send. So a
  // requested schedule that has already elapsed by the moment publish is
  // clicked can never be honestly delivered — block here with an
  // actionable choice instead of silently letting it drift to "now".
  if (job.start_mode === 'SCHEDULED' && job.start_at && job.start_at.getTime() <= Date.now()) {
    fail('الموعد المطلوب فات بالفعل — Meta مش هيلتزم بميعاد في الماضي وهيبدأ فورًا بدل منه. عدّل الموعد لوقت في المستقبل، أو اختار "تشغيل الآن".');
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
      if (active.next_retry_at && active.next_retry_at.getTime() > Date.now()) {
        continue; // waiting out a transient condition's bounded backoff (e.g. a video still processing on Meta) — never hammer Meta every tick
      }
      const lockKey = `${job.job_id}:${active.index}`;
      if (processingCampaigns.has(lockKey)) continue;
      // Cross-instance safety FIRST — if another Railway worker already holds
      // this job's lease, skip it this tick without touching anything.
      if (!(await acquireJobLease(job.job_id))) continue;
      processingCampaigns.add(lockKey);
      publishCampaignFull({ jobId: job.job_id, campaignIndex: active.index })
        .catch(async (err) => {
          await prisma.ambLaunchJob.update({ where: { job_id: job.job_id }, data: { status: 'PARTIAL', error: err.message } }).catch(() => {});
          logger.error('Launch queue campaign failed', { jobId: job.job_id, campaignIndex: active.index, message: err.message });
        })
        .finally(async () => { processingCampaigns.delete(lockKey); await releaseJobLease(job.job_id); });
    } catch (err) {
      logger.error('Launch queue tick failed for job', { jobId: job.job_id, message: err.message });
    }
  }
}

// ---------------------------------------------------------------------------
// Native-schedule reconciliation (§5 safety net) — mirrors cloneEngine.js's
// reconcileNativeScheduledJobs() exactly. A campaign with natively_activated_at
// set is already ACTIVE on Meta with a real future start_time on every ad
// set — Meta reviews now and withholds delivery/spend on its own until that
// instant. This pass (same scheduler tick) only WATCHES: it never recreates
// or re-publishes anything. It catches a stray Meta-side pause (flips it back
// ACTIVE), surfaces a genuine Meta rejection, and — once the real start_at
// has passed — confirms delivery actually began. A campaign whose delivery
// was already confirmed on an earlier tick is skipped (no relation column
// needed: SCHEDULE_CONFIRMED_DELIVERING is written to the existing audit
// trail exactly once and checked for here, avoiding yet another schema
// migration for a single boolean).
export async function reconcileNativeScheduledLaunchCampaigns() {
  const campaigns = await prisma.ambLaunchCampaign.findMany({
    where: { natively_activated_at: { not: null }, status: 'COMPLETE' },
    include: { objects: true },
    take: 50,
  });
  if (!campaigns.length) return { checked: 0 };

  const confirmed = new Set(
    (await prisma.ambLaunchAudit.findMany({
      where: { campaign_id: { in: campaigns.map((c) => c.id) }, event: 'SCHEDULE_CONFIRMED_DELIVERING' },
      select: { campaign_id: true },
    })).map((a) => a.campaign_id)
  );
  const pending = campaigns.filter((c) => !confirmed.has(c.id));
  if (!pending.length) return { checked: campaigns.length, watching: 0 };

  let token;
  try { token = await requireLaunchToken(); } catch { return { checked: campaigns.length, skipped: 'NO_TOKEN' }; }

  let delivering = 0, rejected = 0, fixed = 0;
  for (const campaign of pending) {
    if (!campaign.meta_campaign_id) continue;
    const job = await prisma.ambLaunchJob.findUnique({ where: { job_id: campaign.job_id } });
    if (!job) continue;
    const audit = (event, detail, extra = {}) => prisma.ambLaunchAudit.create({ data: { job_id: campaign.job_id, campaign_id: campaign.id, event, detail, data_json: JSON.stringify(extra) } });
    const adsetIds = campaign.objects.filter((o) => o.level === 'ADSET' && o.status === 'CREATED').map((o) => o.destination_id);
    const adIds = campaign.objects.filter((o) => o.level === 'AD' && o.status === 'CREATED').map((o) => o.destination_id);

    let state;
    try { state = await getCloneJobLiveState(token, { campaignId: campaign.meta_campaign_id, adsetIds, adIds }); }
    catch (err) { logger.warn('AMB launch native reconcile read failed', { campaignId: campaign.id, message: err.message }); continue; }
    if (!state) continue; // transient read failure or campaign genuinely gone — never guess, just retry next tick

    if (state.reviewStatus === 'REJECTED') {
      const fb = state.rejectedFeedback ? JSON.stringify(state.rejectedFeedback).slice(0, 600) : 'بدون تفاصيل من Meta';
      await audit('SCHEDULE_NATIVE_REJECTED', `Meta رفض الإعلان بعد الجدولة الأصلية: ${fb}`);
      rejected++;
      continue;
    }

    // Safety net: something Meta shows as configured-PAUSED that we never
    // paused (e.g. a policy auto-pause, or a manual mistake) — flip it back
    // ACTIVE so the native schedule still fires. Only this campaign's own ids.
    const strays = [state.campaign, ...state.adsets, ...state.ads].filter((e) => e && (e.configuredStatus || '').toUpperCase() === 'PAUSED');
    for (const e of strays) {
      try { await setEntityStatus(token, e.id, 'ACTIVE'); fixed++; }
      catch (err) { logger.warn('AMB launch native reconcile re-activate failed', { id: e.id, message: err.message }); }
    }
    if (strays.length) await audit('SCHEDULE_NATIVE_REPAIR', `أعدنا تفعيل ${strays.length} عنصر وجدناه متوقفًا قبل الموعد المجدول.`);

    const started = job.start_at && new Date(job.start_at).getTime() <= Date.now();
    if (started && (state.deliveryStatus === 'DELIVERING' || state.reviewStatus === 'APPROVED')) {
      await audit('SCHEDULE_CONFIRMED_DELIVERING', `تأكد بدء التسليم الفعلي حسب الجدولة الأصلية (${state.deliveryStatus}) — من غير أي تدخل يدوي.`);
      delivering++;
    }
    // else: before start_at, or still IN_REVIEW at/after it — leave it be;
    // Meta delivers automatically the moment it approves and the time arrives.
  }
  if (delivering || rejected || fixed) logger.info('AMB launch native schedule reconcile', { delivering, rejected, fixed, checked: pending.length });
  return { checked: pending.length, delivering, rejected, fixed };
}
