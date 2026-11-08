// TikTok Ads — pure validation + payload building. No network, no DB: a wizard config goes in, either a list of PLAIN-ARABIC problems or the exact request bodies for
// campaign/create, adgroup/create and ad/create come out. This is what the tests pin down and what the review screen shows before anything is sent.
import {
  API, OBJECTIVES, EVENTS, CTAS, AGE_GROUPS, GENDERS, LANGUAGES, OPERATING_SYSTEMS, LOCATIONS, LIMITS, BID_STRATEGIES, RUN_MODES, BUDGET_LEVELS, PLACEMENTS, defaultConfig,
} from './spec.js';

const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : NaN; };
const str = (v) => String(v ?? '').trim();
const isHttps = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && !!x.hostname; } catch { return false; } };
const pad = (n) => String(n).padStart(2, '0');

/** Wall-clock "YYYY-MM-DD" + "HH:MM" in an IANA time zone → UTC Date (or null). Two passes handle DST edges. */
export function zonedToUtc(dateStr, timeStr, timeZone = 'Africa/Cairo') {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); const t = String(timeStr || '00:00').match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !t) return null;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
  let fmt; try { fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return null; }
  const offsetAt = (ms) => { const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms; };
  let ms = want - offsetAt(want); ms = want - offsetAt(ms);
  const d = new Date(ms); return Number.isNaN(d.getTime()) ? null : d;
}
/** UTC Date → TikTok's "YYYY-MM-DD HH:MM:SS". */
export const tiktokTime = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

/** Clean a raw (possibly half-filled, hand-edited) config into the exact shape the builder expects. Never throws. */
export function normalizeConfig(raw) {
  const d = defaultConfig(); const c = raw && typeof raw === 'object' ? raw : {};
  const list = (v, allowed) => [...new Set((Array.isArray(v) ? v : []).map(String).filter((x) => !allowed || allowed.includes(x)))];
  return {
    name: str(c.name).slice(0, LIMITS.nameMax),
    objective: OBJECTIVES[c.objective] ? c.objective : d.objective,
    event: EVENTS[c.event] ? c.event : d.event,
    pixelId: str(c.pixelId).slice(0, 40),
    landingUrl: str(c.landingUrl),
    displayName: str(c.displayName).slice(0, LIMITS.displayNameMax),
    adText: str(c.adText).slice(0, 300),
    cta: CTAS[c.cta] ? c.cta : d.cta,
    identity: { mode: c.identity?.mode === 'EXISTING' ? 'EXISTING' : 'NEW', id: str(c.identity?.id).slice(0, 80) },
    videos: (Array.isArray(c.videos) ? c.videos : []).map((v) => ({ url: str(v?.url), videoId: str(v?.videoId), name: str(v?.name).slice(0, 120) })).filter((v) => v.url || v.videoId).slice(0, LIMITS.maxVideos + 5),
    locations: list(c.locations, Object.keys(LOCATIONS)),
    ageGroups: list(c.ageGroups, Object.keys(AGE_GROUPS)),
    gender: GENDERS[c.gender] ? c.gender : d.gender,
    languages: list(c.languages, Object.keys(LANGUAGES)),
    operatingSystems: list(c.operatingSystems, Object.keys(OPERATING_SYSTEMS)),
    interestIds: list(c.interestIds).slice(0, 50),
    placement: PLACEMENTS[c.placement] ? c.placement : d.placement,
    budgetLevel: BUDGET_LEVELS[c.budgetLevel] ? c.budgetLevel : d.budgetLevel,
    dailyBudget: c.dailyBudget === '' || c.dailyBudget == null ? '' : num(c.dailyBudget),
    bidStrategy: BID_STRATEGIES[c.bidStrategy] ? c.bidStrategy : d.bidStrategy,
    bidAmount: c.bidAmount === '' || c.bidAmount == null ? '' : num(c.bidAmount),
    runMode: RUN_MODES[c.runMode] ? c.runMode : d.runMode,
    startDate: str(c.startDate), startTime: /^\d{1,2}:\d{2}$/.test(str(c.startTime)) ? str(c.startTime) : '00:00', endDate: str(c.endDate),
    commentsOff: !!c.commentsOff, downloadOff: !!c.downloadOff, shareOff: !!c.shareOff,
    adsPerVideo: Math.min(3, Math.max(1, Math.round(num(c.adsPerVideo)) || 1)),
  };
}

/**
 * Everything wrong (errors — launch is blocked) and everything worth knowing (warnings — launch allowed) about a config, in plain Arabic.
 * ctx: { timeZone, now: Date, currency }.
 */
export function validateConfig(raw, ctx = {}) {
  const c = normalizeConfig(raw); const o = OBJECTIVES[c.objective]; const errors = []; const warnings = [];
  const err = (field, message) => errors.push({ field, message }); const warn = (field, message) => warnings.push({ field, message });
  const now = ctx.now instanceof Date ? ctx.now : new Date(); const tz = ctx.timeZone || 'Africa/Cairo';

  if (c.name.length < 2) err('name', 'اكتب اسم للكامبين (حرفين على الأقل).');
  if (o.needsLanding) { if (!c.landingUrl) err('landingUrl', 'حط لينك صفحة المنتج اللي الإعلان هيودّي عليها.'); else if (!isHttps(c.landingUrl)) err('landingUrl', 'اللينك لازم يبدأ بـ https:// ويكون صحيح.'); }
  else if (c.landingUrl && !isHttps(c.landingUrl)) err('landingUrl', 'اللينك لازم يبدأ بـ https:// ويكون صحيح.');
  if (o.needsPixel) { if (!c.pixelId) err('pixelId', 'اختار الـ Pixel — من غيره تيك توك مش هيعرف يحسب الأوردرات.'); if (!c.event) err('event', 'اختار الحدث اللي بنحسّنه (مثلًا إتمام الطلب).'); }
  if (o.needsExtra === 'instantForm') err('objective', 'هدف «عملاء محتملين» محتاج Instant Form جاهز على حسابك — لسه مش مدعوم هنا. اختار هدف تاني.');

  // creative
  if (c.identity.mode === 'NEW') { if (!c.displayName) err('displayName', 'اكتب اسم البراند اللي هيظهر فوق الإعلان (حد أقصى 40 حرف).'); }
  else if (!c.identity.id) err('identity', 'اختار حساب الهوية (الحساب اللي هينزل منه الإعلان).');
  if (c.adText.length < LIMITS.adTextMin) err('adText', 'اكتب نص الإعلان.');
  else if (c.adText.length > LIMITS.adTextMax) err('adText', `نص الإعلان أطول من ${LIMITS.adTextMax} حرف (تيك توك بيرفضه).`);
  else if (c.adText.length > 80) warn('adText', 'نص الإعلان طويل — الأقصر (أقل من 50 حرف) بيتقرا أحسن على تيك توك.');
  if (!c.videos.length) err('videos', 'ضيف فيديو واحد على الأقل (لينك فيديو أو فيديو من مكتبتك).');
  if (c.videos.length > LIMITS.maxVideos) err('videos', `أقصى عدد ${LIMITS.maxVideos} فيديوهات في الكامبين.`);
  c.videos.forEach((v, i) => { if (v.url && !isHttps(v.url)) err('videos', `الفيديو رقم ${i + 1}: اللينك لازم https:// ومباشر على ملف الفيديو.`); if (!v.url && !v.videoId) err('videos', `الفيديو رقم ${i + 1} فاضي.`); });
  if (c.videos.length === 1) warn('videos', 'فيديو واحد بس. الأفضل 2–3 فيديوهات مختلفة عشان تيك توك يختبرهم ويكمّل على الأقوى.');
  if (c.videos.length * c.adsPerVideo > LIMITS.maxAdsPerGroup) err('adsPerVideo', `عدد الإعلانات (${c.videos.length * c.adsPerVideo}) أكبر من ${LIMITS.maxAdsPerGroup} في المجموعة الواحدة.`);

  // audience
  if (!c.locations.length) err('locations', 'اختار بلد واحد على الأقل.');
  if (!c.ageGroups.length) err('ageGroups', 'اختار فئة عمرية واحدة على الأقل.');
  if (c.ageGroups.includes('AGE_13_17')) warn('ageGroups', 'اخترت 13–17 سنة. إعلانات المنتجات للقاصرين بتتقيّد على تيك توك — الأفضل تشيلها.');
  if (c.ageGroups.length && !c.languages.length) warn('languages', 'من غير لغة محددة الإعلان هيظهر لكل اللغات. لو جمهورك عربي اختار العربية.');

  // money
  const b = num(c.dailyBudget);
  if (c.dailyBudget === '' || Number.isNaN(b)) err('dailyBudget', 'اكتب الميزانية اليومية.');
  else if (b < LIMITS.budgetMin) err('dailyBudget', 'الميزانية اليومية لازم تكون أكبر من صفر.');
  else if (b > LIMITS.budgetMax) err('dailyBudget', 'الميزانية اليومية كبيرة بشكل غير طبيعي — راجع الرقم.');
  else if (ctx.currency === 'EGP' && b < 500) warn('dailyBudget', 'تيك توك بيطلب حد أدنى للميزانية اليومية حسب العملة (غالبًا حوالي 20 دولار). لو الرقم أقل منه هيرفضه وهتشوف السبب.');
  if (c.bidStrategy === 'COST_CAP') {
    if (o.bidKind === 'none') err('bidStrategy', 'هدف الوصول مش بيدعم سقف التكلفة. اختار «أقل تكلفة».');
    else if (!(num(c.bidAmount) >= LIMITS.bidMin)) err('bidAmount', 'اكتب سقف التكلفة (أقصى تكلفة للنتيجة).');
    else if (Number.isFinite(b) && num(c.bidAmount) > b) warn('bidAmount', 'سقف التكلفة أعلى من الميزانية اليومية — راجع الرقم.');
  }

  // timing
  if (c.runMode === 'SCHEDULED') {
    const start = zonedToUtc(c.startDate, c.startTime, tz);
    if (!start) err('startDate', 'اختار تاريخ ووقت البداية.');
    else if (start.getTime() <= now.getTime() + 5 * 60_000) err('startDate', 'ميعاد البداية لازم يكون في المستقبل (على الأقل بعد 5 دقايق).');
    if (c.endDate) { const end = zonedToUtc(c.endDate, '23:59', tz); if (!end || (start && end.getTime() <= start.getTime())) err('endDate', 'تاريخ النهاية لازم يكون بعد البداية.'); }
  }
  if (c.runMode === 'NOW') warn('runMode', 'الكامبين هيبدأ الصرف أول ما تيك توك تراجعه. لو مش متأكد اختار «موقوف» وشغّله بعد المراجعة.');

  return { ok: errors.length === 0, errors, warnings, config: c };
}

// ------------------------------------------------------------------ payloads
export function buildCampaignPayload(raw, { advertiserId }) {
  const c = normalizeConfig(raw); const o = OBJECTIVES[c.objective]; const cbo = c.budgetLevel === 'CAMPAIGN';
  const p = {
    advertiser_id: advertiserId, campaign_name: c.name, objective_type: o.apiObjective, campaign_type: API.campaignType,
    budget_mode: cbo ? API.budgetMode.DAY : API.budgetMode.INFINITE,
    operation_status: API.operationStatus.OFF, // ALWAYS created disabled; enabling is a separate, explicit step
  };
  if (cbo) { p.budget = num(c.dailyBudget); p.budget_optimize_on = true; }
  return p;
}

export function buildAdGroupPayload(raw, { advertiserId, campaignId, timeZone = 'Africa/Cairo', now = new Date() }) {
  const c = normalizeConfig(raw); const o = OBJECTIVES[c.objective]; const cbo = c.budgetLevel === 'CAMPAIGN';
  const p = {
    advertiser_id: advertiserId, campaign_id: campaignId, adgroup_name: c.name,
    promotion_type: API.promotionType,
    placement_type: c.placement === 'AUTO' ? API.placementType.AUTO : API.placementType.MANUAL,
    location_ids: c.locations, age_groups: c.ageGroups, gender: API.gender[c.gender],
    optimization_goal: o.goal, billing_event: o.billing, pacing: API.pacing,
    operation_status: API.operationStatus.OFF,
    comment_disabled: c.commentsOff, video_download_disabled: c.downloadOff, share_disabled: c.shareOff,
  };
  if (c.placement === 'TIKTOK_ONLY') p.placements = [API.placements.TIKTOK];
  if (c.languages.length) p.languages = c.languages;
  if (c.operatingSystems.length) p.operating_systems = c.operatingSystems;
  if (c.interestIds.length) p.interest_category_ids = c.interestIds;
  if (o.needsPixel) { p.pixel_id = c.pixelId; p.optimization_event = EVENTS[c.event].api; }
  if (!cbo) { p.budget_mode = API.budgetMode.DAY; p.budget = num(c.dailyBudget); }
  // bidding: lowest cost = no bid fields; cost cap = a custom bid on the right field for the goal
  if (c.bidStrategy === 'COST_CAP' && o.bidKind !== 'none') {
    p.bid_type = API.bidType.CUSTOM;
    if (o.bidKind === 'conversion') p.conversion_bid_price = num(c.bidAmount); else p.bid_price = num(c.bidAmount);
  } else if (o.bidKind !== 'none') p.bid_type = API.bidType.NO_BID;
  // schedule (UTC, as TikTok expects)
  if (c.runMode === 'SCHEDULED') {
    p.schedule_type = c.endDate ? API.scheduleType.START_END : API.scheduleType.FROM_NOW;
    p.schedule_start_time = tiktokTime(zonedToUtc(c.startDate, c.startTime, timeZone));
    if (c.endDate) p.schedule_end_time = tiktokTime(zonedToUtc(c.endDate, '23:59', timeZone));
  } else { p.schedule_type = API.scheduleType.FROM_NOW; p.schedule_start_time = tiktokTime(new Date(now.getTime() + 60_000)); }
  return p;
}

/** One ad per (video × adsPerVideo). `uploads` = [{ videoId, coverImageId, name }] in the same order as config.videos. */
export function buildAdPayload(raw, { advertiserId, adgroupId, identityId, uploads }) {
  const c = normalizeConfig(raw); const o = OBJECTIVES[c.objective]; const creatives = [];
  uploads.forEach((u, vi) => {
    for (let k = 0; k < c.adsPerVideo; k++) {
      const cr = {
        ad_name: `${c.name} | ${u.name || `فيديو ${vi + 1}`}${c.adsPerVideo > 1 ? ` #${k + 1}` : ''}`.slice(0, 512),
        ad_format: API.adFormat, video_id: u.videoId, ad_text: c.adText,
        identity_type: API.identityType, identity_id: identityId, call_to_action: c.cta,
      };
      if (u.coverImageId) cr.image_ids = [u.coverImageId];
      if (o.needsLanding || c.landingUrl) cr.landing_page_url = c.landingUrl;
      creatives.push(cr);
    }
  });
  return { advertiser_id: advertiserId, adgroup_id: adgroupId, creatives };
}

/** A short plain-Arabic description of what will be created — shown on the review step. */
export function summarize(raw, ctx = {}) {
  const c = normalizeConfig(raw); const o = OBJECTIVES[c.objective]; const tz = ctx.timeZone || 'Africa/Cairo';
  const budget = num(c.dailyBudget);
  const when = c.runMode === 'SCHEDULED' ? `يبدأ ${c.startDate} ${c.startTime} (${tz})${c.endDate ? ` وينتهي ${c.endDate}` : ''}` : c.runMode === 'NOW' ? 'يبدأ فور مراجعة تيك توك' : 'موقوف — تشغّله بإيدك';
  return [
    ['الاسم', c.name || '—'], ['الهدف', `${o.emoji} ${o.label}`],
    ['البلاد', c.locations.map((id) => LOCATIONS[id]?.label || id).join('، ') || '—'],
    ['الأعمار', c.ageGroups.map((a) => AGE_GROUPS[a]).join('، ') || '—'], ['النوع', GENDERS[c.gender]],
    ['اللغة', c.languages.map((l) => LANGUAGES[l]).join('، ') || 'الكل'],
    ['الميزانية', Number.isFinite(budget) ? `${budget} ${ctx.currency || ''}/يوم (${c.budgetLevel === 'CAMPAIGN' ? 'على الحملة' : 'على المجموعة'})` : '—'],
    ['المزايدة', BID_STRATEGIES[c.bidStrategy].label + (c.bidStrategy === 'COST_CAP' ? ` — ${c.bidAmount}` : '')],
    ['الفيديوهات', `${c.videos.length} فيديو → ${c.videos.length * c.adsPerVideo} إعلان`],
    ['التشغيل', when],
  ];
}
