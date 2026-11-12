// AI Product Targeting & Creative Strategy — product PAGE audit: real speed + a transparent /100 score. Read-only: it only GETs the owner's public product page (and asks Google PageSpeed Insights, a free
// public Lighthouse service, to measure it). Nothing is written anywhere except the product's own settings row. Numbers are measured, never guessed; when a measurement is not possible it says so.
import dns from 'node:dns/promises';
import net from 'node:net';

export class PageAuditError extends Error { constructor(message, status = 400, code = 'BAD_URL') { super(message); this.status = status; this.code = code; } }
const FETCH_TIMEOUT_MS = 15_000; const PSI_TIMEOUT_MS = 75_000; const MAX_BYTES = 2_500_000; const MAX_REDIRECTS = 4;

// ───────────── URL safety (SSRF): only public http(s) hosts ─────────────
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  if (net.isIPv6(ip)) { const s = ip.toLowerCase(); return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80') || (s.startsWith('::ffff:') && isPrivateIp(s.slice(7))); }
  return true;
}
export function normalizePageUrl(v) {
  const s = String(v || '').trim(); if (!s) throw new PageAuditError('اكتب رابط صفحة المنتج.');
  if (s.length > 400) throw new PageAuditError('الرابط طويل جدًا.');
  if (/^(?:javascript|data|file|vbscript|blob):/i.test(s) || (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s))) throw new PageAuditError('الرابط لازم يبدأ بـ https://');
  let u; try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { throw new PageAuditError('الرابط غير صالح.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new PageAuditError('الرابط لازم يبدأ بـ https://');
  if (u.username || u.password) throw new PageAuditError('الرابط فيه بيانات دخول — شيلها.');
  return u;
}
export async function assertPublicHost(u, lookup = (h) => dns.lookup(h, { all: true })) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new PageAuditError('الرابط ده مش صفحة عامة على الإنترنت.');
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new PageAuditError('الرابط ده مش صفحة عامة على الإنترنت.'); return; }
  let addrs; try { addrs = await lookup(host); } catch { throw new PageAuditError('الدومين مش بيفتح — اتأكد من الرابط.', 422, 'DNS'); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new PageAuditError('الرابط ده مش صفحة عامة على الإنترنت.');
}

// ───────────── fetching (measured) ─────────────
export async function fetchPageHtml(urlStr, { fetchImpl = fetch, lookup, now = () => performance.now() } = {}) {
  let u = normalizePageUrl(urlStr); let hops = 0;
  for (;;) {
    await assertPublicHost(u, lookup);
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS); const t0 = now();
    let res;
    try { res = await fetchImpl(u.toString(), { redirect: 'manual', signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PageCheck/1.0)', Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ar,en;q=0.8' } }); }
    catch (e) { clearTimeout(timer); throw new PageAuditError(e.name === 'AbortError' ? 'الصفحة اتأخرت أكتر من 15 ثانية في الرد.' : 'تعذّر فتح الصفحة.', 504, 'FETCH_FAILED'); }
    const ttfbMs = Math.round(now() - t0);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(timer); if (++hops > MAX_REDIRECTS) throw new PageAuditError('الرابط بيحوّل أكتر من اللازم.', 422, 'REDIRECTS');
      u = normalizePageUrl(new URL(res.headers.get('location'), u).toString()); continue;
    }
    if (!res.ok) { clearTimeout(timer); throw new PageAuditError(`الصفحة رجّعت خطأ ${res.status}.`, 422, 'HTTP_ERROR'); }
    const type = String(res.headers.get('content-type') || ''); if (!/html|xml/i.test(type)) { clearTimeout(timer); throw new PageAuditError('الرابط ده مش صفحة ويب (HTML).', 422, 'NOT_HTML'); }
    let html = ''; let bytes = 0;
    try {
      const reader = res.body.getReader(); const dec = new TextDecoder('utf-8'); const chunks = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > MAX_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } break; } chunks.push(dec.decode(value, { stream: true })); }
      html = chunks.join('');
    } catch (e) { clearTimeout(timer); throw new PageAuditError('تعذّر قراءة الصفحة.', 504, 'READ_FAILED'); }
    clearTimeout(timer);
    return { finalUrl: u.toString(), status: res.status, ttfbMs, totalMs: Math.round(now() - t0), bytes, truncated: bytes > MAX_BYTES, html, https: u.protocol === 'https:' };
  }
}

// ───────────── PageSpeed Insights (real Lighthouse, mobile) ─────────────
export async function fetchPsi(urlStr, { apiKey = process.env.PAGESPEED_API_KEY, fetchImpl = fetch } = {}) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), PSI_TIMEOUT_MS);
  try {
    const qs = new URLSearchParams({ url: urlStr, strategy: 'mobile', category: 'performance' }); if (apiKey) qs.set('key', apiKey);
    const res = await fetchImpl(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${qs}`, { signal: ac.signal });
    if (!res.ok) return { ok: false, reason: res.status === 429 ? 'Google PageSpeed رفض الطلب مؤقتًا (حد الاستخدام)' : `Google PageSpeed رجّع خطأ ${res.status}` };
    const j = await res.json(); const lh = j?.lighthouseResult; const perf = lh?.categories?.performance?.score;
    if (typeof perf !== 'number') return { ok: false, reason: 'Google PageSpeed مارجّعش تقييم للصفحة' };
    const a = lh.audits || {}; const num = (k) => (typeof a[k]?.numericValue === 'number' ? a[k].numericValue : null);
    return { ok: true, score: Math.round(perf * 100), metrics: { fcpMs: num('first-contentful-paint'), lcpMs: num('largest-contentful-paint'), tbtMs: num('total-blocking-time'), cls: num('cumulative-layout-shift'), speedIndexMs: num('speed-index'), ttiMs: num('interactive') } };
  } catch (e) { return { ok: false, reason: e.name === 'AbortError' ? 'Google PageSpeed اتأخر في القياس' : 'تعذّر الوصول لـ Google PageSpeed' }; }
  finally { clearTimeout(timer); }
}

// ───────────── HTML facts (pure) ─────────────
const strip = (h) => String(h).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
export function extractFacts(html) {
  const h = String(html || '');
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h) || [])[1] || '');
  const metaTag = (name) => { const m = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i').exec(h); const c = m && /content=["']([^"']*)["']/i.exec(m[0]); return c ? decode(c[1]) : ''; };
  const imgs = [...h.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const withAlt = imgs.filter((t) => /\balt=["'][^"']{2,}["']/i.test(t)).length; const lazy = imgs.filter((t) => /loading=["']lazy["']/i.test(t)).length;
  const text = strip(h); const h1s = [...h.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => decode(strip(m[1]))).filter(Boolean);
  const h2s = [...h.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => decode(strip(m[1]))).filter(Boolean).slice(0, 12);
  const scripts = [...h.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]); const extScripts = scripts.filter((t) => /\bsrc=/i.test(t)).length;
  const jsonLd = [...h.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join(' ');
  const priceInLd = /"price"\s*:\s*"?\d/.test(jsonLd) || /product:price:amount|og:price:amount/i.test(h);
  const priceInText = /\d[\d,.]*\s*(?:ج\.?\s?م|جنيه|EGP|LE|L\.E)/i.test(text) || /(?:EGP|LE|L\.E)\s*\d/i.test(text);
  const looksSpa = text.length < 250 && (/id=["'](?:root|app|__next|__nuxt)["']/i.test(h) || scripts.length >= 3);
  return {
    title, metaDescription: metaTag('description') || metaTag('og:description'), ogTitle: metaTag('og:title'), hasViewport: /<meta[^>]+name=["']viewport["']/i.test(h), lang: (/<html[^>]+lang=["']([^"']+)["']/i.exec(h) || [])[1] || null,
    h1: h1s[0] || null, h2: h2s, images: imgs.length, imagesWithAlt: withAlt, imagesLazy: lazy, scripts: scripts.length, externalScripts: extScripts, textLength: text.length,
    hasPrice: priceInLd || priceInText,
    hasCta: /(اطلب|اشتري|اشترى|أضف\s*(?:ل|إلى)\s*السلة|اضف\s*للسلة|احجز|buy\s*now|add\s*to\s*cart|order\s*now|checkout)/i.test(text) || /<(?:button|a|input)[^>]*(?:buy|order|cart|checkout|add-to)/i.test(h),
    hasTrust: /(الدفع\s*عند\s*الاستلام|شحن|توصيل|ضمان|استرجاع|استبدال|cash\s*on\s*delivery|free\s*shipping|warranty|return)/i.test(text),
    hasReviews: /(تقييم|آراء|اراء|عملاؤنا|عملاءنا|reviews?|testimonial)/i.test(text), looksSpa, textSample: text.slice(0, 1200),
  };
}

// ───────────── scoring (transparent) ─────────────
const rate = (ms, good, ok) => (ms == null ? null : ms <= good ? 1 : ms >= ok ? 0 : 1 - (ms - good) / (ok - good));
/** a rough speed estimate from what we measured ourselves — used ONLY when Google PageSpeed is unavailable, and labelled as such. */
export function basicSpeedScore(m, f) {
  let s = 100;
  s -= 30 * (1 - (rate(m.ttfbMs, 600, 2500) ?? 1)); s -= 25 * (1 - (rate(m.totalMs, 1500, 6000) ?? 1)); s -= 15 * (1 - (rate(m.bytes, 150_000, 900_000) ?? 1)); s -= 15 * (1 - (rate(f.scripts, 12, 45) ?? 1));
  const imgsNoLazy = Math.max(0, f.images - f.imagesLazy); s -= 15 * (1 - (rate(imgsNoLazy, 6, 30) ?? 1));
  return Math.max(0, Math.min(100, Math.round(s)));
}
export function contentChecks(f, m) {
  const c = [];
  const add = (key, label, ok, max, note) => c.push({ key, label, ok: !!ok, points: ok ? max : 0, max, note });
  add('https', 'الصفحة على HTTPS', m.https, 5, m.https ? 'آمنة' : 'الصفحة على http — العملاء ممكن يشوفوا تحذير أمان');
  add('viewport', 'مناسبة للموبايل (viewport)', f.hasViewport, 5, f.hasViewport ? 'متظبطة للموبايل' : 'مفيش إعداد موبايل — الصفحة ممكن تظهر صغيرة');
  add('title', 'عنوان الصفحة (title) واضح', f.title.length >= 10 && f.title.length <= 80, 5, f.title ? `${f.title.length} حرف` : 'مفيش عنوان للصفحة');
  add('desc', 'وصف للصفحة (meta description)', f.metaDescription.length >= 40, 3, f.metaDescription ? `${f.metaDescription.length} حرف` : 'مفيش وصف');
  add('h1', 'عنوان رئيسي H1 للمنتج', !!f.h1, 5, f.h1 ? f.h1.slice(0, 60) : 'مفيش H1');
  add('images', 'صور كفاية للمنتج (3 أو أكتر)', f.images >= 3, 8, `${f.images} صورة`);
  add('alt', 'الصور لها وصف (alt) — 70% أو أكتر', f.images > 0 && f.imagesWithAlt / f.images >= 0.7, 4, f.images ? `${f.imagesWithAlt}/${f.images}` : 'مفيش صور');
  add('price', 'السعر ظاهر في الصفحة', f.hasPrice, 8, f.hasPrice ? 'السعر ظاهر' : 'السعر مش ظاهر في كود الصفحة');
  add('cta', 'زر طلب/شراء واضح', f.hasCta, 10, f.hasCta ? 'فيه زر طلب' : 'مفيش زر طلب واضح في كود الصفحة');
  add('trust', 'ذكر الدفع عند الاستلام/الشحن/الضمان', f.hasTrust, 6, f.hasTrust ? 'فيه عناصر ثقة' : 'مفيش ذكر للدفع أو الشحن أو الضمان');
  add('copy', 'وصف نصي كفاية (300 حرف أو أكتر)', f.textLength >= 300, 6, `${f.textLength} حرف ظاهر`);
  return c;
}
const speedLabel = (s) => (s >= 90 ? 'سريعة' : s >= 50 ? 'متوسطة — محتاجة تحسين' : 'بطيئة — بتخسّرك عملاء');
export function scorePage({ fetched, facts, psi }) {
  const m = { ttfbMs: fetched.ttfbMs, totalMs: fetched.totalMs, bytes: fetched.bytes, https: fetched.https };
  const speed = psi?.ok ? { source: 'PAGESPEED', sourceLabel: 'Google PageSpeed (Lighthouse — موبايل)', score: psi.score, metrics: psi.metrics } : { source: 'BASIC', sourceLabel: 'تقدير مبدئي من قياسنا للصفحة (Google PageSpeed مش متاح)', score: basicSpeedScore(m, facts), metrics: null, psiReason: psi?.reason || null };
  speed.label = speedLabel(speed.score);
  const checks = contentChecks(facts, m);
  const contentMeasurable = !facts.looksSpa; const max = checks.reduce((s, c) => s + c.max, 0); const got = checks.reduce((s, c) => s + c.points, 0);
  const content = contentMeasurable ? { score: Math.round((got / max) * 100), checks } : { score: null, checks: [], note: 'الصفحة بتتحمّل بالجافاسكربت — محتواها مش ظاهر في الكود الخام فمقدرتش أقيّم العناصر (السعر/الزر/الصور) من غير تخمين. التقييم النهائي = السرعة بس.' };
  const total = content.score == null ? speed.score : Math.round(speed.score * 0.4 + content.score * 0.6);
  const tips = [];
  if (speed.metrics?.lcpMs > 2500) tips.push(`أكبر عنصر في الصفحة (LCP) بياخد ${(speed.metrics.lcpMs / 1000).toFixed(1)} ثانية — الأفضل أقل من 2.5 ثانية (صغّر صورة المنتج الأساسية).`);
  if (speed.metrics?.tbtMs > 300) tips.push(`الصفحة بتتجمّد ${Math.round(speed.metrics.tbtMs)}ms أثناء التحميل (TBT) — قلّل السكربتات والتطبيقات الإضافية.`);
  if (fetched.ttfbMs > 1200) tips.push(`السيرفر بيرد في ${fetched.ttfbMs}ms — بطيء نسبيًا.`);
  if (fetched.bytes > 500_000) tips.push(`حجم كود الصفحة ${Math.round(fetched.bytes / 1024)}KB — تقيل.`);
  for (const c of [...content.checks].sort((a, b) => b.max - a.max)) if (!c.ok) tips.push(`${c.label}: ${c.note}.`);
  return { total, totalLabel: total >= 80 ? 'ممتازة' : total >= 60 ? 'كويسة' : total >= 40 ? 'متوسطة' : 'ضعيفة', speed, content, tips: tips.slice(0, 8),
    measured: { ttfbMs: fetched.ttfbMs, totalMs: fetched.totalMs, htmlKb: Math.round(fetched.bytes / 1024), images: facts.images, scripts: facts.scripts, https: fetched.https, truncated: fetched.truncated }, formula: content.score == null ? 'السرعة 100%' : 'السرعة 40% + محتوى الصفحة 60%' };
}

/** @param {string} urlStr @param {{fetchHtml?:Function, psi?:Function, now?:()=>string}} deps */
export async function auditPage(urlStr, deps = {}) {
  const fetched = await (deps.fetchHtml || fetchPageHtml)(urlStr);
  const facts = extractFacts(fetched.html);
  const psi = await (deps.psi || fetchPsi)(fetched.finalUrl);
  const r = scorePage({ fetched, facts, psi });
  return { url: normalizePageUrl(urlStr).toString(), finalUrl: fetched.finalUrl, at: (deps.now || (() => new Date().toISOString()))(), ...r, facts: { title: facts.title, h1: facts.h1, h2: facts.h2, metaDescription: facts.metaDescription, textSample: facts.textSample, looksSpa: facts.looksSpa } };
}
