// Phase 10 — full per-product pipeline classification. Offline tests
// against services/amb/productMarketing.js's classifyAllProducts(). Real
// entityWindowMetrics/buildHierarchy pipeline runs on top of in-memory
// MetaPerformanceSnapshot rows (same convention as
// productMarketingMetaMappingTest.js / metaUnmappedAuditTest.js). Zero
// real network calls, zero real DB writes.
//   node src/scripts/pipelineHealthTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

let dbWriteAttempted = false;
for (const model of ['product', 'easyOrdersOrder', 'dailyOrder', 'ambProduct', 'ambProductCampaignMap']) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const orig = prisma[model]?.[method]?.bind(prisma[model]);
    if (!orig) continue;
    prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called — this audit must never write anywhere.`); };
  }
}

const AD_ACCOUNT_ID = 'act_pipeline_test';
prisma.metaConnection.findUnique = async () => ({ id: 'default', status: 'CONNECTED', selected_ad_account_id: AD_ACCOUNT_ID });
prisma.settings.findUnique = async () => null;

// Five products covering every reachable bucket:
//  1 = NO_REAL_ORDERS   (0 EasyOrdersOrder rows)
//  2 = META_UNMAPPED    (has orders, no AmbProduct)
//  3 = AD_ANALYSIS_MISSING (has orders, mapped campaign, zero ads in window)
//  4 = INSUFFICIENT_DATA (has orders, mapped, ads exist but all WEAK)
//  5 = READY             (has orders, mapped, at least one STRONG ad)
const PRODUCTS = [
  { id: 1, product_name: 'منتج بدون طلبات', active: true, store_id: 'default' },
  { id: 2, product_name: 'منتج غير مربوط بـ Meta', active: true, store_id: 'default' },
  { id: 3, product_name: 'منتج بحملة بدون إعلانات', active: true, store_id: 'default' },
  { id: 4, product_name: 'منتج ببيانات ضعيفة', active: true, store_id: 'default' },
  { id: 5, product_name: 'منتج جاهز بالكامل', active: true, store_id: 'default' },
];
prisma.product.findMany = async ({ where = {} } = {}) => {
  let rows = PRODUCTS;
  if (where.store_id) rows = rows.filter((p) => p.store_id === where.store_id);
  if ('active' in where) rows = rows.filter((p) => p.active === where.active);
  return rows.map((p) => ({ ...p }));
};

// Order rows — product 1 has none; 2,3,4,5 each have 2 real order rows.
// One extra unmatched (product_id:null) row proves the store-level
// unmatchedOrderRows count works independently of any single product.
const ORDER_ROWS = [
  { product_id: 2, store_id: 'default', matched: true },
  { product_id: 2, store_id: 'default', matched: true },
  { product_id: 3, store_id: 'default', matched: true },
  { product_id: 3, store_id: 'default', matched: true },
  { product_id: 4, store_id: 'default', matched: true },
  { product_id: 4, store_id: 'default', matched: true },
  { product_id: 5, store_id: 'default', matched: true },
  { product_id: 5, store_id: 'default', matched: true },
  { product_id: null, store_id: 'default', matched: false },
];
prisma.easyOrdersOrder.groupBy = async ({ where }) => {
  const rows = ORDER_ROWS.filter((r) => r.store_id === where.store_id && where.product_id.in.includes(r.product_id));
  const counts = new Map();
  for (const r of rows) counts.set(r.product_id, (counts.get(r.product_id) || 0) + 1);
  return [...counts.entries()].map(([product_id, count]) => ({ product_id, _count: { _all: count } }));
};
prisma.easyOrdersOrder.count = async ({ where }) => ORDER_ROWS.filter((r) => r.store_id === where.store_id && r.matched === where.matched).length;

// AmbProduct — products 3, 4, 5 are mapped; product 2 deliberately is not.
const AMB_PRODUCTS = [
  { id: 300, product_id: 3, active: true, product_name: 'منتج بحملة بدون إعلانات' },
  { id: 400, product_id: 4, active: true, product_name: 'منتج ببيانات ضعيفة' },
  { id: 500, product_id: 5, active: true, product_name: 'منتج جاهز بالكامل' },
];
prisma.ambProduct.findMany = async ({ where = {} } = {}) => {
  let rows = AMB_PRODUCTS;
  if (where.product_id?.in) rows = rows.filter((a) => where.product_id.in.includes(a.product_id));
  if ('active' in where) rows = rows.filter((a) => a.active === where.active);
  return rows.map((a) => ({ ...a }));
};
prisma.ambProduct.findUnique = async ({ where }) => AMB_PRODUCTS.find((a) => a.id === where.id || a.product_id === where.product_id) || null;

// Campaign maps — product 3's campaign has NO ads; product 4's has only a
// WEAK ad; product 5's has a STRONG ad.
let ambCampaignMaps = [
  { id: 1, ad_account_id: AD_ACCOUNT_ID, campaign_id: 'c-noads', campaign_name: 'No Ads Campaign', amb_product_id: 300, status: 'MAPPED' },
  { id: 2, ad_account_id: AD_ACCOUNT_ID, campaign_id: 'c-weak', campaign_name: 'Weak Data Campaign', amb_product_id: 400, status: 'MAPPED' },
  { id: 3, ad_account_id: AD_ACCOUNT_ID, campaign_id: 'c-ready', campaign_name: 'Ready Campaign', amb_product_id: 500, status: 'MAPPED' },
];
prisma.ambProductCampaignMap.findMany = async ({ where = {}, include } = {}) => {
  let rows = ambCampaignMaps;
  if (where.ad_account_id !== undefined) rows = rows.filter((r) => r.ad_account_id === where.ad_account_id);
  if (where.status !== undefined) rows = rows.filter((r) => r.status === where.status);
  if (include?.amb_product) return rows.map((r) => ({ ...r, amb_product: AMB_PRODUCTS.find((a) => a.id === r.amb_product_id) || null }));
  return rows.map((r) => ({ ...r }));
};

function snapshotRow({ level, campaignId, campaignName, adsetId, adId, spend, purchases, dateStart = '2026-08-25' }) {
  return {
    sync_run_id: 1, snapshot_at: new Date(), ad_account_id: AD_ACCOUNT_ID, level, date_start: dateStart, date_stop: dateStart,
    campaign_id: campaignId, campaign_name: campaignName, adset_id: adsetId || null, adset_name: adsetId ? `${adsetId}-n` : null,
    ad_id: adId || null, ad_name: adId ? `${adId}-n` : null,
    spend, impressions: spend ? spend * 20 : 0, clicks: spend ? Math.round(spend / 2) : 0,
    meta_purchases: purchases, meta_revenue: purchases ? purchases * 500 : null, results: null,
  };
}
const snapshotRows = [
  // Campaign for product 3 exists but has NO adset/ad-level rows at all.
  snapshotRow({ level: 'campaign', campaignId: 'c-noads', campaignName: 'No Ads Campaign', spend: 500, purchases: 5 }),
  // Campaign for product 4 has one ad, but spend/purchases stay WEAK (well under the default 150/5 gate doubled for STRONG, and under half for MODERATE).
  snapshotRow({ level: 'campaign', campaignId: 'c-weak', campaignName: 'Weak Data Campaign', spend: 20, purchases: 0 }),
  snapshotRow({ level: 'adset', campaignId: 'c-weak', campaignName: 'Weak Data Campaign', adsetId: 'as-weak', spend: 20, purchases: 0 }),
  snapshotRow({ level: 'ad', campaignId: 'c-weak', campaignName: 'Weak Data Campaign', adsetId: 'as-weak', adId: 'ad-weak', spend: 20, purchases: 0 }),
  // Campaign for product 5 has a real, strong-performing ad.
  snapshotRow({ level: 'campaign', campaignId: 'c-ready', campaignName: 'Ready Campaign', spend: 2000, purchases: 30 }),
  snapshotRow({ level: 'adset', campaignId: 'c-ready', campaignName: 'Ready Campaign', adsetId: 'as-ready', spend: 2000, purchases: 30 }),
  snapshotRow({ level: 'ad', campaignId: 'c-ready', campaignName: 'Ready Campaign', adsetId: 'as-ready', adId: 'ad-ready', spend: 2000, purchases: 30 }),
];
prisma.$queryRaw = async (strings, ...values) => {
  const [level, from, to] = values.filter((v) => typeof v === 'string');
  return snapshotRows.filter((r) => r.level === level && r.date_start >= from && r.date_start <= to).map((r) => ({ ...r }));
};

const PM = await import(pathToFileURL(join(__dirname, '../services/amb/productMarketing.js')).href);

console.log('§1 classifyAllProducts — every reachable bucket, computed correctly:');
{
  const result = await PM.classifyAllProducts({ storeId: 'default', windowName: 'last30' });
  ok('totalProducts:5', result.totalProducts === 5, String(result.totalProducts));
  ok('unmatchedOrderRows:1 — the one product_id:null row, at the STORE level, never pinned to a specific product', result.unmatchedOrderRows === 1, String(result.unmatchedOrderRows));

  const byId = new Map(result.classifications.map((c) => [c.productId, c]));
  ok('product 1 (0 orders) -> NO_REAL_ORDERS', byId.get(1)?.status === 'NO_REAL_ORDERS', JSON.stringify(byId.get(1)));
  ok('product 2 (has orders, no AmbProduct) -> META_UNMAPPED', byId.get(2)?.status === 'META_UNMAPPED', JSON.stringify(byId.get(2)));
  ok('product 3 (mapped, zero ads in window) -> AD_ANALYSIS_MISSING', byId.get(3)?.status === 'AD_ANALYSIS_MISSING', JSON.stringify(byId.get(3)));
  ok('product 4 (mapped, only a WEAK ad) -> INSUFFICIENT_DATA', byId.get(4)?.status === 'INSUFFICIENT_DATA', JSON.stringify(byId.get(4)));
  ok('product 5 (mapped, a STRONG ad) -> READY', byId.get(5)?.status === 'READY', JSON.stringify(byId.get(5)));

  ok('counts summary matches', result.counts.NO_REAL_ORDERS === 1 && result.counts.META_UNMAPPED === 1 && result.counts.AD_ANALYSIS_MISSING === 1 && result.counts.INSUFFICIENT_DATA === 1 && result.counts.READY === 1, JSON.stringify(result.counts));
}

console.log('\n§2 no products in this store -> empty result, never throws:');
{
  const result = await PM.classifyAllProducts({ storeId: 'nonexistent-store' });
  ok('totalProducts:0, empty classifications', result.totalProducts === 0 && result.classifications.length === 0, JSON.stringify(result));
}

console.log('\n§3 Meta not connected -> every order-having product gets PROVIDER_ERROR, never silently misclassified as something else:');
{
  const originalConn = prisma.metaConnection.findUnique;
  prisma.metaConnection.findUnique = async () => null;
  const result = await PM.classifyAllProducts({ storeId: 'default' });
  const byId = new Map(result.classifications.map((c) => [c.productId, c]));
  ok('product 1 (0 orders) still correctly NO_REAL_ORDERS even with Meta down — order data is independent of Meta', byId.get(1)?.status === 'NO_REAL_ORDERS');
  ok('products 2/3/4/5 (all have real orders) -> PROVIDER_ERROR while Meta is unreachable', ['2', '3', '4', '5'].every((id) => byId.get(Number(id))?.status === 'PROVIDER_ERROR'), JSON.stringify([...byId.values()]));
  prisma.metaConnection.findUnique = originalConn;
}

console.log('\n§4 zero real DB writes anywhere in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
