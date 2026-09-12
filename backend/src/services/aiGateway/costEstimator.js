// AI Gateway — cost estimation. Real OpenAI per-model pricing changes over
// time and this repo has no live way to fetch it, so every rate is
// env-configured (USD per 1M tokens) with NO hardcoded guess as a fallback —
// an unconfigured rate means estimated_cost_usd stays null ("unknown"),
// never a fabricated number. Configure once the real current rates are
// known (platform.openai.com/pricing) and every past+future usage row using
// that tier prices itself correctly from then on.
function envNum(name) {
  const v = process.env[name];
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
}

const RATE_PER_1M = {
  routine: { in: () => envNum('AI_PRICE_ROUTINE_INPUT_PER_1M'), out: () => envNum('AI_PRICE_ROUTINE_OUTPUT_PER_1M') },
  balanced: { in: () => envNum('AI_PRICE_BALANCED_INPUT_PER_1M'), out: () => envNum('AI_PRICE_BALANCED_OUTPUT_PER_1M') },
  advanced: { in: () => envNum('AI_PRICE_ADVANCED_INPUT_PER_1M'), out: () => envNum('AI_PRICE_ADVANCED_OUTPUT_PER_1M') },
};

/** @returns {number|null} — null means "rate not configured", never a guess. */
export function estimateTextCostUsd({ tier, inputTokens, cachedInputTokens, outputTokens }) {
  const rate = RATE_PER_1M[tier];
  if (!rate) return null;
  const inRate = rate.in(); const outRate = rate.out();
  if (inRate === null || outRate === null) return null;
  const billableInput = Math.max(0, (inputTokens || 0) - (cachedInputTokens || 0));
  const cost = (billableInput / 1_000_000) * inRate + ((outputTokens || 0) / 1_000_000) * outRate;
  return Math.round(cost * 1_000_000) / 1_000_000; // 6 dp — these are sub-cent amounts per call
}

/**
 * Image cost from Creative Factory's own existing estimator
 * (services/creativeFactory/config.js estimateCostUsd) — reused, not
 * duplicated. Accurate for the currently-priced model (gpt-image-1); if
 * AI_IMAGE_MODEL is pointed at a different model, this stays an honest
 * best-effort estimate against that same table until it's updated for the
 * new model's real published rates.
 */
export async function estimateImageCostUsd({ size = '1024x1024', count = 1 } = {}) {
  try {
    const { estimateCostUsd } = await import('../creativeFactory/config.js');
    return estimateCostUsd(count, size); // null when the provider isn't 'openai' or no rate is known — never a guess
  } catch { return null; }
}
