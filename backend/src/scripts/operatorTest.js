// 🤖 AI Operator regression (2026-10-03). Part A = pure (rules, validation, conflicts, Arabic parsing, guard chain, economics).
// Part B = DB-backed on DISPOSABLE rows ("__optest_" prefix, cleaned up) with an INJECTED executor — no Meta call, no real campaign touched.
// Part C = one read-only pass of the real engine over the real synced world (persist=false): must write nothing and never produce an executable decision in SHADOW.
//   node src/scripts/operatorTest.js [--skip-world]
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); } };

process.env.OPERATOR_ALLOW_META_WRITES = 'true'; // these suites use an INJECTED executor; the deployment lock itself is asserted explicitly (and re-locked) in the lock tests
const __testStart = new Date(); // every service-level call below writes actor-less audit/event rows: removed again in the cleanup
const { prisma } = await imp('../prisma.js');
// the shared DB can drop for seconds (Neon): restoring the global Operator config in the cleanup must survive that, or a test would leave the production mode altered
const retryDb = async (fn) => { for (let i = 0; i < 10; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 4000)); } } return fn(); };
const R = await imp('../services/amb/operatorRules.js');
const G = await imp('../services/amb/operatorGuards.js');
const S = await imp('../services/amb/operatorStore.js');
const E = await imp('../services/amb/operatorEngine.js');
const REP = await imp('../services/amb/operatorReports.js');
const CMD = await imp('../services/amb/operatorCommand.js');
const { AMB_DEFAULT_SETTINGS } = await imp('../services/amb/settings.js');

const NOW = new Date('2026-10-03T12:00:00Z');
const H = 3_600_000;

// =====================================================================================================================
console.log('\nA1. rules: validation');
const goodPause = { name: 'pause no orders', action: 'PAUSE', window: 'today', mode: 'SHADOW', conditions: { all: [{ field: 'spend', op: '>=', value: 180 }, { field: 'purchases', op: '=', value: 0 }] } };
ok('valid pause rule passes', R.validateRule(goodPause).ok, JSON.stringify(R.validateRule(goodPause).errors));
ok('pause without spend gate rejected', R.validateRule({ ...goodPause, conditions: { all: [{ field: 'purchases', op: '=', value: 0 }] } }).errors.some((e) => e.code === 'PAUSE_NEEDS_SPEND_GATE'));
ok('unknown action rejected', R.validateRule({ ...goodPause, action: 'DELETE_ALL' }).errors.some((e) => e.code === 'ACTION_UNKNOWN'));
ok('unknown window rejected', R.validateRule({ ...goodPause, window: 'last999' }).errors.some((e) => e.code === 'WINDOW_UNKNOWN'));
ok('empty conditions rejected', R.validateRule({ ...goodPause, conditions: { all: [] } }).errors.some((e) => e.code === 'CONDITIONS_REQUIRED'));
ok('contradictory conditions rejected', R.validateRule({ ...goodPause, conditions: { all: [{ field: 'spend', op: '>=', value: 200 }, { field: 'spend', op: '<', value: 100 }] } }).errors.some((e) => e.code === 'CONTRADICTION'));
ok('unknown field rejected', !R.validateRule({ ...goodPause, conditions: { all: [{ field: 'nonsense', op: '>=', value: 1 }, { field: 'spend', op: '>=', value: 1 }] } }).ok);
ok('scale needs evidence (orders + cpa)', R.validateRule({ name: 's', action: 'SCALE_UP', action_params: { pct: 15 }, conditions: { all: [{ field: 'cpa', op: '<=', value: 100 }] } }).errors.some((e) => e.code === 'SCALE_NEEDS_EVIDENCE'));
ok('scale pct out of range rejected', R.validateRule({ name: 's', action: 'SCALE_UP', action_params: { pct: 250 }, conditions: { all: [{ field: 'purchases', op: '>=', value: 5 }, { field: 'cpa', op: '<=', value: 100 }] } }).errors.some((e) => e.code === 'SCALE_PCT_RANGE'));
ok('cooldown range enforced', R.validateRule({ ...goodPause, cooldown_hours: 999 }).errors.some((e) => e.code === 'COOLDOWN_RANGE'));
ok('bad mode rejected', R.validateRule({ ...goodPause, mode: 'YOLO' }).errors.some((e) => e.code === 'MODE_UNKNOWN'));
ok('null rule rejected', !R.validateRule(null).ok);

console.log('\nA2. rules: conditions never convert UNKNOWN to zero');
let ev = R.evaluateConditions({ all: [{ field: 'stock', op: '>', value: 20 }] }, { stock: null });
ok('unknown stock => not matched + unknown', !ev.matched && ev.unknown);
ev = R.evaluateConditions({ all: [{ field: 'stock', op: '>', value: 20 }] }, { stock: 0 });
ok('stock=0 is a definite fail (not unknown)', !ev.matched && !ev.unknown);
ev = R.evaluateConditions({ all: [{ field: 'spend', op: '>=', value: 100 }, { field: 'purchases', op: '=', value: 0 }] }, { spend: 150, purchases: 0 });
ok('AND matches', ev.matched);
ev = R.evaluateConditions({ all: [{ field: 'cpa', op: 'between', value: [1, 150] }] }, { cpa: 120 });
ok('between matches', ev.matched);
ev = R.evaluateConditions({ all: [{ field: 'cpa', op: '<=', value: { ref: 'target_cpa' } }] }, { cpa: 100, target_cpa: null });
ok('ref to missing target CPA => unknown', !ev.matched && ev.unknown);
ev = R.evaluateConditions({ all: [{ field: 'cpa', op: '<=', value: { ref: 'target_cpa' } }] }, { cpa: 100, target_cpa: 120 });
ok('ref to target CPA resolves', ev.matched);
ev = R.evaluateConditions({ all: [{ field: 'spend', op: '>=', value: 100 }], any: [{ field: 'cpa', op: '>', value: 150 }, { field: 'frequency', op: '>', value: 3 }] }, { spend: 120, cpa: 100, frequency: 3.5 });
ok('OR group works', ev.matched);

console.log('\nA3. rules: conflict detection + windows');
const rPause = { id: 1, enabled: true, name: 'p', action: 'PAUSE', priority: 10, window: 'today', mode: 'AUTOPILOT', scope: {}, store_id: null, conditions: { all: [{ field: 'spend', op: '>=', value: 100 }, { field: 'cpa', op: '>', value: 100 }] } };
const rScale = { id: 2, enabled: true, name: 's', action: 'SCALE_UP', priority: 20, window: 'today', mode: 'AUTOPILOT', scope: {}, store_id: null, action_params: { pct: 10 }, conditions: { all: [{ field: 'spend', op: '>=', value: 100 }, { field: 'cpa', op: '>', value: 80 }] } };
const conf = R.detectRuleConflicts([rPause, rScale]);
ok('opposed overlapping rules conflict', conf.length >= 1, JSON.stringify(conf));
ok('lower priority number wins', conf[0]?.winner === 1);
ok('disjoint rules do not conflict', R.detectRuleConflicts([rPause, { ...rScale, conditions: { all: [{ field: 'cpa', op: '<', value: 50 }, { field: 'spend', op: '>=', value: 100 }] } }]).length === 0);
const wr = R.windowRange('last7', '2026-10-03');
ok('last7 window range', wr.from === '2026-09-27' && wr.to === '2026-10-03', JSON.stringify(wr));
ok('precedence order: Emergency > Safety > Exceptions > DQ > Inventory > Profit > Testing > User rules > Advisor', R.PRECEDENCE.map((p) => p.key).join('>') === 'EMERGENCY_STOP>SAFETY>EXCEPTION>DATA_QUALITY>INVENTORY>PROFIT>TESTING>USER_RULE>ADVISOR', R.PRECEDENCE.map((p) => p.key).join('>'));

console.log('\nA4. Arabic rule parsing (draft only)');
const p1 = R.parseArabicRule('اقفل الحملة لو صرفت 180 جنيه من غير أوردرات إلا حملات التيست');
ok('canonical rule parsed', p1.ok && p1.rule.action === 'PAUSE', JSON.stringify(p1.notes));
ok('draft is disabled + SHADOW + NL source', p1.rule.enabled === false && p1.rule.mode === 'SHADOW' && p1.rule.source === 'NL');
ok('spend>=180 captured', p1.rule.conditions.all.some((c) => c.field === 'spend' && c.op === '>=' && c.value === 180));
ok('zero purchases captured', p1.rule.conditions.all.some((c) => c.field === 'purchases' && c.op === '=' && c.value === 0));
ok('testing exclusion captured', p1.rule.conditions.all.some((c) => c.field === 'campaign_tag' && c.op === '!=' && c.value === 'TESTING'));
ok('parsed draft passes validation', R.validateRule(p1.rule).ok, JSON.stringify(R.validateRule(p1.rule).errors));
const p2 = R.parseArabicRule('افتح الحملة لو CPA بين 1 و 150 آخر 14 يوم والمخزون أكبر من 20 والربح موجب');
ok('open rule parsed with CPA range + stock + profit', p2.ok && p2.rule.action === 'OPEN' && p2.rule.window === 'last14' && p2.rule.conditions.all.some((c) => c.field === 'cpa' && c.op === 'between') && p2.rule.conditions.all.some((c) => c.field === 'stock') && p2.rule.conditions.all.some((c) => c.field === 'profit_state'), JSON.stringify(p2.rule?.conditions));
ok('gibberish is not parsed', !R.parseArabicRule('كلام مش مفهوم خالص').ok);
ok('empty text is not parsed', !R.parseArabicRule('').ok);

// =====================================================================================================================
console.log('\nA5. guards');
const baseCfg = { mode: 'AUTOPILOT', emergency_stop: false, limits: JSON.parse(JSON.stringify(S.DEFAULT_LIMITS)), cooldowns: { ...S.DEFAULT_COOLDOWNS }, schedule: { mode: 'ALWAYS', ranges: [], tzOffsetHours: 3 } };
const baseSet = { ambMinSpendBeforeDecision: 150, ambMinPurchasesBeforeScaling: 5, ambAllowAutoPause: true, ambAllowAutoOpen: true, ambAllowAutoBudgetIncrease: true, ambAllowAutoBudgetDecrease: true, ambMaxBudgetIncreasePct: 20, ambMaxAutoExecutionAmount: 500 };
const mkCtx = (o = {}) => ({ storeId: 'trendy-storeee', campaign: { id: 'c1', status: 'ACTIVE', budget: 200, tag: null, testing: null }, metrics: { spend: 300, purchases: 0 }, product: { id: 1, mappingVerified: true }, dq: { gate: 'OK', overall: 'RECONCILED', statusTrust: { state: 'OK' } }, stock: { status: 'IN_STOCK', currentStock: 100, daysRemaining: 30 }, econ: { complete: true, profitState: 'PROFITABLE', hardStopCpa: 200 }, exceptions: [], recent: { lastByAction: {}, todayCount: 0 }, metaConnected: true, metaStale: false, advisor: null, incidents: [], ...o });
const mkDec = (o = {}) => ({ action: 'PAUSE', params: {}, ruleMode: 'AUTOPILOT', confidence: 'HIGH', needs: {}, ruleMinSpend: 150, cooldownHours: 12, ...o });
const run = (dec, ctx, cfg = baseCfg, set = baseSet, counters = {}) => G.evaluateGuards({ decision: dec, ctx, config: cfg, settings: set, counters, now: NOW });
const codes = (g) => g.blocks.map((b) => b.code);

let g = run(mkDec(), mkCtx());
ok('clean autopilot pause => AUTO + canAutoExecute', g.wouldBe === 'AUTO' && g.canAutoExecute, JSON.stringify(codes(g)));
g = run(mkDec(), mkCtx(), { ...baseCfg, emergency_stop: true });
ok('EMERGENCY STOP blocks and is primary', codes(g).includes('EMERGENCY_STOP') && g.primary.code === 'EMERGENCY_STOP' && !g.canExecute);
g = run(mkDec({ action: 'SCALE_UP', params: { pct: 15, fromBudget: 200, toBudget: 230 } }), mkCtx({ metrics: { spend: 600, purchases: 10 } }), { ...baseCfg, emergency_stop: true });
ok('emergency stop blocks scale too', codes(g).includes('EMERGENCY_STOP'));
g = run(mkDec(), mkCtx(), { ...baseCfg, mode: 'OFF' });
ok('mode OFF blocks', codes(g).includes('MODE_OFF') && !g.canExecute);
g = run(mkDec({ ruleMode: 'AUTOPILOT' }), mkCtx(), { ...baseCfg, mode: 'SHADOW' });
ok('global SHADOW overrides AUTOPILOT rule (stricter wins)', g.effectiveMode === 'SHADOW' && g.wouldBe === 'SHADOW' && !g.canExecute);
g = run(mkDec({ ruleMode: 'SHADOW' }), mkCtx());
ok('SHADOW rule under AUTOPILOT global stays SHADOW', g.effectiveMode === 'SHADOW' && !g.canAutoExecute);
ok('effectiveMode matrix', G.effectiveMode('AUTOPILOT', 'APPROVAL') === 'APPROVAL' && G.effectiveMode('APPROVAL', 'AUTOPILOT') === 'APPROVAL' && G.effectiveMode('OFF', 'AUTOPILOT') === 'OFF' && G.effectiveMode('AUTOPILOT', 'AUTOPILOT') === 'AUTOPILOT');
g = run(mkDec({ confidence: 'MEDIUM' }), mkCtx());
ok('Autopilot needs HIGH confidence (downgrade to approval)', codes(g).includes('CONFIDENCE_TOO_LOW_FOR_AUTOPILOT') && g.wouldBe === 'PREPARED' && !g.canAutoExecute);
g = run(mkDec(), mkCtx(), baseCfg, { ...baseSet, ambAllowAutoPause: false });
ok('action allowlist OFF => not autopilot', codes(g).includes('ACTION_NOT_ALLOWED') && !g.canAutoExecute && g.wouldBe === 'PREPARED');
g = run(mkDec({ action: 'OPEN', needs: { profit: true, stock: true } }), mkCtx({ campaign: { id: 'c1', status: 'PAUSED', budget: 200 }, stock: { status: 'STOCK_UNKNOWN' } }));
ok('unknown stock blocks OPEN (never assume inventory)', codes(g).includes('STOCK_UNKNOWN') && g.wouldBe === 'BLOCKED');
g = run(mkDec({ action: 'OPEN', needs: { profit: true, stock: true } }), mkCtx({ campaign: { id: 'c1', status: 'PAUSED', budget: 200 }, econ: { complete: false, profitState: 'UNKNOWN' } }));
ok('incomplete economics blocks OPEN (profit UNKNOWN)', codes(g).includes('ECONOMICS_INCOMPLETE'));
g = run(mkDec({ action: 'OPEN', needs: { profit: true, stock: true } }), mkCtx({ campaign: { id: 'c1', status: 'PAUSED', budget: 200 }, stock: { status: 'OUT_OF_STOCK', currentStock: 0 } }));
ok('zero stock blocks OPEN', codes(g).includes('STOCK_OUT'));
g = run(mkDec({ action: 'OPEN', needs: { profit: true } }), mkCtx({ campaign: { id: 'c1', status: 'PAUSED', budget: 200 }, econ: { complete: true, profitState: 'UNPROFITABLE' } }));
ok('unprofitable product blocks OPEN', codes(g).includes('PROFIT_NEGATIVE'));
g = run(mkDec({ action: 'OPEN', needs: {} }), mkCtx({ campaign: { id: 'c1', status: 'PAUSED', budget: 200 }, dq: { gate: 'DECISION_BLOCKED_DATA_QUALITY' } }));
ok('data quality gate blocks with the mandated message', codes(g).includes('DATA_QUALITY_BLOCKED') && G.BLOCK_CODES.DATA_QUALITY_BLOCKED.message.includes('القرار متوقف بسبب جودة البيانات'));
g = run(mkDec({ action: 'OPEN', needs: {} }), mkCtx({ campaign: { id: 'c1', status: 'PAUSED', budget: 200 }, dq: {} }));
ok('UNKNOWN data quality blocks (not treated as OK)', codes(g).includes('DATA_QUALITY_UNKNOWN'));
g = run(mkDec({ action: 'OPEN', needs: {}, usesCod: true }), mkCtx({ campaign: { id: 'c1', status: 'PAUSED', budget: 200 }, dq: { gate: 'OK', overall: 'RECONCILED', statusTrust: { state: 'UNRELIABLE' } } }));
ok('COD-dependent decision blocked while EO status unverified', codes(g).includes('COD_UNRELIABLE'));
g = run(mkDec({ action: 'OPEN' }), mkCtx({ storeId: null, campaign: { id: 'c1', status: 'PAUSED', budget: 200 } }));
ok('missing store => STORE_AMBIGUOUS (fail closed)', codes(g).includes('STORE_AMBIGUOUS'));
g = run(mkDec({ action: 'OPEN', needs: { stock: true } }), mkCtx({ campaign: { id: 'c1', status: 'PAUSED', budget: 200 }, product: { id: 1, mappingVerified: false } }));
ok('unverified mapping blocks product-dependent action', codes(g).includes('MAPPING_UNRELIABLE'));
g = run(mkDec({ action: 'PAUSE', needs: {} }), mkCtx({ product: { id: null, mappingVerified: false } }));
ok('pause on spend-with-no-orders is allowed on unverified mapping (warn only)', !codes(g).includes('MAPPING_UNRELIABLE') && codes(g).includes('MAPPING_UNVERIFIED_WARN'));
for (const [type, act, exp] of [['NO_AUTO_STOP', 'PAUSE', 'EXCEPTION_NO_AUTO_STOP'], ['NO_AUTOMATION', 'PAUSE', 'EXCEPTION_NO_AUTOMATION'], ['NO_AUTO_OPEN', 'OPEN', 'EXCEPTION_NO_AUTO_OPEN'], ['NO_AUTO_SCALE', 'SCALE_UP', 'EXCEPTION_NO_AUTO_SCALE'], ['NO_BUDGET_CHANGE', 'SCALE_DOWN', 'EXCEPTION_NO_BUDGET_CHANGE']]) {
  const c = mkCtx({ metrics: { spend: 600, purchases: 10 }, campaign: { id: 'c1', status: act === 'OPEN' ? 'PAUSED' : 'ACTIVE', budget: 200 }, exceptions: [{ id: 1, types: [type] }] });
  const gg = run(mkDec({ action: act, params: { pct: 10, fromBudget: 200, toBudget: 180 } }), c);
  ok(`exception ${type} blocks ${act}`, codes(gg).includes(exp) && gg.wouldBe === 'BLOCKED');
}
g = run(mkDec({ action: 'SCALE_UP', params: { pct: 15, fromBudget: 200, toBudget: 230 } }), mkCtx({ metrics: { spend: 600, purchases: 10 }, exceptions: [{ id: 1, types: ['NO_AUTO_STOP'] }] }));
ok('NO_AUTO_STOP does not block scale (scoped to its action)', !codes(g).includes('EXCEPTION_NO_AUTO_STOP'));
g = run(mkDec({ action: 'PAUSE' }), mkCtx({ campaign: { id: 'c1', status: 'ACTIVE', budget: 200, tag: 'TESTING', testing: null } }));
ok('TESTING campaign protected from generic pause', codes(g).includes('TESTING_PROTECTED'));
g = run(mkDec({ action: 'PAUSE' }), mkCtx({ campaign: { id: 'c1', status: 'ACTIVE', budget: 200, tag: 'TESTING', testing: { stopSpend: 250 } }, metrics: { spend: 300, purchases: 0 } }));
ok('TESTING campaign can stop at its OWN stop-spend', !codes(g).includes('TESTING_PROTECTED'));
g = run(mkDec(), mkCtx({ recent: { lastByAction: { PAUSE: new Date(NOW.getTime() - 2 * H).toISOString() }, todayCount: 0 } }));
ok('cooldown blocks repeat action', codes(g).includes('COOLDOWN_ACTIVE'));
g = run(mkDec({ action: 'OPEN', needs: {} }), mkCtx({ campaign: { id: 'c1', status: 'PAUSED', budget: 200 }, recent: { lastByAction: { PAUSE: new Date(NOW.getTime() - 3 * H).toISOString() }, todayCount: 0 } }));
ok('flip-flop (open right after pause) blocked', codes(g).includes('FLIP_FLOP'));
g = run(mkDec(), mkCtx(), baseCfg, baseSet, { actionsLastHour: 6 });
ok('hourly rate limit', codes(g).includes('RATE_LIMIT_HOUR'));
g = run(mkDec(), mkCtx(), baseCfg, baseSet, { actionsToday: 30 });
ok('daily rate limit', codes(g).includes('RATE_LIMIT_DAY'));
g = run(mkDec(), mkCtx(), baseCfg, baseSet, { campaignActionsToday: 2 });
ok('per-campaign daily change limit', codes(g).includes('CAMPAIGN_DAILY_LIMIT'));
g = run(mkDec({ action: 'SCALE_UP', params: { pct: 50, fromBudget: 200, toBudget: 300 } }), mkCtx({ metrics: { spend: 600, purchases: 10 } }));
ok('max action size (50% > 20%) blocks', codes(g).includes('MAX_ACTION_SIZE'));
g = run(mkDec({ action: 'SCALE_UP', params: { pct: 15, fromBudget: 200, toBudget: 230 } }), mkCtx({ metrics: { spend: 100, purchases: 2 } }));
ok('scale on thin sample blocked', codes(g).includes('INSUFFICIENT_SAMPLE'));
g = run(mkDec({ action: 'PAUSE' }), mkCtx({ metrics: { spend: 20, purchases: 0 } }));
ok('pause on thin spend blocked', codes(g).includes('INSUFFICIENT_SAMPLE'));
g = run(mkDec({ action: 'OPEN', needs: {} }), mkCtx({ campaign: { id: 'c1', status: 'PAUSED', budget: 200 } }), baseCfg, baseSet, { loss: { campaign: 0, product: 0, account: 5000 } });
ok('daily loss limit freezes OPEN', (baseCfg.limits.lossLimits?.account == null) || codes(g).includes('DAILY_LOSS_LIMIT'));
const lossCfg = { ...baseCfg, limits: { ...baseCfg.limits, lossLimits: { campaign: null, product: null, account: 1000 } } };
g = run(mkDec({ action: 'OPEN', needs: {} }), mkCtx({ campaign: { id: 'c1', status: 'PAUSED', budget: 200 } }), lossCfg, baseSet, { loss: { campaign: 0, product: 0, account: 5000 } });
ok('account loss limit exceeded freezes OPEN', codes(g).includes('DAILY_LOSS_LIMIT'));
g = run(mkDec({ action: 'PAUSE' }), mkCtx(), lossCfg, baseSet, { loss: { campaign: 0, product: 0, account: 5000 } });
ok('loss limit never blocks a PAUSE (stopping a loss is always allowed)', !codes(g).includes('DAILY_LOSS_LIMIT'));
g = run(mkDec({ action: 'OPEN', needs: {} }), mkCtx({ campaign: { id: 'c1', status: 'PAUSED', budget: 200 }, velocity: { abnormal: true } }));
ok('abnormal spend velocity freezes OPEN', codes(g).includes('SPEND_VELOCITY_FREEZE'));
g = run(mkDec({ action: 'SCALE_UP', params: { pct: 15, fromBudget: 200, toBudget: 230 } }), mkCtx({ metrics: { spend: 600, purchases: 10 }, recent: { lastByAction: {}, todayCount: 0, harmfulScaleAt: new Date(NOW.getTime() - 10 * H).toISOString() } }));
ok('recent harmful scale blocks another scale', codes(g).includes('RECENT_HARMFUL_SCALE'));
g = run(mkDec({ action: 'PAUSE' }), mkCtx(), baseCfg, baseSet);
ok('meta stale blocks execution', codes(run(mkDec(), mkCtx({ metaStale: true }))).includes('META_DATA_STALE'));
ok('meta not connected blocks execution', codes(run(mkDec({ ruleMode: 'APPROVAL' }), mkCtx({ metaConnected: false }))).includes('META_NOT_CONNECTED'));
ok('advisory-only AMB blocks execution', codes(run(mkDec({ ruleMode: 'APPROVAL' }), mkCtx(), baseCfg, { ...baseSet, ambExecutionMode: 'ADVISORY' })).includes('AMB_ADVISORY_ONLY'));
g = run(mkDec({ action: 'SCALE_UP', params: { pct: 15, fromBudget: 200, toBudget: 230 }, needs: { stock: true } }), mkCtx({ metrics: { spend: 600, purchases: 10 }, stock: { status: 'IN_STOCK', currentStock: 100, daysRemaining: 3 } }));
ok('stock coverage < minDaysCover blocks SCALE_UP', codes(g).includes('STOCK_COVERAGE_LOW'));
g = run(mkDec({ action: 'SCALE_UP', params: { pct: 15, fromBudget: 200, toBudget: 230 } }), mkCtx({ metrics: { spend: 600, purchases: 10 }, advisor: { stage: 'FIX_FIRST', primaryProblem: 'CREATIVE_FATIGUE' } }));
ok('Smart Advisor disagreement downgrades scale to approval (lowest precedence)', codes(g).includes('ADVISOR_DISAGREES') && !g.canAutoExecute);
g = run(mkDec({ action: 'PAUSE' }), mkCtx({ exceptions: [{ id: 1, types: ['NO_AUTO_STOP'] }], recent: { lastByAction: { PAUSE: new Date(NOW.getTime() - 1 * H).toISOString() }, todayCount: 0 } }), { ...baseCfg, emergency_stop: true });
ok('blocks sorted by precedence (emergency first, then safety, then exception)', codes(g)[0] === 'EMERGENCY_STOP' && codes(g).indexOf('COOLDOWN_ACTIVE') < codes(g).indexOf('EXCEPTION_NO_AUTO_STOP'), JSON.stringify(codes(g)));
ok('schedule: ALWAYS', G.withinSchedule({ mode: 'ALWAYS' }, NOW));
ok('schedule: HOURS inside (12:00Z = 15:00 Cairo)', G.withinSchedule({ mode: 'HOURS', ranges: [{ from: '14:00', to: '18:00' }], tzOffsetHours: 3 }, NOW));
ok('schedule: HOURS outside', !G.withinSchedule({ mode: 'HOURS', ranges: [{ from: '01:00', to: '06:00' }], tzOffsetHours: 3 }, NOW));
ok('schedule: EXCLUDED_HOURS inside the excluded range => blocked', !G.withinSchedule({ mode: 'EXCLUDED_HOURS', ranges: [{ from: '14:00', to: '18:00' }], tzOffsetHours: 3 }, NOW));
ok('schedule: overnight range wraps midnight', G.withinSchedule({ mode: 'HOURS', ranges: [{ from: '22:00', to: '04:00' }], tzOffsetHours: 3 }, new Date('2026-10-03T21:30:00Z')));
g = run(mkDec({ ruleMode: 'APPROVAL' }), mkCtx(), { ...baseCfg, schedule: { mode: 'HOURS', ranges: [{ from: '01:00', to: '06:00' }], tzOffsetHours: 3 } });
ok('outside schedule blocks execution', codes(g).includes('OUTSIDE_SCHEDULE'));

console.log('\nA6. economics: never invented');
let ec = G.computeOperatorEconomics({ product: { selling_price: 0, product_cost: 0 }, ambProduct: null, opCfg: null });
ok('no price/cost => incomplete, profit UNKNOWN, no max CPA invented', !ec.complete && ec.profitState === 'UNKNOWN' && ec.calculatedMaxCpa === null && ec.unitMargin === null);
ec = G.computeOperatorEconomics({ product: { selling_price: 500, product_cost: 200, shipping_cost: 50, packaging_cost: 10, other_cost: 0 }, ambProduct: null, opCfg: { min_profit: 20 }, observedCpa: 100 });
ok('complete economics: margin 240, max CPA 220', ec.complete && ec.unitMargin === 240 && ec.calculatedMaxCpa === 220, JSON.stringify(ec));
ok('profit at CPA 100 => PROFITABLE (140/500)', ec.profitState === 'PROFITABLE' && ec.unitProfitAtCpa === 140);
ec = G.computeOperatorEconomics({ product: { selling_price: 500, product_cost: 200, shipping_cost: 50, packaging_cost: 10 }, ambProduct: null, opCfg: null, observedCpa: 300 });
ok('CPA above margin => UNPROFITABLE', ec.profitState === 'UNPROFITABLE');
ec = G.computeOperatorEconomics({ product: { selling_price: 500, product_cost: 200 }, ambProduct: null, opCfg: { hard_stop_cpa: 180, target_cpa: 120 }, observedCpa: null });
ok('manual Hard Stop/Target CPA honoured and labelled MANUAL', ec.hardStopCpa === 180 && ec.targetCpa === 120 && ec.hardStopSource === 'MANUAL');
ok('confidence: thin evidence is LOW', G.decisionConfidence({ action: 'PAUSE', metrics: { spend: 20, purchases: 0 }, settings: baseSet, mappingVerified: false, dqOk: false, needs: {} }) === 'LOW');
ok('confidence: strong clean evidence is HIGH', G.decisionConfidence({ action: 'PAUSE', metrics: { spend: 400, purchases: 0 }, settings: baseSet, mappingVerified: true, dqOk: true, needs: {} }) === 'HIGH');
ok('confidence: missing economics caps profit-dependent action', G.decisionConfidence({ action: 'SCALE_UP', metrics: { spend: 900, purchases: 20 }, settings: baseSet, mappingVerified: true, dqOk: true, econKnown: false, stockKnown: true, needs: { profit: true } }) !== 'HIGH');

console.log('\nA7. engine pure helpers + settings + route wiring');
const k1 = E.decisionKey({ ruleId: 1, campaignId: 'c1', action: 'PAUSE', cooldownHours: 12, now: NOW });
const k2 = E.decisionKey({ ruleId: 1, campaignId: 'c1', action: 'PAUSE', cooldownHours: 12, now: new Date(NOW.getTime() + 2 * H) });
const k3 = E.decisionKey({ ruleId: 1, campaignId: 'c1', action: 'PAUSE', cooldownHours: 12, now: new Date(NOW.getTime() + 13 * H) });
const k4 = E.decisionKey({ ruleId: 1, campaignId: 'c2', action: 'PAUSE', cooldownHours: 12, now: NOW });
ok('decision_key stable inside one cooldown bucket', k1 === k2);
ok('decision_key changes in the next bucket / other campaign', k1 !== k3 && k1 !== k4);
const sm = E.summarize([{ action: 'OPEN', wouldBe: 'BLOCKED', blocks: [{ severity: 'BLOCK', code: 'STOCK_UNKNOWN' }], primaryBlock: { group: 'INVENTORY', code: 'STOCK_UNKNOWN' } }, { action: 'PAUSE', wouldBe: 'SHADOW', blocks: [] }, { action: 'OPEN', wouldBe: 'BLOCKED', blocks: [{ severity: 'BLOCK', code: 'DATA_QUALITY_BLOCKED' }], primaryBlock: { group: 'DATA_QUALITY', code: 'DATA_QUALITY_BLOCKED' } }]);
ok('summary counts', sm.total === 3 && sm.wouldPause === 1 && sm.wouldOpen === 0 && sm.blockedByDataQuality === 1 && sm.blockedBySafety === 1);
ok('AMB settings: ambAllowAutoOpen exists and defaults OFF', AMB_DEFAULT_SETTINGS.ambAllowAutoOpen === false);
ok('AMB settings: every autopilot allowlist flag defaults OFF', ['ambAllowAutoOpen', 'ambAllowAutoPause', 'ambAllowAutoBudgetIncrease', 'ambAllowAutoBudgetDecrease'].every((k) => AMB_DEFAULT_SETTINGS[k] === false));
ok('default limits: allowAutoRollback is OFF', S.DEFAULT_LIMITS.allowAutoRollback === false);
const routeSrc = readFileSync(join(__dirname, '../routes/operator.js'), 'utf8');
const mutating = routeSrc.split('\n').filter((l) => /^router\.(post|put|delete)\(/.test(l));
const openToManager = ['/emergency-stop', '/rules/validate', '/rules/parse', '/rules/simulate', '/command', '/templates/:key/instantiate', '/rules/:id/dry-run', '/what-will-happen', '/setup-grid/validate', '/setup-grid/preview', '/setup-grid/recompute', '/setup-grid/shadow']; // the last eight only COMPUTE (no writes — proven by the read-only tests; /setup-grid/apply stays ADMIN)
const unguarded = mutating.filter((l) => !/ADMIN/.test(l) && !openToManager.some((p) => l.includes(`'${p}'`)));
ok('every mutating route is ADMIN-only except stop/validate/parse/simulate/command', unguarded.length === 0, unguarded.join(' | '));
ok('Emergency Stop ACTIVATION is open to managers but DEACTIVATION is ADMIN-only', /router\.post\('\/emergency-stop', asyncRoute/.test(routeSrc) && /router\.delete\('\/emergency-stop', ADMIN/.test(routeSrc));

// =====================================================================================================================
console.log('\nB. DB-backed on disposable rows (injected executor, no Meta)');
const T = '__optest_';
const origCfg = await S.getOperatorConfig();
const created = { decisions: [], rules: [], exceptions: [], recs: [] };
const mkDecisionRow = async (o = {}) => {
  const key = `${T}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const row = await prisma.ambOperatorDecision.create({ data: { decision_key: key, store_id: `${T}store`, ad_account_id: `${T}acc`, campaign_id: `${T}c1`, campaign_name: `${T}campaign`, action: 'SCALE_DOWN', rule_name: `${T}rollback`, mode_at_decision: 'APPROVAL', status: 'PREPARED', confidence: 'HIGH', params_json: JSON.stringify({ rollbackOf: 1, fromBudget: 230, toBudget: 200, pct: 13, window: 'today' }), evidence_json: JSON.stringify({ rollbackOf: 1 }), why_json: JSON.stringify({ why: 'test' }), ...o } });
  created.decisions.push(row.id); return row;
};
const fakeWorld = async () => ({ config: await S.getOperatorConfig(), settings: {}, adAccountId: null, campaigns: [], windows: {} });
try {
  // --- config: default + mode + emergency
  ok('config row exists with a valid mode', S.OPERATOR_MODES.includes(origCfg.mode));
  let bad = null; try { await S.setOperatorMode({ mode: 'AUTOPILOT', userId: null }); } catch (e) { bad = e; }
  ok('AUTOPILOT requires explicit confirmation', bad && bad.status === 400);
  bad = null; try { await S.setOperatorMode({ mode: 'TURBO' }); } catch (e) { bad = e; }
  ok('unknown mode rejected', bad && bad.status === 400);
  await S.setOperatorMode({ mode: 'APPROVAL' });
  await S.setEmergencyStop({ on: true, reason: `${T}test` });
  let cfg = await S.getOperatorConfig();
  ok('emergency stop persisted with reason + timestamp', cfg.emergency_stop === true && cfg.emergency_reason === `${T}test` && !!cfg.emergency_at);
  bad = null; try { await S.setOperatorMode({ mode: 'AUTOPILOT', confirmAutopilot: true }); } catch (e) { bad = e; }
  ok('cannot enter AUTOPILOT while emergency stop is on', bad && bad.status === 409);
  await S.setEmergencyStop({ on: false });
  cfg = await S.getOperatorConfig();
  ok('emergency stop cleared', cfg.emergency_stop === false && !cfg.emergency_reason);
  bad = null; try { await S.updateOperatorLimits({ limits: { maxDecreasePct: 500 } }); } catch (e) { bad = e; }
  ok('limits validated (maxDecreasePct 500 rejected)', bad && bad.status === 400);
  bad = null; try { await S.updateOperatorLimits({ cooldowns: { PAUSE: 0 } }); } catch (e) { bad = e; }
  ok('cooldown 0h rejected', bad && bad.status === 400);

  // --- rules store
  const bs = await S.saveRule({ rule: { name: `${T}bad`, action: 'PAUSE', conditions: { all: [{ field: 'purchases', op: '=', value: 0 }] } } });
  ok('invalid rule is NOT saved', !bs.ok && (await prisma.ambOperatorRule.count({ where: { name: `${T}bad` } })) === 0);
  const gs = await S.saveRule({ rule: { ...goodPause, name: `${T}good` } });
  ok('valid rule saved disabled-by-default with SHADOW mode', gs.ok && gs.rule.enabled === false && gs.rule.mode === 'SHADOW');
  if (gs.rule) created.rules.push(gs.rule.id);
  const en = await S.setRuleEnabled({ id: gs.rule.id, enabled: true });
  ok('rule can be enabled', en.ok && en.rule.enabled === true);
  const up = await S.saveRule({ id: gs.rule.id, rule: { ...gs.rule, name: `${T}good`, cooldown_hours: 6 } });
  ok('rule update bumps version', up.ok && up.rule.version === gs.rule.version + 1);
  await S.setRuleEnabled({ id: gs.rule.id, enabled: false });

  // --- exceptions
  const ex = await S.addException({ scopeType: 'CAMPAIGN', scopeId: `${T}c1`, types: ['NO_AUTO_STOP'], reason: 'test', ttlHours: 1 });
  created.exceptions.push(ex.id);
  ok('exception stored with expiry', ex.temporary && ex.types[0] === 'NO_AUTO_STOP');
  ok('active exception listed', (await S.listExceptions({})).some((e) => e.id === ex.id));
  ok('expired exception is NOT listed (TTL enforced at read)', !(await S.listExceptions({ now: new Date(Date.now() + 2 * H) })).some((e) => e.id === ex.id));
  ok('exceptionsFor matches by campaign scope only', S.exceptionsFor({ exceptions: [ex], storeId: 's', productId: 1, campaignId: `${T}c1` }).length === 1 && S.exceptionsFor({ exceptions: [ex], storeId: 's', productId: 1, campaignId: 'other' }).length === 0);
  bad = null; try { await S.addException({ scopeType: 'CAMPAIGN', scopeId: 'x', types: ['DO_ANYTHING'] }); } catch (e) { bad = e; }
  ok('unknown exception type rejected', bad && bad.status === 400);
  await S.removeException({ id: ex.id });
  ok('removed exception no longer listed', !(await S.listExceptions({})).some((e) => e.id === ex.id));

  // --- per-product economics + tags
  bad = null; try { await S.upsertProductConfig({ productId: 2000000000, storeId: `${T}store`, patch: { target_cpa: 150, hard_stop_cpa: 100 } }); } catch (e) { bad = e; }
  ok('Hard Stop CPA below Target CPA rejected', bad && bad.status === 400);
  const pc = await S.upsertProductConfig({ productId: 2000000000, storeId: `${T}store`, patch: { target_cpa: 120, hard_stop_cpa: 200, min_stock: 10 } });
  ok('product config saved and isolated per store', pc.target_cpa === 120 && !(await S.getProductConfig(2000000000, 'default')));
  bad = null; try { await S.upsertProductConfig({ productId: 2000000000, storeId: `${T}store`, patch: { target_cpa: -5 } }); } catch (e) { bad = e; }
  ok('negative CPA rejected', bad && bad.status === 400);
  bad = null; try { await S.setCampaignTag({ adAccountId: `${T}acc`, campaignId: `${T}c1`, tag: 'NOPE' }); } catch (e) { bad = e; }
  ok('invalid campaign tag rejected', bad && bad.status === 400);
  await S.setCampaignTag({ adAccountId: `${T}acc`, campaignId: `${T}c1`, tag: 'TESTING', testing: { stopSpend: 300, minSample: 8 } });
  const tags = await S.loadCampaignTags(`${T}acc`);
  ok('TESTING tag with its own thresholds persisted', tags.get(`${T}c1`)?.tag === 'TESTING' && tags.get(`${T}c1`)?.testing?.stopSpend === 300);
  await S.setCampaignTag({ adAccountId: `${T}acc`, campaignId: `${T}c1`, tag: null });
  ok('tag removable', !(await S.loadCampaignTags(`${T}acc`)).has(`${T}c1`));

  // --- decision lifecycle with an injected executor
  let calls = 0;
  const execOk = async ({ recId }) => { calls++; created.recs.push(recId); return { ok: true }; };
  const deps = (o = {}) => ({ approveAndExecute: execOk, world: null, ...o });
  const reset = async (mode) => { await S.setEmergencyStop({ on: false }); if (mode === 'AUTOPILOT') await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { mode } }); else await S.setOperatorMode({ mode }); }; // AUTOPILOT bypasses the gate here on purpose: the gate itself is tested below

  await reset('SHADOW'); calls = 0;
  let d1 = await mkDecisionRow();
  let r = await E.executeDecision({ decisionId: d1.id, source: 'USER', deps: deps() });
  ok('SHADOW mode: nothing executes, executor never called', !r.executed && calls === 0 && /Shadow/.test(r.message));
  await reset('OFF');
  d1 = await mkDecisionRow(); r = await E.executeDecision({ decisionId: d1.id, deps: deps() });
  ok('OFF mode: nothing executes', !r.executed && calls === 0);

  await reset('APPROVAL');
  await S.setEmergencyStop({ on: true, reason: `${T}stop` });
  d1 = await mkDecisionRow(); r = await E.executeDecision({ decisionId: d1.id, deps: deps() });
  ok('EMERGENCY STOP overrides an approved decision', !r.executed && calls === 0 && /إيقاف الطوارئ/.test(r.message));
  const afterStop = await prisma.ambOperatorDecision.findUnique({ where: { id: d1.id } });
  ok('blocked decision records the reason (not silently dropped)', afterStop.status === 'BLOCKED' && !!afterStop.error);
  await S.setEmergencyStop({ on: false });

  const d2 = await mkDecisionRow();
  const [ra, rb] = await Promise.all([E.executeDecision({ decisionId: d2.id, deps: deps() }), E.executeDecision({ decisionId: d2.id, deps: deps() })]);
  ok('atomic claim: concurrent execution runs the executor exactly once', calls === 1 && [ra, rb].filter((x) => x.executed).length === 1, `calls=${calls} ${JSON.stringify([ra.status, rb.status])}`);
  const row2 = await prisma.ambOperatorDecision.findUnique({ where: { id: d2.id } });
  ok('executed decision reaches EXECUTED/VERIFIED with an executable AmbRecommendation link', ['EXECUTED', 'VERIFIED'].includes(row2.status) && !!row2.amb_recommendation_id && !!row2.executed_at);
  const rec2 = await prisma.ambRecommendation.findUnique({ where: { id: row2.amb_recommendation_id } });
  ok('recommendation routed through the existing executor contract (source OPERATOR, DECREASE_BUDGET)', rec2?.source === 'OPERATOR' && rec2.action_type === 'DECREASE_BUDGET' && rec2.campaign_id === `${T}c1`);
  const again = await E.executeDecision({ decisionId: d2.id, deps: deps() });
  ok('re-executing a finished decision is refused (idempotent)', !again.executed && calls === 1);

  // executor failure
  const d3 = await mkDecisionRow();
  const rf = await E.executeDecision({ decisionId: d3.id, deps: deps({ approveAndExecute: async () => ({ ok: false, message: 'Meta رفض' }) }) });
  const row3 = await prisma.ambOperatorDecision.findUnique({ where: { id: d3.id } });
  ok('executor failure => FAILED with reason, no retry loop', !rf.executed && row3.status === 'FAILED' && /Meta/.test(row3.error));
  if (row3.amb_recommendation_id) created.recs.push(row3.amb_recommendation_id);
  const d3b = await mkDecisionRow();
  const rt = await E.executeDecision({ decisionId: d3b.id, deps: deps({ approveAndExecute: async () => { throw new Error('boom'); } }) });
  const row3b = await prisma.ambOperatorDecision.findUnique({ where: { id: d3b.id } });
  ok('executor exception => FAILED (caught)', !rt.executed && row3b.status === 'FAILED' && /boom/.test(row3b.error));
  if (row3b.amb_recommendation_id) created.recs.push(row3b.amb_recommendation_id);

  // autopilot rollback gate
  await reset('AUTOPILOT');
  const d4 = await mkDecisionRow(); const before = calls;
  const ar = await E.executeDecision({ decisionId: d4.id, source: 'AUTOPILOT', deps: deps() });
  const row4 = await prisma.ambOperatorDecision.findUnique({ where: { id: d4.id } });
  ok('Autopilot rollback is not allowed unless explicitly enabled; decision stays PREPARED for a human', !ar.executed && calls === before && row4.status === 'PREPARED');
  await reset('APPROVAL');

  // approve flow (user)
  const d5 = await mkDecisionRow();
  const ap = await E.approveDecision({ decisionId: d5.id, userId: null, deps: deps() });
  ok('approve => APPROVED => executed through executor', ap.executed === true);
  let r409 = null; try { await E.approveDecision({ decisionId: d5.id, userId: null, deps: deps() }); } catch (e) { r409 = e; }
  ok('approving twice => 409', r409 && r409.status === 409);
  let r404 = null; try { await E.approveDecision({ decisionId: 2147483000, deps: deps() }); } catch (e) { r404 = e; }
  ok('approving a missing decision => 404', r404 && r404.status === 404);

  // revalidation: a decision whose rule vanished never executes
  const d6 = await mkDecisionRow({ rule_id: 2147483000, decision_key: `${T}norule_${Date.now()}`, params_json: JSON.stringify({ window: 'today' }) });
  const before6 = calls;
  const rv = await E.executeDecision({ decisionId: d6.id, deps: deps({ world: await fakeWorld() }) });
  const row6 = await prisma.ambOperatorDecision.findUnique({ where: { id: d6.id } });
  ok('stale decision (rule gone / conditions changed) is EXPIRED, never executed', !rv.executed && calls === before6 && row6.status === 'EXPIRED');

  // reject / snooze
  const d7 = await mkDecisionRow();
  ok('reject works on PREPARED', (await E.rejectDecision({ decisionId: d7.id, userId: null, reason: 'no' })).ok && (await prisma.ambOperatorDecision.findUnique({ where: { id: d7.id } })).status === 'REJECTED');
  ok('reject is not repeatable on a terminal decision', !(await E.rejectDecision({ decisionId: d7.id })).ok);
  const d8 = await mkDecisionRow();
  const sn = await E.snoozeDecision({ decisionId: d8.id, hours: 6 });
  ok('snooze sets SNOOZED until a future time', sn.ok && (await prisma.ambOperatorDecision.findUnique({ where: { id: d8.id } })).status === 'SNOOZED' && sn.until > new Date());
  const sn2 = await E.snoozeDecision({ decisionId: d8.id, hours: 99999 });
  ok('snooze capped at 7 days', sn2.ok === false || sn2.until.getTime() - Date.now() <= 168 * H + 1000);

  // rollback preparation
  const exe = await mkDecisionRow({ action: 'SCALE_UP', status: 'VERIFIED', executed_at: new Date(), before_json: JSON.stringify({ budget: 200 }), after_json: JSON.stringify({ budget: 230 }), rollback_json: JSON.stringify({ capturedBeforeWrite: true, previous: { budget: 200 }, at: new Date().toISOString() }), params_json: JSON.stringify({ pct: 15, fromBudget: 200, toBudget: 230, window: 'today' }) });
  const rb1 = await E.prepareRollback({ decisionId: exe.id, reason: 'TEST' });
  created.decisions.push(rb1.id);
  ok('rollback prepared as a NEW PREPARED inverse decision (SCALE_DOWN to the captured budget)', rb1.status === 'PREPARED' && rb1.action === 'SCALE_DOWN' && JSON.parse(rb1.params_json).toBudget === 200);
  const rb2 = await E.prepareRollback({ decisionId: exe.id, reason: 'TEST' });
  ok('rollback preparation is idempotent', rb2.id === rb1.id);
  const notExec = await mkDecisionRow({ status: 'SHADOW', rollback_json: null });
  let e409 = null; try { await E.prepareRollback({ decisionId: notExec.id }); } catch (e) { e409 = e; }
  ok('cannot roll back a decision that never executed', e409 && e409.status === 409);

  // decision_key uniqueness
  const dupKey = `${T}dup_${Date.now()}`;
  const dupData = { decision_key: dupKey, store_id: `${T}store`, ad_account_id: `${T}acc`, campaign_id: `${T}c9`, action: 'PAUSE', status: 'SHADOW', mode_at_decision: 'SHADOW' };
  const k = await prisma.ambOperatorDecision.create({ data: dupData });
  created.decisions.push(k.id);
  let dupErr = null; try { await prisma.ambOperatorDecision.create({ data: dupData }); } catch (e) { dupErr = e; }
  ok('decision_key is UNIQUE (duplicate decision impossible)', dupErr && dupErr.code === 'P2002');

  // --- reports
  const shaped = REP.shapeDecision(await prisma.ambOperatorDecision.findUnique({ where: { id: row2.id } }));
  ok('shapeDecision parses JSON + labels', shaped.actionLabel && shaped.statusLabel && shaped.params.toBudget === 200 && shaped.links.ambRecommendationId === row2.amb_recommendation_id);
  const hist = await REP.listDecisions({ bucket: 'history', store: `${T}store`, limit: 100 });
  ok('history bucket lists finished decisions of that store only', hist.length >= 2 && hist.every((x) => x.store === `${T}store`));
  const ov = await REP.operatorOverview({ monitored: 7 });
  ok('overview KPIs present and numeric', typeof ov.kpis.readyToOpen === 'number' && typeof ov.kpis.blockedBySafety === 'number' && ov.kpis.monitored === 7 && ['SHADOW', 'APPROVAL', 'AUTOPILOT', 'OFF'].includes(ov.mode));

  // shadow reconciliation (hindsight, no snapshots => userDidSame false)
  const sh = await mkDecisionRow({ action: 'PAUSE', status: 'SHADOW', mode_at_decision: 'SHADOW', created_at: new Date(Date.now() - 5 * H), evidence_json: JSON.stringify({ todayMetrics: { spend: 200, purchases: 0 } }), before_json: JSON.stringify({ status: 'ACTIVE', budget: 200 }), params_json: JSON.stringify({ window: 'today' }) });
  const rec = await REP.reconcileShadowOutcomes({ minAgeHours: 2, limit: 500, deps: { metricsMap: new Map([[`${T}c1`, { spend: 500, purchases: 0, cpa: null }]]) } });
  const shRow = await prisma.ambOperatorDecision.findUnique({ where: { id: sh.id } });
  const shj = JSON.parse(shRow.shadow_json || 'null');
  ok('shadow reconciliation: waste-avoided hindsight computed from spend since the decision (500-200)', rec.evaluated >= 1 && shj?.hindsight?.kind === 'WASTE_AVOIDED' && shj.hindsight.spendSince === 300, JSON.stringify(shj));
  ok('shadow reconciliation: no snapshot => userDidSame false (honest)', shj?.userDidSame?.done === false);
  const rep = await REP.shadowReport({ days: 7 });
  ok('shadow report never calls itself "AI accuracy"', /مش "دقة الذكاء الاصطناعي"/.test(rep.note) && !('accuracy' in rep));

  // --- command center never executes raw
  const cfgBefore = await S.getOperatorConfig(); const rulesBefore = (await S.listRules()).length;
  let c = await CMD.interpretCommand('إيقاف فوري');
  ok('command "إيقاف فوري" => proposal requiring confirmation, nothing applied', c.kind === 'EMERGENCY' && c.requiresConfirmation && (await S.getOperatorConfig()).emergency_stop === cfgBefore.emergency_stop);
  c = await CMD.interpretCommand('لو صرفت 200 جنيه من غير أوردرات وقف الحملة');
  ok('rule-like command => RULE_DRAFT (disabled, SHADOW) and NOT saved', c.kind === 'RULE_DRAFT' && c.rule.enabled === false && c.rule.mode === 'SHADOW' && (await S.listRules()).length === rulesBefore, JSON.stringify(c).slice(0, 200));
  c = await CMD.interpretCommand('إيه الحملات اللي هتتوقف؟');
  ok('question => read-only QUERY', c.kind === 'QUERY' && Array.isArray(c.decisions));
  c = await CMD.interpretCommand('امسح كل الحملات');
  ok('unsupported/dangerous command => UNSUPPORTED', c.kind === 'UNSUPPORTED');
  c = await CMD.interpretCommand('   ');
  ok('empty command => UNSUPPORTED', c.kind === 'UNSUPPORTED');
} catch (err) {
  fail++; console.log('  ✗ DB part crashed —', err.stack || err.message);
} finally {
  // cleanup + restore exactly the original global config
  try {
    await retryDb(() => prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { mode: origCfg.mode, emergency_stop: origCfg.emergency_stop, emergency_reason: origCfg.emergency_reason, emergency_at: origCfg.emergency_at } }));
    const decIds = (await prisma.ambOperatorDecision.findMany({ where: { OR: [{ store_id: `${T}store` }, { decision_key: { startsWith: T } }] }, select: { id: true } })).map((x) => x.id);
    await prisma.ambAction.deleteMany({ where: { recommendation: { batch_id: { in: decIds.map((i) => `operator-${i}`) } } } }).catch(() => {});
    await prisma.ambRecommendation.deleteMany({ where: { batch_id: { in: decIds.map((i) => `operator-${i}`) } } });
    await prisma.ambOperatorDecision.deleteMany({ where: { id: { in: decIds } } });
    await prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ decision_id: { in: decIds } }, { campaign_id: { startsWith: T } }] } });
    await prisma.ambAlert.deleteMany({ where: { OR: [{ title: { contains: T } }, { message: { contains: T } }, { entity_id: { startsWith: T } }] } });
    await prisma.ambOperatorEvent.deleteMany({ where: { actor_id: null, created_at: { gte: __testStart } } });
    await prisma.aiAuditLog.deleteMany({ where: { kind: { startsWith: 'OPERATOR_' }, actor_id: null, created_at: { gte: __testStart } } });
    await prisma.ambOperatorRule.deleteMany({ where: { name: { startsWith: T } } });
    await prisma.ambOperatorException.deleteMany({ where: { scope_id: { startsWith: T } } });
    await prisma.ambOperatorProductConfig.deleteMany({ where: { store_id: `${T}store` } });
    await prisma.ambOperatorCampaignTag.deleteMany({ where: { ad_account_id: `${T}acc` } });
    await prisma.aiAuditLog.deleteMany({ where: { kind: { startsWith: 'OPERATOR_' }, created_at: { gte: new Date(Date.now() - 30 * 60_000) }, input_json: { contains: T } } }).catch(() => {});
    const left = await prisma.ambOperatorDecision.count({ where: { store_id: `${T}store` } });
    const cfgAfter = await S.getOperatorConfig();
    ok('cleanup: no disposable rows left + global config restored exactly', left === 0 && cfgAfter.mode === origCfg.mode && cfgAfter.emergency_stop === origCfg.emergency_stop, `left=${left} mode=${cfgAfter.mode}`);
  } catch (e) { fail++; console.log('  ✗ cleanup failed —', e.message); }
}

// =====================================================================================================================
if (!process.argv.includes('--skip-world')) {
  console.log('\nC. real engine over the real synced world — READ ONLY (persist=false)');
  try {
    const cnt = async () => (await prisma.ambOperatorDecision.count()) + (await prisma.ambAction.count()) + (await prisma.ambRecommendation.count());
    const before = await cnt();
    const cfg = await S.getOperatorConfig();
    const draft = [
      { id: -1, name: 'sim pause', enabled: true, mode: 'AUTOPILOT', window: 'today', action: 'PAUSE', priority: 10, cooldown_hours: 12, scope: {}, store_id: null, conditions: { all: [{ field: 'spend', op: '>=', value: 180 }, { field: 'purchases', op: '=', value: 0 }, { field: 'campaign_status', op: '=', value: 'ACTIVE' }, { field: 'campaign_tag', op: '!=', value: 'TESTING' }] } },
      { id: -2, name: 'sim open', enabled: true, mode: 'APPROVAL', window: 'last14', action: 'OPEN', priority: 20, cooldown_hours: 24, scope: {}, store_id: null, conditions: { all: [{ field: 'cpa', op: 'between', value: [1, 150] }, { field: 'stock', op: '>', value: 20 }, { field: 'profit_state', op: 'in', value: ['PROFITABLE', 'MARGIN_THIN'] }, { field: 'campaign_status', op: '=', value: 'PAUSED' }] } },
    ];
    const res = await E.evaluateOperator({ rules: draft, persist: false });
    ok(`evaluated ${res.campaignsEvaluated} campaigns / ${res.candidates.length} candidates in ${res.ms}ms`, res.campaignsEvaluated > 0 || !res.world.adAccountId);
    ok('persist=false wrote NOTHING (decisions/actions/recommendations unchanged)', (await cnt()) === before);
    if (cfg.mode === 'SHADOW' || cfg.mode === 'OFF') ok(`mode ${cfg.mode}: no candidate is executable (wouldBe is SHADOW/BLOCKED only)`, res.candidates.every((x) => ['SHADOW', 'BLOCKED'].includes(x.wouldBe)), JSON.stringify([...new Set(res.candidates.map((x) => x.wouldBe))]));
    ok('every OPEN candidate carries a stock/economics/mapping/data reason when those are unknown (no silent pass)', res.candidates.filter((x) => x.action === 'OPEN' && x.wouldBe !== 'BLOCKED').every((x) => x.evidence.stock && x.evidence.stock.status !== 'STOCK_UNKNOWN' && x.evidence.economics?.complete));
    ok('every candidate has an explanation (what/why)', res.candidates.every((x) => x.why && x.why.what && x.why.why));
    ok('no candidate leaks another store (store always resolved or blocked)', res.candidates.every((x) => x.store || x.wouldBe === 'BLOCKED'));
    const exec = res.candidates.filter((x) => x.canAutoExecute);
    ok('no auto-executable candidate while ambAllow* switches are OFF', exec.length === 0 || (await (await imp('../services/amb/settings.js')).getAmbSettings()).ambAllowAutoPause === true, `autoExecutable=${exec.length}`);
  } catch (err) { fail++; console.log('  ✗ world part crashed —', err.stack || err.message); }
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
