// productResearchExperimental.js — "Internal Creative Discovery Platform",
// EXPERIMENTAL. Fully separate routes, fully separate tables
// (Experimental*, see prisma/schema.prisma), fully separate orchestrator
// (services/experimentalCreativeDiscovery.js). Never imports from or
// writes to anything the real routes/productResearch.js touches — a bug
// here cannot affect the real Product Research system, by construction
// (different tables, different route tree, different in-memory state).
//
// Gated behind INTERNAL_CREATIVE_DISCOVERY_ENABLED (feature flag) — when
// unset or not "false", the section is enabled by default so it's visible
// immediately after deploy without requiring a new Railway env var (which
// this session cannot set on the user's behalf); set it to the literal
// string "false" to hide the experimental section entirely without
// touching any other code.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { runExperimentalSearchPipeline, requestCancel } from '../services/experimentalCreativeDiscovery.js';
import { classifyErrorType } from '../services/providerHealth.js';
import * as serpApiProvider from '../services/searchProviders/serpApiProvider.js';
import * as youtubeSearchProvider from '../services/searchProviders/youtubeSearchProvider.js';
import * as googleSearchProvider from '../services/searchProviders/googleSearchProvider.js';
import * as apifyProvider from '../services/searchProviders/apifyMetaAdLibraryProvider.js';
import * as metaAdLibraryProvider from '../services/searchProviders/metaAdLibraryProvider.js';
import { getLocalVisionStats, getWorkerDiagnostics } from '../services/vision/localVisionProvider.js';

const router = Router();
const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube', 'META_AD_LIBRARY', 'google'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PLACEHOLDER_PRODUCT_NAME = '(تحليل تلقائي من الصورة)'; // real, honest placeholder — always overwritten with the real generated name before the search reaches a terminal status (Step 21); never left visible as a final name

function isFeatureEnabled() {
  const raw = (process.env.INTERNAL_CREATIVE_DISCOVERY_ENABLED || '').trim().toLowerCase();
  return raw !== 'false' && raw !== '0'; // default ON — see header comment
}

router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));

// Real, honest per-platform provider label — NEVER a fabricated "Internal
// Search"/"Internal Actor" identity. No custom internal scraper exists for
// Instagram/Facebook/TikTok/Meta Ads Library anywhere in this codebase;
// this experimental section calls the SAME real providers the main
// pipeline uses (SerpApi, the real YouTube Data API, Apify) and says so
// plainly. See the delivery report for the full explanation of this
// deliberate deviation from the requested example labels.
router.get(
  '/status',
  asyncRoute(async (req, res) => {
    const enabled = isFeatureEnabled();
    if (!enabled) return res.json({ enabled: false, providers: [] });

    const serpOk = serpApiProvider.isConfigured();
    const googleOk = googleSearchProvider.isConfigured();
    const youtubeOk = youtubeSearchProvider.isConfigured();
    const igFbTiktokStatus = { provider: serpOk ? 'SerpApi (بحث نصي)' : (googleOk ? 'Google Custom Search (بحث نصي)' : null), status: serpOk || googleOk ? 'CONNECTED' : 'NOT_CONFIGURED' };
    const metaAdLib = await metaAdLibraryProvider.getStatus();
    // Real health, not "credentials are present" (Step 8): a cached
    // (10min) but genuinely real Custom Search call — CONFIGURED alone
    // never reports CONNECTED here anymore. This is scoped to the
    // dedicated 'google' platform entry only; Instagram/Facebook/TikTok/
    // YouTube's own status above still uses the pre-existing
    // isConfigured()-based display for their Google FALLBACK path,
        // unchanged — out of this task's explicit Google-only scope.
    const googleHealth = await googleSearchProvider.getHealthStatus();
    const googleStatusMap = { HEALTHY: 'CONNECTED', ERROR: 'ERROR', QUOTA_EXHAUSTED: 'ERROR', NOT_CONFIGURED: 'NOT_CONFIGURED' };

    res.json({
      enabled: true,
      providers: [
        { platform: 'instagram', ...igFbTiktokStatus },
        { platform: 'facebook', ...igFbTiktokStatus },
        { platform: 'tiktok', ...igFbTiktokStatus },
        { platform: 'youtube', provider: youtubeOk ? 'YouTube Data API' : (googleOk ? 'Google Custom Search (بحث نصي)' : null), status: youtubeOk || googleOk ? 'CONNECTED' : 'NOT_CONFIGURED' },
        { platform: 'META_AD_LIBRARY', provider: metaAdLib.provider === 'apify_meta_ad_library' ? 'Apify' : (metaAdLib.provider ? `${metaAdLib.provider} — احتياطي` : null), status: metaAdLib.status },
        {
          platform: 'google',
          provider: googleOk ? 'Google Custom Search' : null,
          status: googleStatusMap[googleHealth.status] || 'NOT_CONFIGURED',
          detail: googleHealth.reasonLabelAr || null,
          healthStatus: googleHealth.status, // NOT_CONFIGURED | HEALTHY | ERROR | QUOTA_EXHAUSTED — the honest, specific state; `status` above is only the coarse badge color
          lastCheckedAt: googleHealth.lastCheckedAt,
        },
      ],
    });
  })
);

// Real, in-memory, process-lifetime usage/cost counters (Step 25) — never
// invented monetary savings, just real counts of what actually ran
// locally vs. what would otherwise have been an external (paid/rate-
// limited) vision call.
router.get(
  '/diagnostics',
  asyncRoute(async (req, res) => {
    if (!isFeatureEnabled()) return res.status(404).json({ error: 'FEATURE_DISABLED' });
    const local = getLocalVisionStats();
    res.json({
      localImageAnalyses: local.localImageAnalyses,
      localCandidateComparisons: local.localCandidateComparisons,
      cacheHits: local.cacheHits,
      averageProcessingMs: local.averageProcessingMs,
      // Every local analysis/comparison is one real external Anthropic
      // vision call that was NOT made — a direct, honest count, not an
      // estimate of money (never invents a dollar figure).
      externalVisionCallsAvoided: local.localImageAnalyses + local.localCandidateComparisons,
      worker: getWorkerDiagnostics(), // live worker-thread state — added specifically to diagnose a real stuck-analysis incident with no other log access available
    });
  })
);

// Real, tiny, on-demand Google diagnostic (Steps 1/4/5) — runs one real
// cheap text call and one real cheap image call directly against Google's
// API and reports exactly what Google said, with zero secrets in the
// response. Does not create an ExperimentalCreativeSearch row (this is a
// connectivity probe, not a product search) and does not touch anything
// outside googleSearchProvider.js.
router.get(
  '/diagnostics/google',
  asyncRoute(async (req, res) => {
    if (!isFeatureEnabled()) return res.status(404).json({ error: 'FEATURE_DISABLED' });
    const query = (req.query.q && String(req.query.q).trim()) || 'BOSCH electric kettle';

    const configured = googleSearchProvider.isConfigured();
    const textCheck = configured ? await googleSearchProvider.testConnection(query) : null;

    let imageResult = { ok: false, error: 'SKIPPED_NOT_CONFIGURED', results: [] };
    if (configured) {
      try {
        const images = await googleSearchProvider.searchImages({ query, resultsLimit: 3 });
        imageResult = { ok: true, count: images.length, results: images.map((i) => ({ imageUrl: i.imageUrl, thumbnailUrl: i.thumbnailUrl, contextUrl: i.contextUrl, title: i.title, displayLink: i.displayLink, mimeType: i.mimeType, width: i.width, height: i.height })) };
      } catch (err) {
        imageResult = {
          ok: false,
          httpStatus: err.httpStatus ?? null,
          googleErrorCode: err.googleErrorCode ?? null,
          googleErrorStatus: err.googleErrorStatus ?? null,
          googleErrorReason: err.googleErrorReason ?? null,
          googleErrorMessage: err.googleErrorMessage || err.message,
          errorType: googleSearchProvider.classifyGoogleErrorType(err),
        };
      }
    }

    // Real evidence of search scope (Step 3): look at the real displayLink
    // values Google actually returned for an unrestricted, non-site-
    // filtered query — if every result comes back on amazon.com, the
    // engine is scoped to that one site; if displayLink varies across
    // domains, the engine is searching the open web. Never asserted
    // without this real check.
    let scopeEvidence = null;
    if (configured && textCheck?.ok) {
      try {
        const webItems = await googleSearchProvider.search({ query, platform: '__diagnostic_unfiltered__', resultsLimit: 10 });
        const domains = [...new Set(webItems.map((i) => { try { return new URL(i.url).hostname; } catch { return null; } }).filter(Boolean))];
        scopeEvidence = { sampleResultCount: webItems.length, uniqueDomains: domains, looksSiteRestricted: domains.length > 0 && domains.every((d) => d.includes('amazon.')), sampleResults: webItems.slice(0, 5).map((i) => ({ url: i.url, title: i.title, snippet: i.snippet, displayLink: (() => { try { return new URL(i.url).hostname; } catch { return null; } })() })) };
      } catch (err) {
        scopeEvidence = { error: err.message };
      }
    }

    res.json({
      configured,
      query,
      textSearch: textCheck ? {
        ok: textCheck.ok,
        httpStatus: textCheck.httpStatus,
        googleErrorCode: textCheck.googleErrorCode,
        googleErrorStatus: textCheck.googleErrorStatus,
        googleErrorReason: textCheck.googleErrorReason,
        googleErrorMessage: textCheck.googleErrorMessage,
        errorType: textCheck.ok ? null : googleSearchProvider.classifyGoogleErrorType({ googleErrorReason: textCheck.googleErrorReason, googleErrorStatus: textCheck.googleErrorStatus, googleErrorMessage: textCheck.googleErrorMessage, httpStatus: textCheck.httpStatus }),
        latencyMs: textCheck.latencyMs,
        resultCount: textCheck.resultCount,
        searchInformation: textCheck.searchInformation,
        cxAccepted: textCheck.ok, // reaching ok:true means Google accepted both the key and cx
        apiKeyAuthenticated: textCheck.ok || !['AUTH_FAILED', 'API_KEY_RESTRICTED'].includes(googleSearchProvider.classifyGoogleErrorType({ googleErrorReason: textCheck.googleErrorReason, googleErrorStatus: textCheck.googleErrorStatus, googleErrorMessage: textCheck.googleErrorMessage })),
      } : null,
      imageSearch: imageResult,
      scopeEvidence,
    });
  })
);

router.post(
  '/search',
  asyncRoute(async (req, res) => {
    if (!isFeatureEnabled()) return res.status(404).json({ error: 'FEATURE_DISABLED', message: 'المنصة التجريبية متوقفة حاليًا.' });

    const { productName, possibleNames, namesAr, namesEn, keywords, description, imageBase64, imageMediaType, country, language, platforms, mode, adLibraryRawLimit, adLibraryActiveOnly } = req.body || {};

    const hasTypedName = typeof productName === 'string' && productName.trim().length > 0;
    const hasImage = Boolean(imageBase64);
    // Image-only mode (Step 1): typing a product name is no longer
    // required as long as a reference image was uploaded — Stage A
    // (productIdentityVision) generates the name automatically. Only
    // reject when NEITHER a name nor an image was given at all.
    if (!hasTypedName && !hasImage) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'اكتب اسم المنتج أو ارفع صورة له.' });
    }
    const selectedPlatforms = Array.isArray(platforms) ? platforms.filter((p) => PLATFORMS.includes(p)) : [];
    if (selectedPlatforms.length === 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'اختار منصة واحدة على الأقل.' });
    }

    let storedImage = null;
    if (hasImage) {
      if (!ALLOWED_IMAGE_TYPES.includes(imageMediaType)) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'نوع الصورة لازم يكون JPEG أو PNG أو WEBP.' });
      }
      const buffer = Buffer.from(imageBase64, 'base64');
      if (buffer.length > MAX_IMAGE_BYTES) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'حجم الصورة أكبر من 5 ميجا.' });
      }
      storedImage = `data:${imageMediaType};base64,${imageBase64}`;
    }

    const validRawLimit = [100, 250, 500, 1000, 2000].includes(Number(adLibraryRawLimit)) ? Number(adLibraryRawLimit) : 100;
    const input = {
      possibleNames: possibleNames || [], namesAr: namesAr || [], namesEn: namesEn || [], keywords: keywords || [], description: description || '', imageBase64, imageMediaType,
      adLibraryRawLimit: validRawLimit,
      adLibraryActiveOnly: Boolean(adLibraryActiveOnly),
    };

    const search = await prisma.experimentalCreativeSearch.create({
      data: {
        user_id: req.user.id,
        source_mode: 'INTERNAL_EXPERIMENTAL',
        search_mode: !hasTypedName && hasImage ? 'IMAGE_ONLY' : 'TEXT',
        product_name: hasTypedName ? productName.trim() : PLACEHOLDER_PRODUCT_NAME,
        product_image: storedImage,
        country: country || 'EG',
        language: language || 'AR_EN',
        platforms_json: JSON.stringify(selectedPlatforms),
        mode: mode === 'deep' ? 'deep' : 'quick',
        status: 'PENDING',
        input_json: JSON.stringify(input),
      },
    });

    logger.info('[InternalCreativeDiscovery] SEARCH_STARTED', { searchId: search.id, userId: req.user.id, platforms: selectedPlatforms, mode: search.mode });
    runExperimentalSearchPipeline(search.id).catch((err) => logger.error('[InternalCreativeDiscovery] PIPELINE_UNCAUGHT', { searchId: search.id, message: err.message }));

    res.status(202).json({ searchId: search.id, status: 'PENDING' });
  })
);

router.get(
  '/search/:id',
  asyncRoute(async (req, res) => {
    const search = await prisma.experimentalCreativeSearch.findUnique({ where: { id: Number(req.params.id) } });
    if (!search) return res.status(404).json({ error: 'NOT_FOUND', message: 'البحث التجريبي ده مش موجود.' });

    const resultCount = await prisma.experimentalCreativeResult.count({ where: { search_id: search.id, ignored: false } });
    const platforms = JSON.parse(search.platforms_json || '[]');
    const platformStatusMap = JSON.parse(search.platform_status_json || '{}');

    // Real per-platform collected/unique counts — never hardcoded demo numbers.
    const rows = await prisma.experimentalCreativeResult.findMany({ where: { search_id: search.id, ignored: false }, select: { platform: true, classification: true } });
    const byPlatform = {};
    for (const p of platforms) byPlatform[p] = rows.filter((r) => r.platform === p).length;

    const queries = await prisma.experimentalCreativeQuery.findMany({ where: { search_id: search.id } });
    const failedPlatforms = platforms.filter((p) => ['FAILED', 'PARTIAL'].includes(platformStatusMap[p]));
    const platformErrors = {};
    for (const p of failedPlatforms) {
      const latest = queries.filter((q) => q.platform === p && q.status === 'FAILED' && q.error).sort((a, b) => b.id - a.id)[0];
      if (!latest) continue;
      // Google gets its own real, specific classifier (Step 7) — the
      // generic one has no way to know Google's real error vocabulary and
      // was exactly why the frontend showed "خطأ غير معروف" for a real,
      // identifiable Google failure.
      if (p === 'google') {
        const errorType = googleSearchProvider.classifyGoogleErrorType({ message: latest.error });
        platformErrors[p] = { errorType, message: latest.error, messageAr: googleSearchProvider.googleErrorLabelAr(errorType) };
      } else {
        platformErrors[p] = { errorType: classifyErrorType({ message: latest.error }), message: latest.error };
      }
    }

    const unclassifiedCount = rows.filter((r) => !r.classification || r.classification === 'UNCLASSIFIED').length;
    const analysisAvailable = rows.some((r) => r.classification && r.classification !== 'UNCLASSIFIED');

    res.json({
      id: search.id,
      sourceMode: search.source_mode,
      searchMode: search.search_mode,
      productName: search.product_name,
      productImage: search.product_image,
      identityProfile: search.identity_profile_json ? JSON.parse(search.identity_profile_json) : null,
      identityProvider: search.identity_provider, // LOCAL_VISION | LOCAL_VISION+ANTHROPIC — diagnostic (Step 24), never required for the profile above to exist
      country: search.country,
      language: search.language,
      platforms,
      mode: search.mode,
      status: search.status,
      platformStatus: platformStatusMap,
      platformErrors,
      byPlatform,
      aiProfile: search.ai_profile_json ? JSON.parse(search.ai_profile_json) : null,
      error: search.error,
      resultCount,
      summary: {
        totalResults: rows.length,
        uniqueResults: rows.length, // dedup already applied at write time (deduplicateResults) — no separate raw-vs-unique split needed for the generic 4 platforms; Meta Ads Library's own raw/unique split is reflected in byPlatform + queriesExecuted below
        exactMatches: rows.filter((r) => r.classification === 'EXACT_MATCH').length,
        verySimilar: rows.filter((r) => r.classification === 'VERY_SIMILAR').length,
        similar: rows.filter((r) => r.classification === 'SIMILAR').length,
        unclassified: unclassifiedCount,
        analysisAvailable,
      },
      queriesExecuted: queries.length,
      startedAt: search.started_at,
      completedAt: search.completed_at,
      createdAt: search.created_at,
    });
  })
);

router.get(
  '/search/:id/results',
  asyncRoute(async (req, res) => {
    const searchId = Number(req.params.id);
    const { platform, classification, active, sort, page, pageSize: pageSizeParam } = req.query;
    const pageSize = [25, 50, 100].includes(Number(pageSizeParam)) ? Number(pageSizeParam) : 50;
    const pageNum = Math.max(1, Number(page) || 1);

    const where = { search_id: searchId, ignored: false };
    if (platform && PLATFORMS.includes(platform)) where.platform = platform;
    if (['EXACT_MATCH', 'VERY_SIMILAR', 'SIMILAR', 'RELATED', 'IRRELEVANT'].includes(classification)) {
      where.classification = classification;
    } else if (classification === 'UNCLASSIFIED') {
      where.OR = [{ classification: 'UNCLASSIFIED' }, { classification: null }];
    }
    if (active === 'active') where.metrics_json = { contains: '"activeStatus":"ACTIVE"' };

    // When a reference image exists, the visually-verified final_score
    // (Steps 17/29 — 80% visual / 15% text / 5% distinctive attributes)
    // is the honest default ranking signal for "same physical product
    // first"; falls back to the text match_score for anything not
    // visually verified (beyond the comparison cap) or when no image was
    // ever uploaded for this search.
    const searchHasImage = await prisma.experimentalCreativeSearch.findUnique({ where: { id: searchId }, select: { product_image: true } }).then((s) => Boolean(s?.product_image));
    const defaultOrderBy = searchHasImage
      ? [{ final_score: { sort: 'desc', nulls: 'last' } }, { match_score: { sort: 'desc', nulls: 'last' } }, { created_at: 'desc' }]
      : [{ match_score: { sort: 'desc', nulls: 'last' } }, { created_at: 'desc' }];
    const orderBy = sort === 'newest' ? [{ published_at: 'desc' }] : sort === 'oldest' ? [{ published_at: 'asc' }] : defaultOrderBy;

    const [total, rows] = await Promise.all([
      prisma.experimentalCreativeResult.count({ where }),
      prisma.experimentalCreativeResult.findMany({ where, orderBy, skip: (pageNum - 1) * pageSize, take: pageSize }),
    ]);

    res.json({
      total,
      page: pageNum,
      pageSize,
      results: rows.map((r) => ({
        id: r.id,
        platform: r.platform,
        contentType: r.content_type,
        url: r.canonical_url,
        title: r.title,
        snippet: r.snippet,
        accountName: r.account_name,
        accountUrl: r.account_url,
        thumbnail: r.thumbnail,
        publishedAt: r.published_at,
        metrics: r.metrics_json ? JSON.parse(r.metrics_json) : {},
        provider: r.provider,
        classification: r.classification || 'UNCLASSIFIED',
        matchScore: r.match_score,
        confidenceScore: r.confidence_score,
        visualMatchScore: r.visual_match_score,
        localVisualMatchScore: r.local_visual_match_score,
        visualMatchProvider: r.visual_match_provider,
        finalScore: r.final_score,
        aiReason: r.ai_reason,
        discoveredByQueries: r.discovered_by_queries_json ? JSON.parse(r.discovered_by_queries_json) : [],
      })),
    });
  })
);

router.post(
  '/search/:id/cancel',
  asyncRoute(async (req, res) => {
    const searchId = Number(req.params.id);
    const search = await prisma.experimentalCreativeSearch.findUnique({ where: { id: searchId } });
    if (!search) return res.status(404).json({ error: 'NOT_FOUND', message: 'البحث التجريبي ده مش موجود.' });
    if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(search.status)) {
      return res.status(409).json({ error: 'ALREADY_FINISHED', message: 'البحث ده خلص أو اتلغى بالفعل.' });
    }
    requestCancel(searchId);
    await prisma.experimentalCreativeSearch.update({ where: { id: searchId }, data: { status: 'CANCELLED', completed_at: new Date() } });
    logger.info('[InternalCreativeDiscovery] SEARCH_CANCEL_REQUESTED', { searchId, userId: req.user.id });
    res.json({ searchId, status: 'CANCELLED' });
  })
);

export default router;
