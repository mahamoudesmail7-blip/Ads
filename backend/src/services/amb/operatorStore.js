// 🤖 AI Operator — persistence + validation for config, rules, exceptions, per-product settings and campaign tags. 2026-10-03.
// Every mutation is validated (operatorRules.validateRule for rules) and written to ai_audit_log (kind=OPERATOR_*) so a rule/mode/
// emergency-stop change is always traceable. The Operator NEVER edits user rules on its own — it can only recommend (see engine).
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { validateRule, detectRuleConflicts, ACTIONS } from './operatorRules.js';

export const OPERATOR_MODES = ['OFF', 'SHADOW', 'APPROVAL', 'AUTOPILOT'];
export const DEFAULT_LIMITS = {
  maxDecreasePct: 30, maxChangesPerCampaignPerDay: 2, maxActionsPerHour: 6, maxActionsPerDay: 30, minDaysCover: 7,
  lossLimits: { campaign: null, product: null, account: null },
  spendVelocity: { windowHours: 1, minSpend: 100, requireNoResult: true },
  collapse: { minSpend: 150, minPurchases: 3, worsePct: 30 },
  postScale: { checkAfterHours: 6, worsePct: 15, minPurchases: 3 },
  allowAutoRollback: false,
  // account-level guards (spec 74): null = no limit. A bad global rule must not be able to move the whole account in one day.
  account: { maxEnablesPerDay: null, maxPausesPerDay: null, maxBudgetIncreasePerDay: null, maxDailySpendUnderAi: null },
  manualOverrideCooldownHours: 24, // after a MANUAL change by the owner the Operator leaves the campaign alone (spec 86)
  minCampaignAgeHours: 24, attributionGraceHours: 6, // never pause on immature conversion data (spec 70/71)
  pendingEvaluationHours: 24, // an executed OPEN/SCALE blocks another risky action until its effect is measured or this long passed
};
export const DEFAULT_COOLDOWNS = { OPEN: 24, PAUSE: 12, SCALE_UP: 24, SCALE_DOWN: 12 };
export const DEFAULT_SCHEDULE = { mode: 'ALWAYS', ranges: [], tzOffsetHours: 3 };
const EXCEPTION_TYPES = ['NO_AUTO_STOP', 'NO_AUTO_OPEN', 'NO_AUTO_SCALE', 'NO_BUDGET_CHANGE', 'NO_AUTOMATION'];
const SCOPE_TYPES = ['STORE', 'PRODUCT', 'CAMPAIGN', 'ADSET', 'AD', 'TAG'];
export const CAMPAIGN_TAGS = ['TESTING', 'SCALE', 'RETARGET', 'PROTECTED'];

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const merge = (base, over) => ({ ...base, ...(over || {}), ...Object.fromEntries(Object.entries(over || {}).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)).map(([k, v]) => [k, { ...(base?.[k] || {}), ...v }])) });

async function audit({ actorId = null, kind, input, success = true, error = null }) {
  try { await prisma.aiAuditLog.create({ data: { actor_id: actorId || null, kind, action: 'EXECUTE', input_json: input !== undefined ? JSON.stringify(input).slice(0, 4000) : null, success, error } }); }
  catch (err) { logger.error('[operatorStore] audit write failed', { message: err.message }); }
}

// ---------------------------------------------------------------------------
// Config (mode + Emergency Stop + limits)
// ---------------------------------------------------------------------------
/** Returns the effective config. The GLOBAL row is created on first read with mode SHADOW — never AUTOPILOT by default. */
export async function getOperatorConfig() {
  let row = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } });
  if (!row) {
    try { row = await prisma.ambOperatorConfig.create({ data: { scope: 'GLOBAL', mode: 'SHADOW' } }); }
    catch (err) { if (err.code === 'P2002') row = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); else throw err; }
  }
  return shapeConfig(row);
}
export function shapeConfig(row) {
  return {
    id: row.id, mode: row.mode, emergency_stop: !!row.emergency_stop, emergency_reason: row.emergency_reason, emergency_at: row.emergency_at,
    limits: merge(DEFAULT_LIMITS, j(row.limits_json, {})), cooldowns: { ...DEFAULT_COOLDOWNS, ...(j(row.cooldowns_json, {}) || {}) },
    schedule: { ...DEFAULT_SCHEDULE, ...(j(row.schedule_json, {}) || {}) }, updated_at: row.updated_at,
    storeLimits: j(row.store_limits_json, {}) || {}, limitsConfigured: !!row.limits_json, autopilotAttest: j(row.autopilot_attest_json, {}) || {},
  };
}

export const ATTEST_KEYS = {
  regression: 'مفيش Regression حرج (الاختبارات الآلية عدّت)',
  executor: 'الـExecutor الحالي (الكتابة على Meta) اتراجع واتجرّب بموافقتي على حملة واحدة منخفضة المخاطر',
  idempotency: 'اتأكدت إن التنفيذ مش بيتكرر (Idempotency) من اختبارات الـOperator',
  storeIsolation: 'اتأكدت إن المتاجر معزولة عن بعض',
};

async function emergencyStopTested() {
  const rows = await prisma.aiAuditLog.findMany({ where: { kind: 'OPERATOR_EMERGENCY_STOP' }, orderBy: { id: 'asc' }, select: { input_json: true }, take: 500 });
  let on = false, onThenOff = false;
  for (const r of rows) { const i = j(r.input_json, {}); if (i.on) on = true; else if (on) onThenOff = true; }
  return onThenOff;
}

/**
 * Autopilot activation gate (spec 111/112). NEVER opens by itself: every check must pass AND the owner must explicitly confirm. Passing time in
 * Shadow does not enable anything — the shadow period is only reported. Attestations (regression / executor / idempotency / store isolation) are
 * explicit human confirmations stored with who/when, because they cannot be proven from inside the running app.
 */
export async function autopilotGate() {
  const cfg = await getOperatorConfig();
  const [rules, firstDecision, decisionCount, shadowReviewed] = await Promise.all([
    listRules(),
    prisma.ambOperatorDecision.findFirst({ orderBy: { created_at: 'asc' }, select: { created_at: true } }),
    prisma.ambOperatorDecision.count(),
    prisma.ambOperatorDecision.count({ where: { mode_at_decision: 'SHADOW' } }),
  ]);
  const enabled = rules.filter((r) => r.enabled);
  const invalid = enabled.filter((r) => !validateRule(r).ok);
  const acct = cfg.limits.account || {}, loss = cfg.limits.lossLimits || {};
  const accountLimits = cfg.limitsConfigured && (acct.maxEnablesPerDay != null || acct.maxPausesPerDay != null || acct.maxBudgetIncreasePerDay != null || acct.maxDailySpendUnderAi != null || loss.account != null);
  const stopTested = await emergencyStopTested();
  const att = cfg.autopilotAttest || {};
  const shadowDays = firstDecision ? Math.floor((Date.now() - firstDecision.created_at.getTime()) / 86_400_000) : 0;
  const checks = [
    { key: 'shadow', label: 'تقييم Shadow واحد على الأقل اتسجّل', ok: shadowReviewed > 0 && decisionCount > 0, detail: `${decisionCount} قرار مسجّل · أول تسجيل منذ ${shadowDays} يوم (الموصى به 7+ أيام — القرار ليك)`, auto: true },
    { key: 'rules', label: 'فيه قاعدة مفعّلة وكل القواعد المفعّلة صالحة', ok: enabled.length > 0 && invalid.length === 0, detail: `${enabled.length} مفعّلة · ${invalid.length} غير صالحة`, auto: true },
    { key: 'accountLimits', label: 'حدود الحساب اليومية متحددة (أكشنز/ميزانية/خسارة)', ok: accountLimits, detail: accountLimits ? 'تم' : 'حدّد حد واحد على الأقل من "الأمان والحدود"', auto: true },
    { key: 'emergencyStop', label: 'إيقاف الطوارئ اتجرّب (تفعيل ثم إلغاء)', ok: stopTested, detail: stopTested ? 'تم' : 'جرّب 🛑 إيقاف فوري ثم ألغِه مرة واحدة', auto: true },
    { key: 'emergencyOff', label: 'إيقاف الطوارئ غير مفعّل دلوقتي', ok: !cfg.emergency_stop, detail: cfg.emergency_stop ? 'مفعّل' : 'تمام', auto: true },
    ...Object.entries(ATTEST_KEYS).map(([k, label]) => ({ key: `attest:${k}`, label, ok: !!att[k], detail: att[k] ? `مؤكَّد (${att[k].at})` : 'محتاج تأكيدك الصريح', auto: false })),
  ];
  return { ok: checks.every((c) => c.ok), checks, shadowDays, note: 'تمرير كل الشروط مش بيفعّل Autopilot لوحده — لازم تفعّله بنفسك. فترة Shadow الموصى بها قرارك انت.' };
}
export async function attestAutopilot({ keys, userId = null }) {
  const bad = (keys || []).filter((k) => !ATTEST_KEYS[k]);
  if (bad.length) { const e = new Error(`تأكيد غير معروف: ${bad.join(', ')}`); e.status = 400; throw e; }
  const cur = await getOperatorConfig();
  const next = { ...cur.autopilotAttest }; const at = new Date().toISOString();
  for (const k of keys || []) next[k] = { by: userId, at };
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { autopilot_attest_json: JSON.stringify(next), updated_by_id: userId } });
  await audit({ actorId: userId, kind: 'OPERATOR_AUTOPILOT_ATTEST', input: { keys } });
  return getOperatorConfig();
}
export async function revokeAttestations({ userId = null } = {}) {
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { autopilot_attest_json: null, updated_by_id: userId } });
  await audit({ actorId: userId, kind: 'OPERATOR_AUTOPILOT_ATTEST', input: { revoked: true } });
  return getOperatorConfig();
}

async function recordEvent(data) { try { await prisma.ambOperatorEvent.create({ data }); } catch (err) { logger.error('[operatorStore] event write failed', { message: err.message }); } }

export async function setOperatorMode({ mode, userId = null, confirmAutopilot = false }) {
  if (!OPERATOR_MODES.includes(mode)) { const e = new Error(`وضع غير مدعوم: ${mode}`); e.status = 400; throw e; }
  const cur = await getOperatorConfig();
  if (mode === 'AUTOPILOT' && !confirmAutopilot) { const e = new Error('تفعيل Autopilot محتاج تأكيد صريح (confirmAutopilot).'); e.status = 400; throw e; }
  if (mode === 'AUTOPILOT' && cur.emergency_stop) { const e = new Error('إيقاف الطوارئ مفعّل — ألغيه الأول قبل Autopilot.'); e.status = 409; throw e; }
  if (mode === 'AUTOPILOT') {
    const gate = await autopilotGate();
    if (!gate.ok) { const e = new Error(`Autopilot مش جاهز: ${gate.checks.filter((c) => !c.ok).map((c) => c.label).join(' | ')}`); e.status = 409; e.details = gate.checks.filter((c) => !c.ok); throw e; }
  }
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { mode, updated_by_id: userId } });
  await audit({ actorId: userId, kind: 'OPERATOR_MODE', input: { from: cur.mode, to: mode } });
  await recordEvent({ kind: 'MODE_CHANGE', actor: 'USER', actor_id: userId, note: `${cur.mode} -> ${mode}` });
  return getOperatorConfig();
}

/** Emergency Stop overrides every rule: no OPEN / PAUSE / budget change / scale. Monitoring and analytics continue. */
export async function setEmergencyStop({ on, reason = null, userId = null }) {
  await getOperatorConfig();
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { emergency_stop: !!on, emergency_reason: on ? (reason || 'إيقاف يدوي') : null, emergency_by_id: on ? userId : null, emergency_at: on ? new Date() : null, updated_by_id: userId } });
  await audit({ actorId: userId, kind: 'OPERATOR_EMERGENCY_STOP', input: { on: !!on, reason } });
  await recordEvent({ kind: 'EMERGENCY_STOP', actor: 'USER', actor_id: userId, note: on ? `ON: ${reason || 'إيقاف يدوي'}` : 'OFF' });
  return getOperatorConfig();
}

const LIMIT_KEYS_ACCOUNT = ['maxEnablesPerDay', 'maxPausesPerDay', 'maxBudgetIncreasePerDay', 'maxDailySpendUnderAi'];
export function validateLimits(patch) {
  const errors = [];
  const L = patch.limits || {};
  const chk = (k, min, max) => { if (L[k] !== undefined && L[k] !== null && (!Number.isFinite(Number(L[k])) || Number(L[k]) < min || Number(L[k]) > max)) errors.push(`${k} لازم يكون بين ${min} و${max}.`); };
  chk('maxDecreasePct', 1, 90); chk('maxChangesPerCampaignPerDay', 1, 20); chk('maxActionsPerHour', 1, 200); chk('maxActionsPerDay', 1, 2000); chk('minDaysCover', 0, 365);
  chk('manualOverrideCooldownHours', 0, 720); chk('minCampaignAgeHours', 0, 720); chk('attributionGraceHours', 0, 168); chk('pendingEvaluationHours', 0, 168);
  for (const [k, v] of Object.entries(L.lossLimits || {})) if (v !== null && (!Number.isFinite(Number(v)) || Number(v) < 0)) errors.push(`lossLimits.${k} لازم يكون رقم موجب أو null.`);
  const chkScope = (name, o) => { for (const [k, v] of Object.entries(o || {})) { if (!LIMIT_KEYS_ACCOUNT.includes(k)) errors.push(`${name}: حد غير معروف ${k}`); else if (v !== null && (!Number.isFinite(Number(v)) || Number(v) < 0)) errors.push(`${name}.${k} لازم يكون رقم موجب أو null.`); } };
  chkScope('account', L.account);
  for (const [storeId, o] of Object.entries(patch.storeLimits || {})) { if (!storeId) errors.push('storeId فاضي.'); chkScope(`store[${storeId}]`, o); }
  for (const [k, v] of Object.entries(patch.cooldowns || {})) { if (!['OPEN', 'PAUSE', 'SCALE_UP', 'SCALE_DOWN'].includes(k)) errors.push(`cooldown غير معروف: ${k}`); else if (!Number.isInteger(v) || v < 1 || v > 168) errors.push(`cooldown ${k} لازم يكون بين 1 و168 ساعة.`); }
  const s = patch.schedule;
  if (s) {
    if (!['ALWAYS', 'HOURS', 'EXCLUDED_HOURS'].includes(s.mode)) errors.push('schedule.mode غير صالح.');
    for (const r of s.ranges || []) if (!/^\d{1,2}:\d{2}$/.test(r.from || '') || !/^\d{1,2}:\d{2}$/.test(r.to || '')) errors.push('نطاق ساعات غير صالح (HH:MM).');
  }
  return errors;
}
export async function updateOperatorLimits({ limits, cooldowns, schedule, storeLimits, userId = null }) {
  const errors = validateLimits({ limits, cooldowns, schedule, storeLimits });
  if (errors.length) { const e = new Error(errors.join(' ')); e.status = 400; e.details = errors; throw e; }
  const cur = await getOperatorConfig();
  const data = { updated_by_id: userId };
  if (limits) data.limits_json = JSON.stringify(merge(cur.limits, limits));
  if (cooldowns) data.cooldowns_json = JSON.stringify({ ...cur.cooldowns, ...cooldowns });
  if (schedule) data.schedule_json = JSON.stringify({ ...cur.schedule, ...schedule });
  if (storeLimits) { const next = { ...cur.storeLimits }; for (const [sid, o] of Object.entries(storeLimits)) next[sid] = { ...(next[sid] || {}), ...o }; data.store_limits_json = JSON.stringify(next); }
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data });
  await audit({ actorId: userId, kind: 'OPERATOR_LIMITS', input: { limits, cooldowns, schedule, storeLimits } });
  return getOperatorConfig();
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
export function shapeRule(r) {
  return {
    id: r.id, rule_uuid: r.rule_uuid, name: r.name, description: r.description, enabled: r.enabled, store_id: r.store_id, scope: j(r.scope_json, {}), window: r.window,
    conditions: j(r.conditions_json, { all: [] }), action: r.action, action_params: j(r.action_params_json, {}), mode: r.mode, cooldown_hours: r.cooldown_hours,
    priority: r.priority, source: r.source, nl_text: r.nl_text, validation: j(r.validation_json, null), version: r.version, created_at: r.created_at, updated_at: r.updated_at,
  };
}
export async function listRules() { return (await prisma.ambOperatorRule.findMany({ orderBy: [{ priority: 'asc' }, { id: 'asc' }] })).map(shapeRule); }

/**
 * Create/update a rule. A rule that fails validation is NOT saved (errors returned). A rule can be saved disabled in any state of
 * warnings; ENABLING requires zero errors. Enabling AUTOPILOT additionally requires the rule's own validation to carry no errors and
 * is reported with the conflicts it creates.
 */
export async function saveRule({ id = null, rule, userId = null }) {
  const v = validateRule(rule);
  if (!v.ok) return { ok: false, validation: v, conflicts: [] };
  const existing = id ? await prisma.ambOperatorRule.findUnique({ where: { id: Number(id) } }) : null;
  if (id && !existing) { const e = new Error('القاعدة غير موجودة.'); e.status = 404; throw e; }
  const data = {
    name: String(rule.name).trim(), description: rule.description || null, enabled: !!rule.enabled, store_id: rule.store_id || null, scope_json: JSON.stringify(rule.scope || {}),
    window: rule.window || 'today', conditions_json: JSON.stringify(rule.conditions), action: rule.action, action_params_json: JSON.stringify(rule.action_params || {}),
    mode: rule.mode || 'SHADOW', cooldown_hours: rule.cooldown_hours ?? 24, priority: rule.priority ?? 100, source: rule.source || 'BUILDER', nl_text: rule.nl_text || null,
    validation_json: JSON.stringify({ warnings: v.warnings, at: new Date().toISOString() }),
  };
  const row = existing
    ? await prisma.ambOperatorRule.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } })
    : await prisma.ambOperatorRule.create({ data: { ...data, rule_uuid: crypto.randomUUID(), created_by_id: userId } });
  const shaped = shapeRule(row);
  const all = await listRules();
  const conflicts = detectRuleConflicts(all).filter((c) => c.a === shaped.id || c.b === shaped.id);
  await audit({ actorId: userId, kind: existing ? 'OPERATOR_RULE_UPDATE' : 'OPERATOR_RULE_CREATE', input: { id: shaped.id, name: shaped.name, action: shaped.action, mode: shaped.mode, enabled: shaped.enabled, source: shaped.source } });
  return { ok: true, rule: shaped, validation: v, conflicts };
}
export async function setRuleEnabled({ id, enabled, userId = null }) {
  const row = await prisma.ambOperatorRule.findUnique({ where: { id: Number(id) } });
  if (!row) { const e = new Error('القاعدة غير موجودة.'); e.status = 404; throw e; }
  const shaped = shapeRule(row);
  if (enabled) { const v = validateRule(shaped); if (!v.ok) return { ok: false, validation: v }; }
  const upd = await prisma.ambOperatorRule.update({ where: { id: row.id }, data: { enabled: !!enabled } });
  await audit({ actorId: userId, kind: 'OPERATOR_RULE_TOGGLE', input: { id: row.id, enabled: !!enabled } });
  const all = await listRules();
  return { ok: true, rule: shapeRule(upd), conflicts: detectRuleConflicts(all).filter((c) => c.a === row.id || c.b === row.id) };
}
export async function deleteRule({ id, userId = null }) {
  await prisma.ambOperatorRule.delete({ where: { id: Number(id) } });
  await audit({ actorId: userId, kind: 'OPERATOR_RULE_DELETE', input: { id } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Exceptions (always override automation) + temporary overrides
// ---------------------------------------------------------------------------
export function shapeException(e) { return { id: e.id, store_id: e.store_id, scope_type: e.scope_type, scope_id: e.scope_id, scope_label: e.scope_label, types: j(e.types_json, []), reason: e.reason, expires_at: e.expires_at, active: e.active, temporary: !!e.expires_at, created_at: e.created_at }; }
export async function addException({ storeId = null, scopeType, scopeId, scopeLabel = null, types, reason = null, ttlHours = null, userId = null }) {
  if (!SCOPE_TYPES.includes(scopeType)) { const e = new Error(`نطاق استثناء غير مدعوم: ${scopeType}`); e.status = 400; throw e; }
  if (!scopeId) { const e = new Error('scopeId مطلوب.'); e.status = 400; throw e; }
  const ts = Array.isArray(types) ? types : [];
  if (!ts.length || ts.some((t) => !EXCEPTION_TYPES.includes(t))) { const e = new Error(`أنواع الاستثناء المسموحة: ${EXCEPTION_TYPES.join(' / ')}`); e.status = 400; throw e; }
  if (ttlHours !== null && (!Number.isFinite(Number(ttlHours)) || Number(ttlHours) <= 0 || Number(ttlHours) > 24 * 60)) { const e = new Error('مدة الاستثناء المؤقت لازم تكون بين ساعة و60 يوم.'); e.status = 400; throw e; }
  const row = await prisma.ambOperatorException.create({ data: { store_id: storeId, scope_type: scopeType, scope_id: String(scopeId), scope_label: scopeLabel, types_json: JSON.stringify(ts), reason, expires_at: ttlHours ? new Date(Date.now() + Number(ttlHours) * 3_600_000) : null, created_by_id: userId } });
  await audit({ actorId: userId, kind: 'OPERATOR_EXCEPTION_ADD', input: { scopeType, scopeId, types: ts, ttlHours, reason } });
  return shapeException(row);
}
export async function removeException({ id, userId = null }) {
  await prisma.ambOperatorException.update({ where: { id: Number(id) }, data: { active: false } });
  await audit({ actorId: userId, kind: 'OPERATOR_EXCEPTION_REMOVE', input: { id } });
  return { ok: true };
}
/** Active, non-expired exceptions (expiry is evaluated here, so a forgotten temporary override can never outlive its TTL). */
export async function listExceptions({ includeExpired = false, now = new Date() } = {}) {
  const rows = await prisma.ambOperatorException.findMany({ where: { active: true }, orderBy: { created_at: 'desc' } });
  return rows.filter((r) => includeExpired || !r.expires_at || r.expires_at > now).map(shapeException);
}
/** Exceptions that apply to ONE campaign (store / product / campaign / tag scope). Pure over an already-loaded list. */
export function exceptionsFor({ exceptions, storeId, productId, campaignId, tag }) {
  return exceptions.filter((e) => (
    (e.scope_type === 'STORE' && e.scope_id === String(storeId)) ||
    (e.scope_type === 'PRODUCT' && productId != null && e.scope_id === String(productId)) ||
    (e.scope_type === 'CAMPAIGN' && e.scope_id === String(campaignId)) ||
    (e.scope_type === 'TAG' && tag && e.scope_id === String(tag))
  ) && (!e.store_id || e.store_id === storeId));
}

// ---------------------------------------------------------------------------
// Per-product settings + campaign tags
// ---------------------------------------------------------------------------
export async function getProductConfig(productId, storeId) { return prisma.ambOperatorProductConfig.findUnique({ where: { product_id_store_id: { product_id: Number(productId), store_id: storeId } } }); }
export async function upsertProductConfig({ productId, storeId, patch, userId = null }) {
  if (!storeId) { const e = new Error('storeId مطلوب.'); e.status = 400; throw e; }
  const num = (v, name) => { if (v === undefined) return undefined; if (v === null || v === '') return null; const n = Number(v); if (!Number.isFinite(n) || n < 0) { const e = new Error(`${name} لازم يكون رقم موجب.`); e.status = 400; throw e; } return n; };
  const data = { product_key: patch.product_key === undefined ? undefined : (String(patch.product_key || '').trim() || null), target_cpa: num(patch.target_cpa, 'Target CPA'), max_cpa: num(patch.max_cpa, 'Max CPA'), hard_stop_cpa: num(patch.hard_stop_cpa, 'Hard Stop CPA'), min_profit: num(patch.min_profit, 'Min Profit'), min_margin_pct: num(patch.min_margin_pct, 'Min Margin'), min_stock: num(patch.min_stock, 'Min Stock'), notes: patch.notes, updated_by_id: userId };
  if (data.hard_stop_cpa != null && data.target_cpa != null && data.hard_stop_cpa < data.target_cpa) { const e = new Error('Hard Stop CPA لازم يكون أكبر من أو يساوي Target CPA.'); e.status = 400; throw e; }
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const row = await prisma.ambOperatorProductConfig.upsert({ where: { product_id_store_id: { product_id: Number(productId), store_id: storeId } }, create: { product_id: Number(productId), store_id: storeId, ...clean }, update: clean });
  await audit({ actorId: userId, kind: 'OPERATOR_PRODUCT_CONFIG', input: { productId, storeId, patch } });
  return row;
}
export async function setCampaignTag({ adAccountId, campaignId, storeId = null, productId = null, tag, testing = null, userId = null }) {
  if (tag !== null && !CAMPAIGN_TAGS.includes(tag)) { const e = new Error(`وسم غير مدعوم. المسموح: ${CAMPAIGN_TAGS.join(' / ')}`); e.status = 400; throw e; }
  if (tag === null) { await prisma.ambOperatorCampaignTag.deleteMany({ where: { ad_account_id: adAccountId, campaign_id: campaignId } }); await audit({ actorId: userId, kind: 'OPERATOR_CAMPAIGN_TAG', input: { campaignId, tag: null } }); return null; }
  const t = testing && tag === 'TESTING' ? JSON.stringify({ spendAllowance: testing.spendAllowance ?? null, minSample: testing.minSample ?? null, evaluationDays: testing.evaluationDays ?? null, stopSpend: testing.stopSpend ?? null }) : null;
  const row = await prisma.ambOperatorCampaignTag.upsert({ where: { ad_account_id_campaign_id: { ad_account_id: adAccountId, campaign_id: campaignId } }, create: { ad_account_id: adAccountId, campaign_id: campaignId, store_id: storeId, product_id: productId, tag, testing_json: t, created_by_id: userId }, update: { tag, store_id: storeId, product_id: productId, testing_json: t } });
  await audit({ actorId: userId, kind: 'OPERATOR_CAMPAIGN_TAG', input: { campaignId, tag } });
  return row;
}
export async function loadCampaignTags(adAccountId) {
  const rows = await prisma.ambOperatorCampaignTag.findMany({ where: { ad_account_id: adAccountId } });
  return new Map(rows.map((r) => [r.campaign_id, { tag: r.tag, testing: j(r.testing_json, null) }]));
}
export { ACTIONS, EXCEPTION_TYPES, SCOPE_TYPES };
