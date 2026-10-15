// 🧪 Live Campaign Intelligence §4 — post-launch windows from REAL snapshot granularity. Pure functions + a real-DB read of disposable snapshot rows (`__lw_`) on the ISOLATED test database.
//   Rules proven: a window is the DIFFERENCE of two day-to-date snapshots (crossing midnight included) · it is offered ONLY when a snapshot lies near the window start · otherwise «غير متاح» with the reason (never an invented hourly history)
//   · a metric that cannot be known is null (never 0) · Meta revising a total DOWN is flagged, not silently shown · partial coverage is reported.
//   node src/scripts/liveWindowMetricsTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url)); const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0; const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };
const W = await imp('../services/amb/liveWindowMetrics.js'); const { prisma } = await imp('../prisma.js');
const T = (d, hm) => new Date(`${d}T${hm}:00Z`); const row = (date, hm, spend, o = {}) => ({ campaign_id: 'c', snapshot_at: T(date, hm), date_start: date, spend, impressions: o.impr ?? spend * 100, clicks: o.clicks ?? spend, meta_purchases: o.p ?? 0, landing_page_views: o.lpv ?? Math.floor(spend / 2) });
const tol = 20 * 60_000;

console.log('\n1. Inside one day: the window is the difference of two day-to-date snapshots');
{
  const rows = [row('2026-10-14', '10:00', 100, { p: 1 }), row('2026-10-14', '11:00', 160, { p: 2 }), row('2026-10-14', '12:00', 250, { p: 4 })];
  const r1 = W.campaignWindowDelta(rows, { hours: 1, tolMs: tol }); ok('last hour at 12:00 = 250 − 160 = 90 spend, 2 purchases', r1.ok && r1.delta.spend === 90 && r1.delta.meta_purchases === 2 && r1.anchorOffsetMin === 0, JSON.stringify(r1));
  const r2 = W.campaignWindowDelta(rows, { hours: 2, tolMs: tol }); ok('last 2h = 250 − 100 = 150', r2.ok && r2.delta.spend === 150);
  const s = W.summarizeDeltas([r1]); ok('derived metrics: CPA = 90 ÷ 2 = 45, CTR = clicks ÷ impressions, CPC, CPM from the SAME delta', s.cpa === 45 && s.cpc === 1 && s.cpm === 10 && s.ctr === 1 && s.spend === 90 && s.purchases === 2, JSON.stringify(s));
}
console.log('\n2. Crossing midnight');
{
  const rows = [row('2026-10-13', '22:00', 450), row('2026-10-13', '23:50', 500), row('2026-10-14', '00:15', 20), row('2026-10-14', '01:00', 80)];
  const r = W.campaignWindowDelta(rows, { hours: 3, tolMs: tol }); ok('last 3h at 01:00 (start 22:00 of the previous day): (500 − 450) + 80 = 130 — the previous day\'s tail plus today', r.ok && r.delta.spend === 130, JSON.stringify(r));
}
console.log('\n3. NEVER fabricate: no snapshot near the start → unavailable, with the reason');
{
  const rows = [row('2026-10-14', '10:00', 100), row('2026-10-14', '12:00', 250)];
  const r = W.campaignWindowDelta(rows, { hours: 1, tolMs: tol }); ok('last hour at 12:00 needs a snapshot near 11:00, the nearest is 60 min away → NO_SNAPSHOT_NEAR_WINDOW_START (not a guess from daily totals)', r.ok === false && r.reason === 'NO_SNAPSHOT_NEAR_WINDOW_START' && r.nearestMin === 60, JSON.stringify(r));
  const r2 = W.campaignWindowDelta([row('2026-10-14', '11:30', 40), row('2026-10-14', '12:00', 70)], { hours: 6, tolMs: tol }); ok('a window that starts BEFORE our first snapshot is unavailable (WINDOW_STARTS_BEFORE_FIRST_SNAPSHOT)', r2.ok === false && r2.reason === 'WINDOW_STARTS_BEFORE_FIRST_SNAPSHOT');
  ok('no snapshots at all → NO_SNAPSHOTS', W.campaignWindowDelta([], { hours: 1, tolMs: tol }).reason === 'NO_SNAPSHOTS');
  const wide = W.campaignWindowDelta(rows, { hours: 1, tolMs: 61 * 60_000 }); ok('the tolerance is the only thing that decides (a 61-minute tolerance would accept it — the interval is configurable)', wide.ok === true);
}
console.log('\n4. Unknown is null, never 0; Meta revising a total DOWN is flagged');
{
  const noOrders = W.summarizeDeltas([W.campaignWindowDelta([row('2026-10-14', '11:00', 100), row('2026-10-14', '12:00', 160)], { hours: 1, tolMs: tol })]); ok('no purchases in the window → CPA is null (not 0)', noOrders.purchases === 0 && noOrders.cpa === null && noOrders.spend === 60);
  const rev = W.campaignWindowDelta([row('2026-10-14', '11:00', 100, { p: 3 }), row('2026-10-14', '12:00', 160, { p: 2 })], { hours: 1, tolMs: tol }); ok('purchases went DOWN between snapshots (Meta adjusted): that metric is null and flagged, spend is still shown', rev.ok && rev.delta.meta_purchases === null && rev.negative.includes('meta_purchases') && rev.delta.spend === 60);
  const s = W.summarizeDeltas([rev]); ok('a null purchases delta makes purchases and CPA null in the summary (never a wrong number)', s.purchases === null && s.cpa === null);
  ok('zero impressions → CTR / CPM are null, not NaN', W.summarizeDeltas([{ ok: true, delta: { spend: 0, impressions: 0, clicks: 0, meta_purchases: 0, landing_page_views: 0 } }]).ctr === null);
}
console.log('\n5. liveWindow(): several campaigns, partial coverage, unknown window');
{
  const rows = [{ ...row('2026-10-14', '11:00', 100, { p: 1 }), campaign_id: 'a' }, { ...row('2026-10-14', '12:00', 160, { p: 2 }), campaign_id: 'a' }, { ...row('2026-10-14', '12:00', 50), campaign_id: 'b' }]; const now = T('2026-10-14', '12:05');
  const r = await W.liveWindow({ campaignIds: ['a', 'b'], windowKey: '1h', now, deps: { rows } }); ok('one campaign has the anchor, one does not: available, PARTIAL, the missing one is named, totals come only from the covered one', r.available && r.partial === true && r.coverage.covered === 1 && r.coverage.missing[0].campaignId === 'b' && r.metrics.spend === 60 && r.source === 'META_SNAPSHOT_DIFF', JSON.stringify(r));
  const none = await W.liveWindow({ campaignIds: ['b'], windowKey: '1h', now, deps: { rows } }); ok('no campaign covered → unavailable with the honest note', none.available === false && /مش هنخمّن|مفيش/.test(none.note));
  const withIdle = await W.liveWindow({ campaignIds: ['a', 'b', 'z1', 'z2'], windowKey: '1h', now, deps: { rows } }); ok('campaigns with NO snapshot at all (paused / never delivered) are INACTIVE, not «missing»: coverage is counted over the delivering ones (2), the idle ones are reported separately (2)', withIdle.coverage.campaigns === 2 && withIdle.coverage.inactive === 2 && withIdle.coverage.covered === 1 && withIdle.coverage.missing.length === 1, JSON.stringify(withIdle.coverage));
  ok('only idle campaigns → unavailable with a clear «not running» note (not a fake zero)', (await W.liveWindow({ campaignIds: ['z1'], windowKey: '1h', now, deps: { rows } })).available === false);
  ok('unknown window and no campaigns are refused cleanly', (await W.liveWindow({ campaignIds: ['a'], windowKey: '5h', now })).reason === 'UNKNOWN_WINDOW' && (await W.liveWindow({ campaignIds: [], windowKey: '1h', now })).reason === 'NO_CAMPAIGNS');
  ok('the windows offered are exactly 1 / 3 / 6 / 12 / 24 hours with Arabic labels', Object.keys(W.HOUR_WINDOWS).join() === '1h,3h,6h,12h,24h' && W.WINDOW_LABEL_AR['1h'] === 'آخر ساعة' && W.WINDOW_LABEL_AR.launch === 'منذ الإطلاق');
}
console.log('\n6. From the REAL snapshot table (disposable rows)');
{
  const run = await prisma.ambSyncRun.create({ data: { status: 'SUCCESS', trigger: 'MANUAL' } }); const cid = `__lw_${Date.now()}`; const d = new Date(); const day = d.toISOString().slice(0, 10);
  const at = (minAgo) => new Date(d.getTime() - minAgo * 60_000);
  try {
    for (const [min, sp, p] of [[190, 100, 1], [130, 140, 1], [70, 200, 2], [10, 260, 3]]) await prisma.metaPerformanceSnapshot.create({ data: { sync_run_id: run.id, snapshot_at: at(min), ad_account_id: 'act_lw', level: 'campaign', date_start: day, date_stop: day, campaign_id: cid, spend: sp, impressions: sp * 100, clicks: sp, meta_purchases: p, landing_page_views: sp / 2 } });
    const r = await W.liveWindow({ campaignIds: [cid], windowKey: '1h', now: d, intervalMinutes: 60 });
    ok('read from the table: the last hour = latest (260 at −10 min) − the snapshot near −70 min (200) = 60 spend, 1 purchase', r.available && r.metrics.spend === 60 && r.metrics.purchases === 1 && r.metrics.cpa === 60, JSON.stringify(r));
    const r3 = await W.liveWindow({ campaignIds: [cid], windowKey: '3h', now: d, intervalMinutes: 60 }); ok('last 3 hours = 260 − 100 (the −190 min snapshot is the nearest to the −190 start) = 160', r3.available && r3.metrics.spend === 160, JSON.stringify(r3));
    const r6 = await W.liveWindow({ campaignIds: [cid], windowKey: '6h', now: d, intervalMinutes: 60 }); ok('last 6 hours: nothing exists that far back → unavailable (not extrapolated)', r6.available === false, JSON.stringify(r6));
  } finally { await prisma.metaPerformanceSnapshot.deleteMany({ where: { campaign_id: cid } }); await prisma.ambSyncRun.delete({ where: { id: run.id } }).catch(() => {}); }
}
console.log('\n7. The service layer (store isolation, since-launch, hour windows) over a mapped product');
{
  const LCS = await imp('../services/amb/liveCampaignStatus.js'); const { STORE_CONTEXT_REQUIRED } = await imp('../services/amb/storeScope.js');
  const ST = 'trendy-storeee'; const made = {}; const cid = `__lw7_${Date.now()}`; const d = new Date(); const day = d.toISOString().slice(0, 10);
  const at = (minAgo) => new Date(d.getTime() - minAgo * 60_000);
  try {
    made.run = await prisma.ambSyncRun.create({ data: { status: 'SUCCESS', trigger: 'MANUAL' } });
    made.product = await prisma.product.create({ data: { product_name: `__lw7_p_${Date.now()}`, selling_price: 1000, product_cost: 0, store_id: ST } });
    made.amb = await prisma.ambProduct.create({ data: { product_id: made.product.id, product_name: made.product.product_name, active: true } });
    made.map = await prisma.ambProductCampaignMap.create({ data: { amb_product_id: made.amb.id, ad_account_id: 'act_lw7', campaign_id: cid, campaign_name: 'lw7', status: 'MAPPED' } });
    made.profile = await prisma.productMarketingProfile.create({ data: { product_id: made.product.id, source: 'MANUAL_UPLOAD', locked_name: made.product.product_name } });
    for (const [min, sp, p] of [[190, 100, 1], [130, 140, 1], [70, 200, 2], [10, 260, 3]]) await prisma.metaPerformanceSnapshot.create({ data: { sync_run_id: made.run.id, snapshot_at: at(min), ad_account_id: 'act_lw7', level: 'campaign', date_start: day, date_stop: day, campaign_id: cid, campaign_name: 'lw7', campaign_status: 'ACTIVE', spend: sp, impressions: sp * 100, clicks: sp, meta_purchases: p, landing_page_views: sp / 2 } });
    const h = await LCS.getLiveWindow({ profileId: made.profile.id, storeId: ST, windowKey: '1h' });
    ok('the hour window through the service: linked, available, the mapped campaign is found, 60 spend / 1 purchase in the last hour', h.linked && h.available && h.metrics.spend === 60 && h.metrics.purchases === 1 && h.coverage.campaigns === 1, JSON.stringify(h));
    const l = await LCS.getLiveWindow({ profileId: made.profile.id, storeId: ST, windowKey: 'launch' });
    ok('«منذ الإطلاق» = the real daily aggregates from the earliest known activity, labelled as NOT a confirmed launch time (no Launch Job here)', l.linked && l.launch.source === 'EARLIEST_KNOWN_ACTIVITY' && l.source === 'META_DAILY_AGGREGATES' && /مش وقت إطلاق مؤكد/.test(l.note) && l.from === day, JSON.stringify(l));
    const wrong = await LCS.getLiveWindow({ profileId: made.profile.id, storeId: 'default', windowKey: '1h' }); ok('the WRONG store is refused (STORE_CONTEXT_REQUIRED) — no numbers cross stores', wrong.linked === false && wrong.code === STORE_CONTEXT_REQUIRED && wrong.metrics === undefined);
    const bad = await LCS.getLiveWindow({ profileId: made.profile.id, storeId: ST, windowKey: 'nope' }); ok('an unknown window key is refused cleanly (UNKNOWN_WINDOW), never a guess', bad.available === false && bad.reason === 'UNKNOWN_WINDOW');
  } finally {
    await prisma.metaPerformanceSnapshot.deleteMany({ where: { campaign_id: cid } }).catch(() => {}); if (made.run) await prisma.ambSyncRun.delete({ where: { id: made.run.id } }).catch(() => {});
    if (made.profile) await prisma.productMarketingProfile.delete({ where: { id: made.profile.id } }).catch(() => {}); if (made.map) await prisma.ambProductCampaignMap.delete({ where: { id: made.map.id } }).catch(() => {});
    if (made.amb) await prisma.ambProduct.delete({ where: { id: made.amb.id } }).catch(() => {}); if (made.product) await prisma.product.delete({ where: { id: made.product.id } }).catch(() => {});
  }
}
await prisma.$disconnect();
console.log(`\n${pass} passed, ${fail} failed`); setTimeout(() => process.exit(fail ? 1 : 0), 50);
