// 🤖 AI Operator — READ MODELS: overview KPIs, decision list/shaping, Shadow performance report, Shadow outcome reconciliation. 2026-10-03.
// Read-only except reconcileShadowOutcomes (writes only the shadow_json of Operator decisions). Nothing here touches Meta.
import { prisma } from '../../prisma.js';
import { ACTION_LABEL_AR } from './operatorRules.js';
import { getOperatorConfig, listRules, listExceptions } from './operatorStore.js';
import { entityWindowMetrics } from './metricsEngine.js';
import { lifecycleOf, LIFECYCLE_LABEL_AR, buildCanonical } from './operatorDecision.js';
import { unblockPlan } from './operatorUnblock.js';

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const MS_H = 3_600_000;
export const STATUS_LABEL_AR = { SHADOW: 'Shadow (مش هيتنفذ)', BLOCKED: 'ممنوع', PREPARED: 'جاهز للموافقة', APPROVED: 'اتوافق عليه', EXECUTING: 'بيتنفذ', EXECUTED: 'اتبعت لـ Meta (لسه مش متأكد)', VERIFIED: 'تم التنفيذ (متأكد من Meta)', FAILED: 'فشل', ROLLED_BACK: 'اترجع', REJECTED: 'مرفوض', SNOOZED: 'مؤجل', EXPIRED: 'انتهى' };

export function shapeDecision(d) {
  const ev = j(d.evidence_json, {}), why = j(d.why_json, {}), params = j(d.params_json, {});
  const blocks = j(d.blocked_codes_json, []);
  const snap = j(d.rule_snapshot_json, null);
  const lifecycle = lifecycleOf(d);
  const canonical = buildCanonical({
    decisionId: d.id, decisionKey: d.decision_key, storeId: d.store_id, productId: d.product_id, campaignId: d.campaign_id, campaignName: d.campaign_name, evaluatedAt: (d.updated_at || d.created_at)?.toISOString?.() || null,
    window: params.window || null, currentState: j(d.before_json, null), action: d.action, params, ruleId: d.rule_id, ruleVersion: d.rule_version, ruleName: d.rule_name,
    category: snap?.conditions && JSON.stringify(snap.conditions).includes('hard_stop_cpa') && ['PAUSE', 'SCALE_DOWN'].includes(d.action) ? 'HARD_SAFETY' : 'OPTIMIZATION',
    advisorPlanVersion: d.advisor_plan_version, recommendationId: d.advisor_rec_id, evidence: ev, blocks, confidence: d.confidence, effectiveMode: d.mode_at_decision, status: d.status, lifecycle,
  });
  return {
    lifecycle, lifecycleLabel: LIFECYCLE_LABEL_AR[lifecycle] || lifecycle, canonical, unblock: canonical.unblock, ruleVersion: d.rule_version, ruleSnapshot: snap, rejectReason: d.reject_reason, errorCategory: d.error_category, expected: j(d.expected_state_json, null),
    id: d.id, key: d.decision_key, status: d.status, statusLabel: STATUS_LABEL_AR[d.status] || d.status, action: d.action, actionLabel: ACTION_LABEL_AR[d.action] || d.action,
    store: d.store_id, productId: d.product_id, productName: ev?.productName || null, campaignId: d.campaign_id, campaignName: d.campaign_name, ruleId: d.rule_id, ruleName: d.rule_name,
    mode: d.mode_at_decision, confidence: d.confidence, params, window: params.window || null,
    metrics: ev?.metrics || null, todayMetrics: ev?.todayMetrics || null, conditions: ev?.conditions || [], economics: ev?.economics || null, stock: ev?.stock || null, dataQuality: ev?.dataQuality || null, mapping: ev?.mapping || null, advisor: ev?.advisor || null,
    blocks, primaryBlock: blocks.find((b) => b.severity === 'BLOCK') || null, warnings: blocks.filter((b) => b.severity === 'WARN'), why,
    before: j(d.before_json, null), after: j(d.after_json, null), rollback: j(d.rollback_json, null), verify: j(d.verify_json, null), outcome: j(d.outcome_json, null), shadow: j(d.shadow_json, null),
    links: { advisorRecId: d.advisor_rec_id, advisorPlanVersion: d.advisor_plan_version, ambRecommendationId: d.amb_recommendation_id, ambActionId: d.amb_action_id },
    approvalSource: d.approval_source, approvedById: d.approved_by_id, approvedAt: d.approved_at, executedAt: d.executed_at, verifiedAt: d.verified_at, error: d.error, snoozedUntil: d.snoozed_until, createdAt: d.created_at, updatedAt: d.updated_at,
  };
}

export async function listDecisions({ bucket = 'today', status = null, action = null, store = null, limit = 100, now = new Date() } = {}) {
  const where = {};
  if (store) where.store_id = store;
  if (action) where.action = action;
  if (status) where.status = { in: String(status).split(',') };
  const dayAgo = new Date(now.getTime() - 24 * MS_H);
  if (bucket === 'today') where.OR = [{ status: { in: ['SHADOW', 'PREPARED', 'BLOCKED', 'SNOOZED', 'APPROVED', 'EXECUTING'] } }, { updated_at: { gte: dayAgo } }];
  else if (bucket === 'scale') { where.action = 'SCALE_UP'; where.status = { in: ['SHADOW', 'PREPARED', 'SNOOZED'] }; }
  else if (bucket === 'open') { where.action = 'OPEN'; where.status = { in: ['SHADOW', 'PREPARED', 'SNOOZED'] }; }
  else if (bucket === 'pause') { where.action = 'PAUSE'; where.status = { in: ['SHADOW', 'PREPARED', 'SNOOZED'] }; }
  else if (bucket === 'blocked') where.status = 'BLOCKED';
  else if (bucket === 'excluded') where.status = 'BLOCKED';
  else if (bucket === 'approval') where.status = { in: ['PREPARED', 'SNOOZED'] };
  else if (bucket === 'history') where.status = { in: ['EXECUTED', 'VERIFIED', 'FAILED', 'ROLLED_BACK', 'REJECTED'] };
  const rows = await prisma.ambOperatorDecision.findMany({ where, orderBy: [{ updated_at: 'desc' }], take: Math.min(Number(limit) || 100, 500) });
  let shaped = rows.map(shapeDecision);
  if (bucket === 'excluded') shaped = shaped.filter((d) => d.primaryBlock && (d.primaryBlock.group === 'EXCEPTION' || d.primaryBlock.code === 'TESTING_PROTECTED' || d.primaryBlock.code === 'PRODUCT_AUTOMATION_OFF'));
  return shaped;
}

export async function decisionEvents(decisionId) {
  const rows = await prisma.ambOperatorEvent.findMany({ where: { decision_id: Number(decisionId) }, orderBy: { created_at: 'asc' }, take: 200 });
  return rows.map((e) => ({ id: e.id, kind: e.kind, from: e.from_status, to: e.to_status, actor: e.actor, actorId: e.actor_id, note: e.note, data: j(e.data_json, null), at: e.created_at }));
}

/** Top-of-page KPIs (spec §5). Counts come from persisted decisions + the live exceptions list; `monitored` from the synced campaign list. */
export async function operatorOverview({ now = new Date(), monitored = null } = {}) {
  const [config, rules, exceptions] = await Promise.all([getOperatorConfig(), listRules(), listExceptions({ now })]);
  const open = await prisma.ambOperatorDecision.findMany({ where: { status: { in: ['SHADOW', 'PREPARED', 'BLOCKED', 'SNOOZED'] } }, select: { action: true, status: true, blocked_codes_json: true } });
  const dayAgo = new Date(now.getTime() - 24 * MS_H);
  const executedToday = await prisma.ambOperatorDecision.count({ where: { status: { in: ['EXECUTED', 'VERIFIED'] }, executed_at: { gte: dayAgo } } });
  const shadowToday = await prisma.ambOperatorDecision.count({ where: { created_at: { gte: dayAgo } } });
  const live = open.filter((d) => d.status !== 'BLOCKED');
  let protectedN = 0, blockedSafety = 0, blockedDq = 0;
  for (const d of open.filter((x) => x.status === 'BLOCKED')) {
    const p = j(d.blocked_codes_json, []).find((b) => b.severity === 'BLOCK');
    if (p?.group === 'EXCEPTION' || p?.code === 'TESTING_PROTECTED') protectedN++; else if (p?.group === 'DATA_QUALITY' || p?.code === 'DATA_UNKNOWN') blockedDq++; else blockedSafety++;
  }
  return {
    mode: config.mode, emergencyStop: config.emergency_stop, emergencyReason: config.emergency_reason, emergencyAt: config.emergency_at,
    kpis: {
      monitored: monitored ?? null,
      readyToOpen: live.filter((d) => d.action === 'OPEN').length,
      proposedPause: live.filter((d) => d.action === 'PAUSE').length,
      scaleOpportunities: live.filter((d) => d.action === 'SCALE_UP').length,
      excluded: exceptions.length + protectedN,
      blockedBySafety: blockedSafety + blockedDq, blockedByDataQuality: blockedDq, blockedOther: blockedSafety,
      actionsToday: executedToday, evaluationsToday: shadowToday,
    },
    rules: { total: rules.length, enabled: rules.filter((r) => r.enabled).length, autopilot: rules.filter((r) => r.enabled && r.mode === 'AUTOPILOT').length },
    exceptions: exceptions.length,
  };
}

// ---------------------------------------------------------------------------
// Shadow performance report (spec §35/§36). Honest labels: these are hindsight INDICATORS, never "AI accuracy".
// ---------------------------------------------------------------------------
export async function shadowReport({ days = 7, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await prisma.ambOperatorDecision.findMany({ where: { created_at: { gte: since }, mode_at_decision: { in: ['SHADOW', 'APPROVAL', 'AUTOPILOT'] } }, select: { action: true, status: true, shadow_json: true, blocked_codes_json: true, mode_at_decision: true, created_at: true } });
  const by = { SHADOW: { PAUSE: 0, OPEN: 0, SCALE_UP: 0, SCALE_DOWN: 0 }, blocked: 0 };
  const hind = { evaluated: 0, wasteAvoided: 0, wasteAvoidedAmount: 0, laterPurchases: 0, userDidSame: 0, stillPending: 0 };
  for (const r of rows) {
    if (r.status === 'BLOCKED') { by.blocked++; continue; }
    if (r.action in by.SHADOW) by.SHADOW[r.action]++;
    const s = j(r.shadow_json, null);
    if (!s) { hind.stillPending++; continue; }
    hind.evaluated++;
    if (s.userDidSame?.done) hind.userDidSame++;
    if (s.hindsight?.kind === 'WASTE_AVOIDED') { hind.wasteAvoided++; hind.wasteAvoidedAmount += s.hindsight.spendSince || 0; }
    if (s.hindsight?.kind === 'LATER_PURCHASES') hind.laterPurchases++;
  }
  const total = rows.length;
  return {
    days, since: since.toISOString(), totalEvaluated: total,
    suggested: { PAUSE: by.SHADOW.PAUSE, OPEN: by.SHADOW.OPEN, SCALE_UP: by.SHADOW.SCALE_UP, SCALE_DOWN: by.SHADOW.SCALE_DOWN, noAction: 0 }, blockedCorrectly: by.blocked,
    hindsight: { ...hind, wasteAvoidedAmount: Math.round(hind.wasteAvoidedAmount) },
    note: 'مؤشرات بأثر رجعي من أرقام Meta المتزامنة — مش "دقة الذكاء الاصطناعي" ومش إثبات سببي.',
  };
}

/**
 * For SHADOW decisions at least `minAgeHours` old: did a human later do the same thing (campaign status/budget changed in later snapshots),
 * and what happened to the campaign afterwards (spend/purchases since the decision)? Writes ONLY shadow_json.
 */
export async function reconcileShadowOutcomes({ now = new Date(), minAgeHours = 2, limit = 80, deps = {} } = {}) {
  const cutoff = new Date(now.getTime() - minAgeHours * MS_H);
  const rows = await prisma.ambOperatorDecision.findMany({ where: { status: 'SHADOW', created_at: { lte: cutoff, gte: new Date(now.getTime() - 30 * 86_400_000) }, shadow_json: null }, orderBy: { created_at: 'asc' }, take: limit });
  let done = 0;
  for (const d of rows) {
    const before = j(d.before_json, {}), ev = j(d.evidence_json, {});
    const later = await prisma.metaPerformanceSnapshot.findMany({ where: { level: 'campaign', campaign_id: d.campaign_id, snapshot_at: { gt: d.created_at } }, orderBy: { snapshot_at: 'asc' }, take: 200, select: { snapshot_at: true, campaign_status: true, campaign_budget: true } });
    let same = null;
    for (const s of later) {
      if ((d.action === 'PAUSE' && s.campaign_status === 'PAUSED') || (d.action === 'OPEN' && s.campaign_status === 'ACTIVE') || (d.action === 'SCALE_UP' && before.budget && s.campaign_budget && s.campaign_budget >= before.budget * 1.02) || (d.action === 'SCALE_DOWN' && before.budget && s.campaign_budget && s.campaign_budget <= before.budget * 0.98)) { same = s.snapshot_at; break; }
    }
    const from = d.created_at.toISOString().slice(0, 10), to = now.toISOString().slice(0, 10);
    const map = deps.metricsMap || await entityWindowMetrics({ level: 'campaign', from, to, adAccountId: d.ad_account_id });
    const m = map.get(d.campaign_id) || null;
    // Window runs from the decision DAY, so subtract the spend already on the books when the decision was made (today's metrics at that time).
    const baseSpend = ev?.todayMetrics?.spend ?? null;
    const spendSince = m?.spend != null && baseSpend != null ? Math.max(0, m.spend - baseSpend) : null;
    let hindsight = { kind: 'UNKNOWN', note: 'مفيش أرقام لاحقة كافية.' };
    if (m && d.action === 'PAUSE') {
      if ((m.purchases ?? 0) === 0 && (spendSince ?? 0) > 0) hindsight = { kind: 'WASTE_AVOIDED', spendSince: Math.round(spendSince), purchasesSince: 0, note: 'لو اتوقفت كان الصرف ده اتجنب (بأثر رجعي).' };
      else if ((m.purchases ?? 0) > 0) hindsight = { kind: 'LATER_PURCHASES', spendSince: Math.round(spendSince ?? 0), purchasesSince: m.purchases, cpaSince: m.cpa ? Math.round(m.cpa) : null, note: 'الحملة جابت مشتريات بعد القرار — الإيقاف كان ممكن يكون مبكرًا.' };
    }
    await prisma.ambOperatorDecision.update({ where: { id: d.id }, data: { shadow_json: JSON.stringify({ userDidSame: { done: !!same, at: same }, hindsight, evaluatedAt: now.toISOString() }) } });
    done++;
  }
  return { evaluated: done };
}
