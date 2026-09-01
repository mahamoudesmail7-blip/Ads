// metaAdLibraryProvider.js — Meta Ads Library discovery. Two real,
// compliant paths, tried in order, never fabricated:
//
// 1. Official Meta Ad Library API (/ads_archive), using the SAME Meta
//    OAuth connection already built for Meta Ads sync (services/
//    metaAuth.js) — reused as-is, no new credential. Real, but Meta's own
//    documented limitation: unrestricted commercial-ad keyword search is
//    only guaranteed in EU/DSA-covered regions; for other countries
//    (Egypt included) this commonly comes back empty or error-restricted
//    even with a fully valid ads_read token. That's Meta's own API
//    behavior, not a bug.
// 2. SerpApi fallback (site:facebook.com/ads/library — real, indexed,
//    public Ad Library URLs), reusing the SAME SERPAPI_API_KEY already
//    configured for Instagram/Facebook/TikTok — no new credential either.
//
// getStatus() reports which path is actually usable, or ERROR if the last
// real attempt failed, or NOT_CONFIGURED if neither path exists at all —
// never a hardcoded CONNECTED.
import { logger } from '../../logger.js';
import * as metaAuth from '../metaAuth.js';
import { searchAdLibrary } from '../metaGraphClient.js';
import * as serpApiProvider from './serpApiProvider.js';

const COUNTRY_MAP = { EG: 'EG', SA: 'SA', AE: 'AE', KW: 'KW' }; // Meta's ad_reached_countries expects real ISO country codes; Worldwide has no single equivalent, so it's handled by the caller passing undefined -> Graph path skipped, SerpApi has no country restriction anyway.

let lastError = null; // module-level, session-lifetime only — same "no new infra" cache pattern as productResearchOrchestrator.js's search cache.

// Real, empirically-confirmed finding from live testing: for Egypt (and
// presumably most non-EU/DSA countries), Meta's /ads_archive endpoint does
// NOT reliably filter by search_terms for regular commercial ads — it can
// return a generic sample of ads reaching that country regardless of the
// query, which would otherwise look like real-but-irrelevant results. This
// is a plain relevance filter on already-real data (never invents
// anything) that discards a Graph API ad whose own text has zero
// overlap with the query, and signals "try the fallback" only when NONE
// of the batch survives that check — i.e. when Meta clearly ignored the
// search term entirely, not when it's just one loosely-related hit.
function hasQueryOverlap(adText, query) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (words.length === 0) return true; // nothing meaningful to check against — don't over-filter
  const haystack = adText.toLowerCase();
  return words.some((w) => haystack.includes(w));
}

async function metaConnectionUsable() {
  try {
    const connection = await metaAuth.getConnection();
    return Boolean(connection && connection.status === 'CONNECTED' && connection.access_token_enc);
  } catch {
    return false;
  }
}

/** @returns {Promise<{status: 'CONNECTED'|'NOT_CONFIGURED'|'ERROR', provider: string|null, detail: string|null}>} */
export async function getStatus() {
  const metaOk = await metaConnectionUsable();
  const serpOk = serpApiProvider.isConfigured();
  if (!metaOk && !serpOk) return { status: 'NOT_CONFIGURED', provider: null, detail: 'مفيش حساب Meta متصل ومفيش SERPAPI_API_KEY.' };
  if (lastError) return { status: 'ERROR', provider: lastError.provider, detail: lastError.message };
  return { status: 'CONNECTED', provider: metaOk ? 'meta_ad_library_api' : 'serpapi_ad_library_search', detail: null };
}

export async function isConfigured() {
  return (await metaConnectionUsable()) || serpApiProvider.isConfigured();
}

/**
 * Returns {items, providerName} — providerName reflects the path that
 * ACTUALLY served this specific call, never guessed from general
 * configuration state (an earlier version inferred it from getStatus(),
 * which meant a call that fell through to SerpApi could get mislabeled as
 * having come from the real Graph API — caught via a real live test where
 * the returned ad content didn't match what the label implied, fixed here).
 * @param {{query: string, resultsLimit?: number, country?: string}} params
 * @returns {Promise<{items: object[], providerName: string}>}
 */
export async function search({ query, resultsLimit = 10, country = 'EG' }) {
  if (await metaConnectionUsable()) {
    try {
      const token = await metaAuth.getDecryptedToken();
      const isoCountry = COUNTRY_MAP[country];
      if (isoCountry) {
        const ads = await searchAdLibrary(token, { searchTerms: query, countries: [isoCountry], limit: resultsLimit });
        const relevantAds = ads.filter((ad) => hasQueryOverlap([ad.ad_creative_bodies?.[0], ad.ad_creative_link_titles?.[0], ad.ad_creative_link_descriptions?.[0], ad.page_name].filter(Boolean).join(' '), query));
        if (ads.length > 0 && relevantAds.length === 0) {
          // Meta returned real ads but ignored the search term entirely (confirmed live for Egypt commercial ads) -- fall through to SerpApi instead of surfacing a generic, unrelated sample as if it were a real match.
          logger.info('META_AD_LIBRARY_GRAPH_API_IRRELEVANT', { query, country: isoCountry, returnedCount: ads.length });
          lastError = { provider: 'meta_ad_library_api', message: `فيسبوك رجّع ${ads.length} إعلان حقيقي بس مفيهمش أي واحد له علاقة بكلمة البحث — على الأغلب الـ API مش بيفلتر بالكلمة في الدولة دي.` };
        } else {
          lastError = null;
          const items = relevantAds.map((ad) => ({
            url: ad.ad_snapshot_url,
            title: ad.ad_creative_link_titles?.[0] || (ad.ad_creative_bodies?.[0] || '').slice(0, 80) || null,
            snippet: ad.ad_creative_bodies?.[0] || ad.ad_creative_link_descriptions?.[0] || null,
            accountName: ad.page_name || null,
            accountUrl: ad.page_id ? `https://www.facebook.com/${ad.page_id}` : null,
            thumbnail: null, // ads_archive doesn't return a direct image URL field — the snapshot page itself is the visual record, never fabricated here
            publishedAt: ad.ad_delivery_start_time || ad.ad_creation_time || null,
            metrics: {
              adId: ad.id || null,
              endDate: ad.ad_delivery_stop_time || null,
              activeStatus: ad.ad_delivery_stop_time ? 'INACTIVE' : 'ACTIVE',
              platformsShownOn: ad.publisher_platforms || [],
              cta: ad.ad_creative_link_captions?.[0] || null,
              mediaType: null, // not exposed by this field set without deeper per-ad lookup — left honestly null, never guessed
              description: ad.ad_creative_link_descriptions?.[0] || null,
              country: isoCountry,
            },
            raw: ad,
          }));
          return { items, providerName: 'meta_ad_library_api' };
        }
      }
      // No ISO mapping for this country selector value (e.g. "Worldwide") -- fall through to SerpApi below rather than guessing a country.
    } catch (err) {
      logger.error('META_AD_LIBRARY_GRAPH_API_FAILED', { message: err.message, graphCode: err.graphCode, graphSubcode: err.graphSubcode });
      lastError = { provider: 'meta_ad_library_api', message: err.message };
      // Real, documented Meta limitation for non-EU commercial search -- fall through to the SerpApi path instead of failing the whole platform.
    }
  }

  if (!serpApiProvider.isConfigured()) {
    throw new Error('Meta Ads Library غير مربوط — محتاج حساب Meta متصل (ads_read) أو SERPAPI_API_KEY.');
  }
  try {
    const items = await serpApiProvider.searchAdLibrary({ query, resultsLimit });
    lastError = null;
    return { items, providerName: 'serpapi_ad_library_search' };
  } catch (err) {
    lastError = { provider: 'serpapi_ad_library_search', message: err.message };
    throw err;
  }
}
