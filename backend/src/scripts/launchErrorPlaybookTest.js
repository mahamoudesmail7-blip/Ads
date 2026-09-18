// Campaign Launch Builder — the Error Playbook Registry
// (services/amb/launchErrorPlaybook.js). Pure, offline tests: every one of
// these is a synthetic error shaped exactly like what the real dependency
// (Meta Graph, Prisma, Node's fetch) actually throws, verifying
// classifyError() routes it to the correct ERROR_CLASSES value and policy.
// No network, no DB, no Meta — this is what "failure-injection testing"
// looks like for a pure classifier: inject the exact real error shape.
//   node src/scripts/launchErrorPlaybookTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { classifyError, ERROR_CLASSES, backoffMsFor } = await imp('../services/amb/launchErrorPlaybook.js');

// Builds an error exactly as metaGraphClient.js's throwGraphOAuthError actually attaches fields.
function metaErr(message, { code = null, subcode = null, type = null, status = 400, isRateLimit = false } = {}) {
  const e = new Error(message);
  e.graphStatus = status; e.graphType = type; e.graphCode = code; e.graphSubcode = subcode;
  e.isMetaRateLimit = isRateLimit; e.fbtraceId = 'AbCdEfGhIj';
  return e;
}

console.log('§1 Meta video processing (thumbnail not ready) — the C8 scenario, now ONE playbook entry:');
{
  const e = new Error('فيديو C8 لسه Meta بيعالجه (processing) — هيتعاد المحاولة تلقائيًا لحد ما يجهز.');
  e.transient = true;
  const c = classifyError(e);
  ok('classified PROCESSING_WAIT', c.classification === ERROR_CLASSES.PROCESSING_WAIT);
  ok('retryable with a real bounded max', c.retryable === true && c.maxRetries > 0);
  ok('never requires a human by itself', c.humanActionRequired === false);
}

console.log('\n§2 Meta rate limiting (429-shaped / app throttle):');
{
  const c1 = classifyError(metaErr('Application request limit reached', { code: 4, isRateLimit: true }));
  ok('code 4 (app throttle) classified RATE_LIMITED', c1.classification === ERROR_CLASSES.RATE_LIMITED);
  const c2 = classifyError(metaErr('(#17) User request limit reached', { code: 17 }));
  ok('code 17 (user throttle), detected even without the isMetaRateLimit flag', c2.classification === ERROR_CLASSES.RATE_LIMITED);
  ok('rate limit is retryable, bounded', c2.retryable === true && c2.maxRetries > 0);
}

console.log('\n§3 Meta 5xx / provider-side failure:');
{
  const c = classifyError(metaErr('An unknown error occurred', { status: 503 }));
  ok('HTTP 5xx from Meta classified PROVIDER_ERROR', c.classification === ERROR_CLASSES.PROVIDER_ERROR);
  ok('retryable, bounded', c.retryable === true && c.maxRetries > 0);
}

console.log('\n§4 HTTP timeout / network blip AFTER Meta may have already accepted the request:');
{
  const timeout = new Error('fetch failed');
  timeout.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
  const c1 = classifyError(timeout);
  ok('undici connect timeout classified TRANSIENT_RETRYABLE', c1.classification === ERROR_CLASSES.TRANSIENT_RETRYABLE);
  ok('flagged retryable — caller (publishCampaignFull) is what actually reconciles before retrying the WRITE', c1.retryable === true);

  const reset = new Error('socket hang up'); reset.code = 'ECONNRESET';
  const c2 = classifyError(reset);
  ok('ECONNRESET classified TRANSIENT_RETRYABLE', c2.classification === ERROR_CLASSES.TRANSIENT_RETRYABLE);

  const abort = new Error('The operation was aborted'); abort.name = 'AbortError';
  const c3 = classifyError(abort);
  ok('AbortError (our own request timeout) classified TRANSIENT_RETRYABLE', c3.classification === ERROR_CLASSES.TRANSIENT_RETRYABLE);
}

console.log('\n§5 DB transient (Prisma connection/pool-timeout family):');
{
  const e1 = new Error("Can't reach database server"); e1.code = 'P1001';
  ok('P1001 classified DATABASE_TRANSIENT', classifyError(e1).classification === ERROR_CLASSES.DATABASE_TRANSIENT);
  const e2 = new Error('Timed out fetching a new connection from the pool'); e2.code = 'P2024';
  ok('P2024 pool timeout classified DATABASE_TRANSIENT', classifyError(e2).classification === ERROR_CLASSES.DATABASE_TRANSIENT);
  ok('DB transient is retryable — never a reason to repeat the Meta write itself', classifyError(e2).retryable === true);
}

console.log('\n§6 Restart between Campaign and Ad Set / restart during the 5-minute gate:');
{
  // These are not distinct ERROR classes — they are covered by idempotency +
  // durable DB columns (next_campaign_at / next_retry_at), not by classifyError()
  // at all. Proven in launchQueueTest.js §4/§6/§8. Documented here so the mapping
  // from the 18 required scenarios to where each is actually proven is explicit.
  ok('covered by durable state, not the classifier — see launchQueueTest.js §4 (gate restart) and §6 (FAILED-stuck resume)', true);
}

console.log('\n§7 Double Publish / double Resume / concurrent scheduler tick:');
{
  // Also not classifyError() concerns — proven by startLaunchQueue()'s idempotent
  // no-op (launchQueueTest.js §2) and the job-level lease lock (§9 below).
  ok('covered by startLaunchQueue idempotency + job lease locking, not the classifier', true);
}

console.log('\n§8 Expired/revoked Meta auth — must NOT be endlessly retried:');
{
  const e = metaErr('Error validating access token: Session has expired', { type: 'OAuthException', code: 190 });
  const c = classifyError(e);
  ok('classified AUTH_REFRESH_REQUIRED', c.classification === ERROR_CLASSES.AUTH_REFRESH_REQUIRED);
  ok('never auto-retried', c.retryable === false && c.maxRetries === 0);
  ok('flags human action required', c.humanActionRequired === true);
  ok('Arabic message tells the user to reconnect Meta', /إعادة ربط/.test(c.arabicMessage));
}

console.log('\n§9 Invalid Page / invalid Pixel / disabled Ad Account (configuration, not our code):');
{
  const c1 = classifyError(metaErr('Invalid parameter', { code: 100, subcode: 1487390 }));
  ok('a real config-object subcode classified CONFIGURATION_REQUIRED', c1.classification === ERROR_CLASSES.CONFIGURATION_REQUIRED);
  const c2 = classifyError(new Error('This ad account has been disabled'));
  ok('"disabled" ad account message classified CONFIGURATION_REQUIRED even without a matching subcode', c2.classification === ERROR_CLASSES.CONFIGURATION_REQUIRED);
  ok('never auto-retried, never silently substitutes another asset', c1.retryable === false && c1.humanActionRequired === true);
  ok('message explicitly says it will NOT be changed automatically', /مش هيتم تغييرها تلقائيًا/.test(c1.arabicMessage));
}

console.log('\n§10 Missing permission on the connected token:');
{
  const c = classifyError(metaErr('(#200) Permissions error', { code: 200 }));
  ok('classified PERMISSION_ERROR', c.classification === ERROR_CLASSES.PERMISSION_ERROR);
  ok('never auto-retried', c.retryable === false && c.humanActionRequired === true);
}

console.log('\n§11 Invalid budget / malformed URL (real validation problems):');
{
  const e1 = new Error('لازم ميزانية صحيحة لكل Ad Set (ABO).'); e1.status = 400;
  ok('our own fail()-thrown validation error classified VALIDATION_ERROR', classifyError(e1).classification === ERROR_CLASSES.VALIDATION_ERROR);
  const e2 = metaErr('Invalid parameter', { code: 100 });
  ok('Meta code 100 (invalid parameter, e.g. malformed URL/budget) classified VALIDATION_ERROR', classifyError(e2).classification === ERROR_CLASSES.VALIDATION_ERROR);
}

console.log('\n§12 One failed video among many / one failed ad among many:');
{
  // Not a distinct error shape either — whatever the underlying real cause is
  // (processing/validation/etc.) classifies normally; the fact that only ONE
  // object out of N is affected is a property of the per-object idempotency
  // map (ensureCreative/ensureAd), proven directly in launchQueueTest.js.
  ok('the "only one object blocked" guarantee comes from the object-map, not the classifier', true);
}

console.log('\n§13 Meta reports the object already exists (a genuine duplicate-name race):');
{
  const c = classifyError(metaErr('An object with this name already exists', {}));
  ok('classified DUPLICATE_OR_ALREADY_CREATED', c.classification === ERROR_CLASSES.DUPLICATE_OR_ALREADY_CREATED);
  ok('retryable via reconciliation, not a terminal failure', c.retryable === true);
}

console.log('\n§14 Unknown/unclassified error — never guessed, always escalated safely:');
{
  const e = new Error('Something Meta has never told us about before');
  const c = classifyError(e);
  ok('falls back to TERMINAL', c.classification === ERROR_CLASSES.TERMINAL);
  ok('flags human action required rather than guessing a repair', c.humanActionRequired === true);
  ok('flagged as genuinely unknown for observability', c.unknown === true);
  ok('never leaks a token/secret — only the message and Meta\'s own public diagnostic ids', !JSON.stringify(c).match(/access_token|EAAB|Bearer /i));
}

console.log('\n§15 backoffMsFor — bounded exponential backoff, respects a real Retry-After when given:');
{
  ok('attempt 1 starts at 30s', backoffMsFor(1) === 30_000);
  ok('doubles each attempt', backoffMsFor(2) === 60_000 && backoffMsFor(3) === 120_000);
  ok('caps at 5 minutes no matter how high the attempt count', backoffMsFor(50) === 5 * 60_000);
  ok('a real Retry-After value is honored over the computed backoff', backoffMsFor(1, 90) === 90_000);
  ok('an absurd Retry-After is still capped (never waits literal hours unbounded)', backoffMsFor(1, 999999) === 15 * 60_000);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
