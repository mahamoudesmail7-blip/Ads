// 🖐️ MANUAL OPERATIONS — a REAL manual mode: the owner picks ONE campaign (or ad set) and ONE operation (open · pause · increase · reduce), sees a live PREFLIGHT, and confirms that exact change.
//   preflight (read-only, live Meta read)  →  explicit confirmation contract  →  the same central gate + the same write stage as every other path  →  independent read-back  →  Execution History.
// Rules: ADMIN only · the global mode must not be SHADOW (SHADOW only simulates and records) · the operation's own permission switch must be ON · Emergency Stop / deployment lock apply · the confirmation must echo
// the live state the preflight showed (campaign, operation, from → to, token); if Meta moved in between, nothing is sent (STATE_CHANGED) · one confirmation = one write (idempotent by token) · warnings that need
// an explicit acknowledgement (out of stock, unmapped campaign, a product in AUTOMATIC) must be acknowledged by name. Nothing here is scheduled, retried or repeated.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { getOperatorConfig } from './operatorStore.js';
import { evaluateWriteGate, GATE_PERMISSION } from './writeGate.js';
import { previewBudgetChange, readBudgetStructure, budgetLimits } from './budgetChange.js';
import { performWrite } from './automationEngine.js';

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export const MANUAL_OPS = { OPEN: { amb: 'RESUME', action: 'OPEN', label: 'فتح الحملة' }, PAUSE: { amb: 'PAUSE', action: 'PAUSE', label: 'إيقاف الحملة' }, INCREASE: { amb: 'INCREASE_BUDGET', action: 'SCALE_UP', label: 'زيادة الميزانية' }, REDUCE: { amb: 'DECREASE_BUDGET', action: 'SCALE_DOWN', label: 'تقليل الميزانية' } };
const TOKEN_TTL_MS = 10 * 60_000;
const fail = (status, message, code, extra = {}) => { const e = new Error(message); e.status = status; e.code = code; Object.assign(e, extra); return e; };
const secret = () => { const s = process.env.JWT_SECRET || process.env.SESSION_SECRET; if (s) return s; if (process.env.NODE_ENV === 'production') throw fail(500, 'مفيش سر توقيع للتأكيد اليدوي (JWT_SECRET) — التنفيذ اليدوي متوقف.', 'NO_SIGNING_SECRET'); return 'manual-ops-dev-secret'; }; // fail closed in production
const sign = (p) => crypto.createHmac('sha256', secret()).update(JSON.stringify(p)).digest('hex').slice(0, 32);
async function requireAdmin(userId, deps) { const u = deps.user || await prisma.user.findUnique({ where: { id: Number(userId) }, select: { id: true, role: true, status: true } }); if (!u || u.role !== 'ADMIN' || u.status !== 'ACTIVE') throw fail(403, 'التشغيل اليدوي على Meta محتاج ADMIN.', 'ADMIN_REQUIRED'); return u; }

async function defaultReadEntity(entityId) {
  const [{ getEntity }, { getDecryptedToken }] = await Promise.all([import('../metaGraphClient.js'), import('../metaAuth.js')]);
  const e = await getEntity(await getDecryptedToken(), entityId, 'id,name,status,effective_status,daily_budget,lifetime_budget'); const d = Number(e.daily_budget);
  return { id: e.id, name: e.name || null, status: e.effective_status || e.status || null, budget: Number.isFinite(d) ? d / 100 : null, lifetime: e.lifetime_budget != null };
}
/** stock + AUTOMATIC flag of the campaign's product (cheap, read-only) */
async function defaultProductState(idn) {
  try { const [{ readinessList }, { getProductPolicy }] = await Promise.all([import('./operatorReadiness.js'), import('./productPolicy.js')]);
    const row = (await readinessList({})).find((r) => Number(r.productId) === Number(idn.productId)); const pol = await getProductPolicy({ productId: idn.productId, storeId: idn.storeId });
    return { stock: row?.stockKnown && Number(row.stock) <= 0 ? 'OUT_OF_STOCK' : row?.stockKnown ? 'IN_STOCK' : 'UNKNOWN', automatic: pol.active?.mode === 'AUTOMATIC' };
  } catch { return null; }
}
const nextState = (op, live) => ({ status: op === 'OPEN' ? 'ACTIVE' : op === 'PAUSE' ? 'PAUSED' : live.status, budget: live.budget ?? null });

/** READ-ONLY. Returns everything the owner must see before confirming + the exact `confirm` payload that execute() will require.
 *  Budget operations run on the LIVE structure (budgetChange.js): CBO → the campaign budget; ABO → the ONE ad set the owner picked (entityId), the others are shown as untouched.
 *  deps (tests): readEntity (open/pause), readCampaign/readAdsets (budget), config, identity, conflicts, capsDeps, recent, settings, now. */
export async function manualPreflight({ campaignId, entityId = null, level = null, operation, toBudget = null, pct = null, userId, now = new Date(), deps = {} }) {
  await requireAdmin(userId, deps);
  const op = MANUAL_OPS[operation]; if (!op) throw fail(400, 'العملية لازم تكون OPEN أو PAUSE أو INCREASE أو REDUCE.', 'BAD_OPERATION');
  if (!campaignId) throw fail(400, 'اختار الحملة.', 'NO_CAMPAIGN'); if (level != null && !['campaign', 'adset'].includes(level)) throw fail(400, 'level غير صالح.', 'BAD_LEVEL');
  const isBudget = ['INCREASE', 'REDUCE'].includes(operation);
  if (!isBudget && entityId && entityId !== campaignId) throw fail(400, 'الفتح والإيقاف على مستوى الحملة فقط.', 'CAMPAIGN_LEVEL_ONLY');
  const config = deps.config ? await (typeof deps.config === 'function' ? deps.config() : deps.config) : await getOperatorConfig();
  const blockers = []; const warnings = []; const ack = [];
  let live, want, structure = null, impact = null, validation = null, eid = entityId || campaignId, lvl = 'campaign', limits = null;
  if (isBudget) {
    let pv; try { pv = await previewBudgetChange({ campaignId, entityId, operation, toBudget, pct, now, deps: { ...deps, config } }); } catch (e) { throw fail(502, `ما قدرناش نقرأ الحالة الحية من Meta: ${String(e.message).slice(0, 160)} — مفيش تنفيذ على بيانات غير موثوقة.`, 'META_UNAVAILABLE'); }
    structure = pv.structure; validation = pv.validation; impact = pv.impact; limits = pv.limits; lvl = structure.entityLevel || 'campaign';
    if (level && structure.entityLevel && level !== structure.entityLevel) throw fail(409, `مستوى الميزانية الفعلي ${structure.entityLevel === 'campaign' ? 'الحملة (CBO)' : 'الـAd Set (ABO)'} مش ${level}.`, 'LEVEL_MISMATCH');
    eid = pv.entityId || campaignId; const ent = structure.entities.find((x) => x.id === eid);
    live = { id: eid, name: ent?.name || structure.campaign.name, status: ent?.status ?? structure.campaign.status, budget: validation.from ?? ent?.budget ?? null };
    want = { status: live.status, budget: validation.to ?? null };
    blockers.push(...validation.blockers); warnings.push(...validation.warnings); ack.push(...validation.ack);
  } else {
    try { live = await (deps.readEntity || defaultReadEntity)(eid); } catch (e) { throw fail(502, `ما قدرناش نقرأ الحالة الحية من Meta: ${String(e.message).slice(0, 160)} — مفيش تنفيذ على بيانات غير موثوقة.`, 'META_UNAVAILABLE'); }
    if (!live || live.id !== eid) throw fail(409, 'الكيان اللي رجع من Meta مش هو المطلوب.', 'ENTITY_MISMATCH');
    want = nextState(operation, live, {});
    if (operation === 'OPEN' && live.status !== 'PAUSED') blockers.push({ code: live.status === 'ACTIVE' ? 'ALREADY_ACTIVE' : `LIVE_STATUS_${live.status}`, message: live.status === 'ACTIVE' ? 'الحملة شغالة بالفعل على Meta.' : `حالة الحملة ${live.status} — مش قابلة للفتح.` });
    if (operation === 'PAUSE' && live.status !== 'ACTIVE') blockers.push({ code: live.status === 'PAUSED' ? 'ALREADY_PAUSED' : `LIVE_STATUS_${live.status}`, message: live.status === 'PAUSED' ? 'الحملة موقوفة بالفعل.' : `حالة الحملة ${live.status} — مش قابلة للإيقاف.` });
    // the money a status change moves: the campaign budget (CBO) or the ad sets that would deliver (ABO) — best effort, never blocks
    try { structure = await readBudgetStructure({ campaignId, deps }); } catch { structure = null; }
  }
  const gate = evaluateWriteGate({ config, actionType: op.amb, mode: 'HUMAN' }); const simulation = config.mode === 'SHADOW';
  const identity = deps.identity ? await deps.identity(campaignId) : await (await import('./integration.js')).campaignIdentity(campaignId).catch(() => null);
  if (!identity || !identity.productId) { warnings.push({ code: 'UNMAPPED_CAMPAIGN', message: 'الحملة غير مربوطة بمنتج مؤكد.' }); ack.push('UNMAPPED_CAMPAIGN'); }
  else if (identity.verified === false) { warnings.push({ code: 'MAPPING_NOT_VERIFIED', message: 'ربط الحملة بالمنتج غير مؤكد.' }); ack.push('MAPPING_NOT_VERIFIED'); }
  if (identity?.productId != null) { const ps = await (deps.productState || defaultProductState)(identity); if (ps?.stock === 'OUT_OF_STOCK' && ['OPEN', 'INCREASE'].includes(operation)) { warnings.push({ code: 'STOCK_OUT', message: 'المخزون خلص — فتح/زيادة ميزانية هيصرف على منتج مش متاح.' }); ack.push('STOCK_OUT'); } if (ps?.automatic) { warnings.push({ code: 'PRODUCT_IS_AUTOMATIC', message: 'المنتج في وضع AUTOMATIC — ممكن المحرك يغيّر الحملة بعدك.' }); ack.push('PRODUCT_IS_AUTOMATIC'); } }
  const conflicts = await (deps.conflicts ? deps.conflicts({ campaignId, want: op.action }) : (await import('./integration.js')).checkConflicts({ campaignId, want: op.action, now }).catch(() => []));
  for (const c of conflicts) blockers.push({ code: c.code, message: `تعارض: ${c.detail || c.code}` });
  const statusBudget = structure ? (structure.level === 'CBO' ? structure.totals.campaignBudget : structure.level === 'ABO' ? structure.totals.adsetsDelivering || structure.totals.adsetsAll : null) : null;
  const exposureDelta = isBudget ? (validation?.delta ?? null) : operation === 'OPEN' ? (statusBudget ?? null) : (statusBudget != null ? -statusBudget : null);
  const exp = now.getTime() + TOKEN_TTL_MS;
  const body = { campaignId, entityId: eid, level: lvl, operation, fromStatus: live.status, fromBudget: live.budget ?? null, toStatus: want.status, toBudget: want.budget ?? null };
  const token = `${exp}.${sign({ ...body, exp })}`;
  const execBlocked = blockers.length ? blockers[0] : (!gate.ok && !simulation ? { code: gate.code, message: gate.message } : null);
  return { ok: true, operation, label: op.label, mode: config.mode === 'OFF' ? 'MANUAL' : config.mode, simulation, campaignId, entityId: eid, level: lvl, name: live.name, entityName: live.name, campaignName: structure?.campaign?.name || null, identity: identity ? { productId: identity.productId ?? null, productName: identity.productName ?? null, storeId: identity.storeId ?? null, mappingVerified: identity.verified ?? null } : null,
    current: { status: live.status, budget: live.budget ?? null }, proposed: { status: want.status, budget: want.budget ?? null }, exposureDelta, blockers, warnings, requiresAck: [...new Set(ack)], gate: gate.ok ? { ok: true } : { ok: false, code: gate.code, message: gate.message, reasons: gate.reasons },
    structure: structure && { level: structure.level, campaign: structure.campaign, entities: structure.entities, adsets: structure.adsets, totals: structure.totals, issues: structure.issues }, impact, limits, change: validation && { from: validation.from, to: validation.to, delta: validation.delta, deltaPct: validation.deltaPct },
    canExecute: !execBlocked, executeBlockedBy: execBlocked, expiresAt: new Date(exp).toISOString(), confirm: { ...body, token, ack: [] }, expectedMetaChange: operation === 'PAUSE' ? 'status: ACTIVE → PAUSED' : operation === 'OPEN' ? 'status: PAUSED → ACTIVE' : `daily_budget (${lvl === 'adset' ? 'Ad Set' : 'Campaign'} ${eid}): ${live.budget} → ${want.budget}`, note: simulation ? 'الوضع SHADOW: التنفيذ محاكاة فقط ومفيش كتابة على Meta.' : 'لا يتم أي تنفيذ قبل ما تأكد وتضغط تنفيذ.' };
}

/** READ-ONLY structure for the picker: CBO budget or every ad set (id · name · status · live budget · eligibility). */
export async function manualStructure({ campaignId, userId, deps = {} }) {
  await requireAdmin(userId, deps);
  try { const s = await readBudgetStructure({ campaignId, deps }); const config = deps.config ? (typeof deps.config === 'function' ? await deps.config() : deps.config) : await getOperatorConfig(); const { getAmbSettings } = await import('./settings.js'); return { ...s, limits: budgetLimits({ settings: deps.settings || await getAmbSettings(), config }) }; }
  catch (e) { throw fail(502, `ما قدرناش نقرأ الحالة الحية من Meta: ${String(e.message).slice(0, 160)}`, 'META_UNAVAILABLE'); }
}

/** Executes exactly what the preflight showed. confirm = the `confirm` object of the preflight (+ ack[] naming every warning code that required acknowledgement). */
export async function manualExecute({ campaignId, entityId = null, level: levelIn = null, operation, toBudget = null, pct = null, confirm, userId, now = new Date(), deps = {} }) {
  await requireAdmin(userId, deps);
  const op = MANUAL_OPS[operation]; if (!op) throw fail(400, 'العملية غير معروفة.', 'BAD_OPERATION');
  if (!confirm || !confirm.token) throw fail(400, 'التنفيذ اليدوي محتاج تأكيد صريح لنفس التغيير اللي ظهر في المعاينة.', 'CONFIRM_REQUIRED');
  const [expS, sig] = String(confirm.token).split('.'); const exp = Number(expS);
  const claimed = { campaignId: confirm.campaignId, entityId: confirm.entityId, level: confirm.level, operation: confirm.operation, fromStatus: confirm.fromStatus, fromBudget: confirm.fromBudget, toStatus: confirm.toStatus, toBudget: confirm.toBudget };
  if (!Number.isFinite(exp) || sig !== sign({ ...claimed, exp })) throw fail(400, 'التأكيد غير صالح (اتعدّل أو مش من المعاينة).', 'CONFIRM_INVALID');
  if (now.getTime() > exp) throw fail(409, 'المعاينة انتهت صلاحيتها — اعمل معاينة جديدة وأكد تاني.', 'CONFIRM_EXPIRED');
  const eid = entityId || campaignId; const level = levelIn ?? confirm.level;
  if (confirm.campaignId !== campaignId || confirm.entityId !== eid || confirm.operation !== operation || confirm.level !== level) throw fail(409, 'التأكيد لحملة/عملية مختلفة عن المطلوبة.', 'CONFIRM_MISMATCH');
  const key = crypto.createHash('sha1').update(`manual|${confirm.token}`).digest('hex').slice(0, 24);
  const existing = await prisma.ambOperatorDecision.findUnique({ where: { decision_key: key } });
  if (existing) return { ok: existing.status === 'VERIFIED', duplicate: true, status: existing.status, decisionId: existing.id, message: 'التأكيد ده اتنفذ قبل كده — مفيش تنفيذ تاني (idempotent).' };
  // the live state must still be EXACTLY what the owner confirmed
  const pre = await manualPreflight({ campaignId, entityId: eid, level, operation, toBudget: confirm.toBudget, pct: null, userId, now, deps });
  if (pre.current.status !== confirm.fromStatus || (pre.current.budget ?? null) !== (confirm.fromBudget ?? null)) throw fail(409, `الحالة على Meta اتغيّرت من وقت المعاينة (دلوقتي ${pre.current.status}/${pre.current.budget ?? '—'} مش ${confirm.fromStatus}/${confirm.fromBudget ?? '—'}) — اعمل معاينة جديدة.`, 'STATE_CHANGED', { current: pre.current });
  const missing = pre.requiresAck.filter((c) => !(confirm.ack || []).includes(c)); if (missing.length) throw fail(409, `لازم تؤكد صراحة التحذيرات: ${missing.join('، ')}`, 'ACK_REQUIRED', { requiresAck: missing });
  if (pre.blockers.length) throw fail(409, pre.blockers[0].message, pre.blockers[0].code, { blockers: pre.blockers });
  const config = deps.config ? await (typeof deps.config === 'function' ? deps.config() : deps.config) : await getOperatorConfig();
  const simulation = config.mode === 'SHADOW';
  if (!simulation && !pre.gate.ok) throw fail(423, pre.gate.message, pre.gate.code, { reasons: pre.gate.reasons });
  const adAccountId = (await (await import('../metaAuth.js')).getConnection())?.selected_ad_account_id || 'UNKNOWN';
  const params = { kind: `MANUAL_${operation}`, level, entityId: eid, entityName: pre.entityName || null, pct: pct ?? null, fromBudget: confirm.fromBudget ?? null, toBudget: confirm.toBudget ?? null, window: 'manual' };
  const row = await prisma.ambOperatorDecision.create({ data: { decision_key: key, status: simulation ? 'SHADOW' : 'PREPARED', store_id: pre.identity?.storeId || 'UNKNOWN', product_id: pre.identity?.productId ?? null, ad_account_id: adAccountId, campaign_id: campaignId, campaign_name: pre.campaignName || pre.name || campaignId, action: op.action, rule_id: null, rule_name: `AUTO:MANUAL_${operation}`, mode_at_decision: config.mode, confidence: 'HIGH',
    blocked_codes_json: JSON.stringify(pre.warnings), evidence_json: JSON.stringify({ manual: true, preflight: { current: pre.current, proposed: pre.proposed, exposureDelta: pre.exposureDelta, warnings: pre.warnings }, ack: confirm.ack || [], history: { beforeBudget: confirm.fromBudget ?? null, afterBudget: confirm.toBudget ?? null, level, entityId: eid, kind: params.kind, timestamp: now.toISOString() } }),
    why_json: JSON.stringify({ what: `${op.label} (يدوي) — ${pre.name || campaignId}`, why: `تنفيذ يدوي بتأكيد صريح من الـADMIN #${userId}.` }), params_json: JSON.stringify(params), before_json: JSON.stringify({ status: confirm.fromStatus, budget: confirm.fromBudget ?? null, level }) } });
  await prisma.ambOperatorEvent.create({ data: { decision_id: row.id, kind: 'TRANSITION', from_status: 'CANDIDATE', to_status: row.status, actor: 'USER', actor_id: Number(userId), note: simulation ? 'MANUAL_SIMULATED' : 'MANUAL_CONFIRMED', campaign_id: campaignId } }).catch(() => {});
  if (simulation) return { ok: true, simulated: true, executed: false, status: 'SHADOW', decisionId: row.id, message: 'SHADOW: اتسجّل كمحاكاة — مفيش أي كتابة على Meta.' };
  const out = { ok: false, executed: false, verified: false, decisionId: row.id, stages: { requested: null, sentToMeta: null, readBack: null, verified: null } };
  const r = await performWrite({ row, params, ambAction: op.amb, actor: 'USER', source: 'USER', userId: Number(userId), config, deps: { ...(deps.exec || {}), config }, out });
  return { ...r, manual: true };
}
