// 🧯 Clone & Schedule × Meta throttle («User request limit reached — Ad Account Has Too Many API Calls»): a TEMPORARY Meta limit must never become a permanent «محجوبة» verdict.
//   1. isMetaThrottle classifies the throttle codes / messages (and nothing else)
//   2. a copy that was blocked ONLY by a throttled source read is put back to PENDING (so «استئناف» re-reads it) — real blocks stay blocked
//   3. the preview turns a throttled read into a WARNING row (never BLOCKED), a real read error still blocks
//   node src/scripts/cloneThrottleTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };

// a loopback Meta mock (the graph client honours META_GRAPH_MOCK only for 127.0.0.1)
const hits = []; let mode = 'ok';
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); hits.push(u.pathname + '?' + u.searchParams.toString().slice(0, 60));
  const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const ids = (u.searchParams.get('ids') || '').split(',').filter(Boolean);
  if (mode === 'missing') return json(400, { error: { message: 'Unsupported get request. Object does not exist', code: 100, type: 'GraphMethodException' } });
  if (mode === 'throttle') return json(400, { error: { message: '(#17) User request limit reached', code: 17, type: 'OAuthException' } });
  if (ids.length) { if (ids.includes('999')) return json(400, { error: { message: 'Unsupported get request. Object with ID 999 does not exist', code: 100, type: 'GraphMethodException' } }); return json(200, Object.fromEntries(ids.map((i) => [i, { id: i, name: 'cr' + i }]))); }
  const one = u.pathname.split('/').pop(); if (one === '999') return json(400, { error: { message: 'Unsupported get request. Object with ID 999 does not exist', code: 100, type: 'GraphMethodException' } });
  return json(200, { id: one, name: 'cr' + one });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.META_GRAPH_MOCK = '1'; process.env.META_GRAPH_MOCK_URL = 'http://127.0.0.1:' + mock.address().port;
const { prisma } = await imp('../prisma.js');
process.env.CLONE_THROTTLE_WAIT_MS = '0'; // no real waiting in tests
const { isMetaThrottle, rearmThrottleBlockedJobs, withThrottleRetry, applyCampaignBudget, buildAdSetPayload } = await imp('../services/amb/cloneEngine.js');

console.log('\n1. Throttle classification');
const err = (message, extra = {}) => Object.assign(new Error(message), extra);
ok('the exact message from the owner’s screenshot is a throttle', isMetaThrottle(err('User request limit reached — Ad Account Has Too Many API Calls: There have been too many calls from this ad-account. Please wait a bit and try again.')));
ok('graph codes 4 / 17 / 32 / 613 / 80004 are throttles', [4, 17, 32, 613, 80004].every((c) => isMetaThrottle(err('x', { graphCode: c }))));
ok('the graph client’s own isMetaRateLimit flag counts', isMetaThrottle(err('x', { isMetaRateLimit: true })));
ok('real problems are NOT throttles (permissions, bad payload, unknown object, auth)', [err('Unsupported get request. Object with ID does not exist', { graphCode: 100 }), err('Invalid OAuth access token', { graphCode: 190 }), err('(#200) Requires ads_management permission', { graphCode: 200 }), err('Invalid parameter', { graphCode: 100, graphSubcode: 1487 })].every((e) => !isMetaThrottle(e)));
ok('null / undefined are safe', !isMetaThrottle(null) && !isMetaThrottle(undefined));

console.log('\n2. Copies blocked only by a throttled read are re-armed; real blocks are left alone');
const bid = `throttle-test-${Date.now()}`;
await prisma.ambCloneBatch.create({ data: { batch_id: bid, source_ad_account_id: 'act_1', destination_account_ids_json: '["act_2"]', campaign_ids_json: '["c1","c2","c3","c4"]', status: 'FAILED', total_copies: 4 } });
const mk = (cid, checks) => prisma.ambCloneJob.create({ data: { batch_id: bid, source_ad_account_id: 'act_1', destination_ad_account_id: 'act_2', source_campaign_id: cid, status: 'PREFLIGHT_BLOCKED', preflight_status: 'BLOCKED', preflight_json: JSON.stringify({ status: 'BLOCKED', checks }), error: 'محجوب' } });
const THR = 'User request limit reached — Ad Account Has Too Many API Calls: There have been too many calls from this ad-account. Please wait a bit and try again.';
const jThrottle = await mk('c1', [{ name: 'قراءة الحملة المصدر', status: 'BLOCK', detail: THR }]);
const jRealRead = await mk('c2', [{ name: 'قراءة الحملة المصدر', status: 'BLOCK', detail: 'Unsupported get request. Object with ID does not exist' }]);
const jInactive = await mk('c3', [{ name: 'حساب الوجهة', status: 'BLOCK', detail: 'الحساب الإعلاني الوجهة غير نشط (account_status=2).' }]);
const jMixed = await mk('c4', [{ name: 'قراءة الحملة المصدر', status: 'BLOCK', detail: THR }, { name: 'حساب الوجهة', status: 'BLOCK', detail: 'غير نشط' }]);
const n = await rearmThrottleBlockedJobs(bid);
const st = async (j) => (await prisma.ambCloneJob.findUnique({ where: { id: j.id } }));
const a = await st(jThrottle);
ok('exactly one job was re-armed', n === 1, String(n));
ok('the throttle-blocked copy is PENDING / WARNING again with its error cleared', a.status === 'PENDING' && a.preflight_status === 'WARNING' && a.error === null, JSON.stringify([a.status, a.preflight_status, a.error]));
ok('a real source-read failure (object missing) stays blocked', (await st(jRealRead)).status === 'PREFLIGHT_BLOCKED');
ok('an inactive destination account stays blocked', (await st(jInactive)).status === 'PREFLIGHT_BLOCKED');
ok('a job with a throttle block AND a real block stays blocked', (await st(jMixed)).status === 'PREFLIGHT_BLOCKED');
ok('re-arming is audited', (await prisma.ambCloneAudit.count({ where: { batch_id: bid, event: 'JOB_REARMED' } })) === 1);
ok('running it again changes nothing (idempotent)', (await rearmThrottleBlockedJobs(bid)) === 0);
await prisma.ambCloneBatch.delete({ where: { batch_id: bid } }).catch(() => {});

console.log('\n3. The preview never turns a throttle into a permanent BLOCK');
const src = fs.readFileSync(join(__dirname, '../services/amb/cloneEngine.js'), 'utf8');
ok('the source-campaign read is retried on a throttle (preview + clone time)', src.includes('withThrottleRetry(() => readCampaignTreeShared(token, cid)') && src.includes('withThrottleRetry(() => readCampaignTreeShared(token, job.source_campaign_id)'));
ok('a throttled read is tagged and becomes a WARNING row with a WARN check; a real error still BLOCKs', /__throttled: isMetaThrottle\(e\)/.test(src) && /status: tree\.__throttled \? 'WARNING' : 'BLOCKED'/.test(src) && /tree\.__throttled \? \{ name: 'قراءة الحملة المصدر', status: 'WARN'/.test(src));
ok('a run / resume re-arms old throttle-blocked copies first', /async function runBatch\(batchId\) \{\s*await rearmThrottleBlockedJobs\(batchId\)/.test(src));

console.log('\n4. Speed + fewer Meta calls: batched creatives, shared source read');
const { getCreativeNodes } = await imp('../services/metaGraphClient.js');
hits.length = 0; mode = 'ok';
const many = await getCreativeNodes('tok', ['11', '12', '13', '14', '15', '16']);
ok('6 creatives are read with ONE Graph call (was 6)', hits.length === 1 && many.size === 6 && many.get('13').name === 'cr13', JSON.stringify(hits));
hits.length = 0; const dup = await getCreativeNodes('tok', ['21', '21', '22']);
ok('duplicate ids are de-duplicated', dup.size === 2 && hits.length === 1);
hits.length = 0; const mixed = await getCreativeNodes('tok', ['31', '999', '32']);
ok('one unreadable creative does not lose the others (falls back one-by-one; only that id gets an __error)', mixed.get('31').name === 'cr31' && mixed.get('32').name === 'cr32' && /does not exist/.test(mixed.get('999').__error || ''), JSON.stringify([...mixed]));
hits.length = 0; mode = 'throttle'; let thrown = null; try { await getCreativeNodes('tok', ['41', '42']); } catch (e) { thrown = e; }
ok('a throttle is RETHROWN (never disguised as a per-creative error) so the retry / WARNING logic sees it', !!thrown && isMetaThrottle(thrown), thrown && thrown.message);
ok('and it did not fan out into one request per creative (exactly one request was sent)', hits.length === 1, String(hits.length));
ok('the clone engine reads the source through the shared cache and the batched creative call', src.includes('readCampaignTreeShared') && src.includes('getCreativeNodes(token, creativeIds)') && src.includes('cachedMetaFetch(`clonetree:') && src.includes('noteRateLimit();'));;
console.log('\n5. Meta WRITES (create campaign / ad set / ad …) wait out «too many calls to this ad-account» (80004 / 2446079) instead of failing the copy');
const W = err('There have been too many calls to this ad-account. Wait a bit and try again. [code=80004, subcode=2446079]', { graphCode: 80004, graphSubcode: 2446079 });
let n1 = 0; const r1 = await withThrottleRetry(async () => { n1++; if (n1 < 3) throw W; return { id: 'camp1' }; }, 't', [0, 0, 0]);
ok('a write rejected twice by the ad-account limit succeeds on the 3rd try (nothing was created by the rejected tries)', r1.id === 'camp1' && n1 === 3, String(n1));
let n2 = 0; let e2 = null; try { await withThrottleRetry(async () => { n2++; throw W; }, 't', [0, 0]); } catch (e) { e2 = e; }
ok('if Meta never recovers it gives up after the configured waits and surfaces the real error (copy → FAILED, resumable)', n2 === 3 && /too many calls/.test(e2?.message || ''), String(n2));
let n3 = 0; let e3 = null; try { await withThrottleRetry(async () => { n3++; throw err('Invalid parameter', { graphCode: 100, graphSubcode: 1487 }); }, 't', [0, 0, 0]); } catch (e) { e3 = e; }
ok('a real error (bad payload) is NEVER retried — one attempt, same error', n3 === 1 && /Invalid parameter/.test(e3?.message || ''));
ok('every clone-engine Meta write goes through the throttle-aware wrapper (create campaign / ad set / creative / ad / image / video / status)', ['_createCampaign', '_createAdSet', '_createAdCreative', '_createAd', '_uploadAdImageFromUrl', '_uploadAdVideoFromUrl', '_setEntityStatus'].every((n) => src.includes('writeRetry(() => ' + n + '(')));
ok('clone batches run one at a time (a single run chain) so two batches never hammer the same quota together', src.includes('let runChain = Promise.resolve()') && src.includes('runChain = runChain.then(async () => {'));
console.log('\n6. A throttled live-state read is NEVER read as «the scheduled campaign is gone»');
const { getCloneJobLiveState } = await imp('../services/metaGraphClient.js');
mode = 'ok'; const live = await getCloneJobLiveState('tok', { campaignId: '555', adsetIds: ['6'], adIds: ['7'] });
ok('a healthy read returns the live state', !!live && live.campaign.id === '555', JSON.stringify(live).slice(0, 120));
mode = 'missing'; const gone = await getCloneJobLiveState('tok', { campaignId: '555' });
ok('a campaign Meta really says does not exist → null (genuinely gone)', gone === null);
mode = 'throttle'; let thr = null; try { await getCloneJobLiveState('tok', { campaignId: '555' }); } catch (e) { thr = e; }
ok('a throttled read THROWS (tagged as a rate limit) instead of returning null', !!thr && thr.isMetaRateLimit === true && isMetaThrottle(thr));
ok('the reconcile re-checks copies an old throttled read wrongly marked «not found», and the status panel reports a throttle as a throttle', src.includes("error: { startsWith: 'الحملة المجدولة غير موجودة' }") && src.includes('JOB_REARMED') && src.includes('throttled,'));

console.log('\n7. Scale as ABO from a CBO campaign (the «ABO scale: destination campaign payload must not carry daily_budget» failure)');
const cboSrc = { daily_budget: '60000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', name: 'LumiMist _ scale 6' };
const aboSrc = { name: 'LumiMist _ scale 5', is_adset_budget_sharing_enabled: false };
const slotAbo = applyCampaignBudget({ name: 'x' }, { c: cboSrc, tree: { adsets: [] }, hasSlotPlan: true });
ok('ABO slot plan from a CBO source: the new campaign carries NO budget and NO campaign bid strategy (the budgets live on the ad sets)', slotAbo.daily_budget === undefined && slotAbo.lifetime_budget === undefined && slotAbo.bid_strategy === undefined, JSON.stringify(slotAbo));
ok('…also for a lifetime-budget CBO source', (() => { const p = applyCampaignBudget({}, { c: { lifetime_budget: '9000000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' }, tree: {}, hasSlotPlan: true }); return p.lifetime_budget === undefined && p.daily_budget === undefined; })());
const plainCbo = applyCampaignBudget({}, { c: cboSrc, tree: { adsets: [] } });
ok('a plain clone of a CBO campaign still copies its budget + strategy (unchanged)', plainCbo.daily_budget === 60000 && plainCbo.bid_strategy === 'LOWEST_COST_WITHOUT_CAP');
const cboScale = applyCampaignBudget({}, { c: aboSrc, tree: { adsets: [{ bid_strategy: 'LOWEST_COST_WITHOUT_CAP' }] }, scaleBudgetEgp: 700 });
ok('CBO scale (owner budget) still sets one campaign budget (70000) + a no-cap strategy (unchanged)', cboScale.daily_budget === 70000 && cboScale.bid_strategy === 'LOWEST_COST_WITHOUT_CAP');
const aboPlain = applyCampaignBudget({}, { c: aboSrc, tree: {}, hasSlotPlan: true });
ok('ABO slot plan from an ABO source: no campaign budget either (unchanged)', aboPlain.daily_budget === undefined && aboPlain.bid_strategy === undefined);
ok('a campaign pacing type is only sent when the new campaign has its own budget (Meta: «No Budget for Campaign» on an ABO copy of a CBO source)', src.includes('if (c.pacing_type && cboBudget) payload.pacing_type = c.pacing_type;') && !src.includes('if (c.pacing_type) payload.pacing_type = c.pacing_type;'));
const asBase = { id: 'as1', name: 'set 1', targeting: { geo_locations: { countries: ['EG'] } }, optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS', status: 'PAUSED', __slotDailyBudgetMinor: 20000 };
const ctx = { newCampaignId: 'c1', campaignHasBudget: true, resolved: { audienceRemap: {} }, pixelMap: {}, scaleBudgetForced: false, nativeStartTime: null };
let adPayload = null; let adErr = null; try { adPayload = buildAdSetPayload({ ...asBase }, { ...ctx, slotFromCbo: true, campaignBidStrategy: 'LOWEST_COST_WITHOUT_CAP' }); } catch (e) { adErr = e; }
ok('the ad sets of that ABO copy carry the strategy the CBO campaign used to hold (so Meta does not default to «bid cap» → «Bid Amount Required») and the owner\'s per-slot budget', !adErr && adPayload.bid_strategy === 'LOWEST_COST_WITHOUT_CAP' && adPayload.daily_budget === 20000, adErr ? adErr.message : JSON.stringify(adPayload).slice(0, 200));
const adNoStrat = buildAdSetPayload({ ...asBase }, { ...ctx, slotFromCbo: true, campaignBidStrategy: null });
ok('a CBO source with no explicit strategy → ad sets get LOWEST_COST_WITHOUT_CAP (never a bid cap nobody set)', adNoStrat.bid_strategy === 'LOWEST_COST_WITHOUT_CAP');
const adWithBid = buildAdSetPayload({ ...asBase, bid_amount: 1500 }, { ...ctx, slotFromCbo: true, campaignBidStrategy: null });
ok('…but if the ad set has its own bid amount it is not forced to no-cap (stays consistent)', adWithBid.bid_strategy === undefined && adWithBid.bid_amount === 1500);
const adNormal = buildAdSetPayload({ ...asBase, bid_strategy: 'COST_CAP', bid_amount: 2000 }, { ...ctx });
ok('an ordinary ABO clone keeps its own ad-set strategy and bid (unchanged)', adNormal.bid_strategy === 'COST_CAP' && adNormal.bid_amount === 2000);

console.log('\n8. The four combinations all build a valid payload: CBO or ABO source × CBO or ABO scale');
const srcCbo = { daily_budget: '60000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' }; const srcAbo = { is_adset_budget_sharing_enabled: false };
const adsetsCbo = [{ id: 'a', name: 'A', targeting: { geo_locations: { countries: ['EG'] } }, optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS', status: 'PAUSED' }];
const adsetsAbo = [{ ...adsetsCbo[0], daily_budget: '30000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' }];
const baseCtx = { newCampaignId: 'c1', resolved: { audienceRemap: {} }, pixelMap: {}, nativeStartTime: null };
const combos = [
  ['CBO source → CBO scale (owner budget 700)', srcCbo, adsetsCbo, { scaleBudgetEgp: 700 }, { cBudget: 70000, adBudget: undefined, strat: 'LOWEST_COST_WITHOUT_CAP' }],
  ['ABO source → CBO scale (owner budget 700)', srcAbo, adsetsAbo, { scaleBudgetEgp: 700 }, { cBudget: 70000, adBudget: undefined, strat: 'LOWEST_COST_WITHOUT_CAP' }],
  ['CBO source → ABO scale (per-slot 200)', srcCbo, adsetsCbo, { hasSlotPlan: true, slot: 20000 }, { cBudget: undefined, adBudget: 20000, strat: 'LOWEST_COST_WITHOUT_CAP' }],
  ['ABO source → ABO scale (per-slot 200)', srcAbo, adsetsAbo, { hasSlotPlan: true, slot: 20000 }, { cBudget: undefined, adBudget: 20000, strat: 'LOWEST_COST_WITHOUT_CAP' }],
];
for (const [label, c, adsets, opt, want] of combos) {
  const camp = applyCampaignBudget({ name: 'n' }, { c, tree: { adsets }, hasSlotPlan: !!opt.hasSlotPlan, scaleBudgetEgp: opt.scaleBudgetEgp || null });
  const slotFromCbo = !!opt.hasSlotPlan && !!(c.daily_budget || c.lifetime_budget);
  const ad = buildAdSetPayload({ ...adsets[0], ...(opt.slot ? { __slotDailyBudgetMinor: opt.slot } : {}) }, { ...baseCtx, campaignHasBudget: !!(opt.scaleBudgetEgp || opt.hasSlotPlan || c.daily_budget), scaleBudgetForced: !!opt.scaleBudgetEgp, slotFromCbo, campaignBidStrategy: c.bid_strategy || null });
  const campOk = camp.daily_budget === want.cBudget && (want.cBudget ? camp.bid_strategy === want.strat : camp.bid_strategy === undefined);
  const adOk = ad.daily_budget === want.adBudget && ad.bid_strategy === want.strat;
  const assertionOk = !(opt.hasSlotPlan && (camp.daily_budget || camp.lifetime_budget)) && !(opt.scaleBudgetEgp && !camp.daily_budget) && !(opt.scaleBudgetEgp && (ad.daily_budget || ad.lifetime_budget));
  ok(label + ': campaign + ad set payloads are consistent (budget on exactly one level, valid strategy) and pass the engine\'s own safety checks', campOk && adOk && assertionOk, JSON.stringify({ camp, ad: { daily_budget: ad.daily_budget, bid_strategy: ad.bid_strategy } }));
}
mock.close();
await prisma.$disconnect();
console.log(`\n${fail ? '❌' : '✅'} cloneThrottleTest: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 300).unref?.();
