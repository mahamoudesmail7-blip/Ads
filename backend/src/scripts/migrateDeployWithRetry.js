// Deploy-time wrapper around `prisma migrate deploy` — retries on a
// connection failure (Prisma P1002 "database server was reached but timed
// out", or the underlying connection ever refused/reset) with backoff,
// before giving up. Root cause this exists for: Neon (this project's
// Postgres host) suspends its compute after a period of inactivity, and the
// FIRST connection after a cold start can take longer to wake up than
// Prisma's connection attempt allows — `prisma migrate deploy` runs before
// the server ever starts, so a single slow wake-up there took the whole
// deploy down with the app never getting a chance to boot.
//
// Never touches migrations/schema/data itself — this only decides HOW MANY
// TIMES and how far apart to retry the exact same `prisma migrate deploy`
// command Railway already ran. Re-running it after a pure connection
// timeout is safe: it only applies migrations not yet recorded in
// `_prisma_migrations`, and does nothing at all when (as today) there are
// none pending.
import { spawnSync } from 'node:child_process';

/** Synchronous sleep (no subprocess, no platform-specific command) — this whole retry loop is intentionally synchronous so `npm start`'s single process exits non-zero on real failure instead of a backgrounded async chain masking it. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [3000, 6000, 12000, 24000, 45000]; // generous — a cold Neon compute can take a while to resume

// A prisma CLI failure prints its error class name (P1001/P1002/etc.) in
// stdout/stderr — matched loosely so this also covers the plain connection-
// refused/reset case, not only the exact P1002 code.
const RETRYABLE_PATTERN = /P1001|P1002|P1008|P1017|ECONNREFUSED|ETIMEDOUT|ECONNRESET|Can't reach database server|timed out/i;

function attempt(n) {
  console.log(`[migrateDeployWithRetry] prisma migrate deploy — attempt ${n}/${MAX_ATTEMPTS}`);
  const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'pipe', encoding: 'utf8', shell: true });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(output);
  return { ok: result.status === 0, retryable: RETRYABLE_PATTERN.test(output), status: result.status };
}

let last = null;
for (let n = 1; n <= MAX_ATTEMPTS; n++) {
  last = attempt(n);
  if (last.ok) { console.log('[migrateDeployWithRetry] succeeded.'); process.exit(0); }
  if (!last.retryable) { console.error('[migrateDeployWithRetry] non-retryable failure — stopping.'); process.exit(last.status ?? 1); }
  if (n < MAX_ATTEMPTS) {
    const wait = BACKOFF_MS[n - 1];
    console.warn(`[migrateDeployWithRetry] looks like a database connection timeout (Neon cold start?) — retrying in ${wait / 1000}s…`);
    sleepSync(wait);
  }
}
console.error(`[migrateDeployWithRetry] exhausted ${MAX_ATTEMPTS} attempts — giving up.`);
process.exit(last.status ?? 1);
