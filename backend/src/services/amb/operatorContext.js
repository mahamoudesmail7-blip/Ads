// 🤖 AI Operator — CONTEXT BUILDER (I/O, read-only). 2026-10-03.
// Gathers, per campaign, everything the pure rule engine + guard chain need — from ALREADY-SYNCED data and the existing canonical
// systems (snapshots, AmbProduct economics, Stock Guard, Data Quality + Easy Orders status trust, persisted Smart Advisor plan,
// recent actions). It never calls Meta or Easy Orders and never writes. Sequential awaits only (small shared Prisma pool).
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection } from '../metaAuth.js';
import { getAmbSettings } from './settings.js';
import { entityWindowMetrics } from './metricsEngine.js';
import { getSyncStatus } from './snapshotSync.js';
import { stockGuardForProduct } from './stockGuard.js';
import { computeProductDataQuality } from './dataQuality.js';
import { getStoreStatusTrust } from '../easyOrdersStatus.js';
import { windowRange, WINDOW_KEYS } from './operatorRules.js';
import { computeOperatorEconomics } from './operatorGuards.js';
import { getOperatorConfig, listExceptions, exceptionsFor, loadCampaignTags } from './operatorStore.js';

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const MS_H = 3_600_000;
const ACTION_FROM_AMB = { PAUSE: 'PAUSE', RESUME: 'OPEN', INCREASE_BUDGET: 'SCALE_UP', DECREASE_BUDGET: 'SCALE_DOWN' };

/** Latest known row per campaign (status + budget) from the synced snapshots of the last `days` days. */
export async function listCampaignsFromSnapshots({ adAccountId, days = 60 }) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.metaPerformanceSnapshot.findMany({
    where: { level: 'campaign', ad_account_id: adAccountId, snapshot_at: { gte: since }, campaign_id: { not: null } },
    distinct: ['campaign_id'], orderBy: [{ campaign_id: 'asc' }, { snapshot_at: 'desc' }],
    select: { campaign_id: true, campaign_name: true, campaign_status: true, campaign_budget: true, campaign_budget_type: true, snapshot_at: true },
  });
  const firsts = await prisma.metaPerformanceSnapshot.groupBy({ by: ['campaign_id'], where: { level: 'campaign', ad_account_id: adAccountId, snapshot_at: { gte: since }, campaign_id: { not: null } }, _min: { date_start: true } });
  const firstSeen = new Map(firsts.map((f) => [f.campaign_id, f._min.date_start ? new Date(`${f._min.date_start}T00:00:00Z`) : null]));
  return rows.map((r) => ({ id: r.campaign_id, name: r.campaign_name, status: r.campaign_status || 'UNKNOWN', budget: r.campaign_budget, budgetType: r.campaign_budget_type, lastSeenAt: r.snapshot_at, firstSeenAt: firstSeen.get(r.campaign_id) || null }));
}

/** campaign -> {ambProductId, via, verified}. Explicit MAPPED rows and wizard-launched campaigns are verified; SUGGESTED / naming-only are NOT. */
export async function buildCampaignProductIndex({ adAccountId }) {
  const idx = new Map();
  const maps = await prisma.ambProductCampaignMap.findMany({ where: { ad_account_id: adAccountId }, select: { campaign_id: true, amb_product_id: true, status: true, match_source: true } });
  for (const m of maps) idx.set(m.campaign_id, { ambProductId: m.amb_product_id, via: m.status === 'MAPPED' ? 'EXPLICIT_MAPPING' : 'SUGGESTED', verified: m.status === 'MAPPED' });
  const launched = await prisma.ambLaunchCampaign.findMany({ where: { meta_campaign_id: { not: null }, job: { ad_account_id: adAccountId, product_id: { not: null } } }, select: { meta_campaign_id: true, job: { select: { product_id: true } } } });
  const ambByProduct = new Map((await prisma.ambProduct.findMany({ where: { product_id: { in: [...new Set(launched.map((l) => l.job.product_id))] } }, select: { id: true, product_id: true } })).map((a) => [a.product_id, a.id]));
  for (const l of launched) { if (!idx.has(l.meta_campaign_id) || !idx.get(l.meta_campaign_id).verified) { const amb = ambByProduct.get(l.job.product_id); if (amb) idx.set(l.meta_campaign_id, { ambProductId: amb, via: 'LAUNCH_JOB', verified: true }); } }
  return idx;
}

/** Product facts needed by guards — loaded once per product per run (cache passed in). */
async function loadProductIdentity({ ambProductId, cache }) {
  if (cache.has(ambProductId)) return cache.get(ambProductId);
  const amb = await prisma.ambProduct.findUnique({ where: { id: ambProductId } });
  const facts = { ambProduct: amb, product: null, storeId: null, opCfg: null, econ: null, stock: null, dq: null, advisor: null, heavy: false };
  if (amb?.product_id) {
    facts.product = await prisma.product.findUnique({ where: { id: amb.product_id }, select: { id: true, product_name: true, store_id: true, selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true, current_stock: true, minimum_stock: true } });
    facts.storeId = facts.product?.store_id || null; // null = fail closed (STORE_AMBIGUOUS)
    if (facts.storeId) facts.opCfg = await prisma.ambOperatorProductConfig.findUnique({ where: { product_id_store_id: { product_id: amb.product_id, store_id: facts.storeId } } });
  }
  cache.set(ambProductId, facts);
  return facts;
}
/** Per-product facts for the setup/readiness layer (identity always; stock guard / data quality / advisor when heavy). Shares the 5-minute cache. */
export async function loadProductFacts({ ambProductId, heavy = false, cache = new Map() }) {
  const f = await loadProductIdentity({ ambProductId, cache });
  if (heavy) await loadProductHeavy(f);
  return f;
}
/** Heavy, per-product facts (stock guard, data quality, store status trust, advisor plan) — loaded ONLY when a rule actually needs them. */
const HEAVY_TTL_MS = 5 * 60_000;
const heavyCache = new Map(); // ambProductId -> {at, stock, dq, advisor} — consecutive scheduler ticks must not recompute DQ/stock for every product
export function clearOperatorFactsCache() { heavyCache.clear(); }
async function loadProductHeavy(facts) {
  if (facts.heavy) return facts;
  facts.heavy = true;
  const amb = facts.ambProduct;
  const hit = amb ? heavyCache.get(amb.id) : null;
  if (hit && Date.now() - hit.at < HEAVY_TTL_MS) { facts.stock = hit.stock; facts.dq = hit.dq; facts.advisor = hit.advisor; return facts; }
  if (amb?.product_id && facts.storeId) {
    {
      facts.stock = await stockGuardForProduct({ productId: amb.product_id, storeId: facts.storeId }).catch((e) => { logger.warn('[operatorContext] stock guard failed', { message: e.message }); return null; });
      if (facts.stock && facts.opCfg?.min_stock != null && facts.stock.minimumStock == null) facts.stock.minimumStock = facts.opCfg.min_stock;
      const dq = await computeProductDataQuality({ productId: amb.product_id, storeId: facts.storeId, windowName: 'last7' }).catch(() => null);
      const trust = await getStoreStatusTrust(facts.storeId).catch(() => null);
      facts.dq = dq && dq.ok ? { gate: ['MAPPING_ERROR', 'PURCHASE_RECONCILIATION_ERROR'].includes(dq.overallStatus) ? 'DECISION_BLOCKED_DATA_QUALITY' : 'VERIFIED', overall: dq.overallStatus, statusTrust: trust, mappingStatus: dq.mapping?.status } : { gate: null, overall: null, statusTrust: trust };
      const plan = await prisma.ambAdvisorPlanVersion.findFirst({ where: { product_id: amb.product_id, store_id: facts.storeId }, orderBy: { version: 'desc' }, select: { version: true, plan_json: true, created_at: true } });
      const pj = plan ? j(plan.plan_json, null) : null;
      facts.advisor = pj ? { planVersion: plan.version, stage: pj.status?.stage, primaryProblem: pj.status?.primaryProblem, dqBlocked: !!pj.status?.dataQuality?.blocked, fatigued: !!pj.fatiguePlan, planAt: plan.created_at } : null;
    }
  }
  if (amb) heavyCache.set(amb.id, { at: Date.now(), stock: facts.stock, dq: facts.dq, advisor: facts.advisor });
  return facts;
}

/**
 * Builds the evaluation world: {adAccountId, config, settings, campaigns[], windows{key:Map}, ...}. `windowKeys` = the windows the active rules use
 * (+ `today` for loss/limit counters). Metrics come from entityWindowMetrics (SQL-side reduction over synced snapshots).
 */
export async function buildOperatorWorld({ windowKeys = ['today'], now = new Date(), only = null } = {}) {
  const connection = await getConnection();
  const adAccountId = connection?.selected_ad_account_id || null;
  const config = await getOperatorConfig();
  const settings = await getAmbSettings();
  if (!adAccountId) return { adAccountId: null, config, settings, connected: false, campaigns: [], windows: {} };
  const sync = await getSyncStatus().catch(() => null);
  const intervalMs = (Number(settings.ambSyncIntervalMinutes) || 15) * 60_000;
  const last = sync?.lastSuccessAt ? new Date(sync.lastSuccessAt).getTime() : null;
  const metaStale = last === null || now.getTime() - last > intervalMs * 4;
  let campaigns = await listCampaignsFromSnapshots({ adAccountId });
  if (only?.campaignIds?.length) campaigns = campaigns.filter((c) => only.campaignIds.includes(c.id));
  const wanted = [...new Set([...windowKeys.filter((k) => WINDOW_KEYS.includes(k)), 'today'])];
  const windows = {};
  for (const k of wanted) { const r = windowRange(k, now.toISOString().slice(0, 10)); windows[k] = await entityWindowMetrics({ level: 'campaign', from: r.from, to: r.to, adAccountId }); }
  const prodIndex = await buildCampaignProductIndex({ adAccountId });
  const tags = await loadCampaignTags(adAccountId);
  const exceptions = await listExceptions({ now });
  return { adAccountId, config, settings, connected: connection?.status === 'CONNECTED', metaStale, metaLastSyncAt: sync?.lastSuccessAt || null, campaigns, windows, prodIndex, tags, exceptions, factsCache: new Map(), now };
}

/** Recent EXECUTED actions per campaign (Operator decisions AND every other AMB action, so manual/legacy actions respect cooldowns too). */
export async function loadRecentActions({ campaignIds, now = new Date(), days = 7, pendingHours = 24 }) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const out = new Map();
  const bump = (cid, action, at) => { const e = out.get(cid) || { lastByAction: {}, todayCount: 0, harmfulScaleAt: null }; if (!e.lastByAction[action] || new Date(at) > new Date(e.lastByAction[action])) e.lastByAction[action] = at; if (now.getTime() - new Date(at).getTime() < 24 * MS_H) e.todayCount++; out.set(cid, e); return e; };
  const ds = await prisma.ambOperatorDecision.findMany({ where: { campaign_id: { in: campaignIds }, status: { in: ['EXECUTING', 'EXECUTED', 'VERIFIED'] }, executed_at: { gte: since } }, select: { campaign_id: true, action: true, executed_at: true, outcome_json: true } });
  for (const d of ds) { const e = bump(d.campaign_id, d.action, d.executed_at); if (d.action === 'SCALE_UP' && /"verdict":"(HARMFUL|FAILED)"/.test(d.outcome_json || '') && (!e.harmfulScaleAt || d.executed_at > e.harmfulScaleAt)) e.harmfulScaleAt = d.executed_at; }
  const acts = await prisma.ambAction.findMany({ where: { entity_id: { in: campaignIds }, execution_status: 'EXECUTED', executed_at: { gte: since } }, select: { entity_id: true, action_type: true, executed_at: true } });
  for (const a of acts) { const act = ACTION_FROM_AMB[a.action_type]; if (act) bump(a.entity_id, act, a.executed_at); }
  const entry = (cid) => out.get(cid) || (out.set(cid, { lastByAction: {}, todayCount: 0, harmfulScaleAt: null }), out.get(cid));
  // an executed OPEN / SCALE_UP whose effect has not been measured yet blocks another risky action (RECENT_ACTION_PENDING_EVALUATION)
  const pendH = Number(pendingHours) || 24;
  for (const d of ds) if (['OPEN', 'SCALE_UP'].includes(d.action) && !d.outcome_json && now.getTime() - new Date(d.executed_at).getTime() < pendH * MS_H) { const e = entry(d.campaign_id); if (!e.pendingEvaluationAt || d.executed_at > e.pendingEvaluationAt) e.pendingEvaluationAt = d.executed_at; }
  // was the campaign paused by US (Operator / AMB executor)? Only then is the owner's stop-intent known (spec 69)
  const since30 = new Date(now.getTime() - 30 * 86_400_000);
  const p1 = await prisma.ambOperatorDecision.findMany({ where: { campaign_id: { in: campaignIds }, action: 'PAUSE', status: { in: ['EXECUTED', 'VERIFIED'] }, executed_at: { gte: since30 } }, select: { campaign_id: true, executed_at: true } });
  const p2 = await prisma.ambAction.findMany({ where: { entity_id: { in: campaignIds }, action_type: 'PAUSE', execution_status: 'EXECUTED', executed_at: { gte: since30 } }, select: { entity_id: true, executed_at: true } });
  for (const r of p1) { const e = entry(r.campaign_id); if (!e.pausedBySystemAt || r.executed_at > e.pausedBySystemAt) e.pausedBySystemAt = r.executed_at; }
  for (const r of p2) { const e = entry(r.entity_id); if (!e.pausedBySystemAt || r.executed_at > e.pausedBySystemAt) e.pausedBySystemAt = r.executed_at; }
  // manual override detected by the scheduler (spec 86)
  const mo = await prisma.ambOperatorEvent.findMany({ where: { kind: 'MANUAL_OVERRIDE', campaign_id: { in: campaignIds }, created_at: { gte: since30 } }, select: { campaign_id: true, created_at: true } });
  for (const r of mo) { const e = entry(r.campaign_id); if (!e.manualOverrideAt || r.created_at > e.manualOverrideAt) e.manualOverrideAt = r.created_at; }
  return out;
}

/** Global counters for the rate limits + loss limits (today). */
export async function loadCounters({ now = new Date(), campaigns = [] }) {
  const hourAgo = new Date(now.getTime() - MS_H), dayAgo = new Date(now.getTime() - 24 * MS_H), weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const done = ['EXECUTING', 'EXECUTED', 'VERIFIED'];
  const h = await prisma.ambOperatorDecision.count({ where: { status: { in: done }, executed_at: { gte: hourAgo } } });
  const today = await prisma.ambOperatorDecision.findMany({ where: { status: { in: done }, executed_at: { gte: dayAgo } }, select: { action: true, store_id: true, params_json: true } });
  const byAction = {}, byStoreAction = {}, budgetIncreaseByStore = {}; let budgetIncreaseToday = 0;
  for (const d of today) {
    byAction[d.action] = (byAction[d.action] || 0) + 1;
    (byStoreAction[d.store_id] = byStoreAction[d.store_id] || {})[d.action] = ((byStoreAction[d.store_id] || {})[d.action] || 0) + 1;
    if (d.action === 'SCALE_UP') { const pr = j(d.params_json, {}); const inc = Math.max(0, (pr.toBudget ?? 0) - (pr.fromBudget ?? 0)); budgetIncreaseToday += inc; budgetIncreaseByStore[d.store_id] = (budgetIncreaseByStore[d.store_id] || 0) + inc; }
  }
  // budget currently under AI control = ACTIVE campaigns the Operator opened/scaled in the last 7 days (sum of their current daily budgets)
  const touched = await prisma.ambOperatorDecision.findMany({ where: { action: { in: ['OPEN', 'SCALE_UP'] }, status: { in: ['EXECUTED', 'VERIFIED'] }, executed_at: { gte: weekAgo } }, select: { campaign_id: true, store_id: true }, distinct: ['campaign_id'] });
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  let aiBudget = 0; const aiBudgetByStore = {};
  for (const t of touched) { const c = byId.get(t.campaign_id); if (c && c.status === 'ACTIVE' && c.budget) { aiBudget += c.budget; aiBudgetByStore[t.store_id] = (aiBudgetByStore[t.store_id] || 0) + c.budget; } }
  return { actionsLastHour: h, actionsToday: today.length, byAction, byStoreAction, budgetIncreaseToday, budgetIncreaseByStore, aiBudget, aiBudgetByStore };
}

/** Everything the guards + rules need for ONE campaign. Pure given `world` (no extra I/O except per-product facts, cached). */
export async function buildCampaignContext({ world, campaign, recentByCampaign, observedCache = new Map() }) {
  const { settings, config, now } = world;
  const idx = world.prodIndex.get(campaign.id) || null;
  const facts = idx ? await loadProductIdentity({ ambProductId: idx.ambProductId, cache: world.factsCache }) : null;
  const tagRow = world.tags.get(campaign.id) || null;
  const todayM = world.windows.today?.get(campaign.id) || null;
  const productId = facts?.ambProduct?.product_id ?? null;
  const storeId = facts?.storeId || null;
  const excs = exceptionsFor({ exceptions: world.exceptions, storeId, productId, campaignId: campaign.id, tag: tagRow?.tag });
  const recent = recentByCampaign.get(campaign.id) || { lastByAction: {}, todayCount: 0, harmfulScaleAt: null };
  return {
    storeId, adAccountId: world.adAccountId, metaConnected: world.connected, metaStale: world.metaStale,
    campaign: { ...campaign, tag: tagRow?.tag || null, testing: tagRow?.testing || null },
    product: facts?.ambProduct ? { id: productId, ambProductId: facts.ambProduct.id, name: facts.ambProduct.product_name, productKey: facts.opCfg?.product_key || null, automationMode: facts.opCfg?.automation_mode || null, maxScalePct: facts.opCfg?.max_scale_pct ?? null, testingAllowance: facts.opCfg?.testing_spend_allowance ?? null, testingMinSample: facts.opCfg?.testing_min_sample ?? null, mappingVerified: !!idx?.verified, mappingSource: idx?.via || 'NONE' } : { mappingVerified: false, mappingSource: idx?.via || 'NONE' },
    metrics: todayM || {}, econ: { complete: false, profitState: 'UNKNOWN' }, stock: null, dq: null, advisor: null, exceptions: excs, recent, incidents: [], velocity: null, ruleConflicts: [],
    config, _facts: facts, _world: world, heavyLoaded: false,
  };
}

/** Lazily fills econ / stock / dq / advisor on a campaign context (idempotent, cached per product). */
export async function ensureHeavy(ctx) {
  if (ctx.heavyLoaded || !ctx._facts) { ctx.heavyLoaded = true; return ctx; }
  const facts = await loadProductHeavy(ctx._facts);
  const w = ctx._world;
  const observedCpa = (w.windows.last14?.get(ctx.campaign.id)?.cpa ?? w.windows.last7?.get(ctx.campaign.id)?.cpa ?? w.windows.today?.get(ctx.campaign.id)?.cpa) ?? null;
  ctx.econ = facts.ambProduct ? computeOperatorEconomics({ product: facts.product, ambProduct: facts.ambProduct, opCfg: facts.opCfg, observedCpa }) : { complete: false, profitState: 'UNKNOWN' };
  ctx.stock = facts.stock ? { ...facts.stock, daysRemaining: facts.stock.daysRemaining ?? null } : null;
  ctx.dq = facts.dq || null; ctx.advisor = facts.advisor || null; ctx.heavyLoaded = true;
  return ctx;
}

/** Which rule fields can only be answered with the heavy per-product facts. */
export const HEAVY_FIELDS = new Set(['stock', 'days_of_stock', 'margin_pct', 'target_cpa', 'max_cpa', 'hard_stop_cpa', 'profit_state', 'data_quality']);

/** Flat field values for rule evaluation over one window (null = unknown, never zero). */
export function fieldsForRule({ ctx, windowMetrics }) {
  const m = windowMetrics || {};
  const e = ctx.econ || {};
  const dqState = !ctx.dq || !ctx.dq.gate ? 'UNKNOWN' : ctx.dq.gate === 'DECISION_BLOCKED_DATA_QUALITY' ? 'BLOCKED' : (ctx.dq.overall === 'RECONCILED' ? 'VERIFIED' : 'WARNING');
  const heavy = !!ctx.heavyLoaded; // product-level facts are UNKNOWN (null) until actually loaded — never defaulted
  return {
    spend: m.spend ?? null, purchases: m.purchases ?? null, cpa: m.cpa ?? null, ctr: m.ctr ?? null, cvr: m.conversionRate ?? null, cpc: m.cpc ?? null, cpm: m.cpm ?? null, roas: m.roas ?? null, frequency: m.frequency ?? null,
    stock: heavy ? (ctx.stock?.currentStock ?? null) : null, days_of_stock: heavy ? (ctx.stock?.daysRemaining ?? null) : null, margin_pct: heavy ? (e.marginPct ?? null) : null,
    target_cpa: heavy ? (e.targetCpa ?? null) : null, max_cpa: heavy ? (e.maxCpa ?? null) : null, hard_stop_cpa: heavy ? (e.hardStopCpa ?? null) : null,
    profit_state: heavy ? (e.profitState && e.profitState !== 'UNKNOWN' && e.profitState !== 'INSUFFICIENT_DATA' ? e.profitState : null) : null, data_quality: heavy ? (dqState === 'UNKNOWN' ? null : dqState) : null, campaign_status: ctx.campaign?.status || 'UNKNOWN', campaign_tag: ctx.campaign?.tag || null, campaign_age_hours: ctx.campaign?.firstSeenAt ? Math.floor((Date.now() - new Date(ctx.campaign.firstSeenAt).getTime()) / MS_H) : null,
  };
}

/** Spend-velocity (spec 56/94 runaway protection): spend in the last ~hour with NO purchases. null = unknown (never "abnormal"). Reads synced snapshots only. */
export async function computeVelocity({ campaignId, now = new Date(), cfg = { windowHours: 1, minSpend: 100, requireNoResult: true } }) {
  const day = now.toISOString().slice(0, 10);
  const rows = await prisma.metaPerformanceSnapshot.findMany({ where: { level: 'campaign', campaign_id: campaignId, date_start: day, snapshot_at: { gte: new Date(now.getTime() - 3 * MS_H) } }, orderBy: { snapshot_at: 'asc' }, select: { snapshot_at: true, spend: true, meta_purchases: true } });
  if (rows.length < 2) return null;
  const last = rows[rows.length - 1];
  const target = new Date(last.snapshot_at.getTime() - (Number(cfg.windowHours) || 1) * MS_H);
  const base = [...rows].reverse().find((r) => r.snapshot_at <= new Date(target.getTime() + 15 * 60_000)) || null;
  if (!base || last.spend == null || base.spend == null) return null;
  const hours = (last.snapshot_at.getTime() - base.snapshot_at.getTime()) / MS_H;
  if (hours < 0.5) return null;
  const spendDelta = (last.spend - base.spend) / hours * (Number(cfg.windowHours) || 1);
  const purchasesDelta = (last.meta_purchases ?? 0) - (base.meta_purchases ?? 0);
  return { spendPerWindow: Math.round(spendDelta * 10) / 10, purchasesDelta, hours: Math.round(hours * 100) / 100, abnormal: spendDelta >= (Number(cfg.minSpend) || 100) && (cfg.requireNoResult ? purchasesDelta <= 0 : true) };
}
