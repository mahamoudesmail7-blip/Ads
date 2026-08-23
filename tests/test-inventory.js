// test-inventory.js — Inventory Layer tests (spec sections 7-9), using the
// spec's own worked examples.
import { test, assertEqual, assertClose, assertTrue } from './test-runner.js';
import { dailyAverageSales, daysOfStockRemaining, stockStatus, restockPriorityScore } from '../js/inventory.js';

const SETTINGS = { lowStockDays: 7, criticalStockDays: 3 };

test('dailyAverageSales: prefers 7D average when available', () => {
  const analysis = { avg7: 6, avg14: 5, avg30: 4, avgAllTime: 3 };
  assertEqual(dailyAverageSales(analysis), 6);
});

test('dailyAverageSales: falls back to longer windows only when shorter ones have no data', () => {
  const analysis = { avg7: null, avg14: null, avg30: 4, avgAllTime: 3 };
  assertEqual(dailyAverageSales(analysis), 4);
});

test('dailyAverageSales: no data anywhere -> null, never assumes 0 sales', () => {
  assertEqual(dailyAverageSales({ avg7: null, avg14: null, avg30: null, avgAllTime: null }), null);
});

test('daysOfStockRemaining: matches spec worked example (stock 100, avg 10/day -> 10 days)', () => {
  assertEqual(daysOfStockRemaining(100, 10), 10);
});

test('daysOfStockRemaining: matches spec worked example (stock 28, avg 10/day -> 2.8 days)', () => {
  assertClose(daysOfStockRemaining(28, 10), 2.8, 0.001);
});

test('daysOfStockRemaining: no stock value tracked -> null, not "0 days"', () => {
  assertEqual(daysOfStockRemaining(null, 10), null);
});

test('stockStatus: 2.8 days with default thresholds -> CRITICAL (matches spec RESTOCK NOW example)', () => {
  assertEqual(stockStatus(2.8, SETTINGS), 'CRITICAL');
});

test('stockStatus: <=7 days but >3 -> LOW', () => {
  assertEqual(stockStatus(5, SETTINGS), 'LOW');
  assertEqual(stockStatus(7, SETTINGS), 'LOW');
});

test('stockStatus: >7 days -> OK', () => {
  assertEqual(stockStatus(10, SETTINGS), 'OK');
});

test('stockStatus: no days-remaining figure -> NO_DATA, never coerced into OK or CRITICAL', () => {
  assertEqual(stockStatus(null, SETTINGS), 'NO_DATA');
});

test('restockPriorityScore: only computed for LOW/CRITICAL products', () => {
  assertEqual(restockPriorityScore({ status: 'OK', profitRecent: 1000, trendCode: 'STRONG_UP', healthScore: 90 }), null);
  assertEqual(restockPriorityScore({ status: 'NO_DATA', profitRecent: null, trendCode: 'STABLE', healthScore: 50 }), null);
});

test('restockPriorityScore: CRITICAL + profitable + strong uptrend scores higher than LOW + no profit data', () => {
  const highPriority = restockPriorityScore({ status: 'CRITICAL', profitRecent: 12000, trendCode: 'STRONG_UP', healthScore: 90 });
  const lowerPriority = restockPriorityScore({ status: 'LOW', profitRecent: null, trendCode: 'STABLE', healthScore: 40 });
  assertTrue(highPriority > lowerPriority, `expected ${highPriority} > ${lowerPriority}`);
});
