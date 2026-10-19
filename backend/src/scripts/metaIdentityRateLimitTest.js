// 📸 INSTAGRAM IDENTITY DISCOVERY vs META THROTTLING — a rate-limited (#17) Instagram edge used to read as «no Instagram account» and was CACHED for 5 minutes, so the launch wizard blocked a Page that really has one.
//   Now: a throttled read is «unknown» (instagramRateLimited), never cached as final, a previous complete answer is kept, and the lazy per-Page read says rateLimited. Meta MOCK only (loopback); no real Meta call.
//   node src/scripts/metaIdentityRateLimitTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };

// ---- the Meta mock: only the edges identity discovery reads
const S = { igEdge: 'EMPTY', pageIg: 'NONE', calls: [] }; // igEdge: EMPTY | HAS | RATE ; pageIg: NONE | HAS | RATE
const RATE = { error: { message: '(#17) User request limit reached', type: 'OAuthException', code: 17, error_subcode: 2446079 } };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const path = u.pathname.replace(/^\/v[\d.]+/, ''); S.calls.push(path); const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (path === '/me/accounts') return send(200, { data: [{ id: '111111111', name: 'Trendy Store.' }] });
  if (/\/promote_pages$/.test(path)) return send(200, { data: [] });
  if (/\/instagram_accounts$/.test(path)) return send(200, { data: [] });
  if (/\/connected_instagram_accounts$/.test(path)) return S.igEdge === 'RATE' ? send(400, RATE) : send(200, { data: S.igEdge === 'HAS' ? [{ id: '17841400000000001', username: 'trendy.store2020' }] : [] });
  if (/^\/act_/.test(path)) { const f = u.searchParams.get('fields') || ''; if (/instagram_business_accounts/.test(f)) return send(200, { business: { instagram_business_accounts: { data: [] } } }); return send(200, { business: { owned_pages: { data: [] }, client_pages: { data: [] } } }); }
  if (/^\/\d{5,}$/.test(path)) { if (S.pageIg === 'RATE') return send(400, RATE); if (S.pageIg === 'HAS') return send(200, { id: path.slice(1), connected_instagram_account: { id: '17841400000000001', username: 'trendy.store2020' } }); return send(200, { id: path.slice(1) }); }
  if (path === '/missing') return send(400, { error: { message: 'Unsupported get request', code: 100, error_subcode: 33 } });
  send(404, { error: { message: 'mock: unsupported', code: 100 } });
});
await new Promise((rs) => server.listen(0, '127.0.0.1', rs));
process.env.META_GRAPH_MOCK = '1'; process.env.META_GRAPH_MOCK_URL = `http://127.0.0.1:${server.address().port}`;
const G = await imp('../services/metaGraphClient.js'); const C = await imp('../services/metaAssetCache.js');
const igCalls = () => S.calls.filter((p) => /connected_instagram_accounts$/.test(p)).length;

try {
  console.log('\n1. A throttled Instagram edge is «unknown», never «no Instagram» — and is not cached as final');
  { S.igEdge = 'RATE'; S.calls = []; const a = await G.getAccountIdentities('tokA', 'act_1', { force: true });
    ok('Meta answers #17 on connected_instagram_accounts → instagramRateLimited=true, instagram [], instagramReadable=false (NOT «no Instagram»)', a.instagramRateLimited === true && a.instagram.length === 0 && a.instagramReadable === false, JSON.stringify([a.instagramRateLimited, a.instagram, a.instagramReadable]));
    ok('the Pages are still discovered (the throttle only affects the Instagram edge)', a.pages.length === 1 && a.pages[0].id === '111111111');
    S.igEdge = 'HAS'; await new Promise((r) => setTimeout(r, 2200)); const before = igCalls(); const b = await G.getAccountIdentities('tokA', 'act_1'); // (the throttled answer is only kept ~2s to absorb a burst of renders)
    ok('the throttled answer was NOT cached as final: once Meta recovers the very next read finds the account (no 5-minute false «none»)', igCalls() > before && b.instagram.length === 1 && b.instagram[0].username === 'trendy.store2020' && b.instagramRateLimited === false && b.instagramReadable === true, JSON.stringify([b.instagram, igCalls() - before]));
    const n = igCalls(); const c = await G.getAccountIdentities('tokA', 'act_1'); ok('a COMPLETE answer is cached normally (a third read makes no extra Meta call)', igCalls() === n && c.instagram.length === 1); }

  console.log('\n2. A good cached answer is never replaced by a throttled partial one');
  { S.igEdge = 'HAS'; await G.getAccountIdentities('tokB', 'act_2', { force: true }); S.igEdge = 'RATE'; const r = await G.getAccountIdentities('tokB', 'act_2', { force: true });
    ok('forced refresh while Meta is throttling → the previous COMPLETE list (trendy.store2020) is served (marked stale), not an empty one', r.instagram.length === 1 && r.instagram[0].username === 'trendy.store2020' && r.__stale === true, JSON.stringify([r.instagram, r.__stale])); }

  console.log('\n3. A Page/account that REALLY has no Instagram is still reported honestly');
  { S.igEdge = 'EMPTY'; const a = await G.getAccountIdentities('tokC', 'act_3', { force: true });
    ok('all edges answered, none lists an account → instagramReadable=true, instagramRateLimited=false (the genuine «no Instagram» message)', a.instagram.length === 0 && a.instagramReadable === true && a.instagramRateLimited === false); }

  console.log('\n4. The lazy per-Page read (used when a Page is picked)');
  { S.pageIg = 'HAS'; const a = await G.getPageInstagramEx('tokD', '111111111'); ok('a linked Instagram is returned', a.instagram?.username === 'trendy.store2020' && a.rateLimited === false);
    S.pageIg = 'NONE'; const b = await G.getPageInstagramEx('tokD', '111111111'); ok('no linked Instagram → null, NOT rate-limited', b.instagram === null && b.rateLimited === false);
    S.pageIg = 'RATE'; const c = await G.getPageInstagramEx('tokD', '111111111'); ok('Meta throttled → null with rateLimited=true (the wizard shows «Meta محدّدة الطلبات», not «no Instagram»)', c.instagram === null && c.rateLimited === true);
    S.pageIg = 'HAS'; ok('the old getPageInstagram() contract is unchanged ({id, username} or null)', (await G.getPageInstagram('tokD', '111111111'))?.id === '17841400000000001'); }

  console.log('\n5. Telling a throttle apart from a permission/missing error');
  { const miss = await G.graphGetProbe('/missing', {}, 'tokE'); const rate = (S.pageIg = 'RATE', await G.graphGetProbe('/222222222', {}, 'tokE'));
    ok('code 100/33 («does not exist / no permission») is NOT a throttle; code 17 IS', miss.ok === false && miss.rateLimited === false && rate.ok === false && rate.rateLimited === true); }

  console.log('\n6. The cache helper');
  { let n = 0; const loader = async () => ({ v: ++n, bad: n === 1 });
    const a = await C.cachedMetaFetch('t:k1', loader, { cacheIf: (v) => !v.bad, incompleteTtlMs: 5 }); await new Promise((r) => setTimeout(r, 15)); const b = await C.cachedMetaFetch('t:k1', loader, { cacheIf: (v) => !v.bad });
    const c = await C.cachedMetaFetch('t:k1', loader, { cacheIf: (v) => !v.bad });
    ok('an incomplete value is kept only briefly, then re-read; the complete one is cached', a.v === 1 && b.v === 2 && c.v === 2 && n === 2, JSON.stringify([a, b, c, n])); }
} finally { server.close(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
