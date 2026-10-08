// Product Research (experimental deep search) fixes: a LIVE search is no longer reaped as FAILED, timeouts / API-access errors are named correctly,
// search queries get a tight timeout, a permanent Google access error stops the loop, YouTube runs first. Disposable "__optest_" fixtures only.
//   node src/scripts/researchPipelineFixesTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const retryDb = async (fn) => { for (let i = 0; i < 10; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 4000)); } } return fn(); };
const { prisma } = await imp('../prisma.js');
const H = await imp('../services/providerHealth.js');
const D = await imp('../services/experimentalCreativeDiscovery.js');
const T = '__optest_';
const ids = []; let userId = null;
const NOT_TERMINAL = ['PENDING', 'ANALYZING', 'GENERATING_QUERIES', 'SEARCHING'];

try {
  console.log('\n1. error classification (what the UI shows)');
  ok('the orchestrator\'s Arabic timeout message is a TIMEOUT (it used to be "خطأ غير معروف")', H.classifyErrorType({ message: 'مهلة الطلب انتهت (instagram) بعد 30 ثانية' }) === 'TIMEOUT');
  ok('code PROVIDER_TIMEOUT => TIMEOUT', H.classifyErrorType({ code: 'PROVIDER_TIMEOUT', message: 'x' }) === 'TIMEOUT');
  ok('Google "project does not have the access to Custom Search JSON API" => API_ACCESS_DENIED (permanent, not a typo in a key)', H.classifyErrorType({ message: 'This project does not have the access to Custom Search JSON API.' }) === 'API_ACCESS_DENIED' && H.isRetryable('API_ACCESS_DENIED') === false);
  ok('existing mappings are unchanged (quota / 429 / 403 / 500 / "timeout" / network)', H.classifyErrorType({ message: 'quota exceeded for the day' }) === 'QUOTA_EXCEEDED' && H.classifyErrorType({ status: 429, message: '' }) === 'RATE_LIMITED' && H.classifyErrorType({ status: 403, message: '' }) === 'INVALID_CREDENTIALS' && H.classifyErrorType({ status: 500, message: '' }) === 'SERVER_ERROR' && H.classifyErrorType({ message: 'request timeout' }) === 'TIMEOUT' && H.classifyErrorType({ message: 'ECONNRESET' }) === 'NETWORK_ERROR' && H.classifyErrorType({ message: 'boom' }) === 'UNKNOWN_ERROR');
  for (const f of ['product-research-experimental.js', 'product-research.js', 'winner-products.js']) ok(`UI label for API_ACCESS_DENIED exists in ${f}`, fs.readFileSync(join(__dirname, '../../../js', f), 'utf8').includes('API_ACCESS_DENIED'));

  console.log('\n2. the stale sweep: a LIVE deep search must not be marked FAILED');
  const others = await retryDb(() => prisma.experimentalCreativeSearch.count({ where: { status: { in: NOT_TERMINAL }, NOT: { product_name: { startsWith: T } } } }));
  if (others > 0) console.log(`  ℹ ${others} real non-terminal search(es) exist: the DB part is skipped (the sweep would touch them)`);
  else {
    const user = await retryDb(() => prisma.user.create({ data: { email: `${T}rs_${Date.now()}@example.invalid`, password_hash: 'x'.repeat(20), name: `${T}rs`, role: 'ADMIN', status: 'ACTIVE', permissions: '{}' } })); userId = user.id;
    const mk = async (name, { createdMinAgo, updatedMinAgo, status = 'SEARCHING' }) => { const s = await retryDb(() => prisma.experimentalCreativeSearch.create({ data: { user_id: userId, product_name: `${T}${name}`, platforms_json: '["instagram"]', status, created_at: new Date(Date.now() - createdMinAgo * 60_000), updated_at: new Date(Date.now() - updatedMinAgo * 60_000) } })); ids.push(s.id); return s; };
    const live = await mk('live-deep', { createdMinAgo: 30, updatedMinAgo: 1 });        // 30 minutes old, but progressing right now (the production case)
    const quiet = await mk('quiet', { createdMinAgo: 30, updatedMinAgo: 15 });          // no activity for 15 minutes: orphaned
    const young = await mk('young', { createdMinAgo: 3, updatedMinAgo: 3 });            // brand new
    const mine = await mk('running-here', { createdMinAgo: 40, updatedMinAgo: 20 });    // silent for 20 min BUT alive in this process
    const done = await mk('done', { createdMinAgo: 90, updatedMinAgo: 90, status: 'COMPLETED' });
    D.__runningSearchesForTests.add(mine.id);
    const n = await D.reapStaleExperimentalSearches();
    const st = async (s) => (await prisma.experimentalCreativeSearch.findUnique({ where: { id: s.id } })).status;
    ok('30 minutes old but active a minute ago => NOT reaped (this is what showed "فشل البحث" at 60% while the search was still running)', (await st(live)) === 'SEARCHING');
    ok('no activity for 15 minutes => reaped as FAILED with the honest message', (await st(quiet)) === 'FAILED' && (await prisma.experimentalCreativeSearch.findUnique({ where: { id: quiet.id } })).error.includes('انقطعت'));
    ok('a young search is left alone', (await st(young)) === 'SEARCHING');
    ok('a search running in THIS process is never reaped, however quiet', (await st(mine)) === 'SEARCHING');
    ok('terminal searches are untouched and exactly one row was reaped', (await st(done)) === 'COMPLETED' && n === 1, `n=${n}`);
    D.__runningSearchesForTests.delete(mine.id);
  }

  console.log('\n3. the pipeline code (source-level guards for the behavioural fixes)');
  const src = fs.readFileSync(join(__dirname, '../services/experimentalCreativeDiscovery.js'), 'utf8');
  ok('search queries use the tight 15s budget, the AI analysis keeps its own 30s', /SEARCH_QUERY_TIMEOUT_MS = 15000/.test(src) && /runProviderSearch\(\{ platform, query: q\.query[^)]*\), SEARCH_QUERY_TIMEOUT_MS, platform\)/.test(src) && /analyzeProduct\([^)]*\)[^;]*PROVIDER_TIMEOUT_MS, 'analyzeProduct'/.test(src) && /PROVIDER_TIMEOUT_MS = 30000/.test(src));
  ok('Google: a permanent access error stops the loop and skips the image call', /googleAccessDenied = true; break;/.test(src) && /!googleAccessDenied\) \{/.test(src));
  ok('YouTube runs first among the generic platforms', /sort\(\(a, b\) => \(a === 'youtube' \? -1 : 0\) - \(b === 'youtube' \? -1 : 0\)\)/.test(src));
  const order = ['instagram', 'facebook', 'tiktok', 'youtube'].sort((a, b) => (a === 'youtube' ? -1 : 0) - (b === 'youtube' ? -1 : 0));
  ok('...and the others keep their order', order.join() === 'youtube,instagram,facebook,tiktok');
  ok('the pipeline registers itself as running and always deregisters', /runningSearches\.add\(searchId\)/.test(src) && /finally \{ runningSearches\.delete\(searchId\)/.test(src));
} catch (e) { fail++; console.log('  ✗ test crashed —', e.stack || e.message); }
finally {
  try {
    D.__runningSearchesForTests.clear();
    await retryDb(() => prisma.experimentalCreativeSearch.deleteMany({ where: { OR: [{ id: { in: ids } }, { product_name: { startsWith: T } }] } }));
    if (userId) await retryDb(() => prisma.user.deleteMany({ where: { id: userId } }));
    ok('cleanup: no fixture left', (await prisma.experimentalCreativeSearch.count({ where: { product_name: { startsWith: T } } })) === 0);
  } catch (e) { fail++; console.log('  ✗ cleanup failed —', e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
