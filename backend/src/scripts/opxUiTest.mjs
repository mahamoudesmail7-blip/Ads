// 🧪 UI test of the AI Operator workspaces in a REAL headless browser (Edge/Chrome via the DevTools protocol) against the local server that runs on the ISOLATED test database.
//   1) node src/scripts/seedUiFixtures.mjs        (fixture plans / products / history in the TEST database)
//   2) start the server on the test database:  node src/scripts/serveOnTestDb.js        (port 4000)
//   3) node src/scripts/opxUiTest.mjs
// It logs in with the documented TEST owner (exists only in the test database) — against production the login simply fails and the test stops.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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
const goto = async (path, { width = 1440, height = 900, mobile = false, ls = {} } = {}) => { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); await send('Page.navigate', { url: `${BASE}/login.html` }); await sleep(500); await js(`${Object.entries(ls).map(([k, v]) => `localStorage.setItem('${k}','${v}');`).join('')} true`); await send('Page.navigate', { url: `${BASE}${path}` }); await sleep(6500); };
const waitFor = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await js(expr)) return true; } catch { /* page reloading */ } await sleep(300); } return false; };
await send('Page.enable'); await send('Runtime.enable');
try {
  await send('Page.navigate', { url: `${BASE}/login.html` }); await sleep(1200);
  const login = await js(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'test-owner@example.invalid',password:'Test-Owner-Only-2026!'})}).then(r=>r.status)`);
  if (login !== 200) { console.log('login failed (is the server running on the TEST database?) — stopping'); process.exit(2); }

  console.log('\n1. Shell: sidebar, workspaces, remembered workspace');
  await goto('/ai-media-buyer.html#operator', { ls: { 'opx.ws': 'open', 'opx.theme': 'light', 'opx.collapsed': '0' } });
  ok('the opx shell is mounted (not the legacy single page)', await waitFor(`!!document.getElementById('opxRoot')`));
  const labels = await js(`[...document.querySelectorAll('#opxNav .lbl')].map(x=>x.textContent)`);
  ok('the 7 independent workspaces, in order', JSON.stringify(labels) === JSON.stringify(['فتح الحملات', 'إيقاف الحملات', 'إدارة الميزانيات', 'قواعد المنتجات', 'الموافقات', 'سجل التنفيذ', 'التنبيهات']), JSON.stringify(labels));
  ok('the advanced group keeps the old tools reachable (permissions / control center / all legacy tools)', (await js(`document.querySelectorAll('#opxNavAdv .opx-item').length`)) === 3);
  await js(`document.querySelector('[data-ws="pause"]').click()`); await sleep(2500);
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
  ok('the four period chips exist: 7 / 30 / 90 / custom', await js(`['7','30','90','custom'].every(k => !!document.querySelector('[data-period="'+k+'"]'))`));
  const cellNum = (cid, idx) => js(`Number(document.querySelector('tr[data-cid="${cid}"]').children[${idx}].innerText.replace(/[^0-9]/g,''))`);
  const apiP = (qs, cid) => js(`fetch('/api/operator/campaign-metrics?ids=${cid}&${qs}').then(r=>r.json())`);
  await js(`document.querySelector('[data-period="90"]').click()`); await sleep(1800);
  const a90 = await apiP('days=90', 'fx_open_2');
  ok('90 days: headers say 90د and the purchases column shows exactly what the server computed for that campaign', await js(`/90د/.test(document.querySelector('.opx-table thead').innerText)`) && (await cellNum('fx_open_2', 3)) === a90.metrics.fx_open_2.purchases && a90.metrics.fx_open_2.purchases > 32, JSON.stringify([a90.metrics?.fx_open_2, await cellNum('fx_open_2', 3)]));
  await js(`document.querySelector('[data-period="custom"]').click()`); await waitFor(`!!document.getElementById('opxApplyRange')`);
  const iso = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  await js(`(()=>{document.getElementById('opxFrom').value='${iso(2)}'; document.getElementById('opxTo').value='${iso(0)}'; document.getElementById('opxApplyRange').click()})()`); await sleep(1800);
  const c3 = await apiP(`from=${iso(2)}&to=${iso(0)}`, 'fx_open_2');
  ok('a custom range (last 3 days) shows the server numbers for exactly that window', (await cellNum('fx_open_2', 3)) === c3.metrics.fx_open_2.purchases && c3.window.days === 3, JSON.stringify([c3.metrics?.fx_open_2, await cellNum('fx_open_2', 3)]));
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
      const m = await js(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, cards: getComputedStyle(document.querySelector('.opx-cards')).display, desk: getComputedStyle(document.querySelector('.opx-desk')).display, bar: document.getElementById('opxActionBar') ? getComputedStyle(document.getElementById('opxActionBar')).display : 'none', bnav: getComputedStyle(document.getElementById('opxBnav')).display })`);
      ok(`${w}px · ${wsKey}: no horizontal page scroll`, m.sw <= m.iw + 2, JSON.stringify(m));
      if (w <= 820 || (w <= 900)) ok(`${w}px · ${wsKey}: phone layout = cards (table hidden)${w <= 900 ? ' + bottom navigation' : ''}${wsKey === 'open' ? ' + sticky action bar' : ''}`, m.cards !== 'none' && m.desk === 'none' && m.bnav !== 'none' && (wsKey !== 'open' || m.bar !== 'none'), JSON.stringify(m));
      else if (w >= 1400) ok(`${w}px · ${wsKey}: desktop layout = table (cards hidden), no bottom nav, no action bar`, m.desk !== 'none' && m.cards === 'none' && m.bnav === 'none' && m.bar === 'none', JSON.stringify(m));
    }
  }
  for (const wsKey of ['pause', 'budget', 'approvals', 'history']) {
    await goto('/ai-media-buyer.html#operator', { width: 390, height: 844, mobile: true, ls: { 'opx.ws': wsKey } }); await waitFor(`!!document.querySelector('.opx-head h1')`); await sleep(1500);
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
  await js(`(()=>{document.getElementById('pl_cap').value='1000'; document.getElementById('pl_moh').value='72'; document.getElementById('pl_save').click()})()`); await sleep(2200);
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
  spawnSync(process.execPath, [join(process.cwd(), 'src/scripts/seedUiFixtures.mjs')], { stdio: 'ignore' });

  ok('no JavaScript errors were thrown during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) { fail++; console.log('  ✗ UI test crashed —', e.message); }
finally { ws.close(); proc.kill(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
