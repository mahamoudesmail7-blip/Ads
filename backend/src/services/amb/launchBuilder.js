// Campaign Launch Builder ("رفع الكامبين") — Phase B (job/state persistence)
// + Phase C (read-only Meta asset discovery for the wizard).
//
// Phase B: the launch-job state machine, idempotent job/campaign creation,
// and the per-object idempotency map a LATER write-capable phase builds on
// — pure validation/state-transition logic or plain Prisma reads/writes
// against the amb_launch_* tables, zero Meta calls. Deliberately separate
// from cloneEngine.js's amb_clone_* tables (a launch job creates brand-new
// campaigns; a clone job copies an existing one) — see schema.prisma's
// header comment on AmbLaunchJob for the full rationale.
//
// Phase C (discoverLaunchAdAccounts / getLaunchAccountAssets below): the
// ONLY Meta calls in this file, and they are 100% read-only GETs reusing
// the EXISTING metaGraphClient.js helpers (the same ones Clone & Schedule's
// /clone/accounts and /clone/identities routes already call) through the
// SAME metaAuth.js connection — no second Meta integration, no new OAuth
// flow, no write endpoint of any kind.
import { prisma } from '../../prisma.js';
import { getConnection, getDecryptedToken } from '../metaAuth.js';
import { getAllAccessibleAdAccounts, getAccountIdentities, getAccountAssetsForClone, searchAdGeoLocations } from '../metaGraphClient.js';
import { listStores } from '../easyOrdersStores.js';

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
// Final core execution step — real ad-set targeting. 'ALL' genders and
// 'AUTOMATIC' placements are Meta's own Broad/Advantage+ defaults (omitted
// from the real payload entirely — see buildTargeting() in launchPublish.js);
// mode defaults to 'BROAD' (targeting omitted from config_json.raw entirely,
// byte-identical to every job created before this feature existed) unless
// the human explicitly opts into 'CUSTOM'.
export const ALLOWED_TARGETING_MODES = ['BROAD', 'CUSTOM'];
export const ALLOWED_GENDERS = ['ALL', 'MALE', 'FEMALE'];
export const ALLOWED_PLACEMENTS_MODES = ['AUTOMATIC', 'FEED_ONLY'];

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
 * Real IANA-timezone-aware local wall-clock -> UTC conversion, using only
 * built-in Intl (no external library, no hardcoded offset). Correct across
 * DST transitions for any real ad-account timezone (Africa/Cairo has no
 * DST, but e.g. America/New_York or Europe/London do) — the standard
 * "resolve the zone's actual UTC offset AT that wall-clock instant" pattern:
 * take the naive UTC guess, ask Intl what that zone's offset is at that
 * instant, then correct by exactly that offset. Never trusts a frontend-
 * computed UTC value or a static +N hours assumption — this is the single
 * authoritative place a launch's requested local start time becomes UTC.
 */
export function localWallClockToUtcDate(dateStr, timeStr, ianaTimeZone) {
  const [Y, M, D] = String(dateStr || '').split('-').map(Number);
  const [h, mi] = String(timeStr || '00:00').split(':').map(Number);
  if (!Y || !M || !D) return null;
  const tz = ianaTimeZone || 'UTC';
  const naiveUtcMs = Date.UTC(Y, M - 1, D, h || 0, mi || 0, 0);
  let offsetMinutes = 0;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(naiveUtcMs)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const hour24 = parts.hour === '24' ? '00' : parts.hour; // Intl sometimes renders midnight as "24" in hour12:false
    const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(hour24), Number(parts.minute), Number(parts.second));
    offsetMinutes = (asIfUtc - naiveUtcMs) / 60000;
  } catch {
    return null; // an unrecognized IANA zone name — caller must fail validation rather than silently guess an offset
  }
  return new Date(naiveUtcMs - offsetMinutes * 60000);
}

export const ALLOWED_LAUNCH_MODES = ['NOW', 'SCHEDULED', 'PAUSED_REVIEW'];
export const ALLOWED_BIDDING_MODES = ['AUTOMATIC', 'BID_CAP'];

// Heuristic build-time estimate for the lead-time protection check — never
// a guaranteed exact timing (real Meta latency varies), just a conservative
// bound used to decide "is the requested schedule even reachable". Reflects
// the bounded-concurrency publish engine: independent ad sets within one
// campaign build CONCURRENCY_LIMIT at a time, each ad set's own ads also
// bounded-concurrent; only campaigns themselves are strictly sequential
// (plus the mandatory 5-minute gap between them).
export const LAUNCH_CONCURRENCY_LIMIT = 5;
const AVG_META_CALL_MS = 900; // one real Graph API write, conservatively
const FIXED_OVERHEAD_MS = 15_000; // campaign creation + live verification + reconciliation reads
const SAFETY_BUFFER_MS = 5 * 60_000; // never cut it exactly to the wire

export function estimateLaunchBuildMs({ campaignCount, adSetsPerCampaign, adsPerAdSet }) {
  // Per campaign: 1 campaign create (sequential) + ad sets in bounded-concurrent
  // batches, each batch's ads also bounded-concurrent (creative + ad = 2 calls/ad).
  const adSetBatches = Math.ceil(adSetsPerCampaign / LAUNCH_CONCURRENCY_LIMIT);
  const adBatchesPerAdSet = Math.ceil(adsPerAdSet / LAUNCH_CONCURRENCY_LIMIT);
  const perCampaignMs = AVG_META_CALL_MS // campaign
    + adSetBatches * AVG_META_CALL_MS // ad set batches
    + adSetsPerCampaign * adBatchesPerAdSet * AVG_META_CALL_MS * 2 // each ad set's own ad batches (creative + ad per call-pair)
    + FIXED_OVERHEAD_MS;
  const interCampaignGateMs = Math.max(0, campaignCount - 1) * 5 * 60_000;
  return campaignCount * perCampaignMs + interCampaignGateMs + SAFETY_BUFFER_MS;
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
export async function validateLaunchConfig(input) {
  const cfg = input && typeof input === 'object' ? input : {};
  if (!cfg.adAccountId || typeof cfg.adAccountId !== 'string') fail('لازم تختار حساب إعلاني.');

  // Smart Decision Center Phase 1 — Product is the root entity. Never
  // inferred from a campaign name (that matching is historical-review only,
  // per the standing rule); the human picks it explicitly at Step 1, and it
  // is re-verified here against the real DB row rather than trusted as-is
  // from the frontend — same "never trust the frontend for anything
  // consequential" principle already used for schedule/timezone below.
  const productId = Number(cfg.productId);
  if (!Number.isInteger(productId) || productId <= 0) fail('لازم تختار منتج.');
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, active: true, is_historical: true, store_id: true } });
  if (!product || !product.active || product.is_historical) fail('المنتج المختار غير صالح أو غير نشط.');
  if (cfg.storeId && product.store_id && product.store_id !== cfg.storeId) fail('المنتج المختار لا يخص هذا المتجر.');
  if (!ALLOWED_BUDGET_MODES.includes(cfg.budgetMode)) fail('نوع الميزانية لازم يكون CBO أو ABO.');
  if (!ALLOWED_CONVERSION_EVENTS.includes(cfg.conversionEvent || 'PURCHASE')) fail('حدث التحويل غير مدعوم.');

  const platforms = Array.isArray(cfg.platforms) && cfg.platforms.length ? cfg.platforms : ['facebook', 'instagram'];
  if (!platforms.every((p) => ALLOWED_PLATFORMS.includes(p))) fail('المنصات المسموح بها فيسبوك وإنستجرام فقط في هذه النسخة.');
  // Real production bug: Instagram checked in the wizard but no real
  // Instagram identity resolved silently fell back to Facebook-only ads,
  // requiring a manual "Add Instagram placement" fix in Ads Manager after
  // the fact. Never allowed again — block here instead.
  if (platforms.includes('instagram') && !cfg.instagramId) fail('اخترت إنستجرام كمنصة لكن لسه معملتش اختيار حساب إنستجرام حقيقي متصل بالصفحة.');

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
    // Authoritative path: raw local date/time + the real ad account's IANA
    // timezone name (never trusted pre-converted from the frontend — that
    // was the actual root cause of a real production bug where the
    // requested midnight became an unrelated afternoon time). Falls back to
    // accepting an already-computed ISO instant only for older/internal
    // callers (test scripts) that construct a config directly.
    if (cfg.startDate && cfg.startTime) {
      const tz = cfg.timezone || 'Africa/Cairo';
      startAt = localWallClockToUtcDate(cfg.startDate, cfg.startTime, tz);
      if (!startAt) fail('منطقة توقيت الحساب الإعلاني غير معروفة — تعذّر حساب موعد البدء.');
    } else if (cfg.startAt) {
      startAt = new Date(cfg.startAt);
    } else {
      fail('لازم تحدد تاريخ ووقت بدء الاختبار، أو تختار "تشغيل الآن".');
    }
    if (!startAt || Number.isNaN(startAt.getTime())) fail('تاريخ/وقت البدء غير صالح.');
  }

  const launchMode = ALLOWED_LAUNCH_MODES.includes(cfg.launchMode) ? cfg.launchMode : 'PAUSED_REVIEW';
  if (launchMode === 'SCHEDULED' && startMode !== 'SCHEDULED') fail('وضع "تشغيل في موعد محدد" محتاج تحديد تاريخ ووقت بدء فعلي.');
  if (launchMode === 'SCHEDULED' && startAt) {
    // Lead-time protection: never let Meta silently replace an unreachable
    // requested start with "now" (confirmed live elsewhere in this file —
    // Meta ignores a past start_time outright). A heuristic, clearly-bounded
    // estimate of how long this exact launch will take to BUILD, compared
    // against how far away the requested moment actually is.
    const neededMs = estimateLaunchBuildMs({ campaignCount, adSetsPerCampaign, adsPerAdSet });
    const availableMs = startAt.getTime() - Date.now();
    if (availableMs < neededMs) {
      const neededMin = Math.ceil(neededMs / 60_000);
      fail(`الموعد المطلوب قريب جدًا — الطلب ده (${campaignCount} كامبين، ${adSetsPerCampaign * campaignCount} Ad Set، ${adSetsPerCampaign * adsPerAdSet * campaignCount} إعلان) محتاج حوالي ${neededMin} دقيقة على الأقل عشان يتبني بالكامل قبل الموعد. اختار موعد بعيد شوية، أو قلل عدد العناصر.`);
    }
  }

  const bidding = cfg.bidding && ALLOWED_BIDDING_MODES.includes(cfg.bidding.mode) && cfg.bidding.mode === 'BID_CAP'
    ? { mode: 'BID_CAP', bidCapMinor: Number(cfg.bidding.bidCapMinor) > 0 ? Number(cfg.bidding.bidCapMinor) : null }
    : { mode: 'AUTOMATIC' };
  if (bidding.mode === 'BID_CAP' && !bidding.bidCapMinor) fail('لازم تحدد قيمة حد أقصى للمزايدة أكبر من صفر، أو اختار "تلقائي".');

  const targeting = validateTargeting(cfg.targeting);

  return {
    productId: product.id,
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
    launchMode,
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
      bidding,
      targeting,
    },
  };
}

/**
 * Real Meta ad-set targeting override — validated the same "fail fast, in
 * Arabic, before any DB write" way as everything else in this function.
 * Returns null for BROAD (or an absent/malformed input) — buildTargeting()
 * in launchPublish.js treats null EXACTLY as it always has (Egypt-wide,
 * Broad age/gender, Advantage+ automatic placements), so every job that
 * never touches this feature is completely unaffected.
 */
function validateTargeting(t) {
  if (!t || t.mode !== 'CUSTOM') return null;
  const genders = ALLOWED_GENDERS.includes(t.genders) ? t.genders : 'ALL';
  let ageMin = Number.isInteger(Number(t.ageMin)) ? Number(t.ageMin) : 18;
  let ageMax = Number.isInteger(Number(t.ageMax)) ? Number(t.ageMax) : 65;
  ageMin = Math.min(65, Math.max(13, ageMin)); // Meta's own real bounds for age_min/age_max
  ageMax = Math.min(65, Math.max(13, ageMax));
  if (ageMin > ageMax) fail('نطاق العمر المستهدف غير صالح — الحد الأدنى أكبر من الحد الأقصى.');
  const geoRegions = Array.isArray(t.geoRegions)
    ? t.geoRegions.filter((r) => r && typeof r.key === 'string' && r.key).map((r) => ({ key: r.key, name: r.name || r.key }))
    : [];
  const placementsMode = ALLOWED_PLACEMENTS_MODES.includes(t.placementsMode) ? t.placementsMode : 'AUTOMATIC';
  return { mode: 'CUSTOM', genders, ageMin, ageMax, geoRegions, placementsMode };
}

/**
 * Idempotent by jobId — a double-click, a refreshed page re-submitting the
 * SAME final wizard state, or a resumed session all land here with the
 * SAME client-generated jobId and get back the exact same job untouched,
 * never a second row or a second validation pass — but ONLY once that job
 * has actually been finalized (has real campaign rows). A bare shell row
 * from startLaunchJob() below (created early so video uploads have a real
 * job to attach to, before the rest of the wizard is filled in) has zero
 * campaigns yet, so it gets validated and turned into a real job here
 * exactly once — this is the ONE case where an "existing" row still gets
 * written to, and it never re-runs for a job that already has campaigns.
 */
export async function createDraftJob({ jobId, userId, input }) {
  if (!jobId || typeof jobId !== 'string' || !/^[a-z0-9_-]{8,80}$/i.test(jobId)) fail('jobId غير صالح.');

  const existing = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId }, include: { campaigns: true } });
  if (existing && existing.campaigns.length > 0) return existing;

  const v = await validateLaunchConfig(input);
  const data = {
    product_id: v.productId,
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
    launch_mode: v.launchMode,
    timezone: v.timezone,
    config_json: JSON.stringify(v.raw),
  };

  return prisma.$transaction(async (tx) => {
    const job = existing
      ? await tx.ambLaunchJob.update({ where: { job_id: jobId }, data })
      : await tx.ambLaunchJob.create({ data: { job_id: jobId, status: 'DRAFT', created_by_id: userId || null, ...data } });
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
      data: { job_id: job.job_id, event: 'JOB_CREATED', actor_id: userId || null, detail: `تم ${existing ? 'استكمال' : 'إنشاء'} طلب رفع كامبين بـ ${v.campaignCount} كامبين(ات).` },
    });
    return tx.ambLaunchJob.findUnique({ where: { job_id: job.job_id }, include: { campaigns: { orderBy: { index: 'asc' } } } });
  });
}

/**
 * Creates the bare-minimum AmbLaunchJob row so video uploads (Phase E) have
 * a real job_id to attach to before the rest of the wizard (budget, pixel,
 * campaigns) is filled in — those still-missing fields are NOT required
 * here and are only ever validated/written by createDraftJob() above, once
 * the owner reaches Review. Idempotent by jobId like every other launch
 * entry point: calling this again for the same jobId (a page reload while
 * still on the videos step) just returns the existing shell untouched.
 */
export async function startLaunchJob({ jobId, userId, adAccountId, adAccountName, productId }) {
  if (!jobId || typeof jobId !== 'string' || !/^[a-z0-9_-]{8,80}$/i.test(jobId)) fail('jobId غير صالح.');
  if (!adAccountId || typeof adAccountId !== 'string') fail('لازم تختار حساب إعلاني.');

  const existing = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId } });
  if (existing) return existing;

  // productId is optional here (the shell row exists purely so video uploads
  // have somewhere to attach before the rest of the wizard is filled in) —
  // real enforcement happens later in validateLaunchConfig()/createDraftJob()
  // at Review. Still persisted immediately when already known so a product
  // picked at Step 1 survives even if the owner uploads videos before
  // reaching Review — never re-derived or guessed, just carried through.
  const pid = Number(productId);
  return prisma.$transaction(async (tx) => {
    const job = await tx.ambLaunchJob.create({
      data: { job_id: jobId, ad_account_id: adAccountId, ad_account_name: adAccountName || null, product_id: Number.isInteger(pid) && pid > 0 ? pid : null, budget_mode: 'CBO', config_json: '{}', status: 'DRAFT', created_by_id: userId || null },
    });
    await tx.ambLaunchAudit.create({ data: { job_id: job.job_id, event: 'JOB_CREATED', actor_id: userId || null, detail: 'بدء طلب رفع كامبين — مسودة أولية لاستضافة الفيديوهات.' } });
    return job;
  });
}

export async function getJob(jobId) {
  return prisma.ambLaunchJob.findUnique({
    where: { job_id: jobId },
    include: {
      campaigns: { orderBy: { index: 'asc' }, include: { objects: true } },
      videos: { orderBy: { slot_key: 'asc' } },
      images: { orderBy: { slot_key: 'asc' } },
      audits: { orderBy: { created_at: 'desc' }, take: 100 },
    },
  });
}

/** Used by both the launch list route and the "الحملات السابقة" history panel — every scalar job field (name/budget/schedule all live there) plus enough per-campaign detail (name/status/human_action_required) to render a real summary without a second round-trip per job. */
export async function listJobs({ limit = 25, cursor } = {}) {
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return prisma.ambLaunchJob.findMany({
    take,
    ...(cursor ? { skip: 1, cursor: { id: Number(cursor) } } : {}),
    orderBy: { created_at: 'desc' },
    include: { campaigns: { select: { id: true, index: true, name: true, status: true, human_action_required: true }, orderBy: { index: 'asc' } } },
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
export async function registerVideoSlot({ jobId, slotKey, originalFilename, contentHash = null, sizeBytes = null, mimeType = null, durationSeconds = null }) {
  const existing = await prisma.ambLaunchVideoAsset.findUnique({ where: { job_id_slot_key: { job_id: jobId, slot_key: slotKey } } });
  const row = existing || await prisma.ambLaunchVideoAsset.create({
    data: { job_id: jobId, slot_key: slotKey, original_filename: originalFilename, content_hash: contentHash, size_bytes: sizeBytes, mime_type: mimeType, duration_seconds: durationSeconds, status: 'PENDING' },
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

/**
 * Permanently drops one video slot's row. Needed because the Review step's
 * syncLaunchVideosFromBackend({force:true}) merges by slot_key — a slot the
 * user removed only client-side (the ✕ button, before this existed) would
 * get silently RESURRECTED as soon as Review re-synced, since the row still
 * existed on the backend. Never touches a slot that already succeeded
 * (status UPLOADED) unless the caller explicitly means to discard a real
 * uploaded Meta video, which the frontend's remove button never does once
 * a slot is UPLOADED (it only offers ✕ for PENDING/FAILED/VALIDATING).
 */
export async function deleteVideoSlot({ jobId, slotKey }) {
  await prisma.ambLaunchVideoAsset.deleteMany({ where: { job_id: jobId, slot_key: slotKey } });
  return { deleted: true };
}

// Image counterparts — exact mirror of the 3 functions above, own table
// (amb_launch_image_assets), own slot_key namespace ("I1".."In", never
// colliding with videos' "C1".."Cn"). Added so the Launch Builder's
// "الفيديوهات" step can accept images alongside videos in the same
// dropzone (explicit request — mixed creative pool, not a separate step).
export const IMAGE_STATUSES = ['PENDING', 'VALIDATING', 'UPLOADING', 'UPLOADED', 'FAILED'];

export async function registerImageSlot({ jobId, slotKey, originalFilename, contentHash = null, sizeBytes = null, mimeType = null, width = null, height = null }) {
  const existing = await prisma.ambLaunchImageAsset.findUnique({ where: { job_id_slot_key: { job_id: jobId, slot_key: slotKey } } });
  const row = existing || await prisma.ambLaunchImageAsset.create({
    data: { job_id: jobId, slot_key: slotKey, original_filename: originalFilename, content_hash: contentHash, size_bytes: sizeBytes, mime_type: mimeType, width, height, status: 'PENDING' },
  });
  let duplicateOfSlotKey = null;
  if (contentHash) {
    const dup = await prisma.ambLaunchImageAsset.findFirst({ where: { job_id: jobId, content_hash: contentHash, slot_key: { not: slotKey } }, orderBy: { id: 'asc' } });
    if (dup) duplicateOfSlotKey = dup.slot_key;
  }
  return { row, duplicateOfSlotKey };
}

export async function markImageResult({ jobId, slotKey, status, metaImageHash = null, error = null }) {
  if (!IMAGE_STATUSES.includes(status)) fail(`حالة غير معروفة: ${status}`);
  return prisma.ambLaunchImageAsset.update({
    where: { job_id_slot_key: { job_id: jobId, slot_key: slotKey } },
    data: { status, meta_image_hash: metaImageHash, error },
  });
}

export async function deleteImageSlot({ jobId, slotKey }) {
  await prisma.ambLaunchImageAsset.deleteMany({ where: { job_id: jobId, slot_key: slotKey } });
  return { deleted: true };
}

/**
 * Smart Decision Center Phase 1 — the wizard's new Step 1 "المنتج" list.
 * Plain DB reads only, zero Meta calls. A store-tagged product only shows
 * for its own store; an untagged (legacy, pre-multi-store) product shows for
 * every store — the exact same backward-compatible convention already
 * documented on Product.store_id itself. This is a UI convenience list, not
 * the authorization boundary: the real enforcement happens server-side in
 * validateLaunchConfig() below, which never trusts a productId the frontend
 * sends just because it appeared in this list.
 */
export async function listLaunchStores() {
  return listStores();
}

export async function listLaunchableProducts({ storeId } = {}) {
  const where = { active: true, is_historical: false };
  if (storeId) where.OR = [{ store_id: storeId }, { store_id: null }];
  return prisma.product.findMany({
    where,
    select: { id: true, product_name: true, sku: true, store_id: true, easy_orders_uuid: true },
    orderBy: { created_at: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Phase C — read-only Meta asset discovery for the wizard. Every function
// below only ever GETs from Meta; none of them create/update/delete
// anything on Meta or in our own DB.
// ---------------------------------------------------------------------------

/** Same connection-required guard as cloneEngine.js's private helper — kept local rather than imported so this file never depends on cloneEngine.js's internals. */
async function requireConnectedToken() {
  const connection = await getConnection();
  if (!connection || connection.status !== 'CONNECTED') { const e = new Error('اربط حساب Meta Ads الأول.'); e.status = 400; throw e; }
  return { connection, token: await getDecryptedToken() };
}

/**
 * Every real Meta ad account this connection is authorized to manage —
 * "Ahmed Samy / Account 2 / Account 3" in the wizard's step 1. Reuses the
 * exact same getAllAccessibleAdAccounts() helper Clone & Schedule's
 * /clone/accounts already calls — already returns id, name, currency,
 * account status, and timezone per account, so this step alone covers the
 * wizard's account/currency/timezone requirements with zero new Graph
 * calls invented.
 */
export async function discoverLaunchAdAccounts() {
  const { connection, token } = await requireConnectedToken();
  const accounts = await getAllAccessibleAdAccounts(token);
  return { accounts, selectedAdAccountId: connection.selected_ad_account_id || null };
}

/**
 * Everything the wizard's "Platforms, Page & Pixel" step needs for ONE
 * selected ad account, in a single call: real Facebook Pages + Instagram
 * identities (with per-item source/verified provenance, and account-level
 * pagesVerified/instagramReadable status flags — the "relevant account/page
 * status and permissions" the wizard needs to show), plus the account's own
 * status/currency/timezone and its real Pixels/Datasets. Composed entirely
 * from getAccountIdentities() and getAccountAssetsForClone() — the same
 * calls the Clone & Schedule feature already makes for the same purpose —
 * never a new Graph API surface.
 */
export async function getLaunchAccountAssets(adAccountId) {
  if (!adAccountId || typeof adAccountId !== 'string') fail('adAccountId مطلوب.');
  const { token } = await requireConnectedToken();
  const [identities, assets] = await Promise.all([
    getAccountIdentities(token, adAccountId),
    getAccountAssetsForClone(token, adAccountId),
  ]);
  return {
    account: assets.account, // { id, name, status, timezoneName, currency }
    pages: identities.pages, // [{ id, name, source, verified }]
    instagram: identities.instagram, // [{ id, username }]
    pixels: assets.pixels, // [{ id, name }]
    pagesVerified: identities.pagesVerified,
    instagramReadable: identities.instagramReadable,
  };
}

/**
 * Real Meta region-targeting keys for a governorate/city name search — the
 * wizard's "🎯 الجمهور والمواضع" step search-as-you-type control, and the
 * Action Plan handoff's own one-time resolution of an evidence-backed
 * governorate. Never a hardcoded id table (Meta assigns these internally;
 * there is no stable public mapping to invent from) — always a real,
 * read-only Graph call.
 */
export async function searchLaunchGeoLocations(q) {
  if (!q || typeof q !== 'string' || !q.trim()) return [];
  const { token } = await requireConnectedToken();
  return searchAdGeoLocations(token, { q: q.trim(), countryCode: 'EG' });
}
