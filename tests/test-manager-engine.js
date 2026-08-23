// test-manager-engine.js
import { test, assertEqual, assertTrue } from './test-runner.js';
import { workloadLevel, sortTasks, canAutoAssign, WORKLOAD_LEVEL } from '../js/manager-engine.js';

test('workloadLevel: at or one above target -> NORMAL (matches spec: 10/10 and 11/10 both fine)', () => {
  assertEqual(workloadLevel(10).code, 'NORMAL');
  assertEqual(workloadLevel(11).code, 'NORMAL');
});

test('workloadLevel: target+2 -> HIGH (spec: 12 -> ⚠️ ضغط عمل مرتفع)', () => {
  assertEqual(workloadLevel(12).code, 'HIGH');
  assertEqual(workloadLevel(13).code, 'HIGH');
});

test('workloadLevel: target+5 or more -> VERY_HIGH (spec: 15+ -> 🚨 ضغط عمل مرتفع جدًا)', () => {
  assertEqual(workloadLevel(15).code, 'VERY_HIGH');
  assertEqual(workloadLevel(16).code, 'VERY_HIGH');
});

test('workloadLevel: respects a custom target', () => {
  assertEqual(workloadLevel(5, 5).code, 'NORMAL');
  assertEqual(workloadLevel(7, 5).code, 'HIGH');
});

test('sortTasks: URGENT always before IMPORTANT/NORMAL regardless of dates', () => {
  const tasks = [
    { priority: 'NORMAL', due_date: '2026-08-01', created_at: '2026-08-01' },
    { priority: 'URGENT', due_date: '2026-08-31', created_at: '2026-08-31' },
  ];
  const sorted = sortTasks(tasks);
  assertEqual(sorted[0].priority, 'URGENT');
});

test('sortTasks: within the same priority, earlier due date wins', () => {
  const tasks = [
    { priority: 'IMPORTANT', due_date: '2026-08-20', created_at: '2026-08-01' },
    { priority: 'IMPORTANT', due_date: '2026-08-18', created_at: '2026-08-01' },
  ];
  const sorted = sortTasks(tasks);
  assertEqual(sorted[0].due_date, '2026-08-18');
});

test('canAutoAssign: true when no existing task (fresh assignment allowed)', () => {
  assertTrue(canAutoAssign(null));
  assertTrue(canAutoAssign(undefined));
});

test('canAutoAssign: true when the existing assignment was automatic', () => {
  assertTrue(canAutoAssign({ assignment_source: 'automatic' }));
});

test('canAutoAssign: false once a manager has moved/set the assignment — the core override-protection rule', () => {
  assertTrue(!canAutoAssign({ assignment_source: 'manager' }));
});
