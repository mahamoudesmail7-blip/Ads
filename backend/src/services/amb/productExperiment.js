// Smart Decision Center Phase 9 — Experiment Measurement. Reuses the
// EXISTING AmbAction/AmbActionResult H6/H12/H24 checkpoint machinery
// (executor.js creates the 3 due_at rows at execution time; outcomeEval.js's
// runOutcomeEvaluation() is the exact scheduler-tick pattern this mirrors)
// — never a new table, never a new checkpoint schedule. The one new piece:
// PRODUCT-level decisions need a product-wide before/after comparison
// (Phase 2's getProductPerformance, sliced by real timestamp windows around
// the execution moment) instead of outcomeEval.js's single-Meta-entity
// snapshot slice, and a comparison of the DECISION's OWN successMetric
// rather than a fixed PAUSE/RESUME/budget-move rulebook.
//
// Internally still stores result_class as SUCCESSFUL|NEUTRAL|FAILED (the
// existing AmbActionResult column, unchanged) — serializeExperimentOutcome()
// below is the translation layer that exposes it as the requested
// IMPROVED|NO_CHANGE|WORSE|INCONCLUSIVE vocabulary, exactly as this
// session's own Phase 1 plan called for ("reuse AmbActionResult as-is; only
// expose its vocabulary differently").
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getProductPerformance } from './productPerformance.js';
import { applyLearningFromExperiment } from './productLearning.js';

const CHECKPOINT_HOURS = { H6: 6, H12: 12, H24: 24 };

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function toISODate(ms) { return new Date(ms).toISOString().slice(0, 10); }

/** Maps a Decision Package's free-text successMetric label to a real, comparable field + direction. Every label this file ever produces (productDecision.js's own vocabulary) is covered; an unrecognized label safely falls back to purchases volume. */
function resolveMetricField(successMetric) {
  const s = String(successMetric || '');
  if (/CPA/.test(s)) return { field: 'cpa', direction: 'LOWER_BETTER' };
  if (/CPC/.test(s)) return { field: 'cpc', direction: 'LOWER_BETTER' };
  if (/CTR/.test(s)) return { field: 'ctr', direction: 'HIGHER_BETTER' };
  if (/تحويل/.test(s)) return { field: 'conversionRate', direction: 'HIGHER_BETTER' };
  if (/تأكيد/.test(s)) return { field: 'confirmationRate', direction: 'HIGHER_BETTER', source: 'easyOrders' };
  if (/تسليم/.test(s)) return { field: 'deliveryRate', direction: 'HIGHER_BETTER', source: 'easyOrders' };
  if (/ربح/.test(s)) return { field: 'revenue', direction: 'HIGHER_BETTER' }; // real profit needs AmbProduct economics not carried in this pure performance slice — revenue is the closest real, always-available proxy
  return { field: 'purchases', direction: 'HIGHER_BETTER' };
}

function metricValue(perf, field, source) {
  const block = source === 'easyOrders' ? perf.easyOrders : perf.meta;
  if (!block || (source === 'easyOrders' ? block.dataState !== 'AVAILABLE' : block.dataState !== 'AVAILABLE')) return null;
  return n(block[field]);
}

/** Real before/after, sliced by timestamp exactly like outcomeEval.js's sliceMetrics() does for single-entity actions — just against the product-wide dataset instead of one Meta entity. */
async function beforeAfterForCheckpoint({ productId, executedAtMs, hours }) {
  const before = await getProductPerformance({ productId, from: toISODate(executedAtMs - hours * 3600 * 1000), to: toISODate(executedAtMs) });
  const after = await getProductPerformance({ productId, from: toISODate(executedAtMs), to: toISODate(executedAtMs + hours * 3600 * 1000) });
  return { before, after };
}

function classify({ beforeVal, afterVal, direction }) {
  if (beforeVal == null || afterVal == null) return { cls: null, note: 'مفيش بيانات كافية في إحدى الفترتين (قبل/بعد) للتقييم — النتيجة غير حاسمة.' };
  if (beforeVal === 0 && afterVal === 0) return { cls: 'NEUTRAL', note: 'لا تغيير — نفس القيمة (صفر) في الفترتين.' };
  const rel = beforeVal !== 0 ? (afterVal - beforeVal) / Math.abs(beforeVal) : (afterVal > 0 ? 1 : -1);
  const improved = direction === 'LOWER_BETTER' ? rel <= -0.1 : rel >= 0.1;
  const worsened = direction === 'LOWER_BETTER' ? rel >= 0.15 : rel <= -0.15;
  if (improved) return { cls: 'SUCCESSFUL', note: `تحسّن حقيقي: ${beforeVal.toFixed(2)} → ${afterVal.toFixed(2)} (${Math.round(rel * 100)}%).` };
  if (worsened) return { cls: 'FAILED', note: `تراجع حقيقي: ${beforeVal.toFixed(2)} → ${afterVal.toFixed(2)} (${Math.round(rel * 100)}%).` };
  return { cls: 'NEUTRAL', note: `تغيّر طفيف غير حاسم: ${beforeVal.toFixed(2)} → ${afterVal.toFixed(2)} (${Math.round(rel * 100)}%).` };
}

/**
 * The scheduler-tick function — same shape as outcomeEval.js's
 * runOutcomeEvaluation(), scoped to level:'product' actions only (the
 * existing function already owns every other level; this file never
 * touches those rows).
 */
export async function evaluateProductExperiments() {
  const due = await prisma.ambActionResult.findMany({
    where: { evaluated_at: null, due_at: { lte: new Date() }, action: { level: 'product' } },
    include: { action: { include: { recommendation: true } } },
  });
  if (!due.length) return { checked: 0, evaluated: 0 };

  let evaluated = 0;
  for (const row of due) {
    const action = row.action;
    const rec = action.recommendation;
    try {
      const ambProduct = rec.amb_product_id ? await prisma.ambProduct.findUnique({ where: { id: rec.amb_product_id }, select: { product_id: true } }) : null;
      const productId = ambProduct?.product_id;
      if (!productId) {
        await prisma.ambActionResult.update({ where: { id: row.id }, data: { evaluated_at: new Date(), result_class: null, notes_json: JSON.stringify({ note: 'تعذّر إيجاد المنتج الحقيقي المرتبط — لا يمكن القياس.' }) } });
        evaluated++; continue;
      }
      const facts = JSON.parse(rec.reason_facts_json || '{}');
      const { field, direction, source } = resolveMetricField(facts.successMetric);
      const hours = CHECKPOINT_HOURS[row.checkpoint] || 24;
      const executedAtMs = (action.executed_at || action.created_at).getTime();
      const { before, after } = await beforeAfterForCheckpoint({ productId, executedAtMs, hours });
      const beforeVal = metricValue(before, field, source);
      const afterVal = metricValue(after, field, source);
      const { cls, note } = classify({ beforeVal, afterVal, direction });

      await prisma.ambActionResult.update({
        where: { id: row.id },
        data: {
          evaluated_at: new Date(),
          result_class: cls,
          cpa_before: field === 'cpa' ? beforeVal : null, cpa_after: field === 'cpa' ? afterVal : null,
          spend_before: n(before.meta?.spend), spend_after: n(after.meta?.spend),
          purchases_before: n(before.meta?.purchases), purchases_after: n(after.meta?.purchases),
          notes_json: JSON.stringify({ field, direction, beforeVal, afterVal, note, successMetric: facts.successMetric }),
        },
      });

      // Phase 10: only the FINAL (H24) checkpoint feeds Product Learning
      // Memory — H6/H12 are still measured and stored above, but writing a
      // durable WORKS/DOES_NOT_WORK verdict off an early, noisier read would
      // risk a premature conclusion the H24 read might reverse.
      if (row.checkpoint === 'H24' && cls) {
        await applyLearningFromExperiment({ productId, facts, resultClass: cls, evidence: { note, actionId: action.id, recommendationId: rec.id } });
      }

      evaluated++;
    } catch (err) {
      logger.warn('[productExperiment] evaluation failed', { actionResultId: row.id, message: err.message });
      await prisma.ambActionResult.update({ where: { id: row.id }, data: { evaluated_at: new Date(), result_class: null, notes_json: JSON.stringify({ note: `فشل التقييم: ${err.message}` }) } }).catch(() => {});
    }
  }
  return { checked: due.length, evaluated };
}

/** SUCCESSFUL|NEUTRAL|FAILED (the real, stored column) -> IMPROVED|NO_CHANGE|WORSE|INCONCLUSIVE (the requested vocabulary) — translation only, never a second classification. */
export function experimentOutcomeLabel(resultClass) {
  return { SUCCESSFUL: 'IMPROVED', NEUTRAL: 'NO_CHANGE', FAILED: 'WORSE' }[resultClass] || 'INCONCLUSIVE';
}

let timer = null;
/** Same 10-minute cadence as outcomeEval.js's own scheduler, running independently so a failure in one never blocks the other. */
export function startProductExperimentScheduler() {
  if (timer) return;
  const EVERY_MS = 10 * 60 * 1000;
  timer = setInterval(() => {
    evaluateProductExperiments().catch((err) => logger.error('Product experiment scheduler tick failed', { message: err.message }));
  }, EVERY_MS);
  logger.info('Product experiment evaluation scheduler started (10m)');
}

/** The full experiment view for one product decision — before metrics + all 3 checkpoints + the overall outcome (the LATEST evaluated checkpoint, since H24 is the most complete picture once available). */
export async function getProductExperiment({ recId }) {
  const rec = await prisma.ambRecommendation.findUnique({ where: { id: Number(recId) }, include: { actions: { include: { results: true }, orderBy: { created_at: 'desc' }, take: 1 } } });
  if (!rec || rec.level !== 'product') { const e = new Error('قرار المنتج غير موجود.'); e.status = 404; throw e; }
  const action = rec.actions[0] || null;
  if (!action) return { hasExperiment: false };

  const checkpoints = ['H6', 'H12', 'H24'].map((cp) => {
    const r = action.results.find((x) => x.checkpoint === cp);
    if (!r) return { checkpoint: cp, status: 'NOT_SCHEDULED' };
    if (!r.evaluated_at) return { checkpoint: cp, status: 'PENDING', dueAt: r.due_at };
    return { checkpoint: cp, status: 'EVALUATED', dueAt: r.due_at, evaluatedAt: r.evaluated_at, outcome: experimentOutcomeLabel(r.result_class), notes: JSON.parse(r.notes_json || '{}') };
  });
  const lastEvaluated = [...checkpoints].reverse().find((c) => c.status === 'EVALUATED');
  return {
    hasExperiment: true,
    actionId: action.id,
    hypothesis: rec.reason,
    executedAt: action.executed_at || action.created_at,
    checkpoints,
    overallOutcome: lastEvaluated ? lastEvaluated.outcome : 'INCONCLUSIVE',
  };
}
