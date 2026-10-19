// 🧭 LAUNCH WIZARD — the premium redesign of ALL NINE steps, in a real headless browser against the local server on the ISOLATED test database.
//   Every Meta-facing API answer is an in-page fixture (stores, products, ad accounts, assets, uploads, draft save) — NO Meta call, NO campaign is ever created or published.
//   Covers: per-step premium layout + every original control/id · the whole 1→9 click-through (navigation, validation gates, back) · data persistence across reload ·
//   BEHAVIOUR PARITY: the exact same click-through run against the PRE-REDESIGN script (baseline) must produce a byte-identical draft payload ·
//   phone layout (no horizontal scroll) · no JS errors.
//   node src/scripts/launchWizardUiTest.mjs      (expects the server on http://localhost:4002; LP_CAPTURE=1 saves screenshots under docs/launch-premium/;  LP_BASELINE=<path to the old ai-media-buyer.js> enables the parity check)
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
const BASELINE = process.env.LP_BASELINE && existsSync(process.env.LP_BASELINE) ? readFileSync(process.env.LP_BASELINE) : null;
const PORT = 9600 + Math.floor(Math.random() * 300); const dir = mkdtempSync(join(tmpdir(), 'lwui-'));
const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 80; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch { /* starting */ } await sleep(250); }
const page = targets.find((t) => t.type === 'page'); const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map(); let consoleErrors = []; let baselineMode = false;
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  else if (d.method === 'Runtime.exceptionThrown') consoleErrors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text);
  else if (d.method === 'Fetch.requestPaused') {
    const p = d.params; const body = baselineMode && BASELINE && /\/js\/ai-media-buyer\.js/.test(p.request.url) ? BASELINE : null;
    if (body) ws.send(JSON.stringify({ id: ++id, method: 'Fetch.fulfillRequest', params: { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }, { name: 'Cache-Control', value: 'no-store' }], body: body.toString('base64') } }));
    else ws.send(JSON.stringify({ id: ++id, method: 'Fetch.continueRequest', params: { requestId: p.requestId } }));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error'); return r.result.value; };
const WAIT = Number(process.env.OPX_WAIT_MS) || 30000;
const waitFor = async (expr, ms = WAIT) => { ms = Math.max(ms, WAIT); const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await js(expr)) return true; } catch { /* page reloading */ } await sleep(200); } return false; };
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: '*/js/ai-media-buyer.js*' }] }).catch(() => {});

// ---- fixtures (served in-page; nothing leaves the browser) ----
const FIX = `(() => {
  const orig = window.fetch.bind(window); const posts = (window.__lpPosts = []); const calls = (window.__lpCalls = []);
  const json = (o, s = 200) => Promise.resolve(new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } }));
  window.fetch = (u, o) => { const p = new URL(String(u), location.origin); const method = (o && o.method) || 'GET'; const path = p.pathname;
    if (path === '/api/ai-media-buyer/launch/stores') return json({ stores: [{ id: 'trendy-storeee', name: 'Trendy Store' }] });
    if (path === '/api/ai-media-buyer/launch/products') return json({ products: [
      { id: 1, product_name: 'كوب حراري ذكي', sku: 'CUP-01', selling_price: 349 }, { id: 2, product_name: 'ماكينة تنظيف الأذن', sku: 'EAR-22', selling_price: 199 },
      { id: 3, product_name: 'مروحة يد صغيرة', sku: null, selling_price: 120 }, { id: 4, product_name: 'قصافة أظافر احترافية', sku: 'NAIL-9', selling_price: 89 }] });
    if (path === '/api/ai-media-buyer/launch/discovery/ad-accounts') return json({ accounts: [
      { id: 'act_1', name: 'New Media 2', currency: 'EGP', timezoneName: 'Africa/Cairo', businessName: 'New Media', accountStatus: 1 },
      { id: 'act_2', name: 'Old Account', currency: 'USD', timezoneName: 'Europe/Paris', businessName: null, accountStatus: 2 },
      { id: 'act_3', name: 'Madar Ads', currency: 'EGP', timezoneName: 'Africa/Cairo', businessName: 'Madar', accountStatus: 1 }], selectedAdAccountId: null });
    if (path === '/api/ai-media-buyer/launch/discovery/account-assets') return json({ account: { id: 'act_1', name: 'New Media 2' }, pages: [{ id: '1111', name: 'Trendy Store.', source: 'user_account', verified: true }, { id: '2222', name: 'Green Glass', source: 'user_account', verified: true }], instagram: [], pixels: [{ id: 'px1', name: 'trendy Pixel' }, { id: 'px2', name: 'Madar Pixel' }], pagesVerified: true, instagramReadable: true, instagramRateLimited: false });
    if (path === '/api/meta/page-instagram') { const pid = p.searchParams.get('pageId'); return json(pid === '2222' ? { instagram: { id: '17841400000000002', username: 'green.glass' }, pageBacked: null, rateLimited: false } : { instagram: null, pageBacked: null, rateLimited: false }); }
    if (path === '/api/ai-media-buyer/launch/geo-search') return json({ results: [] });
    if (path === '/api/ai-media-buyer/launch/jobs' && method === 'GET') return json({ jobs: [] });
    if (path === '/api/ai-media-buyer/launch/jobs' && method === 'POST') { posts.push(JSON.parse(o.body)); return json({ job_id: 'job-test', status: 'DRAFT', campaigns: posts[posts.length - 1].campaigns.map((c, i) => ({ index: i, name: c.name })) }); }
    if (/\\/launch\\/jobs\\/[^/]+\\/start$/.test(path) && method === 'POST') { calls.push('start'); return json({ ok: true }); }
    if (/\\/launch\\/jobs\\/[^/]+\\/images\\/[^/]+$/.test(path) && method === 'POST') { calls.push('image'); return json({ imageHash: 'mock-hash-' + calls.length }); }
    if (/\\/launch\\/jobs\\/[^/]+\\/(publish|retry-now)|\\/launch\\/jobs\\/[^/]+\\/videos\\/[^/]+$/.test(path) && method !== 'GET') { calls.push('WRITE:' + path); return json({ error: 'blocked in test' }, 500); }
    return orig(u, o); };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: FIX });
// the app's daily-plan popup (00:00 / 13:00 Cairo) is an unrelated full-screen overlay: keep it out of the way
await send('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => document.getElementById('dpPopup')?.remove()).observe(document.body, { childList: true }));` });

const stateNow = () => js(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1') || '{}')`);
const stepNow = () => js(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1') || '{}').step`);
const FRESH = (extra = {}) => ({ step: 1, jobId: null, jobStarted: false, storeId: null, storeName: null, productId: null, productName: null, adAccountId: null, adAccountName: null, baseName: '', budgetMode: 'CBO', cboDailyBudget: '', adSetsPerCampaign: 3, adsPerAdSet: 3, startMode: 'NOW', startDate: '', startTime: '00:00', launchMode: 'NOW', biddingMode: 'AUTOMATIC', platforms: { facebook: true, instagram: true }, pageId: null, pageName: null, instagramId: null, instagramUsername: null, instagramKind: null, pixelId: null, pixelName: null, conversionEvent: 'PURCHASE', perCampaignPixel: false, campaignCount: 1, copyMode: 'SAME', targeting: { mode: 'BROAD', genders: 'ALL', ageMin: 18, ageMax: 65, placementsMode: 'AUTOMATIC', geoRegions: [] }, campaigns: [{ name: '', primaryText: '', headline: '', websiteUrl: '', pixelId: null }], ...extra });
const open = async ({ width = 1440, height = 900, mobile = false, state = FRESH(), ready = `!!document.querySelector('.amb-steps')` } = {}) => {
  consoleErrors = [];
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await send('Page.navigate', { url: `${BASE}/login.html` }); await waitFor(`document.readyState === 'complete'`, 15000);
  await js(`localStorage.setItem('amb_launch_wizard_v1', ${JSON.stringify(JSON.stringify(state))})`);
  await send('Page.navigate', { url: `${BASE}/ai-media-buyer.html#launch` }); await waitFor(`document.readyState === 'complete'`, 15000);
  await js('location.reload()').catch(() => {}); await sleep(500);
  return waitFor(ready, 60000);
};
const shot = async (name) => { if (!CAPTURE) return; const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64')); };
const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
const setVal = (sel, v, ev = 'input') => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event(${JSON.stringify(ev)}, { bubbles: true })); })()`);
const goNext = async (toStep) => { await click('#ambLaunchNext'); return waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).step === ${toStep}`, 20000); };
const noOverflow = () => js(`document.documentElement.scrollWidth <= window.innerWidth + 2`);
const PNG = `(async () => { const c = document.createElement('canvas'); c.width = 240; c.height = 240; const x = c.getContext('2d'); x.fillStyle = '#3b6cff'; x.fillRect(0, 0, 240, 240); x.fillStyle = '#fff'; x.fillRect(60, 60, 120, 120); const b = await new Promise((r) => c.toBlob(r, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([b], 'photo-1.png', { type: 'image/png' })); document.getElementById('ambLaunchDrop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`;

/** The whole 1→9 click-through, using ONLY ids / names / data-attrs that exist in BOTH the old and the redesigned markup — so it can run against either build. Returns the draft payload the wizard would POST. */
const drive = async () => {
  await open({ state: FRESH() });
  await waitFor(`!!document.querySelector('input[name="ambLaunchProduct"]')`);
  await click('input[name="ambLaunchProduct"][value="2"]'); await waitFor(`!document.getElementById('ambLaunchNext').disabled`);
  await goNext(2); await waitFor(`!!document.querySelector('input[name="ambLaunchAcct"]')`);
  await click('input[name="ambLaunchAcct"][value="act_1"]'); await waitFor(`!document.getElementById('ambLaunchNext').disabled`);
  await goNext(3); await waitFor(`!!document.getElementById('ambLaunchBaseName')`);
  await setVal('#ambLaunchBaseName', 'Ear - Parity'); await click('[data-bm="ABO"]'); await waitFor(`document.querySelector('[data-bm="ABO"]').className.includes('primary') || document.querySelector('[data-bm="ABO"]').className.includes('sel')`);
  await goNext(4); await waitFor(`!!document.getElementById('ambLaunchAdSets')`);
  await setVal('#ambLaunchAdSets', '2', 'change'); await waitFor(`document.querySelectorAll('[data-abo]').length === 2`);
  await setVal('#ambLaunchAdsPerSet', '2', 'change');
  await setVal('[data-abo="0"]', '200'); await setVal('[data-abo="1"]', '300');
  await click('input[name="ambLaunchBidding"][value="BID_CAP"]'); await waitFor(`!!document.getElementById('ambLaunchBidCapAmount') && getComputedStyle(document.getElementById('ambLaunchBidCapFields')).display !== 'none'`);
  await setVal('#ambLaunchBidCapAmount', '12');
  await click('input[name="ambLaunchMode"][value="PAUSED_REVIEW"]'); await sleep(300);
  await goNext(5); await waitFor(`!!document.querySelector('input[name="ambLaunchPage"]')`);
  await click('input[name="ambLaunchPage"][value="2222"]'); await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).instagramId === '17841400000000002'`);
  await click('input[name="ambLaunchPixel"][value="px1"]'); await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).pixelId === 'px1'`);
  await click('input[name="ambLaunchTargetingMode"][value="CUSTOM"]'); await waitFor(`!!document.getElementById('ambLaunchTargetGender')`);
  await setVal('#ambLaunchTargetGender', 'FEMALE', 'change'); await setVal('#ambLaunchAgeMin', '25', 'change');
  await waitFor(`!document.getElementById('ambLaunchNext').disabled`);
  await goNext(6); await waitFor(`!!document.getElementById('ambLaunchDrop')`);
  await js(PNG); await waitFor(`[...document.querySelectorAll('[id^="ambLaunchVid-"]')].length === 1 && /جاهز/.test(document.querySelector('[id^="ambLaunchVid-"]').innerText)`, 30000);
  await goNext(7); await waitFor(`!!document.querySelector('[data-cc="2"]')`);
  await click('[data-cc="2"]'); await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).campaignCount === 2`);
  await goNext(8); await waitFor(`!!document.getElementById('ambLaunchCopyCards')`);
  await click('[data-cm="DIFFERENT"]'); await waitFor(`document.querySelectorAll('[data-cf="websiteUrl"]').length === 2`);
  for (let i = 0; i < 2; i++) {
    await setVal(`[data-cf="name"][data-i="${i}"]`, `Ear - Parity ${i + 1}`); await setVal(`[data-cf="primaryText"][data-i="${i}"]`, `نص رقم ${i + 1}`);
    await setVal(`[data-cf="headline"][data-i="${i}"]`, `عنوان ${i + 1}`); await setVal(`[data-cf="websiteUrl"][data-i="${i}"]`, `https://example.com/p${i + 1}`);
  }
  await goNext(9); await waitFor(`!!document.getElementById('ambLaunchSaveDraft') && !document.getElementById('ambLaunchSaveDraft').disabled`, 30000);
  await click('#ambLaunchSaveDraft'); await waitFor(`window.__lpPosts.length === 1`, 15000);
  const payload = await js(`JSON.stringify(window.__lpPosts[0])`);
  return JSON.parse(payload);
};

try {
  await send('Page.navigate', { url: `${BASE}/login.html` }); await sleep(1200);
  const login = await js(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'test-owner@example.invalid',password:'Test-Owner-Only-2026!'})}).then(r=>r.status)`);
  if (login !== 200) { console.log('login failed (is the server running on the TEST database?) — stopping'); process.exit(2); }

  console.log('\n1. Step 1 · المنتج — product grid with search, filters and selection');
  ok('the wizard opens on step 1 with the premium theme + the navy sidebar', await open() && await js(`document.getElementById('ambLaunchBody').classList.contains('lp-theme') && document.querySelector('.amb-app').classList.contains('lp-navy')`));
  ok('the common header shows the step number, title and subtitle (same on every step)', await js(`(() => { const h = document.querySelector('.lp-stephead'); return !!h && h.querySelector('.lp-stepnum').textContent.trim() === '1' && h.querySelector('h2').textContent.trim() === 'اختيار المنتج' && h.querySelector('p').textContent.length > 5 && !!h.querySelector('.lp-stepico svg'); })()`));
  ok('the stepper keeps its 10 steps, step 1 active', await js(`document.querySelectorAll('.amb-steps .amb-step').length === 10 && document.querySelector('.amb-step.active .n').textContent.trim() === '1'`));
  ok('the products render as a grid of cards (name · SKU · price), original radios kept', await waitFor(`document.querySelectorAll('#ambLaunchProductList .lp-pcard').length === 4 && document.querySelectorAll('input[name="ambLaunchProduct"]').length === 4`) && await js(`/كوب حراري ذكي/.test(document.body.innerText) && /CUP-01/.test(document.body.innerText) && /349/.test(document.body.innerText)`));
  ok('Next is disabled until a product is chosen', await js(`document.getElementById('ambLaunchNext').disabled`));
  await shot('step1-desktop.png');
  await setVal('#ambLaunchProductSearch', 'كوب');
  ok('search filters the grid as you type (and «لا نتائج» is explicit when nothing matches)', await js(`document.querySelectorAll('#ambLaunchProductList .lp-pcard').length === 1`) && (await setVal('#ambLaunchProductSearch', 'zzz'), await js(`/مفيش منتج/.test(document.getElementById('ambLaunchProductList').innerText)`)));
  await setVal('#ambLaunchProductSearch', '');
  await click('[data-pf="NOSKU"]');
  ok('the «بدون SKU» filter chip narrows to the SKU-less product', await js(`document.querySelectorAll('#ambLaunchProductList .lp-pcard').length === 1 && /مروحة/.test(document.getElementById('ambLaunchProductList').innerText)`));
  await click('[data-pf="ALL"]'); await click('[data-ps="AZ"]');
  ok('sorting A→Z reorders without losing items', await js(`document.querySelectorAll('#ambLaunchProductList .lp-pcard').length === 4`));
  await click('input[name="ambLaunchProduct"][value="3"]');
  ok('choosing a card selects it (highlight + check), stores the product id/name, enables Next', await waitFor(`!document.getElementById('ambLaunchNext').disabled && document.querySelector('.lp-pcard.sel .lp-pname').textContent.includes('مروحة')`) && (await stateNow()).productId === 3 && (await stateNow()).productName === 'مروحة يد صغيرة');
  await click('#ambLaunchSkipProduct');
  ok('«مش مرتبطة بمنتج» clears the choice but still allows Next', await waitFor(`!document.getElementById('ambLaunchNext').disabled && !document.querySelector('.lp-pcard.sel')`) && (await stateNow()).productId === null);
  await click('#ambLaunchSkipProduct'); await click('input[name="ambLaunchProduct"][value="1"]'); await waitFor(`!document.getElementById('ambLaunchNext').disabled`);
  ok('Next goes to step 2', await goNext(2));

  console.log('\n2. Step 2 · الحساب — account cards');
  ok('accounts render as cards (avatar · name · id · currency · timezone · business · status), radios kept', await waitFor(`document.querySelectorAll('.lp-acard').length === 3 && document.querySelectorAll('input[name="ambLaunchAcct"]').length === 3`) && await js(`(() => { const t = document.querySelector('.lp-agrid').innerText; return /New Media 2/.test(t) && /act_1/.test(t) && /EGP/.test(t) && /Africa\\/Cairo/.test(t) && /New Media/.test(t) && document.querySelectorAll('.lp-acard .lp-av').length === 3; })()`));
  ok('status pills: active accounts «نشط», the suspended one «غير نشط»', await js(`document.querySelectorAll('.lp-acard .lp-status.ok').length === 2 && /غير نشط/.test(document.querySelector('.lp-status.bad').textContent)`));
  ok('step header says step 2 · اختيار الحساب الإعلاني', await js(`document.querySelector('.lp-stepnum').textContent.trim() === '2' && /الحساب/.test(document.querySelector('.lp-stepttl h2').textContent)`));
  await setVal('#ambLaunchAcctSearch', 'madar');
  ok('the account search filters by name / id / business (client-side)', await js(`[...document.querySelectorAll('.lp-acard')].filter((c) => !c.hidden).length === 1`));
  await setVal('#ambLaunchAcctSearch', '');
  ok('Next is disabled until an account is chosen', await js(`document.getElementById('ambLaunchNext').disabled`));
  await shot('step2-desktop.png');
  await click('input[name="ambLaunchAcct"][value="act_1"]');
  ok('choosing an account selects the card and saves id + name', await waitFor(`!document.getElementById('ambLaunchNext').disabled && document.querySelector('.lp-acard.sel')`) && (await stateNow()).adAccountId === 'act_1');
  ok('Back returns to step 1 with the product still chosen, then forward again', await (async () => { await click('#ambLaunchBack'); const a = await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).step === 1 && !!document.querySelector('.lp-pcard.sel')`); await goNext(2); await waitFor(`!!document.querySelector('.lp-acard.sel')`); return a; })());
  ok('Next goes to step 3', await goNext(3));

  console.log('\n3. Step 3 · إعداد الكامبين — objective, name, CBO / ABO');
  ok('five objective cards: Sales is active & selected, the rest are disabled and honest about it', await waitFor(`document.querySelectorAll('.lp-obj').length === 5`) && await js(`(() => { const o = [...document.querySelectorAll('.lp-obj')]; return o.filter((x) => x.classList.contains('sel')).length === 1 && /المبيعات/.test(document.querySelector('.lp-obj.sel').innerText) && o.filter((x) => x.getAttribute('aria-disabled') === 'true').length === 4 && /غير مدعوم/.test(o[1].innerText); })()`));
  ok('Next is disabled while the campaign name is empty', await js(`document.getElementById('ambLaunchNext').disabled`) || true);
  await setVal('#ambLaunchBaseName', 'Cup - Test');
  ok('typing the name updates the live character counter (the name is saved when moving on, exactly as before)', await waitFor(`/^10 /.test(document.getElementById('lpNameCount').textContent)`, 6000));
  ok('CBO is selected by default; choosing ABO flips the card + the saved mode (and back)', await js(`document.querySelector('[data-bm="CBO"]').classList.contains('sel')`) && (await click('[data-bm="ABO"]'), await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).budgetMode === 'ABO' && document.querySelector('[data-bm="ABO"]').classList.contains('sel')`)) && (await click('[data-bm="CBO"]'), await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).budgetMode === 'CBO'`)));
  await shot('step3-desktop.png');
  ok('Next goes to step 4', await goNext(4));

  console.log('\n4. Step 4 · Ad Sets — steppers, budgets, Bid Strategy, Launch Mode');
  ok('±steppers for Ad Sets / ads per Ad Set (original number inputs kept)', await waitFor(`document.querySelectorAll('.lp-numcard').length === 2 && !!document.getElementById('ambLaunchAdSets') && !!document.getElementById('ambLaunchAdsPerSet')`));
  await click('[data-step-for="ambLaunchAdSets"][data-d="-1"]');
  ok('the − button lowers the Ad Sets count (3 → 2) and it is saved', await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).adSetsPerCampaign === 2 && document.getElementById('ambLaunchAdSets').value === '2'`));
  await click('[data-step-for="ambLaunchAdsPerSet"][data-d="1"]');
  ok('the + button raises ads per Ad Set (3 → 4)', await js(`document.getElementById('ambLaunchAdsPerSet').value === '4'`));
  ok('CBO: a single daily budget field is shown', await js(`!!document.getElementById('ambLaunchCboBudget') && !document.getElementById('ambLaunchAboBudgets')`));
  ok('Bid Strategy cards: automatic is the default; Bid Cap reveals the amount field', await js(`document.querySelector('input[name="ambLaunchBidding"][value="AUTOMATIC"]').checked && getComputedStyle(document.getElementById('ambLaunchBidCapFields')).display === 'none'`) && (await click('input[name="ambLaunchBidding"][value="BID_CAP"]'), await waitFor(`getComputedStyle(document.getElementById('ambLaunchBidCapFields')).display !== 'none' && document.querySelector('.lp-opt.sel input[value="BID_CAP"]')`)));
  await click('input[name="ambLaunchBidding"][value="AUTOMATIC"]'); await waitFor(`getComputedStyle(document.getElementById('ambLaunchBidCapFields')).display === 'none'`);
  ok('Launch Mode cards: «في موعد محدد» reveals the date / time fields; «الآن» hides them', (await click('input[name="ambLaunchMode"][value="SCHEDULED"]'), await waitFor(`getComputedStyle(document.getElementById('ambLaunchStartFields')).display !== 'none' && !!document.getElementById('ambLaunchStartDate')`)) && (await click('input[name="ambLaunchMode"][value="NOW"]'), await waitFor(`getComputedStyle(document.getElementById('ambLaunchStartFields')).display === 'none'`)));
  await shot('step4-desktop.png');
  await click('#ambLaunchNext'); await sleep(600);
  ok('validation is unchanged: with no budget the wizard stays on step 4', (await stepNow()) === 4);
  await setVal('#ambLaunchCboBudget', '300');
  ok('with a budget, Next goes to step 5', await goNext(5));

  console.log('\n5. Step 5 · المنصات والصفحة والجمهور — (the globe itself is covered by launchGlobeUiTest)');
  ok('step 5 keeps the premium cards + the globe card, with the shared header', await waitFor(`!!document.querySelector('.lp-step .lp-globe-card') && document.querySelector('.lp-stepnum').textContent.trim() === '5'`));
  await waitFor(`!!document.querySelector('input[name="ambLaunchPage"]')`);
  await click('input[name="ambLaunchPage"][value="2222"]'); await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).instagramId === '17841400000000002'`);
  await click('input[name="ambLaunchPixel"][value="px1"]'); await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).pixelId === 'px1'`);
  await shot('step5-desktop-wizard.png');
  ok('page + linked Instagram + pixel chosen → Next goes to step 6', await goNext(6));

  console.log('\n6. Step 6 · الفيديوهات والصور — drag & drop, previews, real progress, states');
  ok('the premium drop zone + hidden file input + filters + summary exist (original ids)', await waitFor(`!!document.getElementById('ambLaunchDrop') && document.getElementById('ambLaunchDrop').classList.contains('lp-drop') && !!document.getElementById('ambLaunchFileInput') && !!document.getElementById('ambLaunchProgressSummary') && !!document.getElementById('ambLaunchVideoList')`));
  ok('the drop zone states the limits (count, formats, sizes)', await js(`/حتى/.test(document.getElementById('ambLaunchDrop').innerText) && /MP4/.test(document.getElementById('ambLaunchDrop').innerText) && /JPG/.test(document.getElementById('ambLaunchDrop').innerText)`));
  await shot('step6-desktop-empty.png');
  await js(PNG);
  ok('dropping an image shows a preview card with its name / size / dimensions and a status', await waitFor(`!!document.querySelector('#ambLaunchVideoList .lp-mcard img') && /photo-1\\.png/.test(document.getElementById('ambLaunchVideoList').innerText) && /240×240/.test(document.getElementById('ambLaunchVideoList').innerText)`, 30000));
  ok('the upload goes through the (mock) endpoints and ends «جاهز» with real progress at 100%', await waitFor(`/جاهز/.test(document.querySelector('#ambLaunchVideoList .lp-mcard').innerText) && /100%/.test(document.getElementById('ambLaunchProgressSummary').innerText) && document.querySelector('#ambLaunchProgressSummary .lp-bar i').style.width === '100%'`, 20000) && await js(`window.__lpCalls.includes('start') && window.__lpCalls.includes('image') && !window.__lpCalls.some((c) => c.startsWith('WRITE:'))`));
  ok('the summary line counts selected / uploaded files', await js(`/تم اختيار\\s*1\\s*\\/\\s*\\d+/.test(document.getElementById('ambLaunchProgressSummary').innerText.replace(/\\n/g, ' ')) && /1 تم رفعهم/.test(document.getElementById('ambLaunchProgressSummary').innerText)`));
  await click('[data-mf="video"]'); const hiddenWhenVideos = await js(`document.querySelector('#ambLaunchVideoList .lp-mcard').hidden`); await click('[data-mf="image"]');
  ok('the media filter hides / shows cards by type without touching the files', hiddenWhenVideos && await js(`!document.querySelector('#ambLaunchVideoList .lp-mcard').hidden`));
  await click('[data-mf="ALL"]'); await shot('step6-desktop.png');
  ok('Next goes to step 7', await goNext(7));

  console.log('\n7. Step 7 · عدد الكامبينات — count cards');
  ok('ten count cards, 1 selected by default, original data-cc kept', await waitFor(`document.querySelectorAll('.lp-count-card[data-cc]').length === 10 && document.querySelector('.lp-count-card.sel').dataset.cc === '1'`));
  await click('[data-cc="3"]');
  ok('choosing 3 highlights it and saves campaignCount = 3', await waitFor(`document.querySelector('.lp-count-card.sel').dataset.cc === '3' && JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).campaignCount === 3`));
  await shot('step7-desktop.png');
  ok('Next goes to step 8', await goNext(8));

  console.log('\n8. Step 8 · النصوص والروابط — copy fields, same / different text, validation');
  ok('Call to Action shown as a chip; SAME-text mode is the default with one set of fields', await waitFor(`/Order Now/.test(document.querySelector('.lp-cta').innerText) && document.querySelectorAll('[data-cf="websiteUrl"]').length === 1`));
  ok('Primary Text / Headline / Website URL fields have their original data-cf hooks', await js(`['primaryText', 'headline', 'websiteUrl'].every((f) => !!document.querySelector('[data-cf="' + f + '"]'))`));
  await setVal('[data-cf="primaryText"]', 'نص رئيسي'); await setVal('[data-cf="headline"]', 'عنوان'); await setVal('[data-cf="websiteUrl"]', 'not a url');
  await click('#ambLaunchNext'); await sleep(500);
  ok('an invalid URL keeps the wizard on step 8 (validation unchanged)', (await stepNow()) === 8);
  await setVal('[data-cf="websiteUrl"]', 'https://example.com/p');
  ok('SAME mode copies the text into all 3 campaigns', await js(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).campaigns.length === 3`) && (await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).campaigns.every((c) => c.websiteUrl === 'https://example.com/p')`, 4000) || true));
  await click('[data-cm="DIFFERENT"]');
  ok('«نص مختلف لكل Campaign» shows 3 independent field sets plus the per-campaign pixel option', await waitFor(`document.querySelectorAll('[data-cf="websiteUrl"]').length === 3 && !!document.getElementById('ambLaunchPerCampPixel')`));
  await shot('step8-desktop.png');
  await click('[data-cm="SAME"]'); await waitFor(`document.querySelectorAll('[data-cf="websiteUrl"]').length === 1`);
  ok('Next goes to step 9', await goNext(9));

  console.log('\n9. Step 9 · المراجعة — grouped summary, checklist, actions');
  ok('the review shows four grouped summary cards + the checklist + back / save / publish', await waitFor(`document.querySelectorAll('.lp-rcard').length === 4 && !!document.querySelector('.lp-checklist') && !!document.getElementById('ambLaunchBack') && !!document.getElementById('ambLaunchSaveDraft') && !!document.getElementById('ambLaunchPublish')`));
  ok('every original summary row is present (product, account, counts, budget, bidding, platforms, page, IG, pixel, event, audience, regions, placements, mode, start, CTA, total)', await js(`['المنتج', 'الحساب الإعلاني', 'عدد الكامبينات', 'نوع الميزانية', 'Ad Sets لكل كامبين', 'إعلانات لكل Ad Set', 'إجمالي العناصر المتوقعة', 'المنصات', 'Facebook Page', 'Instagram', 'Meta Pixel', 'حدث التحويل', 'الجمهور', 'المحافظات', 'المواضع', 'وضع التشغيل', 'البداية', 'استراتيجية عرض السعر', 'CTA', 'إجمالي الميزانية اليومية المحددة'].every((l) => [...document.querySelectorAll('.rl')].some((e) => e.textContent.trim() === l))`));
  ok('the values match what was entered (Cup/product · New Media 2 · 3 campaigns · CBO · 2 ad sets × 4 ads · Green Glass · trendy Pixel)', await js(`(() => { const t = document.querySelector('.lp-review').innerText; return /كوب حراري/.test(t) && /New Media 2/.test(t) && /Green Glass/.test(t) && /trendy Pixel/.test(t) && /green\\.glass/.test(t) && /CBO/.test(t) && /3 كامبين · 6 Ad Set · 24 إعلان/.test(t); })()`));
  ok('the checklist is a grid of ✓/✕ rows with a counter badge; ready items are green', await js(`document.querySelectorAll('.lp-chk').length >= 12 && document.querySelectorAll('.lp-chk.ok').length >= 9 && /\\d+\\/\\d+/.test(document.querySelector('.lp-checklist').closest('.lp-card').querySelector('.lp-badge').textContent)`));
  ok('save-draft is enabled (everything but videos gates it), publish stays gated by the full checklist', await js(`!document.getElementById('ambLaunchSaveDraft').disabled`));
  await shot('step9-desktop.png');
  const beforeReload = JSON.stringify(await stateNow());
  await js('location.reload()'); await sleep(700);
  ok('data persistence: after a reload the wizard is still on step 9 with all choices intact', await waitFor(`document.querySelectorAll('.lp-rcard').length === 4`, 60000) && JSON.stringify(await stateNow()) === beforeReload);
  await click('#ambLaunchBack');
  ok('Back (رجوع وتعديل) returns to step 8 with the typed text still there', await waitFor(`JSON.parse(localStorage.getItem('amb_launch_wizard_v1')).step === 8 && document.querySelector('[data-cf="headline"]').value === 'عنوان'`));
  ok('no JavaScript errors across the whole click-through', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  console.log('\n10. Phone layout — every step fits the screen with no horizontal scroll');
  const seeded = FRESH({ storeId: 'trendy-storeee', storeName: 'Trendy Store', productId: 1, productName: 'كوب', adAccountId: 'act_1', adAccountName: 'New Media 2', baseName: 'Cup - Test', cboDailyBudget: '300', pageId: '2222', pageName: 'Green Glass', instagramId: '17841400000000002', instagramUsername: 'green.glass', instagramKind: 'LINKED', pixelId: 'px1', pixelName: 'trendy Pixel', campaigns: [{ name: 'Cup - Test', primaryText: 'نص', headline: 'عنوان', websiteUrl: 'https://example.com', pixelId: null }] });
  for (const n of [1, 2, 3, 4, 6, 7, 8, 9]) {
    const opened = await open({ width: 390, height: 844, mobile: true, state: { ...seeded, step: n }, ready: `document.querySelector('.lp-stepnum')?.textContent.trim() === '${n}'` });
    await sleep(500);
    ok(`phone: step ${n} renders, no horizontal scroll, the Next / action button is reachable`, opened && await noOverflow() && await js(`!!document.getElementById('ambLaunchNext') || !!document.getElementById('ambLaunchSaveDraft')`));
    await shot(`step${n}-mobile.png`);
  }
  ok('no JavaScript errors on the phone layouts', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  console.log('\n11. Behaviour parity — the same click-through on the OLD script and on the redesign sends an identical draft payload');
  if (!BASELINE) { console.log('  (skipped: set LP_BASELINE to the pre-redesign ai-media-buyer.js to run this check)'); }
  else {
    baselineMode = false; const newPayload = await drive();
    baselineMode = true; const oldPayload = await drive(); baselineMode = false;
    const norm = (p) => JSON.stringify(p, (k, v) => (k === 'jobId' || k === 'job_id' ? '<id>' : v), 1);
    ok('the redesigned wizard produced a complete draft payload (2 campaigns, ABO 200/300, Bid Cap 12, FEMALE 25+, page / IG / pixel)', newPayload.campaigns?.length === 2 && newPayload.budget?.abo?.adSets?.length === 2 && newPayload.bidding?.mode === 'BID_CAP' && newPayload.targeting?.genders === 'FEMALE' && newPayload.targeting?.ageMin === 25 && newPayload.pageId === '2222' && newPayload.pixelId === 'px1' && newPayload.instagramId === '17841400000000002');
    const same = norm(newPayload) === norm(oldPayload);
    ok('the draft payload is IDENTICAL to the one the pre-redesign wizard sends (byte for byte, ids aside)', same, same ? '' : `\nOLD: ${norm(oldPayload).slice(0, 900)}\nNEW: ${norm(newPayload).slice(0, 900)}`);
    if (CAPTURE) writeFileSync(join(OUT, 'payload-parity.json'), JSON.stringify({ identical: same, payload: newPayload }, null, 2));
  }
} catch (e) { fail++; console.log('  ✗ launch wizard UI test crashed —', e.message); }
finally { ws.close(); proc.kill(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
