// tasks.js — page controller for tasks.html, the Media Buyer's single
// workspace (spec sections 5, 12, 16, 24, 29, 37): today's tasks, top-5
// priorities, yesterday's carried-over items, and an End-of-Day report —
// built on REAL products with 🧪 demo orders layered on top for testing,
// never fake "Product A/B" names. Nothing here executes anything in Meta
// Ads — every task is a suggestion the media buyer confirms by hand.
import { Products, DailyOrders, Settings, ActionLog, ACTION_STATUS, DailyReports } from './db.js';
import * as A from './analytics.js';
import * as UI from './ui-common.js';
import { buildProductBundle } from './product-bundle.js';
import { classifyDailyStatus } from './daily-monitor.js';
import { analyzeProductDecision } from './decision-engine.js';
import { buildTask, topTasks, TASK_TYPE, NOT_COMPLETED_REASONS } from './task-engine.js';
import { generateDemoTasks, resetDemoTasks } from './demo-tasks.js';
import { openProductDrawer } from './product-drawer.js';

const state = { asOfDate: A.todayStr(), filter: 'ALL' };

let settings = null;
let byProduct = new Map(); // product_id -> all daily_orders rows (real + demo)
let realProducts = [];
let todayItems = []; // [{product, a, dailyStatus, decision, task, logRow}]
let carriedOver = []; // [{product, task, originalDate}]

const TASK_GROUP_ORDER = ['PAUSE_REVIEW', 'CHECK_STOCK', 'REVIEW_PRODUCT', 'REDUCE', 'SCALE', 'MONITOR', 'COLLECT_DATA'];

// The filter chips are broader groupings than the raw task_type codes
// (e.g. "🚨 خطر" covers PAUSE_REVIEW/CHECK_STOCK/REVIEW_PRODUCT together).
const FILTER_TYPE_MAP = {
  SCALE: ['SCALE'],
  REDUCE: ['REDUCE'],
  PAUSE_REVIEW: ['PAUSE_REVIEW', 'CHECK_STOCK', 'REVIEW_PRODUCT', 'REVIEW_AD'],
  MONITOR: ['MONITOR', 'COLLECT_DATA'],
};

const FILTER_LABELS = {
  ALL: 'الكل',
  SCALE: '🔥 Scale',
  REDUCE: '⬇️ Reduce',
  PAUSE_REVIEW: '🚨 خطر',
  MONITOR: '👀 متابعة',
  LATE: '❌ متأخر',
  DONE: '✅ تم',
};

async function init() {
  UI.renderSidebar('tasks');

  const picker = document.getElementById('asOfDatePicker');
  picker.value = state.asOfDate;
  picker.onchange = () => {
    state.asOfDate = picker.value;
    refresh();
  };
  document.getElementById('btnToday').onclick = () => {
    state.asOfDate = A.todayStr();
    picker.value = state.asOfDate;
    refresh();
  };
  document.getElementById('btnYesterday').onclick = () => {
    state.asOfDate = A.addDays(A.todayStr(), -1);
    picker.value = state.asOfDate;
    refresh();
  };

  document.getElementById('btnResetDemo').onclick = async () => {
    document.getElementById('btnResetDemo').disabled = true;
    const result = await resetDemoTasks(state.asOfDate);
    document.getElementById('btnResetDemo').disabled = false;
    document.getElementById('resetDemoStatus').textContent = result.generated
      ? `تم مسح ${result.removed} سجل تجربة قديم، وتوليد ${result.ordersWritten} سجل جديد على ${result.productsCovered} منتج.`
      : 'لا توجد منتجات حقيقية بعد — أضفها من صفحة المنتجات أولًا.';
    UI.toast('تم تحديث بيانات التجربة');
    await refresh();
  };
  document.getElementById('btnGenerateDemo').onclick = async () => {
    document.getElementById('btnGenerateDemo').disabled = true;
    await generateDemoTasks(state.asOfDate);
    document.getElementById('btnGenerateDemo').disabled = false;
    UI.toast('✅ تم توليد بيانات التجربة');
    await refresh();
  };

  document.getElementById('btnEodReport').onclick = toggleEodReport;
  document.getElementById('btnCloseEodReport').onclick = () => (document.getElementById('eodReportCard').style.display = 'none');
  document.getElementById('btnHistory').onclick = toggleHistory;
  document.getElementById('btnCloseHistory').onclick = () => (document.getElementById('historyCard').style.display = 'none');

  buildFilterChips();
  await refresh();
}

function buildFilterChips() {
  const el = document.getElementById('taskFilterChips');
  el.innerHTML = Object.keys(FILTER_LABELS)
    .map((k) => `<span class="chip ${k === state.filter ? 'active' : ''}" data-v="${k}">${FILTER_LABELS[k]}</span>`)
    .join('');
  el.querySelectorAll('.chip').forEach((chip) => {
    chip.onclick = () => {
      state.filter = chip.dataset.v;
      el.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderTaskList();
    };
  });
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function computeItem(product, dateStr) {
  const records = byProduct.get(product.id) || [];
  const { a, inventory, v2 } = buildProductBundle(product, records, dateStr, settings);
  const dailyStatus = classifyDailyStatus(a, settings);
  const decision = analyzeProductDecision(a, dailyStatus, v2.type, inventory);
  const task = buildTask({ product, a, decision, inventory });
  return { product, a, dailyStatus, decision, task };
}

async function refresh() {
  settings = await Settings.get();
  realProducts = (await Products.all()).filter((p) => !p.is_demo);
  // Tasks page intentionally includes 🧪 demo order rows alongside any real
  // ones — this is the one page in the app that does.
  const allOrders = await DailyOrders.all();
  byProduct = new Map();
  for (const o of allOrders) {
    if (!byProduct.has(o.product_id)) byProduct.set(o.product_id, []);
    byProduct.get(o.product_id).push(o);
  }

  document.getElementById('dateLabel').textContent = `${state.asOfDate === A.todayStr() ? 'اليوم' : ''} ${state.asOfDate}`.trim();

  const anyOrders = allOrders.length > 0;
  document.getElementById('emptyTasksBanner').style.display = anyOrders ? 'none' : 'block';
  if (!anyOrders) {
    document.getElementById('summaryTiles').innerHTML = '';
    document.getElementById('topTasksCard').style.display = 'none';
    document.getElementById('carriedOverCard').style.display = 'none';
    document.getElementById('taskListBody').innerHTML = '';
    return;
  }

  const todayLog = await ActionLog.forDate(state.asOfDate);
  const todayLogMap = new Map(todayLog.map((r) => [r.product_id, r]));
  todayItems = realProducts.map((p) => ({ ...computeItem(p, state.asOfDate), logRow: todayLogMap.get(p.id) || null }));

  // Carried-over: yesterday's URGENT/IMPORTANT tasks that never got a
  // status — but only once the user has actually moved past the day tasks
  // were (re)assigned (see demo-tasks.js). Otherwise a fresh demo
  // generation would immediately flag yesterday's never-seen tasks as
  // "late", which is misleading rather than useful.
  const yesterdayDate = A.addDays(state.asOfDate, -1);
  const pastAssignmentDay = !settings.lastDemoGeneratedDate || state.asOfDate > settings.lastDemoGeneratedDate;
  if (pastAssignmentDay) {
    const yesterdayLog = await ActionLog.forDate(yesterdayDate);
    const yesterdayLogMap = new Map(yesterdayLog.map((r) => [r.product_id, r]));
    carriedOver = realProducts
      .map((p) => ({ ...computeItem(p, yesterdayDate), originalDate: yesterdayDate, logRow: yesterdayLogMap.get(p.id) || null }))
      .filter((x) => !x.logRow && (x.task.priority.code === 'URGENT' || x.task.priority.code === 'IMPORTANT'));
  } else {
    carriedOver = [];
  }

  renderSummary();
  renderTopTasks();
  renderCarriedOver();
  renderTaskList();
  if (document.getElementById('eodReportCard').style.display !== 'none') renderEodReport();
}

// ---------------------------------------------------------------------------
// ☀️ Summary — kept small (spec: "لا تجعل الأرقام كثيرة")
// ---------------------------------------------------------------------------

function renderSummary() {
  const total = todayItems.length;
  const completed = todayItems.filter((x) => x.logRow?.status === ACTION_STATUS.COMPLETED).length;
  const notCompleted = todayItems.filter((x) => x.logRow?.status === ACTION_STATUS.NOT_COMPLETED).length;
  const remaining = total - completed - notCompleted;
  const urgent = todayItems.filter((x) => x.task.priority.code === 'URGENT' && !x.logRow).length;

  const tiles = [
    { label: 'تاسكات اليوم', value: total },
    { label: '✅ تم', value: completed, cls: 'green' },
    { label: 'متبقي', value: remaining, cls: remaining > 0 ? 'yellow' : '' },
    { label: '⚠️ متأخر من أمس', value: carriedOver.length, cls: carriedOver.length > 0 ? 'red' : '' },
    { label: '🔴 عاجل', value: urgent, cls: urgent > 0 ? 'red' : '' },
  ];
  document.getElementById('summaryTiles').innerHTML = tiles
    .map((t) => `<div class="stat-tile"><div class="label">${t.label}</div><div class="value ${t.cls || ''}">${t.value}</div></div>`)
    .join('');
}

// ---------------------------------------------------------------------------
// 🚨 أهم 5 حاجات
// ---------------------------------------------------------------------------

function renderTopTasks() {
  const pending = todayItems.filter((x) => !x.logRow);
  const top = topTasks(pending.map((x) => x.task), 5);
  const card = document.getElementById('topTasksCard');
  const body = document.getElementById('topTasksBody');
  card.style.display = top.length > 0 ? 'block' : 'none';
  if (top.length === 0) return;

  body.innerHTML = top
    .map((t, i) => {
      const item = pending.find((x) => x.product.id === t.productId);
      return `
      <div class="action-card ${item.decision.action.code}" data-id="${t.productId}" style="cursor:pointer;">
        <div class="action-card-title">${i + 1} — ${t.taskType.icon} ${UI.escapeHtml(t.productName)}</div>
        <div class="action-card-metrics">
          <span class="mono">${t.yesterday ?? '—'} ← ${t.today ?? '—'}</span>
          <span>${t.priority.icon} ${t.priority.label}</span>
        </div>
        <div class="action-card-reasons">${UI.escapeHtml(t.requiredAction)}</div>
      </div>`;
    })
    .join('');
  body.querySelectorAll('.action-card').forEach((el) => (el.onclick = () => openProductDrawer(el.dataset.id, refresh)));
}

// ---------------------------------------------------------------------------
// ⚠️ متأخر من أمس
// ---------------------------------------------------------------------------

function renderCarriedOver() {
  const card = document.getElementById('carriedOverCard');
  const body = document.getElementById('carriedOverBody');
  card.style.display = carriedOver.length > 0 ? 'block' : 'none';
  if (carriedOver.length === 0) return;
  body.innerHTML = carriedOver.map((x) => taskCardHtml(x, true)).join('');
  wireTaskCards(body);
}

// ---------------------------------------------------------------------------
// 🎯 قائمة تاسكات اليوم — مجمّعة حسب النوع
// ---------------------------------------------------------------------------

function renderTaskList() {
  const el = document.getElementById('taskListBody');

  if (state.filter === 'LATE') {
    el.innerHTML = carriedOver.length
      ? carriedOver.map((x) => taskCardHtml(x, true)).join('')
      : '<div class="empty-state">لا توجد مهام متأخرة. 👍</div>';
    wireTaskCards(el);
    return;
  }
  if (state.filter === 'DONE') {
    const done = todayItems.filter((x) => x.logRow?.status === ACTION_STATUS.COMPLETED);
    el.innerHTML = done.length ? done.map((x) => taskCardHtml(x, false)).join('') : '<div class="empty-state">لا توجد مهام منفذة اليوم بعد.</div>';
    wireTaskCards(el);
    return;
  }

  const groups = TASK_GROUP_ORDER.filter((code) => state.filter === 'ALL' || (FILTER_TYPE_MAP[state.filter] || []).includes(code))
    .map((code) => ({
      code,
      title: TASK_TYPE[code].label,
      icon: TASK_TYPE[code].icon,
      items: sortByPriority(todayItems.filter((x) => x.task.taskType.code === code)),
    }))
    .filter((g) => g.items.length > 0);

  if (groups.length === 0) {
    el.innerHTML = '<div class="empty-state">لا توجد مهام تطابق هذا الفلتر.</div>';
    return;
  }

  el.innerHTML = groups
    .map(
      (g) => `
      <div class="action-group">
        <div class="action-group-title">${g.icon} ${g.title} <span class="faint" style="font-weight:400; font-size:12px;">(${g.items.length})</span></div>
        ${g.items.map((x) => taskCardHtml(x, false)).join('')}
      </div>`
    )
    .join('');
  wireTaskCards(el);
}

function sortByPriority(items) {
  const order = { URGENT: 0, IMPORTANT: 1, NORMAL: 2 };
  return [...items].sort((x, y) => {
    const p = order[x.task.priority.code] - order[y.task.priority.code];
    if (p !== 0) return p;
    return Math.abs(y.task.diff ?? 0) - Math.abs(x.task.diff ?? 0);
  });
}

function taskCardHtml(item, isCarriedOver) {
  const { product, task, logRow, decision, dailyStatus } = item;
  const dateForAction = isCarriedOver ? item.originalDate : state.asOfDate;
  const status = logRow ? logRow.status : null;
  return `
  <div class="action-card ${decision?.action?.code || ''}" data-id="${product.id}">
    <div class="action-card-title" style="cursor:pointer" data-nav="${product.id}">
      ${isCarriedOver ? '⚠️ ' : ''}${task.taskType.icon} ${UI.escapeHtml(product.product_name)}
      ${isCarriedOver ? `<span class="faint" style="font-size:11px; font-weight:400;">— بتاريخ ${dateForAction}</span>` : ''}
    </div>
    <div class="action-card-metrics">
      <span class="mono">${task.yesterday ?? '—'} ← ${task.today ?? '—'}</span>
      <span>الفرق: ${UI.fmtChangeAbs(task.diff)}</span>
      <span>${task.priority.icon} ${task.priority.label}</span>
      ${dailyStatus ? `<span>${dailyStatus.icon} ${dailyStatus.label}</span>` : ''}
    </div>
    <div class="action-card-reasons"><b>المطلوب:</b> ${UI.escapeHtml(task.requiredAction)}</div>
    <div class="action-card-reasons faint" style="font-size:11.5px;">${UI.escapeHtml(task.reason)}</div>
    ${
      status
        ? `<div class="follow-up-note">${status === ACTION_STATUS.COMPLETED ? '✅ تم التنفيذ' : `❌ لم يتم${logRow.not_completed_reason ? ' — ' + UI.escapeHtml(logRow.not_completed_reason) : ''}`}</div>`
        : `<div class="action-status-row" data-task-actions data-id="${product.id}" data-date="${dateForAction}" data-label="${UI.escapeHtml(task.requiredAction)}" data-type="${task.taskType.code}" data-priority="${task.priority.code}" data-reason-text="${UI.escapeHtml(task.reason)}">
             <span class="status-btn" data-complete>✅ تم</span>
             <span class="status-btn" data-not-complete>❌ لم يتم</span>
           </div>
           <div class="not-completed-picker" data-picker style="display:none; margin-top:8px;"></div>`
    }
  </div>`;
}

function wireTaskCards(container) {
  container.querySelectorAll('[data-nav]').forEach((el) => {
    el.onclick = () => openProductDrawer(el.dataset.nav, refresh);
  });

  container.querySelectorAll('[data-task-actions]').forEach((row) => {
    const meta = {
      productId: Number(row.dataset.id),
      date: row.dataset.date,
      actionLabel: row.dataset.label,
      taskType: row.dataset.type,
      priority: row.dataset.priority,
      reasonText: row.dataset.reasonText,
    };
    row.querySelector('[data-complete]').onclick = async () => {
      await ActionLog.markCompleted(meta.productId, meta.date, meta);
      UI.toast('✅ تم تسجيل التنفيذ');
      await refresh();
    };
    row.querySelector('[data-not-complete]').onclick = () => {
      const picker = row.nextElementSibling;
      picker.style.display = 'block';
      picker.innerHTML = `
        <select class="ltr" data-reason style="width:100%; margin-bottom:6px;">
          ${NOT_COMPLETED_REASONS.map((r) => `<option value="${UI.escapeHtml(r)}">${UI.escapeHtml(r)}</option>`).join('')}
        </select>
        <input type="text" data-note placeholder="ملاحظة إضافية (اختياري)" style="width:100%; margin-bottom:6px;" />
        <button class="btn danger small" data-confirm>تأكيد عدم التنفيذ</button>
      `;
      picker.querySelector('[data-confirm]').onclick = async () => {
        const reason = picker.querySelector('[data-reason]').value;
        const note = picker.querySelector('[data-note]').value.trim();
        await ActionLog.markNotCompleted(meta.productId, meta.date, { ...meta, reason, note });
        UI.toast('تم تسجيل عدم التنفيذ');
        await refresh();
      };
    };
  });
}

// ---------------------------------------------------------------------------
// 📋 End-of-Day report — generated AND persisted (spec: never regenerate
// silently over history — same date overwrites its own row, other dates
// stay untouched forever).
// ---------------------------------------------------------------------------

function toggleEodReport() {
  const card = document.getElementById('eodReportCard');
  const showing = card.style.display !== 'none';
  card.style.display = showing ? 'none' : 'block';
  if (!showing) renderEodReport();
}

function buildEodReportText() {
  const total = todayItems.length;
  const completed = todayItems.filter((x) => x.logRow?.status === ACTION_STATUS.COMPLETED);
  const notCompleted = todayItems.filter((x) => x.logRow?.status === ACTION_STATUS.NOT_COMPLETED);
  const stillCarried = carriedOver.length;

  const lines = [];
  lines.push(`📋 تقرير يوم ${state.asOfDate}`);
  lines.push('');
  lines.push('———  🎯 المهام  ———');
  lines.push(`إجمالي المهام: ${total}`);
  lines.push(`✅ تم تنفيذ: ${completed.length}`);
  lines.push(`❌ لم يتم: ${notCompleted.length}`);
  lines.push(`🔄 ترحلت من أمس: ${stillCarried}`);
  lines.push('');

  if (completed.length > 0) {
    lines.push('———  ✅ تم تنفيذها  ———');
    for (const x of completed) lines.push(`${x.task.taskType.icon} ${x.product.product_name} — ${x.logRow.action_label || x.task.requiredAction}`);
    lines.push('');
  }
  if (notCompleted.length > 0) {
    lines.push('———  ❌ لم يتم تنفيذها  ———');
    for (const x of notCompleted) lines.push(`${x.product.product_name} — ${x.task.taskType.label}${x.logRow.not_completed_reason ? ' (' + x.logRow.not_completed_reason + ')' : ''}`);
    lines.push('');
  }

  const untouched = todayItems.filter((x) => !x.logRow);
  if (untouched.length > 0) {
    lines.push('———  🔄 مهام الغد (لم تُلمس اليوم)  ———');
    for (const x of untouched) lines.push(`${x.product.product_name} — ${x.task.taskType.label}`);
    lines.push('');
  }

  const zeroOrder = todayItems.filter((x) => x.task.taskType.code === 'PAUSE_REVIEW').length;
  const declining = todayItems.filter((x) => ['REDUCE', 'CHECK_STOCK'].includes(x.task.taskType.code)).length;
  const scaleCandidates = todayItems.filter((x) => x.task.taskType.code === 'SCALE').length;
  lines.push('———  📊 أهم مشاكل اليوم  ———');
  lines.push(`1. ${zeroOrder} منتج بدون أوردرات أو مرشح للإيقاف.`);
  lines.push(`2. ${declining} منتج متراجع أو يحتاج تقليل ميزانية.`);
  lines.push(`3. ${scaleCandidates} منتج مرشح للـScale.`);
  lines.push('');
  lines.push('———  🎯 أهم Action Plan للغد  ———');
  lines.push('1. متابعة المنتجات التي لم يتم تنفيذ تاسكاتها اليوم.');
  lines.push('2. مراجعة المنتجات التي ما زالت بدون أوردرات.');
  lines.push('3. متابعة المنتجات التي تم عمل Scale لها اليوم.');
  lines.push('4. مراجعة المنتجات المتراجعة.');

  return { text: lines.join('\n'), summary: { total, completed: completed.length, notCompleted: notCompleted.length, carriedOver: stillCarried } };
}

async function renderEodReport() {
  const { text, summary } = buildEodReportText();
  await DailyReports.save(state.asOfDate, 'DAILY_TASKS', summary, text);
  document.getElementById('eodReportBody').textContent = text;
}

// ---------------------------------------------------------------------------
// 📜 Task history
// ---------------------------------------------------------------------------

async function toggleHistory() {
  const card = document.getElementById('historyCard');
  const showing = card.style.display !== 'none';
  card.style.display = showing ? 'none' : 'block';
  if (showing) return;

  const reports = (await DailyReports.all('DAILY_TASKS')).slice(0, 7);
  const body = document.getElementById('historyBody');
  if (reports.length === 0) {
    body.innerHTML = '<div class="empty-state">لا توجد تقارير محفوظة بعد — اضغط "📋 تقرير نهاية اليوم" لإنشاء أول تقرير.</div>';
    return;
  }
  body.innerHTML = reports
    .map(
      (r) => `
    <div class="alert-card" style="border-inline-start-color: var(--accent); cursor:pointer;" data-date="${r.date}">
      <div class="alert-meta" style="margin-bottom:4px;"><span class="mono">${r.date}</span></div>
      <div>إجمالي: ${r.summary.total} · ✅ ${r.summary.completed} · ❌ ${r.summary.notCompleted} · 🔄 ${r.summary.carriedOver}</div>
    </div>`
    )
    .join('');
  body.querySelectorAll('[data-date]').forEach((el) => {
    el.onclick = () => {
      const report = reports.find((r) => r.date === el.dataset.date);
      document.getElementById('eodReportCard').style.display = 'block';
      document.getElementById('eodReportBody').textContent = report.report_text;
      document.getElementById('historyCard').style.display = 'none';
    };
  });
}

init();
