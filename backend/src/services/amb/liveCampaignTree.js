// Live ad-level tree of ONE campaign, read straight from Meta (read-only).
//
// Why: accounts marked «للمتابعة فقط» are synced LIGHT — campaign-level insights only (listing every ad / ad set of an agency-size account is what made them hang).
// That is perfect for watching, but a scale needs the winning ADS. So for those accounts the scale cards fetch, for the few winning campaigns only, the ads + per-ad insights
// live — TWO Graph calls per campaign (ad sets and the campaign budget come inside the ads read as expansions), cached 5 minutes. The result has the same shape the snapshot
// hierarchy gives (campaign.children = ad sets, each with .children = ads carrying .metrics { purchases, cpa, spend } and .creativeId), so the scale code does not care where it
// came from.
//
// Meta throttles an ad account that is read AND cloned at the same time («Ad Account Has Too Many API Calls»). So this module never hammers a throttled account:
//   · a throttle error puts that account on a 10-minute cool-down (no live reads at all meanwhile);
//   · while cooling down / throttled, the LAST GOOD copy of a campaign (up to 1 hour old) is served instead of nothing;
//   · only when there is no copy at all does the card say «ميتا حاطّة حد طلبات مؤقت — استنى 10–15 دقيقة».
import { graphList, pickPurchases } from '../metaGraphClient.js';

const TTL_MS = 5 * 60_000;
const STALE_MS = 60 * 60_000;
export const COOLDOWN_MS = 10 * 60_000;
const cache = new Map(); // key -> { at, value }
const cooldown = new Map(); // adAccountId -> until (ms)

export const _cacheForTests = cache;
export const _cooldownForTests = cooldown;
export const THROTTLE_RE = /request limit reached|rate limit|too many (api )?calls|\(#(?:4|17|32|613|80000|80003|80004)\)/i;
export const THROTTLED_MSG = 'ميتا حاطّة حد طلبات مؤقت على الحساب ده — استنى 10–15 دقيقة وحدّث الصفحة';

/** Pure: build the ad-set → ads tree from the raw Meta reads. */
export function buildLiveTree({ ads, insights }) {
  const metricsByAd = new Map();
  for (const r of insights || []) {
    const spend = Number(r.spend) || 0;
    const pk = pickPurchases(r.actions);
    const purchases = pk.value == null ? 0 : pk.value;
    metricsByAd.set(String(r.ad_id), { spend, purchases, cpa: purchases > 0 ? spend / purchases : null });
  }
  const byAdset = new Map();
  for (const ad of ads || []) {
    const sid = String(ad.adset_id || '');
    if (!byAdset.has(sid)) byAdset.set(sid, { id: sid, name: ad.adset?.name || sid, children: [] });
    byAdset.get(sid).children.push({
      id: String(ad.id), name: ad.name || String(ad.id), creativeId: ad.creative?.id ? String(ad.creative.id) : null, status: ad.effective_status || ad.status || null,
      metrics: metricsByAd.get(String(ad.id)) || { spend: 0, purchases: 0, cpa: null },
    });
  }
  return [...byAdset.values()];
}

/** Pure: the campaign's daily/lifetime budget in major units from the `campaign{…}` expansion of any of its ads, or null (= ABO). */
export function campaignBudgetFromAds(ads) {
  const c = (ads || []).find((a) => a.campaign)?.campaign;
  if (!c) return null;
  const minor = Number(c.daily_budget) > 0 ? Number(c.daily_budget) : Number(c.lifetime_budget) > 0 ? Number(c.lifetime_budget) : 0;
  return minor > 0 ? minor / 100 : null;
}

/** { children, budget } for one campaign + window; throws on a Meta error (the caller decides what to show). */
export async function fetchLiveCampaignTree({ token, campaignId, window, adAccountId = null }, { reader = null, now = () => Date.now() } = {}) {
  const key = `${campaignId}|${window.from}|${window.to}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < TTL_MS) return hit.value;
  const cooling = adAccountId && (cooldown.get(adAccountId) || 0) > now();
  const staleOk = hit && now() - hit.at < STALE_MS;
  if (cooling) { if (staleOk) return hit.value; const e = new Error(THROTTLED_MSG); e.throttled = true; throw e; }
  const r = reader || {
    ads: () => graphList(`/${campaignId}/ads`, { fields: 'id,name,adset_id,adset{name},creative{id},effective_status,campaign{daily_budget,lifetime_budget}' }, token),
    insights: () => graphList(`/${campaignId}/insights`, { level: 'ad', time_range: { since: window.from, until: window.to }, use_unified_attribution_setting: 'true', action_report_time: 'conversion', fields: 'ad_id,spend,actions' }, token),
  };
  try {
    const ads = await r.ads();
    const insights = await r.insights();
    const value = { children: buildLiveTree({ ads, insights }), budget: campaignBudgetFromAds(ads) };
    cache.set(key, { at: now(), value });
    return value;
  } catch (e) {
    if (THROTTLE_RE.test(String(e?.message || e))) {
      if (adAccountId) cooldown.set(adAccountId, now() + COOLDOWN_MS);
      if (staleOk) return hit.value; // an old copy of the same campaign beats an empty card
      const te = new Error(THROTTLED_MSG); te.throttled = true; throw te;
    }
    throw e;
  }
}

/** Hydrate the given hierarchy campaign nodes in place (bounded concurrency). A failure marks the node (`__adsError`) instead of failing the whole list; after a throttle the rest are not even tried. */
export async function hydrateCampaigns({ token, camps, window, adAccountId = null, concurrency = 2 }, deps = {}) {
  let i = 0; let stop = false;
  const worker = async () => {
    while (i < camps.length && !stop) {
      const camp = camps[i++];
      try {
        const v = await fetchLiveCampaignTree({ token, campaignId: camp.id, window, adAccountId }, deps);
        camp.children = v.children; camp.budget = v.budget; camp.__live = true;
      } catch (e) {
        camp.__adsError = e?.throttled ? THROTTLED_MSG : String(e?.message || e).slice(0, 200);
        if (e?.throttled) stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, camps.length) }, worker));
  for (const camp of camps) if (!camp.__live && !camp.__adsError) camp.__adsError = THROTTLED_MSG; // skipped after a throttle
  return camps;
}
