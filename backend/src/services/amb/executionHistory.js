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
  const origin = a.approval_status === 'AUTO' ? 'AUTOMATIC' : a.recommendation?.source === 'MANUAL' ? 'MANUAL' : 'APPROVED'; const kind = facts.history?.kind || facts.trigger || null;
  return {
    origin, originLabel: { AUTOMATIC: 'تلقائي', MANUAL: 'يدوي', APPROVED: 'بموافقة' }[origin], kind, trigger: kind, decisionReason: a.ai_reason || null,
    id: a.id, at: a.executed_at || a.created_at, requestedAt: a.created_at, campaignId: a.campaign_id || a.entity_id, campaignName: a.entity_name || null, level: a.level, type: a.action_type, typeLabel: OP_LABEL[a.action_type] || a.action_type,
    mode: a.mode, approval: a.approval_status, by: a.executed_by?.name || (a.approval_status === 'AUTO' ? 'النظام (Autopilot)' : null), before, after, budgetChange: oldV.budget != null || newV.budget != null,
    final, finalLabel: FINAL_LABEL[final], stages, error: a.meta_error || (final === 'BLOCKED' ? (reval?.reason || 'اتمنع قبل الإرسال') : null), reason: a.ai_reason || null,
    policyRef: facts.policyRef || (facts.cpaPolicy ? { openCpa: { version: facts.cpaPolicy.version } } : null), cpaPolicy: facts.cpaPolicy ? { verdict: facts.cpaPolicy.verdict, cpa: facts.cpaPolicy.cpa, window: facts.cpaPolicy.window } : null,
    metaResponse: resp ? JSON.stringify(resp).slice(0, 400) : null, verify: verify ? { verified: verify.verified === true, observed: verify.observed ?? verify.status ?? null } : null,
  };
}
export async function listExecutionHistory({ limit = 100, type = null, final = null } = {}) {
  const take = Math.max(1, Math.min(300, Number(limit) || 100));
  const rows = await prisma.ambAction.findMany({ where: type ? { action_type: type } : {}, orderBy: { id: 'desc' }, take, include: { executed_by: { select: { name: true } }, recommendation: { select: { reason_facts_json: true, source: true } } } });
  const shaped = rows.map(shapeActionRow).filter((r) => !final || r.final === final);
  const counts = { total: shaped.length }; for (const r of shaped) counts[r.final] = (counts[r.final] || 0) + 1;
  return { rows: shaped, counts };
}

/** instant of 00:00 Africa/Cairo of the day that contains `now` (handles DST: the offset is measured, not assumed) */
export function cairoDayStart(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
  const wallAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)); const offset = wallAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) - offset);
}
/**
 * 📊 Today's operating summary (Africa/Cairo day) — read only, derived from amb_actions + the approval queue + the operator config. Counts what was actually SENT (EXECUTED) separately from what Meta CONFIRMED (read-back verified);
 * nothing is counted as done because it was merely requested. Exposure = budget the system ADDED today through increases (an open's own budget is not recorded on the action row, so it is not guessed); reductions are reported as released budget.
 */
export async function todaySummary({ now = new Date(), deps = {} } = {}) {
  const since = cairoDayStart(now);
  const rows = await prisma.ambAction.findMany({ where: { OR: [{ executed_at: { gte: since } }, { executed_at: null, created_at: { gte: since } }] }, orderBy: { id: 'desc' }, take: 500, include: { executed_by: { select: { name: true } }, recommendation: { select: { reason_facts_json: true, source: true } } } });
  const sh = rows.map(shapeActionRow); const by = { RESUME: 'opened', PAUSE: 'paused', INCREASE_BUDGET: 'increased', DECREASE_BUDGET: 'reduced' };
  const out = { opened: { sent: 0, verified: 0 }, paused: { sent: 0, verified: 0 }, increased: { sent: 0, verified: 0 }, reduced: { sent: 0, verified: 0 } };
  let exposureAdded = 0, budgetReleased = 0, failed = 0, blocked = 0, uncertain = 0; const byOrigin = { AUTOMATIC: { opened: 0, paused: 0, increased: 0, reduced: 0 }, MANUAL: { opened: 0, paused: 0, increased: 0, reduced: 0 }, APPROVED: { opened: 0, paused: 0, increased: 0, reduced: 0 } };
  for (const r of sh) {
    if (r.final === 'FAILED') failed++; else if (r.final === 'BLOCKED') blocked++; else if (r.final === 'UNCERTAIN') uncertain++;
    const k = by[r.type]; if (!k || !['VERIFIED', 'UNCERTAIN'].includes(r.final)) continue;
    out[k].sent++; byOrigin[r.origin][k]++; if (r.final === 'VERIFIED') out[k].verified++;
    const b = Number(r.after), a = Number(r.before);
    if (r.type === 'INCREASE_BUDGET' && Number.isFinite(b) && Number.isFinite(a)) exposureAdded += Math.max(0, b - a);
    else if (r.type === 'DECREASE_BUDGET' && Number.isFinite(b) && Number.isFinite(a)) budgetReleased += Math.max(0, a - b);
  }
  const AB = await import('./approvalCenter.js'); const bar = await AB.statusBar({ now, deps }).catch(() => ({ pendingApprovals: null, importantAlerts: null }));
  const cfg = deps.config || await (await import('./operatorStore.js')).getOperatorConfig();
  const health = { mode: cfg.mode, emergencyStop: !!cfg.emergency_stop, writesLocked: !!cfg.writesLocked, permissions: cfg.execPermissions, openAlerts: bar.importantAlerts ?? null };
  health.status = cfg.emergency_stop ? 'EMERGENCY_STOP' : cfg.writesLocked ? 'WRITES_LOCKED' : cfg.mode === 'APPROVAL' ? 'APPROVAL_READY' : cfg.mode === 'AUTOPILOT' ? 'AUTOMATIC' : 'OBSERVING';
  return { since, ...out, byOrigin, exposureAdded, budgetReleased, failed, blocked, uncertain, pendingApprovals: bar.pendingApprovals ?? null, health };
}
