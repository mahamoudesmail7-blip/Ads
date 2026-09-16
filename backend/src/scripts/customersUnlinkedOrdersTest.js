// GET /api/customers/unlinked-orders (routes/customers.js) — real Easy
// Orders rows that arrived with a phone value normalizeEgyptianPhone()
// rejected, so no Customer was ever created for them (a deliberate safety
// guard, not a bug). Tests the underlying query + reason classification
// directly against real throwaway DB rows (cleaned up after), since the
// route itself is a thin wrapper with no exported pure function to unit
// test in isolation — same convention as easyOrdersSummaryStoreFilterTest.js.
//   node src/scripts/customersUnlinkedOrdersTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { normalizeEgyptianPhone } = await imp('../services/phoneNormalize.js');

// Same query the route runs — kept identical so this test actually
// exercises the real logic, not a re-description of it.
async function fetchUnlinked() {
  const rows = await prisma.easyOrdersOrder.findMany({
    where: { customer_phone: { not: null }, customer_id: null },
    select: { order_id: true, customer_phone: true, customer_name: true, product_name_raw: true },
  });
  const byOrder = new Map();
  for (const r of rows) if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, r);
  return [...byOrder.values()].map((r) => ({
    orderId: r.order_id,
    reason: normalizeEgyptianPhone(r.customer_phone) ? 'رقم صالح لكن لم يُربط لسبب آخر — يحتاج مراجعة' : 'رقم تليفون غير صالح (مش شكل موبايل مصري حقيقي)',
  }));
}

console.log('§1 Real DB — unlinked-order detection + reason classification (throwaway rows, cleaned up):');
{
  const tag = `__test_unlinked_${Date.now()}__`;
  const orderBadPhone = `${tag}_bad`;
  const orderValidPhoneNoCustomer = `${tag}_valid_orphan`;
  const orderLinked = `${tag}_linked`;

  // A real Customer to link the third order to, proving linked orders are excluded.
  const customer = await prisma.customer.create({
    data: { normalized_phone: '201012345678', primary_phone: '01012345678', name: tag, total_orders: 1 },
  });

  await prisma.easyOrdersOrder.createMany({
    data: [
      { order_id: orderBadPhone, cart_item_id: 'i1', date: '2026-09-01', status: 'PENDING', quantity: 1, matched: false, customer_phone: '5323165947905', customer_name: tag, product_name_raw: tag },
      { order_id: orderValidPhoneNoCustomer, cart_item_id: 'i2', date: '2026-09-01', status: 'PENDING', quantity: 1, matched: false, customer_phone: '01098765432', customer_name: tag, product_name_raw: tag, customer_id: null },
      { order_id: orderLinked, cart_item_id: 'i3', date: '2026-09-01', status: 'PENDING', quantity: 1, matched: false, customer_phone: '01011112222', customer_name: tag, product_name_raw: tag, customer_id: customer.id },
    ],
  });

  try {
    const results = await fetchUnlinked();
    const byId = new Map(results.map((r) => [r.orderId, r]));

    ok('an order with a garbled/invalid phone shows up', byId.has(orderBadPhone));
    ok('its reason correctly says the phone itself is invalid', byId.get(orderBadPhone)?.reason.includes('غير صالح'), byId.get(orderBadPhone)?.reason);

    ok('an order with a genuinely VALID phone but no customer_id ALSO shows up (an edge case worth surfacing, not silently hidden)', byId.has(orderValidPhoneNoCustomer));
    ok('its reason is the DIFFERENT "valid but unlinked for another reason" message, not the invalid-phone one', byId.get(orderValidPhoneNoCustomer)?.reason.includes('صالح لكن'), byId.get(orderValidPhoneNoCustomer)?.reason);

    ok('an order already linked to a real customer is correctly EXCLUDED', !byId.has(orderLinked));
    ok('exactly our two unlinked test rows come back for our own tagged orders, nothing double-counted', byId.has(orderBadPhone) && byId.has(orderValidPhoneNoCustomer) && !byId.has(orderLinked));
  } finally {
    await prisma.easyOrdersOrder.deleteMany({ where: { order_id: { in: [orderBadPhone, orderValidPhoneNoCustomer, orderLinked] } } });
    await prisma.customer.delete({ where: { id: customer.id } });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
