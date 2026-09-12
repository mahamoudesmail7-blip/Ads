// AI Gateway — model routing. Cost-first: every feature declares a TIER
// (routine/balanced/advanced), never a hardcoded model id, so the actual
// model is 100% controlled by env vars (§3/§4/§59) — if the account's real
// model names differ from these defaults, changing the env var is enough,
// no code change.
export const TIERS = { ROUTINE: 'routine', BALANCED: 'balanced', ADVANCED: 'advanced', IMAGE: 'image' };

function cleanEnvValue(raw) { return raw ? raw.split('\n')[0].trim() : raw; }

const DEFAULTS = {
  routine: 'gpt-5.6-luna',
  balanced: 'gpt-5.6-terra',
  advanced: 'gpt-5.6-sol',
};
const ENV_VAR = {
  routine: 'AI_TEXT_ROUTINE_MODEL',
  balanced: 'AI_TEXT_BALANCED_MODEL',
  advanced: 'AI_TEXT_ADVANCED_MODEL',
};

/** The real TEXT model id configured for a tier — always env-driven, never a silent hardcode past the documented default. TIERS.IMAGE is not a text tier — use imageModel() for that; passed here it (like any unrecognized value) falls back to routine. */
export function modelForTier(tier) {
  const t = ENV_VAR[tier] ? tier : TIERS.ROUTINE;
  return cleanEnvValue(process.env[ENV_VAR[t]]) || DEFAULTS[t];
}

export function imageModel() {
  return cleanEnvValue(process.env.AI_IMAGE_MODEL) || cleanEnvValue(process.env.CF_IMAGE_MODEL) || 'gpt-image-1';
}

/** Every configured text tier + the image model, for the admin health screen (§58/§59/§60) — never a paid call, just what's configured. */
export function allConfiguredModels() {
  return {
    routine: modelForTier(TIERS.ROUTINE),
    balanced: modelForTier(TIERS.BALANCED),
    advanced: modelForTier(TIERS.ADVANCED),
    image: imageModel(),
  };
}
