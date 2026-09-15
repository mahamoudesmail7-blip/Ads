// Product ↔ Meta Campaign mapping — reuses AI Media Buyer's existing
// AmbProduct/AmbProductCampaignMap architecture end to end (no new table,
// no new write path). Tests services/amb/productMarketing.js's
// getMetaMappingSuggestions()/confirmMetaMapping() plus a regression check
// that the EXISTING Campaign->AdSet->Ad hierarchy (hierarchyAnalysis.js)
// stays correctly scoped to only MAPPED campaigns.
//
// Every prisma model this flow can legitimately write to (ambProduct,
// ambProductCampaignMap) is a stateful in-memory mock. Every model it must
// NEVER write to (product, easyOrdersOrder, dailyOrder,
// productMarketingProfile, productMarketingSnapshot) throws if any write
// method is called — proving zero Product/Easy Orders/Meta writes.
//   node src/scripts/productMarketingMetaMappingTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

// ---------------------------------------------------------------------------
// Write guards — these models must NEVER be written to by this feature.
// ---------------------------------------------------------------------------
let dbWriteAttempted = false;
for (const model of ['product', 'easyOrdersOrder', 'dailyOrder', 'productMarketingProfile', 'productMarketingSnapshot']) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const orig = prisma[model]?.[method]?.bind(prisma[model]);
    if (!orig) continue;
    prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called — this feature must never write here.`); };
  }
}

// ---------------------------------------------------------------------------
// In-memory tables this feature IS allowed to touch.
// ---------------------------------------------------------------------------
let ambProducts = [];
let ambCampaignMaps = []; // { id, amb_product_id, ad_account_id, campaign_id, campaign_name, status, match_source, match_confidence, ai_reason }
let nextAmbProductId = 1;
let nextMapId = 1;

prisma.ambProduct.findUnique = async ({ where }) => {
  if (where.id !== undefined) return ambProducts.find((p) => p.id === where.id) || null;
  if (where.product_id !== undefined) return ambProducts.find((p) => p.product_id === where.product_id) || null;
  return null;
};
prisma.ambProduct.create = async ({ data }) => {
  const row = { id: nextAmbProductId++, active: true, ...data };
  ambProducts.push(row);
  return { ...row };
};
prisma.ambProduct.findMany = async ({ where = {} } = {}) => {
  let rows = ambProducts;
  if ('active' in where) rows = rows.filter((p) => p.active === where.active);
  return rows.map((r) => ({ ...r }));
};

prisma.ambProductCampaignMap.findMany = async ({ where = {}, include } = {}) => {
  let rows = ambCampaignMaps;
  if (where.amb_product_id !== undefined) rows = rows.filter((r) => r.amb_product_id === where.amb_product_id);
  if (where.ad_account_id !== undefined) rows = rows.filter((r) => r.ad_account_id === where.ad_account_id);
  if (where.status !== undefined) rows = rows.filter((r) => r.status === where.status);
  if (where.campaign_id?.in) rows = rows.filter((r) => where.campaign_id.in.includes(r.campaign_id));
  if (include?.amb_product) return rows.map((r) => ({ ...r, amb_product: ambProducts.find((p) => p.id === r.amb_product_id) || null }));
  return rows.map((r) => ({ ...r }));
};
prisma.ambProductCampaignMap.findUnique = async ({ where }) => {
  const [adAccountId, campaignId] = [where.ad_account_id_campaign_id.ad_account_id, where.ad_account_id_campaign_id.campaign_id];
  return ambCampaignMaps.find((r) => r.ad_account_id === adAccountId && r.campaign_id === campaignId) || null;
};
prisma.ambProductCampaignMap.count = async ({ where = {} } = {}) => (await prisma.ambProductCampaignMap.findMany({ where })).length;
prisma.ambProductCampaignMap.upsert = async ({ where, create, update }) => {
  const [adAccountId, campaignId] = [where.ad_account_id_campaign_id.ad_account_id, where.ad_account_id_campaign_id.campaign_id];
  const existing = ambCampaignMaps.find((r) => r.ad_account_id === adAccountId && r.campaign_id === campaignId);
  if (existing) { Object.assign(existing, update); return { ...existing }; }
  const row = { id: nextMapId++, created_at: new Date(), updated_at: new Date(), ...create };
  ambCampaignMaps.push(row);
  return { ...row };
};

prisma.settings.findUnique = async () => null; // createFromCatalogProduct's getAmbSettings() falls back to real code defaults, never invented here

const AD_ACCOUNT_ID = 'act_test123';
prisma.metaConnection.findUnique = async () => ({ id: 'default', status: 'CONNECTED', selected_ad_account_id: AD_ACCOUNT_ID });

// ---------------------------------------------------------------------------
// In-memory MetaPerformanceSnapshot rows — the REAL entityWindowMetrics/
// aggregateRows pipeline runs on top of these (not mocked), same as
// production, so this test exercises the real aggregation logic.
// ---------------------------------------------------------------------------
let internalProducts = [
  { id: 300, product_name: 'اختبار المنتج الأول', sku: null, active: true },
  { id: 301, product_name: 'اختبار المنتج الثاني', sku: null, active: true },
];
prisma.product.findMany = async () => internalProducts.map((p) => ({ ...p }));
prisma.product.findUnique = async ({ where }) => internalProducts.find((p) => p.id === where.id) || null;

function snapshotRow({ level, campaignId, campaignName, adsetId, adId, spend, purchases, dateStart = '2026-09-10' }) {
  return {
    sync_run_id: 1, snapshot_at: new Date(), ad_account_id: AD_ACCOUNT_ID, level, date_start: dateStart, date_stop: dateStart,
    campaign_id: campaignId, campaign_name: campaignName,
    adset_id: adsetId || null, adset_name: adsetId ? `${adsetId}-name` : null,
    ad_id: adId || null, ad_name: adId ? `${adId}-name` : null,
    spend, impressions: spend ? spend * 20 : 0, clicks: spend ? Math.round(spend / 2) : 0,
    meta_purchases: purchases, meta_revenue: purchases ? purchases * 500 : null, results: null,
  };
}

let snapshotRows = [
  // Product 1 candidate campaigns — slug "GlowBrush", unique in the account.
  snapshotRow({ level: 'campaign', campaignId: 'c1', campaignName: 'GlowBrush _ scale 1', spend: 1000, purchases: 10 }),
  snapshotRow({ level: 'campaign', campaignId: 'c2', campaignName: 'GlowBrush _ scale 2', spend: 2000, purchases: 20 }),
  snapshotRow({ level: 'adset', adsetId: 'as1', campaignId: 'c1', campaignName: 'GlowBrush _ scale 1', spend: 1000, purchases: 10 }),
  snapshotRow({ level: 'ad', adId: 'ad1', adsetId: 'as1', campaignId: 'c1', campaignName: 'GlowBrush _ scale 1', spend: 1000, purchases: 10 }),
  // A totally unrelated campaign — must never be swept into product 1's suggestions/hierarchy.
  snapshotRow({ level: 'campaign', campaignId: 'c9', campaignName: 'Unrelated-Other-Product _ scale', spend: 500, purchases: 5 }),
  snapshotRow({ level: 'adset', adsetId: 'as9', campaignId: 'c9', campaignName: 'Unrelated-Other-Product _ scale', spend: 500, purchases: 5 }),
  snapshotRow({ level: 'ad', adId: 'ad9', adsetId: 'as9', campaignId: 'c9', campaignName: 'Unrelated-Other-Product _ scale', spend: 500, purchases: 5 }),
  // A campaign whose name contains the full external id but not the slug.
  snapshotRow({ level: 'campaign', campaignId: 'c3', campaignName: 'promo-eo998877-launch', spend: 300, purchases: 3 }),
  // A campaign matching only by exact full product name.
  snapshotRow({ level: 'campaign', campaignId: 'c4', campaignName: 'اختبار المنتج الأول - campaign', spend: 400, purchases: 4 }),
  // A weak/generic-word-only campaign — must be rejected, never suggested.
  snapshotRow({ level: 'campaign', campaignId: 'c5', campaignName: 'عروض اليوم الجديدة', spend: 100, purchases: 1 }),
  // All-name-words-but-not-substring (possible match only).
  snapshotRow({ level: 'campaign', campaignId: 'c6', campaignName: 'المنتج الأول اختبار حملة مبعثرة', spend: 150, purchases: 2 }),
  // A campaign already MAPPED to a DIFFERENT AmbProduct — must show as a conflict, never a suggestion.
  snapshotRow({ level: 'campaign', campaignId: 'c7', campaignName: 'GlowBrush _ scale conflict', spend: 700, purchases: 7 }),
];
// loadSnapshots() now runs a genuine $queryRaw (a real Postgres DISTINCT
// ON) rather than Prisma's findMany({distinct}) ORM sugar — see
// metricsEngineSnapshotVolumeTest.js for why. `level`/`from`/`to` are the
// only plain-string interpolated values in that query (the id-column and
// the account-id filter are Prisma.raw()/Prisma.sql() objects, not plain
// values), so they're recovered positionally here the same way that test
// does. This fixture's rows are already one-per-entity (no duplicate sync
// cycles), so no further dedup simulation is needed.
prisma.$queryRaw = async (strings, ...values) => {
  const [level, from, to] = values.filter((v) => typeof v === 'string');
  return snapshotRows.filter((r) => r.level === level && r.date_start >= from && r.date_start <= to);
};

const PM = await import(pathToFileURL(join(__dirname, '../services/amb/productMarketing.js')).href);
const { buildHierarchy } = await import(pathToFileURL(join(__dirname, '../services/amb/hierarchyAnalysis.js')).href);

function fakeProfile(overrides) {
  return {
    id: 900, product_id: 300, source: 'EASY_ORDERS',
    locked_name: 'اختبار المنتج الأول', easy_orders_slug: 'GlowBrush',
    easy_orders_product_id: 'default::eo998877',
    ...overrides,
  };
}
prisma.productMarketingProfile.findUnique = async ({ where }) => fakeProfile({ id: where.id });

console.log('§1 SLUG suggestion — unique brand slug substring match:');
{
  const r = await PM.getMetaMappingSuggestions({ profileId: 900 });
  ok('status REVIEW_REQUIRED (strong match, not yet confirmed)', r.status === 'REVIEW_REQUIRED', r.status);
  const ids = r.suggestedCampaigns.map((c) => c.campaignId).sort();
  // c7 ("GlowBrush _ scale conflict") is a legitimate 3rd SLUG match at this
  // point — it only becomes a conflict once §5 maps it to a DIFFERENT
  // AmbProduct below.
  ok('suggests c1, c2, and c7 (all real GlowBrush campaigns so far)', JSON.stringify(ids) === JSON.stringify(['c1', 'c2', 'c7']), JSON.stringify(ids));
  ok('match method is SLUG for all', r.suggestedCampaigns.every((c) => c.matchMethod === 'SLUG'), JSON.stringify(r.suggestedCampaigns));
  ok('unrelated campaign c9 is never suggested', !ids.includes('c9'), ids.join(','));
  ok('confirmedCampaigns is empty (nothing MAPPED yet)', r.confirmedCampaigns.length === 0);
}

console.log('\n§2 EXTERNAL_ID suggestion (no slug on the profile):');
{
  prisma.productMarketingProfile.findUnique = async ({ where }) => fakeProfile({ id: where.id, easy_orders_slug: null, easy_orders_product_id: 'default::eo998877' });
  const r = await PM.getMetaMappingSuggestions({ profileId: 900 });
  ok('matches c3 via EXTERNAL_ID', r.suggestedCampaigns.some((c) => c.campaignId === 'c3' && c.matchMethod === 'EXTERNAL_ID'), JSON.stringify(r.suggestedCampaigns));
}

console.log('\n§3 EXACT_NAME suggestion (no slug, no external id on the profile):');
{
  prisma.productMarketingProfile.findUnique = async ({ where }) => fakeProfile({ id: where.id, easy_orders_slug: null, easy_orders_product_id: null });
  const r = await PM.getMetaMappingSuggestions({ profileId: 900 });
  ok('matches c4 via EXACT_NAME', r.suggestedCampaigns.some((c) => c.campaignId === 'c4' && c.matchMethod === 'EXACT_NAME'), JSON.stringify(r.suggestedCampaigns));
  ok('c5 (generic-word-only) is never suggested — weak match rejected', !r.suggestedCampaigns.some((c) => c.campaignId === 'c5'), JSON.stringify(r.suggestedCampaigns));
}

console.log('\n§4 ALL_NAME_WORDS -> REVIEW_REQUIRED, shown but never CONFIRMED automatically:');
{
  prisma.productMarketingProfile.findUnique = async ({ where }) => fakeProfile({ id: where.id, easy_orders_slug: null, easy_orders_product_id: null, locked_name: 'اختبار المنتج الأول مبعثرة' });
  const r = await PM.getMetaMappingSuggestions({ profileId: 900 });
  ok('status REVIEW_REQUIRED', r.status === 'REVIEW_REQUIRED', r.status);
  const c6 = r.suggestedCampaigns.find((c) => c.campaignId === 'c6');
  ok('c6 present as ALL_NAME_WORDS with low confidence', c6?.matchMethod === 'ALL_NAME_WORDS' && c6.confidence < 0.5, JSON.stringify(c6));
  ok('never appears in confirmedCampaigns', !r.confirmedCampaigns.some((c) => c.campaignId === 'c6'));
}

console.log('\n§5 ambiguous campaign (already MAPPED to a DIFFERENT AmbProduct) -> conflict, never suggested:');
{
  const otherAmbProduct = await prisma.ambProduct.create({ data: { product_id: 301, product_name: 'اختبار المنتج الثاني' } });
  await prisma.ambProductCampaignMap.upsert({ where: { ad_account_id_campaign_id: { ad_account_id: AD_ACCOUNT_ID, campaign_id: 'c7' } }, create: { ad_account_id: AD_ACCOUNT_ID, campaign_id: 'c7', campaign_name: 'GlowBrush _ scale conflict', amb_product_id: otherAmbProduct.id, status: 'MAPPED', match_source: 'MANUAL' }, update: {} });

  prisma.productMarketingProfile.findUnique = async ({ where }) => fakeProfile({ id: where.id });
  const r = await PM.getMetaMappingSuggestions({ profileId: 900 });
  ok('c7 listed as a conflict, not a suggestion', r.conflicts.some((c) => c.campaignId === 'c7' && c.mappedToAmbProductId === otherAmbProduct.id), JSON.stringify(r.conflicts));
  ok('c7 never appears in suggestedCampaigns', !r.suggestedCampaigns.some((c) => c.campaignId === 'c7'), JSON.stringify(r.suggestedCampaigns));

  console.log('\n§5b confirmMetaMapping REJECTS an attempt to confirm the conflicted campaign:');
  const confirmResult = await PM.confirmMetaMapping({ profileId: 900, campaignIds: ['c7'], userId: 1 });
  ok('c7 -> REJECTED (already mapped to a different AmbProduct)', confirmResult.results[0].status === 'REJECTED', JSON.stringify(confirmResult.results[0]));
}

console.log('\n§6 invalid campaign id (does not exist in live Meta data) -> REJECTED:');
{
  const r = await PM.confirmMetaMapping({ profileId: 900, campaignIds: ['does-not-exist'], userId: 1 });
  ok('REJECTED, not found', r.results[0].status === 'REJECTED', JSON.stringify(r.results[0]));
}

console.log('\n§8 single confirm — creates the AmbProduct (safe, existing createFromCatalogProduct flow) and MAPS the campaign:');
{
  ok('no AmbProduct exists yet for product 300', (await prisma.ambProduct.findUnique({ where: { product_id: 300 } })) === null);
  const r = await PM.confirmMetaMapping({ profileId: 900, campaignIds: ['c1'], userId: 7 });
  ok('c1 -> MAPPED', r.results[0].status === 'MAPPED', JSON.stringify(r.results[0]));
  const amb = await prisma.ambProduct.findUnique({ where: { product_id: 300 } });
  ok('AmbProduct now exists, seeded from the real catalog Product (name copied, not invented)', amb?.product_name === 'اختبار المنتج الأول', JSON.stringify(amb));
  const mapRow = await prisma.ambProductCampaignMap.findUnique({ where: { ad_account_id_campaign_id: { ad_account_id: AD_ACCOUNT_ID, campaign_id: 'c1' } } });
  ok('a real MAPPED row now exists for c1', mapRow?.status === 'MAPPED' && mapRow.amb_product_id === amb.id, JSON.stringify(mapRow));
}

console.log('\n§9 batch confirmation — only the selected campaigns get mapped, c2 is untouched:');
{
  const before = await prisma.ambProductCampaignMap.findUnique({ where: { ad_account_id_campaign_id: { ad_account_id: AD_ACCOUNT_ID, campaign_id: 'c2' } } });
  ok('c2 not mapped before this batch call', before === null);
  const r = await PM.confirmMetaMapping({ profileId: 900, campaignIds: ['c2'], userId: 7 });
  ok('c2 -> MAPPED', r.results[0].status === 'MAPPED', JSON.stringify(r.results[0]));
}

console.log('\n§10 repeated confirmation / duplicate mapping is idempotent — no duplicate row, same result:');
{
  const beforeCount = ambCampaignMaps.filter((m) => m.campaign_id === 'c1').length;
  const r1 = await PM.confirmMetaMapping({ profileId: 900, campaignIds: ['c1'] }, );
  const r2 = await PM.confirmMetaMapping({ profileId: 900, campaignIds: ['c1'] });
  ok('both repeated confirmations return MAPPED, never an error', r1.results[0].status === 'MAPPED' && r2.results[0].status === 'MAPPED');
  const afterCount = ambCampaignMaps.filter((m) => m.campaign_id === 'c1').length;
  ok('still exactly one row for c1 — no duplicate created', afterCount === 1 && afterCount === beforeCount, `before=${beforeCount} after=${afterCount}`);
}

console.log('\n§11 CONFIRMED status + metaMappedCampaignCount reflect the now-real MAPPED rows (c1 and c2):');
{
  const r = await PM.getMetaMappingSuggestions({ profileId: 900 });
  ok('status CONFIRMED', r.status === 'CONFIRMED', r.status);
  const ids = r.confirmedCampaigns.map((c) => c.campaignId).sort();
  ok('confirmedCampaigns = [c1, c2]', JSON.stringify(ids) === JSON.stringify(['c1', 'c2']), JSON.stringify(ids));
  const amb = await prisma.ambProduct.findUnique({ where: { product_id: 300 } });
  const count = await prisma.ambProductCampaignMap.count({ where: { amb_product_id: amb.id, status: 'MAPPED' } });
  ok('metaMappedCampaignCount-equivalent = 2 (the exact count computeSnapshot() surfaces to the UI)', count === 2, String(count));
}

console.log('\n§12 Campaign -> AdSet -> Ad hierarchy stays correctly scoped to MAPPED campaigns only (existing hierarchyAnalysis.js, regression-checked):');
{
  const settings = { ambMinSpendBeforeDecision: 0, ambMinPurchasesBeforeScaling: 0, ambDefaultTargetCpa: 100, ambNoPurchaseStopMultiplier: 2, ambScaleCpaBetterPct: 10, ambMinPurchasesBeforeScaling2: 0 };
  const tree = await buildHierarchy({ adAccountId: AD_ACCOUNT_ID, window: { from: '2026-09-01', to: '2026-09-14' }, settings });
  const amb = await prisma.ambProduct.findUnique({ where: { product_id: 300 } });
  const productNode = tree.products.find((p) => p.id === String(amb.id));
  ok('product node exists with exactly 2 mapped campaigns (c1, c2)', productNode?.children.length === 2, JSON.stringify(productNode?.children.map((c) => c.id)));
  const campaignIds = productNode.children.map((c) => c.id).sort();
  ok('exactly c1 and c2, never the unrelated c9', JSON.stringify(campaignIds) === JSON.stringify(['c1', 'c2']), JSON.stringify(campaignIds));
  const c1Node = productNode.children.find((c) => c.id === 'c1');
  ok('c1 correctly nests its OWN adset (as1) and ad (ad1)', c1Node.children.some((a) => a.id === 'as1') && c1Node.children.find((a) => a.id === 'as1').children.some((ad) => ad.id === 'ad1'), JSON.stringify(c1Node.children));
  ok('the unrelated campaign c9 (and its adset/ad) never appears anywhere under this product', JSON.stringify(productNode).includes('c9') === false && JSON.stringify(productNode).includes('as9') === false);
  const unmappedIds = tree.unmappedCampaigns.map((c) => c.id);
  ok('c9 correctly appears as an unmapped standalone campaign, not attributed to any product', unmappedIds.includes('c9'), unmappedIds.join(','));
}

console.log('\n§12b a real, existing campaign that is NOT among the automatic name-based suggestions can still be MANUALLY confirmed (Phase 7 fix — a merchant who knows via Ads Manager/destination URL that a differently-named campaign is real must be able to confirm it; only the AUTOMATIC suggestion path stays strict, never a rejection of a deliberate admin-only, explicit choice). Run last so it doesn\'t disturb earlier sections\' "c9 stays unmapped" fixture assumptions:');
{
  const r = await PM.confirmMetaMapping({ profileId: 900, campaignIds: ['c9'] /* real, existing campaign, but its name doesn't match product 300 at all — §12 just proved it's otherwise a legitimate unmapped standalone campaign */, userId: 1 });
  ok('c9 -> MAPPED, not rejected', r.results[0].status === 'MAPPED', JSON.stringify(r.results[0]));
  ok('recorded with matchSource MANUAL (never AI_SUGGESTED for something the algorithm never actually suggested)', r.results[0].matchSource === 'MANUAL', JSON.stringify(r.results[0]));
  const mapRow = await prisma.ambProductCampaignMap.findUnique({ where: { ad_account_id_campaign_id: { ad_account_id: AD_ACCOUNT_ID, campaign_id: 'c9' } } });
  ok('the stored row\'s match_source is MANUAL and carries no fabricated AI confidence/reason', mapRow?.match_source === 'MANUAL' && mapRow.match_confidence === null && mapRow.ai_reason === null, JSON.stringify(mapRow));
}

console.log('\n§13 no Meta/Product/Easy Orders writes anywhere in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
