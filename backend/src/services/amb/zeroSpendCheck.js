// 🧾 DAILY ZERO-ORDER SPEND CHECK — a configurable, versioned, owner-approved policy: «a campaign that spent more than X today and brought ZERO orders is eligible for pausing».
//
//   The time is the moment the conditions are CHECKED, never a moment campaigns are closed. At the check time the policy
//     1. takes the ACTIVE campaigns it covers (ad accounts / all active / selected, minus exclusions),
//     2. reads each campaign's Spend and Orders for TODAY (Cairo calendar day, 00:00 → the check),
//     3. ELIGIBLE only if Orders = 0 AND Spend (> | ≥) the SAVED limit; Orders ≥ 1, or Spend within the limit → the campaign continues (for this policy),
//     4. anything uncertain (stale / failed sync, unknown or different ad-account timezone, missing data) → NO decision, an alert, and a retry until the grace window ends,
//     5. an ELIGIBLE campaign is then refined (never loosened): WINNER PROTECTION (a historically strong campaign goes to MANUAL REVIEW by default, or follows the rule, or is exempt — the owner's choice),
//        PROTECTED campaigns go to manual review, and the DAILY STOP LIMITS (max campaigns, max % of the active ones — this policy's own quota, separate from the account limits) send the surplus to manual review.
//   The limit, the comparison, the time, the scope, the winner thresholds and the stop limits are ALL read from the saved policy — nothing is hard-coded (150 / 13:00 / '>' are only the DEFAULTS of an empty policy).
//
//   Time zones: the day is the Cairo day. Meta's daily rows follow the AD ACCOUNT's day. The two are the same only if the account's UTC offset equals Cairo's at that moment; otherwise
//   the Cairo-day spend cannot be rebuilt from daily rows, so the account is reported INCOMPLETE and nothing is paused (never a silent mix of two clocks).
//   Orders: Meta-attributed purchases of the SAME campaign and day (Easy Orders payloads carry no campaign id, so they cannot be attributed to a campaign). Attribution delay is handled by the existing guards on the
//   eligible campaigns (a purchase seen in the last hours blocks the pause) and by the live re-check at execution (an order that appears before the owner approves expires the decision).
//
//   Execution = the EXISTING engine: decisions are persisted with persistCandidates (idempotent key per campaign + Cairo day), APPROVAL → PREPARED for the owner, AUTOMATIC → executeAutoDecision →
//   central write gate → the existing executor → independent read-back. One pause per campaign: if another rule already has a pause decision on the table for the same campaign, the reasons are MERGED into it (persistCandidates).
//   This module never talks to Meta for writes and never touches the daily plans.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getOperatorConfig, autopilotGate } from './operatorStore.js';
import { cairoDate, dueAtTime } from './dailyPlanTime.js';
import { listCampaignsFromSnapshots, buildOperatorWorld, loadCounters } from './operatorContext.js';
import { entityWindowMetrics } from './metricsEngine.js';
import { windowRange } from './operatorRules.js';
import { getSyncStatus } from './snapshotSync.js';
import { raiseAlert } from './alerts.js';
import { GATE_PERMISSION } from './writeGate.js';

export const KIND = 'DAILY_ZERO_SPEND';
export const CAIRO = 'Africa/Cairo';
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MS_M = 60_000;
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const fail = (status, message, code) => { const e = new Error(message); e.status = status; if (code) e.code = code; return e; };
const ids = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))] : []);
const numOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
export const WINNER_WARNING = 'الحملة رابحة تاريخيًا، لكنها تجاوزت حد الصرف اليوم بدون أوردرات';

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the policy (versioned; saving never enables, enabling = approving the CURRENT version)
// ---------------------------------------------------------------------------------------------------------------------------------------------
export const DEFAULT_ZS = Object.freeze({ enabled: false, version: 0, approved: null, updatedAt: null, updatedBy: null, history: [],
  checkTime: '13:00', limit: 150, comparison: 'GT', scope: 'ALL_ACTIVE', adAccountIds: [], includeCampaignIds: [], excludeCampaignIds: [], maxDataAgeMin: 30, retryMinutes: 180,
  winnerAction: 'MANUAL_REVIEW', winnerMinOrders30: 10, winnerMinOrders7: 2, winnerFallbackCpa: null, maxPausesPerDay: null, maxPausePct: null, protectedCampaignIds: [] });
export function normalizeZs(raw = {}) {
  const r = raw || {}; const D = DEFAULT_ZS; const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
  return { enabled: r.enabled === true, version: Number(r.version) || 0, approved: r.approved || null, updatedAt: r.updatedAt || null, updatedBy: r.updatedBy ?? null, history: Array.isArray(r.history) ? r.history : [],
    checkTime: typeof r.checkTime === 'string' && r.checkTime.trim() ? r.checkTime.trim() : D.checkTime, limit: num(r.limit, D.limit), comparison: ['GT', 'GTE'].includes(r.comparison) ? r.comparison : (r.comparison == null ? D.comparison : String(r.comparison)),
    scope: ['ALL_ACTIVE', 'SELECTED'].includes(r.scope) ? r.scope : (r.scope == null ? D.scope : String(r.scope)), adAccountIds: ids(r.adAccountIds), includeCampaignIds: ids(r.includeCampaignIds), excludeCampaignIds: ids(r.excludeCampaignIds),
    maxDataAgeMin: num(r.maxDataAgeMin, D.maxDataAgeMin), retryMinutes: num(r.retryMinutes, D.retryMinutes),
    winnerAction: ['MANUAL_REVIEW', 'RULE', 'EXEMPT'].includes(r.winnerAction) ? r.winnerAction : (r.winnerAction == null ? D.winnerAction : String(r.winnerAction)), winnerMinOrders30: num(r.winnerMinOrders30, D.winnerMinOrders30), winnerMinOrders7: num(r.winnerMinOrders7, D.winnerMinOrders7), winnerFallbackCpa: numOrNull(r.winnerFallbackCpa),
    maxPausesPerDay: numOrNull(r.maxPausesPerDay), maxPausePct: numOrNull(r.maxPausePct), protectedCampaignIds: ids(r.protectedCampaignIds) };
}
export function validateZs(p) {
  const e = []; if (!HHMM.test(String(p.checkTime))) e.push('موعد الفحص: صيغة HH:MM مطلوبة (00:00 – 23:59).');
  if (!Number.isFinite(p.limit) || p.limit <= 0 || p.limit > 1_000_000) e.push('حد الصرف لازم يكون رقم أكبر من صفر.');
  if (!['GT', 'GTE'].includes(p.comparison)) e.push('شرط الصرف لازم يكون «أكبر من» أو «أكبر من/يساوي».'); if (!['ALL_ACTIVE', 'SELECTED'].includes(p.scope)) e.push('نطاق التطبيق لازم يكون كل الحملات النشطة أو حملات محددة.');
  if (p.scope === 'SELECTED' && !p.includeCampaignIds.length) e.push('نطاق «حملات محددة» محتاج تختار حملة واحدة على الأقل.');
  if (!Number.isFinite(p.maxDataAgeMin) || p.maxDataAgeMin < 5 || p.maxDataAgeMin > 240) e.push('أقصى عمر للبيانات لازم يكون بين 5 و240 دقيقة.'); if (!Number.isFinite(p.retryMinutes) || p.retryMinutes < 15 || p.retryMinutes > 600) e.push('مهلة إعادة المحاولة لازم تكون بين 15 و600 دقيقة.');
  if (!['MANUAL_REVIEW', 'RULE', 'EXEMPT'].includes(p.winnerAction)) e.push('تصرف حماية الحملات الرابحة لازم يكون: مراجعة يدوية أو حسب القاعدة أو استثناء.');
  if (!Number.isFinite(p.winnerMinOrders30) || p.winnerMinOrders30 < 1 || p.winnerMinOrders30 > 1000) e.push('أقل أوردرات 30 يوم لتصنيف Winner لازم تكون بين 1 و1000.'); if (!Number.isFinite(p.winnerMinOrders7) || p.winnerMinOrders7 < 1 || p.winnerMinOrders7 > 1000) e.push('أقل أوردرات 7 أيام لتصنيف Winner لازم تكون بين 1 و1000.');
  if (p.winnerFallbackCpa != null && (!Number.isFinite(p.winnerFallbackCpa) || p.winnerFallbackCpa <= 0)) e.push('CPA البديل لتصنيف Winner لازم يكون رقم موجب أو فاضي.');
  if (p.maxPausesPerDay != null && (!Number.isInteger(p.maxPausesPerDay) || p.maxPausesPerDay < 0 || p.maxPausesPerDay > 500)) e.push('أقصى عدد إيقافات يومية لازم يكون رقم صحيح بين 0 و500 (أو فاضي = بدون حد).');
  if (p.maxPausePct != null && (!Number.isFinite(p.maxPausePct) || p.maxPausePct < 0 || p.maxPausePct > 100)) e.push('أقصى نسبة إيقاف لازم تكون بين 0 و100 (أو فاضي = بدون حد).');
  return e;
}
const MATERIAL = ['checkTime', 'limit', 'comparison', 'scope', 'adAccountIds', 'includeCampaignIds', 'excludeCampaignIds', 'maxDataAgeMin', 'retryMinutes', 'winnerAction', 'winnerMinOrders30', 'winnerMinOrders7', 'winnerFallbackCpa', 'maxPausesPerDay', 'maxPausePct', 'protectedCampaignIds'];
const snap = (p) => ({ version: p.version, enabled: p.enabled, ...Object.fromEntries(MATERIAL.map((k) => [k, p[k]])) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const zeroSpendActive = (p) => !!(p?.enabled && p.approved && p.approved.version === p.version);
async function readRaw() { const row = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const raw = j(row?.limits_json, null) || {}; return { raw, policy: normalizeZs(raw.zeroSpendCheck) }; }
async function write(raw, policy, userId) { await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify({ ...raw, zeroSpendCheck: policy }), updated_by_id: userId ?? null } }); }
const audit = (userId, kind, input) => prisma.aiAuditLog.create({ data: { actor_id: userId ?? null, kind, action: 'EXECUTE', input_json: JSON.stringify(input).slice(0, 3500), success: true } }).catch(() => {});
const event = (userId, kind, note, data = {}) => prisma.ambOperatorEvent.create({ data: { kind, actor: 'USER', actor_id: userId ?? null, note, data_json: JSON.stringify(data).slice(0, 3500) } }).catch(() => {});
async function requireAdmin(userId, deps = {}) { const u = deps.user || await prisma.user.findUnique({ where: { id: Number(userId) }, select: { id: true, role: true, status: true } }); if (!u || u.role !== 'ADMIN' || u.status !== 'ACTIVE') throw fail(403, 'ده محتاج ADMIN.', 'FORBIDDEN'); return u; }
export async function getZeroSpendPolicy() { return (await readRaw()).policy; }

/** Saves a NEW VERSION when a material field changed; the approval of the previous version stops counting (the policy is inactive until the owner approves this version). */
export async function saveZeroSpendPolicy({ patch, userId, deps = {} }) {
  await requireAdmin(userId, deps); const { raw, policy: cur } = await readRaw();
  const next = normalizeZs({ ...cur, ...(patch || {}), enabled: cur.enabled, version: cur.version, approved: cur.approved, history: cur.history });
  const errors = validateZs(next); if (errors.length) { const e = fail(400, errors.join(' '), 'INVALID_POLICY'); e.details = errors; throw e; }
  const changed = cur.version === 0 || !same(snap({ ...cur, version: 0, enabled: false }), snap({ ...next, version: 0, enabled: false })); // the first save always creates version 1 (even with the defaults)
  if (!changed) return { policy: cur, changed: false, active: zeroSpendActive(cur) };
  const version = cur.version + 1; const saved = { ...next, version, approved: null, updatedAt: new Date().toISOString(), updatedBy: Number(userId), history: [...cur.history, { ...snap(cur), replacedAt: new Date().toISOString(), by: Number(userId) }].slice(-20) };
  await write(raw, saved, userId); await audit(userId, 'OPERATOR_ZERO_SPEND_POLICY_SAVE', { version, policy: snap(saved) }); await event(userId, 'ZERO_SPEND_POLICY_SAVED', `سياسة الصرف بدون أوردرات v${version}: ${describePolicy(saved)} (محتاجة اعتماد)`, { version });
  return { policy: saved, changed: true, active: false };
}
/** enabled:true APPROVES the current version (needs confirm); enabled:false switches the policy off. Neither pauses anything by itself. */
export async function setZeroSpendEnabled({ enabled, confirm, userId, deps = {} }) {
  await requireAdmin(userId, deps); if (confirm !== true) throw fail(400, 'محتاج تأكيد صريح (confirm).', 'CONFIRM_REQUIRED'); const { raw, policy: cur } = await readRaw();
  if (enabled) { const errors = validateZs(cur); if (errors.length) { const e = fail(400, errors.join(' '), 'INVALID_POLICY'); e.details = errors; throw e; } }
  const next = { ...cur, enabled: !!enabled, approved: enabled ? { version: cur.version, at: new Date().toISOString(), by: Number(userId) } : cur.approved, updatedAt: new Date().toISOString(), updatedBy: Number(userId) };
  await write(raw, next, userId); await audit(userId, 'OPERATOR_ZERO_SPEND_POLICY_ENABLE', { version: cur.version, enabled: !!enabled }); await event(userId, 'ZERO_SPEND_POLICY_ENABLED', enabled ? `اعتماد سياسة الصرف بدون أوردرات v${cur.version} — مفيش حملة اتوقفت بالاعتماد` : 'إيقاف سياسة الصرف بدون أوردرات', { version: cur.version });
  return { policy: next, active: zeroSpendActive(next) };
}
const WACT_AR = { MANUAL_REVIEW: 'مراجعة يدوية', RULE: 'إيقاف حسب القاعدة', EXEMPT: 'استثناء من السياسة' };
export function describePolicy(p) {
  const cmp = p.comparison === 'GTE' ? 'أكبر من أو يساوي' : 'أكبر من'; const scope = p.scope === 'SELECTED' ? `${p.includeCampaignIds.length} حملة محددة` : 'كل الحملات النشطة'; const acc = p.adAccountIds.length ? `${p.adAccountIds.length} حساب إعلاني` : 'الحساب المتصل';
  const lim = [p.maxPausesPerDay != null ? `أقصى ${p.maxPausesPerDay} إيقاف يوميًا` : null, p.maxPausePct != null ? `أقصى ${p.maxPausePct}% من الحملات النشطة` : null].filter(Boolean).join(' · ');
  return `فحص يومي الساعة ${p.checkTime} (القاهرة): أي حملة صرفها اليوم ${cmp} ${p.limit} ج.م وأوردراتها اليوم = 0 تبقى مؤهلة للإيقاف — النطاق: ${scope} · ${acc}${p.excludeCampaignIds.length ? ` · مستثنى ${p.excludeCampaignIds.length} حملة` : ''}. الحملة الرابحة تاريخيًا: ${WACT_AR[p.winnerAction]}${p.protectedCampaignIds.length ? ` · ${p.protectedCampaignIds.length} حملة أساسية محمية (مراجعة يدوية)` : ''}${lim ? ` · ${lim} (الزيادة للمراجعة اليدوية)` : ' · بدون حد أقصى للإيقافات'}.`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// time zones
// ---------------------------------------------------------------------------------------------------------------------------------------------
export function tzOffsetMinutes(tz, at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second); return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / MS_M);
}
const tzCache = new Map();
/** the ad account's IANA timezone (Meta `timezone_name`), cached 24h; null when it cannot be read */
export async function accountTimezone(adAccountId, { deps = {} } = {}) {
  if (deps.accountTz) return deps.accountTz(adAccountId);
  const hit = tzCache.get(adAccountId); if (hit && Date.now() - hit.at < 86_400_000) return hit.tz;
  try { const [G, MA] = await Promise.all([import('../metaGraphClient.js'), import('../metaAuth.js')]); const info = await G.getAdAccountInfo(await MA.getDecryptedToken(), adAccountId); const tz = info?.timezone_name || null; if (tz) tzCache.set(adAccountId, { tz, at: Date.now() }); return tz; } catch { return null; }
}
export const _resetTzCache = () => tzCache.clear();

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the decision (pure) + Winner classification + daily stop limits
// ---------------------------------------------------------------------------------------------------------------------------------------------
export const STATE_LABEL = { CONTINUE: 'استمرار', ELIGIBLE: 'مؤهلة للإيقاف', REVIEW: 'تحتاج مراجعة يدوية', INCOMPLETE: 'بيانات غير مكتملة', EXCLUDED: 'مستثناة', OUT_OF_SCOPE: 'خارج النطاق' };
export function decideZeroSpend({ policy, campaign, spend, orders, data = { ok: true } }) {
  if (policy.excludeCampaignIds.includes(String(campaign.id))) return { state: 'EXCLUDED', code: 'EXCLUDED_BY_POLICY', reason: 'الحملة مستثناة من السياسة.' };
  if (policy.scope === 'SELECTED' && !policy.includeCampaignIds.includes(String(campaign.id))) return { state: 'OUT_OF_SCOPE', code: 'NOT_SELECTED', reason: 'الحملة مش ضمن الحملات المحددة.' };
  if (policy.adAccountIds.length && !policy.adAccountIds.includes(String(campaign.adAccountId))) return { state: 'OUT_OF_SCOPE', code: 'ACCOUNT_NOT_SELECTED', reason: 'الحساب الإعلاني مش ضمن الحسابات المحددة.' };
  if (!data.ok) return { state: 'INCOMPLETE', code: data.code || 'DATA_INCOMPLETE', reason: data.reason || 'بيانات غير مكتملة — مفيش قرار.' };
  if (spend == null || orders == null || !Number.isFinite(Number(spend)) || !Number.isFinite(Number(orders))) return { state: 'INCOMPLETE', code: 'METRICS_MISSING', reason: 'الصرف أو الأوردرات اليوم غير متاحين — مفيش قرار.' };
  if (Number(orders) >= 1) return { state: 'CONTINUE', code: 'ORDERS_PRESENT', reason: `${orders} أوردر اليوم — الحملة مستمرة بالنسبة لهذه السياسة.` };
  const over = policy.comparison === 'GTE' ? Number(spend) >= policy.limit : Number(spend) > policy.limit; const sign = policy.comparison === 'GTE' ? '≥' : '>';
  return over ? { state: 'ELIGIBLE', code: 'ZERO_ORDERS_OVER_LIMIT', reason: `صرف ${spend} ${sign} ${policy.limit} ج.م وصفر أوردر اليوم.` } : { state: 'CONTINUE', code: 'SPEND_WITHIN_LIMIT', reason: `صرف ${spend} داخل الحد (${policy.limit}) — الحملة مستمرة.` };
}
export const WINNER_LABEL = { WINNER: 'رابحة (Winner)', NOT_WINNER: 'مش Winner', UNKNOWN: 'غير معروف (UNKNOWN)' };
const hist = (m) => ({ orders: m ? Number(m.purchases ?? 0) : 0, spend: m ? Math.round(Number(m.spend ?? 0) * 100) / 100 : 0, cpa: m && Number(m.purchases) > 0 ? Math.round(Number(m.spend) / Number(m.purchases)) : null });
/**
 * Winner is NEVER judged on CPA alone. It needs (1) fresh data, (2) enough orders in BOTH the 30-day and 7-day windows (thresholds are policy settings), (3) a PROFIT LIMIT to judge the CPA against — the product's confirmed
 * Maximum (else Target) CPA, or the policy's own fallback CPA — and (4) the recent trend not collapsing. Anything missing → UNKNOWN, never an invented class. Pure.
 */
export function classifyWinner({ h3, h7, h30, limit = null, policy, dataOk = true }) {
  const c3 = h3?.cpa ?? null, c7 = h7?.cpa ?? null; const trend = h3 && h3.orders >= 2 && c3 != null && c7 != null ? (c3 <= c7 * 0.9 ? 'IMPROVING' : c3 >= c7 * 1.15 ? 'DECLINING' : 'FLAT') : 'UNKNOWN';
  const base = { trend, limit, cpa: { d3: c3, d7: c7, d30: h30?.cpa ?? null } };
  if (!dataOk) return { ...base, status: 'UNKNOWN', code: 'DATA_NOT_FRESH', reason: 'البيانات مش حديثة — مفيش تصنيف.' };
  if (!h30 || h30.orders < policy.winnerMinOrders30 || !h7 || h7.orders < policy.winnerMinOrders7) return { ...base, status: 'UNKNOWN', code: 'HISTORY_INSUFFICIENT', reason: `التاريخ غير كافٍ (محتاج ${policy.winnerMinOrders30}+ أوردر في 30 يوم و${policy.winnerMinOrders7}+ في 7 أيام).` };
  if (limit == null) return { ...base, status: 'UNKNOWN', code: 'NO_PROFIT_LIMIT', reason: 'مفيش حد ربحية للمنتج (Max/Target CPA) ولا CPA بديل في السياسة — مينفعش نحكم إنها رابحة.' };
  const strong = h30.cpa != null && h30.cpa <= limit && h7.cpa != null && h7.cpa <= limit && !(trend === 'DECLINING' && h3.orders >= 2 && c3 > limit);
  return strong ? { ...base, status: 'WINNER', code: 'WINNER', reason: `CPA 30 يوم ${h30.cpa} و7 أيام ${h7.cpa} داخل حد الربحية ${limit} بـ ${h30.orders}/${h7.orders} أوردر.` } : { ...base, status: 'NOT_WINNER', code: 'NOT_WINNER', reason: `CPA 30 يوم ${h30.cpa ?? '—'} / 7 أيام ${h7.cpa ?? '—'} مش كله داخل حد الربحية ${limit}${trend === 'DECLINING' ? ' والاتجاه الأخير بيسوء' : ''}.` };
}
/**
 * Refines the base verdicts (rows already carry state/code/reason + winner + protected). Only ever moves ELIGIBLE → REVIEW / EXCLUDED, never the other way:
 *   Winner: RULE keeps ELIGIBLE (with the warning), MANUAL_REVIEW → REVIEW, EXEMPT → EXCLUDED · protected campaign → REVIEW · surplus over the policy's own daily stop limits → REVIEW (highest spend keeps the quota).
 */
export function applyRefinements(rows, policy, { executedToday = 0 } = {}) {
  const warn = [];
  for (const r of rows) {
    if (r.state !== 'ELIGIBLE') continue;
    if (policy.protectedCampaignIds.includes(String(r.campaignId))) { r.state = 'REVIEW'; r.code = 'PROTECTED_CAMPAIGN'; r.reason = `${r.reason} — حملة أساسية محمية من الإيقاف التلقائي: مراجعة يدوية.`; continue; }
    if (r.winner?.status === 'WINNER') {
      r.warning = WINNER_WARNING;
      if (policy.winnerAction === 'EXEMPT') { r.state = 'EXCLUDED'; r.code = 'WINNER_EXEMPT'; r.reason = `${WINNER_WARNING} — مستثناة حسب إعداد حماية الـWinner.`; }
      else if (policy.winnerAction === 'MANUAL_REVIEW') { r.state = 'REVIEW'; r.code = 'WINNER_REVIEW'; r.reason = `${WINNER_WARNING} — محتاجة مراجعة يدوية (مفيش إيقاف تلقائي).`; }
      else r.reason = `${r.reason} ⚠️ ${WINNER_WARNING} (الإعداد: إيقاف حسب القاعدة).`;
    }
  }
  const covered = rows.filter((r) => !['EXCLUDED', 'OUT_OF_SCOPE'].includes(r.state) || r.code === 'WINNER_EXEMPT').length; const cands = rows.filter((r) => r.state === 'ELIGIBLE').sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0));
  const byPct = policy.maxPausePct != null ? Math.floor((covered * policy.maxPausePct) / 100) : Infinity; const byCount = policy.maxPausesPerDay != null ? policy.maxPausesPerDay : Infinity;
  const quota = Math.max(0, Math.min(byPct, byCount) - executedToday);
  if (Number.isFinite(quota)) cands.forEach((r, n) => { if (n >= quota) { r.state = 'REVIEW'; r.code = 'DAILY_STOP_LIMIT'; r.reason = `${r.reason} — تجاوزت حد الإيقافات اليومية للسياسة (${Number.isFinite(byCount) ? `${byCount} حملة` : ''}${Number.isFinite(byCount) && Number.isFinite(byPct) ? ' / ' : ''}${Number.isFinite(byPct) ? `${policy.maxPausePct}% = ${byPct}` : ''}، اتنفذ ${executedToday}): للمراجعة اليدوية.`; warn.push(r.campaignId); } });
  return { quota: Number.isFinite(quota) ? quota : null, overLimit: warn.length };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// evaluate (read-only): today's data → one row per covered campaign
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function accountsOf(policy, deps) {
  if (policy.adAccountIds.length) return policy.adAccountIds;
  if (deps.selectedAccount) return [await deps.selectedAccount()].filter(Boolean);
  const conn = await (await import('../metaAuth.js')).getConnection(); return conn?.selected_ad_account_id ? [conn.selected_ad_account_id] : [];
}
async function historyOf(acc, date, deps) {
  if (deps.historyMetrics) return deps.historyMetrics(acc, date);
  const out = {}; for (const k of ['last3', 'last7', 'last30']) { const r = windowRange(k, date); out[k] = await entityWindowMetrics({ level: 'campaign', from: r.from, to: r.to, adAccountId: acc }, { force: !!deps.forceFresh }); } return out;
}
async function profitLimitOf(campaignId, cache, deps) {
  if (deps.profitLimitOf) return deps.profitLimitOf(campaignId);
  try { const INT = await import('./integration.js'); const idn = await INT.campaignIdentity(campaignId); if (idn?.productId == null || !idn.verified) return null; if (!cache.has(idn.productId)) { const RD = await import('./operatorReadiness.js'); const p = await RD.getProductProfile({ productId: idn.productId }).catch(() => null); cache.set(idn.productId, p ? (p.economics.maxCpa.value ?? p.economics.targetCpa.value ?? null) : null); } return cache.get(idn.productId); } catch { return null; }
}
const OPEN_STATUSES = ['PREPARED', 'APPROVED', 'EXECUTING', 'EXECUTED', 'VERIFIED'];
/** other things that already want (or did) to pause the same campaign — shown in the preview and used so that ONE pause request exists per campaign */
async function conflictsFor(campaignIds, date, now, deps) {
  if (deps.conflictsOf) return deps.conflictsOf(campaignIds, date);
  const out = new Map(campaignIds.map((id) => [id, []])); if (!campaignIds.length) return out;
  const since = new Date(now.getTime() - 24 * 3_600_000);
  for (const d of await prisma.ambOperatorDecision.findMany({ where: { campaign_id: { in: campaignIds }, action: 'PAUSE', rule_name: { startsWith: 'AUTO:' }, status: { in: OPEN_STATUSES }, created_at: { gte: since } }, select: { campaign_id: true, rule_name: true, status: true } }).catch(() => [])) out.get(d.campaign_id)?.push({ code: d.rule_name === `AUTO:${KIND}` ? 'SAME_POLICY_DECISION' : 'OTHER_PAUSE_DECISION', detail: `${d.rule_name.replace('AUTO:', '')} (${d.status})` });
  for (const it of await prisma.ambDailyPlanItem.findMany({ where: { campaign_id: { in: campaignIds }, selected: true, plan: { type: 'PAUSE', plan_date: date, status: { in: ['PREPARED', 'APPROVED', 'RUNNING'] } } }, select: { campaign_id: true } }).catch(() => [])) out.get(it.campaign_id)?.push({ code: 'PAUSE_PLAN_SELECTED', detail: 'الحملة مختارة في خطة الإيقاف اليومية' });
  for (const e of await prisma.ambOperatorEvent.findMany({ where: { kind: 'MANUAL_OVERRIDE', campaign_id: { in: campaignIds }, created_at: { gte: since } }, select: { campaign_id: true } }).catch(() => [])) out.get(e.campaign_id)?.push({ code: 'MANUAL_OVERRIDE_RECENT', detail: 'تعديل يدوي أحدث (آخر 24 ساعة)' });
  return out;
}
async function executedTodayCount(date, deps) {
  if (deps.executedToday) return deps.executedToday(date);
  const rows = await prisma.ambOperatorDecision.findMany({ where: { rule_name: `AUTO:${KIND}`, status: { in: ['EXECUTING', 'EXECUTED', 'VERIFIED'] }, created_at: { gte: new Date(Date.now() - 48 * 3_600_000) } }, select: { evidence_json: true } }).catch(() => []);
  return rows.filter((d) => j(d.evidence_json, {})?.zeroSpend?.date === date).length;
}
export async function evaluateZeroSpendCheck({ now = new Date(), policy = null, deps = {} } = {}) {
  const pol = policy ? normalizeZs(policy) : await getZeroSpendPolicy(); const date = cairoDate(now); const dayStart = dueAtTime(date, '00:00'); const checkAt = dueAtTime(date, pol.checkTime);
  const sync = await (deps.syncStatus ? deps.syncStatus() : getSyncStatus().catch(() => null)); const asOf = sync?.lastSuccessAt ? new Date(sync.lastSuccessAt) : null;
  const ageMin = asOf ? (now.getTime() - asOf.getTime()) / MS_M : null; const syncOk = asOf != null && ageMin <= pol.maxDataAgeMin && ageMin >= -5;
  const reliability = !syncOk ? (asOf ? 'LOW' : 'NONE') : ageMin <= pol.maxDataAgeMin / 2 ? 'HIGH' : 'MEDIUM';
  const out = { date, window: { from: dayStart.toISOString(), to: now.toISOString(), timezone: CAIRO }, checkAt: checkAt.toISOString(), dataAsOf: asOf ? asOf.toISOString() : null, dataAgeMin: ageMin == null ? null : Math.round(ageMin), syncOk, reliability, policy: { version: pol.version, checkTime: pol.checkTime, limit: pol.limit, comparison: pol.comparison, scope: pol.scope }, accounts: [], rows: [] };
  const limitCache = new Map();
  for (const acc of await accountsOf(pol, deps)) {
    const tz = await accountTimezone(acc, { deps }); const cairoOff = tzOffsetMinutes(CAIRO, now); const accOff = tz ? tzOffsetMinutes(tz, now) : null;
    const tzOk = tz != null && accOff === cairoOff; const data = !syncOk ? { ok: false, code: asOf ? 'DATA_STALE' : 'NO_SYNC', reason: asOf ? `آخر مزامنة Meta من ${Math.round(ageMin)} دقيقة (الحد ${pol.maxDataAgeMin}) — مفيش قرار على بيانات قديمة.` : 'مفيش مزامنة Meta ناجحة — مفيش قرار.' }
      : tz == null ? { ok: false, code: 'ACCOUNT_TZ_UNKNOWN', reason: 'مقدرناش نعرف توقيت الحساب الإعلاني — مينفعش نحدد يوم الصرف بدقة.' }
      : !tzOk ? { ok: false, code: 'ACCOUNT_TZ_MISMATCH', reason: `توقيت الحساب الإعلاني (${tz}) مختلف عن القاهرة — يوم Meta غير مطابق ليوم القاهرة، فمفيش قرار.` } : { ok: true };
    const accInfo = { adAccountId: acc, timezone: tz, dataOk: data.ok, code: data.code || null, reliability: data.ok ? reliability : 'LOW' }; out.accounts.push(accInfo);
    const campaigns = (await (deps.campaignsOf ? deps.campaignsOf(acc) : listCampaignsFromSnapshots({ adAccountId: acc }))).filter((c) => c.status === 'ACTIVE');
    let metrics = new Map(); if (data.ok || deps.metricsAlways) { try { metrics = await (deps.todayMetrics ? deps.todayMetrics(acc, date) : entityWindowMetrics({ level: 'campaign', from: date, to: date, adAccountId: acc }, { force: !!deps.forceFresh })); } catch (e) { accInfo.metricsError = String(e.message).slice(0, 120); } }
    let H = { last3: new Map(), last7: new Map(), last30: new Map() }; if (data.ok || deps.metricsAlways) { try { H = await historyOf(acc, date, deps); } catch (e) { accInfo.historyError = String(e.message).slice(0, 120); } }
    for (const c of campaigns) {
      const m = metrics.get(c.id); const spend = m ? Number(m.spend ?? 0) : (data.ok ? 0 : null); const orders = m ? Number(m.purchases ?? 0) : (data.ok ? 0 : null);
      const d = decideZeroSpend({ policy: pol, campaign: { id: c.id, adAccountId: acc }, spend, orders, data });
      const h3 = hist(H.last3?.get(c.id)), h7 = hist(H.last7?.get(c.id)), h30 = hist(H.last30?.get(c.id)); const relevant = ['ELIGIBLE', 'CONTINUE', 'INCOMPLETE'].includes(d.state) || d.state === 'EXCLUDED';
      const winner = relevant ? classifyWinner({ h3, h7, h30, limit: (await profitLimitOf(c.id, limitCache, deps)) ?? pol.winnerFallbackCpa, policy: pol, dataOk: data.ok }) : { status: 'UNKNOWN', code: 'NOT_EVALUATED', reason: '—', trend: 'UNKNOWN', limit: null, cpa: {} };
      out.rows.push({ campaignId: c.id, campaignName: (c.name || '').trim(), adAccountId: acc, budget: c.budget ?? null, spend: spend == null ? null : Math.round(spend * 100) / 100, orders, limit: pol.limit, comparison: pol.comparison, baseState: d.state, state: d.state, stateLabel: STATE_LABEL[d.state], code: d.code, reason: d.reason,
        history: { d3: h3, d7: h7, d30: h30, trend: winner.trend }, winner: { status: winner.status, label: WINNER_LABEL[winner.status], code: winner.code, reason: winner.reason, limit: winner.limit }, warning: null, conflicts: [], sync: { asOf: out.dataAsOf, ageMin: out.dataAgeMin, reliability: accInfo.reliability } });
    }
  }
  const executedToday = await executedTodayCount(date, deps); const ref = applyRefinements(out.rows, pol, { executedToday }); out.limits = { maxPausesPerDay: pol.maxPausesPerDay, maxPausePct: pol.maxPausePct, executedToday, quotaLeft: ref.quota, overLimit: ref.overLimit };
  const flagged = out.rows.filter((r) => ['ELIGIBLE', 'REVIEW'].includes(r.state)).map((r) => r.campaignId); const conf = await conflictsFor(flagged, date, now, deps); for (const r of out.rows) { r.conflicts = (conf.get(r.campaignId) || []).filter((x) => x.code !== 'SAME_POLICY_DECISION'); r.hasOtherPause = r.conflicts.some((x) => ['OTHER_PAUSE_DECISION', 'PAUSE_PLAN_SELECTED'].includes(x.code)); }
  for (const r of out.rows) r.stateLabel = STATE_LABEL[r.state];
  const count = (s) => out.rows.filter((r) => r.state === s).length; out.summary = { total: out.rows.length, ELIGIBLE: count('ELIGIBLE'), CONTINUE: count('CONTINUE'), REVIEW: count('REVIEW'), INCOMPLETE: count('INCOMPLETE'), EXCLUDED: count('EXCLUDED'), OUT_OF_SCOPE: count('OUT_OF_SCOPE'), winnersAtRisk: out.rows.filter((r) => r.baseState === 'ELIGIBLE' && r.winner.status === 'WINNER').length };
  return out;
}
/** the decision row of today for one campaign (what the screen shows as approval / execution state) */
const decisionKey = (campaignId, date) => crypto.createHash('sha1').update(`zs|${campaignId}|${date}`).digest('hex').slice(0, 24);
export async function todayDecisions({ date }) {
  const all = await prisma.ambOperatorDecision.findMany({ where: { rule_name: `AUTO:${KIND}`, created_at: { gte: new Date(Date.now() - 48 * 3_600_000) } }, orderBy: { id: 'desc' }, select: { id: true, campaign_id: true, status: true, error: true, decision_key: true, evidence_json: true, approved_by_id: true, approval_source: true, amb_action_id: true } });
  const m = new Map(); for (const d of all) { if (j(d.evidence_json, {})?.zeroSpend?.date === date && !m.has(d.campaign_id)) m.set(d.campaign_id, d); } return m;
}
export const STATUS_LABEL = { SHADOW: 'محاكاة', PREPARED: 'مجهّز لموافقتك', BLOCKED: 'ممنوع', EXECUTING: 'بيتنفذ', EXECUTED: 'اتنفذ (مستنّي التأكيد)', VERIFIED: 'اتنفذ واتأكد من Meta', FAILED: 'فشل', EXPIRED: 'اتبطل (الأدلة اتغيّرت)', ROLLED_BACK: 'اترجع', REJECTED: 'مرفوض' };

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the run (called from the operator scheduler every tick)
// ---------------------------------------------------------------------------------------------------------------------------------------------
export async function runZeroSpendCheck({ now = new Date(), deps = {} } = {}) {
  const config = await (deps.config ? (typeof deps.config === 'function' ? deps.config() : deps.config) : getOperatorConfig()); const pol = await getZeroSpendPolicy();
  if (!pol.enabled) return { ran: false, why: ['POLICY_DISABLED'] }; if (!zeroSpendActive(pol)) return { ran: false, why: ['POLICY_NOT_APPROVED_AT_CURRENT_VERSION'] };
  if (config.mode === 'OFF') return { ran: false, why: ['MODE_MANUAL'] };
  const date = cairoDate(now); const checkAt = dueAtTime(date, pol.checkTime); if (now.getTime() < checkAt.getTime()) return { ran: false, why: ['NOT_DUE'], checkAt: checkAt.toISOString() };
  const marker = `zs:${date}`; const done = await prisma.ambOperatorEvent.findFirst({ where: { kind: 'ZERO_SPEND_CHECK', campaign_id: marker } }); if (done) return { ran: false, why: ['ALREADY_CHECKED_TODAY'] };
  const graceEnd = new Date(checkAt.getTime() + pol.retryMinutes * MS_M);
  // fresh Meta data at the check (the same refresh helper the daily plans use) and metrics read bypassing the 45 s cache
  let fresh = null; try { const { ensureFreshData } = await import('./dailyPlans.js'); fresh = await ensureFreshData({ now, deps: deps.fresh || {} }); } catch (e) { fresh = { state: 'STALE', error: e.message }; }
  const ev = await evaluateZeroSpendCheck({ now, policy: pol, deps: { ...(deps.eval || {}), forceFresh: true } });
  const incomplete = ev.rows.filter((r) => r.state === 'INCOMPLETE'); const accountsBad = ev.accounts.filter((a) => !a.dataOk);
  if ((!ev.syncOk || accountsBad.length) && now.getTime() < graceEnd.getTime()) return { ran: false, why: [accountsBad[0]?.code || (ev.syncOk ? 'DATA_INCOMPLETE' : 'DATA_STALE')], retryUntil: graceEnd.toISOString(), freshState: fresh?.state || null };
  if (!ev.syncOk || accountsBad.length) { // the grace window is over and the data never became trustworthy: no decision today, an alert, and the day is closed
    await prisma.ambOperatorEvent.create({ data: { kind: 'ZERO_SPEND_CHECK', actor: 'SYSTEM', campaign_id: marker, note: `فحص الصرف بدون أوردرات ${date}: فات من غير بيانات موثوقة (${accountsBad[0]?.code || 'DATA_STALE'})`, data_json: JSON.stringify({ date, status: 'MISSED', version: pol.version, why: accountsBad.map((a) => a.code) }) } });
    await raiseAlert({ severity: 'WARNING', category: 'OPERATOR', title: 'فحص الصرف بدون أوردرات اتعطّل: بيانات غير موثوقة', message: `ما اتوقفتش أي حملة. السبب: ${accountsBad[0]?.code || 'DATA_STALE'} — اتحقق من مزامنة Meta وتوقيت الحساب الإعلاني.`, dedupeKey: `zerospend:missed:${date}` }).catch(() => {});
    return { ran: false, missed: true, why: [accountsBad[0]?.code || 'DATA_STALE'] };
  }
  const out = { ran: true, date, evaluated: ev.rows.length, summary: ev.summary, limits: ev.limits, eligible: [], persisted: { created: 0, updated: 0, merged: 0 }, executed: [], deferred: [] };
  const flagged = ev.rows.filter((r) => ['ELIGIBLE', 'REVIEW'].includes(r.state)); const mode = config.mode; const perm = config.execPermissions || {}; const gateKey = GATE_PERMISSION.PAUSE; const permissionOn = perm[gateKey] === true;
  const { persistCandidates, executeAutoDecision, tickGate, pauseGuards } = await import('./automationEngine.js');
  let world = null, counters = null;
  const cands = [];
  for (const r of flagged) {
    let blockers = [];
    if (deps.guardsOf) blockers = await deps.guardsOf({ campaignId: r.campaignId, row: r }); else {
      try { world = world || await buildOperatorWorld({ windowKeys: ['today'], now }); counters = counters || await loadCounters({ now, campaigns: world.campaigns }); const c = world.campaigns.find((x) => x.id === r.campaignId) || { id: r.campaignId, name: r.campaignName, status: 'ACTIVE' };
        blockers = await pauseGuards({ world, cx: null, c, config, counters, now, trigger: KIND, m3: { spend: r.spend, purchases: r.orders, cpa: null } }); } catch (e) { blockers = [{ code: 'GUARD_EVALUATION_FAILED', message: String(e.message).slice(0, 160) }]; }
    }
    const review = r.state === 'REVIEW'; const autoBlockers = review ? [{ code: r.code, message: r.reason }] : [];
    const effective = blockers.length ? 'BLOCKED' : mode === 'SHADOW' ? 'SHADOW' : mode === 'APPROVAL' || review ? 'APPROVAL' : mode === 'AUTOPILOT' ? 'AUTOMATIC' : 'BLOCKED';
    cands.push({ key: decisionKey(r.campaignId, ev.date), kind: KIND, action: 'PAUSE', campaignId: r.campaignId, campaignName: r.campaignName, productId: null, productName: null, storeId: null, productKey: null, productMode: 'ACCOUNT_POLICY', adAccountId: r.adAccountId,
      entity: { level: 'campaign', id: r.campaignId, budget: r.budget }, fromBudget: null, toBudget: null, pct: null, reason: r.reason, blockers, autoBlockers, effective, permission: gateKey, permissionOn, canExecuteNow: effective === 'AUTOMATIC' && permissionOn, cooldownHours: 24, pausePolicyVersion: null,
      evidence: { m3: { spend: r.spend, purchases: r.orders, cpa: null }, zeroSpend: { date: ev.date, policyVersion: pol.version, checkTime: pol.checkTime, limit: pol.limit, comparison: pol.comparison, spend: r.spend, orders: r.orders, window: ev.window, dataAsOf: ev.dataAsOf, reliability: r.sync.reliability, adAccountId: r.adAccountId, accountTimezone: ev.accounts.find((a) => a.adAccountId === r.adAccountId)?.timezone || null, finalState: r.state, finalCode: r.code, history: r.history, winner: r.winner, warning: r.warning, conflicts: r.conflicts } } });
  }
  for (const acc of [...new Set(cands.map((c) => c.adAccountId))]) { const p = await persistCandidates(cands.filter((c) => c.adAccountId === acc), { adAccountId: acc, mode, now }); out.persisted.created += p.created; out.persisted.updated += p.updated; out.persisted.merged += p.merged || 0; for (const [k, id] of p.ids) { const c = cands.find((x) => x.key === k); if (c) c.decisionId = id; } }
  out.eligible = cands.map((c) => ({ campaignId: c.campaignId, name: c.campaignName, effective: c.effective, decisionId: c.decisionId || null, blockers: c.blockers.map((b) => b.code), review: c.autoBlockers.map((b) => b.code) }));
  // AUTOMATIC: only with the policy approved (checked above), the system mode AUTOMATIC, every central gate open and the «pause» permission — otherwise the decisions simply wait PREPARED for the owner
  if (mode === 'AUTOPILOT') {
    const dcfg = deps.dcfg || await (await import('./dailyPlans.js')).getDailyPlanConfig(); const apOk = deps.autopilotOk ?? (await autopilotGate().catch(() => ({ ok: false }))).ok;
    const gate = tickGate({ config, dcfg, metaStale: false, autopilotOk: apOk }); out.gate = gate.map((g) => g.code);
    if (!gate.length) { let sent = 0; for (const c of cands.filter((x) => x.canExecuteNow && x.decisionId)) {
      if (sent > 0 && !deps.noSleep) await new Promise((r) => setTimeout(r, 3000));
      const r = await executeAutoDecision({ decisionId: c.decisionId, source: 'AUTOPILOT', userId: null, now, deps: deps.execDeps || {} }); out.executed.push({ decisionId: c.decisionId, campaignId: c.campaignId, status: r.status, verified: r.verified, message: r.message }); if (r.sentRequest || r.executed) sent++;
      if (r.rateLimited) { out.deferred.push({ code: 'META_RATE_LIMIT_STOP' }); break; } } }
  }
  await prisma.ambOperatorEvent.create({ data: { kind: 'ZERO_SPEND_CHECK', actor: 'SYSTEM', campaign_id: marker, note: `فحص الصرف بدون أوردرات ${date} (${pol.checkTime}، v${pol.version}): ${ev.summary.total} حملة · مؤهلة ${ev.summary.ELIGIBLE} · مراجعة ${ev.summary.REVIEW} · استمرار ${ev.summary.CONTINUE} · غير مكتملة ${ev.summary.INCOMPLETE}`, data_json: JSON.stringify({ date, status: 'DONE', version: pol.version, summary: ev.summary, limits: ev.limits, mode }) } });
  if (incomplete.length) await raiseAlert({ severity: 'WARNING', category: 'OPERATOR', title: `فحص الصرف بدون أوردرات: ${incomplete.length} حملة بيانات غير مكتملة`, message: 'ما اتاخدش قرار على الحملات دي. ' + incomplete.slice(0, 3).map((r) => `${r.campaignName}: ${r.code}`).join(' · '), dedupeKey: `zerospend:incomplete:${date}` }).catch(() => {});
  if (ev.summary.winnersAtRisk) await raiseAlert({ severity: 'WARNING', category: 'OPERATOR', title: `فحص الصرف بدون أوردرات: ${ev.summary.winnersAtRisk} حملة رابحة تاريخيًا تجاوزت الحد`, message: WINNER_WARNING + ' — راجعها قبل أي إيقاف.', dedupeKey: `zerospend:winner:${date}` }).catch(() => {});
  logger.info('[zeroSpendCheck] checked', { date, summary: ev.summary, mode });
  return out;
}

/** The live re-check run by executeAutoDecision right before a write (and when the owner approves a PREPARED decision): the SAME decision or nothing. Metrics bypass the short cache. */
export async function reevaluateDecision({ row, params, now = new Date(), deps = {} }) {
  const ev0 = j(row.evidence_json, {}) || {}; const zs = ev0.zeroSpend || {}; const blockers = []; let autoBlockers = [];
  const pol = await getZeroSpendPolicy(); if (!zeroSpendActive(pol)) blockers.push({ code: 'POLICY_NOT_ACTIVE', message: 'سياسة الصرف بدون أوردرات مبقتش مفعّلة/معتمدة.' });
  else if (zs.policyVersion != null && zs.policyVersion !== pol.version) blockers.push({ code: 'POLICY_CHANGED', message: `السياسة اتغيّرت (v${zs.policyVersion} → v${pol.version}).` });
  if (zs.date && zs.date !== cairoDate(now)) blockers.push({ code: 'DECISION_DAY_PASSED', message: 'القرار ده بتاع يوم تاني — الفحص بيتعاد كل يوم.' });
  let r = null; if (!blockers.length) {
    const ev = await evaluateZeroSpendCheck({ now, policy: pol, deps: { ...(deps.eval || {}), forceFresh: true } }); r = ev.rows.find((x) => x.campaignId === row.campaign_id) || null;
    if (!r) blockers.push({ code: 'CAMPAIGN_NOT_ACTIVE', message: 'الحملة مبقتش نشطة/مشمولة.' }); else if (r.baseState !== 'ELIGIBLE') blockers.push({ code: r.code, message: r.reason }); else if (r.state !== 'ELIGIBLE') autoBlockers = [{ code: r.code, message: r.reason }]; // still zero orders over the limit, but needs the owner's eyes
  }
  return { candidates: [{ campaignId: row.campaign_id, kind: KIND, action: 'PAUSE', entity: { level: 'campaign', id: params.entityId || row.campaign_id }, blockers, autoBlockers, effective: autoBlockers.length ? 'APPROVAL' : 'AUTOMATIC', evidence: { m3: { spend: r?.spend ?? null, purchases: r?.orders ?? null, cpa: null } }, fromBudget: null, toBudget: null }] };
}
