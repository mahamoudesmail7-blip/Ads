// searchProviders/index.js — the registry every platform search goes
// through. Instagram/Facebook/TikTok have no official third-party public-
// content search API, so they're honestly served via Google Custom
// Search's `site:` filtering (real indexed public URLs, not fabricated —
// see googleSearchProvider.js's header comment). YouTube prefers its own
// real Data API (richer metrics) and falls back to the same Google
// provider when only that is configured. Adding a real native
// Instagram/Facebook/TikTok provider later means adding one file here and
// registering it — this module is the only thing that needs to change
// (Step 34: future-proof architecture).
import * as googleSearchProvider from './googleSearchProvider.js';
import * as youtubeSearchProvider from './youtubeSearchProvider.js';

const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube'];

/** @returns {{platform: string, provider: string, status: 'CONNECTED'|'NOT_CONFIGURED'}[]} */
export function getProviderStatus() {
  const googleOk = googleSearchProvider.isConfigured();
  const youtubeOk = youtubeSearchProvider.isConfigured();
  return [
    { platform: 'instagram', provider: 'google_custom_search', status: googleOk ? 'CONNECTED' : 'NOT_CONFIGURED' },
    { platform: 'facebook', provider: 'google_custom_search', status: googleOk ? 'CONNECTED' : 'NOT_CONFIGURED' },
    { platform: 'tiktok', provider: 'google_custom_search', status: googleOk ? 'CONNECTED' : 'NOT_CONFIGURED' },
    { platform: 'youtube', provider: youtubeOk ? 'youtube_data_api' : 'google_custom_search', status: youtubeOk || googleOk ? 'CONNECTED' : 'NOT_CONFIGURED' },
  ];
}

export function isAnyProviderConfigured() {
  return googleSearchProvider.isConfigured() || youtubeSearchProvider.isConfigured();
}

/**
 * Runs one query against the right provider for the given platform.
 * Throws on failure (caller isolates per-platform/per-query failures —
 * Step 19) — never returns fabricated results.
 * @param {{platform: string, query: string, resultsLimit: number}} params
 * @returns {Promise<{items: object[], providerName: string}>}
 */
export async function runProviderSearch({ platform, query, resultsLimit }) {
  if (!PLATFORMS.includes(platform)) throw new Error(`منصة غير مدعومة: ${platform}`);

  if (platform === 'youtube' && youtubeSearchProvider.isConfigured()) {
    const items = await youtubeSearchProvider.search({ query, resultsLimit });
    return { items, providerName: 'youtube_data_api' };
  }

  if (!googleSearchProvider.isConfigured()) {
    throw new Error(`Google Search Provider غير مربوط — محتاج GOOGLE_SEARCH_API_KEY و GOOGLE_SEARCH_ENGINE_ID عشان البحث في ${platform} يشتغل.`);
  }
  const items = await googleSearchProvider.search({ query, platform, resultsLimit });
  return { items, providerName: 'google_custom_search' };
}
