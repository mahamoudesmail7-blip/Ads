// The "Marketing Performance Decision Agent" (AI Intelligence Phase 2, spec
// §9). Receives only the already-classified, already-prioritized entity
// list from decisionEngine.js — never raw CSV rows — and is asked to write
// exactly two things per entity: a one-sentence Arabic `reason` grounded in
// the numbers it was given, and a specific `recommendedAction` (never
// "راقب الأداء"). It also writes one short cross-category `summary`
// narrative. The app's own classification/priority/confidence/metrics are
// authoritative and are echoed back, never re-derived from the model's
// output — if the API call fails, is unset, or returns something that
// doesn't parse, callers fall back to deterministic templated text so the
// page is never blocked on the LLM.
import crypto from 'node:crypto';
import { askClaude } from './ai.js';

const SYSTEM_PROMPT = `أنت "Marketing Performance Decision Agent" — وكيل تحليل أداء إعلانات Meta لمتجر تجارة إلكترونية مصري (COD).
هتستلم قائمة "entities" (منتجات أو حملات) وكل واحد فيها معاه classification و priority و confidence و metrics محسوبين مسبقًا وثابتين — ممنوع تغيّرهم أو تخترع تصنيف جديد.
مهمتك فقط: لكل entity اكتب "reason" (جملة واحدة بالعربي، لازم تستخدم الأرقام المعطاة فعليًا) و"recommendedAction" (نصيحة محددة وقابلة للتنفيذ، ممنوع تكتب حاجة عامة زي "راقب الأداء" أو "تابع النتائج"). وبعد كده اكتب "summary" (2-3 جمل بالعربي تلخص أهم حاجة حصلت وأكبر مشكلة وأكبر فرصة).
رجّع JSON فقط بدون أي نص تاني، بالشكل ده بالظبط:
{"summary": "...", "items": [{"entityKey": "...", "reason": "...", "recommendedAction": "..."}]}`;

export function computeInputHash(entities, thresholds) {
  const payload = JSON.stringify({ thresholds, entities: entities.map((e) => ({ k: e.entityKey, c: e.classification, s: e.spend, r: e.results, cpa: e.cpa })) });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function buildPromptEntities(entities) {
  // Only the top candidates need real AI text — deep into COLLECT_MORE_DATA/long-tail items get templated text (see deterministic fallback), keeps the prompt small and cheap.
  return entities.slice(0, 40).map((e) => ({
    entityKey: e.entityKey,
    entityType: e.entityType,
    entityName: e.entityName,
    classification: e.classification,
    priority: e.priority,
    confidence: e.confidence,
    metrics: { spend: Math.round(e.spend), results: e.results, cpa: e.cpa !== null ? Math.round(e.cpa * 100) / 100 : null },
    problem: e.problem,
    drillDown: e.drillDown
      ? {
          protect: e.drillDown.protect.map((c) => ({ name: c.campaignName, cpa: c.cpa })),
          reduce: e.drillDown.reduce.map((c) => ({ name: c.campaignName, cpa: c.cpa })),
        }
      : null,
  }));
}

function deterministicReason(e, thresholds) {
  const { aiScaleCpaThreshold: scaleT, aiOptimizeCpaThreshold: optT } = thresholds;
  if (e.classification === 'STOP' && (e.results || 0) === 0) return `صرفت ${Math.round(e.spend)} جنيه من غير أي نتيجة واحدة.`;
  if (e.classification === 'STOP') return `الـ CPA ${e.cpa?.toFixed(1)} جنيه فوق حد الخطر (${optT} جنيه) بصرف ${Math.round(e.spend)} جنيه.`;
  if (e.classification === 'SCALE') return `الـ CPA ${e.cpa?.toFixed(1)} جنيه أقل من حد التوسع (${scaleT} جنيه) بـ${e.results} نتيجة.`;
  if (e.classification === 'OPTIMIZE' && e.drillDown) return `المتوسط العام ${e.cpa?.toFixed(1)} جنيه ضعيف، بس فيه حملة جواه شغالة كويس.`;
  if (e.classification === 'OPTIMIZE') return `الـ CPA ${e.cpa?.toFixed(1)} جنيه داخل نطاق التحسين (${scaleT}-${optT} جنيه).`;
  return `البيانات لسه قليلة (${Math.round(e.spend)} جنيه صرف، ${e.results ?? 0} نتيجة) — مش كفاية لقرار واضح.`;
}

function deterministicAction(e) {
  if (e.classification === 'STOP' && (e.results || 0) === 0) return 'أوقف الحملة فورًا أو راجع الاستهداف والكرييتيف قبل أي صرف إضافي.';
  if (e.classification === 'STOP') return 'قلل الميزانية بشكل كبير أو أوقف الصرف لحد ما تجرب كرييتيف/استهداف جديد.';
  if (e.classification === 'SCALE') return 'زوّد الميزانية تدريجيًا مع متابعة الـ CPA.';
  if (e.classification === 'OPTIMIZE' && e.drillDown) {
    const protect = e.drillDown.protect.map((c) => c.campaignName).join('، ');
    const reduce = e.drillDown.reduce.map((c) => c.campaignName).join('، ');
    return `حافظ على: ${protect}. قلل أو أوقف: ${reduce}.`;
  }
  if (e.classification === 'OPTIMIZE') return 'راجع الاستهداف والكرييتيف قبل زيادة الميزانية.';
  return 'كمّل تجميع بيانات كام يوم كمان قبل أي قرار توسع أو إيقاف.';
}

/** Deterministic fallback for the whole plan — used when ANTHROPIC_API_KEY is unset, the API call fails, or the response doesn't parse as expected. Never blocks the page. */
function fallbackPlan(entities, thresholds) {
  const items = entities.map((e) => ({ entityKey: e.entityKey, reason: deterministicReason(e, thresholds), recommendedAction: deterministicAction(e) }));
  const stop = entities.filter((e) => e.classification === 'STOP').length;
  const scale = entities.filter((e) => e.classification === 'SCALE').length;
  const summary = stop > 0 || scale > 0 ? `في ${scale} فرصة توسع و${stop} مشكلة تحتاج تدخل فوري النهاردة.` : 'مفيش تصنيفات حرجة أو فرص واضحة النهاردة — البيانات المتاحة لسه قليلة لمعظم الحملات.';
  return { summary, items, source: 'FALLBACK' };
}

/**
 * @param {object[]} entities classified entities from decisionEngine.js
 * @param {object} thresholds the thresholds used to classify them (part of the cache key)
 * @returns {Promise<{summary: string, items: object[], source: 'AI'|'FALLBACK', inputHash: string}>}
 */
export async function generateActionPlan(entities, thresholds) {
  const inputHash = computeInputHash(entities, thresholds);
  if (entities.length === 0) {
    return { summary: 'مفيش حملات نشطة في الفترة دي — مفيش خطة عمل تُبنى عليها.', items: [], source: 'FALLBACK', inputHash };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { ...fallbackPlan(entities, thresholds), inputHash };
  }

  try {
    const promptEntities = buildPromptEntities(entities);
    const raw = await askClaude({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify({ entities: promptEntities }) }],
      maxTokens: 2048,
    });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude response was not JSON');
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.summary || !Array.isArray(parsed.items)) throw new Error('Claude response missing summary/items');

    const byKey = new Map(entities.map((e) => [e.entityKey, e]));
    const items = parsed.items
      .filter((it) => byKey.has(it.entityKey) && it.reason && it.recommendedAction)
      .map((it) => ({ entityKey: it.entityKey, reason: String(it.reason).slice(0, 400), recommendedAction: String(it.recommendedAction).slice(0, 400) }));

    // Any entity Claude skipped (e.g. beyond the top-40 sent) still needs text — fill the gap deterministically rather than leaving it blank.
    const coveredKeys = new Set(items.map((it) => it.entityKey));
    for (const e of entities) {
      if (!coveredKeys.has(e.entityKey)) items.push({ entityKey: e.entityKey, reason: deterministicReason(e, thresholds), recommendedAction: deterministicAction(e) });
    }

    return { summary: String(parsed.summary).slice(0, 800), items, source: 'AI', inputHash };
  } catch (err) {
    return { ...fallbackPlan(entities, thresholds), inputHash, error: err.message };
  }
}
