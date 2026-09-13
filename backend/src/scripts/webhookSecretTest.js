// EasyOrders webhook — per-payload-type secret. Offline tests, real HTTP
// against a locally-mounted copy of the real router, but engineered so
// ZERO production DB writes and ZERO real network calls occur:
//   - the "accepted" order-created case sends cart_items:[] (ingestOrder's
//     per-item loop never runs, so no upsert ever happens, and
//     ensureLostOrderTracking's own first read finds zero rows and returns
//     immediately — traced by hand against services/easyOrders.js and
//     services/lostOrders.js);
//   - the "accepted" status-update case uses a fake order_id that has never
//     been ingested, so applyStatusToOrder's own read finds zero rows to
//     write to; global fetch is mocked for the one fallback
//     fetchOrderById() call so not even a real (harmless) network request
//     reaches Easy Orders' API.
//   node src/scripts/webhookSecretTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

process.env.EASYORDERS_WEBHOOK_SECRET = 'test-orders-secret';
process.env.EASYORDERS_STATUS_WEBHOOK_SECRET = 'test-status-secret';

// Never let the "accepted" status-update path make a real network call to
// Easy Orders' API — intercept ONLY requests to their real API base URL;
// everything else (this test's own calls to its local Express server)
// passes through to the real fetch untouched.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  if (String(url).includes('easy-orders.net')) return { ok: false, status: 404, text: async () => '' };
  return originalFetch(url, ...rest);
};

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);
const originalFindMany = prisma.easyOrdersOrder.findMany.bind(prisma.easyOrdersOrder);
let dbWriteAttempted = false;
// Read-only stand-in: always reports "no existing rows" (true for these
// fake, never-ingested order ids) without touching the real table at all.
prisma.easyOrdersOrder.findMany = async () => [];
// Any write call during this test file is a bug in the test design, not an
// expected code path — fail loudly instead of silently touching prod.
for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
  const original = prisma.easyOrdersOrder[method]?.bind(prisma.easyOrdersOrder);
  if (!original) continue;
  prisma.easyOrdersOrder[method] = async (...args) => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.easyOrdersOrder.${method}() was called — this test must never reach a real write.`); };
}

const express = (await import('express')).default;
const { default: webhooksRouter } = await import(pathToFileURL(join(__dirname, '../routes/webhooks.js')).href);
const app = express();
app.use(express.json());
app.use('/api/webhooks', webhooksRouter);
const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/webhooks`;

async function post({ secret, body }) {
  const res = await fetch(base + '/easyorders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret !== undefined ? { secret } : {}) },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const ORDER_CREATED_PAYLOAD = { id: 'test-order-created-id', cart_items: [] };
const STATUS_UPDATE_PAYLOAD = { event_type: 'order-status-update', order_id: 'test-status-update-id', new_status: 'confirmed' };

console.log('§1 Orders (order-created) payload + its OWN correct secret -> accepted:');
{
  const r = await post({ secret: 'test-orders-secret', body: ORDER_CREATED_PAYLOAD });
  ok('200 ok:true', r.status === 200 && r.body?.ok === true, JSON.stringify(r));
}

console.log('\n§2 Orders payload + the STATUS secret -> rejected (secrets are never interchangeable):');
{
  const r = await post({ secret: 'test-status-secret', body: ORDER_CREATED_PAYLOAD });
  ok('401 INVALID_SECRET', r.status === 401 && r.body?.error === 'INVALID_SECRET', JSON.stringify(r));
}

console.log('\n§3 Status-update payload + its OWN correct secret -> accepted:');
{
  const r = await post({ secret: 'test-status-secret', body: STATUS_UPDATE_PAYLOAD });
  ok('200 ok:true', r.status === 200 && r.body?.ok === true, JSON.stringify(r));
}

console.log('\n§4 Status-update payload + the ORDERS secret -> rejected:');
{
  const r = await post({ secret: 'test-orders-secret', body: STATUS_UPDATE_PAYLOAD });
  ok('401 INVALID_SECRET', r.status === 401 && r.body?.error === 'INVALID_SECRET', JSON.stringify(r));
}

console.log('\n§5 Missing secret header entirely -> rejected (for both payload types):');
{
  const r1 = await post({ secret: undefined, body: ORDER_CREATED_PAYLOAD });
  ok('order-created, no secret header -> 401', r1.status === 401 && r1.body?.error === 'INVALID_SECRET', JSON.stringify(r1));
  const r2 = await post({ secret: undefined, body: STATUS_UPDATE_PAYLOAD });
  ok('status-update, no secret header -> 401', r2.status === 401 && r2.body?.error === 'INVALID_SECRET', JSON.stringify(r2));
}

console.log('\n§6 Unrecognized payload type -> rejected BEFORE any secret comparison, never ingested:');
{
  const r1 = await post({ secret: undefined, body: { not: 'a recognized shape' } });
  ok('unknown shape, no secret at all -> 400 UNRECOGNIZED_PAYLOAD (not 401 — type is checked first)', r1.status === 400 && r1.body?.error === 'UNRECOGNIZED_PAYLOAD', JSON.stringify(r1));
  const r2 = await post({ secret: 'test-orders-secret', body: { not: 'a recognized shape' } });
  ok('unknown shape, even WITH a valid orders secret -> still 400, never accepted', r2.status === 400 && r2.body?.error === 'UNRECOGNIZED_PAYLOAD', JSON.stringify(r2));
}

console.log('\n§7 No secret ever appears in a response body:');
{
  const responses = await Promise.all([
    post({ secret: 'test-orders-secret', body: ORDER_CREATED_PAYLOAD }),
    post({ secret: 'wrong', body: ORDER_CREATED_PAYLOAD }),
  ]);
  const serialized = JSON.stringify(responses);
  ok('neither the orders secret nor the status secret value appears in any response', !serialized.includes('test-orders-secret') && !serialized.includes('test-status-secret'));
}

console.log('\n§8 Zero real DB writes were attempted at any point:');
ok('no prisma.easyOrdersOrder write method was ever called', dbWriteAttempted === false);

server.close();
globalThis.fetch = originalFetch;
prisma.easyOrdersOrder.findMany = originalFindMany;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
