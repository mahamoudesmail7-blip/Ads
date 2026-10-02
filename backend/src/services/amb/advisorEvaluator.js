// Smart Advisor — ONE bounded background evaluator (2026-10-02).
// Finds recommendations that are PREPARED/APPROVED/EXECUTED/MEASURING, advances their lifecycle from the real
// AssistantTask state, evaluates only the ones that are due, and recomputes the product plan ONLY when an
// evaluation actually finalised (meaningful event). Reads already-synced data; sequential per recommendation
// (small shared Prisma pool); never calls Meta/Easy Orders; never executes anything.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getAmbSettings } from './settings.js';
import { evaluateRecommendation, syncRecLifecycle, runAdvisorForProduct, invalidatePlanCache } from './advisorTracking.js';

export async function runAdvisorEvaluatorTick({ provider, now = new Date() } = {}) {
  const settings = await getAmbSettings();
  if (!settings.ambAdvisorEvaluatorEnabled) return { skipped: 'DISABLED' };
  const intervalMs = Math.max(5, Number(settings.ambAdvisorEvaluatorIntervalMinutes) || 30) * 60_000;
  const maxRecs = Math.max(1, Number(settings.ambAdvisorMaxProductsPerTick) || 4) * 3;
  const candidates = await prisma.ambAdvisorRecommendation.findMany({ where: { status: { in: ['PREPARED', 'APPROVED', 'EXECUTED', 'MEASURING'] } }, orderBy: { updated_at: 'asc' }, take: 200 });
  let checked = 0, finalized = 0, failed = 0; const touched = new Set();
  for (const rec of candidates) {
    if (checked >= maxRecs) break;
    try {
      let cur = rec;
      if (['PREPARED', 'APPROVED'].includes(cur.status)) cur = await syncRecLifecycle(cur);
      if (!['EXECUTED', 'MEASURING'].includes(cur.status)) continue;
      const lastCheck = JSON.parse(cur.evaluation_json || '{}')?.progress?.lastCheckAt;
      if (lastCheck && now.getTime() - new Date(lastCheck).getTime() < intervalMs) continue; // not due yet
      checked++;
      const r = await evaluateRecommendation(cur.recommendation_id, { provider, now });
      if (r.finalized) { finalized++; touched.add(`${cur.store_id}:${cur.product_id}`); }
    } catch (err) { failed++; logger.warn('[advisorEvaluator] recommendation failed', { recommendationId: rec.recommendation_id, message: err.message }); }
  }
  for (const k of touched) { // a verdict is a meaningful state change -> recompute plan (a new version is only written if the hash really changed)
    const [storeId, pid] = [k.slice(0, k.lastIndexOf(':')), Number(k.slice(k.lastIndexOf(':') + 1))];
    invalidatePlanCache(pid, storeId);
    await runAdvisorForProduct({ productId: pid, storeId, trigger: 'EVALUATION', fresh: true }).catch((e) => logger.warn('[advisorEvaluator] replan failed', { productId: pid, message: e.message }));
  }
  if (checked || failed) logger.info('Smart Advisor evaluator tick', { checked, finalized, failed });
  return { checked, finalized, failed };
}

let timer = null;
export function startAdvisorEvaluatorScheduler() {
  if (timer) return;
  let running = false;
  timer = setInterval(async () => {
    if (running) return; // never overlap ticks
    running = true;
    try { await runAdvisorEvaluatorTick(); } catch (err) { logger.error('Smart Advisor evaluator tick failed', { message: err.message }); } finally { running = false; }
  }, 5 * 60_000);
  timer.unref?.();
  logger.info('Smart Advisor evaluator scheduler started (5-min poll, per-recommendation due-gating)');
}
