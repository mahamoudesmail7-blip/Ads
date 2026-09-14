// Regression test for Block A's real-revenue addition to
// codCountsForProduct(): it now returns real revenue/deliveredRevenue
// (summed order_cost, deduped by order_id) alongside the existing counts,
// so productDashboard() can pass REAL revenue into netProfitBundle()
// instead of always estimating it. Mocked prisma, zero real DB writes.
//   node src/scripts/codOrdersRevenueTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

let dbWriteAttempted = false;
for (const model of ['easyOrdersOrder', 'dailyOrder']) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const orig = prisma[model]?.[method]?.bind(prisma[model]);
    if (!orig) continue;
    prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called.`); };
  }
}

const ORDERS = [
  { order_id: 'o1', status: 'DELIVERED', order_cost: 300, product_id: 1 },
  { order_id: 'o1', status: 'DELIVERED', order_cost: 300, product_id: 1 }, // 2nd cart-item row, same order — must not double-count
  { order_id: 'o2', status: 'DELIVERED', order_cost: 200, product_id: 1 },
  { order_id: 'o3', status: 'CONFIRMED', order_cost: 150, product_id: 1 }, // not delivered yet — counts toward revenue but not deliveredRevenue
  { order_id: 'o4', status: 'CANCELLED', order_cost: 100, product_id: 1 },
];
prisma.easyOrdersOrder.findMany = async ({ where = {} } = {}) => (where.product_id === 1 ? ORDERS : []);
prisma.dailyOrder.findMany = async () => [];

const { codCountsForProduct } = await import(pathToFileURL(join(__dirname, '../services/amb/codOrders.js')).href);

console.log('§1 real revenue and deliveredRevenue are computed, deduped by order_id:');
{
  const r = await codCountsForProduct({ productId: 1 });
  ok('source easyorders', r.source === 'easyorders');
  ok('orders = 4 (deduped, o1 counted once)', r.orders === 4, String(r.orders));
  ok('revenue = 300+200+150+100 = 750 (all orders, deduped)', r.revenue === 750, String(r.revenue));
  ok('deliveredRevenue = 300+200 = 500 (only DELIVERED, o1 counted once)', r.deliveredRevenue === 500, String(r.deliveredRevenue));
}

console.log('\n§2 no product with any EasyOrders rows -> falls through to daily_orders (empty) -> source none, revenue null not 0:');
{
  const r = await codCountsForProduct({ productId: 999 });
  ok('source none', r.source === 'none');
  ok('revenue is null, never a fabricated 0', r.revenue === null);
  ok('deliveredRevenue is null too', r.deliveredRevenue === null);
}

console.log('\n§3 zero writes anywhere in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
