// demo-tasks.js — generates 🧪 DEMO ORDERS on top of the REAL product
// catalog, so the whole Task system (Decision Engine + Task Engine +
// Tasks page) can be exercised end-to-end before EasyOrders exists,
// without inventing fake "Product A/B" names and without touching real
// product records at all. Every row this writes to daily_orders carries
// is_demo:true (see db.js) — real pages (Dashboard/Alerts/Compare/Ranking)
// filter these out; only the Tasks page reads them.
//
// 8 scenarios, each a hand-picked 7-day sequence (oldest-first, index 6 =
// asOfDate) chosen to deterministically land in ONE specific system state
// when run through analyzeProduct() -> classifyDailyStatus() ->
// analyzeProductDecision() -> task-engine's deriveTaskType(). Every shape
// below has been hand-verified against those exact functions — this is
// not random data dressed up as a test.
import { Products, DailyOrders, Settings } from './db.js';
import { addDays, todayStr } from './analytics.js';

// [label, values, matches] — "matches" documents the worked example this
// shape reproduces from the spec, where the spec gave concrete numbers.
const SCENARIOS = [
  { key: 'STRONG', count: 15, values: [4, 5, 6, 7, 6, 5, 10] }, // یesterday 5 -> today 10 (STRONG_GROWTH)
  { key: 'IMPROVING', count: 20, values: [4, 3, 4, 3, 4, 3, 6] }, // yesterday 3 -> today 6 (IMPROVING)
  { key: 'WEAKENING', count: 20, values: [11, 10, 10, 9, 9, 8, 5] }, // yesterday 8 -> today 5, 2-day decline streak (EARLY_DECLINE)
  { key: 'DECLINING', count: 15, values: [22, 19, 16, 13, 11, 10, 4] }, // yesterday 10 -> today 4, 6-day decline streak (SHARP_DECLINE)
  { key: 'ZERO', count: 10, values: [8, 7, 7, 6, 6, 6, 0] }, // yesterday 6 -> today 0 (STOPPED)
  { key: 'STABLE', count: 20, values: [5, 5, 5, 5, 5, 5, 5] }, // yesterday 5 -> today 5 (STABLE)
  // Erratic but today lands near its own baseline (not a real one-day
  // collapse) -> VOLATILE. The spec's own [3,8,2,7,4,9,3] example ends on
  // a genuine 9->3 one-day collapse, which this app's SHARP_DECLINE safety
  // check correctly treats as urgent regardless of the choppy history
  // before it — so a different, equally-erratic-but-not-collapsing shape
  // is used here to land on VOLATILE specifically.
  { key: 'VOLATILE', count: 12, values: [5, 7, 4, 8, 3, 6, 5] },
  { key: 'NEW', count: 15, values: [null, null, null, null, 2, 4, 3] }, // only 3 logged days (NEW/insufficient data)
];

function datesRange(asOfDate, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(addDays(asOfDate, -i));
  return out;
}

/** Proportional split of `total` real products across the 8 scenarios, preserving the spec's 15/20/20/15/10/20/12/15-out-of-127 ratios and always summing to exactly `total` (spec section 4). */
export function scaleCounts(total) {
  const base = 127;
  const raw = SCENARIOS.map((s) => (s.count / base) * total);
  const floored = raw.map(Math.floor);
  let remainder = total - floored.reduce((a, b) => a + b, 0);
  // Distribute leftover units to the scenarios with the largest fractional part first.
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k++) floored[order[k % order.length].i]++;
  return floored;
}

/**
 * @param {string} [asOfDate] defaults to today — pass a different date to
 *   regenerate for a specific simulated day (used by the Tasks page's date
 *   picker to test different days without a full time-travel system).
 */
export async function generateDemoTasks(asOfDate = todayStr()) {
  const realProducts = (await Products.all()).filter((p) => !p.is_demo);
  if (realProducts.length === 0) {
    return { generated: false, reason: 'NO_REAL_PRODUCTS' };
  }
  realProducts.sort((a, b) => (a.product_code || a.product_name).localeCompare(b.product_code || b.product_name, 'ar'));

  const counts = scaleCounts(realProducts.length);
  const dates = datesRange(asOfDate, 7);

  let cursor = 0;
  let ordersWritten = 0;
  const perScenario = {};

  for (let s = 0; s < SCENARIOS.length; s++) {
    const scenario = SCENARIOS[s];
    const n = counts[s];
    perScenario[scenario.key] = n;
    for (let k = 0; k < n && cursor < realProducts.length; k++, cursor++) {
      const product = realProducts[cursor];
      for (let i = 0; i < dates.length; i++) {
        const value = scenario.values[i];
        if (value === null || value === undefined) continue;
        await DailyOrders.upsert({ product_id: product.id, date: dates[i], orders_count: value, is_demo: true });
        ordersWritten++;
      }
    }
  }

  // Marks "the day tasks were (re)assigned" — the Tasks page only treats an
  // unresolved task as ⚠️ carried-over once the viewed date is AFTER this,
  // i.e. once the user has actually had a chance to act on it. Without
  // this, a freshly generated 7-day window would immediately show
  // yesterday's never-seen tasks as "late", which is misleading rather
  // than informative.
  await Settings.save({ lastDemoGeneratedDate: asOfDate });

  return { generated: true, asOfDate, productsCovered: cursor, ordersWritten, perScenario };
}

/** Clears only is_demo=true daily_orders rows (never touches real products or real orders), then regenerates fresh demo data. */
export async function resetDemoTasks(asOfDate = todayStr()) {
  const { removed } = await DailyOrders.clearDemoOrders();
  const result = await generateDemoTasks(asOfDate);
  return { removed, ...result };
}
