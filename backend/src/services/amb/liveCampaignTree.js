// Live ad-level tree of ONE campaign, read straight from Meta (read-only).
//
// Why: accounts marked «للمتابعة فقط» are synced LIGHT — campaign-level insights only (listing every ad / ad set of an agency-size account is what made them hang).
// That is perfect for watching, but a scale needs the winning ADS. So for those accounts the scale cards fetch, for the few winning campaigns only, the ad sets / ads / per-ad
// insights live — 3 small Graph calls per campaign, cached 5 minutes. The result has the same shape the snapshot hierarchy gives (campaign.children = ad sets, each with
// .children = ads carrying .metrics { purchases, cpa, spend } and .creativeId), so the scale code does not care where it came from.
import { graphList, graphFetch, pickPurchases } from '../metaGraphClient.js';

const TTL_MS = 5 * 60_000;
const cache = new Map(); // key -> { at, value }

export const _cacheForTests = cache;

/** Pure: build the ad-set → ads tree from the three raw Meta reads. */
export function buildLiveTree({ adsets, ads, insights }) {
  const metricsByAd = new Map();
  for (const r of insights || []) {
    const spend = Number(r.spend) || 0;
    const pk = pickPurchases(r.actions);
    const purchases = pk.value == null ? 0 : pk.value;
    metricsByAd.set(String(r.ad_id), { spend, purchases, cpa: purchases > 0 ? spend / purchases : null });
  }
  const byAdset = new Map((adsets || []).map((a) => [String(a.id), { id: String(a.id), name: a.name || String(a.id), children: [] }]));
  for (const ad of ads || []) {
    const sid = String(ad.adset_id || '');
    if (!byAdset.has(sid)) byAdset.set(sid, { id: sid, name: sid, children: [] });
    byAdset.get(sid).children.push({
      id: String(ad.id), name: ad.name || String(ad.id), creativeId: ad.creative?.id ? String(ad.creative.id) : null, status: ad.effective_status || ad.status || null,
      metrics: metricsByAd.get(String(ad.id)) || { spend: 0, purchases: 0, cpa: null },
    });
  }
  return [...byAdset.values()].filter((s) => s.children.length);
}

/** { children, budgetKnown } for one campaign + window; throws on a Meta error (the caller decides what to show). */
export async function fetchLiveCampaignTree({ token, campaignId, window }, { reader = null, now = () => Date.now() } = {}) {
  const key = `${campaignId}|${window.from}|${window.to}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < TTL_MS) return hit.value;
  const r = reader || {
    adsets: () => graphList(`/${campaignId}/adsets`, { fields: 'id,name,effective_status' }, token),
    ads: () => graphList(`/${campaignId}/ads`, { fields: 'id,name,adset_id,creative{id},effective_status' }, token),
    insights: () => graphList(`/${campaignId}/insights`, { level: 'ad', time_range: { since: window.from, until: window.to }, use_unified_attribution_setting: 'true', action_report_time: 'conversion', fields: 'ad_id,spend,actions' }, token),
    node: () => graphFetch(`/${campaignId}`, { fields: 'id,daily_budget,lifetime_budget' }, token),
  };
  const [adsets, ads, insights, node] = await Promise.all([r.adsets(), r.ads(), r.insights(), r.node().catch(() => null)]);
  const value = { children: buildLiveTree({ adsets, ads, insights }), budget: node && (Number(node.daily_budget) > 0 || Number(node.lifetime_budget) > 0) ? Number(node.daily_budget || node.lifetime_budget) / 100 : null };
  cache.set(key, { at: now(), value });
  return value;
}

/** Hydrate the given hierarchy campaign nodes in place (bounded concurrency). A failure marks the node (`__adsError`) instead of failing the whole list. */
export async function hydrateCampaigns({ token, camps, window, concurrency = 3 }, deps = {}) {
  let i = 0;
  const worker = async () => {
    while (i < camps.length) {
      const camp = camps[i++];
      try {
        const v = await fetchLiveCampaignTree({ token, campaignId: camp.id, window }, deps);
        camp.children = v.children; camp.budget = v.budget; camp.__live = true;
      } catch (e) { camp.__adsError = String(e?.message || e).slice(0, 200); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, camps.length) }, worker));
  return camps;
}
