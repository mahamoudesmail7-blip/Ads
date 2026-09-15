// Easy Orders Catalog Sync — "مزامنة كتالوج Easy Orders". Page controller
// for easyorders-catalog-sync.html. Isolated module, same shared api-client
// every other AMB/PMC page uses. Purpose: the Product Matching fix
// (services/easyOrders.js's matchProduct — SKU then exact normalized name)
// only resolves an order to a Product that ALREADY EXISTS internally; most
// of a real store's catalog gaps turn out to be products that were never
// entered at all (confirmed against Trendy Store's real catalog: 16 of 20
// products had no internal counterpart whatsoever). This page closes that
// gap with an admin-reviewed creation flow (single or multi-select, NEVER
// automatic) that talks to the dedicated, idempotent
// POST /api/product-marketing/easy-orders/catalog-audit/create endpoint —
// which re-derives name/price from EasyOrders' own real catalog server-side
// and re-checks for an existing exact-name match immediately before
// inserting, so this page's own state is never the source of truth for
// whether something already exists. Once a product is created under the
// same (suffix-stripped) name, the already-deployed exact-name matching
// picks up every future order for it automatically — no further action, no
// code change, ever needed per product again. Any NEW product added to the
// real Easy Orders store later shows up here as MISSING the next time this
// page (re)loads, since it always re-fetches the live catalog — nothing
// here is hardcoded to today's 20 products.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const E = (s) => UI.escapeHtml(String(s ?? ''));
const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  stores: null, storesLoading: true, storesError: null,
  storeId: null, storeSelectorOpen: false,
  audit: null, auditLoading: false, auditError: null,
  drafts: {}, // eoId -> edited display name (price is never editable — always EasyOrders' own real value)
  selected: {}, // eoId -> bool, for the "إنشاء المنتجات المحددة" bulk action
  busyEoIds: new Set(), // rows with an in-flight single-create request
  batchBusy: false,
  lastSyncSummary: null, // the last create call's {created, skippedExists, ambiguous, invalidName, notFound, inProgress, failed} + the fresh post-create MISSING/AMBIGUOUS counts
};

async function init() {
  try { state.me = await api.get('/api/auth/me'); } catch { /* redirected by api-client on 401 */ }
  renderNav();
  UI.mountAmbMobileNav('مزامنة الكتالوج');
  render();
  await loadStores();
  await loadAudit(); // auto-audit as soon as the page opens — no manual trigger needed
}

async function loadStores() {
  state.storesLoading = true; state.storesError = null;
  render();
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

async function loadAudit() {
  state.auditLoading = true; state.auditError = null;
  render();
  try {
    // force_refresh=true always — this page's whole purpose is catching a
    // product added on Easy Orders moments ago, so it must never show the
    // shared 1h cache's stale snapshot (Product Marketing Center's own
    // picker keeps using that cache untouched — this is a per-call bypass,
    // not a global cache disable).
    const r = await api.get('/api/product-marketing/easy-orders/catalog-audit', { ...(state.storeId ? { store_id: state.storeId } : {}), force_refresh: true });
    state.audit = r;
    if (!r.ok) state.auditError = r.error || 'تعذر جلب كتالوج Easy Orders.';
    const stillMissing = new Set((r.items || []).filter((i) => i.status === 'MISSING').map((i) => i.eoId));
    for (const eoId of Object.keys(state.drafts)) if (!stillMissing.has(eoId)) delete state.drafts[eoId];
    for (const eoId of Object.keys(state.selected)) if (!stillMissing.has(eoId)) delete state.selected[eoId];
  } catch (e) {
    state.auditError = e.message || 'تعذر تحميل تدقيق الكتالوج.';
    state.audit = null;
  }
  state.auditLoading = false;
  render();
}

async function selectStore(storeId) {
  if (storeId === state.storeId) { state.storeSelectorOpen = false; render(); return; }
  state.storeId = storeId;
  state.storeSelectorOpen = false;
  state.audit = null;
  state.drafts = {}; state.selected = {}; state.lastSyncSummary = null;
  await loadAudit();
}

function toggleSelectAll() {
  const missingItems = state.audit?.items?.filter((i) => i.status === 'MISSING') || [];
  const allSelected = missingItems.length > 0 && missingItems.every((i) => state.selected[i.eoId]);
  for (const item of missingItems) state.selected[item.eoId] = !allSelected;
  render();
}

const RESULT_LABELS = {
  CREATED: (r) => `✅ "${r.product?.product_name}" — تم الإنشاء`,
  SKIPPED_EXISTS: (r) => `⏭️ موجود بالفعل — مرتبط بمنتج داخلي رقم ${r.existingProductId}`,
  AMBIGUOUS: (r) => `⚠️ غامض — أكثر من منتج داخلي بنفس الاسم (${(r.candidateIds || []).join(', ')}) — يحتاج مراجعة يدوية`,
  INVALID_NAME: () => `⚠️ اسم غير صالح — تم التجاهل`,
  IN_PROGRESS: () => `⏳ طلب إنشاء آخر لنفس الاسم قيد التنفيذ — أعد المحاولة`,
  NOT_FOUND: () => `⚠️ لم يعد هذا المنتج موجودًا في كتالوج Easy Orders — تم التجاهل`,
  FAILED: (r) => `❌ فشل — ${r.message || 'خطأ غير متوقع'}`,
};

/** Sends a batch (possibly of size 1) to the idempotent server-side create endpoint, then ALWAYS re-runs the full audit — the single source of truth for what moved from MISSING to matched and what the counters now are. Never updates local state to pretend a row is "done"; only a fresh audit does that. */
async function submitCreate(eoIds) {
  if (!eoIds.length) return;
  const items = eoIds.map((eoId) => {
    const draft = state.drafts[eoId];
    return draft !== undefined ? { eoId, name: draft } : { eoId };
  });
  let createSummary = null;
  try {
    const r = await api.post('/api/product-marketing/easy-orders/catalog-audit/create', { store_id: state.storeId || undefined, items });
    createSummary = r.summary || null;
    for (const row of r.results || []) {
      const label = (RESULT_LABELS[row.status] || (() => row.status))(row);
      UI.toast(label, row.status === 'CREATED' ? 'success' : 'error');
    }
  } catch (e) {
    UI.toast(e.message || 'فشل طلب الإنشاء.', 'error');
  }
  await loadAudit(); // §5/§7 — reload so MISSING -> EXACT_NAME_MATCH and every counter updates immediately
  if (createSummary) {
    state.lastSyncSummary = {
      ...createSummary,
      remainingMissing: state.audit?.summary?.MISSING ?? null,
      ambiguousNow: state.audit?.summary?.AMBIGUOUS ?? null,
    };
    render();
  }
}

async function createOne(eoId) {
  state.busyEoIds.add(eoId);
  render();
  await submitCreate([eoId]);
  state.busyEoIds.delete(eoId);
  render();
}

async function createSelected() {
  const eoIds = Object.keys(state.selected).filter((id) => state.selected[id]);
  if (!eoIds.length) { UI.toast('اختر منتجًا واحدًا على الأقل.', 'error'); return; }
  state.batchBusy = true;
  render();
  await submitCreate(eoIds);
  state.batchBusy = false;
  render();
}

function renderStoreSelector() {
  if (state.storesLoading || state.storesError || !state.stores || state.stores.length <= 1) return '';
  const current = state.stores.find((s) => s.id === state.storeId) || state.stores[0];
  return `
    <div class="pmc-store-box">
      <div class="pmc-store-label">المتجر الحالي</div>
      <button class="pmc-store-current" id="eocsStoreToggle">${E(current?.name || '—')} <span class="car">▾</span></button>
      ${state.storeSelectorOpen ? `<div class="pmc-store-dropdown">
        ${state.stores.map((s) => `<button class="pmc-store-opt ${s.id === state.storeId ? 'active' : ''}" data-store="${E(s.id)}" ${s.enabled === false ? 'disabled' : ''}>${E(s.name)}${s.id === state.storeId ? ' ✓' : ''}</button>`).join('')}
      </div>` : ''}
    </div>`;
}

function renderSummary(summary) {
  const matched = (summary.EXACT_SKU_MATCH || 0) + (summary.EXACT_NAME_MATCH || 0);
  return `
    <div class="eocs-summary">
      <div class="eocs-stat"><div class="n">${E(summary.total)}</div><div class="l">إجمالي منتجات Easy Orders</div></div>
      <div class="eocs-stat matched"><div class="n">${E(matched)}</div><div class="l">مطابق بالفعل</div></div>
      <div class="eocs-stat missing"><div class="n">${E(summary.MISSING)}</div><div class="l">ناقص (MISSING)</div></div>
      <div class="eocs-stat ambiguous"><div class="n">${E(summary.AMBIGUOUS)}</div><div class="l">غامض (AMBIGUOUS)</div></div>
    </div>
    <div class="eocs-summary-sub">SKU مطابق: ${E(summary.EXACT_SKU_MATCH)} · اسم مطابق: ${E(summary.EXACT_NAME_MATCH)}</div>`;
}

function renderMissingRow(item) {
  const draftName = state.drafts[item.eoId] !== undefined ? state.drafts[item.eoId] : item.displayName;
  const busy = state.busyEoIds.has(item.eoId) || state.batchBusy;
  const checked = !!state.selected[item.eoId];
  return `
    <div class="eocs-row" data-eoid="${E(item.eoId)}">
      <div class="eocs-check"><input type="checkbox" class="eocs-select" ${checked ? 'checked' : ''} ${busy ? 'disabled' : ''} /></div>
      <div>
        <input type="text" class="eocs-name-input" value="${E(draftName)}" ${busy ? 'disabled' : ''} />
        <div class="eocs-name-orig">الاسم الأصلي في Easy Orders: ${E(item.name)} · Easy Orders id: ${E(item.eoId)}</div>
      </div>
      <div class="eocs-price">${E(item.price ?? '—')} ج.م</div>
      <div class="eocs-status">${E(item.status)}</div>
      <div class="eocs-actions"><button class="amb-btn primary sm eocs-create-btn" ${busy ? 'disabled' : ''}>${busy ? 'جارِ التنفيذ…' : 'إنشاء المنتج'}</button></div>
    </div>`;
}

function renderAmbiguousRow(item) {
  return `
    <div class="eocs-ambiguous-row">
      <div>⚠️ ${E(item.name)} <span class="eocs-name-orig">(Easy Orders id: ${E(item.eoId)}, السعر: ${E(item.price ?? '—')} ج.م)</span></div>
      <div class="cand">${item.ambiguousCandidateIds?.length ? `أكثر من منتج داخلي مطابق لنفس الاسم — Product IDs: ${item.ambiguousCandidateIds.join(', ')} — يحتاج مراجعة يدوية، لن يُنشأ تلقائيًا.` : ''}</div>
    </div>`;
}

function renderLastSyncSummary() {
  const s = state.lastSyncSummary;
  if (!s) return '';
  return `
    <div class="pmc-card" style="margin-bottom:16px;">
      <div class="h">📋 نتيجة آخر عملية مزامنة</div>
      <div class="eocs-summary">
        <div class="eocs-stat matched"><div class="n">${E(s.created)}</div><div class="l">تم إنشاؤه</div></div>
        <div class="eocs-stat"><div class="n">${E(s.skippedExists + s.invalidName + s.notFound + s.inProgress)}</div><div class="l">تم تخطيه</div></div>
        <div class="eocs-stat missing"><div class="n">${E(s.failed)}</div><div class="l">فشل</div></div>
        <div class="eocs-stat missing"><div class="n">${E(s.remainingMissing ?? '—')}</div><div class="l">متبقٍ ناقص</div></div>
        <div class="eocs-stat ambiguous"><div class="n">${E(s.ambiguousNow ?? '—')}</div><div class="l">غامض</div></div>
      </div>
    </div>`;
}

function render() {
  const view = $('eocsView');
  if (!view) return;

  const missingItems = state.audit?.items?.filter((i) => i.status === 'MISSING') || [];
  const ambiguousItems = state.audit?.items?.filter((i) => i.status === 'AMBIGUOUS') || [];
  const selectedCount = Object.values(state.selected).filter(Boolean).length;
  const allMissingSelected = missingItems.length > 0 && missingItems.every((i) => state.selected[i.eoId]);

  view.innerHTML = `
    <div class="pmc-header">
      <div>
        <h1>مزامنة كتالوج Easy Orders</h1>
        <p class="sub">Audit تلقائي لكتالوج المتجر الحقيقي مقابل جدول المنتجات الداخلي، مع إنشاء المنتجات الناقصة بمراجعة صريحة من الأدمن — فردي أو بالتحديد المتعدد. أي منتج جديد يُضاف في Easy Orders سيظهر هنا تلقائيًا كـ MISSING في المرة القادمة التي تُفتح فيها الصفحة.</p>
      </div>
      <div id="eocsStoreSelectorMount">${renderStoreSelector()}</div>
    </div>

    ${state.auditLoading ? '<div class="amb-loading">جارِ تحميل الكتالوج من Easy Orders…</div>' : ''}
    ${!state.auditLoading && state.auditError ? `<div class="pmc-card"><div class="h">⚠️ خطأ</div><div>${E(state.auditError)}</div></div>` : ''}

    ${!state.auditLoading && state.audit && !state.auditError ? `
      ${renderSummary(state.audit.summary)}
      ${renderLastSyncSummary()}

      <div class="pmc-card" style="margin-bottom:16px;">
        <div class="h" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <span>🧩 منتجات ناقصة داخليًا (${missingItems.length})</span>
          <div style="display:flex; gap:8px;">
            ${missingItems.length ? `<button class="amb-btn sm" id="eocsSelectAllBtn">${allMissingSelected ? 'إلغاء تحديد الكل' : 'تحديد الكل'}</button>` : ''}
            ${missingItems.length ? `<button class="amb-btn primary sm" id="eocsBulkCreateBtn" ${state.batchBusy ? 'disabled' : ''}>${state.batchBusy ? 'جارِ الإنشاء…' : `إنشاء المنتجات المحددة (${selectedCount})`}</button>` : ''}
          </div>
        </div>
        ${missingItems.length === 0 ? '<div class="amb-empty">لا يوجد منتج ناقص — كل كتالوج المتجر مطابق داخليًا.</div>' : ''}
        ${missingItems.map(renderMissingRow).join('')}
      </div>

      ${ambiguousItems.length ? `
      <div class="pmc-card">
        <div class="h">⚠️ حالات غامضة (${ambiguousItems.length}) — تحتاج مراجعة يدوية</div>
        ${ambiguousItems.map(renderAmbiguousRow).join('')}
      </div>` : ''}

      <div style="margin-top:14px;"><button class="amb-btn" id="eocsRefreshBtn">🔄 تحديث من Easy Orders</button></div>
    ` : ''}
  `;

  $('eocsStoreToggle')?.addEventListener('click', () => { state.storeSelectorOpen = !state.storeSelectorOpen; render(); });
  view.querySelectorAll('[data-store]').forEach((b) => b.addEventListener('click', () => selectStore(b.dataset.store)));
  $('eocsRefreshBtn')?.addEventListener('click', () => { state.lastSyncSummary = null; loadAudit(); });
  $('eocsBulkCreateBtn')?.addEventListener('click', () => createSelected());
  $('eocsSelectAllBtn')?.addEventListener('click', () => toggleSelectAll());

  view.querySelectorAll('.eocs-row[data-eoid]').forEach((row) => {
    const eoId = row.dataset.eoid;
    const nameInput = row.querySelector('.eocs-name-input');
    const checkbox = row.querySelector('.eocs-select');
    nameInput?.addEventListener('input', () => { state.drafts[eoId] = nameInput.value; });
    checkbox?.addEventListener('change', () => { state.selected[eoId] = checkbox.checked; render(); });
    row.querySelector('.eocs-create-btn')?.addEventListener('click', () => createOne(eoId));
  });
}

function renderNav() {
  const u = state.me || {};
  const initials = (u.name || 'U').trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
  $('ambNav').innerHTML = `
    <div class="amb-nav-brand">
      <div class="logo">💡</div>
      <div><div class="t">مركز التسويق الذكي</div><div class="s">قرارات تسويقية أذكى لكل منتج</div></div>
    </div>
    <div class="amb-nav-list">
      <a class="amb-nav-item" href="product-marketing-center.html">💡<span>مركز التسويق الذكي</span></a>
      <a class="amb-nav-item active" href="easyorders-catalog-sync.html">🔄<span>مزامنة الكتالوج</span></a>
      <a class="amb-nav-item" href="ai-media-buyer.html">📈<span>AI Media Buyer</span></a>
      <a class="amb-nav-item" href="creative-factory.html">✨<span>مصنع الإعلانات</span></a>
      <a class="amb-nav-item" href="product-research.html">🔍<span>البحث عن المنتجات</span></a>
    </div>
    <div class="amb-nav-foot">
      <div class="amb-nav-user">
        <div class="av">${E(initials)}</div>
        <div><div class="nm">${E(u.name || '—')}</div><div class="rl">${E({ ADMIN: 'مدير النظام', MANAGER: 'مدير', EMPLOYEE: 'موظف' }[u.role] || u.role || '')}</div></div>
      </div>
      <a class="amb-nav-link" href="ai-intelligence.html">🧠 AI Intelligence</a>
    </div>`;
}

init();
