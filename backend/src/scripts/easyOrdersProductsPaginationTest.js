// Offline tests for EasyOrders catalogue pagination
// (services/amb/easyOrdersProducts.js's fetchEasyOrdersProductsRaw, private
// — exercised through the public getAllEasyOrdersProductsStatus()). Mocks
// global.fetch entirely — no real network call, no real credential.
//   node src/scripts/easyOrdersProductsPaginationTest.js
import { pathToFileURL } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

process.env.EASYORDERS_STORES_JSON = JSON.stringify([
  { id: 's1', name: 'S1', apiKeyEnv: 'EO_TEST_KEY_1' },
  { id: 's2', name: 'S2', apiKeyEnv: 'EO_TEST_KEY_2' },
  { id: 's3', name: 'S3', apiKeyEnv: 'EO_TEST_KEY_3' },
  { id: 's4', name: 'S4', apiKeyEnv: 'EO_TEST_KEY_4' },
  { id: 's5', name: 'S5', apiKeyEnv: 'EO_TEST_KEY_5' },
  { id: 's6', name: 'S6', apiKeyEnv: 'EO_TEST_KEY_6' },
  { id: 's7', name: 'S7', apiKeyEnv: 'EO_TEST_KEY_7' },
  { id: 's8', name: 'S8', apiKeyEnv: 'EO_TEST_KEY_8' },
  { id: 's9', name: 'S9', apiKeyEnv: 'EO_TEST_KEY_9' },
]);
for (let i = 1; i <= 9; i++) process.env[`EO_TEST_KEY_${i}`] = `key-${i}`;
process.env.EASYORDERS_PAGE_DELAY_MS_TEST_OVERRIDE = '5'; // real fetch is mocked below — no reason to burn real wall-clock time on production pacing

const { getAllEasyOrdersProductsStatus, getEasyOrdersProducts, getEasyOrdersDiagnostics } = await import(pathToFileURL(process.cwd() + '/src/services/amb/easyOrdersProducts.js').href);

function product(id, n = '') { return { id, name: `p${id}${n}`, slug: `p${id}`, thumb: `t${id}.png`, price: 100, created_at: null }; }

const originalFetch = global.fetch;
function mockFetch(handler) { global.fetch = handler; }
function restoreFetch() { global.fetch = originalFetch; }

console.log('§1 API ignores pagination entirely — page 1 already contains the whole (short) catalogue:');
{
  let calls = 0;
  mockFetch(async () => { calls++; return { ok: true, status: 200, json: async () => [product(1), product(2), product(3)] }; });
  const result = await getAllEasyOrdersProductsStatus('s1');
  ok('all 3 products returned', result.products.length === 3, JSON.stringify(result.products.map((p) => p.id)));
  ok('stopped after exactly 1 page (short page = last page)', calls === 1, String(calls));
  restoreFetch();
}

console.log('\n§2 Real pagination — 2 full pages of 100 then a short final page, walks all 3:');
{
  let calls = 0;
  mockFetch(async (url) => {
    calls++;
    const u = new URL(url);
    const page = Number(u.searchParams.get('page'));
    if (page === 1) return { ok: true, status: 200, json: async () => Array.from({ length: 100 }, (_, i) => product(i + 1)) };
    if (page === 2) return { ok: true, status: 200, json: async () => Array.from({ length: 100 }, (_, i) => product(i + 101)) };
    if (page === 3) return { ok: true, status: 200, json: async () => [product(201), product(202)] };
    return { ok: true, status: 200, json: async () => [] };
  });
  const result = await getAllEasyOrdersProductsStatus('s2');
  ok('all 202 products fetched across 3 pages', result.products.length === 202, String(result.products.length));
  ok('exactly 3 page requests made', calls === 3, String(calls));
  restoreFetch();
}

console.log('\n§3 Pagination envelope response ({data, total, ...}) is read correctly, not treated as malformed:');
{
  mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: [product(1), product(2)], total: 2, page: 1, pageCount: 1 }) }));
  const result = await getAllEasyOrdersProductsStatus('s3');
  ok('reads .data out of the envelope', result.products.length === 2 && result.ok, JSON.stringify(result));
  restoreFetch();
}

console.log('\n§4 Duplicate id across pages is deduplicated, never double-counted:');
{
  let calls = 0;
  mockFetch(async () => {
    calls++;
    if (calls === 1) return { ok: true, status: 200, json: async () => Array.from({ length: 100 }, (_, i) => product(i + 1)) };
    // page 2 overlaps product id 100 by mistake (e.g. a retry/off-by-one on the real API) plus one genuinely new id
    return { ok: true, status: 200, json: async () => [product(100), product(101)] };
  });
  const result = await getAllEasyOrdersProductsStatus('s4');
  ok('101 unique products, not 102', result.products.length === 101, String(result.products.length));
  restoreFetch();
}

console.log('\n§5 A malformed row (null entry) is skipped, never crashes the whole fetch:');
{
  mockFetch(async () => ({ ok: true, status: 200, json: async () => [product(1), null, product(2)] }));
  const result = await getAllEasyOrdersProductsStatus('s5');
  ok('2 good rows survive, the null row is dropped', result.products.length === 2, JSON.stringify(result.products));
  restoreFetch();
}

console.log('\n§6 429 on page 1 retries with backoff and eventually succeeds:');
{
  let calls = 0;
  mockFetch(async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, text: async () => 'rate limited' };
    return { ok: true, status: 200, json: async () => [product(1)] };
  });
  const start = Date.now();
  const result = await getAllEasyOrdersProductsStatus('s6');
  const elapsed = Date.now() - start;
  ok('succeeds after one retry', result.ok && result.products.length === 1, JSON.stringify(result));
  ok('backed off at least ~1s before retrying (not a tight retry loop)', elapsed >= 900, `elapsed=${elapsed}ms`);
  restoreFetch();
}

console.log('\n§7 The safety bound stops an always-full-page API at EASYORDERS_MAX_PAGES, never loops forever:');
{
  let calls = 0;
  mockFetch(async () => { calls++; return { ok: true, status: 200, json: async () => Array.from({ length: 100 }, (_, i) => product(calls * 1000 + i)) }; });
  const result = await getAllEasyOrdersProductsStatus('s7');
  ok('stopped at exactly 50 page requests, not unbounded', calls === 50, String(calls));
  ok('still returns the (capped) data instead of throwing', result.ok && result.products.length === 5000, String(result.products.length));
  restoreFetch();
}

console.log('\n§8 CRITICAL PRODUCTION FIX — single-flight: N concurrent callers on a cold cache trigger exactly ONE real crawl, never a stampede:');
{
  let realFetchCalls = 0;
  mockFetch(async () => {
    realFetchCalls++;
    await new Promise((r) => setTimeout(r, 50)); // simulate real network latency, giving concurrent callers a real window to collide in
    return { ok: true, status: 200, json: async () => [product(1), product(2)] };
  });
  // Exactly the real production trigger: N product cards each independently
  // calling getEasyOrdersProducts() for the SAME store at the SAME moment.
  const N = 12;
  const results = await Promise.all(Array.from({ length: N }, () => getEasyOrdersProducts('s8')));
  ok('all N concurrent callers still get the real, correct data', results.every((r) => r.length === 2), JSON.stringify(results.map((r) => r.length)));
  ok(`${N} concurrent cold-cache callers produced exactly 1 real HTTP call, not ${N} (the actual fix for the real 429 stampede)`, realFetchCalls === 1, String(realFetchCalls));
  restoreFetch();
}

console.log('\n§9 single-flight also protects getAllEasyOrdersProductsStatus() — including a forceRefresh call joining an already-running crawl instead of starting a second one:');
{
  let realFetchCalls = 0;
  mockFetch(async () => {
    realFetchCalls++;
    await new Promise((r) => setTimeout(r, 50));
    return { ok: true, status: 200, json: async () => [product(1)] };
  });
  const [a, b, c] = await Promise.all([
    getAllEasyOrdersProductsStatus('s9'),
    getAllEasyOrdersProductsStatus('s9'),
    getAllEasyOrdersProductsStatus('s9', { forceRefresh: true }),
  ]);
  ok('all 3 concurrent callers (including the forceRefresh one) get real, correct data', a.ok && b.ok && c.ok && a.products.length === 1);
  ok('exactly 1 real HTTP call for 3 concurrent callers on the same store', realFetchCalls === 1, String(realFetchCalls));
  restoreFetch();
}

console.log('\n§10 getEasyOrdersDiagnostics() — real internal counters, never fabricated:');
{
  const diag = getEasyOrdersDiagnostics();
  ok('reports a real, non-negative requests/min figure', typeof diag.requestsLastMinute === 'number' && diag.requestsLastMinute >= 0);
  ok('reports real cache hit/miss counters (already non-zero from the sections above)', diag.cacheHits >= 0 && diag.cacheMisses > 0, JSON.stringify({ hits: diag.cacheHits, misses: diag.cacheMisses }));
  ok('reports a real 429 count (at least the one from §6 above)', diag.status429Count >= 1, String(diag.status429Count));
  ok('reports a real retry count', diag.retryCount >= 1, String(diag.retryCount));
  ok('reports real per-store last-success timestamps for stores that succeeded', typeof diag.lastSuccessAtByStore.s8 === 'number' && typeof diag.lastSuccessAtByStore.s9 === 'number', JSON.stringify(diag.lastSuccessAtByStore));
  ok('reports real cache age for stores with a warm cache, not a guess', diag.thumbCacheAgeMsByStore.s8 >= 0 && diag.thumbCacheAgeMsByStore.s8 < 5000, JSON.stringify(diag.thumbCacheAgeMsByStore));
  ok('in-flight crawl counts settle back to 0 once every request completes — no leaked entries', diag.inFlightCrawls === 0 && diag.fullInFlightCrawls === 0, JSON.stringify({ inFlight: diag.inFlightCrawls, fullInFlight: diag.fullInFlightCrawls }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
