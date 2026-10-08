// 🧪 migrateDeployWithRetry logic — MOCKS ONLY: no real migration, no database connection, no sleeping.
//   node src/scripts/migrateDeployCoreTest.js
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
const __dirname = dirname(fileURLToPath(import.meta.url));
const core = await import(pathToFileURL(join(__dirname, 'migrateDeployCore.js')).href);
const { resolveMigrationUrl, buildChildEnv, redact, classifyFailure, runMigrateDeploy, describeLockHolders, KIND, EX_CONFIG, LOCK_POLICY, CONNECTION_POLICY, MigrationConfigError } = core;
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };

const POOL = 'postgresql://neondb_owner:SECRET-PW-123@ep-abc-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const DIRECT = 'postgresql://neondb_owner:SECRET-PW-123@ep-abc.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const throwsCfg = (fn) => { try { fn(); return null; } catch (e) { return e instanceof MigrationConfigError ? e.message : 'WRONG ERROR ' + e; } };

console.log('\n1. Which URL do migrations use');
ok('DIRECT_DATABASE_URL (non-pooler) is used even though DATABASE_URL is the pooler', resolveMigrationUrl({ DATABASE_URL: POOL, DIRECT_DATABASE_URL: DIRECT }).url === DIRECT);
ok('DIRECT_DATABASE_URL missing + pooled DATABASE_URL → refused with a clear message', /POOLER/.test(throwsCfg(() => resolveMigrationUrl({ DATABASE_URL: POOL })) || ''));
ok('DIRECT_DATABASE_URL pointing at a pooler host → refused', /POOLER/.test(throwsCfg(() => resolveMigrationUrl({ DATABASE_URL: POOL, DIRECT_DATABASE_URL: POOL })) || ''));
ok('DIRECT_DATABASE_URL garbage / wrong protocol / no database → refused', ['not a url', 'mysql://u:p@h/db', 'postgresql://u:p@host.example.com/'].every((v) => throwsCfg(() => resolveMigrationUrl({ DATABASE_URL: POOL, DIRECT_DATABASE_URL: v })) !== null));
ok('nothing set → refused', throwsCfg(() => resolveMigrationUrl({})) !== null);
ok('local development: no DIRECT var but a non-pooler DATABASE_URL is allowed', resolveMigrationUrl({ DATABASE_URL: DIRECT }).url === DIRECT);
ok('error messages never contain the connection string or password', [throwsCfg(() => resolveMigrationUrl({ DATABASE_URL: POOL })), throwsCfg(() => resolveMigrationUrl({ DATABASE_URL: POOL, DIRECT_DATABASE_URL: POOL }))].every((m) => !/SECRET-PW|neondb_owner|ep-abc/.test(m)));

console.log('\n2. Child environment — advisory lock protection stays on');
const ce = buildChildEnv({ DATABASE_URL: POOL, DIRECT_DATABASE_URL: DIRECT, FOO: '1' }, DIRECT);
ok('the prisma child sees the DIRECT url as DATABASE_URL (app env untouched)', ce.DATABASE_URL === DIRECT && ce.FOO === '1');
ok('PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK is stripped from the child (local run)', !('PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK' in buildChildEnv({ PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: '1' }, DIRECT)));
ok('…and is a fatal config error on production (NODE_ENV or Railway)', /advisory lock must stay enabled/.test(throwsCfg(() => buildChildEnv({ PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: '1', NODE_ENV: 'production' }, DIRECT)) || '') && throwsCfg(() => buildChildEnv({ PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: 'true', RAILWAY_ENVIRONMENT: 'production' }, DIRECT)) !== null);
ok('an explicit "0"/"false" value on production is not a problem', throwsCfg(() => buildChildEnv({ PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: '0', NODE_ENV: 'production' }, DIRECT)) === null);

console.log('\n3. Output redaction + failure classification');
ok('connection strings and passwords are redacted from child output', !/SECRET-PW|neondb_owner/.test(redact(`Error at ${POOL} password=SECRET-PW-123 token: abc`)) && /postgresql:\/\/\*\*\*/.test(redact(POOL)));
const LOCK_OUT = 'Error: P1002\nThe database server was reached but timed out.\nContext: Timed out trying to acquire a postgres advisory lock (SELECT pg_advisory_lock(72707369)). Elapsed: 10000ms.';
ok('P1002 with the advisory-lock context → LOCK_TIMEOUT', classifyFailure(LOCK_OUT) === KIND.LOCK);
ok('plain P1002 / P1001 / ECONNRESET / "Can\'t reach database server" → CONNECTION', ['Error: P1002 timed out', 'P1001', 'ECONNRESET', "Can't reach database server at x"].every((o) => classifyFailure(o) === KIND.CONNECTION));
ok('anything else (e.g. a failed migration P3009 / SQL error) → OTHER (not retried)', classifyFailure('Error: P3009 migrate found failed migrations') === KIND.OTHER && classifyFailure('') === KIND.OTHER);

console.log('\n4. Retry behaviour (fake spawn + fake sleep)');
const harness = (outputs, extra = {}) => {
  const calls = [], sleeps = [], logs = [], warns = [], errs = [];
  const queue = [...outputs];
  const deps = {
    env: { DATABASE_URL: POOL, DIRECT_DATABASE_URL: DIRECT, ...(extra.env || {}) },
    spawn: (cmd, args, opts) => { calls.push({ cmd, args, env: opts.env }); const o = queue.shift() ?? { status: 0, stdout: '' }; return { status: o.status, stdout: o.stdout || '', stderr: o.stderr || '' }; },
    sleep: async (ms) => { sleeps.push(ms); },
    log: (m) => logs.push(m), warn: (m) => warns.push(m), error: (m) => errs.push(m),
    diagnoseLock: extra.diagnoseLock,
  };
  return { deps, calls, sleeps, logs, warns, errs };
};
{
  const h = harness([{ status: 0, stdout: 'No pending migrations to apply.' }]);
  const code = await runMigrateDeploy(h.deps);
  ok('success first time: exit 0, one `prisma migrate deploy` call, no sleep', code === 0 && h.calls.length === 1 && h.sleeps.length === 0 && h.calls[0].args.join(' ') === 'prisma migrate deploy');
  ok('the child process was given the DIRECT url, not the pooler', h.calls[0].env.DATABASE_URL === DIRECT);
}
{
  const h = harness([]); h.deps.env = { DATABASE_URL: POOL };
  const code = await runMigrateDeploy(h.deps);
  ok('pooler-only config: exit 78 BEFORE anything is spawned, clear message, no secrets', code === EX_CONFIG && h.calls.length === 0 && /CONFIGURATION ERROR/.test(h.errs.join('')) && !/SECRET-PW|ep-abc/.test(h.errs.concat(h.logs).join('')));
}
{
  const h = harness([{ status: 1, stderr: 'Error: P1002 timed out' }, { status: 1, stderr: 'Error: P1001' }, { status: 0, stdout: 'ok' }]);
  const code = await runMigrateDeploy(h.deps);
  ok('Neon cold start: retries with the connection back-off and then succeeds', code === 0 && h.calls.length === 3 && h.sleeps.join() === CONNECTION_POLICY.backoffMs.slice(0, 2).join());
}
{
  const h = harness(Array(10).fill({ status: 1, stderr: 'Error: P1001' }));
  const code = await runMigrateDeploy(h.deps);
  ok('connection failures give up after 5 attempts (original policy kept)', code === 1 && h.calls.length === CONNECTION_POLICY.maxAttempts && h.sleeps.length === 4 && /gave up/.test(h.errs.join('')));
}
{
  const h = harness([{ status: 1, stderr: LOCK_OUT }, { status: 1, stderr: LOCK_OUT }, { status: 0, stdout: 'ok' }], { diagnoseLock: async () => ['lock diagnostics: pid 1 HOLDS'] });
  const code = await runMigrateDeploy(h.deps);
  ok('leftover advisory lock: waits with the LONGER lock back-off, then succeeds when it is released', code === 0 && h.sleeps.join() === LOCK_POLICY.backoffMs.slice(0, 2).join());
  ok('…prints read-only lock-holder diagnostics and says nothing is terminated automatically', h.warns.some((w) => /lock diagnostics/.test(w)) && h.warns.some((w) => /NOT terminating anything/.test(w)));
}
{
  const h = harness(Array(12).fill({ status: 1, stderr: LOCK_OUT }));
  const code = await runMigrateDeploy(h.deps);
  ok('a lock that never clears: bounded at 7 attempts (~4 min), exits non-zero with guidance for the owner', code === 1 && h.calls.length === LOCK_POLICY.maxAttempts && h.sleeps.reduce((a, b) => a + b, 0) === LOCK_POLICY.backoffMs.reduce((a, b) => a + b, 0) && /owner decide/.test(h.errs.join('')));
}
{
  const h = harness([{ status: 1, stderr: 'Error: P3009 migrate found failed migrations' }]);
  const code = await runMigrateDeploy(h.deps);
  ok('a real migration failure is NOT retried', code === 1 && h.calls.length === 1 && h.sleeps.length === 0);
}
{
  const h = harness([{ status: 1, stderr: LOCK_OUT }, { status: 0 }], { diagnoseLock: async () => { throw new Error('diagnostics down'); } });
  ok('a failing diagnostics call never breaks the retry loop', await runMigrateDeploy(h.deps) === 0);
}
{
  const h = harness([{ status: 1, stderr: `boom ${POOL} password=SECRET-PW-123` , stdout: ''}, { status: 0 }]);
  await runMigrateDeploy(h.deps);
  ok('child output is redacted before it is logged (no credentials in logs)', !/SECRET-PW|neondb_owner/.test(h.logs.concat(h.warns, h.errs).join('\n')));
}

console.log('\n5. Diagnostics are read-only');
{
  let sqlSeen = '';
  const lines = await describeLockHolders(async (sql) => { sqlSeen = sql; return [{ pid: 10603, granted: true, state: 'idle', application_name: '', xact_start: null, secs_in_state: 840 }]; });
  ok('the lock-holder query is a plain SELECT on pg_locks/pg_stat_activity (no terminate/cancel/DDL)', /^\s*select/i.test(sqlSeen) && !/terminate|cancel|drop|delete|update|insert|alter/i.test(sqlSeen));
  ok('output names pid, state, idle time and open-transaction flag — and nothing sensitive', /pid 10603 HOLDS/.test(lines[0]) && /idle/.test(lines[0]) && /840s/.test(lines[0]) && /open transaction=no/.test(lines[0]));
  ok('no holder → a neutral message', /no session holds/.test((await describeLockHolders(async () => []))[0]));
}

console.log('\n6. The real entry point refuses a pooler-only setup without spawning anything');
{
  const r = spawnSync(process.execPath, [join(__dirname, 'migrateDeployWithRetry.js')], { encoding: 'utf8', cwd: tmpdir(), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: POOL } });
  ok('exit code 78 and a clear message; the connection string is not printed', r.status === EX_CONFIG && /CONFIGURATION ERROR/.test(r.stderr) && !/SECRET-PW|ep-abc|neondb_owner/.test(r.stdout + r.stderr), `${r.status} ${r.stderr}`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} migrateDeployCoreTest: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
