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

/** True when the owner pinned the image model by env — then it is NEVER auto-replaced. */
export function imageModelPinned() {
  return !!(cleanEnvValue(process.env.AI_IMAGE_MODEL) || cleanEnvValue(process.env.CF_IMAGE_MODEL));
}
let discoveredImageModel = null; // set only after the account itself rejected the default id and listed a usable one
export function setDiscoveredImageModel(id) { discoveredImageModel = id || null; }
export function imageModel() {
  return cleanEnvValue(process.env.AI_IMAGE_MODEL) || cleanEnvValue(process.env.CF_IMAGE_MODEL) || discoveredImageModel || 'gpt-image-1';
}
/** Pure: the best image model among the account's model ids — the highest gpt-image-N (full models before "-mini"), or null. */
export function pickBestImageModel(ids) {
  const parsed = (ids || []).map((id) => { const m = /^gpt-image-(\d+(?:\.\d+)?)(-mini)?$/.exec(String(id)); return m ? { id, v: Number(m[1]), mini: !!m[2] } : null; }).filter(Boolean);
  parsed.sort((a, b) => b.v - a.v || Number(a.mini) - Number(b.mini));
  return parsed[0]?.id || null;
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
