// AI Product Marketing Center — every Claude call the module makes. Reuses
// the EXISTING generic Claude client (services/ai.js askClaude — the same
// one AI Media Buyer's claudeAnalyst.js and AI Creative Factory's textAi.js
// already use) and the EXISTING truncation-safe JSON extractor
// (creativeFactory/textAi.js extractJson). No new AI client, no new key.
//
// Contract every call here honours:
//   • Claude receives ONLY the real, already-computed numbers (metrics,
//     locations, creative fields) — it never re-derives or overrides them.
//   • Every qualitative item it returns must carry kind: FACT | HYPOTHESIS |
//     RECOMMENDATION and confidence: LOW | MEDIUM | HIGH — enforced here
//     (defaulted, never trusted blindly) before anything is stored.
//   • Claim status (§11) is validated against productMarketingScoring's hard
//     banned-claim list AFTER Claude answers — Claude's own "آمن" label is
//     downgraded, never upgraded, by that check.
import { askClaude } from '../ai.js';
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

async function callJson({ system, user, maxTokens = 3000, label }) {
  let raw;
  try {
    raw = await askClaude({ system, messages: [{ role: 'user', content: user }], maxTokens });
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
  const res = await callJson({ system: REPORT_SYSTEM, user, maxTokens: 4000, label: 'REPORT' });
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
