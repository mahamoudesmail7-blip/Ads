// AI Product Targeting & Creative Strategy — orchestration. One settings row per product (`ps:<productId>`, no schema change) + the 3 photos in cf_blobs (`ps/<productId>/<slot>`).
// Reuses what already exists: the AI gateway (vision + text, budget guard, usage log, cache), the Easy Orders product data (name, price, link, features), Meta's read-only interest search,
// and the existing segment intelligence (real Meta + Easy Orders buyer data). Nothing here writes to Meta, touches AUTOPILOT, budgets, pauses or any campaign.
import crypto from 'node:crypto';
import { prisma } from '../../../prisma.js';
import { logger } from '../../../logger.js';
import { generateText, TIERS, isAiConfigured } from '../../aiGateway/index.js';
import { getEasyOrdersProductDetail } from '../easyOrdersProducts.js';
import { getStore } from '../../easyOrdersStores.js';
import { verifyInterests } from './metaInterests.js';
import * as SC from './schema.js';
import * as PR from './prompts.js';
import { auditPage } from './pageAudit.js';
import * as IP from './interestsPrompt.js';

export class StrategyError extends Error { constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; } }
const bad = (m, s = 400, c) => new StrategyError(m, s, c);
const now = () => new Date().toISOString();
const KEY = (id) => `ps:${id}`;
const BLOB = (id, slot) => `ps/${id}/${slot}`;
const pid = (v) => { const n = Number(v); if (!Number.isInteger(n) || n === 0) throw bad('معرّف المنتج غير صالح.'); return n; }; // negative = a «new product» draft (see below)

// ───────────── storage ─────────────
const chains = new Map();
const withLock = (k, fn) => { const prev = chains.get(k) || Promise.resolve(); const run = prev.catch(() => {}).then(fn); chains.set(k, run.catch(() => {})); return run; };
const emptyState = (productId) => ({ productId, createdAt: now(), updatedAt: now(), images: {}, commercial: { link: null, confirmed: {} }, analysis: null, targeting: null, posts: null, page: null, interests: null });
export async function loadState(productId) {
  const row = await prisma.settings.findUnique({ where: { id: KEY(productId) } });
  let s = null; try { s = JSON.parse(row?.data || 'null'); } catch { s = null; }
  return s && typeof s === 'object' ? { ...emptyState(productId), ...s } : emptyState(productId);
}
async function saveState(s) { s.updatedAt = now(); const data = JSON.stringify(s); await prisma.settings.upsert({ where: { id: KEY(s.productId) }, create: { id: KEY(s.productId), data }, update: { data } }); return s; }
const mutate = (productId, fn) => withLock(KEY(productId), async () => { const s = await loadState(productId); const out = (await fn(s)) || s; await saveState(out); return out; });


// ───────────── light product list for the picker (id + name only — no spend / CPA / health) ─────────────
export async function listProductsLight({ storeId = null } = {}, deps = {}) {
  const ids = await (deps.discover || (async (s) => (await import('../productDiscovery.js')).discoverRelevantProductIds(s)))(storeId || null);
  if (!ids.length) return [];
  const rows = await (deps.findMany || ((a) => prisma.product.findMany(a)))({ where: { id: { in: ids } }, select: { id: true, product_name: true, store_id: true } });
  return rows.filter((r) => r.product_name).map((r) => ({ id: r.id, name: r.product_name, storeId: r.store_id || null })).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

// ───────────── new (draft) products — a product that does NOT exist in the system ─────────────
// The owner can analyse any product from just a name + photos (e.g. a massager he is only considering). Drafts live ONLY in this module's own settings rows (negative ids, so they can never clash with a real
// product id); nothing is added to the products table, the stores, the campaigns or any other module.
const DRAFTS_KEY = 'psd:index';
async function loadDrafts() {
  const row = await prisma.settings.findUnique({ where: { id: DRAFTS_KEY } }); let d = null; try { d = JSON.parse(row?.data || 'null'); } catch { d = null; }
  return d && Array.isArray(d.items) ? d : { next: 1, items: [] };
}
const mutateDrafts = (fn) => withLock(DRAFTS_KEY, async () => { const d = await loadDrafts(); const out = (await fn(d)) || d; const data = JSON.stringify(out); await prisma.settings.upsert({ where: { id: DRAFTS_KEY }, create: { id: DRAFTS_KEY, data }, update: { data } }); return out; });
const publicDraft = (x) => ({ id: x.id, name: x.name, category: x.category || null, price: x.price ?? null, createdAt: x.createdAt });
async function draftOrThrow(id) { const d = (await loadDrafts()).items.find((x) => x.id === id && !x.deleted); if (!d) throw bad('المنتج الجديد مش موجود (يمكن اتمسح).', 404, 'NOT_FOUND'); return d; }
export async function listDrafts() { return (await loadDrafts()).items.filter((x) => !x.deleted).sort((a, b) => a.id - b.id).map(publicDraft); } // newest first: ids go -1, -2, -3 … so the most negative is the newest (deterministic, unlike a timestamp)
export async function createDraft({ name, category, price } = {}) {
  const n = String(name || '').replace(/\s+/g, ' ').trim(); if (n.length < 2) throw bad('اكتب اسم المنتج (حرفين على الأقل).'); if (n.length > 120) throw bad('اسم المنتج طويل جدًا (أقصى 120 حرف).');
  const cat = String(category || '').replace(/\s+/g, ' ').trim().slice(0, 60) || null;
  let p = null; if (price !== undefined && price !== null && String(price).trim() !== '') { p = Number(price); if (!Number.isFinite(p) || p <= 0 || p > 1_000_000) throw bad('السعر لازم يكون رقم أكبر من صفر.'); }
  let created = null;
  await mutateDrafts((d) => {
    if (d.items.filter((x) => !x.deleted).length >= 200) throw bad('وصلت للحد الأقصى (200 منتج جديد). امسح اللي مش محتاجه.');
    const id = -d.next; d.next += 1; created = { id, name: n, category: cat, price: p, createdAt: now() }; d.items.push(created);
  });
  return publicDraft(created);
}
export async function deleteDraft(id) {
  id = pid(id); if (id > 0) throw bad('الحذف للمنتجات الجديدة بس.');
  await mutateDrafts((d) => { const it = d.items.find((x) => x.id === id && !x.deleted); if (!it) throw bad('المنتج مش موجود.', 404, 'NOT_FOUND'); it.deleted = true; it.deletedAt = now(); });
  for (const def of SC.IMAGE_SLOTS) await prisma.cfBlob.deleteMany({ where: { key: BLOB(id, def.slot) } });
  await mutate(id, () => emptyState(id)); // its photos, analysis, targeting, posts, page audit and interests go with it
  return { ok: true };
}
async function draftContext(productId) {
  const d = await draftOrThrow(productId);
  return { productId, isDraft: true, storeId: null, name: d.name, category: d.category || null, price: d.price ?? null, oldPrice: null, freeShipping: false, features: [], storeUrl: null,
    storeUrlMissingReason: 'منتج جديد مش موجود في متجرك — اكتب رابط صفحة المنتج لو عندك.', eoError: null, linkedCampaigns: null };
}

// ───────────── product data (reused, never duplicated) ─────────────
export async function getContext(productId, deps = {}) {
  if (productId < 0) return draftContext(productId);
  const product = await (deps.findProduct || ((id) => prisma.product.findUnique({ where: { id }, select: { id: true, product_name: true, category: true, selling_price: true, store_id: true, easy_orders_uuid: true } })))(productId);
  if (!product) throw bad('المنتج مش موجود.', 404, 'NOT_FOUND');
  let eo = null; let eoError = null;
  if (product.store_id && product.easy_orders_uuid) { try { eo = await (deps.getEoDetail || getEasyOrdersProductDetail)(product.store_id, product.easy_orders_uuid); } catch (e) { eoError = e.message || 'تعذّر قراءة بيانات Easy Orders'; } }
  else eoError = 'المنتج مش مربوط بمنتج Easy Orders.';
  const store = (deps.getStore || getStore)(product.store_id) || null;
  const domain = store?.domain ? String(store.domain).replace(/^https?:\/\//i, '').replace(/\/+$/, '') : null;
  const storeUrl = eo?.slug && domain ? `https://${domain}/products/${eo.slug}` : null;
  let campaigns = null; try { campaigns = (await (deps.campaigns || (async (id) => (await import('../productPerformance.js')).resolveProductCampaigns(id)))(productId)).length; } catch { campaigns = null; }
  return {
    productId, storeId: product.store_id || null, name: eo?.name || product.product_name, category: eo?.categories?.[0] || product.category || null,
    price: Number.isFinite(Number(eo?.price)) ? Number(eo.price) : (Number.isFinite(Number(product.selling_price)) && product.selling_price > 0 ? Number(product.selling_price) : null),
    oldPrice: eo?.oldPrice ?? null, freeShipping: eo?.freeShipping === true, features: Array.isArray(eo?.facts) ? eo.facts : [], storeUrl, storeUrlMissingReason: storeUrl ? null : (!domain ? 'دومين المتجر مش متسجّل في إعدادات المتجر.' : !eo?.slug ? 'مفيش slug للمنتج من Easy Orders.' : null),
    eoError, linkedCampaigns: campaigns,
  };
}
const validLink = (v) => { const s = String(v || '').trim(); if (!s) return null; if (s.length > 300) throw bad('الرابط طويل جدًا.'); let u; try { u = new URL(s); } catch { throw bad('الرابط غير صالح.'); } if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('الرابط لازم يبدأ بـ https://'); return u.toString(); };
export function effectiveCommercial(context, state) {
  const link = state.commercial?.link?.value || context.storeUrl || null; const linkSource = state.commercial?.link?.value ? 'MANUAL' : (context.storeUrl ? 'STORE_DATA' : null);
  const c = SC.buildCommercial({ price: context.price, oldPrice: context.oldPrice, freeShipping: context.freeShipping, confirmedByOwner: state.commercial?.confirmed || {} });
  return { ...c, link, linkSource };
}
const featuresFor = (analysis) => SC.uniq([...(analysis?.confirmed?.specs || []).map((x) => x.text), ...(analysis?.storeFeatures || [])]).slice(0, 12);

// ───────────── images ─────────────
const MAGIC = [['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff], ['image/png', (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47], ['image/webp', (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP']];
export function parseImageDataUrl(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw bad('ارفع صورة صالحة.');
  if (!SC.ALLOWED_MIME.includes(m[1])) throw bad('نوع الملف مش مدعوم — الصور المقبولة JPG أو PNG أو WEBP.', 415, 'BAD_TYPE');
  const buffer = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw bad('الصورة فاضية.');
  if (buffer.length > SC.MAX_IMAGE_BYTES) throw bad(`الصورة أكبر من ${Math.round(SC.MAX_IMAGE_BYTES / 1048576)}MB.`, 413, 'TOO_BIG');
  const real = MAGIC.find(([, ok]) => ok(buffer)); // the content must really be that image type — the declared type is not trusted
  if (!real) throw bad('الملف مش صورة حقيقية.', 415, 'BAD_CONTENT');
  return { mime: real[0], buffer };
}
const slotOf = (v) => { const s = Number(v); if (![1, 2, 3].includes(s)) throw bad('رقم الصورة لازم يكون 1 أو 2 أو 3.'); return s; };
export async function putImage(productId, slot, dataUrl) {
  productId = pid(productId); slot = slotOf(slot);
  if (productId < 0) await draftOrThrow(productId);
  const { mime, buffer } = parseImageDataUrl(dataUrl);
  await prisma.cfBlob.upsert({ where: { key: BLOB(productId, slot) }, create: { key: BLOB(productId, slot), data: buffer, mime, bytes: buffer.length }, update: { data: buffer, mime, bytes: buffer.length } });
  const sha = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  return mutate(productId, (s) => { s.images[slot] = { slot, mime, bytes: buffer.length, sha, at: now() }; if (s.analysis) s.analysis.stale = true; if (s.targeting) s.targeting.stale = true; if (s.posts) s.posts.stale = true; });
}
export async function removeImage(productId, slot) {
  productId = pid(productId); slot = slotOf(slot);
  await prisma.cfBlob.deleteMany({ where: { key: BLOB(productId, slot) } });
  return mutate(productId, (s) => { delete s.images[slot]; if (s.analysis) s.analysis.stale = true; if (s.targeting) s.targeting.stale = true; if (s.posts) s.posts.stale = true; });
}
export async function getImageBlob(productId, slot) { const row = await prisma.cfBlob.findUnique({ where: { key: BLOB(pid(productId), slotOf(slot)) } }); return row ? { mime: row.mime, data: Buffer.from(row.data) } : null; }
async function loadImages(productId, state) {
  const out = [];
  for (const def of SC.IMAGE_SLOTS) { if (!state.images[def.slot]) continue; const b = await getImageBlob(productId, def.slot); if (b) out.push({ ...def, mime: b.mime, data: b.data }); }
  return out;
}

// ───────────── AI plumbing ─────────────
function assertAi(deps) { if (!(deps.ai ?? isAiConfigured())) throw bad('الذكاء الاصطناعي مش متصل (مفتاح OpenAI غير متظبط).', 503, 'NOT_CONFIGURED'); }
export function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''); const a = t.search(/[{[]/); if (a < 0) throw bad('رد الذكاء الاصطناعي مش بالشكل المتوقع.', 502, 'AI_BAD_OUTPUT');
  try { return JSON.parse(t.slice(a)); } catch { const z = t.lastIndexOf('}'); try { return JSON.parse(t.slice(a, z + 1)); } catch { throw bad('رد الذكاء الاصطناعي مش بالشكل المتوقع.', 502, 'AI_BAD_OUTPUT'); } }
}
async function callAi(deps, args, failMessage) {
  try { return await (deps.generate || generateText)(args); }
  catch (e) { if (e instanceof StrategyError) throw e; throw bad(e.budgetBlocked ? e.message : `${failMessage}${e.errorType === 'NOT_CONFIGURED' ? ' — OpenAI غير متظبط.' : ' حاول تاني بعد شوية.'}`, e.budgetBlocked ? 429 : 502, e.budgetBlocked ? 'BUDGET' : 'AI_FAILED'); }
}

// ───────────── 1. analysis (3 photos together) ─────────────
export async function analyze(productId, { force = false, deps = {} } = {}) {
  productId = pid(productId); assertAi(deps);
  const state = await loadState(productId); const context = await getContext(productId, deps);
  const images = await loadImages(productId, state);
  if (!images.length) throw bad('ارفع صورة واحدة على الأقل للمنتج (الأفضل 3 صور).', 400, 'NO_IMAGES');
  const content = [{ type: 'text', text: PR.analysisUser({ context, slots: images }) }];
  for (const im of images) { content.push({ type: 'text', text: `IMAGE_${im.slot} — ${im.label}:` }); content.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data.toString('base64') } }); }
  const hash = crypto.createHash('sha256'); for (const im of images) hash.update(`${im.slot}:`).update(im.data);
  const out = await callAi(deps, { feature: 'amb_product_strategy_analysis', tier: TIERS.BALANCED, system: PR.ANALYSIS_SYSTEM, messages: [{ role: 'user', content }], maxTokens: 2500, jsonMode: true, cacheParts: { imgs: hash.digest('hex'), name: context.name, features: context.features, price: context.price }, promptVersion: PR.PROMPT_VERSION, force, productId }, 'تعذّر تحليل الصور حاليًا.');
  const analysis = SC.sanitizeAnalysis(parseJson(out.text), { imageCount: Math.max(...images.map((i) => i.slot)), storeFeatures: context.features });
  analysis.imageSlots = images.map((i) => i.slot); analysis.at = now(); analysis.cached = !!out.cached; analysis.stale = false;
  analysis.insufficient = !analysis.enough;
  return mutate(productId, (s) => { s.analysis = analysis; if (s.targeting) s.targeting.stale = true; if (s.posts) s.posts.stale = true; });
}

// ───────────── real buyer audience (existing segment intelligence) ─────────────
export async function realAudience(productId, deps = {}) {
  productId = pid(productId);
  if (productId < 0) { await draftOrThrow(productId); return { window: null, metaAvailable: false, metaUnavailableReason: 'منتج جديد مش موجود في سيستمك — مفيش بيانات مشترين فعلية.', gender: [], age: [], governorates: [], best: { gender: null, age: null, governorate: null }, topObserved: { gender: null, age: null, governorate: null }, audienceSignal: null, note: 'منتج جديد: مفيش Real Buyer Audience لأنه لسه ماتباعش عندك. استخدم الجمهور المقترح من AI كبداية وجرّبه.' }; }
  const product = await (deps.findProduct || ((id) => prisma.product.findUnique({ where: { id }, select: { id: true, store_id: true } })))(productId);
  if (!product) throw bad('المنتج مش موجود.', 404, 'NOT_FOUND');
  const settings = await (deps.settings || (async () => (await import('../settings.js')).getAmbSettings()))();
  const r = await (deps.segment || (async (a) => (await import('../segmentIntel.js')).segmentIntelForProduct(a)))({ productId, storeId: product.store_id, adAccountId: null, windowName: 'last30', settings });
  const top = (t, n = 6) => (t?.table || []).slice(0, n);
  return { window: r.window, metaAvailable: !!r.metaAvailable, metaUnavailableReason: r.metaUnavailableReason || null, gender: top(r.gender), age: top(r.age), governorates: top(r.governorates, 8), best: { gender: r.gender?.best || null, age: r.age?.best || null, governorate: r.governorates?.best || null }, topObserved: { gender: r.gender?.topObserved || null, age: r.age?.topObserved || null, governorate: r.governorates?.topObserved || null }, audienceSignal: r.audienceSignal || null,
    note: 'ده Real Buyer Audience: أرقام فعلية من توصيل Meta وأوردرات Easy Orders. مفيش اختراع لخصائص ديموغرافية — Meta بتكشف النوع والعمر للإعلان مش للأوردر نفسه.' };
}
const realSummary = (ra) => { if (!ra) return ''; const p = []; const g = ra.best?.gender || ra.topObserved?.gender; const a = ra.best?.age || ra.topObserved?.age; const gv = ra.best?.governorate || ra.topObserved?.governorate; if (g?.segment) p.push(`النوع: ${g.segment}`); if (a?.segment) p.push(`العمر: ${a.segment}`); if (gv?.segment) p.push(`المحافظة: ${gv.segment}`); return p.join(' | '); };

// ───────────── 2. targeting ─────────────
export async function buildTargeting(productId, { force = false, deps = {} } = {}) {
  productId = pid(productId); assertAi(deps);
  const state = await loadState(productId); const context = await getContext(productId, deps);
  if (!state.analysis) throw bad('حلّل المنتج الأول (رفع الصور وزر «تحليل المنتج»).', 400, 'NO_ANALYSIS');
  if (state.analysis.insufficient) throw bad('الصور وبيانات المنتج مش كفاية لتحليل مؤكد. ارفع صور أوضح أو ضيف مميزات للمنتج وحلّل تاني.', 422, 'INSUFFICIENT_DATA');
  let ra = null; try { ra = realSummary(await realAudience(productId, deps)); } catch { ra = ''; }
  const out = await callAi(deps, { feature: 'amb_product_strategy_targeting', tier: TIERS.BALANCED, system: PR.TARGETING_SYSTEM, messages: [{ role: 'user', content: PR.targetingUser({ context, analysis: state.analysis, realAudience: ra }) }], maxTokens: 3000, jsonMode: true, cacheParts: { a: state.analysis.at, ra }, promptVersion: PR.PROMPT_VERSION, force, productId }, 'تعذّر تجهيز استراتيجيات الاستهداف حاليًا.');
  const t = SC.sanitizeTargeting(parseJson(out.text));
  if (!t.ok) throw bad('الذكاء الاصطناعي مارجّعش استراتيجيات كاملة. جرّب تاني.', 502, 'AI_INCOMPLETE');
  const names = t.strategies.flatMap((s) => s.interests.map((i) => i.name));
  const v = await verifyInterests(names, deps.meta || {});
  const counts = {}; for (const s of t.strategies) for (const i of s.interests) { const r = v.results.get(i.name) || { status: 'UNAVAILABLE', match: null, alternatives: [] }; i.meta = r; counts[r.status] = (counts[r.status] || 0) + 1; }
  const targeting = { at: now(), strategies: t.strategies, verification: { available: v.available, reason: v.reason, counts, checkedAt: now() }, stale: false, cached: !!out.cached };
  return mutate(productId, (s) => { s.targeting = targeting; });
}

// ───────────── 3-6. posts ─────────────
const typeKeys = SC.POST_TYPES.map((p) => p.key);
function postCtx(context, commercial) { return { link: commercial.link, price: commercial.price, oldPrice: commercial.oldPrice, discountPercent: commercial.discountPercent, confirmed: commercial.confirmed, productName: context.name }; }
export const blocksOf = (audits) => audits.filter((w) => w.level === 'BLOCK');

async function writePosts({ productId, context, state, commercial, types, avoidHooks = [], instruction = '', feedback = [], force = false, deps }) {
  const out = await callAi(deps, {
    feature: 'amb_product_strategy_posts', tier: TIERS.BALANCED, system: PR.POSTS_SYSTEM,
    messages: [{ role: 'user', content: PR.postsUser({ context, analysis: state.analysis, strategies: state.targeting?.strategies, commercial, features: featuresFor(state.analysis), types, avoidHooks, instruction, feedback }) }],
    maxTokens: types.length > 1 ? 9000 : 3200, jsonMode: true,
    cacheParts: types.length > 1 && !instruction && !feedback.length ? { a: state.analysis.at, c: [commercial.price, commercial.oldPrice, commercial.confirmed, commercial.link], t: state.targeting?.at || null } : undefined,
    promptVersion: PR.PROMPT_VERSION, force, productId,
  }, 'تعذّر كتابة البوستات حاليًا.');
  const j = parseJson(out.text); const list = Array.isArray(j?.posts) ? j.posts : [];
  const byType = new Map(list.map((p, i) => [String(p?.type || typeKeys[i] || '').toUpperCase(), p]));
  const res = {}; for (const t of types) { const raw = byType.get(t) || (types.length === 1 ? list[0] : null); if (raw) res[t] = SC.sanitizePost(raw, t, { link: commercial.link }); }
  return res;
}
/** one retry for any post that still carries a BLOCK finding (an invented price, an unconfirmed shipping line …) — bounded to a single extra attempt per post. */
async function fixBlocked({ productId, context, state, commercial, posts, deps }) {
  const ctx = postCtx(context, commercial);
  for (const t of Object.keys(posts)) {
    const blocks = blocksOf(SC.auditPost(posts[t], ctx)); if (!blocks.length) continue;
    try { const retry = await writePosts({ productId, context, state, commercial, types: [t], feedback: blocks.map((b) => b.message), avoidHooks: Object.values(posts).filter((p) => p.type !== t).map((p) => p.hook), deps });
      if (retry[t] && blocksOf(SC.auditPost(retry[t], ctx)).length <= blocks.length) posts[t] = retry[t]; } catch (e) { logger.warn('PS_RETRY_FAILED', { type: t, message: e.message }); }
  }
  return posts;
}
const newItem = (post) => ({ ...post, status: 'DRAFT', versions: [], generatedAt: now(), editedAt: null, baseText: post.text, baseHeadline: post.headline });

export async function generatePosts(productId, { force = false, deps = {} } = {}) {
  productId = pid(productId); assertAi(deps);
  const state = await loadState(productId); const context = await getContext(productId, deps);
  if (!state.analysis) throw bad('حلّل المنتج الأول.', 400, 'NO_ANALYSIS');
  if (state.analysis.insufficient) throw bad('الصور وبيانات المنتج مش كفاية لتحليل مؤكد. ارفع صور أوضح أو ضيف مميزات وحلّل تاني.', 422, 'INSUFFICIENT_DATA');
  const commercial = effectiveCommercial(context, state);
  let posts = await writePosts({ productId, context, state, commercial, types: typeKeys, force, deps });
  posts = await fixBlocked({ productId, context, state, commercial, posts, deps });
  const missing = typeKeys.filter((t) => !posts[t]);
  if (missing.length === typeKeys.length) throw bad('الذكاء الاصطناعي مارجّعش بوستات. جرّب تاني.', 502, 'AI_INCOMPLETE');
  const items = {}; for (const t of typeKeys) if (posts[t]) items[t] = newItem(posts[t]);
  return mutate(productId, (s) => { s.posts = { at: now(), items, missing, stale: false }; });
}

export async function regeneratePost(productId, type, { instruction = '', deps = {} } = {}) {
  productId = pid(productId); assertAi(deps); type = String(type || '').toUpperCase();
  if (!typeKeys.includes(type)) throw bad('نوع البوست غير معروف.');
  const state = await loadState(productId); const context = await getContext(productId, deps);
  if (!state.analysis) throw bad('حلّل المنتج الأول.', 400, 'NO_ANALYSIS');
  const commercial = effectiveCommercial(context, state);
  const others = Object.values(state.posts?.items || {}).filter((p) => p.type !== type).map((p) => p.hook).filter(Boolean);
  let posts = await writePosts({ productId, context, state, commercial, types: [type], avoidHooks: others, instruction: String(instruction || '').slice(0, 300), force: true, deps });
  if (!posts[type]) throw bad('الذكاء الاصطناعي مارجّعش البوست. جرّب تاني.', 502, 'AI_INCOMPLETE');
  posts = await fixBlocked({ productId, context, state, commercial, posts, deps });
  return mutate(productId, (s) => {
    const prev = s.posts?.items?.[type]; const item = newItem(posts[type]);
    item.versions = prev ? [{ text: prev.text, headline: prev.headline, creative: prev.creative, at: now() }, ...(prev.versions || [])].slice(0, 3) : [];
    s.posts = { ...(s.posts || { at: now(), items: {}, missing: [] }), items: { ...(s.posts?.items || {}), [type]: item } };
  });
}

export async function savePost(productId, type, { text, headline, status }, { deps = {} } = {}) {
  productId = pid(productId); type = String(type || '').toUpperCase();
  const state = await loadState(productId); const item = state.posts?.items?.[type]; if (!item) throw bad('البوست مش موجود. اكتب البوستات الأول.', 404, 'NOT_FOUND');
  const next = { ...item };
  if (text !== undefined) { const t = String(text).replace(/\r/g, '').trim(); if (t.length < 50) throw bad('البوست قصير جدًا.'); if (t.length > 2600) throw bad('البوست طويل جدًا (أقصى 2600 حرف).'); next.text = t; next.hook = t.split('\n').map((l) => l.trim()).find(Boolean) || ''; }
  if (headline !== undefined) { const h = String(headline).replace(/\s+/g, ' ').trim(); if (h.length > 90) throw bad('الـHeadline طويل جدًا.'); next.headline = h; }
  const changed = next.text !== item.text || next.headline !== item.headline;
  const st = status !== undefined ? String(status).toUpperCase() : (changed ? 'EDITED' : item.status);
  if (!['DRAFT', 'EDITED', 'APPROVED'].includes(st)) throw bad('حالة غير صالحة.');
  if (st === 'APPROVED') {
    const context = await getContext(productId, deps); const audits = SC.auditPost(next, postCtx(context, effectiveCommercial(context, state)));
    const blocks = blocksOf(audits); if (blocks.length) throw bad(`مينفعش تعتمد البوست: ${blocks.map((b) => b.message).join(' — ')}`, 422, 'BLOCKED');
  }
  next.status = st === 'APPROVED' ? 'APPROVED' : (changed ? 'EDITED' : st); if (changed) next.editedAt = now();
  return mutate(productId, (s) => { s.posts.items[type] = next; });
}
export async function revertPost(productId, type) {
  productId = pid(productId); type = String(type || '').toUpperCase();
  return mutate(productId, (s) => { const it = s.posts?.items?.[type]; if (!it || !it.versions?.length) throw bad('مفيش نسخة سابقة.', 404, 'NO_VERSION'); const [prev, ...rest] = it.versions; s.posts.items[type] = { ...it, text: prev.text, headline: prev.headline, creative: prev.creative || it.creative, hook: String(prev.text).split('\n').map((l) => l.trim()).find(Boolean) || '', versions: rest, status: 'EDITED', editedAt: now() }; });
}


// ───────────── product page audit (speed + /100) ─────────────
export async function analyzePage(productId, { url, deps = {} } = {}) {
  productId = pid(productId);
  const state = await loadState(productId); const context = await getContext(productId, deps);
  const typed = url !== undefined && String(url).trim();
  const target = typed ? validLink(url) : effectiveCommercial(context, state).link;
  if (!target) throw bad('اكتب رابط صفحة المنتج الأول.', 400, 'NO_URL');
  const page = await (deps.audit || auditPage)(target);
  return mutate(productId, (s) => { s.page = page; if (typed) s.commercial.link = { value: target, at: now() }; if (s.interests) s.interests.pageChanged = true; });
}

// ───────────── 8 Meta interests (English, checked against Meta) ─────────────
const rankInterest = (status, alt) => (status === 'VERIFIED' ? 0 : alt ? 1 : status === 'SIMILAR' ? 2 : 3);
export async function buildInterests(productId, { force = false, deps = {} } = {}) {
  productId = pid(productId); assertAi(deps);
  const state = await loadState(productId); const context = await getContext(productId, deps);
  const out = await callAi(deps, { feature: 'amb_product_strategy_interests', tier: TIERS.BALANCED, system: IP.INTERESTS_SYSTEM, messages: [{ role: 'user', content: IP.interestsUser({ context, analysis: state.analysis, page: state.page?.facts }) }], maxTokens: 1800, jsonMode: true,
    cacheParts: { a: state.analysis?.at || null, p: state.page?.at || null, n: context.name, f: context.features }, promptVersion: IP.INTERESTS_VERSION, force, productId }, 'تعذّر تجهيز الاهتمامات حاليًا.');
  const j = parseJson(out.text); const raw = Array.isArray(j?.interests) ? j.interests : [];
  const seen = new Set(); const cands = [];
  for (const x of raw) { const name = SC.cleanInterestName(typeof x === 'string' ? x : x?.name); const k = name.toLowerCase(); if (!name || seen.has(k)) continue; seen.add(k); cands.push({ name, why: String((typeof x === 'string' ? '' : x?.why) || '').slice(0, 140) }); }
  if (cands.length < 3) throw bad('الذكاء الاصطناعي مارجّعش اهتمامات كفاية. جرّب تاني.', 502, 'AI_INCOMPLETE');
  const v = await verifyInterests(cands.map((c) => c.name), deps.meta || {});
  const used = new Set(); const items = [];
  for (const c of cands) {
    const r = v.results.get(c.name) || { status: 'UNAVAILABLE', match: null, alternatives: [] };
    let final = c.name; let alt = false; let meta = null;
    if (r.status === 'VERIFIED') meta = r.match; else if (r.status === 'SIMILAR' && r.alternatives?.[0]) { final = r.alternatives[0].name; alt = true; meta = r.alternatives[0]; }
    const key = final.toLowerCase(); if (used.has(key)) continue; used.add(key);
    items.push({ name: final, requested: alt ? c.name : null, why: c.why, status: alt ? 'VERIFIED' : r.status, alt, metaId: meta?.id || null, audienceLower: meta?.audienceLower ?? null, audienceUpper: meta?.audienceUpper ?? null, path: meta?.path || null, _rank: rankInterest(r.status, alt) });
  }
  const top = items.map((it, i) => ({ it, i })).sort((a, b) => a.it._rank - b.it._rank || a.i - b.i).slice(0, 8).map((x) => { const { _rank, ...rest } = x.it; return rest; });
  const verified = top.filter((x) => x.status === 'VERIFIED').length;
  const interests = { at: now(), items: top, verification: { available: v.available, reason: v.reason, verified, total: top.length, checkedAt: now() }, cached: !!out.cached, pageChanged: false };
  return mutate(productId, (s) => { s.interests = interests; });
}

// ───────────── settings the posts may rely on ─────────────
export async function saveCommercial(productId, { link, confirmed } = {}) {
  productId = pid(productId);
  return mutate(productId, (s) => {
    if (link !== undefined) { const v = validLink(link); s.commercial.link = v ? { value: v, at: now() } : null; }
    if (confirmed && typeof confirmed === 'object') for (const k of ['shipping', 'payment', 'discount']) if (typeof confirmed[k] === 'boolean') s.commercial.confirmed = { ...(s.commercial.confirmed || {}), [k]: confirmed[k] };
    if (s.posts) s.posts.stale = false; // the posts are re-audited live against the new facts; nothing to regenerate by itself
  });
}

// ───────────── what the screen reads ─────────────
export async function getView(productId, deps = {}) {
  productId = pid(productId);
  const state = await loadState(productId); const context = await getContext(productId, deps); const commercial = effectiveCommercial(context, state);
  const ctx = postCtx(context, commercial);
  let posts = null;
  if (state.posts?.items) {
    const ordered = typeKeys.map((t) => state.posts.items[t]).filter(Boolean);
    const sim = SC.similarHooks(ordered);
    posts = ordered.map((p) => { const audits = SC.auditPost(p, ctx); for (const [a, b] of sim) if (p.type === b) audits.push({ code: 'SIMILAR', level: 'WARN', message: `الهوك/الأسلوب قريب جدًا من بوست «${SC.POST_TYPES.find((x) => x.key === a)?.label}».` }); return { ...p, audits, blocked: blocksOf(audits).length > 0, versionsCount: (p.versions || []).length }; });
  }
  return {
    productId, aiConfigured: !!(deps.ai ?? isAiConfigured()), context, commercial,
    images: SC.IMAGE_SLOTS.map((d) => ({ ...d, uploaded: !!state.images[d.slot], bytes: state.images[d.slot]?.bytes || null, at: state.images[d.slot]?.at || null })),
    analysis: state.analysis, targeting: state.targeting, page: state.page || null, interests: state.interests || null, posts, postsMissing: state.posts?.missing || [], postsAt: state.posts?.at || null, stale: { analysis: !!state.analysis?.stale, targeting: !!state.targeting?.stale, posts: !!state.posts?.stale },
    constants: { postTypes: SC.POST_TYPES, strategies: SC.STRATEGIES, genders: SC.GENDER_AR, interestStatus: SC.INTEREST_STATUS_LABEL, maxImageMb: Math.round(SC.MAX_IMAGE_BYTES / 1048576) },
    updatedAt: state.updatedAt,
  };
}
