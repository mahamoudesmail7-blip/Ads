// 🧪 «نتايج شغل الميديا باير»: yesterday's campaigns → what they did today, per buyer and per product; the month per buyer and product; creation day never counted; past days stored once.
// A loopback mock plays the Graph API (read only); isolated test database only.   node src/scripts/buyerReportTest.js
import './_testGuard.js';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };

const world = { activities: new Map(), calls: 0, writes: 0 };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); const seg = url.pathname.split('/').filter(Boolean); const id = seg[1], edge = seg[2];
  if (req.method !== 'GET') world.writes++;
  const send = (c, j) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (/^act_/.test(id || '') && edge === 'activities') { world.calls++; return send(200, { data: world.activities.get(id) || [] }); }
  if (/^act_/.test(id || '')) return send(200, { id, name: `Acct ${id.slice(-4)}`, account_status: 1, currency: 'EGP' });
  return send(200, { data: [] });
});
await new Promise((rs) => server.listen(0, '127.0.0.1', rs)); process.env.META_GRAPH_MOCK = '1'; process.env.META_GRAPH_MOCK_URL = `http://127.0.0.1:${server.address().port}`;

const { prisma } = await imp('../prisma.js');
const R = await imp('../services/amb/buyerReport.js');
const { cairoDate, addDays } = await imp('../services/amb/dailyPlanTime.js');
const T = `br_${Date.now()}_`; const today = cairoDate(); const y = addDays(today, -1); const d2 = addDays(today, -2); const d3 = addDays(today, -3);
const at = (date, hh) => new Date(`${date}T${String(hh).padStart(2, '0')}:20:00+02:00`);
const conn = await prisma.metaConnection.findFirst(); const ACC = conn?.selected_ad_account_id || 'act_1518142859790043';
const made = { runs: [], teamLinked: [] };
// leftovers of earlier local demos in the shared test database would count as «yesterday's» work: clear them first
await prisma.ambLaunchJob.deleteMany({ where: { OR: [{ job_id: { startsWith: 'demoSys_' } }, { job_id: { startsWith: 'demoBA_' } }, { job_id: { startsWith: 'ba_' } }] } }).catch(() => {});
await prisma.ambCloneBatch.deleteMany({ where: { batch_id: { startsWith: 'demoBA_' } } }).catch(() => {});
await prisma.settings.deleteMany({ where: { id: { startsWith: 'ba:ev:' } } }).catch(() => {});
try {
  console.log('\n1. pure');
  const pc = (product, type, orders, spend) => ({ product, type, perf: orders === null ? null : { orders, spend }, at: '2026-11-01T10:00:00Z', id: Math.random() });
  const rows = R.groupProducts([pc('Cup', 'TEST', 4, 200), pc('Cup', 'SCALE', 3, 300), pc('Radio', 'TEST', 0, 90), pc('Radio', 'TEST', null, 0), pc(null, 'OTHER', 1, 50), pc('cup ', 'TEST', 1, 100)]);
  const cup = rows.find((r) => r.name === 'Cup');
  ok('per product: campaigns, tests, scales, orders, spend, cost per order (the same product in different spelling is ONE row)', cup.campaigns === 3 && cup.tests === 2 && cup.scales === 1 && cup.orders === 8 && cup.spend === 600 && cup.cpa === 75, JSON.stringify(cup));
  ok('best product first (most orders), spend with no orders keeps CPA null, a product with no data at all shows null orders (not 0)', rows[0].name === 'Cup' && rows.find((r) => r.name === 'Radio').orders === 0 && rows.find((r) => r.name === 'Radio').cpa === null && R.groupProducts([pc('Zed', 'TEST', null, 0)])[0].orders === null && R.groupProducts([pc('Zed', 'TEST', null, 0)])[0].spendKnown === false);
  ok('unknown product campaigns are grouped as «منتج غير محدد»', rows.some((r) => r.name === 'منتج غير محدد' && r.orders === 1));
  const tot = R.personTotals([pc('A', 'TEST', 2, 100), pc('B', 'SCALE', 3, 200), pc('C', 'TEST', null, 0)]);
  ok('person totals add only what has data: 5 orders / 300 spend / CPA 60; 1 scale, 2 tests, 3 campaigns', tot.orders === 5 && tot.spend === 300 && tot.cpa === 60 && tot.scales === 1 && tot.tests === 2 && tot.campaigns === 3);
  ok('totals of nothing-with-data are null, not zero', R.personTotals([pc('A', 'TEST', null, 0)]).orders === null);
  const byCamp = new Map([['c', new Map([['2026-11-10', { spend: 500, orders: 9 }], ['2026-11-11', { spend: 100, orders: 1 }], ['2026-11-12', { spend: 60, orders: 2 }]])]]);
  const perf = R.campaignPerf(byCamp, { id: 'c', at: '2026-11-10T10:00:00+02:00' }, '2026-11-12');
  ok('a campaign’s numbers start the day AFTER its creation day (the 500 / 9 of the creation day is never counted)', perf.orders === 3 && perf.spend === 160 && R.campaignPerf(byCamp, { id: 'c', at: '2026-11-12T10:00:00+02:00' }, '2026-11-12') === null);

  console.log('\n2. yesterday: campaigns created yesterday → what they did today (mock Graph + isolated DB)');
  const ev = (id, name, actor, aid, when) => ({ event_type: 'create_campaign', translated_event_type: 'Campaign created', object_type: 'CAMPAIGN', object_id: id, object_name: name, actor_id: aid, actor_name: actor, event_time: when.toISOString() });
  world.activities.set(ACC, [
    ev(`${T}c1`, 'Cup - Test', 'Hady Mohamed', '9', at(y, 11)), ev(`${T}c2`, 'Cup - Scale', 'Hady Mohamed', '9', at(y, 14)), ev(`${T}c3`, 'Radio - Test', 'Hady Mohamed', '9', at(y, 15)), ev(`${T}c4`, 'Cup - Test 2', 'Ahmed Samy', '10', at(y, 16)),
    ev(`${T}c5`, 'Radio - Test 2', 'Hady Mohamed', '9', at(d3, 11)), ev(`${T}c6`, 'Radio - Scale', 'Ahmed Samy', '10', at(d2, 12)),
  ]);
  const run = await prisma.ambSyncRun.create({ data: { trigger: 'VIEW', status: 'SUCCESS', ad_account_id: ACC, started_at: new Date(), finished_at: new Date() } }); made.runs.push(run.id);
  const snap = (cid, spend, purchases, date) => prisma.metaPerformanceSnapshot.create({ data: { sync_run_id: run.id, ad_account_id: ACC, level: 'campaign', date_start: date, date_stop: date, campaign_id: cid, campaign_name: cid, spend, meta_purchases: purchases, snapshot_at: new Date() } });
  await snap(`${T}c1`, 70, 9, y); await snap(`${T}c1`, 200, 4, today); await snap(`${T}c2`, 300, 3, today); await snap(`${T}c3`, 90, 0, today); await snap(`${T}c4`, 150, 1, today); // yesterday's 70 / 9 = creation day, must be ignored
  await snap(`${T}c5`, 100, 2, d2); await snap(`${T}c5`, 120, 3, y); await snap(`${T}c5`, 60, 1, today); await snap(`${T}c6`, 80, 2, y); await snap(`${T}c6`, 40, 1, today);

  const yr = await R.getBuyerReport({ mode: 'yesterday', force: true });
  ok('the report is ready and says which day it covers (yesterday) and from when the numbers count (today)', yr.ready === true && yr.from === y && yr.to === y && yr.firstResultDay === today);
  const flat = yr.people.flatMap((p) => p.products.flatMap((r) => r.items)); const mine = (id) => flat.find((c) => c.id === `${T}${id}`);
  ok('each campaign made yesterday shows what it did TODAY (c1: 200 / 4 orders — the 70 / 9 of its creation day is not counted)', mine('c1').perf.orders === 4 && mine('c1').perf.spend === 200 && mine('c3').perf.orders === 0 && mine('c3').perf.cpa === null);
  ok('older campaigns (d-2, d-3) are not in the yesterday report', !mine('c5') && !mine('c6'));
  const hady = yr.people.find((p) => p.products.some((r) => r.items.some((c) => c.id === `${T}c1`))); const ahmed = yr.people.find((p) => p.products.some((r) => r.items.some((c) => c.id === `${T}c4`)));
  const hCup = hady.products.find((r) => r.name === 'Cup'); const hRadio = hady.products.find((r) => r.name === 'Radio');
  ok('per buyer, per product: Hady’s Cup = 1 test + 1 scale → 7 orders, 500 spend, CPA 71.43; his Radio test = 0 orders, 90 spend', hCup.tests === 1 && hCup.scales === 1 && hCup.orders === 7 && hCup.spend === 500 && hCup.cpa === 71.43 && hRadio.orders === 0 && hRadio.spend === 90, JSON.stringify([hCup, hRadio].map((r) => [r.name, r.orders, r.spend, r.cpa])));
  ok('Ahmed’s Cup test is HIS, not Hady’s (each buyer separately): 1 order / 150 spend / CPA 150', ahmed !== hady && ahmed.products.find((r) => r.name === 'Cup').orders === 1 && ahmed.products.find((r) => r.name === 'Cup').cpa === 150);
  ok('a buyer’s totals add his products (Hady: 7 orders, 590 spend, 2 tests + 1 scale…)', hady.totals.orders === 7 && hady.totals.spend === 590 && hady.totals.scales === 1 && hady.totals.tests === 2, JSON.stringify(hady.totals));

  console.log('\n3. month');
  const dom = Number(today.slice(8, 10));
  const mr = await R.getBuyerReport({ mode: 'month', force: true });
  ok('the month report covers the 1st … today and is ready', mr.ready === true && mr.from === `${today.slice(0, 7)}-01` && mr.to === today);
  if (dom >= 4) {
    const mh = mr.people.find((p) => p.products.some((r) => r.items.some((c) => c.id === `${T}c5`)));
    const mRadio = mh.products.find((r) => r.name === 'Radio');
    ok('Hady’s Radio over the month = the test of yesterday (0 orders / 90) + the older one (the days AFTER its creation: 100+120+60 spend, 2+3+1 orders) → 6 orders, 370 spend, CPA 61.67', mRadio.campaigns === 2 && mRadio.orders === 6 && mRadio.spend === 370 && mRadio.cpa === 61.67, JSON.stringify(mRadio));
    ok('the month adds all of Hady’s products (Cup 7 + Radio 6 = 13 orders)', mh.totals.orders === 13, JSON.stringify(mh.totals));
    const stored = await prisma.settings.findUnique({ where: { id: `ba:ev:${d3}` } }); const todayRow = await prisma.settings.findUnique({ where: { id: `ba:ev:${today}` } });
    ok('past days are stored once (never read from Meta again); today is never stored', !!stored && JSON.parse(stored.data).events.length >= 1 && !todayRow);
  } else console.log('  (the 1st–3rd of the month: the older-campaign month assertions are skipped)');
  ok('everything asked of Meta was a READ (GET)', world.writes === 0 && world.calls > 0);
  ok('an unknown mode is refused', await R.getBuyerReport({ mode: 'year' }).then(() => false, (e) => e.status === 400));
} finally {
  await prisma.metaPerformanceSnapshot.deleteMany({ where: { campaign_id: { startsWith: T } } }).catch(() => {});
  await prisma.ambSyncRun.deleteMany({ where: { id: { in: made.runs } } }).catch(() => {});
  await prisma.settings.deleteMany({ where: { id: { startsWith: 'ba:ev:' } } }).catch(() => {});
  await prisma.$disconnect(); server.close();
}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
