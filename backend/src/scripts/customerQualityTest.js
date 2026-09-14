// Product Marketing Intelligence — customerQualityForProduct() tests.
// Pure computation over mocked EasyOrdersOrder/Customer rows. Zero real DB
// writes (this function is read-only by design; write methods are guarded
// anyway to catch any accidental regression).
//   node src/scripts/customerQualityTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

let dbWriteAttempted = false;
for (const model of ['easyOrdersOrder', 'customer', 'product', 'dailyOrder']) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const orig = prisma[model]?.[method]?.bind(prisma[model]);
    if (!orig) continue;
    prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called — this function must be read-only.`); };
  }
}

let orderRows = [];
let customerRows = [];
prisma.easyOrdersOrder.findMany = async ({ where = {} } = {}) => {
  let rows = orderRows;
  if (where.product_id !== undefined) rows = rows.filter((r) => r.product_id === where.product_id);
  if (where.date?.gte) rows = rows.filter((r) => r.date >= where.date.gte);
  if (where.date?.lte) rows = rows.filter((r) => r.date <= where.date.lte);
  return rows.map((r) => ({ ...r }));
};
prisma.customer.findMany = async ({ where = {} } = {}) => {
  let rows = customerRows;
  if (where.id?.in) rows = rows.filter((c) => where.id.in.includes(c.id));
  return rows.map((r) => ({ ...r }));
};

const { customerQualityForProduct } = await import(pathToFileURL(join(__dirname, '../services/amb/customerQuality.js')).href);

console.log('§1 no orders at all for this product/window -> source none, every count null:');
{
  orderRows = []; customerRows = [];
  const r = await customerQualityForProduct({ productId: 999, from: '2026-09-01', to: '2026-09-14' });
  ok('source none', r.source === 'none');
  ok('orders null (never 0 — 0 would falsely claim "confirmed zero orders")', r.orders === null);
  ok('governorates empty array', Array.isArray(r.governorates) && r.governorates.length === 0);
}

console.log('\n§2 real mixed-status orders — confirmation/delivery/RTO rates, revenue, dedup by order_id:');
{
  customerRows = [
    { id: 1, total_orders: 3 }, // repeat customer (bought elsewhere too)
    { id: 2, total_orders: 1 }, // first-time customer
  ];
  orderRows = [
    { order_id: 'o1', status: 'DELIVERED', order_cost: 300, product_id: 48, date: '2026-09-05', customer_id: 1, customer_government: 'الجيزة' },
    { order_id: 'o1', status: 'DELIVERED', order_cost: 300, product_id: 48, date: '2026-09-05', customer_id: 1, customer_government: 'الجيزة' }, // 2nd cart-item row, same order — must not double-count
    { order_id: 'o2', status: 'RETURNED', order_cost: 150, product_id: 48, date: '2026-09-06', customer_id: 2, customer_government: 'القاهرة' },
    { order_id: 'o3', status: 'PENDING', order_cost: 200, product_id: 48, date: '2026-09-07', customer_id: 2, customer_government: 'القاهرة' },
    { order_id: 'o4', status: 'CANCELLED', order_cost: 100, product_id: 48, date: '2026-09-08', customer_id: null, customer_government: null }, // no linked customer (e.g. bad phone) — must not crash
  ];
  const r = await customerQualityForProduct({ productId: 48, from: '2026-09-01', to: '2026-09-14' });
  ok('source easyorders', r.source === 'easyorders');
  ok('orders = 4 (deduped, o1 counted once)', r.orders === 4, String(r.orders));
  ok('confirmed = 1 (DELIVERED implies confirmed; RETURNED requires having been confirmed first in this model — see note)', r.confirmed === 1, String(r.confirmed));
  ok('delivered = 1', r.delivered === 1, String(r.delivered));
  ok('returned = 1', r.returned === 1, String(r.returned));
  ok('cancelled = 1', r.cancelled === 1, String(r.cancelled));
  ok('confirmationRate = 1/4 = 0.25', Math.abs(r.confirmationRate - 0.25) < 1e-9, String(r.confirmationRate));
  ok('deliveryRate = delivered/confirmed = 1/1 = 1', r.deliveryRate === 1, String(r.deliveryRate));
  ok('revenue = 300+150+200+100 = 750', r.revenue === 750, String(r.revenue));
  ok('deliveredRevenue = 300 (only the delivered order)', r.deliveredRevenue === 300, String(r.deliveredRevenue));
  ok('customerCount = 2 (distinct linked customers; the null one excluded)', r.customerCount === 2, String(r.customerCount));
  ok('repeatCustomerCount = 1 (customer 1 has total_orders > 1)', r.repeatCustomerCount === 1, String(r.repeatCustomerCount));
  const govs = Object.fromEntries(r.governorates.map((g) => [g.government, g]));
  ok('governorate breakdown: الجيزة has 1 order, 1 delivered', govs['الجيزة']?.orders === 1 && govs['الجيزة']?.delivered === 1, JSON.stringify(govs));
  ok('governorate breakdown: القاهرة has 2 orders, 0 delivered', govs['القاهرة']?.orders === 2 && govs['القاهرة']?.delivered === 0, JSON.stringify(govs));
  ok('the null-government order (customer_id null) is never bucketed under a fabricated label', Object.keys(govs).length === 2, JSON.stringify(govs));
}

console.log('\n§3 no customers linked at all (all orders unmatched to a real phone) -> customerCount/repeatCustomerCount null, not 0:');
{
  customerRows = [];
  orderRows = [{ order_id: 'o9', status: 'PENDING', order_cost: 50, product_id: 77, date: '2026-09-10', customer_id: null, customer_government: null }];
  const r = await customerQualityForProduct({ productId: 77 });
  ok('customerCount is null (never a fabricated 0)', r.customerCount === null, String(r.customerCount));
  ok('repeatCustomerCount is null', r.repeatCustomerCount === null, String(r.repeatCustomerCount));
  ok('orders is still a real 1', r.orders === 1);
}

console.log('\n§4 zero writes anywhere in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
