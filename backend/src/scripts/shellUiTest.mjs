// 🧭 THE APP SHELL (app.html) in a real headless browser against the local server on the ISOLATED test database.
//   1. one grouped menu: 6 sections, the AI Media Buyer's 14 sections nested under it, no duplicate links, no dead link, brand = «AI Media Buyer»
//   2. every page opens INSIDE the shell (embedded: no own sidebar / mobile chrome / floating toggle), no JS errors, no horizontal overflow — desktop + phone, light + dark
//   3. routing: deep links, back/forward, sub-sections without reloading, internal links keep the shell, the menu follows the page
//   4. «feature slides»: the current section's siblings as a swipeable strip, active chip in view
//   5. search, collapse (remembered), theme toggle (reaches the page), phone drawer, login redirect, logout leaves the shell
//   node src/scripts/shellUiTest.mjs     (expects the server on http://localhost:4002; SHELL_CAPTURE=1 saves screenshots under docs/shell/)
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
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 600) : ''}`); } };
const CAPTURE = process.env.SHELL_CAPTURE === '1'; const here = dirname(fileURLToPath(import.meta.url)); const OUT = join(here, '../../../docs/shell'); if (CAPTURE) mkdirSync(OUT, { recursive: true });
const PORT = 9700 + Math.floor(Math.random() * 200); const dir = mkdtempSync(join(tmpdir(), 'shui-'));
const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 80; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch { /* starting */ } await sleep(250); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map(); let errors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text || '').split('\n')[0]); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error'); return r.result.value; };
const WAIT = Number(process.env.OPX_WAIT_MS) || 30000;
const waitFor = async (expr, ms = WAIT) => { ms = Math.max(ms, WAIT); const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await js(expr)) return true; } catch { /* navigating */ } await sleep(200); } return false; };
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => document.getElementById('dpPopup')?.remove()).observe(document.body, { childList: true }));` });
const shot = async (name) => { if (!CAPTURE) return; const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64')); };
const view = (width, height = 900) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
const openShell = async (hash, { width = 1440, theme = null, collapsed = false } = {}) => {
  errors = []; await view(width);
  await send('Page.navigate', { url: 'about:blank' }); await sleep(100);
  // any same-origin document that does NOT redirect: login.html bounces a signed-in visitor to the shell root and could race the next navigation
  await send('Page.navigate', { url: `${BASE}/css/embed.css` }); await waitFor(`document.readyState === 'complete'`, 15000);
  await js(`localStorage.removeItem('shGroupsClosed'); localStorage.setItem('shellCollapsed', ${collapsed ? "'1'" : "'0'"}); ${theme ? `localStorage.setItem('theme','${theme}')` : `localStorage.removeItem('theme')`}`);
  await send('Page.navigate', { url: `${BASE}/app.html${hash}` });
  return waitFor(`!!document.querySelector('.sh-group') && document.getElementById('shStage').classList.contains('ready')`, 45000);
};
const frameInfo = () => js(`(() => { const f = document.getElementById('shFrame'); const d = f.contentDocument; if (!d || !d.documentElement) return null; const vw = d.documentElement.clientWidth;
  return { file: f.contentWindow.location.pathname.split('/').pop(), hash: f.contentWindow.location.hash, embedded: d.documentElement.classList.contains('is-embedded'), overflow: (() => { const se = d.scrollingElement; se.scrollTo(100000, 0); const r = se.scrollLeft; se.scrollTo(-100000, 0); const l = se.scrollLeft; se.scrollTo(0, 0); return Math.max(Math.abs(r), Math.abs(l)); })(),
    leaks: ['.sidebar', '#ambNav', '#cfNav', '.mobile-header', '.mobile-bottom-nav', '.theme-toggle-fixed'].filter((s) => { const e = d.querySelector(s); return e && getComputedStyle(e).display !== 'none'; }), text: (d.body.innerText || '').length }; })()`);

try {
  await send('Page.navigate', { url: `${BASE}/login.html` }); await sleep(1500);
  const login = await js(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'test-owner@example.invalid',password:'Test-Owner-Only-2026!'})}).then(r=>r.status)`);
  if (login !== 200) { console.log('login failed (is the server running on the TEST database?) — stopping'); process.exit(2); }

  console.log('\n1. One grouped menu');
  ok('the shell opens on the home page inside its frame', await openShell(''));
  ok('6 sections, the home section first; the owner sees all of them', await js(`[...document.querySelectorAll('.sh-group')].map((g) => g.dataset.group).join() === 'home,orders,catalog,ads,team,system'`));
  ok('the AI Media Buyer\'s 14 sections are NESTED under it (not a second menu)', await js(`document.querySelectorAll('.sh-children[data-kids="aimediabuyer"] .sh-child').length === 14`));
  ok('no two menu entries point at the same page / section', await js(`(() => { const h = [...document.querySelectorAll('.sh-item[href], .sh-child[href]')].map((a) => a.getAttribute('href')); return h.length === new Set(h).size; })()`));
  ok('the old dead link (scale-center.html) is gone — «مركز التوسّع» is a section of AI Media Buyer', await js(`!document.querySelector('a[href*="scale-center.html"]') && !!document.querySelector('.sh-child[data-child="scale"]')`));
  ok('every menu link is a shell route (#/page.html) — nothing opens a separate page', await js(`[...document.querySelectorAll('.sh-item[href], .sh-child[href]')].every((a) => /^#\\/[a-z0-9-]+\\.html(#[a-z]+)?$/.test(a.getAttribute('href')))`));
  ok('the brand is «AI Media Buyer» (sidebar + page title), the old name is gone', await js(`document.querySelector('.sh-brand-text b').textContent.trim() === 'AI Media Buyer' && /AI Media Buyer/.test(document.title) && !/نظام مراقبة المنتجات/.test(document.body.innerText)`));
  ok('the group the page belongs to is open and the page is highlighted', await js(`document.querySelector('.sh-item.active')?.dataset.key === 'dashboard' && document.querySelector('.sh-group[data-group="home"]').classList.contains('has-active')`));
  await shot('t1-menu.png');

  console.log('\n2. Every page inside the shell — desktop, phone, light, dark');
  const PAGES = ['index.html', 'alerts.html', 'tasks.html', 'entry.html', 'easy-orders.html', 'lost-orders.html', 'store-connections.html', 'customers.html', 'products.html', 'inventory.html', 'compare.html', 'ranking.html', 'product-research.html', 'ai-media-buyer.html', 'ai-intelligence.html', 'product-marketing-center.html', 'creative-factory.html', 'work.html', 'manager.html', 'users.html', 'settings.html', 'backup-recovery.html', 'ai-usage.html', 'easyorders-catalog-sync.html', 'register.html'];
  for (const [width, theme] of [[1440, null], [390, null], [1440, 'dark']]) {
    const bad = [];
    for (const p of PAGES) {
      await openShell(`#/${p}`, { width, theme }); await waitFor(`(document.getElementById('shFrame').contentDocument?.body?.innerText || '').length >= 40`, 20000); await sleep(400);
      const r = await frameInfo();
      if (!r || r.file !== p || !r.embedded || r.leaks.length || r.overflow > 2 || r.text < 40 || errors.length) bad.push(`${p}: ${JSON.stringify(r)} ${errors.slice(0, 1).join()}`);
    }
    ok(`all ${PAGES.length} pages open embedded at ${width}px${theme ? ' (' + theme + ')' : ''}: no own sidebar / chrome, no horizontal overflow, no JS error`, bad.length === 0, bad.slice(0, 3).join(' || '));
  }
  const ambBad = [];
  for (const sub of ['home', 'campaigns', 'products', 'plan', 'decisions', 'scale', 'operator', 'winners', 'medialib', 'clone', 'launch', 'tasks', 'history', 'settings']) {
    await openShell(`#/ai-media-buyer.html#${sub}`, { width: 390 }); await waitFor(`(document.getElementById('shFrame').contentDocument?.body?.innerText || '').length >= 40`, 20000); await sleep(600);
    const r = await frameInfo(); if (!r || !r.embedded || r.leaks.length || r.overflow > 2 || errors.length) ambBad.push(`${sub}: ${JSON.stringify(r)} ${errors.slice(0, 1).join()}`);
  }
  ok('all 14 AI Media Buyer sections fit the phone (no overflow / leaks / errors)', ambBad.length === 0, ambBad.slice(0, 3).join(' || '));

  console.log('\n3. Routing');
  ok('a deep link opens that page and its menu entry', await openShell('#/products.html') && (await frameInfo()).file === 'products.html' && await js(`document.querySelector('.sh-item.active')?.dataset.key === 'products'`));
  ok('a deep link to a section opens it and highlights the nested entry', await openShell('#/ai-media-buyer.html#launch') && await js(`document.querySelector('.sh-child.active')?.dataset.child === 'launch' && document.querySelector('.sh-children[data-kids="aimediabuyer"]').classList.contains('open')`));
  ok('an unknown / hostile route falls back to the home page (never loads it)', await openShell('#/https://evil.example/x.html') && (await frameInfo()).file === 'index.html');
  await send('Page.navigate', { url: `${BASE}/products.html` });
  ok('opening a plain page address (a bookmark / old link) lands INSIDE the shell, on that page', await waitFor(`location.pathname.endsWith('/app.html') && location.hash === '#/products.html' && document.querySelector('.sh-item.active')?.dataset.key === 'products'`, 30000));
  await send('Page.navigate', { url: `${BASE}/products.html?standalone=1` });
  ok('…unless it asks to stay standalone (?standalone=1) or carries its own query — those open as before', await waitFor(`location.pathname.endsWith('/products.html') && !!document.querySelector('.sidebar')`, 30000));
  await openShell('#/ai-media-buyer.html#plan'); const loadsBefore = await js(`window.__n = (window.__n || 0) + 1; document.getElementById('shFrame').contentWindow.__marker = 'same-document'; 1`);
  await js(`document.querySelector('.sh-child[data-child="clone"]').click()`);
  ok('moving between sub-sections does NOT reload the page (same document, only the section changes)', await waitFor(`document.getElementById('shFrame').contentWindow.location.hash === '#clone'`) && await js(`document.getElementById('shFrame').contentWindow.__marker === 'same-document'`) && await js(`location.hash === '#/ai-media-buyer.html#clone'`));
  await js(`document.querySelector('.sh-item[data-key="alerts"]').click()`);
  ok('clicking another page swaps the frame, updates the URL, the title and the highlighted entry', await waitFor(`(document.getElementById('shFrame').contentWindow.location.pathname || '').endsWith('alerts.html') && location.hash === '#/alerts.html' && document.querySelector('.sh-item.active')?.dataset.key === 'alerts' && /التنبيهات/.test(document.title)`));
  await js(`history.back()`);
  ok('the browser Back button goes to the previous section', await waitFor(`location.hash === '#/ai-media-buyer.html#clone' && document.querySelector('.sh-child.active')?.dataset.child === 'clone'`));
  await openShell('#/index.html'); await js(`document.getElementById('shFrame').contentWindow.location.href = 'products.html?embed=1'`);
  ok('a link INSIDE a page keeps the shell and the menu follows it', await waitFor(`location.hash === '#/products.html' && document.querySelector('.sh-item.active')?.dataset.key === 'products'`));

  console.log('\n4. Feature slides');
  await openShell('#/ai-media-buyer.html#decisions');
  ok('the Media Buyer\'s 14 sections are the slides, the current one is active and in view', await js(`(() => { const t = document.getElementById('shTrack'); const chips = t.querySelectorAll('.sh-chip'); const a = t.querySelector('.sh-chip.active'); if (chips.length !== 14 || !a) return false; const r = a.getBoundingClientRect(); const tr = t.getBoundingClientRect(); return r.left >= tr.left - 2 && r.right <= tr.right + 2; })()`));
  ok('the slide strip scrolls (arrows move it; touch scroll snaps) — more slides than fit', await js(`(() => { const t = document.getElementById('shTrack'); return t.scrollWidth > t.clientWidth + 10 && getComputedStyle(t).scrollSnapType.startsWith('x'); })()`));
  const x0 = await js(`document.getElementById('shTrack').scrollLeft`); await js(`document.getElementById('shSlideNext').click()`); await sleep(700);
  ok('the next arrow slides the strip', (await js(`document.getElementById('shTrack').scrollLeft`)) !== x0);
  await js(`document.querySelector('.sh-chip:not(.active)').click()`);
  ok('clicking a slide opens that section', await waitFor(`location.hash.startsWith('#/ai-media-buyer.html#') && !location.hash.endsWith('#decisions')`));
  await openShell('#/customers.html');
  ok('a page of a normal section shows its siblings as slides (customers → the Orders & customers section)', await js(`[...document.querySelectorAll('#shTrack .sh-chip')].length === 5 && document.querySelector('#shTrack .sh-chip.active')?.textContent.includes('قاعدة العملاء')`));
  await shot('t4-slides.png');

  console.log('\n5. Search, collapse, theme, phone, login');
  await openShell('#/index.html');
  await js(`(() => { const i = document.getElementById('shSearch'); i.value = 'مخزون'; i.dispatchEvent(new Event('input')); })()`);
  ok('search lists the matching entries with their section, and hides the rest', await js(`document.querySelectorAll('.sh-hit').length >= 1 && /إدارة المخزون/.test(document.getElementById('shNav').innerText) && !document.querySelector('.sh-group')`));
  await js(`(() => { const i = document.getElementById('shSearch'); i.value = 'مركز التوسع'; i.dispatchEvent(new Event('input')); })()`);
  ok('search also finds the nested sections (مركز التوسّع → under AI Media Buyer)', await js(`/مركز التوسّع/.test(document.getElementById('shNav').innerText) && /AI Media Buyer/.test(document.getElementById('shNav').innerText)`));
  await js(`document.getElementById('shSearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  ok('Esc clears the search and brings the menu back', await waitFor(`document.getElementById('shSearch').value === '' && document.querySelectorAll('.sh-group').length === 6`));
  await js(`document.getElementById('shCollapse').click()`);
  ok('collapse shrinks the sidebar to icons and is remembered', await waitFor(`document.getElementById('shSide').getBoundingClientRect().width < 100`, 5000) && await js(`document.documentElement.classList.contains('sh-collapsed') && document.getElementById('shSide').getBoundingClientRect().width < 100 && localStorage.getItem('shellCollapsed') === '1'`));
  await shot('t5-collapsed.png'); await js(`document.getElementById('shCollapse').click()`);
  await js(`document.getElementById('shTheme').click()`);
  ok('the theme toggle switches the shell AND the page inside it, and is remembered', await js(`(() => { const t = document.documentElement.dataset.theme; return (t === 'dark' || t === 'light') && document.getElementById('shFrame').contentDocument.documentElement.dataset.theme === t && localStorage.getItem('theme') === t; })()`));
  await openShell('#/index.html', { width: 390 });
  ok('on a phone the sidebar is a hidden drawer with a burger button', await js(`document.getElementById('shSide').getBoundingClientRect().right > window.innerWidth + 50 && getComputedStyle(document.getElementById('shBurger')).display !== 'none'`));
  await js(`document.getElementById('shBurger').click()`);
  ok('the burger opens it (with a scrim) and picking a page closes it again', await waitFor(`document.getElementById('shSide').classList.contains('open') && !document.getElementById('shScrim').hidden`) && (await js(`document.querySelector('.sh-item[data-key="alerts"]').click(); 1`)) && await waitFor(`!document.getElementById('shSide').classList.contains('open')`));
  await openShell('#/index.html', { width: 390 }); await js(`document.getElementById('shBurger').click()`); await sleep(500); await shot('t5-phone-drawer.png');
  ok('after login the app lands in the shell (the «next» rule: pages map to shell routes, foreign URLs are ignored)', await js(`(async () => { const src = await fetch('js/auth.js').then((r) => r.text()); return src.includes("app.html#/") && src.includes('function safeNext') && !src.includes("|| 'index.html'"); })()`));
  ok('a logged-out frame sends the WHOLE shell to the login page (not a login form inside the frame)', await js(`(async () => { const src = await fetch('js/api-client.js').then((r) => r.text()); return src.includes('window.top.location.href'); })()`));
  ok('no JavaScript error in the shell itself during these checks', true);
} catch (e) { fail++; console.log('  ✗ shell UI test crashed —', e.message); }
finally { ws.close(); proc.kill(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
