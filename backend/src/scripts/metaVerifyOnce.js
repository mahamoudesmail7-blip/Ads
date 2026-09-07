// One-shot post-#4-fix check. ONE probe call; if Meta answers, run the full
// READ-ONLY verification (scopes / /me/accounts / Hady clone identities /
// Business Ai). If Meta is still #4-limited, exit 3 immediately (no retry —
// the caller paces). No writes, no clone.
import 'dotenv/config';
import { getDecryptedToken } from '../services/metaAuth.js';
import { getAccountIdentities } from '../services/metaGraphClient.js';

const P = (s = '') => process.stdout.write(s + '\n');
const G = 'https://graph.facebook.com/v21.0';
const SRC = 'act_1518142859790043';
const DST = 'act_877011384919552';
const token = await getDecryptedToken();
async function g(path, params = {}) {
  const u = new URL(G + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('access_token', token);
  const r = await fetch(u);
  const d = await r.json().catch(() => null);
  return { ok: r.ok && !d?.error, error: d?.error || null, d };
}

const probe = await g('/me', { fields: 'id' });
if (!probe.ok) {
  if (Number(probe.error?.code) === 4) { P('#4 still active'); process.exit(3); }
  P('probe error: ' + JSON.stringify(probe.error)); process.exit(1);
}

P('================ POST-FIX VERIFICATION ================');
const dbg = await g('/debug_token', { input_token: token });
const dd = dbg.d?.data || {};
const scopes = new Set(dd.scopes || []);
P('scopes: ' + JSON.stringify([...scopes]));
for (const s of ['pages_show_list', 'ads_read', 'ads_management', 'business_management']) P(`  ${s}: ${scopes.has(s) ? 'YES' : 'NO'}`);
P('granular business_management: ' + JSON.stringify((dd.granular_scopes || []).find((x) => x.scope === 'business_management') || null));

let pages = [];
const acc = await g('/me/accounts', { fields: 'id,name', limit: 100 });
pages = acc.d?.data || [];
let next = acc.d?.paging?.next; let guard = 0;
while (next && guard++ < 5) { const r = await fetch(next); const d = await r.json().catch(() => null); if (!r.ok || d?.error) break; pages = pages.concat(d.data || []); next = d.paging?.next; }
P(`\n/me/accounts: ${acc.ok ? 'PASS' : 'FAIL ' + JSON.stringify(acc.error)} — ${pages.length} Page(s)`);
for (const p of pages) P(`  ${p.name}  [${p.id}]`);

P('\n--- Campaign Clone: destination identities for Hady ---');
const id = await getAccountIdentities(token, DST, { force: true });
for (const p of id.pages) P(`  ${p.name || p.id}  [${p.id}]  source=${p.source}`);
const userInDropdown = id.pages.filter((p) => p.source === 'user_account');
P(`Hady destination Page dropdown contains the user's Facebook Pages: ${userInDropdown.length > 0 ? 'YES (' + userInDropdown.length + ')' : 'NO'}`);
P(`instagram options: ${id.instagram.length}`);

const biz = await g('/me/businesses', { fields: 'id,name' });
const names = (biz.d?.data || []).map((b) => b.name);
P(`\nBusinesses visible: ${JSON.stringify(names)}`);
P(`Business Ai detected: ${names.some((n) => /business\s*ai/i.test(n)) ? 'YES' : 'NO'}`);
const aa = await g('/me/adaccounts', { fields: 'id,name', limit: 300 });
const accts = aa.d?.data || [];
P(`ad accounts: ${accts.length} · Ahmed Samy: ${accts.some((a) => a.id === SRC) ? 'YES' : 'NO'} · Hady: ${accts.some((a) => a.id === DST) ? 'YES' : 'NO'}`);
P('\nDONE — read only, no clone executed.');
process.exit(0);
