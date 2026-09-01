// productResearchAI.js — every place Claude is used inside Product Research:
// (1) product analysis (turns raw user input into a structured profile),
// (2) search query generation, (3) batch result ranking. Claude is NEVER the
// search engine itself — it only understands the product and classifies
// results real search providers already found (see searchProviders/*).
//
// Every call here asks for strict JSON and validates the shape before
// trusting it (Step 36) — an invalid/unparseable response never crashes the
// pipeline, it falls back to a safe, honestly-labelled default instead.
import { askClaude } from './ai.js';
import { logger } from '../logger.js';

const ARRAY_FIELDS = [
  'possible_names_ar', 'possible_names_en', 'alternative_names', 'supplier_names', 'generic_names',
  'benefits', 'problems_solved', 'features', 'use_cases', 'target_audience',
  'keywords_ar', 'keywords_en', 'visual_identifiers', 'negative_keywords',
];

function safeJsonParse(text) {
  // Claude sometimes wraps JSON in ```json fences despite instructions not to — strip them defensively.
  const stripped = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/**
 * Step 2 — Claude Product Analysis. Merges onto (never overwrites) the
 * user's own input. Returns {profile, source: 'ai'|'fallback'}.
 * @param {{productName: string, possibleNames?: string[], namesAr?: string[], namesEn?: string[], keywords?: string[], description?: string, imageBase64?: string, imageMediaType?: string}} input
 */
export async function analyzeProduct(input) {
  const system = `إنت محلل منتجات لأداة بحث منافسين وكونتنت تسويقي. مهمتك تفهم المنتج وترجّع JSON فقط، بدون أي نص تاني قبله أو بعده، بدون Markdown fences.

الشكل المطلوب بالظبط:
{
  "main_product_name": "",
  "product_category": "",
  "product_description": "",
  "possible_names_ar": [],
  "possible_names_en": [],
  "alternative_names": [],
  "supplier_names": [],
  "generic_names": [],
  "benefits": [],
  "problems_solved": [],
  "features": [],
  "use_cases": [],
  "target_audience": [],
  "keywords_ar": [],
  "keywords_en": [],
  "visual_identifiers": [],
  "negative_keywords": []
}

قواعد: كل الحقول array لازم تكون array من نصوص قصيرة (مش جملة طويلة). negative_keywords يعني كلمات لازم البحث يتجنبها (منتجات تانية بنفس الاسم بس مختلفة). لو معلومة مش متاحة من الوصف المعطى، سيب الـ array فاضي، متخترعش حاجة.`;

  const userParts = [];
  userParts.push(`اسم المنتج الرئيسي: ${input.productName}`);
  if (input.possibleNames?.length) userParts.push(`أسماء محتملة: ${input.possibleNames.join('، ')}`);
  if (input.namesAr?.length) userParts.push(`أسماء عربي: ${input.namesAr.join('، ')}`);
  if (input.namesEn?.length) userParts.push(`أسماء إنجليزي: ${input.namesEn.join('، ')}`);
  if (input.keywords?.length) userParts.push(`كلمات مفتاحية إضافية: ${input.keywords.join('، ')}`);
  if (input.description) userParts.push(`وصف: ${input.description}`);

  const content = input.imageBase64
    ? [
        { type: 'text', text: userParts.join('\n') },
        { type: 'image', source: { type: 'base64', media_type: input.imageMediaType || 'image/jpeg', data: input.imageBase64 } },
      ]
    : userParts.join('\n');

  try {
    const text = await askClaude({ system, messages: [{ role: 'user', content }], maxTokens: 1500 });
    const parsed = safeJsonParse(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid JSON shape');

    const profile = { main_product_name: String(parsed.main_product_name || input.productName), product_category: String(parsed.product_category || ''), product_description: String(parsed.product_description || input.description || '') };
    for (const f of ARRAY_FIELDS) profile[f] = Array.isArray(parsed[f]) ? parsed[f].map(String).filter(Boolean) : [];
    return { profile, source: 'ai' };
  } catch (err) {
    logger.error('PRODUCT_RESEARCH_AI_ANALYSIS_FAILED', { message: err.message });
    // Honest fallback — never invents fields, just echoes user input into the same shape so the pipeline can continue.
    const profile = {
      main_product_name: input.productName,
      product_category: '',
      product_description: input.description || '',
      possible_names_ar: input.namesAr || [],
      possible_names_en: input.namesEn || [],
      alternative_names: input.possibleNames || [],
      supplier_names: [], generic_names: [], benefits: [], problems_solved: [], features: [],
      use_cases: [], target_audience: [],
      keywords_ar: (input.namesAr || []).length ? input.namesAr : [], keywords_en: input.keywords || [],
      visual_identifiers: [], negative_keywords: [],
    };
    return { profile, source: 'fallback' };
  }
}

/**
 * Step 3 — Search Query Generator. Deterministic assembly from the
 * (Claude-enriched) profile — no extra Claude call needed since the profile
 * already contains every name/keyword variant; this just combines them into
 * platform-aware query strings and caps the total per MAX_QUERIES_PER_SEARCH.
 * @param {object} profile from analyzeProduct()
 * @param {string[]} platforms
 * @returns {{platform: string, query: string, queryType: string}[]}
 */
export function generateSearchQueries(profile, platforms) {
  const maxQueries = Number(process.env.MAX_QUERIES_PER_SEARCH) || 24;
  const named = [
    ...(profile.possible_names_ar || []).map((q) => ({ q, t: 'ARABIC_NAME' })),
    ...(profile.possible_names_en || []).map((q) => ({ q, t: 'ENGLISH_NAME' })),
    { q: profile.main_product_name, t: 'EXACT_NAME' },
    ...(profile.alternative_names || []).map((q) => ({ q, t: 'ALTERNATIVE_NAME' })),
    ...(profile.generic_names || []).map((q) => ({ q, t: 'GENERIC' })),
  ];
  const descriptive = [
    ...(profile.features || []).slice(0, 3).map((q) => ({ q, t: 'FEATURE' })),
    ...(profile.benefits || []).slice(0, 2).map((q) => ({ q, t: 'BENEFIT' })),
    ...(profile.problems_solved || []).slice(0, 2).map((q) => ({ q, t: 'PROBLEM' })),
  ];

  // Priority order matches Step 22: exact/alternative/named first, descriptive last.
  const seen = new Set();
  const uniqueTerms = [];
  for (const item of [...named, ...descriptive]) {
    const q = (item.q || '').trim();
    if (!q || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    uniqueTerms.push(item);
  }

  const queries = [];
  for (const platform of platforms) {
    for (const { q, t } of uniqueTerms) {
      if (queries.filter((x) => x.platform === platform).length >= maxQueries) break;
      queries.push({ platform, query: q, queryType: t });
    }
  }
  return queries;
}

/**
 * Three-tier query set for Meta Ads Library staged discovery (services/
 * searchProviders/metaAdLibraryProvider.js runStagedSearch): HIGH_PRECISION
 * runs first (exact/alternative/named-variant terms — low false-positive
 * risk), MEDIUM_PRECISION only if that wasn't enough (generic
 * names/keywords), BROAD_DISCOVERY only as a last resort (single
 * descriptive terms — most likely to surface unrelated ads too, which is
 * exactly why it's the last tier tried, not the first). Never invents a
 * term the product profile doesn't actually have.
 * @param {object} profile
 * @returns {{high: string[], medium: string[], broad: string[]}}
 */
export function generateAdLibraryTieredQueries(profile) {
  const dedupe = (arr) => {
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
      const q = (raw || '').trim();
      if (!q || seen.has(q.toLowerCase())) continue;
      seen.add(q.toLowerCase());
      out.push(q);
    }
    return out;
  };

  const high = dedupe([profile.main_product_name, ...(profile.alternative_names || []), ...(profile.possible_names_ar || []), ...(profile.possible_names_en || [])]);
  const highSet = new Set(high.map((q) => q.toLowerCase()));
  const medium = dedupe([...(profile.generic_names || []), ...(profile.keywords_ar || []), ...(profile.keywords_en || [])]).filter((q) => !highSet.has(q.toLowerCase()));
  const mediumSet = new Set(medium.map((q) => q.toLowerCase()));
  const broad = dedupe([...(profile.benefits || []), ...(profile.features || []), ...(profile.problems_solved || [])])
    .filter((q) => !highSet.has(q.toLowerCase()) && !mediumSet.has(q.toLowerCase()))
    .slice(0, 4); // broad terms are the highest false-positive risk — keep this tier small even before any raw-limit cost cap applies

  return { high, medium, broad };
}

/**
 * Step 8 — Claude AI Result Ranking, batched (one call ranks many results,
 * per Step 21's "don't call Claude once per result"). Only sends the
 * normalized metadata a result already has, never a huge raw payload.
 * @param {object} profile
 * @param {object[]} results normalized ProductResearchResult-shaped rows (need id, platform, title, snippet, account_name, content_type)
 * @returns {Promise<Map<number, {classification: string, match_score: number, confidence_score: number, reason: string}>>}
 */
export async function rankResultsBatch(profile, results) {
  if (results.length === 0) return new Map();
  const maxToRank = Number(process.env.MAX_AI_RANKING_RESULTS) || 60;
  const batch = results.slice(0, maxToRank);

  // Full product identity, not just the main name — an Arabic-titled post
  // matching an alternative/Arabic name variant, or a listing whose visual
  // description matches visual_identifiers, is a real match Claude would
  // otherwise miss if only main_product_name/category/description were given.
  const nameVariants = [...(profile.alternative_names || []), ...(profile.possible_names_ar || []), ...(profile.possible_names_en || []), ...(profile.generic_names || [])]
    .filter((n) => n && n !== profile.main_product_name);
  const keywords = [...(profile.keywords_ar || []), ...(profile.keywords_en || [])];

  const system = `إنت بتصنف نتائج بحث حقيقية (مش انت اللي بحثت) عشان تحدد أي واحدة فعلاً بتخص نفس المنتج ده. اعتبر أي اسم من الأسماء البديلة أو الكلمات المفتاحية دي بنفس وزن الاسم الرئيسي — النتيجة ممكن تستخدم أي واحد منهم:

الاسم الرئيسي: ${profile.main_product_name}
الفئة: ${profile.product_category || 'غير محدد'}
الوصف: ${profile.product_description || 'غير متاح'}
${nameVariants.length ? `أسماء بديلة (عربي/إنجليزي): ${nameVariants.join('، ')}` : ''}
${keywords.length ? `كلمات مفتاحية: ${keywords.join('، ')}` : ''}
${profile.visual_identifiers?.length ? `صفات بصرية (من تحليل صورة المنتج): ${profile.visual_identifiers.join('، ')}` : ''}
${profile.negative_keywords?.length ? `كلمات لازم تستبعد النتيجة لو ظهرت (منتج مختلف بنفس الاسم تقريبًا): ${profile.negative_keywords.join('، ')}` : ''}

لكل نتيجة، صنّفها بناءً على العنوان والوصف والحساب المعطى بس — قارنها بكل الأسماء/الكلمات فوق مش بس الاسم الرئيسي:
EXACT_MATCH | VERY_SIMILAR | SIMILAR | RELATED | IRRELEVANT
مع match_score (0-100) و confidence_score (0-100) و reason (سطر واحد بالعربي، لازم يعتمد على البيانات المعطاة بس ويقول أي اسم/كلمة طابقت، متخترعش حاجة مش موجودة في النص).

رجّع JSON array فقط بالشكل ده، بنفس عدد وترتيب النتائج المُدخلة:
[{"id": 0, "classification": "", "match_score": 0, "confidence_score": 0, "reason": ""}]`;

  const userContent = JSON.stringify(
    batch.map((r, i) => ({ id: i, platform: r.platform, content_type: r.content_type, title: r.title, snippet: r.snippet, account_name: r.account_name }))
  );

  const map = new Map();
  try {
    const text = await askClaude({ system, messages: [{ role: 'user', content: userContent }], maxTokens: 4000 });
    const parsed = safeJsonParse(text);
    if (!Array.isArray(parsed)) throw new Error('invalid JSON shape — expected array');
    for (const item of parsed) {
      const idx = Number(item.id);
      if (!Number.isInteger(idx) || !batch[idx]) continue;
      const validClass = ['EXACT_MATCH', 'VERY_SIMILAR', 'SIMILAR', 'RELATED', 'IRRELEVANT'].includes(item.classification) ? item.classification : 'RELATED';
      map.set(batch[idx]._localId, {
        classification: validClass,
        match_score: Math.max(0, Math.min(100, Number(item.match_score) || 0)),
        confidence_score: Math.max(0, Math.min(100, Number(item.confidence_score) || 0)),
        reason: String(item.reason || ''),
      });
    }
  } catch (err) {
    logger.error('PRODUCT_RESEARCH_AI_RANKING_FAILED', { message: err.message });
    // Honest fallback: mark as unranked rather than guessing a score.
    for (const r of batch) map.set(r._localId, { classification: 'RELATED', match_score: null, confidence_score: null, reason: 'التصنيف بالـ AI فشل — النتيجة معروضة من غير تقييم.' });
  }
  return map;
}

const CONTENT_FIELDS = ['hook', 'product_angle', 'benefit', 'problem', 'audience', 'offer', 'price', 'cta', 'creative_type', 'format', 'content_style'];

/**
 * Step 13 — per-result Content/Creative Intelligence. Only ever reasons
 * from the metadata this specific result already has (title/snippet/
 * account) — never invents a hook, price, or CTA that isn't actually
 * inferable from that text. Any field Claude can't support from the given
 * text comes back null, never guessed.
 * @param {{title: string|null, snippet: string|null, accountName: string|null, contentType: string, platform: string}} result
 */
export async function analyzeContent(result) {
  const system = `إنت بتحلل قطعة كونتنت تسويقي حقيقية (منشور/فيديو) بناءً على العنوان والوصف المتاحين بس. رجّع JSON فقط بالشكل ده:
{"hook":null,"product_angle":null,"benefit":null,"problem":null,"audience":null,"offer":null,"price":null,"cta":null,"creative_type":null,"format":null,"content_style":null}

قاعدة صارمة: لو المعلومة مش واضحة فعليًا من النص المعطى، رجّع null لنفس الحقل — ممنوع تخترع أو تخمن أي حاجة مش موجودة في النص.`;
  const userContent = `المنصة: ${result.platform}\nنوع المحتوى: ${result.contentType}\nالحساب: ${result.accountName || 'غير معروف'}\nالعنوان: ${result.title || 'غير متاح'}\nالوصف: ${result.snippet || 'غير متاح'}`;

  try {
    const text = await askClaude({ system, messages: [{ role: 'user', content: userContent }], maxTokens: 600 });
    const parsed = safeJsonParse(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid JSON shape');
    const analysis = {};
    for (const f of CONTENT_FIELDS) analysis[f] = parsed[f] ? String(parsed[f]) : null;
    return { ...analysis, source: 'ai' };
  } catch (err) {
    logger.error('PRODUCT_RESEARCH_CONTENT_ANALYSIS_FAILED', { message: err.message });
    const analysis = Object.fromEntries(CONTENT_FIELDS.map((f) => [f, null]));
    return { ...analysis, source: 'unavailable' };
  }
}
