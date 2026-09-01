// searchProviders/index.js — the registry every platform search goes
// through. Instagram/Facebook/TikTok have no official third-party public-
// content search API, so they're honestly served via `site:`-filtered
// search (real indexed public URLs, not fabricated) through either of two
// interchangeable providers: SerpApi (preferred when configured — see
// serpApiProvider.js's header comment for why it also uses `site:`
// filtering rather than a dedicated per-platform engine) or Google Custom
// Search as a fallback. YouTube prefers its own real Data API (richer
// metrics) and falls back to Google Custom Search when only that is
// configured. META_AD_LIBRARY has its own two-path provider (real Meta
// Graph API first, SerpApi Ad-Library search second) — see
// metaAdLibraryProvider.js's header comment for why. Adding another real
// provider later means adding one file + registering it here — this
// module is the only thing that needs to change (Step 34).
import * as googleSearchProvider from './googleSearchProvider.js';
import * as youtubeSearchProvider from './youtubeSearchProvider.js';
import * as serpApiProvider from './serpApiProvider.js';
import * as metaAdLibraryProvider from './metaAdLibraryProvider.js';

const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube', 'META_AD_LIBRARY'];
const SERPAPI_PLATFORMS = new Set(['instagram', 'facebook', 'tiktok']);

/** @returns {Promise<{platform: string, provider: string|null, status: 'CONNECTED'|'NOT_CONFIGURED'|'ERROR', detail?: string|null}[]>} */
export async function getProviderStatus() {
  const serpApiOk = serpApiProvider.isConfigured();
  const googleOk = googleSearchProvider.isConfigured();
  const youtubeOk = youtubeSearchProvider.isConfigured();
  const igFbTiktokStatus = { provider: serpApiOk ? 'serpapi' : 'google_custom_search', status: serpApiOk || googleOk ? 'CONNECTED' : 'NOT_CONFIGURED' };
  const metaAdLib = await metaAdLibraryProvider.getStatus();
  return [
    { platform: 'instagram', ...igFbTiktokStatus },
    { platform: 'facebook', ...igFbTiktokStatus },
    { platform: 'tiktok', ...igFbTiktokStatus },
    { platform: 'youtube', provider: youtubeOk ? 'youtube_data_api' : 'google_custom_search', status: youtubeOk || googleOk ? 'CONNECTED' : 'NOT_CONFIGURED' },
    { platform: 'META_AD_LIBRARY', ...metaAdLib },
  ];
}

export async function isAnyProviderConfigured() {
  if (serpApiProvider.isConfigured() || googleSearchProvider.isConfigured() || youtubeSearchProvider.isConfigured()) return true;
  return metaAdLibraryProvider.isConfigured();
}

/**
 * Runs one query against the right provider for the given platform.
 * Throws on failure (caller isolates per-platform/per-query failures —
 * Step 19) — never returns fabricated results.
 * @param {{platform: string, query: string, resultsLimit: number, country?: string}} params
 * @returns {Promise<{items: object[], providerName: string}>}
 */
export async function runProviderSearch({ platform, query, resultsLimit, country }) {
  if (!PLATFORMS.includes(platform)) throw new Error(`منصة غير مدعومة: ${platform}`);

  if (platform === 'META_AD_LIBRARY') {
    return metaAdLibraryProvider.search({ query, resultsLimit, country });
  }

  if (platform === 'youtube' && youtubeSearchProvider.isConfigured()) {
    const items = await youtubeSearchProvider.search({ query, resultsLimit });
    return { items, providerName: 'youtube_data_api' };
  }

  if (SERPAPI_PLATFORMS.has(platform) && serpApiProvider.isConfigured()) {
    const items = await serpApiProvider.search({ query, platform, resultsLimit });
    return { items, providerName: 'serpapi' };
  }

  if (!googleSearchProvider.isConfigured()) {
    const hint = SERPAPI_PLATFORMS.has(platform) ? 'SERPAPI_API_KEY أو GOOGLE_SEARCH_API_KEY و GOOGLE_SEARCH_ENGINE_ID' : 'GOOGLE_SEARCH_API_KEY و GOOGLE_SEARCH_ENGINE_ID';
    throw new Error(`Search Provider غير مربوط — محتاج ${hint} عشان البحث في ${platform} يشتغل.`);
  }
  const items = await googleSearchProvider.search({ query, platform, resultsLimit });
  return { items, providerName: 'google_custom_search' };
}
