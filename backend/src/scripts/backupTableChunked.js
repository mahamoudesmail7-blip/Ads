// RESILIENT, RESUMABLE, READ-ONLY dump of ONE huge append-only table (default: meta_performance_snapshots) in id-ordered chunks of gzip NDJSON.
// Why: logicalBackup.js holds a whole table in memory and dies on a dropped connection (1.7M rows / 2.3 GB). This one keeps a cursor, reconnects with back-off, writes a part file per N rows
// and a manifest (rows, id range, sha256 per part) so it can be verified and restarted where it stopped. SELECT only — never writes to the database.
//   node src/scripts/backupTableChunked.js [--table=meta_performance_snapshots] [--out=backups/<dir>] [--page=10000] [--part=100000]
//   node src/scripts/backupTableChunked.js --verify --out=backups/<dir>      (re-hash every part, re-count rows, compare with the live table)
import { mkdirSync, existsSync, readFileSync, writeFileSync, createWriteStream, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createGzip, createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { PrismaClient } from '@prisma/client';

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const TABLE = arg('table', 'meta_performance_snapshots'); if (!/^[a-z_][a-z0-9_]*$/.test(TABLE)) throw new Error('bad table name');
const OUT = arg('out', `backups/${TABLE}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`); const PAGE = Number(arg('page', 10000)); const PART_ROWS = Number(arg('part', 100000)); const VERIFY = process.argv.includes('--verify');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let prisma = new PrismaClient(); const reconnect = async () => { try { await prisma.$disconnect(); } catch { /* gone */ } prisma = new PrismaClient(); };
async function q(sql, ...params) { for (let i = 0; ; i++) { try { return await prisma.$queryRawUnsafe(sql, ...params); } catch (e) { if (i >= 8) throw e; console.log(`[chunked] retry ${i + 1} after: ${String(e.message).split('\n').filter(Boolean).pop().slice(0, 100)}`); await reconnect(); await sleep(1500 * (i + 1)); } } }
const jsonLine = (r) => JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n';
const sha256File = (f) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(f).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
mkdirSync(OUT, { recursive: true }); const manifestFile = join(OUT, 'manifest.json');
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : { table: TABLE, startedAt: new Date().toISOString(), parts: [], complete: false };
const save = () => writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

if (VERIFY) {
  let rows = 0, bad = 0;
  for (const p of manifest.parts) { const f = join(OUT, p.file); const sha = await sha256File(f); let n = 0; const rl = createInterface({ input: createReadStream(f).pipe(createGunzip()), crlfDelay: Infinity }); for await (const line of rl) { if (line) { JSON.parse(line); n++; } } if (sha !== p.sha256 || n !== p.rows) { bad++; console.log(`  ✗ ${p.file}: sha ${sha === p.sha256 ? 'ok' : 'MISMATCH'}, rows ${n}/${p.rows}`); } rows += n; }
  const live = (await q(`select count(*)::int as n, max(id)::int as max_id from "${TABLE}"`))[0]; const lastId = manifest.parts.at(-1)?.maxId ?? 0;
  const newer = (await q(`select count(*)::int as n from "${TABLE}" where id > $1`, lastId))[0].n;
  console.log(JSON.stringify({ parts: manifest.parts.length, backupRows: rows, liveRows: live.n, rowsAddedAfterBackupStart: newer, backupMatchesLiveUpToLastId: rows === live.n - newer, badParts: bad, complete: manifest.complete }));
  await prisma.$disconnect(); process.exit(bad === 0 && rows === live.n - newer && manifest.complete ? 0 : 1);
}

const endId = Number((await q(`select coalesce(max(id), 0)::int as m from "${TABLE}"`))[0].m); manifest.endIdAtStart = manifest.endIdAtStart ?? endId; save();
let cursor = manifest.parts.at(-1)?.maxId ?? 0; let part = manifest.parts.length; const t0 = Date.now();
console.log(`[chunked] ${TABLE}: resuming after id ${cursor}, up to id ${manifest.endIdAtStart}`);
while (cursor < manifest.endIdAtStart) {
  part++; const file = join(OUT, `part-${String(part).padStart(4, '0')}.ndjson.gz`); const out = createWriteStream(file); const gz = createGzip({ level: 6 }); gz.pipe(out); let rows = 0, minId = null, maxId = cursor;
  while (rows < PART_ROWS && cursor < manifest.endIdAtStart) {
    const page = await q(`select * from "${TABLE}" where id > $1 and id <= $2 order by id asc limit ${PAGE}`, cursor, manifest.endIdAtStart);
    if (!page.length) { cursor = manifest.endIdAtStart; break; }
    for (const r of page) { if (!gz.write(jsonLine(r))) await once(gz, 'drain'); } rows += page.length; minId = minId ?? Number(page[0].id); maxId = Number(page.at(-1).id); cursor = maxId;
  }
  gz.end(); await once(out, 'close'); const sha = await sha256File(file);
  manifest.parts.push({ file: file.split(/[\\/]/).pop(), rows, minId, maxId, sha256: sha }); save();
  console.log(`[chunked] part ${part}: ${rows} rows (id ${minId}..${maxId}) — total ${manifest.parts.reduce((t, p) => t + p.rows, 0)} rows, ${Math.round((Date.now() - t0) / 1000)}s`);
}
manifest.complete = true; manifest.finishedAt = new Date().toISOString(); manifest.totalRows = manifest.parts.reduce((t, p) => t + p.rows, 0); save();
console.log(`[chunked] DONE ${manifest.totalRows} rows in ${manifest.parts.length} parts → ${OUT}`);
await prisma.$disconnect(); process.exit(0);
