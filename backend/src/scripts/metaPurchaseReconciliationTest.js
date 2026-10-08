// Meta purchase reconciliation regression (2026-10-01). Reproduces and
// proves the fix for a real discrepancy found on real data: Ads Manager
// showed real Website Purchases for "Smart-EarCleaner -TEST"/"-TEST 7"
// (product 254, جهاز تنظيف الأذن بالماء الآمن), but Product Marketing
// Center's Age/Gender breakdown showed Spend > 0 with Purchases = 0 for the
// exact same campaigns/period.
//
// Root cause #1 (confirmed via real DB timestamps): the campaigns were
// CONFIRMED (AmbProductCampaignMap status -> MAPPED) at 13:53:52, but
// computeAudienceBreakdown()'s cached audience_breakdown_json for this
// profile had already been generated at 13:51:13 — 2m39s EARLIER, built
// from the then-current (smaller) mapped-campaign set that didn't include
// the purchasing campaigns yet. Nothing invalidated that cache when the
// mapping changed, so it kept being served stale. Fixed in
// confirmMetaMapping() (productMarketing.js): any successful MAPPED result
// now nulls audience_breakdown_json for the profile, forcing an honest
// "not computed yet" instead of serving pre-confirmation numbers.
//
// Root cause #2 (confirmed via code+live-data audit): two DIFFERENT
// purchase-action-type matchers existed — metaGraphClient.js's pickPurchases
// (priority-ordered: omni_purchase first) used by the audience-breakdown
// path, vs metaSync.js's old PURCHASE_ACTION_TYPES Set + array-order `find`
// used by the canonical MetaPerformanceSnapshot sync path. They could pick a
// DIFFERENT (non-de-duplicated) purchase action type for the same Meta
// response whenever more than one purchase-like action was present, and the
// old Set was also missing `onsite_web_app_purchase` entirely. Fixed by
// making metaSync.js's extractResults() delegate to the single central
// pickPurchases() for the purchase count — never a second guessed list.
//
//   node src/scripts/metaPurchaseReconciliationTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const { prisma } = await imp('../prisma.js');
const { pickPurchases } = await imp('../services/metaGraphClient.js');
const { extractResults } = await imp('../services/metaSync.js');
const { confirmMetaMapping } = await imp('../services/amb/productMarketing.js');

console.log('§1 pickPurchases() — priority holds regardless of Meta\'s raw array order (the real Smart-EarCleaner response shape):');
{
  // Exact action list Meta returned live for campaign 120252569496130205
  // (Smart-EarCleaner -TEST) on 2026-10-01, deliberately NOT reordered —
  // omni_purchase is NOT first in Meta's own array.
  const realActions = [
    { action_type: 'web_in_store_purchase', value: '3' },
    { action_type: 'omni_purchase', value: '3' },
    { action_type: 'offsite_purchase_add_20_s_calls', value: '3' },
    { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' },
    { action_type: 'onsite_web_app_purchase', value: '3' },
    { action_type: 'purchase', value: '3' },
    { action_type: 'web_app_in_store_purchase', value: '3' },
    { action_type: 'onsite_web_purchase', value: '3' },
  ];
  const pk = pickPurchases(realActions);
  ok('picks omni_purchase specifically (Ads Manager\'s own de-duplicated definition), not just the first array entry', pk.actionType === 'omni_purchase' && pk.value === 3, JSON.stringify(pk));

  // A case where ONLY the type the old metaSync.js Set was missing exists.
  const onlyAppPurchase = [{ action_type: 'onsite_web_app_purchase', value: '7' }];
  const pk2 = pickPurchases(onlyAppPurchase);
  ok('onsite_web_app_purchase (previously missing from the old Set) is now recognized', pk2.value === 7 && pk2.actionType === 'onsite_web_app_purchase', JSON.stringify(pk2));

  const none = pickPurchases([{ action_type: 'link_click', value: '50' }]);
  ok('a row with real engagement but NO purchase-type action returns null (never a fabricated 0 disguised as a real zero)', none.value === null && none.actionType === null, JSON.stringify(none));
}

console.log('\n§2 metaSync.js extractResults() — now reconciles exactly with pickPurchases() (the actual bug: it used to pick a DIFFERENT action type here):');
{
  // Same real action order as §1 — the old array-order-first-match Set-based
  // code would have matched whichever purchase type Meta happened to list
  // FIRST (web_in_store_purchase here), not omni_purchase.
  const row = {
    actions: [
      { action_type: 'web_in_store_purchase', value: '3' },
      { action_type: 'omni_purchase', value: '3' },
      { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' },
    ],
    action_values: [{ action_type: 'omni_purchase', value: '6177' }],
    cost_per_action_type: [],
  };
  const r = extractResults(row);
  ok('extractResults().resultIndicator is omni_purchase (matches pickPurchases exactly), not web_in_store_purchase (array-first)', r.resultIndicator === 'omni_purchase', JSON.stringify(r));
  ok('extractResults().purchases is a real, honest number (3), usable directly for meta_purchases', r.purchases === 3, JSON.stringify(r));

  const noPurchase = extractResults({ actions: [{ action_type: 'landing_page_view', value: '40' }] });
  ok('a non-purchase-optimized row: purchases is null (honest "no purchase action"), results still honestly reports the real landing_page_view count as the generic KPI', noPurchase.purchases === null && noPurchase.results === 40 && noPurchase.resultIndicator === 'landing_page_view', JSON.stringify(noPurchase));
}

console.log('\n§3 confirmMetaMapping() invalidates the stale audience-breakdown cache on every successful confirm (the real root cause fix) — real DB, real profile:');
{
  // Real fixture from this exact investigation: profile 172 (جهاز تنظيف
  // الأذن بالماء الآمن, product 254), campaign 120252569496130205 already
  // MAPPED to it for real.
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: 172 } });
  const realMappedCampaignId = '120252569496130205';
  if (!profile) {
    console.log('  (skipped — profile 172 not present in this DB; this fixture is specific to the investigated product, not a general requirement)');
  } else {
    const snap = await prisma.productMarketingSnapshot.findFirst({ where: { profile_id: profile.id, window_name: 'today' } });
    if (!snap) {
      console.log('  (skipped — no "today" snapshot row exists for profile 172 right now)');
    } else {
      // Seed a non-null cached blob (simulating "computed a moment ago"), then confirm the mapping again and prove it gets cleared.
      await prisma.productMarketingSnapshot.update({ where: { id: snap.id }, data: { audience_breakdown_json: JSON.stringify({ available: true, generatedAt: new Date().toISOString(), age: [], gender: [], fixture: 'pre-confirm-stale-marker' }) } });
      const before = await prisma.productMarketingSnapshot.findUnique({ where: { id: snap.id }, select: { audience_breakdown_json: true } });
      ok('fixture sanity: a cached audience_breakdown_json is present before confirming', !!before.audience_breakdown_json);

      const result = await confirmMetaMapping({ profileId: profile.id, campaignIds: [realMappedCampaignId], userId: 1 });
      ok('confirmMetaMapping() returns a MAPPED result for the real, already-valid campaign', result.results?.[0]?.status === 'MAPPED', JSON.stringify(result.results));

      const after = await prisma.productMarketingSnapshot.findUnique({ where: { id: snap.id }, select: { audience_breakdown_json: true } });
      ok('audience_breakdown_json is now null — the stale cache was invalidated, the next read will honestly recompute instead of serving pre-confirmation numbers', after.audience_breakdown_json === null, JSON.stringify(after));
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
