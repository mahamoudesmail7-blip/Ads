// ✅ Approval Center — ONE list of everything waiting for the owner's decision:
//   decisions (rule-based + Dynamic Budget): Campaign | Product | Action | Before | After | Reason | Risk | Confidence | Approve / Reject
//   plans (daily / independent) that are prepared and not yet approved.
// It only READS and shapes; approving/rejecting goes through the existing official routes (engine → bridge → executor). Bulk approval is limited to low-risk actions that passed every
// check, needs the owner to confirm the exact campaign count and exposed budget, saves a snapshot, and every campaign is re-validated live at its own execution.
import { dashAcctWhere, planAcctWhere } from './acctFilter.js';
import { prisma } from '../../prisma.js';
import { getOperatorConfig } from './operatorStore.js';
import { listDecisions } from './operatorReports.js';
import { permissionFor, PERMISSION_META } from './executionPermissions.js';
import { evaluateWriteGate } from './writeGate.js';

export const BULK_ACTIONS = ['PAUSE', 'SCALE_DOWN'];
export const BULK_MAX = 10;
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** Why an approval of this action would NOT reach Meta right now (empty = it would). Pure over a config. */
export function gateOf(config, action) {
  const reasons = [];
  if (config.emergency_stop) reasons.push('Emergency Stop مفعّل');
  if (config.mode !== 'APPROVAL') reasons.push(`الوضع ${config.mode === 'OFF' ? 'MANUAL' : config.mode} — التنفيذ الفعلي محتاج «بموافقتي»`);
  if (config.writesLocked) reasons.push('كتابة Meta مقفولة على مستوى النشر');
  const need = permissionFor(action);
  if (need && config.execPermissions && config.execPermissions[need] !== true) reasons.push(`صلاحية «${PERMISSION_META[need].label}» مقفولة`);
  return { executableNow: reasons.length === 0, reasons };
}
const beforeAfter = (d) => {
  const p = d.params || {};
  if (d.isBudgetDecision || ['SCALE_UP', 'SCALE_DOWN'].includes(d.action)) return { before: p.fromBudget != null ? { kind: 'BUDGET', value: p.fromBudget } : null, after: p.toBudget != null ? { kind: 'BUDGET', value: p.toBudget } : null };
  if (d.action === 'PAUSE') return { before: { kind: 'STATUS', value: 'ACTIVE' }, after: { kind: 'STATUS', value: 'PAUSED' } };
  if (d.action === 'OPEN') return { before: { kind: 'STATUS', value: 'PAUSED' }, after: { kind: 'STATUS', value: 'ACTIVE' } };
  return { before: null, after: null };
};
export const riskOf = (d) => (d.blocks || []).some((b) => b.severity === 'BLOCK') ? 'HIGH' : (d.confidence === 'LOW' || (d.warnings || []).length >= 2) ? 'MEDIUM' : 'LOW';
export function approvalRow(d, config) {
  const { before, after } = beforeAfter(d); const hard = (d.blocks || []).filter((b) => b.severity === 'BLOCK').map((b) => b.code);
  const exposed = d.params?.toBudget ?? d.params?.budget ?? d.params?.fromBudget ?? d.metrics?.budget ?? null;
  const entityLevel = d.params?.level || null, entityId = d.params?.entityId || null; // ABO: the decision is about ONE ad set — the screen must say which
  return { kind: 'DECISION', id: d.id, status: d.status, campaignId: d.campaignId, campaign: d.campaignName, entityLevel, entityId, entityName: entityLevel === 'adset' ? (d.evidence?.history?.entityName || null) : null, product: d.productName, action: d.action, actionLabel: d.actionLabel, before, after,
    reason: d.why?.why || d.why?.what || d.ruleName || '', risk: riskOf(d), confidence: d.confidence, hardBlocks: hard, warnings: (d.warnings || []).map((w) => w.code),
    exposedBudget: exposed, cpa: d.metrics?.cpa ?? null, orders: d.metrics?.purchases ?? d.metrics?.orders ?? null, spend: d.metrics?.spend ?? null, window: d.window || d.params?.window || null, stock: d.stock?.status || null, execution: gateOf(config, d.action), bulkEligible: BULK_ACTIONS.includes(d.action) && d.status === 'PREPARED' && hard.length === 0, isBudgetDecision: !!d.isBudgetDecision, cooldown: d.cooldown || null, updatedAt: d.updatedAt };
}

export async function listApprovals({ now = new Date(), deps = {} } = {}) {
  const config = deps.config || await getOperatorConfig();
  const decisions = (deps.decisions || await listDecisions({ bucket: 'approval', limit: 150, now })).filter((d) => ['PREPARED', 'SNOOZED'].includes(d.status)).map((d) => approvalRow(d, config));
  const plansRaw = deps.plans || await prisma.ambDailyPlan.findMany({ where: { AND: [await planAcctWhere()], status: 'PREPARED', simulated: false }, include: { items: { select: { selected: true, evidence_json: true, campaign_id: true, campaign_name: true, product_name: true, risk: true, eligibility: true } } }, orderBy: { id: 'desc' }, take: 10 });
  const plans = plansRaw.map((p) => { const sel = p.items.filter((i) => i.selected); return { kind: 'PLAN', planId: p.id, key: p.plan_key, type: p.type, date: p.plan_date, independent: p.plan_key.includes('|T-'), selected: sel.length, total: p.items.length, exposedBudget: Math.round(sel.reduce((t, i) => t + (Number(j(i.evidence_json, {}).budget) || 0), 0)), exposure: { count: sel.length, exposedBudget: Math.round(sel.reduce((t, i) => t + (Number(j(i.evidence_json, {}).budget) || 0), 0)), campaignIds: sel.map((i) => i.campaign_id).sort() }, policyVersion: j(p.evidence_json, {}).openCpa?.version ?? null, version: p.version, execution: gateOf(config, p.type === 'OPEN' ? 'OPEN' : 'PAUSE'), dataState: p.data_state,
      items: sel.map((i) => { const e = j(i.evidence_json, {}); return { campaignId: i.campaign_id, campaign: i.campaign_name, product: i.product_name, before: p.type === 'OPEN' ? 'PAUSED' : 'ACTIVE', after: p.type === 'OPEN' ? 'ACTIVE' : 'PAUSED', budget: e.budget ?? null, cpa: e.cpaPolicy?.cpa ?? e.m7?.cpa ?? null, orders: e.cpaPolicy?.purchases ?? e.m7?.purchases ?? null, risk: i.risk || null, stock: e.stock?.status || null, mapping: e.mapping || null }; }) }; });
  const decExposed = decisions.reduce((t, d) => t + (Number(d.exposedBudget) || 0), 0);
  return { decisions, plans, gate: { mode: config.mode, writesLocked: config.writesLocked, emergencyStop: config.emergency_stop, permissions: config.execPermissions || null }, totals: { pendingDecisions: decisions.length, pendingPlans: plans.length, bulkEligible: decisions.filter((d) => d.bulkEligible).length, exposedBudgetDecisions: Math.round(decExposed) } };
}

/** What a bulk approval of these decisions would be — WITHOUT executing anything. The owner must confirm exactly these two numbers (count + exposed budget). */
export async function bulkPreview({ ids, deps = {} }) {
  const list = [...new Set((ids || []).map(Number))]; const blockers = [];
  if (!list.length) return { ok: false, blockers: ['مفيش قرارات متحددة.'], items: [], count: 0, exposedBudget: 0 };
  if (list.length > BULK_MAX) blockers.push(`الموافقة الجماعية لحد ${BULK_MAX} قرارات.`);
  const config = deps.config || await getOperatorConfig();
  const rows = deps.rows || await prisma.ambOperatorDecision.findMany({ where: { ...(await dashAcctWhere()), id: { in: list } } });
  if (rows.length !== list.length) blockers.push('فيه قرار مش موجود.');
  const notReady = rows.filter((r) => r.status !== 'PREPARED'); if (notReady.length) blockers.push(`قرارات مش جاهزة: ${notReady.map((r) => `#${r.id}(${r.status})`).join(' ')}`);
  const actions = new Set(rows.map((r) => r.action)); const rules = new Set(rows.map((r) => r.rule_id ?? r.rule_name));
  if (actions.size > 1 || rules.size > 1) blockers.push('الموافقة الجماعية بس لقرارات متجانسة: نفس القاعدة ونفس الأكشن.');
  const action = [...actions][0]; if (action && !BULK_ACTIONS.includes(action)) blockers.push('الموافقة الجماعية متاحة بس للأكشنز منخفضة المخاطر (إيقاف / تقليل ميزانية).');
  if (rows.some((r) => (j(r.blocked_codes_json, []) || []).some((b) => b.severity === 'BLOCK'))) blockers.push('فيه قرار عليه موانع أمان.');
  const gate = action ? gateOf(config, action) : { executableNow: false, reasons: [] };
  if (action && !gate.executableNow) blockers.push(`التنفيذ دلوقتي هيتمنع: ${gate.reasons.join(' · ')}`);
  const items = rows.map((r) => { const p = j(r.params_json, {}) || {}; return { id: r.id, campaign: r.campaign_name, campaignId: r.campaign_id, action: r.action, from: p.fromBudget ?? null, to: p.toBudget ?? null, exposedBudget: p.toBudget ?? p.fromBudget ?? null }; });
  const exposedBudget = Math.round(items.reduce((t, i) => t + (Number(i.exposedBudget) || 0), 0));
  return { ok: blockers.length === 0, blockers, items, count: rows.length, exposedBudget, gate };
}

/** Saves the snapshot the bulk approval is based on (who, when, exactly which decisions/budgets). Each campaign is STILL re-validated live at its own execution. */
export async function saveBulkSnapshot({ preview, userId }) {
  return prisma.ambOperatorEvent.create({ data: { kind: 'BULK_APPROVAL_SNAPSHOT', actor: 'USER', actor_id: userId ?? null, note: `موافقة جماعية: ${preview.count} قرار، ميزانية معرّضة ${preview.exposedBudget}`, data_json: JSON.stringify({ count: preview.count, exposedBudget: preview.exposedBudget, items: preview.items, savedAt: new Date().toISOString() }).slice(0, 8000) } });
}

let activeCache = null;
/** ACTIVE campaigns in the latest Meta sync (one cheap query, cached 2 minutes) — the full campaign list is far too heavy for a status bar. */
export async function activeCampaignCount(adAccountId, { now = new Date() } = {}) {
  if (!adAccountId) return null;
  if (activeCache && activeCache.id === adAccountId && now.getTime() - activeCache.at < 120_000) return activeCache.n;
  const last = await prisma.metaPerformanceSnapshot.findFirst({ where: { level: 'campaign', ad_account_id: adAccountId }, orderBy: { snapshot_at: 'desc' }, select: { snapshot_at: true } });
  if (!last) return null;
  const rows = await prisma.metaPerformanceSnapshot.findMany({ where: { level: 'campaign', ad_account_id: adAccountId, campaign_status: 'ACTIVE', snapshot_at: { gte: new Date(last.snapshot_at.getTime() - 5 * 60_000) } }, distinct: ['campaign_id'], select: { campaign_id: true } });
  activeCache = { id: adAccountId, at: now.getTime(), n: rows.length }; return rows.length;
}

/** The four numbers under the status row. */
export async function statusBar({ now = new Date(), deps = {} } = {}) {
  const today = now.toISOString().slice(0, 10);
  const [pendingDecisions, pendingPlans, scheduledPlans, importantAlerts] = await Promise.all([
    prisma.ambOperatorDecision.count({ where: { ...(await dashAcctWhere()), status: 'PREPARED' } }),
    prisma.ambDailyPlan.count({ where: { AND: [await planAcctWhere()], status: 'PREPARED', simulated: false } }),
    prisma.ambDailyPlan.count({ where: { AND: [await planAcctWhere()], status: { in: ['PREPARED', 'APPROVED', 'RUNNING'] }, simulated: false, expires_at: { gt: now } } }),
    prisma.ambAlert.count({ where: { read: false, severity: { in: ['CRITICAL', 'WARNING'] }, created_at: { gte: new Date(now.getTime() - 24 * 3_600_000) } } }),
  ]);
  let activeCampaigns = deps.activeCampaigns ?? null;
  if (activeCampaigns == null) { try { activeCampaigns = await activeCampaignCount((await (await import('../metaAuth.js')).getConnection())?.selected_ad_account_id, { now }); } catch { /* unknown */ } }
  return { activeCampaigns, pendingApprovals: pendingDecisions + pendingPlans, scheduledPlans, importantAlerts, date: today };
}

const AMB_ACTION = { SCALE_UP: 'INCREASE_BUDGET', SCALE_DOWN: 'DECREASE_BUDGET', PAUSE: 'PAUSE', OPEN: 'RESUME' };
/**
 * 👁️ PREVIEW of ONE pending decision — READ ONLY. Answers, before the owner approves: would the write be allowed right now (central gate), what does Meta hold RIGHT NOW versus what the decision expects,
 * does anything conflict (opposite operation / plan queue / budget caps), and what exact request WOULD be sent. Never calls a Meta write endpoint and never changes a row.
 * deps (tests): config, readEntity({entityId}) -> {status,budget}, checkConflicts, checkCaps.
 */
export async function previewDecision({ decisionId, now = new Date(), deps = {} }) {
  const row = await prisma.ambOperatorDecision.findUnique({ where: { id: Number(decisionId) } });
  if (!row) { const e = new Error('القرار غير موجود.'); e.status = 404; throw e; }
  const config = deps.config || await getOperatorConfig(); const params = j(row.params_json, {}) || {}; const ambAction = AMB_ACTION[row.action] || null;
  const out = { decisionId: row.id, status: row.status, campaignId: row.campaign_id, campaign: row.campaign_name, action: row.action, writes: false, gate: null, live: null, expected: null, drift: [], conflicts: [], caps: null, plannedRequest: null, verdict: 'NOT_PREVIEWABLE', notes: [] };
  if (!ambAction) { out.notes.push('الأكشن ده مش عملية كتابة على Meta (تحضير/اختبار) — مفيش معاينة تنفيذ.'); return out; }
  const g = evaluateWriteGate({ config, actionType: ambAction, mode: 'APPROVAL' }); out.gate = { executableNow: g.ok, reasons: g.ok ? [] : g.reasons.map((r) => ({ code: r.code, message: r.message })) };
  const entityId = params.entityId || row.campaign_id; const isBudget = ['SCALE_UP', 'SCALE_DOWN'].includes(row.action);
  out.entity = { id: entityId, level: params.level || 'campaign', name: j(row.evidence_json, {})?.history?.entityName || null, campaignId: row.campaign_id, campaignName: row.campaign_name }; // ABO: the decision is about ONE ad set — the preview says which
  out.expected = isBudget ? { budget: params.fromBudget ?? null, to: params.toBudget ?? null } : { status: row.action === 'OPEN' ? 'PAUSED' : 'ACTIVE', to: row.action === 'OPEN' ? 'ACTIVE' : 'PAUSED' };
  try {
    const live = deps.readEntity ? await deps.readEntity({ entityId }) : await (async () => { const [{ getEntity }, { getDecryptedToken }] = await Promise.all([import('../metaGraphClient.js'), import('../metaAuth.js')]); const e = await getEntity(await getDecryptedToken(), entityId, 'status,effective_status,daily_budget,lifetime_budget'); const d = Number(e.daily_budget); return { status: e.effective_status || e.status || null, budget: Number.isFinite(d) ? d / 100 : null }; })();
    out.live = { status: live?.status ?? null, budget: live?.budget ?? null, readAt: new Date().toISOString() };
    if (isBudget && live?.budget != null && params.fromBudget != null && Math.abs(live.budget - params.fromBudget) > 0.5) out.drift.push({ code: 'BUDGET_CHANGED', detail: `القرار اتبنى على ${params.fromBudget} وMeta دلوقتي ${live.budget}` });
    if (!isBudget && live?.status && out.expected.status && live.status !== out.expected.status) out.drift.push({ code: 'STATUS_CHANGED', detail: `المتوقع ${out.expected.status} وMeta دلوقتي ${live.status}` });
    out.plannedRequest = isBudget ? { endpoint: `POST /${entityId}`, body: { daily_budget: Math.round((params.toBudget ?? 0) * 100) }, humanReadable: `${live?.budget ?? params.fromBudget} → ${params.toBudget}` } : { endpoint: `POST /${entityId}`, body: { status: out.expected.to }, humanReadable: `${live?.status || out.expected.status} → ${out.expected.to}` };
  } catch (e) { out.notes.push(`تعذّرت قراءة Meta: ${String(e.message).slice(0, 120)}`); out.live = null; }
  try { out.conflicts = await (deps.checkConflicts ? deps.checkConflicts({ campaignId: row.campaign_id, want: row.action, excludeDecisionId: row.id }) : (await import('./integration.js')).checkConflicts({ campaignId: row.campaign_id, want: row.action, excludeDecisionId: row.id, now })); } catch { out.conflicts = []; }
  if (row.action === 'SCALE_UP') { try { const { checkBudgetCaps } = await import('./budgetCaps.js'); const cap = await (deps.checkCaps || checkBudgetCaps)({ action: 'SCALE_UP', delta: (params.toBudget ?? 0) - (params.fromBudget ?? 0), adAccountId: row.ad_account_id, campaignId: row.campaign_id, productId: row.product_id ?? null, now }); out.caps = { ok: cap.ok, violations: cap.violations || [] }; } catch { out.caps = null; } }
  const blocked = !g.ok || out.drift.length || out.conflicts.length || (out.caps && !out.caps.ok) || row.status !== 'PREPARED';
  out.verdict = !out.live ? 'LIVE_UNREADABLE' : blocked ? (g.ok ? 'WOULD_BLOCK' : 'GATE_CLOSED') : 'READY';
  return out;
}
