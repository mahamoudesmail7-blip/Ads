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
import * as apifyProvider from './searchProviders/apifyMetaAdLibraryProvider.js';
import { runStagedSearch } from './searchProviders/metaAdLibraryProvider.js';

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
  const input = JSON.parse(search.input_json || '{}');

  // If Apify is configured, META_AD_LIBRARY is handled entirely by the
  // staged-discovery path below (its own batched, tiered queries) instead
  // of the generic one-query-per-name-variant loop every other platform
  // uses — so it's excluded from the generic query set here. If Apify
  // ISN'T configured, it stays in the generic set and falls back to the
  // existing Meta Graph API / SerpApi cascade exactly as before.
  const apifyHandlesAdLibrary = platforms.includes('META_AD_LIBRARY') && apifyProvider.isConfigured();
  const genericPlatforms = apifyHandlesAdLibrary ? platforms.filter((p) => p !== 'META_AD_LIBRARY') : platforms;

  try {
    await updateSearch(searchId, { status: 'ANALYZING', started_at: new Date(), platform_status_json: JSON.stringify(platformStatus) });

    const { profile, source: aiSource } = await analyzeProduct({ ...input, productName: search.product_name });
    await updateSearch(searchId, { status: 'GENERATING_QUERIES', ai_profile_json: JSON.stringify({ ...profile, _analysisSource: aiSource }) });

    const queries = generateSearchQueries(profile, genericPlatforms);
    if (queries.length === 0 && !apifyHandlesAdLibrary) {
      await updateSearch(searchId, { status: 'FAILED', error: 'مقدرش أنشئ أي استعلام بحث — راجع بيانات المنتج المدخلة.', completed_at: new Date() });
      return;
    }

    await prisma.productResearchQuery.createMany({
      data: queries.map((q) => ({ search_id: searchId, platform: q.platform, query: q.query, query_type: q.queryType, provider: 'pending', status: 'PENDING' })),
    });
    const savedQueries = await prisma.productResearchQuery.findMany({ where: { search_id: searchId } });

    await updateSearch(searchId, { status: 'SEARCHING' });

    const providerAnyConfigured = (await isAnyProviderConfigured()) || apifyHandlesAdLibrary;
    const allNormalized = [];

    for (const platform of genericPlatforms) {
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

    // Meta Ads Library via Apify — staged discovery (Steps 2/3/5), isolated
    // from every other platform's loop above exactly like Step 19 requires:
    // an Apify failure here never touches Instagram/Facebook/TikTok/YouTube,
    // which have already run by this point regardless of what happens next.
    if (apifyHandlesAdLibrary) {
      const mode = input.adLibraryMode === 'deep' ? 'deep' : 'quick';
      const rawLimit = [100, 250, 500, 1000, 2000].includes(Number(input.adLibraryRawLimit)) ? Number(input.adLibraryRawLimit) : 100;
      const activeOnly = Boolean(input.adLibraryActiveOnly);

      try {
        const staged = await runStagedSearch({ profile, country: search.country, activeOnly, mode, rawLimit });
        let platformHadSuccess = false;
        let platformHadFailure = false;

        for (const tierResult of staged.tiers) {
          await prisma.productResearchQuery.create({
            data: {
              search_id: searchId,
              platform: 'META_AD_LIBRARY',
              query: tierResult.queries.join('، '),
              query_type: tierResult.tier,
              provider: tierResult.provider,
              status: tierResult.error ? 'FAILED' : 'COMPLETE',
              result_count: tierResult.rawCount,
              error: tierResult.error,
            },
          });
          if (tierResult.error) platformHadFailure = true;
          else platformHadSuccess = true;
        }

        for (const raw of staged.allRawItems) {
          const normalized = normalizeResult(raw, { platform: 'META_AD_LIBRARY', provider: 'apify_meta_ad_library', query: raw._sourceQueries?.join('، ') || '', queryType: 'APIFY_STAGED' });
          if (normalized) allNormalized.push(normalized);
        }

        platformStatus.META_AD_LIBRARY = platformHadSuccess ? (platformHadFailure ? 'PARTIAL' : 'COMPLETE') : 'FAILED';
      } catch (err) {
        logger.error('APIFY_META_AD_LIBRARY_STAGED_SEARCH_FAILED', { searchId, message: err.message });
        await prisma.productResearchQuery.create({
          data: { search_id: searchId, platform: 'META_AD_LIBRARY', query: '(staged discovery)', query_type: 'APIFY_STAGED', provider: 'apify_meta_ad_library', status: 'FAILED', error: err.message },
        });
        platformStatus.META_AD_LIBRARY = 'FAILED';
      }
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
      // rankResultsBatch only ranks the first MAX_AI_RANKING_RESULTS results
      // (cost control, Step 21 — never call Claude on thousands of results
      // one-by-one or in one giant batch). Anything past that cap must still
      // get an explicit UNCLASSIFIED marker instead of staying NULL forever
      // — a real result the AI simply hasn't reached yet is not the same as
      // a result that was actually judged RELATED, and leaving it NULL is
      // exactly the state that used to make real results silently
      // disappear from the results list (see /results route's fix).
      const unrankedIds = saved.filter((r) => !rankings.has(r.id)).map((r) => r.id);
      if (unrankedIds.length > 0) {
        await prisma.productResearchResult.updateMany({
          where: { id: { in: unrankedIds } },
          data: { classification: 'UNCLASSIFIED', ai_reason: 'التحليل الذكي لسه ما وصلش للنتيجة دي (تجاوزت حد الدفعة) — النتيجة حقيقية ومعروضة زي ما هي.' },
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
