// ogImageFetch.js — best-effort real thumbnail backfill for Winner Products
// raw items. SerpApi's organic google results only carry a `thumbnail` field
// for a minority of listings (confirmed live: YouTube 100% via its own Data
// API, but Instagram/TikTok/Facebook/Meta Ad Library often 0-40%) — this
// fills the gap by reading the REAL og:image/twitter:image meta tag off the
// item's own destination URL (the exact preview image that platform itself
// publishes for that post), never a fabricated or generic placeholder.
// Best-effort only: any failure (timeout, non-200, no meta tag, blocked
// page) resolves to null and the item simply keeps no thumbnail — never
// throws, never blocks the rest of the pipeline.
const FETCH_TIMEOUT_MS = 3500;
const MAX_BYTES = 300_000; // og:image is always in <head>, well within this
const META_TAG_RE = /<meta\s+[^>]*>/gi;
const PROP_RE = /(?:property|name)\s*=\s*["']([^"']+)["']/i;
const CONTENT_RE = /content\s*=\s*["']([^"']+)["']/i;
const WANTED_PROPS = new Set(['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']);

async function fetchLimitedHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WinnerProductsBot/1.0)' },
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (received < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
    }
    try { await reader.cancel(); } catch { /* best-effort only */ }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractOgImage(html) {
  const tags = html.match(META_TAG_RE) || [];
  for (const tag of tags) {
    const propMatch = tag.match(PROP_RE);
    if (!propMatch || !WANTED_PROPS.has(propMatch[1].toLowerCase())) continue;
    const contentMatch = tag.match(CONTENT_RE);
    if (contentMatch && contentMatch[1]) return contentMatch[1];
  }
  return null;
}

export async function fetchOgImage(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const html = await fetchLimitedHtml(url);
  if (!html) return null;
  return extractOgImage(html);
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once.
 * @param {any[]} items
 * @param {number} limit
 * @param {(item: any) => Promise<void>} fn
 */
export async function runWithConcurrency(items, limit, fn) {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = items[idx++];
      await fn(current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
