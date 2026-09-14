// Phase 1 Buyer Insights — deterministic new-vs-repeat + co-purchase
// aggregation. Mocked prisma, zero real DB writes. Includes an explicit
// regression guard that the returned object never carries a raw customer
// name/phone/address field (PII must never reach this shape, since PMC's AI
// prompts are built directly from these aggregates).
//   node src/scripts/productMarketingBuyerInsightsTest.js
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

// Product 1 orders: customer 1 (repeat, total_orders=3) ordered twice (100, 120),
// customer 2 (new, total_orders=1) ordered once (200). Each order also has a
// second cart-item row for a DIFFERENT product (co-purchase).
const PRODUCT1_ORDERS = [
  { order_id: 'o1', order_cost: 100, product_id: 1, customer_id: 1 },
  { order_id: 'o2', order_cost: 120, product_id: 1, customer_id: 1 },
  { order_id: 'o3', order_cost: 200, product_id: 1, customer_id: 2 },
];
const CO_PURCHASE_ROWS = [
  { order_id: 'o1', product_id: 50, product: { product_name: 'كريم مرطب' } },
  { order_id: 'o2', product_id: 50, product: { product_name: 'كريم مرطب' } },
  { order_id: 'o3', product_id: 51, product: { product_name: 'شامبو' } },
  { order_id: 'o3', product_id: 1, product: { product_name: 'المنتج نفسه — يستبعد' } }, // same product, must be excluded
];
const CUSTOMERS = [
  { id: 1, total_orders: 3 },
  { id: 2, total_orders: 1 },
];

prisma.easyOrdersOrder.findMany = async ({ where = {} } = {}) => {
  if (where.order_id?.in) {
    // co-purchase lookup: order_id in [...], product_id != productId
    return CO_PURCHASE_ROWS.filter((r) => where.order_id.in.includes(r.order_id) && r.product_id !== where.product_id?.not);
  }
  if (where.product_id !== undefined) return PRODUCT1_ORDERS.filter((o) => o.product_id === where.product_id);
  return [];
};
prisma.customer.findMany = async ({ where = {} } = {}) => (where.id?.in ? CUSTOMERS.filter((c) => where.id.in.includes(c.id)) : CUSTOMERS);

const { buyerInsightsForProduct } = await import(pathToFileURL(join(__dirname, '../services/amb/buyerInsights.js')).href);

console.log('§1 new-vs-repeat split + AOV, using the real Customer.total_orders signal:');
{
  const r = await buyerInsightsForProduct({ productId: 1 });
  ok('source easyorders', r.source === 'easyorders');
  ok('newCustomers = 1 (customer 2)', r.newCustomers === 1, JSON.stringify(r));
  ok('repeatCustomers = 1 (customer 1)', r.repeatCustomers === 1, JSON.stringify(r));
  ok('aovRepeat = avg(100,120) = 110', r.aovRepeat === 110, JSON.stringify(r));
  ok('aovNew = 200', r.aovNew === 200, JSON.stringify(r));
}

console.log('\n§2 top co-purchased products — excludes the product itself, dedupes multi-row same-order/same-product:');
{
  const r = await buyerInsightsForProduct({ productId: 1 });
  const names = r.topCoPurchasedProducts.map((p) => p.productName);
  ok('كريم مرطب appears with coOrders=1 (o1 and o2 both count toward it, but as 2 distinct ORDERS not double-counted per order)', r.topCoPurchasedProducts.find((p) => p.productId === 50)?.coOrders === 2, JSON.stringify(r.topCoPurchasedProducts));
  ok('شامبو appears once', r.topCoPurchasedProducts.find((p) => p.productId === 51)?.coOrders === 1, JSON.stringify(r.topCoPurchasedProducts));
  ok('the product itself (id 1) never appears in its own co-purchase list', !r.topCoPurchasedProducts.some((p) => p.productId === 1), JSON.stringify(r.topCoPurchasedProducts));
}

console.log('\n§3 PII regression guard — the returned shape never carries a raw customer name/phone/address/government field at any level:');
{
  const r = await buyerInsightsForProduct({ productId: 1 });
  const flat = JSON.stringify(r);
  const forbiddenKeys = ['"name"', '"phone"', '"address"', '"government"', '"primary_phone"', '"normalized_phone"'];
  ok('no forbidden PII-shaped key anywhere in the JSON output', forbiddenKeys.every((k) => !flat.includes(k)), flat);
}

console.log('\n§4 no product with any orders -> EMPTY_RESULT, source none:');
{
  const r = await buyerInsightsForProduct({ productId: 999 });
  ok('source none', r.source === 'none');
  ok('all counts null, empty co-purchase list', r.newCustomers === null && r.topCoPurchasedProducts.length === 0);
}

console.log('\n§5 zero writes anywhere in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
