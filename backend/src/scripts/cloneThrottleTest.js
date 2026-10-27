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
await prisma.ambCloneBatch.delete({ where: { batch_id: bid11 } }).catch(() => {});
mock.close();
await prisma.$disconnect();
console.log(`\n${fail ? '❌' : '✅'} cloneThrottleTest: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 300).unref?.();
