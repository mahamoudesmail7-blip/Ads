// AI Media Buyer — Approval Layer + Meta Execution Layer + Audit (layers
// 7-9). This is the ONLY file that calls a Meta WRITE endpoint, and it does
// so only after: owner approval (Approval Mode) or a passing Autopilot gate,
// THEN a fresh load of the live entity, THEN a full rule-engine revalidation,
// THEN a materiality check on the metrics. If the situation moved enough
// that the original recommendation is no longer safe, execution is aborted
// with "Recommendation requires re-analysis" — nothing is sent to Meta.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection, getDecryptedToken } from '../metaAuth.js';
import { getAdAccountInfo, getEntity, setEntityStatus, setEntityBudget } from '../metaGraphClient.js';
import { getAmbSettings } from './settings.js';
import { resolveWindow, entityWindowMetrics } from './metricsEngine.js';
import { validateAction } from './ruleEngine.js';
import { currencyFactor } from './snapshotSync.js';
import { raiseAlert } from './alerts.js';
import { serializeRec } from './recommendationEngine.js';

const MATERIAL_CPA_DRIFT = 0.30; // ±30% relative CPA move since the recommendation ⇒ re-analyse
const MATERIAL_SPEND_MULT = 2.0; // spend more than doubled since the recommendation ⇒ re-analyse

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

/** Owner "Edit Action" — currently only the recommended budget, kept inside the per-action bound. */
export async function applyEdit({ recId, patch, userId }) {
  const rec = await prisma.ambRecommendation.findUnique({ where: { id: Number(recId) } });
  if (!rec) { const e = new Error('التوصية مش موجودة.'); e.status = 404; throw e; }
  if (rec.status !== 'PENDING') { const e = new Error('التوصية دي مش قابلة للتعديل في حالتها الحالية.'); e.status = 409; throw e; }
  const settings = await getAmbSettings();
  const maxPct = n(settings.ambMaxBudgetIncreasePct) ?? 20;

  const edited = {};
  if (patch.recommendedBudget != null && rec.current_budget) {
    const next = Number(patch.recommendedBudget);
    const changePct = Math.abs((next - rec.current_budget) / rec.current_budget) * 100;
    if (!Number.isFinite(next) || next <= 0) { const e = new Error('قيمة ميزانية غير صحيحة.'); e.status = 400; throw e; }
    if (changePct > maxPct + 0.5) { const e = new Error(`التعديل (${Math.round(changePct)}%) أكبر من الحد المسموح لكل أكشن (${maxPct}%).`); e.status = 400; throw e; }
    edited.recommendedBudget = Math.round(next);
    edited.budgetChangePct = Math.round(((next - rec.current_budget) / rec.current_budget) * 100);
  }
  const updated = await prisma.ambRecommendation.update({
    where: { id: rec.id },
    data: {
      recommended_budget: edited.recommendedBudget ?? rec.recommended_budget,
      budget_change_pct: edited.budgetChangePct ?? rec.budget_change_pct,
      edited_json: JSON.stringify({ ...edited, by: userId, at: new Date().toISOString() }),
    },
  });
  return serializeRec(updated);
}

export async function rejectRecommendation({ recId, userId }) {
  const rec = await prisma.ambRecommendation.findUnique({ where: { id: Number(recId) } });
  if (!rec) { const e = new Error('التوصية مش موجودة.'); e.status = 404; throw e; }
  const updated = await prisma.ambRecommendation.update({
    where: { id: rec.id },
    data: { status: 'REJECTED', reviewed_by_id: userId || null, reviewed_at: new Date() },
  });
  return serializeRec(updated);
}

/** Latest live status + which budget field the entity uses + its current budget in EGP. */
async function loadLiveEntity(token, entityId, currency) {
  const e = await getEntity(token, entityId, 'status,effective_status,daily_budget,lifetime_budget,name');
  const factor = currencyFactor(currency);
  const daily = n(e.daily_budget);
  const lifetime = n(e.lifetime_budget);
  return {
    status: e.effective_status || e.status || null,
    name: e.name || null,
    budgetType: daily != null ? 'DAILY' : lifetime != null ? 'LIFETIME' : null,
    budgetMajor: daily != null ? daily / factor : lifetime != null ? lifetime / factor : null,
    raw: e,
  };
}

/**
 * PREVIEW / dry-run of the full execution path for one recommendation —
 * loads the live Meta entity, runs the materiality check + full rule-engine
 * revalidation, and builds the EXACT Meta request that WOULD be sent — but
 * never calls a Meta write endpoint and never writes an AmbAction. Lets the
 * owner (and QA) verify the write path end-to-end with zero risk.
 */
export async function previewExecution({ recId }) {
  const rec = await prisma.ambRecommendation.findUnique({ where: { id: Number(recId) } });
  if (!rec) { const e = new Error('التوصية مش موجودة.'); e.status = 404; throw e; }
  const settings = await getAmbSettings();
  const connection = await getConnection();
  const out = { recId: rec.id, actionType: rec.action_type, executable: rec.executable, canReachMeta: false, live: null, materiality: null, revalidation: null, plannedRequest: null, verdict: 'BLOCKED' };

  if (!rec.executable || !['PAUSE', 'RESUME', 'INCREASE_BUDGET', 'DECREASE_BUDGET'].includes(rec.action_type)) {
    out.verdict = 'DRAFT_ONLY';
    out.note = 'أكشن مسودة — مش قابل للتنفيذ الآلي، لازم موافقة يدوية وتنفيذ خارج النظام.';
    return out;
  }
  if (!connection || connection.status !== 'CONNECTED' || !connection.selected_ad_account_id) {
    out.note = 'مفيش اتصال Meta Ads صالح.';
    return out;
  }

  try {
    const token = await getDecryptedToken();
    let currency = 'EGP';
    try { currency = (await getAdAccountInfo(token, rec.ad_account_id))?.currency || 'EGP'; } catch { /* keep EGP */ }
    const live = await loadLiveEntity(token, rec.entity_id, currency);
    out.canReachMeta = true;
    out.live = { status: live.status, name: live.name, budgetType: live.budgetType, budgetMajor: live.budgetMajor };

    const win = resolveWindow(rec.time_window_label === 'اليوم' ? 'today' : rec.time_window_label === 'أمس' ? 'yesterday' : rec.time_window_label === 'آخر 3 أيام' ? 'last3' : 'last7');
    const liveMetricsMap = await entityWindowMetrics({ level: rec.level, from: win.from, to: win.to, adAccountId: rec.ad_account_id },
      { minSpend: n(settings.ambMinSpendBeforeDecision) ?? 150, minPurchases: n(settings.ambMinPurchasesBeforeScaling) ?? 5 });
    const liveM = liveMetricsMap.get(rec.entity_id) || null;
    const before = JSON.parse(rec.current_metrics_json || '{}');
    let material = false; const drift = {};
    if (liveM) {
      if (n(before.cpa) && n(liveM.cpa)) { const rel = Math.abs(liveM.cpa - before.cpa) / before.cpa; drift.cpaRelChange = rel; if (rel > MATERIAL_CPA_DRIFT) material = true; }
      if (n(before.spend) && n(liveM.spend)) { drift.spendMult = before.spend > 0 ? liveM.spend / before.spend : null; if (drift.spendMult && drift.spendMult > MATERIAL_SPEND_MULT) material = true; }
      if (['PAUSE', 'RESUME'].includes(rec.action_type)) material = false;
    }
    out.materiality = { material, drift, requiresReanalysis: material };

    const revalidation = await validateAction({
      actionType: rec.action_type, level: rec.level, entityId: rec.entity_id, campaignId: rec.campaign_id,
      metrics: liveM || before, econ: null, settings, connection, liveEntity: { status: live.status },
      currentBudget: live.budgetMajor ?? rec.current_budget, recommendedBudget: rec.recommended_budget,
    });
    out.revalidation = { passed: revalidation.passed, checks: revalidation.checks, blockers: revalidation.blockers };

    if (rec.action_type === 'PAUSE' || rec.action_type === 'RESUME') {
      out.plannedRequest = { endpoint: `POST /${rec.entity_id}`, body: { status: rec.action_type === 'PAUSE' ? 'PAUSED' : 'ACTIVE' } };
    } else {
      const factor = currencyFactor(currency);
      const bt = live.budgetType || 'DAILY';
      out.plannedRequest = { endpoint: `POST /${rec.entity_id}`, body: bt === 'LIFETIME' ? { lifetime_budget: Math.round(rec.recommended_budget * factor) } : { daily_budget: Math.round(rec.recommended_budget * factor) }, humanReadable: `${out.live.budgetMajor ?? rec.current_budget} → ${rec.recommended_budget} ${currency}` };
    }

    out.verdict = material ? 'WOULD_ABORT_REANALYSIS' : revalidation.passed ? 'READY' : 'WOULD_BLOCK_RULES';
    return out;
  } catch (err) {
    out.note = `فشل الوصول لـ Meta أثناء المعاينة: ${err.message}`;
    return out;
  }
}

/**
 * Approve + execute one recommendation.
 * @param {{recId:number, userId:number, mode?:'APPROVAL'|'AUTOPILOT'}} p
 */
export async function approveAndExecute({ recId, userId, mode = 'APPROVAL' }) {
  const rec = await prisma.ambRecommendation.findUnique({ where: { id: Number(recId) } });
  if (!rec) { const e = new Error('التوصية مش موجودة.'); e.status = 404; throw e; }
  if (!['PENDING', 'APPROVED'].includes(rec.status)) { const e = new Error(`التوصية في حالة ${rec.status} — مش قابلة للتنفيذ.`); e.status = 409; throw e; }
  if (!rec.executable || !['PAUSE', 'RESUME', 'INCREASE_BUDGET', 'DECREASE_BUDGET'].includes(rec.action_type)) {
    const e = new Error('التوصية دي أكشن مسودة — لازم تتحول لخطة وتتنفّذ يدويًا، مش من هنا.'); e.status = 400; throw e;
  }

  const settings = await getAmbSettings();
  if (settings.ambExecutionMode === 'ADVISORY') {
    const e = new Error('النظام في وضع "استشاري فقط" — مفيش تنفيذ على Meta. غيّر الوضع من الإعدادات.'); e.status = 403; throw e;
  }

  const connection = await getConnection();
  if (!connection || connection.status !== 'CONNECTED' || !connection.selected_ad_account_id) {
    const e = new Error('مفيش اتصال Meta Ads صالح.'); e.status = 400; throw e;
  }

  // Mark approved up-front (audit) then run the guarded execution.
  await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'APPROVED', reviewed_by_id: userId || null, reviewed_at: new Date() } });

  const action = await prisma.ambAction.create({
    data: {
      recommendation_id: rec.id,
      mode,
      action_type: rec.action_type,
      ad_account_id: rec.ad_account_id,
      level: rec.level,
      entity_id: rec.entity_id,
      entity_name: rec.entity_name,
      campaign_id: rec.campaign_id,
      adset_id: rec.adset_id,
      ad_id: rec.ad_id,
      ai_reason: rec.reason,
      ai_confidence: rec.confidence,
      metrics_before_json: rec.current_metrics_json,
      approval_status: mode === 'AUTOPILOT' ? 'AUTO' : 'APPROVED',
      execution_status: 'REVALIDATING',
      executed_by_id: userId || null,
    },
  });

  try {
    const token = await getDecryptedToken();
    let currency = 'EGP';
    try { currency = (await getAdAccountInfo(token, rec.ad_account_id))?.currency || 'EGP'; } catch { /* keep EGP */ }

    // 1. Live entity state.
    const live = await loadLiveEntity(token, rec.entity_id, currency);

    // 2. Materiality check — did the situation move too much since the rec?
    const win = resolveWindow(rec.time_window_label === 'اليوم' ? 'today' : rec.time_window_label === 'أمس' ? 'yesterday' : rec.time_window_label === 'آخر 3 أيام' ? 'last3' : 'last7');
    const liveMetricsMap = await entityWindowMetrics({ level: rec.level, from: win.from, to: win.to, adAccountId: rec.ad_account_id },
      { minSpend: n(settings.ambMinSpendBeforeDecision) ?? 150, minPurchases: n(settings.ambMinPurchasesBeforeScaling) ?? 5 });
    const liveM = liveMetricsMap.get(rec.entity_id) || null;
    const before = JSON.parse(rec.current_metrics_json || '{}');
    const drift = { };
    let material = false;
    if (liveM) {
      if (n(before.cpa) && n(liveM.cpa)) {
        const rel = Math.abs(liveM.cpa - before.cpa) / before.cpa;
        drift.cpaRelChange = rel;
        if (rel > MATERIAL_CPA_DRIFT) material = true;
      }
      if (n(before.spend) && n(liveM.spend)) {
        drift.spendMult = before.spend > 0 ? liveM.spend / before.spend : null;
        if (drift.spendMult && drift.spendMult > MATERIAL_SPEND_MULT) material = true;
      }
      // A pause is still safe even if things moved; only budget/scale actions abort on drift.
      if (rec.action_type === 'PAUSE' || rec.action_type === 'RESUME') material = false;
    }

    // 3. Full rule-engine revalidation with the live entity.
    const revalidation = await validateAction({
      actionType: rec.action_type,
      level: rec.level,
      entityId: rec.entity_id,
      campaignId: rec.campaign_id,
      metrics: liveM || before,
      econ: null,
      settings,
      connection,
      liveEntity: { status: live.status },
      currentBudget: live.budgetMajor ?? rec.current_budget,
      recommendedBudget: rec.recommended_budget,
    });

    if (material || !revalidation.passed) {
      await prisma.ambAction.update({
        where: { id: action.id },
        data: {
          execution_status: 'ABORTED_REANALYSIS',
          revalidation_json: JSON.stringify({ material, drift, checks: revalidation.checks, blockers: revalidation.blockers }),
        },
      });
      await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'NEEDS_REANALYSIS' } });
      await raiseAlert({
        severity: 'WARNING', category: 'EXECUTION',
        title: `تنفيذ متوقف: ${rec.entity_name}`,
        message: material ? 'الأرقام اتغيرت بشكل مؤثر منذ التوصية — محتاجة إعادة تحليل.' : `فحص القواعد رفض التنفيذ: ${revalidation.blockers[0] || 'سبب غير محدد'}`,
        adAccountId: rec.ad_account_id, entityId: rec.entity_id,
        dedupeKey: `abort:${rec.id}`,
      }).catch(() => {});
      return {
        ok: false, aborted: true,
        message: material ? 'التوصية محتاجة إعادة تحليل — الوضع اتغير.' : `فحص القواعد رفض التنفيذ: ${revalidation.blockers[0] || ''}`,
        drift, revalidation,
      };
    }

    // 4. Build + send the real Meta write.
    let oldValue, newValue, metaResponse;
    if (rec.action_type === 'PAUSE' || rec.action_type === 'RESUME') {
      const target = rec.action_type === 'PAUSE' ? 'PAUSED' : 'ACTIVE';
      oldValue = { status: live.status };
      newValue = { status: target };
      await prisma.ambAction.update({ where: { id: action.id }, data: { execution_status: 'REVALIDATING', old_value_json: JSON.stringify(oldValue), new_value_json: JSON.stringify(newValue), meta_request_json: JSON.stringify({ id: rec.entity_id, status: target }) } });
      metaResponse = await setEntityStatus(token, rec.entity_id, target);
    } else {
      const factor = currencyFactor(currency);
      const budgetType = live.budgetType || 'DAILY';
      const newMajor = rec.recommended_budget;
      oldValue = { budget: live.budgetMajor ?? rec.current_budget, budgetType };
      newValue = { budget: newMajor, budgetType };
      const minorArgs = budgetType === 'LIFETIME' ? { lifetimeBudgetMinor: Math.round(newMajor * factor) } : { dailyBudgetMinor: Math.round(newMajor * factor) };
      await prisma.ambAction.update({ where: { id: action.id }, data: { execution_status: 'REVALIDATING', old_value_json: JSON.stringify(oldValue), new_value_json: JSON.stringify(newValue), meta_request_json: JSON.stringify({ id: rec.entity_id, ...minorArgs }) } });
      metaResponse = await setEntityBudget(token, rec.entity_id, minorArgs);
    }

    await prisma.ambAction.update({
      where: { id: action.id },
      data: {
        execution_status: 'EXECUTED',
        executed_at: new Date(),
        revalidation_json: JSON.stringify({ material: false, drift, checks: revalidation.checks }),
        meta_response_json: JSON.stringify(metaResponse).slice(0, 4000),
      },
    });
    await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'EXECUTED' } });

    // 5. Schedule outcome-evaluation checkpoints.
    const now = Date.now();
    await prisma.ambActionResult.createMany({
      data: [
        { action_id: action.id, checkpoint: 'H6', due_at: new Date(now + 6 * 3600 * 1000) },
        { action_id: action.id, checkpoint: 'H12', due_at: new Date(now + 12 * 3600 * 1000) },
        { action_id: action.id, checkpoint: 'H24', due_at: new Date(now + 24 * 3600 * 1000) },
      ],
      skipDuplicates: true,
    });

    await raiseAlert({
      severity: 'INFO', category: 'EXECUTION',
      title: `تم التنفيذ: ${rec.entity_name}`,
      message: `${rec.action_type} — ${rec.action_type.includes('BUDGET') ? `${oldValue.budget} → ${newValue.budget} جنيه` : `${oldValue.status} → ${newValue.status}`}`,
      adAccountId: rec.ad_account_id, entityId: rec.entity_id, recommendationId: rec.id,
    }).catch(() => {});

    logger.info('AMB action executed', { actionId: action.id, recId: rec.id, type: rec.action_type });
    return { ok: true, actionId: action.id, oldValue, newValue, metaResponse };
  } catch (err) {
    await prisma.ambAction.update({
      where: { id: action.id },
      data: { execution_status: 'FAILED', meta_error: (err.message || String(err)).slice(0, 800) },
    }).catch(() => {});
    // Recommendation goes back to PENDING so the owner can retry after fixing the cause (e.g. re-auth).
    await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'PENDING' } }).catch(() => {});
    await raiseAlert({
      severity: 'CRITICAL', category: 'EXECUTION',
      title: `فشل تنفيذ: ${rec.entity_name}`,
      message: `${rec.action_type} فشل: ${(err.message || '').slice(0, 200)}`,
      adAccountId: rec.ad_account_id, entityId: rec.entity_id, recommendationId: rec.id,
      dedupeKey: `execfail:${rec.id}`,
    }).catch(() => {});
    logger.error('AMB action FAILED', { actionId: action.id, recId: rec.id, message: err.message });
    const e = new Error(`فشل التنفيذ على Meta: ${err.message}`); e.status = 502; throw e;
  }
}

/** Execution History (audit log) with the recommendation + results joined. */
export async function listExecutionHistory({ limit = 50 } = {}) {
  const actions = await prisma.ambAction.findMany({
    orderBy: { created_at: 'desc' },
    take: Math.min(limit, 200),
    include: { recommendation: true, results: true, executed_by: { select: { name: true } } },
  });
  const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
  return actions.map((a) => ({
    id: a.id,
    at: a.created_at,
    executedAt: a.executed_at,
    mode: a.mode,
    actionType: a.action_type,
    level: a.level,
    entityName: a.entity_name,
    campaignName: a.recommendation?.campaign_name || null,
    productName: a.recommendation?.product_name || null,
    oldValue: parse(a.old_value_json, null),
    newValue: parse(a.new_value_json, null),
    aiReason: a.ai_reason,
    aiConfidence: a.ai_confidence,
    metricsBefore: parse(a.metrics_before_json, null),
    approvalStatus: a.approval_status,
    executionStatus: a.execution_status,
    revalidation: parse(a.revalidation_json, null),
    metaResponse: parse(a.meta_response_json, null),
    metaError: a.meta_error,
    approvedBy: a.executed_by?.name || null,
    results: a.results
      .sort((x, y) => x.checkpoint.localeCompare(y.checkpoint))
      .map((r) => ({
        checkpoint: r.checkpoint, dueAt: r.due_at, evaluatedAt: r.evaluated_at, resultClass: r.result_class,
        cpaBefore: r.cpa_before, cpaAfter: r.cpa_after, roasBefore: r.roas_before, roasAfter: r.roas_after,
        spendBefore: r.spend_before, spendAfter: r.spend_after, purchasesBefore: r.purchases_before, purchasesAfter: r.purchases_after,
        profitBefore: r.profit_before, profitAfter: r.profit_after, notes: parse(r.notes_json, null),
      })),
  }));
}
