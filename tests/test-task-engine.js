// test-task-engine.js — Task Engine tests: action->task_type mapping,
// priority rules, top-5 selection.
import { test, assertEqual } from './test-runner.js';
import { deriveTaskType, taskPriority, buildTask, topTasks, TASK_TYPE, TASK_PRIORITY } from '../js/task-engine.js';

test('deriveTaskType: SCALE_UP with healthy stock -> SCALE', () => {
  assertEqual(deriveTaskType('SCALE_UP', 'OK').code, 'SCALE');
});

test('deriveTaskType: SCALE_UP with LOW/CRITICAL stock -> CHECK_STOCK, not SCALE (spec section 20)', () => {
  assertEqual(deriveTaskType('SCALE_UP', 'LOW').code, 'CHECK_STOCK');
  assertEqual(deriveTaskType('SCALE_UP', 'CRITICAL').code, 'CHECK_STOCK');
});

test('deriveTaskType: REDUCE -> REDUCE', () => {
  assertEqual(deriveTaskType('REDUCE', 'OK').code, 'REDUCE');
});

test('deriveTaskType: REVIEW_NOW -> REVIEW_PRODUCT (never guesses REVIEW_AD)', () => {
  assertEqual(deriveTaskType('REVIEW_NOW', 'OK').code, 'REVIEW_PRODUCT');
});

test('deriveTaskType: STOP_CANDIDATE -> PAUSE_REVIEW', () => {
  assertEqual(deriveTaskType('STOP_CANDIDATE', null).code, 'PAUSE_REVIEW');
});

test('deriveTaskType: INSUFFICIENT_DATA -> COLLECT_DATA', () => {
  assertEqual(deriveTaskType('INSUFFICIENT_DATA', null).code, 'COLLECT_DATA');
});

test('deriveTaskType: CONTINUE -> MONITOR', () => {
  assertEqual(deriveTaskType('CONTINUE', 'OK').code, 'MONITOR');
});

test('taskPriority: PAUSE_REVIEW/REVIEW_PRODUCT/CHECK_STOCK are URGENT', () => {
  assertEqual(taskPriority('PAUSE_REVIEW').code, 'URGENT');
  assertEqual(taskPriority('REVIEW_PRODUCT').code, 'URGENT');
  assertEqual(taskPriority('CHECK_STOCK').code, 'URGENT');
});

test('taskPriority: SCALE/REDUCE are IMPORTANT', () => {
  assertEqual(taskPriority('SCALE').code, 'IMPORTANT');
  assertEqual(taskPriority('REDUCE').code, 'IMPORTANT');
});

test('taskPriority: MONITOR/COLLECT_DATA are NORMAL', () => {
  assertEqual(taskPriority('MONITOR').code, 'NORMAL');
  assertEqual(taskPriority('COLLECT_DATA').code, 'NORMAL');
});

test('buildTask: assembles a flat task record from a product bundle', () => {
  const task = buildTask({
    product: { id: 1, product_name: 'جهاز إزالة شعر الوجه' },
    a: { today: 10, yesterday: 5, change: { abs: 5 } },
    decision: { action: { code: 'SCALE_UP' }, note: 'تحسن', confidence: 'عالية' },
    inventory: { status: 'OK' },
  });
  assertEqual(task.productName, 'جهاز إزالة شعر الوجه');
  assertEqual(task.today, 10);
  assertEqual(task.diff, 5);
  assertEqual(task.taskType.code, 'SCALE');
  assertEqual(task.priority.code, 'IMPORTANT');
});

test('buildTask: a VOLATILE product classified as MONITOR gets the specific "don\'t react to one day" instruction', () => {
  const task = buildTask({
    product: { id: 2, product_name: 'كاميرا أكشن' },
    a: { today: 5, yesterday: 6, change: { abs: -1 } },
    decision: { action: { code: 'CONTINUE' }, note: 'ثابت', confidence: 'متوسطة', status: { code: 'VOLATILE' } },
    inventory: null,
  });
  assertEqual(task.taskType.code, 'MONITOR');
  assertEqual(task.requiredAction, 'لا تزود الميزانية الآن — راقب الأداء وراجع الإعلانات');
});

test('topTasks: URGENT tasks always outrank IMPORTANT/NORMAL regardless of movement size', () => {
  const tasks = [
    { priority: TASK_PRIORITY.NORMAL, diff: 100, productName: 'A' },
    { priority: TASK_PRIORITY.URGENT, diff: 1, productName: 'B' },
  ];
  const top = topTasks(tasks, 5);
  assertEqual(top[0].productName, 'B');
});

test('topTasks: within the same priority, bigger absolute movement wins', () => {
  const tasks = [
    { priority: TASK_PRIORITY.IMPORTANT, diff: 2, productName: 'A' },
    { priority: TASK_PRIORITY.IMPORTANT, diff: -8, productName: 'B' },
  ];
  const top = topTasks(tasks, 5);
  assertEqual(top[0].productName, 'B');
});

test('topTasks: respects the max cap', () => {
  const tasks = Array.from({ length: 10 }, (_, i) => ({ priority: TASK_PRIORITY.NORMAL, diff: i, productName: `P${i}` }));
  assertEqual(topTasks(tasks, 5).length, 5);
});
