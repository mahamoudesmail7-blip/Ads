// SHARED pre-flight safety layer for every dangerous database operation in
// this repo — the single place that knows what "dangerous" looks like, so a
// new guarded wrapper never has to reinvent the classification rules.
//
// Born from the 2026-09-13 incident (prisma migrate diff --shadow-database-url
// run with the real production DATABASE_URL — see docs/DISASTER_RECOVERY.md
// and feedback_prisma_shadow_database_incident in memory). That incident's
// specific check (assertSafeShadowUrl) lives here now too, so
// prismaMigrateDiffSafe.js and any other guarded wrapper share ONE
// implementation instead of two copies that could drift apart.
//
// Design choice: rather than trying to detect "is this production" (which
// would require hardcoding or hashing a real host/db name into source —
// exactly the kind of infrastructure detail that shouldn't live in a
// committed file), every genuinely destructive operation instead requires
// an explicit, hard-to-fat-finger confirmation env var for that ONE
// invocation. No environment is ever implicitly "safe" — a destructive
// command against ANY database (prod or not) must be deliberately
// confirmed every single time.

export const CONFIRM_ENV_VAR = 'CONFIRM_DESTRUCTIVE_DB_OP';
export const CONFIRM_VALUE = 'I_UNDERSTAND_THIS_IS_DESTRUCTIVE';

/** {host, database} — the two independent axes that must BOTH differ for a shadow database to be considered genuinely separate. Query params (sslmode, channel_binding, pooling flags) and credentials never make two URLs point at different databases, so they're deliberately ignored. */
function parseParts(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase(), database: u.pathname.toLowerCase(), raw: false };
  } catch {
    const s = String(url || '').trim().toLowerCase();
    return { host: s, database: s, raw: true };
  }
}

/**
 * Fails closed on every axis the 2026-09-13 incident (and its near-miss
 * variants) could recur through: identical URLs, same host with a
 * different-looking database, same database name reused on a different
 * host, or either value missing outright. A shadow database is only
 * accepted when it is genuinely separate on BOTH host and database name.
 */
export function assertSafeShadowUrl(shadowUrl, realUrl) {
  if (!shadowUrl) {
    throw new Error('SHADOW_DATABASE_URL غير مضبوط. لازم تحدد قاعدة بيانات مؤقتة/تجريبية منفصلة تمامًا عن DATABASE_URL — لا تستخدم إعادة توجيه فارغ أو نسيان تصديرها.');
  }
  if (!realUrl) {
    throw new Error('DATABASE_URL غير مضبوط في البيئة الحالية — لا يمكن التأكد إن SHADOW_DATABASE_URL مختلفة عنها.');
  }

  const shadow = parseParts(shadowUrl);
  const real = parseParts(realUrl);

  if (shadowUrl === realUrl) {
    throw new Error('SHADOW_DATABASE_URL نفس نص DATABASE_URL بالحرف الواحد! هذا بالظبط اللي سبب فقدان بيانات الإنتاج بالكامل في 2026-09-13.');
  }
  if (shadow.raw || real.raw) {
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

// Known-destructive Prisma CLI subcommand shapes. Matched against a
// normalized, space-joined argv (e.g. "migrate reset", "db push",
// "db push --force-reset", "migrate diff --shadow-database-url ...").
const DANGEROUS_PRISMA_PATTERNS = [
  { test: (a) => a.includes('migrate') && a.includes('reset'), reason: '`prisma migrate reset` DROPS every table and re-applies migrations from scratch.' },
  { test: (a) => a.includes('db') && a.includes('push'), reason: '`prisma db push` can silently drop/alter columns to force the DB to match the schema, with no migration history and no undo.' },
  { test: (a) => a.includes('migrate') && a.includes('diff') && a.includes('--shadow-database-url'), reason: '`prisma migrate diff --shadow-database-url` replaces the ENTIRE contents of whatever URL is passed as the shadow — the exact 2026-09-13 incident.' },
];

// Raw-SQL destructive keyword patterns — checked against SQL file content
// before it is ever sent to `prisma db execute --file`. Deliberately
// keyword-based and case-insensitive rather than a full SQL parser: false
// positives (a comment mentioning "drop") just mean an extra confirmation
// step, which is the safe direction to err in.
const DANGEROUS_SQL_PATTERNS = [
  { re: /\bDROP\s+DATABASE\b/i, reason: 'DROP DATABASE — destroys an entire database.' },
  { re: /\bDROP\s+SCHEMA\b/i, reason: 'DROP SCHEMA — destroys every table/type/etc. in a schema.' },
  { re: /\bTRUNCATE\b/i, reason: 'TRUNCATE — irreversibly empties a table.' },
  { re: /\bDROP\s+TABLE\b/i, reason: 'DROP TABLE — irreversibly deletes a table and all its data.' },
  { re: /\bDELETE\s+FROM\s+[^\s;]+\s*(;|$)/im, reason: 'DELETE FROM <table> with no WHERE clause — deletes every row in the table.' },
  { re: /\bUPDATE\s+[^\s]+\s+SET\b(?![\s\S]*\bWHERE\b)/i, reason: 'UPDATE ... SET with no WHERE clause — overwrites every row in the table.' },
];

/** Pure classifier — no side effects, safe to unit-test with any fake argv array. */
export function classifyDangerousPrismaCommand(argv) {
  const normalized = (argv || []).join(' ').toLowerCase();
  for (const p of DANGEROUS_PRISMA_PATTERNS) {
    if (p.test(normalized)) return { dangerous: true, reason: p.reason };
  }
  return { dangerous: false, reason: null };
}

/** Pure classifier — no side effects, safe to unit-test with any fake SQL string (never reads a real file itself; the caller decides what content to pass in). */
export function classifyDangerousSql(sqlText) {
  const text = String(sqlText || '');
  for (const p of DANGEROUS_SQL_PATTERNS) {
    if (p.re.test(text)) return { dangerous: true, reason: p.reason };
  }
  return { dangerous: false, reason: null };
}

/**
 * The actual gate: given a classification result, throws unless the exact
 * confirmation string is present in the given env-var value. Every
 * destructive op needs this confirmed FRESH for that one invocation —
 * setting it once and forgetting to unset it is a known risk, so callers
 * are expected to set it inline (`CONFIRM_DESTRUCTIVE_DB_OP=... command`),
 * not export it persistently.
 */
export function assertConfirmed(classification, confirmEnvValue) {
  if (!classification.dangerous) return;
  if (confirmEnvValue === CONFIRM_VALUE) return;
  throw new Error(
    `عملية خطيرة اتوقفت: ${classification.reason}\n` +
    `لو متأكد إنك عايز تكمل، شغّل الأمر تاني مع ${CONFIRM_ENV_VAR}=${CONFIRM_VALUE} مضاف لنفس السطر (مش exported بشكل دائم) — ` +
    'وتأكد الأول إن الاتصال ده مش قاعدة بيانات الإنتاج.'
  );
}
