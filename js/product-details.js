// product-details.js — page controller for product.html.
// V1: spec sections 15-16 (Performance + Orders chart).
// V2: sections 11-12 (Financial, Inventory, Profit/Revenue/Stock charts —
// a chart is only rendered when there is real historical data behind it;
// spec section 12 explicitly forbids a fabricated chart).
import { Products, DailyOrders, Settings, ProductNotes, ActionLog, ACTION_STATUS } from './db.js';
import * as A from './analytics.js';
import * as UI from './ui-common.js';
import { renderLineChart } from './charts.js';
import { buildProductBundle } from './product-bundle.js';
import { classifyDailyStatus } from './daily-monitor.js';
import { analyzeProductDecision, buildFollowUp } from './decision-engine.js';
import { getProductInventoryHistory } from './inventory-store.js';
import { MOVEMENT_TYPES, combinedProductStatus } from './inventory-tracker.js';

const POSSIBLE_CAUSES = [
  'انخفاض أداء الإعلان',
  'تغيّر السعر',
  'العرض انتهى',
  'نفاد جزئي في المخزون',
  'مشاكل في صفحة المنتج',
  'تغيّر سلوك العملاء',
];

let currentProductId = null;
let currentProduct = null;
let currentRecords = [];
let currentSettings = null;

async function init() {
  UI.renderSidebar('products');
  const id = Number(UI.qs('id'));
  if (!id) {
    document.querySelector('.main').innerHTML = '<div class="empty-state">منتج غير موجود.</div>';
    return;
  }
  currentProductId = id;

  const [product, settings, records] = await Promise.all([Products.get(id), Settings.get(), DailyOrders.forProduct(id)]);
  // 🧪 Demo orders included on purpose — clicking into a product from the
  // Dashboard must show the SAME numbers that produced its Dashboard
  // classification. A real entry for a given date always reclaims it from
  // demo status (see DailyOrders.upsert).

  if (!product) {
    document.querySelector('.main').innerHTML = '<div class="empty-state">منتج غير موجود.</div>';
    return;
  }

  const asOfDate = A.todayStr();
  currentProduct = product;
  currentRecords = records;
  currentSettings = settings;
  const { a, profit, inventory, v2, score } = buildProductBundle(product, records, asOfDate, settings);
  const dailyStatus = classifyDailyStatus(a, settings);
  const decision = analyzeProductDecision(a, dailyStatus, v2.type, inventory);

  document.getElementById('productName').textContent = product.product_name;
  document.getElementById('productMeta').innerHTML = `رمز المنتج: <span class="mono">${UI.escapeHtml(product.sku || '—')}</span> · سعر البيع: ${Number(product.selling_price || 0).toFixed(2)} · التكلفة: ${Number(product.product_cost || 0).toFixed(2)} · ${product.active ? '<span class="badge green">نشط</span>' : '<span class="badge gray">غير نشط</span>'}`;
  document.getElementById('recPillWrap').innerHTML = UI.recPill(v2.type);

  if (a.isNew) {
    document.getElementById('newBadge').style.display = 'inline-flex';
    document.getElementById('newProductNotice').style.display = 'block';
  }

  // --- Performance ---
  const tiles = [
    { label: 'اليوم', value: UI.fmtNum(a.today) },
    { label: 'إجمالي الأوردرات', value: a.totalOrders },
    { label: 'المتوسط العام', value: UI.fmtAvg(a.avgAllTime) },
    { label: 'أفضل يوم', value: a.bestDay ? `${a.bestDay.orders_count} (${a.bestDay.date})` : '—' },
    { label: 'أسوأ يوم', value: a.worstDay ? `${a.worstDay.orders_count} (${a.worstDay.date})` : '—' },
    { label: 'معدل 7 أيام', value: UI.fmtAvg(a.avg7) },
    { label: 'معدل 14 يوم', value: UI.fmtAvg(a.avg14) },
    { label: 'معدل 30 يوم', value: UI.fmtAvg(a.avg30) },
    { label: 'الاتجاه الحالي', value: UI.trendLabel(a.trend) },
    { label: 'الحالة', value: UI.statusBadge(a.status) },
  ];
  document.getElementById('statTiles').innerHTML = tiles
    .map((t) => `<div class="stat-tile"><div class="label">${t.label}</div><div class="value" style="font-size:18px">${t.value}</div></div>`)
    .join('');

  // --- Financial (V2) ---
  const financialTiles = [
    { label: 'أقصى تكلفة أوردر مربحة', value: profit.breakEvenCPA !== null ? UI.fmtCurrency(profit.breakEvenCPA) : 'البيانات غير متوفرة' },
    { label: 'تكلفة الأوردر الحالية', value: UI.fmtCurrency(profit.currentCPA) },
    { label: 'الحالة', value: UI.cpaStatusBadge(profit.cpaStatus) },
    { label: 'ربح الأوردر', value: UI.fmtCurrency(profit.profitPerOrder) },
    { label: 'إجمالي المبيعات (آخر فترة رصدها)', value: UI.fmtCurrency(profit.revenueRecent) },
    { label: 'صافي الربح (آخر فترة رصدها)', value: UI.fmtCurrency(profit.profitRecent) },
    { label: 'إجمالي المبيعات الكلي', value: UI.fmtCurrency(profit.revenueTotal) },
    { label: 'صافي الربح الكلي', value: UI.fmtCurrency(profit.profitTotal) },
    { label: 'نسبة المرتجعات الفعلية', value: profit.returnRate !== null ? `${profit.returnRate.toFixed(1)}%` : 'لا تتوفر بيانات تسليم/مرتجع بعد' },
    { label: 'تقييم المنتج', value: score ? `${score.score}/100 — ${UI.scoreLabelAr(score.label)}` : 'البيانات غير متوفرة' },
  ];
  document.getElementById('financialTiles').innerHTML = financialTiles
    .map((t) => `<div class="stat-tile"><div class="label">${t.label}</div><div class="value" style="font-size:16px">${t.value}</div></div>`)
    .join('');

  // --- Inventory (V2) ---
  const inventoryTiles = inventory.hasStockData
    ? [
        { label: 'الكمية الحالية', value: inventory.currentStock },
        { label: 'الحد الأدنى', value: inventory.minimumStock ?? '—' },
        { label: 'متوسط المبيعات اليومي', value: inventory.dailyAverageSales !== null ? inventory.dailyAverageSales.toFixed(1) : 'لا تتوفر بيانات مبيعات بعد' },
        { label: 'الأيام المتبقية', value: inventory.daysRemaining !== null ? inventory.daysRemaining.toFixed(1) : 'غير محسوب (لا مبيعات مسجلة)' },
        { label: 'حالة المخزون', value: UI.stockStatusBadge(inventory.status, inventory.daysRemaining) },
        { label: 'المورّد', value: inventory.supplier || '—' },
        { label: 'كمية إعادة الطلب', value: inventory.restockQuantity ?? '—' },
        { label: 'آخر إعادة طلب', value: inventory.lastRestockDate || '—' },
      ]
    : [{ label: 'المخزون', value: 'غير متتبَّع لهذا المنتج' }];
  document.getElementById('inventoryTiles').innerHTML = inventoryTiles
    .map((t) => `<div class="stat-tile"><div class="label">${t.label}</div><div class="value" style="font-size:16px">${t.value}</div></div>`)
    .join('');

  // --- Charts ---
  const map = A.buildOrdersMap(records);
  const orderPoints = [];
  for (let i = 29; i >= 0; i--) {
    const d = A.addDays(asOfDate, -i);
    orderPoints.push({ date: d, value: A.getValue(map, d) });
  }
  renderLineChart(document.getElementById('chartContainer'), orderPoints);

  // Revenue/Profit charts are derived from REAL daily order counts — only
  // rendered when the product actually has a selling price / a computable
  // per-order profit, never a fabricated shape.
  const sellingPrice = Number(product.selling_price) || 0;
  if (sellingPrice > 0) {
    const revenuePoints = orderPoints.map((p) => ({ date: p.date, value: p.value !== null ? p.value * sellingPrice : null }));
    renderLineChart(document.getElementById('revenueChartContainer'), revenuePoints);
  } else {
    document.getElementById('revenueChartContainer').innerHTML = '<div class="empty-state">لا يوجد سعر بيع مسجَّل — لا يمكن حساب الإيرادات.</div>';
  }

  if (profit.profitPerOrder !== null) {
    const profitPoints = orderPoints.map((p) => ({ date: p.date, value: p.value !== null ? p.value * profit.profitPerOrder : null }));
    renderLineChart(document.getElementById('profitChartContainer'), profitPoints);
  } else {
    document.getElementById('profitChartContainer').innerHTML = '<div class="empty-state">أضف تكاليف المنتج وتكلفة الأوردر الحالية من صفحة المنتجات لعرض الربح اليومي.</div>';
  }

  // Historical stock levels now come from the Daily Stock Tracking module's
  // inventory_snapshots — real day-by-day counts from the uploaded
  // inventory file, not fabricated (spec section 5: per-product history).
  const stockHistory = await getProductInventoryHistory(id);
  if (stockHistory.length > 0) {
    const stockPoints = stockHistory.map((s) => ({ date: s.date, value: s.closing_stock }));
    renderLineChart(document.getElementById('stockChartContainer'), stockPoints);

    const trendNote =
      stockHistory.length >= 2
        ? (() => {
            const totalOut = stockHistory.reduce((sum, s) => sum + (s.movement_type === 'OUT' ? s.units_out || 0 : 0), 0);
            const days = stockHistory.length;
            const avgOut = totalOut / days;
            return avgOut >= 10 ? '📈 المنتج بيتحرك بسرعة (متوسط خروج مرتفع يوميًا)' : avgOut > 0 ? '➖ المنتج بيتحرك بمعدل متوسط' : '🐌 المنتج بطيء الحركة — تقريبًا مفيش خروج مسجّل';
          })()
        : '';

    document.getElementById('inventoryHistoryBody').innerHTML = `
      ${trendNote ? `<div class="faint" style="margin-bottom:10px;">${trendNote}</div>` : ''}
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>التاريخ</th><th>المخزون الافتتاحي</th><th>المخزون الختامي</th><th>الحركة</th></tr></thead>
          <tbody>
            ${stockHistory
              .slice()
              .reverse()
              .map((s) => {
                const type = MOVEMENT_TYPES[s.movement_type] || MOVEMENT_TYPES.UNKNOWN;
                return `<tr><td class="mono">${s.date}</td><td class="num">${s.opening_stock ?? '—'}</td><td class="num">${s.closing_stock}</td><td>${type.icon} ${type.label}${s.movement_type === 'OUT' ? ` (-${s.units_out})` : s.stock_change ? ` (${UI.fmtChangeAbs(s.stock_change)})` : ''}</td></tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>`;
  } else {
    document.getElementById('stockChartContainer').innerHTML =
      '<div class="empty-state">لا تتوفر بيانات تاريخية للمخزون بعد — ارفع ملف مخزون من صفحة 🏭 إدارة المخزون لبدء التتبع اليومي.</div>';
    document.getElementById('inventoryHistoryBody').innerHTML = '<div class="empty-state">لا يوجد سجل حركة مخزون لهذا المنتج بعد.</div>';
  }

  // 📦🛒 Combined overview — one glance connecting inventory and orders for
  // the SAME product (same product_id everywhere), matching the exact
  // worked-example shape from the spec (stock y/t, خرج النهارده, orders
  // y/t, one overall status). Only shown when there's at least one real
  // number to show — never a fabricated "—" wall for an untracked product.
  const yesterdayDate = A.addDays(asOfDate, -1);
  const todaySnap = stockHistory.find((s) => s.date === asOfDate) || null;
  const yesterdaySnap = stockHistory.find((s) => s.date === yesterdayDate) || null;
  const ordersToday = A.getValue(map, asOfDate);
  const ordersYesterday = A.getValue(map, yesterdayDate);
  const hasAnyData = todaySnap || yesterdaySnap || ordersToday !== null || ordersYesterday !== null;

  if (hasAnyData) {
    const unitsOutToday = todaySnap && todaySnap.movement_type === 'OUT' ? todaySnap.units_out : 0;
    const hasInventoryMovement = !!(todaySnap && todaySnap.movement_type === 'OUT');
    const ordersDiff = ordersToday !== null && ordersYesterday !== null ? ordersToday - ordersYesterday : null;
    const status = combinedProductStatus(hasInventoryMovement, ordersDiff);
    const overviewTiles = [
      { label: 'المخزون أمس', value: yesterdaySnap ? yesterdaySnap.closing_stock : '➖ لسه معملوش تتبع' },
      { label: 'المخزون النهارده', value: todaySnap ? todaySnap.closing_stock : '➖ لسه معملوش تتبع' },
      { label: 'خرج النهارده', value: todaySnap ? `${unitsOutToday} قطعة` : '➖ لسه معملوش تتبع' },
      { label: 'الأوردرات أمس', value: ordersYesterday !== null ? ordersYesterday : '➖' },
      { label: 'الأوردرات النهارده', value: ordersToday !== null ? ordersToday : '➖' },
      { label: 'الحالة العامة', value: `${status.icon} ${status.label}` },
    ];
    document.getElementById('combinedOverviewCard').style.display = 'block';
    document.getElementById('combinedOverviewBody').innerHTML = `<div class="stat-grid">${overviewTiles
      .map((t) => `<div class="stat-tile"><div class="label">${t.label}</div><div class="value" style="font-size:16px">${t.value}</div></div>`)
      .join('')}</div>`;
  }

  document.getElementById('recBlock').innerHTML = `
    <div style="margin-bottom:10px">${UI.recPill(v2.type)}</div>
    <ul style="margin:0; padding-inline-start:20px; line-height:1.9;">
      ${v2.reasons.map((r) => `<li>${UI.escapeHtml(UI.translateReason(r))}</li>`).join('')}
    </ul>
  `;

  document.getElementById('healthBlock').innerHTML = `
    <div style="font-size:32px; font-weight:700; margin-bottom:6px;">${a.health.score}<span class="faint" style="font-size:16px">/100</span></div>
    <div class="badge ${UI.healthColor(a.health.score)}" style="margin-bottom:12px;">${UI.scoreLabelAr(a.health.label)}</div>
    <div class="health-bar-track" style="width:100%; height:10px;"><div class="health-bar-fill" style="width:${a.health.score}%; background:${a.health.score>=60?'var(--green)':a.health.score>=40?'var(--yellow)':'var(--red)'}"></div></div>
  `;

  const sortedRecords = [...records].sort((x, y) => (x.date < y.date ? 1 : -1));
  document.getElementById('historyBody').innerHTML = sortedRecords
    .map(
      (r) => `
      <tr>
        <td class="mono">${r.date}</td>
        <td class="num">${r.orders_count}</td>
        <td class="num">${r.delivered_count ?? '<span class="faint">—</span>'}</td>
        <td class="num">${r.returned_count ?? '<span class="faint">—</span>'}</td>
        <td class="faint">${UI.escapeHtml(r.notes || '')}</td>
      </tr>`
    )
    .join('');

  // --- Possible causes (spec section 42) — the system never claims to
  // KNOW the cause, only lists what commonly explains a decline. Shown
  // only when the product is actually declining today.
  const decliningCodes = ['STOPPED', 'SHARP_DECLINE', 'EARLY_DECLINE', 'DECLINING', 'WATCH'];
  if (decliningCodes.includes(dailyStatus.code)) {
    document.getElementById('causesCard').style.display = 'block';
    document.getElementById('causesBody').innerHTML = `
      <div class="muted" style="font-size:13px; margin-bottom:10px;">
        الأوردرات ${UI.fmtPct(a.baseline.pct)} عن المعدل الطبيعي. النظام لا يجزم بالسبب، لكن هذه أسباب محتملة يستحق مراجعتها:
      </div>
      <ul style="margin:0; padding-inline-start:20px; line-height:1.9;">
        ${POSSIBLE_CAUSES.map((c) => `<li>${UI.escapeHtml(c)}</li>`).join('')}
      </ul>`;
  }

  await renderDecision(a, decision, asOfDate, settings);
  await renderDecisionHistory();

  await renderNotes();
  document.getElementById('btnAddNote').onclick = addNote;
  document.getElementById('fNoteText').onkeydown = (e) => {
    if (e.key === 'Enter') addNote();
  };
}

// ---------------------------------------------------------------------------
// 🎯 القرار المقترح اليوم — Decision Engine output + action-status controls +
// non-causal follow-up on yesterday's suggestion.
// ---------------------------------------------------------------------------

async function renderDecision(a, decision, asOfDate, settings) {
  const yesterdayDate = A.addDays(asOfDate, -1);
  const yBundle = buildProductBundle(currentProduct, currentRecords, yesterdayDate, settings);
  const yStatus = classifyDailyStatus(yBundle.a, settings);
  const yDecision = analyzeProductDecision(yBundle.a, yStatus, yBundle.v2.type);
  const followUp = buildFollowUp(yDecision, a);

  const logRow = await ActionLog.get(currentProductId, asOfDate);
  const current = logRow ? logRow.status : null;
  const btn = (status, label) =>
    `<span class="status-btn ${current === status ? 'active' : ''}" data-status="${status}">${label}</span>`;

  document.getElementById('decisionBody').innerHTML = `
    <div style="margin-bottom:8px;"><span class="rec-pill ${decision.action.code}">${decision.action.label}</span> <span class="faint" style="font-size:12.5px;">مستوى الثقة: ${decision.confidence}</span></div>
    <div style="margin-bottom:10px; line-height:1.8;">${UI.escapeHtml(decision.note)}</div>
    <div class="action-status-row">
      ${btn(ACTION_STATUS.COMPLETED, '✅ تم التنفيذ')}
      ${btn(ACTION_STATUS.NOT_COMPLETED, '❌ لم يتم')}
      ${!current ? '<span class="faint" style="font-size:11px; align-self:center;">غير منفذ</span>' : ''}
    </div>
    ${followUp ? `<div class="follow-up-note">🔁 متابعة قرار الأمس (${UI.escapeHtml(yDecision.action.label)}): ${UI.escapeHtml(followUp)}</div>` : ''}
  `;

  document.getElementById('decisionBody').querySelectorAll('[data-status]').forEach((el) => {
    el.onclick = async () => {
      if (el.dataset.status === ACTION_STATUS.COMPLETED) {
        await ActionLog.markCompleted(currentProductId, asOfDate, { actionLabel: decision.action.label });
      } else {
        await ActionLog.markNotCompleted(currentProductId, asOfDate, { actionLabel: decision.action.label });
      }
      UI.toast('تم تحديث حالة تنفيذ القرار');
      await renderDecision(a, decision, asOfDate, settings);
      await renderDecisionHistory();
    };
  });
}

async function renderDecisionHistory() {
  const rows = await ActionLog.forProduct(currentProductId);
  const el = document.getElementById('decisionHistoryBody');
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty-state">لا توجد قرارات مسجَّلة بعد — سجل حالة التنفيذ يظهر هنا بمجرد تحديث حالة أي قرار أعلاه.</div>';
    return;
  }
  const statusLabel = { COMPLETED: '✅ تم التنفيذ', NOT_COMPLETED: '❌ لم يتم' };
  el.innerHTML = rows
    .map(
      (r) => `
      <div class="alert-card" style="border-inline-start-color: var(--accent);">
        <div class="alert-meta" style="margin-bottom:4px;"><span class="mono">${r.date}</span></div>
        <div>${UI.escapeHtml(r.action_label)} — <span class="badge gray">${statusLabel[r.status] || r.status}</span></div>
      </div>`
    )
    .join('');
}

async function renderNotes() {
  const notes = await ProductNotes.forProduct(currentProductId);
  const el = document.getElementById('notesList');
  if (notes.length === 0) {
    el.innerHTML = '<div class="empty-state">لا توجد ملاحظات بعد.</div>';
    return;
  }
  el.innerHTML = notes
    .map((n) => {
      const date = new Date(n.created_at);
      const label = `${date.toLocaleDateString('ar-EG')} — ${date.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
      return `
      <div class="alert-card" style="border-inline-start-color: var(--accent);">
        <div class="alert-meta" style="margin-bottom:4px;"><span>${label}</span></div>
        <div>${UI.escapeHtml(n.text)}</div>
        <button class="btn danger small" data-del="${n.id}" style="margin-top:8px;">حذف</button>
      </div>`;
    })
    .join('');
  el.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = async () => {
      await ProductNotes.remove(btn.dataset.del);
      await renderNotes();
    };
  });
}

async function addNote() {
  const input = document.getElementById('fNoteText');
  const text = input.value.trim();
  if (!text) return;
  await ProductNotes.add(currentProductId, text);
  input.value = '';
  UI.toast('تمت إضافة الملاحظة');
  await renderNotes();
}

init();
