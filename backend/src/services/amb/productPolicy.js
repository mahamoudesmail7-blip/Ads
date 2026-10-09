// 🧩 Product Policies — a separate, optional operating policy per product (and per-campaign overrides inside it) that sits ON TOP of the global budget policy and the global guards.
//   Save ≠ Activate: «حفظ» stores a DRAFT; only ADMIN + confirm activates it (AUTOMATIC additionally needs an explicit second confirmation). A policy can tighten or tune the global one
//   within hard bounds, but it can never loosen the global guards, the Emergency Stop, the deployment write lock or the execution permissions.
// Storage: operator config limits_json.productPolicies[`${storeId}:${productId}`] — no schema change. Activation also mirrors the mode / Hard Stop CPA / max scale % into the existing
// AmbOperatorProductConfig (which the guards already read), so those three are enforced by the existing guard chain.
import { prisma } from '../../prisma.js';
import { getOperatorConfig } from './operatorStore.js';

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const MODE_MAP = { MANUAL: 'OFF', APPROVAL: 'APPROVAL', AUTOMATIC: 'AUTOPILOT' }; // policy mode → the existing AmbOperatorProductConfig.automation_mode
export const policyKey = (storeId, productId) => `${storeId || 'default'}:${productId}`;

/** Only known fields survive; everything else is dropped (the policy is a closed schema). null = inherit the global value. */
export function normalizePolicy(raw = {}) {
  const r = raw || {}; const o = {}; const pick = (src, keys) => Object.fromEntries(keys.map((k) => [k, src?.[k] === undefined || src?.[k] === '' ? null : src[k]]));
  o.mode = ['MANUAL', 'APPROVAL', 'AUTOMATIC'].includes(r.mode) ? r.mode : null;
  o.schedule = { ...pick(r.schedule, ['openTime', 'closeTime']), days: Array.isArray(r.schedule?.days) ? [...new Set(r.schedule.days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : null };
  if (o.schedule.days && !o.schedule.days.length) o.schedule.days = null;
  o.cpa = pick(r.cpa, ['normalMin', 'normalMax', 'scale', 'reduce', 'hardStop']);
  o.zeroOrder = pick(r.zeroOrder, ['spend', 'minAgeHours', 'windowDays']);
  o.budget = pick(r.budget, ['increasePct', 'decreasePct', 'minPurchases', 'cooldownHours', 'minBudget', 'maxBudget', 'dailySpendCap']);
  o.manualOverrideHours = num(r.manualOverrideHours);
  o.stockPolicy = ['WARN', 'BLOCK'].includes(r.stockPolicy) ? r.stockPolicy : null;
  for (const grp of ['cpa', 'zeroOrder', 'budget']) for (const k of Object.keys(o[grp])) { const n = num(o[grp][k]); o[grp][k] = n === null ? null : n; }
  o.campaigns = {};
  for (const [cid, c] of Object.entries(r.campaigns || {})) { if (!cid) continue; const n = normalizePolicy({ ...c, campaigns: undefined }); delete n.campaigns; if (JSON.stringify(n) !== JSON.stringify(emptyOverride())) o.campaigns[String(cid)] = n; }
  return o;
}
const emptyOverride = () => { const e = normalizePolicy({}); delete e.campaigns; return e; };

/** Hard bounds (the "global guards cannot be overridden" layer) + ordering rules. Returns Arabic error strings. */
export function validatePolicy(p, { scopeLabel = '' } = {}) {
  const errors = []; const L = (m) => `${scopeLabel}${m}`;
  const rng = (path, v, min, max) => { if (v === null) return; if (Number.isNaN(v) || v < min || v > max) errors.push(L(`${path}: لازم يكون بين ${min} و${max}.`)); };
  const { schedule, cpa, zeroOrder: z, budget: b } = p;
  for (const k of ['openTime', 'closeTime']) if (schedule[k] != null && !HHMM.test(String(schedule[k]))) errors.push(L(`${k === 'openTime' ? 'وقت الفتح' : 'وقت الإيقاف'}: صيغة HH:MM مطلوبة.`));
  for (const [k, v] of Object.entries(cpa)) rng(`CPA (${k})`, v, 1, 100000);
  if (cpa.normalMin != null && cpa.normalMax != null && cpa.normalMin > cpa.normalMax) errors.push(L('الحد الأدنى للـCPA الطبيعي لازم يكون ≤ الأقصى.'));
  if (cpa.scale != null && cpa.reduce != null && cpa.scale >= cpa.reduce) errors.push(L('حد الـScale لازم يكون أقل من حد الـReduce.'));
  if (cpa.reduce != null && cpa.hardStop != null && cpa.reduce > cpa.hardStop) errors.push(L('حد الـReduce لازم يكون ≤ Hard Stop CPA.'));
  if (cpa.normalMax != null && cpa.hardStop != null && cpa.normalMax > cpa.hardStop) errors.push(L('نهاية الـCPA الطبيعي لازم تكون ≤ Hard Stop.'));
  rng('الصرف بدون أوردرات', z.spend, 50, 100000); rng('أقل عمر للحملة (ساعات)', z.minAgeHours, 0, 720);
  if (z.windowDays != null && ![3, 7].includes(z.windowDays)) errors.push(L('نافذة القياس لازم 3 أو 7 أيام.'));
  rng('نسبة الزيادة %', b.increasePct, 1, 50); rng('نسبة التقليل %', b.decreasePct, 1, 50); rng('أقل عدد أوردرات', b.minPurchases, 1, 100); rng('Cooldown (ساعات)', b.cooldownHours, 6, 336);
  rng('أقل ميزانية', b.minBudget, 1, 1e7); rng('أقصى ميزانية', b.maxBudget, 1, 1e7); rng('الحد اليومي لميزانية المنتج (Daily Spend Cap)', b.dailySpendCap, 1, 1e7); rng('حماية التعديل اليدوي (ساعات)', p.manualOverrideHours, 1, 720);
  if (b.dailySpendCap != null && b.maxBudget != null && b.maxBudget > b.dailySpendCap) errors.push(L('أقصى ميزانية للحملة لا يمكن أن تتجاوز الحد اليومي للمنتج.'));
  if (b.minBudget != null && b.maxBudget != null && b.minBudget > b.maxBudget) errors.push(L('أقل ميزانية لازم تكون ≤ أقصى ميزانية.'));
  for (const [cid, c] of Object.entries(p.campaigns || {})) errors.push(...validatePolicy({ ...c, campaigns: {} }, { scopeLabel: `حملة ${cid}: ` }));
  return errors;
}

/** Layer: global budget policy ← product policy ← campaign override. Returns a budget policy object the optimizer understands + the extras (bounds, stock, mode). */
export function applyToBudgetPolicy(globalPolicy, policy, campaignId = null) {
  const eff = mergeEffective(policy, campaignId);
  const out = JSON.parse(JSON.stringify(globalPolicy));
  const set = (obj, k, v) => { if (v != null) obj[k] = v; };
  set(out.scale, 'pct', eff.budget.increasePct); set(out.scale, 'maxCpa', eff.cpa.scale); set(out.scale, 'minPurchases', eff.budget.minPurchases); set(out.scale, 'cooldownHours', eff.budget.cooldownHours);
  set(out.reduce, 'pct', eff.budget.decreasePct); set(out.reduce, 'minCpa', eff.cpa.reduce); set(out.reduce, 'minPurchases', eff.budget.minPurchases); set(out.reduce, 'cooldownHours', eff.budget.cooldownHours);
  if (eff.cpa.normalMin != null) out.keep.minCpa = eff.cpa.normalMin; if (eff.cpa.normalMax != null) out.keep.maxCpa = eff.cpa.normalMax;
  set(out.zeroOrders, 'spend', eff.zeroOrder.spend); set(out.zeroOrders, 'minAgeHours', eff.zeroOrder.minAgeHours);
  if (eff.zeroOrder.windowDays) out.window = eff.zeroOrder.windowDays === 7 ? 'last7' : 'last3';
  // keep the zones coherent after the override (the global validator's ordering rule)
  if (out.scale.maxCpa >= out.reduce.minCpa) out.scale.maxCpa = Math.max(1, out.reduce.minCpa - 1);
  if (out.reduce.maxCpa < out.reduce.minCpa) out.reduce.maxCpa = out.reduce.minCpa;
  if (out.highCpa.above < out.reduce.maxCpa) out.highCpa.above = out.reduce.maxCpa;
  return { policy: out, bounds: { minBudget: eff.budget.minBudget, maxBudget: eff.budget.maxBudget }, dailyCap: eff.budget.dailySpendCap, manualOverrideHours: eff.manualOverrideHours, stockPolicy: eff.stockPolicy, mode: eff.mode, zeroSpend: eff.zeroOrder.spend };
}
/** campaign override wins over the product value (null in the override = inherit the product value) */
export function mergeEffective(policy, campaignId = null) {
  const base = policy ? normalizePolicy(policy) : emptyOverride(); const ov = campaignId && policy?.campaigns?.[campaignId] ? normalizePolicy({ ...policy.campaigns[campaignId], campaigns: undefined }) : null;
  if (!ov) return base;
  const m = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, b[k] ?? a[k]]));
  return { mode: ov.mode ?? base.mode, manualOverrideHours: ov.manualOverrideHours ?? base.manualOverrideHours, schedule: { openTime: ov.schedule.openTime ?? base.schedule.openTime, closeTime: ov.schedule.closeTime ?? base.schedule.closeTime, days: ov.schedule.days ?? base.schedule.days },
    cpa: m(base.cpa, ov.cpa), zeroOrder: m(base.zeroOrder, ov.zeroOrder), budget: m(base.budget, ov.budget), stockPolicy: ov.stockPolicy ?? base.stockPolicy, campaigns: {} };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function readAll() { const row = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const raw = j(row?.limits_json, null) || {}; return { row, raw, all: raw.productPolicies || {} }; }
async function writeAll(raw, all, userId) { await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify({ ...raw, productPolicies: all }), updated_by_id: userId ?? null } }); }
const audit = (userId, kind, input) => prisma.aiAuditLog.create({ data: { actor_id: userId ?? null, kind, action: 'EXECUTE', input_json: JSON.stringify(input).slice(0, 3500), success: true } }).catch(() => {});
const event = (userId, kind, note, data = {}) => prisma.ambOperatorEvent.create({ data: { kind, actor: 'USER', actor_id: userId ?? null, note, data_json: JSON.stringify(data).slice(0, 3500) } }).catch(() => {});
async function requireAdmin(userId, deps = {}) { const u = deps.user || await prisma.user.findUnique({ where: { id: Number(userId) }, select: { id: true, role: true, status: true } }); if (!u || u.role !== 'ADMIN' || u.status !== 'ACTIVE') { const e = new Error('ده محتاج ADMIN.'); e.status = 403; throw e; } return u; }
const fail = (status, message, code) => { const e = new Error(message); e.status = status; if (code) e.code = code; return e; };

export async function getProductPolicy({ productId, storeId }) {
  const { all } = await readAll(); const e = all[policyKey(storeId, productId)] || null;
  return { key: policyKey(storeId, productId), productId: Number(productId), storeId: storeId || 'default', active: e?.active || null, draft: e?.draft || null, status: e?.active ? (e.draft ? 'ACTIVE_WITH_DRAFT' : 'ACTIVE') : e?.draft ? 'DRAFT' : 'NONE', savedAt: e?.savedAt || null, activatedAt: e?.activatedAt || null, activatedById: e?.activatedById || null, version: e?.version || 0 };
}

/** DRAFT only — never changes behaviour. */
export async function saveDraft({ productId, storeId, policy, userId, deps = {} }) {
  await requireAdmin(userId, deps);
  const norm = normalizePolicy(policy); const errors = validatePolicy(norm); if (errors.length) { const e = fail(400, errors.join(' '), 'INVALID_POLICY'); e.details = errors; throw e; }
  const { raw, all } = await readAll(); const k = policyKey(storeId, productId); const cur = all[k] || {};
  all[k] = { ...cur, draft: norm, savedAt: new Date().toISOString(), savedById: Number(userId), version: (cur.version || 0) + 1 };
  await writeAll(raw, all, userId); await audit(userId, 'OPERATOR_PRODUCT_POLICY_DRAFT', { key: k, draft: norm }); await event(userId, 'PRODUCT_POLICY_SAVED', `حفظ مسودة سياسة المنتج ${k} (لم تُفعَّل)`, { key: k });
  return getProductPolicy({ productId, storeId });
}

/** ADMIN + confirm. AUTOMATIC mode needs `confirmAutomatic` too. Mirrors mode / hard stop / max scale into AmbOperatorProductConfig (existing guard inputs). */
export async function activatePolicy({ productId, storeId, confirm, confirmAutomatic = false, userId, deps = {} }) {
  await requireAdmin(userId, deps);
  if (confirm !== true) throw fail(400, 'تفعيل السياسة محتاج تأكيد صريح (confirm).', 'CONFIRM_REQUIRED');
  const { raw, all } = await readAll(); const k = policyKey(storeId, productId); const cur = all[k];
  if (!cur?.draft) throw fail(409, 'مفيش مسودة للتفعيل — احفظ المسودة الأول.', 'NO_DRAFT');
  const anyAuto = cur.draft.mode === 'AUTOMATIC' || Object.values(cur.draft.campaigns || {}).some((c) => c.mode === 'AUTOMATIC');
  if (anyAuto && confirmAutomatic !== true) throw fail(400, 'تفعيل AUTOMATIC على منتج/حملة محتاج تأكيد ADMIN إضافي واضح (confirmAutomatic).', 'CONFIRM_AUTOMATIC_REQUIRED');
  const errors = validatePolicy(cur.draft); if (errors.length) throw fail(400, errors.join(' '), 'INVALID_POLICY');
  all[k] = { ...cur, active: cur.draft, draft: null, activatedAt: new Date().toISOString(), activatedById: Number(userId), version: (cur.version || 0) + 1 };
  await writeAll(raw, all, userId);
  const backup = await syncProductConfig({ productId, storeId, policy: all[k].active, userId }); all[k].mirrorBackup = cur.active ? (cur.mirrorBackup || backup) : backup; await writeAll(raw, all, userId);
  await audit(userId, 'OPERATOR_PRODUCT_POLICY_ACTIVATE', { key: k, mode: all[k].active.mode, automatic: anyAuto }); await event(userId, 'PRODUCT_POLICY_ACTIVATED', `تفعيل سياسة المنتج ${k}${anyAuto ? ' (AUTOMATIC)' : ''}`, { key: k, mode: all[k].active.mode });
  const reconcile = deps.noReconcile ? null : await import('./integration.js').then((m) => m.onProductPolicyChanged({ productId, storeId, kind: 'ACTIVATED', userId, deps: deps.integration || {} })).catch(() => null); // pending plans / decisions of this product are re-evaluated — nothing executes
  return { ...(await getProductPolicy({ productId, storeId })), reconcile };
}
export async function deactivatePolicy({ productId, storeId, confirm, userId, deps = {} }) {
  await requireAdmin(userId, deps); if (confirm !== true) throw fail(400, 'محتاج تأكيد صريح (confirm).', 'CONFIRM_REQUIRED');
  const { raw, all } = await readAll(); const k = policyKey(storeId, productId); const cur = all[k]; if (!cur?.active) throw fail(409, 'مفيش سياسة مفعّلة.', 'NOT_ACTIVE');
  all[k] = { ...cur, draft: cur.draft || cur.active, active: null, version: (cur.version || 0) + 1 }; await writeAll(raw, all, userId);
  await syncProductConfig({ productId, storeId, policy: null, userId, backup: cur.mirrorBackup || null });
  await audit(userId, 'OPERATOR_PRODUCT_POLICY_DEACTIVATE', { key: k }); await event(userId, 'PRODUCT_POLICY_DEACTIVATED', `إيقاف سياسة المنتج ${k} (رجعت للإعدادات العامة)`, { key: k });
  const reconcile = deps.noReconcile ? null : await import('./integration.js').then((m) => m.onProductPolicyChanged({ productId, storeId, kind: 'DEACTIVATED', userId, deps: deps.integration || {} })).catch(() => null);
  return { ...(await getProductPolicy({ productId, storeId })), reconcile };
}
/** Mirrors the three guard-enforced fields into AmbOperatorProductConfig. On activation the previous values are remembered (returned as `backup`) and restored on deactivation. */
async function syncProductConfig({ productId, storeId, policy, userId, backup = null }) {
  const sid = storeId || 'default'; const where = { product_id_store_id: { product_id: Number(productId), store_id: sid } };
  const exists = await prisma.ambOperatorProductConfig.findUnique({ where });
  const before = { automation_mode: exists?.automation_mode ?? null, hard_stop_cpa: exists?.hard_stop_cpa ?? null, max_scale_pct: exists?.max_scale_pct ?? null };
  const next = policy
    ? { automation_mode: policy.mode ? MODE_MAP[policy.mode] : before.automation_mode, hard_stop_cpa: policy.cpa.hardStop ?? before.hard_stop_cpa, max_scale_pct: policy.budget.increasePct ?? before.max_scale_pct }
    : (backup || { automation_mode: null, hard_stop_cpa: null, max_scale_pct: null });
  if (exists) await prisma.ambOperatorProductConfig.update({ where, data: { ...next, updated_by_id: userId ?? null } });
  else if (policy) await prisma.ambOperatorProductConfig.create({ data: { product_id: Number(productId), store_id: sid, ...next, updated_by_id: userId ?? null } });
  return before;
}
/** copy the source's ACTIVE (else draft) policy into target products as DRAFTS (never activates anything) */
export async function copyPolicy({ from, to, userId, deps = {} }) {
  await requireAdmin(userId, deps); const { raw, all } = await readAll(); const src = all[policyKey(from.storeId, from.productId)]; const pol = src?.active || src?.draft; if (!pol) throw fail(404, 'المنتج المصدر ملوش سياسة.', 'NO_SOURCE');
  const clone = normalizePolicy({ ...pol, campaigns: {} }); const out = [];
  for (const t of to) { if (policyKey(t.storeId, t.productId) === policyKey(from.storeId, from.productId)) continue; const k = policyKey(t.storeId, t.productId); const cur = all[k] || {}; all[k] = { ...cur, draft: clone, savedAt: new Date().toISOString(), savedById: Number(userId), version: (cur.version || 0) + 1 }; out.push(k); }
  await writeAll(raw, all, userId); await audit(userId, 'OPERATOR_PRODUCT_POLICY_COPY', { from: policyKey(from.storeId, from.productId), to: out }); await event(userId, 'PRODUCT_POLICY_SAVED', `نسخ سياسة ${policyKey(from.storeId, from.productId)} كمسودات إلى ${out.length} منتج`, { to: out });
  return { copied: out };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// engine-facing readers (cheap: one config read)
// ---------------------------------------------------------------------------------------------------------------------------------------------
/** Map `${storeId}:${productId}` → ACTIVE policy */
export async function loadActivePolicies() { const { all } = await readAll(); const m = new Map(); for (const [k, e] of Object.entries(all)) if (e?.active) m.set(k, e.active); return m; }
/** ACTIVE policy of a product from the operator config's limits object (what the engine already holds), or null */
export const activePolicyFromLimits = (limits, storeId, productId) => (productId == null ? null : limits?.productPolicies?.[policyKey(storeId, productId)]?.active || null);
/** hours the owner's MANUAL change protects a campaign: never below the GLOBAL cooldown — a product policy can only extend it */
export const effectiveManualOverrideHours = (limits, storeId, productId, campaignId = null) => { const g = Number(limits?.manualOverrideCooldownHours ?? 24); const p = activePolicyFromLimits(limits, storeId, productId); const h = p ? mergeEffective(p, campaignId).manualOverrideHours : null; return Math.max(g, Number(h) || 0); };
/** the product's daily budget cap override (null = use the global product cap) */
export const dailyCapFromLimits = (limits, storeId, productId, campaignId = null) => { const p = activePolicyFromLimits(limits, storeId, productId); return p ? mergeEffective(p, campaignId).budget.dailySpendCap ?? null : null; };
/** is the product's schedule allowing automation today (Cairo weekday)? days: 0=Sunday … 6=Saturday. */
export const dayAllowed = (policy, cairoWeekday, campaignId = null) => { const d = mergeEffective(policy, campaignId).schedule.days; return !d || d.includes(cairoWeekday); };
export const weekdayOfCairoDate = (dateStr) => new Date(`${dateStr}T12:00:00Z`).getUTCDay();

// ---------------------------------------------------------------------------------------------------------------------------------------------
// listing (products that have campaigns) + preview
// ---------------------------------------------------------------------------------------------------------------------------------------------
const ymd = (d) => d.toISOString().slice(0, 10);
export async function listProductRules({ now = new Date() } = {}) {
  const since30 = ymd(new Date(now.getTime() - 30 * 86400000)), since7 = ymd(new Date(now.getTime() - 7 * 86400000));
  const maps = await prisma.$queryRawUnsafe(`select p.id as product_id, p.product_name, p.store_id, m.campaign_id, m.campaign_name from amb_product_campaign_map m join amb_products ap on ap.id = m.amb_product_id join products p on p.id = ap.product_id where m.status = 'MAPPED'
    union select p.id, p.product_name, p.store_id, lc.meta_campaign_id, lc.name from amb_launch_campaigns lc join amb_launch_jobs lj on lj.job_id = lc.job_id join products p on p.id = lj.product_id where lc.meta_campaign_id is not null`);
  const ids = [...new Set(maps.map((r) => r.campaign_id))];
  const met = ids.length ? await prisma.$queryRawUnsafe(`with latest as (select distinct on (campaign_id, date_start) campaign_id, date_start, spend, meta_purchases, campaign_status from meta_performance_snapshots where level = 'campaign' and date_start >= $1 and campaign_id = any($2::text[]) order by campaign_id, date_start, snapshot_at desc)
    select campaign_id, (array_agg(campaign_status order by date_start desc))[1] as status, sum(spend) filter (where date_start >= $3) as s7, sum(meta_purchases) filter (where date_start >= $3) as p7, sum(spend) as s30, sum(meta_purchases) as p30 from latest group by campaign_id`, since30, ids, since7) : [];
  const metBy = new Map(met.map((r) => [r.campaign_id, r])); const { all } = await readAll(); const byProduct = new Map();
  for (const r of maps) { const k = policyKey(r.store_id, r.product_id); const e = byProduct.get(k) || { key: k, productId: r.product_id, storeId: r.store_id || 'default', name: r.product_name, campaigns: new Map() }; e.campaigns.set(r.campaign_id, { id: r.campaign_id, name: r.campaign_name }); byProduct.set(k, e); }
  return [...byProduct.values()].map((e) => {
    const cs = [...e.campaigns.values()].map((c) => { const m = metBy.get(c.id); return { ...c, status: m?.status || null, spend7: Number(m?.s7 || 0), purchases7: Number(m?.p7 || 0), spend30: Number(m?.s30 || 0), purchases30: Number(m?.p30 || 0) }; });
    const sum = (f) => cs.reduce((t, c) => t + f(c), 0); const s7 = sum((c) => c.spend7), p7 = sum((c) => c.purchases7), s30 = sum((c) => c.spend30), p30 = sum((c) => c.purchases30); const pol = all[e.key];
    return { key: e.key, productId: e.productId, storeId: e.storeId, name: e.name, campaigns: cs, campaignCount: cs.length, activeCampaigns: cs.filter((c) => c.status === 'ACTIVE').length, purchases7: p7, cpa7: p7 ? Math.round(s7 / p7) : null, purchases30: p30, cpa30: p30 ? Math.round(s30 / p30) : null,
      status: pol?.active ? (pol.draft ? 'ACTIVE_WITH_DRAFT' : 'ACTIVE') : pol?.draft ? 'DRAFT' : 'NONE', mode: pol?.active?.mode || pol?.draft?.mode || null, activatedAt: pol?.activatedAt || null };
  }).sort((a, b) => b.purchases7 - a.purchases7 || (a.cpa7 ?? 1e9) - (b.cpa7 ?? 1e9));
}

/** Read-only: what the policy would conclude for each campaign of the product from the metrics we already hold. Writes nothing, calls nothing. */
export function previewPolicy({ policy, campaigns, globalPolicy }) {
  const norm = normalizePolicy(policy); const errors = validatePolicy(norm); if (errors.length) return { ok: false, errors };
  const rows = campaigns.map((c) => {
    const { policy: bp, bounds, zeroSpend } = applyToBudgetPolicy(globalPolicy, norm, c.id); const cpa = c.purchases7 ? c.spend7 / c.purchases7 : null; const p = c.purchases7 || 0; let verdict = 'KEEP', why = 'داخل المنطقة الطبيعية';
    if (!p && c.spend7 >= bp.zeroOrders.spend) { verdict = 'ZERO_ORDER_STOP'; why = `صرف ${Math.round(c.spend7)} بدون أوردرات (الحد ${bp.zeroOrders.spend})`; }
    else if (cpa != null && cpa <= bp.scale.maxCpa && p >= bp.scale.minPurchases && c.spend7 >= bp.scale.minSpend) { verdict = 'WOULD_INCREASE'; why = `CPA ${Math.round(cpa)} ≤ ${bp.scale.maxCpa} بـ ${p} أوردر → +${bp.scale.pct}%`; }
    else if (cpa != null && cpa >= bp.reduce.minCpa && p >= bp.reduce.minPurchases && c.spend7 >= bp.reduce.minSpend) { verdict = 'WOULD_REDUCE'; why = `CPA ${Math.round(cpa)} ≥ ${bp.reduce.minCpa} بـ ${p} أوردر → −${bp.reduce.pct}%`; }
    return { campaignId: c.id, name: c.name, status: c.status, purchases7: p, cpa7: cpa == null ? null : Math.round(cpa), verdict, why, bounds, note: 'معاينة من بيانات آخر 7 أيام المتزامنة — بدون حواجز الأمان الحية (دي بتتفحص وقت التنفيذ)' };
  });
  return { ok: true, rows, effective: norm };
}
