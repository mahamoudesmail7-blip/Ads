// AI Product Targeting & Creative Strategy — the PURE core (no database, no network, no AI, no clock).
// Everything the model returns is untrusted text: this file turns it into the clean, bounded shapes the screen relies on, separates what is CONFIRMED (visible in the photos / present in the
// store data) from what is only an AI inference or still NEEDS verification, and audits every post for the things that must never ship: invented prices / discounts / shipping / payment
// terms, medical or guaranteed-result claims, a missing or wrong link, and a structure that does not follow the required post format.

export const POST_TYPES = [
  { key: 'GOODBYE', label: 'ودّع المشكلة', goal: 'يبدأ بـ«ودّع» أو «ودّعي» ويركّز على مشكلة يومية حقيقية يساعد المنتج في التعامل معاها.' },
  { key: 'PROBLEM_SOLUTION', label: 'Problem / Solution', goal: 'يبدأ بسؤال قوي عن مشكلة حقيقية، وبعدها يقدّم المنتج وفوائده بإقناع.' },
  { key: 'HOOK_CPM', label: 'Strong Hook / CPM', goal: 'هوك قوي ومختلف يجذب الانتباه (من غير وعد بنتيجة CPM محددة).' },
  { key: 'OFFER_CTR', label: 'Offer First / CTR', goal: 'يبدأ بعرض أو خصم حقيقي من بيانات المنتج، ولو مفيش خصم مؤكد يبدأ بالقيمة والمميزات. يشجّع على الضغط.' },
  { key: 'CURIOSITY_LP', label: 'Curiosity / Landing Page', goal: 'جملة فضول تخلي العميل يدخل صفحة المنتج ويعرف التفاصيل.' },
];
export const STRATEGIES = [
  { key: 'PRIMARY', label: 'الجمهور الأساسي' },
  { key: 'PROBLEM', label: 'جمهور المشكلة أو الاحتياج' },
  { key: 'DETAILED', label: 'Detailed Targeting' },
  { key: 'BROAD', label: 'Broad Audience' },
  { key: 'ADVANTAGE_PLUS', label: 'Advantage+ Audience' },
];
export const IMAGE_SLOTS = [
  { slot: 1, role: 'MAIN', label: 'الشكل الأساسي للمنتج' },
  { slot: 2, role: 'DETAIL', label: 'تفاصيل المنتج أو طريقة استخدامه' },
  { slot: 3, role: 'EXTRA', label: 'المرفقات أو العبوة أو زاوية إضافية' },
];
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
export const EGYPT_GOVERNORATES = ['القاهرة', 'الجيزة', 'الإسكندرية', 'القليوبية', 'الدقهلية', 'الشرقية', 'الغربية', 'المنوفية', 'البحيرة', 'كفر الشيخ', 'دمياط', 'بورسعيد', 'الإسماعيلية', 'السويس', 'الفيوم', 'بني سويف', 'المنيا', 'أسيوط', 'سوهاج', 'قنا', 'الأقصر', 'أسوان', 'مطروح', 'شمال سيناء', 'جنوب سيناء', 'البحر الأحمر', 'الوادي الجديد'];

// ───────────── small helpers ─────────────
export const str = (v, max = 300) => String(v ?? '').replace(/[‎‏]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const multi = (v, max = 2500) => String(v ?? '').replace(/\r/g, '').replace(/[‎‏]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const arr = (v) => (Array.isArray(v) ? v : []);
const clampInt = (v, lo, hi, d) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
export const uniq = (list) => { const seen = new Set(); return list.filter((x) => { const k = String(x.text ?? x).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); };

// ───────────── claims that must never ship ─────────────
const MEDICAL = /(يعالج|بيعالج|علاج|يشفي|هتشفى|بيشفي|يداوي|يخفف الألم|هتخف|يمنع (?:الأمراض|السرطان)|يقضي على|يخلّص(?:ك|ي)? من (?:الألم|المرض)|treat|cure|heal)/i;
const GUARANTEE = /(مضمون|ضمان (?:النتيجة|النتايج)|نتيجة مضمونة|نتايج مضمونة|100\s*%\s*(?:نتيجة|ضمان|مضمون)|بدون استثناء|هتشوف النتيجة (?:فورًا|فورا|من أول)|أقل\s*CPM|أعلى\s*CTR|هيقلل\s*(?:ال)?\s*CPM|هتقلل\s*(?:ال)?\s*CPM|هيزود\s*(?:ال)?\s*CTR|هتزود\s*(?:ال)?\s*CTR)/i;
const SENSITIVE_INTEREST = /(religio|islam|christian|muslim|church|mosque|sexual|lgbt|gay|lesbian|disab|diabet|cancer|depress|anxiety|hiv|pregnan|ethnic|race|political|party|union)/i;

/** Pure: does this text make a medical / guaranteed-result claim? → the matched phrase or null. */
export function findForbiddenClaim(text) { const t = String(text || ''); return (t.match(MEDICAL) || t.match(GUARANTEE) || [null])[0]; }

// ───────────── 1. analysis ─────────────
const VALID_SRC = /^(IMAGE_[123]|STORE_DATA)$/;
const asConfirmed = (list, max) => arr(list).map((x) => ({ text: str(x?.text ?? x, 160), source: String(x?.source || '').toUpperCase().replace(/\s+/g, '') })).filter((x) => x.text);
const textList = (v, n, max = 160) => uniq(arr(v).map((x) => str(typeof x === 'string' ? x : x?.text, max)).filter(Boolean)).slice(0, n);

/**
 * The model's analysis → { confirmed:{specs,usage}, inferred:{...}, needsVerification, ... }.
 * A «confirmed» item survives ONLY with a real source (one of the 3 photos or the store data). Anything without one, and any medical / guaranteed claim, is moved to needsVerification — it is never shown as a fact.
 */
export function sanitizeAnalysis(j, { imageCount = 3, storeFeatures = [] } = {}) {
  const needs = []; const demote = (text, why) => { if (text) needs.push({ text: str(text, 160), why }); };
  const okSrc = (s) => VALID_SRC.test(s) && (s === 'STORE_DATA' || Number(s.slice(-1)) <= imageCount);
  const confirmed = (list) => { const out = []; for (const x of asConfirmed(list)) { const claim = findForbiddenClaim(x.text); if (claim) { demote(x.text, 'ادعاء صحي أو نتيجة مضمونة — ممنوع استخدامه من غير دليل.'); continue; } if (!okSrc(x.source)) { demote(x.text, 'مفيش مصدر مؤكد (صورة أو بيانات المتجر) — محتاج تحقق.'); continue; } out.push(x); } return uniq(out); };
  const guard = (list, n) => { const out = []; for (const t of textList(list, n + 4)) { if (findForbiddenClaim(t)) { demote(t, 'ادعاء صحي أو نتيجة مضمونة — ممنوع استخدامه من غير دليل.'); continue; } out.push(t); } return out.slice(0, n); };
  const r = {
    productName: str(j?.productName, 120), category: str(j?.category, 80), summary: str(j?.summary, 500),
    confirmed: { specs: confirmed(j?.confirmed?.specs).slice(0, 12), usage: confirmed(j?.confirmed?.usage).slice(0, 8) },
    inferred: { benefits: guard(j?.inferred?.benefits, 8), problemsSolved: guard(j?.inferred?.problemsSolved, 6), potentialBuyers: textList(j?.inferred?.potentialBuyers, 6), strengths: textList(j?.inferred?.strengths, 6), weaknesses: textList(j?.inferred?.weaknesses, 6), objections: guard(j?.inferred?.objections, 6) },
    imageNotes: arr(j?.imageNotes).map((n) => ({ slot: clampInt(n?.slot, 1, 3, 0), notes: str(n?.notes, 240) })).filter((n) => n.slot >= 1 && n.slot <= imageCount && n.notes).slice(0, 3),
    storeFeatures: arr(storeFeatures).map((x) => str(x, 160)).filter(Boolean).slice(0, 12),
  };
  for (const x of arr(j?.needsVerification)) { const t = str(x?.text ?? x, 160); if (t) needs.push({ text: t, why: str(x?.why, 160) || 'لازم يتأكد منها قبل ما تتقال في الإعلان.' }); }
  r.needsVerification = uniq(needs).slice(0, 14);
  r.enough = r.confirmed.specs.length + r.confirmed.usage.length > 0 || r.storeFeatures.length > 0;
  return r;
}

// ───────────── 2. targeting ─────────────
const GENDERS = { MALE: 'MALE', FEMALE: 'FEMALE', ALL: 'ALL', رجال: 'MALE', سيدات: 'FEMALE', الجميع: 'ALL', men: 'MALE', women: 'FEMALE', all: 'ALL', male: 'MALE', female: 'FEMALE' };
export const GENDER_AR = { MALE: 'رجال', FEMALE: 'سيدات', ALL: 'الجميع' };
const CONF = ['LOW', 'MEDIUM'];
/** Plain Latin interest name, the way it is searched in Ads Manager (no Arabic, no emoji, no sensitive categories). */
export function cleanInterestName(v) { const s = str(v, 60).replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim(); return /[A-Za-z]/.test(s) && !SENSITIVE_INTEREST.test(s) ? s : ''; }
const GOV_SET = new Set(EGYPT_GOVERNORATES);

export function sanitizeTargeting(j) {
  const byKey = new Map(arr(j?.strategies).map((s) => [String(s?.key || '').toUpperCase(), s]));
  const strategies = STRATEGIES.map((def, i) => {
    const s = byKey.get(def.key) || arr(j?.strategies)[i] || {};
    let ageMin = clampInt(s.ageMin ?? s.age?.min, 18, 65, 22), ageMax = clampInt(s.ageMax ?? s.age?.max, 18, 65, 55); if (ageMin > ageMax) [ageMin, ageMax] = [ageMax, ageMin];
    const gender = GENDERS[String(s.gender ?? '').trim()] || GENDERS[String(s.gender ?? '').trim().toLowerCase()] || 'ALL';
    const regions = uniq(arr(s.locations?.regions ?? s.regions).map((g) => str(g, 40)).filter((g) => GOV_SET.has(g))).slice(0, 12);
    const wide = def.key === 'BROAD' || def.key === 'ADVANTAGE_PLUS';
    const interests = uniq(arr(s.interests).map((x) => ({ text: cleanInterestName(typeof x === 'string' ? x : x?.name), why: str(typeof x === 'string' ? '' : x?.why, 140) })).filter((x) => x.text)).slice(0, wide ? 3 : 6).map((x) => ({ name: x.text, why: x.why }));
    const level = CONF.includes(String(s.confidence?.level ?? s.confidence ?? '').toUpperCase()) ? String(s.confidence?.level ?? s.confidence).toUpperCase() : 'LOW';
    return {
      key: def.key, label: def.label, segmentName: str(s.segmentName ?? s.name, 90),
      gender, ageMin, ageMax,
      locations: { scope: regions.length ? 'GOVERNORATES' : 'EGYPT', regions },
      interests, reason: str(s.reason, 400), motive: str(s.motive ?? s.purchaseMotive, 260), angle: str(s.angle ?? s.marketingAngle, 200), creativeType: str(s.creativeType, 200),
      // an untested audience is never «high» — the cap is enforced here, whatever the model claimed
      confidence: { level, why: str(s.confidence?.why, 200) || 'اقتراح من تحليل المنتج — لسه ما اتجرّبش ببيانات شراء فعلية.' },
    };
  });
  return { strategies, ok: strategies.every((s) => s.segmentName) };
}

/** Pure: how Meta's search answered for ONE suggested interest → a status the screen can show honestly. */
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s) => new Set(normName(s).split(' ').filter(Boolean));
export function matchInterest(term, results) {
  const list = arr(results).filter((r) => r && r.name);
  const t = normName(term);
  const exact = list.find((r) => normName(r.name) === t);
  const shape = (r) => ({ id: String(r.id ?? ''), name: String(r.name), audienceLower: r.audience_size_lower_bound ?? r.audienceLower ?? null, audienceUpper: r.audience_size_upper_bound ?? r.audienceUpper ?? null, path: Array.isArray(r.path) ? r.path.join(' > ') : (r.path || r.topic || null) });
  if (exact) return { status: 'VERIFIED', match: shape(exact), alternatives: [] };
  const a = tokens(term);
  const scored = list.map((r) => { const b = tokens(r.name); const inter = [...a].filter((x) => b.has(x)).length; const union = new Set([...a, ...b]).size || 1; return { r, score: inter / union }; }).sort((x, y) => y.score - x.score);
  const alts = scored.slice(0, 3).map((x) => shape(x.r));
  if (scored.length && scored[0].score >= 0.5) return { status: 'SIMILAR', match: null, alternatives: alts };
  return { status: list.length ? 'UNVERIFIED' : 'NOT_FOUND', match: null, alternatives: alts };
}
export const INTEREST_STATUS_LABEL = {
  VERIFIED: { text: 'متحقق منه في Meta', tone: 'ok' },
  SIMILAR: { text: 'مش موجود بنفس الاسم — فيه بدائل قريبة', tone: 'warn' },
  UNVERIFIED: { text: 'اقتراح يحتاج مراجعة', tone: 'warn' },
  NOT_FOUND: { text: 'مش لاقي نتيجة في Meta — اقتراح يحتاج مراجعة', tone: 'warn' },
  UNAVAILABLE: { text: 'التحقق مش متاح دلوقتي — اقتراح يحتاج مراجعة', tone: 'gray' },
};

// ───────────── 3-6. posts ─────────────
export const IMAGE_FIDELITY = 'Use the three attached reference photos of the REAL product as the only ground truth for its shape, color, proportions, materials and included parts. Do not add accessories, parts, buttons, functions, logos, certifications, text claims or any feature that is not visible in the references. Keep the product exactly as photographed.';
export const IMAGE_FORMAT = 'Square 1:1, 1000x1000 px, clean ad composition, product clearly visible.';
export const VIDEO_FORMAT = 'Vertical 9:16 short video (6-12 seconds), first second must show the visual hook, product shown exactly as in the references.';
export function sanitizeCreative(c) {
  const imagePrompt = str(c?.imagePrompt, 900); const videoPrompt = str(c?.videoPrompt, 900);
  return {
    imageIdea: str(c?.imageIdea, 300), videoIdea: str(c?.videoIdea, 300), visualHook: str(c?.visualHook, 220), audienceFit: str(c?.audienceFit, 220),
    imagePrompt: imagePrompt ? `${imagePrompt}\n\n${IMAGE_FIDELITY}\n${IMAGE_FORMAT}` : '', videoPrompt: videoPrompt ? `${videoPrompt}\n\n${IMAGE_FIDELITY}\n${VIDEO_FORMAT}` : '',
  };
}

/** The link marker the model writes; replaced with the REAL product link (or a visible «ضيف الرابط» marker when we do not have it). */
export const LINK_TOKEN = '{{LINK}}';
export const LINK_MISSING = '[⚠️ ضيف رابط المنتج هنا]';
export function fillLink(text, link) { return String(text || '').split(LINK_TOKEN).join(link || LINK_MISSING); }

const firstLine = (t) => String(t || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
const stripEmoji = (s) => String(s || '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '').trim();
const emojiCount = (s) => (String(s || '').match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
const wordsOf = (s) => new Set(stripEmoji(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));

/**
 * One generated post → a clean post object (text with the real link in place, headline, creative ideas). `ctx.link` = the product link or null.
 */
export function sanitizePost(p, type, { link = null } = {}) {
  const def = POST_TYPES.find((x) => x.key === type) || POST_TYPES[0];
  const text = fillLink(multi(p?.text ?? p?.body, 2600), link);
  return {
    type: def.key, label: def.label, text, hook: firstLine(text), headline: str(p?.headline, 90), angle: str(p?.angle, 200), audience: str(p?.audience, 200),
    offerMode: def.key === 'OFFER_CTR' ? (String(p?.offerMode || '').toUpperCase() === 'DISCOUNT' ? 'DISCOUNT' : 'VALUE') : null,
    creative: sanitizeCreative(p?.creative),
  };
}

const PRICE_RE = /(\d[\d,.]*)\s*(?:جنيه|ج\.م|جم|EGP|LE|L\.E)(?![\p{L}])|(?:جنيه|EGP|LE)\s*(\d[\d,.]*)/giu;
const PCT_RE = /(\d{1,3})\s*%/g;
const num = (s) => Number(String(s).replace(/,/g, ''));

/**
 * Audit a post against what is CONFIRMED. ctx = { link, price, oldPrice, discountPercent, confirmed: { shipping: bool, payment: bool, discount: bool }, productName }.
 * Returns [{ code, level: 'BLOCK'|'WARN', message }]. BLOCK = must be fixed before the post can be approved.
 */
export function auditPost(post, ctx = {}) {
  const w = []; const add = (code, level, message) => w.push({ code, level, message });
  const text = String(post.text || ''); const head = String(post.headline || ''); const all = `${text}\n${head}`;
  const claim = findForbiddenClaim(all); if (claim) add('CLAIM', 'BLOCK', `فيه ادعاء ممنوع («${claim}»): ادعاء صحي أو نتيجة/CPM/CTR مضمونة. شيله أو عدّله.`);
  // prices & discounts: only the product's real numbers
  const known = new Set([ctx.price, ctx.oldPrice].filter((x) => Number.isFinite(Number(x))).map(Number));
  for (const m of all.matchAll(PRICE_RE)) { const v = num(m[1] ?? m[2]); if (Number.isFinite(v) && !known.has(v)) { add('PRICE', 'BLOCK', `رقم سعر مش موجود في بيانات المنتج (${v}). مفيش أسعار مخترعة.`); break; } }
  for (const m of all.matchAll(PCT_RE)) { const v = Number(m[1]); if (!(ctx.confirmed?.discount && ctx.discountPercent && Math.abs(ctx.discountPercent - v) <= 1)) { add('DISCOUNT', 'BLOCK', `نسبة «${v}%» مش مؤكدة في بيانات المنتج.`); break; } }
  if (!ctx.confirmed?.discount && /(خصم|تخفيض|عرض (?:خاص|محدود)|أوفر|قبل وبعد|السعر قبل)/.test(all)) add('DISCOUNT_WORD', 'BLOCK', 'بتتكلم عن خصم/عرض ومفيش خصم مؤكد في بيانات المنتج.');
  if (!ctx.confirmed?.shipping && /(شحن مجاني|توصيل مجاني|توصيل لحد|توصيل سريع|توصيل في|الشحن)/.test(text)) add('SHIPPING', 'BLOCK', 'بتذكر تفاصيل شحن/توصيل غير مؤكدة. أكّدها الأول من «بيانات مؤكدة» أو شيلها.');
  if (!ctx.confirmed?.payment && /(الدفع عند الاستلام|كاش عند|دفع عند)/.test(text)) add('PAYMENT', 'BLOCK', 'بتذكر الدفع عند الاستلام وهو مش مؤكد. أكّده الأول أو شيله.');
  // link
  if (ctx.link) { const n = text.split(ctx.link).length - 1; if (n < 2) add('LINK', 'WARN', `رابط المنتج لازم يظهر مرتين (بعد المقدمة وفي الآخر) — ظاهر ${n} مرة.`); }
  else add('LINK_MISSING', 'WARN', 'رابط المنتج مش متسجّل. ضيفه من «بيانات المنتج».');
  // structure
  const bullets = (text.match(/^\s*(?:✅|✔️|☑️|✔)\s+\S/gmu) || []).length;
  if (bullets < 4 || bullets > 7) add('FEATURES', 'WARN', `عدد المميزات ${bullets} — المطلوب من 4 لـ 7 (✅).`);
  if (!/(اطلب|اطلبي|اطلبه|اطلبها|اطلبوا|اضغط|اضغطي|ادخل|ادخلي|اعرف|شوف|شوفي|تفاصيل)/.test(text)) add('CTA', 'WARN', 'مفيش دعوة واضحة للطلب (CTA).');
  if (text.length < 420) add('LENGTH', 'WARN', 'البوست قصير — المطلوب بوست منظّم وطويل نسبيًا.');
  if (!/\n\n/.test(text)) add('SPACING', 'WARN', 'مفيش مسافات بين الفقرات.');
  if (emojiCount(text) > 28) add('EMOJI', 'WARN', 'الإيموجيز كتير — خليها من غير مبالغة.');
  if (/https?:\/\/\S*emoji/i.test(text)) add('EMOJI_LINK', 'BLOCK', 'استخدم الإيموجيز نفسها مش روابط إيموجي.');
  const h = stripEmoji(firstLine(text));
  if (post.type === 'GOODBYE' && !/^(ودّع|ودع|ودّعي|ودعي)/.test(h)) add('RULE', 'WARN', 'بوست «ودّع» لازم يبدأ بكلمة «ودّع» أو «ودّعي».');
  if (post.type === 'PROBLEM_SOLUTION' && !/[؟?]/.test(firstLine(text))) add('RULE', 'WARN', 'بوست Problem/Solution لازم يبدأ بسؤال.');
  if (head && head.length > 40) add('HEADLINE_LEN', 'WARN', `الـHeadline طويل (${head.length} حرف) — الأفضل لحد 40.`);
  if (!head) add('HEADLINE', 'WARN', 'مفيش Headline.');
  if (ctx.productName && stripEmoji(text).length > 0 && !stripEmoji(text).includes(String(ctx.productName).split(/\s+/)[0])) add('NAME', 'WARN', 'اسم المنتج مش ظاهر في البوست.');
  return w;
}

/** Pure: hooks that are too alike across posts (the 5 posts must differ in hook and angle, not just in the first sentence). */
export function similarHooks(posts, threshold = 0.6) {
  const out = [];
  for (let i = 0; i < posts.length; i++) for (let j = i + 1; j < posts.length; j++) {
    const a = wordsOf(firstLine(posts[i].text)); const b = wordsOf(firstLine(posts[j].text)); if (!a.size || !b.size) continue;
    const inter = [...a].filter((x) => b.has(x)).length; const jac = inter / (new Set([...a, ...b]).size);
    // the bodies too: the same paragraph repeated with a new first line is NOT a different post
    const ba = wordsOf(posts[i].text); const bb = wordsOf(posts[j].text); const bj = [...ba].filter((x) => bb.has(x)).length / (new Set([...ba, ...bb]).size || 1);
    if (jac >= threshold || bj >= 0.78) out.push([posts[i].type, posts[j].type, Math.max(jac, bj)]);
  }
  return out;
}

/** The commercial facts a post may state: derived ONLY from the store data + what the owner confirmed. */
export function buildCommercial({ price, oldPrice, freeShipping, confirmedByOwner = {} }) {
  const discountPercent = Number.isFinite(Number(price)) && Number.isFinite(Number(oldPrice)) && Number(oldPrice) > Number(price) && Number(price) > 0 ? Math.round(((Number(oldPrice) - Number(price)) / Number(oldPrice)) * 100) : null;
  const flag = (k, fromStore) => (confirmedByOwner[k] === true ? true : confirmedByOwner[k] === false ? false : !!fromStore);
  return {
    price: Number.isFinite(Number(price)) ? Number(price) : null, oldPrice: Number.isFinite(Number(oldPrice)) ? Number(oldPrice) : null, discountPercent,
    confirmed: { discount: flag('discount', discountPercent != null), shipping: flag('shipping', freeShipping === true), payment: flag('payment', false) },
    sources: { discount: discountPercent != null ? 'STORE_DATA' : null, shipping: freeShipping === true ? 'STORE_DATA' : null },
  };
}
