// AI Gateway — low-level OpenAI Responses API wrapper. The ONLY file in the
// system that talks to https://api.openai.com/v1/responses directly for
// text/reasoning/vision work (image generation/editing stays in the
// existing services/creativeFactory/imageProvider.js — reused, not
// duplicated, see aiGateway/index.js).
//
// Accepts the SAME message/content-block shape services/ai.js's askClaude()
// always has ({role, content: string | Block[]} with Block =
// {type:'text',text} | {type:'image',source:{type:'base64',media_type,data}})
// so every existing call site migrates by changing an import, not by
// rewriting its prompt-building code.
import { logger } from '../../logger.js';
import * as health from '../providerHealth.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const REQUEST_TIMEOUT_MS = 45000; // vision + reasoning calls run longer than a plain text call
const LARGE_OUTPUT_TIMEOUT_MS = 90000; // large-output JSON calls (e.g. pmc.report's ~4000-token report) measured taking 45-90s even on success — 45s aborted them mid-generation on every retry
const LARGE_OUTPUT_THRESHOLD_TOKENS = 2000;
const MAX_RETRIES = 2;
const PROVIDER = 'openai';

function requestTimeoutFor(maxOutputTokens) {
  return maxOutputTokens >= LARGE_OUTPUT_THRESHOLD_TOKENS ? LARGE_OUTPUT_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function cleanEnvValue(raw) {
  if (!raw) return raw;
  return raw.split('\n')[0].trim();
}

/** Never logs the key itself — only whether it's present, same convention as services/ai.js. */
export function openAiApiKey() {
  return cleanEnvValue(process.env.OPENAI_API_KEY) || null;
}

export function isOpenAiConfigured() {
  return !!openAiApiKey();
}

function apiKeyOrThrow() {
  const key = openAiApiKey();
  if (!key) {
    const e = new Error('OPENAI_API_KEY مش متظبط — ضيفه في متغيرات البيئة عشان تشغّل أي ميزة ذكاء اصطناعي.');
    e.errorType = 'NOT_CONFIGURED';
    throw e;
  }
  return key;
}

/**
 * services/ai.js's Anthropic content-block shape → Responses API input-content
 * shape. `role` matters: the Responses API rejects an `assistant`-role message
 * item whose content uses `input_text` — replaying assistant history back as
 * `input` (no `previous_response_id`) requires `output_text` instead. Found
 * live: a real multi-turn assistant.js chat's 2nd message (the first to carry
 * history) 400'd; every `user`/`system` message keeps `input_text`/
 * `input_image` as before.
 */
function toResponsesContent(content, role = 'user') {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  if (typeof content === 'string') return [{ type: textType, text: content }];
  return content.map((block) => {
    if (block.type === 'text') return { type: textType, text: block.text };
    if (block.type === 'image') {
      const mediaType = block.source?.media_type || 'image/jpeg';
      const data = block.source?.data || '';
      return { type: 'input_image', image_url: `data:${mediaType};base64,${data}` };
    }
    // Unknown block types pass through as text so a caller's mistake is visible in the response rather than silently dropped.
    return { type: textType, text: JSON.stringify(block) };
  });
}

function toResponsesInput(messages) {
  return messages.map((m) => ({ role: m.role, content: toResponsesContent(m.content, m.role) }));
}

// OpenAI's Responses API rejects `text.format: {type:'json_object'}` with a
// 400 ("Response input messages must contain the word 'json' in some form")
// UNLESS the literal word "json" appears somewhere in the `input` array
// itself — the `instructions` (system prompt) field does NOT count, even
// when it says "رجّع JSON فقط". Every caller's own system prompt already
// asks for JSON in Arabic/English, but that alone isn't enough — this is
// the ONE centralized place that guarantees it, so no individual feature
// prompt has to remember to. Idempotent: appended unconditionally whenever
// jsonMode is requested, regardless of what the caller's own prompt says.
const JSON_MODE_DIRECTIVE = 'Return the response as valid JSON only. Do not include markdown, code fences, commentary, or text outside the JSON object.';
export function ensureJsonDirective(input) {
  if (!input.length) return [{ role: 'user', content: [{ type: 'input_text', text: JSON_MODE_DIRECTIVE }] }];
  const withDirective = input.slice();
  const last = { ...withDirective[withDirective.length - 1] };
  last.content = [...last.content, { type: 'input_text', text: JSON_MODE_DIRECTIVE }];
  withDirective[withDirective.length - 1] = last;
  return withDirective;
}

/** Anthropic tool shape ({name, description, input_schema}) → Responses API function-tool shape. */
export function toResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema || { type: 'object', properties: {} }, strict: false }));
}

async function withRetry(fn, maxRetries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const startedAt = Date.now();
    try {
      const result = await fn();
      health.recordSuccess(PROVIDER, Date.now() - startedAt);
      return result;
    } catch (err) {
      lastErr = err;
      const errorType = err.errorType || health.classifyErrorType(err);
      health.recordError(PROVIDER, errorType, Date.now() - startedAt);
      const canRetry = attempt < maxRetries && health.isRetryable(errorType);
      logger.error('OPENAI_CALL_FAILED', { errorType, httpStatus: err.httpStatus || null, attempt, willRetry: canRetry });
      if (!canRetry) throw err;
      const backoffMs = Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

/**
 * One real call to the Responses API. `jsonMode: true` asks for a bare JSON
 * object response (no schema enforcement — callers already validate/repair
 * loosely); `previousResponseId` + `input` continues a tool-use turn.
 */
async function callResponsesApi({ apiKey, model, instructions, input, tools, maxOutputTokens, jsonMode, previousResponseId }) {
  logger.info('OPENAI_REQUEST_STARTED', { model, toolCount: tools?.length || 0, itemCount: input.length, continuing: !!previousResponseId });
  const body = {
    model,
    input,
    max_output_tokens: maxOutputTokens,
    ...(instructions && !previousResponseId ? { instructions } : {}),
    ...(tools ? { tools } : {}),
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    ...(jsonMode ? { text: { format: { type: 'json_object' } } } : {}),
  };
  const timeoutMs = requestTimeoutFor(maxOutputTokens);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    logger.error('OPENAI_REQUEST_FAILED', { message: err.name === 'AbortError' ? 'request timed out' : err.message });
    const wrapped = new Error(err.name === 'AbortError' ? `مقدرش أوصل لـ OpenAI API: انتهت المهلة (${timeoutMs / 1000}s).` : `مقدرش أوصل لـ OpenAI API: ${err.message}`);
    if (err.name === 'AbortError') { wrapped.name = 'AbortError'; wrapped.errorType = 'TIMEOUT'; }
    throw wrapped;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    logger.error('OPENAI_REQUEST_FAILED', { status: res.status, body: bodyText.slice(0, 500) });
    let errorType = null;
    if (res.status === 429) errorType = 'RATE_LIMITED';
    else if (res.status === 401 || res.status === 403) errorType = 'INVALID_CREDENTIALS';
    else if (res.status === 402 || /insufficient.?quota|billing/i.test(bodyText)) errorType = 'INSUFFICIENT_CREDITS';
    else if (res.status === 404 && /model/i.test(bodyText)) errorType = 'MODEL_UNAVAILABLE';
    else if (res.status >= 500) errorType = 'SERVER_ERROR';
    const err = new Error(`OpenAI API error ${res.status}: ${bodyText.slice(0, 300)}`);
    err.httpStatus = res.status;
    err.errorType = errorType;
    throw err;
  }
  logger.info('OPENAI_RESPONSE_RECEIVED', { status: res.status });
  return res.json();
}

/** Pulls the assistant's plain-text answer out of a Responses API payload (ignores reasoning-summary/tool-call items). */
function extractText(data) {
  const items = data.output || [];
  const texts = [];
  for (const item of items) {
    if (item.type === 'message') {
      for (const c of item.content || []) if (c.type === 'output_text' && c.text) texts.push(c.text);
    }
  }
  return texts.join('\n').trim();
}
function extractFunctionCalls(data) {
  return (data.output || []).filter((item) => item.type === 'function_call');
}

/**
 * Drop-in replacement for services/ai.js's askClaude({system, messages, maxTokens}).
 * @returns {Promise<{text:string, requestId:string, usage:{inputTokens,cachedInputTokens,outputTokens}}>}
 */
export async function callOpenAiText({ system, messages, maxTokens = 1024, model, jsonMode = false }) {
  const apiKey = apiKeyOrThrow();
  let input = toResponsesInput(messages);
  if (jsonMode) input = ensureJsonDirective(input);
  // Large-output calls (e.g. pmc.report) get a longer per-attempt timeout
  // (see requestTimeoutFor) but fewer retries — 2 attempts at 90s each is
  // already a ~180s worst case for a synchronous request; 3 would risk
  // exceeding what the deployment's reverse proxy tolerates for no benefit
  // (a call that times out twice in a row is unlikely to succeed on a third).
  const maxRetries = maxTokens >= LARGE_OUTPUT_THRESHOLD_TOKENS ? 1 : MAX_RETRIES;
  const data = await withRetry(() => callResponsesApi({ apiKey, model, instructions: system, input, maxOutputTokens: maxTokens, jsonMode }), maxRetries);
  return {
    text: extractText(data),
    requestId: data.id || null,
    usage: {
      inputTokens: data.usage?.input_tokens ?? null,
      cachedInputTokens: data.usage?.input_tokens_details?.cached_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
    },
  };
}

/**
 * Drop-in replacement for services/ai.js's runAgentTurn(). Same public
 * contract ({text, toolCalls}); internally drives the Responses API's
 * function-calling loop instead of Anthropic's tool_use blocks.
 */
export async function callOpenAiAgentTurn({ system, userMessage, tools, executeTool, maxTurns = 6, maxTokens = 1536, model, onToolCall, history }) {
  const apiKey = apiKeyOrThrow();
  const oaTools = toResponsesTools(tools);
  const toolCalls = [];
  // `history` (prior {role,content} turns, same Block shape as userMessage)
  // is optional — every existing single-message caller (ai-command-center.js
  // via routes/aiAssistant.js) keeps working unchanged with no history.
  let input = Array.isArray(history) && history.length
    ? [...toResponsesInput(history), { role: 'user', content: toResponsesContent(userMessage) }]
    : [{ role: 'user', content: toResponsesContent(userMessage) }];
  let previousResponseId = null;

  for (let turn = 0; turn < maxTurns; turn++) {
    const data = await withRetry(() => callResponsesApi({ apiKey, model, instructions: turn === 0 ? system : undefined, input, tools: oaTools, maxOutputTokens: maxTokens, previousResponseId }));
    const calls = extractFunctionCalls(data);
    if (!calls.length) return { text: extractText(data), toolCalls, requestId: data.id || null };

    previousResponseId = data.id;
    const outputs = [];
    for (const call of calls) {
      let parsedArgs = {};
      try { parsedArgs = call.arguments ? JSON.parse(call.arguments) : {}; } catch { parsedArgs = {}; }
      let output = null; let error = null;
      logger.info('TOOL_CALL_STARTED', { tool: call.name, input: parsedArgs });
      try { output = await executeTool(call.name, parsedArgs); }
      catch (err) { error = err.message || String(err); }
      logger.info('TOOL_CALL_COMPLETED', { tool: call.name, success: !error, error: error || undefined });
      toolCalls.push({ name: call.name, input: parsedArgs });
      onToolCall?.(call.name, parsedArgs, output, error);
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(error ? { error } : output ?? {}) });
    }
    input = outputs;
  }
  return { text: 'مقدرتش أوصل لإجابة نهائية بعد كذا محاولة — جرب تسأل سؤال أوضح أو أبسط.', toolCalls, requestId: null };
}

/** Read-only snapshot of OpenAI's tracked health — never makes a network call itself, same convention as services/ai.js's getAnthropicHealth(). */
export function getOpenAiHealth() {
  return health.classify(PROVIDER, isOpenAiConfigured());
}
