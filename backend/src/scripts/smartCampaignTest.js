// 🧪 Smart Campaign — the journey on top of a page project: AI research (mocked), audience → targeting, the readiness checklist and the step bar.
//   node src/scripts/smartCampaignTest.js
import './_testGuard.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const { prisma } = await imp('../prisma.js');
const PP = await imp('../services/amb/media/pageProjects.js');
const SC = await imp('../services/amb/media/smartCampaign.js');
const SL = await imp('../services/amb/media/smartLaunch.js');
const EP = await imp('../services/amb/media/eoPublish.js');
import fs from 'node:fs';
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const made = [];

try {
  console.log('\n1. sanitizeResearch (pure)');
  const r = SC.sanitizeResearch({
    summary: ' جهاز   مساج ', audience: { gender: 'female', ageMin: 70, ageMax: 10, interests: ['Beauty', 'Beauty', '', { name: 'Home appliance' }, 'x'.repeat(200)], description: 'ستات' },
    benefits: ['ب'.repeat(300), 'خفيف'], painPoints: [], angles: [{ name: 'راحة', hook: 'تعبان؟' }, { name: '', hook: 'x' }, { name: 'سعر' }],
    policyCautions: ['بلاش علاج'], keywords: { videoSearch: ['neck massager'], tiktok: [], instagramHashtags: ['massage'] },
  });
  ok('audience: gender upper-cased and validated, ages clamped to 18–65 and ordered (70/10 → 18..65)', r.audience.gender === 'FEMALE' && r.audience.ageMin === 18 && r.audience.ageMax === 65, JSON.stringify(r.audience));
  ok('lists are bounded and cleaned (empty dropped, object entries read, long text capped)', r.audience.interests.length === 4 && r.audience.interests.includes('Home appliance') && r.audience.interests.every((x) => x.length <= 60) && r.benefits[0].length <= 120);
  ok('angles need BOTH a name and a hook', r.angles.length === 1 && r.angles[0].name === 'راحة');
  const junk = SC.sanitizeResearch(null);
  ok('garbage in → a valid empty shape (ALL genders, default ages), never a crash', junk.audience.gender === 'ALL' && junk.audience.ageMin === 22 && junk.audience.ageMax === 55 && junk.angles.length === 0);
  ok('suggestTargeting maps the audience onto the builder (custom, gender, ages, interests); no research → null', SC.suggestTargeting(r).genders === 'FEMALE' && SC.suggestTargeting(r).mode === 'CUSTOM' && SC.suggestTargeting(null) === null);

  console.log('\n2. runResearch (AI mocked)');
  const p = await PP.createProject({ name: 'جهاز مساج الرقبة', price: 399, facts: ['6 سرعات', 'بطارية 4 ساعات', 'خفيف'], eo: { id: 'eo1', storeId: 's', categories: ['مساج'], quantity: 5, trackStock: true } });
  made.push(p.id);
  let seen = null;
  const gen = async (args) => { seen = args; return { text: JSON.stringify({ summary: 'جهاز مساج', audience: { gender: 'FEMALE', ageMin: 25, ageMax: 45, interests: ['Massage'], description: 'ستات شغالة' }, benefits: ['راحة'], painPoints: ['شد الرقبة'], angles: [{ name: 'راحة', hook: 'ريّح رقبتك' }], policyCautions: ['من غير علاج'], keywords: { videoSearch: ['neck massager'] } }) }; };
  const res = await SC.runResearch(p.id, { deps: { ai: true, generate: gen, loadReference: async () => null } });
  const saved = await PP.getProject(p.id);
  ok('the research is saved on the project (smart.research) with a timestamp', saved.smart.research.audience.gender === 'FEMALE' && saved.smart.research.at && res.painPoints[0] === 'شد الرقبة');
  ok('the prompt carries the REAL facts and category (no invention)', /6 سرعات/.test(seen.messages[0].content[0].text) && /مساج/.test(seen.messages[0].content[0].text) && /ممنوع/.test(seen.system));
  let e = await rejects(SC.runResearch(p.id, { deps: { ai: false } }));
  ok('no AI key → NOT_CONFIGURED', e?.code === 'NOT_CONFIGURED');
  const nofacts = await PP.createProject({ name: 'منتج من غير معلومات' }); made.push(nofacts.id);
  e = await rejects(SC.runResearch(nofacts.id, { deps: { ai: true, generate: gen } }));
  ok('no facts → NO_FACTS (the research must not be built on nothing)', e?.code === 'NO_FACTS');
  e = await rejects(SC.runResearch(p.id, { deps: { ai: true, generate: async () => ({ text: 'not json' }), loadReference: async () => null } }));
  ok('a model that returns junk → a clear RESEARCH_FAILED, the old research is kept', e?.code === 'RESEARCH_FAILED' && (await PP.getProject(p.id)).smart.research.audience.gender === 'FEMALE');
  e = await rejects(SC.runResearch('aaaaaaaaaaaa', { deps: { ai: true, generate: gen } }));
  ok('unknown project → NOT_FOUND', e?.code === 'NOT_FOUND');

  console.log('\n3. readiness + step bar');
  const base = (o = {}) => ({ name: 'x', facts: ['a', 'b', 'c'], reference: { mime: 'image/png' }, eo: { id: 'e', name: 'منتج', trackStock: true, quantity: 9 }, images: [], videos: [], copy: null, smart: {}, ...o });
  const img = (n) => Array.from({ length: n }, (_, i) => ({ id: 'img' + i, status: 'READY' }));
  const empty = SC.readiness(base());
  ok('a fresh journey is NOT ready: no images and no captions are blockers', !empty.ready && empty.blockers.includes('مفيش صور جاهزة') && empty.blockers.includes('مفيش كابشنات'), JSON.stringify(empty.blockers));
  const full = SC.readiness(base({ images: img(4), copy: { captions: [{ primary: 'a', headline: 'b' }], claimIssues: [] }, videos: [{ id: 'v', kind: 'AI' }], smart: { research: { audience: { interests: ['x'] }, angles: [] } } }));
  ok('images + a caption + research + an AI video → ready with no warnings', full.ready && full.warnings === 0, JSON.stringify(full.items.filter((i) => i.level !== 'ok')));
  const stock0 = SC.readiness(base({ eo: { id: 'e', name: 'منتج', trackStock: true, quantity: 0 }, images: img(3), copy: { captions: [{ primary: 'a' }] } }));
  ok('stock 0 on a tracked product is a hard blocker; an untracked stock is fine', !stock0.ready && stock0.blockers.includes('المخزون خلص') && SC.readiness(base({ eo: { id: 'e', name: 'منتج', trackStock: false }, images: img(3), copy: { captions: [{ primary: 'a' }] } })).ready);
  const cl = SC.readiness(base({ images: img(3), copy: { captions: [{ primary: 'نتيجة مضمونة' }], claimIssues: [{ field: 'caption1', text: 'نتيجة مضمونة', reason: 'ادعاء نتيجة مضمونة' }, { field: 'title', text: 'x', reason: 'y' }] } }));
  ok('a flagged caption is a warning (not a blocker) and a flagged TITLE does not count against the captions', cl.ready && cl.items.find((i) => i.key === 'captions').level === 'warn' && /ادعاء نتيجة مضمونة/.test(cl.items.find((i) => i.key === 'captions').detail));
  ok('1-2 images warn, 0 images fail; link-only videos warn and say they need importing', SC.readiness(base({ images: img(2) })).items.find((i) => i.key === 'images').level === 'warn' && SC.readiness(base({ videos: [{ id: 'v', kind: 'LINK' }] })).items.find((i) => i.key === 'videos').detail.includes('استيراد'));
  ok('no reference photo is a blocker; an unlinked product is a warning only', SC.readiness(base({ reference: null })).blockers.includes('مفيش صورة للمنتج') && SC.readiness(base({ eo: null })).items.find((i) => i.key === 'product').level === 'warn');
  const steps = SC.stepStates(base({ images: img(3), copy: { captions: [{ primary: 'a' }] }, smart: { research: { audience: {} }, launch: { jobId: 'j1', status: 'DRAFT' } } }));
  ok('step bar (the reference UI order): info · research · images · page · publish · captions · videos · campaign; research / images / captions done, campaign in progress (warn)', steps.map((x) => x.key).join() === 'info,research,images,page,publish,captions,videos,campaign' && steps.find((x) => x.key === 'research').state === 'done' && steps.find((x) => x.key === 'images').state === 'done' && steps.find((x) => x.key === 'captions').state === 'done' && steps.find((x) => x.key === 'captions').sub === '1 كابشن' && steps.find((x) => x.key === 'campaign').state === 'warn', JSON.stringify(steps.map((x) => x.key + ':' + x.state)));
  ok('a product that lives on the store: its page and publish steps read «صفحتك جاهزة» (store state) until the owner writes a page / publishes; a finished launch is done; an out-of-stock product marks step 1 failed', SC.stepStates(base()).find((x) => x.key === 'page').state === 'store' && SC.stepStates(base()).find((x) => x.key === 'publish').sub === 'صفحتك جاهزة' && SC.stepStates(base({ smart: { launch: { status: 'COMPLETE' } } })).find((x) => x.key === 'campaign').state === 'done' && SC.stepStates(base({ eo: { id: 'e', name: 'x', trackStock: true, quantity: 0 } })).find((x) => x.key === 'info').state === 'fail');

  console.log('\n4. launch bridge: context, asset registration, link');
  ok('landingGuess: store domain + slug (https, no double slash); no domain or no slug → empty (the owner types it)', SL.landingGuess({ domain: 'https://trendy.shop/', slug: 'neck-massager' }) === 'https://trendy.shop/products/neck-massager' && SL.landingGuess({ domain: '', slug: 'x' }) === '' && SL.landingGuess({ domain: 'a.b', slug: '' }) === '');
  const lp = await PP.createProject({ name: 'منتج للكامبين', facts: ['a', 'b', 'c'], eo: { id: 'eo-ctx-1', storeId: 'trendy-storeee', slug: 'camp-prod', name: 'منتج للكامبين' } }); made.push(lp.id);
  const prod = await prisma.product.create({ data: { product_name: 'SC Test Product', easy_orders_uuid: 'eo-ctx-1', store_id: 'trendy-storeee', active: true } });
  let synced = null;
  const ctx1 = await SL.launchContext(lp.id, { deps: { listLaunchableProducts: async (a) => { synced = a; return []; } } });
  ok('context finds the internal Product by the Easy Orders id and syncs the store first', ctx1.linked && ctx1.found && ctx1.productId === prod.id && synced?.storeId === 'trendy-storeee', JSON.stringify(ctx1));
  const unl = await PP.createProject({ name: 'غير مربوط' }); made.push(unl.id);
  ok('an unlinked page → linked:false with a reason (no crash)', (await SL.launchContext(unl.id, { deps: { listLaunchableProducts: async () => [] } })).linked === false);
  const miss = await PP.createProject({ name: 'مش في الكتالوج', eo: { id: 'eo-not-in-catalog', storeId: 'trendy-storeee', slug: 'x' } }); made.push(miss.id);
  const ctx2 = await SL.launchContext(miss.id, { deps: { listLaunchableProducts: async () => { throw new Error('EO down'); } } });
  ok('a product the catalogue does not have yet → found:false with a reason; a failing sync never breaks the context', ctx2.linked && ctx2.found === false && /كتالوج/.test(ctx2.reason));

  const LJ = 'smarttest-job-0001';
  await prisma.ambLaunchJob.create({ data: { job_id: LJ, ad_account_id: 'act_test', budget_mode: 'CBO', config_json: '{}', product_id: prod.id } });
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  await PP.mutateProject(lp.id, (p) => { p.images = [{ id: 'img_aaaaaaaa', status: 'READY' }, { id: 'img_bbbbbbbb', status: 'QUEUED' }, { id: 'img_cccccccc', status: 'READY' }]; });
  for (const k of ['img_aaaaaaaa', 'img_cccccccc']) await prisma.cfBlob.create({ data: { key: 'pp/' + lp.id + '/' + k, data: png, mime: 'image/png', bytes: png.length } });
  const vid = await PP.addVideoFile(lp.id, { buffer: Buffer.from('fake mp4 bytes'), seconds: 12, style: 'ugc', prompt: 'p' });
  await PP.addVideoLink(lp.id, { url: 'https://www.tiktok.com/@a/video/1' });
  const imgsAdded = [], vidsAdded = []; const progress = [];
  const fakeCtx = { progress: async (p, m) => { progress.push(p); } };
  const reg = await SL.runRegisterAssets({ projectId: lp.id, launchJobId: LJ, ctx: fakeCtx, deps: {
    addImage: async (a) => { if (a.filename.includes('cccccccc')) throw new Error('Meta رفضت الصورة'); imgsAdded.push(a); return { slotKey: 'I10' + imgsAdded.length }; },
    addVideo: async (a) => { vidsAdded.push({ ...a, exists: fs.existsSync(a.filePath), size: fs.statSync(a.filePath).size }); return { slotKey: 'C101' }; } } });
  ok('only READY images and stored AI videos are registered (a QUEUED image and a TikTok link are skipped)', reg.images.length === 1 && reg.videos.length === 1 && imgsAdded.length === 1 && vidsAdded.length === 1, JSON.stringify(reg));
  ok('the image bytes and the video file reach the pool (real bytes, a real temp file of the right size, duration carried)', imgsAdded[0].buffer.equals(png) && imgsAdded[0].mime === 'image/png' && vidsAdded[0].exists && vidsAdded[0].size === 'fake mp4 bytes'.length && vidsAdded[0].durationSeconds === 12);
  ok('one failing asset is reported, the others still go through', reg.failed.length === 1 && reg.failed[0].error === 'Meta رفضت الصورة' && reg.failed[0].kind === 'image');
  ok('the temp video file is removed afterwards', !fs.existsSync(vidsAdded[0].filePath));
  const after = await PP.getProject(lp.id);
  ok('the journey remembers the launch job and what was registered', after.smart.launch.jobId === LJ && after.smart.launch.assets.images === 1 && after.smart.launch.assets.videos === 1);
  let er = await rejects(SL.runRegisterAssets({ projectId: lp.id, launchJobId: 'no-such-job-0001', ctx: fakeCtx, deps: {} }));
  ok('an unknown launch job → NOT_FOUND (nothing uploaded)', er?.code === 'NOT_FOUND');
  er = await rejects(SL.runRegisterAssets({ projectId: unl.id, launchJobId: LJ, ctx: fakeCtx, deps: {} }));
  ok('a journey with nothing ready → NOTHING_READY', er?.code === 'NOTHING_READY');
  const lk = await SL.linkLaunch(lp.id, { jobId: LJ, status: 'COMPLETE' });
  ok('linkLaunch stores the job and its status (the step bar reads it); a malformed id is refused', lk.status === 'COMPLETE' && SC.stepStates(await PP.getProject(lp.id)).find((s) => s.key === 'campaign').state === 'done' && (await rejects(Promise.resolve().then(() => SL.linkLaunch(lp.id, { jobId: '../x' })))) !== null);
  await prisma.ambLaunchJob.delete({ where: { job_id: LJ } }).catch(() => {});
  await prisma.product.delete({ where: { id: prod.id } }).catch(() => {});

  console.log('\n5. «النشر على المتجر» (WRITES to the store: preview → hash → explicit confirm; PATCH only; text only)');
  const html = EP.buildDescriptionHtml({ title: 'عنوان <b>', subtitle: 'جملة', paragraphs: ['فقرة & أخرى'], features: ['ميزة 1', 'ميزة "2"'], steps: [{ title: 'ركّب', text: 'سهل' }] });
  ok('description HTML: escaped (no raw tags from the copy), paragraphs, a feature list and numbered steps, no images', html.includes('&lt;b&gt;') && html.includes('&amp;') && html.includes('<ul><li>✅ ميزة 1</li>') && html.includes('<ol><li><strong>ركّب</strong> — سهل</li></ol>') && !/<img|<script/i.test(html), html);
  ok('no copy → empty description', EP.buildDescriptionHtml(null) === '');
  const pj = { name: 'اسم', price: 399, oldPrice: 550, copy: { title: 'ع', paragraphs: ['ف'], features: [], steps: [] } };
  const u1 = EP.buildUpdate(pj, {});
  ok('default update = description only', Object.keys(u1.body).join() === 'description');
  const u2 = EP.buildUpdate(pj, { name: true, description: true, prices: true });
  ok('prices map onto Easy Orders meaning: price = before price (550), sale_price = selling price (399)', u2.body.price === 550 && u2.body.sale_price === 399 && u2.body.name === 'اسم');
  const u3 = EP.buildUpdate({ ...pj, oldPrice: null }, { prices: true, description: true });
  ok('no "before" price → prices are NOT touched, and the reason is given', !('price' in u3.body) && !('sale_price' in u3.body) && u3.notes.length === 1);
  ok('the hash changes with the body and is stable otherwise', EP.buildUpdate(pj, {}).hash === u1.hash && EP.buildUpdate({ ...pj, copy: { ...pj.copy, title: 'ع2' } }, {}).hash !== u1.hash);
  ok('nothing to update / no copy are refused with clear codes', (await rejects(Promise.resolve().then(() => EP.buildUpdate(pj, { description: false })))).code === 'NOTHING_TO_UPDATE' && (await rejects(Promise.resolve().then(() => EP.buildUpdate({ name: 'x' }, {})))).code === 'NO_COPY');

  const pubP = await PP.createProject({ name: 'منتج للنشر', price: 399, oldPrice: 550, facts: ['a'], eo: { id: 'eo-pub-1', storeId: 'trendy-storeee', slug: 's', name: 'منتج للنشر' } }); made.push(pubP.id);
  e = await rejects(EP.previewUpdate(pubP.id, { description: true }));
  ok('no copy yet → preview refused (NO_COPY)', e?.code === 'NO_COPY');
  await PP.updateProject(pubP.id, { copy: { title: 'عنوان', paragraphs: ['فقرة'], features: ['ميزة'] } });
  const pv = await EP.previewUpdate(pubP.id, { description: true, prices: true }, { deps: { getDetail: async () => ({ name: 'اسم قديم', description: 'وصف قديم', price: 300, oldPrice: 400 }) } });
  ok('preview shows what changes (before / after per field) and a hash — and writes NOTHING', pv.fields.some((f) => f.field === 'description' && f.before === 'وصف قديم' && /عنوان/.test(f.after)) && pv.fields.some((f) => f.field === 'sale_price' && f.before === '300' && f.after === '399') && pv.hash.length === 24 && !(await PP.getProject(pubP.id)).smart?.publish, JSON.stringify(pv.fields));
  let sent = null;
  const okUpdate = async (storeId, id, body) => { sent = { storeId, id, body }; return true; };
  e = await rejects(EP.applyUpdate(pubP.id, { description: true, prices: true }, { hash: pv.hash, confirm: undefined }, { deps: { update: okUpdate } }));
  ok('without an explicit confirm:true NOTHING is sent', e?.code === 'NOT_CONFIRMED' && sent === null);
  e = await rejects(EP.applyUpdate(pubP.id, { description: true, prices: true }, { hash: 'deadbeef', confirm: true }, { deps: { update: okUpdate } }));
  ok('a hash that is not the previewed one is refused (STALE_PREVIEW) — what is written is what was shown', e?.code === 'STALE_PREVIEW' && sent === null);
  const res2 = await EP.applyUpdate(pubP.id, { description: true, prices: true }, { hash: pv.hash, confirm: true }, { deps: { update: okUpdate } });
  ok('confirmed + matching hash → exactly the previewed body goes to the right store / product, and the journey records it', res2.ok && sent.storeId === 'trendy-storeee' && sent.id === 'eo-pub-1' && Object.keys(sent.body).sort().join() === 'description,price,sale_price' && (await PP.getProject(pubP.id)).smart.publish.fields.length === 3);
  const recorded = (await PP.getProject(pubP.id)).smart.publish.at;
  e = await rejects(EP.applyUpdate(pubP.id, { description: true, prices: true }, { hash: pv.hash, confirm: true }, { deps: { update: async () => { throw new Error('المفتاح ملوش صلاحية كتابة'); } } }));
  ok('a store that refuses the write → EO_REJECTED with its reason, and the earlier record is untouched', e?.code === 'EO_REJECTED' && /صلاحية/.test(e.message) && (await PP.getProject(pubP.id)).smart.publish.at === recorded);
  const unl2 = await PP.createProject({ name: 'غير مربوط للنشر' }); made.push(unl2.id);
  ok('an unlinked page cannot be published', (await rejects(EP.previewUpdate(unl2.id, {})))?.code === 'NOT_LINKED');
  const EOP = await imp('../services/amb/easyOrdersProducts.js');
  const e1 = await rejects(EOP.updateEasyOrdersProduct('no-such-store', 'abcdef12-3456', { name: 'x' }));
  const e2 = await rejects(EOP.updateEasyOrdersProduct('default', '../x', { name: 'x' }));
  ok('the real writer refuses a store without a key, and a malformed product id (no request is made)', /مفتاح/.test(e1?.message || '') && (/غير صالح/.test(e2?.message || '') || /مفتاح/.test(e2?.message || '')), (e1?.message || '') + ' | ' + (e2?.message || ''));

  console.log('\n6. journey settings, supplier link / unit cost, list extras, page settings');
  const ms = PP.mergeSmart({ research: { a: 1 } }, { selectedCaption: 9, imageCount: 0, pageSettings: { buyFromPage: true, skipCart: 'yes', buyText: 'x'.repeat(100) }, research: 'HACK' });
  ok('mergeSmart: only the known keys are taken (clamped caption 0-3, image count 1-5), strict booleans, capped text, and the research block cannot be overwritten from the client', ms.selectedCaption === 3 && ms.imageCount === 1 && ms.pageSettings.buyFromPage === true && ms.pageSettings.skipCart === false && ms.pageSettings.buyText.length === 40 && ms.research.a === 1);
  const sp = await PP.createProject({ name: 'منتج الإعدادات', facts: ['a'], eo: { id: 'eo-set-1', storeId: 'trendy-storeee', slug: 's' } }); made.push(sp.id);
  await PP.updateProject(sp.id, { supplierUrl: 'https://www.aliexpress.com/item/1.html', unitCost: 120, smart: { selectedCaption: 1, imageCount: 3, pageSettings: { freeShipping: true, fixedBuy: true } } });
  const sp2 = await PP.getProject(sp.id);
  ok('supplier link (https only), unit cost and the journey settings are saved', sp2.supplierUrl.startsWith('https://') && sp2.unitCost === 120 && sp2.smart.selectedCaption === 1 && sp2.smart.imageCount === 3 && sp2.smart.pageSettings.freeShipping === true);
  await PP.updateProject(sp.id, { smart: { landingUrl: 'https://trendy.shop/products/x' } });
  ok('the landing page link (https only) is kept on the journey; a non-https one is dropped', (await PP.getProject(sp.id)).smart.landingUrl === 'https://trendy.shop/products/x' && PP.mergeSmart({}, { landingUrl: 'http://x.com' }).landingUrl === '');
  await PP.updateProject(sp.id, { supplierUrl: 'javascript:alert(1)' });
  ok('a non-http supplier link is dropped', (await PP.getProject(sp.id)).supplierUrl === '');
  const lst = (await PP.listProjects()).find((x) => x.id === sp.id);
  ok('the project list carries what the picker needs (reference photo?, linked?, store, published?)', lst.hasRef === false && lst.eo === true && lst.storeId === 'trendy-storeee' && lst.published === false);
  await PP.updateProject(sp.id, { copy: { title: 'ع', paragraphs: ['ف'], features: [] } });
  const pvs = await EP.previewUpdate(sp.id, { description: false, settings: true }, { deps: { getDetail: async () => null } });
  ok('page settings can be previewed as a store update: Easy Orders field names, booleans, and the buy-button text', pvs.fields.some((x) => x.field === 'is_free_shipping' && x.after === 'true') && pvs.fields.some((x) => x.field === 'is_fixed_bottom_buy') && pvs.fields.some((x) => x.field === 'buy_now_text'), JSON.stringify(pvs.fields.map((x) => x.field)));
  const nos = EP.buildUpdate({ name: 'x', copy: { title: 't' } }, { settings: true, description: true });
  ok('no saved page settings → they are skipped with a reason, the rest still goes', !('is_free_shipping' in nos.body) && nos.notes.some((n) => /إعدادات الصفحة/.test(n)));
} finally {
  for (const id of made) { await prisma.cfBlob.deleteMany({ where: { key: { startsWith: `pp/${id}/` } } }).catch(() => {}); await prisma.settings.deleteMany({ where: { id: `pp:${id}` } }).catch(() => {}); }
  await prisma.$disconnect();
}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
