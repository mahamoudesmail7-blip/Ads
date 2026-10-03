// 🤖 AI Operator — GUARD CHAIN (pure, no DB, no network). 2026-10-03.
//
// Every candidate action goes through the SAME ordered chain. Groups are evaluated in PRECEDENCE order (operatorRules.PRECEDENCE):
// EMERGENCY_STOP > SAFETY > EXCEPTION > DATA_QUALITY > INVENTORY > PROFIT > TESTING > USER_RULE > ADVISOR.
// A BLOCK can never be overridden by a user rule or by the Smart Advisor. A DOWNGRADE keeps the action but forbids Autopilot
// (it stays PREPARED for human approval). WARN is informational.
//
// Principles enforced here:
//  * UNKNOWN is never converted to zero/ok: unknown stock / economics / data quality BLOCK the actions that depend on them.
//  * Easy Orders confirmation/delivery are never used while their status signal is unverified (NO_STATUS_SIGNAL).
//  * Anything the guard cannot establish about store/product/campaign mapping fails closed.
import { PRECEDENCE_RANK, ACTION_LABEL_AR } from './operatorRules.js';
import { evaluateMoneyGuardForScale } from './moneyGuard.js';
import { specCodesFor } from './operatorUnblock.js';

const MS_H = 3_600_000;

/** Catalogue of block/downgrade/warn codes — one place for UI labels (Arabic) and tests. */
export const BLOCK_CODES = {
  EMERGENCY_STOP: { group: 'EMERGENCY_STOP', severity: 'BLOCK', message: '🛑 إيقاف الطوارئ مفعّل — مفيش أي تنفيذ على Meta.' },
  META_WRITES_LOCKED: { group: 'EMERGENCY_STOP', severity: 'BLOCK', message: '🔒 كتابة AI Operator على Meta مقفولة على مستوى النشر — مفيش تنفيذ لحد موافقتك الصريحة.' },
  MODE_OFF: { group: 'EMERGENCY_STOP', severity: 'BLOCK', message: 'AI Operator في وضع OFF.' },
  AMB_ADVISORY_ONLY: { group: 'SAFETY', severity: 'BLOCK', message: 'نظام AI Media Buyer في وضع "استشاري فقط" — مفيش تنفيذ على Meta.' },
  META_NOT_CONNECTED: { group: 'SAFETY', severity: 'BLOCK', message: 'مفيش اتصال Meta Ads صالح.' },
  META_DATA_STALE: { group: 'SAFETY', severity: 'BLOCK', message: 'آخر مزامنة Meta قديمة — مفيش قرار على أرقام قديمة.' },
  OUTSIDE_SCHEDULE: { group: 'SAFETY', severity: 'BLOCK', message: 'خارج جدول التشغيل الآلي المحدد.' },
  STORE_AMBIGUOUS: { group: 'SAFETY', severity: 'BLOCK', message: 'سياق المتجر غير واضح — مرفوض لمنع خلط المتاجر.' },
  MAPPING_UNRELIABLE: { group: 'SAFETY', severity: 'BLOCK', message: '⚠️ Campaign غير مرتبطة بمنتج بشكل موثوق.' },
  MAPPING_UNVERIFIED_WARN: { group: 'SAFETY', severity: 'WARN', message: 'ربط الحملة بالمنتج غير موثّق بالكامل (الإيقاف على أساس صرف بلا أوردرات مسموح لأنه ما بيعتمدش على بيانات المنتج).' },
  DATA_UNKNOWN: { group: 'DATA_QUALITY', severity: 'BLOCK', message: '⚠️ القاعدة متوقفة: بيانات مطلوبة غير معروفة (مفيش تحويل مجهول لصفر).' },
  MODE_SHADOW_NO_EXECUTION: { group: 'SAFETY', severity: 'BLOCK', message: 'الوضع الحالي Shadow — بيعرض اللي كان هيحصل بس ومفيش تنفيذ.' },
  BUDGET_UNKNOWN: { group: 'SAFETY', severity: 'BLOCK', message: 'ميزانية الحملة الحالية غير معروفة (مش CBO أو لسه ما اتزامنتش) — مفيش تغيير ميزانية على رقم مجهول.' },
  SUPERSEDED_BY_RULE: { group: 'USER_RULE', severity: 'BLOCK', message: 'قاعدة تانية بأولوية أعلى قررت أكشن مختلف لنفس الحملة.' },
  CONDITIONS_CHANGED: { group: 'SAFETY', severity: 'BLOCK', message: 'الشروط اتغيرت من وقت التحضير — القرار لم يعد مطابقًا للقاعدة.' },
  ALREADY_IN_TARGET_STATE: { group: 'SAFETY', severity: 'BLOCK', message: 'الحملة بالفعل في الحالة المطلوبة.' },
  INSUFFICIENT_SAMPLE: { group: 'SAFETY', severity: 'BLOCK', message: 'العينة غير كافية للقرار (صرف/أوردرات أقل من الحد الأدنى).' },
  ACTION_NOT_ALLOWED: { group: 'SAFETY', severity: 'DOWNGRADE', message: 'الأكشن ده مش مسموح في Autopilot (قائمة الأكشنز المسموحة) — هيفضل للموافقة.' },
  MAX_ACTION_SIZE: { group: 'SAFETY', severity: 'BLOCK', message: 'حجم تغيير الميزانية أكبر من الحد المسموح للأكشن.' },
  MAX_AUTO_AMOUNT: { group: 'SAFETY', severity: 'DOWNGRADE', message: 'قيمة التغيير أكبر من الحد المسموح لـ Autopilot — هيفضل للموافقة.' },
  RATE_LIMIT_HOUR: { group: 'SAFETY', severity: 'BLOCK', message: 'تم الوصول للحد الأقصى للأكشنز في الساعة.' },
  RATE_LIMIT_DAY: { group: 'SAFETY', severity: 'BLOCK', message: 'تم الوصول للحد الأقصى للأكشنز في اليوم.' },
  CAMPAIGN_DAILY_LIMIT: { group: 'SAFETY', severity: 'BLOCK', message: 'تم الوصول للحد الأقصى لتغييرات نفس الحملة اليوم.' },
  COOLDOWN_ACTIVE: { group: 'SAFETY', severity: 'BLOCK', message: 'فترة التهدئة لسه شغالة على الحملة دي.' },
  FLIP_FLOP: { group: 'SAFETY', severity: 'BLOCK', message: 'عكس أكشن اتنفذ مؤخرًا على نفس الحملة — مفيش تقلب بسبب ضوضاء.' },
  DAILY_LOSS_LIMIT: { group: 'SAFETY', severity: 'BLOCK', message: 'تم تجاوز حد الخسارة اليومي — الأكشنز المخاطرة متوقفة.' },
  SPEND_VELOCITY_FREEZE: { group: 'SAFETY', severity: 'BLOCK', message: 'سرعة صرف غير طبيعية — التوسع/الفتح متجمد.' },
  RECENT_HARMFUL_SCALE: { group: 'SAFETY', severity: 'BLOCK', message: 'فيه توسع ضار حديث على الحملة دي.' },
  CRITICAL_INCIDENT: { group: 'SAFETY', severity: 'BLOCK', message: 'فيه حادثة حرجة (Incident) مفتوحة على المنتج.' },
  EXCEPTION_NO_AUTOMATION: { group: 'EXCEPTION', severity: 'BLOCK', message: '🛡️ استثناء: NO AUTOMATION على النطاق ده.' },
  EXCEPTION_NO_AUTO_STOP: { group: 'EXCEPTION', severity: 'BLOCK', message: '🛡️ استثناء: NO AUTO STOP.' },
  EXCEPTION_NO_AUTO_OPEN: { group: 'EXCEPTION', severity: 'BLOCK', message: '🛡️ استثناء: NO AUTO OPEN.' },
  EXCEPTION_NO_AUTO_SCALE: { group: 'EXCEPTION', severity: 'BLOCK', message: '🛡️ استثناء: NO AUTO SCALE.' },
  EXCEPTION_NO_BUDGET_CHANGE: { group: 'EXCEPTION', severity: 'BLOCK', message: '🛡️ استثناء: NO BUDGET CHANGE.' },
  DATA_QUALITY_BLOCKED: { group: 'DATA_QUALITY', severity: 'BLOCK', message: '⚠️ القرار متوقف بسبب جودة البيانات.' },
  DATA_QUALITY_UNKNOWN: { group: 'DATA_QUALITY', severity: 'BLOCK', message: '⚠️ جودة البيانات غير معروفة لهذا المنتج — القرار متوقف.' },
  COD_UNRELIABLE: { group: 'DATA_QUALITY', severity: 'BLOCK', message: '⚠️ حالات Easy Orders غير موثوقة — أي قرار معتمد على التأكيد/التسليم متوقف.' },
  COD_UNVERIFIED_WARN: { group: 'DATA_QUALITY', severity: 'WARN', message: 'جودة COD غير مؤكدة (حالات Easy Orders غير محدّثة) — القرار مبني على Meta + اقتصاديات المنتج فقط.' },
  STOCK_UNKNOWN: { group: 'INVENTORY', severity: 'BLOCK', message: 'المخزون غير مسجّل — مفيش افتراض مخزون.' },
  STOCK_OUT: { group: 'INVENTORY', severity: 'BLOCK', message: 'المخزون صفر.' },
  STOCK_BELOW_MIN: { group: 'INVENTORY', severity: 'BLOCK', message: 'المخزون تحت الحد الأدنى.' },
  STOCK_COVERAGE_LOW: { group: 'INVENTORY', severity: 'BLOCK', message: 'تغطية المخزون (أيام) أقل من الحد المطلوب للتوسع.' },
  STOCK_COVERAGE_WARN: { group: 'INVENTORY', severity: 'WARN', message: 'تغطية المخزون قريبة من الحد — فكّر في توسع أصغر.' },
  ECONOMICS_INCOMPLETE: { group: 'PROFIT', severity: 'BLOCK', message: 'اقتصاديات المنتج غير مكتملة (سعر/تكلفة) — الربحية UNKNOWN والأكشن المعتمد عليها متوقف.' },
  PROFIT_NEGATIVE: { group: 'PROFIT', severity: 'BLOCK', message: 'المنتج بيخسر عند الـCPA الحالي (هامش الوحدة سالب).' },
  MONEY_GUARD_BLOCKED: { group: 'PROFIT', severity: 'BLOCK', message: 'Money Guard منع التوسع.' },
  MONEY_GUARD_WARN: { group: 'PROFIT', severity: 'WARN', message: 'Money Guard: تحذير.' },
  HARD_STOP_NOT_CONFIGURED: { group: 'PROFIT', severity: 'BLOCK', message: 'مفيش Hard Stop CPA محسوب أو معرّف لهذا المنتج.' },
  TESTING_PROTECTED: { group: 'TESTING', severity: 'BLOCK', message: 'حملة اختبار (TESTING) — محمية من الإيقاف الآلي العام.' },
  TESTING_SAMPLE: { group: 'TESTING', severity: 'BLOCK', message: 'حملة اختبار: العينة أقل من الحد الأدنى المخصص للتوسع.' },
  CONFIDENCE_TOO_LOW_FOR_AUTOPILOT: { group: 'USER_RULE', severity: 'DOWNGRADE', message: 'Autopilot بيتطلب ثقة HIGH — هيفضل للموافقة.' },
  RULE_CONFLICT: { group: 'USER_RULE', severity: 'WARN', message: 'فيه قاعدة تانية متعارضة على نفس الحملة (الأولوية للأقل رقمًا).' },
  STOCK_TOO_LOW: { group: 'INVENTORY', severity: 'BLOCK', message: 'المخزون عند أو تحت الحد الأدنى — مفيش فتح/توسع.' },
  RECENT_ACTION_PENDING_EVALUATION: { group: 'SAFETY', severity: 'BLOCK', message: 'فيه أكشن حديث على الحملة لسه مش متقيّم — مفيش أكشن تاني لحد ما أثره يتقاس.' },
  ATTRIBUTION_GRACE: { group: 'SAFETY', severity: 'BLOCK', message: 'فترة السماح لوصول الأوردرات المنسوبة (Attribution) لسه ماخلصتش — مفيش إيقاف على بيانات غير ناضجة.' },
  MANUAL_OVERRIDE_COOLDOWN: { group: 'SAFETY', severity: 'BLOCK', message: 'انت غيّرت الحملة يدويًا — الأتمتة موقوفة عليها لفترة تهدئة (مش بنلغي قرارك).' },
  ACCOUNT_DAILY_LIMIT: { group: 'SAFETY', severity: 'BLOCK', message: 'تم الوصول لحد الحساب اليومي للأكشنز التلقائية.' },
  STORE_DAILY_LIMIT: { group: 'SAFETY', severity: 'BLOCK', message: 'تم الوصول لحد المتجر اليومي للأكشنز التلقائية.' },
  PRODUCT_AUTOMATION_OFF: { group: 'SAFETY', severity: 'BLOCK', message: 'أتمتة المنتج ده مقفولة (OFF) من ملف أتمتة المنتج.' },
  MANUAL_STOP_INTENT_UNKNOWN: { group: 'SAFETY', severity: 'DOWNGRADE', message: 'مفيش دليل إن الحملة اتقفلت من الـOperator (ممكن تكون اتقفلت يدويًا لسبب) — الفتح محتاج موافقتك.' },
  PROFIT_FLOOR: { group: 'PROFIT', severity: 'BLOCK', message: 'الربح الموثّق للوحدة تحت الحد الأدنى المحدد للمنتج.' },
  ADVISOR_DISAGREES: { group: 'ADVISOR', severity: 'DOWNGRADE', message: 'المستشار الذكي مش شايف المنتج جاهز للتوسع حاليًا — هيفضل للموافقة.' },
  ADVISOR_DATA_GAP: { group: 'ADVISOR', severity: 'WARN', message: 'المستشار الذكي بيعتبر البيانات غير كافية.' },
};

const block = (code, extra = {}) => ({ code, ...BLOCK_CODES[code], ...extra, specCodes: specCodesFor(code, extra) });

/** Effective mode of a decision = the stricter of the global mode and the rule's own mode. */
const MODE_ORDER = ['OFF', 'SHADOW', 'APPROVAL', 'AUTOPILOT'];
export function effectiveMode(globalMode, ruleMode) {
  const g = MODE_ORDER.indexOf(globalMode), r = MODE_ORDER.indexOf(ruleMode || 'SHADOW');
  return MODE_ORDER[Math.max(0, Math.min(g < 0 ? 1 : g, r < 0 ? 1 : r))];
}

/** Hours-of-day schedule check. schedule={mode:'ALWAYS'|'HOURS'|'EXCLUDED_HOURS', ranges:[{from:'HH:MM',to:'HH:MM'}], tzOffsetHours}. */
export function withinSchedule(schedule, now = new Date()) {
  if (!schedule || !schedule.mode || schedule.mode === 'ALWAYS') return true;
  const off = Number(schedule.tzOffsetHours ?? 3); // Africa/Cairo default (+3, no DST handling by design — configurable)
  const local = new Date(now.getTime() + off * MS_H);
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  const inAny = (schedule.ranges || []).some((r) => { const a = toMin(r.from), b = toMin(r.to); return a <= b ? mins >= a && mins < b : mins >= a || mins < b; });
  return schedule.mode === 'HOURS' ? inAny : !inAny;
}

/** Unit economics from CONFIGURED values only — never invented, never derived from Easy Orders statuses. */
export function computeOperatorEconomics({ product, ambProduct, opCfg, observedCpa = null }) {
  // AmbProduct columns default to 0 meaning "not entered": a 0 there must never shadow a real catalog value, and a suggested price (cost x multiplier) is NOT a real price.
  const pos = (...vs) => { for (const v of vs) { const n = Number(v); if (Number.isFinite(n) && n > 0) return n; } return 0; };
  const price = pos(ambProduct?.actual_selling_price, product?.selling_price);
  const cost = pos(ambProduct?.product_cost, product?.product_cost);
  const ship = pos(ambProduct?.shipping_cost, product?.shipping_cost);
  const pack = pos(ambProduct?.packaging_cost, product?.packaging_cost);
  const other = pos(ambProduct?.other_cost, product?.other_cost);
  const complete = price > 0 && cost > 0;
  const variable = cost + ship + pack + other;
  const unitMargin = complete ? price - variable : null;
  const minProfit = Number(opCfg?.min_profit ?? ambProduct?.min_profit) || 0;
  const calculatedMaxCpa = complete ? Math.max(0, unitMargin - minProfit) : null;
  const targetCpa = opCfg?.target_cpa ?? ambProduct?.target_cpa ?? null;
  const maxCpa = opCfg?.max_cpa ?? ambProduct?.max_cpa ?? calculatedMaxCpa;
  const hardStopCpa = opCfg?.hard_stop_cpa ?? null;
  let profitState = 'UNKNOWN', unitProfitAtCpa = null;
  if (complete && observedCpa != null) {
    unitProfitAtCpa = unitMargin - observedCpa;
    const m = price > 0 ? (unitProfitAtCpa / price) * 100 : 0;
    profitState = unitProfitAtCpa < 0 ? 'UNPROFITABLE' : m < 3 ? 'BREAK_EVEN' : m < 15 ? 'MARGIN_THIN' : 'PROFITABLE';
  } else if (complete) profitState = 'INSUFFICIENT_DATA';
  return { complete, price, variable, unitMargin, calculatedMaxCpa, targetCpa, maxCpa, hardStopCpa, hardStopSource: hardStopCpa != null ? 'MANUAL' : null, minProfit, profitState, unitProfitAtCpa, marginPct: unitProfitAtCpa != null && price ? (unitProfitAtCpa / price) * 100 : null };
}

/**
 * Evidence-quality confidence (NOT a model probability): HIGH needs a strong sample, verified mapping, usable data quality and the
 * dependencies the action actually needs (economics/stock) to be known.
 */
export function decisionConfidence({ action, metrics, settings, mappingVerified, dqOk, econKnown, stockKnown, needs }) {
  const minSpend = Number(settings?.ambMinSpendBeforeDecision) || 150, minP = Number(settings?.ambMinPurchasesBeforeScaling) || 5;
  const spend = metrics?.spend ?? 0, purchases = metrics?.purchases ?? 0;
  let score = 0;
  score += spend >= minSpend * 2 ? 2 : spend >= minSpend ? 1 : 0;
  if (action === 'PAUSE' && purchases === 0 && spend >= minSpend) score += 1; // a clean "spend without result" signal
  else score += purchases >= minP * 2 ? 2 : purchases >= minP ? 1 : 0;
  if (mappingVerified) score += 1;
  if (dqOk) score += 1;
  if (needs?.profit && !econKnown) score -= 3;
  if (needs?.stock && !stockKnown) score -= 3;
  return score >= 4 ? 'HIGH' : score >= 2 ? 'MEDIUM' : 'LOW';
}

const FAMILY = { OPEN: 'OPEN', PAUSE: 'PAUSE', SCALE_UP: 'SCALE', SCALE_DOWN: 'SCALE', PREPARE_TEST: 'TEST', ROLLBACK: 'ROLLBACK' };
const OPPOSITE = { OPEN: ['PAUSE'], PAUSE: ['OPEN', 'SCALE_UP'], SCALE_UP: ['SCALE_DOWN', 'PAUSE'], SCALE_DOWN: ['SCALE_UP'] };
const EXC_TO_ACTIONS = { NO_AUTOMATION: ['OPEN', 'PAUSE', 'SCALE_UP', 'SCALE_DOWN', 'PREPARE_TEST'], NO_AUTO_STOP: ['PAUSE'], NO_AUTO_OPEN: ['OPEN'], NO_AUTO_SCALE: ['SCALE_UP'], NO_BUDGET_CHANGE: ['SCALE_UP', 'SCALE_DOWN'] };
const EXC_CODE = { NO_AUTOMATION: 'EXCEPTION_NO_AUTOMATION', NO_AUTO_STOP: 'EXCEPTION_NO_AUTO_STOP', NO_AUTO_OPEN: 'EXCEPTION_NO_AUTO_OPEN', NO_AUTO_SCALE: 'EXCEPTION_NO_AUTO_SCALE', NO_BUDGET_CHANGE: 'EXCEPTION_NO_BUDGET_CHANGE' };

/**
 * The chain. `input` = {decision:{action, params, ruleMode, confidence, needs, usesCod, ruleFields}, ctx, config, settings, counters, now}.
 * Returns {blocks[], primary, canExecute, canAutoExecute, effectiveMode, downgrade, warnings[]} — blocks sorted by precedence.
 */
export function evaluateGuards({ decision, ctx, config, settings = {}, counters = {}, now = new Date() }) {
  const out = [];
  const add = (code, extra) => out.push(block(code, extra));
  const a = decision.action;
  const needs = decision.needs || {};
  const productMode = ctx.product?.automationMode || null;
  const eff = effectiveMode(effectiveMode(config.mode, productMode || 'AUTOPILOT'), decision.ruleMode || 'SHADOW');
  const consequential = ['OPEN', 'PAUSE', 'SCALE_UP', 'SCALE_DOWN'].includes(a);
  const risky = ['OPEN', 'SCALE_UP'].includes(a);
  const m = ctx.metrics || {};
  const lim = config.limits || {};

  // ---- 1. EMERGENCY STOP / OFF
  if (config.emergency_stop && consequential) add('EMERGENCY_STOP');
  if (config.mode === 'OFF') add('MODE_OFF');
  if (config.writesLocked && consequential && eff !== 'SHADOW' && eff !== 'OFF') add('META_WRITES_LOCKED');
  if (productMode === 'OFF' && consequential) add('PRODUCT_AUTOMATION_OFF');

  // ---- 2. SAFETY
  if (!ctx.storeId) add('STORE_AMBIGUOUS');
  if (consequential && settings.ambExecutionMode === 'ADVISORY' && eff !== 'SHADOW') add('AMB_ADVISORY_ONLY');
  if (consequential && ctx.metaConnected === false && eff !== 'SHADOW') add('META_NOT_CONNECTED');
  if (consequential && ctx.metaStale) add('META_DATA_STALE');
  if (consequential && !withinSchedule(config.schedule, now) && eff !== 'SHADOW') add('OUTSIDE_SCHEDULE');
  const st = ctx.campaign?.status;
  if (a === 'OPEN' && st === 'ACTIVE') add('ALREADY_IN_TARGET_STATE');
  if (a === 'PAUSE' && st === 'PAUSED') add('ALREADY_IN_TARGET_STATE');
  const minSpend = Number(settings.ambMinSpendBeforeDecision) || 150, minP = Number(settings.ambMinPurchasesBeforeScaling) || 5;
  if (a === 'SCALE_UP' && ((m.spend ?? 0) < minSpend || (m.purchases ?? 0) < minP)) add('INSUFFICIENT_SAMPLE');
  if (a === 'PAUSE' && (m.spend ?? 0) < Math.min(minSpend, decision.ruleMinSpend ?? minSpend)) add('INSUFFICIENT_SAMPLE');
  // mapping
  const mapped = ctx.product?.mappingVerified === true;
  if (consequential && !mapped) {
    const productFree = a === 'PAUSE' && !needs.profit && !needs.stock && !needs.targetCpa;
    if (productFree) add('MAPPING_UNVERIFIED_WARN'); else add('MAPPING_UNRELIABLE');
  }
  // action allowlist + sizes (Autopilot only; approval keeps a human in the loop)
  const allow = { OPEN: settings.ambAllowAutoOpen === true, PAUSE: settings.ambAllowAutoPause === true, SCALE_UP: settings.ambAllowAutoBudgetIncrease === true, SCALE_DOWN: settings.ambAllowAutoBudgetDecrease === true };
  if (eff === 'AUTOPILOT' && consequential && !allow[a]) add('ACTION_NOT_ALLOWED');
  const pct = decision.params?.pct;
  if (['SCALE_UP', 'SCALE_DOWN'].includes(a) && pct != null) {
    const prodCap = Number(ctx.product?.maxScalePct) || null;
    const maxUp = Math.min(Number(settings.ambMaxBudgetIncreasePct) || 20, prodCap || Infinity), maxDown = Math.min(Number(lim.maxDecreasePct) || 30, prodCap || Infinity);
    if (a === 'SCALE_UP' && pct > maxUp + 0.01) add('MAX_ACTION_SIZE', { detail: `${pct}% > ${maxUp}%` });
    if (a === 'SCALE_DOWN' && pct > maxDown + 0.01) add('MAX_ACTION_SIZE', { detail: `${pct}% > ${maxDown}%` });
    const delta = Math.abs((decision.params?.toBudget ?? 0) - (decision.params?.fromBudget ?? 0));
    const maxAuto = Number(settings.ambMaxAutoExecutionAmount) || 500;
    if (eff === 'AUTOPILOT' && delta > maxAuto) add('MAX_AUTO_AMOUNT', { detail: `${Math.round(delta)} > ${maxAuto}` });
  }
  // rate limits
  if (consequential && eff !== 'SHADOW') {
    if (lim.maxActionsPerHour && (counters.actionsLastHour ?? 0) >= lim.maxActionsPerHour) add('RATE_LIMIT_HOUR');
    if (lim.maxActionsPerDay && (counters.actionsToday ?? 0) >= lim.maxActionsPerDay) add('RATE_LIMIT_DAY');
    if (lim.maxChangesPerCampaignPerDay && (counters.campaignActionsToday ?? 0) >= lim.maxChangesPerCampaignPerDay) add('CAMPAIGN_DAILY_LIMIT');
  }
  // account-level + store-level guards (spec 74/75): a bad global rule must not be able to move the whole account
  if (consequential && eff !== 'SHADOW') {
    const lv = [['ACCOUNT_DAILY_LIMIT', lim.account, counters.byAction, counters.budgetIncreaseToday, counters.aiBudget], ['STORE_DAILY_LIMIT', (config.storeLimits || {})[ctx.storeId], (counters.byStoreAction || {})[ctx.storeId], (counters.budgetIncreaseByStore || {})[ctx.storeId], (counters.aiBudgetByStore || {})[ctx.storeId]]];
    const delta = a === 'SCALE_UP' ? Math.max(0, (decision.params?.toBudget ?? 0) - (decision.params?.fromBudget ?? 0)) : a === 'OPEN' ? Number(ctx.campaign?.budget) || 0 : 0;
    for (const [code, L, by, inc, aiB] of lv) {
      if (!L) continue;
      if (a === 'OPEN' && L.maxEnablesPerDay != null && ((by || {}).OPEN || 0) >= L.maxEnablesPerDay) add(code, { detail: `فتح ${(by || {}).OPEN || 0}/${L.maxEnablesPerDay}` });
      else if (a === 'PAUSE' && L.maxPausesPerDay != null && ((by || {}).PAUSE || 0) >= L.maxPausesPerDay) add(code, { detail: `إيقاف ${(by || {}).PAUSE || 0}/${L.maxPausesPerDay}` });
      else if (a === 'SCALE_UP' && L.maxBudgetIncreasePerDay != null && (inc || 0) + delta > L.maxBudgetIncreasePerDay) add(code, { detail: `زيادة ميزانية ${Math.round((inc || 0) + delta)} > ${L.maxBudgetIncreasePerDay}` });
      else if (['SCALE_UP', 'OPEN'].includes(a) && L.maxDailySpendUnderAi != null && (aiB || 0) + delta > L.maxDailySpendUnderAi) add(code, { detail: `ميزانية تحت تحكم AI ${Math.round((aiB || 0) + delta)} > ${L.maxDailySpendUnderAi}` });
    }
  }
  // human override (spec 86): never immediately undo a manual change
  const moH = Number(lim.manualOverrideCooldownHours ?? 24);
  if (consequential && ctx.recent?.manualOverrideAt && now.getTime() - new Date(ctx.recent.manualOverrideAt).getTime() < moH * MS_H) add('MANUAL_OVERRIDE_COOLDOWN', { detail: `${moH}h` });
  // attribution delay / campaign maturity (spec 70/71): do not pause on immature conversion data
  if (a === 'PAUSE' && !decision.severeOverride) {
    const minAge = Number(lim.minCampaignAgeHours ?? 24), grace = Number(lim.attributionGraceHours ?? 6);
    const firstSeen = ctx.campaign?.firstSeenAt;
    if (firstSeen && minAge > 0 && now.getTime() - new Date(firstSeen).getTime() < minAge * MS_H) add('ATTRIBUTION_GRACE', { detail: `عمر الحملة أقل من ${minAge}س` });
    else {
      const lastEdit = Math.max(0, ...Object.entries(ctx.recent?.lastByAction || {}).filter(([k]) => k !== 'PAUSE').map(([, t]) => new Date(t).getTime()));
      if (grace > 0 && lastEdit && now.getTime() - lastEdit < grace * MS_H) add('ATTRIBUTION_GRACE', { detail: `آخر تعديل منذ أقل من ${grace}س` });
    }
  }
  // a previous action whose effect has not been measured yet (spec 56 RECENT_ACTION_PENDING_EVALUATION)
  if (risky && !decision.severeOverride && ctx.recent?.pendingEvaluationAt) add('RECENT_ACTION_PENDING_EVALUATION', { detail: `منذ ${Math.round((now.getTime() - new Date(ctx.recent.pendingEvaluationAt).getTime()) / MS_H)}س` });
  // opening a campaign whose manual-stop intent cannot be known needs a human (spec 69)
  if (a === 'OPEN' && !ctx.recent?.pausedBySystemAt) add('MANUAL_STOP_INTENT_UNKNOWN');
  // cooldown + flip-flop (uses the SAME recent-action facts the engine loads; hours are configurable per action type)
  const cdH = Number(decision.cooldownHours ?? config.cooldowns?.[a] ?? 24);
  const last = ctx.recent?.lastByAction || {};
  if (last[a] && now.getTime() - new Date(last[a]).getTime() < cdH * MS_H) add('COOLDOWN_ACTIVE', { detail: `${cdH}h` });
  for (const opp of OPPOSITE[a] || []) {
    const t = last[opp]; const oppH = Number(config.cooldowns?.[opp] ?? 24);
    if (t && now.getTime() - new Date(t).getTime() < oppH * MS_H && !decision.severeOverride) add('FLIP_FLOP', { detail: `${opp} منذ ${Math.round((now.getTime() - new Date(t).getTime()) / MS_H)}h` });
  }
  // loss limits (only the risky actions are blocked — stopping a loss is never blocked by a loss limit)
  if (risky) {
    const L = lim.lossLimits || {}, cur = counters.loss || {};
    if ((L.campaign && cur.campaign >= L.campaign) || (L.product && cur.product >= L.product) || (L.account && cur.account >= L.account)) add('DAILY_LOSS_LIMIT');
  }
  if (risky && ctx.velocity?.abnormal) add('SPEND_VELOCITY_FREEZE');
  if (a === 'SCALE_UP' && ctx.recent?.harmfulScaleAt && now.getTime() - new Date(ctx.recent.harmfulScaleAt).getTime() < 72 * MS_H) add('RECENT_HARMFUL_SCALE');
  if (risky && (ctx.incidents || []).some((i) => ['CRITICAL', 'HIGH'].includes(i.severity))) add('CRITICAL_INCIDENT');

  // ---- 3. EXCEPTIONS (always win over automation)
  for (const exc of ctx.exceptions || []) for (const type of exc.types || []) if ((EXC_TO_ACTIONS[type] || []).includes(a)) add(EXC_CODE[type], { exceptionId: exc.id, scope: exc.scope_label || exc.scopeLabel || exc.scope_id, scopeType: exc.scope_type || null, expiresAt: exc.expires_at || null });

  // ---- 4. DATA QUALITY
  const dq = ctx.dq || {};
  if (consequential && needs.dq !== false) {
    if (dq.gate === 'DECISION_BLOCKED_DATA_QUALITY' || dq.overall === 'MAPPING_ERROR' || dq.overall === 'PURCHASE_RECONCILIATION_ERROR') add('DATA_QUALITY_BLOCKED');
    else if (mapped && !dq.gate && !dq.overall) add('DATA_QUALITY_UNKNOWN');
  }
  const codTrust = dq.statusTrust?.state;
  if (consequential && decision.usesCod && codTrust !== 'OK') add('COD_UNRELIABLE');
  else if (consequential && a === 'SCALE_UP' && codTrust && codTrust !== 'OK') add('COD_UNVERIFIED_WARN');

  // ---- 5. INVENTORY (never assume inventory when it is unavailable)
  if (needs.stock && risky) {
    const s = ctx.stock || {};
    if (!s.status || s.status === 'STOCK_UNKNOWN') add('STOCK_UNKNOWN');
    else if (s.status === 'OUT_OF_STOCK') add('STOCK_OUT');
    else if (s.status === 'LOW') add('STOCK_TOO_LOW', { detail: `${s.currentStock ?? '?'} ≤ ${s.minimumStock ?? '?'}` });
    else {
      if (a === 'SCALE_UP' && s.minimumStock != null && s.currentStock != null && s.currentStock < s.minimumStock) add('STOCK_BELOW_MIN');
      const minCover = Number(lim.minDaysCover) || 7;
      if (a === 'SCALE_UP' && s.daysRemaining != null) { if (s.daysRemaining < minCover) add('STOCK_COVERAGE_LOW', { detail: `${Math.round(s.daysRemaining * 10) / 10} يوم` }); else if (s.daysRemaining < minCover * 2) add('STOCK_COVERAGE_WARN', { detail: `${Math.round(s.daysRemaining * 10) / 10} يوم` }); }
    }
  }

  // ---- 6. PROFIT / MONEY GUARD
  if (needs.profit && risky) {
    const e = ctx.econ || {};
    if (!e.complete) add('ECONOMICS_INCOMPLETE');
    else if (e.profitState === 'UNPROFITABLE') add('PROFIT_NEGATIVE');
    if (e.complete && e.minProfit > 0 && e.unitProfitAtCpa != null && e.unitProfitAtCpa < e.minProfit) add('PROFIT_FLOOR', { detail: `${Math.round(e.unitProfitAtCpa)} < ${e.minProfit}` });
    if (a === 'SCALE_UP' && e.complete) {
      const mg = evaluateMoneyGuardForScale({ profitState: e.profitState, stockGuard: ctx.stock, creativeFatigueState: ctx.advisor?.fatigued ? 'FATIGUED' : null, settings });
      if (mg.decision === 'BLOCKED') add('MONEY_GUARD_BLOCKED', { detail: mg.reason });
      else if (mg.decision === 'WARN') add('MONEY_GUARD_WARN', { detail: mg.reason });
    }
  }
  if (needs.hardStop && (ctx.econ?.hardStopCpa == null)) add('HARD_STOP_NOT_CONFIGURED');

  // ---- 7. TESTING protection
  const tag = ctx.campaign?.tag;
  if (tag === 'TESTING') {
    const t = ctx.campaign?.testing || {};
    if (a === 'PAUSE' && !(t.stopSpend != null && (m.spend ?? 0) >= t.stopSpend)) add('TESTING_PROTECTED');
    if (a === 'SCALE_UP' && (m.purchases ?? 0) < (t.minSample ?? Math.max(10, minP * 2))) add('TESTING_SAMPLE');
  }

  // ---- 8. USER RULE metadata
  if (eff === 'AUTOPILOT' && decision.confidence !== 'HIGH') add('CONFIDENCE_TOO_LOW_FOR_AUTOPILOT');
  if ((ctx.ruleConflicts || []).length) add('RULE_CONFLICT', { detail: ctx.ruleConflicts[0].message });

  // ---- 9. ADVISOR (lowest precedence)
  const adv = ctx.advisor || null;
  if (a === 'SCALE_UP' && adv) {
    if (['INSUFFICIENT_DATA'].includes(adv.stage) || adv.dqBlocked) add('ADVISOR_DATA_GAP');
    else if (adv.primaryProblem && adv.primaryProblem !== 'NONE' && !['COD_STATUS_UNKNOWN'].includes(adv.primaryProblem)) add('ADVISOR_DISAGREES', { detail: adv.primaryProblem });
  }

  out.sort((x, y) => (PRECEDENCE_RANK[x.group] ?? 99) - (PRECEDENCE_RANK[y.group] ?? 99) || (x.severity === 'BLOCK' ? -1 : 1));
  const downgrade = out.some((b) => b.severity === 'DOWNGRADE');
  if (decision.wantExecute && (eff === 'SHADOW' || eff === 'OFF') && !out.some((b) => b.code === 'MODE_OFF')) { out.push(block('MODE_SHADOW_NO_EXECUTION')); out.sort((x, y) => (PRECEDENCE_RANK[x.group] ?? 99) - (PRECEDENCE_RANK[y.group] ?? 99) || (x.severity === 'BLOCK' ? -1 : 1)); }
  const blocks = out.filter((b) => b.severity === 'BLOCK');
  const canExecute = blocks.length === 0 && eff !== 'SHADOW' && eff !== 'OFF';
  return {
    effectiveMode: eff, blocks: out, primary: blocks[0] || null, downgrade, warnings: out.filter((b) => b.severity === 'WARN'),
    canExecute, canAutoExecute: canExecute && eff === 'AUTOPILOT' && !downgrade,
    wouldBe: blocks.length ? 'BLOCKED' : eff === 'SHADOW' ? 'SHADOW' : (eff === 'AUTOPILOT' && !downgrade ? 'AUTO' : 'PREPARED'),
    summary_ar: blocks.length ? `ممنوع: ${blocks[0].message}` : `${ACTION_LABEL_AR[a] || a} — كل الحواجز مرّت${downgrade ? ' (بيحتاج موافقة)' : ''}.`,
  };
}

export { FAMILY };
