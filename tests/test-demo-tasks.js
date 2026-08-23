// test-demo-tasks.js — pure-logic tests for the demo scenario distribution.
// Full generation (generateDemoTasks/resetDemoTasks) needs IndexedDB and is
// verified live in the browser instead (see final report), matching this
// app's convention for DB-dependent code.
import { test, assertEqual, assertTrue } from './test-runner.js';
import { scaleCounts } from '../js/demo-tasks.js';

test('scaleCounts: at exactly 127 products, reproduces the spec\'s exact 15/20/20/15/10/20/12/15 split', () => {
  assertEqual(scaleCounts(127), [15, 20, 20, 15, 10, 20, 12, 15]);
});

test('scaleCounts: always sums to the requested total, even when it does not divide evenly', () => {
  for (const total of [1, 5, 10, 50, 127, 200, 301]) {
    const counts = scaleCounts(total);
    assertEqual(counts.reduce((a, b) => a + b, 0), total);
  }
});

test('scaleCounts: never returns a negative count', () => {
  const counts = scaleCounts(3);
  assertTrue(counts.every((c) => c >= 0));
});

test('scaleCounts: zero products -> all-zero split, not an error', () => {
  assertEqual(scaleCounts(0), [0, 0, 0, 0, 0, 0, 0, 0]);
});
