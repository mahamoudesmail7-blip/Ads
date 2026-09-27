// winnerScoring.js — Winner Discovery Engine: real, multi-signal, explainable
// scoring for the clusters winnerProducts.js already builds. Every component
// below is computed from real data already collected by the search
// providers — nothing here calls an external API or invents a metric a
// source can't actually provide.
//
// HONEST DATA-AVAILABILITY NOTE (read before touching weights/thresholds):
// - Real structured views/likes/comments exist ONLY for YouTube (its Data
//   API). Instagram/Facebook/TikTok are served via SerpApi's Google-indexed
//   site: search, which returns title/snippet/thumbnail/URL only — there is
//   no view/like/comment count in that data, full stop. Reach/engagement/
//   velocity are therefore real-but-YouTube-only signals today; every other
//   platform's items contribute to creator-spread/cross-platform/commercial-
//   intent instead, and simply don't count toward reach/engagement.
// - "Commercial intent" here scans each item's own title/snippet text for
//   buying-intent phrases — it is NOT comment analysis. No current provider
//   fetches actual audience comments (SerpApi returns Google's indexed
//   snippet, YouTube's search.list doesn't fetch comment text either), so a
//   title/snippet match is a weaker, indirect proxy and is labeled as such.
// - Every component that has no real data for a given cluster is EXCLUDED
//   from the weighted score (never scored as 0) and the remaining weights
//   are redistributed proportionally — the same principle already used by
//   experimentalCreativeDiscovery.js's computeExactMatchScore(). A
//   `confidence`/`coverage` field discloses how many of the 8 components
//   actually had real data for this cluster.
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import * as localVision from './vision/localVisionProvider.js';
import { computeExactMatchScore, decideMatch, loadExactMatchThresholds } from './experimentalCreativeDiscovery.js';
import { runWithConcurrency } from './ogImageFetch.js';

const LOG_PREFIX = '[WinnerScoring]';

const DEFAULT_WEIGHTS = {
  reach: 15,
  engagement: 15,
  velocity: 10,
  creatorSpread: 15,
  crossPlatform: 15,
  commercialIntent: 10,
  adValidation: 10,
  productMatch: 10,
};

// Real product-match visual verification (see productMatchTier below) goes
// through localVisionProvider's shared, process-wide concurrency-1 queue —
// running it for every cluster in a 90-cluster search would add minutes to
// every job. Bounded to the top-N clusters by preliminary (pre-visual)
// score, matching how experimentalCreativeDiscovery.js already bounds its
// own vision-comparison workload rather than running it unconditionally.
const MAX_VISUAL_VERIFICATIONS_PER_SEARCH = 20;

const COMMERCIAL_INTENT_PHRASES = [
  'السعر', 'بكام', 'ب كام', 'منين', 'فين احصل', 'وين احصل', 'لينك', 'الرابط',
  'عايز اشتري', 'عايزة اشتري', 'عايز احجز', 'اشتري منين',
  'price', 'how much', 'where can i buy', 'where to buy', 'buy link', 'link please', 'need this', 'want this',
];

export async function loadWinnerScoreWeights() {
  const row = await prisma.settings.findUnique({ where: { id: 'default' } }).catch(() => null);
  const saved = row ? JSON.parse(row.data || '{}') : {};
  const configured = saved.winnerScoreWeights && typeof saved.winnerScoreWeights === 'object' ? saved.winnerScoreWeights : {};
  return { ...DEFAULT_WEIGHTS, ...configured };
}

function percentileRank(pool, value) {
  if (value == null || !Number.isFinite(value) || pool.length === 0) return null;
  const below = pool.filter((v) => v < value).length;
  return Math.round((below / pool.length) * 100);
}

/** Real title/snippet keyword scan — see the module header note on what this is NOT (comment analysis). */
function detectCommercialIntent(items) {
  const text = items.map((i) => `${i.title || ''} ${i.snippet || ''}`).join(' \n ').toLowerCase();
  const matchedPhrases = COMMERCIAL_INTENT_PHRASES.filter((p) => text.includes(p.toLowerCase()));
  if (matchedPhrases.length === 0) return { score: null, signal: null, matchedPhrases: [] };
  return { score: Math.min(100, matchedPhrases.length * 25), signal: 'COMMERCIAL_INTENT_SIGNAL', matchedPhrases };
}

/** Real ad presence/persistence/advertiser-count from this cluster's own META_AD_LIBRARY items — never sales/revenue. */
function computeAdValidation(items) {
  const adItems = items.filter((i) => i.platform === 'META_AD_LIBRARY');
  if (adItems.length === 0) return { score: null, signal: null, adsCount: 0, advertisersCount: 0, persistenceDays: null };
  const advertisers = new Set(adItems.filter((i) => i.accountName).map((i) => i.accountName));
  const dates = adItems.map((i) => i.publishedAt).filter(Boolean).map((d) => new Date(d).getTime()).filter((t) => Number.isFinite(t));
  const persistenceDays = dates.length >= 2 ? Math.round((Math.max(...dates) - Math.min(...dates)) / 86400000) : null;
  // Deterministic 0-100: ad count and advertiser count both matter, persistence is a bonus when known.
  const countScore = Math.min(70, adItems.length * 10 + advertisers.size * 15);
  const persistenceBonus = persistenceDays != null ? Math.min(30, Math.round(persistenceDays / 3)) : 0;
  return {
    score: Math.min(100, countScore + persistenceBonus),
    signal: 'AD_VALIDATION',
    adsCount: adItems.length,
    advertisersCount: advertisers.size,
    persistenceDays,
  };
}

function computeCreatorSpread(items) {
  const uniqueCreators = new Set(items.filter((i) => i.accountName).map((i) => `${i.platform}:${i.accountName}`));
  const uniquePosts = new Set(items.filter((i) => i.url).map((i) => i.url));
  const platforms = new Set(items.map((i) => i.platform));
  return { uniqueCreators: uniqueCreators.size, uniquePosts: uniquePosts.size, platformCount: platforms.size };
}

/**
 * Downloads+locally-analyzes real thumbnails already collected for this
 * cluster and checks they're visually consistent with each other (i.e.
 * genuinely one product, not just a same-normalized-title coincidence).
 * Reuses the exact scoring formula computeExactMatchScore()/decideMatch()
 * already use for reference-vs-candidate matching — here applied cluster-
 * internally (first real thumbnail as the reference, every other real
 * thumbnail compared against it, worst-case similarity kept). Returns
 * `{tier: null}` when fewer than 2 real thumbnails exist to compare — never
 * assumes EXACT_MATCH just because nothing contradicts it.
 */
async function computeProductMatchTier(items, thresholds) {
  const thumbs = [...new Set(items.filter((i) => i.thumbnail).map((i) => i.thumbnail))];
  if (thumbs.length < 2) return { tier: null, score: null };

  async function analyze(url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const contentType = (res.headers.get('content-type') || '').split(';')[0];
      if (!contentType.startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 5 * 1024 * 1024) return null;
      return await localVision.analyzeCandidateLocal(buf);
    } catch {
      return null; // a slow/blocked/broken thumbnail never fails the whole cluster's score
    }
  }

  const reference = await analyze(thumbs[0]);
  if (!reference) return { tier: null, score: null };

  let worstEmb = null;
  let worstHash = null;
  for (const url of thumbs.slice(1)) {
    const candidate = await analyze(url);
    if (!candidate) continue;
    const embSim = localVision.embeddingSimilarity(reference.embedding, candidate.embedding);
    const hashSim = localVision.perceptualHashSimilarity(reference.perceptualHash, candidate.perceptualHash);
    if (embSim !== null) worstEmb = worstEmb === null ? embSim : Math.min(worstEmb, embSim);
    if (hashSim !== null) worstHash = worstHash === null ? hashSim : Math.min(worstHash, hashSim);
  }
  if (worstEmb === null && worstHash === null) return { tier: null, score: null };

  const score = computeExactMatchScore({ embSim: worstEmb, hashSim: worstHash, brandBonus: 0, hasBrandOrModel: false, textMatchScore: null, colorMatch: null });
  const decision = decideMatch(score, thresholds); // 'EXACT' | 'REVIEW' | 'REJECT' | null
  const tier = decision === 'EXACT' ? 'EXACT_MATCH' : decision === 'REVIEW' ? 'CLOSE_VARIANT' : decision === 'REJECT' ? 'SIMILAR_CATEGORY' : null;
  return { tier, score };
}

function weightedScore(components, weights) {
  const active = Object.entries(components).filter(([, v]) => v != null && Number.isFinite(v));
  if (active.length === 0) return { score: null, coverage: 0 };
  const totalWeight = active.reduce((s, [k]) => s + (weights[k] || 0), 0);
  if (totalWeight === 0) return { score: null, coverage: 0 };
  const weighted = active.reduce((s, [k, v]) => s + (weights[k] || 0) * v, 0);
  return { score: Math.max(0, Math.min(100, Math.round(weighted / totalWeight))), coverage: Math.round((active.length / Object.keys(DEFAULT_WEIGHTS).length) * 100) };
}

/**
 * 5-state classification (spec: never PROVEN WINNER from one weak signal).
 * Requires both a high score AND real breadth of evidence (creators +
 * platforms) before the top tier — a single viral post with score=90 but
 * creatorSpread.uniqueCreators===1 and platformCount===1 cannot reach it.
 */
function classifyWinnerState(score, coverage, creatorSpread) {
  if (score == null || coverage < 25) return { state: 'INSUFFICIENT_EVIDENCE', label: '❔ بيانات غير كافية' };
  const strongBreadth = creatorSpread.uniqueCreators >= 3 && creatorSpread.platformCount >= 2;
  if (score >= 80 && strongBreadth) return { state: 'PROVEN_WINNER', label: '🔥 منتج فائز مؤكد' };
  if (score >= 65) return { state: 'STRONG_SIGNAL', label: '🚀 إشارة قوية' };
  if (score >= 45) return { state: 'RISING', label: '⚡ صاعد' };
  if (score >= 25) return { state: 'WATCH', label: '👀 تحت المراقبة' };
  return { state: 'INSUFFICIENT_EVIDENCE', label: '❔ بيانات غير كافية' };
}

/**
 * Scores every cluster in a search in one pass. `clusters` is an array of
 * `{key, displayName, items}` (items = the same raw per-platform item
 * objects winnerProducts.js already collected, pre-truncation). Returns a
 * `Map<key, {winnerScore, confidence, trendStage, breakdown}>`.
 * @param {{key:string, displayName:string, items:object[]}[]} clusters
 */
export async function scoreClusters(clusters) {
  const results = new Map();
  if (clusters.length === 0) return results;

  const weights = await loadWinnerScoreWeights();
  const thresholds = await loadExactMatchThresholds();

  // Batch-relative percentile pools (only real numbers, per platform where it matters).
  const youtubeViewsPool = [];
  const youtubeEngagementPool = [];
  const velocityPool = [];
  const perCluster = clusters.map((c) => {
    const ytItems = c.items.filter((i) => i.platform === 'youtube' && i.viewCount != null);
    const totalViews = ytItems.length ? ytItems.reduce((s, i) => s + i.viewCount, 0) : null;
    const totalEngagement = ytItems.length ? ytItems.reduce((s, i) => s + (i.likeCount || 0) + (i.commentCount || 0), 0) : null;
    const engagementRate = totalViews && totalEngagement != null ? (totalEngagement / totalViews) * 100 : null;
    const velocities = ytItems
      .filter((i) => i.publishedAt)
      .map((i) => {
        const days = Math.max(1, (Date.now() - new Date(i.publishedAt).getTime()) / 86400000);
        return i.viewCount / days;
      });
    const avgVelocity = velocities.length ? velocities.reduce((s, v) => s + v, 0) / velocities.length : null;

    if (totalViews != null) youtubeViewsPool.push(totalViews);
    if (engagementRate != null) youtubeEngagementPool.push(engagementRate);
    if (avgVelocity != null) velocityPool.push(avgVelocity);

    return { ...c, totalViews, engagementRate, avgVelocity, creatorSpread: computeCreatorSpread(c.items), adValidation: computeAdValidation(c.items), commercialIntent: detectCommercialIntent(c.items) };
  });

  // Preliminary score (no product-match yet) decides which clusters are worth the expensive visual-consistency check.
  // Component keys here must match DEFAULT_WEIGHTS' keys exactly — weightedScore() looks weight up by key name.
  const preliminary = perCluster.map((c) => {
    const reach = percentileRank(youtubeViewsPool, c.totalViews);
    const engagement = percentileRank(youtubeEngagementPool, c.engagementRate);
    const velocity = percentileRank(velocityPool, c.avgVelocity);
    const crossPlatform = c.creatorSpread.platformCount >= 3 ? 100 : c.creatorSpread.platformCount === 2 ? 60 : c.creatorSpread.platformCount === 1 ? 20 : null;
    const creatorSpread = c.creatorSpread.uniqueCreators >= 5 ? 100 : c.creatorSpread.uniqueCreators >= 3 ? 70 : c.creatorSpread.uniqueCreators >= 2 ? 40 : c.creatorSpread.uniqueCreators === 1 ? 15 : null;
    const components = { reach, engagement, velocity, creatorSpread, crossPlatform, commercialIntent: c.commercialIntent.score, adValidation: c.adValidation.score };
    const { score: prelimScore } = weightedScore({ ...components, productMatch: null }, weights);
    return { ...c, components, prelimScore: prelimScore ?? 0 };
  });

  const toVerify = [...preliminary].sort((a, b) => b.prelimScore - a.prelimScore).slice(0, MAX_VISUAL_VERIFICATIONS_PER_SEARCH);
  const verifySet = new Set(toVerify.map((c) => c.key));
  const productMatchByKey = new Map();
  await runWithConcurrency(toVerify, 1, async (c) => {
    try {
      productMatchByKey.set(c.key, await computeProductMatchTier(c.items, thresholds));
    } catch (err) {
      logger.warn(`${LOG_PREFIX} PRODUCT_MATCH_FAILED`, { key: c.key, message: err.message });
      productMatchByKey.set(c.key, { tier: null, score: null });
    }
  });

  for (const c of preliminary) {
    const productMatch = verifySet.has(c.key) ? (productMatchByKey.get(c.key) || { tier: null, score: null }) : { tier: null, score: null };
    const productMatchScore = productMatch.tier === 'EXACT_MATCH' ? 100 : productMatch.tier === 'CLOSE_VARIANT' ? 55 : productMatch.tier === 'SIMILAR_CATEGORY' ? 15 : null;

    const { score, coverage } = weightedScore({ ...c.components, productMatch: productMatchScore }, weights);
    const { state, label } = classifyWinnerState(score, coverage, c.creatorSpread);

    const evidenceBullets = [];
    if (c.creatorSpread.uniqueCreators > 1) evidenceBullets.push(`ظهر عند ${c.creatorSpread.uniqueCreators} صنّاع محتوى مختلفين، مش حساب واحد بس`);
    if (c.creatorSpread.platformCount > 1) evidenceBullets.push(`موجود على ${c.creatorSpread.platformCount} منصات مختلفة في نفس الوقت`);
    if (c.totalViews != null) evidenceBullets.push(`إجمالي مشاهدات حقيقية على يوتيوب: ${c.totalViews.toLocaleString('en-US')}`);
    if (c.adValidation.adsCount > 0) evidenceBullets.push(`عليه ${c.adValidation.adsCount} إعلان حقيقي من ${c.adValidation.advertisersCount} معلن مختلف`);
    if (c.commercialIntent.signal) evidenceBullets.push(`فيه إشارات اهتمام شرائي في النصوص المكتشفة`);
    if (productMatch.tier === 'EXACT_MATCH') evidenceBullets.push('الصور بتأكد إنه نفس المنتج فعليًا في كل المصادر');

    results.set(c.key, {
      winnerScore: score,
      confidence: coverage,
      trendStage: state,
      breakdown: {
        weights,
        components: { ...c.components, productMatch: productMatchScore },
        evidence: {
          totalViews: c.totalViews, engagementRatePct: c.engagementRate != null ? Math.round(c.engagementRate * 10) / 10 : null, viewsPerDay: c.avgVelocity != null ? Math.round(c.avgVelocity) : null,
          uniqueCreators: c.creatorSpread.uniqueCreators, uniquePosts: c.creatorSpread.uniquePosts, platformCount: c.creatorSpread.platformCount,
          adValidation: { adsCount: c.adValidation.adsCount, advertisersCount: c.adValidation.advertisersCount, persistenceDays: c.adValidation.persistenceDays },
          commercialIntent: { signal: c.commercialIntent.signal, matchedPhrases: c.commercialIntent.matchedPhrases },
          productMatch: { tier: productMatch.tier, verified: verifySet.has(c.key) },
        },
        stateLabel: label,
        evidenceBullets: evidenceBullets.slice(0, 5),
      },
    });
  }

  return results;
}
