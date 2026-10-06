// 🤖 AI Operator — END-TO-END INTEGRATION AUDIT + COMPLETION CENTER + safe AUTO-FIX. 2026-10-03.
//
//   STORE → PRODUCT MASTER → URL/KEY → EASY ORDERS → INVENTORY → ECONOMICS → CAMPAIGN → AD SET → AD → CREATIVE → LIVE PERFORMANCE → DATA QUALITY →
//   SMART ADVISOR (diagnosis + Testing Brain + Growth + Playbook + Learning) → AI OPERATOR → RULES + GUARDS → APPROVAL/AUTOPILOT → META EXECUTION →
//   VERIFICATION → RESULT → LEARNING → NEXT PLAN
//
// This module owns NO business data. It READS every existing source (catalogue, AmbProduct, inventory, Easy Orders, snapshots, media library, Advisor
// plans, PMC) and reports, link by link, whether the real production workflow is connected:
//   CONNECTED   real data flows through this link today
//   BLOCKED     connected in code but deliberately/necessarily stopped (e.g. Meta writes locked, Data Quality gate)
//   MISSING     the data/link does not exist
//   UNVERIFIED  exists but has never been proven in production (no real execution yet)
// Every missing dependency is classified:
//   AUTO_FIXABLE                  the system can close it itself, safely (e.g. compute the Advisor plan, persist STRONG mapping suggestions)
//   NEEDS_USER_VALUE              a number only the owner knows (purchase cost, stock, Target CPA …) — NEVER fabricated
//   NEEDS_EXTERNAL_CONFIGURATION  outside the app (Railway webhook secrets, a live inventory feed …)
//   NEEDS_REVIEW                  a human decision between evidence (ambiguous mapping, price conflict …)
// Code existing is never counted as "complete".
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { readinessList, mappingCenter, persistDeterministicSuggestions } from './operatorReadiness.js';
import { getOperatorConfig, listRules, autopilotGate, metaWritesLocked, ownerPriceOf } from './operatorStore.js';
import { resolveSellingPrice, loadStoreCatalogIndex, clearStoreCatalogCache } from './productPriceResolver.js';
import { evaluateGuards, BLOCK_CODES } from './operatorGuards.js';
import { validateRule } from './operatorRules.js';
import { loadProductFacts } from './operatorContext.js';
import { getAmbSettings } from './settings.js';
import { getSyncStatus } from './snapshotSync.js';
import { getConnection } from '../metaAuth.js';
import { listStores, getStoreWebhookSecretEntries, storeWebhookSecretEnvNames } from '../easyOrdersStores.js';
import { getStoreStatusTrust } from '../easyOrdersStatus.js';
import { inventoryStateMap, effectiveStock } from './inventoryApi.js';
import { runAdvisorForProduct } from './advisorTracking.js';

export const RES = { AUTO_FIXABLE: 'AUTO_FIXABLE', NEEDS_USER_VALUE: 'NEEDS_USER_VALUE', NEEDS_EXTERNAL: 'NEEDS_EXTERNAL_CONFIGURATION', NEEDS_REVIEW: 'NEEDS_REVIEW', NONE: 'NONE' };
export const ST = { CONNECTED: 'CONNECTED', BLOCKED: 'BLOCKED', MISSING: 'MISSING', UNVERIFIED: 'UNVERIFIED' };
const MS_D = 86_400_000;
const pos = (v) => { const n = Number(v); return v != null && Number.isFinite(n) && n > 0 ? n : null; };
const dep = (key, label, state, resolution, detail, extra = {}) => ({ key, label, state, resolution, detail, ...extra });

// =====================================================================================================================
// Guard-chain self-check (pure): proves Rule → Guard is wired and still strict. No DB.
// =====================================================================================================================
export function guardSelfCheck() {
  const cfg = { mode: 'AUTOPILOT', emergency_stop: false, writesLocked: false, limits: { maxActionsPerHour: 6, maxActionsPerDay: 30, minDaysCover: 7, maxChangesPerCampaignPerDay: 2, lossLimits: {}, account: {} }, cooldowns: {}, schedule: { mode: 'ALWAYS' }, storeLimits: {} };
  const set = { ambMinSpendBeforeDecision: 150, ambMinPurchasesBeforeScaling: 5, ambAllowAutoPause: true, ambAllowAutoOpen: true, ambAllowAutoScale: true, ambAllowAutoBudgetIncrease: true, ambAllowAutoBudgetDecrease: true, ambMaxBudgetIncreasePct: 20, ambMaxAutoExecutionAmount: 500 };
  const now = new Date();
  const ctx = (o = {}) => ({ storeId: 's', campaign: { id: 'c', status: 'ACTIVE', budget: 500, firstSeenAt: new Date(now.getTime() - 200 * 3_600_000).toISOString() }, metrics: { spend: 600, purchases: 10 }, product: { id: 1, mappingVerified: true }, dq: { gate: 'OK', overall: 'RECONCILED', statusTrust: { state: 'OK' } }, stock: { status: 'SAFE', currentStock: 100, daysRemaining: 30 }, econ: { complete: true, profitState: 'PROFITABLE', hardStopCpa: 200 }, exceptions: [], recent: { lastByAction: {}, pausedBySystemAt: now.toISOString() }, metaConnected: true, metaStale: false, incidents: [], advisor: { scalePlanPresent: true, stage: 'SCALING' }, ...o });
  const dec = (o = {}) => ({ action: 'PAUSE', params: {}, ruleMode: 'AUTOPILOT', confidence: 'HIGH', needs: {}, ruleMinSpend: 150, cooldownHours: 12, ...o });
  const run = (d, c, conf = cfg) => evaluateGuards({ decision: d, ctx: c, config: conf, settings: set, counters: {}, now });
  const has = (g, code) => g.blocks.some((b) => b.code === code && b.severity === 'BLOCK');
  const scale = { action: 'SCALE_UP', params: { pct: 10, fromBudget: 500, toBudget: 550 }, needs: { profit: true, stock: true } };
  const baseline = run(dec(), ctx());
  const checks = [
    // positive control: the checks below are only meaningful if a fully healthy context is NOT blocked by default
    ['Healthy baseline is not blocked (control)', baseline.blocks.filter((b) => b.severity === 'BLOCK').length === 0],
    ['Emergency Stop overrides everything', has(run(dec(), ctx(), { ...cfg, emergency_stop: true }), 'EMERGENCY_STOP')],
    ['Meta write lock blocks execution', has(run(dec(), ctx(), { ...cfg, writesLocked: true }), 'META_WRITES_LOCKED')],
    ['Unknown stock blocks open/scale', has(run(dec({ action: 'OPEN', needs: { stock: true, profit: true } }), ctx({ campaign: { id: 'c', status: 'PAUSED', budget: 1 }, stock: { status: 'STOCK_UNKNOWN' } })), 'STOCK_UNKNOWN')],
    ['Missing economics blocks scale', has(run(dec(scale), ctx({ econ: { complete: false, profitState: 'UNKNOWN' } })), 'ECONOMICS_INCOMPLETE')],
    ['Price conflict blocks profit-dependent actions', has(run(dec(scale), ctx({ econ: { complete: false, priceStatus: 'CONFLICT', priceConflict: { a: 1 } } })), 'PRICE_CONFLICT')],
    ['Data-quality gate blocks', has(run(dec({ action: 'OPEN', needs: {} }), ctx({ campaign: { id: 'c', status: 'PAUSED', budget: 1 }, dq: { gate: 'DECISION_BLOCKED_DATA_QUALITY' } })), 'DATA_QUALITY_BLOCKED')],
    ['COD-dependent decision blocked while statuses untrusted', has(run(dec({ usesCod: true }), ctx({ dq: { gate: 'OK', overall: 'RECONCILED', statusTrust: { state: 'NO_STATUS_SIGNAL' } } })), 'COD_UNRELIABLE')],
    ['Scale without an Advisor plan is blocked (one strategy)', has(run(dec(scale), ctx({ advisor: null })), 'ADVISOR_PLAN_MISSING')],
    ['Exception always wins', has(run(dec(), ctx({ exceptions: [{ id: 1, types: ['NO_AUTO_STOP'] }] })), 'EXCEPTION_NO_AUTO_STOP')],
    ['Testing campaigns protected', has(run(dec(), ctx({ campaign: { id: 'c', status: 'ACTIVE', budget: 1, tag: 'TESTING', firstSeenAt: new Date(now.getTime() - 99 * 3_600_000).toISOString() } })), 'TESTING_PROTECTED')],
    ['Cooldown blocks repeats', has(run(dec(), ctx({ recent: { lastByAction: { PAUSE: new Date(now.getTime() - 3_600_000).toISOString() }, pausedBySystemAt: now.toISOString() } })), 'COOLDOWN_ACTIVE')],
    ['Attribution grace blocks premature pause', has(run(dec(), ctx({ campaign: { id: 'c', status: 'ACTIVE', budget: 1, firstSeenAt: new Date(now.getTime() - 2 * 3_600_000).toISOString() } })), 'ATTRIBUTION_GRACE')],
    ['Daily loss limit freezes risky actions', has(run(dec({ action: 'OPEN', needs: {} }), ctx({ campaign: { id: 'c', status: 'PAUSED', budget: 1 } }), { ...cfg, limits: { ...cfg.limits, lossLimits: { account: 100 } } }) && evaluateGuards({ decision: dec({ action: 'OPEN', needs: {} }), ctx: ctx({ campaign: { id: 'c', status: 'PAUSED', budget: 1 } }), config: { ...cfg, limits: { ...cfg.limits, lossLimits: { account: 100 } } }, settings: set, counters: { loss: { account: 500 } }, now }), 'DAILY_LOSS_LIMIT')],
    ['Account limits apply', has(evaluateGuards({ decision: dec(), ctx: ctx(), config: { ...cfg, limits: { ...cfg.limits, account: { maxPausesPerDay: 1 } } }, settings: set, counters: { byAction: { PAUSE: 1 } }, now }), 'ACCOUNT_DAILY_LIMIT')],
    ['Autopilot needs allowed action + HIGH confidence', run(dec({ confidence: 'MEDIUM' }), ctx()).canAutoExecute === false],
  ];
  return checks.map(([name, ok]) => ({ name, ok: !!ok }));
}

// =====================================================================================================================
// The audit
// =====================================================================================================================
export async function buildIntegrationAudit({ heavy = false, now = new Date() } = {}) {
  const t0 = Date.now(); const timings = {}; const lap = (k) => { timings[k] = Date.now() - t0; };
  const conn = await getConnection();
  const adAccountId = conn?.status === 'CONNECTED' ? conn.selected_ad_account_id || null : null;
  const [cfg, settings, rules, list] = await Promise.all([getOperatorConfig(), getAmbSettings(), listRules(), readinessList({ heavy })]);
  const ambIds = list.map((p) => p.ambId ?? p.ambProductId);
  const productIds = list.map((p) => p.productId); lap('readinessList');

  // ---- batched reads (no per-product N+1)
  const products = new Map((await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, product_name: true, store_id: true, selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true, current_stock: true, minimum_stock: true, product_code: true, sku: true } })).map((p) => [p.id, p]));
  const ambs = new Map((await prisma.ambProduct.findMany({ where: { id: { in: ambIds } } })).map((a) => [a.id, a]));
  const snapRows = await prisma.inventorySnapshot.findMany({ where: { product_id: { in: productIds }, OR: [{ source: null }, { NOT: { source: { startsWith: 'INVENTORY_API' } } }] }, // API rows are judged by inventoryApi (approval + freshness), not as a generic snapshot
     orderBy: [{ product_id: 'asc' }, { date: 'desc' }], select: { product_id: true, date: true, closing_stock: true } });
  const latestSnap = new Map(); for (const r of snapRows) if (!latestSnap.has(r.product_id)) latestSnap.set(r.product_id, r);
  const snapshotsTotal = await prisma.inventorySnapshot.count();
  const since30 = new Date(now.getTime() - 30 * MS_D).toISOString().slice(0, 10);
  const orders30 = new Map((await prisma.easyOrdersOrder.groupBy({ by: ['product_id'], where: { product_id: { in: productIds }, date: { gte: since30 } }, _count: { _all: true } })).map((g) => [g.product_id, g._count._all]));
  const maps = await prisma.ambProductCampaignMap.findMany({ where: { amb_product_id: { in: ambIds }, ad_account_id: adAccountId || undefined }, select: { amb_product_id: true, campaign_id: true, status: true } });
  const launched = adAccountId ? await prisma.ambLaunchCampaign.findMany({ where: { meta_campaign_id: { not: null }, job: { ad_account_id: adAccountId, product_id: { in: productIds } } }, select: { meta_campaign_id: true, job: { select: { product_id: true } } } }) : [];
  const campsByAmb = new Map();
  for (const m of maps.filter((x) => x.status === 'MAPPED')) (campsByAmb.get(m.amb_product_id) || campsByAmb.set(m.amb_product_id, new Set()).get(m.amb_product_id)).add(m.campaign_id);
  const ambByProductId = new Map([...ambs.values()].filter((a) => a.product_id).map((a) => [a.product_id, a.id]));
  for (const l of launched) { const aid = ambByProductId.get(l.job.product_id); if (aid) (campsByAmb.get(aid) || campsByAmb.set(aid, new Set()).get(aid)).add(l.meta_campaign_id); }
  const allCampIds = [...new Set([...campsByAmb.values()].flatMap((s) => [...s]))];
  // groupBy (DB-side) — `distinct` would pull every snapshot row of 30 days into memory
  const adsetRows = allCampIds.length ? await prisma.metaPerformanceSnapshot.groupBy({ by: ['campaign_id', 'level'], where: { ad_account_id: adAccountId || undefined, level: { in: ['adset', 'ad'] }, campaign_id: { in: allCampIds }, date_start: { gte: since30 } } }) : [];
  const hasAdset = new Set(adsetRows.filter((r) => r.level === 'adset').map((r) => r.campaign_id)), hasAd = new Set(adsetRows.filter((r) => r.level === 'ad').map((r) => r.campaign_id));
  const creativeRows = allCampIds.length ? await prisma.metaPerformanceSnapshot.groupBy({ by: ['campaign_id', 'creative_id'], where: { ad_account_id: adAccountId || undefined, level: 'ad', campaign_id: { in: allCampIds }, creative_id: { not: null }, date_start: { gte: since30 } } }) : [];
  const creativeIds = [...new Set(creativeRows.map((r) => r.creative_id))];
  const refRows = creativeIds.length ? await prisma.mediaLibraryCreativeRef.findMany({ where: { creative_id: { in: creativeIds } }, select: { creative_id: true } }) : [];
  const refSet = new Set(refRows.map((r) => r.creative_id));
  const planRows = await prisma.ambAdvisorPlanVersion.findMany({ where: { product_id: { in: productIds } }, orderBy: [{ product_id: 'asc' }, { version: 'desc' }], select: { product_id: true, store_id: true, version: true, created_at: true } });
  const latestPlan = new Map(); for (const r of planRows) if (!latestPlan.has(r.product_id)) latestPlan.set(r.product_id, r);
  const profiles = await prisma.productMarketingProfile.findMany({ where: { product_id: { in: productIds } }, select: { id: true, product_id: true } });
  const profBy = new Map(profiles.map((p) => [p.product_id, p.id]));
  const tests = profiles.length ? await prisma.productMarketingTest.groupBy({ by: ['profile_id'], where: { profile_id: { in: profiles.map((p) => p.id) } }, _count: { _all: true } }) : [];
  const learn = profiles.length ? await prisma.productMarketingLearning.groupBy({ by: ['profile_id'], where: { profile_id: { in: profiles.map((p) => p.id) } }, _count: { _all: true } }) : [];
  const testsBy = new Map(tests.map((t) => [t.profile_id, t._count._all])), learnBy = new Map(learn.map((t) => [t.profile_id, t._count._all]));
  const advisorRecs = await prisma.ambAdvisorRecommendation.groupBy({ by: ['product_id'], where: { product_id: { in: productIds } }, _count: { _all: true } });
  const advisorRecBy = new Map(advisorRecs.map((r) => [r.product_id, r._count._all]));

  // ---- store catalogues (cached 1h) for price cross-check
  const stores = [...new Set([...products.values()].map((p) => p.store_id).filter(Boolean))];
  lap('batchedReads');
  const catalogs = {}; for (const s of stores) catalogs[s] = await loadStoreCatalogIndex(s);
  lap('storeCatalogs');

  // ---- mapping center (evidence resolver)
  const mc = adAccountId ? await mappingCenter({ adAccountId }) : null;
  const suggestionByProduct = new Map(); const reviewByProduct = new Map();
  for (const r of mc?.rows || []) { if (r.suggestion && r.state !== 'VERIFIED') suggestionByProduct.set(r.suggestion.ambProductId, (suggestionByProduct.get(r.suggestion.ambProductId) || 0) + 1); }

  lap('mappingCenter');
  const invMapAudit = await inventoryStateMap(productIds);
  const globalInventoryFeed = snapshotsTotal > 0 || [...products.values()].some((p) => p.current_stock != null) || [...invMapAudit.values()].some((v) => v.state !== 'UNKNOWN');

  // ---- per product
  const out = [];
  for (const row of list) {
    const ambId = row.ambId ?? row.ambProductId; const amb = ambs.get(ambId); const p = products.get(row.productId);
    const price = resolveSellingPrice({ product: p, ambProduct: amb, storeCatalog: catalogs[p.store_id] || null, ownerConfirmed: ownerPriceOf(cfg, p.id) });
    const deps = [];
    // store -> product
    deps.push(dep('STORE', 'المتجر ← المنتج', p.store_id ? ST.CONNECTED : ST.MISSING, p.store_id ? RES.NONE : RES.NEEDS_REVIEW, p.store_id ? `المتجر: ${p.store_id}` : 'المنتج بلا متجر — fail-closed'));
    // economics
    deps.push(price.status === 'CONFLICT' ? dep('PRICE', 'سعر البيع', ST.BLOCKED, RES.NEEDS_REVIEW, price.reason, { conflict: price.conflict }) : price.value != null ? dep('PRICE', 'سعر البيع', ST.CONNECTED, RES.NONE, `${price.value} ج.م — ${price.source}${price.status === 'FROM_STORE_CATALOG' ? ' (كتالوج المتجر)' : ''}`, { value: price.value, source: price.source }) : dep('PRICE', 'سعر البيع', ST.MISSING, price.sources.storeCatalogMatches > 1 ? RES.NEEDS_REVIEW : RES.NEEDS_USER_VALUE, price.reason || 'لا يوجد سعر'));
    const cost = pos(amb?.product_cost) ?? pos(p.product_cost);
    deps.push(cost != null ? dep('COST', 'تكلفة الشراء', ST.CONNECTED, RES.NONE, `${cost} ج.م`, { value: cost }) : dep('COST', 'تكلفة الشراء', ST.MISSING, RES.NEEDS_USER_VALUE, 'NEEDS_USER_VALUE: Purchase Cost — مش موجودة في أي مصدر'));
    for (const [k, label, a, c] of [['SHIPPING', 'الشحن', amb?.shipping_cost, p.shipping_cost], ['PACKAGING', 'التغليف', amb?.packaging_cost, p.packaging_cost], ['OTHER_COST', 'تكاليف أخرى', amb?.other_cost, p.other_cost]]) { const v = pos(a) ?? pos(c); deps.push(v != null ? dep(k, label, ST.CONNECTED, RES.NONE, `${v} ج.م`, { value: v }) : dep(k, label, ST.MISSING, RES.NEEDS_USER_VALUE, `NEEDS_USER_VALUE: ${label} (أو أكّد إنها صفر)`, { soft: true })); }
    const tgt = amb?.target_cpa ?? row.targetCpa ?? null;
    deps.push(tgt != null ? dep('TARGET_CPA', 'Target CPA', ST.CONNECTED, RES.NONE, `${tgt}`) : dep('TARGET_CPA', 'Target CPA', ST.MISSING, RES.NEEDS_USER_VALUE, 'NEEDS_USER_VALUE: Target CPA (الـ CPA التاريخي مرجع منفصل ومش بيتحوّل لـTarget)'));
    deps.push(amb?.max_cpa != null ? dep('MAX_CPA', 'Max CPA', ST.CONNECTED, RES.NONE, `${amb.max_cpa}`) : dep('MAX_CPA', 'Max CPA', ST.MISSING, RES.NEEDS_USER_VALUE, 'NEEDS_USER_VALUE: Max CPA', { soft: true }));
    deps.push(row.hardStop != null ? dep('HARD_STOP', 'Hard Stop CPA', ST.CONNECTED, RES.NONE, `${row.hardStop}`) : dep('HARD_STOP', 'Hard Stop CPA', ST.MISSING, RES.NEEDS_USER_VALUE, 'NEEDS_USER_VALUE: Hard Stop CPA'));
    deps.push(pos(amb?.min_profit) != null ? dep('MIN_PROFIT', 'أدنى ربح', ST.CONNECTED, RES.NONE, `${amb.min_profit}`) : dep('MIN_PROFIT', 'أدنى ربح', ST.MISSING, RES.NEEDS_USER_VALUE, 'NEEDS_USER_VALUE: Minimum Profit', { soft: true }));
    // zero-order
    const zo = (cfg.limits.productOverrides || {})[String(p.id)]?.zeroOrder;
    deps.push(zo ? dep('ZERO_ORDER', 'حد الإيقاف بدون أوردرات', ST.CONNECTED, RES.NONE, zo.mode === 'FIXED_SPEND' ? `ثابت ${zo.fixedSpend} ج.م` : `Target CPA × ${zo.multiple}`) : dep('ZERO_ORDER', 'حد الإيقاف بدون أوردرات', ST.MISSING, RES.NEEDS_USER_VALUE, 'NEEDS_USER_VALUE: اختار FIXED_SPEND أو TARGET_CPA_MULTIPLE (مفيش رقم عام)'));
    // inventory
    const snap = latestSnap.get(p.id);
    const snapAge = snap ? (now.getTime() - new Date(`${snap.date}T00:00:00Z`).getTime()) / MS_D : null;
    const invS = invMapAudit.get(p.id); const effS = effectiveStock({ manual: p.current_stock, api: invS });
    if (invS?.primary && effS.state !== 'VERIFIED') deps.push(dep('STOCK', 'المخزون الحالي', ST.BLOCKED, RES.NEEDS_EXTERNAL, `Inventory API معتمد لكن الحالة ${effS.state} — المخزون غير معروف (مش صفر)`, { stale: true, source: 'INVENTORY_API' }));
    else if (effS.source === 'INVENTORY_API') deps.push(dep('STOCK', 'المخزون الحالي', ST.CONNECTED, RES.NONE, `${effS.value} (Inventory API — آخر مزامنة ${invS.lastSyncAt})`, { value: effS.value, source: 'INVENTORY_API' }));
    else if (p.current_stock != null) deps.push(dep('STOCK', 'المخزون الحالي', ST.CONNECTED, RES.NONE, `${p.current_stock} (يدوي/الكتالوج${invS && invS.state !== 'UNKNOWN' ? ` — API: ${invS.available} بانتظار موافقتك` : ''})`, { value: p.current_stock, source: 'CATALOG' }));
    else if (snap && snapAge <= 3) deps.push(dep('STOCK', 'المخزون الحالي', ST.CONNECTED, RES.NONE, `${snap.closing_stock} (Inventory Snapshot ${snap.date})`, { value: snap.closing_stock, source: 'INVENTORY_SNAPSHOT' }));
    else if (snap) deps.push(dep('STOCK', 'المخزون الحالي', ST.BLOCKED, RES.NEEDS_USER_VALUE, `آخر Snapshot قديم (${snap.date}) — حدّث الجرد`, { stale: true }));
    else deps.push(dep('STOCK', 'المخزون الحالي', ST.MISSING, globalInventoryFeed ? RES.NEEDS_USER_VALUE : RES.NEEDS_EXTERNAL, globalInventoryFeed ? 'NEEDS_USER_VALUE: Current Stock' : 'NEEDS_EXTERNAL_CONFIGURATION: مفيش مصدر جرد حي متصل (Daily Stock Tracking فاضي ومفيش مخزون في الكتالوج)'));
    deps.push(p.minimum_stock != null ? dep('MIN_STOCK', 'الحد الأدنى للمخزون', ST.CONNECTED, RES.NONE, `${p.minimum_stock}`) : dep('MIN_STOCK', 'الحد الأدنى للمخزون', ST.MISSING, RES.NEEDS_USER_VALUE, 'NEEDS_USER_VALUE: Minimum Stock', { soft: true }));
    const o30 = orders30.get(p.id) || 0;
    deps.push(dep('VELOCITY', 'سرعة البيع (من الأوردرات)', o30 > 0 ? ST.CONNECTED : ST.MISSING, RES.NONE, o30 > 0 ? `${o30} أوردر آخر 30 يوم (Easy Orders)` : 'مفيش أوردرات آخر 30 يوم', { soft: true }));
    // orders
    deps.push(dep('ORDERS', 'المنتج ← أوردرات Easy Orders', o30 > 0 ? ST.CONNECTED : ST.MISSING, RES.NONE, `${o30} أوردر آخر 30 يوم`, { soft: o30 === 0 }));
    // campaigns
    const camps = campsByAmb.get(ambId) || new Set();
    const sugg = suggestionByProduct.get(ambId) || 0;
    if (camps.size) deps.push(dep('MAPPING', 'المنتج ← الحملات (VERIFIED)', ST.CONNECTED, RES.NONE, `${camps.size} حملة VERIFIED`));
    else if (sugg) deps.push(dep('MAPPING', 'المنتج ← الحملات (VERIFIED)', ST.MISSING, RES.NEEDS_REVIEW, `${sugg} ربط مقترح (SUGGESTED) محتاج تأكيدك`));
    else deps.push(dep('MAPPING', 'المنتج ← الحملات (VERIFIED)', ST.MISSING, RES.NEEDS_REVIEW, 'مفيش حملات مربوطة — اربط حملة موجودة (قرارك) أو المنتج لسه ما اتعلنش', { notAdvertised: true }));
    const nAdset = [...camps].filter((c) => hasAdset.has(c)).length, nAd = [...camps].filter((c) => hasAd.has(c)).length;
    deps.push(camps.size ? dep('ADSET_AD', 'الحملة ← Ad Set ← Ad', nAdset && nAd ? ST.CONNECTED : ST.UNVERIFIED, RES.NONE, nAdset ? `${nAdset} حملة بيها Ad Sets/Ads (30 يوم)` : 'مفيش نشاط Ad Set/Ad آخر 30 يوم (حملات متوقفة)', { soft: true }) : dep('ADSET_AD', 'الحملة ← Ad Set ← Ad', ST.MISSING, RES.NONE, 'مفيش حملات', { soft: true }));
    const myCreatives = creativeRows.filter((r) => camps.has(r.campaign_id)).map((r) => r.creative_id);
    const withRef = myCreatives.filter((c) => refSet.has(c)).length;
    deps.push(camps.size ? dep('CREATIVE', 'الحملة ← Creative Intelligence', myCreatives.length ? (withRef ? ST.CONNECTED : ST.UNVERIFIED) : ST.MISSING, RES.NONE, myCreatives.length ? `${myCreatives.length} كرييتف (${withRef} في مكتبة الكرياتيف)` : 'مفيش كرييتف نشط مسجّل', { soft: true }) : dep('CREATIVE', 'الحملة ← Creative Intelligence', ST.MISSING, RES.NONE, 'مفيش حملات', { soft: true }));
    // data quality
    const dqItem = row.readiness.items.find((i) => i.key === 'DATA_QUALITY');
    deps.push(dqItem.pending ? dep('DATA_QUALITY', 'جودة البيانات', ST.UNVERIFIED, RES.NONE, 'لسه ما اتفحصتش', { soft: true }) : dqItem.ok ? dep('DATA_QUALITY', 'جودة البيانات', ST.CONNECTED, RES.NONE, dqItem.detail) : dep('DATA_QUALITY', 'جودة البيانات', ST.BLOCKED, camps.size ? RES.NEEDS_REVIEW : RES.NONE, dqItem.detail));
    // advisor (+ Testing Brain / Growth / Playbook / Learning via the SAME plan)
    const plan = latestPlan.get(p.id);
    if (plan) deps.push(dep('ADVISOR', 'المنتج ← Smart Advisor', ST.CONNECTED, RES.NONE, `خطة v${plan.version} (${plan.created_at.toISOString().slice(0, 10)})`, { planVersion: plan.version }));
    else deps.push(dep('ADVISOR', 'المنتج ← Smart Advisor', ST.MISSING, camps.size ? RES.AUTO_FIXABLE : RES.NONE, camps.size ? 'AUTO_FIXABLE: الخطة تتحسب من نفس مصدر المستشار' : 'مفيش حملات — مفيش خطة', { soft: !camps.size }));
    const profId = profBy.get(p.id);
    deps.push(dep('TESTING_LEARNING', 'Testing Brain / Learning / Playbook', profId && (testsBy.get(profId) || learnBy.get(profId)) ? ST.CONNECTED : profId ? ST.MISSING : ST.MISSING, RES.NONE, profId ? `اختبارات: ${testsBy.get(profId) || 0} · تعلّم: ${learnBy.get(profId) || 0}` : 'مفيش ملف تسويق (PMC) لهذا المنتج — لسه مفيش تاريخ اختبارات', { soft: true }));
    // classification of the product
    const missing = deps.filter((d) => d.state !== ST.CONNECTED && !d.soft);
    out.push({
      productId: p.id, ambProductId: ambId, name: p.product_name, store: p.store_id, readiness: row.readiness.state, advisorVersion: advisorRecBy.get(p.id) != null ? plan?.version ?? null : plan?.version ?? null,
      price: price.value, priceStatus: price.status, ordersLast30d: o30, verifiedCampaigns: camps.size, suggestedCampaigns: sugg,
      dependencies: deps, missing: missing.map((d) => ({ key: d.key, resolution: d.resolution, state: d.state })),
    });
  }

  // ---- global chain
  const total = out.length;
  const cnt = (key, st = ST.CONNECTED) => out.filter((p) => p.dependencies.find((d) => d.key === key)?.state === st).length;
  const link = (key, label, connected, relevant, resolution, detail, forceState = null) => ({ key, label, state: forceState || (relevant === 0 ? ST.MISSING : connected === relevant ? ST.CONNECTED : connected === 0 ? ST.MISSING : ST.MISSING), coverage: { connected, total: relevant }, partial: connected > 0 && connected < relevant, resolution, detail });
  const advertised = out.filter((p) => p.verifiedCampaigns > 0);
  const cntAdv = (key) => advertised.filter((p) => p.dependencies.find((d) => d.key === key)?.state === ST.CONNECTED).length; // coverage of a campaign-level link is measured over ADVERTISED products only
  const eoStores = listStores().map((s) => s.id);
  const eo = await eoStatus(eoStores, now);
  const guardChecks = guardSelfCheck();
  const guardOk = guardChecks.every((c) => c.ok);
  const enabledRules = rules.filter((r) => r.enabled);
  const validRules = enabledRules.filter((r) => validateRule(r).ok);
  const [decisionsTotal, shadowDecisions, approvedExecuted, verifiedWrites, outcomes, lastShadowAt] = await Promise.all([
    prisma.ambOperatorDecision.count(), prisma.ambOperatorDecision.count({ where: { mode_at_decision: 'SHADOW' } }),
    prisma.ambOperatorDecision.count({ where: { status: { in: ['EXECUTED', 'VERIFIED'] } } }), prisma.ambOperatorDecision.count({ where: { status: 'VERIFIED' } }),
    prisma.ambOperatorDecision.count({ where: { outcome_json: { not: null } } }), prisma.ambOperatorDecision.findFirst({ where: { mode_at_decision: 'SHADOW' }, orderBy: { updated_at: 'desc' }, select: { updated_at: true } }),
  ]);
  // Advisor → Operator is proven at runtime on a real product that has a plan: the Operator's own fact loader must return that plan version.
  let advisorToOperator = { state: ST.MISSING, detail: 'مفيش منتج عنده خطة مستشار لإثبات القراءة' };
  const withPlan = out.find((p) => p.dependencies.find((d) => d.key === 'ADVISOR' && d.state === ST.CONNECTED));
  if (withPlan) {
    try { const f = await loadProductFacts({ ambProductId: withPlan.ambProductId, heavy: true }); const pv = withPlan.dependencies.find((d) => d.key === 'ADVISOR').planVersion; advisorToOperator = f.advisor && f.advisor.planVersion === pv ? { state: ST.CONNECTED, detail: `الـOperator قرا خطة v${pv} لـ"${withPlan.name}" (${f.advisor.stage}/${f.advisor.primaryProblem})` } : { state: ST.MISSING, detail: 'الـOperator ما قراش الخطة' }; }
    catch (e) { advisorToOperator = { state: ST.MISSING, detail: `فشل القراءة: ${e.message}` }; }
  }
  const chain = [
    link('STORE_PRODUCT', 'Store → Product', out.filter((p) => p.store).length, total, RES.NONE, 'كل منتج بيتبع متجر (fail-closed بدونه)'),
    link('PRODUCT_ECONOMICS', 'Product → Economics', out.filter((p) => ['PRICE', 'COST'].every((k) => p.dependencies.find((d) => d.key === k)?.state === ST.CONNECTED)).length, total, RES.NEEDS_USER_VALUE, 'سعر + تكلفة شراء'),
    link('PRODUCT_INVENTORY', 'Product → Inventory', cnt('STOCK'), total, globalInventoryFeed ? RES.NEEDS_USER_VALUE : RES.NEEDS_EXTERNAL, globalInventoryFeed ? 'مخزون حي من الكتالوج/Snapshots' : 'مفيش مصدر جرد حي متصل فعليًا'),
    link('PRODUCT_ORDERS', 'Product → Orders', cnt('ORDERS'), total, RES.NONE, 'أوردرات Easy Orders آخر 30 يوم'),
    link('PRODUCT_CAMPAIGN', 'Product → Campaign', advertised.length, total, RES.NEEDS_REVIEW, 'حملات VERIFIED'),
    link('CAMPAIGN_ADSET_AD', 'Campaign → Ad Set → Ad', cntAdv('ADSET_AD'), advertised.length, RES.NONE, 'Snapshots على مستوى Ad Set/Ad'),
    link('CAMPAIGN_CREATIVE', 'Campaign → Creative intelligence', cntAdv('CREATIVE'), advertised.length, RES.NONE, 'كرييتف مربوط بمكتبة الكرياتيف'),
    link('PRODUCT_ADVISOR', 'Product → Smart Advisor', cntAdv('ADVISOR'), advertised.length, RES.AUTO_FIXABLE, 'خطة موحّدة (تشمل Testing Brain + Growth + Playbook + Learning)'),
    { key: 'ADVISOR_OPERATOR', label: 'Advisor → Operator', ...advisorToOperator, coverage: null, resolution: RES.NONE },
    { key: 'OPERATOR_RULE', label: 'Operator → Rule', state: validRules.length ? ST.CONNECTED : ST.MISSING, coverage: { connected: validRules.length, total: enabledRules.length || 0 }, resolution: RES.NEEDS_REVIEW, detail: validRules.length ? `${validRules.length} قاعدة مفعّلة وصالحة` : 'مفيش قاعدة مفعّلة (ابدأ من قالب)' },
    { key: 'RULE_GUARD', label: 'Rule → Guard', state: guardOk ? ST.CONNECTED : ST.BLOCKED, coverage: { connected: guardChecks.filter((c) => c.ok).length, total: guardChecks.length }, resolution: RES.NONE, detail: guardOk ? 'اختبار ذاتي لسلسلة الحواجز نجح' : `فشل: ${guardChecks.filter((c) => !c.ok).map((c) => c.name).join('، ')}` },
    { key: 'DECISION_APPROVAL', label: 'Decision → Approval', state: metaWritesLocked() ? ST.BLOCKED : (approvedExecuted ? ST.CONNECTED : ST.UNVERIFIED), coverage: null, resolution: metaWritesLocked() ? RES.NEEDS_EXTERNAL : RES.NONE, detail: metaWritesLocked() ? 'الموافقة موصولة بالكود لكن التنفيذ مقفول عمدًا (OPERATOR_ALLOW_META_WRITES) لحد موافقتك' : (approvedExecuted ? `${approvedExecuted} قرار اتنفذ بعد موافقة` : 'مفيش موافقة اتجرّبت بعد') },
    { key: 'EXECUTION_VERIFY', label: 'Execution → Meta verification', state: verifiedWrites ? ST.CONNECTED : ST.UNVERIFIED, coverage: null, resolution: RES.NONE, detail: verifiedWrites ? `${verifiedWrites} كتابة اتأكدت بقراءة Meta` : 'القراءة بعد الكتابة موجودة في الـExecutor لكن لم تُجرَّب على Meta حقيقي (0 كتابة)' },
    { key: 'OUTCOME_LEARNING', label: 'Outcome → Learning', state: outcomes ? ST.CONNECTED : ST.UNVERIFIED, coverage: null, resolution: RES.NONE, detail: outcomes ? `${outcomes} نتيجة اتقيّمت` : 'مفيش نتائج بعد (التوسع بيتربط بتوصية المستشار ويلغي كاش خطته؛ الباقي بيتسجل في سجل القرارات)' },
  ];

  // ---- Easy Orders + other global facts
  const sync = await getSyncStatus().catch(() => null);
  const trustOk = eo.stores.filter((s) => s.trust === 'OK').length;
  const completion = {
    productsTotal: total,
    productsReady: out.filter((p) => p.readiness === 'READY').length, productsPartial: out.filter((p) => p.readiness === 'PARTIAL').length, productsBlocked: out.filter((p) => p.readiness === 'BLOCKED').length,
    economicsComplete: { value: chain.find((c) => c.key === 'PRODUCT_ECONOMICS').coverage.connected, total, tab: 'readiness' },
    inventoryConnected: { value: cnt('STOCK'), total, tab: 'readiness', externalDependency: !globalInventoryFeed },
    campaignMappingsVerified: mc ? { value: mc.counts.VERIFIED, total: mc.total, review: mc.counts.review, tab: 'mapping' } : { value: 0, total: 0, tab: 'mapping' },
    dataQualityHealthy: heavy ? { value: cnt('DATA_QUALITY'), total, tab: 'readiness' } : { value: null, total, tab: 'readiness', note: 'اضغط "فحص جودة البيانات"' },
    easyOrdersHealthy: { value: eo.healthy ? 1 : 0, total: 1, stores: eo.stores, tab: 'control', externalDependency: !eo.webhooksConfigured },
    smartAdvisorConnected: { value: cntAdv('ADVISOR'), total: advertised.length, tab: 'control' },
    rulesConfigured: { value: validRules.length, total: enabledRules.length, tab: 'rules' },
    shadowValidated: { value: shadowDecisions, total: null, lastAt: lastShadowAt?.updated_at || null, ok: shadowDecisions > 0, tab: 'today' },
    metaExecutorVerified: { value: verifiedWrites, ok: verifiedWrites > 0, tab: 'performance' },
    autopilotEligible: { ok: (await autopilotGate()).ok, tab: 'control' },
  };
  const byRes = {}; for (const p of out) for (const m of p.missing) byRes[m.resolution] = (byRes[m.resolution] || 0) + 1;
  return { generatedAt: now.toISOString(), ms: Date.now() - t0, timings, heavy, writesLocked: metaWritesLocked(), mode: cfg.mode, emergencyStop: cfg.emergency_stop, chain, completion, easyOrders: eo, guardChecks, products: out, missingByResolution: byRes, metaSync: { lastSuccessAt: sync?.lastSuccessAt || null }, mapping: mc ? { counts: mc.counts, families: mc.families?.slice(0, 20) } : null, inventory: { snapshotsTotal, feedConnected: globalInventoryFeed } };
}

// =====================================================================================================================
// Easy Orders: configuration + ingestion evidence + status trust. Names only — NEVER a secret value.
// =====================================================================================================================
async function eoStatus(storeIds, now) {
  const stores = [];
  for (const id of storeIds) {
    const names = storeWebhookSecretEnvNames(id);
    const { entries, unsetNames } = getStoreWebhookSecretEntries(id);
    const orderSet = !!entries.find((e) => ['ORDER_CREATED', 'ANY'].includes(e.events)), statusSet = !!entries.find((e) => ['STATUS_UPDATE', 'ANY'].includes(e.events));
    const trust = (await getStoreStatusTrust(id).catch(() => null))?.state || null;
    const last = await prisma.easyOrdersOrder.findFirst({ where: { store_id: id }, orderBy: { updated_at: 'desc' }, select: { updated_at: true } });
    const lastCreated = await prisma.easyOrdersOrder.findFirst({ where: { store_id: id }, orderBy: { created_at: 'desc' }, select: { created_at: true } });
    const ageH = last ? (now.getTime() - last.updated_at.getTime()) / 3_600_000 : null;
    const dedicatedMissing = unsetNames.length > 0; // the per-event variables (Orders / Order Status Update) the app expects are not all set
    stores.push({ id, dedicatedSecretsMissing: dedicatedMissing, usesLegacySharedSecret: !!entries.find((e) => e.events === 'ANY'), legacyName: names?.legacy || null, configuredNames: names ? { order: names.order, status: names.status } : null, orderWebhookSecretSet: orderSet, statusWebhookSecretSet: statusSet, unsetNames, trust, lastIngestAt: last?.updated_at || null, lastOrderCreatedAt: lastCreated?.created_at || null, ingestAgeHours: ageH != null ? Math.round(ageH) : null,
      orderCreatedVerified: orderSet && !dedicatedMissing ? 'UNVERIFIED' : 'NEEDS_EXTERNAL_CONFIGURATION', statusUpdateVerified: statusSet && !dedicatedMissing && trust === 'OK' ? 'CONNECTED' : (statusSet && !dedicatedMissing ? 'UNVERIFIED' : 'NEEDS_EXTERNAL_CONFIGURATION') });
  }
  const webhooksConfigured = stores.length > 0 && stores.every((s) => s.orderWebhookSecretSet && s.statusWebhookSecretSet && !s.dedicatedSecretsMissing);
  const healthy = webhooksConfigured && stores.every((s) => s.trust === 'OK');
  return { stores, webhooksConfigured, healthy, codAutomation: healthy ? 'ELIGIBLE' : 'BLOCKED', note: 'COD/Confirmation/Delivery يفضل BLOCKED لحد ما: Order Created → 2xx → المتجر والمنتج الصح → من غير تكرار، ثم Status Update → 2xx → نفس الأوردر اتحدّث، وبعدها Data Quality يعتبر حالات الأوردرات موثوقة (Trust = OK).', procedure: ['1) أضف متغيّري Railway لكل متجر (Orders و Order Status Update)', '2) اعمل أوردر تجريبي → تحقق قراءة فقط: 2xx + storeId + المنتج + مفيش duplicate', '3) غيّر حالة نفس الأوردر → تحقق إن التحديث وصل واتخزن', '4) نسبة الأوردرات الناضجة غير PENDING تعدّي حد الثقة → Trust = OK'] };
}

// =====================================================================================================================
// AUTO-FIX — only AUTO_FIXABLE integration gaps, safe and bounded. Writes ONLY: Smart Advisor plan versions (what viewing a product does) and
// SUGGESTED mapping rows. Never VERIFIED, never economics/stock, never Meta/Easy Orders.
// =====================================================================================================================
export async function autoFixIntegration({ userId = null, maxMs = 90_000, advisorBatch = 6 } = {}) {
  const t0 = Date.now(); const log = [];
  clearStoreCatalogCache(); log.push('تم تحديث كاش كتالوج المتجر (قراءة فقط)');
  const conn = await getConnection();
  const adAccountId = conn?.status === 'CONNECTED' ? conn.selected_ad_account_id : null;
  let mappingResult = null;
  if (adAccountId) { mappingResult = await persistDeterministicSuggestions({ adAccountId, userId }); log.push(`ربط مقترح (STRONG فقط): ${mappingResult.created} جديد، ${mappingResult.updated} متحدّث — لسه محتاج تأكيدك`); }
  const adv = await ensureAdvisorPlans({ max: advisorBatch, maxMs: Math.max(1000, maxMs - (Date.now() - t0)) });
  const { done, failed, failures, todoCount: todo } = adv;
  log.push(`خطط المستشار: اتحسب ${done} من ${todo} منتج ناقص خطة${failed ? `، فشل ${failed}` : ''}`);
  try { await prisma.aiAuditLog.create({ data: { actor_id: userId || null, kind: 'OPERATOR_AUTOFIX', action: 'EXECUTE', input_json: JSON.stringify({ advisorPlans: done, advisorFailed: failed, mapping: mappingResult }).slice(0, 3000), success: true } }); } catch { /* audit is best-effort */ }
  return { ok: true, advisorPlansComputed: done, advisorFailed: failed, advisorRemaining: Math.max(0, todo - done - failed), failures, mapping: mappingResult, log, ms: Date.now() - t0 };
}

/**
 * Smart Advisor plans for ADVERTISED products that have none yet — the plan is computed by the SAME canonical engine the Advisor screen uses (so the Operator and
 * the Advisor can never hold two strategies). Bounded (max products + time) because each plan reads the product's synced data; also run from the scheduler tick.
 */
export async function ensureAdvisorPlans({ max = 3, maxMs = 60_000 } = {}) {
  const t0 = Date.now();
  const list = await readinessList({ heavy: false });
  const maps = await prisma.ambProductCampaignMap.findMany({ where: { amb_product_id: { in: list.map((p) => p.ambProductId) }, status: 'MAPPED' }, select: { amb_product_id: true } });
  const advertised = new Set(maps.map((m) => m.amb_product_id));
  const have = new Set((await prisma.ambAdvisorPlanVersion.groupBy({ by: ['product_id'], where: { product_id: { in: list.map((p) => p.productId) } } })).map((r) => r.product_id));
  const todo = list.filter((p) => advertised.has(p.ambProductId) && !have.has(p.productId));
  let done = 0, failed = 0; const failures = [];
  for (const p of todo.slice(0, max)) {
    if (Date.now() - t0 > maxMs) break;
    try { const r = await runAdvisorForProduct({ productId: p.productId, storeId: p.storeId, trigger: 'OPERATOR_SETUP', fresh: true }); if (r?.ok) done++; else { failed++; failures.push({ product: p.name, reason: r?.reason || r?.code || 'UNKNOWN' }); } }
    catch (e) { failed++; failures.push({ product: p.name, reason: e.message }); logger.warn('[operatorIntegration] advisor plan failed', { productId: p.productId, message: e.message }); }
  }
  return { done, failed, failures, todoCount: todo.length };
}
