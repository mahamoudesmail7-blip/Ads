// adAnalysis.js — EXPERIMENTAL, Meta Ads Competitor Intelligence (Part 2).
// Analyzes ONLY verified-exact Meta Ads Library results (platform=
// META_AD_LIBRARY, match_decision=EXACT) — never the broad candidate pool,
// which both matches what was asked ("after finding ads for the EXACT
// product") and naturally bounds cost.
//
// Deterministic extraction FIRST (regex/keyword/metrics already stored —
// zero AI cost) for every field that doesn't need real semantic judgment;
// Claude is only ever asked for the handful of fields that genuinely
// require understanding phrasing/tone (hook, angle, problem, benefits vs
// features, target audience, creative style). Every field in the final
// stored shape carries its own source: 'OBSERVED' | 'AI_INFERRED' |
// 'AI_ANALYZED' tag — the dashboard must never present a guess as a fact.
//
// Runs fired-but-not-awaited AFTER the main search pipeline already
// reached its terminal status (see productResearchExperimental.js's
// POST /search handler) — a slow or fully-failing analysis batch can
// never delay or break the product search the user is watching. One ad's
// failure is caught and marked FAILED; every other ad continues
// (failure isolation, matches the constraint that a competitor-analysis
// failure must never touch Instagram/Facebook/TikTok/YouTube/Google).
//
// Caching mirrors the exact (key, model_version) idiom already used by
// ExperimentalImageIdentityCache — keyed by a STABLE ad identifier
// (metrics.adId when the Apify provider supplied one, else a hash of the
// canonical URL), never by search_id, so the same competitor ad
// resurfacing in a different search is never re-billed to Claude.
import crypto from 'crypto';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { askClaude } from './ai.js';

const LOG_PREFIX = '[AdAnalysis]';
// Bumped whenever the extraction/prompt/output shape changes, so a stale
// cached analysis is never served against code expecting a different shape.
const MODEL_VERSION = 'ad-analysis-v1';

function safeJsonParse(text) {
  const stripped = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  try { return JSON.parse(stripped); } catch { return null; }
}

function parseMetrics(result) {
  try { return result.metrics_json ? JSON.parse(result.metrics_json) : {}; } catch { return {}; }
}

function adKeyFor(result, metrics) {
  const raw = metrics.adId || result.canonical_url;
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// ============================================================================
// DETERMINISTIC EXTRACTION — zero AI cost, real regex/keyword matches only.
// Every function here returns null/false rather than guessing when the
// text doesn't clearly support a value (Step: "NEVER INVENT PRICE").
// ============================================================================

const CURRENCY_PATTERNS = [
  { regex: /(\d[\d,.]{0,9})\s*(?:جنيه مصري|جنيها|جنيه|ج\.م|EGP)/i, currency: 'EGP' },
  { regex: /(\d[\d,.]{0,9})\s*(?:ريال سعودي|ريال|SAR)/i, currency: 'SAR' },
  { regex: /(\d[\d,.]{0,9})\s*(?:درهم إماراتي|درهم|AED)/i, currency: 'AED' },
  { regex: /(\d[\d,.]{0,9})\s*(?:دينار كويتي|دينار|KWD)/i, currency: 'KWD' },
  { regex: /\$\s*(\d[\d,.]{0,9})/, currency: 'USD' },
];

function parseNumber(raw) {
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function extractPrice(text) {
  for (const { regex, currency } of CURRENCY_PATTERNS) {
    const m = text.match(regex);
    if (m) {
      const value = parseNumber(m[1]);
      if (value !== null && value > 0) {
        return { hasPrice: true, value, currency, source: 'OBSERVED' };
      }
    }
  }
  return { hasPrice: false, value: null, currency: null, source: 'OBSERVED' };
}

function extractDiscount(text) {
  const pctMatch = text.match(/(?:خصم|تخفيض)\s*(\d{1,2})\s*%/i) || text.match(/(\d{1,2})\s*%\s*(?:خصم|off|discount)/i);
  const percentage = pctMatch ? Number(pctMatch[1]) : null;
  // Only claim old/new prices when TWO distinct real price-like numbers
  // appear together with an explicit "كان...بقى/دلوقتي" pairing pattern —
  // deliberately conservative rather than pattern-matching any two numbers
  // in the text, which would risk inventing a discount that isn't real.
  const pairMatch = text.match(/كان\s*(\d[\d,.]{0,9})[^\d]{1,15}(?:بقى|دلوقتي|ب)\s*(\d[\d,.]{0,9})/i);
  const oldPrice = pairMatch ? parseNumber(pairMatch[1]) : null;
  const newPrice = pairMatch ? parseNumber(pairMatch[2]) : null;
  const hasDiscount = Boolean(percentage) || (oldPrice !== null && newPrice !== null && oldPrice > newPrice);
  return { hasDiscount, percentage, oldPrice, newPrice, source: 'OBSERVED' };
}

const OFFER_KEYWORDS = {
  cod: /الدفع عند الاستلام|كاش عند الاستلام|COD/i,
  freeShipping: /شحن مجاني|توصيل مجاني|free shipping/i,
  bundle: /باقة|عرض\s*\d+\s*ب|اشتري\s*\S+\s*واحصل|buy\s*\d+\s*get/i,
  warranty: /ضمان/i,
  limitedQuantity: /كمية محدودة|الكمية محدودة/i,
};
function extractOffers(text) {
  const offers = {};
  for (const [key, regex] of Object.entries(OFFER_KEYWORDS)) offers[key] = regex.test(text);
  return { ...offers, source: 'OBSERVED' };
}

const URGENCY_PHRASES = ['لفترة محدودة', 'الكمية محدودة', 'الحق العرض', 'آخر فرصة', 'العرض هينتهي', 'قبل ما ينفد', 'اليوم بس', 'عرض ينتهي قريبا'];
function extractUrgency(text) {
  const found = URGENCY_PHRASES.filter((p) => text.includes(p));
  return { present: found.length > 0, phrases: found, source: 'OBSERVED' };
}

const TRUST_KEYWORDS = {
  cod: /الدفع عند الاستلام|كاش عند الاستلام/i,
  warranty: /ضمان/i,
  reviews: /تقييم|مراجعات|ريفيوهات/i,
  customerCount: /\d+[\s,]*(?:عميل|عميلة|زبون|طلب تم)/i,
  returns: /استرجاع|إرجاع|استبدال/i,
  shippingPromise: /التوصيل خلال|شحن سريع/i,
};
function extractTrustElements(text) {
  const elements = Object.entries(TRUST_KEYWORDS).filter(([, regex]) => regex.test(text)).map(([key]) => key);
  return { elements, source: 'OBSERVED' };
}

function extractCreativeFormat(metrics) {
  const raw = (metrics.mediaType || '').toLowerCase();
  const value = raw.includes('video') ? 'Video' : raw.includes('carousel') ? 'Carousel' : raw.includes('image') ? 'Image' : 'Other';
  return { value, source: 'OBSERVED' };
}

/** Real, honest "running for N days" — recomputed fresh every call, never stored (Step: ad longevity, never interpreted as profitability). */
export function computeAdLongevity(publishedAt, metrics = {}) {
  if (!publishedAt) return { days: null, note: 'تاريخ بدء الإعلان غير متاح.' };
  const start = new Date(publishedAt);
  const end = metrics.endDate ? new Date(metrics.endDate) : new Date();
  const days = Math.max(0, Math.round((end - start) / (1000 * 60 * 60 * 24)));
  return { days, isActive: metrics.activeStatus === 'ACTIVE', note: 'مدة تشغيل الإعلان لا تعني بالضرورة أنه إعلان رابح.' };
}

export function deterministicExtract(result) {
  const metrics = parseMetrics(result);
  const text = `${result.title || ''} ${result.snippet || ''} ${metrics.description || ''}`;
  return {
    price: extractPrice(text),
    discount: extractDiscount(text),
    offers: extractOffers(text),
    urgency: extractUrgency(text),
    trustElements: extractTrustElements(text),
    creativeFormat: extractCreativeFormat(metrics),
    // CTA is already real, directly-observed data the Apify/Graph
    // normalizer captured (snap.cta_text) — never re-derived.
    cta: { text: metrics.cta || null, type: metrics.ctaType || null, source: 'OBSERVED' },
    // Honest, explicit absence — this pipeline has no video transcript or
    // frame-extraction capability. Never fabricated as if frames were
    // watched (Step 14's explicit constraint).
    openingAnalysis: { available: false, reason: 'لا يوجد تحليل فريمات/نص منطوق في هذا الإصدار — لم تتم مشاهدة الفيديو فعليًا.' },
  };
}

// ============================================================================
// AI SEMANTIC ANALYSIS — one text-only Claude call per ad, only for fields
// that genuinely need judgment. The already-deterministic fields are given
// to Claude as context so it never re-derives (and potentially
// contradicts) price/discount/offers itself.
// ============================================================================

const HOOK_TYPES = ['Problem', 'Pain', 'Curiosity', 'Benefit', 'Price', 'Discount', 'Demonstration', 'Before/After', 'Social Proof', 'Fear', 'Convenience', 'Lifestyle', 'Gift', 'Urgency', 'Product Reveal', 'Educational', 'Story', 'Other'];

const SYSTEM_PROMPT = `إنت محلل إعلانات تسويقية خبير. هتاخد نص إعلان حقيقي (عنوان + نص الإعلان) + حقايق مستخرجة أوتوماتيكيًا بالفعل (سعر/خصم/عروض — متكررهاش أو تتناقض معاها). مهمتك فقط التحليل الدلالي اللي محتاج فهم حقيقي للنص. رجّع JSON فقط بالشكل ده بالظبط:

{
  "hookText": "",
  "hookTypes": [],
  "sellingAngle": "",
  "problem": "",
  "benefits": [],
  "features": [],
  "targetAudience": "",
  "creativeStyle": ""
}

قواعد صارمة:
1. hookText: أول جملة/فكرة جذب فعلية موجودة في النص — لو مفيش نص واضح، سيبها "".
2. hookTypes: اختار من القائمة دي بس: ${HOOK_TYPES.join(', ')}. ممكن أكتر من نوع لو فعلاً منطبق.
3. sellingAngle: زاوية البيع الأساسية اللي النص فعلاً بيركز عليها (جملة قصيرة).
4. problem: المشكلة اللي الإعلان بيركز عليها لو موجودة فعلاً، وإلا سيبها "".
5. benefits: الفوايد (نتيجة/شعور/قيمة للمستخدم) — مختلفة عن features (خصائص المنتج الفيزيائية). ممنوع الخلط بينهم.
6. targetAudience: استنتاج منطقي من لغة الإعلان بس — مش حقيقة مؤكدة، ومتكتبش حاجة عامة زي "الجميع".
7. creativeStyle: مثال UGC / Product Demonstration / Problem-Solution / Before-After / Storytelling / Product Showcase / Testimonial / Lifestyle / Educational / Unboxing / Comparison / Offer-focused / Other.
8. ممنوع اختراع أي حاجة مش مدعومة فعليًا بالنص المعطى.`;

function normalizeAiFields(raw) {
  const hookTypes = Array.isArray(raw.hookTypes) ? raw.hookTypes.filter((t) => HOOK_TYPES.includes(t)) : [];
  return {
    hook: { text: raw.hookText ? String(raw.hookText) : '', types: hookTypes, source: 'AI_ANALYZED' },
    sellingAngle: { value: raw.sellingAngle ? String(raw.sellingAngle) : '', source: 'AI_ANALYZED' },
    problem: { value: raw.problem ? String(raw.problem) : '', source: 'AI_ANALYZED' },
    benefits: { items: Array.isArray(raw.benefits) ? raw.benefits.map(String).filter(Boolean) : [], source: 'AI_ANALYZED' },
    features: { items: Array.isArray(raw.features) ? raw.features.map(String).filter(Boolean) : [], source: 'AI_ANALYZED' },
    targetAudience: { value: raw.targetAudience ? String(raw.targetAudience) : '', source: 'AI_INFERRED' },
    creativeStyle: { value: raw.creativeStyle ? String(raw.creativeStyle) : '', source: 'AI_ANALYZED' },
  };
}

async function aiAnalyze(result, deterministic) {
  const contextLine = `حقايق مستخرجة بالفعل — لا تعيد اشتقاقها: سعر=${deterministic.price.hasPrice ? deterministic.price.value + ' ' + deterministic.price.currency : 'غير موجود'}, خصم=${deterministic.discount.hasDiscount ? (deterministic.discount.percentage ? deterministic.discount.percentage + '%' : 'موجود') : 'غير موجود'}.`;
  const userText = `العنوان: ${result.title || '(بدون عنوان)'}\nنص الإعلان: ${result.snippet || '(بدون نص)'}\n${contextLine}`;
  try {
    const text = await askClaude({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userText }], maxTokens: 600 });
    const parsed = safeJsonParse(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid JSON shape from AI analysis');
    return { ok: true, data: normalizeAiFields(parsed) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Analyzes ONE ad — cache-first, deterministic-first, AI only on a genuine cache miss. Never throws (Step: failure isolation) — a failure comes back as {status:'FAILED', error}. */
export async function analyzeOneAd(result) {
  const metrics = parseMetrics(result);
  const adKey = adKeyFor(result, metrics);

  const cached = await prisma.experimentalAdAnalysisCache.findUnique({
    where: { ad_key_model_version: { ad_key: adKey, model_version: MODEL_VERSION } },
  }).catch(() => null);
  if (cached) {
    logger.info(`${LOG_PREFIX} CACHE_HIT`, { adKey: adKey.slice(0, 12) });
    return { status: 'DONE', analysis: JSON.parse(cached.analysis_json), fromCache: true };
  }

  const deterministic = deterministicExtract(result);
  const ai = await aiAnalyze(result, deterministic);
  if (!ai.ok) {
    logger.error(`${LOG_PREFIX} AI_ANALYSIS_FAILED`, { adKey: adKey.slice(0, 12), message: ai.error });
    return { status: 'FAILED', error: ai.error };
  }

  const analysis = { ...deterministic, ...ai.data, modelVersion: MODEL_VERSION, analyzedAt: new Date().toISOString() };
  await prisma.experimentalAdAnalysisCache.create({
    data: { ad_key: adKey, model_version: MODEL_VERSION, analysis_json: JSON.stringify(analysis) },
  }).catch((err) => logger.error(`${LOG_PREFIX} CACHE_WRITE_FAILED`, { message: err.message }));
  return { status: 'DONE', analysis, fromCache: false };
}

/**
 * Entry point — fired (not awaited) from productResearchExperimental.js
 * right after the main pipeline resolves. Only ever looks at verified-
 * exact Meta Ads Library results for this one search. One ad's failure
 * never stops the batch.
 */
export async function analyzeCompetitorAds(searchId) {
  const qualifying = await prisma.experimentalCreativeResult.findMany({
    where: { search_id: searchId, platform: 'META_AD_LIBRARY', match_decision: 'EXACT' },
  });
  if (qualifying.length === 0) {
    logger.info(`${LOG_PREFIX} NO_QUALIFYING_ADS`, { searchId });
    return;
  }
  logger.info(`${LOG_PREFIX} BATCH_START`, { searchId, count: qualifying.length });
  let done = 0, failed = 0, cached = 0;
  for (const r of qualifying) {
    try {
      const result = await analyzeOneAd(r);
      if (result.fromCache) cached++;
      if (result.status === 'DONE') done++; else failed++;
      await prisma.experimentalCreativeResult.update({
        where: { id: r.id },
        data: {
          ad_analysis_json: result.analysis ? JSON.stringify(result.analysis) : null,
          ad_analysis_status: result.status,
          ad_analyzed_at: new Date(),
        },
      });
    } catch (err) {
      failed++;
      logger.error(`${LOG_PREFIX} AD_UPDATE_FAILED`, { searchId, resultId: r.id, message: err.message });
      await prisma.experimentalCreativeResult.update({ where: { id: r.id }, data: { ad_analysis_status: 'FAILED', ad_analyzed_at: new Date() } }).catch(() => {});
      // Continue to the next ad regardless — one failure never stops the batch.
    }
  }
  logger.info(`${LOG_PREFIX} BATCH_DONE`, { searchId, total: qualifying.length, done, failed, cached });
}

// ============================================================================
// PART 3 — MARKET-LEVEL AGGREGATION. Pure counting/grouping over already-
// analyzed rows, computed fresh on every read (cheap — at most a few dozen
// rows), NEVER hardcoded, NEVER persisted (the underlying ad_analysis_json
// already is).
// ============================================================================

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function distribution(analyses, pick) {
  const counts = new Map();
  for (const a of analyses) {
    const v = pick(a);
    const items = Array.isArray(v) ? v : v ? [v] : [];
    for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  }
  const total = analyses.length || 1;
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, pct: Math.round((count / total) * 1000) / 10 }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Pure aggregation — no AI call here. Reads whatever has been analyzed so
 * far (a batch may still be in progress; the caller sees real partial
 * data, honestly labeled, never a fake "complete" state).
 */
export async function aggregateCompetitorAnalysis(searchId) {
  const qualifying = await prisma.experimentalCreativeResult.findMany({
    where: { search_id: searchId, platform: 'META_AD_LIBRARY', match_decision: 'EXACT' },
  });
  const analyzed = qualifying.filter((r) => r.ad_analysis_status === 'DONE' && r.ad_analysis_json);
  const pending = qualifying.filter((r) => !r.ad_analysis_status || r.ad_analysis_status === 'PENDING').length;
  const failed = qualifying.filter((r) => r.ad_analysis_status === 'FAILED').length;

  const rows = analyzed.map((r) => ({ result: r, analysis: JSON.parse(r.ad_analysis_json), metrics: parseMetrics(r) }));

  const hooks = distribution(rows, (r) => r.analysis.hook?.types || []);
  const sellingAngles = distribution(rows, (r) => r.analysis.sellingAngle?.value).filter((d) => d.value);
  const painPoints = distribution(rows, (r) => r.analysis.problem?.value).filter((d) => d.value);
  const benefits = distribution(rows, (r) => r.analysis.benefits?.items || []);
  const features = distribution(rows, (r) => r.analysis.features?.items || []);
  const ctas = distribution(rows, (r) => r.analysis.cta?.text).filter((d) => d.value);
  const creativeFormats = distribution(rows, (r) => r.analysis.creativeFormat?.value);
  const creativeStyles = distribution(rows, (r) => r.analysis.creativeStyle?.value).filter((d) => d.value);

  const withPrice = rows.filter((r) => r.analysis.price?.hasPrice);
  const byCurrency = {};
  for (const r of withPrice) {
    const cur = r.analysis.price.currency || 'UNKNOWN';
    (byCurrency[cur] ||= []).push(r.analysis.price.value);
  }
  const priceStatsByCurrency = Object.fromEntries(Object.entries(byCurrency).map(([cur, values]) => [
    cur, { count: values.length, min: Math.min(...values), max: Math.max(...values), median: median(values), average: Math.round(values.reduce((a, b) => a + b, 0) / values.length) },
  ]));

  const offerKeys = ['cod', 'freeShipping', 'bundle', 'warranty', 'limitedQuantity'];
  const offerUsage = Object.fromEntries(offerKeys.map((k) => {
    const count = rows.filter((r) => r.analysis.offers?.[k]).length;
    return [k, { count, pct: rows.length ? Math.round((count / rows.length) * 1000) / 10 : 0 }];
  }));
  const discountCount = rows.filter((r) => r.analysis.discount?.hasDiscount).length;
  const urgencyCount = rows.filter((r) => r.analysis.urgency?.present).length;
  const trustElementUsage = distribution(rows, (r) => r.analysis.trustElements?.elements || []);

  // Competitor scorecard — grouped by page/account, real columns only
  // (no ROAS/CPA/Purchases/Revenue — this pipeline has no such data).
  const byAccount = new Map();
  for (const r of rows) {
    const key = r.result.account_name || r.result.account_url || `#${r.result.id}`;
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(r);
  }
  const competitors = [...byAccount.entries()].map(([accountName, group]) => {
    const first = group[0];
    const longevity = computeAdLongevity(first.result.published_at, first.metrics);
    return {
      accountName,
      accountUrl: first.result.account_url,
      adsFound: group.length,
      hook: first.analysis.hook?.types?.[0] || null,
      sellingAngle: first.analysis.sellingAngle?.value || null,
      price: first.analysis.price?.hasPrice ? `${first.analysis.price.value} ${first.analysis.price.currency}` : null,
      discount: first.analysis.discount?.hasDiscount ? (first.analysis.discount.percentage ? `${first.analysis.discount.percentage}%` : 'موجود') : null,
      offer: offerKeys.filter((k) => first.analysis.offers?.[k]).join(', ') || null,
      creativeStyle: first.analysis.creativeStyle?.value || null,
      cta: first.analysis.cta?.text || null,
      adLongevityDays: longevity.days,
      exactProductMatch: true,
      url: first.result.canonical_url,
    };
  }).sort((a, b) => b.adsFound - a.adsFound);

  return {
    adsFound: qualifying.length,
    adsAnalyzed: analyzed.length,
    pending,
    failed,
    batchStatus: qualifying.length === 0 ? 'NONE' : pending > 0 ? 'IN_PROGRESS' : 'DONE',
    hooks,
    sellingAngles,
    painPoints,
    benefits,
    features,
    ctas,
    creativeFormats,
    creativeStyles,
    price: {
      adsAnalyzed: analyzed.length,
      adsWithPrice: withPrice.length,
      visibilityPct: analyzed.length ? Math.round((withPrice.length / analyzed.length) * 1000) / 10 : 0,
      byCurrency: priceStatsByCurrency,
    },
    discountUsageRate: analyzed.length ? Math.round((discountCount / analyzed.length) * 1000) / 10 : 0,
    urgencyUsageRate: analyzed.length ? Math.round((urgencyCount / analyzed.length) * 1000) / 10 : 0,
    trustElementUsage,
    offerUsage,
    competitors,
  };
}

// ============================================================================
// PART 4 — DECISION INTELLIGENCE. One real Claude call PER SEARCH (not per
// ad), fed the already-computed deterministic aggregation above — it only
// ever writes the narrative/recommendation layer, never invents a number.
// Falls back to a deterministic templated summary if the API call fails,
// exactly like the existing aiActionPlan.js pattern.
// ============================================================================

const DECISION_SYSTEM_PROMPT = `إنت مساعد قرارات إعلانية. هتاخد إحصائيات حقيقية محسوبة فعليًا عن إعلانات منافسين حقيقيين (مش تخمين). مهمتك تكتب تحليل نصي بس فوق الأرقام دي، من غير ما تخترع رقم جديد. رجّع JSON بالشكل ده:
{
  "topPatterns": [""],
  "saturatedAngles": [""],
  "underusedAngles": [""],
  "testOpportunities": [{"angle":"","suggestedHook":"","why":"","evidence":"","confidence":"عالية|متوسطة|منخفضة"}],
  "creativeRecommendations": [""],
  "offerPositioning": ""
}
قواعد: 3-5 عناصر في testOpportunities. "underused" مش معناها بالضرورة "أفضل" — نبّه على كده صراحة في why لو محتاج. ممنوع تدّعي إن المنافسين رابحين إلا لو في بيانات أداء حقيقية (مفيش هنا) — ركز على الأنماط والفرص بس.`;

const decisionIntelligenceCache = new Map(); // searchId -> {statsHash, result} — process-lifetime only, same "no new infra" convention as apifyMetaAdLibraryProvider.js's statusCache; safe to lose on restart, regenerated on next request.

function deterministicDecisionFallback(agg) {
  return {
    topPatterns: agg.hooks.slice(0, 3).map((h) => `استخدام هوك "${h.value}" في ${h.pct}% من الإعلانات المحللة`),
    saturatedAngles: agg.sellingAngles.filter((a) => a.pct >= 30).map((a) => a.value),
    underusedAngles: agg.sellingAngles.filter((a) => a.pct > 0 && a.pct < 15).map((a) => a.value),
    testOpportunities: [],
    creativeRecommendations: agg.creativeFormats.slice(0, 2).map((f) => `تجربة صيغة ${f.value} (مستخدمة في ${f.pct}% من الإعلانات المحللة)`),
    offerPositioning: `${agg.discountUsageRate}% من الإعلانات المحللة بتستخدم خصم، و${agg.price.visibilityPct}% بتظهر السعر صراحة.`,
    source: 'DETERMINISTIC_FALLBACK',
  };
}

export async function generateDecisionIntelligence(searchId, agg) {
  if (agg.adsAnalyzed === 0) return null;
  const statsHash = crypto.createHash('sha256').update(JSON.stringify({ hooks: agg.hooks, sellingAngles: agg.sellingAngles, price: agg.price, offerUsage: agg.offerUsage, adsAnalyzed: agg.adsAnalyzed })).digest('hex');
  const cached = decisionIntelligenceCache.get(searchId);
  if (cached && cached.statsHash === statsHash) return cached.result;

  let result;
  try {
    const text = await askClaude({
      system: DECISION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify({
        adsAnalyzed: agg.adsAnalyzed,
        hooks: agg.hooks, sellingAngles: agg.sellingAngles, painPoints: agg.painPoints,
        benefits: agg.benefits, features: agg.features, price: agg.price,
        discountUsageRate: agg.discountUsageRate, urgencyUsageRate: agg.urgencyUsageRate,
        offerUsage: agg.offerUsage, creativeFormats: agg.creativeFormats, creativeStyles: agg.creativeStyles,
      }) }],
      maxTokens: 1400,
    });
    const parsed = safeJsonParse(text);
    if (!parsed || !Array.isArray(parsed.testOpportunities)) throw new Error('invalid decision-intelligence JSON shape');
    result = { ...parsed, source: 'AI_ANALYZED' };
  } catch (err) {
    logger.error(`${LOG_PREFIX} DECISION_INTELLIGENCE_FAILED`, { searchId, message: err.message });
    result = deterministicDecisionFallback(agg);
  }
  decisionIntelligenceCache.set(searchId, { statsHash, result });
  return result;
}
