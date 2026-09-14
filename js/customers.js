// customers.js — page controller for customers.html ("قاعدة العملاء").
// Every customer, order, and aggregate shown here comes from
// backend/src/routes/customers.js, which only reads the real Customer
// Database (deduplicated by normalized Egyptian phone from real Easy
// Orders payloads) — nothing here invents a customer or an order.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const E = (s) => UI.escapeHtml(String(s ?? ''));
const $ = (id) => document.getElementById(id);

// Same real EasyOrdersOrder status vocabulary + badge convention already
// used by js/easy-orders.js — order status is a different vocabulary from
// UI.statusBadge()'s (which is for Meta performance-trend labels).
const ORDER_STATUS_LABELS_AR = { PENDING: 'قيد الانتظار', CONFIRMED: 'مؤكد', DELIVERED: 'تم التسليم', CANCELLED: 'ملغي', RETURNED: 'مرتجع' };
const ORDER_STATUS_BADGE_COLOR = { PENDING: 'yellow', CONFIRMED: 'green', DELIVERED: 'green', CANCELLED: 'red', RETURNED: 'red' };
function orderStatusBadge(status) {
  return `<span class="badge ${E(ORDER_STATUS_BADGE_COLOR[status] || 'gray')}">${E(ORDER_STATUS_LABELS_AR[status] || status)}</span>`;
}

let searchDebounce = null;
let loadGeneration = 0; // guards an older in-flight search from overwriting a newer one's render

async function init() {
  UI.renderSidebar('customers');
  $('custSearch').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(load, 300);
  });
  $('custDrawerOverlay').addEventListener('click', (e) => { if (e.target.id === 'custDrawerOverlay') closeDrawer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  await load();
}

async function load() {
  const gen = ++loadGeneration;
  const q = $('custSearch').value.trim();
  $('custTableBody').innerHTML = `<tr><td colspan="8" class="faint" style="text-align:center;padding:20px;">جارِ التحميل…</td></tr>`;
  try {
    const { customers } = await api.get('/api/customers', q ? { search: q } : undefined);
    if (gen !== loadGeneration) return; // a newer search already started — never let a stale response win
    renderTable(customers);
  } catch (e) {
    if (gen !== loadGeneration) return;
    $('custTableBody').innerHTML = `<tr><td colspan="8" class="faint" style="text-align:center;padding:20px;">${E(e.message || 'تعذر تحميل قائمة العملاء.')}</td></tr>`;
  }
}

function renderTable(customers) {
  if (!customers.length) {
    $('custTableBody').innerHTML = `<tr><td colspan="8" class="faint" style="text-align:center;padding:20px;">لا يوجد عملاء مطابقون.</td></tr>`;
    return;
  }
  $('custTableBody').innerHTML = customers.map((c) => `
    <tr data-id="${E(c.id)}" style="cursor:pointer;">
      <td>${E(c.name || '—')}</td>
      <td class="ltr">${E(c.phoneMasked || '—')}</td>
      <td>${E(c.government || '—')}</td>
      <td>${E(UI.fmtNum(c.totalOrders))}</td>
      <td>${E(UI.fmtNum(c.confirmedOrders))}</td>
      <td>${E(UI.fmtNum(c.deliveredOrders))}</td>
      <td>${c.lastOrderAt ? new Date(c.lastOrderAt).toLocaleDateString('ar-EG') : '—'}</td>
      <td><button class="btn secondary small" data-view="${E(c.id)}">عرض</button></td>
    </tr>`).join('');
  $('custTableBody').querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => openDrawer(Number(tr.dataset.id)));
  });
}

async function openDrawer(id) {
  const overlay = $('custDrawerOverlay');
  const panel = $('custDrawerPanel');
  panel.innerHTML = `<div class="faint" style="padding:20px;">جارِ التحميل…</div>`;
  overlay.classList.add('open');
  try {
    const c = await api.get(`/api/customers/${id}`);
    panel.innerHTML = renderDetail(c);
    $('btnCloseCustDrawer')?.addEventListener('click', closeDrawer);
  } catch (e) {
    panel.innerHTML = `<div class="faint" style="padding:20px;">${E(e.message || 'تعذر تحميل بيانات العميل.')}</div>`;
  }
}

function closeDrawer() {
  $('custDrawerOverlay').classList.remove('open');
}

function renderDetail(c) {
  const otherPhones = c.otherPhones?.length ? c.otherPhones.map(E).join('، ') : null;
  return `
    <div class="drawer-header">
      <div>
        <div class="drawer-title">${E(c.name || 'عميل بدون اسم')}</div>
        <div class="drawer-meta ltr">${E(c.phone || '—')}</div>
      </div>
      <button class="btn secondary small" id="btnCloseCustDrawer">✕</button>
    </div>

    <div class="section-title" style="font-size:13px;">👤 بيانات العميل</div>
    <div style="font-size:13.5px; line-height:2; margin-bottom:10px;">
      ${otherPhones ? `<div><b>أرقام أخرى مسجّلة:</b> <span class="ltr">${otherPhones}</span></div>` : ''}
      <div><b>المحافظة:</b> ${E(c.government || '—')}</div>
      <div><b>العنوان:</b> ${E(c.address || '—')}</div>
      <div><b>أول أوردر:</b> ${c.firstOrderAt ? new Date(c.firstOrderAt).toLocaleDateString('ar-EG') : '—'}</div>
      <div><b>آخر أوردر:</b> ${c.lastOrderAt ? new Date(c.lastOrderAt).toLocaleDateString('ar-EG') : '—'}</div>
    </div>

    <div class="section-title" style="font-size:13px;">📊 الأداء</div>
    <div style="font-size:13.5px; line-height:2; margin-bottom:10px;">
      <div><b>إجمالي الأوردرات:</b> ${E(UI.fmtNum(c.totalOrders))}</div>
      <div><b>مؤكدة:</b> ${E(UI.fmtNum(c.confirmedOrders))}</div>
      <div><b>مُستلمة:</b> ${E(UI.fmtNum(c.deliveredOrders))}</div>
      <div><b>مرتجعة:</b> ${E(UI.fmtNum(c.returnedOrders))}</div>
      <div><b>ملغاة:</b> ${E(UI.fmtNum(c.cancelledOrders))}</div>
      <div><b>إجمالي قيمة الأوردرات:</b> ${UI.fmtCurrency(c.totalOrderValue)}</div>
      <div><b>إيرادات الأوردرات المُستلمة:</b> ${UI.fmtCurrency(c.deliveredRevenue)}</div>
    </div>

    ${c.productsPurchased?.length ? `
    <div class="section-title" style="font-size:13px;">📦 المنتجات المشتراة</div>
    <div style="font-size:13.5px; line-height:1.9; margin-bottom:10px;">
      ${c.productsPurchased.map((p) => `<div>${E(p)}</div>`).join('')}
    </div>` : ''}

    <div class="section-title" style="font-size:13px;">🧾 سجل الأوردرات (${E(c.orderHistory?.length || 0)})</div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>رقم الأوردر</th><th>المنتج</th><th>الحالة</th><th>التكلفة</th><th>التاريخ</th></tr></thead>
        <tbody>
          ${(c.orderHistory || []).map((o) => `
            <tr>
              <td>${E(o.shortId ? `#${o.shortId}` : o.orderId)}</td>
              <td>${E(o.productName || '—')}</td>
              <td>${orderStatusBadge(o.status)}</td>
              <td>${o.cost != null ? UI.fmtCurrency(o.cost) : '—'}</td>
              <td>${o.createdAt ? new Date(o.createdAt).toLocaleDateString('ar-EG') : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

init();
