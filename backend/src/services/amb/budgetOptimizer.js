// 💰 Dynamic Budget Optimizer — per-campaign / per-ad-set budget decisions from LIVE performance, in SHADOW. 2026-10-06.
//
//   Meta budget structure (CBO campaign budget | ABO ad-set budgets) -> evidence (default window | SINCE the last change) -> policy -> guard chain -> decision
//
// POLICY (owner-approved numbers, all configurable, `enabled` is OFF by default and nothing here writes to Meta):
//   ZERO ORDERS   spend >= 200 AND purchases = 0                                    -> PAUSE   (after min campaign age / attribution grace / recent purchase / sample guards)
//   SCALE UP      purchases >= 2 AND spend >= 150 AND CPA <= 80 AND campaign age >= 48h -> budget +20%  (cooldown 24h)
//   KEEP          CPA 81..149 (and any case without a reliable sample)               -> no change
//   REDUCE        purchases >= 3 AND spend >= 450 AND CPA 150..200 AND 7d CPA >= 150 -> budget -20%  (cooldown 48h)
//   HIGH_CPA      CPA > 200 WITH purchases (same sample gate)                        -> budget -20% FIRST, then re-evaluated on NEW evidence after the cooldown.
//                 No direct pause at CPA > 300 (a separate preview is needed before that is ever adopted).
//   NEW EVIDENCE  after ANY budget change: no new change before the cooldown AND before enough NEW data (spend since the change) exists; the next decision is
//                 computed ONLY from the data since that change. One adjustment per entity per cooldown (compounding protection).
// Every existing guard stays (Economics / Stock / Mapping / Data Quality / Manual Override / Emergency Stop / Advisor / exceptions / limits).
// Budget level is DISCOVERED (never guessed): Meta metadata says whether the budget lives on the campaign (CBO) or on its active ad sets (ABO); anything unclear is UNKNOWN and blocked.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getOperatorConfig } from './operatorStore.js';
import { windowRange } from './operatorRules.js';
import { entityWindowMetrics } from './metricsEngine.js';
import { evaluateGuards, decisionConfidence, resolveZeroOrderLimit } from './operatorGuards.js';
import { buildOperatorWorld, buildCampaignContext, ensureHeavy, loadRecentActions, loadCounters, computeLastPurchaseAt, computeVelocity } from './operatorContext.js';
import { lossFor } from './operatorEngine.js';
import { loadActivePolicies, applyToBudgetPolicy, policyKey, dayAllowed, weekdayOfCairoDate } from './productPolicy.js';

const MS_H = 3_600_000;
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const round0 = (v) => (v === null || v === undefined ? null : Math.round(v));
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);

// =====================================================================================================================
// 1. POLICY (pure data + validation)
// =====================================================================================================================
export const DEFAULT_POLICY = {
  enabled: false, // the scheduler ignores the optimizer until the owner turns it on (and even then: SHADOW/APPROVAL follow the global mode, Meta stays locked)
  window: 'last3',
  zeroOrders: { spend: 200, minAgeHours: 24 },
  scale: { minPurchases: 2, minSpend: 150, maxCpa: 80, pct: 20, cooldownHours: 24, minAgeHours: 48 }, // never scale a very new campaign (age = since Meta first reported it)
  keep: { minCpa: 81, maxCpa: 149 },
  reduce: { minPurchases: 3, minSpend: 450, minCpa: 150, maxCpa: 200, min7dCpa: 150, pct: 20, cooldownHours: 48 },
  highCpa: { above: 200, minPurchases: 3, minSpend: 450, pct: 20 },
  newEvidence: { minSpend: 150 },
  maxReductionsBeforeReview: 3, // after this many consecutive reductions the entity is flagged for a human decision (never an automatic pause)
  // ACCOUNT-WIDE onboarding (2026-10-07): ONE policy for every product + product-specific overrides only where a confirmed value exists. The rules above are PERFORMANCE-only (spend / purchases / CPA),
  // so unknown economics and unknown stock are shown as WARNINGS instead of silently blocking them — but a KNOWN bad value (stock out / below minimum, negative profit, price conflict) still blocks.
  accountWide: {
    requireVerifiedMapping: true,   // CONFLICT / UNMAPPED / SUGGESTED / EXTERNAL_STORE campaigns stay PROTECTED and never enter the optimizer
    economicsMissing: 'WARN',        // WARN | BLOCK — ECONOMICS_INCOMPLETE on a performance-only rule
    stockUnknown: 'WARN',            // WARN | BLOCK — STOCK_UNKNOWN: a warning for pause / reduce / keep; an INCREASE with unknown stock additionally needs the owner's approval (never auto)
    productZeroOrderOverride: true,  // a product's own confirmed zero-order stop (e.g. Hair Cap = 3 x Target CPA) replaces the account-wide 200 EGP for that product only
  },
};
export function mergePolicy(saved) {
  const out = JSON.parse(JSON.stringify(DEFAULT_POLICY));
  for (const [k, v] of Object.entries(saved || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') out[k] = { ...out[k], ...v }; else if (k in out) out[k] = v;
  }
  return out;
}
export function validatePolicy(p) {
  const errors = []; const pos = (path, v, min = 0, max = 1e9) => { const n = num(v); if (n === null || Number.isNaN(n) || n < min || n > max) errors.push(`${path}: قيمة غير صالحة (${v}).`); };
  pos('zeroOrders.spend', p.zeroOrders.spend, 1); pos('zeroOrders.minAgeHours', p.zeroOrders.minAgeHours, 0, 720);
  pos('scale.minPurchases', p.scale.minPurchases, 1, 100); pos('scale.minSpend', p.scale.minSpend, 0); pos('scale.maxCpa', p.scale.maxCpa, 1); pos('scale.pct', p.scale.pct, 1, 100); pos('scale.cooldownHours', p.scale.cooldownHours, 1, 336); pos('scale.minAgeHours', p.scale.minAgeHours, 0, 720);
  pos('reduce.minPurchases', p.reduce.minPurchases, 1, 100); pos('reduce.minSpend', p.reduce.minSpend, 0); pos('reduce.minCpa', p.reduce.minCpa, 1); pos('reduce.maxCpa', p.reduce.maxCpa, 1); pos('reduce.min7dCpa', p.reduce.min7dCpa, 0); pos('reduce.pct', p.reduce.pct, 1, 90); pos('reduce.cooldownHours', p.reduce.cooldownHours, 1, 336);
  pos('highCpa.above', p.highCpa.above, 1); pos('highCpa.minPurchases', p.highCpa.minPurchases, 1, 100); pos('highCpa.minSpend', p.highCpa.minSpend, 0); pos('highCpa.pct', p.highCpa.pct, 1, 90);
  pos('newEvidence.minSpend', p.newEvidence.minSpend, 0);
  if (p.scale.maxCpa >= p.reduce.minCpa) errors.push('حد الـScale لازم يكون أقل من بداية منطقة الـReduce.');
  if (p.reduce.maxCpa > p.highCpa.above) errors.push('نهاية منطقة الـReduce لازم تكون ≤ بداية HIGH_CPA.');
  if (p.window && !['last3', 'last7'].includes(p.window)) errors.push('window لازم last3 أو last7.');
  for (const k of ['economicsMissing', 'stockUnknown']) if (!['WARN', 'BLOCK'].includes(p.accountWide?.[k])) errors.push(`accountWide.${k} لازم WARN أو BLOCK.`);
  return errors;
}
export async function getBudgetPolicy() { return mergePolicy((await getOperatorConfig()).limits?.dynamicBudget); }
export async function setBudgetPolicy({ patch, userId = null }) {
  const cur = await getOperatorConfig();
  const next = mergePolicy({ ...(cur.limits?.dynamicBudget || {}), ...(patch || {}), ...Object.fromEntries(Object.entries(patch || {}).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [k, { ...(cur.limits?.dynamicBudget?.[k] || {}), ...v }])) });
  const errors = validatePolicy(next);
  if (errors.length) { const e = new Error(errors.join(' ')); e.status = 400; e.details = errors; throw e; }
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify({ ...cur.limits, dynamicBudget: next }), updated_by_id: userId } });
  await prisma.aiAuditLog.create({ data: { actor_id: userId || null, kind: 'OPERATOR_BUDGET_POLICY', action: 'EXECUTE', input_json: JSON.stringify({ patch }).slice(0, 3000), success: true } }).catch(() => {});
  return next;
}

// =====================================================================================================================
// 2. BUDGET-LEVEL DISCOVERY (pure over Meta metadata) — never guessed
// =====================================================================================================================
/**
 * campaign = {id, status, budget, budgetType}; adsets = [{id, name, status, budget, budgetType}] (only this campaign's).
 * CBO: the campaign carries the budget. ABO: the campaign carries none and its ACTIVE ad sets do. Both / neither / lifetime-only => UNKNOWN or UNSUPPORTED.
 */
export function discoverBudgetEntities({ campaign, adsets = [] }) {
  const cb = Number(campaign?.budget) > 0 ? Number(campaign.budget) : null;
  const activeAdsets = adsets.filter((a) => a.status === 'ACTIVE');
  const abo = activeAdsets.filter((a) => Number(a.budget) > 0);
  if (cb && abo.length) return { level: 'UNKNOWN', entities: [], reason: 'BUDGET_ON_BOTH_LEVELS' }; // Meta does not allow it: the data is inconsistent, so nothing is guessed
  if (cb) {
    if (campaign.budgetType && campaign.budgetType !== 'DAILY') return { level: 'campaign', entities: [{ level: 'campaign', id: campaign.id, name: null, status: campaign.status, budget: cb, budgetType: campaign.budgetType }], unsupported: 'BUDGET_TYPE_NOT_DAILY' };
    return { level: 'campaign', entities: [{ level: 'campaign', id: campaign.id, name: null, status: campaign.status, budget: cb, budgetType: 'DAILY' }] };
  }
  if (abo.length) {
    const ents = abo.map((a) => ({ level: 'adset', id: a.id, name: a.name || null, status: a.status, budget: Number(a.budget), budgetType: a.budgetType || 'DAILY' }));
    const lifetime = ents.find((e) => e.budgetType !== 'DAILY');
    return { level: 'adset', entities: ents, ...(lifetime ? { unsupported: 'BUDGET_TYPE_NOT_DAILY' } : {}) };
  }
  return { level: 'UNKNOWN', entities: [], reason: activeAdsets.length ? 'ACTIVE_ADSETS_WITHOUT_BUDGET' : 'NO_ACTIVE_ADSET_WITH_BUDGET' };
}

/**
 * Structure from the synced Meta snapshots (last 3 days). campaignIds optional filter. Returns Map(campaignId -> {campaign, adsets, source}).
 * A sync cycle whose entity-metadata call failed writes rows with a NULL status/budget (observed on production: ad-set budgets flap value -> null -> value every few syncs).
 * Such a row is an INCOMPLETE sync, not a fact: only rows that carry the entity status are used, so one failed cycle can no longer turn a known budget into BUDGET_UNKNOWN.
 */
export async function loadBudgetStructureFromSnapshots({ adAccountId, campaignIds = null, now = new Date() }) {
  const since = new Date(now.getTime() - 3 * 86_400_000);
  const where = { ad_account_id: adAccountId, snapshot_at: { gte: since }, ...(campaignIds ? { campaign_id: { in: campaignIds } } : { campaign_id: { not: null } }) };
  const camp = await prisma.metaPerformanceSnapshot.findMany({ where: { ...where, level: 'campaign', campaign_status: { not: null } }, distinct: ['campaign_id'], orderBy: [{ campaign_id: 'asc' }, { snapshot_at: 'desc' }], select: { campaign_id: true, campaign_status: true, campaign_budget: true, campaign_budget_type: true } });
  const ads = await prisma.metaPerformanceSnapshot.findMany({ where: { ...where, level: 'adset', adset_id: { not: null }, adset_status: { not: null } }, distinct: ['adset_id'], orderBy: [{ adset_id: 'asc' }, { snapshot_at: 'desc' }], select: { campaign_id: true, adset_id: true, adset_name: true, adset_status: true, adset_budget: true, adset_budget_type: true } });
  const out = new Map();
  for (const c of camp) out.set(c.campaign_id, { campaign: { id: c.campaign_id, status: c.campaign_status, budget: c.campaign_budget, budgetType: c.campaign_budget_type }, adsets: [], source: 'META_SYNC_SNAPSHOT' });
  for (const a of ads) { const e = out.get(a.campaign_id); if (e) e.adsets.push({ id: a.adset_id, name: a.adset_name, status: a.adset_status, budget: a.adset_budget, budgetType: a.adset_budget_type }); }
  return out;
}
/** LIVE read-only cross-check from Meta (two list calls for the whole account). Returns Map like the snapshot loader, or null when Meta is unreachable. */
export async function loadBudgetStructureLive({ adAccountId, token, currency = 'EGP' }) {
  try {
    const G = await import('../metaGraphClient.js'); const { budgetMinorToMajor } = await import('./snapshotSync.js');
    const [camps, adsets] = [await G.getEntitiesMeta(token, adAccountId, 'campaign'), await G.getEntitiesMeta(token, adAccountId, 'adset')];
    const out = new Map();
    for (const c of camps) { const d = budgetMinorToMajor(c.daily_budget, currency), l = budgetMinorToMajor(c.lifetime_budget, currency); out.set(c.id, { campaign: { id: c.id, status: c.effective_status || c.status, budget: d ?? l ?? null, budgetType: d != null ? 'DAILY' : l != null ? 'LIFETIME' : null }, adsets: [], source: 'META_LIVE' }); }
    for (const a of adsets) { const e = out.get(a.campaign_id); if (!e) continue; const d = budgetMinorToMajor(a.daily_budget, currency), l = budgetMinorToMajor(a.lifetime_budget, currency); e.adsets.push({ id: a.id, name: a.name, status: a.effective_status || a.status, budget: d ?? l ?? null, budgetType: d != null ? 'DAILY' : l != null ? 'LIFETIME' : null }); }
    return out;
  } catch (e) { logger.warn('[budgetOptimizer] live budget structure unavailable', { message: e.message }); return null; }
}

// =====================================================================================================================
// 3. EVIDENCE — since the last budget change (I/O) + the pure classifier
// =====================================================================================================================
const idFieldOf = { campaign: 'campaign_id', adset: 'adset_id' };
const dateOf = (d) => d.toISOString().slice(0, 10);
/** Metrics accumulated SINCE `since` for one entity (campaign|adset), from the append-only snapshots (cumulative per day). null when no data. */
export async function metricsSince({ level, id, since, now = new Date(), adAccountId = null }) {
  const sinceDate = dateOf(since);
  const rows = await prisma.metaPerformanceSnapshot.findMany({ where: { level, [idFieldOf[level]]: id, date_start: { gte: sinceDate }, ...(adAccountId ? { ad_account_id: adAccountId } : {}) }, orderBy: { snapshot_at: 'asc' }, select: { date_start: true, snapshot_at: true, spend: true, meta_purchases: true } });
  if (!rows.length) return null;
  return sinceFromSnapshots(rows, since, now);
}
/** Pure: rows = snapshots ascending; cumulative per date_start. */
export function sinceFromSnapshots(rows, since, now = new Date()) {
  const sinceDate = dateOf(since);
  const byDate = new Map(); for (const r of rows) if (r.date_start >= sinceDate) byDate.set(r.date_start, r); // last snapshot of each day since the change (ascending => later overwrites); earlier days are not 'new evidence'
  let baseSpend = 0, basePur = 0;
  const before = rows.filter((r) => r.date_start === sinceDate && new Date(r.snapshot_at).getTime() <= since.getTime());
  if (before.length) { const b = before[before.length - 1]; baseSpend = b.spend ?? 0; basePur = b.meta_purchases ?? 0; }
  let spend = 0, purchases = 0;
  for (const [d, r] of byDate) { spend += r.spend ?? 0; purchases += r.meta_purchases ?? 0; if (d === sinceDate) { spend -= baseSpend; purchases -= basePur; } }
  spend = Math.max(0, spend); purchases = Math.max(0, purchases);
  return { spend: Math.round(spend * 100) / 100, purchases, cpa: purchases > 0 ? spend / purchases : null, hours: Math.max(0, (now.getTime() - since.getTime()) / MS_H) };
}

/** Campaigns the Daily Operations Center actually OPENED (read-back VERIFIED, real plans only) inside the monitoring window: Map(campaignId -> Date). Budget is never touched right after an open. */
export async function loadRecentDailyOpens({ campaignIds, now = new Date(), hours = 24 }) {
  if (!campaignIds?.length) return new Map();
  const rows = await prisma.ambDailyPlanItem.findMany({ where: { campaign_id: { in: campaignIds }, status: 'VERIFIED', status_at: { gte: new Date(now.getTime() - hours * MS_H) }, plan: { type: 'OPEN', simulated: false } }, select: { campaign_id: true, status_at: true } });
  const out = new Map(); for (const r of rows) { const cur = out.get(r.campaign_id); if (!cur || r.status_at > cur) out.set(r.campaign_id, r.status_at); } return out;
}

/** Last EXECUTED budget change per entity (Operator decisions + legacy AMB actions). Map(entityId -> {at, action, from, to, source}). */
export async function loadLastBudgetChanges({ entityIds, campaignIds = [] }) {
  const out = new Map(); const keep = (id, r) => { const cur = out.get(id); if (!cur || r.at > cur.at) out.set(id, r); };
  const acts = await prisma.ambAction.findMany({ where: { entity_id: { in: entityIds }, execution_status: 'EXECUTED', action_type: { in: ['INCREASE_BUDGET', 'DECREASE_BUDGET'] }, executed_at: { not: null } }, select: { entity_id: true, action_type: true, executed_at: true, old_value_json: true, new_value_json: true } });
  for (const a of acts) keep(a.entity_id, { at: a.executed_at, action: a.action_type === 'INCREASE_BUDGET' ? 'SCALE_UP' : 'SCALE_DOWN', from: j(a.old_value_json, {})?.budget ?? null, to: j(a.new_value_json, {})?.budget ?? null, source: 'AMB_ACTION' });
  const ds = await prisma.ambOperatorDecision.findMany({ where: { campaign_id: { in: [...new Set([...campaignIds, ...entityIds])] }, action: { in: ['SCALE_UP', 'SCALE_DOWN'] }, status: { in: ['EXECUTED', 'VERIFIED'] }, executed_at: { not: null } }, select: { campaign_id: true, action: true, executed_at: true, params_json: true } });
  for (const d of ds) { const p = j(d.params_json, {}) || {}; keep(p.entityId || d.campaign_id, { at: d.executed_at, action: d.action, from: p.fromBudget ?? null, to: p.toBudget ?? null, source: 'OPERATOR_DECISION' }); }
  // the OWNER's own budget edits in Meta (recorded by manualChangeDetector): they start the same cooldown (24h after an increase / 48h after a decrease) and the new-evidence-since-change rule
  const ids = new Set([...entityIds, ...campaignIds]);
  const mo = await prisma.ambOperatorEvent.findMany({ where: { kind: 'MANUAL_OVERRIDE', campaign_id: { in: [...new Set(campaignIds)] }, created_at: { gte: new Date(Date.now() - 14 * 86_400_000) } }, select: { campaign_id: true, data_json: true, created_at: true } });
  for (const e of mo) { const d = j(e.data_json, {}) || {}; if (d.source !== 'META_DIFF' || d.field !== 'budget' || !ids.has(d.entityId)) continue; keep(d.entityId, { at: new Date(d.seenAt || e.created_at), action: Number(d.to) > Number(d.from) ? 'SCALE_UP' : 'SCALE_DOWN', from: d.from ?? null, to: d.to ?? null, source: 'MANUAL_META' }); }
  return out;
}

/**
 * PURE classifier. `m` = the evidence metrics (window or since-last-change), `m7` = 7-day metrics, `lastChange` = {at, action} | null, `since` = metricsSince result.
 * Returns {zone, action, pct, rule, reasons[], needs}. action null = no budget/status change.
 */
export function classifyBudget({ m, m7 = null, ageHours = null, lastChange = null, since = null, policy = DEFAULT_POLICY, now = new Date(), reductionStreak = 0, zeroSpendLimit = null }) {
  const P = policy; const reasons = [];
  const zs = zeroSpendLimit != null && zeroSpendLimit > 0 ? zeroSpendLimit : P.zeroOrders.spend; // a product's own confirmed zero-order stop (Hair Cap) replaces the account-wide number for that product only
  const evidence = lastChange ? { kind: 'SINCE_LAST_CHANGE', since: lastChange.at.toISOString(), hours: round0((now.getTime() - lastChange.at.getTime()) / MS_H) } : { kind: 'WINDOW', window: P.window };
  if (lastChange) {
    const cd = lastChange.action === 'SCALE_UP' ? P.scale.cooldownHours : P.reduce.cooldownHours;
    const hrs = (now.getTime() - lastChange.at.getTime()) / MS_H;
    if (hrs < cd) return { zone: 'COOLDOWN', action: null, rule: 'DYN_COOLDOWN', evidence, reasons: [`COOLDOWN: ${Math.ceil(cd - hrs)} ساعة متبقية بعد آخر تعديل (${lastChange.action === 'SCALE_UP' ? 'زيادة' : 'تقليل'})`], cooldownRemainingH: Math.ceil(cd - hrs) };
    if (!since || since.spend < P.newEvidence.minSpend) return { zone: 'NO_NEW_EVIDENCE', action: null, rule: 'DYN_NEW_EVIDENCE', evidence, reasons: [`مفيش بيانات جديدة كفاية منذ آخر تعديل (صرف ${round0(since?.spend ?? 0)} < ${P.newEvidence.minSpend})`] };
  }
  const E = lastChange ? since : m; // the evidence the decision stands on
  const spend = E?.spend ?? null, purchases = E?.purchases ?? 0, cpa = E?.cpa ?? null;
  const sample = { spend: spend == null ? null : round0(spend), purchases, cpa: cpa == null ? null : round0(cpa), cpa7d: m7?.cpa == null ? null : round0(m7.cpa) };
  if (spend == null) return { zone: 'NO_DATA', action: null, rule: 'DYN_KEEP', evidence, sample, reasons: ['مفيش بيانات أداء في نافذة التقييم'] };
  // ZERO ORDERS
  if (purchases === 0) {
    if (spend >= zs) return ageHours != null && ageHours < P.zeroOrders.minAgeHours ? { zone: 'ZERO_ORDERS_TOO_YOUNG', action: null, rule: 'DYN_ZERO_ORDERS', evidence, sample, reasons: [`صرف ${round0(spend)} بدون أوردرات لكن عمر الحملة ${ageHours}س < ${P.zeroOrders.minAgeHours}س`] } : { zone: 'ZERO_ORDERS', action: 'PAUSE', rule: 'DYN_ZERO_ORDERS', evidence, sample, reasons: [`صرف ${round0(spend)} ≥ ${zs}${zs !== P.zeroOrders.spend ? ' (حد المنتج)' : ''} بدون أوردرات`], needs: {}, zeroLimit: zs };
    return { zone: 'NO_ORDERS_YET', action: null, rule: 'DYN_KEEP', evidence, sample, reasons: [`صرف ${round0(spend)} < ${zs}${zs !== P.zeroOrders.spend ? ' (حد المنتج)' : ''} ومفيش أوردرات لسه`] };
  }
  // with purchases: CPA zones
  if (cpa <= P.scale.maxCpa) {
    if (purchases >= P.scale.minPurchases && spend >= P.scale.minSpend && (ageHours == null || ageHours < P.scale.minAgeHours)) return { zone: 'SCALE_TOO_YOUNG', action: null, rule: 'DYN_KEEP', evidence, sample, reasons: [`CPA ${round0(cpa)} ممتاز لكن عمر الحملة ${ageHours}س < ${P.scale.minAgeHours}س — مفيش Scale لحملة جديدة جدًا`] };
    if (purchases >= P.scale.minPurchases && spend >= P.scale.minSpend) return { zone: 'SCALE', action: 'SCALE_UP', pct: P.scale.pct, rule: 'DYN_SCALE_UP', evidence, sample, reasons: [`CPA ${round0(cpa)} ≤ ${P.scale.maxCpa} بـ ${purchases} أوردر وصرف ${round0(spend)}`], needs: { profit: true, stock: true } };
    return { zone: 'SCALE_SAMPLE_INSUFFICIENT', action: null, rule: 'DYN_KEEP', evidence, sample, reasons: [`CPA ${round0(cpa)} ممتاز لكن العينة غير كافية (${purchases} أوردر، صرف ${round0(spend)}) — الحد ${P.scale.minPurchases} أوردر و${P.scale.minSpend} صرف`] };
  }
  if (cpa < P.reduce.minCpa) return { zone: 'KEEP', action: null, rule: 'DYN_KEEP', evidence, sample, reasons: [`CPA ${round0(cpa)} داخل منطقة الاستمرار (${P.keep.minCpa}–${P.keep.maxCpa})`] };
  const sampleOk = (min) => purchases >= min.minPurchases && spend >= min.minSpend;
  if (cpa <= P.reduce.maxCpa) {
    if (!sampleOk(P.reduce)) return { zone: 'REDUCE_SAMPLE_INSUFFICIENT', action: null, rule: 'DYN_KEEP', evidence, sample, reasons: [`CPA ${round0(cpa)} في منطقة التقليل لكن العينة غير كافية (${purchases} أوردر / صرف ${round0(spend)}) — الحد ${P.reduce.minPurchases} و${P.reduce.minSpend}`] };
    if (!(m7?.cpa != null && m7.cpa >= P.reduce.min7dCpa)) return { zone: 'REDUCE_7D_NOT_CONFIRMED', action: null, rule: 'DYN_KEEP', evidence, sample, reasons: [`CPA ${round0(cpa)} في منطقة التقليل لكن CPA الـ7 أيام (${m7?.cpa == null ? 'غير معروف' : round0(m7.cpa)}) أقل من ${P.reduce.min7dCpa} — يوم سيئ مش اتجاه`] };
    return { zone: 'REDUCE', action: 'SCALE_DOWN', pct: P.reduce.pct, rule: 'DYN_REDUCE', evidence, sample, reasons: [`CPA ${round0(cpa)} بين ${P.reduce.minCpa} و${P.reduce.maxCpa} وCPA الـ7 أيام ${round0(m7.cpa)} ≥ ${P.reduce.min7dCpa}`], needs: {}, flagReview: reductionStreak + 1 >= P.maxReductionsBeforeReview };
  }
  // CPA above the HIGH line, with purchases
  if (!sampleOk(P.highCpa)) return { zone: 'HIGH_CPA_SAMPLE_INSUFFICIENT', action: null, rule: 'DYN_KEEP', evidence, sample, reasons: [`CPA ${round0(cpa)} > ${P.highCpa.above} لكن العينة صغيرة (${purchases} أوردر / صرف ${round0(spend)}) — مفيش قرار من عينة عشوائية`] };
  return { zone: 'HIGH_CPA', action: 'SCALE_DOWN', pct: P.highCpa.pct, rule: 'DYN_HIGH_CPA_REDUCE', evidence, sample, reasons: [`HIGH_CPA: CPA ${round0(cpa)} > ${P.highCpa.above} بعينة كافية — تقليل ${P.highCpa.pct}% الأول ثم إعادة التقييم على بيانات جديدة`], needs: {}, flagReview: reductionStreak + 1 >= P.maxReductionsBeforeReview };
}
export const proposedBudget = (action, from, pct) => (from == null ? null : action === 'SCALE_UP' ? round0(from * (1 + pct / 100)) : action === 'SCALE_DOWN' ? round0(from * (1 - pct / 100)) : from);

// =====================================================================================================================
// 4. ORCHESTRATION — the whole account (or a subset), read-only unless persist
// =====================================================================================================================
const FINAL = { PAUSE: 'WOULD_PAUSE', SCALE_UP: 'WOULD_INCREASE', SCALE_DOWN: 'WOULD_REDUCE' };
const PROTECTED_CODES = new Set(['MAPPING_NOT_VERIFIED', 'EXTERNAL_STORE', 'TESTING_PROTECTED', 'RECENT_PURCHASE_PROTECTION', 'ATTRIBUTION_GRACE', 'MANUAL_OVERRIDE_COOLDOWN', 'COOLDOWN_ACTIVE', 'RECENT_ACTION_PENDING_EVALUATION', 'EXCEPTION_NO_AUTOMATION', 'EXCEPTION_NO_AUTO_STOP', 'EXCEPTION_NO_AUTO_OPEN', 'EXCEPTION_NO_AUTO_SCALE', 'EXCEPTION_NO_BUDGET_CHANGE', 'POST_OPEN_MONITORING']);

/**
 * deps (tests): world, structure (Map), adsetWindows ({last3,last7} Map by adset id), lastChanges (Map), since (fn), recent, counters.
 * Returns {at, policy, counts, rows[], decisionsPersisted}. persist=false (default) writes nothing.
 */
export async function evaluateBudgetOptimization({ now = new Date(), persist = false, live = false, only = null, ruleMode = 'SHADOW', deps = {} } = {}) {
  const policy = deps.policy || await getBudgetPolicy();
  const world = deps.world || await buildOperatorWorld({ windowKeys: ['last3', 'last7', 'last14'], now, only });
  const { config, settings } = world;
  const campaigns = world.campaigns.filter((c) => ['ACTIVE', 'PAUSED'].includes(c.status));
  const active = campaigns.filter((c) => c.status === 'ACTIVE');
  const out = { at: now.toISOString(), adAccountId: world.adAccountId || null, policy, mode: config.mode, emergencyStop: config.emergency_stop, campaigns: campaigns.length, activeCampaigns: active.length, pausedCampaigns: campaigns.length - active.length, structureSource: null, rows: [], counts: null };
  if (!world.adAccountId || !active.length) { out.counts = countRows([], campaigns.length - active.length); return out; }

  // ---- budget structure: live from Meta when asked (+ drift vs the synced snapshots), else the synced Meta metadata
  const activeIds = active.map((c) => c.id);
  const snap = deps.structure || await loadBudgetStructureFromSnapshots({ adAccountId: world.adAccountId, campaignIds: activeIds, now });
  let structure = snap; out.structureSource = 'META_SYNC_SNAPSHOT'; out.liveDrift = [];
  if (live && !deps.structure) {
    const { getDecryptedToken } = await import('../metaAuth.js');
    const lv = await loadBudgetStructureLive({ adAccountId: world.adAccountId, token: await getDecryptedToken() });
    if (lv) { structure = lv; out.structureSource = 'META_LIVE'; for (const id of activeIds) { const a = discoverBudgetEntities(snap.get(id) || { campaign: {} }), b = discoverBudgetEntities(lv.get(id) || { campaign: {} }); const sig = (d) => `${d.level}:${d.entities.map((e) => `${e.id}=${e.budget}`).sort().join(',')}`; if (sig(a) !== sig(b)) out.liveDrift.push({ campaignId: id, snapshot: sig(a), live: sig(b) }); } }
    else out.structureSource = 'META_SYNC_SNAPSHOT (live unavailable)';
  }

  // ---- ad-set level performance for ABO (campaign windows are already in the world)
  const adsetWin = deps.adsetWindows || await (async () => {
    const t = now.toISOString().slice(0, 10); const w = {};
    for (const k of ['last3', 'last7']) { const r = windowRange(k, t); w[k] = await entityWindowMetrics({ level: 'adset', from: r.from, to: r.to, adAccountId: world.adAccountId }); }
    return w;
  })();

  // ---- entities, last changes
  const plan = [];
  for (const c of active) {
    const s = structure.get(c.id) || { campaign: { id: c.id, status: c.status, budget: c.budget, budgetType: c.budgetType }, adsets: [] };
    const d = discoverBudgetEntities({ campaign: { ...s.campaign, id: c.id, status: c.status }, adsets: s.adsets });
    plan.push({ campaign: c, discovery: d });
  }
  const entityIds = plan.flatMap((p) => p.discovery.entities.map((e) => e.id));
  const recentOpens = deps.recentOpens || await loadRecentDailyOpens({ campaignIds: activeIds, now }).catch(() => new Map());
  const lastChanges = deps.lastChanges || await loadLastBudgetChanges({ entityIds, campaignIds: activeIds });

  // ---- guards context (same building blocks the Operator engine uses)
  const recent = deps.recent || await loadRecentActions({ campaignIds: activeIds, now, pendingHours: config.limits.pendingEvaluationHours });
  const counters = deps.counters || await loadCounters({ now, campaigns: world.campaigns });
  const ctxs = new Map();
  for (const c of active) ctxs.set(c.id, deps.ctxFor ? await deps.ctxFor(c) : await buildCampaignContext({ world, campaign: c, recentByCampaign: recent }));
  // total CURRENT daily budget per product (all its ACTIVE campaigns) — a product's Daily Spend Cap is enforced against it on every increase
  const productBudget = new Map();
  for (const { campaign: c0, discovery: d0 } of plan) { const cx0 = ctxs.get(c0.id); if (cx0?.product?.id == null) continue; const k0 = policyKey(cx0.storeId, cx0.product.id); productBudget.set(k0, (productBudget.get(k0) || 0) + d0.entities.reduce((t, e) => t + (Number(e.budget) || 0), 0)); }
  const lossBy = { campaign: new Map(), product: new Map(), account: 0 };
  for (const [id, cx] of ctxs) { const l = lossFor(cx.metrics, cx.econ); lossBy.campaign.set(id, l); if (cx.product?.id != null) lossBy.product.set(cx.product.id, (lossBy.product.get(cx.product.id) || 0) + l); lossBy.account += l; }
  const cfg = { ...config, cooldowns: { ...config.cooldowns, SCALE_UP: policy.scale.cooldownHours, SCALE_DOWN: policy.reduce.cooldownHours } }; // the policy's own cooldowns, for THIS evaluation only
  const gset = { ...settings, ambMinPurchasesBeforeScaling: policy.scale.minPurchases }; // the policy's sample gate for scale, for THIS evaluation only (the global setting is untouched)

  // ---- ACCOUNT-WIDE policy layer: mapping state per campaign (the SAME mapping center the UI shows), product zero-order override, performance-only warnings
  const AW = policy.accountWide || {};
  const productPolicies = deps.productPolicies || await loadActivePolicies().catch(() => new Map()); // per-product ACTIVE policies (drafts never apply)
  const cairoToday = deps.cairoToday || new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(now);
  let mapStates = deps.mappingStates || null;
  if (!mapStates && AW.requireVerifiedMapping) {
    try { const { mappingCenter } = await import('./operatorReadiness.js'); const mc = await mappingCenter({ adAccountId: world.adAccountId, limit: 5000 }); mapStates = new Map(mc.rows.map((r) => [r.campaignId, { state: r.state, note: r.note || null }])); }
    catch (e) { logger.warn('[budgetOptimizer] mapping states unavailable — falling back to the verified flag', { message: e.message }); }
  }
  const slim = (x) => (x ? { spend: round0(x.spend ?? 0), purchases: x.purchases ?? 0, cpa: x.cpa == null ? null : round0(x.cpa) } : null);
  const soften = (bk, action) => {
    if (bk.code === 'ECONOMICS_INCOMPLETE' && AW.economicsMissing === 'WARN') return { ...bk, severity: 'WARN' };
    if (bk.code === 'STOCK_UNKNOWN' && AW.stockUnknown === 'WARN') return { ...bk, severity: action === 'SCALE_UP' ? 'DOWNGRADE' : 'WARN' }; // an increase with unknown stock never runs by itself
    return bk;
  };
  const fmtGuard = (bk) => `${bk.code}[${bk.severity[0]}]${bk.detail ? ':' + String(bk.detail).slice(0, 40) : ''}`;

  for (const { campaign: c, discovery } of plan) {
    const cx = ctxs.get(c.id);
    if (!deps.ctxFor) await ensureHeavy(cx); // product facts (economics / stock / data quality / advisor) — cached per product, read-only
    const pol = cx.product?.id != null ? productPolicies.get(policyKey(cx.storeId, cx.product.id)) || null : null;
    const eff = pol ? applyToBudgetPolicy(policy, pol, c.id) : null; const rowPolicy = eff?.policy || policy; const rowAW = eff?.stockPolicy ? { ...AW, stockUnknown: eff.stockPolicy } : AW;
    const dayOff = pol && !dayAllowed(pol, weekdayOfCairoDate(cairoToday), c.id);
    const ms = mapStates?.get(c.id) || null;
    const mapState = ms?.state || (cx.product?.mappingVerified ? 'VERIFIED' : (cx.product?.mappingSource || 'UNMAPPED'));
    const mapVerified = ms ? ms.state === 'VERIFIED' : !!cx.product?.mappingVerified;
    const mapBlock = AW.requireVerifiedMapping && !mapVerified ? { code: mapState === 'EXTERNAL_STORE' ? 'EXTERNAL_STORE' : 'MAPPING_NOT_VERIFIED', severity: 'BLOCK', detail: mapState } : null;
    const base = { storeId: cx.storeId, campaignId: c.id, campaign: (c.name || '').trim(), status: c.status, productId: cx.product?.id ?? null, product: cx.product?.name || null, mapping: mapState, mappingNote: ms?.note || null, budgetLevel: discovery.level };
    const warns = []; // performance-only rules: unknown economics / stock are WARNINGS (a known bad value still blocks inside the guard chain)
    if (cx.product?.id != null && AW.economicsMissing === 'WARN' && !cx.econ?.complete) warns.push({ code: 'ECONOMICS_INCOMPLETE', severity: 'WARN' });
    if (cx.product?.id != null && rowAW.stockUnknown === 'WARN' && (!cx.stock || cx.stock.status === 'STOCK_UNKNOWN')) warns.push({ code: 'STOCK_UNKNOWN', severity: 'WARN' });
    let zeroLimit = eff?.zeroSpend ?? null, zeroUnresolved = false; const zo = cx.productOverride?.zeroOrder;
    if (eff?.zeroSpend == null && AW.productZeroOrderOverride && zo?.mode) { const zr = cx.zeroOrder?.limit != null ? cx.zeroOrder : resolveZeroOrderLimit({ override: zo, targetCpa: cx.econ?.targetCpa }); if (zr.limit) zeroLimit = zr.limit; else zeroUnresolved = true; }
    if (!discovery.entities.length) { rows_push(out, { ...base, entity: null, decision: mapBlock ? 'PROTECTED' : 'BLOCKED', intended: null, guards: [...(mapBlock ? [fmtGuard(mapBlock)] : []), 'BUDGET_UNKNOWN[B]', ...warns.map(fmtGuard)], reason: `مستوى الميزانية غير معروف (${discovery.reason}) — مفيش تخمين`, evidence: null, m3: slim(world.windows.last3?.get(c.id)), m7: slim(world.windows.last7?.get(c.id)) }); continue; }
    for (const ent of discovery.entities) {
      const m = ent.level === 'adset' ? adsetWin.last3?.get(ent.id) : world.windows.last3?.get(c.id);
      const m7 = ent.level === 'adset' ? adsetWin.last7?.get(ent.id) : world.windows.last7?.get(c.id);
      const win = policy.window === 'last7' ? m7 : m;
      const lc = lastChanges.get(ent.id) || (ent.level === 'campaign' ? lastChanges.get(c.id) : null) || null;
      const since = lc ? await (deps.since ? deps.since({ level: ent.level, id: ent.id, since: lc.at }) : metricsSince({ level: ent.level, id: ent.id, since: lc.at, now, adAccountId: world.adAccountId })) : null;
      const ageHours = c.firstSeenAt ? Math.floor((now.getTime() - new Date(c.firstSeenAt).getTime()) / MS_H) : null;
      const winRow = rowPolicy.window === 'last7' ? m7 : m;
      const cl = classifyBudget({ m: winRow, m7, ageHours, lastChange: lc, since, policy: rowPolicy, now, zeroSpendLimit: zeroLimit });
      const evid = { window: cl.evidence, spend: cl.sample?.spend ?? null, purchases: cl.sample?.purchases ?? null, cpa: cl.sample?.cpa ?? null, cpa7d: cl.sample?.cpa7d ?? null, lastChange: lc ? { at: lc.at.toISOString(), action: lc.action, from: lc.from, to: lc.to, source: lc.source } : null };
      const row = { ...base, entity: { level: ent.level, id: ent.id, name: ent.name, budget: ent.budget, budgetType: ent.budgetType }, zone: cl.zone, rule: cl.rule, evidence: evid, m3: slim(m), m7: slim(m7), ageHours, zeroLimit: cl.zeroLimit ?? zeroLimit, reason: cl.reasons.join(' · '), intended: null, guards: [], flagReview: !!cl.flagReview };
      const extra = (have) => warns.filter((w) => !have.some((g) => g.code === w.code)).map(fmtGuard);
      if (!cl.action) { row.decision = mapBlock ? 'PROTECTED' : (['COOLDOWN', 'NO_NEW_EVIDENCE'].includes(cl.zone) ? 'PROTECTED' : 'KEEP'); row.guards = [...(mapBlock ? [fmtGuard(mapBlock)] : []), ...extra([])]; rows_push(out, row); continue; }
      // a budget action: needs a known DAILY budget at the discovered level
      const from = ent.budget; let to = cl.action === 'PAUSE' ? null : proposedBudget(cl.action, from, cl.pct);
      const boundBlocks = [];
      if (eff?.dailyCap != null && cl.action === 'SCALE_UP' && to != null && from != null) { const tot = productBudget.get(policyKey(cx.storeId, cx.product.id)) || 0; if (tot + (to - from) > eff.dailyCap) boundBlocks.push({ code: 'PRODUCT_DAILY_CAP', severity: 'BLOCK', detail: `إجمالي ميزانية المنتج ${tot} + ${to - from} > الحد اليومي ${eff.dailyCap}` }); }
      if (eff && to != null && from != null) { const { minBudget, maxBudget } = eff.bounds; if (cl.action === 'SCALE_UP' && maxBudget != null) { if (from >= maxBudget) boundBlocks.push({ code: 'PRODUCT_MAX_BUDGET', severity: 'BLOCK', detail: `الميزانية ${from} وصلت أقصى حد للمنتج ${maxBudget}` }); else to = Math.min(to, maxBudget); } if (cl.action === 'SCALE_DOWN' && minBudget != null) { if (from <= minBudget) boundBlocks.push({ code: 'PRODUCT_MIN_BUDGET', severity: 'BLOCK', detail: `الميزانية ${from} عند أقل حد للمنتج ${minBudget}` }); else to = Math.max(to, minBudget); } }
      row.intended = { action: cl.action, pct: cl.pct ?? null, fromBudget: cl.action === 'PAUSE' ? null : from, toBudget: to };
      const pre = [];
      if (mapBlock) pre.push(mapBlock);
      if (dayOff && cl.action !== 'PAUSE') pre.push({ code: 'PRODUCT_POLICY_DAY_OFF', severity: 'BLOCK', detail: 'اليوم خارج أيام تشغيل سياسة المنتج' });
      pre.push(...boundBlocks);
      if (cl.action !== 'PAUSE' && recentOpens.get(c.id)) pre.push({ code: 'POST_OPEN_MONITORING', severity: 'BLOCK', detail: `اتفتحت من خطة الفتح ${new Date(recentOpens.get(c.id)).toISOString()} — فترة مراقبة قبل أي تعديل ميزانية` });
      if (cl.action === 'PAUSE' && zeroUnresolved) pre.push({ code: 'ZERO_ORDER_NOT_CONFIGURED', severity: 'BLOCK', detail: 'PRODUCT_OVERRIDE_UNRESOLVED' });
      if (cl.action !== 'PAUSE' && discovery.unsupported) pre.push({ code: 'BUDGET_TYPE_UNSUPPORTED', severity: 'BLOCK' });
      const confidence = decisionConfidence({ action: cl.action, metrics: { spend: cl.sample.spend, purchases: cl.sample.purchases }, settings: gset, mappingVerified: !!cx.product?.mappingVerified, dqOk: cx.dq?.gate !== 'DECISION_BLOCKED_DATA_QUALITY' && !!cx.dq?.gate, econKnown: !!cx.econ?.complete, stockKnown: !!cx.stock && cx.stock.status !== 'STOCK_UNKNOWN', needs: cl.needs || {} });
      if (cl.action === 'PAUSE' && !cx.lastPurchaseLoaded) { cx.lastPurchaseLoaded = true; cx.lastPurchaseAt = deps.lastPurchaseAt ? await deps.lastPurchaseAt(c.id) : await computeLastPurchaseAt({ campaignId: c.id, now }).catch(() => null); }
      if (cl.action === 'SCALE_UP' && cx.velocity === null && !cx.velocityLoaded) { cx.velocityLoaded = true; cx.velocity = deps.velocity ? await deps.velocity(c.id) : await computeVelocity({ campaignId: c.id, now, cfg: config.limits.spendVelocity }).catch(() => null); }
      const g = evaluateGuards({
        decision: { action: cl.action, params: cl.action === 'PAUSE' ? {} : { pct: cl.pct, fromBudget: from, toBudget: to, level: ent.level, entityId: ent.id }, ruleMode, // 'SHADOW' (preview) | 'APPROVAL' (pre-flight of an owner-approved execution: the execution-time guards are evaluated too)
         confidence, needs: cl.needs || {}, usesCod: false, cooldownHours: cl.action === 'SCALE_UP' ? policy.scale.cooldownHours : policy.reduce.cooldownHours, ruleMinSpend: cl.action === 'PAUSE' ? (cl.zeroLimit ?? policy.zeroOrders.spend) : null, severeOverride: false },
        ctx: { ...cx, metrics: { spend: cl.sample.spend, purchases: cl.sample.purchases, cpa: cl.sample.cpa }, campaign: { ...cx.campaign, budget: ent.budget }, ruleConflicts: [] },
        config: cfg, settings: gset, now,
        counters: { ...counters, campaignActionsToday: cx.recent.todayCount, loss: { campaign: lossBy.campaign.get(c.id) || 0, product: cx.product?.id != null ? lossBy.product.get(cx.product.id) || 0 : 0, account: lossBy.account } },
      });
      const gb = g.blocks.map((bk) => soften(bk, cl.action));
      const blocks = [...pre, ...gb.filter((bk) => bk.severity === 'BLOCK')];
      const down = gb.filter((bk) => bk.severity === 'DOWNGRADE');
      row.guards = [...pre, ...gb].map(fmtGuard).concat(extra(gb));
      row.confidence = confidence; row.requiresApproval = down.length > 0; row.primaryBlock = blocks[0]?.code || null;
      row.decision = blocks.length ? (PROTECTED_CODES.has(blocks[0].code) ? 'PROTECTED' : 'BLOCKED') : FINAL[cl.action];
      row.wouldBe = blocks.length ? 'BLOCKED' : (g.effectiveMode === 'SHADOW' || g.effectiveMode === 'OFF' ? 'SHADOW' : (g.effectiveMode === 'AUTOPILOT' && !down.length ? 'AUTO' : 'PREPARED'));
      rows_push(out, row);
    }
  }
  out.counts = countRows(out.rows, campaigns.length - active.length);
  if (persist) out.persisted = await persistBudgetDecisions(out.rows.filter((r) => r.intended), { adAccountId: world.adAccountId, mode: config.mode, now });
  return out;
}
function rows_push(out, row) { out.rows.push(row); }
export function countRows(rows, paused = 0) {
  const c = { WOULD_PAUSE: 0, WOULD_INCREASE: 0, WOULD_REDUCE: 0, KEEP: 0, PROTECTED: 0, BLOCKED: 0, NO_ACTION_PAUSED: paused, HIGH_CPA_REDUCE: 0, blockedWouldPause: 0, blockedWouldIncrease: 0, blockedWouldReduce: 0 };
  for (const r of rows) {
    c[r.decision] = (c[r.decision] || 0) + 1;
    if (r.zone === 'HIGH_CPA') c.HIGH_CPA_REDUCE++;
    if (['BLOCKED', 'PROTECTED'].includes(r.decision) && r.intended) c[{ PAUSE: 'blockedWouldPause', SCALE_UP: 'blockedWouldIncrease', SCALE_DOWN: 'blockedWouldReduce' }[r.intended.action]]++;
  }
  return c;
}

// =====================================================================================================================
// 5. PERSISTENCE + ACTION HISTORY (SHADOW rows in the existing decision table; never executed from here)
// =====================================================================================================================
const RULE_PREFIX = 'DYNAMIC_BUDGET:';
export const isDynamicBudgetRule = (name) => String(name || '').startsWith(RULE_PREFIX);
async function recordEvent(data) { try { await prisma.ambOperatorEvent.create({ data }); } catch (e) { logger.warn('[budgetOptimizer] event write failed', { message: e.message }); } }
export function historyRecord(row, { at = new Date() } = {}) {
  return { beforeBudget: row.intended?.fromBudget ?? null, afterBudget: row.intended?.toBudget ?? null, level: row.entity?.level || null, entityId: row.entity?.id || null, entityName: row.entity?.name || null, cpa: row.evidence?.cpa ?? null, purchases: row.evidence?.purchases ?? null, spend: row.evidence?.spend ?? null, cpa7d: row.evidence?.cpa7d ?? null, rule: row.rule, zone: row.zone, evidenceWindow: row.evidence?.window || null, lastChange: row.evidence?.lastChange || null, timestamp: at.toISOString() };
}
export async function persistBudgetDecisions(rows, { adAccountId, mode, now = new Date(), expireStale = true }) {
  let created = 0, updated = 0; const seen = new Set();
  for (const r of rows) {
    const cooldown = r.intended.action === 'SCALE_UP' ? 24 : 48;
    const bucket = Math.floor(now.getTime() / (cooldown * MS_H));
    const key = crypto.createHash('sha1').update(`dyn|${r.entity?.id || r.campaignId}|${r.intended.action}|${bucket}`).digest('hex').slice(0, 24);
    seen.add(key);
    const status = r.decision === 'BLOCKED' || r.decision === 'PROTECTED' ? 'BLOCKED' : (r.wouldBe === 'PREPARED' ? 'PREPARED' : 'SHADOW');
    const hist = historyRecord(r, { at: now });
    const data = { store_id: r.storeId || 'UNKNOWN', product_id: r.productId, ad_account_id: adAccountId, campaign_id: r.campaignId, campaign_name: r.campaign, action: r.intended.action, rule_id: null, rule_name: `${RULE_PREFIX}${r.rule}`, mode_at_decision: mode, confidence: r.confidence || 'LOW',
      blocked_codes_json: JSON.stringify(r.guards), evidence_json: JSON.stringify({ history: hist, evidence: r.evidence, m3: r.m3 || null, m7: r.m7 || null }), why_json: JSON.stringify({ what: `${r.rule} — ${r.reason}`, why: r.reason }), params_json: JSON.stringify({ ...(r.intended.toBudget != null ? { pct: r.intended.pct, fromBudget: r.intended.fromBudget, toBudget: r.intended.toBudget } : {}), level: r.entity?.level, entityId: r.entity?.id, window: r.evidence?.window?.window || 'since-last-change' }) };
    const ex = await prisma.ambOperatorDecision.findUnique({ where: { decision_key: key } });
    if (!ex) { const row = await prisma.ambOperatorDecision.create({ data: { decision_key: key, status, before_json: JSON.stringify({ budget: r.intended.fromBudget, level: r.entity?.level }), ...data } }); await recordEvent({ decision_id: row.id, kind: 'TRANSITION', from_status: 'CANDIDATE', to_status: status, actor: 'SYSTEM', note: r.primaryBlock || null, campaign_id: r.campaignId }); created++; }
    else if (['SHADOW', 'BLOCKED', 'PREPARED', 'EXPIRED'].includes(ex.status)) { await prisma.ambOperatorDecision.update({ where: { id: ex.id }, data: { ...data, status } }); updated++; }
  }
  if (!expireStale) return { created, updated, expired: 0 }; // single-decision preparation (owner-approved execution) must never touch other decisions
  // this optimizer's own stale open rows (evidence changed / campaign no longer qualifies) expire here — the engine's expiry skips them
  const open = await prisma.ambOperatorDecision.findMany({ where: { rule_name: { startsWith: RULE_PREFIX }, status: { in: ['SHADOW', 'BLOCKED', 'PREPARED'] } }, select: { id: true, decision_key: true } });
  const stale = open.filter((o) => !seen.has(o.decision_key)).map((o) => o.id);
  if (stale.length) await prisma.ambOperatorDecision.updateMany({ where: { id: { in: stale }, status: { in: ['SHADOW', 'BLOCKED', 'PREPARED'] } }, data: { status: 'EXPIRED', error: 'NO_LONGER_APPLICABLE' } });
  return { created, updated, expired: stale.length };
}
/** Action history: before → after budget, level, CPA, purchases, spend, rule, evidence window, timestamp. */
export async function budgetActionHistory({ campaignId = null, limit = 100 } = {}) {
  const rows = await prisma.ambOperatorDecision.findMany({ where: { rule_name: { startsWith: RULE_PREFIX }, ...(campaignId ? { campaign_id: campaignId } : {}) }, orderBy: { id: 'desc' }, take: Math.min(Number(limit) || 100, 500) });
  return rows.map((d) => { const ev = j(d.evidence_json, {}) || {}; const h = ev.history || {}; const cdH = d.action === 'SCALE_UP' ? 24 : 48; const done = d.executed_at && ['EXECUTED', 'VERIFIED'].includes(d.status); const bj = j(d.before_json, {}) || {}, aj = j(d.after_json, {}) || {}; return { id: d.id, status: d.status, mode: d.mode_at_decision, campaignId: d.campaign_id, campaign: d.campaign_name, action: d.action, ...h, ...(done ? { beforeBudget: bj.budget ?? h.beforeBudget ?? null, afterBudget: aj.budget ?? h.afterBudget ?? null } : {}), executedAt: d.executed_at || null, verifiedAt: d.verified_at || null, approvedById: d.approved_by_id || null, verified: d.status === 'VERIFIED', cooldownHours: done ? cdH : null, cooldownUntil: done ? new Date(new Date(d.executed_at).getTime() + cdH * MS_H) : null, createdAt: d.created_at, blocked: j(d.blocked_codes_json, []) }; });
}
