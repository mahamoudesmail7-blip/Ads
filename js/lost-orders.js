// lost-orders.js — page controller for lost-orders.html. Every number,
// name, and status shown here comes from backend/src/routes/lostOrders.js,
// which itself only reads real EasyOrdersOrder/LostOrder rows — nothing in
// this file invents an order, customer, or history entry.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const STATUS_LABELS_AR = {
  NEW: 'جديد',
  PROCESSING: 'قيد المعالجة',
  CONTACTED: 'تم التواصل',
  CUSTOMER_APPROVED: 'العميل وافق',
  CUSTOMER_REJECTED: 'العميل رفض',
  REPLACEMENT_CREATED: 'تم إنشاء بديل',
  CLOSED: 'مغلق',
};
const STATUS_BADGE_COLOR = {
  NEW: 'yellow',
  PROCESSING: 'gray',
  CONTACTED: 'gray',
  CUSTOMER_APPROVED: 'green',
  CUSTOMER_REJECTED: 'red',
  REPLACEMENT_CREATED: 'green',
  CLOSED: 'gray',
};
const FILTER_CHIPS = [
  { key: 'ALL', label: 'الكل' },
  { key: 'NEW', label: 'جديد' },
  { key: 'PROCESSING', label: 'قيد المعالجة' },
  { key: 'REPLACEMENT_CREATED', label: 'تم إنشاء بديل' },
  { key: 'CLOSED', label: 'مغلق' },
];

let currentFilter = 'ALL';
let searchDebounce = null;
let currentDrawerId = null;
let loadGeneration = 0; // guards against an older in-flight load() (e.g. a slow search request) overwriting a newer filter/search change's render

async function init() {
  UI.renderSidebar('lostorders');
  renderFilterChips();
  document.getElementById('loSearch').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(load, 300);
  });
  document.getElementById('loDateFrom').addEventListener('change', load);
  document.getElementById('loDateTo').addEventListener('change', load);
  document.getElementById('loClearDates').onclick = () => {
    document.getElementById('loDateFrom').value = '';
    document.getElementById('loDateTo').value = '';
    load();
  };
  document.getElementById('loDrawerOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'loDrawerOverlay') closeDrawer();
  });
  document.getElementById('btnCancelReplacement').onclick = closeReplacementModal;
  document.getElementById('btnConfirmReplacement').onclick = confirmReplacement;
  document.getElementById('btnManualAdd').onclick = openManualAddModal;
  document.getElementById('btnCancelManualAdd').onclick = closeManualAddModal;
  document.getElementById('btnConfirmManualAdd').onclick = confirmManualAdd;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDrawer();
      closeReplacementModal();
      closeManualAddModal();
    }
  });
  await load();
}

function openManualAddModal() {
  document.getElementById('manualOrderNumber').value = '';
  document.getElementById('manualReason').value = '';
  document.getElementById('loManualAddStatus').style.display = 'none';
  document.getElementById('loManualAddOverlay').style.display = 'flex';
}

function closeManualAddModal() {
  document.getElementById('loManualAddOverlay').style.display = 'none';
}

async function confirmManualAdd() {
  const orderNumber = document.getElementById('manualOrderNumber').value.trim();
  const reason = document.getElementById('manualReason').value.trim();
  const statusEl = document.getElementById('loManualAddStatus');
  if (!orderNumber || !reason) {
    statusEl.style.display = 'block';
    statusEl.textContent = 'لازم تحط رقم الأوردر والسبب.';
    return;
  }
  statusEl.style.display = 'block';
  statusEl.textContent = 'بيدوّر على الأوردر في EasyOrders...';
  try {
    await api.post('/api/lost-orders/manual-add', { orderNumber, reason });
  } catch (err) {
    statusEl.textContent = `⚠️ ${err.message}`;
    return;
  }
  UI.toast('✅ اتضاف بنجاح');
  closeManualAddModal();
  await load();
}

function renderFilterChips() {
  const el = document.getElementById('loStatusChips');
  el.innerHTML = FILTER_CHIPS.map((c) => `<button type="button" class="chip ${c.key === currentFilter ? 'active' : ''}" data-filter="${c.key}">${c.label}</button>`).join('');
  el.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.onclick = () => {
      currentFilter = btn.dataset.filter;
      renderFilterChips();
      load();
    };
  });
}

async function load() {
  const search = document.getElementById('loSearch').value.trim();
  const dateFrom = document.getElementById('loDateFrom').value;
  const dateTo = document.getElementById('loDateTo').value;

  const requestId = ++loadGeneration;
  let summary, list;
  try {
    [summary, list] = await Promise.all([
      api.get('/api/lost-orders/summary'),
      api.get('/api/lost-orders', { status: currentFilter, search: search || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined }),
    ]);
  } catch (err) {
    if (requestId !== loadGeneration) return;
    document.getElementById('loTableBody').innerHTML = '';
    document.getElementById('loEmpty').style.display = 'block';
    document.getElementById('loEmpty').textContent = `⚠️ مقدرش أجيب البيانات (${err.message}) — جرب تاني.`;
    return;
  }
  if (requestId !== loadGeneration) return; // a newer load() already started — this response is stale, don't let it clobber the current render
  renderStatTiles(summary);
  renderTable(list);
}

function renderStatTiles(summary) {
  document.getElementById('loStatTiles').innerHTML = [
    UI.statTile('📮 إجمالي المفقود', summary.total),
    UI.statTile('🆕 جديد', summary.new, { colorClass: summary.new > 0 ? 'yellow' : '' }),
    UI.statTile('⏳ قيد المعالجة', summary.processing),
    UI.statTile('📦 تم إنشاء بديل', summary.replacementCreated, { colorClass: 'green' }),
    UI.statTile('✅ مغلق', summary.closed),
  ].join('');
}

function renderTable(list) {
  const body = document.getElementById('loTableBody');
  const empty = document.getElementById('loEmpty');
  if (list.length === 0) {
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  body.innerHTML = list
    .map(
      (row) => `
      <tr>
        <td class="mono">${row.shortId ? '#' + row.shortId : row.orderId.slice(0, 8) + '…'}</td>
        <td>${UI.escapeHtml(row.customerName || '—')}</td>
        <td class="mono ltr" style="text-align:end;">${UI.escapeHtml(row.customerPhone || '—')}</td>
        <td>${UI.escapeHtml(row.productNames.join('، ') || '—')}</td>
        <td>${UI.escapeHtml(row.customerGovernment || '—')}</td>
        <td class="mono" style="font-size:12px;">${row.orderCreatedAt ? new Date(row.orderCreatedAt).toLocaleDateString('ar-EG') : '—'}</td>
        <td class="mono" style="font-size:12px;">${new Date(row.lostDetectedAt).toLocaleDateString('ar-EG')}</td>
        <td><span class="badge ${STATUS_BADGE_COLOR[row.processingStatus]}">${row.processingStatusLabel}</span></td>
        <td><button class="btn secondary small" data-open="${row.id}">فتح التفاصيل</button></td>
      </tr>
    `
    )
    .join('');
  body.querySelectorAll('[data-open]').forEach((btn) => (btn.onclick = () => openDrawer(Number(btn.dataset.open))));
}

async function openDrawer(id) {
  currentDrawerId = id;
  const overlay = document.getElementById('loDrawerOverlay');
  const panel = document.getElementById('loDrawerPanel');
  panel.innerHTML = '<div class="empty-state">جارِ التحميل…</div>';
  overlay.classList.add('open');

  const data = await api.get(`/api/lost-orders/${id}`);
  if (currentDrawerId !== id) return;
  renderDrawer(data);
}

function closeDrawer() {
  document.getElementById('loDrawerOverlay').classList.remove('open');
  currentDrawerId = null;
}

function renderDrawer(data) {
  const r = data.realOrder;
  const panel = document.getElementById('loDrawerPanel');
  panel.innerHTML = `
    <div class="drawer-header">
      <div>
        <div class="drawer-title">${r?.shortId ? '#' + r.shortId : data.orderId.slice(0, 8) + '…'}</div>
        <div class="drawer-meta">تم اكتشافه كمفقود: ${new Date(data.lostDetectedAt).toLocaleString('ar-EG')}</div>
        ${data.source === 'MANUAL' ? `<div class="drawer-meta" style="margin-top:4px;"><span class="badge gray">أُضيف يدويًا</span> ${UI.escapeHtml(data.manualReason || '')}</div>` : ''}
      </div>
      <button class="btn secondary small" id="btnCloseDrawer">✕</button>
    </div>

    <div class="section-title" style="margin-top:0; font-size:13px;">👤 بيانات العميل الحقيقية</div>
    <div style="font-size:13.5px; line-height:2;">
      <div><b>الاسم:</b> ${UI.escapeHtml(r?.customerName || '—')}</div>
      <div><b>الهاتف:</b> <span class="mono ltr">${UI.escapeHtml(r?.customerPhone || '—')}</span></div>
      <div><b>المحافظة:</b> ${UI.escapeHtml(r?.customerGovernment || '—')}</div>
      <div><b>العنوان:</b> ${UI.escapeHtml(r?.customerAddress || '—')}</div>
    </div>

    <div class="section-title" style="font-size:13px;">📦 المنتجات</div>
    <div style="font-size:13.5px; line-height:1.9; margin-bottom:10px;">
      ${(r?.items || []).map((i) => `<div>${UI.escapeHtml(i.productName)} × ${i.quantity}${!i.matched ? ' <span class="badge gray">غير مربوط</span>' : ''}</div>`).join('') || '—'}
      ${r ? `<div class="faint" style="margin-top:6px;">السعر: ${r.orderCost ?? '—'} + شحن ${r.shippingCost ?? '—'}</div>` : ''}
    </div>

    <div class="section-title" style="font-size:13px;">📅 التواريخ والحالة الحقيقية</div>
    <div style="font-size:13.5px; line-height:2; margin-bottom:10px;">
      <div><b>تاريخ الأوردر الأصلي:</b> ${r?.orderCreatedAt ? new Date(r.orderCreatedAt).toLocaleString('ar-EG') : '—'}</div>
      <div><b>الحالة الحالية في EasyOrders:</b> <span class="mono">${UI.escapeHtml(r?.rawStatus || '—')}</span></div>
    </div>

    <div class="section-title" style="font-size:13px;">⚙️ حالة المعالجة الداخلية</div>
    <select id="drawerStatusSelect" style="margin-bottom:10px;">
      ${Object.entries(STATUS_LABELS_AR).map(([k, v]) => `<option value="${k}" ${data.processingStatus === k ? 'selected' : ''}>${v}</option>`).join('')}
    </select>

    ${
      data.replacementOrderId
        ? `<div class="alert-card positive" style="margin-bottom:10px;"><div class="alert-title">✅ تم إنشاء أوردر بديل #${UI.escapeHtml(data.replacementOrderId)}</div></div>`
        : `<button class="btn" id="btnOpenReplacement" style="width:100%; margin-bottom:14px;">📦 إنشاء أوردر بديل</button>`
    }

    <div class="section-title" style="font-size:13px;">📝 ملاحظات</div>
    <div class="field" style="margin-bottom:8px;">
      <input type="text" id="drawerNoteInput" placeholder="اكتب ملاحظة..." />
    </div>
    <button class="btn secondary small" id="btnAddNote" style="margin-bottom:14px;">إضافة ملاحظة</button>
    <div id="drawerNotes" style="margin-bottom:14px;">
      ${data.notes.length === 0 ? '<div class="faint" style="font-size:12.5px;">مفيش ملاحظات لسه.</div>' : data.notes.map((n) => `<div style="font-size:12.5px; padding:6px 0; border-bottom:1px solid var(--border);"><b>${UI.escapeHtml(n.author || 'النظام')}:</b> ${UI.escapeHtml(n.text)} <span class="faint">— ${new Date(n.createdAt).toLocaleString('ar-EG')}</span></div>`).join('')}
    </div>

    <div class="section-title" style="font-size:13px;">📜 سجل الإجراءات</div>
    <div>
      ${data.history.map((h) => `<div style="font-size:12.5px; padding:6px 0; border-bottom:1px solid var(--border);">${new Date(h.createdAt).toLocaleTimeString('ar-EG')} — ${UI.escapeHtml(h.detail || h.action)}${h.actor ? ` <span class="faint">(${UI.escapeHtml(h.actor)})</span>` : ''}</div>`).join('')}
    </div>
  `;

  document.getElementById('btnCloseDrawer').onclick = closeDrawer;
  document.getElementById('drawerStatusSelect').onchange = async (e) => {
    await api.patch(`/api/lost-orders/${data.id}/status`, { status: e.target.value });
    UI.toast('تم تحديث الحالة');
    await refreshAfterChange(data.id);
  };
  document.getElementById('btnAddNote').onclick = async () => {
    const input = document.getElementById('drawerNoteInput');
    const text = input.value.trim();
    if (!text) return;
    await api.post(`/api/lost-orders/${data.id}/notes`, { text });
    input.value = '';
    await refreshAfterChange(data.id);
  };
  document.getElementById('btnOpenReplacement')?.addEventListener('click', () => openReplacementModal(data));
}

async function refreshAfterChange(id) {
  const data = await api.get(`/api/lost-orders/${id}`);
  renderDrawer(data);
  await load(); // keep the table/summary in sync too
}

let replacementLostOrderId = null;

function openReplacementModal(data) {
  replacementLostOrderId = data.id;
  const r = data.realOrder;
  document.getElementById('repName').value = r?.customerName || '';
  document.getElementById('repPhone').value = r?.customerPhone || '';
  document.getElementById('repGovernment').value = r?.customerGovernment || '';
  document.getElementById('repAddress').value = r?.customerAddress || '';
  document.getElementById('repProducts').textContent = (r?.items || []).map((i) => `${i.productName} × ${i.quantity}`).join('، ') || '—';
  document.getElementById('loReplacementStatus').style.display = 'none';
  document.getElementById('loReplacementOverlay').style.display = 'flex';
}

function closeReplacementModal() {
  document.getElementById('loReplacementOverlay').style.display = 'none';
  replacementLostOrderId = null;
}

async function confirmReplacement() {
  if (!replacementLostOrderId) return;
  const statusEl = document.getElementById('loReplacementStatus');
  statusEl.style.display = 'block';
  statusEl.textContent = 'بيبعت لـ EasyOrders...';
  try {
    await api.post(`/api/lost-orders/${replacementLostOrderId}/create-replacement`, {
      name: document.getElementById('repName').value,
      phone: document.getElementById('repPhone').value,
      government: document.getElementById('repGovernment').value,
      address: document.getElementById('repAddress').value,
    });
  } catch (err) {
    statusEl.innerHTML = `⚠️ ${UI.escapeHtml(err.message)}`;
    return;
  }
  statusEl.textContent = '✅ تم إنشاء الأوردر';
}

init();
