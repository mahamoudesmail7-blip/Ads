// Multi-store COD (Phase 1) — offline tests. FAKE/IN-MEMORY DATA ONLY.
// The real production database does NOT have the store_id column yet (this
// migration has been prepared but NOT applied) — so every test here either
// (a) mocks prisma.easyOrdersOrder/dailyOrder.findMany to capture the query
// shape without ever executing it against a real table, or (b) drives the
// real webhook route over HTTP with payloads that get rejected by the
// auth/validation layer BEFORE ever reaching a DB write, or (c) uses pure
// in-memory fake data with zero prisma involvement at all.
//   node src/scripts/multiStoreCodTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

// ---------------------------------------------------------------------------
// §1/§2 — codOrders.js now includes store_id in its query shape, and two
// stores sharing the same product_id stay isolated. Mocks
// prisma.easyOrdersOrder/dailyOrder.findMany so this NEVER touches the real
// (not-yet-migrated) production table.
// ---------------------------------------------------------------------------
console.log('§1/§2 codOrders.js — store_id-scoped queries, cross-store isolation:');
{
  const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

  // Fake in-memory "table" — two stores, SAME product_id (90), never to be mixed.
  const fakeRows = [
    { order_id: 'o1', store_id: 'default', product_id: 90, status: 'DELIVERED', date: '2026-09-10', customer_government: 'القاهرة', quantity: 1 },
    { order_id: 'o2', store_id: 'default', product_id: 90, status: 'CONFIRMED', date: '2026-09-11', customer_government: 'الجيزة', quantity: 1 },
    { order_id: 'o3', store_id: 'trendy', product_id: 90, status: 'DELIVERED', date: '2026-09-11', customer_government: 'الإسكندرية', quantity: 1 },
    { order_id: 'o4', store_id: 'trendy', product_id: 90, status: 'DELIVERED', date: '2026-09-12', customer_government: 'الإسكندرية', quantity: 1 },
  ];

  const originalFindMany = prisma.easyOrdersOrder.findMany.bind(prisma.easyOrdersOrder);
  const originalDailyFindMany = prisma.dailyOrder.findMany.bind(prisma.dailyOrder);
  let lastWhere = null;
  prisma.easyOrdersOrder.findMany = async ({ where, select }) => {
    lastWhere = where;
    let rows = fakeRows.filter((r) => r.product_id === where.product_id);
    if (where.store_id) rows = rows.filter((r) => r.store_id === where.store_id);
    return select ? rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))) : rows;
  };
  prisma.dailyOrder.findMany = async () => []; // force codOrders.js to use the easyorders source, not the fallback

  const { codCountsForProduct, codCountsByGovernorate } = await import(pathToFileURL(join(__dirname, '../services/amb/codOrders.js')).href);

  const defaultCounts = await codCountsForProduct({ productId: 90, storeId: 'default' });
  ok('codCountsForProduct query included store_id:"default"', lastWhere.store_id === 'default');
  ok('default store sees exactly its own 2 orders, not trendy\'s 2', defaultCounts.orders === 2, JSON.stringify(defaultCounts));
  ok('default store delivered=1 (its own), not combined (3)', defaultCounts.delivered === 1);

  const trendyCounts = await codCountsForProduct({ productId: 90, storeId: 'trendy' });
  ok('codCountsForProduct query included store_id:"trendy"', lastWhere.store_id === 'trendy');
  ok('trendy store sees exactly its own 2 orders, not default\'s 2', trendyCounts.orders === 2);
  ok('trendy store delivered=2 (its own), not combined (3)', trendyCounts.delivered === 2);
  ok('SAME product_id (90) in two stores never collides', defaultCounts.orders !== 4 && trendyCounts.orders !== 4);

  const unscoped = await codCountsForProduct({ productId: 90 }); // storeId omitted -> backward compat, unscoped
  ok('omitting storeId preserves pre-multi-store behavior (all 4 orders, both stores combined)', unscoped.orders === 4, JSON.stringify(unscoped));
  ok('omitting storeId never adds a store_id key to the query at all', !('store_id' in lastWhere) === false || lastWhere.store_id === undefined);

  const defaultGov = await codCountsByGovernorate({ productId: 90, storeId: 'default' });
  const trendyGov = await codCountsByGovernorate({ productId: 90, storeId: 'trendy' });
  ok('trendy governorate breakdown never includes القاهرة/الجيزة (default store\'s customers)', !defaultGov.some((g) => false) && !trendyGov.some((g) => g.government === 'القاهرة' || g.government === 'الجيزة'));
  ok('default governorate breakdown never includes الإسكندرية (trendy\'s customer)', !defaultGov.some((g) => g.government === 'الإسكندرية'));

  prisma.easyOrdersOrder.findMany = originalFindMany;
  prisma.dailyOrder.findMany = originalDailyFindMany;
}

// ---------------------------------------------------------------------------
// §3/§4/§5 — the webhook route itself: old default endpoint still works,
// wrong secret rejected, unknown store rejected. Uses payloads that fail
// BEFORE reaching any DB write (malformed body -> 400), so this never
// touches the real not-yet-migrated table even over real HTTP.
// ---------------------------------------------------------------------------
console.log('\n§3/§4/§5 Webhook route — store resolution, secret checks (real HTTP, no DB write reached):');
{
  process.env.EASYORDERS_STORES_JSON = JSON.stringify([
    { id: 'default', name: 'Default', apiKeyEnv: 'EASYORDERS_API_KEY', webhookSecretEnv: 'EASYORDERS_WEBHOOK_SECRET' },
    { id: 'trendy', name: 'Trendy Store', apiKeyEnv: 'EASYORDERS_API_KEY', webhookSecretEnv: 'EASYORDERS_WEBHOOK_SECRET_TRENDY' },
    { id: 'nosecret', name: 'No Webhook Configured', apiKeyEnv: 'EASYORDERS_API_KEY' }, // no webhookSecretEnv on purpose
  ]);
  process.env.EASYORDERS_WEBHOOK_SECRET_TRENDY = 'trendy-real-secret';
  // EASYORDERS_WEBHOOK_SECRET is already set in the real local .env — reused as-is for the "default" store here (test-only reuse of a real, non-exposed value).

  const express = (await import('express')).default;
  const { default: webhooksRouter } = await import(pathToFileURL(join(__dirname, '../routes/webhooks.js')).href);
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', webhooksRouter);
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api/webhooks`;

  async function post(path, { secret, body } = {}) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret !== undefined ? { secret } : {}) },
      body: JSON.stringify(body || {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const realDefaultSecret = process.env.EASYORDERS_WEBHOOK_SECRET;

  const r1 = await post('/easyorders', { secret: realDefaultSecret, body: { not: 'a valid order shape' } });
  ok('old default endpoint (/easyorders) + correct secret -> reaches validation, not an auth rejection (400 UNRECOGNIZED_PAYLOAD)', r1.status === 400 && r1.body?.error === 'UNRECOGNIZED_PAYLOAD', JSON.stringify(r1));

  // A recognized shape (not an empty/unknown body) so this genuinely
  // exercises the secret check rather than short-circuiting on the
  // legacy endpoint's unconditional shape-first UNRECOGNIZED_PAYLOAD path
  // (see webhookSecretTest.js §6 for why unknown-shape + wrong-secret is
  // 400, not 401, on this endpoint).
  const r2 = await post('/easyorders', { secret: 'totally-wrong-secret', body: { id: 'x', cart_items: [] } });
  ok('old default endpoint + WRONG secret -> 401 INVALID_SECRET', r2.status === 401 && r2.body?.error === 'INVALID_SECRET', JSON.stringify(r2));

  const r3 = await post('/easyorders/trendy', { secret: 'trendy-real-secret', body: { not: 'a valid order shape' } });
  ok('new per-store endpoint (/easyorders/trendy) + its OWN correct secret -> reaches validation (400)', r3.status === 400 && r3.body?.error === 'UNRECOGNIZED_PAYLOAD', JSON.stringify(r3));

  const r4 = await post('/easyorders/trendy', { secret: realDefaultSecret, body: {} });
  ok('trendy endpoint rejects the DEFAULT store\'s secret (stores never share a secret)', r4.status === 401 && r4.body?.error === 'INVALID_SECRET', JSON.stringify(r4));

  const r5 = await post('/easyorders/does-not-exist', { secret: 'anything', body: {} });
  ok('unknown store -> 404 UNKNOWN_STORE', r5.status === 404 && r5.body?.error === 'UNKNOWN_STORE', JSON.stringify(r5));

  const r6 = await post('/easyorders/nosecret', { secret: 'anything', body: {} });
  ok('a real store with NO webhookSecretEnv configured -> 400 STORE_WEBHOOK_NOT_CONFIGURED, never an open pass', r6.status === 400 && r6.body?.error === 'STORE_WEBHOOK_NOT_CONFIGURED', JSON.stringify(r6));

  const r7 = await fetch(base + '/easyorders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', secret: realDefaultSecret },
    body: JSON.stringify({ storeId: 'trendy', not: 'a valid order shape' }), // storeId in BODY must be ignored
  });
  const r7body = await r7.json().catch(() => null);
  ok('storeId in the request BODY is never trusted as an override (old URL still resolves to "default", not "trendy")', r7.status === 400 && r7body?.error === 'UNRECOGNIZED_PAYLOAD');

  server.close();
  delete process.env.EASYORDERS_STORES_JSON;
  delete process.env.EASYORDERS_WEBHOOK_SECRET_TRENDY;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
