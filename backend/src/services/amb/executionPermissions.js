// 🔐 صلاحيات التنفيذ — four INDEPENDENT switches (open / pause / budget increase / budget decrease). Every one is OFF by default.
// A switch is only a PERMISSION: nothing executes unless ALSO (a) the global mode is APPROVAL, (b) the deployment write-lock (OPERATOR_ALLOW_META_WRITES) is open — this module can NEVER change that,
// (c) no Emergency Stop, and (d) an ADMIN approves each plan / decision. Changing a switch needs an ADMIN + an explicit confirmation (`confirm: true`) and is audited twice (AiAuditLog + operator event).
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getOperatorConfig } from './operatorStore.js';

export const PERMISSION_KEYS = ['open', 'pause', 'budgetIncrease', 'budgetDecrease'];
export const PERMISSION_META = {
  open: { label: 'فتح الحملات', icon: '▶️', desc: 'يسمح لخطط الفتح (جدول 12 ص) بإرسال تفعيل حملة لـMeta بعد اعتمادك.', action: 'RESUME' },
  pause: { label: 'إيقاف الحملات', icon: '⏸️', desc: 'يسمح لخطط الإيقاف (جدول 1 ظ) بإرسال إيقاف حملة لـMeta بعد اعتمادك.', action: 'PAUSE' },
  budgetIncrease: { label: 'زيادة الميزانية', icon: '📈', desc: 'يسمح بقرار زيادة ميزانية (+20%) بعد اعتمادك. مسار الزيادة لسه ما اتجرّبش فعليًا على Meta.', action: 'INCREASE_BUDGET' },
  budgetDecrease: { label: 'تقليل الميزانية', icon: '📉', desc: 'يسمح بقرار تقليل ميزانية (−20%) بعد اعتمادك (اتجرّب فعليًا وVERIFIED).', action: 'DECREASE_BUDGET' },
};
const ACTION_KEY = { SCALE_UP: 'budgetIncrease', SCALE_DOWN: 'budgetDecrease', OPEN: 'open', RESUME: 'open', PAUSE: 'pause' };
/** which permission an operator/budget action needs */
export const permissionFor = (action) => ACTION_KEY[action] || null;
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const strict = (o) => Object.fromEntries(PERMISSION_KEYS.map((k) => [k, o?.[k] === true])); // only a literal `true` counts

export async function getExecutionPermissions({ historyLimit = 12 } = {}) {
  const cfg = await getOperatorConfig();
  const events = await prisma.ambOperatorEvent.findMany({ where: { kind: 'PERMISSION_CHANGE' }, orderBy: { id: 'desc' }, take: historyLimit });
  const last = {};
  for (const e of events) { const d = j(e.data_json, {}); if (d?.key && !last[d.key]) last[d.key] = { on: d.to, at: e.created_at, actorId: e.actor_id }; }
  return {
    permissions: strict(cfg.execPermissions),
    meta: PERMISSION_META,
    last,
    lock: { writesLocked: cfg.writesLocked, mode: cfg.mode, emergencyStop: cfg.emergency_stop },
    history: events.map((e) => { const d = j(e.data_json, {}); return { at: e.created_at, actorId: e.actor_id, key: d.key, from: d.from, to: d.to, note: e.note }; }),
  };
}

async function requireAdmin(userId, deps = {}) {
  const u = deps.user || await prisma.user.findUnique({ where: { id: Number(userId) }, select: { id: true, role: true, status: true } });
  if (!u || u.role !== 'ADMIN' || u.status !== 'ACTIVE') { const e = new Error('تغيير صلاحيات التنفيذ محتاج ADMIN.'); e.status = 403; throw e; }
  return u;
}

/** Turn ONE permission on/off. Never touches OPERATOR_ALLOW_META_WRITES, the mode, the Auto toggles or any other permission. */
export async function setExecutionPermission({ key, on, confirm, userId, deps = {} }) {
  if (!PERMISSION_KEYS.includes(key)) { const e = new Error(`صلاحية غير معروفة: ${key}`); e.status = 400; throw e; }
  if (typeof on !== 'boolean') { const e = new Error('on لازم true أو false.'); e.status = 400; throw e; }
  await requireAdmin(userId, deps);
  if (confirm !== true) { const e = new Error('تغيير الصلاحية محتاج تأكيد صريح (confirm).'); e.status = 400; e.code = 'CONFIRM_REQUIRED'; throw e; }
  const row = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } });
  const rawLimits = j(row?.limits_json, null) || {};
  const before = strict(rawLimits.execPermissions);
  if (before[key] === on) return { ok: true, changed: false, permissions: before };
  const next = { ...before, [key]: on };
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify({ ...rawLimits, execPermissions: next }), updated_by_id: userId } });
  await prisma.aiAuditLog.create({ data: { actor_id: Number(userId), kind: 'OPERATOR_EXEC_PERMISSION', action: 'EXECUTE', input_json: JSON.stringify({ key, from: before[key], to: on }), success: true } }).catch((e) => logger.warn('[executionPermissions] audit failed', { message: e.message }));
  await prisma.ambOperatorEvent.create({ data: { kind: 'PERMISSION_CHANGE', actor: 'USER', actor_id: Number(userId), note: `${PERMISSION_META[key].label}: ${before[key] ? 'ON' : 'OFF'} → ${on ? 'ON' : 'OFF'}`, data_json: JSON.stringify({ key, from: before[key], to: on }) } }).catch((e) => logger.warn('[executionPermissions] event failed', { message: e.message }));
  return { ok: true, changed: true, permissions: next };
}
