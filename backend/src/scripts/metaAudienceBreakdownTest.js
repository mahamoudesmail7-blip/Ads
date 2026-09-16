// Phase A — Meta audience/geo/platform breakdown (services/amb/
// metaAudienceBreakdown.js). Pure-function tests for the aggregation/
// classification logic (no network, no DB) + mocked-fetch tests for the
// low-level Meta call (metaGraphClient.js's getInsightsBreakdown, which
// deliberately never throws so a caller can try a fallback combo) + a
// handful of real-DB honesty-path tests for computeAudienceBreakdown that
// touch ONLY a throwaway ProductMarketingProfile/Snapshot pair (never
// AmbProduct/AmbProductCampaignMap/MetaConnection — this project's real
// production data), cleaned up immediately after.
//   node src/scripts/metaAudienceBreakdownTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { classifyError, rowMetrics, aggregateBy } = await imp('../services/amb/metaAudienceBreakdown.js');
const { getInsightsBreakdown } = await imp('../services/metaGraphClient.js');
const { prisma } = await imp('../prisma.js');

console.log('§1 classifyError — never guesses; classifies from Meta\'s own code/message:');
{
  ok('code 100 + "cannot be used together" -> UNSUPPORTED_COMBO', classifyError({ code: 100, message: 'age and region cannot be used together' }) === 'UNSUPPORTED_COMBO');
  ok('code 100 + generic invalid-parameter breakdown wording -> UNSUPPORTED_COMBO', classifyError({ code: 100, message: 'Invalid parameter: breakdowns' }) === 'UNSUPPORTED_COMBO');
  ok('code 190 (expired token) -> PERMISSION', classifyError({ code: 190, message: 'Error validating access token' }) === 'PERMISSION');
  ok('code 200 (permissions) -> PERMISSION', classifyError({ code: 200, message: 'Permissions error' }) === 'PERMISSION');
  ok('code 4 (app throttle) -> RATE_LIMITED', classifyError({ code: 4, message: 'Application request limit reached' }) === 'RATE_LIMITED');
  ok('unrecognized code -> ERROR (never silently treated as unsupported)', classifyError({ code: 999, message: 'something else entirely' }) === 'ERROR');
}

console.log('\n§2 rowMetrics — real purchases/purchase-value extraction, never fabricated:');
{
  const row = {
    spend: '150.5', impressions: '10000', reach: '8000', clicks: '300', ctr: '3.0', cpc: '0.5',
    actions: [{ action_type: 'link_click', value: '300' }, { action_type: 'omni_purchase', value: '12' }, { action_type: 'purchase', value: '9' }],
    action_values: [{ action_type: 'omni_purchase', value: '2400' }, { action_type: 'purchase', value: '1800' }],
  };
  const m = rowMetrics(row);
  ok('spend parsed as a real number', m.spend === 150.5, String(m.spend));
  ok('purchases uses omni_purchase (Ads Manager priority), not the first action in the array', m.purchases === 12, String(m.purchases));
  ok('purchaseValue matches the SAME action_type actually used for purchases (omni_purchase), not a different one', m.purchaseValue === 2400, String(m.purchaseValue));
  ok('reach/ctr/cpc pass through as real numbers, never recomputed', m.reach === 8000 && m.ctr === 3.0 && m.cpc === 0.5);

  const noPurchase = rowMetrics({ spend: '10', impressions: '100', clicks: '2', actions: [{ action_type: 'link_click', value: '2' }] });
  ok('no purchase action at all -> purchases 0, purchaseValue 0 (never null-crashes downstream sums)', noPurchase.purchases === 0 && noPurchase.purchaseValue === 0);
}

console.log('\n§3 aggregateBy — sums real rows by one dimension, recomputes ctr/cpc/cpa from the SUMS (never averages the per-row ratios):');
{
  const rows = [
    { dims: { age: '25-34', gender: 'female' }, spend: 100, impressions: 1000, clicks: 30, purchases: 5, purchaseValue: 1000, reach: 800 },
    { dims: { age: '25-34', gender: 'male' }, spend: 50, impressions: 500, clicks: 10, purchases: 1, purchaseValue: 200, reach: 400 },
    { dims: { age: '35-44', gender: 'female' }, spend: 20, impressions: 200, clicks: 4, purchases: 0, purchaseValue: 0, reach: 150 },
  ];
  const byAge = aggregateBy(rows, 'age');
  const g2534 = byAge.find((r) => r.value === '25-34');
  const g3544 = byAge.find((r) => r.value === '35-44');
  ok('two rows sharing age 25-34 are summed into one bucket', g2534.spend === 150 && g2534.purchases === 6 && g2534.purchaseValue === 1200, JSON.stringify(g2534));
  ok('ctr recomputed from summed clicks/impressions (40/1500=2.67%), not averaged from 3.0%/2.0%', Math.abs(g2534.ctr - 2.67) < 1e-9, String(g2534.ctr));
  ok('cpa recomputed from summed spend/purchases (150/6)', Math.abs(g2534.cpa - 150 / 6) < 1e-6, String(g2534.cpa));
  ok('a bucket with zero purchases gets cpa:null, never a fabricated 0 or Infinity', g3544.cpa === null, String(g3544.cpa));
  ok('sorted by purchases desc — the real winning age group is first', byAge[0].value === '25-34');
  ok('reach is NOT summed across multiple rows (Meta explicitly disallows this) — null when >1 sample', g2534.reach === null, String(g2534.reach));

  const single = aggregateBy([{ dims: { country: 'EG' }, spend: 10, impressions: 100, clicks: 1, purchases: 0, purchaseValue: 0, reach: 90 }], 'country');
  ok('a single-row bucket DOES report reach (only cross-row summing is disallowed)', single[0].reach === 90, String(single[0].reach));
}

console.log('\n§4 getInsightsBreakdown (metaGraphClient.js) — mocked fetch, real pagination + real error passthrough:');
{
  const originalFetch = global.fetch;

  // §4a — a supported combo: two pages, rows concatenated.
  global.fetch = async (url) => {
    const isPage2 = String(url).includes('cursor2');
    return {
      ok: true,
      json: async () => isPage2
        ? { data: [{ age: '35-44', spend: '5' }] }
        : { data: [{ age: '25-34', spend: '10' }], paging: { next: 'https://graph.facebook.com/x?cursor2=1' } },
    };
  };
  const r1 = await getInsightsBreakdown('tok', 'act_1', { breakdowns: ['age'], campaignIds: ['c1'], dateFrom: '2026-01-01', dateTo: '2026-01-07' });
  ok('ok:true with both pages concatenated', r1.ok === true && r1.rows.length === 2, JSON.stringify(r1));

  // §4b — Meta rejects the combination: returns ok:false with the EXACT reason, never throws.
  global.fetch = async () => ({
    ok: false, status: 400,
    json: async () => ({ error: { message: 'age and region cannot be used together', type: 'OAuthException', code: 100, error_subcode: 1487390 } }),
  });
  let threw = false;
  let r2;
  try { r2 = await getInsightsBreakdown('tok', 'act_1', { breakdowns: ['age', 'region'], campaignIds: ['c1'], dateFrom: '2026-01-01', dateTo: '2026-01-07' }); }
  catch { threw = true; }
  ok('never throws for a rejected combo — returns ok:false instead so the caller can fall back', !threw && r2.ok === false);
  ok('the EXACT Meta error message is preserved, never replaced with a generic one', r2.message === 'age and region cannot be used together', r2.message);
  ok('Meta\'s error code is preserved for classification', r2.code === 100);

  // §4c — no confirmed campaigns at all -> never calls Meta, returns an honest reason immediately.
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, json: async () => ({ data: [] }) }; };
  const r3 = await getInsightsBreakdown('tok', 'act_1', { breakdowns: ['age'], campaignIds: [], dateFrom: '2026-01-01', dateTo: '2026-01-07' });
  ok('empty campaignIds short-circuits before any network call', !called && r3.ok === false, JSON.stringify(r3));

  global.fetch = originalFetch;
}

console.log('\n§5 computeAudienceBreakdown — real-DB honesty paths (throwaway profile/snapshot only, never touches AmbProduct/MetaConnection):');
{
  const { computeAudienceBreakdown } = await imp('../services/amb/metaAudienceBreakdown.js');

  let notFoundThrew = false;
  try { await computeAudienceBreakdown({ profileId: 999999999, windowName: 'last7' }); }
  catch (e) { notFoundThrew = e.status === 404; }
  ok('unknown profileId throws 404, never a fabricated result', notFoundThrew);

  const profile = await prisma.productMarketingProfile.create({
    data: {
      source: 'EASY_ORDERS',
      locked_name: '__test_audience_breakdown_no_such_product__',
      easy_orders_product_id: 'default::__test_zzz_not_real__',
    },
  });
  try {
    let noSnapshotThrew = false;
    try { await computeAudienceBreakdown({ profileId: profile.id, windowName: 'last7' }); }
    catch (e) { noSnapshotThrew = e.status === 400; }
    ok('no analyzed snapshot yet for this window -> throws 400 asking to analyze first, never silently computes one', noSnapshotThrew);

    await prisma.productMarketingSnapshot.create({
      data: {
        profile_id: profile.id, window_name: 'last7',
        metrics_json: '{}', opportunity_json: '{}', diagnosis_json: '[]', audience_json: '{}',
        locations_json: '[]', angles_json: '[]', actions_json: '[]',
      },
    });
    const result = await computeAudienceBreakdown({ profileId: profile.id, windowName: 'last7' });
    ok('a product with no resolvable internal catalog match -> honest unavailable, never a guessed breakdown', result.available === false && /مش مربوط بمنتج حقيقي/.test(result.reason || ''), JSON.stringify(result));

    const savedRow = await prisma.productMarketingSnapshot.findUnique({ where: { profile_id_window_name: { profile_id: profile.id, window_name: 'last7' } } });
    ok('the honest result was actually persisted into the snapshot row (not just returned)', JSON.parse(savedRow.audience_breakdown_json || '{}').available === false);
  } finally {
    await prisma.productMarketingProfile.delete({ where: { id: profile.id } }); // cascades the snapshot row
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
