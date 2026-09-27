// Winner Products Discovery Engine — "🔥 منتجات وينر". Phase 1: real
// per-category discovery reusing the EXISTING provider registry
// (searchProviders/index.js — the same Instagram/Facebook/TikTok/YouTube/
// Meta Ads Library connections experimentalCreativeDiscovery.js already
// uses), basic same-title clustering (real fuzzy alias/image clustering is
// a later phase), and honest evidence storage. Slice 1 (this file) adds
// real multi-signal Winner scoring on top of those same clusters — see
// winnerScoring.js for exactly what's real vs honestly UNKNOWN per
// platform. Egypt Saturation / Opportunity Gap are intentionally still left
// null here — a later slice computes them; this file never fabricates them.
//
// Fully isolated from every other module: its own tables
// (winner_product_*), its own routes (/api/winner-products/*), its own
// frontend file. Never touches Product/AmbProduct/ExperimentalCreative* or
// any other existing table.
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { runProviderSearch, isAnyProviderConfigured, getProviderStatus } from './searchProviders/index.js';
import { fetchOgImage, runWithConcurrency } from './ogImageFetch.js';
import { scoreClusters } from './winnerScoring.js';

const LOG_PREFIX = '[WinnerProducts]';
const GENERIC_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube', 'META_AD_LIBRARY'];
const RESULTS_PER_QUERY = { quick: 15, deep: 30 };
const QUERIES_PER_PLATFORM = { quick: 2, deep: 4 };

// ---------------------------------------------------------------------------
// Categories (admin-configurable — real DB table, see schema.prisma)
// ---------------------------------------------------------------------------
export async function listCategories() {
  return prisma.winnerProductCategory.findMany({ where: { enabled: true }, orderBy: { sort_order: 'asc' } });
}

// ---------------------------------------------------------------------------
// Query generation (spec: "the user should NOT have to know product
// names" — real, category-specific seed queries, never one fixed query).
// Phase 1: a real per-category template bank in English + Arabic. Phase 2
// extends this with alias/multi-language generation for CANDIDATE products
// found here, not the initial discovery queries themselves.
// ---------------------------------------------------------------------------
const CATEGORY_QUERY_TEMPLATES = {
  medical: ['viral health gadgets', 'new wellness devices', 'home therapy device', 'أجهزة طبية منزلية ترند'],
  massage: ['massage gun viral', 'trending massage device', 'جهاز مساج ترند', 'مسدس مساج جديد'],
  beauty: ['viral beauty products', 'new beauty gadgets', 'beauty product tiktok made me buy it', 'أدوات تجميل ترند'],
  hair: ['viral hair tool', 'trending hair gadget', 'أداة شعر ترند'],
  skincare: ['new skincare gadgets', 'viral skincare device', 'جهاز عناية بالبشرة ترند'],
  personal_care: ['viral personal care gadget', 'أدوات عناية شخصية ترند'],
  dental: ['viral teeth whitening gadget', 'trending dental device', 'جهاز أسنان ترند'],
  sports: ['trending fitness gadget', 'viral gym gadget', 'أداة رياضية ترند'],
  home_tools: ['viral home gadget', 'must have home tool', 'أداة منزلية ترند'],
  kitchen: ['viral kitchen gadget', 'trending kitchen tool tiktok', 'أداة مطبخ ترند'],
  cleaning: ['viral cleaning gadget', 'trending cleaning tool', 'أداة تنظيف ترند'],
  cars: ['viral car gadget', 'trending car accessory', 'إكسسوار سيارة ترند'],
  mobile_accessories: ['viral phone gadget', 'trending phone accessory', 'إكسسوار موبايل ترند'],
  electronics: ['viral electronic gadget', 'trending small electronics', 'جهاز إلكتروني ترند'],
  smart_devices: ['viral smart gadget', 'trending smart device', 'جهاز ذكي ترند'],
  pets: ['viral pet gadget', 'trending pet product', 'منتج حيوانات أليفة ترند'],
  kids_moms: ['viral baby gadget', 'trending mom product', 'منتج أطفال ترند'],
  toys: ['viral toy 2026', 'trending toy tiktok', 'لعبة ترند'],
  gifts: ['viral gift idea', 'trending gift gadget', 'هدية ترند'],
  decor_lighting: ['viral home decor', 'trending led light gadget', 'ديكور ترند'],
  comfort_sleep: ['viral sleep gadget', 'trending comfort product', 'منتج نوم ترند'],
  travel: ['viral travel gadget', 'trending travel accessory', 'أداة سفر ترند'],
  outdoor: ['viral outdoor gadget', 'trending camping gear', 'أداة أوت دور ترند'],
  tools_maintenance: ['viral repair gadget', 'trending tool gadget', 'أداة صيانة ترند'],
  fashion: ['viral fashion item', 'trending clothing gadget', 'موضة ترند'],
  accessories: ['viral accessory 2026', 'trending accessory tiktok', 'إكسسوار ترند'],
  fishing: ['viral fishing gadget', 'trending fishing gear', 'أداة صيد ترند'],
  garden: ['viral garden gadget', 'trending gardening tool', 'أداة حديقة ترند'],
  education: ['viral learning gadget', 'trending educational toy', 'أداة تعليمية ترند'],
  weird_unique: ['weird viral product', 'unique gadget tiktok', 'منتج غريب ترند'],
  trending: ['trending products 2026', 'viral products this week', 'منتجات ترند 2026'],
  new_arrivals: ['new viral product 2026', 'just launched viral gadget', 'منتج جديد ترند'],
};

function seedQueriesFor(categoryKey, mode) {
  const templates = CATEGORY_QUERY_TEMPLATES[categoryKey] || CATEGORY_QUERY_TEMPLATES.trending;
  const n = QUERIES_PER_PLATFORM[mode] || QUERIES_PER_PLATFORM.quick;
  return templates.slice(0, n);
}

// ---------------------------------------------------------------------------
// Basic same-title clustering (Phase 1). Real fuzzy alias/image-based
// clustering (the spec's full "Product Entity Normalization" section) is
// Phase 2 — this is deliberately simple: normalize (lowercase, strip
// diacritics/extra whitespace/emoji) and group EXACT normalized matches
// only. A low-confidence guess is never silently merged (spec: "if
// confidence is low, keep products separate").
// ---------------------------------------------------------------------------
function normalizeTitle(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, '') // Arabic diacritics
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // strip punctuation/emoji
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------
export async function startSearch({ userId, category, market, timeRange, mode }) {
  const search = await prisma.winnerProductSearch.create({
    data: {
      user_id: userId,
      category,
      market: market || 'EG',
      time_range: timeRange || '7d',
      mode: mode === 'deep' ? 'deep' : 'quick',
      status: 'QUEUED',
    },
  });
  runSearchPipeline(search.id).catch((err) => {
    logger.error(`${LOG_PREFIX} PIPELINE_UNCAUGHT`, { searchId: search.id, message: err.message });
  });
  return search;
}

export async function getSearch(searchId) {
  const search = await prisma.winnerProductSearch.findUnique({ where: { id: searchId } });
  if (!search) return null;
  // Default sort: real Winner Score first (spec: "Default Winner mode: Winner Score descending"), nulls (scoring failed/skipped) sink to the bottom rather than polluting the top of the list; videos_count as a tie-breaker among equally-scored or unscored rows.
  const products = await prisma.winnerProduct.findMany({
    where: { search_id: searchId },
    orderBy: [{ winner_score: { sort: 'desc', nulls: 'last' } }, { videos_count: 'desc' }],
  });
  return { search, products };
}

async function updateSearch(searchId, data) {
  return prisma.winnerProductSearch.update({ where: { id: searchId }, data }).catch((err) => {
    logger.error(`${LOG_PREFIX} UPDATE_FAILED`, { searchId, message: err.message });
  });
}

async function runSearchPipeline(searchId) {
  const search = await prisma.winnerProductSearch.findUnique({ where: { id: searchId } });
  if (!search) return;

  const providerAnyConfigured = await isAnyProviderConfigured();
  if (!providerAnyConfigured) {
    await updateSearch(searchId, { status: 'FAILED', error: 'مفيش أي مزود بحث مربوط — راجع صفحة حالة المزودين.', completed_at: new Date() });
    return;
  }

  const queries = seedQueriesFor(search.category, search.mode);
  await updateSearch(searchId, { status: 'SEARCHING', started_at: new Date(), queries_json: JSON.stringify(queries) });

  const country = search.market === 'EG' || search.market === 'EG_GAP' ? 'EG' : undefined;
  const resultsLimit = RESULTS_PER_QUERY[search.mode] || RESULTS_PER_QUERY.quick;
  const platformStatus = {};
  const allItems = []; // {platform, title, url, thumbnail, accountName, publishedAt}

  for (const platform of GENERIC_PLATFORMS) {
    platformStatus[platform] = 'SEARCHING';
    await updateSearch(searchId, { platform_status_json: JSON.stringify(platformStatus) });
    let platformOk = false;
    for (const query of queries) {
      try {
        const { items } = await runProviderSearch({ platform, query, resultsLimit, country });
        for (const it of items || []) {
          allItems.push({
            platform,
            title: it.title || it.snippet || null,
            // Kept separately (not just folded into title) so commercial-
            // intent keyword detection has real text to scan even when a
            // title exists — see winnerScoring.js's detectCommercialIntent().
            snippet: it.snippet || null,
            url: it.url || it.canonical_url || null,
            thumbnail: it.thumbnail || null,
            accountName: it.accountName || it.account_name || null,
            publishedAt: it.publishedAt || it.published_at || null,
            // Real structured engagement — only YouTube's Data API provides
            // these today (see youtubeSearchProvider.js); every other
            // platform legitimately has none, so these stay null rather
            // than 0 (Winner Discovery Engine scoring treats null as
            // UNKNOWN, never as "zero engagement").
            viewCount: it.viewCount ?? null,
            likeCount: it.likeCount ?? null,
            commentCount: it.commentCount ?? null,
            // Real direct-download media URLs — only Meta Ad Library's
            // Apify path returns these (confirmed real CDN files, not
            // resized previews — see metaAdLibraryProvider.js's
            // mapApifyItem() comment). Every other path/platform has none,
            // so these stay null rather than pointing at the page URL.
            videoUrl: it.metrics?.videoUrl || null,
            imageUrl: it.metrics?.imageUrl || null,
          });
        }
        platformOk = true;
      } catch (err) {
        logger.warn(`${LOG_PREFIX} QUERY_FAILED`, { searchId, platform, query, message: err.message });
        // One query/platform failing must never fail the whole job (spec: "Do not stop the whole search").
      }
    }
    platformStatus[platform] = platformOk ? 'COMPLETE' : 'FAILED';
    await updateSearch(searchId, { platform_status_json: JSON.stringify(platformStatus) });
  }

  await updateSearch(searchId, { status: 'NORMALIZING' });

  // Real-thumbnail backfill: SerpApi's organic google results only carry a
  // `thumbnail` field for a minority of listings (live-measured: YouTube
  // 100% via its own Data API, but Instagram/Facebook/TikTok/Meta Ad
  // Library often well under half) — without this, most result cards would
  // show a placeholder icon instead of an actual product photo, which
  // defeats the point of a visual discovery feed. Backfills by reading the
  // REAL og:image/twitter:image meta tag off the item's own destination URL
  // (never fabricated) — best-effort, capped concurrency, never blocks the
  // pipeline on a slow/blocked page (see ogImageFetch.js).
  const itemsMissingThumb = allItems.filter((it) => !it.thumbnail && it.url);
  if (itemsMissingThumb.length) {
    await runWithConcurrency(itemsMissingThumb, 10, async (item) => {
      item.thumbnail = await fetchOgImage(item.url);
    });
  }

  // Cluster by exact normalized title (Phase 1 — see normalizeTitle() comment above).
  const clusters = new Map(); // normalizedTitle -> { displayName, items: [] }
  for (const item of allItems) {
    if (!item.title || !item.url) continue;
    const key = normalizeTitle(item.title);
    if (!key) continue;
    if (!clusters.has(key)) clusters.set(key, { displayName: item.title, items: [] });
    clusters.get(key).items.push(item);
  }

  await updateSearch(searchId, { status: 'SCORING' });

  // Real multi-signal Winner Score — see winnerScoring.js's own header for
  // exactly what's real vs honestly UNKNOWN per platform. Scored once across
  // all clusters together so reach/engagement/velocity can be ranked
  // relative to this search's own batch (there's no external benchmark
  // dataset to compare against).
  const clusterList = [...clusters.entries()].map(([key, c]) => ({ key, displayName: c.displayName, items: c.items }));
  let scoresByKey = new Map();
  try {
    scoresByKey = await scoreClusters(clusterList);
  } catch (err) {
    logger.error(`${LOG_PREFIX} SCORING_FAILED`, { searchId, message: err.message });
    // Scoring is an enhancement over real discovery data, not a requirement
    // for it — a scoring bug must never hide the real search results
    // themselves (every WinnerProduct row below just keeps null scores).
  }

  const rows = [];
  for (const [normalizedName, cluster] of clusters.entries()) {
    const platforms = [...new Set(cluster.items.map((i) => i.platform))];
    const adsCount = cluster.items.filter((i) => i.platform === 'META_AD_LIBRARY').length;
    const videosCount = cluster.items.filter((i) => i.platform !== 'META_AD_LIBRARY').length;
    const advertisersCount = new Set(cluster.items.filter((i) => i.platform === 'META_AD_LIBRARY' && i.accountName).map((i) => i.accountName)).size;
    const thumbnail = cluster.items.find((i) => i.thumbnail)?.thumbnail || null;
    const scored = scoresByKey.get(normalizedName);
    rows.push({
      search_id: searchId,
      category: search.category,
      display_name: cluster.displayName.slice(0, 200),
      normalized_name: normalizedName.slice(0, 200),
      thumbnail,
      platforms_json: JSON.stringify(platforms),
      videos_count: videosCount,
      ads_count: adsCount,
      advertisers_count: advertisersCount,
      raw_sources_json: JSON.stringify(cluster.items.slice(0, 30)), // evidence trail, capped for row size
      winner_score: scored?.winnerScore ?? null,
      confidence: scored?.confidence ?? null,
      trend_stage: scored?.trendStage ?? null,
      score_breakdown_json: scored?.breakdown ? JSON.stringify(scored.breakdown) : null,
    });
  }

  if (rows.length) await prisma.winnerProduct.createMany({ data: rows });

  const anySucceeded = Object.values(platformStatus).some((s) => s === 'COMPLETE');
  const anyFailed = Object.values(platformStatus).some((s) => s === 'FAILED');
  const finalStatus = !anySucceeded ? 'FAILED' : anyFailed ? 'PARTIAL' : 'COMPLETED';
  await updateSearch(searchId, {
    status: finalStatus,
    completed_at: new Date(),
    error: !anySucceeded ? 'كل المزودين فشلوا في الرد لهذا البحث.' : null,
  });
  logger.info(`${LOG_PREFIX} SEARCH_DONE`, { searchId, status: finalStatus, candidates: rows.length, rawItems: allItems.length });
}

// ---------------------------------------------------------------------------
// Saved products / watchlist
// ---------------------------------------------------------------------------
export async function saveProduct(userId, winnerProductId) {
  const product = await prisma.winnerProduct.findUnique({ where: { id: winnerProductId } });
  if (!product) { const e = new Error('المنتج غير موجود.'); e.status = 404; throw e; }
  const snapshot = {
    winner_score: product.winner_score,
    egypt_saturation: product.egypt_saturation,
    videos_count: product.videos_count,
    ads_count: product.ads_count,
    advertisers_count: product.advertisers_count,
  };
  return prisma.winnerProductSaved.upsert({
    where: { user_id_winner_product_id: { user_id: userId, winner_product_id: winnerProductId } },
    update: {},
    create: { user_id: userId, winner_product_id: winnerProductId, snapshot_json: JSON.stringify(snapshot) },
  });
}

export async function unsaveProduct(userId, winnerProductId) {
  return prisma.winnerProductSaved.deleteMany({ where: { user_id: userId, winner_product_id: winnerProductId } });
}

export async function listSaved(userId) {
  const rows = await prisma.winnerProductSaved.findMany({
    where: { user_id: userId },
    include: { winner_product: true },
    orderBy: { saved_at: 'desc' },
  });
  return rows.map((r) => ({
    ...r.winner_product,
    saved_at: r.saved_at,
    snapshot: JSON.parse(r.snapshot_json || '{}'),
  }));
}

export { getProviderStatus };
