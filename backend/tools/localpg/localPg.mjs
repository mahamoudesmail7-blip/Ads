// Local PostgreSQL for the isolated test suites — TEST TOOLING ONLY (never part of the app's dependencies, never used by the server in production).
//   node tools/localpg/localPg.mjs serve     start (installs + initialises on first use) and stay in the foreground — the test runner starts it detached when it is not already running
//   node tools/localpg/localPg.mjs status    prints "up" / "down" (exit 0 / 1)
//   node tools/localpg/localPg.mjs stop      stops the server started by `serve`
// WHY the files live outside the repo folder: the Windows PostgreSQL binaries cannot start from a path with non-ASCII characters (this project's folder name is Arabic), so the package + the data
// directory live in an ASCII-only home: %LOCALAPPDATA%\optest-pg (override with LOCALPG_HOME). The only thing versioned here is package.json (the dependency pin) and this script.
// Listens on 127.0.0.1 only. Superuser `optest` / password `optest` (local, throw-away data: it only ever holds test fixtures). fsync is OFF: durability is irrelevant for throw-away test data.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export const HOME = process.env.LOCALPG_HOME || path.join(process.env.LOCALAPPDATA || os.homedir(), 'optest-pg');
export const PORT = Number(process.env.LOCALPG_PORT || 54329); export const USER = 'optest'; export const PASSWORD = 'optest';
const DATA = path.join(HOME, 'data'); const PIDFILE = path.join(HOME, 'localpg.pid');
export const isUp = () => new Promise((res) => { const s = net.connect({ port: PORT, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); s.setTimeout(800, () => { s.destroy(); res(false); }); });
function ensureInstalled() {
  if (fs.existsSync(path.join(HOME, 'node_modules', 'embedded-postgres', 'dist', 'index.js'))) return;
  fs.mkdirSync(HOME, { recursive: true }); fs.copyFileSync(path.join(here, 'package.json'), path.join(HOME, 'package.json'));
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: HOME, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error('npm install of embedded-postgres failed');
}
export const pgModuleUrl = () => pathToFileURL(path.join(HOME, 'node_modules', 'pg', 'lib', 'index.js')).href;
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); // importing this module (testEnv.mjs) must never run a command
const cmd = isMain ? process.argv[2] : null;
if (cmd === 'status') { const up = await isUp(); console.log(up ? 'up' : 'down'); process.exit(up ? 0 : 1); }
if (cmd === 'stop') { try { process.kill(Number(fs.readFileSync(PIDFILE, 'utf8')), 'SIGTERM'); console.log('stop signal sent'); } catch { console.log('not running'); } process.exit(0); }
if (cmd === 'serve') {
  if (await isUp()) { console.log('already up'); process.exit(0); }
  ensureInstalled(); const EmbeddedPostgres = (await import(pathToFileURL(path.join(HOME, 'node_modules', 'embedded-postgres', 'dist', 'index.js')).href)).default;
  const pg = new EmbeddedPostgres({ databaseDir: DATA, user: USER, password: PASSWORD, port: PORT, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=300', '-c', 'shared_buffers=128MB'] });
  if (!fs.existsSync(path.join(DATA, 'PG_VERSION'))) await pg.initialise();
  await pg.start(); fs.writeFileSync(PIDFILE, String(process.pid)); console.log('localpg up on', PORT);
  const down = async () => { try { await pg.stop(); } catch { /* already stopped */ } try { fs.unlinkSync(PIDFILE); } catch { /* none */ } process.exit(0); };
  process.on('SIGTERM', down); process.on('SIGINT', down); setInterval(() => {}, 1 << 30);
}
