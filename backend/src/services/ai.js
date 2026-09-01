// Thin Anthropic (Claude) API wrapper. askClaude() is the original plain
// text-in/text-out call (still used by aiActionPlan.js — unchanged).
// runAgentTurn() is new: a real tool-use loop for the AI E-Commerce
// Operating System's assistant (routes/aiAssistant.js) — Claude decides
// which real tools to call (services/aiTools.js), the tools run against
// real data, results are fed back, and this repeats until Claude returns a
// final text answer or maxTurns is hit. No raw fetch/SDK dependency beyond
// what askClaude already used.
import { logger } from '../logger.js';
import * as health from './providerHealth.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2; // bounded — never infinite (Step 15): up to 3 attempts total for a transient failure, then give up and let the caller's own honest fallback take over.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter, bounded retry count, transient errors only (Step 8/15) — never retries invalid credentials, insufficient credits, or a validation 4xx. */
async function withRetry(fn, { provider = 'anthropic' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = Date.now();
    try {
      const result = await fn();
      health.recordSuccess(provider, Date.now() - startedAt);
      return result;
    } catch (err) {
      lastErr = err;
      const errorType = health.classifyErrorType(err);
      health.recordError(provider, errorType, Date.now() - startedAt);
      const canRetry = attempt < MAX_RETRIES && health.isRetryable(errorType);
      logger.error('ANTHROPIC_CALL_FAILED', { errorType, httpStatus: err.httpStatus || null, attempt, willRetry: canRetry });
      if (!canRetry) throw err;
      const backoffMs = Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250); // jitter avoids a thundering-herd retry pattern under real concurrent load
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

// A real-world paste into a platform's Variables UI (Railway included) can
// accidentally grab more than intended — e.g. the next line's
// "NAME=value" got selected along with the key and pasted as one string,
// producing "sk-ant-...\nANTHROPIC_WORKSPACE_ID=\"...\"" as a single env
// var value. That's not valid header content (fetch's Headers throws on
// any \n), so it's cleaned the same defensive way the Meta env vars
// already are: take only the first line, trimmed. A correctly-pasted key
// is single-line already, so this is a no-op for the normal case.
function cleanEnvValue(raw) {
  if (!raw) return raw;
  return raw.split('\n')[0].trim();
}

// Never log process.env.ANTHROPIC_API_KEY itself — only whether it's
// present. This is the one place that reads it, so this is also the one
// honest source of truth for "is Claude actually configured right now".
function apiKeyOrThrow() {
  const apiKey = cleanEnvValue(process.env.ANTHROPIC_API_KEY);
  logger.info(apiKey ? 'ANTHROPIC_API_KEY: CONFIGURED' : 'ANTHROPIC_API_KEY: MISSING');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY مش متظبط — ضيفه في .env عشان تستخدم أي ميزة AI.');
  return apiKey;
}

async function callMessagesApi({ apiKey, system, messages, tools, maxTokens }) {
  logger.info('ANTHROPIC_REQUEST_STARTED', { model: DEFAULT_MODEL, toolCount: tools?.length || 0, messageCount: messages.length });
  // "Identity-linked" API keys (created under a specific Workspace in the
  // Anthropic Console, rather than a legacy org-wide key) require this
  // header naming which workspace the request acts in — not a secret, a
  // plain resource id (wrkspc_...), same as an App ID. Optional: only added
  // when set, so a legacy key without a workspace still works unchanged.
  const workspaceId = cleanEnvValue(process.env.ANTHROPIC_WORKSPACE_ID);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS); // bounded timeout (Step 8) — a hung request is a transient/retryable failure, never an infinite wait.
  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {}),
      },
      body: JSON.stringify({ model: DEFAULT_MODEL, max_tokens: maxTokens, system, messages, ...(tools ? { tools } : {}) }),
      signal: controller.signal,
    });
  } catch (err) {
    // Network-level failure (DNS, timeout, connection reset) — never seen the response at all.
    logger.error('ANTHROPIC_REQUEST_FAILED', { message: err.name === 'AbortError' ? 'request timed out' : err.message });
    const wrapped = new Error(err.name === 'AbortError' ? `مقدرش أوصل لـ Anthropic API: انتهت المهلة (${REQUEST_TIMEOUT_MS / 1000}s).` : `مقدرش أوصل لـ Anthropic API: ${err.message}`);
    if (err.name === 'AbortError') wrapped.name = 'AbortError';
    throw wrapped;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Anthropic's error body is JSON like {type, error:{type, message}} — surface the real code/message, never the key (it's never in this body).
    logger.error('ANTHROPIC_REQUEST_FAILED', { status: res.status, body: body.slice(0, 500) });
    const err = new Error(`Claude API error ${res.status}: ${body.slice(0, 300)}`);
    err.httpStatus = res.status;
    throw err;
  }
  logger.info('ANTHROPIC_RESPONSE_RECEIVED', { status: res.status });
  return res.json();
}

/**
 * @param {{system?: string, messages: {role: 'user'|'assistant', content: string}[], maxTokens?: number}} params
 * @returns {Promise<string>} the assistant's text reply
 */
export async function askClaude({ system, messages, maxTokens = 1024 }) {
  const apiKey = apiKeyOrThrow();
  const data = await withRetry(() => callMessagesApi({ apiKey, system, messages, maxTokens }));
  return data.content?.[0]?.text ?? '';
}

/** Read-only snapshot of Anthropic's tracked health — never makes a network call itself (Step 13). */
export function getAnthropicHealth() {
  const apiKey = Boolean(cleanEnvValue(process.env.ANTHROPIC_API_KEY));
  return health.classify('anthropic', apiKey);
}

/**
 * Real tool-use agent loop. `executeTool(name, input)` must return a
 * JSON-serializable result (or throw — caught here and reported back to
 * Claude as a tool error so it can react honestly instead of the loop
 * silently breaking). Stops as soon as Claude replies with plain text (no
 * more tool_use blocks) or after maxTurns tool-call rounds, whichever
 * first — the maxTurns cap exists only to guarantee the request always
 * terminates, never to truncate a real answer early in practice.
 *
 * @param {{system: string, userMessage: string, tools: object[], executeTool: (name: string, input: object) => Promise<any>, maxTurns?: number, maxTokens?: number, onToolCall?: (name: string, input: object, output: any, error: string|null) => void}} params
 * @returns {Promise<{text: string, toolCalls: {name: string, input: object}[]}>}
 */
export async function runAgentTurn({ system, userMessage, tools, executeTool, maxTurns = 6, maxTokens = 1536, onToolCall }) {
  const apiKey = apiKeyOrThrow();
  const messages = [{ role: 'user', content: userMessage }];
  const toolCalls = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const data = await withRetry(() => callMessagesApi({ apiKey, system, messages, tools, maxTokens }));
    const blocks = data.content || [];
    const toolUseBlocks = blocks.filter((b) => b.type === 'tool_use');

    if (toolUseBlocks.length === 0) {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { text, toolCalls };
    }

    messages.push({ role: 'assistant', content: blocks });

    const toolResults = [];
    for (const call of toolUseBlocks) {
      let output = null;
      let error = null;
      logger.info('TOOL_CALL_STARTED', { tool: call.name, input: call.input || {} });
      try {
        output = await executeTool(call.name, call.input || {});
      } catch (err) {
        error = err.message || String(err);
      }
      logger.info('TOOL_CALL_COMPLETED', { tool: call.name, success: !error, error: error || undefined });
      toolCalls.push({ name: call.name, input: call.input || {} });
      onToolCall?.(call.name, call.input || {}, output, error);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(error ? { error } : output ?? {}),
        ...(error ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { text: 'مقدرتش أوصل لإجابة نهائية بعد كذا محاولة — جرب تسأل سؤال أوضح أو أبسط.', toolCalls };
}
