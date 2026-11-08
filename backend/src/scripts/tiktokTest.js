// 🧪 TikTok campaigns — validation, payloads (field names TikTok v1.3 expects), the in-memory TikTok, the launch flow (resume / no duplicates / safety), errors in plain Arabic, keys.
//   node src/scripts/tiktokTest.js
import './_testGuard.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

const SP = await imp('../services/amb/tiktok/spec.js');
const BD = await imp('../services/amb/tiktok/builder.js');
const CL = await imp('../services/amb/tiktok/client.js');
const MK = await imp('../services/amb/tiktok/mock.js');
const LA = await imp('../services/amb/tiktok/launch.js');
const KY = await imp('../services/amb/tiktok/keys.js');
const DR = await imp('../services/amb/tiktok/drafts.js');

const NOW = new Date('2026-11-08T10:00:00Z');
const good = (over = {}) => ({
  name: 'Selicon - تيك توك', objective: 'CONVERSIONS', event: 'PURCHASE', pixelId: 'MOCKPIXEL001', landingUrl: 'https://shop.example/p/selicon', displayName: 'Trendy', adText: 'اطلب دلوقتي والدفع عند الاستلام',
  cta: 'SHOP_NOW', identity: { mode: 'NEW' }, videos: [{ url: 'https://cdn.example/a.mp4', name: 'فيديو 1' }, { url: 'https://cdn.example/b.mp4', name: 'فيديو 2' }],
  locations: ['357994'], ageGroups: ['AGE_18_24', 'AGE_25_34'], gender: 'ALL', languages: ['ar'], placement: 'AUTO', budgetLevel: 'ADGROUP', dailyBudget: 1000, bidStrategy: 'LOWEST_COST', runMode: 'PAUSED', ...over,
});
const ctx = { timeZone: 'Africa/Cairo', currency: 'EGP', now: NOW };

console.log('\n1. defaults + presets');
{
  const d = SP.defaultConfig();
  ok('default objective is sales, country Egypt, Arabic, paused (safest)', d.objective === 'CONVERSIONS' && d.locations[0] === '357994' && d.languages[0] === 'ar' && d.runMode === 'PAUSED');
  ok('13–17 is NOT in the default ages', !SP.AGE_DEFAULT.includes('AGE_13_17'));
  ok('every preset has an Arabic label + description and a valid objective', Object.values(SP.PRESETS).every((p) => /[؀-ۿ]/.test(p.label) && /[؀-ۿ]/.test(p.description) && SP.OBJECTIVES[p.config.objective]));
  ok('every objective has the goal/billing TikTok needs', Object.values(SP.OBJECTIVES).every((o) => o.apiObjective && o.goal && o.billing));
  ok('country ids are GeoNames-style numerics', Object.keys(SP.LOCATIONS).every((k) => /^\d+$/.test(k)));
}

console.log('\n2. validation — plain Arabic, blocks only real problems');
{
  const v = BD.validateConfig(good(), ctx);
  ok('a good config is valid', v.ok && v.errors.length === 0, JSON.stringify(v.errors));
  ok('an empty config lists what is missing (name, landing, pixel, brand, text, videos, budget)', (() => { const r = BD.validateConfig({}, ctx); const f = r.errors.map((e) => e.field); return !r.ok && ['name', 'landingUrl', 'pixelId', 'displayName', 'adText', 'videos', 'dailyBudget'].every((x) => f.includes(x)); })());
  ok('landing page must be https', BD.validateConfig(good({ landingUrl: 'http://shop.example' }), ctx).errors.some((e) => e.field === 'landingUrl'));
  ok('traffic needs a landing page but NOT a pixel', (() => { const r = BD.validateConfig(good({ objective: 'TRAFFIC', pixelId: '' }), ctx); return r.ok; })());
  ok('video-views needs neither landing nor pixel', BD.validateConfig(good({ objective: 'VIDEO_VIEWS', pixelId: '', landingUrl: '' }), ctx).ok);
  ok('lead-generation is refused with an explanation (needs an Instant Form)', BD.validateConfig(good({ objective: 'LEAD_GENERATION' }), ctx).errors.some((e) => /Instant Form/.test(e.message)));
  ok('ad text over 100 chars is an error', BD.validateConfig(good({ adText: 'ا'.repeat(101) }), ctx).errors.some((e) => e.field === 'adText'));
  ok('ad text 81–100 chars is only a warning', (() => { const r = BD.validateConfig(good({ adText: 'ا'.repeat(90) }), ctx); return r.ok && r.warnings.some((w) => w.field === 'adText'); })());
  ok('brand name max 40 chars is enforced by normalisation', BD.normalizeConfig(good({ displayName: 'x'.repeat(80) })).displayName.length === 40);
  ok('a non-https video link is an error naming the video', BD.validateConfig(good({ videos: [{ url: 'http://x/a.mp4' }] }), ctx).errors.some((e) => /الفيديو رقم 1/.test(e.message)));
  ok('no videos → error; one video → a recommendation, not an error', BD.validateConfig(good({ videos: [] }), ctx).errors.some((e) => e.field === 'videos') && (() => { const r = BD.validateConfig(good({ videos: [{ url: 'https://x/a.mp4' }] }), ctx); return r.ok && r.warnings.some((w) => w.field === 'videos'); })());
  ok('more than 10 videos is refused', BD.validateConfig(good({ videos: Array.from({ length: 11 }, (_, i) => ({ url: `https://x/${i}.mp4` })) }), ctx).errors.some((e) => e.field === 'videos'));
  ok('13–17 age group triggers a warning, not an error', (() => { const r = BD.validateConfig(good({ ageGroups: ['AGE_13_17', 'AGE_18_24'] }), ctx); return r.ok && r.warnings.some((w) => w.field === 'ageGroups'); })());
  ok('budget must be a positive number; a tiny EGP budget warns about TikTok minimums', BD.validateConfig(good({ dailyBudget: 0 }), ctx).errors.some((e) => e.field === 'dailyBudget') && BD.validateConfig(good({ dailyBudget: 100 }), ctx).warnings.some((w) => w.field === 'dailyBudget'));
  ok('cost-cap needs an amount; reach does not support it', BD.validateConfig(good({ bidStrategy: 'COST_CAP' }), ctx).errors.some((e) => e.field === 'bidAmount') && BD.validateConfig(good({ objective: 'REACH', pixelId: '', landingUrl: '', bidStrategy: 'COST_CAP', bidAmount: 5 }), ctx).errors.some((e) => e.field === 'bidStrategy'));
  ok('a scheduled start in the past (or < 5 min) is refused', BD.validateConfig(good({ runMode: 'SCHEDULED', startDate: '2026-11-08', startTime: '12:02' }), ctx).errors.some((e) => e.field === 'startDate'));
  ok('a scheduled start tomorrow midnight (Cairo) is fine; end before start is refused', BD.validateConfig(good({ runMode: 'SCHEDULED', startDate: '2026-11-09', startTime: '00:00' }), ctx).ok && BD.validateConfig(good({ runMode: 'SCHEDULED', startDate: '2026-11-09', startTime: '00:00', endDate: '2026-11-08' }), ctx).errors.some((e) => e.field === 'endDate'));
  ok('«run now» carries a warning', BD.validateConfig(good({ runMode: 'NOW' }), ctx).warnings.some((w) => w.field === 'runMode'));
  ok('unknown / hostile values are normalised away (never reach a payload)', (() => { const n = BD.normalizeConfig({ objective: 'HACK', locations: ['999', '357994'], gender: 'X', cta: 'DROP TABLE', ageGroups: ['AGE_99'] }); return n.objective === 'CONVERSIONS' && n.locations.join() === '357994' && n.gender === 'ALL' && n.cta === 'SHOP_NOW' && n.ageGroups.length === 0; })());
}

console.log('\n3. time zones');
{
  const u = BD.zonedToUtc('2026-11-09', '00:00', 'Africa/Cairo');
  ok('Cairo midnight (UTC+2 in November) → 22:00 UTC the day before', u.toISOString() === '2026-11-08T22:00:00.000Z', u.toISOString());
  ok('UTC zone is identity; garbage returns null', BD.zonedToUtc('2026-11-09', '10:30', 'UTC').toISOString() === '2026-11-09T10:30:00.000Z' && BD.zonedToUtc('x', '00:00') === null && BD.zonedToUtc('2026-11-09', '00:00', 'Not/AZone') === null);
  ok('TikTok time format', BD.tiktokTime(new Date('2026-11-08T22:05:09Z')) === '2026-11-08 22:05:09');
}

console.log('\n4. payloads — the exact fields TikTok v1.3 needs');
{
  const camp = BD.buildCampaignPayload(good(), { advertiserId: '700' });
  ok('campaign: objective, name, infinite campaign budget (budget on the ad group) and ALWAYS disabled', camp.objective_type === 'WEB_CONVERSIONS' && camp.campaign_name === 'Selicon - تيك توك' && camp.budget_mode === 'BUDGET_MODE_INFINITE' && camp.budget === undefined && camp.operation_status === 'DISABLE' && camp.advertiser_id === '700');
  const cbo = BD.buildCampaignPayload(good({ budgetLevel: 'CAMPAIGN', dailyBudget: 800 }), { advertiserId: '700' });
  ok('campaign-level budget → BUDGET_MODE_DAY + budget', cbo.budget_mode === 'BUDGET_MODE_DAY' && cbo.budget === 800 && cbo.budget_optimize_on === true);
  const ag = BD.buildAdGroupPayload(good(), { advertiserId: '700', campaignId: 'C1', timeZone: 'Africa/Cairo', now: NOW });
  ok('ad group: sales → CONVERT / OCPM / pixel + event (SHOPPING) / Egypt / Arabic', ag.optimization_goal === 'CONVERT' && ag.billing_event === 'OCPM' && ag.pixel_id === 'MOCKPIXEL001' && ag.optimization_event === 'SHOPPING' && ag.location_ids.join() === '357994' && ag.languages.join() === 'ar' && ag.promotion_type === 'WEBSITE');
  ok('ad group: daily budget on the group, lowest cost = NO_BID, automatic placement, smooth pacing, disabled', ag.budget === 1000 && ag.budget_mode === 'BUDGET_MODE_DAY' && ag.bid_type === 'BID_TYPE_NO_BID' && ag.placement_type === 'PLACEMENT_TYPE_AUTOMATIC' && ag.pacing === 'PACING_MODE_SMOOTH' && ag.operation_status === 'DISABLE' && ag.gender === 'GENDER_UNLIMITED');
  ok('ad group: paused launch = start from now (+1 min, UTC)', ag.schedule_type === 'SCHEDULE_FROM_NOW' && ag.schedule_start_time === '2026-11-08 10:01:00');
  const sch = BD.buildAdGroupPayload(good({ runMode: 'SCHEDULED', startDate: '2026-11-09', startTime: '00:00', endDate: '2026-11-12' }), { advertiserId: '700', campaignId: 'C1', timeZone: 'Africa/Cairo', now: NOW });
  ok('ad group: scheduled → START_END in UTC (Cairo 00:00 = 22:00 UTC), end = last minute of the end day', sch.schedule_type === 'SCHEDULE_START_END' && sch.schedule_start_time === '2026-11-08 22:00:00' && sch.schedule_end_time === '2026-11-12 21:59:00', JSON.stringify([sch.schedule_start_time, sch.schedule_end_time]));
  const cap = BD.buildAdGroupPayload(good({ bidStrategy: 'COST_CAP', bidAmount: 60 }), { advertiserId: '700', campaignId: 'C1', now: NOW });
  ok('cost cap on conversions → CUSTOM bid with conversion_bid_price; on traffic → bid_price', cap.bid_type === 'BID_TYPE_CUSTOM' && cap.conversion_bid_price === 60 && cap.bid_price === undefined && BD.buildAdGroupPayload(good({ objective: 'TRAFFIC', bidStrategy: 'COST_CAP', bidAmount: 2 }), { advertiserId: '7', campaignId: 'C', now: NOW }).bid_price === 2);
  const tr = BD.buildAdGroupPayload(good({ objective: 'TRAFFIC', pixelId: '' }), { advertiserId: '7', campaignId: 'C', now: NOW });
  ok('traffic: CLICK / CPC and NO pixel fields', tr.optimization_goal === 'CLICK' && tr.billing_event === 'CPC' && tr.pixel_id === undefined && tr.optimization_event === undefined);
  const reach = BD.buildAdGroupPayload(good({ objective: 'REACH' }), { advertiserId: '7', campaignId: 'C', now: NOW });
  ok('reach: REACH / CPM and no bid type', reach.optimization_goal === 'REACH' && reach.billing_event === 'CPM' && reach.bid_type === undefined);
  const to = BD.buildAdGroupPayload(good({ placement: 'TIKTOK_ONLY', operatingSystems: ['ANDROID'], interestIds: ['10001'], commentsOff: true }), { advertiserId: '7', campaignId: 'C', now: NOW });
  ok('manual placement + OS + interests + comments off are passed through', to.placement_type === 'PLACEMENT_TYPE_NORMAL' && to.placements.join() === 'PLACEMENT_TIKTOK' && to.operating_systems.join() === 'ANDROID' && to.interest_category_ids.join() === '10001' && to.comment_disabled === true);
  const ad = BD.buildAdPayload(good({ adsPerVideo: 2 }), { advertiserId: '700', adgroupId: 'G1', identityId: 'ID1', uploads: [{ videoId: 'v1', coverImageId: 'i1', name: 'فيديو 1' }, { videoId: 'v2', coverImageId: 'i2', name: 'فيديو 2' }] });
  ok('ads: one per video × adsPerVideo, each with video, cover, identity, text, CTA and the landing URL', ad.creatives.length === 4 && ad.creatives[0].video_id === 'v1' && ad.creatives[0].image_ids[0] === 'i1' && ad.creatives[0].identity_id === 'ID1' && ad.creatives[0].identity_type === 'CUSTOMIZED_USER' && ad.creatives[0].call_to_action === 'SHOP_NOW' && ad.creatives[0].landing_page_url === 'https://shop.example/p/selicon' && ad.creatives[0].ad_format === 'SINGLE_VIDEO' && ad.adgroup_id === 'G1');
  ok('ad names are unique', new Set(ad.creatives.map((c) => c.ad_name)).size === 4);
  ok('the review summary is plain Arabic', BD.summarize(good(), { currency: 'EGP' }).every(([k, v]) => /[؀-ۿ]/.test(k) && String(v).length));
}

console.log('\n5. the in-memory TikTok behaves like the real create calls (required fields)');
{
  const m = MK.createMockTikTok(); const c = CL.createTikTokClient({ advertiserId: m.advertiser.advertiser_id, transport: m.transport });
  ok('advertiser info + pixels + identities + interests', (await c.advertiserInfo()).currency === 'EGP' && (await c.pixels()).length === 1 && (await c.identities()).length === 1 && (await c.interests()).length > 3);
  const e1 = await rejects(c.createCampaign({ advertiser_id: '1' }));
  ok('a campaign without name/objective/budget_mode is refused with a TikTok-style error', e1 instanceof CL.TikTokError && e1.code === 40002 && /Missing required/.test(e1.message));
  const e2 = await rejects(c.createAdGroup({ advertiser_id: '1', campaign_id: 'nope', adgroup_name: 'x', billing_event: 'CPC', optimization_goal: 'CLICK', schedule_type: 'SCHEDULE_FROM_NOW', schedule_start_time: 'x', location_ids: ['1'] }));
  ok('an ad group under an unknown campaign is refused', e2?.code === 40002);
  const e3 = await rejects(c.uploadVideoByUrl('http://insecure/x.mp4', 'x'));
  ok('a non-https video is refused', e3?.code === 40002);
}

console.log('\n6. launch flow (against the mock)');
const memory = () => { const rows = new Map(); return { rows, getDraft: async (id) => (rows.has(id) ? JSON.parse(JSON.stringify(rows.get(id))) : null), saveDraft: async (d) => { d.updatedAt = new Date().toISOString(); rows.set(d.id, JSON.parse(JSON.stringify(d))); return d; } }; };
const mkDraft = (cfg, mode = 'MOCK') => ({ id: 'abcdef012345', name: cfg.name, status: 'DRAFT', mode, config: BD.normalizeConfig(cfg), progress: { identityId: null, uploads: {}, campaignId: null, adgroupId: null, adIds: [], enabled: false, steps: [] }, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const deps = (mem, mock, extra = {}) => ({ getDraft: mem.getDraft, saveDraft: mem.saveDraft, client: CL.createTikTokClient({ advertiserId: mock.advertiser.advertiser_id, transport: mock.transport }), connection: async () => ({ mode: 'MOCK' }), sleep: async () => {}, now: () => NOW, ...extra });
{
  const mem = memory(); const mock = MK.createMockTikTok(); mem.rows.set('abcdef012345', mkDraft(good()));
  const d = await LA.launchDraft('abcdef012345', {}, deps(mem, mock));
  ok('a full launch creates identity → 2 videos + 2 covers → campaign → ad group → 2 ads, all DISABLED', d.status === 'LAUNCHED' && !!d.progress.identityId && !!d.progress.campaignId && !!d.progress.adgroupId && d.progress.adIds.length === 2 && [...mock.state.campaigns.values()][0].operation_status === 'DISABLE' && [...mock.state.ads.values()].every((a) => a.operation_status === 'DISABLE'));
  ok('every step is recorded as DONE in order', ['validate', 'identity', 'upload', 'campaign', 'adgroup', 'ads'].every((k) => d.progress.steps.find((s) => s.key === k)?.status === 'DONE'));
  const before = mock.creates().length;
  const again = await LA.launchDraft('abcdef012345', {}, deps(mem, mock));
  ok('launching the SAME draft again creates NOTHING new (idempotent)', mock.creates().length === before && again.progress.campaignId === d.progress.campaignId);
  const en = await LA.enableDraft('abcdef012345', {}, deps(mem, mock));
  ok('enabling turns on campaign + ad group + ads, only when asked', en.progress.enabled === true && en.status === 'ENABLED' && [...mock.state.campaigns.values()][0].operation_status === 'ENABLE' && [...mock.state.ads.values()].every((a) => a.operation_status === 'ENABLE'));
  const pa = await LA.pauseDraft('abcdef012345', {}, deps(mem, mock));
  ok('pausing stops the campaign', pa.progress.enabled === false && [...mock.state.campaigns.values()][0].operation_status === 'DISABLE');
}
{
  // failure at each remote create: the next launch RESUMES from that step and creates each object exactly once
  for (const [path, label] of [['/campaign/create/', 'campaign'], ['/adgroup/create/', 'ad group'], ['/ad/create/', 'ads'], ['/file/image/ad/upload/', 'cover upload']]) {
    const mem = memory(); const mock = MK.createMockTikTok({ failures: { [path]: 1 } }); mem.rows.set('abcdef012345', mkDraft(good()));
    const e = await rejects(LA.launchDraft('abcdef012345', {}, deps(mem, mock)));
    const failed = await mem.getDraft('abcdef012345');
    ok(`${label}: a TikTok refusal fails the launch, records the step + a plain-Arabic hint`, !!e && failed.status === 'FAILED' && !!failed.error.stepLabel && !!failed.error.hint.title && /[؀-ۿ]/.test(failed.error.hint.action));
    const d = await LA.launchDraft('abcdef012345', {}, deps(mem, mock));
    const count = (re) => mock.creates().filter((l) => re.test(l.path)).length;
    ok(`${label}: resume completes it, and campaign/ad group/identity were created exactly once`, d.status === 'LAUNCHED' && d.progress.adIds.length === 2 && count(/campaign\/create/) === (path === '/campaign/create/' ? 2 : 1) && count(/adgroup\/create/) === (path === '/adgroup/create/' ? 2 : 1) && count(/identity\/create/) === 1, JSON.stringify(mock.creates().map((l) => l.path)));
    ok(`${label}: both videos were uploaded once each (never re-uploaded on resume)`, mock.creates().filter((l) => /video\/ad\/upload/.test(l.path)).length === 2);
  }
}
{
  // validation failure blocks BEFORE any create
  const mem = memory(); const mock = MK.createMockTikTok(); mem.rows.set('abcdef012345', mkDraft(good({ landingUrl: 'http://bad' })));
  const e = await rejects(LA.launchDraft('abcdef012345', {}, deps(mem, mock)));
  ok('an invalid config is refused with the Arabic reasons and NOTHING is created', e?.status === 400 && /https/.test(e.message) && mock.creates().length === 0);
  // a bad video: the mock refuses it; the error explains
  const mem2 = memory(); const mock2 = MK.createMockTikTok(); mem2.rows.set('abcdef012345', mkDraft(good({ videos: [{ url: 'https://cdn.example/bad-video.mp4' }] })));
  const e2 = await rejects(LA.launchDraft('abcdef012345', {}, deps(mem2, mock2)));
  const f2 = await mem2.getDraft('abcdef012345');
  ok('a rejected video fails at the upload step with the video-format explanation', !!e2 && f2.error.step === 'upload' && /الفيديو/.test(f2.error.hint.title) && !f2.progress.campaignId);
  // existing identity is used as is
  const mem3 = memory(); const mock3 = MK.createMockTikTok(); mem3.rows.set('abcdef012345', mkDraft(good({ identity: { mode: 'EXISTING', id: 'mock_identity_1' } })));
  const d3 = await LA.launchDraft('abcdef012345', {}, deps(mem3, mock3));
  ok('an existing identity is reused (no identity created)', d3.progress.identityId === 'mock_identity_1' && mock3.creates().filter((l) => /identity\/create/.test(l.path)).length === 0);
  // same brand name → reuse, never a second identity
  const mem4 = memory(); const mock4 = MK.createMockTikTok(); mem4.rows.set('abcdef012345', mkDraft(good({ displayName: 'براند تجريبي' })));
  const d4 = await LA.launchDraft('abcdef012345', {}, deps(mem4, mock4));
  ok('a NEW identity with the name of an existing one reuses it', d4.progress.identityId === 'mock_identity_1');
  // a video that is still processing: nothing is lost, resume continues
  const mem5 = memory(); const mock5 = MK.createMockTikTok(); mem5.rows.set('abcdef012345', mkDraft(good({ videos: [{ url: 'https://cdn.example/slow.mp4' }] })));
  const origInfo = mock5.transport; let slow = 3;
  const t5 = async (m, p, o) => { if (p === '/file/video/ad/info/' && slow-- > 0) return { code: 0, message: 'OK', data: { list: [] } }; return origInfo(m, p, o); };
  const dd5 = (extra) => ({ ...deps(mem5, mock5), client: CL.createTikTokClient({ advertiserId: '7', transport: t5 }), pollTries: 2, ...extra });
  const e5 = await rejects(LA.launchDraft('abcdef012345', {}, dd5()));
  const f5 = await mem5.getDraft('abcdef012345');
  ok('a video still processing fails softly (retryable), the video id is kept', !!e5 && e5.retryable === true && Object.values(f5.progress.uploads)[0]?.videoId);
  const d5 = await LA.launchDraft('abcdef012345', {}, dd5({ pollTries: 5 }));
  ok('…and the next launch continues WITHOUT uploading the video again', d5.status === 'LAUNCHED' && mock5.creates().filter((l) => /video\/ad\/upload/.test(l.path)).length === 1);
}
{
  // connection-mode safety + the global write guard
  const mem = memory(); const mock = MK.createMockTikTok(); mem.rows.set('abcdef012345', mkDraft(good(), 'MOCK'));
  const e1 = await rejects(LA.launchDraft('abcdef012345', {}, deps(mem, mock, { connection: async () => ({ mode: 'REAL' }), guard: async () => ({ ok: true }) })));
  ok('a draft made in demo mode can NEVER be launched against the real account', e1?.status === 409 && /تجريبي/.test(e1.message) && mock.creates().length === 0);
  const mem2 = memory(); const mock2 = MK.createMockTikTok(); mem2.rows.set('abcdef012345', mkDraft(good(), 'REAL'));
  const e2 = await rejects(LA.launchDraft('abcdef012345', {}, deps(mem2, mock2, { connection: async () => ({ mode: 'REAL' }), guard: async () => ({ ok: false, message: 'Emergency Stop' }) })));
  ok('Emergency Stop blocks a real launch before anything is sent', e2?.status === 423 && mock2.creates().length === 0);
  const e3 = await rejects(LA.launchDraft('abcdef012345', {}, deps(mem2, mock2, { connection: async () => ({ mode: 'NONE' }) })));
  ok('no connection → a clear error', e3?.status === 409);
  const mem4 = memory(); const mock4 = MK.createMockTikTok({ latencyMs: 20 }); mem4.rows.set('abcdef012345', mkDraft(good()));
  const [r1, r2] = await Promise.allSettled([LA.launchDraft('abcdef012345', {}, deps(mem4, mock4)), LA.launchDraft('abcdef012345', {}, deps(mem4, mock4))]);
  ok('two simultaneous launches of one draft: exactly one runs, the other is refused', [r1, r2].filter((r) => r.status === 'fulfilled').length === 1 && [r1, r2].filter((r) => r.status === 'rejected').length === 1 && mock4.creates().filter((l) => /campaign\/create/.test(l.path)).length === 1);
}
{
  // a create whose outcome is unknown (network) is looked up by name before it is retried
  const mem = memory(); const mock = MK.createMockTikTok(); mem.rows.set('abcdef012345', mkDraft(good()));
  let dropped = false;
  const flaky = async (m, p, o) => { const r = await mock.transport(m, p, o); if (p === '/campaign/create/' && !dropped) { dropped = true; throw new Error('fetch failed'); } return r; };
  const dp = (extra) => ({ ...deps(mem, mock), client: CL.createTikTokClient({ advertiserId: '7', transport: flaky }), ...extra });
  const e = await rejects(LA.launchDraft('abcdef012345', {}, dp()));
  const f = await mem.getDraft('abcdef012345');
  ok('a network drop on campaign/create fails with unknownOutcome', !!e && f.error.unknownOutcome === true && mock.state.campaigns.size === 1);
  const d = await LA.launchDraft('abcdef012345', {}, dp());
  ok('the retry ADOPTS the campaign that was actually created — still exactly one on TikTok', d.status === 'LAUNCHED' && mock.state.campaigns.size === 1 && d.progress.campaignId === [...mock.state.campaigns.keys()][0]);
}

console.log('\n7. errors explained in plain Arabic');
{
  const x = (m, code) => CL.explainTikTokError(Object.assign(new Error(m), { code }));
  ok('expired token → reconnect', /التوكن/.test(x('Access token is invalid', 40105).title));
  ok('rate limit → wait', /حد طلبات/.test(x('Too many requests, rate limit', 40100).title));
  ok('budget too low → raise it', /الميزانية/.test(x('The budget is too low, minimum budget is 20 USD').title));
  ok('pixel / identity / video / landing / policy each get their own explanation', /Pixel/.test(x('pixel_id invalid').title) && /هوية/.test(x('identity not found').title) && /الفيديو/.test(x('video format not supported').title) && /لينك/.test(x('landing page url is invalid').title) && /سياسة/.test(x('ad rejected for policy violation').title));
  ok('a network failure says the work done so far is safe', /مش بترد/.test(x('fetch failed').title) && /مش هيتكرر/.test(x('fetch failed').action));
  ok('anything unknown still gets a generic title + action', x('???').title && x('???').action);
  ok('every explanation is Arabic', ['Access token invalid', 'rate limit', 'budget too low', 'pixel', 'identity', 'video format', 'landing url', 'policy', 'weird'].every((m) => /[؀-ۿ]/.test(x(m).title + x(m).action)));
}

console.log('\n8. keys + drafts (database)');
{
  await KY.clearCredentials();
  ok('nothing saved → mode NONE', (await KY.getConnection()).mode === 'NONE');
  const e1 = await rejects(KY.saveCredentials({ token: 'short', advertiserId: '7000000000001' }));
  const e2 = await rejects(KY.saveCredentials({ token: 'a'.repeat(40), advertiserId: 'abc' }));
  ok('a bad token / advertiser id is refused with an Arabic reason', e1?.status === 400 && e2?.status === 400 && /[؀-ۿ]/.test(e1.message));
  const TOKEN = 'T'.repeat(12) + 'abcdEFGH' + '9'.repeat(12);
  const st = await KY.saveCredentials({ token: TOKEN, advertiserId: '7000000000001' });
  ok('saved → REAL, status shows only the last 4 (never the token)', st.mode === 'REAL' && st.last4 === TOKEN.slice(-4) && !JSON.stringify(st).includes(TOKEN));
  const raw = await (await imp('../prisma.js')).prisma.settings.findUnique({ where: { id: 'tiktok-keys' } });
  ok('the token is encrypted at rest', !raw.data.includes(TOKEN) && JSON.parse(raw.data).token.enc.length > 20);
  ok('the real connection returns the decrypted token to the server only', (await KY.getConnection()).token === TOKEN);
  await KY.setMock(true);
  ok('demo mode wins over saved credentials (no real calls)', (await KY.getConnection()).mode === 'MOCK');
  const cl = await KY.getClient(); ok('demo client is the in-memory one', cl.mode === 'MOCK' && (await cl.client.advertiserInfo()).name === 'حساب تجريبي');
  await KY.clearCredentials(); await KY.setMock(false);
  ok('cleared → NONE and getClient says «اربط»', (await KY.getConnection()).mode === 'NONE' && (await rejects(KY.getClient()))?.status === 409);

  const d = await DR.createDraft({ preset: 'COD_EGYPT', config: { name: 'تجربة' }, mode: 'MOCK' });
  ok('a draft starts from a preset (sales, Egypt, Arabic)', d.config.objective === 'CONVERSIONS' && d.config.locations[0] === '357994' && d.config.name === 'تجربة' && d.status === 'DRAFT' && DR.validDraftId(d.id));
  const u = await DR.updateDraftConfig(d.id, { dailyBudget: 700, hacked: 'x' });
  ok('editing merges + normalises (unknown keys are dropped)', u.config.dailyBudget === 700 && u.config.hacked === undefined);
  ok('it is listed', (await DR.listDrafts()).some((x) => x.id === d.id));
  const dup = await DR.duplicateDraft(d.id); ok('duplicate gives a fresh draft with no remote ids', dup.id !== d.id && dup.progress.campaignId === null && /نسخة/.test(dup.config.name));
  const locked = await DR.getDraft(d.id); locked.progress.campaignId = '123'; await DR.saveDraftRow(locked);
  ok('once something exists on TikTok the config is frozen and the draft cannot be deleted', (await rejects(DR.updateDraftConfig(d.id, { dailyBudget: 1 })))?.status === 409 && (await rejects(DR.deleteDraft(d.id)))?.status === 409);
  ok('an untouched draft can be deleted', (await DR.deleteDraft(dup.id)).deleted === true && (await DR.getDraft(dup.id)) === null);
  const prisma = (await imp('../prisma.js')).prisma; await prisma.settings.deleteMany({ where: { id: { in: ['tt:' + d.id, 'tiktok-keys'] } } });
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
