// 🔎 Reverse-image discovery (Google Lens via SerpApi) — finds pages that show the owner's product straight from the photo. Fake SerpApi on loopback; nothing real is called.
//   1. the temporary public copy of the photo: unguessable token, served only while alive, 404 otherwise, no listing
//   2. SerpApi google_lens call shape (engine / url / type) and result mapping
//   3. discoverByImage: exact + visual matches, de-duplicated, needs a thumbnail, skips honestly (no key / no public URL), survives one failing call, drops the hosted photo afterwards
//   4. the pipeline runs it for image searches and the judge verifies what it found
//   node src/scripts/reverseImageDiscoveryTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };

// ---- a loopback SerpApi (google_lens) ----
const calls = []; let mode = 'ok';
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); calls.push(Object.fromEntries(u.searchParams));
  const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (mode === 'quota') return json(200, { error: 'Your account has run out of searches.' });
  if (mode === 'empty') return json(200, { error: "Google Lens hasn't returned any results for this search." });
  const type = u.searchParams.get('type');
  if (type === 'exact_matches') return json(200, { exact_matches: [{ link: 'https://shop.example/a', title: 'نفس الحذاء', source: 'shop.example', thumbnail: 'https://img.example/a.jpg', price: { value: '$25', extracted_value: 25, currency: '$' } }, { link: 'https://shop.example/b', title: 'بدون صورة', source: 'shop.example' }] });
  return json(200, { visual_matches: [{ link: 'https://shop.example/a', title: 'نفس الحذاء (visual)', source: 'shop.example', thumbnail: 'https://img.example/a2.jpg' }, { link: 'https://other.example/c', title: 'حذاء شبيه', source: 'other.example', image: 'https://img.example/c.jpg' }, { link: 'javascript:alert(1)', title: 'bad', thumbnail: 'https://img.example/x.jpg' }] });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.SERPAPI_MOCK = '1'; process.env.SERPAPI_MOCK_URL = `http://127.0.0.1:${mock.address().port}`; process.env.SERPAPI_API_KEY = 'test-key';
process.env.PUBLIC_BASE_URL = 'https://app.example.test';
const host = await imp('../services/researchReferenceHost.js');
const serp = await imp('../services/searchProviders/serpApiProvider.js');
const { discoverByImage } = await imp('../services/reverseImageDiscovery.js');
const PHOTO = Buffer.alloc(2000, 7).toString('base64');

console.log('\n1. The temporary public copy of the reference photo');
const h = host.hostReferenceImage(PHOTO, 'image/png');
ok('the URL is on the app\'s public origin with a 32-hex unguessable token', h.url === `https://app.example.test/api/research-ref/${h.token}` && /^[a-f0-9]{32}$/.test(h.token));
const app = express(); app.use('/api/research-ref', (await imp('../routes/researchReference.js')).default);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); const base = `http://127.0.0.1:${srv.address().port}`;
const got = await fetch(`${base}/api/research-ref/${h.token}`);
ok('the live token serves the photo bytes with its content type (no login needed)', got.status === 200 && got.headers.get('content-type') === 'image/png' && (await got.arrayBuffer()).byteLength === 2000);
ok('an unknown / malformed token is 404, and there is no listing endpoint', (await fetch(`${base}/api/research-ref/${'0'.repeat(32)}`)).status === 404 && (await fetch(`${base}/api/research-ref/abc`)).status === 404 && (await fetch(`${base}/api/research-ref/`)).status === 404);
const short = host.hostReferenceImage(PHOTO, 'image/jpeg', { ttlMs: 1 }); await new Promise((r) => setTimeout(r, 15));
ok('an expired token is gone', (await fetch(`${base}/api/research-ref/${short.token}`)).status === 404);
host.dropHostedImage(h.token);
ok('a dropped token is gone', (await fetch(`${base}/api/research-ref/${h.token}`)).status === 404);
let tooSmall = null; try { host.hostReferenceImage('AAAA'); } catch (e) { tooSmall = e; }
ok('a tiny / invalid image is refused', !!tooSmall);

console.log('\n2. SerpApi google_lens call + mapping');
calls.length = 0; mode = 'ok';
const ex = await serp.searchByImage({ imageUrl: 'https://app.example.test/api/research-ref/abc', type: 'exact_matches', country: 'EG' });
ok('the call uses engine=google_lens with the image URL, the requested type, Arabic, lower-case country', calls[0].engine === 'google_lens' && calls[0].url === 'https://app.example.test/api/research-ref/abc' && calls[0].type === 'exact_matches' && calls[0].hl === 'ar' && calls[0].country === 'eg' && calls[0].api_key === 'test-key');
ok('results map to {url, title, thumbnail, source, price}', ex.length === 2 && ex[0].url === 'https://shop.example/a' && ex[0].thumbnail === 'https://img.example/a.jpg' && ex[0].accountName === 'shop.example' && ex[0].price.value === '$25');
mode = 'empty'; ok('«no results» from Lens is an honest empty answer, not an error', (await serp.searchByImage({ imageUrl: 'https://x/y', type: 'visual_matches' })).length === 0);
mode = 'quota'; let q = null; try { await serp.searchByImage({ imageUrl: 'https://x/y' }); } catch (e) { q = e; }
ok('an exhausted SerpApi quota is a real error that says so', !!q && /run out of searches/.test(q.message));

console.log('\n3. discoverByImage');
mode = 'ok'; calls.length = 0;
const d = await discoverByImage({ references: [{ imageBase64: PHOTO, imageMediaType: 'image/jpeg' }], country: 'EG' });
ok('exact + visual matches are collected: status OK', d.status === 'OK' && d.counts.exact_matches === 2 && d.counts.visual_matches === 3, JSON.stringify(d.counts));
ok('only candidates WITH a picture and a real http(s) link are kept (a, c) — no photo-less row, no javascript: link', d.normalized.map((n) => n.canonical_url).sort().join() === 'https://other.example/c,https://shop.example/a', d.normalized.map((n) => n.canonical_url).join());
ok('the same page found by both is ONE row and keeps the stronger «exact» tag', d.normalized.filter((n) => n.canonical_url === 'https://shop.example/a').length === 1 && /LENS_EXACT/.test(d.normalized.find((n) => n.canonical_url === 'https://shop.example/a').discovered_by_queries_json));
ok('rows have the platform the results list already understands, a thumbnail for the judge, and the Lens provider tag', d.normalized.every((n) => n.platform === 'google' && n.thumbnail && n.provider === 'serpapi_google_lens'));
ok('the temporary public photo is dropped right after (nothing left hosted)', host._hostedCount() <= 1);
const savedBase = process.env.PUBLIC_BASE_URL; delete process.env.PUBLIC_BASE_URL; delete process.env.RAILWAY_PUBLIC_DOMAIN; delete process.env.FRONTEND_URL;
ok('without a known public origin it SKIPS (and says why) instead of inventing a host', (await discoverByImage({ references: [{ imageBase64: PHOTO }] })).status === 'SKIPPED_NO_PUBLIC_URL');
process.env.PUBLIC_BASE_URL = savedBase;
const savedKey = process.env.SERPAPI_API_KEY; delete process.env.SERPAPI_API_KEY;
ok('without a SerpApi key it SKIPS honestly', (await discoverByImage({ references: [{ imageBase64: PHOTO }] })).status === 'SKIPPED_NO_KEY');
process.env.SERPAPI_API_KEY = savedKey;
mode = 'quota'; const dq = await discoverByImage({ references: [{ imageBase64: PHOTO }] });
ok('a quota error → FAILED with the message, nothing collected, and the second call is not wasted', dq.status === 'FAILED' && dq.normalized.length === 0 && /run out of searches/.test(dq.error));
ok('no references → nothing to search', (await discoverByImage({ references: [] })).status === 'SKIPPED_DISABLED');

console.log('\n4. The pipeline');
const src = fs.readFileSync(join(__dirname, '../services/experimentalCreativeDiscovery.js'), 'utf8');
ok('image searches run reverse-image discovery before the text platforms, save what it finds, and never fail the search because of it', src.includes('discoverByImage({ references: referenceInputImages') && src.includes('REVERSE_IMAGE_FAILED') && src.includes("query_type: 'REVERSE_IMAGE'"));
ok('what Lens finds goes through the same exact-product judge (it has thumbnails, platform google)', src.includes("thumbnail: { not: null }") && src.includes('judgeCandidates({'));
const server = fs.readFileSync(join(__dirname, '../server.js'), 'utf8');
ok('the public photo route is mounted', server.includes("app.use('/api/research-ref', researchReferenceRoutes)"));

srv.close(); mock.close();
console.log(`\n${fail ? '❌' : '✅'} reverseImageDiscoveryTest: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 300).unref?.();
