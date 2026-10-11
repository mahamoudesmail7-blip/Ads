// Test environment manager for the FAST local PostgreSQL target (see backend/tools/localpg).
//   ensureLocalPg()      starts the local server (detached) when it is not already running
//   ensureBaseDb()       creates/refreshes the BASE database `optest_base` (schema from prisma/schema.prisma via `db push`, marker row + fixture catalog + test owner via testDb.mjs seed); it is rebuilt only when
//                        prisma/schema.prisma or the seed code changed (hash stored next to the data directory)
//   cloneDb(name)        CREATE DATABASE <name> TEMPLATE optest_base — a pristine, fully seeded copy in ~1 s; every suite (and every parallel worker) gets its OWN copy, so suites cannot affect each other
//   dropDb(name)         DROP DATABASE … (only names starting with optest_)
// Nothing here can reach Neon or production: the connection is always 127.0.0.1:54329 and every database name must start with `optest_`.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
const here = path.dirname(fileURLToPath(import.meta.url)); const BACKEND = path.resolve(here, '../..');
const LOCALPG = path.join(BACKEND, 'tools/localpg/localPg.mjs');
const { HOME, PORT, USER, PASSWORD, isUp, pgModuleUrl } = await import(pathToUrl(LOCALPG));
function pathToUrl(p) { return 'file:///' + p.replace(/\\/g, '/'); }
export const BASE_DB = 'optest_base';
export const localUrl = (db) => `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${db}?connection_limit=6&pool_timeout=30&connect_timeout=15`;
const assertName = (n) => { if (!/^optest_[A-Za-z0-9_]+$/.test(n)) throw new Error(`refusing: "${n}" is not an optest_* database name`); return n; };

export async function ensureLocalPg() {
  if (await isUp()) return { started: false };
  const child = spawn(process.execPath, [LOCALPG, 'serve'], { cwd: BACKEND, detached: true, stdio: 'ignore', windowsHide: true }); child.unref();
  for (let i = 0; i < 180; i++) { if (await isUp()) return { started: true }; await sleep(500); }
  throw new Error('the local PostgreSQL did not come up within 90 s (see %LOCALAPPDATA%\\optest-pg)');
}
let pgMod = null;
async function admin() { pgMod = pgMod || (await import(pgModuleUrl())).default; const c = new pgMod.Client({ host: '127.0.0.1', port: PORT, user: USER, password: PASSWORD, database: 'postgres' }); await c.connect(); return c; }
async function exists(c, db) { return (await c.query('select 1 from pg_database where datname = $1', [db])).rowCount === 1; }
const hashOf = () => createHash('sha256').update('v3-seq').update(fs.readFileSync(path.join(BACKEND, 'prisma/schema.prisma'))).update(fs.readFileSync(path.join(here, 'testDb.mjs'))).digest('hex').slice(0, 16);
const stampFile = path.join(HOME, 'base.stamp');
const SEQUENCE_SQL = `DO $$ DECLARE r record; BEGIN FOR r IN SELECT c.table_name, c.column_name, pg_get_serial_sequence('public.' || quote_ident(c.table_name), c.column_name) AS seq FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.column_default LIKE 'nextval%' LOOP EXECUTE format('SELECT setval(%L, GREATEST((SELECT COALESCE(MAX(%I), 0) FROM public.%I), 1000))', r.seq, r.column_name, r.table_name); END LOOP; END $$;`;

export async function ensureBaseDb({ force = false, log = () => {} } = {}) {
  const c = await admin();
  try {
    const stamp = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : ''; const want = hashOf();
    if (!force && stamp === want && await exists(c, BASE_DB)) return { rebuilt: false };
    log('building the base test database (schema + fixtures) …');
    await c.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${BASE_DB}'`);
    await c.query(`drop database if exists ${BASE_DB}`); await c.query(`create database ${BASE_DB}`);
  } finally { await c.end(); }
  const env = { ...process.env, TEST_DB_TARGET: 'local', LOCAL_TEST_DATABASE_URL: localUrl(BASE_DB), DATABASE_URL: localUrl(BASE_DB) }; delete env.DIRECT_DATABASE_URL;
  const push = spawnSync(process.execPath, [path.join(BACKEND, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--accept-data-loss'], { cwd: BACKEND, env, encoding: 'utf8' });
  if (push.status !== 0) throw new Error('prisma db push failed on the local base database:\n' + String(push.stdout + push.stderr).slice(-1500));
  const seed = spawnSync(process.execPath, [path.join(here, 'testDb.mjs'), 'seed'], { cwd: BACKEND, env, encoding: 'utf8' });
  if (seed.status !== 0) throw new Error('testDb seed failed on the local base database:\n' + String(seed.stdout + seed.stderr).slice(-1500));
  // factory-default operator state (the GLOBAL config row, SHADOW, permissions OFF) — the Neon runner did this before EVERY suite; with a fresh clone per suite it is part of the template instead
  const reset = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./src/scripts/testDb.mjs').then((m) => m.resetTestDatabaseState()).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); })"], { cwd: BACKEND, env, encoding: 'utf8' });
  if (reset.status !== 0) throw new Error('factory-default operator state failed on the local base database:\n' + String(reset.stdout + reset.stderr).slice(-800));
  // the seed inserts explicit ids (user #1, fixture products); on Neon the sequences were already far ahead — here every serial sequence starts at 1000+ so a suite's autoincrement never collides with a seeded id
  { pgMod = pgMod || (await import(pgModuleUrl())).default; const bc = new pgMod.Client({ host: '127.0.0.1', port: PORT, user: USER, password: PASSWORD, database: BASE_DB }); await bc.connect(); try { await bc.query(SEQUENCE_SQL); } finally { await bc.end(); } }
  fs.writeFileSync(stampFile, hashOf()); return { rebuilt: true };
}
export async function cloneDb(name) {
  assertName(name); const c = await admin();
  try { await c.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${assertName(name)}'`); await c.query(`drop database if exists ${name}`); await c.query(`create database ${name} template ${BASE_DB}`); } finally { await c.end(); }
  return localUrl(name);
}
export async function dropDb(name) { assertName(name); const c = await admin(); try { await c.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}'`); await c.query(`drop database if exists ${name}`); } finally { await c.end(); } }
/** Drops leftovers of runs that are DEAD (database names end with the pid of the process that created them). A database whose owner is still alive is never touched, so two runners / a runner and an audit can work side by side. */
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export async function dropAllWorkerDbs() { const c = await admin(); try { const r = await c.query(`select datname from pg_database where datname like 'optest\_%' and datname <> '${BASE_DB}'`); let n = 0; for (const { datname } of r.rows) { const m = datname.match(/_(\d+)$/); if (m && pidAlive(Number(m[1]))) continue; await c.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${datname}'`); await c.query(`drop database if exists ${datname}`); n++; } return n; } finally { await c.end(); } }