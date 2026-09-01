// productResearchOrchestrator.js — runs the full pipeline for one search:
// analyze -> generate queries -> search each platform (isolated failures,
// Step 19) -> normalize -> dedupe -> save -> batch AI rank -> insights.
// Runs asynchronously after the route returns the search id immediately
// (Step 18) — no new queue infra added, just a fire-and-forget async
// function the route kicks off; GET /search/:id lets the frontend poll
// status, matching "safe asynchronous job pattern... without introducing
// unnecessary infrastructure".
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { analyzeProduct, generateSearchQueries, rankResultsBatch } from './productResearchAI.js';
import { runProviderSearch, isAnyProviderConfigured } from './searchProviders/index.js';
import { normalizeResult, deduplicateResults } from './productResearchNormalize.js';

const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube', 'META_AD_LIBRARY'];

// Step 21 — lightweight in-memory cache (normalized query+platform+country -> results), no new infra.
// Cleared on process restart; that's an acceptable trade-off for a first
// implementation, called out explicitly rather than pretending it's durable.
const searchCache = new Map();
function cacheKey(platform, query, country) {
  return `${platform}::${query.toLowerCase().trim()}::${country}`;
}
function cacheTtlMs() {
  return (Number(process.env.SEARCH_CACHE_TTL) || 3600) * 1000;
}

async function updateSearch(id, data) {
  return prisma.productResearchSearch.update({ where: { id }, data });
}

/** @param {number} searchId */
export async function runSearchPipeline(searchId) {
  const search = await prisma.productResearchSearch.findUnique({ where: { id: searchId } });
  if (!search) {
    logger.error('PRODUCT_RESEARCH_PIPELINE_MISSING_SEARCH', { searchId });
    return;
  }

  const platforms = JSON.parse(search.platforms_json || '[]').filter((p) => PLATFORMS.includes(p));
  const platformStatus = Object.fromEntries(platforms.map((p) => [p, 'PENDING']));

  try {
    await updateSearch(searchId, { status: 'ANALYZING', started_at: new Date(), platform_status_json: JSON.stringify(platformStatus) });

    const input = JSON.parse(search.input_json || '{}');
    const { profile, source: aiSource } = await analyzeProduct({ ...input, productName: search.product_name });
    await updateSearch(searchId, { status: 'GENERATING_QUERIES', ai_profile_json: JSON.stringify({ ...profile, _analysisSource: aiSource }) });

    const queries = generateSearchQueries(profile, platforms);
    if (queries.length === 0) {
      await updateSearch(searchId, { status: 'FAILED', error: 'مقدرش أنشئ أي استعلام بحث — راجع بيانات المنتج المدخلة.', completed_at: new Date() });
      return;
    }

    await prisma.productResearchQuery.createMany({
      data: queries.map((q) => ({ search_id: searchId, platform: q.platform, query: q.query, query_type: q.queryType, provider: 'pending', status: 'PENDING' })),
    });
    const savedQueries = await prisma.productResearchQuery.findMany({ where: { search_id: searchId } });

    await updateSearch(searchId, { status: 'SEARCHING' });

    const providerAnyConfigured = await isAnyProviderConfigured();
    const allNormalized = [];

    for (const platform of platforms) {
      const platformQueries = savedQueries.filter((q) => q.platform === platform);
      let platformHadSuccess = false;
      let platformHadFailure = false;

      for (const q of platformQueries) {
        const key = cacheKey(platform, q.query, search.country);
        const cached = searchCache.get(key);
        const fresh = cached && Date.now() - cached.at < cacheTtlMs();

        try {
          let items, providerName;
          if (fresh) {
            ({ items, providerName } = cached);
          } else {
            const result = await runProviderSearch({ platform, query: q.query, resultsLimit: search.results_per_platform, country: search.country });
            items = result.items;
            providerName = result.providerName;
            searchCache.set(key, { items, providerName, at: Date.now() });
          }

          const normalized = items
            .map((raw) => normalizeResult(raw, { platform, provider: providerName, query: q.query, queryType: q.query_type }))
            .filter(Boolean);
          allNormalized.push(...normalized);

          await prisma.productResearchQuery.update({ where: { id: q.id }, data: { status: 'COMPLETE', provider: providerName, result_count: normalized.length } });
          platformHadSuccess = true;
        } catch (err) {
          logger.error('PRODUCT_RESEARCH_QUERY_FAILED', { searchId, platform, query: q.query, message: err.message });
          await prisma.productResearchQuery.update({ where: { id: q.id }, data: { status: 'FAILED', error: err.message } });
          platformHadFailure = true;
        }
      }

      platformStatus[platform] = platformHadSuccess ? (platformHadFailure ? 'PARTIAL' : 'COMPLETE') : (providerAnyConfigured ? 'FAILED' : 'NOT_CONFIGURED');
      await updateSearch(searchId, { platform_status_json: JSON.stringify(platformStatus) });
    }

    const deduped = deduplicateResults(allNormalized);
    let saved = [];
    if (deduped.length > 0) {
      // createMany with skipDuplicates handles the (search_id, canonical_url) unique constraint safely for a rerun.
      await prisma.productResearchResult.createMany({ data: deduped.map((r) => ({ ...r, search_id: searchId })), skipDuplicates: true });
      saved = await prisma.productResearchResult.findMany({ where: { search_id: searchId } });
    }

    if (saved.length > 0) {
      await updateSearch(searchId, { status: 'RANKING' });
      const forRanking = saved.map((r, i) => ({ ...r, _localId: r.id }));
      const rankings = await rankResultsBatch(profile, forRanking);
      for (const [resultId, ranking] of rankings.entries()) {
        await prisma.productResearchResult.update({
          where: { id: resultId },
          data: { classification: ranking.classification, match_score: ranking.match_score, confidence_score: ranking.confidence_score, ai_reason: ranking.reason },
        });
      }

      // Step 14 — Market Insights, computed from observed data (deterministic) + a short AI interpretation note stored separately and clearly labelled.
      const insights = buildObservedInsights(saved, platformStatus);
      await prisma.productResearchInsight.upsert({
        where: { search_id: searchId },
        create: { search_id: searchId, insights_json: JSON.stringify(insights) },
        update: { insights_json: JSON.stringify(insights), generated_at: new Date() },
      });
    }

    const anyFailed = Object.values(platformStatus).some((s) => s === 'FAILED');
    const anySucceeded = Object.values(platformStatus).some((s) => s === 'COMPLETE' || s === 'PARTIAL');
    const finalStatus = !anySucceeded ? (providerAnyConfigured ? 'FAILED' : 'FAILED') : anyFailed ? 'PARTIAL' : 'COMPLETED';
    await updateSearch(searchId, { status: finalStatus, completed_at: new Date(), error: !anySucceeded && !providerAnyConfigured ? 'مفيش أي Search Provider مربوط — راجع صفحة Provider Status.' : null });
  } catch (err) {
    logger.error('PRODUCT_RESEARCH_PIPELINE_FAILED', { searchId, message: err.message });
    await updateSearch(searchId, { status: 'FAILED', error: err.message, completed_at: new Date() }).catch(() => {});
  }
}

/** Deterministic, from real saved results only — no invented market data (Step 14). */
function buildObservedInsights(results, platformStatus) {
  const nameCount = new Map();
  const platformCount = new Map();
  const typeCount = new Map();
  for (const r of results) {
    if (r.account_name) nameCount.set(r.account_name, (nameCount.get(r.account_name) || 0) + 1);
    platformCount.set(r.platform, (platformCount.get(r.platform) || 0) + 1);
    typeCount.set(r.content_type, (typeCount.get(r.content_type) || 0) + 1);
  }
  const topN = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ name: k, count: v }));

  return {
    observedData: {
      totalResults: results.length,
      byPlatform: Object.fromEntries(platformCount),
      byContentType: Object.fromEntries(typeCount),
      topAccounts: topN(nameCount, 10),
      platformStatus,
    },
    aiInterpretation: null, // reserved for a future pass that asks Claude to narrate the observedData above — not built in this Phase 1, deliberately null rather than faked.
  };
}
