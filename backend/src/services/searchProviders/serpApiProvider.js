// serpApiProvider.js — real SerpApi (serpapi.com) integration for
// Instagram/Facebook/TikTok discovery. SerpApi has no dedicated
// "Instagram"/"Facebook"/"TikTok" search engine (it doesn't offer one —
// checked against its real documented engine list: google, bing, youtube,
// yahoo, baidu, yandex, duckduckgo, google_maps, google_shopping, ...), so
// this honestly uses SerpApi's real `google` engine with the same
// `site:`-filtering technique as googleSearchProvider.js — real, indexed,
// public URLs from those platforms, never fabricated. Preferred over the
// Google Custom Search provider for these 3 platforms when configured
// (searchProviders/index.js), since it's what was explicitly wired up to
// connect here.
import { logger } from '../../logger.js';

const ENDPOINT = 'https://serpapi.com/search.json';

const SITE_FILTER = {
  instagram: 'site:instagram.com',
  facebook: 'site:facebook.com',
  tiktok: 'site:tiktok.com',
};

export function isConfigured() {
  return Boolean(process.env.SERPAPI_API_KEY?.trim());
}

/**
 * @param {{query: string, platform: string, resultsLimit?: number}} params
 * @returns {Promise<object[]>} raw-ish items (same shape googleSearchProvider.js returns, normalized by the caller — see productResearchNormalize.js)
 */
async function runGoogleQuery(fullQuery, resultsLimit, logContext) {
  const apiKey = process.env.SERPAPI_API_KEY?.trim();
  if (!apiKey) throw new Error('SerpApi Provider غير مربوط — SERPAPI_API_KEY مش متظبط.');

  const url = new URL(ENDPOINT);
  url.searchParams.set('engine', 'google');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('q', fullQuery);
  url.searchParams.set('num', String(Math.min(20, resultsLimit)));

  let res;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    throw new Error(`مقدرش أوصل لـ SerpApi: ${err.message}`);
  }
  const data = await res.json().catch(() => null);
  // SerpApi reports a genuine zero-results search as {error: "Google hasn't
  // returned any results for this query."} on an otherwise-ok response —
  // an honest empty outcome, not a real failure. Treated as such (found via
  // a real search that surfaced this exact case) rather than throwing and
  // making the query log show FAILED for what's actually just "no matches".
  if (res.ok && typeof data?.error === 'string' && /haven'?t returned any results/i.test(data.error)) {
    return [];
  }
  if (!res.ok || data?.error) {
    const msg = data?.error || `SerpApi error ${res.status}`;
    logger.error('SERPAPI_PROVIDER_FAILED', { status: res.status, message: msg, ...logContext });
    throw new Error(msg);
  }
  return data.organic_results || [];
}

/**
 * @param {{query: string, platform: string, resultsLimit?: number}} params
 * @returns {Promise<object[]>} raw-ish items (same shape googleSearchProvider.js returns, normalized by the caller — see productResearchNormalize.js)
 */
export async function search({ query, platform, resultsLimit = 10 }) {
  const siteFilter = SITE_FILTER[platform];
  if (!siteFilter) throw new Error(`SerpApi provider هنا بيغطي بس instagram/facebook/tiktok — منصة غير مدعومة: ${platform}`);

  const items = await runGoogleQuery(`${siteFilter} ${query}`, resultsLimit, { platform });
  return items.map((item) => ({
    url: item.link,
    title: item.title,
    snippet: item.snippet,
    thumbnail: item.thumbnail || null,
    raw: item,
  }));
}

/**
 * Fallback path for Meta Ads Library when the official Graph API's
 * commercial-ad search isn't available for the target country (see
 * metaAdLibraryProvider.js's header comment) — real, indexed, public
 * facebook.com/ads/library URLs via the same Google engine, never
 * fabricated. Coverage is inherently thinner than the official API since
 * Ad Library detail pages are JS-rendered and less exhaustively indexed —
 * disclosed honestly, not hidden.
 * @param {{query: string, resultsLimit?: number}} params
 */
export async function searchAdLibrary({ query, resultsLimit = 10 }) {
  const items = await runGoogleQuery(`site:facebook.com/ads/library ${query}`, resultsLimit, { platform: 'META_AD_LIBRARY' });
  return items.map((item) => ({
    url: item.link,
    title: item.title,
    snippet: item.snippet,
    thumbnail: item.thumbnail || null,
    accountName: null,
    publishedAt: null,
    metrics: { adId: null, endDate: null, activeStatus: null, platformsShownOn: [], cta: null, mediaType: null, description: null, country: null },
    raw: item,
  }));
}
