// test-decision-engine.js — Smart Decision Engine tests. Verifies the 5
// action buckets, confidence levels, the percentage-free output guarantee,
// the "improved vs yesterday but still below baseline" nuance, and the
// non-causal next-day follow-up wording.
import { test, assertEqual, assertTrue } from './test-runner.js';
import { analyzeProductDecision, buildFollowUp, ACTION, CONFIDENCE } from '../js/decision-engine.js';
import { DAILY_STATUS } from '../js/daily-monitor.js';

function fakeA(overrides) {
  return {
    isNew: false,
    today: 5,
    yesterday: 5,
    avg7: 5,
    baseline: { pct: 0 },
    declineStreak: 0,
    change: { abs: 0 },
    trend: { code: 'STABLE' },
    totalDataPoints: 20,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Action derivation — one scenario per bucket
// ---------------------------------------------------------------------------

test('decision: new product -> INSUFFICIENT_DATA action, LOW confidence', () => {
  const a = fakeA({ isNew: true, totalDataPoints: 3 });
  const d = analyzeProductDecision(a, DAILY_STATUS.NEW, 'NEW');
  assertEqual(d.action.code, 'INSUFFICIENT_DATA');
  assertEqual(d.confidence, CONFIDENCE.LOW);
});

test('decision: explicit zero after real baseline -> STOP_CANDIDATE', () => {
  const a = fakeA({ today: 0, yesterday: 5, avg7: 5.5, change: { abs: -5 } });
  const d = analyzeProductDecision(a, DAILY_STATUS.STOPPED, 'WATCH');
  assertEqual(d.action.code, 'STOP_CANDIDATE');
  assertTrue(d.note.includes('لم يحقق أي أوردر'));
});

test('decision: v2 EXIT type also forces STOP_CANDIDATE even if dailyStatus is milder', () => {
  const a = fakeA({ today: 2, yesterday: 3, change: { abs: -1 } });
  const d = analyzeProductDecision(a, DAILY_STATUS.DECLINING, 'EXIT');
  assertEqual(d.action.code, 'STOP_CANDIDATE');
});

test('decision: sharp decline -> REVIEW_NOW', () => {
  const a = fakeA({ today: 4, yesterday: 7, declineStreak: 5, change: { abs: -3 } });
  const d = analyzeProductDecision(a, DAILY_STATUS.SHARP_DECLINE, 'FIX');
  assertEqual(d.action.code, 'REVIEW_NOW');
});

test('decision: profit layer FIX alone (even with a milder dailyStatus) -> REVIEW_NOW', () => {
  const a = fakeA({ today: 6, yesterday: 6, change: { abs: 0 } });
  const d = analyzeProductDecision(a, DAILY_STATUS.STABLE, 'FIX');
  assertEqual(d.action.code, 'REVIEW_NOW');
});

test('decision: early decline -> REDUCE', () => {
  const a = fakeA({ today: 6, yesterday: 8, declineStreak: 2, change: { abs: -2 } });
  const d = analyzeProductDecision(a, DAILY_STATUS.EARLY_DECLINE, 'WATCH');
  assertEqual(d.action.code, 'REDUCE');
});

test('decision: confirmed strong growth with today up vs yesterday -> SCALE_UP', () => {
  const a = fakeA({ today: 12, yesterday: 9, avg7: 6.5, baseline: { pct: 84.6 }, change: { abs: 3 }, trend: { code: 'STRONG_UP' } });
  const d = analyzeProductDecision(a, DAILY_STATUS.STRONG_GROWTH, 'SCALE');
  assertEqual(d.action.code, 'SCALE_UP');
});

test('decision: flat/stable day -> CONTINUE', () => {
  const a = fakeA({ today: 10, yesterday: 10, avg7: 10, change: { abs: 0 } });
  const d = analyzeProductDecision(a, DAILY_STATUS.STABLE, 'NORMAL');
  assertEqual(d.action.code, 'CONTINUE');
});

// ---------------------------------------------------------------------------
// The critical nuance: today > yesterday but still well below baseline must
// NOT read as an immediate "زوّد الميزانية" (spec worked example).
// ---------------------------------------------------------------------------

test('decision: improved vs yesterday but still below baseline -> NOT SCALE_UP, cautious note', () => {
  // values [10,9,11,10,8,2,5]: yesterday=2, today=5 (up), but baseline avg
  // is well above 5 -> classifyDailyStatus would call this WATCH/EARLY_DECLINE,
  // not STRONG_GROWTH/IMPROVING, so the action must stay REDUCE/CONTINUE.
  const a = fakeA({ today: 5, yesterday: 2, avg7: 9, baseline: { pct: -35 }, change: { abs: 3 }, trend: { code: 'VOLATILE' } });
  const d = analyzeProductDecision(a, DAILY_STATUS.WATCH, 'WATCH');
  assertEqual(d.action.code, 'REDUCE');
  assertTrue(d.note.includes('لكن'));
  assertTrue(d.note.includes('أقل من مستواه الطبيعي'));
});

// ---------------------------------------------------------------------------
// Inventory-aware caution (spec section 17: strong performance + low stock)
// ---------------------------------------------------------------------------

test('decision: SCALE_UP with LOW/CRITICAL stock adds a stock caution to the note', () => {
  const a = fakeA({ today: 15, yesterday: 10, avg7: 8, change: { abs: 5 } });
  const d = analyzeProductDecision(a, DAILY_STATUS.STRONG_GROWTH, 'SCALE', { status: 'CRITICAL' });
  assertEqual(d.action.code, 'SCALE_UP');
  assertTrue(d.note.includes('المخزون منخفض'));
});

test('decision: SCALE_UP with OK stock has no stock caution', () => {
  const a = fakeA({ today: 15, yesterday: 10, avg7: 8, change: { abs: 5 } });
  const d = analyzeProductDecision(a, DAILY_STATUS.STRONG_GROWTH, 'SCALE', { status: 'OK' });
  assertTrue(!d.note.includes('المخزون منخفض'));
});

test('decision: non-SCALE_UP actions never mention the stock caution even with CRITICAL stock', () => {
  const a = fakeA({ today: 6, yesterday: 8, declineStreak: 2, change: { abs: -2 } });
  const d = analyzeProductDecision(a, DAILY_STATUS.EARLY_DECLINE, 'WATCH', { status: 'CRITICAL' });
  assertTrue(!d.note.includes('المخزون منخفض'));
});

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

test('decision: volatile trend with plenty of data still caps confidence at MEDIUM', () => {
  const a = fakeA({ trend: { code: 'VOLATILE' }, totalDataPoints: 40 });
  const d = analyzeProductDecision(a, DAILY_STATUS.STABLE, 'NORMAL');
  assertEqual(d.confidence, CONFIDENCE.MEDIUM);
});

test('decision: short history (< 14 points), stable trend -> MEDIUM confidence', () => {
  const a = fakeA({ totalDataPoints: 10 });
  const d = analyzeProductDecision(a, DAILY_STATUS.STABLE, 'NORMAL');
  assertEqual(d.confidence, CONFIDENCE.MEDIUM);
});

test('decision: long, stable history -> HIGH confidence', () => {
  const a = fakeA({ totalDataPoints: 30 });
  const d = analyzeProductDecision(a, DAILY_STATUS.STABLE, 'NORMAL');
  assertEqual(d.confidence, CONFIDENCE.HIGH);
});

// ---------------------------------------------------------------------------
// No percentages anywhere in the output (the whole point of this request)
// ---------------------------------------------------------------------------

test('decision: note/reason text never contains a percentage sign', () => {
  const scenarios = [
    [fakeA({ today: 5, yesterday: 2, avg7: 9, baseline: { pct: -35 }, change: { abs: 3 } }), DAILY_STATUS.WATCH, 'WATCH'],
    [fakeA({ today: 0, yesterday: 5, avg7: 5.5, change: { abs: -5 } }), DAILY_STATUS.STOPPED, 'WATCH'],
    [fakeA({ today: 12, yesterday: 9, avg7: 6.5, baseline: { pct: 84.6 }, change: { abs: 3 } }), DAILY_STATUS.STRONG_GROWTH, 'SCALE'],
  ];
  for (const [a, status, v2] of scenarios) {
    const d = analyzeProductDecision(a, status, v2);
    assertTrue(!d.note.includes('%'), `note leaked a percentage: ${d.note}`);
    assertTrue(!d.reason.includes('%'), `reason leaked a percentage: ${d.reason}`);
  }
});

// ---------------------------------------------------------------------------
// Non-causal next-day follow-up
// ---------------------------------------------------------------------------

test('followUp: SCALE_UP yesterday + improved today -> positive, non-causal language', () => {
  const yesterdayDecision = { action: ACTION.SCALE_UP };
  const msg = buildFollowUp(yesterdayDecision, fakeA({ change: { abs: 2 } }));
  assertTrue(msg.startsWith('✅'));
});

test('followUp: SCALE_UP yesterday + declined today -> "تزامن" wording, never "caused by"', () => {
  const yesterdayDecision = { action: ACTION.SCALE_UP };
  const msg = buildFollowUp(yesterdayDecision, fakeA({ change: { abs: -3 } }));
  assertTrue(msg.includes('تزامن'));
  assertTrue(!msg.includes('بسبب'));
});

test('followUp: STOP_CANDIDATE yesterday + still zero today -> decision still stands', () => {
  const yesterdayDecision = { action: ACTION.STOP_CANDIDATE };
  const msg = buildFollowUp(yesterdayDecision, fakeA({ today: 0, change: { abs: 0 } }));
  assertTrue(msg.includes('ما زال'));
});

test('followUp: STOP_CANDIDATE yesterday but product recovered today -> cautious re-check message', () => {
  const yesterdayDecision = { action: ACTION.STOP_CANDIDATE };
  const msg = buildFollowUp(yesterdayDecision, fakeA({ today: 4, change: { abs: 4 } }));
  assertTrue(msg.includes('رجع يسجل'));
});

test('followUp: CONTINUE action has no meaningful follow-up -> null', () => {
  const yesterdayDecision = { action: ACTION.CONTINUE };
  const msg = buildFollowUp(yesterdayDecision, fakeA({ change: { abs: 0 } }));
  assertEqual(msg, null);
});

test('followUp: missing yesterday decision or missing change data -> null, never throws', () => {
  assertEqual(buildFollowUp(null, fakeA({})), null);
  assertEqual(buildFollowUp({ action: ACTION.REDUCE }, fakeA({ change: { abs: null } })), null);
});
