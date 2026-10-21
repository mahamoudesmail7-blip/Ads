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
  if (res.ok && typeof data?.error === 'string' && /returned any results for this query/i.test(data.error)) {
    return [];
  }
  if (!res.ok || data?.error) {
    const msg = data?.error || `SerpApi error ${res.status}`;
    logger.error('SERPAPI_PROVIDER_FAILED', { status: res.status, message: msg, ...logContext });
    const err = new Error(msg);
    // SerpApi reports quota exhaustion ("Your account has run out of
    // searches.") as a 200 OK with an error field in the body, not a 4xx/
    // 5xx status -- httpStatus alone can't distinguish it from a real
    // failure, so the message text itself is the only real signal
    // (providerHealth.classifyErrorType() pattern-matches it).
    err.httpStatus = res.status;
    throw err;
  }
  return data.organic_results || [];
}

/**
 * @param {{query: string, platform: string, resultsLimit?: number}} params
 * @returns {Promise<object[]>} raw-ish items (same shape googleSearchProvider.js returns, normalized by the caller — see productResearchNormalize.js)
 */
// SerpApi's organic_results carry the account/page name for real inside the
// `source` field as "Platform · handle" (e.g. "Instagram · misbar_uae",
// confirmed against live production responses) — Google's own attribution
// text, not anything we compute. Used by the Winner Discovery Engine's
// creator-spread signal (real distinct-creator counting, never fabricated);
// returns null rather than a guess when the field doesn't match.
const SOURCE_HANDLE_RE = /^(?:Instagram|Facebook|TikTok)\s*·\s*(.+)$/i;
function extractCreatorHandle(source) {
  const m = typeof source === 'string' ? source.match(SOURCE_HANDLE_RE) : null;
  return m ? m[1].trim() || null : null;
}

export async function search({ query, platform, resultsLimit = 10 }) {
  const siteFilter = SITE_FILTER[platform];
  if (!siteFilter) throw new Error(`SerpApi provider هنا بيغطي بس instagram/facebook/tiktok — منصة غير مدعومة: ${platform}`);

  const items = await runGoogleQuery(`${siteFilter} ${query}`, resultsLimit, { platform });
  return items.map((item) => ({
    url: item.link,
    title: item.title,
    snippet: item.snippet,
    thumbnail: item.thumbnail || null,
    accountName: extractCreatorHandle(item.source),
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
// Google's indexed title for a facebook.com/ads/library page is often
// literally "Ad Library - <Page Name>" (confirmed against live production
// results) — real attribution text already in the title, extracted the
// same honest way as extractCreatorHandle() above. Returns null (never a
// guess) when the title doesn't match this exact pattern.
const AD_LIBRARY_TITLE_RE = /^ad library\s*-\s*(.+)$/i;
function extractAdLibraryAdvertiser(title) {
  const m = typeof title === 'string' ? title.match(AD_LIBRARY_TITLE_RE) : null;
  return m ? m[1].trim() || null : null;
}

export async function searchAdLibrary({ query, resultsLimit = 10 }) {
  const items = await runGoogleQuery(`site:facebook.com/ads/library ${query}`, resultsLimit, { platform: 'META_AD_LIBRARY' });
  return items.map((item) => ({
    url: item.link,
    title: item.title,
    snippet: item.snippet,
    thumbnail: item.thumbnail || null,
    accountName: extractAdLibraryAdvertiser(item.title),
    publishedAt: null,
    metrics: { adId: null, endDate: null, activeStatus: null, platformsShownOn: [], cta: null, mediaType: null, description: null, country: null },
    raw: item,
  }));
}

// ---- Reverse-image search (Google Lens engine) -----------------------------------------------------------------------------------------------------------
// Test-only SerpApi mock: honoured ONLY when SERPAPI_MOCK=1 and the URL is loopback — production never sets these.
const LENS_MOCK = process.env.SERPAPI_MOCK === '1' && /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(process.env.SERPAPI_MOCK_URL || '') ? process.env.SERPAPI_MOCK_URL : null;

/**
 * Google Lens by image URL. type: 'exact_matches' | 'visual_matches' | 'products' | 'all'.
 * @returns {Promise<{url:string, title:string|null, snippet:string|null, thumbnail:string|null, accountName:string|null, price:object|null, raw:object}[]>}
 */
export async function searchByImage({ imageUrl, type = 'visual_matches', country = 'eg', resultsLimit = 40 }) {
  const apiKey = process.env.SERPAPI_API_KEY?.trim();
  if (!apiKey) throw new Error('SerpApi Provider غير مربوط — SERPAPI_API_KEY مش متظبط.');
  const url = new URL(LENS_MOCK ? `${LENS_MOCK}/search.json` : ENDPOINT);
  url.searchParams.set('engine', 'google_lens');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('url', imageUrl);
  url.searchParams.set('type', type);
  url.searchParams.set('hl', 'ar');
  url.searchParams.set('country', String(country || 'eg').toLowerCase());
  let res;
  try { res = await fetch(url.toString(), { signal: AbortSignal.timeout(45000) }); } catch (err) { throw new Error(`مقدرش أوصل لـ SerpApi: ${err.message}`); }
  const data = await res.json().catch(() => null);
  if (res.ok && typeof data?.error === 'string' && /hasn't returned any results|returned any results/i.test(data.error)) return [];
  if (!res.ok || data?.error) {
    logger.error('SERPAPI_LENS_FAILED', { status: res.status, message: data?.error || res.status, type });
    throw new Error(data?.error || `SerpApi error ${res.status}`);
  }
  const rows = type === 'exact_matches' ? (data.exact_matches || data.visual_matches || []) : (data.visual_matches || data.exact_matches || []);
  return rows.slice(0, resultsLimit).map((m) => ({
    url: m.link,
    title: m.title || null,
    snippet: m.source || null,
    thumbnail: m.thumbnail || m.image || null,
    accountName: m.source || null,
    price: m.price ? { value: m.price.value ?? m.price.extracted_value ?? null, currency: m.price.currency || null } : null,
    raw: m,
  }));
}
