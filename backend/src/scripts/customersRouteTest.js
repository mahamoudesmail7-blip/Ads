// Customer Database route tests — auth/role gating, search by name/phone/
// order id, list-view phone masking, and the full authorized detail view.
// Every prisma call is an in-memory mock; zero real DB writes, zero real
// network calls.
//   node src/scripts/customersRouteTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

let dbWriteAttempted = false;
for (const model of ['customer', 'easyOrdersOrder', 'product']) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const orig = prisma[model]?.[method]?.bind(prisma[model]);
    if (!orig) continue;
    prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called — this route is read-only.`); };
  }
}

const CUSTOMERS = [
  { id: 1, normalized_phone: '201012345678', primary_phone: '01012345678', other_phones_json: null, name: 'Mahmoud Esmail', government: 'الجيزة', address: 'Haram', first_order_at: new Date('2026-09-01'), last_order_at: new Date('2026-09-10'), total_orders: 2, confirmed_orders: 2, delivered_orders: 1, returned_orders: 0, cancelled_orders: 0, total_order_value: 800, delivered_revenue: 300 },
];
const ORDERS = [
  { order_id: 'order-uuid-1', short_id: 3, customer_id: 1, status: 'DELIVERED', order_cost: 300, created_at: new Date('2026-09-01'), product_name_raw: 'جهاز قياس الضغط', product: { product_name: 'جهاز قياس الضغط الذكي المنزلي' } },
  { order_id: 'order-uuid-1', short_id: 3, customer_id: 1, status: 'DELIVERED', order_cost: 300, created_at: new Date('2026-09-01'), product_name_raw: 'جهاز قياس الضغط', product: { product_name: 'جهاز قياس الضغط الذكي المنزلي' } }, // 2nd cart-item row, same order
  { order_id: 'order-uuid-2', short_id: 5, customer_id: 1, status: 'PENDING', order_cost: 500, created_at: new Date('2026-09-10'), product_name_raw: 'منتج آخر', product: null },
];

prisma.customer.findMany = async ({ where = {} } = {}) => {
  if (where.normalized_phone !== undefined) return CUSTOMERS.filter((c) => c.normalized_phone === where.normalized_phone);
  if (where.name?.contains) return CUSTOMERS.filter((c) => c.name && c.name.includes(where.name.contains));
  return CUSTOMERS;
};
prisma.customer.findUnique = async ({ where }) => CUSTOMERS.find((c) => c.id === where.id) || null;
prisma.easyOrdersOrder.findFirst = async ({ where = {} } = {}) => {
  if (where.order_id !== undefined) return ORDERS.find((o) => o.order_id === where.order_id) || null;
  if (where.short_id !== undefined) return ORDERS.find((o) => o.short_id === where.short_id) || null;
  return null;
};
prisma.easyOrdersOrder.findMany = async ({ where = {} } = {}) => (where.customer_id !== undefined ? ORDERS.filter((o) => o.customer_id === where.customer_id) : ORDERS);

const originalUserFindUnique = prisma.user.findUnique.bind(prisma.user);
const jwt = (await import('jsonwebtoken')).default;
const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { default: customersRouter } = await import(pathToFileURL(join(__dirname, '../routes/customers.js')).href);
const app = express();
app.use(cookieParser());
app.use('/api/customers', customersRouter);
const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/customers`;

function tokenFor() { return jwt.sign({ id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' }); }
function asRole(role) { prisma.user.findUnique = async () => ({ id: 1, email: 'x@test.local', name: 'X', role, status: 'ACTIVE', is_owner: false, permissions: '{}' }); }

console.log('§1 no auth cookie -> 401:');
{
  const r = await fetch(`${base}?search=mahmoud`);
  ok('401', r.status === 401, String(r.status));
}

console.log('\n§2 authenticated EMPLOYEE (not ADMIN/MANAGER) -> 403:');
{
  asRole('EMPLOYEE');
  const r = await fetch(`${base}?search=mahmoud`, { headers: { Cookie: `token=${tokenFor()}` } });
  ok('403', r.status === 403, String(r.status));
}

console.log('\n§3 ADMIN search by name -> list view with MASKED phone:');
{
  asRole('ADMIN');
  const r = await fetch(`${base}?search=Mahmoud`, { headers: { Cookie: `token=${tokenFor()}` } });
  const body = await r.json();
  ok('200', r.status === 200, String(r.status));
  ok('exactly one match', body.customers.length === 1, JSON.stringify(body));
  ok('phone is masked (010*****678, middle 5 of 11 digits hidden), never the full raw phone', body.customers[0].phoneMasked === '010*****678', body.customers[0].phoneMasked);
  ok('list response never includes the unmasked "phone" field at all', body.customers[0].phone === undefined, JSON.stringify(body.customers[0]));
}

console.log('\n§4 MANAGER search by real phone (any raw format) -> finds the same customer via normalization:');
{
  asRole('MANAGER');
  const r = await fetch(`${base}?${new URLSearchParams({ search: '+201012345678' })}`, { headers: { Cookie: `token=${tokenFor()}` } });
  const body = await r.json();
  ok('finds customer id=1 despite the different raw phone format', body.customers[0]?.id === 1, JSON.stringify(body));
}

console.log('\n§5 search by Order ID (UUID) -> resolves to the linked customer:');
{
  const r = await fetch(`${base}?${new URLSearchParams({ search: 'order-uuid-1' })}`, { headers: { Cookie: `token=${tokenFor()}` } });
  const body = await r.json();
  ok('resolves via the order_id to customer id=1', body.customers[0]?.id === 1, JSON.stringify(body));
}

console.log('\n§6 search by Order ID (human short_id) -> resolves to the linked customer:');
{
  const r = await fetch(`${base}?${new URLSearchParams({ search: '3' })}`, { headers: { Cookie: `token=${tokenFor()}` } });
  const body = await r.json();
  ok('resolves via the numeric short_id to customer id=1', body.customers[0]?.id === 1, JSON.stringify(body));
}

console.log('\n§7 unknown search term -> empty result, never an error:');
{
  const r = await fetch(`${base}?${new URLSearchParams({ search: 'nobody-like-this-exists' })}`, { headers: { Cookie: `token=${tokenFor()}` } });
  const body = await r.json();
  ok('200 with an empty array', r.status === 200 && body.customers.length === 0, JSON.stringify(body));
}

console.log('\n§8 authorized detail view — full phone shown, order history deduped by order_id, products purchased listed:');
{
  const r = await fetch(`${base}/1`, { headers: { Cookie: `token=${tokenFor()}` } });
  const body = await r.json();
  ok('200', r.status === 200, String(r.status));
  ok('full phone IS shown in the authorized detail view', body.phone === '01012345678', body.phone);
  ok('order history has 2 entries (deduped: order-uuid-1 counted once, order-uuid-2 once)', body.orderHistory.length === 2, JSON.stringify(body.orderHistory));
  ok('productsPurchased lists the real distinct product names', body.productsPurchased.includes('جهاز قياس الضغط الذكي المنزلي'), JSON.stringify(body.productsPurchased));
  ok('aggregate fields come straight from the Customer row', body.totalOrders === 2 && body.deliveredRevenue === 300, JSON.stringify(body));
}

console.log('\n§9 detail view for a non-existent customer -> honest 404:');
{
  const r = await fetch(`${base}/9999`, { headers: { Cookie: `token=${tokenFor()}` } });
  const body = await r.json();
  ok('404 NOT_FOUND', r.status === 404 && body.error === 'NOT_FOUND', JSON.stringify(body));
}

console.log('\n§10 zero writes anywhere in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

server.close();
prisma.user.findUnique = originalUserFindUnique;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
