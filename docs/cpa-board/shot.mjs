// Takes full-size desktop screenshots of the «قواعد CPA الذكية» board from the LOCAL server on the isolated test database (http://localhost:4000).
//   node docs/cpa-board/shot.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
const OUT = dirname(fileURLToPath(import.meta.url)); const BASE = 'http://localhost:4000';
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'; const PORT = 9300 + Math.floor(Math.random() * 300); const dir = mkdtempSync(join(tmpdir(), 'cpashot-'));
const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--disable-gpu', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 80; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch { /* starting */ } await sleep(250); }
const page = targets.find((t) => t.type === 'page'); const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error'); return r.result.value; };
const waitFor = async (expr, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await js(expr)) return true; } catch { /* reloading */ } await sleep(300); } return false; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64')); console.log('saved', name); };
try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `${BASE}/login.html` }); await sleep(1200);
  await js(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'test-owner@example.invalid',password:'Test-Owner-Only-2026!'})}).then(r=>r.status)`);
  await js(`localStorage.setItem('opx.ws','budget'); localStorage.setItem('opx.theme','light'); localStorage.setItem('opx.collapsed','0'); true`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/ai-media-buyer.html#operator` });
  await waitFor(`!!document.querySelector('#cpaBoard .cpa-card') && !document.querySelector('#cpaBoard .opx-empty')`); await sleep(800);
  const setN = (k, v) => js(`(()=>{ const i = document.querySelector('[data-n="${k}"]'); i.value = '${v}'; i.dispatchEvent(new Event('input')); return true; })()`);
  for (const [k, v] of [['bumpStart', 20], ['bumpEnd', 100], ['reduceStart', 130], ['hardStop', 200], ['incPct', 20], ['decPct', 20], ['minOrders', 5], ['cooldown', 24], ['maxChanges', 1], ['zeroSpend', 200], ['maxBudget', 600], ['minBudget', 200], ['dailyCap', 600]]) await setN(k, v);
  await js(`(()=>{ const t = document.getElementById('cpaTest'); t.value = '95'; t.dispatchEvent(new Event('input')); return true; })()`);
  await js(`(()=>{ for (const k of ['bumpStart','bumpEnd','reduceStart','hardStop','minOrders','cooldown','maxBudget','dailyCap']) document.querySelector('[data-more="'+k+'"]').click(); return true; })()`);
  await sleep(400);
  // crop to the board only: make the page as tall as the board and clip to it
  const box = await js(`(()=>{ const r = document.getElementById('cpaBoard').getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; })()`);
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 } }); writeFileSync(join(OUT, 'cpa-board-details-open.png'), Buffer.from(r.data, 'base64')); console.log('saved board', Math.round(box.w), 'x', Math.round(box.h));
  await js(`document.querySelectorAll('.cpa-pop').forEach((p) => { p.hidden = true; }); true`); await sleep(200);
  const b2 = await js(`(()=>{ const r = document.getElementById('cpaBoard').getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; })()`);
  const r2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: b2.x, y: b2.y, width: b2.w, height: b2.h, scale: 1 } }); writeFileSync(join(OUT, 'cpa-board.png'), Buffer.from(r2.data, 'base64'));
} finally { ws.close(); proc.kill(); }
