// Offline tests for the shared DB safety guard (dbSafetyGuard.js) — pure
// functions only. FAKE URLs, FAKE argv arrays, and FAKE SQL strings only:
// no real database connection, no real file, no real Prisma invocation.
//   node src/scripts/dbSafetyGuardTest.js
import { assertSafeShadowUrl, classifyDangerousPrismaCommand, classifyDangerousSql, assertConfirmed, CONFIRM_VALUE } from './dbSafetyGuard.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const FAKE_PROD = 'postgresql://user:pass@ep-fake-prod-host.neon.tech/neondb?sslmode=require';
const FAKE_PROD_DIFF_QUERY = 'postgresql://user:pass@ep-fake-prod-host.neon.tech/neondb?sslmode=require&channel_binding=require';
const SAME_HOST_DIFF_DB = 'postgresql://user:pass@ep-fake-prod-host.neon.tech/shadow_scratch_db?sslmode=require';
const DIFF_HOST_SAME_DB = 'postgresql://other:pass@ep-totally-different-host.neon.tech/neondb?sslmode=require';
const GENUINELY_SEPARATE = 'postgresql://user:pass@ep-fake-shadow-host.neon.tech/shadow_scratch_db?sslmode=require';
const NOT_A_URL = 'this-is-not-a-connection-string-at-all';

console.log('§1 assertSafeShadowUrl (incident: 2026-09-13 prisma migrate diff --shadow-database-url):');
{
  ok('missing shadow url -> throws', throws(() => assertSafeShadowUrl(null, FAKE_PROD)));
  ok('missing DATABASE_URL -> throws', throws(() => assertSafeShadowUrl(GENUINELY_SEPARATE, null)));
  ok('identical URLs (the exact incident) -> throws', throws(() => assertSafeShadowUrl(FAKE_PROD, FAKE_PROD)));
  ok('same host+db, different query string only -> throws', throws(() => assertSafeShadowUrl(FAKE_PROD_DIFF_QUERY, FAKE_PROD)));
  ok('production host reused as shadow (different db name) -> throws', throws(() => assertSafeShadowUrl(SAME_HOST_DIFF_DB, FAKE_PROD)));
  ok('production database name reused as shadow (different host) -> throws', throws(() => assertSafeShadowUrl(DIFF_HOST_SAME_DB, FAKE_PROD)));
  ok('unparseable shadow url -> throws', throws(() => assertSafeShadowUrl(NOT_A_URL, FAKE_PROD)));
  ok('unparseable DATABASE_URL -> throws', throws(() => assertSafeShadowUrl(FAKE_PROD, NOT_A_URL)));
  ok('genuinely different host AND database -> does NOT throw', !throws(() => assertSafeShadowUrl(GENUINELY_SEPARATE, FAKE_PROD)));
}

console.log('\n§2 classifyDangerousPrismaCommand (fake argv only, no real prisma invocation):');
{
  ok('"migrate reset" -> dangerous', classifyDangerousPrismaCommand(['migrate', 'reset']).dangerous === true);
  ok('"db push" -> dangerous', classifyDangerousPrismaCommand(['db', 'push']).dangerous === true);
  ok('"db push --force-reset" -> dangerous', classifyDangerousPrismaCommand(['db', 'push', '--force-reset']).dangerous === true);
  ok('"migrate diff --shadow-database-url X" -> dangerous', classifyDangerousPrismaCommand(['migrate', 'diff', '--shadow-database-url', 'X']).dangerous === true);
  ok('"migrate deploy" -> NOT dangerous', classifyDangerousPrismaCommand(['migrate', 'deploy']).dangerous === false);
  ok('"migrate status" -> NOT dangerous', classifyDangerousPrismaCommand(['migrate', 'status']).dangerous === false);
  ok('"generate" -> NOT dangerous', classifyDangerousPrismaCommand(['generate']).dangerous === false);
  ok('"migrate diff --script" (no shadow url) -> NOT dangerous', classifyDangerousPrismaCommand(['migrate', 'diff', '--from-migrations', 'x', '--script']).dangerous === false);
  ok('"db execute --file x.sql" -> NOT dangerous (classified separately, by SQL content)', classifyDangerousPrismaCommand(['db', 'execute', '--file', 'x.sql']).dangerous === false);
}

console.log('\n§3 classifyDangerousSql (fake SQL strings only, no real file/DB):');
{
  ok('DROP DATABASE -> dangerous', classifyDangerousSql('DROP DATABASE neondb;').dangerous === true);
  ok('DROP SCHEMA -> dangerous', classifyDangerousSql('DROP SCHEMA public CASCADE;').dangerous === true);
  ok('TRUNCATE -> dangerous', classifyDangerousSql('TRUNCATE TABLE users;').dangerous === true);
  ok('DROP TABLE -> dangerous', classifyDangerousSql('DROP TABLE users;').dangerous === true);
  ok('DELETE FROM with no WHERE -> dangerous', classifyDangerousSql('DELETE FROM users;').dangerous === true);
  ok('UPDATE ... SET with no WHERE -> dangerous', classifyDangerousSql('UPDATE users SET role = \'ADMIN\';').dangerous === true);
  ok('DELETE FROM with a WHERE clause -> NOT dangerous', classifyDangerousSql("DELETE FROM users WHERE id = 1;").dangerous === false);
  ok('UPDATE ... SET with a WHERE clause -> NOT dangerous', classifyDangerousSql("UPDATE users SET role = 'ADMIN' WHERE id = 1;").dangerous === false);
  ok('additive CREATE TABLE -> NOT dangerous (the real, legitimate use of guardedDbExecute.js)', classifyDangerousSql('CREATE TABLE "product_mappings" ("id" SERIAL NOT NULL);').dangerous === false);
  ok('ALTER TABLE ADD COLUMN -> NOT dangerous', classifyDangerousSql('ALTER TABLE "users" ADD COLUMN "x" TEXT;').dangerous === false);
  ok('CREATE INDEX -> NOT dangerous', classifyDangerousSql('CREATE INDEX "idx_x" ON "users"("x");').dangerous === false);
}

console.log('\n§4 assertConfirmed (the confirmation gate itself):');
{
  ok('dangerous + no confirmation -> throws', throws(() => assertConfirmed({ dangerous: true, reason: 'test' }, undefined)));
  ok('dangerous + wrong confirmation value -> throws', throws(() => assertConfirmed({ dangerous: true, reason: 'test' }, 'yes')));
  ok('dangerous + exact confirmation value -> does NOT throw', !throws(() => assertConfirmed({ dangerous: true, reason: 'test' }, CONFIRM_VALUE)));
  ok('not dangerous -> never throws regardless of confirmation', !throws(() => assertConfirmed({ dangerous: false, reason: null }, undefined)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
