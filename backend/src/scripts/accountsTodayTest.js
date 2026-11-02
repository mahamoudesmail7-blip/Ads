// 🧪 "نظرة سريعة" accounts card: per-account spend / orders / CPA for one day + the overall total, from the synced snapshots; funds are a separate live read whose failure must never
// hide the numbers. Isolated test database only.
//   node src/scripts/accountsTodayTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const { prisma } = await imp('../prisma.js');
const AT = await imp('../services/amb/accountsToday.js');
const OV = await imp('../services/amb/overview.js');

const PRIMARY = 'act_1518142859790043', HADY = 'act_877011384919552', YASSER = 'act_1370863561334304';
const todayCairo = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() + 3 * 3600e3 - 24 * 3600e3).toISOString().slice(0, 10);
let conn = null, prevAcc = null, prevStatus = null; const runIds = [];
try {
  conn = await prisma.metaConnection.findFirst(); prevAcc = conn?.selected_ad_account_id; prevStatus = conn?.status;
  await prisma.metaConnection.update({ where: { id: conn.id }, data: { selected_ad_account_id: PRIMARY, status: 'CONNECTED' } });
  const run = await prisma.ambSyncRun.create({ data: { trigger: 'VIEW', status: 'SUCCESS', ad_account_id: HADY, started_at: new Date(), finished_at: new Date() } }); runIds.push(run.id);
  const snap = (acc, cid, spend, purchases, date = todayCairo, snapshot_at = new Date()) => prisma.metaPerformanceSnapshot.create({ data: { sync_run_id: run.id, ad_account_id: acc, level: 'campaign', date_start: date, date_stop: date, campaign_id: cid, campaign_name: `at ${cid}`, campaign_status: 'ACTIVE', spend, meta_purchases: purchases, snapshot_at } });
  await snap(HADY, 'at_h1', 210, 3);
  await snap(HADY, 'at_h2', 100, 0);
  await snap(HADY, 'at_h1', 150, 2, todayCairo, new Date(Date.now() - 3600e3)); // an OLDER snapshot of the same campaign/day: only the latest one counts
  await snap(YASSER, 'at_y1', 55, 1);
  await snap(PRIMARY, 'at_p1', 600, 6);
  await snap(HADY, 'at_h_old', 80, 1, yesterday);

  console.log('\n1. Per-account numbers and the overall total');
  const r = await AT.getAccountsToday({});
  const by = (id) => r.accounts.find((a) => a.id === id);
  ok('the day is today (Cairo) and all three accounts are listed', r.date === todayCairo && r.accounts.length === 3, `${r.date} ${r.accounts.length}`);
  ok('Hady = 310 spend / 3 orders / CPA ≈ 103.3 (latest snapshot per campaign, no double count)', by(HADY).spend === 310 && by(HADY).orders === 3 && Math.abs(by(HADY).cpa - 310 / 3) < 0.01, JSON.stringify(by(HADY)));
  ok('Yasser = 55 / 1 / 55', by(YASSER).spend === 55 && by(YASSER).orders === 1 && by(YASSER).cpa === 55, JSON.stringify(by(YASSER)));
  ok('the connected account = 600 / 6 / 100', by(PRIMARY).spend === 600 && by(PRIMARY).orders === 6 && by(PRIMARY).cpa === 100, JSON.stringify(by(PRIMARY)));
  ok('total = sum of the accounts (965 spend / 10 orders / CPA 96.5)', r.total.spend === 965 && r.total.orders === 10 && Math.abs(r.total.cpa - 96.5) < 0.001, JSON.stringify(r.total));
  const ov = await OV.getOverview({ windowName: 'today', adAccountId: HADY });
  ok('matches the Home overview of the same account (same numbers, not a second definition)', ov.kpis.spend === by(HADY).spend && ov.kpis.orders === by(HADY).orders, JSON.stringify(ov.kpis));

  console.log('\n2. Another day, and an account with no rows');
  const y = await AT.getAccountsToday({ date: yesterday });
  ok('yesterday: only the yesterday row (Hady 80 / 1)', y.date === yesterday && y.accounts.find((a) => a.id === HADY).spend === 80 && y.accounts.find((a) => a.id === HADY).orders === 1, JSON.stringify(y.total));
  ok('an account with no rows that day is flagged hasData=false and never shows a fabricated CPA', y.accounts.find((a) => a.id === YASSER).hasData === false && y.accounts.find((a) => a.id === YASSER).cpa === null, JSON.stringify(y.accounts.find((a) => a.id === YASSER)));
  ok('zero orders → CPA is null, not Infinity/0', by(HADY).cpa !== 0 && (await AT.getAccountsToday({ date: '2000-01-01' })).total.cpa === null);
  ok('a malformed date falls back to today (never an error / injection)', (await AT.getAccountsToday({ date: "2026-01-01';--" })).date === todayCairo);

  console.log('\n3. Funds are separate: Graph is unreachable in the test db → funds say so, the numbers still show');
  ok('funds failure is isolated per account (error set, spend/orders intact)', r.accounts.every((a) => a.funds && (a.funds.error || a.funds.display !== undefined)) && by(HADY).spend === 310, JSON.stringify(by(HADY).funds));
  await prisma.metaConnection.update({ where: { id: conn.id }, data: { status: prevStatus } });
} finally {
  if (conn) await prisma.metaConnection.update({ where: { id: conn.id }, data: { selected_ad_account_id: prevAcc ?? null } }).catch(() => {});
  await prisma.metaPerformanceSnapshot.deleteMany({ where: { campaign_id: { startsWith: 'at_' } } }).catch(() => {});
  await prisma.ambSyncRun.deleteMany({ where: { id: { in: runIds } } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
