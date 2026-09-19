// Smart Decision Center — Automatic Analysis. NOT a new decision engine:
// calls the EXISTING buildProductDecisionPackage()/persistProductDecision()
// exactly like the manual POST /product-decision/:id endpoint already does.
// The only new logic here: running this periodically over every product
// with real linked campaigns, and only writing a NEW recommendation row
// when there isn't one yet or the decision has genuinely, materially
// changed — never spamming an identical row every tick, and never
// requiring the user to press "تحليل منتج جديد".
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection } from '../metaAuth.js';
import { getAmbSettings } from './settings.js';
import { resolveProductCampaigns } from './productPerformance.js';
import { buildProductDecisionPackage, persistProductDecision } from './productDecision.js';

const MIN_HOURS_BETWEEN_RUNS = 6;
const CPA_CHANGE_THRESHOLD = 0.15;
const CONFIRMATION_MATURITY_DELTA = 0.1;

/** Plain, human-readable Arabic reasons for why a decision changed — never a raw diff dump. */
function describeChange(lastRec, pkg) {
  if (!lastRec) return ['أول تحليل لهذا المنتج'];
  const reasons = [];
  if (lastRec.decision !== pkg.decision) reasons.push(`القرار تغيّر من ${lastRec.decision} إلى ${pkg.decision}`);
  let lastMetrics = {};
  try { lastMetrics = JSON.parse(lastRec.current_metrics_json || '{}'); } catch { /* keep empty */ }
  const cur = pkg.diagnosis.metrics;
  if (lastMetrics.avgCpa != null && cur.avgCpa != null && lastMetrics.avgCpa > 0) {
    const rel = (cur.avgCpa - lastMetrics.avgCpa) / lastMetrics.avgCpa;
    if (Math.abs(rel) >= CPA_CHANGE_THRESHOLD) reasons.push(rel < 0 ? `CPA تحسّن (${Math.round(lastMetrics.avgCpa)} ← ${Math.round(cur.avgCpa)} ج)` : `CPA ارتفع (${Math.round(lastMetrics.avgCpa)} ← ${Math.round(cur.avgCpa)} ج)`);
  }
  if (lastMetrics.confirmationRate != null && cur.confirmationRate != null && (cur.confirmationRate - lastMetrics.confirmationRate) >= CONFIRMATION_MATURITY_DELTA) {
    reasons.push('معدل التأكيد نضج (بيانات COD أوفى)');
  }
  if (lastMetrics.codSample != null && cur.codSample != null && cur.codSample > lastMetrics.codSample * 1.5 && cur.codSample >= 20) {
    reasons.push(`حجم عينة COD زاد بشكل كافٍ (${lastMetrics.codSample} ← ${cur.codSample})`);
  }
  return reasons;
}

/**
 * The scheduler-tick function. Scoped to real, already-linked products only
 * — a product with zero resolvable campaigns is left as UNMAPPED in the
 * inbox and is never force-analyzed (nothing real to analyze yet).
 */
export async function runAutoAnalysis() {
  const connection = await getConnection();
  const adAccountId = connection?.selected_ad_account_id;
  if (!adAccountId) return { scanned: 0, analyzed: 0, changed: 0, reason: 'NO_AD_ACCOUNT' };
  const settings = await getAmbSettings();
  const windowName = Number(settings.ambAnalysisLookbackDays) >= 30 ? 'last30' : 'last7';

  const ambProducts = await prisma.ambProduct.findMany({ where: { product_id: { not: null }, active: true }, select: { id: true, product_id: true } });
  let scanned = 0, analyzed = 0, changed = 0;

  for (const { id: ambProductId, product_id: productId } of ambProducts) {
    scanned++;
    try {
      const campaigns = await resolveProductCampaigns(productId);
      if (!campaigns.length) continue;

      const lastRec = await prisma.ambRecommendation.findFirst({ where: { level: 'product', amb_product_id: ambProductId }, orderBy: { created_at: 'desc' } });
      if (lastRec && (Date.now() - lastRec.created_at.getTime()) < MIN_HOURS_BETWEEN_RUNS * 3600 * 1000) continue;

      const pkg = await buildProductDecisionPackage({ productId, windowName, settings, adAccountId });
      analyzed++;

      const reasons = describeChange(lastRec, pkg);
      if (!lastRec || reasons.length) {
        await persistProductDecision({ pkg, adAccountId, batchId: `auto-${Date.now()}`, changeReasons: reasons });
        changed++;
        if (lastRec) logger.info('[productAutoAnalysis] decision updated', { productId, from: lastRec.decision, to: pkg.decision, reasons });
      }
    } catch (err) {
      logger.warn('[productAutoAnalysis] failed for product', { productId, message: err.message });
    }
  }
  return { scanned, analyzed, changed };
}

let timer = null;
/** Runs less often than the H6/H12/H24 experiment/outcome tickers — a full Decision Package is much heavier (funnel + creative + segment intel) than a checkpoint slice. */
export function startProductAutoAnalysisScheduler() {
  if (timer) return;
  const EVERY_MS = 30 * 60 * 1000;
  timer = setInterval(() => {
    runAutoAnalysis().catch((err) => logger.error('Product auto-analysis scheduler tick failed', { message: err.message }));
  }, EVERY_MS);
  logger.info('Product auto-analysis scheduler started (30m)');
}
