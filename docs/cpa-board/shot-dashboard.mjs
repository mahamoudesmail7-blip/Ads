// Screenshot of the products dashboard from the LOCAL server on the isolated test database. The overview response is decorated in the page with ILLUSTRATIVE products/numbers (never sent anywhere) so every status can be seen.
//   node docs/cpa-board/shot-dashboard.mjs
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
const DECOR = `
(() => { const of = window.fetch; const L = { cpaScaleMin: 20, cpaScale: 100, cpaReduce: 130, hardStop: 200, minPurchases: 5, zeroSpend: 200, increasePct: 20, decreasePct: 20, dailyCap: 600, maxBudget: 600, minBudget: 200 };
  const mk = (i, name, store, state, perf, mode, camps, running, why) => ({ key: store + ':' + i, productId: i, storeId: store, name, state, blockedReason: null, missing: why ? [{ key: 'x', label: why }] : [], orders7: perf.last7.orders, cpa: { d3: perf.last3.cpa, d7: perf.last7.cpa, d30: perf.last30.cpa }, perf, campaigns: { mapped: camps[1], active: camps[0], ids: [] }, runningBudget: running, policy: { status: mode ? 'ACTIVE' : 'NONE', mode, version: 2 }, limits: { ...L }, economicsComplete: true, stockKnown: true });
  const p = (o3, s3, o7, s7, o30, s30, o0 = 0, s0 = 0) => { const f = (o, s) => ({ orders: o, spend: s, cpa: o ? Math.round(s / o) : null }); return { today: f(o0, s0), last3: f(o3, s3), last7: f(o7, s7), last30: f(o30, s30) }; };
  window.fetch = async (u, o) => { const r = await of(u, o); if (!String(u).includes('/api/operator/automation/overview')) return r; const j = await r.clone().json();
    j.products = [
      mk(424, 'كاب الليزر لتحفيز نمو الشعر', 'trendy-storeee', 'READY', p(14, 1190, 31, 2790, 96, 9120, 4, 330), 'AUTOMATIC', [3, 24], 1800),
      mk(250, 'جهاز إزالة شعر الوجه بدون ألم', 'trendy-storeee', 'READY', p(22, 2310, 50, 5400, 150, 16100, 6, 640), 'APPROVAL', [4, 12], 2400),
      mk(212, 'جهاز المساج البدوي الذكي', 'trendy-storeee', 'READY', p(9, 1280, 21, 2650, 60, 7900, 2, 270), 'APPROVAL', [2, 8], 900),
      mk(159, 'قناع السيليكون لشد الوجه', 'trendy-storeee', 'NEEDS_CONFIGURATION', p(7, 1470, 18, 3300, 70, 11800, 1, 230), null, [1, 21], 600, 'اقتصاديات المنتج ناقصة (تكلفة + شحن)'),
      mk(323, 'ساعة ذكية متعددة الرياضات', 'default', 'READY', p(3, 130, 7, 360, 20, 1120, 1, 60), null, [2, 5], 700),
      mk(320, 'مصباح القمر الليلي', 'default', 'READY', p(0, 410, 0, 780, 5, 1900, 0, 120), 'APPROVAL', [2, 6], 500),
      mk(443, 'فرشاة الشعر الذكية للترتيب والتصفيف', 'default', 'NEEDS_CONFIGURATION', p(0, 0, 0, 0, 0, 0), null, [0, 21], 0, 'الصرف مطلوب حدود'),
      mk(257, 'بخاخ نانو تعقيم سريع', 'trendy-storeee', 'READY', p(11, 1650, 24, 3500, 80, 11400, 3, 410), 'APPROVAL', [3, 9], 1200)];
    j.totals = { ...j.totals, products: j.products.length, READY: 6, NEEDS_CONFIGURATION: 2, BLOCKED: 0 };
    return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } }); }; })();`;
try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `${BASE}/login.html` }); await sleep(1200);
  await js(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'test-owner@example.invalid',password:'Test-Owner-Only-2026!'})}).then(r=>r.status)`);
  await js(`localStorage.setItem('opx.ws','budget'); localStorage.setItem('opx.theme','light'); localStorage.setItem('opx.collapsed','0'); localStorage.setItem('opx.cpa.period','last3'); true`);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: DECOR });
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/ai-media-buyer.html#operator` });
  await waitFor(`!!document.querySelector('#cpaBoard .cpa-dash')`); await sleep(900);
  const clip = async (sel, name, pad = 0) => { const b = await js(`(()=>{ const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; })()`); const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: b.x, y: b.y, width: b.w, height: b.h + pad, scale: 1 } }); writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64')); console.log('saved', name, Math.round(b.w), 'x', Math.round(b.h)); };
  await clip('#cpaBoard .cpa-dash', 'products-dashboard.png');
  await js(`document.querySelector('[data-period="last7"]').click()`); await sleep(300); await clip('#cpaBoard .cpa-dash', 'products-dashboard-7d.png');
} finally { ws.close(); proc.kill(); }
