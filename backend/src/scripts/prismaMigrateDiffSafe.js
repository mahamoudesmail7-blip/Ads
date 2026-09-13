// SAFETY WRAPPER around `prisma migrate diff --shadow-database-url ...`.
//
// Incident (2026-09-13): `prisma migrate diff --shadow-database-url` was
// run with the REAL production DATABASE_URL passed as the "shadow"
// database. Prisma treats a shadow database as fully disposable scratch
// space — it replays the entire migration history into it to compute a
// diff. Pointing that at production wiped every table's data (schema
// stayed intact; every row across all 78 tables was gone).
//
// This script is the ONLY supported way to run `prisma migrate diff` with
// a shadow database in this repo from now on. It refuses to run — before
// shelling out to prisma at all — unless the shadow URL is a DIFFERENT
// database from DATABASE_URL. Never call `npx prisma migrate diff
// --shadow-database-url` directly with $DATABASE_URL again.
//
// Usage:
//   SHADOW_DATABASE_URL=<a real scratch/throwaway db> \
//     node src/scripts/prismaMigrateDiffSafe.js --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script
//
// (Any extra CLI args are passed straight through to `prisma migrate diff`.)
import { execFileSync } from 'node:child_process';

/** {host, database} — the two independent axes that must BOTH differ. Query params (sslmode, channel_binding, pooling flags) and credentials never make two URLs point at different databases, so they're deliberately ignored. */
function parseParts(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase(), database: u.pathname.toLowerCase(), raw: false };
  } catch {
    // Not a parseable URL at all — treat the whole string as both "host" and
    // "database" so an exact-string match (the only thing we can still
    // detect) is still caught, and log that parsing failed rather than
    // silently declaring it safe.
    const s = String(url || '').trim().toLowerCase();
    return { host: s, database: s, raw: true };
  }
}

/**
 * Fails closed on every axis the 2026-09-13 incident (and its near-miss
 * variants) could recur through: identical URLs, same host with a
 * different-looking database, same database name reused on a different
 * host, or either value missing outright. A shadow database is only
 * accepted when it is genuinely separate on BOTH host and database name —
 * matching on just one axis is exactly the kind of "looks different enough"
 * mistake this guard exists to catch.
 */
export function assertSafeShadowUrl(shadowUrl, realUrl) {
  if (!shadowUrl) {
    throw new Error('SHADOW_DATABASE_URL غير مضبوط. لازم تحدد قاعدة بيانات مؤقتة/تجريبية منفصلة تمامًا عن DATABASE_URL — لا تستخدم إعادة توجيه فارغ أو نسيان تصديرها.');
  }
  if (!realUrl) {
    // DATABASE_URL missing entirely means there is nothing to compare
    // against — refuse rather than silently "passing" the check.
    throw new Error('DATABASE_URL غير مضبوط في البيئة الحالية — لا يمكن التأكد إن SHADOW_DATABASE_URL مختلفة عنها.');
  }

  const shadow = parseParts(shadowUrl);
  const real = parseParts(realUrl);

  if (shadowUrl === realUrl) {
    throw new Error('SHADOW_DATABASE_URL نفس نص DATABASE_URL بالحرف الواحد! هذا بالظبط اللي سبب فقدان بيانات الإنتاج بالكامل في 2026-09-13.');
  }
  if (shadow.raw || real.raw) {
    // Couldn't parse one of them as a URL at all — never guess "probably fine".
    throw new Error('تعذّر تحليل SHADOW_DATABASE_URL أو DATABASE_URL كـ connection string صالح — تأكد من الصيغة قبل المتابعة (لن يُسمح بالتشغيل بدون تأكيد أنهما فعلاً قاعدتان مختلفتان).');
  }
  if (shadow.host === real.host && shadow.database === real.database) {
    throw new Error(
      'SHADOW_DATABASE_URL نفس DATABASE_URL (نفس الـ host ونفس اسم قاعدة البيانات)! ' +
      'هذا بالظبط اللي سبب فقدان بيانات الإنتاج بالكامل في 2026-09-13 — ' +
      '"شادو" قاعدة بيانات في Prisma بيتم استبدال محتواها بالكامل.'
    );
  }
  if (shadow.host === real.host) {
    throw new Error(
      `SHADOW_DATABASE_URL بيستخدم نفس الـ host بتاع الإنتاج (${real.host}) حتى لو اسم قاعدة البيانات مختلف. ` +
      'ده لسه خطر — لازم تستخدم سيرفر/فرع منفصل تمامًا عن الإنتاج، مش نفس السيرفر باسم قاعدة بيانات مختلف.'
    );
  }
  if (shadow.database === real.database) {
    throw new Error(
      `SHADOW_DATABASE_URL بيستخدم نفس اسم قاعدة بيانات الإنتاج (${real.database}) حتى لو على host مختلف. ` +
      'اسم متطابق بالصدفة أو بالخطأ لسه بيزود احتمال تنفيذ الأمر على القاعدة الغلط — استخدم اسم قاعدة بيانات تجريبي مختلف بوضوح.'
    );
  }
}

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
// not when assertSafeShadowUrl is imported for its own unit tests.
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  main().catch((err) => { console.error('[prismaMigrateDiffSafe] REFUSED:', err.message); process.exit(1); });
}
