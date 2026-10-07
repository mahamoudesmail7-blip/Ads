// 📅 Daily Operations Center — plan LIFECYCLE, execution engine and server scheduler. 2026-10-07.
//
//   server scheduler (60s, Africa/Cairo)  ->  due slot reached (00:00 OPEN / 13:00 PAUSE)  ->  safe Meta refresh  ->  candidates  ->  PREPARED plan + popup/alert
//   owner reviews + ticks/unticks checkboxes  ->  "approve" (ADMIN)  ->  campaigns one by one: PENDING -> REVALIDATING -> SENT -> VERIFIED | FAILED | SKIPPED | BLOCKED | UNCERTAIN
//
// SAFETY MODEL (everything fails closed):
//   * Preparing / showing a plan never executes anything. Opening the popup never executes anything. A checkbox only SELECTS; only the ADMIN's approve button is the approval.
//   * Global mode SHADOW (or MANUAL/OFF): approval runs the SAME queue as a SIMULATION — every campaign is revalidated against live Meta and ends SIMULATED; NO Meta write exists on that path.
//   * LIVE execution needs ALL of: global mode APPROVAL, deployment write-lock open, no Emergency Stop, queue not halted, the per-type permission (allowOpen / allowPause) explicitly granted by an ADMIN,
//     a plan that is FRESH (Meta data not stale) and not simulated. The write itself is the existing AMB executor (live revalidation + ONE Meta write + read-back). Unconfirmed => UNCERTAIN, never a blind re-POST.
//   * An edit after approval creates a NEW version (the old one is SUPERSEDED and can never run). A plan whose day is over is MISSED — never executed late on its own.
//   * Unattended execution at the due time ("scheduled execution") exists only as a switch that is OFF; this turn does not enable it.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection, getDecryptedToken } from '../metaAuth.js';
import { getOperatorConfig, addException, metaWritesLocked } from './operatorStore.js';
import { getSyncStatus, runSnapshotSync } from './snapshotSync.js';
import { raiseAlert } from './alerts.js';
import { buildOpenCandidates, buildPauseCandidates } from './dailyPlanCandidates.js';
import { SLOTS, TYPE_LABEL_AR, CAIRO_TZ, cairoDate, cairoParts, dueTypes, dueAt, expiresAt, nextDue, planKey, clockNow, isTestClock } from './dailyPlanTime.js';

const MS_M = 60_000, MS_H = 3_600_000;
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const INSTANCE = `${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
export const DEFAULT_DAILY_CONFIG = {
  allowOpen: false, allowPause: false,       // LIVE permission per action type — an ADMIN grants them explicitly, separately, after reviewing
  scheduledExecution: { enabled: false },    // unattended execution at the due time — OFF; the approve click is the approval
  halted: false,                             // kill switch for the queue (stops new orders immediately)
  spacingSeconds: 3, staleMinutes: 30, rateLimitStopAfter: 3, monitoringHours: 24,
};
const ITEM_FINAL = new Set(['VERIFIED', 'FAILED', 'SKIPPED', 'BLOCKED', 'SIMULATED', 'UNCERTAIN']);

// =====================================================================================================================
// config (inside the operator config blob: limits_json.dailyPlan) — ADMIN only at the routes
// =====================================================================================================================
export async function getDailyPlanConfig() { const c = await getOperatorConfig(); return { ...DEFAULT_DAILY_CONFIG, ...(c.limits?.dailyPlan || {}), scheduledExecution: { ...DEFAULT_DAILY_CONFIG.scheduledExecution, ...(c.limits?.dailyPlan?.scheduledExecution || {}) } }; }
export async function setDailyPlanConfig({ patch, userId = null }) {
  const row = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const rawLimits = j(row?.limits_json, null); const prev = await getDailyPlanConfig();
  const next = { ...prev, ...Object.fromEntries(Object.entries(patch || {}).filter(([k]) => ['allowOpen', 'allowPause', 'halted', 'spacingSeconds', 'staleMinutes'].includes(k))) };
  if (patch?.scheduledExecution && typeof patch.scheduledExecution.enabled === 'boolean') next.scheduledExecution = { enabled: patch.scheduledExecution.enabled, by: userId, at: new Date().toISOString() };
  for (const k of ['allowOpen', 'allowPause', 'halted']) if (typeof next[k] !== 'boolean') { const e = new Error(`${k} لازم true/false.`); e.status = 400; throw e; }
  next.spacingSeconds = Math.max(3, Math.min(120, Number(next.spacingSeconds) || 3)); next.staleMinutes = Math.max(5, Math.min(180, Number(next.staleMinutes) || 30));
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify({ ...(rawLimits || {}), dailyPlan: next }), updated_by_id: userId } });
  await prisma.aiAuditLog.create({ data: { actor_id: userId || null, kind: 'DAILY_PLAN_CONFIG', action: 'EXECUTE', input_json: JSON.stringify({ patch, from: prev, to: next }).slice(0, 3000), success: true } }).catch(() => {});
  return next;
}

// =====================================================================================================================
// audit + notifications
// =====================================================================================================================
async function audit({ planId = null, kind = 'DAILY_PLAN', userId = null, campaignId = null, note = null, data = null, actor = null }) {
  try { await prisma.ambOperatorEvent.create({ data: { kind, actor: actor || (userId ? 'USER' : 'SYSTEM'), actor_id: userId, note: note ? String(note).slice(0, 480) : null, data_json: JSON.stringify({ planId, ...(data || {}) }).slice(0, 3000), campaign_id: campaignId } }); } catch (e) { logger.warn('[dailyPlans] audit write failed', { message: e.message }); }
}
async function notify(plan, { severity = 'INFO', title, message, suffix }) {
  if (plan.simulated || process.env.DAILY_PLAN_DISABLE_ALERTS === '1') return null; // test-clock plans (and tests) never raise real alerts
  return raiseAlert({ severity, category: 'OPERATOR', title, message, dedupeKey: `dailyplan:${plan.plan_key}:v${plan.version}:${suffix}` }).catch(() => null);
}

// =====================================================================================================================
// data freshness — a safe refresh from Meta before showing candidates; Meta unavailable => STALE (no execution on untrusted data)
// =====================================================================================================================
export async function ensureFreshData({ now = new Date(), deps = {}, force = false } = {}) {
  const cfg = await getDailyPlanConfig(); const maxAgeMs = cfg.staleMinutes * MS_M;
  const read = async () => { const s = await (deps.syncStatus ? deps.syncStatus() : getSyncStatus()); return s?.lastSuccessAt ? new Date(s.lastSuccessAt) : null; };
  let asOf = await read(); let refreshed = false, error = null;
  if (force || !asOf || Date.now() - asOf.getTime() > maxAgeMs) {
    try { const r = await (deps.refresh ? deps.refresh() : runSnapshotSync({ trigger: 'MANUAL' })); refreshed = !!(r?.ok); if (!r?.ok) error = r?.error || r?.skipped || 'REFRESH_FAILED'; asOf = await read(); } catch (e) { error = e.message; }
  }
  const stale = !asOf || Date.now() - asOf.getTime() > maxAgeMs; // freshness is judged on the REAL clock (a virtual test clock never makes old data look fresh)
  return { asOf, state: stale ? 'STALE' : 'FRESH', refreshed, error: stale ? (error || 'STALE') : null };
}

// =====================================================================================================================
// preparing plans
// =====================================================================================================================
const shapeItemRow = (it) => ({ id: it.id, campaignId: it.campaign_id, campaignName: it.campaign_name, productId: it.product_id, productName: it.product_name, storeId: it.store_id, rank: it.rank, selected: it.selected, selectable: it.selectable, eligibility: it.eligibility, blockCodes: j(it.block_codes_json, []), risk: it.risk, riskScore: it.risk_score, reason: it.reason, evidence: j(it.evidence_json, {}), status: it.status, statusReason: it.status_reason, statusAt: it.status_at, ambActionId: it.amb_action_id, attempts: it.attempts });
export function shapePlan(p, items = []) {
  const sel = items.filter((i) => i.selected);
  return {
    id: p.id, key: p.plan_key, type: p.type, typeLabel: TYPE_LABEL_AR[p.type], date: p.plan_date, timezone: p.timezone, version: p.version, status: p.status, simulated: p.simulated, scheduledAt: p.scheduled_at, expiresAt: p.expires_at, preparedAt: p.prepared_at,
    dataAsOf: p.data_as_of, dataState: p.data_state, surfacedAt: p.surfaced_at, dismissedAt: p.dismissed_at, approvedById: p.approved_by_id, approvedAt: p.approved_at, approvalMode: p.approval_mode, executionMode: p.execution_mode, startedAt: p.started_at, finishedAt: p.finished_at,
    summary: j(p.summary_json, null), evidence: j(p.evidence_json, null), items: items.map(shapeItemRow),
    counts: { total: items.length, selected: sel.length, protected: items.filter((i) => ['PROTECTED', 'BLOCKED'].includes(i.eligibility)).length, selectable: items.filter((i) => i.selectable).length },
  };
}
const latestVersion = (plan_key) => prisma.ambDailyPlan.findFirst({ where: { plan_key }, orderBy: { version: 'desc' }, include: { items: { orderBy: { rank: 'asc' } } } });

/** Builds + stores the plan of `type` for Cairo day `date`. Idempotent: an existing plan of that day/type is returned untouched (unique plan_key+version). */
export async function preparePlan({ type, date, now = new Date(), simulated = isTestClock(), deps = {}, userId = null }) {
  if (!SLOTS[type]) { const e = new Error('نوع خطة غير معروف.'); e.status = 400; throw e; }
  const key = planKey(type, date, simulated); const exists = await latestVersion(key); if (exists) return { plan: exists, created: false };
  const fresh = await ensureFreshData({ now, deps });
  const built = await (deps.build ? deps.build({ type, now }) : (type === 'OPEN' ? buildOpenCandidates({ now, deps: deps.candidates || {} }) : buildPauseCandidates({ now, deps: deps.candidates || {} })));
  const cfg = await getOperatorConfig(); const dcfg = await getDailyPlanConfig();
  const stale = fresh.state === 'STALE';
  let plan;
  try {
    plan = await prisma.ambDailyPlan.create({ data: {
      plan_key: key, type, plan_date: date, timezone: CAIRO_TZ, version: 1, status: 'PREPARED', simulated, scheduled_at: dueAt(type, date), expires_at: expiresAt(date), prepared_at: now, data_as_of: fresh.asOf, data_state: fresh.state, surfaced_at: now >= dueAt(type, date) ? now : null,
      evidence_json: JSON.stringify({ mode: cfg.mode, emergencyStop: cfg.emergency_stop, writesLocked: metaWritesLocked(), policy: built.policy ? { zeroOrders: built.policy.zeroOrders, scale: built.policy.scale, reduce: built.policy.reduce, highCpa: built.policy.highCpa } : null, dataAsOf: fresh.asOf, refreshed: fresh.refreshed, staleReason: fresh.error, staleMinutes: dcfg.staleMinutes, pausedPool: built.pausedTotal ?? null, candidatesPool: built.candidatesPool ?? null, preparedBy: userId ? 'USER' : 'SCHEDULER' }),
      items: { create: built.items.map((it) => ({ campaign_id: it.campaignId, campaign_name: it.campaignName, product_id: it.productId, product_name: it.productName, store_id: it.storeId, rank: it.rank, selected: stale ? false : !!it.selected, selectable: stale ? false : !!it.selectable, eligibility: it.eligibility, block_codes_json: JSON.stringify([...(it.blockCodes || []), ...(stale ? ['STALE_DATA'] : [])]), risk: it.risk, risk_score: it.riskScore, evidence_json: JSON.stringify({ ...it.evidence, warnings: it.warnings }), reason: stale ? `STALE DATA — ${it.reason}` : it.reason })) },
    }, include: { items: { orderBy: { rank: 'asc' } } } });
  } catch (e) { if (e.code === 'P2002') return { plan: await latestVersion(key), created: false }; throw e; }
  await audit({ planId: plan.id, userId, note: `خطة ${TYPE_LABEL_AR[type]} اتجهزت (${plan.items.length} حملة، بيانات ${fresh.state})`, data: { action: 'PREPARED', type, date, version: 1, dataState: fresh.state, items: plan.items.length, selected: plan.items.filter((i) => i.selected).length } });
  if (plan.surfaced_at) await notify(plan, { title: `جدول ${type === 'OPEN' ? 'فتح' : 'إيقاف'} الحملات جاهز للمراجعة`, message: stale ? 'البيانات قديمة (STALE) — مفيش تنفيذ لحد ما Meta تتاح وتتحدّث.' : `${plan.items.filter((i) => i.selected).length} حملة مختارة من ${plan.items.length}. راجع الجدول واضغط اعتماد — مفيش أي تنفيذ قبل كده.`, suffix: 'ready' });
  return { plan, created: true };
}

/** Scheduler step 1: every plan whose slot has arrived on the current CAIRO day exists (and is surfaced); plans of finished days that nobody executed become MISSED. */
export async function ensureDuePlans({ now = new Date(), simulated = isTestClock(), deps = {} } = {}) {
  const out = { prepared: [], missed: [] };
  for (const d of dueTypes(now)) {
    const key = planKey(d.type, d.date, simulated); const ex = await latestVersion(key);
    if (!ex) { const r = await preparePlan({ type: d.type, date: d.date, now, simulated, deps }); if (r.created) out.prepared.push({ type: d.type, date: d.date, planId: r.plan.id }); }
    else if (!ex.surfaced_at) { await prisma.ambDailyPlan.update({ where: { id: ex.id }, data: { surfaced_at: now } }); out.prepared.push({ type: d.type, date: d.date, planId: ex.id, surfacedOnly: true }); }
  }
  const stale = await prisma.ambDailyPlan.findMany({ where: { simulated, status: { in: ['PREPARED', 'APPROVED'] }, expires_at: { lte: now } } });
  for (const p of stale) { const r = await prisma.ambDailyPlan.updateMany({ where: { id: p.id, status: { in: ['PREPARED', 'APPROVED'] } }, data: { status: 'MISSED', finished_at: now, summary_json: JSON.stringify({ missed: true, reason: 'اليوم خلص قبل الاعتماد — مفيش تنفيذ متأخر تلقائي' }) } }); if (r.count) { out.missed.push(p.id); await audit({ planId: p.id, note: 'الخطة فاتت (MISSED) — مفيش تنفيذ متأخر تلقائي', data: { action: 'MISSED' } }); await notify(p, { severity: 'WARNING', title: `جدول ${p.type === 'OPEN' ? 'الفتح' : 'الإيقاف'} فات من غير اعتماد`, message: 'ما اتنفذش أي حاجة. هيتجهز جدول جديد في موعده.', suffix: 'missed' }); } }
  return out;
}

// =====================================================================================================================
// reading: dashboard / popup / one plan
// =====================================================================================================================
export async function getPlanById(id) { const p = await prisma.ambDailyPlan.findUnique({ where: { id: Number(id) }, include: { items: { orderBy: { rank: 'asc' } } } }); return p ? shapePlan(p, p.items) : null; }
export async function planAudit(planId, limit = 300) {
  const rows = await prisma.ambOperatorEvent.findMany({ where: { kind: { in: ['DAILY_PLAN', 'DAILY_PLAN_ITEM'] }, data_json: { contains: `"planId":${Number(planId)},` } }, orderBy: { id: 'asc' }, take: limit });
  return rows.map((e) => ({ id: e.id, kind: e.kind, actor: e.actor, actorId: e.actor_id, note: e.note, campaignId: e.campaign_id, data: j(e.data_json, {}), at: e.created_at }));
}
async function plansOfDay(date, simulated) {
  const out = {}; for (const type of Object.keys(SLOTS)) { const p = await latestVersion(planKey(type, date, simulated)); out[type] = p ? shapePlan(p, p.items) : null; } return out;
}
/** Everything the tab needs: today's two plans, the dashboard numbers, the next due slot, the last plan, the external-schedule warning. */
export async function getDailyOverview({ now = new Date(), simulated = isTestClock() } = {}) {
  const date = cairoDate(now); const plans = await plansOfDay(date, simulated); const dcfg = await getDailyPlanConfig(); const cfg = await getOperatorConfig();
  const next = Object.keys(SLOTS).map((t) => ({ type: t, ...nextDue(t, now) })).sort((a, b) => a.at - b.at)[0];
  const cur = Object.values(plans).filter(Boolean);
  const sumBudget = (p) => p.items.filter((i) => i.selected).reduce((t, i) => t + (Number(i.evidence?.budget) || 0), 0);
  const last = await prisma.ambDailyPlan.findFirst({ where: { simulated, status: { in: ['COMPLETED', 'MISSED', 'CANCELLED'] } }, orderBy: { id: 'desc' } });
  const external = await detectExternalSchedule({});
  return {
    now, cairo: cairoParts(now), date, testClock: isTestClock(), plans,
    dashboard: {
      openProposed: plans.OPEN?.items.length ?? 0, pauseProposed: plans.PAUSE?.items.length ?? 0, selected: cur.reduce((t, p) => t + p.counts.selected, 0), protectedCount: cur.reduce((t, p) => t + p.counts.protected, 0),
      plannedOpenBudget: plans.OPEN ? Math.round(sumBudget(plans.OPEN)) : 0, plannedPauseBudget: plans.PAUSE ? Math.round(sumBudget(plans.PAUSE)) : 0,
      risk: cur.length ? (cur.some((p) => p.items.some((i) => i.selected && i.risk === 'HIGH')) ? 'HIGH' : cur.some((p) => p.items.some((i) => i.selected && i.risk === 'MEDIUM')) ? 'MEDIUM' : 'LOW') : null,
      nextDue: { type: next.type, label: TYPE_LABEL_AR[next.type], date: next.date, at: next.at }, lastPlan: last ? { id: last.id, type: last.type, date: last.plan_date, status: last.status, summary: j(last.summary_json, null) } : null,
    },
    control: { mode: cfg.mode, emergencyStop: cfg.emergency_stop, writesLocked: metaWritesLocked(), halted: dcfg.halted, allowOpen: dcfg.allowOpen, allowPause: dcfg.allowPause, scheduledExecution: dcfg.scheduledExecution.enabled, spacingSeconds: dcfg.spacingSeconds, staleMinutes: dcfg.staleMinutes },
    externalSchedule: external,
    notifications: { inApp: true, external: false, note: 'القناة المفعّلة الوحيدة: تنبيهات السيستم (🔔). مفيش قناة خارجية (Telegram/WhatsApp/Email) مفعّلة لسه.' },
  };
}
/** Popup source of truth (the browser only POLLS this): the DUE plans nobody has reviewed/dismissed yet — also after a later reopen. */
export async function getDuePopups({ now = new Date(), simulated = isTestClock() } = {}) {
  const date = cairoDate(now); const out = [];
  for (const d of dueTypes(now)) {
    const p = await latestVersion(planKey(d.type, d.date, simulated)); if (!p) { out.push({ type: d.type, date: d.date, preparing: true }); continue; }
    if (['PREPARED', 'APPROVED', 'RUNNING'].includes(p.status) && !p.dismissed_at) out.push({ type: d.type, date, planId: p.id, status: p.status, plan: shapePlan(p, p.items) });
  }
  return out;
}
export async function dismissPopup({ planId, userId = null }) {
  const r = await prisma.ambDailyPlan.updateMany({ where: { id: Number(planId), dismissed_at: null }, data: { dismissed_at: new Date() } });
  if (r.count) await audit({ planId, userId, note: 'الـPopup اتقفل/اتراجع — الجدول لسه محفوظ في مركز التشغيل اليومي', data: { action: 'DISMISSED' } });
  return { ok: true, dismissed: r.count === 1 };
}
/** Preview Tomorrow: the open / pause candidates as they look NOW (never stored, never executes). */
export async function previewTomorrow({ now = new Date(), deps = {} } = {}) {
  const date = cairoDate(new Date(now.getTime() + 24 * MS_H)); const out = { date, asOf: now };
  for (const type of ['OPEN', 'PAUSE']) { const b = await (deps.build ? deps.build({ type, now }) : (type === 'OPEN' ? buildOpenCandidates({ now, deps: deps.candidates || {} }) : buildPauseCandidates({ now, deps: deps.candidates || {} }))); out[type] = { count: b.items.length, selected: b.items.filter((i) => i.selected).length, top: b.items.slice(0, 8).map((i) => ({ campaignName: i.campaignName, rank: i.rank, risk: i.risk, selected: i.selected, reason: i.reason })) }; }
  return out;
}
/** Is something outside this system opening / pausing campaigns on a fixed daily schedule (a Meta automated rule / a routine)? Recognised from the recurring status-change pattern of the last 7 days.
 *  The scan reads a week of snapshots, so it is cached for 15 minutes and computed in the BACKGROUND: opening the screen never waits for it (the first call answers {pending:true}). */
let extCache = null, extRun = null;
async function computeExternalSchedule() {
  try {
    const { detectManualChanges } = await import('./manualChangeDetector.js');
    const r = await detectManualChanges({ now: new Date(), lookbackHours: 24, record: false });
    const rec = r?.recurringSchedule || { changes: 0, entities: 0 };
    return { detected: rec.changes >= 3 && rec.entities >= 2, changes: rec.changes, campaigns: rec.entities, note: rec.changes >= 3 ? 'فيه نمط فتح/إيقاف يومي ثابت التوقيت على حملات كتير (Meta rule أو روتين). لازم تعطله قبل تفعيل التنفيذ المجدول عشان ما يتعارضش مع الجدولين.' : null, checkedAt: new Date().toISOString() };
  } catch (e) { return { detected: null, error: String(e.message).split(String.fromCharCode(10)).filter(Boolean).pop()?.slice(0, 160) }; }
}
export async function detectExternalSchedule({ wait = false, maxAgeMs = 15 * MS_M } = {}) {
  if (extCache && Date.now() - extCache.at < maxAgeMs && !extCache.v.error) return extCache.v;
  if (!extRun) extRun = computeExternalSchedule().then((v) => { extCache = { at: Date.now(), v }; return v; }).finally(() => { extRun = null; });
  if (wait) return extRun;
  return extCache?.v || { detected: null, pending: true };
}

// =====================================================================================================================
// owner actions: selection (versioned), exclusions, protection, cancel
// =====================================================================================================================
export async function updateSelection({ planId, selections, special = [], userId, now = new Date() }) {
  const plan = await prisma.ambDailyPlan.findUnique({ where: { id: Number(planId) }, include: { items: { orderBy: { rank: 'asc' } } } });
  if (!plan) { const e = new Error('الخطة غير موجودة.'); e.status = 404; throw e; }
  const latest = await prisma.ambDailyPlan.findFirst({ where: { plan_key: plan.plan_key }, orderBy: { version: 'desc' } });
  if (latest.id !== plan.id) { const e = new Error('دي نسخة قديمة من الخطة — اشتغل على آخر نسخة.'); e.status = 409; throw e; }
  if (['RUNNING', 'COMPLETED', 'CANCELLED', 'SUPERSEDED', 'MISSED'].includes(plan.status)) { const e = new Error(`الخطة ${plan.status} — مش قابلة للتعديل.`); e.status = 409; throw e; }
  const changes = []; const byId = new Map(plan.items.map((i) => [i.campaign_id, i]));
  for (const [cid, want] of Object.entries(selections || {})) { const it = byId.get(cid); if (!it) continue; const v = !!want; if (v && !it.selectable) { const e = new Error(`الحملة ${it.campaign_name || cid} ممنوعة/محمية — مينفعش تتختار.`); e.status = 400; throw e; } if (v && it.eligibility === 'NEEDS_SPECIAL_APPROVAL' && !(special || []).includes(cid)) { const e = new Error(`الحملة ${it.campaign_name || cid} اتوقفت لسبب غير معروف/يدويًا — محتاجة موافقة خاصة صريحة قبل اختيارها.`); e.status = 400; e.code = 'SPECIAL_APPROVAL_REQUIRED'; throw e; } if (it.selected !== v) changes.push({ campaignId: cid, name: it.campaign_name, from: it.selected, to: v, ...(v && it.eligibility === 'NEEDS_SPECIAL_APPROVAL' ? { specialApproval: true } : {}) }); }
  if (!changes.length) return { plan: shapePlan(plan, plan.items), changed: 0, newVersion: false };
  if (plan.status === 'PREPARED') {
    for (const c of changes) await prisma.ambDailyPlanItem.updateMany({ where: { plan_id: plan.id, campaign_id: c.campaignId }, data: { selected: c.to } });
    await audit({ planId: plan.id, userId, note: `تعديل اختيارات (${changes.length})`, data: { action: 'SELECTION', version: plan.version, changes } });
    const fresh = await prisma.ambDailyPlan.findUnique({ where: { id: plan.id }, include: { items: { orderBy: { rank: 'asc' } } } });
    return { plan: shapePlan(fresh, fresh.items), changed: changes.length, newVersion: false };
  }
  // APPROVED (scheduled) => never edit what was approved: a NEW version, the approved one is SUPERSEDED and cannot run
  const next = await prisma.$transaction(async (tx) => {
    const sup = await tx.ambDailyPlan.updateMany({ where: { id: plan.id, status: 'APPROVED' }, data: { status: 'SUPERSEDED', finished_at: now } }); if (sup.count !== 1) { const e = new Error('الخطة اتغيّرت في نفس اللحظة.'); e.status = 409; throw e; }
    const want = new Map(changes.map((c) => [c.campaignId, c.to]));
    return tx.ambDailyPlan.create({ data: { plan_key: plan.plan_key, type: plan.type, plan_date: plan.plan_date, timezone: plan.timezone, version: plan.version + 1, status: 'PREPARED', simulated: plan.simulated, scheduled_at: plan.scheduled_at, expires_at: plan.expires_at, prepared_at: now, data_as_of: plan.data_as_of, data_state: plan.data_state, surfaced_at: plan.surfaced_at, evidence_json: plan.evidence_json,
      items: { create: plan.items.map((i) => ({ campaign_id: i.campaign_id, campaign_name: i.campaign_name, product_id: i.product_id, product_name: i.product_name, store_id: i.store_id, rank: i.rank, selected: want.has(i.campaign_id) ? want.get(i.campaign_id) : i.selected, selectable: i.selectable, eligibility: i.eligibility, block_codes_json: i.block_codes_json, risk: i.risk, risk_score: i.risk_score, evidence_json: i.evidence_json, reason: i.reason })) } }, include: { items: { orderBy: { rank: 'asc' } } } });
  });
  await audit({ planId: next.id, userId, note: `نسخة جديدة v${next.version} بعد تعديل خطة معتمدة — لازم تتعتمد من جديد، والنسخة القديمة اتلغت`, data: { action: 'NEW_VERSION', from: plan.version, to: next.version, supersededPlanId: plan.id, changes } });
  return { plan: shapePlan(next, next.items), changed: changes.length, newVersion: true };
}
export async function excludeCampaign({ campaignId, scope = 'DAY', userId, now = new Date(), label = null }) {
  if (!['DAY', 'ALWAYS'].includes(scope)) { const e = new Error('scope لازم DAY أو ALWAYS.'); e.status = 400; throw e; }
  const hoursLeft = Math.max(1, Math.min(23, Math.ceil((expiresAt(cairoDate(now)).getTime() - now.getTime()) / MS_H)));
  const exc = await addException({ scopeType: 'CAMPAIGN', scopeId: campaignId, scopeLabel: label, types: ['NO_AUTO_OPEN', 'NO_AUTO_STOP'], reason: scope === 'DAY' ? 'DAILY_PLAN_EXCLUDED_TODAY' : 'DAILY_PLAN_EXCLUDED_ALWAYS', ttlHours: scope === 'DAY' ? hoursLeft : null, userId });
  const open = await prisma.ambDailyPlan.findMany({ where: { status: 'PREPARED' }, select: { id: true } });
  if (open.length) await prisma.ambDailyPlanItem.updateMany({ where: { plan_id: { in: open.map((p) => p.id) }, campaign_id: campaignId }, data: { selected: false, selectable: false, eligibility: 'PROTECTED' } });
  await audit({ userId, campaignId, note: scope === 'DAY' ? 'استبعاد الحملة لليوم' : 'استبعاد الحملة دائمًا', data: { action: 'EXCLUDE', scope, exceptionId: exc?.id ?? null } });
  return { ok: true, scope };
}
export async function protectWinner({ campaignId, userId, label = null }) {
  const exc = await addException({ scopeType: 'CAMPAIGN', scopeId: campaignId, scopeLabel: label, types: ['NO_AUTO_STOP'], reason: 'WINNER_PROTECTED', userId });
  await prisma.ambDailyPlanItem.updateMany({ where: { campaign_id: campaignId, plan: { status: 'PREPARED', type: 'PAUSE' } }, data: { selected: false, selectable: false, eligibility: 'PROTECTED' } });
  await audit({ userId, campaignId, note: 'حماية Winner من الإيقاف', data: { action: 'PROTECT_WINNER', exceptionId: exc?.id ?? null } });
  return { ok: true };
}
export async function cancelPlan({ planId, userId, reason = null, now = new Date() }) {
  const r = await prisma.ambDailyPlan.updateMany({ where: { id: Number(planId), status: { in: ['PREPARED', 'APPROVED', 'RUNNING'] } }, data: { status: 'CANCELLED', finished_at: now, summary_json: JSON.stringify({ cancelled: true, reason: reason || 'ألغاها المستخدم' }) } });
  if (!r.count) { const e = new Error('الخطة مش قابلة للإلغاء.'); e.status = 409; throw e; }
  await audit({ planId, userId, note: `إلغاء الخطة${reason ? ': ' + reason : ''}`, data: { action: 'CANCELLED', reason } });
  return { ok: true };
}

// =====================================================================================================================
// approve + execute
// =====================================================================================================================
/** The gate that decides SIMULATION vs LIVE for a plan. Returns {mode:'SIMULATION'|'LIVE', blocked?:{code,message}}. SHADOW/OFF => always SIMULATION (no write path exists). */
export function executionGate({ config, dcfg, type, simulatedPlan }) {
  if (config.emergency_stop) return { blocked: { code: 'EMERGENCY_STOP', message: 'إيقاف الطوارئ مفعّل.' } };
  if (dcfg.halted) return { blocked: { code: 'QUEUE_HALTED', message: 'الطابور موقوف (Kill Switch).' } };
  if (simulatedPlan) return { mode: 'SIMULATION' };
  if (config.mode === 'SHADOW' || config.mode === 'OFF') return { mode: 'SIMULATION' };
  if (config.mode !== 'APPROVAL') return { blocked: { code: config.mode === 'AUTOPILOT' ? 'AUTOPILOT_NOT_ALLOWED_HERE' : 'MODE_NOT_APPROVAL', message: `الوضع ${config.mode} — التنفيذ الفعلي للجداول بيحتاج وضع APPROVAL.` } };
  if (config.writesLocked) return { blocked: { code: 'META_WRITES_LOCKED', message: 'كتابة Meta مقفولة على مستوى النشر (OPERATOR_ALLOW_META_WRITES).' } };
  if (!(type === 'OPEN' ? dcfg.allowOpen : dcfg.allowPause)) return { blocked: { code: 'TYPE_NOT_ALLOWED', message: `صلاحية ${type === 'OPEN' ? 'فتح' : 'إيقاف'} الحملات بالتنفيذ المجدول لسه ما اتمنحتش من ADMIN.` } };
  return { mode: 'LIVE' };
}
async function requireAdmin(userId, deps = {}) {
  const u = deps.user || await prisma.user.findUnique({ where: { id: Number(userId) }, select: { id: true, role: true, status: true } });
  if (!u || u.role !== 'ADMIN' || u.status !== 'ACTIVE') { const e = new Error('اعتماد وتنفيذ جدول التشغيل محتاج موافقة ADMIN صريحة.'); e.status = 403; throw e; }
  return u;
}
export async function approvePlan({ planId, userId, now = new Date(), deps = {} }) {
  if (!userId) { const e = new Error('لازم مستخدم معتمد.'); e.status = 400; throw e; }
  await requireAdmin(userId, deps);
  const plan = await prisma.ambDailyPlan.findUnique({ where: { id: Number(planId) }, include: { items: { orderBy: { rank: 'asc' } } } });
  if (!plan) { const e = new Error('الخطة غير موجودة.'); e.status = 404; throw e; }
  const latest = await prisma.ambDailyPlan.findFirst({ where: { plan_key: plan.plan_key }, orderBy: { version: 'desc' } });
  if (latest.id !== plan.id) { const e = new Error('دي نسخة قديمة — اعتمد آخر نسخة.'); e.status = 409; throw e; }
  if (plan.status !== 'PREPARED') return { ok: false, status: plan.status, message: `الخطة ${plan.status} — مش قابلة للاعتماد.` };
  if (now.getTime() >= plan.expires_at.getTime()) { await prisma.ambDailyPlan.updateMany({ where: { id: plan.id, status: 'PREPARED' }, data: { status: 'MISSED', finished_at: now, summary_json: JSON.stringify({ missed: true, reason: 'اليوم خلص قبل الاعتماد — مفيش تنفيذ متأخر تلقائي' }) } }); await audit({ planId: plan.id, userId, note: 'الاعتماد بعد انتهاء اليوم — الخطة MISSED', data: { action: 'MISSED' } }); return { ok: false, status: 'MISSED', message: 'اليوم خلص — الخطة فاتت ومش بتتنفذ متأخر.' }; }
  const selected = plan.items.filter((i) => i.selected);
  let dataState = plan.data_state, dataAsOf = plan.data_as_of;
  if (dataState === 'STALE' || !dataAsOf || Date.now() - new Date(dataAsOf).getTime() > (await getDailyPlanConfig()).staleMinutes * MS_M) {
    const f = await ensureFreshData({ now, deps }); dataState = f.state; dataAsOf = f.asOf; await prisma.ambDailyPlan.update({ where: { id: plan.id }, data: { data_state: f.state, data_as_of: f.asOf } });
    if (f.state === 'STALE') return { ok: false, status: 'STALE_DATA', message: 'بيانات Meta قديمة (STALE) — مفيش اعتماد/تنفيذ على بيانات غير موثوقة. حدّث وجرّب تاني.', staleReason: f.error };
    // the data moved while the plan was waiting: the ranking can shift, so the owner must review again (selections stay, nothing executes)
  }
  if (!selected.length) return { ok: false, status: 'EMPTY', message: 'مفيش حملة مختارة.' };
  const config = await (deps.config ? deps.config() : getOperatorConfig()); const dcfg = deps.dcfg || await getDailyPlanConfig();
  const gate = executionGate({ config, dcfg, type: plan.type, simulatedPlan: plan.simulated });
  const early = now.getTime() < plan.scheduled_at.getTime();
  if (early && !dcfg.scheduledExecution.enabled) return { ok: false, status: 'NOT_DUE_YET', message: 'لسه ما جاش موعد الجدول. الاعتماد المبكر محتاج تفعيل "التنفيذ المجدول" صراحة (مقفول).' };
  if (gate.blocked) { await audit({ planId: plan.id, userId, note: `الاعتماد اتمنع: ${gate.blocked.code}`, data: { action: 'APPROVE_BLOCKED', code: gate.blocked.code } }); return { ok: false, status: 'BLOCKED', blocked: gate.blocked.code, message: gate.blocked.message }; }
  const claim = await prisma.ambDailyPlan.updateMany({ where: { id: plan.id, status: 'PREPARED' }, data: { status: 'APPROVED', approved_by_id: userId, approved_at: now, approval_mode: config.mode, execution_mode: gate.mode, dismissed_at: plan.dismissed_at || now } });
  if (claim.count !== 1) return { ok: false, status: 'RACE', message: 'الخطة اتغيّرت في نفس اللحظة.' };
  await audit({ planId: plan.id, userId, note: `الخطة اتعتمدت (${selected.length} حملة) — تنفيذ ${gate.mode === 'LIVE' ? 'فعلي' : 'تجريبي (SHADOW، مفيش كتابة على Meta)'}`, data: { action: 'APPROVED', version: plan.version, mode: config.mode, executionMode: gate.mode, selected: selected.map((i) => i.campaign_id) } });
  await notify(plan, { title: `اتعتمد جدول ${plan.type === 'OPEN' ? 'الفتح' : 'الإيقاف'} (${selected.length} حملة)`, message: gate.mode === 'LIVE' ? 'التنفيذ هيبدأ واحدة واحدة.' : 'SHADOW: تنفيذ تجريبي بدون أي كتابة على Meta.', suffix: 'approved' });
  if (early) return { ok: true, status: 'APPROVED', scheduled: true, executionMode: gate.mode, planId: plan.id, message: 'الخطة معتمدة ومجدولة لموعدها.' };
  const run = runPlanExecution({ planId: plan.id, userId, now, deps });
  if (deps.runInline) { const r = await run; return { ok: true, status: 'RUNNING', executionMode: gate.mode, planId: plan.id, result: r }; }
  run.catch((e) => logger.error('[dailyPlans] execution crashed', { planId: plan.id, message: e.message }));
  return { ok: true, status: 'RUNNING', executionMode: gate.mode, planId: plan.id };
}

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));
async function setItem(item, status, reason, extra = {}, planId, userId = null) {
  const from = item.status; await prisma.ambDailyPlanItem.update({ where: { id: item.id }, data: { status, status_reason: reason ? String(reason).slice(0, 480) : null, status_at: new Date(), ...extra } });
  item.status = status; await audit({ planId, kind: 'DAILY_PLAN_ITEM', userId, campaignId: item.campaign_id, note: `${from} → ${status}${reason ? ': ' + reason : ''}`, data: { action: 'ITEM', itemId: item.id, from, to: status, reason: reason || null }, actor: 'SYSTEM' });
}
async function defaultReadEntity(campaignId) {
  const [{ getEntity }, token] = await Promise.all([import('../metaGraphClient.js'), getDecryptedToken()]);
  const e = await getEntity(token, campaignId, 'id,name,status,effective_status,daily_budget,lifetime_budget');
  const d = Number(e.daily_budget); return { id: e.id, status: e.effective_status || e.status || null, budget: Number.isFinite(d) ? d / 100 : null };
}
/** Revalidation of ONE item against live Meta + the current state. Returns {ok, status?, reason?, live?}. */
async function revalidateItem({ plan, item, config, dcfg, deps, now }) {
  if (config.emergency_stop) return { ok: false, status: 'BLOCKED', reason: 'EMERGENCY_STOP' };
  if (dcfg.halted) return { ok: false, status: 'SKIPPED', reason: 'QUEUE_HALTED' };
  const fresh = await prisma.ambDailyPlan.findUnique({ where: { id: plan.id }, select: { status: true } });
  if (!fresh || fresh.status !== 'RUNNING') return { ok: false, status: 'SKIPPED', reason: `PLAN_${fresh?.status || 'GONE'}` };
  const ev = j(item.evidence_json, {});
  if (ev.mapping && ev.mapping !== 'VERIFIED') return { ok: false, status: 'BLOCKED', reason: `MAPPING_${ev.mapping}` };
  const mapState = await (deps.mappingState ? deps.mappingState(item.campaign_id) : null); if (mapState && mapState !== 'VERIFIED') return { ok: false, status: 'BLOCKED', reason: `MAPPING_${mapState}` };
  const manual = await prisma.ambOperatorEvent.count({ where: { kind: 'MANUAL_OVERRIDE', campaign_id: item.campaign_id, created_at: { gt: plan.prepared_at } } });
  if (manual) return { ok: false, status: 'SKIPPED', reason: 'MANUAL_OVERRIDE_AFTER_PREPARED' };
  const excs = deps.exceptions ? await deps.exceptions(item.campaign_id) : (await import('./operatorStore.js').then((m) => m.listExceptions({ now }))).filter((e) => e.scope_type === 'CAMPAIGN' && e.scope_id === item.campaign_id);
  if (excs.some((e) => (e.types || []).some((t) => ['NO_AUTOMATION', plan.type === 'OPEN' ? 'NO_AUTO_OPEN' : 'NO_AUTO_STOP'].includes(t)))) return { ok: false, status: 'BLOCKED', reason: plan.type === 'OPEN' ? 'EXCEPTION_NO_AUTO_OPEN' : 'EXCEPTION_NO_AUTO_STOP' };
  if (plan.type === 'OPEN' && ev.stock?.status === 'OUT_OF_STOCK') return { ok: false, status: 'BLOCKED', reason: 'STOCK_OUT' };
  if (plan.type === 'PAUSE') { const lp = await (deps.lastPurchase ? deps.lastPurchase(item.campaign_id) : (await import('./operatorContext.js')).computeLastPurchaseAt({ campaignId: item.campaign_id, now }).catch(() => null)); const rp = Number(config.limits?.recentPurchaseProtectionHours ?? 3); if (lp && now.getTime() - new Date(lp).getTime() < rp * MS_H) return { ok: false, status: 'SKIPPED', reason: `RECENT_PURCHASE (${Math.round((now.getTime() - new Date(lp).getTime()) / MS_M)} دقيقة)` }; }
  const other = await prisma.ambDailyPlanItem.findFirst({ where: { campaign_id: item.campaign_id, selected: true, plan: { plan_date: plan.plan_date, simulated: plan.simulated, type: plan.type === 'OPEN' ? 'PAUSE' : 'OPEN', status: { in: ['APPROVED', 'RUNNING'] } } }, select: { id: true } });
  if (other) return { ok: false, status: 'BLOCKED', reason: 'CONFLICT_OPEN_AND_PAUSE' };
  let live; try { live = await (deps.readEntity || defaultReadEntity)(item.campaign_id); } catch (e) { return { ok: false, status: 'SKIPPED', reason: e.isMetaRateLimit ? 'META_RATE_LIMITED' : `META_UNAVAILABLE: ${String(e.message).slice(0, 120)}`, retryable: !!e.isMetaRateLimit }; }
  if (!live || live.id !== item.campaign_id) return { ok: false, status: 'BLOCKED', reason: 'CAMPAIGN_ID_MISMATCH' };
  if (plan.type === 'OPEN' && live.status === 'ACTIVE') return { ok: false, status: 'SKIPPED', reason: 'ALREADY_ACTIVE' };
  if (plan.type === 'OPEN' && live.status !== 'PAUSED') return { ok: false, status: 'SKIPPED', reason: `LIVE_STATUS_${live.status}` };
  if (plan.type === 'PAUSE' && live.status !== 'ACTIVE') return { ok: false, status: 'SKIPPED', reason: live.status === 'PAUSED' ? 'ALREADY_PAUSED' : `LIVE_STATUS_${live.status}` };
  return { ok: true, live };
}
export async function runPlanExecution({ planId, userId = null, now = new Date(), deps = {} }) {
  const sleep = deps.sleep || sleepDefault;
  const claim = await prisma.ambDailyPlan.updateMany({ where: { id: Number(planId), status: 'APPROVED', OR: [{ lock_until: null }, { lock_until: { lt: now } }] }, data: { status: 'RUNNING', started_at: now, lock_owner: INSTANCE, lock_until: new Date(now.getTime() + 30 * MS_M) } });
  if (claim.count !== 1) return { skipped: 'NOT_CLAIMED' };
  const plan = await prisma.ambDailyPlan.findUnique({ where: { id: Number(planId) }, include: { items: { orderBy: { rank: 'asc' } } } });
  const items = plan.items.filter((i) => i.selected); const live = plan.execution_mode === 'LIVE'; const dcfg = deps.dcfg || await getDailyPlanConfig();
  const spacing = Math.max(3, Number(dcfg.spacingSeconds) || 3) * 1000; let rateLimited = 0, sent = 0, abort = null;
  for (const item of items) {
    if (ITEM_FINAL.has(item.status)) continue;
    if (abort) { await setItem(item, 'SKIPPED', abort, {}, plan.id, userId); continue; }
    const config = await (deps.config ? deps.config() : getOperatorConfig());
    await setItem(item, 'REVALIDATING', null, { attempts: { increment: 1 } }, plan.id, userId);
    const v = await revalidateItem({ plan, item, config, dcfg: deps.dcfg || await getDailyPlanConfig(), deps, now: deps.now ? deps.now() : new Date() });
    if (!v.ok) { await setItem(item, v.status, v.reason, {}, plan.id, userId); if (v.reason === 'META_RATE_LIMITED') { rateLimited++; await sleep(Math.min(120_000, 15_000 * 2 ** rateLimited)); if (rateLimited >= dcfg.rateLimitStopAfter) abort = 'RATE_LIMIT_STOP'; } continue; }
    if (!live) { await setItem(item, 'SIMULATED', `SHADOW: كان هيتبعت ${plan.type === 'OPEN' ? 'RESUME (status=ACTIVE)' : 'PAUSE (status=PAUSED)'} — مفيش كتابة على Meta (الحالة الحية ${v.live.status})`, {}, plan.id, userId); continue; }
    // ---- LIVE: spacing + ONE write through the existing executor + read-back
    if (sent > 0) await sleep(spacing);
    await setItem(item, 'SENT', 'الطلب اتبعت لـMeta (مستني القراءة بعده)', {}, plan.id, userId); sent++;
    const r = await liveExecuteItem({ plan, item, userId, deps });
    await setItem(item, r.status, r.reason, r.extra || {}, plan.id, userId);
    if (r.rateLimited) { rateLimited++; await sleep(Math.min(120_000, 15_000 * 2 ** rateLimited)); if (rateLimited >= dcfg.rateLimitStopAfter) abort = 'RATE_LIMIT_STOP'; }
  }
  const finalItems = await prisma.ambDailyPlanItem.findMany({ where: { plan_id: plan.id, selected: true } });
  const cnt = (s) => finalItems.filter((i) => i.status === s).length; const byReason = {}; for (const i of finalItems.filter((x) => ['SKIPPED', 'BLOCKED', 'FAILED', 'UNCERTAIN'].includes(x.status))) byReason[i.status_reason || i.status] = (byReason[i.status_reason || i.status] || 0) + 1;
  const summary = { executionMode: plan.execution_mode, selected: finalItems.length, verified: cnt('VERIFIED'), simulated: cnt('SIMULATED'), failed: cnt('FAILED'), skipped: cnt('SKIPPED'), blocked: cnt('BLOCKED'), uncertain: cnt('UNCERTAIN'), byReason, actuallyChanged: cnt('VERIFIED'), notChanged: finalItems.length - cnt('VERIFIED'), metaWrites: sent };
  const end = await prisma.ambDailyPlan.updateMany({ where: { id: plan.id, status: 'RUNNING' }, data: { status: 'COMPLETED', finished_at: new Date(), summary_json: JSON.stringify(summary), lock_until: null, lock_owner: null } });
  if (end.count) { await audit({ planId: plan.id, userId, note: `انتهى التنفيذ — ${summary.executionMode === 'LIVE' ? `${summary.verified} اتأكد من Meta` : `${summary.simulated} محاكاة (مفيش كتابة)`}، ${summary.skipped + summary.blocked} متخطي/ممنوع، ${summary.failed} فشل`, data: { action: 'COMPLETED', summary } });
    await notify(plan, { severity: summary.failed || summary.uncertain ? 'WARNING' : 'INFO', title: `ملخص ${plan.type === 'OPEN' ? 'خطة الفتح' : 'خطة الإيقاف'}`, message: summary.executionMode === 'LIVE' ? `${plan.type === 'OPEN' ? 'اتفتحت' : 'اتقفلت'} فعليًا ${summary.verified} من ${summary.selected}. ${summary.notChanged ? 'الباقي لم يتغيّر — راجع الأسباب في الجدول.' : ''}` : `SHADOW (تجريبي): ${summary.simulated} من ${summary.selected} كانوا هيتنفذوا. مفيش أي كتابة على Meta.`, suffix: 'summary' }); }
  return summary;
}
/** One LIVE order through the existing executor; an error AFTER the request may have gone out is resolved by an independent read, never by a blind re-POST. */
async function liveExecuteItem({ plan, item, userId, deps }) {
  const action = plan.type === 'OPEN' ? 'RESUME' : 'PAUSE'; const target = plan.type === 'OPEN' ? 'ACTIVE' : 'PAUSED'; const prev = plan.type === 'OPEN' ? 'PAUSED' : 'ACTIVE';
  const ev = j(item.evidence_json, {}); const conn = await getConnection();
  const rec = await prisma.ambRecommendation.create({ data: { batch_id: `daily-plan-${plan.id}`, ad_account_id: conn?.selected_ad_account_id || 'UNKNOWN', amb_product_id: null, product_name: item.product_name, level: 'campaign', entity_id: item.campaign_id, entity_name: item.campaign_name, campaign_id: item.campaign_id, campaign_name: item.campaign_name, decision: action === 'RESUME' ? 'SCALE' : 'PAUSE_LOSER', action_type: action, executable: true,
    current_metrics_json: JSON.stringify({ spend: ev.m7?.spend ?? null, cpa: ev.m7?.cpa ?? null, purchases: ev.m7?.purchases ?? null }), reason: `Daily Plan #${plan.id} v${plan.version} (${plan.type}) — ${item.reason || ''}`.slice(0, 900), reason_facts_json: item.evidence_json, confidence: 'MEDIUM', risk_level: item.risk || 'MEDIUM', data_sufficiency: 'MODERATE', priority: 'P2', time_window_label: 'آخر 7 أيام', source: 'OPERATOR', status: 'PENDING' } });
  const exec = deps.approveAndExecute || (await import('./executor.js')).approveAndExecute; let result = null, err = null;
  try { result = await exec({ recId: rec.id, userId, mode: 'APPROVAL' }); } catch (e) { err = e; }
  const act = await prisma.ambAction.findFirst({ where: { recommendation_id: rec.id }, orderBy: { id: 'desc' } }); const verify = j(act?.verify_json, null);
  const extra = { amb_action_id: act?.id ?? null };
  if (!err && result?.ok) return verify?.verified ? { status: 'VERIFIED', reason: `اتأكد من قراءة Meta: ${prev} → ${target}`, extra } : { status: 'UNCERTAIN', reason: 'الطلب اتبعت لكن القراءة الفورية ما أكدتش — مش هنعيد الإرسال أعمى', extra };
  if (result?.aborted) return { status: 'BLOCKED', reason: `الـexecutor رفض قبل الإرسال: ${result.message}`, extra };
  // an error: did a request go out? (the executor records the request before sending) — ask Meta, never re-POST
  const rate = !!err?.isMetaRateLimit || /rate limit|too many calls/i.test(err?.message || '');
  if (act?.meta_request_json) { let rb = null; try { rb = await (deps.readBack || defaultReadBackStatus)({ campaignId: item.campaign_id }); } catch { rb = null; }
    if (rb?.status === target) return { status: 'VERIFIED', reason: `Meta طبّقت التغيير (قراءة مستقلة بعد خطأ الـexecutor): ${prev} → ${target}`, extra, rateLimited: rate };
    if (rb?.status === prev) return { status: 'FAILED', reason: `التغيير ما اتطبقش (القراءة المستقلة: ${rb.status}) — ${err?.message || result?.message || ''}`.slice(0, 300), extra, rateLimited: rate };
    return { status: 'UNCERTAIN', reason: 'الطلب ممكن يكون خرج وما قدرناش نقرأ Meta بعده — راجع الحملة يدويًا (مفيش إعادة إرسال)', extra, rateLimited: rate }; }
  return { status: 'FAILED', reason: (err?.message || result?.message || 'فشل التنفيذ').slice(0, 300), extra, rateLimited: rate };
}
async function defaultReadBackStatus({ campaignId }) { const e = await defaultReadEntity(campaignId); return { status: e.status }; }

// =====================================================================================================================
// the SERVER scheduler (one timer, atomic claims = the lock; the browser only polls)
// =====================================================================================================================
let ticking = false;
export async function runDailyPlanTick({ now = clockNow(), deps = {} } = {}) {
  if (ticking) return { skipped: 'ALREADY_TICKING' }; ticking = true;
  try {
    const sim = isTestClock(); const out = await ensureDuePlans({ now, simulated: sim, deps });
    const dcfg = await getDailyPlanConfig();
    if (dcfg.scheduledExecution.enabled && !sim) { // unattended execution of plans approved ahead of time — only when explicitly enabled
      const due = await prisma.ambDailyPlan.findMany({ where: { simulated: false, status: 'APPROVED', scheduled_at: { lte: now }, expires_at: { gt: now } } });
      out.executed = []; for (const p of due) { out.executed.push(await runPlanExecution({ planId: p.id, userId: p.approved_by_id, now, deps })); }
    }
    return out;
  } finally { ticking = false; }
}
let timer = null;
export function startDailyPlanScheduler() {
  if (timer) return;
  timer = setInterval(() => { runDailyPlanTick({ now: new Date() }).catch((e) => logger.error('[dailyPlans] tick failed', { message: e.message })); }, 60_000);
  timer.unref?.(); logger.info('Daily Operations scheduler started (60s tick, Africa/Cairo: OPEN 00:00 / PAUSE 13:00 — prepares + surfaces plans, never executes by itself)');
}
