// Logic behind migrateDeployWithRetry.js — kept free of side effects (no spawn / no DB / no exit on import) so it can be unit-tested with mocks only.
//
// Why migrations use a DIRECT connection: Prisma takes a SESSION-level Postgres advisory lock (pg_advisory_lock(72707369)) for the whole `migrate deploy`.
// Through Neon's pgbouncer (transaction pooling) a session is not tied to one client, so that lock can be taken on one backend and be left behind on it
// after the process is gone — blocking every later deploy with P1002 ("Timed out trying to acquire a postgres advisory lock"). Neon's own guidance is to
// run migrations over the direct (non-pooler) host while the app keeps using the pooler.
//
//   DIRECT_DATABASE_URL   postgres(ql):// URL to the DIRECT host (no "-pooler" in the host name). Used by `prisma migrate deploy` ONLY.
//   DATABASE_URL          unchanged — the app's (pooled) connection.
//
// Hard rules encoded here: never run migrations through a pooler; never disable Prisma's advisory lock (PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK is stripped
// from the child's environment and is a fatal config error on production); never terminate a PostgreSQL session (the lock-holder diagnostics are read-only
// and only ever print — a human decides).

export const EX_CONFIG = 78;
const PG_PROTOCOL = /^postgres(?:ql)?:$/;

/** A failure of the *setup* (not of Prisma) — the message is safe to print: it never contains the URL. */
export class MigrationConfigError extends Error {}

const parse = (u) => { try { return new URL(u); } catch { return null; } };
export const isPoolerHost = (host) => /-pooler(\.|$)/i.test(host || '');

/**
 * Decide which URL `prisma migrate deploy` will use. Returns { url, source } or throws MigrationConfigError.
 * - DIRECT_DATABASE_URL set → must be a valid postgres URL on a NON-pooler host.
 * - not set → allowed only when DATABASE_URL itself is a valid NON-pooler URL (e.g. local development); a pooled DATABASE_URL is refused.
 */
export function resolveMigrationUrl(env) {
  const direct = (env.DIRECT_DATABASE_URL || '').trim();
  if (direct) {
    const u = parse(direct);
    if (!u || !PG_PROTOCOL.test(u.protocol) || !u.hostname || !u.pathname.replace('/', '')) throw new MigrationConfigError('DIRECT_DATABASE_URL is not a valid postgres:// URL (host and database name are required).');
    if (isPoolerHost(u.hostname)) throw new MigrationConfigError('DIRECT_DATABASE_URL points to a POOLER host ("-pooler"). Migrations must use the direct Neon connection string.');
    return { url: direct, source: 'DIRECT_DATABASE_URL' };
  }
  const app = parse((env.DATABASE_URL || '').trim());
  if (!app || !PG_PROTOCOL.test(app.protocol)) throw new MigrationConfigError('Neither DIRECT_DATABASE_URL nor a valid DATABASE_URL is set.');
  if (isPoolerHost(app.hostname)) throw new MigrationConfigError('DIRECT_DATABASE_URL is not set and DATABASE_URL is a POOLER connection. Refusing to run migrations through the pooler — set DIRECT_DATABASE_URL to the direct (non-pooler) Neon connection string.');
  return { url: env.DATABASE_URL.trim(), source: 'DATABASE_URL (not a pooler)' };
}

const truthy = (v) => v !== undefined && v !== null && String(v).trim() !== '' && !/^(0|false|no|off)$/i.test(String(v).trim());
export const isProductionEnv = (env) => env.NODE_ENV === 'production' || !!env.RAILWAY_ENVIRONMENT || !!env.RAILWAY_ENVIRONMENT_NAME;

/** Environment for the `prisma` child process: migration URL only, advisory lock protection always on. */
export function buildChildEnv(env, url) {
  if (truthy(env.PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK) && isProductionEnv(env)) throw new MigrationConfigError('PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK is set on a production environment — Prisma\'s advisory lock must stay enabled. Remove the variable.');
  const child = { ...env, DATABASE_URL: url };
  delete child.PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK;
  return child;
}

/** Removes anything that looks like credentials from text before it is printed. */
export function redact(text) {
  return String(text || '')
    .replace(/(postgres(?:ql)?:\/\/)[^\s'"`]+/gi, '$1***')
    .replace(/(password|passwd|pwd|token|secret)(\s*[=:]\s*)\S+/gi, '$1$2***');
}

export const KIND = { OK: 'OK', LOCK: 'LOCK_TIMEOUT', CONNECTION: 'CONNECTION', OTHER: 'OTHER' };

/** Classifies a failed `prisma migrate deploy` from its output. */
export function classifyFailure(output) {
  const o = String(output || '');
  if (/advisory lock|pg_advisory_lock|migrate-advisory-locking/i.test(o)) return KIND.LOCK;
  if (/P1001|P1002|P1008|P1017|ECONNREFUSED|ETIMEDOUT|ECONNRESET|Can't reach database server|timed out/i.test(o)) return KIND.CONNECTION;
  return KIND.OTHER;
}

// Neon cold start (the original reason for this wrapper): 5 attempts, ~90 s of back-off.
export const CONNECTION_POLICY = { maxAttempts: 5, backoffMs: [3000, 6000, 12000, 24000, 45000] };
// A leftover advisory lock (an orphaned session on Neon's side) has been seen to last 1–2 minutes: wait longer, but still bounded (~4 min).
export const LOCK_POLICY = { maxAttempts: 7, backoffMs: [10000, 20000, 30000, 45000, 60000, 90000] };

/**
 * Runs `prisma migrate deploy` with retries.
 * deps: { env, spawn(cmd,args,opts)→{status,stdout,stderr}, sleep(ms), log, warn, error, diagnoseLock?():Promise<string[]> }
 * Returns the process exit code (0 = migrations up to date). Never throws for configuration problems — it returns EX_CONFIG after printing a clear message.
 */
export async function runMigrateDeploy(deps) {
  const { env, spawn, sleep, log = () => {}, warn = () => {}, error = () => {}, diagnoseLock } = deps;
  let url, childEnv;
  try {
    ({ url } = resolveMigrationUrl(env));
    childEnv = buildChildEnv(env, url);
  } catch (e) {
    if (e instanceof MigrationConfigError) { error(`[migrateDeployWithRetry] CONFIGURATION ERROR: ${e.message}`); return EX_CONFIG; }
    throw e;
  }
  log('[migrateDeployWithRetry] migrations run over the DIRECT connection (never the pooler); Prisma advisory lock stays enabled.');

  const maxEver = Math.max(CONNECTION_POLICY.maxAttempts, LOCK_POLICY.maxAttempts);
  let last = { status: 1, kind: KIND.OTHER };
  for (let n = 1; n <= maxEver; n++) {
    log(`[migrateDeployWithRetry] prisma migrate deploy — attempt ${n}`);
    const r = spawn('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'pipe', encoding: 'utf8', shell: true, env: childEnv });
    const output = `${r.stdout || ''}${r.stderr || ''}`;
    if (output) log(redact(output).replace(/\s+$/, ''));
    if (r.status === 0) { log('[migrateDeployWithRetry] succeeded.'); return 0; }
    const kind = classifyFailure(output);
    last = { status: r.status ?? 1, kind };
    if (kind === KIND.OTHER) { error('[migrateDeployWithRetry] non-retryable failure — stopping.'); return last.status; }
    const policy = kind === KIND.LOCK ? LOCK_POLICY : CONNECTION_POLICY;
    if (kind === KIND.LOCK && diagnoseLock) {
      try { for (const line of await diagnoseLock()) warn(`[migrateDeployWithRetry] ${line}`); } catch { /* diagnostics are best-effort */ }
    }
    if (n >= policy.maxAttempts) break;
    const wait = policy.backoffMs[n - 1] ?? policy.backoffMs[policy.backoffMs.length - 1];
    warn(kind === KIND.LOCK
      ? `[migrateDeployWithRetry] another session holds Prisma's migration advisory lock — NOT terminating anything automatically; retrying in ${wait / 1000}s…`
      : `[migrateDeployWithRetry] looks like a database connection timeout (Neon cold start?) — retrying in ${wait / 1000}s…`);
    await sleep(wait);
  }
  error(`[migrateDeployWithRetry] gave up (${last.kind}) — see the messages above.${last.kind === KIND.LOCK ? ' A stale session may still hold the lock; check pg_locks (objid 72707369) and have the owner decide whether to end it.' : ''}`);
  return last.status;
}

/** Read-only description of who holds Prisma's migration lock (never ends a session). `query` is injected: (sql) → rows. */
export async function describeLockHolders(query) {
  const rows = await query(`select l.pid, l.granted, a.state, a.application_name, a.backend_start, a.xact_start,
      extract(epoch from (now() - a.state_change))::int as secs_in_state
    from pg_locks l left join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory' and l.objid = 72707369 order by l.granted desc`);
  if (!rows.length) return ['lock diagnostics: no session holds the migration advisory lock right now (it may have just been released).'];
  return rows.map((r) => `lock diagnostics: pid ${r.pid} ${r.granted ? 'HOLDS' : 'waits for'} the migration lock — state=${r.state || '?'}, app=${r.application_name || '(direct)'}, in this state ${r.secs_in_state ?? '?'}s, open transaction=${r.xact_start ? 'yes' : 'no'}`);
}
