// READ-ONLY: try to recover the destination URL + copy fields for the 3
// failed creatives of clone job 12 by reading the underlying Page post with a
// PAGE access token (the user manages page 1057348680790803 "Trendy Storee").
// No writes.
import 'dotenv/config';
import { getDecryptedToken } from '../services/metaAuth.js';

const P = (s = '') => process.stdout.write(s + '\n');
const G = 'https://graph.facebook.com/v21.0';
const userToken = await getDecryptedToken();
const PAGE_ID = '1057348680790803';
const POSTS = [
  '1057348680790803_122117205117042516', // ad 120252236179640205 / creative 1559992342090453
  '1057348680790803_122105075835042516', // ad 120252236179630205 / creative 932629016033661
  '1057348680790803_122117193927042516', // ad 120252236179660205 / creative 1750505422915146
];

async function g(path, params, tok) {
  const u = new URL(G + path);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  u.searchParams.set('access_token', tok);
  const r = await fetch(u);
  const d = await r.json().catch(() => null);
  return { ok: r.ok && !d?.error, error: d?.error || null, d };
}

// 1) get a Page access token
const acc = await g('/me/accounts', { fields: 'id,name,access_token,tasks', limit: 200 }, userToken);
if (!acc.ok) { P('me/accounts failed: ' + JSON.stringify(acc.error)); process.exit(1); }
const page = (acc.d.data || []).find((p) => String(p.id) === PAGE_ID);
if (!page) { P('page ' + PAGE_ID + ' not in /me/accounts'); process.exit(1); }
P(`Page: ${page.name} [${page.id}]  tasks=${JSON.stringify(page.tasks || [])}  hasPageToken=${!!page.access_token}`);
const pageToken = page.access_token;

const POST_FIELDS = [
  'id', 'message', 'created_time', 'permalink_url', 'status_type', 'is_published',
  'call_to_action{type,value}', 'name', 'description', 'caption', 'link', 'picture', 'full_picture',
  'attachments{title,description,type,url,unshimmed_url,target{id,url},media,subattachments}',
  'child_attachments', 'properties',
].join(',');

for (const postId of POSTS) {
  P('\n============================================================');
  P('POST ' + postId);
  // try with page token first, then user token
  let post = pageToken ? await g(`/${postId}`, { fields: POST_FIELDS }, pageToken) : { ok: false, error: 'no page token' };
  if (!post.ok) {
    P('  [page-token read failed: ' + JSON.stringify(post.error) + '] — retrying with user token');
    post = await g(`/${postId}`, { fields: POST_FIELDS }, userToken);
  }
  if (!post.ok) { P('  BOTH READS FAILED: ' + JSON.stringify(post.error)); continue; }
  P(JSON.stringify(post.d, null, 1));

  // extract candidate URLs
  const d = post.d;
  const urls = new Set();
  const cta = d.call_to_action?.value?.link || d.call_to_action?.value?.link_url;
  if (cta) urls.add('call_to_action.value.link: ' + cta);
  if (d.link) urls.add('post.link: ' + d.link);
  for (const a of d.attachments?.data || []) {
    if (a.url) urls.add('attachment.url: ' + a.url);
    if (a.unshimmed_url) urls.add('attachment.unshimmed_url: ' + a.unshimmed_url);
    if (a.target?.url) urls.add('attachment.target.url: ' + a.target.url);
    for (const s of a.subattachments?.data || []) {
      if (s.url) urls.add('sub.url: ' + s.url);
      if (s.target?.url) urls.add('sub.target.url: ' + s.target.url);
    }
  }
  const m = (d.message || '').match(/https?:\/\/[^\s"'<>)]+/);
  if (m) urls.add('message text URL: ' + m[0]);
  P('\n  >>> CANDIDATE DESTINATION URLs:');
  if (urls.size) for (const u of urls) P('     - ' + u); else P('     (none found)');
  P('  >>> primary text (message): ' + JSON.stringify((d.message || '').slice(0, 300)));
  P('  >>> headline (attachment.title / name): ' + JSON.stringify(d.attachments?.data?.[0]?.title || d.name || null));
  P('  >>> description (attachment.description / description): ' + JSON.stringify(d.attachments?.data?.[0]?.description || d.description || null));
  P('  >>> CTA: ' + JSON.stringify(d.call_to_action || null));
}

P('\nDONE — read only.');
process.exit(0);
