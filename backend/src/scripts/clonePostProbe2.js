// READ-ONLY retry: page token + non-deprecated field sets to recover the
// destination URL / copy fields for the 3 posts behind clone job 12.
import 'dotenv/config';
import { getDecryptedToken } from '../services/metaAuth.js';

const P = (s = '') => process.stdout.write(s + '\n');
const G = 'https://graph.facebook.com/v21.0';
const userToken = await getDecryptedToken();
const PAGE_ID = '1057348680790803';
const POSTS = [
  '1057348680790803_122117205117042516',
  '1057348680790803_122105075835042516',
  '1057348680790803_122117193927042516',
];

async function g(path, params, tok) {
  const u = new URL(G + path);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  u.searchParams.set('access_token', tok);
  const r = await fetch(u);
  const d = await r.json().catch(() => null);
  return { ok: r.ok && !d?.error, error: d?.error || null, d };
}

const acc = await g('/me/accounts', { fields: 'id,name,access_token', limit: 200 }, userToken);
const page = (acc.d.data || []).find((p) => String(p.id) === PAGE_ID);
const pageToken = page?.access_token;
P(`page token: ${pageToken ? 'yes' : 'NO'}`);

const TRIES = [
  { label: 'minimal', fields: 'id,message,permalink_url,created_time,status_type' },
  { label: 'cta', fields: 'id,call_to_action' },
  { label: 'name/desc/link/caption', fields: 'id,name,description,link,caption' },
  { label: 'attachments (bare)', fields: 'id,attachments' },
  { label: 'attachments (target/url only)', fields: 'id,attachments{unshimmed_url,target,type,title,description}' },
];

for (const postId of POSTS) {
  P('\n============================================================');
  P('POST ' + postId);
  for (const t of TRIES) {
    const r = await g(`/${postId}`, { fields: t.fields }, pageToken);
    P(`  [${t.label}] ${r.ok ? 'OK  ' + JSON.stringify(r.d) : 'ERR ' + JSON.stringify(r.error)}`);
  }
  // the /attachments edge directly
  const at = await g(`/${postId}/attachments`, {}, pageToken);
  P(`  [/attachments edge] ${at.ok ? JSON.stringify(at.d) : 'ERR ' + JSON.stringify(at.error)}`);
}

// Also: the Page's ads_posts / promotable_posts — these often carry the link.
P('\n============================================================');
P('Page /ads_posts (promotable) — first 10, with link + cta:');
const ap = await g(`/${PAGE_ID}/ads_posts`, { fields: 'id,message,created_time,call_to_action,permalink_url,object_id', limit: 25 }, pageToken);
if (ap.ok) {
  for (const post of ap.d.data || []) {
    const match = POSTS.includes(post.id) || POSTS.some((x) => x.endsWith('_' + String(post.id).split('_').pop()));
    P(`  ${match ? '>>>' : '   '} ${post.id}  cta=${JSON.stringify(post.call_to_action || null)}  msg="${String(post.message || '').slice(0, 80)}"`);
  }
} else {
  P('  ERR ' + JSON.stringify(ap.error));
}

P('\nDONE — read only.');
process.exit(0);
