// AI Media Buyer — recommendation ⇄ live-Meta-state reconciliation.
//
// A PENDING recommendation is only valid while the target entity is still in
// the state the recommendation assumed. If an owner (or Meta itself) changes
// that state out-of-band — pauses a campaign in Ads Manager, resumes an ad,
// sets a budget to the exact value we were about to recommend — the
// recommendation is already satisfied and must NOT keep showing as an
// actionable "Approve & Execute" item.
//
// This runs after every Meta sync (scheduled + manual) and before a fresh
// generation. It reads the CURRENT entity state from the just-written
// snapshots (the freshest source right after a sync) and resolves any
// PENDING rec that no longer applies:
//   RESOLVED_EXTERNALLY   — the entity already reached the recommended state
//   NO_LONGER_APPLICABLE  — the entity has no recent snapshot (deleted /
//                           archived / stopped delivering entirely)
// Resolved rows are kept for audit; they just leave the active Action Plan.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';

const LEVEL_ID_FIELD = { campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' };
const BUDGET_TOLERANCE = 0.02; // 2% — "already at the target budget"

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

/**
 * Latest known Meta state per entity id, from the most recent snapshot that
 * mentions it, at every level. { status, budget, budgetType, seenAt }.
 */
export async function getLiveEntityStates({ adAccountId, sinceHours = 6 }) {
  const since = new Date(Date.now() - sinceHours * 3600 * 1000);
  const rows = await prisma.metaPerformanceSnapshot.findMany({
    where: { ad_account_id: adAccountId, snapshot_at: { gte: since } },
    orderBy: { snapshot_at: 'asc' }, // later writes overwrite earlier ones below
    select: {
      level: true, snapshot_at: true,
      campaign_id: true, campaign_status: true, campaign_budget: true, campaign_budget_type: true,
      adset_id: true, adset_status: true, adset_budget: true, adset_budget_type: true,
      ad_id: true, ad_status: true,
    },
  });
  const map = new Map();
  for (const r of rows) {
    if (r.campaign_id) map.set(r.campaign_id, { status: r.campaign_status || null, budget: r.campaign_budget ?? null, budgetType: r.campaign_budget_type || null, seenAt: r.snapshot_at });
    if (r.adset_id) map.set(r.adset_id, { status: r.adset_status || null, budget: r.adset_budget ?? null, budgetType: r.adset_budget_type || null, seenAt: r.snapshot_at });
    if (r.ad_id) map.set(r.ad_id, { status: r.ad_status || null, budget: null, budgetType: null, seenAt: r.snapshot_at });
  }
  return map;
}

/** True when Meta's effective_status means the entity is actually delivering. */
export function isActive(status) {
  return status === 'ACTIVE';
}

/**
 * Decide whether one PENDING rec is already satisfied by the current state.
 * @returns {{status:'RESOLVED_EXTERNALLY'|'NO_LONGER_APPLICABLE', note:string} | null}
 */
export function evaluateAgainstLiveState(rec, live) {
  if (!live || !live.status) {
    return { status: 'NO_LONGER_APPLICABLE', note: 'العنصر لم يعد له بيانات حديثة في Meta (اتوقف نهائيًا أو اتحذف) — لا يوجد إجراء مطلوب.' };
  }
  const active = isActive(live.status);
  const isPauseLike = ['PAUSE', 'PAUSE_LOSER'].includes(rec.decision) || rec.action_type === 'PAUSE';
  const isResumeLike = rec.decision === 'RESUME' || rec.action_type === 'RESUME';
  const isBudgetChange = ['INCREASE_BUDGET', 'DECREASE_BUDGET'].includes(rec.action_type);
  const isDraftOrMonitor = !['PAUSE', 'RESUME', 'INCREASE_BUDGET', 'DECREASE_BUDGET'].includes(rec.action_type);

  if (isPauseLike && !active) {
    return { status: 'RESOLVED_EXTERNALLY', note: 'تم إيقاف العنصر بالفعل من Meta Ads Manager — لا يوجد إجراء مطلوب.' };
  }
  if (isResumeLike && active) {
    return { status: 'RESOLVED_EXTERNALLY', note: 'تم تشغيل العنصر بالفعل من Meta Ads Manager — لا يوجد إجراء مطلوب.' };
  }
  if (isBudgetChange) {
    if (!active) {
      return { status: 'NO_LONGER_APPLICABLE', note: 'العنصر متوقف حاليًا في Meta — تعديل الميزانية مش قابل للتطبيق. شغّل العنصر الأول لو عايز تعدّل ميزانيته.' };
    }
    const target = n(rec.recommended_budget);
    const cur = n(live.budget);
    if (target != null && cur != null && cur > 0 && Math.abs(cur - target) / cur <= BUDGET_TOLERANCE) {
      return { status: 'RESOLVED_EXTERNALLY', note: `الميزانية الحالية في Meta (${Math.round(cur)} ج) بالفعل تساوي الهدف تقريبًا — لا يوجد إجراء مطلوب.` };
    }
  }
  if (isDraftOrMonitor && !active) {
    // A "monitor / draft test" recommendation on an entity that's now paused
    // is moot — nothing to monitor and nothing to duplicate from a stopped entity.
    return { status: 'NO_LONGER_APPLICABLE', note: 'العنصر متوقف حاليًا في Meta — التوصية دي مبقاش ليها معنى.' };
  }
  return null;
}

/**
 * Reconcile every PENDING recommendation for the connected account against
 * the current live Meta state. Resolves the ones already satisfied.
 * @returns {{ok:boolean, checked:number, resolvedExternally:number, noLongerApplicable:number, details:object[]}}
 */
export async function reconcilePendingRecommendations({ adAccountId }) {
  if (!adAccountId) return { ok: false, error: 'NO_AD_ACCOUNT' };

  // Collapse any PENDING rec that isn't in the newest batch — a newer
  // analysis supersedes it. (Defensive: covers a generate() whose supersede
  // step didn't fully commit.)
  const newest = await prisma.ambRecommendation.findFirst({
    where: { ad_account_id: adAccountId }, orderBy: { created_at: 'desc' }, select: { batch_id: true },
  });
  let stale = 0;
  if (newest) {
    const s = await prisma.ambRecommendation.updateMany({
      where: { ad_account_id: adAccountId, status: 'PENDING', batch_id: { not: newest.batch_id } },
      data: { status: 'SUPERSEDED' },
    }).catch(() => ({ count: 0 }));
    stale = s.count;
  }

  const pending = await prisma.ambRecommendation.findMany({
    where: { ad_account_id: adAccountId, status: 'PENDING', ...(newest ? { batch_id: newest.batch_id } : {}) },
  });
  if (pending.length === 0) return { ok: true, checked: 0, staleSuperseded: stale, resolvedExternally: 0, noLongerApplicable: 0, details: [] };

  const live = await getLiveEntityStates({ adAccountId });
  let resolvedExternally = 0, noLongerApplicable = 0;
  const details = [];

  for (const rec of pending) {
    // entity_id is the Meta id the action targets (campaign/adset/ad). For a
    // product-level rec there is no single entity — skip (nothing to reconcile).
    if (!rec.entity_id) continue;
    const state = live.get(rec.entity_id) || null;
    const verdict = evaluateAgainstLiveState(rec, state);
    if (!verdict) continue;

    await prisma.ambRecommendation.update({
      where: { id: rec.id },
      data: { status: verdict.status, resolution_note: verdict.note, resolved_at: new Date() },
    });
    if (verdict.status === 'RESOLVED_EXTERNALLY') resolvedExternally++;
    else noLongerApplicable++;
    details.push({ id: rec.id, entity: rec.entity_name, decision: rec.decision, from: 'PENDING', to: verdict.status, note: verdict.note });
  }

  if (resolvedExternally + noLongerApplicable > 0) {
    logger.info('AMB reconciliation resolved recommendations', { adAccountId, resolvedExternally, noLongerApplicable, checked: pending.length });
  }
  return { ok: true, checked: pending.length, staleSuperseded: stale, resolvedExternally, noLongerApplicable, details };
}
