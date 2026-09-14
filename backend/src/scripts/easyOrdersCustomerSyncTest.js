// Easy Orders <-> Customer Database sync integration — exercises the REAL
// ingestOrder()/applyStatusToOrder() functions end-to-end (not just
// services/customers.js in isolation), proving the wiring itself is
// correct: a real order payload creates/links a Customer, populates the
// new confirmed-real fields, and a status change recomputes both the
// product's DailyOrder AND the customer's aggregates. Also proves "one
// failed order must not stop the full sync" — a customer-link failure
// still lets the order itself get stored.
//
// Every prisma write is a stateful in-memory mock. Zero real DB writes,
// zero real network calls.
//   node src/scripts/easyOrdersCustomerSyncTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

let dbWriteAttempted = false;
for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
  const orig = prisma.lostOrder?.[method]?.bind(prisma.lostOrder);
  if (orig) prisma.lostOrder[method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.lostOrder.${method}() was called (test orders never reach RETURNED).`); };
  const origH = prisma.lostOrderHistory?.[method]?.bind(prisma.lostOrderHistory);
  if (origH) prisma.lostOrderHistory[method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.lostOrderHistory.${method}() was called.`); };
}

// ---------------------------------------------------------------------------
// In-memory tables
// ---------------------------------------------------------------------------
let products = [{ id: 48, product_name: 'جهاز قياس الضغط الذكي المنزلي', sku: '', active: true }];
let easyOrders = []; // rows created by ingestOrder
let customers = [];
let dailyOrders = [];
let nextEoId = 1, nextCustomerId = 1, nextDailyId = 1;

prisma.product.findFirst = async ({ where }) => products.find((p) => where.sku !== undefined ? p.sku === where.sku : false) || null;
prisma.product.findMany = async ({ where = {} } = {}) => ('active' in where ? products.filter((p) => p.active === where.active) : products);

prisma.easyOrdersOrder.upsert = async ({ where, create, update }) => {
  const key = where.order_id_cart_item_id;
  let row = easyOrders.find((r) => r.order_id === key.order_id && r.cart_item_id === key.cart_item_id);
  if (row) { Object.assign(row, update); return { ...row }; }
  row = { id: nextEoId++, customer_id: null, ...create };
  easyOrders.push(row);
  return { ...row };
};
prisma.easyOrdersOrder.findMany = async ({ where = {} } = {}) => {
  let rows = easyOrders;
  if (where.product_id !== undefined) rows = rows.filter((r) => r.product_id === where.product_id);
  if (where.date !== undefined) rows = rows.filter((r) => r.date === where.date);
  if (where.order_id !== undefined) rows = rows.filter((r) => r.order_id === where.order_id);
  if (where.customer_id !== undefined) rows = rows.filter((r) => r.customer_id === where.customer_id);
  return rows.map((r) => ({ ...r }));
};
prisma.easyOrdersOrder.updateMany = async ({ where = {}, data }) => {
  let count = 0;
  for (const r of easyOrders) {
    if (where.order_id !== undefined && r.order_id !== where.order_id) continue;
    Object.assign(r, data);
    count++;
  }
  return { count };
};
prisma.easyOrdersOrder.update = async ({ where, data }) => {
  const row = easyOrders.find((r) => r.id === where.id);
  Object.assign(row, data);
  return { ...row };
};

prisma.dailyOrder.upsert = async ({ where, create, update }) => {
  const key = where.product_id_date;
  let row = dailyOrders.find((d) => d.product_id === key.product_id && d.date === key.date);
  if (row) { Object.assign(row, update); return { ...row }; }
  row = { id: nextDailyId++, ...create };
  dailyOrders.push(row);
  return { ...row };
};

prisma.customer.findUnique = async ({ where }) => customers.find((c) => c.normalized_phone === where.normalized_phone) || null;
prisma.customer.upsert = async ({ where, create, update }) => {
  const existing = customers.find((c) => c.normalized_phone === where.normalized_phone);
  if (existing) { Object.assign(existing, Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined))); return { ...existing }; }
  const row = { id: nextCustomerId++, other_phones_json: null, total_orders: 0, confirmed_orders: 0, delivered_orders: 0, returned_orders: 0, cancelled_orders: 0, total_order_value: 0, delivered_revenue: 0, first_order_at: null, last_order_at: null, ...create };
  customers.push(row);
  return { ...row };
};
prisma.customer.update = async ({ where, data }) => {
  const row = customers.find((c) => c.id === where.id);
  Object.assign(row, data);
  return { ...row };
};

const { ingestOrder, applyStatusToOrder } = await import(pathToFileURL(join(__dirname, '../services/easyOrders.js')).href);

function realOrderPayload(overrides = {}) {
  return {
    id: 'order-uuid-1', short_id: 1, created_at: '2026-09-13T17:02:43.706Z', status: 'pending',
    full_name: 'Mahmoud Esmail', phone: '01112305888', government: 'الجيزة', address: 'giza\nHaram',
    cost: 3699, shipping_cost: 60, total_cost: 3759,
    store_id: '10dd5a6f-51fb-4846-a122-6ef9799e35bb', guest_id: '86f6e54f-fc23-4fa1-ab31-ff481dc8004d',
    payment_method: 'cod', ip: '154.182.139.73:33244', ip_country: 'eg',
    metadata: {
      '01112305888': { delivery_rate_status: 'completed', order_delivery_rate_id: 'x', rate_result: 'unknown' },
      tracking: { first_order_at: '2026-09-13T17:02:43.403Z', first_visit_at: '2026-09-13T13:55:42.515Z', orders_count: 0, pages_visited: ['/'], referrer: 'app.easy-orders.net', sessions_count: 9, visit_duration_seconds: 148 },
    },
    cart_items: [{ id: 'item-1', quantity: 1, product: { sku: '', name: 'جهاز قياس الضغط الذكي المنزلي' } }],
    ...overrides,
  };
}

console.log('§1 ingestOrder() end-to-end — real Easy Orders fields populated + Customer created and linked:');
{
  await ingestOrder(realOrderPayload());
  ok('exactly one EasyOrdersOrder row created', easyOrders.length === 1, String(easyOrders.length));
  const row = easyOrders[0];
  ok('easy_orders_store_id stored', row.easy_orders_store_id === '10dd5a6f-51fb-4846-a122-6ef9799e35bb');
  ok('easy_orders_guest_id stored', row.easy_orders_guest_id === '86f6e54f-fc23-4fa1-ab31-ff481dc8004d');
  ok('payment_method stored', row.payment_method === 'cod');
  ok('ip_address/ip_country stored', row.ip_address === '154.182.139.73:33244' && row.ip_country === 'eg');
  ok('total_cost stored', row.total_cost === 3759);
  ok('delivery_rate_status/result stored from metadata[phone]', row.delivery_rate_status === 'completed' && row.delivery_rate_result === 'unknown');
  ok('tracking_json stores the real metadata.tracking sub-object verbatim', JSON.parse(row.tracking_json).referrer === 'app.easy-orders.net');
  ok('customer_id is linked (not null)', typeof row.customer_id === 'number', String(row.customer_id));
  ok('exactly one Customer created', customers.length === 1, String(customers.length));
  ok('Customer aggregates already reflect this one order (recomputed as part of ingestion)', customers[0].total_orders === 1, JSON.stringify(customers[0]));
}

console.log('\n§2 a second order for the SAME real phone (different raw format) links to the SAME customer:');
{
  await ingestOrder(realOrderPayload({ id: 'order-uuid-2', phone: '+201112305888', cost: 500, status: 'pending', cart_items: [{ id: 'item-2', quantity: 1, product: { sku: '', name: 'جهاز قياس الضغط الذكي المنزلي' } }] }));
  ok('still exactly one Customer (no duplicate)', customers.length === 1, String(customers.length));
  const linkedCustomerIds = new Set(easyOrders.map((r) => r.customer_id));
  ok('both orders link to the same customer_id', linkedCustomerIds.size === 1, JSON.stringify([...linkedCustomerIds]));
  ok('Customer aggregates now reflect BOTH orders', customers[0].total_orders === 2, String(customers[0].total_orders));
}

console.log('\n§3 applyStatusToOrder recomputes the linked customer aggregates on a real status change:');
{
  await applyStatusToOrder('order-uuid-1', 'delivered_to_client');
  const c = customers[0];
  ok('delivered_orders reflects the status change', c.delivered_orders === 1, String(c.delivered_orders));
  ok('delivered_revenue reflects only the delivered order\'s cost (3699)', c.delivered_revenue === 3699, String(c.delivered_revenue));
}

console.log('\n§4 one failed customer-link must not stop the order itself from being ingested:');
{
  const before = easyOrders.length;
  const originalUpsert = prisma.customer.upsert;
  prisma.customer.upsert = async () => { throw new Error('simulated failure'); };
  await ingestOrder(realOrderPayload({ id: 'order-uuid-3', phone: '01055500000', cost: 100, cart_items: [{ id: 'item-3', quantity: 1, product: { sku: '', name: 'جهاز قياس الضغط الذكي المنزلي' } }] }));
  ok('the order row was still created despite the customer-link failure', easyOrders.length === before + 1, `before=${before} after=${easyOrders.length}`);
  const newRow = easyOrders.find((r) => r.order_id === 'order-uuid-3');
  ok('the order simply has no customer_id linked', newRow.customer_id === null, String(newRow.customer_id));
  prisma.customer.upsert = originalUpsert;
}

console.log('\n§5 zero writes to LostOrder tables anywhere in this file (test orders never reach RETURNED):');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
