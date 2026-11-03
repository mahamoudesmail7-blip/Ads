// AMB Media — stage 1 of the video finder: search BY THE PRODUCT PHOTO (Google Lens through SerpApi).
// Lens returns pages that visually match the photo; from them we keep video links (TikTok / Instagram / YouTube), TikTok accounts that
// post this product, and page titles (used as extra keywords for the text search that follows).
// SerpApi's documented way is `engine=google_lens&url=<public image url>`; when the photo has no public URL (a manually uploaded one) we fall
// back to the upload step in the spec (POST /image, photo under 480 KB) — that fallback follows the spec and could not be verified without a
// real key. Parsing is deliberately tolerant: besides the JSON fields it scans the whole response text for video links.
import { MediaError } from './mediaJobs.js';

const SERP = 'https://serpapi.com';
const VIDEO_RES = [
  /https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/@[\w.]+\/video\/\d+/gi,
  /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p)\/[\w-]+/gi,
  /https?:\/\/(?:www\.)?youtube\.com\/(?:shorts\/[\w-]+|watch\?v=[\w-]+)/gi,
  /https?:\/\/youtu\.be\/[\w-]+/gi,
];
const ACCOUNT_RE = /https?:\/\/(?:www\.)?tiktok\.com\/(@[\w.]+)(?=["\\/?\s]|$)(?!\/video)/gi;
export const MAX_UPLOAD_BYTES = 480 * 1024;

/** Pure: pull video links, TikTok accounts and titles out of one Lens response (parsed JSON and/or raw text). */
export function parseLens(json, rawText = '') {
  const text = rawText || JSON.stringify(json || {});
  const videos = new Set();
  for (const re of VIDEO_RES) for (const m of text.matchAll(re)) videos.add(m[0].replace(/\\u0026/g, '&').replace(/[.,)]+$/, ''));
  const accounts = new Set();
  for (const m of text.matchAll(ACCOUNT_RE)) accounts.add(m[1].toLowerCase());
  const titles = [];
  for (const k of ['visual_matches', 'knowledge_graph', 'products']) for (const it of json?.[k] || []) { const t = String(it?.title || '').replace(/\s+/g, ' ').trim(); if (t.length >= 12 && !titles.includes(t)) titles.push(t.slice(0, 80)); }
  return { videoUrls: [...videos], accounts: [...accounts], titles: titles.slice(0, 12) };
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(45_000) });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new MediaError('SerpApi: المفتاح غلط أو مرفوض.', 'SERPAPI_KEY');
  if (res.status === 429) throw new MediaError('SerpApi: الحد الشهري وصل.', 'SERPAPI_LIMIT');
  if (!res.ok) throw new MediaError(`SerpApi ردّ بخطأ ${res.status}.`, 'SERPAPI_HTTP');
  let json = null; try { json = JSON.parse(text); } catch { /* keep raw */ }
  if (json?.error) throw new MediaError(`SerpApi: ${String(json.error).slice(0, 160)}`, 'SERPAPI_ERROR');
  return { json, text };
}

/** Upload fallback from the spec: a photo under 480 KB → image_id (valid ~10 minutes). */
async function uploadForLens({ key, image, fetchImpl }) {
  if (image.buffer.length > MAX_UPLOAD_BYTES) throw new MediaError('صورة المنتج أكبر من 480KB ومفيش لها رابط عام — صغّرها وارفعها تاني عشان البحث بالصورة يشتغل.', 'IMAGE_TOO_BIG');
  const form = new FormData();
  form.append('image', new Blob([image.buffer], { type: image.mime || 'image/jpeg' }), 'product.jpg');
  form.append('api_key', key);
  const res = await fetchImpl(`${SERP}/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(45_000) });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.image_id) throw new MediaError('SerpApi: رفع الصورة للبحث فشل.', 'SERPAPI_UPLOAD');
  return j.image_id;
}

/** Two Lens searches (all matches + a TikTok-biased one). `imageUrl` = a public URL of the photo when we have one. Returns { videoUrls, accounts, titles, searches }. */
export async function lensSearch({ key, imageUrl = null, image = null, fetchImpl = fetch }) {
  if (!key) throw new MediaError('SerpApi مش مربوط.', 'NOT_CONFIGURED');
  const base = new URLSearchParams({ engine: 'google_lens', hl: 'ar', country: 'eg', api_key: key });
  if (imageUrl && /^https?:\/\//i.test(imageUrl)) base.set('url', imageUrl);
  else if (image) base.set('image_id', await uploadForLens({ key, image, fetchImpl }));
  else throw new MediaError('مفيش صورة للمنتج للبحث بيها.', 'NO_PRODUCT_IMAGE');

  const variants = [new URLSearchParams(base), new URLSearchParams({ ...Object.fromEntries(base), type: 'visual_matches', q: 'tiktok' })];
  const out = { videoUrls: new Set(), accounts: new Set(), titles: [], searches: 0 };
  let firstError = null;
  for (const v of variants) {
    try {
      const { json, text } = await getJson(`${SERP}/search.json?${v.toString()}`, fetchImpl);
      out.searches++;
      const p = parseLens(json, text);
      p.videoUrls.forEach((u) => out.videoUrls.add(u)); p.accounts.forEach((a) => out.accounts.add(a));
      for (const t of p.titles) if (!out.titles.includes(t)) out.titles.push(t);
    } catch (e) { firstError = firstError || e; }
  }
  if (!out.searches) throw firstError || new MediaError('بحث الصورة فشل.', 'LENS_FAILED');
  return { videoUrls: [...out.videoUrls], accounts: [...out.accounts].slice(0, 5), titles: out.titles.slice(0, 12), searches: out.searches };
}

/** Free public oEmbed (TikTok, YouTube) → { title, author, thumbnail } for a link that came without any data. null when unavailable. */
export async function oembed(url, fetchImpl = fetch) {
  let ep = null;
  if (/tiktok\.com/i.test(url)) ep = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  else if (/youtube\.com|youtu\.be/i.test(url)) ep = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
  if (!ep) return null;
  try {
    const res = await fetchImpl(ep, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const j = await res.json();
    return { title: String(j.title || '').slice(0, 200), author: j.author_name || null, thumbnail: j.thumbnail_url || null };
  } catch { return null; }
}
