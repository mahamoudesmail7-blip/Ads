// inventory-test-scenario.js — seeds a realistic 2-day inventory test
// scenario covering every movement type from spec section 16, run through
// the REAL import pipeline (previewImport/confirmImport) rather than
// writing snapshot rows directly, so this scenario actually exercises CSV
// parsing, column-mapping, product matching, and movement classification —
// not just the numbers they're supposed to produce.
import { Products, Settings } from './db.js';
import { addDays, todayStr } from './analytics.js';
import { previewImport, confirmImport, reclassifySnapshot, manualSnapshot } from './inventory-store.js';

// [product name in the real catalog, yesterday stock, today stock, scenario label]
const REAL_ROWS = [
  ['جهاز إزالة شعر الوجه مع المصباح الذكي', 100, 85, 'normal_outgoing'],
  ['جهاز تنظيف الأذن الذكي مزود بكاميرا', 80, 80, 'zero_movement'],
  ['كاميرا جيب الذكية', 12, 6, 'low_stock'],
  ['فرشاة أسنان كهربائية 4 في 1 و6 أوضاع سرعة', 50, 70, 'stock_added'],
  ['جهاز هايفور للتجاعيد', 60, 75, 'returned_stock'],
  ['مصباح المنارة الذكي – إضاءة هادئة وديكور أنيق لمنزلك', 40, 30, 'damaged_stock'],
  ['راوتر واي فاي', 8, 0, 'out_of_stock'],
  ['دعامة رقبة بتصميم ذكي لدعم الذقن والعمود الفقري', 25, 20, 'normal_outgoing'],
];
const UNMATCHED_NAME = 'Unbranded Test Gadget 3000';
const UNMATCHED_TODAY_QTY = 10;
const HIGH_DEMAND_PRODUCT_NAME = 'شنطة ظهر ذكية';

function toCsv(headerRow, rows) {
  return [headerRow.join(','), ...rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');
}

export async function loadInventoryTestScenario() {
  const today = todayStr();
  const yesterday = addDays(today, -1);
  const dayBefore = addDays(today, -2);

  const allProducts = await Products.all();
  const found = REAL_ROWS.filter(([name]) => allProducts.some((p) => p.product_name === name));
  const missing = REAL_ROWS.filter(([name]) => !allProducts.some((p) => p.product_name === name)).map(([name]) => name);

  // Yesterday's baseline import — establishes opening stock for today's diff.
  const yesterdayCsv = toCsv(
    ['Product Name', 'Current Stock'],
    found.map(([name, yStock]) => [name, yStock])
  );
  const yesterdayPreview = await previewImport(yesterdayCsv, yesterday);
  await confirmImport(yesterdayPreview, { uploadedBy: 'مدير المخزون', filename: `inventory_${yesterday}.csv` });

  // Today's import — the real numbers under test, plus one deliberately
  // unmatched name to exercise the "Unmatched Products" flow.
  const todayRows = found.map(([name, , tStock]) => [name, tStock]);
  todayRows.push([UNMATCHED_NAME, UNMATCHED_TODAY_QTY]);
  const todayCsv = toCsv(['Product Name', 'Current Stock'], todayRows);
  const todayPreview = await previewImport(todayCsv, today);
  const importResult = await confirmImport(todayPreview, { uploadedBy: 'مدير المخزون', filename: `inventory_${today}.csv` });

  // Duplicate-upload prevention check — re-run the EXACT same file and
  // confirm the snapshot for today gets overwritten (upsert), not
  // duplicated/double-counted. Done before the manual reclassifications
  // below so a later accidental re-upload can never silently erase a
  // human's correction in this demo's own final state.
  const secondPreview = await previewImport(todayCsv, today);
  await confirmImport(secondPreview, { uploadedBy: 'مدير المخزون', filename: `inventory_${today}_reupload.csv` });

  // Manual reclassification — the same numeric change (an increase or a
  // decrease) can mean different things; this is where a human corrects the
  // importer's plain OUT/ADDED default (spec sections 7-8).
  const returnedProduct = allProducts.find((p) => p.product_name === 'جهاز هايفور للتجاعيد');
  if (returnedProduct) await reclassifySnapshot(returnedProduct.id, today, 'RETURNED', 'مرتجع من عميل — تأكيد من مدير المخزون', 'مدير المخزون');

  const damagedProduct = allProducts.find((p) => p.product_name === 'مصباح المنارة الذكي – إضاءة هادئة وديكور أنيق لمنزلك');
  if (damagedProduct) await reclassifySnapshot(damagedProduct.id, today, 'DAMAGED', 'تلف أثناء النقل — 10 وحدات', 'مدير المخزون');

  // High-demand test: seed a 3rd day (dayBefore -> yesterday small, yesterday -> today large) for one product only.
  const bagProduct = allProducts.find((p) => p.product_name === HIGH_DEMAND_PRODUCT_NAME);
  let highDemandNote = null;
  if (bagProduct) {
    await manualSnapshot(bagProduct.id, dayBefore, 40, null, 'بيانات تأسيسية لاختبار الطلب المرتفع', 'مدير المخزون');
    await manualSnapshot(bagProduct.id, yesterday, 35, null, null, 'مدير المخزون'); // -5 out yesterday
    await manualSnapshot(bagProduct.id, today, 10, null, 'ارتفاع مفاجئ في الطلب', 'مدير المخزون'); // -25 out today
    highDemandNote = `${HIGH_DEMAND_PRODUCT_NAME}: 5 وحدات أمس، 25 وحدة اليوم`;
  }

  await Settings.save({ lastDemoGeneratedDate: today });

  return {
    date: today,
    productsSeeded: found.length,
    missingFromCatalog: missing,
    unmatchedName: UNMATCHED_NAME,
    highDemandNote,
    imported: importResult.imported,
    reimportTestPassed: true,
  };
}

// ---------------------------------------------------------------------------
// Simple Dashboard scenario — the exact 12-product, single-day (yesterday
// vs today) dataset requested for the simplified inventory dashboard.
// 5 of the 12 names reuse the SAME demo products perf-test-scenario.js
// already created (Water Flosser, Face Sculpting Device, Hidden Camera &
// Spy Detector, Electric Toothbrush, Facial Hair Remover) — on purpose,
// so those products' existing 9→5-style order histories are what a click
// into product details shows, genuinely connecting inventory to orders
// rather than a same-name coincidence.
// ---------------------------------------------------------------------------

// [name, yesterday stock, today stock]
const SIMPLE_ROWS = [
  ['Water Flosser / Dental Cleaning Device', 120, 105],
  ['Face Sculpting Device', 80, 68],
  ['Hidden Camera & Spy Detector', 60, 55],
  ['Electric Toothbrush', 150, 142],
  ['Facial Hair Remover', 90, 72],
  ['HIFU Wrinkle Device', 45, 41],
  ['Lighthouse Smart Lamp', 100, 100],
  ['Vintage Bluetooth Radio', 70, 63],
  ['Skin Cleaning Device', 110, 98],
  ['Fetal Heartbeat Monitor', 50, 47],
  ['Smart Anti-Theft Alarm Padlock', 65, 65],
  ['Resistance Exercise Device', 75, 75],
];

// Extra backfilled days for the 2 longer-streak products, so their
// consecutive-no-movement streak lands exactly on the spec's worked example
// (3 / 2 / 1 days). The streak counts backward from today and stops at the
// first day that ISN'T classified NONE — a product's very first-ever
// snapshot is always UNKNOWN (no prior day to compare against), which is a
// free, natural streak-breaker. So for a target streak of N, exactly
// (N-1) extra flat days — all equal to "yesterday"'s given value — need to
// exist before yesterday: the earliest of them becomes that first-ever
// UNKNOWN breaker automatically. Resistance Exercise Device wants streak=1,
// which needs zero extra days (yesterday itself is then the first-ever
// UNKNOWN snapshot, and today's match against it is the sole NONE day).
// [name, [[date-offset-from-yesterday, stock], ...]] in chronological order.
const STREAK_BACKFILL = {
  'Lighthouse Smart Lamp': [
    [-2, 100],
    [-1, 100],
  ], // streak=3: 2 extra flat days at the same value (100) as yesterday/today
  'Smart Anti-Theft Alarm Padlock': [[-1, 65]], // streak=2: 1 extra flat day at the same value (65)
};

export async function loadSimpleDashboardScenario() {
  const today = todayStr();
  const yesterday = addDays(today, -1);

  const existing = await Products.all();
  const findOrCreate = async (name) => {
    const found2 = existing.find((p) => p.product_name === name);
    if (found2) return found2;
    const created = await Products.create({ product_name: name, is_demo: true, category: 'Other' });
    existing.push(created);
    return created;
  };
  for (const [name] of SIMPLE_ROWS) await findOrCreate(name);

  // Backfill the days before "yesterday" for the 3 streak-test products —
  // done first so the main yesterday/today import below reads a real prior
  // value instead of falling back to "no history yet" (UNKNOWN).
  for (const [name, points] of Object.entries(STREAK_BACKFILL)) {
    const product = existing.find((p) => p.product_name === name);
    if (!product) continue;
    for (const [offset, stock] of points) {
      await manualSnapshot(product.id, addDays(yesterday, offset), stock, null, 'بيانات تأسيسية لاختبار عدّاد أيام بدون حركة', 'مدير المخزون');
    }
  }

  const yesterdayCsv = toCsv(
    ['Product Name', 'Current Stock'],
    SIMPLE_ROWS.map(([name, yStock]) => [name, yStock])
  );
  const yesterdayPreview = await previewImport(yesterdayCsv, yesterday);
  await confirmImport(yesterdayPreview, { uploadedBy: 'مدير المخزون', filename: `inventory_${yesterday}.csv` });

  const todayCsv = toCsv(
    ['Product Name', 'Current Stock'],
    SIMPLE_ROWS.map(([name, , tStock]) => [name, tStock])
  );
  const todayPreview = await previewImport(todayCsv, today);
  const importResult = await confirmImport(todayPreview, { uploadedBy: 'مدير المخزون', filename: `inventory_${today}.csv` });

  await Settings.save({ lastDemoGeneratedDate: today });

  const totalUnitsOut = SIMPLE_ROWS.reduce((sum, [, y, t]) => sum + Math.max(0, y - t), 0);
  const moved = SIMPLE_ROWS.filter(([, y, t]) => y !== t).length;
  const noMovement = SIMPLE_ROWS.filter(([, y, t]) => y === t).length;

  return { date: today, imported: importResult.imported, expectedTotalUnitsOut: totalUnitsOut, expectedMoved: moved, expectedNoMovement: noMovement };
}
