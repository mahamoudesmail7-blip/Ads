// test-recommendation-engine.js — V2 Recommendation Engine tests
// (spec sections 19-20): SCALE/WATCH/FIX/EXIT/RESTOCK/NORMAL must combine
// multiple metrics, never a single one, and must always explain itself.
import { test, assertEqual, assertTrue } from './test-runner.js';
import { buildRecommendationV2, productScore } from '../js/recommendation-engine.js';

function fakeAnalysis({ type, healthScore = 70, trendCode = 'STABLE' }) {
  return {
    recommendation: { type, reasons: [`core:${type}`] },
    health: { score: healthScore, label: 'Good' },
    trend: { code: trendCode },
  };
}

// ---------------------------------------------------------------------------
// buildRecommendationV2
// ---------------------------------------------------------------------------

test('buildRecommendationV2: NEW passes through untouched regardless of profit/inventory', () => {
  const r = buildRecommendationV2({
    analysis: fakeAnalysis({ type: 'NEW' }),
    profit: { profitPerOrder: -500 },
    inventory: { status: 'CRITICAL', daysRemaining: 1 },
  });
  assertEqual(r.type, 'NEW');
});

test('buildRecommendationV2: SCALE downgraded to FIX when losing money per order — orders alone never justify SCALE', () => {
  const r = buildRecommendationV2({
    analysis: fakeAnalysis({ type: 'SCALE' }),
    profit: { profitPerOrder: -20 },
    inventory: null,
  });
  assertEqual(r.type, 'FIX');
  assertTrue(r.reasons.some((x) => x.toLowerCase().includes('losing')), 'reasons should explain the profit loss');
});

test('buildRecommendationV2: SCALE stays SCALE when profitable', () => {
  const r = buildRecommendationV2({
    analysis: fakeAnalysis({ type: 'SCALE' }),
    profit: { profitPerOrder: 150 },
    inventory: null,
  });
  assertEqual(r.type, 'SCALE');
});

test('buildRecommendationV2: WATCH becomes FIX when the product is actively losing money', () => {
  const r = buildRecommendationV2({
    analysis: fakeAnalysis({ type: 'WATCH' }),
    profit: { profitPerOrder: -30 },
    inventory: null,
  });
  assertEqual(r.type, 'FIX');
});

test('buildRecommendationV2: KEEP maps to NORMAL when nothing else overrides it', () => {
  const r = buildRecommendationV2({
    analysis: fakeAnalysis({ type: 'KEEP' }),
    profit: { profitPerOrder: 40 },
    inventory: { status: 'OK' },
  });
  assertEqual(r.type, 'NORMAL');
});

test('buildRecommendationV2: EXIT downgraded to FIX when still clearly profitable and not critically unhealthy', () => {
  const r = buildRecommendationV2({
    analysis: fakeAnalysis({ type: 'EXIT', healthScore: 45 }),
    profit: { profitPerOrder: 60 },
    inventory: null,
  });
  assertEqual(r.type, 'FIX');
});

test('buildRecommendationV2: EXIT stays EXIT when also unprofitable (multiple metrics agree)', () => {
  const r = buildRecommendationV2({
    analysis: fakeAnalysis({ type: 'EXIT', healthScore: 20 }),
    profit: { profitPerOrder: -40 },
    inventory: null,
  });
  assertEqual(r.type, 'EXIT');
});

test('buildRecommendationV2: EXIT stays EXIT even with no profit data at all (core signal alone is sufficient when nothing contradicts it)', () => {
  const r = buildRecommendationV2({
    analysis: fakeAnalysis({ type: 'EXIT', healthScore: 15 }),
    profit: null,
    inventory: null,
  });
  assertEqual(r.type, 'EXIT');
});

test('buildRecommendationV2: NORMAL becomes RESTOCK when stock is CRITICAL', () => {
  const r = buildRecommendationV2({
    analysis: fakeAnalysis({ type: 'KEEP' }),
    profit: { profitPerOrder: 30 },
    inventory: { status: 'CRITICAL', daysRemaining: 1.5 },
  });
  assertEqual(r.type, 'RESTOCK');
  assertTrue(r.reasons.some((x) => x.includes('days of stock')), 'reasons should mention stock days remaining');
});

test('buildRecommendationV2: EXIT keeps priority over a CRITICAL stock signal (no point restocking a product being exited)', () => {
  const r = buildRecommendationV2({
    analysis: fakeAnalysis({ type: 'EXIT', healthScore: 15 }),
    profit: { profitPerOrder: -50 },
    inventory: { status: 'CRITICAL', daysRemaining: 1 },
  });
  assertEqual(r.type, 'EXIT');
});

test('buildRecommendationV2: reasons is never empty', () => {
  const r = buildRecommendationV2({ analysis: fakeAnalysis({ type: 'WATCH' }), profit: null, inventory: null });
  assertTrue(r.reasons.length > 0, 'expected at least one explaining reason');
});

// ---------------------------------------------------------------------------
// productScore
// ---------------------------------------------------------------------------

test('productScore: strong health + strong profit margin + low returns scores Excellent', () => {
  const s = productScore({ healthScore: 90, profitPerOrder: 300, breakEvenCPA: 400, returnRatePct: 2 });
  assertTrue(s.score >= 80, `expected >=80, got ${s.score}`);
  assertEqual(s.label, '🔥 Excellent');
});

test('productScore: weak health + losing money + high returns scores low', () => {
  const s = productScore({ healthScore: 15, profitPerOrder: -100, breakEvenCPA: 400, returnRatePct: 30 });
  assertTrue(s.score < 30, `expected <30, got ${s.score}`);
});

test('productScore: missing profit/return data renormalizes to health-only, not penalized for absent data', () => {
  const s = productScore({ healthScore: 80, profitPerOrder: null, breakEvenCPA: null, returnRatePct: null });
  assertEqual(s.score, 80);
  assertEqual(s.componentsUsed, 1);
});

test('productScore: absolutely no data anywhere returns null, not a fabricated 0/50/100', () => {
  const s = productScore({ healthScore: null, profitPerOrder: null, breakEvenCPA: null, returnRatePct: null });
  assertEqual(s, null);
});
