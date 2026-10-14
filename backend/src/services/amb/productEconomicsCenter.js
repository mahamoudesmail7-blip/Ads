// «اقتصاديات المنتجات» (AMB V2) — ONE place to see a product's REAL numbers and enter what is missing, then check readiness, simulate, and (from the existing, gated activation) switch it to AUTOMATIC.
// It adds NO new rules: economics come from the canonical engines (computeOperatorEconomics / resolveSellingPrice / productFactsBatch), policies from productPolicy (draft → activate, AUTOMATIC refused on an incomplete product),
// readiness from automationReadiness, the simulation from previewPolicy. This module only COMPOSES them and writes DRAFT-level data:
//   · economics  → catalogue Product + AmbProduct (cost / shipping / packaging / other / stock / minimum stock) — numbers the owner typed, never defaults
//   · CPA limits → AmbOperatorProductConfig (target / max / hard stop) through the existing upsertProductConfig
//   · policy     → a product-policy DRAFT through the existing saveDraft (it changes NOTHING until the owner activates it)
// Rules of the house: nothing is assumed (a missing number stays «غير متوفر»); every product has its OWN policy; a product that already has an ACTIVE policy (Hair-Cap) is LOCKED here — its live settings are never touched from this screen.
import { prisma } from '../../prisma.js';
import { readinessList } from './operatorReadiness.js';
import { listProductRules, getProductPolicy, saveDraft, previewPolicy, normalizePolicy, validatePolicy, overlayGlobal, getGlobalRules, loadActivePolicies } from './productPolicy.js';
import { loadProductFactsBatch } from './productFactsBatch.js';
import { productAutomationReadiness, evaluateReadiness } from './automationReadiness.js';
import { computeOperatorEconomics } from './operatorGuards.js';
import { resolveSellingPrice, loadStoreCatalogIndex } from './productPriceResolver.js';
import { getOperatorConfig, ownerPriceOf, upsertProductConfig } from './operatorStore.js';
import { updateProduct as updateAmbProduct } from './ambProducts.js';
import { getBudgetPolicy } from './budgetOptimizer.js';
import { getPausePolicy } from './pausePolicy.js';
import { getOpenCpaPolicy } from './openCpaPolicy.js';

/** the owner's six (2026-10-14): Selicon · Mini Camera · Radio · Air-Blower · Backpack · Remote Car — the screen can also show any other product with campaigns (scope=all) */
export const PRIORITY_PRODUCT_IDS = Object.freeze([159, 250, 323, 320, 443, 257]);
// the house ratios of the Hair-Cap policy, shown ONLY as a suggestion derived from a REAL max CPA — never applied by itself
export const SUGGEST_RATIOS = Object.freeze({ scale: 0.6, reduce: 0.9, hardStop: 1 });

const fail = (status, message, code) => { const e = new Error(message); e.status = status; if (code) e.code = code; return e; };
const n = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);
const pos = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };
const r0 = (v) => (v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));
const audit = (userId, kind, input) => prisma.aiAuditLog.create({ data: { actor_id: userId ?? null, kind, action: 'EXECUTE', input_json: JSON.stringify(input).slice(0, 3500), success: true } }).catch(() => {});

export function suggestLines(maxCpa) {
  const m = pos(maxCpa); if (m == null) return null;
  return { basis: m, scale: r0(m * SUGGEST_RATIOS.scale), reduce: r0(m * SUGGEST_RATIOS.reduce), hardStop: r0(m * SUGGEST_RATIOS.hardStop), note: 'مقترح بنفس نسب Hair-Cap (0.6 / 0.9 / 1.0 من أعلى CPA) — مش مطبّق إلا لما تحفظه بنفسك' };
}

/** Pure. Real profitability from REAL inputs; every field is null (never 0) when something it needs is missing. */
export function profitView({ econ, perf }) {
  const m = econ?.complete ? econ.unitMargin : null; const out = { unitMargin: m, breakEvenCpa: m, marginPct: m != null && econ.price > 0 ? Math.round((m / econ.price) * 1000) / 10 : null, profit7: null, profit30: null, state: econ?.profitState || 'UNKNOWN' };
  if (m != null && perf) { if (perf.orders7 != null) out.profit7 = r0(perf.orders7 * m - (perf.spend7 || 0)); if (perf.orders30 != null) out.profit30 = r0(perf.orders30 * m - (perf.spend30 || 0)); }
  out.note = 'تقديري: أوردرات Meta × هامش الوحدة − الصرف (قبل المرتجعات/RTO)'; return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the board
// ---------------------------------------------------------------------------------------------------------------------------------------------
export async function getProductEconomicsBoard({ scope = 'six', ids = null, now = new Date(), deps = {} } = {}) {
  const [rows, rules, cfg, gl, pause, open] = await Promise.all([deps.rows || readinessList({}), deps.rules || listProductRules({ now }), deps.config || getOperatorConfig(), getGlobalRules().catch(() => ({ active: null })), getPausePolicy(), getOpenCpaPolicy().catch(() => null)]);
  const ruleBy = new Map(rules.map((r) => [Number(r.productId), r])); const rowBy = new Map(rows.map((r) => [Number(r.productId), r]));
  const activeIds = [...(await loadActivePolicies(cfg.limits)).keys()].map((k) => Number(String(k).split(':').pop())).filter(Number.isInteger); // products already running a policy (from the policies themselves, not from campaign mappings): always shown, but LOCKED
  const want = ids?.length ? ids.map(Number) : scope === 'all' ? [...new Set([...rows.map((r) => Number(r.productId))])] : [...PRIORITY_PRODUCT_IDS];
  const idList = [...new Set([...want, ...activeIds])].filter((x) => rowBy.has(x) || ruleBy.has(x) || activeIds.includes(x));
  const [products, ambs, opCfgs, { facts }] = await Promise.all([prisma.product.findMany({ where: { id: { in: idList } }, select: { id: true, product_name: true, store_id: true, selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true, current_stock: true, minimum_stock: true } }), prisma.ambProduct.findMany({ where: { product_id: { in: idList } } }), prisma.ambOperatorProductConfig.findMany({ where: { product_id: { in: idList } } }), loadProductFactsBatch(idList, { now })]);
  const pBy = new Map(products.map((p) => [p.id, p])); const aBy = new Map(ambs.map((a) => [a.product_id, a])); const cBy = new Map(opCfgs.map((c) => [`${c.product_id}|${c.store_id}`, c]));
  const catalogs = {}; for (const sid of new Set(products.map((p) => p.store_id).filter(Boolean))) catalogs[sid] = await loadStoreCatalogIndex(sid).catch(() => null);
  const cards = [];
  for (const id of idList) {
    const product = pBy.get(id); const row = rowBy.get(id) || null; const rule = ruleBy.get(id) || null; if (!product) continue;
    const amb = aBy.get(id) || null; const opCfg = cBy.get(`${id}|${product.store_id}`) || null;
    const priceRes = resolveSellingPrice({ product, ambProduct: amb, storeCatalog: catalogs[product.store_id] || null, ownerConfirmed: ownerPriceOf(cfg, id) });
    const perf = perfOf(rule); const econ = computeOperatorEconomics({ product, ambProduct: amb, opCfg, observedCpa: perf.cpa30, priceResolution: priceRes });
    const pol = await getProductPolicy({ productId: id, storeId: product.store_id }); const locked = !!pol.active;
    const eff = pol.active ? pol.effective : pol.draft ? overlayGlobal(gl.active, pol.draft) : null;
    const rd = evaluateReadiness({ row, policy: eff, pause, open, minStockRequired: open?.enabled ? open.minStock : null });
    const fact = facts.get(id); const maxCpa = opCfg?.max_cpa ?? amb?.max_cpa ?? econ.calculatedMaxCpa ?? null;
    const inp = (v, entered) => ({ value: entered ? v : null, entered: !!entered });
    cards.push({
      productId: id, ambProductId: amb?.id ?? null, storeId: product.store_id, name: product.product_name, locked, lockedReason: locked ? 'عليه سياسة مفعّلة (شغّال) — إعداداته الحية مقفولة من هنا. عدّلها من «قواعد المنتجات» عن قصد.' : null, isPriority: PRIORITY_PRODUCT_IDS.includes(id),
      economics: { price: { value: econ.price || null, status: priceRes.status, source: priceRes.source, conflict: priceRes.conflict || null, reason: priceRes.reason || null }, cost: inp(pos(amb?.product_cost) ?? pos(product.product_cost), pos(amb?.product_cost) ?? pos(product.product_cost)), shipping: inp(pos(amb?.shipping_cost) ?? pos(product.shipping_cost), pos(amb?.shipping_cost) ?? pos(product.shipping_cost)), packaging: inp(pos(amb?.packaging_cost) ?? pos(product.packaging_cost), pos(amb?.packaging_cost) ?? pos(product.packaging_cost)), other: inp(pos(amb?.other_cost) ?? pos(product.other_cost), pos(amb?.other_cost) ?? pos(product.other_cost)), complete: !!econ.complete },
      profit: profitView({ econ, perf }), performance: perf, campaigns: { total: rule?.campaignCount ?? 0, active: rule?.activeCampaigns ?? 0, activeBudgetNote: null },
      stock: { current: fact?.stock?.current ?? null, minimum: fact?.stock?.minimum ?? null, status: fact?.stock?.status || 'STOCK_UNKNOWN', manualCurrent: product.current_stock ?? null, manualMinimum: product.minimum_stock ?? null },
      cpa: { target: opCfg?.target_cpa ?? amb?.target_cpa ?? null, max: opCfg?.max_cpa ?? amb?.max_cpa ?? null, hardStop: opCfg?.hard_stop_cpa ?? null, calculatedMax: econ.calculatedMaxCpa ?? null, effectiveMax: maxCpa, suggestion: suggestLines(maxCpa) },
      policy: { status: pol.status, mode: pol.active?.mode || pol.draft?.mode || null, version: pol.version ?? null, draft: pol.draft, active: pol.active, form: toForm(pol.draft || pol.active) },
      readiness: { ready: rd.ready, state: rd.state, checks: rd.checks, missing: rd.missing },
    });
  }
  cards.sort((a, b) => Number(a.locked) - Number(b.locked) || PRIORITY_PRODUCT_IDS.indexOf(a.productId) - PRIORITY_PRODUCT_IDS.indexOf(b.productId));
  return { generatedAt: now.toISOString(), scope, count: cards.length, products: cards, summary: { ready: cards.filter((c) => !c.locked && c.readiness.ready).length, blocked: cards.filter((c) => !c.locked && !c.readiness.ready).length, locked: cards.filter((c) => c.locked).length },
    note: 'كل الأرقام من بياناتك الفعلية. الخانة الفاضية = غير متوفر (مش صفر). المنتج المقفول شغّال AUTOMATIC ومش بيتعدل من هنا.' };
}
function perfOf(rule) {
  if (!rule) return { orders7: null, spend7: null, cpa7: null, orders30: null, spend30: null, cpa30: null };
  const sum = (f) => rule.campaigns.reduce((t, c) => t + (f(c) || 0), 0);
  return { orders7: rule.purchases7, spend7: Math.round(sum((c) => c.spend7)), cpa7: rule.cpa7, orders30: rule.purchases30, spend30: Math.round(sum((c) => c.spend30)), cpa30: rule.cpa30 };
}
/** the policy as the flat form the screen edits */
export function toForm(p) {
  if (!p) return null; const c = p.cpa || {}, z = p.zeroOrder || {}, b = p.budget || {};
  return { scale: c.scale ?? null, reduce: c.reduce ?? null, hardStop: c.hardStop ?? null, zeroSpend: z.spend ?? null, zeroMinAgeHours: z.minAgeHours ?? null, increasePct: b.increasePct ?? null, decreasePct: b.decreasePct ?? null, minPurchases: b.minPurchases ?? null, cooldownHours: b.cooldownHours ?? null, minBudget: b.minBudget ?? null, maxBudget: b.maxBudget ?? null, dailySpendCap: b.dailySpendCap ?? null, maxChangesPerDay: b.maxChangesPerDay ?? null };
}
/** flat form → the closed product-policy schema. AUTOMATIC is the INTENT of the draft; it still activates only through the gated activation. */
export function fromForm(f = {}) {
  return normalizePolicy({ mode: 'AUTOMATIC', cpa: { scale: f.scale, reduce: f.reduce, hardStop: f.hardStop }, zeroOrder: { spend: f.zeroSpend, minAgeHours: f.zeroMinAgeHours }, budget: { increasePct: f.increasePct, decreasePct: f.decreasePct, minPurchases: f.minPurchases, cooldownHours: f.cooldownHours, minBudget: f.minBudget, maxBudget: f.maxBudget, dailySpendCap: f.dailySpendCap, maxChangesPerDay: f.maxChangesPerDay } });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// writes (ADMIN is enforced by the route; the lock + validation here)
// ---------------------------------------------------------------------------------------------------------------------------------------------
const ECON_FIELDS = { cost: 'product_cost', shipping: 'shipping_cost', packaging: 'packaging_cost', other: 'other_cost' };
function cleanEconomics(e = {}) {
  const out = {}; const errors = [];
  for (const k of ['cost', 'shipping', 'packaging', 'other']) { if (e[k] === undefined) continue; const v = n(e[k]); if (v !== null && (Number.isNaN(v) || v < 0 || v > 1e7)) errors.push(`${{ cost: 'تكلفة الشراء', shipping: 'الشحن', packaging: 'التغليف', other: 'تكاليف أخرى' }[k]}: رقم صالح مطلوب.`); else out[k] = v; }
  for (const k of ['currentStock', 'minimumStock']) { if (e[k] === undefined) continue; const v = n(e[k]); if (v !== null && (Number.isNaN(v) || v < 0 || v > 1e8)) errors.push(`${k === 'currentStock' ? 'المخزون الحالي' : 'الحد الأدنى للمخزون'}: رقم صالح مطلوب.`); else out[k] = v; }
  if (out.cost === 0) errors.push('تكلفة الشراء لازم تكون أكبر من صفر (الصفر معناه «لم تُدخل»).');
  return { out, errors };
}
function cleanCpa(c = {}) {
  const out = {}; const errors = [];
  for (const k of ['target', 'max', 'hardStop']) { if (c[k] === undefined) continue; const v = n(c[k]); if (v !== null && (Number.isNaN(v) || v <= 0 || v > 1e6)) errors.push(`${{ target: 'CPA المستهدف', max: 'أقصى CPA', hardStop: 'Hard Stop' }[k]}: لازم رقم أكبر من صفر.`); else out[k] = v; }
  if (out.target != null && out.max != null && out.target > out.max) errors.push('CPA المستهدف لازم يكون ≤ أقصى CPA.');
  if (out.max != null && out.hardStop != null && out.hardStop < out.max) errors.push('Hard Stop لازم يكون ≥ أقصى CPA.');
  return { out, errors };
}

/** one save: validate EVERYTHING first (nothing is written if anything is wrong), then economics → CPA limits → policy draft. Returns the fresh card. */
export async function saveProductEconomics({ productId, economics, cpaLimits, policyForm, userId, now = new Date(), deps = {} }) {
  const id = Number(productId); const product = await prisma.product.findUnique({ where: { id }, select: { id: true, store_id: true, product_name: true } }); if (!product) throw fail(404, 'المنتج مش موجود.', 'NOT_FOUND');
  const pol = await getProductPolicy({ productId: id, storeId: product.store_id }); if (pol.active) throw fail(423, 'المنتج ده عليه سياسة مفعّلة (شغّال) — إعداداته الحية مقفولة من هنا. عدّلها من «قواعد المنتجات» عن قصد.', 'PRODUCT_LOCKED');
  const ec = economics ? cleanEconomics(economics) : { out: {}, errors: [] }; const cc = cpaLimits ? cleanCpa(cpaLimits) : { out: {}, errors: [] };
  let draft = null, pErrors = []; if (policyForm) { draft = fromForm(policyForm); pErrors = validatePolicy(draft); }
  const errors = [...ec.errors, ...cc.errors, ...pErrors]; if (errors.length) { const e = fail(400, errors.join(' '), 'INVALID'); e.details = errors; throw e; }
  const wrote = [];
  if (Object.keys(ec.out).length) {
    const catalog = {}; if (ec.out.cost !== undefined) catalog.product_cost = ec.out.cost ?? 0; if (ec.out.shipping !== undefined) catalog.shipping_cost = ec.out.shipping; if (ec.out.packaging !== undefined) catalog.packaging_cost = ec.out.packaging; if (ec.out.other !== undefined) catalog.other_cost = ec.out.other; if (ec.out.currentStock !== undefined) catalog.current_stock = ec.out.currentStock; if (ec.out.minimumStock !== undefined) catalog.minimum_stock = ec.out.minimumStock;
    await prisma.product.update({ where: { id }, data: catalog });
    const amb = await prisma.ambProduct.findUnique({ where: { product_id: id }, select: { id: true } }); // keep the AMB record equal to what the owner typed (a stale AMB value would otherwise win in the economics)
    if (amb) { const ap = {}; for (const [k, col] of Object.entries(ECON_FIELDS)) if (ec.out[k] !== undefined) ap[col] = ec.out[k] ?? 0; if (Object.keys(ap).length) await updateAmbProduct(amb.id, ap); }
    wrote.push('economics'); await audit(userId, 'PRODUCT_ECONOMICS_SAVED', { productId: id, economics: ec.out });
  }
  if (Object.keys(cc.out).length) { await upsertProductConfig({ productId: id, storeId: product.store_id, patch: { target_cpa: cc.out.target, max_cpa: cc.out.max, hard_stop_cpa: cc.out.hardStop }, userId }); wrote.push('cpaLimits'); }
  if (draft) { await saveDraft({ productId: id, storeId: product.store_id, policy: draft, userId, deps: deps.policy || {} }); wrote.push('policyDraft'); }
  const board = await getProductEconomicsBoard({ ids: [id], now, deps: deps.board || {} });
  return { ok: true, wrote, card: board.products.find((c) => c.productId === id) || null, note: 'اتحفظ. السياسة مسودة فقط — مفيش تنفيذ ولا AUTOMATIC لحد ما تعتمدها وتفعّلها بنفسك.' };
}

/** pure compute of a form that is NOT saved yet: the real economics + what the policy would conclude for each campaign (7-day numbers we already hold). Writes nothing, calls nothing. */
export async function previewProductForm({ productId, economics = {}, cpaLimits = {}, policyForm = null, now = new Date(), deps = {} }) {
  const id = Number(productId); const product = await prisma.product.findUnique({ where: { id } }); if (!product) throw fail(404, 'المنتج مش موجود.', 'NOT_FOUND');
  const amb = await prisma.ambProduct.findUnique({ where: { product_id: id } }); const opCfg = await prisma.ambOperatorProductConfig.findUnique({ where: { product_id_store_id: { product_id: id, store_id: product.store_id } } }).catch(() => null);
  const ec = cleanEconomics(economics); const cc = cleanCpa(cpaLimits); const errors = [...ec.errors, ...cc.errors];
  const over = (cur, v) => (v === undefined ? cur : v === null ? 0 : v); const prod2 = { ...product, product_cost: over(product.product_cost, ec.out.cost), shipping_cost: over(product.shipping_cost, ec.out.shipping), packaging_cost: over(product.packaging_cost, ec.out.packaging), other_cost: over(product.other_cost, ec.out.other) };
  const amb2 = amb ? { ...amb, product_cost: over(amb.product_cost, ec.out.cost), shipping_cost: over(amb.shipping_cost, ec.out.shipping), packaging_cost: over(amb.packaging_cost, ec.out.packaging), other_cost: over(amb.other_cost, ec.out.other) } : null;
  const op2 = { ...(opCfg || {}), target_cpa: cc.out.target !== undefined ? cc.out.target : opCfg?.target_cpa, max_cpa: cc.out.max !== undefined ? cc.out.max : opCfg?.max_cpa, hard_stop_cpa: cc.out.hardStop !== undefined ? cc.out.hardStop : opCfg?.hard_stop_cpa };
  const cfg = deps.config || await getOperatorConfig(); const catalog = await loadStoreCatalogIndex(product.store_id).catch(() => null);
  const priceRes = resolveSellingPrice({ product: prod2, ambProduct: amb2, storeCatalog: catalog, ownerConfirmed: ownerPriceOf(cfg, id) });
  const rules = deps.rules || await listProductRules({ now }); const rule = rules.find((r) => Number(r.productId) === id) || null; const perf = perfOf(rule);
  const econ = computeOperatorEconomics({ product: prod2, ambProduct: amb2, opCfg: op2, observedCpa: perf.cpa30, priceResolution: priceRes });
  let simulation = null, policyErrors = [];
  if (policyForm) { const draft = fromForm(policyForm); policyErrors = validatePolicy(draft); if (!policyErrors.length) simulation = previewPolicy({ policy: draft, campaigns: (rule?.campaigns || []).filter((c) => c.status === 'ACTIVE'), globalPolicy: await getBudgetPolicy() }); }
  const maxCpa = op2.max_cpa ?? amb2?.max_cpa ?? econ.calculatedMaxCpa ?? null;
  return { ok: !errors.length && !policyErrors.length, errors: [...errors, ...policyErrors], price: { value: econ.price || null, status: priceRes.status }, economicsComplete: !!econ.complete, profit: profitView({ econ, perf }), calculatedMaxCpa: econ.calculatedMaxCpa ?? null, suggestion: suggestLines(maxCpa), simulation, note: 'معاينة بالأرقام اللي كتبتها — مش محفوظة ومفيش أي تنفيذ.' };
}

/** the read-only readiness + activation summary of one product as the engine itself would judge it right now */
export async function productReadinessCheck({ productId, now = new Date() }) {
  const id = Number(productId); const product = await prisma.product.findUnique({ where: { id }, select: { store_id: true } }); if (!product) throw fail(404, 'المنتج مش موجود.', 'NOT_FOUND');
  const pol = await getProductPolicy({ productId: id, storeId: product.store_id }); const gl = await getGlobalRules().catch(() => ({ active: null })); const eff = pol.active ? pol.effective : pol.draft ? overlayGlobal(gl.active, pol.draft) : null;
  const rd = await productAutomationReadiness({ productId: id, storeId: product.store_id, deps: { policy: eff } });
  return { ...rd, policyStatus: pol.status, hasDraft: !!pol.draft, canActivate: rd.ready && !!pol.draft && !pol.active, note: 'التفعيل بيمر على التأكيد الصريح + AUTOMATIC بتأكيد إضافي، ومرفوض لو أي بند ناقص.' };
}
