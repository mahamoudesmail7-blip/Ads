// amb-payments.js — «مركز المدفوعات الإعلانية»: Fawry codes, payments, follow-up, reports. Mounted as the `payments` section of AI Media Buyer (ai-media-buyer.js adds only the nav entry).
// Talks ONLY to /api/ads-payments. Every number on screen comes from that API; nothing here is a placeholder. Whatever is not connected (real extraction / direct payment / credit proof)
// is shown as «تحتاج ربط» with the manual path, never faked.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const E = (s) => UI.escapeHtml(String(s ?? ''));
const API = '/api/ads-payments';
const rid = () => { try { return crypto.randomUUID().replace(/-/g, '').slice(0, 28); } catch { return (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)).padEnd(16, 'x'); } };
const num = (v, d = 0) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(Number(v)) ? 0 : Math.min(d || 2, 2), maximumFractionDigits: d || 2 }));
const egp = (v) => (v === null || v === undefined ? '—' : `${num(v, 2)} ج`);
const pct = (v) => `${num(v, 1)}%`;
const pad = (n) => String(n).padStart(2, '0');
function fmtClock(iso) { const d = new Date(iso); const h = d.getHours(); return `${pad(h % 12 || 12)}:${pad(d.getMinutes())} ${h >= 12 ? 'م' : 'ص'}`; }
function fmtDT(iso) { if (!iso) return '—'; const d = new Date(iso); const t = new Date(); const same = d.toDateString() === t.toDateString(); return same ? fmtClock(iso) : `${d.getDate()}/${d.getMonth() + 1} ${fmtClock(iso)}`; }
/** table cell: the time, with the date small above it when it is not today (keeps the date columns narrow) */
function dtCell(iso) { if (!iso) return '—'; const d = new Date(iso); return d.toDateString() === new Date().toDateString() ? fmtClock(iso) : `<span class="dd">${d.getDate()}/${d.getMonth() + 1}</span>${fmtClock(iso)}`; }
function fmtFull(iso) { if (!iso) return '—'; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtClock(iso)}`; }
function fmtDur(min) { if (min == null) return '—'; if (min < 60) return `${min} دقيقة`; const h = Math.floor(min / 60); const m = min % 60; return h >= 24 ? `${Math.floor(h / 24)} يوم ${h % 24} ساعة` : `${h} ساعة${m ? ` و${m} دقيقة` : ''}`; }
const kfmt = (v) => (v >= 1_000_000 ? `${num(v / 1_000_000, 1)}M` : v >= 1000 ? `${num(v / 1000, v % 1000 === 0 ? 0 : 1)}K` : num(v));

const IC = {
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2"/><path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2z"/><circle cx="16.5" cy="14.5" r="1.2"/>',
  ticket: '<path d="M3 9a2 2 0 0 0 0 6v3h18v-3a2 2 0 0 1 0-6V6H3z"/><path d="M13 6v12" stroke-dasharray="2 2"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  x: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  stack: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 17 9 5 9-5" opacity=".5"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/>',
  cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  chev: '<path d="m15 18-6-6 6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 19.4 7l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4z"/>',
  doc: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l3-4 3 3 5-7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  arrow: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
};
const ic = (n, c = 'fp-ic') => `<svg class="${c}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${IC[n] || ''}</svg>`;
const META = '<svg class="fp-meta" viewBox="0 0 32 20" fill="none" stroke="#1877f2" stroke-width="3.2" stroke-linecap="round"><path d="M4 16c3-12 7.5-12 12 0 4.500-12 9-12 12 0"/></svg>';
const FAWRY = '<span class="fp-fawry" aria-label="فوري"><span class="fp-fawry-dot"></span>فوري</span>';

const TABS = [{ k: 'overview', l: 'نظرة عامة', i: 'home' }, { k: 'extract', l: 'استخراج أكواد فوري', i: 'bolt' }, { k: 'log', l: 'سجل أكواد الدفع', i: 'doc' }, { k: 'wallets', l: 'الدفع والمحافظ', i: 'wallet' }, { k: 'accounts', l: 'الحسابات الإعلانية', i: 'list' }, { k: 'reports', l: 'التقارير والتقفيل', i: 'chart' }, { k: 'settings', l: 'الإعدادات', i: 'gear' }];
const ST = { UNPAID: ['غير مدفوع', 'x'], PAY_FAILED: ['فشل الدفع', 'x'], PAYING: ['جاري الدفع', 'clock'], PAID: ['مدفوع ولم يسمع', 'clock'], CREDITED: ['مسمع بنجاح', 'check'], EXPIRED: ['منتهي الصلاحية', 'x'], UNCERTAIN: ['نتيجة غير مؤكدة', 'warn'], REVIEW: ['يحتاج مراجعة', 'warn'] };
const ST_CLASS = { UNPAID: 'red', PAY_FAILED: 'red', EXPIRED: 'gray', PAYING: 'orange', PAID: 'orange', UNCERTAIN: 'orange', REVIEW: 'orange', CREDITED: 'green' };
const pill = (s) => `<span class="fp-pill ${ST_CLASS[s] || 'gray'}">${ic(ST[s]?.[1] || 'clock', 'fp-ic sm')}${E(ST[s]?.[0] || s)}</span>`;
const donut = (p, color, size = 58) => { const r = 22; const c = 2 * Math.PI * r; const v = Math.max(0, Math.min(100, p)); return `<svg class="fp-donut" width="${size}" height="${size}" viewBox="0 0 56 56"><circle cx="28" cy="28" r="${r}" fill="none" stroke="#ece8fb" stroke-width="6"/><circle cx="28" cy="28" r="${r}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(c * v / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 28 28)"/><text x="28" y="32" text-anchor="middle" font-size="12" font-weight="800" fill="#1e1b4b">${Math.round(v)}%</text></svg>`; };

const P = {
  tab: 'overview', period: { preset: 'month', from: '', to: '' }, account: '', ov: null, status: null, toast: () => {}, timers: [],
  xrid: rid(), amount: 3000, custom: false, xAccount: '', lastExtract: null, logQ: { q: '', status: '', account: '', user: '', method: '', bucket: '', from: '', to: '', dateField: 'extracted', offset: 0 }, log: null, report: null, gran: '', settings: null, methods: null, accountsTab: null, forecast: null, caps: null, closings: null, closeKind: 'day', accountDetail: null,
};
let root = null;

const errBox = (e) => E(e?.message || 'حصل خطأ.');
async function call(fn) { try { return await fn(); } catch (e) { P.toast(e?.message || 'حصل خطأ.', 'error'); throw e; } }
const can = (k) => !!P.ov?.perms?.[k] || !!P.status?.perms?.[k];
const providers = () => P.ov?.providers || P.status?.providers;

// ---------------------------------------------------------------------------
// modal helpers
// ---------------------------------------------------------------------------
function modal(html, { wide = false, cls = '' } = {}) {
  const ov = document.createElement('div'); ov.className = 'fp-ov';
  ov.innerHTML = `<div class="fp-modal ${wide ? 'wide' : ''} ${cls}" role="dialog" dir="rtl">${html}</div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); };
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
  const esc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
  return { el: ov, close, $: (s) => ov.querySelector(s), $$: (s) => [...ov.querySelectorAll(s)] };
}
function confirmBox({ title, body, ok = 'تأكيد', danger = false, cancel = 'إلغاء' }) {
  return new Promise((res) => {
    const m = modal(`<div class="fp-mh"><h3>${E(title)}</h3><button class="fp-x" data-close>${ic('x')}</button></div><div class="fp-mb">${body}</div><div class="fp-mf"><button class="fp-btn ghost" data-close>${E(cancel)}</button><button class="fp-btn ${danger ? 'danger' : 'primary'}" id="fpOk">${E(ok)}</button></div>`);
    let done = false; const fin = (v) => { if (!done) { done = true; res(v); } m.close(); };
    m.$('#fpOk').onclick = () => fin(true); m.$$('[data-close]').forEach((b) => { b.onclick = () => fin(false); }); m.el.addEventListener('mousedown', (e) => { if (e.target === m.el) fin(false); });
  });
}
const copyText = async (t) => { try { await navigator.clipboard.writeText(t); P.toast('اتنسخ الكود ✔', 'success'); } catch { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); P.toast('اتنسخ الكود ✔', 'success'); } catch { P.toast('منقدرش ننسخ — انسخه يدويًا.', 'error'); } a.remove(); } };
const lockBtn = async (btn, fn) => { if (btn.disabled) return; btn.disabled = true; const old = btn.innerHTML; btn.classList.add('busy'); try { return await fn(); } finally { btn.disabled = false; btn.classList.remove('busy'); btn.innerHTML = old; } };

// ---------------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------------
function periodQs() { const p = P.period; return { preset: p.preset, ...(p.preset === 'custom' ? { from: p.from, to: p.to } : {}) }; }
async function loadOverview() { P.ov = await api.get(`${API}/overview`, { ...periodQs(), account: P.account || undefined }); if (!P.xAccount || !P.ov.accounts.some((a) => a.id === P.xAccount)) P.xAccount = P.ov.accounts.find((a) => !a.removed)?.id || ''; return P.ov; }

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------
export async function mountPayments(panel, { toast } = {}) {
  root = panel; P.toast = toast || (() => {}); P.timers.forEach(clearInterval); P.timers = [];
  P.status = await api.get(`${API}/status`).catch((e) => { throw new Error(e.status === 403 ? 'مفيش عندك صلاحية لمشاهدة مركز المدفوعات — اطلبها من مدير النظام.' : e.message); });
  panel.classList.add('fpc'); panel.innerHTML = '<div class="fp-loading">جارِ التحميل…</div>';
  panel.onclick = onClick; panel.onchange = onChange; panel.oninput = onInput;
  await renderAll();
  const t = setInterval(() => { if (!document.body.contains(root)) { clearInterval(t); return; } if (document.hidden || document.querySelector('.fp-ov') || P.tab !== 'overview') return; refreshQuiet(); }, 60_000);
  P.timers.push(t);
}
async function refreshQuiet() { try { await loadOverview(); renderBody(); } catch { /* keep what is on screen */ } }

async function renderAll() {
  root.innerHTML = `<div id="fpHead"></div><div id="fpTabs"></div><div id="fpBody"><div class="fp-loading">جارِ التحميل…</div></div>`;
  renderHead(); renderTabs(); await showTab(P.tab);
}
function renderHead() {
  const pr = P.status?.presets || {}; const accs = P.ov?.accounts || [];
  document.getElementById('fpHead').innerHTML = `
    <div class="fp-head">
      <div class="fp-head-id"><div class="fp-head-ic">${ic('wallet', 'fp-ic lg')}</div><div><h1>مركز المدفوعات الإعلانية</h1><div class="sub">استخراج أكواد الدفع الإلكتروني — متابعة حالة الأكواد — وتقارير تفصيلية</div></div></div>
      <div class="fp-head-tools">
        <button class="fp-btn primary" data-act="newCode">${ic('bolt')}استخراج كود جديد</button>
        <div class="fp-sel"><span class="fp-sel-ic">${ic('cal')}</span><select id="fpPeriod">${Object.entries(pr).map(([k, l]) => `<option value="${k}" ${P.period.preset === k ? 'selected' : ''}>${E(k === 'month' && P.ov?.period?.preset === 'month' ? P.ov.period.label : l)}</option>`).join('')}</select><span class="fp-sel-dd">${ic('down')}</span></div>
        <div class="fp-sel"><span class="fp-sel-ic">${ic('clock')}</span><select id="fpAcct"><option value="">جميع الحسابات</option>${accs.map((a) => `<option value="${E(a.id)}" ${P.account === a.id ? 'selected' : ''}>${E(a.name)}</option>`).join('')}</select><span class="fp-sel-dd">${ic('down')}</span></div>
      </div>
    </div>
    ${P.period.preset === 'custom' ? `<div class="fp-range"><label>من <input type="date" id="fpFrom" value="${E(P.period.from)}"></label><label>إلى <input type="date" id="fpTo" value="${E(P.period.to)}"></label><button class="fp-btn sm primary" data-act="applyRange">تطبيق</button></div>` : ''}
    ${providers()?.simulation ? `<div class="fp-banner sim">${ic('shield')}<b>وضع محاكاة (اختبار):</b> الأكواد والمدفوعات هنا تجريبية على قاعدة بيانات الاختبار فقط — مفيش كود حقيقي ولا فلوس حقيقية.</div>` : ''}`;
  document.getElementById('fpPeriod').onchange = (e) => { P.period.preset = e.target.value; if (e.target.value === 'custom') { const t = new Date().toISOString().slice(0, 10); P.period.from = P.period.from || t; P.period.to = P.period.to || t; renderHead(); } else { P.log = null; P.report = null; showTab(P.tab); renderHead(); } };
  document.getElementById('fpAcct').onchange = (e) => { P.account = e.target.value; P.logQ.account = P.account; P.log = null; showTab(P.tab); };
}
function renderTabs() {
  document.getElementById('fpTabs').innerHTML = `<div class="fp-tabs">${TABS.map((t) => `<button class="fp-tab ${P.tab === t.k ? 'active' : ''}" data-act="tab" data-k="${t.k}">${ic(t.i)}<span>${t.l}</span></button>`).join('')}</div>`;
}
async function showTab(k) {
  P.tab = k; renderTabs(); const body = document.getElementById('fpBody'); body.innerHTML = '<div class="fp-loading">جارِ التحميل…</div>';
  try {
    if (k === 'overview' || !P.ov) await loadOverview();
    if (k === 'extract') await loadBatches();
    if (k === 'log') await loadLog();
    if (k === 'wallets') { P.methods = await api.get(`${API}/methods`); P.caps = await api.get(`${API}/capabilities`); }
    if (k === 'accounts') { P.accountsTab = await api.get(`${API}/accounts`, periodQs()); P.forecast = await api.get(`${API}/forecast`).catch(() => null); P.accountDetail = null; }
    if (k === 'reports') { if (can('reports')) { P.report = await api.get(`${API}/report`, { ...periodQs(), granularity: P.gran || undefined }); P.closings = await api.get(`${API}/closings`, { kind: P.closeKind }); } }
    if (k === 'settings') { P.settings = await api.get(`${API}/settings`); }
    renderHead(); renderBody();
  } catch (e) { body.innerHTML = `<div class="fp-card fp-empty">⚠️ ${errBox(e)}</div>`; }
}
const renderBody = () => { const b = document.getElementById('fpBody'); if (!b) return; ({ overview: renderOverview, extract: renderExtractTab, log: renderLogTab, wallets: renderWallets, accounts: renderAccountsTab, reports: renderReports, settings: renderSettings })[P.tab](b); };

// ---------------------------------------------------------------------------
// OVERVIEW — same layout as the reference
// ---------------------------------------------------------------------------
function kpiHtml(o) {
  const r = o.report; const b = r.buckets; const cmp = o.comparison;
  const card = (cls, icon, title, count, val, p, color, bucket) => `<button class="fp-kpi ${cls}" data-act="kpi" data-bucket="${bucket}"><div class="k-ic">${ic(icon)}</div><div class="k-body"><div class="k-t">${title}</div><div class="k-n">${num(count)} <small>كود</small></div><div class="k-v">${egp(val)}</div></div>${p == null ? '' : donut(p, color)}</button>`;
  const ch = cmp.changePct;
  return `<div class="fp-kpis">
    <button class="fp-kpi total" data-act="kpi" data-bucket=""><div class="k-ic">${ic('ticket')}</div><div class="k-body"><div class="k-t">إجمالي الأكواد المستخرجة</div><div class="k-n">${num(r.extracted.count)} <small>كود</small></div><div class="k-v">قيمة الأكواد: ${egp(r.extracted.valueEgp)}</div></div></button>
    ${card('unpaid', 'x', 'الأكواد غير المدفوعة', b.unpaid.count, b.unpaid.valueEgp, b.unpaid.pct, '#ef4444', 'unpaid')}
    ${card('pending', 'clock', 'الأكواد المعلقة', b.pending.count, b.pending.valueEgp, b.pending.pct, '#f59e0b', 'pending')}
    ${card('credited', 'check', 'الأكواد المسمعة', b.credited.count, b.credited.valueEgp, b.credited.pct, '#16a34a', 'credited')}
    <button class="fp-kpi paid" data-act="kpi" data-bucket="paid"><div class="k-ic">${ic('stack')}</div><div class="k-body"><div class="k-t">إجمالي المدفوعات الفعلية</div><div class="k-n big">${num(r.payments.actualEgp, 2)} <small>ج</small></div><div class="k-v ${ch == null ? '' : ch >= 0 ? 'up' : 'down'}">${ch == null ? `لا توجد فترة سابقة للمقارنة` : `${ic(ch >= 0 ? 'up' : 'down', 'fp-ic sm')} ${ch >= 0 ? '+' : ''}${num(ch, 1)}% عن ${E(cmp.label)}`}</div><div class="k-sub">مسمّع مؤكد: ${egp(r.credited.valueEgp)} · رسوم: ${egp(r.payments.feesEgp)}</div></div></button>
  </div>`;
}
function fawryPanelHtml({ modalMode = false } = {}) {
  const sx = modalMode ? 'M' : '';
  const o = P.ov; const ex = providers()?.extract; const connected = ex?.available;
  const accs = (o?.accounts || []).filter((a) => !a.removed);
  const amounts = (P.status?.quickAmounts || [1000, 2000, 3000, 5000, 10000]);
  const sel = P.custom ? 'custom' : P.amount;
  return `<div class="fp-card fp-fawrybox" id="fpFawry${sx}">
    <div class="fp-fawry-top"><div class="t"><h3>استخراج كود فوري ${ic('bolt', 'fp-ic sm bolt')}</h3><div class="s">شحن حسابك الإعلاني عبر فوري</div></div>${FAWRY}</div>
    ${connected ? '' : `<div class="fp-banner warn">${ic('link')}<div><b>الاستخراج الآلي «تحتاج ربط»</b> — ${E(ex?.reason || '')}<br><span class="fp-dim">المسار المتاح: ${E(ex?.manualPath || '')}</span></div></div>`}
    <label class="fp-lab">الحساب الإعلاني</label>
    <div class="fp-sel wide acct"><select id="fpXAcct${sx}">${accs.map((a) => `<option value="${E(a.id)}" ${P.xAccount === a.id ? 'selected' : ''}>${E(a.name)}</option>`).join('')}</select>${META}<span class="fp-sel-dd">${ic('down')}</span></div>
    <label class="fp-lab">قيمة الشحن</label>
    <div class="fp-amts">${amounts.map((a) => `<button class="fp-amt ${sel === a ? 'on' : ''}" data-act="amt" data-v="${a}">${num(a)} ج</button>`).join('')}<button class="fp-amt ${P.custom ? 'on' : ''}" data-act="amt" data-v="custom">مبلغ مخصص</button></div>
    <div class="fp-need">${FAWRY}<div class="nv"><span class="nl">قيمة كود فوري المطلوب</span>${P.custom ? `<input id="fpCustom${sx}" type="number" min="1" step="0.01" value="${P.amount && !amounts.includes(P.amount) ? P.amount : ''}" placeholder="اكتب المبلغ">` : `<b>${num(P.amount)} ج</b>`}</div></div>
    ${connected ? `<button class="fp-btn primary xl" data-act="extractNow" id="fpExtractBtn${sx}">استخراج كود فوري الآن ${ic('bolt')}</button>` : ''}
    ${can('extract') ? `<button class="fp-btn ${connected ? 'ghost' : 'primary'} xl" data-act="registerCode">${ic('plus')}تسجيل كود (من Ads Manager)</button>` : ''}
    ${P.lastExtract ? lastExtractHtml(P.lastExtract) : ''}
  </div>`;
}
function lastExtractHtml(x) {
  const c = x.code; const j = x.job;
  if (c) return `<div class="fp-result ok"><div class="rt">${ic('check')} ${x.manual ? 'اتسجّل الكود' : 'اتطلّع الكود بنجاح'}${c.simulated ? ' <span class="fp-tag">محاكاة</span>' : ''}</div><div class="code"><span>${E(c.code)}</span><button class="fp-btn sm ghost" data-act="copy" data-v="${E(c.code)}">${ic('copy')}نسخ</button></div><div class="fp-dim">${E(c.accountName)} · ${egp(c.amountEgp)} · ${c.expiresAt ? `ينتهي ${fmtFull(c.expiresAt)}` : 'تاريخ الانتهاء غير متاح'}</div></div>`;
  if (j) return `<div class="fp-result ${j.status === 'FAILED' ? 'bad' : 'warn'}"><div class="rt">${ic(j.status === 'FAILED' ? 'x' : 'warn')} ${j.status === 'FAILED' ? 'فشل الاستخراج' : 'نتيجة غير مؤكدة'}</div><div class="fp-dim">${E(j.error || '')}</div>${j.status === 'UNCERTAIN' ? `<div class="fp-dim">راجع Ads Manager قبل أي محاولة جديدة، ثم حلّ العملية من «استخراج أكواد فوري».</div>` : ''}</div>`;
  return '';
}
function lastCodesHtml(o) {
  const rows = o.lastCodes || [];
  return `<div class="fp-card"><div class="fp-ch"><h3>${ic('clock')}آخر الأكواد المستخرجة</h3></div>${rows.length ? `<div class="fp-last">${rows.map((c) => `<button class="fp-lrow" data-act="code" data-id="${c.id}"><span class="lcol"><b class="lc">${E(c.code)}</b><span class="la">${E(c.accountName)}</span></span><span class="rcol"><span class="lv">${num(c.amountEgp)} ج</span>${pill(c.status)}</span></button>`).join('')}</div>` : '<div class="fp-empty sm">لسه مفيش أكواد.</div>'}<a class="fp-link" data-act="tab" data-k="log" href="javascript:void 0">عرض كل الأكواد ${ic('arrow', 'fp-ic sm')}</a></div>`;
}
function bulkCardHtml() {
  const batches = (P.ov?.batches || []);
  return `<div class="fp-card fp-bulk"><div class="fp-bulk-h"><div class="bi">${ic('stack', 'fp-ic lg')}</div><div><h3>الدفع الجماعي</h3><div class="s">دفع عدة أكواد دفعة واحدة</div></div></div>
    ${batches.length ? `<div class="fp-batchnote">${batches.map((b) => `<button class="fp-chip" data-act="openBatch" data-id="${b.id}">${b.type === 'PAY' ? 'دفع جماعي' : 'استخراج جماعي'} — ${E(b.status === 'RUNNING' ? 'شغال' : b.status === 'STOPPED_UNCERTAIN' ? 'وقف: نتيجة غير مؤكدة' : 'متوقف')}</button>`).join('')}</div>` : ''}
    <button class="fp-btn primary xl" data-act="bulkPay" ${can('bulkPay') ? '' : 'disabled title="مفيش صلاحية الدفع الجماعي"'}>اختيار الأكواد والدفع ${ic('arrow')}</button>
    <button class="fp-btn ghost xl" data-act="bulkExtract" ${can('extract') ? '' : 'disabled'}>استخراج أكواد جماعي ${ic('bolt')}</button></div>`;
}
function accountsListHtml(o) {
  const accs = o.accounts.filter((a) => !a.removed || a.extractedCount);
  return `<div class="fp-card fp-accts"><div class="fp-ch"><h3>الحسابات الإعلانية</h3><a class="fp-link top" data-act="tab" data-k="accounts" href="javascript:void 0">عرض الكل</a></div>
    ${accs.length ? accs.map((a) => `<div class="fp-acct" data-act="account" data-id="${E(a.id)}"><div class="ah">${META}<div class="an"><b>${E(a.name)}</b><span>${egp(a.extractedValueEgp)} | ${num(a.extractedCount)} كود${a.balance?.available != null ? ` · رصيد ${num(a.balance.available)} ج` : ''}</span></div>${donut(a.creditedPct, '#16a34a', 48)}</div><div class="ac"><span class="fp-chip red">غير مدفوع ${a.unpaid}</span><span class="fp-chip orange">معلق ${a.pending}</span><span class="fp-chip green">مسمع ${a.credited}</span>${can('extract') && !a.removed ? `<button class="fp-btn sm primary charge" data-act="charge" data-id="${E(a.id)}">${ic('bolt', 'fp-ic sm')}شحن الحساب</button>` : ''}</div></div>`).join('') : '<div class="fp-empty sm">مفيش حسابات إعلانية مربوطة.</div>'}</div>`;
}
function rowActions(c, full = false) {
  const payable = ['UNPAID', 'PAY_FAILED'].includes(c.status) && can('pay');
  const pay = payable ? `<button class="fp-btn sm primary" data-act="pay" data-id="${c.id}">ادفع الآن</button>` : '';
  const dots = `<button class="fp-btn sm ghost icon" data-act="code" data-id="${c.id}" title="التفاصيل">${ic('dots')}</button>`;
  return full ? pay + dots : (pay || dots); // like the reference: «ادفع الآن» on unpaid rows, «…» on the others (the code number opens the details too)
}
function logRowsHtml(rows, { full = false } = {}) {
  return rows.map((c, i) => `<tr data-id="${c.id}"><td class="c-n">${i + 1}</td><td><button class="fp-codebtn" data-act="code" data-id="${c.id}">${E(c.code)}</button>${c.simulated && full ? '<span class="fp-tag">محاكاة</span>' : ''}</td><td>${E(c.accountName)}</td><td class="c-amt">${num(c.amountEgp)} ج</td><td class="c-dt">${dtCell(c.extractedAt)}</td><td class="c-dt">${dtCell(c.paidAt)}</td><td class="c-dt">${dtCell(c.creditedAt)}</td>${full ? `<td class="c-dt">${dtCell(c.expiresAt)}</td>` : ''}<td>${pill(c.status)}</td><td>${c.methodLabel ? `<span class="fp-method">${E(c.methodLabel)}</span>` : '—'}</td>${full ? `<td>${E(c.paidBy || c.extractedBy || '—')}</td><td class="mono">${E(c.txnRef || '—')}</td><td>${c.receipt?.number ? E(c.receipt.number) : c.receipt?.note ? 'مرفق' : '—'}</td>` : ''}<td class="c-act">${rowActions(c, full)}</td></tr>`).join('');
}
function logTableHtml(o) {
  const rows = o.log || [];
  return `<div class="fp-card fp-logcard"><div class="fp-ch"><h3>${ic('ticket')}سجل أكواد الدفع (اليوم)</h3><div class="fp-filters"><div class="fp-search">${ic('search')}<input id="fpOvSearch" placeholder="بحث برقم أو الحساب…" value="${E(P.ovSearch || '')}"></div></div></div>
    <div class="fp-tw"><table class="fp-table"><thead><tr><th>#</th><th>الكود</th><th>الحساب الإعلاني</th><th>المبلغ</th><th>تاريخ الاستخراج</th><th>تاريخ الدفع</th><th>تاريخ التسميع</th><th>الحالة</th><th>طريقة الدفع</th><th>إجراءات</th></tr></thead><tbody id="fpOvRows">${rows.length ? logRowsHtml(filterOv(rows)) : `<tr><td colspan="10" class="fp-empty sm">مفيش أكواد النهارده أو متعلقة.</td></tr>`}</tbody></table></div>
    <div class="fp-note">الأكواد المتعلقة من أيام سابقة بتفضل هنا لحد ما تتحل.</div></div>`;
}
const filterOv = (rows) => { const t = (P.ovSearch || '').trim().toLowerCase(); return t ? rows.filter((r) => [r.code, r.accountName, r.txnRef].some((x) => String(x || '').toLowerCase().includes(t))) : rows; };
function monthHtml(o) {
  const m = o.month.report; const b = m.buckets;
  const row = (l, v, cls = '') => `<div class="fp-mrow"><span>${l}</span><b class="${cls}">${v}</b></div>`;
  return `<div class="fp-card fp-month"><div class="fp-ch"><h3>${ic('cal')}ملخص الشهر (${E(o.month.label)})</h3></div>
    ${row('إجمالي الأكواد', `${num(m.extracted.count)} كود`)}${row('إجمالي القيمة', egp(m.extracted.valueEgp))}${row('المدفوعات الفعلية', egp(m.payments.actualEgp))}${row('الرصيد المسمع المؤكد', egp(m.credited.valueEgp), 'g')}${row('الأكواد المسمعة', `${num(b.credited.count)} كود (${pct(b.credited.pct)})`, 'g')}${row('الأكواد المعلقة', `${num(b.pending.count)} كود (${pct(b.pending.pct)})`, 'o')}${row('غير المدفوعة', `${num(b.unpaid.count)} كود (${pct(b.unpaid.pct)})`, 'r')}</div>`;
}
function chartSvg(series, { key = 'paidEgp', h = 210, wide = false, W: forceW = 0 } = {}) {
  const max = Math.max(1, ...series.map((s) => s[key])); const step = (() => { const raw = max / 4; const mag = 10 ** Math.floor(Math.log10(raw)); const n = raw / mag; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag; })();
  const top = Math.ceil(max / step) * step || step; const W = forceW || (wide ? Math.max(900, series.length * 46 + 80) : 440); const L = 46; const B = 26; const T = 14; const ph = h - B - T; const pw = W - L - 6; const bw = Math.max(6, Math.min(46, pw / series.length - 14));
  const grid = []; for (let v = 0; v <= top + 1; v += step) { const y = T + ph - (v / top) * ph; grid.push(`<line x1="${L}" x2="${W - 6}" y1="${y}" y2="${y}" stroke="#ece8fb" stroke-dasharray="3 4"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="#8b87a8">${kfmt(v)}</text>`); }
  const bars = series.map((s, i) => { const cx = L + (pw / series.length) * (i + 0.5); const bh = (s[key] / top) * ph; const y = T + ph - bh; return `<rect x="${cx - bw / 2}" y="${y}" width="${bw}" height="${Math.max(bh, s[key] > 0 ? 2 : 0)}" rx="6" fill="url(#fpBar)"><title>${E(s.label)}: ${num(s[key], 2)} ج</title></rect>${s[key] > 0 && pw / series.length > 30 ? `<text x="${cx}" y="${y - 5}" text-anchor="middle" font-size="11" font-weight="800" fill="#1e1b4b">${kfmt(s[key])}</text>` : ''}<text x="${cx}" y="${h - 8}" text-anchor="middle" font-size="10.5" fill="#6b6788">${E(s.label)}</text>`; }).join('');
  return `<svg class="fp-chart" viewBox="0 0 ${W} ${h}" preserveAspectRatio="xMidYMid meet" style="direction:ltr"><defs><linearGradient id="fpBar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#c4b5fd"/></linearGradient></defs>${grid.join('')}${bars}</svg>`;
}
function chartHtml(o) { return `<div class="fp-card"><div class="fp-ch"><h3>${ic('doc')}حركة المدفوعات خلال الشهر</h3></div>${o.series.some((s) => s.paidEgp > 0) ? chartSvg(o.series, { W: 330, h: 250 }) : '<div class="fp-empty sm">مفيش مدفوعات في الشهر ده لسه.</div>'}</div>`; }
const SEV_ICON = { CRITICAL: 'warn', WARNING: 'clock', INFO: 'bell' };
function alertsHtml(o) {
  return `<div class="fp-card fp-alerts"><div class="fp-ch"><h3>التنبيهات المهمة ${ic('bell')}</h3>${o.alertsTotal > o.alerts.length ? `<span class="fp-dim">+${o.alertsTotal - o.alerts.length} تنبيه</span>` : ''}</div>
    ${o.alerts.length ? o.alerts.slice(0, 5).map((a, i) => `<button class="fp-alert ${a.severity}" data-act="alert" data-i="${i}">${ic(SEV_ICON[a.severity] || 'bell')}<span><b>${E(a.title)}</b><br>${E(a.message)}</span></button>`).join('') : '<div class="fp-empty sm ok">✔ مفيش تنبيهات دلوقتي.</div>'}</div>`;
}
function renderOverview(body) {
  const o = P.ov;
  body.innerHTML = `${kpiHtml(o)}
  <div class="fp-body">
    <div class="fp-col-r">${fawryPanelHtml()}${lastCodesHtml(o)}${bulkCardHtml()}</div>
    <div class="fp-col-l">
      <div class="fp-main">${logTableHtml(o)}${accountsListHtml(o)}</div>
      <div class="fp-bottom">${alertsHtml(o)}${chartHtml(o)}${monthHtml(o)}</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------
const H = {
  tab: (t) => showTab(t.dataset.k),
  kpi: (t) => { const b = t.dataset.bucket; const p = P.ov.period; P.logQ = { ...P.logQ, bucket: b === 'paid' ? '' : b, status: '', q: '', offset: 0, from: p.from, to: p.to, dateField: b === 'paid' ? 'paid' : 'extracted', account: P.account || '' }; P.log = null; showTab('log'); },
  amt: (t) => { if (t.dataset.v === 'custom') { P.custom = true; P.amount = null; } else { P.custom = false; P.amount = Number(t.dataset.v); } refreshFawry(); },
  copy: (t) => copyText(t.dataset.v),
  code: (t) => openCode(t.dataset.id),
  pay: (t) => openPay(t.dataset.id),
  account: (t) => { P.tab = 'accounts'; showTab('accounts').then(() => openAccount(t.dataset.id)); },
  newCode: () => { openExtractModal(); },
  extractNow: (t) => extractNow(t),
  registerCode: () => openRegister(),
  bulkExtract: () => openBulkExtract(),
  bulkPay: () => openBulkPay(),
  openBatch: (t) => openBatchView(t.dataset.id),
  alert: (t) => { const a = P.ov.alerts[Number(t.dataset.i)]; if (!a) return; if (a.target.type === 'code') openCode(a.target.id); else if (a.target.type === 'account') { showTab('accounts').then(() => openAccount(a.target.id)); } else if (a.target.type === 'tab') showTab(a.target.id); },
  applyRange: () => { const f = document.getElementById('fpFrom').value; const t = document.getElementById('fpTo').value; if (!f || !t) return P.toast('اختار التاريخين.', 'error'); P.period.from = f; P.period.to = t; P.log = null; P.report = null; showTab(P.tab); },
  charge: (t) => { P.xAccount = t.dataset.id; openExtractModal(); },
  logPage: (t) => { P.logQ.offset = Math.max(0, P.logQ.offset + Number(t.dataset.d) * 100); loadLog().then(renderBody); },
  logReset: () => { P.logQ = { q: '', status: '', account: P.account || '', user: '', method: '', bucket: '', from: '', to: '', dateField: 'extracted', offset: 0 }; P.log = null; showTab('log'); },
  exportXlsx: () => { const q = new URLSearchParams(periodQs()).toString(); window.location.href = `${API}/report.xlsx?${q}`; },
  runMonitor: (t) => lockBtn(t, async () => { const r = await call(() => api.post(`${API}/monitor/run`, {})); P.toast(`تمت المتابعة — انتهت: ${r.expired || 0} · مطابقة: ${r.reconciled || 0} · تسميع: ${r.credited || 0}`, 'success'); P.settings = await api.get(`${API}/settings`); renderBody(); }),
};
async function onClick(e) { const t = e.target.closest('[data-act]'); if (!t || t.disabled) return; const h = H[t.dataset.act]; if (!h) return; e.preventDefault?.(); try { await h(t); } catch { /* already toasted */ } }
let searchTimer = null;
function onInput(e) {
  if (e.target.id === 'fpOvSearch') { P.ovSearch = e.target.value; const tb = document.getElementById('fpOvRows'); if (tb) tb.innerHTML = logRowsHtml(filterOv(P.ov.log)) || ''; }
  if (e.target.id === 'fpCustom' || e.target.id === 'fpCustomM') { P.amount = Number(e.target.value) || null; }
  if (e.target.id === 'fpLogQ') { clearTimeout(searchTimer); searchTimer = setTimeout(() => { P.logQ.q = e.target.value; P.logQ.offset = 0; loadLog().then(() => { renderBody(); const i = document.getElementById('fpLogQ'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }); }, 350); }
}
function onChange(e) {
  const id = e.target.id;
  if (id === 'fpXAcct' || id === 'fpXAcctM') P.xAccount = e.target.value;
  const m = /^fpLog_(.+)$/.exec(id || ''); if (m) { P.logQ[m[1]] = e.target.value; P.logQ.offset = 0; if (m[1] === 'bucket' && e.target.value) P.logQ.status = ''; if (m[1] === 'status' && e.target.value) P.logQ.bucket = ''; loadLog().then(renderBody); }
  if (id === 'fpGran') { P.gran = e.target.value; showTab('reports'); }
  if (id === 'fpCloseKind') { P.closeKind = e.target.value; showTab('reports'); }
}
function refreshFawry() { for (const [id, mm] of [['fpFawry', false], ['fpFawryM', true]]) { const el = document.getElementById(id); if (!el) continue; const tmp = document.createElement('div'); tmp.innerHTML = fawryPanelHtml({ modalMode: mm }); el.replaceWith(tmp.firstElementChild); } }

// ---- extraction
async function extractNow(btn, { acknowledge = false } = {}) {
  const amount = Number(P.amount); if (!P.xAccount) return P.toast('اختار الحساب الإعلاني.', 'error'); if (!amount) return P.toast('اكتب المبلغ.', 'error');
  await lockBtn(btn, async () => {
    try {
      const r = await api.post(`${API}/extract`, { accountId: P.xAccount, amountEgp: amount, requestId: P.xrid, acknowledgeExisting: acknowledge });
      P.lastExtract = r; P.xrid = rid(); P.toast(r.code ? 'اتطلّع الكود وانحفظ ✔' : r.job?.status === 'UNCERTAIN' ? 'النتيجة غير مؤكدة — راجع قبل أي محاولة جديدة.' : 'فشل الاستخراج.', r.code ? 'success' : 'error');
      await loadOverview(); renderHead(); if (P.tab === 'overview') renderBody(); else if (P.tab === 'extract') { await loadBatches(); renderBody(); }
      refreshFawry();
    } catch (err) {
      if (err.code === 'EXISTING_OPEN_CODES' || err.code === 'DUPLICATE_RECENT') {
        const w = err.details?.warnings || {}; const list = (w.open || []).map((c) => `<div class="fp-lrow static"><span class="lc">${E(c.code)}</span><span class="lv">${num(c.amountEgp)} ج</span>${pill(c.status)}</div>`).join('');
        const go = await confirmBox({ title: '⚠️ فيه كود سابق لنفس الحساب', body: `<p>${err.code === 'DUPLICATE_RECENT' ? 'اتطلب كود بنفس المبلغ لنفس الحساب من لحظات — ممكن يكون ضغطة مكررة.' : 'الحساب ده عليه كود لسه غير مدفوع أو متعلق:'}</p><div class="fp-last">${list}</div><p class="fp-dim">استخراج كود جديد هيعمل كود تاني فعلي. متأكد؟</p>`, ok: 'استخراج كود جديد رغم كده', danger: true });
        if (go) return extractNow(btn, { acknowledge: true });
      } else if (err.code === 'NEEDS_CONNECTION') { P.toast('الاستخراج الآلي محتاج ربط — استخدم «تسجيل كود».', 'error'); loadOverview().then(() => { renderHead(); refreshFawry(); }); }
      else P.toast(err.message || 'حصل خطأ.', 'error');
    }
  });
}
function openExtractModal() {
  const m = modal(`<div class="fp-mh"><h3>استخراج كود جديد</h3><button class="fp-x" data-close>${ic('x')}</button></div><div class="fp-mb" id="fpModalFawry">${fawryPanelHtml({ modalMode: true })}</div>`, { cls: 'fp-modal-fawry' });
  m.el.onclick = async (e) => { const t = e.target.closest('[data-act]'); if (!t || t.disabled) return; if (t.dataset.act === 'registerCode') { m.close(); return openRegister(); } if (['amt', 'copy', 'extractNow'].includes(t.dataset.act)) { try { await H[t.dataset.act](t); } catch { /* toasted */ } } };
  m.el.oninput = (e) => onInput(e); m.el.onchange = (e) => onChange(e);
}
function openRegister() {
  const accs = (P.ov?.accounts || []).filter((a) => !a.removed);
  const link = P.xAccount ? `https://adsmanager.facebook.com/ads/manager/account_settings/account_billing/?act=${E(P.xAccount.replace('act_', ''))}` : 'https://adsmanager.facebook.com';
  const m = modal(`<div class="fp-mh"><h3>تسجيل كود فوري (من Ads Manager)</h3><button class="fp-x" data-close>${ic('x')}</button></div><div class="fp-mb">
    <p class="fp-dim">اطلب الكود من Ads Manager ← الفوترة ← «إضافة أموال» ← فوري، وبعدين سجّله هنا. السيستم بيمنع تسجيل نفس الكود مرتين، وبيتابع حالته ويسجّل كل خطوة. <a href="${link}" target="_blank" rel="noopener">فتح فوترة الحساب ↗</a></p>
    <div class="fp-form"><label>الحساب الإعلاني<select id="rgAcct">${accs.map((a) => `<option value="${E(a.id)}" ${P.xAccount === a.id ? 'selected' : ''}>${E(a.name)}</option>`).join('')}</select></label>
    <label>رقم كود فوري<input id="rgCode" inputmode="numeric" placeholder="مثال: 1234567890" autocomplete="off"></label>
    <label>المبلغ (ج)<input id="rgAmt" type="number" min="1" step="0.01" value="${P.amount && !P.custom ? P.amount : ''}"></label>
    <label>تاريخ ووقت انتهاء الصلاحية (لو ظاهر)<input id="rgExp" type="datetime-local"></label>
    <label class="full">ملاحظة (اختياري)<input id="rgNote" maxlength="200"></label></div></div>
    <div class="fp-mf"><button class="fp-btn ghost" data-close>إلغاء</button><button class="fp-btn primary" id="rgSave">حفظ الكود</button></div>`);
  const save = async (ack = false) => { const exp = m.$('#rgExp').value; const body = { accountId: m.$('#rgAcct').value, amountEgp: Number(m.$('#rgAmt').value), code: m.$('#rgCode').value, expiresAt: exp ? new Date(exp).toISOString() : null, note: m.$('#rgNote').value, acknowledgeExisting: ack };
    try { const r = await api.post(`${API}/register`, body); P.lastExtract = { code: r.code, manual: true }; P.toast('اتسجّل الكود ✔', 'success'); m.close(); await loadOverview(); renderHead(); renderBody(); }
    catch (err) { if (err.code === 'EXISTING_OPEN_CODES') { if (await confirmBox({ title: '⚠️ فيه كود سابق لنفس الحساب', body: '<p>الحساب ده عليه كود لسه غير مدفوع أو متعلق. تسجّل الكود الجديد برضه؟</p>', ok: 'سجّل برضه', danger: true })) return save(true); } else P.toast(err.message, 'error'); } };
  m.$('#rgSave').onclick = (e) => lockBtn(e.currentTarget, () => save());
}

// ---- code details drawer
async function openCode(id) {
  let d; try { d = await api.get(`${API}/codes/${id}`); } catch (e) { return P.toast(e.message, 'error'); }
  const c = d.row; const evLabel = { EXTRACTED: 'اتطلّع الكود', REGISTERED_MANUALLY: 'تسجيل يدوي', PAY_STARTED: 'بدأ الدفع', PAID: 'تم الدفع', PAY_FAILED: 'فشل الدفع', PAY_UNCERTAIN: 'دفع غير مؤكد', RECONCILED_PAID: 'مطابقة: مدفوع', RECONCILED_NOT_PAID: 'مطابقة: غير مدفوع', CREDITED: 'تم التسميع', EXPIRED: 'انتهت الصلاحية', CANCELLED: 'اتلغى', AMOUNT_MISMATCH: 'اختلاف مبلغ', DUP_PAY_BLOCKED: 'دفع مكرر اتمنع', FLAGGED_REVIEW: 'للمراجعة', PAY_INTERRUPTED: 'انقطاع أثناء الدفع', ATTACHED_TO_JOB: 'ربط بعملية' };
  const kv = (l, v) => `<div class="kv"><span>${l}</span><b>${v}</b></div>`;
  const payable = ['UNPAID', 'PAY_FAILED'].includes(c.status);
  const m = modal(`<div class="fp-mh"><h3>كود ${E(c.code)} ${pill(c.status)}</h3><button class="fp-x" data-close>${ic('x')}</button></div><div class="fp-mb">
    ${c.reason && c.status === 'REVIEW' ? `<div class="fp-banner warn">${ic('warn')}<div>${c.reason === 'AMOUNT_MISMATCH' ? 'مبلغ الدفع مختلف عن قيمة الكود — راجع العملية.' : 'الكود متعلّم للمراجعة.'}</div></div>` : ''}
    ${c.status === 'UNCERTAIN' ? `<div class="fp-banner warn">${ic('warn')}<div><b>نتيجة الدفع غير مؤكدة.</b> ممكن الخصم حصل. ممنوع تدفع تاني قبل المطابقة.</div></div>` : ''}
    ${c.creditHint ? `<div class="fp-banner info">${ic('bell')}<div>الرصيد زاد ${egp(c.creditHint.deltaEgp)} بعد الدفع — ده <b>دليل مساعد فقط</b> (الإنفاق بيحرّك الرصيد كمان)، مش تأكيد تسميع.</div></div>` : ''}
    <div class="fp-kvs">${kv('الحساب الإعلاني', E(c.accountName))}${kv('المبلغ', egp(c.amountEgp))}${kv('المصدر', E(c.sourceLabel))}${kv('وقت الاستخراج', fmtFull(c.extractedAt))}${kv('استخرجه', E(c.extractedBy || '—'))}${kv('انتهاء الصلاحية', c.expiresAt ? fmtFull(c.expiresAt) : 'غير متاح')}
    ${kv('وقت الدفع', fmtFull(c.paidAt))}${kv('الموظف المسؤول', E(c.paidBy || '—'))}${kv('وسيلة الدفع', E(c.methodLabel || '—'))}${kv('رقم العملية', `<span class="mono">${E(c.txnRef || '—')}</span>`)}${kv('رسوم الدفع', c.feeEgp == null ? '—' : egp(c.feeEgp))}${kv('إجمالي المخصوم', c.totalEgp == null ? '—' : egp(c.totalEgp))}${kv('الإيصال', c.receipt ? E(c.receipt.number || c.receipt.note || '—') : '—')}
    ${kv('وقت التسميع', fmtFull(c.creditedAt))}${kv('مصدر تأكيد التسميع', E(c.creditSource || '—'))}${kv('مدة الاستخراج → الدفع', fmtDur(c.minutesToPay))}${kv('مدة الدفع → التسميع', fmtDur(c.minutesToCredit))}${kv('آخر تحقق', c.lastCheckedAt ? fmtFull(c.lastCheckedAt) : '—')}${c.creditEvidence ? kv('دليل التسميع', E(c.creditEvidence)) : ''}</div>
    <h4>سجل الأحداث</h4><div class="fp-events">${(d.events || []).slice().reverse().map((e) => `<div class="ev"><span class="et">${fmtFull(e.at)}</span><b>${E(evLabel[e.type] || e.type)}</b>${e.by?.name ? ` <span class="fp-dim">— ${E(e.by.name)}</span>` : ''}${e.note ? `<div class="fp-dim">${E(e.note)}</div>` : ''}</div>`).join('') || '<div class="fp-dim">—</div>'}</div></div>
    <div class="fp-mf wrap"><button class="fp-btn ghost" data-copy>${ic('copy')}نسخ الكود</button>
    ${payable && can('pay') ? '<button class="fp-btn primary" data-do="pay">ادفع الآن</button>' : ''}
    ${['UNCERTAIN', 'PAYING'].includes(c.status) && can('pay') ? '<button class="fp-btn primary" data-do="reconcile">مطابقة الدفع</button>' : ''}
    ${['PAID', 'REVIEW'].includes(c.status) && c.paidAt ? '<button class="fp-btn primary" data-do="credit">تأكيد التسميع</button>' : ''}
    ${payable ? '<button class="fp-btn ghost" data-do="cancel">إلغاء الكود</button>' : ''}
    ${!['CREDITED', 'EXPIRED', 'PAYING'].includes(c.status) ? '<button class="fp-btn ghost" data-do="review">تعليم للمراجعة</button>' : ''}</div>`, { wide: true });
  m.$('[data-copy]').onclick = () => copyText(c.code);
  m.$$('[data-do]').forEach((b) => { b.onclick = async () => { const k = b.dataset.do; if (k === 'pay') { m.close(); return openPay(id); } m.close(); if (k === 'reconcile') return openReconcile(c); if (k === 'credit') return openCredit(c); if (k === 'cancel') { if (await confirmBox({ title: 'إلغاء الكود', body: `<p>هتلغي الكود ${E(c.code)} (${egp(c.amountEgp)})؟ هيتحول «منتهي».</p>`, ok: 'إلغاء الكود', danger: true })) { await call(() => api.post(`${API}/codes/${id}/cancel`, { note: 'إلغاء يدوي' })); afterChange(); } } if (k === 'review') { openNote('تعليم للمراجعة', 'سبب المراجعة', async (note) => { await api.post(`${API}/codes/${id}/review`, { note }); afterChange(); }); } }; });
}
async function afterChange() { try { await loadOverview(); } catch { /* ignore */ } renderHead(); if (P.tab === 'log') { await loadLog().catch(() => {}); } if (P.tab === 'accounts') { P.accountsTab = await api.get(`${API}/accounts`, periodQs()).catch(() => P.accountsTab); } renderBody(); }
function openNote(title, label, onSave, { area = false, ok = 'حفظ' } = {}) {
  const m = modal(`<div class="fp-mh"><h3>${E(title)}</h3><button class="fp-x" data-close>${ic('x')}</button></div><div class="fp-mb"><div class="fp-form one"><label class="full">${E(label)}${area ? '<textarea id="ntTxt" rows="3"></textarea>' : '<input id="ntTxt">'}</label></div></div><div class="fp-mf"><button class="fp-btn ghost" data-close>إلغاء</button><button class="fp-btn primary" id="ntSave">${E(ok)}</button></div>`);
  m.$('#ntSave').onclick = (e) => lockBtn(e.currentTarget, async () => { try { await onSave(m.$('#ntTxt').value); m.close(); } catch (err) { P.toast(err.message, 'error'); } });
}
function openCredit(c) {
  const m = modal(`<div class="fp-mh"><h3>تأكيد تسميع الكود ${E(c.code)}</h3><button class="fp-x" data-close>${ic('x')}</button></div><div class="fp-mb"><p class="fp-dim">التسميع مش بيتأكد من زيادة الرصيد وحدها. افتح Ads Manager ← الفوترة ← المعاملات، وتأكد إن مبلغ <b>${egp(c.amountEgp)}</b> اتضاف، واكتب الدليل (رقم المعاملة / التاريخ). التأكيد بيتسجّل باسمك.</p><div class="fp-form one"><label class="full">الدليل<input id="crEv" placeholder="مثال: معاملة Meta رقم … بتاريخ …"></label><label>وقت التسميع (اختياري)<input id="crAt" type="datetime-local"></label></div></div><div class="fp-mf"><button class="fp-btn ghost" data-close>إلغاء</button><button class="fp-btn primary" id="crOk">تأكيد التسميع</button></div>`);
  m.$('#crOk').onclick = (e) => lockBtn(e.currentTarget, async () => { try { const at = m.$('#crAt').value; await api.post(`${API}/codes/${c.id}/credit`, { evidence: m.$('#crEv').value, at: at ? new Date(at).toISOString() : null }); P.toast('اتأكد التسميع ✔', 'success'); m.close(); afterChange(); } catch (err) { P.toast(err.message, 'error'); } });
}
function openReconcile(c) {
  const m = modal(`<div class="fp-mh"><h3>مطابقة دفع غير مؤكد — ${E(c.code)}</h3><button class="fp-x" data-close>${ic('x')}</button></div><div class="fp-mb"><div class="fp-banner warn">${ic('warn')}<div>ممنوع تعيد الدفع قبل ما نعرف إن الخصم حصل ولا لأ. السيستم هيسأل المصدر الأول؛ لو مقدرش، سجّل القرار بدليل من كشف الحساب.</div></div>
    <div class="fp-form"><label class="full">القرار<select id="rcRes"><option value="">اسأل المصدر الرسمي</option><option value="PAID">اتخصم فعلًا (مدفوع)</option><option value="NOT_PAID">ماتخصمش (غير مدفوع)</option></select></label><label>رقم العملية (لو مدفوع)<input id="rcTxn"></label><label>رقم الإيصال<input id="rcRec"></label><label class="full">الدليل<input id="rcEv" placeholder="مثال: ظاهر في كشف المحفظة بتاريخ …"></label></div></div><div class="fp-mf"><button class="fp-btn ghost" data-close>إلغاء</button><button class="fp-btn primary" id="rcOk">تنفيذ المطابقة</button></div>`);
  m.$('#rcOk').onclick = (e) => lockBtn(e.currentTarget, async () => { try { await api.post(`${API}/codes/${c.id}/reconcile`, { resolution: m.$('#rcRes').value || null, txnRef: m.$('#rcTxn').value, receiptRef: m.$('#rcRec').value, evidence: m.$('#rcEv').value }); P.toast('تمت المطابقة ✔', 'success'); m.close(); afterChange(); } catch (err) { P.toast(err.message, 'error'); } });
}

// ---- pay modal (direct when connected, manual record otherwise)
async function openPay(id, methodId = null) {
  let methods = P.ov?.methods; if (!methods) { try { methods = (await api.get(`${API}/status`)).methods; } catch { methods = []; } }
  if (!methods.length) { return confirmBox({ title: 'مفيش وسيلة دفع', body: '<p>أضف وسيلة دفع (محفظة / فوري / كارت) من تبويب «الدفع والمحافظ» الأول.</p>', ok: 'حاضر', cancel: 'إلغاء' }).then(() => showTab('wallets')); }
  const mid = methodId || methods[0].id; let q; try { q = await api.post(`${API}/codes/${id}/quote`, { methodId: mid }); } catch (e) { return P.toast(e.message, 'error'); }
  const direct = q.directPay; const pr = P.requestPayId = rid();
  const m = modal(`<div class="fp-mh"><h3>دفع كود فوري</h3><button class="fp-x" data-close>${ic('x')}</button></div><div class="fp-mb">
    <div class="fp-kvs one"><div class="kv"><span>الحساب الإعلاني</span><b>${E(q.code.accountName)}</b></div><div class="kv"><span>رقم كود فوري</span><b class="mono">${E(q.code.code)}</b></div><div class="kv"><span>قيمة الكود</span><b>${egp(q.amountEgp)}</b></div></div>
    <label class="fp-lab">وسيلة الدفع / المحفظة</label><div class="fp-sel wide"><select id="pyMethod">${methods.map((x) => `<option value="${x.id}" ${x.id === mid ? 'selected' : ''}>${E(x.label)}${x.balanceEgp != null ? ` — رصيد ${num(x.balanceEgp)} ج` : ''}</option>`).join('')}</select><span class="fp-sel-dd">${ic('down')}</span></div>
    <div class="fp-kvs one"><div class="kv"><span>الرصيد المتاح</span><b>${q.method.balanceEgp == null ? 'غير متاح' : egp(q.method.balanceEgp) + (q.method.balanceSource === 'MANUAL' ? ' <small>(يدوي)</small>' : '')}</b></div><div class="kv"><span>رسوم الدفع</span><b>${egp(q.feeEgp)} <small>(حسب إعدادات الوسيلة)</small></b></div><div class="kv total"><span>إجمالي المبلغ المطلوب خصمه</span><b>${egp(q.totalEgp)}</b></div></div>
    ${q.sufficient === false ? `<div class="fp-banner warn">${ic('warn')}<div>رصيد الوسيلة مش كافي للدفع.</div></div>` : ''}
    ${!q.payable ? `<div class="fp-banner warn">${ic('warn')}<div>الكود مش قابل للدفع في حالته الحالية (${E(q.code.statusLabel)}).</div></div>` : ''}
    ${direct ? '' : `<div class="fp-banner warn">${ic('link')}<div><b>الدفع المباشر «تحتاج ربط»</b> — ${E(q.provider.reason || '')}<br><b>المسار الحالي:</b> ادفع الكود من فوري/محفظتك، وبعدين سجّل العملية هنا:</div></div>
    <div class="fp-form"><label>رقم العملية (حقيقي)<input id="pyTxn" placeholder="رقم المعاملة من إيصال الدفع"></label><label>رقم/وصف الإيصال<input id="pyRec"></label><label>وقت الدفع<input id="pyAt" type="datetime-local"></label><label>الرسوم الفعلية (ج)<input id="pyFee" type="number" min="0" step="0.01" value="${q.feeEgp}"></label></div>`}
    ${q.provider.mode === 'SIMULATION' ? `<div class="fp-banner sim">${ic('shield')}دفع محاكاة — مفيش خصم حقيقي.</div>` : ''}</div>
    <div class="fp-mf"><button class="fp-btn ghost" data-close>إلغاء</button><button class="fp-btn primary" id="pyOk" ${q.payable && q.sufficient !== false ? '' : 'disabled'}>${direct ? 'تأكيد الدفع' : 'تسجيل الدفع'}</button></div>`);
  m.$('#pyMethod').onchange = (e) => { m.close(); openPay(id, e.target.value); };
  m.$('#pyOk').onclick = (e) => lockBtn(e.currentTarget, async () => {
    try {
      const r = direct ? await api.post(`${API}/codes/${id}/pay`, { methodId: m.$('#pyMethod').value, requestId: pr, confirm: true, expectedTotalEgp: q.totalEgp })
        : await api.post(`${API}/codes/${id}/manual-payment`, { methodId: m.$('#pyMethod').value, requestId: pr, txnRef: m.$('#pyTxn').value, receiptRef: m.$('#pyRec').value, paidAt: m.$('#pyAt').value ? new Date(m.$('#pyAt').value).toISOString() : null, feeEgp: m.$('#pyFee').value });
      const st = r.code.status; P.toast(st === 'PAID' ? 'تم الدفع وانحفظ ✔ — متابعة التسميع شغالة' : st === 'UNCERTAIN' ? 'نتيجة الدفع غير مؤكدة — طابقها قبل أي محاولة.' : st === 'PAY_FAILED' ? 'فشل الدفع: ' + (r.code.reason || '') : st === 'REVIEW' ? 'اتدفع لكن المبلغ مختلف — يحتاج مراجعة.' : 'تم.', st === 'PAID' ? 'success' : 'error'); m.close(); afterChange();
    } catch (err) { if (err.code === 'QUOTE_CHANGED') { P.toast('الإجمالي اتغيّر — راجع وأكّد تاني.', 'error'); m.close(); return openPay(id, m.$('#pyMethod').value); } P.toast(err.message, 'error'); if (['ALREADY_PAID', 'ALREADY_PAYING', 'UNCERTAIN_BLOCKS_RETRY', 'EXPIRED', 'NOT_PAYABLE'].includes(err.code)) { m.close(); afterChange(); } }
  });
}

// ---- bulk extract
async function openBulkExtract() {
  const accs = (P.ov?.accounts || []).filter((a) => !a.removed); const amounts = P.status?.quickAmounts || [1000, 2000, 3000, 5000, 10000];
  const m = modal(`<div class="fp-mh"><h3>استخراج أكواد جماعي</h3><button class="fp-x" data-close>${ic('x')}</button></div><div class="fp-mb" id="bxBody">
    ${providers()?.extract?.available ? '' : `<div class="fp-banner warn">${ic('link')}<div><b>الاستخراج الآلي «تحتاج ربط»</b> — ${E(providers()?.extract?.reason || '')}</div></div>`}
    <p class="fp-dim">علّم الحسابات وحدد مبلغ لكل حساب. هتشوف المعاينة قبل أي تنفيذ، والتنفيذ بيتم بالتتابع حسب حدود المزود.</p>
    <table class="fp-table sm"><tbody>${accs.map((a) => `<tr><td><input type="checkbox" class="bxChk" value="${E(a.id)}"></td><td>${META} ${E(a.name)}</td><td><select class="bxAmt">${amounts.map((x) => `<option value="${x}">${num(x)} ج</option>`).join('')}<option value="custom">مخصص…</option></select> <input type="number" class="bxCust" min="1" step="0.01" style="display:none;width:90px"></td></tr>`).join('')}</tbody></table></div>
    <div class="fp-mf"><button class="fp-btn ghost" data-close>إغلاق</button><button class="fp-btn primary" id="bxPrev">معاينة</button></div>`, { wide: true });
  m.$$('.bxAmt').forEach((s) => { s.onchange = () => { const c = s.parentElement.querySelector('.bxCust'); c.style.display = s.value === 'custom' ? '' : 'none'; }; });
  const items = () => m.$$('.bxChk').filter((c) => c.checked).map((c) => { const tr = c.closest('tr'); const s = tr.querySelector('.bxAmt'); return { accountId: c.value, amountEgp: Number(s.value === 'custom' ? tr.querySelector('.bxCust').value : s.value) }; });
  m.$('#bxPrev').onclick = (e) => lockBtn(e.currentTarget, async () => {
    const its = items(); if (!its.length) return P.toast('علّم حساب واحد على الأقل.', 'error');
    try {
      const pv = await api.post(`${API}/bulk-extract/preview`, { items: its });
      m.$('#bxBody').innerHTML = `<div class="fp-kvs one"><div class="kv"><span>عدد الأكواد المطلوبة</span><b>${pv.count}</b></div><div class="kv total"><span>الإجمالي</span><b>${egp(pv.totalEgp)}</b></div></div><table class="fp-table sm"><thead><tr><th>الحساب</th><th>المبلغ</th><th>تحذير</th></tr></thead><tbody>${pv.items.map((i) => `<tr><td>${E(i.accountName)}</td><td>${egp(i.amountEgp)}</td><td>${i.openCodes.length ? `<span class="fp-chip orange">عليه ${i.openCodes.length} كود متعلق</span>` : '—'}</td></tr>`).join('')}</tbody></table>${pv.warnings ? '<div class="fp-banner warn">فيه حسابات عليها أكواد متعلقة — التنفيذ هيطلب موافقتك عليها.</div>' : ''}${pv.provider.available ? '' : `<div class="fp-banner warn">${ic('link')}<div>التنفيذ الآلي «تحتاج ربط».</div></div>`}`;
      const go = m.$('#bxPrev'); go.textContent = 'تنفيذ الاستخراج'; go.disabled = !pv.provider.available; go.onclick = (ev) => lockBtn(ev.currentTarget, async () => { try { const b = await api.post(`${API}/bulk-extract`, { items: its, requestId: rid(), acknowledgeExisting: pv.warnings > 0 }); m.close(); openBatchView(b.id); } catch (err) { P.toast(err.message, 'error'); } });
    } catch (err) { P.toast(err.message, 'error'); }
  });
}
async function openBatchView(id) {
  const m = modal(`<div class="fp-mh"><h3>متابعة الدفعة</h3><button class="fp-x" data-close>${ic('x')}</button></div><div class="fp-mb" id="btBody"><div class="fp-loading">…</div></div><div class="fp-mf wrap" id="btFoot"><button class="fp-btn ghost" data-close>إغلاق</button></div>`, { wide: true });
  let stop = false;
  const lbl = { PENDING: 'في الانتظار', EXTRACTING: 'جاري الاستخراج', PAYING: 'جاري الدفع', DONE: 'تم استخراج الكود', PAID: 'تم الدفع', FAILED: 'فشل', UNCERTAIN: 'نتيجة غير مؤكدة', SKIPPED: 'اتخطّى' }; const cls = { PENDING: 'gray', EXTRACTING: 'orange', PAYING: 'orange', DONE: 'green', PAID: 'green', FAILED: 'red', UNCERTAIN: 'orange', SKIPPED: 'gray' };
  const draw = async () => {
    if (stop || !document.body.contains(m.el)) return; let b; try { b = await api.get(`${API}/batches/${id}`); } catch { return; }
    const isPay = b.type === 'PAY'; const items = b.items || [];
    m.$('#btBody').innerHTML = `<div class="fp-kvs one"><div class="kv"><span>النوع</span><b>${isPay ? 'دفع جماعي' : 'استخراج جماعي'}</b></div><div class="kv"><span>الحالة</span><b>${{ RUNNING: 'شغال…', DONE: 'خلص', STOPPED_UNCERTAIN: 'وقف — نتيجة غير مؤكدة', STOPPED: 'متوقف', INTERRUPTED: 'اتقطع (إعادة تشغيل)' }[b.status] || b.status}</b></div></div>
    <table class="fp-table sm"><thead><tr><th>${isPay ? 'الكود' : 'الحساب'}</th><th>المبلغ</th><th>الحالة</th><th>تفاصيل</th></tr></thead><tbody>${items.map((i) => `<tr><td>${E(isPay ? `${i.code} — ${i.accountName}` : i.accountName)}</td><td>${egp(i.amountEgp)}</td><td><span class="fp-pill ${cls[i.status] || 'gray'}">${E(lbl[i.status] || i.status)}</span></td><td>${E(i.error || i.txnRef || '')}${!isPay && i.status === 'UNCERTAIN' ? ` <button class="fp-btn sm ghost" data-resolve="${i.jobId}">حلّها</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
    m.$$('[data-resolve]').forEach((bt) => { bt.onclick = () => openResolveJob(bt.dataset.resolve); });
    m.$('#btFoot').innerHTML = `<button class="fp-btn ghost" data-close>إغلاق</button>${['INTERRUPTED', 'STOPPED'].includes(b.status) ? '<button class="fp-btn primary" id="btResume">متابعة الباقي</button>' : ''}`;
    m.$$('[data-close]').forEach((x) => { x.onclick = m.close; }); const rs = m.$('#btResume'); if (rs) rs.onclick = () => lockBtn(rs, async () => { try { await api.post(`${API}/batches/${id}/resume`, {}); draw(); } catch (err) { P.toast(err.message, 'error'); } });
    if (b.status === 'RUNNING') setTimeout(draw, 1500); else { afterChange(); }
  };
  draw(); const iv = setInterval(() => { if (!document.body.contains(m.el)) { stop = true; clearInterval(iv); } }, 800);
}
function openResolveJob(jobId) {
  const m = modal(`<div class="fp-mh"><h3>حل عملية استخراج غير مؤكدة</h3><button class="fp-x" data-close>${ic('x')}</button></div><div class="fp-mb"><p class="fp-dim">افتح Ads Manager وشوف هل الكود اتطلّع فعلًا. لو اتطلّع، اربطه هنا؛ لو لأ، أكّد إنه ماتطلعش.</p><div class="fp-form"><label class="full">الإجراء<select id="rjRes"><option value="ATTACH_CODE">الكود اتطلّع — اربطه</option><option value="NOT_ISSUED">الكود ماتطلعش</option></select></label><label>رقم الكود<input id="rjCode"></label><label>انتهاء الصلاحية<input id="rjExp" type="datetime-local"></label><label class="full">ملاحظة / دليل<input id="rjNote"></label></div></div><div class="fp-mf"><button class="fp-btn ghost" data-close>إلغاء</button><button class="fp-btn primary" id="rjOk">تنفيذ</button></div>`);
  m.$('#rjOk').onclick = (e) => lockBtn(e.currentTarget, async () => { try { const exp = m.$('#rjExp').value; await api.post(`${API}/jobs/${jobId}/resolve`, { resolution: m.$('#rjRes').value, code: m.$('#rjCode').value, expiresAt: exp ? new Date(exp).toISOString() : null, note: m.$('#rjNote').value }); P.toast('تم ✔', 'success'); m.close(); afterChange(); } catch (err) { P.toast(err.message, 'error'); } });
}

// ---- bulk pay
async function openBulkPay() {
  let all; try { all = await api.get(`${API}/codes`, { bucket: 'unpaid', limit: 200 }); } catch (e) { return P.toast(e.message, 'error'); }
  const rows = all.rows.filter((r) => r.status === 'UNPAID' || r.status === 'PAY_FAILED'); const methods = P.ov?.methods || [];
  if (!methods.length) { P.toast('أضف وسيلة دفع الأول من «الدفع والمحافظ».', 'error'); return showTab('wallets'); }
  const m = modal(`<div class="fp-mh"><h3>الدفع الجماعي</h3><button class="fp-x" data-close>${ic('x')}</button></div><div class="fp-mb" id="bpBody">
    ${providers()?.pay?.available ? '' : `<div class="fp-banner warn">${ic('link')}<div><b>الدفع المباشر «تحتاج ربط»</b> — ${E(providers()?.pay?.reason || '')}<br>استخدم «ادفع الآن» لكل كود لتسجيل الدفع اليدوي.</div></div>`}
    <label class="fp-lab">وسيلة الدفع</label><div class="fp-sel wide"><select id="bpMethod">${methods.map((x) => `<option value="${x.id}">${E(x.label)}${x.balanceEgp != null ? ` — رصيد ${num(x.balanceEgp)} ج` : ''}</option>`).join('')}</select><span class="fp-sel-dd">${ic('down')}</span></div>
    <table class="fp-table sm"><thead><tr><th><input type="checkbox" id="bpAll"></th><th>الكود</th><th>الحساب</th><th>المبلغ</th></tr></thead><tbody>${rows.map((r) => `<tr><td><input type="checkbox" class="bpChk" value="${r.id}"></td><td class="mono">${E(r.code)}</td><td>${E(r.accountName)}</td><td>${egp(r.amountEgp)}</td></tr>`).join('') || '<tr><td colspan="4" class="fp-empty sm">مفيش أكواد غير مدفوعة.</td></tr>'}</tbody></table></div>
    <div class="fp-mf"><button class="fp-btn ghost" data-close>إغلاق</button><button class="fp-btn primary" id="bpPrev" ${rows.length ? '' : 'disabled'}>معاينة</button></div>`, { wide: true });
  const sel = () => m.$$('.bpChk').filter((c) => c.checked).map((c) => c.value); const bpAll = m.$('#bpAll'); if (bpAll) bpAll.onchange = () => m.$$('.bpChk').forEach((c) => { c.checked = bpAll.checked; });
  m.$('#bpPrev').onclick = (e) => lockBtn(e.currentTarget, async () => {
    const ids = sel(); if (!ids.length) return P.toast('اختار كود واحد على الأقل.', 'error');
    try {
      const methodId = m.$('#bpMethod')?.value || methods[0].id; const pv = await api.post(`${API}/bulk-pay/preview`, { codeIds: ids, methodId }); const t = pv.totals;
      m.$('#bpBody').innerHTML = `<div class="fp-kvs"><div class="kv"><span>عدد الأكواد</span><b>${t.count}</b></div><div class="kv"><span>الحسابات</span><b>${E(pv.accounts.join('، '))}</b></div><div class="kv"><span>إجمالي المبالغ</span><b>${egp(t.amountEgp)}</b></div><div class="kv"><span>إجمالي الرسوم</span><b>${egp(t.feesEgp)}</b></div><div class="kv total"><span>إجمالي المبلغ المخصوم</span><b>${egp(t.totalEgp)}</b></div><div class="kv"><span>وسيلة الدفع</span><b>${E(pv.method.label)}${pv.method.balanceEgp != null ? ` — رصيد ${egp(pv.method.balanceEgp)}` : ''}</b></div></div>
      <table class="fp-table sm"><thead><tr><th>الكود</th><th>الحساب</th><th>القيمة</th><th>الرسوم</th><th>الإجمالي</th></tr></thead><tbody>${pv.items.map((i) => `<tr class="${i.eligible ? '' : 'dim'}"><td class="mono">${E(i.code)}</td><td>${E(i.accountName)}</td><td>${egp(i.amountEgp)}</td><td>${egp(i.feeEgp)}</td><td>${i.eligible ? egp(i.totalEgp) : E(i.reason)}</td></tr>`).join('')}</tbody></table>
      ${pv.sufficient === false ? `<div class="fp-banner warn">${ic('warn')}رصيد الوسيلة مش كافي.</div>` : ''}<label class="fp-agree"><input type="checkbox" id="bpAgree"> أوافق صراحةً على خصم <b>${egp(t.totalEgp)}</b> من «${E(pv.method.label)}» بالتتابع، وإن أي عملية نتيجتها غير مؤكدة هتوقف الدفعة ومش هتتكرر.</label>`;
      const go = m.$('#bpPrev'); go.textContent = 'تنفيذ الدفع الجماعي'; go.disabled = true; const ag = m.$('#bpAgree'); ag.onchange = () => { go.disabled = !(ag.checked && pv.directPay && pv.sufficient !== false && pv.items.every((i) => i.eligible)); };
      go.onclick = (ev) => lockBtn(ev.currentTarget, async () => { try { const b = await api.post(`${API}/bulk-pay`, { codeIds: ids, methodId, requestId: rid(), confirm: true, expectedTotalEgp: t.totalEgp }); m.close(); openBatchView(b.id); } catch (err) { P.toast(err.message, 'error'); } });
    } catch (err) { P.toast(err.message, 'error'); }
  });
}

// ---------------------------------------------------------------------------
// TAB: extract
// ---------------------------------------------------------------------------
async function loadBatches() { P.batches = (await api.get(`${API}/batches`)).batches; if (!P.ov) await loadOverview(); }
function renderExtractTab(body) {
  const batches = P.batches || []; const uncertain = batches.flatMap((b) => (b.items || []).filter((i) => i.status === 'UNCERTAIN' && b.type === 'EXTRACT').map((i) => ({ ...i, batchId: b.id })));
  body.innerHTML = `<div class="fp-two"><div>${fawryPanelHtml()}</div><div class="fp-stack">
    <div class="fp-card"><div class="fp-ch"><h3>${ic('stack')}استخراج جماعي (Bulk Codes)</h3></div><p class="fp-dim">حدد عدة حسابات وكل حساب بمبلغه، شوف المعاينة بالإجمالي، وبعد موافقتك بينفذ بالتتابع.</p><button class="fp-btn primary" data-act="bulkExtract" ${can('extract') ? '' : 'disabled'}>${ic('bolt')}بدء استخراج جماعي</button></div>
    ${uncertain.length ? `<div class="fp-card"><div class="fp-ch"><h3>${ic('warn')}عمليات نتيجتها غير مؤكدة</h3></div>${uncertain.map((i) => `<div class="fp-lrow static"><span class="la">${E(i.accountName)}</span><span class="lv">${egp(i.amountEgp)}</span><button class="fp-btn sm primary" data-resolve="${i.jobId}">حلّها</button></div>`).join('')}</div>` : ''}
    <div class="fp-card"><div class="fp-ch"><h3>آخر الدفعات</h3></div>${batches.length ? batches.map((b) => `<button class="fp-lrow" data-act="openBatch" data-id="${b.id}"><span class="la">${b.type === 'PAY' ? 'دفع جماعي' : 'استخراج جماعي'}</span><span class="lv">${egp(b.totalEgp ?? b.totals?.totalEgp)}</span><span class="fp-chip ${b.status === 'DONE' ? 'green' : b.status === 'RUNNING' ? 'orange' : 'red'}">${E({ RUNNING: 'شغال', DONE: 'خلص', STOPPED_UNCERTAIN: 'وقف', STOPPED: 'متوقف', INTERRUPTED: 'اتقطع' }[b.status] || b.status)}</span></button>`).join('') : '<div class="fp-empty sm">مفيش دفعات.</div>'}</div></div></div>`;
  body.querySelectorAll('[data-resolve]').forEach((b) => { b.onclick = () => openResolveJob(b.dataset.resolve); });
}

// ---------------------------------------------------------------------------
// TAB: log
// ---------------------------------------------------------------------------
async function loadLog() { const q = { ...P.logQ, limit: 100 }; P.log = await api.get(`${API}/codes`, q); }
function renderLogTab(body) {
  const L = P.log; const q = P.logQ; const accs = P.ov?.accounts || [];
  const opt = (v, l, cur) => `<option value="${E(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${E(l)}</option>`;
  body.innerHTML = `<div class="fp-card"><div class="fp-ch"><h3>${ic('doc')}سجل أكواد الدفع <small class="fp-dim">(${num(L.total)} كود)</small></h3><div class="fp-head-tools"><a class="fp-btn sm ghost" href="${API}/report.xlsx?${new URLSearchParams(periodQs())}" ${can('reports') ? '' : 'hidden'}>تصدير Excel</a><button class="fp-btn sm ghost" data-act="logReset">مسح الفلاتر</button></div></div>
    <div class="fp-filterbar"><div class="fp-search wide">${ic('search')}<input id="fpLogQ" placeholder="بحث برقم الكود أو اسم الحساب أو رقم العملية" value="${E(q.q)}"></div>
    <select id="fpLog_status"><option value="">كل الحالات</option>${Object.entries(L.statuses).map(([k, l]) => opt(k, l, q.status)).join('')}</select>
    <select id="fpLog_bucket"><option value="">كل المجموعات</option>${[['unpaid', 'غير مدفوعة'], ['pending', 'معلقة'], ['credited', 'مسمعة'], ['expired', 'منتهية'], ['open', 'كل المفتوحة']].map(([k, l]) => opt(k, l, q.bucket)).join('')}</select>
    <select id="fpLog_account"><option value="">كل الحسابات</option>${accs.map((a) => opt(a.id, a.name, q.account)).join('')}</select>
    <select id="fpLog_user"><option value="">كل الموظفين</option>${L.filters.users.map((u) => opt(u, u, q.user)).join('')}</select>
    <select id="fpLog_method"><option value="">كل طرق الدفع</option>${L.filters.methods.map((u) => opt(u, u, q.method)).join('')}</select>
    <select id="fpLog_dateField">${opt('extracted', 'تاريخ الاستخراج', q.dateField)}${opt('paid', 'تاريخ الدفع', q.dateField)}${opt('credited', 'تاريخ التسميع', q.dateField)}</select>
    <input type="date" id="fpLog_from" value="${E(q.from)}"><input type="date" id="fpLog_to" value="${E(q.to)}"></div>
    <div class="fp-tw"><table class="fp-table"><thead><tr><th>#</th><th>الكود</th><th>الحساب الإعلاني</th><th>المبلغ</th><th>تاريخ الاستخراج</th><th>تاريخ الدفع</th><th>تاريخ التسميع</th><th>انتهاء الصلاحية</th><th>الحالة</th><th>طريقة الدفع</th><th>الموظف</th><th>رقم العملية</th><th>الإيصال</th><th>إجراءات</th></tr></thead><tbody>${L.rows.length ? logRowsHtml(L.rows, { full: true }) : '<tr><td colspan="14" class="fp-empty sm">مفيش أكواد بالفلاتر دي.</td></tr>'}</tbody></table></div>
    <div class="fp-pager"><button class="fp-btn sm ghost" data-act="logPage" data-d="-1" ${q.offset ? '' : 'disabled'}>السابق</button><span>${q.offset + 1}–${Math.min(q.offset + 100, L.total)} من ${L.total}</span><button class="fp-btn sm ghost" data-act="logPage" data-d="1" ${q.offset + 100 < L.total ? '' : 'disabled'}>التالي</button></div></div>`;
}

// ---------------------------------------------------------------------------
// TAB: wallets / methods / capabilities
// ---------------------------------------------------------------------------
function renderWallets(body) {
  const M = P.methods; const C = P.caps; const pr = M.providers; const st = (p) => `<div class="fp-prov ${p.available ? 'on' : 'off'}"><b>${E(p.label)}</b><span class="fp-chip ${p.available ? (p.mode === 'SIMULATION' ? 'orange' : 'green') : 'red'}">${E(p.status)}</span>${p.reason ? `<div class="fp-dim">${E(p.reason)}</div>` : ''}${p.manualPath ? `<div class="fp-dim"><b>المسار البديل:</b> ${E(p.manualPath)}</div>` : ''}${p.note ? `<div class="fp-dim">${E(p.note)}</div>` : ''}</div>`;
  const stateCls = { YES: 'green', NO: 'red', NEEDS_CONNECTION: 'orange', INFO: 'gray' }, stateLbl = { YES: 'متاح', NO: 'غير متاح', NEEDS_CONNECTION: 'تحتاج ربط', INFO: 'معلومة' };
  body.innerHTML = `<div class="fp-two"><div class="fp-stack">
    <div class="fp-card"><div class="fp-ch"><h3>${ic('wallet')}وسائل الدفع والمحافظ</h3>${can('manageMethods') ? `<button class="fp-btn sm primary" data-act="addMethod">${ic('plus')}إضافة وسيلة</button>` : ''}</div>
    <p class="fp-dim">مفيش أرقام محافظ كاملة ولا باسوردات ولا أكواد تحقق بتتخزن هنا — بس الاسم وآخر 4 أرقام وقاعدة الرسوم.</p>
    ${M.methods.length ? M.methods.map((x) => `<div class="fp-mrow2"><div><b>${E(x.label)}</b> <span class="fp-chip gray">${E(M.types[x.type] || x.type)}</span>${x.active ? '' : ' <span class="fp-chip red">متوقفة</span>'}<div class="fp-dim">رسوم: ${x.feePct}% + ${x.feeFixed} ج ${x.maskedRef ? `· ${E(x.maskedRef)}` : ''} · الرصيد: ${x.balanceEgp == null ? 'غير متاح' : `${egp(x.balanceEgp)} (${x.balanceSource === 'MANUAL' ? 'يدوي' : 'من المزود'})`}</div></div>${can('manageMethods') ? `<div><button class="fp-btn sm ghost" data-act="editMethod" data-id="${x.id}">تعديل</button><button class="fp-btn sm ghost" data-act="delMethod" data-id="${x.id}">حذف</button></div>` : ''}</div>`).join('') : '<div class="fp-empty sm">لسه مفيش وسائل دفع — أضف واحدة علشان تقدر تدفع/تسجّل الدفع.</div>'}</div>
    <div class="fp-card"><div class="fp-ch"><h3>${ic('stack')}الدفع الجماعي</h3></div><button class="fp-btn primary" data-act="bulkPay" ${can('bulkPay') ? '' : 'disabled'}>اختيار الأكواد والدفع</button></div></div>
    <div class="fp-stack"><div class="fp-card"><div class="fp-ch"><h3>${ic('link')}حالة الربط الحقيقي</h3></div>${st(pr.extract)}${st(pr.pay)}${st(pr.credit)}</div>
    <div class="fp-card"><div class="fp-ch"><h3>${ic('shield')}تقرير التحقق من الربط (<bdi dir="ltr">${E(C.checkedAt)}</bdi>)</h3></div>${C.items.map((i) => `<div class="fp-cap"><div class="cq">${E(i.q)} <span class="fp-chip ${stateCls[i.state]}">${stateLbl[i.state]}</span></div><div class="fp-dim">${E(i.a)}</div></div>`).join('')}<h4>المسار اليدوي المعتمد حاليًا</h4><ol class="fp-ol">${C.manual.map((x) => `<li>${E(x)}</li>`).join('')}</ol></div></div></div>`;
}
Object.assign(H, {
  addMethod: () => openMethod(null),
  editMethod: (t) => openMethod(P.methods.methods.find((x) => x.id === t.dataset.id)),
  delMethod: async (t) => { if (await confirmBox({ title: 'حذف وسيلة دفع', body: '<p>الأكواد القديمة المدفوعة بيها بتفضل في السجل. تحذف الوسيلة؟</p>', ok: 'حذف', danger: true })) { await call(() => api.delete(`${API}/methods/${t.dataset.id}`)); P.methods = await api.get(`${API}/methods`); await loadOverview(); renderBody(); } },
});
function openMethod(x) {
  const types = P.methods.types;
  const m = modal(`<div class="fp-mh"><h3>${x ? 'تعديل' : 'إضافة'} وسيلة دفع</h3><button class="fp-x" data-close>${ic('x')}</button></div><div class="fp-mb"><div class="fp-form"><label>الاسم<input id="mtLabel" value="${E(x?.label || '')}"></label><label>النوع<select id="mtType">${Object.entries(types).map(([k, l]) => `<option value="${k}" ${x?.type === k ? 'selected' : ''}>${E(l)}</option>`).join('')}</select></label><label>آخر 4 أرقام (اختياري)<input id="mtRef" maxlength="12" placeholder="••1234" value="${E(x?.maskedRef || '')}"></label><label>الرصيد الحالي (ج) — يدوي، اختياري<input id="mtBal" type="number" min="0" step="0.01" value="${x?.balanceEgp ?? ''}"></label><label>نسبة الرسوم %<input id="mtPct" type="number" min="0" max="20" step="0.01" value="${x?.feePct ?? 0}"></label><label>رسوم ثابتة (ج)<input id="mtFix" type="number" min="0" step="0.01" value="${x?.feeFixed ?? 0}"></label><label class="full"><span><input type="checkbox" id="mtOn" ${x?.active === false ? '' : 'checked'}> وسيلة نشطة</span></label></div></div><div class="fp-mf"><button class="fp-btn ghost" data-close>إلغاء</button><button class="fp-btn primary" id="mtSave">حفظ</button></div>`);
  m.$('#mtSave').onclick = (e) => lockBtn(e.currentTarget, async () => { try { await api.post(`${API}/methods`, { id: x?.id, label: m.$('#mtLabel').value, type: m.$('#mtType').value, maskedRef: m.$('#mtRef').value, balanceEgp: m.$('#mtBal').value, feePct: m.$('#mtPct').value, feeFixed: m.$('#mtFix').value, active: m.$('#mtOn').checked }); m.close(); P.methods = await api.get(`${API}/methods`); await loadOverview(); renderBody(); P.toast('اتحفظت ✔', 'success'); } catch (err) { P.toast(err.message, 'error'); } });
}

// ---------------------------------------------------------------------------
// TAB: accounts (+ forecast)
// ---------------------------------------------------------------------------
function renderAccountsTab(body) {
  const A = P.accountsTab; const F = P.forecast; const fmap = Object.fromEntries((F?.accounts || []).map((f) => [f.accountId, f]));
  const need = (F?.accounts || []).filter((f) => f.needsTopUpToday);
  body.innerHTML = `${F ? `<div class="fp-card"><div class="fp-ch"><h3>${ic('clock')}توقع احتياج الحسابات للشحن <span class="fp-chip orange">تقديري</span></h3></div><p class="fp-dim">${E(F.note)}</p>
    ${need.length ? `<div class="fp-banner warn">${ic('warn')}<div><b>حسابات تحتاج شحن اليوم (تقدير):</b> ${need.map((f) => `${E(f.name)} (≈${f.hoursLeft} ساعة)`).join('، ')}</div></div>` : ''}
    <div class="fp-tw"><table class="fp-table"><thead><tr><th>الحساب</th><th>الرصيد المتبقي</th><th>متوسط الصرف اليومي</th><th>الساعات المتوقعة</th><th>مبلغ الشحن المقترح</th><th>في الطريق (مدفوع لم يسمع)</th><th></th></tr></thead><tbody>${F.accounts.map((f) => `<tr><td><b>${E(f.name)}</b></td><td>${f.balanceEgp == null ? '<span class="fp-dim">غير متاح</span>' : egp(f.balanceEgp)}</td><td>${f.avgDailySpendEgp == null ? '—' : egp(f.avgDailySpendEgp)}</td><td>${f.hoursLeft == null ? '—' : `≈ ${num(f.hoursLeft, 1)} ساعة`}</td><td>${f.suggestedTopUpEgp == null ? '—' : f.suggestedTopUpEgp ? egp(f.suggestedTopUpEgp) : 'مش محتاج'}</td><td>${f.incomingEgp ? egp(f.incomingEgp) : '—'}</td><td>${f.note ? `<span class="fp-dim">${E(f.note)}</span>` : f.needsTopUpToday ? '<span class="fp-chip red">يحتاج شحن</span>' : ''}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="fp-acctgrid">${A.accounts.map((a) => `<div class="fp-card fp-acctcard"><div class="ah">${META}<div class="an"><b>${E(a.name)}</b><span>${a.balance?.available != null ? `الرصيد الحالي: ${egp(a.balance.available)}` : 'الرصيد غير متاح'}${fmap[a.id]?.hoursLeft != null ? ` · يكفي ≈ ${num(fmap[a.id].hoursLeft, 0)} ساعة` : ''}</span></div>${donut(a.creditedPct, '#16a34a', 52)}</div>
      <div class="fp-kvs one"><div class="kv"><span>الأكواد المستخرجة</span><b>${num(a.extractedCount)} (${egp(a.extractedValueEgp)})</b></div><div class="kv"><span>مسمع / معلق / غير مدفوع</span><b><span class="g">${a.credited}</span> / <span class="o">${a.pending}</span> / <span class="r">${a.unpaid}</span></b></div><div class="kv"><span>مدفوعات اليوم</span><b>${egp(a.paidTodayEgp)}</b></div><div class="kv"><span>مدفوعات الشهر الحالي</span><b>${egp(a.paidMonthEgp)}</b></div></div>
      <div class="fp-cardbtns"><button class="fp-btn primary sm" data-act="charge" data-id="${E(a.id)}" ${can('extract') ? '' : 'disabled'}>${ic('bolt')}شحن الحساب</button><button class="fp-btn ghost sm" data-act="account" data-id="${E(a.id)}">التفاصيل</button></div></div>`).join('')}</div><div id="fpAcctDetail"></div>`;
  if (P.accountDetail) openAccount(P.accountDetail, true);
}
async function openAccount(id, quiet = false) {
  P.accountDetail = id; const host = document.getElementById('fpAcctDetail'); if (!host) return;
  try { const d = await api.get(`${API}/accounts/${encodeURIComponent(id)}`, periodQs()); const r = d.report;
    host.innerHTML = `<div class="fp-card fp-detail"><div class="fp-ch"><h3>${META} ${E(d.account.name)} — تفاصيل الحساب (${E(r.period.label)})</h3><button class="fp-btn sm ghost" data-act="closeDetail">إغلاق</button></div>
      <div class="fp-kvs"><div class="kv"><span>أكواد مستخرجة</span><b>${r.extracted.count} (${egp(r.extracted.valueEgp)})</b></div><div class="kv"><span>مدفوعات فعلية</span><b>${egp(r.payments.actualEgp)}</b></div><div class="kv"><span>رصيد مسمع مؤكد</span><b>${egp(r.credited.valueEgp)}</b></div><div class="kv"><span>متوسط مدة التسميع</span><b>${fmtDur(r.avgMinutesToCredit)}</b></div></div>
      ${d.series.some((s) => s.paidEgp) ? chartSvg(d.series, { wide: true }) : ''}<div class="fp-tw"><table class="fp-table"><thead><tr><th>#</th><th>الكود</th><th>الحساب الإعلاني</th><th>المبلغ</th><th>تاريخ الاستخراج</th><th>تاريخ الدفع</th><th>تاريخ التسميع</th><th>الحالة</th><th>طريقة الدفع</th><th>إجراءات</th></tr></thead><tbody>${logRowsHtml(d.codes) || ''}</tbody></table></div></div>`;
    if (!quiet) host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { P.toast(e.message, 'error'); }
}
H.closeDetail = () => { P.accountDetail = null; document.getElementById('fpAcctDetail').innerHTML = ''; };

// ---------------------------------------------------------------------------
// TAB: reports & closing
// ---------------------------------------------------------------------------
function renderReports(body) {
  if (!can('reports')) { body.innerHTML = '<div class="fp-card fp-empty">مفيش عندك صلاحية مراجعة التقارير.</div>'; return; }
  const R = P.report; const r = R.report; const cmp = R.comparison; const mom = R.monthOverMonth;
  const stat = (l, v, s = '') => `<div class="fp-stat"><span>${l}</span><b>${v}</b>${s ? `<small>${s}</small>` : ''}</div>`;
  const tbl = (title, rows) => `<div class="fp-card"><div class="fp-ch"><h3>${title}</h3></div>${rows.length ? `<table class="fp-table sm"><tbody>${rows.map((x) => `<tr><td>${E(x.label)}</td><td>${x.count} عملية</td><td><b>${egp(x.totalEgp)}</b></td></tr>`).join('')}</tbody></table>` : '<div class="fp-empty sm">مفيش مدفوعات في الفترة.</div>'}</div>`;
  const dlt = (a, b) => (b > 0 ? `${a >= b ? '+' : ''}${num(((a - b) / b) * 100, 1)}%` : '—');
  body.innerHTML = `<div class="fp-card"><div class="fp-ch"><h3>${ic('chart')}تقرير الفترة: ${E(r.period.label)} <small class="fp-dim"><bdi dir="ltr">${E(r.period.from)} → ${E(r.period.to)}</bdi></small></h3><div class="fp-head-tools"><button class="fp-btn sm ghost" data-act="exportXlsx">${ic('doc')}تصدير Excel</button></div></div>
    <div class="fp-note">الأكواد المستخرجة بتتحسب بتاريخ الاستخراج، والمدفوعات بتاريخ الدفع، والتسميع بتاريخ التأكيد — فمفيش حاجة بتتحسب مرتين في فترة.</div>
    <div class="fp-stats">${stat('أكواد مستخرجة', num(r.extracted.count), `قيمتها ${egp(r.extracted.valueEgp)}`)}${stat('أكواد مدفوعة', num(r.payments.count), `قيمتها ${egp(r.payments.codesValueEgp)}`)}${stat('إجمالي المدفوعات الفعلية', egp(r.payments.actualEgp), cmp.changePct == null ? 'لا توجد فترة سابقة' : `${cmp.changePct >= 0 ? '+' : ''}${cmp.changePct}% عن ${E(cmp.label)}`)}${stat('الرصيد المضاف المؤكد', egp(r.credited.valueEgp), `${r.credited.count} كود`)}${stat('غير مدفوعة', egp(r.buckets.unpaid.valueEgp), `${r.buckets.unpaid.count} كود`)}${stat('معلقة', egp(r.buckets.pending.valueEgp), `${r.buckets.pending.count} كود`)}${stat('رسوم الدفع', egp(r.payments.feesEgp))}${stat('متوسط قيمة الكود', egp(r.extracted.avgCodeEgp))}${stat('متوسط الاستخراج → الدفع', fmtDur(r.avgMinutesToPay))}${stat('متوسط الدفع → التسميع', fmtDur(r.avgMinutesToCredit))}</div></div>
    <div class="fp-card"><div class="fp-ch"><h3>${ic('doc')}حركة المدفوعات</h3><select id="fpGran"><option value="day" ${R.granularity === 'day' ? 'selected' : ''}>يومي</option><option value="week" ${R.granularity === 'week' ? 'selected' : ''}>أسبوعي</option><option value="month" ${R.granularity === 'month' ? 'selected' : ''}>شهري</option></select></div>${R.series.some((s) => s.paidEgp) ? chartSvg(R.series, { wide: true }) : '<div class="fp-empty sm">مفيش مدفوعات في الفترة دي.</div>'}</div>
    <div class="fp-three">${tbl('المدفوعات لكل حساب إعلاني', r.byAccount)}${tbl('المدفوعات لكل موظف', r.byUser)}${tbl('المدفوعات لكل وسيلة دفع', r.byMethod)}</div>
    <div class="fp-two"><div class="fp-card"><div class="fp-ch"><h3>مقارنة المدفوعات بالإنفاق الإعلاني</h3></div>${R.spend.available ? `<table class="fp-table sm"><thead><tr><th>الحساب</th><th>الإنفاق</th><th>مدفوع (قيمة الأكواد)</th><th>الفرق</th></tr></thead><tbody>${R.spend.rows.map((x) => `<tr><td>${E(x.name)}</td><td>${x.spendEgp == null ? '—' : egp(x.spendEgp)}</td><td>${egp(x.paidCodesEgp)}</td><td class="${x.diffEgp == null ? '' : x.diffEgp >= 0 ? 'g' : 'r'}">${x.diffEgp == null ? '—' : egp(x.diffEgp)}</td></tr>`).join('')}</tbody></table><div class="fp-note">${E(R.spend.note)}</div>` : `<div class="fp-empty sm">${E(R.spend.note)}</div>`}</div>
    <div class="fp-card"><div class="fp-ch"><h3>مقارنة الشهر الحالي بالشهر السابق</h3></div><table class="fp-table sm"><thead><tr><th></th><th>${E(mom.currentLabel)}</th><th>${E(mom.previousLabel)}</th><th>التغير</th></tr></thead><tbody><tr><td>عدد المدفوعات</td><td>${mom.current.count}</td><td>${mom.previous.count}</td><td>${dlt(mom.current.count, mom.previous.count)}</td></tr><tr><td>المدفوعات الفعلية</td><td>${egp(mom.current.actualEgp)}</td><td>${egp(mom.previous.actualEgp)}</td><td>${dlt(mom.current.actualEgp, mom.previous.actualEgp)}</td></tr><tr><td>الرسوم</td><td>${egp(mom.current.feesEgp)}</td><td>${egp(mom.previous.feesEgp)}</td><td>${dlt(mom.current.feesEgp, mom.previous.feesEgp)}</td></tr></tbody></table></div></div>
    <div class="fp-card"><div class="fp-ch"><h3>${ic('shield')}التقفيل المالي <select id="fpCloseKind"><option value="day" ${P.closeKind === 'day' ? 'selected' : ''}>يومي</option><option value="month" ${P.closeKind === 'month' ? 'selected' : ''}>شهري</option></select></h3><button class="fp-btn sm ghost" data-act="runClosing">إنشاء التقفيلات الناقصة</button></div><p class="fp-dim">بيتعمل تلقائيًا بعد نهاية اليوم/الشهر بتوقيت القاهرة، وبيتحفظ ومبيتعدّلش. أي دفع/تسميع بعده بيظهر كتسوية بتاريخها.</p>
      ${P.closings?.closings?.length ? `<table class="fp-table sm"><thead><tr><th>الفترة</th><th>مستخرج</th><th>مدفوع فعلي</th><th>رسوم</th><th>مسمّع</th><th>غير مدفوع (آخر اليوم)</th><th>مدفوع لم يسمع</th><th>فروقات</th><th></th></tr></thead><tbody>${P.closings.closings.map((c) => `<tr><td>${E(c.key)}</td><td>${num(c.totals.extractedCount)} · ${egp(c.totals.extractedEgp)}</td><td>${egp(c.totals.actualPaidEgp)}</td><td>${egp(c.totals.feesEgp)}</td><td>${egp(c.totals.creditedEgp)}</td><td>${egp(c.positionsAtClose.unpaid.valueEgp)}</td><td>${egp(c.positionsAtClose.paidNotCredited.valueEgp)}</td><td>${c.discrepancies.length ? `<span class="fp-chip red">${c.discrepancies.length}</span>` : '—'}</td><td><button class="fp-btn sm ghost" data-act="openClosing" data-k="${E(c.key)}">تفاصيل</button></td></tr>`).join('')}</tbody></table>` : '<div class="fp-empty sm">لسه مفيش تقفيلات (بتتعمل بعد نهاية أول يوم فيه نشاط).</div>'}</div>`;
}
Object.assign(H, {
  runClosing: (t) => lockBtn(t, async () => { const r = await call(() => api.post(`${API}/closings/run`, {})); P.toast(r.created.length ? `اتعمل ${r.created.length} تقفيل` : 'مفيش تقفيلات ناقصة.', 'success'); P.closings = await api.get(`${API}/closings`, { kind: P.closeKind }); renderBody(); }),
  openClosing: async (t) => {
    const d = await call(() => api.get(`${API}/closings/${encodeURIComponent(t.dataset.k)}`)); const c = d.closing;
    modal(`<div class="fp-mh"><h3>تقفيل ${E(c.key)}</h3><button class="fp-x" data-close>${ic('x')}</button></div><div class="fp-mb"><div class="fp-kvs"><div class="kv"><span>أكواد مستخرجة</span><b>${c.totals.extractedCount} · ${egp(c.totals.extractedEgp)}</b></div><div class="kv"><span>أكواد مدفوعة</span><b>${c.totals.paidCount} · ${egp(c.totals.paidCodesEgp)}</b></div><div class="kv"><span>إجمالي المدفوعات الفعلية</span><b>${egp(c.totals.actualPaidEgp)}</b></div><div class="kv"><span>رسوم الدفع</span><b>${egp(c.totals.feesEgp)}</b></div><div class="kv"><span>المبالغ الخارجة من وسائل الدفع</span><b>${egp(c.totals.outflowEgp)}</b></div><div class="kv"><span>الرصيد المسمع</span><b>${egp(c.totals.creditedEgp)}</b></div><div class="kv"><span>أكواد غير مدفوعة (نهاية الفترة)</span><b>${c.positionsAtClose.unpaid.count} · ${egp(c.positionsAtClose.unpaid.valueEgp)}</b></div><div class="kv"><span>مدفوع ولم يسمع (نهاية الفترة)</span><b>${c.positionsAtClose.paidNotCredited.count} · ${egp(c.positionsAtClose.paidNotCredited.valueEgp)}</b></div></div>
      <h4>فروقات تحتاج مراجعة</h4>${c.discrepancies.length ? c.discrepancies.map((x) => `<div class="fp-lrow static"><span class="lc">${E(x.code)}</span><span class="la">${E(x.note)}</span></div>`).join('') : '<div class="fp-dim">لا يوجد.</div>'}
      <h4>تسويات لاحقة (بعد التقفيل — بدون تعديل على التقفيل)</h4>${d.late.length ? d.late.map((x) => `<div class="fp-lrow static"><span class="lc">${E(x.code)}</span><span class="la">${E(x.note)} — ${fmtFull(x.at)}</span><span class="lv">${egp(x.amountEgp)}</span></div>`).join('') : '<div class="fp-dim">لا يوجد.</div>'}</div><div class="fp-mf"><button class="fp-btn ghost" data-close>إغلاق</button></div>`, { wide: true });
  },
});

// ---------------------------------------------------------------------------
// TAB: settings (+ permissions, follow-up, audit)
// ---------------------------------------------------------------------------
function renderSettings(body) {
  const S = P.settings; const c = S.config; const mon = P.status?.monitor || {};
  const f = (id, l, v, extra = '') => `<label>${l}<input id="${id}" type="number" value="${E(v)}" ${extra}></label>`;
  body.innerHTML = `<div class="fp-two"><div class="fp-stack"><div class="fp-card"><div class="fp-ch"><h3>${ic('gear')}إعدادات المتابعة والتنبيهات</h3></div>${S.isAdmin ? '' : '<div class="fp-banner warn">الإعدادات لمدير النظام فقط — بتعرضها للقراءة.</div>'}
    <div class="fp-form">${f('stMon', 'فترة المتابعة التلقائية (دقيقة 1–60)', c.monitorEveryMin, 'min=1 max=60')}
    <label>مدة التنبيه<select id="stAlert">${[15, 30, 60, 120].map((v) => `<option value="${v}" ${c.alertAfterMin === v ? 'selected' : ''}>${v} دقيقة</option>`).join('')}${[15, 30, 60, 120].includes(c.alertAfterMin) ? '' : `<option selected>${c.alertAfterMin}</option>`}</select></label>
    ${f('stExp', 'تنبيه قرب الانتهاء (دقيقة قبل)', c.expiryWarnMin)}${f('stCred', 'مهلة التسميع قبل التنبيه (دقيقة)', c.creditOverdueMin)}${f('stMin', 'أقل مبلغ للكود (ج)', c.minAmountEgp)}${f('stMax', 'أعلى مبلغ للكود (ج)', c.maxAmountEgp)}${f('stGap', 'الفاصل بين الاستخراجات الجماعية (مللي ثانية)', c.extractGapMs)}${f('stCover', 'أيام التغطية في التوقع', c.coverDays, 'step=0.5')}${f('stNeed', 'حد الساعات لـ«تحتاج شحن»', c.needTopUpHours)}${f('stLow', 'حد الرصيد المنخفض (ج)', c.lowBalanceEgp)}
    <label class="full"><span><input type="checkbox" id="stClose" ${c.closingEnabled ? 'checked' : ''}> التقفيل التلقائي اليومي والشهري</span></label></div>
    <h4>أسماء الحسابات (اختياري — بتظهر بدل اسم ميتا)</h4><div class="fp-form">${S.accounts.map((a) => `<label>${E(a.id)}<input data-alias="${E(a.id)}" value="${E(c.accountNames[a.id] || '')}" placeholder="${E(a.name)}"></label>`).join('')}</div>
    ${S.isAdmin ? '<div class="fp-mf"><button class="fp-btn primary" data-act="saveSettings">حفظ الإعدادات</button></div>' : ''}</div>
    <div class="fp-card"><div class="fp-ch"><h3>${ic('clock')}المتابعة في الخلفية</h3><button class="fp-btn sm ghost" data-act="runMonitor">شغّل المتابعة الآن</button></div>
    <div class="fp-kvs one"><div class="kv"><span>آخر متابعة</span><b>${mon.lastTickAt ? fmtFull(mon.lastTickAt) : 'لسه'}</b></div><div class="kv"><span>آخر نجاح</span><b>${mon.lastOkAt ? fmtFull(mon.lastOkAt) : '—'}</b></div><div class="kv"><span>آخر خطأ</span><b>${E(mon.lastError || 'لا يوجد')}</b></div><div class="kv"><span>تهدئة (Rate limit)</span><b>${mon.backoffUntil && new Date(mon.backoffUntil) > new Date() ? fmtFull(mon.backoffUntil) : 'لا'}</b></div></div><p class="fp-dim">بتشتغل حتى لو قفلت الصفحة، وبتكمّل بعد إعادة التشغيل. الأكواد المعلقة بتفضل في المتابعة لحد ما تتحل.</p></div></div>
    <div class="fp-stack">${S.isAdmin ? `<div class="fp-card"><div class="fp-ch"><h3>${ic('user')}الصلاحيات والحد اليومي لكل موظف</h3></div><table class="fp-table sm"><thead><tr><th>المستخدم</th>${Object.values(S.permLabels).map((l) => `<th>${E(l)}</th>`).join('')}<th>حد الدفع اليومي (ج)</th><th></th></tr></thead><tbody>${S.users.map((u) => `<tr data-uid="${u.id}"><td><b>${E(u.name)}</b><br><span class="fp-dim">${E(u.role)}</span></td>${Object.keys(S.permLabels).map((k) => `<td><input type="checkbox" data-perm="${k}" ${u.perms[k] ? 'checked' : ''} ${u.role === 'ADMIN' ? 'disabled' : ''}></td>`).join('')}<td><input type="number" class="lim" min="0" value="${u.dailyLimitEgp ?? ''}" placeholder="بدون حد" ${u.role === 'ADMIN' ? '' : ''}></td><td>${u.role === 'ADMIN' ? '<span class="fp-dim">كل الصلاحيات</span>' : '<button class="fp-btn sm primary" data-act="savePerm">حفظ</button>'}</td></tr>`).join('')}</tbody></table><div class="fp-note">المدير (ADMIN) عنده كل الصلاحيات دايمًا. «الدفع الجماعي» محتاج صلاحية «تنفيذ الدفع» كمان. الحد اليومي بيتحسب بتوقيت القاهرة.</div></div>` : ''}
    <div class="fp-card"><div class="fp-ch"><h3>${ic('shield')}سجل العمليات (Audit Log)</h3><button class="fp-btn sm ghost" data-act="loadAudit">عرض آخر العمليات</button></div><div id="fpAudit" class="fp-dim">اضغط «عرض» — كل عملية بتتسجل: مين نفّذها وإمتى ونتيجتها (من غير أي أسرار).</div></div></div></div>`;
}
Object.assign(H, {
  saveSettings: (t) => lockBtn(t, async () => { const v = (id) => Number(document.getElementById(id).value); const aliases = {}; document.querySelectorAll('[data-alias]').forEach((i) => { if (i.value.trim()) aliases[i.dataset.alias] = i.value.trim(); });
    await call(() => api.put(`${API}/settings`, { monitorEveryMin: v('stMon'), alertAfterMin: v('stAlert'), expiryWarnMin: v('stExp'), creditOverdueMin: v('stCred'), minAmountEgp: v('stMin'), maxAmountEgp: v('stMax'), extractGapMs: v('stGap'), coverDays: v('stCover'), needTopUpHours: v('stNeed'), lowBalanceEgp: v('stLow'), closingEnabled: document.getElementById('stClose').checked, accountNames: aliases })); P.toast('اتحفظت الإعدادات ✔', 'success'); P.settings = await api.get(`${API}/settings`); P.status = await api.get(`${API}/status`); P.ov = null; renderBody(); }),
  savePerm: (t) => lockBtn(t, async () => { const tr = t.closest('tr'); const uid = tr.dataset.uid; const perms = {}; tr.querySelectorAll('[data-perm]').forEach((i) => { perms[i.dataset.perm] = i.checked; }); const lim = tr.querySelector('.lim').value;
    await call(() => api.put(`${API}/permissions/${uid}`, { perms })); const limits = { ...(P.settings.config.dailyLimits || {}) }; if (lim === '') delete limits[uid]; else limits[uid] = Number(lim); await call(() => api.put(`${API}/settings`, { dailyLimits: limits })); P.toast('اتحفظت الصلاحيات ✔', 'success'); P.settings = await api.get(`${API}/settings`); renderBody(); }),
  loadAudit: async () => { const d = await call(() => api.get(`${API}/audit`, { limit: 60 })); document.getElementById('fpAudit').innerHTML = `<table class="fp-table sm"><tbody>${d.audit.map((a) => `<tr><td>${fmtFull(a.at)}</td><td>${E(a.actor?.name || 'النظام')}</td><td>${E(a.action)}</td><td>${E(a.outcome)}</td><td class="mono">${E(a.target?.id || '')}</td></tr>`).join('') || '<tr><td>لا يوجد</td></tr>'}</tbody></table>`; },
});
