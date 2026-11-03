// 🧪 AMB Media provider keys: stored encrypted, never returned, env fallback, live test with an injected fetch (no network). Isolated test database only.
//   node src/scripts/mediaKeysTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`); } };

const { prisma } = await imp('../prisma.js');
const K = await imp('../services/amb/media/mediaKeys.js');
const savedEnv = { APIFY_TOKEN: process.env.APIFY_TOKEN, FAL_KEY: process.env.FAL_KEY, SERPAPI_KEY: process.env.SERPAPI_KEY };
try {
  await prisma.settings.deleteMany({ where: { id: 'media-keys' } });
  delete process.env.APIFY_TOKEN; delete process.env.FAL_KEY; delete process.env.SERPAPI_KEY;

  console.log('\n[1] nothing configured');
  let st = await K.getMediaKeysStatus();
  ok('apify/fal/serpapi not configured', !st.apify.configured && !st.fal.configured && !st.serpapi.configured);
  ok('openai is reported but env-only', st.openai.envOnly === true);
  ok('getMediaKey is null', (await K.getMediaKey('apify')) === null);

  console.log('\n[2] save / status / read-back');
  const secret = 'apify_api_SECRETVALUE1234567890abcd';
  const s = await K.setMediaKey('apify', `  "${secret}"  `);
  ok('status says SAVED with last4', s.configured && s.source === 'SAVED' && s.last4 === 'abcd');
  ok('the key is never in the status JSON', !JSON.stringify(await K.getMediaKeysStatus()).includes('SECRETVALUE'));
  ok('server-side read returns the clean plaintext', (await K.getMediaKey('apify')) === secret);
  const row = await prisma.settings.findUnique({ where: { id: 'media-keys' } });
  ok('stored encrypted (plaintext not in the DB row)', row && !row.data.includes('SECRETVALUE'));

  console.log('\n[3] validation');
  let err = null; try { await K.setMediaKey('apify', 'short'); } catch (e) { err = e; }
  ok('too-short key rejected with 400', err?.status === 400);
  err = null; try { await K.setMediaKey('nope', 'x'.repeat(20)); } catch (e) { err = e; }
  ok('unknown provider rejected with 400', err?.status === 400);
  err = null; try { await K.setMediaKey('fal', 'has space inside the key'); } catch (e) { err = e; }
  ok('key with whitespace rejected', err?.status === 400);

  console.log('\n[4] env fallback + saved wins');
  process.env.FAL_KEY = 'fal-env-key-1234567890wxyz';
  st = await K.getMediaKeysStatus();
  ok('fal from ENV', st.fal.configured && st.fal.source === 'ENV' && st.fal.last4 === 'wxyz');
  await K.setMediaKey('fal', 'fal-saved-key-123456789012');
  ok('saved overrides env', (await K.getMediaKey('fal')) === 'fal-saved-key-123456789012');
  await K.clearMediaKey('fal');
  ok('after clear, env is used again', (await K.getMediaKey('fal')) === 'fal-env-key-1234567890wxyz');

  console.log('\n[5] live test (injected fetch, no network)');
  let seen = null;
  let r = await K.testMediaKey('apify', { fetchImpl: async (url, init) => { seen = { url, auth: init?.headers?.Authorization }; return { status: 200, json: { data: { username: 'ads', plan: { id: 'STARTER' } } } }; } });
  ok('apify ok, uses Bearer + users/me', r.ok && r.verified && seen.url.endsWith('/users/me') && seen.auth === `Bearer ${secret}`);
  ok('message never contains the key', !r.message.includes('SECRET'));
  r = await K.testMediaKey('apify', { fetchImpl: async () => ({ status: 401, json: null }) });
  ok('apify 401 → not ok, Arabic message', !r.ok && /التوكن غلط/.test(r.message));
  r = await K.testMediaKey('fal');
  ok('fal: saved but not verified (no free ping)', r.ok && r.verified === false);
  await K.clearMediaKey('apify');
  r = await K.testMediaKey('apify');
  ok('no key → not ok', !r.ok);
} finally {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await prisma.settings.deleteMany({ where: { id: 'media-keys' } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
