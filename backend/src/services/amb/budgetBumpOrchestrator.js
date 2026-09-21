// Smart Decision Center — Budget Bump Orchestrator. Gathers REAL ad-set
// metrics via the existing, already-hardened metricsEngine.js primitives
// (the same ones recommendationEngine.js's own scale logic already uses),
// evaluates each ad set PURELY on its own numbers via budgetBumpEngine.js,
// and persists an eligible bump/rollback as an ORDINARY AmbRecommendation
// with action_type INCREASE_BUDGET/DECREASE_BUDGET — the exact executable
// action types executor.js's approve/revalidate/execute/H6-H12-H24 pipeline
// already knows how to run. Zero new execution code; this file only ever
// reads Meta data and writes an AmbRecommendation row, never Meta itself.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection } from '../metaAuth.js';
import { getAmbSettings } from './settings.js';
import { entityWindowMetrics, resolveWindow } from './metricsEngine.js';
import { mappedCampaignIndex } from './mapping.js';
import { evaluateAdSetForBump, evaluateAdSetForRollback, resolveAdSetLifecycleState } from './budgetBumpEngine.js';

export function bumpSettingsFrom(settings) {
  const out = {};
  const map = {
    cpaSuccessThreshold: 'ambBumpCpaSuccessThreshold', bumpPct: 'ambBumpPct', rollbackCpaThreshold: 'ambBumpRollbackCpaThreshold',
    minPurchases: 'ambBumpMinPurchases', minSpend: 'ambBumpMinSpend', minEvalHours: 'ambBumpMinEvalHours',
    maxBumpsPerDay: 'ambBumpMaxPerDay', cooldownHoursAfterBump: 'ambBumpCooldownHours', cooldownHoursAfterRollback: 'ambBumpRollbackCooldownHours',
    maxDailyBudget: 'ambBumpMaxDailyBudget',
  };
  for (const [k, settingsKey] of Object.entries(map)) if (settings[settingsKey] != null) out[k] = settings[settingsKey];
  return out;
}

/** The most recent bump/rollback AmbAction for this ad set, in the shape budgetBumpEngine.js's lifecycle function expects — reconstructed from AmbAction's own real old_value_json/new_value_json/created_at, never a separate new history table. */
export async function latestBumpActionFor(adAccountId, adsetId) {
  const rec = await prisma.ambRecommendation.findFirst({
    where: { level: 'adset', entity_id: adsetId, ad_account_id: adAccountId, decision: { in: ['BUMP_ADSET_25', 'ROLLBACK_BUMP'] } },
    orderBy: { created_at: 'desc' },
    include: { actions: { orderBy: { created_at: 'desc' }, take: 1 } },
  });
  if (!rec) return null;
  const action = rec.actions[0] || null;
  const type = rec.decision === 'BUMP_ADSET_25' ? 'BUMP' : 'ROLLBACK';
  if (!action) return { type, status: rec.status, at: rec.created_at.toISOString(), budgetBefore: rec.current_budget };
  const oldVal = action.old_value_json ? JSON.parse(action.old_value_json) : null;
  return {
    type, status: action.execution_status === 'EXECUTED' ? 'EXECUTED' : rec.status,
    at: (action.executed_at || action.created_at).toISOString(),
    budgetBefore: oldVal?.budget ?? rec.current_budget,
  };
}

export async function bumpsInLast24h(adAccountId, adsetId) {
  return prisma.ambRecommendation.count({
    where: { level: 'adset', entity_id: adsetId, ad_account_id: adAccountId, decision: 'BUMP_ADSET_25', created_at: { gte: new Date(Date.now() - 24 * 3600000) } },
  });
}

export async function persistBumpRecommendation({ adAccountId, adSet, ambProductId, productName, evalResult, batchId }) {
  return prisma.ambRecommendation.create({
    data: {
      batch_id: batchId, ad_account_id: adAccountId, amb_product_id: ambProductId || null, product_name: productName || null,
      level: 'adset', entity_id: adSet.entityId, entity_name: adSet.name || adSet.entityId,
      campaign_id: adSet.campaignId || null, campaign_name: adSet.campaignName || null,
      adset_id: adSet.entityId, adset_name: adSet.name || adSet.entityId,
      decision: 'BUMP_ADSET_25', action_type: 'INCREASE_BUDGET', executable: true,
      current_budget: evalResult.currentBudget, recommended_budget: evalResult.proposedBudget, budget_change_pct: evalResult.pct,
      current_metrics_json: JSON.stringify({ cpa: adSet.cpa, spend: adSet.spend, purchases: adSet.purchases }),
      reason: evalResult.evidence,
      reason_facts_json: JSON.stringify({ rule: 'BUDGET_BUMP', evidence: evalResult.evidence }),
      confidence: 'HIGH', risk_level: 'LOW', priority: 'P1', data_sufficiency: 'STRONG',
      source: 'FALLBACK', status: 'PENDING',
    },
  });
}

async function persistRollbackRecommendation({ adAccountId, adSet, ambProductId, productName, evalResult, batchId }) {
  return prisma.ambRecommendation.create({
    data: {
      batch_id: batchId, ad_account_id: adAccountId, amb_product_id: ambProductId || null, product_name: productName || null,
      level: 'adset', entity_id: adSet.entityId, entity_name: adSet.name || adSet.entityId,
      campaign_id: adSet.campaignId || null, campaign_name: adSet.campaignName || null,
      adset_id: adSet.entityId, adset_name: adSet.name || adSet.entityId,
      decision: 'ROLLBACK_BUMP', action_type: 'DECREASE_BUDGET', executable: true,
      current_budget: evalResult.currentBudget, recommended_budget: evalResult.proposedBudget,
      budget_change_pct: evalResult.currentBudget > 0 ? Math.round(((evalResult.proposedBudget - evalResult.currentBudget) / evalResult.currentBudget) * 10000) / 100 : null,
      current_metrics_json: JSON.stringify({ cpa: adSet.cpa, spend: adSet.spend, purchases: adSet.purchases }),
      reason: evalResult.evidence,
      reason_facts_json: JSON.stringify({ rule: 'BUDGET_BUMP_ROLLBACK', evidence: evalResult.evidence, restoresExactPriorBudget: true }),
      confidence: 'HIGH', risk_level: 'MEDIUM', priority: 'P0', data_sufficiency: 'STRONG',
      source: 'FALLBACK', status: 'PENDING',
    },
  });
}

/**
 * The scheduler-tick / on-demand function. Scoped to ABO ad sets only (an
 * ad set under a CBO campaign has no budget of its own to bump — the
 * campaign does; that is a different, not-yet-built action). Gated behind
 * settings.ambBumpEnabled so this brand-new capability never starts
 * generating recommendations until the user explicitly turns it on.
 */
export async function runBudgetBumpAnalysis() {
  const settings = await getAmbSettings();
  if (!settings.ambBumpEnabled) return { scanned: 0, bumped: 0, rolledBack: 0, reason: 'DISABLED' };

  const connection = await getConnection();
  const adAccountId = connection?.selected_ad_account_id;
  if (!adAccountId) return { scanned: 0, bumped: 0, rolledBack: 0, reason: 'NO_AD_ACCOUNT' };

  const window = resolveWindow('last3'); // a short, responsive window — bumps react to recent performance, not a 30-day average
  const bumpCfg = bumpSettingsFrom(settings);

  const [campaignMetrics, adsetMetrics, campaignMap] = await Promise.all([
    entityWindowMetrics({ level: 'campaign', from: window.from, to: window.to, adAccountId }),
    entityWindowMetrics({ level: 'adset', from: window.from, to: window.to, adAccountId }),
    mappedCampaignIndex({ adAccountId }),
  ]);

  let scanned = 0, bumped = 0, rolledBack = 0;
  const batchId = `bump-${Date.now()}`;

  for (const adSet of adsetMetrics.values()) {
    if (adSet.status !== 'ACTIVE') continue;
    const campaign = adSet.campaignId ? campaignMetrics.get(adSet.campaignId) : null;
    if (campaign?.budget != null) continue; // CBO — the campaign, not this ad set, holds the editable budget
    if (adSet.budget == null) continue; // no resolvable ABO budget for this ad set
    scanned++;

    try {
      const [latestAction, recentBumps] = await Promise.all([
        latestBumpActionFor(adAccountId, adSet.entityId),
        bumpsInLast24h(adAccountId, adSet.entityId),
      ]);
      const lifecycle = resolveAdSetLifecycleState({ latestAction, bumpsInLast24h: recentBumps }, bumpCfg);
      const mapped = adSet.campaignId ? campaignMap.get(adSet.campaignId) : null;

      if (lifecycle.canEvaluateRollback && latestAction?.budgetBefore != null) {
        const rollback = evaluateAdSetForRollback({ cpa: adSet.cpa, spend: adSet.spend, purchases: adSet.purchases, budgetBefore: latestAction.budgetBefore, budgetAfter: adSet.budget }, bumpCfg);
        if (rollback.action === 'ROLLBACK') {
          await persistRollbackRecommendation({ adAccountId, adSet, ambProductId: mapped?.ambProductId, productName: mapped?.productName, evalResult: rollback, batchId });
          rolledBack++;
          continue;
        }
      }
      if (lifecycle.canEvaluateBump) {
        const bump = evaluateAdSetForBump({ cpa: adSet.cpa, spend: adSet.spend, purchases: adSet.purchases, currentBudget: adSet.budget }, bumpCfg);
        if (bump.action === 'BUMP') {
          await persistBumpRecommendation({ adAccountId, adSet, ambProductId: mapped?.ambProductId, productName: mapped?.productName, evalResult: bump, batchId });
          bumped++;
        }
      }
    } catch (err) {
      logger.warn('[budgetBumpOrchestrator] failed for ad set', { adsetId: adSet.entityId, message: err.message });
    }
  }
  return { scanned, bumped, rolledBack };
}

let timer = null;
export function startBudgetBumpScheduler() {
  if (timer) return;
  const EVERY_MS = 30 * 60 * 1000;
  timer = setInterval(() => {
    runBudgetBumpAnalysis().catch((err) => logger.error('Budget bump scheduler tick failed', { message: err.message }));
  }, EVERY_MS);
  logger.info('Budget bump scheduler started (30m)');
}
