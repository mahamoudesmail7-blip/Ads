// metaAdLibraryProvider.js — Meta Ads Library discovery. THREE real,
// compliant paths, tried in priority order, never fabricated:
//
// 1. Apify (curious_coder/facebook-ads-library-scraper) — the PRIMARY
//    commercial-ad path, manually verified working for Egypt/Active/
//    keyword search before this was built (see runStagedSearch() below
//    and apifyMetaAdLibraryProvider.js's header comment for the real,
//    verified actor input/output shape).
// 2. Official Meta Ad Library API (/ads_archive), using the SAME Meta
//    OAuth connection already built for Meta Ads sync (services/
//    metaAuth.js) — reused as-is, no new credential. Real, but Meta's own
//    documented limitation: unrestricted commercial-ad keyword search is
//    only guaranteed in EU/DSA-covered regions; for other countries
//    (Egypt included) this commonly comes back empty or error-restricted,
//    or (empirically confirmed live) ignores search_terms entirely.
// 3. SerpApi fallback (site:facebook.com/ads/library — real, indexed,
//    public Ad Library URLs), reusing the SAME SERPAPI_API_KEY already
//    configured for Instagram/Facebook/TikTok — no new credential either.
//
// getStatus() reports which path is actually usable, or ERROR if the last
// real attempt failed, or NOT_CONFIGURED if neither path exists at all —
// never a hardcoded CONNECTED.
import { logger } from '../../logger.js';
import * as metaAuth from '../metaAuth.js';
import { searchAdLibrary } from '../metaGraphClient.js';
import * as serpApiProvider from './serpApiProvider.js';
import * as apifyProvider from './apifyMetaAdLibraryProvider.js';
import { generateAdLibraryTieredQueries } from '../productResearchAI.js';
import { validateAndCanonicalize } from '../productResearchNormalize.js';
import * as health from '../providerHealth.js';

const COUNTRY_MAP = { EG: 'EG', SA: 'SA', AE: 'AE', KW: 'KW' }; // Meta's ad_reached_countries expects real ISO country codes; Worldwide has no single equivalent, so it's handled by the caller passing undefined -> Graph path skipped, SerpApi has no country restriction anyway.

let lastError = null; // module-level, session-lifetime only — same "no new infra" cache pattern as productResearchOrchestrator.js's search cache.

// Real, empirically-confirmed finding from live testing: for Egypt (and
// presumably most non-EU/DSA countries), Meta's /ads_archive endpoint does
// NOT reliably filter by search_terms for regular commercial ads — it can
// return a generic sample of ads reaching that country regardless of the
// query, which would otherwise look like real-but-irrelevant results. This
// is a plain relevance filter on already-real data (never invents
// anything) that discards a Graph API ad whose own text has zero
// overlap with the query, and signals "try the fallback" only when NONE
// of the batch survives that check — i.e. when Meta clearly ignored the
// search term entirely, not when it's just one loosely-related hit.
function hasQueryOverlap(adText, query) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (words.length === 0) return true; // nothing meaningful to check against — don't over-filter
  const haystack = adText.toLowerCase();
  return words.some((w) => haystack.includes(w));
}

async function metaConnectionUsable() {
  try {
    const connection = await metaAuth.getConnection();
    return Boolean(connection && connection.status === 'CONNECTED' && connection.access_token_enc);
  } catch {
    return false;
  }
}

/**
 * Reports the full 3-tier priority chain honestly — never a hardcoded
 * CONNECTED. `primary` is Apify (real, verified); `fallbacks` lists the
 * other two paths' real status too, so the UI can show "Primary: Apify —
 * CONNECTED / Fallback: Meta Graph — CONNECTED, SerpApi — CONNECTED"
 * rather than collapsing everything into one line.
 * @returns {Promise<{status: 'CONNECTED'|'NOT_CONFIGURED'|'ERROR', provider: string|null, detail: string|null, primary: object, fallbacks: object[]}>}
 */
export async function getStatus() {
  const apifyStatus = await apifyProvider.getStatus();
  const metaOk = await metaConnectionUsable();
  const serpOk = serpApiProvider.isConfigured();

  // Layers real recent-traffic health (Step 13/14 watchdog) onto the
  // existing configured/not check — a fallback that's configured but whose
  // last real attempt failed now reports DEGRADED instead of a blanket
  // CONNECTED, and recovers on its own the moment one more real attempt
  // succeeds (metaGraphClient/serpApiProvider record this from real usage
  // in search() below — never a synthetic paid probe).
  const fallbacks = [
    { provider: 'meta_ad_library_api', status: health.classify('meta_ad_library_api', metaOk).status },
    { provider: 'serpapi_ad_library_search', status: health.classify('serpapi_ad_library_search', serpOk).status },
  ];

  if (apifyStatus.status === 'CONNECTED') {
    return { status: 'CONNECTED', provider: 'apify_meta_ad_library', detail: null, primary: apifyStatus, fallbacks };
  }
  if (!metaOk && !serpOk) {
    // Apify not configured/erroring AND neither fallback exists either -- genuinely not usable.
    return { status: apifyStatus.status === 'ERROR' ? 'ERROR' : 'NOT_CONFIGURED', provider: null, detail: apifyStatus.detail || 'مفيش أي مصدر لـ Meta Ads Library متاح.', primary: apifyStatus, fallbacks };
  }
  if (lastError) return { status: 'ERROR', provider: lastError.provider, detail: lastError.message, primary: apifyStatus, fallbacks };
  return { status: 'CONNECTED', provider: metaOk ? 'meta_ad_library_api' : 'serpapi_ad_library_search', detail: null, primary: apifyStatus, fallbacks };
}

export async function isConfigured() {
  if (apifyProvider.isConfigured()) return true;
  return (await metaConnectionUsable()) || serpApiProvider.isConfigured();
}

/**
 * Returns {items, providerName} — providerName reflects the path that
 * ACTUALLY served this specific call, never guessed from general
 * configuration state (an earlier version inferred it from getStatus(),
 * which meant a call that fell through to SerpApi could get mislabeled as
 * having come from the real Graph API — caught via a real live test where
 * the returned ad content didn't match what the label implied, fixed here).
 * @param {{query: string, resultsLimit?: number, country?: string}} params
 * @returns {Promise<{items: object[], providerName: string}>}
 */
export async function search({ query, resultsLimit = 10, country = 'EG' }) {
  if (await metaConnectionUsable()) {
    try {
      const token = await metaAuth.getDecryptedToken();
      const isoCountry = COUNTRY_MAP[country];
      if (isoCountry) {
        const ads = await searchAdLibrary(token, { searchTerms: query, countries: [isoCountry], limit: resultsLimit });
        const relevantAds = ads.filter((ad) => hasQueryOverlap([ad.ad_creative_bodies?.[0], ad.ad_creative_link_titles?.[0], ad.ad_creative_link_descriptions?.[0], ad.page_name].filter(Boolean).join(' '), query));
        if (ads.length > 0 && relevantAds.length === 0) {
          // Meta returned real ads but ignored the search term entirely (confirmed live for Egypt commercial ads) -- fall through to SerpApi instead of surfacing a generic, unrelated sample as if it were a real match.
          logger.info('META_AD_LIBRARY_GRAPH_API_IRRELEVANT', { query, country: isoCountry, returnedCount: ads.length });
          lastError = { provider: 'meta_ad_library_api', message: `فيسبوك رجّع ${ads.length} إعلان حقيقي بس مفيهمش أي واحد له علاقة بكلمة البحث — على الأغلب الـ API مش بيفلتر بالكلمة في الدولة دي.` };
        } else {
          lastError = null;
          health.recordSuccess('meta_ad_library_api');
          const items = relevantAds.map((ad) => ({
            url: ad.ad_snapshot_url,
            title: ad.ad_creative_link_titles?.[0] || (ad.ad_creative_bodies?.[0] || '').slice(0, 80) || null,
            snippet: ad.ad_creative_bodies?.[0] || ad.ad_creative_link_descriptions?.[0] || null,
            accountName: ad.page_name || null,
            accountUrl: ad.page_id ? `https://www.facebook.com/${ad.page_id}` : null,
            thumbnail: null, // ads_archive doesn't return a direct image URL field — the snapshot page itself is the visual record, never fabricated here
            publishedAt: ad.ad_delivery_start_time || ad.ad_creation_time || null,
            metrics: {
              adId: ad.id || null,
              endDate: ad.ad_delivery_stop_time || null,
              activeStatus: ad.ad_delivery_stop_time ? 'INACTIVE' : 'ACTIVE',
              platformsShownOn: ad.publisher_platforms || [],
              cta: ad.ad_creative_link_captions?.[0] || null,
              mediaType: null, // not exposed by this field set without deeper per-ad lookup — left honestly null, never guessed
              description: ad.ad_creative_link_descriptions?.[0] || null,
              country: isoCountry,
            },
            raw: ad,
          }));
          return { items, providerName: 'meta_ad_library_api' };
        }
      }
      // No ISO mapping for this country selector value (e.g. "Worldwide") -- fall through to SerpApi below rather than guessing a country.
    } catch (err) {
      logger.error('META_AD_LIBRARY_GRAPH_API_FAILED', { provider: 'meta_ad_library_api', query, message: err.message, graphCode: err.graphCode, graphSubcode: err.graphSubcode });
      lastError = { provider: 'meta_ad_library_api', message: err.message };
      health.recordError('meta_ad_library_api', health.classifyErrorType(err));
      // Real, documented Meta limitation for non-EU commercial search -- fall through to the SerpApi path instead of failing the whole platform.
    }
  }

  if (!serpApiProvider.isConfigured()) {
    throw new Error('Meta Ads Library غير مربوط — محتاج حساب Meta متصل (ads_read) أو SERPAPI_API_KEY.');
  }
  try {
    const items = await serpApiProvider.searchAdLibrary({ query, resultsLimit });
    lastError = null;
    health.recordSuccess('serpapi_ad_library_search');
    return { items, providerName: 'serpapi_ad_library_search' };
  } catch (err) {
    lastError = { provider: 'serpapi_ad_library_search', message: err.message };
    health.recordError('serpapi_ad_library_search', health.classifyErrorType(err));
    throw err;
  }
}

/**
 * Maps one real Apify dataset item to normalizeResult()'s expected raw
 * shape. Field names confirmed by directly inspecting real saved dataset
 * items (raw_metadata_json) from a live Test A run against the production
 * DB — NOT from the Apify Store's display labels, which use different
 * casing/nesting than the actor's actual JSON output. Real shape: snake_case
 * top-level keys (ad_archive_id, page_id, page_name, is_active,
 * publisher_platform (singular key, array value), start_date/end_date as
 * Unix SECONDS, ad_library_url as the real per-ad link) plus a nested
 * `snapshot` object holding the actual creative (snapshot.body.text,
 * snapshot.cta_text, snapshot.cta_type, snapshot.link_url,
 * snapshot.link_description, snapshot.images[].original_image_url). Any
 * field genuinely absent stays null, never guessed (per explicit
 * instruction: adText/creative bodies can legitimately be null).
 */
function mapApifyItem(item) {
  // Real field names confirmed by inspecting actual scraped output (the
  // Apify Store's display names — "Ad Archive ID", "Is Active" etc. — are
  // NOT the real JSON keys; the actor's real output is snake_case with a
  // nested `snapshot` object holding the actual creative). An earlier
  // version guessed camelCase keys from the display names and from an
  // incomplete manual description, which silently produced null/1970-date
  // results — caught via a real live test, fixed here against the actual
  // raw JSON.
  const snap = item.snapshot || {};
  const adText = snap.body?.text ?? null;
  const toDate = (unixSeconds) => (typeof unixSeconds === 'number' ? new Date(unixSeconds * 1000).toISOString() : null); // real field is Unix SECONDS, not ms

  return {
    url: item.ad_library_url || null, // the real per-ad snapshot link (item.url is the generic search-results page, not per-ad)
    title: snap.title || item.page_name || null,
    snippet: adText,
    accountName: item.page_name || null,
    accountUrl: item.page_id ? `https://www.facebook.com/${item.page_id}` : (snap.page_profile_uri || null),
    thumbnail: snap.images?.[0]?.original_image_url || snap.videos?.[0]?.video_preview_image_url || null,
    publishedAt: toDate(item.start_date),
    metrics: {
      adId: item.ad_archive_id || null,
      endDate: toDate(item.end_date),
      activeStatus: item.is_active === true ? 'ACTIVE' : (item.is_active === false ? 'INACTIVE' : null),
      platformsShownOn: Array.isArray(item.publisher_platform) ? item.publisher_platform : [],
      cta: snap.cta_text || null,
      ctaType: snap.cta_type || null,
      mediaType: snap.display_format || (snap.videos?.length ? 'video' : snap.images?.length ? 'image' : null),
      description: snap.link_description || null,
      country: null,
      ctaDomain: snap.link_url || null,
      currency: item.currency || null,
      estimatedAudienceSize: item.reach_estimate || null,
      impressions: null,
    },
    raw: item,
  };
}

const DEFAULT_MAX_RAW_RESULTS = 500;

/**
 * Staged discovery (Steps 2/5 of the request): tries HIGH_PRECISION
 * queries first via Apify (one batched run, all high-tier terms in a
 * single `urls` array — one actor charge, not one per term); only runs
 * MEDIUM_PRECISION if that didn't reach the raw limit yet; only then
 * BROAD_DISCOVERY. Stops as soon as the (cost-capped) raw limit is met.
 * Returns raw per-tier results — normalization/dedup/persistence stays
 * the orchestrator's job, same as every other platform.
 * @param {{profile: object, country: string, activeOnly: boolean, mode: 'quick'|'deep', rawLimit: number}} params
 * @returns {Promise<{tiers: {tier: string, queries: string[], rawCount: number, provider: string, error: string|null}[], allRawItems: object[], providerLimitReached: boolean}>}
 */
export async function runStagedSearch({ profile, country, activeOnly, mode, rawLimit }) {
  if (!apifyProvider.isConfigured()) return null; // signals the caller to fall back to the generic per-query loop (Graph API / SerpApi via search())

  const hardCap = Number(process.env.APIFY_AD_LIBRARY_MAX_RAW_RESULTS_PER_SEARCH) || DEFAULT_MAX_RAW_RESULTS;
  const effectiveLimit = Math.min(Number(rawLimit) || 100, hardCap);
  const { high, medium, broad } = generateAdLibraryTieredQueries(profile);
  const tiersToTry = [
    { name: 'HIGH_PRECISION', queries: high },
    { name: 'MEDIUM_PRECISION', queries: medium },
    { name: 'BROAD_DISCOVERY', queries: broad },
  ].filter((t) => t.queries.length > 0);

  const tiers = [];
  const allRawItems = [];
  const seenCanonical = new Set(); // in-memory running uniqueness count to decide when to stop staging — real DB dedup still happens once in the orchestrator afterward

  for (const tier of tiersToTry) {
    const remaining = effectiveLimit - allRawItems.length;
    if (remaining <= 0) break;

    const runner = mode === 'deep' ? apifyProvider.runDeep : apifyProvider.runQuick;
    try {
      const rawItems = await runner({ queries: tier.queries, country, activeOnly, rawLimit: Math.min(remaining, effectiveLimit) });
      const mapped = rawItems.map((raw) => ({ ...mapApifyItem(raw), _sourceQueries: tier.queries }));
      tiers.push({ tier: tier.name, queries: tier.queries, rawCount: mapped.length, provider: 'apify_meta_ad_library', error: null });
      allRawItems.push(...mapped);

      for (const m of mapped) {
        const canonical = m.url ? validateAndCanonicalize(m.url, 'META_AD_LIBRARY') : null;
        if (canonical) seenCanonical.add(canonical.toString());
      }
      lastError = null;
      health.recordSuccess('apify_meta_ad_library');
    } catch (err) {
      logger.error('APIFY_META_AD_LIBRARY_STAGE_FAILED', { provider: 'apify_meta_ad_library', tier: tier.name, mode, message: err.message });
      tiers.push({ tier: tier.name, queries: tier.queries, rawCount: 0, provider: 'apify_meta_ad_library', error: err.message });
      lastError = { provider: 'apify_meta_ad_library', message: err.message };
      health.recordError('apify_meta_ad_library', health.classifyErrorType(err));
      // One tier failing doesn't stop the next tier from being tried — real per-stage isolation, same principle as per-platform isolation elsewhere.
    }

    if (seenCanonical.size >= effectiveLimit) break; // enough unique ads already — Step 5's "don't keep spending money" rule
  }

  const providerLimitReached = allRawItems.length >= effectiveLimit;
  return { tiers, allRawItems, providerLimitReached, effectiveLimit };
}
