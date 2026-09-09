// AI Creative Factory — central provider / model / threshold configuration.
//
// EVERYTHING here comes from environment variables with safe defaults, and
// NOTHING is a secret in a response: getProviderStatus() only ever reports
// booleans + non-secret ids. This is the single source of truth for "is the
// image provider actually configured right now" — the whole module runs in a
// mock-safe "provider off" mode when it isn't, and never fabricates an image.
import { getAnthropicHealth } from '../ai.js';

function clean(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).split('\n')[0].trim();
}
function num(raw, dflt) {
  const c = clean(raw);
  if (c === '') return dflt;               // unset / blank env var -> use the default, NOT 0
  const v = Number(c);
  return Number.isFinite(v) ? v : dflt;
}
function bool(raw, dflt) {
  const v = clean(raw).toLowerCase();
  if (v === '') return dflt;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// ---------------------------------------------------------------------------
// Image generation provider
// ---------------------------------------------------------------------------
export function imageProviderName() {
  const explicit = clean(process.env.CF_IMAGE_PROVIDER).toLowerCase();
  if (explicit) return explicit; // 'openai' | 'disabled' | future adapters
  return openAiKey() ? 'openai' : 'disabled';
}
export function openAiKey() {
  return clean(process.env.OPENAI_API_KEY);
}
export function imageModel() {
  return clean(process.env.CF_IMAGE_MODEL) || 'gpt-image-1';
}
/** Requested output pixel size for an aspect ratio the OpenAI Images API supports. */
export function imageSizeFor(aspectRatio) {
  const map = {
    '1:1': clean(process.env.CF_IMAGE_SIZE_SQUARE) || '1024x1024',
    '4:5': clean(process.env.CF_IMAGE_SIZE_PORTRAIT) || '1024x1536',
    '9:16': clean(process.env.CF_IMAGE_SIZE_PORTRAIT) || '1024x1536',
    '16:9': clean(process.env.CF_IMAGE_SIZE_LANDSCAPE) || '1536x1024',
    '1.91:1': clean(process.env.CF_IMAGE_SIZE_LANDSCAPE) || '1536x1024',
  };
  return map[aspectRatio] || map['1:1'];
}
export function imageQualityTier() {
  return clean(process.env.CF_IMAGE_QUALITY) || 'high'; // low | medium | high (gpt-image-1)
}

// ---------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------
export function storageProviderName() {
  return (clean(process.env.CF_STORAGE_PROVIDER) || 'db').toLowerCase(); // db | s3 | cloudinary | supabase
}

// ---------------------------------------------------------------------------
// Thresholds / limits — all overridable from Settings (see settings.js) which
// layers on top of these env-level defaults.
// ---------------------------------------------------------------------------
export const CF_DEFAULT_THRESHOLDS = {
  qualityThreshold: num(process.env.CF_QUALITY_THRESHOLD, 88),          // overall 0..100
  productAccuracyThreshold: num(process.env.CF_PRODUCT_ACCURACY_THRESHOLD, 90),
  realismThreshold: num(process.env.CF_REALISM_THRESHOLD, 72),          // "would a customer suspect AI?"
  claimComplianceMustPass: true,
  // Targeted-retry caps per mode (spec §16/§19). A retry is never a blind repeat.
  maxRetriesFast: num(process.env.CF_MAX_RETRIES_FAST, 1),
  maxRetriesPremium: num(process.env.CF_MAX_RETRIES_PREMIUM, 2),
  maxRetries: num(process.env.CF_MAX_RETRIES, 3),                        // legacy cap / ceiling
  maxImagesPerProject: num(process.env.CF_MAX_IMAGES_PER_PROJECT, 50),
  generationConcurrency: num(process.env.CF_GENERATION_CONCURRENCY, 3),  // independent images in parallel
  premiumCandidates: num(process.env.CF_PREMIUM_CANDIDATES, 2),          // best-of-N — HERO only, PREMIUM only
  premiumCandidatesMax: 4,
  goodEnoughMargin: num(process.env.CF_GOOD_ENOUGH_MARGIN, 8),           // overall >= (threshold - margin) + product/realism ok -> stop
  dailyImageBudget: num(process.env.CF_DAILY_IMAGE_BUDGET, 0),           // 0 = no explicit ceiling
  monthlyImageBudget: num(process.env.CF_MONTHLY_IMAGE_BUDGET, 0),
  allowPremiumMode: bool(process.env.CF_ALLOW_PREMIUM, true),
  textOverlay: bool(process.env.CF_TEXT_OVERLAY, true),                  // render Arabic ourselves (never the image model)
  defaultGenerationMode: (clean(process.env.CF_DEFAULT_GENERATION_MODE) || 'FAST').toUpperCase(),
  minReferenceImages: num(process.env.CF_MIN_REFERENCE_IMAGES, 3),
  maxReferenceImages: num(process.env.CF_MAX_REFERENCE_IMAGES, 6),
};

// Per-image price estimate (USD) — used only for the "التكلفة التقديرية"
// display. If not configured we show "غير متاحة حاليًا" rather than inventing
// a number.
export function imageUnitCostUsd() {
  const v = num(process.env.CF_IMAGE_UNIT_COST_USD, NaN);
  return Number.isFinite(v) ? v : null;
}
export function estimateCostUsd(imageCount) {
  const unit = imageUnitCostUsd();
  if (unit === null) return null;
  return Math.round(unit * Math.max(0, imageCount) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Public, secret-free status
// ---------------------------------------------------------------------------
export function getProviderStatus() {
  const imgProvider = imageProviderName();
  const imgConfigured = imgProvider === 'disabled' ? false : (imgProvider === 'openai' ? !!openAiKey() : true);
  const textHealth = getAnthropicHealth(); // { status, ... } — never a key
  const textConfigured = !!textHealth && textHealth.status !== 'NOT_CONFIGURED';
  return {
    image: {
      provider: imgProvider,
      configured: imgConfigured,
      model: imgProvider === 'disabled' ? null : imageModel(),
      status: imgProvider === 'disabled' || !imgConfigured ? 'NOT_CONFIGURED' : 'READY',
      envVar: 'OPENAI_API_KEY',
    },
    text: {
      provider: 'anthropic',
      configured: textConfigured,
      status: textConfigured ? (textHealth.status || 'READY') : 'NOT_CONFIGURED',
      envVar: 'ANTHROPIC_API_KEY',
      lastErrorType: textHealth?.lastErrorType || null,   // diagnostic only — a category, never a secret
      lastErrorAt: textHealth?.lastErrorAt || null,
      lastOkAt: textHealth?.lastSuccessfulRequestAt || null,
    },
    storage: { provider: storageProviderName() },
    costEstimateAvailable: imageUnitCostUsd() !== null,
  };
}

export function textAiConfigured() {
  const h = getAnthropicHealth();
  return !!h && h.status !== 'NOT_CONFIGURED';
}
