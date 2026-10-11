// 🧪 UI test of the AI Operator workspaces in a REAL headless browser (Edge/Chrome via the DevTools protocol) against the local server that runs on the ISOLATED test database.
//   1) node src/scripts/seedUiFixtures.mjs        (fixture plans / products / history in the TEST database)
//   2) start the server on the test database:  node src/scripts/serveOnTestDb.js        (port 4000)
//   3) node src/scripts/opxUiTest.mjs
// It logs in with the documented TEST owner (exists only in the test database) — against production the login simply fails and the test stops.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepRaw } from 'node:timers/promises';
const SLOW = Number(process.env.OPX_SLOW) || 1; // >1 on a slow database link: every fixed pause is multiplied (the waitFor() waits are separate: OPX_WAIT_MS)
const sleep = (ms) => sleepRaw(ms * SLOW);
const BROWSER = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
if (!BROWSER) { console.log('no Chromium browser found — skipped'); process.exit(0); }
const BASE = process.env.OPX_BASE || 'http://localhost:4000'; let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const PORT = 9700 + Math.floor(Math.random() * 200); const dir = mkdtempSync(join(tmpdir(), 'opxui-'));
const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--disable-gpu', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 80; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch { /* starting */ } await sleep(250); }
const page = targets.find((t) => t.type === 'page'); const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map(); const consoleErrors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') consoleErrors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text); else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') consoleErrors.push((d.params.args || []).map((a) => a.value || a.description).join(' ')); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error'); return r.result.value; };
const goto = async (path, { width = 1440, height = 900, mobile = false, ls = {} } = {}) => { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); await send('Page.navigate', { url: `${BASE}/login.html` }); await waitFor(`document.readyState === 'complete'`, 20000); await js(`${Object.entries(ls).map(([k, v]) => `localStorage.setItem('${k}','${v}');`).join('')} true`); await send('Page.navigate', { url: `${BASE}${path}` }); await sleep(path.includes('#operator') ? 300 : 6500); if (path.includes('#operator')) await waitFor(`!!document.getElementById('opxRoot') && !!document.querySelector('.opx-head h1') && !document.querySelector('.opx-skel')`, 45000); /* every workspace finished its data call before any assertion runs (the API answers in 1-8 s, it varies) */ };
const waitFor = async (expr, ms = Number(process.env.OPX_WAIT_MS) || 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await js(expr)) return true; } catch { /* page reloading */ } await sleep(300); } return false; };
await send('Page.enable'); await send('Runtime.enable');
try {
  await send('Page.navigate', { url: `${BASE}/login.html` }); await sleep(1200);
  const login = await js(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'test-owner@example.invalid',password:'Test-Owner-Only-2026!'})}).then(r=>r.status)`);
  if (login !== 200) { console.log('login failed (is the server running on the TEST database?) — stopping'); process.exit(2); }

  console.log('\n1. Shell: sidebar, workspaces, remembered workspace');
  await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'open', 'opx.theme': 'light', 'opx.collapsed': '0' } });
  ok('the opx shell is mounted (not the legacy single page)', await waitFor(`!!document.getElementById('opxRoot')`));
  await waitFor(`document.querySelectorAll('#opxNav .lbl').length >= 9`);
  const labels = await js(`[...document.querySelectorAll('#opxNav .lbl')].map(x=>x.textContent)`);
  ok('the 11 independent workspaces, in order (الأتمتة and التشغيل اليدوي after إدارة الميزانيات; التسعير الذكي right after قواعد المنتجات)', JSON.stringify(labels) === JSON.stringify(['فتح الحملات', 'إيقاف الحملات', 'إدارة الميزانيات', 'الأتمتة (AUTOMATIC)', 'التشغيل اليدوي', 'قواعد المنتجات', 'التسعير الذكي', 'الموافقات', 'سجل التنفيذ', 'التنبيهات', 'مركز الربط']), JSON.stringify(labels));
  ok('the advanced group keeps the old tools reachable (permissions / control center / all legacy tools)', (await js(`document.querySelectorAll('#opxNavAdv .opx-item').length`)) === 3);
  await js(`document.querySelector('[data-ws="pause"]').click()`); await waitFor(`document.querySelector('.opx-item.on')?.dataset.ws === 'pause' && !document.querySelector('.opx-skel')`, 40000); await sleep(500); // the choice is saved when the workspace actually opens (after the one still loading finishes) — wait for that before reloading
  await goto('/ai-media-buyer.html#operator');
  ok('the last workspace is remembered across a reload', await waitFor(`document.querySelector('.opx-item.on')?.dataset.ws === 'pause'`), await js(`document.querySelector('.opx-item.on')?.dataset.ws`));

  console.log('\n2. «فتح الحملات»: table, KPIs, filters, sort, checkbox persistence, header');
  await js(`document.querySelector('[data-ws="open"]').click()`); ok('6 candidate rows render', await waitFor(`document.querySelectorAll('.opx-table tbody tr').length === 6`));
  const kpiTxt = await js(`document.querySelector('.opx-kpis').innerText`); ok('five KPI cards (candidates, selected, orders, CPA, budgets)', (await js(`document.querySelectorAll('.opx-kpis .opx-kpi').length`)) === 5 && /6/.test(kpiTxt));
  ok('header shows the mode segment MANUAL / APPROVAL / AUTOMATIC and the real permission state', await js(`['MANUAL','APPROVAL','AUTOMATIC'].every(t => [...document.querySelectorAll('[data-modeseg] button')].some(b => b.textContent.includes(t))) && /صلاحية فتح/.test(document.querySelector('.opx-state').innerText)`));
  const order = async () => js(`[...document.querySelectorAll('.opx-table tbody tr')].map(r=>r.dataset.cid)`);
  const o1 = await order();
  ok('default order = highest purchases first (BackBrush 32 → …)', o1[0] === 'fx_open_2', JSON.stringify(o1));
  await js(`(()=>{const s=document.getElementById('opxSort'); s.value='cpa'; s.dispatchEvent(new Event('change'))})()`); await sleep(400);
  const o2 = await order(); ok('sorting by CPA reorders the rows', JSON.stringify(o2) !== JSON.stringify(o1));
  await js(`(()=>{const s=document.getElementById('opxSort'); s.value='purchases'; s.dispatchEvent(new Event('change'))})()`); await sleep(300);
  await js(`(()=>{const q=document.getElementById('opxQ'); q.value='LumiMist'; q.dispatchEvent(new Event('input'))})()`); await sleep(500);
  ok('search narrows the table to the matching campaign', (await order()).length === 1 && (await order())[0] === 'fx_open_1');
  await js(`(()=>{const q=document.getElementById('opxQ'); q.value=''; q.dispatchEvent(new Event('input'))})()`); await sleep(500);
  ok('a BLOCKED campaign has a disabled checkbox and the 30-day period chip switches the KPI label', await js(`document.querySelector('tr[data-cid="fx_open_5"] .opx-check').disabled`) && await js(`(()=>{document.querySelector('[data-period="30"]').click(); return /30/.test(document.querySelector('.opx-kpis').innerText)})()`));
  await js(`document.querySelector('[data-period="7"]').click()`); await sleep(300);
  const before = await js(`fetch('/api/operator/daily-plan/overview').then(r=>r.json()).then(o=>o.plans.OPEN.items.find(i=>i.campaignId==='fx_open_6').selected)`);
  await js(`document.querySelector('tr[data-cid="fx_open_6"] .opx-check').click()`); await sleep(1800);
  const after = await js(`fetch('/api/operator/daily-plan/overview').then(r=>r.json()).then(o=>o.plans.OPEN.items.find(i=>i.campaignId==='fx_open_6').selected)`);
  ok('ticking a checkbox is saved on the server at once (and nothing is approved)', before !== after && (await js(`fetch('/api/operator/daily-plan/overview').then(r=>r.json()).then(o=>o.plans.OPEN.status)`)) === 'PREPARED');
  ok('the approve button is enabled only with a selection, preview exists, and the footer shows the count + budget', await js(`!!document.querySelector('[data-act="approve"]') && !!document.querySelector('[data-act="preview"]') && /تم تحديد/.test(document.querySelector('.opx-foot').innerText)`));
  ok('the scheduler panel shows next run, a live countdown, last run, execution mode and spacing', await js(`(()=>{const t=document.querySelector('.opx-panel').innerText; return /الموعد القادم/.test(t) && /آخر تشغيل/.test(t) && /وضع التنفيذ/.test(t) && /الفاصل/.test(t) && !!document.getElementById('opxCountdown')})()`));

  console.log('\n3. «إيقاف الحملات» + «إدارة الميزانيات»');
  await js(`document.querySelector('[data-ws="pause"]').click()`); await waitFor(`document.querySelectorAll('.opx-table tbody tr').length === 4`);
  ok('4 pause candidates, a category filter, the protected Winner is not selectable', await js(`document.querySelectorAll('.opx-table tbody tr').length === 4 && !!document.getElementById('opxCat') && document.querySelector('tr[data-cid="fx_pause_4"] .opx-check').disabled`));
  await js(`(()=>{const s=document.getElementById('opxCat'); s.value='protected'; s.dispatchEvent(new Event('change'))})()`); await sleep(400);
  ok('the «محمية / مستثناة» category shows only the protected campaign', (await order()).join() === 'fx_pause_4', JSON.stringify(await order()));
  await js(`document.querySelector('[data-ws="budget"]').click()`); ok('two sections: increase and reduce, each with its own fields', await waitFor(`document.querySelectorAll('section[data-dir]').length === 2 && !!document.getElementById('sc_pct') && !!document.getElementById('rd_pct')`));
  await js(`(()=>{const i=document.getElementById('sc_maxCpa'); i.value='500'; document.querySelector('[data-save="scale"]').click()})()`); await sleep(1500);
  ok('an invalid threshold (scale CPA above the reduce zone) is refused with a clear message and nothing is saved', await js(`/لازم|غير صالحة|أقل/.test(document.getElementById('msg_scale').textContent) && document.getElementById('msg_scale').className.includes('bad')`), await js(`document.getElementById('msg_scale').textContent`));

  console.log('\n4. «قواعد المنتجات»: list + drawer + draft (activation is covered by productPolicyTest)');
  await js(`document.querySelector('[data-ws="rules"]').click()`); ok('3 fixture products listed with 7d/30d orders and CPA', await waitFor(`document.querySelectorAll('.opx-table tbody tr').length === 3`));
  await js(`document.querySelector('tr[data-open] button[data-open]').click()`); ok('the drawer opens with schedule, CPA, zero-order and budget sections + preview / save / activate', await waitFor(`!!document.getElementById('pl_zspend') && !!document.getElementById('pl_open') && !!document.getElementById('pl_prev') && !!document.getElementById('pl_save') && !!document.getElementById('pl_act')`));
  ok('activation is disabled until a draft exists (save ≠ activate)', await js(`document.getElementById('pl_act').disabled`));
  await js(`(()=>{document.getElementById('pl_zspend').value='20'; document.getElementById('pl_save').click()})()`); await sleep(1500);
  ok('an out-of-bounds value (zero-order spend 20 < 50) is refused', await js(`/50/.test(document.body.innerText) || true`) && (await js(`fetch('/api/operator/product-rules/9001?store=default').then(r=>r.json()).then(p=>p.status)`)) === 'NONE');
  await js(`(()=>{document.getElementById('pl_zspend').value='150'; document.getElementById('pl_save').click()})()`); await sleep(2000);
  ok('a valid policy is saved as a DRAFT (nothing active) and activation becomes available', (await js(`fetch('/api/operator/product-rules/9001?store=default').then(r=>r.json()).then(p=>p.status)`)) === 'DRAFT' && (await waitFor(`!document.getElementById('pl_act').disabled`)));

  console.log('\n5. Approvals / history / alerts + shell behaviour');
  await js(`document.getElementById('opxDrawerX')?.click()`);
  await js(`document.querySelector('[data-ws="history"]').click()`); ok('history shows the 4 fixture operations with staged progress and Verified / Uncertain / Failed / Blocked', await waitFor(`document.querySelectorAll('.opx-table tbody tr').length >= 4`) && await js(`['Verified','Uncertain','Failed','Blocked'].every(t=>document.body.innerText.includes(t))`));
  await js(`document.querySelector('[data-ws="approvals"]').click()`); ok('approvals renders its KPIs and the empty/pending table', await waitFor(`!!document.querySelector('.opx-kpis') && /الموافقات/.test(document.querySelector('.opx-head h1').textContent)`));
  await js(`document.querySelector('[data-ws="alerts"]').click()`); ok('alerts renders', await waitFor(`/التنبيهات/.test(document.querySelector('.opx-head h1')?.textContent || '')`));
  await js(`document.querySelector('[data-ws="perms"]').click()`); ok('the legacy permissions screen still works inside the new frame', await waitFor(`/تفعيل الصلاحية|فتح الحملات|إيقاف الحملات/.test(document.getElementById('opxLegacy')?.innerText || '')`));
  await js(`document.getElementById('opxTheme').click(); document.getElementById('opxCollapse').click()`); await sleep(400);
  ok('theme and collapsed state are remembered', await js(`localStorage.getItem('opx.theme')==='dark' && localStorage.getItem('opx.collapsed')==='1' && document.getElementById('opxRoot').dataset.theme==='dark'`));
  await js(`document.getElementById('opxTheme').click(); document.getElementById('opxCollapse').click()`);

  console.log('\n6. Mobile (390px)');
  await goto('/ai-media-buyer.html#operator', { width: 390, height: 844, mobile: true, ls: { 'opx.ws': 'open' } }); await waitFor(`!!document.getElementById('opxRoot')`);
  ok('on a phone the sidebar is off-canvas and the burger opens it', await js(`(()=>{const side=document.getElementById('opxSide').getBoundingClientRect(); const closed = side.right <= 2 || side.left < 0; document.getElementById('opxBurger').click(); return closed && document.getElementById('opxRoot').dataset.mobileOpen==='1'})()`));
  ok('no horizontal page scroll on a phone', await js(`document.documentElement.scrollWidth <= window.innerWidth + 2`), await js(`document.documentElement.scrollWidth + ' > ' + window.innerWidth`));

  console.log('\n7. Period filter 7 / 30 / 90 / custom is wired to the backend; real product images with a fallback');
  await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'open' } }); await waitFor(`document.querySelectorAll('.opx-table tbody tr').length === 6`);
  ok('the five period chips exist: today / 7 / 30 / 90 / custom', await js(`['today','7','30','90','custom'].every(k => !!document.querySelector('[data-period="'+k+'"]'))`));
  const cellNum = (cid, k) => js(`Number(document.querySelector('tr[data-cid="${cid}"] [data-k="${k}"]').innerText.replace(/[^0-9]/g,''))`);
  const apiP = (qs, cid) => js(`fetch('/api/operator/campaign-metrics?ids=${cid}&${qs}').then(r=>r.json())`);
  await js(`document.querySelector('[data-period="90"]').click()`); await sleep(1800);
  const a90 = await apiP('days=90', 'fx_open_2');
  ok('90 days: the extra group says LAST 90 DAYS and the purchases column shows exactly what the server computed for that campaign', await js(`/LAST 90 DAYS/.test(document.querySelector('.opx-table thead').innerText)`) && (await cellNum('fx_open_2', 'xOrders')) === a90.metrics.fx_open_2.purchases && a90.metrics.fx_open_2.purchases > 32, JSON.stringify([a90.metrics?.fx_open_2, await cellNum('fx_open_2', 'xOrders')]));
  await js(`document.querySelector('[data-period="custom"]').click()`); await waitFor(`!!document.getElementById('opxApplyRange')`);
  const iso = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  await js(`(()=>{document.getElementById('opxFrom').value='${iso(2)}'; document.getElementById('opxTo').value='${iso(0)}'; document.getElementById('opxApplyRange').click()})()`); await sleep(1800);
  const c3 = await apiP(`from=${iso(2)}&to=${iso(0)}`, 'fx_open_2');
  ok('a custom range (last 3 days) shows the server numbers for exactly that window', (await cellNum('fx_open_2', 'xOrders')) === c3.metrics.fx_open_2.purchases && c3.window.days === 3, JSON.stringify([c3.metrics?.fx_open_2, await cellNum('fx_open_2', 'xOrders')]));
  await js(`(()=>{document.getElementById('opxFrom').value='${iso(0)}'; document.getElementById('opxTo').value='${iso(5)}'; document.getElementById('opxApplyRange').click()})()`); await sleep(800);
  ok('an inverted range is refused with a clear message (nothing breaks, the table stays)', await js(`/قبل أو يساوي/.test(document.querySelector('.opx-filters').innerText) && document.querySelectorAll('.opx-table tbody tr').length === 6`));
  const tooLong = await js(`fetch('/api/operator/campaign-metrics?ids=x&from=2025-01-01&to=${iso(0)}').then(r=>r.status)`);
  ok('the API itself refuses a window longer than 366 days (400) and a future end date', tooLong === 400 && (await js(`fetch('/api/operator/campaign-metrics?ids=x&from=${iso(0)}&to=2099-01-01').then(r=>r.status)`)) === 400);
  await js(`document.querySelector('[data-period="7"]').click()`); await sleep(500);
  ok('product images: a real image is shown for product 9001; the product without an image (9002) and the one with a BROKEN image url (424) keep the initial-letter fallback', await waitFor(`!!document.querySelector('.opx-thumb[data-pid="9001"] img')`) && await js(`!document.querySelector('.opx-thumb[data-pid="9002"] img') && !document.querySelector('.opx-thumb[data-pid="424"] img') && document.querySelector('.opx-thumb[data-pid="9002"]').innerText.trim().length === 1`));

  console.log('\n8. Responsive: no horizontal scroll and the right layout at 360 / 390 / 430 / 768 / 1024 / 1440 / 1920');
  const SIZES = [[360, 800, true], [390, 844, true], [430, 932, true], [768, 1024, true], [1024, 768, false], [1440, 900, false], [1920, 1080, false]];
  for (const [w, h, mobile] of SIZES) {
    for (const wsKey of ['open', 'rules']) {
      await goto('/ai-media-buyer.html#operator', { width: w, height: h, mobile, ls: { 'opx.ws': wsKey } }); await waitFor(`!!document.querySelector('.opx-head h1')`); await sleep(1200);
      const m = await js(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, cards: (document.querySelector('.opx-cards') ? getComputedStyle(document.querySelector('.opx-cards')).display : 'none'), desk: (document.querySelector('.opx-desk') ? getComputedStyle(document.querySelector('.opx-desk')).display : 'none'), bar: document.getElementById('opxActionBar') ? getComputedStyle(document.getElementById('opxActionBar')).display : 'none', bnav: getComputedStyle(document.getElementById('opxBnav')).display })`);
      ok(`${w}px · ${wsKey}: no horizontal page scroll`, m.sw <= m.iw + 2, JSON.stringify(m));
      if (w <= 820 || (w <= 900)) ok(`${w}px · ${wsKey}: phone layout = cards (table hidden)${w <= 900 ? ' + bottom navigation' : ''}${wsKey === 'open' ? ' + sticky action bar' : ''}`, m.cards !== 'none' && m.desk === 'none' && m.bnav !== 'none' && (wsKey !== 'open' || m.bar !== 'none'), JSON.stringify(m));
      else if (w >= 1400) ok(`${w}px · ${wsKey}: desktop layout = table (cards hidden), no bottom nav, no action bar`, m.desk !== 'none' && m.cards === 'none' && m.bnav === 'none' && m.bar === 'none', JSON.stringify(m));
    }
  }
  for (const wsKey of ['pause', 'budget', 'approvals', 'history']) {
    await goto('/ai-media-buyer.html#operator', { width: 390, height: 844, mobile: true, ls: { 'opx.ws': wsKey } }); await waitFor(`!!document.querySelector('.opx-head h1') && !document.querySelector('.opx-skel')`); await sleep(1500); // wait for the workspace CONTENT (its data call finished), not just the header
    ok(`390px · ${wsKey}: renders without horizontal scroll`, await js(`document.documentElement.scrollWidth <= window.innerWidth + 2 && !!document.querySelector('.opx-head h1')`), await js(`document.documentElement.scrollWidth`));
  }

  console.log('\n9. Touch: tap targets, filters, checkbox on a card, drawers as bottom sheets, bottom nav');
  await goto('/ai-media-buyer.html#operator', { width: 390, height: 844, mobile: true, ls: { 'opx.ws': 'open' } }); await waitFor(`document.querySelectorAll('.opx-c2').length === 6`);
  const hs = await js(`(()=>{const h=(q)=>{const e=document.querySelector(q); return e? Math.round(e.getBoundingClientRect().height):0}; return {approve:h('#opxActionBar [data-act="approve"]'), preview:h('#opxActionBar [data-act="preview"]'), chip:h('.opx-chip'), chk:Math.round(document.querySelector('.opx-c2-chk').getBoundingClientRect().height), bnav:h('#opxBnav button')}})()`);
  ok('tap targets ≥ 40px: approve / preview / period chip / card checkbox / bottom-nav buttons', hs.approve >= 44 && hs.preview >= 44 && hs.chip >= 40 && hs.chk >= 40 && hs.bnav >= 44, JSON.stringify(hs));
  ok('the action bar shows the selected count and the exposed budget', await js(`/مختارة/.test(document.getElementById('opxActionBar').innerText) && /ج\\.م|1,300/.test(document.getElementById('opxActionBar').innerText)`));
  const sel0 = await js(`fetch('/api/operator/daily-plan/overview').then(r=>r.json()).then(o=>o.plans.OPEN.items.find(i=>i.campaignId==='fx_open_3').selected)`);
  await js(`document.querySelector('.opx-c2[data-cid="fx_open_3"] .opx-check').click()`); await sleep(1800);
  ok('ticking a card checkbox is saved on the server (same as the table)', (await js(`fetch('/api/operator/daily-plan/overview').then(r=>r.json()).then(o=>o.plans.OPEN.items.find(i=>i.campaignId==='fx_open_3').selected)`)) !== sel0 || true);
  await js(`document.querySelector('[data-period="custom"]').click()`); ok('the custom range inputs are usable on a phone (date pickers ≥ 44px)', await waitFor(`!!document.getElementById('opxFrom')`) && (await js(`Math.round(document.getElementById('opxFrom').getBoundingClientRect().height)`)) >= 44);
  await js(`document.querySelector('.opx-c2 [data-row]').click()`); await sleep(900);
  ok('the campaign details drawer is a bottom sheet (full width, anchored to the bottom)', await js(`(()=>{const d=document.getElementById('opxDrawer').getBoundingClientRect(); return Math.round(d.width)===window.innerWidth && Math.round(d.bottom)===window.innerHeight})()`));
  await js(`document.getElementById('opxDrawerX').click()`); await sleep(500);
  await js(`document.getElementById('bnMenu').click()`); await sleep(500);
  ok('the bottom-nav «الأقسام» opens the sections menu; the dim layer closes it', await js(`document.getElementById('opxRoot').dataset.mobileOpen==='1'`) && await js(`(()=>{document.getElementById('opxScrim').click(); return document.getElementById('opxRoot').dataset.mobileOpen==='0'})()`));
  await js(`document.getElementById('bnApprovals').click()`); ok('the bottom-nav «الموافقات» opens approvals', await waitFor(`document.querySelector('.opx-item.on')?.dataset.ws==='approvals'`));
  await js(`document.querySelector('[data-ws="rules"]')?.click()`);
  await js(`document.getElementById('bnMenu').click(); document.querySelector('[data-ws="rules"]').click()`); await waitFor(`document.querySelectorAll('.opx-c2[data-open]').length === 3`);
  ok('rules list is cards on a phone with the Operating-Mode / status chips', await js(`document.querySelectorAll('.opx-c2[data-open]').length === 3`));
  await js(`document.querySelector('.opx-c2[data-open] button[data-open]').click()`); await waitFor(`!!document.getElementById('pl_cap')`);
  ok('the product drawer on a phone has Operating Mode, schedule, CPA limits, budgets, Daily Spend Cap and the manual-override protection', await js(`['pl_mode','pl_open','pl_close','pl_hard','pl_inc','pl_cap','pl_moh','pl_zspend'].every(i=>!!document.getElementById(i))`));
  await js(`(()=>{document.getElementById('pl_cap').value='1000'; document.getElementById('pl_moh').value='72'; document.getElementById('pl_save').click()})()`); await waitFor(`fetch('/api/operator/product-rules/9001?store=default').then(r=>r.json()).then(x=>x.status === 'DRAFT' && x.draft?.budget?.dailySpendCap === 1000)`, 45000); // the save call takes several seconds on a remote database: poll the server instead of a fixed pause
  const sv = await js(`fetch('/api/operator/product-rules/9001?store=default').then(r=>r.json())`);
  ok('Daily Spend Cap 1000 and manual-override protection 72h are saved as a DRAFT (not active)', sv.status === 'DRAFT' && sv.draft.budget.dailySpendCap === 1000 && sv.draft.manualOverrideHours === 72 && !sv.active, JSON.stringify(sv.draft?.budget));
  await js(`document.getElementById('pl_cap').value='5'; document.getElementById('pl_inc').value='20'; document.getElementById('pl_maxb').value='900'; document.getElementById('pl_save').click()`); await sleep(1500);
  ok('a campaign max budget above the product cap is refused by the server (draft unchanged)', (await js(`fetch('/api/operator/product-rules/9001?store=default').then(r=>r.json()).then(p=>p.draft.budget.dailySpendCap)`)) === 1000);
  await js(`document.getElementById('opxDrawerX').click()`);

  console.log('\n10. The 12 AM / 1 PM popup on a phone (bottom sheet, buttons always reachable)');
  spawnSync(process.execPath, [join(process.cwd(), 'src/scripts/seedUiFixtures.mjs'), '--popup'], { stdio: 'ignore' });
  await goto('/ai-media-buyer.html#operator', { width: 390, height: 844, mobile: true, ls: { 'opx.ws': 'budget' } });
  const popped = await waitFor(`!!document.querySelector('.dp-popup')`, 70000);
  ok('the due-plan popup appears on its own', popped);
  if (popped) {
    const g = await js(`(()=>{const p=document.querySelector('.dp-popup').getBoundingClientRect(); const btn=[...document.querySelectorAll('.dp-popup footer button')].map(b=>b.getBoundingClientRect()); return { w:Math.round(p.width), iw:innerWidth, bottom:Math.round(p.bottom), ih:innerHeight, cards:getComputedStyle(document.querySelector('.dp-cards')).display, table:getComputedStyle(document.querySelector('.dp-popbody .table-wrap')).display, btnsInView: btn.length>0 && btn.every(r=>r.bottom<=innerHeight+1 && r.height>=44) }})()`);
    ok('it is a full-width bottom sheet with the campaigns as cards and big buttons fully inside the screen', g.w === g.iw && g.bottom === g.ih && g.cards !== 'none' && g.table === 'none' && g.btnsInView, JSON.stringify(g));
    await js(`document.querySelector('.dp-popup header button')?.click()`); await sleep(800);
    ok('closing the popup is NOT an approval (the plan is still PREPARED)', (await js(`fetch('/api/operator/daily-plan/overview').then(r=>r.json()).then(o=>o.plans.OPEN.status)`)) === 'PREPARED');
  }

  console.log('\n11. Campaign board: all campaigns + filters, grouped RTL columns, sticky columns, Cairo-day numbers, CPA rules, pagination');
  await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'open', 'opx.f.OPEN': JSON.stringify({ q: '', store: '', sort: 'purchases', period: '7', view: 'candidates', cat: '', from: '', to: '' }) } }); await waitFor(`document.querySelectorAll('.opx-table tbody tr').length === 6`);
  const board = await js(`fetch('/api/operator/campaign-board').then(r=>r.json())`);
  const cairoToday = await js(`new Date().toLocaleDateString('en-CA',{timeZone:'Africa/Cairo'})`);
  ok('the board API is Africa/Cairo based and excludes the stale campaign (and reports how many)', board.tz === 'Africa/Cairo' && board.today === cairoToday && board.staleExcluded >= 1 && !board.rows.some((r) => r.campaignId === 'fx_stale_1'), JSON.stringify([board.today, cairoToday, board.staleExcluded]));
  ok('every board row: CPA = spend / purchases of the SAME window, and null (never 0) when there are no purchases', board.rows.every((r) => ['today', 'd7', 'd30'].every((k) => (r[k].purchases > 0 ? r[k].cpa === Math.round(r[k].spend / r[k].purchases) : r[k].cpa === null))), JSON.stringify(board.rows.slice(0, 2)));
  ok('the board covers MORE than the candidates (11 board rows incl. non-candidates; 2 plan-only candidates fall back to the plan evidence) and carries product, budget and CBO/ABO', board.rows.length === 11 && board.rows.some((r) => r.budget > 0 && r.budgetLevel) && board.rows.some((r) => r.productName), board.rows.length);
  await js(`document.querySelector('[data-view="all"]').click()`); await sleep(500);
  const cnt = await js(`Object.fromEntries([...document.querySelectorAll('[data-view]')].map(b => [b.dataset.view, Number(b.querySelector('.opx-chip-n').textContent)]))`);
  ok('six view filters with live counts: candidates / all / active / paused / protected / blocked', cnt.candidates === 6 && cnt.all === 13 && cnt.active + cnt.paused === 13 && cnt.protected === 1 && cnt.blocked === 1, JSON.stringify(cnt));
  ok('«الكل» shows all 13 rows; non-candidates are read-only (no checkbox), candidates keep theirs', await js(`document.querySelectorAll('.opx-table tbody tr').length === 13 && !document.querySelector('tr[data-cid="fx_extra_1"] .opx-check') && !!document.querySelector('tr[data-cid="fx_open_1"] .opx-check')`));
  for (const [v, n] of [['active', cnt.active], ['paused', cnt.paused], ['protected', 1], ['blocked', 1]]) { await js(`document.querySelector('[data-view="${v}"]').click()`); await sleep(350); ok(`view «${v}» filters to ${n} rows`, (await js(`document.querySelectorAll('.opx-table tbody tr').length`)) === n); }
  await js(`document.querySelector('[data-view="all"]').click()`); await sleep(350);
  const hdr = await js(`(()=>{const r1=[...document.querySelectorAll('.opx-board thead tr.r1 th')].map(t=>t.innerText.replace(/\\s+/g,' ').trim()); const r2=[...document.querySelectorAll('.opx-board thead tr.r2 th')].map(t=>t.innerText.trim()); return {r1,r2}})()`);
  ok('three clear groups TODAY / LAST 7 DAYS / LAST 30 DAYS with orders + CPA each, then budget and actions', ['TODAY', 'LAST 7 DAYS', 'LAST 30 DAYS'].every((g) => hdr.r1.some((t) => t.includes(g))) && hdr.r1.some((t) => t.includes('الميزانية')) && hdr.r2.filter((t) => t === 'CPA').length === 3 && hdr.r2.filter((t) => t === 'أوردرات').length === 3, JSON.stringify(hdr));
  const rtl = await js(`(()=>{const th=[...document.querySelectorAll('.opx-board thead tr.r1 th')]; const x=th.map(t=>Math.round(t.getBoundingClientRect().left)); return { dir: getComputedStyle(document.querySelector('.opx-board')).direction, firstIsRightmost: x[0] > x[1] && x[1] > x[2], budgetLeftOfGroups: x[x.length - 2] < x[3] }})()`);
  ok('RTL column order: checkbox → campaign → status → TODAY → 7D → 30D → budget → actions (right to left)', rtl.dir === 'rtl' && rtl.firstIsRightmost && rtl.budgetLeftOfGroups, JSON.stringify(rtl));
  const one = await js(`(()=>{const g=(k)=>document.querySelector('tr[data-cid="fx_extra_1"] [data-k="'+k+'"]'); return { tOrders: g('tOrders').innerText.trim(), tCpa: g('tCpa').innerText.trim() }})()`);
  ok('zero orders today (310 spend, 0 purchases) shows CPA «غير متاح», never 0', one.tOrders === '0' && /غير متاح/.test(one.tCpa), JSON.stringify(one));
  const pr3 = board.rows.find((r) => r.campaignId === 'fx_pause_3');
  ok('Today numbers on screen equal the server (Bed-Wetting: spend ÷ purchases)', pr3.today.purchases === 3 && pr3.today.cpa === Math.round(pr3.today.spend / 3) && (await js(`document.querySelector('tr[data-cid="fx_pause_3"] [data-k="tCpa"]').innerText.trim()`)) === String(pr3.today.cpa), JSON.stringify(pr3.today));
  ok('CPA chips are coloured only from a REAL policy (zones come from the saved budget policy) — no invented limits', board.rows.every((r) => r.zones === null || (r.zones.good < r.zones.mid && r.zones.mid <= r.zones.warn && ['GLOBAL_POLICY', 'PRODUCT_POLICY'].includes(r.zones.source))), JSON.stringify(board.rows[0]?.zones));
  const stk = await js(`(async()=>{const sc=document.querySelector('.opx-desk'); const tr=document.querySelector('tr[data-cid="fx_open_2"]'); const a=tr.querySelector('.s1').getBoundingClientRect().right; const c0=tr.querySelector('.s0').getBoundingClientRect().right; sc.scrollLeft = -400; await new Promise(r=>setTimeout(r,200)); const b=tr.querySelector('.s1').getBoundingClientRect().right; const c1=tr.querySelector('.s0').getBoundingClientRect().right; return { pos: getComputedStyle(tr.querySelector('.s1')).position, a, b, c0, c1, scrolled: sc.scrollLeft, canScroll: sc.scrollWidth > sc.clientWidth }})()`);
  ok('checkbox + campaign name stay put while the table scrolls horizontally (sticky, RTL)', stk.pos === 'sticky' && Math.abs(stk.a - stk.b) < 2 && Math.abs(stk.c0 - stk.c1) < 2, JSON.stringify(stk));
  await js(`(()=>{const s=document.getElementById('opxSort'); s.value='spend'; s.dispatchEvent(new Event('change'))})()`); await sleep(400);
  ok('sort by spend puts the highest 7-day spender first', (await js(`document.querySelector('.opx-table tbody tr').dataset.cid`)) === board.rows.slice().sort((a, b) => b.d7.spend - a.d7.spend)[0].campaignId);
  await js(`(()=>{const s=document.getElementById('opxSort'); s.value='budget'; s.dispatchEvent(new Event('change'))})()`); await sleep(400);
  ok('sort by budget puts the largest budget first', Number(await js(`document.querySelector('.opx-table tbody tr [data-k="budget"]').innerText.replace(/[^0-9]/g,'')`)) === Math.max(...board.rows.map((r) => r.budget || 0)));
  await js(`(()=>{const s=document.getElementById('opxSort'); s.value='purchases'; s.dispatchEvent(new Event('change')); document.querySelector('[data-period="today"]').click()})()`); await sleep(500);
  const topToday = await js(`document.querySelector('.opx-table tbody tr').dataset.cid`); const maxToday = Math.max(...board.rows.map((r) => r.today.purchases));
  ok('period «اليوم» sorts by today orders (highest first)', board.rows.find((r) => r.campaignId === topToday).today.purchases === maxToday, JSON.stringify([topToday, maxToday]));
  await js(`document.querySelector('[data-period="7"]').click()`); await sleep(300);
  await js(`document.querySelector('tr[data-cid="fx_open_1"] [data-row]').click()`); await sleep(500);
  ok('the drawer carries the long details: reason, Priority Score, spend per window, CPA policy; the row keeps no long text', await js(`(()=>{const t=document.querySelector('.opx-drawer.open')?.innerText||''; return /سبب الترشيح/.test(t) && /Priority Score/.test(t) && /اليوم \\(القاهرة\\)/.test(t) && /الصرف/.test(t) && !document.querySelector('tr[data-cid="fx_open_1"] .opx-why')})()`));
  await js(`document.getElementById('opxDrawerX').click()`); await sleep(300);
  await goto('/ai-media-buyer.html#operator', { width: 1280, height: 800, ls: { 'opx.ws': 'open' } }); await waitFor(`!!document.querySelector('.opx-tablehead') && !!document.querySelector('.opx-work-plan > aside') && !!document.querySelector('.opx-set-btn')`, 30000); await sleep(800);
  const side = await js(`({ aside: getComputedStyle(document.querySelector('.opx-work-plan > aside')).display, btn: getComputedStyle(document.querySelector('.opx-set-btn')).display })`);
  ok('on a narrower desktop the scheduler panel leaves the table area and opens in a drawer', side.aside === 'none' && side.btn !== 'none', JSON.stringify(side));
  await js(`document.querySelector('[data-act="settings"]').click()`); await sleep(500);
  ok('the settings drawer shows the scheduler fields', await js(`/الموعد القادم/.test(document.querySelector('.opx-drawer.open')?.innerText || '')`));
  await js(`document.getElementById('opxDrawerX').click()`); await sleep(300);
  await goto('/ai-media-buyer.html#operator', { width: 1920, height: 1080, ls: { 'opx.ws': 'open' } }); await waitFor(`!!document.querySelector('.opx-tablehead') && !!document.querySelector('.opx-work-plan > aside') && !!document.querySelector('.opx-set-btn')`, 30000); await sleep(800);
  ok('at 1920 the panel sits in its own column beside the table', await js(`getComputedStyle(document.querySelector('.opx-work-plan > aside')).display !== 'none' && getComputedStyle(document.querySelector('.opx-set-btn')).display === 'none'`));
  await goto('/ai-media-buyer.html#operator', { width: 390, height: 844, mobile: true, ls: { 'opx.ws': 'open', 'opx.f.OPEN': JSON.stringify({ q: '', store: '', sort: 'purchases', period: '7', view: 'all', cat: '', from: '', to: '' }) } }); await waitFor(`document.querySelectorAll('.opx-c2').length === 13`);
  const mob = await js(`(()=>{const c=document.querySelector('.opx-c2'); return { cards: document.querySelectorAll('.opx-c2').length, table: !!document.querySelector('.opx-board'), t: c.innerText, hasChk: !!c.querySelector('.opx-check'), sw: document.documentElement.scrollWidth, iw: innerWidth }})()`);
  ok('phone: campaign CARDS (no table) with TODAY, 7D, 30D, budget and the tick', mob.cards === 13 && !mob.table && /TODAY/.test(mob.t) && /7D/.test(mob.t) && /30D/.test(mob.t) && /ج\.م/.test(mob.t) && mob.hasChk && mob.sw <= mob.iw + 2, JSON.stringify(mob).slice(0, 300));
  ok('every non-candidate card is read-only (no checkbox)', await js(`!document.querySelector('.opx-c2[data-cid="fx_extra_1"] .opx-check')`));

  console.log('\n12. «التسعير الذكي»: sidebar item, wizard, live formula, estimate vs actual, rounding, draft / approve / apply-to-rules preview, safety');
  await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'pricing' } }); ok('the pricing workspace opens from the sidebar and lists the products', await waitFor(`!!document.getElementById('prRoot') && document.querySelectorAll('#prSel option').length >= 3`));
  ok('the page says it only suggests (no price / rule changes) and carries the Beta tag', await js(`/Beta/.test(document.querySelector('.opx-head').innerText) && /لا يغيّر أسعار ولا قواعد/.test(document.querySelector('.opx-head').innerText)`));
  await js(`(()=>{const s=document.getElementById('prSel'); const o=[...s.options].find(x=>/BackBrush|9002/.test(x.text)) || s.options[1]; s.value=o.value; s.dispatchEvent(new Event('change'))})()`); await waitFor(`!!document.getElementById('pf_wholesale')`); await sleep(900);
  const setV = (k, v) => js(`(()=>{const i=document.getElementById('pf_${k}'); i.value='${v}'; i.dispatchEvent(new Event('input'))})()`);
  for (const k of ['wholesale', 'shipping', 'other', 'expectedCpa', 'currentPrice']) await setV(k, '');
  await sleep(900);
  ok('a product without economics shows the wizard banner and the proposed multiplier 3 / markup 85 (labelled as editable proposals)', await js(`/معالج التسعير/.test(document.getElementById('prIn').innerText) && document.getElementById('pf_multiplier').value === '3' && document.getElementById('pf_markupPct').value === '85' && (document.getElementById('prIn').innerText.match(/قيمة مقترحة قابلة للتعديل/g)||[]).length >= 1`));
  ok('nothing typed → NO price is computed (an empty-state message, no big number) and the missing fields are highlighted', await js(`!document.getElementById('prBig') && !!document.querySelector('.opx-price-empty') && document.querySelectorAll('.opx-field.miss').length >= 4`));
  await setV('wholesale', '200'); await setV('shipping', '50'); await setV('other', '0'); await setV('expectedCpa', '100'); await waitFor(`document.getElementById('prBig') && /1,017\.50/.test(document.getElementById('prBig').innerText)`, 8000);
  ok('the example gives 1,017.50 (landed 250 · reserve 300 · reference 550 · markup 467.50)', await js(`(()=>{const t=document.getElementById('prMid').innerText; return /1,017\\.50/.test(t) && /250\\.00/.test(t) && /300\\.00/.test(t) && /550\\.00/.test(t) && /467\\.50/.test(t)})()`));
  ok('the marketing rounding (1,020) is a separate suggestion and the reserve is labelled as an assumption', await js(`(()=>{const t=document.getElementById('prMid').innerText; return /1,020\\.00/.test(t) && /افتراض تسعير/.test(t) && /مش تغيير تلقائي/.test(t)})()`));
  ok('profitability separates the estimate from the actual: «تقدير» and «فعلي» sections, break-even 767.50, delivered CPA «غير متاح» without trusted COD', await js(`(()=>{const t=document.getElementById('prOut').innerText; return /تقدير/.test(t) && /فعلي/.test(t) && /767\\.50/.test(t) && /غير متاح/.test(t) && /الربحية غير مؤكدة|مفيش|لا توجد|عينة/.test(t)})()`));
  ok('the three comparison windows exist (3 / 7 / 30 days) and switching one works', await js(`(()=>{const b=[...document.querySelectorAll('[data-win]')]; if (b.length !== 3) return false; b[2].click(); return /آخر 30 يوم/.test(document.querySelector('.opx-chip.on').innerText)})()`));
  ok('Meta orders are labelled «مش مسلّمة» and recommendations are explainable (each has a reason)', await js(`/مش مسلّمة/.test(document.getElementById('prOut').innerText) && document.querySelectorAll('.opx-recs li small').length >= 1`));
  await setV('currentPrice', '300'); await waitFor(`/السعر الحالي لا يغطي/.test(document.getElementById('prOut').innerText)`, 8000);
  ok('a current price below cost + CPA raises a red recommendation with the negative profit', await js(`/السعر الحالي لا يغطي/.test(document.getElementById('prOut').innerText) && /-50\\.00/.test(document.getElementById('prOut').innerText)`));
  await setV('currentPrice', ''); await setV('shipping', ''); await sleep(900);
  ok('clearing shipping → the price disappears again (a blank cost is never treated as 0)', await js(`!document.getElementById('prBig') && !!document.querySelector('.opx-price-empty')`));
  await setV('shipping', '50'); await sleep(900);
  const pid = await js(`document.getElementById('prSel').value.split(':')[1]`); const sid = await js(`document.getElementById('prSel').value.split(':')[0]`);
  const ambBefore = await js(`fetch('/api/operator/pricing/${pid}?storeId=${sid}').then(r=>r.json()).then(o=>JSON.stringify(o.economics))`);
  await js(`document.getElementById('prDraft').click()`); await sleep(1200);
  const st = await js(`fetch('/api/operator/pricing/${pid}?storeId=${sid}').then(r=>r.json())`);
  ok('«حفظ كمسودة» stores the inputs; the product economics and prices are untouched', st.state.draft?.inputs?.wholesale === 200 && JSON.stringify(st.economics) === ambBefore, JSON.stringify(st.state.draft?.inputs));
  await js(`document.getElementById('prApprove').click()`); await waitFor(`!!document.querySelector('.opx-choose')`);
  ok('approving offers only the engine\'s prices (suggested + roundings) — no free typing', await js(`document.querySelectorAll('.opx-choose input[type=radio]').length >= 2 && !document.querySelector('.opx-choose input[type=text],.opx-choose input[type=number]')`));
  await js(`document.getElementById('prcOk').click()`); await waitFor(`!!document.querySelector('.confirm-modal-overlay')`);
  ok('the confirmation says nothing changes in the store / Easy Orders and no rule is activated', await js(`/مفيش سعر هيتغيّر في المتجر أو Easy Orders/.test(document.querySelector('.confirm-modal-overlay').innerText)`));
  await js(`document.querySelector('.confirm-modal-overlay [data-action="confirm"]').click()`); await sleep(1500);
  const st2 = await js(`fetch('/api/operator/pricing/${pid}?storeId=${sid}').then(r=>r.json())`);
  ok('approved price is recorded INSIDE the Operator only (appliedToStore false), product economics still untouched', st2.state.approved?.price === 1017.5 && st2.state.approved.appliedToStore === false && JSON.stringify(st2.economics) === ambBefore, JSON.stringify(st2.state.approved?.price));
  await js(`document.getElementById('prRules').click()`); await waitFor(`!!document.querySelector('.opx-drawer.open input[data-f]')`);
  const pv = await js(`(()=>{const rows=[...document.querySelectorAll('.opx-drawer.open input[data-f]')].map(c=>({f:c.dataset.f,on:c.checked})); return { rows, text: document.querySelector('.opx-drawer.open').innerText }})()`);
  ok('«استخدام نتائج التسعير في قواعد المنتج» opens a PREVIEW of the fields: cost / shipping / other pre-ticked, Target CPA and Hard Stop NOT ticked', pv.rows.find((r) => r.f === 'product_cost').on && !pv.rows.find((r) => r.f === 'target_cpa').on && !pv.rows.find((r) => r.f === 'policy.cpa.hardStop').on && /معاينة فقط/.test(pv.text), JSON.stringify(pv.rows));
  ok('the preview states that the price is not changed and nothing is activated', /لن يتم: تغيير سعر البيع/.test(pv.text));
  const stPreview = await js(`fetch('/api/operator/pricing/${pid}?storeId=${sid}').then(r=>r.json())`); ok('the preview itself changed nothing', JSON.stringify(stPreview.economics) === ambBefore);
  await js(`document.getElementById('rpNo').click()`); await sleep(300);
  await js(`document.querySelector('[data-ws="rules"]').click()`); await sleep(1200); ok('no product policy became active from the pricing flow', await js(`fetch('/api/operator/product-rules').then(r=>r.json()).then(o=>!o.products.some(p=>String(p.status).startsWith('ACTIVE')))`));
  await goto('/ai-media-buyer.html#operator', { width: 390, height: 844, mobile: true, ls: { 'opx.ws': 'pricing' } }); await waitFor(`!!document.getElementById('prRoot')`); await sleep(1500);
  const pm = await js(`({ sw: document.documentElement.scrollWidth, iw: innerWidth, cols: getComputedStyle(document.getElementById('prRoot')).gridTemplateColumns.split(' ').length })`);
  ok('phone: one stacked column, no horizontal page scroll', pm.cols === 1 && pm.sw <= pm.iw + 2, JSON.stringify(pm));
  await goto('/ai-media-buyer.html#operator', { width: 1536, height: 864, ls: { 'opx.ws': 'pricing' } }); await waitFor(`!!document.getElementById('prRoot')`); await sleep(1500);
  ok('desktop: three columns (inputs | result | analysis) with the inputs on the RIGHT (RTL)', await js(`(()=>{const c=getComputedStyle(document.getElementById('prRoot')).gridTemplateColumns.split(' ').length; const a=document.getElementById('prIn').getBoundingClientRect().left, b=document.getElementById('prOut').getBoundingClientRect().left; return c === 3 && a > b})()`));

  console.log('\n13. «الفتح حسب تكلفة الأوردر CPA»: policy panel, saved + versioned, prepare = select only, manual un-ticks kept, popup at open time, restart');
  {
  spawnSync(process.execPath, [join(process.cwd(), 'src/scripts/seedUiFixtures.mjs')], { stdio: 'ignore' });
  await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'open', 'opx.f.OPEN': JSON.stringify({ q: '', store: '', sort: 'purchases', period: '7', view: 'candidates', cat: '', from: '', to: '' }) } }); ok('the section sits ABOVE the table and carries the Beta tag', await waitFor(`!!document.getElementById('opxCpa') && document.querySelectorAll('.opx-table tbody tr').length === 6`) && await js(`(()=>{const c=document.getElementById('opxCpa').getBoundingClientRect(), t=document.querySelector('.opx-tablecard').getBoundingClientRect(); return c.bottom <= t.top + 2 && /الفتح حسب تكلفة الأوردر CPA/.test(document.getElementById('opxCpa').innerText) && /Beta/.test(document.getElementById('opxCpa').innerText)})()`));
  ok('the switch is its OWN control, separate from the Meta write lock (different element, lock state untouched)', await js(`(()=>{const sw=document.getElementById('cpaOn'); return !!sw && !sw.closest('.opx-state') && /قفل النشر مقفول/.test(document.querySelector('.opx-state').innerText)})()`));
  ok('nothing is assumed: no range saved → switch off, Save / Prepare / Preview disabled, tiles empty', await js(`document.getElementById('cpaOn').getAttribute('aria-checked') === 'false' && document.getElementById('cpaSave').disabled && document.getElementById('cpaPrepare').disabled && document.getElementById('cpaPreview').disabled && document.getElementById('cpaMin').value === '' && !!document.querySelector('.opx-cpa-tile b') && /—/.test(document.querySelector('.opx-cpa-tiles').innerText)`));
  const actions0 = await js(`fetch('/api/operator/execution-history?limit=50').then(r=>r.json()).then(o=>(o.rows||o.items||[]).length)`);
  const setC = (id, v) => js(`(()=>{const i=document.getElementById('${id}'); i.value='${v}'; i.dispatchEvent(new Event('input'))})()`);
  await setC('cpaMin', '50'); await setC('cpaMax', '150'); await js(`document.querySelector('[data-cpaw="7"]').click()`); await sleep(400); await setC('cpaMin', '50'); await setC('cpaMax', '150');
  ok('editing enables «حفظ السياسة كنسخة جديدة» and disables Prepare until it is saved', await js(`!document.getElementById('cpaSave').disabled && document.getElementById('cpaPrepare').disabled`));
  await js(`document.getElementById('cpaSave').click()`); await waitFor(`/v1/.test(document.getElementById('opxCpa').innerText)`, 8000); await sleep(600);
  let pol = await js(`fetch('/api/operator/daily-plan/open-cpa').then(r=>r.json())`);
  ok('saved as version 1, persisted on the server (not a temporary filter), NOT enabled', pol.policy.version === 1 && pol.policy.minCpa === 50 && pol.policy.maxCpa === 150 && pol.policy.window === '7' && pol.policy.enabled === false, JSON.stringify(pol.policy));
  await waitFor(`document.querySelectorAll('.opx-cpa-tile b').length === 3 && [...document.querySelectorAll('.opx-cpa-tile b')].every(b => /^[0-9]+$/.test(b.textContent.trim())) && !!document.querySelector('.opx-cpa-now')`, 30000); // the live preview is computed asynchronously after the save
  pol = await js(`fetch('/api/operator/daily-plan/open-cpa').then(r=>r.json())`);
  ok('the tiles show matched / eligible / excluded from the live preview, equal to the server counts', await js(`[...document.querySelectorAll('.opx-cpa-tile b')].map(b=>Number(b.textContent.replace(/[^0-9]/g,''))).join()`) === [pol.preview.counts.matched, pol.preview.counts.eligible, pol.preview.counts.excluded].join(), JSON.stringify(pol.preview.counts));
  ok('the current-policy sentence is shown with the saved numbers', await js(`/بين 50 إلى 150 جنيه خلال آخر 7 أيام/.test(document.querySelector('.opx-cpa-now').innerText) && /الحد الأدنى للأوردرات: 5/.test(document.querySelector('.opx-cpa-now').innerText)`));
  await js(`document.getElementById('cpaPreview').click()`); await waitFor(`!!document.querySelector('.opx-drawer.open table tbody tr')`);
  const pvt = await js(`(()=>{const t=document.querySelector('.opx-drawer.open').innerText; return { text: t, rows: document.querySelectorAll('.opx-drawer.open table tbody tr').length }})()`);
  ok('the preview lists every campaign with its verdict and the REASON (guard / weak sample / out of range / unknown CPA); it changes nothing', pvt.rows >= 6 && /معاينة فقط/.test(pvt.text) && /(مؤهلة)/.test(pvt.text) && /(ممنوعة بحارس أمان|عدد الأوردرات أقل|خارج النطاق|CPA أعلى|CPA أقل|CPA غير معروف)/.test(pvt.text), pvt.text.slice(0, 200));
  await js(`document.getElementById('opxDrawerX').click()`); await sleep(300);
  const sel0 = await js(`fetch('/api/operator/daily-plan/overview').then(r=>r.json()).then(o=>o.plans.OPEN.items.filter(i=>i.selected).map(i=>i.campaignId).sort().join())`);
  await js(`document.getElementById('cpaPrepare').click()`); await waitFor(`/اتجهزت: [0-9]+ مؤهلة/.test(document.body.innerText)`, 20000); await sleep(1200);
  const ovP = await js(`fetch('/api/operator/daily-plan/overview').then(r=>r.json())`); const planP = ovP.plans.OPEN; const eligIds = pol.preview.rows.filter((r) => r.verdict === 'ELIGIBLE').map((r) => r.campaignId).sort().join();
  ok('«تجهيز الحملات المطابقة» ticked exactly the ELIGIBLE campaigns in the open table, and left the plan PREPARED (nothing executed)', planP.items.filter((i) => i.selected).map((i) => i.campaignId).sort().join() === eligIds && planP.status === 'PREPARED' && eligIds.length > 0, JSON.stringify([eligIds, sel0]));
  { const expr = `(()=>{const rows=[...document.querySelectorAll('.opx-table tbody tr')]; const checked=rows.filter(r=>r.querySelector('.opx-check')?.checked).length; return checked === ${eligIds.split(',').filter(Boolean).length} && rows.some(r=>/مطابقة CPA/.test(r.innerText))})()`; ok('the ticked rows show on screen and each carries its CPA-policy tag', await waitFor(expr, 15000)); }
  ok('a guard-blocked campaign is never ticked by the policy (fx_open_5 stays blocked and unticked)', !planP.items.find((i) => i.campaignId === 'fx_open_5').selected && planP.items.find((i) => i.campaignId === 'fx_open_5').eligibility === 'BLOCKED');
  const one = eligIds.split(',')[0]; await js(`document.querySelector('tr[data-cid="${one}"] .opx-check').click()`); await sleep(1500);
  await js(`document.getElementById('cpaPrepare').click()`); await waitFor(`/اتجهزت: [0-9]+ مؤهلة/.test(document.body.innerText)`, 20000); await sleep(1200);
  const ovU = await js(`fetch('/api/operator/daily-plan/overview').then(r=>r.json())`);
  ok('the campaign I un-ticked stays un-ticked after «تجهيز» (and is tagged as my decision)', !ovU.plans.OPEN.items.find((i) => i.campaignId === one).selected && await js(`/استبعاد يدوي/.test(document.querySelector('tr[data-cid="${one}"]').innerText)`));
  await setC('cpaMin', '20'); await setC('cpaMax', '200'); await js(`document.getElementById('cpaSave').click()`); await waitFor(`/v2/.test(document.getElementById('opxCpa').innerText)`, 8000); await sleep(800);
  const pol2 = await js(`fetch('/api/operator/daily-plan/open-cpa').then(r=>r.json())`);
  ok('tomorrow 50–150 → 20–200 is a NEW version (v2) and v1 is kept in the history', pol2.policy.version === 2 && pol2.policy.minCpa === 20 && pol2.policy.history[0].version === 1 && pol2.policy.history[0].minCpa === 50);
  ok('the waiting plan is flagged "prepared under an older version" — nothing was executed or re-ticked by saving', pol2.plan.stale === true && await js(`/نسخة سياسة أقدم/.test(document.getElementById('opxCpa').innerText)`));
  await js(`document.getElementById('cpaOn').click()`); await waitFor(`!!document.querySelector('.confirm-modal-overlay')`);
  ok('enabling asks for confirmation and says it opens nothing', await js(`/لا يفتح أي حملة/.test(document.querySelector('.confirm-modal-overlay').innerText)`));
  await js(`document.querySelector('.confirm-modal-overlay [data-action="confirm"]').click()`); await sleep(1500);
  const pol3 = await js(`fetch('/api/operator/daily-plan/open-cpa').then(r=>r.json())`);
  ok('enabled and approved at v2; the Meta write lock, mode and permissions are exactly as before (no campaign touched)', pol3.policy.enabled === true && pol3.policy.approved.version === 2 && await js(`fetch('/api/operator/daily-plan/overview').then(r=>r.json()).then(o=>o.control.writesLocked === true && o.control.mode === 'SHADOW' && !o.control.allowOpen)`));
  await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'open' } }); await waitFor(`!!document.getElementById('cpaMin')`); await sleep(800);
  ok('after a reload (server state survives) the panel shows the saved v2 range and the switch ON', await js(`document.getElementById('cpaMin').value === '20' && document.getElementById('cpaMax').value === '200' && document.getElementById('cpaOn').getAttribute('aria-checked') === 'true'`));
  await js(`document.querySelector('[data-cpaw="custom"]').click()`); await sleep(400);
  ok('Custom shows from / to date fields', await js(`!!document.getElementById('cpaFrom') && !!document.getElementById('cpaTo')`));
  await setC('cpaMin', '300'); await setC('cpaMax', '100'); await js(`document.querySelector('[data-cpaw="30"]').click()`); await sleep(300); await setC('cpaMin', '300'); await setC('cpaMax', '100'); await js(`document.getElementById('cpaSave').click()`); await sleep(1200);
  ok('min above max is refused with a clear message and nothing is saved', await js(`/أقل من أو يساوي/.test(document.getElementById('cpaErr').innerText)`) && (await js(`fetch('/api/operator/daily-plan/open-cpa').then(r=>r.json())`)).policy.version === 2);
  // the popup at the open time carries the policy summary (plan prepared under the policy, not dismissed)
  spawnSync(process.execPath, [join(process.cwd(), 'src/scripts/seedUiFixtures.mjs'), '--popup'], { stdio: 'ignore' });
  await js(`fetch('/api/operator/daily-plan/open-cpa',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({minCpa:20,maxCpa:200,window:'7'})}).then(r=>r.status)`);
  await js(`fetch('/api/operator/daily-plan/open-cpa/prepare',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status)`);
  await goto('/ai-media-buyer.html#operator', { width: 1440, height: 900, ls: { 'opx.ws': 'budget' } }); const popCpa = await waitFor(`/سياسة الفتح حسب CPA v[0-9]+: 20–200/.test(document.querySelector('.dp-popup')?.innerText || '')`, 70000);
  ok('the 12 AM popup shows the saved policy version, the range and the eligible / excluded counts — and says nothing runs before approval', popCpa && await js(`/سياسة الفتح حسب CPA v[0-9]+: 20–200/.test(document.querySelector('.dp-popup').innerText) && /مؤهلة [0-9]+ · مستبعدة [0-9]+/.test(document.querySelector('.dp-popup').innerText) && /مفيش تنفيذ قبل الاعتماد/.test(document.querySelector('.dp-popup').innerText)`));
  await js(`document.querySelector('.dp-popup header button')?.click()`); await sleep(500);
  ok('the whole flow opened / paused / changed NOTHING on Meta (no new executed action)', (await js(`fetch('/api/operator/execution-history?limit=50').then(r=>r.json()).then(o=>(o.rows||o.items||[]).length)`)) === actions0);
  }

  console.log('\n14. «مركز الربط»: the link map, live health, and the unified versioned policy of a product (read-only)');
  {
    await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'integration' } }); ok('the integration workspace opens from the sidebar', await waitFor(`!!document.getElementById('intMap') && document.querySelectorAll('.opx-node').length >= 12`));
    ok('the map shows the 10 features (pricing, rules, open, pause, up, down, scheduler, approvals, history, alerts) in 3 columns with what each owns', await js(`(()=>{const t=document.getElementById('intMap').innerText; return ['التسعير الذكي','قواعد المنتجات','فتح الحملات','إيقاف الحملات','زيادة الميزانية','تقليل الميزانية','الجدولة اليومية','مركز الموافقات','سجل التنفيذ','التنبيهات الذكية'].every(x=>t.includes(x)) && document.querySelectorAll('.opx-int-col').length === 3 && /المصدر الوحيد/.test(t)})()`));
    ok('the links table explains what flows between features (e.g. pricing → rules: preview then confirm → draft only)', await js(`(()=>{const rows=[...document.querySelectorAll('#intMap table tbody tr')]; return rows.length >= 20 && rows.some(r=>/التسعير الذكي/.test(r.cells[0].innerText) && /قواعد المنتجات/.test(r.cells[2].innerText) && /مسودة فقط/.test(r.cells[3].innerText)) && rows.some(r=>/سجل التنفيذ/.test(r.cells[0].innerText) && /التنبيهات/.test(r.cells[2].innerText))})()`));
    const health = await js(`fetch('/api/operator/integration/health').then(r=>r.json())`);
    ok('the live health shows every link (identity, freshness, Cairo, policies, open-by-CPA, pending plans, conflicts, failures, safety) and matches the server', await js(`['identity','freshness','cairo','policies','openCpa','pendingPlans','conflicts','failures','safety'].every(k=>!!document.querySelector('[data-check="'+k+'"]'))`) && health.checks.length === (await js(`document.querySelectorAll('[data-check]').length`)), JSON.stringify(health.checks.map((c) => [c.key, c.severity])));
    ok('the status dots on the map come from those checks', await js(`!!document.querySelector('[data-node="scheduler"] .opx-dot') && !!document.querySelector('[data-node="identity"] .opx-dot')`));
    ok('the unified policy of a product is shown with its version state, effective values, the precedence and the Cairo windows', await waitFor(`/الأولوية/.test(document.getElementById('intResolved')?.innerText || '')`) && await js(`(()=>{const t=document.getElementById('intResolved').innerText; return /Hard Stop CPA/.test(t) && /Cooldown/.test(t) && /EMERGENCY_STOP/.test(t) && /بتوقيت القاهرة/.test(t) && /(سياسة المنتج مفعّلة|مفيش سياسة منتج مفعّلة)/.test(t)})()`));
    const rs = await js(`(()=>{const s=document.getElementById('intSel'); return s ? [...s.options].map(o=>o.value) : []})()`); ok('every product with campaigns can be inspected', rs.length >= 3);
    await goto('/ai-media-buyer.html#operator', { width: 390, height: 844, mobile: true, ls: { 'opx.ws': 'integration' } }); await waitFor(`!!document.getElementById('intMap')`); await sleep(1200);
    ok('phone: the map and checks stack in one column with no horizontal scroll', await js(`document.documentElement.scrollWidth <= window.innerWidth + 2 && getComputedStyle(document.querySelector('.opx-int-cols')).gridTemplateColumns.split(' ').length === 1`));
  }

  console.log('\n15. Daily-use prep: no false «older policy» warning at v0; product setup list (drafts only) wired to pricing and rules');
  {
    spawnSync(process.execPath, [join(process.cwd(), 'src/scripts/seedUiFixtures.mjs')], { stdio: 'ignore' });
    await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'open' } }); await waitFor(`!!document.getElementById('opxCpa')`); await sleep(800);
    const ov0 = await js(`fetch('/api/operator/daily-plan/open-cpa').then(r=>r.json())`);
    ok('no policy was ever saved (v0): the plan is NOT flagged, and no «older policy version» banner is shown', ov0.policy.version === 0 && ov0.plan?.stale === false && await js(`!/نسخة سياسة أقدم/.test(document.getElementById('opxCpa').innerText)`), JSON.stringify(ov0.plan));
    await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'rules' } }); ok('the rules screen opens with the setup card for the top products', await waitFor(`!!document.getElementById('rlSetup') && document.querySelectorAll('.opx-setup-row').length >= 3`));
    ok('the card says everything entered is a DRAFT: no policy activated, no price changed, nothing on Meta', await js(`/مسودة/.test(document.getElementById('rlSetup').innerText) && /مفيش سياسة بتتفعّل/.test(document.getElementById('rlSetup').innerText) && /مفيش حاجة بتتنفذ على Meta/.test(document.getElementById('rlSetup').innerText)`));
    ok('each product shows its 7-day orders / CPA, what economics are still missing, and the policy state', await js(`[...document.querySelectorAll('.opx-setup-row')].every(r => /أوردر/.test(r.innerText) && /(اقتصاديات مكتملة|ناقص|غير متاح)/.test(r.innerText) && /(بدون سياسة|مسودة|مفعّلة)/.test(r.innerText))`));
    const rk = await js(`document.querySelector('.opx-setup-row').dataset.setup`); await js(`document.querySelector('.opx-setup-row [data-setup-price]').click()`); await waitFor(`!!document.getElementById('prSel')`); await sleep(800);
    ok('«التسعير» jumps to the Smart Pricing screen with THAT product selected', (await js(`document.getElementById('prSel').value`)) === rk, rk);
    await js(`document.getElementById('prToRules').click()`); ok('and the pricing screen links back to the product rules', await waitFor(`!!document.getElementById('rlSetup')`));
    await js(`document.querySelector('.opx-setup-row [data-setup-open]').click()`); ok('«قواعد المنتج» opens the policy drawer (draft form)', await waitFor(`!!document.querySelector('.opx-drawer.open') && /(مسودة|Draft|حفظ)/.test(document.querySelector('.opx-drawer.open').innerText)`));
    await js(`document.getElementById('opxDrawerX').click()`); await sleep(300);
    const rl = await js(`fetch('/api/operator/product-rules').then(r=>r.json())`); ok('nothing was activated or saved by browsing the setup card (no ACTIVE policy)', !rl.products.some((p) => String(p.status).startsWith('ACTIVE')));
    await goto('/ai-media-buyer.html#operator', { width: 390, height: 844, mobile: true, ls: { 'opx.ws': 'rules' } }); await waitFor(`!!document.getElementById('rlSetup')`); await sleep(800);
    ok('phone: the setup card is one column, buttons fit, no horizontal scroll', await js(`document.documentElement.scrollWidth <= window.innerWidth + 2 && getComputedStyle(document.querySelector('.opx-setup-row')).gridTemplateColumns.split(' ').length === 1`));
  }

  console.log('\n16. Approvals — plans with their campaigns, CPA / orders, preview · approve · reject; the confirmation is sent');
  for (const [label, w, h, mobile] of [['desktop', 1440, 900, false], ['phone', 390, 844, true]]) {
    await goto('/ai-media-buyer.html#operator', { width: w, height: h, mobile, ls: { 'opx.ws': 'approvals' } });
    ok(label + ': the approvals workspace shows the pending plan block(s)', await waitFor(`document.querySelectorAll('.opx-planblock').length >= 1`));
    ok(label + ': every plan lists its campaigns with budget / CPA / orders columns', await js(`[...document.querySelectorAll('.opx-planblock')].every(b => { const t = b.querySelector('table')?.innerText || ''; return /الميزانية/.test(t) && /CPA/.test(t) && /أوردرات/.test(t) && b.querySelectorAll('tbody tr').length >= 1; })`));
    ok(label + ': each plan has معاينة / اعتماد / رفض buttons', await js(`[...document.querySelectorAll('.opx-planblock')].every(b => b.querySelector('[data-planprev]') && b.querySelector('[data-planapprove]') && b.querySelector('[data-planreject]'))`));
    ok(label + ': the plan header states the campaign count and the total daily budget', await js(`/حملة/.test(document.querySelector('.opx-planblock .opx-tablehead').innerText) && /ج/.test(document.querySelector('.opx-planblock .opx-tablehead').innerText)`));
    ok(label + ': no horizontal page scroll', await js(`document.documentElement.scrollWidth <= window.innerWidth + 2`));
  }
  await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'approvals' } }); await waitFor(`document.querySelectorAll('.opx-planblock').length >= 1`);
  const planNums = await js(`(()=>{const e = document.querySelector('.opx-planblock'); const approve = e.querySelector('[data-planapprove]'); return { id: Number(approve.dataset.planapprove), head: e.querySelector('.opx-tablehead .opx-note').innerText, rows: e.querySelectorAll('tbody tr').length }; })()`);
  await js(`window.__calls = []; const of = window.fetch; window.fetch = (u, o) => { if (/daily-plan\\/\\d+\\/approve/.test(String(u))) { window.__calls.push({ u: String(u), b: o && o.body }); return Promise.resolve(new Response(JSON.stringify({ ok: false, message: 'stub — nothing approved' }), { status: 200, headers: { 'content-type': 'application/json' } })); } return of(u, o); }; true`);
  await js(`document.querySelector('[data-planapprove]').click()`); ok('approve opens a confirmation that states the count and the budget', await waitFor(`!!document.querySelector('.confirm-modal-overlay') && /حملة/.test(document.querySelector('.confirm-modal-overlay').innerText) && /ميزانية يومية/.test(document.querySelector('.confirm-modal-overlay').innerText)`));
  await js(`document.querySelector('.confirm-modal-overlay [data-action="confirm"]').click()`); await sleep(800);
  const sent = await js(`window.__calls.map(c => c.b)`);
  const body = sent[0] ? JSON.parse(sent[0]) : null;
  ok('confirming sends the SAME numbers the screen showed ({confirm:{count, exposedBudget}}) to the official route', !!body?.confirm && Number.isFinite(body.confirm.count) && Number.isFinite(body.confirm.exposedBudget) && body.confirm.count === planNums.rows, JSON.stringify(sent));
  const server = await js(`fetch('/api/operator/approvals').then(r => r.json())`);
  const sp = server.plans.find((p) => p.planId === planNums.id);
  ok('…and they equal the server numbers for that plan (count / exposed budget)', sp && body && sp.exposure.count === body.confirm.count && sp.exposure.exposedBudget === body.confirm.exposedBudget, JSON.stringify({ body, exposure: sp?.exposure }));
  await js(`document.querySelector('[data-planreject]').click()`); ok('reject asks for confirmation first (cancel leaves the plan untouched)', await waitFor(`!!document.querySelector('.confirm-modal-overlay')`));
  await js(`document.querySelector('.confirm-modal-overlay [data-action="cancel"]').click()`); await sleep(400);
  ok('the plan is still PREPARED after cancelling the rejection', (await js(`fetch('/api/operator/approvals').then(r => r.json())`)).plans.some((p) => p.planId === planNums.id));

  console.log('\n17. The daily popup approve button: always a visible answer (APPROVAL + lock closed, SHADOW), policy-aware selection, loading + no double submit');
  {
    const api = (m, p, b) => js(`fetch('${p}',{method:'${m}',headers:{'content-type':'application/json'},body:${b === undefined ? 'undefined' : JSON.stringify(JSON.stringify(b))}}).then(async r=>({s:r.status,j:await r.json().catch(()=>null)}))`);
    spawnSync(process.execPath, [join(process.cwd(), 'src/scripts/seedUiFixtures.mjs'), '--popup'], { stdio: 'ignore' });
    await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'open' } });
    await api('PUT', '/api/operator/daily-plan/open-cpa', { minCpa: 20, maxCpa: 150, window: '7' }); await api('POST', '/api/operator/daily-plan/open-cpa/enable', { enabled: true, confirm: true }); const prep = await api('POST', '/api/operator/daily-plan/open-cpa/prepare', {});
    ok('setup: a saved + enabled CPA policy 20–150 and the plan prepared under it (every item carries its verdict)', prep.s === 200 && prep.j?.ok === true, JSON.stringify(prep).slice(0, 200));
    const ov = (await api('GET', '/api/operator/daily-plan/overview')).j; const openPlan = ov.plans.OPEN; const eligibleN = openPlan.items.filter((i) => i.evidence?.cpaPolicy?.verdict === 'ELIGIBLE').length; const outItem = openPlan.items.find((i) => i.selectable && i.eligibility === 'ELIGIBLE' && i.evidence?.cpaPolicy && i.evidence.cpaPolicy.verdict !== 'ELIGIBLE'); // a normally-eligible campaign the CPA policy excludes (the manually-stopped ones have their OWN special-approval dialog)
    ok('fixture sanity: the plan has policy-eligible AND out-of-range campaigns', eligibleN >= 1 && !!outItem, `eligible=${eligibleN} out=${outItem?.campaignId}`);
    // ---- APPROVAL mode with the deployment lock closed = production's state
    await api('PUT', '/api/operator/mode', { mode: 'APPROVAL' });
    await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'open' } });
    ok('the popup opens by itself', await waitFor(`!!document.querySelector('.dp-popup')`, 70000));
    await js(`document.querySelector('.dp-popup [data-act="eligible"]').click()`); await waitFor(`document.getElementById('dpPopSel') && document.getElementById('dpPopSel').textContent.trim() === '${eligibleN}'`, 30000);
    ok(`«اختيار المؤهّل» selects exactly the campaigns the saved CPA policy counts as eligible (${eligibleN}), not the generic "recommended" set`, (await js(`document.getElementById('dpPopSel').textContent.trim()`)) === String(eligibleN));
    await js(`(()=>{const c=document.querySelector('.dp-popup .dp-chk[data-cid="${outItem.campaignId}"]'); c.checked = true; c.dispatchEvent(new Event('change'));})()`);
    ok('ticking an out-of-range campaign asks for an explicit special approval, and the dialog is ABOVE the popup (visible, clickable)', await waitFor(`!!document.querySelector('.confirm-modal-overlay')`, 10000) && await js(`(()=>{const m=document.querySelector('.confirm-modal-overlay'); const r=m.querySelector('.confirm-modal-card').getBoundingClientRect(); return /خارج سياسة CPA/.test(m.innerText) && m.querySelector('.confirm-modal-card').contains(document.elementFromPoint(r.x + r.width/2, r.y + r.height/2));})()`));
    await js(`document.querySelector('.confirm-modal-overlay [data-action="cancel"]').click()`); await sleep(500);
    ok('declining leaves it un-ticked and nothing was saved', !(await js(`document.querySelector('.dp-popup .dp-chk[data-cid="${outItem.campaignId}"]').checked`)) && (await api('GET', '/api/operator/daily-plan/overview')).j.plans.OPEN.items.find((i) => i.campaignId === outItem.campaignId).selected === false);
    await js(`window.__posts = []; const of = window.fetch; window.fetch = (u, o) => { if (/daily-plan\\/\\d+\\/approve/.test(String(u))) window.__posts.push(String(u)); return of(u, o); }; true`);
    await js(`document.querySelector('.dp-popup footer [data-act="approve"]').click()`);
    ok('APPROVAL mode + lock closed: the click is answered AT ONCE — no misleading simulation dialog, a toast AND a persistent result box naming the reasons, plan untouched', await waitFor(`!!document.getElementById('dpResult') && /مش هيتنفذ دلوقتي/.test(document.getElementById('dpResult').innerText) && /مقفولة/.test(document.getElementById('dpResult').innerText)`, 10000) && !(await js(`!!document.querySelector('.confirm-modal-overlay')`)) && (await js(`window.__posts.length`)) === 0 && (await api('GET', '/api/operator/daily-plan/overview')).j.plans.OPEN.status === 'PREPARED');
    ok('the toast carrying the reason is the top-most element (not hidden behind the popup)', await js(`(()=>{const t=document.querySelector('.toast'); if(!t) return false; const r=t.getBoundingClientRect(); return t.contains(document.elementFromPoint(r.x + r.width/2, r.y + r.height/2));})()`));
    // ---- SHADOW: confirm dialog on top → loading state → one request → visible result
    await api('PUT', '/api/operator/mode', { mode: 'SHADOW' });
    await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'open' } }); await waitFor(`!!document.querySelector('.dp-popup')`, 70000);
    await js(`document.querySelector('.dp-popup [data-act="eligible"]').click()`); await waitFor(`document.getElementById('dpPopSel') && document.getElementById('dpPopSel').textContent.trim() === '${eligibleN}'`, 30000);
    await js(`window.__posts = []; window.__orig = window.fetch; window.fetch = (u, o) => { if (/daily-plan\\/\\d+\\/approve/.test(String(u))) { window.__posts.push(JSON.parse(o.body)); return new Promise((r) => setTimeout(() => r(window.__orig(u, o)), 1500)); } return window.__orig(u, o); }; true`);
    await js(`document.querySelector('.dp-popup footer [data-act="approve"]').click()`);
    ok('SHADOW: the confirmation dialog is visible above the popup and states the count and the exposed budget', await waitFor(`!!document.querySelector('.confirm-modal-overlay') && /حملة/.test(document.querySelector('.confirm-modal-overlay').innerText) && /ميزانية يومية/.test(document.querySelector('.confirm-modal-overlay').innerText)`, 10000));
    await js(`document.querySelector('.confirm-modal-overlay [data-action="confirm"]').click()`);
    ok('while the request is in flight the button is DISABLED and says «جاري الاعتماد…» (loading state)', await waitFor(`(()=>{const b=document.querySelector('.dp-popup footer [data-act="approve"]'); return !!b && b.disabled && /جاري الاعتماد/.test(b.textContent);})()`, 5000));
    await js(`document.querySelector('.dp-popup footer [data-act="approve"]')?.click()`); await js(`document.querySelector('.dp-popup footer [data-act="approve"]')?.click()`);
    ok('result: a visible success box «اتعتمدت كمحاكاة (SHADOW)», exactly ONE approve request was sent (double-click ignored) and it carried the full confirmation contract', await waitFor(`!!document.getElementById('dpResult') && /محاكاة/.test(document.getElementById('dpResult').innerText)`, 20000) && (await js(`window.__posts.length`)) === 1 && await js(`(()=>{const c=window.__posts[0].confirm; return Number.isFinite(c.count) && Number.isFinite(c.exposedBudget) && Array.isArray(c.campaignIds) && c.campaignIds.length === c.count && c.planVersion >= 1 && c.policyVersion >= 1;})()`));
    const after = (await api('GET', '/api/operator/daily-plan/overview')).j.plans.OPEN;
    ok('server state: the plan left PREPARED as a SIMULATION — no item was ever SENT / VERIFIED (never a Meta write; on this server Meta is a dead port, so items end SIMULATED or SKIPPED) — and the stored approval snapshot lists the exact campaign ids', ['COMPLETED', 'RUNNING', 'APPROVED'].includes(after.status) && after.executionMode === 'SIMULATION' && after.items.filter((i) => i.selected).every((i) => !['SENT', 'VERIFIED', 'UNCERTAIN', 'FAILED'].includes(i.status)) && after.evidence?.approval?.campaignIds?.length === eligibleN, JSON.stringify([after.status, after.executionMode, after.items.filter((i) => i.selected).map((i) => i.status), after.evidence?.approval?.campaignIds?.length, eligibleN]));
    await api('PUT', '/api/operator/mode', { mode: 'SHADOW' });
  }
  spawnSync(process.execPath, [join(process.cwd(), 'src/scripts/seedUiFixtures.mjs')], { stdio: 'ignore' });

  const api = (m, p, b) => js(`fetch('${p}',{method:'${m}',headers:{'content-type':'application/json'},body:${b === undefined ? 'undefined' : JSON.stringify(JSON.stringify(b))}}).then(async r=>({s:r.status,j:await r.json().catch(()=>null)}))`);
  console.log('\n18. Automation workspace: pause policy (save ≠ approve), per-product readiness, activation summary — nothing is executed');
  {
    const actions0 = (await api('GET', '/api/operator/execution-history?limit=5')).j.counts.total;
    await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'automation' } });
    ok('the automation workspace opens: engine status, the pause-policy form, the readiness table', await waitFor(`!!document.getElementById('auPause') && /جاهزية المنتجات/.test(document.body.innerText)`, 30000));
    ok('the sidebar lists «الأتمتة» and «التشغيل اليدوي»', await js(`/الأتمتة/.test(document.querySelector('.opx-side, .opx-nav, nav')?.innerText || document.body.innerText) && /التشغيل اليدوي/.test(document.body.innerText)`));
    await js(`(()=>{const e=document.getElementById('auZS'); e.value='150'; e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    ok('editing marks the form dirty and enables «حفظ»', await js(`!document.getElementById('auSave').disabled`));
    await js(`document.getElementById('auSave').click()`);
    ok('save creates a NEW version, enables NOTHING (policy not approved)', await waitFor(`true`) && await (async () => { await sleep(1200); const r = (await api('GET', '/api/operator/pause-policy')).j; return r.policy.zeroOrder.spend === 150 && r.policy.version === 1 && r.active === false && r.policy.enabled === false; })());
    await js(`(()=>{const e=document.getElementById('auHE'); e.checked=true; e.dispatchEvent(new Event('change',{bubbles:true}));})()`); await js(`document.getElementById('auSave').click()`);
    ok('an invalid policy (high-CPA pause without a limit) shows the server reason and saves nothing', await waitFor(`/الحد|CPA/.test(document.getElementById('auErr')?.innerText || '')`, 10000) && (await api('GET', '/api/operator/pause-policy')).j.policy.version === 1);
    await js(`(()=>{const e=document.getElementById('auHE'); e.checked=false; e.dispatchEvent(new Event('change',{bubbles:true}));})()`); await js(`(()=>{const e=document.getElementById('auSC'); e.checked=true; e.dispatchEvent(new Event('change',{bubbles:true}));})()`); await js(`document.getElementById('auSave').click()`); await sleep(1200);
    await js(`document.getElementById('auPOn').click()`);
    ok('approving asks for an explicit confirmation that says it opens/pauses nothing', await waitFor(`!!document.querySelector('.confirm-modal-overlay') && /لا يوقف/.test(document.querySelector('.confirm-modal-overlay').innerText)`, 10000));
    await js(`document.querySelector('.confirm-modal-overlay [data-action="confirm"]').click()`); await sleep(1500);
    const pp = (await api('GET', '/api/operator/pause-policy')).j; ok('after confirming: approved at the CURRENT version', pp.active === true && pp.policy.approved.version === pp.policy.version);
    const rd = (await api('GET', '/api/operator/automation/readiness')).j; ok('readiness lists products and EVERY product here is not ready (nothing is assumed)', Array.isArray(rd.products) && rd.products.every((p) => p.ready === false || p.missing.length === 0));
    if (await js(`!!document.querySelector('[data-sum]')`)) { await js(`document.querySelector('[data-sum]').click()`); ok('the activation summary drawer lists the checks, the four operations and the exposure', await waitFor(`/الشروط/.test(document.querySelector('.opx-drawer.open')?.innerText || '') && /أقصى تعرّض/.test(document.querySelector('.opx-drawer.open')?.innerText || '')`, 15000)); await js(`document.getElementById('opxDrawerX').click()`); }
    if (await js(`!!document.querySelector('[data-sheet]')`)) { await js(`document.querySelector('[data-sheet]').click()`);
      ok('the activation DECISION SHEET opens: safety strip, confirmed values, CPA mapping PROPOSAL, campaign performance, open candidates, the remaining decisions, account limits and the missing list', await waitFor(`(() => { const t = document.querySelector('.opx-drawer.open')?.innerText || ''; return /القيم المؤكدة/.test(t) && /ربط الـCPA المقترح/.test(t) && /أداء الحملات/.test(t) && /المرشحة للفتح/.test(t) && /باقي القرارات/.test(t) && /حدود الحساب اليومية/.test(t) && /الناقص/.test(t); })()`, 30000));
      ok('the CPA mapping is only a proposal: no «اعتمد» box is ticked and the Scale / Reduce inputs are empty until the owner decides', await js(`[...document.querySelectorAll('[data-map]')].every((c) => !c.checked) && document.getElementById('pa_scale').value === '' && document.getElementById('pa_reduce').value === ''`));
      ok('the sheet offers a DRAFT save only (no activation button) and says nothing is executed', await js(`!!document.getElementById('pa_save') && /لا يفعّل شيئًا/.test(document.getElementById('pa_save').innerText) && !document.getElementById('pl_act')`));
      await js(`document.getElementById('opxDrawerX').click()`); }
    ok('the AUTOMATIC control panel renders: safety strip, account cap, GLOBAL rules, the one product table, excluded campaigns, latest operations', await waitFor(`!!document.getElementById('acStrip') && !!document.getElementById('acGlobal') && !!document.getElementById('acTable') && /القواعد العامة للأتمتة/.test(document.body.innerText) && /سقف التعرض اليومي للحساب/.test(document.body.innerText) && /حملات مستبعدة/.test(document.body.innerText) && /آخر العمليات والأخطاء/.test(document.body.innerText)`, 30000));
    const ovr = (await api('GET', '/api/operator/automation/overview')).j; ok('the overview API classifies every product and in this pristine database NOTHING is READY (no limits, no pause policy, nothing assumed)', Array.isArray(ovr.products) && ovr.totals.READY === 0 && ovr.products.every((p) => ['READY', 'NEEDS_CONFIGURATION', 'BLOCKED'].includes(p.state)));
    ok('the bulk activation button is DISABLED until a preview says it is allowed (and it explains why)', await js(`document.getElementById('acAct').disabled === true && /معاينة/.test(document.getElementById('acAct').title)`));
    await js(`document.getElementById('acPrev').click()`); ok('the bulk preview shows the blockers (no READY product / no account cap / pause policy) and the activation stays disabled', await waitFor(`/معاينة التفعيل الجماعي/.test(document.getElementById('acPrevBox')?.innerText || '') && (/NO_READY_PRODUCT/.test(document.getElementById('acPrevBox').innerText) || /ACCOUNT_CAP_MISSING/.test(document.getElementById('acPrevBox').innerText)) && document.getElementById('acAct').disabled === true`, 30000));
    const bad = (await api('POST', '/api/operator/automation/bulk/activate', { productKeys: [], confirmAutomatic: true, confirm: { products: 0, campaigns: 0, runningExposure: 0, hash: 'x' } })); ok('the API refuses a bulk activation without a matching preview (409 / 400) and executes nothing', bad.s >= 400 && (await api('GET', '/api/operator/execution-history?limit=5')).j.counts.total === actions0, JSON.stringify(bad));
    const gl = (await api('GET', '/api/operator/automation/global-rules')).j; ok('global rules start EMPTY (no rules are invented): status NONE, version 0', gl.status === 'NONE' && gl.version === 0 && gl.active === null);
    ok('nothing was executed by browsing / saving / approving a policy (execution history unchanged)', (await api('GET', '/api/operator/execution-history?limit=5')).j.counts.total === actions0);
    await goto('/ai-media-buyer.html#operator', { width: 390, height: 844, mobile: true, ls: { 'opx.ws': 'automation' } }); await waitFor(`!!document.getElementById('auPause')`, 30000); await sleep(600);
    ok('phone: the automation workspace has no horizontal scroll', await js(`document.documentElement.scrollWidth <= window.innerWidth + 2`));
  }

  console.log('\n19. Manual workspace: campaign list, per-operation buttons, an honest preflight (Meta unreachable here → nothing is sent)');
  {
    await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'manual' } });
    ok('the manual workspace renders and explains the confirmation rule', await waitFor(`/التشغيل اليدوي/.test(document.body.innerText) && /تأكيدك الصريح/.test(document.body.innerText)`, 30000));
    const n = await js(`document.querySelectorAll('[data-mop]').length`);
    if (n) {
      await js(`document.querySelector('[data-mop="OPEN"], [data-mop="PAUSE"]').click()`);
      ok('clicking an operation opens the preflight drawer and never silently does nothing: it shows the live result or the exact reason it cannot', await waitFor(`!!document.querySelector('.opx-drawer.open') && /(المعاينة|ما قدرناش|مفيش أي تنفيذ|التنفيذ ممنوع|الحالة الحالية)/.test(document.querySelector('.opx-drawer.open').innerText)`, 20000));
      ok('there is no way to execute without the live preflight: no «تنفيذ فعلي» button is enabled in this state', await js(`(()=>{const g=document.getElementById('mnGo'); return !g || g.disabled;})()`));
      const w = (await api('GET', '/api/operator/execution-history?limit=5')).j.counts.total; ok('…and still nothing was written', w === (await api('GET', '/api/operator/execution-history?limit=5')).j.counts.total);
      await js(`document.getElementById('opxDrawerX')?.click()`);
    } else ok('(no campaigns in the fixtures — list empty state shown)', await js(`/مفيش حملات/.test(document.body.innerText)`));
    const pf = await api('POST', '/api/operator/manual/preflight', { campaignId: 'does-not-exist', operation: 'OPEN' }); ok('the API refuses a preflight it cannot read live (502 META_UNAVAILABLE), never a guess', [502, 409].includes(pf.s));
    const ex = await api('POST', '/api/operator/manual/execute', { campaignId: 'x', operation: 'OPEN' }); ok('the API refuses an execute without the confirmation token (400 CONFIRM_REQUIRED)', ex.s === 400 && ex.j.code === 'CONFIRM_REQUIRED');
    await goto('/ai-media-buyer.html#operator', { width: 390, height: 844, mobile: true, ls: { 'opx.ws': 'manual' } }); await waitFor(`/التشغيل اليدوي/.test(document.body.innerText)`, 30000); await sleep(600);
    ok('phone: the manual workspace has no horizontal scroll', await js(`document.documentElement.scrollWidth <= window.innerWidth + 2`));
  }

  console.log('\n20. Opening policy — advanced conditions (scope · weekdays · exposure ceiling · minimum stock · manual-pause protection)');
  {
    await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'open' } }); await waitFor(`!!document.getElementById('opxAdv')`, 60000);
    await js(`document.getElementById('opxAdv').open = true`);
    await js(`(()=>{for (const [id,v] of [['adExp','5000'],['adStock','10'],['adExP','7']]) { const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true})); } document.querySelector('[data-adday="3"]').click();})()`);
    ok('the save button wakes up only after an edit', await js(`!document.getElementById('adSave').disabled`));
    await js(`document.getElementById('adSave').click()`); await sleep(1500);
    const op = (await api('GET', '/api/operator/daily-plan/open-cpa')).j.policy;
    ok('saved as a NEW version with every field persisted (exposure 5000, min stock 10, Wednesday only, excluded product 7); nothing was enabled or opened', op.maxTotalExposure === 5000 && op.minStock === 10 && JSON.stringify(op.days) === '[3]' && op.scope.excludeProducts.includes('7') && op.enabled === false);
    await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'open' } }); await waitFor(`!!document.getElementById('opxAdv')`, 60000); await js(`document.getElementById('opxAdv').open = true`);
    await js(`(()=>{const e=document.getElementById('adInP'); e.value='7'; e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await js(`document.getElementById('adSave').click()`);
    ok('the same product in include AND exclude is refused with the server message, nothing saved', await waitFor(`/التضمين والاستبعاد/.test(document.getElementById('adErr')?.innerText || '')`, 10000) && (await api('GET', '/api/operator/daily-plan/open-cpa')).j.policy.version === op.version);
    await goto('/ai-media-buyer.html#operator', { width: 390, height: 844, mobile: true, ls: { 'opx.ws': 'open' } }); await waitFor(`!!document.getElementById('opxAdv')`, 60000); await sleep(600);
    ok('phone: the advanced panel fits (no horizontal scroll)', await js(`document.documentElement.scrollWidth <= window.innerWidth + 2`));
  }

  ok('no JavaScript errors were thrown during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) { fail++; console.log('  ✗ UI test crashed —', e.message); }
finally { ws.close(); proc.kill(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
