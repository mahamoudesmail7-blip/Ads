// apifyMetaAdLibraryProvider.js — real Apify integration for Meta Ads
// Library discovery, the PRIMARY commercial-ad provider now that it's
// been manually verified working for Egypt/Active/keyword search.
//
// Verified directly against the real Apify Store listing (not guessed)
// before writing this file: actor "curious_coder/facebook-ads-library-
// scraper" — its documented output field names (Ad Archive ID, Page ID,
// Page Name, Publisher Platform, Start/End Date, Is Active) match exactly
// what was reported from the real manual test. Its real, documented input
// shape (from the actor's own API tab):
//   { "urls": [{"url": "<a real facebook.com/ads/library/?... search URL>"}],
//     "count": <max ads to scrape> }
// — it scrapes whatever real Ad Library search URL you already know how
// to build (this backend already builds this exact URL shape for the
// SerpApi Ad Library fallback), never a keyword param scraper invents.
//
// APIFY_META_AD_LIBRARY_ACTOR_ID overrides the actor id if the one
// actually tested was different — never silently assumed without this
// escape hatch, per explicit instruction not to hardcode without
// verification.
import { logger } from '../../logger.js';

const DEFAULT_ACTOR_ID = 'curious_coder/facebook-ads-library-scraper';
const API_BASE = 'https://api.apify.com/v2';

function actorId() {
  return (process.env.APIFY_META_AD_LIBRARY_ACTOR_ID?.trim() || DEFAULT_ACTOR_ID).trim();
}
function actorPath() {
  return actorId().replace('/', '~'); // Apify's URL-safe actor path form
}

export function isConfigured() {
  return Boolean(process.env.APIFY_API_TOKEN?.trim());
}

let statusCache = null; // {result, at} — real actor-metadata check (free, no scrape cost), cached briefly so Provider Status doesn't hit Apify on every page load.
const STATUS_CACHE_TTL_MS = 5 * 60 * 1000;

/** @returns {Promise<{status: 'CONNECTED'|'NOT_CONFIGURED'|'ERROR', provider: string|null, detail: string|null}>} */
export async function getStatus() {
  const token = process.env.APIFY_API_TOKEN?.trim();
  if (!token) return { status: 'NOT_CONFIGURED', provider: null, detail: 'APIFY_API_TOKEN مش متظبط.' };

  if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_TTL_MS) return statusCache.result;

  // GET /v2/actors/{id} is free metadata, not a scrape run — safe to call for a real status check without spending Apify credits.
  try {
    const res = await fetch(`${API_BASE}/actors/${actorPath()}?token=${encodeURIComponent(token)}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const result = { status: 'ERROR', provider: 'apify_meta_ad_library', detail: `Apify actor غير متاح (HTTP ${res.status}) — تأكد من APIFY_META_AD_LIBRARY_ACTOR_ID: ${body.slice(0, 200)}` };
      statusCache = { result, at: Date.now() };
      return result;
    }
    const result = { status: 'CONNECTED', provider: 'apify_meta_ad_library', detail: null };
    statusCache = { result, at: Date.now() };
    return result;
  } catch (err) {
    const result = { status: 'ERROR', provider: 'apify_meta_ad_library', detail: `مقدرش أوصل لـ Apify: ${err.message}` };
    statusCache = { result, at: Date.now() };
    return result;
  }
}

/** Real facebook.com/ads/library search URL — the actual input this actor scrapes, same URL shape already used for the SerpApi Ad Library fallback. */
export function buildSearchUrl({ query, country, activeOnly }) {
  const url = new URL('https://www.facebook.com/ads/library/');
  url.searchParams.set('active_status', activeOnly ? 'active' : 'all');
  url.searchParams.set('ad_type', 'all');
  url.searchParams.set('country', country || 'ALL');
  url.searchParams.set('q', query);
  url.searchParams.set('search_type', 'keyword_unordered');
  url.searchParams.set('media_type', 'all');
  return url.toString();
}

async function callApify(endpoint, body, { timeoutSec } = {}) {
  const token = process.env.APIFY_API_TOKEN?.trim();
  const url = new URL(`${API_BASE}${endpoint}`);
  url.searchParams.set('token', token);
  if (timeoutSec) url.searchParams.set('timeout', String(timeoutSec));

  let res;
  try {
    res = await fetch(url.toString(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(`مقدرش أوصل لـ Apify: ${err.message}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || `Apify error ${res.status}`;
    logger.error('APIFY_META_AD_LIBRARY_FAILED', { status: res.status, message: msg });
    throw new Error(msg);
  }
  return data;
}

/**
 * QUICK mode — one real synchronous Apify call (run-sync-get-dataset-items),
 * multiple search queries batched into ONE run's `urls` array (real cost
 * efficiency: one actor run charged once, not once per query). Good for
 * up to ~100-250 raw ads before the sync endpoint's own request timeout
 * becomes a real risk.
 * @param {{queries: string[], country: string, activeOnly: boolean, rawLimit: number}} params
 * @returns {Promise<object[]>} raw actor dataset items
 */
export async function runQuick({ queries, country, activeOnly, rawLimit }) {
  const urls = queries.map((q) => ({ url: buildSearchUrl({ query: q, country, activeOnly }) }));
  const items = await callApify(`/actors/${actorPath()}/run-sync-get-dataset-items`, { urls, count: rawLimit }, { timeoutSec: 120 });
  return Array.isArray(items) ? items : [];
}

/**
 * DEEP mode — real async run + poll (avoids the sync endpoint's tighter
 * timeout for larger raw limits), with a real, bounded retry/timeout loop
 * — never an unbounded polling loop.
 * @param {{queries: string[], country: string, activeOnly: boolean, rawLimit: number}} params
 * @returns {Promise<object[]>}
 */
export async function runDeep({ queries, country, activeOnly, rawLimit }) {
  const urls = queries.map((q) => ({ url: buildSearchUrl({ query: q, country, activeOnly }) }));
  const run = await callApify(`/actors/${actorPath()}/runs`, { urls, count: rawLimit });
  const runId = run?.data?.id;
  if (!runId) throw new Error('Apify مرجعش Run ID — مقدرش أتابع النتيجة.');

  const token = process.env.APIFY_API_TOKEN?.trim();
  const maxPolls = 40; // ~ up to 6-7 minutes at the backoff below — a real, bounded ceiling, never infinite
  let delayMs = 3000;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 1.3, 15000);

    const statusRes = await fetch(`${API_BASE}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
    const statusData = await statusRes.json().catch(() => null);
    const status = statusData?.data?.status;
    if (status === 'SUCCEEDED') {
      const datasetId = statusData.data.defaultDatasetId;
      const itemsRes = await fetch(`${API_BASE}/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&format=json`);
      const items = await itemsRes.json().catch(() => []);
      return Array.isArray(items) ? items : [];
    }
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      throw new Error(`Apify run انتهى بحالة ${status}.`);
    }
    // RUNNING / READY — keep polling
  }
  throw new Error('Apify run استغرق وقت أطول من الحد المسموح — جرب حد أقل أو حاول تاني.');
}
