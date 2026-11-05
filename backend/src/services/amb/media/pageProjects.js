// AMB Media — PRODUCT PAGE projects: build a product page from A to Z (title, description, feature list, a chosen set of designed
// images and videos) for a store like Easy Orders, in the order the page shows them.
// A project is one JSON row in `settings` (id `pp:<id>`); its binary assets (reference photo, generated images, AI videos) are rows in
// `cf_blobs` (key `pp/<id>/<asset>`) — durable on Railway's ephemeral disk, no bucket needed. Nothing here writes to Meta or to the store:
// the finished page is EXPORTED (ZIP in page order + copy text) for the owner to publish.
import crypto from 'node:crypto';
import { prisma } from '../../../prisma.js';
import { generateText, TIERS, isAiConfigured, checkImageBudget, logImageUsage, estimateImageCostUsd } from '../../aiGateway/index.js';
import { getImageProvider } from '../../creativeFactory/imageProvider.js';
import { scanClaims } from '../../creativeFactory/claimsGuard.js';
import { MediaError } from './mediaJobs.js';
import { PAGE_TEMPLATES, PAGE_IMAGE_SIZE, buildTemplatePrompt } from './pageTemplates.js';
import { DEFAULT_STYLE, validStyle, styleRefsFor, PAGE_PACK } from './pageStyles.js';

const PREFIX = 'pp:';
export const MAX_IMAGES_PER_PROJECT = 24;
export const MAX_IMAGES_PER_BATCH = 8;
export const MAX_VIDEOS_PER_PROJECT = 10;
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
const MAX_REF_BYTES = 8 * 1024 * 1024;

const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const now = () => new Date().toISOString();
const rid = (p) => `${p}_${crypto.randomBytes(4).toString('hex')}`;
const bad = (m, code = 'BAD_INPUT') => new MediaError(m, code);
const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const strList = (v, n, max) => (Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean).slice(0, n);
const blobKey = (pid, asset) => `pp/${pid}/${asset}`;
export const validProjectId = (id) => /^[0-9a-f]{12}$/.test(String(id || ''));

// ---- per-project lock: the UI edits and a running job both read-modify-write the same JSON row
const locks = new Map();
export function withProject(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.then(fn);                       // the caller gets this one (and handles its rejection)
  const tail = next.then(() => {}, () => {});       // the queue must never reject, or the NEXT caller (and an unhandled rejection) would inherit the failure
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return next;
}

async function read(id) {
  if (!validProjectId(id)) return null;
  const row = await prisma.settings.findUnique({ where: { id: PREFIX + id } });
  return row ? parse(row.data) : null;
}
const write = (p) => { p.updatedAt = now(); const data = JSON.stringify(p); return prisma.settings.upsert({ where: { id: PREFIX + p.id }, create: { id: PREFIX + p.id, data }, update: { data } }); };

/** Read-modify-write under the lock. fn(project) may mutate and/or return a value; the project is saved after. */
async function mutate(id, fn) {
  return withProject(id, async () => {
    const p = await read(id);
    if (!p) throw bad('المشروع مش موجود.', 'NOT_FOUND');
    const out = await fn(p);
    await write(p);
    return out;
  });
}

// ---- projects
export async function createProject({ name, price = null, oldPrice = null, facts = [], eo = null, style = DEFAULT_STYLE }) {
  const n = str(name, 120);
  if (n.length < 2) throw bad('اكتب اسم المنتج.');
  const p = { id: crypto.randomBytes(6).toString('hex'), name: n, price: numOrNull(price), oldPrice: numOrNull(oldPrice), facts: strList(facts, 20, 200), style: validStyle(style), eo: eo ? sanitizeEo(eo) : null, reference: null, copy: null, images: [], videos: [], createdAt: now(), updatedAt: now() };
  await write(p);
  return p;
}
/** What we keep of the linked Easy Orders product (read-only facts shown on the page; image URLs are public CDN links we re-download server-side, never trusted from the browser). */
export function sanitizeEo(eo) {
  const imgs = (Array.isArray(eo.images) ? eo.images : []).filter((u) => typeof u === 'string' && /^https:\/\//i.test(u)).slice(0, 12);
  return { id: str(eo.id, 80), storeId: str(eo.storeId, 80) || null, slug: str(eo.slug, 120), name: str(eo.name, 160),
    categories: strList(eo.categories, 6, 60), quantity: Number.isFinite(Number(eo.quantity)) ? Number(eo.quantity) : null, trackStock: eo.trackStock === true, freeShipping: eo.freeShipping === true,
    images: imgs, syncedAt: eo.syncedAt || now() };
}
/** Refresh the linked-product info (and, when asked, the editable fields) from a fresh Easy Orders read. */
export function applyEoSync(id, detail, { overwrite = false } = {}) {
  return mutate(id, (p) => {
    if (!p.eo) throw bad('الصفحة دي مش مربوطة بمنتج من Easy Orders.');
    p.eo = sanitizeEo({ ...p.eo, ...detail, syncedAt: now() });
    if (overwrite) {
      if (detail.name) p.name = str(detail.name, 120);
      p.price = numOrNull(detail.price); p.oldPrice = numOrNull(detail.oldPrice);
      if (detail.facts?.length) p.facts = strList(detail.facts, 20, 200);
    }
    return { eo: p.eo, name: p.name, price: p.price, oldPrice: p.oldPrice, facts: p.facts };
  });
}
function numOrNull(v) { if (v === '' || v === null || v === undefined) return null; const x = Number(v); if (!Number.isFinite(x) || x < 0) throw bad('السعر غير صالح.'); return Math.round(x * 100) / 100; }

export async function getProject(id) { return read(id); }
/** Read-modify-write of one project under its lock — for the Smart Campaign journey, which keeps its own `smart` section on the same row. */
export const mutateProject = mutate;

export async function listProjects() {
  const rows = await prisma.settings.findMany({ where: { id: { startsWith: PREFIX } } });
  return rows.map((r) => parse(r.data)).filter((p) => p.id).map((p) => ({ id: p.id, name: p.name, images: (p.images || []).filter((i) => i.status === 'READY').length, videos: (p.videos || []).length, hasCopy: !!p.copy, hasRef: !!p.reference, eo: !!p.eo, storeId: p.eo?.storeId ?? null, published: !!p.smart?.publish, updatedAt: p.updatedAt })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function deleteProject(id) {
  if (!validProjectId(id)) throw bad('معرّف غير صالح.');
  await withProject(id, async () => {
    await prisma.cfBlob.deleteMany({ where: { key: { startsWith: `pp/${id}/` } } });
    await prisma.settings.deleteMany({ where: { id: PREFIX + id } });
  });
  return { ok: true };
}

export function updateProject(id, patch = {}) {
  return mutate(id, (p) => {
    if (patch.name !== undefined) { const n = str(patch.name, 120); if (n.length < 2) throw bad('اكتب اسم المنتج.'); p.name = n; }
    if (patch.price !== undefined) p.price = numOrNull(patch.price);
    if (patch.oldPrice !== undefined) p.oldPrice = numOrNull(patch.oldPrice);
    if (patch.facts !== undefined) p.facts = strList(patch.facts, 20, 200);
    if (patch.style !== undefined) p.style = validStyle(patch.style); // the design system the WHOLE page's images follow
    if (patch.supplierUrl !== undefined) { const u = str(patch.supplierUrl, 400); p.supplierUrl = /^https?:\/\//i.test(u) ? u : ''; }
    if (patch.unitCost !== undefined) p.unitCost = numOrNull(patch.unitCost);
    if (patch.smart && typeof patch.smart === 'object') p.smart = mergeSmart(p.smart, patch.smart);
    if (patch.copy && typeof patch.copy === 'object') p.copy = sanitizeCopy({ ...(p.copy || {}), ...patch.copy }, p);
    return p;
  });
}

const bool = (v) => v === true;
/** The page settings the journey keeps (applied to the store only when the owner confirms a store update). */
export function sanitizePageSettings(s = {}) {
  return { buyFromPage: bool(s.buyFromPage), skipCart: bool(s.skipCart), fixedBuy: bool(s.fixedBuy), freeShipping: bool(s.freeShipping), visitors: bool(s.visitors), buyText: str(s.buyText, 40) || 'اضغط هنا للشراء' };
}
/** The journey's own small settings: which caption goes to the campaign, how many page images, the page settings. Only these keys are ever taken from the client. */
export function mergeSmart(cur, patch) {
  const s = { ...(cur || {}) };
  if (patch.selectedCaption !== undefined) { const n = Math.round(Number(patch.selectedCaption)); s.selectedCaption = Number.isFinite(n) ? Math.min(3, Math.max(0, n)) : 0; }
  if (patch.imageCount !== undefined) { const n = Math.round(Number(patch.imageCount)); s.imageCount = Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 4; }
  if (patch.pageSettings && typeof patch.pageSettings === 'object') s.pageSettings = sanitizePageSettings(patch.pageSettings);
  if (patch.landingUrl !== undefined) { const u = str(patch.landingUrl, 400); s.landingUrl = /^https:\/\/[^\s]+$/i.test(u) ? u : ''; }
  return s;
}

/** Normalises copy edits from the UI and re-runs the deterministic claims scan (never trusts the client's issue list). */
export function sanitizeCopy(c, project) {
  const out = {
    title: str(c.title, 120), subtitle: str(c.subtitle, 160), paragraphs: strList(c.paragraphs, 4, 600), features: strList(c.features, 8, 40), pains: strList(c.pains, 4, 40), cta: str(c.cta, 40) || 'اطلبه دلوقتي',
    steps: (Array.isArray(c.steps) ? c.steps : []).map((s) => ({ title: str(s?.title, 40), text: str(s?.text, 80) })).filter((s) => s.title).slice(0, 3),
    headlines: {},
    captions: (Array.isArray(c.captions) ? c.captions : []).map((x) => ({ primary: str(x?.primary, 420), headline: str(x?.headline, 60) })).filter((x) => x.primary).slice(0, 4),
  };
  for (const id of Object.keys(PAGE_TEMPLATES)) { const h = c.headlines?.[id]; if (h && (h.headline || h.subtitle)) out.headlines[id] = { headline: str(h.headline, 80), subtitle: str(h.subtitle, 100) }; }
  out.claimIssues = claimIssues(out, project);
  return out;
}
export function claimIssues(copy, project) {
  const items = [{ field: 'title', text: copy.title }, { field: 'subtitle', text: copy.subtitle }, ...copy.paragraphs.map((t, i) => ({ field: `paragraph${i + 1}`, text: t })), ...copy.features.map((t, i) => ({ field: `feature${i + 1}`, text: t })), ...((copy.captions || []).map((x, i) => ({ field: `caption${i + 1}`, text: x.primary }))), ...(copy.pains || []).map((t, i) => ({ field: `pain${i + 1}`, text: t })), ...Object.entries(copy.headlines || {}).flatMap(([k, h]) => [{ field: `${k}.headline`, text: h.headline }, { field: `${k}.subtitle`, text: h.subtitle }])];
  return scanClaims({ items, product: { specifications: (project?.facts || []).join('\n'), benefits: (project?.facts || []).join('\n') } }).issues;
}

// ---- reference photo + blobs
export async function setReference(id, buffer, mime) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw bad('لا توجد بيانات صورة.');
  if (buffer.length > MAX_REF_BYTES) throw bad('الصورة أكبر من 8MB.');
  const m = /^image\/(png|jpeg|webp)$/.test(String(mime)) ? mime : null;
  if (!m) throw bad('الصورة لازم تكون JPG أو PNG أو WebP.');
  return mutate(id, async (p) => {
    await putBlob(id, 'ref', buffer, m);
    p.reference = { mime: m, bytes: buffer.length, at: now() };
    return p.reference;
  });
}
async function putBlob(pid, asset, buffer, mime) {
  const key = blobKey(pid, asset);
  await prisma.cfBlob.upsert({ where: { key }, create: { key, data: buffer, mime, bytes: buffer.length }, update: { data: buffer, mime, bytes: buffer.length } });
}
export async function getAsset(pid, asset) {
  if (!validProjectId(pid) || !/^(ref|img_[0-9a-f]{8}|vid_[0-9a-f]{8})$/.test(String(asset))) return null;
  const row = await prisma.cfBlob.findUnique({ where: { key: blobKey(pid, asset) } });
  return row ? { data: Buffer.from(row.data), mime: row.mime } : null;
}
export async function loadReference(pid) { const a = await getAsset(pid, 'ref'); return a ? { buffer: a.data, mime: a.mime } : null; }

// ---- image entries
export function addImages(id, items) {
  return mutate(id, (p) => {
    const list = Array.isArray(items) ? items.slice(0, MAX_IMAGES_PER_BATCH) : [];
    if (!list.length) throw bad('اختار قالب صورة واحد على الأقل.');
    if (p.images.length + list.length > MAX_IMAGES_PER_PROJECT) throw bad(`الحد الأقصى ${MAX_IMAGES_PER_PROJECT} صورة للصفحة.`);
    const added = list.map((it) => {
      const t = PAGE_TEMPLATES[it.template];
      if (!t) throw bad(`قالب غير معروف: ${it.template}`);
      const e = { id: rid('img'), template: it.template, headline: str(it.headline, 80), subtitle: str(it.subtitle, 100), labels: strList(it.labels, t.maxLabels ?? 6, 40), steps: (Array.isArray(it.steps) ? it.steps : []).map((s) => ({ title: str(s?.title, 40), text: str(s?.text, 80) })).filter((s) => s.title).slice(0, 3), cta: str(it.cta, 40), quality: ['low', 'medium', 'high'].includes(it.quality) ? it.quality : 'medium', status: 'QUEUED', error: null, textCheck: null, version: 0, createdAt: now(), updatedAt: now() };
      p.images.push(e); return e;
    });
    return added;
  });
}
/** The 5-image page pack (hero → problem → problem+solution → demonstration → final CTA): creates the entries; text comes from the AI copy unless edited. */
export function addPack(id, { quality = 'high' } = {}) {
  return addImages(id, PAGE_PACK.map((x) => ({ template: x.template, quality })));
}
export function updateImage(id, imgId, patch) {
  return mutate(id, (p) => {
    const e = p.images.find((x) => x.id === imgId); if (!e) throw bad('الصورة مش موجودة.', 'NOT_FOUND');
    const t = PAGE_TEMPLATES[e.template];
    if (patch.headline !== undefined) e.headline = str(patch.headline, 80);
    if (patch.subtitle !== undefined) e.subtitle = str(patch.subtitle, 100);
    if (patch.labels !== undefined) e.labels = strList(patch.labels, t.maxLabels ?? 6, 40);
    if (patch.cta !== undefined) e.cta = str(patch.cta, 40);
    if (patch.steps !== undefined) e.steps = (Array.isArray(patch.steps) ? patch.steps : []).map((s) => ({ title: str(s?.title, 40), text: str(s?.text, 80) })).filter((s) => s.title).slice(0, 3);
    if (['low', 'medium', 'high'].includes(patch.quality)) e.quality = patch.quality;
    e.updatedAt = now();
    return e;
  });
}
export function removeImage(id, imgId) {
  return mutate(id, async (p) => {
    const i = p.images.findIndex((x) => x.id === imgId); if (i < 0) throw bad('الصورة مش موجودة.', 'NOT_FOUND');
    p.images.splice(i, 1);
    await prisma.cfBlob.deleteMany({ where: { key: blobKey(id, imgId) } });
    return { ok: true };
  });
}
/** Reorder images by an id list (unknown ids ignored, missing ids keep their relative order at the end). */
export function reorderImages(id, order) {
  return mutate(id, (p) => {
    const pos = new Map((Array.isArray(order) ? order : []).map((x, i) => [String(x), i]));
    p.images.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e6) - (pos.has(b.id) ? pos.get(b.id) : 1e6));
    return p.images.map((i) => i.id);
  });
}

// ---- AI copy
const COPY_SYSTEM = 'أنت كاتب إعلانات لمتجر إلكتروني مصري. اكتب بالعامية المصرية البسيطة المحترمة. ممنوع تماماً: أي ادعاء طبي أو علاجي أو ضمان نتيجة، أي رقم أو نسبة أو مواصفة مش موجودة في المعلومات المعطاة، أي كلمة إنجليزية (غير أسماء مثل Bluetooth وUSB لو موجودة في المعلومات). العناوين قصيرة ومباشرة (٦ كلمات بالكتير). رجّع JSON فقط.';

export async function generateCopy(id, { deps = {} } = {}) {
  const p = await read(id); if (!p) throw bad('المشروع مش موجود.', 'NOT_FOUND');
  if (!(deps.ai ?? isAiConfigured())) throw new MediaError('الذكاء الاصطناعي مش متصل (مفتاح OpenAI).', 'NOT_CONFIGURED');
  const ref = await (deps.loadReference || loadReference)(id);
  const ids = Object.keys(PAGE_TEMPLATES);
  const user = `المنتج: ${p.name}\nالسعر: ${p.price ?? 'غير محدد'}${p.oldPrice ? ` (بدل ${p.oldPrice})` : ''}\nمعلومات ومميزات حقيقية عن المنتج:\n${(p.facts.length ? p.facts : ['(لا توجد معلومات — اكتب فقط اللي ظاهر في الصورة)']).map((f) => `- ${f}`).join('\n')}\n\nرجّع JSON بالشكل: {"captions":[{"primary":"كابشن إعلان (٢-٣ سطور حتى ٣٥٠ حرف، بيعرض المنتج بالمعلومات المعطاة بس، وينتهي بدعوة للطلب)","headline":"عنوان الإعلان حتى ٤٠ حرف"}] (٣ كابشنات مختلفة في الأسلوب), "title": "اسم/عنوان الصفحة", "subtitle": "جملة قصيرة تحت العنوان", "paragraphs": ["فقرة وصف ١ (حتى ٢٢٠ حرف)", "فقرة وصف ٢"], "features": ["ميزة من ١ لـ ٣ كلمات" × ٦], "pains": ["مشكلة يومية قصيرة بيعاني منها العميل (٢ لـ ٥ كلمات)" × ٣], "steps": [{"title":"خطوة","text":"جملة قصيرة"} × ٣], "cta": "نص زرار الطلب", "headlines": { ${ids.map((t) => `"${t}": {"headline":"...","subtitle":"..."}`).join(', ')} }}`;
  const content = [{ type: 'text', text: user }];
  if (ref) content.push({ type: 'image', source: { type: 'base64', media_type: ref.mime, data: ref.buffer.toString('base64') } });
  let j;
  try {
    const out = await (deps.generate || generateText)({ feature: 'amb_media_page_copy', tier: TIERS.BALANCED, system: COPY_SYSTEM, messages: [{ role: 'user', content }], maxTokens: 1800, jsonMode: true });
    j = JSON.parse(out.text);
  } catch (e) { throw new MediaError(e.budgetBlocked ? e.message : 'تعذّر كتابة المحتوى حاليًا — جرّب تاني.', 'COPY_FAILED'); }
  return mutate(id, (proj) => { proj.copy = sanitizeCopy(j, proj); return proj.copy; });
}

// ---- image generation + reading the text back
const norm = (s) => String(s || '').replace(/[ً-ٟـ]/g, '').replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const bigrams = (s) => { const a = new Set(); for (let i = 0; i < s.length - 1; i++) a.add(s.slice(i, i + 2)); return a; };
/** Pure: 0..1 similarity (Dice on character bigrams) between an expected text and the text found in the image; substring match counts as 1. */
export function textSimilarity(expected, seen) {
  const e = norm(expected), s = norm(seen);
  if (!e) return 1; if (!s) return 0; if (s.includes(e)) return 1;
  const a = bigrams(e), b = bigrams(s); if (!a.size) return e === s ? 1 : 0;
  let hit = 0; for (const g of a) if (b.has(g)) hit++;
  return hit / a.size; // how much of the EXPECTED text is present (the image may contain more words)
}
/** Pure: decide from the text read out of the image. Headline must be (nearly) exact; the rest on average. */
export function judgeText({ headline, others = [] }, seen) {
  const h = headline ? textSimilarity(headline, seen) : 1;
  const rest = others.filter(Boolean).map((t) => textSimilarity(t, seen));
  const avg = rest.length ? rest.reduce((a, b) => a + b, 0) / rest.length : 1;
  return { ok: h >= 0.85 && avg >= 0.7, headlineScore: Math.round(h * 100), otherScore: Math.round(avg * 100) };
}
async function readTextBack({ buffer, mime, deps }) {
  try {
    const out = await (deps.generate || generateText)({ feature: 'amb_media_page_text_check', tier: TIERS.BALANCED, messages: [{ role: 'user', content: [{ type: 'text', text: 'اقرأ كل النص العربي المكتوب على الصورة ده بالظبط كما هو (من غير تصحيح). رجّع JSON فقط: {"text":"كل النص مفصول بسطر جديد"}' }, { type: 'image', source: { type: 'base64', media_type: mime, data: buffer.toString('base64') } }] }], maxTokens: 500, jsonMode: true });
    return String(JSON.parse(out.text).text || '');
  } catch { return null; }
}

/** What the icon/chip cards say when the owner did not type them: pain points for the problem image, trust chips for the closing image, features everywhere else. */
function defaultLabels(template, cp, max) {
  if (template === 'problem') return (cp.pains || []).slice(0, max);
  if (template === 'final_cta') return ['الدفع عند الاستلام', 'توصيل سريع'].slice(0, max);
  return (cp.features || []).slice(0, max);
}

function entryContext(p, e) {
  const t = PAGE_TEMPLATES[e.template]; const cp = p.copy || {}; const h = cp.headlines?.[e.template] || {};
  return {
    name: p.name, style: validStyle(p.style),
    priceText: p.price != null ? `${p.price} جنيه` : '', oldPriceText: p.price != null && p.oldPrice ? `${p.oldPrice} جنيه` : '',
    headline: e.headline || h.headline || cp.title || p.name,
    subtitle: t.fields.includes('subtitle') ? (e.subtitle || h.subtitle || '') : '',
    labels: t.fields.includes('labels') ? (e.labels.length ? e.labels : defaultLabels(e.template, cp, t.maxLabels ?? 6)) : [],
    steps: t.fields.includes('steps') ? (e.steps.length ? e.steps : (cp.steps || [])) : [],
    cta: t.fields.includes('cta') ? (e.cta || cp.cta || 'اطلبه دلوقتي') : '',
  };
}

/** Generate the given image entries one by one (each success is saved immediately; one failure does not stop the rest). */
export async function runImageBatch({ projectId, imageIds, ctx, deps = {} }) {
  const ref = await (deps.loadReference || loadReference)(projectId);
  if (!ref) throw new MediaError('ارفع صورة المنتج الأول (القسم 1).', 'NO_PRODUCT_IMAGE');
  const provider = (deps.provider || getImageProvider)();
  if (provider.name === 'disabled') throw new MediaError('توليد الصور مش متصل: مفتاح OpenAI مش متظبط أو الرصيد خلص.', 'NOT_CONFIGURED');
  const budget = await (deps.checkBudget || checkImageBudget)();
  if (budget.blocked) throw new MediaError(`وصلت للحد الشهري لميزانية الذكاء الاصطناعي (${budget.spentUsd}$ من ${budget.budgetUsd}$).`, 'BUDGET');

  const ids = [...new Set(imageIds)].slice(0, MAX_IMAGES_PER_BATCH);
  const done = [], failed = [];
  for (let i = 0; i < ids.length; i++) {
    const imgId = ids[i];
    await ctx.progress((i / ids.length) * 95, `صورة ${i + 1} من ${ids.length}`);
    let proj = await read(projectId), e = proj?.images.find((x) => x.id === imgId);
    if (!e) { failed.push({ id: imgId, error: 'الصورة اتمسحت.' }); continue; }
    await mutate(projectId, (p) => { const x = p.images.find((y) => y.id === imgId); if (x) { x.status = 'GENERATING'; x.error = null; } });
    try {
      const styleRefs = (deps.styleRefs || styleRefsFor)(validStyle(proj.style), e.template);
      const prompt = buildTemplatePrompt(e.template, { ...entryContext(proj, e), styleRefCount: styleRefs.length });
      // image 1 = the real product (identity), images 2.. = style references only — the prompt says so
      const out = await provider.generate({ prompt, size: PAGE_IMAGE_SIZE, n: 1, quality: e.quality, referenceImages: [{ b64: ref.buffer.toString('base64'), mime: ref.mime }, ...styleRefs] });
      const img = out.images[0]; const buffer = Buffer.from(img.b64, 'base64'); const mime = img.mime || 'image/png';
      const usd = Number(await (deps.estimateCost || estimateImageCostUsd)({ size: PAGE_IMAGE_SIZE, count: 1 }).catch(() => 0)) || 0;
      ctx.cost('openai-image', usd, 1);
      Promise.resolve((deps.logUsage || logImageUsage)({ feature: 'amb_media_page_project_image', model: out.model, generationType: 'edit', imageCount: 1, size: PAGE_IMAGE_SIZE, status: 'SUCCESS', estimatedCostUsd: usd || null, durationMs: out.durationMs })).catch(() => {});
      const c = entryContext(proj, e);
      const seen = await readTextBack({ buffer, mime, deps });
      const textCheck = seen === null ? null : { ...judgeText({ headline: c.headline, others: [c.subtitle, c.cta, ...c.labels] }, seen), seen: seen.slice(0, 400) };
      await putBlob(projectId, imgId, buffer, mime);
      await mutate(projectId, (p) => { const x = p.images.find((y) => y.id === imgId); if (x) { x.status = 'READY'; x.error = null; x.textCheck = textCheck; x.version = (x.version || 0) + 1; x.updatedAt = now(); } });
      done.push(imgId);
    } catch (err) {
      const hard = err.code === 'PROVIDER_NOT_CONFIGURED' || err.httpStatus === 401 || err.httpStatus === 429;
      const message = err.httpStatus === 429 ? 'OpenAI: الرصيد خلص أو الحد وصل — اشحن وجرّب تاني.' : String(err.message || 'فشل التوليد.').slice(0, 300);
      await mutate(projectId, (p) => { const x = p.images.find((y) => y.id === imgId); if (x) { x.status = 'FAILED'; x.error = message; } }).catch(() => {});
      failed.push({ id: imgId, error: message });
      if (hard) { for (const rest of ids.slice(i + 1)) await mutate(projectId, (p) => { const x = p.images.find((y) => y.id === rest); if (x && x.status === 'QUEUED') { x.status = 'FAILED'; x.error = message; } }).catch(() => {}); break; }
    }
  }
  if (!done.length) throw new MediaError(failed[0]?.error || 'ما اتولّدتش أي صورة.', 'NO_IMAGES');
  return { done, failed };
}

// ---- videos
export function addVideoLink(id, { url, title = '', source = 'LINK' }) {
  return mutate(id, (p) => {
    let u; try { u = new URL(url); } catch { throw bad('اللينك غير صالح.'); }
    if (u.protocol !== 'https:') throw bad('اللينك لازم يكون https.');
    if (p.videos.length >= MAX_VIDEOS_PER_PROJECT) throw bad(`الحد الأقصى ${MAX_VIDEOS_PER_PROJECT} فيديو.`);
    if (p.videos.some((v) => v.url === u.toString())) throw bad('اللينك ده مضاف قبل كده.');
    const v = { id: rid('vid'), kind: 'LINK', url: u.toString(), title: str(title, 160), source: str(source, 20) || 'LINK', createdAt: now() };
    p.videos.push(v); return v;
  });
}
export function removeVideo(id, vidId) {
  return mutate(id, async (p) => {
    const i = p.videos.findIndex((x) => x.id === vidId); if (i < 0) throw bad('الفيديو مش موجود.', 'NOT_FOUND');
    p.videos.splice(i, 1); await prisma.cfBlob.deleteMany({ where: { key: blobKey(id, vidId) } }); return { ok: true };
  });
}
/** Store one AI video (bytes) in the project. */
export function addVideoFile(id, { buffer, seconds, style, prompt }) {
  return mutate(id, async (p) => {
    if (buffer.length > MAX_VIDEO_BYTES) throw bad('الفيديو الناتج أكبر من 40MB.');
    if (p.videos.length >= MAX_VIDEOS_PER_PROJECT) throw bad(`الحد الأقصى ${MAX_VIDEOS_PER_PROJECT} فيديو.`);
    const v = { id: rid('vid'), kind: 'AI', seconds, style, title: 'فيديو AI من صورة المنتج', prompt: str(prompt, 400), bytes: buffer.length, createdAt: now() };
    await putBlob(id, v.id, buffer, 'video/mp4');
    p.videos.push(v); return v;
  });
}

// ---- export: a plain STORE-only zip (no dependency), images in page order + copy.txt (+ AI videos)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function buildZip(files) { // files: [{ name, data: Buffer }]
  const locals = [], centrals = []; let offset = 0;
  const d = new Date(); const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1); const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), crc = crc32(f.data), size = f.data.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, f.data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(size, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + size;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function exportCopyText(p) {
  const c = p.copy || {};
  const lines = [`# ${c.title || p.name}`, c.subtitle || '', '', `السعر: ${p.price ?? '—'}${p.oldPrice ? ` (بدل ${p.oldPrice})` : ''}`, '', '## الوصف', ...(c.paragraphs || []), '', '## المميزات', ...(c.features || []).map((f) => `- ${f}`), ''];
  if ((p.videos || []).some((v) => v.kind === 'LINK')) lines.push('## فيديوهات (لينكات)', ...p.videos.filter((v) => v.kind === 'LINK').map((v) => `- ${v.title || v.source}: ${v.url}`), '');
  return lines.join('\n');
}

export async function exportZip(id) {
  const p = await read(id); if (!p) throw bad('المشروع مش موجود.', 'NOT_FOUND');
  const files = [];
  let n = 0;
  for (const e of p.images) {
    if (e.status !== 'READY') continue;
    const a = await getAsset(id, e.id); if (!a) continue;
    n++; files.push({ name: `${String(n).padStart(2, '0')}-${e.template}.${a.mime.includes('jpeg') ? 'jpg' : a.mime.includes('webp') ? 'webp' : 'png'}`, data: a.data });
  }
  let v = 0;
  for (const x of p.videos) { if (x.kind !== 'AI') continue; const a = await getAsset(id, x.id); if (a) { v++; files.push({ name: `video-${String(v).padStart(2, '0')}.mp4`, data: a.data }); } }
  files.push({ name: 'copy.txt', data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(exportCopyText(p), 'utf8')]) });
  if (files.length === 1) throw bad('مفيش صور جاهزة للتصدير.', 'EMPTY');
  return { zip: buildZip(files), name: `page-${p.id}.zip`, count: files.length };
}
