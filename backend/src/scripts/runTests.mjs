// 🚀 Test runner — FAST TEST / FULL REGRESSION, parallel, on a throw-away LOCAL PostgreSQL (with the Neon test branch kept for the suites that must run there).
//
//   node src/scripts/runTests.mjs                       FAST: the suites AFFECTED by your uncommitted changes (+ the whole security gate, always) — minutes
//   node src/scripts/runTests.mjs --mode=full           FULL REGRESSION: every suite on the local DB in parallel, THEN the Neon-required subset on the Neon test branch (before deploying)
//   node src/scripts/runTests.mjs --since=<git-ref>     "affected" = changed since that ref (default: working tree vs HEAD, incl. untracked files)  ·  --files=a,b  explicit changed-file list
//   node src/scripts/runTests.mjs a b c                 exactly these suites
//   options: --parallel=N (default 4) · --ui (also run opxUiTest: local server + real browser) · --no-neon (skip the Neon pass in full mode) · --neon-all (run EVERYTHING on Neon, sequentially, like before) · --list
//
// Isolation (why parallel is safe): every suite gets its OWN pristine database cloned from a seeded template (`CREATE DATABASE … TEMPLATE optest_base`, ~1 s), dropped afterwards; suites use ephemeral ports (0) for
// their mock servers. Nothing can touch production or Neon in the local pass (loopback host + `optest_*` names are enforced by _testGuard.js). Security suites are never skipped or reduced.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { SUITES, SECURITY_GATE, NEON_REQUIRED, GLOBAL_TRIGGERS } from './testSuites.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const BACKEND = path.resolve(here, '../..'); const REPO = path.resolve(BACKEND, '..');
const args = process.argv.slice(2); const flag = (n) => args.some((a) => a === `--${n}`); const opt = (n, d = null) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const MODE = opt('mode', 'fast'); const PAR = Math.max(1, Number(opt('parallel', Math.min(4, Math.max(2, os.cpus().length - 2)))));
const explicit = args.filter((a) => !a.startsWith('--')); const t00 = Date.now(); const fmt = (ms) => (ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`);
const say = (m) => console.log(`[${fmt(Date.now() - t00).padStart(6)}] ${m}`);
const TIMINGS = path.join(BACKEND, '.test-timings.json'); let history = {}; try { history = JSON.parse(fs.readFileSync(TIMINGS, 'utf8')); } catch { /* first run */ }

// ---------------------------------------------------------------- which suites are affected by the changes
function changedFiles() {
  if (opt('files')) return opt('files').split(',').map((x) => x.trim().split(String.fromCharCode(92)).join('/')).filter(Boolean); // explicit list (what-if / CI): --files=backend/src/services/amb/approvalCenter.js,...
  const since = opt('since'); const run = (a) => spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...run(['diff', '--name-only', since || 'HEAD']), ...(since ? [] : run(['ls-files', '-o', '--exclude-standard']))])].map((f) => f.replace(/\\/g, '/'));
}
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|imp\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const resolveImport = (from, spec) => { const base = path.resolve(path.dirname(from), spec); for (const c of [base, base + '.js', base + '.mjs', path.join(base, 'index.js')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; return null; };
function closureOf(entry) { const seen = new Set(); const stack = [entry]; while (stack.length) { const f = stack.pop(); if (seen.has(f)) continue; seen.add(f); let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; } for (const m of src.matchAll(IMPORT_RE)) { const r = resolveImport(f, m[1]); if (r && !r.includes('node_modules')) stack.push(r); } } return seen; }
const rel = (f) => path.relative(REPO, f).replace(/\\/g, '/');
function affectedSuites() {
  const changed = changedFiles(); const reasons = new Map(); const add = (s, why) => { if (!reasons.has(s)) reasons.set(s, why); };
  if (changed.some((f) => GLOBAL_TRIGGERS.some((re) => re.test(f)))) { for (const s of SUITES) add(s, 'harness/schema changed'); return { changed, reasons }; }
  const changedSet = new Set(changed);
  for (const s of SUITES) { const file = path.join(here, `${s}.js`); if (!fs.existsSync(file)) continue; for (const f of closureOf(file)) { const r = rel(f); if (changedSet.has(r)) { add(s, r.replace('backend/src/', '')); break; } } }
  for (const s of SECURITY_GATE) add(s, 'security gate (always)');
  return { changed, reasons };
}

// ---------------------------------------------------------------- plan
if (flag('list')) { console.log(SUITES.join('\n')); process.exit(0); }
let plan; let why = new Map(); let changedList = [];
if (flag('only-ui')) { plan = []; }
else if (explicit.length) { plan = explicit; explicit.forEach((s) => why.set(s, 'requested')); }
else if (MODE === 'full') { plan = [...SUITES]; plan.forEach((s) => why.set(s, 'full regression')); }
else { const a = affectedSuites(); changedList = a.changed; why = a.reasons; plan = SUITES.filter((s) => why.has(s)); }
plan = plan.filter((s) => { const ok = fs.existsSync(path.join(here, `${s}.js`)); if (!ok) say(`- ${s}: not in this checkout — skipped`); return ok; });
const uiAffected = flag('ui') || MODE === 'full' || changedList.some((f) => /^(js\/|css\/|ai-media-buyer\.html|backend\/src\/scripts\/(opxUiTest|seedUiFixtures|serveOnTestDb))/.test(f) || /^backend\/src\/routes\/operator\.js$/.test(f));

if (flag('neon-all')) { const r = spawnSync(process.execPath, [path.join(here, 'runIsolatedSuites.mjs'), ...plan], { cwd: BACKEND, stdio: 'inherit' }); process.exit(r.status ?? 1); }

say(`${MODE.toUpperCase()}${explicit.length ? ' (explicit)' : ''} · ${plan.length} suites · ${PAR} parallel · local PostgreSQL${MODE === 'full' && !flag('no-neon') ? ` + Neon subset (${NEON_REQUIRED.length})` : ''}`);
if (MODE !== 'full' && !explicit.length) { say(`changed files: ${changedList.length} · affected: ${plan.filter((s) => why.get(s) !== 'security gate (always)').length} + security gate ${SECURITY_GATE.length} (always)${uiAffected ? ' · UI test relevant → add --ui' : ''}`); }

const { ensureLocalPg, ensureBaseDb, cloneDb, dropDb, dropAllWorkerDbs, localUrl } = await import('./testEnv.mjs');
const tEnv0 = Date.now(); const st = await ensureLocalPg(); const base = await ensureBaseDb({ log: say }); await dropAllWorkerDbs().catch(() => {});
say(`local PostgreSQL ${st.started ? 'started' : 'ready'} · base database ${base.rebuilt ? 'REBUILT' : 'cached'} (${fmt(Date.now() - tEnv0)})`);

// ---------------------------------------------------------------- run (longest first, N at a time, each suite in its own database)
const skipsWorld = (f) => fs.readFileSync(f, 'utf8').includes('skip-world');
const queue = [...plan].sort((a, b) => (history[b]?.ms || 30000) - (history[a]?.ms || 30000)); const results = []; let done = 0; let active = 0;
async function runSuite(name) {
  const file = path.join(here, `${name}.js`); const dbName = `optest_${name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30)}_${process.pid}`; const t0 = Date.now(); let tClone = 0, tRun = 0;
  say(`▶ ${name.padEnd(30)} [${++active} running · ${done}/${plan.length} done]`);
  let out = '', status = -1, timedOut = false;
  try {
    const c0 = Date.now(); const url = await cloneDb(dbName); tClone = Date.now() - c0;
    const env = { ...process.env, TEST_DB_TARGET: 'local', LOCAL_TEST_DATABASE_URL: url, OPX_LOCAL: '1' };
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [file, ...(skipsWorld(file) ? ['--skip-world'] : [])], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10 * 60_000);
      child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
      const r0 = Date.now(); child.on('close', (code) => { clearTimeout(timer); tRun = Date.now() - r0; status = code; resolve(); });
    });
  } catch (e) { out += `\nrunner error: ${e.message}`; } finally { await dropDb(dbName).catch(() => {}); }
  active--; done++; const sum = [...out.matchAll(/(\d+) passed, (\d+) failed/g)].pop(); const failedLines = out.split('\n').filter((l) => /✗|crashed|TEST GUARD|runner error/.test(l)).slice(0, 6);
  const r = { name, target: 'local', status: status === 0 ? 'ok' : 'FAIL', passed: sum ? +sum[1] : null, failed: sum ? +sum[2] : null, ms: Date.now() - t0, cloneMs: tClone, runMs: tRun, failedLines, timedOut };
  results.push(r); history[name] = { ms: r.ms }; say(`${r.status === 'ok' ? '✓' : '✗'} ${name.padEnd(30)} ${sum ? `${sum[1]} passed, ${sum[2]} failed` : `exit ${status}${timedOut ? ' (timeout)' : ''}`} · ${fmt(r.ms)}  [${done}/${plan.length}]`);
  for (const l of failedLines) if (r.status !== 'ok') console.log(`           ${l.slice(0, 200)}`);
}
async function pool() { const workers = Array.from({ length: Math.min(PAR, queue.length) }, async () => { while (queue.length) await runSuite(queue.shift()); }); await Promise.all(workers); }
const tRun0 = Date.now(); await pool(); const localMs = Date.now() - tRun0;

// ---------------------------------------------------------------- optional: real Neon pass for the Neon-required subset (FULL only)
let neon = null;
if (MODE === 'full' && !flag('no-neon') && !explicit.length) {
  const subset = NEON_REQUIRED.filter((s) => plan.includes(s)); say(`Neon test branch: ${subset.length} suites (sequential, as the production database engine) …`); const n0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, 'runIsolatedSuites.mjs'), ...subset], { cwd: BACKEND, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TEST_DB_TARGET: '' } });
  const lines = (r.stdout || '').split('\n'); const parsed = lines.filter((l) => /^[✓✗]/.test(l)).map((l) => { const m = l.match(/^([✓✗]) (\w+): (?:(\d+) passed, (\d+) failed|exit (\d+)) \((\d+)s\)/); return m ? { name: m[2], target: 'neon', status: m[1] === '✓' ? 'ok' : 'FAIL', passed: m[3] ? +m[3] : null, failed: m[4] ? +m[4] : null, ms: +m[6] * 1000 } : null; }).filter(Boolean);
  neon = { ms: Date.now() - n0, exit: r.status, results: parsed, tail: lines.filter((l) => /✗|suites green|TEST GUARD/.test(l)).slice(0, 8) };
  for (const p of parsed) say(`${p.status === 'ok' ? '✓' : '✗'} [neon] ${p.name.padEnd(26)} ${p.passed ?? '?'} passed, ${p.failed ?? '?'} failed · ${fmt(p.ms)}`); if (!parsed.length) for (const l of neon.tail) say(`   neon: ${l.slice(0, 160)}`);
  results.push(...parsed);
}

// ---------------------------------------------------------------- optional: the real-browser UI test against a local server on a pristine local database
let ui = null;
if (flag('ui') || (MODE === 'full' && !explicit.length && !flag('no-ui'))) {
  say('UI test (real browser, desktop + phone) against a local server on a pristine local database …'); const u0 = Date.now(); const dbName = `optest_ui_${process.pid}`; const url = await cloneDb(dbName);
  const env = { ...process.env, TEST_DB_TARGET: 'local', LOCAL_TEST_DATABASE_URL: url, PORT: '4000' }; delete env.DIRECT_DATABASE_URL;
  const seed = spawnSync(process.execPath, [path.join(here, 'seedUiFixtures.mjs')], { cwd: BACKEND, env, encoding: 'utf8' });
  const server = spawn(process.execPath, [path.join(here, 'serveOnTestDb.js')], { cwd: BACKEND, env, stdio: 'ignore', windowsHide: true });
  let up = false; for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch('http://localhost:4000/login.html')).ok; } catch { await sleep(500); } }
  let out = ''; let code = -1;
  if (up && seed.status === 0) { const r = spawnSync(process.execPath, [path.join(here, 'opxUiTest.mjs')], { cwd: BACKEND, env: { ...env, OPX_WAIT_MS: env.OPX_WAIT_MS || '30000' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 25 * 60_000 }); out = (r.stdout || '') + (r.stderr || ''); code = r.status; } else out = `server did not start / seed failed (${seed.status}): ${String(seed.stderr).slice(-300)}`;
  try { server.kill('SIGKILL'); } catch { /* gone */ } spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); await dropDb(dbName).catch(() => {});
  const sum = [...out.matchAll(/(\d+) passed, (\d+) failed/g)].pop(); const failedLines = out.split('\n').filter((l) => /✗/.test(l)).slice(0, 8);
  ui = { name: 'opxUiTest', target: 'local+browser', status: code === 0 ? 'ok' : 'FAIL', passed: sum ? +sum[1] : null, failed: sum ? +sum[2] : null, ms: Date.now() - u0, failedLines }; results.push(ui);
  say(`${ui.status === 'ok' ? '✓' : '✗'} opxUiTest (desktop + phone)   ${sum ? `${sum[1]} passed, ${sum[2]} failed` : `exit ${code}`} · ${fmt(ui.ms)}`); for (const l of failedLines) console.log(`           ${l.slice(0, 220)}`);
  { // the budget journey (CBO / ABO ad-set picker → preview → execute on a Meta MOCK → VERIFIED): its own database, its own server (port 4001) and its own loopback Meta mock
    const b0 = Date.now(); const dbName2 = `optest_ui2_${process.pid}`; const url2 = await cloneDb(dbName2); const env2 = { ...process.env, TEST_DB_TARGET: 'local', LOCAL_TEST_DATABASE_URL: url2, PORT: '4001' }; delete env2.DIRECT_DATABASE_URL;
    const seed2 = spawnSync(process.execPath, [path.join(here, 'seedUiFixtures.mjs')], { cwd: BACKEND, env: env2, encoding: 'utf8' }); let out2 = '', code2 = -1;
    if (seed2.status === 0) { const r2 = spawnSync(process.execPath, [path.join(here, 'budgetUiTest.mjs')], { cwd: BACKEND, env: { ...env2, OPX_WAIT_MS: env2.OPX_WAIT_MS || '60000' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 }); out2 = (r2.stdout || '') + (r2.stderr || ''); code2 = r2.status; } else out2 = `seed failed: ${String(seed2.stdout + seed2.stderr).slice(-300)}`;
    await dropDb(dbName2).catch(() => {}); const sum2 = [...out2.matchAll(/(\d+) passed, (\d+) failed/g)].pop(); const fl2 = out2.split('\n').filter((l) => /✗/.test(l)).slice(0, 8);
    const r = { name: 'budgetUiTest', target: 'local+browser', status: code2 === 0 ? 'ok' : 'FAIL', passed: sum2 ? +sum2[1] : null, failed: sum2 ? +sum2[2] : null, ms: Date.now() - b0, failedLines: fl2 }; results.push(r);
    say(`${r.status === 'ok' ? '✓' : '✗'} budgetUiTest (CBO / ABO journey, desktop + phone)   ${sum2 ? `${sum2[1]} passed, ${sum2[2]} failed` : `exit ${code2}`} · ${fmt(r.ms)}`); for (const l of fl2) console.log(`           ${l.slice(0, 220)}`);
  }
}

// ---------------------------------------------------------------- report
fs.writeFileSync(TIMINGS, JSON.stringify(history, null, 1));
const bad = results.filter((r) => r.status !== 'ok'); const totalPassed = results.reduce((t, r) => t + (r.passed || 0), 0); const totalFailed = results.reduce((t, r) => t + (r.failed || 0), 0);
const slow = [...results].sort((a, b) => b.ms - a.ms).slice(0, 10);
console.log(`\nslowest 10:\n${slow.map((r, i) => `  ${String(i + 1).padStart(2)}. ${r.name.padEnd(30)} ${r.target.padEnd(13)} ${fmt(r.ms).padStart(8)}${r.cloneMs != null ? `  (db clone ${fmt(r.cloneMs)})` : ''}`).join('\n')}`);
const total = Date.now() - t00; const report = { mode: MODE, parallel: PAR, suites: results.length, ok: results.length - bad.length, failedSuites: bad.map((r) => r.name), assertionsPassed: totalPassed, assertionsFailed: totalFailed, wallMs: total, localMs, neonMs: neon?.ms ?? null, uiMs: ui?.ms ?? null, at: new Date().toISOString(), results };
fs.writeFileSync(path.join(BACKEND, 'test-report.json'), JSON.stringify(report, null, 1));
console.log(`\n${bad.length ? '❌' : '✅'} ${results.length - bad.length}/${results.length} suites green · ${totalPassed} assertions passed, ${totalFailed} failed · wall ${fmt(total)}${bad.length ? ' — failing: ' + bad.map((r) => r.name).join(', ') : ''}`);
process.exit(bad.length ? 1 : 0);
