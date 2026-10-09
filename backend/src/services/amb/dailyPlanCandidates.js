// 🧮 Daily Operations Center — CANDIDATE builders for the two daily plans. READ-ONLY: synced snapshots + existing canonical systems (mapping center, stock guard, data quality, Smart Advisor, the Dynamic Budget
// Optimizer's guard chain). Nothing here writes to Meta or to the plan tables. 2026-10-07.
//
//   OPEN  (00:00 Cairo): PAUSED campaigns that earned a place back, ranked by REAL performance with sample size, CPA stability and orders (never "a winner" from one order).
//   PAUSE (13:00 Cairo): ACTIVE campaigns ranked by risk (worst first). Only the policy's own pause rule (zero orders >= the limit, after attribution grace / min age / recent-purchase / testing protection)
//                        is pre-selected; high-CPA campaigns are listed but NOT pre-selected (the policy reduces their budget instead of pausing); strong winners are protected.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { buildOperatorWorld, buildCampaignContext, ensureHeavy, loadRecentActions } from './operatorContext.js';
import { mappingCenter } from './operatorReadiness.js';
import { evaluateBudgetOptimization, loadBudgetStructureFromSnapshots, loadLastBudgetChanges, getBudgetPolicy } from './budgetOptimizer.js';
import { diffEntityRows, classifyRecurring } from './manualChangeDetector.js';
import { exceptionsFor } from './operatorStore.js';
import { computeLastPurchaseAt } from './operatorContext.js';
import { STAGE_LABEL_AR, PROBLEM_LABEL_AR } from './advisorPlan.js';

const MS_H = 3_600_000;
const round0 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
import { priorityScore } from './priorityScore.js';
import { loadActivePolicies, policyKey, mergeEffective, dayAllowed, weekdayOfCairoDate } from './productPolicy.js';
import { SLOTS, cairoDate } from './dailyPlanTime.js';
import { getOpenCpaPolicy, applyPolicyToItems, loadWindowMetrics } from './openCpaPolicy.js';

/** Per-product policy gate for a daily plan: the product's days of the week + its own opening/closing time (a product with its own time lives in its own slot plan). Pure. */
export function policyScheduleBlock({ policy, type, slotTime, date, campaignId = null }) {
  if (!policy) return null;
  if (!dayAllowed(policy, weekdayOfCairoDate(date), campaignId)) return 'PRODUCT_POLICY_DAY_OFF';
  const eff = mergeEffective(policy, campaignId).schedule; const own = type === 'OPEN' ? eff.openTime : eff.closeTime;
  return own && own !== slotTime ? 'PRODUCT_POLICY_OTHER_TIME' : null;
}
const syncAgeMin = async (deps = {}) => { try { const st = await (deps.syncStatus ? deps.syncStatus() : (await import('./snapshotSync.js')).getSyncStatus()); return st?.lastSuccessAt ? Math.max(0, Math.round((Date.now() - new Date(st.lastSuccessAt).getTime()) / 60_000)) : null; } catch { return null; } };
const slim = (m) => (m ? { spend: round0(m.spend ?? 0), purchases: m.purchases ?? 0, cpa: m.cpa == null ? null : round0(m.cpa), ctr: m.ctr == null ? null : Math.round(m.ctr * 100) / 100, cpc: m.cpc == null ? null : Math.round(m.cpc * 100) / 100, cvr: m.conversionRate == null ? (m.cvr == null ? null : Math.round(m.cvr * 100) / 100) : Math.round(m.conversionRate * 100) / 100 } : { spend: 0, purchases: 0, cpa: null, ctr: null, cpc: null, cvr: null });

// =====================================================================================================================
// PURE scoring / ranking (unit-tested)
// =====================================================================================================================
export const sampleTier = (p30) => (p30 >= 20 ? 'A' : p30 >= 8 ? 'B' : p30 >= 3 ? 'C' : 'D');
/** CPA reference for ranking: the 30-day CPA when its sample is meaningful (>= 5 orders), otherwise the 7-day one. */
export const cpaReference = ({ m7, m30 }) => ((m30?.purchases ?? 0) >= 5 && m30.cpa != null ? m30.cpa : (m7?.purchases ?? 0) >= 2 && m7.cpa != null ? m7.cpa : m30?.cpa ?? m7?.cpa ?? null);
/** CPA stability between the 7d and 30d windows: STABLE (<= 30% apart), VOLATILE, or UNKNOWN. */
export function cpaStability({ m7, m30 }) {
  if (!(m7?.cpa > 0) || !(m30?.cpa > 0) || (m7.purchases ?? 0) < 2 || (m30.purchases ?? 0) < 5) return 'UNKNOWN';
  const r = Math.max(m7.cpa, m30.cpa) / Math.min(m7.cpa, m30.cpa); return r <= 1.3 ? 'STABLE' : 'VOLATILE';
}
/** OPEN ranking score — higher is better. Sample tier first, then CPA, orders, stability; stale data is penalised. */
export function openScore({ m7, m30, daysSinceActive = null }) {
  const tier = sampleTier(m30?.purchases ?? 0); const cpa = cpaReference({ m7, m30 });
  const tierPts = { A: 300, B: 200, C: 100, D: 0 }[tier];
  const cpaPts = cpa == null ? 0 : Math.max(0, 250 - cpa);
  const ordersPts = Math.min(m30?.purchases ?? 0, 60) * 2;
  const stab = cpaStability({ m7, m30 }); const stabPts = stab === 'STABLE' ? 40 : stab === 'VOLATILE' ? -40 : 0;
  const stale = daysSinceActive != null && daysSinceActive > 14 ? -Math.min(80, (daysSinceActive - 14) * 4) : 0;
  return Math.round(tierPts + cpaPts + ordersPts + stabPts + stale);
}
/** Is an OPEN candidate RECOMMENDED (pre-selectable)? Needs a reliable sample, a CPA under the keep ceiling and no volatility red flag. */
export function openRecommended({ m7, m30 }) {
  const tier = sampleTier(m30?.purchases ?? 0), cpa = cpaReference({ m7, m30 });
  if (tier === 'D' || cpa == null) return { ok: false, why: 'عينة غير كافية (أقل من 3 أوردرات في 30 يوم) — مفيش حملة بتتسمّى رابحة من أوردر واحد' };
  if (cpa >= 150) return { ok: false, why: `CPA المرجعي ${round0(cpa)} ≥ 150 — فوق منطقة الاستمرار` };
  // a good 30-day number never hides a bad RECENT week: real spend in 7 days with no orders, or a 7-day CPA over the line
  if ((m7?.spend ?? 0) >= 200 && ((m7?.purchases ?? 0) === 0 || (m7.cpa != null && m7.cpa > 200))) return { ok: false, why: `الأداء الحديث ضعيف: ${m7.purchases ?? 0} أوردر على ${round0(m7.spend)} صرف في 7 أيام${m7.cpa != null ? ` (CPA ${round0(m7.cpa)})` : ''} — رغم CPA 30 يوم ${round0(cpa)}` };
  if (cpaStability({ m7, m30 }) === 'VOLATILE') return { ok: false, why: 'CPA غير مستقر بين 7 و30 يوم' };
  if (tier === 'C' && (m7?.purchases ?? 0) === 0) return { ok: false, why: 'عينة صغيرة ومفيش أوردرات حديثة' };
  return { ok: true, why: null };
}
export function openRisk({ m7, m30, stock, warnings = [] }) {
  const tier = sampleTier(m30?.purchases ?? 0), cpa = cpaReference({ m7, m30 }); let s = 0;
  s += { A: 0, B: 15, C: 35, D: 60 }[tier]; if (cpa == null) s += 20; else if (cpa >= 200) s += 35; else if (cpa >= 150) s += 25; else if (cpa > 120) s += 10;
  if (cpaStability({ m7, m30 }) === 'VOLATILE') s += 15; if (stock === 'STOCK_UNKNOWN' || !stock) s += 5; s += warnings.length * 5;
  s = Math.min(100, s); return { score: s, level: s >= 60 ? 'HIGH' : s >= 30 ? 'MEDIUM' : 'LOW' };
}
/** PAUSE risk score (0-100), worst first. Zero orders after a real spend and a CPA far above the line weigh most; today's partial numbers only add a hint (the day is not over at 13:00). */
export function pauseRisk({ today, m3, m7, m30, zeroLimit = 200 }) {
  let s = 0; const reasons = [];
  const z3 = (m3?.purchases ?? 0) === 0 && (m3?.spend ?? 0) >= zeroLimit, z7 = (m7?.purchases ?? 0) === 0 && (m7?.spend ?? 0) >= zeroLimit;
  if (z3) { s += 90; reasons.push(`صرف ${round0(m3.spend)} بدون أوردرات في 3 أيام`); } else if (z7) { s += 80; reasons.push(`صرف ${round0(m7.spend)} بدون أوردرات في 7 أيام`); }
  const cpa = m3?.cpa ?? m7?.cpa ?? null;
  if (!z3 && !z7 && cpa != null) { if (cpa > 300) { s += 80; reasons.push(`CPA ${round0(cpa)} > 300`); } else if (cpa > 200) { s += 65; reasons.push(`CPA ${round0(cpa)} > 200`); } else if (cpa >= 150) { s += 45; reasons.push(`CPA ${round0(cpa)} في منطقة التقليل (150–200)`); } else if (cpa > 80) s += 15; else s += 5; }
  if (m3?.cpa && m7?.cpa && m3.cpa > m7.cpa * 1.3) { s += 10; reasons.push('CPA الـ3 أيام أسوأ من الـ7 أيام'); }
  if ((m3?.purchases ?? 0) < 2 && (m3?.spend ?? 0) >= 300 && !z3) { s += 10; reasons.push('صرف كبير على عينة صغيرة'); }
  if ((today?.purchases ?? 0) === 0 && (today?.spend ?? 0) >= zeroLimit) { s += 8; reasons.push(`اليوم: صرف ${round0(today.spend)} بدون أوردرات (جزئي — اليوم لسه ما خلصش)`); }
  s = Math.max(0, Math.min(100, s)); return { score: s, level: s >= 65 ? 'HIGH' : s >= 35 ? 'MEDIUM' : 'LOW', reasons };
}
/** Strong winner = enough orders over 30 days, CPA comfortably under the keep line on BOTH windows. */
export const isWinner = ({ m7, m30 }) => (m30?.purchases ?? 0) >= 10 && m30.cpa != null && m30.cpa <= 120 && (m7?.purchases ?? 0) >= 2 && m7.cpa != null && m7.cpa <= 130;

// =====================================================================================================================
// I/O helpers
// =====================================================================================================================
/** ABO/CBO + the budget that would run: CBO = the campaign budget; ABO = the sum of the budgets of the ad sets that would actually deliver (ACTIVE or held back only by the paused campaign). */
export function plannedBudget(s) {
  if (!s) return { level: 'UNKNOWN', budget: null };
  const cb = Number(s.campaign?.budget); if (cb > 0) return { level: 'CBO', budget: cb };
  const run = (s.adsets || []).filter((a) => ['ACTIVE', 'CAMPAIGN_PAUSED'].includes(a.status) && Number(a.budget) > 0);
  if (run.length) return { level: 'ABO', budget: run.reduce((t, a) => t + Number(a.budget), 0), adsets: run.length };
  return { level: 'UNKNOWN', budget: null };
}
/** Who paused it? DAILY_SCHEDULE (a recurring daily routine / rule — recognised from the last 7 days of status changes), SYSTEM (our own executed pause), MANUAL (a one-off owner pause), UNKNOWN_OLD (no recent change). */
export async function loadPausedOrigin({ campaignIds, recentByCampaign = new Map(), now = new Date(), deps = {} }) {
  const out = new Map(); if (!campaignIds.length) return out;
  const since = new Date(now.getTime() - 7 * 24 * MS_H);
  const rows = deps.statusRows || await prisma.metaPerformanceSnapshot.findMany({ where: { level: 'campaign', campaign_id: { in: campaignIds }, snapshot_at: { gte: since }, campaign_status: { not: null } }, orderBy: { snapshot_at: 'asc' }, select: { campaign_id: true, snapshot_at: true, campaign_status: true } });
  const by = new Map(); for (const r of rows) (by.get(r.campaign_id) || by.set(r.campaign_id, []).get(r.campaign_id)).push({ at: r.snapshot_at, status: r.campaign_status, budget: null });
  const changes = []; for (const [id, rs] of by) for (const c of diffEntityRows(rs)) changes.push({ ...c, entityId: id });
  const cls = classifyRecurring(changes);
  for (const id of campaignIds) {
    const pauses = cls.filter((c) => c.entityId === id && c.field === 'status' && c.to === 'PAUSED').sort((a, b) => b.seenAt - a.seenAt);
    const last = pauses[0] || null; const sys = recentByCampaign.get(id)?.pausedBySystemAt || null;
    if (sys && (!last || new Date(sys) >= last.seenAt - 35 * 60_000)) out.set(id, { origin: 'SYSTEM', at: sys });
    else if (last) out.set(id, { origin: last.recurring ? 'DAILY_SCHEDULE' : 'MANUAL', at: last.seenAt });
    else out.set(id, { origin: 'UNKNOWN_OLD', at: null });
  }
  return out;
}
export async function loadLastActiveDates(campaignIds, deps = {}) {
  if (deps.lastActive) return deps.lastActive;
  const out = new Map(); if (!campaignIds.length) return out;
  const rows = await prisma.metaPerformanceSnapshot.groupBy({ by: ['campaign_id'], where: { level: 'campaign', campaign_id: { in: campaignIds }, spend: { gt: 0 } }, _max: { date_start: true } });
  for (const r of rows) out.set(r.campaign_id, r._max.date_start); return out;
}
const daysBetween = (dateStr, now) => (dateStr ? Math.max(0, Math.floor((now.getTime() - new Date(`${dateStr}T00:00:00Z`).getTime()) / (24 * MS_H))) : null);
const exceptionFor = (ctx, kinds) => (ctx?.exceptions || []).find((e) => (e.types || []).some((t) => kinds.includes(t)));
const advisorSummary = (adv) => (adv ? { stage: adv.stage || null, stageLabel: STAGE_LABEL_AR[adv.stage] || adv.stageLabel || adv.stage || null, problem: adv.primaryProblem || null, problemLabel: PROBLEM_LABEL_AR[adv.primaryProblem] || adv.primaryProblemLabel || adv.primaryProblem || null, scalePlan: !!adv.scalePlanPresent, next: adv.nextActionNow || null } : null);

async function prepareWorld({ now, deps }) {
  const world = deps.world || await buildOperatorWorld({ windowKeys: ['today', 'last3', 'last7', 'last14', 'last30'], now });
  const mapStates = deps.mapStates || await (async () => { const mc = await mappingCenter({ adAccountId: world.adAccountId, limit: 5000 }); return new Map(mc.rows.map((r) => [r.campaignId, { state: r.state, note: r.note || null }])); })();
  return { world, mapStates };
}

// =====================================================================================================================
// OPEN candidates (00:00)
// =====================================================================================================================
export async function buildOpenCandidates({ now = new Date(), slotTime = SLOTS.OPEN, deps = {} } = {}) {
  const { world, mapStates } = await prepareWorld({ now, deps });
  const productPolicies = deps.productPolicies || await loadActivePolicies().catch(() => new Map()); const today = cairoDate(now);
  if (!world.adAccountId) return { items: [], world, note: 'مفيش اتصال Meta' };
  const paused = world.campaigns.filter((c) => c.status === 'PAUSED');
  const w7 = world.windows.last7, w30 = world.windows.last30;
  // only paused campaigns that actually ran in the last 30 days are candidates (hundreds of long-dead paused campaigns are not "candidates")
  const pool = paused.filter((c) => (w30?.get(c.id)?.spend ?? 0) > 0 || (w7?.get(c.id)?.spend ?? 0) > 0);
  const ids = pool.map((c) => c.id);
  const recent = deps.recent || await loadRecentActions({ campaignIds: ids, now, pendingHours: world.config.limits.pendingEvaluationHours });
  const origin = deps.origin || await loadPausedOrigin({ campaignIds: ids, recentByCampaign: recent, now, deps });
  const lastActive = await loadLastActiveDates(ids, deps);
  const structure = deps.structure || await loadBudgetStructureFromSnapshots({ adAccountId: world.adAccountId, campaignIds: ids, now });
  const dataAgeMin = await syncAgeMin(deps);
  const items = []; let heavy = 0;
  // Σ current daily budget of each product's ACTIVE campaigns — computed only when some product policy defines a Daily Spend Cap
  const activeBudgetByAmb = new Map();
  if ([...productPolicies.values()].some((p) => mergeEffective(p).budget.dailySpendCap != null || Object.keys(p.campaigns || {}).length)) {
    const act = world.campaigns.filter((x) => x.status === 'ACTIVE'); const st = deps.activeStructure || await loadBudgetStructureFromSnapshots({ adAccountId: world.adAccountId, campaignIds: act.map((x) => x.id), now });
    for (const ac of act) { const idx = world.prodIndex?.get(ac.id); if (!idx) continue; activeBudgetByAmb.set(idx.ambProductId, (activeBudgetByAmb.get(idx.ambProductId) || 0) + (Number(plannedBudget(st.get(ac.id)).budget) || 0)); }
  }
  for (const c of pool) {
    const ms = mapStates.get(c.id) || { state: 'UNMAPPED' };
    const m7 = slim(w7?.get(c.id)), m30 = slim(w30?.get(c.id)), m3 = slim(world.windows.last3?.get(c.id));
    const cx = deps.ctxFor ? await deps.ctxFor(c) : await buildCampaignContext({ world, campaign: c, recentByCampaign: recent });
    const blocks = [], warnings = [];
    if (ms.state !== 'VERIFIED') blocks.push(ms.state === 'EXTERNAL_STORE' ? 'EXTERNAL_STORE' : `MAPPING_${ms.state}`);
    const exc = exceptionFor(cx, ['NO_AUTOMATION', 'NO_AUTO_OPEN']); if (exc) blocks.push('EXCEPTION_NO_AUTO_OPEN');
    { const sb = policyScheduleBlock({ policy: cx.product?.id != null ? productPolicies.get(policyKey(cx.storeId, cx.product.id)) : null, type: 'OPEN', slotTime, date: today, campaignId: c.id }); if (sb) blocks.push(sb); }
    { const polForCap = cx.product?.id != null ? productPolicies.get(policyKey(cx.storeId, cx.product.id)) : null; const cap = polForCap ? mergeEffective(polForCap, c.id).budget.dailySpendCap : null; if (cap != null) { const have = activeBudgetByAmb.get(cx.product.ambProductId) || 0; const add = Number(plannedBudget(structure.get(c.id)).budget) || 0; if (have + add > cap) blocks.push('PRODUCT_DAILY_CAP'); } } // opening must not push the product above its Daily Spend Cap
    if (cx.recent?.manualOverrideAt && now.getTime() - new Date(cx.recent.manualOverrideAt).getTime() < (cx.policyManualOverrideHours || world.config.limits.manualOverrideCooldownHours || 24) * MS_H) blocks.push('MANUAL_OVERRIDE_COOLDOWN');
    if (!blocks.length && !deps.ctxFor && heavy < 45) { await ensureHeavy(cx); heavy++; }
    if (!blocks.length) {
      if (cx.stock?.status === 'OUT_OF_STOCK') blocks.push('STOCK_OUT');
      else if (!cx.stock || cx.stock.status === 'STOCK_UNKNOWN') warnings.push('STOCK_UNKNOWN');
      if (cx.dq?.gate === 'DECISION_BLOCKED_DATA_QUALITY') blocks.push('DATA_QUALITY_BLOCKED');
      if (cx.econ && !cx.econ.complete) warnings.push('ECONOMICS_INCOMPLETE');
    }
    const po = origin.get(c.id) || { origin: 'UNKNOWN_OLD', at: null };
    const needsSpecial = ['MANUAL', 'UNKNOWN_OLD'].includes(po.origin);
    const rec = openRecommended({ m7, m30 }); const score = openScore({ m7, m30, daysSinceActive: daysBetween(lastActive.get(c.id), now) });
    const risk = openRisk({ m7, m30, stock: cx.stock?.status, warnings });
    const bud = plannedBudget(structure.get(c.id));
    const eligibility = blocks.length ? 'BLOCKED' : needsSpecial ? 'NEEDS_SPECIAL_APPROVAL' : 'ELIGIBLE';
    const cpaRef = cpaReference({ m7, m30 });
    const reason = blocks.length ? `ممنوعة: ${blocks.join(' · ')}` : rec.ok ? `CPA ${round0(cpaRef)} على ${(m30.purchases >= 5 ? m30 : m7).purchases} أوردر (${cpaStability({ m7, m30 }) === 'STABLE' ? 'مستقر بين 7 و30 يوم' : 'عينة كافية'}) — ${po.origin === 'DAILY_SCHEDULE' ? 'اتقفلت بالروتين اليومي' : po.origin === 'SYSTEM' ? 'اتقفلت بقرار السيستم' : 'اتقفلت يدويًا/غير معروف'}` : `مش مرشحة تلقائيًا: ${rec.why}`;
    items.push({
      campaignId: c.id, campaignName: (c.name || '').trim(), productId: cx.product?.id ?? null, productName: cx.product?.name || null, storeId: cx.storeId || null,
      eligibility, selectable: !blocks.length, selected: !blocks.length && !needsSpecial && rec.ok, blockCodes: blocks, warnings, risk: risk.level, riskScore: risk.score, rankScore: score, reason,
      evidence: { status: 'PAUSED', priority: priorityScore({ m3, m7, m30, ageHours: null, dataAgeMin, blocks, warnings }), m3, m7, m30, budget: bud.budget, budgetLevel: bud.level, adsets: bud.adsets ?? null, lastActiveDate: lastActive.get(c.id) || null, daysSinceActive: daysBetween(lastActive.get(c.id), now), pausedBy: po.origin, pausedAt: po.at ? new Date(po.at).toISOString() : null, stability: cpaStability({ m7, m30 }), tier: sampleTier(m30.purchases), recommended: rec.ok, notRecommendedBecause: rec.why, stock: cx.stock ? { status: cx.stock.status, current: cx.stock.currentStock ?? null } : null, mapping: ms.state, advisor: advisorSummary(cx.advisor) },
    });
  }
  // the saved «الفتح حسب CPA» policy (only when ON and complete): it decides the default selection from the policy window of the SAME fresh snapshots; every guard above stays above it
  let openCpa = null;
  { const pol = deps.openCpaPolicy !== undefined ? deps.openCpaPolicy : await getOpenCpaPolicy().catch(() => null);
    if (pol?.enabled && pol.minCpa != null && pol.maxCpa != null) { const metrics = await loadWindowMetrics({ policy: pol, now, adAccountId: world.adAccountId, deps: { metrics: deps.openCpaMetrics } }); const r = applyPolicyToItems({ items, policy: pol, metrics, dataAgeMin }); openCpa = { version: pol.version, approvedVersion: pol.approved?.version ?? null, minCpa: pol.minCpa, maxCpa: pol.maxCpa, window: pol.window, from: pol.from, to: pol.to, minPurchases: pol.minPurchases, maxDataAgeMin: pol.maxDataAgeMin, counts: r.counts }; } }
  items.sort((a, b) => (b.selectable - a.selectable) || b.rankScore - a.rankScore);
  items.forEach((it, i) => { it.rank = i + 1; });
  return { items, world, candidatesPool: pool.length, pausedTotal: paused.length, openCpa };
}

// =====================================================================================================================
// PAUSE candidates (13:00)
// =====================================================================================================================
export async function buildPauseCandidates({ now = new Date(), slotTime = SLOTS.PAUSE, deps = {} } = {}) {
  const { world, mapStates } = await prepareWorld({ now, deps });
  const productPolicies = deps.productPolicies || await loadActivePolicies().catch(() => new Map()); const todayDate = cairoDate(now);
  if (!world.adAccountId) return { items: [], world, note: 'مفيش اتصال Meta' };
  const active = world.campaigns.filter((c) => c.status === 'ACTIVE'); const ids = active.map((c) => c.id);
  const opt = deps.optimizer || await evaluateBudgetOptimization({ now, persist: false, live: false, deps: { world, mappingStates: mapStates } });
  const policy = opt.policy || await getBudgetPolicy();
  const recent = deps.recent || await loadRecentActions({ campaignIds: ids, now, pendingHours: world.config.limits.pendingEvaluationHours });
  const lastChanges = deps.lastChanges || await loadLastBudgetChanges({ entityIds: ids, campaignIds: ids });
  const structure = deps.structure || await loadBudgetStructureFromSnapshots({ adAccountId: world.adAccountId, campaignIds: ids, now });
  const dataAgeMin = await syncAgeMin(deps);
  const items = [];
  for (const c of active) {
    const rows = opt.rows.filter((r) => r.campaignId === c.id);
    const ms = mapStates.get(c.id) || { state: 'UNMAPPED' };
    const today = slim(world.windows.today?.get(c.id)), m3 = slim(world.windows.last3?.get(c.id)), m7 = slim(world.windows.last7?.get(c.id)), m30 = slim(world.windows.last30?.get(c.id));
    const pauseRow = rows.find((r) => r.intended?.action === 'PAUSE') || null; const row = pauseRow || rows[0] || null;
    const zeroLimit = row?.zeroLimit ?? policy.zeroOrders.spend;
    const rk = pauseRisk({ today, m3, m7, m30, zeroLimit });
    const blocks = []; const guards = (pauseRow?.guards || []).filter((g) => /\[B\]/.test(g)).map((g) => g.split('[')[0]);
    if (ms.state !== 'VERIFIED') blocks.push(ms.state === 'EXTERNAL_STORE' ? 'EXTERNAL_STORE' : `MAPPING_${ms.state}`);
    for (const g of guards) if (!blocks.includes(g)) blocks.push(g);
    { const sb = policyScheduleBlock({ policy: row?.productId != null ? productPolicies.get(policyKey(row.storeId, row.productId)) : null, type: 'PAUSE', slotTime, date: todayDate, campaignId: c.id }); if (sb && !blocks.includes(sb)) blocks.push(sb); }
    const excs = exceptionsFor({ exceptions: world.exceptions || [], storeId: row?.storeId || null, productId: row?.productId ?? null, campaignId: c.id, tag: null }); if (excs.some((e) => (e.types || []).some((t) => ['NO_AUTOMATION', 'NO_AUTO_STOP'].includes(t))) && !blocks.includes('EXCEPTION_NO_AUTO_STOP')) blocks.push('EXCEPTION_NO_AUTO_STOP');
    const winner = isWinner({ m7, m30 });
    const lc = rows.map((r) => r.evidence?.lastChange).filter(Boolean).sort((a, b) => new Date(b.at) - new Date(a.at))[0] || lastChanges.get(c.id) || null;
    const lastPurchase = deps.lastPurchase ? await deps.lastPurchase(c.id) : await computeLastPurchaseAt({ campaignId: c.id, now }).catch(() => null);
    const ageH = c.firstSeenAt ? Math.floor((now.getTime() - new Date(c.firstSeenAt).getTime()) / MS_H) : null;
    const bud = plannedBudget(structure.get(c.id));
    const wouldPause = pauseRow?.decision === 'WOULD_PAUSE' && !blocks.length;
    const protectedBy = winner ? 'WINNER' : blocks.length ? 'GUARD' : null;
    const eligibility = blocks.some((b) => b.startsWith('MAPPING_') || b === 'EXTERNAL_STORE') ? 'BLOCKED' : winner || blocks.length ? 'PROTECTED' : 'ELIGIBLE';
    const graceHours = (world.config.limits.attributionGraceHours ?? 6);
    const recentMin = lastPurchase ? Math.round((now.getTime() - new Date(lastPurchase).getTime()) / 60_000) : null;
    const reasonParts = wouldPause ? [`سياسة: صرف ${round0(row?.m3?.spend ?? m3.spend)} بدون أوردرات (حد ${zeroLimit})`] : rk.reasons.slice();
    if (!wouldPause && row?.reason) reasonParts.push(row.reason);
    items.push({
      campaignId: c.id, campaignName: (c.name || '').trim(), productId: row?.productId ?? null, productName: row?.product || null, storeId: row?.storeId || null,
      eligibility, selectable: eligibility !== 'BLOCKED' && !winner && !blocks.length, selected: wouldPause, blockCodes: blocks, warnings: (row?.guards || []).filter((g) => /\[W\]/.test(g)).map((g) => g.split('[')[0]), risk: rk.level, riskScore: rk.score, rankScore: rk.score,
      reason: winner ? '🏆 Winner محمي — أداء قوي وعينة موثوقة' : blocks.length ? `ممنوع/محمي: ${blocks.join(' · ')}` : reasonParts.join(' · ') || 'أداء ضمن الحدود — مفيش سبب سياسة للإيقاف (اختيار يدوي فقط)',
      evidence: { status: 'ACTIVE', priority: priorityScore({ m3, m7, m30, ageHours: ageH, dataAgeMin, blocks, warnings: (row?.guards || []).filter((g) => /[W]/.test(g)).map((g) => g.split('[')[0]) }), today, m3, m7, m30, partialToday: true, budget: row?.entity?.budget ?? bud.budget, budgetLevel: row?.entity ? (row.entity.level === 'campaign' ? 'CBO' : 'ABO') : bud.level, decision: pauseRow?.decision || row?.decision || null, zone: row?.zone || null, rule: pauseRow?.rule || row?.rule || null, optimizerGuards: row?.guards || [], zeroLimit, attributionGraceHours: graceHours, campaignAgeHours: ageH, recentPurchaseMinutesAgo: recentMin, lastBudgetChange: lc ? { at: new Date(lc.at).toISOString(), action: lc.action, from: lc.from ?? null, to: lc.to ?? null, source: lc.source || null } : null, winner, protectedBy, mapping: ms.state, advisor: null, policyPause: wouldPause },
    });
  }
  // advisor view per campaign (the optimizer rows do not carry it): one cheap persisted-plan lookup per product
  const prods = [...new Set(items.map((i) => i.productId).filter((x) => x != null))];
  if (prods.length && !deps.optimizer) {
    const plans = await prisma.ambAdvisorPlanVersion.findMany({ where: { product_id: { in: prods } }, orderBy: { version: 'desc' }, select: { product_id: true, plan_json: true } });
    const seen = new Set();
    for (const p of plans) { if (seen.has(p.product_id)) continue; seen.add(p.product_id); let pj = null; try { pj = JSON.parse(p.plan_json); } catch { /* */ } if (!pj) continue; const adv = { stage: pj.status?.stage, primaryProblem: pj.status?.primaryProblem, scalePlanPresent: !!pj.scalePlan, nextActionNow: (pj.actions?.now || [])[0]?.title || null }; for (const it of items.filter((x) => x.productId === p.product_id)) it.evidence.advisor = advisorSummary(adv); }
  }
  items.sort((a, b) => b.rankScore - a.rankScore || (b.evidence.m3.spend - a.evidence.m3.spend));
  items.forEach((it, i) => { it.rank = i + 1; });
  return { items, world, policy };
}
