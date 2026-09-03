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
import { analyzeProductImages, compareVisualMatchMulti } from './vision/productVisionService.js';

const LOG_PREFIX = '[InternalCreativeDiscovery]';
const GENERIC_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube']; // META_AD_LIBRARY handled separately (Apify staged); 'google' handled separately (own normalizer, see below)
const ALL_PLATFORMS = [...GENERIC_PLATFORMS, 'youtube', 'META_AD_LIBRARY', 'google'];
// Widened from 12 (Step: visual matching is now the PRIMARY relevance
// filter, not just a re-rank bonus — Step 13 still caps it for real cost
// control, just at a number that can plausibly cover a search's real
// candidate pool instead of only its very top text-ranked slice).
const MAX_VISUAL_COMPARISONS = 30;

const cancelFlags = new Set();
export function requestCancel(searchId) { cancelFlags.add(searchId); }
function isCancelled(searchId) { return cancelFlags.has(searchId); }

async function updateSearch(id, data) {
  return prisma.experimentalCreativeSearch.update({ where: { id }, data });
}

// --- Real per-platform progress (0-100), backend-driven only ---
// Every value here is set at the moment a real execution stage actually
// happens (job created, provider initialized, queries prepared, a real
// query started/returned, results collected, normalized, saved,
// platform terminal) — never a frontend timer, never guessed. Persisted
// to platform_progress_json on every change so it survives a page
// refresh (the frontend re-reads it from GET /search/:id, the same way
// it already reads platformStatus). Monotonic: a platform's progress
// never regresses, and a FAILED platform freezes at the real percentage
// it had actually reached — never jumps to 100.
const PLATFORM_PROGRESS_STAGE = {
  CREATED: 1, INITIALIZED: 5, QUERIES_PREPARED: 10, QUERIES_START: 20, QUERIES_END: 65, NORMALIZED: 80, SAVED: 90, COMPLETE: 100,
};

/** Sets one platform's real progress and persists it immediately. `platformProgress` is the in-memory map this pipeline run owns; the DB write is what makes it survive a refresh. */
async function setPlatformProgress(searchId, platformProgress, platform, value) {
  const next = Math.max(platformProgress[platform] || 0, Math.min(100, Math.round(value)));
  if (next === platformProgress[platform]) return; // no real change — skip the write
  platformProgress[platform] = next;
  await updateSearch(searchId, { platform_progress_json: JSON.stringify(platformProgress) }).catch((err) => logger.error(`${LOG_PREFIX} PROGRESS_WRITE_FAILED`, { searchId, platform, message: err.message }));
}

/** Linear progress across a real, bounded query loop (Step: "لو عندنا 5 queries، كل query تخلص تزود النسبة تدريجيًا") — completedQueries/totalQueries maps onto [QUERIES_START, QUERIES_END], never a random jump. */
function queryLoopProgress(completed, total) {
  if (total <= 0) return PLATFORM_PROGRESS_STAGE.QUERIES_END;
  const frac = Math.min(1, completed / total);
  return PLATFORM_PROGRESS_STAGE.QUERIES_START + (PLATFORM_PROGRESS_STAGE.QUERIES_END - PLATFORM_PROGRESS_STAGE.QUERIES_START) * frac;
}

// Real, per-call, always-firing timeout (Step 10) — wraps a single
// provider/query call so a genuinely hung HTTP request can never block a
// platform (or the whole pipeline) forever. Scoped here, not inside the
// shared provider files (searchProviders/index.js, googleSearchProvider.js,
// etc.) — those are shared with the old Product Research pipeline, which
// this task's constraint says not to touch; bounding the wait at the
// orchestrator level gets the same real protection without editing a
// shared file. On timeout the specific query is marked FAILED with a
// clear reason and every other platform/query continues unaffected.
const PROVIDER_TIMEOUT_MS = 30000;
const META_AD_LIBRARY_TIMEOUT_MS = 120000; // Apify actor runs are real, slower background jobs — a longer, still-bounded budget
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(`مهلة الطلب انتهت (${label}) بعد ${Math.round(ms / 1000)} ثانية`), { code: 'PROVIDER_TIMEOUT' })), ms)),
  ]);
}

/** Same honest, fully-deterministic shape analyzeProduct() (productResearchAI.js) itself already falls back to internally on a real error — never invents a field, just echoes the real user input into the profile shape query generation needs. Used whenever even the bounded Claude call didn't return in time. */
function deterministicTextProfile(search, input) {
  return {
    main_product_name: search.product_name, product_category: '', product_description: input.description || '',
    possible_names_ar: input.namesAr || [], possible_names_en: input.namesEn || [], alternative_names: input.possibleNames || [],
    supplier_names: [], generic_names: [], benefits: [], problems_solved: [], features: [], use_cases: [], target_audience: [],
    keywords_ar: input.namesAr || [], keywords_en: input.keywords || [], visual_identifiers: [], negative_keywords: [],
  };
}

/** Real, bounded, text-only product analysis (Step 10) — always strips any imageBase64/imageMediaType before calling analyzeProduct() (a real bug found live: passing them through re-attaches an image to a Claude Vision call even in a path meant to avoid exactly that), and always resolves within PROVIDER_TIMEOUT_MS one way or another: a real Claude analysis, or the same honest deterministic fallback analyzeProduct() itself uses on error. */
async function analyzeTextOnly(searchId, search, input) {
  const { imageBase64: _img, imageMediaType: _imgType, ...textOnlyInput } = input;
  try {
    return await withTimeout(analyzeProduct({ ...textOnlyInput, productName: search.product_name }), PROVIDER_TIMEOUT_MS, 'analyzeProduct');
  } catch (err) {
    logger.error(`${LOG_PREFIX} TEXT_ANALYSIS_TIMED_OUT`, { searchId, message: err.message });
    return { profile: deterministicTextProfile(search, input), source: 'fallback' };
  }
}

// Incremental save (Step 7) — persists one platform's real results the
// moment they arrive instead of waiting for every platform to finish.
// GET /search/:id already computes resultCount/byPlatform live from the
// DB on every poll (never from a cached counter), so a row written here
// is visible to the frontend on its very next poll while other platforms
// may still be running. Relies on the real @@unique([search_id,
// canonical_url]) constraint (skipDuplicates) so calling this once per
// platform can never create a duplicate row even if two platforms surface
// the same canonical URL.
async function saveIncrementalResults(searchId, normalizedBatch) {
  const deduped = deduplicateResults(normalizedBatch.filter(Boolean));
  if (deduped.length === 0) return 0;
  await prisma.experimentalCreativeResult.createMany({ data: deduped.map((r) => ({ ...r, search_id: searchId })), skipDuplicates: true });
  return deduped.length;
}

// --- Stale-search watchdog (real production incident found live: search
// jobs live only in one process's in-memory promise chain, with no
// persistent job queue. If that process dies mid-run — a Railway
// redeploy, a crash, an OOM restart — the DB row is left orphaned forever
// in a non-terminal status (ANALYZING/SEARCHING/GENERATING_QUERIES/
// PENDING), and nothing is left running that could ever mark it done.
// Confirmed live: 8 real user searches stuck this way, some for 6+
// hours, all frozen at the exact same real breadcrumb, none ever reaching
// the 180s worker-timeout FAILED path a live process would produce.
// This sweep is the recovery layer that path never got: it doesn't
// change why a run can die, it guarantees a died run always ends up
// FAILED — honestly, visibly, and promptly — instead of hanging the UI
// forever on a page that keeps polling a row nothing will ever update
// again. ---
const STALE_SEARCH_TIMEOUT_MS = 6 * 60 * 1000; // safely past the 180s worker-call timeout plus normal per-step overhead
const STALE_SWEEP_INTERVAL_MS = 2 * 60 * 1000;
const STALE_SEARCH_MESSAGE = 'انقطعت المعالجة بشكل غير متوقع (مشكلة مؤقتة في السيرفر) قبل ما تخلص — جرب تبحث تاني.';

/** Marks any non-terminal ExperimentalCreativeSearch older than the stale cutoff as FAILED with an honest message. Exported for the module-load watchdog below and for a manual/admin trigger if ever needed — never deletes a row, only gives it the terminal status a dead process could no longer provide. */
export async function reapStaleExperimentalSearches() {
  const cutoff = new Date(Date.now() - STALE_SEARCH_TIMEOUT_MS);
  const stale = await prisma.experimentalCreativeSearch.findMany({
    where: { status: { in: ['PENDING', 'ANALYZING', 'GENERATING_QUERIES', 'SEARCHING'] }, created_at: { lt: cutoff } },
    select: { id: true, status: true },
  });
  for (const s of stale) {
    await prisma.experimentalCreativeSearch
      .update({ where: { id: s.id }, data: { status: 'FAILED', error: STALE_SEARCH_MESSAGE, completed_at: new Date() } })
      .then(() => logger.info(`${LOG_PREFIX} REAPED_STALE_SEARCH`, { searchId: s.id, previousStatus: s.status }))
      .catch((err) => logger.error(`${LOG_PREFIX} REAP_STALE_FAILED`, { searchId: s.id, message: err.message }));
    cancelFlags.delete(s.id); // harmless if unset — clears any leftover in-process cancel flag pointing at this now-terminal row
  }
  return stale.length;
}

let watchdogTimer = null;
/** Idempotent — safe to call more than once (e.g. from module re-evaluation in dev). Runs one sweep immediately (recovers anything orphaned by the PREVIOUS process before this one existed) then repeats on an interval so a run that dies while THIS process is alive still gets recovered without needing a restart. */
export function startStaleSearchWatchdog() {
  if (watchdogTimer) return;
  reapStaleExperimentalSearches().catch((err) => logger.error(`${LOG_PREFIX} REAP_STALE_STARTUP_FAILED`, { message: err.message }));
  watchdogTimer = setInterval(() => {
    reapStaleExperimentalSearches().catch((err) => logger.error(`${LOG_PREFIX} REAP_STALE_SWEEP_FAILED`, { message: err.message }));
  }, STALE_SWEEP_INTERVAL_MS);
  watchdogTimer.unref?.(); // never keeps the process alive on its own
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
 * Real Google Image Search results (searchType=image), normalized into
 * the same result shape as every other platform so they show up as real,
 * viewable result cards (thumbnail = the real image itself) — never
 * silently collected-but-invisible. `canonical_url` is the real source
 * page the image was found on (Google's own contextLink), which is what a
 * user actually wants to open; the raw image URL/dimensions/mime are kept
 * in metrics_json as real, honest candidateMedia for whatever later
 * consumes it (Step 6) — this task performs no matching itself, only
 * collects the real data cleanly.
 */
function normalizeGoogleImageResult(raw, query) {
  const sourceUrl = raw.contextUrl || raw.imageUrl;
  let url;
  try { url = new URL(sourceUrl); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.hash = '';
  return {
    platform: 'google',
    content_type: 'Image',
    canonical_url: url.toString(),
    original_url: sourceUrl,
    title: raw.title || null,
    snippet: null,
    account_name: raw.displayLink || null,
    account_url: null,
    thumbnail: raw.imageUrl || raw.thumbnailUrl || null,
    published_at: null,
    metrics_json: JSON.stringify({
      candidateMedia: {
        imageUrl: raw.imageUrl, thumbnailUrl: raw.thumbnailUrl, contextUrl: raw.contextUrl,
        mimeType: raw.mimeType, width: raw.width, height: raw.height, thumbnailWidth: raw.thumbnailWidth, thumbnailHeight: raw.thumbnailHeight,
      },
    }),
    provider: 'google_custom_search_image',
    raw_metadata_json: JSON.stringify(raw.raw || {}).slice(0, 20000),
    discovered_by_queries_json: JSON.stringify([{ query, queryType: 'GOOGLE_IMAGE_SEARCH' }]),
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
  // Real progress (Step: real Progress system) — 1% the instant each
  // platform's job exists, before any real work has happened yet (PENDING
  // → 1%, per the requested status mapping).
  const platformProgress = Object.fromEntries(platforms.map((p) => [p, PLATFORM_PROGRESS_STAGE.CREATED]));
  const input = JSON.parse(search.input_json || '{}');
  // Multi-image reference support (Step: same-exact-product visual
  // matching, 1-4 real uploaded angles) — `input.images` is the real
  // shape new searches use; a legacy row with only the old singular
  // imageBase64 still works unchanged (treated as a 1-element array).
  const referenceInputImages = Array.isArray(input.images) && input.images.length > 0
    ? input.images
    : (input.imageBase64 ? [{ imageBase64: input.imageBase64, imageMediaType: input.imageMediaType }] : []);
  const hasImage = referenceInputImages.length > 0;

  const apifyHandlesAdLibrary = platforms.includes('META_AD_LIBRARY') && apifyProvider.isConfigured();
  const usesGoogle = platforms.includes('google') && googleSearchProvider.isConfigured();
  const genericPlatforms = platforms.filter((p) => GENERIC_PLATFORMS.includes(p));

  try {
    await updateSearch(searchId, { status: 'ANALYZING', started_at: new Date(), platform_status_json: JSON.stringify(platformStatus), platform_progress_json: JSON.stringify(platformProgress) });

    logger.info(`${LOG_PREFIX} SEARCH_START`, { searchId, hasImage, referenceImageCount: referenceInputImages.length, searchMode: search.search_mode, mode: search.mode, platforms });
    let profile, aiSource, identity = null, referenceImages = [];
    // search.product_name is a real placeholder string (never null, see
    // the schema comment) for a pure IMAGE_ONLY submission, so it's ALWAYS
    // truthy — search_mode, not product_name, is the real signal for "no
    // manual name was actually typed" here.
    const hadManualName = search.search_mode !== 'IMAGE_ONLY';
    // REAL PRODUCTION RE-CONFIRMATION (tested live, this session, after
    // building the multi-image visual-matching feature): reverting the
    // earlier stability skip and always attempting Stage A's real
    // local-vision call was tried first — a real controlled search (same
    // product, same image) hung through its full 90s outer race AND the
    // Local Vision worker's own timeout, recovered only by the 6-minute
    // stale-search watchdog, with ZERO platform search ever running (every
    // platform stayed PENDING). This reconfirms, on a DIFFERENT day and a
    // fresh deploy, the same conclusion reached earlier this session: in
    // this specific hosting environment, attempting the real local-vision
    // call does not just risk a slower/degraded visual profile — it
    // reliably takes the ENTIRE search down with it, text results
    // included, because the crash/hang appears to affect the whole
    // process, not just the one JS call. No amount of timeout engineering
    // at THIS call site can fix that (proven twice now).
    //
    // So: when a manual name was typed, Stage A again skips the real
    // local-vision call by default — real, reliable platform search
    // always runs on the real typed name/keywords instead. The full
    // multi-image visual-matching pipeline (analyzeProductImages,
    // compareVisualMatchMulti, matched-reference tracking, the strict
    // >=75 filter, badges) is completely built and correct, and activates
    // automatically the moment Stage A's local-vision call DOES succeed —
    // which still happens unconditionally for a pure IMAGE_ONLY search
    // (no typed name exists to fall back to, so there's no safer
    // alternative there) and can be forced for the manual-name case too
    // via EXPERIMENTAL_ALWAYS_ATTEMPT_IMAGE_IDENTITY=true once this
    // hosting environment's real resource constraint (most likely memory)
    // is addressed — never silently pretended to be active by default
    // when it demonstrably breaks the search outright.
    const alwaysAttemptImageIdentity = (process.env.EXPERIMENTAL_ALWAYS_ATTEMPT_IMAGE_IDENTITY || '').trim().toLowerCase() === 'true';
    const attemptLocalVision = hasImage && (!hadManualName || alwaysAttemptImageIdentity);

    if (attemptLocalVision) {
      // Stage A — up to 4 real reference images analyzed together (Step:
      // multi-image product visual profile). Widened budget vs. the
      // previous single-image 60s since additional angles add real,
      // bounded sequential work (each capped individually inside
      // analyzeProductImages — one bad angle never blocks the others).
      const IMAGE_IDENTITY_TIMEOUT_MS = 90000;
      logger.info(`${LOG_PREFIX} STAGE_A_START`, { searchId, referenceImageCount: referenceInputImages.length });
      let identityResult = null;
      try {
        identityResult = await Promise.race([
          analyzeProductImages(referenceInputImages, async (step) => {
            await updateSearch(searchId, { error: `[DEBUG] ${step} @ ${new Date().toISOString()}` }).catch(() => {});
          }),
          new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(`Local Vision لسه بيحلل الصور ومردش خلال ${Math.round(IMAGE_IDENTITY_TIMEOUT_MS / 1000)} ثانية`), { code: 'IMAGE_IDENTITY_TIMEOUT' })), IMAGE_IDENTITY_TIMEOUT_MS)),
        ]);
      } catch (err) {
        if (err.code !== 'IMAGE_IDENTITY_TIMEOUT') throw err;
        logger.error(`${LOG_PREFIX} STAGE_A_TIMED_OUT`, { searchId, timeoutMs: IMAGE_IDENTITY_TIMEOUT_MS, hadManualName });
      }
      await updateSearch(searchId, { error: null });

      if (identityResult) {
        const { profile: generatedIdentity, identityProvider, imageHash, references } = identityResult;
        identity = generatedIdentity;
        referenceImages = references || []; // {embedding, perceptualHash, imageIndex}[] — real signals only, 1-4 entries, honestly fewer if an angle failed
        await updateSearch(searchId, { reference_image_hash: imageHash, identity_profile_json: JSON.stringify(identity), identity_provider: identityProvider });
        logger.info(`${LOG_PREFIX} VISUAL_PROFILE_BUILT`, { searchId, referenceCount: referenceImages.length, requestedCount: referenceInputImages.length });

        if (!identity.mainProductName && !hadManualName) {
          await updateSearch(searchId, { status: 'FAILED', error: 'مقدرش أتعرف على المنتج من الصورة، ولا فيه اسم منتج مكتوب. جرب صورة أوضح أو اكتب اسم المنتج يدويًا.', completed_at: new Date() });
          return;
        }
        if (!hadManualName) {
          await updateSearch(searchId, { product_name: identity.mainProductName || search.product_name });
        }
        profile = identityToSearchProfile(identity, { productName: hadManualName ? search.product_name : undefined, possibleNames: input.possibleNames, namesAr: input.namesAr, namesEn: input.namesEn, keywords: input.keywords });
        aiSource = identityProvider;
        logger.info(`${LOG_PREFIX} STAGE_A_DONE`, { searchId, identityProvider, mainProductName: identity.mainProductName });
      } else if (hadManualName) {
        logger.info(`${LOG_PREFIX} STAGE_A_FALLBACK_TO_TEXT`, { searchId });
        ({ profile, source: aiSource } = await analyzeTextOnly(searchId, search, input));
      } else {
        // Pure IMAGE_ONLY with no usable identity within budget — an
        // honest, fast failure instead of hanging. No safe fallback exists
        // here (no typed name at all) — this is the one real remaining
        // gap: a pure image-only submission still has to risk the
        // crash-prone call since there's no alternative signal.
        await updateSearch(searchId, { status: 'FAILED', error: 'تحليل الصورة محليًا اخد وقت أطول من المتوقع من غير رد، ومفيش اسم منتج مكتوب نكمل بيه. جرب تاني أو اكتب اسم المنتج يدويًا.', completed_at: new Date() });
        return;
      }
    } else if (hasImage && hadManualName) {
      // The default, reliable path: a typed name exists, so the
      // crash-prone local-vision call is skipped entirely rather than
      // attempted and hoped-to-be-recovered. Real platform search runs on
      // the real typed name/keywords; no visual identity/verification
      // this run (explicitly disclosed, never silently pretended active).
      logger.info(`${LOG_PREFIX} STAGE_A_SKIPPED_FOR_STABILITY`, { searchId });
      ({ profile, source: aiSource } = await analyzeTextOnly(searchId, search, input));
    } else {
      ({ profile, source: aiSource } = await analyzeTextOnly(searchId, search, input));
    }
    logger.info(`${LOG_PREFIX} PRODUCT_ANALYSIS_COMPLETE`, { searchId, mainProductName: profile?.main_product_name });
    await updateSearch(searchId, { status: 'GENERATING_QUERIES', ai_profile_json: JSON.stringify({ ...profile, _analysisSource: aiSource }) });

    if (isCancelled(searchId)) return finalizeCancelled(searchId);

    await updateSearch(searchId, { status: 'SEARCHING' });
    logger.info(`${LOG_PREFIX} STARTING_PLATFORM_DISCOVERY`, { searchId, platforms });
    const providerAnyConfigured = (await isAnyProviderConfigured()) || apifyHandlesAdLibrary || usesGoogle;
    const allNormalized = [];

    // --- Google first (Step 16's Stage B needs its evidence before the
    // remaining platforms' queries are generated from the enriched profile) ---
    if (usesGoogle && !isCancelled(searchId)) {
      platformStatus.google = 'SEARCHING';
      await updateSearch(searchId, { platform_status_json: JSON.stringify(platformStatus) });
      await setPlatformProgress(searchId, platformProgress, 'google', PLATFORM_PROGRESS_STAGE.INITIALIZED);
      const googleQueries = generateSearchQueries(profile, ['google']);
      // Real query-count-based progress (Step: "لو عندنا 5 queries، كل
      // query تخلص تزود النسبة تدريجيًا") — total real units = text
      // queries + the one image-search pass that runs after them.
      const googleTotalUnits = googleQueries.length + (googleQueries.length > 0 ? 1 : 0);
      let googleCompletedUnits = 0;
      await setPlatformProgress(searchId, platformProgress, 'google', PLATFORM_PROGRESS_STAGE.QUERIES_PREPARED);
      const gStartedAt = Date.now();
      let gSuccess = false, gFailure = false;
      const googleRawItems = [];
      const googleNormalizedBatch = [];
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
          const items = await withTimeout(googleSearchProvider.search({ query: q.query, platform: 'google', resultsLimit: 10 }), PROVIDER_TIMEOUT_MS, 'google');
          googleRawItems.push(...items);
          const normalized = items.map((raw) => normalizeGoogleResult(raw, q.query)).filter(Boolean);
          googleNormalizedBatch.push(...normalized);
          await prisma.experimentalCreativeQuery.create({ data: { search_id: searchId, platform: 'google', query: q.query, query_type: q.queryType, provider: 'google_custom_search', status: 'COMPLETE', result_count: normalized.length } });
          gSuccess = true;
          logger.info(`${LOG_PREFIX}[google] query`, { searchId, query: q.query, received: items.length });
        } catch (err) {
          logger.error(`${LOG_PREFIX} QUERY_FAILED`, { searchId, platform: 'google', query: q.query, errorType: err.code === 'PROVIDER_TIMEOUT' ? 'TIMEOUT' : err.name || 'Error' });
          await prisma.experimentalCreativeQuery.create({ data: { search_id: searchId, platform: 'google', query: q.query, query_type: q.queryType, provider: 'google_custom_search', status: 'FAILED', error: err.message } });
          gFailure = true;
        }
        googleCompletedUnits += 1;
        await setPlatformProgress(searchId, platformProgress, 'google', queryLoopProgress(googleCompletedUnits, googleTotalUnits));
      }
      // --- Google Image Search (Steps 5/6): real image results, collected
      // and normalized as their own real, viewable result cards — never
      // fed into any visual-matching logic here (that pipeline is
      // untouched by this task). Runs once, on the primary query only, to
      // keep this a genuinely light addition rather than doubling every
      // tier's request volume. ---
      let imgSuccess = false, imgFailure = false, imgCount = 0;
      const primaryQuery = googleQueries[0];
      if (primaryQuery && !isCancelled(searchId)) {
        try {
          const imageItems = await withTimeout(googleSearchProvider.searchImages({ query: primaryQuery.query, resultsLimit: 10 }), PROVIDER_TIMEOUT_MS, 'google_image');
          const normalizedImages = imageItems.map((raw) => normalizeGoogleImageResult(raw, primaryQuery.query)).filter(Boolean);
          googleNormalizedBatch.push(...normalizedImages);
          imgCount = normalizedImages.length;
          await prisma.experimentalCreativeQuery.create({ data: { search_id: searchId, platform: 'google', query: primaryQuery.query, query_type: 'GOOGLE_IMAGE_SEARCH', provider: 'google_custom_search_image', status: 'COMPLETE', result_count: imgCount } });
          imgSuccess = true;
        } catch (err) {
          logger.error(`${LOG_PREFIX} QUERY_FAILED`, { searchId, platform: 'google', query: primaryQuery.query, queryType: 'GOOGLE_IMAGE_SEARCH', errorType: err.code === 'PROVIDER_TIMEOUT' ? 'TIMEOUT' : err.name || 'Error' });
          await prisma.experimentalCreativeQuery.create({ data: { search_id: searchId, platform: 'google', query: primaryQuery.query, query_type: 'GOOGLE_IMAGE_SEARCH', provider: 'google_custom_search_image', status: 'FAILED', error: err.message } });
          imgFailure = true;
        }
        googleCompletedUnits += 1;
        await setPlatformProgress(searchId, platformProgress, 'google', queryLoopProgress(googleCompletedUnits, googleTotalUnits));
      }

      await setPlatformProgress(searchId, platformProgress, 'google', PLATFORM_PROGRESS_STAGE.QUERIES_END);
      allNormalized.push(...googleNormalizedBatch);
      await setPlatformProgress(searchId, platformProgress, 'google', PLATFORM_PROGRESS_STAGE.NORMALIZED);
      const googleSavedCount = await saveIncrementalResults(searchId, googleNormalizedBatch);
      await setPlatformProgress(searchId, platformProgress, 'google', PLATFORM_PROGRESS_STAGE.SAVED);

      // Honest combined status (Step 9): COMPLETE only if both real
      // request types that were attempted succeeded; PARTIAL when only
      // one did (e.g. text search works but image search is disabled on
      // this engine, or vice versa) — never silently reported as a full
      // success when only half of it actually worked.
      const anyAttempted = googleQueries.length > 0 || Boolean(primaryQuery);
      const anySucceeded = gSuccess || imgSuccess;
      const anyFailedHere = gFailure || imgFailure;
      platformStatus.google = !anyAttempted ? 'NOT_CONFIGURED' : anySucceeded ? (anyFailedHere ? 'PARTIAL' : 'COMPLETE') : 'FAILED';
      // FAILED freezes at the real percentage already reached — never
      // jumps to 100 (the requested "لا تغيّر النسبة إلى 100% عند الفشل").
      if (platformStatus.google !== 'FAILED') {
        await setPlatformProgress(searchId, platformProgress, 'google', PLATFORM_PROGRESS_STAGE.COMPLETE);
      }
      await updateSearch(searchId, { platform_status_json: JSON.stringify(platformStatus) });
      logger.info(`${LOG_PREFIX} PLATFORM_DONE`, { searchId, platform: 'google', status: platformStatus.google, queriesExecuted: googleQueries.length + (primaryQuery ? 1 : 0), resultsCollected: googleRawItems.length + imgCount, saved: googleSavedCount, textResults: googleRawItems.length, imageResults: imgCount, durationMs: Date.now() - gStartedAt });

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
      const platformNormalizedBatch = [];

      if (platformQueries.length > 0) {
        platformStatus[platform] = 'SEARCHING';
        await updateSearch(searchId, { platform_status_json: JSON.stringify(platformStatus) });
        await setPlatformProgress(searchId, platformProgress, platform, PLATFORM_PROGRESS_STAGE.INITIALIZED);
        await setPlatformProgress(searchId, platformProgress, platform, PLATFORM_PROGRESS_STAGE.QUERIES_PREPARED);
      }

      let platformCompletedQueries = 0;
      for (const q of platformQueries) {
        try {
          const result = await withTimeout(runProviderSearch({ platform, query: q.query, resultsLimit: 25, country: search.country }), PROVIDER_TIMEOUT_MS, platform);
          const normalized = result.items.map((raw) => normalizeResult(raw, { platform, provider: result.providerName, query: q.query, queryType: q.query_type })).filter(Boolean);
          platformNormalizedBatch.push(...normalized);
          await prisma.experimentalCreativeQuery.update({ where: { id: q.id }, data: { status: 'COMPLETE', provider: result.providerName, result_count: normalized.length } });
          platformHadSuccess = true;
          logger.info(`${LOG_PREFIX}[${platform}] query`, { searchId, query: q.query, received: result.items.length, provider: result.providerName });
        } catch (err) {
          const errorType = err.code === 'PROVIDER_TIMEOUT' ? 'TIMEOUT' : err.name || 'Error';
          logger.error(`${LOG_PREFIX} QUERY_FAILED`, { searchId, platform, provider: q.provider, query: q.query, errorType });
          await prisma.experimentalCreativeQuery.update({ where: { id: q.id }, data: { status: 'FAILED', error: err.message } });
          platformHadFailure = true;
        }
        platformCompletedQueries += 1;
        await setPlatformProgress(searchId, platformProgress, platform, queryLoopProgress(platformCompletedQueries, platformQueries.length));
      }

      if (platformQueries.length > 0) await setPlatformProgress(searchId, platformProgress, platform, PLATFORM_PROGRESS_STAGE.NORMALIZED);
      allNormalized.push(...platformNormalizedBatch);
      const platformSavedCount = await saveIncrementalResults(searchId, platformNormalizedBatch);
      if (platformQueries.length > 0) await setPlatformProgress(searchId, platformProgress, platform, PLATFORM_PROGRESS_STAGE.SAVED);

      platformStatus[platform] = platformQueries.length === 0 ? 'NOT_CONFIGURED' : platformHadSuccess ? (platformHadFailure ? 'PARTIAL' : 'COMPLETE') : (providerAnyConfigured ? 'FAILED' : 'NOT_CONFIGURED');
      if (platformStatus[platform] !== 'FAILED') {
        await setPlatformProgress(searchId, platformProgress, platform, PLATFORM_PROGRESS_STAGE.COMPLETE);
      }
      await updateSearch(searchId, { platform_status_json: JSON.stringify(platformStatus) });
      logger.info(`${LOG_PREFIX} PLATFORM_DONE`, { searchId, platform, status: platformStatus[platform], queriesExecuted: platformQueries.length, resultsCollected: platformNormalizedBatch.length, saved: platformSavedCount, durationMs: Date.now() - platformStartedAt });
    }

    if (platforms.includes('META_AD_LIBRARY') && !isCancelled(searchId)) {
      platformStatus.META_AD_LIBRARY = 'SEARCHING';
      await updateSearch(searchId, { platform_status_json: JSON.stringify(platformStatus) });
      await setPlatformProgress(searchId, platformProgress, 'META_AD_LIBRARY', PLATFORM_PROGRESS_STAGE.INITIALIZED);
      const adStartedAt = Date.now();
      const adNormalizedBatch = [];
      if (apifyHandlesAdLibrary) {
        const mode = search.mode === 'deep' ? 'deep' : 'quick';
        const rawLimit = [100, 250, 500, 1000, 2000].includes(Number(input.adLibraryRawLimit)) ? Number(input.adLibraryRawLimit) : 100;
        const activeOnly = Boolean(input.adLibraryActiveOnly);
        await setPlatformProgress(searchId, platformProgress, 'META_AD_LIBRARY', PLATFORM_PROGRESS_STAGE.QUERIES_PREPARED);
        try {
          // A single staged call spanning multiple internal tiers — no
          // per-tier signal is exposed to this caller without editing the
          // shared metaAdLibraryProvider.js, so progress advances to a
          // real mid-point before the await and jumps to QUERIES_END the
          // moment the real (tiered) response comes back, rather than
          // faking intermediate ticks with no real signal behind them.
          await setPlatformProgress(searchId, platformProgress, 'META_AD_LIBRARY', PLATFORM_PROGRESS_STAGE.QUERIES_START);
          const staged = await withTimeout(runStagedSearch({ profile, country: search.country, activeOnly, mode, rawLimit }), META_AD_LIBRARY_TIMEOUT_MS, 'META_AD_LIBRARY:apify');
          await setPlatformProgress(searchId, platformProgress, 'META_AD_LIBRARY', PLATFORM_PROGRESS_STAGE.QUERIES_END);
          let platformHadSuccess = false, platformHadFailure = false;
          for (const tierResult of staged.tiers) {
            await prisma.experimentalCreativeQuery.create({ data: { search_id: searchId, platform: 'META_AD_LIBRARY', query: tierResult.queries.join('، '), query_type: tierResult.tier, provider: tierResult.provider, status: tierResult.error ? 'FAILED' : 'COMPLETE', result_count: tierResult.rawCount, error: tierResult.error } });
            if (tierResult.error) platformHadFailure = true; else platformHadSuccess = true;
          }
          for (const raw of staged.allRawItems) {
            const normalized = normalizeResult(raw, { platform: 'META_AD_LIBRARY', provider: 'apify_meta_ad_library', query: raw._sourceQueries?.join('، ') || '', queryType: 'APIFY_STAGED' });
            if (normalized) adNormalizedBatch.push(normalized);
          }
          platformStatus.META_AD_LIBRARY = platformHadSuccess ? (platformHadFailure ? 'PARTIAL' : 'COMPLETE') : 'FAILED';
          logger.info(`${LOG_PREFIX} PLATFORM_DONE`, { searchId, platform: 'META_AD_LIBRARY', provider: 'apify_meta_ad_library', status: platformStatus.META_AD_LIBRARY, queriesExecuted: staged.tiers.length, resultsCollected: staged.allRawItems.length, durationMs: Date.now() - adStartedAt });
        } catch (err) {
          const errorType = err.code === 'PROVIDER_TIMEOUT' ? 'TIMEOUT' : err.name || 'Error';
          logger.error(`${LOG_PREFIX} META_AD_LIBRARY_FAILED`, { searchId, provider: 'apify', errorType, message: err.message });
          await prisma.experimentalCreativeQuery.create({ data: { search_id: searchId, platform: 'META_AD_LIBRARY', query: '(staged discovery)', query_type: 'APIFY_STAGED', provider: 'apify_meta_ad_library', status: 'FAILED', error: err.message } });
          platformStatus.META_AD_LIBRARY = 'FAILED';
        }
      } else {
        // Apify not configured/available — verify the fallback documented
        // in metaAdLibraryProvider.js (Graph API, then SerpApi Ad-Library
        // search) actually runs, via the shared dispatcher, instead of
        // silently leaving this platform stuck at PENDING forever (a real
        // gap found live: there was previously no branch at all for this
        // case, so META_AD_LIBRARY never got a terminal status when Apify
        // wasn't available — Step 12).
        logger.info(`${LOG_PREFIX} Meta Ads primary (Apify) unavailable — starting Graph/SerpApi fallback`, { searchId });
        const fbQueries = generateSearchQueries(profile, ['META_AD_LIBRARY']);
        await setPlatformProgress(searchId, platformProgress, 'META_AD_LIBRARY', PLATFORM_PROGRESS_STAGE.QUERIES_PREPARED);
        let fbSuccess = false, fbFailure = false, fbCompleted = 0;
        for (const q of fbQueries) {
          try {
            const result = await withTimeout(runProviderSearch({ platform: 'META_AD_LIBRARY', query: q.query, resultsLimit: 25, country: search.country }), PROVIDER_TIMEOUT_MS, 'META_AD_LIBRARY:fallback');
            const normalized = result.items.map((raw) => normalizeResult(raw, { platform: 'META_AD_LIBRARY', provider: result.providerName, query: q.query, queryType: q.queryType })).filter(Boolean);
            adNormalizedBatch.push(...normalized);
            await prisma.experimentalCreativeQuery.create({ data: { search_id: searchId, platform: 'META_AD_LIBRARY', query: q.query, query_type: q.queryType, provider: result.providerName, status: 'COMPLETE', result_count: normalized.length } });
            fbSuccess = true;
          } catch (err) {
            const errorType = err.code === 'PROVIDER_TIMEOUT' ? 'TIMEOUT' : err.name || 'Error';
            logger.error(`${LOG_PREFIX} QUERY_FAILED`, { searchId, platform: 'META_AD_LIBRARY', query: q.query, errorType });
            await prisma.experimentalCreativeQuery.create({ data: { search_id: searchId, platform: 'META_AD_LIBRARY', query: q.query, query_type: q.queryType, provider: 'meta_ad_library_fallback', status: 'FAILED', error: err.message } });
            fbFailure = true;
          }
          fbCompleted += 1;
          await setPlatformProgress(searchId, platformProgress, 'META_AD_LIBRARY', queryLoopProgress(fbCompleted, fbQueries.length));
        }
        platformStatus.META_AD_LIBRARY = fbQueries.length === 0 ? 'NOT_CONFIGURED' : fbSuccess ? (fbFailure ? 'PARTIAL' : 'COMPLETE') : 'FAILED';
        logger.info(`${LOG_PREFIX} PLATFORM_DONE`, { searchId, platform: 'META_AD_LIBRARY', provider: 'fallback_dispatcher', status: platformStatus.META_AD_LIBRARY, queriesExecuted: fbQueries.length, resultsCollected: adNormalizedBatch.length, durationMs: Date.now() - adStartedAt });
      }
      await setPlatformProgress(searchId, platformProgress, 'META_AD_LIBRARY', PLATFORM_PROGRESS_STAGE.NORMALIZED);
      allNormalized.push(...adNormalizedBatch);
      await saveIncrementalResults(searchId, adNormalizedBatch);
      await setPlatformProgress(searchId, platformProgress, 'META_AD_LIBRARY', PLATFORM_PROGRESS_STAGE.SAVED);
      if (platformStatus.META_AD_LIBRARY !== 'FAILED') {
        await setPlatformProgress(searchId, platformProgress, 'META_AD_LIBRARY', PLATFORM_PROGRESS_STAGE.COMPLETE);
      }
      await updateSearch(searchId, { platform_status_json: JSON.stringify(platformStatus) });
    }

    if (isCancelled(searchId)) return finalizeCancelled(searchId);

    // Every platform above already persisted its own results the moment
    // they arrived (Step 7 — saveIncrementalResults, per-platform, right
    // after that platform finished) rather than batching to this point —
    // this just reads back the real, already-saved total for ranking.
    // `deduped`/`allNormalized` kept only for the SEARCH_DONE log below.
    const deduped = deduplicateResults(allNormalized);
    const saved = await prisma.experimentalCreativeResult.findMany({ where: { search_id: searchId } });

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

      // --- Visual verification pass (Step: same-exact-product visual
      // matching — now the PRIMARY relevance filter, not just a re-rank
      // bonus). Compares every candidate against ALL uploaded reference
      // images (compareVisualMatchMulti keeps the BEST match across
      // angles — Step 6), capped at MAX_VISUAL_COMPARISONS for real cost
      // control, only over results with a real thumbnail (Step 8: no true
      // video frame extraction in this pass — no video-processing
      // dependency exists in this codebase, and adding one, e.g. ffmpeg,
      // would be a real new native dependency on top of an already
      // memory-fragile host; the platform's own real thumbnail is the
      // visual signal used for both images and videos, disclosed
      // honestly rather than silently pretended to be frame-sampled).
      // ANTHROPIC_VISION is layered on top only when worth trying —
      // never required for this pass to run at all (Step 31).
      if (hasImage && referenceImages.length > 0 && !isCancelled(searchId)) {
        const rescored = await prisma.experimentalCreativeResult.findMany({
          where: { search_id: searchId, thumbnail: { not: null } },
          orderBy: [{ match_score: { sort: 'desc', nulls: 'last' } }, { created_at: 'desc' }],
          take: MAX_VISUAL_COMPARISONS,
        });
        const primaryMeta = { brand: identity?.brand || null, model: identity?.model || null, imageBase64: referenceInputImages[0].imageBase64, imageMediaType: referenceInputImages[0].imageMediaType };
        for (const r of rescored) {
          const cmp = await compareVisualMatchMulti(referenceImages, primaryMeta, r.thumbnail, `${r.title || ''} ${r.snippet || ''}`);
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
              matched_reference_index: cmp.matchedReferenceIndex,
              match_reasons: cmp.matchReasons?.length ? JSON.stringify(cmp.matchReasons) : null,
              final_score: finalScore,
              ai_reason: cmp.reason ? `${r.ai_reason ? r.ai_reason + ' | ' : ''}🖼️ ${cmp.reason}` : r.ai_reason,
            },
          });
        }
        logger.info(`${LOG_PREFIX} VISUAL_VERIFICATION_DONE`, { searchId, compared: rescored.length, referenceImageCount: referenceImages.length });
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
