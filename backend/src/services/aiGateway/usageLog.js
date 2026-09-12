// AI Gateway — usage/cost logging (§37) + the aggregates the admin
// dashboard (§38) reads. Append-only; a logging failure must never break
// the actual AI feature it's recording (best-effort, caught + warned).
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';

export async function logUsage({ feature, tier, model, promptVersion, status, cached, inputTokens, cachedInputTokens, outputTokens, imageCount, imageGenerationType, imageSize, estimatedCostUsd, requestId, error, productId, userId, durationMs }) {
  try {
    await prisma.aiUsageLog.create({
      data: {
        feature, tier, model, prompt_version: promptVersion || null, status, cached: !!cached,
        input_tokens: inputTokens ?? null, cached_input_tokens: cachedInputTokens ?? null, output_tokens: outputTokens ?? null,
        image_count: imageCount || 0, image_generation_type: imageGenerationType || null, image_size: imageSize || null,
        estimated_cost_usd: estimatedCostUsd ?? null,
        request_id: requestId || null, error: error ? String(error).slice(0, 500) : null,
        product_id: productId ?? null, user_id: userId ?? null, duration_ms: durationMs ?? null,
      },
    });
  } catch (err) {
    logger.warn('AI_USAGE_LOG_WRITE_FAILED', { message: err.message });
  }
}

function since(days) { return new Date(Date.now() - days * 24 * 3600 * 1000); }
function startOfMonthUtc() { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }

// §6 unified text+image window summary — every count/cost split by tier so
// the dashboard never has to re-derive text-vs-image itself.
function r3(n) { return Math.round(n * 1000) / 1000; }
async function windowSummary(from) {
  const rows = await prisma.aiUsageLog.findMany({ where: { created_at: { gte: from } }, select: { status: true, cached: true, estimated_cost_usd: true, image_count: true, tier: true } });
  const textRows = rows.filter((r) => r.tier !== 'image');
  const imageRows = rows.filter((r) => r.tier === 'image');
  const cost = rows.reduce((a, r) => a + (r.estimated_cost_usd || 0), 0);
  const imageCost = imageRows.reduce((a, r) => a + (r.estimated_cost_usd || 0), 0);
  const textCost = cost - imageCost;
  const cacheHits = textRows.filter((r) => r.cached).length; // caching only ever applies to text/vision — image generation is never cached (§9/§67 dedupes by image HASH elsewhere, not a blanket cache)
  return {
    calls: rows.length,
    costUsd: r3(cost),
    textCalls: textRows.length,
    textCostUsd: r3(textCost),
    textFailed: textRows.filter((r) => r.status === 'FAILED').length,
    imageCalls: imageRows.length,
    imageGenerations: imageRows.reduce((a, r) => a + (r.image_count || 0), 0),
    imageCostUsd: r3(imageCost),
    imageFailed: imageRows.filter((r) => r.status === 'FAILED').length,
    failed: rows.filter((r) => r.status === 'FAILED').length,
    cacheHitPct: textRows.length ? Math.round((cacheHits / textRows.length) * 1000) / 10 : null,
  };
}

/** §38 admin usage dashboard data. Real numbers only — an unconfigured price rate just means costUsd stays at whatever's actually priced (partial sum), never an invented total. */
export async function usageSummary() {
  const [today, last7, month, monthBudget] = await Promise.all([
    windowSummary(new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z')),
    windowSummary(since(7)),
    windowSummary(startOfMonthUtc()),
    prisma.aiUsageLog.groupBy({ by: ['tier'], where: { created_at: { gte: startOfMonthUtc() } }, _count: { _all: true }, _sum: { estimated_cost_usd: true } }),
  ]);
  const byTier = Object.fromEntries(monthBudget.map((r) => [r.tier, { calls: r._count._all, costUsd: Math.round((r._sum.estimated_cost_usd || 0) * 1000) / 1000 }]));

  const byFeatureRows = await prisma.aiUsageLog.groupBy({ by: ['feature'], where: { created_at: { gte: since(7) } }, _count: { _all: true }, _sum: { estimated_cost_usd: true } });
  const mostExpensiveFeature = byFeatureRows.filter((r) => r._sum.estimated_cost_usd).sort((a, b) => (b._sum.estimated_cost_usd || 0) - (a._sum.estimated_cost_usd || 0))[0] || null;
  const byModelRows = await prisma.aiUsageLog.groupBy({ by: ['model'], where: { created_at: { gte: since(7) } }, _count: { _all: true }, _sum: { estimated_cost_usd: true } });
  const mostExpensiveModel = byModelRows.filter((r) => r._sum.estimated_cost_usd).sort((a, b) => (b._sum.estimated_cost_usd || 0) - (a._sum.estimated_cost_usd || 0))[0] || null;

  return {
    today, last7, month,
    byTier: { routine: byTier.routine || { calls: 0, costUsd: 0 }, balanced: byTier.balanced || { calls: 0, costUsd: 0 }, advanced: byTier.advanced || { calls: 0, costUsd: 0 }, image: byTier.image || { calls: 0, costUsd: 0 } },
    mostExpensiveFeature: mostExpensiveFeature ? { feature: mostExpensiveFeature.feature, costUsd: Math.round((mostExpensiveFeature._sum.estimated_cost_usd || 0) * 1000) / 1000 } : null,
    mostExpensiveModel: mostExpensiveModel ? { model: mostExpensiveModel.model, costUsd: Math.round((mostExpensiveModel._sum.estimated_cost_usd || 0) * 1000) / 1000 } : null,
  };
}

/** Month-to-date spend used by the budget guard — pure sum, no caching (call frequency is bounded by real AI calls, never hammered). */
export async function monthToDateCostUsd() {
  const agg = await prisma.aiUsageLog.aggregate({ where: { created_at: { gte: startOfMonthUtc() } }, _sum: { estimated_cost_usd: true } });
  return agg._sum.estimated_cost_usd || 0;
}
