// easy-orders.js — page controller for the "Easy Orders" section, reading
// ONLY real data from backend/src/routes/easyorders.js (GET /api/easyorders/summary),
// which itself reads only rows the real webhook (backend/src/routes/webhooks.js)
// has written. Nothing in this file invents a number, a product name, or a
// status — every value rendered here traces back to an actual EasyOrders
// webhook delivery. Empty data renders as 0 / an empty-state message, never
// a placeholder value.
//
// "Last 7 Days" was dropped from the earlier demo version of this page —
// the real read endpoint only supports a single day + its prior day (which
// is what hourly tracking and the real orders list both need); a real
// multi-day range view is a reasonable follow-up but isn't built here.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const REFRESH_INTERVAL_MS = 15000; // webhook delivery is push-based server-side; this just keeps the open tab in sync without a manual reload.

let selectedDate = null; // null = today (server decides "today" so it can't drift from the client's clock)
let refreshTimer = null;
let loadGeneration = 0; // guards against a stale in-flight request (e.g. from the auto-refresh timer) overwriting a just-requested range switch

function todayUTCDateStr() {
  return new Date().toISOString().slice(0, 10);
}
function shiftDateStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function classify(current, previous) {
  if (current === 0) return 'CRITICAL';
  if (!previous) return 'GOOD';
  const pct = (current - previous) / previous;
  if (pct <= -0.4) return 'CRITICAL';
  if (pct <= -0.15) return 'ATTENTION';
  return 'GOOD';
}

const STATUS_LABELS_AR = { PENDING: 'قيد الانتظار', CONFIRMED: 'مؤكد', DELIVERED: 'تم التسليم', CANCELLED: 'ملغي', RETURNED: 'مرتجع' };
const STATUS_BADGE_COLOR = { PENDING: 'yellow', CONFIRMED: 'green', DELIVERED: 'green', CANCELLED: 'red', RETURNED: 'red' };

async function init() {
  UI.renderSidebar('easyorders');
  renderRangeChips();
  await load();
  refreshTimer = setInterval(load, REFRESH_INTERVAL_MS);
  window.addEventListener('beforeunload', () => clearInterval(refreshTimer));
}

function renderRangeChips() {
  const el = document.getElementById('rangeChips');
  el.innerHTML = `
    <button type="button" class="chip ${!selectedDate ? 'active' : ''}" data-which="today">اليوم</button>
    <button type="button" class="chip ${selectedDate === 'yesterday' ? 'active' : ''}" data-which="yesterday">أمس</button>
  `;
  el.querySelectorAll('[data-which]').forEach((btn) => {
    btn.onclick = () => {
      selectedDate = btn.dataset.which === 'yesterday' ? 'yesterday' : null;
      renderRangeChips();
      load();
    };
  });
}

async function load() {
  const requestId = ++loadGeneration;
  const params = selectedDate === 'yesterday' ? { date: shiftDateStr(todayUTCDateStr(), -1) } : {};

  let data;
  try {
    data = await api.get('/api/easyorders/summary', params);
  } catch (err) {
    if (requestId !== loadGeneration) return; // superseded by a newer request — don't clobber whatever it's about to render
    document.getElementById('eoStatTiles').innerHTML = `<div class="empty-state">مقدرش أجيب بيانات EasyOrders (${UI.escapeHtml(err.message)})</div>`;
    return;
  }
  if (requestId !== loadGeneration) return; // stale response (e.g. the auto-refresh timer fired mid-flight while the user switched ranges) — the newer load() already owns the screen
  render(data);
}

function render(data) {
  renderStatTiles(data);
  renderStatusCounts(data);
  renderCompareBars(data);
  renderProductsTable(data.products);
  renderTopProducts(data.products);
  renderAlerts(data.products);
  renderHourly(data.hourly);
  renderOrders(data.orders, data.unmatchedToday);
}

function renderStatTiles({ totals }) {
  const diffArrow = totals.diff > 0 ? '↑' : totals.diff < 0 ? '↓' : '';
  const diffColor = totals.diff > 0 ? 'green' : totals.diff < 0 ? 'red' : '';
  const rangeLabel = selectedDate === 'yesterday' ? 'أمس' : 'اليوم';
  const prevLabel = selectedDate === 'yesterday' ? 'أول أمس' : 'أمس';
  document.getElementById('eoStatTiles').innerHTML = [
    UI.statTile(`📦 أوردرات ${rangeLabel}`, totals.todayOrders),
    UI.statTile(`📅 أوردرات ${prevLabel}`, totals.yesterdayOrders),
    UI.statTile('⚖️ الفرق', `${diffArrow} ${Math.abs(totals.diff)}`, { colorClass: diffColor }),
    UI.statTile('📈 نسبة التغيير', `${totals.pct > 0 ? '+' : ''}${totals.pct}%`, { colorClass: diffColor }),
  ].join('');
}

function renderStatusCounts({ statusCounts }) {
  const el = document.getElementById('eoStatusCounts');
  el.innerHTML = Object.entries(statusCounts)
    .map(([status, count]) => `<span class="badge ${STATUS_BADGE_COLOR[status]}">${STATUS_LABELS_AR[status]}: ${count}</span>`)
    .join(' ');
}

function renderCompareBars({ totals }) {
  const rangeLabel = selectedDate === 'yesterday' ? 'أمس' : 'اليوم';
  const prevLabel = selectedDate === 'yesterday' ? 'أول أمس' : 'أمس';
  const max = Math.max(totals.todayOrders, totals.yesterdayOrders, 1);
  document.getElementById('eoCompareBars').innerHTML = `
    <div class="eo-bar-row">
      <div class="eo-bar-label">${rangeLabel}</div>
      <div class="eo-bar-track"><div class="eo-bar-fill accent" style="width:${(totals.todayOrders / max) * 100}%"></div></div>
      <div class="eo-bar-value">${totals.todayOrders}</div>
    </div>
    <div class="eo-bar-row">
      <div class="eo-bar-label">${prevLabel}</div>
      <div class="eo-bar-track"><div class="eo-bar-fill gray" style="width:${(totals.yesterdayOrders / max) * 100}%"></div></div>
      <div class="eo-bar-value">${totals.yesterdayOrders}</div>
    </div>
  `;
  const note = document.getElementById('eoCompareNote');
  if (totals.todayOrders === 0 && totals.yesterdayOrders === 0) {
    note.innerHTML = `<span class="muted">⚪ مفيش أوردرات مسجلة للفترة دي لسه</span>`;
  } else if (totals.diff > 0) {
    note.innerHTML = `<span class="eo-text-green">🎉 ${rangeLabel} أفضل من ${prevLabel} بـ ${totals.diff} أوردر</span>`;
  } else if (totals.diff < 0) {
    note.innerHTML = `<span class="eo-text-red">⚠️ ${rangeLabel} أقل من ${prevLabel} بـ ${Math.abs(totals.diff)} أوردر</span>`;
  } else {
    note.innerHTML = `<span class="muted">⚪ ${rangeLabel} زي ${prevLabel} بالظبط</span>`;
  }
}

function renderProductsTable(products) {
  const body = document.getElementById('eoProductsBody');
  if (products.length === 0) {
    document.getElementById('eoProductsEmpty').style.display = 'block';
    body.innerHTML = '';
    return;
  }
  document.getElementById('eoProductsEmpty').style.display = 'none';
  body.innerHTML = products
    .map((p) => {
      const diff = p.today - p.yesterday;
      const cls = diff > 0 ? 'eo-text-green' : diff < 0 ? 'eo-text-red' : 'eo-text-gray';
      const sign = diff > 0 ? '+' : '';
      return `
        <tr>
          <td>${UI.escapeHtml(p.name)}${!p.matched ? ' <span class="badge gray">غير مربوط بمنتج</span>' : ''}</td>
          <td class="mono">${p.today}</td>
          <td class="mono">${p.yesterday}</td>
          <td class="mono ${cls}">${sign}${diff}</td>
        </tr>
      `;
    })
    .join('');
}

function renderTopProducts(products) {
  const el = document.getElementById('eoTopProducts');
  const withOrders = products.filter((p) => p.today > 0);
  if (withOrders.length === 0) {
    el.innerHTML = `<div class="empty-state">مفيش أوردرات النهارده لسه</div>`;
    return;
  }
  const total = withOrders.reduce((s, p) => s + p.today, 0);
  const top = withOrders.slice(0, 4); // products already sorted by today desc from the API
  el.innerHTML = top
    .map((p, i) => {
      const share = total > 0 ? Math.round((p.today / total) * 100) : 0;
      return `
        <div class="eo-top-row">
          <div class="eo-top-rank">#${i + 1}</div>
          <div class="eo-top-info">
            <div class="eo-top-name">${UI.escapeHtml(p.name)}</div>
            <div class="eo-top-meta">${p.today} أوردر — ${share}% من الإجمالي</div>
            <div class="health-bar-track" style="width:100%;"><div class="health-bar-fill" style="width:${share}%; background:var(--accent);"></div></div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderAlerts(products) {
  const flagged = products
    .map((p) => ({ p, status: classify(p.today, p.yesterday) }))
    .filter((r) => r.status !== 'GOOD')
    .sort((a, b) => a.p.today - b.p.today)
    .slice(0, 3);

  const el = document.getElementById('eoAlerts');
  if (flagged.length === 0) {
    el.innerHTML = `<div class="empty-state">مفيش منتجات محتاجة انتباه دلوقتي 🎉</div>`;
    return;
  }
  el.innerHTML = flagged
    .map(({ p, status }) => {
      if (p.today === 0) {
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
          <div class="alert-meta"><span>انخفض من ${p.yesterday} إلى ${p.today} أوردر</span></div>
          <div class="alert-rec"><b>الإجراء المقترح:</b> راجع الحملات الخاصة بالمنتج</div>
        </div>
      `;
    })
    .join('');
}

function renderHourly(hourly) {
  const wrap = document.getElementById('eoHourlyWrap');
  const empty = document.getElementById('eoHourlyEmpty');
  if (hourly.length === 0) {
    wrap.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  wrap.style.display = '';
  empty.style.display = 'none';
  document.getElementById('eoHourlyBody').innerHTML = hourly
    .map(
      (h) => `
      <tr>
        <td class="mono">${h.hourLabel}</td>
        <td class="mono">${h.incoming}</td>
        <td class="mono">${h.CONFIRMED}</td>
        <td class="mono">${h.CANCELLED}</td>
        <td class="mono">${h.PENDING}</td>
      </tr>
    `
    )
    .join('');
}

function renderOrders(orders, unmatchedToday) {
  const wrap = document.getElementById('eoOrdersWrap');
  const empty = document.getElementById('eoOrdersEmpty');
  if (orders.length === 0) {
    wrap.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  wrap.style.display = '';
  empty.style.display = 'none';
  document.getElementById('eoOrdersBody').innerHTML = orders
    .map(
      (o) => `
      <tr>
        <td class="mono" style="font-size:11.5px;">${o.orderId.slice(0, 8)}…</td>
        <td>${UI.escapeHtml(o.productNames.join('، '))}</td>
        <td class="mono">${o.quantity}</td>
        <td><span class="badge ${STATUS_BADGE_COLOR[o.status]}">${STATUS_LABELS_AR[o.status]}</span></td>
        <td class="mono" style="font-size:12px;">${new Date(o.createdAt).toLocaleString('ar-EG')}</td>
      </tr>
    `
    )
    .join('');
  document.getElementById('eoUnmatchedNote').textContent = unmatchedToday > 0 ? `⚠️ ${unmatchedToday} أوردر وصل بمنتج غير مربوط بكود SKU — راجع صفحة المنتجات.` : '';
}

init();
