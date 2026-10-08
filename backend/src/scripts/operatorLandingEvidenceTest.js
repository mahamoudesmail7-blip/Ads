// 🤖 AI Operator — LANDING-PAGE EVIDENCE acceptance: evidence hierarchy, conflict detection, page-ownership proof.
// Pure tests + an injected (offline) analysis dry-run on real data. NO Meta call, NO network. Fixtures use the "__optest_" prefix and are cleaned up.
//   node src/scripts/operatorLandingEvidenceTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const retryDb = async (fn) => { for (let i = 0; i < 8; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 4000)); } } return fn(); };
const { prisma } = await imp('../prisma.js');
const L = await imp('../services/amb/operatorLandingAnalysis.js');
const CX = await imp('../services/amb/operatorContext.js');

console.log('1) slug + page identity + ownership proof');
{
  ok('slug from /products/<slug>', L.slugFromLandingUrl('https://www.x.com/products/Calm-Light?utm=1') === 'calm-light');
  ok('slug from a bare path', L.slugFromLandingUrl('https://x.com/Calm-Light') === 'calm-light');
  const html = '<html><title>مصباح (s6)</title><script>{"store_id":"592da091-37fd-4983-8081-a170fd493fe5","id":"7d679a74-cbd3-4eaa-86b7-da178eff038b"}</script></html>';
  const page = L.extractPageIdentity(html);
  ok('page identity: title, store id, uuids', page.title.includes('مصباح') && page.storeIds[0].startsWith('592da091') && page.uuids.includes('7d679a74-cbd3-4eaa-86b7-da178eff038b'));
  const cats = { 'trendy-storeee': { bySlug: new Map([['calm-light', { id: '7d679a74-cbd3-4eaa-86b7-da178eff038b', name: 'مصباح' }]]) }, default: { bySlug: new Map([['fire-radio', { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'راديو' }]]) } };
  const p1 = L.provePage({ url: 'https://d1.com/products/Calm-Light', page, catalogues: cats });
  ok('PROVEN: the catalogue uuid for that slug is embedded in the page itself', p1.proven && p1.store === 'trendy-storeee');
  const foreign = L.extractPageIdentity('<title>DSP</title>{"store_id":"3efd0080-736e-4f06-ab1b-fb67a71e16b6","id":"625a594b-0c99-4c34-b81b-876aa00ccd55"}');
  const p2 = L.provePage({ url: 'https://smart-estore.myeasyorders.com/products/Calm-Light', page: foreign, catalogues: cats });
  ok('a *.myeasyorders.com page of ANOTHER store proves nothing (even if the slug exists in our catalogue)', !p2.proven && p2.reason === 'PAGE_BELONGS_TO_A_STORE_WE_DO_NOT_OWN', JSON.stringify(p2));
  const p3 = L.provePage({ url: 'https://d1.com/products/other', page, catalogues: cats });
  ok('slug that is not the page product -> not proven', !p3.proven);
  ok('unreachable page -> not proven', !L.provePage({ url: 'https://d1.com/products/Calm-Light', page: null, catalogues: cats }).proven);
  ok('domain is never trusted by itself (same host, different page identity, different verdict)', p1.proven && !p2.proven);
}

console.log('2) evidence hierarchy + conflict detection');
{
  const C = L.classifyCampaignEvidence;
  let r = C({ explicit: 5 }); ok('explicit mapping -> VERIFIED tier 1', r.state === 'VERIFIED' && r.tier === 1);
  r = C({ launch: 7, landing: { productId: 7, proven: true } }); ok('launch + landing agree -> VERIFIED (LAUNCH_AND_LANDING_AGREE)', r.state === 'VERIFIED' && r.basis === 'LAUNCH_AND_LANDING_AGREE');
  r = C({ launch: 404, landing: { productId: 185, proven: true } }); ok('launch ≠ landing(proven) -> CONFLICT, no verified product', r.state === 'CONFLICT' && r.productId === null && r.conflicts.length === 2);
  r = C({ launch: 404, landing: { productId: 185, proven: false, reason: 'PAGE_BELONGS_TO_A_STORE_WE_DO_NOT_OWN' } }); ok('launch + UNPROVEN landing -> the unproven page never creates a conflict (warning only)', r.state === 'VERIFIED' && r.productId === 404 && r.warnings.length === 1);
  r = C({ landing: { productId: 159, proven: true } }); ok('proven landing alone -> VERIFIED tier 3', r.state === 'VERIFIED' && r.tier === 3 && r.basis === 'LANDING_PAGE_VERIFIED');
  r = C({ landing: { productId: 159, proven: false, reason: 'X' } }); ok('unproven landing alone -> never VERIFIED', r.state === 'UNMAPPED');
  r = C({ landing: { productId: 159, proven: true }, keyOrSibling: 141 }); ok('proven landing ≠ name/key suggestion (Selicon) -> CONFLICT', r.state === 'CONFLICT');
  r = C({ landing: { productId: 159, proven: true }, keyOrSibling: 159 }); ok('proven landing + agreeing suggestion -> VERIFIED', r.state === 'VERIFIED');
  r = C({ keyOrSibling: 141 }); ok('name/key suggestion alone -> SUGGESTED only (never VERIFIED)', r.state === 'SUGGESTED' && r.tier === 4);
  r = C({ landing: { productId: 159, proven: true }, lineage: [141] }); ok('clone lineage pointing elsewhere -> CONFLICT', r.state === 'CONFLICT');
  r = C({ explicit: 5, launch: 6 }); ok('explicit ≠ launch -> CONFLICT (human decision vs system record)', r.state === 'CONFLICT');
  r = C({ explicit: 5, landing: { productId: 9, proven: true } }); ok('explicit (human) outranks a differing proven landing: stays VERIFIED with a warning', r.state === 'VERIFIED' && r.productId === 5 && r.warnings.length >= 1);
  r = C({ existing: 126, landing: { productId: 212, proven: true } }); ok('an automatic existing mapping that a PROVEN landing page contradicts -> CONFLICT', r.state === 'CONFLICT');
  r = C({ existing: 126 }); ok('existing automatic mapping with no contrary evidence stays VERIFIED (EXISTING_MAPPING)', r.state === 'VERIFIED' && r.basis === 'EXISTING_MAPPING');
  r = C({}); ok('no evidence -> UNMAPPED', r.state === 'UNMAPPED');
}

ok('persisted conflicts are sticky (only a human MANUAL mapping clears them)', L.isPersistedConflict({ match_source: 'LANDING_CONFLICT' }) && !L.isPersistedConflict({ match_source: 'MANUAL' }) && !L.isPersistedConflict(null));
console.log('3) a persisted conflict is NOT verified for the Operator');
const T = '__optest_land_'; const created = { products: [], maps: [] };
try {
  const p = await retryDb(() => prisma.product.create({ data: { product_name: `${T}p`, product_code: `${T}${Date.now()}`, store_id: 'default', selling_price: 0, product_cost: 0 } })); created.products.push(p.id);
  const amb = await retryDb(() => prisma.ambProduct.create({ data: { product_id: p.id, product_name: `${T}p`, product_cost: 0, pricing_multiplier: 1, suggested_selling_price: 0, packaging_cost: 0, shipping_cost: 0, other_cost: 0, rto_cost: 0, currency: 'EGP' } }));
  const acc = `${T}acc`;
  await retryDb(() => prisma.ambProductCampaignMap.create({ data: { ad_account_id: acc, campaign_id: `${T}c1`, amb_product_id: amb.id, status: 'SUGGESTED', match_source: 'LANDING_CONFLICT', ai_reason: '{"conflicts":[]}' } }));
  await retryDb(() => prisma.ambProductCampaignMap.create({ data: { ad_account_id: acc, campaign_id: `${T}c2`, amb_product_id: amb.id, status: 'MAPPED', match_source: 'LANDING_URL' } }));
  const idx = await retryDb(() => CX.buildCampaignProductIndex({ adAccountId: acc }));
  ok('LANDING_CONFLICT row: indexed but NOT verified (blocks automation)', idx.get(`${T}c1`)?.verified === false && idx.get(`${T}c1`)?.via === 'LANDING_CONFLICT', JSON.stringify(idx.get(`${T}c1`)));
  ok('MAPPED / LANDING_URL row: verified', idx.get(`${T}c2`)?.verified === true);
} finally {
  await retryDb(() => prisma.ambProductCampaignMap.deleteMany({ where: { ad_account_id: { startsWith: T } } }));
  await retryDb(() => prisma.ambProduct.deleteMany({ where: { product_name: { startsWith: T } } }));
  await retryDb(() => prisma.product.deleteMany({ where: { product_name: { startsWith: T } } }));
}

console.log('4) analysis dry-run on real data with an injected offline link source writes nothing');
{
  const before = { maps: await retryDb(() => prisma.ambProductCampaignMap.count()), amb: await retryDb(() => prisma.ambProduct.count()), prod: await retryDb(() => prisma.product.count()) };
  const conn = await imp('../services/metaAuth.js'); const acc = (await retryDb(() => conn.getConnection()))?.selected_ad_account_id;
  if (!acc) { console.log('  (no Meta account connected — skipped)'); } else {
    const res = await retryDb(() => L.analyzeLandingEvidence({ adAccountId: acc, apply: false, maxCampaigns: 5, deps: { token: 'x', catalogues: { catalogues: { default: { bySlug: new Map() }, 'trendy-storeee': { bySlug: new Map() } }, dbByUuid: { default: new Map(), 'trendy-storeee': new Map() } }, collectLinks: async () => ({ ads: 1, links: ['https://nowhere.invalid/products/x'] }), fetchPage: async () => null } }));
    const after = { maps: await retryDb(() => prisma.ambProductCampaignMap.count()), amb: await retryDb(() => prisma.ambProduct.count()), prod: await retryDb(() => prisma.product.count()) };
    ok('dry-run is read-only (no mapping/AMB/product rows changed)', JSON.stringify(before) === JSON.stringify(after) && res.apply === false);
    ok('unreachable pages never produce a verified landing link', res.results.every((d) => d.state === 'ERROR' || d.basis !== 'LANDING_PAGE_VERIFIED'));
    ok('every campaign got a decision (scope respected)', res.scope <= 5 && res.results.length === res.scope);
  }
}
console.log('5) mapping health by campaign family');
{
  const H = await imp('../services/amb/operatorMappingHealth.js');
  ok('family stems', H.familyKeyOf('\u200eSelicon _ scale - 4 - Scale') === 'selicon' && H.familyKeyOf('Hair-Cap - Ci -Gi') === 'hair-cap' && H.familyKeyOf('Smart-Bag-Scale-ABO') === 'smart-bag' && H.familyKeyOf('Mini Camera _ scale 7') === 'mini camera' && H.familyKeyOf('Fire-Radio-NewTest-VO') === 'fire-radio' && H.familyKeyOf('Face-Hair-NewTest-AR') === 'face-hair' && H.familyKeyOf('Smart-Bag-NewTest-AI') === 'smart-bag', [H.familyKeyOf('\u200eSelicon _ scale - 4 - Scale'), H.familyKeyOf('Hair-Cap - Ci -Gi'), H.familyKeyOf('Smart-Bag-Scale-ABO'), H.familyKeyOf('Mini Camera _ scale 7')].join('|'));
  const rows = [
    { campaignId: '1', campaignName: 'Selicon _ scale', state: 'VERIFIED', product: { productId: 141, name: 'brush' }, spend7d: 10 },
    { campaignId: '2', campaignName: 'Selicon _ scale - 2', state: 'VERIFIED', product: { productId: 159, name: 'mask' }, spend7d: 5 },
    { campaignId: '3', campaignName: 'Selicon _ scale - 6', state: 'CONFLICT', spend7d: 0 },
    { campaignId: '4', campaignName: 'Quran _ scale', state: 'SUGGESTED', spend7d: 0 },
    { campaignId: '5', campaignName: 'microscope - Test', state: 'VERIFIED', product: { productId: 36, name: 'micro' }, spend7d: 100 },
    { campaignId: '6', campaignName: 'Air-Blower _ scale', state: 'VERIFIED', product: { productId: 320, name: 'air' }, spend7d: 1 },
    { campaignId: '7', campaignName: 'Air-Blower _ scale - 2', state: 'VERIFIED', product: { productId: 320, name: 'air' }, spend7d: 1 },
  ];
  const rep = H.buildFamilyReport(rows, { externalIds: new Set(['5']) });
  ok('counts include EXTERNAL_STORE and add up', rep.counts.VERIFIED === 4 && rep.counts.EXTERNAL_STORE === 1 && rep.counts.CONFLICT === 1 && rep.counts.SUGGESTED === 1 && Object.values(rep.counts).reduce((a, b) => a + b, 0) === rows.length, JSON.stringify(rep.counts));
  const sel = rep.families.find((f) => f.family === 'selicon');
  ok('a family verified to two products is flagged MULTI_PRODUCT + HAS_CONFLICT -> NEEDS_DECISION', sel.flags.includes('MULTI_PRODUCT') && sel.flags.includes('HAS_CONFLICT') && sel.health === 'NEEDS_DECISION' && sel.total === 3);
  ok('a fully verified single-product family is HEALTHY', rep.families.find((f) => f.family === 'air-blower').health === 'HEALTHY');
  ok('external-store family needs a decision', rep.families.find((f) => f.family === 'microscope').health === 'NEEDS_DECISION');
}
console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
