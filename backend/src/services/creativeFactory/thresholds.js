// AI Creative Factory — effective thresholds = env CF_DEFAULT_THRESHOLDS with
// the owner's saved Settings layered on top. One place so the job worker, the
// quality judge and the routes all agree.
import { CF_DEFAULT_THRESHOLDS } from './config.js';
import { getCfSettings } from './settings.js';

export async function getEffectiveThresholds() {
  const s = await getCfSettings();
  return {
    qualityThreshold: numOr(s.cfQualityThreshold, CF_DEFAULT_THRESHOLDS.qualityThreshold),
    productAccuracyThreshold: numOr(s.cfProductAccuracyThreshold, CF_DEFAULT_THRESHOLDS.productAccuracyThreshold),
    realismThreshold: numOr(s.cfRealismThreshold, CF_DEFAULT_THRESHOLDS.realismThreshold),
    goodEnoughMargin: numOr(s.cfGoodEnoughMargin, CF_DEFAULT_THRESHOLDS.goodEnoughMargin),
    claimComplianceMustPass: s.cfClaimComplianceMustPass !== false,
    maxRetriesFast: clampInt(s.cfMaxRetriesFast, CF_DEFAULT_THRESHOLDS.maxRetriesFast, 0, 3),
    maxRetriesPremium: clampInt(s.cfMaxRetriesPremium, CF_DEFAULT_THRESHOLDS.maxRetriesPremium, 0, 4),
    maxRetries: clampInt(s.cfMaxRetries, CF_DEFAULT_THRESHOLDS.maxRetries, 0, 6),
    maxImagesPerProject: clampInt(s.cfMaxImagesPerProject, CF_DEFAULT_THRESHOLDS.maxImagesPerProject, 1, 50),
    generationConcurrency: clampInt(s.cfGenerationConcurrency, CF_DEFAULT_THRESHOLDS.generationConcurrency, 1, 6),
    premiumCandidates: clampInt(s.cfPremiumCandidates, CF_DEFAULT_THRESHOLDS.premiumCandidates, 1, CF_DEFAULT_THRESHOLDS.premiumCandidatesMax),
    textOverlay: s.cfTextOverlay !== false && CF_DEFAULT_THRESHOLDS.textOverlay !== false,
    allowPremiumMode: s.cfAllowPremiumMode !== false,
    defaultGenerationMode: (s.cfDefaultGenerationMode || CF_DEFAULT_THRESHOLDS.defaultGenerationMode || 'FAST').toUpperCase(),
    dailyImageBudgetUsd: numOr(s.cfDailyImageBudgetUsd, CF_DEFAULT_THRESHOLDS.dailyImageBudget),
    monthlyImageBudgetUsd: numOr(s.cfMonthlyImageBudgetUsd, CF_DEFAULT_THRESHOLDS.monthlyImageBudget),
    minReferenceImages: clampInt(s.cfMinReferenceImages, CF_DEFAULT_THRESHOLDS.minReferenceImages, 1, 6),
    maxReferenceImages: clampInt(s.cfMaxReferenceImages, CF_DEFAULT_THRESHOLDS.maxReferenceImages, 3, 6),
  };
}

function numOr(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }
function clampInt(v, dflt, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
