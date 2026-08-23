// products.js — page controller for products.html. Real-product-focused:
// demo products are never shown here (spec: "لا أريد المنتجات الوهمية
// تظهر في: ... Products"); search + category filter for a catalog that can
// run into the hundreds; row click opens the quick-view drawer instead of
// navigating away.
import { Products, Settings, DailyOrders } from './db.js';
import * as UI from './ui-common.js';
import { breakEvenCPA } from './profit.js';
import { dailyAverageSales, daysOfStockRemaining, stockStatus } from './inventory.js';
import { analyzeProduct, todayStr } from './analytics.js';
import { buildImportPlan, parseProductsCsv } from './product-import.js';
import { importRealCatalog } from './real-catalog.js';
import { openProductDrawer } from './product-drawer.js';
import { calculateProductScore } from './product-score.js';
import { wireScoreTriggers } from './score-modal.js';

let editingId = null;
let settings = null;
let allProducts = [];
const state = { search: '', category: 'ALL', sort: UI.qs('sort') === 'score' ? 'score' : 'name' };

const CATEGORIES = ['Beauty', 'Health', 'Home', 'Electronics', 'Kids', 'Fitness', 'Accessories', 'Kitchen', 'Smart Devices', 'Other'];

const FINANCIAL_FIELDS = [
  ['fShipping', 'shipping_cost'],
  ['fPackaging', 'packaging_cost'],
  ['fOtherCost', 'other_cost'],
  ['fReturnCost', 'expected_return_cost'],
  ['fCommission', 'commission'],
  ['fAdvertising', 'advertising_cost'],
];

const INVENTORY_FIELDS = [
  ['fStock', 'current_stock'],
  ['fMinStock', 'minimum_stock'],
  ['fRestockQty', 'restock_quantity'],
];

function inputToOptNum(elId) {
  const v = document.getElementById(elId).value;
  return v === '' ? null : Number(v);
}

async function init() {
  UI.renderSidebar('products');
  settings = await Settings.get();
  document.getElementById('btnAdd').onclick = () => openModal(null);
  document.getElementById('btnCancel').onclick = closeModal;
  document.getElementById('btnSave').onclick = save;
  document.getElementById('modalOverlay').onclick = (e) => {
    if (e.target.id === 'modalOverlay') closeModal();
  };
  document.getElementById('searchProduct').oninput = (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderTable();
  };
  document.getElementById('btnImportReal').onclick = runRealCatalogImport;
  document.getElementById('btnImportCsv').onclick = () => document.getElementById('fileImportCsv').click();
  document.getElementById('fileImportCsv').onchange = handleCsvFile;

  buildCategoryChips();
  buildSortChips();
  await render();
}

function buildSortChips() {
  const el = document.getElementById('sortChips');
  if (!el) return;
  const options = [['name', 'الاسم'], ['score', '🏆 التقييم']];
  el.innerHTML = options.map(([v, label]) => `<span class="chip ${v === state.sort ? 'active' : ''}" data-v="${v}">${label}</span>`).join('');
  el.querySelectorAll('.chip').forEach((chip) => {
    chip.onclick = () => {
      state.sort = chip.dataset.v;
      el.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderTable();
    };
  });
}

function buildCategoryChips() {
  const el = document.getElementById('categoryChips');
  const values = ['ALL', ...CATEGORIES];
  el.innerHTML = values.map((v) => `<span class="chip ${v === state.category ? 'active' : ''}" data-v="${v}">${v === 'ALL' ? 'كل الفئات' : v}</span>`).join('');
  el.querySelectorAll('.chip').forEach((chip) => {
    chip.onclick = () => {
      state.category = chip.dataset.v;
      el.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderTable();
    };
  });
}

async function render() {
  allProducts = await Products.all();
  renderCounts();
  await renderTable();
}

function renderCounts() {
  const real = allProducts.filter((p) => !p.is_demo);
  const active = real.filter((p) => p.active).length;
  const demoCount = allProducts.filter((p) => p.is_demo).length;
  document.getElementById('countsLine').textContent = `إجمالي المنتجات: ${real.length}   |   نشط: ${active}   |   تجريبي (مخفي): ${demoCount}`;
}

async function renderTable() {
  // Demo products never appear here (spec: they must not show in Products).
  let real = allProducts.filter((p) => !p.is_demo);

  if (state.search) {
    real = real.filter(
      (p) => p.product_name.toLowerCase().includes(state.search) || (p.sku || '').toLowerCase().includes(state.search)
    );
  }
  if (state.category !== 'ALL') {
    real = real.filter((p) => p.category === state.category);
  }

  const tbody = document.getElementById('tbody');
  document.getElementById('emptyState').style.display = real.length === 0 ? 'block' : 'none';

  const asOfDate = todayStr();
  let rows = await Promise.all(
    real.map(async (p) => {
      const records = await DailyOrders.forProduct(p.id); // 🧪 demo orders included — see alerts.js comment
      const analysis = analyzeProduct(records, asOfDate, settings);
      const score = calculateProductScore(analysis);

      let stockCell = '<span class="faint">غير محدد</span>';
      if (p.current_stock !== null && p.current_stock !== undefined) {
        const avgSales = dailyAverageSales(analysis);
        const days = daysOfStockRemaining(p.current_stock, avgSales);
        const status = stockStatus(days, settings);
        const badgeColor = status === 'CRITICAL' ? 'red' : status === 'LOW' ? 'yellow' : status === 'OK' ? 'green' : 'gray';
        stockCell = `${p.current_stock} <span class="badge ${badgeColor}">${days !== null ? days.toFixed(1) + ' يوم' : 'لا مبيعات مسجلة'}</span>`;
      }
      return { p, stockCell, score };
    })
  );

  rows =
    state.sort === 'score'
      ? rows.sort((x, y) => (y.score.score ?? -1) - (x.score.score ?? -1))
      : rows.sort((x, y) => (x.p.product_code || x.p.product_name).localeCompare(y.p.product_code || y.p.product_name, 'ar'));

  tbody.innerHTML = rows
    .map(
      ({ p, stockCell, score }) => `
      <tr>
        <td><a href="#" data-drawer="${p.id}">${UI.escapeHtml(p.product_name)}</a></td>
        <td class="mono">${UI.escapeHtml(p.sku || '—')}</td>
        <td class="mono faint">${UI.escapeHtml(p.product_code || '—')}</td>
        <td>${p.category ? UI.escapeHtml(p.category) : '<span class="faint">—</span>'}</td>
        <td data-id="${p.id}">${UI.scoreCircleHtml(score, 'sm')}</td>
        <td class="num">${stockCell}</td>
        <td>${p.active ? '<span class="badge green">نشط</span>' : '<span class="badge gray">غير نشط</span>'}</td>
        <td>
          <button class="btn secondary small" data-edit="${p.id}">تعديل</button>
          <button class="btn danger small" data-del="${p.id}">حذف</button>
        </td>
      </tr>`
    )
    .join('');

  tbody.querySelectorAll('[data-drawer]').forEach((el) => {
    el.onclick = (e) => {
      e.preventDefault();
      openProductDrawer(el.dataset.drawer, render);
    };
  });
  wireScoreTriggers(tbody, (id) => {
    const row = rows.find((r) => String(r.p.id) === String(id));
    return { name: row.p.product_name, result: row.score };
  });
  tbody.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.onclick = async () => {
      const p = allProducts.find((x) => x.id === Number(btn.dataset.edit));
      openModal(p);
    };
  });
  tbody.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = async () => {
      const p = allProducts.find((x) => x.id === Number(btn.dataset.del));
      if (confirm(`هل تريد حذف "${p.product_name}"؟ سيتم حذف كل بيانات الأوردرات الخاصة به أيضًا. لا يمكن التراجع عن هذا الإجراء.`)) {
        await Products.remove(p.id);
        UI.toast('تم حذف المنتج');
        await render();
      }
    };
  });
}

function openModal(product) {
  editingId = product ? product.id : null;
  document.getElementById('modalTitle').textContent = product ? 'تعديل منتج' : 'إضافة منتج';
  document.getElementById('fName').value = product ? product.product_name : '';
  document.getElementById('fSku').value = product ? product.sku || '' : '';
  document.getElementById('fCode').value = product ? product.product_code || '' : '';
  document.getElementById('fCategory').value = product ? product.category || '' : '';
  document.getElementById('fPrice').value = product ? product.selling_price ?? '' : '';
  document.getElementById('fCost').value = product ? product.product_cost ?? '' : '';
  document.getElementById('fActive').value = product ? String(product.active !== false) : 'true';

  for (const [elId, field] of FINANCIAL_FIELDS) {
    document.getElementById(elId).value = product ? product[field] ?? '' : '';
  }
  if (!product) {
    document.getElementById('fShipping').value = settings.defaultShippingCost || '';
    document.getElementById('fPackaging').value = settings.defaultPackagingCost || '';
  }

  for (const [elId, field] of INVENTORY_FIELDS) {
    document.getElementById(elId).value = product ? product[field] ?? '' : '';
  }
  document.getElementById('fSupplier').value = product ? product.supplier || '' : '';
  document.getElementById('fLastRestock').value = product ? product.last_restock_date || '' : '';

  document.getElementById('modalOverlay').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modalOverlay').style.display = 'none';
}

async function save() {
  const name = document.getElementById('fName').value.trim();
  if (!name) {
    UI.toast('اسم المنتج مطلوب', 'error');
    return;
  }
  let productCode = document.getElementById('fCode').value.trim();
  if (!productCode && !editingId) {
    productCode = await Products.nextProductCode();
  }
  const payload = {
    product_name: name,
    sku: document.getElementById('fSku').value.trim(),
    category: document.getElementById('fCategory').value || null,
    selling_price: Number(document.getElementById('fPrice').value) || 0,
    product_cost: Number(document.getElementById('fCost').value) || 0,
    active: document.getElementById('fActive').value === 'true',
    supplier: document.getElementById('fSupplier').value.trim() || null,
    last_restock_date: document.getElementById('fLastRestock').value || null,
    is_demo: false,
  };
  if (productCode) payload.product_code = productCode;
  for (const [elId, field] of FINANCIAL_FIELDS) payload[field] = inputToOptNum(elId);
  for (const [elId, field] of INVENTORY_FIELDS) payload[field] = inputToOptNum(elId);

  try {
    if (editingId) {
      await Products.update(editingId, payload);
      UI.toast('تم تحديث المنتج');
    } else {
      await Products.create(payload);
      UI.toast('تم إضافة المنتج');
    }
    closeModal();
    await render();
  } catch (e) {
    UI.toast(e.name === 'ConstraintError' ? 'يوجد منتج آخر بنفس كود المنتج' : 'حدث خطأ أثناء الحفظ', 'error');
  }
}

// ---------------------------------------------------------------------------
// Import — real catalog (one-click, hardcoded) + generic CSV/Excel upload.
// ---------------------------------------------------------------------------

function showImportSummary(label, result) {
  const card = document.getElementById('importSummaryCard');
  const body = document.getElementById('importSummaryBody');
  card.style.display = 'block';
  body.innerHTML = `
    <div>${label}</div>
    <div>✅ تم إضافة ${result.created} منتج</div>
    <div>🔄 تم تحديث ${result.updated}</div>
    <div>⚠️ تم تجاهل ${result.duplicatesInFile} (مكرر داخل نفس الملف)</div>
    <div>❌ أخطاء ${result.errors}</div>
  `;
}

async function runRealCatalogImport() {
  const btn = document.getElementById('btnImportReal');
  btn.disabled = true;
  const result = await importRealCatalog();
  btn.disabled = false;
  document.getElementById('realImportStatus').innerHTML = `
    ✅ تم إضافة ${result.created} منتج · 🔄 تم تحديث ${result.updated} ·
    إجمالي القائمة: ${result.total} (بها SKU: ${result.withSku}، بدون SKU: ${result.withoutSku})
  `;
  UI.toast('تم استيراد القائمة الحقيقية');
  await render();
}

async function handleCsvFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const { rows, error } = parseProductsCsv(text);
  if (error) {
    UI.toast(error, 'error');
    e.target.value = '';
    return;
  }

  const existing = await Products.all();
  const plan = buildImportPlan(existing, rows);

  let created = 0;
  let updated = 0;
  for (const row of plan.toCreate) {
    const productCode = await Products.nextProductCode();
    await Products.create({ product_name: row.product_name, sku: row.sku, category: row.category, product_code: productCode, active: true, is_demo: false });
    created++;
  }
  for (const { existing: existingProduct, row } of plan.toUpdate) {
    await Products.update(existingProduct.id, {
      product_name: row.product_name,
      sku: row.sku || existingProduct.sku,
      category: row.category || existingProduct.category,
    });
    updated++;
  }

  showImportSummary(`تم استيراد الملف: ${file.name}`, {
    created,
    updated,
    duplicatesInFile: plan.duplicatesInFile.length,
    errors: plan.errors.length,
  });
  e.target.value = '';
  await render();
}

init();
