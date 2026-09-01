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
import * as health from '../providerHealth.js';
import { getAnthropicHealth } from '../ai.js';

const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube', 'META_AD_LIBRARY'];
const SERPAPI_PLATFORMS = new Set(['instagram', 'facebook', 'tiktok']);

/**
 * @returns {Promise<{platform: string, provider: string|null, status: 'CONNECTED'|'NOT_CONFIGURED'|'ERROR'|'DEGRADED', detail?: string|null}[]>}
 * Every entry's status is layered on real recent-traffic health (Step 13's
 * watchdog, providerHealth.js) — CONNECTED can now downgrade to DEGRADED on
 * its own the moment a real request fails, and recovers to CONNECTED the
 * moment one more real request succeeds, with zero redeploy (Step 14).
 * Anthropic is included here too (previously absent from this list
 * entirely) since Product Research's AI ranking/product-analysis depend on
 * it just as much as the search providers do.
 */
export async function getProviderStatus() {
  const serpApiOk = serpApiProvider.isConfigured();
  const googleOk = googleSearchProvider.isConfigured();
  const youtubeOk = youtubeSearchProvider.isConfigured();
  const serpApiHealth = health.classify('serpapi', serpApiOk);
  const googleHealth = health.classify('google_custom_search', googleOk);
  const igFbTiktokUsesSerp = serpApiOk;
  const igFbTiktokStatus = {
    provider: igFbTiktokUsesSerp ? 'serpapi' : 'google_custom_search',
    status: (igFbTiktokUsesSerp ? serpApiHealth : googleHealth).status,
  };
  const youtubeHealth = health.classify('youtube_data_api', youtubeOk);
  const metaAdLib = await metaAdLibraryProvider.getStatus();
  const anthropic = getAnthropicHealth();
  return [
    { platform: 'instagram', ...igFbTiktokStatus },
    { platform: 'facebook', ...igFbTiktokStatus },
    { platform: 'tiktok', ...igFbTiktokStatus },
    { platform: 'youtube', provider: youtubeOk ? 'youtube_data_api' : 'google_custom_search', status: (youtubeOk ? youtubeHealth : googleHealth).status },
    { platform: 'META_AD_LIBRARY', ...metaAdLib },
    // Not a search platform — a shared enhancement layer (product analysis
    // + result ranking). Reported separately so the UI can show it as its
    // own row rather than forcing it onto one platform arbitrarily.
    { platform: 'anthropic', provider: 'anthropic', status: anthropic.status, detail: anthropic.lastErrorType || null, lastCheckedAt: anthropic.lastCheckedAt, lastSuccessfulRequestAt: anthropic.lastSuccessfulRequestAt, lastErrorAt: anthropic.lastErrorAt, latencyMs: anthropic.latencyMs },
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
    // metaAdLibraryProvider.search() already records its own health per real path (Apify/Graph/SerpApi) internally.
    return metaAdLibraryProvider.search({ query, resultsLimit, country });
  }

  if (platform === 'youtube' && youtubeSearchProvider.isConfigured()) {
    const startedAt = Date.now();
    try {
      const items = await youtubeSearchProvider.search({ query, resultsLimit });
      health.recordSuccess('youtube_data_api', Date.now() - startedAt);
      return { items, providerName: 'youtube_data_api' };
    } catch (err) {
      health.recordError('youtube_data_api', health.classifyErrorType(err), Date.now() - startedAt);
      throw err;
    }
  }

  if (SERPAPI_PLATFORMS.has(platform) && serpApiProvider.isConfigured()) {
    const startedAt = Date.now();
    try {
      const items = await serpApiProvider.search({ query, platform, resultsLimit });
      health.recordSuccess('serpapi', Date.now() - startedAt);
      return { items, providerName: 'serpapi' };
    } catch (err) {
      health.recordError('serpapi', health.classifyErrorType(err), Date.now() - startedAt);
      throw err;
    }
  }

  if (!googleSearchProvider.isConfigured()) {
    const hint = SERPAPI_PLATFORMS.has(platform) ? 'SERPAPI_API_KEY أو GOOGLE_SEARCH_API_KEY و GOOGLE_SEARCH_ENGINE_ID' : 'GOOGLE_SEARCH_API_KEY و GOOGLE_SEARCH_ENGINE_ID';
    throw new Error(`Search Provider غير مربوط — محتاج ${hint} عشان البحث في ${platform} يشتغل.`);
  }
  const startedAt = Date.now();
  try {
    const items = await googleSearchProvider.search({ query, platform, resultsLimit });
    health.recordSuccess('google_custom_search', Date.now() - startedAt);
    return { items, providerName: 'google_custom_search' };
  } catch (err) {
    health.recordError('google_custom_search', health.classifyErrorType(err), Date.now() - startedAt);
    throw err;
  }
}
