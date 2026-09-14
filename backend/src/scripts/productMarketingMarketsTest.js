// Phase 1 Markets & Areas — extended governorate breakdown (revenue/AOV/
// customerCount/repeatCustomerCount/band) + marketsForProduct(). Mocked
// prisma, zero real DB writes.
//   node src/scripts/productMarketingMarketsTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

let dbWriteAttempted = false;
for (const model of ['easyOrdersOrder', 'customer', 'product']) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const orig = prisma[model]?.[method]?.bind(prisma[model]);
    if (!orig) continue;
    prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called.`); };
  }
}

const ORDERS = [
  // Cairo: high volume, high delivery rate -> should band SCALE_MARKET
  ...Array.from({ length: 20 }, (_, i) => ({ order_id: `cai-${i}`, status: i < 15 ? 'DELIVERED' : 'CONFIRMED', order_cost: 200, product_id: 1, customer_id: 100 + i, customer_government: 'القاهرة' })),
  // Giza: high volume, poor delivery rate -> should band REDUCE_PRIORITY (RTO signal)
  ...Array.from({ length: 15 }, (_, i) => ({ order_id: `giz-${i}`, status: i < 3 ? 'DELIVERED' : 'CONFIRMED', order_cost: 150, product_id: 1, customer_id: 200 + i, customer_government: 'الجيزة' })),
  // Aswan: too few orders -> INSUFFICIENT_DATA
  { order_id: 'asw-1', status: 'DELIVERED', order_cost: 100, product_id: 1, customer_id: 300, customer_government: 'اسوان' },
];
const CUSTOMERS = [
  ...Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, total_orders: i % 5 === 0 ? 2 : 1 })), // some Cairo repeat customers
  ...Array.from({ length: 15 }, (_, i) => ({ id: 200 + i, total_orders: 1 })),
  { id: 300, total_orders: 1 },
];

prisma.easyOrdersOrder.findMany = async ({ where = {} } = {}) => (where.product_id !== undefined ? ORDERS.filter((o) => o.product_id === where.product_id) : ORDERS);
prisma.customer.findMany = async ({ where = {} } = {}) => (where.id?.in ? CUSTOMERS.filter((c) => where.id.in.includes(c.id)) : CUSTOMERS);

const { customerQualityForProduct, marketsForProduct } = await import(pathToFileURL(join(__dirname, '../services/amb/customerQuality.js')).href);

console.log('§1 extended governorate breakdown carries revenue/AOV/customerCount/repeatCustomerCount:');
{
  const q = await customerQualityForProduct({ productId: 1 });
  const cairo = q.governorates.find((g) => g.government === 'القاهرة');
  ok('Cairo revenue = 20*200 = 4000', cairo.revenue === 4000, JSON.stringify(cairo));
  ok('Cairo AOV = 4000/20 = 200', cairo.aov === 200, JSON.stringify(cairo));
  ok('Cairo customerCount = 20 (distinct customers)', cairo.customerCount === 20, JSON.stringify(cairo));
  ok('Cairo repeatCustomerCount = 4 (every 5th customer has total_orders=2: indices 0,5,10,15)', cairo.repeatCustomerCount === 4, JSON.stringify(cairo));
  ok('Cairo deliveredRevenue = 15*200 = 3000', cairo.deliveredRevenue === 3000, JSON.stringify(cairo));
}

console.log('\n§2 marketsForProduct — bands each governorate deterministically, never by order count alone:');
{
  const { source, markets } = await marketsForProduct({ productId: 1, minOrders: 10 });
  ok('source easyorders', source === 'easyorders');
  const cairo = markets.find((m) => m.government === 'القاهرة');
  const giza = markets.find((m) => m.government === 'الجيزة');
  const aswan = markets.find((m) => m.government === 'اسوان');
  ok('Cairo (high volume + high delivery rate) -> SCALE_MARKET', cairo.band === 'SCALE_MARKET', JSON.stringify(cairo));
  ok('Giza (high volume but POOR delivery rate) -> REDUCE_PRIORITY, never SCALE just from order count', giza.band === 'REDUCE_PRIORITY', JSON.stringify(giza));
  ok('Aswan (only 1 order, below minOrders) -> INSUFFICIENT_DATA', aswan.band === 'INSUFFICIENT_DATA', JSON.stringify(aswan));
  ok('markets sorted by delivered desc', markets[0].government === 'القاهرة');
}

console.log('\n§3 no product with any orders -> marketsForProduct returns source none, empty markets:');
{
  const { source, markets } = await marketsForProduct({ productId: 999 });
  ok('source none', source === 'none');
  ok('empty markets array', Array.isArray(markets) && markets.length === 0);
}

console.log('\n§4 zero writes anywhere in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
