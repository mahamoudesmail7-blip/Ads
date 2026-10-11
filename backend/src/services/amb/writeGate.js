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
    // 'HUMAN' = an owner who just confirmed THIS operation (manual operation, or approving a prepared automation decision): valid in MANUAL, APPROVAL and AUTOMATIC — never in SHADOW (simulation only)
    const want = mode === 'AUTOPILOT' ? 'AUTOPILOT' : mode === 'HUMAN' ? 'HUMAN' : 'APPROVAL';
    if (want === 'HUMAN') { if (!['OFF', 'APPROVAL', 'AUTOPILOT'].includes(config.mode)) push('MODE_SHADOW_NO_WRITE', `الوضع الحالي ${config.mode} — مفيش كتابة على Meta (محاكاة فقط). غيّر الوضع إلى MANUAL أو APPROVAL.`); }
    else if (config.mode !== want) push(want === 'APPROVAL' ? 'MODE_NOT_APPROVAL' : 'MODE_NOT_AUTOMATIC', `الوضع الحالي ${config.mode === 'OFF' ? 'MANUAL' : config.mode} — التنفيذ ${want === 'APPROVAL' ? 'بموافقتك' : 'التلقائي'} محتاج وضع ${want === 'APPROVAL' ? 'APPROVAL' : 'AUTOMATIC'}.`);
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

// =====================================================================================================================
// THE GLOBAL LAYER — the rules that apply to EVERY write to Meta, whichever feature started it (Operator, Clone, Launch, campaign schedules, uploads…):
//   Emergency Stop OFF  ·  the deployment lock (OPERATOR_ALLOW_META_WRITES) open.      (mode / per-operation permissions stay the Operator's own business — see evaluateWriteGate above)
// It is enforced at the two places that can actually reach the Graph API (metaGraphClient.graphPost and the chunked video upload), so no feature can forget it, and ALSO checked early at each feature's entry
// point so a refused run is a clean, explained refusal (nothing half-created) instead of a failure in the middle.
// =====================================================================================================================
/** Pure: Emergency Stop + deployment lock only. */
export function evaluateGlobalWriteGuard({ config }) {
  const reasons = [];
  if (!config) reasons.push({ code: 'NO_CONFIG', message: 'إعدادات الـOperator غير متاحة — كتابة Meta مرفوضة (fail-closed).' });
  else {
    if (config.emergency_stop) reasons.push({ code: 'EMERGENCY_STOP', message: 'إيقاف الطوارئ مفعّل — مفيش أي كتابة على Meta.' });
    if (config.writesLocked !== false) reasons.push({ code: 'META_WRITES_LOCKED', message: 'كتابة Meta مقفولة على مستوى النشر (OPERATOR_ALLOW_META_WRITES).' });
  }
  return reasons.length ? { ok: false, code: reasons[0].code, message: reasons[0].message, reasons } : { ok: true };
}

/** Thrown by the global layer. `status` 423 (Locked) so the routes answer with a clear refusal; `permanent` so no retry loop treats it as a transient Meta error. */
export class MetaWriteBlockedError extends Error {
  constructor(r, source) { super(`${r.message}${source ? ` [${source}]` : ''}`); this.name = 'MetaWriteBlockedError'; this.code = 'META_WRITE_BLOCKED'; this.reasonCode = r.code; this.reasons = (r.reasons || []).map((x) => x.code); this.status = 423; this.permanent = true; this.source = source || null; }
}
const lastAudit = new Map(); const AUDIT_DEDUPE_MS = 10 * 60_000; // a ticking scheduler must not flood the audit log with the same refusal
/**
 * The global check: reads the CURRENT operator config (deps.config = test injection) and returns {ok} / {ok:false, ...}. Audits a refusal (WRITE_GATE_BLOCK) at most once per source+reason per 10 minutes
 * (the first one always; `suppressed` counts the rest) unless deps.audit === false.
 */
export async function checkGlobalMetaWrite({ source = null, detail = null, userId = null, deps = {} } = {}) {
  let config = null;
  try { config = deps.config ? await (typeof deps.config === 'function' ? deps.config() : deps.config) : await getOperatorConfig(); } catch (e) { logger.error('[writeGate] cannot read operator config', { message: e.message }); }
  const r = evaluateGlobalWriteGuard({ config });
  if (r.ok) return r;
  if (deps.audit !== false) {
    const key = `${source || '-'}|${r.code}`; const now = Date.now(); const prev = lastAudit.get(key);
    if (!prev || now - prev.at > AUDIT_DEDUPE_MS || deps.auditEvery === true) {
      lastAudit.set(key, { at: now, n: 0 });
      try { await prisma.ambOperatorEvent.create({ data: { kind: 'WRITE_GATE_BLOCK', actor: 'SYSTEM', actor_id: userId ? Number(userId) : null, note: `منع كتابة Meta (طبقة عامة): ${source || 'unknown'} — ${r.code}`.slice(0, 480), data_json: JSON.stringify({ layer: 'GLOBAL', source, detail, codes: r.reasons.map((x) => x.code), suppressed: prev?.n || 0 }).slice(0, 3000) } }); }
      catch (e) { logger.warn('[writeGate] audit event failed', { message: e.message }); }
    } else prev.n++;
  }
  return r;
}
/** Throws MetaWriteBlockedError when the global layer refuses. */
export async function assertMetaWritesAllowed(opts = {}) {
  const r = await checkGlobalMetaWrite(opts);
  if (!r.ok) throw new MetaWriteBlockedError(r, opts.source);
  return r;
}
/** test hook: forget the audit de-duplication memory */
export const __resetGlobalAuditMemory = () => lastAudit.clear();
