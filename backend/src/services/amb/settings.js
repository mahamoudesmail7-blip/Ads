// AI Media Buyer settings. Stored in the EXISTING `settings` JSON blob row
// (id='default'), same convention as routes/settings.js's DEFAULT_SETTINGS —
// a new field never needs a migration. Every key is prefixed `amb` so it can
// never collide with an existing threshold. Read-through with defaults so a
// fresh install behaves sensibly before the owner ever opens Settings.
import { prisma } from '../../prisma.js';

// Every dangerous automatic action defaults OFF. Approval Mode is the default
// operating mode. Autopilot is disabled until the owner explicitly turns it
// on AND enables the specific action classes below.
export const AMB_DEFAULT_SETTINGS = {
  ambExecutionMode: 'APPROVAL',        // ADVISORY | APPROVAL | AUTOPILOT
  ambSyncIntervalMinutes: 15,
  ambAlsoRefreshAdsDailyMetric: true,  // piggy-back the existing metaSync.runSync so the current AI Intelligence page goes live too
  ambDefaultPricingMultiplier: 3,
  ambDefaultTargetCpa: 120,            // EGP
  ambDefaultCurrency: 'EGP',
  ambNoPurchaseStopMultiplier: 2,      // "No Purchase Stop Threshold" = Target CPA × this
  ambMaxBudgetIncreasePct: 20,         // per single action
  ambScalingCooldownHours: 24,
  ambMaxDailyBudgetIncreasePct: 50,    // across all actions on one entity in 24h
  ambMaxAllowedDailyLoss: 1000,        // EGP — rule engine blocks further scaling / flags P0 past this
  ambMaxAutoExecutionAmount: 500,      // EGP — autopilot may not apply a budget delta larger than this
  ambMinPurchasesBeforeScaling: 5,
  ambMinSpendBeforeDecision: 150,      // EGP
  ambAnalysisLookbackDays: 7,
  ambScaleCpaBetterPct: 10,            // CPA must be at least this % under target before any scale is considered
  ambCreativeFatigueFreqThreshold: 3.5,
  // Autopilot action allow-list (all OFF by default)
  ambAllowAutoPause: false,
  ambAllowAutoBudgetIncrease: false,
  ambAllowAutoBudgetDecrease: false,
  ambAllowDuplicationActions: false,
  // Campaign Clone & Schedule
  ambCloneDefaultActivationTime: '00:00',   // HH:MM in each destination account's timezone
  ambCloneAutoActivate: true,               // scheduler flips cloned (PAUSED) campaigns ACTIVE at the scheduled time; set false to hold them
  ambCloneMaxCampaignsPerBatch: 20,         // guard on one clone batch
  ambCloneNativeSchedule: false,            // OPT-IN: scheduled clones use native Meta start_time (campaign/ad sets/ads ACTIVE now → Meta reviews immediately, zero spend, auto-delivers at start). Default OFF keeps the create-PAUSED-then-flip behaviour.
  // Media Asset Library
  ambMediaLibraryAutoDiscover: true,        // fold new creatives into the library on every sync
  ambMediaLibraryScanDays: 30,              // how far back a discovery pass looks for creatives
};

/** Merged AMB settings — DEFAULTS <- whatever the owner saved. Only the `amb…` keys are returned. */
export async function getAmbSettings() {
  const row = await prisma.settings.findUnique({ where: { id: 'default' } });
  const saved = row ? JSON.parse(row.data) : {};
  const out = { ...AMB_DEFAULT_SETTINGS };
  for (const k of Object.keys(AMB_DEFAULT_SETTINGS)) {
    if (saved[k] !== undefined && saved[k] !== null) out[k] = saved[k];
  }
  return out;
}

/** Persists a partial patch of AMB settings back into the shared blob, leaving every non-`amb` key untouched. ADMIN-gated at the route layer. */
export async function saveAmbSettings(patch) {
  const row = await prisma.settings.findUnique({ where: { id: 'default' } });
  const current = row ? JSON.parse(row.data) : {};
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!k.startsWith('amb')) continue; // never let this endpoint write a non-AMB setting
    if (!(k in AMB_DEFAULT_SETTINGS)) continue;
    clean[k] = v;
  }
  const merged = { ...current, ...clean, id: 'default' };
  await prisma.settings.upsert({
    where: { id: 'default' },
    create: { id: 'default', data: JSON.stringify(merged) },
    update: { data: JSON.stringify(merged) },
  });
  return getAmbSettings();
}
