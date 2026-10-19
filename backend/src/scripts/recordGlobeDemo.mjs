// 🎬 Records a short demo (frames → mp4 + gif via ffmpeg) of the launch-wizard 3D globe: slow auto-rotation, mouse drag, wheel zoom in/out, «+ / −», and «العودة إلى مصر».
//   node src/scripts/recordGlobeDemo.mjs      (expects the local TEST-database server on http://localhost:4002 — the same one launchGlobeUiTest uses; output: docs/launch-premium/globe-demo.mp4 + .gif)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
const BROWSER = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
const BASE = process.env.LP_BASE || 'http://localhost:4002'; const here = dirname(fileURLToPath(import.meta.url)); const OUT = join(here, '../../../docs/launch-premium'); mkdirSync(OUT, { recursive: true });
const frames = mkdtempSync(join(tmpdir(), 'globeframes-')); const PORT = 9900 + Math.floor(Math.random() * 90);
const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'gd-'))}`, 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 80; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch { /* starting */ } await sleep(250); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map(); const shots = []; ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method === 'Page.screencastFrame') { shots.push({ ts: d.params.metadata.timestamp, data: d.params.data }); send('Page.screencastFrameAck', { sessionId: d.params.sessionId }).catch(() => {}); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
const waitFor = async (e, ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await js(e)) return true; } catch { /* reloading */ } await sleep(250); } return false; };
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const o = window.fetch.bind(window); const j = (x) => Promise.resolve(new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } })); window.fetch = (u, op) => { const p = new URL(String(u), location.origin).pathname; if (p === '/api/ai-media-buyer/launch/discovery/account-assets') return j({ account: { id: 'act_1', name: 'Demo' }, pages: [{ id: '1111', name: 'Trendy Store.', source: 'user_account', verified: true }], instagram: [], pixels: [{ id: 'px1', name: 'trendy Pixel' }], pagesVerified: true, instagramReadable: true, instagramRateLimited: false }); if (p === '/api/meta/page-instagram') return j({ instagram: null, pageBacked: null, rateLimited: false }); if (p === '/api/ai-media-buyer/launch/jobs') return j({ jobs: [] }); return o(u, op); }; document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => document.getElementById('dpPopup')?.remove()).observe(document.body, { childList: true })); })();` });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/login.html` }); await sleep(1200);
await js(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'test-owner@example.invalid',password:'Test-Owner-Only-2026!'})}).then(r=>r.status)`);
const state = { step: 5, jobId: null, jobStarted: false, storeId: 'trendy-storeee', productId: 1, productName: 'منتج', adAccountId: 'act_1', adAccountName: 'Demo', baseName: 'Demo', budgetMode: 'CBO', cboDailyBudget: '300', adSetsPerCampaign: 3, adsPerAdSet: 3, startMode: 'NOW', startDate: '', startTime: '00:00', launchMode: 'NOW', biddingMode: 'AUTOMATIC', platforms: { facebook: true, instagram: true }, pageId: null, pageName: null, instagramId: null, instagramUsername: null, instagramKind: null, pixelId: null, pixelName: null, conversionEvent: 'PURCHASE', perCampaignPixel: false, campaignCount: 1, copyMode: 'SAME', targeting: { mode: 'BROAD', genders: 'ALL', ageMin: 18, ageMax: 65, placementsMode: 'AUTOMATIC', geoRegions: [] }, campaigns: [{ name: 'Demo', primaryText: '', headline: '', websiteUrl: '', pixelId: null }] };
await js(`localStorage.setItem('amb_launch_wizard_v1', ${JSON.stringify(JSON.stringify(state))})`);
await send('Page.navigate', { url: `${BASE}/ai-media-buyer.html#launch` }); await sleep(800); await js('location.reload()').catch(() => {}); await sleep(600);
if (!(await waitFor(`!!document.getElementById('lpGlobeStage')?.__globe && !document.getElementById('lpGlobeMsg') && !!document.querySelector('#lpGlobeStage canvas')`))) { console.log('globe did not load'); process.exit(2); }
await js(`document.querySelector('.lp-globe-card').scrollIntoView({ block: 'center' })`); await sleep(500);
const clip = await js(`(() => { const r = document.querySelector('.lp-globe-card').getBoundingClientRect(); return { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)), width: Math.round(Math.min(r.width, innerWidth - r.left)) & ~1, height: Math.round(Math.min(r.height, innerHeight - r.top)) & ~1, scale: 1 }; })()`);
const ctr = await js(`(() => { const r = document.querySelector('#lpGlobeStage canvas').getBoundingClientRect(); return { x: Math.round(r.left + r.width * 0.62), y: Math.round(r.top + r.height * 0.55) }; })()`);
await send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
await sleep(3500);                                                                                   // 1) slow auto-rotation around Egypt
await mouse('mouseMoved', ctr.x, ctr.y); await mouse('mousePressed', ctr.x, ctr.y);                   // 2) drag to rotate
for (let i = 1; i <= 24; i++) { await mouse('mouseMoved', ctr.x - i * 14, ctr.y + i * 5); await sleep(45); } await mouse('mouseReleased', ctr.x - 24 * 14, ctr.y + 24 * 5); await sleep(900);
for (let i = 0; i < 6; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: ctr.x, y: ctr.y, deltaX: 0, deltaY: -260 }); await sleep(260); } await sleep(1200);   // 3) wheel zoom in
for (let i = 0; i < 6; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: ctr.x, y: ctr.y, deltaX: 0, deltaY: 300 }); await sleep(260); } await sleep(1000);       // 4) wheel zoom out
await js(`document.getElementById('lpZoomIn').click()`); await sleep(1200); await js(`document.getElementById('lpZoomOut').click()`); await sleep(1200);                           // 5) + / − buttons
await js(`document.getElementById('lpToEgypt').click()`); await sleep(3500);                                                                                                       // 6) back to Egypt
await send('Page.stopScreencast'); ws.close(); proc.kill();
let n = 0; const list = [];
for (let i = 0; i < shots.length; i++) { const name = join(frames, `f${String(i).padStart(5, '0')}.jpg`); writeFileSync(name, Buffer.from(shots[i].data, 'base64')); const dur = i + 1 < shots.length ? Math.min(0.5, shots[i + 1].ts - shots[i].ts) : 0.5; list.push(`file '${name.split(String.fromCharCode(92)).join('/')}'`, `duration ${dur.toFixed(3)}`); n++; }
list.push(`file '${join(frames, `f${String(shots.length - 1).padStart(5, '0')}.jpg`).split(String.fromCharCode(92)).join('/')}'`); writeFileSync(join(frames, 'list.txt'), list.join(String.fromCharCode(10)));
const mp4 = join(OUT, 'globe-demo.mp4'); const gif = join(OUT, 'globe-demo.gif');
const a = spawnSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', join(frames, 'list.txt'), '-vf', 'fps=15,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', mp4], { encoding: 'utf8' });
const b = spawnSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', join(frames, 'list.txt'), '-vf', 'fps=10,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer', gif], { encoding: 'utf8' });
console.log(`frames: ${n} · mp4 exit ${a.status} · gif exit ${b.status}`); rmSync(frames, { recursive: true, force: true }); process.exit(a.status === 0 ? 0 : 1);
