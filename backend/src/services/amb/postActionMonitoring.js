// 📈 Post-Action Monitoring — after every REAL executed action: Before / After, CPA, purchases, spend, budget, execution time, actor, rule, confidence, verification,
// and the 6 / 12 / 24 / 48-hour outcome checkpoints (evaluated by the existing outcome engine from the append-only Meta snapshots). A verdict says whether performance
// IMPROVED / WORSENED / has INSUFFICIENT evidence — it never claims a cause. When it WORSENED we SUGGEST a rollback; this module never executes anything.
import { prisma } from '../../prisma.js';

export const CHECKPOINTS = [{ key: 'H6', hours: 6 }, { key: 'H12', hours: 12 }, { key: 'H24', hours: 24 }, { key: 'H48', hours: 48 }];
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const MIN_SAMPLE = 3; // purchases before + after below this = not enough evidence to judge

/** Verdict of ONE evaluated checkpoint. Pure. */
export function checkpointVerdict(cp) {
  if (!cp || cp.state !== 'EVALUATED') return { verdict: 'PENDING', label: 'لسه ما حانش موعد التقييم' };
  const sample = (cp.purchasesBefore ?? 0) + (cp.purchasesAfter ?? 0);
  if (cp.class == null) return { verdict: 'INSUFFICIENT', label: 'الأدلة غير كافية (مفيش بيانات كفاية)' };
  if (sample < MIN_SAMPLE && cp.actionType !== 'PAUSE' && cp.actionType !== 'RESUME') return { verdict: 'INSUFFICIENT', label: `الأدلة غير كافية (${sample} أوردر فقط قبل وبعد)` };
  if (cp.class === 'SUCCESSFUL') return { verdict: 'IMPROVED', label: 'تحسّن / اتحقق المطلوب' };
  if (cp.class === 'FAILED') return { verdict: 'WORSE', label: 'تدهور / ما اتحققش المطلوب' };
  return { verdict: 'NO_CHANGE', label: 'تغيّر طفيف' };
}

/** Overall verdict = the LATEST evaluated checkpoint that has enough evidence; WORSE at any evaluated checkpoint is surfaced. */
export function overallVerdict(checkpoints) {
  const ev = checkpoints.filter((c) => c.state === 'EVALUATED');
  if (!ev.length) return { verdict: 'PENDING', label: 'بانتظار أول تقييم (6 ساعات)' };
  const judged = ev.map((c) => ({ c, v: checkpointVerdict(c) }));
  const last = [...judged].reverse().find((x) => x.v.verdict !== 'INSUFFICIENT') || judged[judged.length - 1];
  const worse = judged.find((x) => x.v.verdict === 'WORSE');
  return { verdict: worse && last.v.verdict !== 'IMPROVED' ? 'WORSE' : last.v.verdict, label: (worse && last.v.verdict !== 'IMPROVED' ? worse : last).v.label, basedOn: (worse && last.v.verdict !== 'IMPROVED' ? worse : last).c.key };
}

/** A rollback is only SUGGESTED (never executed): the reverse of the action, from its recorded before-state. */
export function rollbackSuggestion({ actionType, before, verdict, level, entityId, entityName }) {
  if (verdict !== 'WORSE') return null;
  if (actionType === 'INCREASE_BUDGET' || actionType === 'DECREASE_BUDGET') {
    if (before?.budget == null) return null;
    return { type: actionType === 'INCREASE_BUDGET' ? 'RESTORE_LOWER_BUDGET' : 'RESTORE_HIGHER_BUDGET', text: `اقتراح: إرجاع ميزانية «${entityName || entityId}» إلى ${before.budget} (القيمة قبل التنفيذ)`, restoreTo: before.budget, level, entityId, executes: false };
  }
  if (actionType === 'RESUME') return { type: 'PAUSE_AGAIN', text: `اقتراح: إيقاف «${entityName || entityId}» مرة تانية`, level, entityId, executes: false };
  if (actionType === 'PAUSE') return { type: 'RESUME_AGAIN', text: `اقتراح: إعادة تشغيل «${entityName || entityId}»`, level, entityId, executes: false };
  return null;
}

/** make sure every action executed in the last 72h also has its 48h checkpoint (older code only scheduled 6/12/24h). */
export async function ensureH48(actions) {
  for (const a of actions) {
    if (!a.executed_at || Date.now() - new Date(a.executed_at).getTime() > 72 * 3_600_000) continue;
    if (a.results.some((r) => r.checkpoint === 'H48')) continue;
    const row = await prisma.ambActionResult.create({ data: { action_id: a.id, checkpoint: 'H48', due_at: new Date(new Date(a.executed_at).getTime() + 48 * 3_600_000) } }).catch(() => null);
    if (row) a.results.push(row);
  }
}

export async function listMonitoredActions({ limit = 20, days = 14, includeFixtures = false, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const actions = await prisma.ambAction.findMany({
    where: { execution_status: 'EXECUTED', executed_at: { gte: since }, action_type: { in: ['RESUME', 'PAUSE', 'INCREASE_BUDGET', 'DECREASE_BUDGET'] }, ...(includeFixtures ? {} : { NOT: { OR: [{ entity_id: { startsWith: '__optest_' } }, { ad_account_id: { startsWith: '__optest_' } }] } }) },
    orderBy: { executed_at: 'desc' }, take: Math.min(Number(limit) || 20, 100), include: { results: true, recommendation: true, executed_by: { select: { name: true } } },
  });
  await ensureH48(actions);
  const decisions = actions.length ? await prisma.ambOperatorDecision.findMany({ where: { amb_action_id: { in: actions.map((a) => a.id) } }, select: { amb_action_id: true, rule_name: true, confidence: true, status: true } }) : [];
  const decOf = new Map(decisions.map((d) => [d.amb_action_id, d]));
  return actions.map((a) => {
    const oldV = j(a.old_value_json, {}) || {}, newV = j(a.new_value_json, {}) || {}, verify = j(a.verify_json, null);
    const cps = CHECKPOINTS.map((c) => {
      const r = a.results.find((x) => x.checkpoint === c.key); const due = new Date(new Date(a.executed_at).getTime() + c.hours * 3_600_000);
      if (!r || !r.evaluated_at) return { key: c.key, hours: c.hours, state: 'PENDING', dueAt: r?.due_at || due, actionType: a.action_type };
      return { key: c.key, hours: c.hours, state: 'EVALUATED', dueAt: r.due_at, evaluatedAt: r.evaluated_at, class: r.result_class, cpaBefore: r.cpa_before, cpaAfter: r.cpa_after, purchasesBefore: r.purchases_before, purchasesAfter: r.purchases_after, spendBefore: r.spend_before, spendAfter: r.spend_after, note: j(r.notes_json, {})?.note || null, actionType: a.action_type };
    }).map((c) => ({ ...c, ...checkpointVerdict(c) }));
    const overall = overallVerdict(cps); const dec = decOf.get(a.id);
    const isBudget = ['INCREASE_BUDGET', 'DECREASE_BUDGET'].includes(a.action_type);
    return {
      actionId: a.id, actionType: a.action_type, campaignId: a.campaign_id, entityId: a.entity_id, entityName: a.entity_name, level: a.level, executedAt: a.executed_at, actor: a.executed_by?.name || (a.executed_by_id ? `#${a.executed_by_id}` : 'SYSTEM'), mode: a.mode,
      rule: dec?.rule_name || a.recommendation?.decision || null, confidence: dec?.confidence || a.recommendation?.confidence || null,
      before: isBudget ? { budget: oldV.budget ?? null } : { status: oldV.status ?? null }, after: isBudget ? { budget: newV.budget ?? null } : { status: newV.status ?? null },
      verification: verify ? { verified: !!verify.verified, at: a.verified_at } : { verified: null }, checkpoints: cps, verdict: overall.verdict, verdictLabel: overall.label, verdictBasedOn: overall.basedOn || null,
      rollback: rollbackSuggestion({ actionType: a.action_type, before: isBudget ? { budget: oldV.budget } : null, verdict: overall.verdict, level: a.level, entityId: a.entity_id, entityName: a.entity_name }),
    };
  });
}
