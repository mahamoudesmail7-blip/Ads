// «AI Smart Targeting» — the third audience choice of the launch wizard (next to «Broad» and «تخصيص الجمهور»).
// It analyses ONE product and proposes: gender, age range, the 5 best interests (each CHECKED against Meta's own interest search — an interest without a real Meta id is never proposed for applying),
// placements, locations, and the reason for each choice. READ ONLY: it reads the product, the product's REAL buyer audience (existing segment intelligence) and Meta's targeting search. Nothing is written anywhere.
// Where the proposal comes from, honestly labelled:
//   REAL_DATA  gender / age / governorates only when the product's own buyers prove a winner segment (the existing PROVEN rule — never a new threshold);
//   AI         the OpenAI gateway (product name, category, price, confirmed features) when it is configured and answers;
//   RULES      a fixed Egyptian-market rule table by product type when the AI is not available (credit / key / outage) — still verified against Meta, and the screen says so.
import { generateText, TIERS, isAiConfigured } from '../aiGateway/index.js';
import { getDecryptedToken } from '../metaAuth.js';
import { verifyInterests, searchAdInterest } from './productStrategy/metaInterests.js';
import { getContext, realAudience, parseJson } from './productStrategy/engine.js';
import { getProductMemory, recommendFromMemory, RULES as MEM_RULES } from './productMemory.js';
import { graphFetch } from '../metaGraphClient.js';
import { logger } from '../../logger.js';

export const SMART_VERSION = 'smart-targeting-2026-11-v1';
const MAX_INTERESTS = 5; const MIN_AUDIENCE_UPPER = 50_000;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
/** A slow dependency (live Meta breakdown, the memory, Meta suggestions) must never hang the whole proposal: after `ms` it counts as unavailable. */
const withTimeout = (p, ms, label) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`${label} took longer than ${ms / 1000}s`)), ms); Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); });
export const TIMEOUTS = { real: 20_000, memory: 25_000, related: 12_000, ai: 45_000, verify: 25_000 };
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const SENSITIVE = /(islam|muslim|christian|religio|quran|koran|bible|church|mosque|politic|election|cancer|diabet|disease|disorder|pregnan|lgbt|gay\b|lesbian|sexual|sex\b|debt|loan|bankrupt|ethnic|race\b)/i;

// ───────────── rule table (used when the AI is not available) ─────────────
// gender: MALE | FEMALE | ALL — ages inside Meta's 18..65 — interest names are candidates only: every one is verified against Meta before it can be proposed.
const RULES = [
  { key: 'beauty', re: /(تجميل|مكياج|ميك ?اب|بشره|بشرة|شعر|كريم|سيروم|عطر|برفان|ليزر|ازالة|إزالة|عناية|اظافر|أظافر|makeup|cosmetic|skin|hair|beauty|serum|perfume|nail)/i, gender: 'FEMALE', ageMin: 20, ageMax: 45, interests: ['Beauty', 'Cosmetics', 'Skin care', 'Hair care', 'Makeup', 'Online shopping'], why: 'منتج عناية وجمال — الشريحة الأكبر اللي بتشتريه نساء من 20 لـ 45.' },
  { key: 'kitchen', re: /(مطبخ|طبخ|قلاية|خلاط|مضرمة|سكين|حلل|حلة|فرن|ثلاجة|كيك|اواني|أواني|اطباق|أطباق|kitchen|cook|blender|fryer|knife|pan\b|oven)/i, gender: 'FEMALE', ageMin: 24, ageMax: 55, interests: ['Cooking', 'Kitchen', 'Home appliance', 'Home & garden', 'Baking', 'Online shopping'], why: 'أدوات مطبخ — القرار غالبًا عند ست البيت من 24 لـ 55.' },
  { key: 'home', re: /(بيت|منزل|ديكور|ستاير|سجاد|مفروشات|تنظيف|منظم|رف|اضاءة|إضاءة|home|decor|clean|organizer|furniture|lamp|curtain)/i, gender: 'FEMALE', ageMin: 24, ageMax: 55, interests: ['Home improvement', 'Interior design', 'Home & garden', 'Home decor', 'Cleaning', 'Online shopping'], why: 'منتج للبيت — الاهتمام الأقوى عند الأسر من 24 لـ 55.' },
  { key: 'baby', re: /(طفل|اطفال|أطفال|بيبي|رضيع|مولود|لعبة|العاب|ألعاب|baby|kid|child|toy|infant)/i, gender: 'FEMALE', ageMin: 22, ageMax: 40, interests: ['Parenting', 'Toys', 'Baby products', 'Motherhood', 'Online shopping'], why: 'منتج أطفال — اللي بيشتري غالبًا الأمهات من 22 لـ 40.' },
  { key: 'fashion', re: /(حذاء|جزمة|شنطة|حقيبة|ملابس|تيشيرت|بنطلون|فستان|حجاب|ساعة|نظارة|shoe|sneaker|bag\b|shirt|dress|watch|fashion|sunglass|wallet)/i, gender: 'ALL', ageMin: 18, ageMax: 45, interests: ['Fashion', 'Shopping', 'Clothing', 'Online shopping', 'Shoes', 'Accessories'], why: 'موضة وإكسسوارات — جمهور واسع من الجنسين من 18 لـ 45.' },
  { key: 'car', re: /(سيارة|سيارات|عربية|عربيات|كفر|اطار|إطار|موتوسيكل|car\b|auto|vehicle|motor|tire|dashcam)/i, gender: 'MALE', ageMin: 22, ageMax: 55, interests: ['Cars', 'Automobile', 'Auto accessories', 'Motorcycles', 'Online shopping'], why: 'إكسسوارات عربيات — الجمهور الأكبر رجال من 22 لـ 55.' },
  { key: 'tools', re: /(عدة|عدد|شنيور|مفك|مثقاب|ادوات|أدوات|صيانة|لحام|tool|drill|diy|repair|welding|screwdriver)/i, gender: 'MALE', ageMin: 24, ageMax: 55, interests: ['Do it yourself', 'Home improvement', 'Tools', 'Hardware', 'Online shopping'], why: 'أدوات وصيانة — الجمهور الأكبر رجال من 24 لـ 55.' },
  { key: 'fitness', re: /(رياضة|رياضي|جيم|لياقة|مساج|تخسيس|دمبل|gym|fitness|sport|massage|workout|yoga|protein)/i, gender: 'ALL', ageMin: 20, ageMax: 45, interests: ['Physical fitness', 'Gym', 'Sports', 'Weight training', 'Massage', 'Online shopping'], why: 'رياضة ولياقة — جمهور شاب من الجنسين من 20 لـ 45.' },
  { key: 'tech', re: /(موبايل|هاتف|شاحن|سماعة|ايفون|آيفون|كاميرا|راوتر|الكترونيات|إلكترونيات|gadget|phone|charger|earbud|headphone|camera|electronic|usb|bluetooth|smart)/i, gender: 'MALE', ageMin: 18, ageMax: 40, interests: ['Consumer electronics', 'Gadget', 'Technology', 'Mobile phone', 'Online shopping'], why: 'إلكترونيات وأجهزة — الجمهور الأكبر شباب من 18 لـ 40.' },
  { key: 'pets', re: /(قطة|قطط|كلب|كلاب|حيوان|pet\b|cat\b|dog\b|aquarium)/i, gender: 'ALL', ageMin: 20, ageMax: 50, interests: ['Pets', 'Cats', 'Dogs', 'Pet food', 'Online shopping'], why: 'منتجات حيوانات أليفة — جمهور واسع من 20 لـ 50.' },
  { key: 'fishing', re: /(صيد|سنارة|سمك|fishing|camping|خيمة|رحلات)/i, gender: 'MALE', ageMin: 22, ageMax: 55, interests: ['Fishing', 'Camping', 'Outdoor recreation', 'Hiking', 'Online shopping'], why: 'صيد ورحلات — الجمهور الأكبر رجال من 22 لـ 55.' },
];
const DEFAULT_RULE = { key: 'general', gender: 'ALL', ageMin: 20, ageMax: 50, interests: ['Online shopping', 'Shopping', 'Home & garden', 'Consumer electronics', 'Fashion'], why: 'منتج عام ومش واضح له فئة بعينها — الأفضل جمهور واسع من الجنسين من 20 لـ 50 وتسيب Meta تتعلّم.' };
export function ruleProfile(name, category) { const text = `${name || ''} ${category || ''}`; return RULES.find((r) => r.re.test(text)) || DEFAULT_RULE; }

// ───────────── pure helpers ─────────────
/** Meta age bracket → numbers: «25-34» → [25,34] · «65+» → [65,65]. */
export function parseAgeSegment(seg) { const m = /^(\d{2})\s*[-–]\s*(\d{2})$/.exec(clean(seg)); if (m) return [Number(m[1]), Number(m[2])]; const p = /^(\d{2})\s*\+$/.exec(clean(seg)); return p ? [Number(p[1]), 65] : null; }
export function genderOfSegment(seg) { const s = clean(seg); return s === 'رجال' ? 'MALE' : s === 'نساء' ? 'FEMALE' : null; }
export const GENDER_AR = { MALE: 'رجالي', FEMALE: 'حريمي', ALL: 'الاتنين' };
/** The final ≤5 interests: only ones Meta returned with a REAL id (exact match, or the closest Meta alternative of a similar name), sensitive categories removed, too-narrow audiences dropped, no duplicates. */
export function pickInterests(cands, verification, max = MAX_INTERESTS) {
  const used = new Set(); const items = [];
  cands.forEach((c, order) => {
    if (SENSITIVE.test(c.name)) return;
    const r = verification.results.get(c.name); if (!r) return;
    let meta = null; let requested = null;
    if (r.status === 'VERIFIED') meta = r.match; else if (r.status === 'SIMILAR' && r.alternatives?.[0]) { meta = r.alternatives[0]; requested = c.name; }
    if (!meta?.id || SENSITIVE.test(meta.name) || used.has(meta.id)) return;
    if (meta.audienceUpper != null && Number(meta.audienceUpper) < MIN_AUDIENCE_UPPER) return;
    used.add(meta.id); items.push({ id: String(meta.id), name: meta.name, requested, why: c.why || '', audienceLower: meta.audienceLower ?? null, audienceUpper: meta.audienceUpper ?? null, path: meta.path || null, exact: !requested, _rank: (requested ? 1 : 0) * 100 + order });
  });
  return items.sort((a, b) => a._rank - b._rank).slice(0, max).map(({ _rank, ...x }) => x);
}
export function sanitizeAi(raw, context) {
  const g = String(raw?.gender || '').toUpperCase(); const gender = ['MALE', 'FEMALE', 'ALL'].includes(g) ? g : null;
  let ageMin = Math.round(Number(raw?.ageMin)), ageMax = Math.round(Number(raw?.ageMax));
  if (!Number.isFinite(ageMin) || !Number.isFinite(ageMax)) { ageMin = null; ageMax = null; } else { ageMin = clamp(ageMin, 18, 65); ageMax = clamp(ageMax, 18, 65); if (ageMin > ageMax) [ageMin, ageMax] = [ageMax, ageMin]; if (ageMax - ageMin < 8) ageMax = Math.min(65, ageMin + 8); }
  const seen = new Set(); const interests = [];
  for (const x of Array.isArray(raw?.interests) ? raw.interests : []) { const name = clean(typeof x === 'string' ? x : x?.name).replace(/^#/, ''); const k = name.toLowerCase(); if (!name || name.length > 80 || seen.has(k) || SENSITIVE.test(name)) continue; seen.add(k); interests.push({ name, why: clean(typeof x === 'string' ? '' : x?.why).slice(0, 220) }); }
  return { gender, genderReason: clean(raw?.genderReason).slice(0, 260), ageMin, ageMax, ageReason: clean(raw?.ageReason).slice(0, 260), interests: interests.slice(0, 16), productKind: clean(raw?.productKind).slice(0, 80) };
}

// ───────────── AI ─────────────
const SYSTEM = `You are a senior Meta (Facebook/Instagram) media buyer targeting EGYPT. For ONE product, propose the audience that is most likely to buy it.
Rules:
- Use ONLY the product facts given (name, category, price, confirmed features, real buyer data when given). Never invent features.
- gender: "MALE", "FEMALE" or "ALL". Use ALL when the product is not clearly gendered, when it is a gift/home item, or when the evidence is unclear.
- age: ageMin and ageMax between 18 and 65, a realistic buying range for Egypt (at least 8 years wide). When REAL buyer data is given (share of purchases by age / gender), trust it over any general assumption.
- interests: 14 candidate Detailed-Targeting INTEREST names in ENGLISH, exactly as they appear in Meta Ads Manager (e.g. "Massage", "Home improvement", "Cooking", "Online shopping"). Short, common, real Meta interests. Most relevant first, and AT LEAST 4 of them must be specific to what the product DOES / is used for (e.g. for a massage roller: "Massage", "Body contouring"; not only broad ones like "Beauty" or "Shopping"). No brand names unless the product is that brand's accessory.
- NEVER suggest sensitive categories (religion, health conditions, politics, sexual orientation, ethnicity, finances/debt).
- Give each reason in short Egyptian Arabic tied to the product. No guarantees about performance.
Return JSON only: {"productKind":"short Arabic type of the product","gender":"MALE|FEMALE|ALL","genderReason":"...","ageMin":25,"ageMax":45,"ageReason":"...","interests":[{"name":"English interest","why":"..."}]}`;
function userPrompt(context, real) {
  const L = [`اسم المنتج: ${context.name}`, context.category ? `التصنيف: ${context.category}` : null, context.price != null ? `السعر: ${context.price} جنيه` : null, context.features?.length ? `مميزات مؤكدة:\n- ${context.features.slice(0, 10).join('\n- ')}` : null];
  if (real?.gender || real?.age) L.push(`بيانات مشترين حقيقية للمنتج: ${[real.gender && `النوع الأفضل: ${real.gender}`, real.age && `العمر الأفضل: ${real.age}`].filter(Boolean).join(' | ')}`);
  return `${L.filter(Boolean).join('\n')}\n\nرشّح الجمهور المناسب. JSON فقط.`;
}
async function askAi(context, real, deps, productId) {
  const ready = deps.ai ?? isAiConfigured(); if (!ready) { const e = new Error('الذكاء الاصطناعي مش متصل (مفتاح OpenAI غير متظبط).'); e.code = 'NOT_CONFIGURED'; throw e; }
  const out = await (deps.generate || generateText)({ feature: 'amb_smart_targeting', tier: TIERS.BALANCED, system: SYSTEM, messages: [{ role: 'user', content: userPrompt(context, real) }], maxTokens: 1800, jsonMode: true, cacheParts: { n: context.name, c: context.category, p: context.price, f: context.features, r: real || null }, promptVersion: SMART_VERSION, productId });
  return sanitizeAi(parseJson(out.text), context);
}

// ───────────── real buyer evidence ─────────────
// ───────────── real buyer evidence = the DISTRIBUTION of the product's purchases (volume), not one cheap bracket ─────────────
/** Meta age rows → brackets with numbers («25-34» → min 25 / max 34); «Unknown» and anything unparsable is left out. */
export function bracketsOf(rows) {
  const out = [];
  for (const r of rows || []) { const rg = parseAgeSegment(r?.segment); if (!rg) continue; out.push({ segment: clean(r.segment), min: rg[0], max: rg[1], purchases: Number(r.purchases) || 0, spend: Number(r.spend) || 0, cpa: r.cpa ?? null }); }
  return out.sort((a, b) => a.min - b.min);
}
/**
 * The narrowest run of neighbouring age brackets that holds at least `target` of ALL the purchases (and at least two brackets): start at the bracket with the most purchases and grow towards the neighbour with more purchases.
 * Volume decides, never a single bracket's CPA — a bracket with 3 purchases at a low CPA cannot become «the age».
 */
export function coverageRange(brackets, target = 0.85, minBrackets = 2) {
  const total = (brackets || []).reduce((s, b) => s + b.purchases, 0); if (!brackets?.length || total <= 0) return null;
  let top = 0; brackets.forEach((b, i) => { if (b.purchases > brackets[top].purchases) top = i; });
  let lo = top, hi = top, got = brackets[top].purchases;
  while ((got / total < target || hi - lo + 1 < minBrackets) && (lo > 0 || hi < brackets.length - 1)) {
    const left = lo > 0 ? brackets[lo - 1].purchases : -1; const right = hi < brackets.length - 1 ? brackets[hi + 1].purchases : -1;
    if (left >= right && lo > 0) { lo -= 1; got += brackets[lo].purchases; } else { hi += 1; got += brackets[hi].purchases; }
  }
  const inc = brackets.slice(lo, hi + 1);
  return { min: Math.max(18, inc[0].min), max: Math.min(65, inc[inc.length - 1].max), coverage: got / total, total, included: inc.map((b) => b.segment) };
}
/** Share of purchases by gender (known genders only). One gender needs ≥ 70% of at least 30 purchases to count; a real split is «الاتنين». */
export function genderDistribution(rows) {
  let male = 0, female = 0; for (const r of rows || []) { const g = genderOfSegment(r?.segment); if (g === 'MALE') male += Number(r.purchases) || 0; else if (g === 'FEMALE') female += Number(r.purchases) || 0; }
  const total = male + female; if (!total) return null; const mp = male / total, fp = female / total;
  const value = total < 30 ? null : mp >= 0.7 ? 'MALE' : fp >= 0.7 ? 'FEMALE' : 'ALL';
  return { total, male, female, malePct: Math.round(mp * 1000) / 10, femalePct: Math.round(fp * 1000) / 10, value };
}
async function realEvidence(productId, deps) {
  try {
    const ra = await withTimeout((deps.real || ((id) => realAudience(id, deps.realDeps || {}, 'last90')))(productId), deps.timeouts?.real ?? TIMEOUTS.real, 'real audience'); if (!ra) return null;
    const ageRows = bracketsOf(ra.age); const ageDist = coverageRange(ageRows); const genderDist = genderDistribution(ra.gender);
    const govs = (ra.best?.governorate?.segment && Array.isArray(ra.governorates)) ? ra.governorates.filter((r) => (r.orders || 0) > 0).slice(0, 3).map((r) => r.segment) : [];
    return { ageRows, ageDist, genderDist, governorates: govs, windowName: ra.window?.name || null, windowLabel: ra.window?.label || null, raw: ra };
  } catch (e) { logger.warn('[smartTargeting] real audience unavailable', { message: e.message }); return null; }
}
async function resolveRegions(names, deps) {
  const out = []; const search = deps.geoSearch || (async (q) => (await import('./launchBuilder.js')).searchLaunchGeoLocations(q));
  for (const n of names) { try { const list = await search(n); const hit = (list || []).find((r) => clean(r.name).toLowerCase() === clean(n).toLowerCase()) || (list || [])[0]; if (hit?.key && !out.some((o) => o.key === hit.key)) out.push({ key: String(hit.key), name: hit.name || n }); } catch { /* skip this governorate */ } }
  return out;
}

/**
 * @param {{ productId: number, deps?: object }} p   deps (tests): ai, generate, real, meta, geoSearch, getContext
 */
// ───────────── memory helpers ─────────────
/** What this product's OWN tests proved about gender / age: only a WIN with a real sample (not «small sample») counts, and the range is exactly the one that was tested. */
export function historyEvidence(m) {
  const wins = (m?.adSets || []).filter((x) => x.verdict === 'WIN' && x.confidence !== 'LOW' && x.targeting).sort((x, y) => x.cpa - y.cpa); const out = { gender: null, age: null };
  const g = wins.find((x) => x.targeting.genders !== 'ALL'); if (g) out.gender = { value: g.targeting.genders, text: `الجنس ${GENDER_AR[g.targeting.genders]} كسب في تيست حقيقي: «${g.name}» CPA ${g.cpa} ج بعد ${g.purchases} مشتريات.` };
  const a = wins.find((x) => x.targeting.ageMin > 18 || x.targeting.ageMax < 65); if (a) { const label = `${a.targeting.ageMin}–${a.targeting.ageMax}`; out.age = { min: a.targeting.ageMin, max: a.targeting.ageMax, label, text: `السن ${label} كسب في تيست حقيقي: «${a.name}» CPA ${a.cpa} ج بعد ${a.purchases} مشتريات — وهو متوافق مع العمر المعتاد للمنتج.` }; }
  return out;
}
export function demographicsOf(ra) { return { window: ra.window?.name || null, gender: ra.gender || [], age: ra.age || [], governorates: (ra.governorates || []).slice(0, 10), best: { gender: ra.best?.gender?.segment || null, age: ra.best?.age?.segment || null, governorate: ra.best?.governorate?.segment || null }, note: ra.note || null }; }
/** The memory as the screen needs it (the full ad-set list stays on the server). */
export function trimMemory(m) {
  return { hasHistory: m.hasHistory, tests: m.tests, baseline: m.baseline ?? null, windows: m.windows, audienceTypes: m.audienceTypes, learnings: m.learnings, summary: m.summary, limits: m.limits, journal: m.journal, demographics: m.demographics || null, smartTests: m.smartTests,
    adSets: (m.adSets || []).slice(0, 8).map((x) => ({ id: x.id, name: x.name, type: x.type, verdict: x.verdict, confidence: x.confidence, spend: x.spend, purchases: x.purchases, cpa: x.cpa, smart: x.smart, why: x.why })), interestsTested: (m.interests || []).length };
}
/** Meta's own «related interests» for some interests (read only) — real ids, sensitive / tiny audiences dropped. */
export async function relatedInterests(names, deps = {}) {
  const token = await (deps.getToken || getDecryptedToken)();
  const data = await (deps.suggest || ((t, n) => graphFetch('/search', { type: 'adinterestsuggestion', interest_list: JSON.stringify(n.slice(0, 5)), limit: 15, locale: 'en_US' }, t)))(token, names);
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return list.filter((r) => r?.id && r?.name && !SENSITIVE.test(r.name) && !(r.audience_size_upper_bound != null && Number(r.audience_size_upper_bound) < MIN_AUDIENCE_UPPER)).map((r) => ({ id: String(r.id), name: String(r.name), audienceLower: r.audience_size_lower_bound ?? null, audienceUpper: r.audience_size_upper_bound ?? null, path: Array.isArray(r.path) ? r.path.join(' › ') : (r.topic || null) }));
}


export async function suggestSmartTargeting({ productId, deps = {} }) {
  const id = Number(productId); if (!Number.isInteger(id) || id <= 0) { const e = new Error('اختار منتج الأول.'); e.status = 400; throw e; }
  const context = await (deps.getContext || getContext)(id, deps.ctxDeps || {});
  const real = await realEvidence(id, deps);
  // the product's MEMORY: every past test of THIS product (its own campaigns only), judged on real numbers — empty for a new product. If it is slow or fails, the proposal still comes (exploratory) and says so.
  let memory = null; let memoryNote = null; try { memory = await withTimeout((deps.memory || ((pid) => getProductMemory(pid, { persist: true })))(id), deps.timeouts?.memory ?? TIMEOUTS.memory, 'product memory'); } catch (e) { memoryNote = 'ذاكرة المنتج مقدرتش تتحمّل دلوقتي (' + (/took longer/.test(e.message) ? 'اتأخرت' : 'عطل مؤقت') + ') — الاقتراح ده بدونها. اضغط «إعادة التحليل» تاني بعد شوية.'; logger.warn('[smartTargeting] memory unavailable', { message: e.message }); }
  const hasHistory = !!memory?.hasHistory; const rec = hasHistory ? recommendFromMemory(memory) : null; const hist = hasHistory ? historyEvidence(memory) : null;
  if (hasHistory && real?.raw) memory.demographics = demographicsOf(real.raw);
  const alternatives = {}; // proposals the owner can switch to with one click (e.g. the age of his own sales when it disagrees with the usual age of the product)
  const sources = { gender: null, age: null, interests: null }; const reasons = { gender: '', age: '', interests: '', locations: '', placements: '' }; const notes = [];
  let ai = null; let aiError = null;
  try { ai = await withTimeout(askAi(context, real ? { gender: real.genderDist?.value ? GENDER_AR[real.genderDist.value] : null, age: real.ageDist && real.ageDist.total >= 30 ? `${real.ageDist.min}-${real.ageDist.max} (${Math.round(real.ageDist.coverage * 100)}% من ${real.ageDist.total} مشترى)` : null } : null, deps, id), deps.timeouts?.ai ?? TIMEOUTS.ai, 'AI'); } catch (e) { aiError = e.code === 'NOT_CONFIGURED' ? e.message : 'الذكاء الاصطناعي مش متاح دلوقتي (رصيد/مفتاح/عطل مؤقت).'; logger.warn('[smartTargeting] AI unavailable', { message: e.message }); }
  const rule = ruleProfile(context.name, context.category);

  // gender: a gender that WON in this product's own tests > the product's proven buyer segment > AI > rules
  let gender; let ageMin; let ageMax;
  const gd = real?.genderDist;
  if (hist?.gender) { gender = hist.gender.value; sources.gender = 'HISTORY'; reasons.gender = hist.gender.text; }
  else if (gd?.value) { gender = gd.value; sources.gender = 'REAL_DATA'; reasons.gender = gd.value === 'ALL' ? `مشترياتك الفعلية (${gd.total} مشترى) متقسمة: رجال ${gd.malePct}% · نساء ${gd.femalePct}% — مفيش نوع غالب بوضوح، فالأنسب الاتنين.` : `مشترياتك الفعلية (${gd.total} مشترى): ${gd.value === 'MALE' ? 'رجال' : 'نساء'} ${gd.value === 'MALE' ? gd.malePct : gd.femalePct}% من المشتريات.`; }
  else if (ai?.gender) { gender = ai.gender; sources.gender = 'AI'; reasons.gender = ai.genderReason || `الذكاء الاصطناعي رشّح ${GENDER_AR[gender]} للمنتج ده.`; }
  else { gender = rule.gender; sources.gender = 'RULES'; reasons.gender = rule.why; }
  // age: the usual age of this kind of product (AI, else the rule table) is the PRIOR. Evidence (an age range that WON in this product's own tests, then the product's best Meta age bracket) only overrides it when it AGREES with it
  // (overlaps at least half) — a single Meta bracket can just be the cheapest place Meta delivered (e.g. 55-64 on a Broad campaign), not the real buyer. When it disagrees the prior stays, the screen says why and offers it in one click.
  const prior = ai?.ageMin != null ? { min: ai.ageMin, max: ai.ageMax, src: 'AI', reason: ai.ageReason || 'نطاق عمر مرشّح من الذكاء الاصطناعي حسب نوع المنتج.' } : { min: rule.ageMin, max: rule.ageMax, src: 'RULES', reason: rule.why };
  ageMin = prior.min; ageMax = prior.max; sources.age = prior.src; reasons.age = prior.reason;
  const ad = real?.ageDist; const evidence = [];
  const pct = (x) => Math.round(x * 100);
  const strongAge = ad && ad.total >= 30; const weakAge = ad && ad.total >= 15 && ad.total < 30;
  const above = strongAge ? (real.ageRows || []).filter((b) => b.min > ad.max).reduce((s, b) => s + b.purchases, 0) : 0;
  if (strongAge) { // a real sample of purchases decides — it overrides the general (AI / rules) assumption
    ageMin = ad.min; ageMax = ad.max; sources.age = 'REAL_DATA';
    reasons.age = `مشترياتك الفعلية (${real.windowLabel || 'آخر 90 يوم'} · ${ad.total} مشترى): ${pct(ad.coverage)}% اتشتروا من سن ${ad.min}–${ad.max} (الشرايح ${ad.included.join('، ')})${above ? ` — وفوق ${ad.max} ${pct(above / ad.total)}% بس` : ''}. ${ad.min === prior.min && ad.max === prior.max ? '' : `العمر المعتاد للمنتج كان ${prior.min}–${prior.max} لكن أرقامك أقوى.`}`;
  } else {
    if (hist?.age) evidence.push({ min: hist.age.min, max: hist.age.max, src: 'HISTORY', label: hist.age.label, agree: hist.age.text, segment: hist.age.label });
    if (weakAge) evidence.push({ min: ad.min, max: ad.max, src: 'REAL_DATA', label: `${ad.min}–${ad.max}`, agree: `مشترياتك الفعلية (${ad.total} مشترى بس — عينة صغيرة): ${pct(ad.coverage)}% من سن ${ad.min}–${ad.max}، وده متوافق مع العمر المعتاد للمنتج (${prior.min}–${prior.max}).`, segment: `${ad.min}–${ad.max}` });
    let usedAge = false;
    for (const ev of evidence) {
      const overlap = Math.max(0, Math.min(ev.max, prior.max) - Math.max(ev.min, prior.min)); const ratio = overlap / Math.max(1, Math.min(ev.max - ev.min, prior.max - prior.min));
      if (!usedAge && ratio >= 0.5) { ageMin = ev.min; ageMax = ev.max; sources.age = ev.src; reasons.age = ev.agree; usedAge = true; }
      else if (!usedAge && ratio < 0.5 && !alternatives.age) { alternatives.age = { ageMin: ev.min, ageMax: ev.max, segment: ev.segment }; notes.push(`بيانات ${ev.src === 'HISTORY' ? 'تيستات المنتج' : 'مبيعاتك (عينة صغيرة)'} بتقول سن ${ev.segment} — بس ده بعيد عن العمر المعتاد للمنتج ده (${prior.min}–${prior.max}) والعينة لسه صغيرة، فاستخدمت العمر المعتاد. لو عايز سن ${ev.src === 'HISTORY' ? 'التيستات' : 'مبيعاتك'} اضغط الزرار تحت السن.`); }
    }
  }

  // interests: (1) the audience that WON before (as a set — never credited to one interest), (2) new interests Meta says are close to it, (3) verified candidates from the AI / rule table — each one a real Meta id
  const cands = ai?.interests?.length >= 3 ? ai.interests : rule.interests.map((name) => ({ name, why: rule.why }));
  sources.interests = ai?.interests?.length >= 3 ? 'AI' : 'RULES';
  const avoidIds = new Set((rec?.avoid || []).map((x) => x.id)); const testedIds = new Set((memory?.interests || []).map((x) => x.id));
  let verification; try { verification = await withTimeout(verifyInterests(cands.map((c) => c.name), deps.meta || {}), deps.timeouts?.verify ?? TIMEOUTS.verify, 'Meta interest check'); } catch (e) { verification = { results: new Map(), available: false, reason: 'Meta اتأخرت في الرد' }; logger.warn('[smartTargeting] interest verification failed', { message: e.message }); }
  let priorPicks = pickInterests(cands.filter((c) => true), verification, 12).filter((i) => !avoidIds.has(i.id)).map((i) => ({ ...i, origin: 'PRIOR' }));
  if (hasHistory) { const fresh = priorPicks.filter((i) => !testedIds.has(i.id)); priorPicks = fresh.length >= 2 ? fresh : priorPicks; } // a new test explores what was NOT tried yet
  const proven = [];
  const winSet = rec?.proven?.[0]; if (winSet) for (const i of winSet.targeting.interests.slice(0, 3)) if (!avoidIds.has(i.id)) proven.push({ id: i.id, name: i.name, requested: null, why: `من الجمهور اللي نجح قبل كده: «${winSet.name}» (CPA ${winSet.cpa} ج بعد ${winSet.purchases} مشتريات) — النتيجة للمجموعة كلها مش للاهتمام ده لوحده.`, audienceLower: null, audienceUpper: null, path: null, exact: true, origin: 'PROVEN' });
  let related = [];
  if (hasHistory && (proven.length || testedIds.size)) {
    const seeds = proven.length ? proven.map((p) => p.name) : (memory.interests || []).filter((x) => x.verdict !== 'LOSS').slice(0, 3).map((x) => x.name);
    if (seeds.length) { try { related = (await withTimeout((deps.related || relatedInterests)(seeds, deps.meta || {}), deps.timeouts?.related ?? TIMEOUTS.related, 'related interests')).filter((x) => !testedIds.has(x.id) && !avoidIds.has(x.id)).slice(0, 3).map((x) => ({ ...x, requested: null, exact: true, origin: 'NEW_RELATED', why: `اهتمام قريب من اللي جرّبته (${seeds.join('، ')}) — Meta بتقترحه وملهوش تجربة قبل كده في المنتج ده.` })); } catch (e) { logger.warn('[smartTargeting] related interests unavailable', { message: e.message }); } }
  }
  const seenIds = new Set(); const interests = [];
  for (const i of [...proven, ...related.slice(0, 2), ...priorPicks, ...related.slice(2)]) { if (seenIds.has(i.id) || interests.length >= MAX_INTERESTS) continue; seenIds.add(i.id); interests.push(i); }
  const unverified = verification.available ? [] : cands.slice(0, MAX_INTERESTS).map((c) => c.name);
  if (!verification.available && !proven.length) notes.push('مش قادر أتأكد من الاهتمامات على Meta دلوقتي (' + (verification.reason || 'Meta مش متصل') + ') — مش هقترح اهتمامات غير متحقق منها. اربط Meta أو جرّب تاني.');
  else if (interests.length < MAX_INTERESTS) notes.push(`لقيت ${interests.length} اهتمام متحقق منهم في Meta بس — تقدر تضيف باقي الخمسة بنفسك من البحث.`);
  reasons.interests = interests.length ? (hasHistory ? 'الاهتمامات مرتّبة: اللي نجح قبل كده، وبعدها اهتمامات قريبة جديدة، وبعدها اقتراحات المنتج — وكلها ليها ID حقيقي من Meta.' : 'الاهتمامات دي اتشافت واحدة واحدة في بحث Meta نفسه (ليها ID حقيقي وحجم جمهور)، ومرتبطة بنوع المنتج.') : '';

  // locations: only a PROVEN governorate winner earns a restriction — otherwise Egypt-wide (the system's usual, safest choice)
  let locations = { mode: 'EGYPT', regions: [], reason: 'مفيش دليل كفاية في مبيعاتك على محافظات بعينها — الأفضل مصر كلها وMeta توزّع. تقدر تحدد محافظات من الكوكب بنفسك.' };
  if (real?.governorates?.length) { const regions = await resolveRegions(real.governorates, deps); if (regions.length) locations = { mode: 'REGIONS', regions, reason: `أقوى المحافظات في أوردراتك الفعلية: ${regions.map((r) => r.name).join('، ')}.` }; }
  const placements = { mode: 'AUTOMATIC', reason: 'المواضع التلقائية (Advantage+) بتسيب Meta تجيب أرخص نتيجة — الأفضل كبداية. تقدر تحصرها في الفيد بس لو عايز.' };
  const advantage = { mode: 'RESTRICT', text: 'الجمهور بيتبعت لـ Meta كتقييد فعلي (Advantage audience مقفول): Meta هتلتزم بالسن والنوع والاهتمامات اللي اخترتها ومش هتوسّعها. لو فتحت Advantage+ بيبقوا مجرد اقتراح وMeta ممكن توسّع برا حدودك.' };
  if (memoryNote) notes.push(memoryNote);
  if (!hasHistory && !memoryNote) notes.push('المنتج ده جديد على السيستم (مفيش حملات سابقة مسجّلة ليه)، فالاقتراح مبني على فهم المنتج مش على نتايج حملات.');
  else if (sources.gender !== 'HISTORY' && sources.gender !== 'REAL_DATA' && sources.age !== 'HISTORY' && sources.age !== 'REAL_DATA') notes.push('اتعمله حملات قبل كده بس لسه مفيش شريحة سن/نوع مثبتة بعينة كافية، فالنوع والسن اقتراح مبدئي.');

  const base = ai ? 'AI' : 'RULES';
  const source = hasHistory ? `HISTORY+${base}` : (sources.gender === 'REAL_DATA' || sources.age === 'REAL_DATA') ? `REAL_DATA+${base}` : base;
  const evidenceOut = real && (real.ageDist || real.genderDist) ? { source: 'META_BREAKDOWN', window: real.windowLabel || real.windowName || null, age: real.ageDist ? { total: real.ageDist.total, coverage: Math.round(real.ageDist.coverage * 1000) / 10, range: { min: real.ageDist.min, max: real.ageDist.max }, used: sources.age === 'REAL_DATA', rows: (real.ageRows || []).map((b) => ({ segment: b.segment, purchases: b.purchases, share: real.ageDist.total ? Math.round(b.purchases / real.ageDist.total * 1000) / 10 : null, spend: Math.round(b.spend), cpa: b.cpa != null ? Math.round(b.cpa) : null, included: real.ageDist.included.includes(b.segment) })) } : null, gender: real.genderDist || null } : null;
  if (aiError) notes.push(`${aiError} — استخدمت قواعد السوق المصري بدل الذكاء الاصطناعي (والاهتمامات لسه متحقق منها من Meta).`);
  const strategy = rec ? rec.strategy : { mode: 'EXPLORE', reason: 'منتج جديد: ابدأ باستهداف استكشافي (الاقتراح ده) وخلّي السيستم يتعلم من نتيجته.', confidence: 'LOW' };
  const adSetsPlan = rec ? rec.adSetsPlan : [{ type: 'INTERESTS', label: 'اهتمامات استكشافية', note: 'أول تجربة للمنتج.' }, { type: 'BROAD', label: 'Ad Set واسع (Broad) للمقارنة', note: 'عشان بعد النتايج تعرف الاهتمامات فرقت ولا لأ.' }];
  const w90 = memory?.windows?.w90?.purchases || 0;
  const confidence = !hasHistory ? { level: 'LOW', text: 'منخفضة — منتج جديد، مبني على فهم المنتج فقط.' } : (w90 >= MEM_RULES.highPurchases && strategy.confidence !== 'LOW') ? { level: 'HIGH', text: `عالية — ${w90} مشتريات في 90 يوم.` } : (w90 >= MEM_RULES.mediumPurchases) ? { level: 'MEDIUM', text: `متوسطة — ${w90} مشتريات في 90 يوم.` } : { level: 'LOW', text: `منخفضة — ${w90} مشتريات بس في 90 يوم، البيانات لسه قليلة.` };
  return {
    ok: true, version: SMART_VERSION, at: new Date().toISOString(), basis: hasHistory ? 'HISTORY' : 'EXPLORATORY', source, sources, aiError, product: { id: id, name: context.name, category: context.category || null, price: context.price ?? null, kind: ai?.productKind || null },
    gender, genderLabel: GENDER_AR[gender], ageMin, ageMax, alternatives, evidence: evidenceOut, interests, unverified, placements, locations, reasons, notes, advantage, strategy, adSetsPlan, confidence,
    memory: memory ? trimMemory(memory) : null,
    verification: { available: verification.available, reason: verification.reason || null, candidates: cands.length, verified: interests.length },
    targeting: { mode: 'SMART', genders: gender, ageMin, ageMax, interests: interests.map((i) => ({ id: i.id, name: i.name })), geoRegions: locations.regions, placementsMode: placements.mode },
  };
}

/** Manual interest search for the editor (read only) — Meta's real adinterest search. */
export async function searchInterests(q, deps = {}) {
  const term = clean(q); if (term.length < 2) return [];
  const token = await (deps.getToken || getDecryptedToken)(); const list = await (deps.search || searchAdInterest)(token, term);
  return list.filter((r) => r?.id && r?.name && !SENSITIVE.test(r.name)).slice(0, 10).map((r) => ({ id: String(r.id), name: String(r.name), audienceLower: r.audience_size_lower_bound ?? null, audienceUpper: r.audience_size_upper_bound ?? null, path: Array.isArray(r.path) ? r.path.join(' › ') : (r.topic || null) }));
}
