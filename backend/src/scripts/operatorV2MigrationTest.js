// 🧪 AI Operator V2 — the migration (20261013120000_operator_v2_views: two NEW tables) on throw-away LOCAL databases, never near production.
//   1) a database WITH DATA on the old schema: apply → nothing else changes (counts, columns, indexes, foreign keys of every existing table identical), the two tables appear empty, schema == Prisma datamodel
//   2) rollback.sql returns the schema EXACTLY to the old state, data untouched; the migration can be applied again; a second apply is refused (no duplicates)
//   3) an EMPTY database + the full migration history (prisma migrate deploy): works, both tables exist, the migration is recorded
//   4) new code before the migration (tables missing): home / campaigns / export keep working, views + snapshots answer a clear 503 V2_TABLES_MISSING; after the migration they work; no legacy code touches the tables
// LOCAL-ONLY (needs throw-away databases): on the Neon test branch use  node src/scripts/v2MigrationNeon.mjs
//   node src/scripts/operatorV2MigrationTest.js        (run by the local runner: TEST_DB_TARGET=local)
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
const __dirname = dirname(fileURLToPath(import.meta.url)); const BACKEND = join(__dirname, '..', '..'); const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0; const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };
if (process.env.TEST_DB_TARGET !== 'local') { console.log('SKIPPED — local-only suite (needs throw-away databases). On the Neon test branch run: node src/scripts/v2MigrationNeon.mjs'); process.exit(0); }

const TE = await imp('./testEnv.mjs'); const MIG = '20261013120000_operator_v2_views'; const MIG_DIR = join(BACKEND, 'prisma', 'migrations', MIG); const NEW_TABLES = ['amb_operator_saved_views', 'amb_operator_selection_snapshots'];
const CLI = join(BACKEND, 'node_modules', 'prisma', 'build', 'index.js'); const SCHEMA = join(BACKEND, 'prisma', 'schema.prisma');
const cli = (url, args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: BACKEND, env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url, ...(extra.env || {}) }, encoding: 'utf8', input: extra.input, timeout: 240_000 });
const exec = (url, file) => cli(url, ['db', 'execute', '--url', url, '--file', file]);
const diff = (url) => cli(url, ['migrate', 'diff', '--from-url', url, '--to-schema-datamodel', SCHEMA, '--exit-code']);
const made = []; const mkDb = async (tag) => { const name = `optest_v2mig_${tag}_${process.pid}`; made.push(name); return { name, url: await TE.cloneDb(name) }; };
const client = (url) => new PrismaClient({ datasourceUrl: url }); const q = (c, sql) => c.$queryRawUnsafe(sql);

async function snapshot(c) {
  const tables = (await q(c, `select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`)).map((r) => r.table_name); const counts = {};
  for (const t of tables) counts[t] = Number((await q(c, `select count(*)::int as n from "${t}"`))[0].n);
  const cols = (await q(c, `select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' order by 1,2`)).map((r) => JSON.stringify(r));
  const idx = (await q(c, `select tablename, indexname, indexdef from pg_indexes where schemaname='public' order by 1,2`)).map((r) => JSON.stringify(r));
  const fks = (await q(c, `select conrelid::regclass::text as t, conname, confrelid::regclass::text as r from pg_constraint where contype='f' order by 1,2`)).map((r) => JSON.stringify(r));
  return { tables, counts, cols, idx, fks };
}
const old = (s) => ({ tables: s.tables.filter((t) => !NEW_TABLES.includes(t)), counts: Object.fromEntries(Object.entries(s.counts).filter(([t]) => !NEW_TABLES.includes(t))), cols: s.cols.filter((x) => !NEW_TABLES.includes(JSON.parse(x).table_name)), idx: s.idx.filter((x) => !NEW_TABLES.includes(JSON.parse(x).tablename)), fks: s.fks.filter((x) => { const f = JSON.parse(x); return !NEW_TABLES.some((t) => f.t.includes(t) || f.r.includes(t)); }) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  await TE.ensureLocalPg();
  console.log('\n1. A database WITH DATA on the old schema (before the migration)');
  const A = await mkDb('a'); const cA = client(A.url);
  await q(cA, `drop table if exists ${NEW_TABLES.map((t) => `"${t}"`).join(', ')}`);
  // make it a realistic database: users, products, a sync run with 300 snapshot rows, operator events and a saved decision on top of the fixtures
  { const stamp = Date.now(); await cA.user.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ email: `v2mig_${stamp}_${i}@example.invalid`, password_hash: 'x'.repeat(20), name: `v2mig ${i}`, role: i % 5 === 0 ? 'MANAGER' : 'EMPLOYEE', status: 'ACTIVE', permissions: JSON.stringify(i % 2 ? { 'operator.view': true, 'operator.accounts': ['act_x'] } : {}) })) });
    await cA.product.createMany({ data: Array.from({ length: 50 }, (_, i) => ({ product_name: `v2mig p${i}`, product_code: `v2mig_${stamp}_${i}`, store_id: 'default', selling_price: 100 + i, product_cost: 40 })) });
    const run = await cA.ambSyncRun.create({ data: { status: 'SUCCESS', ad_account_id: 'act_v2mig', finished_at: new Date() } });
    await cA.metaPerformanceSnapshot.createMany({ data: Array.from({ length: 300 }, (_, i) => ({ sync_run_id: run.id, ad_account_id: 'act_v2mig', level: 'campaign', date_start: '2026-10-01', date_stop: '2026-10-01', campaign_id: `v2mig_c${i}`, campaign_name: `c${i}`, campaign_status: 'ACTIVE', spend: 10 + i, meta_purchases: i % 4, snapshot_at: new Date() })) });
    await cA.ambOperatorEvent.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ kind: 'V2_MIG_FIXTURE', actor: 'SYSTEM', note: `event ${i}` })) }); }
  const before = await snapshot(cA); const rowsBefore = Object.values(before.counts).reduce((t, n) => t + n, 0);
  ok('the old-schema database has real data (fixtures + 20 users, 50 products, 300 snapshot rows, 100 events) and neither new table', rowsBefore > 450 && before.counts.users >= 20 && before.counts.meta_performance_snapshots >= 300 && NEW_TABLES.every((t) => !before.tables.includes(t)), JSON.stringify({ rowsBefore, users: before.counts.users }));
  const ap = exec(A.url, join(MIG_DIR, 'migration.sql')); ok('the migration SQL applies cleanly (exit 0)', ap.status === 0, (ap.stdout + ap.stderr).slice(-400));
  const after = await snapshot(cA);
  ok('exactly two tables were added and no table disappeared or was renamed (no name clash)', same(after.tables.filter((t) => !NEW_TABLES.includes(t)), before.tables) && after.tables.length === before.tables.length + 2 && NEW_TABLES.every((t) => after.tables.includes(t)));
  ok('NO DATA LOSS: the row count of every existing table is identical before and after', same(old(after).counts, before.counts), JSON.stringify(Object.keys(before.counts).filter((t) => before.counts[t] !== after.counts[t])));
  ok('no existing table was altered: columns, defaults, indexes and foreign keys of all existing tables are byte-identical', same(old(after).cols, before.cols) && same(old(after).idx, before.idx) && same(old(after).fks, before.fks));
  ok('the new tables are empty and have NO foreign key in either direction (old code deleting users / products can never be blocked by them)', NEW_TABLES.every((t) => after.counts[t] === 0) && after.fks.filter((x) => NEW_TABLES.some((t) => x.includes(t))).length === 0 && same(after.fks, before.fks));
  const nc = (await q(cA, `select table_name, column_name from information_schema.columns where table_schema='public' and table_name in ('amb_operator_saved_views','amb_operator_selection_snapshots') order by 1, ordinal_position`)).map((r) => `${r.table_name}.${r.column_name}`);
  ok('the new tables carry exactly the designed columns (owner, scope, name, config / query, ids hash, expiry …) and nothing sensitive (no tokens, no credentials)', same(nc, ['amb_operator_saved_views.id','amb_operator_saved_views.owner_id','amb_operator_saved_views.scope','amb_operator_saved_views.name','amb_operator_saved_views.config_json','amb_operator_saved_views.shared','amb_operator_saved_views.shared_min_role','amb_operator_saved_views.created_at','amb_operator_saved_views.updated_at','amb_operator_selection_snapshots.id','amb_operator_selection_snapshots.owner_id','amb_operator_selection_snapshots.scope','amb_operator_selection_snapshots.query_json','amb_operator_selection_snapshots.ids_json','amb_operator_selection_snapshots.total','amb_operator_selection_snapshots.ids_hash','amb_operator_selection_snapshots.data_as_of','amb_operator_selection_snapshots.created_at','amb_operator_selection_snapshots.expires_at']), nc.join(','));
  ok('sharing cannot widen data scope at the database level: a view stores only its OWN config text + a share flag — no account / campaign data columns', !nc.some((c) => /account|campaign_id|token|secret|password/i.test(c)));
  const d1 = diff(A.url); ok('after the migration the database schema is IDENTICAL to the Prisma datamodel (prisma migrate diff exit 0)', d1.status === 0, (d1.stdout + d1.stderr).slice(-600));
  const again = exec(A.url, join(MIG_DIR, 'migration.sql')); const afterAgain = await snapshot(cA); ok('a second apply is refused by the database (no duplicate tables, nothing changed)', again.status !== 0 && same(afterAgain.counts, after.counts) && same(afterAgain.tables, after.tables));

  console.log('\n2. Rollback');
  const rb = exec(A.url, join(MIG_DIR, 'rollback.sql')); ok('rollback.sql runs cleanly', rb.status === 0, (rb.stdout + rb.stderr).slice(-400));
  const rolled = await snapshot(cA); ok('after the rollback the schema is EXACTLY the old one again (tables, columns, indexes, foreign keys) and every existing row is still there', same(rolled, before), JSON.stringify({ tablesEq: same(rolled.tables, before.tables), countsEq: same(rolled.counts, before.counts), colsEq: same(rolled.cols, before.cols), idxEq: same(rolled.idx, before.idx), fksEq: same(rolled.fks, before.fks) }));
  const rb2 = exec(A.url, join(MIG_DIR, 'rollback.sql')); ok('the rollback is idempotent (running it twice is harmless)', rb2.status === 0 && same(await snapshot(cA), before));
  const re = exec(A.url, join(MIG_DIR, 'migration.sql')); const d2 = diff(A.url); ok('the migration can be applied AGAIN after a rollback, and the schema is identical to the datamodel', re.status === 0 && d2.status === 0, (re.stdout + re.stderr + d2.stdout + d2.stderr).slice(-400));
  const sqlText = fs.readFileSync(join(MIG_DIR, 'migration.sql'), 'utf8').replace(/--.*$/gm, ''); ok('the migration file is purely additive: only CREATE TABLE / CREATE INDEX — no ALTER / DROP / UPDATE / DELETE / TRUNCATE', /CREATE TABLE/.test(sqlText) && !/\b(ALTER|DROP|UPDATE|DELETE|TRUNCATE|INSERT)\b/i.test(sqlText));
  await cA.$disconnect();

  console.log('\n3. An EMPTY database + the full migration history (prisma migrate deploy)');
  const E = await mkDb('e'); const cE = client(E.url); await q(cE, 'drop schema public cascade'); await q(cE, 'create schema public');
  ok('the database is really empty (no tables at all)', (await snapshot(cE)).tables.length === 0);
  const dep = cli(E.url, ['migrate', 'deploy', '--schema', SCHEMA]); ok('migrate deploy builds the whole schema from nothing (every migration, including this one) and exits 0', dep.status === 0, (dep.stdout + dep.stderr).slice(-700));
  const sE = await snapshot(cE); ok('both new tables exist and are empty', NEW_TABLES.every((t) => sE.tables.includes(t) && sE.counts[t] === 0));
  const rec = await q(cE, `select migration_name, finished_at is not null as done from _prisma_migrations where migration_name = '${MIG}'`); ok('the migration is recorded as finished in _prisma_migrations', rec.length === 1 && rec[0].done === true);
  const allDone = await q(cE, `select count(*)::int as n, count(*) filter (where finished_at is null)::int as unfinished from _prisma_migrations`); ok('no migration is left unfinished or rolled back', allDone[0].unfinished === 0 && allDone[0].n >= 60, JSON.stringify(allDone));
  const dE = diff(E.url); const dtxt = dE.stdout + dE.stderr; ok('the history-built schema has no drift on the two new tables (any drift reported is in older, unrelated tables)', !NEW_TABLES.some((t) => dtxt.includes(t)), dtxt.slice(-600));
  console.log(`  ℹ drift of the older history vs the datamodel (informational): ${dE.status === 0 ? 'none' : 'present (not caused by this migration)'}`);
  await cE.$disconnect();

  console.log('\n4. New code BEFORE the migration (tables missing) and after it — real V2 routes on this suite\'s own isolated database');
  const { prisma } = await imp('../prisma.js'); const TT = await imp('../services/amb/dailyPlanTime.js'); const { default: v2Routes } = await imp('../routes/operatorV2.js'); const { errorHandler } = await imp('../middleware/errorHandler.js');
  const T = '__optest_v2m_'; const AC = `act_${T}A`; const today = TT.cairoDate(new Date());
  const app = express(); app.use(cookieParser()); app.use(express.json()); app.use('/api/operator-v2', v2Routes); app.use(errorHandler);
  const server = await new Promise((rs) => { const s = app.listen(0, '127.0.0.1', () => rs(s)); }); const base = `http://127.0.0.1:${server.address().port}/api/operator-v2`;
  const user = await prisma.user.create({ data: { email: `${T}admin_${Date.now()}@example.invalid`, password_hash: 'x'.repeat(20), name: `${T}admin`, role: 'ADMIN', status: 'ACTIVE', permissions: '{}' } }); const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const call = async (method, p, body) => { const x = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: `token=${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await x.text(); let j = null; try { j = JSON.parse(text); } catch { /* */ } return { s: x.status, j, text }; };
  const run = await prisma.ambSyncRun.create({ data: { status: 'SUCCESS', ad_account_id: AC, finished_at: new Date() } });
  await prisma.metaPerformanceSnapshot.createMany({ data: Array.from({ length: 4 }, (_, i) => ({ sync_run_id: run.id, ad_account_id: AC, level: 'campaign', date_start: today, date_stop: today, campaign_id: `${T}c${i}`, campaign_name: `camp ${i}`, campaign_status: 'ACTIVE', campaign_budget: 100, campaign_budget_type: 'DAILY', spend: 50 + i, meta_purchases: 1, snapshot_at: new Date() })) });
  try {
    await prisma.$executeRawUnsafe(`drop table if exists ${NEW_TABLES.map((t) => `"${t}"`).join(', ')}`);
    const present = async () => (await prisma.$queryRawUnsafe(`select table_name from information_schema.tables where table_schema='public' and table_name in ('${NEW_TABLES.join("','")}')`)).length;
    ok('this suite database is now on the OLD schema (both tables absent)', (await present()) === 0);
    const qh = await call('POST', '/campaigns/query', { accounts: [AC], pageSize: 10 }); const hm = await call('GET', '/home'); const ex = await call('POST', '/campaigns/export', { accounts: [AC] });
    ok('without the tables: campaign query, Home and CSV export keep working (200, real rows)', qh.s === 200 && qh.j.total === 4 && hm.s === 200 && ex.s === 200 && ex.text.split('\n').length > 3, JSON.stringify([qh.s, hm.s, ex.s, qh.j?.message]));
    const gv = await call('GET', '/views'); const pv = await call('POST', '/views', { name: 'x', config: { period: { key: 'last7' } } }); const sn = await call('POST', '/campaigns/snapshot', { accounts: [AC] });
    ok('without the tables: saved views and selection snapshots answer a clear, retryable 503 «V2_TABLES_MISSING» — never a raw 500 / stack trace', [gv, pv, sn].every((r) => r.s === 503 && r.j?.error === 'V2_TABLES_MISSING' && /Migration/.test(r.j.message) && !/prisma|P20|stack|invocation/i.test(r.text)), JSON.stringify([gv.s, gv.text.slice(0, 160), pv.s, sn.s]));
    const rv = await call('POST', '/campaigns/review-preview', { action: 'PAUSE', ids: [{ campaignId: `${T}c0`, adAccountId: AC }] }); ok('without the tables: a review preview of explicit campaigns still works (it needs no snapshot)', rv.s === 200 && rv.j.totals.selected === 1, JSON.stringify([rv.s, rv.j?.message]));
    const mg = exec(process.env.DATABASE_URL, join(MIG_DIR, 'migration.sql')); ok('applying the migration to this database succeeds', mg.status === 0 && (await present()) === 2, (mg.stdout + mg.stderr).slice(-300));
    const gv2 = await call('GET', '/views'); const cv = await call('POST', '/views', { name: 'FX migration', config: { period: { key: 'last7' } } }); const sn2 = await call('POST', '/campaigns/snapshot', { accounts: [AC] });
    ok('after the migration: views list (200), a view saves, and a selection snapshot is created — with no code change', gv2.s === 200 && cv.s === 200 && sn2.s === 200 && sn2.j.total === 4, JSON.stringify([gv2.s, cv.s, sn2.s, cv.j?.message, sn2.j?.message]));
    const rb3 = exec(process.env.DATABASE_URL, join(MIG_DIR, 'rollback.sql')); const gv3 = await call('GET', '/views'); const qh3 = await call('POST', '/campaigns/query', { accounts: [AC], pageSize: 10 });
    ok('after a ROLLBACK the system degrades the same way: views → 503 (retryable), the campaign list keeps working', rb3.status === 0 && gv3.s === 503 && gv3.j.error === 'V2_TABLES_MISSING' && qh3.s === 200);
    // legacy code never touches the tables
    const SRC = join(BACKEND, 'src'); const refs = []; const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(js|mjs)$/.test(f.name) && /ambOperator(SavedView|SelectionSnapshot)/.test(fs.readFileSync(p, 'utf8'))) refs.push(path.relative(SRC, p).replace(/\\/g, '/')); } }; walk(SRC);
    ok('only the V2 services (and their tests / cleanup scripts) reference the two tables — no legacy route, engine or job reads or writes them', refs.length > 0 && refs.every((r) => /^services\/amb\/(operatorSavedViews|campaignSelection)\.js$|^scripts\//.test(r)), refs.join(', '));
    exec(process.env.DATABASE_URL, join(MIG_DIR, 'migration.sql'));
  } finally {
    await prisma.metaPerformanceSnapshot.deleteMany({ where: { ad_account_id: AC } }).catch(() => {}); await prisma.ambSyncRun.deleteMany({ where: { ad_account_id: AC } }).catch(() => {}); await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
    server.close(); await prisma.$disconnect();
  }
} finally {
  for (const n of made) await TE.dropDb(n).catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`); setTimeout(() => process.exit(fail ? 1 : 0), 50);
void os;
