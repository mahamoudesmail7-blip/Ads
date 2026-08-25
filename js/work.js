// work.js — page controller for work.html: distributes today's actionable
// tasks (URGENT/IMPORTANT priority — MONITOR/COLLECT_DATA are informational
// only, not "work" to hand someone) across the 5-person team, tracks
// per-employee completion, and keeps assignments STABLE across reloads.
import { Products, DailyOrders, Settings, ActionLog, ACTION_STATUS, DailyReports, TeamMembers, TaskAssignments, TaskRecords, TaskActivityLog, TASK_STATUS } from './db.js';
import * as A from './analytics.js';
import * as UI from './ui-common.js';
import { api } from './api-client.js';
import { buildProductBundle } from './product-bundle.js';
import { classifyDailyStatus } from './daily-monitor.js';
import { analyzeProductDecision } from './decision-engine.js';
import { buildTask, TASK_TYPE } from './task-engine.js';
import { assignTasksRoundRobin, workloadByEmployee } from './team-engine.js';
import { openProductDrawer } from './product-drawer.js';
import { materializeAutoTasksForDate, completeTask, cancelTaskByEmployee } from './task-store.js';

const state = { asOfDate: A.todayStr(), employeeFilter: 'ALL' };

let settings = null;
let byProduct = new Map();
let realProducts = [];
let employees = [];
let workItems = []; // actionable items today: {product, a, dailyStatus, decision, task, logRow, employeeId}
let carriedOver = []; // {product, task, originalDate, employeeId}
let managerTasks = []; // task_records for asOfDate (both 🤖 automatic and 👑 manager-added) — the "employee dashboard" view for the 👑 تحكم المدير task system
let teamActivity = []; // task_activity_log for asOfDate — 📅 نشاط الفريق اليوم
let currentUser = null; // real logged-in User (id/role) — an EMPLOYEE viewer sees only their own manager-assigned tasks below; ADMIN/MANAGER keep the full team view unchanged

const PRIORITY_LABELS = { URGENT: '🔴 عاجل', IMPORTANT: '🟠 مهم', NORMAL: '🟡 عادي' };
const ACTIVITY_LABELS = {
  ADD: '👑 أضاف Task',
  EDIT: '✏️ عدّل Task',
  MOVE: '👤 نقل Task',
  CANCEL: '🗑️ ألغى Task',
  PRIORITY_CHANGE: '🔺 غيّر الأولوية',
  NOTE: '📝 أضاف ملاحظة',
  STATUS_CHANGE: '🔁 غيّر الحالة',
  EMPLOYEE_COMPLETE: '🟢 أنهى مهمة',
  EMPLOYEE_NOT_COMPLETE: '🟡 لم ينهِ مهمة',
  EMPLOYEE_CANCEL: '🔴 ألغى مهمة',
};

async function init() {
  UI.renderSidebar('work');
  currentUser = await api.get('/api/auth/me').catch(() => null);
  // Seeding the default team is an ADMIN/MANAGER-only write server-side
  // (POST /api/team/seed-default) — an EMPLOYEE viewer loading this page to
  // see their own tasks has nothing to seed and must never crash the whole
  // page on a 403 just because a manager hasn't opened it first today.
  if (currentUser?.role !== 'EMPLOYEE') await TeamMembers.seedDefaultTeam();

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

  document.getElementById('btnTeamReport').onclick = toggleTeamReport;
  document.getElementById('btnCloseTeamReport').onclick = () => (document.getElementById('teamReportCard').style.display = 'none');
  document.getElementById('btnHistory').onclick = toggleHistory;
  document.getElementById('btnCloseHistory').onclick = () => (document.getElementById('historyCard').style.display = 'none');

  await refresh();
}

function computeItem(product, dateStr) {
  const records = byProduct.get(product.id) || [];
  const { a, inventory, v2 } = buildProductBundle(product, records, dateStr, settings);
  const dailyStatus = classifyDailyStatus(a, settings);
  const decision = analyzeProductDecision(a, dailyStatus, v2.type, inventory);
  const task = buildTask({ product, a, decision, inventory });
  return { product, a, dailyStatus, decision, task };
}

const ACTIONABLE = new Set(['URGENT', 'IMPORTANT']);

async function refresh() {
  settings = await Settings.get();
  realProducts = (await Products.all()).filter((p) => !p.is_demo);
  employees = await TeamMembers.all();

  const allOrders = await DailyOrders.all();
  byProduct = new Map();
  for (const o of allOrders) {
    if (!byProduct.has(o.product_id)) byProduct.set(o.product_id, []);
    byProduct.get(o.product_id).push(o);
  }

  document.getElementById('dateLabel').textContent = `${state.asOfDate === A.todayStr() ? 'اليوم' : ''} ${state.asOfDate}`.trim();

  if (allOrders.length === 0) {
    document.getElementById('summaryTiles').innerHTML = '<div class="empty-state">لا توجد بيانات بعد — ولّد بيانات التجربة من صفحة 🎯 تاسكات اليوم أولًا.</div>';
    document.getElementById('teamTableBody').innerHTML = '';
    document.getElementById('workListBody').innerHTML = '';
    document.getElementById('managerTasksBody').innerHTML = '';
    document.getElementById('completedWorkBody').innerHTML = '';
    document.getElementById('teamActivityBody').innerHTML = '';
    return;
  }

  const allItemsToday = realProducts.map((p) => computeItem(p, state.asOfDate));
  const actionableToday = allItemsToday.filter((x) => ACTIONABLE.has(x.task.priority.code));

  // Assignment: fill in anything not yet assigned for this date, keep the rest stable.
  const existingAssignRows = await TaskAssignments.forDate(state.asOfDate);
  const existingAssignMap = new Map(existingAssignRows.map((r) => [r.product_id, r.employee_id]));
  const fullAssignMap = assignTasksRoundRobin(
    actionableToday.map((x) => ({ productId: x.product.id, priority: x.task.priority })),
    employees,
    existingAssignMap
  );
  // Persisting new auto-assignments is an ADMIN/MANAGER-only write server-side
  // (POST /api/assignments/bulk) — an EMPLOYEE viewer still gets the computed
  // (client-side, no network write) assignment map for rendering below, just
  // without trying to save it; whatever a manager already persisted today
  // still reads back normally via the GET above.
  if (currentUser?.role !== 'EMPLOYEE') {
    await TaskAssignments.bulkAssignNew(state.asOfDate, fullAssignMap, [...existingAssignMap.keys()]);
  }

  const todayLog = await ActionLog.forDate(state.asOfDate);
  const todayLogMap = new Map(todayLog.map((r) => [r.product_id, r]));

  workItems = actionableToday.map((x) => ({ ...x, employeeId: fullAssignMap.get(x.product.id) ?? null, logRow: todayLogMap.get(x.product.id) || null }));

  // Carried over — same gating rule as tasks.js (only past the day tasks were assigned).
  const yesterdayDate = A.addDays(state.asOfDate, -1);
  const pastAssignmentDay = !settings.lastDemoGeneratedDate || state.asOfDate > settings.lastDemoGeneratedDate;
  if (pastAssignmentDay) {
    const yItems = realProducts.map((p) => computeItem(p, yesterdayDate)).filter((x) => ACTIONABLE.has(x.task.priority.code));
    const yLog = await ActionLog.forDate(yesterdayDate);
    const yLogMap = new Map(yLog.map((r) => [r.product_id, r]));
    const yAssignRows = await TaskAssignments.forDate(yesterdayDate);
    const yAssignMap = new Map(yAssignRows.map((r) => [r.product_id, r.employee_id]));
    carriedOver = yItems
      .filter((x) => !yLogMap.has(x.product.id))
      .map((x) => ({ ...x, originalDate: yesterdayDate, employeeId: yAssignMap.get(x.product.id) ?? null }));
  } else {
    carriedOver = [];
  }

  // 📋 مهام من المدير (👑 تحكم المدير's task_records) — the same materialize
  // + fetch pattern manager.html uses, so this page always reflects the
  // exact same tasks a manager sees/assigns, including manual additions.
  // Materializing (POST /api/tasks under the hood) is ADMIN/MANAGER-only —
  // an EMPLOYEE viewer just reads whatever already exists rather than
  // triggering a write, same reasoning as the assignment block above.
  if (currentUser?.role !== 'EMPLOYEE') await materializeAutoTasksForDate(state.asOfDate);
  managerTasks = await TaskRecords.forDate(state.asOfDate);
  teamActivity = await TaskActivityLog.forDate(state.asOfDate);

  buildEmployeeTabs();
  renderSummary();
  renderTeamTable();
  renderTopWork();
  renderCarriedOver();
  renderEmployeeSummary();
  renderWorkList();
  renderManagerTasks();
  renderCompletedWork();
  renderTeamActivity();
  if (document.getElementById('teamReportCard').style.display !== 'none') renderTeamReport();
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function buildEmployeeTabs() {
  const el = document.getElementById('employeeTabs');
  const values = [{ id: 'ALL', name: 'الكل' }, ...employees];
  el.innerHTML = values
    .map((e) => `<span class="chip ${state.employeeFilter === String(e.id) ? 'active' : ''}" data-v="${e.id}">${UI.escapeHtml(e.name)}</span>`)
    .join('');
  el.querySelectorAll('.chip').forEach((chip) => {
    chip.onclick = () => {
      state.employeeFilter = chip.dataset.v;
      el.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderEmployeeSummary();
      renderCarriedOver();
      renderWorkList();
      renderManagerTasks();
      renderCompletedWork();
    };
  });
}

// ---------------------------------------------------------------------------
// Summary tiles + team table
// ---------------------------------------------------------------------------

function renderSummary() {
  const total = workItems.length;
  const completed = workItems.filter((x) => x.logRow?.status === ACTION_STATUS.COMPLETED).length;
  const notCompleted = workItems.filter((x) => x.logRow?.status === ACTION_STATUS.NOT_COMPLETED).length;
  const remaining = total - completed - notCompleted;
  const tiles = [
    { label: 'إجمالي الشغل', value: total },
    { label: '✅ تم', value: completed, cls: 'green' },
    { label: 'متبقي', value: remaining, cls: remaining > 0 ? 'yellow' : '' },
    { label: '⚠️ متأخر', value: carriedOver.length, cls: carriedOver.length > 0 ? 'red' : '' },
  ];
  document.getElementById('summaryTiles').innerHTML = tiles.map((t) => UI.statTile(t.label, t.value, { colorClass: t.cls })).join('');
}

function renderTeamTable() {
  const statusByProductId = new Map(workItems.map((x) => [x.product.id, x.logRow?.status ?? null]));
  const assignments = new Map(workItems.map((x) => [x.product.id, x.employeeId]));
  const workload = workloadByEmployee(employees, assignments, statusByProductId);

  document.getElementById('teamTableBody').innerHTML = workload
    .map(
      (w) => `
    <tr>
      <td>${UI.escapeHtml(w.employee.name)}</td>
      <td class="num">${w.total} / ${w.employee.daily_task_target ?? 10}</td>
      <td class="num" style="color:var(--green)">${w.completed}</td>
      <td class="num" style="color:var(--red)">${w.notCompleted}</td>
      <td class="num" style="color:var(--yellow)">${w.remaining}</td>
    </tr>`
    )
    .join('');
}

// ---------------------------------------------------------------------------
// 🔥 أهم الشغل النهارده
// ---------------------------------------------------------------------------

function renderTopWork() {
  const pending = workItems.filter((x) => !x.logRow);
  const order = { URGENT: 0, IMPORTANT: 1, NORMAL: 2 };
  const top = [...pending]
    .sort((a, b) => {
      const p = order[a.task.priority.code] - order[b.task.priority.code];
      if (p !== 0) return p;
      return Math.abs(b.task.diff ?? 0) - Math.abs(a.task.diff ?? 0);
    })
    .slice(0, 5);

  const card = document.getElementById('topWorkCard');
  const body = document.getElementById('topWorkBody');
  card.style.display = top.length > 0 ? 'block' : 'none';
  if (top.length === 0) return;

  body.innerHTML = top
    .map((x, i) => {
      const emp = employees.find((e) => e.id === x.employeeId);
      return `
      <div class="action-card ${x.decision.action.code}" data-id="${x.product.id}" style="cursor:pointer;">
        <div class="action-card-title">${i + 1} — ${x.task.taskType.icon} ${UI.escapeHtml(x.product.product_name)}</div>
        <div class="action-card-metrics">
          <span>👤 ${emp ? UI.escapeHtml(emp.name) : '—'}</span>
          <span>${x.task.priority.icon} ${x.task.priority.label}</span>
        </div>
        <div class="action-card-reasons">${UI.escapeHtml(x.task.requiredAction)}</div>
      </div>`;
    })
    .join('');
  body.querySelectorAll('.action-card').forEach((el) => (el.onclick = () => openProductDrawer(el.dataset.id, refresh)));
}

// ---------------------------------------------------------------------------
// ⚠️ متأخر
// ---------------------------------------------------------------------------

function renderCarriedOver() {
  const card = document.getElementById('carriedOverCard');
  const body = document.getElementById('carriedOverBody');
  const visible = state.employeeFilter === 'ALL' ? carriedOver : carriedOver.filter((x) => String(x.employeeId) === state.employeeFilter);
  card.style.display = visible.length > 0 ? 'block' : 'none';
  if (visible.length === 0) return;
  body.innerHTML = visible.map((x) => workCardHtml(x, true)).join('');
  wireWorkCards(body);
}

// ---------------------------------------------------------------------------
// Employee summary strip (shown only when a specific employee tab is active)
// ---------------------------------------------------------------------------

function renderEmployeeSummary() {
  const el = document.getElementById('employeeSummary');
  if (state.employeeFilter === 'ALL') {
    el.innerHTML = '';
    return;
  }
  const emp = employees.find((e) => String(e.id) === state.employeeFilter);
  if (!emp) {
    el.innerHTML = '';
    return;
  }
  const mine = workItems.filter((x) => x.employeeId === emp.id);
  const completed = mine.filter((x) => x.logRow?.status === ACTION_STATUS.COMPLETED).length;
  const notCompleted = mine.filter((x) => x.logRow?.status === ACTION_STATUS.NOT_COMPLETED).length;
  const remaining = mine.length - completed - notCompleted;
  const myCarried = carriedOver.filter((x) => x.employeeId === emp.id).length;
  const rate = mine.length > 0 ? Math.round((completed / mine.length) * 100) : 0;

  el.innerHTML = `
    <div class="card" style="margin-bottom:14px;">
      <div style="font-size:15px; font-weight:700; margin-bottom:8px;">شغل ${UI.escapeHtml(emp.name)} النهارده</div>
      <div class="stat-grid" style="margin-bottom:0;">
        ${[
          UI.statTile('Tasks', mine.length),
          UI.statTile('✅ تم', completed, { colorClass: 'green' }),
          UI.statTile('❌ لم يتم', notCompleted, { colorClass: 'red' }),
          UI.statTile('⏳ متبقي', remaining, { colorClass: 'yellow' }),
          UI.statTile('⚠️ مرحل', myCarried, { colorClass: myCarried > 0 ? 'red' : '' }),
          UI.statTile('نسبة الإنجاز', `${rate}%`),
        ].join('')}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Work list
// ---------------------------------------------------------------------------

function renderWorkList() {
  const el = document.getElementById('workListBody');
  const visible = state.employeeFilter === 'ALL' ? workItems : workItems.filter((x) => String(x.employeeId) === state.employeeFilter);

  if (visible.length === 0) {
    el.innerHTML = '<div class="empty-state">لا يوجد شغل مطابق.</div>';
    return;
  }

  const order = { URGENT: 0, IMPORTANT: 1, NORMAL: 2 };
  const sorted = [...visible].sort((a, b) => order[a.task.priority.code] - order[b.task.priority.code]);
  el.innerHTML = sorted.map((x) => workCardHtml(x, false)).join('');
  wireWorkCards(el);
}

function workCardHtml(item, isCarriedOver) {
  const { product, task, logRow, decision, employeeId } = item;
  const dateForAction = isCarriedOver ? item.originalDate : state.asOfDate;
  const status = logRow ? logRow.status : null;
  const emp = employees.find((e) => e.id === employeeId);
  return `
  <div class="action-card ${decision?.action?.code || ''}" data-id="${product.id}">
    <div class="action-card-title" style="cursor:pointer" data-nav="${product.id}">
      ${isCarriedOver ? '⚠️ ' : ''}${task.taskType.icon} ${UI.escapeHtml(product.product_name)}
    </div>
    <div class="action-card-metrics">
      <span class="mono">${task.yesterday ?? '—'} ← ${task.today ?? '—'}</span>
      <span>الفرق: ${UI.fmtChangeAbs(task.diff)}</span>
      <span>${task.priority.icon} ${task.priority.label}</span>
      <span>👤 ${emp ? UI.escapeHtml(emp.name) : '—'}</span>
    </div>
    <div class="action-card-reasons"><b>🎯 المطلوب:</b> ${UI.escapeHtml(task.requiredAction)}</div>
    ${
      status
        ? `<div class="follow-up-note">${status === ACTION_STATUS.COMPLETED ? '✅ تم التنفيذ' : `❌ لم يتم${logRow.not_completed_reason ? ' — ' + UI.escapeHtml(logRow.not_completed_reason) : ''}`}</div>`
        : `<div class="action-status-row" data-task-actions data-id="${product.id}" data-date="${dateForAction}" data-label="${UI.escapeHtml(task.requiredAction)}">
             <span class="status-btn" data-complete>✅ تم</span>
             <span class="status-btn" data-not-complete>❌ لم يتم</span>
           </div>`
    }
  </div>`;
}

function wireWorkCards(container) {
  container.querySelectorAll('[data-nav]').forEach((el) => {
    el.onclick = () => openProductDrawer(el.dataset.nav, refresh);
  });
  container.querySelectorAll('[data-task-actions]').forEach((row) => {
    const productId = Number(row.dataset.id);
    const date = row.dataset.date;
    const label = row.dataset.label;
    row.querySelector('[data-complete]').onclick = async () => {
      await ActionLog.markCompleted(productId, date, { actionLabel: label });
      UI.toast('✅ تم تسجيل التنفيذ');
      await refresh();
    };
    row.querySelector('[data-not-complete]').onclick = async () => {
      await ActionLog.markNotCompleted(productId, date, { actionLabel: label, reason: 'لم يتم التنفيذ' });
      UI.toast('تم تسجيل عدم التنفيذ');
      await refresh();
    };
  });
}

// ---------------------------------------------------------------------------
// 📋 مهام من المدير — task_records (👑 تحكم المدير), both 🤖 automatic and
// 👑 manager-added. This is the "employee dashboard" a manager-assigned
// task appears on. Still-open statuses only (PENDING/IN_PROGRESS/
// NOT_COMPLETED/OVERDUE) — COMPLETED lives in ✅ الشغل المكتمل below,
// CANCELLED is never shown again anywhere but the manager's history/log.
// ---------------------------------------------------------------------------

const OPEN_STATUSES = new Set([TASK_STATUS.PENDING, TASK_STATUS.IN_PROGRESS, TASK_STATUS.NOT_COMPLETED, TASK_STATUS.OVERDUE]);

function promptRequired(message) {
  while (true) {
    const value = prompt(message);
    if (value === null) return null; // user cancelled
    if (value.trim()) return value.trim();
    alert('السبب مطلوب — لازم تكتب سبب الإلغاء قبل ما تكمل.');
  }
}

function managerTaskCardHtml(t) {
  const type = TASK_TYPE[t.task_type];
  const empName = t.employee?.name || employees.find((e) => e.id === t.employee_id)?.name;
  return `
  <div class="action-card" data-task-id="${t.id}">
    <div class="action-card-title">${t.source === 'manager' ? '👑' : '🤖'} ${type ? type.icon + ' ' + type.label : t.task_type} — ${UI.escapeHtml(t.title)}</div>
    <div class="action-card-metrics">
      ${t.product_name ? `<span>📦 ${UI.escapeHtml(t.product_name)}</span>` : ''}
      ${t.related_campaign ? `<span>📣 ${UI.escapeHtml(t.related_campaign)}</span>` : ''}
      <span>${PRIORITY_LABELS[t.priority] || t.priority}</span>
      <span>👤 ${empName ? UI.escapeHtml(empName) : '—'}</span>
      <span class="faint">بواسطة: ${t.assigned_by === 'manager' ? '👑 المدير' : '🤖 تلقائي'}</span>
    </div>
    ${t.details ? `<div class="action-card-reasons" style="white-space:pre-wrap;">${UI.escapeHtml(t.details)}</div>` : ''}
    ${t.manager_note ? `<div class="action-card-reasons">📝 ملاحظة المدير: ${UI.escapeHtml(t.manager_note)}</div>` : ''}
    <div class="action-status-row" data-manager-task-actions="${t.id}">
      <span class="status-btn" data-complete>✓ إنهاء المهمة</span>
      <span class="status-btn" data-submit-result>📤 رفع النتيجة</span>
      <span class="status-btn" data-cancel>🔴 إلغاء</span>
    </div>
  </div>`;
}

function renderManagerTasks() {
  const body = document.getElementById('managerTasksBody');
  // An EMPLOYEE viewer only cares about their own assigned tasks ("مهامي" —
  // spec §7); ADMIN/MANAGER keep seeing the full team's tasks exactly as
  // before this feature.
  const forViewer =
    currentUser?.role === 'EMPLOYEE' ? managerTasks.filter((t) => t.employee_id === currentUser.id) : managerTasks;
  const visible = (state.employeeFilter === 'ALL' ? forViewer : forViewer.filter((t) => String(t.employee_id) === state.employeeFilter)).filter((t) =>
    OPEN_STATUSES.has(t.status)
  );

  if (visible.length === 0) {
    body.innerHTML = `<div class="empty-state">${currentUser?.role === 'EMPLOYEE' ? 'مفيش مهام متعينة لك حاليًا.' : 'لا توجد مهام من المدير حاليًا.'}</div>`;
    return;
  }

  const order = { URGENT: 0, IMPORTANT: 1, NORMAL: 2 };
  const sorted = [...visible].sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9));
  body.innerHTML = sorted.map(managerTaskCardHtml).join('');

  body.querySelectorAll('[data-manager-task-actions]').forEach((row) => {
    const id = Number(row.dataset.managerTaskActions);
    row.querySelector('[data-complete]').onclick = async () => {
      await completeTask(id);
      UI.toast('✅ تم إنهاء المهمة');
      await refresh();
    };
    row.querySelector('[data-submit-result]').onclick = async () => {
      const result = promptRequired('ملخص النتيجة — إيه اللي اتعمل؟ (مطلوب):');
      if (result === null) return;
      try {
        await api.patch(`/api/tasks/${id}`, { status: 'COMPLETED', completed_at: new Date().toISOString(), employee_result: result });
        UI.toast('✅ اتبعتت النتيجة — المهمة دلوقتي تحتاج مراجعة المدير');
        await refresh();
      } catch (err) {
        UI.toast(err.message, 'error');
      }
    };
    row.querySelector('[data-cancel]').onclick = async () => {
      const reason = promptRequired('سبب إلغاء المهمة (مطلوب):');
      if (reason === null) return; // cancelled the prompt — no change
      try {
        await cancelTaskByEmployee(id, reason);
        UI.toast('تم إلغاء المهمة');
        await refresh();
      } catch (err) {
        UI.toast(err.message, 'error');
      }
    };
  });
}

// ---------------------------------------------------------------------------
// ✅ الشغل المكتمل — completed task_records only, read-only historical
// record (never deleted, never re-shown as actionable).
// ---------------------------------------------------------------------------

function renderCompletedWork() {
  const body = document.getElementById('completedWorkBody');
  const visible = (state.employeeFilter === 'ALL' ? managerTasks : managerTasks.filter((t) => String(t.employee_id) === state.employeeFilter)).filter(
    (t) => t.status === TASK_STATUS.COMPLETED
  );

  if (visible.length === 0) {
    body.innerHTML = '<div class="empty-state">لا توجد مهام مكتملة اليوم بعد.</div>';
    return;
  }

  body.innerHTML = visible
    .map((t) => {
      const type = TASK_TYPE[t.task_type];
      const emp = employees.find((e) => e.id === t.employee_id);
      const completedAt = t.completed_at ? new Date(t.completed_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '—';
      return `
      <div class="action-card CONTINUE">
        <div class="action-card-title">✅ ${type ? type.icon + ' ' + type.label : t.task_type} — ${UI.escapeHtml(t.title)}</div>
        <div class="action-card-metrics">
          ${t.product_name ? `<span>📦 ${UI.escapeHtml(t.product_name)}</span>` : ''}
          <span>👤 ${emp ? UI.escapeHtml(emp.name) : '—'}</span>
          <span>🕒 ${completedAt}</span>
        </div>
      </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// 📅 نشاط الفريق اليوم — team-wide timeline (not filtered by employee tab
// on purpose — this is meant to show everyone's activity together).
// ---------------------------------------------------------------------------

function renderTeamActivity() {
  const body = document.getElementById('teamActivityBody');
  if (teamActivity.length === 0) {
    body.innerHTML = '<div class="empty-state">لا يوجد نشاط مسجَّل اليوم.</div>';
    return;
  }
  const sorted = [...teamActivity].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  body.innerHTML = sorted
    .map((r) => {
      const dt = new Date(r.created_at);
      const time = dt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
      return `
      <div class="alert-card" style="border-inline-start-color: var(--accent);">
        <div class="alert-meta" style="margin-bottom:4px;"><span class="mono">🕒 ${time}</span></div>
        <div>${ACTIVITY_LABELS[r.action_type] || r.action_type} — ${UI.escapeHtml(r.details_text || '')}</div>
      </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// 📋 Team report
// ---------------------------------------------------------------------------

function toggleTeamReport() {
  const card = document.getElementById('teamReportCard');
  const showing = card.style.display !== 'none';
  card.style.display = showing ? 'none' : 'block';
  if (!showing) renderTeamReport();
}

function buildTeamReportText() {
  const statusByProductId = new Map(workItems.map((x) => [x.product.id, x.logRow?.status ?? null]));
  const assignments = new Map(workItems.map((x) => [x.product.id, x.employeeId]));
  const workload = workloadByEmployee(employees, assignments, statusByProductId);

  const total = workItems.length;
  const completed = workItems.filter((x) => x.logRow?.status === ACTION_STATUS.COMPLETED).length;
  const notCompleted = workItems.filter((x) => x.logRow?.status === ACTION_STATUS.NOT_COMPLETED).length;

  const lines = [];
  lines.push(`📋 تقرير الشغل اللي هيتعمل — ${state.asOfDate}`);
  lines.push('');
  lines.push(`إجمالي المهام: ${total}`);
  lines.push(`تم تنفيذ: ${completed}`);
  lines.push(`لم يتم: ${notCompleted}`);
  lines.push(`ترحل للغد: ${carriedOver.length}`);
  lines.push('');
  lines.push('———  👥 أداء الفريق  ———');
  for (const w of workload) {
    lines.push(`${w.employee.name}: ${w.total} Tasks — ${w.completed} تم — ${w.notCompleted} لم يتم — ${w.remaining} متبقي`);
  }

  return { text: lines.join('\n'), summary: { total, completed, notCompleted, carriedOver: carriedOver.length } };
}

async function renderTeamReport() {
  const { text, summary } = buildTeamReportText();
  await DailyReports.save(state.asOfDate, 'TEAM_WORK', summary, text);
  document.getElementById('teamReportBody').textContent = text;
}

// ---------------------------------------------------------------------------
// 📜 History
// ---------------------------------------------------------------------------

async function toggleHistory() {
  const card = document.getElementById('historyCard');
  const showing = card.style.display !== 'none';
  card.style.display = showing ? 'none' : 'block';
  if (showing) return;

  const reports = (await DailyReports.all('TEAM_WORK')).slice(0, 7);
  const body = document.getElementById('historyBody');
  if (reports.length === 0) {
    body.innerHTML = '<div class="empty-state">لا توجد تقارير محفوظة بعد.</div>';
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
      document.getElementById('teamReportCard').style.display = 'block';
      document.getElementById('teamReportBody').textContent = report.report_text;
      document.getElementById('historyCard').style.display = 'none';
    };
  });
}

init();
