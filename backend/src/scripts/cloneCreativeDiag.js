// READ-ONLY diagnosis of the FAILED creatives for clone job 12
// (Ahmed Samy → Hady, campaign "Hair-Remover _ scale 4"). Fetches the real
// source Ads + AdCreatives + the underlying Page post(s) from Meta with every
// relevant field, and reports where (if anywhere) the destination URL lives.
// No writes. No clone. No new objects.
import 'dotenv/config';
import { getDecryptedToken } from '../services/metaAuth.js';

const P = (s = '') => process.stdout.write(s + '\n');
const G = 'https://graph.facebook.com/v21.0';
const token = await getDecryptedToken();

async function g(path, params = {}) {
  const u = new URL(G + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  u.searchParams.set('access_token', token);
  const r = await fetch(u);
  const d = await r.json().catch(() => null);
  return { ok: r.ok && !d?.error, error: d?.error || null, d };
}

const SRC_CAMPAIGN = '120252236179650205';
const ADS = ['120252236179640205', '120252236179630205', '120252236179660205'];
const CREATIVES = ['1559992342090453', '932629016033661', '1750505422915146'];

const CREATIVE_FIELDS = [
  'id', 'name', 'status', 'account_id', 'object_type', 'call_to_action_type',
  'object_story_id', 'effective_object_story_id', 'object_story_spec',
  'asset_feed_spec', 'degrees_of_freedom_spec', 'contextual_multi_ads',
  'link_url', 'link_og_id', 'template_url', 'template_url_spec', 'object_url',
  'url_tags', 'image_hash', 'image_url', 'thumbnail_url', 'thumbnail_id',
  'body', 'title', 'link_deep_link_url', 'instagram_permalink_url',
  'instagram_user_id', 'actor_id', 'product_set_id', 'effective_instagram_media_id',
  'branded_content_sponsor_page_id', 'source_instagram_media_id', 'authorization_category',
].join(',');

const POST_FIELDS = [
  'id', 'message', 'story', 'permalink_url', 'created_time', 'status_type', 'type',
  'call_to_action', 'link', 'name', 'caption', 'description', 'picture', 'full_picture',
  'object_id', 'properties', 'child_attachments', 'is_published', 'promotion_status',
  'attachments{title,description,url,unshimmed_url,target,media,type,subattachments}',
].join(',');

// ---- per source ad ----
P('================ SOURCE ADS (job 12 — campaign ' + SRC_CAMPAIGN + ') ================');
for (const adId of ADS) {
  P('\n------------------------------------------------------------');
  const ad = await g(`/${adId}`, { fields: `id,name,status,effective_status,adset_id,campaign_id,tracking_specs,conversion_domain,creative{${CREATIVE_FIELDS}}` });
  if (!ad.ok) { P(`AD ${adId}: READ FAILED — ${JSON.stringify(ad.error)}`); continue; }
  P(`AD ${ad.d.id}  "${ad.d.name}"  status=${ad.d.status}/${ad.d.effective_status}`);
  P(`  adset=${ad.d.adset_id}`);
  P(`  tracking_specs = ${JSON.stringify(ad.d.tracking_specs || null)}`);
  P(`  conversion_domain = ${JSON.stringify(ad.d.conversion_domain || null)}`);
  const cr = ad.d.creative || {};
  P(`  creative(inline) = ${JSON.stringify(cr, null, 1)}`);
}

// ---- per source creative (full) ----
P('\n\n================ SOURCE ADCREATIVES (full) ================');
for (const crId of CREATIVES) {
  P('\n------------------------------------------------------------');
  const cr = await g(`/${crId}`, { fields: CREATIVE_FIELDS });
  if (!cr.ok) { P(`CREATIVE ${crId}: READ FAILED — ${JSON.stringify(cr.error)}`); continue; }
  const c = cr.d;
  P(`CREATIVE ${c.id}  "${c.name || ''}"  object_type=${c.object_type}`);
  P(JSON.stringify(c, null, 1));

  const postId = c.effective_object_story_id || c.object_story_id;
  if (postId) {
    P(`\n  >>> underlying Page post ${postId} <<<`);
    const post = await g(`/${postId}`, { fields: POST_FIELDS });
    if (post.ok) {
      P('  ' + JSON.stringify(post.d, null, 1).replace(/\n/g, '\n  '));
    } else {
      P(`  post read FAILED — ${JSON.stringify(post.error)}`);
      // try the Page feed for a story with this id
      const pageId = String(postId).split('_')[0];
      const alt = await g(`/${postId}`, { fields: 'id,message,permalink_url,call_to_action' });
      P(`  fallback minimal: ${JSON.stringify(alt.ok ? alt.d : alt.error)}`);
      void pageId;
    }
    // Also: the ad-account adcreative's object_story_spec derived from the post
    const spec = await g(`/${crId}`, { fields: 'object_story_spec{page_id,instagram_user_id,link_data{link,message,name,description,caption,call_to_action,image_hash,child_attachments},photo_data{image_hash,url,caption,call_to_action},video_data{video_id,call_to_action,message,title,link_description}}' });
    P(`  object_story_spec expansion: ${JSON.stringify(spec.ok ? spec.d.object_story_spec : spec.error, null, 1)}`);
  }
}

P('\n================ DONE — read only, nothing written ================');
process.exit(0);
