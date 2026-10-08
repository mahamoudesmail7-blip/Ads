// 🛡️ Test-database guard — import this FIRST in every regression suite.
//
// Makes it impossible for a suite to touch the production database, even if the environment variables are wrong:
//  1. TEST_DATABASE_URL is required (a separate Neon branch/database) and must not share an endpoint with DATABASE_URL / DIRECT_DATABASE_URL / the
//     known production endpoints, must not be a pooler, must be a Neon/Postgres URL.
//  2. process.env.DATABASE_URL is REPLACED by the test URL before @prisma/client / prisma.js are loaded (this module is evaluated first), so every
//     `new PrismaClient()` in the suite, in the services and in child processes the suite spawns talks to the test database. DIRECT_DATABASE_URL and
//     the deployment write-unlock are removed from the environment.
//  3. The target database must carry the test marker row (settings.id = '__TEST_DATABASE_MARKER__', seeded by `node src/scripts/testDb.mjs seed`).
//     That row exists only in the test database, so even a TEST_DATABASE_URL accidentally set to production is refused.
// On any failure it prints why and exits with code 3 BEFORE a single suite statement runs. It never prints a connection string.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { MARKER_ID, validateTestUrl } from './_testGuardCore.js';
export { MARKER_ID };

const stop = (why) => { console.error(`\n🛑 TEST GUARD: ${why}\n   The suites run ONLY against the isolated test database (TEST_DATABASE_URL). Nothing was executed.\n`); process.exit(3); };

/** Reads a key from backend/.env WITHOUT touching process.env (so production values never leak into the suite's environment by accident). */
function dotenvValue(key) {
  try {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../.env'), 'utf8');
    const m = text.match(new RegExp('^' + key + '="?([^"\\r\\n]*)"?\\s*$', 'm'));
    return m ? m[1] : '';
  } catch { return ''; }
}

const testUrl = (process.env.TEST_DATABASE_URL || dotenvValue('TEST_DATABASE_URL')).trim();
const productionUrls = [process.env.DATABASE_URL, process.env.DIRECT_DATABASE_URL, dotenvValue('DATABASE_URL'), dotenvValue('DIRECT_DATABASE_URL')];
const problem = validateTestUrl(testUrl, productionUrls);
if (problem) stop(problem);

// From here on every PrismaClient in this process (and its children) is bound to the test database.
process.env.DATABASE_URL = testUrl;
process.env.TEST_DATABASE_URL = testUrl;
delete process.env.DIRECT_DATABASE_URL;
delete process.env.OPERATOR_ALLOW_META_WRITES; // writes stay locked unless a suite sets it itself, in-process
process.env.TEST_DB_GUARD = '1';

// Identity check: the marker row must exist in THIS database (only the test database has it).
const { PrismaClient } = await import('@prisma/client');
const probe = new PrismaClient({ datasources: { db: { url: testUrl } }, log: [] });
try {
  const rows = await probe.$queryRawUnsafe(`select id from public.settings where id = $1`, MARKER_ID);
  if (!rows.length) stop('the test marker row is missing in the target database — it is not the seeded test database (run: node src/scripts/testDb.mjs seed). Refusing to run.');
} catch (e) {
  stop('could not verify the test database identity (' + String(e.message).split('\n').pop().slice(0, 120) + ')');
} finally { await probe.$disconnect(); }
