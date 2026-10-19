// 🔐 LOGIN BRUTE-FORCE LIMIT — 20 FAILED attempts / 15 min / client; successful logins do not use the allowance; the «too many attempts» answer is JSON with a clear message (it used to be plain text,
//   which the login page read as «مقدرش أوصل للسيرفر» although the server was up). Isolated TEST database only (the module imports the app's auth router).
//   node src/scripts/authLimiterTest.js
import './_testGuard.js';
import 'dotenv/config';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const express = (await import('express')).default; const { authLimiter } = await imp('../routes/auth.js');

const app = express(); app.set('trust proxy', 1); app.use(express.json());
app.post('/login', authLimiter, (req, res) => (req.body?.ok ? res.json({ ok: true }) : res.status(401).json({ message: 'wrong' })));
const server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
const post = (ok_) => fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: ok_ }) });

try {
  console.log('\n1. Successful logins never use up the allowance');
  { let codes = []; for (let i = 0; i < 30; i++) codes.push((await post(true)).status);
    ok('30 successful logins in a row are all accepted (a busy day / many tabs cannot lock the owner out)', codes.every((c) => c === 200), codes.join()); }
  console.log('\n2. Failed attempts are limited, and the limit answers in JSON');
  { let last = null, codes = []; for (let i = 0; i < 21; i++) { last = await post(false); codes.push(last.status); }
    ok('the first 20 wrong attempts get the normal 401, the 21st is blocked with 429', codes.slice(0, 20).every((c) => c === 401) && codes[20] === 429, codes.join());
    const body = await last.json().catch(() => null);
    ok('the 429 is JSON (not plain text) — the login page can read it', /application\/json/.test(last.headers.get('content-type') || '') && !!body);
    ok('the message says «too many attempts», how many minutes to wait, and that the SERVER IS UP', /محاولات دخول كتير/.test(body?.message || '') && /\d+ دقيقة/.test(body.message) && /السيرفر شغال/.test(body.message) && body.error === 'TOO_MANY_ATTEMPTS' && body.retryAfterSeconds > 0 && body.retryAfterSeconds <= 900, JSON.stringify(body));
    const afterOk = await post(true); ok('while blocked even the right password is refused (that is the protection), with the same readable JSON', afterOk.status === 429 && !!(await afterOk.json().catch(() => null))?.message); }
  console.log('\n3. The pages read the answer instead of guessing «server down»');
  { const login = fs.readFileSync(join(__dirname, '../../../js/auth.js'), 'utf8'); const reg = fs.readFileSync(join(__dirname, '../../../js/register-page.js'), 'utf8');
    for (const [name, src] of [['login', login], ['register', reg]]) ok(`${name} page: a non-JSON answer does not throw into «مقدرش أوصل للسيرفر», and a 429 has its own message`, /await res\.json\(\)\.catch\(\(\) => \(\{\}\)\)/.test(src) && /res\.status === 429/.test(src) && /السيرفر شغال/.test(src)); }
} finally { server.close(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
