// test-team-engine.js — balanced assignment tests.
import { test, assertEqual, assertTrue } from './test-runner.js';
import { assignTasksRoundRobin, workloadByEmployee } from '../js/team-engine.js';

const EMPLOYEES = [
  { id: 1, name: 'محمود', active: true },
  { id: 2, name: 'احمد', active: true },
  { id: 3, name: 'سامي', active: true },
  { id: 4, name: 'عصام', active: true },
  { id: 5, name: 'حسن', active: true },
];

function tasks(n, priority = 'IMPORTANT') {
  return Array.from({ length: n }, (_, i) => ({ productId: i + 1, priority: { code: priority } }));
}

test('assignTasksRoundRobin: every task gets assigned to exactly one employee', () => {
  const result = assignTasksRoundRobin(tasks(23), EMPLOYEES);
  assertEqual(result.size, 23);
  for (const empId of result.values()) assertTrue(EMPLOYEES.some((e) => e.id === empId));
});

test('assignTasksRoundRobin: balances load within 1 task of each other across 5 employees', () => {
  const result = assignTasksRoundRobin(tasks(50), EMPLOYEES);
  const counts = EMPLOYEES.map((e) => [...result.values()].filter((v) => v === e.id).length);
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  assertTrue(max - min <= 1, `load spread too uneven: ${counts.join(',')}`);
});

test('assignTasksRoundRobin: never reassigns an already-assigned task on rerun', () => {
  const first = assignTasksRoundRobin(tasks(10), EMPLOYEES);
  const originalOwnerOfTask1 = first.get(1);
  const second = assignTasksRoundRobin(tasks(15), EMPLOYEES, first); // same 10 + 5 new
  assertEqual(second.get(1), originalOwnerOfTask1);
  assertEqual(second.size, 15);
});

test('assignTasksRoundRobin: inactive employees never receive tasks', () => {
  const employees = [...EMPLOYEES.slice(0, 4), { id: 5, name: 'حسن', active: false }];
  const result = assignTasksRoundRobin(tasks(20), employees);
  assertTrue(![...result.values()].includes(5));
});

test('assignTasksRoundRobin: no active employees -> empty assignment, never throws', () => {
  const employees = EMPLOYEES.map((e) => ({ ...e, active: false }));
  const result = assignTasksRoundRobin(tasks(5), employees);
  assertEqual(result.size, 0);
});

test('assignTasksRoundRobin: urgent tasks spread across the team rather than piling on one person', () => {
  const urgent = tasks(15, 'URGENT');
  const result = assignTasksRoundRobin(urgent, EMPLOYEES);
  const counts = EMPLOYEES.map((e) => [...result.values()].filter((v) => v === e.id).length);
  assertTrue(counts.every((c) => c === 3), `expected an even 3-each split, got ${counts.join(',')}`);
});

test('workloadByEmployee: computes total/completed/notCompleted/remaining per person', () => {
  const assignments = new Map([[1, 1], [2, 1], [3, 2]]);
  const statusByProductId = new Map([[1, 'COMPLETED'], [2, 'NOT_COMPLETED']]);
  const workload = workloadByEmployee(EMPLOYEES, assignments, statusByProductId);
  const mahmoud = workload.find((w) => w.employee.name === 'محمود');
  assertEqual(mahmoud.total, 2);
  assertEqual(mahmoud.completed, 1);
  assertEqual(mahmoud.notCompleted, 1);
  assertEqual(mahmoud.remaining, 0);
  const ahmed = workload.find((w) => w.employee.name === 'احمد');
  assertEqual(ahmed.total, 1);
  assertEqual(ahmed.remaining, 1);
});
