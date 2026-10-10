// 🔐 THE CENTRAL META-WRITE GATE. Every operation that changes a campaign's status or budget on Meta (open / pause / budget increase / budget decrease) must pass through here
// IMMEDIATELY before the write, no matter which feature started it (daily plans, rule decisions, the budget bridge, the legacy recommendations route, the assistant tasks, product decisions).
// It is deliberately independent of the caller's own gates (defense in depth): a caller that forgot — or an old route that never knew — about the Operator's controls is still stopped here.
//
//   Emergency Stop OFF  ·  global mode matches the approval kind (APPROVAL for a human approval, AUTOMATIC/AUTOPILOT only for the autopilot path)  ·  the deployment lock
//   (OPERATOR_ALLOW_META_WRITES) is open — this module can NEVER change it  ·  the operation's OWN permission switch is ON (open / pause / budgetIncrease / budgetDecrease are independent).
//
// A refusal is recorded as an operator event (audit) and returned as data; nothing is sent to Meta and no recommendation/action row changes state.
import { logger } from '../../logger.js';
import { prisma } from '../../prisma.js';
import { getOperatorConfig } from './operatorStore.js';
import { PERMISSION_META } from './executionPermissions.js';

/** executor action type -> the permission switch it needs */
export const GATE_PERMISSION = { RESUME: 'open', PAUSE: 'pause', INCREASE_BUDGET: 'budgetIncrease', DECREASE_BUDGET: 'budgetDecrease' };
export const GATED_ACTIONS = Object.keys(GATE_PERMISSION);

/** Pure: why this write must NOT go out right now. Returns {ok:true} or {ok:false, code, message, reasons[]} (all reasons, first one = primary). */
export function evaluateWriteGate({ config, actionType, mode = 'APPROVAL' }) {
  const reasons = [];
  const push = (code, message) => reasons.push({ code, message });
  const need = GATE_PERMISSION[actionType];
  if (!need) push('ACTION_NOT_GATED', `الأكشن ${actionType} غير معروف لبوابة الكتابة — مرفوض (fail-closed).`);
  if (!config) push('NO_CONFIG', 'إعدادات الـOperator غير متاحة — مرفوض (fail-closed).');
  else {
    if (config.emergency_stop) push('EMERGENCY_STOP', 'إيقاف الطوارئ مفعّل — مفيش أي كتابة على Meta.');
    const want = mode === 'AUTOPILOT' ? 'AUTOPILOT' : 'APPROVAL';
    if (config.mode !== want) push(want === 'APPROVAL' ? 'MODE_NOT_APPROVAL' : 'MODE_NOT_AUTOMATIC', `الوضع الحالي ${config.mode === 'OFF' ? 'MANUAL' : config.mode} — التنفيذ ${want === 'APPROVAL' ? 'بموافقتك' : 'التلقائي'} محتاج وضع ${want === 'APPROVAL' ? 'APPROVAL' : 'AUTOMATIC'}.`);
    if (config.writesLocked !== false) push('META_WRITES_LOCKED', 'كتابة Meta مقفولة على مستوى النشر (OPERATOR_ALLOW_META_WRITES).'); // anything but an explicit false is "locked"
    if (need && !(config.execPermissions && config.execPermissions[need] === true)) push('PERMISSION_OFF', `صلاحية «${PERMISSION_META[need]?.label || need}» مقفولة — فعّلها من «صلاحيات التنفيذ» (ADMIN + تأكيد).`);
  }
  if (!reasons.length) return { ok: true, permission: need };
  return { ok: false, code: reasons[0].code, message: reasons[0].message, reasons };
}

/**
 * The gate for the real world: reads the CURRENT operator config (or `deps.config`, test injection only) and evaluates it.
 * On refusal writes an audit event. Never throws for a refusal — callers decide how to surface it (the executor returns {ok:false, blocked:true}).
 */
export async function checkMetaWrite({ actionType, mode = 'APPROVAL', entityId = null, entityName = null, source = null, userId = null, deps = {} } = {}) {
  let config = null;
  try { config = deps.config ? await (typeof deps.config === 'function' ? deps.config() : deps.config) : await getOperatorConfig(); } catch (e) { logger.error('[writeGate] cannot read operator config', { message: e.message }); }
  const r = evaluateWriteGate({ config, actionType, mode });
  if (r.ok) return r;
  if (deps.audit !== false) {
    try { await prisma.ambOperatorEvent.create({ data: { kind: 'WRITE_GATE_BLOCK', actor: 'SYSTEM', actor_id: userId ? Number(userId) : null, campaign_id: entityId ? String(entityId) : null, note: `منع كتابة Meta: ${actionType} — ${r.code}${source ? ` (${source})` : ''}`, data_json: JSON.stringify({ actionType, mode, source, entityId, entityName, codes: r.reasons.map((x) => x.code) }).slice(0, 3000) } }); }
    catch (e) { logger.warn('[writeGate] audit event failed', { message: e.message }); }
  }
  return r;
}
