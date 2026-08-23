// team-engine.js — Balanced task-assignment logic for 🛠️ الشغل اللي هيتعمل.
// Pure functions, no DOM/IndexedDB. Splits today's actionable tasks across
// the active team members so no one person is stuck with everything hard
// while someone else is idle (spec section 11: "لا تجعل محمود يحصل دائمًا
// على أصعب المهام").
//
// Algorithm: greedy load-balancing, not blind round-robin. Tasks are
// processed most-urgent-first; each task goes to whichever active employee
// currently has the FEWEST tasks (ties broken by team order). Processing
// urgent tasks first, while every employee's load is still near-equal,
// means urgent work naturally spreads across the whole team instead of
// piling onto whoever happens to be first in rotation. Already-assigned
// tasks (from `existingAssignments`) are never reassigned — re-running
// this on a page reload only fills in what's still unassigned, so an
// assignment made this morning doesn't silently change under someone by
// the afternoon.

const PRIORITY_ORDER = { URGENT: 0, IMPORTANT: 1, NORMAL: 2 };

/**
 * @param {{productId:number, priority:{code:string}}[]} tasks
 * @param {{id:number, name:string, active?:boolean}[]} employees
 * @param {Map<number,number>} [existingAssignments] productId -> employeeId, kept stable
 * @returns {Map<number,number>} productId -> employeeId for EVERY task (existing + newly assigned)
 */
export function assignTasksRoundRobin(tasks, employees, existingAssignments = new Map()) {
  const active = employees.filter((e) => e.active !== false);
  const result = new Map(existingAssignments);
  if (active.length === 0) return result;

  const load = new Map(active.map((e) => [e.id, 0]));
  for (const empId of result.values()) {
    if (load.has(empId)) load.set(empId, load.get(empId) + 1);
  }

  const sorted = [...tasks].sort((a, b) => (PRIORITY_ORDER[a.priority.code] ?? 9) - (PRIORITY_ORDER[b.priority.code] ?? 9));

  for (const task of sorted) {
    if (result.has(task.productId)) continue;
    let best = active[0];
    for (const e of active) {
      if (load.get(e.id) < load.get(best.id)) best = e;
    }
    result.set(task.productId, best.id);
    load.set(best.id, load.get(best.id) + 1);
  }

  return result;
}

/** Per-employee counts for the workload table (spec section 4). */
export function workloadByEmployee(employees, assignments, statusByProductId) {
  const active = employees.filter((e) => e.active !== false);
  return active.map((e) => {
    const productIds = [...assignments.entries()].filter(([, empId]) => empId === e.id).map(([pid]) => pid);
    const total = productIds.length;
    const completed = productIds.filter((pid) => statusByProductId.get(pid) === 'COMPLETED').length;
    const notCompleted = productIds.filter((pid) => statusByProductId.get(pid) === 'NOT_COMPLETED').length;
    const remaining = total - completed - notCompleted;
    return { employee: e, total, completed, notCompleted, remaining };
  });
}
