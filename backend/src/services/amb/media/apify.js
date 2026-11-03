// AMB Media — Apify client for the video finder (TikTok search, Instagram reels by hashtag, Meta Ad Library).
// Read-only searches against public content. Every call takes an injectable fetch so tests never touch the network.
// Failures of ONE source never stop the search: callers catch per source and carry on with the rest.
import { getMediaKey } from './mediaKeys.js';
import { MediaError } from './mediaJobs.js';

const BASE = 'https://api.apify.com/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { token, method = 'GET', body, fetchImpl = fetch }) {
  const res = await fetchImpl(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90_000) });
  const text = await res.text().catch(() => '');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  if (res.status === 401) throw new MediaError('Apify: التوكن غلط.', 'APIFY_KEY');
  if (res.status === 402) throw new MediaError('Apify: الرصيد خلص.', 'APIFY_LIMIT');
  if (!res.ok) {
    const m = String(json?.error?.message || text).slice(0, 200);
    if (/usage hard limit|platform-feature-disabled/i.test(m)) throw new MediaError('حساب Apify وصل للحد الشهري.', 'APIFY_LIMIT');
    throw new MediaError(`Apify ردّ بخطأ ${res.status}: ${m}`, 'APIFY_HTTP');
  }
  return json;
}

/** Run an actor and wait for it. Returns { items, usd }. */
export async function runActor(actor, input, { timeoutSec = 240, fetchImpl = fetch, token } = {}) {
  const tok = token || await getMediaKey('apify');
  if (!tok) throw new MediaError('Apify مش مربوط — حط التوكن من لوحة «أدوات الميديا الذكية».', 'NOT_CONFIGURED');
  const id = actor.replace('/', '~');
  let run = (await api(`/acts/${id}/runs?timeout=${timeoutSec}&waitForFinish=60`, { token: tok, method: 'POST', body: input, fetchImpl }))?.data;
  const deadline = Date.now() + (timeoutSec + 60) * 1000;
  while (run && !['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(run.status) && Date.now() < deadline) {
    run = (await api(`/actor-runs/${run.id}?waitForFinish=60`, { token: tok, fetchImpl }))?.data;
    if (run && !['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(run.status)) await sleep(1000);
  }
  if (!run || run.status !== 'SUCCEEDED') throw new MediaError(`Apify ${actor}: ${run?.status || 'لم يرد'}`, 'APIFY_RUN');
  const items = await api(`/datasets/${run.defaultDatasetId}/items?clean=true`, { token: tok, fetchImpl });
  const usd = Number((await api(`/actor-runs/${run.id}`, { token: tok, fetchImpl }).catch(() => null))?.data?.usageTotalUsd) || 0;
  return { items: Array.isArray(items) ? items : [], usd };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** Pure normalisers → the finder's one candidate shape { url, directUrl, source, author, caption, views, likes, durationSec, thumbnail, adDays, adCount }. */
export function normalizeTikTok(item) {
  if (!item || item.isSlideshow || item.imagePost) return null; // photo posts with music are not videos
  const url = item.webVideoUrl || item.url;
  if (!url) return null;
  return { url, directUrl: null, source: 'TIKTOK', author: item.authorMeta?.name || null, caption: item.text || '', views: num(item.playCount), likes: num(item.diggCount), durationSec: num(item.videoMeta?.duration), thumbnail: item.videoMeta?.coverUrl || item.videoMeta?.originalCoverUrl || null, adDays: null, adCount: null };
}
export function normalizeReel(item) {
  if (!item?.url || !item.videoUrl) return null; // no file = a photo post
  return { url: item.url, directUrl: item.videoUrl, source: 'INSTAGRAM', author: item.ownerUsername || null, caption: item.caption || '', views: num(item.videoPlayCount ?? item.videoViewCount), likes: num(item.likesCount), durationSec: num(item.videoDuration), thumbnail: item.displayUrl || null, adDays: null, adCount: null };
}
export function normalizeAdLibrary(item, now = Date.now()) {
  const snap = item?.snapshot || {};
  const vid = snap.videos?.[0] || snap.cards?.find((c) => c.videoHdUrl || c.videoSdUrl);
  const id = item?.adArchiveID || item?.adArchiveId;
  if (!vid || !id) return null;
  const start = num(item.startDate);
  return { url: `https://www.facebook.com/ads/library/?id=${id}`, directUrl: vid.videoHdUrl || vid.videoSdUrl || null, source: 'META_ADS', author: item.pageName || null, caption: snap.body?.text || snap.title || '', views: null, likes: null, durationSec: null, thumbnail: vid.videoPreviewImageUrl || null, adDays: start ? Math.max(0, Math.round((now / 1000 - start) / 86400)) : null, adCount: num(item.collationCount) };
}

export async function searchTikTok(queries, { country = 'EG', limit = 20, fetchImpl, token } = {}) {
  const { items, usd } = await runActor('clockworks~tiktok-scraper', { searchQueries: queries.slice(0, 15), searchSection: '/video', resultsPerPage: Math.min(60, limit), shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSubtitles: false, shouldDownloadSlideshowImages: false, proxyCountryCode: /^[A-Z]{2}$/.test(country) ? country : 'None' }, { fetchImpl, token });
  return { videos: items.map(normalizeTikTok).filter(Boolean), usd };
}
export async function searchInstagramReels(hashtags, { limit = 10, fetchImpl, token } = {}) {
  const { items, usd } = await runActor('apify~instagram-hashtag-scraper', { hashtags: hashtags.map((h) => String(h).replace(/^#/, '')).slice(0, 5), resultsType: 'reels', resultsLimit: limit }, { fetchImpl, token });
  return { videos: items.map(normalizeReel).filter(Boolean), usd };
}
export async function searchMetaAdLibrary(queries, { country = 'EG', limit = 40, fetchImpl, token } = {}) {
  const startUrls = queries.slice(0, 3).flatMap((q) => [country, 'ALL'].map((c) => ({ url: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${c}&q=${encodeURIComponent(q)}&media_type=video&search_type=keyword_unordered` })));
  const { items, usd } = await runActor('apify~facebook-ads-scraper', { startUrls, resultsLimit: limit, activeStatus: 'active' }, { timeoutSec: 300, fetchImpl, token });
  return { videos: items.map((i) => normalizeAdLibrary(i)).filter(Boolean), usd };
}
