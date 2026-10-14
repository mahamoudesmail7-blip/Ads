// «حماية إعادة الفتح» — a campaign that OUR OWN system paused because of PERFORMANCE (high CPA / zero orders / loss / any rule we cannot prove was harmless) must never be re-opened UNATTENDED just because the long window
// (30 / 90 days) of «الفتح حسب CPA» still averages well. The long average includes the good days BEFORE it went bad. This module answers two questions, purely from the system's own records:
//   1) was it paused by the system, when, and was the cause PERFORMANCE?   → loadSystemPauses / classifyPauseCause  (fail-CLOSED: an unknown cause counts as performance)
//   2) does the RECENT (last 7 days) evidence contradict the policy range?   → recentContradiction
// A protected campaign becomes «NEEDS_SPECIAL_APPROVAL»: never ticked by the policy, never run by the unattended runner, still openable by the owner (special approval in the review screen, or «التشغيل اليدوي»).
// Read-only: nothing here writes or calls Meta.
import { prisma } from '../../prisma.js';

export const PROTECT_LOOKBACK_DAYS = 90; // the longest policy window — a pause inside it is part of the average the policy is looking at
export const KIND = Object.freeze({ PERFORMANCE: 'PERFORMANCE', HARMLESS: 'HARMLESS', MANUAL: 'MANUAL' });
export const PROTECTION_AR = Object.freeze({
  PAUSED_FOR_PERFORMANCE: 'اتقفلت من النظام بسبب أداء (CPA عالي / صرف بدون أوردرات / خسارة) — ممنوع تتفتح تلقائي حتى لو متوسط الفترة الطويلة كويس',
  RECENT_CPA_ABOVE_MAX: 'CPA آخر 7 أيام أعلى من الحد الأقصى — متوسط الفترة الطويلة لوحده مش كفاية',
});
// causes that are provably NOT about performance: stock, the daily closing routine, and the owner's own manual operation
const HARMLESS_RULE = /STOCK|SCHEDULED_CLOSE|DAILY_SCHEDULE|OUT_OF_STOCK/i;
const HARMLESS_TEXT = /STOCK_OUT|OUT_OF_STOCK|SCHEDULED_CLOSE|مخزون|المخزون|الإغلاق المجدول|إغلاق مجدول/;
const MANUAL_RULE = /^AUTO:MANUAL_/;

/** Pure. {source:'DECISION'|'ACTION', ruleName?, reasonText?, recSource?} → PERFORMANCE | HARMLESS | MANUAL. Anything we cannot prove harmless is PERFORMANCE (fail-closed). */
export function classifyPauseCause({ source, ruleName = '', reasonText = '', recSource = '' } = {}) {
  const rule = String(ruleName || ''); const text = String(reasonText || '');
  if (MANUAL_RULE.test(rule)) return KIND.MANUAL;
  if (String(recSource || '').toUpperCase() === 'MANUAL') return KIND.MANUAL;
  if (source === 'DECISION' && rule) return HARMLESS_RULE.test(rule) ? KIND.HARMLESS : KIND.PERFORMANCE;
  if (HARMLESS_TEXT.test(text) && !/CPA|HIGH_CPA|ZERO|بدون أوردر|خسار|LOSS/i.test(text)) return KIND.HARMLESS;
  return KIND.PERFORMANCE;
}

/** The latest executed pause per campaign inside the lookback → Map(campaignId → {at, kind, source, cause}). A performance pause always wins over a newer harmless one inside the window (it is the dangerous fact). */
export async function loadSystemPauses({ campaignIds, now = new Date(), days = PROTECT_LOOKBACK_DAYS, deps = {} } = {}) {
  const out = new Map(); const ids = [...new Set((campaignIds || []).map(String))]; if (!ids.length) return out;
  if (deps.pauseRows) { for (const r of deps.pauseRows) put(out, r); return out; }
  const since = new Date(now.getTime() - days * 86_400_000);
  const ds = await prisma.ambOperatorDecision.findMany({ where: { campaign_id: { in: ids }, action: 'PAUSE', status: { in: ['EXECUTED', 'VERIFIED'] }, executed_at: { gte: since } }, select: { campaign_id: true, rule_name: true, executed_at: true } });
  for (const d of ds) put(out, { campaignId: d.campaign_id, at: d.executed_at, kind: classifyPauseCause({ source: 'DECISION', ruleName: d.rule_name }), source: 'DECISION', cause: d.rule_name || null });
  const as = await prisma.ambAction.findMany({ where: { entity_id: { in: ids }, action_type: 'PAUSE', execution_status: 'EXECUTED', executed_at: { gte: since } }, select: { entity_id: true, executed_at: true, ai_reason: true, recommendation: { select: { reason: true, source: true } } } });
  for (const a of as) { const text = a.recommendation?.reason || a.ai_reason || ''; put(out, { campaignId: a.entity_id, at: a.executed_at, kind: classifyPauseCause({ source: 'ACTION', reasonText: text, recSource: a.recommendation?.source }), source: 'ACTION', cause: String(text).slice(0, 160) || null }); }
  return out;
}
const rank = { PERFORMANCE: 3, MANUAL: 2, HARMLESS: 1 };
function put(map, r) { const id = String(r.campaignId); const cur = map.get(id); const at = r.at instanceof Date ? r.at : new Date(r.at); const next = { at: at.toISOString(), kind: r.kind, source: r.source, cause: r.cause }; if (!cur || rank[next.kind] > rank[cur.kind] || (rank[next.kind] === rank[cur.kind] && next.at > cur.at)) map.set(id, next); }

/** Pure. The recent (last 7 days) numbers contradict the policy range: orders exist and the CPA is above the maximum. A campaign with no recent data is NOT contradicted (nothing to contradict it with). */
export function recentContradiction({ m7, maxCpa }) {
  if (!m7 || maxCpa == null) return null; const orders = Number(m7.purchases) || 0; const spend = Number(m7.spend);
  const cpa = m7.cpa != null ? Number(m7.cpa) : orders > 0 && Number.isFinite(spend) ? spend / orders : null;
  return orders > 0 && cpa != null && cpa > maxCpa ? { code: 'RECENT_CPA_ABOVE_MAX', cpa: Math.round(cpa), orders } : null;
}
