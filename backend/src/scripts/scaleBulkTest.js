// 🧪 Bulk Scale — the sequencer around executeScale (mocked): validation, one-at-a-time order, gap between campaigns, per-item failure isolation, cancel, no overlap.
//   node src/scripts/scaleBulkTest.js
import './_testGuard.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const SB = await import(pathToFileURL(join(__dirname, '../services/amb/scaleBulk.js')).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitDone = async (id) => { for (let i = 0; i < 200; i++) { const b = SB.getBatch(id); if (b && b.status !== 'RUNNING') return b; await wait(5); } return SB.getBatch(id); };

const cbo = (id, extra = {}) => ({ sourceCampaignId: id, label: `camp ${id}`, budgetMode: 'CBO', selectedAdIds: ['a1', 'a2'], campaignBudgetEgp: 300, ...extra });
const abo = (id) => ({ sourceCampaignId: id, label: `camp ${id}`, budgetMode: 'ABO', adSets: [{ dailyBudgetEgp: 150, selectedAdIds: ['a1'] }] });

console.log('\n1. validation (nothing starts when anything is wrong)');
SB._resetForTests();
let calls = 0; const exec = async () => { calls++; return {}; };
ok('empty selection rejected', throws(() => SB.startBulk({ items: [] }, { exec })) !== null);
ok('more than the max rejected', throws(() => SB.startBulk({ items: Array.from({ length: SB.MAX_ITEMS + 1 }, (_, i) => cbo(String(i))) }, { exec })) !== null);
ok('duplicate campaign rejected', throws(() => SB.startBulk({ items: [cbo('1'), cbo('1')] }, { exec }))?.message.includes('متكرر'));
ok('CBO without budget rejected', throws(() => SB.startBulk({ items: [cbo('1', { campaignBudgetEgp: 0 })] }, { exec }))?.message.includes('ميزانية'));
ok('CBO without ads rejected', throws(() => SB.startBulk({ items: [cbo('1', { selectedAdIds: [] })] }, { exec }))?.message.includes('إعلانًا'));
ok('ABO slot without budget rejected', throws(() => SB.startBulk({ items: [{ ...abo('1'), adSets: [{ dailyBudgetEgp: 0, selectedAdIds: ['a'] }] }] }, { exec })) !== null);
ok('missing budget mode rejected', throws(() => SB.startBulk({ items: [{ sourceCampaignId: '1' }] }, { exec })) !== null);
ok('gap below the minimum rejected', throws(() => SB.startBulk({ items: [cbo('1')], gapSeconds: 5 }, { exec })) !== null);
ok('one bad campaign among good ones → the whole request is rejected, exec never called', throws(() => SB.startBulk({ items: [cbo('1'), cbo('2', { campaignBudgetEgp: -1 })] }, { exec })) !== null && calls === 0);

console.log('\n2. schedule must leave room for the last campaign');
const now = Date.UTC(2026, 10, 7, 10, 0, 0);
const toUtc = (d, t) => { const [y, m, dd] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return new Date(Date.UTC(y, m - 1, dd, h - 2, mi)); };
ok('start time too soon for 3 campaigns × 60s → rejected', throws(() => SB.startBulk({ items: [cbo('1'), cbo('2'), cbo('3')], startMode: 'SCHEDULE', startAt: '2026-11-07T12:02' }, { exec, now: () => now, toUtc }))?.message.includes('قريب'));
ok('invalid date rejected', throws(() => SB.startBulk({ items: [cbo('1')], startMode: 'SCHEDULE', startAt: 'x' }, { exec, now: () => now, toUtc })) !== null);
SB._resetForTests();
const sched = SB.startBulk({ items: [cbo('1'), cbo('2')], startMode: 'SCHEDULE', startAt: '2026-11-08T00:00', gapSeconds: 30 }, { exec: async () => ({}), now: () => now, toUtc, sleep: async () => {} });
ok('a far enough schedule is accepted', sched.status === 'RUNNING' && sched.startMode === 'SCHEDULE');
await waitDone(sched.id);

console.log('\n3. runs one at a time, in order, with the gap between them');
SB._resetForTests();
const log = []; let running = 0; let maxRunning = 0; const sleeps = [];
const exec3 = async (a) => { running++; maxRunning = Math.max(maxRunning, running); log.push(a.sourceCampaignId); await wait(5); running--; return { scaleCampaignName: `${a.sourceCampaignId} - Scale`, adSetsCreated: 1, adsCreated: 2, decisionId: Number(a.sourceCampaignId) }; };
const b3 = SB.startBulk({ items: [cbo('1'), abo('2'), cbo('3')], gapSeconds: 60 }, { exec: exec3, sleep: async (ms) => { sleeps.push(ms); } });
ok('returns immediately as RUNNING (does not block on Meta)', b3.status === 'RUNNING' && b3.counts.total === 3);
const d3 = await waitDone(b3.id);
ok('all three done, in the selected order', d3.status === 'DONE' && log.join(',') === '1,2,3' && d3.counts.done === 3);
ok('never two at the same time', maxRunning === 1);
ok('a 60s wait between campaigns (2 waits for 3 campaigns, none after the last)', sleeps.length === 2 && sleeps.every((ms) => ms === 60000));
ok('the result of each is kept', d3.items[1].result?.scaleCampaignName === '2 - Scale' && d3.items[0].result.adsCreated === 2);

console.log('\n4. exec receives exactly the approved config (budget mode, budget, ads, start mode, account)');
SB._resetForTests();
const seen = [];
const b4 = SB.startBulk({ items: [cbo('1', { campaignBudgetEgp: 450, selectedAdIds: ['x', 'x', 'y'] }), abo('2')], startMode: 'RUN_NOW', windowName: 'today', userId: 7, adAccountId: 'act_9' }, { exec: async (a) => { seen.push(a); return {}; }, sleep: async () => {} });
await waitDone(b4.id);
ok('CBO args', seen[0].budgetMode === 'CBO' && seen[0].campaignBudgetEgp === 450 && seen[0].selectedAdIds.join() === 'x,y' && seen[0].startMode === 'RUN_NOW' && seen[0].userId === 7 && seen[0].adAccountId === 'act_9');
ok('every campaign waits for its clone for the long bulk timeout (not the 2-minute single default)', seen.every((a) => a.waitTimeoutMs === SB.WAIT_PER_CAMPAIGN_MS && a.waitTimeoutMs === 5 * 60_000 && a.waitTimeoutMs > 120000));
ok('ABO args', seen[1].budgetMode === 'ABO' && seen[1].adSets[0].dailyBudgetEgp === 150 && seen[1].selectedAdIds === undefined);

console.log('\n5. one failure never stops the rest');
SB._resetForTests();
const b5 = SB.startBulk({ items: [cbo('1'), cbo('2'), cbo('3')] }, { exec: async (a) => { if (a.sourceCampaignId === '2') throw new Error('Meta rejected'); return {}; }, sleep: async () => {} });
const d5 = await waitDone(b5.id);
ok('1 and 3 done, 2 failed with its reason', d5.items[0].status === 'DONE' && d5.items[1].status === 'FAILED' && d5.items[1].error === 'Meta rejected' && d5.items[2].status === 'DONE');
ok('the batch finishes (DONE) with counts', d5.status === 'DONE' && d5.counts.failed === 1 && d5.counts.done === 2);

console.log('\n6. a second bulk cannot start while one is running; it can after');
SB._resetForTests();
let release; const gate = new Promise((r) => { release = r; });
const b6 = SB.startBulk({ items: [cbo('1')] }, { exec: async () => { await gate; return {}; }, sleep: async () => {} });
ok('second start while running → 409', throws(() => SB.startBulk({ items: [cbo('9')] }, { exec }))?.status === 409);
ok('currentBatch is the running one', SB.currentBatch()?.id === b6.id);
release(); await waitDone(b6.id);
ok('after it finishes a new one is allowed', throws(() => { const x = SB.startBulk({ items: [cbo('9')] }, { exec: async () => ({}), sleep: async () => {} }); return x; }) === null);
await wait(20);

console.log('\n7. cancel stops the campaigns that have not started (the finished ones stay)');
SB._resetForTests();
let wake; const wakeP = new Promise((r) => { wake = r; });
const done7 = [];
const b7 = SB.startBulk({ items: [cbo('1'), cbo('2'), cbo('3')] }, { exec: async (a) => { done7.push(a.sourceCampaignId); return {}; }, sleep: async () => { await wakeP; } });
await wait(20);
SB.cancelBatch(b7.id); wake();
const d7 = await waitDone(b7.id);
ok('first done, the others canceled and never executed', done7.join() === '1' && d7.items[1].status === 'CANCELED' && d7.items[2].status === 'CANCELED' && d7.status === 'CANCELED' && d7.counts.skipped === 2);
ok('unknown batch → 404', throws(() => SB.cancelBatch('nope'))?.status === 404);
ok('latestBatch returns the most recent', SB.latestBatch()?.id === b7.id);

console.log('\n7b. a Meta rate limit stops the whole bulk (nothing else is started)');
SB._resetForTests();
const ran7b = [];
const b7b = SB.startBulk({ items: [cbo('1'), cbo('2'), cbo('3'), cbo('4')] }, { exec: async (a) => { ran7b.push(a.sourceCampaignId); if (a.sourceCampaignId === '2') throw new Error('فشل إنشاء حملة الاسكيل: User request limit reached — Ad Account Has Too Many API Calls'); return {}; }, sleep: async () => {} });
const d7b = await waitDone(b7b.id);
ok('1 done, 2 failed by the throttle, 3 and 4 never started', ran7b.join() === '1,2' && d7b.items[0].status === 'DONE' && d7b.items[1].status === 'FAILED' && d7b.items[2].status === 'CANCELED' && d7b.items[3].status === 'CANCELED');
ok('the batch says why it stopped (rate limit) and the skipped ones carry the message', d7b.stopReason === 'RATE_LIMIT' && d7b.status === 'CANCELED' && d7b.items[2].error === SB.RATE_LIMIT_STOP_MSG);
SB._resetForTests();
const ran7c = [];
const b7c = SB.startBulk({ items: [cbo('1'), cbo('2'), cbo('3')] }, { exec: async (a) => { ran7c.push(a.sourceCampaignId); if (a.sourceCampaignId === '1') throw new Error('Invalid creative'); return {}; }, sleep: async () => {} });
const d7c = await waitDone(b7c.id);
ok('an ordinary failure (not the throttle, not a wait timeout) does NOT stop the rest', ran7c.join() === '1,2,3' && d7c.stopReason === null && d7c.status === 'DONE');
SB._resetForTests();
const ran7d = [];
const b7d = SB.startBulk({ items: [cbo('1'), cbo('2'), cbo('3')] }, { exec: async (a) => { ran7d.push(a.sourceCampaignId); if (a.sourceCampaignId === '1') throw new Error('انتهت مهلة الانتظار والنسخ لسه شغال على ميتا (CLONING)'); return {}; }, sleep: async () => {} });
const d7d = await waitDone(b7d.id);
ok('a clone still running after the wait (5 min) STOPS the bulk — the next one is not started behind it', ran7d.join() === '1' && d7d.stopReason === 'WAIT_TIMEOUT' && d7d.items[1].status === 'CANCELED' && d7d.items[1].error === SB.WAIT_STOP_MSG && d7d.status === 'CANCELED');
ok('the timeout item gets the «resume, never re-scale» hint', d7d.items[0].hint?.kind === 'WAIT_TIMEOUT' && d7d.items[0].hint.retry === 'RESUME');
ok('the throttle pattern matches Meta codes and messages, not ordinary errors', SB.META_THROTTLE_RE.test('(#17) User request limit reached') && SB.META_THROTTLE_RE.test('Too many calls') && !SB.META_THROTTLE_RE.test('Invalid creative'));

console.log('\n8. a clone that finishes AFTER the wait gave up is settled correctly (no duplicate-scale card)');
const SW = await import(pathToFileURL(join(__dirname, '../services/amb/scaleWinners.js')).href);
const camp = { level: 'CAMPAIGN', status: 'CREATED', destination_id: '123' };
ok('still cloning → PENDING (left alone)', SW.classifyScaleOutcome([{ status: 'CLONING' }], []).status === 'PENDING');
ok('one job pending among terminal ones → PENDING', SW.classifyScaleOutcome([{ status: 'SCHEDULED_NATIVE' }, { status: 'PENDING' }], [camp]).status === 'PENDING');
ok('scheduled-native + campaign created → EXECUTED', SW.classifyScaleOutcome([{ status: 'SCHEDULED_NATIVE' }], [camp]).status === 'EXECUTED');
ok('cloned-paused + campaign created → EXECUTED', SW.classifyScaleOutcome([{ status: 'CLONED_PAUSED' }], [camp]).status === 'EXECUTED');
ok('terminal OK but no campaign was created → FAILED', SW.classifyScaleOutcome([{ status: 'CLONED_PAUSED' }], []).status === 'FAILED');
ok('a failed object → FAILED with its error', (() => { const r = SW.classifyScaleOutcome([{ status: 'SCHEDULED_NATIVE' }], [camp, { level: 'AD', status: 'FAILED', error: 'bad creative' }]); return r.status === 'FAILED' && r.error === 'bad creative'; })());
ok('job FAILED → FAILED with the job error', (() => { const r = SW.classifyScaleOutcome([{ status: 'FAILED', error: 'Meta said no' }], []); return r.status === 'FAILED' && r.error === 'Meta said no'; })());
ok('no job at all → FAILED', SW.classifyScaleOutcome([], []).status === 'FAILED');

console.log('\n9. orphaned clone batches (a restart killed the worker) are re-kicked safely');
const CE = await import(pathToFileURL(join(__dirname, '../services/amb/cloneEngine.js')).href);
{
  const now = new Date('2026-11-07T17:00:00Z');
  const ago = (min) => new Date(now.getTime() - min * 60000);
  const mk = (id, status, jobStatus, extra = {}) => ({ batch_id: id, status, jobs: [{ status: jobStatus, scheduled_activation_at: null, ...extra }] });
  const sel = (batches, { running = [], audit = {}, tries = {} } = {}) => CE.selectOrphanedBatches({ batches, runningIds: new Set(running), lastAuditAt: new Map(Object.entries(audit)), tries: new Map(Object.entries(tries)), now });
  ok('CLONING with no worker and 10 quiet minutes → recovered', sel([mk('a', 'CLONING', 'CLONING')], { audit: { a: ago(10) } }).join() === 'a');
  ok('APPROVED + PENDING job with no worker → recovered', sel([mk('a', 'APPROVED', 'PENDING')], { audit: { a: ago(30) } }).join() === 'a');
  ok('a batch with a live worker is NEVER touched', sel([mk('a', 'CLONING', 'CLONING')], { running: ['a'], audit: { a: ago(60) } }).length === 0);
  ok('recent activity (< 5 min) → left alone', sel([mk('a', 'CLONING', 'CLONING')], { audit: { a: ago(2) } }).length === 0);
  ok('finished jobs → nothing to recover', sel([mk('a', 'CLONING', 'SCHEDULED_NATIVE')], { audit: { a: ago(30) } }).length === 0);
  ok('COMPLETED / FAILED batches are not this function’s business', sel([mk('a', 'COMPLETED', 'CLONING'), mk('b', 'FAILED', 'PENDING')], { audit: { a: ago(30), b: ago(30) } }).length === 0);
  ok('scheduled start already passed → not recovered', sel([mk('a', 'CLONING', 'CLONING', { scheduled_activation_at: ago(5) })], { audit: { a: ago(30) } }).length === 0);
  ok('at most once per 10 minutes', sel([mk('a', 'CLONING', 'CLONING')], { audit: { a: ago(30) }, tries: { a: [ago(4)] } }).length === 0);
  ok('again after the gap', sel([mk('a', 'CLONING', 'CLONING')], { audit: { a: ago(30) }, tries: { a: [ago(12)] } }).join() === 'a');
  ok('capped at 5 attempts per batch', sel([mk('a', 'CLONING', 'CLONING')], { audit: { a: ago(60) }, tries: { a: [ago(20), ago(30), ago(40), ago(50), ago(60)] } }).length === 0);
  ok('only the orphan among several is picked', sel([mk('a', 'CLONING', 'CLONING'), mk('b', 'CLONING', 'CLONING')], { running: ['a'], audit: { a: ago(30), b: ago(30) } }).join() === 'b');
}

console.log('\n10. «للمتابعة فقط» accounts: the ads of the winning campaigns are read live (so a scale is possible there)');
const LT = await import(pathToFileURL(join(__dirname, '../services/amb/liveCampaignTree.js')).href);
{
  const ads = [{ id: 'a1', name: 'Ad 1', adset_id: 's1', adset: { name: 'Set 1' }, creative: { id: 'c1' }, campaign: { daily_budget: '20000' } }, { id: 'a2', name: 'Ad 2', adset_id: 's1', adset: { name: 'Set 1' }, creative: { id: 'c2' } }, { id: 'a3', name: 'Ad 3', adset_id: 's2', adset: { name: 'Set 2' } }];
  const insights = [{ ad_id: 'a1', spend: '120', actions: [{ action_type: 'purchase', value: '3' }] }, { ad_id: 'a2', spend: '50', actions: [{ action_type: 'link_click', value: '9' }] }];
  const tree = LT.buildLiveTree({ ads, insights });
  ok('ads grouped under their ad sets (names come with the ads read) with the creative id', tree.length === 2 && tree[0].name === 'Set 1' && tree[0].children.length === 2 && tree[0].children[0].creativeId === 'c1' && tree[1].children[0].creativeId === null);
  ok('purchases + CPA come from the per-ad insights (cpa = spend / purchases)', tree[0].children[0].metrics.purchases === 3 && tree[0].children[0].metrics.cpa === 40 && tree[0].children[0].metrics.spend === 120);
  ok('an ad with spend but no purchase has 0 purchases and NO cpa (never a fake number)', tree[0].children[1].metrics.purchases === 0 && tree[0].children[1].metrics.cpa === null);
  ok('an ad with no insight row at all → zero metrics', tree[1].children[0].metrics.purchases === 0 && tree[1].children[0].metrics.spend === 0);
  ok('no ads → no ad sets', LT.buildLiveTree({ ads: [], insights: [] }).length === 0);
  ok('CBO budget (minor → major) comes from the campaign expansion; no expansion budget → null (ABO)', LT.campaignBudgetFromAds(ads) === 200 && LT.campaignBudgetFromAds([{ id: 'x', campaign: {} }]) === null && LT.campaignBudgetFromAds([]) === null);
}
{
  LT._cacheForTests.clear(); LT._cooldownForTests.clear();
  const W = { from: '2026-11-07', to: '2026-11-07' };
  let reads = 0;
  const reader = { ads: async () => { reads++; return [{ id: 'a1', name: 'A', adset_id: 's1', adset: { name: 'S' }, creative: { id: 'c1' }, campaign: { daily_budget: '20000' } }]; }, insights: async () => [{ ad_id: 'a1', spend: '60', actions: [{ action_type: 'purchase', value: '2' }] }] };
  const camps = [{ id: 'k1' }, { id: 'k2' }];
  await LT.hydrateCampaigns({ token: 't', camps, window: W, adAccountId: 'act_1' }, { reader });
  ok('campaigns get their ads, CPA and CBO budget', camps.every((c) => c.__live && c.children[0].children[0].metrics.cpa === 30 && c.budget === 200));
  await LT.hydrateCampaigns({ token: 't', camps: [{ id: 'k1' }], window: W, adAccountId: 'act_1' }, { reader });
  ok('a second read inside 5 minutes is served from the cache (no extra Meta calls)', reads === 2);
  // throttle: the stale copy is served, the account cools down
  const throttled = { ads: async () => { throw new Error('(#17) User request limit reached'); }, insights: async () => [] };
  const again = [{ id: 'k1' }];
  await LT.hydrateCampaigns({ token: 't', camps: again, window: W, adAccountId: 'act_1' }, { reader: throttled, now: () => LT._cacheForTests.get('k1|2026-11-07|2026-11-07').at + 6 * 60_000 });
  ok('on a throttle the LAST GOOD copy (older than 5 min, younger than 1 h) is served instead of an empty card', again[0].__live === true && !again[0].__adsError);
  ok('the throttled account is on cool-down', (LT._cooldownForTests.get('act_1') || 0) > 0);
  const fresh = [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }];
  let calls = 0;
  await LT.hydrateCampaigns({ token: 't', camps: fresh, window: W, adAccountId: 'act_2', concurrency: 1 }, { reader: { ads: async () => { calls++; throw new Error('Too many calls'); }, insights: async () => [] } });
  ok('no copy at all → friendly message on every card; after the FIRST throttle nothing else is read', fresh.every((c) => c.__adsError === LT.THROTTLED_MSG && !c.__live) && calls === 1);
  const cooled = [{ id: 'm1' }]; let c2 = 0;
  await LT.hydrateCampaigns({ token: 't', camps: cooled, window: W, adAccountId: 'act_2' }, { reader: { ads: async () => { c2++; return []; }, insights: async () => [] } });
  ok('while cooling down, Meta is not called at all', c2 === 0 && cooled[0].__adsError === LT.THROTTLED_MSG);
  const other = [{ id: 'q1' }];
  await LT.hydrateCampaigns({ token: 't', camps: other, window: W, adAccountId: 'act_3' }, { reader: { ads: async () => { throw new Error('Invalid parameter'); }, insights: async () => [] } });
  ok('a NON-throttle error is shown as is and does NOT start a cool-down', other[0].__adsError === 'Invalid parameter' && !LT._cooldownForTests.has('act_3'));
}

console.log('\n11. a creative Meta rejects for a missing link: sibling URL fallback, else «needs input» (not a dead-end failure)');
{
  ok('the Meta message is recognised', CE.isLinkRequiredError(new Error('Invalid parameter — Required Field Is Missing: The link field is required')) === true && CE.isLinkRequiredError(new Error('Image Not Found')) === false);
  const base = { name: 'c', object_story_spec: { page_id: '1', link_data: { message: 'm', image_hash: 'h', call_to_action: { type: 'SHOP_NOW', value: {} } } } };
  ok('a creative with no link → extract gives null', CE.extractCreativeLink(base) === null);
  const fixed = CE.injectCreativeLink(base, 'https://shop.example/p');
  ok('the URL is set on link_data and its CTA; the original payload is untouched', fixed.object_story_spec.link_data.link === 'https://shop.example/p' && fixed.object_story_spec.link_data.call_to_action.value.link === 'https://shop.example/p' && base.object_story_spec.link_data.link === undefined);
  ok('an existing link is NEVER overwritten', CE.injectCreativeLink({ object_story_spec: { link_data: { link: 'https://keep.me' } } }, 'https://other').object_story_spec.link_data.link === 'https://keep.me');
  ok('video creatives get the CTA link', CE.injectCreativeLink({ object_story_spec: { video_data: { video_id: 'v', call_to_action: { type: 'SHOP_NOW' } } } }, 'https://u').object_story_spec.video_data.call_to_action.value.link === 'https://u');
  ok('the sibling URL is recovered from a stored payload_json, even when it was cut at 6000 chars', CE.linkFromPayloadJson(JSON.stringify({ object_story_spec: { link_data: { link: 'https://p.example/x' } } })) === 'https://p.example/x' && CE.linkFromPayloadJson('{"object_story_spec":{"link_data":{"message":"cut here ... "link":"https://cut.example/y","name":"abc') === 'https://cut.example/y' && CE.linkFromPayloadJson('') === null && CE.linkFromPayloadJson('{"a":1}') === null);
  ok('the campaign URL is read from the SOURCE creatives (first one that has one; errors skipped)', CE.linkFromSourceCreatives(new Map([['1', { __error: 'x' }], ['2', { object_story_spec: { link_data: {} } }], ['3', { object_story_spec: { video_data: { call_to_action: { value: { link: 'https://src.example/z' } } } } }]])) === 'https://src.example/z' && CE.linkFromSourceCreatives(new Map()) === null && CE.linkFromSourceCreatives(null) === null);
  ok('extract finds the URL in link_data / video CTA / feed', CE.extractCreativeLink({ object_story_spec: { link_data: { link: 'https://a' } } }) === 'https://a' && CE.extractCreativeLink({ object_story_spec: { video_data: { call_to_action: { value: { link: 'https://b' } } } } }) === 'https://b' && CE.extractCreativeLink({ asset_feed_spec: { link_urls: [{ website_url: 'https://c' }] } }) === 'https://c');
}
ok('a report-only account is recognised', SW.isReportOnlyAccount({ ambReportOnlyAccountIds: ['act_1', 'act_2'] }, 'act_2') === true);
ok('an operated account is not', SW.isReportOnlyAccount({ ambReportOnlyAccountIds: ['act_1'] }, 'act_9') === false);
ok('no setting → not report-only', SW.isReportOnlyAccount({}, 'act_1') === false && SW.isReportOnlyAccount(null, 'act_1') === false);
ok('ids compare as strings', SW.isReportOnlyAccount({ ambReportOnlyAccountIds: [123] }, '123') === true);

console.log('\n12. every failure says what it means and what to do (no raw Meta text left alone)');
{
  const SE = await import(pathToFileURL(join(__dirname, '../services/amb/scaleErrors.js')).href);
  const k = (m) => SE.classifyScaleError(m);
  ok('Meta throttle → wait', k('فشل إنشاء حملة الاسكيل: User request limit reached — Ad Account Has Too Many API Calls').kind === 'THROTTLE' && k('(#17) x').retry === 'WAIT' && k(SB.RATE_LIMIT_STOP_MSG).kind === 'THROTTLE');
  ok('wait timeout → resume, never re-scale', k('انتهت مهلة الانتظار والنسخ لسه شغال على ميتا (CLONING)').kind === 'WAIT_TIMEOUT' && k('انتهت المهلة والـ job لسه في حالة CLONING.').retry === 'RESUME');
  ok('missing link → resume', k('Invalid parameter — Required Field Is Missing: The link field is required').kind === 'MISSING_LINK' && k('هذا الإعلان يحتاج رابط وجهة').retry === 'RESUME');
  ok('no creative → resume', k('لا يوجد كرياتيف صالح للإعلان.').kind === 'NO_CREATIVE' && k('لا يوجد كرياتيف صالح للإعلان.').retry === 'RESUME');
  ok('ads could not be read → nothing was written, safe to scale again', k('تعذّر قراءة إعلانات الحملة من ميتا: x').kind === 'ADS_UNREADABLE' && k('تعذّر قراءة إعلانات الحملة من ميتا: x').retry === 'RESCALE');
  ok('permission errors are recognised', k('Error validating access token: Session has expired').kind === 'PERMISSION');
  ok('anything else → a safe generic instruction (check the clone log first)', k('something odd').kind === 'UNKNOWN' && /استنساخ وجدولة/.test(k('something odd').action) && k('').kind === 'UNKNOWN');
  ok('every rule has a title and an action in Arabic', ['User request limit reached', 'انتهت المهلة والـ job', 'link field is required', 'لا يوجد كرياتيف صالح', 'تعذّر قراءة إعلانات الحملة', 'Error validating access token', 'zzz'].every((m) => /[؀-ۿ]/.test(k(m).title) && /[؀-ۿ]/.test(k(m).action)));
  SB._resetForTests();
  const bh = SB.startBulk({ items: [cbo('1'), cbo('2')] }, { exec: async (a) => { if (a.sourceCampaignId === '1') throw new Error('لا يوجد كرياتيف صالح للإعلان.'); return {}; }, sleep: async () => {} });
  const dh = await waitDone(bh.id);
  ok('the bulk progress carries the hint for a failed item (and none for the others)', dh.items[0].hint?.kind === 'NO_CREATIVE' && dh.items[0].hint.retry === 'RESUME' && dh.items[1].hint === null);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
