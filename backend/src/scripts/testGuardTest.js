// 🧪 The test-database guard itself. Never connects to production: every "bad" scenario is refused BEFORE any connection, and the one connecting scenario targets the TEST database only.
//   node src/scripts/testGuardTest.js        (needs TEST_DATABASE_URL in backend/.env; does not import the guard itself)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const { validateTestUrl, MARKER_ID, endpointOf } = await import(pathToFileURL(join(__dirname, '_testGuardCore.js')).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };

const PROD_POOL = 'postgresql://u:p@ep-solitary-cell-b22g00vo-pooler.c-6.eu-central-1.aws.neon.tech/neondb';
const PROD_DIRECT = 'postgresql://u:p@ep-solitary-cell-b22g00vo.c-6.eu-central-1.aws.neon.tech/neondb';
const OTHER = 'postgresql://u:p@ep-other-branch-123.c-6.eu-central-1.aws.neon.tech/neondb';

console.log('\n1. URL validation (pure)');
ok('unset / garbage / wrong protocol are refused', ['', 'nope', 'mysql://u:p@h/db'].every((u) => validateTestUrl(u, [PROD_POOL]) !== null));
ok('the production endpoint is refused (pooler or direct form), even with no production URL configured', validateTestUrl(PROD_DIRECT, []) !== null && validateTestUrl(PROD_DIRECT.replace('ep-solitary-cell-b22g00vo', 'ep-solitary-cell-b22g00vo-pooler'), []) !== null);
ok('a pooler URL is refused', /DIRECT/.test(validateTestUrl(OTHER.replace('ep-other-branch-123', 'ep-other-branch-123-pooler'), []) || ''));
ok('an endpoint equal to any configured production URL is refused', /same endpoint/.test(validateTestUrl(OTHER, [PROD_POOL, OTHER]) || ''));
ok('a different direct Neon branch endpoint is accepted', validateTestUrl(OTHER, [PROD_POOL, PROD_DIRECT]) === null);
ok('messages never contain the URL', ![validateTestUrl(PROD_DIRECT, []), validateTestUrl(OTHER, [OTHER])].some((m) => /u:p@|ep-other|ep-solitary/.test(m)));

console.log('\n2. The guard module, run as a fresh process');
const guard = join(__dirname, '_testGuard.js');
const run = (code, env) => spawnSync(process.execPath, ['--input-type=module', '-e', `import ${JSON.stringify(pathToFileURL(guard).href)}; ${code}`], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
{
  const r = run('console.log("SUITE RAN")', { TEST_DATABASE_URL: PROD_DIRECT });
  ok('TEST_DATABASE_URL = production endpoint → exit 3 and NO suite code runs', r.status === 3 && !/SUITE RAN/.test(r.stdout) && /PRODUCTION endpoint/.test(r.stderr), r.stderr);
}
{
  const r = run('console.log("SUITE RAN")', { TEST_DATABASE_URL: PROD_POOL });
  ok('production pooler endpoint as TEST_DATABASE_URL → refused', r.status === 3 && !/SUITE RAN/.test(r.stdout));
}
{
  const r = run('console.log("SUITE RAN")', { TEST_DATABASE_URL: OTHER });
  ok('a different but unreachable/unmarked database → refused (identity cannot be verified), no suite code', r.status === 3 && !/SUITE RAN/.test(r.stdout) && /could not verify|marker/.test(r.stderr), r.stderr);
}
{
  // Real test database (from .env): env vars set "wrongly" to production-like values must be overridden / removed.
  const r = run('console.log(JSON.stringify({ guard: process.env.TEST_DB_GUARD, dbIsTest: process.env.DATABASE_URL === process.env.TEST_DATABASE_URL, directGone: process.env.DIRECT_DATABASE_URL === undefined, writesLocked: process.env.OPERATOR_ALLOW_META_WRITES === undefined }))',
    { DATABASE_URL: PROD_POOL, DIRECT_DATABASE_URL: PROD_DIRECT, OPERATOR_ALLOW_META_WRITES: 'true' });
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* shown below */ }
  ok('with production DATABASE_URL/DIRECT/WRITES wrongly set in the environment, the guard rebinds DATABASE_URL to the test DB, drops DIRECT and the write-unlock', !!out && out.guard === '1' && out.dbIsTest && out.directGone && out.writesLocked, r.stdout + r.stderr);
}
{
  const hostEndpoint = (s) => { try { return endpointOf(s); } catch { return null; } };
  const text = readFileSync(join(__dirname, '../../.env'), 'utf8');
  const val = (k) => (text.match(new RegExp('^' + k + '="?([^"\\r\\n]*)"?\\s*$', 'm')) || [])[1] || '';
  ok('backend/.env: TEST_DATABASE_URL is set and its endpoint differs from DATABASE_URL', !!val('TEST_DATABASE_URL') && hostEndpoint(val('TEST_DATABASE_URL')) !== hostEndpoint(val('DATABASE_URL')));
  ok('the marker id is the documented one', MARKER_ID === '__TEST_DATABASE_MARKER__');
}

console.log('\n3. Every DB suite imports the guard first');
{
  const files = (await import('node:fs')).readdirSync(__dirname).filter((f) => /Test\.(js|mjs)$/.test(f) && !['testGuardTest.js', 'migrateDeployCoreTest.js'].includes(f));
  const unguarded = files.filter((f) => { const first = readFileSync(join(__dirname, f), 'utf8').split(/\r?\n/).find((l) => /^import[\s{*]/.test(l)) || ''; return !/_testGuard\.js/.test(first); });
  ok(`all ${files.length} suites have the guard as their first import`, unguarded.length === 0, unguarded.join(', '));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} testGuardTest: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
