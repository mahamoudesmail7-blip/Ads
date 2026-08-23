// manager-engine.js — pure logic for 👑 تحكم المدير. No DOM/IndexedDB.

export const WORKLOAD_LEVEL = {
  NORMAL: { code: 'NORMAL', icon: '🟢', label: 'طبيعي' },
  HIGH: { code: 'HIGH', icon: '🟡', label: 'مرتفع' },
  VERY_HIGH: { code: 'VERY_HIGH', icon: '🔴', label: 'مرتفع جدًا' },
};

/**
 * The daily target (spec: 10) is a TARGET, not a hard limit — the manager
 * can always add more. Thresholds match the spec's own worked examples
 * exactly: target+1 is still silently fine, target+2 is a warning,
 * target+5 or more is critical.
 */
export function workloadLevel(count, target = 10) {
  if (count >= target + 5) return WORKLOAD_LEVEL.VERY_HIGH;
  if (count >= target + 2) return WORKLOAD_LEVEL.HIGH;
  return WORKLOAD_LEVEL.NORMAL;
}

const PRIORITY_ORDER = { URGENT: 0, IMPORTANT: 1, NORMAL: 2 };

/** Priority first, then due date, then created-at (spec section 13). */
export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const p = (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
    if (p !== 0) return p;
    const dueA = a.due_date || '';
    const dueB = b.due_date || '';
    if (dueA !== dueB) return dueA < dueB ? -1 : 1;
    return (a.created_at || '') < (b.created_at || '') ? -1 : 1;
  });
}

/**
 * Whether an automatic (re)assignment pass is allowed to set/change this
 * task's employee. Once a manager has moved a task, auto-assignment must
 * never silently move it back (spec section 10) — this is the single rule
 * that protects that guarantee, kept here so it's independently testable.
 */
export function canAutoAssign(task) {
  return !task || task.assignment_source !== 'manager';
}
