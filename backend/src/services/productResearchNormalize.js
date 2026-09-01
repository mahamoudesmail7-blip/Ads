// productResearchNormalize.js — Steps 5-7: turns a raw provider item into
// the canonical ProductResearchResult shape, validates/canonicalizes its
// URL (rejecting anything malformed or off-domain — also the SSRF guard:
// this is the only place a provider-returned URL is ever trusted, and it's
// checked against a fixed platform-domain whitelist before it's stored or
// ever fetched again), and deduplicates against what's already been found.
const ALLOWED_DOMAINS = {
  instagram: ['instagram.com', 'www.instagram.com'],
  facebook: ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.watch'],
  tiktok: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com'],
  youtube: ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'],
  META_AD_LIBRARY: ['facebook.com', 'www.facebook.com'], // real Ad Library snapshot/search URLs live under facebook.com/ads/library
};

// Tracking/query params stripped for canonicalization — never security-relevant, just noise that would otherwise make the same real post look like two different URLs.
const STRIP_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'igshid', 'fbclid', 'si', 'feature'];

/** @returns {URL|null} — null means reject (malformed, wrong protocol, or not on the platform's real domain). */
export function validateAndCanonicalize(rawUrl, platform) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const allowed = ALLOWED_DOMAINS[platform] || [];
  if (!allowed.includes(url.hostname.toLowerCase())) return null;

  for (const p of STRIP_PARAMS) url.searchParams.delete(p);
  url.hash = '';
  // Drop a single trailing slash for consistency (but never collapse the root path itself).
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  return url;
}

// Bounds raw_metadata_json's size without ever producing invalid JSON. A
// plain `.slice(0, N)` on the stringified JSON (the previous approach) cuts
// mid-string/mid-token for any provider payload over the cap — confirmed
// live: ~5% of real Apify Ad Library items (the ones with long nested video
// CDN URLs) landed in the DB as unparseable truncated JSON. This field is
// diagnostic-only (never rendered raw to users), so a truncated-but-valid
// marker object is the safe behavior instead.
const RAW_METADATA_MAX_CHARS = 20000;
function safeTruncatedJson(obj, maxChars = RAW_METADATA_MAX_CHARS) {
  const full = JSON.stringify(obj || {});
  if (full.length <= maxChars) return full;
  return JSON.stringify({ _truncated: true, _originalLength: full.length, preview: full.slice(0, maxChars) });
}

function detectContentType(platform, url) {
  const path = url.pathname.toLowerCase();
  if (platform === 'instagram') {
    if (path.includes('/reel/')) return 'Reel';
    if (path.includes('/p/')) return 'Post';
    if (path.split('/').filter(Boolean).length === 1) return 'Profile';
    return 'Unknown';
  }
  if (platform === 'facebook') {
    if (path.includes('/videos/')) return 'Video';
    if (path.includes('/posts/') || path.includes('/permalink')) return 'Post';
    if (path.startsWith('/pages/') || path.split('/').filter(Boolean).length === 1) return 'Page';
    return 'Unknown';
  }
  if (platform === 'tiktok') {
    if (path.includes('/video/')) return 'Video';
    if (path.startsWith('/@') && path.split('/').filter(Boolean).length === 1) return 'Creator';
    return 'Unknown';
  }
  if (platform === 'youtube') {
    if (path.includes('/shorts/')) return 'Short';
    if (path.includes('/watch') || url.hostname === 'youtu.be') return 'Video';
    if (path.startsWith('/channel/') || path.startsWith('/@') || path.startsWith('/c/')) return 'Channel';
    return 'Unknown';
  }
  if (platform === 'META_AD_LIBRARY') return 'Ad'; // every validated result on this platform is, by definition, a real ad
  return 'Unknown';
}

/**
 * @param {object} raw item from a search provider (shape varies by provider — see searchProviders/*)
 * @param {{platform: string, provider: string, query: string, queryType: string}} context
 * @returns {object|null} normalized result ready to persist, or null if the URL failed validation
 */
export function normalizeResult(raw, context) {
  const canonical = validateAndCanonicalize(raw.url, context.platform);
  if (!canonical) return null;

  return {
    platform: context.platform,
    content_type: detectContentType(context.platform, canonical),
    canonical_url: canonical.toString(),
    original_url: raw.url,
    title: raw.title || null,
    snippet: raw.snippet || null,
    account_name: raw.accountName || null,
    account_url: raw.accountUrl || null,
    thumbnail: raw.thumbnail || null,
    published_at: raw.publishedAt ? new Date(raw.publishedAt) : null,
    metrics_json: raw.metrics && Object.keys(raw.metrics).length ? JSON.stringify(raw.metrics) : null,
    provider: context.provider,
    raw_metadata_json: safeTruncatedJson(raw.raw || {}),
    discovered_by_queries_json: JSON.stringify([{ query: context.query, queryType: context.queryType }]),
  };
}

/**
 * Step 7 — dedup across queries within one search run, merging
 * discovered_by_queries so a result found by 3 queries records all 3
 * instead of showing up 3 times.
 * @param {object[]} normalizedResults
 * @returns {object[]} deduplicated
 */
export function deduplicateResults(normalizedResults) {
  const byUrl = new Map();
  for (const r of normalizedResults) {
    const existing = byUrl.get(r.canonical_url);
    if (!existing) {
      byUrl.set(r.canonical_url, r);
      continue;
    }
    const existingQueries = JSON.parse(existing.discovered_by_queries_json || '[]');
    const newQueries = JSON.parse(r.discovered_by_queries_json || '[]');
    existing.discovered_by_queries_json = JSON.stringify([...existingQueries, ...newQueries]);
    // Keep the richer metadata (whichever has more populated fields) as the primary record.
    const existingScore = ['title', 'snippet', 'thumbnail', 'metrics_json'].filter((k) => existing[k]).length;
    const newScore = ['title', 'snippet', 'thumbnail', 'metrics_json'].filter((k) => r[k]).length;
    if (newScore > existingScore) {
      for (const k of ['title', 'snippet', 'thumbnail', 'metrics_json', 'account_name']) if (r[k]) existing[k] = r[k];
    }
  }
  return [...byUrl.values()];
}
