// Campaign Launch Builder — centralized error classification + recovery
// policy ("the Error Playbook Registry"). Every error the publish engine
// can encounter (Meta Graph API, our own network layer, Prisma/DB, our own
// validation) is classified HERE, once, into one of ERROR_CLASSES, and the
// classification alone decides what happens next — bounded auto-retry,
// stop-and-wait-for-human, or a real terminal failure. New failure modes
// (the next "C8 thumbnail" surprise) are handled by adding one entry to
// PLAYBOOK below, never by scattering a new special case through
// launchPublish.js.
//
// Inputs are real, structured signals — never string-guessing beyond what
// Meta/Prisma/Node themselves document:
//   - Meta Graph errors: err.graphCode / err.graphSubcode / err.graphType /
//     err.isMetaRateLimit / err.graphStatus (all attached by
//     metaGraphClient.js's throwGraphOAuthError — real Meta diagnostic
//     fields, documented at developers.facebook.com/docs/graph-api/guides/
//     error-handling, never secrets).
//   - Our own explicit flags: err.transient (thrown by ensureCreative for
//     "video still processing"), err.status (thrown by fail()/validation).
//   - Node network errors: err.code (ECONNRESET/ETIMEDOUT/ENOTFOUND/…) or
//     err.name === 'AbortError'/'FetchError'.
//   - Prisma errors: err.code matching Prisma's own P1xxx (connection) /
//     P2024 (pool timeout) family — documented at prisma.io/docs.
//
// Never logs/returns a token, secret, or customer PII — only Meta's own
// public diagnostic identifiers (code/subcode/type/fbtrace_id) and our own
// object identifiers (campaign/job ids, Meta object ids).

export const ERROR_CLASSES = Object.freeze({
  TRANSIENT_RETRYABLE: 'TRANSIENT_RETRYABLE',
  PROCESSING_WAIT: 'PROCESSING_WAIT',
  RATE_LIMITED: 'RATE_LIMITED',
  AUTH_REFRESH_REQUIRED: 'AUTH_REFRESH_REQUIRED',
  CONFIGURATION_REQUIRED: 'CONFIGURATION_REQUIRED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  PERMISSION_ERROR: 'PERMISSION_ERROR',
  DUPLICATE_OR_ALREADY_CREATED: 'DUPLICATE_OR_ALREADY_CREATED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  DATABASE_TRANSIENT: 'DATABASE_TRANSIENT',
  TERMINAL: 'TERMINAL',
});

// Real, documented Meta Graph API OAuth/permission/validation codes — never
// invented. code 190 = OAuthException (expired/invalid/revoked token).
// code 200/10/294/3921 family = missing permission on the token/asset.
// code 100 = invalid parameter (a real validation problem with our payload
// or a business object we referenced, e.g. a deleted Page/Pixel).
const META_AUTH_CODES = new Set([190]);
const META_PERMISSION_CODES = new Set([200, 10, 294, 3921]);
const META_VALIDATION_CODES = new Set([100, 2635]);
// Real subcodes seen for "this business object can't be used" (disabled ad
// account, unpublished Page, deleted Pixel) — distinct from a pure
// permission problem: the user must pick/fix a different object, we can't.
const META_CONFIG_SUBCODES = new Set([1487390, 1487056, 1815857, 2446381, 1885299]);

function isMetaRateLimited(err) {
  if (err.isMetaRateLimit) return true;
  return [4, 17, 32, 613, 80004].includes(Number(err.graphCode)) || /request limit reached|rate limit|too many calls/i.test(err.message || '');
}
function isNetworkError(err) {
  const code = err.code || err.cause?.code;
  return ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)
    || err.name === 'AbortError'
    || /fetch failed|network|socket hang up/i.test(err.message || '');
}
function isDatabaseTransient(err) {
  // Prisma connection/pool-timeout family (P1000-P1999 connection errors, P2024 pool timeout,
  // P2028 transaction API error) — genuinely transient infra, never a data/logic problem.
  return typeof err.code === 'string' && (/^P10\d\d$/.test(err.code) || ['P2024', 'P2028', 'P2034'].includes(err.code));
}
function isMetaProviderError(err) {
  return Number(err.graphStatus) >= 500 || /temporarily unavailable|internal error|try again/i.test(err.message || '');
}

/**
 * Classifies one error into { classification, retryable, maxRetries,
 * backoffPolicy, humanActionRequired, arabicMessage, code, subcode }.
 * Pure function — no I/O, fully unit-testable against synthetic errors.
 */
export function classifyError(err) {
  const code = err.graphCode ?? null;
  const subcode = err.graphSubcode ?? null;
  const base = { code, subcode, graphType: err.graphType ?? null, fbtraceId: err.fbtraceId ?? null };

  // 1. Our own explicit "still processing" signal (ensureCreative) — always wins first.
  if (err.transient) {
    return { ...base, classification: ERROR_CLASSES.PROCESSING_WAIT, retryable: true, maxRetries: 20, humanActionRequired: false, arabicMessage: err.message };
  }

  // 2. Auth — never endlessly retried; needs a human to re-connect Meta.
  if (err.graphType === 'OAuthException' || META_AUTH_CODES.has(Number(code))) {
    return { ...base, classification: ERROR_CLASSES.AUTH_REFRESH_REQUIRED, retryable: false, maxRetries: 0, humanActionRequired: true, arabicMessage: 'اتصال Meta يحتاج إعادة ربط — التوكن منتهي أو اتلغى. اربط حساب Meta Ads تاني ثم استأنف النشر.' };
  }

  // 3. Rate limiting — real, bounded, respects Meta's own signal.
  if (isMetaRateLimited(err)) {
    return { ...base, classification: ERROR_CLASSES.RATE_LIMITED, retryable: true, maxRetries: 30, humanActionRequired: false, arabicMessage: 'Meta وصلت لحد الطلبات المسموح بيه مؤقتًا — هيتم الاستئناف تلقائيًا بعد شوية.' };
  }

  // 4. Configuration — a business object (Page/Pixel/Ad Account) we referenced is unusable.
  // Never auto-fixed by substituting a different one — that's a content decision only the user can make.
  if (META_CONFIG_SUBCODES.has(Number(subcode)) || /ad account.*disabled|page.*unavailable|pixel.*not found|has been disabled/i.test(err.message || '')) {
    return { ...base, classification: ERROR_CLASSES.CONFIGURATION_REQUIRED, retryable: false, maxRetries: 0, humanActionRequired: true, arabicMessage: `في مشكلة في إعدادات الحساب/الصفحة/البيكسل تمنع الاستمرار: ${err.message} — لازم تتحقق منها وتصححها، ثم استأنف النشر (مش هيتم تغييرها تلقائيًا).` };
  }

  // 5. Permission — the connected token lacks a needed scope on an asset.
  if (META_PERMISSION_CODES.has(Number(code))) {
    return { ...base, classification: ERROR_CLASSES.PERMISSION_ERROR, retryable: false, maxRetries: 0, humanActionRequired: true, arabicMessage: `التوكن المتصل مالوش صلاحية كافية: ${err.message} — راجع صلاحيات حساب Meta المتصل، ثم استأنف النشر.` };
  }

  // 6. Validation — a real, structural problem with the payload/budget/URL/etc.
  if (META_VALIDATION_CODES.has(Number(code)) || err.status === 400 || err.status === 422) {
    return { ...base, classification: ERROR_CLASSES.VALIDATION_ERROR, retryable: false, maxRetries: 0, humanActionRequired: true, arabicMessage: `في مشكلة في البيانات نفسها: ${err.message} — لازم تتصحح يدويًا (مش هيتم اختيار قيمة بديلة تلقائيًا)، ثم استأنف النشر.` };
  }

  // 7. Meta itself reports the object already exists / duplicate name conflict.
  if (/already exists|duplicate/i.test(err.message || '')) {
    return { ...base, classification: ERROR_CLASSES.DUPLICATE_OR_ALREADY_CREATED, retryable: true, maxRetries: 5, humanActionRequired: false, arabicMessage: 'Meta بترجع إن العنصر موجود بالفعل — هيتم التحقق وإعادة المحاولة بأمان من غير تكرار.' };
  }

  // 8. Meta's own infrastructure (5xx / "try again").
  if (isMetaProviderError(err)) {
    return { ...base, classification: ERROR_CLASSES.PROVIDER_ERROR, retryable: true, maxRetries: 15, humanActionRequired: false, arabicMessage: 'مشكلة مؤقتة في سيرفرات Meta — هيتم الاستئناف تلقائيًا.' };
  }

  // 9. Our own DB connectivity blips (Neon/Postgres) — never a reason to repeat a Meta write.
  if (isDatabaseTransient(err)) {
    return { ...base, classification: ERROR_CLASSES.DATABASE_TRANSIENT, retryable: true, maxRetries: 10, humanActionRequired: false, arabicMessage: 'مشكلة اتصال مؤقتة بقاعدة البيانات — هيتم إعادة المحاولة من غير أي كتابة جديدة على Meta.' };
  }

  // 10. Plain network/timeout — the write may or may not have landed on Meta; always
  // reconcile persisted state before ever retrying the WRITE itself (see publishCampaignFull).
  if (isNetworkError(err)) {
    return { ...base, classification: ERROR_CLASSES.TRANSIENT_RETRYABLE, retryable: true, maxRetries: 15, humanActionRequired: false, arabicMessage: 'انقطاع مؤقت في الشبكة — هيتم التحقق من الحالة الفعلية قبل إعادة أي محاولة.' };
  }

  // 11. Anything else — never guess a repair. Preserve progress, flag for a human, show the real message.
  return { ...base, classification: ERROR_CLASSES.TERMINAL, retryable: false, maxRetries: 0, humanActionRequired: true, arabicMessage: `خطأ غير معروف محتاج مراجعة يدوية: ${err.message}`, unknown: true };
}

/** Bounded exponential backoff, capped at 5 minutes, shared by every retryable classification. Respects a real Retry-After header/value when Meta provides one. */
export function backoffMsFor(attemptNumber, retryAfterSeconds) {
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return Math.min(retryAfterSeconds * 1000, 15 * 60_000);
  return Math.min(30_000 * 2 ** Math.max(0, attemptNumber - 1), 5 * 60_000);
}
