// Unmapped Meta activity audit (Phase 8) — offline tests against
// services/amb/productMarketing.js's auditUnmappedMetaActivity(). Real
// entityWindowMetrics/aggregateRows pipeline runs on top of in-memory
// MetaPerformanceSnapshot rows (not mocked, same as
// productMarketingMetaMappingTest.js's convention). Zero real network calls
// (fetch mocked) and zero real DB writes (every write method on every
// touched model throws).
//   node src/scripts/metaUnmappedAuditTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

process.env.EASYORDERS_STORES_JSON = JSON.stringify([
  { id: 'default', name: 'Trendy Store', apiKeyEnv: 'EO_KEY_DEFAULT' },
  { id: 'trendy-storeee', name: 'Trendy Storeee', apiKeyEnv: 'EO_KEY_2' },
]);
process.env.EO_KEY_DEFAULT = 'key-default';
process.env.EO_KEY_2 = 'key-2';

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

let dbWriteAttempted = false;
for (const model of ['product', 'easyOrdersOrder', 'dailyOrder', 'ambProduct', 'ambProductCampaignMap']) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const orig = prisma[model]?.[method]?.bind(prisma[model]);
    if (!orig) continue;
    prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called — this audit must never write anywhere.`); };
  }
}

const AD_ACCOUNT_ID = 'act_test999';
prisma.metaConnection.findUnique = async () => ({ id: 'default', status: 'CONNECTED', selected_ad_account_id: AD_ACCOUNT_ID });

// A campaign already MAPPED must never be reported as REVIEW/UNMAPPED.
let existingMaps = [{ id: 1, ad_account_id: AD_ACCOUNT_ID, campaign_id: 'c-mapped', campaign_name: 'Already Mapped Campaign', amb_product_id: 900, status: 'MAPPED' }];
prisma.ambProductCampaignMap.findMany = async ({ where = {}, include } = {}) => {
  let rows = existingMaps;
  if (where.ad_account_id !== undefined) rows = rows.filter((r) => r.ad_account_id === where.ad_account_id);
  if (where.status !== undefined) rows = rows.filter((r) => r.status === where.status);
  if (include?.amb_product) return rows.map((r) => ({ ...r, amb_product: { id: r.amb_product_id, product_name: 'Mapped Product' } }));
  return rows.map((r) => ({ ...r }));
};

function snapshotRow({ campaignId, campaignName, spend, purchases, dateStart = '2026-09-10' }) {
  return {
    sync_run_id: 1, snapshot_at: new Date(), ad_account_id: AD_ACCOUNT_ID, level: 'campaign', date_start: dateStart, date_stop: dateStart,
    campaign_id: campaignId, campaign_name: campaignName, adset_id: null, adset_name: null, ad_id: null, ad_name: null,
    spend, impressions: spend * 20, clicks: Math.round(spend / 2), meta_purchases: purchases, meta_revenue: purchases ? purchases * 500 : null, results: null,
  };
}
const snapshotRows = [
  snapshotRow({ campaignId: 'c-mapped', campaignName: 'Already Mapped Campaign', spend: 500, purchases: 5 }),
  snapshotRow({ campaignId: 'c-hairremover', campaignName: 'Hair-Remover _ scale 4', spend: 6837, purchases: 59 }),
  snapshotRow({ campaignId: 'c-radio', campaignName: 'Radio _ scale 1', spend: 2795, purchases: 22 }),
  snapshotRow({ campaignId: 'c-genuinely-unmapped', campaignName: 'Q3 Generic Push Campaign', spend: 300, purchases: 3 }),
  snapshotRow({ campaignId: 'c-trendy2-slug', campaignName: 'FootFile _ scale', spend: 400, purchases: 4 }),
  snapshotRow({ campaignId: 'c-ambiguous', campaignName: 'Cleaner _ scale', spend: 200, purchases: 2 }),
];
// loadSnapshots() runs a genuine $queryRaw (a real Postgres DISTINCT ON),
// not Prisma's findMany ORM sugar — see metricsEngineSnapshotVolumeTest.js
// / productMarketingMetaMappingTest.js for why. level/from/to are the only
// plain-string interpolated values in that query, recovered positionally.
prisma.$queryRaw = async (strings, ...values) => {
  const [level, from, to] = values.filter((v) => typeof v === 'string');
  return snapshotRows.filter((r) => r.level === level && r.date_start >= from && r.date_start <= to).map((r) => ({ ...r }));
};

// Catalogs — 'default' has a "Hair-Remover-Device" and "Fire-Radio" slug;
// 'trendy-storeee' has a "FootFile-Pro" slug. Neither slug is a coincidence
// with the OTHER store's products — proves cross-store slug matching still
// correctly attributes the right store.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('easy-orders.net/api/v1/external-apps/products')) {
    const key = opts?.headers?.['Api-Key'];
    if (key === 'key-default') {
      return { ok: true, status: 200, json: async () => [
        { id: 'eo-hair-1', name: 'جهاز إزالة الشعر', slug: 'Hair-Remover-Device', thumb: 't', price: 500, created_at: null },
        { id: 'eo-radio-1', name: 'راديو كلاسيكي', slug: 'Fire-Radio', thumb: 't', price: 300, created_at: null },
        { id: 'eo-vacuum-1', name: 'مكنسة كهربائية', slug: 'Vacuum-Cleaner', thumb: 't', price: 700, created_at: null },
      ] };
    }
    if (key === 'key-2') {
      return { ok: true, status: 200, json: async () => [
        { id: 'eo-footfile-1', name: 'مبرد القدم', slug: 'FootFile-Pro', thumb: 't', price: 900, created_at: null },
        { id: 'eo-cleanerpro-1', name: 'جهاز تنظيف احترافي', slug: 'Cleaner-Pro', thumb: 't', price: 1200, created_at: null },
      ] };
    }
    return { ok: true, status: 200, json: async () => [] };
  }
  return originalFetch(url, opts);
};

// Internal products carrying the easy_orders_uuid the audit resolves through.
const INTERNAL_PRODUCTS = [
  { id: 48, product_name: 'جهاز قياس الضغط الذكي المنزلي', easy_orders_uuid: 'eo-hair-1', store_id: 'default' }, // deliberately a wrong-sounding name/uuid pair — the audit trusts the UUID match, not the name
  { id: 129, product_name: 'راديو كلاسيكي', easy_orders_uuid: 'eo-radio-1', store_id: 'default' },
  { id: 305, product_name: 'مبرد القدم اليدوي', easy_orders_uuid: 'eo-footfile-1', store_id: 'trendy-storeee' },
  { id: 400, product_name: 'مكنسة كهربائية قوية', easy_orders_uuid: 'eo-vacuum-1', store_id: 'default' },
  { id: 401, product_name: 'جهاز تنظيف احترافي شامل', easy_orders_uuid: 'eo-cleanerpro-1', store_id: 'trendy-storeee' },
];
prisma.product.findMany = async ({ where = {} } = {}) => {
  if (where.easy_orders_uuid?.in) return INTERNAL_PRODUCTS.filter((p) => where.easy_orders_uuid.in.includes(p.easy_orders_uuid)).map((p) => ({ ...p }));
  return INTERNAL_PRODUCTS.map((p) => ({ ...p }));
};

const PM = await import(pathToFileURL(join(__dirname, '../services/amb/productMarketing.js')).href);

console.log('§1 auditUnmappedMetaActivity — classifies real unmapped spend into REVIEW (slug evidence) vs UNMAPPED (none):');
{
  const result = await PM.auditUnmappedMetaActivity({ windowName: 'last7' });
  ok('ok:true', result.ok === true, JSON.stringify(result));
  ok('already-MAPPED campaign never appears in totalUnmapped', result.totalUnmapped === 5, String(result.totalUnmapped));

  const hairReview = result.reviewCandidates.find((r) => r.campaignId === 'c-hairremover');
  ok('Hair-Remover campaign -> REVIEW with the correct candidate product (48) via a shared token, despite the slug carrying an extra word ("Device") the campaign name never used', hairReview?.status === 'REVIEW' && hairReview.candidates.some((c) => c.productId === 48), JSON.stringify(hairReview));
  ok('REVIEW row carries real spend/purchases, never fabricated', hairReview.spend === 6837 && hairReview.purchases === 59);

  const radioReview = result.reviewCandidates.find((r) => r.campaignId === 'c-radio');
  ok('Radio campaign -> REVIEW with candidate product 129', radioReview?.candidates.some((c) => c.productId === 129), JSON.stringify(radioReview));

  const footfileReview = result.reviewCandidates.find((r) => r.campaignId === 'c-trendy2-slug');
  ok('FootFile campaign -> REVIEW with candidate product 305, correctly attributed to trendy-storeee (not default)', footfileReview?.candidates.some((c) => c.productId === 305 && c.storeId === 'trendy-storeee'), JSON.stringify(footfileReview));

  const genuinelyUnmapped = result.unmapped.find((r) => r.campaignId === 'c-genuinely-unmapped');
  ok('a campaign name with no slug evidence anywhere -> UNMAPPED, never guessed', genuinelyUnmapped?.status === 'UNMAPPED', JSON.stringify(genuinelyUnmapped));

  const ambiguousReview = result.reviewCandidates.find((r) => r.campaignId === 'c-ambiguous');
  ok('an ambiguous shared token ("cleaner") across TWO different real products in TWO different stores surfaces BOTH as candidates — never silently picks one', ambiguousReview?.candidates?.length === 2 && ambiguousReview.candidates.some((c) => c.productId === 400 && c.storeId === 'default') && ambiguousReview.candidates.some((c) => c.productId === 401 && c.storeId === 'trendy-storeee'), JSON.stringify(ambiguousReview));

  ok('reviewCandidates sorted by spend descending', result.reviewCandidates[0].campaignId === 'c-hairremover');
  ok('summary counts match', result.summary.review === 4 && result.summary.unmapped === 1, JSON.stringify(result.summary));
}

console.log('\n§2 no ad account connected -> honest error, never a fabricated empty-success:');
{
  const originalConn = prisma.metaConnection.findUnique;
  prisma.metaConnection.findUnique = async () => null;
  const result = await PM.auditUnmappedMetaActivity({ windowName: 'last7' });
  ok('ok:false with a real reason', result.ok === false && !!result.error, JSON.stringify(result));
  prisma.metaConnection.findUnique = originalConn;
}

console.log('\n§3 zero real DB writes anywhere in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

globalThis.fetch = originalFetch;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
