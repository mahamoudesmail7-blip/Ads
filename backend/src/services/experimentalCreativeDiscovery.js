// experimentalCreativeDiscovery.js — "Internal Creative Discovery Platform",
// EXPERIMENTAL, fully isolated from the real Product Research pipeline
// (productResearchOrchestrator.js). Writes only to Experimental* tables,
// never touches ProductResearchSearch/Query/Result. Reuses the exact same
// analysis/query-generation/provider/normalize/ranking functions the real
// pipeline uses — imported, never copy-pasted or modified — so a bug fixed
// here can never diverge from the real pipeline's behavior, and nothing in
// this file can change what those shared functions do for the real
// pipeline's own callers.
//
// HONESTY NOTE (read before assuming "Internal Search"/"Internal Actor" are
// real, separate scraping engines): they are not. No custom Instagram/
// Facebook/TikTok scraper and no custom Meta Ads Library actor exist in
// this codebase or anywhere in this project's history — building one for
// real is a large, separate engineering + legal-compliance effort (ToS,
// anti-bot, proxy infrastructure) far outside a single task, and this
// session's whole discipline is never to fake a working system. This
// module instead wires the experimental section to the SAME real,
// currently-working providers the main pipeline already uses (SerpApi for
// Instagram/Facebook/TikTok, the real YouTube Data API, Apify for Meta Ads
// Library) and reports the REAL provider name honestly in every UI label —
// never rebranded as "Internal Search"/"Internal Actor". See the delivery
// report for the full explanation.
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { analyzeProduct, generateSearchQueries, rankResultsBatch } from './productResearchAI.js';
import { runProviderSearch, isAnyProviderConfigured } from './searchProviders/index.js';
import { normalizeResult, deduplicateResults } from './productResearchNormalize.js';
import * as apifyProvider from './searchProviders/apifyMetaAdLibraryProvider.js';
import { runStagedSearch } from './searchProviders/metaAdLibraryProvider.js';

const LOG_PREFIX = '[InternalCreativeDiscovery]';
const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube', 'META_AD_LIBRARY'];

// In-memory cancellation flags — session-lifetime only, same "no new infra"
// convention as every other in-memory cache in this codebase
// (productResearchOrchestrator's searchCache, apifyMetaAdLibraryProvider's
// statusCache). A cancel request sets this; the loop below checks it
// between steps and stops promptly rather than instantly (an in-flight
// provider HTTP call is allowed to finish rather than aborted mid-request).
const cancelFlags = new Set();

export function requestCancel(searchId) {
  cancelFlags.add(searchId);
}

function isCancelled(searchId) {
  return cancelFlags.has(searchId);
}

async function updateSearch(id, data) {
  return prisma.experimentalCreativeSearch.update({ where: { id }, data });
}

/** @param {number} searchId */
export async function runExperimentalSearchPipeline(searchId) {
  const startedAtMs = Date.now();
  const search = await prisma.experimentalCreativeSearch.findUnique({ where: { id: searchId } });
  if (!search) {
    logger.error(`${LOG_PREFIX} MISSING_SEARCH`, { searchId });
    return;
  }

  const platforms = JSON.parse(search.platforms_json || '[]').filter((p) => PLATFORMS.includes(p));
  const platformStatus = Object.fromEntries(platforms.map((p) => [p, 'PENDING']));
  const input = JSON.parse(search.input_json || '{}');

  const apifyHandlesAdLibrary = platforms.includes('META_AD_LIBRARY') && apifyProvider.isConfigured();
  const genericPlatforms = apifyHandlesAdLibrary ? platforms.filter((p) => p !== 'META_AD_LIBRARY') : platforms;

  try {
    await updateSearch(searchId, { status: 'ANALYZING', started_at: new Date(), platform_status_json: JSON.stringify(platformStatus) });

    const { profile, source: aiSource } = await analyzeProduct({ ...input, productName: search.product_name });
    await updateSearch(searchId, { status: 'GENERATING_QUERIES', ai_profile_json: JSON.stringify({ ...profile, _analysisSource: aiSource }) });

    if (isCancelled(searchId)) return finalizeCancelled(searchId);

    const queries = generateSearchQueries(profile, genericPlatforms);
    if (queries.length === 0 && !apifyHandlesAdLibrary) {
      await updateSearch(searchId, { status: 'FAILED', error: 'مقدرش أنشئ أي استعلام بحث — راجع بيانات المنتج المدخلة.', completed_at: new Date() });
      return;
    }

    await prisma.experimentalCreativeQuery.createMany({
      data: queries.map((q) => ({ search_id: searchId, platform: q.platform, query: q.query, query_type: q.queryType, provider: 'pending', status: 'PENDING' })),
    });
    const savedQueries = await prisma.experimentalCreativeQuery.findMany({ where: { search_id: searchId } });

    await updateSearch(searchId, { status: 'SEARCHING' });
    const providerAnyConfigured = (await isAnyProviderConfigured()) || apifyHandlesAdLibrary;
    const allNormalized = [];

    for (const platform of genericPlatforms) {
      if (isCancelled(searchId)) return finalizeCancelled(searchId);

      const platformQueries = savedQueries.filter((q) => q.platform === platform);
      let platformHadSuccess = false;
      let platformHadFailure = false;
      const platformStartedAt = Date.now();

      for (const q of platformQueries) {
        try {
          const result = await runProviderSearch({ platform, query: q.query, resultsLimit: 25, country: search.country });
          const normalized = result.items
            .map((raw) => normalizeResult(raw, { platform, provider: result.providerName, query: q.query, queryType: q.query_type }))
            .filter(Boolean);
          allNormalized.push(...normalized);
          await prisma.experimentalCreativeQuery.update({ where: { id: q.id }, data: { status: 'COMPLETE', provider: result.providerName, result_count: normalized.length } });
          platformHadSuccess = true;
        } catch (err) {
          logger.error(`${LOG_PREFIX} QUERY_FAILED`, { searchId, platform, provider: q.provider, query: q.query, queriesExecuted: platformQueries.indexOf(q) + 1, errorType: err.name || 'Error' });
          await prisma.experimentalCreativeQuery.update({ where: { id: q.id }, data: { status: 'FAILED', error: err.message } });
          platformHadFailure = true;
        }
      }

      platformStatus[platform] = platformHadSuccess ? (platformHadFailure ? 'PARTIAL' : 'COMPLETE') : (providerAnyConfigured ? 'FAILED' : 'NOT_CONFIGURED');
      await updateSearch(searchId, { platform_status_json: JSON.stringify(platformStatus) });
      logger.info(`${LOG_PREFIX} PLATFORM_DONE`, { searchId, platform, status: platformStatus[platform], queriesExecuted: platformQueries.length, resultsCollected: allNormalized.filter((r) => r.platform === platform).length, durationMs: Date.now() - platformStartedAt });
    }

    if (apifyHandlesAdLibrary && !isCancelled(searchId)) {
      const mode = search.mode === 'deep' ? 'deep' : 'quick';
      const rawLimit = [100, 250, 500, 1000, 2000].includes(Number(input.adLibraryRawLimit)) ? Number(input.adLibraryRawLimit) : 100;
      const activeOnly = Boolean(input.adLibraryActiveOnly);
      const adStartedAt = Date.now();

      try {
        const staged = await runStagedSearch({ profile, country: search.country, activeOnly, mode, rawLimit });
        let platformHadSuccess = false;
        let platformHadFailure = false;

        for (const tierResult of staged.tiers) {
          await prisma.experimentalCreativeQuery.create({
            data: { search_id: searchId, platform: 'META_AD_LIBRARY', query: tierResult.queries.join('، '), query_type: tierResult.tier, provider: tierResult.provider, status: tierResult.error ? 'FAILED' : 'COMPLETE', result_count: tierResult.rawCount, error: tierResult.error },
          });
          if (tierResult.error) platformHadFailure = true; else platformHadSuccess = true;
        }

        for (const raw of staged.allRawItems) {
          const normalized = normalizeResult(raw, { platform: 'META_AD_LIBRARY', provider: 'apify_meta_ad_library', query: raw._sourceQueries?.join('، ') || '', queryType: 'APIFY_STAGED' });
          if (normalized) allNormalized.push(normalized);
        }

        platformStatus.META_AD_LIBRARY = platformHadSuccess ? (platformHadFailure ? 'PARTIAL' : 'COMPLETE') : 'FAILED';
        logger.info(`${LOG_PREFIX} PLATFORM_DONE`, { searchId, platform: 'META_AD_LIBRARY', provider: 'apify_meta_ad_library', status: platformStatus.META_AD_LIBRARY, queriesExecuted: staged.tiers.length, resultsCollected: staged.allRawItems.length, durationMs: Date.now() - adStartedAt });
      } catch (err) {
        logger.error(`${LOG_PREFIX} META_AD_LIBRARY_FAILED`, { searchId, errorType: err.name || 'Error', message: err.message });
        await prisma.experimentalCreativeQuery.create({ data: { search_id: searchId, platform: 'META_AD_LIBRARY', query: '(staged discovery)', query_type: 'APIFY_STAGED', provider: 'apify_meta_ad_library', status: 'FAILED', error: err.message } });
        platformStatus.META_AD_LIBRARY = 'FAILED';
      }
      await updateSearch(searchId, { platform_status_json: JSON.stringify(platformStatus) });
    }

    if (isCancelled(searchId)) return finalizeCancelled(searchId);

    const deduped = deduplicateResults(allNormalized);
    let saved = [];
    if (deduped.length > 0) {
      await prisma.experimentalCreativeResult.createMany({ data: deduped.map((r) => ({ ...r, search_id: searchId })), skipDuplicates: true });
      saved = await prisma.experimentalCreativeResult.findMany({ where: { search_id: searchId } });
    }

    if (saved.length > 0) {
      await updateSearch(searchId, { status: 'RANKING' });
      const forRanking = saved.map((r) => ({ ...r, _localId: r.id }));
      const rankings = await rankResultsBatch(profile, forRanking);
      for (const [resultId, ranking] of rankings.entries()) {
        await prisma.experimentalCreativeResult.update({ where: { id: resultId }, data: { classification: ranking.classification, match_score: ranking.match_score, confidence_score: ranking.confidence_score, ai_reason: ranking.reason } });
      }
      const rankedIds = new Set(rankings.keys());
      const unrankedIds = saved.filter((r) => !rankedIds.has(r.id)).map((r) => r.id);
      if (unrankedIds.length > 0) {
        await prisma.experimentalCreativeResult.updateMany({ where: { id: { in: unrankedIds } }, data: { classification: 'UNCLASSIFIED', ai_reason: 'التحليل الذكي لسه ما وصلش للنتيجة دي (تجاوزت حد الدفعة) — النتيجة حقيقية ومعروضة زي ما هي.' } });
      }
    }

    // Re-checked one last time: a cancel request that arrived while the
    // ranking/save block above was running (the loop only checks between
    // coarse stages, not mid-stage) must never be silently overwritten by
    // this final status write -- CANCELLED, once set by the /cancel route,
    // has to stick.
    if (isCancelled(searchId)) return finalizeCancelled(searchId);

    const anyFailed = Object.values(platformStatus).some((s) => s === 'FAILED');
    const anySucceeded = Object.values(platformStatus).some((s) => s === 'COMPLETE' || s === 'PARTIAL');
    const finalStatus = !anySucceeded ? 'FAILED' : anyFailed ? 'PARTIAL' : 'COMPLETED';
    await updateSearch(searchId, { status: finalStatus, completed_at: new Date(), error: !anySucceeded && !providerAnyConfigured ? 'مفيش أي Search Provider مربوط — راجع صفحة Provider Status.' : null });
    logger.info(`${LOG_PREFIX} SEARCH_DONE`, { searchId, status: finalStatus, resultsCollected: allNormalized.length, uniqueResults: deduped.length, durationMs: Date.now() - startedAtMs });
  } catch (err) {
    logger.error(`${LOG_PREFIX} PIPELINE_FAILED`, { searchId, errorType: err.name || 'Error', message: err.message });
    await updateSearch(searchId, { status: 'FAILED', error: err.message, completed_at: new Date() }).catch(() => {});
  } finally {
    cancelFlags.delete(searchId);
  }
}

async function finalizeCancelled(searchId) {
  logger.info(`${LOG_PREFIX} SEARCH_CANCELLED`, { searchId });
  await prisma.experimentalCreativeSearch.update({ where: { id: searchId }, data: { status: 'CANCELLED', completed_at: new Date() } }).catch(() => {});
  cancelFlags.delete(searchId);
}
