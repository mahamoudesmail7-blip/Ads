// product-drawer.js — shared "quick view" drawer (spec section 23: clicking
// a product opens a simple drawer/modal, not a full dashboard-sized page).
// Used from both products.js and dashboard.js so a row click doesn't force
// a full navigation. product.html (the full page with charts/history) stays
// reachable via a link inside the drawer for anyone who wants it.
import { Products, DailyOrders, Settings, ProductNotes, ActionLog, ACTION_STATUS } from './db.js';
import * as A from './analytics.js';
import * as UI from './ui-common.js';
import { buildProductBundle } from './product-bundle.js';
import { classifyDailyStatus } from './daily-monitor.js';
import { analyzeProductDecision, buildFollowUp } from './decision-engine.js';

let overlayEl = null;
let currentProductId = null;

function ensureDrawer() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement('div');
  overlayEl.className = 'drawer-overlay';
  overlayEl.innerHTML = `<div class="drawer-panel" id="productDrawerPanel"></div>`;
  overlayEl.onclick = (e) => {
    if (e.target === overlayEl) closeProductDrawer();
  };
  document.body.appendChild(overlayEl);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeProductDrawer();
  });
  return overlayEl;
}

export function closeProductDrawer() {
  if (overlayEl) overlayEl.classList.remove('open');
  currentProductId = null;
}

export async function openProductDrawer(productId, onChange) {
  const id = Number(productId);
  currentProductId = id;
  ensureDrawer();
  const panel = document.getElementById('productDrawerPanel');
  panel.innerHTML = '<div class="empty-state">جارِ التحميل…</div>';
  overlayEl.classList.add('open');

  // 🧪 Demo orders included on purpose — see alerts.js comment.
  const [product, settings, records] = await Promise.all([Products.get(id), Settings.get(), DailyOrders.forProduct(id)]);
  if (currentProductId !== id) return; // drawer was reopened for a different product before this resolved
  if (!product) {
    panel.innerHTML = '<div class="empty-state">منتج غير موجود.</div>';
    return;
  }

  const asOfDate = A.todayStr();
  const { a, inventory, v2 } = buildProductBundle(product, records, asOfDate, settings);
  const dailyStatus = classifyDailyStatus(a, settings);
  const decision = analyzeProductDecision(a, dailyStatus, v2.type, inventory);

  const yesterdayDate = A.addDays(asOfDate, -1);
  const yBundle = buildProductBundle(product, records, yesterdayDate, settings);
  const yDecision = analyzeProductDecision(yBundle.a, classifyDailyStatus(yBundle.a, settings), yBundle.v2.type);
  const followUp = buildFollowUp(yDecision, a);

  const logRow = await ActionLog.get(id, asOfDate);
  const notes = await ProductNotes.forProduct(id);

  const stockCell = inventory.hasStockData
    ? `${inventory.currentStock} ${inventory.daysRemaining !== null ? `(${inventory.daysRemaining.toFixed(1)} يوم متبقي)` : ''}`
    : 'غير محدد';

  const recentRows = [...records].sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 7);

  panel.innerHTML = `
    <div class="drawer-header">
      <div>
        <div class="drawer-title">${UI.escapeHtml(product.product_name)}</div>
        <div class="drawer-meta">
          ${product.product_code ? `<span class="mono">${UI.escapeHtml(product.product_code)}</span> · ` : ''}
          رمز: <span class="mono">${UI.escapeHtml(product.sku || '—')}</span>
          ${product.category ? ` · ${UI.escapeHtml(product.category)}` : ''}
        </div>
      </div>
      <button class="drawer-close" id="drawerCloseBtn">✕</button>
    </div>

    <div class="drawer-stat-row">
      <div class="drawer-stat"><div class="label">أمس</div><div class="value">${UI.fmtNum(a.yesterday)}</div></div>
      <div class="drawer-stat"><div class="label">اليوم</div><div class="value">${UI.fmtNum(a.today)}</div></div>
      <div class="drawer-stat"><div class="label">الفرق</div><div class="value">${UI.fmtChangeAbs(a.change.abs)}</div></div>
      <div class="drawer-stat"><div class="label">معدل 7 أيام</div><div class="value">${UI.fmtAvg(a.avg7)}</div></div>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-title">الحالة</div>
      <div>${dailyStatus.icon} ${dailyStatus.label}</div>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-title">🎯 القرار المقترح</div>
      <div style="margin-bottom:8px;"><span class="rec-pill ${decision.action.code}">${decision.action.label}</span> <span class="faint" style="font-size:12px;">الثقة: ${decision.confidence}</span></div>
      <div style="margin-bottom:10px; font-size:13px; line-height:1.7;">${UI.escapeHtml(decision.note)}</div>
      <div class="action-status-row" id="drawerStatusRow"></div>
      ${followUp ? `<div class="follow-up-note">🔁 ${UI.escapeHtml(followUp)}</div>` : ''}
    </div>

    <div class="drawer-section">
      <div class="drawer-section-title">📦 المخزون</div>
      <div style="font-size:13px;">${stockCell}</div>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-title">📅 آخر 7 أيام</div>
      ${recentRows.length === 0 ? '<div class="faint" style="font-size:12.5px;">لا توجد بيانات أوردرات بعد.</div>' : recentRows.map((r) => `<div class="drawer-timeline-row"><span class="mono">${r.date}</span><span>${r.orders_count}</span></div>`).join('')}
    </div>

    <div class="drawer-section">
      <div class="drawer-section-title">📝 ملاحظات</div>
      <div class="field-row" style="align-items:flex-end; margin-bottom:8px;">
        <div class="field" style="flex:1; margin-bottom:0;"><input type="text" id="drawerNoteText" placeholder="أضف ملاحظة…" /></div>
        <button class="btn small" id="drawerAddNote" style="margin-inline-start:8px;">إضافة</button>
      </div>
      <div id="drawerNotesList">
        ${notes.length === 0 ? '<div class="faint" style="font-size:12px;">لا توجد ملاحظات بعد.</div>' : notes.map((n) => `<div style="font-size:12.5px; padding:5px 0; border-bottom:1px solid var(--border);">${UI.escapeHtml(n.text)}<div class="faint" style="font-size:10.5px;">${new Date(n.created_at).toLocaleString('ar-EG')}</div></div>`).join('')}
      </div>
    </div>

    <a href="${UI.productLink(id)}" style="font-size:12.5px;">فتح الصفحة الكاملة (رسوم بيانية وسجل كامل) ↗</a>
  `;

  document.getElementById('drawerCloseBtn').onclick = closeProductDrawer;

  const statusRow = document.getElementById('drawerStatusRow');
  const current = logRow ? logRow.status : null;
  const btn = (status, label) => `<span class="status-btn ${current === status ? 'active' : ''}" data-status="${status}">${label}</span>`;
  statusRow.innerHTML = `
    ${btn(ACTION_STATUS.COMPLETED, '✅ تم التنفيذ')}
    ${btn(ACTION_STATUS.NOT_COMPLETED, '❌ لم يتم')}
    ${!current ? '<span class="faint" style="font-size:11px; align-self:center;">غير منفذ</span>' : ''}
  `;
  statusRow.querySelectorAll('[data-status]').forEach((el) => {
    el.onclick = async () => {
      if (el.dataset.status === ACTION_STATUS.COMPLETED) {
        await ActionLog.markCompleted(id, asOfDate, { actionLabel: decision.action.label });
      } else {
        await ActionLog.markNotCompleted(id, asOfDate, { actionLabel: decision.action.label });
      }
      UI.toast('تم تحديث حالة تنفيذ القرار');
      if (onChange) onChange();
      await openProductDrawer(id, onChange);
    };
  });

  document.getElementById('drawerAddNote').onclick = async () => {
    const input = document.getElementById('drawerNoteText');
    const text = input.value.trim();
    if (!text) return;
    await ProductNotes.add(id, text);
    await openProductDrawer(id, onChange);
  };
  document.getElementById('drawerNoteText').onkeydown = (e) => {
    if (e.key === 'Enter') document.getElementById('drawerAddNote').click();
  };
}
