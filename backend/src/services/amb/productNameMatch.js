// AI Media Buyer Operator — fuzzy product name resolution AND verified
// product-feature lookup. Lets chat tools that only need a product's NAME
// (content generation: posts/angles/hooks/creative briefs) accept free
// text — from what the user typed, or from what the model identified in an
// attached product photo — instead of forcing the human to look up and
// type a raw internal Product ID. Never invents a product: an unmatched
// name returns candidates:[] and the caller must say so honestly, never
// guess the "closest" one silently.
import { prisma } from '../../prisma.js';

// Arabic normalization: unify alef/hamza variants, ta-marbuta/ha, strip
// diacritics/tatweel and punctuation, collapse whitespace — so "الراديو"
// vs "راديو" vs "راديو." all compare equal.
function normalizeAr(s) {
  return String(s || '')
    .replace(/[ً-ٰٟـ]/g, '') // diacritics + tatweel
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// Grammatical words PLUS generic e-commerce filler words that carry no
// real product-identifying signal regardless of how rare they happen to be
// in this specific catalogue (a corpus-frequency/IDF approach alone won't
// catch these — "منتج" can be coincidentally rare today and still mean
// nothing) — matching on one of these alone must never count as evidence.
const STOPWORDS = new Set([
  'ال', 'من', 'في', 'مع', 'و', 'أو', 'او',
  'منتج', 'منتجات', 'جهاز', 'اداه', 'ادوات', 'مجموعه', 'سيت', 'نوع', 'موديل',
  'جديد', 'جديده', 'اصلي', 'اصليه', 'عملي', 'عمليه', 'ذكي', 'ذكيه',
  'كهربائي', 'كهربائيه', 'محمول', 'محموله', 'صغير', 'صغيره', 'كبير', 'كبيره',
]);
function tokens(s) {
  return normalizeAr(s).split(' ').filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * @param {{productId?:number|string, productName?:string}} input
 * @returns {Promise<{ok:true, product:{id:number,product_name:string}} | {ok:false, error?:string, candidates?:Array<{id:number,name:string}>}>}
 */
export async function resolveProductByIdOrName({ productId, productName }) {
  if (productId) {
    const p = await prisma.product.findUnique({ where: { id: Number(productId) }, select: { id: true, product_name: true, active: true, is_historical: true } });
    if (!p || !p.active || p.is_historical) return { ok: false, error: 'المنتج غير موجود أو غير نشط.' };
    return { ok: true, product: p };
  }
  if (!productName || !productName.trim()) return { ok: false, error: 'محتاج اسم المنتج أو رقمه.' };

  const all = await prisma.product.findMany({ where: { active: true, is_historical: false }, select: { id: true, product_name: true } });
  const qNorm = normalizeAr(productName);
  const qTokens = tokens(productName);
  if (!qTokens.length) return { ok: false, error: 'اسم المنتج المُدخل غير كافٍ للمطابقة.' };

  // Document frequency per token across REAL product names — generic words
  // that recur across many products ("جهاز", "منتج", "ذكي", "كهربائي"...)
  // must never count as a meaningful match on their own; a rare/distinctive
  // token (a product's own real, uncommon word) should. Computed fresh each
  // call so it self-adjusts to whatever products actually exist — never a
  // hand-typed stopword list that could go stale.
  const allTokenSets = all.map((p) => new Set(tokens(p.product_name)));
  const docFreq = new Map();
  for (const set of allTokenSets) for (const t of set) docFreq.set(t, (docFreq.get(t) || 0) + 1);
  const idf = (t) => Math.log((all.length + 1) / ((docFreq.get(t) || 0) + 1)) + 1;

  const scored = all.map((p, i) => {
    const nNorm = normalizeAr(p.product_name);
    let score = 0;
    if (nNorm === qNorm) score = 1000;
    else if (nNorm.includes(qNorm) || qNorm.includes(nNorm)) score = 500;
    else {
      const overlap = qTokens.filter((t) => allTokenSets[i].has(t));
      score = overlap.reduce((sum, t) => sum + idf(t), 0);
      // A single, common (low-idf) token overlapping is not real evidence —
      // e.g. "منتج"/"جهاز" appearing in dozens of unrelated product names.
      if (overlap.length === 1 && idf(overlap[0]) < 2) score = 0;
    }
    return { p, score };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score);

  if (!scored.length) return { ok: false, error: 'مفيش منتج حقيقي بالاسم ده أو حاجة قريبة منه.', candidates: [] };
  // Auto-resolve ONLY when the top match is uniquely, clearly best — a tie
  // (even a high-scoring one, like 11 real products all containing the same
  // generic word) must always be surfaced for the human to pick by NAME,
  // never silently guessed and never asked for an ID.
  const top = scored[0];
  const runnerUp = scored[1];
  if (!runnerUp || top.score - runnerUp.score >= Math.max(20, top.score * 0.3)) {
    return { ok: true, product: top.p };
  }

  // Only candidates genuinely close to the top score are real disambiguation
  // options — a low-relevance token-overlap match (e.g. sharing only one
  // common adjective) must never be listed alongside the real contenders.
  const relevant = scored.filter((r) => r.score >= top.score * 0.6).slice(0, 6);

  // A TRUE duplicate — every close candidate has the exact same real name —
  // is not a real ambiguity a human can resolve by name (they're identical);
  // asking "which one?" would just repeat the same name back at them. Break
  // the tie deterministically instead: prefer whichever copy is actually
  // linked into AI Media Buyer (AmbProduct), else the most recently created.
  const allSameName = relevant.every((r) => normalizeAr(r.p.product_name) === normalizeAr(top.p.product_name));
  if (allSameName && relevant.length > 1) {
    const linked = await prisma.ambProduct.findMany({ where: { product_id: { in: relevant.map((r) => r.p.id) }, active: true }, select: { product_id: true } });
    const linkedIds = new Set(linked.map((l) => l.product_id));
    const preferred = relevant.find((r) => linkedIds.has(r.p.id)) || [...relevant].sort((a, b) => b.p.id - a.p.id)[0];
    return { ok: true, product: preferred.p };
  }

  return { ok: false, error: 'فيه أكتر من منتج قريب من الاسم ده.', candidates: relevant.map((r) => ({ id: r.p.id, name: r.p.product_name })) };
}

// Labels PMC's confirmed_traits_json uses purely for DATA PROVENANCE (which
// store, which source, internal id, matched price) rather than an actual
// physical product feature — never useful as an ad-copy "✅ feature" bullet.
const PROVENANCE_LABELS = new Set(['المتجر', 'المصدر', 'اسم المنتج (Easy Orders)', 'رقم المنتج الداخلي', 'سعر البيع المسجّل', 'الفئة']);

// Product names in this catalogue often literally enumerate real features
// for multi-function products ("...5 في 1 – حوض سمك، إضاءة LED، ساعة رقمية،
// مقياس حرارة، ومنظم أقلام") — split the listy part after a dash/colon on
// commas/"+". Only trusted as real features when it yields several short
// parts; a normal descriptive name split on commas that just gives one long
// fragment back is not a real feature list.
function featuresFromProductName(name) {
  const afterDash = name.split(/[–\-:]/).slice(1).join(' ').trim();
  const listPart = afterDash || name;
  const parts = listPart.split(/[،,]|(?:\s\+\s)/)
    .map((s) => s.trim().replace(/^و\s*/, '')) // strip a leading "و" (and) connector — not part of the feature name
    .filter((s) => s.length >= 2 && s.length <= 40);
  return parts.length >= 2 ? parts : [];
}

/**
 * Real, verified product facts for content generation — NEVER invented.
 * Sources, most to least authoritative: PMC's own confirmed_traits (minus
 * pure data-provenance rows), CfProduct's reviewed specification/benefit
 * fields (when a Creative Factory profile is linked), and features
 * literally enumerated in the product's own name.
 * @param {{id:number, product_name:string}} product
 * @returns {Promise<string[]>}
 */
export async function getVerifiedFeatures(product) {
  const features = [];
  const [pmcProfile, cfProduct] = await Promise.all([
    prisma.productMarketingProfile.findFirst({ where: { product_id: product.id }, orderBy: { updated_at: 'desc' }, select: { confirmed_traits_json: true } }),
    prisma.cfProduct.findUnique({ where: { product_id: product.id }, select: { specifications: true, benefits: true } }).catch(() => null),
  ]);

  if (pmcProfile?.confirmed_traits_json) {
    try {
      const traits = JSON.parse(pmcProfile.confirmed_traits_json);
      for (const t of traits) {
        if (!t?.label || PROVENANCE_LABELS.has(t.label)) continue;
        features.push(t.value ? `${t.label}: ${t.value}` : t.label);
      }
    } catch { /* malformed row — skip, never guess */ }
  }
  if (cfProduct?.specifications) features.push(String(cfProduct.specifications).slice(0, 200));
  if (cfProduct?.benefits) features.push(String(cfProduct.benefits).slice(0, 200));
  features.push(...featuresFromProductName(product.product_name));

  return [...new Set(features)].slice(0, 12);
}
