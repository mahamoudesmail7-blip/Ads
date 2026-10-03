// 🤖 AI Operator — SETUP LAYER: product automation profile (storeId + productId), readiness, global readiness dashboard, campaign mapping center,
// bulk CSV setup and the setup wizard. 2026-10-03.
//
// Single source of truth rule: NOTHING here owns a copy of canonical data.
//   price / cost / shipping / packaging / other / Target CPA / Max CPA / Min Profit -> AmbProduct (the existing AMB economics model, via ambProducts.updateProduct)
//   current stock / minimum stock                                                  -> Product (the catalog's inventory fields, read by the existing stockGuard)
//   Product Key / Hard Stop CPA / automation mode / scale cap / testing allowance  -> AmbOperatorProductConfig (the ONLY new storage; these exist nowhere else)
// Unknown stays unknown: an empty cell never writes 0, and a missing value is never invented.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { mapProductByName, normalizeName } from '../../../../js/product-mapping.js';
import { updateProduct, createFromCatalogProduct } from './ambProducts.js';
import * as mapping from './mapping.js';
import { computeOperatorEconomics } from './operatorGuards.js';
import { entityWindowMetrics } from './metricsEngine.js';
import { windowRange } from './operatorRules.js';
import { SETUP_ACTIONS } from './operatorUnblock.js';
import { resolveCampaignEvidence, persistStrongSuggestions, campaignPrefix } from './operatorMappingResolver.js';
import { listCampaignsFromSnapshots, buildCampaignProductIndex, loadProductFacts } from './operatorContext.js';
import { resolveSellingPrice, loadStoreCatalogIndex } from './productPriceResolver.js';
import { listExceptions, addException, removeException, getOperatorConfig } from './operatorStore.js';

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const R = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const MODES = ['OFF', 'SHADOW', 'APPROVAL', 'AUTOPILOT'];

async function audit({ actorId = null, kind, input }) {
  try { await prisma.aiAuditLog.create({ data: { actor_id: actorId || null, kind, action: 'EXECUTE', input_json: JSON.stringify(input).slice(0, 4000), success: true } }); }
  catch (err) { logger.error('[operatorReadiness] audit write failed', { message: err.message }); }
}

// =====================================================================================================================
// Product automation profile
// =====================================================================================================================
async function loadProductBundle(productId) {
  const product = await prisma.product.findUnique({ where: { id: Number(productId) }, select: { id: true, product_name: true, product_code: true, sku: true, store_id: true, selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true, current_stock: true, minimum_stock: true } });
  if (!product) { const e = new Error('المنتج غير موجود.'); e.status = 404; throw e; }
  const amb = await prisma.ambProduct.findUnique({ where: { product_id: product.id } });
  const opCfg = await prisma.ambOperatorProductConfig.findUnique({ where: { product_id_store_id: { product_id: product.id, store_id: product.store_id } } });
  return { product, amb, opCfg };
}

const srcOf = (ambVal, prodVal) => (Number(ambVal) > 0 ? 'AMB' : Number(prodVal) > 0 ? 'CATALOG' : null);
const valOf = (ambVal, prodVal) => (Number(ambVal) > 0 ? Number(ambVal) : Number(prodVal) > 0 ? Number(prodVal) : null);

/** The single automation profile for storeId + productId (spec 58). Every value says where it comes from. */
export async function getProductProfile({ productId, heavy = false }) {
  const { product, amb, opCfg } = await loadProductBundle(productId);
  const priceResolution = resolveSellingPrice({ product, ambProduct: amb, storeCatalog: await loadStoreCatalogIndex(product.store_id) });
  const econ = computeOperatorEconomics({ product, ambProduct: amb, opCfg, priceResolution });
  const exceptions = (await listExceptions({})).filter((e) => (e.scope_type === 'PRODUCT' && e.scope_id === String(product.id)) || (e.scope_type === 'STORE' && e.scope_id === product.store_id));
  const idx = amb ? await campaignsForAmbProduct(amb.id) : [];
  let facts = null;
  if (heavy && amb) facts = await loadProductFacts({ ambProductId: amb.id, heavy: true });
  const readiness = computeReadiness({ product, amb, opCfg, econ, campaigns: idx, dq: facts ? facts.dq : undefined });
  const zeroOrder = ((await getOperatorConfig()).limits.productOverrides || {})[String(product.id)]?.zeroOrder || null;
  return {
    priceResolution, zeroOrder,
    product: { id: product.id, name: product.product_name, code: product.product_code, sku: product.sku, storeId: product.store_id },
    ambProductId: amb?.id ?? null,
    productKey: opCfg?.product_key || null,
    store: product.store_id,
    economics: {
      sellingPrice: { value: valOf(amb?.actual_selling_price, product.selling_price), source: srcOf(amb?.actual_selling_price, product.selling_price) },
      purchaseCost: { value: valOf(amb?.product_cost, product.product_cost), source: srcOf(amb?.product_cost, product.product_cost) },
      shipping: { value: valOf(amb?.shipping_cost, product.shipping_cost), source: srcOf(amb?.shipping_cost, product.shipping_cost) },
      packaging: { value: valOf(amb?.packaging_cost, product.packaging_cost), source: srcOf(amb?.packaging_cost, product.packaging_cost) },
      other: { value: valOf(amb?.other_cost, product.other_cost), source: srcOf(amb?.other_cost, product.other_cost) },
      targetCpa: { value: opCfg?.target_cpa ?? amb?.target_cpa ?? null, source: opCfg?.target_cpa != null ? 'OPERATOR_OVERRIDE' : amb?.target_cpa != null ? 'AMB' : null },
      maxCpa: { value: opCfg?.max_cpa ?? amb?.max_cpa ?? econ.calculatedMaxCpa ?? null, source: opCfg?.max_cpa != null ? 'OPERATOR_OVERRIDE' : amb?.max_cpa != null ? 'AMB' : econ.calculatedMaxCpa != null ? 'CALCULATED' : null },
      hardStopCpa: { value: opCfg?.hard_stop_cpa ?? null, source: opCfg?.hard_stop_cpa != null ? 'MANUAL' : null },
      minProfit: { value: opCfg?.min_profit ?? amb?.min_profit ?? null, source: opCfg?.min_profit != null ? 'OPERATOR_OVERRIDE' : amb?.min_profit != null ? 'AMB' : null },
      unitMargin: econ.unitMargin, complete: econ.complete,
    },
    stock: { current: product.current_stock ?? null, minimum: product.minimum_stock ?? opCfg?.min_stock ?? null, known: product.current_stock != null, status: facts?.stock?.status || null, daysRemaining: facts?.stock?.daysRemaining ?? null },
    testing: { spendAllowance: opCfg?.testing_spend_allowance ?? null, minSample: opCfg?.testing_min_sample ?? null },
    scale: { maxScalePct: opCfg?.max_scale_pct ?? null },
    automationMode: opCfg?.automation_mode || null,
    exceptions,
    campaigns: idx,
    readiness,
  };
}

async function campaignsForAmbProduct(ambProductId) {
  const rows = await prisma.ambProductCampaignMap.findMany({ where: { amb_product_id: ambProductId }, select: { campaign_id: true, campaign_name: true, status: true, match_source: true, ad_account_id: true } });
  return rows.map((r) => ({ campaignId: r.campaign_id, campaignName: r.campaign_name, status: r.status, source: r.match_source, adAccountId: r.ad_account_id, verified: r.status === 'MAPPED' }));
}

/** Validates a profile patch (pure). Returns {errors[], warnings[], clean} — `clean` carries only the cells the user actually provided. */
export function validateProfilePatch(patch, current = {}) {
  const errors = [], warnings = [], clean = {};
  const take = (key, label, { min = 0, max = Infinity, int = false } = {}) => {
    if (patch[key] === undefined) return;
    if (patch[key] === null || patch[key] === '') { clean[key] = null; return; }
    const n = Number(patch[key]);
    if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) { errors.push(`${label}: قيمة غير صالحة (${patch[key]}).`); return; }
    clean[key] = n;
  };
  take('selling_price', 'سعر البيع', { min: 0.01 }); take('product_cost', 'تكلفة الشراء', { min: 0.01 }); take('shipping_cost', 'الشحن'); take('packaging_cost', 'التغليف'); take('other_cost', 'تكاليف أخرى');
  take('target_cpa', 'Target CPA', { min: 0.01 }); take('max_cpa', 'Max CPA', { min: 0.01 }); take('hard_stop_cpa', 'Hard Stop CPA', { min: 0.01 }); take('min_profit', 'أدنى ربح');
  take('current_stock', 'المخزون الحالي'); take('minimum_stock', 'الحد الأدنى للمخزون'); take('max_scale_pct', 'أقصى نسبة توسع', { min: 1, max: 100 });
  take('testing_spend_allowance', 'ميزانية الاختبار'); take('testing_min_sample', 'أدنى عينة اختبار', { min: 1, int: true });
  if (patch.product_key !== undefined) clean.product_key = String(patch.product_key || '').trim() || null;
  if (patch.automation_mode !== undefined) { if (patch.automation_mode !== null && patch.automation_mode !== '' && !MODES.includes(patch.automation_mode)) errors.push(`وضع الأتمتة غير صالح: ${patch.automation_mode}`); else clean.automation_mode = patch.automation_mode || null; }
  const merged = { ...current, ...clean };
  if (merged.hard_stop_cpa != null && merged.target_cpa != null && merged.hard_stop_cpa < merged.target_cpa) errors.push('Hard Stop CPA لازم يكون ≥ Target CPA.');
  if (merged.max_cpa != null && merged.target_cpa != null && merged.max_cpa < merged.target_cpa) errors.push('Max CPA لازم يكون ≥ Target CPA.');
  if (merged.hard_stop_cpa != null && merged.max_cpa != null && merged.hard_stop_cpa < merged.max_cpa) warnings.push('Hard Stop CPA أقل من Max CPA — الإيقاف هيحصل قبل ما توصل للحد الأقصى.');
  if (merged.selling_price != null && merged.product_cost != null && merged.selling_price <= merged.product_cost) warnings.push('سعر البيع أقل من أو يساوي تكلفة الشراء — المنتج بيخسر قبل الإعلانات.');
  if (merged.selling_price != null && merged.product_cost != null && merged.target_cpa != null) {
    const margin = merged.selling_price - merged.product_cost - (merged.shipping_cost || 0) - (merged.packaging_cost || 0) - (merged.other_cost || 0);
    if (merged.target_cpa >= margin) warnings.push(`Target CPA (${merged.target_cpa}) أعلى من هامش الوحدة (${R(margin, 1)}) — المنتج هيخسر عند الهدف.`);
  }
  if (merged.minimum_stock != null && merged.current_stock != null && merged.current_stock < merged.minimum_stock) warnings.push('المخزون الحالي أقل من الحد الأدنى — الفتح والتوسع هيتمنعوا.');
  return { errors, warnings, clean };
}

/** Saves a profile patch to the CANONICAL homes (see header). Creates the AMB product from the catalog product when missing. */
export async function saveProductProfile({ productId, patch, userId = null }) {
  const { product, amb: existingAmb, opCfg } = await loadProductBundle(productId);
  const { errors, warnings, clean } = validateProfilePatch(patch, {
    selling_price: valOf(existingAmb?.actual_selling_price, product.selling_price), product_cost: valOf(existingAmb?.product_cost, product.product_cost), shipping_cost: valOf(existingAmb?.shipping_cost, product.shipping_cost), packaging_cost: valOf(existingAmb?.packaging_cost, product.packaging_cost), other_cost: valOf(existingAmb?.other_cost, product.other_cost),
    target_cpa: opCfg?.target_cpa ?? existingAmb?.target_cpa ?? null, max_cpa: opCfg?.max_cpa ?? existingAmb?.max_cpa ?? null, hard_stop_cpa: opCfg?.hard_stop_cpa ?? null, current_stock: product.current_stock, minimum_stock: product.minimum_stock,
  });
  if (errors.length) { const e = new Error(errors.join(' ')); e.status = 400; e.details = errors; throw e; }

  const ambKeys = { selling_price: 'actual_selling_price', product_cost: 'product_cost', shipping_cost: 'shipping_cost', packaging_cost: 'packaging_cost', other_cost: 'other_cost', target_cpa: 'target_cpa', max_cpa: 'max_cpa', min_profit: 'min_profit' };
  const ambPatch = {}; for (const [k, col] of Object.entries(ambKeys)) if (clean[k] !== undefined && !['target_cpa', 'max_cpa', 'min_profit'].includes(k)) ambPatch[col] = clean[k];
  // CPAs/min profit are canonical on AmbProduct too (the Operator override table only holds what AmbProduct cannot).
  for (const k of ['target_cpa', 'max_cpa', 'min_profit']) if (clean[k] !== undefined) ambPatch[k] = clean[k];
  let amb = existingAmb;
  if (Object.keys(ambPatch).length) {
    if (!amb) { await createFromCatalogProduct(product.id, userId); amb = await prisma.ambProduct.findUnique({ where: { product_id: product.id } }); }
    await updateProduct(amb.id, ambPatch);
  }
  // The catalogue Product is the MASTER for price/cost fields and is what Profit Brain / Money Guard / true-performance read; AmbProduct is what the AMB
  // economics pages read. One save keeps both identical (a single transaction of intent — not two sources of truth drifting apart).
  const catPatch = {};
  if (clean.selling_price !== undefined) catPatch.selling_price = clean.selling_price ?? 0;
  if (clean.product_cost !== undefined) catPatch.product_cost = clean.product_cost ?? 0;
  for (const k of ['shipping_cost', 'packaging_cost', 'other_cost']) if (clean[k] !== undefined) catPatch[k] = clean[k];
  if (Object.keys(catPatch).length) await prisma.product.update({ where: { id: product.id }, data: catPatch });
  const stockPatch = {}; if (clean.current_stock !== undefined) stockPatch.current_stock = clean.current_stock; if (clean.minimum_stock !== undefined) stockPatch.minimum_stock = clean.minimum_stock;
  if (Object.keys(stockPatch).length) await prisma.product.update({ where: { id: product.id }, data: stockPatch });
  const opPatch = {}; for (const k of ['hard_stop_cpa', 'product_key', 'automation_mode', 'max_scale_pct', 'testing_spend_allowance', 'testing_min_sample']) if (clean[k] !== undefined) opPatch[k] = clean[k];
  if (Object.keys(opPatch).length) await prisma.ambOperatorProductConfig.upsert({ where: { product_id_store_id: { product_id: product.id, store_id: product.store_id } }, create: { product_id: product.id, store_id: product.store_id, ...opPatch, updated_by_id: userId }, update: { ...opPatch, updated_by_id: userId } });
  await audit({ actorId: userId, kind: 'OPERATOR_PRODUCT_PROFILE', input: { productId: product.id, storeId: product.store_id, changed: clean } });
  return { ok: true, warnings, profile: await getProductProfile({ productId: product.id }) };
}

// =====================================================================================================================
// Readiness (spec 59/60)
// =====================================================================================================================
/**
 * READY / PARTIAL / BLOCKED. BLOCKED = something critical is missing (campaign mapping, economics, data quality). PARTIAL = only softer items are missing
 * (stock, Hard Stop CPA). `dq === undefined` means "not checked yet" (light mode) — it is reported as such, never as OK.
 */
export function computeReadiness({ product, amb, opCfg, econ, campaigns, dq, zeroOrder }) {
  const verified = (campaigns || []).filter((c) => c.verified);
  const dqKnown = dq !== undefined;
  const dqBlocked = dqKnown && dq?.gate === 'DECISION_BLOCKED_DATA_QUALITY';
  const dqUnknown = dqKnown && !dq?.gate;
  const items = [
    { key: 'MAPPING', label: 'ربط الحملات بالمنتج (VERIFIED)', ok: verified.length > 0, severity: 'CRITICAL', detail: verified.length ? `${verified.length} حملة مربوطة` : (campaigns?.length ? 'فيه ربط مقترح بس (SUGGESTED) — مش كفاية' : 'مفيش حملات مربوطة'), action: SETUP_ACTIONS.MAPPING },
    { key: 'ECONOMICS', label: 'الاقتصاديات (سعر البيع + تكلفة الشراء)', ok: !!econ?.complete, severity: 'CRITICAL', detail: econ?.complete ? `هامش الوحدة ${R(econ.unitMargin, 1)} ج.م` : 'سعر البيع/التكلفة ناقصين — الربحية UNKNOWN', action: SETUP_ACTIONS.ECONOMICS },
    { key: 'DATA_QUALITY', label: 'جودة البيانات', ok: dqKnown ? !dqBlocked && !dqUnknown : false, severity: 'CRITICAL', pending: !dqKnown, detail: !dqKnown ? 'لسه ما اتفحصتش' : dqBlocked ? 'جودة البيانات بتمنع القرارات' : dqUnknown ? 'غير محسوبة (اربط الحملات وانتظر المزامنة)' : 'سليمة', action: SETUP_ACTIONS.DATA_QUALITY },
    { key: 'STOCK', label: 'المخزون الحالي مسجّل', ok: product?.current_stock != null, severity: 'SOFT', detail: product?.current_stock != null ? `${product.current_stock} قطعة` : 'غير مسجّل — الفتح/التوسع هيتمنعوا', action: SETUP_ACTIONS.STOCK },
    { key: 'MIN_STOCK', label: 'الحد الأدنى للمخزون', ok: (product?.minimum_stock ?? opCfg?.min_stock) != null, severity: 'SOFT', detail: (product?.minimum_stock ?? opCfg?.min_stock) != null ? `${product?.minimum_stock ?? opCfg?.min_stock}` : 'غير محدد', action: SETUP_ACTIONS.STOCK },
    { key: 'TARGET_CPA', label: 'Target CPA', ok: (opCfg?.target_cpa ?? amb?.target_cpa) != null, severity: 'SOFT', detail: (opCfg?.target_cpa ?? amb?.target_cpa) != null ? `${opCfg?.target_cpa ?? amb?.target_cpa}` : 'غير محدد', action: SETUP_ACTIONS.ECONOMICS },
    // per-product zero-order stop. Only evaluated when the caller supplies it (undefined = not asked), so older callers keep their exact item list.
    ...(zeroOrder === undefined ? [] : [{ key: 'ZERO_ORDER', label: 'حد الإيقاف بدون أوردرات', ok: !!zeroOrder, severity: 'SOFT', detail: zeroOrder ? (zeroOrder.mode === 'FIXED_SPEND' ? `ثابت ${zeroOrder.fixedSpend}` : `Target CPA × ${zeroOrder.multiple}`) : 'غير مضبوط — إيقاف الصفر-أوردرات ممنوع', action: SETUP_ACTIONS.ZERO_ORDER || SETUP_ACTIONS.HARD_STOP }]),
    { key: 'HARD_STOP', label: 'Hard Stop CPA', ok: opCfg?.hard_stop_cpa != null, severity: 'SOFT', detail: opCfg?.hard_stop_cpa != null ? `${opCfg.hard_stop_cpa}` : 'غير محدد', action: SETUP_ACTIONS.HARD_STOP },
  ];
  const criticalMissing = items.filter((i) => i.severity === 'CRITICAL' && !i.ok);
  const softMissing = items.filter((i) => i.severity === 'SOFT' && !i.ok);
  const pendingOnly = criticalMissing.every((i) => i.pending);
  // a product whose only gap is a not-yet-run data-quality check is PARTIAL (we simply don't know yet), never READY
  const state = criticalMissing.length && !pendingOnly ? 'BLOCKED' : (criticalMissing.length || softMissing.length ? 'PARTIAL' : 'READY');
  return { state, icon: state === 'READY' ? '🟢' : state === 'PARTIAL' ? '🟡' : '🔴', items, missing: [...criticalMissing, ...softMissing].map((i) => ({ key: i.key, label: i.label, severity: i.severity, action: i.action, pending: !!i.pending })), mode: opCfg?.automation_mode || null };
}

/** Readiness of every active AMB product (the product universe the Operator can ever act on). `heavy` adds the data-quality check (cached 5 min). */
export async function readinessList({ heavy = false, heavyFor = null } = {}) {
  const ambs = await prisma.ambProduct.findMany({ where: { active: true, product_id: { not: null } }, select: { id: true, product_id: true, product_name: true, product_cost: true, actual_selling_price: true, shipping_cost: true, packaging_cost: true, other_cost: true, target_cpa: true, max_cpa: true, min_profit: true } });
  const productIds = ambs.map((a) => a.product_id);
  const products = new Map((await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, product_name: true, store_id: true, selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true, current_stock: true, minimum_stock: true } })).map((p) => [p.id, p]));
  const cfgs = new Map((await prisma.ambOperatorProductConfig.findMany({ where: { product_id: { in: productIds } } })).map((c) => [`${c.product_id}:${c.store_id}`, c]));
  const maps = await prisma.ambProductCampaignMap.findMany({ where: { amb_product_id: { in: ambs.map((a) => a.id) } }, select: { amb_product_id: true, campaign_id: true, status: true, match_source: true } });
  const byAmb = new Map(); for (const m of maps) (byAmb.get(m.amb_product_id) || byAmb.set(m.amb_product_id, []).get(m.amb_product_id)).push({ campaignId: m.campaign_id, status: m.status, source: m.match_source, verified: m.status === 'MAPPED' });
  const out = [];
  const cfgGlobal = await getOperatorConfig();
  const catalogs = {}; for (const sid of new Set([...products.values()].map((p) => p.store_id).filter(Boolean))) catalogs[sid] = await loadStoreCatalogIndex(sid); // cached 1h; null when the store catalogue is unavailable
  for (const amb of ambs) {
    const product = products.get(amb.product_id); if (!product) continue;
    const opCfg = cfgs.get(`${product.id}:${product.store_id}`) || null;
    const priceResolution = resolveSellingPrice({ product, ambProduct: amb, storeCatalog: catalogs[product.store_id] || null });
    const econ = computeOperatorEconomics({ product, ambProduct: amb, opCfg, priceResolution });
    let dq;
    if (heavy || heavyFor?.has(product.id)) { const f = await loadProductFacts({ ambProductId: amb.id, heavy: true }); dq = f.dq || { gate: null }; }
    const readiness = computeReadiness({ product, amb, opCfg, econ, campaigns: byAmb.get(amb.id) || [], dq, zeroOrder: ((cfgGlobal.limits.productOverrides || {})[String(product.id)]?.zeroOrder) || null });
    out.push({ productId: product.id, ambProductId: amb.id, name: product.product_name, storeId: product.store_id, productKey: opCfg?.product_key || null, automationMode: opCfg?.automation_mode || null, campaignsMapped: (byAmb.get(amb.id) || []).filter((c) => c.verified).length, campaignsSuggested: (byAmb.get(amb.id) || []).filter((c) => !c.verified).length, economicsComplete: !!econ.complete, priceStatus: priceResolution.status, stockKnown: product.current_stock != null, stock: product.current_stock ?? null, hardStop: opCfg?.hard_stop_cpa ?? null, targetCpa: opCfg?.target_cpa ?? amb.target_cpa ?? null, readiness });
  }
  const order = { BLOCKED: 0, PARTIAL: 1, READY: 2 };
  out.sort((a, b) => order[a.readiness.state] - order[b.readiness.state] || a.name.localeCompare(b.name));
  return out;
}

/** Spec 60: what must be configured before Autopilot, at a glance. */
export async function globalReadiness({ heavy = false, adAccountId = null } = {}) {
  const list = await readinessList({ heavy });
  const c = { READY: 0, PARTIAL: 0, BLOCKED: 0 }; for (const p of list) c[p.readiness.state]++;
  let mapped = null, unmapped = null, suggested = null;
  if (adAccountId) {
    const camps = (await listCampaignsFromSnapshots({ adAccountId })).filter((x) => ['ACTIVE', 'PAUSED'].includes(x.status));
    const idx = await buildCampaignProductIndex({ adAccountId });
    mapped = camps.filter((x) => idx.get(x.id)?.verified).length; suggested = camps.filter((x) => idx.has(x.id) && !idx.get(x.id).verified).length; unmapped = camps.length - mapped - suggested;
  }
  const dqChecked = heavy;
  return {
    products: { total: list.length, ready: c.READY, partial: c.PARTIAL, blocked: c.BLOCKED },
    campaigns: { mapped, suggested, unmapped },
    missingEconomics: list.filter((p) => !p.economicsComplete).length,
    missingStock: list.filter((p) => !p.stockKnown).length,
    missingHardStop: list.filter((p) => p.hardStop == null).length,
    noMappedCampaigns: list.filter((p) => p.campaignsMapped === 0).length,
    blockedByDataQuality: dqChecked ? list.filter((p) => p.readiness.items.find((i) => i.key === 'DATA_QUALITY' && !i.ok && !i.pending)).length : null,
    dataQualityChecked: dqChecked,
  };
}

// =====================================================================================================================
// Campaign mapping center (spec 62/63)
// =====================================================================================================================
/**
 * VERIFIED (explicit/confirmed mapping or launch-job link), SUGGESTED (deterministic or weak suggestion — never executed against), UNMAPPED, CONFLICT.
 * Suggestion evidence order: explicit mapping > launch job > Product Key in the campaign name > name similarity (WEAK, needs >= 2 shared tokens, never auto-confirmed).
 */
export async function mappingCenter({ adAccountId, limit = 400 }) {
  if (!adAccountId) return { connected: false, rows: [], counts: {} };
  const campaigns = (await listCampaignsFromSnapshots({ adAccountId })).filter((c) => ['ACTIVE', 'PAUSED'].includes(c.status));
  const maps = await prisma.ambProductCampaignMap.findMany({ where: { ad_account_id: adAccountId }, include: { amb_product: { select: { id: true, product_name: true, product_id: true } } } });
  const mapBy = new Map(maps.map((m) => [m.campaign_id, m]));
  const launched = await prisma.ambLaunchCampaign.findMany({ where: { meta_campaign_id: { not: null }, job: { ad_account_id: adAccountId, product_id: { not: null } } }, select: { meta_campaign_id: true, job: { select: { product_id: true } } } });
  const ambs = await prisma.ambProduct.findMany({ where: { active: true }, select: { id: true, product_name: true, product_id: true } });
  const ambByProduct = new Map(ambs.filter((a) => a.product_id).map((a) => [a.product_id, a]));
  const launchBy = new Map(launched.map((l) => [l.meta_campaign_id, ambByProduct.get(l.job.product_id) || null]));
  const keys = (await prisma.ambOperatorProductConfig.findMany({ where: { product_key: { not: null } }, select: { product_id: true, product_key: true } })).map((k) => ({ key: normalizeName(k.product_key), raw: k.product_key, amb: ambByProduct.get(k.product_id) || null })).filter((k) => k.key && k.amb);
  const exceptions = await listExceptions({});
  const excluded = new Set(exceptions.filter((e) => e.scope_type === 'CAMPAIGN' && e.types.includes('NO_AUTOMATION')).map((e) => e.scope_id));
  // 7-day spend from the SAME canonical reduction every other screen uses (never a raw sum over snapshot rows — those repeat the day's cumulative spend)
  const w7 = windowRange('last7', new Date().toISOString().slice(0, 10));
  const m7 = await entityWindowMetrics({ level: 'campaign', from: w7.from, to: w7.to, adAccountId });
  const spend = new Map([...m7.entries()].map(([id, m]) => [id, m.spend || 0]));
  const evidence = await resolveCampaignEvidence({ adAccountId, campaigns, ambProducts: ambs });
  const rows = [];
  for (const c of campaigns) {
    const nameN = normalizeName(c.name || '');
    const m = mapBy.get(c.id) || null;
    const lj = launchBy.get(c.id) || null;
    const keyHits = keys.filter((k) => nameN.includes(k.key));
    const keyProducts = [...new Map(keyHits.map((k) => [k.amb.id, k])).values()];
    let state = 'UNMAPPED', product = null, source = 'NONE', confidence = null, suggestion = null, note = null;
    if (m && m.status === 'MAPPED') { state = 'VERIFIED'; product = m.amb_product; source = m.match_source === 'MANUAL' ? 'EXPLICIT_MAPPING' : m.match_source; }
    else if (lj) { state = 'VERIFIED'; product = lj; source = 'LAUNCH_JOB'; }
    else if (m && m.status === 'SUGGESTED') { state = 'SUGGESTED'; product = m.amb_product; source = m.match_source; confidence = m.match_confidence; }
    // conflicts: two pieces of deterministic evidence pointing at different products
    const mappedAmbId = (m?.status === 'MAPPED' ? m.amb_product_id : null) ?? lj?.id ?? null;
    if (mappedAmbId && lj && m?.status === 'MAPPED' && lj.id !== m.amb_product_id) { state = 'CONFLICT'; note = `الربط اليدوي بيشاور على "${m.amb_product?.product_name}" لكن حملة الرفع تابعة لـ"${lj.product_name}"`; }
    else if (mappedAmbId && keyProducts.length && !keyProducts.some((k) => k.amb.id === mappedAmbId)) { state = 'CONFLICT'; note = `اسم الحملة فيه Product Key لمنتج تاني ("${keyProducts[0].amb.product_name}")`; }
    else if (keyProducts.length > 1 && !mappedAmbId) { state = 'CONFLICT'; note = 'اسم الحملة بيطابق أكتر من منتج'; }
    // evidence for anything not already VERIFIED — ONE resolver (URL / Product Key / sibling prefix / weak name); never produces VERIFIED
    const ev = evidence.get(c.id) || null;
    let review = null;
    if (state !== 'VERIFIED' && ev) {
      if (ev.decision === 'AMBIGUOUS') review = 'AMBIGUOUS';
      else if (ev.pick) {
        const am = ambs.find((x) => x.id === ev.pick.ambProductId);
        const strongEv = ev.pick.evidence.find((e) => ['URL_SLUG', 'PRODUCT_KEY', 'SIBLING_PREFIX'].includes(e.type));
        suggestion = { ambProductId: ev.pick.ambProductId, productName: am?.product_name || null, confidence: strongEv ? 0.9 : R(ev.pick.evidence[0].confidence, 2), source: strongEv?.type || 'NAME_SIMILARITY', evidence: ev.pick.evidence.map((e) => e.detail).join(' · '), weak: ev.decision === 'SUGGEST_WEAK' };
        if (state === 'UNMAPPED') state = 'SUGGESTED';
        review = 'CONFIRM';
      }
    }
    if (state === 'SUGGESTED' && !review) review = 'CONFIRM'; // a persisted SUGGESTED row always waits for a human
    if (state === 'UNMAPPED' && !review) review = 'UNEXPLAINED'; // no deterministic evidence at all: a human decides (grouped by name family below)
    rows.push({
      campaignId: c.id, campaignName: c.name, campaignStatus: c.status, spend7d: R(spend.get(c.id) || 0, 0),
      detectedProductKey: keyHits[0]?.raw || null, state, source, confidence: confidence ?? suggestion?.confidence ?? (state === 'VERIFIED' ? 1 : null), note,
      product: product ? { ambProductId: product.id, name: product.product_name, productId: product.product_id } : null, suggestion, excluded: excluded.has(c.id),
      review, evidence: ev?.evidence || [], candidates: ev?.decision === 'AMBIGUOUS' ? ev.candidates.map((c2) => ({ ambProductId: c2.ambProductId, productName: ambs.find((x) => x.id === c2.ambProductId)?.product_name || null, evidence: c2.evidence.map((e) => `${e.type}: ${e.detail}`) })) : [],
    });
  }
  const order = { CONFLICT: 0, UNMAPPED: 1, SUGGESTED: 2, VERIFIED: 3 };
  rows.sort((a, b) => order[a.state] - order[b.state] || b.spend7d - a.spend7d);
  const counts = { VERIFIED: 0, SUGGESTED: 0, UNMAPPED: 0, CONFLICT: 0, excluded: 0 }; for (const r of rows) { counts[r.state]++; if (r.excluded) counts.excluded++; }
  const reviewQueue = rows.filter((r) => r.review).sort((x, y) => y.spend7d - x.spend7d);
  // campaigns of the same name family (e.g. "Smart-Bag _ ...") that still need a decision, so ONE human choice can settle the whole family
  const fam = new Map();
  for (const r of reviewQueue) { const pre = campaignPrefix(r.campaignName) || `__single:${r.campaignId}`; const f = fam.get(pre) || { prefix: pre.startsWith('__single:') ? null : pre, campaignIds: [], names: [], spend7d: 0, reviews: new Set(), suggestedProductIds: new Set() }; f.campaignIds.push(r.campaignId); f.names.push(r.campaignName); f.spend7d += r.spend7d; f.reviews.add(r.review); if (r.suggestion) f.suggestedProductIds.add(r.suggestion.ambProductId); fam.set(pre, f); }
  const families = [...fam.values()].map((f) => ({ prefix: f.prefix, campaignIds: f.campaignIds, count: f.campaignIds.length, sampleNames: f.names.slice(0, 3), spend7d: Math.round(f.spend7d), reviews: [...f.reviews], suggestedAmbProductId: f.suggestedProductIds.size === 1 ? [...f.suggestedProductIds][0] : null })).sort((a, b) => b.spend7d - a.spend7d);
  counts.families = families.length; counts.unexplained = reviewQueue.filter((r) => r.review === 'UNEXPLAINED').length; counts.review = reviewQueue.length; counts.ambiguous = reviewQueue.filter((r) => r.review === 'AMBIGUOUS').length; counts.strongSuggestions = rows.filter((r) => r.suggestion && !r.suggestion.weak).length;
  return { connected: true, rows: rows.slice(0, limit), reviewQueue: reviewQueue.slice(0, 300), families: families.slice(0, 80), total: rows.length, counts, note: 'التنفيذ الآلي مبيحصلش على حملة SUGGESTED أو UNMAPPED أو CONFLICT أبدًا.' };
}

/** Owner confirms / changes a mapping. Always status MAPPED + a human match_source — the only way a campaign becomes VERIFIED besides a launch job. */
export async function confirmMapping({ adAccountId, campaignId, campaignName = null, ambProductId, userId = null }) {
  const row = await mapping.setMapping({ adAccountId, campaignId, campaignName, ambProductId, status: 'MAPPED', matchSource: 'MANUAL', userId });
  await audit({ actorId: userId, kind: 'OPERATOR_MAPPING', input: { campaignId, ambProductId, action: 'CONFIRM' } });
  return row;
}
/** One explicit human choice for a whole name family. Only campaigns currently in the review queue (never VERIFIED, never excluded) are touched, max 40. */
export async function confirmFamily({ adAccountId, campaignIds, ambProductId, userId = null }) {
  const ids = [...new Set((campaignIds || []).map(String))];
  if (!ids.length || ids.length > 40) { const e = new Error('عدد الحملات لازم يكون بين 1 و40.'); e.status = 400; throw e; }
  const center = await mappingCenter({ adAccountId });
  const queue = new Map(center.reviewQueue.map((r) => [r.campaignId, r]));
  const bad = ids.filter((id) => !queue.has(id));
  if (bad.length) { const e = new Error(`حملات مش في قائمة المراجعة (اتربطت قبل كده أو مش موجودة): ${bad.slice(0, 5).join(', ')}`); e.status = 409; throw e; }
  const prefixes = new Set(ids.map((id) => campaignPrefix(queue.get(id).campaignName) || id));
  if (prefixes.size > 1 && ids.length > 1) { const e = new Error('الحملات لازم تكون من نفس عائلة الاسم.'); e.status = 400; throw e; }
  let n = 0;
  for (const id of ids) { await mapping.setMapping({ adAccountId, campaignId: id, campaignName: queue.get(id).campaignName, ambProductId, status: 'MAPPED', matchSource: 'MANUAL', userId }); n++; }
  await audit({ actorId: userId, kind: 'OPERATOR_MAPPING', input: { action: 'CONFIRM_FAMILY', ambProductId, count: n } });
  return { ok: true, confirmed: n };
}
export async function unmapCampaign({ adAccountId, campaignId, userId = null }) {
  await mapping.removeMapping({ adAccountId, campaignId });
  await audit({ actorId: userId, kind: 'OPERATOR_MAPPING', input: { campaignId, action: 'UNMAP' } });
  return { ok: true };
}
/** Excluding a campaign = a CAMPAIGN-scoped NO_AUTOMATION exception (the same mechanism as every other protection — reversible, audited). */
export async function excludeCampaign({ campaignId, campaignName = null, exclude = true, reason = null, userId = null }) {
  const existing = (await listExceptions({})).filter((e) => e.scope_type === 'CAMPAIGN' && e.scope_id === campaignId && e.types.includes('NO_AUTOMATION'));
  if (!exclude) { for (const e of existing) await removeException({ id: e.id, userId }); return { ok: true, excluded: false }; }
  if (existing.length) return { ok: true, excluded: true, already: true };
  await addException({ scopeType: 'CAMPAIGN', scopeId: campaignId, scopeLabel: campaignName, types: ['NO_AUTOMATION'], reason: reason || 'مستبعدة من مركز ربط الحملات', userId });
  return { ok: true, excluded: true };
}
/** Persists ONLY deterministic suggestions (a Product Key in the name) as SUGGESTED rows — never as MAPPED. Name-similarity guesses are shown but not stored. */
export async function persistDeterministicSuggestions({ adAccountId, userId = null }) {
  const campaigns = (await listCampaignsFromSnapshots({ adAccountId })).filter((c) => ['ACTIVE', 'PAUSED'].includes(c.status));
  const r = await persistStrongSuggestions({ adAccountId, campaigns, userId }); // the ONE resolver; STRONG evidence only; always SUGGESTED, never VERIFIED
  await audit({ actorId: userId, kind: 'OPERATOR_MAPPING', input: { action: 'PERSIST_SUGGESTIONS', ...r } });
  return { saved: r.created + r.updated, ...r };
}

// =====================================================================================================================
// Bulk setup (spec 61)
// =====================================================================================================================
const HEADERS = {
  product: ['product', 'المنتج', 'اسم المنتج', 'product_name', 'name'], code: ['code', 'product_code', 'كود', 'كود المنتج', 'sku'], product_id: ['product_id', 'id', 'رقم المنتج'], store: ['store', 'store_id', 'المتجر'],
  product_cost: ['purchase_cost', 'cost', 'product_cost', 'تكلفة الشراء', 'التكلفة', 'سعر الشراء'], selling_price: ['selling_price', 'price', 'سعر البيع', 'السعر'],
  shipping_cost: ['shipping', 'shipping_cost', 'الشحن'], packaging_cost: ['packaging', 'packaging_cost', 'التغليف'], other_cost: ['other', 'other_cost', 'أخرى', 'تكاليف أخرى'],
  target_cpa: ['target_cpa', 'target cpa', 'هدف cpa'], max_cpa: ['max_cpa', 'max cpa'], hard_stop_cpa: ['hard_stop_cpa', 'hard stop cpa', 'hard stop', 'حد الإيقاف'],
  min_profit: ['min_profit', 'minimum_profit', 'أدنى ربح'], minimum_stock: ['minimum_stock', 'min_stock', 'الحد الأدنى للمخزون', 'أدنى مخزون'], current_stock: ['current_stock', 'stock', 'المخزون', 'المخزون الحالي'],
};
const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
function parseCsv(text) {
  const rows = []; let cur = [], cell = '', q = false;
  const t = String(text || '').replace(/^﻿/, '');
  const delim = (t.split('\n')[0].match(/\t/g) || []).length > (t.split('\n')[0].match(/,/g) || []).length ? '\t' : (t.split('\n')[0].match(/;/g) || []).length > (t.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { cur.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; cur.push(cell); cell = ''; if (cur.some((c) => c.trim() !== '')) rows.push(cur); cur = []; }
    else cell += ch;
  }
  cur.push(cell); if (cur.some((c) => c.trim() !== '')) rows.push(cur);
  return rows;
}
const parseNum = (raw) => { const s = String(raw ?? '').trim().replace(/[٠-٩]/g, (d) => AR_DIGITS[d]).replace(/٫/g, '.').replace(/[,٬\s]/g, ''); if (s === '') return { empty: true }; if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return { invalid: true }; const n = Number(s); return Number.isFinite(n) ? { value: n } : { invalid: true }; }; // anything that is not a plain number is INVALID (never silently treated as empty)

/** CSV text -> validated plan. NOTHING is written. Each row resolves to ONE product (id / code / sku / exact normalised name within the store) or is an ERROR — never fuzzy. */
export async function previewBulkSetup({ csv, maxRows = 500 }) {
  const table = parseCsv(csv);
  if (table.length < 2) return { ok: false, error: 'الملف فاضي أو فيه الهيدر بس.', rows: [], summary: {} };
  const head = table[0].map((h) => normalizeName(h));
  const col = {}; for (const [k, names] of Object.entries(HEADERS)) { const i = head.findIndex((h) => names.map(normalizeName).includes(h)); if (i >= 0) col[k] = i; }
  if (col.product === undefined && col.code === undefined && col.product_id === undefined) return { ok: false, error: 'لازم عمود للمنتج (اسم / كود / رقم).', rows: [], summary: {} };
  const dataRows = table.slice(1, maxRows + 1);
  const products = await prisma.product.findMany({ select: { id: true, product_name: true, product_code: true, sku: true, store_id: true, selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true, current_stock: true, minimum_stock: true } });
  const ambs = new Map((await prisma.ambProduct.findMany({ where: { product_id: { not: null } } })).map((a) => [a.product_id, a]));
  const cfgs = new Map((await prisma.ambOperatorProductConfig.findMany()).map((c) => [`${c.product_id}:${c.store_id}`, c]));
  const seen = new Map();
  const out = [];
  dataRows.forEach((cells, idx) => {
    const line = idx + 2; const get = (k) => (col[k] === undefined ? '' : String(cells[col[k]] ?? '').trim());
    const errors = [], warnings = [], patch = {};
    // resolve the product
    let cands = [];
    if (get('product_id')) cands = products.filter((p) => String(p.id) === get('product_id'));
    else if (get('code')) cands = products.filter((p) => p.product_code && p.product_code.toLowerCase() === get('code').toLowerCase() || p.sku && p.sku.toLowerCase() === get('code').toLowerCase());
    else if (get('product')) cands = products.filter((p) => normalizeName(p.product_name) === normalizeName(get('product')));
    if (get('store')) cands = cands.filter((p) => p.store_id === get('store'));
    let product = null;
    if (cands.length === 1) product = cands[0]; else if (cands.length > 1) errors.push(`المنتج بيطابق ${cands.length} منتجات (${cands.map((p) => `${p.store_id}#${p.id}`).join(', ')}) — حدّد المتجر أو الكود.`); else errors.push('المنتج غير موجود (مفيش تخمين — لازم تطابق دقيق بالاسم/الكود/الرقم).');
    if (product) { if (seen.has(product.id)) errors.push(`المنتج متكرر في الملف (سطر ${seen.get(product.id)}).`); seen.set(product.id, line); }
    // numeric cells: empty = leave untouched; invalid = error
    for (const k of ['product_cost', 'selling_price', 'shipping_cost', 'packaging_cost', 'other_cost', 'target_cpa', 'max_cpa', 'hard_stop_cpa', 'min_profit', 'minimum_stock', 'current_stock']) {
      if (col[k] === undefined) continue; const r = parseNum(get(k));
      if (r.empty) continue; if (r.invalid) { errors.push(`${k}: قيمة غير رقمية "${get(k)}".`); continue; } patch[k] = r.value;
    }
    if (!Object.keys(patch).length) errors.push('مفيش أي قيمة للتحديث في السطر ده.');
    let changes = [];
    if (product && !errors.length) {
      const amb = ambs.get(product.id), cfg = cfgs.get(`${product.id}:${product.store_id}`);
      const v = validateProfilePatch(patch, { selling_price: valOf(amb?.actual_selling_price, product.selling_price), product_cost: valOf(amb?.product_cost, product.product_cost), shipping_cost: valOf(amb?.shipping_cost, product.shipping_cost), packaging_cost: valOf(amb?.packaging_cost, product.packaging_cost), other_cost: valOf(amb?.other_cost, product.other_cost), target_cpa: cfg?.target_cpa ?? amb?.target_cpa ?? null, max_cpa: cfg?.max_cpa ?? amb?.max_cpa ?? null, hard_stop_cpa: cfg?.hard_stop_cpa ?? null, current_stock: product.current_stock, minimum_stock: product.minimum_stock });
      errors.push(...v.errors); warnings.push(...v.warnings);
      const curr = { selling_price: valOf(amb?.actual_selling_price, product.selling_price), product_cost: valOf(amb?.product_cost, product.product_cost), shipping_cost: valOf(amb?.shipping_cost, product.shipping_cost), packaging_cost: valOf(amb?.packaging_cost, product.packaging_cost), other_cost: valOf(amb?.other_cost, product.other_cost), target_cpa: cfg?.target_cpa ?? amb?.target_cpa ?? null, max_cpa: cfg?.max_cpa ?? amb?.max_cpa ?? null, hard_stop_cpa: cfg?.hard_stop_cpa ?? null, min_profit: cfg?.min_profit ?? amb?.min_profit ?? null, current_stock: product.current_stock, minimum_stock: product.minimum_stock };
      changes = Object.entries(v.clean).map(([k, to]) => ({ field: k, from: curr[k] ?? null, to })).filter((c) => c.from !== c.to);
      if (!changes.length && !errors.length) warnings.push('مفيش تغيير فعلي (نفس القيم الحالية).');
    }
    out.push({ line, product: product ? { id: product.id, name: product.product_name, storeId: product.store_id } : null, input: get('product') || get('code') || get('product_id'), patch, changes, errors, warnings, status: errors.length ? 'ERROR' : warnings.length ? 'WARN' : 'OK' });
  });
  const summary = { rows: out.length, ok: out.filter((r) => r.status === 'OK').length, warn: out.filter((r) => r.status === 'WARN').length, error: out.filter((r) => r.status === 'ERROR').length, truncated: table.length - 1 > maxRows };
  return { ok: true, columns: Object.keys(col), rows: out, summary };
}

/** Applies a previewed CSV. Re-validates; refuses everything if any row is an ERROR (unless skipInvalid), then writes row by row through the canonical saver. */
export async function applyBulkSetup({ csv, skipInvalid = false, userId = null }) {
  const plan = await previewBulkSetup({ csv });
  if (!plan.ok) { const e = new Error(plan.error); e.status = 400; throw e; }
  if (plan.summary.error && !skipInvalid) { const e = new Error(`فيه ${plan.summary.error} سطر فيه أخطاء — صلّحهم أو فعّل "تجاهل الصفوف الغلط". مفيش حاجة اتحفظت.`); e.status = 400; e.details = plan.rows.filter((r) => r.status === 'ERROR').map((r) => ({ line: r.line, errors: r.errors })); throw e; }
  const results = [];
  for (const r of plan.rows) {
    if (r.status === 'ERROR') { results.push({ line: r.line, status: 'SKIPPED', errors: r.errors }); continue; }
    if (!r.changes.length) { results.push({ line: r.line, status: 'UNCHANGED' }); continue; }
    try { await saveProductProfile({ productId: r.product.id, patch: r.patch, userId }); results.push({ line: r.line, status: 'SAVED', productId: r.product.id, changes: r.changes.length }); }
    catch (err) { results.push({ line: r.line, status: 'FAILED', error: err.message }); }
  }
  const summary = { saved: results.filter((x) => x.status === 'SAVED').length, skipped: results.filter((x) => x.status === 'SKIPPED').length, unchanged: results.filter((x) => x.status === 'UNCHANGED').length, failed: results.filter((x) => x.status === 'FAILED').length };
  await audit({ actorId: userId, kind: 'OPERATOR_BULK_SETUP', input: { summary, lines: results.filter((x) => x.status === 'SAVED').map((x) => x.line).slice(0, 200) } });
  return { ok: true, summary, results };
}

/** CSV pre-filled with every active AMB product (blank cells) — the user fills the numbers, uploads, previews, applies. */
export async function bulkSetupTemplate() {
  const list = await readinessList({ heavy: false });
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['product_id', 'product', 'store', 'purchase_cost', 'selling_price', 'shipping', 'packaging', 'other', 'target_cpa', 'max_cpa', 'hard_stop_cpa', 'min_profit', 'current_stock', 'minimum_stock'];
  const lines = [head.join(',')];
  for (const p of list) lines.push([p.productId, p.name, p.storeId, '', '', '', '', '', '', '', '', '', '', ''].map(esc).join(','));
  return lines.join('\n');
}

// =====================================================================================================================
// Setup wizard (spec 117)
// =====================================================================================================================
export async function setupWizard({ adAccountId = null, heavy = false } = {}) {
  const [g, cfg, rules, decisions] = await Promise.all([globalReadiness({ heavy, adAccountId }), getOperatorConfig(), prisma.ambOperatorRule.findMany({ where: { enabled: true }, select: { id: true } }), prisma.ambOperatorDecision.count()]);
  const t = g.products.total || 1;
  const steps = [
    { key: 'mapping', title: 'ربط الحملات', done: g.campaigns.unmapped === 0 && g.campaigns.suggested === 0 && (g.campaigns.mapped || 0) > 0, progress: g.campaigns.mapped == null ? null : { done: g.campaigns.mapped, total: (g.campaigns.mapped || 0) + (g.campaigns.suggested || 0) + (g.campaigns.unmapped || 0) }, hint: g.campaigns.unmapped ? `${g.campaigns.unmapped} حملة غير مربوطة` : g.campaigns.suggested ? `${g.campaigns.suggested} ربط مقترح محتاج تأكيد` : 'تمام', tab: 'mapping' },
    { key: 'economics', title: 'اقتصاديات المنتجات', done: g.missingEconomics === 0 && g.products.total > 0, progress: { done: g.products.total - g.missingEconomics, total: g.products.total }, hint: g.missingEconomics ? `${g.missingEconomics} منتج بدون سعر/تكلفة` : 'تمام', tab: 'readiness' },
    { key: 'inventory', title: 'المخزون', done: g.missingStock === 0 && g.products.total > 0, progress: { done: g.products.total - g.missingStock, total: g.products.total }, hint: g.missingStock ? `${g.missingStock} منتج مخزونه غير مسجّل` : 'تمام', tab: 'readiness' },
    { key: 'rules', title: 'القواعد', done: rules.length > 0, progress: { done: rules.length, total: Math.max(1, rules.length) }, hint: rules.length ? `${rules.length} قاعدة مفعّلة` : 'مفيش قاعدة مفعّلة — ابدأ من قالب', tab: 'rules' },
    { key: 'shadow', title: 'محاكاة Shadow', done: decisions > 0, progress: { done: Math.min(decisions, 1), total: 1 }, hint: decisions ? `${decisions} قرار مسجّل` : 'شغّل "لو شغلت الأوتوميشن دلوقتي؟" أو قيّم الآن', tab: 'control' },
    { key: 'approval', title: 'جاهزية وضع "بموافقتي"', done: g.products.ready > 0 && rules.length > 0 && decisions > 0, progress: { done: g.products.ready, total: g.products.total }, hint: g.products.ready ? `${g.products.ready} منتج READY` : 'محتاج منتج واحد READY على الأقل', tab: 'control' },
  ];
  const done = steps.filter((s) => s.done).length;
  return { steps, progress: { done, total: steps.length, pct: Math.round((done / steps.length) * 100) }, mode: cfg.mode, note: 'الوصول لـ100% مبيفعّلش Autopilot — Autopilot ليه بوابة تفعيل منفصلة وقرارك انت.' };
}
