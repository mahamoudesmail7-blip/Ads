// SAFETY WRAPPER around `prisma db execute --file <sql>` — the mechanism
// this repo actually uses to apply schema changes against the Neon pooler
// (see the workaround documented in project memory: `prisma migrate dev`
// times out on advisory locks over the pooler, so the real flow is
// `migrate diff --script` -> review -> `db execute --file` -> manual
// `_prisma_migrations` bookkeeping). That flow is legitimate and mostly
// additive (CREATE TABLE, CREATE INDEX, ALTER TABLE ADD COLUMN) — this
// wrapper does not block it. It only stops to demand explicit confirmation
// when the SQL file itself contains a genuinely destructive statement
// (DROP DATABASE/SCHEMA/TABLE, TRUNCATE, a WHERE-less DELETE/UPDATE).
//
// Usage:
//   node src/scripts/guardedDbExecute.js --file path/to/migration.sql --url "$DATABASE_URL"
//   (any extra args are passed straight through to `prisma db execute`)
//
// A destructive file requires:
//   CONFIRM_DESTRUCTIVE_DB_OP=I_UNDERSTAND_THIS_IS_DESTRUCTIVE \
//     node src/scripts/guardedDbExecute.js --file path/to/migration.sql --url "$DATABASE_URL"
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classifyDangerousSql, assertConfirmed, CONFIRM_ENV_VAR } from './dbSafetyGuard.js';

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  if (fileIdx === -1 || !args[fileIdx + 1]) {
    console.error('[guardedDbExecute] usage: node guardedDbExecute.js --file <path.sql> --url <connection-string> [...other prisma db execute args]');
    process.exit(1);
  }
  const filePath = args[fileIdx + 1];
  const sql = readFileSync(filePath, 'utf8');

  const classification = classifyDangerousSql(sql);
  assertConfirmed(classification, process.env[CONFIRM_ENV_VAR]);
  if (classification.dangerous) {
    console.log(`[guardedDbExecute] destructive SQL CONFIRMED (${classification.reason}) — proceeding.`);
  }

  execFileSync('npx', ['prisma', 'db', 'execute', ...args], { stdio: 'inherit', shell: true });
}

// See logicalBackup.js for why pathToFileURL() is required here instead of
// a plain string comparison (process.argv[1] can be a relative path on
// Windows, which would silently never match import.meta.url and make
// main() never run — the guard would then do NOTHING while exiting 0).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('[guardedDbExecute] REFUSED:', err.message); process.exit(1); });
}
