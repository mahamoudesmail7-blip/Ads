// Post-#4-fix verification. Waits out any active Meta rate-limit, then checks
// (READ ONLY, minimal call budget):
//   9)  scopes still granted: pages_show_list / ads_read / ads_management /
//       business_management
//   9b) /me/accounts still returns the Pages (count + names)
//   10) Campaign Clone identity for Hady — does the destination Page list now
//       contain the user's Facebook Pages?  (uses the CACHED getAccountIdentities)
// No clone executed. No writes.
import 'dotenv/config';
import { getDecryptedToken } from '../services/metaAuth.js';
import { getAccountIdentities } from '../services/metaGraphClient.js';

const P = (s = '') => process.stdout.write(s + '\n');
const G = 'https://graph.facebook.com/v21.0';
const SRC = 'act_1518142859790043'; // Ahmed Samy
const DST = 'act_877011384919552';  // Hady

const token = await getDecryptedToken();
async function g(path, params = {}) {
  const u = new URL(G + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('access_token', token);
  const r = await fetch(u);
  const d = await r.json().catch(() => null);
  return { ok: r.ok && !d?.error, error: d?.error || null, d };
}

// --- wait out #4 (max ~25 min) ---
let ready = false;
for (let i = 0; i < 50; i++) {
  const probe = await g('/me', { fields: 'id' });
  if (probe.ok) { ready = true; break; }
  if (Number(probe.error?.code) === 4) {
    P(`[#4 still active — retry ${i + 1}/50 in 30s]`);
    await new Promise((r) => setTimeout(r, 30000));
    continue;
  }
  P('Unexpected error: ' + JSON.stringify(probe.error));
  process.exit(1);
}
if (!ready) { P('Meta still #4-limited after ~25 min — try again later.'); process.exit(2); }

P('================ POST-FIX VERIFICATION ================');
// 9) scopes
const dbg = await g('/debug_token', { input_token: token });
const dd = dbg.d?.data || {};
const scopes = new Set(dd.scopes || []);
const need = ['pages_show_list', 'ads_read', 'ads_management', 'business_management'];
P('scopes: ' + JSON.stringify([...scopes]));
for (const s of need) P(`  ${s}: ${scopes.has(s) ? 'YES' : 'NO'}`);
P('granular business_management: ' + JSON.stringify((dd.granular_scopes || []).find((x) => x.scope === 'business_management') || null));

// 9b) /me/accounts
const acc = await g('/me/accounts', { fields: 'id,name', limit: 100 });
let pages = acc.d?.data || [];
let next = acc.d?.paging?.next;
let guard = 0;
while (next && guard++ < 5) {
  const r = await fetch(next); const d = await r.json().catch(() => null);
  if (!r.ok || d?.error) break;
  pages = pages.concat(d.data || []); next = d.paging?.next;
}
P(`\n/me/accounts: ${acc.ok ? 'PASS' : 'FAIL ' + JSON.stringify(acc.error)} — ${pages.length} Page(s)`);
for (const p of pages) P(`  ${p.name}  [${p.id}]`);

// 10) Clone identity for Hady (destination) — cached path
P('\n--- Campaign Clone: destination identities for Hady (act_877011384919552) ---');
const id = await getAccountIdentities(token, DST, { force: true });
P(`pages available to destination (${id.pages.length}):`);
for (const p of id.pages) P(`  ${p.name || p.id}  [${p.id}]  source=${p.source}`);
P(`instagram (${id.instagram.length}): ${JSON.stringify(id.instagram.slice(0, 10))}`);
const userPagesInDropdown = id.pages.filter((p) => p.source === 'user_account');
P(`\nHady destination Page dropdown contains the user's Facebook Pages: ${userPagesInDropdown.length > 0 ? 'YES (' + userPagesInDropdown.length + ')' : 'NO'}`);

// Business Ai visible?
const biz = await g('/me/businesses', { fields: 'id,name' });
const names = (biz.d?.data || []).map((b) => b.name);
P(`\nBusinesses visible: ${JSON.stringify(names)}`);
P(`Business Ai detected: ${names.some((n) => /business\s*ai/i.test(n)) ? 'YES' : 'NO'}`);
P(`Ahmed Samy / Hady still reachable: check /me/adaccounts`);
const aa = await g('/me/adaccounts', { fields: 'id,name', limit: 300 });
const accts = aa.d?.data || [];
P(`  total ad accounts: ${accts.length}`);
P(`  Ahmed Samy: ${accts.some((a) => a.id === SRC) ? 'YES' : 'NO'}   Hady: ${accts.some((a) => a.id === DST) ? 'YES' : 'NO'}`);

P('\nDONE — read only, no clone executed.');
process.exit(0);
