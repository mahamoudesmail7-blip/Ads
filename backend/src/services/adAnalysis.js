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
import { classify as healthClassify } from './providerHealth.js';

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
// RULE-BASED HOOK/ANGLE FALLBACK — used whenever Claude is unavailable
// (Step: Part 6B). Every tag maps to a real keyword/pattern match against
// the actual ad title+snippet text; a category with no textual evidence
// is never guessed — 'UNKNOWN' instead. Shares the exact HOOK_TYPES
// vocabulary the AI path uses (below) so aggregation never has to
// reconcile two different taxonomies.
// ============================================================================

const HOOK_RULES = [
  { type: 'Fear', regex: /خطر|تجسس|مراقب|اختراق|يتجسس|تُراقب|احمِ نفسك|حماية|أمان/ },
  { type: 'Problem', regex: /مشكلة|بتعاني|تعبت من|تعاني من|زهقت من/ },
  { type: 'Curiosity', regex: /هل تعلم|تعرف إن|فاكر|تخيل لو|عارف إن/ },
  { type: 'Demonstration', regex: /شاهد كيف|شوف إزاي|جرب دلوقتي|طريقة الاستخدام|بالفيديو/ },
  { type: 'Social Proof', regex: /تقييم|عميل راضي|الأكثر مبيعًا|آلاف العملاء|طلب تم/ },
  { type: 'Convenience', regex: /سهل الاستخدام|في دقيقة|بساطة|بدون تعقيد/ },
  { type: 'Benefit', regex: /يساعدك|يوفر لك|هتحس|راحة تامة|هتلاحظ الفرق/ },
];

/** Real, evidence-based hook classification — never invents a category. */
function ruleBasedHook(title, snippet, deterministic) {
  const text = `${title || ''} ${snippet || ''}`;
  const types = new Set();
  const firstLine = (title || snippet || '').split(/[\n.!]/)[0] || '';
  if (firstLine.includes('؟')) types.add('Question');
  for (const { type, regex } of HOOK_RULES) if (regex.test(text)) types.add(type);
  if (deterministic.price.hasPrice) types.add('Price');
  if (deterministic.discount.hasDiscount) types.add('Discount');
  if (deterministic.urgency.present) types.add('Urgency');
  if (types.size === 0) types.add('UNKNOWN');
  return { text: firstLine.trim().slice(0, 140), types: [...types], source: 'RULE_BASED' };
}

const ANGLE_RULES = [
  { angle: 'Security', regex: /أمان|حماية|خطر|تجسس|مراقبة|اختراق/ },
  { angle: 'Privacy', regex: /خصوصية|سرية|أسرارك/ },
  { angle: 'Convenience', regex: /سهل|سهولة|بساطة|في دقايق|بدون مجهود/ },
  { angle: 'Portability', regex: /محمول|خفيف|صغير الحجم|يتحرك معاك|سهل الحمل/ },
  { angle: 'Technology', regex: /تقنية|ذكي|تكنولوجيا|رقمي/ },
  { angle: 'Home Use', regex: /في البيت|للمنزل|الاستخدام المنزلي/ },
];

/** Real, evidence-based selling-angle classification — 'UNKNOWN' when nothing in the text supports a category. */
function ruleBasedAngle(title, snippet, deterministic) {
  const text = `${title || ''} ${snippet || ''}`;
  for (const { angle, regex } of ANGLE_RULES) if (regex.test(text)) return { value: angle, source: 'RULE_BASED' };
  if (deterministic.discount.hasDiscount || deterministic.price.hasPrice) return { value: 'Price/Value', source: 'RULE_BASED' };
  return { value: 'UNKNOWN', source: 'RULE_BASED' };
}

function ruleBasedAnalyze(result, deterministic) {
  return {
    hook: ruleBasedHook(result.title, result.snippet, deterministic),
    sellingAngle: ruleBasedAngle(result.title, result.snippet, deterministic),
    problem: { value: '', source: 'RULE_BASED' }, // needs real semantic judgment — never guessed deterministically
    benefits: { items: [], source: 'RULE_BASED' },
    features: { items: [], source: 'RULE_BASED' },
    targetAudience: { value: '', source: 'RULE_BASED' },
    creativeStyle: { value: '', source: 'RULE_BASED' },
  };
}

// Mirrors the exact anthropicWorthTrying() pattern already established in
// productVisionService.js — checked ONCE per ad before ever attempting a
// call, so once Claude proves itself unavailable (e.g. insufficient
// credits) for the first ad in a batch, every remaining ad in that batch
// (and every ad in every later search, until Anthropic recovers) skips
// straight to the rule-based fallback instead of each paying its own
// failing network round-trip.
function anthropicWorthTrying() {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return false;
  return healthClassify('anthropic', true).status !== 'ERROR';
}

// ============================================================================
// AI SEMANTIC ANALYSIS — one text-only Claude call per ad, only for fields
// that genuinely need judgment. The already-deterministic fields are given
// to Claude as context so it never re-derives (and potentially
// contradicts) price/discount/offers itself.
// ============================================================================

const HOOK_TYPES = ['Question', 'Problem', 'Pain', 'Curiosity', 'Benefit', 'Price', 'Discount', 'Demonstration', 'Before/After', 'Social Proof', 'Fear', 'Convenience', 'Lifestyle', 'Gift', 'Urgency', 'Product Reveal', 'Educational', 'Story', 'Other', 'UNKNOWN'];

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

/**
 * Analyzes ONE ad — cache-first, deterministic-first, AI only when
 * genuinely worth trying. Never throws (Step: failure isolation).
 *
 * FIXED real production bug (found by inspecting live data, not assumed):
 * this used to discard the perfectly good deterministic fields entirely
 * whenever the AI call failed, returning only {status:'FAILED'} with no
 * analysis_json at all — with Anthropic's account out of credits, this
 * meant EVERY ad analysis in production was silently thrown away, full
 * stop, regardless of how much real price/discount/offer/CTA data had
 * already been extracted for free. Deterministic fields (plus a rule-
 * based hook/selling-angle fallback, never a guess) are now ALWAYS
 * persisted — only the semantic layer's source flips between
 * 'AI_ANALYZED'/'AI_INFERRED' and 'RULE_BASED' depending on what actually
 * ran.
 */
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
  const worthTrying = anthropicWorthTrying();
  const ai = worthTrying ? await aiAnalyze(result, deterministic) : { ok: false, error: 'Anthropic not worth trying (circuit open or unconfigured)' };

  let semantic, status;
  if (ai.ok) {
    semantic = ai.data;
    status = 'DONE';
  } else {
    if (worthTrying) logger.error(`${LOG_PREFIX} AI_ANALYSIS_FAILED`, { adKey: adKey.slice(0, 12), message: ai.error });
    semantic = ruleBasedAnalyze(result, deterministic);
    status = 'DETERMINISTIC_ONLY';
  }

  const analysis = { ...deterministic, ...semantic, modelVersion: MODEL_VERSION, analyzedAt: new Date().toISOString() };

  // Only a REAL AI result is cached — a deterministic-only result must
  // never be permanently stuck for this ad; the next time it's
  // encountered (this search's own re-analysis is deduped elsewhere, but
  // a DIFFERENT future search finding the same ad) Anthropic gets a fresh
  // chance once it's healthy again, at zero extra cost either way (the
  // deterministic/rule-based pass is free to recompute).
  if (status === 'DONE') {
    await prisma.experimentalAdAnalysisCache.create({
      data: { ad_key: adKey, model_version: MODEL_VERSION, analysis_json: JSON.stringify(analysis) },
    }).catch((err) => logger.error(`${LOG_PREFIX} CACHE_WRITE_FAILED`, { message: err.message }));
  }
  return { status, analysis, fromCache: false };
}

/**
 * Entry point — fired (not awaited) from productResearchExperimental.js
 * right after the main pipeline resolves.
 *
 * Step: Part 5 — widened from strictly match_decision:'EXACT' to
 * `ignored:false` (EXACT + REVIEW + never-visually-compared/null) —
 * REJECT is the only thing `ignored:true` ever sets, so it stays
 * categorically excluded. A result that was never compared (e.g. beyond
 * the visual-comparison cap) was never DISQUALIFIED either — analyzing it
 * and honestly labeling it "unverified" is strictly better than the old
 * behavior of silently finding zero qualifying ads and leaving the whole
 * panel looking broken, which is exactly what happened on the real
 * production searches this fix was diagnosed against (0 EXACT, 0 REVIEW,
 * 70 never-compared, out of 100 real Meta ads). Market-level percentage
 * aggregates still only ever draw from EXACT+REVIEW rows (see
 * aggregateCompetitorAnalysis) — this widening is about not silently
 * discarding per-ad analysis, never about polluting the stats.
 */
export async function analyzeCompetitorAds(searchId) {
  const qualifying = await prisma.experimentalCreativeResult.findMany({
    where: { search_id: searchId, platform: 'META_AD_LIBRARY', ignored: false },
  });
  if (qualifying.length === 0) {
    logger.info(`${LOG_PREFIX} NO_QUALIFYING_ADS`, { searchId });
    return;
  }
  logger.info(`${LOG_PREFIX} BATCH_START`, { searchId, count: qualifying.length });
  let done = 0, deterministicOnly = 0, failed = 0, cached = 0;
  for (const r of qualifying) {
    try {
      const result = await analyzeOneAd(r);
      if (result.fromCache) cached++;
      if (result.status === 'DONE') done++; else deterministicOnly++;
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
  logger.info(`${LOG_PREFIX} BATCH_DONE`, { searchId, total: qualifying.length, done, deterministicOnly, failed, cached });
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

/** Real, honest AI-availability status (Step: Part 11) — reads the SAME providerHealth tracker every real Anthropic call already feeds, never a synthetic probe. Distinguishes the specific insufficient-credits condition from a generic transient error so the UI banner can say something genuinely useful instead of a mysterious "AI failed". */
export function getAiStatus() {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return { status: 'NOT_CONFIGURED', label: 'الذكاء الاصطناعي غير مفعّل في هذا النظام.' };
  const health = healthClassify('anthropic', true);
  if (health.status === 'CONNECTED') return { status: 'AVAILABLE', label: 'تحليل AI مكتمل' };
  if (health.lastErrorType === 'INSUFFICIENT_CREDITS') return { status: 'DEGRADED_NO_CREDITS', label: 'تحليل AI غير متاح — تم استخدام التحليل المحلي (رصيد Anthropic غير كافٍ)' };
  return { status: 'DEGRADED_ERROR', label: 'تحليل AI غير متاح مؤقتًا — تم استخدام التحليل المحلي' };
}

/**
 * Pure aggregation — no AI call here. Reads whatever has been analyzed so
 * far (a batch may still be in progress; the caller sees real partial
 * data, honestly labeled, never a fake "complete" state).
 *
 * Step: Part 5/9 — explicit buckets, never a silently-empty panel.
 * `qualifying` now covers everything analyzeCompetitorAds() analyzes
 * (EXACT + REVIEW + never-compared/null, i.e. ignored:false) so per-ad
 * analysis (hook/price/offer/etc.) is available and shown for all of
 * them. Market-level PERCENTAGE aggregates below are deliberately
 * restricted to `statsRows` (EXACT + REVIEW only) — an unverified ad was
 * never confirmed to even be the right product, so it's shown honestly
 * (counted, individually analyzable) but never allowed to skew "most
 * common hook/angle/price" stats. REJECT never appears anywhere here at
 * all (excluded by `ignored:false` at the query level already).
 */
export async function aggregateCompetitorAnalysis(searchId) {
  const [qualifying, rejectedCount] = await Promise.all([
    prisma.experimentalCreativeResult.findMany({ where: { search_id: searchId, platform: 'META_AD_LIBRARY', ignored: false } }),
    prisma.experimentalCreativeResult.count({ where: { search_id: searchId, platform: 'META_AD_LIBRARY', match_decision: 'REJECT' } }),
  ]);
  const analyzed = qualifying.filter((r) => (r.ad_analysis_status === 'DONE' || r.ad_analysis_status === 'DETERMINISTIC_ONLY') && r.ad_analysis_json);
  const pending = qualifying.filter((r) => !r.ad_analysis_status).length;
  const failed = qualifying.filter((r) => r.ad_analysis_status === 'FAILED').length;
  const buckets = {
    metaAdsFound: qualifying.length + rejectedCount,
    verifiedExact: qualifying.filter((r) => r.match_decision === 'EXACT').length,
    possibleReview: qualifying.filter((r) => r.match_decision === 'REVIEW').length,
    unverified: qualifying.filter((r) => r.match_decision === null).length,
    rejected: rejectedCount,
    analyzed: analyzed.length,
    analysisFailed: failed,
  };

  // Stats-eligible = analyzed AND confirmed EXACT or REVIEW — never the unverified bucket (see comment above).
  const statsRows = analyzed.filter((r) => r.match_decision === 'EXACT' || r.match_decision === 'REVIEW');
  const rows = statsRows.map((r) => ({ result: r, analysis: JSON.parse(r.ad_analysis_json), metrics: parseMetrics(r) }));

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
  // Part 10 — video-vs-image ratio is just creativeFormats re-read; kept as
  // its own named field since the decision assistant references it directly.
  const formatRatio = { video: creativeFormats.find((f) => f.value === 'Video')?.count || 0, image: creativeFormats.find((f) => f.value === 'Image')?.count || 0 };

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
      matchDecision: first.result.match_decision, // EXACT | REVIEW — honest, never hardcoded true (this scorecard is built only from statsRows, so it's always one of these two)
      url: first.result.canonical_url,
    };
  }).sort((a, b) => b.adsFound - a.adsFound);

  return {
    // Kept for back-compat with the existing frontend field names.
    adsFound: qualifying.length,
    adsAnalyzed: analyzed.length,
    pending,
    failed,
    batchStatus: qualifying.length === 0 ? 'NONE' : pending > 0 ? 'IN_PROGRESS' : 'DONE',
    buckets,
    aiStatus: getAiStatus(),
    statsBasedOnCount: rows.length, // how many of `adsAnalyzed` actually fed the percentages below (EXACT+REVIEW only)
    hooks,
    sellingAngles,
    painPoints,
    benefits,
    features,
    ctas,
    creativeFormats,
    creativeStyles,
    formatRatio,
    price: {
      adsAnalyzed: rows.length,
      adsWithPrice: withPrice.length,
      visibilityPct: rows.length ? Math.round((withPrice.length / rows.length) * 1000) / 10 : 0,
      byCurrency: priceStatsByCurrency,
    },
    discountUsageRate: rows.length ? Math.round((discountCount / rows.length) * 1000) / 10 : 0,
    urgencyUsageRate: rows.length ? Math.round((urgencyCount / rows.length) * 1000) / 10 : 0,
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
قواعد: 3-5 عناصر في testOpportunities. "underused" مش معناها بالضرورة "أفضل" — نبّه على كده صراحة في why لو محتاج. ممنوع تدّعي إن المنافسين رابحين إلا لو في بيانات أداء حقيقية (مفيش هنا) — ركز على الأنماط والفرص بس. استخدم عبارة "يستحق الاختبار" لأي زاوية أو صيغة مقترحة — ممنوع تمامًا كلمة "رابحة" أو "فايزة" أو أي وصف بيدّعي نتيجة أداء حقيقية غير موجودة.`;

const decisionIntelligenceCache = new Map(); // searchId -> {statsHash, result} — process-lifetime only, same "no new infra" convention as apifyMetaAdLibraryProvider.js's statusCache; safe to lose on restart, regenerated on next request.

function deterministicDecisionFallback(agg) {
  const topCta = agg.ctas[0];
  const dominantFormat = agg.formatRatio.video >= agg.formatRatio.image ? `فيديو (${agg.formatRatio.video})` : `صورة (${agg.formatRatio.image})`;
  const topPainPoint = agg.painPoints[0];
  return {
    topPatterns: [
      ...agg.hooks.slice(0, 3).map((h) => `استخدام هوك "${h.value}" في ${h.pct}% من الإعلانات المحللة`),
      `الصيغة الأكثر استخدامًا: ${dominantFormat}`,
      topCta ? `الـCTA الأكثر استخدامًا: "${topCta.value}" (${topCta.pct}%)` : null,
    ].filter(Boolean),
    saturatedAngles: agg.sellingAngles.filter((a) => a.pct >= 30).map((a) => a.value),
    underusedAngles: agg.sellingAngles.filter((a) => a.pct > 0 && a.pct < 15).map((a) => a.value),
    // Never a claim of a "winning" angle without real performance data —
    // deliberately empty in the deterministic fallback (a genuine "worth
    // testing" recommendation needs real judgment, not a keyword count).
    testOpportunities: [],
    creativeRecommendations: agg.creativeFormats.slice(0, 2).map((f) => `${f.value} يستحق الاختبار (مستخدم بالفعل في ${f.pct}% من الإعلانات المحللة عند المنافسين)`),
    offerPositioning: `${agg.discountUsageRate}% من الإعلانات المحللة بتستخدم خصم، و${agg.price.visibilityPct}% بتظهر السعر صراحة.`
      + (topPainPoint ? ` أكتر نقطة ألم بيركزوا عليها: "${topPainPoint.value}".` : ''),
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
        adsAnalyzed: agg.statsBasedOnCount,
        hooks: agg.hooks, sellingAngles: agg.sellingAngles, painPoints: agg.painPoints,
        benefits: agg.benefits, features: agg.features, price: agg.price,
        discountUsageRate: agg.discountUsageRate, urgencyUsageRate: agg.urgencyUsageRate,
        offerUsage: agg.offerUsage, creativeFormats: agg.creativeFormats, creativeStyles: agg.creativeStyles,
        ctas: agg.ctas, formatRatio: agg.formatRatio,
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
