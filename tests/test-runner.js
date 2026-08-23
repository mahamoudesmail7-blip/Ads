// test-runner.js — Minimal in-browser test framework. No dependencies,
// no Node required: open tests/../test.html in any browser and the results
// render on the page. Intentionally tiny — this project has one job
// (verify analytics.js), not a general test framework.

export const results = [];

export function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
  }
}

export function assertEqual(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertClose(actual, expected, tolerance = 0.01, msg) {
  if (actual === null || expected === null) {
    if (actual !== expected) throw new Error(`${msg ? msg + ': ' : ''}expected ${expected}, got ${actual}`);
    return;
  }
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ~${expected}, got ${actual}`);
  }
}

export function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg || 'expected condition to be true');
}
