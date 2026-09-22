// SAFETY WRAPPER for any `prisma` CLI invocation — classifies the command
// first (dbSafetyGuard.js), and for anything destructive (migrate reset, db
// push, migrate diff --shadow-database-url) refuses to run unless
// CONFIRM_DESTRUCTIVE_DB_OP=I_UNDERSTAND_THIS_IS_DESTRUCTIVE is set on that
// exact invocation. Non-destructive commands (migrate deploy, migrate
// status, generate, validate, studio, migrate diff without a shadow url)
// pass straight through with no friction.
//
// Usage — put "prisma" first, exactly like you would with npx:
//   node src/scripts/guardedPrismaCommand.js migrate deploy
//   node src/scripts/guardedPrismaCommand.js migrate reset          # refused without confirmation
//   CONFIRM_DESTRUCTIVE_DB_OP=I_UNDERSTAND_THIS_IS_DESTRUCTIVE \
//     node src/scripts/guardedPrismaCommand.js migrate reset        # allowed, once explicitly confirmed
//
// A `migrate diff --shadow-database-url` invocation additionally still goes
// through assertSafeShadowUrl (SHADOW_DATABASE_URL vs DATABASE_URL) — the
// confirmation flag above does NOT bypass that check; both must pass.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { classifyDangerousPrismaCommand, assertConfirmed, assertSafeShadowUrl, CONFIRM_ENV_VAR } from './dbSafetyGuard.js';

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('[guardedPrismaCommand] usage: node guardedPrismaCommand.js <prisma subcommand...>');
    process.exit(1);
  }

  const classification = classifyDangerousPrismaCommand(args);
  assertConfirmed(classification, process.env[CONFIRM_ENV_VAR]);

  if (args.includes('--shadow-database-url')) {
    // Someone typed the URL positionally instead of via env — still route
    // through the real env-var-based check for consistency with
    // prismaMigrateDiffSafe.js: refuse rather than trust an inline value.
    const idx = args.indexOf('--shadow-database-url');
    const inlineShadow = args[idx + 1];
    assertSafeShadowUrl(inlineShadow || process.env.SHADOW_DATABASE_URL, process.env.DATABASE_URL);
  }

  if (classification.dangerous) {
    console.log(`[guardedPrismaCommand] destructive command CONFIRMED (${classification.reason}) — proceeding.`);
  }
  execFileSync('npx', ['prisma', ...args], { stdio: 'inherit', shell: true });
}

// See logicalBackup.js for why pathToFileURL() is required here instead of
// a plain string comparison (process.argv[1] can be a relative path on
// Windows, which would silently never match import.meta.url and make
// main() never run — the guard would then do NOTHING while exiting 0).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('[guardedPrismaCommand] REFUSED:', err.message); process.exit(1); });
}
