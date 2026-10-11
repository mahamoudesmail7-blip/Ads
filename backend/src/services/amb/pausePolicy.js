// «سياسة الإيقاف التلقائي» — a saved, VERSIONED, owner-APPROVED pause policy (the sibling of «الفتح حسب CPA»). 2026-10-11.
//   limits_json.pausePolicy = { enabled, version, approved:{version,at,by}, scheduledClose, zeroOrder, highCpa, stockOut, protections, scope, days, history[] }
// Saving creates a NEW version and never turns anything on; «تفعيل» = ADMIN + confirm and records WHICH version was approved. Nothing here pauses a campaign: it only DECIDES (pure) — execution is the
// automation engine's job, behind the central write gate, per product opt-in (product policy mode AUTOMATIC), and every Safety Guard stays above it.
//   triggers:  STOCK_OUT (always wins) · ZERO_ORDER (spend with no orders) · HIGH_CPA (CPA above X with a real sample) · SCHEDULED_CLOSE (the daily closing plan, executed without a click)
//   protections: winnerProtection + precedence — PROTECTION_WINS (a strong winner is not paused by ZERO_ORDER / HIGH_CPA; STOCK_OUT still pauses it) or RULE_WINS (a fired rule pauses even a winner)
import { prisma } from '../../prisma.js';
import { cairoDate } from './dailyPlanTime.js';
import { emptyScope, normalizeScope, validateScope, normalizeDays, validDays, scopeVerdict, weekdayAllowed } from './automationScope.js';

export const PRECEDENCE = ['PROTECTION_WINS', 'RULE_WINS'];
export const PRECEDENCE_AR = { PROTECTION_WINS: 'حماية الـWinner أقوى من قواعد الإيقاف (ما عدا نفاد المخزون)', RULE_WINS: 'قاعدة الإيقاف أقوى حتى على الـWinner' };
export const TRIGGER_AR = { STOCK_OUT: 'نفاد المخزون', ZERO_ORDER: 'صرف بدون أوردرات', HIGH_CPA: 'CPA عالي', SCHEDULED_CLOSE: 'الإغلاق المجدول' };
export const DEFAULT_PAUSE = Object.freeze({
  enabled: false, version: 0, approved: null, updatedAt: null, updatedBy: null, history: [],
  scheduledClose: { enabled: false },
  zeroOrder: { enabled: true, spend: null },                                  // spend null → the product policy / account budget policy value; a number replaces the ACCOUNT default (e.g. 150)
  highCpa: { enabled: false, above: null, minPurchases: 5, minSpend: null },  // direct pause when the 3-day CPA is above `above` with a real sample (otherwise the budget policy reduces first)
  stockOut: { enabled: true },
  protections: { winnerProtection: true, precedence: 'PROTECTION_WINS' },
  scope: emptyScope(), days: null,
});
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const num = (v) => (v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? null : Number(v));
const fail = (status, message, code) => { const e = new Error(message); e.status = status; if (code) e.code = code; return e; };
const bool = (v, d) => (v === undefined || v === null ? d : v === true);

export function normalizePause(raw = {}) {
  const r = raw || {}; const D = DEFAULT_PAUSE;
  return { ...D, enabled: r.enabled === true, version: Number(r.version) || 0, approved: r.approved || null, updatedAt: r.updatedAt || null, updatedBy: r.updatedBy ?? null, history: Array.isArray(r.history) ? r.history : [],
    scheduledClose: { enabled: bool(r.scheduledClose?.enabled, false) },
    zeroOrder: { enabled: bool(r.zeroOrder?.enabled, true), spend: num(r.zeroOrder?.spend) },
    highCpa: { enabled: bool(r.highCpa?.enabled, false), above: num(r.highCpa?.above), minPurchases: num(r.highCpa?.minPurchases) ?? D.highCpa.minPurchases, minSpend: num(r.highCpa?.minSpend) },
    stockOut: { enabled: bool(r.stockOut?.enabled, true) },
    protections: { winnerProtection: bool(r.protections?.winnerProtection, true), precedence: PRECEDENCE.includes(r.protections?.precedence) ? r.protections.precedence : 'PROTECTION_WINS' },
    scope: normalizeScope(r.scope), days: normalizeDays(r.days) };
}
export function validatePause(p, { requireTrigger = false } = {}) {
  const e = []; const pos = (path, v, min, max) => { if (v === null || v === undefined) return; if (!Number.isFinite(v) || v < min || v > max) e.push(`${path}: لازم بين ${min} و${max}.`); };
  pos('حد الصرف بدون أوردرات', p.zeroOrder.spend, 1, 1e6); pos('CPA العالي', p.highCpa.above, 1, 1e5); pos('أقل أوردرات لحكم CPA', p.highCpa.minPurchases, 1, 100); pos('أقل صرف لحكم CPA', p.highCpa.minSpend, 0, 1e7);
  if (p.highCpa.enabled && p.highCpa.above == null) e.push('الإيقاف بالـCPA العالي محتاج تحدد الحد (CPA أعلى من).');
  if (!PRECEDENCE.includes(p.protections.precedence)) e.push('أولوية الحماية لازم PROTECTION_WINS أو RULE_WINS.');
  e.push(...validateScope(p.scope)); if (!validDays(p.days)) e.push('أيام الأسبوع لازم تكون أرقام من 0 إلى 6.');
  if (requireTrigger && !(p.scheduledClose.enabled || p.zeroOrder.enabled || p.highCpa.enabled || p.stockOut.enabled)) e.push('فعّل سبب إيقاف واحد على الأقل.');
  return e;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// pure decision: which trigger (if any) pauses this campaign — with the protections applied
// ---------------------------------------------------------------------------------------------------------------------------------------------
/**
 * input: { policy, campaignId, productId, storeId, optimizer: {action:'PAUSE'|…, zone, zeroLimit}|null, m3, stock: {status}|null, winner, weekday }
 * Returns { trigger: 'STOCK_OUT'|'ZERO_ORDER'|'HIGH_CPA'|null, skipped: [{trigger, code}], blockers: [codes] } — `blockers` = reasons the policy itself forbids a pause right now (scope / weekday / disabled).
 */
export function decidePause({ policy, campaignId, productId = null, storeId = null, optimizer = null, m3 = null, stock = null, winner = false, weekday = null }) {
  const skipped = []; const blockers = [];
  const sv = scopeVerdict(policy.scope, { productId, storeId, campaignId }); if (sv) blockers.push(sv);
  if (weekday != null && !weekdayAllowed(policy.days, weekday)) blockers.push('DAY_NOT_ALLOWED');
  const fired = [];
  if (policy.stockOut.enabled && stock?.status === 'OUT_OF_STOCK') fired.push('STOCK_OUT');
  if (policy.zeroOrder.enabled) {
    const lim = policy.zeroOrder.spend; const zero = optimizer ? optimizer.action === 'PAUSE' : (lim != null && (m3?.purchases ?? 0) === 0 && (m3?.spend ?? 0) >= lim); // the optimizer row already applied the limit + minimum age + attribution grace
    if (zero) fired.push('ZERO_ORDER');
  }
  if (policy.highCpa.enabled && policy.highCpa.above != null && m3?.cpa != null && m3.cpa > policy.highCpa.above && (m3.purchases ?? 0) >= policy.highCpa.minPurchases && (m3.spend ?? 0) >= (policy.highCpa.minSpend ?? 0)) fired.push('HIGH_CPA');
  const protectedWinner = policy.protections.winnerProtection && winner && policy.protections.precedence === 'PROTECTION_WINS';
  let trigger = null;
  for (const t of ['STOCK_OUT', 'ZERO_ORDER', 'HIGH_CPA']) { if (!fired.includes(t)) continue; if (protectedWinner && t !== 'STOCK_OUT') { skipped.push({ trigger: t, code: 'WINNER_PROTECTED' }); continue; } trigger = t; break; }
  return { trigger, skipped, blockers, fired };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// storage — same shape as the open policy
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function readRaw() { const row = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const raw = j(row?.limits_json, null) || {}; return { raw, policy: normalizePause(raw.pausePolicy) }; }
async function write(raw, policy, userId) { await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify({ ...raw, pausePolicy: policy }), updated_by_id: userId ?? null } }); }
const audit = (userId, kind, input) => prisma.aiAuditLog.create({ data: { actor_id: userId ?? null, kind, action: 'EXECUTE', input_json: JSON.stringify(input).slice(0, 3500), success: true } }).catch(() => {});
const event = (userId, kind, note, data = {}) => prisma.ambOperatorEvent.create({ data: { kind, actor: 'USER', actor_id: userId ?? null, note, data_json: JSON.stringify(data).slice(0, 3500) } }).catch(() => {});
async function requireAdmin(userId, deps = {}) { const u = deps.user || await prisma.user.findUnique({ where: { id: Number(userId) }, select: { id: true, role: true, status: true } }); if (!u || u.role !== 'ADMIN' || u.status !== 'ACTIVE') throw fail(403, 'ده محتاج ADMIN.'); return u; }
const KEYS = ['scheduledClose', 'zeroOrder', 'highCpa', 'stockOut', 'protections', 'scope', 'days'];
const snap = (p) => ({ version: p.version, enabled: p.enabled, ...Object.fromEntries(KEYS.map((k) => [k, p[k]])) });
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function getPausePolicy() { return (await readRaw()).policy; }
export async function savePausePolicy({ patch, userId, now = new Date(), deps = {} }) {
  await requireAdmin(userId, deps); const { raw, policy: cur } = await readRaw();
  const merged = { ...cur }; for (const k of KEYS) if (patch && k in patch) merged[k] = (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) && k !== 'scope') ? { ...cur[k], ...patch[k] } : patch[k];
  const next = normalizePause({ ...merged, enabled: cur.enabled, version: cur.version, approved: cur.approved, history: cur.history });
  const errors = validatePause(next, { requireTrigger: cur.enabled }); if (errors.length) { const e = fail(400, errors.join(' '), 'INVALID_POLICY'); e.details = errors; throw e; }
  if (!KEYS.some((k) => !same(next[k], cur[k]))) return { policy: cur, changed: false };
  next.version = cur.version + 1; next.updatedAt = now.toISOString(); next.updatedBy = Number(userId); next.history = [...cur.history, { ...snap(cur), replacedAt: now.toISOString(), by: Number(userId) }].slice(-30);
  await write(raw, next, userId); await audit(userId, 'PAUSE_POLICY_SAVED', { from: snap(cur), to: snap(next) }); await event(userId, 'PAUSE_POLICY_SAVED', `حفظ سياسة الإيقاف v${next.version} — الاعتماد للتنفيذ التلقائي لسه على النسخة القديمة`, snap(next));
  return { policy: next, changed: true, wasEnabled: cur.enabled };
}
export async function setPausePolicyEnabled({ enabled, confirm, userId, now = new Date(), deps = {} }) {
  await requireAdmin(userId, deps); if (typeof enabled !== 'boolean') throw fail(400, 'enabled لازم true/false.'); if (confirm !== true) throw fail(400, 'محتاج تأكيد صريح.', 'CONFIRM_REQUIRED');
  const { raw, policy: cur } = await readRaw(); const reapprove = enabled && cur.enabled && cur.approved?.version !== cur.version; if (cur.enabled === enabled && !reapprove) return { policy: cur, changed: false };
  if (enabled) { const errors = validatePause(cur, { requireTrigger: true }); if (errors.length) { const e = fail(400, errors.join(' '), 'INVALID_POLICY'); e.details = errors; throw e; } }
  const next = { ...cur, enabled, approved: enabled ? { version: cur.version, at: now.toISOString(), by: Number(userId) } : null, updatedAt: now.toISOString(), updatedBy: Number(userId) };
  await write(raw, next, userId); await audit(userId, enabled ? 'PAUSE_POLICY_ENABLED' : 'PAUSE_POLICY_DISABLED', { snapshot: snap(next) }); await event(userId, enabled ? 'PAUSE_POLICY_ENABLED' : 'PAUSE_POLICY_DISABLED', `${enabled ? 'اعتماد' : 'إيقاف'} سياسة الإيقاف (v${next.version}) — مفيش حملة اتوقفت بسبب الزر`, snap(next));
  return { policy: next, changed: true };
}
/** the policy the engine may act on: enabled AND approved at its CURRENT version (a newer saved version is not used until approved) */
export const pausePolicyActive = (p) => !!(p && p.enabled && p.approved && p.approved.version === p.version);
export const today = (now) => cairoDate(now);
