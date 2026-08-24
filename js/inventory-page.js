// inventory-page.js — page controller for inventory.html (🏭 إدارة المخزون).
// Named distinctly from inventory.js (the existing V2 pure Inventory Layer
// module — days-of-stock-remaining projections) to avoid colliding with it;
// this file is the Daily Stock Tracking module's UI wiring instead.
import { Products, InventoryMovementLog, Settings, DailyReports } from './db.js';
import * as A from './analytics.js';
import * as UI from './ui-common.js';
import { MOVEMENT_TYPES } from './inventory-tracker.js';
import {
  previewImport,
  confirmImport,
  connectUnmatchedProduct,
  getUnresolvedUnmatched,
  getTodaysOutgoing,
  getWarehouseSummary,
  getLowStockAndOutOfStock,
  getHighDemandProducts,
  getReconciliation,
  getFullComparison,
  getNoMovementWithStreaks,
  getDecliningOutgoing,
  getOrdersComparison,
  importRealStockList,
  buildDailyInventoryReport,
} from './inventory-store.js';
import { loadInventoryTestScenario, loadSimpleDashboardScenario } from './inventory-test-scenario.js';

const state = { date: A.todayStr(), showAllOutgoing: false, showAllNoMovement: false, showAllOrders: false, search: '' };
const TOP_N = 5;

let rawCsvText = null;
let currentFilename = null;
let currentPreview = null;
let products = [];
let lastFullComparison = [];

async function init() {
  UI.renderSidebar('inventory');

  const picker = document.getElementById('asOfDatePicker');
  picker.value = state.date;
  picker.onchange = () => {
    state.date = picker.value;
    refresh();
  };
  document.getElementById('btnToday').onclick = () => {
    state.date = A.todayStr();
    picker.value = state.date;
    refresh();
  };
  document.getElementById('btnYesterday').onclick = () => {
    state.date = A.addDays(A.todayStr(), -1);
    picker.value = state.date;
    refresh();
  };

  document.getElementById('btnUploadFile').onclick = () => document.getElementById('fileInput').click();
  document.getElementById('fileInput').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    currentFilename = file.name;
    rawCsvText = await file.text();
    e.target.value = '';
    await runPreview(null);
  };

  document.getElementById('btnImportRealStock').onclick = async () => {
    document.getElementById('btnImportRealStock').disabled = true;
    const result = await importRealStockList(state.date, 'مدير المخزون');
    document.getElementById('btnImportRealStock').disabled = false;
    UI.toast(
      result.unmatched.length > 0
        ? `✅ تم استيراد ${result.imported} منتج — ${result.unmatched.length} لم يتطابق (راجعها في "تفاصيل وأدوات إضافية")`
        : `✅ تم استيراد ${result.imported} منتج بنجاح`
    );
    await refresh();
  };

  document.getElementById('btnLoadTestScenario').onclick = async () => {
    document.getElementById('btnLoadTestScenario').disabled = true;
    const result = await loadSimpleDashboardScenario();
    document.getElementById('btnLoadTestScenario').disabled = false;
    UI.toast(`✅ تم تحميل بيانات التجربة (إجمالي صادر متوقع: ${result.expectedTotalUnitsOut})`);
    state.date = result.date;
    picker.value = state.date;
    await refresh();
  };
  document.getElementById('btnLoadAdvancedScenario').onclick = async () => {
    document.getElementById('btnLoadAdvancedScenario').disabled = true;
    const result = await loadInventoryTestScenario();
    document.getElementById('btnLoadAdvancedScenario').disabled = false;
    UI.toast(`✅ تم تحميل السيناريو المتقدم (${result.productsSeeded} منتج + حالة غير متطابقة)`);
    state.date = result.date;
    picker.value = state.date;
    await refresh();
  };

  document.getElementById('btnToggleComparison').onclick = () => {
    const el = document.getElementById('fullComparisonCard');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  };
  document.getElementById('btnToggleMore').onclick = () => {
    const el = document.getElementById('moreDetailsSection');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  };
  document.getElementById('btnViewAllOutgoing').onclick = () => {
    state.showAllOutgoing = !state.showAllOutgoing;
    refresh();
  };
  document.getElementById('btnViewAllNoMovement').onclick = () => {
    state.showAllNoMovement = !state.showAllNoMovement;
    refresh();
  };
  document.getElementById('btnViewAllOrders').onclick = () => {
    state.showAllOrders = !state.showAllOrders;
    refresh();
  };
  document.getElementById('searchProduct').oninput = (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderFullComparison(lastFullComparison);
  };

  document.getElementById('btnDailyReport').onclick = toggleDailyReport;
  document.getElementById('btnCloseDailyReport').onclick = () => (document.getElementById('dailyReportCard').style.display = 'none');

  document.getElementById('btnCancelPreview').onclick = closePreviewModal;
  document.getElementById('btnReprocessMapping').onclick = reprocessMapping;
  document.getElementById('btnConfirmImport').onclick = confirmImportFlow;
  document.getElementById('previewModalOverlay').onclick = (e) => {
    if (e.target.id === 'previewModalOverlay') closePreviewModal();
  };

  products = await Products.all();
  await refresh();
}

async function refresh() {
  document.getElementById('dateLabel').textContent = `عرض بيانات بتاريخ ${state.date}`;

  const [summary, reconciliation, lowOut, highDemand, outgoing, movementLog, unmatched, fullComparison, noMovement, declining, orders] = await Promise.all([
    getWarehouseSummary(state.date),
    getReconciliation(state.date),
    getLowStockAndOutOfStock(state.date),
    getHighDemandProducts(state.date),
    getTodaysOutgoing(state.date),
    InventoryMovementLog.forDate(state.date),
    getUnresolvedUnmatched(),
    getFullComparison(state.date),
    getNoMovementWithStreaks(state.date),
    getDecliningOutgoing(state.date),
    getOrdersComparison(state.date),
  ]);
  products = await Products.all();
  lastFullComparison = fullComparison;

  renderSimpleHeadline(summary, reconciliation, declining);
  renderOutgoing(outgoing);
  renderNoMovement(noMovement);
  renderDeclining(declining);
  renderOrders(orders);
  renderWarehouseSummary(summary);
  renderFullComparison(fullComparison);
  renderAlerts(lowOut, highDemand);
  renderReconciliationBanner(reconciliation);
  renderUnmatched(unmatched);
  renderMovementLog(movementLog);
  if (document.getElementById('dailyReportCard').style.display !== 'none') renderDailyReport();
}

// ---------------------------------------------------------------------------
// 1. الأرقام الأساسية — أول حاجة تتشاف، أربع أرقام بس (spec section 3).
// ---------------------------------------------------------------------------

function renderSimpleHeadline(summary, reconciliation, declining) {
  const tiles = [
    ['📦 خرج النهارده', `${summary.totalUnitsOutToday} قطعة`],
    ['🛒 الأوردرات النهارده', `${reconciliation.ordersToday} أوردر`],
    ['🚫 مخرجش النهارده', `${summary.productsWithNoMovement} منتجات`],
    ['📉 منتجات نازلة', `${declining.length} منتجات`],
    ['📊 إجمالي المخزون الحالي', summary.totalUnitsAvailable],
  ];
  document.getElementById('simpleHeadline').innerHTML = tiles
    .map(([label, value]) => UI.statTile(label, value))
    .join('');
}

function goToProduct(productId) {
  window.location.href = `product.html?id=${productId}`;
}

// ---------------------------------------------------------------------------
// Alerts (spec section 6)
// ---------------------------------------------------------------------------

function renderAlerts(lowOut, highDemand) {
  const el = document.getElementById('inventoryAlerts');
  const banners = [];
  for (const s of lowOut.outOfStock) {
    banners.push(`<div class="perf-alert-banner">🔴 نفد من المخزون: ${UI.escapeHtml(s.product_name)} غير متوفر حاليًا في المخزون.</div>`);
  }
  for (const s of lowOut.lowStock) {
    banners.push(`<div class="perf-alert-banner">⚠️ تنبيه مخزون منخفض: ${UI.escapeHtml(s.product_name)} متبقي منه ${s.closing_stock} وحدة فقط.</div>`);
  }
  for (const s of highDemand) {
    banners.push(
      `<div class="perf-alert-banner positive">🔥 طلب مرتفع: ${UI.escapeHtml(s.product_name)} شهد خروج وحدات أعلى من المعتاد اليوم (${s.yesterdayOut ?? 0} أمس ← ${s.units_out} اليوم).</div>`
    );
  }
  el.innerHTML = banners.join('') || '<div class="empty-state">لا توجد تنبيهات مخزون اليوم. 👍</div>';
}

function renderReconciliationBanner(reconciliation) {
  const el = document.getElementById('reconciliationBanner');
  if (!reconciliation.message) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<div class="perf-alert-banner">${reconciliation.message} (أوردرات اليوم: ${reconciliation.ordersToday} — وحدات خارجة: ${reconciliation.unitsOutToday})</div>`;
}

// ---------------------------------------------------------------------------
// 📦 Today's Outgoing (spec section 4) — sorted highest-first, one click
// into the product's full detail (spec section 10 / 11).
// ---------------------------------------------------------------------------

function renderOutgoing(outgoing) {
  const total = outgoing.reduce((sum, s) => sum + (s.units_out || 0), 0);
  document.getElementById('outgoingTitle').textContent = `📦 خرج النهارده — إجمالي: ${total} قطعة`;
  const btn = document.getElementById('btnViewAllOutgoing');
  btn.textContent = state.showAllOutgoing ? 'أهم 5 بس' : 'عرض الكل';
  btn.style.display = outgoing.length > TOP_N ? 'inline-flex' : 'none';
  const shown = state.showAllOutgoing ? outgoing : outgoing.slice(0, TOP_N);
  const body = document.getElementById('outgoingBody');
  if (outgoing.length === 0) {
    body.innerHTML = '<div class="empty-state">لا توجد منتجات خرجت من المخزون اليوم بعد.</div>';
    return;
  }
  body.innerHTML = shown
    .map((s) => {
      const status = classifyStatusIcon(s.closing_stock, s.units_out);
      return `
    <div class="action-card" data-goto="${s.product_id}" style="cursor:pointer;">
      <div class="action-card-title">${status} ${UI.escapeHtml(s.product_name)} ← ${s.units_out} قطعة</div>
      <div class="action-card-metrics">
        <span>مخزون أمس: ${s.opening_stock ?? '—'}</span>
        <span>مخزون النهارده: ${s.closing_stock}</span>
        <span style="color:var(--red); font-weight:700;">📦 خرج: ${s.units_out} قطعة</span>
      </div>
    </div>`;
    })
    .join('');
  wireGotoCards(body);
}

function wireGotoCards(container) {
  container.querySelectorAll('[data-goto]').forEach((el) => (el.onclick = () => goToProduct(el.dataset.goto)));
}

// Local, dependency-free mirror of inventory-tracker.js's classifyProductStatus icon —
// avoids importing the whole module just for four emoji.
function classifyStatusIcon(currentStock, unitsOut) {
  if (currentStock === 0) return '🔴';
  const out = unitsOut || 0;
  if (out === 0) return '⚪';
  if (out >= 15) return '🔥';
  if (out >= 6) return '🟢';
  return '🟡';
}

// ---------------------------------------------------------------------------
// ⏸️ بدون حركة اليوم (spec sections 5-6)
// ---------------------------------------------------------------------------

function renderNoMovement(noMovement) {
  const btn = document.getElementById('btnViewAllNoMovement');
  btn.textContent = state.showAllNoMovement ? 'أهم 5 بس' : 'عرض الكل';
  btn.style.display = noMovement.length > TOP_N ? 'inline-flex' : 'none';
  const shown = state.showAllNoMovement ? noMovement : noMovement.slice(0, TOP_N);
  const body = document.getElementById('noMovementBody');
  if (noMovement.length === 0) {
    body.innerHTML = '<div class="empty-state">كل المنتجات خرج منها حاجة النهارده. 👍</div>';
    return;
  }
  body.innerHTML = shown
    .map(
      (s) => `
    <div class="action-card" data-goto="${s.product_id}" style="cursor:pointer;">
      <div class="action-card-title">🚫 ${UI.escapeHtml(s.product_name)} — مخرجش النهارده</div>
      <div class="action-card-metrics">
        <span class="mono">أمس ${s.opening_stock ?? s.closing_stock} ← النهارده ${s.closing_stock}</span>
        <span>${s.alertLevel.icon} ${s.alertLevel.label} — ${s.streak} ${s.streak === 1 ? 'يوم' : 'أيام'} متتالية بدون حركة</span>
      </div>
    </div>`
    )
    .join('');
  wireGotoCards(body);
}

// ---------------------------------------------------------------------------
// 📉 كان بيخرج كتير وبقى قليل (spec section 5)
// ---------------------------------------------------------------------------

function renderDeclining(declining) {
  const card = document.getElementById('decliningCard');
  card.style.display = declining.length > 0 ? 'block' : 'none';
  if (declining.length === 0) return;
  document.getElementById('decliningBody').innerHTML = declining
    .map(
      (s) => `
    <div class="action-card" data-goto="${s.product_id}" style="cursor:pointer;">
      <div class="action-card-title">📉 ${UI.escapeHtml(s.product_name)}</div>
      <div class="action-card-metrics">
        <span>أمس: ${s.yesterdayOut} قطعة</span>
        <span>النهارده: ${s.units_out} قطعة</span>
        <span style="color:var(--red); font-weight:700;">📉 نازل ${s.drop} قطعة</span>
      </div>
    </div>`
    )
    .join('');
  wireGotoCards(document.getElementById('decliningBody'));
}

// ---------------------------------------------------------------------------
// 🛒 الأوردرات (spec section 6) — نفس المنتج، مربوط بنظام الأوردرات الموجود
// ---------------------------------------------------------------------------

function renderOrders(orders) {
  const card = document.getElementById('ordersCard');
  const withData = orders.filter((o) => o.yesterdayOrders !== null || o.todayOrders !== null);
  card.style.display = withData.length > 0 ? 'block' : 'none';
  if (withData.length === 0) return;

  const btn = document.getElementById('btnViewAllOrders');
  btn.textContent = state.showAllOrders ? 'أهم 5 بس' : 'عرض الكل';
  btn.style.display = withData.length > TOP_N ? 'inline-flex' : 'none';
  const sorted = [...withData].sort((a, b) => Math.abs(b.diff || 0) - Math.abs(a.diff || 0));
  const shown = state.showAllOrders ? sorted : sorted.slice(0, TOP_N);

  document.getElementById('ordersBody').innerHTML = shown
    .map((o) => {
      const diffText = o.diff === null ? '—' : o.diff > 0 ? `📈 +${o.diff}` : o.diff < 0 ? `📉 ${o.diff}` : '➖ 0';
      return `
    <div class="action-card" data-goto="${o.product_id}" style="cursor:pointer;">
      <div class="action-card-title">${o.combinedStatus.icon} ${UI.escapeHtml(o.product_name)}</div>
      <div class="action-card-metrics">
        <span class="mono">${o.yesterdayOrders ?? '—'} → ${o.todayOrders ?? '—'}</span>
        <span style="font-weight:700;">${diffText} أوردر</span>
        <span>${o.combinedStatus.label}</span>
      </div>
    </div>`;
    })
    .join('');
  wireGotoCards(document.getElementById('ordersBody'));
}

// ---------------------------------------------------------------------------
// 🔄 مقارنة المخزون — كل المنتجات (spec section 9) — مطويّة افتراضيًا
// ---------------------------------------------------------------------------

function renderFullComparison(rows) {
  const body = document.getElementById('fullComparisonBody');
  const filtered = state.search ? rows.filter((s) => s.product_name.toLowerCase().includes(state.search)) : rows;
  if (filtered.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="empty-state">${state.search ? 'لا يوجد منتج مطابق للبحث.' : 'لا توجد بيانات مخزون بعد.'}</td></tr>`;
    return;
  }
  body.innerHTML = filtered
    .map((s) => {
      const outCell = !s.tracked ? '—' : s.movement_type === 'OUT' ? '📦 ' + s.units_out : '⏸️ 0';
      return `
    <tr data-goto="${s.product_id}" style="cursor:pointer; ${!s.tracked ? 'opacity:0.6;' : ''}">
      <td>${UI.escapeHtml(s.product_name)}</td>
      <td class="num mono">${s.opening_stock ?? '—'}</td>
      <td class="num mono">${s.closing_stock ?? '—'}</td>
      <td class="num">${outCell}</td>
      <td>${s.status.icon} ${s.status.label}</td>
    </tr>`;
    })
    .join('');
  wireGotoCards(body);
}

// ---------------------------------------------------------------------------
// 📊 Today's Warehouse Activity (spec section 4)
// ---------------------------------------------------------------------------

function renderWarehouseSummary(summary) {
  // spec section 8's exact 5 items — the headline above already covers
  // total-out/moved/no-movement/total-stock, so this card adds only what's
  // new: low stock + out of stock (still calculated, never hardcoded).
  const stats = [
    ['📦 إجمالي الوحدات الخارجة', summary.totalUnitsOutToday],
    ['📋 منتجات تحركت', summary.productsWithMovement],
    ['⏸️ منتجات بدون حركة', summary.productsWithNoMovement],
    ['⚠️ مخزون منخفض', summary.lowStockProducts],
    ['🔴 نفد من المخزون', summary.outOfStockProducts],
  ];
  document.getElementById('warehouseSummaryBody').innerHTML = stats.map(([label, value]) => `<span>${label}: <b class="mono">${value}</b></span>`).join('');
}

// ---------------------------------------------------------------------------
// ❓ Unmatched Products (spec section 10)
// ---------------------------------------------------------------------------

function renderUnmatched(unmatched) {
  const card = document.getElementById('unmatchedCard');
  card.style.display = unmatched.length > 0 ? 'block' : 'none';
  if (unmatched.length === 0) return;

  const productOptions = products
    .filter((p) => !p.is_demo)
    .slice()
    .sort((a, b) => a.product_name.localeCompare(b.product_name, 'ar'))
    .map((p) => `<option value="${p.id}">${UI.escapeHtml(p.product_name)}</option>`)
    .join('');

  document.getElementById('unmatchedBody').innerHTML = unmatched
    .map(
      (u, i) => `
    <div class="action-card" data-unmatched="${i}">
      <div class="action-card-title">❓ ${UI.escapeHtml(u.excelName)}</div>
      <div class="action-card-metrics"><span>الكمية بالملف: ${u.quantity}</span><span class="faint">من ملف بتاريخ ${u.batchDate}</span></div>
      <div class="toolbar" style="margin-top:8px;">
        <select data-connect-select style="max-width:260px;"><option value="">— اختر المنتج الصحيح —</option>${productOptions}</select>
        <button class="btn secondary small" data-connect-btn>🔗 ربط</button>
      </div>
    </div>`
    )
    .join('');

  document.querySelectorAll('[data-unmatched]').forEach((card2) => {
    const idx = Number(card2.dataset.unmatched);
    card2.querySelector('[data-connect-btn]').onclick = async () => {
      const select = card2.querySelector('[data-connect-select]');
      if (!select.value) {
        UI.toast('اختر منتج أولًا', 'error');
        return;
      }
      await connectUnmatchedProduct(unmatched[idx].excelName, Number(select.value));
      UI.toast('✅ تم ربط المنتج — هيتطابق تلقائيًا في المرات الجاية');
      await refresh();
    };
  });
}

// ---------------------------------------------------------------------------
// 📜 Inventory Movement Log (spec section 8)
// ---------------------------------------------------------------------------

function renderMovementLog(entries) {
  const body = document.getElementById('movementLogBody');
  if (entries.length === 0) {
    body.innerHTML = '<div class="empty-state">لا يوجد حركة مخزون مسجّلة اليوم.</div>';
    return;
  }
  body.innerHTML = entries
    .map((e) => {
      const type = MOVEMENT_TYPES[e.movement_type] || MOVEMENT_TYPES.UNKNOWN;
      const dt = new Date(e.created_at);
      const time = dt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
      return `
      <div class="alert-card" style="border-inline-start-color: var(--accent);">
        <div class="alert-meta" style="margin-bottom:4px;"><span class="mono">🕒 ${time}</span> <b>${UI.escapeHtml(e.product_name)}</b></div>
        <div>${type.icon} ${type.label} — من ${e.previous_qty ?? '—'} إلى ${e.new_qty} (${UI.fmtChangeAbs(e.diff)})</div>
        ${e.notes ? `<div class="faint" style="font-size:12px; margin-top:4px;">📝 ${UI.escapeHtml(e.notes)}</div>` : ''}
        <div class="faint" style="font-size:11px; margin-top:4px;">بواسطة: ${UI.escapeHtml(e.updated_by || '—')}</div>
      </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// 📋 Daily Inventory Report (spec section 14)
// ---------------------------------------------------------------------------

function toggleDailyReport() {
  const card = document.getElementById('dailyReportCard');
  const showing = card.style.display !== 'none';
  card.style.display = showing ? 'none' : 'block';
  if (!showing) renderDailyReport();
}

async function renderDailyReport() {
  const report = await buildDailyInventoryReport(state.date);
  const lines = [];
  lines.push(`📋 تقرير المخزون اليومي — ${report.date}`);
  lines.push('');
  lines.push(`إجمالي المنتجات: ${report.summary.totalProducts}`);
  lines.push(`منتجات بها حركة: ${report.summary.productsWithMovement}`);
  lines.push(`إجمالي الوحدات الخارجة: ${report.summary.totalUnitsOutToday}`);
  lines.push(`إجمالي الوحدات المتاحة: ${report.summary.totalUnitsAvailable}`);
  lines.push(`منتجات بدون حركة: ${report.summary.productsWithNoMovement}`);
  lines.push(`منتجات مخزونها منخفض: ${report.summary.lowStockProducts}`);
  lines.push('');
  if (report.top.length > 0) {
    lines.push('———  🏆 أعلى المنتجات خروجًا  ———');
    const medals = ['🥇', '🥈', '🥉'];
    report.top.forEach((s, i) => lines.push(`${medals[i] || '•'} ${s.product_name} — ${s.units_out} وحدة خارجة`));
    lines.push('');
  }
  if (report.stockAdded.length > 0) {
    lines.push('———  📥 مخزون مضاف  ———');
    for (const s of report.stockAdded) lines.push(`${s.product_name}: +${s.stock_change}`);
    lines.push('');
  }
  if (report.returned.length > 0) {
    lines.push('———  ↩️ مرتجعات  ———');
    for (const s of report.returned) lines.push(`${s.product_name}: +${s.stock_change}`);
    lines.push('');
  }
  if (report.damaged.length > 0) {
    lines.push('———  💥 تالف  ———');
    for (const s of report.damaged) lines.push(`${s.product_name}: ${s.stock_change}`);
    lines.push('');
  }
  if (report.reconciliation.message) {
    lines.push('———  ⚖️ مطابقة الأوردرات بالمخزون  ———');
    lines.push(report.reconciliation.message);
  }

  const text = lines.join('\n');
  document.getElementById('dailyReportBody').textContent = text;
  await DailyReports.save(state.date, 'INVENTORY', { totalUnitsOutToday: report.summary.totalUnitsOutToday }, text);
}

// ---------------------------------------------------------------------------
// Import preview modal (spec sections 9, 11)
// ---------------------------------------------------------------------------

async function runPreview(mappingOverride) {
  currentPreview = await previewImport(rawCsvText, state.date, mappingOverride);
  openPreviewModal();
}

function openPreviewModal() {
  const p = currentPreview;
  const fill = (id, selected) => {
    const el = document.getElementById(id);
    const opts = p.headers.map((h) => `<option value="${UI.escapeHtml(h)}" ${h === selected ? 'selected' : ''}>${UI.escapeHtml(h)}</option>`).join('');
    el.innerHTML = (id === 'mapSku' || id === 'mapWarehouse' ? '<option value="">— غير متاح —</option>' : '') + opts;
  };
  fill('mapProductName', p.mapping?.productName);
  fill('mapQuantity', p.mapping?.quantity);
  fill('mapSku', p.mapping?.sku);
  fill('mapWarehouse', p.mapping?.warehouse);

  document.getElementById('previewSummary').innerHTML = `
    <span>📄 إجمالي الصفوف: <b>${p.totalRows}</b></span> ·
    <span style="color:var(--green)">✅ متطابقة: <b>${p.matched.length}</b></span> ·
    <span style="color:var(--yellow)">❓ غير متطابقة: <b>${p.unmatched.length}</b></span> ·
    <span style="color:var(--red)">⚠️ غير صالحة: <b>${p.invalid.length}</b></span> ·
    <span>🔁 مكررة: <b>${p.duplicates.length}</b></span>`;

  const issues = [];
  if (p.invalid.length > 0) {
    issues.push(`<div class="perf-alert-banner">⚠️ ${p.invalid.length} صف به بيانات غير صالحة ولن يتم استيراده: ${p.invalid.slice(0, 5).map((r) => `صف ${r.rowNumber} (${UI.escapeHtml(r.reason)})`).join('، ')}${p.invalid.length > 5 ? '...' : ''}</div>`);
  }
  if (p.duplicates.length > 0) {
    issues.push(`<div class="perf-alert-banner">🔁 أسماء مكررة داخل نفس الملف: ${p.duplicates.map((d) => UI.escapeHtml(d)).join('، ')}</div>`);
  }
  document.getElementById('previewIssues').innerHTML = issues.join('');

  const rows = [...p.matched.map((r) => ({ ...r, isMatched: true })), ...p.unmatched.map((r) => ({ ...r, isMatched: false }))].slice(0, 100);
  document.getElementById('previewTableBody').innerHTML = rows
    .map((r) => {
      if (r.isMatched) {
        const m = r.movement;
        const type = MOVEMENT_TYPES[m.type] || MOVEMENT_TYPES.UNKNOWN;
        return `<tr><td>${UI.escapeHtml(r.excelName)}</td><td class="num">${r.quantity}</td><td>${UI.escapeHtml(r.productName)}</td><td class="faint">${r.matchMethod}</td><td>${type.icon} ${type.label}${m.type === 'OUT' ? ` (-${m.unitsOut})` : m.stockChange ? ` (${UI.fmtChangeAbs(m.stockChange)})` : ''}</td></tr>`;
      }
      return `<tr style="color:var(--yellow)"><td>${UI.escapeHtml(r.excelName)}</td><td class="num">${r.quantity}</td><td colspan="2">❓ غير متطابق</td><td>—</td></tr>`;
    })
    .join('');

  document.getElementById('previewModalOverlay').style.display = 'flex';
}

function closePreviewModal() {
  document.getElementById('previewModalOverlay').style.display = 'none';
}

async function reprocessMapping() {
  const mapping = {
    productName: document.getElementById('mapProductName').value,
    quantity: document.getElementById('mapQuantity').value,
    sku: document.getElementById('mapSku').value || null,
    warehouse: document.getElementById('mapWarehouse').value || null,
  };
  await runPreview(mapping);
}

async function confirmImportFlow() {
  if (currentPreview.matched.length === 0) {
    UI.toast('لا توجد صفوف متطابقة للاستيراد', 'error');
    return;
  }
  await confirmImport(currentPreview, { uploadedBy: 'admin', filename: currentFilename });
  UI.toast(`✅ تم استيراد ${currentPreview.matched.length} منتج`);
  closePreviewModal();
  await refresh();
}

init();
