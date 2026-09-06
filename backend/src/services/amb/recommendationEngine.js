// AI Media Buyer — Recommendation Engine (layer 6). Turns the deterministic
// hierarchy + rule-engine output into structured, prioritised
// AmbRecommendation rows. Claude is called ONCE at the end only to author
// the `reason` text and the executive summary; every number, decision,
// action_type, priority, confidence, risk and data-sufficiency value here is
// deterministic and is what gets persisted — Claude cannot move any of them.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection } from '../metaAuth.js';
import { getAmbSettings } from './settings.js';
import { resolveWindow, entityIntradayTrend, assessCreativeFatigue } from './metricsEngine.js';
import { buildHierarchy, nodeStatus } from './hierarchyAnalysis.js';
import { economicsSummary, netProfitBundle } from './productEconomics.js';
import { codCountsForProduct } from './codOrders.js';
import { computeScaleRecommendation, evaluateStopSignals, validateAction } from './ruleEngine.js';
import { narrateRecommendations, buildOutcomeContext } from './claudeAnalyst.js';
import { raiseAlert } from './alerts.js';

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
const suff2conf = { STRONG: 'HIGH', MODERATE: 'MEDIUM', WEAK: 'LOW' };

/** Walk campaign→adset→ad nodes of a hierarchy, yielding {node, productName, ambProductId, econ}. */
function* walkExecutableNodes(tree) {
  const emit = function* (campaign, productName, ambProductId, econ) {
    yield { node: campaign, level: 'campaign', productName, ambProductId, econ };
    for (const as of campaign.children || []) {
      yield { node: as, level: 'adset', productName, ambProductId, econ, campaign };
      for (const ad of as.children || []) yield { node: ad, level: 'ad', productName, ambProductId, econ, campaign, adset: as };
    }
  };
  for (const p of tree.products || []) {
    for (const c of p.children || []) yield* emit(c, p.name, Number(p.id), p.economics);
  }
  for (const c of tree.unmappedCampaigns || []) yield* emit(c, null, null, null);
}

/** Which node actually holds the editable budget: CBO → the campaign; ABO → the adset. */
function budgetHolder(ctx) {
  const { node, level, campaign } = ctx;
  if (level === 'campaign' && node.budget != null) return { entity: node, entityLevel: 'campaign' };
  if (level === 'adset' && node.budget != null && !(campaign && campaign.budget != null)) return { entity: node, entityLevel: 'adset' };
  return null;
}

/**
 * Decide ONE candidate action for a node (deterministic). Returns null when
 * the node warrants no recommendation (healthy/insufficient with nothing to
 * say). trend/fatigue are optional enrichments.
 */
function decideForNode(ctx, settings, trend, fatigue, productNetProfit) {
  const { node, level, econ } = ctx;
  const m = node.metrics || {};
  const status = node.status || nodeStatus(m, econ, settings);
  const stop = evaluateStopSignals({ metrics: m, econ, settings, trend });
  const holder = budgetHolder(ctx);
  const currentBudget = holder ? holder.entity.budget : null;
  const target = n(econ?.targetCpa) ?? n(settings.ambDefaultTargetCpa) ?? 120;
  const targetMetrics = { targetCpa: target, maxCpa: n(econ?.maxCpa) ?? n(econ?.codBreakEvenCpa) ?? n(econ?.breakEvenCpa) ?? target * 1.5 };

  const base = {
    level, entity_name: node.name, entity_id: node.id,
    campaign_id: ctx.campaign?.id || (level === 'campaign' ? node.id : null),
    campaign_name: ctx.campaign?.name || (level === 'campaign' ? node.name : null),
    adset_id: ctx.adset?.id || (level === 'adset' ? node.id : null),
    adset_name: ctx.adset?.name || (level === 'adset' ? node.name : null),
    ad_id: level === 'ad' ? node.id : null,
    ad_name: level === 'ad' ? node.name : null,
    product_name: ctx.productName, amb_product_id: ctx.ambProductId,
    current_metrics: m, target_metrics: targetMetrics,
    current_budget: currentBudget, recommended_budget: null, budget_change_pct: null,
    confidence: suff2conf[m.dataSufficiency] || 'LOW',
    data_sufficiency: m.dataSufficiency || 'WEAK',
    reason_facts: { status: status.verdict, statusReasons: status.reasons, stopSignals: stop.signals, fatigue: fatigue?.status || null },
  };

  // --- STOP path -----------------------------------------------------------
  if (stop.stop && stop.severity === 'CRITICAL') {
    return { ...base, decision: 'PAUSE_LOSER', action_type: 'PAUSE', risk_level: 'LOW', priority: 'P0' };
  }
  if (status.color === 'RED') {
    // A confirmed loss is always P0 (spec "P0 — Critical Loss"). Prefer a
    // budget cut when there's a budget to cut and there ARE some sales;
    // pause outright when it's a pure zero-result burn.
    if ((m.purchases || 0) === 0) return { ...base, decision: 'PAUSE_LOSER', action_type: 'PAUSE', risk_level: 'LOW', priority: 'P0' };
    if (holder) {
      const pct = n(settings.ambMaxBudgetIncreasePct) ?? 20;
      const newB = Math.max(1, Math.round(currentBudget * (1 - pct / 100)));
      return { ...base, decision: 'REDUCE_BUDGET', action_type: 'DECREASE_BUDGET', recommended_budget: newB, budget_change_pct: -pct, risk_level: 'LOW', priority: 'P0' };
    }
    return { ...base, decision: 'PAUSE_LOSER', action_type: 'PAUSE', risk_level: 'MEDIUM', priority: 'P0' };
  }

  // --- OPTIMIZE path -----------------------------------------------------------
  if (status.color === 'YELLOW') {
    if (fatigue?.status === 'FATIGUED') return { ...base, decision: 'TEST_NEW_CREATIVE', action_type: 'DRAFT_TEST_NEW_CREATIVE', risk_level: 'LOW', priority: 'P2' };
    if (holder && (m.purchases || 0) > 0) {
      const newB = Math.max(1, Math.round(currentBudget * 0.9));
      return { ...base, decision: 'REDUCE_BUDGET', action_type: 'DECREASE_BUDGET', recommended_budget: newB, budget_change_pct: -10, risk_level: 'LOW', priority: 'P2' };
    }
    return { ...base, decision: 'MONITOR', action_type: 'DRAFT_MONITOR', risk_level: 'LOW', priority: 'P2' };
  }

  // --- SCALE path -----------------------------------------------------------
  if (status.color === 'BLUE' || (status.color === 'GREEN' && holder)) {
    const scale = computeScaleRecommendation({ metrics: m, econ, settings, currentBudget });
    if (scale.shouldScale && holder) {
      const strongBand = ['STRONG', 'GOOD'].includes(scale.band);
      const loss = productNetProfit != null && productNetProfit < -(n(settings.ambMaxAllowedDailyLoss) ?? 1000);
      if (loss) return { ...base, decision: 'HOLD', action_type: 'DRAFT_MONITOR', risk_level: 'MEDIUM', priority: 'P2', reason_facts: { ...base.reason_facts, blockedBy: 'MAX_DAILY_LOSS' } };
      return {
        ...base, decision: 'INCREASE_BUDGET', action_type: 'INCREASE_BUDGET',
        recommended_budget: scale.newBudget, budget_change_pct: scale.changePct,
        risk_level: strongBand ? 'MEDIUM' : 'LOW', priority: strongBand ? 'P1' : 'P2',
        reason_facts: { ...base.reason_facts, scaleBand: scale.band },
      };
    }
    if (status.color === 'BLUE') {
      return { ...base, decision: 'DUPLICATE_WINNER', action_type: 'DRAFT_DUPLICATE_WINNER', risk_level: 'LOW', priority: 'P2' };
    }
  }

  // --- fatigue on an otherwise-healthy winner ----------------------------------
  if (fatigue?.status === 'EARLY_FATIGUE') {
    return { ...base, decision: 'TEST_NEW_CREATIVE', action_type: 'DRAFT_TEST_NEW_CREATIVE', risk_level: 'LOW', priority: 'P3' };
  }

  return null; // healthy / no-op
}

/**
 * Run a full analysis + recommendation cycle for the connected ad account
 * and window. Persists one batch of AmbRecommendation rows (supersedes the
 * previous still-PENDING batch for the same account). Returns the batch.
 */
export async function generateRecommendations({ windowName = null, triggeredById = null } = {}) {
  const connection = await getConnection();
  if (!connection || connection.status !== 'CONNECTED' || !connection.selected_ad_account_id) {
    return { ok: false, error: 'NOT_CONNECTED' };
  }
  const adAccountId = connection.selected_ad_account_id;
  const settings = await getAmbSettings();
  const window = resolveWindow(windowName || (settings.ambAnalysisLookbackDays >= 7 ? 'last7' : 'last3'));

  const tree = await buildHierarchy({ adAccountId, window, settings });

  // Per-product window net profit (real, from COD data) for the max-loss rule.
  const netProfitByProduct = new Map();
  for (const p of tree.products || []) {
    const pid = Number(p.id);
    const prod = await prisma.ambProduct.findUnique({ where: { id: pid } });
    if (!prod) continue;
    const counts = await codCountsForProduct({ productId: prod.product_id || -1, from: window.from, to: window.to });
    const bundle = netProfitBundle(prod, {
      adSpend: p.metrics?.spend || 0,
      deliveredOrders: counts.delivered,
      returnedOrders: counts.returned,
    });
    netProfitByProduct.set(pid, bundle.netProfit);
  }

  const candidates = [];
  for (const ctx of walkExecutableNodes(tree)) {
    const m = ctx.node.metrics;
    if (!m) continue;
    // Enrichment: intra-day trend + fatigue only for ad-level (cheap enough, most relevant).
    let trend = null, fatigue = null;
    if (ctx.level === 'ad') {
      trend = await entityIntradayTrend({ level: 'ad', entityId: ctx.node.id, hoursAgo: 6, adAccountId }).catch(() => null);
      fatigue = assessCreativeFatigue(trend, { frequency: m.frequency, freqCeiling: n(settings.ambCreativeFatigueFreqThreshold) ?? 3.5 });
    }
    const decided = decideForNode(ctx, settings, trend, fatigue, ctx.ambProductId ? netProfitByProduct.get(ctx.ambProductId) : null);
    if (decided) candidates.push(decided);
  }

  // Parent-child dedup: analysis runs at every level (spec), but a PAUSE at
  // campaign level already covers its ad sets/ads — don't also emit a PAUSE
  // for each child (that's the SAME action 3×). Keep the highest-level pause;
  // keep child pauses only when the parent isn't being paused.
  const pausedCampaigns = new Set(candidates.filter((c) => c.level === 'campaign' && ['PAUSE', 'PAUSE_LOSER'].includes(c.decision)).map((c) => c.campaign_id));
  const pausedAdsets = new Set(candidates.filter((c) => c.level === 'adset' && ['PAUSE', 'PAUSE_LOSER'].includes(c.decision)).map((c) => c.adset_id));
  const deduped = candidates.filter((c) => {
    if (['PAUSE', 'PAUSE_LOSER'].includes(c.decision)) {
      if (c.level === 'adset' && pausedCampaigns.has(c.campaign_id)) return false;
      if (c.level === 'ad' && (pausedCampaigns.has(c.campaign_id) || pausedAdsets.has(c.adset_id))) return false;
    }
    return true;
  });
  candidates.length = 0;
  candidates.push(...deduped);

  // Rule-engine pass — sets executable + attaches the check list.
  for (const c of candidates) {
    const rule = await validateAction({
      actionType: c.action_type,
      level: c.level,
      entityId: c.entity_id,
      campaignId: c.campaign_id,
      metrics: c.current_metrics,
      econ: null,
      settings,
      connection,
      currentBudget: c.current_budget,
      recommendedBudget: c.recommended_budget,
      netProfitWindow: c.amb_product_id ? netProfitByProduct.get(c.amb_product_id) : null,
    });
    c.rule_engine = rule;
    c.executable = rule.executable && ['PAUSE', 'RESUME', 'INCREASE_BUDGET', 'DECREASE_BUDGET'].includes(c.action_type);
  }

  // Stable per-candidate key for Claude ↔ persisted row correlation.
  const batchId = crypto.randomUUID();
  for (const c of candidates) {
    c.key = crypto.createHash('sha1').update(`${c.level}:${c.entity_id}:${c.decision}`).digest('hex').slice(0, 16);
  }

  // Claude narration (text only) + executive summary + outcome-history context.
  const history = await buildOutcomeContext().catch(() => []);
  const narration = await narrateRecommendations(candidates, { history });

  // Supersede the previous still-open batch for this account, then persist.
  await prisma.ambRecommendation.updateMany({
    where: { ad_account_id: adAccountId, status: 'PENDING' },
    data: { status: 'SUPERSEDED' },
  });

  const rows = candidates.map((c) => ({
    batch_id: batchId,
    ad_account_id: adAccountId,
    amb_product_id: c.amb_product_id || null,
    product_name: c.product_name || null,
    level: c.level,
    entity_id: c.entity_id || null,
    entity_name: c.entity_name || null,
    campaign_id: c.campaign_id || null,
    campaign_name: c.campaign_name || null,
    adset_id: c.adset_id || null,
    adset_name: c.adset_name || null,
    ad_id: c.ad_id || null,
    ad_name: c.ad_name || null,
    decision: c.decision,
    action_type: c.action_type,
    executable: !!c.executable,
    current_metrics_json: JSON.stringify(c.current_metrics || {}),
    target_metrics_json: JSON.stringify(c.target_metrics || {}),
    current_budget: c.current_budget ?? null,
    recommended_budget: c.recommended_budget ?? null,
    budget_change_pct: c.budget_change_pct ?? null,
    reason: narration.reasons.get(c.key) || null,
    reason_facts_json: JSON.stringify({ ...(c.reason_facts || {}), explain: narration.explanations.get(c.key) || null, narrationSource: narration.source }),
    rule_engine_json: JSON.stringify(c.rule_engine || {}),
    confidence: c.confidence,
    risk_level: c.risk_level,
    data_sufficiency: c.data_sufficiency,
    priority: c.priority,
    time_window_from: window.from,
    time_window_to: window.to,
    time_window_label: window.label,
    source: narration.source,
  }));

  if (rows.length > 0) await prisma.ambRecommendation.createMany({ data: rows });

  // Opportunity / critical alerts (deduped so a still-true condition doesn't respam).
  for (const c of candidates) {
    if (c.priority === 'P0') {
      await raiseAlert({
        severity: 'CRITICAL', category: 'CPA_LIMIT',
        title: `تدخل فوري: ${c.entity_name}`,
        message: `${c.decision} — ${narration.reasons.get(c.key) || 'راجع التوصية.'}`,
        adAccountId, level: c.level, entityId: c.entity_id, campaignId: c.campaign_id,
        dedupeKey: `p0:${c.entity_id}:${c.decision}`,
      }).catch(() => {});
    } else if (c.decision === 'INCREASE_BUDGET' && c.priority === 'P1') {
      await raiseAlert({
        severity: 'OPPORTUNITY', category: 'SCALE_READY',
        title: `فرصة توسّع: ${c.entity_name}`,
        message: `${narration.reasons.get(c.key) || 'CPA أقل من الهدف مع حجم كافٍ.'}`,
        adAccountId, level: c.level, entityId: c.entity_id, campaignId: c.campaign_id,
        dedupeKey: `scale:${c.entity_id}`,
      }).catch(() => {});
    }
  }

  logger.info('AMB recommendations generated', { batchId, count: rows.length, source: narration.source, window });
  return { ok: true, batchId, count: rows.length, executiveSummary: narration.executiveSummary, source: narration.source, window };
}

/** The current open batch (PENDING/APPROVED/EXECUTED rows from the newest batch_id) for the connected account. */
export async function getCurrentRecommendations() {
  const connection = await getConnection();
  if (!connection?.selected_ad_account_id) return { ok: false, error: 'NOT_CONNECTED' };
  const newest = await prisma.ambRecommendation.findFirst({
    where: { ad_account_id: connection.selected_ad_account_id },
    orderBy: { created_at: 'desc' },
    select: { batch_id: true, created_at: true },
  });
  if (!newest) return { ok: true, batchId: null, items: [] };
  const items = await prisma.ambRecommendation.findMany({
    where: { batch_id: newest.batch_id },
    orderBy: [{ priority: 'asc' }, { created_at: 'asc' }],
  });
  return { ok: true, batchId: newest.batch_id, generatedAt: newest.created_at, items: items.map(serializeRec) };
}

/** Groups the decision into the spec's Action Plan categories. */
export function recCategory(decision) {
  if (['SCALE', 'INCREASE_BUDGET'].includes(decision)) return 'SCALE';
  if (['HOLD'].includes(decision)) return 'HOLD';
  if (['MONITOR'].includes(decision)) return 'MONITOR';
  if (['PAUSE', 'PAUSE_LOSER', 'REDUCE_BUDGET'].includes(decision)) return 'PAUSE_CANDIDATE';
  if (['TEST_NEW_CREATIVE', 'TEST_NEW_HOOK', 'DUPLICATE_WINNER', 'TEST_NEW_AUDIENCE'].includes(decision)) return 'NEW_CREATIVE_NEEDED';
  return 'MONITOR';
}

export function serializeRec(r) {
  const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
  const facts = parse(r.reason_facts_json, {});
  return {
    id: r.id,
    batchId: r.batch_id,
    level: r.level,
    productName: r.product_name,
    ambProductId: r.amb_product_id,
    entityId: r.entity_id,
    entityName: r.entity_name,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    adsetName: r.adset_name,
    adName: r.ad_name,
    decision: r.decision,
    category: recCategory(r.decision),
    actionType: r.action_type,
    executable: r.executable,
    currentMetrics: parse(r.current_metrics_json, {}),
    targetMetrics: parse(r.target_metrics_json, {}),
    currentBudget: r.current_budget,
    recommendedBudget: r.recommended_budget,
    budgetChangePct: r.budget_change_pct,
    reason: r.reason,
    explain: facts.explain || null,
    reasonFacts: facts,
    ruleEngine: parse(r.rule_engine_json, {}),
    confidence: r.confidence,
    riskLevel: r.risk_level,
    dataSufficiency: r.data_sufficiency,
    priority: r.priority,
    timeWindow: { from: r.time_window_from, to: r.time_window_to, label: r.time_window_label },
    source: r.source,
    status: r.status,
    reviewedAt: r.reviewed_at,
    editedJson: parse(r.edited_json, null),
    createdAt: r.created_at,
  };
}
