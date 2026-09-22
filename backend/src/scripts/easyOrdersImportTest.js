// Historical order import from an Easy Orders Excel export
// (services/easyOrdersImport.js). Column layout tested here is confirmed
// against a REAL 6,988-row export inspected on 2026-09-16 — see that file's
// header comment. Builds tiny synthetic workbooks in memory (never touches
// the real exported file) and real throwaway DB rows, cleaned up after.
//   node src/scripts/easyOrdersImportTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ExcelJS from 'exceljs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { parseExportBuffer, startImport, getImportJob } = await imp('../services/easyOrdersImport.js');
const { prisma } = await imp('../prisma.js');

// Builds a workbook with the SAME 30-column layout as the real export
// (columns not listed default to null, exactly like a real file's unused
// columns) — one header row + the given data rows, each a {col: value} map.
async function buildWorkbook(dataRows) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Sheet1');
  const HEADER = [null, 'ID', 'Status', 'FullName', 'Phone', 'City', 'Address', 'Total Cost', 'Product Cost', 'Shipping Cost', 'Coupon', 'Coupon Discount', 'Product Name', 'Variant', 'Quantity', 'SKU', 'Item Price', 'CreatedAt', 'Extra Data', 'Extra Data2', 'Alt Phone', 'Note', 'Ref', 'Utm Source', 'Utm Campaign', 'Payment Method', 'Payment Status', 'Funnel ID', 'Order ID', 'Referral Code', 'External Order ID'];
  sheet.addRow(HEADER);
  for (const r of dataRows) {
    // sheet.addRow(plainArray) is 0-indexed (arr[0] -> column A), UNLIKE
    // row.values/getCell()'s 1-indexed convention every COL.* constant
    // uses — so column N's value goes at arr[N-1], not arr[N].
    const arr = new Array(30).fill(null);
    for (const [col, val] of Object.entries(r)) arr[Number(col) - 1] = val;
    sheet.addRow(arr);
  }
  return wb.xlsx.writeBuffer();
}

const COL = { ID: 1, STATUS: 2, FULL_NAME: 3, PHONE: 4, CITY: 5, ADDRESS: 6, TOTAL_COST: 7, PRODUCT_COST: 8, SHIPPING_COST: 9, PRODUCT_NAME: 12, QUANTITY: 14, SKU: 15, ITEM_PRICE: 16, CREATED_AT: 17, PAYMENT_METHOD: 25, ORDER_ID: 28 };

console.log('§1 parseExportBuffer — real column mapping + the in_delivery correction:');
{
  const tag = `__test_parse_${Date.now()}__`;
  const buf = await buildWorkbook([
    { [COL.ID]: 111, [COL.STATUS]: 'pending', [COL.FULL_NAME]: 'أحمد علي', [COL.PHONE]: '01012345678', [COL.CITY]: 'قاهره', [COL.ADDRESS]: 'شارع كذا', [COL.TOTAL_COST]: 1059, [COL.PRODUCT_COST]: 999, [COL.SHIPPING_COST]: 60, [COL.PRODUCT_NAME]: `${tag}_product`, [COL.QUANTITY]: '2', [COL.SKU]: '', [COL.CREATED_AT]: '2026-09-10T10:00:00.000Z', [COL.PAYMENT_METHOD]: 'cod', [COL.ORDER_ID]: `${tag}_A` },
    { [COL.ID]: 112, [COL.STATUS]: 'in_delivery', [COL.FULL_NAME]: 'سارة محمد', [COL.PHONE]: '01098765432', [COL.CITY]: 'الجيزة', [COL.ADDRESS]: 'شارع تاني', [COL.TOTAL_COST]: 500, [COL.PRODUCT_COST]: 450, [COL.SHIPPING_COST]: 50, [COL.PRODUCT_NAME]: `${tag}_product`, [COL.QUANTITY]: '1', [COL.SKU]: '', [COL.CREATED_AT]: '2026-09-11T10:00:00.000Z', [COL.PAYMENT_METHOD]: 'cod', [COL.ORDER_ID]: `${tag}_B` },
    { [COL.ID]: 113, [COL.STATUS]: 'pending', [COL.FULL_NAME]: 'بدون رقم أوردر' }, // no Order ID at all -> must be skipped, not crash
  ]);

  const { rows, skipped } = await parseExportBuffer(buf);
  ok('two valid rows parsed', rows.length === 2, String(rows.length));
  ok('the row missing an Order ID is skipped with a real reason, not silently dropped', skipped.length === 1 && skipped[0].reason.includes('Order ID'));

  const a = rows.find((r) => r.id === `${tag}_A`);
  ok('Order ID (UUID) maps to order.id', !!a);
  ok('Product Cost column maps to order.cost (not Total Cost)', a.cost === 999, String(a.cost));
  ok('Shipping Cost maps straight across', a.shipping_cost === 60);
  ok('Total Cost maps to order.total_cost', a.total_cost === 1059);
  ok('City maps to government verbatim (normalization happens at read time elsewhere, not here)', a.government === 'قاهره');
  ok('quantity is a real number, string "2" parsed correctly', a.cart_items[0].quantity === 2);
  ok('product name carried through to the synthetic cart item', a.cart_items[0].product.name === `${tag}_product`);

  const b = rows.find((r) => r.id === `${tag}_B`);
  ok('"in_delivery" is corrected to "confirmed" — never left to fall into normalizeStatus()\'s generic .includes("deliver") DELIVERED match', b.status === 'confirmed', b.status);
}

console.log('\n§2 Real DB — startImport() end-to-end via a tiny synthetic file (real throwaway rows, cleaned up):');
{
  const tag = `__test_import_e2e_${Date.now()}__`;
  const buf = await buildWorkbook([
    { [COL.ID]: 201, [COL.STATUS]: 'pending', [COL.FULL_NAME]: tag, [COL.PHONE]: '01011122233', [COL.CITY]: 'المنيا', [COL.ADDRESS]: 'x', [COL.TOTAL_COST]: 200, [COL.PRODUCT_COST]: 180, [COL.SHIPPING_COST]: 20, [COL.PRODUCT_NAME]: tag, [COL.QUANTITY]: '1', [COL.SKU]: '', [COL.CREATED_AT]: '2026-09-12T10:00:00.000Z', [COL.PAYMENT_METHOD]: 'cod', [COL.ORDER_ID]: `${tag}_1` },
    { [COL.ID]: 202, [COL.STATUS]: 'canceled', [COL.FULL_NAME]: tag, [COL.PHONE]: '01099988877', [COL.CITY]: 'أسيوط', [COL.ADDRESS]: 'y', [COL.TOTAL_COST]: 300, [COL.PRODUCT_COST]: 280, [COL.SHIPPING_COST]: 20, [COL.PRODUCT_NAME]: tag, [COL.QUANTITY]: '3', [COL.SKU]: '', [COL.CREATED_AT]: '2026-09-13T10:00:00.000Z', [COL.PAYMENT_METHOD]: 'cod', [COL.ORDER_ID]: `${tag}_2` },
  ]);

  try {
    const started = await startImport({ buffer: Buffer.from(buf), storeId: 'default', userId: null });
    ok('startImport reports the real row count immediately (parsing is synchronous before the job starts)', started.totalRows === 2, String(started.totalRows));

    let job = getImportJob(started.jobId);
    let waited = 0;
    while (job.status === 'RUNNING' && waited < 10000) { await sleep(100); waited += 100; job = getImportJob(started.jobId); }

    ok('job finishes (not stuck RUNNING) within a few seconds for 2 rows', job.status === 'DONE', job.status);
    ok('both rows imported with zero failures', job.imported === 2 && job.failed === 0, JSON.stringify(job));

    const dbRows = await prisma.easyOrdersOrder.findMany({ where: { order_id: { in: [`${tag}_1`, `${tag}_2`] } } });
    ok('both real EasyOrdersOrder rows actually exist now', dbRows.length === 2);
    const row1 = dbRows.find((r) => r.order_id === `${tag}_1`);
    ok('row1 status PENDING, order_cost from Product Cost column (180, not the 200 Total Cost)', row1.status === 'PENDING' && row1.order_cost === 180, JSON.stringify({ status: row1.status, order_cost: row1.order_cost }));
    const row2 = dbRows.find((r) => r.order_id === `${tag}_2`);
    ok('"canceled" (single L) correctly normalizes to CANCELLED', row2.status === 'CANCELLED');
    ok('customer_id got linked automatically (same pipeline as a live webhook order)', row1.customer_id != null && row2.customer_id != null);

    // Idempotency — re-running the exact same file must never create a second row per order.
    const started2 = await startImport({ buffer: Buffer.from(buf), storeId: 'default', userId: null });
    let job2 = getImportJob(started2.jobId);
    waited = 0;
    while (job2.status === 'RUNNING' && waited < 10000) { await sleep(100); waited += 100; job2 = getImportJob(started2.jobId); }
    const dbRowsAfterRerun = await prisma.easyOrdersOrder.findMany({ where: { order_id: { in: [`${tag}_1`, `${tag}_2`] } } });
    ok('re-importing the exact same file is idempotent — still exactly 2 rows, never 4', dbRowsAfterRerun.length === 2, String(dbRowsAfterRerun.length));

    const customerIds = dbRows.map((r) => r.customer_id).filter(Boolean);
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  } finally {
    await prisma.easyOrdersOrder.deleteMany({ where: { order_id: { in: [`${tag}_1`, `${tag}_2`] } } });
  }
}

console.log('\n§3 Historical created_at preservation (real DB, does not break live-webhook default):');
{
  const tag = `__test_createdat_${Date.now()}__`;
  const historicalIso = '2020-03-15T08:30:00.000Z';
  const buf = await buildWorkbook([
    { [COL.ID]: 301, [COL.STATUS]: 'pending', [COL.FULL_NAME]: tag, [COL.PHONE]: '01055566677', [COL.CITY]: 'قنا', [COL.ADDRESS]: 'z', [COL.TOTAL_COST]: 400, [COL.PRODUCT_COST]: 380, [COL.SHIPPING_COST]: 20, [COL.PRODUCT_NAME]: tag, [COL.QUANTITY]: '1', [COL.SKU]: '', [COL.CREATED_AT]: historicalIso, [COL.PAYMENT_METHOD]: 'cod', [COL.ORDER_ID]: `${tag}_1` },
  ]);
  try {
    const started = await startImport({ buffer: Buffer.from(buf), storeId: 'default', userId: null });
    let job = getImportJob(started.jobId);
    let waited = 0;
    while (job.status === 'RUNNING' && waited < 10000) { await sleep(100); waited += 100; job = getImportJob(started.jobId); }
    ok('import job finished', job.status === 'DONE', job.status);

    const row = await prisma.easyOrdersOrder.findFirst({ where: { order_id: `${tag}_1` } });
    ok('imported row exists', !!row);
    ok('created_at preserves the historical Excel CreatedAt, not import time', row.created_at.toISOString() === historicalIso, row.created_at.toISOString());
    ok('date field (day-level) still derived correctly from the same historical timestamp', row.date === '2020-03-15', row.date);

    // Live-webhook path (no createdAt option passed) must be unaffected — still defaults to "now".
    const { ingestOrder } = await imp('../services/easyOrders.js');
    const liveTag = `${tag}_live`;
    const before = Date.now();
    await ingestOrder({ id: liveTag, status: 'pending', full_name: tag, phone: '01066677788', government: 'قاهره', cost: 100, cart_items: [{ id: 'x', quantity: 1, product: { sku: null, name: tag, id: null } }] }, 'default');
    const liveRow = await prisma.easyOrdersOrder.findFirst({ where: { order_id: liveTag } });
    ok('a live-style ingestOrder() call with no createdAt option keeps defaulting to real insertion time (webhook behavior unchanged)', liveRow.created_at.getTime() >= before - 1000, liveRow.created_at.toISOString());
    await prisma.easyOrdersOrder.deleteMany({ where: { order_id: liveTag } });
    if (liveRow.customer_id) await prisma.customer.deleteMany({ where: { id: liveRow.customer_id } });

    if (row.customer_id) await prisma.customer.deleteMany({ where: { id: row.customer_id } });
  } finally {
    await prisma.easyOrdersOrder.deleteMany({ where: { order_id: `${tag}_1` } });
  }
}

console.log('\n§4 Multi-item Excel rows — safe splitting, never guessing:');
{
  const tag = `__test_multiitem_${Date.now()}__`;
  // A real-shaped multi-item row: 2 products, aligned quantity/sku/price lines, sum matches Product Cost (1*100 + 2*50 = 200).
  const bufOk = await buildWorkbook([
    { [COL.ID]: 401, [COL.STATUS]: 'pending', [COL.FULL_NAME]: tag, [COL.PHONE]: '01011223344', [COL.CITY]: 'جيزة', [COL.ADDRESS]: 'a', [COL.TOTAL_COST]: 220, [COL.PRODUCT_COST]: 200, [COL.SHIPPING_COST]: 20, [COL.PRODUCT_NAME]: `${tag}_A\n${tag}_B`, [COL.QUANTITY]: '1\n2', [COL.SKU]: '\n', [COL.ITEM_PRICE]: '100\n50', [COL.CREATED_AT]: '2026-09-14T09:00:00.000Z', [COL.PAYMENT_METHOD]: 'cod', [COL.ORDER_ID]: `${tag}_ok` },
  ]);
  const { rows: okRows } = await parseExportBuffer(bufOk);
  const okRow = okRows.find((r) => r.id === `${tag}_ok`);
  ok('well-formed multi-item row splits into 2 real cart items', okRow.cart_items.length === 2, String(okRow.cart_items?.length));
  ok('item 1 gets its own name/quantity', okRow.cart_items[0].product.name === `${tag}_A` && okRow.cart_items[0].quantity === 1);
  ok('item 2 gets its own name/quantity', okRow.cart_items[1].product.name === `${tag}_B` && okRow.cart_items[1].quantity === 2);
  ok('the two synthetic cart-item ids are distinct (so both survive the order_id+cart_item_id upsert, not overwrite each other)', okRow.cart_items[0].id !== okRow.cart_items[1].id);

  try {
    const started = await startImport({ buffer: Buffer.from(bufOk), storeId: 'trendy-storeee', userId: null });
    let job = getImportJob(started.jobId);
    let waited = 0;
    while (job.status === 'RUNNING' && waited < 10000) { await sleep(100); waited += 100; job = getImportJob(started.jobId); }
    const dbRows = await prisma.easyOrdersOrder.findMany({ where: { order_id: `${tag}_ok` } });
    ok('real DB: one multi-item order produces 2 distinct rows, not 1 concatenated fake product', dbRows.length === 2, String(dbRows.length));
    ok('neither row carries the old-style concatenated "name\\nname" fake product', dbRows.every((r) => !r.product_name_raw.includes('\n')));
    const customerIds = dbRows.map((r) => r.customer_id).filter(Boolean);
    if (customerIds.length) await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  } finally {
    await prisma.easyOrdersOrder.deleteMany({ where: { order_id: `${tag}_ok` } });
  }

  // Ambiguous case: quantity/sku/price don't align with the product-name line count -> must NOT guess a split.
  const bufAmbiguous = await buildWorkbook([
    { [COL.ID]: 402, [COL.STATUS]: 'pending', [COL.FULL_NAME]: tag, [COL.PHONE]: '01099887766', [COL.CITY]: 'اسيوط', [COL.ADDRESS]: 'b', [COL.TOTAL_COST]: 220, [COL.PRODUCT_COST]: 200, [COL.SHIPPING_COST]: 20, [COL.PRODUCT_NAME]: `${tag}_C\n${tag}_D`, [COL.QUANTITY]: '1', [COL.SKU]: '', [COL.ITEM_PRICE]: '200', [COL.CREATED_AT]: '2026-09-14T09:00:00.000Z', [COL.PAYMENT_METHOD]: 'cod', [COL.ORDER_ID]: `${tag}_ambiguous` },
  ]);
  const { rows: ambRows } = await parseExportBuffer(bufAmbiguous);
  const ambRow = ambRows.find((r) => r.id === `${tag}_ambiguous`);
  ok('misaligned quantity/sku/price lines -> falls back to a single ambiguous item, never guesses a split', ambRow.cart_items.length === 1 && ambRow.cart_items[0].product.name === `${tag}_C\n${tag}_D`);

  // Sum mismatch case: aligned line counts, but quantity*price doesn't add up to Product Cost -> must NOT guess.
  const bufSumMismatch = await buildWorkbook([
    { [COL.ID]: 403, [COL.STATUS]: 'pending', [COL.FULL_NAME]: tag, [COL.PHONE]: '01099887755', [COL.CITY]: 'اسيوط', [COL.ADDRESS]: 'c', [COL.TOTAL_COST]: 220, [COL.PRODUCT_COST]: 999, [COL.SHIPPING_COST]: 20, [COL.PRODUCT_NAME]: `${tag}_E\n${tag}_F`, [COL.QUANTITY]: '1\n1', [COL.SKU]: '\n', [COL.ITEM_PRICE]: '100\n50', [COL.CREATED_AT]: '2026-09-14T09:00:00.000Z', [COL.PAYMENT_METHOD]: 'cod', [COL.ORDER_ID]: `${tag}_summismatch` },
  ]);
  const { rows: sumRows } = await parseExportBuffer(bufSumMismatch);
  const sumRow = sumRows.find((r) => r.id === `${tag}_summismatch`);
  ok('aligned lines but quantity*price sum does not match Product Cost -> falls back, never guesses', sumRow.cart_items.length === 1 && sumRow.cart_items[0].product.name === `${tag}_E\n${tag}_F`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
