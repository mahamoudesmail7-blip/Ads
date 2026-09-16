// AI Product Marketing Center — "مركز التسويق الذكي للمنتج". Page controller
// for product-marketing-center.html. Isolated module: talks only to
// /api/product-marketing/* via the shared api-client, same as every other
// AMB/Creative Factory page. No Meta write anywhere on this page — every
// action here is read/analyze/decide-a-recommendation only.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const E = (s) => UI.escapeHtml(String(s ?? ''));
const $ = (id) => document.getElementById(id);
const fmtEGP = (n) => UI.fmtCurrency(n);
const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
const fmtPct1 = (n) => (n === null || n === undefined ? '—' : `${Math.round(n * 1000) / 10}%`);

const WINDOWS = [
  { k: 'today', label: 'اليوم' }, { k: 'yesterday', label: 'أمس' },
  { k: 'last3', label: 'آخر 3 أيام' }, { k: 'last7', label: 'آخر 7 أيام' },
  { k: 'last14', label: 'آخر 14 يوم' }, { k: 'last30', label: 'آخر 30 يوم' }, { k: 'last90', label: 'آخر 90 يوم' },
];
const TABS = [
  { k: 'overview', label: 'نظرة عامة', desc: 'ملخص شامل', icon: 'home', color: 'blue' },
  { k: 'audience', label: 'الجمهور والأسواق', desc: 'مين بيشتري المنتج', icon: 'users', color: 'green' },
  { k: 'angles', label: 'زوايا البيع', desc: 'كيف نبيعه', icon: 'target', color: 'amber' },
  { k: 'creative', label: 'الكرياتيف', desc: 'أفكار تصاميم وفيديوهات', icon: 'image', color: 'purple' },
  { k: 'hooks', label: 'Hooks والبوستات', desc: 'رسائل تجذب الانتباه', icon: 'zap', color: 'pink' },
  { k: 'locations', label: 'الأسواق والمناطق', desc: 'توزيع الطلبات', icon: 'mappin', color: 'cyan' },
  { k: 'competitors', label: 'المنافسين', desc: 'تحليل السوق', icon: 'barchart', color: 'green' },
  { k: 'tests', label: 'الاختبارات والنتائج', desc: 'ما الذي يعمل أفضل', icon: 'flask', color: 'blue' },
  { k: 'strategist', label: 'المستشار الذكي', desc: 'توصيات وخطوة قادمة', icon: 'lightbulb', color: 'yellow' },
];

// ---------------------------------------------------------------------------
// Local, page-scoped icon set (Phase 1 redesign) — same visual family as
// ui-common.js's inline Feather/Lucide-style icons (24x24, currentColor
// stroke) but kept local to this file since these icons are PMC-specific and
// ui-common.js's ICON_PATHS/navIcon are private to the site-wide nav. Zero
// external dependency, matches this project's zero-icon-font rule.
// ---------------------------------------------------------------------------
const PMC_ICON_PATHS = {
  home: '<path d="M3 9.5 12 3l9 6.5"/><path d="M5 10v10a1 1 0 0 0 1 1h3v-6h6v6h3a1 1 0 0 0 1-1V10"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.2"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="9" r="1.7"/><path d="M21 15l-5-5-9 9"/>',
  zap: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
  mappin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  barchart: '<path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6" rx="0.5"/><rect x="12" y="8" width="3" height="10" rx="0.5"/><rect x="17" y="5" width="3" height="13" rx="0.5"/>',
  flask: '<path d="M9 2v6.2L4.3 17a2 2 0 0 0 1.8 2.9h11.8a2 2 0 0 0 1.8-2.9L15 8.2V2"/><path d="M8.5 2h7"/><path d="M7.2 14.5h9.6"/>',
  lightbulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a6.5 6.5 0 0 0-4.2 11.5c.9.75 1.2 1.4 1.2 2.5h6c0-1.1.3-1.75 1.2-2.5A6.5 6.5 0 0 0 12 2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  upload: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  tag: '<path d="M20.6 12.6 12 21.2 2.8 12 2.8 2.8 12 2.8z" /><circle cx="7.5" cy="7.5" r="1.4" fill="currentColor" stroke="none"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="10.5" r="1.6"/><path d="M21 16l-5.5-5.5-4 4-2-2L3 18"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  store: '<path d="M3 9h18l-1.5-5H4.5L3 9z"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M9 20v-5h6v5"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  dots: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  cart: '<circle cx="9" cy="21" r="1.4"/><circle cx="18" cy="21" r="1.4"/><path d="M2.5 3h2l2.4 12.4a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 8H6"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M9 9.3c.3-1 1.4-1.6 3-1.6 1.8 0 3 .8 3 2s-1.2 1.6-3 1.9c-1.8.3-3 .8-3 2s1.4 2 3.2 1.9c1.4-.1 2.4-.7 2.8-1.6"/><path d="M12 6v1.6M12 16.4V18"/>',
  percent: '<line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  trend: '<path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/>',
  megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M14 8a4 4 0 0 1 0 8"/><path d="M17 5a8 8 0 0 1 0 14"/>',
};
function pmcIcon(name, cls = '') {
  return `<svg class="pmc-ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PMC_ICON_PATHS[name] || ''}</svg>`;
}

/** Small local relative-time formatter (Arabic) — no such helper exists yet in ui-common.js. Used ONLY for real timestamps (snapshot.computedAt); never called with a fabricated date. */
function timeAgoAr(dateInput) {
  if (!dateInput) return null;
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return 'الآن';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `منذ ${diffMin} دقيقة`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `منذ ${diffHr} ساعة`;
  const diffDay = Math.floor(diffHr / 24);
  return `منذ ${diffDay} يوم`;
}

const HEALTH_BAND_LABEL_AR = { HEALTHY: 'ممتاز', GOOD: 'جيد', NEEDS_ATTENTION: 'يحتاج انتباه', AT_RISK: 'في خطر', CRITICAL: 'حرج', INSUFFICIENT_DATA: 'بيانات غير كافية' };
const HEALTH_BAND_COLOR = { HEALTHY: 'green', GOOD: 'green', NEEDS_ATTENTION: 'yellow', AT_RISK: 'yellow', CRITICAL: 'red', INSUFFICIENT_DATA: 'gray' };
function healthBandPill(band) {
  if (!band) return '';
  return `<span class="badge ${HEALTH_BAND_COLOR[band] || 'gray'}">${E(HEALTH_BAND_LABEL_AR[band] || band)}</span>`;
}
const PRIORITY_LABEL_AR = { P0: 'حرج — الآن', P1: 'فرصة فورية', P2: 'تحسين/اختبار', P3: 'بيانات ناقصة' };
const PRIORITY_COLOR = { P0: 'red', P1: 'green', P2: 'yellow', P3: 'gray' };
function priorityPill(p) { return p ? `<span class="badge ${PRIORITY_COLOR[p] || 'gray'}">${E(PRIORITY_LABEL_AR[p] || p)}</span>` : ''; }
const BAND_LABEL_AR = { WINNER: '🏆 فائز', PROMISING: '📈 واعد', AVERAGE: '➖ متوسط', WEAK: '🔴 ضعيف', UNTESTED: '⚪ غير مُختبر' };
const BAND_COLOR = { WINNER: 'green', PROMISING: 'green', AVERAGE: 'yellow', WEAK: 'red', UNTESTED: 'gray' };
function bandPill(b) { return b ? `<span class="badge ${BAND_COLOR[b] || 'gray'}">${E(BAND_LABEL_AR[b] || b)}</span>` : ''; }
const MARKET_BAND_LABEL_AR = { SCALE_MARKET: '🏆 وسّع', KEEP_TESTING: '🟢 استمر بالاختبار', MONITOR: '🟡 راقب', REDUCE_PRIORITY: '🔴 قلّل الأولوية', INSUFFICIENT_DATA: '⚪ بيانات غير كافية' };
const MARKET_BAND_COLOR = { SCALE_MARKET: 'green', KEEP_TESTING: 'green', MONITOR: 'yellow', REDUCE_PRIORITY: 'red', INSUFFICIENT_DATA: 'gray' };
function marketBandPill(b) { return b ? `<span class="badge ${MARKET_BAND_COLOR[b] || 'gray'}">${E(MARKET_BAND_LABEL_AR[b] || b)}</span>` : ''; }
const STATUS_LABEL_AR = { DATA_BACKED: '📊 مبني على بيانات', AI_HYPOTHESIS: '🤖 فرضية ذكاء اصطناعي', TEST_REQUIRED: '🧪 يحتاج اختبار', INSUFFICIENT_DATA: '⚪ بيانات غير كافية' };
const STATUS_COLOR = { DATA_BACKED: 'green', AI_HYPOTHESIS: 'yellow', TEST_REQUIRED: 'yellow', INSUFFICIENT_DATA: 'gray' };
function statusPill(s) { return s ? `<span class="badge ${STATUS_COLOR[s] || 'gray'}">${E(STATUS_LABEL_AR[s] || s)}</span>` : ''; }

const state = {
  me: null,
  // Multi-store — the store must be chosen BEFORE any product/catalog data
  // loads, and switching it clears every downstream product/analysis state
  // (see selectStore()) so Store A's data can never linger on screen after
  // switching to Store B.
  stores: null, storesLoading: true, storesError: null,
  storeId: null, storeSelectorOpen: false,
  source: 'EASY_ORDERS', // EASY_ORDERS | MANUAL_UPLOAD (source-picker only, before lock)
  eoQuery: '', eoFilter: 'all', // all | newest | recent
  eoAll: null, eoLoading: false, eoError: null, // the ONE real fetch, cached client-side
  eoRecentIds: null, // distinct easyOrdersProductId from this user's own recent profiles (real usage history)
  eoVisible: 20, // progressive "تحميل المزيد" window over the real list — never a fake page count
  eoSelected: null, // the clicked-but-not-yet-locked EO product (confirm bar)
  uploadImages: [], // [{base64, mediaType, dataUrl}]
  profile: null, // locked profile
  windowName: 'last7',
  snapshot: null, snapshotLoading: false,
  tab: 'overview',
  memory: null, actions: null, competitors: null,
  hookResult: null, postResult: null, ideaResult: null, testPackResult: null,
  genAngle: '', genTone: 'مباشر', genCategory: '',
  // Phase 1 — Testing Lab (own tab state; tests come straight off state.snapshot elsewhere)
  labTests: null, labTestsLoading: false, labNewTestOpen: false, labBusyId: null,
  catalogSyncMissing: null, // count of Easy Orders catalog products not yet in the internal Product table (nav badge -> easyorders-catalog-sync.html); null until loaded, never shown to a non-ADMIN (that page is ADMIN-only)
  // Product <-> Meta Campaign mapping (§ربط إعلانات Meta) — independent of
  // the AI snapshot; loaded/refreshed on its own, never auto-confirmed.
  metaMapping: null, metaMappingLoading: false, metaMappingSelected: {}, metaMappingBusy: false,
};

async function init() {
  try { state.me = await api.get('/api/auth/me'); } catch { /* redirected by api-client on 401 */ }
  $('ambDrawerOverlay').addEventListener('click', (e) => { if (e.target.id === 'ambDrawerOverlay') $('ambDrawerOverlay').classList.remove('open'); });
  renderNav();
  UI.mountAmbMobileNav('مركز التسويق الذكي');
  render();
  await loadStores();
  loadCatalogSyncBadge(); // fire-and-forget — a slow/failed Easy Orders catalog fetch must never block the rest of the page
}

/** The nav badge's live count — reuses the SAME read-only audit endpoint the Catalog Sync page itself calls, so the two never disagree. Silently shows nothing on any error (wrong role, store not configured, etc.) — this is a convenience nudge, not a page a MANAGER-level user could act on anyway (that page requires ADMIN). */
async function loadCatalogSyncBadge() {
  try {
    const r = await api.get('/api/product-marketing/easy-orders/catalog-audit', state.storeId ? { store_id: state.storeId } : undefined);
    state.catalogSyncMissing = r.ok ? (r.summary?.MISSING ?? null) : null;
  } catch {
    state.catalogSyncMissing = null; // e.g. 403 for a non-ADMIN — badge just stays hidden
  }
  renderNav();
}

async function loadStores() {
  state.storesLoading = true; state.storesError = null;
  renderStoreSelector();
  try {
    const r = await api.get('/api/product-marketing/stores');
    state.stores = r.stores || [];
    if (!state.storeId && state.stores.length) state.storeId = state.stores[0].id;
  } catch (e) {
    state.storesError = e.message || 'تعذر تحميل المتاجر المتاحة.';
    state.stores = null;
  }
  state.storesLoading = false;
  render();
}

/** §6 — switching the store must clear EVERYTHING downstream: selected product, lock, Meta mapping, COD, audience, locations, angles, creative, hooks/posts, recommendations. Store A's data must never linger after switching to Store B. */
function selectStore(storeId) {
  if (storeId === state.storeId) { state.storeSelectorOpen = false; renderStoreSelector(); return; }
  state.storeId = storeId;
  state.storeSelectorOpen = false;
  // Product source / catalog state (must reload for the new store):
  state.eoAll = null; state.eoLoading = false; state.eoError = null;
  state.eoQuery = ''; state.eoFilter = 'all'; state.eoVisible = 20; state.eoRecentIds = null;
  state.eoSelected = null;
  // Locked product + every downstream analysis result:
  state.profile = null;
  resetWorkspace();
  render();
  state.catalogSyncMissing = null; renderNav();
  loadCatalogSyncBadge();
}

function renderStoreSelector() {
  const mount = $('pmcStoreSelector');
  if (!mount) return;
  if (state.storesLoading) { mount.innerHTML = ''; return; } // no flash of a selector that might turn out to be single-store
  if (state.storesError || !state.stores || !state.stores.length) {
    mount.innerHTML = `<div class="pmc-store-box error"><div class="pmc-store-label">المتجر الحالي</div><div class="pmc-store-current">⚠️ ${E(state.storesError || 'المتجر غير مربوط بـ Easy Orders')}</div></div>`;
    return;
  }
  // §1 — the selector itself (a store name + dropdown to switch) only makes
  // sense — and should only appear — when there's actually more than one
  // store to choose between. A single-store deployment (today's real
  // production) sees NO new UI at all, exactly as before this feature.
  if (state.stores.length <= 1) { mount.innerHTML = ''; return; }
  const current = state.stores.find((s) => s.id === state.storeId) || state.stores[0];
  mount.innerHTML = `
    <div class="pmc-store-box">
      <div class="pmc-store-label">المتجر الحالي</div>
      <button class="pmc-store-current" id="pmcStoreToggle">${E(current?.name || '—')} <span class="car">▾</span></button>
      ${state.storeSelectorOpen ? `<div class="pmc-store-dropdown">
        ${state.stores.map((s) => `<button class="pmc-store-opt ${s.id === state.storeId ? 'active' : ''}" data-store="${E(s.id)}" ${s.enabled === false ? 'disabled' : ''}>${E(s.name)}${s.id === state.storeId ? ' ✓' : ''}</button>`).join('')}
      </div>` : ''}
    </div>`;
  $('pmcStoreToggle').onclick = () => { state.storeSelectorOpen = !state.storeSelectorOpen; renderStoreSelector(); };
  mount.querySelectorAll('[data-store]').forEach((b) => { b.onclick = () => selectStore(b.dataset.store); });
}

// Phase 1 redesign — the 9 PMC sections become the primary sidebar nav
// (previously only a horizontal tab strip inside the workspace). The
// pre-existing cross-page family links (Catalog Sync/AI Media Buyer/
// Creative Factory/Product Research/user info/"الرجوع للنظام") are NOT
// removed — they move into the sidebar footer, exactly as real as before.
// Nav items are inert until a product is locked (state.profile), matching
// the existing "no analysis without a locked product" rule — never a fake
// active section shown before real data exists.
function renderNav() {
  const u = state.me || {};
  const initials = (u.name || 'U').trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
  const locked = !!state.profile;
  $('ambNav').innerHTML = `
    <div class="amb-nav-brand pmc-brand">
      <div class="logo pmc-brand-logo">${pmcIcon('lightbulb')}</div>
      <div><div class="t">مركز التسويق الذكي</div><div class="s">للمنتجات</div></div>
    </div>
    <div class="amb-nav-list pmc-section-nav">
      ${TABS.map((t) => `<button class="amb-nav-item pmc-nav-item ${locked && state.tab === t.k ? 'active' : ''} ${locked ? '' : 'disabled'}" data-pmc-tab="${t.k}" ${locked ? '' : 'disabled'}>
        <span class="pmc-nav-ic clr-${t.color}">${pmcIcon(t.icon)}</span><span>${E(t.label)}</span>
      </button>`).join('')}
    </div>
    <div class="amb-nav-foot pmc-nav-foot">
      <div class="pmc-nav-links">
        <a class="amb-nav-link" href="easyorders-catalog-sync.html">${pmcIcon('refresh')} مزامنة الكتالوج${state.catalogSyncMissing ? `<span class="amb-nav-count" title="منتجات Easy Orders غير موجودة في جدول المنتجات الداخلي">${E(state.catalogSyncMissing)}</span>` : ''}</a>
        <a class="amb-nav-link" href="ai-media-buyer.html">${pmcIcon('barchart')} AI Media Buyer</a>
        <a class="amb-nav-link" href="creative-factory.html">${pmcIcon('image')} مصنع الإعلانات</a>
        <a class="amb-nav-link" href="product-research.html">${pmcIcon('search')} البحث عن المنتجات</a>
        <a class="amb-nav-link" href="ai-intelligence.html">${pmcIcon('lightbulb')} AI Intelligence</a>
      </div>
      <div class="amb-nav-user">
        <div class="av">${E(initials)}</div>
        <div><div class="nm">${E(u.name || '—')}</div><div class="rl">${E({ ADMIN: 'مدير النظام', MANAGER: 'مدير', EMPLOYEE: 'موظف' }[u.role] || u.role || '')}</div></div>
      </div>
      <a class="amb-nav-link" href="index.html">↩︎ الرجوع للنظام</a>
    </div>`;
  $('ambNav').querySelectorAll('[data-pmc-tab]').forEach((b) => {
    b.onclick = () => { if (!state.profile) return; selectPmcTab(b.dataset.pmcTab); };
  });
}

/** Switches state.tab and updates ONLY the active-state classes + the tab body — never rebuilds the sidebar/hero/nav-cards on a tab switch (perf). Shared by the sidebar nav items AND the large nav cards below the hero. */
function selectPmcTab(tabKey) {
  state.tab = tabKey;
  updateActiveNav();
  renderTabBody();
}
function updateActiveNav() {
  document.querySelectorAll('[data-pmc-tab]').forEach((el) => el.classList.toggle('active', el.dataset.pmcTab === state.tab));
}

function render() {
  const view = $('pmcView');
  view.innerHTML = `
    <div class="pmc-header">
      <div>
        <h1>مركز التسويق الذكي للمنتج</h1>
        <div class="sub">نفهم منتجك، نكتشف له أفضل جمهور وزوايا بيع، ونحوّل البيانات إلى أفكار وكرياتيفات قابلة للاختبار.</div>
      </div>
      <div id="pmcStoreSelector"></div>
      <div class="pmc-ai-chip">🤖 ذكاء اصطناعي مخصص لمنتجك</div>
    </div>
    <div id="pmcBody"></div>`;
  renderStoreSelector();
  if (state.storesLoading) { $('pmcBody').innerHTML = '<div class="amb-loading">جارِ تحميل المتاجر…</div>'; return; }
  if (!state.stores || !state.stores.length) {
    $('pmcBody').innerHTML = `<div class="amb-panel"><div class="pmc-eo-error"><div style="font-size:22px;">⚠️</div><div style="font-weight:700;margin:6px 0;">المتجر غير مربوط بـ Easy Orders</div><div class="detail">${E(state.storesError || 'لازم تضبط EASYORDERS_API_KEY أو EASYORDERS_STORES_JSON في متغيرات البيئة أولًا.')}</div></div></div>`;
    return;
  }
  if (!state.profile) renderSourcePicker($('pmcBody'));
  else renderWorkspace($('pmcBody'));
}

// ---------------------------------------------------------------------------
// §1 — Product source, lock, understanding
// ---------------------------------------------------------------------------
function renderSourcePicker(mount) {
  mount.innerHTML = `
    <div class="amb-panel">
      <div class="section-title" style="margin-top:0;">اختر مصدر المنتج</div>
      <div class="faint" style="font-size:12px;margin-bottom:14px;">قبل أي تحليل، لازم تحدد المنتج الحقيقي اللي هنشتغل عليه — من كتالوج Easy Orders أو برفع صورته. مفيش تحليل من غير منتج معتمد.</div>
      <div class="pmc-source-seg">
        <button class="${state.source === 'EASY_ORDERS' ? 'active' : ''}" data-src="EASY_ORDERS">🛒 Easy Orders</button>
        <button class="${state.source === 'MANUAL_UPLOAD' ? 'active' : ''}" data-src="MANUAL_UPLOAD">📷 رفع صورة</button>
      </div>
      <div id="pmcSourceBody"></div>
    </div>`;
  mount.querySelectorAll('[data-src]').forEach((c) => { c.onclick = () => { if (state.source === c.dataset.src) return; state.source = c.dataset.src; state.eoSelected = null; render(); }; });
  if (state.source === 'EASY_ORDERS') renderEasyOrdersPicker($('pmcSourceBody'));
  else renderUploadPicker($('pmcSourceBody'));
}

// ---------------------------------------------------------------------------
// Easy Orders catalog browser — loads the FULL real catalogue immediately
// (one call, cached client-side), then search/filter/paging all happen
// locally over that one real list. No placeholder products, ever.
// ---------------------------------------------------------------------------
async function renderEasyOrdersPicker(mount) {
  mount.innerHTML = `
    <div class="pmc-eo-toolbar">
      <input class="amb-input pmc-input" id="pmcEoSearch" type="search" placeholder="ابحث عن المنتج بالاسم..." value="${E(state.eoQuery)}" />
      <div class="pmc-eo-filters">
        <button class="amb-fbtn ${state.eoFilter === 'all' ? 'active' : ''}" data-eof="all">كل المنتجات</button>
        <button class="amb-fbtn ${state.eoFilter === 'newest' ? 'active' : ''}" data-eof="newest">الأحدث</button>
        <button class="amb-fbtn ${state.eoFilter === 'recent' ? 'active' : ''}" data-eof="recent">تم استخدامها مؤخرًا</button>
      </div>
    </div>
    <div id="pmcEoGrid"></div>
    <div id="pmcEoConfirmBar"></div>`;
  $('pmcEoSearch').oninput = (e) => { state.eoQuery = e.target.value; state.eoVisible = 20; paintEoGrid(); };
  mount.querySelectorAll('[data-eof]').forEach((b) => { b.onclick = async () => { state.eoFilter = b.dataset.eof; state.eoVisible = 20; if (state.eoFilter === 'recent' && !state.eoRecentIds) await loadRecentEoIds(); renderEasyOrdersPicker(mount); }; });

  if (!state.eoAll && !state.eoLoading) await loadEoCatalog();
  paintEoGrid();
}

async function loadEoCatalog() {
  state.eoLoading = true; state.eoError = null;
  paintEoGrid();
  try {
    const r = await api.get('/api/product-marketing/easy-orders/search', { q: '', store_id: state.storeId });
    // §1 — the backend now says explicitly whether this is a REAL catalogue
    // (possibly genuinely empty) or a failure; a failure must never be
    // shown as "لم يتم العثور على منتجات" — show the real technical reason.
    if (r.ok === false) {
      state.eoError = r.error || 'تعذر تحميل منتجات Easy Orders.';
      state.eoAll = null;
    } else {
      state.eoAll = r.products || [];
    }
  } catch (e) {
    state.eoError = e.message || 'تعذر الاتصال بـ Easy Orders.';
    state.eoAll = null;
  }
  state.eoLoading = false;
  paintEoGrid();
}
async function loadRecentEoIds() {
  try {
    const { profiles } = await api.get('/api/product-marketing/profiles');
    const ids = [];
    // §8 strict store isolation — "used recently" must only ever surface
    // THIS store's own product ids, never another store's.
    for (const p of profiles) if (p.storeId === state.storeId && p.easyOrdersProductId && !ids.includes(p.easyOrdersProductId)) ids.push(p.easyOrdersProductId);
    state.eoRecentIds = ids;
  } catch { state.eoRecentIds = []; }
}

function skeletonGridHtml(n = 10) {
  return `<div class="pmc-product-grid">${Array.from({ length: n }).map(() => `<div class="pmc-skel"><div class="thumb"></div><div class="body"><div class="ln"></div><div class="ln w60"></div></div></div>`).join('')}</div>`;
}

function paintEoGrid() {
  const grid = $('pmcEoGrid'); const bar = $('pmcEoConfirmBar');
  if (!grid) return;
  if (state.eoLoading) { grid.innerHTML = skeletonGridHtml(); if (bar) bar.innerHTML = ''; return; }
  if (state.eoError) {
    grid.innerHTML = `<div class="pmc-eo-error">
      <div style="font-size:22px;">⚠️</div>
      <div style="font-weight:700;margin:6px 0;">تعذّر تحميل منتجات Easy Orders</div>
      <div class="detail">${E(state.eoError)}</div>
      <button class="amb-btn sm primary" id="pmcEoRetry">إعادة المحاولة</button>
    </div>`;
    $('pmcEoRetry').onclick = loadEoCatalog;
    if (bar) bar.innerHTML = '';
    return;
  }
  const all = state.eoAll || [];
  if (!all.length) { grid.innerHTML = `<div class="pmc-eo-error"><div style="font-size:22px;">📦</div><div style="font-weight:700;margin:6px 0;">لم يتم العثور على منتجات في Easy Orders</div><button class="amb-btn sm primary" id="pmcEoRetry">إعادة المحاولة</button></div>`; $('pmcEoRetry').onclick = loadEoCatalog; if (bar) bar.innerHTML = ''; return; }

  const q = state.eoQuery.trim().toLowerCase();
  let list = q ? all.filter((p) => p.name.toLowerCase().includes(q)) : all.slice();
  if (state.eoFilter === 'newest') list = [...list].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  else if (state.eoFilter === 'recent') {
    const rec = state.eoRecentIds || [];
    list = rec.map((id) => list.find((p) => String(p.id) === String(id))).filter(Boolean);
  }

  if (!list.length) {
    const msg = state.eoFilter === 'recent' ? 'لسه ما استخدمتش أي منتج من Easy Orders في تحليل سابق.' : q ? 'مفيش منتجات مطابقة للبحث.' : 'مفيش منتجات.';
    grid.innerHTML = `<div class="pmc-empty">${E(msg)}</div>`;
    if (bar) bar.innerHTML = '';
    return;
  }

  const visible = list.slice(0, state.eoVisible);
  grid.innerHTML = `<div class="pmc-product-grid">${visible.map((p) => `
    <div class="pmc-pcard ${state.eoSelected?.id === p.id ? 'selected' : ''}" data-pick="${E(p.id)}">
      <div class="thumb">${p.thumb ? `<img src="${E(p.thumb)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'pmc-thumb-placeholder',textContent:'📦'}))" />` : `<div class="pmc-thumb-placeholder">📦</div>`}</div>
      <div class="body">
        <div class="n" title="${E(p.name)}">${E(p.name)}</div>
        <div class="price ${p.price ? '' : 'na'}">${p.price ? fmtEGP(p.price) : 'السعر غير متاح'}</div>
        <button class="pick-btn">${state.eoSelected?.id === p.id ? '✓ مُختار' : 'اختيار المنتج'}</button>
      </div>
    </div>`).join('')}</div>
    ${list.length > visible.length ? `<div style="text-align:center;margin-top:14px;"><button class="amb-btn" id="pmcEoLoadMore">تحميل المزيد (${fmtNum(list.length - visible.length)} أكتر)</button></div>` : ''}`;

  grid.querySelectorAll('[data-pick]').forEach((c) => { c.onclick = () => { state.eoSelected = list.find((p) => String(p.id) === c.dataset.pick); paintEoGrid(); }; });
  const more = $('pmcEoLoadMore'); if (more) more.onclick = () => { state.eoVisible += 20; paintEoGrid(); };

  if (bar) {
    bar.innerHTML = state.eoSelected ? `<div class="pmc-confirm-bar">
      <img src="${E(state.eoSelected.thumb || '')}" onerror="this.style.visibility='hidden'" />
      <div class="info"><div class="n">${E(state.eoSelected.name)}</div><div class="p">${state.eoSelected.price ? fmtEGP(state.eoSelected.price) : 'السعر غير متاح'} · Easy Orders</div></div>
      <button class="amb-btn sm ghost" id="pmcEoCancelPick">إلغاء</button>
      <button class="amb-btn primary" id="pmcEoConfirmPick">تأكيد وبدء التحليل</button>
    </div>` : '';
    if (state.eoSelected) {
      $('pmcEoCancelPick').onclick = () => { state.eoSelected = null; paintEoGrid(); };
      $('pmcEoConfirmPick').onclick = () => lockEasyOrders(state.eoSelected.id);
    }
  }
}

function renderUploadPicker(mount) {
  mount.innerHTML = `
    <div class="pmc-upload-zone" id="pmcDropZone">
      <div style="font-size:28px;">📷</div>
      <div style="font-weight:700;margin:6px 0;">اسحب الصور هنا أو دوس للاختيار</div>
      <div class="faint" style="font-size:12px;">حتى 5 صور — JPEG / PNG / WEBP، أقل من 5 ميجا لكل صورة</div>
      <input type="file" id="pmcFileInput" accept="image/jpeg,image/png,image/webp" multiple style="display:none;" />
    </div>
    <div class="pmc-upload-previews" id="pmcPreviews"></div>
    <div class="toolbar" style="margin-top:14px;">
      <button class="amb-btn primary" id="pmcAnalyzeUpload" ${state.uploadImages.length ? '' : 'disabled'}>تحليل الصور وتأكيد المنتج</button>
    </div>`;
  const paintPreviews = () => { $('pmcPreviews').innerHTML = state.uploadImages.map((im, i) => `<img src="${im.dataUrl}" title="صورة ${i + 1}" />`).join(''); $('pmcAnalyzeUpload').disabled = !state.uploadImages.length; };
  const zone = $('pmcDropZone'); const input = $('pmcFileInput');
  zone.onclick = () => input.click();
  input.onchange = async () => { await addFiles([...input.files]); paintPreviews(); };
  zone.ondragover = (e) => e.preventDefault();
  zone.ondrop = async (e) => { e.preventDefault(); await addFiles([...e.dataTransfer.files]); paintPreviews(); };
  $('pmcAnalyzeUpload').onclick = lockFromUpload;
  paintPreviews();
}

function readAsDataUrl(f) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(f); }); }
async function addFiles(files) {
  const remaining = 5 - state.uploadImages.length;
  if (remaining <= 0) { UI.toast('أقصى عدد صور 5', 'error'); return; }
  for (const f of files.slice(0, remaining)) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) { UI.toast('نوع الصورة لازم يكون JPEG أو PNG أو WEBP', 'error'); continue; }
    if (f.size > 5 * 1024 * 1024) { UI.toast('حجم الصورة لازم يكون أقل من 5 ميجا', 'error'); continue; }
    const dataUrl = await readAsDataUrl(f);
    state.uploadImages.push({ base64: dataUrl.split(',')[1], mediaType: f.type, dataUrl });
  }
}

async function lockEasyOrders(eoId) {
  const btn = $('pmcEoConfirmPick'); if (btn) { btn.disabled = true; btn.textContent = 'جارِ التأكيد…'; }
  try {
    state.profile = await api.post('/api/product-marketing/profiles/from-easy-orders', { eoProductId: eoId, storeId: state.storeId });
    state.eoSelected = null;
    resetWorkspace();
    render();
    renderNav();
  } catch (e) { UI.toast(e.message, 'error'); if (btn) { btn.disabled = false; btn.textContent = 'تأكيد وبدء التحليل'; } }
}
async function lockFromUpload() {
  try {
    const images = state.uploadImages.map((im) => ({ imageBase64: im.base64, imageMediaType: im.mediaType }));
    state.profile = await api.post('/api/product-marketing/profiles/from-images', { images });
    resetWorkspace();
    render();
    renderNav();
  } catch (e) { UI.toast(e.message, 'error'); }
}
function resetWorkspace() {
  state.tab = 'overview'; state.snapshot = null; state.memory = null; state.actions = null; state.competitors = null;
  state.hookResult = null; state.postResult = null; state.ideaResult = null; state.testPackResult = null;
  state.metaMapping = null; state.metaMappingLoading = false; state.metaMappingSelected = {}; state.metaMappingBusy = false;
  state.labTests = null; state.labTestsLoading = false; state.labNewTestOpen = false; state.labBusyId = null;
}

// ---------------------------------------------------------------------------
// Workspace: confirmed card + window selector + tabs
// ---------------------------------------------------------------------------
/** All real per-product descriptive facts, as compact pills — never invents a marketing bullet; only what confirmedTraits/potentialTraits actually contain. */
function traitPillsHtml(items, cls) {
  if (!items?.length) return '';
  return items.map((t) => `<span class="pmc-trait-pill ${cls}">${E(t.label)}${t.value ? `: ${E(t.value)}` : ''}</span>`).join('');
}
function findTrait(items, label) { return (items || []).find((t) => t.label === label)?.value || null; }

function productHeroHtml(p) {
  const category = findTrait(p.confirmedTraits, 'الفئة') || findTrait(p.potentialTraits, 'الفئة');
  const sourceLabel = p.source === 'EASY_ORDERS' ? 'Easy Orders' : 'رفع يدوي';
  const imageCount = p.imageIds?.length || (p.primaryImageUrl ? 1 : 0);
  const lastAnalysis = state.snapshot?.computedAt ? timeAgoAr(state.snapshot.computedAt) : null;
  const gallery = (p.imageIds || []).slice(0, 4).map((id) => `<div class="pmc-hero-thumb"><img src="/api/product-marketing/profiles/${p.id}/images/${id}" onerror="this.closest('.pmc-hero-thumb').style.display='none'" /></div>`).join('');
  return `
    <div class="pmc-hero">
      <div class="pmc-hero-media">
        <div class="pmc-hero-main">${p.primaryImageUrl ? `<img src="${E(p.primaryImageUrl)}" onerror="this.style.visibility='hidden'" />` : `<div class="pmc-hero-noimg">${pmcIcon('photo')}</div>`}</div>
        ${gallery ? `<div class="pmc-hero-thumbs">${gallery}</div>` : ''}
      </div>
      <div class="pmc-hero-body">
        <div class="pmc-hero-top">
          <span class="pmc-hero-badge">${pmcIcon('check')} منتج محدد</span>
        </div>
        <div class="pmc-hero-name">${E(p.lockedName)}</div>
        <div class="pmc-hero-sub">${category ? E(category) : E(sourceLabel)}${category ? ` · ${E(sourceLabel)}` : ''}</div>
        <div class="pmc-hero-pills">
          ${traitPillsHtml(p.confirmedTraits, 'confirmed')}
          ${traitPillsHtml(p.potentialTraits, 'potential')}
        </div>
        <div class="pmc-hero-price-row">
          <div class="pmc-hero-price"><span class="l">السعر في السوق</span><b>${p.sellingPrice ? fmtEGP(p.sellingPrice) : '—'}</b></div>
          <div class="pmc-hero-source"><span class="l">المصدر</span><b>${pmcIcon('store')} ${E(p.storeName || sourceLabel)}</b></div>
        </div>
      </div>
      <div class="pmc-hero-side">
        <div class="pmc-hero-actions">
          <button class="amb-btn primary" id="pmcChangeProduct">${pmcIcon('plus')} تحليل منتج جديد</button>
        </div>
        <div class="pmc-quick-info">
          <div class="h">معلومات سريعة</div>
          ${category ? `<div class="pmc-qi-row"><span>${pmcIcon('tag')} الفئة</span><b>${E(category)}</b></div>` : ''}
          <div class="pmc-qi-row"><span>${pmcIcon('link')} المصدر</span><b>${E(sourceLabel)}</b></div>
          <div class="pmc-qi-row"><span>${pmcIcon('photo')} عدد صور</span><b>${imageCount || '—'}</b></div>
          <div class="pmc-qi-row"><span>${pmcIcon('clock')} آخر تحليل</span><b>${lastAnalysis || 'لسه ما اتحللش'}</b></div>
        </div>
      </div>
    </div>`;
}

function navCardsHtml() {
  return `<div class="pmc-navcards">${TABS.map((t) => `
    <button class="pmc-navcard ${state.tab === t.k ? 'active' : ''}" data-pmc-tab="${t.k}">
      <span class="pmc-navcard-ic clr-${t.color}">${pmcIcon(t.icon)}</span>
      <span class="pmc-navcard-t">${E(t.label)}</span>
      <span class="pmc-navcard-d">${E(t.desc)}</span>
    </button>`).join('')}</div>`;
}

function renderWorkspace(mount) {
  const p = state.profile;
  mount.innerHTML = `
    ${productHeroHtml(p)}
    <div id="pmcMetaMappingSection"></div>
    ${navCardsHtml()}

    <div class="toolbar pmc-window-toolbar">
      <span class="amb-fgrp"><span class="fl">الفترة</span>${WINDOWS.map((w) => `<button class="amb-fbtn ${state.windowName === w.k ? 'active' : ''}" data-win="${w.k}">${E(w.label)}</button>`).join('')}</span>
      <button class="amb-btn sm" id="pmcRefresh">${pmcIcon('refresh')} تحديث التحليل</button>
    </div>

    <div id="pmcTabBody"></div>`;

  $('pmcChangeProduct').onclick = () => { state.profile = null; state.eoSelected = null; resetWorkspace(); render(); renderNav(); };
  // renderWorkspace's own trailing check (below) already calls loadSnapshot()
  // whenever state.snapshot is null — calling it again here used to fire two
  // concurrent /analyze requests for the same window. Whichever one settled
  // LAST overwrote the cached snapshot, so a slow AI-timeout retry could
  // clobber an already-successful result with a failure purely by finishing
  // later. Let renderWorkspace's own check be the only trigger.
  mount.querySelectorAll('[data-win]').forEach((b) => { b.onclick = () => { state.windowName = b.dataset.win; state.snapshot = null; renderWorkspace(mount); }; });
  $('pmcRefresh').onclick = () => loadSnapshot(true);
  mount.querySelectorAll('[data-pmc-tab]').forEach((b) => { b.onclick = () => selectPmcTab(b.dataset.pmcTab); });

  renderMetaMappingSection();
  if (!state.metaMapping && !state.metaMappingLoading) loadMetaMapping();

  if (!state.snapshot && !state.snapshotLoading) loadSnapshot();
  else renderTabBody();
}

function traitCol(cls, label, items) {
  if (!items?.length) return '';
  return `<div class="pmc-trait-col ${cls}"><div class="h">${E(label)}</div><ul>${items.map((t) => `<li>${E(t.label)}${t.value ? `: ${E(t.value)}` : ''}</li>`).join('')}</ul></div>`;
}

async function loadSnapshot(force = false) {
  state.snapshotLoading = true;
  const body = $('pmcTabBody'); if (body) body.innerHTML = '<div class="pmc-empty">🤖 بنحلل المنتج… (بيانات حقيقية + ذكاء اصطناعي)</div>';
  try {
    state.snapshot = await api.post(`/api/product-marketing/profiles/${state.profile.id}/analyze`, { window: state.windowName, force });
  } catch (e) {
    UI.toast(e.message, 'error');
    state.snapshot = null;
  }
  state.snapshotLoading = false;
  renderTabBody();
}

function renderTabBody() {
  const mount = $('pmcTabBody');
  if (!mount) return;
  if (!state.snapshot) { mount.innerHTML = '<div class="pmc-empty">مفيش تحليل متاح حاليًا.</div>'; return; }
  const s = state.snapshot;
  const renderers = { overview: renderOverview, audience: renderAudience, angles: renderAngles, creative: renderCreative, hooks: renderHooksTab, locations: renderLocations, competitors: renderCompetitors, tests: renderTests, strategist: renderStrategist };
  (renderers[state.tab] || renderOverview)(mount, s);
}

function kindPill(kind) { return kind ? `<span class="pmc-pill ${E(kind)}">${{ FACT: 'حقيقة', HYPOTHESIS: 'فرضية', RECOMMENDATION: 'توصية' }[kind] || kind}</span>` : ''; }
function confPill(c) { return c ? `<span class="pmc-pill conf-${E(c)}">ثقة ${{ LOW: 'منخفضة', MEDIUM: 'متوسطة', HIGH: 'عالية' }[c] || c}</span>` : ''; }
function claimPill(status, reason) { const map = { GREEN: ['🟢 آمن', ''], YELLOW: ['🟡 يحتاج إثبات', ''], RED: ['🔴 غير موصى به', reason || ''] }; const [label] = map[status] || ['—', '']; return `<span class="pmc-claim ${E(status)}" title="${E(reason || '')}">${label}</span>`; }

// ---- Phase F — every tab shows real data, an AI note, or an explicit "why
// not" reason; never a blank card. dataCompleteness (backend-computed,
// see assembleDataCompleteness) already carries {status, reason} per
// dimension — this just renders it consistently with a labeled source. ----
const PMC_SRC_LABEL = { META: 'Meta', EASY_ORDERS: 'Easy Orders', AI: 'AI', CATALOG: 'الكتالوج', RESEARCH: 'بحث المنافسين' };
const PMC_SRC_COLOR = { META: 'blue', EASY_ORDERS: 'green', AI: 'purple', CATALOG: 'amber', RESEARCH: 'cyan' };
function pmcSourceBadge(source) { return `<span class="pmc-src-badge ${PMC_SRC_COLOR[source] || 'blue'}">${E(PMC_SRC_LABEL[source] || source)}</span>`; }
const PMC_STATUS_CLASS = { AVAILABLE: 'ok', PARTIAL: 'partial', MISSING: 'missing', ERROR: 'error' };
/** `sources` is one source key or an array of them (a section can be fed by more than one, e.g. Meta + AI). */
function pmcDataStatus(dim, sources) {
  if (!dim) return '';
  const badges = (Array.isArray(sources) ? sources : [sources]).map(pmcSourceBadge).join('');
  return `<div class="pmc-data-status ${PMC_STATUS_CLASS[dim.status] || 'missing'}">${badges}<span class="reason">${E(dim.reason || '')}</span></div>`;
}

// §7 — Matched / Possible Match / Unmapped, with the real reason (never a
// generic "insufficient data" for this specific case).
function metaMatchBadgeHtml(da) {
  if (!da) return '';
  if (da.metaMatchMethod === 'AMB_MAPPING') {
    return `<div class="faint" style="font-size:11px;margin-top:8px;">🟢 مصدر بيانات Meta: ربط مؤكد${da.metaMappedCampaignCount ? ` — ${E(da.metaMappedCampaignCount)} حملة مرتبطة` : ''}</div>`;
  }
  if (da.metaMatchMethod) {
    const label = da.metaMatchMethod === 'SLUG' ? 'اقتراح غير مؤكد (عبر Slug)' : da.metaMatchMethod === 'EXTERNAL_ID' ? 'اقتراح غير مؤكد (عبر رقم المنتج)' : 'اقتراح غير مؤكد (عبر اسم المنتج)';
    return `<div class="faint" style="font-size:11px;margin-top:8px;">🟡 ${E(label)}${da.metaMatchReason ? ` — ${E(da.metaMatchReason)}` : ''} — راجع قسم "ربط إعلانات Meta" وأكِّده.</div>`;
  }
  if (da.possibleMetaMatch) {
    return `<div class="faint" style="font-size:11px;margin-top:8px;">🟡 تطابق محتمل — ${E(da.possibleMetaMatch.reason)} (${da.possibleMetaMatch.campaignNames.slice(0, 2).map(E).join('، ')})</div>`;
  }
  return `<div class="faint" style="font-size:11px;margin-top:8px;">⚪ غير مربوط بأي حملة Meta</div>`;
}

// ---------------------------------------------------------------------------
// Product <-> Meta Campaign mapping — "ربط إعلانات Meta". Independent of the
// AI snapshot: reuses AI Media Buyer's EXISTING AmbProduct/
// AmbProductCampaignMap architecture (no new mapping system). Never
// auto-confirms — every write happens only from an explicit admin click on
// "تأكيد الربط" after reviewing checked campaigns.
// ---------------------------------------------------------------------------
const META_MAPPING_STATUS_LABEL = { CONFIRMED: '🟢 مؤكد', REVIEW_REQUIRED: '🟡 يحتاج مراجعة', UNMAPPED: '⚪ غير مربوط', AMBIGUOUS: '🔴 غامض' };

async function loadMetaMapping() {
  state.metaMappingLoading = true;
  renderMetaMappingSection();
  try {
    state.metaMapping = await api.get(`/api/product-marketing/profiles/${state.profile.id}/meta-mapping`);
    state.metaMappingSelected = {};
  } catch (e) {
    UI.toast(e.message || 'تعذر تحميل اقتراحات ربط Meta.', 'error');
    state.metaMapping = null;
  }
  state.metaMappingLoading = false;
  renderMetaMappingSection();
}

async function confirmSelectedMetaCampaigns() {
  const campaignIds = Object.keys(state.metaMappingSelected).filter((id) => state.metaMappingSelected[id]);
  if (!campaignIds.length) { UI.toast('اختر حملة واحدة على الأقل قبل تأكيد الربط.', 'error'); return; }
  state.metaMappingBusy = true;
  renderMetaMappingSection();
  try {
    const r = await api.post(`/api/product-marketing/profiles/${state.profile.id}/meta-mapping/confirm`, { campaignIds });
    for (const row of r.results || []) {
      if (row.status === 'MAPPED') UI.toast(`✅ تم تأكيد ربط "${row.campaignName || row.campaignId}"`, 'success');
      else UI.toast(`⚠️ ${row.campaignId}: ${row.reason || 'رُفض الربط'}`, 'error');
    }
  } catch (e) {
    UI.toast(e.message || 'فشل تأكيد الربط.', 'error');
  }
  state.metaMappingBusy = false;
  await loadMetaMapping();
  await loadSnapshot(true); // Meta metrics likely just changed — reflect it immediately in the analysis, same as any other explicit "تحديث"
}

function metaMappingRowHtml(c, selectable) {
  const checked = !!state.metaMappingSelected[c.campaignId];
  return `
    <div class="pmc-mm-row">
      ${selectable ? `<div class="pmc-mm-check"><input type="checkbox" class="pmc-mm-select" data-cid="${E(c.campaignId)}" ${checked ? 'checked' : ''} /></div>` : '<div></div>'}
      <div>
        <div class="pmc-mm-name">${E(c.campaignName)}</div>
        <div class="faint" style="font-size:11px;">Campaign ID: ${E(c.campaignId)}</div>
      </div>
      <div class="pmc-mm-num">${fmtEGP(c.spend)}</div>
      <div class="pmc-mm-num">${fmtNum(c.purchases)}</div>
      <div class="pmc-mm-num">${c.cpa != null ? fmtEGP(c.cpa) : '—'}</div>
      <div class="pmc-mm-badge ${E(c.status)}">${c.status === 'MAPPED' ? 'مؤكد' : 'مقترح'}</div>
      <div class="faint" style="font-size:11px;">${E(c.matchMethod || '—')}${c.confidence != null ? ` · ${Math.round(c.confidence * 100)}%` : ''}</div>
    </div>`;
}

function renderMetaMappingSection() {
  const mount = $('pmcMetaMappingSection');
  if (!mount) return;
  const mm = state.metaMapping;

  if (state.metaMappingLoading && !mm) { mount.innerHTML = '<div class="pmc-card" style="margin-bottom:14px;"><div class="h">📣 ربط إعلانات Meta</div><div class="amb-loading">جارِ تحميل الاقتراحات…</div></div>'; return; }
  if (!mm) { mount.innerHTML = ''; return; }

  const selectedCount = Object.values(state.metaMappingSelected).filter(Boolean).length;
  mount.innerHTML = `
    <div class="pmc-card" style="margin-bottom:14px;">
      <div class="h" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <span>📣 ربط إعلانات Meta — ${META_MAPPING_STATUS_LABEL[mm.status] || mm.status}</span>
        <button class="amb-btn sm" id="pmcMmRefresh" ${state.metaMappingBusy ? 'disabled' : ''}>🔄 تحديث الاقتراحات</button>
      </div>

      ${mm.confirmedCampaigns.length ? `
        <div class="faint" style="font-size:11.5px;margin:6px 0;">حملات مؤكدة (${mm.confirmedCampaigns.length}) — مصدر بيانات Meta الحالي لهذا المنتج:</div>
        ${mm.confirmedCampaigns.map((c) => metaMappingRowHtml(c, false)).join('')}
      ` : ''}

      ${mm.suggestedCampaigns.length ? `
        <div class="faint" style="font-size:11.5px;margin:10px 0 6px;">حملات مقترحة (${mm.suggestedCampaigns.length}) — راجعها وحدد ما تريد تأكيده:</div>
        ${mm.suggestedCampaigns.map((c) => metaMappingRowHtml(c, true)).join('')}
        <div style="display:flex; gap:8px; margin-top:10px;">
          <button class="amb-btn primary sm" id="pmcMmConfirm" ${state.metaMappingBusy ? 'disabled' : ''}>${state.metaMappingBusy ? 'جارِ التأكيد…' : `تأكيد الربط (${selectedCount})`}</button>
          <button class="amb-btn sm ghost" id="pmcMmClear">إلغاء التحديد</button>
        </div>
      ` : ''}

      ${!mm.confirmedCampaigns.length && !mm.suggestedCampaigns.length ? `<div class="pmc-empty" style="padding:10px;">${E(mm.reason || 'لا توجد حملات Meta مقترحة لهذا المنتج حاليًا.')}</div>` : ''}

      ${mm.conflicts?.length ? `
        <div class="faint" style="font-size:11px;margin-top:10px;color:var(--amb-amber);">⚠️ ${mm.conflicts.length} حملة تشبه اسم/معرّف هذا المنتج لكنها مربوطة بالفعل بمنتج AMB آخر — لن تُقترح هنا لتفادي ربط خاطئ: ${mm.conflicts.map((c) => E(c.campaignName)).join('، ')}</div>
      ` : ''}
    </div>`;

  $('pmcMmRefresh')?.addEventListener('click', () => loadMetaMapping());
  $('pmcMmConfirm')?.addEventListener('click', () => confirmSelectedMetaCampaigns());
  $('pmcMmClear')?.addEventListener('click', () => { state.metaMappingSelected = {}; renderMetaMappingSection(); });
  mount.querySelectorAll('.pmc-mm-select').forEach((cb) => {
    cb.addEventListener('change', () => { state.metaMappingSelected[cb.dataset.cid] = cb.checked; renderMetaMappingSection(); });
  });
}

// ---- §4/§5/§6/§20/§21 — Overview ----
/**
 * Phase 2 KPI row — ONLY real, non-null metrics get a card (spend/selling
 * price default to a real 0/real price so they always show; purchases/
 * delivered/deliveryRate/CPA/revenue/netProfit are omitted entirely, never
 * shown as a fake "—" tile, when the underlying value is genuinely null).
 * No trend/delta arrows anywhere: no prior-window comparison value is
 * exposed by the API to the frontend today (see plan) — inventing one here
 * would violate the "never fabricate a trend" rule.
 */
function kpiCard(icon, color, label, value, extra = '') {
  if (value === null || value === undefined) return '';
  return `<div class="pmc-kpi"><span class="pmc-kpi-ic clr-${color}">${pmcIcon(icon)}</span><div class="pmc-kpi-body"><b>${value}</b><span>${E(label)}</span>${extra}</div></div>`;
}
// Revenue-source honesty (never merge Meta's self-reported ad-conversion
// revenue with confirmed Easy Orders revenue — two separate cards, two
// separate labels, always). m.revenueSource is now always explicit:
// 'real'/'estimated' (COD-derived, from a confirmed AmbProduct's own P&L)
// or 'meta' (Meta's own platform-reported value, unconfirmed by any real
// order) — see productMarketing.js's deriveRevenueHonesty() for the full
// rationale. m.codRevenue is the SAME real number the governorate/
// customer-quality table already shows, surfaced here as its own card so
// it's never confused with — or averaged into — Meta's figure.
function revenueCards(m) {
  const cards = [];
  if (m.revenue != null) {
    if (m.revenueSource === 'meta') {
      cards.push(kpiCard('megaphone', 'yellow', 'إيراد Meta — غير مؤكد', fmtEGP(m.revenue)));
    } else {
      cards.push(kpiCard('megaphone', 'yellow', 'الإيراد', fmtEGP(m.revenue), m.revenueSource ? `<i class="pmc-kpi-tag">${m.revenueSource === 'real' ? 'حقيقي' : 'تقديري'}</i>` : ''));
    }
  }
  if (m.codRevenue != null) {
    cards.push(kpiCard('check', 'green', 'إيراد حقيقي — Easy Orders', fmtEGP(m.codRevenue)));
  }
  return cards;
}

// Same never-merge principle for ROAS: m.roas is ALWAYS Meta's own
// campaign-derived figure (confirmed: never recomputed from real COD
// revenue even with a confirmed AmbProduct mapping) — always shown as
// "ROAS — Meta". m.realRoas is the ONLY figure ever computed from
// confirmed Easy Orders revenue ÷ real spend — shown separately as
// "ROAS — حقيقي (Easy Orders)", only when a real signal exists to compute
// it from (never a fabricated placeholder).
function roasCards(m) {
  const cards = [];
  if (m.roas != null) cards.push(kpiCard('trend', 'purple', 'ROAS — Meta', fmtNum(Math.round(m.roas * 100) / 100)));
  if (m.realRoas != null) cards.push(kpiCard('trend', 'green', 'ROAS — حقيقي (Easy Orders)', fmtNum(Math.round(m.realRoas * 100) / 100)));
  return cards;
}

function kpiRowHtml(s, p) {
  const m = s.metrics || {};
  const cards = [
    kpiCard('coin', 'blue', 'الإنفاق الإعلاني', fmtEGP(m.totalSpend ?? 0)),
    kpiCard('cart', 'purple', 'مشتريات Meta', m.metaPurchases != null ? fmtNum(m.metaPurchases) : null),
    kpiCard('check', 'green', 'طلبات مُستلمة (COD)', m.deliveredOrders != null ? fmtNum(m.deliveredOrders) : null),
    kpiCard('percent', 'cyan', 'معدل الاستلام', m.deliveryRate != null ? fmtPct1(m.deliveryRate) : null),
    kpiCard('target', 'amber', 'Delivered CPA', m.deliveredCpa != null ? fmtEGP(m.deliveredCpa) : null),
    kpiCard('trend', m.netProfit != null && m.netProfit >= 0 ? 'green' : 'pink', 'صافي الربح', m.netProfit != null ? fmtEGP(m.netProfit) : null),
    ...revenueCards(m),
    ...roasCards(m),
    kpiCard('tag', 'blue', 'متوسط سعر المنتج', p?.sellingPrice ? fmtEGP(p.sellingPrice) : null),
  ].filter(Boolean);
  return cards.length ? `<div class="pmc-kpi-row">${cards.join('')}</div>` : '';
}

/** Real horizontal-bar visual for top governorates — same s.markets/s.locations data renderLocations() already shows as a table; bars sized by real delivered-order share. Never fabricates a location or a bar for a value that isn't real. */
function locationsBarHtml(s) {
  const rows = (s.markets?.length ? s.markets : s.locations) || [];
  if (!rows.length) return '';
  const top = [...rows].sort((a, b) => (b.delivered || 0) - (a.delivered || 0)).slice(0, 6);
  const max = Math.max(...top.map((r) => r.delivered || 0), 1);
  return `<div class="pmc-card">
    <div class="h">${pmcIcon('mappin')} توزيع الطلبات حسب المحافظات</div>
    <div class="pmc-geo-bars">${top.map((r) => `<div class="pmc-geo-row">
      <span class="lbl">${E(r.government)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.round(((r.delivered || 0) / max) * 100)}%"></span></span>
      <span class="val">${fmtNum(r.delivered)}</span>
    </div>`).join('')}</div>
  </div>`;
}

function renderOverview(mount, s) {
  const op = s.opportunity || {};
  const scoreColor = op.label === 'قوية' ? 'strong' : op.label === 'متوسطة' ? 'medium' : 'weak';
  const ring = op.score != null ? scoreRingSvg(op.score, scoreColor) : '<div class="pmc-empty" style="padding:16px;">البيانات غير كافية للحكم</div>';
  const m = s.metrics || {};
  mount.innerHTML = `
    ${kpiRowHtml(s, state.profile)}
    <div class="pmc-card" style="margin-bottom:14px;">
      <div class="h" style="display:flex;justify-content:space-between;align-items:center;">
        <span>🔔 يحتاج انتباهك الآن</span>${healthBandPill(op.healthBand)}
      </div>
      ${needsAttentionListHtml(s.needsAttention)}
    </div>
    ${buyerInsightsRowHtml(s.buyerInsights)}
    <div class="pmc-top-grid">
      <div class="pmc-card">
        <div class="h">💡 فرصة نجاح المنتج</div>
        ${ring}
        ${op.dataSufficient ? `<div class="pmc-score-label ${scoreColor}">${E(op.label)} · ${confPill(op.confidence)}</div>` : `<div class="faint" style="text-align:center;font-size:12px;">${E(op.note || 'البيانات غير كافية للحكم')}</div>`}
      </div>
      <div class="pmc-card">
        <div class="h">📊 الأداء الحالي — ${E(m.windowLabel || '')}</div>
        <div class="pmc-kv"><span>المصروف</span><b>${fmtEGP(m.totalSpend)}</b></div>
        <div class="pmc-kv"><span>مشتريات Meta</span><b>${fmtNum(m.metaPurchases)}</b></div>
        <div class="pmc-kv"><span>طلبات مُستلمة (COD)</span><b>${fmtNum(m.deliveredOrders)}</b></div>
        <div class="pmc-kv"><span>معدل الاستلام</span><b>${fmtPct1(m.deliveryRate)}</b></div>
        <div class="pmc-kv"><span>Delivered CPA</span><b>${fmtEGP(m.deliveredCpa)}</b></div>
        <div class="pmc-kv"><span>صافي الربح</span><b>${fmtEGP(m.netProfit)}</b></div>
        ${metaMatchBadgeHtml(m.dataAvailability)}
      </div>
      <div class="pmc-card">
        <div class="h">🩺 التشخيص السريع</div>
        ${(s.diagnosis || []).map((d) => `<div class="pmc-diag-item"><div class="dot ${E(d.severity)}"></div><div><div class="t">${E(d.problem)}</div><div class="e">${E(d.evidence)}</div><div class="a">↳ ${E(d.action)}</div></div></div>`).join('')}
        ${s.diagnosisNarrative ? `<div class="faint" style="font-size:12px;margin-top:8px;">${E(s.diagnosisNarrative)}</div>` : ''}
      </div>
      <div class="pmc-card">
        <div class="h">👥 أفضل جمهور مقترح</div>
        ${audienceSummaryHtml(s.audience)}
      </div>
      ${locationsBarHtml(s) || `<div class="pmc-card"><div class="h">📍 أفضل المحافظات</div><div class="pmc-empty" style="padding:10px;">${E(m.dataAvailability?.codMessage || 'البيانات غير كافية للحكم')}</div></div>`}
      <div class="pmc-card">
        <div class="h">🏆 التركيبة الرابحة</div>
        ${winningFormulaHtml(s.winningFormula)}
      </div>
    </div>

    <div class="pmc-card" style="margin-top:14px;">
      <div class="h">🔥 أفضل زوايا بيع مقترحة</div>
      ${(s.angles || []).slice(0, 3).map((a) => `<div class="pmc-angle-mini"><span>${E(a.name)} ${claimPill(a.claimStatus, a.claimReason)}</span>${confPill(a.confidence)}</div>`).join('') || `<div class="pmc-empty">${E(s.aiFailed ? (s.aiFailReason || 'تعذر إكمال التحليل حالياً — حاول مرة أخرى') : 'البيانات غير كافية للحكم')}</div>`}
    </div>

    <div class="pmc-card" style="margin-top:14px;">
      <div class="h">⚡ ماذا أفعل الآن؟</div>
      ${actionsListHtml(s.actions)}
      ${s.aiFailed ? `<div class="faint" style="font-size:11.5px;margin-top:6px;">⚠️ تعذّر توليد التوصيات الذكية: ${E(s.aiFailReason || '')}</div>` : ''}
    </div>`;
  wireActionButtons(mount);
}

function needsAttentionListHtml(items) {
  if (!items?.length) return '<div class="pmc-empty" style="padding:10px;">مفيش حاجة تحتاج انتباه حاليًا — الأرقام في نطاقها الطبيعي.</div>';
  return items.slice(0, 6).map((it) => `<div class="pmc-diag-item">
    <div class="dot ${it.priority === 'P0' ? 'HIGH' : it.priority === 'P1' ? 'MEDIUM' : 'INFO'}"></div>
    <div>
      <div class="t">${priorityPill(it.priority)} ${E(it.what)}</div>
      <div class="e">${E(it.why || '')}</div>
      <div class="a">↳ ${E(it.action || '')}</div>
    </div>
  </div>`).join('');
}

function buyerInsightsRowHtml(bi) {
  if (!bi) return '';
  const hasAny = bi.newCustomers != null || bi.repeatCustomers != null;
  if (!hasAny) return '';
  return `<div class="pmc-card" style="margin-bottom:14px;">
    <div class="h">👤 جودة العملاء الحقيقية</div>
    <div class="pmc-top-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));">
      <div class="pmc-kv"><span>عملاء جدد</span><b>${fmtNum(bi.newCustomers)}</b></div>
      <div class="pmc-kv"><span>عملاء متكررين</span><b>${fmtNum(bi.repeatCustomers)}</b></div>
      <div class="pmc-kv"><span>متوسط الطلب (جديد)</span><b>${bi.aovNew != null ? fmtEGP(bi.aovNew) : '—'}</b></div>
      <div class="pmc-kv"><span>متوسط الطلب (متكرر)</span><b>${bi.aovRepeat != null ? fmtEGP(bi.aovRepeat) : '—'}</b></div>
    </div>
    ${bi.topCoPurchasedProducts?.length ? `<div class="faint" style="font-size:11.5px;margin-top:8px;">غالبًا يُشترى مع: ${bi.topCoPurchasedProducts.slice(0, 3).map((p) => E(p.productName || `#${p.productId}`)).join('، ')}</div>` : ''}
  </div>`;
}

function scoreRingSvg(score, cls) {
  const r = 40, c = 2 * Math.PI * r;
  const color = cls === 'strong' ? 'var(--amb-green)' : cls === 'medium' ? 'var(--amb-amber)' : 'var(--amb-red)';
  const off = c - (Math.max(0, Math.min(100, score)) / 100) * c;
  return `<div class="pmc-score-ring"><svg width="92" height="92" viewBox="0 0 92 92">
    <circle cx="46" cy="46" r="${r}" fill="none" stroke="var(--amb-border)" stroke-width="8" />
    <circle cx="46" cy="46" r="${r}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}" />
  </svg><div class="num"><b>${score}</b><span>/100</span></div></div>`;
}

function audienceSummaryHtml(a) {
  if (!a || a.unavailable) return `<div class="pmc-empty" style="padding:10px;">${E(a?.reason || 'البيانات غير كافية للحكم')}</div>`;
  const rows = [];
  if (a.gender?.value) rows.push(`<div class="pmc-kv"><span>النوع</span><b>${E(a.gender.value)} ${kindPill(a.gender.kind)}</b></div>`);
  if (a.ageRange?.value) rows.push(`<div class="pmc-kv"><span>السن</span><b>${E(a.ageRange.value)}</b></div>`);
  if (a.buyerVsUser?.user) rows.push(`<div class="pmc-kv"><span>المستخدم</span><b>${E(a.buyerVsUser.user)}</b></div>`);
  if (a.buyerVsUser?.buyer) rows.push(`<div class="pmc-kv"><span>المشتري</span><b>${E(a.buyerVsUser.buyer)}</b></div>`);
  return rows.join('') || '<div class="pmc-empty" style="padding:10px;">البيانات غير كافية للحكم</div>';
}

function winningFormulaHtml(wf) {
  if (!wf || !wf.available) return '<div class="pmc-empty" style="padding:10px;">البيانات غير كافية للحكم بعد</div>';
  const rows = [['النوع', wf.gender], ['السن', wf.ageRange], ['المكان', wf.location], ['الزاوية', wf.angle], ['Hook', wf.hook], ['الشكل', wf.format]];
  return rows.filter(([, v]) => v).map(([k, v]) => `<div class="pmc-kv"><span>${E(k)}</span><b>${E(v)}</b></div>`).join('') + (wf.narrative ? `<div class="faint" style="font-size:11.5px;margin-top:6px;">${E(wf.narrative)}</div>` : '');
}

function actionsListHtml(actions) {
  if (!actions?.length) return '<div class="pmc-empty">مفيش توصيات حاليًا.</div>';
  return actions.map((a, i) => `<div class="pmc-action-item">
    <div class="t">${E(a.title)} ${confPill(a.confidence)}</div>
    <div class="r">${E(a.reason)}${a.expectedBenefit ? ` · الفايدة المتوقعة: ${E(a.expectedBenefit)}` : ''}${a.risk ? ` · الخطورة: ${E(a.risk)}` : ''}</div>
    <div class="faint" style="font-size:11px;margin-bottom:6px;">المصدر: ${E(a.source || '—')}</div>
    <div class="btns">
      <button class="amb-btn sm primary" data-act-approve="${i}">موافقة</button>
      <button class="amb-btn sm" data-act-modify="${i}">تعديل</button>
      <button class="amb-btn sm ghost" data-act-reject="${i}">رفض</button>
    </div>
  </div>`).join('');
}
function wireActionButtons(mount) {
  const decide = async (i, status) => {
    const list = await api.get(`/api/product-marketing/profiles/${state.profile.id}/actions`);
    const row = list.actions.find((a) => a.actionKey === state.snapshot.actions[i]?.actionKey);
    if (!row) { UI.toast('التوصية دي مش متاحة للقرار حاليًا.', 'error'); return; }
    try { await api.post(`/api/product-marketing/actions/${row.id}/decide`, { status }); UI.toast('تم تسجيل القرار.'); }
    catch (e) { UI.toast(e.message, 'error'); }
  };
  mount.querySelectorAll('[data-act-approve]').forEach((b) => b.onclick = () => decide(Number(b.dataset.actApprove), 'APPROVED'));
  mount.querySelectorAll('[data-act-modify]').forEach((b) => b.onclick = () => decide(Number(b.dataset.actModify), 'MODIFIED'));
  mount.querySelectorAll('[data-act-reject]').forEach((b) => b.onclick = () => decide(Number(b.dataset.actReject), 'REJECTED'));
}

// ---- §7/§9 — Audience & Markets ----
/** Phase 2 — one structured fact tile instead of a plain kv row; same fields, no fabrication (kind/confidence/evidence pass through untouched). */
function audienceFactTile(icon, color, label, value, kind, confidence, evidence) {
  return `<div class="pmc-fact-tile">
    <span class="pmc-fact-ic clr-${color}">${pmcIcon(icon)}</span>
    <div class="pmc-fact-body">
      <div class="pmc-fact-label">${E(label)}</div>
      <div class="pmc-fact-value">${E(value || '—')} ${kindPill(kind)} ${confPill(confidence)}</div>
      ${evidence ? `<div class="pmc-fact-evidence">${E(evidence)}</div>` : ''}
    </div>
  </div>`;
}
function segmentCardHtml(seg) {
  return `<div class="pmc-segment-card">
    <span class="pmc-segment-ic">${pmcIcon('users')}</span>
    <div class="pmc-segment-body">
      <div class="head"><span class="name">${E(seg.label)}</span>${kindPill(seg.kind)}${confPill(seg.confidence)}</div>
      <div class="pmc-angle-fields">
        <div class="f"><b>النوع</b>${E(seg.gender || '—')}</div>
        <div class="f"><b>السن</b>${E(seg.ageRange || '—')}</div>
        <div class="f"><b>المكان</b>${E(seg.location || '—')}</div>
        <div class="f"><b>حجم البيانات</b>${E(seg.dataSize || '—')}</div>
      </div>
      ${seg.evidence ? `<div class="faint" style="font-size:11.5px;margin-top:8px;">الدليل: ${E(seg.evidence)}</div>` : ''}
    </div>
  </div>`;
}
// ---- Phase A — real Meta age/gender/region/country/platform/placement ----
// ---- breakdown (confirmed campaigns only). Every number here is Meta's ----
// ---- own ad-performance-by-segment data — an audience Meta SERVED the ----
// ---- ad to, never a literal Easy Orders customer record. ----
const COMBO_STATUS_LABEL_AR = { AVAILABLE: 'متاح', EMPTY: 'مفيش بيانات', UNSUPPORTED: 'Meta ما بتدعمش الدمج ده', PERMISSION_DENIED: 'صلاحية ناقصة', ERROR: 'خطأ' };
function dimTableHtml(title, rows, unit) {
  if (!rows?.length) return '';
  return `<div class="pmc-card" style="margin-bottom:14px;">
    <div class="h">${E(title)}</div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${E(unit)}</th><th>الصرف</th><th>مشتريات</th><th>قيمة المشتريات</th><th>CPA</th><th>CTR</th><th>CPC</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${E(r.value)}</td><td>${fmtEGP(r.spend)}</td><td>${fmtNum(r.purchases)}</td><td>${r.purchaseValue ? fmtEGP(r.purchaseValue) : '—'}</td><td>${r.cpa != null ? fmtEGP(r.cpa) : '—'}</td><td>${r.ctr != null ? `${r.ctr.toFixed(1)}%` : '—'}</td><td>${r.cpc != null ? fmtEGP(r.cpc) : '—'}</td></tr>`).join('')}</tbody>
    </table></div>
  </div>`;
}
function comboStatusRowsHtml(combos) {
  const entries = Object.entries(combos || {});
  if (!entries.length) return '';
  return `<details class="pmc-loc-details" style="margin-top:6px;">
    <summary>حالة كل تقسيم طلبناه من Meta (${entries.length})</summary>
    <div style="margin-top:8px;">${entries.map(([key, c]) => `<div class="pmc-kv"><span>${E(key)}</span><b>${E(COMBO_STATUS_LABEL_AR[c.status] || c.status)}</b></div>${c.reason ? `<div class="faint" style="font-size:11px;margin:0 0 8px;">${E(c.reason)}</div>` : ''}`).join('')}</div>
  </details>`;
}
function audienceBreakdownBoxHtml(ab) {
  if (!ab || !ab.available) {
    return `<div class="pmc-empty">${E(ab?.reason || 'لسه ما اتحسبتش بيانات الجمهور الحقيقية من Meta.')}</div>${comboStatusRowsHtml(ab?.combos)}`;
  }
  const freshness = ab.generatedAt ? `<div class="faint" style="font-size:11px;margin-bottom:10px;">آخر تحديث: ${new Date(ab.generatedAt).toLocaleString('ar-EG')} — ${E(ab.windowLabel || '')} — ${fmtNum((ab.campaignIds || []).length)} حملة مؤكدة</div>` : '';
  const warning = ab.sampleWarning ? `<div class="pmc-empty" style="text-align:right;background:var(--amb-amber-bg);border-color:var(--amb-amber);color:var(--amb-amber);">⚠️ ${E(ab.sampleWarning)}</div>` : '';
  const tables = [
    dimTableHtml('التوزيع حسب السن', ab.age, 'الفئة العمرية'),
    dimTableHtml('التوزيع حسب النوع', ab.gender, 'النوع'),
    dimTableHtml('أقوى المناطق (Region)', ab.region, 'المنطقة'),
    dimTableHtml('أقوى الدول (Country)', ab.country, 'الدولة'),
    dimTableHtml('Facebook مقابل Instagram', ab.platform, 'المنصة'),
    dimTableHtml('أداء المواضع (Placement)', ab.placement?.map((p) => ({ ...p, value: [p.publisher_platform, p.platform_position].filter(Boolean).join(' · ') })), 'الموضع'),
  ].join('');
  return `${freshness}${warning}${tables || '<div class="pmc-empty">Meta ما رجّعتش صفوف حقيقية لأي تقسيم في هذه الفترة.</div>'}${comboStatusRowsHtml(ab.combos)}`;
}
/** Real, deterministic Easy-Orders-derived customer facts for THIS product — zero AI, zero Meta. Same data buyerInsightsRowHtml() shows on Overview, but honest about being empty here instead of silently disappearing (Overview treats it as a bonus row; this tab is exactly where someone asking "what does Easy Orders say" would look first). */
function realCustomerInsightsCardHtml(bi) {
  const hasAny = bi && (bi.newCustomers != null || bi.repeatCustomers != null);
  return `<div class="pmc-card" style="margin-bottom:14px;">
    <div class="h">${pmcIcon('users')} ${pmcSourceBadge('EASY_ORDERS')} جودة العملاء الحقيقية (من طلبات هذا المنتج فعليًا)</div>
    ${hasAny ? `
      <div class="pmc-top-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));">
        <div class="pmc-kv"><span>عملاء جدد</span><b>${fmtNum(bi.newCustomers)}</b></div>
        <div class="pmc-kv"><span>عملاء متكررين</span><b>${fmtNum(bi.repeatCustomers)}</b></div>
        <div class="pmc-kv"><span>متوسط الطلب (جديد)</span><b>${bi.aovNew != null ? fmtEGP(bi.aovNew) : '—'}</b></div>
        <div class="pmc-kv"><span>متوسط الطلب (متكرر)</span><b>${bi.aovRepeat != null ? fmtEGP(bi.aovRepeat) : '—'}</b></div>
      </div>
      ${bi.topCoPurchasedProducts?.length ? `<div class="faint" style="font-size:11.5px;margin-top:8px;">غالبًا يُشترى مع: ${bi.topCoPurchasedProducts.slice(0, 3).map((p) => E(p.productName || `#${p.productId}`)).join('، ')}</div>` : ''}
    ` : `<div class="pmc-empty">لا توجد طلبات حقيقية كافية من Easy Orders لهذا المنتج في هذه الفترة — لسه مفيش عملاء نقدر نحسب منهم جديد/متكرر.</div>`}
    <div class="faint" style="font-size:11px;margin-top:6px;">حقائق شرائية ملحوظة فقط (جديد/متكرر، قيمة الطلب، شراء مشترك) — أبدًا مفيش استنتاج عمر أو نوع من الاسم أو رقم التليفون أو العنوان.</div>
  </div>`;
}
function renderAudience(mount, s) {
  const a = s.audience || {};
  const dc = s.dataCompleteness || {};
  const ab = s.audienceBreakdown || null;
  mount.innerHTML = `
    <div class="pmc-section-badge data-backed">${pmcIcon('check')} جمهور Meta الحقيقي</div>
    <div class="pmc-card" style="margin-bottom:14px;">
      <div class="h" style="display:flex;justify-content:space-between;align-items:center;">
        <span>${pmcIcon('users')} ${pmcSourceBadge('META')} أداء الجمهور الحقيقي على الحملات المؤكدة</span>
        <button class="amb-btn sm primary" id="pmcRefreshAudienceBreakdown">${ab?.generatedAt ? '🔄 تحديث من Meta' : '📡 احسب من بيانات Meta'}</button>
      </div>
      <div class="faint" style="font-size:11.5px;margin-bottom:10px;">أداء إعلاني حقيقي موزّع حسب الشريحة اللي Meta عرض عليها الإعلان — "Meta-attributed audience performance" — مش هوية عملاء حقيقية، ومش مبني على بيانات Easy Orders. توزيع محافظات الطلبات الحقيقي موجود منفصل في تبويب "الأسواق والمناطق".</div>
      <div id="pmcAudienceBreakdownBox">${audienceBreakdownBoxHtml(ab)}</div>
    </div>
    <div class="pmc-section-badge data-backed">${pmcIcon('check')} عملاء Easy Orders الحقيقيين</div>
    ${realCustomerInsightsCardHtml(s.buyerInsights)}
    <div class="pmc-section-badge suggested">${pmcIcon('target')} فرضية AI مساعدة</div>
    ${pmcDataStatus(dc.demographics, 'META')}
    <div class="pmc-card">
      <div class="h">${pmcIcon('users')} خريطة السوق والجمهور</div>
      ${a.unavailable ? `<div class="pmc-empty">${E(a.reason)}</div>` : `
        <div class="faint" style="font-size:11.5px;margin-bottom:10px;">${pmcSourceBadge('AI')} فرضية تسويقية مبنية على المنتج وأدائه الحقيقي — مش هوية عملاء حقيقية أو بيانات Meta ديموغرافية.</div>
        <div class="pmc-fact-grid">
          ${audienceFactTile('users', 'green', 'النوع', a.gender?.value, a.gender?.kind, a.gender?.confidence, a.gender?.evidence)}
          ${audienceFactTile('clock', 'amber', 'السن', a.ageRange?.value, a.ageRange?.kind, a.ageRange?.confidence, a.ageRange?.evidence)}
          ${a.buyerVsUser?.user ? audienceFactTile('target', 'blue', 'المستخدم', a.buyerVsUser.user) : ''}
          ${a.buyerVsUser?.buyer ? audienceFactTile('cart', 'purple', 'المشتري', a.buyerVsUser.buyer) : ''}
          ${a.buyerVsUser?.secondaryBuyer ? audienceFactTile('users', 'cyan', 'المشتري الثانوي', a.buyerVsUser.secondaryBuyer) : ''}
          ${a.buyerVsUser?.giftOpportunity ? audienceFactTile('tag', 'pink', 'فرصة هدية', a.buyerVsUser.giftOpportunity) : ''}
        </div>
      `}
    </div>
    <div class="pmc-card" style="margin-top:14px;">
      <div class="h">${pmcIcon('target')} شرائح مقترحة ${pmcSourceBadge('AI')}</div>
      ${(a.segments || []).map(segmentCardHtml).join('') || `<div class="pmc-empty">${E(a.unavailable ? a.reason : 'البيانات غير كافية للحكم')}</div>`}
    </div>`;
  $('pmcRefreshAudienceBreakdown').onclick = async () => {
    const box = $('pmcAudienceBreakdownBox'); box.innerHTML = '<div class="pmc-empty">📡 بنجيب بيانات الجمهور الحقيقية من Meta…</div>';
    try {
      const result = await api.post(`/api/product-marketing/profiles/${state.profile.id}/audience-breakdown`, { window: state.windowName, force: true });
      s.audienceBreakdown = result;
      box.innerHTML = audienceBreakdownBoxHtml(result);
    } catch (e) { UI.toast(e.message, 'error'); box.innerHTML = `<div class="pmc-empty">${E(e.message)}</div>`; }
  };
}

function winnerIntelTableHtml(intel, emptyMsg) {
  if (!intel?.dataAvailable || !intel.table?.length) return `<div class="pmc-empty" style="padding:10px;">${E(emptyMsg)}</div>`;
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th>الاسم</th><th>الصرف</th><th>مشتريات</th><th>CPA</th><th>CTR</th><th>التصنيف</th></tr></thead>
    <tbody>${intel.table.slice(0, 8).map((r) => `<tr><td>${E(r.label)}</td><td>${fmtEGP(r.spend)}</td><td>${fmtNum(r.purchases)}</td><td>${r.cpa != null ? fmtEGP(r.cpa) : '—'}</td><td>${r.ctr != null ? `${r.ctr.toFixed(1)}%` : '—'}</td><td>${bandPill(r.band)}</td></tr>`).join('')}</tbody>
  </table></div>
  ${intel.winner ? `<div class="faint" style="font-size:12px;margin-top:8px;">🏆 <b>${E(intel.winner.label)}</b> — ${E(intel.winner.why || '')}</div>` : ''}`;
}

// ---- §10/§11 — Sales angles ----
function renderAngles(mount, s) {
  const dc = s.dataCompleteness || {};
  mount.innerHTML = `
    <div class="pmc-section-badge data-backed">${pmcIcon('check')} زوايا مثبتة بالبيانات</div>
    <div class="pmc-card" style="margin-bottom:14px;">
      <div class="h">${pmcIcon('barchart')} أداء زوايا البيع الحقيقي (من الإعلانات الجارية فعليًا)</div>
      ${pmcDataStatus(dc.hooks, 'META')}
      ${winnerIntelTableHtml(s.angleIntel, 'لا توجد بيانات إعلانات حقيقية كفاية لتصنيف الزوايا بعد.')}
    </div>
    <div class="pmc-section-badge suggested">${pmcIcon('target')} زوايا مقترحة للاختبار</div>
    <div class="pmc-card">
      <div class="h">${pmcIcon('target')} أفضل زوايا بيع مقترحة</div>
      ${pmcDataStatus(s.aiFailed ? { status: 'ERROR', reason: s.aiFailReason } : { status: 'AVAILABLE', reason: 'مقترحات AI مبنية على المنتج + أداء الحملات الحقيقي.' }, 'AI')}
      ${(s.angles || []).map((a, i) => `<div class="pmc-angle-card">
        <div class="head"><span class="name">${E(a.name)}</span><span class="cat">${E(a.category || '')}</span>${confPill(a.confidence)}${claimPill(a.claimStatus, a.claimReason)}</div>
        <div class="faint" style="font-size:12.5px;">${E(a.why || '')}</div>
        <div class="pmc-angle-fields">
          <div class="f"><b>الجمهور</b>${E(a.audience || '—')}</div>
          <div class="f"><b>السن</b>${E(a.ageRange || '—')}</div>
          <div class="f"><b>المكان</b>${E(a.location || '—')}</div>
          <div class="f"><b>المشكلة</b>${E(a.painPoint || '—')}</div>
          <div class="f"><b>الفايدة</b>${E(a.benefit || '—')}</div>
          <div class="f"><b>Hook مقترح</b>${E(a.hook || '—')}</div>
          <div class="f"><b>الشكل المقترح</b>${E(a.suggestedFormat || '—')}</div>
        </div>
        ${a.claimStatus === 'RED' ? `<div class="faint" style="font-size:11.5px;color:var(--amb-red);margin-top:6px;">🔴 ${E(a.claimReason)}</div>` : ''}
        <div class="toolbar" style="margin-top:10px;">
          <button class="amb-btn sm" data-gen-hooks="${i}">توليد Hooks لهذه الزاوية</button>
          <button class="amb-btn sm" data-gen-post="${i}">توليد بوست</button>
          <button class="amb-btn sm ghost" data-gen-idea="${i}">أفكار كرياتيف</button>
        </div>
      </div>`).join('') || `<div class="pmc-empty">${E(s.aiFailed ? (s.aiFailReason || 'تعذر إكمال التحليل حالياً — حاول مرة أخرى') : 'البيانات غير كافية للحكم — استمر بالصرف على المنتج أو راجع تحليل المنافسين.')}</div>`}
    </div>`;
  mount.querySelectorAll('[data-gen-hooks]').forEach((b) => b.onclick = () => { state.genAngle = s.angles[Number(b.dataset.genHooks)].name; state.tab = 'hooks'; renderTabBody(); generateHooks(); });
  mount.querySelectorAll('[data-gen-post]').forEach((b) => b.onclick = () => { state.genAngle = s.angles[Number(b.dataset.genPost)].name; state.tab = 'hooks'; renderTabBody(); generatePost(); });
  mount.querySelectorAll('[data-gen-idea]').forEach((b) => b.onclick = () => { state.genAngle = s.angles[Number(b.dataset.genIdea)].name; state.tab = 'creative'; renderTabBody(); generateIdeas(); });
}

// ---- §12/§13/§14/§17 — Creative Intelligence ----
function winningComponentsHtml(wc) {
  if (!wc?.dataSufficient) return '';
  const rows = [
    wc.bestMarket && ['🏆 أفضل سوق', wc.bestMarket.government, wc.bestMarket.why],
    wc.bestHook && ['🏆 أفضل Hook', wc.bestHook.label, wc.bestHook.why],
    wc.bestSellingAngle && ['🏆 أفضل زاوية بيع', wc.bestSellingAngle.label, wc.bestSellingAngle.why],
    wc.bestAd && ['🏆 أفضل إعلان', wc.bestAd.name, wc.bestAd.why],
  ].filter(Boolean);
  if (!rows.length) return '';
  return `<div class="pmc-card" style="margin-bottom:14px;">
    <div class="h">${pmcIcon('image')} أفضل المكوّنات التسويقية الحقيقية</div>
    ${rows.map(([label, value, why]) => `<div class="pmc-kv"><span>${E(label)}</span><b>${E(value)}</b></div><div class="faint" style="font-size:11px;margin:0 0 8px;">${E(why || '')}</div>`).join('')}
  </div>`;
}

function renderCreative(mount, s) {
  const dc = s.dataCompleteness || {};
  const aiUnavailReason = s.aiFailed ? s.aiFailReason : 'البيانات غير كافية للحكم بعد.';
  mount.innerHTML = `
    ${pmcDataStatus(dc.creative, 'META')}
    ${winningComponentsHtml(s.winningComponents)}
    <div class="pmc-card">
      <div class="h">${pmcIcon('image')} ذكاء الكرياتيف</div>
      <div class="pmc-angle-fields">
        <div class="f"><b>أفضل إعلان</b>${s.bestAd ? `${E(s.bestAd.name)} — CPA ${fmtEGP(s.bestAd.cpa)}` : 'البيانات غير كافية للحكم'}</div>
        <div class="f"><b>أضعف إعلان</b>${s.worstAd ? `${E(s.worstAd.name)} — CPA ${fmtEGP(s.worstAd.cpa)}` : 'البيانات غير كافية للحكم'}</div>
        <div class="f"><b>أفضل Hook مكتشف</b>${E(s.bestAd?.analysis?.hook || '—')}</div>
        <div class="f"><b>أفضل زاوية مكتشفة</b>${E(s.bestAd?.analysis?.sellingAngle || '—')}</div>
      </div>
    </div>

    <div class="pmc-winner-box">
      <div style="font-weight:800;margin-bottom:6px;">🏆 بصمة الإعلان الرابح ${pmcSourceBadge('AI')}</div>
      ${s.winnerDna?.available ? `<ul style="margin:0 0 8px;padding-inline-start:18px;">${(s.winnerDna.reasons || []).map((r) => `<li>${E(r)}</li>`).join('')}</ul><div class="faint" style="font-size:12.5px;">${E(s.winnerDna.narrative || '')}</div>
        <div class="toolbar" style="margin-top:10px;"><button class="amb-btn sm" id="pmcVariations3">3 Variations</button><button class="amb-btn sm" id="pmcVariations5">5 Variations</button><button class="amb-btn sm" id="pmcVariations10">10 Variations</button></div>`
        : `<div class="faint">${E(aiUnavailReason)}</div>`}
    </div>

    <div class="pmc-loser-box">
      <div style="font-weight:800;margin-bottom:6px;">🔬 تحليل الإعلان الضعيف ${pmcSourceBadge('AI')}</div>
      ${s.loserAutopsy?.available ? `<div class="faint" style="font-size:12.5px;">السبب الجذري: <b>${E(s.loserAutopsy.rootCause)}</b><br/>${E(s.loserAutopsy.narrative || '')}</div>` : `<div class="faint">${E(aiUnavailReason)}</div>`}
    </div>

    <div class="pmc-card">
      <div class="h">${pmcIcon('zap')} أفكار كرياتيف${state.genAngle ? ` — ${E(state.genAngle)}` : ''}</div>
      <button class="amb-btn sm primary" id="pmcGenIdeas">توليد أفكار كرياتيف</button>
      <div id="pmcIdeasBox" style="margin-top:10px;">${ideasHtml(state.ideaResult)}</div>
    </div>

    <div class="pmc-card" style="margin-top:14px;">
      <div class="h">${pmcIcon('image')} مصنع الإعلانات</div>
      <div class="faint" style="font-size:12px;margin-bottom:8px;">أرسل أفكار الكرياتيف مباشرة لمصنع الإعلانات لإنشاء الصور الفعلية.</div>
      <button class="amb-btn sm" id="pmcCfCheck">تحقق من الجاهزية</button>
      <div id="pmcCfStatus" style="margin-top:8px;"></div>
    </div>`;
  const gen3 = $('pmcVariations3'), gen5 = $('pmcVariations5'), gen10 = $('pmcVariations10');
  [gen3, gen5, gen10].forEach((b) => b && (b.onclick = () => UI.toast('الاشتقاقات هتتولد من نفس فكرة الإعلان الرابح — استخدم "أفكار كرياتيف" فوق ثم أرسلها لمصنع الإعلانات.', 'info')));
  $('pmcGenIdeas').onclick = generateIdeas;
  $('pmcCfCheck').onclick = checkCfReadiness;
}
const IDEA_STATUS_LABEL_AR = { CREATE_MORE_LIKE_THIS: '🏆 اعمل زيها أكتر', REFRESH_WINNER: '📈 جدّد الفائز', NEW_TEST: '🧪 اختبار جديد', STOP_REPEATING: '🔴 وقف التكرار' };
function ideaStatusPill(st) { return st ? `<span class="badge ${st === 'CREATE_MORE_LIKE_THIS' ? 'green' : st === 'STOP_REPEATING' ? 'red' : 'yellow'}">${E(IDEA_STATUS_LABEL_AR[st] || st)}</span>` : ''; }
function ideasHtml(ideas) {
  if (!ideas?.length) return '';
  return ideas.map((idea) => `<div class="pmc-idea-item">
    <div class="t">${E(idea.type)} ${ideaStatusPill(idea.status)}</div>
    <div class="f"><b>المشهد:</b> ${E(idea.scene)}</div>
    <div class="f"><b>Hook:</b> ${E(idea.hook)}</div>
    <div class="f"><b>مكان المنتج:</b> ${E(idea.productPlacement)}</div>
    <div class="f"><b>النص الأساسي:</b> ${E(idea.mainText)}</div>
    <div class="f"><b>CTA:</b> ${E(idea.cta)}</div>
    <div class="f"><b>الجمهور المستهدف:</b> ${E(idea.targetAudience)}</div>
    <div class="f faint">${E(idea.whyItCouldWork)}</div>
  </div>`).join('');
}
async function generateIdeas() {
  const box = $('pmcIdeasBox'); if (box) box.innerHTML = '<div class="pmc-empty">🤖 بنولّد أفكار كرياتيف…</div>';
  try {
    const r = await api.post(`/api/product-marketing/profiles/${state.profile.id}/creative-ideas`, { angle: state.genAngle, count: 4 });
    state.ideaResult = r.ok ? r.ideas : null;
    if (!r.ok) UI.toast(r.reason || 'تعذّر توليد الأفكار.', 'error');
  } catch (e) { UI.toast(e.message, 'error'); state.ideaResult = null; }
  if (box) box.innerHTML = ideasHtml(state.ideaResult) || '<div class="pmc-empty">تعذّر التوليد.</div>';
}
async function checkCfReadiness() {
  const box = $('pmcCfStatus');
  try {
    const r = await api.get(`/api/product-marketing/profiles/${state.profile.id}/creative-factory-readiness`);
    box.innerHTML = r.ready ? `<span class="badge green">✅ جاهز — <a href="creative-factory.html">افتح مصنع الإعلانات</a></span>` : `<span class="badge gray">${E(r.reason)}</span>`;
  } catch (e) { box.innerHTML = `<span class="badge red">${E(e.message)}</span>`; }
}

// ---- §15/§16 — Hook Lab & Post Generator ----
function renderHooksTab(mount, s) {
  mount.innerHTML = `
    <div class="pmc-section-badge data-backed">${pmcIcon('check')} أداء حقيقي</div>
    <div class="pmc-card" style="margin-bottom:14px;">
      <div class="h">${pmcIcon('zap')} أداء الـ Hooks الحقيقي (من الإعلانات الجارية فعليًا)</div>
      ${pmcDataStatus(s.dataCompleteness?.hooks, 'META')}
      ${winnerIntelTableHtml(s.hookIntel, 'لا توجد بيانات إعلانات حقيقية كفاية لتصنيف الـ Hooks بعد.')}
    </div>
    <div class="pmc-card">
      <div class="h">${pmcIcon('zap')} مختبر الـ Hooks ${pmcSourceBadge('AI')}</div>
      <div class="toolbar" style="margin-bottom:10px;">
        <input class="amb-input sm" id="pmcAngleInput" placeholder="الزاوية (اختياري)" value="${E(state.genAngle)}" />
        <select class="amb-select sm" id="pmcHookCount"><option value="5">5</option><option value="10" selected>10</option><option value="20">20</option></select>
        <button class="amb-btn sm primary" id="pmcGenHooks">توليد Hooks</button>
      </div>
      <div id="pmcHooksBox">${hooksHtml(state.hookResult)}</div>
    </div>
    <div class="pmc-card" style="margin-top:14px;">
      <div class="h">📝 مولد البوستات</div>
      <div class="toolbar" style="margin-bottom:10px;">
        <select class="amb-select sm" id="pmcToneSelect">
          ${['مباشر', 'فضولي', 'Problem/Solution', 'عائلي', 'Premium', 'شبابي', 'هدية', 'Demonstration', 'بسيط'].map((t) => `<option ${state.genTone === t ? 'selected' : ''}>${E(t)}</option>`).join('')}
        </select>
        <button class="amb-btn sm primary" id="pmcGenPost">توليد بوست</button>
      </div>
      <div id="pmcPostBox">${postHtml(state.postResult)}</div>
    </div>
    <div class="pmc-card" style="margin-top:14px;">
      <div class="h">📦 حزمة اختبار بضغطة واحدة</div>
      <div class="faint" style="font-size:12px;margin-bottom:8px;">5 Hooks + بوست + 3 أفكار كرياتيف لنفس الزاوية، جاهزين للإرسال لمصنع الإعلانات.</div>
      <button class="amb-btn sm primary" id="pmcGenPack">إنشاء حزمة اختبار</button>
      <div id="pmcPackBox" style="margin-top:10px;"></div>
    </div>`;
  $('pmcAngleInput').oninput = (e) => { state.genAngle = e.target.value; };
  $('pmcGenHooks').onclick = () => generateHooks(Number($('pmcHookCount').value));
  $('pmcGenPost').onclick = () => generatePost($('pmcToneSelect').value);
  $('pmcGenPack').onclick = generateTestPack;
}
function hooksHtml(hooks) {
  if (!hooks?.length) return '';
  return hooks.map((h) => `<div class="pmc-hook-item">${E(h.text)} ${claimPill(h.claimStatus, h.claimReason)}<div class="faint" style="font-size:11px;">${E(h.category || '')}</div></div>`).join('');
}
const POST_STATUS_LABEL_AR = { WINNING_COPY: '🏆 نص فائز', VARIATION: '📈 نسخة معدّلة', NEW_TEST: '🧪 اختبار جديد' };
function postStatusPill(st) { return st ? `<span class="badge ${st === 'WINNING_COPY' ? 'green' : 'yellow'}">${E(POST_STATUS_LABEL_AR[st] || st)}</span>` : ''; }
function postHtml(post) {
  if (!post) return '';
  return `<div class="pmc-hook-item">
    <div>${postStatusPill(post.status)}</div>
    <div><b>Headline:</b> ${E(post.headline)}</div>
    <div style="margin-top:6px;"><b>قصير:</b> ${E(post.short)}</div>
    <div style="margin-top:6px;"><b>متوسط:</b> ${E(post.medium)}</div>
    <div style="margin-top:6px;"><b>طويل:</b> ${E(post.long)}</div>
    <div style="margin-top:6px;"><b>CTA:</b> ${E(post.cta)}</div>
    <div style="margin-top:6px;">${claimPill(post.claimStatus, post.claimReason)}</div>
  </div>`;
}
async function generateHooks(count = 10) {
  const box = $('pmcHooksBox'); if (box) box.innerHTML = '<div class="pmc-empty">🤖 بنولّد Hooks…</div>';
  try {
    const r = await api.post(`/api/product-marketing/profiles/${state.profile.id}/hooks`, { angle: state.genAngle, category: state.genCategory, count });
    state.hookResult = r.ok ? r.hooks : null;
    if (!r.ok) UI.toast(r.reason || 'تعذّر توليد الـ Hooks.', 'error');
  } catch (e) { UI.toast(e.message, 'error'); state.hookResult = null; }
  if (box) box.innerHTML = hooksHtml(state.hookResult) || '<div class="pmc-empty">تعذّر التوليد.</div>';
}
async function generatePost(tone = state.genTone) {
  state.genTone = tone;
  const box = $('pmcPostBox'); if (box) box.innerHTML = '<div class="pmc-empty">🤖 بنكتب البوست…</div>';
  try {
    const r = await api.post(`/api/product-marketing/profiles/${state.profile.id}/posts`, { angle: state.genAngle, tone });
    state.postResult = r.ok ? r.post : null;
    if (!r.ok) UI.toast(r.reason || 'تعذّر توليد البوست.', 'error');
  } catch (e) { UI.toast(e.message, 'error'); state.postResult = null; }
  if (box) box.innerHTML = postHtml(state.postResult) || '<div class="pmc-empty">تعذّر التوليد.</div>';
}
async function generateTestPack() {
  const box = $('pmcPackBox'); box.innerHTML = '<div class="pmc-empty">🤖 بنجهّز حزمة الاختبار…</div>';
  try {
    const pack = await api.post(`/api/product-marketing/profiles/${state.profile.id}/test-pack`, { angle: state.genAngle });
    box.innerHTML = `<div class="section-title" style="font-size:13px;">Hooks</div>${hooksHtml(pack.hooks) || '<div class="pmc-empty">—</div>'}
      <div class="section-title" style="font-size:13px;margin-top:10px;">بوست</div>${postHtml(pack.post) || '<div class="pmc-empty">—</div>'}
      <div class="section-title" style="font-size:13px;margin-top:10px;">أفكار كرياتيف</div>${ideasHtml(pack.ideas) || '<div class="pmc-empty">—</div>'}`;
  } catch (e) { UI.toast(e.message, 'error'); box.innerHTML = '<div class="pmc-empty">تعذّر إنشاء الحزمة.</div>'; }
}

// ---- §6/§8 — Markets & Areas (real Easy Orders governorate economics) ----
/** Phase 4 — summary tiles computed client-side from the SAME already-loaded rows array (no new query); each is only shown when the underlying real value exists. */
function marketsSummaryHtml(rows, rich) {
  if (!rows.length) return '';
  const byDelivered = [...rows].sort((a, b) => (b.delivered || 0) - (a.delivered || 0))[0];
  const byOrders = [...rows].sort((a, b) => (b.orders || 0) - (a.orders || 0))[0];
  const withRate = rows.filter((r) => r.deliveryRate != null);
  const byRate = withRate.length ? [...withRate].sort((a, b) => b.deliveryRate - a.deliveryRate)[0] : null;
  const withRevenue = rich ? rows.filter((r) => r.revenue != null) : [];
  const byRevenue = withRevenue.length ? [...withRevenue].sort((a, b) => b.revenue - a.revenue)[0] : null;
  const tiles = [
    byDelivered?.delivered ? kpiCard('check', 'green', 'أفضل محافظة (استلام)', E(byDelivered.government)) : '',
    byRate ? kpiCard('percent', 'cyan', 'أعلى معدل استلام', `${E(byRate.government)} — ${fmtPct1(byRate.deliveryRate)}`) : '',
    byRevenue ? kpiCard('coin', 'yellow', 'أعلى إيراد', `${E(byRevenue.government)} — ${fmtEGP(byRevenue.revenue)}`) : '',
    byOrders?.orders ? kpiCard('cart', 'purple', 'أكبر عدد طلبات', `${E(byOrders.government)} — ${fmtNum(byOrders.orders)}`) : '',
  ].filter(Boolean);
  return tiles.length ? `<div class="pmc-kpi-row">${tiles.join('')}</div>` : '';
}
/** Mobile card view for the SAME governorate rows the desktop table shows — no new data, just a second display format shown only ≤768px (table shown only >768px, see .pmc-loc-table/.pmc-loc-cards CSS). */
function locationCardHtml(l, rich) {
  return `<div class="pmc-loc-card">
    <div class="pmc-loc-card-head"><span>${E(l.government)}</span>${rich ? marketBandPill(l.band) : ''}</div>
    <div class="pmc-loc-card-grid">
      <div class="kv"><span>الطلبات</span><b>${fmtNum(l.orders)}</b></div>
      <div class="kv"><span>مؤكدة</span><b>${fmtNum(l.confirmed)}</b></div>
      <div class="kv"><span>مُستلمة</span><b>${fmtNum(l.delivered)}</b></div>
      <div class="kv"><span>معدل الاستلام</span><b>${fmtPct1(l.deliveryRate)}</b></div>
    </div>
    ${rich ? `<details class="pmc-loc-details">
      <summary>عرض التفاصيل</summary>
      <div class="pmc-loc-card-grid" style="margin-top:8px;">
        <div class="kv"><span>مرتجعة</span><b>${fmtNum(l.returned)}</b></div>
        <div class="kv"><span>الإيراد</span><b>${fmtEGP(l.revenue)}</b></div>
        <div class="kv"><span>متوسط الطلب</span><b>${l.aov != null ? fmtEGP(l.aov) : '—'}</b></div>
        <div class="kv"><span>عملاء</span><b>${fmtNum(l.customerCount)}</b></div>
        <div class="kv"><span>متكررين</span><b>${fmtNum(l.repeatCustomerCount)}</b></div>
      </div>
    </details>` : ''}
  </div>`;
}
function renderLocations(mount, s) {
  const markets = s.markets || [];
  const rows = markets.length ? markets : (s.locations || []); // old cached snapshots without markets_json yet fall back gracefully
  const rich = markets.length > 0;
  mount.innerHTML = `
    ${pmcDataStatus(s.dataCompleteness?.geography, 'EASY_ORDERS')}
    <div class="faint" style="font-size:11px;margin:-4px 0 10px;">هذا توزيع جغرافي من عناوين طلبات Easy Orders الحقيقية فقط — مش توزيع جمهور Meta الإعلاني. توزيع الجمهور الجغرافي من Meta (دولة/منطقة) موجود منفصل في تبويب "الجمهور والأسواق".</div>
    ${marketsSummaryHtml(rows, rich)}
    <div class="pmc-card">
      <div class="h">${pmcIcon('mappin')} الأسواق والمناطق — ${E(s.metrics?.windowLabel || '')}</div>
      <div class="faint" style="font-size:11.5px;margin-bottom:10px;">الترتيب حسب: الطلبات المُستلمة فعليًا أولًا، ثم معدل الاستلام — مش عدد المشتريات على Meta فقط (مناسب لأوردرات الدفع عند الاستلام). لا يوجد تصنيف "وسّع" لمجرد ارتفاع عدد الطلبات — لازم معدل استلام حقيقي كمان.</div>
      ${rows.length ? `<div class="table-wrap pmc-table-premium pmc-loc-table-wrap"><table class="data pmc-loc-table">
        <thead><tr><th>المحافظة</th><th>الطلبات</th><th>مؤكدة</th><th>مُستلمة</th><th>مرتجعة</th><th>معدل الاستلام</th>${rich ? '<th>الإيراد</th><th>متوسط الطلب</th><th>عملاء</th><th>متكررين</th><th>التصنيف</th>' : ''}</tr></thead>
        <tbody>${rows.map((l) => `<tr><td>${E(l.government)}</td><td>${fmtNum(l.orders)}</td><td>${fmtNum(l.confirmed)}</td><td>${fmtNum(l.delivered)}</td><td>${fmtNum(l.returned)}</td><td>${fmtPct1(l.deliveryRate)}</td>${rich ? `<td>${fmtEGP(l.revenue)}</td><td>${l.aov != null ? fmtEGP(l.aov) : '—'}</td><td>${fmtNum(l.customerCount)}</td><td>${fmtNum(l.repeatCustomerCount)}</td><td>${marketBandPill(l.band)}</td>` : ''}</tr>`).join('')}</tbody>
      </table></div>
      <div class="pmc-loc-cards">${rows.map((l) => locationCardHtml(l, rich)).join('')}</div>` : `<div class="pmc-empty">${E(s.metrics?.dataAvailability?.codMessage || 'لا توجد طلبات مسجّلة بعنوان محافظة في هذه الفترة.')}</div>`}
      ${s.locationCommentary ? `<div class="faint" style="font-size:12px;margin-top:10px;">${E(s.locationCommentary)}</div>` : ''}
    </div>`;
}

// ---- §18 — Competitors ----
async function renderCompetitors(mount, s) {
  mount.innerHTML = '<div class="pmc-empty">بنحمّل بيانات المنافسين…</div>';
  if (!state.competitors) {
    try { state.competitors = await api.get(`/api/product-marketing/profiles/${state.profile.id}/competitors`); }
    catch (e) { state.competitors = { available: false, reason: e.message }; }
  }
  const c = state.competitors;
  if (!c.available) { mount.innerHTML = `${pmcDataStatus({ status: 'MISSING', reason: c.reason }, 'RESEARCH')}<div class="pmc-empty">${E(c.reason)}${c.reason?.includes('البحث') ? ' — <a href="product-research.html">افتح صفحة البحث عن المنتجات</a>' : ''}</div>`; return; }
  const gaps = s.marketGaps;
  mount.innerHTML = `
    ${pmcDataStatus({ status: 'AVAILABLE', reason: 'بيانات من صفحة "البحث عن المنتجات" الحالية.' }, 'RESEARCH')}
    <div class="pmc-card">
      <div class="h">${pmcIcon('barchart')} تحليل المنافسين</div>
      <div class="faint" style="font-size:11.5px;margin-bottom:10px;">بيانات من صفحة "البحث عن المنتجات" الحالية — مفيش بحث جديد بيتعمل هنا.</div>
      ${c.competitors.map((cc) => `<div class="pmc-competitor-card">
        <span class="pmc-competitor-ic">${pmcIcon('users')}</span>
        <div class="pmc-competitor-body">
          <div class="pmc-competitor-name">${E(cc.accountName || cc.accountUrl)}</div>
          <div class="pmc-competitor-meta">${E(cc.platform)}${cc.country ? ` · ${E(cc.country)}` : ''}${cc.accountUrl ? ` · <a href="${E(cc.accountUrl)}" target="_blank" rel="noopener">${pmcIcon('link')}</a>` : ''}</div>
        </div>
        <div class="pmc-competitor-stat"><b>${cc.followerCount != null ? fmtNum(cc.followerCount) : '—'}</b><span>متابع</span></div>
      </div>`).join('')}
    </div>
    <div class="pmc-card" style="margin-top:14px;">
      <div class="h" style="display:flex;justify-content:space-between;align-items:center;">
        <span>🎯 فجوات السوق المحتملة</span>
        <button class="amb-btn sm" id="pmcGenGaps">${gaps?.gaps?.length ? '🔄 إعادة التوليد' : '🤖 توليد فجوات السوق'}</button>
      </div>
      <div class="faint" style="font-size:11px;margin-bottom:8px;">استنتاج ذكاء اصطناعي مبني على البيانات الحقيقية أعلاه — مش حقيقة مؤكدة.</div>
      <div id="pmcGapsBox">${gaps?.gaps?.length ? gaps.gaps.map((g) => `<div class="pmc-diag-item"><div class="dot INFO"></div><div><div class="t">${E(g.gap)} ${confPill(g.confidence)}</div><div class="e">${E(g.interpretation)}</div></div></div>`).join('') : '<div class="pmc-empty" style="padding:10px;">لسه ما اتولّدش فجوات سوق لهذا المنتج.</div>'}</div>
    </div>`;
  $('pmcGenGaps').onclick = async () => {
    const box = $('pmcGapsBox'); box.innerHTML = '<div class="pmc-empty">🤖 بنحلل فجوات السوق…</div>';
    try {
      const result = await api.post(`/api/product-marketing/profiles/${state.profile.id}/market-gaps`, { window: state.windowName, force: true });
      s.marketGaps = result;
      box.innerHTML = result.gaps?.length ? result.gaps.map((g) => `<div class="pmc-diag-item"><div class="dot INFO"></div><div><div class="t">${E(g.gap)} ${confPill(g.confidence)}</div><div class="e">${E(g.interpretation)}</div></div></div>`).join('') : '<div class="pmc-empty" style="padding:10px;">مفيش فجوات واضحة من البيانات الحالية.</div>';
    } catch (e) { UI.toast(e.message, 'error'); box.innerHTML = '<div class="pmc-empty">تعذّر التوليد.</div>'; }
  };
}

// ---- §17-20 — Testing Lab (real, persisted experiments) ----
const TEST_TYPE_LABEL_AR = { AUDIENCE: 'جمهور', HOOK: 'Hook', SELLING_ANGLE: 'زاوية بيع', CREATIVE: 'كرياتيف', OFFER: 'عرض', COPY: 'نص إعلاني', MARKET_AREA: 'سوق/منطقة', PRICE: 'سعر' };
const TEST_STATUS_LABEL_AR = { PLANNED: 'مخطَّط', RUNNING: 'جاري', COMPLETED: 'مكتمل', STOPPED: 'مُتوقف', INCONCLUSIVE: 'غير حاسم' };
const TEST_CLASSIFICATION_LABEL_AR = { WINNER: '🏆 فائز', LOSER: '🔴 خاسر', NEUTRAL: '➖ محايد', INCONCLUSIVE: '⚪ غير حاسم' };

async function loadLabTests() {
  state.labTestsLoading = true;
  try { state.labTests = (await api.get(`/api/product-marketing/profiles/${state.profile.id}/tests`)).tests; }
  catch (e) { UI.toast(e.message, 'error'); state.labTests = []; }
  state.labTestsLoading = false;
  renderTabBody();
}

function testingLabFormHtml() {
  if (!state.labNewTestOpen) return '';
  return `<div class="pmc-card" style="margin:10px 0;background:var(--amb-bg-2,transparent);">
    <div class="h" style="font-size:13px;">اختبار جديد</div>
    <div class="pmc-lab-grid">
      <select class="amb-select sm" id="labType">${Object.entries(TEST_TYPE_LABEL_AR).map(([k, v]) => `<option value="${k}">${E(v)}</option>`).join('')}</select>
      <select class="amb-select sm" id="labPriority"><option value="P0">P0 — حرج</option><option value="P1">P1</option><option value="P2" selected>P2</option><option value="P3">P3</option></select>
      <input class="amb-input sm" id="labSuccessMetric" placeholder="مقياس النجاح (مثال: ctr, cpa, deliveredCpa)" />
      <input class="amb-input sm" id="labBudget" type="number" placeholder="ميزانية مقترحة (اختياري)" />
    </div>
    <textarea class="amb-input" id="labHypothesis" placeholder="الفرضية — ليه نتوقع إن ده هيشتغل؟" style="margin-top:8px;min-height:50px;"></textarea>
    <div class="pmc-lab-grid" style="margin-top:8px;">
      <input class="amb-input sm" id="labControl" placeholder="Control (الحالي)" />
      <input class="amb-input sm" id="labVariation" placeholder="Variation (الجديد)" />
    </div>
    <input class="amb-input sm" id="labVariable" placeholder="المتغيّر اللي بنغيّره (مثال: Hook، الجمهور، السعر)" style="margin-top:8px;" />
    <div class="toolbar" style="margin-top:10px;">
      <button class="amb-btn sm primary" id="labCreateBtn">إنشاء الاختبار</button>
      <button class="amb-btn sm ghost" id="labCancelBtn">إلغاء</button>
    </div>
  </div>`;
}

async function createLabTest() {
  const btn = $('labCreateBtn');
  const hypothesis = $('labHypothesis').value.trim();
  const variable = $('labVariable').value.trim();
  const control = $('labControl').value.trim();
  const variation = $('labVariation').value.trim();
  const successMetric = $('labSuccessMetric').value.trim();
  if (!hypothesis || !variable || !control || !variation || !successMetric) { UI.toast('لازم تملأ الفرضية والمتغيّر والـControl والـVariation ومقياس النجاح.', 'error'); return; }
  btn.disabled = true; btn.textContent = 'جارِ الإنشاء…';
  try {
    await api.post(`/api/product-marketing/profiles/${state.profile.id}/tests`, {
      testType: $('labType').value, hypothesis, variable, control, variation, successMetric,
      recommendedBudget: $('labBudget').value ? Number($('labBudget').value) : undefined,
      priority: $('labPriority').value,
    });
    UI.toast('تم إنشاء الاختبار.', 'success');
    state.labNewTestOpen = false;
    await loadLabTests();
  } catch (e) { UI.toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'إنشاء الاختبار'; }
}

async function setLabTestStatus(testId, status) {
  state.labBusyId = testId; renderTabBody();
  try { await api.post(`/api/product-marketing/profiles/${state.profile.id}/tests/${testId}/status`, { status }); await loadLabTests(); }
  catch (e) { UI.toast(e.message, 'error'); state.labBusyId = null; renderTabBody(); }
}

function testCardHtml(t) {
  const busy = state.labBusyId === t.id;
  return `<div class="pmc-idea-item">
    <div class="t">${E(TEST_TYPE_LABEL_AR[t.testType] || t.testType)} — ${E(TEST_STATUS_LABEL_AR[t.status] || t.status)} ${priorityPill(t.priority)}</div>
    <div class="f"><b>الفرضية:</b> ${E(t.hypothesis)}</div>
    <div class="f"><b>Control → Variation:</b> ${E(t.control)} → ${E(t.variation)}</div>
    <div class="f"><b>مقياس النجاح:</b> ${E(t.successMetric)}</div>
    ${t.results?.length ? `<div class="f"><b>آخر نتيجة:</b> ${E(TEST_CLASSIFICATION_LABEL_AR[t.results[0].classification] || t.results[0].classification)}${t.results[0].whatDidWeLearn ? ` — ${E(t.results[0].whatDidWeLearn)}` : ''}</div>` : ''}
    <div class="toolbar" style="margin-top:8px;">
      ${t.status === 'PLANNED' ? `<button class="amb-btn sm" data-lab-start="${t.id}" ${busy ? 'disabled' : ''}>ابدأ التشغيل</button>` : ''}
      ${t.status === 'RUNNING' ? `<button class="amb-btn sm" data-lab-result="${t.id}" ${busy ? 'disabled' : ''}>تسجيل نتيجة</button><button class="amb-btn sm ghost" data-lab-stop="${t.id}" ${busy ? 'disabled' : ''}>إيقاف</button>` : ''}
    </div>
    <div id="labResultForm-${t.id}"></div>
  </div>`;
}

function resultFormHtml(testId) {
  return `<div class="pmc-lab-grid" style="margin-top:8px;">
    <input class="amb-input sm" id="labResFrom-${testId}" type="date" />
    <input class="amb-input sm" id="labResTo-${testId}" type="date" />
    <input class="amb-input sm" id="labResSpend-${testId}" type="number" placeholder="الصرف" />
    <input class="amb-input sm" id="labResPurchases-${testId}" type="number" placeholder="مشتريات Meta" />
    <input class="amb-input sm" id="labResMetric-${testId}" type="number" placeholder="قيمة المقياس الفعلية" />
    <input class="amb-input sm" id="labResControl-${testId}" type="number" placeholder="قيمة الـControl للمقارنة" />
  </div>
  <textarea class="amb-input sm" id="labResLearn-${testId}" placeholder="إيه اللي اتعلمناه؟" style="margin-top:6px;"></textarea>
  <div class="toolbar" style="margin-top:6px;"><button class="amb-btn sm primary" data-lab-submit-result="${testId}">حفظ النتيجة</button></div>`;
}

async function submitLabResult(testId) {
  const from = $(`labResFrom-${testId}`).value, to = $(`labResTo-${testId}`).value;
  if (!from || !to) { UI.toast('لازم تحدد فترة الاختبار.', 'error'); return; }
  const metricName = $(`labResMetric-${testId}`).closest('.pmc-idea-item')?.querySelector('.f')?.textContent || '';
  const test = (state.labTests || []).find((t) => t.id === testId);
  const metrics = { spend: Number($(`labResSpend-${testId}`).value) || undefined, metaPurchases: Number($(`labResPurchases-${testId}`).value) || undefined };
  if (test) metrics[test.successMetric] = Number($(`labResMetric-${testId}`).value);
  try {
    await api.post(`/api/product-marketing/profiles/${state.profile.id}/tests/${testId}/results`, {
      window: { from, to }, metrics, controlValue: Number($(`labResControl-${testId}`).value) || undefined,
      whatDidWeLearn: $(`labResLearn-${testId}`).value.trim() || undefined,
    });
    UI.toast('تم تسجيل النتيجة.', 'success');
    await loadLabTests();
  } catch (e) { UI.toast(e.message, 'error'); }
}

function wireTestingLab(mount) {
  $('labNewTestBtn')?.addEventListener('click', () => { state.labNewTestOpen = true; renderTabBody(); });
  $('labCancelBtn')?.addEventListener('click', () => { state.labNewTestOpen = false; renderTabBody(); });
  $('labCreateBtn')?.addEventListener('click', createLabTest);
  mount.querySelectorAll('[data-lab-start]').forEach((b) => b.onclick = () => setLabTestStatus(Number(b.dataset.labStart), 'RUNNING'));
  mount.querySelectorAll('[data-lab-stop]').forEach((b) => b.onclick = () => setLabTestStatus(Number(b.dataset.labStop), 'STOPPED'));
  mount.querySelectorAll('[data-lab-result]').forEach((b) => b.onclick = () => {
    const id = Number(b.dataset.labResult);
    $(`labResultForm-${id}`).innerHTML = resultFormHtml(id);
    $(`labResultForm-${id}`).querySelector('[data-lab-submit-result]').onclick = () => submitLabResult(id);
  });
}

// ---- §21/§22/§24 — Tests & Results (real Testing Lab + memory + actions log) ----
/** Phase 5 — groups the SAME real test list by its real status into a clearer "experimentation center" look; testCardHtml/wireTestingLab are completely unchanged. */
function labListGroupedHtml(tests) {
  if (!tests?.length) return '<div class="pmc-empty" style="padding:10px;">مفيش اختبارات مسجّلة لهذا المنتج بعد.</div>';
  const groups = [
    { label: 'جارية الآن', match: (t) => t.status === 'RUNNING' },
    { label: 'مخطَّطة', match: (t) => t.status === 'PLANNED' },
    { label: 'مكتملة / منتهية', match: (t) => ['COMPLETED', 'STOPPED', 'INCONCLUSIVE'].includes(t.status) },
  ];
  return groups.map((g) => {
    const items = tests.filter(g.match);
    if (!items.length) return '';
    return `<div class="pmc-section-badge">${E(g.label)} (${items.length})</div>${items.map(testCardHtml).join('')}`;
  }).join('') || tests.map(testCardHtml).join('');
}
/** Phase D — auto-computed campaign/ad leaderboard from the SAME real Meta
 * data already gathered for Creatives/Angles/Hooks (bestAd/worstAd,
 * winningComponents) — no new backend call. Distinct from the manual
 * Testing Lab below it: this is "what already won/lost", not "what you're
 * about to test". Never invents a winner — every row only appears when the
 * underlying real metric exists. */
function realResultsLeaderboardHtml(s) {
  const rows = [
    s.bestAd && ['🏆 أفضل إعلان (أقل CPA)', s.bestAd.name, [`CPA ${fmtEGP(s.bestAd.cpa)}`, `مشتريات ${fmtNum(s.bestAd.purchases)}`, s.bestAd.ctr != null ? `CTR ${s.bestAd.ctr.toFixed(1)}%` : null, `صرف ${fmtEGP(s.bestAd.spend)}`].filter(Boolean).join(' · ')],
    s.worstAd && ['🔻 أضعف إعلان (أعلى CPA)', s.worstAd.name, [`CPA ${fmtEGP(s.worstAd.cpa)}`, `مشتريات ${fmtNum(s.worstAd.purchases)}`, s.worstAd.ctr != null ? `CTR ${s.worstAd.ctr.toFixed(1)}%` : null, `صرف ${fmtEGP(s.worstAd.spend)}`].filter(Boolean).join(' · ')],
    s.winningComponents?.bestMarket && ['🏆 أفضل سوق', s.winningComponents.bestMarket.government, s.winningComponents.bestMarket.why],
    s.winningComponents?.bestHook && ['🏆 أفضل Hook', s.winningComponents.bestHook.label, s.winningComponents.bestHook.why],
    s.winningComponents?.bestSellingAngle && ['🏆 أفضل زاوية بيع', s.winningComponents.bestSellingAngle.label, s.winningComponents.bestSellingAngle.why],
  ].filter(Boolean);
  const dc = s.dataCompleteness || {};
  return `<div class="pmc-card" style="margin-bottom:14px;">
    <div class="h">${pmcIcon('barchart')} نتائج حقيقية — أفضل/أضعف أداء حاليًا</div>
    ${pmcDataStatus(dc.creative, 'META')}
    ${rows.length ? rows.map(([label, value, detail]) => `<div class="pmc-kv"><span>${E(label)}</span><b>${E(value)}</b></div><div class="faint" style="font-size:11px;margin:0 0 8px;">${E(detail || '')}</div>`).join('')
      : `<div class="pmc-empty">${E(dc.creative?.reason || 'لا يوجد إعلان بأداء كافٍ لتحديد فائز/خاسر بعد.')}</div>`}
  </div>`;
}
async function renderTests(mount, s) {
  mount.innerHTML = `
    ${realResultsLeaderboardHtml(s)}
    <div class="pmc-card">
      <div class="h" style="display:flex;justify-content:space-between;align-items:center;">
        <span>${pmcIcon('flask')} مختبر الاختبارات ${pmcSourceBadge('CATALOG')}</span>
        ${!state.labNewTestOpen ? '<button class="amb-btn sm primary" id="labNewTestBtn">+ اختبار جديد</button>' : ''}
      </div>
      <div class="faint" style="font-size:11.5px;margin-bottom:8px;">سجل اختبارات يدوي تضيفه بنفسك — منفصل عن لوحة النتائج الحقيقية فوق.</div>
      ${testingLabFormHtml()}
      <div id="pmcLabList">${state.labTestsLoading ? '<div class="pmc-empty">بنحمّل الاختبارات…</div>' : labListGroupedHtml(state.labTests)}</div>
    </div>
    <div class="pmc-card" style="margin-top:14px;">
      <div class="h">⚡ سجل التوصيات</div>
      ${actionsListHtml(s.actions)}
    </div>
    <div class="pmc-card" style="margin-top:14px;">
      <div class="h">🧠 الذاكرة التسويقية الذاتية التعلّم</div>
      <div id="pmcMemoryBox" class="pmc-empty">بنحمّل السجل…</div>
    </div>`;
  wireActionButtons(mount);
  wireTestingLab(mount);
  if (!state.labTests && !state.labTestsLoading) loadLabTests();
  try {
    const { entries } = await api.get(`/api/product-marketing/profiles/${state.profile.id}/memory`);
    $('pmcMemoryBox').outerHTML = entries.length ? entries.map((m) => `<div class="pmc-memory-item">
      <div class="lbl">${E(m.field)}</div>
      <div><b>الافتراض السابق:</b> ${E(JSON.stringify(m.previous))}</div>
      <div><b>الدليل الجديد:</b> ${E(m.evidence)}</div>
      <div><b>التوصية الجديدة:</b> ${E(JSON.stringify(m.new))}</div>
    </div>`).join('') : '<div class="pmc-empty" id="pmcMemoryBox">مفيش تغييرات في الافتراضات لسه — لسه أول تحليل لهذا المنتج.</div>';
  } catch { /* memory is best-effort */ }
}

// ---- §24 — AI Product Marketing Strategist (on-demand — own AI call) ----
function strategistAnswersHtml(answers) {
  if (!answers?.length) return '<div class="pmc-empty" style="padding:10px;">لسه ما اتولّدش استشارة لهذا المنتج.</div>';
  return answers.map((a) => `<div class="pmc-advisor-card">
    <span class="pmc-advisor-ic">${pmcIcon('lightbulb')}</span>
    <div class="pmc-advisor-body">
      <div class="t">${E(a.question)} ${statusPill(a.status)}</div>
      <div class="e">${E(a.answer)}</div>
    </div>
  </div>`).join('');
}
function renderStrategist(mount, s) {
  const answers = s.strategist?.answers || [];
  mount.innerHTML = `
    <div class="pmc-card">
      <div class="h" style="display:flex;justify-content:space-between;align-items:center;">
        <span>${pmcIcon('lightbulb')} المستشار الذكي للتسويق</span>
        <button class="amb-btn sm primary" id="pmcGenStrategist">${answers.length ? '🔄 إعادة الاستشارة' : '🤖 اطلب استشارة'}</button>
      </div>
      <div id="pmcStrategistBox">${strategistAnswersHtml(answers)}</div>
    </div>`;
  $('pmcGenStrategist').onclick = async () => {
    const box = $('pmcStrategistBox'); box.innerHTML = '<div class="pmc-empty">🤖 بنجهّز الاستشارة…</div>';
    try {
      const result = await api.post(`/api/product-marketing/profiles/${state.profile.id}/strategist`, { window: state.windowName, force: true });
      s.strategist = result;
      box.innerHTML = strategistAnswersHtml(result.answers);
    } catch (e) { UI.toast(e.message, 'error'); box.innerHTML = '<div class="pmc-empty">تعذّر توليد الاستشارة.</div>'; }
  };
}

document.addEventListener('DOMContentLoaded', init);
