// Temporary Phase 0 diagnostic route (GET /api/easyorders/debug/order/:orderId)
// — proves it requires ADMIN, passes the real Easy Orders API response
// through completely unmodified, and returns 404 honestly when the order
// doesn't exist. Zero real network calls (global fetch mocked) and zero
// real DB writes.
//   node src/scripts/easyOrdersDebugRouteTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

process.env.EASYORDERS_API_KEY = 'test-key';

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

let dbWriteAttempted = false;
for (const model of ['easyOrdersOrder', 'dailyOrder', 'product']) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const orig = prisma[model]?.[method]?.bind(prisma[model]);
    if (!orig) continue;
    prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called.`); };
  }
}

const REAL_ORDER_ID = 'test-order-uuid-123';
const FAKE_RAW_ORDER = {
  id: REAL_ORDER_ID, short_id: 3, full_name: 'Test Customer', phone: '01000000000',
  email: 'test@example.com', notes: 'ملاحظة تجريبية', coupon: 'SAVE10',
  utm_source: 'facebook', campaign_id: '120252250593950205',
  cart_items: [{ id: 'ci1', quantity: 1, product: { sku: 'SKU-X', name: 'منتج تجريبي' } }],
  created_at: '2026-09-13T18:56:33.017Z', status: 'pending',
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  if (String(url).includes(`/orders/${REAL_ORDER_ID}`)) return { ok: true, status: 200, json: async () => FAKE_RAW_ORDER };
  if (String(url).includes('/orders/does-not-exist')) return { ok: false, status: 404, text: async () => '' };
  return originalFetch(url, ...rest);
};

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const jwt = (await import('jsonwebtoken')).default;
const originalUserFindUnique = prisma.user.findUnique.bind(prisma.user);

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { default: easyOrdersRouter } = await import(pathToFileURL(join(__dirname, '../routes/easyorders.js')).href);
const app = express();
app.use(cookieParser());
app.use('/api/easyorders', easyOrdersRouter);
const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/easyorders`;

function tokenFor(role) { return jwt.sign({ id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' }); }

console.log('§1 no auth cookie -> 401:');
{
  const r = await fetch(`${base}/debug/order/${REAL_ORDER_ID}`);
  ok('401', r.status === 401, String(r.status));
}

console.log('\n§2 authenticated but non-ADMIN (MANAGER) -> 403:');
{
  prisma.user.findUnique = async () => ({ id: 1, email: 'm@test.local', name: 'Manager', role: 'MANAGER', status: 'ACTIVE', is_owner: false, permissions: '{}' });
  const r = await fetch(`${base}/debug/order/${REAL_ORDER_ID}`, { headers: { Cookie: `token=${tokenFor('MANAGER')}` } });
  ok('403', r.status === 403, String(r.status));
}

console.log('\n§3 ADMIN + real order id -> 200 with the RAW body completely unmodified:');
{
  prisma.user.findUnique = async () => ({ id: 1, email: 'a@test.local', name: 'Admin', role: 'ADMIN', status: 'ACTIVE', is_owner: false, permissions: '{}' });
  const r = await fetch(`${base}/debug/order/${REAL_ORDER_ID}`, { headers: { Cookie: `token=${tokenFor('ADMIN')}` } });
  const body = await r.json();
  ok('200', r.status === 200, String(r.status));
  ok('body is byte-for-byte the same raw object (every field passed through, nothing stripped/renamed)', JSON.stringify(body) === JSON.stringify(FAKE_RAW_ORDER), JSON.stringify(body));
  ok('fields not read anywhere else in the app (email/notes/coupon/utm/campaign_id) are visible here', body.email && body.notes && body.coupon && body.utm_source && body.campaign_id, JSON.stringify(body));
}

console.log('\n§4 ADMIN + order that does not exist -> honest 404, never a fabricated body:');
{
  const r = await fetch(`${base}/debug/order/does-not-exist`, { headers: { Cookie: `token=${tokenFor('ADMIN')}` } });
  const body = await r.json();
  ok('404', r.status === 404 && body.error === 'NOT_FOUND', JSON.stringify({ status: r.status, body }));
}

console.log('\n§5 zero real DB writes anywhere in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

server.close();
globalThis.fetch = originalFetch;
prisma.user.findUnique = originalUserFindUnique;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
