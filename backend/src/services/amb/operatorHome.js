// AI Operator V2 — the Home screen payload (read-only). Composed ONLY from existing sources: the campaign query (period KPIs, view counts), the operator config (mode / lock / permissions), the policy stores,
// the decision / plan tables and the autopilot gate. A policy counts as READY only when it is ENABLED and APPROVED at its current version — a saved draft is never «ready». Nothing is written.
//   EMPLOYEE (read-only): period KPIs, view counts and data freshness only — no gates, policies, approvals or the to-do list.
import { dashAcctWhere, planAcctWhere } from './acctFilter.js';
import { prisma } from '../../prisma.js';
import { queryCampaigns } from './campaignQuery.js';
import { getOperatorConfig, autopilotGate } from './operatorStore.js';
import { getPausePolicy, pausePolicyActive } from './pausePolicy.js';
import { getOpenCpaPolicy } from './openCpaPolicy.js';
import { getZeroSpendPolicy, zeroSpendActive } from './zeroSpendCheck.js';
import { policyBook } from './productPolicy.js';

const state = (ready, saved) => (ready ? 'READY' : saved ? 'DRAFT' : 'MISSING');
export async function policyStates() {
  const [pause, open, zero, book] = await Promise.all([getPausePolicy(), getOpenCpaPolicy(), getZeroSpendPolicy(), policyBook()]);
  const products = Object.values(book.products || {}); const ready = products.filter((e) => e?.active).length; const draft = products.filter((e) => !e?.active && e?.draft).length;
  const list = [
    { key: 'OPEN_CPA', label: 'سياسة الفتح حسب CPA', state: state(!!(open.enabled && open.approved), (open.version || 0) > 0), detail: open.enabled && open.approved ? `معتمدة v${open.version}` : (open.version || 0) > 0 ? 'محفوظة وغير معتمدة/غير مفعّلة' : 'غير موجودة' },
    { key: 'PAUSE', label: 'سياسة الإيقاف', state: state(pausePolicyActive(pause), (pause.version || 0) > 0), detail: pausePolicyActive(pause) ? `معتمدة v${pause.version}` : (pause.version || 0) > 0 ? `v${pause.version} محفوظة — المعتمدة ${pause.approved ? 'v' + pause.approved.version : 'لا شيء'}` : 'غير موجودة' },
    { key: 'ZERO_SPEND', label: 'سياسة الصرف بدون أوردرات', state: state(zeroSpendActive(zero), (zero.version || 0) > 0), detail: zeroSpendActive(zero) ? `معتمدة v${zero.version} (${zero.checkTime})` : (zero.version || 0) > 0 ? 'محفوظة وغير معتمدة' : 'غير موجودة' },
    { key: 'GLOBAL_RULES', label: 'القواعد العامة', state: state(['ACTIVE', 'ACTIVE_WITH_DRAFT'].includes(book.global.status), book.global.status === 'DRAFT'), detail: book.global.status },
    { key: 'PRODUCT_POLICIES', label: 'سياسات المنتجات', state: ready && !draft && products.length === ready ? 'READY' : ready || draft ? 'PARTIAL' : 'MISSING', detail: `${ready} معتمدة · ${draft} مسودة · ${products.length - ready - draft} غير مكتملة` },
  ];
  return { list, ready: list.filter((p) => p.state === 'READY').length, incomplete: list.filter((p) => p.state !== 'READY').length };
}
const STEP_TARGET = { rules: 'auto', accountLimits: 'set', emergencyStop: 'set', writesUnlocked: 'set', emergencyOff: 'set', shadow: 'auto' };
export async function buildHome({ user, access, query = {}, now = new Date() }) {
  const q = await queryCampaigns({ access, body: { period: query.period || 'last7', from: query.from, to: query.to, compare: query.compare === true, view: 'all', pageSize: 5 }, now });
  const out = { level: access.level, period: q.period, summary: q.summary, viewCounts: q.viewCounts, viewExposure: q.viewExposure, freshness: q.freshness, attribution: q.attribution, accounts: q.facets.accounts, generatedAt: now.toISOString() };
  if (!access.capabilities.reviewActions) return out;
  const cfg = await getOperatorConfig();
  out.gates = { mode: cfg.mode, writesLocked: cfg.writesLocked !== false, emergencyStop: !!cfg.emergency_stop, permissions: cfg.execPermissions || {}, permissionsOn: Object.values(cfg.execPermissions || {}).filter((v) => v === true).length };
  out.pending = { decisions: await prisma.ambOperatorDecision.count({ where: { ...(await dashAcctWhere()), status: 'PREPARED' } }), plans: await prisma.ambDailyPlan.count({ where: { AND: [await planAcctWhere()], status: 'PREPARED', simulated: false } }) };
  const last = await prisma.ambAction.findFirst({ where: { execution_status: { in: ['EXECUTED', 'VERIFIED', 'FAILED'] } }, orderBy: { id: 'desc' }, select: { id: true, action_type: true, entity_name: true, execution_status: true, executed_at: true, verified_at: true, ai_reason: true } });
  out.lastAction = last ? { id: last.id, action: last.action_type, campaign: last.entity_name, status: last.execution_status, verified: !!last.verified_at, at: (last.executed_at || null), reason: last.ai_reason || null } : null;
  out.policies = await policyStates();
  if (access.capabilities.approve) {
    const gate = await autopilotGate().catch(() => null); const steps = [];
    if (out.policies) for (const p of out.policies.list) if (p.state !== 'READY') steps.push({ key: `policy:${p.key}`, text: `${p.label}: ${p.detail}`, section: 'auto' });
    if (gate) for (const c of gate.checks) if (!c.ok) steps.push({ key: `gate:${c.key}`, text: c.label, detail: c.detail, section: STEP_TARGET[c.key] || 'set' });
    out.todo = steps;
  }
  return out;
}
