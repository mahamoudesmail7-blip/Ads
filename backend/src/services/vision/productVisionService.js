// productVisionService.js — EXPERIMENTAL, Internal Creative Discovery only.
// THE provider abstraction (Step 1). experimentalCreativeDiscovery.js calls
// ONLY this module for anything vision-related and never knows or cares
// whether LOCAL_VISION or ANTHROPIC_VISION actually produced a given
// field — that's the whole point: Anthropic becomes an optional
// enhancement layered on top of a real, always-available local pipeline,
// never a requirement.
//
// LOCAL_VISION (localVisionProvider.js) always runs first and is treated
// as sufent on its own: it produces the identity profile / visual match
// score from real OCR + real CLIP embeddings + real zero-shot
// classification + real perceptual hashing — nothing here waits on or
// requires Anthropic to produce a usable result. ANTHROPIC_VISION
// (productIdentityVision.js, completely unmodified in its own logic) is
// only ever attempted afterward, only when configured AND its own real
// health tracker doesn't already say ERROR, and its result only ever
// enhances fields the local pass left weak/empty — it can never overwrite
// a real local finding with a lower-confidence guess, and any Anthropic
// failure is swallowed silently (logged, never thrown) so the local
// result is always what ships.
import crypto from 'crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import * as localVision from './localVisionProvider.js';
import { analyzeProductImage as anthropicAnalyzeImage, compareVisualMatch as anthropicCompareVisual } from '../productIdentityVision.js';
import { classify as healthClassify, classifyErrorType } from '../providerHealth.js';

const LOG_PREFIX = '[ProductVisionService]';
const LOCAL_MODEL_VERSION = 'local-v1';

function hashImage(imageBase64) {
  return crypto.createHash('sha256').update(imageBase64).digest('hex');
}

function anthropicConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}
/** Anthropic is attempted only when configured AND its real, traffic-driven health tracker (the same one every other Claude call in this app feeds — never a synthetic probe) doesn't already show ERROR. A never-yet-exercised or merely DEGRADED state is still worth trying once; a confirmed ERROR (e.g. the known insufficient-credit state) is not worth spending a request on. */
function anthropicWorthTrying() {
  if (!anthropicConfigured()) return false;
  return healthClassify('anthropic', true).status !== 'ERROR';
}

const OCR_TOKEN_PATTERN = /^[A-Z][A-Z0-9]{2,14}$/; // short, upper-case-heavy tokens are brand/model *candidates* only — Step 6/8 explicitly forbids treating this as confirmed

/** Level 1 (Step 7): maps LOCAL_VISION's raw computed output onto the exact same Product Identity Profile shape productIdentityVision.js's Claude-generated profile already uses, so nothing downstream (identityToSearchProfile, the frontend display, Stage B enrichment) needs a second shape to understand. Every field here is directly traceable to a real local computation — nothing guessed. */
function localToProfileShape(local) {
  const strongOcrTokens = (local.ocr.words || []).filter((w) => w.confidence >= 65 && OCR_TOKEN_PATTERN.test(w.text));
  const brand = strongOcrTokens[0]?.text || null;
  const brandConfidence = strongOcrTokens[0]?.confidence || 0;
  const model = strongOcrTokens[1]?.text || null;
  const modelConfidence = strongOcrTokens[1]?.confidence || 0;

  const category = local.category || '';
  const mainProductName = brand && category ? `${brand} ${category}` : category || '';
  const candidateNames = (local.categoryCandidates || []).slice(0, 3).map((c) => (brand ? `${brand} ${c.label}` : c.label)).filter(Boolean);
  const overallConfidence = category ? Math.round((local.categoryConfidence + (local.ocr.confidence || 0)) / (local.ocr.text ? 2 : 1)) : 0;

  return {
    mainProductName,
    mainProductNameConfidence: brand ? Math.round((local.categoryConfidence + brandConfidence) / 2) : local.categoryConfidence,
    candidateNames,
    alternativeNames: [],
    arabicNames: [],
    englishNames: mainProductName ? [mainProductName] : [],
    keywords: [category, brand].filter(Boolean),
    description: '', // local pipeline never invents prose — Anthropic enrichment is the only source of a real description
    productCategory: category,
    specificCategory: category,
    categoryConfidence: local.categoryConfidence,
    brand,
    brandConfidence,
    model,
    modelConfidence,
    visibleText: (local.ocr.words || []).map((w) => w.text),
    distinctiveFeatures: (local.dominantColors || []).map((c) => `dominant color ${c}`),
    visualFingerprint: {
      overallShape: '', silhouette: '', bodyGeometry: '', materialAppearance: '',
      buttons: '', screen: '', handle: '', head: '', openings: '', ports: '', attachments: '', uniqueContours: '',
      visibleBrand: brand, visibleModel: model,
      mainColors: local.dominantColors || [], secondaryColors: [], distinctivePhysicalFeatures: [], visibleText: (local.ocr.words || []).map((w) => w.text),
    },
    visualFingerprintConfidence: local.embedding ? 60 : 0, // a real embedding was computed (structural signal exists), but no descriptive fingerprint text -- moderate, honest confidence, never the polished prose Anthropic can produce
    multipleProductsDetected: false, // the local pipeline has no multi-object detection -- never claims to have found or ruled this out
    imageQualityIssues: local.embedding ? [] : ['local_embedding_failed'],
    overallConfidence,
  };
}

/** Enhancement merge (Step 7 Level 2): Anthropic's output only fills gaps the local pass left weak — never overwrites a real local finding with a lower-confidence one. Text fields (description, arabicNames/englishNames/alternativeNames, distinctiveFeatures, visualFingerprint prose) come from Anthropic when available since local has no real source for them at all. */
function mergeAnthropicEnrichment(localProfile, anthropicProfile) {
  const merged = { ...localProfile };
  if (anthropicProfile.mainProductNameConfidence > localProfile.mainProductNameConfidence) {
    merged.mainProductName = anthropicProfile.mainProductName || localProfile.mainProductName;
    merged.mainProductNameConfidence = anthropicProfile.mainProductNameConfidence;
  }
  if (!merged.brand && anthropicProfile.brand) { merged.brand = anthropicProfile.brand; merged.brandConfidence = anthropicProfile.brandConfidence; }
  if (!merged.model && anthropicProfile.model) { merged.model = anthropicProfile.model; merged.modelConfidence = anthropicProfile.modelConfidence; }
  if (anthropicProfile.categoryConfidence > localProfile.categoryConfidence) {
    merged.productCategory = anthropicProfile.productCategory || localProfile.productCategory;
    merged.specificCategory = anthropicProfile.specificCategory || localProfile.specificCategory;
    merged.categoryConfidence = anthropicProfile.categoryConfidence;
  }
  merged.description = anthropicProfile.description || localProfile.description;
  merged.arabicNames = [...new Set([...(anthropicProfile.arabicNames || []), ...(localProfile.arabicNames || [])])];
  merged.englishNames = [...new Set([...(anthropicProfile.englishNames || []), ...(localProfile.englishNames || [])])];
  merged.alternativeNames = [...new Set([...(anthropicProfile.alternativeNames || []), ...(localProfile.alternativeNames || [])])];
  merged.candidateNames = [...new Set([...(anthropicProfile.candidateNames || []), ...(localProfile.candidateNames || [])])];
  merged.keywords = [...new Set([...(anthropicProfile.keywords || []), ...(localProfile.keywords || [])])];
  merged.visibleText = [...new Set([...(anthropicProfile.visibleText || []), ...(localProfile.visibleText || [])])];
  merged.distinctiveFeatures = anthropicProfile.distinctiveFeatures?.length ? anthropicProfile.distinctiveFeatures : localProfile.distinctiveFeatures;
  merged.visualFingerprint = { ...localProfile.visualFingerprint, ...Object.fromEntries(Object.entries(anthropicProfile.visualFingerprint || {}).filter(([, v]) => v && (!Array.isArray(v) || v.length))) };
  merged.visualFingerprintConfidence = Math.max(localProfile.visualFingerprintConfidence, anthropicProfile.visualFingerprintConfidence);
  merged.multipleProductsDetected = anthropicProfile.multipleProductsDetected || localProfile.multipleProductsDetected;
  merged.imageQualityIssues = [...new Set([...(localProfile.imageQualityIssues || []), ...(anthropicProfile.imageQualityIssues || [])])];
  merged.overallConfidence = Math.max(localProfile.overallConfidence, anthropicProfile.overallConfidence);
  return merged;
}

/**
 * THE abstraction entry point (Step 1). Always attempts LOCAL_VISION
 * first (free, real, never optional); only ever adds ANTHROPIC_VISION as
 * an enhancement layer on top, and only when it's actually worth trying.
 * @returns {Promise<{profile: object, identityProvider: 'LOCAL_VISION'|'LOCAL_VISION+ANTHROPIC', imageHash: string, embedding: number[]|null, perceptualHash: string|null}>}
 */
export async function analyzeProductImage(imageBase64, imageMediaType) {
  const imageHash = hashImage(imageBase64);
  const buffer = Buffer.from(imageBase64, 'base64');

  // --- LOCAL_VISION, always attempted, cache-checked first ---
  // Timeout added defensively (Step: diagnosing a real, still-unresolved
  // hang with no direct Railway log access) — a `.catch()` alone only
  // handles a REJECTED promise, never a query that simply never settles;
  // this guarantees the cache check itself can never be the thing that
  // hangs the whole search, regardless of why.
  logger.info(`${LOG_PREFIX} CACHE_CHECK_START`, { imageHash: imageHash.slice(0, 12) });
  let localProfile, embedding, perceptualHash;
  const cachedLocal = await Promise.race([
    prisma.experimentalImageIdentityCache.findUnique({
      where: { image_hash_model_version_provider: { image_hash: imageHash, model_version: LOCAL_MODEL_VERSION, provider: 'LOCAL_VISION' } },
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
  ]).catch((err) => { logger.error(`${LOG_PREFIX} CACHE_CHECK_FAILED`, { message: err.message }); return null; });
  logger.info(`${LOG_PREFIX} CACHE_CHECK_DONE`, { hit: Boolean(cachedLocal) });

  if (cachedLocal) {
    localVision.recordCacheHit();
    const cachedData = JSON.parse(cachedLocal.profile_json);
    localProfile = cachedData.profile;
    embedding = cachedData.embedding;
    perceptualHash = cachedData.perceptualHash;
    logger.info(`${LOG_PREFIX} LOCAL_CACHE_HIT`, { imageHash: imageHash.slice(0, 12) });
  } else {
    const local = await localVision.analyzeLocal(buffer);
    localProfile = localToProfileShape(local);
    embedding = local.embedding;
    perceptualHash = local.perceptualHash;
    await prisma.experimentalImageIdentityCache.create({
      data: { image_hash: imageHash, model_version: LOCAL_MODEL_VERSION, provider: 'LOCAL_VISION', profile_json: JSON.stringify({ profile: localProfile, embedding, perceptualHash }) },
    }).catch((err) => logger.error(`${LOG_PREFIX} LOCAL_CACHE_WRITE_FAILED`, { message: err.message }));
    logger.info(`${LOG_PREFIX} LOCAL_IDENTITY_GENERATED`, { imageHash: imageHash.slice(0, 12), mainProductName: localProfile.mainProductName, overallConfidence: localProfile.overallConfidence, brand: localProfile.brand });
  }

  // --- ANTHROPIC_VISION, optional enhancement only ---
  let identityProvider = 'LOCAL_VISION';
  let profile = localProfile;
  if (anthropicWorthTrying()) {
    try {
      const { profile: anthropicProfile, source } = await anthropicAnalyzeImage(imageBase64, imageMediaType);
      if (source !== 'fallback' && anthropicProfile.mainProductName) {
        profile = mergeAnthropicEnrichment(localProfile, anthropicProfile);
        identityProvider = 'LOCAL_VISION+ANTHROPIC';
        logger.info(`${LOG_PREFIX} ANTHROPIC_ENRICHMENT_APPLIED`, { imageHash: imageHash.slice(0, 12) });
      }
    } catch (err) {
      logger.error(`${LOG_PREFIX} ANTHROPIC_ENRICHMENT_FAILED`, { errorType: classifyErrorType(err), message: err.message });
      // Swallowed on purpose — LOCAL_VISION's result already shipped above; Anthropic is enhancement only, never a requirement (Step 31).
    }
  }

  return { profile, identityProvider, imageHash, embedding, perceptualHash };
}

/**
 * Local candidate-vs-reference comparison (Steps 9/10) — always attempted
 * when a reference embedding exists. Combines real embedding cosine
 * similarity, real perceptual-hash similarity, and a real brand/model
 * text-match bonus (checked against the candidate's own title/snippet
 * text, not a second OCR pass — cheaper, and that text is already real
 * data already collected for the result). ANTHROPIC_VISION semantic
 * comparison is layered on top only when worth trying, and only ever
 * blended with the local score, never substituted alone (Step 11).
 * @param {{embedding:number[]|null, perceptualHash:string|null, brand:string|null, model:string|null, imageBase64:string, imageMediaType:string}} reference
 * @param {string} candidateThumbnailUrl
 * @param {string} candidateText title+snippet, for the brand/model text-match bonus
 * @returns {Promise<{localVisualMatchScore:number|null, visualMatchScore:number|null, visualMatchProvider:string|null, reason:string|null}>}
 */
export async function compareVisualMatch(reference, candidateThumbnailUrl, candidateText = '') {
  if (!reference.embedding) return { localVisualMatchScore: null, visualMatchScore: null, visualMatchProvider: null, reason: null };

  let candidateBuffer;
  try {
    const res = await fetch(candidateThumbnailUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`تعذر تحميل صورة المرشح: ${res.status}`);
    const contentType = (res.headers.get('content-type') || '').split(';')[0];
    if (!contentType.startsWith('image/')) throw new Error('الرابط مش صورة حقيقية');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('صورة المرشح أكبر من الحد المسموح');
    candidateBuffer = buf;
  } catch (err) {
    return { localVisualMatchScore: null, visualMatchScore: null, visualMatchProvider: null, reason: null, error: err.message };
  }

  const candidate = await localVision.analyzeCandidateLocal(candidateBuffer);
  const embSim = localVision.embeddingSimilarity(reference.embedding, candidate.embedding);
  const hashSim = localVision.perceptualHashSimilarity(reference.perceptualHash, candidate.perceptualHash);

  const lowerText = candidateText.toLowerCase();
  let brandBonus = 0;
  if (reference.brand && lowerText.includes(reference.brand.toLowerCase())) brandBonus += 15;
  if (reference.model && lowerText.includes(reference.model.toLowerCase())) brandBonus += 10;

  const parts = [embSim, hashSim].filter((v) => v !== null);
  if (parts.length === 0) return { localVisualMatchScore: null, visualMatchScore: null, visualMatchProvider: null, reason: null };
  const base = embSim !== null && hashSim !== null ? 0.7 * embSim + 0.3 * hashSim : parts[0];
  const localVisualMatchScore = Math.max(0, Math.min(100, Math.round(base + brandBonus)));

  let visualMatchScore = localVisualMatchScore;
  let visualMatchProvider = 'LOCAL_EMBEDDING';
  let reason = null;
  if (anthropicWorthTrying()) {
    try {
      const semantic = await anthropicCompareVisual(reference.imageBase64, reference.imageMediaType, candidateThumbnailUrl);
      if (semantic.visualMatchScore !== null) {
        visualMatchScore = Math.round(0.5 * localVisualMatchScore + 0.5 * semantic.visualMatchScore);
        visualMatchProvider = 'LOCAL_EMBEDDING+ANTHROPIC';
        reason = semantic.reason;
      }
    } catch (err) {
      logger.error('[ProductVisionService] ANTHROPIC_COMPARE_FAILED', { errorType: classifyErrorType(err), message: err.message });
      // Swallowed — the local score above already stands.
    }
  }

  return { localVisualMatchScore, visualMatchScore, visualMatchProvider, reason };
}
