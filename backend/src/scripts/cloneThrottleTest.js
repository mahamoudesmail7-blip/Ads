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
  if (mode === 'accts' || mode === 'acctsThrottled') { if (u.pathname.endsWith('/me/adaccounts')) return json(200, { data: [{ id: 'act_1', account_id: '1', name: 'A', account_status: 1 }] }); if (u.pathname.endsWith('/me/businesses')) return mode === 'acctsThrottled' ? json(403, { error: { message: '(#4) Application request limit reached', code: 4, type: 'OAuthException' } }) : json(200, { data: [] }); return json(200, { data: [] }); }
  if (mode === 'transient') return json(500, { error: { message: 'An unexpected error has occurred. Please retry your request later.', code: 2, type: 'OAuthException', is_transient: true } });
  if (mode === 'source') return json(200, { id: u.pathname.split('/').pop(), source: 'https://cdn.example/v.mp4', data: [{ hash: 'h1', url: 'https://cdn.example/i.jpg' }] });
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
{
  const { sanitizeTrackingSpecs: san, TRACKING_SPEC_ERR_RE: RE } = await import(pathToFileURL(join(__dirname, '../services/amb/cloneEngine.js')).href);
  const real = { 'action.type': ['offsite_conversion'], fb_pixel: ['111'] }; const post = { 'action.type': ['link_click'], post: ['9_9'], 'post.wall': ['9'] };
  ok('tracking_specs with real objects (pixel / post) are copied untouched', JSON.stringify(san([real, post])) === JSON.stringify([real, post]));
  ok('the production failure: an entry with an action.type and NO object («Action query missing object», subcode 1634005) is dropped, the good ones stay', JSON.stringify(san([{ 'action.type': ['offsite_conversion'] }, post])) === JSON.stringify([post]) && JSON.stringify(san([{ 'action.type': ['offsite_conversion'], fb_pixel: [] }, real])) === JSON.stringify([real]));
  ok('empty object lists inside a kept entry are removed (never sent as empty arrays); an empty / null id is not an object', JSON.stringify(san([{ 'action.type': ['link_click'], post: ['9_9'], page: [], 'post.wall': [''] }])) === JSON.stringify([{ 'action.type': ['link_click'], post: ['9_9'] }]) && san([{ 'action.type': ['x'], fb_pixel: [null] }]) === null);
  ok('nothing real left → null (the ad is created without tracking_specs); no specs / garbage → null or unchanged, never a crash', san([{ 'action.type': ['offsite_conversion'] }]) === null && san(null) === null && san(undefined) === null && san([]) === null && san([null, 5, 'x', []]) === null && san('raw') === 'raw');
  ok('the Meta error text is recognised (message + code), and ordinary errors are not', RE.test('Invalid parameter — Action query missing object: Each action type must use at least one object. [code=100, subcode=1634005, type=OAuthException]') && RE.test('subcode=1634005') && !RE.test('(#4) Application request limit reached') && !RE.test('Invalid parameter — something else'));
}
ok('clone batches run one at a time PER LANE (per ad account; a scale has its own lane) so two batches never hammer the same quota together, but different accounts never wait for each other', src.includes('let runChain = Promise.resolve()') && /const laneChains = new (TenantMap|Map)\(\)/.test(src) && src.includes('laneChains.set(lane, prev.then(async () => {') && src.includes('export function laneOfBatch'));
{
  const { laneOfBatch } = await import(pathToFileURL(join(__dirname, '../services/amb/cloneEngine.js')).href);
  const b = (src, dest) => ({ source_ad_account_id: src, destination_account_ids_json: JSON.stringify(dest) });
  ok('lanes: a clone to another account and a scale (destination = the source account) → the ONE lane of the destination account', laneOfBatch(b('act_1', ['act_2'])) === 'ACCOUNT:act_2' && laneOfBatch(b('act_1', ['act_1'])) === 'ACCOUNT:act_1');
  ok('different accounts = different lanes (they run at the same time); the SAME account’s scale and clone share ONE lane (one at a time — the quota is shared)', laneOfBatch(b('act_1', ['act_1'])) !== laneOfBatch(b('act_2', ['act_2'])) && laneOfBatch(b('act_9', ['act_1'])) === laneOfBatch(b('act_1', ['act_1'])));
  ok('two scales on the SAME account share a lane (still one at a time — the quota is protected); destination order never changes the lane; garbage → a safe lane, no crash', laneOfBatch(b('act_1', ['act_1'])) === laneOfBatch(b('act_1', ['act_1', 'act_1'])) && laneOfBatch(b('x', ['b', 'a'])) === laneOfBatch(b('x', ['a', 'b'])) && typeof laneOfBatch({ destination_account_ids_json: 'not json' }) === 'string' && typeof laneOfBatch(null) === 'string');
}
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
ok('a resume re-arms an activation that a restart left half-done (ACTIVATION_PENDING untouched for 5+ minutes → CLONED_PAUSED), so the scheduler activates it', src.includes("status: 'ACTIVATION_PENDING', updated_at: { lt:") && src.includes("data: { status: 'CLONED_PAUSED', error: null }") && src.includes('await rearmStuckActivations(batchId)'));
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
console.log('\n9. Meta\'s transient «unexpected error, retry later» (code 2) no longer parks a copy as ACTIVATION_FAILED (NeckEase- Test, ad 4.1)');
const { isMetaTransient, transientRetry } = await imp('../services/amb/cloneEngine.js');
const T2 = err('An unexpected error has occurred. Please retry your request later. [code=2, type=OAuthException, fbtrace_id=AtSYW2SS4c0LP4NMhNh8gzv]', { graphCode: 2, graphType: 'OAuthException' });
ok('the exact error from the owner\'s screenshot is transient (and NOT a throttle)', isMetaTransient(T2) && !isMetaThrottle(T2));
ok('code 1, is_transient, HTTP 5xx and the «please retry» wording are transient', [err('x', { graphCode: 1 }), err('x', { graphTransient: true }), err('x', { graphStatus: 503 }), err('An unexpected error has occurred. Please retry your request later.')].every(isMetaTransient));
ok('real problems and throttles are NOT transient (bad payload, permissions, auth, rate limit)', [err('Invalid parameter', { graphCode: 100, graphSubcode: 1487 }), err('(#200) Requires ads_management permission', { graphCode: 200 }), err('Invalid OAuth access token', { graphCode: 190 }), err('x', { graphCode: 17 }), null].every((e) => !isMetaTransient(e)));
let t1 = 0; const rt1 = await transientRetry(async () => { t1++; if (t1 < 3) throw T2; return { success: true }; }, 't', [0, 0, 0]);
ok('a status write that hits the transient error twice succeeds on the 3rd try — the ad is activated, the copy is NOT failed', rt1.success === true && t1 === 3, String(t1));
let t2 = 0; let te2 = null; try { await transientRetry(async () => { t2++; throw T2; }, 't', [0, 0]); } catch (e) { te2 = e; }
ok('if Meta stays broken it gives up after the waits and surfaces the real error (the reconcile then repairs it later)', t2 === 3 && /unexpected error/.test(te2?.message || ''), String(t2));
let t3 = 0; try { await transientRetry(async () => { t3++; throw err('Invalid parameter', { graphCode: 100 }); }, 't', [0, 0, 0]); } catch { /* expected */ }
ok('a real error is never retried (one attempt)', t3 === 1);
ok('the clone engine\'s status write retries transient errors on top of the throttle wrapper (status flips only — creates are never re-sent on a transient error)', src.includes("transientRetry(() => writeRetry(() => _setEntityStatus(...a), 'write:status'), 'write:status')") && !/transientRetry\(\(\) => (writeRetry\(\(\) => )?_create/.test(src));
ok('the graph client tags is_transient so the classification can use it', fs.readFileSync(join(__dirname, '../services/metaGraphClient.js'), 'utf8').includes('err.graphTransient = e.is_transient === true'));
ok('the native-schedule reconcile now also picks up a PARTIALLY failed native activation, re-activates whatever is still PAUSED and re-arms the copy as SCHEDULED_NATIVE only when every repair succeeded', src.includes("error: { contains: PARTIAL_NATIVE_FAIL }") && src.includes('let repairFailed = 0;') && src.includes("if (job.status === 'ACTIVATION_FAILED' && !repairFailed)") && src.includes("data: { status: 'SCHEDULED_NATIVE', error: null }"));
ok('the old «not found → re-arm» branch does not swallow the partial-failure case (that one must go through the repair)', src.includes("job.status === 'ACTIVATION_FAILED' && !String(job.error || '').includes(PARTIAL_NATIVE_FAIL)"));
ok('a native activation that fails on any object raises an owner alert at once (deduped per job), not only an audit line', src.includes('clone-native-activate-fail:${jobId}') && /تفعيل جدولة Meta فشل جزئيًا/.test(src));
console.log('\n10. A throttled / transient SOURCE read is never read as «the video has no source file» (clone job 985 — 5 videos failed for that)');
const { getVideoSourceUrl, getAdImageUrlStrict } = await imp('../services/metaGraphClient.js');
mode = 'source'; ok('a healthy read returns the video source URL', (await getVideoSourceUrl('tok', '111')) === 'https://cdn.example/v.mp4');
mode = 'throttle'; let vt = null; try { await getVideoSourceUrl('tok', '111'); } catch (e) { vt = e; }
ok('«Application request limit reached» THROWS (rate-limit tagged) instead of returning null', !!vt && isMetaThrottle(vt), vt && vt.message);
mode = 'transient'; let vtr = null; try { await getVideoSourceUrl('tok', '111'); } catch (e) { vtr = e; }
ok('Meta\'s transient «unexpected error» THROWS (retryable) instead of returning null', !!vtr && isMetaTransient(vtr), vtr && vtr.message);
mode = 'missing'; ok('a real answer (the video does not exist / no access) is still null = genuinely no source', (await getVideoSourceUrl('tok', '111')) === null);
mode = 'source'; ok('image URL read: healthy → URL', (await getAdImageUrlStrict('tok', 'act_1', 'h1')) === 'https://cdn.example/i.jpg');
mode = 'throttle'; let it = null; try { await getAdImageUrlStrict('tok', 'act_1', 'h1'); } catch (e) { it = e; } ok('image URL read: a throttle throws, never «no file»', !!it && isMetaThrottle(it));
ok('the re-upload path re-reads the source patiently before giving up (video + image), and the preflight read waits out a throttle', src.includes("url = await readVideoSource(token, srcId, [30_000, 90_000, 180_000])") && src.includes('url = await readImageUrl(token, job.source_ad_account_id, srcHash') && src.includes("readVideoSource(token, v, [20_000, 60_000])"));
mode = 'ok';
console.log('\n11. A resumed copy keeps the ads made EARLIER in its id map (job 985: only 5 of 15 ads were activated)');
const { completeIdMapFromObjects } = await imp('../services/amb/cloneEngine.js');
const bid11 = `idmap-test-${Date.now()}`; await prisma.ambCloneBatch.create({ data: { batch_id: bid11, source_ad_account_id: 'act_1', destination_account_ids_json: '["act_2"]', campaign_ids_json: '["c9"]', status: 'COMPLETED', total_copies: 1 } });
const jm = await prisma.ambCloneJob.create({ data: { batch_id: bid11, source_ad_account_id: 'act_1', destination_ad_account_id: 'act_2', source_campaign_id: 'c9', status: 'SCHEDULED_NATIVE', id_map_json: JSON.stringify({ adsets: { as1: 'D_as1' }, ads: { ad3: 'D_ad3' } }) } });
for (const [level, sid, did, st] of [['ADSET', 'as1', 'D_as1', 'CREATED'], ['ADSET', 'as2', 'D_as2', 'CREATED'], ['AD', 'ad1', 'D_ad1', 'CREATED'], ['AD', 'ad2', 'D_ad2', 'CREATED'], ['AD', 'ad3', 'D_ad3', 'CREATED'], ['AD', 'ad4', null, 'FAILED'], ['CREATIVE', 'cr1', 'D_cr1', 'CREATED']]) await prisma.ambCloneObjectMap.create({ data: { job_id: jm.id, batch_id: bid11, level, source_id: sid, destination_id: did, status: st } });
const fixed = await completeIdMapFromObjects(jm, { adsets: { as1: 'D_as1' }, ads: { ad3: 'D_ad3' } });
ok('the missing created ad sets / ads are added from the object rows (3 ads, 2 ad sets); FAILED ads and creatives are not', Object.keys(fixed.ads).sort().join() === 'ad1,ad2,ad3' && Object.keys(fixed.adsets).sort().join() === 'as1,as2', JSON.stringify(fixed));
const jmAfter = await prisma.ambCloneJob.findUnique({ where: { id: jm.id } });
ok('the grown map is persisted (so the repair net + status panel see all of them) and audited', JSON.parse(jmAfter.id_map_json).ads.ad1 === 'D_ad1' && (await prisma.ambCloneAudit.count({ where: { batch_id: bid11, event: 'ID_MAP_COMPLETED' } })) === 1);
const again = await completeIdMapFromObjects(jmAfter, JSON.parse(jmAfter.id_map_json));
ok('idempotent: a complete map changes nothing and writes no second audit row', Object.keys(again.ads).length === 3 && (await prisma.ambCloneAudit.count({ where: { batch_id: bid11, event: 'ID_MAP_COMPLETED' } })) === 1);
ok('a resume restores ads made earlier into idMap.ads, and the reconcile completes the map before it reads Meta', src.includes("if (arow.status === 'CREATED') { if (arow.destination_id) idMap.ads[ad.id] = arow.destination_id; continue; }") && src.includes('idMap = await completeIdMapFromObjects(job, idMap)'));
console.log('\n12. «Image Not Found» after the asset_feed_spec stub is dropped still falls back to a re-upload (Smart-Bag copy: 7 of 15 creatives failed)');
const stubIdx = src.indexOf('const p2 = { ...payload }; delete p2.asset_feed_spec;');
const stubBlock = stubIdx > 0 ? src.slice(stubIdx, stubIdx + 2600) : '';
ok('the stub-less retry, when it fails with an asset-reference error and shared assets were used, drops them and re-uploads (forceReupload for images AND videos) before giving up', stubBlock.includes('isAssetRefError(err2) && (provisionalV.length || provisionalI.length)') && stubBlock.includes('await dropProvisionalAssets()') && stubBlock.includes('destImageHash(h, hh, { ...o, forceReupload: true })') && stubBlock.includes('destVideoId(v, hh, { ...o, forceReupload: true })'));
ok('a real, non-asset error from the stub-less retry is still final (no endless retry) and the rebuilt payload drops a stub asset_feed_spec', stubBlock.includes('} else { finalErr = err2; }') && stubBlock.includes('delete p3.asset_feed_spec'));
const asset = (m, sub) => Object.assign(new Error(m), { graphCode: 100, graphSubcode: sub });
const { isAssetRefError: _x } = await imp('../services/amb/cloneEngine.js').then((m) => ({ isAssetRefError: m.isAssetRefError }));
ok('the exact Meta error from the owner\'s batch (Image Not Found, subcode 2446386) is an asset-reference error → re-upload is allowed; payload-structure subcode 2446385 is not', typeof _x !== 'function' || (_x(asset('Invalid parameter — Image Not Found: The image you selected is not available. It might be deleted or you might not have permission to use it in ads.', 2446386)) && !_x(asset('Invalid parameter — Image Not Found', 2446385))));
console.log('\n13. Automatic resume of an approved batch that ended with failed copies (bounded: quiet 5 min, 1 per 10 min, max 3, then an alert)');
const { autoResumeFailedBatches, AUTO_RESUME_MAX } = await imp('../services/amb/cloneEngine.js');
const mkB = async (tag, over = {}) => { const id = `autoresume-${tag}-${Date.now()}`; await prisma.ambCloneBatch.create({ data: { batch_id: id, source_ad_account_id: 'act_1', destination_account_ids_json: '["act_2"]', campaign_ids_json: '["c1"]', status: 'PARTIALLY_FAILED', total_copies: 1, approved_at: new Date(), ...over } }); return id; };
let jctr = 0; const mkJ = (id, status, extra = {}) => prisma.ambCloneJob.create({ data: { batch_id: id, source_ad_account_id: 'act_1', destination_ad_account_id: 'act_2', source_campaign_id: 'c' + (++jctr), status, ...extra } });
await prisma.ambCloneBatch.deleteMany({ where: { batch_id: { startsWith: 'autoresume-' } } }); // leftovers of an interrupted earlier run (TEST database only)
const cnt = (id, detailStart) => prisma.ambCloneAudit.count({ where: { batch_id: id, event: 'AUTO_RESUME', ...(detailStart ? { detail: { startsWith: detailStart } } : {}) } });
const later = (min) => new Date(Date.now() + min * 60e3);
const settle = () => new Promise((r) => setTimeout(r, 1500));
const bA = await mkB('a'); await mkJ(bA, 'FAILED'); await mkJ(bA, 'SCHEDULED_NATIVE');
await prisma.ambCloneAudit.create({ data: { batch_id: bA, event: 'JOB_FAILED', detail: 'x' } });
const ar0 = await autoResumeFailedBatches({ now: new Date() });
ok('a batch that JUST finished (quiet < 5 min) is left alone — never resumed mid-run', (await cnt(bA)) === 0 && ar0.resumed === 0, JSON.stringify(ar0));
const ar1 = await autoResumeFailedBatches({ now: later(6) }); await settle();
ok('quiet for 5+ minutes with a FAILED copy → resumed automatically (attempt 1/3 audited)', (await cnt(bA)) === 1 && ar1.resumed >= 1, JSON.stringify(ar1));
const ar1b = await autoResumeFailedBatches({ now: later(7) });
ok('not again within 10 minutes of the last attempt', (await cnt(bA)) === 1, JSON.stringify(ar1b));
await prisma.ambCloneBatch.update({ where: { batch_id: bA }, data: { status: 'PARTIALLY_FAILED' } });
await autoResumeFailedBatches({ now: later(18) }); await settle(); await prisma.ambCloneBatch.update({ where: { batch_id: bA }, data: { status: 'PARTIALLY_FAILED' } });
await autoResumeFailedBatches({ now: later(30) }); await settle(); await prisma.ambCloneBatch.update({ where: { batch_id: bA }, data: { status: 'PARTIALLY_FAILED' } });
ok(`at most ${AUTO_RESUME_MAX} automatic attempts per batch`, (await cnt(bA)) === AUTO_RESUME_MAX, String(await cnt(bA)));
await autoResumeFailedBatches({ now: later(45) });
ok('after the last attempt the owner is told (one EXHAUSTED audit row + alert key), not retried forever', (await cnt(bA, 'EXHAUSTED')) === 1 && (await cnt(bA)) === AUTO_RESUME_MAX + 1);
await autoResumeFailedBatches({ now: later(60) });
ok('…and the exhaustion notice is raised once', (await cnt(bA, 'EXHAUSTED')) === 1);
const bB = await mkB('b', { approved_at: null, status: 'PENDING_APPROVAL' }); await mkJ(bB, 'FAILED');
const bC = await mkB('c'); await mkJ(bC, 'NEEDS_INPUT'); await mkJ(bC, 'SCHEDULED_NATIVE');
const bD = await mkB('d'); await mkJ(bD, 'FAILED', { scheduled_activation_at: new Date(Date.now() - 3600e3) });
const bE = await mkB('e', { status: 'CANCELLED' }); await mkJ(bE, 'FAILED');
await autoResumeFailedBatches({ now: later(8) }); await settle();
ok('never resumes: an unapproved batch, a batch whose only problem is NEEDS_INPUT (needs the owner), one whose scheduled start already passed, or a cancelled batch', (await cnt(bB)) === 0 && (await cnt(bC)) === 0 && (await cnt(bD)) === 0 && (await cnt(bE)) === 0);
const schedSrc = fs.readFileSync(join(__dirname, '../services/amb/cloneScheduler.js'), 'utf8');
ok('the 60-second clone scheduler runs it', schedSrc.includes('autoResumeFailedBatches') && schedSrc.includes('await autoResumeFailedBatches()'));
for (const id of [bA, bB, bC, bD, bE]) await prisma.ambCloneBatch.delete({ where: { batch_id: id } }).catch(() => {});
await prisma.ambCloneBatch.delete({ where: { batch_id: bid11 } }).catch(() => {});
console.log('\n14. The ad-accounts list built while Meta throttles is INCOMPLETE and is never cached as the final answer');
const { getAllAccessibleAdAccounts } = await imp('../services/metaGraphClient.js');
mode = 'acctsThrottled'; const partial = await getAllAccessibleAdAccounts('tok-acc', { force: true });
ok('a throttled /me/businesses marks the list incomplete (the accounts it did get are still returned)', partial.length === 1 && partial.__incomplete === true);
await new Promise((r) => setTimeout(r, 2200)); // an incomplete answer is held for ~2 s only (no hammering), then Meta is asked again
mode = 'accts'; const full = await getAllAccessibleAdAccounts('tok-acc');
ok('after the ~2 s hold the next call re-reads Meta instead of serving the partial list for 5 minutes (complete list, not flagged)', full.length === 1 && !full.__incomplete);
const acctAgain = await getAllAccessibleAdAccounts('tok-acc');
ok('a COMPLETE list is cached normally', acctAgain === full);
mode = 'acctsThrottled'; const stale = await getAllAccessibleAdAccounts('tok-acc', { force: true });
ok('if Meta throttles again, the last COMPLETE list is served (stale) rather than a partial one', stale === full);
{ // a throttle the clone engine hits is remembered PER AD ACCOUNT so the owner's alerts / syncs stop competing with the scale for the same quota
  const MC = await imp('../services/metaAssetCache.js');
  ok('an ad account is not «throttled» until the engine notes it, then it is for ~10 minutes (and a pause of 0 ends at once)', MC.isAccountThrottled('act_zz1') === false && (MC.noteAccountThrottled('act_zz1'), MC.isAccountThrottled('act_zz1') === true) && (MC.noteAccountThrottled('act_zz1', -1), MC.isAccountThrottled('act_zz1') === false));
  ok('the clone engine notes the throttled accounts of the job it is running (destination + source) on every throttle wait', src.includes('throttleCtx.run({ accounts: [job.destination_ad_account_id, job.source_ad_account_id]') && src.includes('noteAccountThrottled'));
}
{ // the wait follows what META says about its own throttle (response headers), not only a blind back-off
  const GC = await imp('../services/metaGraphClient.js'); const CE = await imp('../services/amb/cloneEngine.js');
  const H = (o) => ({ get: (n) => (o[n] === undefined ? null : o[n]) });
  ok('Meta «estimated_time_to_regain_access» (minutes, business-use-case header) is read as milliseconds', GC.regainMsFromHeaders(H({ 'x-business-use-case-usage': JSON.stringify({ 123: [{ type: 'ads_management', call_count: 100, estimated_time_to_regain_access: 12 }] }) })) === 12 * 60_000);
  ok('the ad-account usage header (reset_time_duration, seconds) is read too, the longest figure wins, and garbage / no header = 0', GC.regainMsFromHeaders(H({ 'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 99, reset_time_duration: 900 }), 'x-business-use-case-usage': JSON.stringify({ 1: [{ estimated_time_to_regain_access: 5 }] }) })) === 900_000 && GC.regainMsFromHeaders(H({ 'x-business-use-case-usage': '{not json' })) === 0 && GC.regainMsFromHeaders(null) === 0);
  const keep = process.env.CLONE_THROTTLE_WAIT_MS; delete process.env.CLONE_THROTTLE_WAIT_MS;
  ok('the engine waits META own time (+5 s) when it is longer than the planned back-off, never less than planned, never more than 20 minutes', CE.throttleWaitMs(30_000, 600_000) === 605_000 && CE.throttleWaitMs(90_000, 0) === 90_000 && CE.throttleWaitMs(300_000, 60_000) === 300_000 && CE.throttleWaitMs(30_000, 3 * 3600_000) === 20 * 60_000);
  if (keep !== undefined) process.env.CLONE_THROTTLE_WAIT_MS = keep;
  ok('a throttle wait is written to the clone log (THROTTLE_WAIT) with the reason, so the owner sees WHY a scale is waiting', src.includes("'THROTTLE_WAIT'") && src.includes('batchId, jobId: job.id'));
}
{ // job 1204: Meta rejects the copied ad set — «IG Explore Placement Is Deprecated» (subcode 2490589)
  const CE = await imp('../services/amb/cloneEngine.js');
  const mk = (t) => CE.buildAdSetPayload({ name: 'a', billing_event: 'IMPRESSIONS', optimization_goal: 'OFFSITE_CONVERSIONS', targeting: t }, { newCampaignId: '1', campaignHasBudget: true, resolved: {} }).targeting;
  const t1 = mk({ publisher_platforms: ['facebook', 'instagram'], instagram_positions: ['stream', 'explore', 'story'], facebook_positions: ['feed'] });
  ok('the deprecated Instagram «explore» placement is dropped from the copy; every other placement stays exactly as it was', JSON.stringify(t1.instagram_positions) === JSON.stringify(['stream', 'story']) && JSON.stringify(t1.facebook_positions) === JSON.stringify(['feed']) && JSON.stringify(t1.publisher_platforms) === JSON.stringify(['facebook', 'instagram']));
  const t2 = mk({ publisher_platforms: ['instagram'], instagram_positions: ['explore'] });
  ok('when «explore» was the ONLY Instagram position the key is removed (Meta default) — no position the source never had is invented', !('instagram_positions' in t2) && JSON.stringify(t2.publisher_platforms) === JSON.stringify(['instagram']));
  const keep = { publisher_platforms: ['instagram'], instagram_positions: ['stream', 'explore_home', 'reels'] };
  ok('«explore_home» (still valid) and a targeting with no Instagram positions are left untouched', JSON.stringify(mk(keep).instagram_positions) === JSON.stringify(['stream', 'explore_home', 'reels']) && !('instagram_positions' in mk({ geo_locations: { countries: ['EG'] } })) && CE.stripDeprecatedPlacements(null) === null);
}
{ // the background syncs (every 15 min × 15 accounts, all day) leave a throttled ad account alone
  const fsm = await import('node:fs'); const ss = fsm.readFileSync(join(__dirname, '../services/amb/snapshotSync.js'), 'utf8');
  ok('the scheduled sync of the connected account is skipped while Meta throttles it (a manual sync still runs)', ss.includes("trigger === 'SCHEDULED' && isAccountThrottled(adAccountId)") && ss.includes("skipped: 'THROTTLED'"));
  ok('the view-account sync loop skips a throttled account, and a rate-limit failure of either sync marks the account as throttled', ss.includes('if (isAccountThrottled(id)) continue;') && ss.split('if (isMetaRateLimitError(err)) noteAccountThrottled(adAccountId);').length === 3);
}
{ // Meta's own quota reading (x-business-use-case-usage) drives the waiting — measured on production: development_access, the limit hit is CPU time, not call count
  const U = await imp('../services/metaUsage.js'); const MC = await imp('../services/metaAssetCache.js'); U._resetUsageForTests();
  const hdr = JSON.stringify({ 1518142859790043: [{ type: 'ads_management', call_count: 2, total_cputime: 124, total_time: 133, estimated_time_to_regain_access: 10, ads_api_access_tier: 'development_access' }], 907503341896278: [{ type: 'ads_management', call_count: 10, total_cputime: 36, total_time: 61, estimated_time_to_regain_access: 0 }] });
  const pu = U.parseUsage(hdr);
  ok('the usage header is parsed per account: the WORST of call_count / cputime / time, and Meta\'s minutes-to-regain as ms', pu.length === 2 && pu[0].id === '1518142859790043' && pu[0].pct === 133 && pu[0].regainMs === 600_000 && pu[0].tier === 'development_access' && pu[1].pct === 61 && pu[1].regainMs === 0 && U.parseUsage('{bad').length === 0 && U.parseUsage(null).length === 0);
  U.noteUsageHeader(hdr);
  const rem = U.remainingRegainMs('act_1518142859790043');
  ok('a blocked account has remaining wait ≈ Meta\'s figure (act_ prefix or not), a free account 0, an unknown account 0', rem > 590_000 && rem <= 600_000 && U.remainingRegainMs('1518142859790043') > 590_000 && U.remainingRegainMs('act_907503341896278') === 0 && U.remainingRegainMs('act_999') === 0);
  ok('background readers treat a blocked / near-limit account as busy (and a calm one as free) — through the same switch the clone engine uses', U.isAccountBusy('act_1518142859790043') === true && MC.isAccountThrottled('act_1518142859790043') === true && U.isAccountBusy('act_907503341896278') === false && MC.isAccountThrottled('act_907503341896278') === false);
  U._resetUsageForTests();
  ok('the clone engine asks Meta for the quota before a copy starts (a tiny read per account), waits what Meta says, and logs it', src.includes('async function waitForQuota(') && src.includes('await waitForQuota(token,') && src.includes('remainingRegainMs'));
  const gc = (await import('node:fs')).readFileSync(join(__dirname, '../services/metaGraphClient.js'), 'utf8');
  ok('every Graph response in the client passes through the wrapper that records Meta\'s usage header', gc.includes('async function gfetch(') && gc.split('await fetch(').length === 2);
}
{ // who uses Meta's quota: every Graph call is attributed to the code that made it
  const U = await imp('../services/metaUsage.js'); U._resetUsageForTests();
  const stack = ['Error', '    at callerLabel (file:///x/backend/src/services/metaUsage.js:1:1)', '    at gfetch (file:///x/backend/src/services/metaGraphClient.js:5:5)', '    at async graphFetch (file:///x/backend/src/services/metaGraphClient.js:99:9)', '    at async getEntitiesMeta (file:///x/backend/src/services/metaGraphClient.js:300:1)', '    at async runSnapshotSync (file:///x/backend/src/services/amb/snapshotSync.js:210:20)', '    at async file:///x/backend/src/services/amb/snapshotSync.js:355:13'].join('\n');
  ok('a Graph call is labelled by the first caller outside the client and the scheduler / route at the start of the chain', U.labelFromStack(stack) === 'snapshotSync:runSnapshotSync' && U.labelFromStack(['Error', '    at x (C:\\a\\backend\\src\\services\\amb\\scaleWinners.js:1:1)', '    at y (C:\\a\\backend\\src\\routes\\aiMediaBuyer.js:5:5)'].join('\n')) === 'scaleWinners:x ⇐ aiMediaBuyer:y' && U.labelFromStack('') === 'unlabeled');
  const now = Date.now();
  U.recordCall({ label: 'a:f', account: 'act_1', ms: 400, status: 200, now }); U.recordCall({ label: 'a:f', account: '1', ms: 600, status: 200, now }); U.recordCall({ label: 'b:g', account: '1', ms: 100, status: 500, now }); U.recordCall({ label: 'c:h', account: '2', ms: 5000, status: 200, now });
  const all = U.topConsumers({ minutes: 60, now }); const one = U.topConsumers({ minutes: 60, account: 'act_1', now });
  ok('the heaviest callers are ranked by Graph time with calls / average / share, and can be narrowed to one ad account (act_ prefix or not)', all[0].label === 'c:h' && all[0].sharePct > 60 && one.length === 2 && one[0].label === 'a:f' && one[0].calls === 2 && one[0].ms === 1000 && one[0].avgMs === 500 && one[1].errors === 1);
  ok('the numbers older than the window are left out', U.topConsumers({ minutes: 5, now: now + 3 * 3600_000 }).length === 0);
  const fsm = await import('node:fs'); const rt = fsm.readFileSync(join(__dirname, '../routes/metaUsage.js'), 'utf8'); const sv = fsm.readFileSync(join(__dirname, '../server.js'), 'utf8');
  ok('the report is an ADMIN-only read route mounted in the server', rt.includes("requireRole('ADMIN')") && sv.includes("app.use('/api/meta-usage', metaUsageRoutes)") && !/fetch\(/.test(rt));
  U._resetUsageForTests();
}
mode = 'ok';
mock.close();
await prisma.$disconnect();
console.log(`\n${fail ? '❌' : '✅'} cloneThrottleTest: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 300).unref?.();
