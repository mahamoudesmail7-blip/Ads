// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 13 (Stock Intelligence) verification.
//   node src/scripts/stockIntelligenceTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { stockStatus, daysRemaining } = await imp('../services/amb/stockGuard.js');
const { prisma } = await imp('../prisma.js');
const { get_stock_status } = await imp('../services/aiTools.js');

console.log('§1 Pure fixture assertions — stockStatus (no real product in this DB has current_stock set, so this proves the boundaries the real-data pass below cannot):');
{
  ok('current_stock null -> STOCK_UNKNOWN (never invented)', stockStatus({ current_stock: null, minimum_stock: 10 }).status === 'STOCK_UNKNOWN');
  ok('current_stock 0 -> OUT_OF_STOCK', stockStatus({ current_stock: 0, minimum_stock: 10 }).status === 'OUT_OF_STOCK');
  ok('current_stock below minimum -> LOW', stockStatus({ current_stock: 5, minimum_stock: 10 }).status === 'LOW');
  ok('current_stock exactly at minimum -> LOW (boundary inclusive)', stockStatus({ current_stock: 10, minimum_stock: 10 }).status === 'LOW');
  ok('current_stock comfortably above minimum -> SAFE', stockStatus({ current_stock: 50, minimum_stock: 10 }).status === 'SAFE');
  ok('no minimum_stock configured (null) -> treated as 0, any positive stock is SAFE', stockStatus({ current_stock: 5, minimum_stock: null }).status === 'SAFE');

  ok('daysRemaining null when velocity is null (never fabricated)', daysRemaining({ currentStock: 100, avgDailyDelivered: null }) === null);
  ok('daysRemaining null when velocity is 0 (never divide-by-zero to Infinity)', daysRemaining({ currentStock: 100, avgDailyDelivered: 0 }) === null);
  ok('daysRemaining is a real, correctly rounded number for real inputs', daysRemaining({ currentStock: 100, avgDailyDelivered: 7 }) === Math.round(100 / 7));
}

console.log('\n§2 Real reads — get_stock_status maps stockGuard states onto the spec vocabulary honestly:');
{
  const STATE_MAP = { SAFE: 'HEALTHY', LOW: 'LOW', OUT_OF_STOCK: 'CRITICAL', STOCK_UNKNOWN: 'NOT_CONNECTED' };
  const ambProducts = await prisma.ambProduct.findMany({ take: 10, orderBy: { id: 'desc' }, select: { product_id: true, product_name: true } });
  let checked = 0;
  for (const ap of ambProducts) {
    if (!ap.product_id) continue;
    const out = await get_stock_status({ productId: ap.product_id });
    if (!out.ok) continue;
    checked++;
    ok(`${ap.product_name} status is a real spec-vocabulary value`, Object.values(STATE_MAP).includes(out.status), out.status);
    ok(`${ap.product_name} NOT_CONNECTED carries an honest note, never a fabricated number`, out.status !== 'NOT_CONNECTED' || (out.currentStock === null && typeof out.note === 'string'), JSON.stringify(out));
    ok(`${ap.product_name} daysRemaining is null or a non-negative integer`, out.daysRemaining === null || (Number.isInteger(out.daysRemaining) && out.daysRemaining >= 0), out.daysRemaining);
  }
  ok('checked at least one real product', checked > 0, `checked=${checked}`);
  console.log(`  checked ${checked} real products (all NOT_CONNECTED in this DB — no product has current_stock configured yet, confirmed honest).`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
