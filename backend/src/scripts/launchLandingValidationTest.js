// Mandatory pre-launch Product / Landing validation (launchLandingValidation.js + launchBuilder + publish gate).
// Fully offline: catalogues and pages are injected; the module has NO Meta import, so no Meta call is possible. Fixtures use "__optest_" and are cleaned up.
//   node src/scripts/launchLandingValidationTest.js
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const retryDb = async (fn) => { for (let i = 0; i < 8; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 4000)); } } return fn(); };
delete process.env.LAUNCH_LANDING_VALIDATION_TEST_BYPASS; // this suite tests the REAL gate
const { prisma } = await imp('../prisma.js');
const V = await imp('../services/amb/launchLandingValidation.js');
const B = await imp('../services/amb/launchBuilder.js');
const P = await imp('../services/amb/landingProof.js');

// ---- injected world -------------------------------------------------------------------------------------------------------------------------------
const U = { u185: '7d679a74-cbd3-4eaa-86b7-da178eff038b', u404: 'a7bc2c87-3134-49f3-9a47-9d26473b7639', t322: '23ab676a-0000-4000-8000-000000000322', d129: '02fba30b-0000-4000-8000-000000000129', dupA: 'aaaa0001-0000-4000-8000-00000000000a', dupB: 'bbbb0002-0000-4000-8000-00000000000b' };
const catalogues = {
  'trendy-storeee': { bySlug: new Map([['calm-light', { id: U.u185, name: 'مصباح القمر الليلي' }], ['moon-speaker', { id: U.u404, name: 'مصباح القمر الذكي' }], ['fire-radio', { id: U.t322, name: 'راديو' }], ['dup-a', { id: U.dupA, name: 'منتج مكرر' }], ['dup-b', { id: U.dupB, name: 'منتج مكرر' }]]) },
  default: { bySlug: new Map([['fire-radio', { id: U.d129, name: 'راديو' }]]) },
};
const dbByUuid = {
  'trendy-storeee': new Map([[U.u185, { id: 185, product_name: 'مصباح القمر الليلي' }], [U.u404, { id: 404, product_name: 'مصباح القمر الذكي' }], [U.t322, { id: 322, product_name: 'راديو' }], [U.dupA, { id: 901, product_name: 'منتج مكرر' }], [U.dupB, { id: 902, product_name: 'منتج مكرر' }]]),
  default: new Map([[U.d129, { id: 129, product_name: 'راديو' }]]),
};
// url -> the uuids the page embeds about itself (null = unreachable)
const pages = new Map([
  ['https://shop.example/products/Calm-Light', { storeIds: ['S-T'], uuids: [U.u185, 'S-T'] }],
  ['https://shop.example/products/Moon-Speaker', { storeIds: ['S-T'], uuids: [U.u404] }],
  ['https://shop.example/products/Fire-Radio', { storeIds: ['S-T'], uuids: [U.t322] }],
  ['https://shop.example/products/Dup-B', { storeIds: ['S-T'], uuids: [U.dupB] }],
  ['https://foreign.example/products/Calm-Light', { storeIds: ['S-OTHER'], uuids: ['99999999-9999-4999-8999-999999999999'] }],
  ['https://shop.example/products/Unknown-Thing', { storeIds: ['S-T'], uuids: ['11111111-1111-4111-8111-111111111111'] }],
]);
const fetchPage = async (url) => pages.get(String(url).split('?')[0]) || null;
const deps = { catalogues: { catalogues, dbByUuid }, fetchPage };
const sel = (id, store, uuid, name) => ({ id, store_id: store, easy_orders_uuid: uuid, product_name: name });
const run = (product, urls) => V.validateLaunchLanding({ product, campaigns: urls.map((u, i) => ({ name: `C${i + 1}`, websiteUrl: u })), deps: { ...deps, catalogues: deps.catalogues } });

console.log('1) the six required cases');
{
  let r = await run(sel(185, 'trendy-storeee', U.u185, 'مصباح القمر الليلي'), ['https://shop.example/products/Calm-Light?utm=1']);
  ok('correct product -> OK (evidence saved)', r.ok && r.evidence.ok && r.evidence.results[0].status === 'VERIFIED' && r.evidence.results[0].productId === 185 && r.evidence.productEoUuid === U.u185);
  r = await run(sel(404, 'trendy-storeee', U.u404, 'مصباح القمر الذكي'), ['https://shop.example/products/Calm-Light']);
  ok('wrong product, same store (the Calm-Light / Moon-Speaker mistake) -> BLOCK', !r.ok && r.errors[0].code === 'WRONG_PRODUCT' && r.errors[0].pageProductId === 185, JSON.stringify(r.errors));
  r = await run(sel(129, 'default', U.d129, 'راديو'), ['https://shop.example/products/Fire-Radio']);
  ok('wrong store (same product name in the other store) -> BLOCK WRONG_STORE', !r.ok && r.errors[0].code === 'WRONG_STORE' && r.errors[0].pageStore === 'trendy-storeee' && r.errors[0].productStore === 'default', JSON.stringify(r.errors));
  r = await run(sel(185, 'trendy-storeee', U.u185, 'مصباح'), ['https://foreign.example/products/Calm-Light']);
  ok('unknown / foreign-store URL -> BLOCK (a domain is never trusted)', !r.ok && r.errors[0].code === 'PAGE_BELONGS_TO_A_STORE_WE_DO_NOT_OWN', JSON.stringify(r.errors));
  r = await run(sel(185, 'trendy-storeee', U.u185, 'مصباح'), ['https://shop.example/']);
  ok('URL that is not a product page -> BLOCK', !r.ok);
  r = await run(sel(901, 'trendy-storeee', U.dupA, 'منتج مكرر'), ['https://shop.example/products/Dup-B']);
  ok('duplicate-name products: selected A, page is B -> BLOCK DUPLICATE_NAME_DIFFERENT_PRODUCT', !r.ok && r.errors[0].code === 'DUPLICATE_NAME_DIFFERENT_PRODUCT', JSON.stringify(r.errors));
  r = await run(sel(185, 'trendy-storeee', U.u185, 'مصباح'), ['https://shop.example/products/Calm-Light']);
  ok('same inputs, page reachable -> OK', r.ok);
  const down = await V.validateLaunchLanding({ product: sel(185, 'trendy-storeee', U.u185, 'مصباح'), campaigns: [{ name: 'C1', websiteUrl: 'https://down.example/products/Calm-Light' }], deps: { ...deps, fetchPage: async () => null } });
  ok('unreachable page -> BLOCK PAGE_UNREACHABLE (not a warning)', !down.ok && down.errors[0].code === 'PAGE_UNREACHABLE');
}

console.log('2) identity of the SELECTED product + mixed campaigns');
{
  let r = await run(sel(185, 'trendy-storeee', null, 'مصباح'), ['https://shop.example/products/Calm-Light']);
  ok('selected product has no Easy Orders uuid -> BLOCK (identity unresolved)', !r.ok && r.errors[0].code === 'PRODUCT_NOT_LINKED_TO_EASY_ORDERS');
  r = await run(sel(185, null, U.u185, 'مصباح'), ['https://shop.example/products/Calm-Light']);
  ok('selected product has no store -> BLOCK', !r.ok && r.errors[0].code === 'PRODUCT_STORE_UNRESOLVED');
  r = await run(sel(185, 'trendy-storeee', U.u185, 'مصباح القمر الليلي'), ['https://shop.example/products/Calm-Light', 'https://shop.example/products/Moon-Speaker']);
  ok('one good + one wrong campaign -> BLOCK listing only the wrong one', !r.ok && r.errors.length === 1 && r.errors[0].campaign === 'C2' && r.evidence.ok === false);
  ok('the Arabic block message names the campaign and the page product', V.landingBlockMessage(r.errors).includes('C2') && V.landingBlockMessage(r.errors).includes('الإطلاق ممنوع'));
}

console.log('3) the bypass can never exist in production');
{
  process.env.LAUNCH_LANDING_VALIDATION_TEST_BYPASS = '1'; const old = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  const r = await V.validateLaunchLanding({ product: sel(404, 'trendy-storeee', U.u404, 'x'), campaigns: [{ name: 'C1', websiteUrl: 'https://shop.example/products/Calm-Light' }], deps });
  ok('with NODE_ENV=production the test bypass is ignored (wrong product still blocked)', !r.ok);
  process.env.NODE_ENV = old; delete process.env.LAUNCH_LANDING_VALIDATION_TEST_BYPASS; if (old === undefined) delete process.env.NODE_ENV;
}

console.log('4) wizard: validateLaunchConfig / createDraftJob / publish gate (real DB fixtures, no Meta)');
const T = '__optest_land_'; const created = { products: [], jobs: [] };
try {
  const prod = await retryDb(() => prisma.product.create({ data: { product_name: `${T}p`, product_code: `${T}${Date.now()}`, store_id: 'default', easy_orders_uuid: `${T}uuid`, selling_price: 0, product_cost: 0 } })); created.products.push(prod.id);
  const input = (url) => ({ adAccountId: 'act_optest', pageId: 'pg_optest', productId: prod.id, budgetMode: 'CBO', budget: { cbo: { dailyBudgetMinor: 10000 } }, pixelId: 'px', platforms: ['facebook'], adSetsPerCampaign: 1, adsPerAdSet: 1, campaigns: [{ name: 'T1', websiteUrl: url }], startMode: 'NOW', launchMode: 'PAUSED_REVIEW' });
  const okValidator = async ({ product, campaigns }) => ({ ok: true, errors: [], evidence: { version: 1, ok: true, validatedAt: new Date().toISOString(), productId: product.id, results: campaigns.map((c) => ({ url: c.websiteUrl.split('?')[0], status: 'VERIFIED', productId: product.id, store: product.store_id })) } });
  const badValidator = async () => ({ ok: false, errors: [{ code: 'WRONG_PRODUCT', message: 'x', campaign: 'T1' }], evidence: { ok: false } });
  let blocked = null; try { await B.validateLaunchConfig(input('https://shop.example/products/Calm-Light'), { landingValidator: badValidator }); } catch (e) { blocked = e; }
  ok('validateLaunchConfig throws LANDING_VALIDATION_BLOCK (400) on a mismatch', blocked?.code === 'LANDING_VALIDATION_BLOCK' && blocked.status === 400);
  const jobId = `optestland${Date.now()}`; created.jobs.push(jobId);
  let blocked2 = null; try { await B.createDraftJob({ jobId, userId: null, input: input('https://shop.example/products/Calm-Light'), landingValidator: badValidator }); } catch (e) { blocked2 = e; }
  ok('createDraftJob blocks BEFORE any job/campaign row is written', blocked2?.code === 'LANDING_VALIDATION_BLOCK' && (await retryDb(() => prisma.ambLaunchJob.count({ where: { job_id: jobId } }))) === 0);
  const job = await B.createDraftJob({ jobId, userId: null, input: input('https://shop.example/products/Calm-Light'), landingValidator: okValidator });
  const cfg = JSON.parse(job.config_json);
  ok('validation evidence is stored with the launch job (config_json.landingValidation)', cfg.landingValidation?.ok === true && cfg.landingValidation.results[0].productId === prod.id);
  const full = await retryDb(() => prisma.ambLaunchJob.findUnique({ where: { job_id: jobId }, include: { campaigns: true } }));
  const g1 = await V.assertLaunchLandingVerified(full);
  ok('publish gate: fresh matching evidence passes without any network call', g1.cached === true);
  // evidence for a different product => the gate re-validates live and BLOCKS (selected product has no real page in the injected world)
  const tampered = { ...full, config_json: JSON.stringify({ ...cfg, landingValidation: { ...cfg.landingValidation, productId: 999999 } }) };
  let gate = null; try { await V.assertLaunchLandingVerified(tampered, { deps }); } catch (e) { gate = e; }
  ok('publish gate: stale/foreign evidence -> live re-validation -> BLOCK before any Meta write', gate?.code === 'LANDING_VALIDATION_BLOCK');
  const old = { ...full, config_json: JSON.stringify({ ...cfg, landingValidation: { ...cfg.landingValidation, validatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() } }) };
  let gate2 = null; try { await V.assertLaunchLandingVerified(old, { deps }); } catch (e) { gate2 = e; }
  ok('publish gate: evidence older than 24h is not trusted (re-validated, blocked here)', gate2?.code === 'LANDING_VALIDATION_BLOCK');
  const after = JSON.parse((await retryDb(() => prisma.ambLaunchJob.findUnique({ where: { job_id: jobId } }))).config_json);
  ok('the failed re-validation is persisted as evidence (ok:false) for the audit trail', after.landingValidation?.ok === false);
  const pub = await import('../services/amb/launchPublish.js');
  let q = null; try { await pub.startLaunchQueue({ jobId, userId: null }); } catch (e) { q = e; }
  ok('startLaunchQueue refuses to start while the landing identity is unverified (landing block, not another check)', q?.code === 'LANDING_VALIDATION_BLOCK', q?.message);
} finally {
  await retryDb(() => prisma.ambLaunchAudit.deleteMany({ where: { job_id: { in: created.jobs } } }));
  await retryDb(() => prisma.ambLaunchCampaign.deleteMany({ where: { job_id: { in: created.jobs } } }));
  await retryDb(() => prisma.ambLaunchJob.deleteMany({ where: { job_id: { in: created.jobs } } }));
  await retryDb(() => prisma.product.deleteMany({ where: { product_name: { startsWith: T } } }));
  const left = { jobs: await prisma.ambLaunchJob.count({ where: { job_id: { in: created.jobs } } }), products: await prisma.product.count({ where: { product_name: { startsWith: T } } }) };
  ok('cleanup: no fixtures left', left.jobs === 0 && left.products === 0, JSON.stringify(left));
}
console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
