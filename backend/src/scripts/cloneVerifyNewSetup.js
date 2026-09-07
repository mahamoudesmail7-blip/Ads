// STEP 1-3: verify the NEW Meta setup (Business Ai / ahmed samy -> Hady),
// refresh every asset FRESH from Meta (no cache), run the AdCreative
// capability test (creates + deletes ONE temp creative — explicitly approved),
// and list the real campaigns in the source account.
//
// READ ONLY except the single temp AdCreative, which is deleted immediately.
// Creates NO campaign / ad set / ad. Touches nothing in the source account.
//   node src/scripts/cloneVerifyNewSetup.js
import 'dotenv/config';
import { getConnection, getDecryptedToken } from '../services/metaAuth.js';
import {
  getAllAccessibleAdAccounts, listCampaignsForClone, getAccountAssetsForClone,
  getAccountIdentities, createAdCreative,
} from '../services/metaGraphClient.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const SRC_NAME = 'ahmed samy';
const DST_NAME = 'Hady';
const BIZ_NAME = 'Business Ai';
const P = (s = '') => process.stdout.write(s + '\n');

async function gget(path, params = {}) {
  const u = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  u.searchParams.set('access_token', TOKEN);
  const r = await fetch(u);
  const d = await r.json().catch(() => null);
  return { ok: r.ok && !d?.error, status: r.status, data: d, error: d?.error || null };
}

let TOKEN;

// ---------------------------------------------------------------------------
const conn = await getConnection();
P('================ STEP 1 — NEW META SETUP VERIFICATION ================');
P(`Meta connection status: ${conn?.status || 'NONE'}`);
if (!conn || conn.status !== 'CONNECTED') { P('❌ Meta not connected. Stop.'); process.exit(1); }
TOKEN = await getDecryptedToken();

// --- token scopes ---
const perms = await gget('/me/permissions');
const granted = new Set((perms.data?.data || []).filter((p) => p.status === 'granted').map((p) => p.permission));
const declined = (perms.data?.data || []).filter((p) => p.status === 'declined').map((p) => p.permission);
P('\n--- Token permissions (granted) ---');
P([...granted].sort().join(', ') || '(none returned)');
if (declined.length) P('declined: ' + declined.join(', '));
const hasAdsRead = granted.has('ads_read');
const hasAdsMgmt = granted.has('ads_management');
P(`ads_read       : ${hasAdsRead ? 'YES' : 'NO'}`);
P(`ads_management : ${hasAdsMgmt ? 'YES' : 'NO'}`);
P(`business_management: ${granted.has('business_management') ? 'YES' : 'NO'}   pages_show_list: ${granted.has('pages_show_list') ? 'YES' : 'NO'}   pages_read_engagement: ${granted.has('pages_read_engagement') ? 'YES' : 'NO'}`);

// --- app id + (best-effort) live/mode ---
const app = await gget('/me', { fields: 'id' }); // token owner
const dbg = await gget('/debug_token', { input_token: TOKEN });
const appId = dbg.data?.data?.app_id || null;
const appScopes = dbg.data?.data?.scopes || [];
P(`\n--- App ---`);
P(`app_id (from token): ${appId || 'unknown'}`);
let appLive = null;
if (appId) {
  const appNode = await gget(`/${appId}`, { fields: 'id,name,link,app_type,restrictions' });
  P(`app: ${JSON.stringify(appNode.data || appNode.error)}`);
  // Meta doesn't expose a clean "mode" field; the AdCreative test below is the real check.
}

// --- businesses ---
P('\n--- Businesses on this token ---');
const biz = await gget('/me/businesses', { fields: 'id,name,verification_status,is_disabled_for_integrations,created_time', limit: 100 });
const bizList = biz.data?.data || [];
for (const b of bizList) P(`  ${b.name}  [${b.id}]  verification=${b.verification_status}  disabled=${b.is_disabled_for_integrations}`);
const bizAi = bizList.find((b) => (b.name || '').toLowerCase() === BIZ_NAME.toLowerCase())
  || bizList.find((b) => (b.name || '').toLowerCase().includes('business ai'));
P(bizAi ? `\n"${BIZ_NAME}" → ${bizAi.id}  verification_status=${bizAi.verification_status}` : `\n⚠️ "${BIZ_NAME}" not found among businesses on this token.`);

// --- ad accounts (fresh) ---
P('\n--- Accessible ad accounts (fresh from Meta) ---');
const accts = await getAllAccessibleAdAccounts(TOKEN);
P(`total accessible: ${accts.length}`);
const norm = (s) => String(s || '').trim().toLowerCase();
const src = accts.find((a) => norm(a.name) === norm(SRC_NAME)) || accts.find((a) => norm(a.name).includes('ahmed samy'));
const dst = accts.find((a) => norm(a.name) === norm(DST_NAME)) || accts.find((a) => norm(a.name).includes('hady'));
P(src ? `SOURCE  "${src.name}"  ${src.id}  currency=${src.currency}  tz=${src.timezoneName}  status=${src.accountStatus}  business=${JSON.stringify(src.business || null)}` : `❌ SOURCE "${SRC_NAME}" NOT FOUND`);
P(dst ? `DEST    "${dst.name}"  ${dst.id}  currency=${dst.currency}  tz=${dst.timezoneName}  status=${dst.accountStatus}  business=${JSON.stringify(dst.business || null)}` : `❌ DEST "${DST_NAME}" NOT FOUND`);
if (!src || !dst) { P('\nCannot continue without both accounts. Stop.'); process.exit(1); }

// --- per-account detail: capabilities + user_tasks ---
async function acctDetail(id, label) {
  const d = await gget(`/${id}`, { fields: 'name,account_status,disable_reason,currency,timezone_name,capabilities,funding_source,user_tasks,business{id,name,verification_status}' });
  P(`\n--- ${label} detail (${id}) ---`);
  if (!d.ok) { P(`  ❌ read failed: ${JSON.stringify(d.error)}`); return null; }
  const x = d.data;
  P(`  name=${x.name}  account_status=${x.account_status}  disable_reason=${x.disable_reason}`);
  P(`  user_tasks=${JSON.stringify(x.user_tasks || [])}`);
  P(`  business=${JSON.stringify(x.business || null)}`);
  P(`  capabilities=${JSON.stringify(x.capabilities || [])}`);
  return x;
}
const srcD = await acctDetail(src.id, 'SOURCE ahmed samy');
const dstD = await acctDetail(dst.id, 'DEST Hady');
const dstTasks = new Set(dstD?.user_tasks || []);
const dstCanManage = dstTasks.has('MANAGE') || dstTasks.has('ADVERTISE'); // MANAGE = full; ADVERTISE = can create/run ads

// --- SOURCE read test ---
P('\n--- SOURCE read access test ---');
let srcReadPass = false; let srcCampaigns = [];
try {
  srcCampaigns = await listCampaignsForClone(TOKEN, src.id, { since: daysAgo(30), until: today() });
  srcReadPass = Array.isArray(srcCampaigns);
  P(`  PASS — listed ${srcCampaigns.length} campaign(s) (last 30d window helper).`);
} catch (e) { P(`  FAIL — ${e.message}`); }
// also a raw unrestricted campaign count
const rawC = await gget(`/${src.id}/campaigns`, { fields: 'id,name,status,effective_status,objective', limit: 200 });
const rawCampaigns = rawC.data?.data || [];
P(`  raw /campaigns read: ${rawC.ok ? 'PASS' : 'FAIL ' + JSON.stringify(rawC.error)} — ${rawCampaigns.length} campaign(s) total (all statuses)`);

// --- DEST identities + assets (fresh) ---
P('\n--- DEST Hady — Pages / Instagram / Pixels (fresh) ---');
const dIdent = await getAccountIdentities(TOKEN, dst.id).catch((e) => ({ __error: e.message }));
P(`  pages: ${JSON.stringify((dIdent.pages || []).map((p) => ({ id: p.id, name: p.name, source: p.source, verified: p.verified })))}`);
P(`  instagram: ${JSON.stringify(dIdent.instagram || [])}`);
P(`  pagesVerified=${dIdent.pagesVerified}  instagramReadable=${dIdent.instagramReadable}`);
const dAssets = await getAccountAssetsForClone(TOKEN, dst.id).catch((e) => ({ __error: e.message }));
P(`  pixels/datasets: ${JSON.stringify((dAssets.pixels || []).map((p) => ({ id: p.id, name: p.name })))}`);
P(`  custom audiences: ${(dAssets.customAudiences || dAssets.audiences || []).length}`);

P('\n--- SOURCE ahmed samy — Pages / Instagram / Pixels (fresh) ---');
const sIdent = await getAccountIdentities(TOKEN, src.id).catch((e) => ({ __error: e.message }));
P(`  pages: ${JSON.stringify((sIdent.pages || []).map((p) => ({ id: p.id, name: p.name })))}`);
P(`  instagram: ${JSON.stringify(sIdent.instagram || [])}`);
const sAssets = await getAccountAssetsForClone(TOKEN, src.id).catch((e) => ({ __error: e.message }));
P(`  pixels/datasets: ${JSON.stringify((sAssets.pixels || []).map((p) => ({ id: p.id, name: p.name })))}`);

// shared
const dPix = new Set((dAssets.pixels || []).map((p) => String(p.id)));
const sharedPix = (sAssets.pixels || []).filter((p) => dPix.has(String(p.id)));
const dPg = new Set((dIdent.pages || []).map((p) => String(p.id)));
const sPg = new Set((sIdent.pages || []).map((p) => String(p.id)));
const sharedPages = (dIdent.pages || []).filter((p) => sPg.has(String(p.id)));
P('\n--- SHARED source ↔ dest ---');
P(`  shared pages: ${JSON.stringify(sharedPages.map((p) => ({ id: p.id, name: p.name })))}`);
P(`  shared pixels: ${JSON.stringify(sharedPix.map((p) => ({ id: p.id, name: p.name })))}`);
P(`  currency match: ${src.currency === dst.currency ? 'YES (' + src.currency + ')' : 'NO (' + src.currency + ' vs ' + dst.currency + ')'}`);

// ---------------------------------------------------------------------------
P('\n================ STEP 2 — AdCreative CAPABILITY TEST (Hady) ================');
// Pick a Page Hady can post as. Prefer one in Hady's own identity list.
const testPage = (dIdent.pages || [])[0] || (sIdent.pages || []).find((p) => dPg.has(String(p.id))) || null;
let creativePass = null; let devModeBlocker = null; let capDetail = '';
if (!testPage) {
  creativePass = false;
  capDetail = 'لا توجد صفحة فيسبوك متاحة لحساب Hady لعمل اختبار AdCreative — لازم تربط صفحة بالحساب الوجهة.';
  P('  ⚠️ ' + capDetail);
} else {
  P(`  test page: ${testPage.name} [${testPage.id}]`);
  const payload = {
    name: `__capability_test__${Date.now()} (delete me)`,
    object_story_spec: {
      page_id: String(testPage.id),
      link_data: { link: 'https://www.facebook.com', message: 'capability test — safe to delete' },
    },
  };
  try {
    const res = await createAdCreative(TOKEN, dst.id, payload);
    creativePass = true; devModeBlocker = 'FIXED';
    P(`  ✅ PASS — AdCreative created: ${res.id}`);
    // clean up
    const del = await fetch(`${GRAPH}/${res.id}?access_token=${encodeURIComponent(TOKEN)}`, { method: 'DELETE' });
    const dj = await del.json().catch(() => null);
    P(`  cleanup delete: ${del.ok && dj?.success !== false ? 'OK (removed)' : 'could not delete — ' + JSON.stringify(dj)} ${del.ok ? '' : '(id ' + res.id + ' — remove manually if it lingers)'}`);
  } catch (e) {
    creativePass = false;
    const sub = e.graphSubcode ?? e?.graphSubcode;
    capDetail = `${e.message}${sub != null ? ` [subcode=${sub}]` : ''}${e.graphUserMsg ? ` — ${e.graphUserMsg}` : ''}`;
    devModeBlocker = String(sub) === '1885183' || /development mode/i.test(capDetail) ? 'STILL EXISTS' : 'N/A (different error)';
    P(`  ❌ FAIL — ${capDetail}`);
  }
}

// ---------------------------------------------------------------------------
P('\n================ STEP 3 — CAMPAIGNS IN ahmed samy ================');
const listForUi = rawCampaigns.length ? rawCampaigns : srcCampaigns;
P(`Detected ${listForUi.length} campaign(s) in "${src.name}":`);
for (const c of listForUi) P(`  [${c.status || c.effective_status}]  ${c.name}  —  ${c.id}  (${c.objective || '—'})`);

// ---------------------------------------------------------------------------
P('\n================ SUMMARY ================');
P(`Business Ai              : ${bizAi ? (String(bizAi.verification_status).toLowerCase().includes('verified') ? 'VERIFIED' : 'FOUND — verification_status=' + bizAi.verification_status) : 'PROBLEM (not found on token)'}`);
P(`Meta App Live            : ${creativePass === true ? 'YES (AdCreative POST succeeded)' : creativePass === false && devModeBlocker === 'STILL EXISTS' ? 'NO (still development mode)' : 'INCONCLUSIVE'}`);
P(`ads_management           : ${hasAdsMgmt ? 'YES' : 'NO'}`);
P(`ads_read                 : ${hasAdsRead ? 'YES' : 'NO'}`);
P(`ahmed samy READ ACCESS   : ${srcReadPass && rawC.ok ? 'PASS' : 'FAIL'}`);
P(`Hady MANAGEMENT ACCESS   : ${dstCanManage ? 'PASS (user_tasks=' + JSON.stringify([...dstTasks]) + ')' : 'FAIL / UNKNOWN (user_tasks=' + JSON.stringify([...dstTasks]) + ')'}`);
P(`AdCreative capability     : ${creativePass === true ? 'PASS' : 'FAIL'}${capDetail ? ' — ' + capDetail : ''}`);
P(`Previous dev-mode blocker : ${devModeBlocker || (creativePass ? 'FIXED' : 'UNKNOWN')}`);
P(`Campaigns detected        : ${listForUi.length}`);
P('');
P('IDS FOR THE DRY RUN:');
P(`  source: ${src.id}`);
P(`  dest  : ${dst.id}`);
P(`  campaign ids: ${JSON.stringify(listForUi.map((c) => c.id))}`);
P('\nDONE — no Campaign/AdSet/Ad created. Source account untouched.');
process.exit(0);

function today() { return new Date().toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
