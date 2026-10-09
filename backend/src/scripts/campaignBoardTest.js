// 🧪 Campaign board (read-only): Cairo-day windows, CPA = spend / purchases of the same window (null — never 0 — with no purchases), CPA colour zones only from a real policy, and a DB check that
// stale campaigns are excluded, every window uses the LAST snapshot of each day, and nothing is written.
//   node src/scripts/campaignBoardTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const B = await imp('../services/amb/campaignBoard.js'); const T = await imp('../services/amb/dailyPlanTime.js'); const { prisma } = await imp('../prisma.js');

console.log('\n1. Windows are anchored on the CAIRO calendar day');
{
  const w = B.boardWindows('2026-10-09');
  ok('today is one day; 7D = 7 inclusive days; 30D = 30 inclusive days', w.today.from === '2026-10-09' && w.today.to === '2026-10-09' && w.d7.from === '2026-10-03' && w.d30.from === '2026-09-10' && w.d30.to === '2026-10-09', JSON.stringify(w));
  const nearMidnight = new Date('2026-10-08T21:30:00Z'); // 00:30 in Cairo (UTC+3)
  ok('00:30 Cairo is already the NEXT calendar day (UTC would still say yesterday)', T.cairoDate(nearMidnight) === '2026-10-09' && nearMidnight.toISOString().slice(0, 10) === '2026-10-08', T.cairoDate(nearMidnight));
  ok('23:30 Cairo is still the same day', T.cairoDate(new Date('2026-10-09T20:30:00Z')) === '2026-10-09');
  const m = B.boardWindows('2026-03-01'); ok('month boundaries are right (30 days back from 1 March)', m.d30.from === '2026-01-31', m.d30.from);
}

console.log('\n2. CPA = spend / purchases (same window); no purchases = not available');
ok('300 / 3 = 100', B.cpaOf(300, 3) === 100);
ok('rounds like the rest of the Operator (329 / 5 = 66)', B.cpaOf(329, 5) === 66);
ok('zero purchases → null, NOT 0 (even with spend)', B.cpaOf(310, 0) === null);
ok('no purchases and no spend → null', B.cpaOf(0, 0) === null && B.cpaOf(null, null) === null);
ok('purchases without spend gives 0 (a free order), never a crash', B.cpaOf(0, 4) === 0);

console.log('\n3. CPA colour zones come ONLY from a real policy');
{
  const g = { scale: { maxCpa: 80 }, keep: { minCpa: 81, maxCpa: 149 }, reduce: { minCpa: 150, maxCpa: 200 }, highCpa: { above: 200 } };
  const z = B.zonesFor(g, null);
  ok('global budget policy → good ≤ 80, mid ≤ 149, warn ≤ 200 (source GLOBAL_POLICY)', z && z.good === 80 && z.mid === 149 && z.warn === 200 && z.source === 'GLOBAL_POLICY', JSON.stringify(z));
  const p = B.zonesFor(g, { mode: 'APPROVAL', cpa: { scale: 60, reduce: 120, hardStop: 160 } });
  ok('an ACTIVE product policy overrides the zones (source PRODUCT_POLICY) and stays ordered', p && p.source === 'PRODUCT_POLICY' && p.good === 60 && p.good < p.mid && p.mid <= p.warn, JSON.stringify(p));
  ok('no policy at all → null (the UI shows a neutral chip, nothing is invented)', B.zonesFor(null, null) === null && B.zonesFor({}, null) === null);
  ok('a policy with missing zones → null, never defaults', B.zonesFor({ scale: {}, keep: {}, reduce: {} }, null) === null);
}

console.log('\n4. Board over real rows (isolated test database)');
const ACC = 'act_board_test_1'; let conn = null, prevAcc = null; const run = await prisma.ambSyncRun.create({ data: { status: 'SUCCESS', ad_account_id: ACC, finished_at: new Date() } });
try {
  conn = await prisma.metaConnection.findFirst(); prevAcc = conn?.selected_ad_account_id;
  await prisma.metaConnection.update({ where: { id: conn.id }, data: { selected_ad_account_id: ACC } });
  const today = T.cairoDate(new Date()); const yest = T.cairoDate(new Date(Date.now() - 86400000));
  const snap = (cid, day, spend, purchases, extra = {}) => prisma.metaPerformanceSnapshot.create({ data: { sync_run_id: run.id, ad_account_id: ACC, level: 'campaign', date_start: day, date_stop: day, campaign_id: cid, campaign_name: `T ${cid}`, campaign_status: 'ACTIVE', campaign_budget: 250, campaign_budget_type: 'DAILY', spend, meta_purchases: purchases, ...extra } });
  await snap('bt_a', today, 100, 1, { snapshot_at: new Date(Date.now() - 3 * 3600e3) }); await snap('bt_a', today, 300, 3); // two snapshots of the SAME day: only the latest counts (no double counting)
  await snap('bt_a', yest, 200, 2); await snap('bt_zero', today, 90, 0); await snap('bt_old', yest, 10, 1, { snapshot_at: new Date(Date.now() - 5 * 86400000) });
  const b = await B.buildCampaignBoard({ now: new Date() });
  const a = b.rows.find((r) => r.campaignId === 'bt_a'), z = b.rows.find((r) => r.campaignId === 'bt_zero');
  ok('board is for the Cairo day and lists fresh campaigns only (stale one excluded and counted)', b.today === today && b.tz === 'Africa/Cairo' && !b.rows.some((r) => r.campaignId === 'bt_old') && b.staleExcluded >= 1, JSON.stringify([b.today, b.staleExcluded]));
  ok('last snapshot of the day wins: today = 300 spend / 3 purchases (not 400 / 4)', a && a.today.spend === 300 && a.today.purchases === 3 && a.today.cpa === 100, JSON.stringify(a?.today));
  ok('7D adds yesterday once: 500 / 5 = 100', a && a.d7.spend === 500 && a.d7.purchases === 5 && a.d7.cpa === 100, JSON.stringify(a?.d7));
  ok('zero purchases today: spend shown, CPA null', z && z.today.spend === 90 && z.today.purchases === 0 && z.today.cpa === null, JSON.stringify(z?.today));
  ok('CBO budget carried with its level', a && a.budget === 250 && a.budgetLevel === 'CBO');
  const before = await prisma.ambAction.count(); await B.buildCampaignBoard({ now: new Date() }); ok('building the board writes nothing (no Action rows)', (await prisma.ambAction.count()) === before);
} finally {
  if (conn) await prisma.metaConnection.update({ where: { id: conn.id }, data: { selected_ad_account_id: prevAcc ?? null } });
  await prisma.metaPerformanceSnapshot.deleteMany({ where: { ad_account_id: ACC } }); await prisma.ambSyncRun.deleteMany({ where: { ad_account_id: ACC } }); await prisma.$disconnect();
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
