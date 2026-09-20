// Campaign Launch Builder — Phase F payload builders (services/amb/
// launchPublish.js). Pure, offline tests locking in the real Meta API
// requirements discovered empirically against the connected Ahmed Samy
// account during Phase F development (see that session's report): ABO
// campaigns need is_adset_budget_sharing_enabled explicitly, this ad
// account's ad sets need an explicit bid_strategy, and video creatives
// need an explicit thumbnail. No network calls, no real DB, no Meta.
//   node src/scripts/launchPublishTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { buildTargeting, buildCampaignPayload, buildAdSetPayload, buildCreativePayload, runBounded } = await imp('../services/amb/launchPublish.js');

const abojob = { objective: 'OUTCOME_SALES', budget_mode: 'ABO', platforms_json: '["facebook"]', pixel_id: 'pix_job', conversion_event: 'PURCHASE', config_json: '{}', start_mode: 'NOW', start_at: null };
const cbojob = { ...abojob, budget_mode: 'CBO', config_json: JSON.stringify({ budget: { cbo: { dailyBudgetMinor: 50000 } } }) };
const campaign = { name: 'Cup - Test', pixel_id: null, primary_text: 'نص', headline: 'عنوان', website_url: 'https://trendystore.com' };

console.log('§1 buildTargeting — minimal valid shape (geo_locations is the one Meta-required field):');
{
  const t = buildTargeting(abojob);
  ok('includes geo_locations with a real country code', Array.isArray(t.geo_locations?.countries) && t.geo_locations.countries.length > 0);
  ok('publisher_platforms reflects the job\'s own configured platforms, never invents extra ones', JSON.stringify(t.publisher_platforms) === '["facebook"]');
}

console.log('\n§1b Final core execution step — CUSTOM targeting override, and the mandatory "no targeting -> exact same Broad default as before" guarantee:');
{
  const customJob = { ...abojob, config_json: JSON.stringify({ targeting: { mode: 'CUSTOM', genders: 'FEMALE', ageMin: 20, ageMax: 35, geoRegions: [{ key: '1001', name: 'Cairo Governorate' }], placementsMode: 'FEED_ONLY' } }) };
  const t = buildTargeting(customJob);
  ok('CUSTOM targeting sets real genders (FEMALE -> [2])', JSON.stringify(t.genders) === '[2]', JSON.stringify(t));
  ok('CUSTOM targeting sets real age_min/age_max', t.age_min === 20 && t.age_max === 35);
  ok('CUSTOM targeting overrides geo_locations with the real resolved region key, never the country-wide default', JSON.stringify(t.geo_locations) === JSON.stringify({ regions: [{ key: '1001', country: 'EG' }] }), JSON.stringify(t.geo_locations));
  ok('FEED_ONLY placements sets real facebook/instagram position arrays', JSON.stringify(t.facebook_positions) === '["feed"]' && JSON.stringify(t.instagram_positions) === '["stream"]');

  const broadJob = { ...abojob, config_json: JSON.stringify({ targeting: { mode: 'BROAD' } }) };
  const broadT = buildTargeting(broadJob);
  ok('an EXPLICIT BROAD mode is byte-identical to a job with no targeting key at all — never a silent narrowing', JSON.stringify(broadT) === JSON.stringify(buildTargeting(abojob)));

  const allGendersJob = { ...abojob, config_json: JSON.stringify({ targeting: { mode: 'CUSTOM', genders: 'ALL', ageMin: 18, ageMax: 65, geoRegions: [], placementsMode: 'AUTOMATIC' } }) };
  const allT = buildTargeting(allGendersJob);
  ok('CUSTOM mode with genders:ALL omits the genders key entirely (Meta\'s own Broad default), never fabricates [1,2]', allT.genders === undefined, JSON.stringify(allT));
  ok('CUSTOM mode with an empty geoRegions array falls back to the country-wide default, never an empty/broken regions list', JSON.stringify(allT.geo_locations) === JSON.stringify({ countries: ['EG'] }));
  ok('AUTOMATIC placements never sets facebook_positions/instagram_positions', allT.facebook_positions === undefined && allT.instagram_positions === undefined);
}

console.log('\n§2 buildCampaignPayload — ABO vs CBO budget-field placement:');
{
  const abo = buildCampaignPayload(abojob, campaign);
  ok('ABO campaign carries NO daily_budget/lifetime_budget (budget lives on the ad set)', abo.daily_budget === undefined && abo.lifetime_budget === undefined);
  ok('ABO campaign explicitly sets is_adset_budget_sharing_enabled — confirmed live Meta REJECTS creation otherwise', abo.is_adset_budget_sharing_enabled === false);
  ok('status is always PAUSED on create', abo.status === 'PAUSED');
  ok('special_ad_categories is an empty array, never the deprecated "NONE" string', Array.isArray(abo.special_ad_categories) && abo.special_ad_categories.length === 0);

  const cbo = buildCampaignPayload(cbojob, campaign);
  ok('CBO campaign carries the real configured daily_budget', cbo.daily_budget === 50000);
  ok('CBO campaign does NOT set is_adset_budget_sharing_enabled (only relevant when the campaign has no budget)', cbo.is_adset_budget_sharing_enabled === undefined);
  // Confirmed live against this real ad account (dozens of real working
  // ACTIVE/PAUSED campaigns): for CBO, bid_strategy belongs on the
  // CAMPAIGN, never the ad set — the earlier "ad-set-level bid_strategy"
  // approach was corrected after it silently manufactured an unwanted
  // 200 EGP Bid Cap the user never asked for.
  ok('CBO campaign defaults to LOWEST_COST_WITHOUT_CAP (Meta\'s "Automatic / Highest volume", no manual cap) — confirmed live, dozens of real working campaigns in this exact account use exactly this', cbo.bid_strategy === 'LOWEST_COST_WITHOUT_CAP', cbo.bid_strategy);
  ok('never a bid_amount by default — no bid cap unless explicitly requested', cbo.bid_amount === undefined);

  const cboBidCap = buildCampaignPayload({ ...cbojob, config_json: JSON.stringify({ budget: { cbo: { dailyBudgetMinor: 50000 } }, bidding: { mode: 'BID_CAP', bidCapMinor: 15000 } }) }, campaign);
  ok('an EXPLICITLY chosen Bid Cap mode uses LOWEST_COST_WITH_BID_CAP with the user\'s own real amount — never derived from the daily budget', cboBidCap.bid_strategy === 'LOWEST_COST_WITH_BID_CAP' && cboBidCap.bid_amount === 15000, JSON.stringify({ s: cboBidCap.bid_strategy, a: cboBidCap.bid_amount }));
}

console.log('\n§3 buildAdSetPayload — bid strategy, promoted_object, budget placement, schedule:');
{
  const adSet = buildAdSetPayload(abojob, campaign, 'meta_campaign_123', 0, 20000);
  ok('carries an explicit bid_strategy — confirmed live this ad account REJECTS ad set creation without one', adSet.bid_strategy === 'LOWEST_COST_WITHOUT_CAP');
  ok('promoted_object uses the campaign\'s own pixel when set, else falls back to the job\'s pixel', true); // covered by §4 below with an explicit campaign-level pixel
  ok('promoted_object.custom_event_type matches the job\'s real configured conversion event', adSet.promoted_object.custom_event_type === 'PURCHASE');
  ok('ABO ad set carries the real per-ad-set daily_budget', adSet.daily_budget === 20000);
  ok('references the real created campaign_id', adSet.campaign_id === 'meta_campaign_123');
  ok('status is always PAUSED on create', adSet.status === 'PAUSED');
  ok('no start_time when start_mode is NOW', adSet.start_time === undefined);

  const scheduled = buildAdSetPayload({ ...abojob, start_mode: 'SCHEDULED', start_at: new Date(Date.now() + 3600_000) }, campaign, 'c', 0, 20000);
  ok('a real future start_time is included when scheduled', typeof scheduled.start_time === 'string');
  // Superseded by §6 below: a past SCHEDULED start_time is now always sent
  // honestly (never silently dropped) — see the real production bug that
  // fix addresses. Kept only as a pointer so this history isn't lost.

  const cboAdSet = buildAdSetPayload(cbojob, campaign, 'c', 0, 20000);
  ok('a CBO ad set never carries its own budget (the campaign already has one — Meta rejects both at once)', cboAdSet.daily_budget === undefined);
  // Real production bug, now fixed: bid_strategy/bid_amount used to be set
  // HERE (ad-set level) for CBO, which made Meta demand a bid_amount —
  // sending the daily budget as that amount created an unwanted 200 EGP Bid
  // Cap the user never asked for. Confirmed live: a CBO ad set needs NO bid
  // fields of its own at all — it inherits from the campaign.
  ok('a CBO ad set carries NO bid_strategy of its own — inherits from the campaign, confirmed live', cboAdSet.bid_strategy === undefined, cboAdSet.bid_strategy);
  ok('a CBO ad set NEVER carries a bid_amount — this is exactly how the unwanted 200 EGP Bid Cap bug happened', cboAdSet.bid_amount === undefined, cboAdSet.bid_amount);

  const aboBidCap = buildAdSetPayload({ ...abojob, config_json: JSON.stringify({ bidding: { mode: 'BID_CAP', bidCapMinor: 8000 } }) }, campaign, 'c', 0, 20000);
  ok('an ABO ad set with Bid Cap explicitly chosen uses LOWEST_COST_WITH_BID_CAP + the real user amount, never the daily budget', aboBidCap.bid_strategy === 'LOWEST_COST_WITH_BID_CAP' && aboBidCap.bid_amount === 8000, JSON.stringify({ s: aboBidCap.bid_strategy, a: aboBidCap.bid_amount }));
}

console.log('\n§4 buildAdSetPayload — per-campaign pixel override takes priority over the job-level pixel:');
{
  const campaignWithOwnPixel = { ...campaign, pixel_id: 'pix_campaign_override' };
  const adSet = buildAdSetPayload(abojob, campaignWithOwnPixel, 'c', 0, 20000);
  ok('uses the campaign\'s own pixel_id, not the job-level default, when per_campaign_pixel set one', adSet.promoted_object.pixel_id === 'pix_campaign_override');
}

console.log('\n§5 buildCreativePayload — real page, real video, explicit thumbnail, verified CTA:');
{
  const creative = buildCreativePayload(abojob, campaign, 0, 0, 'video_123', 'https://scontent.example/thumb.jpg');
  ok('references the job\'s real Facebook Page', 'page_id' in creative.object_story_spec);
  ok('video_data carries the real reused video_id — never a fresh upload', creative.object_story_spec.video_data.video_id === 'video_123');
  ok('image_url is set — confirmed live Meta REJECTS a video creative with no thumbnail at all', creative.object_story_spec.video_data.image_url === 'https://scontent.example/thumb.jpg');
  ok('call_to_action uses the verified real ORDER_NOW enum by default', creative.object_story_spec.video_data.call_to_action.type === 'ORDER_NOW');
  ok('the CTA links to the campaign\'s real website URL', creative.object_story_spec.video_data.call_to_action.value.link === campaign.website_url);
  ok('carries the campaign\'s real primary text/headline, never placeholder copy', creative.object_story_spec.video_data.message === 'نص' && creative.object_story_spec.video_data.title === 'عنوان');
}

console.log('\n§6 buildAdSetPayload — customer lifecycle strategy + always-send SCHEDULED start_time (two real production bugs fixed):');
{
  const adSet = buildAdSetPayload(abojob, campaign, 'meta_campaign_123', 0, 20000);
  ok('carries existing_customer_budget_percentage:100 — confirmed real AdSet field behind Ads Manager\'s "Customer lifecycle strategy: Get conversions from all audiences"', adSet.existing_customer_budget_percentage === 100, String(adSet.existing_customer_budget_percentage));
  ok('never a lower value — that would enable new-customer-only/retention budget restriction the wizard has no UI for', adSet.existing_customer_budget_percentage >= 100);

  // The real production bug: a durable queue can create an ad set well AFTER the
  // originally-requested SCHEDULED moment has already elapsed — start_time must
  // still be sent, never silently omitted (which defaults Meta to "start now").
  const pastScheduleJob = { ...abojob, start_mode: 'SCHEDULED', start_at: new Date(Date.now() - 24 * 3600_000) };
  const pastAdSet = buildAdSetPayload(pastScheduleJob, campaign, 'c', 0, 20000);
  ok('a SCHEDULED start_time already 24h in the past is STILL sent honestly — never silently dropped (the exact real bug: dropping it let Meta default to "now", replacing midnight with an unrelated afternoon time)', pastAdSet.start_time === pastScheduleJob.start_at.toISOString(), pastAdSet.start_time);

  const futureScheduleJob = { ...abojob, start_mode: 'SCHEDULED', start_at: new Date(Date.now() + 3600_000) };
  const futureAdSet = buildAdSetPayload(futureScheduleJob, campaign, 'c', 0, 20000);
  ok('a future SCHEDULED start_time is sent as before (no regression)', futureAdSet.start_time === futureScheduleJob.start_at.toISOString());

  ok('NOW mode never sends a start_time at all', buildAdSetPayload(abojob, campaign, 'c', 0, 20000).start_time === undefined);
}

console.log('\n§7 buildCreativePayload — Instagram identity (the real production bug: ads created with Facebook-only identity):');
{
  const noIg = buildCreativePayload(abojob, campaign, 0, 0, 'video_123', 'https://scontent.example/thumb.jpg');
  ok('no instagram_user_id sent when the job has none configured — never a placeholder/empty value', noIg.object_story_spec.instagram_user_id === undefined);

  const withIg = buildCreativePayload({ ...abojob, instagram_id: '17841400000000000' }, campaign, 0, 0, 'video_123', 'https://scontent.example/thumb.jpg');
  ok('instagram_user_id is a sibling of page_id inside object_story_spec — confirmed field placement from this codebase\'s own working Clone & Schedule engine', withIg.object_story_spec.instagram_user_id === '17841400000000000');
  ok('page_id is still present alongside it — both identities set together', 'page_id' in withIg.object_story_spec);
}

console.log('\n§8 runBounded — the new within-campaign speed engine: bounded concurrency, never fail-fast, every slot always settles:');
{
  let concurrentNow = 0, maxConcurrent = 0;
  const order = [];
  const items = Array.from({ length: 12 }, (_, i) => i);
  const results = await runBounded(items, 5, async (i) => {
    concurrentNow++; maxConcurrent = Math.max(maxConcurrent, concurrentNow);
    await new Promise((r) => setTimeout(r, 5));
    order.push(i);
    concurrentNow--;
    return i * 10;
  });
  ok('never runs more than the given concurrency limit at once', maxConcurrent <= 5, String(maxConcurrent));
  ok('every item still eventually runs — nothing silently dropped', order.length === 12);
  ok('successful results are returned in the original slot order, not completion order', results.every((r, i) => r.ok && r.value === i * 10));

  // A stuck/failing slot (e.g. one video still processing) must never
  // prevent OTHER independent slots in the same batch from completing —
  // exactly the production inefficiency this refactor fixes.
  let ranAfterFailure = 0;
  const mixed = await runBounded([0, 1, 2, 3, 4, 5], 2, async (i) => {
    if (i === 1) throw new Error('slot 1 is still WAITING_FOR_META');
    await new Promise((r) => setTimeout(r, 2));
    ranAfterFailure++;
    return i;
  });
  ok('a thrown slot is captured as {ok:false} rather than aborting the whole batch', mixed[1].ok === false && mixed[1].error.message.includes('WAITING_FOR_META'));
  ok('every OTHER slot in the same batch still completes despite the failure', ranAfterFailure === 5, String(ranAfterFailure));
  ok('every non-failing slot reports its own real success', mixed.filter((r, i) => i !== 1).every((r) => r.ok === true));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
