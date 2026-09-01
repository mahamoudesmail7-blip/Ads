// Product Research Intelligence — routes. ADMIN/MANAGER only, same tier as
// Settings/Meta (no separate "Media Buyer" role exists yet in this system's
// User.role values, so this reuses the existing tier rather than inventing
// one — see the implementation report for how to add one later if needed).
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { runSearchPipeline } from '../services/productResearchOrchestrator.js';
import { getProviderStatus } from '../services/searchProviders/index.js';
import { analyzeContent } from '../services/productResearchAI.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));

const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube', 'META_AD_LIBRARY'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Step 25 — simple in-memory sliding-window rate limit on the expensive
// search endpoint (no new infra; resets on process restart, an accepted
// trade-off for a first pass, same as the search cache).
const rateLimitHits = new Map();
function checkRateLimit(userId, max = 5, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const hits = (rateLimitHits.get(userId) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  rateLimitHits.set(userId, hits);
  return true;
}

router.get(
  '/provider-status',
  asyncRoute(async (req, res) => {
    res.json({ providers: await getProviderStatus() });
  })
);

router.post(
  '/search',
  asyncRoute(async (req, res) => {
    if (!checkRateLimit(req.user.id)) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'وصلت للحد الأقصى من عمليات البحث (5 كل 10 دقايق) — استنى شوية وجرب تاني.' });
    }

    const { productName, possibleNames, namesAr, namesEn, keywords, description, imageBase64, imageMediaType, country, language, platforms, resultsPerPlatform, productId, adLibraryMode, adLibraryRawLimit, adLibraryActiveOnly } = req.body || {};

    if (!productName || typeof productName !== 'string' || !productName.trim()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'اسم المنتج مطلوب.' });
    }
    const selectedPlatforms = Array.isArray(platforms) ? platforms.filter((p) => PLATFORMS.includes(p)) : [];
    if (selectedPlatforms.length === 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'اختار منصة واحدة على الأقل.' });
    }
    const hardCap = Number(process.env.MAX_RESULTS_PER_PLATFORM) || 100; // 100 = the UI's own max option, so this cap is invisible unless an operator deliberately lowers it for cost control
    const requested = [10, 25, 50, 100].includes(Number(resultsPerPlatform)) ? Number(resultsPerPlatform) : 25;
    const limit = Math.min(requested, hardCap); // user's UI choice can never exceed the server-side cost-control cap

    let storedImage = null;
    if (imageBase64) {
      if (!ALLOWED_IMAGE_TYPES.includes(imageMediaType)) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'نوع الصورة لازم يكون JPEG أو PNG أو WEBP.' });
      }
      const buffer = Buffer.from(imageBase64, 'base64');
      if (buffer.length > MAX_IMAGE_BYTES) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'حجم الصورة أكبر من 5 ميجا.' });
      }
      // Stored as a data URI directly in the DB row (not written to Railway's ephemeral disk, which doesn't persist across deploys) — same DB-centric storage convention the rest of this app already uses.
      storedImage = `data:${imageMediaType};base64,${imageBase64}`;
    }

    if (productId) {
      const product = await prisma.product.findUnique({ where: { id: Number(productId) } });
      if (!product) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'المنتج المحدد مش موجود.' });
    }

    // adLibraryRawLimit: honestly capped, never silently rounded down to a smaller default -- if it's not one of the real supported values it falls back to 100 (Quick's own default), not a smaller silent cap.
    const validRawLimit = [100, 250, 500, 1000, 2000].includes(Number(adLibraryRawLimit)) ? Number(adLibraryRawLimit) : 100;
    const input = {
      possibleNames: possibleNames || [], namesAr: namesAr || [], namesEn: namesEn || [], keywords: keywords || [], description: description || '', imageBase64, imageMediaType,
      adLibraryMode: adLibraryMode === 'deep' ? 'deep' : 'quick',
      adLibraryRawLimit: validRawLimit,
      adLibraryActiveOnly: Boolean(adLibraryActiveOnly),
    };

    const search = await prisma.productResearchSearch.create({
      data: {
        user_id: req.user.id,
        product_id: productId ? Number(productId) : null,
        product_name: productName.trim(),
        product_image: storedImage,
        country: country || 'EG',
        language: language || 'AR_EN',
        platforms_json: JSON.stringify(selectedPlatforms),
        results_per_platform: limit,
        status: 'PENDING',
        input_json: JSON.stringify(input),
      },
    });

    logger.info('PRODUCT_RESEARCH_SEARCH_STARTED', { searchId: search.id, userId: req.user.id, platforms: selectedPlatforms });

    // Fire-and-forget — the route returns immediately, frontend polls GET /search/:id (Step 18).
    runSearchPipeline(search.id).catch((err) => logger.error('PRODUCT_RESEARCH_PIPELINE_UNCAUGHT', { searchId: search.id, message: err.message }));

    res.status(202).json({ searchId: search.id, status: 'PENDING' });
  })
);

router.get(
  '/search/:id',
  asyncRoute(async (req, res) => {
    const search = await prisma.productResearchSearch.findUnique({ where: { id: Number(req.params.id) } });
    if (!search) return res.status(404).json({ error: 'NOT_FOUND', message: 'البحث ده مش موجود.' });

    const resultCount = await prisma.productResearchResult.count({ where: { search_id: search.id } });

    const platforms = JSON.parse(search.platforms_json || '[]');
    let adLibraryStats = null;
    if (platforms.includes('META_AD_LIBRARY')) {
      const [adRows, adQueries] = await Promise.all([
        prisma.productResearchResult.findMany({
          where: { search_id: search.id, platform: 'META_AD_LIBRARY', ignored: false },
          select: { account_name: true, classification: true, thumbnail: true, metrics_json: true },
        }),
        prisma.productResearchQuery.findMany({ where: { search_id: search.id, platform: 'META_AD_LIBRARY' } }),
      ]);
      const inputData = search.input_json ? JSON.parse(search.input_json) : {};
      const rawAdsCollected = adQueries.reduce((sum, q) => sum + (q.result_count || 0), 0);
      const requestedRawLimit = [100, 250, 500, 1000, 2000].includes(Number(inputData.adLibraryRawLimit)) ? Number(inputData.adLibraryRawLimit) : 100;
      // "Unclassified" covers both the new explicit 'UNCLASSIFIED' value AND
      // legacy NULL rows (written before that value existed, or results
      // beyond the AI ranking batch cap) — both mean the same real thing:
      // AI never produced a real judgement for this real result.
      const unclassifiedCount = adRows.filter((r) => !r.classification || r.classification === 'UNCLASSIFIED').length;
      const analysisAvailable = adRows.some((r) => r.classification && r.classification !== 'UNCLASSIFIED');
      adLibraryStats = {
        adsFound: adRows.length,
        activeAds: adRows.filter((r) => r.metrics_json?.includes('"activeStatus":"ACTIVE"')).length,
        advertisersFound: new Set(adRows.map((r) => r.account_name).filter(Boolean)).size,
        exactMatches: adRows.filter((r) => r.classification === 'EXACT_MATCH').length,
        verySimilar: adRows.filter((r) => r.classification === 'VERY_SIMILAR').length,
        similar: adRows.filter((r) => r.classification === 'SIMILAR').length,
        related: adRows.filter((r) => r.classification === 'RELATED').length,
        irrelevant: adRows.filter((r) => r.classification === 'IRRELEVANT').length,
        unclassified: unclassifiedCount,
        analysisAvailable,
        analysisSource: analysisAvailable ? 'ai' : 'fallback',
        creativesFound: adRows.filter((r) => Boolean(r.thumbnail)).length, // "creative" = a result with an actual visible media asset, never assumed for a text-only listing
        // Step 3's requested reporting fields — all derived from real rows already in the existing schema, no new columns needed.
        mode: inputData.adLibraryMode || null,
        requestedRawLimit,
        rawAdsCollected,
        uniqueAdsAfterDedup: adRows.length,
        queriesExecuted: adQueries.length,
        providerRuns: adQueries.filter((q) => q.provider === 'apify_meta_ad_library').length,
        providerLimitReached: rawAdsCollected >= requestedRawLimit,
      };
    }

    res.json({
      id: search.id,
      productName: search.product_name,
      productImage: search.product_image,
      country: search.country,
      language: search.language,
      platforms,
      status: search.status,
      platformStatus: JSON.parse(search.platform_status_json || '{}'),
      aiProfile: search.ai_profile_json ? JSON.parse(search.ai_profile_json) : null,
      error: search.error,
      resultCount,
      adLibraryStats,
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
    const { platform, classification, minMatch, page, active, sort, pageSize: pageSizeParam } = req.query;
    // Real production bug, found via live testing: the old default filter
    // was `classification: { not: 'IRRELEVANT' }`. In SQL, `<> 'IRRELEVANT'`
    // does NOT match NULL rows (three-valued logic) — so the moment AI
    // ranking never touched a result (Claude unavailable, or the result was
    // simply beyond the ranking batch cap), its classification stayed NULL
    // and this filter silently erased it from the list, even though the
    // stats tiles (computed by separate, unfiltered queries) kept reporting
    // the real total. Confirmed live against search #25: 259 real, stored
    // Meta Ads Library results, 0 returned by this filter. Fixed below by
    // never filtering at all by default ("ALL" truly means all, per the
    // explicit requirement that AI availability must never hide real
    // results) and by treating NULL as equivalent to UNCLASSIFIED so a
    // reader who deliberately filters to UNCLASSIFIED also sees legacy rows
    // written before that value existed.
    const pageSize = [25, 50, 100].includes(Number(pageSizeParam)) ? Number(pageSizeParam) : 50;
    const pageNum = Math.max(1, Number(page) || 1);

    const where = { search_id: searchId, ignored: false };
    if (platform && PLATFORMS.includes(platform)) where.platform = platform;
    if (['EXACT_MATCH', 'VERY_SIMILAR', 'SIMILAR', 'RELATED', 'IRRELEVANT'].includes(classification)) {
      where.classification = classification;
    } else if (classification === 'UNCLASSIFIED') {
      where.OR = [{ classification: 'UNCLASSIFIED' }, { classification: null }];
    }
    // classification is empty/"ALL"/unrecognized -> no filter at all, every real result shows.
    if (minMatch) where.match_score = { gte: Number(minMatch) };
    // "Active ads only" — metrics_json is a flexible JSON-as-string column
    // (no schema change for this), so this is a plain substring match
    // rather than a real JSON query; correct because activeStatus is only
    // ever written as this exact literal (see metaAdLibraryProvider.js) —
    // never user-controlled text, so no injection/false-match risk.
    if (active === 'active') where.metrics_json = { contains: '"activeStatus":"ACTIVE"' };

    // Default "match" sort: real-scored results first, UNCLASSIFIED/null
    // ones after (explicit `nulls: 'last'` — Postgres's own default for
    // DESC is nulls-first, which would otherwise bury every classified
    // result behind hundreds of unclassified ones on page 1). Nothing is
    // excluded either way — this only affects order, never visibility.
    const orderBy = sort === 'newest' ? [{ published_at: 'desc' }] : sort === 'oldest' ? [{ published_at: 'asc' }] : [{ match_score: { sort: 'desc', nulls: 'last' } }, { created_at: 'desc' }];

    const [total, rows] = await Promise.all([
      prisma.productResearchResult.count({ where }),
      prisma.productResearchResult.findMany({
        where,
        orderBy,
        skip: (pageNum - 1) * pageSize,
        take: pageSize,
        include: { competitor: { select: { id: true } } },
      }),
    ]);
    // "Active first" is a page-local re-sort (not a full-dataset ORDER BY)
    // to avoid a raw-SQL JSON-path query for a single sort option — stated
    // plainly rather than silently pretending it's a global sort.
    if (sort === 'active') {
      rows.sort((a, b) => {
        const aActive = a.metrics_json?.includes('"activeStatus":"ACTIVE"') ? 0 : 1;
        const bActive = b.metrics_json?.includes('"activeStatus":"ACTIVE"') ? 0 : 1;
        return aActive - bActive;
      });
    }

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
        // Legacy rows saved before UNCLASSIFIED existed are still null here
        // — normalized to the same honest label the frontend renders either way.
        classification: r.classification || 'UNCLASSIFIED',
        matchScore: r.match_score,
        confidenceScore: r.confidence_score,
        aiReason: r.ai_reason,
        isSavedCompetitor: Boolean(r.competitor),
        discoveredByQueries: r.discovered_by_queries_json ? JSON.parse(r.discovered_by_queries_json) : [],
      })),
    });
  })
);

router.get(
  '/search/:id/insights',
  asyncRoute(async (req, res) => {
    const insight = await prisma.productResearchInsight.findUnique({ where: { search_id: Number(req.params.id) } });
    if (!insight) return res.json({ hasInsights: false });
    res.json({ hasInsights: true, ...JSON.parse(insight.insights_json), generatedAt: insight.generated_at });
  })
);

router.get(
  '/search/:id/competitors',
  asyncRoute(async (req, res) => {
    const rows = await prisma.productResearchCompetitor.findMany({ where: { search_id: Number(req.params.id) }, orderBy: { created_at: 'desc' } });
    res.json({ competitors: rows });
  })
);

router.get(
  '/history',
  asyncRoute(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = 25;
    const [total, rows] = await Promise.all([
      prisma.productResearchSearch.count({ where: { user_id: req.user.id } }),
      prisma.productResearchSearch.findMany({
        where: { user_id: req.user.id },
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { results: true, competitors: true } } },
      }),
    ]);
    res.json({
      total,
      page,
      pageSize,
      searches: rows.map((s) => ({
        id: s.id,
        productName: s.product_name,
        status: s.status,
        platforms: JSON.parse(s.platforms_json || '[]'),
        resultCount: s._count.results,
        competitorCount: s._count.competitors,
        createdAt: s.created_at,
        completedAt: s.completed_at,
      })),
    });
  })
);

router.post(
  '/search/:id/rerun',
  asyncRoute(async (req, res) => {
    const search = await prisma.productResearchSearch.findUnique({ where: { id: Number(req.params.id) } });
    if (!search) return res.status(404).json({ error: 'NOT_FOUND', message: 'البحث ده مش موجود.' });
    if (!checkRateLimit(req.user.id)) return res.status(429).json({ error: 'RATE_LIMITED', message: 'استنى شوية قبل ما تعيد بحث تاني.' });

    await prisma.productResearchQuery.deleteMany({ where: { search_id: search.id } });
    await prisma.productResearchResult.deleteMany({ where: { search_id: search.id } });
    await prisma.productResearchSearch.update({ where: { id: search.id }, data: { status: 'PENDING', error: null, platform_status_json: null, completed_at: null } });

    runSearchPipeline(search.id).catch((err) => logger.error('PRODUCT_RESEARCH_PIPELINE_UNCAUGHT', { searchId: search.id, message: err.message }));
    res.status(202).json({ searchId: search.id, status: 'PENDING' });
  })
);

router.post(
  '/result/:id/save-competitor',
  asyncRoute(async (req, res) => {
    const result = await prisma.productResearchResult.findUnique({ where: { id: Number(req.params.id) }, include: { search: true } });
    if (!result) return res.status(404).json({ error: 'NOT_FOUND', message: 'النتيجة دي مش موجودة.' });

    const { notes } = req.body || {};
    const competitor = await prisma.productResearchCompetitor.upsert({
      where: { result_id: result.id },
      create: {
        product_id: result.search.product_id,
        search_id: result.search_id,
        result_id: result.id,
        platform: result.platform,
        account_name: result.account_name,
        account_url: result.account_url || result.canonical_url,
        country: result.search.country,
        follower_count: result.metrics_json ? JSON.parse(result.metrics_json).followers ?? null : null,
        notes: notes || null,
        saved_by_id: req.user.id,
      },
      update: { notes: notes || undefined, last_seen: new Date() },
    });
    res.json({ competitor });
  })
);

router.post(
  '/result/:id/analyze',
  asyncRoute(async (req, res) => {
    const result = await prisma.productResearchResult.findUnique({ where: { id: Number(req.params.id) } });
    if (!result) return res.status(404).json({ error: 'NOT_FOUND', message: 'النتيجة دي مش موجودة.' });

    const analysis = await analyzeContent({ title: result.title, snippet: result.snippet, accountName: result.account_name, contentType: result.content_type, platform: result.platform });
    res.json({ analysis });
  })
);

router.post(
  '/result/:id/ignore',
  asyncRoute(async (req, res) => {
    const result = await prisma.productResearchResult.update({ where: { id: Number(req.params.id) }, data: { ignored: true } }).catch(() => null);
    if (!result) return res.status(404).json({ error: 'NOT_FOUND', message: 'النتيجة دي مش موجودة.' });
    res.json({ ignored: true });
  })
);

export default router;
