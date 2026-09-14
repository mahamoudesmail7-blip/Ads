// Customer backfill — idempotency, resumability, and failure-isolation
// tests for services/scripts/backfillCustomers.js's run(). All prisma
// calls are in-memory mocks; zero real DB writes.
//   node src/scripts/backfillCustomersTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

let dbWriteAttempted = false;
for (const model of ['product', 'dailyOrder', 'lostOrder', 'lostOrderHistory']) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const orig = prisma[model]?.[method]?.bind(prisma[model]);
    if (!orig) continue;
    prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called.`); };
  }
}

// ---------------------------------------------------------------------------
// In-memory "easyorders_orders" + "customers" tables — a small set of
// historical rows (pre-existing, customer_id: null), matching what real
// pre-Customer-DB rows look like.
// ---------------------------------------------------------------------------
let easyOrders = [
  { id: 1, order_id: 'hist-1', customer_id: null, customer_phone: '01012340001', customer_name: 'Ali', customer_government: 'القاهرة', customer_address: 'addr1' },
  { id: 2, order_id: 'hist-2', customer_id: null, customer_phone: '01012340001', customer_name: 'Ali', customer_government: 'القاهرة', customer_address: 'addr1' }, // same customer, second historical order
  { id: 3, order_id: 'hist-3', customer_id: null, customer_phone: null, customer_name: 'No Phone Order', customer_government: null, customer_address: null }, // no usable phone
  { id: 4, order_id: 'hist-4', customer_id: null, customer_phone: 'garbage-not-a-phone', customer_name: 'Bad Phone', customer_government: null, customer_address: null }, // unnormalizable
  { id: 5, order_id: 'hist-5', customer_id: null, customer_phone: '01198765432', customer_name: 'Mona', customer_government: 'الجيزة', customer_address: 'addr5' },
];
let customers = [];
let nextCustomerId = 1;

prisma.easyOrdersOrder.findMany = async ({ where = {}, distinct, skip = 0, take } = {}) => {
  let rows = easyOrders;
  if (where.customer_id === null) rows = rows.filter((r) => r.customer_id === null);
  if (where.order_id !== undefined) rows = rows.filter((r) => r.order_id === where.order_id);
  if (where.customer_id !== undefined && where.customer_id !== null) rows = rows.filter((r) => r.customer_id === where.customer_id);
  if (distinct?.includes('order_id')) {
    const seen = new Set();
    rows = rows.filter((r) => { if (seen.has(r.order_id)) return false; seen.add(r.order_id); return true; });
  }
  rows = rows.slice(skip, take ? skip + take : undefined);
  return rows.map((r) => ({ ...r }));
};
prisma.easyOrdersOrder.updateMany = async ({ where = {}, data }) => {
  let count = 0;
  for (const r of easyOrders) { if (where.order_id !== undefined && r.order_id !== where.order_id) continue; Object.assign(r, data); count++; }
  return { count };
};

prisma.customer.findUnique = async ({ where }) => customers.find((c) => c.normalized_phone === where.normalized_phone) || null;
prisma.customer.count = async () => customers.length;
prisma.customer.upsert = async ({ where, create, update }) => {
  const existing = customers.find((c) => c.normalized_phone === where.normalized_phone);
  if (existing) { Object.assign(existing, Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined))); return { ...existing }; }
  const row = { id: nextCustomerId++, other_phones_json: null, total_orders: 0, confirmed_orders: 0, delivered_orders: 0, returned_orders: 0, cancelled_orders: 0, total_order_value: 0, delivered_revenue: 0, first_order_at: null, last_order_at: null, ...create };
  customers.push(row);
  return { ...row };
};
prisma.customer.update = async ({ where, data }) => { const row = customers.find((c) => c.id === where.id); Object.assign(row, data); return { ...row }; };

const { run } = await import(pathToFileURL(join(__dirname, './backfillCustomers.js')).href);

console.log('§1 first run — links orders with a usable phone, skips the ones without:');
{
  const summary = await run();
  ok('5 orders processed (one per distinct order_id)', summary.ordersProcessed === 5, JSON.stringify(summary));
  ok('3 orders linked (hist-1, hist-2, hist-5)', summary.ordersLinked === 3, JSON.stringify(summary));
  ok('2 orders skipped for no usable phone (hist-3 null, hist-4 garbage)', summary.ordersSkippedNoUsablePhone === 2, JSON.stringify(summary));
  ok('0 failures', summary.failures === 0, JSON.stringify(summary));
  ok('exactly 2 customers created (Ali shared by 2 orders, Mona separately)', summary.customersCreatedThisRun === 2, JSON.stringify(summary));
  ok('hist-1 and hist-2 (same phone) link to the SAME customer', easyOrders[0].customer_id === easyOrders[1].customer_id && easyOrders[0].customer_id !== null);
  ok('hist-3/hist-4 remain unlinked (customer_id still null)', easyOrders[2].customer_id === null && easyOrders[3].customer_id === null);
}

console.log('\n§2 repeated run (idempotency) — already-linked orders are never revisited, no duplicate customers:');
{
  const customerCountBefore = customers.length;
  const summary = await run();
  ok('only the 2 still-unlinked orders are processed this time', summary.ordersProcessed === 2, JSON.stringify(summary));
  ok('0 newly linked (they still have no usable phone)', summary.ordersLinked === 0, JSON.stringify(summary));
  ok('both still skipped for no usable phone', summary.ordersSkippedNoUsablePhone === 2, JSON.stringify(summary));
  ok('no new customers created on the repeated run', customers.length === customerCountBefore, `before=${customerCountBefore} after=${customers.length}`);
}

console.log('\n§3 a run after fixing one bad record picks it up — WITHOUT ever re-touching already-linked orders (hist-4 stays permanently unlinkable and correctly reappears every run):');
{
  // Give hist-3 a real phone now, to prove a LATER run can still pick up a
  // fixed record without needing to touch the ones already linked.
  easyOrders[2].customer_phone = '01055500000';
  const summary = await run();
  ok('2 orders processed — hist-3 (now fixable) + hist-4 (still permanently garbage); hist-1/2/5 never revisited', summary.ordersProcessed === 2, JSON.stringify(summary));
  ok('hist-3 is now linked', summary.ordersLinked === 1, JSON.stringify(summary));
  ok('hist-4 is still correctly skipped (garbage phone never becomes valid)', summary.ordersSkippedNoUsablePhone === 1, JSON.stringify(summary));
  ok('a new customer was created for hist-3\'s newly-valid phone', summary.customersCreatedThisRun === 1, JSON.stringify(summary));
}

console.log('\n§4 failure isolation — one order throwing an unexpected error does not stop the batch:');
{
  easyOrders.push({ id: 6, order_id: 'hist-6', customer_id: null, customer_phone: '01011112222', customer_name: 'Will Fail', customer_government: null, customer_address: null });
  easyOrders.push({ id: 7, order_id: 'hist-7', customer_id: null, customer_phone: '01033334444', customer_name: 'Will Succeed', customer_government: null, customer_address: null });
  const originalUpsert = prisma.customer.upsert;
  prisma.customer.upsert = async (args) => {
    if (args.create.normalized_phone === '201011112222') throw new Error('simulated failure for hist-6');
    return originalUpsert(args);
  };
  const summary = await run();
  ok('3 orders processed — hist-4 (still permanently garbage) + hist-6 (fails) + hist-7 (succeeds)', summary.ordersProcessed === 3, JSON.stringify(summary));
  ok('1 failure recorded (hist-6)', summary.failures === 1, JSON.stringify(summary));
  ok('1 still linked successfully (hist-7) despite the other failing', summary.ordersLinked === 1, JSON.stringify(summary));
  ok('hist-4 still correctly skipped, not counted as a failure', summary.ordersSkippedNoUsablePhone === 1, JSON.stringify(summary));
  const hist7 = easyOrders.find((r) => r.order_id === 'hist-7');
  ok('hist-7 is actually linked', hist7.customer_id !== null);
  prisma.customer.upsert = originalUpsert;
}

console.log('\n§5 zero writes to unrelated tables (product, dailyOrder, lostOrder*) anywhere in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
