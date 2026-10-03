// 🤖 AI Operator — canonical DECISION OBJECT + lifecycle helpers (pure, no I/O).
// The canonical object (spec 64) is the single source for the UI, the Assistant, Tasks, Execution and the Audit log: nothing re-derives a decision
// from raw rows in a different way. Storage statuses stay stable (SHADOW/BLOCKED/PREPARED/...); `lifecycle` is the spec's vocabulary.
import { unblockPlan } from './operatorUnblock.js';

/** spec 65 lifecycle: CANDIDATE → BLOCKED | SHADOW | READY_FOR_APPROVAL → APPROVED | REJECTED | EXPIRED → EXECUTING → EXECUTED → VERIFIED → MEASURING → EVALUATED | FAILED | ROLLED_BACK */
export const LIFECYCLE = ['CANDIDATE', 'BLOCKED', 'SHADOW', 'READY_FOR_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTING', 'EXECUTED', 'VERIFIED', 'MEASURING', 'EVALUATED', 'FAILED', 'ROLLED_BACK'];
export const LIFECYCLE_LABEL_AR = {
  CANDIDATE: 'مرشّح', BLOCKED: 'ممنوع بحاجز أمان', SHADOW: 'Shadow (مش هيتنفذ)', READY_FOR_APPROVAL: 'جاهز للموافقة', APPROVED: 'اتوافق عليه', REJECTED: 'مرفوض', EXPIRED: 'انتهت صلاحيته',
  EXECUTING: 'بيتنفذ…', EXECUTED: 'اتبعت لـ Meta (لسه مش متأكد)', VERIFIED: 'تم التنفيذ (متأكد من Meta)', MEASURING: 'تم التنفيذ — بنقيس الأثر', EVALUATED: 'تم التنفيذ — الأثر اتقيّم', FAILED: 'فشل', ROLLED_BACK: 'اترجع',
};

/** storage status (+ row) → spec lifecycle. SNOOZED is an operational detail of READY_FOR_APPROVAL. */
export function lifecycleOf(row) {
  const st = row.status;
  if (st === 'PREPARED' || st === 'SNOOZED') return 'READY_FOR_APPROVAL';
  if (st === 'VERIFIED') return row.outcome_json ? 'EVALUATED' : 'MEASURING';
  return LIFECYCLE.includes(st) ? st : 'CANDIDATE';
}

/** risk order the scheduler follows (spec 94): runaway/hard-stop first, then loss risk, approvals, scale, open, optimisation. Lower = sooner. */
export function riskRank({ action, category }) {
  if (category === 'HARD_SAFETY') return 1;
  if (action === 'PAUSE' || action === 'SCALE_DOWN') return 3;
  if (action === 'SCALE_UP') return 5;
  if (action === 'OPEN') return 6;
  return 7;
}

/** Hard-safety rules (stop-loss against a configured Hard Stop CPA) are separated from optimisation rules (open/scale/budget) — spec 85. */
export function isHardSafetyRule(rule) {
  const all = [...(rule?.conditions?.all || []), ...(rule?.conditions?.any || [])];
  const touchesHardStop = all.some((c) => c.field === 'hard_stop_cpa' || c.value?.ref === 'hard_stop_cpa');
  return touchesHardStop && ['PAUSE', 'SCALE_DOWN'].includes(rule?.action);
}

/** error → category. Only RETRYABLE failures may ever be retried (spec 107); everything else is recorded and surfaced. */
export function classifyError(err) {
  const msg = String(err?.message || err || '');
  const code = err?.code ?? err?.status ?? null;
  if (/rate.?limit|too many calls|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|timeout|temporar|try again|service unavailable|\b(4|17|32|613|80000|80004)\b/i.test(msg) || [429, 502, 503, 504].includes(Number(code))) return 'RETRYABLE';
  if (/permission|not authorized|access token|OAuthException|invalid parameter|does not exist|\(#200\)|\(#10\)/i.test(msg) || [400, 401, 403, 404].includes(Number(code))) return 'PERMANENT';
  if (/القواعد|رفض التنفيذ|محتاجة إعادة تحليل|حاجز/.test(msg)) return 'GUARD';
  return 'PERMANENT';
}

/**
 * Has the critical evidence changed since the decision was prepared? (spec 66) Pure over two evidence snapshots.
 * Returns the reasons; any reason expires the decision — a stale decision is never executed.
 */
export function evidenceDrift(prev, fresh, { action } = {}) {
  const out = [];
  const pm = prev?.metrics || {}, fm = fresh?.metrics || {};
  if (pm.cpa != null && fm.cpa != null && pm.cpa > 0 && Math.abs(fm.cpa - pm.cpa) / pm.cpa > 0.2) out.push({ code: 'CPA_CHANGED', detail: `${Math.round(pm.cpa)} → ${Math.round(fm.cpa)}` });
  if (action === 'PAUSE' && (fm.purchases ?? 0) > (pm.purchases ?? 0)) out.push({ code: 'NEW_PURCHASES', detail: `${pm.purchases ?? 0} → ${fm.purchases}` });
  const ps = prev?.stock, fs = fresh?.stock;
  if (ps && fs && ps.current != null && fs.current != null && ps.current !== fs.current) out.push({ code: 'STOCK_CHANGED', detail: `${ps.current} → ${fs.current}` });
  if (ps && fs && ps.status !== fs.status) out.push({ code: 'STOCK_STATUS_CHANGED', detail: `${ps.status} → ${fs.status}` });
  const pe = prev?.economics, fe = fresh?.economics;
  if (pe && fe && pe.unitMargin != null && fe.unitMargin != null && Math.abs(pe.unitMargin - fe.unitMargin) > 0.5) out.push({ code: 'PRICE_CHANGED', detail: `${Math.round(pe.unitMargin)} → ${Math.round(fe.unitMargin)}` });
  const pd = prev?.dataQuality?.gate, fd = fresh?.dataQuality?.gate;
  if (pd !== undefined && fd !== undefined && pd !== fd) out.push({ code: 'DATA_QUALITY_CHANGED', detail: `${pd} → ${fd}` });
  return out;
}

/** The expected live state right before the write: a status action needs the opposite status, a budget action needs the same budget it was computed from. */
export function expectedState({ action, campaign, params }) {
  if (action === 'PAUSE') return { status: 'ACTIVE' };
  if (action === 'OPEN') return { status: 'PAUSED' };
  if (['SCALE_UP', 'SCALE_DOWN'].includes(action)) return { status: 'ACTIVE', budget: params?.fromBudget ?? campaign?.budget ?? null };
  return {};
}
/** Does the current campaign still match what the decision was computed against? (null = nothing to compare). */
export function stateMatches(expected, current) {
  const reasons = [];
  if (expected?.status && current?.status && expected.status !== current.status) reasons.push({ code: 'STATUS_CHANGED', detail: `${expected.status} → ${current.status}` });
  if (expected?.budget != null && current?.budget != null && expected.budget > 0 && Math.abs(current.budget - expected.budget) / expected.budget > 0.01) reasons.push({ code: 'BUDGET_CHANGED', detail: `${expected.budget} → ${current.budget}` });
  return reasons;
}

/** previous / proposed Meta state shown on every decision (spec 64/73). Budget changes always show the real money: "500 → 600 EGP (+20%)". */
export function metaStates({ action, campaign, params }) {
  const prevState = { status: campaign?.status ?? null, budget: campaign?.budget ?? null };
  let proposed = { ...prevState };
  if (action === 'PAUSE') proposed.status = 'PAUSED';
  else if (action === 'OPEN') proposed.status = 'ACTIVE';
  else if (['SCALE_UP', 'SCALE_DOWN'].includes(action) && params?.toBudget != null) proposed.budget = params.toBudget;
  const money = ['SCALE_UP', 'SCALE_DOWN'].includes(action) && params?.fromBudget != null && params?.toBudget != null
    ? { from: params.fromBudget, to: params.toBudget, delta: Math.round((params.toBudget - params.fromBudget) * 100) / 100, pct: params.fromBudget ? Math.round(((params.toBudget - params.fromBudget) / params.fromBudget) * 1000) / 10 : null, currency: 'EGP' }
    : null;
  return { previousMetaState: prevState, proposedMetaState: proposed, budgetChange: money };
}

/**
 * Builds the canonical decision object (spec 64). `inp` is already-normalised data (works for a live candidate AND for a persisted row).
 * `requiresApproval` is true whenever a human must confirm: anything below AUTO, any downgrade, any non-autopilot effective mode.
 */
export function buildCanonical(inp) {
  const blocks = inp.blocks || [];
  const hard = blocks.filter((b) => b.severity === 'BLOCK');
  const plan = unblockPlan(blocks, { productId: inp.productId ?? null, campaignId: inp.campaignId ?? null });
  const downgraded = blocks.some((b) => b.severity === 'DOWNGRADE');
  const states = metaStates({ action: inp.action, campaign: inp.currentState, params: inp.params });
  return {
    decisionId: inp.decisionId ?? null, decisionKey: inp.decisionKey ?? null,
    storeId: inp.storeId ?? null, productId: inp.productId ?? null, campaignId: inp.campaignId ?? null, campaignName: inp.campaignName ?? null,
    evaluatedAt: inp.evaluatedAt ?? null, analysisWindow: inp.window ?? null, analysisRange: inp.windowRange ?? null,
    currentState: inp.currentState ?? null, recommendedAction: inp.action,
    ruleId: inp.ruleId ?? null, ruleVersion: inp.ruleVersion ?? null, ruleName: inp.ruleName ?? null, category: inp.category || 'OPTIMIZATION',
    advisorPlanVersion: inp.advisorPlanVersion ?? null, recommendationId: inp.recommendationId ?? null,
    evidence: inp.evidence ?? null, dataQuality: inp.evidence?.dataQuality ?? null,
    guards: blocks.map((b) => ({ code: b.code, specCodes: b.specCodes || [], group: b.group, severity: b.severity, message: b.message, detail: b.detail || null })),
    confidence: inp.confidence ?? null,
    blocked: hard.length > 0, blockReasons: plan.reasons, unblock: plan,
    requiresApproval: hard.length === 0 && (downgraded || inp.effectiveMode !== 'AUTOPILOT'),
    effectiveMode: inp.effectiveMode ?? null,
    previousMetaState: states.previousMetaState, proposedMetaState: states.proposedMetaState, budgetChange: states.budgetChange,
    status: inp.status ?? null, lifecycle: inp.lifecycle ?? null,
  };
}
