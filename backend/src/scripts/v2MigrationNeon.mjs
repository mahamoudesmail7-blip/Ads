// 🧪 AI Operator V2 migration on the NEON TEST BRANCH (the isolated test database — never production). A one-off confirmation next to operatorV2MigrationTest (which runs on local throw-away databases):
//   apply → every existing table unchanged (row counts + schema) → schema == datamodel → second apply refused → rollback → schema exactly as before → re-apply → final state = the state it was found in.
//   node src/scripts/v2MigrationNeon.mjs        (needs TEST_DATABASE_URL; the test guard refuses anything that is not the marked test database)
import './_testGuard.js';
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); const URL_ = process.env.DATABASE_URL; // replaced by the guard with the TEST url
let pass = 0, fail = 0; const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };
if (process.env.TEST_DB_TARGET === 'local') { console.log('This script is for the Neon test branch; the local runner uses operatorV2MigrationTest.'); process.exit(0); }
const NEW = ['amb_operator_saved_views', 'amb_operator_selection_snapshots']; const MIG = join(BACKEND, 'prisma', 'migrations', '20261013120000_operator_v2_views'); const CLI = join(BACKEND, 'node_modules', 'prisma', 'build', 'index.js');
const cli = (args) => { let r; for (let i = 0; i < 3; i++) { r = spawnSync(process.execPath, [CLI, ...args], { cwd: BACKEND, env: { ...process.env, DATABASE_URL: URL_, DIRECT_DATABASE_URL: URL_ }, encoding: 'utf8', timeout: 240_000 }); if (r.status === 0 || !/P1001|P1002|P1017|Can't reach|Connection|timed out|ECONN/i.test(r.stdout + r.stderr)) break; } return r; };
const exec = (file) => cli(['db', 'execute', '--url', URL_, '--file', file]); const diff = () => cli(['migrate', 'diff', '--from-url', URL_, '--to-schema-datamodel', join(BACKEND, 'prisma', 'schema.prisma'), '--exit-code']);
const c = new PrismaClient({ datasourceUrl: URL_ }); const q = async (sql) => { for (let i = 0; ; i++) { try { return await c.$queryRawUnsafe(sql); } catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 1500)); } } };
async function snap() {
  const counts = Object.fromEntries((await q(`select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int as n from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`)).map((r) => [r.table_name, Number(r.n)]));
  const cols = (await q(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' order by 1,2`)).map((r) => JSON.stringify(r));
  const idx = (await q(`select tablename, indexname, indexdef from pg_indexes where schemaname='public' order by 1,2`)).map((r) => JSON.stringify(r));
  const fks = (await q(`select conrelid::regclass::text as t, conname, confrelid::regclass::text as r from pg_constraint where contype='f' order by 1,2`)).map((r) => JSON.stringify(r));
  return { counts, cols, idx, fks };
}
const stripNew = (s) => ({ counts: Object.fromEntries(Object.entries(s.counts).filter(([t]) => !NEW.includes(t))), cols: s.cols.filter((x) => !NEW.includes(JSON.parse(x).table_name)), idx: s.idx.filter((x) => !NEW.includes(JSON.parse(x).tablename)), fks: s.fks.filter((x) => { const f = JSON.parse(x); return !NEW.some((t) => f.t.includes(t) || f.r.includes(t)); }) });
const norm = (t) => String(t).split(String.fromCharCode(10)).filter((l) => l.trim() && !/Added tables|amb_operator_(saved_views|selection_snapshots)|Added (unique )?index on columns \((shared, scope|owner_id, scope, name|owner_id, created_at|expires_at)\)/.test(l)).join(String.fromCharCode(10)).trim();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
try {
  console.log('Neon TEST branch (marker verified by the guard)');
  const s0 = await snap(); const had = NEW.every((t) => t in s0.counts); const hadAny = NEW.some((t) => t in s0.counts); console.log(`  ℹ initial state: new tables ${had ? 'present' : hadAny ? 'PARTIALLY present' : 'absent'}; ${Object.keys(s0.counts).length} tables, ${Object.values(s0.counts).reduce((t, n) => t + n, 0)} rows`);
  const rb0 = exec(join(MIG, 'rollback.sql')); ok('start from the OLD schema: rollback.sql removes the two tables (if they existed) and nothing else', rb0.status === 0, rb0.stdout + rb0.stderr);
  const base = await snap(); ok('the OLD-schema baseline has none of the new tables and every other table is exactly as it was found', NEW.every((t) => !(t in base.counts)) && same(stripNew(base), stripNew(s0)));
  const dBase = diff(); const driftBase = (dBase.stdout + dBase.stderr).trim(); console.log(`  ℹ drift of the Neon test branch vs the datamodel BEFORE the migration: ${dBase.status === 0 ? 'none' : 'present (older, unrelated — shown below)'}`); if (dBase.status !== 0) console.log('    ' + driftBase.split(String.fromCharCode(10)).filter(Boolean).slice(0, 4).join(String.fromCharCode(10) + '    '));
  const ap = exec(join(MIG, 'migration.sql')); ok('migration.sql applies on Neon (exit 0)', ap.status === 0, ap.stdout + ap.stderr);
  const s1 = await snap(); ok('NO DATA LOSS: every existing table has the same row count; columns / indexes / foreign keys of every existing table are identical', same(stripNew(s1), stripNew(base)));
  ok('both new tables exist, are empty and have no foreign keys', NEW.every((t) => s1.counts[t] === 0) && s1.fks.length === base.fks.length);
  const d = diff(); ok('after the migration the schema differs from the datamodel by EXACTLY what it differed by before (no drift on the new tables, nothing new) — identical to the datamodel if the branch had no older drift', norm(d.stdout + d.stderr) === norm(driftBase) && !NEW.some((t) => (d.stdout + d.stderr).includes(t)), JSON.stringify([norm(d.stdout + d.stderr), norm(driftBase)]));
  const again = exec(join(MIG, 'migration.sql')); ok('a second apply is refused and changes nothing', again.status !== 0 && same(stripNew(await snap()), stripNew(base)));
  const rb = exec(join(MIG, 'rollback.sql')); const s2 = await snap(); ok('ROLLBACK on Neon: the schema is exactly the old one again (same tables, columns, indexes, foreign keys, row counts)', rb.status === 0 && same(s2, base));
  const re = exec(join(MIG, 'migration.sql')); const d2 = diff(); ok('re-applying after the rollback works and leaves the same drift as before (none on the new tables)', re.status === 0 && norm(d2.stdout + d2.stderr) === norm(driftBase), (re.stdout + re.stderr + d2.stdout + d2.stderr).slice(-400));
  if (!had) { const rbf = exec(join(MIG, 'rollback.sql')); ok('final state restored to how it was found (new tables absent again)', rbf.status === 0 && same(await snap(), base)); } else console.log('  ℹ final state: new tables present, as found');
} catch (e) { fail++; console.log('  ✗ crashed —', e.message); }
finally { await c.$disconnect(); }
console.log(`\n${pass} passed, ${fail} failed`); setTimeout(() => process.exit(fail ? 1 : 0), 50);
