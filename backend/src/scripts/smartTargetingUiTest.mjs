// ✨ LAUNCH WIZARD — «AI Smart Targeting» (the third audience choice) in a real headless browser against the local server on the ISOLATED test database.
//   The proposal comes from an in-page fixture (the real endpoint is covered by smartTargetingTest.js); NO Meta call and NO campaign is ever created.
//   node src/scripts/smartTargetingUiTest.mjs      (expects the server on http://localhost:4002; LP_CAPTURE=1 saves a screenshot under docs/launch-premium/)
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

const SMART_FIX = `(() => {
  const orig = window.fetch.bind(window); const calls = (window.__lpCalls = window.__lpCalls || []);
  const resp = (o, s = 200, ms = 450) => new Promise((res) => setTimeout(() => res(new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } })), ms));
  const R = { ok: true, source: 'AI', sources: { gender: 'AI', age: 'AI', interests: 'AI' }, product: { id: 1, name: 'قلاية هوائية' }, gender: 'FEMALE', genderLabel: 'حريمي', ageMin: 26, ageMax: 50,
    interests: [['6003349442621', 'Cooking', 88000000], ['6003040113419', 'Kitchen', 6000000], ['6003025470329', 'Home appliance', 24000000], ['6003157080527', 'Baking', 12000000], ['6003139266461', 'Online shopping', 700000000]].map(([id, name, u]) => ({ id, name, audienceUpper: u, audienceLower: u * 0.9, why: 'مرتبط بالمنتج: ' + name, exact: true, requested: null })),
    placements: { mode: 'AUTOMATIC', reason: 'المواضع التلقائية بتجيب أرخص نتيجة.' }, locations: { mode: 'EGYPT', regions: [], reason: 'مفيش دليل كفاية على محافظات بعينها.' },
    reasons: { gender: 'قلاية للبيت — ست البيت.', age: 'الأسر من 26 لـ 50.', interests: 'الاهتمامات دي اتشافت واحدة واحدة في بحث Meta.', locations: '', placements: '' }, notes: ['المنتج لسه معندوش شريحة مثبتة من مبيعاته، فالنوع والسن اقتراح مبدئي.'], verification: { available: true, candidates: 6, verified: 5 } };
  window.fetch = (u, o) => { const p = new URL(String(u), location.origin);
    if (p.pathname === '/api/ai-media-buyer/launch/smart-targeting') { calls.push('smart:' + (o?.body || '')); if (window.__smartFail) return resp({ error: 'AI_FAILED', message: 'تعذّر التحليل حاليًا.' }, 502, 200); return resp(R); }
    if (p.pathname === '/api/ai-media-buyer/launch/interest-search') { const q = p.searchParams.get('q'); calls.push('int:' + q); return resp({ results: /gym/i.test(q) ? [{ id: '6003107902433', name: 'Gym', audienceUpper: 300000000, path: 'Interests › Fitness' }, { id: '6003384248805', name: 'Gym membership', audienceUpper: 1000000, path: null }] : /cook/i.test(q) ? [{ id: '6003349442621', name: 'Cooking', audienceUpper: 88000000 }] : [] }, 200, 150); }
    return orig(u, o); };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: SMART_FIX });
const calls = () => js(`JSON.stringify(window.__lpCalls || [])`).then((x) => JSON.parse(x));
const lsT = () => js(`JSON.stringify((JSON.parse(localStorage.getItem('amb_launch_wizard_v1') || '{}')).targeting || {})`).then((x) => JSON.parse(x));
const lsS = () => js(`JSON.stringify(((JSON.parse(localStorage.getItem('amb_launch_wizard_v1') || '{}')).smart || {}))`).then((x) => JSON.parse(x));

try {
  await send('Page.navigate', { url: `${BASE}/login.html` }); await sleep(1200);
  await js(`localStorage.setItem('noShell','1')`); const login = await js(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'mahamoudesmail7@gmail.com',password:'Demo-View-2026!'})}).then(r=>r.status)`);
  if (login !== 200) { console.log('login failed (is the server running on the TEST database?) — stopping'); process.exit(2); }

  console.log('\n1. the third choice sits next to Broad and «تخصيص الجمهور»');
  ok('the audience step opens (Broad is the default) — Page and Pixel already chosen, so only the audience can stop «التالي»', await open({ height: 1300, state: SEED({ pageId: '1111', pageName: 'Trendy Store.', pixelId: 'px1', pixelName: 'trendy Pixel', platforms: { facebook: true, instagram: false } }) }));
  ok('three modes: Broad · تخصيص الجمهور · ✨ AI Smart Targeting (with its one-line promise)', await js(`(() => { const r = [...document.querySelectorAll('input[name="ambLaunchTargetingMode"]')].map((x) => x.value); return r.join() === 'BROAD,CUSTOM,SMART' && /AI Smart Targeting/.test(document.querySelector('.lp-mode-ai').innerText) && /يحلل المنتج/.test(document.querySelector('.lp-mode-ai').innerText); })()`));
  ok('Broad is selected and no Smart panel is shown (nothing changes for existing flows)', await js(`document.querySelector('input[value="BROAD"]').checked && !document.querySelector('.sm-box')`));

  console.log('\n2. choosing it analyses the product by itself and shows an EDITABLE proposal');
  await js(`document.querySelector('input[value="SMART"]').click()`);
  ok('the analysis starts at once (loading state) and calls the read-only endpoint with the chosen product', await waitFor(`!!document.querySelector('.sm-loading')`, 8000) && (await calls()).some((c) => c.startsWith('smart:') && c.includes('"productId":1')));
  ok('the proposal appears: gender, age, placements, interests, reasons, notes, source badge, Apply button', await waitFor(`!!document.querySelector('.sm-chips .sm-chip') && !!document.getElementById('smApply')`, 15000));
  ok('gender «حريمي» is selected (the AI said FEMALE), age 26 — 50, placements Advantage+', await js(`document.querySelector('[data-sm-gender="FEMALE"]').classList.contains('on') && !document.querySelector('[data-sm-gender="MALE"]').classList.contains('on') && document.getElementById('smAgeMin').value === '26' && document.getElementById('smAgeMax').value === '50' && document.getElementById('smPlacements').value === 'AUTOMATIC'`));
  ok('exactly the 5 verified interests are shown as chips, each with its audience size', await js(`(() => { const c = [...document.querySelectorAll('.sm-chips .sm-chip')]; return c.length === 5 && c[0].innerText.includes('Cooking') && /مليون/.test(c[0].innerText); })()`));
  ok('«ليه الاختيار ده؟» lists the reasons (gender, age, interests, locations, placements) and the honest note about the first proposal', await js(`(() => { const t = document.querySelector('.sm-why').innerText; return /النوع/.test(t) && /ست البيت/.test(t) && /السن/.test(t) && /الاهتمامات/.test(t) && /المحافظات/.test(t) && /المواضع/.test(t) && /اقتراح مبدئي/.test(document.querySelector('.sm-notes').innerText); })()`));
  ok('the source is shown honestly (AI + Meta check)', await js(`/AI \\+ تحقق Meta/.test(document.querySelector('.sm-badge').innerText)`));
  ok('the draft already fills the wizard targeting (mode SMART) but it is NOT applied yet', (await lsT()).mode === 'SMART' && (await lsT()).interests?.length === 5 && !(await lsS()).applied);
  await js(`(() => { const el = document.querySelector('.lp-modes'); el.scrollIntoView({ block: 'start' }); window.scrollBy(0, -20); })()`); await sleep(500); await shot('smart-targeting.png');

  console.log('\n3. everything can be edited before applying');
  await js(`document.querySelector('[data-sm-gender="ALL"]').click()`); await sleep(200);
  ok('gender → «الاتنين» (kept in the wizard state)', (await lsT()).genders === 'ALL' && await js(`document.querySelector('[data-sm-gender="ALL"]').classList.contains('on')`));
  await js(`(() => { const a = document.getElementById('smAgeMin'); a.value = '22'; a.dispatchEvent(new Event('change')); const b = document.getElementById('smAgeMax'); b.value = '40'; b.dispatchEvent(new Event('change')); })()`); await sleep(200);
  ok('age edited to 22 — 40 (kept)', (await lsT()).ageMin === 22 && (await lsT()).ageMax === 40);
  await js(`(() => { const a = document.getElementById('smAgeMin'); a.value = '60'; a.dispatchEvent(new Event('change')); })()`); await sleep(200);
  ok('an impossible age range is corrected (min above max pushes max up), never sent broken', (await lsT()).ageMin === 60 && (await lsT()).ageMax >= 60);
  await js(`(() => { const a = document.getElementById('smAgeMin'); a.value = '22'; a.dispatchEvent(new Event('change')); const b = document.getElementById('smAgeMax'); b.value = '40'; b.dispatchEvent(new Event('change')); })()`); await sleep(200);
  await js(`document.querySelectorAll('[data-sm-rm]')[4].click()`); await sleep(400);
  ok('removing an interest (×) works: 4 left, saved', await js(`document.querySelectorAll('.sm-chips .sm-chip').length === 4`) && (await lsT()).interests.length === 4);
  await js(`(() => { const q = document.getElementById('smIntQ'); q.value = 'Gym'; q.dispatchEvent(new Event('input')); })()`);
  ok('adding one: the search goes to the read-only Meta search and lists real interests (name, audience, path)', await waitFor(`document.querySelectorAll('#smIntRes [data-sm-add]').length === 2`, 8000) && (await calls()).includes('int:Gym') && await js(`/Gym/.test(document.getElementById('smIntRes').innerText) && /Fitness/.test(document.getElementById('smIntRes').innerText)`));
  await js(`document.querySelector('#smIntRes [data-sm-add]').click()`); await sleep(500);
  ok('the picked interest is added with its REAL Meta id (5 chips again)', (await lsT()).interests.length === 5 && (await lsT()).interests.some((i) => i.id === '6003107902433' && i.name === 'Gym'));
  await js(`(() => { const q = document.getElementById('smIntQ'); q.value = 'cook'; q.dispatchEvent(new Event('input')); })()`);
  await waitFor(`document.querySelectorAll('#smIntRes [data-sm-add]').length === 1`, 8000); await js(`document.querySelector('#smIntRes [data-sm-add]').click()`); await sleep(400);
  ok('adding an interest that is already there is refused (no duplicates)', (await lsT()).interests.filter((i) => i.id === '6003349442621').length === 1);

  console.log('\n4. Apply is required before going on');
  await js(`document.getElementById('ambLaunchNext').click()`); await sleep(500);
  ok('«التالي» without applying is blocked with a clear message (still on step 5)', (await snap()).includes('"step":5') && await js(`/تطبيق الاستهداف/.test(document.body.innerText)`));
  await js(`document.getElementById('smApply').click()`); await sleep(500);
  ok('«تطبيق الاستهداف» → the panel says it is applied and the choice is saved with the applied flag', await js(`!!document.querySelector('.sm-ok')`) && (await lsS()).applied === true);
  ok('the saved targeting is exactly what goes to the server: SMART, gender ALL, age 22-40, interests with real ids', (() => true)() && (await lsT()).mode === 'SMART' && (await lsT()).genders === 'ALL' && (await lsT()).ageMin === 22 && (await lsT()).interests.every((i) => /^\d{10,}$/.test(i.id)));
  await js(`document.getElementById('ambLaunchNext').click()`); await sleep(600);
  ok('after applying, «التالي» goes on to the next step', !(await snap()).includes('"step":5'));
  ok('the whole time NOTHING was written to Meta or to a launch job (only read calls)', !(await calls()).some((c) => c.startsWith('WRITE:')));

  console.log('\n5. it survives a reload, and a failure is shown with a retry');
  const keep = { ...JSON.parse(await js(`localStorage.getItem('amb_launch_wizard_v1')`)), step: 5 }; const reopened = await open({ state: keep }); const back = await waitFor(`!!document.querySelector('.sm-ok') && document.querySelectorAll('.sm-chips .sm-chip').length === 5`, 10000);
  ok('re-open the step: the applied Smart choice is still there (chips + applied)', reopened && back, JSON.stringify({ reopened, keptSmart: keep.smart && { status: keep.smart.status, applied: keep.smart.applied, pid: keep.smart.productId }, now: await lsS().then((x) => ({ status: x.status, applied: x.applied })), mode: keep.targeting?.mode, panel: await js(`(document.querySelector('.sm-box')||{}).innerText`) }));
  await js(`window.__smartFail = true`); await js(`document.getElementById('smRun').click()`);
  ok('a failed analysis shows the reason and «حاول تاني» (nothing breaks, nothing applied)', await waitFor(`!!document.querySelector('.sm-box .lp-note') && /تعذّر التحليل/.test(document.querySelector('.sm-box').innerText) && !!document.getElementById('smRun')`, 8000) && !(await lsS()).applied);
  await js(`window.__smartFail = false`); await js(`document.getElementById('smRun').click()`);
  ok('retry works and the proposal is back (not applied again until confirmed)', await waitFor(`!!document.getElementById('smApply') && document.querySelectorAll('.sm-chips .sm-chip').length === 5`, 10000));
  ok('switching back to Broad removes the Smart panel and the other modes still work (CUSTOM shows its own fields)', await js(`(() => { document.querySelector('input[value="CUSTOM"]').click(); return true; })()`) && await waitFor(`!!document.getElementById('ambLaunchTargetGender') && !document.querySelector('.sm-box')`, 8000));
  ok('no JavaScript errors were thrown during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) { fail++; console.log('  ✗ smart targeting UI test crashed —', e.message); }
finally { ws.close(); proc.kill(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
