// youtubeSearchProvider.js — real YouTube Data API v3 (search.list +
// videos.list for real view/like counts). Preferred over the Google
// site:youtube.com fallback when configured, since this returns real
// structured metrics (views/likes) the generic web search can't.
import { logger } from '../../logger.js';

const SEARCH_ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';
const VIDEOS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';

export function isConfigured() {
  return Boolean(process.env.YOUTUBE_API_KEY?.trim());
}

/**
 * @param {{query: string, resultsLimit?: number}} params
 * @returns {Promise<object[]>} normalized-ish items with real metrics
 */
export async function search({ query, resultsLimit = 10 }) {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) throw new Error('YouTube Search Provider غير مربوط — YOUTUBE_API_KEY مش متظبط.');

  const searchUrl = new URL(SEARCH_ENDPOINT);
  searchUrl.searchParams.set('key', apiKey);
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('part', 'snippet');
  searchUrl.searchParams.set('type', 'video');
  searchUrl.searchParams.set('maxResults', String(Math.min(50, resultsLimit)));

  let res;
  try {
    res = await fetch(searchUrl.toString());
  } catch (err) {
    throw new Error(`مقدرش أوصل لـ YouTube API: ${err.message}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    const msg = data?.error?.message || `YouTube API error ${res.status}`;
    logger.error('YOUTUBE_SEARCH_PROVIDER_FAILED', { status: res.status, message: msg });
    throw new Error(msg);
  }

  const items = data.items || [];
  const videoIds = items.map((i) => i.id?.videoId).filter(Boolean);
  let statsById = new Map();
  if (videoIds.length > 0) {
    const statsUrl = new URL(VIDEOS_ENDPOINT);
    statsUrl.searchParams.set('key', apiKey);
    statsUrl.searchParams.set('id', videoIds.join(','));
    statsUrl.searchParams.set('part', 'statistics');
    try {
      const statsRes = await fetch(statsUrl.toString());
      const statsData = await statsRes.json().catch(() => null);
      if (statsRes.ok && statsData?.items) {
        statsById = new Map(statsData.items.map((v) => [v.id, v.statistics]));
      }
    } catch {
      // Real metrics are a bonus, not a requirement — never fail the whole search because the stats call hiccupped (Step "Do not fail the entire search if some metrics cannot be retrieved").
    }
  }

  return items.map((item) => {
    const vid = item.id?.videoId;
    const stats = statsById.get(vid);
    return {
      url: `https://www.youtube.com/watch?v=${vid}`,
      title: item.snippet?.title,
      snippet: item.snippet?.description,
      thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
      accountName: item.snippet?.channelTitle,
      publishedAt: item.snippet?.publishedAt || null,
      metrics: stats ? { views: stats.viewCount ? Number(stats.viewCount) : null, likes: stats.likeCount ? Number(stats.likeCount) : null } : {},
      raw: item,
    };
  });
}
