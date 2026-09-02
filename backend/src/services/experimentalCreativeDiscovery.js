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
// this codebase or anywhere in this project's history. This module wires
// the experimental section to the SAME real, currently-working providers
// the main pipeline already uses and reports the REAL provider name
// honestly in every UI label.
//
// IMAGE-ONLY WORKFLOW (new): when the search was submitted with an
// uploaded image and no typed product name, Stage A (productIdentityVision
// .analyzeProductImage) generates a full Product Identity Profile from the
// image BEFORE any query generation happens — text typing is never
// required. "google" is a new platform, handled directly here (bypassing
// the shared runProviderSearch/normalizeResult, which are never modified —
// see the inline notes at each Google-specific call site for why) and used
// both as its own result feed and for a bounded, append-only Stage B
// enrichment pass. A final visual-verification pass (real Claude-vision
// side-by-side comparisons, capped for cost) re-ranks the top text-matched
// candidates so the same physical product surfaces first — see
// productIdentityVision.compareVisualMatch.
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { analyzeProduct, generateSearchQueries, rankResultsBatch } from './productResearchAI.js';
import { runProviderSearch, isAnyProviderConfigured } from './searchProviders/index.js';
import { normalizeResult, deduplicateResults } from './productResearchNormalize.js';
import * as apifyProvider from './searchProviders/apifyMetaAdLibraryProvider.js';
import { runStagedSearch } from './searchProviders/metaAdLibraryProvider.js';
import * as googleSearchProvider from './searchProviders/googleSearchProvider.js';
import { identityToSearchProfile } from './productIdentityVision.js';
import { analyzeProductImage, compareVisualMatch } from './vision/productVisionService.js';

const LOG_PREFIX = '[InternalCreativeDiscovery]';
const GENERIC_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube']; // META_AD_LIBRARY handled separately (Apify staged); 'google' handled separately (own normalizer, see below)
const ALL_PLATFORMS = [...GENERIC_PLATFORMS, 'youtube', 'META_AD_LIBRARY', 'google'];
const MAX_VISUAL_COMPARISONS = 12; // real cost cap on Claude-vision side-by-side comparisons per search — never unbounded

const cancelFlags = new Set();
export function requestCancel(searchId) { cancelFlags.add(searchId); }
function isCancelled(searchId) { return cancelFlags.has(searchId); }

async function updateSearch(id, data) {
  return prisma.experimentalCreativeSearch.update({ where: { id }, data });
}

// Google results never go through productResearchNormalize.js's
// normalizeResult()/validateAndCanonicalize() — that file is shared with
// the real Product Research pipeline and this task's constraint is to
// never modify it, but its ALLOWED_DOMAINS whitelist has no 'google' entry
// (general web results, not one fixed domain) and adding one would be a
// real behavior change to a shared file for a platform the real pipeline
// never uses. This is a small, local, experimental-only equivalent
// instead — same output shape, same honesty rules (missing fields stay
// null, never guessed).
function normalizeGoogleResult(raw, query) {
  let url;
  try { url = new URL(raw.url); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.hash = '';
  return {
    platform: 'google',
    content_type: 'Page',
    canonical_url: url.toString(),
    original_url: raw.url,
    title: raw.title || null,
    snippet: raw.snippet || null,
    account_name: null,
    account_url: null,
    thumbnail: raw.thumbnail || null,
    published_at: null,
    metrics_json: null,
    provider: 'google_custom_search',
    raw_metadata_json: JSON.stringify(raw.raw || {}).slice(0, 20000),
    discovered_by_queries_json: JSON.stringify([{ query, queryType: 'GOOGLE_ENRICHMENT' }]),
  };
}

/**
 * Stage B (Step 16) — bounded, deterministic, append-only enrichment from
 * real Google results. Never touches mainProductName/brand/model/
 * visualFingerprint (Step 17/19: "IMAGE WINS" — the image-derived core
 * identity is never overwritten by text evidence). Only appends a new
 * alias to alternative_names, and only when at least 2 independent Google
 * results agree on the same phrase that isn't already known — "multiple
 * reliable signals agree", never a single weak result. No extra Claude
 * call: a plain, explainable text-overlap heuristic, kept simple and
 * auditable on purpose.
 */
function enrichProfileFromGoogleResults(profile, googleItems) {
  const known = new Set([profile.main_product_name, ...profile.alternative_names, ...profile.possible_names_ar, ...profile.possible_names_en].map((s) => (s || '').toLowerCase()));
  const phraseCounts = new Map(); // phrase -> Set of distinct result urls that mentioned it
  for (const item of googleItems) {
    const text = `${item.title || ''} ${item.snippet || ''}`;
    // 2-5 word capitalized-ish phrases (works reasonably for both English
    // product/brand names and Arabic phrases since Arabic has no case) —
    // deliberately simple, never claims to be a real NLP extractor.
    const candidates = text.match(/[A-Za-z؀-ۿ][A-Za-z0-9؀-ۿ\-]*(?:\s+[A-Za-z0-9؀-ۿ\-]+){0,3}/g) || [];
    for (const c of candidates) {
      const norm = c.trim();
      if (norm.length < 4 || norm.length > 60) continue;
      const key = norm.toLowerCase();
      if (known.has(key)) continue;
      if (!phraseCounts.has(key)) phraseCounts.set(key, { display: norm, urls: new Set() });
      phraseCounts.get(key).urls.add(item.url);
    }
  }
  const agreed = [...phraseCounts.values()].filter((v) => v.urls.size >= 2).map((v) => v.display);
  if (agreed.length > 0) {
    profile.alternative_names = [...new Set([...profile.alternative_names, ...agreed.slice(0, 8)])]; // capped — this is a discovery aid, not a full alias dump
    logger.info(`${LOG_PREFIX} STAGE_B_ENRICHED`, { addedAliases: agreed.slice(0, 8) });
  }
  return profile;
}

/** Simple, deterministic, explainable 0-100 score: how many of the reference image's distinctive features are echoed in a result's own text. Never an AI call — the 5% "distinctive attributes" weight is meant to be a cheap, transparent signal, not a second vision pass. */
function distinctiveAttributeScore(identity, result) {
  const features = [...(identity?.distinctiveFeatures || []), ...(identity?.visualFingerprint?.distinctivePhysicalFeatures || [])];
  if (features.length === 0) return null;
  const text = `${result.title || ''} ${result.snippet || ''}`.toLowerCase();
  const hits = features.filter((f) => f && text.includes(String(f).toLowerCase().slice(0, 15))).length;
  return Math.round((hits / features.length) * 100);
}

/** @param {number} searchId */
export async function runExperimentalSearchPipeline(searchId) {
  const startedAtMs = Date.now();
  const search = await prisma.experimentalCreativeSearch.findUnique({ where: { id: searchId } });
  if (!search) { logger.error(`${LOG_PREFIX} MISSING_SEARCH`, { searchId }); return; }

  const platforms = JSON.parse(search.platforms_json || '[]').filter((p) => ALL_PLATFORMS.includes(p));
  const platformStatus = Object.fromEntries(platforms.map((p) => [p, 'PENDING']));
  const input = JSON.parse(search.input_json || '{}');
  const hasImage = Boolean(input.imageBase64);

  const apifyHandlesAdLibrary = platforms.includes('META_AD_LIBRARY') && apifyProvider.isConfigured();
  const usesGoogle = platforms.includes('google') && googleSearchProvider.isConfigured();
  const genericPlatforms = platforms.filter((p) => GENERIC_PLATFORMS.includes(p));

  try {
    await updateSearch(searchId, { status: 'ANALYZING', started_at: new Date(), platform_status_json: JSON.stringify(platformStatus) });

    let profile, aiSource, identity = null, referenceEmbedding = null, referencePerceptualHash = null;
    if (hasImage) {
      // Stage A — image is the primary identity signal (Step 17), always
      // run when an image exists, regardless of whether the user also
      // typed something (typed text becomes a manual override merged on
      // top, never dropped — identityToSearchProfile's manualOverrides).
      // Goes through the LOCAL_VISION-first provider abstraction
      // (productVisionService.js) — this orchestrator never knows or
      // cares whether LOCAL_VISION alone or LOCAL_VISION+ANTHROPIC
      // actually produced the profile (Step 1).
      const { profile: generatedIdentity, identityProvider, imageHash, embedding, perceptualHash } = await analyzeProductImage(input.imageBase64, input.imageMediaType);
      identity = generatedIdentity;
      referenceEmbedding = embedding;
      referencePerceptualHash = perceptualHash;
      await updateSearch(searchId, { reference_image_hash: imageHash, identity_profile_json: JSON.stringify(identity), identity_provider: identityProvider });

      // search.product_name is a real placeholder string (never null, see
      // the schema comment) for a pure IMAGE_ONLY submission, so it's
      // ALWAYS truthy — search_mode, not product_name, is the real signal
      // for "no manual name was actually typed" here.
      const hadManualName = search.search_mode !== 'IMAGE_ONLY';
      if (!identity.mainProductName && !hadManualName) {
        // Neither the image nor manual text produced a usable name — an
        // honest failure, never a silent guess (Step 23), and never lets
        // the placeholder string itself leak into query generation.
        await updateSearch(searchId, { status: 'FAILED', error: 'مقدرش أتعرف على المنتج من الصورة، ولا فيه اسم منتج مكتوب. جرب صورة أوضح أو اكتب اسم المنتج يدويًا.', completed_at: new Date() });
        return;
      }
      if (!hadManualName) {
        // Fill the real placeholder product_name with the real generated name (Step 21's auto-fill).
        await updateSearch(searchId, { product_name: identity.mainProductName || search.product_name });
      }
      profile = identityToSearchProfile(identity, { productName: hadManualName ? search.product_name : undefined, possibleNames: input.possibleNames, namesAr: input.namesAr, namesEn: input.namesEn, keywords: input.keywords });
      aiSource = identityProvider;
    } else {
      ({ profile, source: aiSource } = await analyzeProduct({ ...input, productName: search.product_name }));
    }
    await updateSearch(searchId, { status: 'GENERATING_QUERIES', ai_profile_json: JSON.stringify({ ...profile, _analysisSource: aiSource }) });

    if (isCancelled(searchId)) return finalizeCancelled(searchId);

    await updateSearch(searchId, { status: 'SEARCHING' });
    const providerAnyConfigured = (await isAnyProviderConfigured()) || apifyHandlesAdLibrary || usesGoogle;
    const allNormalized = [];

    // --- Google first (Step 16's Stage B needs its evidence before the
    // remaining platforms' queries are generated from the enriched profile) ---
    if (usesGoogle && !isCancelled(searchId)) {
      const googleQueries = generateSearchQueries(profile, ['google']);
      const gStartedAt = Date.now();
      let gSuccess = false, gFailure = false;
      const googleRawItems = [];
      for (const q of googleQueries) {
        try {
          // Direct call, bypassing the shared runProviderSearch dispatcher
          // (searchProviders/index.js) on purpose — that file is shared
          // with the real pipeline and 'google' as a bare platform isn't
          // one of its recognized cases; adding it there would mean
          // editing a shared file this task's constraint says not to
          // touch. googleSearchProvider.search() itself needs zero
          // change: an unrecognized platform value already falls through
          // to a plain, unfiltered query (confirmed by reading its code).
          const items = await googleSearchProvider.search({ query: q.query, platform: 'google', resultsLimit: 10 });
          googleRawItems.push(...items);
          const normalized = items.map((raw) => normalizeGoogleResult(raw, q.query)).filter(Boolean);
          allNormalized.push(...normalized);
          await prisma.experimentalCreativeQuery.create({ data: { search_id: searchId, platform: 'google', query: q.query, query_type: q.queryType, provider: 'google_custom_search', status: 'COMPLETE', result_count: normalized.length } });
          gSuccess = true;
        } catch (err) {
          logger.error(`${LOG_PREFIX} QUERY_FAILED`, { searchId, platform: 'google', query: q.query, errorType: err.name || 'Error' });
          await prisma.experimentalCreativeQuery.create({ data: { search_id: searchId, platform: 'google', query: q.query, query_type: q.queryType, provider: 'google_custom_search', status: 'FAILED', error: err.message } });
          gFailure = true;
        }
      }
      platformStatus.google = googleQueries.length === 0 ? 'NOT_CONFIGURED' : gSuccess ? (gFailure ? 'PARTIAL' : 'COMPLETE') : 'FAILED';
      await updateSearch(searchId, { platform_status_json: JSON.stringify(platformStatus) });
      logger.info(`${LOG_PREFIX} PLATFORM_DONE`, { searchId, platform: 'google', status: platformStatus.google, queriesExecuted: googleQueries.length, resultsCollected: googleRawItems.length, durationMs: Date.now() - gStartedAt });

      if (hasImage && googleRawItems.length > 0) {
        profile = enrichProfileFromGoogleResults(profile, googleRawItems);
        await updateSearch(searchId, { ai_profile_json: JSON.stringify({ ...profile, _analysisSource: aiSource, _stageBEnriched: true }) });
      }
    } else if (platforms.includes('google') && !usesGoogle) {
      platformStatus.google = 'NOT_CONFIGURED';
      await updateSearch(searchId, { platform_status_json: JSON.stringify(platformStatus) });
    }

    // --- Remaining generic platforms, using the (possibly Stage-B-enriched) profile ---
    const queries = generateSearchQueries(profile, genericPlatforms);
    if (queries.length > 0) {
      await prisma.experimentalCreativeQuery.createMany({
        data: queries.map((q) => ({ search_id: searchId, platform: q.platform, query: q.query, query_type: q.queryType, provider: 'pending', status: 'PENDING' })),
      });
    }
    const savedQueries = await prisma.experimentalCreativeQuery.findMany({ where: { search_id: searchId, platform: { in: genericPlatforms } } });

    for (const platform of genericPlatforms) {
      if (isCancelled(searchId)) return finalizeCancelled(searchId);
      const platformQueries = savedQueries.filter((q) => q.platform === platform);
      let platformHadSuccess = false, platformHadFailure = false;
      const platformStartedAt = Date.now();

      for (const q of platformQueries) {
        try {
          const result = await runProviderSearch({ platform, query: q.query, resultsLimit: 25, country: search.country });
          const normalized = result.items.map((raw) => normalizeResult(raw, { platform, provider: result.providerName, query: q.query, queryType: q.query_type })).filter(Boolean);
          allNormalized.push(...normalized);
          await prisma.experimentalCreativeQuery.update({ where: { id: q.id }, data: { status: 'COMPLETE', provider: result.providerName, result_count: normalized.length } });
          platformHadSuccess = true;
        } catch (err) {
          logger.error(`${LOG_PREFIX} QUERY_FAILED`, { searchId, platform, provider: q.provider, query: q.query, errorType: err.name || 'Error' });
          await prisma.experimentalCreativeQuery.update({ where: { id: q.id }, data: { status: 'FAILED', error: err.message } });
          platformHadFailure = true;
        }
      }

      platformStatus[platform] = platformQueries.length === 0 ? 'NOT_CONFIGURED' : platformHadSuccess ? (platformHadFailure ? 'PARTIAL' : 'COMPLETE') : (providerAnyConfigured ? 'FAILED' : 'NOT_CONFIGURED');
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
        let platformHadSuccess = false, platformHadFailure = false;
        for (const tierResult of staged.tiers) {
          await prisma.experimentalCreativeQuery.create({ data: { search_id: searchId, platform: 'META_AD_LIBRARY', query: tierResult.queries.join('، '), query_type: tierResult.tier, provider: tierResult.provider, status: tierResult.error ? 'FAILED' : 'COMPLETE', result_count: tierResult.rawCount, error: tierResult.error } });
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

      // --- Visual verification pass (Steps 9-11/17/29): real local
      // embedding/perceptual-hash/OCR-brand comparison, always attempted
      // when a real reference embedding exists — capped at
      // MAX_VISUAL_COMPARISONS for real cost/time control, only over
      // results that have a real thumbnail. ANTHROPIC_VISION is layered
      // on top only when worth trying (productVisionService.compareVisualMatch
      // decides that internally) — never required for this pass to run at
      // all (Step 31).
      if (hasImage && referenceEmbedding && !isCancelled(searchId)) {
        const rescored = await prisma.experimentalCreativeResult.findMany({
          where: { search_id: searchId, thumbnail: { not: null } },
          orderBy: [{ match_score: { sort: 'desc', nulls: 'last' } }, { created_at: 'desc' }],
          take: MAX_VISUAL_COMPARISONS,
        });
        const reference = { embedding: referenceEmbedding, perceptualHash: referencePerceptualHash, brand: identity?.brand || null, model: identity?.model || null, imageBase64: input.imageBase64, imageMediaType: input.imageMediaType };
        for (const r of rescored) {
          const cmp = await compareVisualMatch(reference, r.thumbnail, `${r.title || ''} ${r.snippet || ''}`);
          if (cmp.error || cmp.visualMatchScore === null) {
            if (cmp.error) logger.error(`${LOG_PREFIX} VISUAL_COMPARE_FAILED`, { searchId, resultId: r.id, message: cmp.error });
            continue; // honest skip — never fabricates a score when the real comparison failed (e.g. broken thumbnail URL) or couldn't run at all
          }
          const distinctScore = distinctiveAttributeScore(identity, r);
          const finalScore = Math.round(0.8 * cmp.visualMatchScore + 0.15 * (r.match_score ?? 0) + 0.05 * (distinctScore ?? 0));
          await prisma.experimentalCreativeResult.update({
            where: { id: r.id },
            data: {
              visual_match_score: cmp.visualMatchScore,
              local_visual_match_score: cmp.localVisualMatchScore,
              visual_match_provider: cmp.visualMatchProvider,
              final_score: finalScore,
              ai_reason: cmp.reason ? `${r.ai_reason ? r.ai_reason + ' | ' : ''}🖼️ ${cmp.reason}` : r.ai_reason,
            },
          });
        }
        logger.info(`${LOG_PREFIX} VISUAL_VERIFICATION_DONE`, { searchId, compared: rescored.length });
      }
    }

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
