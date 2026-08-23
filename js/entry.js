// entry.js — page controller for entry.html: manual daily order entry
// (spec section 3, method 1) and CSV/Excel import (method 2). Both paths
// funnel through DailyOrders.upsert(), which is the single place duplicate
// product+date rows are prevented.
import { Products, DailyOrders } from './db.js';
import { parseOrdersCSV } from './csv.js';
import * as A from './analytics.js';
import * as UI from './ui-common.js';

let products = [];

async function init() {
  UI.renderSidebar('entry');
  products = (await Products.all()).filter((p) => !p.is_demo);
  products.sort((a, b) => a.product_name.localeCompare(b.product_name, 'ar'));

  document.getElementById('fDate').value = A.todayStr();
  document.getElementById('fDate').max = A.todayStr();

  const productSelect = document.getElementById('fProduct');
  productSelect.innerHTML = products.map((p) => `<option value="${p.id}">${UI.escapeHtml(p.product_name)}</option>`).join('');

  const filterSelect = document.getElementById('fFilterProduct');
  filterSelect.innerHTML = '<option value="">كل المنتجات</option>' + products.map((p) => `<option value="${p.id}">${UI.escapeHtml(p.product_name)}</option>`).join('');
  filterSelect.onchange = renderRecent;

  document.getElementById('btnSave').onclick = saveManualEntry;
  document.getElementById('fCsv').onchange = handleCsvImport;

  if (products.length === 0) {
    document.getElementById('saveStatus').innerHTML = 'لا توجد منتجات بعد. أضف منتجًا من <a href="products.html">صفحة المنتجات</a> أولًا.';
  }

  await renderRecent();
}

async function saveManualEntry() {
  const date = document.getElementById('fDate').value;
  const productId = document.getElementById('fProduct').value;
  const orders = document.getElementById('fOrders').value;
  const delivered = document.getElementById('fDelivered').value;
  const returned = document.getElementById('fReturned').value;
  const notes = document.getElementById('fNotes').value;
  const statusEl = document.getElementById('saveStatus');

  if (!date || !productId || orders === '') {
    UI.toast('التاريخ، المنتج، وعدد الأوردرات مطلوبة', 'error');
    return;
  }

  const { created } = await DailyOrders.upsert({
    product_id: productId,
    date,
    orders_count: Number(orders),
    delivered_count: delivered === '' ? null : Number(delivered),
    returned_count: returned === '' ? null : Number(returned),
    notes,
  });

  UI.toast(created ? 'تم حفظ الأوردر' : 'تم تحديث الأوردر الموجود لنفس المنتج والتاريخ (لا تكرار)');
  statusEl.textContent = created ? 'تم الحفظ ✓' : 'تم التحديث (كان موجودًا بالفعل) ✓';
  document.getElementById('fOrders').value = '';
  document.getElementById('fDelivered').value = '';
  document.getElementById('fReturned').value = '';
  document.getElementById('fNotes').value = '';
  await renderRecent();
}

async function handleCsvImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const { valid, errors, unmatchedProducts } = parseOrdersCSV(text, products);

  let createdCount = 0;
  let updatedCount = 0;
  for (const row of valid) {
    const { created } = await DailyOrders.upsert(row);
    if (created) createdCount++;
    else updatedCount++;
  }

  const resultEl = document.getElementById('importResult');
  const parts = [];
  parts.push(`<div class="alert-card ${errors.length ? 'warning' : 'positive'}">`);
  parts.push(`<div class="alert-title">تم الاستيراد: ${createdCount} صف جديد، ${updatedCount} صف تم تحديثه (بدون تكرار)</div>`);
  if (unmatchedProducts.length) {
    parts.push(`<div class="alert-meta">منتجات غير معروفة (لم يتم استيرادها): ${unmatchedProducts.map(UI.escapeHtml).join('، ')}</div>`);
  }
  if (errors.length) {
    parts.push(`<div class="alert-meta">${errors.length} خطأ في الملف:</div>`);
    parts.push(`<div class="faint mono" style="white-space:pre-line; font-size:12px;">${errors.slice(0, 20).map(UI.escapeHtml).join('\n')}${errors.length > 20 ? `\n… و ${errors.length - 20} أخرى` : ''}</div>`);
  }
  parts.push('</div>');
  resultEl.innerHTML = parts.join('');

  e.target.value = '';
  if (createdCount || updatedCount) await renderRecent();
}

async function renderRecent() {
  const filterProductId = document.getElementById('fFilterProduct').value;
  const all = (await DailyOrders.all()).filter((r) => !r.is_demo);
  const byId = new Map(products.map((p) => [p.id, p]));

  let rows = all;
  if (filterProductId) rows = rows.filter((r) => r.product_id === Number(filterProductId));
  rows = rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 50);

  document.getElementById('recentBody').innerHTML = rows
    .map((r) => {
      const p = byId.get(r.product_id);
      return `
      <tr>
        <td class="mono">${r.date}</td>
        <td>${p ? UI.escapeHtml(p.product_name) : '—'}</td>
        <td class="num">${r.orders_count}</td>
        <td class="num">${r.delivered_count ?? '<span class="faint">—</span>'}</td>
        <td class="num">${r.returned_count ?? '<span class="faint">—</span>'}</td>
        <td class="faint">${UI.escapeHtml(r.notes || '')}</td>
        <td><button class="btn danger small" data-del="${r.id}">حذف</button></td>
      </tr>`;
    })
    .join('');

  document.getElementById('recentBody').querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = async () => {
      await DailyOrders.remove(btn.dataset.del);
      UI.toast('تم حذف الإدخال');
      await renderRecent();
    };
  });
}

init();
