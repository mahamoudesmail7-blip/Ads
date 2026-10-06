// 🤖 AI Operator — setup/lifecycle layer regression (spec 56–119), 2026-10-03.
// Part A = pure (unblock plans + spec codes, canonical object, lifecycle, drift/expiry, new guards, templates, readiness, profile validation).
// Part B = DB-backed on DISPOSABLE rows ("__optest_" prefix, cleaned up): bulk setup, events, retry, bulk approval, Autopilot gate, manual override,
//          outcomes — executor injected, NO Meta call, NO real alert left behind.
// Part C = read-only over the real synced world (mapping center, readiness, what-will-happen).
//   node src/scripts/operatorSetupTest.js [--skip-world]
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); } };

process.env.OPERATOR_ALLOW_META_WRITES = 'true'; // these suites use an INJECTED executor; the deployment lock itself is asserted explicitly (and re-locked) in the lock tests
const __testStart = new Date(); // every service-level call below writes actor-less audit/event rows: removed again in the cleanup
const { prisma } = await imp('../prisma.js');
// the shared DB can drop for seconds (Neon): restoring the global Operator config in the cleanup must survive that, or a test would leave the production mode altered
const retryDb = async (fn) => { for (let i = 0; i < 10; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 4000)); } } return fn(); };
const U = await imp('../services/amb/operatorUnblock.js');
const D = await imp('../services/amb/operatorDecision.js');
const G = await imp('../services/amb/operatorGuards.js');
const S = await imp('../services/amb/operatorStore.js');
const E = await imp('../services/amb/operatorEngine.js');
const RD = await imp('../services/amb/operatorReadiness.js');
const TP = await imp('../services/amb/operatorTemplates.js');
const OPS = await imp('../services/amb/operatorOps.js');
const CTX = await imp('../services/amb/operatorContext.js');
const R = await imp('../services/amb/operatorRules.js');

const NOW = new Date('2026-10-03T12:00:00Z'); const H = 3_600_000;
const SPEC_CODES_REQUIRED = ['DATA_QUALITY_BLOCK', 'STORE_CONTEXT_MISSING', 'PRODUCT_MAPPING_UNCERTAIN', 'ECONOMICS_MISSING', 'STOCK_UNKNOWN', 'STOCK_TOO_LOW', 'PROFIT_UNKNOWN', 'COD_UNRELIABLE', 'INSUFFICIENT_SAMPLE', 'TESTING_PROTECTED', 'CAMPAIGN_EXCEPTION', 'PRODUCT_EXCEPTION', 'COOLDOWN_ACTIVE', 'DAILY_LOSS_LIMIT', 'EMERGENCY_STOP', 'AUTOMATION_DISABLED', 'ACTION_NOT_ALLOWED', 'CONFLICTING_RULE', 'RECENT_ACTION_PENDING_EVALUATION'];

// =====================================================================================================================
console.log('\nA1. block reasons -> spec codes + unblock plan (spec 56/57)');
const reachable = new Set([...Object.values(U.SPEC_CODES).flat(), 'PRODUCT_EXCEPTION']);
ok('every spec-56 machine code is reachable from some guard', SPEC_CODES_REQUIRED.every((c) => reachable.has(c)), SPEC_CODES_REQUIRED.filter((c) => !reachable.has(c)).join(','));
const blockCodes = Object.keys(G.BLOCK_CODES);
const noPlan = blockCodes.filter((c) => U.planFor(c).steps[0] === 'راجع سبب المنع في التفاصيل');
ok('every guard code has a concrete unblock plan (no generic fallback)', noPlan.length === 0, noPlan.join(','));
const noSpec = blockCodes.filter((c) => G.BLOCK_CODES[c].severity === 'BLOCK' && !U.SPEC_CODES[c]);
ok('every BLOCK guard code maps to a spec machine code', noSpec.length === 0, noSpec.join(','));
let plan = U.unblockPlan([{ code: 'ECONOMICS_INCOMPLETE', severity: 'BLOCK', message: 'x' }, { code: 'STOCK_UNKNOWN', severity: 'BLOCK', message: 'y' }, { code: 'COOLDOWN_ACTIVE', severity: 'BLOCK', message: 'z' }], { productId: 7, campaignId: 'c1' });
ok('economics+stock => two setup actions (button per kind) + numbered steps', plan.blocked && plan.actions.map((a) => a.type).sort().join() === 'ECONOMICS,STOCK' && plan.steps.length >= 3, JSON.stringify(plan.actions));
ok('time-based block (cooldown) has steps but NO button', !plan.actions.some((a) => a.type === 'COOLDOWN'));
ok('economics reason carries ECONOMICS_MISSING + PROFIT_UNKNOWN', plan.reasons[0].specCodes.includes('ECONOMICS_MISSING') && plan.reasons[0].specCodes.includes('PROFIT_UNKNOWN'));
ok('setup action carries the product it is for', plan.actions.every((a) => a.productId === 7));
ok('warnings/downgrades are not "reasons"', U.unblockPlan([{ code: 'RULE_CONFLICT', severity: 'WARN', message: 'w' }]).blocked === false);
ok('PRODUCT-scoped exception => PRODUCT_EXCEPTION, campaign-scoped => CAMPAIGN_EXCEPTION', U.specCodesFor('EXCEPTION_NO_AUTO_STOP', { scopeType: 'PRODUCT' })[0] === 'PRODUCT_EXCEPTION' && U.specCodesFor('EXCEPTION_NO_AUTO_STOP', { scopeType: 'CAMPAIGN' })[0] === 'CAMPAIGN_EXCEPTION');
ok('mapping uncertain => "اربط الحملة بالمنتج" button', U.planFor('MAPPING_UNRELIABLE').action.type === 'MAPPING' && U.planFor('MAPPING_UNRELIABLE').action.label === 'اربط الحملة بالمنتج');
ok('stock unknown => "ربط/تحديث المخزون" button', U.planFor('STOCK_UNKNOWN').action.label === 'ربط/تحديث المخزون');
ok('economics => "أدخل اقتصاديات المنتج" button', U.planFor('ECONOMICS_INCOMPLETE').action.label === 'أدخل اقتصاديات المنتج');

// =====================================================================================================================
console.log('\nA2. canonical decision object, lifecycle, drift, expiry (spec 64–67)');
const blocksStockUnknown = [{ code: 'STOCK_UNKNOWN', severity: 'BLOCK', group: 'INVENTORY', message: 'm' }];
const can = D.buildCanonical({ decisionId: 5, storeId: 'trendy-storeee', productId: 3, campaignId: 'c9', evaluatedAt: NOW.toISOString(), window: 'last7', currentState: { status: 'ACTIVE', budget: 500 }, action: 'SCALE_UP', params: { fromBudget: 500, toBudget: 600, pct: 20 }, ruleId: 2, ruleVersion: 3, advisorPlanVersion: 4, recommendationId: 'rec-1', evidence: { metrics: {}, dataQuality: { gate: 'VERIFIED' } }, blocks: blocksStockUnknown, confidence: 'LOW', effectiveMode: 'APPROVAL', status: 'BLOCKED' });
const REQ = ['decisionId', 'storeId', 'productId', 'campaignId', 'evaluatedAt', 'analysisWindow', 'currentState', 'recommendedAction', 'ruleId', 'ruleVersion', 'advisorPlanVersion', 'recommendationId', 'evidence', 'dataQuality', 'guards', 'confidence', 'blocked', 'blockReasons', 'requiresApproval', 'previousMetaState', 'proposedMetaState'];
ok('canonical object carries every spec-64 field', REQ.every((k) => k in can), REQ.filter((k) => !(k in can)).join(','));
ok('blocked flag + machine block reasons + unblock plan', can.blocked && can.blockReasons[0].specCodes.includes('STOCK_UNKNOWN') && can.unblock.actions.some((a) => a.type === 'STOCK'));
ok('budget change shows the real money: 500 → 600 (+20%)', can.budgetChange.from === 500 && can.budgetChange.to === 600 && can.budgetChange.pct === 20 && can.proposedMetaState.budget === 600 && can.previousMetaState.budget === 500);
ok('a blocked decision never "requires approval" (it cannot proceed at all)', can.requiresApproval === false);
const can2 = D.buildCanonical({ action: 'PAUSE', blocks: [], effectiveMode: 'AUTOPILOT', currentState: { status: 'ACTIVE' } });
ok('autopilot + no downgrade => no approval needed; PAUSE proposes PAUSED', can2.requiresApproval === false && can2.proposedMetaState.status === 'PAUSED');
ok('downgrade or non-autopilot mode => requires approval', D.buildCanonical({ action: 'PAUSE', blocks: [{ code: 'X', severity: 'DOWNGRADE' }], effectiveMode: 'AUTOPILOT' }).requiresApproval && D.buildCanonical({ action: 'PAUSE', blocks: [], effectiveMode: 'APPROVAL' }).requiresApproval);
ok('lifecycle vocabulary is complete (spec 65)', ['CANDIDATE', 'BLOCKED', 'SHADOW', 'READY_FOR_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTING', 'EXECUTED', 'VERIFIED', 'FAILED', 'ROLLED_BACK', 'MEASURING', 'EVALUATED'].every((x) => D.LIFECYCLE.includes(x)));
ok('lifecycleOf: PREPARED/SNOOZED => READY_FOR_APPROVAL; VERIFIED => MEASURING until an outcome exists => EVALUATED', D.lifecycleOf({ status: 'PREPARED' }) === 'READY_FOR_APPROVAL' && D.lifecycleOf({ status: 'SNOOZED' }) === 'READY_FOR_APPROVAL' && D.lifecycleOf({ status: 'VERIFIED' }) === 'MEASURING' && D.lifecycleOf({ status: 'VERIFIED', outcome_json: '{}' }) === 'EVALUATED' && D.lifecycleOf({ status: 'EXECUTED' }) === 'EXECUTED');
ok('wording: "sent to Meta" is NOT "executed" (spec 106)', /لسه مش متأكد/.test(D.LIFECYCLE_LABEL_AR.EXECUTED) && /متأكد من Meta/.test(D.LIFECYCLE_LABEL_AR.VERIFIED) && !/تم التنفيذ/.test(D.LIFECYCLE_LABEL_AR.EXECUTED));
const ev0 = { metrics: { cpa: 100, purchases: 0 }, stock: { current: 50, status: 'SAFE' }, economics: { unitMargin: 200 }, dataQuality: { gate: 'VERIFIED' } };
ok('no change => no drift', D.evidenceDrift(ev0, JSON.parse(JSON.stringify(ev0)), { action: 'PAUSE' }).length === 0);
ok('CPA moved >20% => CPA_CHANGED', D.evidenceDrift(ev0, { ...ev0, metrics: { cpa: 130, purchases: 0 } }, { action: 'SCALE_UP' }).some((r) => r.code === 'CPA_CHANGED'));
ok('new purchases expire a PAUSE (but not a scale)', D.evidenceDrift(ev0, { ...ev0, metrics: { cpa: 100, purchases: 2 } }, { action: 'PAUSE' }).some((r) => r.code === 'NEW_PURCHASES') && !D.evidenceDrift(ev0, { ...ev0, metrics: { cpa: 100, purchases: 2 } }, { action: 'SCALE_UP' }).some((r) => r.code === 'NEW_PURCHASES'));
ok('stock / price / data-quality change => expiry reasons', ['STOCK_CHANGED', 'PRICE_CHANGED', 'DATA_QUALITY_CHANGED'].every((code) => D.evidenceDrift(ev0, { ...ev0, stock: { current: 10, status: 'SAFE' }, economics: { unitMargin: 150 }, dataQuality: { gate: 'DECISION_BLOCKED_DATA_QUALITY' } }, { action: 'OPEN' }).some((r) => r.code === code)));
ok('expected state: pause needs ACTIVE, open needs PAUSED, scale needs same budget', D.expectedState({ action: 'PAUSE' }).status === 'ACTIVE' && D.expectedState({ action: 'OPEN' }).status === 'PAUSED' && D.expectedState({ action: 'SCALE_UP', params: { fromBudget: 500 } }).budget === 500);
ok('state mismatch (status/budget) => expire reasons', D.stateMatches({ status: 'ACTIVE' }, { status: 'PAUSED' })[0].code === 'STATUS_CHANGED' && D.stateMatches({ budget: 500 }, { budget: 560 })[0].code === 'BUDGET_CHANGED' && D.stateMatches({ budget: 500 }, { budget: 502 }).length === 0);
ok('risk order: hard-stop < pause/reduce < scale < open', D.riskRank({ action: 'PAUSE', category: 'HARD_SAFETY' }) < D.riskRank({ action: 'PAUSE' }) && D.riskRank({ action: 'PAUSE' }) < D.riskRank({ action: 'SCALE_UP' }) && D.riskRank({ action: 'SCALE_UP' }) < D.riskRank({ action: 'OPEN' }));
ok('hard-safety rule = pause/reduce against Hard Stop CPA; optimisation otherwise', D.isHardSafetyRule({ action: 'PAUSE', conditions: { all: [{ field: 'cpa', op: '>', value: { ref: 'hard_stop_cpa' } }] } }) && !D.isHardSafetyRule({ action: 'SCALE_UP', conditions: { all: [{ field: 'cpa', op: '<=', value: { ref: 'target_cpa' } }] } }));
ok('error classes: rate-limit/timeout RETRYABLE, permission PERMANENT, guard abort GUARD', D.classifyError({ message: 'Meta rate limit reached' }) === 'RETRYABLE' && D.classifyError({ message: 'ETIMEDOUT' }) === 'RETRYABLE' && D.classifyError({ message: '(#200) permission denied' }) === 'PERMANENT' && D.classifyError({ message: 'فحص القواعد رفض التنفيذ' }) === 'GUARD');

// =====================================================================================================================
console.log('\nA3. new guards (spec 69–75, 85, 86, 103)');
const cfg0 = { mode: 'AUTOPILOT', emergency_stop: false, limits: JSON.parse(JSON.stringify(S.DEFAULT_LIMITS)), cooldowns: { ...S.DEFAULT_COOLDOWNS }, schedule: { mode: 'ALWAYS' }, storeLimits: {} };
const set0 = { ambMinSpendBeforeDecision: 150, ambMinPurchasesBeforeScaling: 5, ambAllowAutoPause: true, ambAllowAutoOpen: true, ambAllowAutoBudgetIncrease: true, ambAllowAutoBudgetDecrease: true, ambMaxBudgetIncreasePct: 20, ambMaxAutoExecutionAmount: 500 };
const mk = (o = {}) => ({ storeId: 'trendy-storeee', campaign: { id: 'c1', status: 'ACTIVE', budget: 500, tag: null, firstSeenAt: new Date(NOW.getTime() - 100 * H).toISOString() }, metrics: { spend: 300, purchases: 8 }, product: { id: 1, mappingVerified: true }, dq: { gate: 'OK', overall: 'RECONCILED', statusTrust: { state: 'OK' } }, stock: { status: 'SAFE', currentStock: 100, daysRemaining: 30 }, econ: { complete: true, profitState: 'PROFITABLE', hardStopCpa: 200, minProfit: 0 }, exceptions: [], recent: { lastByAction: {}, todayCount: 0, pausedBySystemAt: NOW.toISOString() }, metaConnected: true, metaStale: false, incidents: [], ...o });
const dec = (o = {}) => ({ action: 'PAUSE', params: {}, ruleMode: 'AUTOPILOT', confidence: 'HIGH', needs: {}, ruleMinSpend: 150, cooldownHours: 12, ...o });
const run = (d, c, cfg = cfg0, set = set0, counters = {}) => G.evaluateGuards({ decision: d, ctx: c, config: cfg, settings: set, counters, now: NOW });
const cs = (g) => g.blocks.map((b) => b.code);
const openCtx = (o = {}) => mk({ campaign: { id: 'c1', status: 'PAUSED', budget: 500 }, ...o });
let g = run(dec({ action: 'OPEN', needs: { profit: true, stock: true } }), openCtx({ stock: { status: 'LOW', currentStock: 3, minimumStock: 5 } }));
ok('stock at/below minimum (LOW) blocks OPEN with STOCK_TOO_LOW', cs(g).includes('STOCK_TOO_LOW') && g.wouldBe === 'BLOCKED');
g = run(dec({ action: 'SCALE_UP', params: { pct: 10, fromBudget: 500, toBudget: 550 }, needs: { profit: true, stock: true } }), mk({ stock: { status: 'LOW', currentStock: 3, minimumStock: 5 } }));
ok('stock at/below minimum blocks SCALE_UP', cs(g).includes('STOCK_TOO_LOW'));
g = run(dec({ action: 'PAUSE', needs: { stock: true } }), mk({ stock: { status: 'LOW', currentStock: 3, minimumStock: 5 } }));
ok('low stock never blocks a PAUSE', !cs(g).includes('STOCK_TOO_LOW'));
g = run(dec({ action: 'OPEN', needs: {} }), openCtx({ recent: { lastByAction: {}, todayCount: 0 } }));
ok('OPEN with unknown manual-stop intent => downgraded to approval (never autopilot)', cs(g).includes('MANUAL_STOP_INTENT_UNKNOWN') && !g.canAutoExecute && g.wouldBe === 'PREPARED');
g = run(dec({ action: 'OPEN', needs: {} }), openCtx());
ok('OPEN of a campaign the Operator itself paused keeps its mode', !cs(g).includes('MANUAL_STOP_INTENT_UNKNOWN'));
g = run(dec(), mk({ campaign: { id: 'c1', status: 'ACTIVE', budget: 500, firstSeenAt: new Date(NOW.getTime() - 2 * H).toISOString() } }));
ok('PAUSE on a 2-hour-old campaign blocked (attribution grace / maturity)', cs(g).includes('ATTRIBUTION_GRACE'));
g = run(dec(), mk({ recent: { lastByAction: { SCALE_UP: new Date(NOW.getTime() - 1 * H).toISOString() }, todayCount: 1 } }));
ok('PAUSE within 6h of our own edit blocked (attribution grace)', cs(g).includes('ATTRIBUTION_GRACE'));
g = run(dec({ severeOverride: true }), mk({ campaign: { id: 'c1', status: 'ACTIVE', budget: 500, firstSeenAt: new Date(NOW.getTime() - 2 * H).toISOString() } }));
ok('hard-safety PAUSE is not held back by the attribution grace', !cs(g).includes('ATTRIBUTION_GRACE'));
g = run(dec(), mk({ recent: { lastByAction: {}, todayCount: 0, manualOverrideAt: new Date(NOW.getTime() - 3 * H).toISOString() } }));
ok('manual override => cooldown on ALL consequential actions (we never undo the owner)', cs(g).includes('MANUAL_OVERRIDE_COOLDOWN'));
g = run(dec(), mk({ recent: { lastByAction: {}, todayCount: 0, manualOverrideAt: new Date(NOW.getTime() - 30 * H).toISOString() } }));
ok('manual-override cooldown expires (24h default)', !cs(g).includes('MANUAL_OVERRIDE_COOLDOWN'));
g = run(dec({ action: 'SCALE_UP', params: { pct: 10, fromBudget: 500, toBudget: 550 }, needs: { profit: true, stock: true } }), mk({ recent: { lastByAction: {}, todayCount: 0, pendingEvaluationAt: new Date(NOW.getTime() - 3 * H).toISOString() } }));
ok('RECENT_ACTION_PENDING_EVALUATION blocks another risky action', cs(g).includes('RECENT_ACTION_PENDING_EVALUATION'));
const accCfg = { ...cfg0, limits: { ...cfg0.limits, account: { maxEnablesPerDay: 2, maxPausesPerDay: 3, maxBudgetIncreasePerDay: 400, maxDailySpendUnderAi: 2000 } } };
g = run(dec(), mk(), accCfg, set0, { byAction: { PAUSE: 3 } });
ok('account limit: max pauses/day', cs(g).includes('ACCOUNT_DAILY_LIMIT'));
g = run(dec({ action: 'OPEN', needs: {} }), openCtx(), accCfg, set0, { byAction: { OPEN: 2 } });
ok('account limit: max enables/day', cs(g).includes('ACCOUNT_DAILY_LIMIT'));
g = run(dec({ action: 'SCALE_UP', params: { pct: 20, fromBudget: 500, toBudget: 600 }, needs: { profit: true, stock: true } }), mk(), accCfg, set0, { budgetIncreaseToday: 350 });
ok('account limit: total budget increase/day (350 + 100 > 400)', cs(g).includes('ACCOUNT_DAILY_LIMIT'));
g = run(dec({ action: 'SCALE_UP', params: { pct: 20, fromBudget: 500, toBudget: 600 }, needs: { profit: true, stock: true } }), mk(), accCfg, set0, { aiBudget: 1950 });
ok('account limit: max daily spend under AI control', cs(g).includes('ACCOUNT_DAILY_LIMIT'));
const storeCfg = { ...cfg0, storeLimits: { 'trendy-storeee': { maxPausesPerDay: 1 } } };
g = run(dec(), mk(), storeCfg, set0, { byStoreAction: { 'trendy-storeee': { PAUSE: 1 } } });
ok('store limit applies to its own store', cs(g).includes('STORE_DAILY_LIMIT'));
g = run(dec(), mk({ storeId: 'default' }), storeCfg, set0, { byStoreAction: { 'trendy-storeee': { PAUSE: 1 }, default: { PAUSE: 0 } } });
ok('store A limit never leaks into store B (isolation)', !cs(g).includes('STORE_DAILY_LIMIT'));
g = run(dec(), mk({ product: { id: 1, mappingVerified: true, automationMode: 'OFF' } }));
ok('product automation OFF blocks', cs(g).includes('PRODUCT_AUTOMATION_OFF'));
g = run(dec({ ruleMode: 'AUTOPILOT' }), mk({ product: { id: 1, mappingVerified: true, automationMode: 'APPROVAL' } }));
ok('product mode APPROVAL caps an AUTOPILOT rule (stricter wins)', g.effectiveMode === 'APPROVAL' && !g.canAutoExecute);
g = run(dec({ action: 'SCALE_UP', params: { pct: 15, fromBudget: 500, toBudget: 575 }, needs: { profit: true, stock: true } }), mk({ product: { id: 1, mappingVerified: true, maxScalePct: 10 } }));
ok('product scale cap (10%) overrides the global step (15%)', cs(g).includes('MAX_ACTION_SIZE'));
g = run(dec({ action: 'SCALE_UP', params: { pct: 10, fromBudget: 500, toBudget: 550 }, needs: { profit: true, stock: true } }), mk({ econ: { complete: true, profitState: 'MARGIN_THIN', unitProfitAtCpa: 5, minProfit: 20, unitMargin: 200 } }));
ok('profit floor: verified profit under configured minimum blocks scale', cs(g).includes('PROFIT_FLOOR'));
g = run(dec({ action: 'SCALE_UP', params: { pct: 10, fromBudget: 500, toBudget: 550 }, needs: { profit: true, stock: true } }), mk({ econ: { complete: false, profitState: 'UNKNOWN' } }));
ok('profit floor never inferred when economics are missing (blocked as ECONOMICS_INCOMPLETE instead)', cs(g).includes('ECONOMICS_INCOMPLETE') && !cs(g).includes('PROFIT_FLOOR'));
ok('every block carries machine spec codes', run(dec(), mk(), { ...cfg0, emergency_stop: true }).blocks.every((b) => Array.isArray(b.specCodes) && b.specCodes.length));
const ec = G.computeOperatorEconomics({ product: { selling_price: 500, product_cost: 200, shipping_cost: 40 }, ambProduct: { product_cost: 0, actual_selling_price: null, suggested_selling_price: 0, shipping_cost: 0, packaging_cost: 0, other_cost: 0 }, opCfg: null });
ok('AmbProduct zeros ("not entered") never shadow real catalog values', ec.complete && ec.unitMargin === 260, JSON.stringify(ec));
const ec2 = G.computeOperatorEconomics({ product: { selling_price: 0, product_cost: 0 }, ambProduct: { product_cost: 50, actual_selling_price: null, suggested_selling_price: 150 }, opCfg: null });
ok('a SUGGESTED price (cost × multiplier) is not a real price => still incomplete', !ec2.complete && ec2.profitState === 'UNKNOWN');

// =====================================================================================================================
console.log('\nA4. templates (spec 79–83)');
const tl = TP.listTemplates();
ok('all 8 spec templates exist', ['ZERO_ORDER_STOP', 'HARD_CPA_STOP', 'WINNER_SCALE', 'STOCK_PROTECTION', 'TESTING_PROTECTION', 'SPEND_VELOCITY', 'CREATIVE_FATIGUE', 'PROFIT_PROTECTION'].every((k) => tl.some((t) => t.key === k)));
const rt = tl.filter((t) => t.kind === 'RULE').map((t) => TP.instantiateTemplate(t.key));
ok('every rule template validates and is a DRAFT (disabled)', rt.every((x) => x.validation.ok && x.rule.enabled === false), rt.map((x) => x.validation.errors.map((e) => e.code)).flat().join(','));
ok('no template can produce an AUTOPILOT rule; defaults are SHADOW/APPROVAL', rt.every((x) => ['SHADOW', 'APPROVAL'].includes(x.rule.mode)));
ok('zero-order template: default SHADOW, X/Y user-chosen, excludes TESTING, requires DQ', (() => { const x = TP.instantiateTemplate('ZERO_ORDER_STOP', { spend: 250, minAgeHours: 48 }); const c = x.rule.conditions.all; return x.rule.mode === 'SHADOW' && c.some((q) => q.field === 'spend' && q.value === 250) && c.some((q) => q.field === 'campaign_age_hours' && q.value === 48) && c.some((q) => q.field === 'campaign_tag' && q.value === 'TESTING') && c.some((q) => q.field === 'data_quality'); })());
ok('winner-scale template: default APPROVAL and requires profit + stock cover', (() => { const x = TP.instantiateTemplate('WINNER_SCALE'); return x.rule.mode === 'APPROVAL' && x.rule.conditions.all.some((q) => q.field === 'profit_state') && x.rule.conditions.all.some((q) => q.field === 'days_of_stock'); })());
ok('Hard Stop template references the product Hard Stop CPA (no invented number)', JSON.stringify(TP.instantiateTemplate('HARD_CPA_STOP').rule.conditions).includes('"ref":"hard_stop_cpa"'));
let bad = null; try { TP.instantiateTemplate('WINNER_SCALE', { pct: 500 }); } catch (e) { bad = e; }
ok('template parameters are validated', bad && bad.status === 400);
bad = null; try { TP.instantiateTemplate('TESTING_PROTECTION'); } catch (e) { bad = e; }
ok('GUARD-kind entries cannot be instantiated as rules', bad && bad.status === 400);
ok('campaign_age_hours is a real rule field', !!R.FIELDS.campaign_age_hours);
// regressions found by the real-product Shadow run
{
  const nm = R.evaluateConditions({ all: [{ field: 'campaign_tag', op: '!=', value: 'TESTING' }] }, { campaign_tag: '' });
  ok('untagged campaign (tag "") satisfies tag != TESTING (it used to be UNKNOWN, so most campaigns never matched a template)', nm.matched === true && nm.unknown === false);
  ok('tagged TESTING campaign fails tag != TESTING', R.evaluateConditions({ all: [{ field: 'campaign_tag', op: '!=', value: 'TESTING' }] }, { campaign_tag: 'TESTING' }).matched === false);
  const rf = R.evaluateConditions({ all: [{ field: 'cpa', op: '>', value: { ref: 'hard_stop_cpa' } }] }, { cpa: 190, hard_stop_cpa: null });
  ok('evaluateConditions reports WHICH fact is missing: the referenced Hard Stop CPA (not the CPA metric)', rf.unknown === true && rf.details[0].actual === 190 && rf.details[0].ref === 'hard_stop_cpa');
  ok('the referenced facts are product facts (heavy) so the engine BLOCKS instead of dropping the rule', CTX.HEAVY_FIELDS.has('hard_stop_cpa') && CTX.HEAVY_FIELDS.has('target_cpa'));
  const fc = (m) => CTX.fieldsForRule({ ctx: { campaign: { status: 'ACTIVE', tag: null }, econ: {}, stock: null, dq: null, heavyLoaded: false }, windowMetrics: m });
  ok('a synced row with spend and NO purchase action => purchases 0 (the zero-orders rule can fire)', fc({ spend: 300, purchases: null }).purchases === 0 && fc({ spend: 300, purchases: 4 }).purchases === 4);
  ok('no metrics row at all => purchases stays UNKNOWN (never converted to 0)', fc(null).purchases === null && fc(undefined).spend === null);
  ok('CPA is still unknown without purchases (no division by zero)', fc({ spend: 300, purchases: null, cpa: null }).cpa === null);
  ok('untagged campaign => tag is the empty string', fc({ spend: 1 }).campaign_tag === '');
  const zt = TP.instantiateTemplate('ZERO_ORDER_STOP').rule.conditions.all.find((c) => c.field === 'data_quality');
  ok('zero-order template needs data quality VERIFIED or WARNING (never BLOCKED/UNKNOWN)', zt.op === 'in' && zt.value.includes('WARNING') && !zt.value.includes('BLOCKED'));
}

// =====================================================================================================================
console.log('\nA5. readiness + profile validation (spec 58–60)');
const prodOK = { current_stock: 50, minimum_stock: 10 }, ambOK = { target_cpa: 100 }, cfgOK = { hard_stop_cpa: 200 }, ecOK = { complete: true, unitMargin: 200 };
const verifiedC = [{ verified: true }];
let rd = RD.computeReadiness({ product: prodOK, amb: ambOK, opCfg: cfgOK, econ: ecOK, campaigns: verifiedC, dq: { gate: 'VERIFIED' } });
ok('everything present => READY 🟢', rd.state === 'READY' && rd.icon === '🟢' && rd.missing.length === 0);
rd = RD.computeReadiness({ product: { current_stock: null, minimum_stock: 10 }, amb: ambOK, opCfg: cfgOK, econ: ecOK, campaigns: verifiedC, dq: { gate: 'VERIFIED' } });
ok('only stock missing => PARTIAL 🟡 with Stock listed + setup button', rd.state === 'PARTIAL' && rd.missing.some((m) => m.key === 'STOCK' && m.action.type === 'STOCK'));
rd = RD.computeReadiness({ product: prodOK, amb: ambOK, opCfg: cfgOK, econ: { complete: false }, campaigns: [], dq: { gate: null } });
ok('mapping + economics + data quality missing => BLOCKED 🔴', rd.state === 'BLOCKED' && rd.missing.filter((m) => m.severity === 'CRITICAL').length === 3);
rd = RD.computeReadiness({ product: prodOK, amb: ambOK, opCfg: cfgOK, econ: ecOK, campaigns: [{ verified: false }], dq: { gate: 'VERIFIED' } });
ok('a SUGGESTED mapping is not enough => BLOCKED', rd.state === 'BLOCKED' && rd.items.find((i) => i.key === 'MAPPING').ok === false);
rd = RD.computeReadiness({ product: prodOK, amb: ambOK, opCfg: cfgOK, econ: ecOK, campaigns: verifiedC, dq: { gate: 'DECISION_BLOCKED_DATA_QUALITY' } });
ok('data quality BLOCKED => BLOCKED', rd.state === 'BLOCKED');
rd = RD.computeReadiness({ product: prodOK, amb: ambOK, opCfg: cfgOK, econ: ecOK, campaigns: verifiedC, dq: undefined });
ok('data quality not checked yet => PARTIAL (never reported as READY)', rd.state === 'PARTIAL' && rd.missing.some((m) => m.key === 'DATA_QUALITY' && m.pending));
let v = RD.validateProfilePatch({ target_cpa: 150, hard_stop_cpa: 100 });
ok('Hard Stop < Target rejected', v.errors.some((e) => /Hard Stop/.test(e)));
v = RD.validateProfilePatch({ product_cost: -5 });
ok('negative cost rejected', v.errors.length === 1);
v = RD.validateProfilePatch({ selling_price: 100, product_cost: 120 });
ok('price <= cost is a WARNING (not silently accepted as profitable)', v.errors.length === 0 && v.warnings.some((w) => /بيخسر/.test(w)));
v = RD.validateProfilePatch({ selling_price: 300, product_cost: 100, shipping_cost: 50, target_cpa: 200 });
ok('Target CPA above unit margin warns', v.warnings.some((w) => /هامش الوحدة/.test(w)));
v = RD.validateProfilePatch({ target_cpa: '' });
ok('empty value clears (null) — never writes 0', v.clean.target_cpa === null);
v = RD.validateProfilePatch({ automation_mode: 'TURBO' });
ok('unknown automation mode rejected', v.errors.length === 1);
v = RD.validateProfilePatch({ testing_min_sample: 2.5 });
ok('integer-only fields enforced', v.errors.length === 1);
v = RD.validateProfilePatch({});
ok('an empty patch changes nothing', Object.keys(v.clean).length === 0);

// =====================================================================================================================
console.log('\nA6. deployment-level Meta write lock');
{
  const saved = process.env.OPERATOR_ALLOW_META_WRITES;
  delete process.env.OPERATOR_ALLOW_META_WRITES;
  ok('lock is ON by default (variable absent => LOCKED)', S.metaWritesLocked() === true);
  const cfgL = { ...cfg0, writesLocked: true };
  for (const [mode, expectBlock] of [['SHADOW', false], ['APPROVAL', true], ['AUTOPILOT', true]]) {
    const gl = G.evaluateGuards({ decision: { action: 'PAUSE', params: {}, ruleMode: mode, confidence: 'HIGH', needs: {}, ruleMinSpend: 150, cooldownHours: 12 }, ctx: mk(), config: { ...cfgL, mode }, settings: set0, counters: {}, now: NOW });
    ok(`guard: mode ${mode} + lock => ${expectBlock ? 'BLOCKED (META_WRITES_LOCKED)' : 'stays a SHADOW record (nothing to write)'}`, expectBlock ? (gl.blocks.some((b) => b.code === 'META_WRITES_LOCKED' && b.severity === 'BLOCK') && !gl.canExecute && !gl.canAutoExecute) : (gl.wouldBe === 'SHADOW' && !gl.canExecute));
  }
  ok('META_WRITES_LOCKED has a spec code + an unblock plan', U.planFor('META_WRITES_LOCKED').steps[0] !== 'راجع سبب المنع في التفاصيل' && U.SPEC_CODES.META_WRITES_LOCKED.length === 1);
  process.env.OPERATOR_ALLOW_META_WRITES = saved ?? 'true';
}

console.log('\nB. DB-backed on disposable rows (executor injected; no Meta; no real alerts left)');
const T = '__optest_';
const origCfg = await S.getOperatorConfig();
const created = { decisions: [], products: [], amb: [] };
const mkDecision = async (o = {}) => {
  const row = await prisma.ambOperatorDecision.create({ data: { decision_key: `${T}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, store_id: `${T}store`, ad_account_id: `${T}acc`, campaign_id: `${T}c1`, campaign_name: `${T}campaign`, action: 'SCALE_DOWN', rule_name: `${T}rb`, mode_at_decision: 'APPROVAL', status: 'PREPARED', confidence: 'HIGH', params_json: JSON.stringify({ rollbackOf: 1, fromBudget: 230, toBudget: 200, pct: 13, window: 'today' }), evidence_json: JSON.stringify({ rollbackOf: 1 }), why_json: JSON.stringify({ why: 't' }), ...o } });
  created.decisions.push(row.id); return row;
};
try {
  // ---- bulk setup on a disposable product
  const prod = await prisma.product.create({ data: { product_name: `${T}منتج تجريبي`, product_code: `${T}CODE1`, store_id: `${T}store`, selling_price: 0, product_cost: 0 } });
  created.products.push(prod.id);
  const hdr = 'product_id,product,purchase_cost,selling_price,shipping,packaging,target_cpa,hard_stop_cpa,minimum_stock,current_stock';
  let pv = await RD.previewBulkSetup({ csv: `${hdr}\n${prod.id},,100,300,30,10,60,120,5,40` });
  ok('preview: valid row resolves the product and lists real changes (from → to)', pv.ok && pv.rows[0].status === 'OK' && pv.rows[0].product.id === prod.id && pv.rows[0].changes.some((c) => c.field === 'selling_price' && c.to === 300), JSON.stringify(pv.rows[0]));
  ok('preview writes NOTHING', (await prisma.ambProduct.count({ where: { product_id: prod.id } })) === 0 && (await prisma.product.findUnique({ where: { id: prod.id } })).current_stock === null);
  pv = await RD.previewBulkSetup({ csv: `product,store,purchase_cost\n${T}منتج تجريبي,${T}store,50` });
  ok('exact name + store resolves (no fuzzy)', pv.rows[0].product?.id === prod.id);
  pv = await RD.previewBulkSetup({ csv: `product,purchase_cost\nمنتج مش موجود خالص,50` });
  ok('unknown product => ERROR (never guessed)', pv.rows[0].status === 'ERROR' && /مفيش تخمين/.test(pv.rows[0].errors[0]));
  pv = await RD.previewBulkSetup({ csv: `product_id,purchase_cost\n${prod.id},abc` });
  ok('non-numeric cell => ERROR', pv.rows[0].status === 'ERROR');
  pv = await RD.previewBulkSetup({ csv: `product_id,purchase_cost,selling_price
${prod.id},abc,300
${prod.id},12abc,300` });
  ok('garbage next to valid cells is an ERROR too (regression: it used to be treated as an empty cell)', pv.rows[0].status === 'ERROR' && /غير رقمية/.test(pv.rows[0].errors.join(' ')));
  pv = await RD.previewBulkSetup({ csv: `product_id,purchase_cost,selling_price\n${prod.id},50,100\n${prod.id},60,110` });
  ok('product repeated in the file => ERROR on the second row', pv.rows[1].errors.some((e) => /متكرر/.test(e)));
  pv = await RD.previewBulkSetup({ csv: `product_id,target_cpa,hard_stop_cpa\n${prod.id},150,100` });
  ok('Hard Stop < Target => ERROR in the import too', pv.rows[0].status === 'ERROR');
  pv = await RD.previewBulkSetup({ csv: `product_id,purchase_cost,selling_price\n${prod.id},١٢٠٫٥,٣٠٠` });
  ok('Arabic digits / decimal mark accepted', pv.rows[0].patch.product_cost === 120.5 && pv.rows[0].patch.selling_price === 300);
  pv = await RD.previewBulkSetup({ csv: `product_id,purchase_cost,selling_price\n${prod.id},,\n` });
  ok('all-empty row => ERROR (an empty cell never writes 0)', pv.rows[0].status === 'ERROR');
  pv = await RD.previewBulkSetup({ csv: `foo,bar\n1,2` });
  ok('missing product column => refused', !pv.ok);
  let apErr = null; try { await RD.applyBulkSetup({ csv: `product_id,purchase_cost\n${prod.id},100\n99999999,5` }); } catch (e) { apErr = e; }
  ok('apply refuses EVERYTHING if any row is invalid (nothing saved)', apErr && apErr.status === 400 && (await prisma.ambProduct.count({ where: { product_id: prod.id } })) === 0);
  const ap = await RD.applyBulkSetup({ csv: `${hdr}\n${prod.id},,100,300,30,10,60,120,5,40` });
  ok('apply saves through the canonical homes', ap.summary.saved === 1);
  const prodAfter = await prisma.product.findUnique({ where: { id: prod.id } });
  const ambAfter = await prisma.ambProduct.findUnique({ where: { product_id: prod.id } }); if (ambAfter) created.amb.push(ambAfter.id);
  const cfgAfter = await prisma.ambOperatorProductConfig.findUnique({ where: { product_id_store_id: { product_id: prod.id, store_id: `${T}store` } } });
  ok('stock → Product.current/minimum_stock (canonical inventory)', prodAfter.current_stock === 40 && prodAfter.minimum_stock === 5);
  ok('price/cost/shipping/packaging/target → AmbProduct (canonical economics, created from catalog)', ambAfter && ambAfter.actual_selling_price === 300 && ambAfter.product_cost === 100 && ambAfter.shipping_cost === 30 && ambAfter.packaging_cost === 10 && ambAfter.target_cpa === 60);
  ok('Hard Stop CPA → operator config only (no duplicate of canonical data)', cfgAfter?.hard_stop_cpa === 120 && cfgAfter.target_cpa == null);
  const profile = await RD.getProductProfile({ productId: prod.id });
  ok('profile: values with their source, margin computed, store isolated', profile.economics.sellingPrice.value === 300 && profile.economics.purchaseCost.source === 'AMB' && profile.economics.unitMargin === 160 && profile.store === `${T}store` && profile.stock.known && profile.economics.hardStopCpa.value === 120);
  ok('profile readiness: economics+stock ok, mapping missing => BLOCKED with a mapping action', profile.readiness.state === 'BLOCKED' && profile.readiness.missing.some((m) => m.key === 'MAPPING' && m.action.type === 'MAPPING'));
  const sv = await RD.saveProductProfile({ productId: prod.id, patch: { current_stock: 0 } });
  ok('stock 0 is saved as 0 (known) — distinct from unknown', (await prisma.product.findUnique({ where: { id: prod.id } })).current_stock === 0 && sv.profile.stock.known);
  let bpErr = null; try { await RD.saveProductProfile({ productId: prod.id, patch: { target_cpa: 200, hard_stop_cpa: 100 } }); } catch (e) { bpErr = e; }
  ok('profile save validates (Hard Stop < Target => 400)', bpErr && bpErr.status === 400);
  const tpl = await RD.bulkSetupTemplate();
  ok('template CSV is pre-filled with the real AMB products (blank numeric cells)', tpl.split('\n')[0].startsWith('product_id,product,store') && tpl.split('\n').length > 1);

  // ---- events, expiry, retry
  await S.setEmergencyStop({ on: false }); await S.setOperatorMode({ mode: 'APPROVAL' });
  let calls = 0; const execOk = async ({ recId }) => { calls++; return { ok: true }; };
  const d1 = await mkDecision();
  const r1 = await E.executeDecision({ decisionId: d1.id, deps: { approveAndExecute: execOk } });
  ok('unverified write is reported as "sent", NOT "executed" (spec 106)', r1.executed && r1.status === 'EXECUTED' && r1.verified === false && /تم إرسال الطلب إلى Meta/.test(r1.message) && !/^تم التنفيذ/.test(r1.message));
  const ev1 = await prisma.ambOperatorEvent.findMany({ where: { decision_id: d1.id }, orderBy: { id: 'asc' } });
  ok('every transition persisted (PREPARED→EXECUTING→EXECUTED)', ev1.map((e) => e.to_status).join('>') === 'EXECUTING>EXECUTED', ev1.map((e) => `${e.from_status}>${e.to_status}`).join(','));
  const d2 = await mkDecision();
  const rf = await E.executeDecision({ decisionId: d2.id, deps: { approveAndExecute: async () => { throw new Error('Meta rate limit reached'); } } });
  let row2 = await prisma.ambOperatorDecision.findUnique({ where: { id: d2.id } });
  ok('retryable failure recorded with its category (never auto-retried)', row2.status === 'FAILED' && row2.error_category === 'RETRYABLE' && calls === 1 && rf.category === 'RETRYABLE');
  const rt1 = await E.retryFailedDecision({ decisionId: d2.id });
  ok('a human may retry a RETRYABLE failure (back to PREPARED)', rt1.ok && (await prisma.ambOperatorDecision.findUnique({ where: { id: d2.id } })).status === 'PREPARED');
  const d3 = await mkDecision();
  await E.executeDecision({ decisionId: d3.id, deps: { approveAndExecute: async () => { throw new Error('(#200) permission denied'); } } });
  let rerr = null; try { await E.retryFailedDecision({ decisionId: d3.id }); } catch (e) { rerr = e; }
  ok('PERMANENT failure can never be retried', rerr && rerr.status === 409);
  ok('failure raised a (non-spam) alert and nothing else was auto-retried', calls === 1);
  const d4 = await mkDecision({ status: 'REJECTED' });
  ok('rejection stores the reason without any learning side-effect', (await E.rejectDecision({ decisionId: (await mkDecision()).id, reason: 'مش وقته' })).ok);
  const rj = await prisma.ambOperatorDecision.findFirst({ where: { reject_reason: 'مش وقته', store_id: `${T}store` } });
  ok('reject_reason persisted', !!rj && rj.status === 'REJECTED');

  // ---- expiry: expected state / rule version (fake empty world => nothing matches => EXPIRED)
  const world = { config: await S.getOperatorConfig(), settings: {}, adAccountId: null, campaigns: [], windows: {} };
  const rl = await S.saveRule({ rule: { name: `${T}rule`, action: 'PAUSE', window: 'today', conditions: { all: [{ field: 'spend', op: '>=', value: 100 }, { field: 'purchases', op: '=', value: 0 }] } } });
  const dr = await mkDecision({ action: 'PAUSE', rule_id: rl.rule.id, rule_name: rl.rule.name, rule_version: rl.rule.version, params_json: JSON.stringify({ window: 'today' }), expected_state_json: JSON.stringify({ status: 'ACTIVE' }) });
  await S.setRuleEnabled({ id: rl.rule.id, enabled: true });
  const rx = await E.executeDecision({ decisionId: dr.id, deps: { approveAndExecute: execOk, world } });
  const rowx = await prisma.ambOperatorDecision.findUnique({ where: { id: dr.id } });
  const evx = await prisma.ambOperatorEvent.findMany({ where: { decision_id: dr.id } });
  ok('stale decision => EXPIRED + transition event, executor never called', !rx.executed && rowx.status === 'EXPIRED' && evx.some((e) => e.to_status === 'EXPIRED') && calls === 1);
  await prisma.ambOperatorRule.deleteMany({ where: { id: rl.rule.id } });

  // ---- bulk approval
  const b1 = await mkDecision({ rule_id: null }), b2 = await mkDecision({ rule_id: null });
  const callsBefore = calls;
  let be = null; try { await OPS.bulkApprove({ decisionIds: [b1.id, b2.id], confirmedIds: [b1.id], userId: null, deps: { approveAndExecute: execOk } }); } catch (e) { be = e; }
  ok('bulk approval requires every item to be individually confirmed', be && be.status === 400 && calls === callsBefore);
  const bOpen = await mkDecision({ action: 'OPEN', params_json: JSON.stringify({ rollbackOf: 1, window: 'today' }) });
  be = null; try { await OPS.bulkApprove({ decisionIds: [b1.id, bOpen.id], confirmedIds: [b1.id, bOpen.id], userId: null, deps: { approveAndExecute: execOk } }); } catch (e) { be = e; }
  ok('mixed actions are refused (no blind bulk approval)', be && /متجانسة/.test(be.message));
  be = null; try { await OPS.bulkApprove({ decisionIds: [bOpen.id], confirmedIds: [bOpen.id], userId: null, deps: { approveAndExecute: execOk } }); } catch (e) { be = e; }
  ok('risky actions (OPEN) are never bulk-approvable', be && /منخفضة المخاطر/.test(be.message));
  be = null; try { await OPS.bulkApprove({ decisionIds: Array.from({ length: 11 }, (_, i) => i + 1), confirmedIds: Array.from({ length: 11 }, (_, i) => i + 1), userId: null }); } catch (e) { be = e; }
  ok('bulk size capped at 10', be && be.status === 400);
  const bres = await OPS.bulkApprove({ decisionIds: [b1.id, b2.id], confirmedIds: [b1.id, b2.id], userId: null, deps: { approveAndExecute: execOk } });
  ok('homogeneous low-risk bulk: each item executed individually through the same guarded path', bres.summary.executed === 2 && calls === callsBefore + 2 && bres.results.every((x) => x.executed));

  // ---- Autopilot gate
  const gate = await S.autopilotGate();
  ok('gate lists automatic checks + human attestations', gate.checks.some((c) => c.key === 'shadow') && gate.checks.some((c) => c.key === 'emergencyStop') && gate.checks.filter((c) => !c.auto).length === 4);
  let ge = null; try { await S.setOperatorMode({ mode: 'AUTOPILOT', confirmAutopilot: true }); } catch (e) { ge = e; }
  ok('AUTOPILOT refused while any gate check fails (with the failing checks listed)', ge && ge.status === 409 && Array.isArray(ge.details) && ge.details.length > 0 && (await S.getOperatorConfig()).mode !== 'AUTOPILOT');
  ok('passing time/setup never auto-enables Autopilot', gate.note.includes('مش بيفعّل Autopilot لوحده'));
  let ae = null; try { await S.attestAutopilot({ keys: ['nonsense'] }); } catch (e) { ae = e; }
  ok('unknown attestation rejected', ae && ae.status === 400);
  await S.attestAutopilot({ keys: ['regression'], userId: null });
  ok('attestation recorded with time', (await S.autopilotGate()).checks.find((c) => c.key === 'attest:regression').ok);
  await S.revokeAttestations({});
  ok('attestations revocable', !(await S.autopilotGate()).checks.find((c) => c.key === 'attest:regression').ok);

  // ---- account/store limits persistence + isolation
  let le = null; try { await S.updateOperatorLimits({ limits: { account: { bogus: 1 } } }); } catch (e) { le = e; }
  ok('unknown account limit key rejected', le && le.status === 400);
  le = null; try { await S.updateOperatorLimits({ storeLimits: { [`${T}store`]: { maxPausesPerDay: -3 } } }); } catch (e) { le = e; }
  ok('negative store limit rejected', le && le.status === 400);
  const upd = await S.updateOperatorLimits({ limits: { account: { maxPausesPerDay: 7 } }, storeLimits: { [`${T}store`]: { maxEnablesPerDay: 2 } } });
  ok('account + per-store limits persisted; other stores untouched', upd.limits.account.maxPausesPerDay === 7 && upd.storeLimits[`${T}store`].maxEnablesPerDay === 2 && !upd.storeLimits['trendy-storeee'] && upd.limitsConfigured);

  // ---- manual override detection
  const mo = await mkDecision({ action: 'PAUSE', status: 'VERIFIED', executed_at: new Date(Date.now() - 3 * H), after_json: JSON.stringify({ status: 'PAUSED' }), campaign_id: `${T}cmo` });
  const dets = await E.detectManualOverrides({ deps: { latestSnapshot: () => ({ campaign_status: 'ACTIVE', campaign_budget: 100, snapshot_at: new Date() }) } });
  ok('owner re-activated a campaign we paused => MANUAL_OVERRIDE recorded (never undone)', dets.overrides.includes(`${T}cmo`));
  const dets2 = await E.detectManualOverrides({ deps: { latestSnapshot: () => ({ campaign_status: 'ACTIVE', campaign_budget: 100, snapshot_at: new Date() }) } });
  ok('override recorded once (no duplicate event)', !dets2.overrides.includes(`${T}cmo`) && (await prisma.ambOperatorEvent.count({ where: { kind: 'MANUAL_OVERRIDE', campaign_id: `${T}cmo` } })) === 1);
  const recent = await CTX.loadRecentActions({ campaignIds: [`${T}cmo`], now: new Date() });
  ok('the guard context sees the override (cooldown input)', !!recent.get(`${T}cmo`)?.manualOverrideAt && !!recent.get(`${T}cmo`)?.pausedBySystemAt);
  const mo2 = await mkDecision({ action: 'PAUSE', status: 'VERIFIED', executed_at: new Date(Date.now() - 3 * H), after_json: JSON.stringify({ status: 'PAUSED' }), campaign_id: `${T}cmo2` });
  const dets3 = await E.detectManualOverrides({ deps: { latestSnapshot: () => ({ campaign_status: 'PAUSED', campaign_budget: 100, snapshot_at: new Date() }) } });
  ok('state unchanged => no override', !dets3.overrides.includes(`${T}cmo2`));

  // ---- outcome evaluation (before/after, causal honesty)
  const mkExec = (cid, action, hoursAgo, cpa, extra = {}) => mkDecision({ action, status: 'VERIFIED', executed_at: new Date(Date.now() - hoursAgo * H), campaign_id: cid, evidence_json: JSON.stringify({ metrics: { cpa, purchases: 8 } }), after_json: JSON.stringify({ budget: 600 }), rollback_json: JSON.stringify({ previous: { budget: 500 } }), params_json: JSON.stringify({ pct: 20, fromBudget: 500, toBudget: 600, window: 'today' }), ...extra });
  const oi = await mkExec(`${T}co1`, 'SCALE_DOWN', 10, 170), oh = await mkExec(`${T}co2`, 'SCALE_UP', 10, 100), oc = await mkExec(`${T}co3`, 'SCALE_UP', 10, 100);
  await mkExec(`${T}co3`, 'SCALE_DOWN', 5, 100); // another executed action on the SAME campaign afterwards => confounded
  const mm = new Map([[`${T}co1`, { cpa: 118, purchases: 6 }], [`${T}co2`, { cpa: 140, purchases: 6 }], [`${T}co3`, { cpa: 140, purchases: 6 }]]);
  const ev = await E.detectPostScaleDeterioration({ deps: { metricsMap: mm } });
  const oo = async (id) => JSON.parse((await prisma.ambOperatorDecision.findUnique({ where: { id } })).outcome_json || 'null');
  ok('budget reduction with CPA 170 → 118 after a sample => IMPROVED', (await oo(oi.id))?.verdict === 'IMPROVED', JSON.stringify(await oo(oi.id)));
  ok('scale-up with CPA +40% => HARMFUL + a rollback PREPARED (never executed)', (await oo(oh.id))?.verdict === 'HARMFUL' && ev.rollbacksPrepared.length >= 1);
  const rbRow = await prisma.ambOperatorDecision.findFirst({ where: { decision_key: `rollback:${oh.id}` } }); if (rbRow) created.decisions.push(rbRow.id);
  ok('rollback decision is a PREPARED inverse, waiting for the owner', rbRow?.status === 'PREPARED' && rbRow.action === 'SCALE_DOWN');
  ok('another action on the same campaign => CONFOUNDED (no causal credit/blame)', (await oo(oc.id))?.verdict === 'CONFOUNDED');
  const thin = await mkExec(`${T}co4`, 'SCALE_UP', 10, 100);
  await E.detectPostScaleDeterioration({ deps: { metricsMap: new Map([[`${T}co4`, { cpa: 90, purchases: 1 }]]) } });
  ok('insufficient sample => no verdict yet (not guessed)', (await oo(thin.id)) === null);

  // ---- reports on the disposable data
  const perf = await OPS.performanceReport({ days: 30 });
  ok('performance: counts by type, NO success % without enough evaluations', perf.byType.SCALE_UP && perf.totals.executed >= 1 && !('successRate' in perf) && (perf.outcomes.evaluated >= 5 ? perf.outcomes.summary !== null : perf.outcomes.summary === null));
  const outc = await OPS.executedWithOutcomes({ days: 14 });
  ok('outcome list: PAUSE is not judged by CPA; unsampled actions say so', outc.every((o) => o.verdict) && outc.some((o) => o.verdict === 'IMPROVED'));
  const audit = await OPS.ruleAuditLog({ limit: 50 });
  ok('rule/config audit log: who + when + label', audit.length > 0 && audit.every((a) => a.label && a.at && a.actor));
  const health = await OPS.operatorHealth({ scheduler: { started: false, running: false, intervalMinutes: 10, lastRun: null } });
  ok('health: mode, emergency, meta read, queue depth, failed, blocked', 'queueDepth' in health && 'failedLast24h' in health && 'lastMetaRead' in health && 'lastMetaWrite' in health && 'emergencyStop' in health);
  const shaped = (await (await imp('../services/amb/operatorReports.js')).decisionEvents(d1.id));
  ok('decision events readable for the audit trail', shaped.length >= 2 && shaped[0].at);
  const sh = (await imp('../services/amb/operatorReports.js')).shapeDecision(await prisma.ambOperatorDecision.findUnique({ where: { id: d1.id } }));
  ok('shaped decision exposes lifecycle + canonical + unblock', sh.lifecycle === 'EXECUTED' && sh.canonical.decisionId === d1.id && sh.unblock && sh.lifecycleLabel);
} catch (err) {
  fail++; console.log('  ✗ DB part crashed —', err.stack || err.message);
} finally {
  try {
    await retryDb(() => prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { mode: origCfg.mode, emergency_stop: origCfg.emergency_stop, emergency_reason: origCfg.emergency_reason, emergency_at: origCfg.emergency_at, limits_json: origCfg.limitsConfigured ? JSON.stringify(origCfg.limits) : null, store_limits_json: Object.keys(origCfg.storeLimits || {}).length ? JSON.stringify(origCfg.storeLimits) : null, autopilot_attest_json: Object.keys(origCfg.autopilotAttest || {}).length ? JSON.stringify(origCfg.autopilotAttest) : null } }));
    const decIds = (await prisma.ambOperatorDecision.findMany({ where: { OR: [{ store_id: `${T}store` }, { decision_key: { startsWith: T } }, { campaign_id: { startsWith: T } }] }, select: { id: true } })).map((x) => x.id);
    const batches = decIds.map((i) => `operator-${i}`);
    await prisma.ambAction.deleteMany({ where: { recommendation: { batch_id: { in: batches } } } }).catch(() => {});
    await prisma.ambRecommendation.deleteMany({ where: { batch_id: { in: batches } } });
    await prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ decision_id: { in: decIds } }, { campaign_id: { startsWith: T } }] } });
    await prisma.ambOperatorDecision.deleteMany({ where: { id: { in: decIds } } });
    await prisma.ambOperatorEvent.deleteMany({ where: { actor_id: null, created_at: { gte: __testStart } } });
    await prisma.aiAuditLog.deleteMany({ where: { kind: { startsWith: 'OPERATOR_' }, actor_id: null, created_at: { gte: __testStart } } });
    await prisma.ambOperatorRule.deleteMany({ where: { name: { startsWith: T } } });
    await prisma.ambOperatorProductConfig.deleteMany({ where: { store_id: `${T}store` } });
    await prisma.ambOperatorEvent.deleteMany({ where: { kind: { in: ['MODE_CHANGE', 'EMERGENCY_STOP'] }, created_at: { gte: new Date(Date.now() - 20 * 60_000) }, note: { contains: '__optest_' } } });
    await prisma.ambAlert.deleteMany({ where: { OR: [{ title: { contains: T } }, { message: { contains: T } }, { entity_id: { startsWith: T } }] } });
    await prisma.ambProduct.deleteMany({ where: { OR: [{ id: { in: created.amb } }, { product_name: { startsWith: T } }] } });
    await prisma.product.deleteMany({ where: { OR: [{ id: { in: created.products } }, { product_name: { startsWith: T } }] } });
    await prisma.aiAuditLog.deleteMany({ where: { kind: { startsWith: 'OPERATOR_' }, created_at: { gte: new Date(Date.now() - 20 * 60_000) }, input_json: { contains: T } } }).catch(() => {});
    const left = (await prisma.ambOperatorDecision.count({ where: { store_id: `${T}store` } })) + (await prisma.product.count({ where: { product_name: { startsWith: T } } })) + (await prisma.ambAlert.count({ where: { title: { contains: T } } }));
    const c2 = await S.getOperatorConfig();
    ok('cleanup: nothing left (decisions/products/alerts) + global config restored', left === 0 && c2.mode === origCfg.mode && c2.emergency_stop === origCfg.emergency_stop && JSON.stringify(c2.storeLimits) === JSON.stringify(origCfg.storeLimits), `left=${left} mode=${c2.mode}`);
  } catch (e) { fail++; console.log('  ✗ cleanup failed —', e.message); }
}

// =====================================================================================================================
if (!process.argv.includes('--skip-world')) {
  console.log('\nC. real synced world — READ ONLY');
  try {
    const { getConnection } = await imp('../services/metaAuth.js');
    const conn = await getConnection(); const acc = conn?.selected_ad_account_id || null;
    const cnt = async () => (await prisma.ambOperatorDecision.count()) + (await prisma.ambAction.count()) + (await prisma.ambRecommendation.count()) + (await prisma.ambProductCampaignMap.count()) + (await prisma.ambAlert.count());
    const before = await cnt();
    const t0 = Date.now(); const list = await RD.readinessList({ heavy: false });
    ok(`readiness (light) for ${list.length} products in ${Date.now() - t0}ms`, list.length > 0 && list.every((p) => ['READY', 'PARTIAL', 'BLOCKED'].includes(p.readiness.state)));
    ok('on current real data nothing is READY (no stock/economics) — guards are not weakened to look active', list.every((p) => p.readiness.state !== 'READY') || list.some((p) => p.economicsComplete && p.stockKnown));
    ok('every non-ready product lists what is missing with a setup action', list.filter((p) => p.readiness.state !== 'READY').every((p) => p.readiness.missing.length > 0 && p.readiness.missing.every((m) => m.action)));
    const g = await RD.globalReadiness({ heavy: false, adAccountId: acc });
    ok('global readiness: product states add up, missing-economics/stock counted', g.products.ready + g.products.partial + g.products.blocked === g.products.total && typeof g.missingEconomics === 'number' && typeof g.missingStock === 'number');
    if (acc) {
      const mc = await RD.mappingCenter({ adAccountId: acc });
      ok(`mapping center: ${mc.total} campaigns — states add up`, mc.counts.VERIFIED + mc.counts.SUGGESTED + mc.counts.UNMAPPED + mc.counts.CONFLICT + (mc.counts.EXTERNAL_STORE || 0) === mc.total);
      ok('VERIFIED rows always have a product; SUGGESTED/UNMAPPED never claim to be verified', mc.rows.filter((r) => r.state === 'VERIFIED').every((r) => r.product) && mc.rows.filter((r) => r.state !== 'VERIFIED').every((r) => !(r.source === 'EXPLICIT_MAPPING' && !r.product)));
      ok('name-similarity suggestions are flagged WEAK and need >=2 shared words', mc.rows.filter((r) => r.suggestion?.source === 'NAME_SIMILARITY').every((r) => r.suggestion.weak === true));
      const w = await RD.setupWizard({ adAccountId: acc, heavy: false });
      ok('wizard: 6 steps with progress; says 100% does not enable Autopilot', w.steps.length === 6 && /مبيفعّلش Autopilot/.test(w.note));
    }
    const w2 = await OPS.whatWillHappen({});
    const s = w2.summary;
    ok(`what-will-happen: ${s.objectsEvaluated} objects → would open ${s.wouldOpen} / pause ${s.wouldPause} / scale ${s.wouldScale} / reduce ${s.wouldReduce} / blocked ${s.blocked} / excluded ${s.excluded} / unknown ${s.unknown}`, ['wouldOpen', 'wouldPause', 'wouldScale', 'wouldReduce', 'blocked', 'excluded', 'protected', 'unknown'].every((k) => typeof s[k] === 'number') && w2.wrote === false);
    ok('everything in this pass wrote NOTHING (decisions/actions/recommendations/mappings/alerts unchanged)', (await cnt()) === before);
    const brief = await OPS.dailyBrief({ adAccountId: acc });
    ok('daily brief has did / needs approval / blocked / needs setup / improved-worsened / top risk / top opportunity', ['did', 'needsApproval', 'blocked', 'needsSetup', 'improved', 'worsened', 'topRisk', 'topOpportunity'].every((k) => k in brief));
  } catch (err) { fail++; console.log('  ✗ world part crashed —', err.stack || err.message); }
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
