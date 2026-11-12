// 🧪 Product page audit (speed + /100) and the «8 Meta interests» list — URL safety (SSRF), measuring, HTML facts, the transparent score, Google PageSpeed parsing, and the engine (saving, interest verification).
//   node src/scripts/productPageAuditTest.js      (no database, no network, no AI key needed)
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
const { prisma } = await imp('../prisma.js');
const mem = new Map(); const blobs = new Map(); const products = new Map();
Object.defineProperty(prisma, 'settings', { configurable: true, value: { findUnique: async ({ where }) => (mem.has(where.id) ? { id: where.id, data: mem.get(where.id) } : null), upsert: async ({ where, create, update }) => { mem.set(where.id, mem.has(where.id) ? update.data : create.data); return {}; } } });
Object.defineProperty(prisma, 'cfBlob', { configurable: true, value: { findUnique: async ({ where }) => (blobs.has(where.key) ? { key: where.key, ...blobs.get(where.key) } : null), upsert: async () => ({}), deleteMany: async () => ({}) } });
Object.defineProperty(prisma, 'product', { configurable: true, value: { findUnique: async ({ where }) => products.get(where.id) || null } });
const PA = await imp('../services/amb/productStrategy/pageAudit.js'); const PS = await imp('../services/amb/productStrategy/engine.js');
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const pub = async () => [{ address: '93.184.216.34' }];

const GOOD = `<!doctype html><html lang="ar"><head><title>جهاز المساج الدوّار 360 للجسم</title><meta name="viewport" content="width=device-width"><meta name="description" content="جهاز مساج يدوي بعدة بكرات دوّارة مناسب للاستخدام المنزلي والعناية بالجسم"></head><body><h1>جهاز المساج الدوّار 360</h1>
<img src="a.jpg" alt="جهاز المساج من الأمام" loading="lazy"><img src="b.jpg" alt="تفاصيل البكرات"><img src="c.jpg" alt="طريقة الاستخدام"><img src="d.jpg" alt="الجهاز من الجنب">
<p>السعر 349 جنيه فقط والدفع عند الاستلام وشحن لكل المحافظات مع استرجاع خلال 14 يوم. ${'جهاز مساج عملي بتصميم مريح وسهل الاستخدام في البيت. '.repeat(8)}</p><button>اطلب الآن</button><script src="x.js"></script></body></html>`;
const SPA = '<!doctype html><html><head><title>متجر</title></head><body><div id="root"></div><script src="a.js"></script><script src="b.js"></script><script src="c.js"></script></body></html>';
const fetched = (html, o = {}) => ({ finalUrl: 'https://shop.example.com/p/1', status: 200, ttfbMs: 300, totalMs: 900, bytes: html.length, truncated: false, https: true, html, ...o });

console.log('\n1. URL safety (the server only fetches public http(s) pages)');
{
  ok('bare domain gets https://', PA.normalizePageUrl('shop.example.com/p/1').protocol === 'https:');
  ok('ftp / javascript / credentials / empty are refused', (await rejects(() => PA.normalizePageUrl('ftp://x.com')))?.status === 400 && (await rejects(() => PA.normalizePageUrl('')))?.status === 400 && (await rejects(() => PA.normalizePageUrl('https://u:p@x.com')))?.status === 400);
  ok('localhost, 127.0.0.1, 10.x, 192.168.x, 169.254 (cloud metadata), ::1 are refused', (await Promise.all(['http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/latest', 'http://[::1]/'].map((u) => rejects(() => PA.assertPublicHost(new URL(u)))))).every(Boolean));
  ok('a domain that RESOLVES to a private address is refused (DNS rebinding style)', !!(await rejects(() => PA.assertPublicHost(new URL('https://evil.example.com'), async () => [{ address: '10.1.1.1' }]))));
  ok('a normal public domain passes', (await rejects(() => PA.assertPublicHost(new URL('https://shop.example.com'), pub))) === null);
  const mk = (map) => async (u) => map(u);
  const resp = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, body: { getReader: () => { let sent = false; return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: new TextEncoder().encode(body) })), cancel: async () => {} }; } } });
  const r1 = await PA.fetchPageHtml('https://shop.example.com/p/1', { lookup: pub, fetchImpl: mk(() => resp(200, GOOD, { 'content-type': 'text/html; charset=utf-8' })) });
  ok('a page is fetched with measured timings, size and https flag', r1.status === 200 && r1.bytes > 500 && r1.https === true && r1.ttfbMs >= 0 && r1.html.includes('اطلب الآن'));
  const rd = await rejects(() => PA.fetchPageHtml('https://shop.example.com/p/1', { lookup: async (h) => (h === 'shop.example.com' ? pub() : [{ address: '127.0.0.1' }]), fetchImpl: mk(() => resp(302, '', { location: 'http://internal.evil.com/' })) }));
  ok('a redirect to a private host is refused (every hop is re-checked)', rd?.status === 400);
  ok('a 404 / non-HTML response gives a clear error', (await rejects(() => PA.fetchPageHtml('https://shop.example.com/x', { lookup: pub, fetchImpl: mk(() => resp(404, '', { 'content-type': 'text/html' })) })))?.code === 'HTTP_ERROR' && (await rejects(() => PA.fetchPageHtml('https://shop.example.com/x', { lookup: pub, fetchImpl: mk(() => resp(200, '{}', { 'content-type': 'application/json' })) })))?.code === 'NOT_HTML');
  let n = 0; const loop = await rejects(() => PA.fetchPageHtml('https://shop.example.com/a', { lookup: pub, fetchImpl: mk(() => resp(301, '', { location: `https://shop.example.com/${++n}` })) }));
  ok('a redirect loop stops after a few hops', loop?.code === 'REDIRECTS' && n <= 6);
}

console.log('\n2. facts read from the page (no guessing)');
{
  const f = PA.extractFacts(GOOD);
  ok('title / meta description / H1 / viewport / lang are read', f.title.startsWith('جهاز المساج') && f.metaDescription.length > 40 && f.h1 === 'جهاز المساج الدوّار 360' && f.hasViewport && f.lang === 'ar');
  ok('images, alt coverage, lazy loading are counted', f.images === 4 && f.imagesWithAlt === 4 && f.imagesLazy === 1);
  ok('price, buy button, trust words (COD / shipping / return) are detected', f.hasPrice && f.hasCta && f.hasTrust);
  ok('a normal page is not mistaken for a JS-only page', f.looksSpa === false && f.textLength > 300);
  const s = PA.extractFacts(SPA);
  ok('a JS-only (client rendered) page is detected, so we do not pretend to see its content', s.looksSpa === true && s.hasPrice === false);
  ok('scripts and styles never count as visible text', !PA.extractFacts('<body><script>var price="999 جنيه اطلب"</script><style>a{}</style><p>x</p></body>').hasCta);
}

console.log('\n3. the score (real PageSpeed number when available, honest estimate otherwise)');
{
  const f = PA.extractFacts(GOOD);
  const withPsi = PA.scorePage({ fetched: fetched(GOOD), facts: f, psi: { ok: true, score: 62, metrics: { fcpMs: 2100, lcpMs: 4300, tbtMs: 450, cls: 0.02, speedIndexMs: 3000, ttiMs: 5000 } } });
  ok('speed comes from Google PageSpeed as-is (62) and is labelled with its source', withPsi.speed.source === 'PAGESPEED' && withPsi.speed.score === 62 && /Google PageSpeed/.test(withPsi.speed.sourceLabel));
  ok('content score = checks earned / possible (a complete page = 100)', withPsi.content.score === 100 && withPsi.content.checks.every((c) => c.ok));
  ok('total = 40% speed + 60% content (62*0.4 + 100*0.6 = 85)', withPsi.total === 85 && /40%/.test(withPsi.formula));
  ok('slow metrics produce concrete tips with the real numbers (LCP 4.3s, TBT 450ms)', withPsi.tips.some((t) => /4\.3/.test(t)) && withPsi.tips.some((t) => /450/.test(t)));
  const noPsi = PA.scorePage({ fetched: fetched(GOOD), facts: f, psi: { ok: false, reason: 'Google PageSpeed رفض الطلب مؤقتًا (حد الاستخدام)' } });
  ok('without PageSpeed the speed is a labelled ESTIMATE with the reason — never presented as Lighthouse', noPsi.speed.source === 'BASIC' && /تقدير/.test(noPsi.speed.sourceLabel) && /حد الاستخدام/.test(noPsi.speed.psiReason) && noPsi.speed.metrics === null);
  const slow = PA.basicSpeedScore({ ttfbMs: 3000, totalMs: 8000, bytes: 1_200_000 }, { ...f, scripts: 60, images: 40, imagesLazy: 0 }); const fast = PA.basicSpeedScore({ ttfbMs: 200, totalMs: 600, bytes: 60_000 }, { ...f, scripts: 4, images: 3, imagesLazy: 3 });
  ok('the estimate separates a heavy slow page (low) from a light fast one (high)', slow < 25 && fast > 90, `${slow}/${fast}`);
  const bare = '<html><body><p>x</p></body></html>'; const poor = PA.scorePage({ fetched: fetched(bare, { https: false }), facts: PA.extractFacts(bare), psi: { ok: true, score: 40, metrics: {} } });
  ok('a poor page scores low and lists what is missing (no price, no button, http)', poor.total < 45 && poor.content.checks.filter((c) => !c.ok).length >= 8 && poor.tips.some((t) => /زر طلب/.test(t)));
  const spa = PA.scorePage({ fetched: fetched(SPA), facts: PA.extractFacts(SPA), psi: { ok: true, score: 71, metrics: {} } });
  ok('a JS-only page: content is NOT scored (no guessing) and the total is the speed alone, with the reason shown', spa.content.score === null && spa.total === 71 && /مقدرتش أقيّم/.test(spa.content.note) && spa.formula === 'السرعة 100%');
}

console.log('\n4. Google PageSpeed response parsing');
{
  const js = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
  const good = await PA.fetchPsi('https://shop.example.com', { apiKey: 'k', fetchImpl: js(200, { lighthouseResult: { categories: { performance: { score: 0.57 } }, audits: { 'first-contentful-paint': { numericValue: 2200.4 }, 'largest-contentful-paint': { numericValue: 4100 }, 'total-blocking-time': { numericValue: 380 }, 'cumulative-layout-shift': { numericValue: 0.11 } } } }) });
  ok('performance 0.57 → 57 with the real FCP / LCP / TBT / CLS', good.ok && good.score === 57 && good.metrics.lcpMs === 4100 && good.metrics.cls === 0.11 && good.metrics.ttiMs === null);
  const lim = await PA.fetchPsi('https://shop.example.com', { fetchImpl: js(429, {}) }); ok('rate limit → ok:false with a clear Arabic reason', lim.ok === false && /حد الاستخدام/.test(lim.reason));
  ok('an unexpected body → ok:false (never a made-up score)', (await PA.fetchPsi('https://shop.example.com', { fetchImpl: js(200, { foo: 1 }) })).ok === false);
  ok('a network failure → ok:false', (await PA.fetchPsi('https://shop.example.com', { fetchImpl: async () => { throw new Error('boom'); } })).ok === false);
}

console.log('\n5. engine: save the audit + the 8 interests');
{
  products.set(7, { id: 7, product_name: 'جهاز المساج الدوّار', category: 'عناية', selling_price: 349, store_id: 'trendy', easy_orders_uuid: 'abc-123' });
  const eo = { name: 'جهاز المساج الدوّار', slug: 'Massage', price: 349, oldPrice: null, freeShipping: false, categories: ['عناية بالجسم'], facts: ['بكرات متعددة', 'تصميم عملي'] };
  const base = { getEoDetail: async () => eo, getStore: () => ({ id: 'trendy', domain: 'www.trendy-egy.com' }), campaigns: async () => [1] };
  const audit = async (u) => ({ url: u, finalUrl: u, at: new Date().toISOString(), total: 77, totalLabel: 'كويسة', speed: { score: 70, source: 'PAGESPEED', label: 'متوسطة', sourceLabel: 'x', metrics: {} }, content: { score: 90, checks: [] }, tips: [], measured: { ttfbMs: 1, totalMs: 1, htmlKb: 1, images: 1, scripts: 1, https: true }, formula: 'x', facts: { title: 'جهاز المساج', h1: 'جهاز', textSample: 'نص' } });
  const st = await PS.analyzePage(7, { url: 'https://www.trendy-egy.com/products/Massage-Roller', deps: { ...base, audit } });
  ok('the audit is saved inside the product and the typed URL becomes the product link used in posts', st.page.total === 77 && st.commercial.link.value === 'https://www.trendy-egy.com/products/Massage-Roller');
  const v = await PS.getView(7, { ...base, ai: true });
  ok('the screen model exposes page + interests', v.page.total === 77 && v.interests === null && v.commercial.linkSource === 'MANUAL');
  ok('a bad URL is refused (no audit runs)', (await rejects(() => PS.analyzePage(7, { url: 'javascript:alert(1)', deps: { ...base, audit } })))?.status === 400);
  products.set(8, { id: 8, product_name: 'منتج', category: null, selling_price: 0, store_id: null, easy_orders_uuid: null });
  ok('no URL anywhere → a clear message', (await rejects(() => PS.analyzePage(8, { deps: { ...base, getEoDetail: async () => { throw new Error('x'); }, getStore: () => null, audit } })))?.code === 'NO_URL');

  const cands = ['Massage', 'Self-care', 'Spa', 'Wellness (alternative medicine)', 'Beauty', 'Online shopping', 'Home improvement', 'Fitness and wellness', 'massage', 'تدليك', 'Islam', 'Physical fitness', 'Yoga', 'Health care', 'Skin care', 'Relaxation'].map((n) => ({ name: n, why: 'سبب' }));
  const generate = async () => ({ text: JSON.stringify({ interests: cands }), cached: false });
  const known = { Massage: { id: '1', name: 'Massage', audience_size_lower_bound: 5e6, audience_size_upper_bound: 8e6 }, Spa: { id: '2', name: 'Spa' }, Beauty: { id: '3', name: 'Beauty' }, Yoga: { id: '4', name: 'Yoga' }, 'Skin care': { id: '5', name: 'Skin care' }, 'Online shopping': { id: '6', name: 'Online shopping' } };
  const meta = { getToken: async () => 't', search: async (_t, q) => (known[q] ? [known[q]] : q === 'Fitness and wellness' ? [{ id: '9', name: 'Fitness and wellness' }, { id: '10', name: 'Wellness' }] : q === 'Self-care' ? [{ id: '11', name: 'Self-care products' }] : []), cache: { get: async () => null, set: async () => {} } };
  const r = await PS.buildInterests(7, { deps: { ...base, ai: true, generate, meta } });
  const names = r.interests.items.map((x) => x.name);
  ok('exactly 8 interests, no duplicates (the repeated «massage» and the Arabic / sensitive ones are dropped)', names.length === 8 && new Set(names.map((x) => x.toLowerCase())).size === 8 && !names.includes('Islam') && names.every((x) => /^[\x20-\x7E]+$/.test(x)), names.join());
  ok('Meta-verified ones come first and carry Meta’s id (and audience size when Meta gives it)', r.interests.items[0].name === 'Massage' && r.interests.items[0].metaId === '1' && r.interests.items[0].audienceUpper === 8e6 && r.interests.items.slice(0, 6).every((x) => x.status === 'VERIFIED'));
  const sim = r.interests.items.find((x) => x.requested === 'Self-care');
  ok('a name Meta does not have exactly is swapped for Meta’s real close match and says so', !!sim && sim.name === 'Self-care products' && sim.alt === true);
  ok('the verification count is honest (X of 8 checked inside Meta)', r.interests.verification.available === true && r.interests.verification.verified === r.interests.items.filter((x) => x.status === 'VERIFIED').length);
  const down = await PS.buildInterests(7, { deps: { ...base, ai: true, generate, meta: { getToken: async () => { throw new Error('Meta مش متصل'); } } } });
  ok('Meta not connected → still 8 suggestions, but NONE is shown as verified and the reason is stated', down.interests.items.length === 8 && down.interests.items.every((x) => x.status === 'UNAVAILABLE') && down.interests.verification.available === false && /Meta/.test(down.interests.verification.reason));
  ok('no AI key → a clear 503, nothing invented', (await rejects(() => PS.buildInterests(7, { deps: { ...base, ai: false } })))?.status === 503);
  ok('too few usable candidates from the AI → an honest error, not a padded list', (await rejects(() => PS.buildInterests(7, { deps: { ...base, ai: true, generate: async () => ({ text: JSON.stringify({ interests: [{ name: 'Yoga' }, { name: 'عربي' }] }) }), meta } })))?.code === 'AI_INCOMPLETE');
  await PS.analyzePage(7, { url: 'https://www.trendy-egy.com/products/Massage-Roller', deps: { ...base, audit } });
  ok('re-auditing the page after the interests were made marks them as needing a refresh', (await PS.getView(7, { ...base, ai: true })).interests.pageChanged === true);
  const reopened = await PS.getView(7, { ...base, ai: true }); ok('everything stays saved inside the product (re-opening shows the same 8)', reopened.interests.items.length === 8 || reopened.interests.items.length === down.interests.items.length);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
