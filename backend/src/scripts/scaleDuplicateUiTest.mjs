// 🔁 «دبلكيت للاسكيل» — after a (bulk) scale finished the page says so and asks whether to duplicate it as CBO or ABO, in a real headless browser against the local server on the ISOLATED test database.
//   Every Meta-facing answer is an in-page fixture (nothing leaves the browser, no campaign is created). node src/scripts/scaleDuplicateUiTest.mjs   (expects the server on http://localhost:4002; LP_CAPTURE=1 saves a screenshot)
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

const DUP_FIX = `(() => {
  const orig = window.fetch.bind(window); const calls = (window.__dupCalls = []);
  const resp = (o, s = 200, ms = 60) => new Promise((res) => setTimeout(() => res(new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } })), ms));
  const item = (id, label, status, plan) => ({ sourceCampaignId: id, label, budgetMode: plan.budgetMode, status, startedAt: 1, finishedAt: 2, error: status === 'FAILED' ? 'boom' : null, hint: null, result: status === 'DONE' ? { scaleCampaignName: label + ' scale' } : null, plan });
  const items = [item('S1', 'Anti-suffocation - scale', 'DONE', { budgetMode: 'CBO', selectedAdIds: ['a1', 'a2'], campaignBudgetEgp: 400 }), item('S2', 'teeth - SCALE', 'DONE', { budgetMode: 'ABO', adSets: [{ dailyBudgetEgp: 150, selectedAdIds: ['b1'] }, { dailyBudgetEgp: 250, selectedAdIds: ['b2'] }] }), item('S3', 'Nail-clipper', 'FAILED', { budgetMode: 'CBO', selectedAdIds: ['c1'], campaignBudgetEgp: 300 })];
  const done = { id: 'b1', accountKey: 'PRIMARY', status: 'DONE', stopReason: null, gapSeconds: 60, startMode: 'RUN_NOW', startAt: null, nextAt: null, counts: { total: 3, done: 2, failed: 1, skipped: 0 }, items };
  const running = { ...done, status: 'RUNNING', counts: { total: 3, done: 0, failed: 0, skipped: 0 }, items: items.map((i) => ({ ...i, status: 'QUEUED' })) };
  window.fetch = (u, o) => { const p = new URL(String(u), location.origin);
    if (p.pathname === '/api/ai-media-buyer/scale/winners') return resp({ cards: [{ sourceCampaignId: 'S9', displayName: 'Cup', sourceCampaignName: 'Cup - test', decisionStatus: 'PENDING', orders: 3, cpa: 70, winningCreativeCount: 2, ads: [], proposedScaleCampaignName: 'Cup - scale', defaults: { selectedAdIds: [] } }] });
    if (p.pathname === '/api/ai-media-buyer/scale/bulk/latest') return resp({ batch: window.__dupStarted ? { ...done, id: 'b2', counts: { total: 2, done: 2, failed: 0, skipped: 0 }, items: items.slice(0, 2) } : (window.__b1Done ? done : running) }); // like the real server: the latest batch is what it is NOW (a finished one never turns back into a running one)
    if (p.pathname === '/api/ai-media-buyer/scale/bulk/b1') { window.__b1Done = true; return resp(done); }
    if (p.pathname === '/api/ai-media-buyer/scale/duplicate') { calls.push('dup:' + (o?.body || '')); window.__dupStarted = true; const b = JSON.parse(o.body); return resp({ ...running, id: 'b2', counts: { total: b.items.length, done: 0, failed: 0, skipped: 0 }, items: b.items.map((i) => ({ sourceCampaignId: i.sourceCampaignId, label: i.label, budgetMode: i.budgetMode, status: 'QUEUED', plan: i })) }); }
    if (p.pathname === '/api/ai-media-buyer/scale/bulk/b2') return resp({ ...done, id: 'b2', counts: { total: 2, done: 2, failed: 0, skipped: 0 }, items: items.slice(0, 2) });
    return orig(u, o); };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: DUP_FIX });
const dcalls = () => js(`JSON.stringify(window.__dupCalls || [])`).then((x) => JSON.parse(x));
const clickSel = async (sel) => { for (let k = 0; k < 150; k++) { const hit = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`).catch(() => false); if (hit) return true; await sleep(1000); } return false; }; // the page re-renders a few times while it settles (slow test database): click the moment the element exists
const clickModal = (which) => js(`document.querySelector('.confirm-modal-overlay [data-action="${which}"]').click()`);

try {
  await send('Page.navigate', { url: `${BASE}/login.html` }); await sleep(1200);
  await js(`localStorage.setItem('noShell','1')`); const login = await js(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'mahamoudesmail7@gmail.com',password:'Demo-View-2026!'})}).then(r=>r.status)`);
  if (login !== 200) { console.log('login failed (is the server running on the TEST database?) — stopping'); process.exit(2); }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/ai-media-buyer.html#home` }); await waitFor(`document.readyState === 'complete'`, 15000);

  console.log('\n1. a bulk scale is running → it finishes → the page says so and ASKS about a duplicate');
  ok('the bulk scale panel is on the page (the fixture batch runs for a few seconds, then finishes)', await waitFor(`!!document.querySelector('.amb-bulk-progress')`, 150000));
  ok('when it finishes: «خلص الاسكيل المجمّع — تم 2 · فشل 1», each item shows its state, and the prompt «عايز تعمل دبلكيت للاسكيل؟» appears', await waitFor(`(() => { const t = (document.querySelector('.amb-bulk-progress') || {}).innerText || ''; return !!document.querySelector('.amb-dup') && /خلص الاسكيل المجمّع — تم 2 · فشل 1/.test(t) && /تم ✓/.test(t) && /فشل/.test(t) && /عايز تعمل دبلكيت للاسكيل/.test(t); })()`, 150000));
  ok('the prompt offers CBO or ABO (and «مش دلوقتي»), and counts only the 2 campaigns that were really scaled', await waitFor(`(() => { const d = document.querySelector('.amb-dup'); return !!d && !!d.querySelector('[data-dup-mode="CBO"]') && !!d.querySelector('[data-dup-mode="ABO"]') && /مش دلوقتي/.test(d.innerText) && /2 كامبين/.test(d.innerText) && /هتتأكد الأول/.test(d.innerText); })()`, 150000));
  await shot('scale-duplicate-prompt.png');

  console.log('\n2. choosing the type opens a CONFIRMATION first — nothing starts before it');
  await clickSel('[data-dup-mode="ABO"]');
  ok('the confirmation shows the duplicate in ABO: the CBO one as ONE ad set with its budget (400), the ABO one with its 2 ad sets (400), total 800 — and the failed campaign is NOT in it', await waitFor(`!!document.querySelector('.confirm-modal-overlay')`, 20000) && await js(`(() => { const t = document.querySelector('.confirm-modal-overlay').innerText; return /تأكيد دبلكيت الاسكيل \\(ABO\\)/.test(t) && /Anti-suffocation - scale/.test(t) && /teeth - SCALE/.test(t) && !/Nail-clipper/.test(t) && /1 Ad Set/.test(t) && /2 Ad Set/.test(t) && /800/.test(t); })()`));
  await shot('scale-duplicate-confirm.png');
  await clickModal('cancel'); await sleep(300);
  ok('cancelling the confirmation starts NOTHING (no request was sent)', (await dcalls()).length === 0 && await js(`!document.querySelector('.confirm-modal-overlay')`));
  await clickSel('[data-dup-mode="CBO"]');
  ok('the CBO confirmation: the ABO one becomes one campaign budget = the SUM of its ad sets (400), both 2 ads', await waitFor(`!!document.querySelector('.confirm-modal-overlay')`, 20000) && await js(`(() => { const t = document.querySelector('.confirm-modal-overlay').innerText; return /تأكيد دبلكيت الاسكيل \\(CBO\\)/.test(t) && /teeth - SCALE — .*400.*2 إعلان/.test(t.replace(/\\n/g, ' ')) && /Anti-suffocation - scale — .*400.*2 إعلان/.test(t.replace(/\\n/g, ' ')); })()`));
  await clickModal('confirm'); await sleep(900);
  const sent = (await dcalls())[0] || ''; const body = sent.startsWith('dup:') ? JSON.parse(sent.slice(4)) : null;
  ok('after the owner confirms, ONE request: budgetMode CBO, the 2 finished campaigns with their plans (400 / [a1,a2]), the same gap (60 s) — the failed one is not sent', !!body && body.budgetMode === 'CBO' && body.items.length === 2 && body.items.map((i) => i.sourceCampaignId).join() === 'S1,S2' && body.items[0].campaignBudgetEgp === 400 && body.items[1].budgetMode === 'ABO' && body.gapSeconds === 60, sent);
  ok('the new duplicate batch is shown as running (and the same prompt appears again when it finishes — one more duplicate is possible)', await waitFor(`/دبلكيت/.test(document.body.innerText) && !!document.querySelector('.amb-bulk-progress')`, 150000) && await waitFor(`!!document.querySelector('.amb-dup')`, 120000));

  console.log('\n3. «مش دلوقتي» just closes the prompt');
  await clickSel('.amb-dup [data-bulk-act="dismiss"]'); await sleep(400);
  ok('dismissed: no panel, no request', await js(`!document.querySelector('.amb-dup')`) && (await dcalls()).length === 1);
  console.log('\n4. a steady scale by default: 1 minute between campaigns, with one-click presets (faster ones included)');
  await clickSel('[data-bulk-pick="S9"]'); await clickSel('[data-bulk-act="open"]');
  ok('the bulk panel opens with a 1 minute gap, «آمن 1 د» selected and the summary says 1 دقيقة', await waitFor(`(() => { const g = document.querySelector('[data-bulk-gap]'); const on = document.querySelector('.amb-gap-presets .on'); return !!g && Number(g.value) === 1 && !!on && /آمن 1 د/.test(on.innerText) && /1 دقيقة/.test(document.querySelector('[data-bulk-gaptxt]').innerText); })()`, 150000));
  ok('five presets: أسرع 6 ث · سريع 15 ث · متوسط 30 ث · آمن 1 د · بطيء 2 د', await js(`document.querySelectorAll('.amb-gap-presets button').length === 5 && /أسرع 6 ث/.test(document.querySelector('.amb-gap-presets').innerText) && /بطيء 2 د/.test(document.querySelector('.amb-gap-presets').innerText)`));
  await clickSel('[data-bulk-gap-preset="0.25"]');
  ok('«سريع 15 ث» → the gap becomes 15 seconds (field + summary + the preset is marked)', await waitFor(`(() => { const g = document.querySelector('[data-bulk-gap]'); const on = document.querySelector('.amb-gap-presets .on'); return !!g && Number(g.value) === 0.25 && !!on && /سريع 15 ث/.test(on.innerText) && /15 ثانية/.test(document.querySelector('[data-bulk-gaptxt]').innerText); })()`, 60000));
  await js(`(() => { const g = document.querySelector('[data-bulk-gap]'); g.value = '0.03'; g.dispatchEvent(new Event('input')); })()`); await sleep(300);
  ok('under 5 seconds is refused with a clear hint (the approve button stays off)', await js(`/5 ثواني/.test(document.querySelector('.amb-bulk-hint').innerText) && document.querySelector('[data-bulk-act="approve"]').disabled`));
  ok('no JavaScript errors were thrown during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) { fail++; console.log('  ✗ scale duplicate UI test crashed —', e.message); }
finally { ws.close(); proc.kill(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
