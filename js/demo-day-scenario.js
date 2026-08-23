// demo-day-scenario.js — a hand-curated "Demo Day" (18 Aug 2026, vs 17 Aug
// as yesterday) on 17 specific REAL products, matching a user-provided
// worked example. This is INTENTIONALLY separate from demo-tasks.js's
// broad 127-product 8-bucket generator: 🧪 تجربة يوم جديد loads THIS
// specific curated day; 🔄 إعادة التجربة reverts to the general demo
// dataset (demo-tasks.js), matching the two distinct buttons requested.
//
// Products are matched by NAME using product-mapping.js's fuzzy matcher
// (already built for the EasyOrders name-matching problem) rather than
// assuming byte-identical strings, since a couple of the given names are
// shortened versions of the real catalog entries (e.g. "ماكينة صنع الثلج
// DSP الاحترافية" vs the catalog's longer "... – ثلج جاهز خلال 6 دقائق").
//
// IMPORTANT — why the resulting Scale/Reduce/Review counts don't land on
// exactly 5/3/6 as in the worked example: the Decision Engine (already
// tested, used everywhere else in this app) classifies a >=50% single-day
// drop as an urgent SHARP_DECLINE regardless of how gentle the days before
// it were — several of the "declined" products given here (e.g. 11→5 is a
// 55% overnight drop) mathematically trigger that safety check. That's the
// engine correctly telling you a swing THIS big deserves more than "just
// reduce budget", not a bug — see the live-verified counts in the final
// report instead of the illustrative ones.
import { Products, DailyOrders, Settings } from './db.js';
import { addDays } from './analytics.js';
import { mapProductByName } from './product-mapping.js';

export const DEMO_TODAY = '2026-08-18';
export const DEMO_YESTERDAY = '2026-08-17';

// [name (fuzzy-matched against the real catalog), yesterday, today]
const SCENARIO = [
  ['جهاز إزالة شعر الوجه مع المصباح الذكي', 8, 14],
  ['جهاز تنظيف الأذن الذكي مزود بكاميرا', 6, 12],
  ['كاميرا جيب الذكية', 5, 10],
  ['فرشاة أسنان كهربائية 4 في 1', 4, 9],
  ['جهاز هايفور للتجاعيد', 3, 8],
  ['مصباح المنارة الذكي', 5, 8],
  ['سماعة بلوتوث كلاسيكية مع إضاءة موجية', 4, 7],
  ['شنطة ظهر ذكية', 3, 6],
  ['جهاز تنظيف الزجاج الكهربائي', 11, 5],
  ['راديو كلاسيكي – ستايل الماضي', 9, 4],
  ['حامل لابتوب', 8, 4],
  ['جهاز تدليك الرقبة والظهر مع تدفئة', 10, 6],
  ['فواحة', 7, 4],
  ['ماكينة صنع الثلج DSP الاحترافية', 6, 3],
  ['راوتر واي فاي', 7, 0],
  ['جهاز قياس درجة الحرارة الديجيتال', 5, 0],
  ['منظف أقمشة', 4, 0],
];

function datesEndingToday() {
  return Array.from({ length: 7 }, (_, i) => addDays(DEMO_TODAY, -(6 - i)));
}

/** 6 days climbing steadily up to `yesterday`, then a jump to `today` — a clean, unambiguous uptrend. */
function risingValues(yesterday, today) {
  const lead = [5, 4, 3, 2, 1, 0].map((back) => Math.max(0, yesterday - back));
  return [...lead, today];
}

/** 5 days flat at a higher baseline, easing down to `yesterday`, then `today`. */
function decliningValues(yesterday, today) {
  const lead = Array(5).fill(yesterday + 2).concat([yesterday]);
  return [...lead, today];
}

/** Flat at `yesterday`'s level, then an explicit zero — always STOPPED regardless of the lead-in shape. */
function zeroValues(yesterday) {
  return [...Array(6).fill(yesterday), 0];
}

function buildValues(yesterday, today) {
  if (today === 0) return zeroValues(yesterday);
  return today > yesterday ? risingValues(yesterday, today) : decliningValues(yesterday, today);
}

export async function loadDemoDay() {
  const realProducts = (await Products.all()).filter((p) => !p.is_demo);
  await DailyOrders.clearDemoOrders();

  const dates = datesEndingToday();
  let matched = 0;
  let ordersWritten = 0;
  const unmatched = [];

  for (const [name, yesterday, today] of SCENARIO) {
    const { productId } = mapProductByName(name, realProducts, 0.5);
    if (!productId) {
      unmatched.push(name);
      continue;
    }
    matched++;
    const values = buildValues(yesterday, today);
    for (let i = 0; i < dates.length; i++) {
      await DailyOrders.upsert({ product_id: productId, date: dates[i], orders_count: values[i], is_demo: true });
      ordersWritten++;
    }
  }

  await Settings.save({ lastDemoGeneratedDate: DEMO_TODAY });

  return { matched, unmatched, ordersWritten, demoToday: DEMO_TODAY, demoYesterday: DEMO_YESTERDAY };
}
