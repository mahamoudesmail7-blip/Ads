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
]);
for (let i = 1; i <= 7; i++) process.env[`EO_TEST_KEY_${i}`] = `key-${i}`;
process.env.EASYORDERS_PAGE_DELAY_MS_TEST_OVERRIDE = '5'; // real fetch is mocked below — no reason to burn real wall-clock time on production pacing

const { getAllEasyOrdersProductsStatus } = await import(pathToFileURL(process.cwd() + '/src/services/amb/easyOrdersProducts.js').href);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
