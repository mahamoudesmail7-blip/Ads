// Local review helper: a PRISTINE local-Postgres clone (optest_v2dev) with the UI fixtures + a server on http://localhost:4000, for looking at the V2 screens in a browser.
//   node src/scripts/devV2Server.mjs          → prints the URL and keeps the server running until Ctrl+C
// Test database only (the guard refuses anything else). Logins: test-owner@ / test-manager@ / test-employee@ / test-employee-nogrant@example.invalid  — password: Test-Owner-Only-2026!
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)); const BACKEND = path.join(here, '..', '..');
const { ensureLocalPg, ensureBaseDb, cloneDb } = await import('./testEnv.mjs');
await ensureLocalPg(); await ensureBaseDb({ log: (m) => console.log(m) }); const url = await cloneDb('optest_v2dev');
const env = { ...process.env, TEST_DB_TARGET: 'local', LOCAL_TEST_DATABASE_URL: url, PORT: process.env.PORT || '4000' }; delete env.DIRECT_DATABASE_URL;
const seed = spawnSync(process.execPath, [path.join(here, 'seedUiFixtures.mjs')], { cwd: BACKEND, env, encoding: 'utf8' }); console.log(seed.stdout.trim() || seed.stderr.slice(-800));
const server = spawn(process.execPath, [path.join(here, 'serveOnTestDb.js')], { cwd: BACKEND, env, stdio: 'inherit' });
console.log(`\nV2 review server → http://localhost:${env.PORT}/ai-media-buyer.html#operator   (set localStorage opx.v2=1 or add ?ui=v2)`);
process.on('SIGINT', () => { server.kill(); process.exit(0); });
