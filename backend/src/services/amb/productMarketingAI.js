// AI Product Marketing Center — every AI call the module makes. Reuses the
// central AI gateway (services/aiGateway — OpenAI) and the EXISTING
// truncation-safe JSON extractor (creativeFactory/textAi.js extractJson).
// No new AI client, no new key.
//
// Contract every call here honours:
//   • The model receives ONLY the real, already-computed numbers (metrics,
//     locations, creative fields) — it never re-derives or overrides them.
//   • Every qualitative item it returns must carry kind: FACT | HYPOTHESIS |
//     RECOMMENDATION and confidence: LOW | MEDIUM | HIGH — enforced here
//     (defaulted, never trusted blindly) before anything is stored.
//   • Claim status (§11) is validated against productMarketingScoring's hard
//     banned-claim list AFTER the model answers — its own "آمن" label is
//     downgraded, never upgraded, by that check.
import { generateText, TIERS } from '../aiGateway/index.js';
import { extractJson } from '../creativeFactory/textAi.js';
import { classifyClaim } from './productMarketingScoring.js';
import { logger } from '../../logger.js';

const KIND_VALUES = new Set(['FACT', 'HYPOTHESIS', 'RECOMMENDATION']);
const CONF_VALUES = new Set(['LOW', 'MEDIUM', 'HIGH']);
function kindOf(v) { return KIND_VALUES.has(v) ? v : 'HYPOTHESIS'; }
function confOf(v) { return CONF_VALUES.has(v) ? v : 'LOW'; }
function claimOf(text, aiStatus) {
  const forced = classifyClaim(text);
  if (forced) return forced;
  const status = ['GREEN', 'YELLOW', 'RED'].includes(aiStatus) ? aiStatus : 'YELLOW';
  return { status, reason: status === 'YELLOW' ? 'يحتاج تأكيد قبل الاستخدام.' : null };
}

async function callJson({ system, user, maxTokens = 3000, label, tier = TIERS.ROUTINE }) {
  let raw;
  try {
    ({ text: raw } = await generateText({ feature: `pmc.${label.toLowerCase()}`, tier, system, messages: [{ role: 'user', content: user }], maxTokens, jsonMode: true }));
  } catch (err) {
    logger.error(`[ProductMarketingAI] ${label}_CALL_FAILED`, { message: err.message });
    return { ok: false, reason: err.message };
  }
  const parsed = extractJson(raw);
  if (parsed === undefined) {
    logger.error(`[ProductMarketingAI] ${label}_BAD_JSON`, { rawStart: String(raw).slice(0, 200) });
    return { ok: false, reason: 'رد AI لم يحتوِ JSON صالح.' };
  }
  return { ok: true, data: parsed, raw };
}

// ---------------------------------------------------------------------------
// Main "brain" call — one request covering §9 audience, §8 location
// commentary, §10 sales angles (+ §11 claims), §13/§14 winner/loser
// narration, §20 winning formula, §21 top actions. Every number it is given
// is real; everything it returns is qualitative/interpretive and gets
// kind+confidence enforced on the way back in.
// ---------------------------------------------------------------------------
const REPORT_SYSTEM = `إنت خبير تسويق منتجات ميديا بايينج مصري. هتستلم أرقام حقيقية فعلية عن أداء منتج (من Meta Ads و Easy Orders) ومعلومات عن هوية المنتج. مهمتك تفسير الأرقام وتقترح أفكار تسويقية — مش تخترع أرقام جديدة.

قواعد صارمة:
1. ممنوع تخترع أي رقم أداء (صرف/مشتريات/CPA/محافظات) — استخدم بس الأرقام المُعطاة لك.
2. كل عنصر رأي أو اقتراح لازم يكون له "kind": "FACT" لو مبني مباشرة على رقم مُعطى، "HYPOTHESIS" لو استنتاج منطقي محتاج تأكيد، "RECOMMENDATION" لو اقتراح فعل.
3. كل عنصر لازم "confidence": "LOW"|"MEDIUM"|"HIGH" حسب قوة الدليل الفعلي المتاح — لو البيانات قليلة اكتب LOW بصراحة.
4. ممنوع منعًا باتًا أي ادّعاء طبي أو علاجي أو تخسيس أو ضمان نتيجة (زي: يحرق الدهون، يعالج، يخسس، نتيجة مضمونة). لو الزاوية فيها احتمال كده، صنّفها claimStatus:"RED" وابدل الفايدة بفايدة عملية غير طبية (راحة، سهولة، وقت، مظهر، تنظيم).
5. لو البيانات مش كافية لأي جزء، قول كده صراحة في الحقل المناسب بدل ما تخمن.
6. اكتب بالعربي المصري في كل النصوص التسويقية (hooks/angles/copy)، والتصنيفات التقنية بالإنجليزي زي المطلوب في الشكل.

رجّع JSON فقط بالشكل ده بالظبط (بدون أي نص خارجه):
{
  "audience": {
    "gender": {"value":"رجال|نساء|الاثنين|غير محسوم بعد","kind":"...","confidence":"...","evidence":""},
    "ageRange": {"value":"18-24|25-34|35-44|45-54|55+","kind":"...","confidence":"...","evidence":""},
    "buyerVsUser": {"user":"","buyer":"","secondaryBuyer":"","giftOpportunity":"","evidence":""},
    "segments": [{"label":"","gender":"","ageRange":"","location":"","kind":"HYPOTHESIS","confidence":"MEDIUM","evidence":"","dataSize":""}]
  },
  "locationCommentary": "سطرين شرح ليه المحافظات دي طلعت أعلى/أقل بناءً على الأرقام المُعطاة فقط",
  "angles": [
    {"name":"","category":"Problem/Solution|Demonstration|Daily Use|Convenience|Comfort|Lifestyle|Family|Gift|Office|Home|Travel|Parents|Younger|Older|Educational|Comparison|Premium|Value|Seasonal|Time saving|Portable","why":"","audience":"","ageRange":"","location":"","painPoint":"","benefit":"","hook":"","suggestedFormat":"صورة|فيديو|كاروسيل","confidence":"LOW|MEDIUM|HIGH","claimStatus":"GREEN|YELLOW|RED","claimReason":""}
  ],
  "diagnosisNarrative": "سطرين تفسير بشري للتشخيص المُعطى ليك، مش تكرار للأرقام",
  "winnerDna": {"available": true, "reasons": ["..."], "narrative":""},
  "loserAutopsy": {"available": true, "rootCause":"Angle|Hook|Creative|Audience|Offer|Location|Landing|insufficient_data", "narrative":""},
  "winningFormula": {"available": true, "gender":"", "ageRange":"", "location":"", "angle":"", "hook":"", "format":"", "narrative":""},
  "actions": [{"actionKey":"","title":"","reason":"","confidence":"LOW|MEDIUM|HIGH","source":"","expectedBenefit":"","risk":""}]
}
لو أي قسم مش متاح له بيانات كافية، رجّعه بـ "available": false ونص "غير متاح — البيانات غير كافية للحكم" بدل ما تخترع.`;

export async function buildIntelligenceReport(ctx) {
  const user = `بيانات المنتج والأداء الحقيقية (استخدمها فقط، ممنوع تخترع غيرها):\n${JSON.stringify(ctx, null, 2)}`;
  const res = await callJson({ system: REPORT_SYSTEM, user, maxTokens: 4000, label: 'REPORT', tier: TIERS.BALANCED });
  if (!res.ok) return { ok: false, reason: res.reason };
  const d = res.data || {};

  const seg = (s = {}) => ({ value: s.value ?? null, kind: kindOf(s.kind), confidence: confOf(s.confidence), evidence: s.evidence || '' });
  const audience = {
    gender: seg(d.audience?.gender),
    ageRange: seg(d.audience?.ageRange),
    buyerVsUser: d.audience?.buyerVsUser || null,
    segments: Array.isArray(d.audience?.segments) ? d.audience.segments.map((s) => ({
      label: s.label || '', gender: s.gender || '', ageRange: s.ageRange || '', location: s.location || '',
      kind: kindOf(s.kind || 'HYPOTHESIS'), confidence: confOf(s.confidence), evidence: s.evidence || '', dataSize: s.dataSize || '',
    })) : [],
  };

  const angles = Array.isArray(d.angles) ? d.angles.map((a) => {
    const claim = claimOf(`${a.name} ${a.benefit} ${a.hook}`, a.claimStatus);
    return {
      name: a.name || 'زاوية بدون اسم', category: a.category || '', why: a.why || '', audience: a.audience || '',
      ageRange: a.ageRange || '', location: a.location || '', painPoint: a.painPoint || '', benefit: a.benefit || '',
      hook: a.hook || '', suggestedFormat: a.suggestedFormat || '', confidence: confOf(a.confidence),
      claimStatus: claim.status, claimReason: claim.reason || a.claimReason || '',
    };
  }) : [];

  const actions = Array.isArray(d.actions) ? d.actions.slice(0, 5).map((a, i) => ({
    actionKey: a.actionKey || `action_${i + 1}`, title: a.title || '', reason: a.reason || '',
    confidence: confOf(a.confidence), source: a.source || 'تحليل الأداء الحالي', expectedBenefit: a.expectedBenefit || '', risk: a.risk || '',
  })) : [];

  return {
    ok: true,
    audience,
    locationCommentary: d.locationCommentary || null,
    angles,
    diagnosisNarrative: d.diagnosisNarrative || null,
    winnerDna: d.winnerDna?.available ? { available: true, reasons: d.winnerDna.reasons || [], narrative: d.winnerDna.narrative || '' } : { available: false },
    loserAutopsy: d.loserAutopsy?.available ? { available: true, rootCause: d.loserAutopsy.rootCause || 'insufficient_data', narrative: d.loserAutopsy.narrative || '' } : { available: false },
    winningFormula: d.winningFormula?.available ? { available: true, ...d.winningFormula } : { available: false },
    actions,
    raw: res.raw,
  };
}

// ---------------------------------------------------------------------------
// Angle Intelligence (Product Growth & Profit Intelligence, Phase 3 Slice
// 6) — NEW angle proposals only, generated on demand, never auto-triggered.
// Deliberately a small, focused prompt (not the full buildIntelligenceReport
// context, which is entangled with a ProductMarketingProfile most AMB
// products don't have) — takes only real, already-known angle labels
// (Testing Brain's own ANGLE-dimension keys) so it never re-proposes
// something already tried, and a plain-text bottleneck summary for context.
// Every proposal starts state:'PROPOSED' — never claims WON until real
// performance proves it, matching every other AI-generated item's contract.
// ---------------------------------------------------------------------------
const ANGLE_SYSTEM = `إنت استراتيجي تسويق مصري. هتقترح زوايا بيع جديدة (Selling Angles) لمنتج، مبنية على السياق الحقيقي اللي هتستلمه فقط (زوايا مجربة قبل كده تتجنبها، ومشكلة الأداء الحالية لو موجودة). كل زاوية مقترحة هي فرضية تحتاج اختبار حقيقي، مش حقيقة مؤكدة — ممنوع تدّعي إنها فائزة. ممنوع منعًا باتًا أي ادّعاء طبي أو علاجي أو تخسيس أو ضمان نتيجة. رجّع JSON فقط:
{"angles":[{"name":"","category":"Problem/Solution|Convenience|Time Saving|Comfort|Gift|Demonstration|Comparison|Value|Routine|Before/After","why":"","persona":"","corePromise":"","hookDirection":"","creativeDirection":"","hypothesis":""}]}`;
export async function generateAngleProposals({ productName, existingAngles = [], bottleneckContext, count = 3 }) {
  const user = `المنتج: ${productName}\nالزوايا المجربة قبل كده (ممنوع تقترح نفس الزاوية تاني بصيغة مختلفة): ${existingAngles.length ? existingAngles.join('، ') : 'مفيش زوايا مسجلة حتى الآن'}\nسياق المشكلة الحالية (لو موجود): ${bottleneckContext || 'مفيش سياق إضافي'}\nاقترح ${count} زوايا بيع جديدة ومختلفة فعليًا عن الزوايا المجربة.`;
  const res = await callJson({ system: ANGLE_SYSTEM, user, maxTokens: 1800, label: 'ANGLES' });
  if (!res.ok) return { ok: false, reason: res.reason };
  const angles = Array.isArray(res.data?.angles) ? res.data.angles.slice(0, count).map((a) => {
    const claim = classifyClaim(`${a.name || ''} ${a.corePromise || ''} ${a.hookDirection || ''}`);
    return {
      name: a.name || 'زاوية بدون اسم', category: a.category || '', why: a.why || '', persona: a.persona || '',
      corePromise: a.corePromise || '', hookDirection: a.hookDirection || '', creativeDirection: a.creativeDirection || '', hypothesis: a.hypothesis || '',
      state: 'PROPOSED', claimStatus: claim ? claim.status : 'GREEN', claimReason: claim?.reason || null,
    };
  }) : [];
  return { ok: true, angles };
}

// ---------------------------------------------------------------------------
// §15 Hook Lab — generated on demand only (never as part of the main report).
// ---------------------------------------------------------------------------
const HOOK_SYSTEM = `إنت كاتب إعلانات مصري متخصص في الـ Hooks. اكتب Hooks بالعامية المصرية بس، قصيرة وقوية، بدون أي ادّعاء طبي أو تخسيس أو ضمان نتيجة. رجّع JSON فقط: {"hooks":[{"text":"","category":""}]}`;
export async function generateHooks({ productName, angle, category, count = 10 }) {
  const user = `المنتج: ${productName}\nالزاوية المطلوبة: ${angle || 'عام'}\nنوع الـ Hook المطلوب (لو محدد): ${category || 'أي نوع مناسب'}\nاكتب ${count} Hook مختلفين بالعامية المصرية.`;
  const res = await callJson({ system: HOOK_SYSTEM, user, maxTokens: 1500, label: 'HOOKS' });
  if (!res.ok) return { ok: false, reason: res.reason };
  const hooks = Array.isArray(res.data?.hooks) ? res.data.hooks.slice(0, count).map((h) => {
    const claim = classifyClaim(h.text);
    return { text: h.text || '', category: h.category || '', claimStatus: claim ? claim.status : 'GREEN', claimReason: claim?.reason || null };
  }) : [];
  return { ok: true, hooks };
}

// ---------------------------------------------------------------------------
// §16 Post Generator.
// ---------------------------------------------------------------------------
const POST_SYSTEM = `إنت كاتب محتوى فيسبوك مصري. اكتب بوست إعلاني بالعامية المصرية، بدون أي ادّعاء طبي أو تخسيس أو ضمان نتيجة. رجّع JSON فقط:
{"short":"","medium":"","long":"","headline":"","primaryText":"","cta":"","hook":""}`;
export async function generatePost({ productName, angle, tone }) {
  const user = `المنتج: ${productName}\nالزاوية: ${angle || 'عام'}\nنبرة الكتابة المطلوبة: ${tone || 'مباشر'}`;
  const res = await callJson({ system: POST_SYSTEM, user, maxTokens: 1500, label: 'POST' });
  if (!res.ok) return { ok: false, reason: res.reason };
  const d = res.data || {};
  const full = `${d.short || ''} ${d.medium || ''} ${d.long || ''} ${d.headline || ''}`;
  const claim = classifyClaim(full);
  return { ok: true, post: { ...d, claimStatus: claim ? claim.status : 'GREEN', claimReason: claim?.reason || null } };
}

// ---------------------------------------------------------------------------
// §17 Creative Idea Generator.
// ---------------------------------------------------------------------------
const IDEA_SYSTEM = `إنت مخرج إبداعي لإعلانات منتجات في مصر. اقترح أفكار كرياتيف عملية وواقعية (تصوير حقيقي، مش تصميم AI غريب)، بدون أي ادّعاء طبي أو تخسيس. رجّع JSON فقط:
{"ideas":[{"type":"Image|Video|Carousel|Demonstration|Lifestyle|Studio|UGC","scene":"","hook":"","productPlacement":"","mainText":"","cta":"","targetAudience":"","whyItCouldWork":""}]}`;
export async function generateCreativeIdeas({ productName, angle, count = 4 }) {
  const user = `المنتج: ${productName}\nالزاوية: ${angle || 'عام'}\nاقترح ${count} أفكار كرياتيف مختلفة الأنواع.`;
  const res = await callJson({ system: IDEA_SYSTEM, user, maxTokens: 2200, label: 'IDEAS' });
  if (!res.ok) return { ok: false, reason: res.reason };
  const ideas = Array.isArray(res.data?.ideas) ? res.data.ideas.slice(0, count) : [];
  return { ok: true, ideas };
}

// ---------------------------------------------------------------------------
// §15/§16 Market Gap Engine. "observed" is built DETERMINISTICALLY here from
// the real competitorIntel() rows the caller passes in — the model never
// touches that part, so a competitor fact can never be silently altered.
// The model only ever produces "gaps" (interpretation), each forced to
// kind:HYPOTHESIS and a real confidence — never presented as fact.
// ---------------------------------------------------------------------------
const MARKET_GAP_SYSTEM = `إنت محلل تسويقي مصري متخصص في تحليل المنافسين. هتستلم بيانات حقيقية عن منافسين حقيقيين (من بحث سابق) وزوايا/Hooks المنتج الحالي. مهمتك: تكتشف فجوات حقيقية — حاجات المنافسين مش بيعملوها أو بيعملوها بشكل ضعيف — بناءً على البيانات المُعطاة فقط. ممنوع تخترع منافس أو معلومة مش موجودة في البيانات. كل فجوة رأي/استنتاج مش حقيقة مؤكدة. رجّع JSON فقط:
{"gaps":[{"gap":"وصف قصير للفجوة","interpretation":"ليه دي فرصة فعلية بناءً على البيانات المُعطاة","confidence":"LOW|MEDIUM|HIGH"}]}
لو البيانات مش كافية لاستنتاج فجوة حقيقية، رجّع مصفوفة فاضية بدل ما تخترع.`;

/** Pure — separates deterministic observed facts from AI-shaped interpretation. Exported for tests. */
export function shapeMarketGaps(rawData, competitors) {
  const observed = (competitors || []).map((c) => ({
    platform: c.platform, accountName: c.accountName, accountUrl: c.accountUrl, country: c.country, followerCount: c.followerCount,
  }));
  const gaps = Array.isArray(rawData?.gaps) ? rawData.gaps.slice(0, 8).map((g) => ({
    gap: g.gap || '', interpretation: g.interpretation || '', confidence: confOf(g.confidence), kind: 'HYPOTHESIS',
  })) : [];
  return { observed, gaps };
}

export async function generateMarketGaps(ctx) {
  const competitors = ctx?.competitors || [];
  if (!competitors.length) return { ok: true, ...shapeMarketGaps({ gaps: [] }, []) };
  const user = `المنافسين الحقيقيين (بيانات فعلية من بحث سابق، لا تخترع غيرها):\n${JSON.stringify(competitors, null, 2)}\n\nزوايا/Hooks المنتج الحالي المعروفة (لو موجودة):\n${JSON.stringify({ ownAngles: ctx?.ownAngles || [], ownHooks: ctx?.ownHooks || [] }, null, 2)}`;
  const res = await callJson({ system: MARKET_GAP_SYSTEM, user, maxTokens: 1500, label: 'MARKET_GAPS' });
  if (!res.ok) return { ok: false, reason: res.reason, ...shapeMarketGaps({ gaps: [] }, competitors) };
  return { ok: true, ...shapeMarketGaps(res.data, competitors) };
}

// ---------------------------------------------------------------------------
// §24 AI Product Marketing Strategist — answers the spec's 14 fixed
// questions. Every answer gets a validated status; the model's own label is
// never trusted blind (mirrors kind/confidence enforcement everywhere else
// in this file).
// ---------------------------------------------------------------------------
const STRATEGIST_QUESTIONS = [
  'مين أستهدف؟', 'أنهي سوق نوصّي بيه أولاً؟', 'أنهي مشكلة نبدأ بيها؟', 'أنهي Selling Angle نستخدمه؟',
  'أنهي Hook نستخدمه؟', 'أنهي Creative ننتجه؟', 'أنهي Offer نختبره؟', 'أنهي Post/Ad Copy نشغّله؟',
  'أنهي فجوة عند المنافسين نستغلها؟', 'إيه اللي نختبره بعد كده؟', 'إيه اللي نوقف اختباره؟',
  'إيه اللي اتعلمناه لحد دلوقتي؟', 'إيه اللي بيحد من النمو؟', 'إيه أعلى خطوة تأثيرًا نعملها دلوقتي؟',
];
const STATUS_VALUES = new Set(['DATA_BACKED', 'AI_HYPOTHESIS', 'TEST_REQUIRED', 'INSUFFICIENT_DATA']);
function statusOf(v) { return STATUS_VALUES.has(v) ? v : 'AI_HYPOTHESIS'; }

const STRATEGIST_SYSTEM = `إنت "مستشار تسويق منتج" خبير. هتستلم كل البيانات الحقيقية المتاحة عن منتج (أداء، أسواق، جمهور، Hooks، Angles، منافسين، اختبارات سابقة). جاوب على الأسئلة الـ14 المُحددة بالظبط بالترتيب، كل إجابة قصيرة وعملية بالعربي المصري. كل إجابة لازم توصف بـ"status":
- "DATA_BACKED" لو الإجابة مبنية مباشرة على رقم/نتيجة حقيقية موجودة في البيانات.
- "AI_HYPOTHESIS" لو استنتاج منطقي معقول لكن مش مؤكد برقم مباشر.
- "TEST_REQUIRED" لو الإجابة الصح الوحيدة هي "لازم نختبر عشان نعرف".
- "INSUFFICIENT_DATA" لو البيانات ضعيفة جدًا للإجابة أصلاً.
ممنوع تدّعي DATA_BACKED من غير رقم حقيقي فعلي في البيانات المُعطاة. رجّع JSON فقط:
{"answers":[{"question":"نص السؤال بالظبط زي ما اتبعت","answer":"","status":"DATA_BACKED|AI_HYPOTHESIS|TEST_REQUIRED|INSUFFICIENT_DATA"}]}
الأسئلة بالترتيب: ${STRATEGIST_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join(' ')}`;

/** Pure — validates/defaults every answer's status. Exported for tests. */
export function shapeStrategistBrief(rawData) {
  const byQuestion = new Map((Array.isArray(rawData?.answers) ? rawData.answers : []).map((a) => [a.question, a]));
  return {
    answers: STRATEGIST_QUESTIONS.map((q) => {
      const a = byQuestion.get(q);
      return { question: q, answer: a?.answer || 'لا توجد إجابة كافية بالبيانات الحالية.', status: a ? statusOf(a.status) : 'INSUFFICIENT_DATA' };
    }),
  };
}

export async function generateStrategistBrief(ctx) {
  const user = `كل البيانات الحقيقية المتاحة عن المنتج (استخدمها فقط، ممنوع تخترع غيرها):\n${JSON.stringify(ctx, null, 2)}`;
  const res = await callJson({ system: STRATEGIST_SYSTEM, user, maxTokens: 3000, label: 'STRATEGIST', tier: TIERS.BALANCED });
  if (!res.ok) return { ok: false, reason: res.reason, ...shapeStrategistBrief({ answers: [] }) };
  return { ok: true, ...shapeStrategistBrief(res.data) };
}
