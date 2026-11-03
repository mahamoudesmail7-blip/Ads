// AMB Media — Phase 2: finds existing videos of the product (TikTok search, Instagram reels, Meta Ad Library, pasted links),
// then ranks them by how much their COVER looks like the product's real photo (OpenAI vision through the central gateway).
// Nothing is downloaded or uploaded here — the owner sees the candidates and picks; mediaImport.js does the transfer.
// Every source is optional: one failing (no key, limit, Meta change) never stops the others, and the per-source outcome is returned.
import crypto from 'node:crypto';
import { generateText, TIERS } from '../../aiGateway/index.js';
import { isAiConfigured } from '../../aiGateway/index.js';
import * as apify from './apify.js';
import * as lensMod from './lens.js';
import { getMediaKey } from './mediaKeys.js';
import { isAllowedVideoUrl } from './ytdlp.js';
import { MediaError } from './mediaJobs.js';
import { resolveJobProduct } from './productImage.js';

export const MAX_DURATION_SEC = 120;
const COVER_BATCH = 10;
const SOURCE_PRIORITY = { MANUAL: 0, LENS: 1, META_ADS: 2 }; // a video the PHOTO search matched beats keyword results
const lensCandidate = (url) => ({ url, directUrl: null, source: 'LENS', author: null, caption: '', views: null, likes: null, durationSec: null, thumbnail: null, adDays: null, adCount: null });

export const candidateId = (url) => crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 12);

/** Pure fallback when the AI can't suggest keywords: the name itself + a few generic modifiers. */
export function fallbackQueries(name) {
  const base = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const words = base.split(' ').filter((w) => w.length > 2).slice(0, 3);
  return { queries: [...new Set([base, `${base} review`, `${base} اعلان`])].filter(Boolean), hashtags: [...new Set(words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean))] };
}

async function suggestKeywords({ name, image, ai }) {
  if (!ai) return fallbackQueries(name);
  try {
    const content = [{ type: 'text', text: `Product name: ${name}. Suggest search keywords to find short ad/UGC videos of this exact product on TikTok and Instagram (Egypt market). JSON only: {"queries":[up to 5 strings: 2 generic English, 2 specific to this model, 1 Egyptian Arabic],"hashtags":[up to 4 single-word hashtags without #]}` }];
    if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.buffer.toString('base64') } });
    const out = await generateText({ feature: 'amb_media_keywords', tier: TIERS.ROUTINE, messages: [{ role: 'user', content }], maxTokens: 400, jsonMode: true });
    const j = JSON.parse(out.text);
    const queries = (j.queries || []).map(String).filter(Boolean).slice(0, 5), hashtags = (j.hashtags || []).map(String).filter(Boolean).slice(0, 4);
    return queries.length ? { queries, hashtags } : fallbackQueries(name);
  } catch { return fallbackQueries(name); }
}

async function coverBytes(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    return buf.length && buf.length < 1_500_000 && /^image\//.test(mime) ? { buffer: buf, mime } : null;
  } catch { return null; }
}

/** Adds matchScore (0-100) / matchNote to candidates whose cover could be compared. Failure of a batch leaves those unscored (never invented). */
export async function scoreCovers({ name, image, candidates, fetchImpl = fetch, ask }) {
  const ranker = ask || (async ({ content }) => JSON.parse((await generateText({ feature: 'amb_media_cover_rank', tier: TIERS.BALANCED, messages: [{ role: 'user', content }], maxTokens: 700, jsonMode: true })).text));
  for (let i = 0; i < candidates.length; i += COVER_BATCH) {
    const batch = candidates.slice(i, i + COVER_BATCH);
    const covers = await Promise.all(batch.map((c) => (c.thumbnail ? coverBytes(c.thumbnail, fetchImpl) : null)));
    const content = [{ type: 'text', text: `The first image is the REAL product "${name}". Then ${covers.filter(Boolean).length} video covers, each preceded by its index. For each cover score 0-100 how likely the same exact product is visible (50 = product not visible, below 30 = other product). JSON only: {"results":[{"index":number,"score":number,"note":"short Arabic note"}]}` },
      { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.buffer.toString('base64') } }];
    covers.forEach((cv, k) => { if (cv) { content.push({ type: 'text', text: `index ${k}` }, { type: 'image', source: { type: 'base64', media_type: cv.mime, data: cv.buffer.toString('base64') } }); } });
    if (content.length <= 2) continue;
    try {
      const j = await ranker({ content });
      for (const r of j.results || []) { const c = batch[Number(r.index)]; if (c && Number.isFinite(Number(r.score))) { c.matchScore = Math.max(0, Math.min(100, Math.round(Number(r.score)))); c.matchNote = String(r.note || '').slice(0, 120); } }
    } catch { /* this batch stays unscored */ }
  }
  return candidates;
}

/** Pure ordering: pasted links first, then running Meta ads (longest/most-duplicated first), then by cover score, then by views. */
export function sortCandidates(list) {
  const adRank = (c) => (c.adDays || 0) + 10 * (c.adCount || 0);
  return [...list].sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.source] ?? 3, pb = SOURCE_PRIORITY[b.source] ?? 3;
    if (pa !== pb) return pa - pb;
    if (a.source === 'META_ADS' && b.source === 'META_ADS') return adRank(b) - adRank(a);
    const sa = a.matchScore ?? -1, sb = b.matchScore ?? -1;
    if (sa !== sb) return sb - sa;
    return (b.views || 0) - (a.views || 0);
  });
}

export async function runVideoFinder({ launchJobId, target = 12, manualUrls = [], country = 'EG', ctx, deps = {} }) {
  const want = Math.max(3, Math.min(30, Number(target) || 12));
  const pc = await (deps.resolveProduct || resolveJobProduct)(launchJobId);
  const ai = deps.ai ?? isAiConfigured();
  const fetchImpl = deps.fetchImpl || fetch;
  const A = deps.apify || apify;

  await ctx.progress(5, 'بجهّز كلمات البحث');
  const { queries, hashtags } = await suggestKeywords({ name: pc.product.name, image: pc.image, ai });

  const sources = []; let pool = [];
  const runSource = async (id, label, fn) => {
    try { const r = await fn(); ctx.cost(`apify:${id}`, r.usd || 0, r.videos.length); pool.push(...r.videos); sources.push({ id, label, ok: true, count: r.videos.length }); }
    catch (e) { sources.push({ id, label, ok: false, count: 0, error: e.message }); }
  };

  // STAGE 1 — search by the product PHOTO (Google Lens). Its page titles also sharpen the keyword search that follows.
  const L = deps.lens || lensMod;
  const serpKey = deps.serpKey !== undefined ? deps.serpKey : await getMediaKey('serpapi');
  let lens = null;
  if (!pc.image) sources.push({ id: 'lens', label: 'بحث بصورة المنتج', ok: false, count: 0, error: 'مفيش صورة للمنتج' });
  else if (!serpKey) sources.push({ id: 'lens', label: 'بحث بصورة المنتج', ok: false, count: 0, error: 'SerpApi مش مربوط' });
  else {
    await ctx.progress(10, 'بدوّر بصورة المنتج (Google Lens)');
    try {
      lens = await L.lensSearch({ key: serpKey, imageUrl: pc.image.url || null, image: pc.image, fetchImpl: deps.serpFetch });
      ctx.cost('serpapi', 0, lens.searches);
      pool.push(...lens.videoUrls.map(lensCandidate));
      sources.push({ id: 'lens', label: 'بحث بصورة المنتج', ok: true, count: lens.videoUrls.length });
    } catch (e) { sources.push({ id: 'lens', label: 'بحث بصورة المنتج', ok: false, count: 0, error: e.message }); }
  }
  const allQueries = [...new Set([...queries, ...(lens?.titles || []).slice(0, 3)])].slice(0, 8);

  await ctx.progress(25, 'بدوّر على تيك توك وريلز ومكتبة إعلانات ميتا');
  await Promise.all([
    ...(lens?.accounts?.length ? [runSource('tiktokAccounts', 'حسابات من بحث الصورة', () => A.tiktokProfiles(lens.accounts, { fetchImpl: deps.apifyFetch }))] : []),
    runSource('tiktok', 'تيك توك', () => A.searchTikTok(allQueries, { country, limit: Math.max(20, want * 2), fetchImpl: deps.apifyFetch })),
    runSource('instagram', 'ريلز انستجرام', () => (hashtags.length ? A.searchInstagramReels(hashtags, { fetchImpl: deps.apifyFetch }) : Promise.resolve({ videos: [], usd: 0 }))),
    runSource('metaAds', 'مكتبة إعلانات ميتا', () => A.searchMetaAdLibrary(allQueries, { country, fetchImpl: deps.apifyFetch })),
  ]);
  const manual = [...new Set(manualUrls.map(String))].filter(isAllowedVideoUrl).map((url) => ({ url, directUrl: null, source: 'MANUAL', author: null, caption: '', views: null, likes: null, durationSec: null, thumbnail: null, adDays: null, adCount: null }));
  pool = [...manual, ...pool];

  if (!pool.length && sources.every((s) => !s.ok)) throw new MediaError(`كل المصادر فشلت: ${sources.map((s) => `${s.label}: ${s.error}`).join(' | ')}`, 'ALL_SOURCES_FAILED');

  const seen = new Set();
  let candidates = pool.filter((c) => { if (seen.has(c.url)) return false; seen.add(c.url); return c.source === 'MANUAL' || !(c.durationSec > MAX_DURATION_SEC); }).map((c) => ({ id: candidateId(c.url), ...c, matchScore: null, matchNote: null }));
  if (!candidates.length) throw new MediaError('ملقيتش فيديوهات مناسبة للمنتج ده. جرّب تلزق لينكات بنفسك.', 'NO_VIDEOS');

  // links that came from the photo search have no data yet: fill cover / title / author from the free public oEmbed (TikTok, YouTube)
  const bare = candidates.filter((c) => c.source === 'LENS' && !c.thumbnail).slice(0, 24);
  for (let i = 0; i < bare.length; i += 4) await Promise.all(bare.slice(i, i + 4).map(async (c) => { const o = await L.oembed(c.url, fetchImpl); if (o) { c.thumbnail = o.thumbnail; c.caption = o.title; c.author = o.author; } }));

  const scoreable = candidates.filter((c) => c.thumbnail).slice(0, Math.max(want * 3, 30));
  if (ai && pc.image && scoreable.length) { await ctx.progress(60, 'بقارن الأغلفة بصورة المنتج'); await scoreCovers({ name: pc.product.name, image: pc.image, candidates: scoreable, fetchImpl, ask: deps.ask }); }

  candidates = sortCandidates(candidates).slice(0, want + 10);
  return { product: pc.product.name, queries: allQueries, hashtags, sources, scored: !!(ai && pc.image), lens: lens ? { searches: lens.searches, accounts: lens.accounts, usedPublicUrl: !!pc.image.url } : null, candidates };
}
