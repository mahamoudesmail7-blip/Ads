// 🌍 LAUNCH WIZARD — step «المنصات والصفحة والجمهور»: the premium layout + the REAL interactive 3D globe, in a real headless browser against the local server on the ISOLATED test database.
//   The wizard's own API answers (account assets / page instagram / geo-search) are served by in-page fixtures — NO Meta call and NO campaign is ever created. The globe is a real WebGL sphere (software GL in CI).
//   Covers: rotate by mouse · wheel + buttons zoom (clamped) · back to Egypt · country fly-to is DISPLAY ONLY · city pick = real Meta key · Broad adds nothing · state survives re-render/reload · FB/IG/Page/Pixel/Instagram identity ·
//   audience size is never invented · no continent names · reduced motion · WebGL missing / library blocked (fallback keeps every tool) · pause when hidden · dispose on leaving the step · phone layout.
//   node src/scripts/launchGlobeUiTest.mjs      (expects the server on http://localhost:4002 — the runner starts it; LP_CAPTURE=1 also saves screenshots + frames under docs/launch-premium/)
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleepRaw } from 'node:timers/promises';
const SLOW = Number(process.env.OPX_SLOW) || 1; const sleep = (ms) => sleepRaw(ms * SLOW);
const BROWSER = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
if (!BROWSER) { console.log('no Chromium browser found — skipped'); process.exit(0); }
const BASE = process.env.LP_BASE || 'http://localhost:4002'; let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 700) : ''}`); } };
const CAPTURE = process.env.LP_CAPTURE === '1'; const here = dirname(fileURLToPath(import.meta.url)); const OUT = join(here, '../../../docs/launch-premium'); if (CAPTURE) mkdirSync(OUT, { recursive: true });
const PORT = 9300 + Math.floor(Math.random() * 300); const dir = mkdtempSync(join(tmpdir(), 'lpui-'));
const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 80; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch { /* starting */ } await sleep(250); }
const page = targets.find((t) => t.type === 'page'); const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map(); const consoleErrors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') consoleErrors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error'); return r.result.value; };
const WAIT = Number(process.env.OPX_WAIT_MS) || 30000;
const waitFor = async (expr, ms = WAIT) => { ms = Math.max(ms, WAIT); const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await js(expr)) return true; } catch { /* page reloading */ } await sleep(250); } return false; };
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');

// ---- the wizard's fixtures (served in-page; nothing leaves the browser) ----
const FIX = `(() => {
  const orig = window.fetch.bind(window); const calls = (window.__lpCalls = []);
  const json = (o, s = 200) => Promise.resolve(new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } }));
  const REGIONS = { 'القاهرة': [{ key: '1001', name: 'القاهرة' }], 'الإسكندرية': [{ key: '1002', name: 'الإسكندرية' }, { key: '1003', name: 'الإسكندرية الجديدة' }], 'الجيزة': [{ key: '1004', name: 'الجيزة' }], 'أسوان': [{ key: '1005', name: 'أسوان' }] };
  window.fetch = (u, o) => { const url = String(u); const p = new URL(url, location.origin);
    if (p.pathname === '/api/ai-media-buyer/launch/discovery/account-assets') { calls.push('assets'); return json({ account: { id: 'act_1', name: 'Fixture' }, pages: [{ id: '1111', name: 'Trendy Store.', source: 'user_account', verified: true }, { id: '2222', name: 'Green Glass', source: 'user_account', verified: true }, { id: '3333', name: 'Aman', source: 'user_account', verified: true }], instagram: [], pixels: [{ id: 'px1', name: 'trendy Pixel' }, { id: 'px2', name: 'Madar Pixel' }], pagesVerified: true, instagramReadable: true, instagramRateLimited: false }); }
    if (p.pathname === '/api/meta/page-instagram') { calls.push('pageig:' + p.searchParams.get('pageId')); const pid = p.searchParams.get('pageId'); return json(pid === '2222' ? { instagram: { id: '17841400000000002', username: 'green.glass' }, pageBacked: null, rateLimited: false } : pid === '1111' ? { instagram: null, pageBacked: { id: '17841478345529875', username: null }, rateLimited: false } : { instagram: null, pageBacked: null, rateLimited: false }); }
    if (p.pathname === '/api/ai-media-buyer/launch/geo-search') { const q = p.searchParams.get('q'); calls.push('geo:' + q); return json({ results: REGIONS[q] || Object.entries(REGIONS).filter(([k]) => k.includes(q)).flatMap(([, v]) => v) }); }
    if (p.pathname === '/api/ai-media-buyer/launch/jobs') return json({ jobs: [] });
    if (/\\/launch\\/(publish|jobs\\/.+\\/(start|queue))/.test(p.pathname) && (o?.method || 'GET') !== 'GET') { calls.push('WRITE:' + p.pathname); return json({ error: 'blocked in test' }, 500); }
    return orig(u, o); };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: FIX });
// the app's daily-plan popup (00:00 / 13:00 Cairo) is an unrelated full-screen overlay that would swallow the mouse in a test run at that hour: keep it out of the way
await send('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => document.getElementById('dpPopup')?.remove()).observe(document.body, { childList: true }));` });

const snap = () => js(`(() => { const s = JSON.parse(localStorage.getItem('amb_launch_wizard_v1') || '{}'); return JSON.stringify({ step: s.step, platforms: s.platforms, pageId: s.pageId, pixelId: s.pixelId, instagramId: s.instagramId, instagramKind: s.instagramKind, conversionEvent: s.conversionEvent, targeting: s.targeting }); })()`);
const SEED = (extra = {}) => ({ step: 5, jobId: null, jobStarted: false, storeId: 'trendy-storeee', productId: 1, productName: 'منتج تجريبي', adAccountId: 'act_1', adAccountName: 'Fixture', baseName: 'Cup - Test', budgetMode: 'CBO', cboDailyBudget: '300', adSetsPerCampaign: 3, adsPerAdSet: 3, startMode: 'SCHEDULED', startDate: '', startTime: '00:00', launchMode: 'PAUSED_REVIEW', biddingMode: 'AUTOMATIC', platforms: { facebook: true, instagram: true }, pageId: null, pageName: null, instagramId: null, instagramUsername: null, instagramKind: null, pixelId: null, pixelName: null, conversionEvent: 'PURCHASE', perCampaignPixel: false, campaignCount: 1, copyMode: 'SAME', targeting: { mode: 'BROAD', genders: 'ALL', ageMin: 18, ageMax: 65, placementsMode: 'AUTOMATIC', geoRegions: [] }, campaigns: [{ name: 'Cup - Test', primaryText: '', headline: '', websiteUrl: '', pixelId: null }], ...extra });
const open = async ({ width = 1440, height = 900, mobile = false, state = SEED(), media = [] } = {}) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await send('Emulation.setEmulatedMedia', { media: 'screen', features: media });
  await send('Page.navigate', { url: `${BASE}/login.html` }); await waitFor(`document.readyState === 'complete'`, 15000);
  await js(`localStorage.setItem('amb_launch_wizard_v1', ${JSON.stringify(JSON.stringify(state))})`);
  await send('Page.navigate', { url: `${BASE}/ai-media-buyer.html#launch` }); await waitFor(`document.readyState === 'complete'`, 15000);
  await js('location.reload()').catch(() => {}); await sleep(600);
  return waitFor(`!!document.querySelector('.lp-step') && !!document.getElementById('ambLaunchGeoSearch')`, 60000);
};
const globeReady = () => waitFor(`!!document.getElementById('lpGlobeStage')?.__globe && !document.getElementById('lpGlobeMsg') && !!document.querySelector('#lpGlobeStage canvas')`, 90000);
const pov = () => js(`document.getElementById('lpGlobeStage').__globe.pov()`);
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
const centre = () => js(`(() => { const r = document.querySelector('#lpGlobeStage canvas').getBoundingClientRect(); return { x: Math.round(r.left + r.width * 0.62), y: Math.round(r.top + r.height * 0.55) }; })()`);
const shot = async (name) => { if (!CAPTURE) return; const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64')); };

try {
  await send('Page.navigate', { url: `${BASE}/login.html` }); await sleep(1200);
  await js(`localStorage.setItem('noShell','1')`); const login = await js(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'test-owner@example.invalid',password:'Test-Owner-Only-2026!'})}).then(r=>r.status)`);
  if (login !== 200) { console.log('login failed (is the server running on the TEST database?) — stopping'); process.exit(2); }

  console.log('\n1. The premium layout: every real control is still there (same ids), and the stepper is the premium one');
  ok('the wizard opens on step 5 with the premium two-column layout: settings cards + the globe card', await open());
  ok('the wizard body carries the premium theme and the stepper keeps its 10 steps (step 5 active)', await js(`document.getElementById('ambLaunchBody').classList.contains('lp-theme') && document.querySelectorAll('.amb-steps .amb-step').length === 10 && document.querySelector('.amb-step.active .n').textContent.trim() === '5'`));
  ok('all the original controls exist with their original ids / names (FB, IG, Page, Pixel, event, mode, search, chips, nav)', await js(`['ambLaunchPlatFb','ambLaunchPlatIg','ambLaunchConvEvent','ambLaunchGeoSearch','ambLaunchGeoResults','ambLaunchGeoChips','ambLaunchBack','ambLaunchNext'].every((i) => !!document.getElementById(i)) && ['ambLaunchPage','ambLaunchPixel','ambLaunchTargetingMode'].every((n) => document.querySelectorAll('input[name="' + n + '"]').length > 0)`));
  ok('Lucide icons are used (inline SVG), not emoji', await js(`document.querySelectorAll('.lp-card-h .lp-ico, .lp-plat .lp-ico').length >= 6`));
  ok('the page cards show real names / ids from the account (Trendy Store. · 1111 …), pixels too', await js(`/Trendy Store\\./.test(document.body.innerText) && /1111/.test(document.body.innerText) && /trendy Pixel/.test(document.body.innerText) && /px1/.test(document.body.innerText)`));
  ok('the layout is RTL', await js(`getComputedStyle(document.querySelector('.lp-theme')).direction === 'rtl'`));
  await shot('step5-desktop-before-globe.png');

  console.log('\n2. A REAL WebGL globe (lazy), Egypt highlighted, no continent names, no invented audience number');
  ok('the 3D library + textures load lazily and a real <canvas> appears with the loader gone', await globeReady());
  ok('the planet is a WebGL canvas (not an image / video / gif) and the texture is the compressed one', await js(`(() => { const c = document.querySelector('#lpGlobeStage canvas'); const gl = c.getContext('webgl2') || c.getContext('webgl'); return !!gl && ['earth-1k.jpg', 'earth-2k.jpg'].includes(document.getElementById('lpGlobeStage').__globe.info.texture) && !document.querySelector('.lp-globe-card video, .lp-globe-card img[src*="earth"]'); })()`));
  ok('GPU is capped: pixel ratio ≤ 1.5', await js(`document.getElementById('lpGlobeStage').__globe.info.rendererPixelRatio <= 1.5`));
  ok('Egypt has its pin: flag + «مصر» label', await waitFor(`!!document.querySelector('.lp-pin .lp-flag svg') && /مصر/.test(document.querySelector('.lp-pin .lp-pinname').textContent)`));
  ok('no continent / country NAMES are drawn on the globe (only Egypt’s own label)', await js(`!/أوروبا|آسيا|اسيا|أفريقيا|افريقيا|Europe|Asia|Africa|America|Oceania/i.test(document.getElementById('lpGlobeStage').innerText + ' ' + document.querySelector('.lp-tip').innerText)`));
  ok('the audience size says «غير متاح» — never a made-up number like 45.2M', await js(`(() => { const t = document.querySelector('.lp-aud').innerText; return /غير متاح/.test(t) && !/\\d+(\\.\\d+)?\\s*[MK]/.test(t) && !/45\\.2/.test(document.body.innerText); })()`));
  ok('it opens already centred near Egypt', await waitFor(`(() => { const p = document.getElementById('lpGlobeStage').__globe.pov(); return Math.abs(p.lat - 26.8) < 6 && Math.abs(p.lng - 30.8) < 8; })()`, 15000));
  ok('auto-rotate is ON at the start (slow, smooth)', await js(`document.getElementById('lpGlobeStage').__globe.isAutoRotating()`));
  await shot('step5-desktop.png');

  console.log('\n3. Interaction: mouse drag rotates, the wheel and the +/− buttons zoom within limits, «العودة إلى مصر» flies back');
  const before = await snap(); const p0 = await pov(); const c = await centre();
  await mouse('mouseMoved', c.x, c.y); await mouse('mousePressed', c.x, c.y); for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', c.x - i * 18, c.y + i * 6); await sleep(40); } await mouse('mouseReleased', c.x - 8 * 18, c.y + 8 * 6); await sleep(500);
  const p1 = await pov(); ok('dragging with the mouse rotates the planet (lat/lng changed)', Math.abs(p1.lng - p0.lng) > 2 || Math.abs(p1.lat - p0.lat) > 1, JSON.stringify([p0, p1]));
  ok('auto-rotate stops while the user interacts', await js(`!document.getElementById('lpGlobeStage').__globe.isAutoRotating()`));
  const a0 = (await pov()).altitude; for (let i = 0; i < 4; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: -240 }); await sleep(120); } await sleep(500);
  const a1 = (await pov()).altitude; ok('the mouse wheel zooms IN (altitude decreased)', a1 < a0 - 0.01, `${a0} → ${a1}`);
  for (let i = 0; i < 40; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: -400 }); } await sleep(700);
  const aMin = (await pov()).altitude; ok('zoom-in is clamped (never inside the planet)', aMin >= 0.5 && aMin < a1, String(aMin));
  for (let i = 0; i < 60; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: 400 }); } await sleep(700);
  const aMax = (await pov()).altitude; ok('zoom-out is clamped (never out of sight)', aMax <= 4.6 && aMax > aMin, String(aMax));
  await js(`document.getElementById('lpToEgypt').click()`); await waitFor(`Math.abs(document.getElementById('lpGlobeStage').__globe.pov().altitude - 1.9) < 0.05`, 15000); await sleep(300);
  const z1 = (await pov()).altitude; await js(`document.getElementById('lpZoomIn').click()`); await sleep(900); const z2 = (await pov()).altitude;
  ok('the + button zooms in (one press ≈ ×0.68, never past the minimum)', z2 < z1 - 0.2 && z2 >= 0.5, `${z1} → ${z2}`);
  await js(`document.getElementById('lpZoomOut').click()`); await sleep(700); const z3 = (await pov()).altitude; ok('the − button zooms out', z3 > z2, `${z2} → ${z3}`);
  await mouse('mouseMoved', c.x, c.y); await mouse('mousePressed', c.x, c.y); for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', c.x + i * 25, c.y - i * 8); await sleep(30); } await mouse('mouseReleased', c.x + 250, c.y - 80); await sleep(400);
  await js(`document.getElementById('lpToEgypt').click()`);
  ok('«العودة إلى مصر» flies the camera smoothly back to Egypt', await waitFor(`(() => { const p = document.getElementById('lpGlobeStage').__globe.pov(); return Math.abs(p.lat - 26.8) < 1.5 && Math.abs(p.lng - 30.8) < 1.5 && Math.abs(p.altitude - 1.9) < 0.25; })()`, 15000));
  ok('moving / zooming the planet changed NOTHING in the campaign (platforms, page, pixel, instagram, targeting identical)', (await snap()) === before);
  ok('Broad mode: Egypt was NOT added to the targeting (no regions, no countries added) just because the globe shows it', await js(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).targeting.geoRegions.length === 0 && JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).targeting.mode === 'BROAD'`));
  ok('the globe never wrote anything to Meta (no write call was made)', !(await js(`window.__lpCalls.some((x) => x.startsWith('WRITE:'))`)));
  await shot('step5-desktop-zoom.png');

  console.log('\n4. Country search is DISPLAY ONLY; city picks use the real Meta key and only in «تخصيص الجمهور»');
  const beforeSearch = await snap();
  await js(`(() => { const i = document.getElementById('ambLaunchGeoSearch'); i.value = 'فرنسا'; i.dispatchEvent(new Event('input')); })()`);
  ok('typing a country shows it in the results marked «عرض فقط»', await waitFor(`!!document.querySelector('#ambLaunchGeoResults [data-country="FR"]') && /عرض فقط/.test(document.getElementById('ambLaunchGeoResults').innerText)`));
  const pBeforeFly = await pov(); await js(`document.querySelector('#ambLaunchGeoResults [data-country="FR"]').click()`); await sleep(1500);
  const pFly = await pov(); ok('choosing it moves the camera there visually (lat/lng changed toward France)', Math.abs(pFly.lat - pBeforeFly.lat) > 5 || Math.abs(pFly.lng - pBeforeFly.lng) > 5, JSON.stringify([pBeforeFly, pFly]));
  ok('…and the targeting did NOT change; the panel says it is display only', (await snap()) === beforeSearch && await js(`/للعرض على الكوكب فقط/.test(document.getElementById('lpCountryNote').textContent)`));
  await js(`document.getElementById('lpToEgypt').click()`);
  ok('in Broad the quick cities are disabled and the panel says why', await js(`[...document.querySelectorAll('[data-quick]')].every((b) => b.disabled) && /فعّل «تخصيص الجمهور»/.test(document.getElementById('lpGeoHint').textContent)`));
  await js(`document.querySelector('input[name="ambLaunchTargetingMode"][value="CUSTOM"]').click()`);
  ok('switching to «تخصيص الجمهور» shows gender / age / placements and enables the quick cities', await waitFor(`!!document.getElementById('ambLaunchTargetGender') && !!document.getElementById('ambLaunchAgeMin') && !!document.getElementById('ambLaunchPlacementsMode') && [...document.querySelectorAll('[data-quick]')].every((b) => !b.disabled)`));
  await js(`document.querySelector('[data-quick="القاهرة"]').click()`);
  ok('picking «القاهرة» resolves Meta’s REAL key first (1001), then adds exactly that region', await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).targeting.geoRegions.some((r) => r.key === '1001' && r.name === 'القاهرة')`) && await js(`window.__lpCalls.includes('geo:القاهرة')`));
  ok('the chip + the highlighted row + a glowing marker on the planet appear in place (the planet was not rebuilt)', await js(`document.querySelectorAll('#ambLaunchGeoChips .lp-chip').length === 1 && document.querySelector('[data-quick="القاهرة"]').classList.contains('on') && document.getElementById('lpGlobeStage').__globe.pointCount() === 1`));
  await js(`(() => { const i = document.getElementById('ambLaunchGeoSearch'); i.value = 'الإسكندرية'; i.dispatchEvent(new Event('input')); })()`);
  ok('searching a city in custom mode lists Meta’s regions (add to targeting)', await waitFor(`!!document.querySelector('#ambLaunchGeoResults [data-geo-key="1002"]')`));
  await js(`document.querySelector('#ambLaunchGeoResults [data-geo-key="1002"]').click()`);
  ok('clicking it adds that Meta key (1002); two regions now, two markers', await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).targeting.geoRegions.length === 2`) && await js(`document.getElementById('lpGlobeStage').__globe.pointCount() === 2`));
  await js(`document.querySelector('#ambLaunchGeoChips [data-geo-remove="0"]').click()`);
  ok('removing a chip removes that region from the targeting and its marker; one region left (الإسكندرية), one marker', await waitFor(`(() => { const t = JSON.parse(localStorage.getItem('amb_launch_wizard_v1')); return t.targeting.geoRegions.length === 1 && t.targeting.geoRegions[0].key === '1002' && document.getElementById('lpGlobeStage').__globe.pointCount() === 1; })()`));
  await js(`document.getElementById('ambLaunchTargetGender').value = 'FEMALE'; document.getElementById('ambLaunchTargetGender').dispatchEvent(new Event('change')); document.getElementById('ambLaunchAgeMin').value = '25'; document.getElementById('ambLaunchAgeMin').dispatchEvent(new Event('change')); document.getElementById('ambLaunchPlacementsMode').value = 'FEED_ONLY'; document.getElementById('ambLaunchPlacementsMode').dispatchEvent(new Event('change'));`);
  ok('gender / min age / placements still write the same targeting fields (FEMALE, 25, FEED_ONLY)', await js(`(() => { const t = JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).targeting; return t.genders === 'FEMALE' && t.ageMin === 25 && t.placementsMode === 'FEED_ONLY'; })()`) || await waitFor(`(() => { const t = JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).targeting; return t.genders === 'FEMALE' && t.ageMin === 25 && t.placementsMode === 'FEED_ONLY'; })()`, 3000));

  console.log('\n5. Platforms, Page, Instagram identity and Pixel behave exactly as before');
  await js(`document.querySelector('input[name="ambLaunchPage"][value="1111"]').click()`);
  ok('Trendy Store. (no linked account) → the Page’s own Instagram is picked and labelled', await waitFor(`/إنستجرام الصفحة نفسها/.test(document.body.innerText) && JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).instagramKind === 'PAGE_BACKED'`));
  await js(`document.querySelector('input[name="ambLaunchPage"][value="3333"]').click()`);
  ok('Aman (no Instagram at all) → the honest warning with retry / Facebook-only buttons', await waitFor(`!!document.getElementById('ambLaunchIgEmpty') && !!document.getElementById('ambLaunchIgRetry') && !!document.getElementById('ambLaunchIgFbOnly')`));
  await js(`document.getElementById('ambLaunchIgFbOnly').click()`);
  ok('«كمّل على فيسبوك فقط» turns Instagram off', await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).platforms.instagram === false`));
  await waitFor(`!!document.getElementById('ambLaunchPlatIg')`); await js(`document.getElementById('ambLaunchPlatIg').click()`); await sleep(700);
  await js(`document.querySelector('input[name="ambLaunchPage"][value="2222"]').click()`);
  ok('Green Glass (a linked account) → @green.glass is picked as LINKED', await waitFor(`(() => { const s = JSON.parse(localStorage.getItem('amb_launch_wizard_v1')); return s.pageId === '2222' && s.instagramId === '17841400000000002' && s.instagramKind === 'LINKED'; })()`));
  await js(`document.querySelector('input[name="ambLaunchPixel"][value="px2"]').click(); document.getElementById('ambLaunchConvEvent').value = 'ADD_TO_CART'; document.getElementById('ambLaunchConvEvent').dispatchEvent(new Event('change'));`);
  ok('Pixel + conversion event selections are saved (px2)', await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).pixelId === 'px2'`));
  ok('the planet was built ONCE through all those re-renders (the same canvas element, still alive)', await js(`document.querySelectorAll('#lpGlobeStage canvas').length === 1 && !!document.getElementById('lpGlobeStage').__globe`));
  const beforeReload = await snap();
  await js('location.reload()'); await sleep(800);
  ok('the choices survive a reload (regions, page, pixel, mode) and the globe comes back', await waitFor(`!!document.querySelector('.lp-step')`, 60000) && (await snap()) === beforeReload && await globeReady());

  console.log('\n6. Reduced motion, hidden tab, leaving the step');
  ok('prefers-reduced-motion: no auto-rotate and instant moves', await open({ media: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }) && await globeReady() && await js(`!document.getElementById('lpGlobeStage').__globe.isAutoRotating()`));
  const f0 = await js(`document.getElementById('lpGlobeStage').__globe.frames()`); await sleep(500); const f1 = await js(`document.getElementById('lpGlobeStage').__globe.frames()`);
  ok('while visible it keeps rendering', f1 > f0, `${f0} → ${f1}`);
  await js(`Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange'));`); await sleep(400);
  const h0 = await js(`document.getElementById('lpGlobeStage').__globe.frames()`); await sleep(700); const h1 = await js(`document.getElementById('lpGlobeStage').__globe.frames()`);
  ok('when the tab is hidden the drawing STOPS (no frames rendered)', h1 === h0, `${h0} → ${h1}`);
  await js(`Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange'));`); await sleep(600);
  ok('…and resumes when it is visible again', (await js(`document.getElementById('lpGlobeStage').__globe.frames()`)) > h1);
  await js(`document.getElementById('ambLaunchHistoryBtn').click()`);
  ok('leaving the step (history) disposes the planet: canvas gone, nothing left rendering', await waitFor(`!document.querySelector('#lpGlobeStage canvas') && !document.getElementById('lpGlobeStage')`, 15000));

  console.log('\n7. Failure modes: WebGL missing / library blocked → every targeting tool still works');
  const noGl = await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__noGL = true; const _gc = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { if (window.__noGL && /webgl/i.test(t)) return null; return _gc.call(this, t, ...a); };` });
  ok('no WebGL: the step still opens', await open({ state: SEED({ targeting: { mode: 'CUSTOM', genders: 'ALL', ageMin: 18, ageMax: 65, placementsMode: 'AUTOMATIC', geoRegions: [] } }) }));
  ok('…with a clear message instead of the planet', await waitFor(`/WebGL/.test(document.getElementById('lpGlobeMsg')?.innerText || '') && !document.querySelector('#lpGlobeStage canvas')`, 30000));
  await js(`document.querySelector('[data-quick="الجيزة"]').click()`);
  ok('…and the quick cities / search / chips keep working (Giza → Meta key 1004)', await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).targeting.geoRegions.some((r) => r.key === '1004')`) && await js(`document.querySelectorAll('#ambLaunchGeoChips .lp-chip').length === 1`));
  ok('…and the next button still works (not blocked by the missing planet)', await js(`!document.getElementById('ambLaunchNext').disabled`));
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: noGl.identifier }); await js(`window.__noGL = false`);
  await send('Network.setBlockedURLs', { urls: ['*globe.gl.min.js'] });
  ok('library download blocked: the step opens and says the planet could not load', await open() && await waitFor(`/تعذّر تحميل الكوكب/.test(document.getElementById('lpGlobeMsg')?.innerText || '')`, 40000));
  ok('…with the search box and cards fully usable', await js(`!document.getElementById('ambLaunchGeoSearch').disabled && document.querySelectorAll('.lp-card').length >= 6`));
  await send('Network.setBlockedURLs', { urls: [] });

  console.log('\n8. Phone layout');
  ok('phone (390px): the step renders', await open({ width: 390, height: 844, mobile: true }));
  ok('phone: no horizontal scroll, the globe card is above the settings and fits the screen', await js(`document.documentElement.scrollWidth <= window.innerWidth + 2 && document.querySelector('.lp-globe-card').getBoundingClientRect().right <= window.innerWidth + 1 && document.querySelector('.lp-globe-card').getBoundingClientRect().top < document.querySelector('.lp-cards').getBoundingClientRect().top`));
  ok('phone: the planet loads, touch controls exist (+ / − / Egypt) and the targeting panel is reachable', await globeReady() && await js(`!!document.getElementById('lpZoomIn') && !!document.getElementById('lpToEgypt') && !!document.getElementById('ambLaunchGeoSearch')`));
  await shot('step5-mobile.png');
  ok('no JavaScript errors were thrown during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) { fail++; console.log('  ✗ launch globe UI test crashed —', e.message); }
finally { ws.close(); proc.kill(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
