// ROOT-CAUSE probe: why does the token see "Rosy dose" but not "Business Ai"?
// READ ONLY. No writes.
import 'dotenv/config';
import { getConnection, getDecryptedToken } from '../services/metaAuth.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const P = (s = '') => process.stdout.write(s + '\n');
let TOKEN;

async function g(path, params = {}) {
  const u = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  u.searchParams.set('access_token', TOKEN);
  const r = await fetch(u);
  const d = await r.json().catch(() => null);
  return { ok: r.ok && !d?.error, status: r.status, data: d, error: d?.error || null };
}

const conn = await getConnection();
TOKEN = await getDecryptedToken();

P('=== Connected Meta user (from DB) ===');
P(`meta_user_id=${conn.meta_user_id}  meta_user_name=${conn.meta_user_name}  connected_at=${conn.connected_at?.toISOString?.() || conn.connected_at}`);
P(`selected_business=${conn.selected_business_id} "${conn.selected_business_name}"  selected_ad_account=${conn.selected_ad_account_id}`);

P('\n=== /me ===');
P(JSON.stringify((await g('/me', { fields: 'id,name' })).data));

P('\n=== token debug (scopes, granular_scopes, expiry) ===');
const dbg = await g('/debug_token', { input_token: TOKEN });
const dd = dbg.data?.data || {};
P(`app_id=${dd.app_id}  type=${dd.type}  is_valid=${dd.is_valid}  expires_at=${dd.expires_at ? new Date(dd.expires_at * 1000).toISOString() : 'never'}  data_access_expires_at=${dd.data_access_expires_at ? new Date(dd.data_access_expires_at * 1000).toISOString() : '-'}`);
P(`scopes: ${JSON.stringify(dd.scopes || [])}`);
P(`granular_scopes: ${JSON.stringify(dd.granular_scopes || [])}`);

P('\n=== /me/permissions ===');
const perms = await g('/me/permissions');
for (const p of perms.data?.data || []) P(`  ${p.permission}: ${p.status}`);

P('\n=== /me/businesses (member of) ===');
const mb = await g('/me/businesses', { fields: 'id,name,verification_status,created_by,permitted_roles,two_factor_type', limit: 100 });
for (const b of mb.data?.data || []) P(`  "${b.name}" [${b.id}] verification=${b.verification_status}`);
if (mb.error) P('  ERROR ' + JSON.stringify(mb.error));

P('\n=== /me/business_users (business-user roles) ===');
const bu = await g('/me/business_users', { fields: 'id,name,role,business{id,name}', limit: 100 });
if (bu.ok) for (const x of bu.data?.data || []) P(`  role=${x.role} business="${x.business?.name}" [${x.business?.id}]`);
else P('  ERROR/none ' + JSON.stringify(bu.error));

P('\n=== /me/assigned_business_asset_groups ===');
const abag = await g('/me/assigned_business_asset_groups', { fields: 'id,name', limit: 50 });
P(bu.ok ? JSON.stringify(abag.data?.data || abag.error) : JSON.stringify(abag.error));

for (const [label, id] of [['ahmed samy', 'act_1518142859790043'], ['Hady', 'act_877011384919552']]) {
  P(`\n=== ${label} (${id}) — direct fetch ===`);
  const a = await g(`/${id}`, { fields: 'name,account_id,account_status,business,owner,partner,funding_source,user_tasks,users{id,name,tasks},agencies{id,name}' });
  if (!a.ok) { P('  ERROR ' + JSON.stringify(a.error)); continue; }
  const x = a.data;
  P(`  name=${x.name}  status=${x.account_status}`);
  P(`  business=${JSON.stringify(x.business || null)}`);
  P(`  owner=${JSON.stringify(x.owner || null)}`);
  P(`  partner=${JSON.stringify(x.partner || null)}`);
  P(`  agencies=${JSON.stringify(x.agencies?.data || x.agencies || null)}`);
  P(`  user_tasks=${JSON.stringify(x.user_tasks || [])}`);
  P(`  users=${JSON.stringify((x.users?.data || []).slice(0, 10))}`);
}

P('\n=== /me/adaccounts (how many, and which have a business) ===');
const aa = await g('/me/adaccounts', { fields: 'id,name,business{id,name}', limit: 300 });
const list = aa.data?.data || [];
P(`  total via /me/adaccounts: ${list.length}`);
const withBiz = list.filter((a) => a.business);
P(`  with a resolvable business: ${withBiz.length}`);
const bizGroups = {};
for (const a of list) { const k = a.business ? `${a.business.name} [${a.business.id}]` : '(no business / individually shared)'; (bizGroups[k] = bizGroups[k] || []).push(a.name); }
for (const [k, v] of Object.entries(bizGroups)) P(`   ${k}: ${v.length} account(s) — ${v.slice(0, 8).join(', ')}${v.length > 8 ? ' …' : ''}`);

P('\n=== Try to locate "Business Ai" by name anywhere reachable ===');
// businesses I own or manage
const owned = await g('/me/businesses', { fields: 'id,name', limit: 200 });
const all = [...(owned.data?.data || [])];
const hit = all.find((b) => /business\s*ai/i.test(b.name || ''));
P(hit ? `  FOUND in /me/businesses: ${JSON.stringify(hit)}` : '  NOT in /me/businesses.');

P('\nDONE — read only.');
process.exit(0);
