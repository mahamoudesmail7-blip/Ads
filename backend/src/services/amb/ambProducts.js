// AI Media Buyer — Products module. CRUD for AmbProduct (its own economics
// profile, optionally linked to an existing Product) + the rich per-product
// dashboard: real Meta spend/purchases joined to real COD confirmed/
// delivered/returned counts, deterministic Net Profit, and the best
// campaign / ad set / ad / creative / hook inside that product.
//
// suggested_selling_price is always recomputed on write as
// product_cost × pricing_multiplier (never a global constant); the owner
// may still override it per product via actual_selling_price.
import { prisma } from '../../prisma.js';
import { getConnection } from '../metaAuth.js';
import { getAmbSettings } from './settings.js';
import { resolveWindow } from './metricsEngine.js';
import { buildHierarchy } from './hierarchyAnalysis.js';
import { economicsSummary, netProfitBundle, effectiveSellingPrice } from './productEconomics.js';
import { codCountsForProduct, observedRatesForProduct } from './codOrders.js';

const WRITABLE = [
  'product_name', 'product_id', 'external_product_ref', 'product_cost', 'pricing_multiplier',
  'actual_selling_price', 'packaging_cost', 'shipping_cost', 'other_cost', 'rto_cost',
  'confirmation_rate', 'delivery_rate', 'target_cpa', 'warning_cpa', 'max_cpa',
  'target_profit', 'min_profit', 'currency', 'active',
];

function pickWritable(body) {
  const out = {};
  for (const k of WRITABLE) if (body[k] !== undefined) out[k] = body[k] === '' ? null : body[k];
  return out;
}

function withComputed(data, existing = {}) {
  const merged = { ...existing, ...data };
  const cost = Number(merged.product_cost);
  const mult = Number(merged.pricing_multiplier);
  if (Number.isFinite(cost) && Number.isFinite(mult)) {
    data.suggested_selling_price = cost * mult;
  }
  return data;
}

export async function listProducts() {
  const rows = await prisma.ambProduct.findMany({
    orderBy: { created_at: 'desc' },
    include: { product: { select: { id: true, product_name: true } }, _count: { select: { campaign_maps: true } } },
  });
  return rows.map((p) => ({
    ...serialize(p),
    linkedProductName: p.product?.product_name || null,
    mappedCampaignCount: p._count.campaign_maps,
  }));
}

export async function createProduct(body, userId) {
  const data = withComputed(pickWritable(body));
  if (!data.product_name) { const e = new Error('اسم المنتج مطلوب.'); e.status = 400; throw e; }
  if (data.pricing_multiplier == null) data.pricing_multiplier = (await getAmbSettings()).ambDefaultPricingMultiplier;
  if (!data.currency) data.currency = (await getAmbSettings()).ambDefaultCurrency;
  const created = await prisma.ambProduct.create({ data: { ...data, created_by_id: userId || null } });
  return serialize(created);
}

export async function updateProduct(id, body) {
  const existing = await prisma.ambProduct.findUnique({ where: { id: Number(id) } });
  if (!existing) { const e = new Error('المنتج مش موجود.'); e.status = 404; throw e; }
  const data = withComputed(pickWritable(body), existing);
  const updated = await prisma.ambProduct.update({ where: { id: existing.id }, data });
  return serialize(updated);
}

export async function deleteProduct(id) {
  await prisma.ambProduct.delete({ where: { id: Number(id) } });
  return { deleted: true };
}

/** Seed an AmbProduct from an existing catalog Product (copies cost/price as a starting point; the owner tunes the rest). */
export async function createFromCatalogProduct(productId, userId) {
  const p = await prisma.product.findUnique({ where: { id: Number(productId) } });
  if (!p) { const e = new Error('المنتج ده مش موجود في الكتالوج.'); e.status = 404; throw e; }
  const existing = await prisma.ambProduct.findUnique({ where: { product_id: p.id } });
  if (existing) return serialize(existing);
  const s = await getAmbSettings();
  const created = await prisma.ambProduct.create({
    data: withComputed({
      product_id: p.id,
      product_name: p.product_name,
      product_cost: p.product_cost || 0,
      pricing_multiplier: s.ambDefaultPricingMultiplier,
      actual_selling_price: p.selling_price || null,
      packaging_cost: p.packaging_cost || 0,
      shipping_cost: p.shipping_cost || 0,
      other_cost: p.other_cost || 0,
      rto_cost: p.expected_return_cost || 0,
      currency: s.ambDefaultCurrency,
      created_by_id: userId || null,
    }),
  });
  return serialize(created);
}

/** Full per-product dashboard for a window. */
export async function productDashboard(id, { windowName } = {}) {
  const p = await prisma.ambProduct.findUnique({ where: { id: Number(id) } });
  if (!p) { const e = new Error('المنتج مش موجود.'); e.status = 404; throw e; }
  const settings = await getAmbSettings();
  const window = resolveWindow(windowName || (settings.ambAnalysisLookbackDays >= 7 ? 'last7' : 'last3'));
  const connection = await getConnection();
  const econ = economicsSummary(p);

  let meta = { spend: 0, purchases: null, revenue: null, roas: null };
  let bests = { campaign: null, adset: null, ad: null, creative: null, hook: null };
  if (connection?.selected_ad_account_id) {
    const tree = await buildHierarchy({ adAccountId: connection.selected_ad_account_id, window, settings });
    const node = (tree.products || []).find((x) => String(x.id) === String(p.id));
    if (node?.metrics) {
      meta = { spend: node.metrics.spend || 0, purchases: node.metrics.purchases ?? null, revenue: node.metrics.revenue ?? null, roas: node.metrics.roas ?? null };
      bests = pickBests(node);
    }
  }

  const cod = p.product_id ? await codCountsForProduct({ productId: p.product_id, from: window.from, to: window.to }) : { source: 'none', orders: null, confirmed: null, delivered: null, returned: null };
  const observed = p.product_id ? await observedRatesForProduct({ productId: p.product_id, from: window.from, to: window.to }) : { source: 'none', confirmationRate: null, deliveryRate: null };

  const bundle = netProfitBundle(p, { adSpend: meta.spend, deliveredOrders: cod.delivered, returnedOrders: cod.returned });
  const avgCpa = meta.purchases ? meta.spend / meta.purchases : null;
  const deliveredCpa = cod.delivered ? meta.spend / cod.delivered : null;
  const confirmedCpa = cod.confirmed ? meta.spend / cod.confirmed : null;

  return {
    product: serialize(p),
    economics: econ,
    window,
    meta,
    cod: { source: cod.source, orders: cod.orders, confirmed: cod.confirmed, delivered: cod.delivered, returned: cod.returned },
    observedRates: observed,
    metrics: {
      totalSpend: meta.spend,
      metaPurchases: meta.purchases,
      confirmedOrders: cod.confirmed,
      deliveredOrders: cod.delivered,
      revenue: bundle.revenue,
      avgCpa,
      confirmedCpa,
      deliveredCpa,
      netProfit: bundle.netProfit,
      netMarginPct: bundle.netMarginPct,
      roas: meta.roas,
      pnl: bundle,
    },
    bests,
    classification: classifyProduct({ bundle, deliveredCpa, econ, deliveredOrders: cod.delivered, settings }),
  };
}

function pickBests(productNode) {
  const campaigns = productNode.children || [];
  const allAdsets = campaigns.flatMap((c) => (c.children || []).map((a) => ({ ...a, campaignName: c.name })));
  const allAds = allAdsets.flatMap((as) => (as.children || []).map((ad) => ({ ...ad, adsetName: as.name })));
  const allCreatives = allAdsets.flatMap((as) => as.creatives || []);
  const best = (arr) => arr
    .filter((x) => x.metrics && x.metrics.cpa !== null && (x.metrics.purchases || 0) > 0)
    .sort((a, b) => a.metrics.cpa - b.metrics.cpa)[0] || null;
  const slim = (x) => x ? { id: x.id, name: x.name, cpa: x.metrics.cpa, purchases: x.metrics.purchases, spend: x.metrics.spend, roas: x.metrics.roas } : null;
  return {
    campaign: slim(best(campaigns)),
    adset: slim(best(allAdsets)),
    ad: slim(best(allAds)),
    creative: slim(best(allCreatives)),
    hook: null, // account-level hook analysis lives in the Winners section
  };
}

function classifyProduct({ bundle, deliveredCpa, econ, deliveredOrders, settings }) {
  if (bundle.netProfit === null || !deliveredOrders) {
    return { label: 'NO_DATA', reason: 'مفيش بيانات تسليم حقيقية كفاية لتصنيف ربحية المنتج.' };
  }
  const np = bundle.netProfit;
  const target = econ.targetCpa ?? settings.ambDefaultTargetCpa ?? 120;
  const warning = econ.warningCpa ?? target * 1.15;
  const rev = bundle.revenue || 0;
  const marginPct = rev > 0 ? (np / rev) * 100 : null;

  if (np > 0 && deliveredCpa !== null && deliveredCpa <= target * 0.85 && deliveredOrders >= (settings.ambMinPurchasesBeforeScaling || 5)) {
    return { label: 'WINNING', reason: `صافي ربح ${Math.round(np)} جنيه وتكلفة الأوردر المسلّم (${Math.round(deliveredCpa)} جنيه) أقل من الهدف بوضوح.` };
  }
  if (np > 0) return { label: 'PROFITABLE', reason: `صافي ربح موجب (${Math.round(np)} جنيه، هامش ${marginPct != null ? marginPct.toFixed(1) + '%' : '—'}).` };
  if (Math.abs(marginPct ?? 0) <= 5) return { label: 'BREAK_EVEN', reason: `الربح قريب من الصفر (هامش ${marginPct?.toFixed(1)}%).` };
  if (np < 0 && (deliveredCpa === null || deliveredCpa <= warning * 1.2)) return { label: 'AT_RISK', reason: `صافي ربح سالب بسيط (${Math.round(np)} جنيه) — قابل للإنقاذ بتحسين.` };
  return { label: 'LOSING', reason: `صافي ربح سالب واضح (${Math.round(np)} جنيه) وتكلفة الأوردر المسلّم فوق حد التحذير.` };
}

function serialize(p) {
  return {
    id: p.id,
    productId: p.product_id,
    productName: p.product_name,
    externalProductRef: p.external_product_ref,
    productCost: p.product_cost,
    pricingMultiplier: p.pricing_multiplier,
    suggestedSellingPrice: p.suggested_selling_price,
    actualSellingPrice: p.actual_selling_price,
    effectiveSellingPrice: effectiveSellingPrice(p),
    packagingCost: p.packaging_cost,
    shippingCost: p.shipping_cost,
    otherCost: p.other_cost,
    rtoCost: p.rto_cost,
    confirmationRate: p.confirmation_rate,
    deliveryRate: p.delivery_rate,
    targetCpa: p.target_cpa,
    warningCpa: p.warning_cpa,
    maxCpa: p.max_cpa,
    targetProfit: p.target_profit,
    minProfit: p.min_profit,
    currency: p.currency,
    active: p.active,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

export { serialize as serializeAmbProduct };
