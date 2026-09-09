// AI Creative Factory settings. Stored in the EXISTING `settings` JSON blob
// row (id='default'), same convention as amb/settings.js — a new field never
// needs a migration. Every key is prefixed `cf` so it can never collide with
// an AMB or core threshold. Read-through with defaults (which themselves fall
// back to the env-level CF_DEFAULT_THRESHOLDS) so a fresh install behaves
// sensibly before the owner ever opens Settings.
import { prisma } from '../../prisma.js';
import { CF_DEFAULT_THRESHOLDS } from './config.js';

export const CF_DEFAULT_SETTINGS = {
  cfQualityThreshold: CF_DEFAULT_THRESHOLDS.qualityThreshold,
  cfProductAccuracyThreshold: CF_DEFAULT_THRESHOLDS.productAccuracyThreshold,
  cfClaimComplianceMustPass: CF_DEFAULT_THRESHOLDS.claimComplianceMustPass,
  cfMaxRetries: CF_DEFAULT_THRESHOLDS.maxRetries,
  cfMaxImagesPerProject: CF_DEFAULT_THRESHOLDS.maxImagesPerProject,
  cfPremiumCandidates: CF_DEFAULT_THRESHOLDS.premiumCandidates,
  cfAllowPremiumMode: CF_DEFAULT_THRESHOLDS.allowPremiumMode,
  cfDefaultGenerationMode: CF_DEFAULT_THRESHOLDS.defaultGenerationMode, // FAST | PREMIUM
  cfDailyImageBudgetUsd: CF_DEFAULT_THRESHOLDS.dailyImageBudget,
  cfMonthlyImageBudgetUsd: CF_DEFAULT_THRESHOLDS.monthlyImageBudget,
  cfMinReferenceImages: CF_DEFAULT_THRESHOLDS.minReferenceImages,
  cfMaxReferenceImages: CF_DEFAULT_THRESHOLDS.maxReferenceImages,
  cfDefaultProductLockMode: 'STRICT',   // صارم
  cfDefaultStylePreset: 'EGY_ECOM',
  cfDefaultMarket: 'EG',
  cfDefaultLanguage: 'ar',
  cfDefaultDialect: 'egyptian',
  cfDefaultTextDensity: 'MINIMAL',
  cfDefaultPeopleRule: 'NONE',
  cfHijabRequiredDefault: false,
};

export async function getCfSettings() {
  const row = await prisma.settings.findUnique({ where: { id: 'default' } });
  const saved = row ? safeParse(row.data) : {};
  const out = { ...CF_DEFAULT_SETTINGS };
  for (const k of Object.keys(CF_DEFAULT_SETTINGS)) {
    if (saved[k] !== undefined && saved[k] !== null) out[k] = saved[k];
  }
  return out;
}

export async function saveCfSettings(patch) {
  const row = await prisma.settings.findUnique({ where: { id: 'default' } });
  const current = row ? safeParse(row.data) : {};
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!k.startsWith('cf')) continue;              // never write a non-CF setting from here
    if (!(k in CF_DEFAULT_SETTINGS)) continue;
    clean[k] = v;
  }
  const merged = { ...current, ...clean, id: 'default' };
  await prisma.settings.upsert({
    where: { id: 'default' },
    create: { id: 'default', data: JSON.stringify(merged) },
    update: { data: JSON.stringify(merged) },
  });
  return getCfSettings();
}

function safeParse(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }
