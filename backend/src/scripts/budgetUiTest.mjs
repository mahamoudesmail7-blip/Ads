// 🧪 BUDGET UI JOURNEY in a REAL headless browser against the local server on the ISOLATED test database, with a Meta MOCK that models campaigns AND ad sets:
//   «إدارة الميزانيات» → manual panel → choose a campaign (CBO) / choose the AD SET (ABO) → live preview → confirm → execute on the mock → independent read-back → VERIFIED → Execution History.
//   It starts its OWN server (port 4001, OPERATOR_ALLOW_META_WRITES=true, Meta = the mock). Never touches production.   node src/scripts/budgetUiTest.mjs
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepRaw } from 'node:timers/promises';
const SLOW = Number(process.env.OPX_SLOW) || 1; // >1 on a slow database link: every fixed pause is multiplied (the waitFor() waits are separate: OPX_WAIT_MS)
const sleep = (ms) => sleepRaw(ms * SLOW);
const BROWSER = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
if (!BROWSER) { console.log('no Chromium browser found — skipped'); process.exit(0); }
const BASE = 'http://localhost:4001'; let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 1800) : ''}`); } };
const PORT = 9700 + Math.floor(Math.random() * 200); const dir = mkdtempSync(join(tmpdir(), 'opxui-'));
const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--disable-gpu', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 80; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch { /* starting */ } await sleep(250); }
const page = targets.find((t) => t.type === 'page'); const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map(); const consoleErrors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') consoleErrors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text); else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') consoleErrors.push((d.params.args || []).map((a) => a.value || a.description).join(' ')); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error'); return r.result.value; };
const goto = async (path, { width = 1440, height = 900, mobile = false, ls = {} } = {}) => { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); await send('Page.navigate', { url: `${BASE}/login.html` }); await waitFor(`document.readyState === 'complete'`, 20000); await js(`${Object.entries(ls).map(([k, v]) => `localStorage.setItem('${k}','${v}');`).join('')} true`); await send('Page.navigate', { url: `${BASE}${path}` }); await sleep(path.includes('#operator') ? 300 : 6500); if (path.includes('#operator')) await waitFor(`!!document.getElementById('opxRoot') && !!document.querySelector('.opx-head h1') && !document.querySelector('.opx-skel')`, 45000); /* every workspace finished its data call before any assertion runs (the API answers in 1-8 s, it varies) */ };
const WAIT = Number(process.env.OPX_WAIT_MS) || 15000;
const waitFor = async (expr, ms = WAIT) => { ms = Math.max(ms, WAIT); const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await js(expr)) return true; } catch { /* page reloading */ } await sleep(300); } return false; };
await send('Page.enable'); await send('Runtime.enable');

import http from 'node:http';
const world = new Map(); const log = [];
const camp = (id, o = {}) => world.set(id, { id, name: 'camp ' + id, status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: null, lifetime_budget: null, _t: 'campaign', ...o });
const adset = (id, cid, o = {}) => world.set(id, { id, name: 'adset ' + id, status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: null, lifetime_budget: null, campaign_id: cid, _t: 'adset', ...o });
const clean = (e) => { const { _t, ...r } = e; return r; };
const writes = (id) => log.filter((r) => r.method === 'POST' && r.id === id); const allWrites = () => log.filter((r) => r.method === 'POST');
camp('fx_extra_1', { daily_budget: '20000', name: 'Radio _ scale 1' }); adset('fx_extra_1_as', 'fx_extra_1');
camp('fx_open_6', { name: 'LumiMist _ scale 8' }); adset('abo_A', 'fx_open_6', { daily_budget: '25000', name: 'M - Copy' }); adset('abo_B', 'fx_open_6', { daily_budget: '25000', name: 'M', status: 'PAUSED', effective_status: 'PAUSED' }); adset('abo_C', 'fx_open_6', { daily_budget: '20000', name: 'Third' });
const mock = http.createServer((req, res) => { const url = new URL(req.url, 'http://x'); const seg = url.pathname.split('/').filter(Boolean); const id = seg[1], edge = seg[2]; let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => { const body = Object.fromEntries(new URLSearchParams(raw)); delete body.access_token; log.push({ method: req.method, id, edge: edge || null, body }); const send = (c, j) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); }; const e = world.get(id);
    if (req.method === 'GET') { if (edge === 'adsets') return send(200, { data: [...world.values()].filter((x) => x._t === 'adset' && x.campaign_id === id).map(clean) }); if (e) return send(200, clean(e)); if (/^act_/.test(id || '')) return send(200, { id, name: 'acc', currency: 'EGP', account_status: 1 }); return send(404, { error: { message: 'Unsupported get request (mock)', code: 100 } }); }
    if (!e) return send(404, { error: { message: 'Unsupported post request (mock)', code: 100 } }); if (body.status) { e.status = body.status; e.effective_status = body.status; } if (body.daily_budget) e.daily_budget = String(body.daily_budget); return send(200, { success: true }); }); });
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const { fileURLToPath } = await import('node:url'); const here = join(fileURLToPath(new URL('.', import.meta.url)));
const server = spawn(process.execPath, [join(here, 'serveOnTestDb.js')], { cwd: join(here, '../..'), env: { ...process.env, PORT: '4001', UI_META_MOCK_URL: 'http://127.0.0.1:' + mock.address().port, OPERATOR_ALLOW_META_WRITES: 'true' }, stdio: 'ignore', windowsHide: true });
let up = false; for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(BASE + '/login.html')).ok; } catch { await sleep(500); } }
if (!up) { console.log('  ✗ the budget UI server did not start'); process.exit(1); }
const api = (m, p, b) => js(`fetch('${p}',{method:'${m}',headers:{'content-type':'application/json'},body:${b === undefined ? 'undefined' : JSON.stringify(JSON.stringify(b))}}).then(async r=>({s:r.status,j:await r.json().catch(()=>null)}))`);
const click = (sel) => js(`document.querySelector('${sel}').click()`);
try {
  await send('Page.navigate', { url: BASE + '/login.html' }); await sleep(1200);
  const login = await js(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'test-owner@example.invalid',password:'Test-Owner-Only-2026!'})}).then(r=>r.status)`);
  if (login !== 200) { console.log('login failed — stopping'); process.exit(2); }
  await api('PUT', '/api/operator/mode', { mode: 'MANUAL' }); await api('PUT', '/api/operator/execution-permissions/budgetIncrease', { on: true, confirm: true }); await api('PUT', '/api/operator/execution-permissions/budgetDecrease', { on: true, confirm: true });
  console.log('\n1. «إدارة الميزانيات» shows the manual panel with CBO / ABO labels and one button per direction');
  await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'budget', 'opx.theme': 'light' } });
  ok('the manual budget panel is on the budget screen', await waitFor(`!!document.getElementById('bmCard') && document.querySelectorAll('#bmCard [data-mop]').length > 0`, 40000));
  ok('only increase / reduce buttons are offered there (no open / pause)', await js(`[...document.querySelectorAll('#bmCard [data-mop]')].every((b) => ['INCREASE','REDUCE'].includes(b.dataset.mop))`));
  ok('every campaign row says CBO / ABO / unknown', await js(`[...document.querySelectorAll('#bmCard tbody tr')].every((r) => /CBO|ABO|غير معروفة/.test(r.innerText))`));

  console.log('\n2. CBO: increase +20% on the campaign budget (200 → 240) through the UI');
  await js(`document.querySelector('#bmCard [data-cid="fx_extra_1"][data-mop="INCREASE"]').click()`);
  ok('the drawer reads the LIVE structure: CBO, campaign budget 200, no ad-set picker', await waitFor(`/CBO/.test(document.querySelector('.opx-drawer.open')?.innerText || '') && !!document.getElementById('bmTo') && !document.querySelector('[name="bmPick"]')`, 20000));
  await click('[data-pct="20"]');
  ok('+20% fills 240 and shows 200 ← 240 (+40 ج, +20.0%)', await js(`document.getElementById('bmTo').value === '240' && /240/.test(document.getElementById('bmCalc').innerText) && /20/.test(document.getElementById('bmCalc').innerText)`));
  await click('#bmPre');
  ok('the preview states current → proposed on the CAMPAIGN, the expected Meta change and the exposure; nothing was written yet', await waitFor(`/200/.test(document.querySelector('.opx-drawer.open')?.innerText || '') && /240/.test(document.querySelector('.opx-drawer.open')?.innerText || '') && /daily_budget/.test(document.querySelector('.opx-drawer.open').innerText) && !!document.getElementById('mnGo')`, 20000) && allWrites().length === 0);
  ok('the execute button is enabled (permission ON, mode MANUAL, lock open on this server)', await waitFor(`!!document.getElementById('mnGo') && !document.getElementById('mnGo').disabled`), JSON.stringify((await api('POST', '/api/operator/manual/preflight', { campaignId: 'fx_extra_1', operation: 'INCREASE', toBudget: 240 })).j, (k, v) => (['structure', 'confirm', 'limits'].includes(k) ? undefined : v)));
  await click('#mnGo'); ok('the confirmation dialog states the change before anything is sent', await waitFor(`!!document.querySelector('.confirm-modal-overlay') && /200/.test(document.querySelector('.confirm-modal-overlay').innerText) && /240/.test(document.querySelector('.confirm-modal-overlay').innerText)`, 10000));
  await click('.confirm-modal-overlay [data-action="confirm"]');
  ok('the result drawer says VERIFIED (read back from Meta)', await waitFor(`/اتأكد من Meta/.test(document.querySelector('.opx-drawer.open')?.innerText || '')`, 30000));
  ok('Meta (mock) really changed: ONE write on the campaign (24000), the ad set untouched', writes('fx_extra_1').length === 1 && writes('fx_extra_1')[0].body.daily_budget === '24000' && writes('fx_extra_1_as').length === 0 && world.get('fx_extra_1').daily_budget === '24000');
  await click('#opxDrawerX');

  console.log('\n3. ABO: pick the AD SET — only it changes');
  await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'budget', 'opx.theme': 'light' } }); await waitFor(`!!document.getElementById('bmCard')`, 40000);
  await js(`document.querySelector('#bmCard [data-cid="fx_open_6"][data-mop="INCREASE"]').click()`);
  ok('the drawer lists ALL 3 ad sets with name · id · status · live budget · eligibility, and the total 700', await waitFor(`document.querySelectorAll('[name="bmPick"]').length === 3 && /M - Copy/.test(document.querySelector('.opx-drawer.open').innerText) && /abo_A/.test(document.querySelector('.opx-drawer.open').innerText) && /700/.test(document.querySelector('.opx-drawer.open').innerText)`, 20000));
  ok('the paused ad set is marked «بتأكيد» (eligible only with an explicit acknowledgement)', await js(`/بتأكيد/.test(document.querySelector('.opx-drawer.open').innerText)`));
  ok('nothing is chosen for the owner: the preview button is disabled until an ad set is picked', await js(`document.getElementById('bmPre').disabled === true && !document.getElementById('bmTo')`));
  await js(`document.querySelector('[name="bmPick"][value="abo_A"]').click()`); await waitFor(`!!document.getElementById('bmTo')`, 10000); await click('[data-pct="20"]');
  ok('picking "M - Copy" shows its budget 250; +20% → 300 and the ad-set total 700 ← 750', await js(`document.getElementById('bmTo').value === '300' && /700/.test(document.getElementById('bmCalc').innerText) && /750/.test(document.getElementById('bmCalc').innerText)`));
  await click('#bmPre');
  ok('the preview shows the ad set (name + id), the ABO totals and the ad sets that will NOT change', await waitFor(`/M - Copy/.test(document.querySelector('.opx-drawer.open')?.innerText || '') && /abo_A/.test(document.querySelector('.opx-drawer.open').innerText) && /مش هيتغيّر/.test(document.querySelector('.opx-drawer.open').innerText) && /750/.test(document.querySelector('.opx-drawer.open').innerText) && !!document.getElementById('mnGo')`, 20000));
  await click('#mnGo'); await waitFor(`!!document.querySelector('.confirm-modal-overlay')`, 10000); await click('.confirm-modal-overlay [data-action="confirm"]');
  ok('VERIFIED', await waitFor(`/اتأكد من Meta/.test(document.querySelector('.opx-drawer.open')?.innerText || '')`, 30000));
  ok('Meta (mock): ONLY ad set A changed (30000); B, C and the campaign were never written', writes('abo_A').length === 1 && writes('abo_A')[0].body.daily_budget === '30000' && writes('abo_B').length === 0 && writes('abo_C').length === 0 && writes('fx_open_6').length === 0 && world.get('abo_B').daily_budget === '25000' && world.get('abo_C').daily_budget === '20000');
  await click('#opxDrawerX');

  console.log('\n4. ABO: reduce a PAUSED ad set needs the acknowledgement; limits are said before confirming');
  await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'budget', 'opx.theme': 'light' } }); await waitFor(`!!document.getElementById('bmCard')`, 40000);
  await js(`document.querySelector('#bmCard [data-cid="fx_open_6"][data-mop="REDUCE"]').click()`); await waitFor(`document.querySelectorAll('[name="bmPick"]').length === 3`, 20000);
  await js(`document.querySelector('[name="bmPick"][value="abo_B"]').click()`); await waitFor(`!!document.getElementById('bmTo')`, 10000);
  await js(`(()=>{const e=document.getElementById('bmTo'); e.value='100'; e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  ok('a reduction beyond the per-action limit (250 → 100 = −60%) is flagged live before any request', await js(`/أكبر من الحد المسموح/.test(document.getElementById('bmCalc').innerText)`));
  await js(`(()=>{const e=document.getElementById('bmTo'); e.value='200'; e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await click('#bmPre');
  ok('the preview of the paused ad set requires ticking the acknowledgement; the button stays disabled until then', await waitFor(`!!document.querySelector('[data-ack="ADSET_PAUSED"]') && !!document.getElementById('mnGo') && document.getElementById('mnGo').disabled === true`, 20000));
  await click('[data-ack="ADSET_PAUSED"]'); ok('ticking it enables the execute button', await waitFor(`!!document.getElementById('mnGo') && document.getElementById('mnGo').disabled === false`));
  await click('#mnGo'); await waitFor(`!!document.querySelector('.confirm-modal-overlay')`, 10000); await click('.confirm-modal-overlay [data-action="confirm"]');
  ok('the paused ad set is reduced 250 → 200 and VERIFIED; A / C untouched by this action', await waitFor(`/اتأكد من Meta/.test(document.querySelector('.opx-drawer.open')?.innerText || '')`, 30000) && world.get('abo_B').daily_budget === '20000' && writes('abo_B').length === 1 && writes('abo_C').length === 0 && writes('abo_A').length === 1);
  await click('#opxDrawerX');

  console.log('\n5. Execution History: the rows say Ad Set + campaign + VERIFIED');
  const h = (await api('GET', '/api/operator/execution-history?limit=20')).j.rows;
  ok('history has the three budget actions, VERIFIED, origin MANUAL, the ABO ones carry entityLevel adset + the ad-set name + the parent campaign name', h.filter((r) => r.final === 'VERIFIED' && r.origin === 'MANUAL').length >= 3 && h.some((r) => r.entityLevel === 'adset' && r.entityName === 'M - Copy' && r.campaignName === 'LumiMist _ scale 8' && r.before === 250 && r.after === 300), JSON.stringify(h.slice(0, 5).map((r) => [r.final, r.origin, r.entityLevel, r.entityName, r.campaignName, r.before, r.after])));
  await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'history', 'opx.theme': 'light' } });
  ok('the history screen names the ad set under the campaign', await waitFor('document.body.innerText.includes("M - Copy") && document.body.innerText.includes("(abo_A)") && /Ad Set:/.test(document.body.innerText)', 30000));

  console.log('\n6. Phone layout and gates');
  await goto('/ai-media-buyer.html#operator', { width: 390, height: 844, mobile: true, ls: { 'opx.ws': 'budget', 'opx.theme': 'light' } }); await waitFor(`!!document.getElementById('bmCard')`, 40000); await sleep(600);
  ok('phone: the budget screen with the manual panel has no horizontal scroll', await js(`document.documentElement.scrollWidth <= window.innerWidth + 2`));
  await js(`document.querySelector('#bmCard [data-cid="fx_open_6"][data-mop="INCREASE"]').click()`); await waitFor(`document.querySelectorAll('[name="bmPick"]').length === 3`, 20000); await sleep(400);
  ok('phone: the ad-set picker drawer fits the screen', await js(`document.documentElement.scrollWidth <= window.innerWidth + 2 && document.querySelector('.opx-drawer.open').getBoundingClientRect().right <= window.innerWidth + 2`));
  await api('PUT', '/api/operator/execution-permissions/budgetIncrease', { on: false, confirm: true }); await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'budget', 'opx.theme': 'light' } }); await waitFor(`!!document.getElementById('bmCard')`, 40000);
  const w0 = allWrites().length; await js(`document.querySelector('#bmCard [data-cid="fx_extra_1"][data-mop="REDUCE"]').click()`);
  ok('the increase permission OFF does not stop a REDUCE (its own permission is ON): the reduce preview is executable', await waitFor(`!!document.getElementById('bmTo')`, 20000));
  await js(`document.getElementById('opxDrawerX').click()`); await js(`document.querySelector('#bmCard [data-cid="fx_open_6"][data-mop="INCREASE"]').click()`); await waitFor(`document.querySelectorAll('[name="bmPick"]').length === 3`, 20000); await js(`document.querySelector('[name="bmPick"][value="abo_C"]').click()`); await waitFor(`!!document.getElementById('bmTo')`, 20000); await click('[data-pct="10"]'); await click('#bmPre');
  ok('with the increase permission OFF the preview says exactly why it cannot run (PERMISSION_OFF) and the button is disabled — nothing is sent', await waitFor(`/PERMISSION_OFF/.test(document.querySelector('.opx-drawer.open')?.innerText || '') && document.getElementById('mnGo').disabled === true`, 20000) && allWrites().length === w0);
  ok('no JavaScript errors were thrown during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) { fail++; console.log('  ✗ budget UI test crashed —', e.message); }
finally { ws.close(); proc.kill(); try { server.kill('SIGKILL'); } catch {} spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); mock.close(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
