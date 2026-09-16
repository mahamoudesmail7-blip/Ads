// Store filter for GET /api/easyorders/summary (routes/easyOrders.js). The
// dashboard used to mix every configured store's orders together with no
// way to isolate one — this adds an optional `store_id` query param.
//   node src/scripts/easyOrdersSummaryStoreFilterTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { resolveStoreFilter } = await imp('../routes/easyOrders.js');
const { prisma } = await imp('../prisma.js');

console.log('§1 resolveStoreFilter — pure parsing, no DB:');
{
  ok('no store_id at all -> no filter (every store mixed, unchanged default)', JSON.stringify(resolveStoreFilter(undefined).where) === '{}');
  ok('store_id="all" -> explicitly no filter too', JSON.stringify(resolveStoreFilter('all').where) === '{}');
  ok('empty string -> no filter, never a bogus store_id:"" match', JSON.stringify(resolveStoreFilter('').where) === '{}');
  ok('a real store id -> scoped where clause', JSON.stringify(resolveStoreFilter('trendy-storeee').where) === JSON.stringify({ store_id: 'trendy-storeee' }));
  ok('storeId itself is surfaced too (not just the where clause)', resolveStoreFilter('trendy-storeee').storeId === 'trendy-storeee');
  ok('storeId is null when unfiltered', resolveStoreFilter(undefined).storeId === null);
}

console.log('\n§2 Real DB — the resolved where clause actually isolates one store\'s orders from another\'s (throwaway rows, cleaned up):');
{
  const today = new Date().toISOString().slice(0, 10);
  const tag = `__test_store_filter_${Date.now()}__`;
  const orderA = `${tag}_A`;
  const orderB = `${tag}_B`;
  await prisma.easyOrdersOrder.createMany({
    data: [
      { order_id: orderA, cart_item_id: 'item-a', date: today, status: 'PENDING', quantity: 1, matched: false, store_id: 'default', product_name_raw: tag },
      { order_id: orderB, cart_item_id: 'item-b', date: today, status: 'PENDING', quantity: 1, matched: false, store_id: 'trendy-storeee', product_name_raw: tag },
    ],
  });
  try {
    const baseWhere = { date: today, product_name_raw: tag };

    const unfiltered = await prisma.easyOrdersOrder.findMany({ where: { ...baseWhere, ...resolveStoreFilter(undefined).where } });
    ok('no filter -> both stores\' test rows come back together', unfiltered.length === 2, String(unfiltered.length));

    const onlyDefault = await prisma.easyOrdersOrder.findMany({ where: { ...baseWhere, ...resolveStoreFilter('default').where } });
    ok('filtered to "default" -> only that store\'s row, never the other store\'s', onlyDefault.length === 1 && onlyDefault[0].order_id === orderA, JSON.stringify(onlyDefault.map((r) => r.order_id)));

    const onlyTrendy = await prisma.easyOrdersOrder.findMany({ where: { ...baseWhere, ...resolveStoreFilter('trendy-storeee').where } });
    ok('filtered to "trendy-storeee" -> only that store\'s row', onlyTrendy.length === 1 && onlyTrendy[0].order_id === orderB, JSON.stringify(onlyTrendy.map((r) => r.order_id)));

    const unknownStore = await prisma.easyOrdersOrder.findMany({ where: { ...baseWhere, ...resolveStoreFilter('no-such-store').where } });
    ok('an unknown store id -> zero rows, never falls back to "all"', unknownStore.length === 0);
  } finally {
    await prisma.easyOrdersOrder.deleteMany({ where: { order_id: { in: [orderA, orderB] } } });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
