// 🤖 AI Operator — OPERATIONS read/aux layer: performance, outcome tracking, daily brief, health, rule/audit logs, "what will happen today",
// bulk approval and the (deliberately sparse) notifications. 2026-10-03. Read-only except bulkApprove (goes through the normal approve path)
// and notifications (alerts only).
import { prisma } from '../../prisma.js';
import { raiseAlert } from './alerts.js';
import { getSyncStatus } from './snapshotSync.js';
import { getOperatorConfig } from './operatorStore.js';
import { evaluateOperator, approveDecision } from './operatorEngine.js';
import { shapeDecision } from './operatorReports.js';
import { globalReadiness } from './operatorReadiness.js';
import { ACTION_LABEL_AR } from './operatorRules.js';

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const MS_H = 3_600_000;
const R = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

// =====================================================================================================================
// Performance (spec 97) + business outcome (spec 98/99)
// =====================================================================================================================
/** Counts only — NO success percentage unless there are enough evaluated outcomes (spec 97), and every verdict keeps its causal caveat. */
export async function performanceReport({ days = 30, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await prisma.ambOperatorDecision.findMany({ where: { created_at: { gte: since } }, select: { action: true, status: true, outcome_json: true, executed_at: true, error_category: true, mode_at_decision: true } });
  const types = ['OPEN', 'PAUSE', 'SCALE_UP', 'SCALE_DOWN'];
  const byType = Object.fromEntries(types.map((t) => [t, { executed: 0, verified: 0, failed: 0, rolledBack: 0, blocked: 0, rejected: 0, expired: 0 }]));
  const totals = { executed: 0, verified: 0, failed: 0, rolledBack: 0, blocked: 0, rejected: 0, expired: 0, shadow: 0, prepared: 0 };
  const verdicts = {}; let evaluated = 0;
  for (const r of rows) {
    const t = byType[r.action];
    const bump = (k) => { totals[k]++; if (t) t[k]++; };
    if (r.status === 'EXECUTED' || r.status === 'VERIFIED') { bump('executed'); if (r.status === 'VERIFIED') bump('verified'); }
    else if (r.status === 'FAILED') bump('failed'); else if (r.status === 'ROLLED_BACK') bump('rolledBack'); else if (r.status === 'BLOCKED') bump('blocked'); else if (r.status === 'REJECTED') bump('rejected'); else if (r.status === 'EXPIRED') bump('expired');
    else if (r.status === 'SHADOW') totals.shadow++; else if (r.status === 'PREPARED' || r.status === 'SNOOZED') totals.prepared++;
    const o = j(r.outcome_json, null); if (o?.verdict) { evaluated++; verdicts[o.verdict] = (verdicts[o.verdict] || 0) + 1; }
  }
  const MIN_EVAL = 5;
  return {
    days, totals, byType, outcomes: { evaluated, verdicts, minForSummary: MIN_EVAL, summary: evaluated >= MIN_EVAL ? verdicts : null },
    note: evaluated >= MIN_EVAL ? 'الأحكام بأثر رجعي ومعها تحفظ السببية (CONFOUNDED لما أكشنز تانية حصلت).' : `لسه مفيش تقييم كافي (${evaluated} من ${MIN_EVAL}) — مبنعرضش نسبة نجاح مضللة.`,
  };
}

/** Executed actions with their before → after (spec 99). Each one carries the honest verdict, including "not enough data yet". */
export async function executedWithOutcomes({ days = 14, limit = 60 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.ambOperatorDecision.findMany({ where: { status: { in: ['EXECUTED', 'VERIFIED', 'ROLLED_BACK'] }, executed_at: { gte: since } }, orderBy: { executed_at: 'desc' }, take: limit });
  return rows.map((r) => {
    const o = j(r.outcome_json, null), ev = j(r.evidence_json, {}), params = j(r.params_json, {});
    return { id: r.id, action: r.action, actionLabel: ACTION_LABEL_AR[r.action] || r.action, campaignId: r.campaign_id, campaignName: r.campaign_name, status: r.status, executedAt: r.executed_at, verified: r.status === 'VERIFIED',
      before: { cpa: ev?.metrics?.cpa ?? null, purchases: ev?.metrics?.purchases ?? null, budget: params.fromBudget ?? null }, action_: params.toBudget != null ? `${params.fromBudget} → ${params.toBudget} ج.م (${params.pct ? (r.action === 'SCALE_UP' ? '+' : '-') + params.pct + '%' : ''})` : null,
      after: o ? { cpa: o.cpaAfter, purchases: o.purchasesAfter, changePct: o.changePct } : null, verdict: o?.verdict || (r.action === 'PAUSE' ? 'NOT_JUDGED_BY_CPA' : 'PENDING_SAMPLE'), note: o?.note || (r.action === 'PAUSE' ? 'الإيقاف بيوقف الصرف بالتصميم — مش بيتحكم عليه بالـCPA.' : o ? null : 'لسه مفيش عينة كافية بعد الأكشن.') };
  });
}

// =====================================================================================================================
// Health (spec 92)
// =====================================================================================================================
export async function operatorHealth({ scheduler = null, now = new Date() } = {}) {
  const dayAgo = new Date(now.getTime() - 24 * MS_H);
  const [cfg, sync, lastEval, lastWrite, failed, blocked, queue, executing] = await Promise.all([
    getOperatorConfig(), getSyncStatus().catch(() => null),
    prisma.ambOperatorDecision.findFirst({ orderBy: { updated_at: 'desc' }, select: { updated_at: true } }),
    prisma.ambOperatorDecision.findFirst({ where: { status: { in: ['EXECUTED', 'VERIFIED'] } }, orderBy: { executed_at: 'desc' }, select: { executed_at: true, status: true } }),
    prisma.ambOperatorDecision.count({ where: { status: 'FAILED', updated_at: { gte: dayAgo } } }),
    prisma.ambOperatorDecision.count({ where: { status: 'BLOCKED' } }),
    prisma.ambOperatorDecision.count({ where: { status: { in: ['PREPARED', 'SNOOZED'] } } }),
    prisma.ambOperatorDecision.count({ where: { status: 'EXECUTING' } }),
  ]);
  const syncAgeMin = sync?.lastSuccessAt ? Math.round((now.getTime() - new Date(sync.lastSuccessAt).getTime()) / 60_000) : null;
  return {
    mode: cfg.mode, emergencyStop: cfg.emergency_stop,
    lastEvaluation: scheduler?.lastRun?.at || lastEval?.updated_at || null, lastEvaluationResult: scheduler?.lastRun?.error ? { error: scheduler.lastRun.error } : (scheduler?.lastRun?.result ? { evaluated: scheduler.lastRun.result.evaluated ?? null, candidates: scheduler.lastRun.result.candidates ?? null, skipped: scheduler.lastRun.result.skipped ?? null } : null),
    lastMetaRead: sync?.lastSuccessAt || null, metaReadAgeMinutes: syncAgeMin, metaFresh: syncAgeMin != null && syncAgeMin <= (Number(cfg.limits?.metaMaxAgeMinutes) || 60),
    lastMetaWrite: lastWrite?.executed_at || null,
    scheduler: scheduler ? { started: scheduler.started, running: scheduler.running, intervalMinutes: scheduler.intervalMinutes, consecutiveFailures: scheduler.consecutiveFailures ?? 0, nextRunAt: scheduler.nextRunAt ?? null } : null,
    queueDepth: queue, executing, failedLast24h: failed, blocked,
  };
}

// =====================================================================================================================
// Audit logs (spec 78 / 105)
// =====================================================================================================================
/** Rule audit: created / edited / enabled / disabled / mode changed / deleted — who and when, from ai_audit_log (written by every store mutation). */
export async function ruleAuditLog({ ruleId = null, limit = 100 } = {}) {
  const rows = await prisma.aiAuditLog.findMany({ where: { kind: { in: ['OPERATOR_RULE_CREATE', 'OPERATOR_RULE_UPDATE', 'OPERATOR_RULE_TOGGLE', 'OPERATOR_RULE_DELETE', 'OPERATOR_MODE', 'OPERATOR_LIMITS', 'OPERATOR_EMERGENCY_STOP', 'OPERATOR_EXCEPTION_ADD', 'OPERATOR_EXCEPTION_REMOVE', 'OPERATOR_PRODUCT_PROFILE', 'OPERATOR_BULK_SETUP', 'OPERATOR_MAPPING', 'OPERATOR_CAMPAIGN_TAG', 'OPERATOR_AUTOPILOT_ATTEST'] } }, orderBy: { id: 'desc' }, take: Math.min(limit, 300) });
  const actors = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actor_id).filter(Boolean))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const LABEL = { OPERATOR_RULE_CREATE: 'إنشاء قاعدة', OPERATOR_RULE_UPDATE: 'تعديل قاعدة', OPERATOR_RULE_TOGGLE: 'تفعيل/إيقاف قاعدة', OPERATOR_RULE_DELETE: 'حذف قاعدة', OPERATOR_MODE: 'تغيير وضع التشغيل', OPERATOR_LIMITS: 'تعديل حدود الأمان', OPERATOR_EMERGENCY_STOP: 'إيقاف الطوارئ', OPERATOR_EXCEPTION_ADD: 'إضافة استثناء', OPERATOR_EXCEPTION_REMOVE: 'إزالة استثناء', OPERATOR_PRODUCT_PROFILE: 'تعديل ملف منتج', OPERATOR_BULK_SETUP: 'إعداد جماعي', OPERATOR_MAPPING: 'ربط حملة', OPERATOR_CAMPAIGN_TAG: 'وسم حملة', OPERATOR_AUTOPILOT_ATTEST: 'تأكيدات Autopilot' };
  let out = rows.map((r) => ({ id: r.id, kind: r.kind, label: LABEL[r.kind] || r.kind, actor: r.actor_id ? (actors.get(r.actor_id) || `#${r.actor_id}`) : 'النظام', input: j(r.input_json, null), at: r.created_at, success: r.success }));
  if (ruleId != null) out = out.filter((r) => r.kind.startsWith('OPERATOR_RULE') && Number(r.input?.id) === Number(ruleId));
  return out;
}

// =====================================================================================================================
// "What will happen today?" (spec 101) + dry run (spec 76)
// =====================================================================================================================
/** Shadow simulation of every enabled rule over the live world. NO writes. A candidate that is not BLOCKED is what the Operator would do; mode is irrelevant here. */
export async function whatWillHappen({ rules = null } = {}) {
  const r = await evaluateOperator({ rules, persist: false });
  const live = r.candidates.filter((c) => c.wouldBe !== 'BLOCKED');
  const blocked = r.candidates.filter((c) => c.wouldBe === 'BLOCKED');
  const unknownGroups = new Set(['DATA_QUALITY', 'INVENTORY']);
  const summary = {
    objectsEvaluated: r.campaignsEvaluated, rulesEvaluated: r.rulesEvaluated, candidates: r.candidates.length,
    wouldOpen: live.filter((c) => c.action === 'OPEN').length, wouldPause: live.filter((c) => c.action === 'PAUSE').length, wouldScale: live.filter((c) => c.action === 'SCALE_UP').length, wouldReduce: live.filter((c) => c.action === 'SCALE_DOWN').length,
    blocked: blocked.length, excluded: blocked.filter((c) => c.primaryBlock?.group === 'EXCEPTION').length, protected: blocked.filter((c) => ['TESTING_PROTECTED', 'PRODUCT_AUTOMATION_OFF'].includes(c.primaryBlock?.code)).length,
    unknown: blocked.filter((c) => unknownGroups.has(c.primaryBlock?.group) || ['DATA_UNKNOWN', 'ECONOMICS_INCOMPLETE', 'MAPPING_UNRELIABLE'].includes(c.primaryBlock?.code)).length,
  };
  return { simulation: true, wrote: false, summary, engineSummary: r.summary, ms: r.ms, conflicts: r.conflicts, candidates: r.candidates.slice(0, 300).map((c) => ({ key: c.key, action: c.action, actionLabel: ACTION_LABEL_AR[c.action], store: c.store, productName: c.productName, campaign: c.campaign, ruleName: c.ruleName, wouldBe: c.wouldBe, confidence: c.confidence, params: c.params, primaryBlock: c.primaryBlock, canonical: c.canonical })) };
}

// =====================================================================================================================
// Bulk approval (spec 89) — homogeneous, low-risk, each item shown and re-validated individually
// =====================================================================================================================
export const BULK_APPROVABLE_ACTIONS = ['PAUSE', 'SCALE_DOWN'];
export const BULK_MAX = 10;
export async function bulkApprove({ decisionIds, confirmedIds, userId, deps = {} }) {
  const ids = [...new Set((decisionIds || []).map(Number))];
  if (!ids.length) { const e = new Error('مفيش قرارات متحددة.'); e.status = 400; throw e; }
  if (ids.length > BULK_MAX) { const e = new Error(`الموافقة الجماعية لحد ${BULK_MAX} قرارات.`); e.status = 400; throw e; }
  const conf = new Set((confirmedIds || []).map(Number));
  if (ids.some((i) => !conf.has(i))) { const e = new Error('لازم تراجع وتأكد كل حملة بنفسها قبل الموافقة الجماعية.'); e.status = 400; throw e; }
  const rows = await prisma.ambOperatorDecision.findMany({ where: { id: { in: ids } } });
  if (rows.length !== ids.length) { const e = new Error('فيه قرار مش موجود.'); e.status = 404; throw e; }
  const bad = rows.filter((r) => r.status !== 'PREPARED');
  if (bad.length) { const e = new Error(`قرارات مش جاهزة للموافقة: ${bad.map((b) => `#${b.id}(${b.status})`).join(' ')}`); e.status = 409; throw e; }
  const rules = new Set(rows.map((r) => r.rule_id)), actions = new Set(rows.map((r) => r.action));
  if (rules.size !== 1 || actions.size !== 1) { const e = new Error('الموافقة الجماعية بس لقرارات متجانسة: نفس القاعدة ونفس الأكشن. مفيش موافقة عمياء على أكشنز مختلطة.'); e.status = 400; throw e; }
  const action = [...actions][0];
  if (!BULK_APPROVABLE_ACTIONS.includes(action)) { const e = new Error('الموافقة الجماعية متاحة بس للأكشنز منخفضة المخاطر (إيقاف / تقليل ميزانية).'); e.status = 400; throw e; }
  if (rows.some((r) => (j(r.blocked_codes_json, []) || []).some((b) => b.severity === 'BLOCK'))) { const e = new Error('فيه قرار عليه موانع — مش ممكن يتوافق عليه جماعيًا.'); e.status = 400; throw e; }
  const results = [];
  for (const r of rows) { // sequential: every item re-validates and claims on its own (idempotent, atomic)
    try { const x = await approveDecision({ decisionId: r.id, userId, deps }); results.push({ id: r.id, campaign: r.campaign_name, executed: !!x.executed, status: x.status, message: x.message }); }
    catch (err) { results.push({ id: r.id, campaign: r.campaign_name, executed: false, status: 'ERROR', message: err.message }); }
  }
  return { ok: true, action, summary: { total: results.length, executed: results.filter((x) => x.executed).length, notExecuted: results.filter((x) => !x.executed).length }, results };
}

// =====================================================================================================================
// Daily brief (spec 100)
// =====================================================================================================================
export async function dailyBrief({ now = new Date(), adAccountId = null } = {}) {
  const dayAgo = new Date(now.getTime() - 24 * MS_H), weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const [executed, awaiting, blockedRows, outcomes, readiness, cfg, failed] = await Promise.all([
    prisma.ambOperatorDecision.findMany({ where: { status: { in: ['EXECUTED', 'VERIFIED', 'ROLLED_BACK'] }, executed_at: { gte: dayAgo } }, orderBy: { executed_at: 'desc' }, take: 20 }),
    prisma.ambOperatorDecision.findMany({ where: { status: 'PREPARED' }, orderBy: { updated_at: 'desc' }, take: 20 }),
    prisma.ambOperatorDecision.findMany({ where: { status: 'BLOCKED', updated_at: { gte: dayAgo } }, select: { blocked_codes_json: true } }),
    prisma.ambOperatorDecision.findMany({ where: { executed_at: { gte: weekAgo }, outcome_json: { not: null } }, select: { campaign_name: true, action: true, outcome_json: true } }),
    globalReadiness({ heavy: false, adAccountId }),
    getOperatorConfig(),
    prisma.ambOperatorDecision.count({ where: { status: 'FAILED', updated_at: { gte: dayAgo } } }),
  ]);
  const reasons = {};
  for (const b of blockedRows) for (const x of (j(b.blocked_codes_json, []) || []).filter((c) => c.severity === 'BLOCK').slice(0, 1)) reasons[x.code] = (reasons[x.code] || 0) + 1;
  const topBlocks = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([code, n]) => ({ code, count: n }));
  const verdicts = outcomes.map((o) => ({ campaign: o.campaign_name, action: o.action, ...j(o.outcome_json, {}) }));
  const improved = verdicts.filter((v) => v.verdict === 'IMPROVED'), worse = verdicts.filter((v) => ['HARMFUL', 'WORSENED'].includes(v.verdict));
  const opp = awaiting.filter((a) => a.action === 'SCALE_UP').slice(0, 1).map(shapeDecision)[0] || null;
  const risk = worse[0] ? { kind: 'WORSENED', text: `${worse[0].campaign}: CPA ${worse[0].cpaBefore} → ${worse[0].cpaAfter} بعد ${ACTION_LABEL_AR[worse[0].action]}` } : (cfg.emergency_stop ? { kind: 'EMERGENCY', text: 'إيقاف الطوارئ مفعّل' } : (failed ? { kind: 'FAILED', text: `${failed} تنفيذ فشل آخر 24 ساعة` } : null));
  return {
    generatedAt: now.toISOString(), mode: cfg.mode, emergencyStop: cfg.emergency_stop,
    did: executed.map((r) => ({ id: r.id, action: r.action, actionLabel: ACTION_LABEL_AR[r.action], campaign: r.campaign_name, status: r.status, at: r.executed_at, verified: r.status === 'VERIFIED' })),
    needsApproval: awaiting.map((r) => ({ id: r.id, action: r.action, actionLabel: ACTION_LABEL_AR[r.action], campaign: r.campaign_name, rule: r.rule_name })),
    blocked: { total: blockedRows.length, top: topBlocks },
    needsSetup: { productsBlocked: readiness.products.blocked, productsPartial: readiness.products.partial, missingEconomics: readiness.missingEconomics, missingStock: readiness.missingStock, unmappedCampaigns: readiness.campaigns.unmapped },
    improved: improved.slice(0, 5), worsened: worse.slice(0, 5),
    topRisk: risk, topOpportunity: opp ? { decisionId: opp.id, campaign: opp.campaignName, product: opp.productName, text: opp.why?.what } : null,
  };
}

// =====================================================================================================================
// Notifications — meaningful only (spec 90). Time-bucketed dedupe keys: a re-evaluation never re-notifies inside its bucket.
// =====================================================================================================================
export async function emitOperatorNotifications({ now = new Date(), result = null } = {}) {
  const bucket = (h) => Math.floor(now.getTime() / (h * MS_H));
  const sent = [];
  const send = async (a) => { const r = await raiseAlert({ category: 'OPERATOR', ...a }); if (r) sent.push(a.dedupeKey); };
  const prepared = await prisma.ambOperatorDecision.count({ where: { status: 'PREPARED' } });
  if (prepared > 0) await send({ severity: 'INFO', title: `AI Operator: ${prepared} قرار محتاج موافقتك`, message: 'افتح "قرارات اليوم" وراجع القرارات الجاهزة.', dedupeKey: `operator:needs-approval:${bucket(6)}` });
  const dq = await prisma.ambOperatorDecision.count({ where: { status: 'BLOCKED', updated_at: { gte: new Date(now.getTime() - 24 * MS_H) }, blocked_codes_json: { contains: '"group":"DATA_QUALITY"' } } });
  if (dq > 0) await send({ severity: 'WARNING', title: `AI Operator: جودة البيانات منعت ${dq} قرار`, message: 'القرارات المتوقفة بسبب جودة البيانات مش هتتنفذ لحد ما الجودة ترجع سليمة.', dedupeKey: `operator:dq-blocked:${bucket(24)}` });
  const limit = await prisma.ambOperatorDecision.count({ where: { status: 'BLOCKED', updated_at: { gte: new Date(now.getTime() - 24 * MS_H) }, OR: [{ blocked_codes_json: { contains: 'ACCOUNT_DAILY_LIMIT' } }, { blocked_codes_json: { contains: 'STORE_DAILY_LIMIT' } }, { blocked_codes_json: { contains: 'RATE_LIMIT_DAY' } }] } });
  if (limit > 0) await send({ severity: 'WARNING', title: 'AI Operator: وصل لحد يومي', message: 'حد الأكشنز/الميزانية اليومي اتوصل — الأكشنز الإضافية متوقفة لحد بكرة.', dedupeKey: `operator:daily-limit:${bucket(24)}` });
  const failedRows = await prisma.ambOperatorDecision.findMany({ where: { status: 'FAILED', updated_at: { gte: new Date(now.getTime() - 24 * MS_H) } }, select: { campaign_id: true, error_category: true } });
  if (failedRows.length >= 3) await send({ severity: 'CRITICAL', title: `AI Operator: ${failedRows.length} تنفيذ فشل آخر 24 ساعة`, message: 'تكرار فشل في الكتابة على Meta — راجع سجل التنفيذ. مفيش إعادة محاولة تلقائية.', dedupeKey: `operator:repeated-failure:${bucket(24)}` });
  return { sent };
}

export async function notifyEmergencyStop({ on, reason = null, now = new Date() }) {
  if (!on) return;
  await raiseAlert({ severity: 'CRITICAL', category: 'OPERATOR', title: '🛑 AI Operator: إيقاف الطوارئ اتفعّل', message: reason || 'إيقاف يدوي', dedupeKey: `operator:emergency:${now.toISOString().slice(0, 13)}` });
}
