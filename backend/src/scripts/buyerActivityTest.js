// 🧪 «اللي اتعمل النهارده حسب الميديا باير»: the campaigns created on a day (Meta «View history» + the system's own records), who made each one, which account / product, and what they gave
// the same day / the next day. A loopback mock plays the Graph API (read only); isolated test database only.
//   node src/scripts/buyerActivityTest.js
import './_testGuard.js';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };

// ── mock Graph: account info + the activity history of each account (GET only; any other method is recorded as a violation)
const world = { activities: new Map(), calls: [], writes: 0, acts: {} };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); const seg = url.pathname.split('/').filter(Boolean); const id = seg[1], edge = seg[2];
  world.calls.push(`${req.method} ${edge || id}`); if (edge === 'activities') world.acts[id] = (world.acts[id] || 0) + 1; if (req.method !== 'GET') world.writes++;
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

  console.log('\n3b. who sees what');
  const camp = (id, type, key) => ({ id, type, name: id, by: null, actor: null, results: null, _k: key });
  const full = { date: '2026-11-16', scope: 'ALL', team: [{ id: 'm1', name: 'Hady' }, { id: 'm2', name: 'Ahmed' }], people: [{ key: 'm:m1', memberId: 'm1', name: 'Hady', campaigns: [camp('a', 'TEST'), camp('b', 'SCALE')], idle: false }, { key: 'm:m2', memberId: 'm2', name: 'Ahmed', campaigns: [camp('c', 'TEST')], idle: false }, { key: 'a:x', memberId: null, name: 'Stranger', campaigns: [camp('d', 'TEST')], idle: false }], totals: { campaigns: 4, tests: 3, scales: 1, people: 3 }, week: [{ date: '2026-11-16', selected: true, today: true, campaigns: 4, approx: false }, { date: '2026-11-15', selected: false, today: false, campaigns: 9, approx: false }] };
  const self = B.scopeActivity(full, 'm1');
  ok('a media buyer gets ONLY his own card and campaigns — nobody else’s name, work or the unlinked rows', self.scope === 'SELF' && self.people.length === 1 && self.people[0].name === 'Hady' && self.people[0].campaigns.length === 2 && !JSON.stringify(self).includes('Ahmed') && !JSON.stringify(self).includes('Stranger'));
  ok('his totals are his own (2 campaigns: 1 test + 1 scale), no team list is sent, and the strip counts of others are not leaked (left for his own-counts call)', self.totals.campaigns === 2 && self.totals.tests === 1 && self.totals.scales === 1 && self.team.length === 0 && self.week.every((w) => w.campaigns === 0 && w.approx === true));
  ok('the owner (no member) gets the full data untouched', B.scopeActivity(full, null) === full);
  ok('a media buyer with no campaigns today gets an empty (idle) own view, not someone else’s', B.scopeActivity({ ...full, people: full.people.filter((p) => p.memberId !== 'm1') }, 'm1').people.length === 0);

  console.log('\n3c. the owner alert feed (pure)');
  {
    const F = await imp('../services/amb/buyerFeed.js'); const N = await import(pathToFileURL(join(__dirname, '../../../js/buyer-notify.js')).href);
    const act = { people: [{ name: 'Hady', campaigns: [{ id: 'k1', name: 'Cup - Test', type: 'TEST', accountName: 'Hazem', product: 'Cup', at: '2026-11-17T08:00:00Z' }, { id: 'k2', name: 'Cup - Scale', type: 'SCALE', accountName: 'Hazem', at: '2026-11-17T09:00:00Z' }] }, { name: 'Stranger', campaigns: [{ id: 'k3', name: 'X', type: 'OTHER', at: '2026-11-17T07:00:00Z' }] }, { name: 'Idle', campaigns: [] }] };
    const ce = F.campaignEvents(act);
    ok('every campaign becomes one feed event with a stable id, its person, its type and its time (people with nothing created add nothing)', ce.length === 3 && ce[0].id === 'c:k1' && ce[0].who === 'Hady' && ce[1].type === 'SCALE' && ce.every((e) => e.kind === 'CAMPAIGN' && e.at));
    ok('no activity at all (Meta down) → no campaign events, no crash', F.campaignEvents(null).length === 0 && F.campaignEvents({}).length === 0);
    const team = [{ id: 'm1', name: 'Hady', userId: 5 }, { id: 'm2', name: 'Ahmed', userId: 6 }];
    const day = { log: [
      { id: 'l1', action: 'SUBMITTED', taskId: 't1', taskTitle: 'اقفل كامبين', memberId: 'm1', actorId: 5, actorName: 'Hady', text: 'بعت إثبات', at: '2026-11-17T10:00:00Z' },
      { id: 'l2', action: 'STARTED', taskId: 't2', taskTitle: 'اسكيل', memberId: 'm2', actorId: 6, actorName: 'Ahmed', at: '2026-11-17T10:05:00Z' },
      { id: 'l3', action: 'APPROVED', taskId: 't1', taskTitle: 'اقفل كامبين', memberId: 'm1', actorId: 1, actorName: 'Owner', at: '2026-11-17T10:30:00Z' },
      { id: 'l4', action: 'SUBMITTED', taskId: 't3', taskTitle: 'مهمة', memberId: 'm1', actorId: 99, actorName: 'Someone else', at: '2026-11-17T10:40:00Z' },
      { id: 'l5', action: 'NOT_DONE', taskId: 't4', taskTitle: 'مهمة تانية', memberId: 'm2', actorId: 6, actorName: 'Ahmed', at: '2026-11-17T11:00:00Z' },
      { id: 'l6', action: 'NOTE', taskId: 't1', taskTitle: 'x', memberId: 'm1', actorId: 5, at: '2026-11-17T11:10:00Z' },
    ] };
    const te = F.taskEvents(day, team);
    ok('only what a media buyer did on HIS OWN task alerts the owner: submitted / started / not-done — not the owner’s approval, not someone else acting on the task, not a plain note', te.map((e) => e.id).join() === 't:l1,t:l2,t:l5' && te[0].who === 'Hady' && te[0].action === 'SUBMITTED');
    ok('an unlinked team card (no login) can never match an actor', F.taskEvents(day, [{ id: 'm1', name: 'Hady', userId: null }]).length === 0 && F.taskEvents(null, team).length === 0);
    const feed = F.mergeFeed(ce, te); ok('the merged feed is newest first and carries both kinds', feed[0].id === 't:l5' && feed.some((e) => e.kind === 'CAMPAIGN') && feed.some((e) => e.kind === 'TASK') && feed.every((e, i) => i === 0 || feed[i - 1].at >= e.at));
    const d1 = N.describeEvent(ce[0]), d2 = N.describeEvent(ce[1]), d3 = N.describeEvent(ce[2]), d4 = N.describeEvent(te[0]), d5 = N.describeEvent(te[1]);
    ok('the alert wording: «Hady عمل تيست جديد» / «اسكيل جديد» / «كامبين جديد» + the campaign and account on the second line', d1.head === 'Hady عمل تيست جديد' && d1.line === 'Cup - Test · Hazem' && d2.head === 'Hady عمل اسكيل جديد' && d2.icon === 'scale' && d3.head === 'Stranger عمل كامبين جديد');
    ok('task alerts: «بعت إثبات مهمة» / «بدأ مهمة» with the task title', d4.head === 'Hady بعت إثبات مهمة' && d4.line === 'اقفل كامبين' && d5.head === 'Ahmed بدأ مهمة');
    ok('the order sound rings only for a CAMPAIGN (test / scale / other) — a task alert alone is silent, a mixed batch rings once', N.shouldPlaySound([ce[0]]) && N.shouldPlaySound([ce[1]]) && N.shouldPlaySound([te[0], ce[2]]) && !N.shouldPlaySound([te[0], te[1]]) && !N.shouldPlaySound([]) && !N.shouldPlaySound(null));
    const nw = N.pickNew(feed, ['c:k1', 't:l1']); ok('only ids not announced yet are new, oldest first (nothing is announced twice)', nw.map((e) => e.id).join() === 'c:k3,c:k2,t:l2,t:l5' && N.pickNew(feed, feed.map((e) => e.id)).length === 0 && N.pickNew(null, []).length === 0);
  }

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
  { // the owner's live alerts: a campaign made from inside the system is visible at once (database only, no Meta call); one made by hand needs Meta's history
    const c0 = world.calls.length; const fastT = await B.getTodayCampaigns({ fast: true }); const fastAll = fastT.people.flatMap((p) => p.campaigns); const hadyFast = fastAll.find((c) => c.id === sc.id);
    ok('FAST alerts: the campaign the system launched is there at once with its person (Hady), and NOT ONE call went to Meta; the hand-made one (Meta only) is not in the fast read', !!hadyFast && hadyFast.by?.userId === hadyU.id && world.calls.length === c0 && !fastAll.some((c) => c.id === man.id), JSON.stringify([!!hadyFast, world.calls.length - c0]));
    const fullT = await B.getTodayCampaigns({ fast: false, maxAgeMs: 0 }); const fullAll = fullT.people.flatMap((p) => p.campaigns);
    ok('FULL alerts: both the system one and the hand-made one are found (Meta re-read because maxAgeMs=0), nothing written to Meta', fullAll.some((c) => c.id === sc.id) && fullAll.some((c) => c.id === man.id) && world.writes === 0 && world.calls.length > c0);
    const c1 = world.calls.length; await B.getTodayCampaigns({ fast: false, maxAgeMs: 60_000 }); ok('the full read is cached for the asked time (no new Meta call inside it) — Meta is not hammered by the polling', world.calls.length === c1);
  }
  { // the alerts must not compete with a scale for Meta's quota (the scale failed with «Too Many API Calls»)
    const SBm = await imp('../services/amb/scaleBulk.js'); let release; const gate = new Promise((r) => { release = r; });
    SBm._resetForTests(); const batch = SBm.startBulk({ items: [{ sourceCampaignId: 'zz1', label: 'zz', budgetMode: 'CBO', selectedAdIds: ['a'], campaignBudgetEgp: 100 }] }, { exec: () => gate, sleep: async () => {} });
    const c0 = world.calls.length; const during = await B.getTodayCampaigns({ fast: false, maxAgeMs: 0 });
    ok('while a bulk scale is RUNNING the alerts make NO call to Meta at all (the system-made campaigns still show, from the database)', SBm.anyBulkRunning() === true && world.calls.length === c0 && during.people.flatMap((p) => p.campaigns).some((c) => c.id === sc.id), String(world.calls.length - c0));
    release({}); for (let k = 0; k < 100 && SBm.anyBulkRunning(); k++) await new Promise((r) => setTimeout(r, 10)); SBm._resetForTests();
    const c1 = world.calls.length; await B.getTodayCampaigns({ fast: false, maxAgeMs: 0 });
    ok('after the scale finished the alerts read Meta again', SBm.anyBulkRunning() === false && world.calls.length > c1);
    B.markFeedThrottled(ACC, 60_000); const c2 = world.acts[ACC] || 0; const thr = await B.getTodayCampaigns({ fast: false, maxAgeMs: 0 });
    ok('an ad account Meta throttled is left alone (no call) — and the alerts still answer (system-made ones from the database)', (world.acts[ACC] || 0) === c2 && thr.people.flatMap((p) => p.campaigns).some((c) => c.id === sc.id));
    B.markFeedThrottled(ACC, -1); const c3 = world.acts[ACC] || 0; await B.getTodayCampaigns({ fast: false, maxAgeMs: 0 });
    ok('…and it is read again once the pause is over', (world.acts[ACC] || 0) > c3);
  }
  ok('a campaign made today has NO result yet (it starts at 12 AM tomorrow): started=false, nothing counted — even though a snapshot exists for today', sc.results.started === false && sc.results.first === null && sc.results.total === null && man.results.first === null && sc.results.firstDay === addDays(today, 1));
  ok('the totals count what the day holds (tests / scales / campaigns); yesterday’s campaign is not in today', td.totals.campaigns >= 2 && td.totals.tests >= 1 && td.totals.scales >= 1 && !td.people.flatMap((p) => p.campaigns).some((c) => c.id === `${T}old1`));
  ok('the day strip is 7 days ending on today, the selected day flagged', td.week.length === 7 && td.week.at(-1).date === today && td.week.at(-1).selected === true && td.week.filter((w) => w.selected).length === 1);
  ok('the main call is fast: the strip it returns is exact only for the selected day, the other days are flagged approx (system records only) until the separate week call fills them', td.week.find((w) => w.selected).approx === false && td.week.filter((w) => w.approx).length === 6);
  const wk = await B.getWeekStrip({ date: today });
  ok('the week call counts EVERY day from Meta’s history + the system (yesterday ≥ 1, 3 days ago ≥ 1, today ≥ 2), none approx', wk.week.length === 7 && wk.week.every((w) => w.approx === false) && wk.week.find((w) => w.date === yesterday).campaigns >= 1 && wk.week.find((w) => w.date === addDays(today, -3)).campaigns >= 1 && wk.week.at(-1).campaigns >= 2, JSON.stringify(wk.week.map((w) => w.campaigns)));
  const yd = await B.getBuyerActivity({ date: yesterday, force: true }); const old = yd.people.flatMap((p) => p.campaigns).find((c) => c.id === `${T}old1`);
  ok('made yesterday: its first RESULT is today (the first running day): 100 spend / 1 order / CPA 100, flagged «today, still running»; the creation day’s 120 / 3 is NOT shown', !!old && old.results.started === true && old.results.firstDayIsToday === true && old.results.first.orders === 1 && old.results.first.spend === 100 && old.results.first.cpa === 100 && old.results.total === null, JSON.stringify(old?.results));
  const d3 = await B.getBuyerActivity({ date: addDays(today, -3), force: true }); const older = d3.people.flatMap((p) => p.campaigns).find((c) => c.id === `${T}old2`);
  ok('going back to an older day keeps the strip ending on today (the recent days stay clickable); a far-back day extends it', d3.week.at(-1).date === today && d3.week.find((w) => w.selected)?.date === addDays(today, -3) && d3.week.length === 7 && (await B.getBuyerActivity({ date: addDays(today, -12), force: true })).week.length === 13);
  ok('made 3 days ago: first running day = 80 spend / 2 orders / CPA 40; total since it started (3 days) = 180 spend / 5 orders; the creation day (70 / 9) is never counted', !!older && older.results.first.orders === 2 && older.results.first.spend === 80 && older.results.first.cpa === 40 && older.results.total.orders === 5 && older.results.total.spend === 180 && older.results.totalDays === 3, JSON.stringify(older?.results));
  const calls = world.calls.length; ok('everything asked of Meta was a READ (GET) — nothing written', world.writes === 0 && calls > 0, `${world.writes} writes / ${calls} calls`);
  world.activities.clear(); const quiet = await B.getBuyerActivity({ date: today, force: true });
  ok('if Meta’s history has nothing, the system’s own record still shows the campaign (it is not lost)', quiet.people.flatMap((p) => p.campaigns).some((c) => c.id === `${T}sys1`));
  // viewers: the owner account sees all; a media buyer (his login linked to his team card) sees himself; an unlinked login nothing
  { const E = await imp('../services/dailyTasks/engine.js'); const cfg = await E.getConfig(); const hadyM = cfg.team.find((m) => m.name === 'Hady') || cfg.team[0]; const prevLink = hadyM.userId || null; const UID = 987654;
    try {
      await E.updateMember(hadyM.id, { userId: UID });
      const owner = await B.resolveViewer({ id: 1, email: 'mahamoudesmail7@gmail.com', role: 'ADMIN', is_owner: true }); const buyer = await B.resolveViewer({ id: UID, email: 'buyer@example.invalid', role: 'EMPLOYEE' }); const stranger = await B.resolveViewer({ id: 123456789, email: 'x@example.invalid', role: 'ADMIN' }); const anon = await B.resolveViewer(null);
      ok('viewers: the owner account → everyone; a linked media buyer → only his own team card; another ADMIN who is not the owner and not linked → no access; nobody → no access', owner.all === true && buyer.all === false && buyer.memberId === hadyM.id && stranger === null && anon === null, JSON.stringify([owner, buyer, stranger, anon]));
      const wk = await B.getWeekStrip({ date: today, memberId: hadyM.id }); const all = await B.getWeekStrip({ date: today });
      ok('the strip for a media buyer counts only HIS campaigns (≤ the full counts, flagged SELF)', wk.scope === 'SELF' && wk.week.length === all.week.length && wk.week.every((w, i) => w.campaigns <= all.week[i].campaigns && w.approx === false));
    } finally { await E.updateMember(hadyM.id, { userId: prevLink }).catch(() => {}); }
  }
  const fut = await B.getBuyerActivity({ date: addDays(today, 5), force: true }); ok('a future date is clamped to today; a bad date falls back to today', fut.date === today && (await B.getBuyerActivity({ date: 'nonsense', force: true })).date === today);
  const none = await B.getBuyerActivity({ date: '2020-01-01', force: true }); ok('a day with nothing: zero totals, everybody listed as idle, no error', none.totals.campaigns === 0 && none.people.every((p) => p.idle));
  console.log('\n5. the real routes: who may ask, and what each one gets');
  {
    const E = await imp('../services/dailyTasks/engine.js'); const router = (await imp('../routes/buyerActivity.js')).default; const { errorHandler } = await imp('../middleware/errorHandler.js');
    const app = express(); app.use(cookieParser()); app.use(express.json()); app.use('/api/ai-media-buyer/buyer-activity', router); app.use(errorHandler);
    const srv = await new Promise((rs) => { const x = app.listen(0, '127.0.0.1', () => rs(x)); }); const base = `http://127.0.0.1:${srv.address().port}/api/ai-media-buyer/buyer-activity`;
    const mkU = async (tag, role, email = null) => { const e = email || `${T}${tag}@example.invalid`; const ex = await prisma.user.findFirst({ where: { email: e } }); if (ex) return { u: ex, made: false }; const u = await prisma.user.create({ data: { email: e, password_hash: 'x'.repeat(20), name: `${T}${tag}`, role, status: 'ACTIVE', permissions: '{}' } }); return { u, made: true }; };
    const cfg = await E.getConfig(); const hadyM = cfg.team.find((m) => m.name === 'Hady') || cfg.team[0]; const prevLink = hadyM.userId || null;
    const bu = await mkU('buyer', 'EMPLOYEE'); const st = await mkU('stranger', 'ADMIN'); const ow = await mkU('owner', 'ADMIN', 'mahamoudesmail7@gmail.com');
    const get = async (u, path = '/', method = 'GET', body) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(u ? { cookie: `token=${jwt.sign({ id: u.id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '10m' })}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
    try {
      await E.updateMember(hadyM.id, { userId: bu.u.id });
      ok('no login → 401', (await get(null)).status === 401);
      const rS = await get(st.u); ok('an ADMIN who is not the owner and not linked to a media buyer → 403 «حسابك مش مربوط» (the section is the owner’s and the buyers’ own)', rS.status === 403 && rS.json?.error === 'NOT_LINKED');
      const rB = await get(bu.u); ok('a media buyer asks for the day: he gets scope SELF, only his own card (his team member), no team list', rB.status === 200 && rB.json.scope === 'SELF' && rB.json.people.every((x) => x.memberId === hadyM.id) && rB.json.team.length === 0, JSON.stringify([rB.status, rB.json?.scope, rB.json?.people?.map((x) => x.name)]));
      const rO = await get(ow.u); ok('the owner account gets EVERYTHING (all media buyers + the team list)', rO.status === 200 && rO.json.scope !== 'SELF' && rO.json.people.length >= rB.json.people.length && rO.json.team.length > 1);
      const wB = await get(bu.u, '/week'); ok('the strip for the buyer counts only his work', wB.status === 200 && wB.json.scope === 'SELF');
      const repB = await get(bu.u, '/report?mode=yesterday'); ok('his report is his own too (scope SELF, only his card)', repB.status === 200 && repB.json.scope === 'SELF' && repB.json.people.every((x) => x.memberId === hadyM.id));
      const alB = await get(bu.u, '/aliases', 'PUT', { actorId: 'x', memberId: hadyM.id }); ok('a media buyer cannot link names (owner only)', alB.status === 403);
      const fB = await get(bu.u, '/feed'); const fS = await get(st.u, '/feed'); const fO = await get(ow.u, '/feed'); const fN = await get(null, '/feed');
      ok('the alert feed is the OWNER’s: a media buyer → 403, another ADMIN → 403, nobody → 401; the owner gets the feed', fB.status === 403 && fS.status === 403 && fN.status === 401 && fO.status === 200 && Array.isArray(fO.json.events) && typeof fO.json.date === 'string' && typeof fO.json.now === 'string', JSON.stringify([fB.status, fS.status, fN.status, fO.status]));
      const fF = await get(ow.u, '/feed?fast=1'); const fFB = await get(bu.u, '/feed?fast=1'); ok('the fast feed is the owner’s too (200 for the owner with events array, 403 for a media buyer)', fF.status === 200 && Array.isArray(fF.json.events) && fFB.status === 403);
      ok('and what the buyer is refused does not leak the others’ names', !JSON.stringify(fB.json).includes('Ahmed'));
      const alO = await get(ow.u, '/aliases', 'PUT', { actorId: 'x', memberId: 'no-such-member' }); ok('the owner can (a wrong member is a 400, not a 403)', alO.status === 400);
    } finally {
      await E.updateMember(hadyM.id, { userId: prevLink }).catch(() => {}); srv.close();
      for (const x of [bu, st, ow]) if (x.made) await prisma.user.delete({ where: { id: x.u.id } }).catch(() => {});
    }
  }
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
