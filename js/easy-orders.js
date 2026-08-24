// easy-orders.js — page controller for the new, self-contained "Easy Orders"
// section (spec: a minimal, 10-second-read overview for a media buyer —
// NOT another full analytics dashboard). Deliberately isolated from every
// other module: it does not import db.js, analytics.js, or task-store.js,
// and does not write anything to the shared database. All data here is a
// local, in-memory DEMO dataset (spec section 11) meant to be swapped for
// the real EasyOrders-sourced data (already flowing into daily_orders via
// backend/src/routes/webhooks.js) once this UI is approved — that wiring
// is intentionally left for a later, separate step.
import * as UI from './ui-common.js';

// Today's numbers per product. yesterday/dayBefore let the Yesterday/Last-7
// range chips show genuinely different (if synthetic) numbers instead of
// just relabeling the same view — still 100% local demo data, replace with
// a real query once this section reads live data.
const DEMO_PRODUCTS = [
  { id: 1, name: 'جهاز قياس نبضات الجنين', today: 30, yesterday: 28, dayBefore: 26 },
  { id: 2, name: 'جهاز تنظيف الأذن الذكي', today: 18, yesterday: 33, dayBefore: 30 },
  { id: 3, name: 'فرشاة الأسنان الذكية', today: 12, yesterday: 10, dayBefore: 11 },
  { id: 4, name: 'جهاز إزالة شعر الوجه', today: 5, yesterday: 18, dayBefore: 17 },
  { id: 5, name: 'جهاز كشف الكاميرات', today: 0, yesterday: 6, dayBefore: 7 },
  { id: 6, name: 'جهاز هايفور للتجاعيد', today: 22, yesterday: 20, dayBefore: 19 },
  { id: 7, name: 'مصباح المنارة الذكي', today: 15, yesterday: 16, dayBefore: 14 },
];

const DEMO_EMPLOYEES = ['سارة', 'أحمد', 'مريم'];

const RANGES = {
  today: { label: 'اليوم', prevLabel: 'أمس', products: DEMO_PRODUCTS.map((p) => ({ id: p.id, name: p.name, current: p.today, previous: p.yesterday })) },
  yesterday: { label: 'أمس', prevLabel: 'أول أمس', products: DEMO_PRODUCTS.map((p) => ({ id: p.id, name: p.name, current: p.yesterday, previous: p.dayBefore })) },
  last7: {
    label: 'آخر 7 أيام',
    prevLabel: 'الأسبوع اللي قبله',
    products: DEMO_PRODUCTS.map((p) => ({ id: p.id, name: p.name, current: p.today * 6 + p.yesterday, previous: Math.round((p.today * 6 + p.yesterday) * 1.08) })),
  },
};

let currentRange = 'today';
const doneTasks = new Set(); // page-local only — no backend task created/edited by this demo checklist

/**
 * Simple, single-threshold classification per spec section 8 ("لا تستخدم
 * Thresholds معقدة"): 0 orders or a very sharp drop = CRITICAL, a
 * noticeable drop = ATTENTION, anything else = GOOD.
 */
function classify(current, previous) {
  if (current === 0) return 'CRITICAL';
  if (!previous) return 'GOOD';
  const pct = (current - previous) / previous;
  if (pct <= -0.4) return 'CRITICAL';
  if (pct <= -0.15) return 'ATTENTION';
  return 'GOOD';
}

function pctChange(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

function init() {
  UI.renderSidebar('easyorders');
  document.getElementById('eoStatTiles').replaceChildren(); // placeholder cleared by render()
  renderRangeChips();
  render();
}

function renderRangeChips() {
  const el = document.getElementById('rangeChips');
  el.innerHTML = Object.entries(RANGES)
    .map(([key, r]) => `<button type="button" class="chip ${key === currentRange ? 'active' : ''}" data-range="${key}">${r.label}</button>`)
    .join('');
  el.querySelectorAll('[data-range]').forEach((btn) => {
    btn.onclick = () => {
      currentRange = btn.dataset.range;
      renderRangeChips();
      render();
    };
  });
}

function render() {
  const range = RANGES[currentRange];
  const products = range.products;
  const totalCurrent = products.reduce((s, p) => s + p.current, 0);
  const totalPrevious = products.reduce((s, p) => s + p.previous, 0);
  const diff = totalCurrent - totalPrevious;
  const pct = pctChange(totalCurrent, totalPrevious);

  renderStatTiles(range, totalCurrent, totalPrevious, diff, pct);
  renderCompareBars(range, totalCurrent, totalPrevious, diff);
  renderProductsTable(products);
  renderTopProducts(products, totalCurrent);
  renderAlerts(products);
  renderTasks(products);
}

function renderStatTiles(range, totalCurrent, totalPrevious, diff, pct) {
  const diffArrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '';
  const diffColor = diff > 0 ? 'green' : diff < 0 ? 'red' : '';
  document.getElementById('eoStatTiles').innerHTML = [
    UI.statTile(`📦 أوردرات ${range.label}`, totalCurrent),
    UI.statTile(`📅 أوردرات ${range.prevLabel}`, totalPrevious),
    UI.statTile('⚖️ الفرق', `${diffArrow} ${Math.abs(diff)}`, { colorClass: diffColor }),
    UI.statTile('📈 نسبة التغيير', `${pct > 0 ? '+' : ''}${pct}%`, { colorClass: diffColor }),
  ].join('');
}

function renderCompareBars(range, totalCurrent, totalPrevious, diff) {
  const max = Math.max(totalCurrent, totalPrevious, 1);
  document.getElementById('eoCompareBars').innerHTML = `
    <div class="eo-bar-row">
      <div class="eo-bar-label">${range.label}</div>
      <div class="eo-bar-track"><div class="eo-bar-fill accent" style="width:${(totalCurrent / max) * 100}%"></div></div>
      <div class="eo-bar-value">${totalCurrent}</div>
    </div>
    <div class="eo-bar-row">
      <div class="eo-bar-label">${range.prevLabel}</div>
      <div class="eo-bar-track"><div class="eo-bar-fill gray" style="width:${(totalPrevious / max) * 100}%"></div></div>
      <div class="eo-bar-value">${totalPrevious}</div>
    </div>
  `;
  const note = document.getElementById('eoCompareNote');
  if (diff > 0) {
    note.innerHTML = `<span class="eo-text-green">🎉 ${range.label} أفضل من ${range.prevLabel} بـ ${diff} أوردر</span>`;
  } else if (diff < 0) {
    note.innerHTML = `<span class="eo-text-red">⚠️ ${range.label} أقل من ${range.prevLabel} بـ ${Math.abs(diff)} أوردر</span>`;
  } else {
    note.innerHTML = `<span class="muted">⚪ ${range.label} زي ${range.prevLabel} بالظبط</span>`;
  }
}

function renderProductsTable(products) {
  document.getElementById('eoProductsBody').innerHTML = products
    .map((p) => {
      const diff = p.current - p.previous;
      const cls = diff > 0 ? 'eo-text-green' : diff < 0 ? 'eo-text-red' : 'eo-text-gray';
      const sign = diff > 0 ? '+' : '';
      return `
        <tr>
          <td>${UI.escapeHtml(p.name)}</td>
          <td class="mono">${p.current}</td>
          <td class="mono">${p.previous}</td>
          <td class="mono ${cls}">${sign}${diff}</td>
        </tr>
      `;
    })
    .join('');
}

function renderTopProducts(products, totalCurrent) {
  const top = [...products].sort((a, b) => b.current - a.current).slice(0, 4);
  document.getElementById('eoTopProducts').innerHTML = top
    .map((p, i) => {
      const share = totalCurrent > 0 ? Math.round((p.current / totalCurrent) * 100) : 0;
      return `
        <div class="eo-top-row">
          <div class="eo-top-rank">#${i + 1}</div>
          <div class="eo-top-info">
            <div class="eo-top-name">${UI.escapeHtml(p.name)}</div>
            <div class="eo-top-meta">${p.current} أوردر — ${share}% من الإجمالي</div>
            <div class="health-bar-track" style="width:100%;"><div class="health-bar-fill" style="width:${share}%; background:var(--accent);"></div></div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderAlerts(products) {
  const flagged = products
    .map((p) => ({ p, status: classify(p.current, p.previous) }))
    .filter((r) => r.status !== 'GOOD')
    .sort((a, b) => a.p.current - b.p.current) // worst (fewest orders) first
    .slice(0, 3); // spec: "لا تعرض Alerts كثيرة" — top few only

  const el = document.getElementById('eoAlerts');
  if (flagged.length === 0) {
    el.innerHTML = `<div class="empty-state">مفيش منتجات محتاجة انتباه دلوقتي 🎉</div>`;
    return;
  }
  el.innerHTML = flagged
    .map(({ p, status }) => {
      if (status === 'CRITICAL' && p.current === 0) {
        return `
          <div class="alert-card negative">
            <div class="alert-title">🔴 بدون أوردرات — ${UI.escapeHtml(p.name)}</div>
            <div class="alert-meta"><span>لم يسجل أي أوردر</span></div>
            <div class="alert-rec"><b>الإجراء المقترح:</b> راجع الإعلان أو حالة المنتج</div>
          </div>
        `;
      }
      const cls = status === 'CRITICAL' ? 'negative' : 'warning';
      const icon = status === 'CRITICAL' ? '🔴 انخفاض قوي' : '🟠 محتاج متابعة';
      return `
        <div class="alert-card ${cls}">
          <div class="alert-title">${icon} — ${UI.escapeHtml(p.name)}</div>
          <div class="alert-meta"><span>انخفض من ${p.previous} إلى ${p.current} أوردر</span></div>
          <div class="alert-rec"><b>الإجراء المقترح:</b> راجع الحملات الخاصة بالمنتج</div>
        </div>
      `;
    })
    .join('');
}

function renderTasks(products) {
  const flagged = products.filter((p) => classify(p.current, p.previous) !== 'GOOD').slice(0, 3);
  const tasks = flagged.map((p, i) => ({
    id: p.id,
    text: p.current === 0 ? `حلل سبب توقف ${p.name}` : `راجع انخفاض ${p.name}`,
    employee: DEMO_EMPLOYEES[i % DEMO_EMPLOYEES.length],
    priority: classify(p.current, p.previous) === 'CRITICAL' ? 'عاجل' : 'مهم',
  }));

  const el = document.getElementById('eoTasks');
  if (tasks.length === 0) {
    el.innerHTML = `<div class="empty-state">مفيش مهام مطلوبة دلوقتي 🎉</div>`;
    return;
  }
  el.innerHTML = tasks
    .map(
      (t) => `
      <label class="eo-task-row">
        <input type="checkbox" data-task="${t.id}" ${doneTasks.has(t.id) ? 'checked' : ''} />
        <span class="eo-task-text ${doneTasks.has(t.id) ? 'done' : ''}">${UI.escapeHtml(t.text)}</span>
        <span class="badge gray">${t.employee}</span>
        <span class="badge ${t.priority === 'عاجل' ? 'red' : 'yellow'}">${t.priority}</span>
      </label>
    `
    )
    .join('');
  el.querySelectorAll('[data-task]').forEach((cb) => {
    cb.onchange = () => {
      const id = Number(cb.dataset.task);
      if (cb.checked) doneTasks.add(id);
      else doneTasks.delete(id);
      renderTasks(RANGES[currentRange].products); // re-render to sync the strikethrough state
    };
  });
}

init();
