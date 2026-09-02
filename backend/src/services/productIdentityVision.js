// productIdentityVision.js — EXPERIMENTAL, Internal Creative Discovery only.
// Stage A of the image-only workflow: one real Claude vision call turns an
// uploaded product photo into a rich, structured Product Identity Profile
// (name candidates, Arabic/English aliases, keywords, description, brand/
// model, OCR text, a detailed visual fingerprint, distinctive features —
// every field carrying its own honest confidence). Every value here is
// Claude's own real assessment of the real uploaded image — nothing is
// invented by this file; fields Claude can't support from the image come
// back null/empty, never guessed (brand/model especially — see the
// system prompt's explicit "do not guess" instruction).
//
// This module is never imported by the real Product Research pipeline —
// only by services/experimentalCreativeDiscovery.js.
import crypto from 'crypto';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { askClaude } from './ai.js';

// Bumped whenever the prompt/output shape changes, so a stale cached
// profile is never served against code expecting a different shape
// (Step 27's cache key is [image_hash, model_version] specifically so this
// bump alone invalidates every old cache entry safely).
const MODEL_VERSION = 'identity-v1';

function safeJsonParse(text) {
  const stripped = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  try { return JSON.parse(stripped); } catch { return null; }
}

function hashImage(imageBase64) {
  return crypto.createHash('sha256').update(imageBase64).digest('hex');
}

const SYSTEM_PROMPT = `إنت خبير في التعرف على المنتجات من الصور لأداة بحث منافسين. اتفرج على الصورة كويس وارجع JSON فقط بالشكل ده بالظبط، من غير أي نص تاني قبله أو بعده ومن غير Markdown fences:

{
  "mainProductName": "",
  "mainProductNameConfidence": 0,
  "candidateNames": [],
  "alternativeNames": [],
  "arabicNames": [],
  "englishNames": [],
  "keywords": [],
  "description": "",
  "productCategory": "",
  "specificCategory": "",
  "categoryConfidence": 0,
  "brand": null,
  "brandConfidence": 0,
  "model": null,
  "modelConfidence": 0,
  "visibleText": [],
  "distinctiveFeatures": [],
  "visualFingerprint": {
    "overallShape": "",
    "silhouette": "",
    "bodyGeometry": "",
    "mainColors": [],
    "secondaryColors": [],
    "materialAppearance": "",
    "buttons": "",
    "screen": "",
    "handle": "",
    "head": "",
    "openings": "",
    "ports": "",
    "attachments": "",
    "uniqueContours": "",
    "distinctivePhysicalFeatures": [],
    "visibleBrand": null,
    "visibleModel": null,
    "visibleText": []
  },
  "visualFingerprintConfidence": 0,
  "multipleProductsDetected": false,
  "imageQualityIssues": [],
  "overallConfidence": 0
}

قواعد صارمة، اتبعها بالظبط:

1. mainProductName: لازم يكون اسم منتج محدد وواضح يوصف الحاجة المرئية فعليًا، مش اسم عام. مثال غلط: "جهاز" أو "أداة" أو "مساج" أو "منظف". مثال صح: "جهاز مساج فروة الرأس الكهربائي" أو "قصافة أظافر برأس مائل" أو "جهاز قياس ضغط أوتوماتيكي للذراع".

2. candidateNames: لو مش متأكد 100% من الاسم الرئيسي، حط كذا اسم بديل محتمل هنا (array) عشان البحث ميعتمدش على تخمين واحد بس.

3. alternativeNames/arabicNames/englishNames: أسماء بحث حقيقية ومفيدة بس (أسماء شائعة، أسماء تجارة إلكترونية، صيغ وصفية معقولة) — ممنوع اختراع أسماء غير منطقية.

4. keywords: كلمات بحث قوية تركز على هوية المنتج، الشكل المميز، الوظيفة المحددة، البراند/الموديل لو ظاهر. ممنوع كلمات عامة ضعيفة لوحدها (زي "جهاز" لوحدها) إلا لو مدموجة في عبارة محددة.

5. description: وصف قصير وواقعي بناءً على اللي شايفه فعلاً بس. ممنوع تمامًا: تخترع أي ادعاء طبي، أو مواصفات مش شايفها (وات، سعة بطارية، خامة دقيقة، شهادات) — لو مش متأكد، متكتبهاش خالص.

6. brand/model: لو مكتوب أو ظاهر بوضوح على المنتج، استخدمه واكتب brandConfidence/modelConfidence عالي. لو مش ظاهر خالص، خليهم null بالظبط — ممنوع تخمين اسم براند حتى لو شكله يشبه براند معروف.

7. visibleText: أي نص أو رقم أو كود ظاهر فعليًا على المنتج أو الشاشة أو التغليف (OCR) — لو مش متأكد من دقة القراءة، اكتبه برضو بس خليه يبان في overallConfidence إنه مش مؤكد 100%.

8. visualFingerprint: وصف تفصيلي للشكل الفيزيائي الفعلي (شكل عام، سيلويت، هندسة الجسم، ألوان أساسية وثانوية، خامة ظاهرة، أزرار، شاشة، مقبض، رأس، فتحات، منافذ، ملحقات، ملامح مميزة). لو عنصر مش موجود في الصورة، سيبه فاضي "" أو [].

9. distinctiveFeatures: من 5 لـ 15 خاصية فيزيائية مميزة تساعد تحدد نفس المنتج بالظبط (مش أي منتج من نفس النوع).

10. multipleProductsDetected: true لو فيه أكتر من منتج واضح في الصورة — في الحالة دي ركّز كل التحليل على المنتج الأبرز بصريًا بس، وممنوع تخلط خصائص من منتجين مختلفين.

11. imageQualityIssues: array من أي مشكلة حقيقية في الصورة (مثلاً "blurred", "too_small", "heavily_cropped", "product_mostly_hidden") — سيبها فاضية لو الصورة كويسة.

12. كل قيم الـ confidence أرقام من 0 لـ 100 — عبّر برأيك الحقيقي، ممنوع تحط رقم عالي لحاجة إنت مش متأكد منها.`;

/**
 * Stage A — one real Claude vision call. Never called for a search that
 * has no reference image.
 * @param {string} imageBase64
 * @param {string} imageMediaType
 * @returns {Promise<{profile: object, source: 'ai'|'fallback', imageHash: string}>}
 */
export async function analyzeProductImage(imageBase64, imageMediaType) {
  const imageHash = hashImage(imageBase64);

  // Cache check first (Steps 26/27) — never re-spend a vision call on the
  // exact same image bytes + prompt version.
  const cached = await prisma.experimentalImageIdentityCache.findUnique({
    where: { image_hash_model_version: { image_hash: imageHash, model_version: MODEL_VERSION } },
  }).catch(() => null);
  if (cached) {
    logger.info('[InternalCreativeDiscovery] IDENTITY_CACHE_HIT', { imageHash: imageHash.slice(0, 12) });
    return { profile: JSON.parse(cached.profile_json), source: 'cache', imageHash };
  }

  try {
    const text = await askClaude({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: imageMediaType || 'image/jpeg', data: imageBase64 } }, { type: 'text', text: 'حلل الصورة دي وارجع الـ JSON المطلوب.' }] }],
      maxTokens: 2000,
    });
    const parsed = safeJsonParse(text);
    if (!parsed || typeof parsed !== 'object' || !parsed.mainProductName) throw new Error('invalid JSON shape or missing mainProductName');

    const profile = normalizeProfile(parsed);
    await prisma.experimentalImageIdentityCache.create({
      data: { image_hash: imageHash, model_version: MODEL_VERSION, profile_json: JSON.stringify(profile) },
    }).catch((err) => logger.error('[InternalCreativeDiscovery] IDENTITY_CACHE_WRITE_FAILED', { message: err.message }));

    logger.info('[InternalCreativeDiscovery] IDENTITY_GENERATED', { imageHash: imageHash.slice(0, 12), mainProductName: profile.mainProductName, overallConfidence: profile.overallConfidence, multipleProductsDetected: profile.multipleProductsDetected });
    return { profile, source: 'ai', imageHash };
  } catch (err) {
    logger.error('[InternalCreativeDiscovery] IDENTITY_GENERATION_FAILED', { message: err.message });
    // Honest fallback — never invents a product identity. The caller must
    // treat this the same as "no name typed and no image understood" and
    // surface it plainly rather than pretending analysis worked.
    return {
      profile: normalizeProfile({ mainProductName: '', mainProductNameConfidence: 0, overallConfidence: 0, imageQualityIssues: ['analysis_failed'] }),
      source: 'fallback',
      imageHash,
    };
  }
}

const ARRAY_FIELDS = ['candidateNames', 'alternativeNames', 'arabicNames', 'englishNames', 'keywords', 'visibleText', 'distinctiveFeatures', 'imageQualityIssues'];
const VF_ARRAY_FIELDS = ['mainColors', 'secondaryColors', 'distinctivePhysicalFeatures', 'visibleText'];

function normalizeProfile(raw) {
  const profile = {
    mainProductName: String(raw.mainProductName || ''),
    mainProductNameConfidence: clampConfidence(raw.mainProductNameConfidence),
    description: raw.description ? String(raw.description) : '',
    productCategory: raw.productCategory ? String(raw.productCategory) : '',
    specificCategory: raw.specificCategory ? String(raw.specificCategory) : '',
    categoryConfidence: clampConfidence(raw.categoryConfidence),
    brand: raw.brand ? String(raw.brand) : null,
    brandConfidence: raw.brand ? clampConfidence(raw.brandConfidence) : 0,
    model: raw.model ? String(raw.model) : null,
    modelConfidence: raw.model ? clampConfidence(raw.modelConfidence) : 0,
    visualFingerprintConfidence: clampConfidence(raw.visualFingerprintConfidence),
    multipleProductsDetected: Boolean(raw.multipleProductsDetected),
    overallConfidence: clampConfidence(raw.overallConfidence),
  };
  for (const f of ARRAY_FIELDS) profile[f] = Array.isArray(raw[f]) ? raw[f].map(String).filter(Boolean) : [];

  const vf = raw.visualFingerprint && typeof raw.visualFingerprint === 'object' ? raw.visualFingerprint : {};
  profile.visualFingerprint = {
    overallShape: vf.overallShape ? String(vf.overallShape) : '',
    silhouette: vf.silhouette ? String(vf.silhouette) : '',
    bodyGeometry: vf.bodyGeometry ? String(vf.bodyGeometry) : '',
    materialAppearance: vf.materialAppearance ? String(vf.materialAppearance) : '',
    buttons: vf.buttons ? String(vf.buttons) : '',
    screen: vf.screen ? String(vf.screen) : '',
    handle: vf.handle ? String(vf.handle) : '',
    head: vf.head ? String(vf.head) : '',
    openings: vf.openings ? String(vf.openings) : '',
    ports: vf.ports ? String(vf.ports) : '',
    attachments: vf.attachments ? String(vf.attachments) : '',
    uniqueContours: vf.uniqueContours ? String(vf.uniqueContours) : '',
    visibleBrand: vf.visibleBrand ? String(vf.visibleBrand) : null,
    visibleModel: vf.visibleModel ? String(vf.visibleModel) : null,
  };
  for (const f of VF_ARRAY_FIELDS) profile.visualFingerprint[f] = Array.isArray(vf[f]) ? vf[f].map(String).filter(Boolean) : [];

  return profile;
}

function clampConfidence(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num)));
}

const VISUAL_COMPARE_SYSTEM_PROMPT = `إنت بتقارن بين صورتين: الصورة الأولى هي المنتج المرجعي الحقيقي اللي المستخدم رفعه، والصورة التانية مرشح حقيقي من نتائج البحث. قيّم بصراحة هل المرشح ده هو نفس المنتج الفيزيائي بالظبط (نفس الشكل والألوان والتفاصيل المميزة) — مش بس نفس النوع أو الفئة. منتج من نفس الفئة بس شكله مختلف فعليًا يستاهل درجة منخفضة (20-40)، مش عالية، حتى لو الاسم شبه بعضه. رجّع JSON فقط بالشكل ده:
{"visualMatchScore": 0, "reason": ""}
visualMatchScore من 0 لـ 100 (100 = نفس المنتج بالظبط، 0 = منتج مختلف تمامًا). reason: سطر واحد بالعربي يوضح السبب الحقيقي وراء الدرجة دي.`;

/**
 * Real Claude-vision side-by-side comparison between the reference image
 * and one candidate result's thumbnail — the core of "same physical
 * product ranks first" (Steps 17/29). Bounded/capped by the caller (never
 * run over every result — see experimentalCreativeDiscovery.js). Fetches
 * the candidate thumbnail server-side and sends it as a real image, rather
 * than relying on an unconfirmed URL-source image API shape.
 * @returns {Promise<{visualMatchScore: number|null, reason: string|null, error: string|null}>}
 */
export async function compareVisualMatch(referenceImageBase64, referenceImageMediaType, candidateThumbnailUrl) {
  let candidateBase64, candidateMediaType;
  try {
    const res = await fetch(candidateThumbnailUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`تعذر تحميل صورة المرشح: ${res.status}`);
    const contentType = (res.headers.get('content-type') || '').split(';')[0];
    if (!contentType.startsWith('image/')) throw new Error('الرابط مش صورة حقيقية');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('صورة المرشح أكبر من الحد المسموح');
    candidateBase64 = buf.toString('base64');
    candidateMediaType = contentType;
  } catch (err) {
    return { visualMatchScore: null, reason: null, error: err.message };
  }

  try {
    const text = await askClaude({
      system: VISUAL_COMPARE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'الصورة الأولى: المنتج المرجعي. الصورة الثانية: المرشح.' },
          { type: 'image', source: { type: 'base64', media_type: referenceImageMediaType || 'image/jpeg', data: referenceImageBase64 } },
          { type: 'image', source: { type: 'base64', media_type: candidateMediaType, data: candidateBase64 } },
        ],
      }],
      maxTokens: 300,
    });
    const parsed = safeJsonParse(text);
    if (!parsed || typeof parsed.visualMatchScore !== 'number') throw new Error('رد غير صالح من نموذج المقارنة');
    return { visualMatchScore: clampConfidence(parsed.visualMatchScore), reason: parsed.reason ? String(parsed.reason) : null, error: null };
  } catch (err) {
    return { visualMatchScore: null, reason: null, error: err.message };
  }
}

/**
 * Maps the rich Product Identity Profile onto the existing profile shape
 * `generateSearchQueries()`/`generateAdLibraryTieredQueries()` already
 * expect (productResearchAI.js) — reused as-is, never modified, so query
 * generation/tiering logic can never diverge between the real and
 * experimental pipelines.
 * @param {object} identity from analyzeProductImage()
 * @param {{possibleNames?: string[], namesAr?: string[], namesEn?: string[], keywords?: string[]}} manualOverrides any manual text the user also typed — merged on top, never dropped
 */
export function identityToSearchProfile(identity, manualOverrides = {}) {
  return {
    main_product_name: identity.mainProductName || manualOverrides.productName || '',
    product_category: identity.specificCategory || identity.productCategory || '',
    product_description: identity.description || '',
    possible_names_ar: [...new Set([...(identity.arabicNames || []), ...(manualOverrides.namesAr || [])])],
    possible_names_en: [...new Set([...(identity.englishNames || []), ...(manualOverrides.namesEn || [])])],
    alternative_names: [...new Set([...(identity.alternativeNames || []), ...(identity.candidateNames || []), ...(manualOverrides.possibleNames || [])])],
    supplier_names: [],
    generic_names: identity.brand && identity.model ? [`${identity.brand} ${identity.model}`] : [],
    benefits: [],
    problems_solved: [],
    features: identity.distinctiveFeatures || [],
    use_cases: [],
    target_audience: [],
    keywords_ar: (identity.keywords || []).filter((k) => /[؀-ۿ]/.test(k)),
    keywords_en: [...new Set([...(identity.keywords || []).filter((k) => !/[؀-ۿ]/.test(k)), ...(manualOverrides.keywords || [])])],
    visual_identifiers: identity.visualFingerprint?.distinctivePhysicalFeatures || [],
    negative_keywords: [],
  };
}
