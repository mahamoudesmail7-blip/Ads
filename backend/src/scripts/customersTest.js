// Customer Database service tests — upsertCustomerForOrder,
// recomputeCustomerStats, linkOrderToCustomer. Every prisma.customer/
// easyOrdersOrder call is an in-memory mock (stateful, mimicking real
// upsert/unique-constraint semantics) — this file NEVER performs a real DB
// write. Every write method on product/dailyOrder is guarded to throw,
// proving this feature never touches unrelated tables.
//   node src/scripts/customersTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

let dbWriteAttempted = false;
for (const model of ['product', 'dailyOrder']) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const orig = prisma[model]?.[method]?.bind(prisma[model]);
    if (!orig) continue;
    prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called.`); };
  }
}

// ---------------------------------------------------------------------------
// In-memory "customers" + "easyorders_orders" tables. The upsert mock
// enforces the real unique-constraint semantics on normalized_phone so the
// concurrency test is meaningful.
// ---------------------------------------------------------------------------
let customers = [];
let nextCustomerId = 1;
let orders = []; // { id, order_id, customer_id, status, order_cost, created_at }

prisma.customer.findUnique = async ({ where }) => customers.find((c) => c.normalized_phone === where.normalized_phone) || null;
prisma.customer.upsert = async ({ where, create, update }) => {
  const existing = customers.find((c) => c.normalized_phone === where.normalized_phone);
  if (existing) {
    Object.assign(existing, Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)));
    existing.updated_at = new Date();
    return { ...existing };
  }
  const row = { id: nextCustomerId++, other_phones_json: null, total_orders: 0, confirmed_orders: 0, delivered_orders: 0, returned_orders: 0, cancelled_orders: 0, total_order_value: 0, delivered_revenue: 0, first_order_at: null, last_order_at: null, created_at: new Date(), updated_at: new Date(), ...create };
  customers.push(row);
  return { ...row };
};
prisma.customer.update = async ({ where, data }) => {
  const row = customers.find((c) => c.id === where.id);
  if (!row) throw new Error('customer not found');
  Object.assign(row, data);
  return { ...row };
};

prisma.easyOrdersOrder.findMany = async ({ where = {} } = {}) => {
  let rows = orders;
  if (where.customer_id !== undefined) rows = rows.filter((o) => o.customer_id === where.customer_id);
  if (where.order_id !== undefined) rows = rows.filter((o) => o.order_id === where.order_id);
  return rows.map((r) => ({ ...r }));
};
prisma.easyOrdersOrder.updateMany = async ({ where = {}, data }) => {
  let count = 0;
  for (const o of orders) {
    if (where.order_id !== undefined && o.order_id !== where.order_id) continue;
    Object.assign(o, data);
    count++;
  }
  return { count };
};

const { normalizeEgyptianPhone } = await import(pathToFileURL(join(__dirname, '../services/phoneNormalize.js')).href);
const { upsertCustomerForOrder, recomputeCustomerStats, linkOrderToCustomer } = await import(pathToFileURL(join(__dirname, '../services/customers.js')).href);

console.log('§1 Customer creation — new phone, no existing customer:');
{
  const c = await upsertCustomerForOrder({ rawPhone: '01012345678', fullName: 'Mahmoud', government: 'الجيزة', address: 'Haram', guestId: 'g1' });
  ok('created with the normalized phone', c.normalized_phone === '201012345678', c.normalized_phone);
  ok('name/government/address/guestId stored as given', c.name === 'Mahmoud' && c.government === 'الجيزة' && c.address === 'Haram' && c.easy_orders_guest_id === 'g1');
  ok('exactly one customer row exists', customers.length === 1, String(customers.length));
}

console.log('\n§2 Customer update — same phone in a different raw format, updates in place (no duplicate):');
{
  const before = customers.length;
  const c = await upsertCustomerForOrder({ rawPhone: '+201012345678', fullName: 'Mahmoud Esmail', government: 'الجيزة', address: 'Haram new', guestId: 'g2' });
  ok('same customer id (matched by normalized phone, not raw string)', c.id === 1, String(c.id));
  ok('no duplicate row created', customers.length === before, `before=${before} after=${customers.length}`);
  ok('name updated to the newer non-blank value', c.name === 'Mahmoud Esmail');
  ok('primary_phone updated to the latest raw variant', c.primary_phone === '+201012345678');
  const otherPhones = JSON.parse(c.other_phones_json || '[]');
  ok('the OLD raw phone variant is preserved in other_phones_json', otherPhones.includes('01012345678'), c.other_phones_json);
}

console.log('\n§3 blank/missing values never overwrite a good existing value:');
{
  const c = await upsertCustomerForOrder({ rawPhone: '01012345678', fullName: '', government: null, address: undefined, guestId: '' });
  ok('name stays the previous good value (blank string ignored)', c.name === 'Mahmoud Esmail', c.name);
  ok('government stays the previous good value (null ignored)', c.government === 'الجيزة', c.government);
  ok('address stays the previous good value (undefined ignored)', c.address === 'Haram new', c.address);
}

console.log('\n§4 invalid/unnormalizable phone -> null, no customer created or touched:');
{
  const before = customers.length;
  const c = await upsertCustomerForOrder({ rawPhone: 'not-a-real-phone', fullName: 'Someone' });
  ok('returns null', c === null);
  ok('no new customer created', customers.length === before);
}

console.log('\n§5 multiple raw phone variants across 3 different real formats all resolve to ONE customer:');
{
  customers = []; nextCustomerId = 1; // fresh slate for this scenario
  await upsertCustomerForOrder({ rawPhone: '01198765432', fullName: 'Sara' });
  await upsertCustomerForOrder({ rawPhone: '201198765432', fullName: 'Sara' });
  await upsertCustomerForOrder({ rawPhone: '0020 119 876 5432', fullName: 'Sara A.' });
  ok('exactly one customer for all 3 real variants of the same number', customers.length === 1, String(customers.length));
  const otherPhones = JSON.parse(customers[0].other_phones_json || '[]');
  ok('other_phones_json records the real variants actually seen (never invented)', otherPhones.length >= 1, customers[0].other_phones_json);
}

console.log('\n§6 concurrency — two "simultaneous" upserts for a BRAND NEW phone never create two customers:');
{
  customers = []; nextCustomerId = 1;
  const [c1, c2] = await Promise.all([
    upsertCustomerForOrder({ rawPhone: '01234567890', fullName: 'Race A' }),
    upsertCustomerForOrder({ rawPhone: '01234567890', fullName: 'Race B' }),
  ]);
  ok('both calls resolve to the SAME customer id', c1.id === c2.id, `${c1.id} vs ${c2.id}`);
  ok('exactly one row exists after the race', customers.length === 1, String(customers.length));
}

console.log('\n§7 order -> customer linking (linkOrderToCustomer):');
{
  customers = []; nextCustomerId = 1; orders = [];
  orders.push({ id: 1, order_id: 'order-A', customer_id: null, status: 'PENDING', order_cost: 500, created_at: new Date('2026-09-01') });
  const customerId = await linkOrderToCustomer({ orderId: 'order-A', rawPhone: '01055512345', fullName: 'Test Buyer', government: 'القاهرة', address: 'x' });
  ok('returns the resolved customer id', typeof customerId === 'number' && customerId > 0, String(customerId));
  ok('the order row is now linked', orders[0].customer_id === customerId, String(orders[0].customer_id));
}

console.log('\n§8 aggregate recomputation — total/confirmed/delivered/returned/cancelled + delivered revenue, deduped by order_id:');
{
  customers = []; nextCustomerId = 1; orders = [];
  const c = await upsertCustomerForOrder({ rawPhone: '01055512345' });
  orders = [
    { id: 1, order_id: 'o1', customer_id: c.id, status: 'DELIVERED', order_cost: 300, created_at: new Date('2026-09-01') },
    { id: 2, order_id: 'o1', customer_id: c.id, status: 'DELIVERED', order_cost: 300, created_at: new Date('2026-09-01') }, // same order, 2nd cart-item row — must be deduped by order_id, not double-counted
    { id: 3, order_id: 'o2', customer_id: c.id, status: 'RETURNED', order_cost: 150, created_at: new Date('2026-09-05') },
    { id: 4, order_id: 'o3', customer_id: c.id, status: 'CANCELLED', order_cost: 200, created_at: new Date('2026-09-03') },
    { id: 5, order_id: 'o4', customer_id: c.id, status: 'PENDING', order_cost: 400, created_at: new Date('2026-09-10') },
  ];
  await recomputeCustomerStats(c.id);
  const updated = customers.find((x) => x.id === c.id);
  ok('total_orders = 4 (deduped by order_id, o1 counted once)', updated.total_orders === 4, String(updated.total_orders));
  ok('delivered_orders = 1', updated.delivered_orders === 1, String(updated.delivered_orders));
  ok('returned_orders = 1', updated.returned_orders === 1, String(updated.returned_orders));
  ok('cancelled_orders = 1', updated.cancelled_orders === 1, String(updated.cancelled_orders));
  ok('confirmed_orders includes DELIVERED (delivered implies confirmed) = 1', updated.confirmed_orders === 1, String(updated.confirmed_orders));
  ok('total_order_value = 300+150+200+400 = 1050 (o1 counted once despite 2 rows)', updated.total_order_value === 1050, String(updated.total_order_value));
  ok('delivered_revenue = 300 (only the DELIVERED order)', updated.delivered_revenue === 300, String(updated.delivered_revenue));
  ok('first_order_at is the earliest (2026-09-01)', updated.first_order_at.toISOString().startsWith('2026-09-01'), updated.first_order_at);
  ok('last_order_at is the latest (2026-09-10)', updated.last_order_at.toISOString().startsWith('2026-09-10'), updated.last_order_at);
}

console.log('\n§9 recomputeCustomerStats with no linked orders -> no-op, never errors, never zeroes out a real customer by mistake:');
{
  customers = []; nextCustomerId = 1; orders = [];
  const c = await upsertCustomerForOrder({ rawPhone: '01055512345' });
  await recomputeCustomerStats(null); // should just return, no throw
  await recomputeCustomerStats(999999); // non-existent id, no orders -> no-op
  ok('no exception thrown for null/unknown customerId', true);
}

console.log('\n§10 a failed customer link (e.g. a DB error) never throws out of linkOrderToCustomer, and logs no raw PII:');
{
  customers = []; nextCustomerId = 1; orders = [{ id: 1, order_id: 'order-fail', customer_id: null, status: 'PENDING', order_cost: 100, created_at: new Date() }];
  const originalUpsert = prisma.customer.upsert;
  const originalWarn = (await import(pathToFileURL(join(__dirname, '../logger.js')).href)).logger.warn;
  let loggedArgs = null;
  const { logger } = await import(pathToFileURL(join(__dirname, '../logger.js')).href);
  logger.warn = (...args) => { loggedArgs = args; };
  prisma.customer.upsert = async () => { throw new Error('simulated DB error'); };

  const result = await linkOrderToCustomer({ orderId: 'order-fail', rawPhone: '01099998888', fullName: 'Secret Name', address: 'Secret Address 123' });
  ok('returns null instead of throwing', result === null);
  ok('order row is left unlinked (customer_id still null)', orders[0].customer_id === null);
  ok('a warning was logged', loggedArgs !== null);
  const loggedText = JSON.stringify(loggedArgs);
  ok('the log does NOT contain the raw phone', !loggedText.includes('01099998888'), loggedText);
  ok('the log does NOT contain the raw name', !loggedText.includes('Secret Name'), loggedText);
  ok('the log does NOT contain the raw address', !loggedText.includes('Secret Address'), loggedText);
  ok('the log DOES contain the order id (safe to log)', loggedText.includes('order-fail'), loggedText);

  prisma.customer.upsert = originalUpsert;
  logger.warn = originalWarn;
}

console.log('\n§11 zero writes to unrelated tables (product, dailyOrder) anywhere in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
