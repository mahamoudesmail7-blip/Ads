// Thin Anthropic (Claude) API wrapper. askClaude() is the original plain
// text-in/text-out call (still used by aiActionPlan.js — unchanged).
// runAgentTurn() is new: a real tool-use loop for the AI E-Commerce
// Operating System's assistant (routes/aiAssistant.js) — Claude decides
// which real tools to call (services/aiTools.js), the tools run against
// real data, results are fed back, and this repeats until Claude returns a
// final text answer or maxTurns is hit. No raw fetch/SDK dependency beyond
// what askClaude already used.
import { logger } from '../logger.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5';

// Never log process.env.ANTHROPIC_API_KEY itself — only whether it's
// present. This is the one place that reads it, so this is also the one
// honest source of truth for "is Claude actually configured right now".
function apiKeyOrThrow() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  logger.info(apiKey ? 'ANTHROPIC_API_KEY: CONFIGURED' : 'ANTHROPIC_API_KEY: MISSING');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY مش متظبط — ضيفه في .env عشان تستخدم أي ميزة AI.');
  return apiKey;
}

async function callMessagesApi({ apiKey, system, messages, tools, maxTokens }) {
  logger.info('ANTHROPIC_REQUEST_STARTED', { model: DEFAULT_MODEL, toolCount: tools?.length || 0, messageCount: messages.length });
  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: DEFAULT_MODEL, max_tokens: maxTokens, system, messages, ...(tools ? { tools } : {}) }),
    });
  } catch (err) {
    // Network-level failure (DNS, timeout, connection reset) — never seen the response at all.
    logger.error('ANTHROPIC_REQUEST_FAILED', { message: err.message });
    throw new Error(`مقدرش أوصل لـ Anthropic API: ${err.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Anthropic's error body is JSON like {type, error:{type, message}} — surface the real code/message, never the key (it's never in this body).
    logger.error('ANTHROPIC_REQUEST_FAILED', { status: res.status, body: body.slice(0, 500) });
    throw new Error(`Claude API error ${res.status}: ${body.slice(0, 300)}`);
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
  const data = await callMessagesApi({ apiKey, system, messages, maxTokens });
  return data.content?.[0]?.text ?? '';
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
    const data = await callMessagesApi({ apiKey, system, messages, tools, maxTokens });
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
