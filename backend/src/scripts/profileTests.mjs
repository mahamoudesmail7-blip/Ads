// ⏱️ Test-infrastructure profiler: where does the time actually go? Measures the building blocks on BOTH engines (Neon test branch vs the local PostgreSQL) so the numbers can be compared.
//   node src/scripts/profileTests.mjs            (read-only against Neon: it only counts / selects on the TEST branch; the local part uses its own throw-away databases)
// Reports (ms): connection · plain round-trip (p50/p95) · a Prisma findMany · a 20-query service-like burst · template clone / state reset / seed · server start (cold) · API call timings with the number of SQL
// queries each one issues (so "slow because of N sequential queries × RTT" is shown, not guessed).
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
const here = path.dirname(fileURLToPath(import.meta.url)); const BACKEND = path.resolve(here, '../..');
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, min: s[0], p50: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] }; };
const timeIt = async (fn) => { const t = performance.now(); await fn(); return Math.round((performance.now() - t) * 10) / 10; };
const out = { generatedAt: new Date().toISOString(), engines: {} };

async function profileEngine(label, env) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import './src/scripts/_testGuard.js';
    const { prisma } = await import('./src/prisma.js'); let q = 0; prisma.$use(async (p, next) => { q++; return next(p); }); // counts Prisma operations of the app's OWN client (the one the services use)
    const t = async (fn) => { const a = performance.now(); await fn(); return Math.round((performance.now() - a) * 10) / 10; };
    const r = {}; r.connect_first_query_ms = await t(() => prisma.$queryRawUnsafe('select 1'));
    r.rtt = []; for (let i = 0; i < 25; i++) r.rtt.push(await t(() => prisma.$queryRawUnsafe('select 1')));
    r.findMany_ms = []; for (let i = 0; i < 10; i++) r.findMany_ms.push(await t(() => prisma.ambAlert.findMany({ take: 20 })));
    r.burst20_sequential_ms = await t(async () => { for (let i = 0; i < 20; i++) await prisma.user.count(); });
    r.burst20_parallel_ms = await t(() => Promise.all(Array.from({ length: 20 }, () => prisma.user.count())));
    r.write_ms = []; for (let i = 0; i < 5; i++) r.write_ms.push(await t(async () => { const x = await prisma.ambAlert.create({ data: { severity: 'INFO', category: 'PROFILE', title: '__optest_prof', message: 'x' } }); await prisma.ambAlert.delete({ where: { id: x.id } }); }));
    const m = await import('./src/scripts/testDb.mjs'); r.reset_state_ms = await t(() => m.resetTestDatabaseState()).catch(() => null); // (null on Neon here: the guard has already rebound DATABASE_URL; measured separately below)
    // service-level: how many SQL statements and how long do the heavy screens' services need?
    q = 0; r.services = {}; for (const [name, fn] of [['listApprovals', async () => (await import('./src/services/amb/approvalCenter.js')).listApprovals({})], ['dailyPlanOverview', async () => (await import('./src/services/amb/dailyPlans.js')).getDashboard?.({}) ?? (await import('./src/services/amb/dailyPlans.js')).getDailyPlanConfig()], ['operatorOverview', async () => (await import('./src/services/amb/operatorReports.js')).operatorOverview({})], ['buildProductionReadiness', async () => (await import('./src/services/amb/productionReadiness.js')).buildProductionReadiness({})]]) { q = 0; let ms = null, err = null; try { ms = await t(fn); } catch (e) { err = String(e.message).slice(0, 80); } r.services[name] = { ms, queries: q, err }; }
    console.log('@@' + JSON.stringify(r)); await prisma.$disconnect(); process.exit(0);`], { cwd: BACKEND, env, encoding: 'utf8', timeout: 5 * 60_000 });
  const line = (child.stdout || '').split('\n').find((l) => l.startsWith('@@')); if (!line) return { error: (child.stderr || child.stdout || 'no output').slice(-400) };
  const r = JSON.parse(line.slice(2)); return { connect_first_query_ms: r.connect_first_query_ms, rtt_ms: stats(r.rtt), findMany_ms: stats(r.findMany_ms), burst20_sequential_ms: r.burst20_sequential_ms, burst20_parallel_ms: r.burst20_parallel_ms, write_roundtrip_ms: stats(r.write_ms), reset_state_ms: r.reset_state_ms, services: r.services };
}
const { ensureLocalPg, ensureBaseDb, cloneDb, dropDb, localUrl } = await import('./testEnv.mjs');
await ensureLocalPg(); await ensureBaseDb();
// 1. engine comparison
out.engines.neon = await profileEngine('neon', { ...process.env, TEST_DB_TARGET: '' });
if (out.engines.neon && !out.engines.neon.error) { const rr = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./src/scripts/testDb.mjs').then(async (m) => { const t = performance.now(); await m.resetTestDatabaseState(); console.log('@@' + Math.round(performance.now() - t)); process.exit(0); })"], { cwd: BACKEND, env: { ...process.env, TEST_DB_TARGET: '' }, encoding: 'utf8', timeout: 120000 }); const l = (rr.stdout || '').split(String.fromCharCode(10)).find((x) => x.startsWith('@@')); out.engines.neon.reset_state_ms = l ? Number(l.slice(2)) : null; }
const dbName = `optest_prof_${process.pid}`; const t0 = performance.now(); const url = await cloneDb(dbName); out.local_template_clone_ms = Math.round(performance.now() - t0);
out.engines.local = await profileEngine('local', { ...process.env, TEST_DB_TARGET: 'local', LOCAL_TEST_DATABASE_URL: url });
// 2. seed + server start + API timings on each engine (the UI test's real cost centres)
async function serverProfile(label, env) {
  const seedMs = await timeIt(async () => { spawnSync(process.execPath, [path.join(here, 'seedUiFixtures.mjs')], { cwd: BACKEND, env, stdio: 'ignore' }); });
  const t = performance.now(); const server = spawn(process.execPath, [path.join(here, 'serveOnTestDb.js')], { cwd: BACKEND, env: { ...env, PORT: '4100' }, stdio: 'ignore', windowsHide: true });
  let up = false; for (let i = 0; i < 240 && !up; i++) { try { up = (await fetch('http://localhost:4100/login.html')).ok; } catch { await sleep(250); } } const startMs = Math.round(performance.now() - t);
  const api = {}; let cookie = '';
  try {
    const lr = await fetch('http://localhost:4100/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'test-owner@example.invalid', password: 'Test-Owner-Only-2026!' }) }); cookie = (lr.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    for (const p of ['/api/operator/overview', '/api/operator/daily-plan/overview', '/api/operator/approvals', '/api/operator/config', '/api/operator/status-bar', '/api/operator/product-rules']) { const xs = []; for (let i = 0; i < 3; i++) { const a = performance.now(); const r = await fetch('http://localhost:4100' + p, { headers: { cookie } }); await r.text(); xs.push(Math.round(performance.now() - a)); } api[p] = { status: null, ms_p50: stats(xs).p50, ms_max: stats(xs).max }; }
  } catch (e) { api.error = e.message; }
  try { server.kill('SIGKILL'); } catch { /* gone */ } spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  return { seed_fixtures_ms: seedMs, server_cold_start_ms: startMs, api };
}
out.server = { neon: await serverProfile('neon', { ...process.env, TEST_DB_TARGET: '' }), local: await serverProfile('local', { ...process.env, TEST_DB_TARGET: 'local', LOCAL_TEST_DATABASE_URL: url }) };
await dropDb(dbName).catch(() => {});
console.log(JSON.stringify(out, null, 1));
