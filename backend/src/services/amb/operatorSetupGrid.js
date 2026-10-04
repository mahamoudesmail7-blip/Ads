// 🤖 AI Operator — SETUP GRID: every product in ONE editable table (economics, CPA limits, zero-order stop, stock, mapping status, readiness).
//   buildSetupGrid  -> rows pre-filled ONLY with trusted values that already exist (owner/catalogue price, stored costs, stored CPAs...); everything else MISSING (null)
//   validateGrid    -> per-row errors/warnings (same validators as the profile + CSV paths)
//   previewGrid     -> before -> after per cell, nothing written
//   applyGrid       -> writes through the CANONICAL savers only (saveProductProfile / setProductOverride), then recomputes readiness and runs a
//                      READ-ONLY Shadow simulation for the products that are now READY. No Meta call, no mode change, no mapping change.
// Rules that never bend:
//   * a BLANK cell means "leave as is" — it is never written as 0 and never clears an existing value from here;
//   * a price CONFLICT is shown with both numbers and no value is picked; only a value the owner types resolves it;
//   * a suggestion from the store catalogue is displayed, never auto-filled;
//   * nothing here can VERIFY a campaign mapping.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { readinessList, validateProfilePatch, saveProductProfile, computeReadiness } from './operatorReadiness.js';
import { computeOperatorEconomics } from './operatorGuards.js';
import { loadProductUniverse } from './operatorCoverage.js';
import { resolveSellingPrice, loadStoreCatalogIndex } from './productPriceResolver.js';
import { getOperatorConfig, setProductOverride, validateZeroOrderOverride, ZERO_ORDER_MODES } from './operatorStore.js';
import { evaluateOperator } from './operatorEngine.js';
import { summarizeSimulation } from './operatorOps.js';

const pos = (v) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : null; };
const first = (a, b) => pos(a) ?? pos(b);
const srcOf = (a, b) => (pos(a) != null ? 'AMB' : pos(b) != null ? 'CATALOG' : null);
const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const num = (v) => { const n = Number(String(v).replace(/,/g, '').trim()); return Number.isFinite(n) ? n : NaN; };

/** grid cell key -> profile-patch key */
export const GRID_FIELDS = {
  selling_price: 'selling_price', purchase_cost: 'product_cost', shipping: 'shipping_cost', packaging: 'packaging_cost',
  target_cpa: 'target_cpa', hard_stop_cpa: 'hard_stop_cpa', current_stock: 'current_stock', minimum_stock: 'minimum_stock',
};
export const GRID_COLUMNS = ['product', 'store', 'selling_price', 'purchase_cost', 'shipping', 'packaging', 'target_cpa', 'hard_stop_cpa', 'zero_order', 'current_stock', 'minimum_stock', 'mapping', 'readiness'];

async function loadBundles(productIds) {
  const products = new Map((await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, product_name: true, store_id: true, selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true, current_stock: true, minimum_stock: true } })).map((p) => [p.id, p]));
  const ambs = new Map((await prisma.ambProduct.findMany({ where: { product_id: { in: productIds } } })).map((a) => [a.product_id, a]));
  const cfgs = new Map((await prisma.ambOperatorProductConfig.findMany({ where: { product_id: { in: productIds } } })).map((c) => [`${c.product_id}:${c.store_id}`, c]));
  return { products, ambs, cfgs };
}

/** The values that exist TODAY for a product, in the patch vocabulary (null = missing). */
function currentValues({ product, amb, cfg }) {
  return {
    selling_price: first(amb?.actual_selling_price, product.selling_price), product_cost: first(amb?.product_cost, product.product_cost),
    shipping_cost: first(amb?.shipping_cost, product.shipping_cost), packaging_cost: first(amb?.packaging_cost, product.packaging_cost), other_cost: first(amb?.other_cost, product.other_cost),
    target_cpa: cfg?.target_cpa ?? amb?.target_cpa ?? null, max_cpa: cfg?.max_cpa ?? amb?.max_cpa ?? null, hard_stop_cpa: cfg?.hard_stop_cpa ?? null,
    current_stock: product.current_stock ?? null, minimum_stock: product.minimum_stock ?? cfg?.min_stock ?? null,
  };
}

// =====================================================================================================================
/**
 * Every REAL catalogue product of every store (Product Master = source of truth), with its store, advertising state, EO link and readiness.
 * A product with no campaign is NOT_ADVERTISED — never dropped. A product with no AMB record is listed too (operatorLinked=false); its AMB record is
 * created only by an explicit Apply. Readiness here is the LIGHT one (data quality is checked on demand).
 */
export async function buildSetupGrid() {
  const u = await loadProductUniverse();
  const config = await getOperatorConfig();
  const overrides = config.limits.productOverrides || {};
  const rows = u.products.map((r) => {
    const { product, amb, cfg } = r;
    const cur = currentValues({ product, amb, cfg });
    const pr = resolveSellingPrice({ product, ambProduct: amb, storeCatalog: u.eo[product.store_id]?.byKey || null });
    const econ = computeOperatorEconomics({ product, ambProduct: amb, opCfg: cfg, priceResolution: pr });
    const zo = overrides[String(product.id)]?.zeroOrder || null;
    const campaigns = [...Array(r.verifiedCampaigns).fill({ verified: true }), ...Array(r.suggestedCampaigns).fill({ verified: false })];
    const rd = computeReadiness({ product, amb, opCfg: cfg, econ, campaigns, dq: undefined, zeroOrder: zo, ambLinked: !!amb });
    return {
      productId: product.id, ambProductId: amb?.id ?? null, operatorLinked: !!amb, name: product.product_name, store: product.store_id,
      advertising: r.advertising, catalogLink: r.catalogLink, orders30d: r.orders30d, pmcProfiles: r.pmcProfiles,
      price: {
        value: pr.status === 'CONFLICT' ? null : cur.selling_price, source: pr.status === 'CONFLICT' ? null : srcOf(amb?.actual_selling_price, product.selling_price),
        status: pr.status, conflict: pr.status === 'CONFLICT' ? pr.conflict : null, reason: pr.reason || null,
        suggestion: pr.status === 'FROM_STORE_CATALOG' ? { value: pr.value, source: 'STORE_CATALOG' } : null,
      },
      purchase_cost: cur.product_cost, shipping: cur.shipping_cost, packaging: cur.packaging_cost, target_cpa: cur.target_cpa, hard_stop_cpa: cur.hard_stop_cpa,
      zero_order: zo ? { mode: zo.mode, value: zo.mode === 'FIXED_SPEND' ? zo.fixedSpend ?? null : zo.multiple ?? null } : null,
      current_stock: cur.current_stock, minimum_stock: cur.minimum_stock,
      mapping: { state: r.verifiedCampaigns ? 'VERIFIED' : r.suggestedCampaigns ? 'SUGGESTED' : 'UNMAPPED', verified: r.verifiedCampaigns, suggested: r.suggestedCampaigns },
      readiness: { state: rd.state, icon: rd.icon, missing: rd.missing.map((x) => ({ key: x.key, label: x.label, severity: x.severity })) },
    };
  });
  const order = { ADVERTISED: 0, SUGGESTED_ONLY: 1, NOT_ADVERTISED: 2 };
  rows.sort((x, y) => x.store.localeCompare(y.store) || order[x.advertising] - order[y.advertising] || y.orders30d - x.orders30d || x.name.localeCompare(y.name));
  const bucket = () => ({ total: 0, advertised: 0, notAdvertised: 0, suggestedOnly: 0, READY: 0, PARTIAL: 0, BLOCKED: 0, notLinked: 0, priceConflicts: 0, priceMissing: 0, withOrders30d: 0 });
  const counts = { ...bucket(), byStore: {} };
  for (const x of rows) {
    for (const t of [counts, (counts.byStore[x.store] ||= bucket())]) {
      t.total++; t[x.readiness.state]++;
      if (x.advertising === 'ADVERTISED') t.advertised++; else if (x.advertising === 'SUGGESTED_ONLY') t.suggestedOnly++; else t.notAdvertised++;
      if (!x.operatorLinked) t.notLinked++; if (x.price.status === 'CONFLICT') t.priceConflicts++; else if (x.price.value == null) t.priceMissing++; if (x.orders30d > 0) t.withOrders30d++;
    }
  }
  return {
    columns: GRID_COLUMNS, zeroOrderModes: ZERO_ORDER_MODES, stores: u.stores.map((s) => s.id), rows, counts,
    note: 'الجدول بيعرض كل المنتجات الحقيقية في الكتالوج (Product Master) لكل متجر — حتى اللي ملهاش حملات (NOT_ADVERTISED). الخانة الفاضية = "سيبها زي ما هي" (مش بتتحول لصفر ومش بتمسح قيمة موجودة). القيم المعروضة كلها موجودة فعلًا في النظام — مفيش حاجة اتملت بتخمين.',
  };
}

// =====================================================================================================================
/** Normalises + validates the submitted changes; writes nothing. changes = [{ productId, values:{<grid key>:number|''}, zeroOrder:{mode, value}|null }] */
export async function validateGrid({ changes }) {
  if (!Array.isArray(changes) || !changes.length) { const e = new Error('مفيش تغييرات للمراجعة.'); e.status = 400; throw e; }
  if (changes.length > 200) { const e = new Error('أقصى عدد 200 منتج في المرة.'); e.status = 400; throw e; }
  const ids = [...new Set(changes.map((c) => Number(c.productId)).filter(Number.isInteger))];
  const { products, ambs, cfgs } = await loadBundles(ids);
  const config = await getOperatorConfig();
  const overrides = config.limits.productOverrides || {};
  const catalogs = {}; for (const s of new Set([...products.values()].map((p) => p.store_id).filter(Boolean))) catalogs[s] = await loadStoreCatalogIndex(s);
  const seen = new Set();
  const rows = changes.map((c) => {
    const errors = [], warnings = [], diff = [];
    const product = products.get(Number(c.productId));
    if (!product) return { productId: c.productId, name: null, status: 'ERROR', errors: ['المنتج غير موجود.'], warnings, changes: [], patch: {}, zeroOrder: null };
    if (seen.has(product.id)) errors.push('المنتج متكرر في نفس الطلب.'); seen.add(product.id);
    const amb = ambs.get(product.id), cfg = cfgs.get(`${product.id}:${product.store_id}`);
    const cur = currentValues({ product, amb, cfg });
    const patch = {};
    for (const [gk, pk] of Object.entries(GRID_FIELDS)) {
      const raw = c.values?.[gk];
      if (isBlank(raw)) continue; // blank = untouched (never 0, never a clear)
      const n = num(raw);
      if (!Number.isFinite(n)) { errors.push(`${gk}: قيمة غير رقمية "${raw}".`); continue; }
      patch[pk] = n;
    }
    // validators shared with the profile / CSV paths (ranges, Hard Stop >= Target, profit warnings, stock < minimum ...)
    const v = validateProfilePatch(patch, cur);
    errors.push(...v.errors); warnings.push(...v.warnings);
    for (const [pk, to] of Object.entries(v.clean)) if (to !== null && to !== cur[pk]) diff.push({ field: pk, from: cur[pk] ?? null, to });
    // a typed price resolves a CONFLICT — say what it is being compared with
    if (patch.selling_price != null) {
      const pr = resolveSellingPrice({ product, ambProduct: amb, storeCatalog: catalogs[product.store_id] || null });
      if (pr.sources.storeCatalog != null && Math.abs(pr.sources.storeCatalog - patch.selling_price) > 0.5) warnings.push(`السعر المُدخل (${patch.selling_price}) مختلف عن سعر كتالوج المتجر (${pr.sources.storeCatalog}).`);
      if (pr.status === 'CONFLICT') warnings.push('إدخالك هيحسم تعارض السعر — اتأكد من الرقم الصحيح.');
    }
    // zero-order stop (per product)
    let zeroOrder = null;
    const z = c.zeroOrder;
    if (z && !isBlank(z.mode)) {
      const base = overrides[String(product.id)]?.zeroOrder || {};
      const raw = { ...base, mode: z.mode };
      delete raw.fixedSpend; delete raw.multiple;
      if (z.mode === 'FIXED_SPEND') raw.fixedSpend = isBlank(z.value) ? undefined : num(z.value);
      if (z.mode === 'TARGET_CPA_MULTIPLE') raw.multiple = isBlank(z.value) ? undefined : num(z.value);
      const zv = validateZeroOrderOverride(raw);
      errors.push(...zv.errors.map((m) => `حد الإيقاف: ${m}`));
      if (!zv.errors.length) {
        zeroOrder = zv.clean;
        const before = overrides[String(product.id)]?.zeroOrder || null;
        const same = before && before.mode === zeroOrder.mode && (before.fixedSpend ?? null) === (zeroOrder.fixedSpend ?? null) && (before.multiple ?? null) === (zeroOrder.multiple ?? null);
        if (!same) diff.push({ field: 'zero_order', from: before ? (before.mode === 'FIXED_SPEND' ? `ثابت ${before.fixedSpend}` : `× ${before.multiple}`) : null, to: zeroOrder.mode === 'FIXED_SPEND' ? `ثابت ${zeroOrder.fixedSpend}` : `× ${zeroOrder.multiple}` });
        else zeroOrder = null;
        if (zeroOrder?.mode === 'TARGET_CPA_MULTIPLE' && (patch.target_cpa ?? cur.target_cpa) == null) warnings.push('المضاعف محتاج Target CPA — لحد ما تتحدد، حد الإيقاف هيفضل ممنوع.');
      }
    } else if (z && !isBlank(z.value)) errors.push('اختار طريقة حد الإيقاف الأول.');
    if (!errors.length && !diff.length) warnings.push('مفيش تغيير فعلي.');
    return { productId: product.id, name: product.product_name, store: product.store_id, status: errors.length ? 'ERROR' : diff.length ? (warnings.length ? 'WARN' : 'OK') : 'UNCHANGED', errors, warnings, changes: diff, patch, zeroOrder };
  });
  const summary = { rows: rows.length, ok: rows.filter((r) => r.status === 'OK').length, warn: rows.filter((r) => r.status === 'WARN').length, error: rows.filter((r) => r.status === 'ERROR').length, unchanged: rows.filter((r) => r.status === 'UNCHANGED').length, cells: rows.reduce((a, r) => a + r.changes.length, 0) };
  return { ok: summary.error === 0, rows, summary };
}

/** Preview = validation + the before/after list (identical computation, nothing written). */
export const previewGrid = validateGrid;

// =====================================================================================================================
export async function applyGrid({ changes, skipInvalid = false, userId = null }) {
  const plan = await validateGrid({ changes });
  if (plan.summary.error && !skipInvalid) { const e = new Error(`فيه ${plan.summary.error} منتج فيه أخطاء — صلّحهم أو فعّل "تجاهل الصفوف الغلط". مفيش حاجة اتحفظت.`); e.status = 400; e.details = plan.rows.filter((r) => r.status === 'ERROR').map((r) => ({ productId: r.productId, name: r.name, errors: r.errors })); throw e; }
  const results = [];
  for (const r of plan.rows) {
    if (r.status === 'ERROR') { results.push({ productId: r.productId, name: r.name, status: 'SKIPPED', errors: r.errors }); continue; }
    if (!r.changes.length) { results.push({ productId: r.productId, name: r.name, status: 'UNCHANGED' }); continue; }
    try {
      if (Object.keys(r.patch).length) await saveProductProfile({ productId: r.productId, patch: r.patch, userId });
      if (r.zeroOrder) await setProductOverride({ productId: r.productId, zeroOrder: r.zeroOrder, userId });
      results.push({ productId: r.productId, name: r.name, status: 'SAVED', cells: r.changes.length });
    } catch (err) { results.push({ productId: r.productId, name: r.name, status: 'FAILED', error: err.message }); }
  }
  const summary = { saved: results.filter((x) => x.status === 'SAVED').length, skipped: results.filter((x) => x.status === 'SKIPPED').length, unchanged: results.filter((x) => x.status === 'UNCHANGED').length, failed: results.filter((x) => x.status === 'FAILED').length };
  try { await prisma.aiAuditLog.create({ data: { actor_id: userId || null, kind: 'OPERATOR_SETUP_GRID', action: 'EXECUTE', input_json: JSON.stringify({ summary, products: results.filter((x) => x.status === 'SAVED').map((x) => x.productId).slice(0, 200) }).slice(0, 4000), success: true } }); }
  catch (err) { logger.error('[operatorSetupGrid] audit write failed', { message: err.message }); }

  // recompute readiness for what was touched, then simulate (read-only) for the products that are now READY
  const touched = new Set(results.filter((x) => x.status === 'SAVED').map((x) => x.productId));
  const list = await readinessList({ heavy: false, heavyFor: touched }); // data quality is checked ONLY for the products that were just edited
  const fromList = new Map(list.filter((p) => touched.has(p.productId)).map((p) => [p.productId, { productId: p.productId, name: p.name, state: p.readiness.state, missing: p.readiness.missing.map((m) => m.label) }]));
  const rest = [...touched].filter((id) => !fromList.has(id));
  if (rest.length) { const g = await buildSetupGrid(); for (const r of g.rows) if (rest.includes(r.productId)) fromList.set(r.productId, { productId: r.productId, name: r.name, state: r.readiness.state, missing: r.readiness.missing.map((m) => m.label) }); }
  const readinessAfter = [...fromList.values()];
  const readyIds = readinessAfter.filter((p) => p.state === 'READY').map((p) => p.productId);
  const shadow = readyIds.length ? await shadowForProducts({ productIds: readyIds }) : { skipped: 'NO_READY_PRODUCTS', message: 'مفيش منتج وصل لحالة READY بعد الحفظ — Shadow Simulation اتخطّت.' };
  return { ok: true, summary, results, readinessAfter, shadow, wroteMeta: false };
}

// =====================================================================================================================
/** READ-ONLY Shadow simulation limited to the verified campaigns of the given (READY) products. Never persists a decision, never calls Meta. */
export async function shadowForProducts({ productIds }) {
  const ids = [...new Set((productIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return { skipped: 'NO_PRODUCTS', message: 'مفيش منتجات.' };
  const list = await readinessList({ heavy: false, heavyFor: new Set(ids) });
  const ready = list.filter((p) => ids.includes(p.productId) && p.readiness.state === 'READY');
  const notReady = list.filter((p) => ids.includes(p.productId) && p.readiness.state !== 'READY').map((p) => ({ productId: p.productId, name: p.name, state: p.readiness.state }));
  if (!ready.length) return { skipped: 'NO_READY_PRODUCTS', message: 'مفيش منتج READY — الـ Shadow بيشتغل على المنتجات الجاهزة بس.', notReady };
  const rules = (await prisma.ambOperatorRule.findMany({ where: { enabled: true }, select: { id: true } }));
  if (!rules.length) return { skipped: 'NO_ENABLED_RULES', message: 'مفيش قواعد مفعّلة — فعّل قاعدة الأول (الخطوة 5) وبعدها يتحاكى القرار.', readyProducts: ready.map((p) => ({ productId: p.productId, name: p.name })), notReady };
  const maps = await prisma.ambProductCampaignMap.findMany({ where: { amb_product_id: { in: ready.map((p) => p.ambProductId) }, status: 'MAPPED' }, select: { campaign_id: true } });
  const launched = await prisma.ambLaunchCampaign.findMany({ where: { meta_campaign_id: { not: null }, job: { product_id: { in: ready.map((p) => p.productId) } } }, select: { meta_campaign_id: true } });
  const campaignIds = [...new Set([...maps.map((m) => m.campaign_id), ...launched.map((l) => l.meta_campaign_id)])];
  if (!campaignIds.length) return { skipped: 'NO_VERIFIED_CAMPAIGNS', message: 'المنتجات READY بس مفيهاش حملات VERIFIED.', readyProducts: ready.map((p) => ({ productId: p.productId, name: p.name })), notReady };
  const r = await evaluateOperator({ persist: false, only: { campaignIds }, autoExecute: false });
  return { simulation: true, wrote: false, ...summarizeSimulation(r), readyProducts: ready.map((p) => ({ productId: p.productId, name: p.name })), notReady, campaigns: campaignIds.length };
}

/** Re-computes readiness WITH the data-quality check for the given products (all when none given). Read-only. */
export async function recomputeReadiness({ productIds = null } = {}) {
  const ids = productIds?.length ? new Set(productIds.map(Number)) : null;
  const list = await readinessList({ heavy: !ids, heavyFor: ids });
  return list.filter((p) => !ids || ids.has(p.productId)).map((p) => ({ productId: p.productId, name: p.name, state: p.readiness.state, icon: p.readiness.icon, missing: p.readiness.missing.map((m) => ({ key: m.key, label: m.label, severity: m.severity, pending: m.pending })) }));
}
