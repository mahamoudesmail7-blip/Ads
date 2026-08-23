// manager.js — page controller for manager.html (👑 تحكم المدير).
import { Products, TeamMembers, TaskRecords, TaskActivityLog, TASK_STATUS, DailyReports } from './db.js';
import * as A from './analytics.js';
import * as UI from './ui-common.js';
import { TASK_TYPE } from './task-engine.js';
import { workloadLevel, sortTasks } from './manager-engine.js';
import {
  materializeAutoTasksForDate,
  addManagerTask,
  updateTask,
  moveTask,
  cancelTask,
  changePriority,
  completeTask,
  failTask,
  setStatus,
  carriedOverTasks,
} from './task-store.js';

const state = {
  date: A.todayStr(),
  employeeFilter: 'ALL',
  statusFilter: 'ALL',
  sourceFilter: 'ALL',
  priorityFilter: 'ALL',
  typeFilter: 'ALL',
  productFilter: 'ALL',
  search: '',
  selectedIds: new Set(),
};

let employees = [];
let products = [];
let tasks = []; // task_records for state.date
let carriedOver = [];
let activityToday = []; // task_activity_log for state.date — the source of truth for "moved" counts
let editingTaskId = null;
let movingTaskId = null;

const PRIORITY_LABELS = { URGENT: '🔴 عاجل', IMPORTANT: '🟠 مهم', NORMAL: '🟡 عادي' };
const STATUS_LABELS = {
  PENDING: '⏳ قيد الانتظار',
  IN_PROGRESS: '⏳ قيد التنفيذ',
  COMPLETED: '✅ تم',
  NOT_COMPLETED: '❌ لم يتم',
  OVERDUE: '🚨 متأخرة',
  CANCELLED: '🗑️ ملغاة',
};
// Statuses a manager can pick from the row-level status selector — CANCELLED is deliberately excluded since it always needs a reason via the dedicated 🗑️ flow (cancelTask).
const SETTABLE_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'NOT_COMPLETED', 'OVERDUE'];
const SOURCE_LABELS = { automatic: '🤖 تلقائية', manager: '👑 مدير' };

async function init() {
  UI.renderSidebar('manager');
  await TeamMembers.seedDefaultTeam();

  const picker = document.getElementById('asOfDatePicker');
  picker.value = state.date;
  picker.onchange = async () => {
    state.date = picker.value;
    state.selectedIds.clear();
    await refresh();
  };
  document.getElementById('btnToday').onclick = async () => {
    state.date = A.todayStr();
    picker.value = state.date;
    state.selectedIds.clear();
    await refresh();
  };
  document.getElementById('btnYesterday').onclick = async () => {
    state.date = A.addDays(A.todayStr(), -1);
    picker.value = state.date;
    state.selectedIds.clear();
    await refresh();
  };

  document.getElementById('btnMaterialize').onclick = async () => {
    const result = await materializeAutoTasksForDate(state.date);
    UI.toast(`تم إنشاء ${result.created} مهمة تلقائية جديدة`);
    await refresh();
  };
  document.getElementById('btnAddTask').onclick = () => openTaskModal(null);
  document.getElementById('btnCancelTaskModal').onclick = closeTaskModal;
  document.getElementById('btnSaveTask').onclick = saveTaskModal;
  document.getElementById('taskModalOverlay').onclick = (e) => {
    if (e.target.id === 'taskModalOverlay') closeTaskModal();
  };
  document.getElementById('btnCancelMove').onclick = closeMoveModal;
  document.getElementById('btnConfirmMove').onclick = confirmMove;
  document.getElementById('moveModalOverlay').onclick = (e) => {
    if (e.target.id === 'moveModalOverlay') closeMoveModal();
  };
  document.getElementById('btnManagerReport').onclick = toggleReport;
  document.getElementById('btnCloseReport').onclick = () => (document.getElementById('reportCard').style.display = 'none');
  document.getElementById('btnActivityLog').onclick = toggleActivityLog;
  document.getElementById('btnCloseActivityLog').onclick = () => (document.getElementById('activityLogCard').style.display = 'none');

  document.getElementById('searchTask').oninput = (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderTaskTable();
  };
  document.getElementById('selectAll').onchange = (e) => {
    const visibleIds = filteredTasks().map((t) => t.id);
    if (e.target.checked) visibleIds.forEach((id) => state.selectedIds.add(id));
    else visibleIds.forEach((id) => state.selectedIds.delete(id));
    renderTaskTable();
    renderBulkBar();
  };
  document.getElementById('btnBulkMove').onclick = () => openMoveModal([...state.selectedIds]);
  document.getElementById('btnBulkCancel').onclick = async () => {
    if (!confirm(`هل أنت متأكد من إلغاء ${state.selectedIds.size} مهمة؟`)) return;
    for (const id of state.selectedIds) await cancelTask(id, null);
    state.selectedIds.clear();
    UI.toast('تم إلغاء المهام المحددة');
    await refresh();
  };
  document.getElementById('btnBulkUrgent').onclick = async () => {
    for (const id of state.selectedIds) await changePriority(id, 'URGENT');
    state.selectedIds.clear();
    UI.toast('تم تعيين المهام المحددة كعاجلة');
    await refresh();
  };

  buildStatusChips();
  buildSourceChips();

  employees = await TeamMembers.all();
  products = (await Products.all()).filter((p) => !p.is_demo);
  populateEmployeeSelects();
  populateProductSelect();
  populateFilterSelects();

  await refresh();

  if (UI.qs('openAdd') === '1') openTaskModal(null);
}

function populateFilterSelects() {
  const priorityEl = document.getElementById('priorityFilter');
  priorityEl.innerHTML = '<option value="ALL">كل الأولويات</option>' + Object.entries(PRIORITY_LABELS).map(([code, label]) => `<option value="${code}">${label}</option>`).join('');
  priorityEl.onchange = () => {
    state.priorityFilter = priorityEl.value;
    renderTaskTable();
  };

  const typeEl = document.getElementById('typeFilter');
  typeEl.innerHTML = '<option value="ALL">كل الأنواع</option>' + Object.values(TASK_TYPE).map((t) => `<option value="${t.code}">${t.icon} ${t.label}</option>`).join('');
  typeEl.onchange = () => {
    state.typeFilter = typeEl.value;
    renderTaskTable();
  };

  const productEl = document.getElementById('productFilter');
  const productOpts = products
    .slice()
    .sort((a, b) => a.product_name.localeCompare(b.product_name, 'ar'))
    .map((p) => `<option value="${p.id}">${UI.escapeHtml(p.product_name)}</option>`)
    .join('');
  productEl.innerHTML = '<option value="ALL">كل المنتجات</option>' + productOpts;
  productEl.onchange = () => {
    state.productFilter = productEl.value;
    renderTaskTable();
  };
}

function buildStatusChips() {
  const el = document.getElementById('statusFilterChips');
  const values = ['ALL', 'PENDING', 'COMPLETED', 'NOT_COMPLETED', 'CANCELLED'];
  el.innerHTML = values.map((v) => `<span class="chip ${v === state.statusFilter ? 'active' : ''}" data-v="${v}">${v === 'ALL' ? 'كل الحالات' : STATUS_LABELS[v]}</span>`).join('');
  el.querySelectorAll('.chip').forEach((chip) => {
    chip.onclick = () => {
      state.statusFilter = chip.dataset.v;
      el.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderTaskTable();
    };
  });
}

function buildSourceChips() {
  const el = document.getElementById('sourceFilterChips');
  const values = ['ALL', 'automatic', 'manager'];
  el.innerHTML = values.map((v) => `<span class="chip ${v === state.sourceFilter ? 'active' : ''}" data-v="${v}">${v === 'ALL' ? 'كل المصادر' : SOURCE_LABELS[v]}</span>`).join('');
  el.querySelectorAll('.chip').forEach((chip) => {
    chip.onclick = () => {
      state.sourceFilter = chip.dataset.v;
      el.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderTaskTable();
    };
  });
}

function buildEmployeeTabs() {
  const el = document.getElementById('employeeTabs');
  const values = [{ id: 'ALL', name: 'الكل' }, ...employees];
  el.innerHTML = values.map((e) => `<span class="chip ${String(e.id) === state.employeeFilter ? 'active' : ''}" data-v="${e.id}">${UI.escapeHtml(e.name)}</span>`).join('');
  el.querySelectorAll('.chip').forEach((chip) => {
    chip.onclick = () => {
      state.employeeFilter = chip.dataset.v;
      el.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderEmployeeCards();
      renderTaskTable();
    };
  });
}

function populateEmployeeSelects() {
  const opts = employees.map((e) => `<option value="${e.id}">${UI.escapeHtml(e.name)}</option>`).join('');
  document.getElementById('fEmployee').innerHTML = opts;
  document.getElementById('fMoveTo').innerHTML = opts;
}

function populateProductSelect() {
  const opts = products
    .slice()
    .sort((a, b) => a.product_name.localeCompare(b.product_name, 'ar'))
    .map((p) => `<option value="${p.id}">${UI.escapeHtml(p.product_name)}</option>`)
    .join('');
  document.getElementById('fProduct').innerHTML = '<option value="">— بدون منتج محدد —</option>' + opts;
}

async function refresh() {
  await materializeAutoTasksForDate(state.date);
  tasks = await TaskRecords.forDate(state.date);
  carriedOver = await carriedOverTasks(state.date);
  activityToday = await TaskActivityLog.forDate(state.date);
  employees = await TeamMembers.all();

  document.getElementById('dateLabel').textContent = state.date;
  buildEmployeeTabs();

  renderSummary();
  renderEmployeeCards();
  renderCarriedOver();
  renderTaskTable();
  if (document.getElementById('reportCard').style.display !== 'none') renderReport();
  if (document.getElementById('activityLogCard').style.display !== 'none') renderActivityLog();
}

// ---------------------------------------------------------------------------
// Summary + team table
// ---------------------------------------------------------------------------

function renderSummary() {
  const live = tasks.filter((t) => t.status !== TASK_STATUS.CANCELLED);
  const completed = tasks.filter((t) => t.status === TASK_STATUS.COMPLETED).length;
  const inProgress = tasks.filter((t) => t.status === TASK_STATUS.IN_PROGRESS).length;
  const notCompleted = tasks.filter((t) => t.status === TASK_STATUS.NOT_COMPLETED).length;
  const overdue = tasks.filter((t) => t.status === TASK_STATUS.OVERDUE).length;
  const remaining = tasks.filter((t) => t.status === TASK_STATUS.PENDING).length;
  const addedByManager = tasks.filter((t) => t.source === 'manager').length;
  const cancelled = tasks.filter((t) => t.status === TASK_STATUS.CANCELLED).length;
  const moved = new Set(activityToday.filter((a) => a.action_type === 'MOVE').map((a) => a.task_id)).size;

  const tiles = [
    ['إجمالي المهام', live.length],
    ['⏳ متبقي', remaining],
    ['🔄 قيد التنفيذ', inProgress],
    ['✅ تم', completed],
    ['❌ لم يتم', notCompleted],
    ['🚨 متأخرة', overdue],
    ['⚠️ مرحّل من أمس', carriedOver.length],
    ['👑 مضافة يدويًا', addedByManager],
    ['🗑️ ملغاة', cancelled],
    ['👤 منقولة', moved],
  ];
  document.getElementById('summaryTiles').innerHTML = tiles
    .map(([label, value]) => `<div class="stat-tile"><div class="label">${label}</div><div class="value">${value}</div></div>`)
    .join('');
}

function renderEmployeeCards() {
  const grid = document.getElementById('teamCardsGrid');
  const rows = employees
    .filter((e) => e.active !== false)
    .map((e) => {
      const mineAll = tasks.filter((t) => t.employee_id === e.id);
      const mine = mineAll.filter((t) => t.status !== TASK_STATUS.CANCELLED);
      const completed = mine.filter((t) => t.status === TASK_STATUS.COMPLETED).length;
      const inProgress = mine.filter((t) => t.status === TASK_STATUS.IN_PROGRESS).length;
      const remaining = mine.filter((t) => t.status === TASK_STATUS.PENDING || t.status === TASK_STATUS.IN_PROGRESS).length;
      const cancelledHere = mineAll.filter((t) => t.status === TASK_STATUS.CANCELLED).length;
      const lateHere = carriedOver.filter((t) => t.employee_id === e.id).length;
      const target = e.daily_task_target || 10;
      const level = workloadLevel(mine.length, target);
      const over = mine.length - target;
      const completionRate = mine.length > 0 ? Math.round((completed / mine.length) * 100) : 0;
      return { e, total: mine.length, completed, inProgress, remaining, cancelledHere, lateHere, level, target, over, completionRate };
    });

  grid.innerHTML = rows
    .map(
      (r) => `
    <div class="employee-card ${String(r.e.id) === state.employeeFilter ? 'active' : ''}" data-employee-card="${r.e.id}">
      <div class="employee-card-name">👤 ${UI.escapeHtml(r.e.name)}</div>
      <div class="employee-card-count">${r.total} / ${r.target} Tasks — ${r.level.icon} ${r.level.label}</div>
      ${r.over > 0 ? `<div class="employee-card-over">⚠️ ${r.over} Task إضافية فوق الهدف</div>` : ''}
      <div class="health-bar-track" style="width:100%; margin-bottom:8px;"><span class="health-bar-fill" style="width:${r.completionRate}%; background:var(--green)"></span></div>
      <div class="employee-card-stats">
        <span>✅ ${r.completed} تم</span>
        <span>⏳ ${r.remaining} متبقي</span>
        ${r.inProgress > 0 ? `<span>🔄 ${r.inProgress} قيد التنفيذ</span>` : ''}
        ${r.lateHere > 0 ? `<span style="color:var(--yellow)">⚠️ ${r.lateHere} متأخر</span>` : ''}
        ${r.cancelledHere > 0 ? `<span class="faint">🗑️ ${r.cancelledHere} ملغاة</span>` : ''}
        <span class="faint">نسبة الإنجاز: ${r.completionRate}%</span>
      </div>
      <button class="employee-card-add" data-employee-add="${r.e.id}">➕ إضافة Task</button>
    </div>`
    )
    .join('');

  grid.querySelectorAll('[data-employee-card]').forEach((card) => {
    card.onclick = (e) => {
      if (e.target.closest('[data-employee-add]')) return;
      const id = card.dataset.employeeCard;
      state.employeeFilter = state.employeeFilter === id ? 'ALL' : id;
      buildEmployeeTabs();
      renderEmployeeCards();
      renderTaskTable();
    };
  });
  grid.querySelectorAll('[data-employee-add]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openTaskModal(null, Number(btn.dataset.employeeAdd));
    };
  });
}

function renderCarriedOver() {
  const card = document.getElementById('carriedOverCard');
  const body = document.getElementById('carriedOverBody');
  card.style.display = carriedOver.length > 0 ? 'block' : 'none';
  if (carriedOver.length === 0) return;
  const empMap = new Map(employees.map((e) => [e.id, e.name]));
  body.innerHTML = carriedOver
    .map(
      (t) => `
    <div class="action-card" data-id="${t.id}">
      <div class="action-card-title">⚠️ ${TASK_TYPE[t.task_type]?.icon || ''} ${UI.escapeHtml(t.title)}${t.product_name ? ' — ' + UI.escapeHtml(t.product_name) : ''}</div>
      <div class="action-card-metrics">
        <span>👤 ${empMap.get(t.employee_id) ? UI.escapeHtml(empMap.get(t.employee_id)) : '—'}</span>
        <span>بتاريخ ${t.date}</span>
        <span>${PRIORITY_LABELS[t.priority] || t.priority}</span>
      </div>
      <div class="action-status-row" data-carried="${t.id}">
        <span class="status-btn" data-complete>✅ تم</span>
        <span class="status-btn" data-fail>❌ لم يتم</span>
      </div>
    </div>`
    )
    .join('');
  body.querySelectorAll('[data-carried]').forEach((row) => {
    const id = Number(row.dataset.carried);
    row.querySelector('[data-complete]').onclick = async () => {
      await completeTask(id);
      UI.toast('تم تنفيذ المهمة المرحّلة');
      await refresh();
    };
    row.querySelector('[data-fail]').onclick = async () => {
      await failTask(id, 'لم يتم التنفيذ', null);
      UI.toast('تم تسجيلها كغير منفذة');
      await refresh();
    };
  });
}

// ---------------------------------------------------------------------------
// Task table
// ---------------------------------------------------------------------------

function filteredTasks() {
  let list = tasks;
  if (state.employeeFilter !== 'ALL') list = list.filter((t) => String(t.employee_id) === state.employeeFilter);
  if (state.statusFilter !== 'ALL') list = list.filter((t) => t.status === state.statusFilter);
  if (state.sourceFilter !== 'ALL') list = list.filter((t) => t.source === state.sourceFilter);
  if (state.priorityFilter !== 'ALL') list = list.filter((t) => t.priority === state.priorityFilter);
  if (state.typeFilter !== 'ALL') list = list.filter((t) => t.task_type === state.typeFilter);
  if (state.productFilter !== 'ALL') list = list.filter((t) => String(t.product_id) === state.productFilter);
  if (state.search) {
    const empMap = new Map(employees.map((e) => [e.id, e.name]));
    list = list.filter((t) => {
      const employeeName = (empMap.get(t.employee_id) || '').toLowerCase();
      return (
        (t.title || '').toLowerCase().includes(state.search) ||
        (t.product_name || '').toLowerCase().includes(state.search) ||
        (t.details || '').toLowerCase().includes(state.search) ||
        (t.related_campaign || '').toLowerCase().includes(state.search) ||
        employeeName.includes(state.search)
      );
    });
  }
  return sortTasks(list);
}

function renderTaskTable() {
  const list = filteredTasks();
  const tbody = document.getElementById('taskTableBody');
  document.getElementById('emptyState').style.display = list.length === 0 ? 'block' : 'none';
  const empMap = new Map(employees.map((e) => [e.id, e.name]));

  tbody.innerHTML = list
    .map((t) => {
      const type = TASK_TYPE[t.task_type];
      const checked = state.selectedIds.has(t.id) ? 'checked' : '';
      const isCancelled = t.status === TASK_STATUS.CANCELLED;
      const statusCell = isCancelled
        ? STATUS_LABELS[t.status]
        : `<select data-status-select="${t.id}">${SETTABLE_STATUSES.map((s) => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}</select>`;
      return `
      <tr>
        <td><input type="checkbox" data-select="${t.id}" ${checked} /></td>
        <td>${UI.escapeHtml(t.title)}${t.product_name ? `<div class="faint" style="font-size:11px;">📦 ${UI.escapeHtml(t.product_name)}</div>` : ''}${t.related_campaign ? `<div class="faint" style="font-size:11px;">📣 ${UI.escapeHtml(t.related_campaign)}</div>` : ''} <span class="faint" style="font-size:10px;">${SOURCE_LABELS[t.source]}</span></td>
        <td>${type ? type.icon + ' ' + type.label : t.task_type}</td>
        <td class="num mono">${t.yesterday ?? '—'} ← ${t.today ?? '—'}</td>
        <td class="num">${t.diff !== null && t.diff !== undefined ? UI.fmtChangeAbs(t.diff) : '—'}</td>
        <td>${PRIORITY_LABELS[t.priority] || t.priority}</td>
        <td>${empMap.get(t.employee_id) ? UI.escapeHtml(empMap.get(t.employee_id)) : '<span class="faint">—</span>'}</td>
        <td>${statusCell}</td>
        <td>${SOURCE_LABELS[t.source] || t.source}</td>
        <td>
          <span class="status-btn" data-edit="${t.id}">✏️</span>
          <span class="status-btn" data-move="${t.id}">👤</span>
          ${!isCancelled ? `<span class="status-btn" data-cancel="${t.id}">🗑️</span>` : ''}
        </td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('[data-select]').forEach((el) => {
    el.onchange = () => {
      const id = Number(el.dataset.select);
      if (el.checked) state.selectedIds.add(id);
      else state.selectedIds.delete(id);
      renderBulkBar();
    };
  });
  tbody.querySelectorAll('[data-status-select]').forEach((el) => {
    el.onchange = async () => {
      const id = Number(el.dataset.statusSelect);
      const newStatus = el.value;
      if (newStatus === TASK_STATUS.NOT_COMPLETED) {
        const reason = prompt('سبب عدم التنفيذ (اختياري):') || null;
        await failTask(id, reason, null);
      } else if (newStatus === TASK_STATUS.COMPLETED) {
        await completeTask(id);
      } else {
        await setStatus(id, newStatus);
      }
      UI.toast('تم تحديث حالة المهمة');
      await refresh();
    };
  });
  tbody.querySelectorAll('[data-edit]').forEach((el) => {
    el.onclick = () => {
      const task = tasks.find((t) => t.id === Number(el.dataset.edit));
      openTaskModal(task);
    };
  });
  tbody.querySelectorAll('[data-move]').forEach((el) => {
    el.onclick = () => openMoveModal([Number(el.dataset.move)]);
  });
  tbody.querySelectorAll('[data-cancel]').forEach((el) => {
    el.onclick = async () => {
      if (!confirm('هل أنت متأكد من حذف هذه المهمة؟')) return;
      const reason = prompt('سبب الإلغاء (اختياري):') || null;
      await cancelTask(Number(el.dataset.cancel), reason);
      UI.toast('تم إلغاء المهمة');
      await refresh();
    };
  });

  renderBulkBar();
}

function renderBulkBar() {
  const bar = document.getElementById('bulkBar');
  bar.style.display = state.selectedIds.size > 0 ? 'flex' : 'none';
  document.getElementById('bulkCount').textContent = `${state.selectedIds.size} محدد`;
}

// ---------------------------------------------------------------------------
// Add/Edit modal
// ---------------------------------------------------------------------------

function openTaskModal(task, presetEmployeeId) {
  editingTaskId = task ? task.id : null;
  document.getElementById('taskModalTitle').textContent = task
    ? 'تعديل المهمة'
    : presetEmployeeId
      ? `إضافة Task لـ ${UI.escapeHtml(employees.find((e) => e.id === presetEmployeeId)?.name || '')}`
      : 'إضافة مهمة جديدة';
  document.getElementById('fEmployee').value = task ? task.employee_id ?? '' : presetEmployeeId ?? employees[0]?.id ?? '';
  document.getElementById('fTaskType').value = task ? task.task_type : 'OTHER';
  document.getElementById('fProduct').value = task ? task.product_id ?? '' : '';
  document.getElementById('fTitle').value = task ? task.title : '';
  document.getElementById('fDetails').value = task ? task.details || '' : '';
  document.getElementById('fCampaign').value = task ? task.related_campaign || '' : '';
  document.getElementById('fPriority').value = task ? task.priority : 'IMPORTANT';
  document.getElementById('fDueDate').value = task ? task.due_date || state.date : state.date;
  document.getElementById('fExecutionDate').value = task ? task.date : state.date;
  document.getElementById('fManagerNote').value = task ? task.manager_note || '' : '';
  document.getElementById('taskModalOverlay').style.display = 'flex';
}

function closeTaskModal() {
  document.getElementById('taskModalOverlay').style.display = 'none';
}

async function saveTaskModal() {
  const title = document.getElementById('fTitle').value.trim();
  if (!title) {
    UI.toast('عنوان المهمة مطلوب', 'error');
    return;
  }
  const executionDate = document.getElementById('fExecutionDate').value || state.date;
  const payload = {
    employeeId: Number(document.getElementById('fEmployee').value) || null,
    taskType: document.getElementById('fTaskType').value,
    productId: document.getElementById('fProduct').value ? Number(document.getElementById('fProduct').value) : null,
    title,
    details: document.getElementById('fDetails').value.trim(),
    relatedCampaign: document.getElementById('fCampaign').value.trim(),
    priority: document.getElementById('fPriority').value,
    dueDate: document.getElementById('fDueDate').value || executionDate,
    managerNote: document.getElementById('fManagerNote').value.trim(),
  };

  if (editingTaskId) {
    await updateTask(editingTaskId, {
      employee_id: payload.employeeId,
      task_type: payload.taskType,
      product_id: payload.productId,
      title: payload.title,
      details: payload.details,
      related_campaign: payload.relatedCampaign || null,
      priority: payload.priority,
      due_date: payload.dueDate,
      manager_note: payload.managerNote,
      date: executionDate,
    });
    UI.toast('تم تحديث المهمة');
  } else {
    await addManagerTask({ date: executionDate, ...payload });
    UI.toast('تم إضافة المهمة');
  }
  closeTaskModal();
  // The task may now belong to a different date than the one currently viewed (moved via تاريخ التنفيذ, or just-added for a future date) — refresh() re-reads state.date, so switch the view to match what the manager actually just touched.
  if (executionDate !== state.date) {
    state.date = executionDate;
    document.getElementById('asOfDatePicker').value = executionDate;
  }
  await refresh();
}

// ---------------------------------------------------------------------------
// Move modal
// ---------------------------------------------------------------------------

function openMoveModal(ids) {
  movingTaskId = ids;
  document.getElementById('moveModalOverlay').style.display = 'flex';
}
function closeMoveModal() {
  document.getElementById('moveModalOverlay').style.display = 'none';
}
async function confirmMove() {
  const newEmployeeId = Number(document.getElementById('fMoveTo').value);
  const ids = Array.isArray(movingTaskId) ? movingTaskId : [movingTaskId];
  for (const id of ids) await moveTask(id, newEmployeeId);
  state.selectedIds.clear();
  closeMoveModal();
  UI.toast('تم نقل المهمة');
  await refresh();
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

const ACTION_LABELS = {
  ADD: '👑 أضاف Task',
  EDIT: '✏️ عدّل Task',
  MOVE: '👤 نقل Task',
  CANCEL: '🗑️ ألغى Task',
  PRIORITY_CHANGE: '🔺 غيّر الأولوية',
  NOTE: '📝 أضاف ملاحظة',
  STATUS_CHANGE: '🔁 غيّر الحالة',
  EMPLOYEE_COMPLETE: '🟢 أنهى مهمة',
  EMPLOYEE_NOT_COMPLETE: '🟡 لم ينهِ مهمة',
  EMPLOYEE_CANCEL: '🔴 ألغى مهمة (موظف)',
};

async function toggleActivityLog() {
  const card = document.getElementById('activityLogCard');
  const showing = card.style.display !== 'none';
  card.style.display = showing ? 'none' : 'block';
  if (!showing) await renderActivityLog();
}

async function renderActivityLog() {
  const rows = (await TaskActivityLog.forDate(state.date)).slice(0, 50);
  const body = document.getElementById('activityLogBody');
  if (rows.length === 0) {
    body.innerHTML = '<div class="empty-state">لا يوجد نشاط مسجَّل اليوم.</div>';
    return;
  }
  body.innerHTML = rows
    .map((r) => {
      const dt = new Date(r.created_at);
      return `
      <div class="alert-card" style="border-inline-start-color: var(--accent);">
        <div class="alert-meta" style="margin-bottom:4px;"><span class="mono">${dt.toLocaleDateString('ar-EG')} ${dt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</span></div>
        <div>${ACTION_LABELS[r.action_type] || r.action_type} — ${UI.escapeHtml(r.details_text || '')}</div>
      </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Manager report
// ---------------------------------------------------------------------------

function toggleReport() {
  const card = document.getElementById('reportCard');
  const showing = card.style.display !== 'none';
  card.style.display = showing ? 'none' : 'block';
  if (!showing) renderReport();
}

function buildReportText() {
  const added = tasks.filter((t) => t.source === 'manager').length;
  const moved = new Set(activityToday.filter((a) => a.action_type === 'MOVE').map((a) => a.task_id)).size;
  const cancelled = tasks.filter((t) => t.status === TASK_STATUS.CANCELLED).length;
  const completed = tasks.filter((t) => t.status === TASK_STATUS.COMPLETED).length;
  const notCompleted = tasks.filter((t) => t.status === TASK_STATUS.NOT_COMPLETED).length;

  const lines = [];
  lines.push(`📋 تقرير تحكم المدير — ${state.date}`);
  lines.push('');
  lines.push(`Tasks Added By Manager: ${added}`);
  lines.push(`Tasks Moved: ${moved}`);
  lines.push(`Tasks Cancelled: ${cancelled}`);
  lines.push(`Tasks Completed: ${completed}`);
  lines.push(`Tasks Not Completed: ${notCompleted}`);
  lines.push(`Tasks Carried Over: ${carriedOver.length}`);
  lines.push('');
  lines.push('———  حسب الموظف  ———');
  for (const e of employees.filter((e) => e.active !== false)) {
    const mine = tasks.filter((t) => t.employee_id === e.id);
    const c = mine.filter((t) => t.status === TASK_STATUS.COMPLETED).length;
    const nc = mine.filter((t) => t.status === TASK_STATUS.NOT_COMPLETED).length;
    const canc = mine.filter((t) => t.status === TASK_STATUS.CANCELLED).length;
    const late = carriedOver.filter((t) => t.employee_id === e.id).length;
    const manual = mine.filter((t) => t.source === 'manager').length;
    const auto = mine.filter((t) => t.source === 'automatic').length;
    lines.push(`${e.name}: ${mine.filter((t) => t.status !== TASK_STATUS.CANCELLED).length} Tasks — ✅${c} — ❌${nc} — 🚨${late} متأخر — 🗑️${canc} — 👑${manual} — 🤖${auto}`);
  }

  return { text: lines.join('\n'), summary: { total: tasks.filter((t) => t.status !== TASK_STATUS.CANCELLED).length, completed, notCompleted, carriedOver: carriedOver.length } };
}

async function renderReport() {
  const { text, summary } = buildReportText();
  await DailyReports.save(state.date, 'MANAGER_CONTROL', summary, text);
  document.getElementById('reportBody').textContent = text;
}

init();
