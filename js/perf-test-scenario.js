// perf-test-scenario.js — a small, fixed 5-product test scenario for the
// 📊 "مقارنة أداء المنتجات" dashboard section, exactly matching the
// yesterday/today numbers from the feature request's own worked example
// (Water Flosser 9→5, etc.). These 5 names don't exist in the real 127-
// product catalog, so — same no-fabrication rule as everywhere else in
// this app — they are created as their OWN clearly-marked demo products
// (is_demo: true) rather than guess-mapped onto a real product. Re-running
// this loader is idempotent (find-or-create by name, then overwrite just
// these 5 products' own order history) and never touches any other
// product's data, real or demo.
import { Products, DailyOrders, Settings } from './db.js';
import { addDays, todayStr } from './analytics.js';

// [name, yesterday, today] — the exact 5 sample rows from the request.
const SCENARIO = [
  ['Water Flosser / Dental Cleaning Device', 9, 5],
  ['Face Sculpting Device', 12, 16],
  ['Hidden Camera & Spy Detector', 7, 7],
  ['Electric Toothbrush', 4, 2],
  ['Facial Hair Remover', 3, 9],
];

function datesEndingToday(today) {
  return Array.from({ length: 7 }, (_, i) => addDays(today, -(6 - i)));
}

/** 6 days climbing steadily up to `yesterday`, then a jump to `today` — gives the trend engine a real uptrend to detect. */
function risingValues(yesterday, today) {
  const lead = [5, 4, 3, 2, 1, 0].map((back) => Math.max(0, yesterday - back));
  return [...lead, today];
}

/** 5 days flat at a higher baseline, easing down to `yesterday`, then `today` — a real downtrend. */
function decliningValues(yesterday, today) {
  const lead = Array(5).fill(yesterday + 2).concat([yesterday]);
  return [...lead, today];
}

/** Flat at the same level every day — a genuinely stable product (Hidden Camera: 7 → 7). */
function stableValues(yesterday) {
  return Array(7).fill(yesterday);
}

function buildValues(yesterday, today) {
  if (today === yesterday) return stableValues(yesterday);
  return today > yesterday ? risingValues(yesterday, today) : decliningValues(yesterday, today);
}

export async function loadPerfTestScenario() {
  const today = todayStr();
  const dates = datesEndingToday(today);
  const existing = await Products.all();

  let ordersWritten = 0;
  for (const [name, yesterday, todayVal] of SCENARIO) {
    let product = existing.find((p) => p.product_name.trim().toLowerCase() === name.toLowerCase());
    if (!product) {
      product = await Products.create({ product_name: name, is_demo: true, category: 'Other' });
    }
    const values = buildValues(yesterday, todayVal);
    for (let i = 0; i < dates.length; i++) {
      await DailyOrders.upsert({ product_id: product.id, date: dates[i], orders_count: values[i], is_demo: true, source: 'demo' });
      ordersWritten++;
    }
  }

  await Settings.save({ lastDemoGeneratedDate: today });
  return { productsLoaded: SCENARIO.length, ordersWritten, date: today };
}
