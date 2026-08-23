// task-store.js — orchestration layer for 👑 تحكم المدير: turns today's
// live Decision Engine output into persisted, editable task_records
// (materialization), plus every manager mutation (add/edit/move/cancel/
// priority/note), each logging to task_activity_log where the spec calls
// for an audit trail.
//
// Relationship to tasks.html/work.html: those two pages still use their
// original model (recompute live each load + action_log/task_assignments
// for status/employee) — this is a SEPARATE, parallel tracking system
// built for the Manager Control page specifically, not a replacement.
// Unifying them would mean migrating tasks.js/work.js's read/write paths
// onto task_records too; that's a real follow-up, not done here — seeing
// through that risk under this scope would have meant destabilizing two
// already-verified pages. Documented plainly in the final report as well.
import { Products, DailyOrders, Settings, TeamMembers, TaskRecords, TaskActivityLog, TASK_STATUS } from './db.js';
import { addDays, todayStr } from './analytics.js';
import { buildProductBundle } from './product-bundle.js';
import { classifyDailyStatus } from './daily-monitor.js';
import { analyzeProductDecision } from './decision-engine.js';
import { buildTask } from './task-engine.js';

const ACTIONABLE = new Set(['URGENT', 'IMPORTANT']);

async function computeAutoItems(date) {
  const settings = await Settings.get();
  const products = (await Products.all()).filter((p) => !p.is_demo && p.active);
  const allOrders = await DailyOrders.all();
  const byProduct = new Map();
  for (const o of allOrders) {
    if (!byProduct.has(o.product_id)) byProduct.set(o.product_id, []);
    byProduct.get(o.product_id).push(o);
  }

  return products
    .map((p) => {
      const { a, inventory, v2 } = buildProductBundle(p, byProduct.get(p.id) || [], date, settings);
      const dailyStatus = classifyDailyStatus(a, settings);
      const decision = analyzeProductDecision(a, dailyStatus, v2.type, inventory);
      const task = buildTask({ product: p, a, decision, inventory });
      return { product: p, a, decision, task };
    })
    .filter((x) => ACTIONABLE.has(x.task.priority.code));
}

/**
 * Idempotently ensures every actionable auto-decision for `date` has a
 * corresponding task_record — safe to call every time the manager page
 * (or tasks.html/work.html) loads. Never touches an existing record, so a
 * manager's edits from an earlier visit are never overwritten (spec
 * section 10). New automatic tasks are assigned to whichever active
 * employee currently has the least load that day, matching
 * team-engine.js's algorithm.
 */
export async function materializeAutoTasksForDate(date) {
  const [autoItems, existingRecords, employees] = await Promise.all([computeAutoItems(date), TaskRecords.forDate(date), TeamMembers.all()]);

  const existingAutoProductIds = new Set(existingRecords.filter((r) => r.source === 'automatic').map((r) => r.product_id));
  const toCreate = autoItems.filter((x) => !existingAutoProductIds.has(x.product.id));

  const active = employees.filter((e) => e.active !== false);
  const load = new Map(active.map((e) => [e.id, 0]));
  for (const r of existingRecords) {
    if (r.status !== TASK_STATUS.CANCELLED && load.has(r.employee_id)) load.set(r.employee_id, load.get(r.employee_id) + 1);
  }

  const order = { URGENT: 0, IMPORTANT: 1, NORMAL: 2 };
  toCreate.sort((x, y) => (order[x.task.priority.code] ?? 9) - (order[y.task.priority.code] ?? 9));

  let created = 0;
  for (const x of toCreate) {
    let employeeId = null;
    if (active.length > 0) {
      let best = active[0];
      for (const e of active) if (load.get(e.id) < load.get(best.id)) best = e;
      employeeId = best.id;
      load.set(best.id, load.get(best.id) + 1);
    }
    await TaskRecords.create({
      date,
      product_id: x.product.id,
      product_name: x.product.product_name,
      task_type: x.task.taskType.code,
      title: x.task.requiredAction,
      details: x.decision.note,
      priority: x.task.priority.code,
      employee_id: employeeId,
      source: 'automatic',
      assignment_source: 'automatic',
      assigned_by: 'automatic',
      assigned_at: new Date().toISOString(),
      today: x.a.today,
      yesterday: x.a.yesterday,
      diff: x.a.change.abs,
      due_date: date,
    });
    created++;
  }

  return { created, totalAutomatic: autoItems.length };
}

// ---------------------------------------------------------------------------
// Manager mutations — every one logs to task_activity_log except routine
// employee completions (spec's activity-log examples are all manager
// actions).
// ---------------------------------------------------------------------------

export async function addManagerTask({ date, productId, taskType, title, details, priority, employeeId, dueDate, managerNote, relatedCampaign }) {
  let productName = null;
  let today = null;
  let yesterday = null;
  let diff = null;
  if (productId) {
    const product = await Products.get(productId);
    if (product) {
      productName = product.product_name;
      const settings = await Settings.get();
      const records = await DailyOrders.forProduct(productId);
      const { a } = buildProductBundle(product, records, date, settings);
      today = a.today;
      yesterday = a.yesterday;
      diff = a.change.abs;
    }
  }

  const task = await TaskRecords.create({
    date,
    product_id: productId || null,
    product_name: productName,
    task_type: taskType,
    title,
    details: details || '',
    priority,
    employee_id: employeeId || null,
    source: 'manager',
    assignment_source: 'manager',
    manager_note: managerNote || null,
    related_campaign: relatedCampaign || null,
    assigned_by: 'manager',
    assigned_at: new Date().toISOString(),
    today,
    yesterday,
    diff,
    due_date: dueDate || date,
  });

  await TaskActivityLog.log({
    date,
    action_type: 'ADD',
    task_id: task.id,
    employee_to: employeeId || null,
    details_text: `أضاف مهمة "${title}"${productName ? ' — ' + productName : ''}`,
  });

  return task;
}

export async function updateTask(id, patch) {
  const before = await TaskRecords.get(id);
  const updated = await TaskRecords.update(id, patch);
  await TaskActivityLog.log({
    date: updated.date,
    action_type: 'EDIT',
    task_id: id,
    employee_to: updated.employee_id,
    details_text: `عدّل مهمة "${before?.title || updated.title}" (${Object.keys(patch).join('، ')})`,
  });
  return updated;
}

export async function moveTask(id, newEmployeeId) {
  const before = await TaskRecords.get(id);
  const updated = await TaskRecords.update(id, { employee_id: newEmployeeId, assignment_source: 'manager' });
  await TaskActivityLog.log({
    date: updated.date,
    action_type: 'MOVE',
    task_id: id,
    employee_from: before?.employee_id ?? null,
    employee_to: newEmployeeId,
    details_text: `نقل مهمة "${updated.title}"`,
  });
  return updated;
}

export async function cancelTask(id, reason) {
  const updated = await TaskRecords.update(id, {
    status: TASK_STATUS.CANCELLED,
    cancelled_at: new Date().toISOString(),
    cancelled_by: 'manager',
    cancel_reason: reason || null,
  });
  await TaskActivityLog.log({
    date: updated.date,
    action_type: 'CANCEL',
    task_id: id,
    employee_to: updated.employee_id,
    details_text: `ألغى مهمة "${updated.title}"${reason ? ' — ' + reason : ''}`,
  });
  return updated;
}

export async function changePriority(id, newPriority) {
  const before = await TaskRecords.get(id);
  const updated = await TaskRecords.update(id, { priority: newPriority });
  await TaskActivityLog.log({
    date: updated.date,
    action_type: 'PRIORITY_CHANGE',
    task_id: id,
    employee_to: updated.employee_id,
    details_text: `غيّر الأولوية: ${before?.priority || '—'} → ${newPriority}`,
  });
  return updated;
}

export async function addManagerNote(id, note) {
  const updated = await TaskRecords.update(id, { manager_note: note });
  await TaskActivityLog.log({
    date: updated.date,
    action_type: 'NOTE',
    task_id: id,
    employee_to: updated.employee_id,
    details_text: `أضاف ملاحظة: "${note}"`,
  });
  return updated;
}

/** Employee name for activity-log messages — a full-table scan is fine, the team is 5 rows. */
async function employeeName(employeeId) {
  if (!employeeId) return null;
  const employees = await TeamMembers.all();
  return employees.find((e) => e.id === employeeId)?.name ?? null;
}

/** Employee marks a task done — this must show up in the manager's activity log just like a manager action ("✅ Ahmed completed a task"). */
export async function completeTask(id) {
  const updated = await TaskRecords.update(id, { status: TASK_STATUS.COMPLETED, completed_at: new Date().toISOString() });
  const name = await employeeName(updated.employee_id);
  await TaskActivityLog.log({
    date: updated.date,
    action_type: 'EMPLOYEE_COMPLETE',
    task_id: id,
    employee_to: updated.employee_id,
    details_text: `${name ? name + ' ' : ''}أنهى مهمة "${updated.title}"${updated.product_name ? ' — ' + updated.product_name : ''}`,
  });
  return updated;
}

export async function failTask(id, reason, note) {
  const updated = await TaskRecords.update(id, { status: TASK_STATUS.NOT_COMPLETED, not_completed_reason: reason || null, not_completed_note: note || null });
  const name = await employeeName(updated.employee_id);
  await TaskActivityLog.log({
    date: updated.date,
    action_type: 'EMPLOYEE_NOT_COMPLETE',
    task_id: id,
    employee_to: updated.employee_id,
    details_text: `${name ? name + ' ' : ''}لم ينهِ مهمة "${updated.title}"${reason ? ' — ' + reason : ''}`,
  });
  return updated;
}

/**
 * Employee cancels their own task — distinct from the manager's cancelTask():
 * a reason is MANDATORY here (throws if missing/blank), matching the spec's
 * "require the employee to enter a mandatory cancellation reason." Still a
 * soft cancel (status only), never a physical delete, and still excluded
 * from carry-over exactly like a manager cancellation.
 */
export async function cancelTaskByEmployee(id, reason) {
  if (!reason || !reason.trim()) {
    throw new Error('Cancellation reason is required.');
  }
  const updated = await TaskRecords.update(id, {
    status: TASK_STATUS.CANCELLED,
    cancelled_at: new Date().toISOString(),
    cancelled_by: 'employee',
    cancel_reason: reason.trim(),
  });
  const name = await employeeName(updated.employee_id);
  await TaskActivityLog.log({
    date: updated.date,
    action_type: 'EMPLOYEE_CANCEL',
    task_id: id,
    employee_to: updated.employee_id,
    details_text: `${name ? name + ' ' : ''}ألغى مهمة "${updated.title}"${updated.product_name ? ' — ' + updated.product_name : ''} — السبب: ${reason.trim()}`,
  });
  return updated;
}

/** Manual status override (⏳ قيد التنفيذ / ✅ / ❌ / 🚨 متأخرة) from the row-level status selector — a manager can set any non-cancelled status directly, logged like every other manager action. Cancelling stays a separate flow (cancelTask) since it requires a reason and dedicated audit fields. */
export async function setStatus(id, newStatus) {
  const before = await TaskRecords.get(id);
  const updated = await TaskRecords.update(id, { status: newStatus });
  await TaskActivityLog.log({
    date: updated.date,
    action_type: 'STATUS_CHANGE',
    task_id: id,
    employee_to: updated.employee_id,
    details_text: `غيّر الحالة: ${before?.status || '—'} → ${newStatus}`,
  });
  return updated;
}

export async function bulkMove(ids, employeeId) {
  for (const id of ids) await moveTask(id, employeeId);
}
export async function bulkCancel(ids, reason) {
  for (const id of ids) await cancelTask(id, reason);
}
export async function bulkPriority(ids, priority) {
  for (const id of ids) await changePriority(id, priority);
}

/** Yesterday's (or any earlier date's) still-PENDING tasks — carried forward automatically (spec section 27). Cancelled tasks never qualify since only PENDING rows are returned. */
export async function carriedOverTasks(beforeDate) {
  return TaskRecords.pendingBefore(beforeDate);
}
