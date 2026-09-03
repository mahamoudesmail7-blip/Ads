// googleSearchProvider.js — real Google Programmable Search Engine (Custom
// Search JSON API) integration. This is the real, honest way this system
// discovers Instagram/Facebook/TikTok (and optionally YouTube) content: no
// official platform API lets a third-party app search arbitrary public
// posts across those platforms, but Google indexes and returns real public
// URLs from them via `site:` filtered queries — the same technique real
// competitor-research tools use. Never fabricates a result; every URL
// returned here came from a real Google API response.
import { logger } from '../../logger.js';

const ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

// --- Conclusively verified unavailable for this Google Cloud project
// (real production evidence, not guessed) ---
// Real live requests kept returning 403 PERMISSION_DENIED / reason
// "forbidden" / "This project does not have the access to Custom Search
// JSON API." AFTER every configuration angle was independently confirmed
// correct: Custom Search API enabled on the right project, correct API
// key, key's API restrictions set to Custom Search API specifically,
// application restrictions set to None, correct Search Engine ID (cx),
// and daily quota available (100/day, not exhausted). With every
// credential/config dimension eliminated, the remaining explanation is
// that this Google Cloud project itself does not have real access to the
// API (a project-level entitlement, not something a key/cx change can
// fix) — Google's Custom Search JSON API is known to be withheld from
// some projects/regions/account types outside of the documented
// enable/key/quota flow entirely.
//
// This flag stops every real network call this file would otherwise make
// (see the short-circuit in callGoogle() below) so nothing keeps spending
// the limited daily quota against a request that has already failed
// identically, byte-for-byte, on repeat real attempts. Flip this back to
// `false` only after a real, deliberate reason to re-test (e.g. Google
// support confirms access was granted) — never as a guess.
const UNSUPPORTED_FOR_NEW_PROJECT = true;
const UNSUPPORTED_REASON = {
  httpStatus: 403,
  googleErrorCode: 403,
  googleErrorStatus: 'PERMISSION_DENIED',
  googleErrorReason: 'forbidden',
  googleErrorMessage: 'This project does not have the access to Custom Search JSON API.',
};

const SITE_FILTER = {
  instagram: 'site:instagram.com',
  facebook: 'site:facebook.com',
  tiktok: 'site:tiktok.com',
  youtube: 'site:youtube.com',
};

export function isConfigured() {
  return Boolean(process.env.GOOGLE_SEARCH_API_KEY?.trim() && process.env.GOOGLE_SEARCH_ENGINE_ID?.trim());
}

/**
 * Classifies a real thrown error from this file into one of the specific
 * reasons Google's Custom Search API actually reports — never a generic
 * "unknown error" (the exact gap the frontend was showing). Based on
 * Google's real, documented error shape (error.status, error.errors[]
 * .reason, error.message patterns) — every branch here maps a genuinely
 * distinct Google failure mode, not a guess.
 * @param {Error} err an error thrown by search()/searchImages()/searchAdLibrary()/testConnection()
 */
export function classifyGoogleErrorType(err) {
  if (err?.googleErrorReason === 'NOT_CONFIGURED') return 'NOT_CONFIGURED';
  if (err?.googleErrorReason === 'NETWORK_ERROR') return 'NETWORK_ERROR';
  if (err?.googleErrorReason === 'UNSUPPORTED_FOR_NEW_PROJECT') return 'UNSUPPORTED_FOR_NEW_PROJECT';
  // Message-text fallback for the DB-reclassification path (only
  // err.message survives into ExperimentalCreativeQuery.error) — matches
  // this exact, real, conclusively-verified wording so a stored old error
  // still reclassifies correctly on later reads.
  if (/does not have the access to custom search json api/i.test(err?.googleErrorMessage || err?.message || '')) return 'UNSUPPORTED_FOR_NEW_PROJECT';
  const reason = (err?.googleErrorReason || '').toLowerCase();
  const status = err?.googleErrorStatus || '';
  const message = (err?.googleErrorMessage || err?.message || '').toLowerCase();

  if (reason === 'keyinvalid' || /api key not valid/.test(message)) return 'AUTH_FAILED';
  if (reason === 'ipreferrerblocked' || reason === 'forbidden' || /referer|http referrer/.test(message)) return 'API_KEY_RESTRICTED';
  if (reason === 'accessnotconfigured' || status === 'PERMISSION_DENIED' || /has not been used in project|is disabled|enable it by visiting/.test(message)) return 'API_NOT_ENABLED';
  if (/invalid value.*cx|invalid.*search engine id|unknown search engine/.test(message)) return 'INVALID_ENGINE_ID';
  if (reason === 'dailylimitexceeded' || reason === 'quotaexceeded' || reason === 'resource_exhausted' || status === 'RESOURCE_EXHAUSTED' || /daily limit exceeded|quota exceeded/.test(message)) return 'QUOTA_EXHAUSTED';
  if (reason === 'ratelimitexceeded' || reason === 'userratelimitexceeded' || err?.httpStatus === 429 || /rate limit exceeded/.test(message)) return 'RATE_LIMITED';
  if (/billing|payment/.test(message)) return 'BILLING_REQUIRED';
  if (/image search|searchtype/.test(message)) return 'IMAGE_SEARCH_DISABLED';
  if (/not configured to search|siterestrict|refinelabels/.test(message)) return 'SEARCH_SCOPE_LIMITED';
  // "Request contains an invalid argument." is Google's real, generic
  // wording for this class of failure (confirmed live against this
  // project's own key/cx) — it carries no field name, but reason
  // "badRequest"/status INVALID_ARGUMENT (when available) or this exact
  // message text (when only the stored string survives, e.g. reclassified
  // from ExperimentalCreativeQuery.error) both mean the request itself was
  // rejected before Google even tried to search — most commonly a
  // malformed `cx`. Kept as INVALID_REQUEST (not asserted as INVALID_CX)
  // since the generic message alone can't distinguish that from a
  // malformed `key` with the same symptom.
  if (reason === 'badrequest' || status === 'INVALID_ARGUMENT' || /request contains an invalid argument/.test(message)) return 'INVALID_REQUEST';
  return 'GOOGLE_API_ERROR';
}

const GOOGLE_ERROR_LABEL_AR = {
  NOT_CONFIGURED: 'المفتاح أو معرّف محرك البحث غير مضبوطين',
  NETWORK_ERROR: 'تعذر الاتصال بجوجل (مشكلة شبكة مؤقتة)',
  AUTH_FAILED: 'مفتاح API غير صحيح',
  API_KEY_RESTRICTED: 'مفتاح API مقيّد بشكل يمنع هذا الطلب',
  API_NOT_ENABLED: 'خدمة Custom Search API غير مفعّلة على المشروع',
  INVALID_ENGINE_ID: 'معرّف محرك البحث (cx) غير صحيح',
  QUOTA_EXHAUSTED: 'انتهت حصة البحث اليومية لدى جوجل',
  RATE_LIMITED: 'تم تجاوز حد الطلبات المؤقت',
  BILLING_REQUIRED: 'الفوترة مطلوبة على مشروع جوجل',
  INVALID_REQUEST: 'طلب غير صحيح لجوجل',
  IMAGE_SEARCH_DISABLED: 'البحث بالصور غير مفعّل على محرك البحث ده',
  SEARCH_SCOPE_LIMITED: 'محرك البحث محدود بنطاق مواقع معيّن، مش الويب كله',
  UNSUPPORTED_FOR_NEW_PROJECT: 'Google Custom Search JSON API غير متاح لمشروع جوجل ده — تم التأكد الحي إن كل الإعدادات صحيحة (المفتاح، صلاحياته، معرّف محرك البحث، الكوتة) وبرضو جوجل بترفض بنفس الخطأ',
  GOOGLE_API_ERROR: 'خطأ من واجهة جوجل',
};

/** Real, honest Arabic label for the classified reason — never a generic "unknown error". */
export function googleErrorLabelAr(reasonType) {
  return GOOGLE_ERROR_LABEL_AR[reasonType] || GOOGLE_ERROR_LABEL_AR.GOOGLE_API_ERROR;
}

/**
 * Real Google API error shape: {error:{code, message, status, errors:[{reason, domain, message}]}}.
 * Every field captured here is attached to the thrown Error (never just
 * the human-readable message) so callers can honestly classify WHY a
 * request failed instead of falling through to "unknown error" — the
 * exact gap that made the frontend show "خطأ غير معروف" for a real,
 * specific Google failure.
 */
function buildGoogleError(res, data, context) {
  const g = data?.error || {};
  const reason = g.errors?.[0]?.reason || null;
  const message = g.message || `Google Search API error ${res.status}`;
  logger.error('GOOGLE_SEARCH_PROVIDER_FAILED', { httpStatus: res.status, googleCode: g.code ?? res.status, googleStatus: g.status || null, googleReason: reason, message, ...context });
  const err = new Error(message);
  err.httpStatus = res.status;
  err.googleErrorCode = g.code ?? res.status;
  err.googleErrorStatus = g.status || null; // e.g. "INVALID_ARGUMENT" | "PERMISSION_DENIED" | "RESOURCE_EXHAUSTED"
  err.googleErrorReason = reason; // e.g. "badRequest" | "keyInvalid" | "dailyLimitExceeded" | "quotaExceeded"
  err.googleErrorMessage = message;
  // Full raw error body (never contains the API key/cx — those are
  // request params, not response fields) — kept only for diagnostics so a
  // vague top-level message like "Request contains an invalid argument"
  // can still be root-caused from Google's own field_violations/details,
  // without ever guessing.
  err.googleErrorRaw = g;
  return err;
}

async function callGoogle(params, context) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY?.trim();
  const engineId = process.env.GOOGLE_SEARCH_ENGINE_ID?.trim();
  if (!apiKey || !engineId) {
    const err = new Error('Google Search Provider غير مربوط — GOOGLE_SEARCH_API_KEY أو GOOGLE_SEARCH_ENGINE_ID مش متظبطين.');
    err.googleErrorReason = 'NOT_CONFIGURED';
    throw err;
  }

  // Single choke point: every real network call this file can make goes
  // through here, so gating it here (not per-caller) is what actually
  // "stops automatic requests to Google" everywhere at once — no live
  // HTTP request is made at all once this is set, so no quota is spent
  // re-confirming an already conclusively-verified real failure.
  if (UNSUPPORTED_FOR_NEW_PROJECT) {
    const err = new Error(UNSUPPORTED_REASON.googleErrorMessage);
    err.httpStatus = UNSUPPORTED_REASON.httpStatus;
    err.googleErrorCode = UNSUPPORTED_REASON.googleErrorCode;
    err.googleErrorStatus = UNSUPPORTED_REASON.googleErrorStatus;
    err.googleErrorReason = 'UNSUPPORTED_FOR_NEW_PROJECT';
    err.googleErrorMessage = UNSUPPORTED_REASON.googleErrorMessage;
    err.googleErrorRaw = { code: UNSUPPORTED_REASON.googleErrorCode, message: UNSUPPORTED_REASON.googleErrorMessage, status: UNSUPPORTED_REASON.googleErrorStatus, errors: [{ message: UNSUPPORTED_REASON.googleErrorMessage, domain: 'global', reason: 'forbidden' }] };
    throw err;
  }

  const url = new URL(ENDPOINT);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('cx', engineId);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    const wrapped = new Error(`مقدرش أوصل لـ Google Search API: ${err.message}`);
    wrapped.googleErrorReason = 'NETWORK_ERROR';
    throw wrapped;
  }
  const latencyMs = Date.now() - startedAt;
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) throw buildGoogleError(res, data, context);
  return { data, latencyMs, cxAccepted: true }; // reaching here at all means the API key authenticated AND cx was accepted by Google — a request-shape/auth rejection would have thrown above
}

/**
 * @param {{query: string, platform: string, resultsLimit?: number}} params
 * @returns {Promise<object[]>} raw Google items (normalized by the caller — see productResearchNormalize.js)
 */
export async function search({ query, platform, resultsLimit = 10 }) {
  const siteFilter = SITE_FILTER[platform];
  const fullQuery = siteFilter ? `${siteFilter} ${query}` : query;
  const { data } = await callGoogle({ q: fullQuery, num: Math.min(10, resultsLimit) }, { platform, query: fullQuery }); // Google Custom Search caps at 10 per request

  return (data.items || []).map((item) => ({
    url: item.link,
    title: item.title,
    snippet: item.snippet,
    thumbnail: item.pagemap?.cse_thumbnail?.[0]?.src || item.pagemap?.cse_image?.[0]?.src || null,
    raw: item,
  }));
}

/**
 * Real Google Custom Search Image search (searchType=image) — Step 5/6:
 * the basis for future local visual matching (candidateMedia), collected
 * honestly here without performing any matching itself. Every returned
 * field is exactly what Google's own response contains; fields Google
 * doesn't return for a given item stay null, never fabricated.
 * @param {{query: string, resultsLimit?: number}} params
 * @returns {Promise<object[]>}
 */
export async function searchImages({ query, resultsLimit = 10 }) {
  const { data } = await callGoogle({ q: query, searchType: 'image', num: Math.min(10, resultsLimit) }, { query, searchType: 'image' });
  return (data.items || []).map((item) => ({
    imageUrl: item.link || null,
    thumbnailUrl: item.image?.thumbnailLink || null,
    contextUrl: item.image?.contextLink || null, // the real source page the image was found on
    title: item.title || null,
    displayLink: item.displayLink || null,
    mimeType: item.mime || null,
    width: item.image?.width ?? null,
    height: item.image?.height ?? null,
    thumbnailWidth: item.image?.thumbnailWidth ?? null,
    thumbnailHeight: item.image?.thumbnailHeight ?? null,
    raw: item,
  }));
}

/**
 * Fallback path for Meta Ads Library when the official Graph API's
 * commercial-ad search isn't available for the target country (see
 * metaAdLibraryProvider.js's header comment) — real, indexed, public
 * facebook.com/ads/library URLs via the same Google engine, never
 * fabricated. Coverage is inherently thinner than the official API since
 * Ad Library detail pages are JS-rendered and less exhaustively indexed —
 * disclosed honestly, not hidden.
 * @param {{query: string, resultsLimit?: number}} params
 */
export async function searchAdLibrary({ query, resultsLimit = 10 }) {
  const { data } = await callGoogle({ q: `site:facebook.com/ads/library ${query}`, num: Math.min(10, resultsLimit) }, { platform: 'META_AD_LIBRARY', query });
  return (data.items || []).map((item) => ({
    url: item.link,
    title: item.title,
    snippet: item.snippet,
    thumbnail: item.pagemap?.cse_thumbnail?.[0]?.src || item.pagemap?.cse_image?.[0]?.src || null,
    accountName: null,
    publishedAt: null,
    metrics: { adId: null, endDate: null, activeStatus: null, platformsShownOn: [], cta: null, mediaType: null, description: null, country: null },
    raw: item,
  }));
}

/**
 * One real, cheap (num=1, text search — never billed as an image/heavy
 * request) Google Custom Search call, used ONLY to verify the
 * credentials+engine actually work — never to run a real product search.
 * Returns real, structured diagnostics: never guesses whether the API key
 * or engine id are valid, only reports what Google's own response said
 * (Step: provider health, "HEALTHY means a recent real successful
 * request", never "credentials are merely present").
 * @returns {Promise<{ok: boolean, httpStatus: number|null, googleErrorCode: number|null, googleErrorStatus: string|null, googleErrorReason: string|null, googleErrorMessage: string|null, latencyMs: number|null, resultCount: number|null, searchInformation: object|null}>}
 */
// Real, cached health check (Step 8) — same convention as
// apifyMetaAdLibraryProvider.js's statusCache: a real Custom Search call
// happened, cached briefly so a provider-status page load never
// re-spends Google quota on every view. CONFIGURED (creds present) is
// deliberately NOT treated as HEALTHY on its own — this cache only ever
// reports HEALTHY after a real request actually succeeded.
let statusCache = null; // {result, at}
const STATUS_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * @returns {Promise<{status: 'NOT_CONFIGURED'|'HEALTHY'|'ERROR'|'QUOTA_EXHAUSTED'|'UNSUPPORTED_FOR_NEW_PROJECT', reasonType: string|null, reasonLabelAr: string|null, lastCheckedAt: string, latencyMs: number|null}>}
 */
export async function getHealthStatus({ force = false } = {}) {
  if (!isConfigured()) return { status: 'NOT_CONFIGURED', reasonType: null, reasonLabelAr: null, lastCheckedAt: new Date().toISOString(), latencyMs: null };
  // Never CONNECTED/HEALTHY just because credentials exist, and never
  // spends a real request re-confirming a conclusively-verified failure
  // (Step 3 of the Google fix-up request) — reported directly, no
  // testConnection() call at all.
  if (UNSUPPORTED_FOR_NEW_PROJECT) {
    return { status: 'UNSUPPORTED_FOR_NEW_PROJECT', reasonType: 'UNSUPPORTED_FOR_NEW_PROJECT', reasonLabelAr: googleErrorLabelAr('UNSUPPORTED_FOR_NEW_PROJECT'), lastCheckedAt: new Date().toISOString(), latencyMs: null };
  }
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_CACHE_TTL_MS) return statusCache.result;

  const check = await testConnection('test');
  let result;
  if (check.ok) {
    result = { status: 'HEALTHY', reasonType: null, reasonLabelAr: null, lastCheckedAt: new Date().toISOString(), latencyMs: check.latencyMs };
  } else {
    const reasonType = classifyGoogleErrorType({ googleErrorReason: check.googleErrorReason, googleErrorStatus: check.googleErrorStatus, googleErrorMessage: check.googleErrorMessage, httpStatus: check.httpStatus });
    result = { status: reasonType === 'QUOTA_EXHAUSTED' ? 'QUOTA_EXHAUSTED' : 'ERROR', reasonType, reasonLabelAr: googleErrorLabelAr(reasonType), lastCheckedAt: new Date().toISOString(), latencyMs: null };
  }
  statusCache = { result, at: Date.now() };
  return result;
}

export async function testConnection(query = 'test') {
  try {
    const { data, latencyMs } = await callGoogle({ q: query, num: 1 }, { diagnostic: true });
    return {
      ok: true,
      httpStatus: 200,
      googleErrorCode: null, googleErrorStatus: null, googleErrorReason: null, googleErrorMessage: null,
      latencyMs,
      resultCount: (data.items || []).length,
      searchInformation: data.searchInformation ? { totalResults: data.searchInformation.totalResults, searchTime: data.searchInformation.searchTime } : null,
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: err.httpStatus ?? null,
      googleErrorCode: err.googleErrorCode ?? null,
      googleErrorStatus: err.googleErrorStatus ?? null,
      googleErrorReason: err.googleErrorReason ?? null,
      googleErrorMessage: err.googleErrorMessage || err.message,
      googleErrorRaw: err.googleErrorRaw ?? null,
      latencyMs: null,
      resultCount: null,
      searchInformation: null,
    };
  }
}
