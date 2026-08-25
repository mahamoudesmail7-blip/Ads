// Thin Anthropic (Claude) API wrapper — infrastructure for later AI
// Intelligence phases (AI Business Chat, narrative Decision Center). NOT
// called by anything in Phase 1 (ads upload / column mapping / True
// Business Performance are all deterministic — see services/adsImport.js).
// Raw fetch rather than the SDK: this is the only place in the whole
// backend that would need it, so a dependency isn't worth adding yet.
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * @param {{system?: string, messages: {role: 'user'|'assistant', content: string}[], maxTokens?: number}} params
 * @returns {Promise<string>} the assistant's text reply
 */
export async function askClaude({ system, messages, maxTokens = 1024 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY مش متظبط — ضيفه في .env عشان تستخدم أي ميزة AI.');

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text ?? '';
}
