// AI GATEWAY — the ONE place every AI feature in the system calls through.
// OpenAI is the sole provider (§0/§47): nothing here ever falls back to
// Anthropic, silently or otherwise. Handles: model routing (router.js),
// retries/timeout (openaiClient.js), JSON validation, structured output,
// usage logging (usageLog.js), cost tracking (costEstimator.js), cache
// lookup/write (cache.js), budget guard (budget.js), and error handling.
//
// Every feature-level function elsewhere (aiActionPlan.generateActionPlan,
// productMarketingAI.buildIntelligenceReport, claudeAnalyst.narrateRecommendations,
// creativeFactory/textAi.callAiJson, ...) is a thin, well-named wrapper
// around generateText()/runTools() here — see the migration report for the
// full feature -> gateway-call map. That keeps every call site's own
// prompt-building/parsing/fallback logic untouched while centralizing
// everything Section 2 asks for in one real place, instead of scattering
// 15 near-identical passthrough method names across the codebase.
import { callOpenAiText, callOpenAiAgentTurn, isOpenAiConfigured, getOpenAiHealth, openAiApiKey } from './openaiClient.js';
import { modelForTier, imageModel, allConfiguredModels, TIERS } from './router.js';
import { requestHash, cacheGet, cacheSet, cacheInvalidate, TTL } from './cache.js';
import { logUsage, usageSummary } from './usageLog.js';
import { estimateTextCostUsd, estimateImageCostUsd } from './costEstimator.js';
import { checkBudget } from './budget.js';
import { logger } from '../../logger.js';

export { TIERS, TTL, cacheInvalidate, requestHash, usageSummary, checkBudget, allConfiguredModels, imageModel, estimateImageCostUsd };

export function isAiConfigured() { return isOpenAiConfigured(); }

/**
 * §5/§8 — image generation cost/usage tracking + the SAME monthly budget
 * guard text/vision already use. Creative Factory's own generation loop
 * (services/creativeFactory/generationJob.js) is UNCHANGED — its prompts,
 * retry logic, storage, and CfGenerationAttempt record stay exactly as they
 * were; this only wraps that one real provider.generate() call site with a
 * budget check before spending and a row in the SAME ai_usage_log table
 * every text/vision call already writes to, so the admin usage dashboard
 * and the monthly budget guard cover images too — real architectural
 * unification without touching working generation behavior.
 */
export async function checkImageBudget() { return checkBudget(); }

export async function logImageUsage({ feature, model, productId, generationType, imageCount = 1, size = null, status, error, estimatedCostUsd, requestId, durationMs }) {
  return logUsage({
    feature, tier: TIERS.IMAGE, model, status,
    imageCount, estimatedCostUsd, requestId, error, productId, durationMs,
    // image_generation_type / image_size are image-only columns — passed through logUsage's generic call
    imageGenerationType: generationType || null, imageSize: size || null,
  });
}

/** ANTHROPIC_ENABLED gate (§47): even if some forgotten path still imports services/ai.js, this makes that fact visible instead of quietly reachable. Read once per call — cheap, and always reflects the live env var. */
export function anthropicEnabled() { return process.env.ANTHROPIC_ENABLED === 'true'; }

/**
 * The main text/vision/JSON entry point. Drop-in signature for
 * services/ai.js's old askClaude({system, messages, maxTokens}) plus the
 * fields the gateway needs for routing/caching/logging:
 *
 * @param {object} p
 * @param {string} p.feature      stable dotted name, e.g. "pmc.intelligence_report" — used for logging + cache namespacing
 * @param {'routine'|'balanced'|'advanced'} [p.tier='routine']
 * @param {string} [p.system]
 * @param {{role:'user'|'assistant', content: string|object[]}[]} p.messages  same content-block shape askClaude always took
 * @param {number} [p.maxTokens=1024]
 * @param {boolean} [p.jsonMode=false]  ask the model for a bare JSON object response
 * @param {object} [p.cacheParts]  when given, the call is cached under requestHash({feature, model, promptVersion, parts: cacheParts}); omit to never cache
 * @param {number|null} [p.cacheTtlMs]  null/omitted = persistent until cacheInvalidate() is called
 * @param {string} [p.promptVersion]  §44 — stored with the cache row/usage log so a prompt change never serves a stale-shape cached result
 * @param {boolean} [p.force]  bypass cache read (still writes a fresh entry) — "إعادة التحليل"/"إنشاء أفكار جديدة" (§77)
 * @param {number} [p.productId] [p.userId]  best-effort attribution for the usage log
 * @returns {Promise<{text:string, cached:boolean, requestId:string|null, model:string, usage:object|null, estimatedCostUsd:number|null}>}
 */
export async function generateText({ feature, tier = TIERS.ROUTINE, system, messages, maxTokens = 1024, jsonMode = false, cacheParts, cacheTtlMs, promptVersion, force = false, productId, userId }) {
  if (!feature) throw new Error('aiGateway.generateText: feature مطلوب (لأغراض الـ logging والـ caching).');
  const model = modelForTier(tier);
  const cacheKey = cacheParts ? requestHash({ feature, model, promptVersion, parts: cacheParts }) : null;

  if (cacheKey && !force) {
    const cached = await cacheGet(cacheKey);
    if (cached !== null) {
      logUsage({ feature, tier, model, promptVersion, status: 'SUCCESS', cached: true, productId, userId }).catch(() => {});
      return { text: cached, cached: true, requestId: null, model, usage: null, estimatedCostUsd: 0 };
    }
  }

  if (!anthropicEnabled()) { /* documents the guard exists; this function never touches Anthropic regardless */ }

  const budget = await checkBudget();
  if (budget.blocked) {
    const err = new Error(`تم الوصول للحد الأقصى لميزانية الذكاء الاصطناعي الشهرية (${budget.spentUsd}$ من ${budget.budgetUsd}$) — التوليد الجديد متوقف مؤقتًا حتى بداية الشهر القادم أو رفع الميزانية.`);
    err.budgetBlocked = true;
    await logUsage({ feature, tier, model, promptVersion, status: 'BLOCKED_BUDGET', error: err.message, productId, userId });
    throw err;
  }

  const startedAt = Date.now();
  try {
    const { text, requestId, usage } = await callOpenAiText({ system, messages, maxTokens, model, jsonMode });
    const estimatedCostUsd = estimateTextCostUsd({ tier, inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens });
    await logUsage({ feature, tier, model, promptVersion, status: 'SUCCESS', cached: false, inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens, estimatedCostUsd, requestId, productId, userId, durationMs: Date.now() - startedAt });
    if (cacheKey) await cacheSet({ cacheKey, feature, promptVersion, data: text, ttlMs: cacheTtlMs });
    return { text, cached: false, requestId, model, usage, estimatedCostUsd };
  } catch (err) {
    await logUsage({ feature, tier, model, promptVersion, status: 'FAILED', error: err.message, productId, userId, durationMs: Date.now() - startedAt });
    logger.error('AI_GATEWAY_TEXT_FAILED', { feature, tier, model, message: err.message });
    throw err;
  }
}

/**
 * Tool-use agent loop — drop-in for services/ai.js's old runAgentTurn().
 * Same {text, toolCalls} contract; tools stay in the existing Anthropic-
 * shaped {name, description, input_schema} form (services/aiTools.js is
 * untouched) — converted to the Responses API's function-tool shape
 * internally.
 */
export async function runTools({ feature, tier = TIERS.BALANCED, system, userMessage, tools, executeTool, maxTurns = 6, maxTokens = 1536, onToolCall, userId }) {
  if (!feature) throw new Error('aiGateway.runTools: feature مطلوب.');
  const model = modelForTier(tier);
  const budget = await checkBudget();
  if (budget.blocked) {
    const err = new Error(`تم الوصول للحد الأقصى لميزانية الذكاء الاصطناعي الشهرية — المساعد متوقف مؤقتًا.`);
    err.budgetBlocked = true;
    await logUsage({ feature, tier, model, status: 'BLOCKED_BUDGET', error: err.message, userId });
    throw err;
  }
  const startedAt = Date.now();
  try {
    const { text, toolCalls, requestId } = await callOpenAiAgentTurn({ system, userMessage, tools, executeTool, maxTurns, maxTokens, model, onToolCall });
    await logUsage({ feature, tier, model, status: 'SUCCESS', requestId, userId, durationMs: Date.now() - startedAt });
    return { text, toolCalls };
  } catch (err) {
    await logUsage({ feature, tier, model, status: 'FAILED', error: err.message, userId, durationMs: Date.now() - startedAt });
    logger.error('AI_GATEWAY_TOOLS_FAILED', { feature, tier, model, message: err.message });
    throw err;
  }
}

/**
 * §58/§59/§60 — real connectivity + model-availability check. Calls
 * OpenAI's model-list endpoint (free metadata, never a paid generation) so
 * "is this actually reachable and are the configured models real" is
 * answered honestly, not assumed from key presence alone.
 */
export async function healthCheck() {
  const models = allConfiguredModels();
  if (!isOpenAiConfigured()) {
    return { status: 'NOT_CONFIGURED', models, textAvailable: {}, imageAvailable: false, checkedAt: new Date().toISOString() };
  }
  try {
    const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${openAiApiKey()}` }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { status: 'ERROR', models, textAvailable: {}, imageAvailable: false, httpStatus: res.status, checkedAt: new Date().toISOString() };
    const data = await res.json();
    const ids = new Set((data.data || []).map((m) => m.id));
    return {
      status: 'CONNECTED',
      models,
      textAvailable: { routine: ids.has(models.routine), balanced: ids.has(models.balanced), advanced: ids.has(models.advanced) },
      imageAvailable: ids.has(models.image),
      totalModelsListed: ids.size,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return { status: 'ERROR', models, textAvailable: {}, imageAvailable: false, error: err.message, checkedAt: new Date().toISOString() };
  }
}

export { getOpenAiHealth };
