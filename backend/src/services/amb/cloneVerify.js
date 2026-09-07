// AI Media Buyer — Campaign Clone VERIFICATION. After a clone job runs, this
// re-fetches every object it created from Meta (never trusting the POST
// response) and diffs it field-by-field against the source. Produces a
// structured report: MATCH / WARNING / MISMATCH per field, per object.
//
// Read-only. Never writes to Meta or to the source.
import { prisma } from '../../prisma.js';
import { getDecryptedToken } from '../metaAuth.js';
import { graphFetch, getCampaignNode, getAdSetNodes, getAdNodes, getCreativeNode, getAdAccountInfo } from '../metaGraphClient.js';
import { currencyFactor } from './snapshotSync.js';

function j(v, d) { try { return v ? JSON.parse(v) : d; } catch { return d; } }
const norm = (s) => String(s ?? '').trim();
const setEq = (a, b) => {
  const A = new Set((a || []).map(String)); const B = new Set((b || []).map(String));
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
};

function cmp(fields, src, dst, out, level, srcName) {
  for (const f of fields) {
    const name = f.label;
    let sv = f.src ? f.src(src) : src?.[f.key];
    let dv = f.dst ? f.dst(dst) : dst?.[f.key];
    let verdict;
    if (f.eq) verdict = f.eq(sv, dv) ? 'MATCH' : (f.soft ? 'WARNING' : 'MISMATCH');
    else if (sv == null && dv == null) verdict = 'MATCH';
    else if (norm(JSON.stringify(sv)) === norm(JSON.stringify(dv))) verdict = 'MATCH';
    else if (dv == null || dv === '') verdict = 'MISMATCH';
    else verdict = f.soft ? 'WARNING' : 'MISMATCH';
    out.push({ level, object: srcName, field: name, source: sv ?? null, dest: dv ?? null, verdict, note: f.note || null });
  }
}

/** Verify one clone job. Returns { jobId, ok, summary:{MATCH,WARNING,MISMATCH}, objects:[...], diffs:[...] }. */
export async function verifyJob(jobId) {
  const job = await prisma.ambCloneJob.findUnique({ where: { id: Number(jobId) }, include: { objects: true } });
  if (!job) { const e = new Error('الوظيفة مش موجودة.'); e.status = 404; throw e; }
  const token = await getDecryptedToken();
  const dest = job.destination_ad_account_id;
  const src = job.source_ad_account_id;
  const idMap = j(job.id_map_json, {}) || {};

  let factor = 100;
  try { factor = currencyFactor((await getAdAccountInfo(token, dest))?.currency || 'EGP'); } catch { /* keep 100 */ }

  const diffs = [];
  const objects = [];
  const created = (level) => job.objects.filter((o) => o.level === level && o.status === 'CREATED');

  // ---------- Campaign ----------
  const campObj = created('CAMPAIGN')[0];
  if (campObj?.destination_id) {
    let sCamp = null; let dCamp = null;
    try { sCamp = await getCampaignNode(token, job.source_campaign_id); } catch { /* */ }
    try { dCamp = await graphFetch(`/${campObj.destination_id}`, { fields: 'id,name,objective,buying_type,status,effective_status,bid_strategy,daily_budget,lifetime_budget,special_ad_categories,spend_cap' }, token); } catch (e) { dCamp = { __error: e.message }; }
    objects.push({ level: 'CAMPAIGN', sourceId: job.source_campaign_id, destId: campObj.destination_id, fetched: !dCamp?.__error, error: dCamp?.__error || null });
    if (sCamp && dCamp && !dCamp.__error) {
      cmp([
        { label: 'objective', key: 'objective' },
        { label: 'buying_type', src: (x) => x.buying_type || 'AUCTION', dst: (x) => x.buying_type || 'AUCTION' },
        { label: 'budget mode (CBO/ABO)', src: (x) => (x.daily_budget || x.lifetime_budget ? 'CBO' : 'ABO'), dst: (x) => (x.daily_budget || x.lifetime_budget ? 'CBO' : 'ABO') },
        { label: 'daily_budget', src: (x) => (x.daily_budget ? Number(x.daily_budget) : null), dst: (x) => (x.daily_budget ? Number(x.daily_budget) : null) },
        { label: 'lifetime_budget', src: (x) => (x.lifetime_budget ? Number(x.lifetime_budget) : null), dst: (x) => (x.lifetime_budget ? Number(x.lifetime_budget) : null) },
        { label: 'bid_strategy', key: 'bid_strategy', soft: true },
        { label: 'special_ad_categories', src: (x) => x.special_ad_categories || [], dst: (x) => x.special_ad_categories || [], eq: (a, b) => setEq(a.length ? a : ['NONE'], b.length ? b : ['NONE']) },
        { label: 'status = PAUSED', src: () => 'PAUSED', dst: (x) => x.status, eq: (a, b) => b === 'PAUSED' },
      ], sCamp, dCamp, diffs, 'CAMPAIGN', sCamp.name);
    }
  }

  // ---------- Ad Sets ----------
  let srcAdsets = [];
  try { srcAdsets = await getAdSetNodes(token, job.source_campaign_id); } catch { /* */ }
  const srcAdsetById = new Map(srcAdsets.map((a) => [a.id, a]));
  for (const o of created('ADSET')) {
    const s = srcAdsetById.get(o.source_id);
    let d = null;
    try {
      d = await graphFetch(`/${o.destination_id}`, { fields: 'id,name,status,campaign_id,daily_budget,lifetime_budget,billing_event,optimization_goal,bid_amount,bid_strategy,targeting,promoted_object,attribution_spec,start_time,end_time,destination_type' }, token);
    } catch (e) { d = { __error: e.message }; }
    objects.push({ level: 'ADSET', sourceId: o.source_id, destId: o.destination_id, fetched: !d?.__error, error: d?.__error || null });
    if (!s || !d || d.__error) continue;
    cmp([
      { label: 'optimization_goal', key: 'optimization_goal' },
      { label: 'billing_event', key: 'billing_event' },
      { label: 'bid_strategy', key: 'bid_strategy', soft: true },
      { label: 'placements (publisher_platforms)', src: (x) => x.targeting?.publisher_platforms || null, dst: (x) => x.targeting?.publisher_platforms || null, eq: (a, b) => (a == null && b == null) || setEq(a, b), soft: true, note: 'null = Advantage+ placements' },
      { label: 'facebook_positions', src: (x) => x.targeting?.facebook_positions || null, dst: (x) => x.targeting?.facebook_positions || null, eq: (a, b) => (a == null && b == null) || setEq(a, b), soft: true },
      { label: 'geo countries', src: (x) => x.targeting?.geo_locations?.countries || null, dst: (x) => x.targeting?.geo_locations?.countries || null, eq: (a, b) => (a == null && b == null) || setEq(a, b) },
      { label: 'age_min', src: (x) => x.targeting?.age_min ?? null, dst: (x) => x.targeting?.age_min ?? null },
      { label: 'age_max', src: (x) => x.targeting?.age_max ?? null, dst: (x) => x.targeting?.age_max ?? null },
      { label: 'genders', src: (x) => x.targeting?.genders || null, dst: (x) => x.targeting?.genders || null, eq: (a, b) => (a == null && b == null) || setEq(a, b) },
      { label: 'custom_audiences (#)', src: (x) => (x.targeting?.custom_audiences || []).length, dst: (x) => (x.targeting?.custom_audiences || []).length },
      { label: 'excluded_custom_audiences (#)', src: (x) => (x.targeting?.excluded_custom_audiences || []).length, dst: (x) => (x.targeting?.excluded_custom_audiences || []).length },
      { label: 'detailed targeting (flexible_spec #)', src: (x) => (x.targeting?.flexible_spec || []).length, dst: (x) => (x.targeting?.flexible_spec || []).length, soft: true },
      { label: 'promoted_object.pixel_id', src: (x) => x.promoted_object?.pixel_id ?? null, dst: (x) => x.promoted_object?.pixel_id ?? null, soft: true, note: 'may be remapped for a portfolio-shared pixel' },
      { label: 'promoted_object.custom_event_type', src: (x) => x.promoted_object?.custom_event_type ?? null, dst: (x) => x.promoted_object?.custom_event_type ?? null },
      { label: 'promoted_object.product_catalog_id', src: (x) => x.promoted_object?.product_catalog_id ?? null, dst: (x) => x.promoted_object?.product_catalog_id ?? null, soft: true },
      { label: 'attribution_spec', src: (x) => x.attribution_spec || null, dst: (x) => x.attribution_spec || null, eq: (a, b) => JSON.stringify(a) === JSON.stringify(b), soft: true },
      { label: 'daily_budget (ABO)', src: (x) => (x.daily_budget ? Number(x.daily_budget) : null), dst: (x) => (x.daily_budget ? Number(x.daily_budget) : null), soft: true },
      { label: 'lifetime_budget (ABO)', src: (x) => (x.lifetime_budget ? Number(x.lifetime_budget) : null), dst: (x) => (x.lifetime_budget ? Number(x.lifetime_budget) : null), soft: true },
      { label: 'campaign_id → new', src: () => idMap.campaigns?.[job.source_campaign_id] || '(new)', dst: (x) => x.campaign_id, eq: (a, b) => b === (idMap.campaigns?.[job.source_campaign_id]) , note: 'expected: points at the cloned campaign' },
      { label: 'status = PAUSED', src: () => 'PAUSED', dst: (x) => x.status, eq: (a, b) => b === 'PAUSED' },
    ], s, d, diffs, 'ADSET', s.name);
  }

  // ---------- Ads + Creatives ----------
  let srcAds = [];
  try { srcAds = await getAdNodes(token, job.source_campaign_id); } catch { /* */ }
  const srcAdById = new Map(srcAds.map((a) => [a.id, a]));
  for (const o of created('AD')) {
    const s = srcAdById.get(o.source_id);
    let d = null;
    try { d = await graphFetch(`/${o.destination_id}`, { fields: 'id,name,status,adset_id,creative{id},tracking_specs,conversion_domain' }, token); } catch (e) { d = { __error: e.message }; }
    objects.push({ level: 'AD', sourceId: o.source_id, destId: o.destination_id, fetched: !d?.__error, error: d?.__error || null });
    if (!s || !d || d.__error) continue;
    cmp([
      { label: 'has creative', src: () => !!s.creative?.id, dst: (x) => !!x.creative?.id, eq: (a, b) => b === true },
      { label: 'conversion_domain', key: 'conversion_domain', soft: true },
      { label: 'tracking_specs', src: (x) => x.tracking_specs || null, dst: (x) => x.tracking_specs || null, eq: (a, b) => JSON.stringify(a) === JSON.stringify(b), soft: true },
      { label: 'status = PAUSED', src: () => 'PAUSED', dst: (x) => x.status, eq: (a, b) => b === 'PAUSED' },
    ], s, d, diffs, 'AD', s.name);
  }

  for (const o of created('CREATIVE')) {
    let s = null; let d = null;
    try { s = await getCreativeNode(token, o.source_id); } catch { /* */ }
    try { d = await getCreativeNode(token, o.destination_id); } catch (e) { d = { __error: e.message }; }
    objects.push({ level: 'CREATIVE', sourceId: o.source_id, destId: o.destination_id, fetched: !d?.__error, error: d?.__error || null });
    if (!s || !d || d.__error) continue;
    const body = (c) => c.body || c.object_story_spec?.link_data?.message || c.object_story_spec?.video_data?.message || (c.asset_feed_spec?.bodies || [])[0]?.text || null;
    const title = (c) => c.title || c.object_story_spec?.link_data?.name || c.object_story_spec?.video_data?.title || (c.asset_feed_spec?.titles || [])[0]?.text || null;
    const cta = (c) => c.call_to_action_type || c.object_story_spec?.link_data?.call_to_action?.type || c.object_story_spec?.video_data?.call_to_action?.type || (c.asset_feed_spec?.call_to_action_types || [])[0] || null;
    const link = (c) => c.object_story_spec?.link_data?.link || c.link_url || (c.asset_feed_spec?.link_urls || [])[0]?.website_url || null;
    const pageId = (c) => c.object_story_spec?.page_id || null;
    const igId = (c) => c.object_story_spec?.instagram_user_id || c.object_story_spec?.instagram_actor_id || c.instagram_user_id || null;
    const hasVideo = (c) => !!(c.video_id || c.object_story_spec?.video_data?.video_id || (c.asset_feed_spec?.videos || []).length);
    const hasImage = (c) => !!(c.image_hash || c.image_url || c.object_story_spec?.link_data?.image_hash || (c.asset_feed_spec?.images || []).length);
    cmp([
      { label: 'body', src: body, dst: body },
      { label: 'headline/title', src: title, dst: title },
      { label: 'CTA', src: cta, dst: cta },
      { label: 'destination URL', src: link, dst: link },
      { label: 'page_id', src: pageId, dst: pageId },
      { label: 'instagram identity', src: igId, dst: igId, soft: true },
      { label: 'has video media', src: hasVideo, dst: hasVideo, eq: (a, b) => a === b },
      { label: 'has image media', src: hasImage, dst: hasImage, eq: (a, b) => a === b },
    ], s, d, diffs, 'CREATIVE', s.name || o.source_id);
  }

  const summary = { MATCH: 0, WARNING: 0, MISMATCH: 0 };
  for (const dd of diffs) summary[dd.verdict]++;
  return { jobId: job.id, destinationAccountId: dest, sourceAccountId: src, sourceCampaignId: job.source_campaign_id, destinationCampaignId: job.destination_campaign_id, ok: summary.MISMATCH === 0, summary, objects, diffs };
}

export async function verifyBatch(batchId) {
  const jobs = await prisma.ambCloneJob.findMany({ where: { batch_id: batchId, status: { in: ['CLONED_PAUSED', 'ACTIVATION_PENDING', 'ACTIVATED', 'FAILED', 'ACTIVATION_FAILED'] } } });
  const results = [];
  for (const jb of jobs) {
    try { results.push(await verifyJob(jb.id)); }
    catch (e) { results.push({ jobId: jb.id, ok: false, error: e.message }); }
  }
  const summary = { MATCH: 0, WARNING: 0, MISMATCH: 0 };
  for (const r of results) if (r.summary) for (const k of Object.keys(summary)) summary[k] += r.summary[k];
  return { batchId, ok: results.every((r) => r.ok), summary, jobs: results };
}
