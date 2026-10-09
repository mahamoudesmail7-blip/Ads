// 📜 Unified execution history: every Meta write the system attempted (daily plans, budget bridge, approvals) as ONE row with its stages — Requested → Validated → Approved → Sent → Read-back → Verified /
// Failed / Blocked / Uncertain. Read-only over amb_actions; "Verified" only exists when the independent read-back confirmed it (verify_json.verified === true).
import { prisma } from '../../prisma.js';

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export const OP_LABEL = { RESUME: 'فتح الحملة', PAUSE: 'إيقاف الحملة', INCREASE_BUDGET: 'زيادة الميزانية', DECREASE_BUDGET: 'تقليل الميزانية' };
export const FINAL_LABEL = { REQUESTED: 'مطلوب', VALIDATED: 'اتحقق منه', VERIFIED: 'اتأكد من Meta', FAILED: 'فشل', BLOCKED: 'ممنوع قبل الإرسال', UNCERTAIN: 'غير مؤكد' };

/** pure: one amb_actions row → the history row (never invents a stage that did not happen) */
export function shapeActionRow(a) {
  const facts = j(a.recommendation?.reason_facts_json, null) || {};
  const reval = j(a.revalidation_json, null), verify = j(a.verify_json, null), req = j(a.meta_request_json, null), resp = j(a.meta_response_json, null);
  const oldV = j(a.old_value_json, {}), newV = j(a.new_value_json, {});
  const sent = !!req && a.execution_status !== 'ABORTED_REANALYSIS';
  let final = 'REQUESTED';
  if (a.execution_status === 'ABORTED_REANALYSIS') final = 'BLOCKED';
  else if (a.execution_status === 'FAILED') final = 'FAILED';
  else if (a.execution_status === 'EXECUTED') final = verify?.verified === true ? 'VERIFIED' : 'UNCERTAIN';
  else if (a.execution_status === 'REVALIDATING') final = 'VALIDATED';
  const stages = [
    { key: 'REQUESTED', done: true, at: a.created_at },
    { key: 'VALIDATED', done: !!reval, ok: reval ? reval.ok !== false : null, at: null, note: reval?.reason || null },
    { key: 'APPROVED', done: !!a.approval_status, at: null, note: a.approval_status === 'AUTO' ? 'تلقائي (Autopilot)' : 'موافقة ADMIN' },
    { key: 'SENT', done: sent, at: sent ? a.executed_at : null },
    { key: 'READ_BACK', done: !!verify, ok: verify ? verify.verified === true : null, at: a.verified_at || null },
    { key: final === 'REQUESTED' ? 'PENDING' : final, done: !['REQUESTED', 'VALIDATED'].includes(final), at: a.executed_at || null },
  ];
  const before = oldV.budget != null ? oldV.budget : oldV.status ?? null; const after = newV.budget != null ? newV.budget : newV.status ?? null;
  return {
    id: a.id, at: a.executed_at || a.created_at, requestedAt: a.created_at, campaignId: a.campaign_id || a.entity_id, campaignName: a.entity_name || null, level: a.level, type: a.action_type, typeLabel: OP_LABEL[a.action_type] || a.action_type,
    mode: a.mode, approval: a.approval_status, by: a.executed_by?.name || (a.approval_status === 'AUTO' ? 'النظام (Autopilot)' : null), before, after, budgetChange: oldV.budget != null || newV.budget != null,
    final, finalLabel: FINAL_LABEL[final], stages, error: a.meta_error || (final === 'BLOCKED' ? (reval?.reason || 'اتمنع قبل الإرسال') : null), reason: a.ai_reason || null,
    policyRef: facts.policyRef || (facts.cpaPolicy ? { openCpa: { version: facts.cpaPolicy.version } } : null), cpaPolicy: facts.cpaPolicy ? { verdict: facts.cpaPolicy.verdict, cpa: facts.cpaPolicy.cpa, window: facts.cpaPolicy.window } : null,
    metaResponse: resp ? JSON.stringify(resp).slice(0, 400) : null, verify: verify ? { verified: verify.verified === true, observed: verify.observed ?? verify.status ?? null } : null,
  };
}
export async function listExecutionHistory({ limit = 100, type = null, final = null } = {}) {
  const take = Math.max(1, Math.min(300, Number(limit) || 100));
  const rows = await prisma.ambAction.findMany({ where: type ? { action_type: type } : {}, orderBy: { id: 'desc' }, take, include: { executed_by: { select: { name: true } }, recommendation: { select: { reason_facts_json: true } } } });
  const shaped = rows.map(shapeActionRow).filter((r) => !final || r.final === final);
  const counts = { total: shaped.length }; for (const r of shaped) counts[r.final] = (counts[r.final] || 0) + 1;
  return { rows: shaped, counts };
}
