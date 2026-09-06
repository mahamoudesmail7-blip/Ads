// AI Media Buyer — Claude Analysis Layer (layer 5). Claude ONLY writes
// natural-language interpretation on top of numbers/classifications/
// priorities that are already final and deterministic. It never computes a
// metric, never changes a classification, never emits a Meta action. If the
// API is unset/failing/malformed, deterministic templates take over so the
// page is never blocked (same contract as services/aiActionPlan.js).
import { askClaude } from '../ai.js';
import { prisma } from '../../prisma.js';

const SYSTEM_PROMPT = `أنت "AI Media Buyer" — محلل شراء إعلانات Meta لمتجر تجارة إلكترونية مصري (COD).
هتستلم:
1. "recommendations": قائمة توصيات، كل واحدة معاها decision و action_type و priority و confidence و risk و data_sufficiency و metrics و target_metrics و rule_engine — كلها نهائية ومحسوبة مسبقًا. ممنوع تغيّر أي رقم أو تصنيف أو تخترع أكشن.
2. "history": ملخص نتائج قرارات سابقة (اختياري) — استخدمه عشان تكون أكثر تحفظًا لو قرار زيّه فشل قبل كده.
مهم: كل توصية معاها "current_status" = حالة العنصر الحالية في Meta (ACTIVE / PAUSED / ...). دي الحقيقة — التزم بيها. ممنوع تقول "لازم يتوقف فورًا" أو "أوقفه" لعنصر مش ACTIVE، وممنوع تقول "شغّله" لعنصر ACTIVE بالفعل. لو الحالة مش متوافقة مع الأكشن، وضّح كده في الشرح.
لكل توصية اكتب شرح منظّم بالعربي المصري البسيط، كل حقل جملة قصيرة مبنية على الأرقام المعطاة فعليًا فقط (ممنوع كلام عام زي "راقب الأداء"):
- "whatHappened": إيه اللي حصل بالأرقام.
- "why": ليه ده بيحصل / السبب المحتمل.
- "whatToDo": الإجراء المحدد المطلوب.
- "expectedBenefit": الفايدة المتوقعة لو اتعمل (كمّي لو ممكن).
- "risk": المخاطرة لو اتعمل.
- "dataSupport": قد إيه البيانات كافية للقرار ده.
وبعدها "executive_summary" — 3-4 جمل: صحة الحساب، أهم فرصة، أكبر هدر/مشكلة، أفضل عنصر أداءً.
رجّع JSON فقط بالشكل:
{"executive_summary":"...","items":[{"key":"<id>","whatHappened":"...","why":"...","whatToDo":"...","expectedBenefit":"...","risk":"...","dataSupport":"..."}]}`;

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

/** Tolerant JSON extraction: strips ```json fences, then tries a direct parse, then the outermost {…} span. Returns null on failure (caller falls back to templates). */
function parseJsonLoose(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

/** Meta effective_status other than ACTIVE means the entity is not delivering. */
function notActive(r) {
  const s = r.current_metrics?.metaStatus;
  return s && s !== 'ACTIVE';
}

function deterministicReason(r) {
  const m = r.current_metrics || {};
  const cpa = n(m.cpa);
  const spend = Math.round(m.spend || 0);
  // Never tell the owner to "stop it now" for something already stopped in Meta.
  if (notActive(r) && (['PAUSE', 'PAUSE_LOSER'].includes(r.decision) || r.action_type === 'PAUSE')) {
    return 'العنصر متوقف بالفعل في Meta — لا يوجد إجراء مطلوب.';
  }
  switch (r.decision) {
    case 'PAUSE':
    case 'PAUSE_LOSER':
      return (m.purchases || 0) === 0
        ? `صرف ${spend} جنيه من غير أي شراء — فوق حد الإيقاف.`
        : `CPA ${cpa?.toFixed(1)} جنيه فوق الحد الأقصى المسموح بصرف ${spend} جنيه.`;
    case 'REDUCE_BUDGET':
      return `الأداء داخل نطاق التحذير (CPA ${cpa?.toFixed(1)} جنيه) — تقليل الميزانية أأمن من الإيقاف الكامل.`;
    case 'INCREASE_BUDGET':
    case 'SCALE':
      return `CPA ${cpa?.toFixed(1)} جنيه أقل من الهدف مع ${m.purchases} شراء وبيانات ${m.dataSufficiency === 'STRONG' ? 'قوية' : 'كافية'} — فرصة توسّع محسوبة.`;
    case 'DUPLICATE_WINNER':
      return `عنصر رابح مستقر (CPA ${cpa?.toFixed(1)} جنيه) — تكراره في استهداف/مجموعة جديدة بيوسّع الوصول بدون لمس الأصل.`;
    case 'TEST_NEW_CREATIVE':
      return `مؤشرات إجهاد كرييتف واضحة — اختبار كرييتف جديد قبل ما الأداء يقع أكتر.`;
    case 'MONITOR':
      return `البيانات لسه مش كفاية لقرار (${spend} جنيه صرف، ${m.purchases ?? 0} شراء) — استمرار المراقبة.`;
    default:
      return `CPA ${cpa != null ? cpa.toFixed(1) + ' جنيه' : 'غير متاح'} بصرف ${spend} جنيه — القرار: ${r.decision}.`;
  }
}

/** Deterministic 6-part explanation — same shape Claude is asked for, used when the API is unset/failing so the Action Plan is never generic and never blocked. */
function deterministicExplain(r) {
  const m = r.current_metrics || {};
  const cpa = n(m.cpa);
  const spend = Math.round(m.spend || 0);
  const target = n(r.target_metrics?.targetCpa);
  const cur = n(r.current_budget);
  const next = n(r.recommended_budget);
  if (notActive(r) && (['PAUSE', 'PAUSE_LOSER'].includes(r.decision) || r.action_type === 'PAUSE')) {
    return {
      whatHappened: `${r.entity_name}: الحالة في Meta دلوقتي "${m.metaStatus}" — العنصر مش شغّال.`,
      why: 'اتوقف من Meta Ads Manager أو توقف تلقائيًا.',
      whatToDo: 'مفيش إجراء مطلوب — التوصية دي اتحلّت من برّه النظام.',
      expectedBenefit: '—',
      risk: '—',
      dataSupport: `الحالة الحالية "${m.metaStatus}" هي المرجع.`,
    };
  }
  const dsAr = { STRONG: 'قوية', MODERATE: 'كافية', WEAK: 'ضعيفة' }[r.data_sufficiency] || r.data_sufficiency;
  const base = {
    whatHappened: `${r.entity_name}: صرف ${spend} ج، ${m.purchases ?? 0} شراء${cpa != null ? `، CPA ${cpa.toFixed(1)} ج` : ''}${m.roas != null ? `، ROAS ${m.roas.toFixed(1)}×` : ''}.`,
    dataSupport: `كفاية البيانات ${dsAr} (صرف ${spend} ج${m.purchases != null ? `، ${m.purchases} شراء` : ''}). الثقة: ${r.confidence}.`,
  };
  switch (r.decision) {
    case 'PAUSE': case 'PAUSE_LOSER':
      return { ...base,
        why: (m.purchases || 0) === 0 ? `صرف تعدّى حد الإيقاف (${target ? Math.round(target * 2) : '—'} ج) من غير أي شراء — استهداف/كرييتيف مش شغّال.` : `CPA فوق الحد الأقصى المسموح — وحدة الاقتصاد سالبة على كل أوردر.`,
        whatToDo: `أوقف ${r.level === 'ad' ? 'الإعلان' : r.level === 'adset' ? 'المجموعة' : 'الحملة'} فورًا${(m.purchases || 0) > 0 ? ' أو قلّل ميزانيتها لأدنى حد لحد ما تجرب زاوية جديدة' : ''}.`,
        expectedBenefit: `وقف نزيف ~${spend} ج كل فترة زيّ دي، وإعادة توجيه الميزانية للعناصر الرابحة.`,
        risk: `منخفضة — العنصر خاسر بالفعل. لو أوقفته ممكن الخوارزمية تعيد توزيع التعلّم.` };
    case 'REDUCE_BUDGET':
      return { ...base,
        why: `CPA داخل نطاق التحذير (فوق الهدف وتحت الحد الأقصى) — الأداء ضعيف بس مش خسارة كاملة.`,
        whatToDo: `قلّل الميزانية من ${cur ?? '—'} ج لـ ${next ?? '—'} ج (${r.budget_change_pct ?? '—'}%) وراقب 24 ساعة.`,
        expectedBenefit: `تقليل الصرف غير الفعّال مع الحفاظ على التعلّم، وفرصة يرجع CPA للهدف بحجم أقل.`,
        risk: `منخفضة–متوسطة — تقليل كبير ممكن يبطّئ التسليم؛ التقليل هنا محسوب.` };
    case 'INCREASE_BUDGET': case 'SCALE':
      return { ...base,
        why: `CPA أقل من الهدف${target ? ` (${cpa?.toFixed(1)} مقابل ${Math.round(target)} ج)` : ''} مع حجم شراء كافٍ وبيانات ${dsAr} — كفاءة تتحمّل حجم أكبر.`,
        whatToDo: `زوّد الميزانية من ${cur ?? '—'} ج لـ ${next ?? '—'} ج (+${r.budget_change_pct ?? '—'}%) بالتدريج مع متابعة CPA.`,
        expectedBenefit: `زيادة عدد الأوردرات تقريبًا بنفس نسبة الزيادة لو ثبت CPA — أي ~${r.budget_change_pct ?? 0}% أوردرات إضافية.`,
        risk: `متوسطة — التوسع السريع ممكن يرفع CPA؛ الزيادة مقيّدة بـ${r.budget_change_pct ?? '—'}% وفترة تهدئة.` };
    case 'DUPLICATE_WINNER':
      return { ...base,
        why: `عنصر رابح مستقر — تكراره في استهداف/مجموعة جديدة بيوسّع الوصول من غير ما يلمس الأصل.`,
        whatToDo: `اعمل نسخة من العنصر في مجموعة/استهداف جديد (أكشن مسودة — يتنفّذ يدويًا).`,
        expectedBenefit: `مسار توسّع أفقي بدون المخاطرة بإجهاد الجمهور الحالي أو زعزعة تعلّم الأصل.`,
        risk: `منخفضة — الأصل مايتغيّرش؛ التكلفة هي ميزانية اختبار النسخة الجديدة.` };
    case 'TEST_NEW_CREATIVE':
      return { ...base,
        why: `مؤشرات إجهاد كرييتف (تكرار مرتفع / CTR بينزل / CPC بيرتفع) — الأداء هيقع لو الكرييتيف مااتجدّدش.`,
        whatToDo: `جهّز 1-2 كرييتيف جديد حوالين نفس الزاوية الرابحة واختبرهم في نفس المجموعة.`,
        expectedBenefit: `الحفاظ على CPA الحالي ومنع تدهوره؛ احتمال كرييتيف جديد يتفوّق.`,
        risk: `منخفضة — اختبار كرييتيف بميزانية محدودة؛ الأصل شغّال لحد ما البديل يثبت.` };
    default: // MONITOR / HOLD
      return { ...base,
        why: `البيانات لسه مش كفاية لقرار توسّع أو إيقاف واثق.`,
        whatToDo: `سيبها شغّالة وكمّل تجميع بيانات؛ راجع تاني بعد ما توصل لحد أدنى صرف/مشتريات.`,
        expectedBenefit: `تجنّب قرار متسرّع على عيّنة صغيرة (توسّع مبكر = هدر، إيقاف مبكر = قتل عنصر واعد).`,
        risk: `منخفضة — عدم التصرّف هو الأأمن على البيانات الحالية.` };
  }
}

function deterministicSummary(recs) {
  const scale = recs.filter((r) => ['SCALE', 'INCREASE_BUDGET', 'DUPLICATE_WINNER'].includes(r.decision)).length;
  const stop = recs.filter((r) => ['PAUSE', 'PAUSE_LOSER', 'REDUCE_BUDGET'].includes(r.decision)).length;
  const p0 = recs.filter((r) => r.priority === 'P0').length;
  const parts = [];
  parts.push(p0 > 0 ? `فيه ${p0} حالة حرجة محتاجة تدخل فوري.` : 'مفيش حالات حرجة دلوقتي.');
  if (scale > 0) parts.push(`${scale} فرصة توسّع متاحة.`);
  if (stop > 0) parts.push(`${stop} عنصر بيستهلك ميزانية من غير نتيجة كافية.`);
  if (scale === 0 && stop === 0) parts.push('الحساب مستقر — البيانات المتاحة لسه قليلة لمعظم العناصر.');
  return parts.join(' ');
}

/**
 * Summarised historical outcome context (spec "AI DECISION OUTCOME
 * LEARNING") — NOT unrestricted ML: just the last N evaluated action
 * results per (product, action_type), so Claude can be more conservative
 * where a similar decision failed before.
 */
export async function buildOutcomeContext({ limitPerGroup = 5 } = {}) {
  const results = await prisma.ambActionResult.findMany({
    where: { checkpoint: 'H24', result_class: { not: null } },
    include: { action: { include: { recommendation: { select: { product_name: true, decision: true } } } } },
    orderBy: { evaluated_at: 'desc' },
    take: 200,
  });
  const groups = new Map();
  for (const r of results) {
    const key = `${r.action.recommendation?.product_name || 'عام'}::${r.action.action_type}`;
    if (!groups.has(key)) groups.set(key, []);
    const g = groups.get(key);
    if (g.length < limitPerGroup) g.push(r);
  }
  const out = [];
  for (const [key, rs] of groups.entries()) {
    const [product, actionType] = key.split('::');
    const succ = rs.filter((x) => x.result_class === 'SUCCESSFUL').length;
    const fail = rs.filter((x) => x.result_class === 'FAILED').length;
    const cpaDeltas = rs.map((x) => (n(x.cpa_after) != null && n(x.cpa_before) ? (x.cpa_after - x.cpa_before) / x.cpa_before : null)).filter((x) => x != null);
    const avgCpaDeltaPct = cpaDeltas.length ? Math.round((cpaDeltas.reduce((a, b) => a + b, 0) / cpaDeltas.length) * 100) : null;
    out.push({ product, actionType, sample: rs.length, successful: succ, failed: fail, avgCpaChangePct: avgCpaDeltaPct });
  }
  return out;
}

const EX_FIELDS = ['whatHappened', 'why', 'whatToDo', 'expectedBenefit', 'risk', 'dataSupport'];
function cleanExplain(obj) {
  const out = {};
  for (const f of EX_FIELDS) out[f] = obj && obj[f] ? String(obj[f]).slice(0, 400) : null;
  return out;
}

/**
 * @param {object[]} recs deterministic recommendation objects (pre-persist)
 * @returns {Promise<{executiveSummary:string, reasons:Map<string,string>, explanations:Map<string,object>, source:'AI'|'FALLBACK'}>}
 *   reasons = the one-line summary (kept in AmbRecommendation.reason);
 *   explanations = the structured 6-part {whatHappened, why, whatToDo, expectedBenefit, risk, dataSupport}
 */
export async function narrateRecommendations(recs, { history = [] } = {}) {
  const reasons = new Map();
  const explanations = new Map();
  const fillDeterministic = () => {
    for (const r of recs) {
      if (!reasons.has(r.key)) reasons.set(r.key, deterministicReason(r));
      if (!explanations.has(r.key)) explanations.set(r.key, deterministicExplain(r));
    }
  };

  if (recs.length === 0) {
    return { executiveSummary: 'مفيش عناصر نشطة كفاية لتحليلها في الفترة دي.', reasons, explanations, source: 'FALLBACK' };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    fillDeterministic();
    return { executiveSummary: deterministicSummary(recs), reasons, explanations, source: 'FALLBACK' };
  }
  try {
    const compact = (m) => (m ? { cpa: m.cpa, spend: m.spend, purchases: m.purchases, roas: m.roas, ctr: m.ctr, cpc: m.cpc, conversionRate: m.conversionRate, dataSufficiency: m.dataSufficiency } : null);
    const payload = {
      recommendations: recs.slice(0, 12).map((r) => ({
        key: r.key, decision: r.decision, action_type: r.action_type, priority: r.priority,
        confidence: r.confidence, risk: r.risk_level, data_sufficiency: r.data_sufficiency,
        current_status: r.current_metrics?.metaStatus || 'UNKNOWN',
        metrics: compact(r.current_metrics), target_metrics: r.target_metrics,
        budget: r.current_budget != null ? { current: r.current_budget, recommended: r.recommended_budget, changePct: r.budget_change_pct } : null,
        rule_engine: r.rule_engine ? { passed: r.rule_engine.passed, blockers: (r.rule_engine.blockers || []).slice(0, 2) } : null,
        entity: { level: r.level, name: r.entity_name, product: r.product_name },
      })),
      history,
    };
    const raw = await askClaude({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content: JSON.stringify(payload) }], maxTokens: 4500 });
    const parsed = parseJsonLoose(raw);
    if (!parsed || !parsed.executive_summary || !Array.isArray(parsed.items)) throw new Error('missing fields');
    const byKey = new Map(recs.map((r) => [String(r.key), r]));
    for (const it of parsed.items) {
      const k = String(it.key);
      if (!byKey.has(k)) continue;
      const ex = cleanExplain(it);
      if (ex.whatToDo || ex.whatHappened) {
        explanations.set(k, ex);
        reasons.set(k, ex.whatToDo || ex.whatHappened);
      }
    }
    fillDeterministic(); // any rec Claude skipped
    return { executiveSummary: String(parsed.executive_summary).slice(0, 800), reasons, explanations, source: 'AI' };
  } catch (err) {
    fillDeterministic();
    return { executiveSummary: deterministicSummary(recs), reasons, explanations, source: 'FALLBACK', error: err.message };
  }
}

export { deterministicReason, deterministicExplain, deterministicSummary };
