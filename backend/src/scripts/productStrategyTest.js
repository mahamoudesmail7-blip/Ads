// 🧪 AI Product Targeting & Creative Strategy — the pure rules (confirmed vs inferred, forbidden claims, invented prices / discounts / shipping, post structure, interest matching) and the engine
// (photos upload + validation, analysis, targeting + Meta verification, 5 posts + retry, edit / regenerate / revert / approve, persistence) with fakes for the AI, Meta and Easy Orders.
//   node src/scripts/productStrategyTest.js      (no database, no network, no AI key needed)
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
const { prisma } = await imp('../prisma.js');
const mem = new Map(); const blobs = new Map(); const products = new Map();
Object.defineProperty(prisma, 'settings', { configurable: true, value: { findUnique: async ({ where }) => (mem.has(where.id) ? { id: where.id, data: mem.get(where.id) } : null), upsert: async ({ where, create, update }) => { mem.set(where.id, mem.has(where.id) ? update.data : create.data); return {}; } } });
Object.defineProperty(prisma, 'cfBlob', { configurable: true, value: { findUnique: async ({ where }) => (blobs.has(where.key) ? { key: where.key, ...blobs.get(where.key) } : null), upsert: async ({ where, create, update }) => { blobs.set(where.key, blobs.has(where.key) ? update : create); return {}; }, deleteMany: async ({ where }) => { blobs.delete(where.key); return {}; } } });
Object.defineProperty(prisma, 'product', { configurable: true, value: { findUnique: async ({ where }) => products.get(where.id) || null } });
const SC = await imp('../services/amb/productStrategy/schema.js'); const PS = await imp('../services/amb/productStrategy/engine.js'); const MI = await imp('../services/amb/productStrategy/metaInterests.js');
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

console.log('\n1. analysis: confirmed vs inferred vs needs-verification');
{
  const a = SC.sanitizeAnalysis({ productName: 'جهاز مساج', category: 'عناية', summary: 's',
    confirmed: { specs: [{ text: 'بكرات دوّارة', source: 'IMAGE_1' }, { text: 'يعمل بالبطارية', source: '' }, { text: 'مقبض مريح', source: 'IMAGE_9' }, { text: 'خامة بلاستيك ABS', source: 'STORE_DATA' }, { text: 'يعالج الألم نهائيًا', source: 'IMAGE_1' }], usage: [{ text: 'تدليك الفخذين', source: 'IMAGE_2' }] },
    inferred: { benefits: ['راحة بعد يوم طويل', 'هتخف من السليوليت مضمون'], problemsSolved: ['تعب الوقفة'], potentialBuyers: ['سيدات'], strengths: ['سهل'], weaknesses: ['مش كهربائي'], objections: ['هل بيوجع؟'] },
    needsVerification: [{ text: 'عمر البطارية', why: 'مش ظاهر' }] }, { imageCount: 3, storeFeatures: ['تصميم عملي'] });
  ok('an item with a real source (photo / store data) stays CONFIRMED', a.confirmed.specs.map((x) => x.text).join() === 'بكرات دوّارة,خامة بلاستيك ABS' && a.confirmed.usage.length === 1);
  ok('an item with NO source or an impossible source (IMAGE_9) is demoted to «needs verification», never shown as a fact', a.needsVerification.some((x) => x.text === 'يعمل بالبطارية') && a.needsVerification.some((x) => x.text === 'مقبض مريح'));
  ok('medical / guaranteed claims never survive — even in the «confirmed» or «inferred» lists', !JSON.stringify(a.confirmed).includes('يعالج') && !a.inferred.benefits.some((b) => /مضمون/.test(b)) && a.needsVerification.some((x) => /ادعاء/.test(x.why)));
  ok('inferences stay inferences (separate lists) and the model’s own verification list is kept', a.inferred.problemsSolved.length === 1 && a.needsVerification.some((x) => x.text === 'عمر البطارية'));
  ok('store features are carried as STORE_DATA; «enough» is true when something is confirmed', a.storeFeatures[0] === 'تصميم عملي' && a.enough === true);
  ok('nothing confirmed + no store features → NOT enough (the screen says so, no fake analysis)', SC.sanitizeAnalysis({ confirmed: { specs: [{ text: 'x', source: '' }] } }, { imageCount: 3 }).enough === false);
  ok('a source from a photo that was not uploaded is invalid (only 1 photo → IMAGE_2 is not a source)', SC.sanitizeAnalysis({ confirmed: { specs: [{ text: 'a', source: 'IMAGE_2' }] } }, { imageCount: 1 }).confirmed.specs.length === 0);
}

console.log('\n2. targeting: 5 strategies, bounds, interests, Meta verification');
{
  const raw = { strategies: [
    { key: 'PRIMARY', segmentName: 'سيدات 25-45', gender: 'سيدات', ageMin: 45, ageMax: 25, locations: { regions: ['القاهرة', 'مدينة وهمية'] }, interests: [{ name: 'Massage', why: 'x' }, { name: 'تدليك', why: 'عربي' }, { name: 'Islam', why: 'sensitive' }, { name: 'Self-care', why: '' }], reason: 'r', motive: 'm', angle: 'a', creativeType: 'c', confidence: { level: 'HIGH', why: 'sure' } },
    { key: 'PROBLEM', segmentName: 'تعبانين', gender: 'ALL', ageMin: 10, ageMax: 99 }, { key: 'DETAILED', segmentName: 'd' }, { key: 'BROAD', segmentName: 'b', interests: ['A', 'B', 'C', 'D', 'E'] }, { key: 'ADVANTAGE_PLUS', segmentName: 'ap' }] };
  const t = SC.sanitizeTargeting(raw);
  ok('exactly 5 strategies in the fixed order with Arabic labels', t.strategies.map((s) => s.key).join() === 'PRIMARY,PROBLEM,DETAILED,BROAD,ADVANTAGE_PLUS' && t.ok);
  const p = t.strategies[0];
  ok('age is bounded 18–65 and ordered; gender normalised; unknown governorates dropped', p.ageMin === 25 && p.ageMax === 45 && p.gender === 'FEMALE' && p.locations.regions.join() === 'القاهرة' && t.strategies[1].ageMin === 18 && t.strategies[1].ageMax === 65);
  ok('interests are plain English names only (Arabic and sensitive ones are dropped)', p.interests.map((i) => i.name).join() === 'Massage,Self-care');
  ok('confidence can NEVER be «high» for an untested audience (capped at medium, defaults to low)', p.confidence.level === 'LOW' && t.strategies.every((s) => ['LOW', 'MEDIUM'].includes(s.confidence.level)));
  ok('Broad keeps at most 3 interests (suggestions only)', t.strategies[3].interests.length === 3);
  ok('matchInterest: exact name → VERIFIED with Meta’s id / audience size', SC.matchInterest('Massage', [{ id: '6003', name: 'Massage', audience_size_lower_bound: 1000, audience_size_upper_bound: 5000, path: ['Interests', 'Massage'] }]).status === 'VERIFIED');
  const sim = SC.matchInterest('Body massage tools', [{ id: '1', name: 'Massage tools' }, { id: '2', name: 'Spa' }]); ok('no exact name but close → SIMILAR with real alternatives from Meta', sim.status === 'SIMILAR' && sim.alternatives[0].name === 'Massage tools');
  ok('nothing close → UNVERIFIED (still a suggestion that needs review); no results → NOT_FOUND', SC.matchInterest('Zzzz', [{ id: '1', name: 'Cars' }]).status === 'UNVERIFIED' && SC.matchInterest('Zzzz', []).status === 'NOT_FOUND');
  // verifyInterests with fakes
  const calls = []; const store = new Map();
  const deps = { getToken: async () => 'tok', search: async (_t, q) => { calls.push(q); return q === 'Massage' ? [{ id: '6003', name: 'Massage' }] : []; }, cache: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); } } };
  const v1 = await MI.verifyInterests(['Massage', 'Ghost interest', 'Massage'], deps);
  ok('Meta search: verified when found, NOT_FOUND otherwise, duplicates asked once', v1.results.get('Massage').status === 'VERIFIED' && v1.results.get('Ghost interest').status === 'NOT_FOUND' && calls.length === 2 && v1.available);
  await MI.verifyInterests(['Massage'], deps); ok('the second time comes from the cache (Meta is not asked again)', calls.length === 2);
  const v2 = await MI.verifyInterests(['Massage'], { ...deps, getToken: async () => { throw new Error('مفيش حساب Meta Ads متصل دلوقتي.'); } });
  ok('Meta not connected → UNAVAILABLE for every interest — never «verified»', v2.results.get('Massage').status === 'UNAVAILABLE' && v2.available === false);
  const v3 = await MI.verifyInterests(['Massage'], { ...deps, cache: { get: async () => null, set: async () => {} }, search: async () => { throw new Error('rate limit'); } });
  ok('a Meta error → UNAVAILABLE with the reason, never invented', v3.results.get('Massage').status === 'UNAVAILABLE' && /rate limit/.test(v3.results.get('Massage').reason));
}

console.log('\n3. posts: format audit, invented prices / discounts / shipping, claims, hooks');
{
  const LINK = 'https://www.trendy-egy.com/products/Massage-Roller';
  const good = `💗 ليه تدفعي كل مرة في جلسة مساج.. وإنتِ ممكن تعمليها بنفسك؟ 😍\nبعد يوم طويل من الوقفة، جسمك محتاج شوية اهتمام وراحة! 💆‍♀️\nمع جهاز المساج الدوّار خلي روتينك أسهل. ✨\n${LINK}\n\n🔥 جهاز واحد.. واستخدامات كتير!\n✅ بكرات متعددة لتدليك الجسم.\n✅ تصميم عملي للاستخدام المنزلي.\n✅ مناسب لتدليك مناطق مختلفة بلطف.\n✅ من غير كهرباء أو شحن.\n\n💖 خلي المساج خطوة بسيطة ضمن روتينك وإنتِ مرتاحة في بيتك وده بيفرق في يومك فعلًا بعد التعب.\n\n🔥 اطلبي جهاز المساج دلوقتي وشوفي التفاصيل! 🛍️\n${LINK}`;
  const base = { type: 'PROBLEM_SOLUTION', text: good, headline: 'مساج في البيت بسهولة' };
  const ctx = { link: LINK, price: 349, oldPrice: null, discountPercent: null, confirmed: { discount: false, shipping: false, payment: false }, productName: 'جهاز المساج الدوّار' };
  ok('a well-formed post passes with no BLOCK finding', SC.auditPost(base, ctx).filter((w) => w.level === 'BLOCK').length === 0, JSON.stringify(SC.auditPost(base, ctx)));
  const blocks = (t, c = ctx, extra = {}) => SC.auditPost({ ...base, text: t, ...extra }, c).filter((w) => w.level === 'BLOCK').map((w) => w.code);
  ok('an invented PRICE is blocked (only the product’s real price / old price are allowed)', blocks(good + '\nالسعر 199 جنيه بس!').includes('PRICE') && !blocks(good + '\nالسعر 349 جنيه').includes('PRICE'));
  ok('an invented DISCOUNT (%, «خصم», «قبل وبعد») is blocked when the data has none', blocks(good + '\nخصم 30% النهارده').includes('DISCOUNT') && blocks(good + '\nعرض خاص لفترة محدودة').includes('DISCOUNT_WORD'));
  const withDisc = { ...ctx, price: 299, oldPrice: 399, discountPercent: 25, confirmed: { discount: true, shipping: false, payment: false } };
  ok('a REAL, confirmed discount is allowed — and only with its real percentage', !blocks(good + '\nخصم 25%', withDisc).includes('DISCOUNT') && blocks(good + '\nخصم 60%', withDisc).includes('DISCOUNT'));
  ok('shipping and payment lines are blocked unless confirmed; allowed once confirmed', blocks(good + '\n🚚 توصيل لحد باب البيت').includes('SHIPPING') && blocks(good + '\n💰 الدفع عند الاستلام').includes('PAYMENT') && !blocks(good + '\n🚚 توصيل لحد باب البيت\n💰 الدفع عند الاستلام', { ...ctx, confirmed: { ...ctx.confirmed, shipping: true, payment: true } }).length);
  ok('medical / guaranteed claims are blocked (cure, guaranteed result, guaranteed CPM / CTR)', blocks(good + '\nبيعالج آلام الظهر').includes('CLAIM') && blocks(good + '\nنتيجة مضمونة').includes('CLAIM') && blocks(good + '\nهيقلل ال CPM').includes('CLAIM'));
  ok('the link must appear twice; one occurrence / no link are warnings', SC.auditPost({ ...base, text: good.replace(/\n🔥 اطلبي[\s\S]*$/, '\n🔥 اطلبي دلوقتي') }, ctx).some((w) => w.code === 'LINK') && SC.auditPost(base, { ...ctx, link: null }).some((w) => w.code === 'LINK_MISSING'));
  ok('structure warnings: 4–7 features, CTA, paragraphs, long headline', SC.auditPost({ ...base, text: '🔥 مساج\n✅ واحد\n✅ اتنين\nاشتري' }, ctx).some((w) => w.code === 'FEATURES') && SC.auditPost({ ...base, headline: 'x'.repeat(60) }, ctx).some((w) => w.code === 'HEADLINE_LEN'));
  ok('type rules: «ودّع» must open the GOODBYE post; Problem/Solution must open with a question', SC.auditPost({ ...base, type: 'GOODBYE' }, ctx).some((w) => w.code === 'RULE') && !SC.auditPost({ ...base, type: 'GOODBYE', text: good.replace(/^[^\n]+/, '🎯 ودّعي تعب الوقفة اليومي! 💆‍♀️') }, ctx).some((w) => w.code === 'RULE') && SC.auditPost({ ...base, text: good.replace(/^[^\n]+/, '💗 مساج في البيت') }, ctx).some((w) => w.code === 'RULE'));
  const p1 = { text: good, type: 'GOODBYE' }; const p2 = { text: good.replace(/^[^\n]+/, '💗 سؤال تاني خالص عن حاجة مختلفة؟'), type: 'HOOK_CPM' };
  ok('the same post with only a new first line is detected as «not different»', SC.similarHooks([p1, p2]).length === 1);
  ok('fillLink writes the REAL link, or a visible «add the link» marker when none is known', SC.fillLink('a {{LINK}} b {{LINK}}', LINK) === `a ${LINK} b ${LINK}` && SC.fillLink('{{LINK}}', null).includes('ضيف رابط المنتج'));
  const cr = SC.sanitizeCreative({ imageIdea: 'i', videoIdea: 'v', imagePrompt: 'A hand holding the roller', videoPrompt: 'Slow pan of the roller' });
  ok('creative prompts ALWAYS carry the fidelity clause (3 reference photos, no extra accessories) and the right format (1:1 / 9:16)', /three attached reference photos/.test(cr.imagePrompt) && /Do not add accessories/.test(cr.imagePrompt) && /1000x1000/.test(cr.imagePrompt) && /9:16/.test(cr.videoPrompt) && /Do not add accessories/.test(cr.videoPrompt));
  const c = SC.buildCommercial({ price: 299, oldPrice: 399, freeShipping: true, confirmedByOwner: {} });
  ok('commercial facts: a real discount comes only from store data (25%); shipping only from a free-shipping flag; payment never assumed', c.discountPercent === 25 && c.confirmed.discount && c.confirmed.shipping && !c.confirmed.payment && SC.buildCommercial({ price: 299, oldPrice: null }).confirmed.discount === false);
  ok('the owner can confirm payment (and un-confirm something), nothing else changes', SC.buildCommercial({ price: 1, confirmedByOwner: { payment: true, discount: false } }).confirmed.payment === true);
}

console.log('\n4. engine: upload validation');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 2)]);
const url = (b, mime) => `data:${mime};base64,${b.toString('base64')}`;
products.set(7, { id: 7, product_name: 'جهاز المساج الدوّار', category: 'عناية', selling_price: 349, store_id: 'trendy', easy_orders_uuid: 'abc-123' });
const eo = { name: 'جهاز المساج الدوّار 360°', slug: 'Massage-Roller', price: 349, oldPrice: null, freeShipping: false, categories: ['عناية'], facts: ['بكرات متعددة', 'تصميم عملي للاستخدام المنزلي'] };
const baseDeps = { getEoDetail: async () => eo, getStore: () => ({ id: 'trendy', domain: 'www.trendy-egy.com' }), campaigns: async () => [1, 2] };
{
  const e1 = await rejects(() => PS.putImage(7, 1, url(Buffer.from('hello'), 'text/plain')));
  ok('a non-image type is refused with a clear message', e1?.status === 415 && /JPG|PNG|WEBP/.test(e1.message));
  const e2 = await rejects(() => PS.putImage(7, 1, url(Buffer.from('not really a png at all, sorry'), 'image/png')));
  ok('a file that only CLAIMS to be an image (bad content) is refused', e2?.status === 415 && /مش صورة حقيقية/.test(e2.message));
  const e3 = await rejects(() => PS.putImage(7, 1, url(Buffer.concat([PNG, Buffer.alloc(SC.MAX_IMAGE_BYTES)]), 'image/png')));
  ok('an oversized image is refused', e3?.status === 413);
  ok('slot must be 1, 2 or 3', (await rejects(() => PS.putImage(7, 4, url(PNG, 'image/png'))))?.status === 400);
  await PS.putImage(7, 1, url(PNG, 'image/png')); const s2 = await PS.putImage(7, 2, url(JPG, 'image/jpeg'));
  ok('valid images are stored (the real type is detected from the bytes) and listed', s2.images[1].mime === 'image/png' && s2.images[2].mime === 'image/jpeg' && (await PS.getImageBlob(7, 1)).data.length === PNG.length);
}

console.log('\n5. engine: analysis → targeting → 5 posts (fake AI / Meta)');
const goodPost = (type, hookLine, extra = '') => ({ type, headline: `Headline ${type}`.slice(0, 30), angle: `زاوية ${type}`, audience: 'سيدات', offerMode: 'VALUE', creative: { imageIdea: 'i', videoIdea: 'v', visualHook: 'h', audienceFit: 'a', imagePrompt: 'p1', videoPrompt: 'p2' },
  text: `${hookLine}\nمقدمة مختلفة تمامًا لنوع ${type} بتشرح الاحتياج اليومي والتعب بعد يوم طويل من الشغل والوقفة.\nجهاز المساج الدوّار 360° بيخلي الروتين أسهل. ✨\n{{LINK}}\n\n🔥 مميزات ${type}\n✅ بكرات متعددة لتدليك الجسم.\n✅ تصميم عملي للاستخدام المنزلي.\n✅ ميزة تالتة خاصة بـ${type}.\n✅ ميزة رابعة خاصة بـ${type}.\n\n💖 فقرة سبب الشراء الخاصة بنوع ${type} وفيها فايدة عملية للمستخدم في البيت من غير تعقيد.\n${extra}\n\n🔥 اطلبي جهاز المساج دلوقتي وشوفي التفاصيل! 🛍️\n{{LINK}}` });
const HOOKS = { GOODBYE: '🎯 ودّعي تعب الوقفة اليومي! 💆‍♀️', PROBLEM_SOLUTION: '💗 ليه تدفعي كل مرة في جلسة مساج؟ 😍', HOOK_CPM: '🔥 اللي محدش قاله عن راحة آخر اليوم!', OFFER_CTR: '✨ مميزات جهاز المساج الدوّار في سطور', CURIOSITY_LP: '👀 سر الجهاز اللي بيتكلم عنه الكل' };
let aiCalls = 0; let aiMode = 'ok';
const analysisJson = { productName: 'جهاز المساج الدوّار', category: 'عناية', summary: 'جهاز مساج يدوي بكرات', confirmed: { specs: [{ text: 'بكرات متعددة', source: 'IMAGE_1' }, { text: 'مقبض يدوي', source: 'IMAGE_2' }], usage: [{ text: 'تدليك الفخذين', source: 'IMAGE_2' }] }, inferred: { benefits: ['راحة'], problemsSolved: ['تعب الوقفة'], potentialBuyers: ['سيدات'], strengths: ['سهل'], weaknesses: ['يدوي'], objections: ['هل بيوجع؟'] }, needsVerification: [{ text: 'الخامة', why: 'مش ظاهرة' }], imageNotes: [{ slot: 1, notes: 'ظاهر الجهاز' }] };
const targetingJson = { strategies: ['PRIMARY', 'PROBLEM', 'DETAILED', 'BROAD', 'ADVANTAGE_PLUS'].map((k) => ({ key: k, segmentName: `شريحة ${k}`, gender: 'FEMALE', ageMin: 25, ageMax: 45, locations: { regions: [] }, interests: k === 'BROAD' ? [] : [{ name: 'Massage', why: 'x' }, { name: 'Invented Interest Zed', why: 'y' }], reason: 'r', motive: 'm', angle: `زاوية ${k}`, creativeType: 'فيديو', confidence: { level: 'MEDIUM', why: 'w' } })) };
let lastUserText = '';
const generate = async (a) => { aiCalls++; lastUserText = JSON.stringify(a.messages).slice(0, 5000); if (aiMode === 'fail') throw Object.assign(new Error('boom'), { errorType: 'X' }); if (a.feature.endsWith('analysis')) return { text: JSON.stringify(analysisJson), cached: false, model: 'm' };
  if (a.feature.endsWith('targeting')) return { text: JSON.stringify(targetingJson), cached: false, model: 'm' };
  const wanted = (/الأنواع المطلوبة بالترتيب: ([A-Z_،\s]+)/.exec(a.messages[0].content) || [])[1]?.split('،').map((x) => x.trim()) || Object.keys(HOOKS);
  return { text: JSON.stringify({ posts: wanted.map((t) => goodPost(t, HOOKS[t], aiMode === 'badprice' && t === 'OFFER_CTR' && !/ملاحظات لازم تتصلّح/.test(a.messages[0].content) ? '💰 السعر 99 جنيه بس وخصم 50%!' : '')) }), cached: false, model: 'm' }; };
const metaDeps = { getToken: async () => 'tok', search: async (_t, q) => (q === 'Massage' ? [{ id: '6003', name: 'Massage', audience_size_lower_bound: 10, audience_size_upper_bound: 20 }] : []), cache: { get: async () => null, set: async () => {} } };
const deps = { ...baseDeps, ai: true, generate, meta: metaDeps };
{
  ok('no AI key → a clear message, not a crash', (await rejects(() => PS.analyze(7, { deps: { ...baseDeps, ai: false } })))?.status === 503);
  ok('no photo → a clear message', (await rejects(() => PS.analyze(8, { deps: { ...baseDeps, ai: true, generate }, }).catch((e) => { throw e; })))?.message.length > 5);
  const st = await PS.analyze(7, { deps });
  ok('the analysis is saved INSIDE the product (survives a reload) with its source separation', st.analysis.confirmed.specs.length === 2 && st.analysis.needsVerification.length === 1 && st.analysis.imageSlots.join() === '1,2' && !st.analysis.insufficient);
  ok('both photos reach the vision call TOGETHER (one request, two images)', true && lastUserText.includes('IMAGE_1') && lastUserText.includes('IMAGE_2'));
  aiMode = 'fail'; ok('an AI failure becomes a clear Arabic message', (await rejects(() => PS.analyze(7, { deps, force: true })))?.status === 502); aiMode = 'ok';
  const t = await PS.buildTargeting(7, { deps });
  ok('5 strategies saved; interests carry Meta status: Massage VERIFIED, the invented one «needs review» (NOT_FOUND)', t.targeting.strategies.length === 5 && t.targeting.strategies[0].interests[0].meta.status === 'VERIFIED' && t.targeting.strategies[0].interests[1].meta.status === 'NOT_FOUND' && t.targeting.verification.counts.VERIFIED === 4);
  const posts = await PS.generatePosts(7, { deps });
  ok('5 posts, one per required type, each with its own headline and creative ideas', Object.keys(posts.posts.items).join() === 'GOODBYE,PROBLEM_SOLUTION,HOOK_CPM,OFFER_CTR,CURIOSITY_LP' && Object.values(posts.posts.items).every((p) => p.headline && p.creative.imagePrompt.includes('reference photos') && p.creative.videoPrompt.includes('9:16')));
  const v = await PS.getView(7, deps);
  ok('the real product link (from the store domain + slug) is in every post, twice', v.commercial.link === 'https://www.trendy-egy.com/products/Massage-Roller' && v.posts.every((p) => p.text.split(v.commercial.link).length - 1 === 2));
  ok('the view carries product data (name, price, link, features, linked campaigns) and no AI-blocking findings', v.context.name === 'جهاز المساج الدوّار 360°' && v.context.price === 349 && v.context.features.length === 2 && v.context.linkedCampaigns === 2 && v.posts.every((p) => !p.blocked), JSON.stringify(v.posts.map((p) => p.audits.filter((a) => a.level === 'BLOCK'))));
  // invented price → automatic single retry
  aiMode = 'badprice'; const before = aiCalls; const retried = await PS.generatePosts(7, { deps, force: true });
  ok('a post with an invented price/discount is automatically rewritten ONCE; the final post has no price/discount', aiCalls - before === 2 && !/99 جنيه|50%/.test(retried.posts.items.OFFER_CTR.text)); aiMode = 'ok';
}

console.log('\n6. engine: edit, approve, regenerate, revert');
{
  const ed = await PS.savePost(7, 'GOODBYE', { text: `${HOOKS.GOODBYE}\n${'نص معدّل طويل بما يكفي لنعدّي الحد الأدنى للبوست. '.repeat(3)}` });
  ok('editing a post marks it EDITED and keeps it', ed.posts.items.GOODBYE.status === 'EDITED' && /نص معدّل/.test(ed.posts.items.GOODBYE.text));
  ok('a too-short post is refused', (await rejects(() => PS.savePost(7, 'GOODBYE', { text: 'قصير' })))?.status === 400);
  const bad = await PS.savePost(7, 'HOOK_CPM', { text: (await PS.getView(7, deps)).posts.find((p) => p.type === 'HOOK_CPM').text + '\nخصم 70% النهارده' });
  ok('a post that contains a BLOCK finding can be edited but NOT approved', bad.posts.items.HOOK_CPM.status === 'EDITED' && (await rejects(() => PS.savePost(7, 'HOOK_CPM', { status: 'APPROVED' })))?.status === 422);
  const apr = await PS.savePost(7, 'PROBLEM_SOLUTION', { status: 'APPROVED' }); ok('a clean post can be approved', apr.posts.items.PROBLEM_SOLUTION.status === 'APPROVED');
  const hd = await PS.savePost(7, 'PROBLEM_SOLUTION', { headline: 'هيدلاين جديد' }); ok('editing the headline alone works and resets approval to «edited»', hd.posts.items.PROBLEM_SOLUTION.headline === 'هيدلاين جديد' && hd.posts.items.PROBLEM_SOLUTION.status === 'EDITED');
  const reg = await PS.regeneratePost(7, 'GOODBYE', { instruction: 'اقصر شوية', deps });
  ok('regenerating ONE post replaces only that post, keeps the previous version, and carries the user’s instruction', reg.posts.items.GOODBYE.versions.length === 1 && reg.posts.items.GOODBYE.status === 'DRAFT' && /اقصر شوية/.test(lastUserText) && reg.posts.items.CURIOSITY_LP.status === 'DRAFT' && !/نص معدّل/.test(reg.posts.items.GOODBYE.text));
  const rev = await PS.revertPost(7, 'GOODBYE'); ok('«الرجوع للنسخة السابقة» restores the edited text', /نص معدّل/.test(rev.posts.items.GOODBYE.text) && rev.posts.items.GOODBYE.versions.length === 0);
  ok('regenerating an unknown type is refused', (await rejects(() => PS.regeneratePost(7, 'NOPE', { deps })))?.status === 400);
}

console.log('\n7. product data link: manual link, confirmed facts, re-audit');
{
  const s1 = await PS.saveCommercial(7, { link: 'https://shop.example.com/p/x' }); const v1 = await PS.getView(7, deps);
  ok('a manual link overrides the store link and is re-checked in every post', s1.commercial.link.value === 'https://shop.example.com/p/x' && v1.commercial.linkSource === 'MANUAL' && v1.posts.every((p) => p.audits.some((a) => a.code === 'LINK')));
  ok('a bad link is refused', (await rejects(() => PS.saveCommercial(7, { link: 'javascript:alert(1)' })))?.status === 400 && (await rejects(() => PS.saveCommercial(7, { link: 'not a link' })))?.status === 400);
  await PS.saveCommercial(7, { link: '' }); await PS.saveCommercial(7, { confirmed: { payment: true, shipping: true } });
  const withShip = await PS.savePost(7, 'CURIOSITY_LP', { text: (await PS.getView(7, deps)).posts.find((p) => p.type === 'CURIOSITY_LP').text + '\n🚚 توصيل لحد باب البيت\n💰 الدفع عند الاستلام' });
  ok('once the owner confirms shipping + payment, those lines are allowed (and the post can be approved)', (await PS.getView(7, deps)).posts.find((p) => p.type === 'CURIOSITY_LP').audits.filter((a) => a.level === 'BLOCK').length === 0 && withShip.posts.items.CURIOSITY_LP.status === 'EDITED');
  await PS.saveCommercial(7, { confirmed: { payment: false } });
  ok('un-confirming payment makes the same line a BLOCK again (the facts are checked live, not frozen)', (await PS.getView(7, deps)).posts.find((p) => p.type === 'CURIOSITY_LP').audits.some((a) => a.code === 'PAYMENT'));
  const noLink = await PS.getView(7, { ...deps, getStore: () => ({ id: 'trendy', domain: null }) }); ok('no store domain and no manual link → the view says why instead of inventing a link', noLink.context.storeUrlMissingReason && /دومين/.test(noLink.context.storeUrlMissingReason));
}

console.log('\n8. insufficient data + real buyer audience + removal');
{
  products.set(9, { id: 9, product_name: 'منتج غامض', category: null, selling_price: 0, store_id: null, easy_orders_uuid: null });
  await PS.putImage(9, 1, url(PNG, 'image/png'));
  const weak = { ...analysisJson, confirmed: { specs: [], usage: [] }, needsVerification: [{ text: 'كل حاجة', why: 'الصورة مش واضحة' }] };
  const st = await PS.analyze(9, { deps: { ...baseDeps, getEoDetail: async () => { throw new Error('x'); }, ai: true, generate: async () => ({ text: JSON.stringify(weak), cached: false }) } });
  ok('not enough data → the analysis is flagged INSUFFICIENT (nothing invented)', st.analysis.insufficient === true && st.analysis.confirmed.specs.length === 0);
  ok('…and targeting / posts are refused with a clear message', (await rejects(() => PS.buildTargeting(9, { deps })))?.status === 422 && (await rejects(() => PS.generatePosts(9, { deps })))?.status === 422);
  const ra = await PS.realAudience(7, { findProduct: async () => ({ id: 7, store_id: 'trendy' }), settings: async () => ({}), segment: async () => ({ window: { from: 'a', to: 'b' }, metaAvailable: true, gender: { table: [{ segment: 'سيدات', purchases: 30 }], best: { segment: 'سيدات' }, topObserved: null }, age: { table: [], best: null, topObserved: null }, governorates: { table: [{ segment: 'القاهرة', orders: 50, deliveryRate: 0.8 }], best: { segment: 'القاهرة' }, topObserved: null }, audienceSignal: { label: 'سيدات / القاهرة' } }) });
  ok('Real Buyer Audience comes from the existing segment intelligence (real Meta + Easy Orders), with an honest note', ra.gender[0].segment === 'سيدات' && ra.governorates[0].orders === 50 && /مفيش اختراع/.test(ra.note));
  const gone = await PS.removeImage(7, 1); ok('removing a photo works and marks the analysis stale (re-analyse suggested)', !gone.images[1] && gone.analysis.stale === true);
}

console.log('\n9. «منتج جديد» — a product that does not exist in the system');
{
  const deps = { ai: true, getStore: () => null, campaigns: async () => [], generate: async (a) => ({ text: JSON.stringify(a.feature.endsWith('analysis') ? analysisJson : a.feature.endsWith('targeting') ? targetingJson : { posts: [] }), cached: false }), meta: { getToken: async () => { throw new Error('x'); } } };
  ok('a name is required (and bounded); a bad price is refused', (await rejects(() => PS.createDraft({ name: ' ' })))?.status === 400 && (await rejects(() => PS.createDraft({ name: 'x'.repeat(121) })))?.status === 400 && (await rejects(() => PS.createDraft({ name: 'جهاز', price: -5 })))?.status === 400 && (await rejects(() => PS.createDraft({ name: 'جهاز', price: 'abc' })))?.status === 400);
  const d1 = await PS.createDraft({ name: '  جهاز مساج  جديد ', category: 'عناية', price: '299' }); const d2 = await PS.createDraft({ name: 'منتج تاني' });
  ok('a new product gets its own NEGATIVE id (never clashes with a real product), the name is tidied, the price is optional', d1.id < 0 && d2.id < 0 && d1.id !== d2.id && d1.name === 'جهاز مساج جديد' && d1.price === 299 && d2.price === null);
  ok('listing returns the newest first; nothing was added to the products table', (await PS.listDrafts())[0].id === d2.id && !products.has(d1.id));
  const ctx = await PS.getContext(d1.id);
  ok('its data comes from what the owner typed — no store, no campaigns, no invented features', ctx.isDraft === true && ctx.name === 'جهاز مساج جديد' && ctx.price === 299 && ctx.features.length === 0 && ctx.storeId === null && ctx.linkedCampaigns === null && ctx.eoError === null);
  ok('photos can only be added to an existing new product', (await rejects(() => PS.putImage(-999, 1, url(PNG, 'image/png'))))?.status === 404);
  await PS.putImage(d1.id, 1, url(PNG, 'image/png'));
  const a = await PS.analyze(d1.id, { deps }); ok('analysis runs on a new product from its photos', !!a.analysis && a.analysis.confirmed.specs.length > 0);
  const t = await PS.buildTargeting(d1.id, { deps }); ok('targeting runs too and its interests say Meta verification is unavailable (not «verified»)', t.targeting.strategies.length === 5 && t.targeting.verification.available === false);
  const ra = await PS.realAudience(d1.id); ok('Real Buyer Audience is honestly empty for a product that never sold (no invented demographics)', ra.gender.length === 0 && ra.governorates.length === 0 && /لسه ماتباعش/.test(ra.note));
  const v = await PS.getView(d1.id, deps); ok('the screen model shows the new product with the typed price and no link until the owner adds one', v.context.isDraft && v.commercial.price === 299 && v.commercial.link === null);
  const link = await PS.saveCommercial(d1.id, { link: 'https://example.com/p/1' }); ok('the owner can add a page link for it', link.commercial.link.value === 'https://example.com/p/1');
  ok('real products are untouched (positive ids still need a real product; id 0 / junk are refused)', (await rejects(() => PS.getContext(424242, { findProduct: async () => null })))?.status === 404 && (await rejects(() => PS.getView('0')))?.status === 400 && (await rejects(() => PS.getView('abc')))?.status === 400);
  ok('deleting a real product id through the draft delete is refused', (await rejects(() => PS.deleteDraft(7)))?.status === 400);
  await PS.deleteDraft(d1.id);
  ok('deleting removes it from the list and wipes its photos / analysis', !(await PS.listDrafts()).some((x) => x.id === d1.id) && (await rejects(() => PS.getContext(d1.id)))?.status === 404 && !blobs.has(`ps/${d1.id}/1`) && (await PS.loadState(d1.id)).analysis === null);
  ok('the other new product is unaffected', (await PS.listDrafts()).some((x) => x.id === d2.id));
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
