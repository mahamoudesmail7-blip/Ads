// 🧪 Budget-decision EXECUTION (owner-approved, ONE decision at a time). 2026-10-07.
//
// The Dynamic Budget Optimizer only ever produced SHADOW rows (rule_id NULL, rule_name 'DYNAMIC_BUDGET:*'): the generic operator executor expires those on purpose.
// This module is the narrow, explicit bridge used for the first END-TO-END approval test:
//
//   Live Meta data -> decision -> guards (in APPROVAL mode) -> owner approval -> Meta write (existing executor) -> read-back verification -> audit -> cooldown
//
// Rules of the bridge (all of them fail CLOSED):
//   * ONE decision per call; no bulk; Autopilot is impossible here (the global mode must be exactly APPROVAL and the call carries a human user id).
//   * Only the actions listed in EXECUTABLE_ACTIONS (the first test = SCALE_DOWN, i.e. a budget REDUCTION; never an increase, never a pause, never an open).
//   * Nothing is sent unless: Emergency Stop is off, mode = APPROVAL, the deployment write-lock is open, AND a fresh live re-evaluation still gives the SAME decision
//     (same entity, same current budget, same proposed budget, no BLOCK guard, evidence not drifted). Anything else EXPIRES the decision — nothing is written to Meta.
//   * The Meta write itself is the existing AMB executor (live revalidation + ONE POST + read-back verify). "Request sent" is never reported as "verified".
//   * The cooldown starts by itself: the executed AmbAction / decision is the entity's "last change" for the optimizer (24h after an increase, 48h after a decrease).
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getOperatorConfig } from './operatorStore.js';
import { evaluateBudgetOptimization, persistBudgetDecisions } from './budgetOptimizer.js';
import { raiseAlert } from './alerts.js';

const MS_H = 3_600_000;
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export const EXECUTABLE_ACTIONS = new Set(['SCALE_DOWN']); // widened ONLY by an explicit owner decision
const AMB_ACTION = { SCALE_DOWN: 'DECREASE_BUDGET', SCALE_UP: 'INCREASE_BUDGET', PAUSE: 'PAUSE' };
const MAX_CPA_DRIFT = 0.30;
const recordEvent = async (data) => { try { await prisma.ambOperatorEvent.create({ data }); } catch (e) { logger.warn('[budgetExecution] event write failed', { message: e.message }); } };
const transition = (decisionId, from, to, { actor = 'USER', actorId = null, note = null, data = null, campaignId = null } = {}) => recordEvent({ decision_id: decisionId, kind: 'TRANSITION', from_status: from, to_status: to, actor, actor_id: actorId, note, data_json: data ? JSON.stringify(data).slice(0, 3000) : null, campaign_id: campaignId });
// Test hook: ONLY honoured when BUDGET_EXECUTION_TEST_HOOK=1 (set by the route test); in production the variable is absent so this is inert. It lets the test drive the REAL routes with a stubbed Meta executor.
let testDeps = null;
export const __setBudgetExecutionTestDeps = (d) => { testDeps = d; };
const effDeps = (deps) => (process.env.BUDGET_EXECUTION_TEST_HOOK === '1' && testDeps ? { ...testDeps, ...deps } : deps);
/** A budget change needs an explicit ADMIN: checked here again (not only at the route) so no other caller can bypass it. */
async function requireAdmin(userId, deps) {
  const u = deps.user || await prisma.user.findUnique({ where: { id: Number(userId) }, select: { id: true, role: true, status: true } });
  if (!u || u.role !== 'ADMIN' || u.status !== 'ACTIVE') { const e = new Error('تنفيذ تغيير ميزانية محتاج موافقة ADMIN صريحة.'); e.status = 403; throw e; }
  return u;
}
const cooldownHoursOf = (action, policy) => (action === 'SCALE_UP' ? policy?.scale?.cooldownHours : policy?.reduce?.cooldownHours) ?? 48;

/**
 * Independent read-back of the entity's CURRENT daily budget (READ only), retrying on Meta's ad-account rate limit. Used ONLY when the executor reports an error although a Meta
 * request may already have gone out (typical case: the write was accepted and the verification read was rate-limited) — so the report states what Meta REALLY holds instead of guessing.
 * Returns {budget, status} or null when Meta cannot be read.
 */
export async function defaultReadBack({ entityId, waitMs = 45_000, tries = 8 }) {
  const [{ getEntity }, { getDecryptedToken }] = await Promise.all([import('../metaGraphClient.js'), import('../metaAuth.js')]);
  const token = await getDecryptedToken();
  for (let i = 0; i < tries; i++) {
    try { const e = await getEntity(token, entityId, 'effective_status,status,daily_budget,lifetime_budget'); const d = Number(e.daily_budget); return { budget: Number.isFinite(d) ? d / 100 : null, status: e.effective_status || e.status || null }; }
    catch (err) { if (!err.isMetaRateLimit) { logger.warn('[budgetExecution] read-back failed', { message: err.message }); return null; } await new Promise((x) => setTimeout(x, waitMs)); }
  }
  return null;
}

/** Config-level refusal reasons (nothing about the decision itself changed, so the decision stays PREPARED). */
export function configBlock(config) {
  if (config.emergency_stop) return { code: 'EMERGENCY_STOP', message: 'إيقاف الطوارئ مفعّل.' };
  if (config.mode !== 'APPROVAL') return { code: config.mode === 'AUTOPILOT' ? 'AUTOPILOT_NOT_ALLOWED_HERE' : 'MODE_NOT_APPROVAL', message: `الوضع الحالي ${config.mode} — التنفيذ بموافقتك محتاج وضع APPROVAL.` };
  if (config.writesLocked) return { code: 'META_WRITES_LOCKED', message: 'كتابة AI Operator على Meta مقفولة على مستوى النشر (OPERATOR_ALLOW_META_WRITES).' };
  return null;
}

/**
 * Re-evaluates ONE campaign on live data in APPROVAL context and persists exactly the actionable row as a PREPARED decision (never touches other decisions).
 * Returns {ok, decisionId, row} or {ok:false, reason, row}. deps.evaluate / deps.config are injectable for tests.
 */
export async function prepareBudgetDecision({ campaignId, userId = null, now = new Date(), deps: depsIn = {} }) {
  const deps = effDeps(depsIn);
  await requireAdmin(userId, deps);
  const config = deps.config || await getOperatorConfig();
  if (config.mode !== 'APPROVAL') return { ok: false, reason: 'MODE_NOT_APPROVAL', message: `الوضع ${config.mode} — التحضير للموافقة محتاج APPROVAL.` };
  const res = await (deps.evaluate || ((o) => evaluateBudgetOptimization(o)))({ now, persist: false, live: true, only: { campaignIds: [campaignId] }, ruleMode: 'APPROVAL' });
  if (res.structureSource !== 'META_LIVE') return { ok: false, reason: 'NO_LIVE_DATA', message: `بنية الميزانية ما اتقرتش لايف من Meta (${res.structureSource}) — مفيش تحضير على بيانات قديمة.` };
  const rows = res.rows.filter((r) => r.campaignId === campaignId && r.intended);
  if (rows.length !== 1) return { ok: false, reason: rows.length ? 'MULTIPLE_ENTITIES' : 'NO_ACTION', message: rows.length ? 'الحملة فيها أكتر من كيان (Ad Sets) بقرار — التنفيذ بيتم على كيان واحد بس.' : 'مفيش قرار ميزانية للحملة دي دلوقتي.', rows: res.rows };
  const row = rows[0];
  if (!EXECUTABLE_ACTIONS.has(row.intended.action) || row.decision !== 'WOULD_REDUCE' || row.wouldBe !== 'PREPARED' || row.primaryBlock) return { ok: false, reason: 'NOT_ACTIONABLE', message: `القرار الحالي ${row.decision} (${row.intended.action}) — مش قابل للتنفيذ.`, row };
  const p = await (deps.persist || persistBudgetDecisions)([row], { adAccountId: res.adAccountId || row.adAccountId || deps.adAccountId, mode: 'APPROVAL', now, expireStale: false });
  const dec = await prisma.ambOperatorDecision.findFirst({ where: { rule_name: { startsWith: 'DYNAMIC_BUDGET:' }, campaign_id: campaignId, status: 'PREPARED' }, orderBy: { id: 'desc' } });
  return dec ? { ok: true, decisionId: dec.id, row, persisted: p } : { ok: false, reason: 'NOT_PERSISTED', message: 'القرار ما اتحفظش كـPREPARED.', row, persisted: p };
}

/**
 * Executes ONE PREPARED budget decision after the owner's explicit approval. deps (tests): config, evaluate, approveAndExecute, policy.
 * Returns a stage report {stages:{requested, sentToMeta, readBack, verified, cooldown}, ...}; never claims success that Meta did not confirm.
 */
export async function executeBudgetDecision({ decisionId, userId, now = new Date(), deps: depsIn = {} }) {
  const deps = effDeps(depsIn);
  if (!userId) { const e = new Error('التنفيذ بيحتاج موافقة مستخدم (userId).'); e.status = 400; throw e; }
  await requireAdmin(userId, deps);
  const row = await prisma.ambOperatorDecision.findUnique({ where: { id: Number(decisionId) } });
  const out = { ok: false, executed: false, verified: false, decisionId: Number(decisionId), stages: { requested: null, sentToMeta: null, readBack: null, verified: null, cooldown: null } };
  if (!row) return { ...out, status: 'NOT_FOUND', message: 'القرار غير موجود.' };
  if (!String(row.rule_name || '').startsWith('DYNAMIC_BUDGET:')) return { ...out, status: 'NOT_A_BUDGET_DECISION', message: 'ده مش قرار Dynamic Budget.' };
  if (row.status !== 'PREPARED') return { ...out, status: row.status, message: `القرار في حالة ${row.status} — مش قابل للتنفيذ (بيتنفذ مرة واحدة بس).` };
  if (!EXECUTABLE_ACTIONS.has(row.action)) return { ...out, status: 'ACTION_NOT_ENABLED', message: `الأكشن ${row.action} مش مفعّل للتنفيذ في الاختبار ده (التخفيض فقط).` };
  const params = j(row.params_json, {}) || {};
  const level = params.level, entityId = params.entityId;
  if (!['campaign', 'adset'].includes(level) || !entityId || !(params.toBudget > 0) || !(params.fromBudget > 0)) return { ...out, status: 'BAD_PARAMS', message: 'بيانات القرار ناقصة (مستوى/كيان/ميزانية).' };

  // 1. configuration gate — a refusal here leaves the decision PREPARED (nothing about it changed)
  const config = deps.config || await getOperatorConfig();
  const cb = configBlock(config);
  if (cb) { await transition(row.id, 'PREPARED', 'PREPARED', { actorId: userId, note: `BLOCKED_AT_GATE ${cb.code}`, campaignId: row.campaign_id }); return { ...out, status: 'BLOCKED', blocked: cb.code, message: cb.message }; }

  // 2. fresh LIVE re-evaluation — the same decision or nothing
  const res = await (deps.evaluate || ((o) => evaluateBudgetOptimization(o)))({ now, persist: false, live: true, only: { campaignIds: [row.campaign_id] }, ruleMode: 'APPROVAL' });
  const fresh = res.rows.find((r) => r.entity?.id === entityId);
  const reasons = [];
  if (res.structureSource !== 'META_LIVE') reasons.push({ code: 'NO_LIVE_DATA', detail: String(res.structureSource) }); // the budget level / current budget must come from Meta RIGHT NOW, never from the synced copy
  if (!fresh) reasons.push({ code: 'ENTITY_NOT_FOUND', detail: entityId });
  else {
    if (fresh.decision !== 'WOULD_REDUCE' || fresh.intended?.action !== row.action) reasons.push({ code: 'DECISION_CHANGED', detail: `${fresh.decision}/${fresh.intended?.action || '—'}` });
    if (fresh.primaryBlock || (fresh.guards || []).some((g) => /\[B\]/.test(g))) reasons.push({ code: 'GUARD_BLOCK', detail: fresh.primaryBlock || fresh.guards.filter((g) => /\[B\]/.test(g)).join(' ') });
    if (fresh.requiresApproval === true) { /* approval IS what this is — a DOWNGRADE guard only forbids Autopilot */ }
    if (Math.abs((fresh.entity?.budget ?? -1) - params.fromBudget) > 0.5) reasons.push({ code: 'BUDGET_CHANGED', detail: `${params.fromBudget} → live ${fresh.entity?.budget}` });
    if (fresh.intended?.toBudget !== params.toBudget) reasons.push({ code: 'PROPOSAL_CHANGED', detail: `${params.toBudget} → ${fresh.intended?.toBudget}` });
    const oldCpa = j(row.evidence_json, {})?.evidence?.cpa, newCpa = fresh.evidence?.cpa;
    if (oldCpa && newCpa && Math.abs(newCpa - oldCpa) / oldCpa > MAX_CPA_DRIFT) reasons.push({ code: 'EVIDENCE_DRIFT', detail: `CPA ${oldCpa} → ${newCpa}` });
  }
  if (reasons.length) {
    const msg = `القرار اتبطل — الأدلة/الحالة اتغيّرت: ${reasons.map((r) => `${r.code} (${r.detail})`).join('، ')}`;
    await prisma.ambOperatorDecision.update({ where: { id: row.id }, data: { status: 'EXPIRED', error: msg, error_category: 'GUARD' } });
    await transition(row.id, 'PREPARED', 'EXPIRED', { actorId: userId, note: msg, data: { reasons }, campaignId: row.campaign_id });
    return { ...out, status: 'EXPIRED', message: msg, reasons };
  }

  // 3. approve + atomic claim (a duplicated call can never execute twice)
  const approvedAt = new Date();
  const claim = await prisma.ambOperatorDecision.updateMany({ where: { id: row.id, status: 'PREPARED' }, data: { status: 'EXECUTING', approval_source: 'USER', approved_by_id: userId, approved_at: approvedAt } });
  if (claim.count !== 1) return { ...out, status: 'RACE', message: 'القرار بيتنفذ بالفعل.' };
  await transition(row.id, 'PREPARED', 'EXECUTING', { actorId: userId, note: 'APPROVED_BY_OWNER', campaignId: row.campaign_id });
  out.stages.requested = approvedAt.toISOString();

  // 4. the executable recommendation the existing executor understands (entity level = the discovered budget level)
  const m3 = j(row.evidence_json, {})?.m3 || fresh.m3 || {};
  const amb = row.product_id != null ? await prisma.ambProduct.findFirst({ where: { product_id: row.product_id }, select: { id: true } }) : null;
  const rec = await prisma.ambRecommendation.create({ data: {
    batch_id: `operator-budget-${row.id}`, ad_account_id: row.ad_account_id, amb_product_id: amb?.id ?? null, product_name: fresh.product || null, level, entity_id: entityId, entity_name: fresh.entity?.name || row.campaign_name, campaign_id: row.campaign_id, campaign_name: row.campaign_name,
    adset_id: level === 'adset' ? entityId : null, decision: AMB_ACTION[row.action], action_type: AMB_ACTION[row.action], executable: true,
    current_metrics_json: JSON.stringify({ spend: m3.spend ?? null, cpa: m3.cpa ?? null, purchases: m3.purchases ?? null }), current_budget: params.fromBudget, recommended_budget: params.toBudget, budget_change_pct: row.action === 'SCALE_UP' ? params.pct : -(params.pct || 0),
    reason: `AI Operator — ${row.rule_name}: ${j(row.why_json, {})?.why || ''}`.slice(0, 900), reason_facts_json: row.evidence_json, confidence: row.confidence, risk_level: 'LOW', data_sufficiency: 'STRONG', priority: 'P2', time_window_label: 'آخر 3 أيام', source: 'OPERATOR', status: 'PENDING',
  } });
  await prisma.ambOperatorDecision.update({ where: { id: row.id }, data: { amb_recommendation_id: rec.id, before_json: JSON.stringify({ level, entityId, budget: params.fromBudget }) } });

  // 5. the guarded write (live revalidation + ONE Meta write + read-back verification live in the existing executor)
  const exec = deps.approveAndExecute || (await import('./executor.js')).approveAndExecute;
  let result = null, err = null;
  try { result = await exec({ recId: rec.id, userId, mode: 'APPROVAL' }); } catch (e) { err = e; }
  const action = await prisma.ambAction.findFirst({ where: { recommendation_id: rec.id }, orderBy: { id: 'desc' } });
  let oldV = j(action?.old_value_json, null), newV = j(action?.new_value_json, null), verify = j(action?.verify_json, null);
  out.ambActionId = action?.id ?? null; out.recommendationId = rec.id;
  out.stages.sentToMeta = action?.meta_request_json ? { at: (action.executed_at || action.created_at)?.toISOString?.() || null, request: j(action.meta_request_json) } : null;
  const base = { amb_action_id: action?.id ?? null, before_json: JSON.stringify(oldV || { level, entityId, budget: params.fromBudget }), after_json: newV ? JSON.stringify(newV) : null, rollback_json: oldV ? JSON.stringify({ capturedBeforeWrite: true, previous: oldV, actionId: action?.id, at: new Date().toISOString() }) : null };
  // the executor errored although a request may have gone out: ask Meta what it really holds before saying anything
  let recon = null, reconDone = false;
  if ((err || !result?.ok) && !result?.aborted && action?.meta_request_json) { reconDone = true; recon = await (deps.readBack || defaultReadBack)({ entityId, level }); }
  const appliedByReadBack = !!(recon && recon.budget != null && Math.abs(recon.budget - params.toBudget) < 1);
  if (appliedByReadBack) {
    oldV = oldV || { budget: params.fromBudget }; newV = newV || { budget: params.toBudget }; verify = { verified: true, live: { budgetMajor: recon.budget }, reconciled: true, executorError: (err?.message || result?.message || '').slice(0, 300) };
    await prisma.ambAction.update({ where: { id: action.id }, data: { execution_status: 'EXECUTED', executed_at: action.executed_at || new Date(), verified_at: new Date(), verify_json: JSON.stringify(verify) } }).catch(() => {});
    await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'EXECUTED' } }).catch(() => {});
    base.after_json = JSON.stringify(newV);
    out.reconciled = true;
  }
  if ((err || !result?.ok) && !appliedByReadBack) {
    const msg = err?.message || result?.message || 'فشل التنفيذ.';
    const status = result?.aborted ? 'BLOCKED' : 'FAILED';
    await prisma.ambOperatorDecision.update({ where: { id: row.id }, data: { ...base, status, error: msg, error_category: result?.aborted ? 'GUARD' : 'EXECUTION' } });
    await transition(row.id, 'EXECUTING', status, { actorId: userId, note: msg, campaignId: row.campaign_id });
    await raiseAlert({ severity: 'WARNING', category: 'OPERATOR', title: `AI Operator: تنفيذ ميزانية لم يتم — ${row.campaign_name}`, message: msg, adAccountId: row.ad_account_id, entityId: row.campaign_id, dedupeKey: `operator:budgetfail:${row.id}` }).catch(() => {});
    out.stages.verified = 'FAILED'; out.stages.cooldown = null;
    const holds = !reconDone ? 'مفيش طلب خرج لـMeta.' : recon ? `قراءة Meta المستقلة: الميزانية الحالية ${recon.budget} (المطلوب ${params.toBudget}) — التغيير ما اتطبقش.` : 'ما قدرناش نقرأ Meta بعد الفشل — حالة الميزانية على Meta غير مؤكدة، راجعها يدويًا.';
    out.stages.readBack = recon ? { at: new Date().toISOString(), verified: false, liveBudgetAfter: recon.budget, expected: params.toBudget, independent: true } : (reconDone ? { at: new Date().toISOString(), verified: null, liveBudgetAfter: null, independent: true, unreadable: true } : null);
    return { ...out, status, message: `${status === 'FAILED' ? 'فشل' : 'اتمنع'}: ${msg} — ${holds}`, sentRequest: !!out.stages.sentToMeta, metaState: recon ? { budget: recon.budget } : null };
  }
  const verified = !!(verify?.verified);
  out.stages.readBack = verify ? { at: action?.verified_at?.toISOString?.() || new Date().toISOString(), verified, liveBudgetAfter: verify.live?.budgetMajor ?? null, expected: newV?.budget ?? null, ...(verify.reconciled ? { independent: true } : {}) } : null;
  await prisma.ambOperatorDecision.update({ where: { id: row.id }, data: { ...base, status: verified ? 'VERIFIED' : 'EXECUTED', executed_at: action?.executed_at || new Date(), verified_at: verified ? (action?.verified_at || new Date()) : null, verify_json: verify ? JSON.stringify(verify) : (action?.verify_json || null), error: verified ? null : 'تم إرسال الطلب إلى Meta لكن القراءة الفورية لم تؤكد التغيير (Unverified).' } });
  await transition(row.id, 'EXECUTING', verified ? 'VERIFIED' : 'EXECUTED', { actorId: userId, campaignId: row.campaign_id, data: { verified, before: oldV, after: newV } });
  if (!verified) await raiseAlert({ severity: 'WARNING', category: 'OPERATOR', title: `AI Operator: الطلب اتبعت ومفيش تأكيد — ${row.campaign_name}`, message: 'Meta قبلت الطلب لكن القراءة بعده ما أكدتش التغيير — Unverified، مش هنعتبره نجاح.', adAccountId: row.ad_account_id, entityId: row.campaign_id, dedupeKey: `operator:budgetunverified:${row.id}` }).catch(() => {});
  const policy = deps.policy || res.policy; const cdH = cooldownHoursOf(row.action, policy);
  const executedAt = action?.executed_at || new Date();
  out.stages.verified = verified ? 'VERIFIED' : 'UNVERIFIED';
  out.stages.cooldown = { hours: cdH, from: executedAt.toISOString(), until: new Date(executedAt.getTime() + cdH * MS_H).toISOString(), manualOverrideGuardHours: config.limits?.manualOverrideCooldownHours ?? 24 };
  return { ...out, ok: true, executed: true, verified, status: verified ? 'VERIFIED' : 'EXECUTED', before: oldV, after: newV, message: verified ? 'تم التنفيذ — اتأكد من قراءة Meta.' : 'تم إرسال الطلب إلى Meta — لسه مفيش تأكيد بقراءة Meta (Unverified).' };
}
