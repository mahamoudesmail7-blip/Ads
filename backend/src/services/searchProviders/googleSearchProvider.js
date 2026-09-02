// googleSearchProvider.js — real Google Programmable Search Engine (Custom
// Search JSON API) integration. This is the real, honest way this system
// discovers Instagram/Facebook/TikTok (and optionally YouTube) content: no
// official platform API lets a third-party app search arbitrary public
// posts across those platforms, but Google indexes and returns real public
// URLs from them via `site:` filtered queries — the same technique real
// competitor-research tools use. Never fabricates a result; every URL
// returned here came from a real Google API response.
import { logger } from '../../logger.js';

const ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

const SITE_FILTER = {
  instagram: 'site:instagram.com',
  facebook: 'site:facebook.com',
  tiktok: 'site:tiktok.com',
  youtube: 'site:youtube.com',
};

export function isConfigured() {
  return Boolean(process.env.GOOGLE_SEARCH_API_KEY?.trim() && process.env.GOOGLE_SEARCH_ENGINE_ID?.trim());
}

/**
 * @param {{query: string, platform: string, resultsLimit?: number}} params
 * @returns {Promise<object[]>} raw Google items (normalized by the caller — see productResearchNormalize.js)
 */
export async function search({ query, platform, resultsLimit = 10 }) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY?.trim();
  const engineId = process.env.GOOGLE_SEARCH_ENGINE_ID?.trim();
  if (!apiKey || !engineId) throw new Error('Google Search Provider غير مربوط — GOOGLE_SEARCH_API_KEY أو GOOGLE_SEARCH_ENGINE_ID مش متظبطين.');

  const siteFilter = SITE_FILTER[platform];
  const fullQuery = siteFilter ? `${siteFilter} ${query}` : query;

  const url = new URL(ENDPOINT);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('cx', engineId);
  url.searchParams.set('q', fullQuery);
  url.searchParams.set('num', String(Math.min(10, resultsLimit))); // Google Custom Search caps at 10 per request

  let res;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    throw new Error(`مقدرش أوصل لـ Google Search API: ${err.message}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    const msg = data?.error?.message || `Google Search API error ${res.status}`;
    logger.error('GOOGLE_SEARCH_PROVIDER_FAILED', { status: res.status, message: msg, platform });
    const err = new Error(msg);
    err.httpStatus = res.status;
    throw err;
  }

  return (data.items || []).map((item) => ({
    url: item.link,
    title: item.title,
    snippet: item.snippet,
    thumbnail: item.pagemap?.cse_thumbnail?.[0]?.src || item.pagemap?.cse_image?.[0]?.src || null,
    raw: item,
  }));
}
