// INDEPENDENT LOGICAL BACKUP — the third recovery layer alongside Neon's
// own Point-in-Time Recovery. The 2026-09-13 incident proved a short PITR
// window alone isn't enough for long-term recovery confidence; this script
// is a plan-independent, always-available fallback that works regardless of
// which Neon tier is active.
//
// READ-ONLY against the database: every table is paginated through with
// plain findMany() calls — NEVER create/update/delete/upsert/executeRaw, and
// no SQL write of any kind. Output is ONE combined gzip-compressed JSON file
// (every model's rows, keyed by model name) plus a manifest and a SHA-256
// checksum file — nothing is ever written back to the database.
//
// NEVER auto-run on deploy, on boot, or on any schedule by itself — this
// repo has no cron/scheduler wired to it. An operator runs it explicitly:
//   node src/scripts/logicalBackup.js                        # all tables
//   node src/scripts/logicalBackup.js --only=user,product    # just some
//   node src/scripts/logicalBackup.js --out=/some/other/dir
//
// Output lands under backend/backups/ (git-ignored — never commit a
// backup; it contains real customer names/phones/addresses). backend/ is
// explicitly blocked from static serving in server.js
// (/^\/(backend|\.git|\.env)/i -> 404 before express.static ever runs), so
// this location is never web-reachable.
import { writeFileSync, mkdirSync, readFileSync, createWriteStream, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createGzip, createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { prisma } from '../prisma.js';

const PAGE_SIZE = 5000;

function parseArgs(argv) {
  const out = { only: null, outDir: null };
  for (const a of argv) {
    if (a.startsWith('--only=')) out.only = a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--out=')) out.outDir = a.slice('--out='.length);
  }
  return out;
}

function currentGitCommit() {
  try { return execSync('git rev-parse HEAD', { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' }).trim(); }
  catch { return null; }
}

/** Every real Prisma model accessor on the generated client — introspected at runtime so this never goes stale when the schema grows, instead of a hand-maintained list that drifts. */
function allModelNames() {
  return Object.keys(prisma).filter((k) => !k.startsWith('$') && !k.startsWith('_') && typeof prisma[k]?.findMany === 'function');
}

/**
 * Every row of one model, paginated. READ-ONLY: only ever calls
 * findMany() — never create/update/delete/upsert, never a raw SQL write.
 * Cursor-paginated by `id` (every model in this schema uses a plain
 * integer `id` primary key — confirmed against prisma/schema.prisma, no
 * composite-key models exist), falling back to a single findMany() only if
 * that assumption is ever wrong for some future model (defensive, not
 * expected to trigger today).
 */
async function fetchAllRows(modelName) {
  let cursor;
  const rows = [];
  for (;;) {
    const page = await prisma[modelName].findMany({
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    }).catch(async () => prisma[modelName].findMany());
    if (!page.length) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE || page[page.length - 1]?.id === undefined) break;
    cursor = page[page.length - 1].id;
  }
  return rows;
}

function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function pad(n) { return String(n).padStart(2, '0'); }
function timestampLabel(d = new Date()) {
  // YYYY-MM-DD-HHmm in UTC, matching backup-YYYY-MM-DD-HHMM used for git tags.
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

// Output format: JSON LINES (one JSON object per line) inside the gzip
// stream, NOT one giant JSON document. This is deliberate, not
// stylistic — an early version built one combined JS string via
// JSON.stringify(hugeObject) and hit V8's hard string-length ceiling
// ("Invalid string length") because this database's real content includes
// large base64 image blobs (cfBlob, productMarketingImage, etc.) alongside
// ~190k+ ordinary rows. Streaming line-by-line means no single string or
// buffer of the full dataset's size is EVER constructed, on write or on
// verify — only Buffers (which don't share JS strings' length ceiling) and
// bounded per-line chunks.
//   Line 1:      {"type":"meta","createdAtUtc":...,"models":["user","product",...]}
//   Line 2..N-1: {"type":"row","model":"user","data":{...}}
//   Line N:      {"type":"end","tableCount":N}
// The "meta" line's `models` list is what lets a verifier tell "this table
// legitimately has zero rows" apart from "this table was never attempted" —
// a table with zero rows never gets a "row" line at all, so without this
// list a naive verifier can misreport a real 0-row table as missing.
async function* backupLines(models, onProgress) {
  yield JSON.stringify({ type: 'meta', createdAtUtc: new Date().toISOString(), models }) + '\n';
  for (const model of models) {
    let cursor;
    let count = 0;
    for (;;) {
      const page = await prisma[model].findMany({
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      }).catch(async () => prisma[model].findMany());
      if (!page.length) break;
      for (const row of page) yield JSON.stringify({ type: 'row', model, data: row }) + '\n';
      count += page.length;
      if (page.length < PAGE_SIZE || page[page.length - 1]?.id === undefined) break;
      cursor = page[page.length - 1].id;
    }
    onProgress(model, count);
  }
  yield JSON.stringify({ type: 'end', tableCount: models.length }) + '\n';
}

async function main() {
  const { only, outDir } = parseArgs(process.argv.slice(2));
  const available = allModelNames();
  const models = (only && only.length ? only : available).filter((m) => available.includes(m));
  const skipped = (only || []).filter((m) => !available.includes(m));
  if (skipped.length) console.warn('[logicalBackup] unknown model names ignored:', skipped.join(', '));

  const dir = outDir || fileURLToPath(new URL('../../backups/', import.meta.url));
  mkdirSync(dir, { recursive: true });

  const label = timestampLabel();
  const baseName = `prod-${label}`;
  const dataFile = join(dir, `${baseName}.json.gz`);
  const manifestFile = join(dir, `${baseName}.manifest.json`);
  const sha256File = join(dir, `${baseName}.sha256`);

  const startedAt = Date.now();
  const counts = {};
  await pipeline(
    Readable.from(backupLines(models, (model, count) => { counts[model] = count; console.log(`[logicalBackup] ${model} ... ${count} rows`); })),
    createGzip(),
    createWriteStream(dataFile),
  );

  // Hashing the already-gzipped file: a Buffer, not a decoded JS string —
  // Buffers don't share the string-length ceiling that caused this
  // rewrite, and the compressed file is far smaller than the raw data
  // anyway, so reading it whole here is safe regardless of dataset size.
  const checksum = sha256Of(readFileSync(dataFile));
  writeFileSync(sha256File, `${checksum}  ${baseName}.json.gz\n`, 'utf8');

  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
  const manifest = {
    createdAtUtc: new Date().toISOString(),
    gitCommit: currentGitCommit(),
    databaseProvider: 'Neon (PostgreSQL)',
    databaseName: 'neondb',
    format: 'gzip-compressed JSON Lines (one JSON object per line: a {type:"meta"} header, then {type:"row",model,data} per row, then {type:"end"}) — NOT a single JSON document; see the comment above backupLines().',
    tableCount: models.length,
    totalRows,
    rowCountsByTable: counts,
    backupFilename: `${baseName}.json.gz`,
    checksumSha256: checksum,
    checksumFile: `${baseName}.sha256`,
    durationMs: Date.now() - startedAt,
  };
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`\n[logicalBackup] done -> ${dataFile}`);
  console.log(`[logicalBackup] ${totalRows} total rows across ${models.length} tables in ${manifest.durationMs}ms`);
  console.log(`[logicalBackup] sha256: ${checksum}`);
  return { dataFile, manifestFile, sha256File, manifest };
}

/**
 * Structural, read-only validation of an already-created backup —
 * decompresses and scans it LINE BY LINE (never materializing the full
 * decompressed content as one string/buffer, for the same string-length
 * reason backupLines() streams on write), re-derives the checksum, and
 * counts rows per model. Never writes anything, never touches the
 * database.
 */
export async function verifyBackupFile(dataFile, expectedSha256) {
  const actualSha256 = sha256Of(readFileSync(dataFile));
  const checksumMatch = actualSha256 === expectedSha256;

  const rowCounts = {};
  let attemptedModels = null; // from the meta line's `models` list — lets a genuinely-empty table read as 0, not "missing"
  let gzipOk = true;
  let sawEnd = false;
  let buffered = '';
  try {
    const gunzipStream = createReadStream(dataFile).pipe(createGunzip());
    for await (const chunk of gunzipStream) {
      buffered += chunk.toString('utf8');
      let nl;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        const obj = JSON.parse(line);
        if (obj.type === 'meta' && Array.isArray(obj.models)) {
          attemptedModels = obj.models;
          for (const m of obj.models) rowCounts[m] = 0;
        }
        if (obj.type === 'row') rowCounts[obj.model] = (rowCounts[obj.model] || 0) + 1;
        if (obj.type === 'end') sawEnd = true;
      }
    }
  } catch {
    gzipOk = false;
  }

  const modelCount = attemptedModels ? attemptedModels.length : Object.keys(rowCounts).length;
  const totalRows = Object.values(rowCounts).reduce((a, b) => a + b, 0);
  return { checksumMatch, actualSha256, gzipOk, modelCount, rowCounts, totalRows, sawEnd };
}

// Windows note: process.argv[1] can be a relative path (e.g. when invoked
// as `node src/scripts/logicalBackup.js` from bash) — a plain string
// comparison against import.meta.url (always an absolute, URL-encoded
// file:// URL) silently never matches on Windows, which would make main()
// never run at all while still exiting 0. pathToFileURL() normalizes both
// relative and absolute argv[1] into the same absolute-URL form import.meta.url
// already uses, so the comparison is reliable on every OS.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('[logicalBackup] FAILED:', err.message); process.exit(1); });
}

export { allModelNames, parseArgs, fetchAllRows, sha256Of };
