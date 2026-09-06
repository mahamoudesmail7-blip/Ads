// AI Media Buyer — Outcome Evaluation Engine (layer 10). A background job
// fills each executed action's 6h / 12h / 24h checkpoint when it comes due,
// by comparing the entity's real performance in the window AFTER the action
// against the window of equal length BEFORE it — all from the append-only
// meta_performance_snapshots series. DETERMINISTIC; no Claude call. The
// classified result feeds back into claudeAnalyst.buildOutcomeContext() so
// future recommendations get more conservative where a similar move failed.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { codCountsForProduct } from './codOrders.js';
import { netProfitBundle } from './productEconomics.js';

const CHECKPOINT_HOURS = { H6: 6, H12: 12, H24: 24 };

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

/** Incremental metrics for an entity between two timestamps, from cumulative snapshots. */
async function sliceMetrics({ level, entityId, adAccountId, fromTs, toTs }) {
  const idField = level === 'campaign' ? 'campaign_id' : level === 'adset' ? 'adset_id' : 'ad_id';
  const rows = await prisma.metaPerformanceSnapshot.findMany({
    where: { level, [idField]: entityId, ad_account_id: adAccountId, snapshot_at: { gte: new Date(fromTs - 3 * 3600 * 1000), lte: new Date(toTs + 60 * 1000) } },
    orderBy: { snapshot_at: 'asc' },
  });
  if (rows.length < 2) return null;
  const at = (ts) => {
    let chosen = null;
    for (const r of rows) { if (new Date(r.snapshot_at).getTime() <= ts) chosen = r; }
    return chosen || rows[0];
  };
  const a = at(fromTs);
  const b = at(toTs);
  if (!a || !b || a === b) return null;
  const dSpend = (n(b.spend) ?? 0) - (n(a.spend) ?? 0);
  const dPurch = (n(b.meta_purchases) ?? 0) - (n(a.meta_purchases) ?? 0);
  const dRev = (n(b.meta_revenue) ?? 0) - (n(a.meta_revenue) ?? 0);
  return {
    spend: dSpend,
    purchases: dPurch,
    revenue: dRev,
    cpa: dPurch > 0 ? dSpend / dPurch : null,
    roas: dSpend > 0 && dRev ? dRev / dSpend : null,
  };
}

function classify(actionType, before, after) {
  if (!before || !after) return { cls: null, note: 'مفيش عينة snapshots كفاية للتقييم.' };
  const notes = [];

  if (actionType === 'PAUSE') {
    const stopped = (after.spend || 0) <= Math.max(1, (before.spend || 0) * 0.1);
    notes.push(stopped ? 'العنصر توقف فعليًا عن الصرف بعد الإيقاف.' : 'العنصر لسه بيصرف بعد أمر الإيقاف — راجع يدويًا.');
    return { cls: stopped ? 'SUCCESSFUL' : 'FAILED', note: notes.join(' ') };
  }
  if (actionType === 'RESUME') {
    const resumed = (after.spend || 0) > 0;
    return { cls: resumed ? 'SUCCESSFUL' : 'NEUTRAL', note: resumed ? 'العنصر رجع يصرف بعد التشغيل.' : 'لسه مفيش صرف بعد التشغيل.' };
  }

  // Budget moves: judge on CPA + volume direction.
  const cpaB = n(before.cpa), cpaA = n(after.cpa);
  if (cpaB == null || cpaA == null) {
    const volUp = (after.purchases || 0) > (before.purchases || 0);
    return { cls: volUp ? 'NEUTRAL' : 'FAILED', note: 'CPA غير قابل للحساب في إحدى الفترتين — تقييم مبدئي على حجم الشراء فقط.' };
  }
  const rel = (cpaA - cpaB) / cpaB;
  if (actionType === 'INCREASE_BUDGET') {
    if (rel <= 0.1 && (after.purchases || 0) >= (before.purchases || 0)) return { cls: 'SUCCESSFUL', note: `CPA ثابت/أفضل (${cpaB.toFixed(1)}→${cpaA.toFixed(1)}) مع زيادة/ثبات في المشتريات بعد التوسع.` };
    if (rel >= 0.25) return { cls: 'FAILED', note: `CPA ارتفع ${Math.round(rel * 100)}% بعد التوسع (${cpaB.toFixed(1)}→${cpaA.toFixed(1)}).` };
    return { cls: 'NEUTRAL', note: `تغير طفيف في CPA بعد التوسع (${Math.round(rel * 100)}%).` };
  }
  if (actionType === 'DECREASE_BUDGET') {
    if (rel <= 0.05) return { cls: 'SUCCESSFUL', note: `CPA اتحسن/ثبت بعد تقليل الميزانية (${cpaB.toFixed(1)}→${cpaA.toFixed(1)}).` };
    if (rel >= 0.2 && (after.purchases || 0) < (before.purchases || 0)) return { cls: 'FAILED', note: `CPA ارتفع والمشتريات نزلت بعد التقليل.` };
    return { cls: 'NEUTRAL', note: 'أثر محدود بعد تقليل الميزانية.' };
  }
  return { cls: 'NEUTRAL', note: 'نوع أكشن غير مصنّف للتقييم.' };
}

/** Evaluate every due, not-yet-evaluated checkpoint. Safe to call repeatedly. */
export async function runOutcomeEvaluation() {
  const due = await prisma.ambActionResult.findMany({
    where: { evaluated_at: null, due_at: { lte: new Date() } },
    include: { action: { include: { recommendation: true } } },
    take: 100,
  });
  let evaluated = 0;
  for (const r of due) {
    try {
      const a = r.action;
      if (!a.executed_at || a.execution_status !== 'EXECUTED') {
        await prisma.ambActionResult.update({ where: { id: r.id }, data: { evaluated_at: new Date(), result_class: 'NEUTRAL', notes_json: JSON.stringify({ note: 'الأكشن مااتنفّذش فعليًا — لا يوجد نتيجة للتقييم.' }) } });
        evaluated++;
        continue;
      }
      const execTs = new Date(a.executed_at).getTime();
      const hours = CHECKPOINT_HOURS[r.checkpoint] || 24;
      const before = await sliceMetrics({ level: a.level, entityId: a.entity_id, adAccountId: a.ad_account_id, fromTs: execTs - hours * 3600 * 1000, toTs: execTs });
      const after = await sliceMetrics({ level: a.level, entityId: a.entity_id, adAccountId: a.ad_account_id, fromTs: execTs, toTs: execTs + hours * 3600 * 1000 });
      const { cls, note } = classify(a.action_type, before, after);

      // Best-effort delivered CPA + profit deltas when the product is mapped and has COD data.
      let deliveredCpaBefore = null, deliveredCpaAfter = null, profitBefore = null, profitAfter = null;
      const rec = a.recommendation;
      if (rec?.amb_product_id) {
        const prod = await prisma.ambProduct.findUnique({ where: { id: rec.amb_product_id } });
        if (prod?.product_id) {
          const toISO = (ms) => new Date(ms).toISOString().slice(0, 10);
          const cBefore = await codCountsForProduct({ productId: prod.product_id, from: toISO(execTs - hours * 3600 * 1000), to: toISO(execTs) });
          const cAfter = await codCountsForProduct({ productId: prod.product_id, from: toISO(execTs), to: toISO(execTs + hours * 3600 * 1000) });
          if (before && cBefore.delivered) deliveredCpaBefore = before.spend / cBefore.delivered;
          if (after && cAfter.delivered) deliveredCpaAfter = after.spend / cAfter.delivered;
          if (before) profitBefore = netProfitBundle(prod, { adSpend: before.spend, deliveredOrders: cBefore.delivered, returnedOrders: cBefore.returned }).netProfit;
          if (after) profitAfter = netProfitBundle(prod, { adSpend: after.spend, deliveredOrders: cAfter.delivered, returnedOrders: cAfter.returned }).netProfit;
        }
      }

      await prisma.ambActionResult.update({
        where: { id: r.id },
        data: {
          evaluated_at: new Date(),
          cpa_before: before?.cpa ?? null, cpa_after: after?.cpa ?? null,
          roas_before: before?.roas ?? null, roas_after: after?.roas ?? null,
          spend_before: before?.spend ?? null, spend_after: after?.spend ?? null,
          purchases_before: before?.purchases ?? null, purchases_after: after?.purchases ?? null,
          delivered_cpa_before: deliveredCpaBefore, delivered_cpa_after: deliveredCpaAfter,
          profit_before: profitBefore, profit_after: profitAfter,
          result_class: cls,
          notes_json: JSON.stringify({ note, before, after }),
        },
      });
      evaluated++;
    } catch (err) {
      logger.error('AMB outcome eval failed for a checkpoint', { resultId: r.id, message: err.message });
    }
  }
  if (evaluated > 0) logger.info('AMB outcome evaluation ran', { evaluated });
  return { evaluated, due: due.length };
}

let timer = null;
export function startAmbOutcomeScheduler() {
  if (timer) return;
  const EVERY_MS = 10 * 60 * 1000;
  timer = setInterval(() => {
    runOutcomeEvaluation().catch((err) => logger.error('AMB outcome scheduler tick failed', { message: err.message }));
  }, EVERY_MS);
  logger.info('AMB outcome evaluation scheduler started (10m)');
}
