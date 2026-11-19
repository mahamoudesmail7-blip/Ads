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
import { logger } from '../../logger.js';

export const SMART_VERSION = 'smart-targeting-2026-11-v1';
const MAX_INTERESTS = 5; const MIN_AUDIENCE_UPPER = 50_000;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
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
- age: ageMin and ageMax between 18 and 65, a realistic buying range for Egypt (at least 8 years wide).
- interests: 14 candidate Detailed-Targeting INTEREST names in ENGLISH, exactly as they appear in Meta Ads Manager (e.g. "Massage", "Home improvement", "Cooking", "Online shopping"). Short, common, real Meta interests. Most relevant first. No brand names unless the product is that brand's accessory.
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
async function realEvidence(productId, deps) {
  try {
    const ra = await (deps.real || ((id) => realAudience(id, deps.realDeps || {})))(productId); if (!ra) return null;
    const g = genderOfSegment(ra.best?.gender?.segment); const ageSeg = ra.best?.age?.segment ? parseAgeSegment(ra.best.age.segment) : null;
    const govs = (ra.best?.governorate?.segment && Array.isArray(ra.governorates)) ? ra.governorates.filter((r) => (r.orders || 0) > 0).slice(0, 3).map((r) => r.segment) : [];
    return { gender: g, genderText: ra.best?.gender?.segment || null, ageSeg, age: ra.best?.age?.segment || null, governorates: govs, windowName: ra.window?.name || null };
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
export async function suggestSmartTargeting({ productId, deps = {} }) {
  const id = Number(productId); if (!Number.isInteger(id) || id <= 0) { const e = new Error('اختار منتج الأول.'); e.status = 400; throw e; }
  const context = await (deps.getContext || getContext)(id, deps.ctxDeps || {});
  const real = await realEvidence(id, deps);
  const sources = { gender: null, age: null, interests: null }; const reasons = { gender: '', age: '', interests: '', locations: '', placements: '' }; const notes = [];
  let ai = null; let aiError = null;
  try { ai = await askAi(context, real ? { gender: real.genderText, age: real.age } : null, deps, id); } catch (e) { aiError = e.code === 'NOT_CONFIGURED' ? e.message : 'الذكاء الاصطناعي مش متاح دلوقتي (رصيد/مفتاح/عطل مؤقت).'; logger.warn('[smartTargeting] AI unavailable', { message: e.message }); }
  const rule = ruleProfile(context.name, context.category);

  // gender / age: real buyers (proven winner) > AI > rules
  let gender; let ageMin; let ageMax;
  if (real?.gender) { gender = real.gender; sources.gender = 'REAL_DATA'; reasons.gender = `من بيانات مشتريّن منتجك الفعلية: أقوى شريحة ${real.genderText}.`; }
  else if (ai?.gender) { gender = ai.gender; sources.gender = 'AI'; reasons.gender = ai.genderReason || `الذكاء الاصطناعي رشّح ${GENDER_AR[gender]} للمنتج ده.`; }
  else { gender = rule.gender; sources.gender = 'RULES'; reasons.gender = rule.why; }
  if (real?.ageSeg) { ageMin = clamp(real.ageSeg[0] - 5, 18, 65); ageMax = clamp(real.ageSeg[1] + 5, 18, 65); sources.age = 'REAL_DATA'; reasons.age = `أقوى شريحة عمرية في مبيعاتك ${real.age} — وسّعتها 5 سنين من كل ناحية عشان التوزيع ميضيقش.`; }
  else if (ai?.ageMin != null) { ageMin = ai.ageMin; ageMax = ai.ageMax; sources.age = 'AI'; reasons.age = ai.ageReason || 'نطاق عمر مرشّح من الذكاء الاصطناعي حسب نوع المنتج.'; }
  else { ageMin = rule.ageMin; ageMax = rule.ageMax; sources.age = 'RULES'; reasons.age = rule.why; }

  // interests: AI candidates (or the rule table) — each verified against Meta; only verified ones can be applied
  const cands = ai?.interests?.length >= 3 ? ai.interests : rule.interests.map((name) => ({ name, why: rule.why }));
  sources.interests = ai?.interests?.length >= 3 ? 'AI' : 'RULES';
  const verification = await verifyInterests(cands.map((c) => c.name), deps.meta || {});
  const interests = pickInterests(cands, verification);
  const unverified = verification.available ? [] : cands.slice(0, MAX_INTERESTS).map((c) => c.name);
  if (!verification.available) notes.push('مش قادر أتأكد من الاهتمامات على Meta دلوقتي (' + (verification.reason || 'Meta مش متصل') + ') — مش هقترح اهتمامات غير متحقق منها. اربط Meta أو جرّب تاني.');
  else if (interests.length < MAX_INTERESTS) notes.push(`لقيت ${interests.length} اهتمام متحقق منهم في Meta بس من ${cands.length} مرشّحين — تقدر تضيف باقي الخمسة بنفسك من البحث.`);
  reasons.interests = interests.length ? 'الاهتمامات دي اتشافت واحدة واحدة في بحث Meta نفسه (ليها ID حقيقي وحجم جمهور)، ومرتبطة بنوع المنتج.' : '';

  // locations: only a PROVEN governorate winner earns a restriction — otherwise Egypt-wide (the system's usual, safest choice)
  let locations = { mode: 'EGYPT', regions: [], reason: 'مفيش دليل كفاية في مبيعاتك على محافظات بعينها — الأفضل مصر كلها وMeta توزّع. تقدر تحدد محافظات من الكوكب بنفسك.' };
  if (real?.governorates?.length) { const regions = await resolveRegions(real.governorates, deps); if (regions.length) locations = { mode: 'REGIONS', regions, reason: `أقوى المحافظات في أوردراتك الفعلية: ${regions.map((r) => r.name).join('، ')}.` }; }
  const placements = { mode: 'AUTOMATIC', reason: 'المواضع التلقائية (Advantage+) بتسيب Meta تجيب أرخص نتيجة — الأفضل كبداية. تقدر تحصرها في الفيد بس لو عايز.' };
  if (sources.gender !== 'REAL_DATA' && sources.age !== 'REAL_DATA') notes.push('المنتج لسه معندوش شريحة مثبتة من مبيعاته، فالنوع والسن اقتراح مبدئي — جرّبه كتيست وراجع أرقامه.');

  const source = (sources.gender === 'REAL_DATA' || sources.age === 'REAL_DATA') ? (ai ? 'REAL_DATA+AI' : 'REAL_DATA+RULES') : (ai ? 'AI' : 'RULES');
  if (aiError) notes.push(`${aiError} — استخدمت قواعد السوق المصري بدل الذكاء الاصطناعي (والاهتمامات لسه متحقق منها من Meta).`);
  return {
    ok: true, version: SMART_VERSION, at: new Date().toISOString(), source, sources, aiError, product: { id: id, name: context.name, category: context.category || null, price: context.price ?? null, kind: ai?.productKind || null },
    gender, genderLabel: GENDER_AR[gender], ageMin, ageMax, interests, unverified, placements, locations, reasons, notes,
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
