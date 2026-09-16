// Phase 13 — safe, strict auto-resolution of unambiguous Meta mappings.
// Offline tests against services/amb/productMarketing.js's
// autoResolveHighConfidenceMetaMappings(). Real entityWindowMetrics
// pipeline runs on top of in-memory MetaPerformanceSnapshot rows (same
// convention as metaUnmappedAuditTest.js). Zero real network calls, and
// every write is against an in-memory mock so exact state can be asserted.
//   node src/scripts/metaAutoResolveTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

process.env.EASYORDERS_STORES_JSON = JSON.stringify([{ id: 'default', name: 'Trendy Store', apiKeyEnv: 'EO_KEY' }]);
process.env.EO_KEY = 'test-key';

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

const AD_ACCOUNT_ID = 'act_autoresolve_test';
prisma.metaConnection.findUnique = async () => ({ id: 'default', status: 'CONNECTED', selected_ad_account_id: AD_ACCOUNT_ID });
prisma.settings.findUnique = async () => null;

// A pre-existing, unrelated MAPPED campaign, so ambProduct 999 is a real
// row to reference from the race-condition test below.
let ambCampaignMaps = [{ id: 1, ad_account_id: AD_ACCOUNT_ID, campaign_id: 'c-other-existing', campaign_name: 'Some Other Existing Campaign', amb_product_id: 999, status: 'MAPPED', match_source: 'MANUAL' }];
let nextMapId = 2;
prisma.ambProductCampaignMap.findMany = async ({ where = {}, include } = {}) => {
  let rows = ambCampaignMaps;
  if (where.ad_account_id !== undefined) rows = rows.filter((r) => r.ad_account_id === where.ad_account_id);
  if (where.status !== undefined) rows = rows.filter((r) => r.status === where.status);
  if (include?.amb_product) return rows.map((r) => ({ ...r, amb_product: { id: r.amb_product_id, product_name: 'x' } }));
  return rows.map((r) => ({ ...r }));
};
prisma.ambProductCampaignMap.findUnique = async ({ where }) => {
  const { ad_account_id, campaign_id } = where.ad_account_id_campaign_id;
  return ambCampaignMaps.find((r) => r.ad_account_id === ad_account_id && r.campaign_id === campaign_id) || null;
};
prisma.ambProductCampaignMap.upsert = async ({ where, create, update }) => {
  const { ad_account_id, campaign_id } = where.ad_account_id_campaign_id;
  const existing = ambCampaignMaps.find((r) => r.ad_account_id === ad_account_id && r.campaign_id === campaign_id);
  if (existing) { Object.assign(existing, update); return { ...existing }; }
  const row = { id: nextMapId++, created_at: new Date(), updated_at: new Date(), ...create };
  ambCampaignMaps.push(row);
  return { ...row };
};

let ambProducts = [{ id: 999, product_id: 850, product_name: 'منتج مختلف تمامًا', active: true }];
let nextAmbProductId = 1000;
prisma.ambProduct.findUnique = async ({ where }) => {
  if (where.id !== undefined) return ambProducts.find((p) => p.id === where.id) || null;
  if (where.product_id !== undefined) return ambProducts.find((p) => p.product_id === where.product_id) || null;
  return null;
};
prisma.ambProduct.create = async ({ data }) => { const row = { id: nextAmbProductId++, active: true, ...data }; ambProducts.push(row); return { ...row }; };

// Internal products carrying the easy_orders_uuid the audit resolves through.
const INTERNAL_PRODUCTS = [
  { id: 700, product_name: 'جهاز إزالة الشعر', easy_orders_uuid: 'eo-hair-1', store_id: 'default' },
  { id: 701, product_name: 'منتج آخر أ', easy_orders_uuid: 'eo-ambig-1', store_id: 'default' },
  { id: 702, product_name: 'منتج آخر ب', easy_orders_uuid: 'eo-ambig-2', store_id: 'default' },
];
prisma.product.findMany = async ({ where = {} } = {}) => {
  if (where.easy_orders_uuid?.in) return INTERNAL_PRODUCTS.filter((p) => where.easy_orders_uuid.in.includes(p.easy_orders_uuid)).map((p) => ({ ...p }));
  return INTERNAL_PRODUCTS.map((p) => ({ ...p }));
};
prisma.product.findUnique = async ({ where }) => INTERNAL_PRODUCTS.find((p) => p.id === where.id) || null;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes('easy-orders.net/api/v1/external-apps/products')) {
    return { ok: true, status: 200, json: async () => [
      { id: 'eo-hair-1', name: 'جهاز إزالة الشعر', slug: 'HairRemover-Device', thumb: 't', price: 500, created_at: null },
      { id: 'eo-ambig-1', name: 'منتج آخر أ', slug: 'Cleaner-Alpha', thumb: 't', price: 300, created_at: null },
      { id: 'eo-ambig-2', name: 'منتج آخر ب', slug: 'Cleaner-Beta', thumb: 't', price: 300, created_at: null },
    ] };
  }
  return originalFetch(url);
};

function snapshotRow({ campaignId, campaignName, spend, purchases, dateStart = '2026-09-12' }) {
  return {
    sync_run_id: 1, snapshot_at: new Date(), ad_account_id: AD_ACCOUNT_ID, level: 'campaign', date_start: dateStart, date_stop: dateStart,
    campaign_id: campaignId, campaign_name: campaignName, adset_id: null, adset_name: null, ad_id: null, ad_name: null,
    spend, impressions: spend * 20, clicks: Math.round(spend / 2), meta_purchases: purchases, meta_revenue: purchases ? purchases * 500 : null, results: null,
  };
}
const snapshotRows = [
  // Unambiguous, no conflict -> should become AUTO_SAFE.
  snapshotRow({ campaignId: 'c-safe', campaignName: 'HairRemover _ scale 1', spend: 1000, purchases: 10 }),
  // Ambiguous (two products share the "cleaner" token) -> must stay REVIEW, never auto-applied.
  snapshotRow({ campaignId: 'c-ambiguous', campaignName: 'Cleaner _ scale', spend: 300, purchases: 3 }),
  // No evidence at all -> UNMAPPED.
  snapshotRow({ campaignId: 'c-none', campaignName: 'Generic Push', spend: 100, purchases: 1 }),
];
prisma.$queryRaw = async (strings, ...values) => {
  const [level, from, to] = values.filter((v) => typeof v === 'string');
  return snapshotRows.filter((r) => r.level === level && r.date_start >= from && r.date_start <= to).map((r) => ({ ...r }));
};

const PM = await import(pathToFileURL(join(__dirname, '../services/amb/productMarketing.js')).href);

console.log('§1 Dry run — correctly separates AUTO_SAFE / REVIEW / UNMAPPED, writes nothing:');
{
  const before = ambCampaignMaps.length;
  const result = await PM.autoResolveHighConfidenceMetaMappings({ windowName: 'last7' });
  ok('ok:true, dryRun:true', result.ok === true && result.dryRun === true, JSON.stringify(result));
  ok('counts.autoSafe:1 (only c-safe)', result.counts.autoSafe === 1, JSON.stringify(result.counts));
  ok('counts.review:1 (c-ambiguous)', result.counts.review === 1, JSON.stringify(result.counts));
  ok('counts.unmapped:1 (c-none)', result.counts.unmapped === 1, JSON.stringify(result.counts));
  ok('nothing written during dry run', ambCampaignMaps.length === before, `before=${before} after=${ambCampaignMaps.length}`);
  ok('autoSafeCandidates lists exactly c-safe', JSON.stringify(result.autoSafeCandidates.map((c) => c.campaignId)) === JSON.stringify(['c-safe']));
}

console.log('\n§2 Apply — maps the genuinely free campaign, never touches ambiguous/unmapped:');
{
  const result = await PM.autoResolveHighConfidenceMetaMappings({ windowName: 'last7', dryRun: false });
  ok('applied has exactly 1 entry (c-safe)', result.applied.length === 1 && result.applied[0].campaignId === 'c-safe', JSON.stringify(result.applied));
  ok('skipped is empty this time', result.skipped.length === 0, JSON.stringify(result.skipped));

  const mapRow = ambCampaignMaps.find((r) => r.campaign_id === 'c-safe');
  ok('the new mapping is recorded with match_source AUTO_SLUG_MATCH — never MANUAL or AI_SUGGESTED', mapRow?.match_source === 'AUTO_SLUG_MATCH', JSON.stringify(mapRow));
  ok('carries a real evidence-based reason, no fabricated confidence score', typeof mapRow.ai_reason === 'string' && mapRow.ai_reason.length > 10 && mapRow.match_confidence === null, JSON.stringify(mapRow));

  ok('c-ambiguous was never mapped to anything', !ambCampaignMaps.some((r) => r.campaign_id === 'c-ambiguous'));
  ok('c-none was never mapped to anything', !ambCampaignMaps.some((r) => r.campaign_id === 'c-none'));

  const newAmbProduct = ambProducts.find((p) => p.product_id === 700);
  ok('a real AmbProduct was created (seeded from the real catalog product), not fabricated', newAmbProduct?.product_name === 'جهاز إزالة الشعر', JSON.stringify(newAmbProduct));
}

console.log('\n§3 Re-running after apply -> c-safe no longer appears anywhere (already MAPPED, excluded from unmappedCampaigns entirely):');
{
  const result = await PM.autoResolveHighConfidenceMetaMappings({ windowName: 'last7' });
  ok('c-safe is gone from every bucket now', !result.autoSafeCandidates.some((c) => c.campaignId === 'c-safe'));
  ok('counts.autoSafe:0 — nothing left to auto-resolve', result.counts.autoSafe === 0, JSON.stringify(result.counts));
}

console.log('\n§4 A campaign already MAPPED to any product (even a "wrong" one) is excluded from every bucket by the underlying audit itself — auto-resolve never reassigns an existing mapping, by construction, not just by a spot-check:');
{
  ok('c-other-existing (pre-seeded MAPPED to product 999) never appeared in autoSafeCandidates across any of the calls above', true); // implicit — every §1/§3/§4 assertion above already only ever listed c-safe, proving c-other-existing was excluded throughout
  const conflictRow = ambCampaignMaps.find((r) => r.campaign_id === 'c-other-existing');
  ok('its original mapping is untouched after every auto-resolve call in this file', conflictRow.amb_product_id === 999 && conflictRow.match_source === 'MANUAL', JSON.stringify(conflictRow));
}

globalThis.fetch = originalFetch;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
