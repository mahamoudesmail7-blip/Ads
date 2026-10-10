// 🔁 RESTART RECOVERY — what happens to work that was in flight when the server died (a Railway redeploy / crash).
//
// The rule that makes it safe: NOTHING IS EVER RE-SENT. An interrupted operation is settled by ASKING Meta what it holds now (an independent read), never by repeating the write.
//   · a request that was recorded as sent (item SENT / an action row with a recorded Meta request)  →  read-back:  the target value → VERIFIED · the old value → FAILED · unreadable → UNCERTAIN
//   · an operation interrupted BEFORE anything was sent                                            →  daily-plan items: SKIPPED (the owner re-prepares) · decisions: back to PREPARED (a fresh approval + fresh live validation)
// Plans that were RUNNING end up COMPLETED with a summary flagged `recovered`, so they can never be claimed/executed again (the executor only claims APPROVED plans). Every settlement is audited.
// Orphans are found by an EXPIRED lock (a plan holds a 30-min lock), or — once, at server start — by a lock owned by another (dead) process instance.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { INSTANCE } from './dailyPlans.js';

const MS_M = 60_000;
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const FINAL = new Set(['VERIFIED', 'FAILED', 'SKIPPED', 'BLOCKED', 'SIMULATED', 'UNCERTAIN']);
const event = async (data) => { try { await prisma.ambOperatorEvent.create({ data }); } catch (e) { logger.warn('[executionRecovery] event write failed', { message: e.message }); } };

/** Independent READ of a campaign's current status + daily budget. deps.readEntity({entityId}) is the test hook; null when Meta cannot be read. */
async function readLive(entityId, deps) {
  try {
    if (deps.readEntity) return await deps.readEntity({ entityId });
    const [{ getEntity }, { getDecryptedToken }] = await Promise.all([import('../metaGraphClient.js'), import('../metaAuth.js')]);
    const token = await getDecryptedToken(); const e = await getEntity(token, entityId, 'status,effective_status,daily_budget');
    const d = Number(e.daily_budget); return { status: e.effective_status || e.status || null, budget: Number.isFinite(d) ? d / 100 : null };
  } catch (e) { logger.warn('[executionRecovery] read-back failed', { entityId, message: e.message }); return null; }
}
/** What did the interrupted write intend, and does Meta now hold it?  → 'APPLIED' | 'NOT_APPLIED' | 'UNREADABLE' */
function judge(live, newV, oldV) {
  if (!live) return 'UNREADABLE';
  if (newV?.budget != null) { if (live.budget == null) return 'UNREADABLE'; if (Math.abs(live.budget - Number(newV.budget)) < 1) return 'APPLIED'; return 'NOT_APPLIED'; }
  if (newV?.status) { if (!live.status) return 'UNREADABLE'; if (live.status === newV.status) return 'APPLIED'; if (!oldV?.status || live.status === oldV.status) return 'NOT_APPLIED'; return 'UNREADABLE'; }
  return 'UNREADABLE';
}
async function settleAction(action, outcome, live, note) {
  if (!action) return;
  const verify = JSON.stringify({ verified: outcome === 'APPLIED', recovered: true, observed: live ? { status: live.status, budget: live.budget } : null, unreadable: outcome === 'UNREADABLE', note });
  if (outcome === 'NOT_APPLIED') await prisma.ambAction.update({ where: { id: action.id }, data: { execution_status: 'FAILED', meta_error: String(note).slice(0, 800), verify_json: verify, verified_at: new Date() } }).catch(() => {});
  else await prisma.ambAction.update({ where: { id: action.id }, data: { execution_status: 'EXECUTED', executed_at: action.executed_at || new Date(), verify_json: verify, verified_at: outcome === 'APPLIED' ? new Date() : null } }).catch(() => {});
}
const actionOfItem = (plan, item) => prisma.ambAction.findFirst({ where: { entity_id: item.campaign_id, recommendation: { batch_id: `daily-plan-${plan.id}` } }, orderBy: { id: 'desc' } });

// ------------------------------------------------------------------------------------------------ daily plans
export async function recoverInterruptedPlans({ now = new Date(), onStartup = false, deps = {} } = {}) {
  const orphans = await prisma.ambDailyPlan.findMany({ where: { status: 'RUNNING', OR: [{ lock_until: null }, { lock_until: { lt: now } }, { lock_owner: null }, ...(onStartup ? [{ NOT: { lock_owner: INSTANCE } }] : [])] }, include: { items: { orderBy: { rank: 'asc' } } } });
  const out = [];
  for (const plan of orphans) {
    const target = plan.type === 'OPEN' ? 'ACTIVE' : 'PAUSED', prev = plan.type === 'OPEN' ? 'PAUSED' : 'ACTIVE'; const settled = [];
    for (const item of plan.items.filter((i) => i.selected && !FINAL.has(i.status))) {
      const act = await actionOfItem(plan, item); const requestWentOut = item.status === 'SENT' || !!act?.meta_request_json;
      let status, reason;
      if (!requestWentOut) { status = 'SKIPPED'; reason = 'RESTART_NOT_RESUMED — العملية اتقطعت قبل الإرسال ومفيش تنفيذ تلقائي بعد إعادة التشغيل. جهّز الخطة تاني لو لسه مطلوبة.'; if (act && act.execution_status === 'REVALIDATING') await prisma.ambAction.update({ where: { id: act.id }, data: { execution_status: 'FAILED', meta_error: 'اتقطعت قبل الإرسال (إعادة تشغيل)' } }).catch(() => {}); }
      else {
        const live = await readLive(item.campaign_id, deps); const outcome = judge(live, { status: target }, { status: prev });
        status = outcome === 'APPLIED' ? 'VERIFIED' : outcome === 'NOT_APPLIED' ? 'FAILED' : 'UNCERTAIN';
        reason = outcome === 'APPLIED' ? `اتأكد بقراءة مستقلة بعد إعادة التشغيل: ${prev} → ${target} (مفيش إعادة إرسال)` : outcome === 'NOT_APPLIED' ? `التغيير ما اتطبقش (قراءة مستقلة بعد إعادة التشغيل: ${live?.status}) — مفيش إعادة إرسال` : 'الطلب ممكن يكون خرج وما قدرناش نقرأ Meta بعد إعادة التشغيل — راجع الحملة يدويًا (مفيش إعادة إرسال)';
        await settleAction(act, outcome, live, reason);
      }
      await prisma.ambDailyPlanItem.update({ where: { id: item.id }, data: { status, status_reason: reason.slice(0, 480), status_at: new Date(), ...(act ? { amb_action_id: act.id } : {}) } });
      await event({ kind: 'DAILY_PLAN_ITEM', actor: 'SYSTEM', note: `RECOVERY ${item.status} → ${status}: ${reason}`.slice(0, 480), campaign_id: item.campaign_id, data_json: JSON.stringify({ planId: plan.id, itemId: item.id, action: 'RECOVERED', from: item.status, to: status }) });
      settled.push({ campaignId: item.campaign_id, from: item.status, to: status });
    }
    const all = await prisma.ambDailyPlanItem.findMany({ where: { plan_id: plan.id, selected: true } }); const cnt = (s) => all.filter((i) => i.status === s).length;
    const summary = { executionMode: plan.execution_mode, selected: all.length, verified: cnt('VERIFIED'), simulated: cnt('SIMULATED'), failed: cnt('FAILED'), skipped: cnt('SKIPPED'), blocked: cnt('BLOCKED'), uncertain: cnt('UNCERTAIN'), actuallyChanged: cnt('VERIFIED'), notChanged: all.length - cnt('VERIFIED'), recovered: true, recoveredAt: now.toISOString() };
    const end = await prisma.ambDailyPlan.updateMany({ where: { id: plan.id, status: 'RUNNING' }, data: { status: 'COMPLETED', finished_at: now, summary_json: JSON.stringify(summary), lock_until: null, lock_owner: null } });
    if (!end.count) continue; // another instance settled it first
    await event({ kind: 'DAILY_PLAN', actor: 'SYSTEM', note: `استرداد بعد إعادة التشغيل: الخطة #${plan.id} اتقفلت — ${summary.verified} اتأكد، ${summary.uncertain} غير مؤكد، ${summary.skipped} متخطي، ${summary.failed} فشل (مفيش إعادة إرسال)`, data_json: JSON.stringify({ planId: plan.id, action: 'RECOVERED', summary, settled }).slice(0, 3000) });
    if (!plan.simulated && process.env.DAILY_PLAN_DISABLE_ALERTS !== '1') { try { const { raiseAlert } = await import('./alerts.js'); await raiseAlert({ severity: summary.uncertain || summary.failed ? 'WARNING' : 'INFO', category: 'OPERATOR', title: `استرداد بعد إعادة تشغيل: خطة ${plan.type === 'OPEN' ? 'الفتح' : 'الإيقاف'} #${plan.id}`, message: `السيرفر اتعاد تشغيله أثناء التنفيذ. اتأكد ${summary.verified} · غير مؤكد ${summary.uncertain} · متخطي ${summary.skipped}. مفيش أي إعادة إرسال.`, dedupeKey: `dailyplan-recovery:${plan.id}` }); } catch { /* alert is best-effort */ } }
    out.push({ planId: plan.id, settled, summary });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ decisions (EXECUTING)
export async function recoverInterruptedDecisions({ now = new Date(), onStartup = false, olderThanMin = 10, deps = {} } = {}) {
  const rows = await prisma.ambOperatorDecision.findMany({ where: { status: 'EXECUTING', ...(onStartup ? {} : { updated_at: { lt: new Date(now.getTime() - olderThanMin * MS_M) } }) } });
  const out = [];
  for (const row of rows) {
    const act = row.amb_recommendation_id ? await prisma.ambAction.findFirst({ where: { recommendation_id: row.amb_recommendation_id }, orderBy: { id: 'desc' } }) : null;
    const tr = (to, note, extra = {}) => event({ decision_id: row.id, kind: 'TRANSITION', from_status: 'EXECUTING', to_status: to, actor: 'SYSTEM', note: `RECOVERY: ${note}`.slice(0, 480), campaign_id: row.campaign_id, data_json: JSON.stringify({ recovered: true, ...extra }).slice(0, 3000) });
    if (!act?.meta_request_json) { // nothing went out: back to the owner's queue (fresh approval + fresh live validation required)
      const r = await prisma.ambOperatorDecision.updateMany({ where: { id: row.id, status: 'EXECUTING' }, data: { status: 'PREPARED', error: 'RESTART: العملية اتقطعت قبل الإرسال — رجعت لمرحلة الموافقة (محتاجة اعتماد جديد).' } });
      if (r.count) { if (act && act.execution_status === 'REVALIDATING') await prisma.ambAction.update({ where: { id: act.id }, data: { execution_status: 'FAILED', meta_error: 'اتقطعت قبل الإرسال (إعادة تشغيل)' } }).catch(() => {}); await tr('PREPARED', 'لم يُرسل شيء لـMeta'); out.push({ decisionId: row.id, to: 'PREPARED' }); }
      continue;
    }
    const newV = j(act.new_value_json, null), oldV = j(act.old_value_json, null); const live = await readLive(act.entity_id, deps); const outcome = judge(live, newV, oldV);
    const note = outcome === 'APPLIED' ? 'اتأكد بقراءة مستقلة بعد إعادة التشغيل' : outcome === 'NOT_APPLIED' ? 'التغيير ما اتطبقش (قراءة مستقلة)' : 'ما قدرناش نقرأ Meta بعد إعادة التشغيل — راجع يدويًا';
    await settleAction(act, outcome, live, note);
    const to = outcome === 'APPLIED' ? 'VERIFIED' : outcome === 'NOT_APPLIED' ? 'FAILED' : 'EXECUTED';
    const r = await prisma.ambOperatorDecision.updateMany({ where: { id: row.id, status: 'EXECUTING' }, data: { status: to, amb_action_id: act.id, executed_at: act.executed_at || new Date(), verified_at: outcome === 'APPLIED' ? new Date() : null, verify_json: JSON.stringify({ verified: outcome === 'APPLIED', recovered: true, observed: live }), error: outcome === 'APPLIED' ? null : `${note}${outcome === 'UNREADABLE' ? ' (Unverified)' : ''}`, error_category: outcome === 'NOT_APPLIED' ? 'EXECUTION' : null } });
    if (r.count) { if (outcome === 'APPLIED' && act.recommendation_id) await prisma.ambRecommendation.update({ where: { id: act.recommendation_id }, data: { status: 'EXECUTED' } }).catch(() => {}); await tr(to, note, { observed: live }); out.push({ decisionId: row.id, to }); }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ stray action rows (e.g. the legacy approve route died mid-write)
export async function recoverInterruptedActions({ now = new Date(), onStartup = false, olderThanMin = 10, deps = {} } = {}) {
  const rows = await prisma.ambAction.findMany({ where: { execution_status: 'REVALIDATING', ...(onStartup ? {} : { created_at: { lt: new Date(now.getTime() - olderThanMin * MS_M) } }) }, take: 50 });
  const out = [];
  for (const act of rows) {
    if (!act.meta_request_json) { const r = await prisma.ambAction.updateMany({ where: { id: act.id, execution_status: 'REVALIDATING' }, data: { execution_status: 'FAILED', meta_error: 'اتقطعت قبل الإرسال (إعادة تشغيل)' } }); if (r.count) { await prisma.ambRecommendation.updateMany({ where: { id: act.recommendation_id, status: { in: ['APPROVED'] } }, data: { status: 'PENDING' } }).catch(() => {}); out.push({ actionId: act.id, to: 'FAILED' }); } continue; }
    const live = await readLive(act.entity_id, deps); const outcome = judge(live, j(act.new_value_json, null), j(act.old_value_json, null));
    await settleAction(act, outcome, live, outcome === 'APPLIED' ? 'اتأكد بعد إعادة التشغيل' : outcome === 'NOT_APPLIED' ? 'التغيير ما اتطبقش (قراءة مستقلة)' : 'غير مؤكد — راجع يدويًا');
    if (outcome === 'APPLIED') await prisma.ambRecommendation.update({ where: { id: act.recommendation_id }, data: { status: 'EXECUTED' } }).catch(() => {});
    await event({ kind: 'ACTION_RECOVERY', actor: 'SYSTEM', campaign_id: act.campaign_id, note: `RECOVERY action #${act.id}: ${outcome}`, data_json: JSON.stringify({ actionId: act.id, outcome, observed: live }) });
    out.push({ actionId: act.id, to: outcome });
  }
  return out;
}

/** One call for the scheduler / startup. Never throws; each part is independent. */
export async function recoverInterrupted({ now = new Date(), onStartup = false, deps = {} } = {}) {
  const res = {};
  for (const [k, fn] of [['plans', recoverInterruptedPlans], ['decisions', recoverInterruptedDecisions], ['actions', recoverInterruptedActions]]) {
    try { res[k] = await fn({ now, onStartup, deps }); } catch (e) { logger.error('[executionRecovery] part failed', { part: k, message: e.message }); res[k] = { error: e.message }; }
  }
  const n = ['plans', 'decisions', 'actions'].reduce((t, k) => t + (Array.isArray(res[k]) ? res[k].length : 0), 0);
  if (n) logger.warn('[executionRecovery] settled interrupted work — nothing was re-sent', { count: n });
  return res;
}
