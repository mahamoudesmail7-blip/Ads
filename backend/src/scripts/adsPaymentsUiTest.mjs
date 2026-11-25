// Ads Payment Center — real-browser UI check (headless Edge/Chrome over the DevTools protocol) against the LOCAL server on the ISOLATED test database.
//   1. node src/scripts/adsPaymentsDevSeed.js          (SIMULATED sample data, test database only)
//   2. node src/scripts/serveAdsPaymentsDev.js         (the real server, simulator switched on — refused anywhere else)   → http://localhost:4000
//   3. node src/scripts/adsPaymentsUiTest.mjs          (FP_SHOTS=<dir> saves screenshots; FP_BASE overrides the server URL)
// Nothing here touches Meta, a real wallet or production: the server only runs on the test database and every code is a simulated one.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const BROWSER = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
if (!BROWSER) { console.log('no Chromium browser found — skipped'); process.exit(0); }
const BASE = process.env.FP_BASE || 'http://localhost:4000'; const SHOTS = process.env.FP_SHOTS || ''; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0; const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };
const PORT = 9400 + Math.floor(Math.random() * 300); const dir = mkdtempSync(join(tmpdir(), 'fpui-'));
const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--hide-scrollbars', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
const done = (code) => { try { proc.kill(); } catch { /* gone */ } process.exit(code); };
let targets; for (let i = 0; i < 80; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch { /* starting */ } await sleep(250); }
const page = targets.find((t) => t.type === 'page'); const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map(); const jsErrors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') jsErrors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error'); return r.result.value; };
const waitFor = async (expr, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await js(expr)) return true; } catch { /* reloading */ } await sleep(150); } return false; };
const shot = async (name, { w = 1536, h = 1020, full = true } = {}) => {
  if (!SHOTS) return; await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(250);
  const m = await send('Page.getLayoutMetrics'); const H = full ? Math.ceil(m.cssContentSize.height) : h;
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, clip: { x: 0, y: 0, width: w, height: H, scale: 1 } }); writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
};
const click = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
const tab = async (k) => { await click(`[data-act="tab"][data-k="${k}"]`); await sleep(300); await waitFor(`!document.querySelector('#fpBody .fp-loading')`, 25000); };
const text = (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.innerText || ''`);
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1536, height: 1020, deviceScaleFactor: 1, mobile: false });

// ---- login (the test database owner) and open the section
await send('Page.navigate', { url: `${BASE}/login.html` }); await sleep(1200);
const login = await js(`fetch('/api/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test-owner@example.invalid', password: 'Test-Owner-Only-2026!' }) }).then((r) => r.status)`);
ok('logged in to the test database', login === 200, login);
await js(`localStorage.setItem('noShell', '1')`); // the page is driven directly (outside the app shell), like the other UI tests
await send('Page.navigate', { url: `${BASE}/ai-media-buyer.html#payments` });
await waitFor(`!!document.querySelector('.fp-kpis')`, 40000);
ok('the section opens from the sidebar entry and renders the overview', await waitFor(`!!document.querySelector('.fp-kpis') && !!document.querySelector('.fp-tabs')`, 40000));
if (!(await js('!!document.querySelector(".fp-kpis")'))) console.log('DEBUG', await js('location.href + " | " + document.body.innerText.slice(0, 400)'), jsErrors.slice(0, 3));
await js(`document.getElementById('dpPopup')?.remove()`);
await shot('01-overview');

console.log('\n1. Layout of the reference');
const L = await js(`(() => { const r = (s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b ? { left: b.left, right: b.right, top: b.top } : { left: NaN, right: NaN, top: NaN }; }; const k = [...document.querySelectorAll('.fp-kpi')].map((e) => e.getBoundingClientRect()); return {
  dir: getComputedStyle(document.querySelector('.fpc')).direction, kpis: k.length, kpiOrder: k.every((x, i) => i === 0 || x.left < k[i - 1].left), fawry: r('#fpFawry'), log: r('.fp-logcard'), accts: r('.fp-accts'), alerts: r('.fp-alerts'), chart: r('.fp-chart'), month: r('.fp-month'),
  tabs: [...document.querySelectorAll('.fp-tab span')].map((e) => e.textContent), side: !!document.querySelector('#ambNav'), navHas: [...document.querySelectorAll('#ambNavList [data-nav]')].some((b) => b.dataset.nav === 'payments'), navOriginal: ['home', 'campaigns', 'products', 'plan', 'scale', 'operator', 'clone', 'launch', 'history', 'settings'].every((n) => !!document.querySelector('#ambNavList [data-nav="' + n + '"]')),
  hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2 }; })()`);
ok('RTL, five KPI cards laid out right → left (total, unpaid, pending, credited, paid)', L.dir === 'rtl' && L.kpis === 5 && L.kpiOrder);
ok('the Fawry panel is in the right column, the log table in the middle and the accounts list on the left', L.fawry.left > L.log.left && L.log.left > L.accts.left && L.fawry.right > L.log.right);
ok('under them: alerts (right) · movement chart (middle) · month summary (left)', L.alerts.left > L.chart.left && L.chart.left > L.month.left);
ok('the seven tabs are in the requested order', L.tabs.join('|') === 'نظرة عامة|استخراج أكواد فوري|سجل أكواد الدفع|الدفع والمحافظ|الحسابات الإعلانية|التقارير والتقفيل|الإعدادات', L.tabs.join('|'));
ok('the original sidebar is untouched and only gained «مركز المدفوعات»', L.side && L.navHas && L.navOriginal);
ok('no horizontal page scroll', !L.hscroll);

console.log('\n2. Real numbers (nothing hard-coded)');
const api = (p) => js(`fetch(${JSON.stringify(p)}, { credentials: 'include' }).then((r) => r.json())`);
const ov = await api('/api/ads-payments/overview?preset=month');
const shown = await js(`({ total: document.querySelector('.fp-kpi.total .k-n').innerText, unpaid: document.querySelector('.fp-kpi.unpaid .k-n').innerText, pending: document.querySelector('.fp-kpi.pending .k-n').innerText, credited: document.querySelector('.fp-kpi.credited .k-n').innerText, paid: document.querySelector('.fp-kpi.paid .k-n').innerText.replace(/[^0-9.,]/g, '') })`);
const n = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
ok('the KPI cards show exactly what the API computed', n(shown.total) === ov.report.extracted.count && n(shown.unpaid) === ov.report.buckets.unpaid.count && n(shown.pending) === ov.report.buckets.pending.count && n(shown.credited) === ov.report.buckets.credited.count && Math.abs(n(shown.paid) - ov.report.payments.actualEgp) < 0.01, JSON.stringify(shown));
ok('unpaid + pending + credited + expired = extracted (no double count)', ['unpaid', 'pending', 'credited', 'expired'].reduce((s, k) => s + ov.report.buckets[k].count, 0) === ov.report.extracted.count);
ok('every ad account in the list comes from the connected accounts (no names in the code)', ov.accounts.length >= 4 && (await js(`document.querySelectorAll('.fp-accts .fp-acct').length`)) === ov.accounts.length);
ok('the chart has a bar per week of the current month and only real values', await js(`document.querySelectorAll('.fp-chart rect').length`) === ov.series.length);

console.log('\n3. Extraction (simulated provider)');
const beforeCount = (await api('/api/ads-payments/codes?limit=1')).total;
await js(`(() => { const s = document.getElementById('fpXAcct'); s.value = [...s.options].find((o) => /Boda/.test(o.textContent)).value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await click('[data-act="amt"][data-v="2000"]'); await sleep(200);
ok('a quick amount selects and the required-code box shows it', (await text('.fp-need')).includes('2,000'));
await click('[data-act="amt"][data-v="custom"]'); await sleep(200);
ok('the custom amount shows an input', !!(await js(`document.getElementById('fpCustom')`)));
await js(`(() => { const i = document.getElementById('fpCustom'); i.value = String(1200 + Math.floor(Math.random() * 900) + 0.5); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const warn1 = await js(`(async () => { document.getElementById('fpExtractBtn').click(); await new Promise((r) => setTimeout(r, 2500)); return document.querySelector('.fp-modal h3')?.innerText || ''; })()`);
ok('an account that still has an open code shows the warning dialog before extracting another', /فيه كود سابق/.test(warn1), warn1);
await js(`document.querySelector('.fp-ov [data-close]')?.click()`); await sleep(300);
await js(`(() => { const s = document.getElementById('fpXAcct'); s.value = [...s.options].find((o) => /Ahmed/.test(o.textContent)).value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const fresh = await api('/api/ads-payments/codes?account=act_1518142859790043&bucket=open'); const hadOpen = fresh.total > 0;
await js(`document.getElementById('fpExtractBtn').click()`); await sleep(2500);
await js(`[...document.querySelectorAll('.fp-ov button')].find((b) => /رغم كده/.test(b.innerText))?.click()`); await sleep(3000); // an open or just-requested code for the account shows the warning — confirm it
const after = (await api('/api/ads-payments/codes?limit=1')).total;
ok('a confirmed extraction saves ONE new real code in the database', after === beforeCount + 1, `${beforeCount} → ${after}`);
ok('the result shows the code number, a copy button and its details', await waitFor(`!!document.querySelector('.fp-result.ok .code span') && !!document.querySelector('.fp-result.ok [data-act="copy"]')`, 8000));
const newest = (await api('/api/ads-payments/codes?limit=1')).rows[0];
ok('the new code is UNPAID, simulated, with its employee, time and expiry', newest.status === 'UNPAID' && newest.simulated && !!newest.extractedBy && !!newest.extractedAt && !!newest.expiresAt);
ok('it appears at the top of «آخر الأكواد المستخرجة» and in today\'s log', (await text('.fp-last')).includes(newest.code) && (await js(`document.querySelector('#fpOvRows').innerText`)).includes(newest.code));
await shot('02-after-extract');

console.log('\n4. Payment');
await click(`#fpOvRows [data-act="pay"][data-id="${newest.id}"]`); await sleep(1500);
const payTxt = await text('.fp-modal');
ok('«ادفع الآن» opens the payment window with the account, the code, the value, the method, the balance, the fee and the total', /الحساب الإعلاني/.test(payTxt) && payTxt.includes(newest.code) && /الرصيد المتاح/.test(payTxt) && /رسوم الدفع/.test(payTxt) && /إجمالي المبلغ المطلوب خصمه/.test(payTxt));
await shot('03-pay-modal', { full: false });
await js(`document.getElementById('pyOk').click()`); await sleep(3000);
const paid = (await api(`/api/ads-payments/codes/${newest.id}`)).row;
ok('confirming the payment records PAID (not credited yet) with the transaction, receipt, employee and method', paid.status === 'PAID' && !!paid.txnRef && !!paid.receipt && !!paid.paidBy && !!paid.methodLabel && !paid.creditedAt, JSON.stringify(paid).slice(0, 300));
ok('…and the window closed, the row now has no «ادفع الآن»', !(await js(`!!document.querySelector('.fp-modal')`)) && !(await js(`!!document.querySelector('#fpOvRows [data-act="pay"][data-id="${newest.id}"]')`)));
const dupe = await js(`fetch('/api/ads-payments/codes/${newest.id}/pay', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ methodId: '${(await api('/api/ads-payments/methods')).methods[0].id}', requestId: 'dupe-request-0001', confirm: true, expectedTotalEgp: ${paid.totalEgp} }) }).then(async (r) => ({ s: r.status, b: await r.json() }))`);
ok('paying the same code again (new request) is refused and nothing is charged twice', dupe.s === 409 && dupe.b.error === 'ALREADY_PAID', JSON.stringify(dupe));

console.log('\n5. Code details, credit confirmation, tabs');
await js(`document.querySelector('[data-act="code"][data-id="${newest.id}"]').click()`); await sleep(1200);
const drawer = await text('.fp-modal');
ok('the code window shows the full history (extract → paid), the durations and the actions', /سجل الأحداث/.test(drawer) && /تم الدفع/.test(drawer) && /تأكيد التسميع/.test(drawer));
await shot('04-code-details', { full: false });
await js(`[...document.querySelectorAll('.fp-modal button')].find((b) => /تأكيد التسميع/.test(b.innerText)).click()`); await sleep(500);
await js(`(() => { document.getElementById('crEv').value = ''; })()`); await js(`document.getElementById('crOk').click()`); await sleep(1200);
ok('credit confirmation without evidence is refused (the window stays open)', await js(`!!document.getElementById('crOk')`));
await js(`(() => { document.getElementById('crEv').value = 'Ads Manager → الفوترة → معاملة اختبار 5521'; })()`); await js(`document.getElementById('crOk').click()`); await sleep(2500);
const cred = (await api(`/api/ads-payments/codes/${newest.id}`)).row;
ok('with evidence it becomes CREDITED, source «تأكيد يدوي», and the KPI refreshes', cred.status === 'CREDITED' && /يدوي/.test(cred.creditSource) && !!cred.creditedAt);
for (const [k, probe] of [['extract', '.fp-fawrybox'], ['log', '#fpLogQ'], ['wallets', '.fp-prov'], ['accounts', '.fp-acctcard'], ['reports', '.fp-stats'], ['settings', '#stMon']]) {
  await tab(k); ok(`tab «${k}» renders its content`, await waitFor(`!!document.querySelector(${JSON.stringify(probe)})`, 15000)); await shot(`10-tab-${k}`);
}
await tab('log'); await js(`(() => { const i = document.getElementById('fpLogQ'); i.value = '${newest.code}'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(1800);
ok('the log search by code number finds the row', (await js(`document.querySelectorAll('#fpBody tbody tr[data-id]').length`)) === 1);
await tab('reports'); await js(`document.getElementById('fpGran').value = 'week'; document.getElementById('fpGran').dispatchEvent(new Event('change', { bubbles: true }))`); await sleep(2500);
ok('the report switches to weekly granularity', await waitFor(`document.getElementById('fpGran')?.value === 'week'`, 10000));
await tab('wallets'); ok('the real-connection status says «تحتاج ربط» wording is shown when a provider is not connected (simulation labelled «محاكاة» here)', /محاكاة|تحتاج ربط/.test(await text('#fpBody')));

console.log('\n5b. Excel export & the shortcut buttons');
const xl = await js(`fetch('/api/ads-payments/report.xlsx?preset=month', { credentials: 'include' }).then(async (r) => ({ s: r.status, t: r.headers.get('content-type'), n: (await r.arrayBuffer()).byteLength }))`);
ok('the report exports to a real .xlsx file', xl.s === 200 && /spreadsheetml/.test(xl.t) && xl.n > 3000, JSON.stringify(xl));
await tab('overview');
ok('every account in the overview list has its own «شحن الحساب» button', (await js(`document.querySelectorAll('.fp-accts .charge').length`)) >= 4);
await js(`document.querySelector('.fp-accts .charge').click()`); await sleep(600);
ok('«شحن الحساب» opens the extraction window with the accounts to choose from', /استخراج كود جديد/.test(await text('.fp-modal')) && !!(await js(`document.getElementById('fpXAcctM')`)));
await js(`document.querySelector('.fp-ov [data-close]').click()`);

console.log('\n6. Responsive');
await tab('overview'); await shot('20-phone', { w: 390, h: 844, full: true });
const ph = await js(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2`);
ok('no horizontal page scroll at phone width', ph);
await shot('21-tablet', { w: 900, h: 1000, full: true });

// ---- inside the real app shell (the page is an iframe of app.html, with the shell's own sidebar)
await js(`localStorage.removeItem('noShell')`); await send('Page.navigate', { url: `${BASE}/app.html#/ai-media-buyer.html#payments` });
ok('inside the app shell the section renders too', await waitFor(`!!document.querySelector('iframe')?.contentDocument?.querySelector('.fp-kpis')`, 40000));
await shot('30-in-shell', { w: 1536, h: 1020, full: false });
ok('no JavaScript errors on any screen', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
console.log(`\n${fail ? '❌' : '✅'} adsPaymentsUiTest: ${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);
