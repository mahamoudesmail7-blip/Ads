// 🤖 AI Operator — RULE TEMPLATES (spec 79–83). Templates are EDITABLE starting points, never a mandatory strategy: each one instantiates a normal draft rule
// (disabled, SHADOW or APPROVAL — never AUTOPILOT) that goes through the same validation as any rule. Parameters are chosen by the user.
// Entries with kind GUARD describe protections that are already built into the guard chain (they need no rule) so the user can see and tune them.
import { validateRule } from './operatorRules.js';

const C = (field, op, value) => ({ field, op, value });

export const TEMPLATES = [
  {
    key: 'ZERO_ORDER_STOP', kind: 'RULE', title: 'إيقاف حملة صرفت من غير أوردرات', category: 'OPTIMIZATION',
    description: 'بيجهّز إيقاف لما الصرف يوصل X ومفيش أوردرات، بعد عمر أدنى Y ساعة، ومش حملة اختبار، وجودة البيانات سليمة. الاستثناءات بتتغلب عليه دايمًا.',
    params: [{ key: 'spend', label: 'الصرف X (ج.م)', default: 180, min: 1 }, { key: 'minAgeHours', label: 'أدنى عمر للحملة Y (ساعة)', default: 24, min: 0 }],
    defaultMode: 'SHADOW',
    build: (p) => ({ name: `إيقاف: صرف ≥ ${p.spend} بدون أوردرات`, action: 'PAUSE', window: 'today', mode: 'SHADOW', cooldown_hours: 12, priority: 50,
      conditions: { all: [C('spend', '>=', p.spend), C('purchases', '=', 0), C('campaign_age_hours', '>=', p.minAgeHours), C('campaign_status', '=', 'ACTIVE'), C('campaign_tag', '!=', 'TESTING'), C('data_quality', 'in', ['VERIFIED', 'WARNING'])] } }), // not BLOCKED / not UNKNOWN (a WARNING such as missing age/gender breakdown does not affect a stop-loss)
  },
  {
    key: 'HARD_CPA_STOP', kind: 'RULE', title: 'إيقاف عند تجاوز Hard Stop CPA', category: 'HARD_SAFETY',
    description: 'قاعدة أمان: لو الـCPA فوق Hard Stop CPA المسجّل للمنتج بعد عينة كافية، بيجهّز إيقاف. لو Hard Stop CPA مش مسجّل، القاعدة بتتوقف وتطلب تسجيله (مفيش افتراض).',
    params: [{ key: 'spend', label: 'أدنى صرف للعينة (ج.م)', default: 250, min: 1 }, { key: 'purchases', label: 'أدنى أوردرات', default: 2, min: 1 }],
    defaultMode: 'SHADOW',
    build: (p) => ({ name: `Hard Stop CPA (صرف ≥ ${p.spend}، أوردرات ≥ ${p.purchases})`, action: 'PAUSE', window: 'last3', mode: 'SHADOW', cooldown_hours: 12, priority: 10,
      conditions: { all: [C('spend', '>=', p.spend), C('purchases', '>=', p.purchases), C('cpa', '>', { ref: 'hard_stop_cpa' }), C('campaign_status', '=', 'ACTIVE'), C('campaign_tag', '!=', 'TESTING')] } }),
  },
  {
    key: 'WINNER_SCALE', kind: 'RULE', title: 'توسع خطوة للحملة الرابحة', category: 'OPTIMIZATION',
    description: 'لما أوردرات ≥ الحد الأدنى و CPA ≤ Target CPA والربحية والمخزون سليمين وفيه تغطية مخزون، بيجهّز زيادة ميزانية بخطوة صغيرة. افتراضيًا بموافقتك.',
    params: [{ key: 'purchases', label: 'أدنى أوردرات', default: 5, min: 1 }, { key: 'pct', label: 'نسبة الزيادة %', default: 15, min: 1, max: 100 }, { key: 'daysCover', label: 'أدنى أيام تغطية مخزون', default: 7, min: 0 }],
    defaultMode: 'APPROVAL',
    build: (p) => ({ name: `توسع ${p.pct}% (أوردرات ≥ ${p.purchases}، CPA ≤ Target)`, action: 'SCALE_UP', window: 'last7', mode: 'APPROVAL', cooldown_hours: 24, priority: 60, action_params: { pct: p.pct },
      conditions: { all: [C('purchases', '>=', p.purchases), C('cpa', '<=', { ref: 'target_cpa' }), C('profit_state', 'in', ['PROFITABLE', 'MARGIN_THIN']), C('days_of_stock', '>=', p.daysCover), C('campaign_status', '=', 'ACTIVE')] } }),
  },
  {
    key: 'STOCK_PROTECTION', kind: 'RULE', title: 'حماية المخزون (إيقاف اختياري)', category: 'HARD_SAFETY',
    description: 'منع الفتح والتوسع لما المخزون عند/تحت الحد الأدنى مبني أصلًا في حواجز الأمان. القاعدة دي اختيارية: بتجهّز إيقاف لما تغطية المخزون تقل عن X يوم. مش مفروضة عليك.',
    params: [{ key: 'days', label: 'أيام التغطية (≤)', default: 2, min: 0 }],
    defaultMode: 'SHADOW',
    build: (p) => ({ name: `إيقاف عند تغطية مخزون ≤ ${p.days} يوم`, action: 'PAUSE', window: 'today', mode: 'SHADOW', cooldown_hours: 12, priority: 20,
      conditions: { all: [C('days_of_stock', '<=', p.days), C('spend', '>=', 1), C('campaign_status', '=', 'ACTIVE')] } }),
  },
  {
    key: 'TESTING_PROTECTION', kind: 'GUARD', title: 'حماية حملات الاختبار (مبنية)', category: 'HARD_SAFETY',
    description: 'أي حملة بوسم TESTING محمية من الإيقاف العام، ولها حد صرف إيقاف وأدنى عينة للتوسع خاصين بيها. بتتحدد من وسم الحملة (تفاصيل القرار ← وسم الحملة).',
  },
  {
    key: 'SPEND_VELOCITY', kind: 'GUARD', title: 'تنبيه/تجميد سرعة الصرف (مبني)', category: 'HARD_SAFETY',
    description: 'لو حملة صرفت أكتر من حد معين في آخر ساعة من غير نتيجة، الفتح والتوسع بيتجمدوا عليها. الحد بيتعدل من "الأمان والحدود" (spendVelocity).',
  },
  {
    key: 'CREATIVE_FATIGUE', kind: 'RULE', title: 'استجابة لإجهاد الكرييتف', category: 'OPTIMIZATION',
    description: 'لما التكرار (Frequency) يعلى مع صرف كافي، بيجهّز تقليل ميزانية بسيط لحد ما تبدّل الكرييتف — بيغيّر الميزانية بس، مش كل حاجة.',
    params: [{ key: 'frequency', label: 'التكرار (≥)', default: 3.5, min: 1 }, { key: 'spend', label: 'أدنى صرف', default: 200, min: 1 }, { key: 'pct', label: 'نسبة التقليل %', default: 20, min: 1, max: 100 }],
    defaultMode: 'APPROVAL',
    build: (p) => ({ name: `إجهاد كرييتف: تكرار ≥ ${p.frequency} → تقليل ${p.pct}%`, action: 'SCALE_DOWN', window: 'last3', mode: 'APPROVAL', cooldown_hours: 24, priority: 70, action_params: { pct: p.pct },
      conditions: { all: [C('frequency', '>=', p.frequency), C('spend', '>=', p.spend), C('campaign_status', '=', 'ACTIVE'), C('campaign_tag', '!=', 'TESTING')] } }),
  },
  {
    key: 'PROFIT_PROTECTION', kind: 'RULE', title: 'حماية الربح', category: 'HARD_SAFETY',
    description: 'منع التوسع لما الربحية غير مثبتة أو سالبة مبني في الحواجز. القاعدة دي بتجهّز تقليل ميزانية لما المنتج بيخسر بشكل موثّق (بعد عينة). لو الاقتصاديات ناقصة بتتوقف — مفيش استنتاج.',
    params: [{ key: 'purchases', label: 'أدنى أوردرات', default: 3, min: 1 }, { key: 'pct', label: 'نسبة التقليل %', default: 20, min: 1, max: 100 }],
    defaultMode: 'APPROVAL',
    build: (p) => ({ name: `حماية ربح: خسارة موثّقة → تقليل ${p.pct}%`, action: 'SCALE_DOWN', window: 'last7', mode: 'APPROVAL', cooldown_hours: 24, priority: 30, action_params: { pct: p.pct },
      conditions: { all: [C('profit_state', '=', 'UNPROFITABLE'), C('purchases', '>=', p.purchases), C('campaign_status', '=', 'ACTIVE')] } }),
  },
];

export function listTemplates() {
  return TEMPLATES.map(({ build, ...t }) => t);
}

/** Instantiates a template with the user's parameters -> a DRAFT rule (disabled, never AUTOPILOT) + its validation. Nothing is saved here. */
export function instantiateTemplate(key, params = {}) {
  const t = TEMPLATES.find((x) => x.key === key);
  if (!t) { const e = new Error(`قالب غير معروف: ${key}`); e.status = 404; throw e; }
  if (t.kind !== 'RULE') { const e = new Error('ده حاجز مبني مش قاعدة — مفيش حاجة تتفعّل.'); e.status = 400; throw e; }
  const p = {};
  for (const def of t.params) {
    const raw = params[def.key] ?? def.default; const n = Number(raw);
    if (!Number.isFinite(n) || (def.min != null && n < def.min) || (def.max != null && n > def.max)) { const e = new Error(`${def.label}: قيمة غير صالحة (${raw}).`); e.status = 400; throw e; }
    p[def.key] = n;
  }
  const rule = { ...t.build(p), enabled: false, source: 'TEMPLATE', description: t.description, template_key: key };
  rule.mode = ['SHADOW', 'APPROVAL'].includes(rule.mode) ? rule.mode : 'SHADOW'; // a template can never produce an AUTOPILOT rule
  return { template: key, params: p, rule, validation: validateRule(rule) };
}
