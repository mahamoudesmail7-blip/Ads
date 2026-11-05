// 🧪 «نظرة سريعة» → "كل يوم جاب كام أوردر": one calendar month day by day (Meta purchases of every account) + the products behind each day.
// Same numbers / same product attribution as the accounts card and its products modal. Isolated test database only.
//   node src/scripts/monthDailyOrdersTest.js
import './_testGuard.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const { prisma } = await imp('../prisma.js');
const M = await imp('../services/amb/monthDailyOrders.js');
const AP = await imp('../services/amb/accountProductsToday.js');

const PRIMARY = 'act_1518142859790043', HADY = 'act_877011384919552', YASSER = 'act_1370863561334304';
const todayCairo = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const month = new Date(Date.UTC(+todayCairo.slice(0, 4), +todayCairo.slice(5, 7) - 2, 1)).toISOString().slice(0, 7); // the previous month: fully in the past whatever day the suite runs
const d = (n) => `${month}-${String(n).padStart(2, '0')}`;
let conn = null, prevAcc = null; const runIds = []; const made = { product: null, job: null };
try {
  console.log('\n1. pure month document (no database)');
  ok('month validation', M.validMonth('2026-11') && !M.validMonth('2026-13') && !M.validMonth('2026-1') && !M.validMonth("2026-11';--") && !M.validMonth(null));
  ok('days in month incl. leap February', M.daysInMonth('2026-11') === 30 && M.daysInMonth('2026-10') === 31 && M.daysInMonth('2028-02') === 29 && M.daysInMonth('2027-02') === 28);
  const g = (key, name, orders, spend, source = 'NAME', campaigns = 1) => [key, { key, name, source, orders, spend, campaigns }];
  const doc = M.buildMonthDoc({
    month: '2026-11', today: '2026-11-04',
    perAccount: [
      { id: 'A', name: 'Acc A', days: new Map([['2026-11-01', new Map([g('p:1', 'Soleva', 5, 500, 'LAUNCH'), g('n:x', 'X', 0, 80)])], ['2026-11-03', new Map([g('p:1', 'Soleva', 2, 100, 'LAUNCH')])]]) },
      { id: 'B', name: 'Acc B', days: new Map([['2026-11-01', new Map([g('p:1', 'Soleva', 3, 150, 'LAUNCH'), g('n:y', 'Y', 4, 200)])]]) },
    ],
  });
  ok('one entry per calendar day (30), future days flagged', doc.days.length === 30 && doc.days[3].future === false && doc.days[4].future === true && doc.days[29].day === 30);
  const d1 = doc.days[0];
  ok('day 1 = 12 orders across both accounts; the same product merges into ONE row (8 orders)', d1.orders === 12 && d1.products.length === 2 && d1.products[0].name === 'Soleva' && d1.products[0].orders === 8, JSON.stringify(d1.products));
  ok('merged product keeps the per-account split, best account first', d1.products[0].accounts.length === 2 && d1.products[0].accounts[0].name === 'Acc A' && d1.products[0].accounts[0].orders === 5);
  ok('spend without orders is listed apart, never among the products; day spend includes it', d1.noOrders.length === 1 && d1.noOrders[0].name === 'X' && d1.spend === 930);
  ok('cost per order = spend / orders (930 spend counted → 77.5)', d1.cpa === 77.5, String(d1.cpa));
  ok('order share adds up to 100', Math.abs(d1.products.reduce((s, p) => s + p.orderShare, 0) - 100) < 0.1);
  ok('a day with no snapshots: hasData=false, 0 orders, null CPA — never a fabricated row', doc.days[1].hasData === false && doc.days[1].orders === 0 && doc.days[1].cpa === null && doc.days[1].products.length === 0);
  ok('month totals / average over days WITH data / best day', doc.total.orders === 14 && doc.avgPerDay === 7 && doc.daysWithData === 2 && doc.bestDay.day === 1 && doc.bestDay.orders === 12, JSON.stringify([doc.total, doc.avgPerDay, doc.bestDay]));
  const empty = M.buildMonthDoc({ month: '2026-11', today: '2026-11-04', perAccount: [] });
  ok('no data at all → zero totals, no best day, no average', empty.total.orders === 0 && empty.bestDay === null && empty.avgPerDay === null && empty.total.cpa === null);

  console.log('\n2. real snapshots (isolated DB)');
  conn = await prisma.metaConnection.findFirst(); prevAcc = conn?.selected_ad_account_id;
  await prisma.metaConnection.update({ where: { id: conn.id }, data: { selected_ad_account_id: PRIMARY, status: 'CONNECTED' } });
  const run = await prisma.ambSyncRun.create({ data: { trigger: 'VIEW', status: 'SUCCESS', ad_account_id: HADY, started_at: new Date(), finished_at: new Date() } }); runIds.push(run.id);
  const snap = (acc, cid, name, spend, purchases, date, snapshot_at = new Date()) => prisma.metaPerformanceSnapshot.create({ data: { sync_run_id: run.id, ad_account_id: acc, level: 'campaign', date_start: date, date_stop: date, campaign_id: cid, campaign_name: name, spend, meta_purchases: purchases, snapshot_at } });
  await snap(HADY, 'md_n1', 'Nail-clipper - Test 1', 300, 3, d(1));
  await snap(HADY, 'md_n1', 'Nail-clipper - Test 1', 100, 1, d(1), new Date(Date.now() - 3600e3)); // older snapshot of the same campaign/day: ignored
  await snap(HADY, 'md_n2', 'nail-clipper-Test 2', 100, 1, d(1));
  await snap(HADY, 'md_l1', 'launch campaign x', 150, 5, d(1));
  await snap(HADY, 'md_l1', 'launch campaign x', 120, 4, d(2));
  await snap(YASSER, 'md_y1', 'Soleva - Test', 40, 1, d(1));
  made.product = await prisma.product.create({ data: { product_name: 'MD Launch Product' } });
  made.job = await prisma.ambLaunchJob.create({ data: { job_id: 'md-test-job', ad_account_id: HADY, budget_mode: 'CBO', config_json: '{}', product_id: made.product.id } });
  await prisma.ambLaunchCampaign.create({ data: { job_id: made.job.job_id, index: 0, name: 'launch campaign x', meta_campaign_id: 'md_l1', status: 'COMPLETE' } });

  const r = await M.getMonthDailyOrders({ month, force: true });
  const day1 = r.days[0], day2 = r.days[1];
  ok('day 1 orders = 3 + 1 + 5 (Hady) + 1 (Yasser) = 10, older snapshot ignored', day1.orders === 10, String(day1.orders));
  ok('day 2 = 4 orders from the launched product', day2.orders === 4 && day2.products[0].name === 'MD Launch Product' && day2.products[0].source === 'LAUNCH', JSON.stringify(day2.products));
  ok('day 1 products: wizard product 5, Nail-clipper family 4 (3+1), Soleva 1 — best first', JSON.stringify(day1.products.map((p) => [p.name, p.orders])) === JSON.stringify([['MD Launch Product', 5], ['Nail-clipper', 4], ['Soleva', 1]]), JSON.stringify(day1.products.map((p) => [p.name, p.orders])));
  const hadyDay = await AP.getAccountProductsToday({ adAccountId: HADY, date: d(1) });
  const yDay = await AP.getAccountProductsToday({ adAccountId: YASSER, date: d(1) });
  ok('SAME numbers as the accounts card for that day (Hady + Yasser)', day1.orders === hadyDay.totals.orders + yDay.totals.orders && day1.spend === r2(hadyDay.totals.spend + yDay.totals.spend), `${day1.orders} vs ${hadyDay.totals.orders}+${yDay.totals.orders}`);
  ok('a mid-month day without rows is empty (no invented zero row)', r.days[2].hasData === false && r.days[2].products.length === 0);
  const cur = await M.getMonthDailyOrders({ month: todayCairo.slice(0, 7), force: true });
  ok('in the current month the days after today are flagged future and stay empty', cur.days.filter((x) => x.future).every((x) => !x.hasData && x.orders === 0) && cur.days.every((x) => (x.date > todayCairo) === x.future));
  ok('totals sum the days; best day is day 1 when it has the most orders', r.total.orders === 14 && r.bestDay.day === 1);
  const other = await M.getMonthDailyOrders({ month: '2020-01', force: true });
  ok('a past month with no data → 31 empty days, no best day', other.days.length === 31 && other.total.orders === 0 && other.bestDay === null);
  const cached = await M.getMonthDailyOrders({ month });
  ok('a second call within the cache window is served from memory (same object)', cached === r);
} finally {
  if (conn) await prisma.metaConnection.update({ where: { id: conn.id }, data: { selected_ad_account_id: prevAcc ?? null } }).catch(() => {});
  await prisma.metaPerformanceSnapshot.deleteMany({ where: { campaign_id: { startsWith: 'md_' } } }).catch(() => {});
  await prisma.ambSyncRun.deleteMany({ where: { id: { in: runIds } } }).catch(() => {});
  if (made.job) await prisma.ambLaunchJob.delete({ where: { job_id: made.job.job_id } }).catch(() => {});
  if (made.product) await prisma.product.delete({ where: { id: made.product.id } }).catch(() => {});
  await prisma.$disconnect();
}
function r2(n) { return Math.round(n * 100) / 100; }
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
