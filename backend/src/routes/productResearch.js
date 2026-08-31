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

const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube'];
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
    res.json({ providers: getProviderStatus() });
  })
);

router.post(
  '/search',
  asyncRoute(async (req, res) => {
    if (!checkRateLimit(req.user.id)) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'وصلت للحد الأقصى من عمليات البحث (5 كل 10 دقايق) — استنى شوية وجرب تاني.' });
    }

    const { productName, possibleNames, namesAr, namesEn, keywords, description, imageBase64, imageMediaType, country, language, platforms, resultsPerPlatform, productId } = req.body || {};

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

    const input = { possibleNames: possibleNames || [], namesAr: namesAr || [], namesEn: namesEn || [], keywords: keywords || [], description: description || '', imageBase64, imageMediaType };

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
    res.json({
      id: search.id,
      productName: search.product_name,
      productImage: search.product_image,
      country: search.country,
      language: search.language,
      platforms: JSON.parse(search.platforms_json || '[]'),
      status: search.status,
      platformStatus: JSON.parse(search.platform_status_json || '{}'),
      aiProfile: search.ai_profile_json ? JSON.parse(search.ai_profile_json) : null,
      error: search.error,
      resultCount,
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
    const { platform, classification, minMatch, page } = req.query;
    const pageSize = 25;
    const pageNum = Math.max(1, Number(page) || 1);

    const where = { search_id: searchId, ignored: false };
    if (platform && PLATFORMS.includes(platform)) where.platform = platform;
    if (classification && ['EXACT_MATCH', 'VERY_SIMILAR', 'SIMILAR', 'RELATED', 'IRRELEVANT'].includes(classification)) {
      where.classification = classification;
    } else {
      where.classification = { not: 'IRRELEVANT' }; // Step 9 default: hide IRRELEVANT
    }
    if (minMatch) where.match_score = { gte: Number(minMatch) };

    const [total, rows] = await Promise.all([
      prisma.productResearchResult.count({ where }),
      prisma.productResearchResult.findMany({
        where,
        orderBy: [{ match_score: 'desc' }, { created_at: 'desc' }],
        skip: (pageNum - 1) * pageSize,
        take: pageSize,
        include: { competitor: { select: { id: true } } },
      }),
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
        thumbnail: r.thumbnail,
        publishedAt: r.published_at,
        metrics: r.metrics_json ? JSON.parse(r.metrics_json) : {},
        classification: r.classification,
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
