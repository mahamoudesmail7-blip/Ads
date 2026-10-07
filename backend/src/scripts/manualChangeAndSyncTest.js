// ✋ Owner edits in Meta are recognised (MANUAL_OVERRIDE + cooldown) and a FAILED metadata fetch never writes NULL status/budget over a good value. Disposable "__optest_" fixtures only.
//   node src/scripts/manualChangeAndSyncTest.js
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const retryDb = async (fn) => { for (let i = 0; i < 10; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 4000)); } } return fn(); };
const { prisma } = await imp('../prisma.js');
const MC = await imp('../services/amb/manualChangeDetector.js');
const SS = await imp('../services/amb/snapshotSync.js');
const BO = await imp('../services/amb/budgetOptimizer.js');
const CX = await imp('../services/amb/operatorContext.js');
const T = '__optest_'; const created = { run: null };
const at = (h) => new Date(Date.UTC(2026, 9, 7, 0, 0, 0) + h * 3_600_000);
const NOW = at(20);
const before = { actions: await prisma.ambAction.count(), decisions: await prisma.ambOperatorDecision.count(), recs: await prisma.ambRecommendation.count() };

try {
  console.log('\n1. diffEntityRows (pure)');
  const row = (h, status, budget) => ({ at: at(h), status, budget });
  let ch = MC.diffEntityRows([row(1, 'ACTIVE', 500), row(2, 'ACTIVE', 500), row(3, 'ACTIVE', 300), row(4, 'ACTIVE', 300)]);
  ok('a budget edit 500 -> 300 is one change, timed at the first snapshot that SAW it', ch.length === 1 && ch[0].field === 'budget' && ch[0].from === 500 && ch[0].to === 300 && ch[0].seenAt.getTime() === at(3).getTime() && ch[0].prevAt.getTime() === at(2).getTime(), JSON.stringify(ch));
  ch = MC.diffEntityRows([row(1, 'ACTIVE', 500), row(2, null, null), row(3, 'ACTIVE', 500), row(4, null, null), row(5, 'ACTIVE', 500)]);
  ok('NULL-status rows (failed metadata fetch) are ignored: the old value -> null -> value flapping is NOT a manual change', ch.length === 0, JSON.stringify(ch));
  ch = MC.diffEntityRows([row(1, 'ACTIVE', 500), row(2, 'ACTIVE', null), row(3, 'ACTIVE', 500)]);
  ok('a missing budget on a valid row (null budget) is skipped, not treated as 500 -> 0 -> 500', ch.length === 0);
  ch = MC.diffEntityRows([row(1, 'ACTIVE', 500), row(2, 'ACTIVE', 503)]);
  ok('tiny rounding noise (<1%) is not an edit; 5% is', ch.length === 0 && MC.diffEntityRows([row(1, 'ACTIVE', 500), row(2, 'ACTIVE', 525)]).length === 1);
  ch = MC.diffEntityRows([row(1, 'ACTIVE', 200), row(2, 'PAUSED', 200), row(3, 'ACTIVE', 200)]);
  ok('pause then resume = two status changes (ACTIVE -> PAUSED, PAUSED -> ACTIVE)', ch.length === 2 && ch[0].field === 'status' && ch[0].to === 'PAUSED' && ch[1].to === 'ACTIVE');
  ch = MC.diffEntityRows([row(1, 'ACTIVE', 200), row(2, 'CAMPAIGN_PAUSED', 200), row(3, 'WITH_ISSUES', 200)]);
  ok('effective statuses that are not an owner action (CAMPAIGN_PAUSED / WITH_ISSUES) are not manual status changes', ch.length === 0);
  const c1 = { field: 'budget', from: 500, to: 300, prevAt: at(2), seenAt: at(3) };
  ok('attribution: a system action executed inside the window makes it a SYSTEM change; one hours later does not', MC.isSystemChange(c1, [at(2.5)]) === true && MC.isSystemChange(c1, [at(3.4)]) === true && MC.isSystemChange(c1, [at(6)]) === false && MC.isSystemChange(c1, []) === false);

  console.log('\n1b. recurring schedules are not manual edits (pure)');
  const st = (day, h, m, to, id) => ({ field: 'status', from: to === 'PAUSED' ? 'ACTIVE' : 'PAUSED', to, entityId: id, prevAt: new Date(Date.UTC(2026, 9, day, h, m - 10)), seenAt: new Date(Date.UTC(2026, 9, day, h, m)) });
  const sched = [];
  for (const [d, mm] of [[2, 49], [4, 53], [5, 11], [6, 13]]) for (const id of ['c1', 'c2']) sched.push(st(d, 10 + Math.floor((mm + 0) / 60), mm % 60, 'PAUSED', id)); // ~10:49-11:13 UTC on four days
  for (const [d, h, mm] of [[4, 21, 19], [5, 21, 37], [6, 21, 23]]) for (const id of ['c1', 'c2']) sched.push(st(d, h, mm, 'ACTIVE', id)); // ~21:20-21:40 UTC
  let cr = MC.classifyRecurring(sched);
  ok('the daily 11:10 pause / 21:30 resume pattern across days is recognised as a recurring schedule (every change flagged)', cr.every((c) => c.recurring === true), JSON.stringify(cr.filter((c) => !c.recurring).length));
  cr = MC.classifyRecurring([st(6, 11, 47, 'PAUSED', 'a1'), st(6, 11, 47, 'PAUSED', 'a2')]);
  ok('two ad sets paused at the same minute on ONE day only is a manual action (not a schedule)', cr.every((c) => c.recurring === false));
  cr = MC.classifyRecurring([...sched, st(6, 16, 5, 'PAUSED', 'c9')]);
  ok('a one-off pause at a different time of day stays MANUAL even when a schedule exists', cr.find((c) => c.entityId === 'c9').recurring === false && cr.filter((c) => c.entityId !== 'c9').every((c) => c.recurring));
  cr = MC.classifyRecurring([{ field: 'budget', from: 500, to: 300, entityId: 'b1', prevAt: at(1), seenAt: new Date(Date.UTC(2026, 9, 2, 11, 5)) }, { field: 'budget', from: 300, to: 200, entityId: 'b1', prevAt: at(1), seenAt: new Date(Date.UTC(2026, 9, 3, 11, 6)) }, { field: 'budget', from: 200, to: 100, entityId: 'b1', prevAt: at(1), seenAt: new Date(Date.UTC(2026, 9, 4, 11, 4)) }]);
  ok('budget edits are NEVER treated as a schedule (they always start a cooldown)', cr.every((c) => c.recurring === false));

  console.log('\n2. detectManualChanges over injected snapshots (records MANUAL_OVERRIDE events once)');
  const recorded = [];
  const camps = [{ id: `${T}cA`, name: 'CBO campaign' }, { id: `${T}cB`, name: 'ABO campaign' }, { id: `${T}cC`, name: 'System-changed' }];
  const campaignRows = [];
  for (const [h, b] of [[1, 500], [2, 500], [3, 300], [4, 300]]) campaignRows.push({ campaign_id: `${T}cA`, snapshot_at: at(h), campaign_status: 'ACTIVE', campaign_budget: b });
  for (const h of [1, 2, 3, 4]) campaignRows.push({ campaign_id: `${T}cB`, snapshot_at: at(h), campaign_status: 'ACTIVE', campaign_budget: null });
  for (const [h, b] of [[1, 400], [2, 400], [3, 480], [4, 480]]) campaignRows.push({ campaign_id: `${T}cC`, snapshot_at: at(h), campaign_status: 'ACTIVE', campaign_budget: b });
  const adsetRows = [];
  for (const [h, st, b] of [[1, 'ACTIVE', 200], [2, null, null], [3, 'ACTIVE', 200], [4, 'ACTIVE', 250], [5, 'ACTIVE', 250]]) adsetRows.push({ campaign_id: `${T}cB`, adset_id: `${T}aB`, adset_name: 'AS B', snapshot_at: at(h), adset_status: st, adset_budget: b });
  const deps = { adAccountId: `${T}acc`, activeCampaigns: camps, campaignRows, adsetRows: adsetRows.filter((r) => r.adset_status), systemTimes: (id, cid) => (cid === `${T}cC` ? [at(2.8)] : []), existingKeys: new Set(), onRecord: async (e) => recorded.push(e) };
  MC.__resetManualDetectorThrottle();
  let res = await MC.detectManualChanges({ now: NOW, lookbackHours: 48, deps });
  const byEntity = (id) => res.changes.find((c) => c.entityId === id);
  ok('CBO: the campaign budget edit 500 -> 300 is detected as MANUAL', byEntity(`${T}cA`)?.field === 'budget' && byEntity(`${T}cA`).from === 500 && byEntity(`${T}cA`).to === 300);
  ok('ABO: the ad-set budget edit 200 -> 250 is detected on the AD SET (the failed-metadata null row in between is ignored)', byEntity(`${T}aB`)?.level === 'adset' && byEntity(`${T}aB`).to === 250 && res.changes.filter((c) => c.entityId === `${T}aB`).length === 1, JSON.stringify(res.changes));
  ok('a change made while the SYSTEM executed an action is attributed to the system, not recorded as manual', !byEntity(`${T}cC`) && res.systemAttributed === 1, JSON.stringify(res));
  ok('exactly 2 MANUAL_OVERRIDE events were recorded with the entity, field, from/to and the time the sync saw it', recorded.length === 2 && recorded.every((e) => e.data.source === 'META_DIFF' && e.data.seenAt) && recorded.some((e) => e.campaignId === `${T}cB` && e.data.entityId === `${T}aB` && e.data.level === 'adset'));
  const keys = new Set(recorded.map((e) => `${e.campaignId}|${e.data.entityId}|${e.data.field}|${e.data.to}|${e.data.seenAt}`));
  MC.__resetManualDetectorThrottle(); const rec2 = [];
  res = await MC.detectManualChanges({ now: NOW, lookbackHours: 48, deps: { ...deps, existingKeys: keys, onRecord: async (e) => rec2.push(e) } });
  ok('idempotent: a second run records nothing new', res.recorded === 0 && rec2.length === 0);
  MC.__resetManualDetectorThrottle(); res = await MC.detectManualChanges({ now: NOW, lookbackHours: 48, record: false, deps: { ...deps, existingKeys: new Set(), onRecord: async () => { throw new Error('must not record'); } } });
  ok('record:false (dry run) reports the changes and writes nothing', res.changes.length === 2 && res.recorded === 0);
  MC.__resetManualDetectorThrottle(); await MC.detectManualChanges({ now: NOW, deps });
  ok('throttle: an immediate second scheduler-style call is skipped', (await MC.detectManualChanges({ now: new Date(NOW.getTime() + 60_000), throttleMin: 30, deps })).skipped === 'THROTTLED');

  console.log('\n3. the optimizer + guards react to a manual edit (real DB rows, fixtures)');
  const camp = `${T}cM`; const adset = `${T}aM`;
  await retryDb(() => prisma.ambOperatorEvent.createMany({ data: [
    { kind: 'MANUAL_OVERRIDE', actor: 'USER', campaign_id: camp, note: 'fixture', created_at: new Date(Date.now() - 5 * 3_600_000), data_json: JSON.stringify({ source: 'META_DIFF', level: 'adset', entityId: adset, field: 'budget', from: 200, to: 300, seenAt: new Date(Date.now() - 5 * 3_600_000).toISOString() }) },
    { kind: 'MANUAL_OVERRIDE', actor: 'USER', campaign_id: camp, note: 'fixture (status — must not count as a budget change)', created_at: new Date(Date.now() - 2 * 3_600_000), data_json: JSON.stringify({ source: 'META_DIFF', level: 'adset', entityId: adset, field: 'status', from: 'PAUSED', to: 'ACTIVE', seenAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }) },
  ] }));
  const lc = await BO.loadLastBudgetChanges({ entityIds: [adset], campaignIds: [camp] });
  ok('loadLastBudgetChanges returns the owner edit as the entity\'s last change (source MANUAL_META, direction from the values)', lc.get(adset)?.source === 'MANUAL_META' && lc.get(adset).action === 'SCALE_UP' && lc.get(adset).from === 200 && lc.get(adset).to === 300, JSON.stringify([...lc]));
  const cls = BO.classifyBudget({ m: { spend: 600, purchases: 5, cpa: 120 }, lastChange: lc.get(adset), since: { spend: 40, purchases: 0, cpa: null }, now: new Date() });
  ok('...so the optimizer waits: 5h after the owner raised the budget => COOLDOWN (24h), no automatic change', cls.zone === 'COOLDOWN' && cls.action === null, JSON.stringify(cls));
  const recent = await CX.loadRecentActions({ campaignIds: [camp], now: new Date() });
  ok('the guard context sees the manual override (MANUAL_OVERRIDE_COOLDOWN input) for the campaign', !!recent.get(camp)?.manualOverrideAt);

  console.log('\n4. snapshot sync: a failed metadata fetch carries the last GOOD values forward (never NULL over a valid value)');
  const mkIns = (level, ids) => ({ level, date_start: '2026-10-07', date_stop: '2026-10-07', spend: '10', impressions: '100', clicks: '5', ...ids });
  const insights = { campaign: [mkIns('campaign', { campaign_id: `${T}k1`, campaign_name: 'K1' })], adset: [mkIns('adset', { campaign_id: `${T}k1`, adset_id: `${T}s1`, adset_name: 'S1' }), mkIns('adset', { campaign_id: `${T}k1`, adset_id: `${T}s_new`, adset_name: 'brand new' })], ad: [mkIns('ad', { campaign_id: `${T}k1`, adset_id: `${T}s1`, ad_id: `${T}d1`, ad_name: 'D1' })] };
  const fresh = (e) => new Map(e);
  const metaFailed = { campaign: fresh([[`${T}k1`, { status: 'ACTIVE', objective: 'OUTCOME_SALES', campaignId: null, adsetId: null, creativeId: null, budget: null, budgetType: null }]]), adset: new Map(), ad: new Map() }; // adset + ad metadata calls failed
  const fallback = { campaign: new Map(), adset: new Map([[`${T}s1`, { status: 'ACTIVE', objective: null, campaignId: `${T}k1`, adsetId: null, creativeId: null, budget: 300, budgetType: 'DAILY' }]]), ad: new Map([[`${T}d1`, { status: 'ACTIVE', objective: null, campaignId: `${T}k1`, adsetId: `${T}s1`, creativeId: 'cr1', budget: null, budgetType: null }]]) };
  let built = await SS.buildCycleRows({ insightsByLevel: insights, meta: metaFailed, adAccountId: `${T}acc`, loadFallback: async () => fallback });
  const rAd = built.rows.find((r) => r.level === 'adset' && r.adset_id === `${T}s1`), rNew = built.rows.find((r) => r.adset_id === `${T}s_new`), rD = built.rows.find((r) => r.level === 'ad');
  ok('adset metadata failed: the ad-set row keeps status ACTIVE + budget 300 (carried), not null', rAd.adset_status === 'ACTIVE' && rAd.adset_budget === 300 && rAd.adset_budget_type === 'DAILY', JSON.stringify(rAd));
  ok('ad metadata failed: the ad row keeps its status and creative', rD.ad_status === 'ACTIVE' && rD.creative_id === 'cr1');
  ok('an entity with NO earlier good row stays null (nothing invented)', rNew.adset_status === null && rNew.adset_budget === null);
  ok('the counters say what happened', built.carried.adset === 1 && built.carried.ad === 1 && built.missingBefore.adset === 2 && built.missingBefore.campaign === 0, JSON.stringify([built.carried, built.missingBefore]));
  const good = { campaign: fresh([[`${T}k1`, { status: 'ACTIVE', objective: 'X', budget: null }]]), adset: fresh([[`${T}s1`, { status: 'PAUSED', objective: null, campaignId: `${T}k1`, budget: 120, budgetType: 'DAILY' }], [`${T}s_new`, { status: 'ACTIVE', budget: 90, budgetType: 'DAILY' }]]), ad: fresh([[`${T}d1`, { status: 'ACTIVE', creativeId: 'crX' }]]) };
  built = await SS.buildCycleRows({ insightsByLevel: insights, meta: good, adAccountId: `${T}acc`, loadFallback: async () => { throw new Error('must not be called when nothing is missing'); } });
  ok('when Meta DID answer, the fresh values win (a real change is written; the fallback is never even loaded)', built.rows.find((r) => r.adset_id === `${T}s1` && r.level === 'adset').adset_status === 'PAUSED' && built.rows.find((r) => r.adset_id === `${T}s1` && r.level === 'adset').adset_budget === 120 && built.carried.adset === 0);
  built = await SS.buildCycleRows({ insightsByLevel: insights, meta: { campaign: fresh([[`${T}k1`, { status: 'ACTIVE' }]]), adset: new Map(), ad: new Map() }, adAccountId: `${T}acc`, loadFallback: async () => { throw new Error('db down'); } });
  ok('if even the fallback lookup fails the cycle still builds its rows (null as before) instead of aborting', built.rows.length === 4);
  // DB loader against real fixture rows
  const run = await retryDb(() => prisma.ambSyncRun.create({ data: { trigger: 'MANUAL', status: 'SUCCESS', ad_account_id: `${T}acc` } })); created.run = run.id;
  const mk = (h, status, budget) => ({ sync_run_id: run.id, snapshot_at: new Date(NOW.getTime() - h * 3_600_000), ad_account_id: `${T}acc`, level: 'adset', date_start: '2026-10-07', date_stop: '2026-10-07', campaign_id: `${T}k2`, adset_id: `${T}s2`, adset_name: 'S2', adset_status: status, adset_budget: budget, adset_budget_type: budget ? 'DAILY' : null, spend: 1, meta_purchases: 0 });
  await retryDb(() => prisma.metaPerformanceSnapshot.createMany({ data: [mk(3, 'ACTIVE', 250), mk(1, null, null), mk(60, 'ACTIVE', 111)] }));
  const fb = await SS.loadMetaFallback({ adAccountId: `${T}acc`, missing: { campaign: new Set(), adset: new Set([`${T}s2`]), ad: new Set() }, now: NOW });
  ok('loadMetaFallback: the newest row WITH a status (250), skipping the newer null row and the stale (>48h) one', fb.adset.get(`${T}s2`)?.budget === 250 && fb.adset.get(`${T}s2`).status === 'ACTIVE', JSON.stringify([...fb.adset]));
  const meta2 = { campaign: new Map(), adset: new Map([[`${T}s2`, { status: 'ACTIVE', budget: 999 }]]), ad: new Map() };
  const n = SS.applyMetaFallback(meta2, fb);
  ok('applyMetaFallback never overrides what Meta returned this cycle', n.adset === 0 && meta2.adset.get(`${T}s2`).budget === 999);

  console.log('\n5. safety');
  ok('nothing executed / no Meta rows touched by this test (AMB actions, operator decisions, recommendations unchanged)', (await prisma.ambAction.count()) === before.actions && (await prisma.ambOperatorDecision.count()) === before.decisions && (await prisma.ambRecommendation.count()) === before.recs);
} catch (e) { fail++; console.log('  ✗ test crashed —', e.stack || e.message); }
finally {
  try {
    await retryDb(() => prisma.ambOperatorEvent.deleteMany({ where: { campaign_id: { startsWith: T } } }));
    await retryDb(() => prisma.metaPerformanceSnapshot.deleteMany({ where: { ad_account_id: `${T}acc` } }));
    if (created.run) await retryDb(() => prisma.ambSyncRun.deleteMany({ where: { id: created.run } }));
    ok('cleanup: no fixture left', (await prisma.ambOperatorEvent.count({ where: { campaign_id: { startsWith: T } } })) === 0 && (await prisma.metaPerformanceSnapshot.count({ where: { ad_account_id: `${T}acc` } })) === 0);
  } catch (e) { fail++; console.log('  ✗ cleanup failed —', e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
