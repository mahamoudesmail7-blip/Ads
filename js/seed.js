// seed.js — Demo data generator (spec section 27). 8 products over 30 days,
// deliberately covering every state the system needs to demonstrate:
// rising, stable, declining, critical, a brand-new product, a product with
// explicit zero-order days, a volatile product, and a mild-decline (WATCH)
// product.

import { Products, DailyOrders, clearAllData } from './db.js';
import { addDays, todayStr } from './analytics.js';

function datesRange(asOfDate, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(addDays(asOfDate, -i));
  return out;
}

function clampInt(n) {
  return Math.max(0, Math.round(n));
}

function rising(dates) {
  // Flat low plateau, then a recent step up that holds for several days.
  // A smooth linear ramp doesn't work here: the 7D trailing baseline lags
  // today by only ~3.5 days on average, so it rises together with today and
  // the % gap never clears the SCALE threshold. A recent plateau shift
  // (mirrors a real post-creative-refresh or post-budget-bump jump) keeps
  // the baseline mostly anchored to the old, lower normal — this is the
  // demo's SCALE CANDIDATE showcase.
  return dates.map((d, i, arr) => {
    const idxFromEnd = arr.length - 1 - i;
    const base = idxFromEnd < 6 ? 11 : 5;
    return { date: d, orders_count: clampInt(base + (Math.random() - 0.5) * 1.0) };
  });
}

function stable(dates) {
  return dates.map((d, i) => {
    if (i === Math.floor(dates.length / 2)) return null; // one deliberate "No Data" day
    return { date: d, orders_count: clampInt(6 + (Math.random() - 0.5) * 2) };
  }).filter(Boolean);
}

function declining(dates) {
  return dates.map((d, i) => ({
    date: d,
    orders_count: clampInt(10 - (i / dates.length) * 6 + (Math.random() - 0.5) * 1.2),
  }));
}

function critical(dates) {
  return dates.map((d, i) => {
    const idxFromEnd = dates.length - 1 - i;
    const val = idxFromEnd < 5 ? 1 + Math.round(Math.random()) : 8 + (Math.random() - 0.5) * 2;
    return { date: d, orders_count: clampInt(val) };
  });
}

function newProduct(dates) {
  return dates.slice(-4).map((d) => ({ date: d, orders_count: clampInt(2 + Math.random() * 3) }));
}

function zeroOrderDays(dates) {
  return dates.map((d, i) => {
    if (i % 6 === 0) return { date: d, orders_count: 0 };
    return { date: d, orders_count: clampInt(3 + (Math.random() - 0.5) * 2) };
  });
}

function volatile(dates) {
  return dates.map((d) => ({ date: d, orders_count: clampInt(3 + Math.random() * 9) }));
}

function watch(dates) {
  // Mild, steady decline with a short trailing decline streak — enough to
  // trigger WATCH (via declineStreak/status DOWN) without being CRITICAL.
  return dates.map((d, i, arr) => {
    const idxFromEnd = arr.length - 1 - i;
    if (idxFromEnd < 3) return { date: d, orders_count: clampInt(7 - idxFromEnd * 1.1) };
    return { date: d, orders_count: clampInt(9 - (i / dates.length) * 2 + (Math.random() - 0.5) * 1.2) };
  });
}

const PRODUCT_DEFS = [
  { product_name: 'جهاز نحت الوجه', sku: 'FACE-SCLPT-01', selling_price: 899, product_cost: 220, gen: rising, shipping_cost: 50, packaging_cost: 15, other_cost: 10, expected_return_cost: 20, commission: 15, advertising_cost: 230, current_stock: 80, minimum_stock: 20, supplier: 'مورد أ', restock_quantity: 100 },
  { product_name: 'سماعة بلوتوث X', sku: 'BT-SPK-X', selling_price: 450, product_cost: 150, gen: stable, shipping_cost: 35, packaging_cost: 10, other_cost: 8, expected_return_cost: 12, commission: 10, advertising_cost: 130, current_stock: 120, minimum_stock: 25, supplier: 'مورد ب', restock_quantity: 150 },
  { product_name: 'ساعة ذكية برو', sku: 'SW-PRO-02', selling_price: 1200, product_cost: 400, gen: declining, shipping_cost: 60, packaging_cost: 20, other_cost: 15, expected_return_cost: 35, commission: 25, advertising_cost: 420, current_stock: 30, minimum_stock: 15, supplier: 'مورد ج', restock_quantity: 60 },
  { product_name: 'شاحن لاسلكي سريع', sku: 'WL-CHRG-FST', selling_price: 350, product_cost: 90, gen: critical, shipping_cost: 30, packaging_cost: 8, other_cost: 6, expected_return_cost: 10, commission: 8, advertising_cost: 220, current_stock: 15, minimum_stock: 20, supplier: 'مورد د', restock_quantity: 80 },
  { product_name: 'عطر رجالي فاخر', sku: 'PERF-MEN-LX', selling_price: 650, product_cost: 180, gen: newProduct, shipping_cost: 40, packaging_cost: 25, other_cost: 10, expected_return_cost: 15, commission: 12, advertising_cost: 150, current_stock: 90, minimum_stock: 20, supplier: 'مورد أ', restock_quantity: 100 },
  { product_name: 'حزام تنحيف كهربائي', sku: 'SLIM-BELT-EL', selling_price: 780, product_cost: 210, gen: zeroOrderDays, shipping_cost: 55, packaging_cost: 18, other_cost: 12, expected_return_cost: 25, commission: 16, advertising_cost: 240, current_stock: 40, minimum_stock: 15, supplier: 'مورد ب', restock_quantity: 70 },
  { product_name: 'نظارة شمس بولارايز', sku: 'SUN-POLAR-03', selling_price: 299, product_cost: 70, gen: volatile, shipping_cost: 25, packaging_cost: 8, other_cost: 5, expected_return_cost: 8, commission: 6, advertising_cost: 100, current_stock: 200, minimum_stock: 40, supplier: 'مورد ج', restock_quantity: 200 },
  { product_name: 'مكواة شعر تيتانيوم', sku: 'HAIR-IRON-TI', selling_price: 540, product_cost: 160, gen: watch, shipping_cost: 38, packaging_cost: 12, other_cost: 8, expected_return_cost: 15, commission: 10, advertising_cost: 190, current_stock: 25, minimum_stock: 15, supplier: 'مورد د', restock_quantity: 80 },
];

/**
 * @param {boolean} force if true, wipes ALL existing data first (products, orders, settings).
 * If false, only seeds when the database currently has zero products.
 */
export async function seedDemoData(force = false) {
  const existing = await Products.all();
  if (!force && existing.length > 0) {
    return { seeded: false, reason: 'DATA_EXISTS' };
  }
  if (force) {
    await clearAllData();
  }

  const asOfDate = todayStr();
  const dates = datesRange(asOfDate, 30);

  let productsCreated = 0;
  let ordersCreated = 0;

  for (const def of PRODUCT_DEFS) {
    const product = await Products.create({
      product_name: def.product_name,
      sku: def.sku,
      selling_price: def.selling_price,
      product_cost: def.product_cost,
      shipping_cost: def.shipping_cost,
      packaging_cost: def.packaging_cost,
      other_cost: def.other_cost,
      expected_return_cost: def.expected_return_cost,
      commission: def.commission,
      advertising_cost: def.advertising_cost,
      current_stock: def.current_stock,
      minimum_stock: def.minimum_stock,
      supplier: def.supplier,
      restock_quantity: def.restock_quantity,
      active: true,
      is_demo: true,
    });
    productsCreated++;

    const series = def.gen(dates);
    for (const point of series) {
      await DailyOrders.upsert({
        product_id: product.id,
        date: point.date,
        orders_count: point.orders_count,
      });
      ordersCreated++;
    }
  }

  return { seeded: true, productsCreated, ordersCreated };
}

// ---------------------------------------------------------------------------
// Downturn QA scenario — deterministic, hand-specified test data (not
// random) covering exactly 7 days ending today, designed to exercise:
// negative Daily Change, DOWN/CRITICAL status, Downtrend detection, low
// Health Score, EXIT Candidate (sustained decline, not a single bad day),
// explicit-zero handling, and No-Data handling. Every array below is
// oldest-first, index[6] = today.
//
// This is TEST data only — no connection to any real order source
// (EasyOrders or otherwise). It is tagged is_demo=true like the general
// seedDemoData() products above, so "Clear Demo Data" in Settings removes
// it (and only it) without touching anything the user entered by hand.
// ---------------------------------------------------------------------------

// Each product also carries V2 Profit Engine + Inventory fields so "Load
// Demo Data" immediately showcases Break-even CPA, Profit/Order, and Stock
// Alerts too — not just order counts. `values` (order history) is
// unchanged from V1 so every previously-verified Daily Change / 7D Avg /
// Trend / Status number stays exactly the same.
const DOWNTURN_PRODUCT_DEFS = [
  {
    product_name: 'جهاز نحت الوجه',
    sku: 'QA-DOWN-01',
    values: [5, 6, 6, 7, 8, 8, 7],
    selling_price: 899, product_cost: 220, shipping_cost: 50, packaging_cost: 15, other_cost: 10, expected_return_cost: 20, commission: 15, advertising_cost: 250,
    current_stock: 45, minimum_stock: 20, supplier: 'مورد أ', restock_quantity: 100,
  },
  {
    product_name: 'جهاز تنظيف الأذن',
    sku: 'QA-DOWN-02',
    values: [10, 9, 10, 9, 10, 10, 7],
    selling_price: 450, product_cost: 150, shipping_cost: 40, packaging_cost: 10, other_cost: 10, expected_return_cost: 15, commission: 10, advertising_cost: 190,
    current_stock: 100, minimum_stock: 15, supplier: 'مورد ب', restock_quantity: 150,
  },
  {
    product_name: 'جهاز كشف الكاميرات',
    sku: 'QA-DOWN-03',
    values: [8, 8, 7, 7, 7, 7, 5],
    // CPA above break-even on purpose — this product is a losing-money demo (WATCH -> FIX override).
    selling_price: 650, product_cost: 300, shipping_cost: 45, packaging_cost: 15, other_cost: 10, expected_return_cost: 20, commission: 12, advertising_cost: 280,
    current_stock: 60, minimum_stock: 20, supplier: 'مورد ج', restock_quantity: 80,
  },
  {
    product_name: 'جهاز هايفور',
    sku: 'QA-DOWN-04',
    values: [8, 7, 7, 6, 6, 6, 4],
    selling_price: 1200, product_cost: 500, shipping_cost: 60, packaging_cost: 20, other_cost: 15, expected_return_cost: 30, commission: 25, advertising_cost: 300,
    // Deliberately low stock relative to its sales rate -> CRITICAL / RESTOCK demo.
    current_stock: 8, minimum_stock: 10, supplier: 'مورد د', restock_quantity: 60,
  },
  {
    product_name: 'جهاز إزالة شعر الوجه',
    sku: 'QA-DOWN-05',
    values: [9, 8, 7, 6, 5, 5, 2],
    selling_price: 780, product_cost: 280, shipping_cost: 55, packaging_cost: 18, other_cost: 12, expected_return_cost: 25, commission: 18, advertising_cost: 420,
    current_stock: 50, minimum_stock: 15, supplier: 'مورد أ', restock_quantity: 90,
  },
  {
    product_name: 'منتج اختبار الخروج',
    sku: 'QA-DOWN-06',
    values: [10, 9, 8, 7, 6, 5, 3],
    selling_price: 550, product_cost: 200, shipping_cost: 40, packaging_cost: 12, other_cost: 10, expected_return_cost: 20, commission: 12, advertising_cost: 310,
    current_stock: 15, minimum_stock: 10, supplier: 'مورد ب', restock_quantity: 60,
  },
  {
    product_name: 'منتج اختبار الصفر',
    sku: 'QA-DOWN-07',
    values: [5, 5, 4, 3, 2, 0, 0], // explicit zeros (yesterday & today)
    selling_price: 400, product_cost: 150, shipping_cost: 30, packaging_cost: 10, other_cost: 8, expected_return_cost: 15, commission: 10, advertising_cost: 150,
    current_stock: 25, minimum_stock: 10, supplier: 'مورد ج', restock_quantity: 50,
  },
  {
    product_name: 'منتج بدون بيانات',
    sku: 'QA-DOWN-08',
    values: [], // NO daily_orders rows at all — proves No Data is never coerced to 0
    // Stock IS tracked here on purpose: with zero order history, days-of-stock
    // must come out NO_DATA (can't project a daily rate from nothing) even
    // though current_stock itself is a real number — a distinct edge case
    // from "stock not tracked at all".
    selling_price: 500, product_cost: 150,
    current_stock: 40, minimum_stock: 10, supplier: 'مورد د', restock_quantity: 70,
  },
  {
    // Genuinely rising: last 5 available points strictly increasing ->
    // Strong Uptrend, and clearly above its own (pre-rise) baseline ->
    // STRONG_GROWTH daily status. Showcases spec section 19-20.
    product_name: 'منتج صاعد بقوة',
    sku: 'QA-DOWN-09',
    values: [3, 4, 5, 6, 7, 8, 10],
    selling_price: 620, product_cost: 210, shipping_cost: 35, packaging_cost: 10, other_cost: 8, expected_return_cost: 12, commission: 10, advertising_cost: 180,
    current_stock: 70, minimum_stock: 20, supplier: 'مورد أ', restock_quantity: 100,
  },
  {
    // Perfectly flat: a clean STABLE showcase distinct from every other
    // scenario above, which are all some flavor of decline or growth.
    product_name: 'منتج مستقر تمامًا',
    sku: 'QA-DOWN-10',
    values: [6, 6, 6, 6, 6, 6, 6],
    selling_price: 450, product_cost: 160, shipping_cost: 30, packaging_cost: 10, other_cost: 8, expected_return_cost: 10, commission: 8, advertising_cost: 140,
    current_stock: 60, minimum_stock: 15, supplier: 'مورد ب', restock_quantity: 80,
  },
];

/**
 * Idempotent by design, not by wipe-and-recreate: each product is looked up
 * by its fixed SKU (unique index) and reused if it already exists, so
 * product IDs — and any bookmarked Product Details links — stay stable
 * across repeated runs. For each product, its existing order history is
 * cleared and rewritten fresh from `values` before every run. That's
 * necessary (not just cosmetic) because "last 7 days ending today" is a
 * moving window: if this runs again on a later date, a plain upsert alone
 * would leave the previous run's now-stale date sitting outside the new
 * window, and — worse — a date both runs' windows cover would silently get
 * overwritten with the WRONG value (the array is aligned to whichever
 * 7-day window is current, so the same calendar date can land at a
 * different array index between runs). Clearing this product's rows first
 * avoids both problems. Running it twice in the same session, same day,
 * therefore produces byte-for-byte the same records — never growing.
 */
export async function seedDownturnScenario() {
  const asOfDate = todayStr();
  const dates = datesRange(asOfDate, 7);

  let productsCreated = 0;
  let productsReused = 0;
  let ordersWritten = 0;

  for (const def of DOWNTURN_PRODUCT_DEFS) {
    const productFields = {
      product_name: def.product_name,
      sku: def.sku,
      selling_price: def.selling_price,
      product_cost: def.product_cost,
      shipping_cost: def.shipping_cost ?? null,
      packaging_cost: def.packaging_cost ?? null,
      other_cost: def.other_cost ?? null,
      expected_return_cost: def.expected_return_cost ?? null,
      commission: def.commission ?? null,
      advertising_cost: def.advertising_cost ?? null,
      current_stock: def.current_stock ?? null,
      minimum_stock: def.minimum_stock ?? null,
      supplier: def.supplier ?? null,
      restock_quantity: def.restock_quantity ?? null,
      active: true,
      is_demo: true,
    };

    let product = await Products.findBySku(def.sku);
    if (product) {
      // Keep an already-existing demo product's financial/inventory fields
      // in sync with the current definition (e.g. if this scenario was
      // seeded before V2's Profit/Inventory fields existed).
      product = await Products.update(product.id, productFields);
      productsReused++;
    } else {
      product = await Products.create(productFields);
      productsCreated++;
    }

    // Wipe this product's own order history before rewriting it fresh —
    // see the function doc comment for why this is required for
    // correctness across day-rollovers, not just a "reset" nicety.
    const existing = await DailyOrders.forProduct(product.id);
    for (const row of existing) await DailyOrders.remove(row.id);

    for (let i = 0; i < dates.length; i++) {
      const value = def.values[i];
      if (value === null || value === undefined) continue; // leave as No Data
      await DailyOrders.upsert({ product_id: product.id, date: dates[i], orders_count: value });
      ordersWritten++;
    }
  }

  return { seeded: true, productsCreated, productsReused, ordersWritten };
}

// ---------------------------------------------------------------------------
// Decision Center scenario — deterministic, hand-specified data (products
// A-J) built specifically to exercise every branch of the Decision Engine
// (js/decision-engine.js): all 5 suggested actions plus the "not enough
// data yet" case. Each `values` array is oldest-first, index[6] = today
// (`null` = a day with no daily_orders row at all, i.e. real "No Data").
//
// Hand-verified expected outcome per product (see decision-engine.js for
// the rules being exercised):
//   A زوّد الميزانية  — ticked up today, back at/above its normal baseline
//   B قلل الميزانية   — 2-day day-over-day decline streak (early decline)
//   C مرشح لإيقاف الحملة — explicit zero today after a real, active baseline
//   D استمر كما أنت   — perfectly flat, nothing to react to
//   E زوّد الميزانية  — 5 strictly-increasing days -> confirmed strong growth
//   F راجع فورًا      — 6-day continuous decline (not yet zero/explicit-exit)
//   G قلل الميزانية   — volatile then a 3-day decline streak
//   H مرشح لإيقاف الحملة — zero today after a weak-but-real baseline
//   I بيانات غير كافية — only 3 logged days, correctly flagged as new
//   J زوّد الميزانية  — 5 strictly-increasing days, steepest at the end
// This is TEST data only, tagged is_demo=true like every other seed here.
// ---------------------------------------------------------------------------

const DECISION_PRODUCT_DEFS = [
  {
    product_name: 'جهاز نحت الوجه الذكي', sku: 'QA-DEC-A', values: [4, 4, 3, 4, 3, 3, 5],
    selling_price: 899, product_cost: 220, shipping_cost: 50, packaging_cost: 15, other_cost: 10, expected_return_cost: 20, commission: 15, advertising_cost: 230,
    current_stock: 80, minimum_stock: 20, supplier: 'مورد أ', restock_quantity: 100,
  },
  {
    product_name: 'سماعة بلوتوث برو', sku: 'QA-DEC-B', values: [7, 8, 9, 8, 9, 8, 6],
    selling_price: 450, product_cost: 150, shipping_cost: 35, packaging_cost: 10, other_cost: 8, expected_return_cost: 12, commission: 10, advertising_cost: 130,
    current_stock: 120, minimum_stock: 25, supplier: 'مورد ب', restock_quantity: 150,
  },
  {
    product_name: 'ساعة يد رقمية', sku: 'QA-DEC-C', values: [6, 5, 6, 5, 6, 5, 0],
    selling_price: 1200, product_cost: 400, shipping_cost: 60, packaging_cost: 20, other_cost: 15, expected_return_cost: 35, commission: 25, advertising_cost: 420,
    current_stock: 30, minimum_stock: 15, supplier: 'مورد ج', restock_quantity: 60,
  },
  {
    product_name: 'شاحن لاسلكي ثابت', sku: 'QA-DEC-D', values: [10, 10, 10, 10, 10, 10, 10],
    selling_price: 350, product_cost: 90, shipping_cost: 30, packaging_cost: 8, other_cost: 6, expected_return_cost: 10, commission: 8, advertising_cost: 120,
    current_stock: 150, minimum_stock: 30, supplier: 'مورد د', restock_quantity: 150,
  },
  {
    product_name: 'عطر رجالي مميز', sku: 'QA-DEC-E', values: [1, 2, 3, 4, 5, 6, 8],
    selling_price: 650, product_cost: 180, shipping_cost: 40, packaging_cost: 25, other_cost: 10, expected_return_cost: 15, commission: 12, advertising_cost: 150,
    current_stock: 90, minimum_stock: 20, supplier: 'مورد أ', restock_quantity: 100,
  },
  {
    // Losing money on purpose (high advertising_cost relative to margin) so
    // v2.type also lands on FIX, reinforcing REVIEW_NOW from a second signal.
    product_name: 'حزام تنحيف حراري', sku: 'QA-DEC-F', values: [13, 12, 11, 10, 8, 7, 5],
    selling_price: 780, product_cost: 280, shipping_cost: 55, packaging_cost: 18, other_cost: 12, expected_return_cost: 25, commission: 16, advertising_cost: 480,
    current_stock: 40, minimum_stock: 15, supplier: 'مورد ب', restock_quantity: 70,
  },
  {
    product_name: 'نظارة شمسية متذبذبة', sku: 'QA-DEC-G', values: [10, 11, 9, 12, 10, 5, 4],
    selling_price: 299, product_cost: 70, shipping_cost: 25, packaging_cost: 8, other_cost: 5, expected_return_cost: 8, commission: 6, advertising_cost: 100,
    current_stock: 200, minimum_stock: 40, supplier: 'مورد ج', restock_quantity: 200,
  },
  {
    product_name: 'مكواة شعر صغيرة', sku: 'QA-DEC-H', values: [3, 2, 1, 0, 0, 1, 0],
    selling_price: 540, product_cost: 160, shipping_cost: 38, packaging_cost: 12, other_cost: 8, expected_return_cost: 15, commission: 10, advertising_cost: 190,
    current_stock: 25, minimum_stock: 15, supplier: 'مورد د', restock_quantity: 80,
  },
  {
    product_name: 'جهاز تدليك جديد', sku: 'QA-DEC-I', values: [null, null, null, null, 2, 3, 2],
    selling_price: 620, product_cost: 200, shipping_cost: 35, packaging_cost: 10, other_cost: 8, expected_return_cost: 12, commission: 10, advertising_cost: 160,
    current_stock: 60, minimum_stock: 20, supplier: 'مورد أ', restock_quantity: 90,
  },
  {
    product_name: 'كريم العناية بالبشرة', sku: 'QA-DEC-J', values: [4, 5, 6, 7, 8, 9, 12],
    selling_price: 480, product_cost: 130, shipping_cost: 28, packaging_cost: 9, other_cost: 6, expected_return_cost: 10, commission: 8, advertising_cost: 110,
    current_stock: 110, minimum_stock: 25, supplier: 'مورد ب', restock_quantity: 120,
  },
];

/** Same idempotent find-by-SKU + rewrite-order-history pattern as seedDownturnScenario — see that function's doc comment for why. */
export async function seedDecisionDemo() {
  const asOfDate = todayStr();
  const dates = datesRange(asOfDate, 7);

  let productsCreated = 0;
  let productsReused = 0;
  let ordersWritten = 0;

  for (const def of DECISION_PRODUCT_DEFS) {
    const productFields = {
      product_name: def.product_name,
      sku: def.sku,
      selling_price: def.selling_price,
      product_cost: def.product_cost,
      shipping_cost: def.shipping_cost ?? null,
      packaging_cost: def.packaging_cost ?? null,
      other_cost: def.other_cost ?? null,
      expected_return_cost: def.expected_return_cost ?? null,
      commission: def.commission ?? null,
      advertising_cost: def.advertising_cost ?? null,
      current_stock: def.current_stock ?? null,
      minimum_stock: def.minimum_stock ?? null,
      supplier: def.supplier ?? null,
      restock_quantity: def.restock_quantity ?? null,
      active: true,
      is_demo: true,
    };

    let product = await Products.findBySku(def.sku);
    if (product) {
      product = await Products.update(product.id, productFields);
      productsReused++;
    } else {
      product = await Products.create(productFields);
      productsCreated++;
    }

    const existing = await DailyOrders.forProduct(product.id);
    for (const row of existing) await DailyOrders.remove(row.id);

    for (let i = 0; i < dates.length; i++) {
      const value = def.values[i];
      if (value === null || value === undefined) continue;
      await DailyOrders.upsert({ product_id: product.id, date: dates[i], orders_count: value });
      ordersWritten++;
    }
  }

  return { seeded: true, productsCreated, productsReused, ordersWritten };
}
