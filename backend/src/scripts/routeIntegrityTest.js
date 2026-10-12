// 🧪 Static guards on the API surface (pure source scan: needs no database and sends nothing anywhere).
//   1) no Express router may register the SAME method + path twice. Express serves the first one and silently ignores the second, so the second handler is dead code and any screen that expects ITS
//      response shape breaks at runtime (this exact collision — two `GET /brief` in routes/operator.js — made the «مركز التحكم» tab fail with «Cannot read properties of undefined»).
//   2) every literal `/api/operator/...` call made by the operator screens (js/opx-*.js, js/ai-operator*.js) must match a registered route with the same method — a screen calling a route that does not exist is a dead button.
import './_testGuard.js'; // every suite refuses to run unless the environment is the isolated TEST setup (this one touches no database, but the rule is uniform)
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
let pass = 0, fail = 0; const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 600) : ''}`); } };
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'routes'); const jsDir = join(here, '..', '..', '..', 'js');
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const REG = /\b(?:router|app)\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
console.log('\n1. Duplicate route registrations');
let total = 0; const dups = [];
for (const f of files) {
  const src = readFileSync(join(dir, f), 'utf8'); const seen = new Map();
  for (const m of src.matchAll(REG)) { total++; const key = `${m[1].toUpperCase()} ${m[3]}`; seen.set(key, (seen.get(key) || 0) + 1); }
  for (const [k, n] of seen) if (n > 1) dups.push(`${f}: ${k} ×${n}`);
}
ok(`${files.length} route files scanned (${total} registrations): no method+path is registered twice in the same file`, dups.length === 0, dups.join(' | '));

console.log('\n2. Every call the operator screens make has a route');
const opSrc = readFileSync(join(dir, 'operator.js'), 'utf8'); const routes = [];
for (const m of opSrc.matchAll(REG)) routes.push({ method: m[1].toUpperCase(), raw: m[3], re: new RegExp('^' + m[3].replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_]+/g, '[^/]+') + '$') });
const uiFiles = readdirSync(jsDir).filter((f) => /^(opx-.*|ai-operator.*)\.js$/.test(f));
const CALL = /\bapi\.(get|post|put|patch|delete)\(\s*(['"`])(\/api\/operator[^'"`]*)\2/g; const missing = []; let calls = 0;
for (const f of uiFiles) {
  const src = readFileSync(join(jsDir, f), 'utf8');
  for (const m of src.matchAll(CALL)) {
    calls++; const method = m[1].toUpperCase(); let p = m[3].replace(/\$\{[^}]*\}/g, 'X').split('?')[0].replace(/^\/api\/operator/, ''); if (p === '') p = '/';
    // a tail built at run time («/setup-grid/${path}») must at least match the static prefix of a registered route
    const dyn = m[3].indexOf('${'); const stat = dyn >= 0 ? m[3].slice(0, dyn).replace(/^\/api\/operator/, '') : null;
    const found = stat !== null && stat.endsWith('/') ? routes.some((r) => r.method === method && r.raw.startsWith(stat)) : routes.some((r) => r.method === method && r.re.test(p));
    if (!found) missing.push(`${f}: ${method} ${m[3]}`);
  }
}
ok(`${calls} literal operator API calls in ${uiFiles.length} screens: every one matches a registered route and method`, missing.length === 0, missing.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
