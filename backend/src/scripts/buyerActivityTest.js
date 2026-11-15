// 🧪 «اللي اتعمل النهارده حسب الميديا باير»: the campaigns created on a day (Meta «View history» + the system's own records), who made each one, which account / product, and what they gave
// the same day / the next day. A loopback mock plays the Graph API (read only); isolated test database only.
//   node src/scripts/buyerActivityTest.js
import './_testGuard.js';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };

// ── mock Graph: account info + the activity history of each account (GET only; any other method is recorded as a violation)
const world = { activities: new Map(), calls: [], writes: 0 };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); const seg = url.pathname.split('/').filter(Boolean); const id = seg[1], edge = seg[2];
  world.calls.push(`${req.method} ${edge || id}`); if (req.method !== 'GET') world.writes++;
  const send = (c, j) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (/^act_/.test(id || '') && edge === 'activities') return send(200, { data: world.activities.get(id) || [] });
  if (/^act_/.test(id || '')) return send(200, { id, name: `Acct ${id.slice(-4)}`, account_status: 1, currency: 'EGP' });
  return send(200, { data: [] });
});
await new Promise((rs) => server.listen(0, '127.0.0.1', rs)); process.env.META_GRAPH_MOCK = '1'; process.env.META_GRAPH_MOCK_URL = `http://127.0.0.1:${server.address().port}`;

const { prisma } = await imp('../prisma.js');
const B = await imp('../services/amb/buyerActivity.js');
const { cairoDate, addDays } = await imp('../services/amb/dailyPlanTime.js');
const T = `ba_${Date.now()}_`; const today = cairoDate(); const yesterday = addDays(today, -1);
const at = (date, hh, mm = '00') => new Date(`${date}T${String(hh).padStart(2, '0')}:${mm}:00+02:00`);
const made = { users: [], jobs: [], batches: [], runs: [], product: null };
const conn = await prisma.metaConnection.findFirst(); const ACC = conn?.selected_ad_account_id || 'act_1518142859790043'; const ACC2 = 'act_877011384919552';
try {
  console.log('\n1. pure: naming → type / product');
  ok('the campaign NAME decides: «Cup - Scale» → SCALE, «Cup - Test 2» → TEST, Arabic words too', B.typeOfCampaign('Cup - Scale') === 'SCALE' && B.typeOfCampaign('Cup - Test 2') === 'TEST' && B.typeOfCampaign('كاب - تيست') === 'TEST' && B.typeOfCampaign('كاب - اسكيل 1') === 'SCALE');
  ok('no keyword → the system record decides (launch = test, clone = scale), else «كامبين» (OTHER)', B.typeOfCampaign('Cup 5', 'TEST') === 'TEST' && B.typeOfCampaign('Cup 5', 'SCALE') === 'SCALE' && B.typeOfCampaign('Cup 5') === 'OTHER');
  ok('product = the part before « - » in the owner’s naming', B.productFromName('Cup - Test 2') === 'Cup' && B.productFromName('Hair Cap - Scale - 500') === 'Hair Cap' && B.productFromName('Cup') === null);

  console.log('\n2. pure: Meta «View history» rows → campaigns created');
  const ev = B.creationEvents([
    { event_type: 'create_campaign', object_type: 'CAMPAIGN', object_id: '111', object_name: 'Cup - Test', actor_id: '9', actor_name: 'Hady Mohamed', event_time: `${today}T08:00:00+0000` },
    { event_type: 'update_campaign_budget', object_type: 'CAMPAIGN', object_id: '111', object_name: 'Cup - Test', actor_id: '9', actor_name: 'Hady Mohamed', event_time: `${today}T09:00:00+0000` },
    { event_type: 'create_ad_set', object_type: 'ADSET', object_id: '222', object_name: 'adset', actor_id: '9', actor_name: 'Hady Mohamed', event_time: `${today}T08:01:00+0000` },
    { event_type: 'create_campaign', object_type: 'CAMPAIGN', object_id: '111', object_name: 'Cup - Test', actor_id: '9', actor_name: 'Hady Mohamed', event_time: `${today}T07:55:00+0000` },
    { event_type: 'create_campaign', object_type: 'CAMPAIGN', object_id: '333', object_name: 'Soleva - Scale', actor_id: '10', actor_name: 'Ahmed Samy', event_time: 'not a date' },
  ], ACC);
  ok('only «campaign created» events count (budget edits and ad sets are ignored), each campaign once with its earliest event, a bad time is dropped', ev.length === 1 && ev[0].id === '111' && ev[0].actor.name === 'Hady Mohamed' && ev[0].at.toISOString().startsWith(`${today}T07:55`));

  console.log('\n3. pure: who made it');
  const team = [{ id: 'm1', name: 'Hady', userId: 11 }, { id: 'm2', name: 'Ahmed Samy', userId: null }, { id: 'm3', name: 'Mohamed 3sam', userId: null }];
  ok('a Facebook actor is matched to the media buyer whose WHOLE name is inside the actor’s name', B.matchMember({ id: '9', name: 'Hady Mohamed' }, team)?.id === 'm1' && B.matchMember({ id: '1', name: 'ahmed  samy ali' }, team)?.id === 'm2');
  ok('…never a guess: no match / two possible members → null', B.matchMember({ id: '5', name: 'Omar Ali' }, team) === null && B.matchMember({ id: '6', name: 'Hady' }, [...team, { id: 'm9', name: 'Hady', userId: null }]) === null);
  ok('the most specific name wins: actor «Ahmed Samy Ali» is «Ahmed Samy», not «Samy» — an exact tie is still null', B.matchMember({ id: '2', name: 'Ahmed Samy Ali' }, [...team, { id: 'm7', name: 'Samy', userId: null }])?.id === 'm2' && B.matchMember({ id: '3', name: 'Ali Zed' }, [{ id: 'a', name: 'Ali', userId: null }, { id: 'b', name: 'Zed', userId: null }]) === null);
  ok('a link the owner set wins (even if the names do not look alike)', B.matchMember({ id: '77', name: 'Zed Qq' }, team, { 77: 'm3' })?.id === 'm3');
  const sys = new Map([['111', { userId: 11, userName: 'Hady', kind: 'TEST', product: 'Cup', name: 'Cup - Test', accountId: ACC, accountName: 'A', at: at(today, 10) }], ['444', { userId: 11, userName: 'Hady', kind: 'SCALE', product: null, name: 'Cup - Scale copy', accountId: ACC2, accountName: 'B', at: at(today, 12) }]]);
  const events = [{ id: '111', name: 'Cup - Test', accountId: ACC, at: at(today, 10), actor: { id: '1', name: 'Mahmoud Esmail' } }, { id: '555', name: 'Soleva - Scale', accountId: ACC2, at: at(today, 11), actor: { id: '10', name: 'Ahmed Samy' } }, { id: '666', name: 'Old - Test', accountId: ACC, at: at(yesterday, 11), actor: { id: '10', name: 'Ahmed Samy' } }];
  const merged = B.mergeCampaigns(events, sys, { day: today, accountNames: { [ACC]: 'Acct A' } });
  ok('system-made campaigns keep the PERSON who launched them (not the connected token owner), Meta-only ones use the actor; other days are cut', merged.length === 3 && merged.find((c) => c.id === '111').by.userId === 11 && merged.find((c) => c.id === '111').source === 'SYSTEM' && merged.find((c) => c.id === '555').source === 'META' && merged.find((c) => c.id === '555').actor.name === 'Ahmed Samy' && !merged.some((c) => c.id === '666'));
  ok('a system campaign missing from Meta’s history is still listed; type/product come from the name or the record', merged.some((c) => c.id === '444' && c.type === 'SCALE') && merged.find((c) => c.id === '555').type === 'SCALE' && merged.find((c) => c.id === '555').product === 'Soleva' && merged.find((c) => c.id === '111').product === 'Cup');
  const g = B.groupByPerson(merged, team, {});
  const hady = g.find((p) => p.memberId === 'm1'); const ahmed = g.find((p) => p.memberId === 'm2'); const idle = g.find((p) => p.memberId === 'm3');
  ok('per person: Hady = 1 test + 1 scale, Ahmed = 1 scale (a Facebook name matched to his card), Mohamed 3sam = nothing (still listed)', hady.tests === 1 && hady.scales === 1 && hady.total === 2 && ahmed.scales === 1 && idle.idle === true && g[0].memberId === 'm1');
  const stranger = B.groupByPerson([{ ...merged[1], actor: { id: '99', name: 'Someone Else' } }], team, {}).find((p) => !p.linked);
  ok('an actor who matches nobody gets their own «غير مربوط» row (so the owner can link him)', stranger && stranger.name === 'Someone Else' && stranger.actor.id === '99' && stranger.memberId === null);
  const m = new Map([['c1', new Map([['2026-11-01', { spend: 100, orders: 2 }], ['2026-11-02', { spend: 300, orders: 3 }]])]]);
  ok('results: spend + Meta purchases + CPA over the days; no snapshot at all → null (never a fake zero)', JSON.stringify(B.sumResults(m, ['c1'], ['2026-11-01'])) === JSON.stringify({ spend: 100, orders: 2, cpa: 50 }) && B.sumResults(m, ['c1'], ['2026-11-09']) === null && B.sumResults(m, ['nope'], ['2026-11-01']) === null);

  console.log('\n4. real rows + mock Graph (isolated DB)');
  const mkUser = async (tag) => { const u = await prisma.user.create({ data: { email: `${T}${tag}@example.invalid`, password_hash: 'x'.repeat(20), name: `Hady ${T}`, role: 'ADMIN', status: 'ACTIVE', permissions: '{}' } }); made.users.push(u.id); return u; };
  const hadyU = await mkUser('hady'); const prod = await prisma.product.create({ data: { product_name: 'Cup' } }); made.product = prod.id;
  const job = await prisma.ambLaunchJob.create({ data: { job_id: `${T}j1`, ad_account_id: ACC, ad_account_name: 'Acct A', budget_mode: 'CBO', campaign_count: 1, config_json: '{}', status: 'COMPLETE', created_by_id: hadyU.id, product_id: prod.id, created_at: at(today, 10), campaigns: { create: [{ index: 0, name: 'Cup - Test', meta_campaign_id: `${T}sys1`, status: 'COMPLETE' }] } } }); made.jobs.push(job.job_id);
  const ago = (iso) => iso;
  world.activities.set(ACC, [
    { event_type: 'create_campaign', translated_event_type: 'Campaign created', object_type: 'CAMPAIGN', object_id: `${T}sys1`, object_name: 'Cup - Test', actor_id: '1', actor_name: 'Mahmoud Esmail', event_time: at(today, 10).toISOString() },
    { event_type: 'create_campaign', translated_event_type: 'Campaign created', object_type: 'CAMPAIGN', object_id: `${T}man1`, object_name: 'Cup - Scale', actor_id: '9', actor_name: 'Hady Manual', event_time: at(today, 14).toISOString() },
    { event_type: 'create_campaign', translated_event_type: 'Campaign created', object_type: 'CAMPAIGN', object_id: `${T}old1`, object_name: 'Soleva - Test', actor_id: '9', actor_name: 'Hady Manual', event_time: at(yesterday, 11).toISOString() },
    { event_type: 'create_campaign', translated_event_type: 'Campaign created', object_type: 'CAMPAIGN', object_id: `${T}old2`, object_name: 'Cup - Test 3', actor_id: '9', actor_name: 'Hady Manual', event_time: at(addDays(today, -3), 11).toISOString() },
  ]);
  const run = await prisma.ambSyncRun.create({ data: { trigger: 'VIEW', status: 'SUCCESS', ad_account_id: ACC, started_at: new Date(), finished_at: new Date() } }); made.runs.push(run.id);
  const snap = (cid, spend, purchases, date) => prisma.metaPerformanceSnapshot.create({ data: { sync_run_id: run.id, ad_account_id: ACC, level: 'campaign', date_start: date, date_stop: date, campaign_id: cid, campaign_name: cid, spend, meta_purchases: purchases, snapshot_at: new Date() } });
  await snap(`${T}sys1`, 200, 4, today); await snap(`${T}man1`, 90, 0, today); await snap(`${T}old1`, 120, 3, yesterday); await snap(`${T}old1`, 100, 1, today);
  await snap(`${T}old2`, 70, 9, addDays(today, -3)); await snap(`${T}old2`, 80, 2, addDays(today, -2)); await snap(`${T}old2`, 60, 3, yesterday); await snap(`${T}old2`, 40, 0, today); // day 0 (creation day) has numbers on purpose: they must NOT be counted

  const td = await B.getBuyerActivity({ date: today, force: true });
  const mine = td.people.find((p) => p.campaigns.some((c) => c.id === `${T}sys1`)); const man = td.people.flatMap((p) => p.campaigns).find((c) => c.id === `${T}man1`); const sc = td.people.flatMap((p) => p.campaigns).find((c) => c.id === `${T}sys1`);
  ok('today: the campaign the system launched is Hady’s (by the login, not the token owner), type TEST, product Cup, with the account name', !!mine && sc.source === 'SYSTEM' && sc.type === 'TEST' && sc.product === 'Cup' && sc.by.userId === hadyU.id && !!sc.accountName);
  ok('today: the campaign made by hand in Ads Manager is found from «View history» (type SCALE from its name «Cup - Scale»), by the Facebook actor', !!man && man.source === 'META' && man.type === 'SCALE' && man.actor.name === 'Hady Manual' && man.product === 'Cup');
  ok('a campaign made today has NO result yet (it starts at 12 AM tomorrow): started=false, nothing counted — even though a snapshot exists for today', sc.results.started === false && sc.results.first === null && sc.results.total === null && man.results.first === null && sc.results.firstDay === addDays(today, 1));
  ok('the totals count what the day holds (tests / scales / campaigns); yesterday’s campaign is not in today', td.totals.campaigns >= 2 && td.totals.tests >= 1 && td.totals.scales >= 1 && !td.people.flatMap((p) => p.campaigns).some((c) => c.id === `${T}old1`));
  ok('the day strip is 7 days ending on today, the selected day flagged', td.week.length === 7 && td.week.at(-1).date === today && td.week.at(-1).selected === true && td.week.filter((w) => w.selected).length === 1);
  ok('every chip of the strip counts that day’s campaigns from Meta’s history too (not only the selected day): yesterday 1, 3 days ago 1, today at least 2', td.week.find((w) => w.date === yesterday).campaigns >= 1 && td.week.find((w) => w.date === addDays(today, -3)).campaigns >= 1 && td.week.at(-1).campaigns >= 2, JSON.stringify(td.week.map((w) => w.campaigns)));
  const yd = await B.getBuyerActivity({ date: yesterday, force: true }); const old = yd.people.flatMap((p) => p.campaigns).find((c) => c.id === `${T}old1`);
  ok('made yesterday: its first RESULT is today (the first running day): 100 spend / 1 order / CPA 100, flagged «today, still running»; the creation day’s 120 / 3 is NOT shown', !!old && old.results.started === true && old.results.firstDayIsToday === true && old.results.first.orders === 1 && old.results.first.spend === 100 && old.results.first.cpa === 100 && old.results.total === null, JSON.stringify(old?.results));
  const d3 = await B.getBuyerActivity({ date: addDays(today, -3), force: true }); const older = d3.people.flatMap((p) => p.campaigns).find((c) => c.id === `${T}old2`);
  ok('going back to an older day keeps the strip ending on today (the recent days stay clickable); a far-back day extends it', d3.week.at(-1).date === today && d3.week.find((w) => w.selected)?.date === addDays(today, -3) && d3.week.length === 7 && (await B.getBuyerActivity({ date: addDays(today, -12), force: true })).week.length === 13);
  ok('made 3 days ago: first running day = 80 spend / 2 orders / CPA 40; total since it started (3 days) = 180 spend / 5 orders; the creation day (70 / 9) is never counted', !!older && older.results.first.orders === 2 && older.results.first.spend === 80 && older.results.first.cpa === 40 && older.results.total.orders === 5 && older.results.total.spend === 180 && older.results.totalDays === 3, JSON.stringify(older?.results));
  const calls = world.calls.length; ok('everything asked of Meta was a READ (GET) — nothing written', world.writes === 0 && calls > 0, `${world.writes} writes / ${calls} calls`);
  world.activities.clear(); const quiet = await B.getBuyerActivity({ date: today, force: true });
  ok('if Meta’s history has nothing, the system’s own record still shows the campaign (it is not lost)', quiet.people.flatMap((p) => p.campaigns).some((c) => c.id === `${T}sys1`));
  const fut = await B.getBuyerActivity({ date: addDays(today, 5), force: true }); ok('a future date is clamped to today; a bad date falls back to today', fut.date === today && (await B.getBuyerActivity({ date: 'nonsense', force: true })).date === today);
  const none = await B.getBuyerActivity({ date: '2020-01-01', force: true }); ok('a day with nothing: zero totals, everybody listed as idle, no error', none.totals.campaigns === 0 && none.people.every((p) => p.idle));
} finally {
  await prisma.metaPerformanceSnapshot.deleteMany({ where: { campaign_id: { startsWith: T } } }).catch(() => {});
  await prisma.ambSyncRun.deleteMany({ where: { id: { in: made.runs } } }).catch(() => {});
  await prisma.ambLaunchJob.deleteMany({ where: { job_id: { in: made.jobs } } }).catch(() => {});
  if (made.product) await prisma.product.delete({ where: { id: made.product } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect(); server.close();
}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
