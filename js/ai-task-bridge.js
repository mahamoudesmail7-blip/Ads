// ai-task-bridge.js — the ONE place that renders "AI recommendation -> real
// task" UI, shared by ai-intelligence.html and manager.html so the two
// pages can never drift (spec: "Connect AI Intelligence with Manager
// Control"). AI Intelligence = analyze + recommend; Manager Control =
// decide + assign + follow up — this module is the bridge between them,
// never a third decision-maker: it only ever proposes a pre-filled task a
// human reviews and can edit before it's created. Employee assignment is
// required (spec: "Improve AI Recommendation -> Task Assignment Flow") —
// the manager always makes the final call, but a task can't be created
// with nobody responsible for it.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const PRIORITY_LABELS = { URGENT: '🔴 عاجل', IMPORTANT: '🟠 مهم', NORMAL: '🟡 عادي' };
const TASK_TYPE_LABELS = {
  SCALE: '🔥 ارفع الميزانية تدريجيًا', REDUCE: '⬇️ قلل الميزانية وراجع الإعلان', PAUSE_REVIEW: '🚨 أوقف/راجع الكامبين',
  MONITOR: '👀 استمر وراقب', CHECK_STOCK: '📦 راجع المخزون', REVIEW_PRODUCT: '🛠️ راجع الإعلان وسبب انخفاض الأوردرات',
  COLLECT_DATA: '🆕 اجمع بيانات أكثر', TEST_CREATIVE: '🧪 جرّب تصميم إعلان جديد', CAMPAIGN: '🎯 مهمة متعلقة بالحملة', OTHER: '📌 مهمة أخرى',
};
const PRIORITY_SUGGESTION = { STOP: 'URGENT', SCALE: 'IMPORTANT', OPTIMIZE: 'IMPORTANT', COLLECT_MORE_DATA: 'NORMAL' };
const TASK_TYPE_SUGGESTION = { SCALE: 'SCALE', OPTIMIZE: 'REVIEW_PRODUCT', STOP: 'PAUSE_REVIEW', COLLECT_MORE_DATA: 'COLLECT_DATA' };
const TASK_STATUS_LABELS = { PENDING: 'جديدة', IN_PROGRESS: 'جاري العمل', COMPLETED: 'مكتملة', NOT_COMPLETED: 'متوقفة', OVERDUE: 'متأخرة', CANCELLED: 'ملغاة' };
const ROLE_LABELS = { ADMIN: 'مدير النظام', MANAGER: 'مدير', EMPLOYEE: 'موظف' };

let currentModalCtx = null; // {entity, planItem, onCreated}
let currentEmployees = []; // last-fetched assignable-employees list (re-fetched whenever task type changes, for the suggestion)
let selectedEmployeeId = null;

function money(n) {
  return n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function initials(name) {
  return (name || '؟').trim().slice(0, 1).toUpperCase();
}

function suggestTitle(entity) {
  const verb = { SCALE: 'توسيع', OPTIMIZE: 'تحسين', STOP: 'معالجة', COLLECT_MORE_DATA: 'متابعة' }[entity.classification] || 'مراجعة';
  return `${verb} ${entity.entityType === 'product' ? 'منتج' : 'حملة'} ${entity.entityName}`;
}

function suggestDetails(entity, planItem) {
  const lines = [
    `${entity.entityType === 'product' ? 'المنتج' : 'الحملة'}: ${entity.entityName}`,
    `الصرف: ${money(entity.spend)} جنيه`,
    `النتائج: ${entity.results ?? '—'}`,
    `CPA: ${entity.cpa !== null ? entity.cpa.toFixed(1) : '—'} جنيه`,
  ];
  if (planItem?.reason) lines.push('', `السبب: ${planItem.reason}`);
  if (planItem?.recommendedAction) lines.push('', `توصية AI: ${planItem.recommendedAction}`);
  return lines.join('\n');
}

/** The 5-state assignment-status vocabulary (spec §11) layered on top of the underlying TaskRecord status/review_status — never a new DB value, just how it reads to a human. */
export function assignmentStatusLabel(t) {
  if (t.reviewStatus === 'PENDING_REVIEW') return '🟡 تحتاج مراجعة';
  if (t.status === 'COMPLETED' && t.reviewStatus === 'APPROVED') return '🟢 مكتملة';
  if (t.status === 'IN_PROGRESS') return '🔵 جاري التنفيذ';
  if (t.status === 'PENDING') return '🟣 تم إنشاء مهمة';
  return TASK_STATUS_LABELS[t.status] || t.status; // NOT_COMPLETED / CANCELLED / OVERDUE fall back to the plain label
}

/** The task-status/action row embedded inside a caller's own card markup — either the convert button, or the existing task's status + a view-task link. */
export function taskActionHtml(entity) {
  const t = entity.task;
  if (!t || !t.blocksConversion) {
    return `<button class="btn secondary small" data-convert-entity="${entity.entityType}:${UI.escapeHtml(entity.entityKey)}">→ تحويل إلى مهمة</button>`;
  }
  return `
    <div style="font-size:12px; margin-top:4px;">
      <b>${assignmentStatusLabel(t)}</b>
      ${t.assignedToName ? `<span class="faint"> — 👤 المسؤول:</span> ${UI.escapeHtml(t.assignedToName)}` : ''}
    </div>
    <button class="btn secondary small" data-view-task="${t.taskId}">عرض المهمة</button>
  `;
}

/** Attaches click handlers for every [data-convert-entity]/[data-view-task] inside `container`. `entityLookup(key)` resolves "type:key" back to the full entity+planItem the card was built from. `onChanged()` is called after a task is created (so the caller can refresh). */
export function wireTaskActions(container, entityLookup, onChanged) {
  container.querySelectorAll('[data-convert-entity]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const { entity, planItem } = entityLookup(btn.dataset.convertEntity);
      if (entity) openConvertToTaskModal(entity, planItem, onChanged);
    };
  });
  container.querySelectorAll('[data-view-task]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      viewTaskModal(Number(btn.dataset.viewTask));
    };
  });
}

async function loadAssignableEmployees(taskType) {
  currentEmployees = await api.get('/api/tasks/assignable-employees', taskType ? { taskType } : undefined);
  return currentEmployees;
}

function ensureModalMounted() {
  if (document.getElementById('aiTaskModalOverlay')) return;
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="aiTaskModalOverlay" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:260; align-items:center; justify-content:center; padding:20px;">
      <div class="card" style="width:520px; max-width:100%; max-height:90vh; overflow-y:auto;">
        <div class="section-title" style="margin-top:0;">✦ تحويل توصية AI إلى مهمة</div>
        <div class="card" style="background:var(--accent-dim); border-color:var(--accent); margin-bottom:14px;">
          <div class="faint" style="font-size:11.5px; margin-bottom:4px;">توصية AI (للعرض فقط)</div>
          <div id="aiTaskAiBlock" style="font-size:13px;"></div>
        </div>

        <div class="field-row">
          <div class="field">
            <label>الموظف المسؤول *</label>
            <div class="combobox" id="aiTaskEmployeeCombo">
              <input type="text" id="aiTaskEmployeeSearch" placeholder="ابحث عن موظف..." autocomplete="off" />
              <div class="combobox-list" id="aiTaskEmployeeList" style="display:none;"></div>
            </div>
            <div class="field-error" id="aiTaskEmployeeError" style="display:none;">يرجى اختيار الموظف المسؤول عن تنفيذ المهمة</div>
          </div>
          <div class="field"><label>الأولوية *</label><select id="aiTaskPriority"></select></div>
        </div>

        <div class="field-row">
          <div class="field"><label>نوع المهمة</label><select id="aiTaskType"></select></div>
          <div class="field"><label>تاريخ التنفيذ</label><input type="date" id="aiTaskExecutionDate" class="ltr" /></div>
        </div>

        <div class="field"><label>عنوان المهمة *</label><input type="text" id="aiTaskTitle" /></div>
        <div class="field"><label>تفاصيل المهمة *</label><textarea id="aiTaskDetails" rows="5" style="width:100%; background:var(--bg-elevated); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:8px; font-family:inherit;"></textarea></div>
        <div class="field"><label>الموعد النهائي (اختياري)</label><input type="date" id="aiTaskDueDate" class="ltr" /></div>

        <div id="aiTaskStatus" class="faint" style="font-size:12.5px; margin-bottom:10px; display:none;"></div>
        <div class="toolbar" style="justify-content:flex-end;">
          <button class="btn secondary" id="aiTaskCancelBtn">إلغاء</button>
          <button class="btn" id="aiTaskSaveBtn">إنشاء المهمة</button>
        </div>
      </div>
    </div>
    <div id="aiViewTaskOverlay" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:260; align-items:center; justify-content:center; padding:20px;">
      <div class="card" style="width:420px; max-width:100%;">
        <div class="section-title" style="margin-top:0;">📋 المهمة</div>
        <div id="aiViewTaskBody" style="font-size:13.5px;"></div>
        <div class="toolbar" style="justify-content:flex-end; margin-top:14px;">
          <a class="btn secondary" href="manager.html">افتح في تحكم المدير</a>
          <button class="btn" id="aiViewTaskCloseBtn">إغلاق</button>
        </div>
      </div>
    </div>`
  );

  document.getElementById('aiTaskCancelBtn').onclick = closeConvertModal;
  document.getElementById('aiTaskModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'aiTaskModalOverlay') closeConvertModal();
  });
  document.getElementById('aiTaskSaveBtn').onclick = submitConvertModal;
  document.getElementById('aiViewTaskCloseBtn').onclick = () => (document.getElementById('aiViewTaskOverlay').style.display = 'none');
  document.getElementById('aiViewTaskOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'aiViewTaskOverlay') document.getElementById('aiViewTaskOverlay').style.display = 'none';
  });

  const searchInput = document.getElementById('aiTaskEmployeeSearch');
  searchInput.addEventListener('input', () => {
    // Typing is always the start of a fresh search — the previous selection
    // (if any) must not silently ride along under new-looking search text
    // until the manager actually clicks a result again.
    selectedEmployeeId = null;
    renderEmployeeList(searchInput.value);
  });
  searchInput.addEventListener('focus', () => renderEmployeeList(searchInput.value));
  document.addEventListener('click', (e) => {
    if (!document.getElementById('aiTaskEmployeeCombo').contains(e.target)) {
      document.getElementById('aiTaskEmployeeList').style.display = 'none';
    }
  });

  document.getElementById('aiTaskType').addEventListener('change', async (e) => {
    await loadAssignableEmployees(e.target.value);
    // A manager who already picked someone keeps their choice — the refreshed list only changes who's marked "مقترح" for next time, never silently reassigns.
    if (!selectedEmployeeId) applySuggestionIfAny();
  });
}

function employeeById(id) {
  return currentEmployees.find((e) => String(e.id) === String(id));
}

function selectEmployee(emp) {
  selectedEmployeeId = emp ? emp.id : null;
  document.getElementById('aiTaskEmployeeSearch').value = emp ? emp.name : '';
  document.getElementById('aiTaskEmployeeList').style.display = 'none';
  document.getElementById('aiTaskEmployeeError').style.display = 'none';
}

function applySuggestionIfAny() {
  const suggested = currentEmployees.find((e) => e.suggested);
  if (suggested) selectEmployee(suggested);
}

function renderEmployeeList(query) {
  const list = document.getElementById('aiTaskEmployeeList');
  const q = (query || '').trim().toLowerCase();
  const filtered = q ? currentEmployees.filter((e) => e.name.toLowerCase().includes(q)) : currentEmployees;

  if (filtered.length === 0) {
    list.innerHTML = '<div class="combobox-empty">مفيش موظفين مطابقين.</div>';
  } else {
    list.innerHTML = filtered
      .map(
        (e) => `
        <div class="combobox-item" data-emp-id="${e.id}">
          <div class="account-avatar sm">${UI.escapeHtml(initials(e.name))}</div>
          <div style="flex:1; min-width:0;">
            <div class="name">${UI.escapeHtml(e.name)}${e.suggested ? ' <span class="badge accent">مقترح</span>' : ''}</div>
            <div class="role">${ROLE_LABELS[e.role] || e.role}${e.activeTaskCount ? ` — ${e.activeTaskCount} مهمة مفتوحة` : ' — مفيش مهام مفتوحة'}</div>
          </div>
        </div>`
      )
      .join('');
    list.querySelectorAll('[data-emp-id]').forEach((row) => {
      row.onclick = () => selectEmployee(employeeById(row.dataset.empId));
    });
  }
  list.style.display = 'block';
}

export async function openConvertToTaskModal(entity, planItem, onCreated) {
  ensureModalMounted();
  currentModalCtx = { entity, planItem, onCreated };
  selectedEmployeeId = null;

  document.getElementById('aiTaskAiBlock').innerHTML = `
    <div><b>${UI.escapeHtml(entity.entityName)}</b> — CPA ${entity.cpa !== null ? entity.cpa.toFixed(1) : '—'} جنيه، صرف ${money(entity.spend)} جنيه، نتائج ${entity.results ?? '—'}</div>
    ${planItem?.reason ? `<div style="margin-top:6px;">${UI.escapeHtml(planItem.reason)}</div>` : ''}
    ${planItem?.recommendedAction ? `<div style="margin-top:4px; font-weight:600;">${UI.escapeHtml(planItem.recommendedAction)}</div>` : ''}
  `;

  const prioritySelect = document.getElementById('aiTaskPriority');
  prioritySelect.innerHTML = Object.entries(PRIORITY_LABELS).map(([code, label]) => `<option value="${code}">${label}</option>`).join('');
  prioritySelect.value = PRIORITY_SUGGESTION[entity.classification] || 'NORMAL';

  const suggestedType = TASK_TYPE_SUGGESTION[entity.classification] || 'OTHER';
  const typeSelect = document.getElementById('aiTaskType');
  typeSelect.innerHTML = Object.entries(TASK_TYPE_LABELS).map(([code, label]) => `<option value="${code}">${label}</option>`).join('');
  typeSelect.value = suggestedType;

  document.getElementById('aiTaskTitle').value = suggestTitle(entity);
  document.getElementById('aiTaskDetails').value = suggestDetails(entity, planItem);
  document.getElementById('aiTaskDueDate').value = '';
  document.getElementById('aiTaskExecutionDate').value = new Date().toISOString().slice(0, 10);
  document.getElementById('aiTaskStatus').style.display = 'none';
  document.getElementById('aiTaskEmployeeError').style.display = 'none';

  const searchInput = document.getElementById('aiTaskEmployeeSearch');
  searchInput.value = '';
  searchInput.placeholder = 'جارِ تحميل الموظفين...';
  document.getElementById('aiTaskModalOverlay').style.display = 'flex';

  try {
    await loadAssignableEmployees(suggestedType);
    searchInput.placeholder = 'ابحث عن موظف...';
    applySuggestionIfAny();
  } catch (err) {
    searchInput.placeholder = 'تعذّر تحميل الموظفين';
  }
}

function closeConvertModal() {
  document.getElementById('aiTaskModalOverlay').style.display = 'none';
  document.getElementById('aiTaskEmployeeList').style.display = 'none';
  currentModalCtx = null;
}

async function submitConvertModal() {
  if (!currentModalCtx) return;
  const { entity, onCreated } = currentModalCtx;
  const title = document.getElementById('aiTaskTitle').value.trim();
  if (!title) {
    UI.toast('لازم تكتب عنوان المهمة', 'error');
    return;
  }
  if (!selectedEmployeeId) {
    document.getElementById('aiTaskEmployeeError').style.display = 'block';
    document.getElementById('aiTaskEmployeeSearch').focus();
    return;
  }

  const statusEl = document.getElementById('aiTaskStatus');
  statusEl.style.display = 'block';
  statusEl.textContent = 'بيتعمل...';

  try {
    await api.post('/api/ai-intelligence/decisions/convert-to-task', {
      entityType: entity.entityType,
      entityKey: entity.entityKey,
      employeeId: selectedEmployeeId,
      priority: document.getElementById('aiTaskPriority').value,
      taskType: document.getElementById('aiTaskType').value,
      title,
      details: document.getElementById('aiTaskDetails').value.trim() || null,
      dueDate: document.getElementById('aiTaskDueDate').value || null,
      executionDate: document.getElementById('aiTaskExecutionDate').value || null,
    });
    UI.toast('✅ اتعملت المهمة');
    closeConvertModal();
    if (onCreated) onCreated();
  } catch (err) {
    if (err.code === 'TASK_EXISTS') {
      statusEl.textContent = '⚠️ هذه التوصية لديها مهمة مرتبطة بالفعل.';
    } else {
      statusEl.textContent = `⚠️ ${err.message}`;
    }
  }
}

async function viewTaskModal(taskId) {
  ensureModalMounted();
  const body = document.getElementById('aiViewTaskBody');
  body.innerHTML = 'جارِ التحميل…';
  document.getElementById('aiViewTaskOverlay').style.display = 'flex';
  try {
    const task = await api.get('/api/tasks', { id: taskId });
    body.innerHTML = `
      <div style="margin-bottom:6px;"><b>${UI.escapeHtml(task.title || '—')}</b></div>
      <div class="faint" style="font-size:12.5px; margin-bottom:10px;">${UI.escapeHtml(task.product_name || task.related_campaign || '')}</div>
      <div>الحالة: <b>${assignmentStatusLabel({ status: task.status, reviewStatus: task.review_status })}</b></div>
      ${task.employee?.name ? `<div>👤 المسؤول: ${UI.escapeHtml(task.employee.name)}</div>` : ''}
      <div>الأولوية: ${PRIORITY_LABELS[task.priority] || task.priority || '—'}</div>
      ${task.details ? `<div style="margin-top:8px; white-space:pre-wrap;">${UI.escapeHtml(task.details)}</div>` : ''}
      ${task.employee_result ? `<div style="margin-top:8px;"><b>نتيجة الموظف:</b><br>${UI.escapeHtml(task.employee_result)}</div>` : ''}
    `;
  } catch (err) {
    body.innerHTML = `⚠️ ${UI.escapeHtml(err.message)}`;
  }
}
