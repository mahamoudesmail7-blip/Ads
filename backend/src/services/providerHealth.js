// providerHealth.js — lightweight in-memory watchdog/health tracker
// (Steps 13/14). No new DB table: health state is inherently transient
// diagnostic data, same "no new infra" convention already used for this
// app's other in-memory caches (productResearchOrchestrator.js's
// searchCache, apifyMetaAdLibraryProvider.js's statusCache) — it resets on
// process restart, which is fine, since Railway restarts always come with
// a fresh health picture anyway rather than a stale one.
//
// This module never makes a network call by itself. Every recordSuccess/
// recordError call here piggybacks on a real request the app was already
// making for a real user action (a real search, a real AI ranking call),
// or — for providers with a genuinely free metadata endpoint (Apify) — a
// deliberately cheap, non-billable check. It exists purely to answer "is
// this provider currently healthy" from real, recent traffic, never from a
// synthetic probe that would itself cost money or hit a rate limit.
const state = new Map(); // provider -> {lastCheckedAt, lastSuccessfulRequestAt, lastErrorAt, lastErrorType, latencyMs}

function record(provider) {
  if (!state.has(provider)) {
    state.set(provider, { lastCheckedAt: null, lastSuccessfulRequestAt: null, lastErrorAt: null, lastErrorType: null, latencyMs: null });
  }
  return state.get(provider);
}

export function recordSuccess(provider, latencyMs = null) {
  const s = record(provider);
  const now = new Date();
  s.lastCheckedAt = now;
  s.lastSuccessfulRequestAt = now;
  s.latencyMs = latencyMs;
  s.lastErrorType = null; // a real success clears a prior error -- the whole point of "self-healing" (Step 14): no manual redeploy needed for a transient failure to clear.
}

export function recordError(provider, errorType, latencyMs = null) {
  const s = record(provider);
  const now = new Date();
  s.lastCheckedAt = now;
  s.lastErrorAt = now;
  s.lastErrorType = errorType;
  if (latencyMs !== null) s.latencyMs = latencyMs;
}

/**
 * Combines tracked recent-activity with a configured/not flag into one of
 * CONNECTED|DEGRADED|NOT_CONFIGURED|ERROR — never hardcoded.
 * - NOT_CONFIGURED: no credential at all.
 * - CONNECTED: configured, and either never yet exercised or its most
 *   recent real attempt succeeded.
 * - DEGRADED: configured, most recent real attempt failed, but it HAS
 *   worked before (a real regression, self-heals the moment one more real
 *   request succeeds — no redeploy needed).
 * - ERROR: configured, most recent attempt failed, and it has never
 *   succeeded (or its only past success is stale/unknown) — a harder
 *   signal than a transient blip.
 * @returns {{status: string, lastCheckedAt: Date|null, lastSuccessfulRequestAt: Date|null, lastErrorAt: Date|null, lastErrorType: string|null, latencyMs: number|null}}
 */
export function classify(provider, isConfigured) {
  const s = record(provider);
  if (!isConfigured) return { status: 'NOT_CONFIGURED', ...s };
  if (!s.lastErrorType) return { status: 'CONNECTED', ...s };
  return { status: s.lastSuccessfulRequestAt ? 'DEGRADED' : 'ERROR', ...s };
}

// Real, confirmed-live message patterns for quota/credit exhaustion —
// found via a real production incident (SerpApi + YouTube Data API both
// ran out of quota simultaneously, misread as a code regression until the
// actual stored Query.error text was inspected). Neither provider signals
// this with a status code alone: SerpApi returns quota exhaustion as a 200
// OK with an error field in the body (no 4xx at all), and YouTube's 403
// is shared between "quota exceeded" and "invalid API key" — status code
// alone can't tell them apart, so the message text is checked first and is
// the authoritative signal here, not a fallback.
const QUOTA_PATTERN = /run\s*out\s*of\s*searches|quota\s*exceeded|quotaexceeded|dailylimitexceeded|rate\s*limit\s*exceeded/i;

/** Categorizes a thrown error into a bounded, log-safe type — used both for health tracking and for deciding whether a retry is worth attempting (services/ai.js). Never includes the raw error message here (that's logged separately, already scrubbed of secrets at the call site). */
export function classifyErrorType(err) {
  const status = err?.httpStatus || err?.status;
  const message = err?.message || '';
  // Checked first, ahead of status-code mapping: a 403 can mean "quota
  // exceeded" (temporary, resets on its own) just as easily as "invalid
  // key" (permanent) -- and SerpApi's quota error carries no error status
  // at all. Getting this wrong previously classified a real, resettable
  // quota exhaustion as a permanent INVALID_CREDENTIALS/UNKNOWN failure.
  if (QUOTA_PATTERN.test(message)) return 'QUOTA_EXCEEDED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401 || status === 403) return 'INVALID_CREDENTIALS';
  if (status === 402 || /insufficient.?credit|billing/i.test(message)) return 'INSUFFICIENT_CREDITS';
  if (status >= 400 && status < 500) return 'VALIDATION_ERROR';
  if (status >= 500) return 'SERVER_ERROR';
  if (err?.name === 'AbortError' || /timeout/i.test(message)) return 'TIMEOUT';
  if (/network|fetch|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(message)) return 'NETWORK_ERROR';
  return 'UNKNOWN_ERROR';
}

/** Whether an error type is worth a bounded retry (Step 15) — transient only, never a permanent/config-level failure. QUOTA_EXCEEDED is deliberately NOT retried here: a daily/monthly quota doesn't recover within this request's retry window (seconds), so retrying just burns time without changing the outcome -- it recovers on the provider's own schedule (YouTube resets daily at midnight Pacific; SerpApi resets on the account's billing cycle). */
export function isRetryable(errorType) {
  return ['TIMEOUT', 'NETWORK_ERROR', 'RATE_LIMITED', 'SERVER_ERROR'].includes(errorType);
}
