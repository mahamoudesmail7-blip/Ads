// ai-media-buyer.js — page controller for ai-media-buyer.html.
//
// UI redesign only: a clean, premium light dashboard. Every backend call,
// approval function, Meta action, recommendation-lifecycle rule and data
// model is UNCHANGED from before — the same endpoints, the same
// approve/reject/edit/dry-run/execute flow, the same winner hierarchy.
// Advanced/technical detail now lives inside "التفاصيل" instead of on the
// main cards.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const E = (s) => UI.escapeHtml(String(s ?? ''));
const $ = (id) => document.getElementById(id);

function fmtNum(v, d = 0) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtEGP(v, d = 0) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `${fmtNum(v, d)} ج.م`;
}
function fmtPct(v, d = 1) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `${fmtNum(v, d)}%`;
}
function fmtX(v, d = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `${fmtNum(v, d)}x`;
}
function fmtDT(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
}
function timeAgo(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'الآن';
  if (mins < 60) return `منذ ${mins} دقيقة`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `منذ ${hrs} ساعة`;
  return `منذ ${Math.round(hrs / 24)} يوم`;
}

// ---- tiny inline icon set (stroke, currentColor) ----
const IC = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l3-4 3 3 5-7"/>',
  box: '<path d="M21 8 12 3 3 8l9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/>',
  bulb: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  doc: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 19.4 7l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4z"/>',
  money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  cart: '<circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/><path d="M2 3h3l2.4 12.2A2 2 0 0 0 9.4 17h8.5a2 2 0 0 0 2-1.6L21 7H6"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M16 12h4"/>',
  rocket: '<path d="M5 15c-1 1-1.5 4-1.5 4s3-.5 4-1.5"/><path d="M9 12a12 12 0 0 1 8-9 12 12 0 0 1-2 11l-4 3-3-3z"/><circle cx="14" cy="9" r="1.5"/>',
  stop: '<circle cx="12" cy="12" r="9"/><path d="M9 9h6v6H9z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/>',
  meta: '<path d="M4 15c2.5-8 6-8 8 0 2-8 5.5-8 8 0"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10 8l6 4-6 4z"/>',
};
function ic(name, cls = 'ic') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${IC[name] || ''}</svg>`;
}

const NAV = [
  { key: 'home', label: 'الرئيسية', icon: 'home' },
  { key: 'campaigns', label: 'أداء الإعلانات', icon: 'chart' },
  { key: 'products', label: 'المنتجات', icon: 'box' },
  { key: 'plan', label: 'القرارات الذكية', icon: 'bulb', badge: true },
  { key: 'winners', label: 'الأبطال', icon: 'image' },
  { key: 'medialib', label: 'مكتبة الكرياتيفات', icon: 'grid' },
  { key: 'clone', label: 'استنساخ وجدولة', icon: 'copy' },
  { key: 'history', label: 'التقارير', icon: 'doc' },
  { key: 'settings', label: 'الإعدادات', icon: 'gear' },
];
const SECTIONS = { campaigns: renderCampaigns, products: renderProducts, plan: renderPlan, winners: renderWinners, medialib: renderMediaLib, clone: renderClone, history: renderHistory, settings: renderSettings };
const SECTION_TITLE = { campaigns: 'أداء الإعلانات', products: 'المنتجات', plan: 'القرارات الذكية', winners: 'الكرياتيفات والأبطال', medialib: 'مكتبة الكرياتيفات', clone: 'استنساخ وجدولة الحملات', history: 'التقارير وسجل التنفيذ', settings: 'الإعدادات' };
const NO_WINDOW_SECTIONS = new Set(['settings', 'clone']);

// Exactly the 3 periods the dashboard supports. All map to the backend's
// existing resolveWindow() keys, so every window-aware endpoint honours them.
const WINDOWS = [
  { key: 'today', label: 'اليوم' },
  { key: 'yesterday', label: 'أمس' },
  { key: 'last7', label: 'آخر 7 أيام' },
];
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
function fmtDateAr(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return `${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
/** "6 سبتمبر 2026" for a single day, "31 أغسطس — 6 سبتمبر 2026" for a range. */
function windowDateText(w) {
  if (!w || !w.from) return '';
  if (!w.to || w.to === w.from) return fmtDateAr(w.from);
  const a = new Date(w.from + 'T00:00:00'), b = new Date(w.to + 'T00:00:00');
  const left = b.getFullYear() === a.getFullYear() ? `${a.getDate()} ${AR_MONTHS[a.getMonth()]}` : fmtDateAr(w.from);
  return `${left} — ${fmtDateAr(w.to)}`;
}

const state = {
  tab: 'home',
  window: 'today',
  isAdmin: false,
  me: null,
  home: null,       // cached home payload
  filter: 'all',
  search: '',
  pendingCount: 0,
  productImages: {}, // { [ambProductId]: {hasImage, source} } — preloaded once, no N+1
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
async function init() {
  try {
    state.me = await api.get('/api/auth/me');
    state.isAdmin = state.me.role === 'ADMIN' || state.me.is_owner;
  } catch { /* api-client handles 401 */ }

  $('ambDrawerOverlay').addEventListener('click', (e) => { if (e.target.id === 'ambDrawerOverlay') closeDrawer(); });
  window.addEventListener('hashchange', route);
  renderNav();
  route();
}

function renderNav() {
  const u = state.me || {};
  const initials = (u.name || 'U').trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
  $('ambNav').innerHTML = `
    <div class="amb-nav-brand">
      <div class="logo">${ic('bulb', 'ic')}</div>
      <div><div class="t">AI Media Buyer</div><div class="s">قرارات أذكى. ربح أعلى.</div></div>
    </div>
    <div class="amb-nav-list" id="ambNavList">
      ${NAV.map((n) => `<button class="amb-nav-item ${n.key === state.tab ? 'active' : ''}" data-nav="${n.key}">
        ${ic(n.icon)}<span>${E(n.label)}</span>
        ${n.badge && state.pendingCount ? `<span class="amb-nav-count">${state.pendingCount}</span>` : ''}
      </button>`).join('')}
    </div>
    <div class="amb-nav-foot">
      <div class="amb-nav-user">
        <div class="av">${E(initials)}</div>
        <div><div class="nm">${E(u.name || '—')}</div><div class="rl">${E({ ADMIN: 'مدير النظام', MANAGER: 'مدير', EMPLOYEE: 'موظف' }[u.role] || u.role || '')}</div></div>
      </div>
      <a class="amb-nav-link" href="ai-intelligence.html">🧠 AI Intelligence</a>
      <a class="amb-nav-link" href="index.html">↩︎ الرجوع للنظام</a>
    </div>`;
  $('ambNavList').querySelectorAll('[data-nav]').forEach((b) => {
    b.onclick = () => { location.hash = b.dataset.nav; };
  });
}

function route() {
  if (cloneState.poll) { clearInterval(cloneState.poll); cloneState.poll = null; }
  if (schedState.ticker) { clearInterval(schedState.ticker); schedState.ticker = null; }
  const hash = (location.hash || '#home').slice(1);
  state.tab = NAV.find((n) => n.key === hash) ? hash : 'home';
  renderNav();
  const view = $('ambView');
  view.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  const run = state.tab === 'home' ? renderHome : (panel) => renderSection(panel, state.tab);
  run(view).catch((err) => { view.innerHTML = `<div class="amb-empty">⚠️ ${E(err.message || err)}</div>`; });
}

/** Deep section wrapper — light header + the existing renderer (unchanged) into a panel. */
async function renderSection(view, key) {
  view.innerHTML = `
    <div class="amb-head">
      <div>
        <h1>${E(SECTION_TITLE[key] || key)}</h1>
        <div class="sub">جزء من AI Media Buyer — نفس البيانات والمنطق، عرض مبسّط.</div>
      </div>
      <div class="amb-head-tools">${NO_WINDOW_SECTIONS.has(key) ? '' : windowChips()}</div>
    </div>
    <div id="ambSecPanel"></div>`;
  if (!NO_WINDOW_SECTIONS.has(key)) wireWindowChips(() => route());
  await SECTIONS[key]($('ambSecPanel'));
}

function windowChips() {
  return `<div class="amb-filters" style="margin:0;">${WINDOWS.map((w) => `<button class="amb-fbtn ${w.key === state.window ? 'active' : ''}" data-w="${w.key}">${E(w.label)}</button>`).join('')}</div>`;
}
function wireWindowChips(onChange) {
  document.querySelectorAll('[data-w]').forEach((b) => { b.onclick = () => { state.window = b.dataset.w; onChange(); }; });
}
// legacy helper kept for deep renderers that call it
function windowPicker(onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'amb-filters';
  wrap.style.marginBottom = '14px';
  wrap.innerHTML = WINDOWS.map((w) => `<button class="amb-fbtn ${w.key === state.window ? 'active' : ''}" data-wp="${w.key}">${E(w.label)}</button>`).join('');
  wrap.querySelectorAll('[data-wp]').forEach((b) => { b.onclick = () => { state.window = b.dataset.wp; onChange(); }; });
  return wrap;
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------
function openDrawer(html) {
  $('ambDrawerPanel').innerHTML = html;
  $('ambDrawerOverlay').classList.add('open');
}
function closeDrawer() { $('ambDrawerOverlay').classList.remove('open'); }

// ---------------------------------------------------------------------------
// HOME — the reference dashboard
// ---------------------------------------------------------------------------
async function renderHome(view) {
  const win = state.window;
  const calls = [
    api.get(`/api/ai-media-buyer/overview?window=${win}`),
    api.get('/api/ai-media-buyer/recommendations'),
    api.get(`/api/ai-media-buyer/hierarchy?window=${win}`).catch(() => null),
    api.get('/api/meta/status').catch(() => null),
    api.get('/api/ai-media-buyer/product-images').catch(() => ({})),
    // Only "today" has a well-defined "previous period" (yesterday) for a trend.
    win === 'today' ? api.get('/api/ai-media-buyer/hierarchy?window=yesterday').catch(() => null) : Promise.resolve(null),
  ];
  const [ov, recs, hWin, meta, imgMap, hPrev] = await Promise.all(calls);
  state.productImages = imgMap || {};

  const active = recs.active || recs.items || [];
  const resolved = recs.resolved || [];
  state.pendingCount = active.length;
  state.home = { ov, active, resolved, hWin, meta };
  renderNav();

  const w = ov.window || hWin?.window || { label: WINDOWS.find((x) => x.key === win)?.label };

  if (!ov.connected) {
    view.innerHTML = `${homeHeader(ov, meta)}${windowBar(w)}<div class="amb-panel amb-empty">${E(ov.message || 'اربط حساب Meta Ads من صفحة AI Intelligence الأول.')}</div>`;
    wireHeader();
    return;
  }

  const aW = hWin?.accountAvg || {};
  const aP = hPrev?.accountAvg || {};
  const k = ov.kpis || {};
  const spend = k.spend ?? aW.spend;
  const cpa = k.avgCpa ?? aW.cpa;
  const orders = k.orders ?? aW.purchases;
  const net = k.netProfit ?? null;
  const showTrend = win === 'today';

  view.innerHTML = `
    ${homeHeader(ov, meta)}
    ${windowBar(w)}
    <div class="amb-kpis">
      ${kpiCard('إجمالي الإنفاق', fmtEGP(spend), 'money', 'red', showTrend ? trend(spend, aP.spend, false) : '')}
      ${kpiCard('متوسط CPA', fmtEGP(cpa), 'target', 'purple', showTrend ? trend(cpa, aP.cpa, true) : '')}
      ${kpiCard('الطلبات', fmtNum(orders), 'cart', 'blue', showTrend ? trend(orders, aP.purchases, false) : '')}
      ${kpiCard('صافي الربح', net == null ? '—' : fmtEGP(net), 'wallet', 'green', '')}
    </div>

    <div class="amb-filters" id="ambFilters"></div>

    <div class="amb-grid">
      <div class="amb-col-main">
        <div class="amb-section-h">
          <div class="t">${ic('bulb', 'ic')} القرارات المقترحة من الذكاء الاصطناعي</div>
          <span class="amb-sort">${resolved.length ? `${resolved.filter((r) => ['RESOLVED_EXTERNALLY', 'NO_LONGER_APPLICABLE'].includes(r.status)).length} توصية اتحلّت` : ''}</span>
        </div>
        <div id="ambScaleWinners"></div>
        <div id="ambRecBatchNote"></div>
        <div id="ambRecList"></div>
      </div>
      <div class="amb-col-side" id="ambSide"></div>
    </div>
    <div id="ambHomeSchedules"></div>`;

  wireHeader();
  renderFilters(active);
  renderRecBatchNote(active, w);
  renderRecList(active);
  renderSide(ov, meta, hWin, active);
  renderScaleWinners().catch(() => {});
  if ($('ambHomeSchedules')) renderHomeSchedules($('ambHomeSchedules')).catch(() => {});
}

// ===========================================================================
// AI Suggested Decisions — Winner → Scale  (this section only)
// ===========================================================================
const scaleUi = new Map(); // sourceCampaignId -> { open, budgetMode, sel, cboBudget, abo:[{budget,sel}], mode, date, time }

function scaleState(card) {
  let s = scaleUi.get(card.sourceCampaignId);
  if (!s) {
    const firstSel = card.bestWinnerAdId ? new Set([card.bestWinnerAdId]) : new Set(card.defaults.selectedAdIds || []);
    s = {
      open: false,
      budgetMode: card.sourceBudgetType === 'ABO' ? 'ABO' : 'CBO', // preselect source type; owner is authoritative
      sel: new Set(card.defaults.selectedAdIds || []),             // CBO ad selection
      cboBudget: '',
      abo: [{ budget: '', sel: new Set(firstSel) }],               // ABO slots
      mode: 'RUN_NOW',
      date: card.defaults.startDate || cairoDateStr(1),
      time: card.defaults.startTime || '00:00',
    };
    scaleUi.set(card.sourceCampaignId, s);
  }
  return s;
}
/** ABO config is submittable: ≥1 slot, and every slot has a budget>0 and ≥1 ad. */
function scaleAboValid(s) {
  return s.abo.length >= 1 && s.abo.every((sl) => Number(sl.budget) > 0 && sl.sel.size >= 1);
}
/** Why "موافق على الاسكيل" is (or isn't) clickable — drives the button + inline hint. */
function scaleApproveState(card, s) {
  if (!state.isAdmin) return { ok: false, reason: 'الاسكيل متاح للـ ADMIN فقط.' };
  if (s.mode === 'SCHEDULE' && !cloneStartInFuture(s.date, s.time)) return { ok: false, reason: 'لازم يكون تاريخ ووقت البداية في المستقبل.' };
  if (s.budgetMode === 'ABO') {
    const noBudget = s.abo.some((sl) => !(Number(sl.budget) > 0));
    const noAds = s.abo.some((sl) => sl.sel.size < 1);
    if (noBudget && noAds) return { ok: false, reason: 'كل Ad Set محتاج ميزانية يومية أكبر من صفر وإعلان واحد على الأقل.' };
    if (noBudget) return { ok: false, reason: 'أدخل ميزانية يومية (أكبر من صفر) لكل Ad Set.' };
    if (noAds) return { ok: false, reason: 'اختر إعلانًا واحدًا على الأقل لكل Ad Set.' };
    return { ok: true, reason: '' };
  }
  const sel = card.ads.filter((a) => s.sel.has(a.adId)).length;
  if (!sel && !(Number(s.cboBudget) > 0)) return { ok: false, reason: 'اختر إعلانًا رابحًا وأدخِل ميزانية الحملة اليومية.' };
  if (!sel) return { ok: false, reason: 'اختر إعلانًا رابحًا واحدًا على الأقل.' };
  if (!(Number(s.cboBudget) > 0)) return { ok: false, reason: 'أدخل ميزانية الحملة اليومية (أكبر من صفر).' };
  return { ok: true, reason: '' };
}
/** Patch the approve button + hint in place (no full re-render → input keeps focus). */
function syncScaleApprove(card) {
  const s = scaleUi.get(card.sourceCampaignId); if (!s) return;
  const cid = card.sourceCampaignId;
  const esc = (window.CSS && CSS.escape) ? CSS.escape(cid) : cid;
  const btn = document.querySelector(`[data-scw-act="approve"][data-scw="${esc}"]`);
  if (!btn) return;
  const { ok, reason } = scaleApproveState(card, s);
  btn.disabled = !ok;
  const hint = btn.closest('.amb-scale-exp')?.querySelector('.amb-scale-hint');
  if (hint) { hint.textContent = ok ? '' : reason; hint.hidden = ok; }
}
/** Compact winner-ad row (checkbox). `attr` is the data-* wiring attribute string. */
function scaleAdRow(a, checked, attr) {
  return `<label class="amb-scale-ad ${checked ? 'sel' : ''} ${a.qualifies ? '' : 'dim'}">
    <input type="checkbox" ${attr} ${checked ? 'checked' : ''} />
    <span class="an">${E(a.adName)}${a.bestWinner ? ` <span class="amb-badge best">🏆 BEST WINNER</span>` : ''}</span>
    <span class="am faint">${a.orders} طلب · CPA ${a.cpa == null ? '—' : fmtEGP(a.cpa)} · صرف ${fmtEGP(a.spend)}${a.creativeType ? ` · ${E(a.creativeType)}` : ''}</span>
    <span class="aid faint mono">${E(a.adId)}</span>
  </label>`;
}

let _scaleData = null; // last /scale/winners payload (re-rendered locally on card interaction)
async function renderScaleWinners(cached) {
  const el = $('ambScaleWinners');
  if (!el) return;
  let data = cached || _scaleData;
  if (!cached) {
    try { data = await api.get(`/api/ai-media-buyer/scale/winners?window=${state.window}`); }
    catch { el.innerHTML = ''; return; }
    _scaleData = data;
  }
  const cards = (data.cards || []).filter((c) => c.decisionStatus === 'PENDING' || (scaleUi.get(c.sourceCampaignId)?.open));
  if (!cards.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="amb-scale-wrap">
      <div class="amb-scale-h">🚀 جاهزة للاسكيل <span class="faint">— طلب ≥ 1 و CPA ≤ ${data.winnerCpaEgp} ج.م</span></div>
      ${cards.map(scaleCardHtml).join('')}
    </div>`;
  wireScaleCards(el, data);
}
const rerenderScale = () => renderScaleWinners(_scaleData);

function scaleCardHtml(card) {
  const s = scaleState(card);
  return `<div class="amb-scale-card ${s.open ? 'open' : ''}" data-scw="${E(card.sourceCampaignId)}">
    <div class="amb-scale-top">
      <div class="amb-scale-name">
        <div class="pn">${E(card.displayName)}</div>
        <div class="cn faint">${E(card.sourceCampaignName)}</div>
      </div>
      <div class="amb-scale-nums">
        <div class="nb"><b>${fmtNum(card.orders)}</b><span>طلب</span></div>
        <div class="nb"><b>${fmtEGP(card.cpa)}</b><span>CPA</span></div>
        <div class="nb"><b>${fmtNum(card.winningCreativeCount)}</b><span>كرياتيف رابح</span></div>
      </div>
      <div class="amb-scale-cta">
        <span class="amb-badge scale">Recommended for Scaling</span>
        <button class="amb-btn ${s.open ? 'ghost' : 'primary'} sm" data-scw-act="toggle" data-scw="${E(card.sourceCampaignId)}">${s.open ? 'إغلاق' : 'Review Scale'}</button>
        ${!s.open ? `<button class="amb-btn ghost sm" data-scw-act="reject" data-scw="${E(card.sourceCampaignId)}">رفض</button>` : ''}
      </div>
    </div>
    ${s.open ? scaleExpandedHtml(card, s) : ''}
  </div>`;
}

function scaleExpandedHtml(card, s) {
  const sched = s.mode === 'SCHEDULE';
  const futureOk = !sched || cloneStartInFuture(s.date, s.time);
  const cid = E(card.sourceCampaignId);
  const isAbo = s.budgetMode === 'ABO';

  // --- CBO derived ---
  const cboSel = card.ads.filter((a) => s.sel.has(a.adId));
  const cboBudgetOk = Number(s.cboBudget) > 0;
  const cboReqAdSets = new Set(cboSel.map((a) => a.adsetId)).size;

  // --- ABO derived ---
  const aboTotalDaily = s.abo.reduce((t, sl) => t + (Number(sl.budget) || 0), 0);
  const aboInstances = s.abo.reduce((t, sl) => t + sl.sel.size, 0);

  const approve = scaleApproveState(card, s);
  const canApprove = approve.ok;

  return `<div class="amb-scale-exp">
    <div class="amb-scale-sec">
      <div class="t">الأداء</div>
      <div class="amb-scale-perf">
        <span><b>${fmtNum(card.orders)}</b> طلب</span>
        <span><b>${fmtEGP(card.cpa)}</b> CPA</span>
        <span><b>${fmtEGP(card.spend)}</b> صرف</span>
      </div>
      <div class="amb-scale-reco">${E(card.recommendation)}</div>
    </div>

    <div class="amb-scale-sec">
      <div class="t">نوع توزيع الميزانية</div>
      <div class="amb-scale-seg">
        <button class="${!isAbo ? 'on' : ''}" data-scw-bmode="CBO" data-scw="${cid}">CBO — ميزانية الحملة</button>
        <button class="${isAbo ? 'on' : ''}" data-scw-bmode="ABO" data-scw="${cid}">ABO — ميزانية مجموعات الإعلانات</button>
      </div>
      <div class="faint" style="font-size:11.5px; margin-top:4px;">المصدر: ${card.sourceBudgetType === 'ABO' ? 'ABO' : 'CBO'} — تقدر تغيّر قبل الموافقة.</div>
    </div>

    ${isAbo ? `
    <div class="amb-scale-sec">
      <div class="t" style="display:flex; align-items:center; justify-content:space-between;">
        <span>عدد الـ Ad Sets</span>
        <span class="amb-scale-step">
          <button data-scw-abo-dec data-scw="${cid}" ${s.abo.length <= 1 ? 'disabled' : ''}>−</button>
          <b>${s.abo.length}</b>
          <button data-scw-abo-inc data-scw="${cid}">+</button>
        </span>
      </div>
      ${s.abo.map((sl, i) => `
        <div class="amb-scale-slot">
          <div class="sh">Ad Set ${i + 1}</div>
          <div class="field" style="max-width:190px;">
            <label>الميزانية اليومية (ج.م)</label>
            <input type="number" min="1" step="1" placeholder="مثال: 300" value="${E(sl.budget)}" data-scw-abo-budget="${i}" data-scw="${cid}" />
          </div>
          <div class="slot-ads">
            ${card.ads.map((a) => scaleAdRow(a, sl.sel.has(a.adId), `data-scw-abo-ad="${i}:${E(a.adId)}" data-scw="${cid}"`)).join('')}
          </div>
        </div>`).join('')}
      <div class="faint" style="font-size:11.5px;">نفس الإعلان في أكثر من Ad Set = نُسخ مقصودة (يُنشأ إعلان لكل تعيين).</div>
    </div>
    ` : `
    <div class="amb-scale-sec">
      <div class="t">الإعلانات الرابحة — اختَر ما تريد اسكيله</div>
      ${card.ads.map((a) => scaleAdRow(a, s.sel.has(a.adId), `data-scw-ad="${E(a.adId)}" data-scw="${cid}"`)).join('')}
      <div class="field" style="max-width:210px; margin-top:8px;">
        <label>ميزانية الحملة اليومية (ج.م / يوم)</label>
        <input type="number" min="1" step="1" placeholder="مثال: 500" value="${E(s.cboBudget)}" data-scw-cbo-budget data-scw="${cid}" />
      </div>
    </div>
    `}

    <div class="amb-scale-sec">
      <div class="t">تشغيل الحملة</div>
      <div class="amb-field-grid">
        <label class="amb-radio-row ${!sched ? 'sel' : ''}" style="cursor:pointer;">
          <input type="radio" name="scwmode-${cid}" value="RUN_NOW" ${!sched ? 'checked' : ''} data-scw-mode data-scw="${cid}" />
          <span class="rr-main">تشغيل الآن — Run Now</span>
        </label>
        <label class="amb-radio-row ${sched ? 'sel' : ''}" style="cursor:pointer;">
          <input type="radio" name="scwmode-${cid}" value="SCHEDULE" ${sched ? 'checked' : ''} data-scw-mode data-scw="${cid}" />
          <span class="rr-main">جدولة البداية — Schedule Start</span>
        </label>
      </div>
      ${sched ? `<div class="amb-field-grid" style="margin-top:6px;">
        <div class="field" style="max-width:180px;"><label>Start Date</label><input type="date" value="${E(s.date)}" min="${E(cairoDateStr(0))}" data-scw-date data-scw="${cid}" /></div>
        <div class="field" style="max-width:150px;"><label>Start Time</label><input type="time" value="${E(s.time)}" data-scw-time data-scw="${cid}" /></div>
        <div class="field" style="max-width:160px;"><label>Timezone</label><input type="text" value="Africa/Cairo" disabled readonly /></div>
      </div>
      ${futureOk ? '' : `<div class="faint" style="font-size:12px; color:var(--amb-red); margin-top:4px;">The selected start date and time must be in the future.</div>`}` : ''}
    </div>

    <div class="amb-scale-sec summary">
      <div class="t">الملخص النهائي</div>
      ${isAbo ? `
        <div class="amb-scale-sum">
          <div><span>الحملة الجديدة</span><b>${E(card.proposedScaleCampaignName)}</b></div>
          <div><span>نوع الميزانية</span><b>ABO</b></div>
        </div>
        ${s.abo.map((sl, i) => `<div class="amb-scale-sumline">Ad Set ${i + 1}: <b>${Number(sl.budget) > 0 ? fmtEGP(Number(sl.budget)) + '/يوم' : '—'}</b> · ${sl.sel.size} إعلان</div>`).join('')}
        <div class="amb-scale-sum" style="margin-top:6px;">
          <div><span>إجمالي الميزانية اليومية</span><b>${fmtEGP(aboTotalDaily)}/يوم</b></div>
          <div><span>Ad instances</span><b>${aboInstances}</b></div>
          <div><span>التشغيل</span><b>${sched ? `${fmtDMY(s.date)} ${fmt12h(s.time)} — القاهرة` : 'الآن'}</b></div>
        </div>
      ` : `
        <div class="amb-scale-sum">
          <div><span>الحملة الجديدة</span><b>${E(card.proposedScaleCampaignName)}</b></div>
          <div><span>نوع الميزانية</span><b>CBO</b></div>
          <div><span>ميزانية الحملة</span><b>${cboBudgetOk ? fmtEGP(Number(s.cboBudget)) + '/يوم' : '—'}</b></div>
          <div><span>Ad Sets</span><b>${cboReqAdSets}</b></div>
          <div><span>Ads</span><b>${cboSel.length}</b></div>
          <div><span>التشغيل</span><b>${sched ? `${fmtDMY(s.date)} ${fmt12h(s.time)} — القاهرة` : 'الآن'}</b></div>
        </div>
      `}
    </div>

    <div class="amb-scale-actions">
      <button class="amb-btn primary" data-scw-act="approve" data-scw="${cid}" ${canApprove ? '' : 'disabled'}>${state.isAdmin ? 'موافق على الاسكيل' : 'الاسكيل متاح للـ ADMIN فقط'}</button>
      <button class="amb-btn ghost" data-scw-act="cancel" data-scw="${cid}">إلغاء</button>
      <div class="amb-scale-hint" ${canApprove ? 'hidden' : ''}>${E(approve.reason)}</div>
    </div>
  </div>`;
}

function wireScaleCards(root, data) {
  const byId = new Map((data.cards || []).map((c) => [c.sourceCampaignId, c]));
  const rerender = rerenderScale;

  root.querySelectorAll('[data-scw-act]').forEach((btn) => {
    const id = btn.dataset.scw;
    const card = byId.get(id);
    const s = card ? scaleState(card) : null;
    btn.onclick = async () => {
      if (!card) return;
      if (btn.dataset.scwAct === 'toggle' || btn.dataset.scwAct === 'cancel') { s.open = btn.dataset.scwAct === 'toggle' ? !s.open : false; rerender(); return; }
      if (btn.dataset.scwAct === 'reject') {
        if (!(await UI.confirmModal({ title: 'رفض الاسكيل', message: `مش هتظهر توصية اسكيل جديدة لـ «${E(card.displayName)}» تاني إلا لو ظهر أداء جديد مؤهل.`, confirmLabel: 'رفض', danger: true }))) return;
        try { await api.post('/api/ai-media-buyer/scale/reject', { sourceCampaignId: card.sourceCampaignId, sourceCampaignName: card.sourceCampaignName, productName: card.productName, windowLabel: card.window.label }); UI.toast('تم الرفض'); scaleUi.delete(card.sourceCampaignId); rerender(); }
        catch (e) { UI.toast(e.message, 'error'); }
        return;
      }
      if (btn.dataset.scwAct === 'approve') {
        const sched = s.mode === 'SCHEDULE';
        if (sched && !cloneStartInFuture(s.date, s.time)) { UI.toast('The selected start date and time must be in the future.', 'error'); return; }
        let body; let summary;
        if (s.budgetMode === 'ABO') {
          if (!scaleAboValid(s)) { UI.toast('كل Ad Set لازم ميزانية أكبر من صفر وإعلان واحد على الأقل.', 'error'); return; }
          const adSets = s.abo.map((sl) => ({ dailyBudgetEgp: Number(sl.budget), selectedAdIds: [...sl.sel] }));
          body = { budgetMode: 'ABO', sourceCampaignId: card.sourceCampaignId, adSets, startMode: s.mode, startAt: sched ? `${s.date}T${s.time}` : null, window: state.window };
          const total = adSets.reduce((t, x) => t + x.dailyBudgetEgp, 0);
          const inst = adSets.reduce((t, x) => t + x.selectedAdIds.length, 0);
          summary = `ABO — ${adSets.length} Ad Set، إجمالي ${fmtEGP(total)}/يوم، ${inst} إعلان.`;
        } else {
          const selectedAdIds = card.ads.filter((a) => s.sel.has(a.adId)).map((a) => a.adId);
          if (!selectedAdIds.length) { UI.toast('اختر إعلانًا واحدًا على الأقل.', 'error'); return; }
          if (!(Number(s.cboBudget) > 0)) { UI.toast('أدخل ميزانية الحملة.', 'error'); return; }
          body = { budgetMode: 'CBO', sourceCampaignId: card.sourceCampaignId, selectedAdIds, campaignBudgetEgp: Number(s.cboBudget), startMode: s.mode, startAt: sched ? `${s.date}T${s.time}` : null, window: state.window };
          summary = `CBO — ميزانية الحملة ${fmtEGP(Number(s.cboBudget))}/يوم، ${selectedAdIds.length} إعلان.`;
        }
        const ok = await UI.confirmModal({
          title: 'تأكيد الاسكيل',
          message: `هيتم إنشاء حملة <b>${E(card.proposedScaleCampaignName)}</b> (متوقفة) بنسخة مطابقة للمصدر.<br>${E(summary)}<br>${sched ? `التشغيل: ${fmtDMY(s.date)} — ${fmt12h(s.time)} — Africa/Cairo.` : 'تشغيل الآن بعد اكتمال النسخ.'}<br>حملة المصدر مش هتتغير. متابعة؟`,
          confirmLabel: sched ? 'موافق وجدولة' : 'موافق وتشغيل', danger: true,
        });
        if (!ok) return;
        // The backend BLOCKS until the clone tree is fully built (or fails).
        btn.disabled = true; btn.textContent = 'جاري إنشاء حملة الاسكيل...';
        try {
          const r = await api.post('/api/ai-media-buyer/scale/execute', body);
          UI.toast(`✅ تم إنشاء حملة الاسكيل بنجاح — ${E(r.scaleCampaignName)} · ${E(r.budgetMode || '')} · ${fmtNum(r.adSetsCreated)} مجموعة · ${fmtNum(r.adsCreated)} إعلان (متوقفة)`);
          scaleUi.delete(card.sourceCampaignId);
          route();
        } catch (e) {
          UI.toast(`فشل إنشاء حملة الاسكيل: ${e.message}`, 'error');
          btn.disabled = false; btn.textContent = 'موافق على الاسكيل';
        }
        return;
      }
    };
  });

  const cardOf = (elm) => byId.get(elm.closest('[data-scw]')?.dataset.scw);

  root.querySelectorAll('[data-scw-bmode]').forEach((b) => {
    b.onclick = () => { const card = cardOf(b); if (card) { scaleState(card).budgetMode = b.dataset.scwBmode === 'ABO' ? 'ABO' : 'CBO'; rerenderScale(); } };
  });
  root.querySelectorAll('[data-scw-abo-inc]').forEach((b) => {
    b.onclick = () => { const card = cardOf(b); if (!card) return; const s = scaleState(card); s.abo.push({ budget: '', sel: new Set() }); rerenderScale(); };
  });
  root.querySelectorAll('[data-scw-abo-dec]').forEach((b) => {
    b.onclick = () => { const card = cardOf(b); if (!card) return; const s = scaleState(card); if (s.abo.length > 1) s.abo.pop(); rerenderScale(); };
  });
  root.querySelectorAll('[data-scw-abo-budget]').forEach((inp) => {
    inp.oninput = () => { const card = cardOf(inp); if (!card) return; scaleState(card).abo[Number(inp.dataset.scwAboBudget)].budget = inp.value; syncScaleApprove(card); };
    inp.onchange = () => rerenderScale();
  });
  root.querySelectorAll('[data-scw-abo-ad]').forEach((cb) => {
    cb.onclick = () => {
      const card = cardOf(cb); if (!card) return;
      const [i, adId] = cb.dataset.scwAboAd.split(':');
      const slot = scaleState(card).abo[Number(i)];
      if (cb.checked) slot.sel.add(adId); else slot.sel.delete(adId);
      rerenderScale();
    };
  });
  root.querySelectorAll('[data-scw-cbo-budget]').forEach((inp) => {
    inp.oninput = () => { const card = cardOf(inp); if (!card) return; scaleState(card).cboBudget = inp.value; syncScaleApprove(card); };
    inp.onchange = () => rerenderScale();
  });
  root.querySelectorAll('[data-scw-ad]').forEach((cb) => {
    cb.onclick = () => { const card = cardOf(cb); if (!card) return; const s = scaleState(card); if (cb.checked) s.sel.add(cb.dataset.scwAd); else s.sel.delete(cb.dataset.scwAd); rerenderScale(); };
  });
  root.querySelectorAll('[data-scw-mode]').forEach((r) => {
    r.onchange = () => { const card = cardOf(r); if (card) { scaleState(card).mode = r.value === 'SCHEDULE' ? 'SCHEDULE' : 'RUN_NOW'; rerenderScale(); } };
  });
  root.querySelectorAll('[data-scw-date]').forEach((d) => { d.onchange = () => { const card = cardOf(d); if (card) { scaleState(card).date = d.value || cairoDateStr(1); rerenderScale(); } }; });
  root.querySelectorAll('[data-scw-time]').forEach((t) => { t.onchange = () => { const card = cardOf(t); if (card) { scaleState(card).time = /^\d{1,2}:\d{2}$/.test(t.value) ? t.value : '00:00'; rerenderScale(); } }; });
}

/**
 * The recommendation batch is generated for one period. When the selected
 * period differs, tell the owner and offer to re-run the AI on THIS period.
 * (Regeneration is analysis-only — it never executes / approves anything.)
 */
function renderRecBatchNote(active, w) {
  const el = $('ambRecBatchNote');
  if (!el) return;
  const batchLabel = active[0]?.timeWindow?.label || null;
  if (!batchLabel || batchLabel === w.label) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="amb-batchnote">
    <span>التوصيات الحالية محسوبة على فترة «${E(batchLabel)}». لتحليل الذكاء الاصطناعي على «${E(w.label)}»:</span>
    <button class="amb-btn primary sm" id="ambRegenForWin">توليد على «${E(w.label)}»</button>
  </div>`;
  $('ambRegenForWin').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = '… بيحلل الفترة';
    try {
      const r = await api.post('/api/ai-media-buyer/recommendations/generate', { window: state.window });
      UI.toast(`✅ ${r.count} توصية على «${w.label}»`);
      route();
    } catch (err) { UI.toast(err.message, 'error'); e.target.disabled = false; e.target.textContent = `توليد على «${w.label}»`; }
  };
}

function homeHeader(ov, meta) {
  const name = (state.me?.name || '').split(/\s+/)[0] || '';
  const last = ov.syncStatus?.lastRun;
  const syncOk = last?.status === 'SUCCESS';
  const acctName = meta?.selectedAdAccount?.name || ov.syncStatus?.selectedAdAccount?.name || 'الحساب المتصل';
  return `
    <div class="amb-head">
      <div>
        <h1>مرحباً ${E(name)} 👋</h1>
        <div class="sub">هنا ملخص أداء إعلاناتك اليوم والقرارات المقترحة من الذكاء الاصطناعي</div>
      </div>
      <div class="amb-head-tools">
        <span class="amb-chip ${syncOk ? '' : last?.status === 'FAILED' ? 'err' : 'warn'}"><span class="dot"></span>${last ? `محدّث ${timeAgo(last.at)}` : 'لم تتم مزامنة بعد'}</span>
        <span class="amb-select" title="الحساب الإعلاني">${ic('meta', 'ic')} ${E(acctName)}</span>
        <button class="amb-iconbtn" id="ambSync" title="مزامنة الآن">${ic('refresh', 'ic')}</button>
      </div>
    </div>`;
}

/** Apple-style segmented period control + the real date/range under it. */
function windowBar(w) {
  return `
    <div class="amb-period">
      <div class="amb-seg" id="ambSeg">
        ${WINDOWS.map((x) => `<button class="amb-seg-btn ${x.key === state.window ? 'active' : ''}" data-win="${x.key}">${E(x.label)}</button>`).join('')}
      </div>
      <div class="amb-period-date">${E(windowDateText(w))}</div>
    </div>`;
}
function wireWindowBar() {
  document.querySelectorAll('#ambSeg [data-win]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.win === state.window) return;
      state.window = b.dataset.win;
      route(); // re-fetches every panel for the new period; never executes anything
    };
  });
}
function wireHeader() {
  const b = $('ambSync');
  if (b) b.onclick = syncNow;
  wireWindowBar();
}

async function syncNow() {
  const b = $('ambSync');
  if (b) b.classList.add('busy');
  try {
    const r = await api.post('/api/ai-media-buyer/sync/run', {});
    if (r.skipped) UI.toast(`المزامنة اتخطت: ${r.skipped}`, 'error');
    else UI.toast(`✅ اتزامن ${r.snapshotRows} صف`);
  } catch (err) {
    UI.toast(err.message, 'error');
  } finally {
    if (b) b.classList.remove('busy');
    route();
  }
}

function kpiCard(label, value, icon, tone, trendHtml) {
  const m = /(\d[\d.,]*)\s*(ج\.م|x)?/.exec(value);
  const num = m ? m[1] : value;
  const cur = m && m[2] ? m[2] : '';
  return `<div class="amb-kpi">
    <div class="k-top"><span class="k-label">${E(label)}</span><span class="k-ic ${tone}">${ic(icon, 'ic')}</span></div>
    <div class="k-val">${E(num)}${cur ? `<span class="cur">${E(cur)}</span>` : ''}</div>
    ${trendHtml || ''}
  </div>`;
}
/** lowerIsBetter inverts the good/bad colour (e.g. CPA going down is good). */
function trend(now, prev, lowerIsBetter) {
  const a = Number(now), b = Number(prev);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return '';
  const pct = ((a - b) / Math.abs(b)) * 100;
  if (Math.abs(pct) < 0.5) return `<div class="k-trend"><span class="muted">ثابت عن أمس</span></div>`;
  const up = pct > 0;
  const good = lowerIsBetter ? !up : up;
  return `<div class="k-trend ${good ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(Math.round(pct))}% <span class="muted">عن أمس</span></div>`;
}

// ---- filters ----
const CAT_META = {
  all: { label: 'الكل', dot: '' },
  need: { label: 'يحتاج قرار', dot: 'red' },
  SCALE: { label: 'فرص Scaling', dot: 'green' },
  PAUSE_CANDIDATE: { label: 'إيقاف', dot: 'red' },
  NEW_CREATIVE_NEEDED: { label: 'كرياتيف جديد', dot: 'blue' },
};
function renderFilters(active) {
  const counts = {
    all: active.length,
    need: active.length,
    SCALE: active.filter((r) => r.category === 'SCALE').length,
    PAUSE_CANDIDATE: active.filter((r) => r.category === 'PAUSE_CANDIDATE').length,
    NEW_CREATIVE_NEEDED: active.filter((r) => r.category === 'NEW_CREATIVE_NEEDED').length,
  };
  $('ambFilters').innerHTML = `
    ${Object.entries(CAT_META).map(([key, m]) => `
      <button class="amb-fbtn ${state.filter === key ? 'active' : ''}" data-f="${key}">
        ${m.dot ? `<span class="fdot ${m.dot}"></span>` : ''}${E(m.label)} <span class="fcount">(${counts[key] || 0})</span>
      </button>`).join('')}
    <div class="amb-search">${ic('search', 's-ic')}<input type="text" id="ambSearch" placeholder="ابحث عن حملة أو منتج..." value="${E(state.search)}" /></div>`;
  $('ambFilters').querySelectorAll('[data-f]').forEach((b) => {
    b.onclick = () => { state.filter = b.dataset.f; renderFilters(state.home.active); renderRecList(state.home.active); };
  });
  const s = $('ambSearch');
  s.oninput = () => { state.search = s.value; renderRecList(state.home.active); };
  s.onkeydown = (e) => { if (e.key === 'Enter') e.preventDefault(); };
}

function filteredRecs(active) {
  let list = active;
  if (state.filter !== 'all' && state.filter !== 'need') list = list.filter((r) => r.category === state.filter);
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter((r) => [r.entityName, r.campaignName, r.adsetName, r.adName, r.productName].some((x) => (x || '').toLowerCase().includes(q)));
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return [...list].sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || new Date(b.createdAt) - new Date(a.createdAt));
}

function renderRecList(active) {
  const list = filteredRecs(active);
  const el = $('ambRecList');
  if (!el) return;
  el.innerHTML = list.length ? list.map(recCardV2).join('') : `<div class="amb-panel amb-empty">مفيش توصيات في التصنيف ده دلوقتي.</div>`;
  el.querySelectorAll('[data-rec]').forEach((b) => {
    const id = Number(b.dataset.rec);
    const act = b.dataset.act;
    if (act === 'approve') b.onclick = () => approveRec(id, b);
    else if (act === 'reject') b.onclick = () => rejectRec(id);
    else if (act === 'details') b.onclick = () => showRecDetails(id);
  });
}

// ---- compact recommendation card (reference style) ----
const CHIP = {
  SCALE: { cls: 'scale', label: 'فرصة Scaling', icon: 'rocket' },
  PAUSE_CANDIDATE: { cls: 'pause', label: 'إيقاف', icon: 'stop' },
  NEW_CREATIVE_NEEDED: { cls: 'creative', label: 'كرياتيف جديد', icon: 'bulb' },
  MONITOR: { cls: 'monitor', label: 'مراقبة', icon: 'chart' },
  HOLD: { cls: 'optimize', label: 'تثبيت', icon: 'target' },
};
const LEVEL_AR = { product: 'منتج', campaign: 'حملة', adset: 'مجموعة إعلانية', ad: 'إعلان' };
const CONF_AR = { HIGH: ['high', 'ثقة عالية'], MEDIUM: ['med', 'ثقة متوسطة'], LOW: ['low', 'ثقة منخفضة'] };

function shortRec(r) {
  if (r.currentBudget != null && r.recommendedBudget != null) {
    return `${r.decision === 'REDUCE_BUDGET' ? 'تقليل' : 'زيادة'} الميزانية من ${fmtEGP(r.currentBudget)} إلى ${fmtEGP(r.recommendedBudget)}`;
  }
  return { PAUSE: 'إيقاف العنصر الآن', PAUSE_LOSER: 'إيقاف العنصر الآن', RESUME: 'تشغيل العنصر',
    DUPLICATE_WINNER: 'تكرار هذا العنصر الرابح في استهداف جديد',
    TEST_NEW_CREATIVE: 'تجهيز كرياتيف جديد حول نفس الزاوية الرابحة',
    MONITOR: 'المتابعة وجمع بيانات أكثر قبل أي قرار',
    HOLD: 'تثبيت الأداء الحالي' }[r.decision] || 'مراجعة الأداء';
}
function shortReason(r) {
  return r.explain?.why || r.explain?.whatHappened || r.reason || '';
}

// Neutral product placeholder (used when a product has no image, or an image fails to load).
const PLACEHOLDER_IMG = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%2398a0ad" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8l9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>');

/** 56x56 product thumbnail — real image via the preloaded map, else the placeholder. */
function productThumb(r) {
  const info = r.ambProductId ? state.productImages[r.ambProductId] : null;
  if (info && info.hasImage) {
    return `<img class="amb-r-thumb" src="/api/ai-media-buyer/products/${r.ambProductId}/image" alt="${E(r.productName || '')}" decoding="async" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}';this.classList.add('ph')" />`;
  }
  return `<img class="amb-r-thumb ph" src="${PLACEHOLDER_IMG}" alt="" />`;
}

/** Product line + full real Meta hierarchy (Campaign → Ad Set → Ad), with honest fallbacks. */
function hierarchyLines(r) {
  const prod = r.productName
    ? `<div class="pnm">${E(r.productName)}</div>`
    : `<div class="pnm muted">غير مرتبط بمنتج</div>`;
  const camp = r.level === 'campaign' ? (r.entityName || r.campaignName) : r.campaignName;
  const lines = [];
  if (r.level === 'campaign') {
    lines.push(`<span>Campaign: <b>${E(camp || 'الحملة غير متاحة')}</b></span>`);
  } else if (r.level === 'adset') {
    lines.push(`<span>Campaign: <b>${E(camp || 'الحملة غير متاحة')}</b></span>`);
    lines.push(`<span>Ad Set: <b>${E(r.entityName || r.adsetName || '—')}</b></span>`);
  } else if (r.level === 'ad') {
    lines.push(`<span>Campaign: <b>${E(camp || 'الحملة غير متاحة')}</b></span>`);
    lines.push(`<span>Ad Set: <b>${E(r.adsetName || '—')}</b></span>`);
    lines.push(`<span>Ad: <b>${E(r.entityName || r.adName || '—')}</b></span>`);
  } else {
    lines.push(`<span>Product: <b>${E(r.entityName || r.productName || '—')}</b></span>`);
  }
  return `${prod}<div class="amb-r-hier">${lines.join('')}</div>`;
}

function recCardV2(r) {
  const m = r.currentMetrics || {};
  const t = r.targetMetrics || {};
  const chip = CHIP[r.category] || CHIP.MONITOR;
  const conf = CONF_AR[r.confidence] || CONF_AR.LOW;
  const canExec = r.executable && r.status === 'PENDING';
  const paused = r.currentStatus && r.currentStatus !== 'ACTIVE';

  let primary = '';
  if (canExec) {
    if (r.category === 'PAUSE_CANDIDATE') primary = `<button class="amb-btn danger" data-rec="${r.id}" data-act="approve">إيقاف الآن</button>`;
    else primary = `<button class="amb-btn primary" data-rec="${r.id}" data-act="approve">موافقة وتنفيذ</button>`;
  } else if (r.category === 'NEW_CREATIVE_NEEDED') {
    primary = `<button class="amb-btn blue" data-rec="${r.id}" data-act="details">إنشاء كرياتيف</button>`;
  } else {
    primary = `<button class="amb-btn" data-rec="${r.id}" data-act="details">عرض الخطة</button>`;
  }

  return `<div class="amb-r">
    <div class="amb-r-chip ${chip.cls}"><span class="ci">${ic(chip.icon, 'ic')}</span>${E(chip.label)}</div>
    <div class="amb-r-body">
      <div class="amb-r-top">
        ${productThumb(r)}
        <div class="amb-r-id">
          ${hierarchyLines(r)}
        </div>
        <div class="amb-r-when">${timeAgo(r.createdAt)}</div>
      </div>
      <div class="amb-r-metrics">
        <div class="m"><div class="ml">CPA</div><div class="mv">${fmtEGP(m.cpa)}</div></div>
        <div class="m"><div class="ml">الطلبات</div><div class="mv">${fmtNum(m.purchases)}</div></div>
        <div class="m"><div class="ml">ROAS</div><div class="mv">${fmtX(m.roas)}</div></div>
        <div class="m"><div class="ml">الإنفاق</div><div class="mv">${fmtEGP(m.spend)}</div></div>
      </div>
      <div class="amb-r-rec">${E(shortRec(r))}</div>
      ${shortReason(r) ? `<div class="amb-r-reason">${E(shortReason(r))}</div>` : ''}
      <div class="amb-r-foot">
        <span class="amb-conf ${conf[0]}">● ${E(conf[1])}</span>
        ${r.currentStatus ? `<span class="amb-metabadge ${paused ? 'paused' : ''}">${E(META_STATUS_AR[r.currentStatus] || r.currentStatus)}</span>` : ''}
        <div class="amb-r-actions">
          ${primary}
          ${r.status === 'PENDING' ? `<button class="amb-btn ghost" data-rec="${r.id}" data-act="reject">رفض</button>` : ''}
          <button class="amb-btn ghost" data-rec="${r.id}" data-act="details">التفاصيل</button>
        </div>
      </div>
    </div>
  </div>`;
}

// ---- right column ----
function renderSide(ov, meta, hWin, active) {
  const el = $('ambSide');
  if (!el) return;
  const winLabel = WINDOWS.find((x) => x.key === state.window)?.label || '';

  // Block 1 — ad account status
  const last = ov.syncStatus?.lastRun;
  const connected = !!(meta?.connected ?? ov.connected);
  const acctName = meta?.selectedAdAccount?.name || 'الحساب المتصل';
  const st = !connected ? { c: 'err', t: 'منفصل' }
    : last?.status === 'RUNNING' ? { c: 'sync', t: 'مزامنة' }
    : last?.status === 'FAILED' ? { c: 'err', t: 'خطأ' }
    : { c: 'ok', t: 'نشط' };
  const acctBlock = `<div class="amb-panel">
    <h3>حالة الحسابات الإعلانية</h3>
    ${connected ? `<div class="amb-acc-row"><span class="ai">${ic('meta', 'ic')}</span><span class="an">${E(acctName)}</span><span class="as ${st.c}">${st.t}</span></div>`
      : `<div class="amb-empty" style="padding:8px 0;">اربط حساب Meta Ads من صفحة AI Intelligence.</div>`}
    ${last ? `<div class="faint" style="font-size:11px; margin-top:8px;">آخر مزامنة ${timeAgo(last.at)} · ${last.snapshotRows ?? 0} صف</div>` : ''}
  </div>`;

  // Block 2 — top products for the selected period (by CPA asc)
  const prods = (hWin?.products || [])
    .filter((p) => p.metrics && p.metrics.cpa != null)
    .sort((a, b) => a.metrics.cpa - b.metrics.cpa)
    .slice(0, 4);
  const prodBlock = `<div class="amb-panel">
    <h3>أفضل المنتجات — ${E(winLabel)}</h3>
    ${prods.length ? prods.map((p, i) => `<div class="amb-prod-row"><span class="rk">${i + 1}</span><span class="pn">${E(p.name)}</span><span class="pc">CPA ${fmtEGP(p.metrics.cpa)}</span></div>`).join('')
      : `<div class="amb-empty" style="padding:8px 0;">اربط الحملات بالمنتجات لعرض الأفضل أداءً.</div>`}
  </div>`;

  // Block 3 — decisions donut
  const dc = {
    Scaling: active.filter((r) => r.category === 'SCALE').length,
    Pause: active.filter((r) => r.category === 'PAUSE_CANDIDATE').length,
    Creative: active.filter((r) => r.category === 'NEW_CREATIVE_NEEDED').length,
    Other: active.filter((r) => ['MONITOR', 'HOLD'].includes(r.category)).length,
  };
  const donutBlock = `<div class="amb-panel">
    <h3>توزيع القرارات</h3>
    <div class="amb-donut-wrap">
      ${donutSvg(dc, active.length)}
      <div class="amb-donut-legend">
        <div class="lg"><span class="sw" style="background:var(--amb-green)"></span> Scaling <span class="lv">${dc.Scaling}</span></div>
        <div class="lg"><span class="sw" style="background:var(--amb-red)"></span> إيقاف <span class="lv">${dc.Pause}</span></div>
        <div class="lg"><span class="sw" style="background:var(--amb-blue)"></span> كرياتيف جديد <span class="lv">${dc.Creative}</span></div>
        ${dc.Other ? `<div class="lg"><span class="sw" style="background:var(--amb-text-faint)"></span> متابعة <span class="lv">${dc.Other}</span></div>` : ''}
      </div>
    </div>
  </div>`;

  el.innerHTML = acctBlock + prodBlock + donutBlock;
}

function donutSvg(counts, total) {
  const segs = [
    ['#15924f', counts.Scaling], ['#d33f3f', counts.Pause], ['#2f6bff', counts.Creative], ['#98a0ad', counts.Other],
  ].filter(([, v]) => v > 0);
  const sum = segs.reduce((s, [, v]) => s + v, 0) || 1;
  const R = 42, C = 2 * Math.PI * R;
  let offset = 0;
  const rings = segs.map(([col, v]) => {
    const len = (v / sum) * C;
    const el = `<circle r="${R}" cx="54" cy="54" fill="none" stroke="${col}" stroke-width="14" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 54 54)"/>`;
    offset += len;
    return el;
  }).join('');
  return `<svg class="amb-donut" viewBox="0 0 108 108">
    <circle r="${R}" cx="54" cy="54" fill="none" stroke="#eef0f3" stroke-width="14"/>
    ${rings}
    <text x="54" y="50" text-anchor="middle" font-size="22" font-weight="800" fill="#171e2e">${total}</text>
    <text x="54" y="66" text-anchor="middle" font-size="10" fill="#98a0ad">قرارات</text>
  </svg>`;
}

// ===========================================================================
// Actions — UNCHANGED behaviour, restyled confirm/toasts only.
// ===========================================================================
async function approveRec(id, btn) {
  const ok = await UI.confirmModal({
    title: 'موافقة وتنفيذ على Meta',
    message: 'هيتبعت أمر حقيقي لحساب Meta Ads بعد إعادة تحقّق من الأرقام الحالية. متابعة؟',
    confirmLabel: 'نفّذ الآن', danger: true,
  });
  if (!ok) return;
  if (btn) btn.disabled = true;
  try {
    const r = await api.post(`/api/ai-media-buyer/recommendations/${id}/approve`, {});
    if (r.ok) UI.toast('✅ اتنفّذ على Meta');
    else if (r.aborted) UI.toast(`⛔ اتوقف: ${r.message}`, 'error');
    else UI.toast(r.message || 'ماتنفّذش', 'error');
  } catch (err) {
    UI.toast(err.message, 'error');
    if (btn) btn.disabled = false;
    return;
  }
  route();
}
async function rejectRec(id) {
  try { await api.post(`/api/ai-media-buyer/recommendations/${id}/reject`, {}); UI.toast('اترفضت'); }
  catch (err) { UI.toast(err.message, 'error'); }
  route();
}
async function editRec(id) {
  const r = await api.get(`/api/ai-media-buyer/recommendations/${id}`);
  const val = prompt(`الميزانية المقترحة الجديدة (الحالية ${fmtEGP(r.currentBudget)}، مسموح ±20% لكل أكشن):`, r.recommendedBudget);
  if (val === null) return;
  try { await api.patch(`/api/ai-media-buyer/recommendations/${id}`, { recommendedBudget: Number(val) }); UI.toast('✅ اتعدّل'); route(); }
  catch (err) { UI.toast(err.message, 'error'); }
}
async function dryRunRec(id) {
  openDrawer('<div class="drawer-section faint">بيتحقق من مسار التنفيذ على Meta (بدون أي تغيير)…</div>');
  try {
    const d = await api.get(`/api/ai-media-buyer/recommendations/${id}/dry-run`);
    const verdictAr = { READY: '🟢 جاهز للتنفيذ', WOULD_ABORT_REANALYSIS: '⚠️ هيتوقف — محتاج إعادة تحليل', WOULD_BLOCK_RULES: '🔴 فحص القواعد هيرفض', DRAFT_ONLY: 'مسودة فقط', BLOCKED: '🔴 متوقف' }[d.verdict] || d.verdict;
    openDrawer(`
      <div class="drawer-header"><div class="drawer-title">تحقّق من مسار التنفيذ</div><button class="drawer-close" id="ambDrawerX">×</button></div>
      <div class="drawer-section">
        <div style="font-weight:800; margin-bottom:8px;">${E(verdictAr)}</div>
        ${d.note ? `<div class="faint" style="font-size:12.5px; margin-bottom:8px;">${E(d.note)}</div>` : ''}
        <div class="amb-derived">
          <div class="amb-derived-row"><span>وصول لـ Meta</span><b>${d.canReachMeta ? 'نعم' : 'لا'}</b></div>
          ${d.live ? `<div class="amb-derived-row"><span>حالة العنصر الحيّة</span><b>${E(d.live.status || '—')}</b></div>` : ''}
          ${d.live && d.live.budgetMajor != null ? `<div class="amb-derived-row"><span>الميزانية الحيّة</span><b>${fmtEGP(d.live.budgetMajor)}</b></div>` : ''}
          ${d.materiality ? `<div class="amb-derived-row"><span>تغيّر مؤثر منذ التوصية؟</span><b>${d.materiality.material ? 'نعم — إعادة تحليل' : 'لا'}</b></div>` : ''}
          ${d.revalidation ? `<div class="amb-derived-row"><span>إعادة التحقّق من القواعد</span><b>${d.revalidation.passed ? 'نجحت' : 'رفضت'}</b></div>` : ''}
        </div>
        ${d.plannedRequest ? `<div class="section-title">الطلب اللي هيتبعت لـ Meta (لو وافقت)</div>
          <pre style="white-space:pre-wrap; font-size:11.5px; background:var(--amb-surface-2); padding:10px; border-radius:8px;">${E(d.plannedRequest.endpoint)}\n${E(JSON.stringify(d.plannedRequest.body, null, 1))}${d.plannedRequest.humanReadable ? '\n// ' + E(d.plannedRequest.humanReadable) : ''}</pre>` : ''}
        ${d.revalidation ? `<div class="section-title">فحوصات القواعد</div><div class="amb-rec-checks">${(d.revalidation.checks || []).map((c) => `<div class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✔' : '✖'} ${E(c.name)} — ${E(c.detail)}</div>`).join('')}</div>` : ''}
        <div class="faint" style="font-size:11.5px; margin-top:10px;">مفيش أي حاجة اتبعتت لـ Meta. ده تحقّق فقط.</div>
        <div class="toolbar" style="margin-top:12px;"><button class="amb-btn" id="ambDrawerX2">إغلاق</button></div>
      </div>`);
    $('ambDrawerX').onclick = closeDrawer;
    $('ambDrawerX2').onclick = closeDrawer;
  } catch (err) {
    openDrawer(`<div class="drawer-section"><div class="amb-empty">⚠️ ${E(err.message)}</div><button class="amb-btn" id="ambDrawerX2">إغلاق</button></div>`);
    $('ambDrawerX2').onclick = closeDrawer;
  }
}

const DECISION_AR = {
  SCALE: 'توسّع', HOLD: 'تثبيت', MONITOR: 'مراقبة', PAUSE: 'إيقاف', PAUSE_LOSER: 'إيقاف خاسر',
  REDUCE_BUDGET: 'تقليل ميزانية', INCREASE_BUDGET: 'زيادة ميزانية', DUPLICATE_WINNER: 'تكرار البطل',
  TEST_NEW_CREATIVE: 'اختبار كرياتيف جديد', TEST_NEW_HOOK: 'اختبار هوك جديد', TEST_NEW_AUDIENCE: 'اختبار جمهور جديد',
};
const STATUS_AR = {
  PENDING: 'بانتظار قرارك', APPROVED: 'موافَق عليها', REJECTED: 'مرفوضة', EXECUTED: 'اتنفّذت',
  SUPERSEDED: 'محدّثة', NEEDS_REANALYSIS: 'محتاجة إعادة تحليل', EXPIRED: 'منتهية',
  RESOLVED_EXTERNALLY: 'اتحلّت من Meta', NO_LONGER_APPLICABLE: 'خارج النطاق',
};
const STATUS_BADGE = { EXECUTED: 'green', RESOLVED_EXTERNALLY: 'green', NEEDS_REANALYSIS: 'red', NO_LONGER_APPLICABLE: 'gray', PENDING: 'blue' };
const META_STATUS_AR = { ACTIVE: 'شغّال', PAUSED: 'متوقف', CAMPAIGN_PAUSED: 'الحملة متوقفة', ADSET_PAUSED: 'المجموعة متوقفة', ARCHIVED: 'مؤرشف', DELETED: 'محذوف', DISAPPROVED: 'مرفوض', PENDING_REVIEW: 'تحت المراجعة', IN_PROCESS: 'قيد التجهيز', WITH_ISSUES: 'به مشاكل' };
const CONF_FULL = { HIGH: 'ثقة عالية', MEDIUM: 'ثقة متوسطة', LOW: 'ثقة منخفضة' };
const RISK_AR = { LOW: 'مخاطرة منخفضة', MEDIUM: 'مخاطرة متوسطة', HIGH: 'مخاطرة عالية' };
const DS_AR = { STRONG: 'بيانات قوية', MODERATE: 'بيانات كافية', WEAK: 'بيانات قليلة' };

/** Full details drawer — this is where ALL advanced/technical detail lives now. */
async function showRecDetails(id) {
  openDrawer('<div class="drawer-section faint">جارِ التحميل…</div>');
  const r = await api.get(`/api/ai-media-buyer/recommendations/${id}`);
  const re = r.ruleEngine || {};
  const ex = r.explain || {};
  const m = r.currentMetrics || {};
  const learning = r.dataSufficiency === 'WEAK';

  let econHtml = '';
  let prodMeta = null;
  if (r.ambProductId) {
    try {
      const d = await api.get(`/api/ai-media-buyer/products/${r.ambProductId}?window=today`);
      const e = d.economics || {}, pm = d.metrics || {};
      prodMeta = d.product || null;
      econHtml = `
        <div class="section-title">اقتصاديات المنتج</div>
        <div class="amb-derived">
          <div class="amb-derived-row"><span>تكلفة المنتج</span><b>${fmtEGP(e.productCost)}</b></div>
          <div class="amb-derived-row"><span>سعر البيع</span><b>${fmtEGP(e.effectiveSellingPrice)}</b></div>
          <div class="amb-derived-row"><span>شحن + تغليف + أخرى</span><b>${fmtEGP((e.baseOperationalCost || 0) - (e.productCost || 0))}</b></div>
          <div class="amb-derived-row"><span>Break-even CPA</span><b>${fmtEGP(e.codBreakEvenCpa ?? e.breakEvenCpa)}</b></div>
          <div class="amb-derived-row"><span>CPA الحالي</span><b>${fmtEGP(m.cpa)}</b></div>
          <div class="amb-derived-row"><span>صافي ربح المنتج (اليوم)</span><b>${fmtEGP(pm.netProfit)}</b></div>
        </div>`;
    } catch { /* product may not exist — hide the block */ }
  }

  openDrawer(`
    <div class="drawer-header"><div class="drawer-title">تفاصيل التوصية</div><button class="drawer-close" id="ambDrawerX">×</button></div>
    <div class="drawer-section">
      <div style="font-weight:800; font-size:15px; margin-bottom:4px;">${E(DECISION_AR[r.decision] || r.decision)} — ${E(r.entityName || '')}</div>
      <div class="faint" style="font-size:12px; margin-bottom:10px;">
        Meta · ${E(LEVEL_AR[r.level] || r.level)}
        ${r.campaignName ? ` · حملة: ${E(r.campaignName)}` : ''}${r.adsetName ? ` · مجموعة: ${E(r.adsetName)}` : ''}${r.adName ? ` · إعلان: ${E(r.adName)}` : ''}
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
        <span class="amb-conf ${(CONF_AR[r.confidence] || CONF_AR.LOW)[0]}">${E(CONF_FULL[r.confidence] || r.confidence)}</span>
        <span class="badge gray">${E(RISK_AR[r.riskLevel] || r.riskLevel)}</span>
        <span class="badge gray">${E(DS_AR[r.dataSufficiency] || r.dataSufficiency)}</span>
        <span class="badge ${STATUS_BADGE[r.status] || 'gray'}">${E(STATUS_AR[r.status] || r.status || 'PENDING')}</span>
        ${r.currentStatus ? `<span class="badge ${r.currentStatus === 'ACTIVE' ? 'blue' : 'yellow'}">Meta: ${E(META_STATUS_AR[r.currentStatus] || r.currentStatus)}</span>` : ''}
      </div>
      ${learning ? `<div class="amb-derived" style="margin-bottom:10px;">⚠️ الحملة لسه في مرحلة التعلّم — البيانات قليلة، فالقرار مبدئي.</div>` : ''}
      ${r.resolutionNote ? `<div class="amb-derived" style="margin-bottom:10px;">📌 ${E(r.resolutionNote)}${r.resolvedAt ? ` <span class="faint">(${fmtDT(r.resolvedAt)})</span>` : ''}</div>` : ''}

      <div class="section-title">شرح القرار</div>
      <div class="amb-drawer-explain">
        ${ex.whatHappened ? `<div class="row"><b>إيه اللي حصل؟</b><span>${E(ex.whatHappened)}</span></div>` : ''}
        ${ex.why ? `<div class="row"><b>ليه؟</b><span>${E(ex.why)}</span></div>` : ''}
        ${ex.whatToDo ? `<div class="row"><b>الإجراء</b><span>${E(ex.whatToDo)}</span></div>` : `<div class="row"><b>الإجراء</b><span>${E(r.reason || '—')}</span></div>`}
        ${ex.expectedBenefit ? `<div class="row"><b>الفايدة المتوقعة</b><span>${E(ex.expectedBenefit)}</span></div>` : ''}
        ${ex.risk ? `<div class="row"><b>المخاطرة</b><span>${E(ex.risk)}</span></div>` : ''}
        ${ex.dataSupport ? `<div class="row"><b>دعم البيانات</b><span>${E(ex.dataSupport)}</span></div>` : ''}
      </div>

      <div class="section-title">الأرقام الحالية</div>
      <div class="amb-derived">
        <div class="amb-derived-row"><span>CPA</span><b>${fmtEGP(m.cpa)}</b></div>
        <div class="amb-derived-row"><span>الهدف</span><b>${fmtEGP(r.targetMetrics?.targetCpa)}</b></div>
        <div class="amb-derived-row"><span>الإنفاق</span><b>${fmtEGP(m.spend)}</b></div>
        <div class="amb-derived-row"><span>الطلبات</span><b>${fmtNum(m.purchases)}</b></div>
        <div class="amb-derived-row"><span>ROAS</span><b>${fmtX(m.roas)}</b></div>
        ${r.currentBudget != null ? `<div class="amb-derived-row"><span>الميزانية</span><b>${fmtEGP(r.currentBudget)} ← ${fmtEGP(r.recommendedBudget)} (${r.budgetChangePct > 0 ? '+' : ''}${fmtNum(r.budgetChangePct)}%)</b></div>` : ''}
      </div>

      ${econHtml}

      <div class="section-title">فحص القواعد</div>
      <div class="amb-rec-checks">
        ${(re.checks || []).map((c) => `<div class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✔' : '✖'} ${E(c.name)} — ${E(c.detail)}</div>`).join('') || '<div class="faint">مفيش تفاصيل.</div>'}
      </div>
      ${re.blockers && re.blockers.length ? `<div style="margin-top:8px; color:var(--amb-red); font-size:12.5px;">موانع: ${re.blockers.map(E).join(' / ')}</div>` : ''}

      <div class="section-title">المنتج والهيكل الإعلاني</div>
      <div class="amb-derived">
        ${r.productName || prodMeta?.productName ? `<div class="amb-derived-row"><span>اسم المنتج</span><b>${E(prodMeta?.productName || r.productName)}</b></div>` : '<div class="amb-derived-row"><span>المنتج</span><b>غير مرتبط بمنتج</b></div>'}
        ${r.ambProductId ? `<div class="amb-derived-row"><span>معرّف المنتج (AI Media Buyer)</span><b class="mono">${E(r.ambProductId)}</b></div>` : ''}
        ${prodMeta?.externalProductRef ? `<div class="amb-derived-row"><span>Product ID (الكتالوج)</span><b class="mono">${E(prodMeta.externalProductRef)}</b></div>` : ''}
        ${prodMeta?.imageUrl ? `<div class="amb-derived-row"><span>رابط صورة المنتج</span><b class="mono" style="max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${E(prodMeta.imageUrl)}</b></div>` : (r.ambProductId && state.productImages[r.ambProductId]?.hasImage ? `<div class="amb-derived-row"><span>صورة المنتج</span><b>من بيانات بحث المنتجات</b></div>` : '')}
        ${r.campaignName ? `<div class="amb-derived-row"><span>الحملة</span><b>${E(r.campaignName)}</b></div>` : ''}
        ${r.campaignId ? `<div class="amb-derived-row"><span>معرّف الحملة</span><b class="mono">${E(r.campaignId)}</b></div>` : ''}
        ${r.adsetName ? `<div class="amb-derived-row"><span>المجموعة الإعلانية</span><b>${E(r.adsetName)}</b></div>` : ''}
        ${r.adsetId ? `<div class="amb-derived-row"><span>معرّف المجموعة</span><b class="mono">${E(r.adsetId)}</b></div>` : ''}
        ${r.adName ? `<div class="amb-derived-row"><span>الإعلان</span><b>${E(r.adName)}</b></div>` : ''}
        ${r.adId ? `<div class="amb-derived-row"><span>معرّف الإعلان</span><b class="mono">${E(r.adId)}</b></div>` : ''}
        <div class="amb-derived-row"><span>معرّف العنصر المستهدَف</span><b class="mono">${E(r.entityId || '—')}</b></div>
      </div>

      ${(r.actions || []).length ? `<div class="section-title">سجل التنفيذ</div>${(r.actions || []).map((a) => `<div class="faint" style="font-size:12px;">#${a.id} — ${E(a.status)} — ${fmtDT(a.at)}${a.metaError ? ` — خطأ: ${E(a.metaError)}` : ''}</div>`).join('')}` : ''}

      <div class="toolbar" style="margin-top:16px; gap:8px; flex-wrap:wrap;">
        ${r.status === 'PENDING' && r.executable ? `<button class="amb-btn" id="ambDrDry">تحقّق من المسار</button>` : ''}
        ${r.status === 'PENDING' && r.currentBudget != null && r.executable ? `<button class="amb-btn" id="ambDrEdit">تعديل الميزانية</button>` : ''}
        ${r.status === 'PENDING' ? `<button class="amb-btn ghost" id="ambDrReject">رفض</button>` : ''}
        <button class="amb-btn" id="ambDrawerX2">إغلاق</button>
      </div>
    </div>
  `);
  $('ambDrawerX').onclick = closeDrawer;
  $('ambDrawerX2').onclick = closeDrawer;
  if ($('ambDrDry')) $('ambDrDry').onclick = () => dryRunRec(id);
  if ($('ambDrEdit')) $('ambDrEdit').onclick = () => editRec(id);
  if ($('ambDrReject')) $('ambDrReject').onclick = async () => { closeDrawer(); await rejectRec(id); };
}

// ===========================================================================
// DEEP SECTIONS — logic UNCHANGED from before; only the light shell restyles
// the shared .card / table / tree components around them.
// ===========================================================================

// ---- Products ----
async function renderProducts(panel) {
  const [list, catalog] = await Promise.all([
    api.get('/api/ai-media-buyer/products'),
    api.get('/api/ai-media-buyer/catalog-products'),
  ]);
  panel.innerHTML = `
    <div class="toolbar" style="margin-bottom:14px;">
      <button class="amb-btn primary" id="ambNewProduct">+ منتج جديد</button>
      <select class="amb-select" id="ambSeedCatalog" style="max-width:260px;">
        <option value="">— أنشئ من منتج في الكتالوج —</option>
        ${catalog.map((c) => `<option value="${c.id}">${E(c.product_name)}</option>`).join('')}
      </select>
    </div>
    ${list.length === 0 ? '<div class="amb-panel amb-empty">مفيش منتجات في AI Media Buyer لسه. اربط كل حملة بمنتج عشان يحسب الربحية الحقيقية.</div>' : `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>المنتج</th><th>التكلفة</th><th>مضاعف</th><th>سعر البيع</th><th>Break-even CPA</th><th>Target CPA</th><th>حملات</th><th></th></tr></thead>
        <tbody>${list.map(productRow).join('')}</tbody>
      </table></div>`}
  `;
  $('ambNewProduct').onclick = () => openProductEditor(null);
  $('ambSeedCatalog').onchange = async (e) => {
    if (!e.target.value) return;
    try { await api.post(`/api/ai-media-buyer/products/from-catalog/${e.target.value}`, {}); UI.toast('✅ اتنشأ منتج من الكتالوج'); route(); }
    catch (err) { UI.toast(err.message, 'error'); }
  };
  panel.querySelectorAll('[data-prod]').forEach((b) => {
    b.onclick = () => (b.dataset.act === 'edit' ? openProductEditor(Number(b.dataset.prod)) : openProductDashboard(Number(b.dataset.prod)));
  });
}
function productRow(p) {
  return `<tr>
    <td><b>${E(p.productName)}</b>${p.linkedProductName ? `<div class="faint" style="font-size:11px;">↔ ${E(p.linkedProductName)}</div>` : ''}</td>
    <td>${fmtEGP(p.productCost)}</td>
    <td>${fmtNum(p.pricingMultiplier, 2)}</td>
    <td>${fmtEGP(p.effectiveSellingPrice)}${p.actualSellingPrice ? ' <span class="faint">(يدوي)</span>' : ''}</td>
    <td>${fmtEGP((p.effectiveSellingPrice || 0) - (p.productCost || 0) - (p.packagingCost || 0) - (p.shippingCost || 0) - (p.otherCost || 0))}</td>
    <td>${fmtEGP(p.targetCpa)}</td>
    <td>${p.mappedCampaignCount}</td>
    <td style="white-space:nowrap;">
      <button class="amb-btn sm" data-prod="${p.id}" data-act="dash">تحليل</button>
      <button class="amb-btn sm" data-prod="${p.id}" data-act="edit">تعديل</button>
    </td>
  </tr>`;
}
const PFIELDS = [
  ['product_name', 'اسم المنتج', 'text'], ['external_product_ref', 'Product ID (اختياري)', 'text'],
  ['image_url', 'رابط صورة المنتج (اختياري)', 'text'],
  ['product_cost', 'تكلفة المنتج', 'number'], ['pricing_multiplier', 'مضاعف التسعير', 'number'],
  ['actual_selling_price', 'سعر البيع الفعلي (تجاوز يدوي)', 'number'],
  ['packaging_cost', 'تكلفة التغليف', 'number'], ['shipping_cost', 'تكلفة الشحن', 'number'],
  ['other_cost', 'تكاليف أخرى', 'number'], ['rto_cost', 'تكلفة المرتجع / RTO', 'number'],
  ['confirmation_rate', 'نسبة التأكيد (0-1)', 'number'], ['delivery_rate', 'نسبة التسليم (0-1)', 'number'],
  ['target_cpa', 'Target CPA', 'number'], ['warning_cpa', 'Warning CPA', 'number'], ['max_cpa', 'أقصى CPA مسموح', 'number'],
  ['target_profit', 'الربح المستهدف', 'number'], ['min_profit', 'أدنى ربح', 'number'], ['currency', 'العملة', 'text'],
];
async function openProductEditor(id) {
  let p = { pricing_multiplier: 3, currency: 'EGP' };
  if (id) p = await api.get(`/api/ai-media-buyer/products/${id}`).then((r) => ({
    ...r.product,
    product_name: r.product.productName, external_product_ref: r.product.externalProductRef,
    product_cost: r.product.productCost, pricing_multiplier: r.product.pricingMultiplier,
    actual_selling_price: r.product.actualSellingPrice, packaging_cost: r.product.packagingCost,
    shipping_cost: r.product.shippingCost, other_cost: r.product.otherCost, rto_cost: r.product.rtoCost,
    confirmation_rate: r.product.confirmationRate, delivery_rate: r.product.deliveryRate,
    target_cpa: r.product.targetCpa, warning_cpa: r.product.warningCpa, max_cpa: r.product.maxCpa,
    target_profit: r.product.targetProfit, min_profit: r.product.minProfit, currency: r.product.currency,
    image_url: r.product.imageUrl,
  }));
  openDrawer(`
    <div class="drawer-header"><div class="drawer-title">${id ? 'تعديل منتج' : 'منتج جديد'}</div><button class="drawer-close" id="ambDrawerX">×</button></div>
    <div class="drawer-section">
      <div class="amb-field-grid">
        ${PFIELDS.map(([f, label, type]) => `
          <div class="field"><label>${E(label)}</label>
            <input type="${type}" data-f="${f}" value="${p[f] ?? ''}" ${type === 'number' ? 'step="any"' : ''} />
          </div>`).join('')}
      </div>
      <div class="amb-derived" id="ambPricePreview" style="margin-top:14px;"></div>
      <div class="toolbar" style="margin-top:16px;">
        <button class="amb-btn primary" id="ambSaveProduct">حفظ</button>
        ${id && state.isAdmin ? `<button class="amb-btn danger" id="ambDelProduct">حذف</button>` : ''}
        <button class="amb-btn" id="ambCancelProduct">إلغاء</button>
      </div>
    </div>
  `);
  const readForm = () => {
    const o = {};
    $('ambDrawerPanel').querySelectorAll('[data-f]').forEach((el) => {
      const v = el.value.trim();
      o[el.dataset.f] = v === '' ? null : el.type === 'number' ? Number(v) : v;
    });
    return o;
  };
  const updatePreview = () => {
    const o = readForm();
    const sp = o.actual_selling_price || (Number(o.product_cost || 0) * Number(o.pricing_multiplier || 0));
    const base = Number(o.product_cost || 0) + Number(o.packaging_cost || 0) + Number(o.shipping_cost || 0) + Number(o.other_cost || 0);
    const be = sp - base;
    let cod = null;
    if (o.confirmation_rate != null && o.delivery_rate != null) {
      const gp = sp - base;
      cod = (o.confirmation_rate * o.delivery_rate) * gp - (o.confirmation_rate * (1 - o.delivery_rate)) * Number(o.rto_cost || 0);
    }
    $('ambPricePreview').innerHTML = `
      <div class="amb-derived-row"><span>السعر المقترح (تكلفة × مضاعف)</span><b>${fmtEGP(Number(o.product_cost || 0) * Number(o.pricing_multiplier || 0))}</b></div>
      <div class="amb-derived-row"><span>السعر المستخدم في الحساب</span><b>${fmtEGP(sp)}</b></div>
      <div class="amb-derived-row"><span>التكلفة التشغيلية الأساسية</span><b>${fmtEGP(base)}</b></div>
      <div class="amb-derived-row"><span>ربح إجمالي قبل الإعلانات</span><b>${fmtEGP(sp - base)}</b></div>
      <div class="amb-derived-row"><span>Break-even CPA (أساسي)</span><b>${fmtEGP(be)}</b></div>
      <div class="amb-derived-row"><span>Break-even CPA (معدّل COD)</span><b>${cod === null ? '— (ضيف نسبة التأكيد/التسليم)' : fmtEGP(cod)}</b></div>`;
  };
  $('ambDrawerPanel').querySelectorAll('[data-f]').forEach((el) => el.addEventListener('input', updatePreview));
  updatePreview();
  $('ambDrawerX').onclick = closeDrawer;
  $('ambCancelProduct').onclick = closeDrawer;
  $('ambSaveProduct').onclick = async () => {
    try {
      const body = readForm();
      if (id) await api.patch(`/api/ai-media-buyer/products/${id}`, body);
      else await api.post('/api/ai-media-buyer/products', body);
      UI.toast('✅ اتحفظ'); closeDrawer(); route();
    } catch (err) { UI.toast(err.message, 'error'); }
  };
  if ($('ambDelProduct')) $('ambDelProduct').onclick = async () => {
    if (!(await UI.confirmModal({ title: 'حذف المنتج', message: 'هيتحذف من AI Media Buyer (مش من الكتالوج). متابعة؟', danger: true, confirmLabel: 'حذف' }))) return;
    await api.delete(`/api/ai-media-buyer/products/${id}`); UI.toast('اتحذف'); closeDrawer(); route();
  };
}
async function openProductDashboard(id) {
  openDrawer('<div class="drawer-section faint">جارِ التحميل…</div>');
  const d = await api.get(`/api/ai-media-buyer/products/${id}?window=${state.window}`);
  const m = d.metrics, cls = d.classification;
  const clsBadge = { WINNING: 'green', PROFITABLE: 'green', BREAK_EVEN: 'gray', AT_RISK: 'yellow', LOSING: 'red', NO_DATA: 'gray' }[cls.label] || 'gray';
  openDrawer(`
    <div class="drawer-header"><div class="drawer-title">${E(d.product.productName)}</div><button class="drawer-close" id="ambDrawerX">×</button></div>
    <div class="drawer-section">
      <span class="badge ${clsBadge}">${E({ WINNING: 'منتج رابح', PROFITABLE: 'مربح', BREAK_EVEN: 'تعادل', AT_RISK: 'في خطر', LOSING: 'خاسر', NO_DATA: 'بيانات ناقصة' }[cls.label] || cls.label)}</span>
      <div class="faint" style="font-size:12.5px; margin:8px 0 14px;">${E(cls.reason)} · نافذة: ${E(d.window.label)}</div>
      <div class="amb-derived">
        <div class="amb-derived-row"><span>إجمالي الصرف</span><b>${fmtEGP(m.totalSpend)}</b></div>
        <div class="amb-derived-row"><span>مشتريات Meta</span><b>${fmtNum(m.metaPurchases)}</b></div>
        <div class="amb-derived-row"><span>أوردرات مؤكدة</span><b>${fmtNum(m.confirmedOrders)}</b></div>
        <div class="amb-derived-row"><span>أوردرات مسلّمة</span><b>${fmtNum(m.deliveredOrders)}</b></div>
        <div class="amb-derived-row"><span>إيراد</span><b>${fmtEGP(m.revenue)}</b></div>
        <div class="amb-derived-row"><span>متوسط CPA</span><b>${fmtEGP(m.avgCpa)}</b></div>
        <div class="amb-derived-row"><span>Confirmed CPA</span><b>${fmtEGP(m.confirmedCpa)}</b></div>
        <div class="amb-derived-row"><span>Delivered CPA</span><b>${fmtEGP(m.deliveredCpa)}</b></div>
        <div class="amb-derived-row"><span>ROAS</span><b>${fmtX(m.roas)}</b></div>
      </div>
      <div class="section-title">صافي الربح (${E(d.cod.source === 'none' ? 'مفيش بيانات تسليم' : d.cod.source)})</div>
      <div class="amb-derived">
        <div class="amb-derived-row"><span>الإيراد</span><b>${fmtEGP(m.pnl.revenue)}</b></div>
        <div class="amb-derived-row"><span>صرف الإعلانات</span><b>${fmtEGP(m.pnl.adSpend)}</b></div>
        <div class="amb-derived-row"><span>تكلفة البضاعة (COGS)</span><b>${fmtEGP(m.pnl.cogs)}</b></div>
        <div class="amb-derived-row"><span>شحن</span><b>${fmtEGP(m.pnl.shipping)}</b></div>
        <div class="amb-derived-row"><span>تغليف</span><b>${fmtEGP(m.pnl.packaging)}</b></div>
        <div class="amb-derived-row"><span>تكلفة المرتجع</span><b>${fmtEGP(m.pnl.rtoCost)}</b></div>
        <div class="amb-derived-row"><span>تكاليف أخرى</span><b>${fmtEGP(m.pnl.otherCost)}</b></div>
        <div class="amb-derived-row" style="border-top:1px solid var(--amb-border); margin-top:4px; padding-top:8px;"><span><b>صافي الربح</b></span><b style="color:${(m.netProfit ?? 0) >= 0 ? 'var(--amb-green)' : 'var(--amb-red)'};">${fmtEGP(m.netProfit)} (${fmtPct(m.netMarginPct)})</b></div>
      </div>
      <div class="section-title">أفضل عنصر داخل المنتج</div>
      ${['campaign', 'adset', 'ad', 'creative'].map((lvl) => {
        const b = d.bests[lvl];
        const arLvl = { campaign: 'حملة', adset: 'مجموعة', ad: 'إعلان', creative: 'كرييتف' }[lvl];
        return b ? `<div class="amb-winner-card"><span class="amb-winner-trophy">🏆</span><div class="amb-winner-body"><div class="amb-winner-name">${arLvl}: ${E(b.name)}</div><div class="amb-winner-meta">CPA ${fmtEGP(b.cpa)} · ${fmtNum(b.purchases)} شراء · ROAS ${fmtX(b.roas)}</div></div></div>` : `<div class="faint" style="font-size:12px;">${arLvl}: مفيش بيانات كافية</div>`;
      }).join('')}
      ${d.observedRates.confirmationRate != null ? `<div class="faint" style="font-size:12px; margin-top:12px;">نِسب مرصودة: تأكيد ${fmtPct(d.observedRates.confirmationRate * 100)} · تسليم ${fmtPct(d.observedRates.deliveryRate * 100)} (عيّنة ${d.observedRates.sample})</div>` : ''}
      <div class="toolbar" style="margin-top:14px;"><button class="amb-btn" id="ambDrawerX2">إغلاق</button></div>
    </div>
  `);
  $('ambDrawerX').onclick = closeDrawer;
  $('ambDrawerX2').onclick = closeDrawer;
}

// ---- Campaign hierarchy (winner logic UNCHANGED) ----
async function renderCampaigns(panel) {
  panel.innerHTML = '';
  const [tree, mapState, products] = await Promise.all([
    api.get(`/api/ai-media-buyer/hierarchy?window=${state.window}`),
    api.get('/api/ai-media-buyer/mapping').catch(() => null),
    api.get('/api/ai-media-buyer/products').catch(() => []),
  ]);
  const acct = tree.accountAvg;
  const head = document.createElement('div');
  head.innerHTML = `<div class="faint" style="font-size:12.5px; margin-bottom:12px;">
    متوسط الحساب — صرف ${fmtEGP(acct?.spend)} · CPA ${fmtEGP(acct?.cpa)} · ROAS ${fmtX(acct?.roas)} · CTR ${fmtPct(acct?.ctr)}
  </div>
  <div class="faint" style="font-size:12px; margin-bottom:14px;">🟢 رابح · 🟡 تحسين · 🔴 مرشح إيقاف · 🔵 فرصة توسّع · ⚪ محتاج بيانات</div>`;
  panel.appendChild(head);

  if (mapState && mapState.counts) {
    const mm = document.createElement('div');
    mm.className = 'card';
    mm.style.marginBottom = '16px';
    mm.innerHTML = `<div class="section-title" style="margin-top:0;">ربط الحملات بالمنتجات</div>
      <div class="faint" style="font-size:12px; margin-bottom:8px;">مربوط ${mapState.counts.mapped} · مقترح ${mapState.counts.suggested} · غير مربوط ${mapState.counts.unmapped}</div>
      ${mapState.unmapped.slice(0, 8).map((c) => `
        <div class="eo-task-row">
          <span class="eo-task-text">${E(c.campaignName || c.campaignId)} <span class="faint">(${fmtEGP(c.spend)})</span>${c.suggestion ? ` — مقترح: <b>${E(c.suggestion.productName || '')}</b>` : ''}</span>
          <select class="amb-select" data-map-campaign="${E(c.campaignId)}" data-map-name="${E(c.campaignName || '')}" style="max-width:180px;">
            <option value="">— اختر منتج —</option>
            ${products.map((p) => `<option value="${p.id}" ${c.suggestion && c.suggestion.ambProductId === p.id ? 'selected' : ''}>${E(p.productName)}</option>`).join('')}
          </select>
        </div>`).join('') || '<div class="faint" style="font-size:12px;">كل الحملات النشطة مربوطة ✅</div>'}`;
    panel.appendChild(mm);
    mm.querySelectorAll('[data-map-campaign]').forEach((sel) => {
      sel.onchange = async () => {
        if (!sel.value) return;
        try { await api.post('/api/ai-media-buyer/mapping', { campaignId: sel.dataset.mapCampaign, campaignName: sel.dataset.mapName, ambProductId: Number(sel.value) }); UI.toast('✅ اتربطت'); route(); }
        catch (err) { UI.toast(err.message, 'error'); }
      };
    });
  }

  const treeWrap = document.createElement('div');
  const groups = [];
  for (const p of tree.products || []) groups.push({ title: `📦 ${p.name}`, node: p, children: p.children });
  if ((tree.unmappedCampaigns || []).length) groups.push({ title: '— حملات غير مربوطة بمنتج —', node: null, children: tree.unmappedCampaigns });
  treeWrap.innerHTML = groups.map((g) => `
    <div style="margin-bottom:18px;">
      <div class="section-title">${E(g.title)} ${g.node ? statusDot(g.node.status) : ''} ${g.node && g.node.metrics ? `<span class="faint" style="font-weight:400;font-size:12px;">CPA ${fmtEGP(g.node.metrics.cpa)} · صرف ${fmtEGP(g.node.metrics.spend)}</span>` : ''}</div>
      ${(g.children || []).map((c) => treeNode(c, 0)).join('') || '<div class="faint" style="font-size:12px;">مفيش حملات نشطة.</div>'}
    </div>`).join('');
  panel.appendChild(treeWrap);
  wireTree(treeWrap);
}
function statusDot(s) {
  if (!s) return '';
  const ar = { HEALTHY: 'سليم', OPTIMIZE: 'تحسين', LOSS: 'خسارة', STOP_CANDIDATE: 'مرشح إيقاف', WATCH: 'مراقبة', SCALE_OPPORTUNITY: 'فرصة توسّع', NEED_MORE_DATA: 'محتاج بيانات' }[s.verdict] || s.verdict;
  return `<span class="amb-dot ${s.color}" title="${E(ar)}"></span>`;
}
function treeNode(node) {
  const m = node.metrics || {};
  const hasKids = (node.children && node.children.length) || (node.creatives && node.creatives.length);
  const lvlAr = { campaign: 'حملة', adset: 'مجموعة', ad: 'إعلان', creative: 'كرييتف' }[node.level] || node.level;
  return `<div class="amb-tree-node">
    <div class="amb-tree-row" data-node-toggle="${hasKids ? '1' : '0'}">
      <span class="amb-tree-caret">${hasKids ? '▶' : ''}</span>
      ${statusDot(node.status)}
      <span class="amb-tree-name" title="${E(node.name)}"><span class="faint" style="font-size:11px;">${E(lvlAr)}</span> ${E(node.name)}</span>
      <span class="amb-tree-metrics">
        <span>صرف <b>${fmtEGP(m.spend)}</b></span>
        <span>شراء <b>${fmtNum(m.purchases)}</b></span>
        <span>CPA <b>${fmtEGP(m.cpa)}</b></span>
        <span>ROAS <b>${fmtX(m.roas)}</b></span>
        ${node.budget != null ? `<span>ميزانية <b>${fmtEGP(node.budget)}</b></span>` : ''}
      </span>
    </div>
    ${hasKids ? `<div class="amb-tree-children">
      ${(node.children || []).map((c) => treeNode(c)).join('')}
      ${(node.creatives || []).length ? `<div class="faint" style="font-size:11px; margin:6px 0;">كرييتيفز:</div>${node.creatives.map((c) => treeNode(c)).join('')}` : ''}
    </div>` : ''}
  </div>`;
}
function wireTree(root) {
  root.querySelectorAll('[data-node-toggle="1"]').forEach((row) => {
    row.onclick = () => {
      const kids = row.parentElement.querySelector('.amb-tree-children');
      const caret = row.querySelector('.amb-tree-caret');
      if (!kids) return;
      caret.classList.toggle('open', kids.classList.toggle('open'));
    };
  });
}

// ---- Winners / creatives (logic UNCHANGED) ----
async function renderWinners(panel) {
  panel.innerHTML = '';
  const w = await api.get(`/api/ai-media-buyer/winners?window=${state.window}`);
  const wn = w.winners;
  const cov = w.coverage || { analyzed: 0, notAnalyzed: 0, insufficientData: 0, total: 0 };
  const bigCard = (icon, label, node) => node
    ? `<div class="amb-winner-card" style="align-items:flex-start;"><span class="amb-winner-trophy">${icon}</span><div class="amb-winner-body">
        <div class="amb-winner-name">${E(label)}: ${E(node.name || node.label)}</div>
        <div class="amb-rec-metrics" style="margin:6px 0;">
          <span>صرف <b>${fmtEGP(node.spend)}</b></span><span>شراء <b>${fmtNum(node.purchases)}</b></span><span>CPA <b>${fmtEGP(node.cpa)}</b></span>
          ${node.deliveredCpa != null ? `<span>CPA مسلّم <b>${fmtEGP(node.deliveredCpa)}</b></span>` : ''}
          <span>CTR <b>${fmtPct(node.ctr)}</b></span><span>CPC <b>${fmtEGP(node.cpc)}</b></span><span>CVR <b>${fmtPct(node.conversionRate)}</b></span><span>ROAS <b>${fmtX(node.roas)}</b></span>
          ${node.netProfit != null ? `<span>صافي ربح <b>${fmtEGP(node.netProfit)}</b></span>` : ''}
          <span>كفاية بيانات <b>${E({ STRONG: 'قوية', MODERATE: 'كافية', WEAK: 'ضعيفة' }[node.dataSufficiency] || node.dataSufficiency)}</b></span>
          <span>ثقة <b>${E(CONF_FULL[node.confidence] || node.confidence)}</b></span>
        </div>
        <div style="font-size:12.5px;">✅ <b>ليه هو البطل:</b> ${E(node.why || '—')}</div>
      </div></div>`
    : `<div class="faint" style="font-size:12.5px; padding:6px 0;">${E(label)}: لسه مفيش عنصر بيحقق شروط "البطل".</div>`;
  panel.insertAdjacentHTML('beforeend', `
    <div class="card" style="margin-bottom:14px; display:flex; gap:14px; flex-wrap:wrap; align-items:center;">
      <div class="section-title" style="margin:0;">تحليل الكرياتيفات:</div>
      <span class="badge green">مُحلَّل ${cov.analyzed}</span>
      <span class="badge yellow">بيانات غير كافية ${cov.insufficientData}</span>
      <span class="badge gray">غير مُحلَّل ${cov.notAnalyzed}</span>
      <div style="flex:1;"></div>
      <button class="amb-btn sm" id="ambRunCreative">حلّل الباقي</button>
    </div>
    <div class="card" style="margin-bottom:16px;">
      <div class="section-title" style="margin-top:0;">🏆 الأبطال — نافذة ${E(w.window.label)}</div>
      ${bigCard('🥇', 'المنتج', wn.product)}${bigCard('🚀', 'الحملة', wn.campaign)}${bigCard('🎯', 'المجموعة الإعلانية', wn.adset)}
      ${bigCard('📢', 'الإعلان', wn.ad)}${bigCard('🎨', 'الكرييتف', wn.creative)}
      ${labelWinnerLine('🪝 الهوك', wn.hook)}${labelWinnerLine('📐 زاوية البيع', wn.sellingAngle)}${labelWinnerLine('🎁 العرض', wn.offer)}${labelWinnerLine('👥 زاوية الجمهور', wn.audienceAngle)}
    </div>
    ${labelTable('🪝 مقارنة الهوكس', w.hooks)}${labelTable('📐 مقارنة زوايا البيع', w.angles)}${labelTable('🎁 مقارنة العروض', w.offers)}${labelTable('👥 مقارنة زوايا الجمهور', w.audiences)}
  `);
  $('ambRunCreative').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = '… بيحلل';
    try { const r = await api.post('/api/ai-media-buyer/creative-analysis/run', { max: 25 }); UI.toast(`✅ اتحلل ${r.analyzed} كرييتف`); route(); }
    catch (err) { UI.toast(err.message, 'error'); e.target.disabled = false; e.target.textContent = 'حلّل الباقي'; }
  };
}
function labelWinnerLine(label, w) {
  if (!w) return `<div class="faint" style="font-size:12.5px; padding:6px 0;">${E(label)}: لسه مفيش بطل واضح.</div>`;
  return `<div class="amb-winner-card"><span class="amb-winner-trophy">🏆</span><div class="amb-winner-body">
    <div class="amb-winner-name">${E(label)}: ${E(w.label)}</div>
    <div class="amb-winner-meta">CPA ${fmtEGP(w.cpa)} · ${fmtNum(w.purchases)} شراء · CTR ${fmtPct(w.ctr)} · مصدر: ${w.source === 'CREATIVE_ANALYSIS' ? 'تحليل الكرييتف' : 'اسم الإعلان'}</div>
    <div style="font-size:12px; margin-top:3px;">${E(w.why || '')}</div>
  </div></div>`;
}
function labelTable(title, group) {
  if (!group || !group.table || group.table.length === 0) {
    return `<div class="card" style="margin-bottom:16px;"><div class="section-title" style="margin-top:0;">${E(title)}</div><div class="faint" style="font-size:12.5px;">لسه مفيش تصنيفات كفاية للمقارنة.</div></div>`;
  }
  return `<div class="card" style="margin-bottom:16px;"><div class="section-title" style="margin-top:0;">${E(title)} ${group.winner ? `— البطل: <b>${E(group.winner.label)}</b>` : ''}</div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>التصنيف</th><th>مصدر</th><th>إعلانات</th><th>صرف</th><th>شراء</th><th>CPA</th><th>CTR</th><th>CVR</th><th>كفاية بيانات</th></tr></thead>
      <tbody>${group.table.map((r) => `<tr ${group.winner && r.label === group.winner.label ? 'style="background:var(--amb-green-bg);"' : ''}>
        <td>${E(r.label)}</td><td class="faint">${r.source === 'CREATIVE_ANALYSIS' ? 'كرييتف' : 'اسم'}</td><td>${fmtNum(r.adCount)}</td><td>${fmtEGP(r.spend)}</td><td>${fmtNum(r.purchases)}</td><td>${fmtEGP(r.cpa)}</td><td>${fmtPct(r.ctr)}</td><td>${fmtPct(r.conversionRate)}</td><td>${E({ STRONG: 'قوية', MODERATE: 'كافية', WEAK: 'ضعيفة' }[r.dataSufficiency] || '')}</td>
      </tr>`).join('')}</tbody>
    </table></div></div>`;
}

// ---- Full AI Action Plan (categories + resolved) — logic UNCHANGED ----
async function renderPlan(panel) {
  const [cur, imgMap] = await Promise.all([
    api.get('/api/ai-media-buyer/recommendations'),
    api.get('/api/ai-media-buyer/product-images').catch(() => ({})),
  ]);
  state.productImages = imgMap || {};
  const active = cur.active || cur.items || [];
  const resolved = cur.resolved || [];
  state.pendingCount = active.length; renderNav();
  const CATS = [
    { key: 'SCALE', label: '🚀 توسّع' }, { key: 'HOLD', label: '🟢 تثبيت' }, { key: 'MONITOR', label: '🟡 مراقبة' },
    { key: 'PAUSE_CANDIDATE', label: '🔴 مرشّح للإيقاف' }, { key: 'NEW_CREATIVE_NEEDED', label: '🎨 كرياتيف جديد' },
  ];
  const byCat = {};
  for (const it of active) (byCat[it.category] = byCat[it.category] || []).push(it);
  const extResolved = resolved.filter((r) => ['RESOLVED_EXTERNALLY', 'NO_LONGER_APPLICABLE'].includes(r.status));

  panel.innerHTML = `
    <div class="toolbar" style="margin-bottom:14px;">
      <button class="amb-btn primary" id="ambGenPlan">توليد خطة جديدة</button>
      <button class="amb-btn" id="ambReconcile">طابق مع حالة Meta</button>
      ${cur.generatedAt ? `<span class="faint" style="font-size:12px;">آخر توليد: ${fmtDT(cur.generatedAt)}</span>` : ''}
    </div>
    ${active.length === 0 ? `<div class="amb-panel amb-empty">مفيش توصيات نشطة محتاجة إجراء دلوقتي.${extResolved.length ? ' (فيه توصيات محلولة تحت)' : ''}</div>` : CATS.map((c) => {
      const list = (byCat[c.key] || []).sort((a, b) => a.priority.localeCompare(b.priority));
      if (!list.length) return '';
      return `<div style="margin-bottom:20px;"><div class="section-title">${E(c.label)} <span class="faint" style="font-weight:400;font-size:12px;">(${list.length})</span></div>${list.map(recCardV2).join('')}</div>`;
    }).join('')}
    ${extResolved.length ? `<div style="margin-top:8px;">
      <button class="amb-btn sm" id="ambToggleResolved">توصيات محلولة / خارج النطاق (${extResolved.length}) ▾</button>
      <div id="ambResolvedList" hidden style="margin-top:10px;">${extResolved.map(resolvedCard).join('')}</div>
    </div>` : ''}`;
  const rc = $('ambReconcile');
  rc.onclick = async () => {
    rc.disabled = true; rc.textContent = '… بيطابق';
    try {
      const r = await api.post('/api/ai-media-buyer/recommendations/reconcile', {});
      UI.toast((r.resolvedExternally + r.noLongerApplicable) > 0 ? `✅ اتحلّت ${r.resolvedExternally} + ${r.noLongerApplicable} خارج النطاق` : 'كل التوصيات لسه منطبقة');
      route();
    } catch (err) { UI.toast(err.message, 'error'); rc.disabled = false; rc.textContent = 'طابق مع حالة Meta'; }
  };
  const tr = $('ambToggleResolved');
  if (tr) tr.onclick = () => { const el = $('ambResolvedList'); el.hidden = !el.hidden; };
  $('ambGenPlan').onclick = async () => {
    const btn = $('ambGenPlan'); btn.disabled = true; btn.textContent = '… بيحلل';
    try { const r = await api.post('/api/ai-media-buyer/recommendations/generate', { window: state.window }); UI.toast(`✅ ${r.count} توصية`); route(); }
    catch (err) { UI.toast(err.message, 'error'); btn.disabled = false; btn.textContent = 'توليد خطة جديدة'; }
  };
  panel.querySelectorAll('[data-rec]').forEach((b) => {
    const id = Number(b.dataset.rec);
    const act = b.dataset.act;
    if (act === 'approve') b.onclick = () => approveRec(id, b);
    else if (act === 'reject') b.onclick = () => rejectRec(id);
    else if (act === 'details') b.onclick = () => showRecDetails(id);
  });
}
function resolvedCard(r) {
  return `<div class="amb-rec" style="border-inline-start-color:var(--amb-text-faint); opacity:.9;">
    <div class="amb-rec-head">
      <span class="amb-pri ${r.priority}">${r.priority}</span>
      <span class="amb-rec-title">${E(DECISION_AR[r.decision] || r.decision)} — ${E(r.entityName || '')}</span>
      <span class="badge ${STATUS_BADGE[r.status] || 'gray'}">${E(STATUS_AR[r.status] || r.status)}</span>
      ${r.currentStatus ? `<span class="faint" style="font-size:12px;">حالة Meta: ${E(META_STATUS_AR[r.currentStatus] || r.currentStatus)}</span>` : ''}
    </div>
    <div style="font-size:12.5px; margin-top:6px;">${E(r.resolutionNote || 'اتحلّت خارج النظام.')}</div>
    <div class="amb-rec-actions"><button class="amb-btn sm" data-rec="${r.id}" data-act="details">التفاصيل</button></div>
  </div>`;
}

// ---- Execution history / reports — logic UNCHANGED ----
async function renderHistory(panel) {
  const rows = await api.get('/api/ai-media-buyer/execution-history?limit=80');
  panel.innerHTML = rows.length === 0
    ? '<div class="amb-panel amb-empty">مفيش أكشنز اتنفّذت لسه.</div>'
    : `<div class="table-wrap"><table class="data">
        <thead><tr><th>الوقت</th><th>العنصر</th><th>الأكشن</th><th>قبل ← بعد</th><th>الحالة</th><th>النتيجة (24س)</th><th>وافق</th></tr></thead>
        <tbody>${rows.map(histRow).join('')}</tbody></table></div>`;
  panel.querySelectorAll('[data-hist]').forEach((b) => b.onclick = () => showHistDetails(rows.find((x) => x.id === Number(b.dataset.hist))));
}
function histRow(a) {
  const ex = { PENDING: 'منتظر', REVALIDATING: 'إعادة تحقّق', EXECUTED: '✅ تم', FAILED: '❌ فشل', ABORTED_REANALYSIS: '⛔ إعادة تحليل' }[a.executionStatus] || a.executionStatus;
  const h24 = (a.results || []).find((r) => r.checkpoint === 'H24');
  const resAr = h24?.resultClass ? ({ SUCCESSFUL: '🟢 ناجح', NEUTRAL: '🟡 محايد', FAILED: '🔴 فاشل' }[h24.resultClass]) : (h24 ? '⏳ مستني' : '—');
  const bp = a.oldValue, np = a.newValue;
  const change = a.actionType.includes('BUDGET') && bp && np ? `${fmtEGP(bp.budget)} ← ${fmtEGP(np.budget)}` : bp && np ? `${E(bp.status || '')} ← ${E(np.status || '')}` : '—';
  return `<tr>
    <td style="white-space:nowrap;">${fmtDT(a.at)}</td>
    <td>${E(a.entityName || '')}${a.productName ? `<div class="faint" style="font-size:11px;">${E(a.productName)}</div>` : ''}</td>
    <td>${E(DECISION_AR[a.actionType] || a.actionType)} <span class="faint">(${E(a.mode)})</span></td>
    <td>${change}</td>
    <td>${E(ex)}${a.metaError ? `<div class="faint" style="font-size:11px; color:var(--amb-red);">${E(a.metaError.slice(0, 60))}</div>` : ''}</td>
    <td>${resAr}</td>
    <td>${E(a.approvedBy || '')} <button class="amb-btn sm" data-hist="${a.id}">تفاصيل</button></td>
  </tr>`;
}
function showHistDetails(a) {
  if (!a) return;
  openDrawer(`
    <div class="drawer-header"><div class="drawer-title">تفاصيل التنفيذ #${a.id}</div><button class="drawer-close" id="ambDrawerX">×</button></div>
    <div class="drawer-section">
      <div class="amb-derived">
        <div class="amb-derived-row"><span>العنصر</span><b>${E(a.entityName || '')}</b></div>
        <div class="amb-derived-row"><span>الأكشن</span><b>${E(DECISION_AR[a.actionType] || a.actionType)}</b></div>
        <div class="amb-derived-row"><span>الوضع</span><b>${E(a.mode)}</b></div>
        <div class="amb-derived-row"><span>الحالة</span><b>${E(a.executionStatus)}</b></div>
        <div class="amb-derived-row"><span>وافق</span><b>${E(a.approvedBy || '')}</b></div>
        <div class="amb-derived-row"><span>تنفيذ</span><b>${fmtDT(a.executedAt)}</b></div>
      </div>
      <div class="section-title">سبب الـ AI</div>
      <div class="amb-rec-reason">${E(a.aiReason || '—')}</div>
      ${a.revalidation ? `<div class="section-title">إعادة التحقّق قبل التنفيذ</div><pre style="white-space:pre-wrap; font-size:11px; background:var(--amb-surface-2); padding:10px; border-radius:8px;">${E(JSON.stringify(a.revalidation, null, 1))}</pre>` : ''}
      ${a.metaError ? `<div style="color:var(--amb-red); font-size:12.5px; margin-top:8px;">خطأ Meta: ${E(a.metaError)}</div>` : ''}
      <div class="section-title">تقييم النتيجة (H6 / H12 / H24)</div>
      ${(a.results || []).map((r) => `<div class="amb-derived" style="margin-bottom:8px;">
        <div class="amb-derived-row"><span>نقطة</span><b>${r.checkpoint} — ${r.evaluatedAt ? fmtDT(r.evaluatedAt) : 'مستني ' + fmtDT(r.dueAt)}</b></div>
        ${r.resultClass ? `<div class="amb-derived-row"><span>التصنيف</span><b>${E({ SUCCESSFUL: 'ناجح', NEUTRAL: 'محايد', FAILED: 'فاشل' }[r.resultClass])}</b></div>` : ''}
        <div class="amb-derived-row"><span>CPA قبل ← بعد</span><b>${fmtEGP(r.cpaBefore)} ← ${fmtEGP(r.cpaAfter)}</b></div>
        <div class="amb-derived-row"><span>ROAS قبل ← بعد</span><b>${fmtX(r.roasBefore)} ← ${fmtX(r.roasAfter)}</b></div>
        <div class="amb-derived-row"><span>شراء قبل ← بعد</span><b>${fmtNum(r.purchasesBefore)} ← ${fmtNum(r.purchasesAfter)}</b></div>
        <div class="amb-derived-row"><span>ربح قبل ← بعد</span><b>${fmtEGP(r.profitBefore)} ← ${fmtEGP(r.profitAfter)}</b></div>
        ${r.notes && r.notes.note ? `<div class="faint" style="font-size:11.5px; margin-top:4px;">${E(r.notes.note)}</div>` : ''}
      </div>`).join('') || '<div class="faint" style="font-size:12px;">مفيش نقاط تقييم.</div>'}
      <div class="toolbar" style="margin-top:14px;"><button class="amb-btn" id="ambDrawerX2">إغلاق</button></div>
    </div>
  `);
  $('ambDrawerX').onclick = closeDrawer;
  $('ambDrawerX2').onclick = closeDrawer;
}

// ===========================================================================
// MEDIA ASSET LIBRARY — one deduplicated catalogue of every creative running
// across the connected Meta ad accounts: Product → Creative → Hook/Angle →
// Campaign → Ad Set → Ad → Ad Account → Performance → Winner/Loser. Discovery
// is automatic (piggy-backs the sync) + on-demand per account. Winner scaling
// reuses the existing Campaign Clone & Schedule flow — nothing is created on
// Meta before APPROVE & SCHEDULE.
// ===========================================================================
const mlState = { view: 'grid', format: '', productId: '', q: '', accountId: '', accounts: null, products: null };
const ML_FORMAT_AR = { VIDEO: 'فيديو', IMAGE: 'صورة', CAROUSEL: 'كاروسيل', OTHER: 'أخرى' };
const ML_LINK_AR = { MANUAL: 'ربط يدوي', AUTO_CAMPAIGN_MAP: 'ربط تلقائي', NONE: 'غير مربوط' };

async function renderMediaLib(panel) {
  if (!mlState.products) mlState.products = await api.get('/api/ai-media-buyer/products').catch(() => []);
  if (!mlState.accounts) mlState.accounts = (await api.get('/api/ai-media-buyer/clone/accounts').catch(() => ({ accounts: [] }))).accounts || [];
  panel.innerHTML = `<div id="ambMlBar"></div><div id="ambMlBody"><div class="amb-loading">جارِ التحميل…</div></div>`;
  renderMlBar();
  await renderMlBody();
}

function renderMlBar() {
  const el = $('ambMlBar');
  const prods = mlState.products || [];
  const accts = mlState.accounts || [];
  el.innerHTML = `
    <div class="amb-ml-bar">
      <div class="amb-seg" id="ambMlView">
        <button class="amb-seg-btn ${mlState.view === 'grid' ? 'active' : ''}" data-mlv="grid">المكتبة</button>
        <button class="amb-seg-btn ${mlState.view === 'intel' ? 'active' : ''}" data-mlv="intel">تحليل الأبطال</button>
      </div>
      ${mlState.view === 'grid' ? `
        <select class="amb-select" id="ambMlFormat">
          <option value="">كل الأنواع</option>
          ${['VIDEO', 'IMAGE', 'CAROUSEL', 'OTHER'].map((f) => `<option value="${f}" ${mlState.format === f ? 'selected' : ''}>${E(ML_FORMAT_AR[f])}</option>`).join('')}
        </select>
        <select class="amb-select" id="ambMlProduct">
          <option value="">كل المنتجات</option>
          <option value="none" ${mlState.productId === 'none' ? 'selected' : ''}>— غير مربوط —</option>
          ${prods.map((p) => `<option value="${p.id}" ${String(mlState.productId) === String(p.id) ? 'selected' : ''}>${E(p.productName)}</option>`).join('')}
        </select>
        <select class="amb-select" id="ambMlAccount">
          <option value="">كل الحسابات</option>
          ${accts.map((a) => `<option value="${E(a.id)}" ${mlState.accountId === a.id ? 'selected' : ''}>${E(a.name || a.id)}</option>`).join('')}
        </select>
        <div class="amb-search">${ic('search', 's-ic')}<input type="text" id="ambMlSearch" placeholder="ابحث بالاسم / الهوك / النص..." value="${E(mlState.q)}" /></div>
        <select class="amb-select" id="ambMlScan"><option value="">— فحص حساب الآن —</option>${accts.map((a) => `<option value="${E(a.id)}">${E(a.name || a.id)}</option>`).join('')}</select>
      ` : ''}
    </div>`;
  el.querySelectorAll('[data-mlv]').forEach((b) => { b.onclick = () => { mlState.view = b.dataset.mlv; renderMlBar(); renderMlBody(); }; });
  if (mlState.view === 'grid') {
    $('ambMlFormat').onchange = (e) => { mlState.format = e.target.value; renderMlBody(); };
    $('ambMlProduct').onchange = (e) => { mlState.productId = e.target.value; renderMlBody(); };
    $('ambMlAccount').onchange = (e) => { mlState.accountId = e.target.value; renderMlBody(); };
    const s = $('ambMlSearch');
    let t;
    s.oninput = () => { clearTimeout(t); t = setTimeout(() => { mlState.q = s.value.trim(); renderMlBody(); }, 350); };
    $('ambMlScan').onchange = async (e) => {
      const id = e.target.value; e.target.value = '';
      if (!id) return;
      UI.toast('… بيفحص الحساب');
      try { const r = await api.post('/api/ai-media-buyer/media-library/scan', { accountId: id }); UI.toast(`✅ ${r.newAssets} كرياتيف جديد · ${r.newRefs} ربط`); renderMlBody(); }
      catch (err) { UI.toast(err.message, 'error'); }
    };
  }
}

async function renderMlBody() {
  const body = $('ambMlBody');
  if (!body) return;
  body.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  try {
    if (mlState.view === 'intel') return renderMlIntel(body);
    const data = await api.get('/api/ai-media-buyer/media-library', {
      window: state.window, format: mlState.format || undefined, productId: mlState.productId || undefined,
      accountId: mlState.accountId || undefined, q: mlState.q || undefined,
    });
    const list = data.assets || [];
    body.innerHTML = `
      <div class="faint" style="font-size:12px; margin-bottom:12px;">${list.length} كرياتيف · الأداء لنافذة «${E(data.window.label)}» · الاكتشاف تلقائي مع كل مزامنة</div>
      ${list.length ? `<div class="amb-ml-grid">${list.map(mlCard).join('')}</div>` : '<div class="amb-panel amb-empty">لسه مفيش كرياتيفات في المكتبة. هتتعبّى تلقائيًا مع المزامنة، أو استخدم «فحص حساب الآن».</div>'}`;
    body.querySelectorAll('[data-asset]').forEach((c) => { c.onclick = () => showAssetDetail(Number(c.dataset.asset)); });
  } catch (err) {
    body.innerHTML = `<div class="amb-panel amb-empty">⚠️ ${E(err.message || err)}</div>`;
  }
}

function mlThumb(a) {
  if (a.thumbnailUrl) return `<img class="amb-ml-thumb" src="${E(a.thumbnailUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="amb-ml-thumb ph" style="display:none;">${ic(a.format === 'VIDEO' ? 'play' : 'image', 'ic')}</div>`;
  return `<div class="amb-ml-thumb ph">${ic(a.format === 'VIDEO' ? 'play' : 'image', 'ic')}</div>`;
}
function mlCard(a) {
  const p = a.performance || {};
  return `<div class="amb-ml-card" data-asset="${a.id}">
    ${mlThumb(a)}
    <div class="amb-ml-body">
      <div class="amb-ml-name">${E(a.name)}</div>
      <div class="amb-ml-tags">
        <span class="badge gray">${E(ML_FORMAT_AR[a.format] || a.format)}</span>
        ${a.productName ? `<span class="badge blue">${E(a.productName)}</span>` : `<span class="badge gray">غير مربوط</span>`}
        ${a.hook ? `<span class="amb-ml-hook" title="${E(a.hook)}">🪝 ${E(a.hook.slice(0, 28))}</span>` : ''}
      </div>
      <div class="amb-ml-metrics">
        <span>صرف <b>${fmtEGP(p.spend)}</b></span>
        <span>شراء <b>${fmtNum(p.purchases)}</b></span>
        <span>CPA <b>${fmtEGP(p.cpa)}</b></span>
        <span>ROAS <b>${fmtX(p.roas)}</b></span>
        <span>حسابات <b>${fmtNum(a.accountCount)}</b></span>
      </div>
    </div>
  </div>`;
}

async function showAssetDetail(id) {
  openDrawer('<div class="drawer-section faint">جارِ التحميل…</div>');
  let d;
  try { d = await api.get(`/api/ai-media-buyer/media-library/assets/${id}`, { window: state.window }); }
  catch (err) { openDrawer(`<div class="drawer-section"><div class="amb-empty">⚠️ ${E(err.message)}</div><button class="amb-btn" id="ambDrawerX2">إغلاق</button></div>`); $('ambDrawerX2').onclick = closeDrawer; return; }
  const a = d.asset, t = d.performance.total || {}, pr = d.performance.profit || {};
  const prods = mlState.products || [];
  openDrawer(`
    <div class="drawer-header"><div class="drawer-title">تفاصيل الكرياتيف</div><button class="drawer-close" id="ambDrawerX">×</button></div>
    <div class="drawer-section">
      ${a.thumbnailUrl ? `<img src="${E(a.thumbnailUrl)}" alt="" style="width:100%; max-height:220px; object-fit:contain; background:var(--amb-surface-2); border-radius:10px; margin-bottom:12px;" onerror="this.style.display='none'" />` : ''}
      <div class="field"><label>اسم الكرياتيف</label><input type="text" id="ambAsName" value="${E(a.name)}" /></div>
      <div class="amb-field-grid" style="margin-top:10px;">
        <div class="field"><label>المنتج</label>
          <select id="ambAsProduct">
            <option value="">— غير مربوط —</option>
            ${prods.map((p) => `<option value="${p.id}" ${String(a.ambProductId) === String(p.id) ? 'selected' : ''}>${E(p.productName)}</option>`).join('')}
          </select>
          <div class="faint" style="font-size:11px; margin-top:2px;">${E(ML_LINK_AR[a.linkSource] || a.linkSource)}</div>
        </div>
        <div class="field"><label>الهوك</label><input type="text" id="ambAsHook" value="${E(a.hook || '')}" /></div>
        <div class="field"><label>زاوية البيع</label><input type="text" id="ambAsAngle" value="${E(a.sellingAngle || '')}" /></div>
      </div>
      <div class="toolbar" style="margin:10px 0 6px;"><button class="amb-btn primary sm" id="ambAsSave">حفظ التعديلات</button></div>

      <div class="section-title">الأداء الكلي — نافذة ${E(d.window.label)}</div>
      <div class="amb-derived">
        <div class="amb-derived-row"><span>الإنفاق</span><b>${fmtEGP(t.spend)}</b></div>
        <div class="amb-derived-row"><span>الطلبات (Meta)</span><b>${fmtNum(t.purchases)}</b></div>
        <div class="amb-derived-row"><span>CPA</span><b>${fmtEGP(t.cpa)}</b></div>
        <div class="amb-derived-row"><span>الإيراد</span><b>${fmtEGP(t.revenue)}</b></div>
        <div class="amb-derived-row"><span>ROAS</span><b>${fmtX(t.roas)}</b></div>
        <div class="amb-derived-row"><span>CTR</span><b>${fmtPct(t.ctr)}</b></div>
        <div class="amb-derived-row"><span>CPC</span><b>${fmtEGP(t.cpc)}</b></div>
        <div class="amb-derived-row"><span>صافي الربح</span><b>${pr.netProfit == null ? '—' : fmtEGP(pr.netProfit)}</b></div>
        <div class="amb-derived-row"><span>CPA مسلّم</span><b>${pr.deliveredCpa == null ? '—' : fmtEGP(pr.deliveredCpa)}</b></div>
      </div>
      ${pr.scopeNote ? `<div class="faint" style="font-size:11px; margin-top:4px;">${E(pr.scopeNote)}</div>` : ''}

      <div class="section-title">الأداء لكل حساب</div>
      ${(d.performance.byAccount || []).length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>الحساب</th><th>صرف</th><th>شراء</th><th>CPA</th><th>ROAS</th></tr></thead>
        <tbody>${d.performance.byAccount.map((x) => `<tr><td class="mono" style="font-size:11px;">${E(mlAcctName(x.adAccountId))}</td><td>${fmtEGP(x.spend)}</td><td>${fmtNum(x.purchases)}</td><td>${fmtEGP(x.cpa)}</td><td>${fmtX(x.roas)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="faint" style="font-size:12px;">لا يوجد أداء مُسجَّل في هذه النافذة (الحساب قد يحتاج مزامنة).</div>'}

      <div class="section-title">مستخدَم في</div>
      <div class="amb-derived">
        <div class="amb-derived-row"><span>حسابات إعلانية</span><b>${d.usage.accounts.length}</b></div>
        <div class="amb-derived-row"><span>حملات</span><b>${d.usage.campaigns.length}</b></div>
        <div class="amb-derived-row"><span>مجموعات إعلانية</span><b>${d.usage.adsets.length}</b></div>
        <div class="amb-derived-row"><span>إعلانات</span><b>${d.usage.ads.length}</b></div>
      </div>
      ${d.usage.campaigns.length ? `<div class="faint" style="font-size:11.5px; margin-top:6px;">${d.usage.campaigns.slice(0, 8).map((c) => E(c.name)).join(' · ')}</div>` : ''}

      <div class="section-title">الخريطة عبر الحسابات (نفس الأصل)</div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>الحساب</th><th>creative_id</th><th>نوع</th><th>image_hash / video_id</th><th>مصدر</th></tr></thead>
        <tbody>${d.crossAccountMap.map((r) => `<tr>
          <td class="mono" style="font-size:11px;">${E(mlAcctName(r.adAccountId))}</td>
          <td class="mono" style="font-size:11px;">${E(r.creativeId)}</td>
          <td>${E(ML_FORMAT_AR[r.format] || r.format || '—')}</td>
          <td class="mono" style="font-size:10.5px;">${E([...(r.imageHashes || []), ...(r.videoIds || [])].join(', ').slice(0, 60) || '—')}</td>
          <td>${r.origin === 'CLONED' ? '<span class="badge blue">استنساخ</span>' : '<span class="badge gray">مكتشَف</span>'}</td>
        </tr>`).join('')}</tbody>
      </table></div>

      ${d.scalingHistory.length ? `<div class="section-title">سجل التوسيع</div>
        ${d.scalingHistory.map((s) => `<div class="faint" style="font-size:12px;">${fmtDT(s.createdAt)} → ${s.destinationAccountIds.length} حساب · <b>${E(CLONE_BATCH_AR[s.status]?.[0] || s.status)}</b>${s.cloneBatchId ? ` · <button class="amb-btn sm ghost" data-openbatch="${E(s.cloneBatchId)}">فتح الدفعة</button>` : ''}</div>`).join('')}` : ''}

      <div class="section-title">توسيع الكرياتيف الرابح</div>
      <div class="faint" style="font-size:12px; margin-bottom:8px;">هيبني خطة استنساخ من الحملات اللي بتشغّل الكرياتيف ده → للحسابات اللي تختارها. مفيش أي حاجة بتتنفّذ قبل «موافقة وجدولة».</div>
      <div class="amb-check-list" id="ambAsScaleDests">
        ${(mlState.accounts || []).map((ac) => `<label class="amb-check-row"><input type="checkbox" data-scaledest="${E(ac.id)}" /><span class="rr-main">${E(ac.name || ac.id)}</span><span class="rr-sub">${E(ac.id)}${ac.timezoneName ? ` · ${E(ac.timezoneName)}` : ''}</span></label>`).join('')}
      </div>
      <div class="toolbar" style="margin-top:10px; gap:8px;">
        <input type="time" id="ambAsScaleTime" value="00:00" style="max-width:130px;" />
        <button class="amb-btn primary" id="ambAsScale" ${state.isAdmin ? '' : 'disabled'}>${state.isAdmin ? 'مراجعة خطة التوسيع' : 'التوسيع للـ ADMIN فقط'}</button>
      </div>

      <div class="toolbar" style="margin-top:14px;"><button class="amb-btn" id="ambDrawerX2">إغلاق</button></div>
    </div>`);
  $('ambDrawerX').onclick = closeDrawer;
  $('ambDrawerX2').onclick = closeDrawer;
  $('ambAsSave').onclick = async () => {
    try {
      await api.patch(`/api/ai-media-buyer/media-library/assets/${id}`, {
        assetName: $('ambAsName').value, ambProductId: $('ambAsProduct').value || null,
        hook: $('ambAsHook').value, sellingAngle: $('ambAsAngle').value,
      });
      UI.toast('✅ اتحفظ'); renderMlBody();
    } catch (err) { UI.toast(err.message, 'error'); }
  };
  document.querySelectorAll('[data-openbatch]').forEach((b) => {
    b.onclick = () => { closeDrawer(); cloneState.batchId = b.dataset.openbatch; cloneState.step = 6; location.hash = 'clone'; };
  });
  $('ambAsScale').onclick = async () => {
    const dests = [...document.querySelectorAll('[data-scaledest]:checked')].map((x) => x.dataset.scaledest);
    if (!dests.length) { UI.toast('اختر حساب وجهة واحد على الأقل', 'error'); return; }
    const btn = $('ambAsScale'); btn.disabled = true; btn.textContent = '… بيجهّز الخطة';
    try {
      const r = await api.post(`/api/ai-media-buyer/media-library/assets/${id}/scaling-plan`, { destinationAccountIds: dests, scheduleLocalTime: $('ambAsScaleTime').value || '00:00', window: state.window });
      UI.toast('✅ اتجهزت خطة التوسيع — راجع ووافق');
      closeDrawer();
      cloneState.batchId = r.batch.batchId; cloneState.step = 6; location.hash = 'clone';
    } catch (err) { UI.toast(err.message, 'error'); btn.disabled = false; btn.textContent = 'مراجعة خطة التوسيع'; }
  };
}
function mlAcctName(id) {
  return (mlState.accounts || []).find((a) => a.id === id)?.name || id;
}

async function renderMlIntel(body) {
  const d = await api.get('/api/ai-media-buyer/media-library/intel', { window: state.window });
  const th = d.thresholds || {};
  const winCard = (w, withScale) => `
    <div class="amb-ml-win">
      ${mlThumb(w)}
      <div class="amb-ml-win-body">
        <div class="amb-ml-name">${E(w.name)}</div>
        <div class="amb-ml-tags">
          ${w.productName ? `<span class="badge blue">${E(w.productName)}</span>` : '<span class="badge gray">غير مربوط</span>'}
          ${w.hook ? `<span class="amb-ml-hook">🪝 ${E(w.hook.slice(0, 26))}</span>` : ''}
          <span class="badge ${w.confidence === 'HIGH' ? 'green' : 'yellow'}">${E({ HIGH: 'ثقة عالية', MEDIUM: 'ثقة متوسطة', LOW: 'ثقة منخفضة' }[w.confidence] || w.confidence)}</span>
        </div>
        <div class="amb-ml-metrics">
          <span>CPA <b>${fmtEGP(w.performance.cpa)}</b></span>
          <span>شراء <b>${fmtNum(w.performance.purchases)}</b></span>
          <span>صرف <b>${fmtEGP(w.performance.spend)}</b></span>
          <span>ROAS <b>${fmtX(w.performance.roas)}</b></span>
          ${w.profit && w.profit.netProfit != null ? `<span>ربح <b>${fmtEGP(w.profit.netProfit)}</b></span>` : ''}
          <span>حسابات <b>${w.accountCount}</b></span>
        </div>
        ${w.reason ? `<div class="amb-r-reason" style="margin-top:6px;">${E(w.reason)}</div>` : ''}
        <div class="toolbar" style="margin-top:8px;">
          <button class="amb-btn sm" data-asset="${w.assetId}">تفاصيل</button>
          ${withScale && state.isAdmin ? `<button class="amb-btn sm primary" data-scale="${w.assetId}">مراجعة خطة التوسيع</button>` : ''}
        </div>
      </div>
    </div>`;

  body.innerHTML = `
    <div class="faint" style="font-size:12px; margin-bottom:12px;">
      نافذة «${E(d.window.label)}» · ${d.counts.scored} كرياتيف له أداء · هدف CPA ${fmtEGP(th.targetCpa)} · حد التوسّع ${fmtEGP(th.scaleCpa)} · أدنى صرف ${fmtEGP(th.minSpend)} · أدنى شراء ${th.minPurchases}
      <br/>البطل لا يُحدَّد من الـ CPA وحده — لازم يعدّي حدود كفاية البيانات والربحية.
    </div>

    <div class="section-title">🏆 الكرياتيفات الرابحة (${d.winners.length})</div>
    ${d.winners.length ? d.winners.map((w) => winCard(w, true)).join('') : '<div class="amb-panel amb-empty">لسه مفيش كرياتيف عدّى كل شروط «الرابح» في الفترة دي.</div>'}

    ${d.crossAccount.length ? `<div class="section-title">🌍 أفضل كرياتيف عبر أكثر من حساب</div>${d.crossAccount.map((w) => winCard(w, true)).join('')}` : ''}

    ${d.bestPerProduct.length ? `<div class="section-title">📦 أفضل كرياتيف لكل منتج</div>
      <div class="amb-ml-grid">${d.bestPerProduct.map((w) => `<div class="amb-ml-card" data-asset="${w.assetId}">${mlThumb(w)}<div class="amb-ml-body"><div class="amb-ml-name">${E(w.productName || '—')}</div><div class="faint" style="font-size:11.5px;">${E(w.name.slice(0, 40))}</div><div class="amb-ml-metrics"><span>CPA <b>${fmtEGP(w.performance.cpa)}</b></span><span>شراء <b>${fmtNum(w.performance.purchases)}</b></span>${w.isWinner ? '<span class="badge green">رابح</span>' : ''}</div></div></div>`).join('')}</div>` : ''}

    <div class="amb-grid" style="margin-top:16px;">
      <div class="amb-col-main">
        <div class="section-title">🪝 الهوك الرابح</div>
        ${mlLabelPanel(d.winningHook)}
        <div class="section-title">📐 زاوية البيع الرابحة</div>
        ${mlLabelPanel(d.winningAngle)}
      </div>
      <div class="amb-col-side">
        <div class="amb-panel">
          <h3>الكرياتيفات الخاسرة (${d.losers.length})</h3>
          ${d.losers.length ? d.losers.map((l) => `<div class="amb-prod-row"><span class="pn">${E(l.name.slice(0, 34))}</span><span class="pc">${E(l.reason || '')}</span></div>`).join('') : '<div class="amb-empty" style="padding:8px 0;">مفيش كرياتيف خاسر واضح.</div>'}
        </div>
      </div>
    </div>`;

  body.querySelectorAll('[data-asset]').forEach((b) => { b.onclick = () => showAssetDetail(Number(b.dataset.asset)); });
  body.querySelectorAll('[data-scale]').forEach((b) => { b.onclick = () => showAssetDetail(Number(b.dataset.scale)); });
}
function mlLabelPanel(g) {
  if (!g || !g.table || !g.table.length) return '<div class="amb-panel amb-empty">مفيش تصنيفات كفاية للمقارنة.</div>';
  return `<div class="amb-panel"><div class="table-wrap"><table class="data">
    <thead><tr><th>التصنيف</th><th>كرياتيفات</th><th>صرف</th><th>شراء</th><th>CPA</th><th>CTR</th><th>كفاية</th></tr></thead>
    <tbody>${g.table.map((r) => `<tr ${g.winner && r.label === g.winner.label ? 'style="background:var(--amb-green-bg);"' : ''}>
      <td>${E(r.label)}</td><td>${fmtNum(r.assets)}</td><td>${fmtEGP(r.spend)}</td><td>${fmtNum(r.purchases)}</td><td>${fmtEGP(r.cpa)}</td><td>${fmtPct(r.ctr)}</td>
      <td>${E({ STRONG: 'قوية', MODERATE: 'كافية', WEAK: 'ضعيفة' }[r.dataSufficiency] || '')}</td>
    </tr>`).join('')}</tbody>
  </table></div>${g.winner ? `<div class="faint" style="font-size:12px; margin-top:6px;">البطل: <b>${E(g.winner.label)}</b> — ${E(g.winner.why || '')}</div>` : ''}</div>`;
}

// ===========================================================================
// CAMPAIGN CLONE & SCHEDULE — a new additive workflow. Copies user-selected
// campaigns from ONE source ad account into one or more destination accounts
// as PAUSED, then the backend scheduler activates them at the chosen time
// (default 00:00 in each destination account's timezone). Nothing is created
// on Meta before "APPROVE & SCHEDULE". The source campaigns are never touched.
// ===========================================================================
const cloneState = {
  step: 1, // 1 FROM · 2 CAMPAIGNS · 3 TO · 4 REVIEW & COPY · (5/6) RESULT
  accounts: null,
  srcBiz: '__ALL__',   // Business Portfolio filter for the source picker
  dstBiz: '__ALL__',   // Business Portfolio filter for the destination picker
  sourceId: null,
  campaigns: null,
  campaignsForAccount: null,
  selected: new Set(),
  dests: new Set(),
  execMode: 'RUN_NOW',       // 'RUN_NOW' | 'SCHEDULE' — the ONLY scheduling control
  startDate: '',              // Cairo-local 'YYYY-MM-DD' (defaulted to tomorrow on first render)
  startTime: '00:00',         // Cairo-local 'HH:MM' 24h (default 12:00 AM)
  preview: null,
  analysis: null,           // POST /clone/analyze result
  pageMap: {},               // { sourcePageId: destPageId }
  igChoice: 'PAGE_ONLY',     // a destination IG id, or 'PAGE_ONLY'
  pixelMap: {},              // { sourcePixelId: destPixelId }
  copyValidAdsOnly: false,    // copy the copyable ads, skip the rest (no empty campaigns)
  batchId: null,
  batch: null,
  poll: null,
  busy: false,
};

const CLONE_MODE_AR = {
  REUSE_SAFE: ['إعادة استخدام آمنة', 'green'], REBUILD_FROM_SPEC: ['إعادة بناء من المواصفات', 'blue'],
  REUPLOAD_IMAGE: ['إعادة رفع صورة', 'blue'], REUPLOAD_VIDEO: ['إعادة رفع فيديو', 'blue'],
  REBUILD_CAROUSEL: ['إعادة بناء كاروسيل', 'blue'], UNSUPPORTED: ['غير مدعوم', 'red'],
};
const CLONE_READY_AR = {
  READY: ['✅ جاهز', 'green'], READY_WITH_REBUILD: ['🔄 سيتم إعادة البناء', 'blue'],
  NEEDS_IDENTITY_MAPPING: ['⚠️ يحتاج اختيار هوية', 'yellow'], NEEDS_PIXEL_MAPPING: ['⚠️ يحتاج ربط Pixel', 'yellow'],
  NEEDS_MANUAL_MEDIA: ['⬆️ يحتاج رفع ميديا يدوي', 'yellow'], UNSUPPORTED: ['❌ غير مدعوم', 'red'],
};

const CLONE_BATCH_AR = {
  PENDING_APPROVAL: ['بانتظار الموافقة', 'blue'], DRAFT: ['مسودة', 'gray'],
  APPROVED: ['موافَق — يجهّز', 'blue'], CLONING: ['جارِ الاستنساخ', 'blue'],
  SCHEDULED: ['اتنسخت — متوقفة', 'green'], PARTIALLY_FAILED: ['اكتمل جزئيًا', 'yellow'],
  COMPLETED: ['اكتملت', 'green'], CANCELLED: ['ملغاة', 'gray'], FAILED: ['فشلت', 'red'],
  NEEDS_DECISION: ['محتاجة قرار', 'yellow'], NEEDS_INPUT: ['محتاجة رابط وجهة', 'yellow'],
};
const CLONE_JOB_AR = {
  PENDING: ['بالانتظار', 'gray'], PREFLIGHT_BLOCKED: ['محجوبة', 'red'], CLONING: ['جارِ النسخ', 'blue'],
  NEEDS_INPUT: ['محتاجة رابط وجهة', 'yellow'],
  CLONED_PAUSED: ['اتنسخت — متوقفة', 'green'], ACTIVATION_PENDING: ['جارِ التفعيل', 'blue'],
  ACTIVATED: ['مُفعّلة', 'green'], ACTIVATION_FAILED: ['فشل التفعيل', 'red'], FAILED: ['فشلت', 'red'], CANCELLED: ['ملغاة', 'gray'],
  CANNOT_COPY: ['لا يمكن نسخها', 'red'], NEEDS_DECISION: ['محتاجة قرار', 'yellow'],
};
const PF_AR = { READY: ['جاهزة', 'green'], WARNING: ['تحذير', 'yellow'], BLOCKED: ['محجوبة', 'red'] };
const PF_CHECK_ICON = { INFO: '•', WARN: '⚠', BLOCK: '✖' };

/** Distinct Business Portfolios present in the loaded clone accounts, for the source/dest filters. */
function cloneBizGroups() {
  const m = new Map();
  for (const a of cloneState.accounts || []) {
    const key = a.businessId || '__NONE__';
    if (!m.has(key)) m.set(key, { key, name: a.businessName || 'حسابات فردية (خارج Business)', count: 0 });
    m.get(key).count++;
  }
  return [...m.values()].sort((x, y) => (x.key === '__NONE__' ? 1 : y.key === '__NONE__' ? -1 : x.name.localeCompare(y.name)));
}
/** <select> of Business Portfolios; value '__ALL__' or a businessId or '__NONE__'. */
function cloneBizSelect(id, current) {
  const groups = cloneBizGroups();
  if (groups.length < 2) return ''; // only one portfolio in view — no filter needed
  return `<div class="field" style="max-width:340px; margin-bottom:12px;">
    <label>Business Portfolio</label>
    <select id="${id}">
      <option value="__ALL__" ${current === '__ALL__' ? 'selected' : ''}>كل الـ Business Portfolios</option>
      ${groups.map((g) => `<option value="${E(g.key)}" ${current === g.key ? 'selected' : ''}>${E(g.name)} (${g.count})</option>`).join('')}
    </select>
  </div>`;
}
function cloneAcctInBiz(a, biz) {
  if (biz === '__ALL__') return true;
  if (biz === '__NONE__') return !a.businessId;
  return a.businessId === biz;
}

// ---- Clone "Run Now / Schedule Start" — timezone is ALWAYS Africa/Cairo ----
const CLONE_TZ = 'Africa/Cairo';
/** Cairo-local calendar parts right now: { y, m, d, hh, mm } (numbers). */
function cairoNowParts() {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: CLONE_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date()).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute };
}
/** Cairo-local date 'YYYY-MM-DD', `offsetDays` from today (Cairo). */
function cairoDateStr(offsetDays = 0) {
  const n = cairoNowParts();
  const dt = new Date(Date.UTC(n.y, n.m - 1, n.d));
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  return dt.toISOString().slice(0, 10);
}
/** Is a Cairo-local 'YYYY-MM-DD' + 'HH:MM' strictly in the future? (compared in Cairo wall-clock — no tz math needed for the comparison). */
function cloneStartInFuture(dateStr, timeStr) {
  const n = cairoNowParts();
  const [Y, M, D] = String(dateStr || '').split('-').map(Number);
  const [h, mi] = String(timeStr || '00:00').split(':').map(Number);
  const sel = Date.UTC(Y, (M || 1) - 1, D || 1, h || 0, mi || 0);
  const now = Date.UTC(n.y, n.m - 1, n.d, n.hh, n.mm);
  return sel > now;
}
/** '15:30' -> '03:30 PM' */
function fmt12h(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${String(m || 0).padStart(2, '0')} ${ap}`;
}
/** 'YYYY-MM-DD' -> 'DD/MM/YYYY' */
function fmtDMY(iso) { const [y, m, d] = String(iso || '').split('-'); return d && m && y ? `${d}/${m}/${y}` : iso; }

function cloneUUID() {
  try { return crypto.randomUUID(); } catch { return 'b-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
}
function badge(text, tone) { return `<span class="badge ${tone || 'gray'}">${E(text)}</span>`; }
function acctLabel(a) { return `${a.name || a.id}${a.currency ? ` · ${a.currency}` : ''}${a.timezoneName ? ` · ${a.timezoneName}` : ''}`; }

async function renderClone(panel) {
  if (cloneState.poll) { clearInterval(cloneState.poll); cloneState.poll = null; }
  panel.innerHTML = `<div id="ambCloneRecent"></div><div id="ambCloneBody"><div class="amb-loading">جارِ التحميل…</div></div>`;
  renderCloneRecent();
  await renderCloneStep();
}

async function renderCloneRecent() {
  const el = $('ambCloneRecent');
  if (!el) return;
  let list = [];
  try { list = await api.get('/api/ai-media-buyer/clone/batches?limit=8'); } catch { /* ignore */ }
  if (!list.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="amb-panel" style="margin-bottom:16px;">
      <div class="section-title" style="margin-top:0;">دفعات الاستنساخ الأخيرة</div>
      <div class="amb-clone-recent">
        ${list.map((b) => {
          const [t, tone] = CLONE_BATCH_AR[b.status] || [b.status, 'gray'];
          return `<button class="amb-clone-recent-row" data-batch="${E(b.batchId)}">
            <span class="r-main">${E(b.sourceAccountName || b.sourceAccountId)} → ${b.destinationCount} حساب</span>
            <span class="r-sub">${b.campaignCount} حملة · ${b.totalCopies} نسخة · ${fmtDT(b.createdAt)}</span>
            ${badge(t, tone)}
            <span class="r-jobs">${b.jobs.activated}/${b.jobs.total} مُفعّلة${b.jobs.failed ? ` · ${b.jobs.failed} فشل` : ''}${b.jobs.blocked ? ` · ${b.jobs.blocked} محجوب` : ''}</span>
          </button>`;
        }).join('')}
      </div>
    </div>`;
  el.querySelectorAll('[data-batch]').forEach((b) => {
    b.onclick = () => { cloneState.batchId = b.dataset.batch; cloneState.step = 6; renderCloneStep(); };
  });
}

function cloneStepper() {
  const steps = ['الحساب المصدر', 'اختيار الحملات', 'حساب الوجهة', 'مراجعة ونسخ'];
  return `<div class="amb-steps">${steps.map((s, i) => `
    <div class="amb-step ${cloneState.step === i + 1 ? 'active' : cloneState.step > i + 1 ? 'done' : ''}">
      <span class="n">${cloneState.step > i + 1 ? '✓' : i + 1}</span><span class="l">${E(s)}</span>
    </div>`).join('<span class="amb-step-sep"></span>')}</div>`;
}

async function renderCloneStep() {
  const body = $('ambCloneBody');
  if (!body) return;
  body.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  try {
    if (cloneState.step === 6 || cloneState.step === 5) return renderCloneResult(body);
    if (cloneState.step === 1) return renderCloneFrom(body);
    if (cloneState.step === 2) return renderCloneCampaigns(body);
    if (cloneState.step === 3) return renderCloneTo(body);
    if (cloneState.step === 4) return renderCloneReview(body);
  } catch (err) {
    body.innerHTML = `<div class="amb-panel amb-empty">⚠️ ${E(err.message || err)}</div>
      <div class="toolbar" style="margin-top:12px;"><button class="amb-btn" id="ambCloneRetry">إعادة المحاولة</button></div>`;
    const r = $('ambCloneRetry'); if (r) r.onclick = () => renderCloneStep();
  }
}

function cloneNav(backStep, nextStep, nextLabel, nextEnabled) {
  return `<div class="amb-wizard-nav">
    ${backStep ? `<button class="amb-btn ghost" id="ambCloneBack">رجوع</button>` : '<span></span>'}
    <button class="amb-btn primary" id="ambCloneNext" ${nextEnabled ? '' : 'disabled'}>${E(nextLabel)}</button>
  </div>`;
}
function wireCloneNav(backStep, onNext) {
  const b = $('ambCloneBack'); if (b) b.onclick = () => { cloneState.step = backStep; renderCloneStep(); };
  const n = $('ambCloneNext'); if (n) n.onclick = onNext;
}

// ---- Step 1 · FROM ACCOUNT ----
async function renderCloneFrom(body) {
  if (!cloneState.accounts) {
    const r = await api.get('/api/ai-media-buyer/clone/accounts');
    cloneState.accounts = r.accounts || [];
    if (!cloneState.sourceId && r.selectedAdAccountId) cloneState.sourceId = r.selectedAdAccountId;
  }
  const accts = (cloneState.accounts || []).filter((a) => cloneAcctInBiz(a, cloneState.srcBiz));
  body.innerHTML = `
    ${cloneStepper()}
    <div class="amb-panel">
      <div class="section-title" style="margin-top:0;">من أي حساب إعلاني تنسخ؟</div>
      <div class="faint" style="font-size:12px; margin-bottom:12px;">اختر Business Portfolio ثم حساب مصدر واحد. لن يتم تعديل أي حاجة في هذا الحساب.</div>
      ${cloneBizSelect('ambCloneSrcBiz', cloneState.srcBiz)}
      ${accts.length ? `<div class="amb-radio-list">${accts.map((a) => `
        <label class="amb-radio-row ${cloneState.sourceId === a.id ? 'sel' : ''}">
          <input type="radio" name="ambCloneSrc" value="${E(a.id)}" ${cloneState.sourceId === a.id ? 'checked' : ''} />
          <span class="rr-main">${E(a.name || a.id)}</span>
          <span class="rr-sub">${E(a.id)}${a.currency ? ` · ${E(a.currency)}` : ''}${a.timezoneName ? ` · ${E(a.timezoneName)}` : ''}${a.businessName ? ` · 🏢 ${E(a.businessName)}` : ''}${Number(a.accountStatus) !== 1 ? ' · <b style="color:var(--amb-red)">غير نشط</b>' : ''}</span>
        </label>`).join('')}</div>` : '<div class="amb-empty">مفيش حسابات إعلانية في هذا الاختيار.</div>'}
    </div>
    ${cloneNav(0, 2, 'التالي: اختيار الحملات', !!cloneState.sourceId)}`;
  const sb = $('ambCloneSrcBiz');
  if (sb) sb.onchange = () => { cloneState.srcBiz = sb.value; renderCloneStep(); };
  body.querySelectorAll('input[name="ambCloneSrc"]').forEach((r) => {
    r.onchange = () => {
      if (cloneState.sourceId !== r.value) { cloneState.campaignsForAccount = null; cloneState.selected = new Set(); }
      cloneState.sourceId = r.value;
      cloneState.dests = new Set([...cloneState.dests].filter((d) => d !== r.value));
      renderCloneStep();
    };
  });
  wireCloneNav(0, () => { if (cloneState.sourceId) { cloneState.step = 2; renderCloneStep(); } });
}

// ---- Step 2 · SELECT CAMPAIGNS ----
async function renderCloneCampaigns(body) {
  if (cloneState.campaignsForAccount !== cloneState.sourceId) {
    const r = await api.get(`/api/ai-media-buyer/clone/campaigns?accountId=${encodeURIComponent(cloneState.sourceId)}`);
    cloneState.campaigns = r.campaigns || [];
    cloneState.campaignsForAccount = cloneState.sourceId;
  }
  const list = cloneState.campaigns;
  const srcName = cloneState.accounts?.find((a) => a.id === cloneState.sourceId)?.name || cloneState.sourceId;
  body.innerHTML = `
    ${cloneStepper()}
    <div class="amb-panel">
      <div class="section-title" style="margin-top:0;">اختر الحملات من «${E(srcName)}»</div>
      <div class="faint" style="font-size:12px; margin-bottom:10px;">اختر يدويًا الحملات اللي عايز تنسخها — مفيش أي حاجة بتتنسخ تلقائيًا. <b>للاختبار ابدأ بحملات متوقفة (Paused).</b></div>
      <div class="toolbar" style="margin-bottom:10px;">
        <button class="amb-btn sm" id="ambCloneSelAll">تحديد الكل</button>
        <button class="amb-btn sm ghost" id="ambCloneSelNone">إلغاء التحديد</button>
        <span class="faint" style="font-size:12px;">${cloneState.selected.size} / ${list.length} محددة</span>
      </div>
      ${list.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th></th><th>الحملة</th><th>ID</th><th>الحالة</th><th>الهدف</th><th>الميزانية</th><th>الصرف (7ي)</th><th>شراء</th><th>CPA</th><th>مجموعات</th><th>إعلانات</th></tr></thead>
        <tbody>${list.map((c) => `<tr class="${cloneState.selected.has(c.id) ? 'amb-row-sel' : ''}">
          <td><input type="checkbox" data-camp="${E(c.id)}" ${cloneState.selected.has(c.id) ? 'checked' : ''} /></td>
          <td><b>${E(c.name)}</b></td>
          <td class="mono faint" style="font-size:11px;">${E(c.id)}</td>
          <td>${badge(META_STATUS_AR[c.status] || c.status || '—', c.status === 'ACTIVE' ? 'blue' : 'gray')}</td>
          <td class="faint" style="font-size:12px;">${E(c.objective || '—')}</td>
          <td>${c.dailyBudgetMinor ? fmtEGP(c.dailyBudgetMinor / 100) + '/يوم' : c.lifetimeBudgetMinor ? fmtEGP(c.lifetimeBudgetMinor / 100) : `<span class="faint">${E(c.budgetMode)}</span>`}</td>
          <td>${c.spend == null ? '—' : fmtEGP(c.spend)}</td>
          <td>${fmtNum(c.purchases)}</td>
          <td>${c.cpa == null ? '—' : fmtEGP(c.cpa)}</td>
          <td>${fmtNum(c.adsetCount)}</td>
          <td>${fmtNum(c.adCount)}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<div class="amb-empty">مفيش حملات في الحساب ده.</div>'}
    </div>
    ${cloneNav(1, 3, 'التالي: حسابات الوجهة', cloneState.selected.size > 0)}`;
  const refresh = () => renderCloneStep();
  $('ambCloneSelAll').onclick = () => { cloneState.selected = new Set(list.map((c) => c.id)); refresh(); };
  $('ambCloneSelNone').onclick = () => { cloneState.selected = new Set(); refresh(); };
  body.querySelectorAll('[data-camp]').forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) cloneState.selected.add(cb.dataset.camp); else cloneState.selected.delete(cb.dataset.camp);
      cb.closest('tr').classList.toggle('amb-row-sel', cb.checked);
      const n = $('ambCloneNext'); if (n) n.disabled = cloneState.selected.size === 0;
      const cnt = body.querySelector('.toolbar .faint'); if (cnt) cnt.textContent = `${cloneState.selected.size} / ${list.length} محددة`;
    };
  });
  wireCloneNav(1, () => { if (cloneState.selected.size) { cloneState.step = 3; renderCloneStep(); } });
}

// ---- Step 3 · TO ACCOUNT(S) ----
async function renderCloneTo(body) {
  const others = (cloneState.accounts || []).filter((a) => a.id !== cloneState.sourceId && cloneAcctInBiz(a, cloneState.dstBiz));
  const srcCur = cloneState.accounts?.find((a) => a.id === cloneState.sourceId)?.currency || null;
  body.innerHTML = `
    ${cloneStepper()}
    <div class="amb-panel">
      <div class="section-title" style="margin-top:0;">لأي حسابات تنسخ؟</div>
      <div class="faint" style="font-size:12px; margin-bottom:12px;">اختر Business Portfolio ثم حساب وجهة واحد أو أكثر. حساب المصدر مستبعد تلقائيًا. النسخ عبر Business مختلف مسموح طالما Meta تسمح بالأصول.</div>
      ${cloneBizSelect('ambCloneDstBiz', cloneState.dstBiz)}
      ${others.length ? `<div class="amb-check-list">${others.map((a) => {
        const mism = srcCur && a.currency && srcCur !== a.currency;
        return `<label class="amb-check-row ${cloneState.dests.has(a.id) ? 'sel' : ''}">
          <input type="checkbox" data-dest="${E(a.id)}" ${cloneState.dests.has(a.id) ? 'checked' : ''} />
          <span class="rr-main">${E(a.name || a.id)}</span>
          <span class="rr-sub">${E(a.id)}${a.currency ? ` · ${E(a.currency)}` : ''}${a.timezoneName ? ` · ${E(a.timezoneName)}` : ''}${a.businessName ? ` · 🏢 ${E(a.businessName)}` : ''}${Number(a.accountStatus) !== 1 ? ' · <b style="color:var(--amb-red)">غير نشط</b>' : ''}${mism ? ` · <b style="color:var(--amb-amber)">عملة مختلفة</b>` : ''}</span>
        </label>`;
      }).join('')}</div>` : '<div class="amb-empty">مفيش حسابات في هذا الاختيار.</div>'}
    </div>
    ${cloneNav(2, 4, 'التالي: المراجعة والنسخ', cloneState.dests.size > 0)}`;
  const db = $('ambCloneDstBiz');
  if (db) db.onchange = () => { cloneState.dstBiz = db.value; renderCloneStep(); };
  body.querySelectorAll('[data-dest]').forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) cloneState.dests.add(cb.dataset.dest); else cloneState.dests.delete(cb.dataset.dest);
      cb.closest('label').classList.toggle('sel', cb.checked);
      const n = $('ambCloneNext'); if (n) n.disabled = cloneState.dests.size === 0;
    };
  });
  wireCloneNav(2, () => { if (cloneState.dests.size) { cloneState.step = 4; renderCloneStep(); } });
}

// ---- Step 4 · REVIEW & COPY ----
// (Scheduling is no longer a wizard step — every copied campaign is scheduled
// individually AFTER the copy completes, from the result view / dashboard.)
/** Shared preflight-matrix renderer (grouped by campaign) — used by the wizard review + the pending-batch review. */
function cloneMatrixHtml(matrix) {
  const byCamp = {};
  for (const r of matrix) (byCamp[r.campaignName || r.campaignId] = byCamp[r.campaignName || r.campaignId] || []).push(r);
  return Object.entries(byCamp).map(([cname, rows]) => `
    <div class="amb-pf-camp">
      <div class="amb-pf-camp-h">${E(cname)}</div>
      ${rows.map((r) => {
        const [t, tone] = PF_AR[r.status] || [r.status, 'gray'];
        const bad = (r.checks || []).filter((c) => c.status !== 'INFO');
        return `<div class="amb-pf-row">
          <span class="amb-pf-dest">${E(r.destinationAccountName || r.destinationAccountId)}</span>
          ${badge(t, tone)}
          <div class="amb-pf-reasons">${bad.length ? bad.map((c) => `<div class="pf-reason ${c.status.toLowerCase()}">${PF_CHECK_ICON[c.status] || '•'} ${E(c.detail)}</div>`).join('') : '<span class="faint" style="font-size:12px;">كل الفحوصات سليمة.</span>'}</div>
        </div>`;
      }).join('')}
    </div>`).join('');
}

/** The clone "Run Now / Schedule Start" section — the ONLY thing here that the user controls. Timezone is fixed to Africa/Cairo. */
function cloneScheduleSectionHtml() {
  if (!cloneState.startDate) cloneState.startDate = cairoDateStr(1); // default: tomorrow (Cairo)
  const sched = cloneState.execMode === 'SCHEDULE';
  const summary = sched
    ? `<b>Scheduled</b> · ${fmtDMY(cloneState.startDate)} · ${fmt12h(cloneState.startTime)} · Africa/Cairo`
    : `<b>Run Now</b>`;
  return `
    <div class="section-title">وقت التشغيل / Execution</div>
    <div class="amb-field-grid" style="margin-bottom:8px;">
      <label class="amb-radio-row ${!sched ? 'sel' : ''}" style="cursor:pointer;">
        <input type="radio" name="ambCloneExec" value="RUN_NOW" ${!sched ? 'checked' : ''} />
        <span class="rr-main">تشغيل الآن — Run Now</span>
        <span class="rr-sub">تُنسخ الحملة وتبدأ فورًا حسب منطق التفعيل الحالي.</span>
      </label>
      <label class="amb-radio-row ${sched ? 'sel' : ''}" style="cursor:pointer;">
        <input type="radio" name="ambCloneExec" value="SCHEDULE" ${sched ? 'checked' : ''} />
        <span class="rr-main">جدولة البداية — Schedule Start</span>
        <span class="rr-sub">تُنسخ الحملة متوقفة وتبدأ في التاريخ/الوقت المحددين (بتوقيت القاهرة).</span>
      </label>
    </div>
    <div id="ambCloneSchedFields" ${sched ? '' : 'hidden'}>
      <div class="amb-field-grid">
        <div class="field" style="max-width:190px;">
          <label>Start Date</label>
          <input type="date" id="ambCloneStartDate" value="${E(cloneState.startDate)}" min="${E(cairoDateStr(0))}" />
        </div>
        <div class="field" style="max-width:150px;">
          <label>Start Time</label>
          <input type="time" id="ambCloneStartTime" value="${E(cloneState.startTime)}" />
        </div>
        <div class="field" style="max-width:170px;">
          <label>Timezone</label>
          <input type="text" value="Africa/Cairo" disabled readonly />
        </div>
      </div>
      <div id="ambCloneSchedErr" class="faint" style="font-size:12px; color:var(--amb-red); margin-top:4px;"></div>
    </div>
    <div class="faint" style="font-size:12.5px; margin-top:6px;">Execution Type: <span id="ambCloneExecSummary">${summary}</span></div>
  `;
}
function wireCloneScheduleSection() {
  const paint = () => {
    const sched = cloneState.execMode === 'SCHEDULE';
    const f = $('ambCloneSchedFields'); if (f) f.hidden = !sched;
    const s = $('ambCloneExecSummary');
    if (s) s.innerHTML = sched
      ? `<b>Scheduled</b> · ${fmtDMY(cloneState.startDate)} · ${fmt12h(cloneState.startTime)} · Africa/Cairo`
      : `<b>Run Now</b>`;
    const cell = $('ambCloneExecCell');
    if (cell) cell.textContent = sched
      ? `مجدولة — ${fmtDMY(cloneState.startDate)} ${fmt12h(cloneState.startTime)} (القاهرة)`
      : 'تشغيل الآن';
    const err = $('ambCloneSchedErr');
    if (err) err.textContent = (sched && !cloneStartInFuture(cloneState.startDate, cloneState.startTime))
      ? 'لازم يكون تاريخ ووقت البداية في المستقبل. — The selected start date and time must be in the future.' : '';
    document.querySelectorAll('input[name="ambCloneExec"]').forEach((r) => r.closest('.amb-radio-row')?.classList.toggle('sel', r.checked));
    syncCloneApproveButton();
  };
  document.querySelectorAll('input[name="ambCloneExec"]').forEach((r) => {
    r.onchange = () => { cloneState.execMode = r.value === 'SCHEDULE' ? 'SCHEDULE' : 'RUN_NOW'; paint(); };
  });
  const d = $('ambCloneStartDate'); if (d) d.onchange = () => { cloneState.startDate = d.value || cairoDateStr(1); paint(); };
  const t = $('ambCloneStartTime'); if (t) t.onchange = () => { cloneState.startTime = /^\d{1,2}:\d{2}$/.test(t.value) ? t.value : '00:00'; paint(); };
  paint();
}
/** True when the scheduling section is in a valid state to submit. */
function cloneScheduleValid() {
  return cloneState.execMode !== 'SCHEDULE' || cloneStartInFuture(cloneState.startDate, cloneState.startTime);
}

function cloneIdentityMapPayload() {
  // Single-destination wizard: one dest page for all source pages, one IG choice.
  const pages = {};
  for (const [src, dst] of Object.entries(cloneState.pageMap)) if (dst) pages[src] = dst;
  const anyDest = Object.values(pages)[0] || null;
  const igIsAccount = cloneState.igChoice && cloneState.igChoice !== 'PAGE_ONLY';
  return {
    destinationPageId: anyDest,
    destinationInstagramId: igIsAccount ? cloneState.igChoice : null,
    identityMap: { pages, instagram: {} },
    allowPageOnlyIg: !igIsAccount,
    copyValidAdsOnly: cloneState.copyValidAdsOnly === true,
    pixelMap: Object.fromEntries(Object.entries(cloneState.pixelMap).filter(([, v]) => v)),
  };
}

async function runCloneAnalysis() {
  const idp = cloneIdentityMapPayload();
  cloneState.analysis = await api.post('/api/ai-media-buyer/clone/analyze', {
    sourceAccountId: cloneState.sourceId,
    destinationAccountIds: [...cloneState.dests],
    campaignIds: [...cloneState.selected],
    destinationPageId: idp.destinationPageId,
    destinationInstagramId: idp.destinationInstagramId,
    identityMap: idp.identityMap,
    pixelMap: idp.pixelMap,
    allowPageOnlyIg: idp.allowPageOnlyIg,
  });
  return cloneState.analysis;
}

async function renderCloneReview(body) {
  const [preview, analysis] = await Promise.all([
    api.post('/api/ai-media-buyer/clone/preview', {
      sourceAccountId: cloneState.sourceId,
      destinationAccountIds: [...cloneState.dests],
      campaignIds: [...cloneState.selected],
    }),
    runCloneAnalysis().catch((e) => ({ __error: e.message })),
  ]);
  cloneState.preview = preview;
  if (!analysis.__error) cloneState.analysis = analysis;
  const rowsByCamp = {};
  for (const r of preview.matrix) (rowsByCamp[r.campaignId] = rowsByCamp[r.campaignId] || []).push(r);

  body.innerHTML = `
    ${cloneStepper()}
    <div class="amb-panel amb-review">
      <div class="amb-review-grid">
        <div><span class="rl">المصدر</span><span class="rv">${E(preview.source.name)}</span></div>
        <div><span class="rl">الحملات المختارة</span><span class="rv">${preview.campaigns.length}</span></div>
        <div><span class="rl">حسابات الوجهة</span><span class="rv">${preview.destinations.length}</span></div>
        <div><span class="rl">إجمالي النسخ</span><span class="rv">${preview.totalCopies}${preview.blockedCopies ? ` <span class="faint" style="font-size:12px;">(${preview.cloneableCopies} قابلة · ${preview.blockedCopies} محجوبة)</span>` : ''}</span></div>
        <div><span class="rl">وقت التشغيل</span><span class="rv" id="ambCloneExecCell">${cloneState.execMode === 'SCHEDULE' ? `مجدولة — ${fmtDMY(cloneState.startDate || cairoDateStr(1))} ${fmt12h(cloneState.startTime)} (القاهرة)` : 'تشغيل الآن'}</span></div>
        <div><span class="rl">حملات المصدر</span><span class="rv" style="color:var(--amb-green); font-weight:800;">بدون أي تغيير</span></div>
      </div>

      <div class="section-title">الحملات</div>
      <div class="faint" style="font-size:12.5px; margin-bottom:10px;">${preview.campaigns.map((c) => E(c.name)).join(' · ')}</div>

      <div class="section-title">حسابات الوجهة</div>
      <div class="amb-derived" style="margin-bottom:12px;">
        ${preview.destinations.map((d) => `<div class="amb-derived-row"><span>${E(d.name)}</span><b class="faint">${E(d.timezoneName || '')}</b></div>`).join('')}
      </div>

      <div class="section-title">فحص ما قبل الاستنساخ</div>
      <div class="amb-pf-list">
        ${Object.entries(rowsByCamp).map(([cid, rows]) => {
          const cname = rows[0]?.campaignName || cid;
          return `<div class="amb-pf-camp">
            <div class="amb-pf-camp-h">${E(cname)}</div>
            ${rows.map((r) => {
              const [t, tone] = PF_AR[r.status] || [r.status, 'gray'];
              const bad = (r.checks || []).filter((c) => c.status !== 'INFO');
              return `<div class="amb-pf-row">
                <span class="amb-pf-dest">${E(r.destinationAccountName)}</span>
                ${badge(t, tone)}
                <div class="amb-pf-reasons">${bad.length ? bad.map((c) => `<div class="pf-reason ${c.status.toLowerCase()}">${PF_CHECK_ICON[c.status] || '•'} ${E(c.detail)}</div>`).join('') : '<span class="faint" style="font-size:12px;">كل الفحوصات سليمة.</span>'}</div>
              </div>`;
            }).join('')}
          </div>`;
        }).join('')}
      </div>
      ${preview.blockedCopies ? `<div class="amb-batchnote" style="margin-top:12px;"><span>${preview.blockedCopies} نسخة محجوبة ومش هتتنسخ.</span></div>` : ''}

      ${cloneScheduleSectionHtml()}

      <div id="ambCloneRebuild"></div>

      <div class="amb-wizard-nav" style="margin-top:18px;">
        <div style="display:flex; gap:8px;">
          <button class="amb-btn ghost" id="ambCloneBack">رجوع وتعديل</button>
          <button class="amb-btn ghost" id="ambCloneCancel">إلغاء</button>
        </div>
        <button class="amb-btn primary" id="ambCloneApprove" ${preview.cloneableCopies > 0 && state.isAdmin ? '' : 'disabled'}>
          ${state.isAdmin ? `نسخ إلى حساب الوجهة (${preview.cloneableCopies})` : 'النسخ متاح للـ ADMIN فقط'}
        </button>
      </div>
    </div>`;
  renderCloneRebuildPanel();
  wireCloneScheduleSection();
  $('ambCloneBack').onclick = () => { cloneState.step = 3; renderCloneStep(); };
  $('ambCloneCancel').onclick = () => { resetCloneWizard(); renderCloneRecent(); renderCloneStep(); };
  const ap = $('ambCloneApprove');
  if (ap) ap.onclick = async () => {
    if (!cloneScheduleValid()) { UI.toast('لازم يكون تاريخ ووقت البداية في المستقبل. — The selected start date and time must be in the future.', 'error'); return; }
    const scheduled = cloneState.execMode === 'SCHEDULE';
    const startAt = scheduled ? `${cloneState.startDate}T${cloneState.startTime}` : null;
    const ok = await UI.confirmModal({
      title: scheduled ? 'نسخ وجدولة البداية' : 'نسخ وتشغيل الآن',
      message: `هيتم إنشاء ${preview.cloneableCopies} حملة (بكل المجموعات والإعلانات) في ${preview.destinations.length} حساب وجهة كنسخة مطابقة للمصدر. حملات المصدر مش هتتغير خالص.<br><br>`
        + (scheduled
          ? `<b>وقت التشغيل:</b> ${fmtDMY(cloneState.startDate)} — ${fmt12h(cloneState.startTime)} — Africa/Cairo.<br>تُنسخ متوقفة (PAUSED) وتتفعّل تلقائيًا في الوقت ده.`
          : `<b>وقت التشغيل:</b> تشغيل الآن — تُنسخ (PAUSED) وتتفعّل فورًا بعد اكتمال النسخ.`)
        + `<br><br>متابعة؟`,
      confirmLabel: scheduled ? 'نسخ وجدولة' : 'نسخ وتشغيل', danger: true,
    });
    if (!ok) return;
    ap.disabled = true; ap.textContent = '… بيجهّز الدفعة';
    try {
      if (!cloneState.batchId) cloneState.batchId = cloneUUID();
      const idp = cloneIdentityMapPayload();
      await api.post('/api/ai-media-buyer/clone/batches', {
        batchId: cloneState.batchId,
        sourceAccountId: cloneState.sourceId,
        destinationAccountIds: [...cloneState.dests],
        campaignIds: [...cloneState.selected],
        executionMode: cloneState.execMode,
        startAt,
        destinationPageId: idp.destinationPageId,
        destinationInstagramId: idp.destinationInstagramId,
        identityMap: idp.identityMap,
        pixelMap: idp.pixelMap,
        allowPageOnlyIg: idp.allowPageOnlyIg,
        copyValidAdsOnly: idp.copyValidAdsOnly,
      });
      await api.post(`/api/ai-media-buyer/clone/batches/${cloneState.batchId}/approve`, {});
      UI.toast(scheduled ? '✅ تمت الموافقة — نسخ + جدولة البداية' : '✅ تمت الموافقة — نسخ + تشغيل الآن');
      cloneState.step = 6;
      renderCloneStep();
    } catch (err) {
      UI.toast(err.message, 'error');
      ap.disabled = false;
      syncCloneApproveButton();
    }
  };
}

const COPY_STATUS_AR = {
  READY: ['✅ جاهز', 'green'], NEEDS_MAPPING: ['⚠️ يحتاج اختيار', 'yellow'], CANNOT_COPY: ['❌ لا يمكن نسخه', 'red'],
};
const ASSET_ACTION_AR = {
  REUSE: 'إعادة استخدام نفس الأصل', REUPLOAD: 'رفع نفس الملف للوجهة', REUSE_OR_MANUAL: 'محاولة إعادة الاستخدام؛ وإلا رفع يدوي', NONE: '—',
};

/** "Duplicate campaigns to another ad account" — mapping selectors (only when needed) + a plain per-ad copy table. */
function renderCloneRebuildPanel() {
  const el = $('ambCloneRebuild');
  if (!el) return;
  const a = cloneState.analysis;
  if (!a || a.__error) { el.innerHTML = a?.__error ? `<div class="amb-batchnote"><span>تعذّر تحليل النسخ: ${E(a.__error)}</span></div>` : ''; return; }

  const t = a.overallCopySummary || { campaigns: 0, adSets: 0, ads: 0, ready: 0, needsMapping: 0, cannotCopy: 0 };
  const srcPages = [...new Set(a.campaigns.flatMap((c) => c.identityRequired?.pages || []))];
  // Pixels that still need a choice (not already shared into the destination).
  const srcPixelsNeedingMap = [...new Set(a.campaigns.flatMap((c) => c.ads.filter((ad) => ad.pixel?.status === 'NEEDS_PIXEL_MAPPING').map((ad) => ad.pixel.sourcePixelId)))];
  const igNeeded = a.campaigns.some((c) => c.ads.some((ad) => ['NEEDS_CHOICE', 'PAGE_ONLY'].includes(ad.identity?.igStatus)));
  const c0 = a.campaigns[0] || {};
  const destPages = c0.destinationIdentities?.pages || [];
  const destIg = c0.destinationIdentities?.instagram || [];
  const destPixels = c0.destinationPixels || [];

  const needMappingSection = srcPages.length || srcPixelsNeedingMap.length || igNeeded;

  el.innerHTML = `
    <div class="section-title">معاينة النسخ</div>
    <div class="amb-derived" style="margin-bottom:12px;">
      <div class="amb-derived-row"><span>الحملات المختارة</span><b>${t.campaigns}</b></div>
      <div class="amb-derived-row"><span>المجموعات الإعلانية</span><b>${t.adSets}</b></div>
      <div class="amb-derived-row"><span>الإعلانات</span><b>${t.ads}</b></div>
      <div class="amb-derived-row"><span>جاهز</span><b style="color:var(--amb-green)">${t.ready}</b></div>
      <div class="amb-derived-row"><span>يحتاج اختيار</span><b style="color:var(--amb-amber)">${t.needsMapping}</b></div>
      <div class="amb-derived-row"><span>لا يمكن نسخه</span><b style="color:${t.cannotCopy ? 'var(--amb-red)' : 'var(--amb-text)'}">${t.cannotCopy}</b></div>
    </div>

    ${needMappingSection ? `
      <div class="section-title">اختيارات الوجهة المطلوبة</div>
      <div class="faint" style="font-size:12px; margin-bottom:8px;">فقط الموارد اللي مش قابلة للنسخ المباشر. الموارد المشتركة (زي الـ Pixel المشترك) بتُعاد استخدامها تلقائيًا.</div>
      <div class="amb-field-grid">
        ${srcPages.map((sp) => `
          <div class="field"><label>صفحة فيسبوك للوجهة (بدل ${E(sp)})</label>
            <select data-pagemap="${E(sp)}">
              <option value="">— اختر صفحة —</option>
              ${destPages.map((p) => `<option value="${E(p.id)}" ${cloneState.pageMap[sp] === p.id ? 'selected' : ''}>${E(p.name || p.label || p.id)} (${E(p.id)})${p.source === 'user_account' ? ' — صفحتك' : p.source === 'promote_pages' ? '' : ' — Portfolio'}</option>`).join('')}
            </select>
          </div>`).join('')}
        ${igNeeded ? `
          <div class="field"><label>حساب انستجرام للوجهة</label>
            <select data-igchoice>
              ${destIg.map((g) => `<option value="${E(g.id)}" ${cloneState.igChoice === g.id ? 'selected' : ''}>@${E(g.username)}</option>`).join('')}
              <option value="PAGE_ONLY" ${cloneState.igChoice === 'PAGE_ONLY' ? 'selected' : ''}>هوية الصفحة فقط (لا يوجد حساب انستجرام في الوجهة)</option>
            </select>
          </div>` : ''}
        ${srcPixelsNeedingMap.map((sx) => `
          <div class="field"><label>Pixel/Dataset للوجهة (بدل ${E(sx)})</label>
            <select data-pixelmap="${E(sx)}">
              <option value="">— اختر Pixel —</option>
              ${destPixels.map((p) => `<option value="${E(p.id)}" ${cloneState.pixelMap[sx] === p.id ? 'selected' : ''}>${E(p.name)} (${E(p.id)})</option>`).join('')}
            </select>
          </div>`).join('')}
      </div>
    ` : '<div class="faint" style="font-size:12px; margin-bottom:8px;">✅ كل الموارد (الصفحة / انستجرام / الـ Pixel) متاحة من حساب الوجهة — مفيش اختيارات مطلوبة.</div>'}

    <div class="section-title">تفاصيل الإعلانات</div>
    ${a.campaigns.map((c) => `
      <div class="amb-pf-camp" style="margin-top:8px;">
        <div class="amb-pf-camp-h">${E(c.campaignName)} → ${E(c.destinationAccountName)} · ${E(c.copySummary.ready)}/${E(c.copySummary.totalAds)} جاهز${c.copySummary.needsMapping ? ` · ${c.copySummary.needsMapping} يحتاج اختيار` : ''}${c.copySummary.cannotCopy ? ` · ${c.copySummary.cannotCopy} لا يمكن نسخه` : ''}</div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>الإعلان</th><th>الحالة</th><th>الوسائط</th><th>السبب / الملاحظة</th></tr></thead>
          <tbody>${c.ads.map((ad) => {
            const [st, stone] = COPY_STATUS_AR[ad.copyStatus] || [ad.copyStatus, 'gray'];
            return `<tr>
              <td>${E(ad.adName || ad.adId)}<div class="faint" style="font-size:10px;">${E(ad.normalized?.format || '')}</div></td>
              <td>${badge(st, stone)}</td>
              <td style="font-size:11px;">${E(ASSET_ACTION_AR[ad.assetAction] || ad.assetAction || '—')}</td>
              <td style="font-size:11px;">${(ad.copyReasons || []).map(E).join('<br/>') || '—'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>`).join('')}

    ${t.cannotCopy ? `
      <div class="amb-batchnote" style="margin-top:12px;">
        <span>${t.cannotCopy} إعلان مش قابل للنسخ. تقدر تنسخ الباقي وتتجاهلهم، أو تلغي.</span>
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
          <input type="checkbox" id="ambCloneValidOnly" ${cloneState.copyValidAdsOnly ? 'checked' : ''} /> نسخ الإعلانات الصالحة فقط
        </label>
      </div>` : ''}

    <div class="faint" style="font-size:11px; margin-top:10px;">${E(a.metaDuplicationNote || '')}</div>
    <div class="faint" style="font-size:11px; margin-top:4px;">${E(a.appModeWarning || '')}</div>
  `;

  const reAnalyze = async () => { el.querySelectorAll('select,input').forEach((s) => (s.disabled = true)); try { await runCloneAnalysis(); } catch (e) { UI.toast(e.message, 'error'); } renderCloneRebuildPanel(); syncCloneApproveButton(); };
  el.querySelectorAll('[data-pagemap]').forEach((s) => { s.onchange = () => { cloneState.pageMap[s.dataset.pagemap] = s.value || null; reAnalyze(); }; });
  el.querySelectorAll('[data-pixelmap]').forEach((s) => { s.onchange = () => { cloneState.pixelMap[s.dataset.pixelmap] = s.value || null; reAnalyze(); }; });
  const ig = el.querySelector('[data-igchoice]');
  if (ig) ig.onchange = () => { cloneState.igChoice = ig.value; reAnalyze(); };
  const vo = $('ambCloneValidOnly');
  if (vo) vo.onchange = () => { cloneState.copyValidAdsOnly = vo.checked; syncCloneApproveButton(); };
  syncCloneApproveButton();
}

/** Enable "Copy to destination" only when every ad is READY, or the user opted into "valid ads only". */
function syncCloneApproveButton() {
  const ap = $('ambCloneApprove');
  const a = cloneState.analysis;
  if (!ap || !a || a.__error) return;
  const t = a.overallCopySummary || {};
  const schedBad = !cloneScheduleValid();
  const blocked = (t.needsMapping || 0) > 0 || ((t.cannotCopy || 0) > 0 && !cloneState.copyValidAdsOnly) || schedBad;
  ap.disabled = !state.isAdmin || (cloneState.preview?.cloneableCopies || 0) === 0 || blocked;
  const n = cloneState.preview?.cloneableCopies || 0;
  ap.textContent = !state.isAdmin ? 'النسخ متاح للـ ADMIN فقط'
    : (t.needsMapping || 0) > 0 ? `أكمل الاختيارات المطلوبة (${t.needsMapping})`
    : ((t.cannotCopy || 0) > 0 && !cloneState.copyValidAdsOnly) ? 'فعّل «نسخ الإعلانات الصالحة فقط» أو ألغِ'
    : schedBad ? 'صحّح تاريخ/وقت البداية'
    : cloneState.execMode === 'SCHEDULE' ? `نسخ وجدولة البداية (${n})`
    : `نسخ وتشغيل الآن (${n})`;
}

function resetCloneWizard() {
  Object.assign(cloneState, { step: 1, srcBiz: '__ALL__', dstBiz: '__ALL__', sourceId: null, campaigns: null, campaignsForAccount: null, selected: new Set(), dests: new Set(), execMode: 'RUN_NOW', startDate: '', startTime: '00:00', preview: null, analysis: null, pageMap: {}, igChoice: 'PAGE_ONLY', pixelMap: {}, batchId: null, batch: null });
}

// ---- Step 6 · RESULT / progress ----
async function renderCloneResult(body) {
  const b = await api.get(`/api/ai-media-buyer/clone/batches/${cloneState.batchId}`);
  cloneState.batch = b;
  const [bt, btone] = CLONE_BATCH_AR[b.status] || [b.status, 'gray'];
  const jobsByDest = {};
  for (const jb of b.jobs) (jobsByDest[jb.destinationAccountId] = jobsByDest[jb.destinationAccountId] || []).push(jb);
  const live = ['APPROVED', 'CLONING'].includes(b.status);

  body.innerHTML = `
    <div class="amb-panel">
      <div class="amb-clone-result-h">
        <div>
          <div style="font-weight:800; font-size:15px;">${E(b.source.name || b.source.id)} → ${b.destinationAccountIds.length} حساب</div>
          <div class="faint" style="font-size:12px;">${b.campaignIds.length} حملة · ${b.totalCopies} نسخة · كلها متوقفة (PAUSED) · أنشأها ${E(b.createdBy || '—')}${b.approvedBy ? ` · وافق ${E(b.approvedBy)}` : ''}</div>
        </div>
        ${badge(bt, btone)}
      </div>
      <div class="amb-clone-summary">
        <span>${b.jobsSummary.clonedPaused} اتنسخت</span>
        <span>${b.jobsSummary.activated} مُفعّلة</span>
        ${b.jobsSummary.failed ? `<span class="bad">${b.jobsSummary.failed} فشل</span>` : ''}
        ${b.jobsSummary.blocked ? `<span class="bad">${b.jobsSummary.blocked} محجوب</span>` : ''}
        ${b.jobsSummary.cloning ? `<span class="busy">${b.jobsSummary.cloning} جارٍ</span>` : ''}
      </div>
      <div style="font-size:12.5px; margin-top:6px;">Execution Type: <b>${b.executionMode === 'SCHEDULE' ? `Scheduled — ${E(fmtDMY((b.startAtCairo || '').split('T')[0]))} ${E(fmt12h((b.startAtCairo || '').split('T')[1] || '00:00'))} — Africa/Cairo` : b.executionMode === 'RUN_NOW' ? 'Run Now' : '—'}</b></div>
      <div style="color:var(--amb-green); font-size:12.5px; font-weight:700; margin-top:6px;">حملات المصدر: بدون أي تغيير (نسخة مطابقة)</div>
      ${b.error ? `<div style="color:var(--amb-red); font-size:12.5px; margin-top:6px;">${E(b.error)}</div>` : ''}

      ${b.status === 'PENDING_APPROVAL' ? `
        <div class="section-title">فحص ما قبل الاستنساخ</div>
        <div class="amb-pf-list">${cloneMatrixHtml(b.preflight || [])}</div>
        <div class="amb-wizard-nav" style="margin-top:16px;">
          <button class="amb-btn ghost" id="ambCloneCancelBatch2">إلغاء</button>
          <button class="amb-btn primary" id="ambCloneApprovePending" ${state.isAdmin ? '' : 'disabled'}>${state.isAdmin ? 'نسخ إلى حساب الوجهة' : 'النسخ متاح للـ ADMIN فقط'}</button>
        </div>
      ` : ''}

      ${Object.entries(jobsByDest).map(([did, jobs]) => `
        <div class="amb-clone-dest">
          <div class="amb-clone-dest-h">${E(jobs[0].destinationAccountName || did)} <span class="faint">${E(jobs[0].destinationTimezone || '')}</span></div>
          ${jobs.map(cloneJobCard).join('')}
        </div>`).join('')}

      <div id="ambCloneSchedules"></div>

      <details class="amb-clone-audit" style="margin-top:14px;">
        <summary>سجل التدقيق (${b.audit.length})</summary>
        <div class="amb-audit-list">
          ${b.audit.map((a) => `<div class="amb-audit-row"><span class="faint">${fmtDT(a.at)}</span> <b>${E(a.event)}</b>${a.level ? ` · ${E(a.level)}` : ''}${a.detail ? ` — ${E(a.detail)}` : ''}</div>`).join('') || '<div class="faint">—</div>'}
        </div>
      </details>

      <div class="toolbar" style="margin-top:16px; flex-wrap:wrap; gap:8px;">
        ${state.isAdmin && ['PARTIALLY_FAILED', 'FAILED', 'SCHEDULED', 'NEEDS_INPUT'].includes(b.status) ? `<button class="amb-btn" id="ambCloneResume">استئناف الفاشل/الناقص</button>` : ''}
        ${state.isAdmin && !['COMPLETED', 'CANCELLED'].includes(b.status) ? `<button class="amb-btn danger" id="ambCloneCancelBatch">إلغاء الجدولة</button>` : ''}
        <button class="amb-btn ghost" id="ambCloneRefresh">تحديث</button>
        <button class="amb-btn" id="ambCloneNew">دفعة جديدة</button>
      </div>
      ${live ? `<div class="faint" style="font-size:11.5px; margin-top:8px;">بيحدّث تلقائيًا…</div>` : ''}
    </div>`;

  body.querySelectorAll('[data-jobtoggle]').forEach((s) => {
    s.onclick = () => { const d = s.nextElementSibling; if (d) d.hidden = !d.hidden; };
  });
  body.querySelectorAll('[data-adurl-save]').forEach((btn) => {
    btn.onclick = async () => {
      const sourceAdId = btn.dataset.adurlSave;
      const inp = body.querySelector(`[data-adurl="${sourceAdId}"]`);
      const url = (inp?.value || '').trim();
      if (!/^https?:\/\/.+/i.test(url)) { UI.toast('أدخل رابطًا صحيحًا يبدأ بـ https://', 'error'); return; }
      btn.disabled = true;
      try {
        await api.post(`/api/ai-media-buyer/clone/batches/${b.batchId}/ad-url`, { sourceAdId, url, resume: true });
        UI.toast('✅ اتحفظ الرابط — جارِ استئناف الإعلان');
        renderCloneStep();
      } catch (e) { UI.toast(e.message, 'error'); btn.disabled = false; }
    };
  });
  if ($('ambCloneSchedules')) renderCloneSchedules($('ambCloneSchedules'), b).catch(() => {});
  const rs = $('ambCloneResume');
  if (rs) rs.onclick = async () => { rs.disabled = true; try { await api.post(`/api/ai-media-buyer/clone/batches/${b.batchId}/resume`, {}); UI.toast('↻ استئناف'); renderCloneStep(); } catch (e) { UI.toast(e.message, 'error'); rs.disabled = false; } };
  const cb = $('ambCloneCancelBatch');
  if (cb) cb.onclick = async () => {
    if (!(await UI.confirmModal({ title: 'إلغاء جدولة الدفعة', message: 'النسخ اللي اتعملت هتفضل متوقفة (PAUSED) ومش هتتفعّل. متابعة؟', danger: true, confirmLabel: 'إلغاء الجدولة' }))) return;
    try { await api.post(`/api/ai-media-buyer/clone/batches/${b.batchId}/cancel`, {}); UI.toast('أُلغيت الجدولة'); renderCloneStep(); } catch (e) { UI.toast(e.message, 'error'); }
  };
  $('ambCloneRefresh').onclick = () => renderCloneStep();
  $('ambCloneNew').onclick = () => { resetCloneWizard(); renderCloneRecent(); renderCloneStep(); };
  const ap = $('ambCloneApprovePending');
  if (ap) ap.onclick = async () => {
    const ok = await UI.confirmModal({ title: 'نسخ إلى حساب الوجهة', message: `هيتم إنشاء النسخ في حساب الوجهة وكلها <b>متوقفة (PAUSED)</b>. حملات المصدر مش هتتغير. الجدولة بتتحدد بعد اكتمال النسخ. متابعة؟`, confirmLabel: 'نسخ الآن', danger: true });
    if (!ok) return;
    ap.disabled = true; ap.textContent = '… بيجهّز';
    try { await api.post(`/api/ai-media-buyer/clone/batches/${b.batchId}/approve`, {}); UI.toast('✅ تمت الموافقة — بدأ الاستنساخ'); renderCloneStep(); }
    catch (e) { UI.toast(e.message, 'error'); ap.disabled = false; ap.textContent = 'نسخ إلى حساب الوجهة'; }
  };
  const cb2 = $('ambCloneCancelBatch2');
  if (cb2) cb2.onclick = async () => {
    if (!(await UI.confirmModal({ title: 'إلغاء الدفعة', message: 'هتتلغي خطة الاستنساخ دي. متابعة؟', danger: true, confirmLabel: 'إلغاء' }))) return;
    try { await api.post(`/api/ai-media-buyer/clone/batches/${b.batchId}/cancel`, {}); UI.toast('أُلغيت'); resetCloneWizard(); renderCloneRecent(); renderCloneStep(); } catch (e) { UI.toast(e.message, 'error'); }
  };

  if (cloneState.poll) { clearInterval(cloneState.poll); cloneState.poll = null; }
  if (live) {
    cloneState.poll = setInterval(async () => {
      if (state.tab !== 'clone' || cloneState.step !== 6) { clearInterval(cloneState.poll); cloneState.poll = null; return; }
      try {
        const fresh = await api.get(`/api/ai-media-buyer/clone/batches/${cloneState.batchId}`);
        if (!['APPROVED', 'CLONING'].includes(fresh.status)) { clearInterval(cloneState.poll); cloneState.poll = null; }
        renderCloneResult(body);
      } catch { /* keep polling */ }
    }, 4000);
  }
}

function cloneJobCard(jb) {
  const [t, tone] = CLONE_JOB_AR[jb.status] || [jb.status, 'gray'];
  const cc = jb.copiesCreated || {};
  const bad = (jb.preflightChecks || []).filter((c) => c.status === 'BLOCK');
  const objs = jb.objects || [];
  const objLine = (o) => `<div class="amb-obj-row ${o.status === 'FAILED' ? 'bad' : o.status === 'CREATED' ? 'ok' : ''}">
    <span>${E(o.level)}</span><span class="faint">${E(o.sourceName || o.sourceId)}</span>
    <span>${o.status === 'CREATED' ? `→ ${E(o.destinationId || '')}` : E({ PENDING: 'بالانتظار', FAILED: 'فشل', SKIPPED: 'تخطّي', NEEDS_INPUT: 'محتاج رابط' }[o.status] || o.status)}</span>
    ${o.error ? `<span class="${o.status === 'NEEDS_INPUT' ? 'warn' : 'bad'}" style="flex-basis:100%; font-size:11px;">${E(o.error)}</span>` : ''}
    ${o.status === 'NEEDS_INPUT' && o.level === 'AD' ? `<span style="flex-basis:100%; display:flex; gap:6px; margin-top:4px;">
      <input type="url" placeholder="https://…" data-adurl="${E(o.sourceId)}" style="flex:1; font-size:12px; padding:4px 6px;" />
      <button class="amb-btn sm" data-adurl-save="${E(o.sourceId)}">حفظ الرابط واستئناف</button>
    </span>` : ''}
  </div>`;
  return `<div class="amb-clone-job">
    <div class="amb-clone-job-h" data-jobtoggle="1">
      <span class="j-name">${E(jb.sourceCampaignName || jb.sourceCampaignId)}</span>
      ${badge(t, tone)}
      <span class="j-meta faint">${cc.adsets != null ? `${cc.adsets} مجموعة · ${cc.ads} إعلان · ` : ''}${jb.status === 'CLONED_PAUSED' ? 'متوقفة — جاهزة للجدولة' : ''}${jb.destinationCampaignId ? ` · <span class="mono">${E(jb.destinationCampaignId)}</span>` : ''}</span>
    </div>
    <div class="amb-clone-job-d" hidden>
      ${jb.error ? `<div class="bad" style="font-size:12px; margin-bottom:6px;">${E(jb.error)}</div>` : ''}
      ${bad.length ? `<div style="font-size:12px; margin-bottom:6px;">${bad.map((c) => `<div class="pf-reason block">✖ ${E(c.detail)}</div>`).join('')}</div>` : ''}
      ${objs.length ? `<div class="amb-obj-list">${objs.map(objLine).join('')}</div>` : '<div class="faint" style="font-size:12px;">مفيش عناصر متسجلة بعد.</div>'}
    </div>
  </div>`;
}

// ---- Settings — logic UNCHANGED ----
const SETTING_FIELDS = [
  ['ambExecutionMode', 'وضع التشغيل', 'select', ['ADVISORY', 'APPROVAL', 'AUTOPILOT']],
  ['ambSyncIntervalMinutes', 'كل كام دقيقة تتم المزامنة', 'number'],
  ['ambAlsoRefreshAdsDailyMetric', 'حدّث كمان بيانات AI Intelligence مع كل مزامنة', 'bool'],
  ['ambDefaultPricingMultiplier', 'مضاعف التسعير الافتراضي', 'number'],
  ['ambDefaultTargetCpa', 'Target CPA الافتراضي', 'number'],
  ['ambDefaultCurrency', 'العملة الافتراضية', 'text'],
  ['ambNoPurchaseStopMultiplier', 'مضاعف الإيقاف بدون شراء (Target CPA ×)', 'number'],
  ['ambMaxBudgetIncreasePct', 'أقصى زيادة ميزانية لكل أكشن %', 'number'],
  ['ambScalingCooldownHours', 'فترة تهدئة التوسّع (ساعات)', 'number'],
  ['ambMaxDailyBudgetIncreasePct', 'أقصى زيادة ميزانية يومية %', 'number'],
  ['ambMaxAllowedDailyLoss', 'أقصى خسارة يومية مسموحة', 'number'],
  ['ambMaxAutoExecutionAmount', 'أقصى مبلغ تنفيذ تلقائي', 'number'],
  ['ambMinPurchasesBeforeScaling', 'أدنى مشتريات قبل التوسّع', 'number'],
  ['ambMinSpendBeforeDecision', 'أدنى صرف قبل أي قرار', 'number'],
  ['ambAnalysisLookbackDays', 'نافذة التحليل (أيام)', 'number'],
  ['ambScaleCpaBetterPct', 'CPA لازم يكون أحسن من الهدف بـ % قبل التوسّع', 'number'],
  ['ambCreativeFatigueFreqThreshold', 'حد التكرار لإجهاد الكرييتف', 'number'],
  ['ambAllowAutoPause', 'أوتوبايلوت: اسمح بالإيقاف التلقائي', 'bool'],
  ['ambAllowAutoBudgetIncrease', 'أوتوبايلوت: اسمح بزيادة الميزانية', 'bool'],
  ['ambAllowAutoBudgetDecrease', 'أوتوبايلوت: اسمح بتقليل الميزانية', 'bool'],
  ['ambAllowDuplicationActions', 'أوتوبايلوت: اسمح بأكشنز التكرار', 'bool'],
];
async function renderSettings(panel) {
  const { settings } = await api.get('/api/ai-media-buyer/settings');
  panel.innerHTML = `
    <div class="card">
      <div class="section-title" style="margin-top:0;">إعدادات AI Media Buyer</div>
      <div class="faint" style="font-size:12px; margin-bottom:14px;">وضع "الموافقة" هو الافتراضي — مفيش تنفيذ على Meta من غير موافقتك. كل خيارات الأوتوبايلوت الخطيرة مقفولة افتراضيًا.</div>
      <div class="amb-field-grid">
        ${SETTING_FIELDS.map(([k, label, type, opts]) => {
          const v = settings[k];
          if (type === 'bool') return `<div class="field"><label style="display:flex; align-items:center; gap:8px; cursor:pointer;"><input type="checkbox" data-s="${k}" ${v ? 'checked' : ''} /> ${E(label)}</label></div>`;
          if (type === 'select') return `<div class="field"><label>${E(label)}</label><select data-s="${k}">${opts.map((o) => `<option value="${o}" ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
          return `<div class="field"><label>${E(label)}</label><input type="${type}" data-s="${k}" value="${v ?? ''}" step="any" /></div>`;
        }).join('')}
      </div>
      <div class="toolbar" style="margin-top:16px;">
        ${state.isAdmin ? '<button class="amb-btn primary" id="ambSaveSettings">حفظ الإعدادات</button>' : '<span class="faint">الحفظ متاح للـ ADMIN فقط.</span>'}
      </div>
    </div>`;
  if ($('ambSaveSettings')) $('ambSaveSettings').onclick = async () => {
    const body = {};
    panel.querySelectorAll('[data-s]').forEach((el) => {
      if (el.type === 'checkbox') body[el.dataset.s] = el.checked;
      else if (el.type === 'number') body[el.dataset.s] = el.value === '' ? null : Number(el.value);
      else body[el.dataset.s] = el.value;
    });
    try { await api.put('/api/ai-media-buyer/settings', body); UI.toast('✅ اتحفظت الإعدادات'); route(); }
    catch (err) { UI.toast(err.message, 'error'); }
  };
}

// ===========================================================================
// ADVANCED CAMPAIGN SCHEDULING — per copied campaign. Configure WHEN a copied
// (PAUSED) campaign runs; the server-side scheduler activates/pauses it at the
// approved times with a live Meta revalidation. The browser is never in the
// execution loop.
// ===========================================================================
const SCHED_STATUS_AR = {
  PENDING_APPROVAL: ['بانتظار الموافقة', 'blue'],
  SCHEDULED: ['مجدولة', 'blue'],
  STARTING_SOON: ['تبدأ قريباً', 'yellow'],
  RUNNING: ['شغالة الآن', 'green'],
  ENDING_SOON: ['تنتهي قريباً', 'yellow'],
  ENDED: ['انتهت', 'gray'],
  PAUSED: ['تم إيقافها', 'gray'],
  CANCELLED: ['ألغيت الجدولة', 'gray'],
  FAILED: ['فشل التنفيذ', 'red'],
  NEEDS_INTERVENTION: ['تحتاج تدخل', 'red'],
};
const SCHED_MODE_AR = {
  RUN_NOW: 'تشغيل الآن',
  START_AT: 'تحديد تاريخ ووقت التشغيل',
  START_NO_END: 'تشغيل بدون وقت إيقاف',
  START_AND_END: 'تحديد تاريخ ووقت التشغيل والإيقاف',
};
const SCHED_TZ_OPTIONS = ['Africa/Cairo', 'UTC', 'Asia/Riyadh', 'Europe/Istanbul', 'Asia/Dubai'];

const schedState = { ticker: null, editing: {} }; // editing: { [cloneJobId]: true }

function schedHumanize(ms) {
  if (ms == null) return '';
  const past = ms < 0;
  let s = Math.abs(Math.round(ms / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [];
  if (d) parts.push(`${d} يوم`);
  if (h) parts.push(`${h} ساعة`);
  if (!d && m) parts.push(`${m} دقيقة`);
  if (!d && !h && !m) parts.push(`${s} ثانية`);
  const txt = parts.join(' و');
  return past ? `متأخر ${txt}` : txt;
}

function startSchedTicker() {
  if (schedState.ticker) return;
  schedState.ticker = setInterval(() => {
    const els = document.querySelectorAll('[data-cd]');
    if (!els.length) { clearInterval(schedState.ticker); schedState.ticker = null; return; }
    const now = Date.now();
    els.forEach((el) => {
      const t = new Date(el.dataset.cd).getTime();
      const mode = el.dataset.cdMode;
      const diff = t - now;
      if (mode === 'start') el.textContent = diff > 0 ? `تبدأ بعد: ${schedHumanize(diff)}` : `تبدأ الآن…`;
      else el.textContent = diff > 0 ? `متبقٍّ على الإيقاف: ${schedHumanize(diff)}` : `تنتهي الآن…`;
    });
  }, 1000);
}

function schedMetaStatusChip(s, job) {
  const st = s?.status || job?.status;
  if (s?.status === 'RUNNING') return '<span class="badge green">🟢 شغالة الآن</span>';
  if (['CLONED_PAUSED', 'ACTIVATION_FAILED'].includes(job?.status) || ['SCHEDULED', 'PENDING_APPROVAL', 'PAUSED', 'ENDED', 'NEEDS_INTERVENTION'].includes(s?.status)) return '<span class="badge gray">⏸ متوقفة (PAUSED)</span>';
  if (job?.status === 'ACTIVATED') return '<span class="badge green">🟢 مُفعّلة</span>';
  return `<span class="badge gray">${E(st || '—')}</span>`;
}

/** The 4-option editor for a copied campaign with no active schedule yet. */
function scheduleEditorHtml(job) {
  const today = new Date().toISOString().slice(0, 10);
  return `<div class="amb-sched-editor" data-sched-editor="${job.id}">
    <div class="section-title" style="margin-top:0;">جدولة التشغيل — ${E(job.sourceCampaignName || job.destinationCampaignId || '')}</div>
    <div class="faint" style="font-size:12px; margin-bottom:10px;">الحملة اتنسخت <b>متوقفة</b>. حدّد إمتى تشتغل. مفيش أي تفعيل قبل موافقتك.</div>
    <div class="amb-sched-modes">
      ${Object.entries(SCHED_MODE_AR).map(([v, label], i) => `
        <label class="amb-sched-mode"><input type="radio" name="schedmode-${job.id}" value="${v}" ${i === 1 ? 'checked' : ''}/> ${E(label)}</label>`).join('')}
    </div>
    <div class="amb-field-grid" style="margin-top:10px;">
      <div class="field" data-when="START_AT START_NO_END START_AND_END">
        <label>تاريخ التشغيل</label><input type="date" data-f="startDate" min="${today}" value="${today}" />
      </div>
      <div class="field" data-when="START_AT START_NO_END START_AND_END">
        <label>وقت التشغيل</label><input type="time" data-f="startTime" value="09:00" />
      </div>
      <div class="field" data-when="START_AND_END">
        <label>تاريخ الإيقاف</label><input type="date" data-f="endDate" min="${today}" value="${today}" />
      </div>
      <div class="field" data-when="START_AND_END">
        <label>وقت الإيقاف</label><input type="time" data-f="endTime" value="23:30" />
      </div>
      <div class="field">
        <label>التوقيت الزمني</label>
        <select data-f="timezone">${SCHED_TZ_OPTIONS.map((t) => `<option value="${t}" ${t === 'Africa/Cairo' ? 'selected' : ''}>${t === 'Africa/Cairo' ? 'القاهرة (Africa/Cairo)' : t}</option>`).join('')}</select>
      </div>
    </div>
    <div class="amb-wizard-nav" style="margin-top:12px;">
      <span></span>
      <button class="amb-btn primary" data-sched-review="${job.id}" ${state.isAdmin ? '' : 'disabled'}>${state.isAdmin ? 'مراجعة الجدولة' : 'الجدولة متاحة للـ ADMIN فقط'}</button>
    </div>
  </div>`;
}

/** The card for an existing schedule (any state) — review/approve, countdown, manual controls, history. */
function scheduleCardHtml(s, job) {
  const [t, tone] = SCHED_STATUS_AR[s.displayStatus] || SCHED_STATUS_AR[s.status] || [s.status, 'gray'];
  const isPending = s.status === 'PENDING_APPROVAL';
  const isScheduled = s.status === 'SCHEDULED';
  const isRunning = s.status === 'RUNNING';
  const isDone = ['ENDED', 'PAUSED', 'CANCELLED', 'FAILED'].includes(s.status);
  const canEdit = ['PENDING_APPROVAL', 'SCHEDULED', 'NEEDS_INTERVENTION'].includes(s.status);
  const cd = isScheduled && s.startAt
    ? `<div class="amb-sched-cd" data-cd="${E(s.startAt)}" data-cd-mode="start">تبدأ بعد: ${E(schedHumanize(s.startsInMs))}</div>`
    : isRunning && s.endAt
      ? `<div class="amb-sched-cd" data-cd="${E(s.endAt)}" data-cd-mode="end">متبقٍّ على الإيقاف: ${E(schedHumanize(s.endsInMs))}</div>`
      : isRunning && !s.endAt
        ? `<div class="amb-sched-cd">شغالة — بدون إيقاف تلقائي</div>`
        : '';
  return `<div class="amb-sched-card" data-sched-card="${s.id}">
    <div class="amb-sched-card-h">
      <div>
        <div style="font-weight:800;">${E(s.campaignName || s.destinationCampaignId || '')}</div>
        <div class="faint" style="font-size:12px;">${E(s.sourceAccountName || '')} → ${E(s.destinationAccountName || s.destinationAccountId)}</div>
      </div>
      ${badge(t, tone)}
    </div>
    <div class="amb-sched-grid">
      <div><span class="rl">حالة Meta</span><span class="rv">${schedMetaStatusChip(s, job)}</span></div>
      <div><span class="rl">النوع</span><span class="rv">${E(SCHED_MODE_AR[s.mode] || s.mode)}</span></div>
      <div><span class="rl">سيتم تشغيل الحملة</span><span class="rv">${E(s.startLocalText || '—')}</span></div>
      <div><span class="rl">سيتم إيقاف الحملة</span><span class="rv">${s.endLocalText ? E(s.endLocalText) : 'بدون إيقاف تلقائي'}</span></div>
      <div><span class="rl">التوقيت</span><span class="rv">${E(s.timezone)}</span></div>
      <div><span class="rl">مدة التشغيل</span><span class="rv">${s.durationText ? E(s.durationText) : '—'}</span></div>
      ${s.approved ? `<div><span class="rl">الموافقة</span><span class="rv" style="color:var(--amb-green);font-weight:700;">✅ تمت الموافقة${s.approvedByName ? ` · ${E(s.approvedByName)}` : ''}</span></div>` : `<div><span class="rl">الموافقة</span><span class="rv" style="color:var(--amb-amber);font-weight:700;">⏳ بانتظار موافقتك</span></div>`}
      ${s.actualStartText ? `<div><span class="rl">بدأت فعليًا</span><span class="rv">${E(s.actualStartText)}</span></div>` : ''}
      ${s.actualEndText ? `<div><span class="rl">توقفت فعليًا</span><span class="rv">${E(s.actualEndText)}</span></div>` : ''}
    </div>
    ${cd ? `<div style="margin-top:8px;">${cd}</div>` : ''}
    ${s.interventionReason ? `<div class="amb-batchnote" style="margin-top:8px;"><span>⚠️ ${E(s.interventionReason)}</span></div>` : ''}
    ${s.lastError ? `<div style="color:var(--amb-red);font-size:12px;margin-top:6px;">${E(s.lastError)}</div>` : ''}
    <div class="toolbar" style="margin-top:12px; flex-wrap:wrap; gap:8px;">
      ${isPending && state.isAdmin ? `<button class="amb-btn primary" data-sa="approve" data-id="${s.id}">موافقة على الجدولة</button>` : ''}
      ${canEdit && state.isAdmin ? `<button class="amb-btn ghost" data-sa="edit" data-id="${s.id}">تعديل الجدولة</button>` : ''}
      ${!isRunning && !isDone && state.isAdmin ? `<button class="amb-btn" data-sa="runnow" data-id="${s.id}">تشغيل الآن</button>` : ''}
      ${isRunning && state.isAdmin ? `<button class="amb-btn danger" data-sa="pausenow" data-id="${s.id}">إيقاف الآن</button>` : ''}
      ${!isRunning && !isDone && state.isAdmin ? `<button class="amb-btn danger ghost" data-sa="cancel" data-id="${s.id}">إلغاء الجدولة</button>` : ''}
      ${s.edits && s.edits.length ? `<button class="amb-btn ghost" data-sa="history" data-id="${s.id}">السجل (${s.edits.length})</button>` : ''}
    </div>
    <div class="amb-sched-history" data-sched-history="${s.id}" hidden>
      ${(s.edits || []).map((e) => `<div class="faint" style="font-size:11.5px;">${fmtDT(e.at)} — ${e.material ? 'تعديل جوهري' : 'تعديل'}: ${E(JSON.stringify(e.to))}</div>`).join('')}
    </div>
  </div>`;
}

function wireScheduleEditor(mount, job, onDone) {
  const ed = mount.querySelector(`[data-sched-editor="${job.id}"]`);
  if (!ed) return;
  const applyMode = () => {
    const mode = ed.querySelector(`input[name="schedmode-${job.id}"]:checked`)?.value || 'START_AT';
    ed.querySelectorAll('[data-when]').forEach((f) => { f.style.display = f.dataset.when.split(' ').includes(mode) ? '' : 'none'; });
  };
  ed.querySelectorAll(`input[name="schedmode-${job.id}"]`).forEach((r) => { r.onchange = applyMode; });
  applyMode();
  const btn = ed.querySelector(`[data-sched-review="${job.id}"]`);
  if (btn) btn.onclick = async () => {
    const mode = ed.querySelector(`input[name="schedmode-${job.id}"]:checked`)?.value;
    const g = (f) => ed.querySelector(`[data-f="${f}"]`)?.value || '';
    const payload = { cloneJobId: job.id, mode, timezone: g('timezone') };
    if (mode !== 'RUN_NOW') { payload.startDate = g('startDate'); payload.startTime = g('startTime'); }
    if (mode === 'START_AND_END') { payload.endDate = g('endDate'); payload.endTime = g('endTime'); }
    btn.disabled = true; btn.textContent = '… بيجهّز المراجعة';
    try {
      await api.post('/api/ai-media-buyer/schedules', payload);
      schedState.editing[job.id] = false;
      UI.toast('📋 جاهزة للمراجعة — راجع وادّي موافقتك');
      onDone();
    } catch (e) { UI.toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'مراجعة الجدولة'; }
  };
}

function wireScheduleCard(mount, s, onDone) {
  const card = mount.querySelector(`[data-sched-card="${s.id}"]`);
  if (!card) return;
  card.querySelectorAll('[data-sa]').forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.sa;
      const id = btn.dataset.id;
      if (act === 'history') { const h = card.querySelector(`[data-sched-history="${id}"]`); if (h) h.hidden = !h.hidden; return; }
      if (act === 'edit') {
        schedState.editing[s.cloneJobId] = true;
        // The editor only lives in the clone RESULT view — jump there if this
        // card is on the dashboard (hashchange → route() re-renders it).
        if (mount.id === 'ambCloneSchedules') { onDone(); return; }
        cloneState.batchId = s.batchId; cloneState.step = 6;
        location.hash = 'clone';
        return;
      }
      let ok = true; let ep = '';
      if (act === 'approve') { ep = `/approve`; ok = await UI.confirmModal({ title: 'موافقة على الجدولة', message: `بموافقتك، السيرفر هيفعّل الحملة "${E(s.campaignName || '')}" في <b>${E(s.startLocalText || '')}</b>${s.endLocalText ? ` ويوقفها في <b>${E(s.endLocalText)}</b>` : ' ويسيبها شغالة لحد ما توقفها يدويًا'}. التفعيل والإيقاف مصرّح بيهم من دلوقتي، والسيرفر بيعيد التحقق من حالة Meta وقت التنفيذ. متابعة؟`, confirmLabel: 'موافقة على الجدولة', danger: true }); }
      else if (act === 'runnow') { ep = `/run-now`; ok = await UI.confirmModal({ title: 'تشغيل الآن', message: `هيتم تفعيل الحملة "${E(s.campaignName || '')}" فورًا بعد إعادة التحقق من حالة Meta. متابعة؟`, confirmLabel: 'تشغيل الآن', danger: true }); }
      else if (act === 'pausenow') { ep = `/pause-now`; ok = await UI.confirmModal({ title: 'إيقاف الآن', message: `هيتم إيقاف الحملة "${E(s.campaignName || '')}" فورًا. متابعة؟`, confirmLabel: 'إيقاف الآن', danger: true }); }
      else if (act === 'cancel') { ep = `/cancel`; ok = await UI.confirmModal({ title: 'إلغاء الجدولة', message: 'الحملة هتفضل متوقفة (PAUSED). متابعة؟', confirmLabel: 'إلغاء الجدولة', danger: true }); }
      if (!ok) return;
      btn.disabled = true;
      try {
        await api.post(`/api/ai-media-buyer/schedules/${id}${ep}`, {});
        UI.toast('✅ تم');
        onDone();
      } catch (e) { UI.toast(e.message, 'error'); btn.disabled = false; }
    };
  });
}

/** Schedule area inside the clone RESULT view — one block per copied campaign. */
async function renderCloneSchedules(mount, batch) {
  const eligible = (batch.jobs || []).filter((jb) => ['CLONED_PAUSED', 'ACTIVATED', 'ACTIVATION_FAILED'].includes(jb.status));
  if (!eligible.length) { mount.innerHTML = ''; return; }
  let schedules = [];
  try { schedules = await api.get(`/api/ai-media-buyer/schedules?batchId=${encodeURIComponent(batch.batchId)}`); } catch { /* ignore */ }
  const byJob = {};
  for (const s of schedules) {
    if (!byJob[s.cloneJobId] || s.id > byJob[s.cloneJobId].id) byJob[s.cloneJobId] = s;
  }
  mount.innerHTML = `
    <div class="section-title">جدولة الحملات المنسوخة</div>
    <div class="amb-sched-list">
      ${eligible.map((jb) => {
        const s = byJob[jb.id];
        const active = s && !['CANCELLED', 'ENDED'].includes(s.status);
        if (active && !schedState.editing[jb.id]) return `<div class="amb-sched-slot" data-slot="${jb.id}">${scheduleCardHtml(s, jb)}</div>`;
        return `<div class="amb-sched-slot" data-slot="${jb.id}">${scheduleEditorHtml(jb)}${s && ['CANCELLED', 'ENDED'].includes(s.status) ? `<div class="faint" style="font-size:11.5px;margin-top:6px;">آخر جدولة: ${E((SCHED_STATUS_AR[s.status] || [s.status])[0])} — ${E(s.startLocalText || '')}</div>` : ''}</div>`;
      }).join('')}
    </div>`;
  const refresh = () => renderCloneSchedules(mount, batch);
  eligible.forEach((jb) => {
    const s = byJob[jb.id];
    const active = s && !['CANCELLED', 'ENDED'].includes(s.status);
    if (active && !schedState.editing[jb.id]) wireScheduleCard(mount, s, refresh);
    else wireScheduleEditor(mount, jb, refresh);
  });
  startSchedTicker();
}

/** Dashboard section: "الحملات المنقولة والمجدولة". */
async function renderHomeSchedules(mount) {
  let schedules = [];
  try { schedules = await api.get('/api/ai-media-buyer/schedules?limit=100'); } catch { mount.innerHTML = ''; return; }
  if (!schedules.length) { mount.innerHTML = ''; return; }
  const order = { NEEDS_INTERVENTION: 0, FAILED: 1, PENDING_APPROVAL: 2, RUNNING: 3, SCHEDULED: 4, ENDED: 6, PAUSED: 6, CANCELLED: 7 };
  const active = schedules.filter((s) => !['ENDED', 'PAUSED', 'CANCELLED'].includes(s.status)).sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5) || new Date(a.startAt) - new Date(b.startAt));
  const done = schedules.filter((s) => ['ENDED', 'PAUSED', 'CANCELLED'].includes(s.status)).slice(0, 8);
  const pending = active.filter((s) => s.status === 'PENDING_APPROVAL');

  mount.innerHTML = `
    <div class="amb-panel" style="margin-top:18px;">
      <div class="amb-section-h"><div class="t">${ic('clock', 'ic')} الحملات المنقولة والمجدولة</div>
        <span class="amb-sort">${active.length} نشطة${pending.length ? ` · ${pending.length} بانتظار موافقتك` : ''}</span></div>
      ${pending.length ? `
        <div class="amb-sched-pending">
          <div class="section-title" style="margin-top:4px;">بانتظار موافقتك</div>
          ${pending.map((s) => scheduleCardHtml(s, null)).join('')}
        </div>` : ''}
      <div class="amb-sched-list" style="margin-top:10px;">
        ${active.filter((s) => s.status !== 'PENDING_APPROVAL').map((s) => scheduleCardHtml(s, null)).join('') || '<div class="faint" style="font-size:12px;">مفيش حملات مجدولة نشطة.</div>'}
      </div>
      ${done.length ? `<details style="margin-top:10px;"><summary class="faint" style="font-size:12px;cursor:pointer;">جدولات منتهية (${done.length})</summary>
        <div class="amb-sched-list" style="margin-top:8px;">${done.map((s) => scheduleCardHtml(s, null)).join('')}</div></details>` : ''}
    </div>`;
  const refresh = () => renderHomeSchedules(mount);
  [...pending, ...active, ...done].forEach((s) => wireScheduleCard(mount, s, refresh));
  startSchedTicker();
}

init();
