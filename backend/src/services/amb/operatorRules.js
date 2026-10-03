// 🤖 AI Operator — RULES (pure, no DB, no network). 2026-10-03.
//
// A rule is STRUCTURED DATA: {name, action, mode, window, cooldown_hours, scope, conditions:{all:[{field,op,value}]}}.
// Free text (Arabic) is only ever COMPILED into this structure and shown for confirmation — it is never executed.
//
// This file owns: the field catalogue, rule validation (incl. contradictions and dangerous broad scope), rule-vs-rule conflict
// detection, condition evaluation (UNKNOWN is never converted to zero), the deterministic precedence order, and a deterministic
// Arabic rule parser that works without any AI call.
import { todayISO, addDaysISO } from './metricsEngine.js';

export const ACTIONS = ['OPEN', 'PAUSE', 'SCALE_UP', 'SCALE_DOWN', 'PREPARE_TEST'];
export const ACTION_LABEL_AR = { OPEN: 'فتح الحملة', PAUSE: 'إيقاف الحملة', SCALE_UP: 'زيادة الميزانية', SCALE_DOWN: 'تقليل الميزانية', PREPARE_TEST: 'تجهيز اختبار كرياتيف', ROLLBACK: 'رجوع للحالة السابقة' };
export const RULE_MODES = ['SHADOW', 'APPROVAL', 'AUTOPILOT'];
export const WINDOW_KEYS = ['today', 'last3', 'last7', 'last14', 'last30', 'last60'];
export const WINDOW_LABEL_AR = { today: 'اليوم', last3: 'آخر 3 أيام', last7: 'آخر 7 أيام', last14: 'آخر 14 يوم', last30: 'آخر 30 يوم', last60: 'آخر 60 يوم' };
const WINDOW_DAYS = { today: 1, last3: 3, last7: 7, last14: 14, last30: 30, last60: 60 };

/** Inclusive [from,to] date range for a rule window (today counts as day 1). */
export function windowRange(key, today = todayISO()) {
  const d = WINDOW_DAYS[key];
  if (!d) return null;
  return { from: addDaysISO(today, -(d - 1)), to: today, days: d, label: WINDOW_LABEL_AR[key] };
}

/**
 * Deterministic precedence — a higher entry ALWAYS wins over a lower one (spec §33). A user rule can never override a safety guard.
 * Documented here so the UI, the engine and the tests share ONE order.
 */
export const PRECEDENCE = [
  { key: 'EMERGENCY_STOP', label_ar: 'إيقاف الطوارئ' },
  { key: 'SAFETY', label_ar: 'حواجز الأمان (حدود الأكشن، الخسارة، سرعة الصرف، الجدول، الربط)' },
  { key: 'EXCEPTION', label_ar: 'الاستثناءات' },
  { key: 'DATA_QUALITY', label_ar: 'جودة البيانات' },
  { key: 'INVENTORY', label_ar: 'المخزون' },
  { key: 'PROFIT', label_ar: 'الربحية / Money Guard' },
  { key: 'TESTING', label_ar: 'حماية حملات الاختبار' },
  { key: 'USER_RULE', label_ar: 'قواعد المستخدم' },
  { key: 'ADVISOR', label_ar: 'توصية المستشار الذكي' },
];
export const PRECEDENCE_RANK = Object.fromEntries(PRECEDENCE.map((p, i) => [p.key, i]));

// ---------------------------------------------------------------------------
// Field catalogue
// ---------------------------------------------------------------------------
const num = (label, unit = null, extra = {}) => ({ type: 'number', label, unit, ...extra });
const en = (label, values, extra = {}) => ({ type: 'enum', label, values, ...extra });
export const FIELDS = {
  spend: num('الصرف', 'EGP'),
  purchases: num('الأوردرات/المشتريات (Meta)'),
  cpa: num('CPA', 'EGP'),
  ctr: num('CTR', '%'),
  cvr: num('معدل التحويل', '%'),
  cpc: num('CPC', 'EGP'),
  cpm: num('CPM', 'EGP'),
  roas: num('ROAS'),
  frequency: num('التكرار (Frequency)'),
  stock: num('المخزون الحالي', 'قطعة'),
  days_of_stock: num('أيام تغطية المخزون', 'يوم'),
  margin_pct: num('هامش الربح', '%'),
  target_cpa: num('Target CPA', 'EGP', { derived: true }),
  max_cpa: num('Max CPA', 'EGP', { derived: true }),
  hard_stop_cpa: num('Hard Stop CPA', 'EGP', { derived: true }),
  profit_state: en('حالة الربح', ['PROFITABLE', 'MARGIN_THIN', 'BREAK_EVEN', 'UNPROFITABLE', 'PARTIAL_DATA', 'INSUFFICIENT_DATA', 'UNKNOWN']),
  data_quality: en('جودة البيانات', ['VERIFIED', 'WARNING', 'BLOCKED', 'UNKNOWN']),
  campaign_status: en('حالة الحملة', ['ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED', 'WITH_ISSUES', 'IN_PROCESS', 'UNKNOWN']),
  campaign_age_hours: num('عمر الحملة (منذ أقدم ظهور)', 'ساعة'),
  campaign_tag: { type: 'string', label: 'وسم الحملة (TESTING/SCALE/...)' },
};
/**
 * COD / confirmation / delivery / return conditions. Deliberately NOT supported as rule fields: Easy Orders order statuses are not yet verified as
 * maintained (see easyOrdersStatus.getStoreStatusTrust), so a rule built on them would act on numbers that are not evidence. They are rejected at
 * validation, refused by the Arabic parser (never silently dropped from a sentence) and — as defence in depth — any rule that still carries one is
 * evaluated as COD-dependent (blocked with COD_UNRELIABLE unless the store's status trust is OK, and even then DATA_UNKNOWN: there is no source field).
 */
export const COD_FIELDS = ['confirmation_rate', 'delivery_rate', 'return_rate', 'confirmed_orders', 'delivered_orders', 'returned_orders', 'cod_confirmed', 'cod_delivered', 'cod_returned'];
export const usesCodField = (rule) => [...(rule?.conditions?.all || []), ...(rule?.conditions?.any || [])].some((c) => COD_FIELDS.includes(c?.field));
const COD_TERMS = /(تاكيد|مؤكد|اتاكد|تسليم|اتسلم|مسلم|مرتجع|مرتجعات|كاش|\bcod\b|confirmation|confirmed|deliver)/;
const NUMERIC_OPS = ['>', '>=', '<', '<=', '=', '!=', 'between'];
const ENUM_OPS = ['=', '!=', 'in'];
const STRING_OPS = ['=', '!=', 'in'];
export const OPS_FOR = { number: NUMERIC_OPS, enum: ENUM_OPS, string: STRING_OPS };
const MONEY_FIELDS = new Set(['spend', 'cpa', 'cpc', 'cpm', 'target_cpa', 'max_cpa', 'hard_stop_cpa']);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const err = (code, message, path = null) => ({ code, message, path });

/**
 * Validates a rule definition. Returns {ok, errors[], warnings[]}. Errors block saving; warnings are shown but allowed.
 * Never trusts a field/op/action it does not know — an AI-compiled rule goes through exactly this function.
 */
export function validateRule(rule) {
  const errors = [], warnings = [];
  if (!rule || typeof rule !== 'object') return { ok: false, errors: [err('INVALID_RULE', 'القاعدة غير صالحة.')], warnings };
  const name = String(rule.name || '').trim();
  if (!name) errors.push(err('NAME_REQUIRED', 'اسم القاعدة مطلوب.', 'name'));
  if (name.length > 120) errors.push(err('NAME_TOO_LONG', 'اسم القاعدة أطول من 120 حرف.', 'name'));
  if (!ACTIONS.includes(rule.action)) errors.push(err('ACTION_UNKNOWN', `الأكشن "${rule.action}" غير مدعوم. المسموح: ${ACTIONS.join(' / ')}.`, 'action'));
  if (rule.mode && !RULE_MODES.includes(rule.mode)) errors.push(err('MODE_UNKNOWN', `وضع القاعدة "${rule.mode}" غير مدعوم.`, 'mode'));
  const window = rule.window || 'today';
  if (!WINDOW_KEYS.includes(window)) errors.push(err('WINDOW_UNKNOWN', `فترة التحليل "${window}" غير مدعومة.`, 'window'));
  const cd = rule.cooldown_hours ?? 24;
  if (!Number.isInteger(cd) || cd < 1 || cd > 168) errors.push(err('COOLDOWN_RANGE', 'فترة التهدئة لازم تكون رقم صحيح بين 1 و168 ساعة.', 'cooldown_hours'));

  const conds = rule.conditions?.all;
  const anyConds = rule.conditions?.any;
  if (!Array.isArray(conds) || conds.length === 0) errors.push(err('CONDITIONS_REQUIRED', 'لازم شرط واحد على الأقل (AND).', 'conditions.all'));
  if (anyConds !== undefined && !Array.isArray(anyConds)) errors.push(err('CONDITIONS_ANY_INVALID', 'شروط OR لازم تكون قائمة.', 'conditions.any'));
  const all = [...(Array.isArray(conds) ? conds : []), ...(Array.isArray(anyConds) ? anyConds : [])];
  if (all.length > 14) errors.push(err('TOO_MANY_CONDITIONS', 'عدد الشروط أكبر من 14.', 'conditions'));
  all.forEach((c, i) => validateCondition(c, `conditions[${i}]`, errors));

  // contradiction inside one AND list (e.g. spend >= 200 AND spend < 100)
  if (Array.isArray(conds)) {
    const byField = {};
    for (const c of conds) { if (c && FIELDS[c.field]?.type === 'number' && isNum(c.value) || (c?.op === 'between' && Array.isArray(c.value))) (byField[c.field] = byField[c.field] || []).push(c); }
    for (const [f, list] of Object.entries(byField)) { const iv = intersectIntervals(list); if (iv && iv.empty) errors.push(err('CONTRADICTION', `الشروط على "${FIELDS[f].label}" متناقضة ومفيش قيمة تحققها.`, 'conditions')); }
  }

  // evidence gates — a destructive/consequential rule must carry a sample requirement
  const fieldsUsed = new Set(all.map((c) => c?.field));
  if (rule.action === 'PAUSE' && !fieldsUsed.has('spend')) errors.push(err('PAUSE_NEEDS_SPEND_GATE', 'قاعدة الإيقاف لازم تتضمن حد صرف (Spend) — مفيش إيقاف من غير عينة كافية.', 'conditions'));
  if (rule.action === 'SCALE_UP' && !(fieldsUsed.has('purchases') && (fieldsUsed.has('cpa') || fieldsUsed.has('roas')))) errors.push(err('SCALE_NEEDS_EVIDENCE', 'قاعدة التوسع لازم تتضمن عدد أوردرات + CPA (أو ROAS) كدليل.', 'conditions'));
  if (rule.action === 'OPEN' && !(fieldsUsed.has('cpa') || fieldsUsed.has('purchases'))) errors.push(err('OPEN_NEEDS_HISTORY', 'قاعدة الفتح لازم تعتمد على أداء تاريخي (CPA أو أوردرات) في فترة التحليل.', 'conditions'));
  if (rule.action === 'OPEN' && !fieldsUsed.has('campaign_status')) warnings.push(err('OPEN_STATUS_IMPLIED', 'قاعدة الفتح بتشتغل على الحملات المقفولة فقط (campaign_status = PAUSED) حتى لو ما كتبتهاش.', 'conditions'));
  if (rule.action === 'SCALE_UP' && all.some((c) => c?.field === 'cpa' && ['>', '>='].includes(c.op))) warnings.push(err('SCALE_ON_HIGH_CPA', 'قاعدة توسع بشرط CPA مرتفع — تأكد إنها مقصودة.', 'conditions'));

  // params
  const p = rule.action_params || {};
  if (['SCALE_UP', 'SCALE_DOWN'].includes(rule.action)) {
    if (!isNum(p.pct) || p.pct <= 0 || p.pct > 100) errors.push(err('SCALE_PCT_RANGE', 'نسبة تغيير الميزانية لازم تكون بين 1% و100%.', 'action_params.pct'));
    else if (p.pct > 30) warnings.push(err('SCALE_PCT_HIGH', `نسبة ${p.pct}% كبيرة — الحد الفعلي هيتحدد بحدود الأمان وقت التنفيذ.`, 'action_params.pct'));
  }

  // dangerous broad scope
  const scope = rule.scope || {};
  const hasStore = !!rule.store_id;
  const narrowed = !!(scope.productIds?.length || scope.productKeys?.length || scope.campaignIds?.length || scope.tags?.length);
  if (rule.mode === 'AUTOPILOT' && !hasStore) errors.push(err('AUTOPILOT_NEEDS_STORE', 'قاعدة Autopilot لازم تكون محددة بمتجر معين (مفيش Autopilot على كل المتاجر).', 'store_id'));
  if (rule.mode === 'AUTOPILOT' && ['SCALE_UP', 'OPEN'].includes(rule.action) && !narrowed) warnings.push(err('AUTOPILOT_BROAD_SCOPE', 'Autopilot بنطاق واسع (كل منتجات المتجر) — يفضل تحديد منتجات أو وسوم.', 'scope'));
  if (rule.action === 'PAUSE' && !narrowed && !(scope.excludeTags || []).includes('TESTING') && !all.some((c) => c?.field === 'campaign_tag')) warnings.push(err('PAUSE_NO_TESTING_PROTECTION', 'قاعدة إيقاف على كل الحملات من غير استثناء لحملات الاختبار (TESTING).', 'scope'));
  return { ok: errors.length === 0, errors, warnings };
}

function validateCondition(c, path, errors) {
  if (!c || typeof c !== 'object') return errors.push(err('CONDITION_INVALID', 'شرط غير صالح.', path));
  if (COD_FIELDS.includes(c.field)) return errors.push(err('COD_FIELD_UNSUPPORTED', 'شروط التأكيد/التسليم/المرتجعات (COD) مش مدعومة في القواعد لحد ما حالات Easy Orders تتوثق — ممنوعة.', `${path}.field`));
  const f = FIELDS[c.field];
  if (!f) return errors.push(err('FIELD_UNKNOWN', `الحقل "${c.field}" غير معروف.`, `${path}.field`));
  if (!OPS_FOR[f.type].includes(c.op)) return errors.push(err('OP_INVALID', `المعامل "${c.op}" مش مناسب لحقل "${f.label}".`, `${path}.op`));
  const v = c.value;
  if (f.type === 'number') {
    if (c.op === 'between') {
      if (!Array.isArray(v) || v.length !== 2 || !isNum(v[0]) || !isNum(v[1]) || v[0] >= v[1]) errors.push(err('VALUE_INVALID', `النطاق لـ"${f.label}" لازم يكون [من, إلى] بحيث من < إلى.`, `${path}.value`));
    } else if (v && typeof v === 'object' && !Array.isArray(v)) { // reference to another derived number, e.g. cpa > hard_stop_cpa * 1.2
      const ref = FIELDS[v.ref];
      if (!ref || ref.type !== 'number' || !ref.derived) errors.push(err('REF_INVALID', `المرجع "${v.ref}" غير صالح (المسموح: Target/Max/Hard Stop CPA).`, `${path}.value`));
      else if (v.mult !== undefined && (!isNum(v.mult) || v.mult <= 0 || v.mult > 10)) errors.push(err('REF_MULT_INVALID', 'معامل المرجع لازم يكون بين 0 و10.', `${path}.value`));
    } else if (!isNum(v)) errors.push(err('VALUE_INVALID', `القيمة لـ"${f.label}" لازم تكون رقم.`, `${path}.value`));
    else if (v < 0 && c.field !== 'roas') errors.push(err('VALUE_NEGATIVE', `القيمة لـ"${f.label}" لا يمكن أن تكون سالبة.`, `${path}.value`));
    else if (MONEY_FIELDS.has(c.field) && v > 1_000_000) errors.push(err('VALUE_TOO_LARGE', `القيمة لـ"${f.label}" كبيرة بشكل غير منطقي.`, `${path}.value`));
  } else if (f.type === 'enum') {
    const vals = Array.isArray(v) ? v : [v];
    if (!vals.length || vals.some((x) => !f.values.includes(x))) errors.push(err('VALUE_INVALID', `قيمة "${f.label}" لازم تكون من: ${f.values.join(' / ')}.`, `${path}.value`));
  } else if (f.type === 'string') {
    const vals = Array.isArray(v) ? v : [v];
    if (!vals.length || vals.some((x) => typeof x !== 'string' || !x.trim())) errors.push(err('VALUE_INVALID', `قيمة "${f.label}" لازم تكون نص.`, `${path}.value`));
  }
}

/** Interval [lo,hi] implied by numeric conditions on ONE field. `empty` = no value can satisfy all of them. */
function intersectIntervals(conds) {
  let lo = -Infinity, hi = Infinity, loInc = true, hiInc = true;
  for (const c of conds) {
    if (c.op === 'between' && Array.isArray(c.value)) { lo = Math.max(lo, c.value[0]); hi = Math.min(hi, c.value[1]); continue; }
    if (!isNum(c.value)) continue;
    if (c.op === '>') { if (c.value >= lo) { lo = c.value; loInc = false; } }
    else if (c.op === '>=') { if (c.value > lo) { lo = c.value; loInc = true; } }
    else if (c.op === '<') { if (c.value <= hi) { hi = c.value; hiInc = false; } }
    else if (c.op === '<=') { if (c.value < hi) { hi = c.value; hiInc = true; } }
    else if (c.op === '=') { lo = Math.max(lo, c.value); hi = Math.min(hi, c.value); }
  }
  const empty = lo > hi || (lo === hi && !(loInc && hiInc));
  return { lo, hi, empty };
}

// ---------------------------------------------------------------------------
// Rule-vs-rule conflicts
// ---------------------------------------------------------------------------
const OPPOSED = new Set(['OPEN|PAUSE', 'PAUSE|OPEN', 'SCALE_UP|PAUSE', 'PAUSE|SCALE_UP', 'SCALE_UP|SCALE_DOWN', 'SCALE_DOWN|SCALE_UP', 'OPEN|SCALE_DOWN', 'SCALE_DOWN|OPEN']);
function scopesOverlap(a, b) {
  if (a.store_id && b.store_id && a.store_id !== b.store_id) return false;
  const sa = a.scope || {}, sb = b.scope || {};
  for (const key of ['productIds', 'productKeys', 'campaignIds', 'tags']) {
    const x = sa[key] || [], y = sb[key] || [];
    if (x.length && y.length && !x.some((v) => y.includes(v))) return false;
  }
  return true;
}
function condsOverlap(a, b) {
  const fields = new Set([...(a.conditions?.all || []), ...(b.conditions?.all || [])].map((c) => c.field));
  for (const f of fields) {
    if (FIELDS[f]?.type !== 'number') continue;
    const both = [...(a.conditions?.all || []), ...(b.conditions?.all || [])].filter((c) => c.field === f);
    if (both.length < 2) continue;
    const iv = intersectIntervals(both);
    if (iv.empty) return false; // the two rules can never hold at the same time on this field
  }
  return true;
}
/** Pairs of ENABLED rules that could fire on the same campaign with opposed actions. Resolution is deterministic (priority, then safety guards). */
export function detectRuleConflicts(rules) {
  const live = rules.filter((r) => r.enabled !== false);
  const out = [];
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i], b = live[j];
    if (!scopesOverlap(a, b)) continue;
    if (a.action === b.action) {
      if (JSON.stringify(a.conditions) === JSON.stringify(b.conditions) && a.window === b.window) out.push({ kind: 'DUPLICATE_RULE', a: a.id ?? a.name, b: b.id ?? b.name, message: `القاعدتان "${a.name}" و"${b.name}" متطابقتان.` });
      continue;
    }
    if (!OPPOSED.has(`${a.action}|${b.action}`) || !condsOverlap(a, b)) continue;
    const winner = (a.priority ?? 100) <= (b.priority ?? 100) ? a : b;
    out.push({ kind: 'CONTRADICTORY_ACTIONS', a: a.id ?? a.name, b: b.id ?? b.name, winner: winner.id ?? winner.name, message: `"${a.name}" (${ACTION_LABEL_AR[a.action]}) و"${b.name}" (${ACTION_LABEL_AR[b.action]}) ممكن يتطبقوا على نفس الحملة. الأولوية للأقل رقمًا (${winner.name})، وحواجز الأمان بتغلب الاتنين.` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
const cmp = {
  '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b,
  '=': (a, b) => a === b, '!=': (a, b) => a !== b,
};
function resolveExpected(c, fields) {
  if (c.value && typeof c.value === 'object' && !Array.isArray(c.value) && c.value.ref) {
    const base = fields[c.value.ref];
    return base === null || base === undefined ? null : base * (c.value.mult ?? 1);
  }
  return c.value;
}
/**
 * Evaluates AND (+ optional OR) conditions against flat `fields`. A missing/null actual is UNKNOWN — it never passes and is never
 * treated as 0. Returns {matched, unknown, details[]}; `unknown` means "could not be decided because data is missing".
 */
export function evaluateConditions(conditions, fields) {
  const details = [];
  const one = (c) => {
    const actual = fields[c.field] === undefined ? null : fields[c.field];
    const expected = resolveExpected(c, fields);
    const d = { field: c.field, label: FIELDS[c.field]?.label || c.field, op: c.op, expected, actual, pass: false, unknown: false };
    if (actual === null || actual === undefined || expected === null || expected === undefined) { d.unknown = true; details.push(d); return d; }
    if (c.op === 'between') d.pass = Number(actual) >= expected[0] && Number(actual) <= expected[1];
    else if (c.op === 'in') d.pass = (Array.isArray(expected) ? expected : [expected]).includes(actual);
    else if (FIELDS[c.field]?.type === 'number') d.pass = cmp[c.op](Number(actual), Number(expected));
    else d.pass = cmp[c.op](actual, expected);
    details.push(d); return d;
  };
  const andRes = (conditions?.all || []).map(one);
  const orRes = (conditions?.any || []).map(one);
  const andOk = andRes.every((d) => d.pass);
  const orOk = !orRes.length || orRes.some((d) => d.pass);
  const unknown = !(andOk && orOk) && [...andRes, ...orRes].some((d) => d.unknown) && ![...andRes, ...orRes].some((d) => !d.pass && !d.unknown);
  return { matched: andOk && orOk, unknown, details };
}

export function describeCondition(d) {
  const val = Array.isArray(d.expected) ? d.expected.join('–') : d.expected;
  const act = d.actual === null || d.actual === undefined ? 'غير معروف' : (typeof d.actual === 'number' ? Math.round(d.actual * 100) / 100 : d.actual);
  return `${d.label} ${d.op} ${val} (الفعلي: ${act})${d.unknown ? ' ⚠️ ناقص بيانات' : d.pass ? ' ✓' : ' ✗'}`;
}

// ---------------------------------------------------------------------------
// Deterministic Arabic -> structured rule (no AI). Always returns a DRAFT: disabled, SHADOW, awaiting confirmation.
// ---------------------------------------------------------------------------
const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
const normalizeAr = (s) => String(s || '').toLowerCase().replace(/[٠-٩]/g, (d) => AR_DIGITS[d]).replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[ًٌٍَُِّْ]/g, '').replace(/\s+/g, ' ').trim();

export function parseArabicRule(text) {
  const raw = String(text || '').trim();
  const t = normalizeAr(raw);
  const out = { ok: false, rule: null, notes: [], unparsed: [] };
  if (!t) { out.notes.push('النص فاضي.'); return out; }
  let action = null;
  if (/(اقفل|اقفلها|وقف|اوقف|ايقاف|اوقفها|بوز)/.test(t)) action = 'PAUSE';
  else if (/(افتح|افتحها|شغل|شغلها|فعل|فعلها)/.test(t)) action = 'OPEN';
  else if (/(زود|زوّد|كبر|وسع|ارفع)/.test(t)) action = 'SCALE_UP';
  else if (/(قلل|نزل|خفض)/.test(t)) action = 'SCALE_DOWN';
  if (!action) { out.notes.push('مقدرتش أحدد الأكشن (إيقاف/فتح/زيادة/تقليل ميزانية).'); return out; }
  // never drop a COD clause silently (that would make the rule broader than the user wrote)
  if (COD_TERMS.test(t)) { out.unparsed.push('COD'); out.notes.push('الجملة فيها شرط تأكيد/تسليم/مرتجعات (COD) — مش مدعوم كشرط في القواعد لحد ما حالات Easy Orders تتوثق. شيله من النص وجرّب تاني.'); return out; }

  const all = [];
  const nums = (re) => { const m = t.match(re); return m ? Number(m[1]) : null; };
  // spend
  const spendAtLeast = nums(/(?:صرف(?:ت|ها)?|صرفه|spend)\s*(?:اكتر من|اكثر من|اكتر|على الاقل|تعدي|>=?)?\s*(\d+(?:\.\d+)?)/);
  if (spendAtLeast !== null) all.push({ field: 'spend', op: '>=', value: spendAtLeast });
  // zero orders
  if (/(من غير|بدون|ولا|صفر|0)\s*(?:اي\s*)?(?:اوردر|طلب|شراء|مشتريات|اوردرات)/.test(t) || /(?:اوردر|طلب)\s*(?:=|يساوي)\s*0/.test(t)) all.push({ field: 'purchases', op: '=', value: 0 });
  const ordersAtLeast = nums(/(?:اوردرات|اوردر|طلبات|مشتريات)\s*(?:اكتر من|على الاقل|>=?)\s*(\d+)/);
  if (ordersAtLeast !== null) all.push({ field: 'purchases', op: '>=', value: ordersAtLeast });
  // CPA
  const cpaBetween = t.match(/cpa\s*(?:بين|من)\s*(\d+(?:\.\d+)?)\s*(?:و|الى|ل|لـ|-|حتى)\s*(\d+(?:\.\d+)?)/);
  if (cpaBetween) all.push({ field: 'cpa', op: 'between', value: [Number(cpaBetween[1]), Number(cpaBetween[2])] });
  else {
    const cpaLess = nums(/cpa\s*(?:اقل من|اقل|<=?)\s*(\d+(?:\.\d+)?)/);
    const cpaMore = nums(/cpa\s*(?:اكتر من|اكثر من|اعلي من|اعلى من|>=?)\s*(\d+(?:\.\d+)?)/);
    if (cpaLess !== null) all.push({ field: 'cpa', op: '<=', value: cpaLess });
    if (cpaMore !== null) all.push({ field: 'cpa', op: '>=', value: cpaMore });
    if (/cpa\s*(?:اقل من|اقل)\s*(?:ال)?target|cpa\s*(?:اقل من|اقل)\s*(?:الهدف)/.test(t)) all.push({ field: 'cpa', op: '<=', value: { ref: 'target_cpa' } });
    if (/cpa\s*(?:اكتر من|اعلي من|اعلى من|تعدي)\s*(?:ال)?hard\s*stop/.test(t)) all.push({ field: 'cpa', op: '>', value: { ref: 'hard_stop_cpa' } });
  }
  // stock
  const stockMore = nums(/(?:المخزون|ستوك|stock)\s*(?:اكتر من|اكثر من|اكبر من|اعلي من|>=?|فوق)\s*(\d+)/);
  if (stockMore !== null) all.push({ field: 'stock', op: '>', value: stockMore });
  const daysCover = nums(/(?:المخزون يكفي|يكفي)\s*(\d+)\s*(?:ايام|يوم)/);
  if (daysCover !== null) all.push({ field: 'days_of_stock', op: '>=', value: daysCover });
  if (/(اسبوع)\s*(?:مخزون)?|المخزون يكفي اسبوع/.test(t) && /مخزون/.test(t) && daysCover === null) all.push({ field: 'days_of_stock', op: '>=', value: 7 });
  // profit
  if (/(ربح موجب|مربح|مربحه|ربحيه ايجابيه)/.test(t)) all.push({ field: 'profit_state', op: 'in', value: ['PROFITABLE', 'MARGIN_THIN'] });
  // campaign off (for OPEN)
  if (action === 'OPEN') all.push({ field: 'campaign_status', op: '=', value: 'PAUSED' });
  if (action !== 'OPEN') all.push({ field: 'campaign_status', op: '=', value: 'ACTIVE' });
  // exception: testing
  const excludeTesting = /(الا|عدا|ماعدا|باستثناء)\s*(?:حملات\s*)?(?:ال)?(?:تيست|تست|testing|test|اختبار)/.test(t);
  if (excludeTesting) all.push({ field: 'campaign_tag', op: '!=', value: 'TESTING' });

  // window
  let window = 'today';
  if (/(اخر|اخر)\s*14\s*يوم|اسبوعين/.test(t)) window = 'last14';
  else if (/(اخر)\s*30\s*يوم|اخر شهر|شهر/.test(t)) window = 'last30';
  else if (/(اخر)\s*60\s*يوم|شهرين/.test(t)) window = 'last60';
  else if (/(اخر)\s*7\s*ايام|اخر اسبوع|اسبوع/.test(t) && !/مخزون/.test(t)) window = 'last7';
  else if (/(اخر)\s*3\s*ايام|3 ايام/.test(t)) window = 'last3';
  else if (/(النهارده|اليوم|انهارده)/.test(t)) window = 'today';
  else out.notes.push('مذكرتش فترة تحليل — اخترت "اليوم". راجعها.');

  // sample gates for pause when not stated
  if (action === 'PAUSE' && !all.some((c) => c.field === 'spend')) out.notes.push('قاعدة الإيقاف محتاجة حد صرف — أضفه قبل الحفظ.');

  const conds = all.filter((c) => c.field !== 'campaign_status' || action !== 'PAUSE' || true);
  const params = {};
  if (['SCALE_UP', 'SCALE_DOWN'].includes(action)) { const pct = nums(/(\d+(?:\.\d+)?)\s*%/); params.pct = pct ?? 10; if (pct === null) out.notes.push('مذكرتش نسبة — اخترت 10%.'); }
  out.rule = {
    name: raw.slice(0, 80), description: raw, action, window, mode: 'SHADOW', enabled: false, cooldown_hours: 24, priority: 100, source: 'NL', nl_text: raw,
    store_id: null, scope: {}, action_params: params, conditions: { all: conds },
  };
  out.ok = conds.length > 0;
  if (!out.ok) out.notes.push('مقدرتش أستخرج شروط واضحة من النص.');
  return out;
}
