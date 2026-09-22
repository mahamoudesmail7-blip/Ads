// SAFETY WRAPPER around `prisma migrate diff --shadow-database-url ...`.
//
// Incident (2026-09-13): `prisma migrate diff --shadow-database-url` was
// run with the REAL production DATABASE_URL passed as the "shadow"
// database. Prisma treats a shadow database as fully disposable scratch
// space — it replays the entire migration history into it to compute a
// diff. Pointing that at production wiped every table's data (schema
// stayed intact; every row across all 78 tables was gone). Full incident
// writeup: docs/DISASTER_RECOVERY.md.
//
// This script is the ONLY supported way to run `prisma migrate diff` with
// a shadow database in this repo from now on. It refuses to run — before
// shelling out to prisma at all — unless the shadow URL is a DIFFERENT
// database from DATABASE_URL. Never call `npx prisma migrate diff
// --shadow-database-url` directly with $DATABASE_URL again.
//
// The actual classification/comparison logic lives in the shared
// dbSafetyGuard.js so every guarded wrapper (this one, guardedPrismaCommand.js,
// guardedDbExecute.js) uses the exact same rules instead of drifting apart.
//
// Usage:
//   SHADOW_DATABASE_URL=<a real scratch/throwaway db> \
//     node src/scripts/prismaMigrateDiffSafe.js --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script
//
// (Any extra CLI args are passed straight through to `prisma migrate diff`.)
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertSafeShadowUrl } from './dbSafetyGuard.js';

export { assertSafeShadowUrl };

async function main() {
  const shadowUrl = process.env.SHADOW_DATABASE_URL;
  const realUrl = process.env.DATABASE_URL;
  assertSafeShadowUrl(shadowUrl, realUrl);

  const extraArgs = process.argv.slice(2);
  const args = ['prisma', 'migrate', 'diff', '--shadow-database-url', shadowUrl, ...extraArgs];
  console.log('[prismaMigrateDiffSafe] shadow URL verified distinct from DATABASE_URL — proceeding.');
  execFileSync('npx', args, { stdio: 'inherit', shell: true });
}

// Only auto-run when executed directly (`node prismaMigrateDiffSafe.js`),
// not when assertSafeShadowUrl is imported for its own unit tests. Uses
// pathToFileURL() rather than a plain string comparison because
// process.argv[1] can be a relative path on Windows, which would silently
// never match import.meta.url and make main() never run (exiting 0 having
// done nothing at all — see logicalBackup.js for the full explanation).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('[prismaMigrateDiffSafe] REFUSED:', err.message); process.exit(1); });
}
