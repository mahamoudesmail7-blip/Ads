// «الفتح حسب تكلفة الأوردر CPA» — a saved, VERSIONED opening policy (not a display filter). 2026-10-09.
//   limits_json.openCpa = { enabled, minCpa, maxCpa, window: today|7|30|90|custom, from, to, minPurchases, maxDataAgeMin, version, approved:{version,at,by}, history[] }
// Saving the range creates a new version (the old one stays in the history) and NEVER enables anything; enabling is a separate ADMIN + confirm action. Neither opens a campaign:
// opening still happens only through the Daily Plan (approve → live revalidation → one Meta write), and every global Safety Guard stays above this policy.
// A campaign is ELIGIBLE only if: its CPA for the chosen window is KNOWN and inside [min, max] · it has at least `minPurchases` orders in that window · the Meta data is fresh ·
// it passed the plan's Eligibility + Safety Guards · it is not a campaign that needs a special approval · the owner did not untick it. Nothing else is ever assumed.
import { prisma } from '../../prisma.js';
import { PROTECTION_AR, recentContradiction } from './reopenProtection.js';
import { getConnection } from '../metaAuth.js';
import { entityWindowMetrics } from './metricsEngine.js';
import { cairoDate } from './dailyPlanTime.js';
import { emptyScope, normalizeScope, validateScope, normalizeDays, validDays, scopeVerdict, weekdayAllowed, applyExposureCap } from './automationScope.js';

export const OPEN_CPA_WINDOWS = ['today', '7', '30', '90', 'custom'];
export const WINDOW_LABEL = { today: 'اليوم', 7: 'آخر 7 أيام', 30: 'آخر 30 يوم', 90: 'آخر 90 يوم', custom: 'فترة مخصصة' };
// 2026-10-11: scope (include/exclude products · stores · campaigns), weekdays, a total-exposure ceiling, a minimum stock and manual-pause protection are part of the SAME versioned, approved policy.
export const DEFAULT_OPEN_CPA = Object.freeze({ enabled: false, minCpa: null, maxCpa: null, window: '7', from: null, to: null, minPurchases: 5, maxDataAgeMin: 30, scope: emptyScope(), days: null, maxTotalExposure: null, minStock: null, protectManualPause: { enabled: true, hours: 48 }, version: 0, approved: null, updatedAt: null, updatedBy: null, history: [] });
export const REASON_AR = {
  ...PROTECTION_AR,
  GUARD_BLOCKED: 'ممنوعة بحارس أمان', NEEDS_SPECIAL_APPROVAL: 'محتاجة موافقة خاصة (اتقفلت يدويًا/غير معروف)', CPA_UNKNOWN: 'CPA غير معروف (مفيش أوردرات في الفترة)', CPA_BELOW_MIN: 'CPA أقل من الحد الأدنى للنطاق', CPA_ABOVE_MAX: 'CPA أعلى من الحد الأقصى للنطاق',
  SAMPLE_TOO_SMALL: 'عدد الأوردرات أقل من الحد الأدنى للعينة', DATA_STALE: 'بيانات Meta قديمة', USER_DESELECTED: 'استبعدتها يدويًا — لا تُعاد بدون موافقة خاصة',
  EXCLUDED_BY_POLICY: 'مستبعدة بالسياسة (منتج / متجر / حملة)', OUT_OF_SCOPE: 'خارج نطاق السياسة (مش ضمن المنتجات/المتاجر/الحملات المضمّنة)', DAY_NOT_ALLOWED: 'اليوم مش ضمن أيام الفتح في السياسة',
  STOCK_BELOW_MIN: 'المخزون أقل من الحد الأدنى في السياسة', STOCK_UNKNOWN_FOR_MIN: 'المخزون غير معروف والسياسة محددة حد أدنى', MANUAL_PAUSE_PROTECTED: 'اتقفلت يدويًا مؤخرًا — محمية من الفتح التلقائي', EXPOSURE_CAP: 'هتتجاوز سقف إجمالي الميزانيات المعرضة للصرف', BUDGET_UNKNOWN: 'ميزانية الحملة غير معروفة',
};
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const fail = (status, message, code) => { const e = new Error(message); e.status = status; if (code) e.code = code; return e; };
const YMD = /^\d{4}-\d{2}-\d{2}$/; const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const toNum = (v) => (v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? null : Number(v));

/** inclusive window on the CAIRO calendar day */
export function windowRangeFor(policy, today) {
  const w = String(policy.window);
  if (w === 'today') return { from: today, to: today, days: 1 };
  if (w === 'custom') return { from: policy.from, to: policy.to, days: Math.round((Date.parse(`${policy.to}T00:00:00Z`) - Date.parse(`${policy.from}T00:00:00Z`)) / 86400000) + 1 };
  const n = Number(w); return { from: addDays(today, -(n - 1)), to: today, days: n };
}
export function normalizeOpenCpa(raw = {}) {
  const r = raw || {};
  return { ...DEFAULT_OPEN_CPA, ...r, minCpa: toNum(r.minCpa), maxCpa: toNum(r.maxCpa), window: OPEN_CPA_WINDOWS.includes(String(r.window)) ? String(r.window) : (r.window === undefined || r.window === null ? '7' : String(r.window)), from: r.from || null, to: r.to || null,
    minPurchases: toNum(r.minPurchases) ?? DEFAULT_OPEN_CPA.minPurchases, maxDataAgeMin: toNum(r.maxDataAgeMin) ?? DEFAULT_OPEN_CPA.maxDataAgeMin, history: Array.isArray(r.history) ? r.history : [],
    scope: normalizeScope(r.scope), days: normalizeDays(r.days), maxTotalExposure: toNum(r.maxTotalExposure), minStock: toNum(r.minStock),
    protectManualPause: { enabled: r.protectManualPause?.enabled !== false, hours: toNum(r.protectManualPause?.hours) ?? DEFAULT_OPEN_CPA.protectManualPause.hours } };
}
/** Arabic error strings; `requireRange` is true when enabling / preparing */
export function validateOpenCpa(p, { today = cairoDate(new Date()), requireRange = false } = {}) {
  const e = [];
  // 2026-10-14: the LOWER limit may be 0 (= «من صفر»: no floor); the UPPER limit must stay above zero
  const num = (k, label, allowZero = false) => { const v = p[k]; if (v === null) return; if (!Number.isFinite(v) || v < 0 || (v === 0 && !allowZero)) e.push(`${label}: لازم يكون ${allowZero ? 'رقم صفر أو أكبر' : 'رقم أكبر من صفر'}.`); else if (v > 100000) e.push(`${label}: أكبر من اللازم.`); };
  num('minCpa', 'أقل CPA', true); num('maxCpa', 'أعلى CPA');
  if (requireRange && (p.minCpa === null || p.maxCpa === null)) e.push('لازم تحدد أقل CPA وأعلى CPA — السيستم مش بيفترض نطاق.');
  if (p.minCpa !== null && p.maxCpa !== null && p.minCpa > p.maxCpa) e.push('أقل CPA لازم يكون أقل من أو يساوي أعلى CPA.');
  if (!OPEN_CPA_WINDOWS.includes(p.window)) e.push('فترة القياس لازم تكون: اليوم / 7 / 30 / 90 / مخصصة.');
  if (p.window === 'custom') {
    if (!YMD.test(String(p.from)) || !YMD.test(String(p.to))) e.push('الفترة المخصصة محتاجة تاريخ بداية ونهاية صالحين.');
    else if (p.from > p.to) e.push('تاريخ البداية لازم يكون قبل أو يساوي النهاية.');
    else if (p.to > today) e.push('تاريخ النهاية لا يمكن أن يكون في المستقبل.');
    else if ((Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86400000 + 1 > 366) e.push('الفترة أطول من 366 يوم.');
  }
  if (!Number.isInteger(p.minPurchases) || p.minPurchases < 1 || p.minPurchases > 100) e.push('الحد الأدنى للأوردرات لازم يكون عدد صحيح بين 1 و100.');
  if (!Number.isFinite(p.maxDataAgeMin) || p.maxDataAgeMin < 5 || p.maxDataAgeMin > 180) e.push('أقصى عمر لبيانات Meta بالدقائق: بين 5 و180.');
  e.push(...validateScope(p.scope || emptyScope()));
  if (!validDays(p.days)) e.push('أيام الأسبوع لازم تكون أرقام من 0 (الأحد) إلى 6 (السبت).');
  if (p.maxTotalExposure !== null && p.maxTotalExposure !== undefined && (!Number.isFinite(p.maxTotalExposure) || p.maxTotalExposure <= 0 || p.maxTotalExposure > 1e8)) e.push('سقف إجمالي الميزانيات المعرضة: لازم رقم موجب.');
  if (p.minStock !== null && p.minStock !== undefined && (!Number.isInteger(p.minStock) || p.minStock < 1 || p.minStock > 1e6)) e.push('الحد الأدنى للمخزون: عدد صحيح موجب.');
  if (p.protectManualPause && (!Number.isFinite(p.protectManualPause.hours) || p.protectManualPause.hours < 1 || p.protectManualPause.hours > 720)) e.push('حماية الإيقاف اليدوي (ساعات): بين 1 و720.');
  return e;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// pure evaluation of ONE campaign
// ---------------------------------------------------------------------------------------------------------------------------------------------
/** item: {eligibility, selectable, blockCodes, evidence}. metrics: {spend, purchases}. Returns the verdict with every reason. */
export function evaluateCampaign({ policy, item, metrics, dataAgeMin = 0, reselect = false, weekday = null, now = new Date() }) {
  const spend = metrics?.spend ?? null, purchases = metrics?.purchases ?? null;
  const cpa = purchases > 0 && spend != null ? Math.round(Number(spend) / Number(purchases)) : null; // CPA = spend / purchases of the SAME window; null — never 0 — with no orders
  const codes = []; const detail = [];
  const matched = cpa !== null && cpa >= policy.minCpa && cpa <= policy.maxCpa;
  if (cpa === null) codes.push('CPA_UNKNOWN'); else if (cpa < policy.minCpa) codes.push('CPA_BELOW_MIN'); else if (cpa > policy.maxCpa) codes.push('CPA_ABOVE_MAX');
  if (cpa !== null && purchases < policy.minPurchases) codes.push('SAMPLE_TOO_SMALL');
  if (item.eligibility === 'BLOCKED' || item.selectable === false) { codes.push('GUARD_BLOCKED'); for (const c of item.blockCodes || []) detail.push(c); }
  else if (item.eligibility === 'NEEDS_SPECIAL_APPROVAL') codes.push('NEEDS_SPECIAL_APPROVAL');
  if (dataAgeMin > policy.maxDataAgeMin) codes.push('DATA_STALE');
  if (item.evidence?.userDeselected && !reselect) codes.push('USER_DESELECTED');
  // 2026-10-14 reopen protection: a performance pause by the system, or recent numbers that contradict the range, are never overridden by a long-window average (only an explicit owner re-selection can)
  if (item.evidence?.systemPause?.kind === 'PERFORMANCE' && !reselect) codes.push('PAUSED_FOR_PERFORMANCE');
  if (recentContradiction({ m7: item.evidence?.m7, maxCpa: policy.maxCpa }) && !reselect) codes.push('RECENT_CPA_ABOVE_MAX');
  // ---- 2026-10-11: scope, weekday, minimum stock, manual-pause protection (all part of the approved policy version)
  { const sv = scopeVerdict(policy.scope, { productId: item.productId ?? item.evidence?.productId ?? null, storeId: item.storeId ?? item.evidence?.storeId ?? null, campaignId: item.campaignId ?? null }); if (sv) codes.push(sv); }
  if (weekday != null && !weekdayAllowed(policy.days, weekday)) codes.push('DAY_NOT_ALLOWED');
  if (policy.minStock != null) { const st = item.evidence?.stock; if (!st || st.current == null || st.status === 'STOCK_UNKNOWN') codes.push('STOCK_UNKNOWN_FOR_MIN'); else if (Number(st.current) < policy.minStock) codes.push('STOCK_BELOW_MIN'); }
  if (policy.protectManualPause?.enabled && item.evidence?.pausedBy === 'MANUAL' && item.evidence?.pausedAt && now.getTime() - new Date(item.evidence.pausedAt).getTime() < policy.protectManualPause.hours * 3_600_000) codes.push('MANUAL_PAUSE_PROTECTED');
  const rangeCodes = ['CPA_UNKNOWN', 'CPA_BELOW_MIN', 'CPA_ABOVE_MAX']; const blockers = codes.filter((c) => !rangeCodes.includes(c));
  const verdict = cpa === null ? 'UNKNOWN_CPA' : !matched ? 'OUT_OF_RANGE' : blockers.length ? 'EXCLUDED' : 'ELIGIBLE';
  return { verdict, matched, eligible: verdict === 'ELIGIBLE', cpa, spend, purchases, codes, reasons: codes.map((c) => REASON_AR[c] || c), guardCodes: detail };
}
/** counts + per-campaign rows for a set of evaluated items (matched = CPA inside the range; excluded = matched but not eligible) */
export function summarizeEvaluations(rows) {
  const matched = rows.filter((r) => r.eval.matched), eligible = rows.filter((r) => r.eval.eligible), excluded = matched.filter((r) => !r.eval.eligible);
  const byReason = {}; for (const r of excluded) for (const c of r.eval.codes.filter((x) => !['CPA_UNKNOWN', 'CPA_BELOW_MIN', 'CPA_ABOVE_MAX'].includes(x))) byReason[c] = (byReason[c] || 0) + 1;
  return { total: rows.length, matched: matched.length, eligible: eligible.length, excluded: excluded.length, outOfRange: rows.filter((r) => r.eval.verdict === 'OUT_OF_RANGE').length, unknownCpa: rows.filter((r) => r.eval.verdict === 'UNKNOWN_CPA').length, byReason };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// storage (operator config JSON — no schema change). History keeps every previous version.
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function readRaw() { const row = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const raw = j(row?.limits_json, null) || {}; return { raw, policy: normalizeOpenCpa(raw.openCpa) }; }
async function write(raw, policy, userId) { await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify({ ...raw, openCpa: policy }), updated_by_id: userId ?? null } }); }
const audit = (userId, kind, input) => prisma.aiAuditLog.create({ data: { actor_id: userId ?? null, kind, action: 'EXECUTE', input_json: JSON.stringify(input).slice(0, 3500), success: true } }).catch(() => {});
const event = (userId, kind, note, data = {}) => prisma.ambOperatorEvent.create({ data: { kind, actor: 'USER', actor_id: userId ?? null, note, data_json: JSON.stringify(data).slice(0, 3500) } }).catch(() => {});
async function requireAdmin(userId, deps = {}) { const u = deps.user || await prisma.user.findUnique({ where: { id: Number(userId) }, select: { id: true, role: true, status: true } }); if (!u || u.role !== 'ADMIN' || u.status !== 'ACTIVE') throw fail(403, 'ده محتاج ADMIN.'); return u; }
const snap = (p) => ({ version: p.version, enabled: p.enabled, minCpa: p.minCpa, maxCpa: p.maxCpa, window: p.window, from: p.from, to: p.to, minPurchases: p.minPurchases, maxDataAgeMin: p.maxDataAgeMin, scope: p.scope, days: p.days, maxTotalExposure: p.maxTotalExposure, minStock: p.minStock, protectManualPause: p.protectManualPause });

export async function getOpenCpaPolicy() { return (await readRaw()).policy; }
const RANGE_KEYS = ['minCpa', 'maxCpa', 'window', 'from', 'to', 'minPurchases', 'maxDataAgeMin', 'scope', 'days', 'maxTotalExposure', 'minStock', 'protectManualPause'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Saves the limits as a NEW version when something changed. Never touches `enabled`. Returns {policy, changed, supersededPrevious}. */
export async function saveOpenCpaPolicy({ patch, userId, now = new Date(), deps = {} }) {
  await requireAdmin(userId, deps); const { raw, policy: cur } = await readRaw();
  const next = normalizeOpenCpa({ ...cur, ...Object.fromEntries(Object.entries(patch || {}).filter(([k]) => RANGE_KEYS.includes(k))) });
  if (next.window !== 'custom') { next.from = null; next.to = null; }
  const errors = validateOpenCpa(next, { today: cairoDate(now), requireRange: cur.enabled }); if (errors.length) { const e = fail(400, errors.join(' '), 'INVALID_POLICY'); e.details = errors; throw e; }
  const changed = RANGE_KEYS.some((k) => !same(next[k], cur[k])); if (!changed) return { policy: cur, changed: false };
  next.version = cur.version + 1; next.updatedAt = now.toISOString(); next.updatedBy = Number(userId);
  next.history = [...cur.history, { ...snap(cur), replacedAt: now.toISOString(), by: Number(userId) }].slice(-30);
  // saving the limits never turns the rule on or off; the version the owner APPROVED stays the old one — the new version drives plan preparation (APPROVAL / SHADOW) but is never used by AUTOMATIC until the owner approves it
  await write(raw, next, userId); await audit(userId, 'OPEN_CPA_POLICY_SAVED', { from: snap(cur), to: snap(next) }); await event(userId, 'OPEN_CPA_POLICY_SAVED', `حفظ سياسة الفتح حسب CPA v${next.version}: ${next.minCpa ?? '—'}–${next.maxCpa ?? '—'} (${WINDOW_LABEL[next.window]}) — الاعتماد للتنفيذ التلقائي لسه على النسخة القديمة`, snap(next));
  return { policy: next, changed: true, wasEnabled: cur.enabled };
}
/** The owner's explicit switch. Enabling = ADMIN + confirm + a complete valid range; it records WHICH version was approved. Does not open anything. */
export async function setOpenCpaEnabled({ enabled, confirm, userId, now = new Date(), deps = {} }) {
  await requireAdmin(userId, deps); if (typeof enabled !== 'boolean') throw fail(400, 'enabled لازم true/false.'); if (confirm !== true) throw fail(400, 'محتاج تأكيد صريح.', 'CONFIRM_REQUIRED');
  const { raw, policy: cur } = await readRaw(); const reapprove = enabled && cur.enabled && cur.approved?.version !== cur.version; if (cur.enabled === enabled && !reapprove) return { policy: cur, changed: false };
  if (enabled) { const errors = validateOpenCpa(cur, { today: cairoDate(now), requireRange: true }); if (errors.length) { const e = fail(400, errors.join(' '), 'INVALID_POLICY'); e.details = errors; throw e; } }
  const next = { ...cur, enabled, version: cur.version, approved: enabled ? { version: cur.version, at: now.toISOString(), by: Number(userId) } : null, updatedAt: now.toISOString(), updatedBy: Number(userId) };
  await write(raw, next, userId); await audit(userId, enabled ? 'OPEN_CPA_POLICY_ENABLED' : 'OPEN_CPA_POLICY_DISABLED', { snapshot: snap(next) }); await event(userId, enabled ? 'OPEN_CPA_POLICY_ENABLED' : 'OPEN_CPA_POLICY_DISABLED', `${enabled ? 'تفعيل' : 'إيقاف'} الفتح حسب CPA (v${next.version}) — مفيش حملة اتفتحت بسبب الزر`, snap(next));
  return { policy: next, changed: true };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// metrics of the policy window (Cairo day) for every campaign — one cached read
// ---------------------------------------------------------------------------------------------------------------------------------------------
export async function loadWindowMetrics({ policy, now = new Date(), adAccountId = null, deps = {} }) {
  if (deps.metrics) return deps.metrics;
  const acc = adAccountId || (await getConnection())?.selected_ad_account_id; if (!acc) return new Map();
  const r = windowRangeFor(policy, cairoDate(now)); return entityWindowMetrics({ level: 'campaign', from: r.from, to: r.to, adAccountId: acc });
}
/** Applies the policy to built candidates (OPEN builder): evidence.cpaPolicy on every item; selection follows the policy. Pure over its inputs. */
export function applyPolicyToItems({ items, policy, metrics, dataAgeMin = 0, now = new Date(), baseExposure = 0 }) {
  const weekday = new Date(`${cairoDate(now)}T12:00:00Z`).getUTCDay();
  const rows = items.map((it) => { const m = metrics.get(it.campaignId); const ev = evaluateCampaign({ policy, item: it, metrics: m ? { spend: m.spend, purchases: m.purchases } : null, dataAgeMin, weekday, now }); return { it, eval: ev }; });
  applyCapToEvals([...rows].sort((a, b) => (b.it.rankScore ?? 0) - (a.it.rankScore ?? 0)), { policy, baseExposure, budgetOf: (r) => r.it.evidence?.budget, keyOf: (r) => r.it.campaignId });
  for (const { it, eval: ev } of rows) {
    it.evidence = { ...(it.evidence || {}), cpaPolicy: { version: policy.version, window: policy.window, verdict: ev.verdict, matched: ev.matched, cpa: ev.cpa, spend: ev.spend, purchases: ev.purchases, codes: ev.codes, reasons: ev.reasons } };
    it.selected = !!it.selectable && ev.eligible; // the policy decides the default selection; the owner can still untick/tick (special approval rules unchanged)
    if (ev.matched) it.reason = ev.eligible ? `مطابقة لسياسة CPA ${policy.minCpa}–${policy.maxCpa}: CPA ${ev.cpa} على ${ev.purchases} أوردر — ${it.reason}` : `مطابقة للنطاق لكن مستبعدة: ${ev.reasons.join(' · ')}`;
  }
  return { rows, counts: summarizeEvaluations(rows) };
}

/** The total-exposure ceiling of the policy, applied to already-evaluated rows IN RANK ORDER (best first): a row that would push (running exposure + base) over the cap is refused with EXPOSURE_CAP. Mutates the rows' eval. */
export function applyCapToEvals(rows, { policy, baseExposure = 0, budgetOf, keyOf }) {
  if (policy.maxTotalExposure == null) return { refused: new Set(), exposure: baseExposure };
  const r = applyExposureCap(rows.map((x) => ({ key: keyOf(x), budget: budgetOf(x), eligible: x.eval.eligible })), { cap: policy.maxTotalExposure, base: baseExposure });
  for (const x of rows) if (r.refused.has(keyOf(x))) { x.eval.codes.push(Number(budgetOf(x)) > 0 ? 'EXPOSURE_CAP' : 'BUDGET_UNKNOWN'); x.eval.reasons = x.eval.codes.map((c) => REASON_AR[c] || c); x.eval.eligible = false; x.eval.verdict = 'EXCLUDED'; }
  return r;
}

/**
 * Execution-time re-check of the policy rules that can change between preparing and executing (and that a plan edited by hand could violate): scope, weekday, minimum stock, manual-pause protection.
 * `snap` is the policy snapshot stored on the plan (plan.evidence.openCpa) — the SAME approved version the plan was prepared under. Returns the reason code or null. Pure.
 */
export function runtimeBlock(snap, { campaignId, productId = null, storeId = null, evidence = {} } = {}, { weekday = null, now = new Date() } = {}) {
  if (!snap) return null;
  const sv = scopeVerdict(snap.scope, { productId, storeId, campaignId }); if (sv) return sv;
  if (weekday != null && !weekdayAllowed(snap.days, weekday)) return 'DAY_NOT_ALLOWED';
  if (snap.minStock != null) { const st = evidence.stock; if (!st || st.current == null || st.status === 'STOCK_UNKNOWN') return 'STOCK_UNKNOWN_FOR_MIN'; if (Number(st.current) < snap.minStock) return 'STOCK_BELOW_MIN'; }
  if (snap.protectManualPause?.enabled && evidence.pausedBy === 'MANUAL' && evidence.pausedAt && now.getTime() - new Date(evidence.pausedAt).getTime() < snap.protectManualPause.hours * 3_600_000) return 'MANUAL_PAUSE_PROTECTED';
  return null;
}
