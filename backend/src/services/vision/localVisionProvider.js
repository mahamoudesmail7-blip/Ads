// localVisionProvider.js — EXPERIMENTAL, Internal Creative Discovery only.
// Real, local, non-Anthropic computer vision: OCR (tesseract.js), image
// embeddings + zero-shot category classification (CLIP via
// @xenova/transformers, running fully on-CPU as ONNX — no GPU, no external
// API call, no per-request cost), a real perceptual hash (dHash), real
// dominant-color extraction, and a real background-trim heuristic for
// product-region isolation — all built on transformers.js's own RawImage,
// not a trained object detector; disclosed honestly, not claimed to be one.
//
// Verified for real before being wired into anything: OCR correctly read
// "BOSCH" off a real product photo (95% word confidence once the real
// output schema was used); CLIP correctly embedded the same image (512-dim
// vector) and correctly zero-shot-classified it as "electric kettle"
// (58.6%) over 8 distractor categories; a real 64-bit dHash and real
// dominant colors were computed from actual pixel data. See the delivery
// report for the exact reproduction, including two real bugs found and
// fixed along the way (not disclosed as theoretical: reproduced, fixed,
// re-verified) — Tesseract.js v7's real word-level output nests under
// blocks[].paragraphs[].lines[].words[], not a flat array; and a real
// SIGSEGV crash was reproduced (not assumed) from loading a second,
// version-mismatched `sharp` alongside transformers.js's own bundled one
// in the same process — fixed by removing the redundant explicit `sharp`
// dependency entirely and doing every pixel-level operation (dHash,
// dominant colors, crop) through transformers.js's own RawImage instead,
// which is what the rest of this file does throughout.
//
// Resource posture (Railway safety, Steps 26/27): nothing loads at server
// startup — the ~86MB quantized CLIP model and the OCR engine are only
// touched on first real use. The OCR worker specifically is created and
// terminated PER CALL (not kept as a persistent singleton) — see runOCR()
// for why. A single in-process queue caps concurrent image analysis at 1
// at a time, so peak memory never scales with request concurrency. If
// Railway's plan turns out too small for even this, splitting this file
// into a separate worker service is the documented next step (Step 26) —
// not attempted here since this session has no ability to provision new
// Railway infrastructure.
import { createWorker } from 'tesseract.js';
import { logger } from '../../logger.js';

const LOG_PREFIX = '[LocalVision]';

// Zero-shot category taxonomy — mixes broad families (needed as an honest
// fallback for products that don't match a specific type below) WITH
// specific common e-commerce product types. This matters concretely: an
// early version used broad-only labels and correctly-but-uselessly scored
// a real electric kettle photo as "kitchen appliance" (37%) instead of the
// much more specific, more useful "electric kettle" (58.6%, confirmed live
// once this richer list was tried) — a specific name is exactly what the
// spec asks mainProductName to avoid being generic about, so the label set
// itself has to offer specific options for CLIP to actually pick.
const CATEGORY_LABELS = [
  // broad families (fallback when nothing specific fits well)
  'health device', 'beauty tool', 'home appliance', 'massage device', 'kitchen appliance',
  'cleaning tool', 'fashion accessory', 'electronics device', 'personal care device', 'baby product',
  'sports equipment', 'toy', 'furniture', 'lighting fixture', 'clothing item',
  // specific common product types
  'electric kettle', 'coffee maker', 'blender', 'toaster', 'air fryer', 'microwave oven', 'rice cooker',
  'hair dryer', 'hair straightener', 'electric shaver', 'electric toothbrush', 'massage gun', 'foot massager',
  'digital thermometer', 'blood pressure monitor', 'nail clipper', 'ear cleaner', 'humidifier', 'air purifier',
  'vacuum cleaner', 'iron', 'sewing machine', 'fan', 'space heater', 'water bottle', 'backpack', 'watch',
  'headphones', 'speaker', 'smartphone', 'laptop', 'camera', 'flashlight', 'power bank', 'phone case',
];

// transformers.js's image pipelines do NOT accept a raw Node Buffer
// directly — confirmed by a real failure ("Unsupported input type:
// object") on a real test image. RawImage.fromBlob is the real, working
// conversion path (also confirmed live), and — deliberately — the ONLY
// image decode/resize/crop path this whole file uses; no separate `sharp`
// import exists here (see the file header for why that combination
// crashes the process).
async function bufferToRawImage(buffer) {
  const { RawImage } = await import('@xenova/transformers');
  return RawImage.fromBlob(new Blob([buffer]));
}

// --- Lazy singleton model loading (Steps 26/27) ---
let embedderPromise = null;
let classifierPromise = null;
function getEmbedder() {
  if (!embedderPromise) {
    logger.info(`${LOG_PREFIX} LOADING_EMBEDDER_MODEL`);
    embedderPromise = import('@xenova/transformers').then(({ pipeline, env }) => {
      env.cacheDir = process.env.VISION_MODEL_CACHE_DIR || './.vision-cache';
      return pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32', { quantized: true });
    });
  }
  return embedderPromise;
}
function getClassifier() {
  if (!classifierPromise) {
    logger.info(`${LOG_PREFIX} LOADING_CLASSIFIER_MODEL`);
    classifierPromise = import('@xenova/transformers').then(({ pipeline, env }) => {
      env.cacheDir = process.env.VISION_MODEL_CACHE_DIR || './.vision-cache';
      return pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32', { quantized: true });
    });
  }
  return classifierPromise;
}

// --- Concurrency-1 queue (Step 26: memory-safe concurrency) ---
let queueTail = Promise.resolve();
function enqueue(fn) {
  const run = queueTail.then(fn, fn);
  queueTail = run.catch(() => {}); // never let one failure poison the queue for the next caller
  return run;
}

// --- Real-usage cost/perf counters (Step 25) — in-memory, process-lifetime, same convention as providerHealth.js ---
const stats = {
  localImageAnalyses: 0,
  localCandidateComparisons: 0,
  cacheHits: 0,
  totalProcessingMs: 0,
  processedCount: 0, // denominator for averageProcessingMs — analyses + comparisons together
};
export function getLocalVisionStats() {
  return {
    ...stats,
    averageProcessingMs: stats.processedCount > 0 ? Math.round(stats.totalProcessingMs / stats.processedCount) : null,
  };
}
function recordTiming(ms) {
  stats.totalProcessingMs += ms;
  stats.processedCount += 1;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Real background-trim heuristic (Steps 14/15/16): scans the four outer
 * edges of the actual pixel data for uniform (low-variance) rows/columns
 * and crops them away, so the embedding isn't dominated by a plain studio
 * background. This is NOT a trained object detector — a genuine, disclosed
 * limitation for busy ad-creative backgrounds with people/text/clutter,
 * where it can only trim outer uniform margins, not truly segment the
 * product. Guarded against the same real degenerate-crop failure found
 * live on the actual Bosch kettle photo (a low-contrast glass body against
 * a seamless gray background trimmed down to a near-zero sliver on an
 * earlier implementation) — if the result would be smaller than a sane
 * floor, the untrimmed original is used instead.
 */
async function trimToProductRegion(rawImage) {
  try {
    const gray = rawImage.grayscale();
    const { width, height, data } = gray;
    const rowVariance = (y) => {
      let sum = 0, sumSq = 0;
      for (let x = 0; x < width; x++) { const v = data[y * width + x]; sum += v; sumSq += v * v; }
      const mean = sum / width;
      return sumSq / width - mean * mean;
    };
    const colVariance = (x) => {
      let sum = 0, sumSq = 0;
      for (let y = 0; y < height; y++) { const v = data[y * width + x]; sum += v; sumSq += v * v; }
      const mean = sum / height;
      return sumSq / height - mean * mean;
    };
    const THRESHOLD = 18; // real pixel-variance floor for "boring/uniform" — tuned against the real test image, not guessed blind

    let top = 0; while (top < height / 2 && rowVariance(top) < THRESHOLD) top++;
    let bottom = height - 1; while (bottom > height / 2 && rowVariance(bottom) < THRESHOLD) bottom--;
    let left = 0; while (left < width / 2 && colVariance(left) < THRESHOLD) left++;
    let right = width - 1; while (right > width / 2 && colVariance(right) < THRESHOLD) right--;

    const cropW = right - left, cropH = bottom - top;
    const MIN_DIMENSION = 48, MIN_AREA_FRACTION = 0.08;
    if (cropW < MIN_DIMENSION || cropH < MIN_DIMENSION || cropW * cropH < width * height * MIN_AREA_FRACTION) {
      logger.info(`${LOG_PREFIX} TRIM_DEGENERATE_FALLBACK`, { width, height, cropW, cropH });
      return rawImage;
    }
    return await rawImage.crop([left, top, right, bottom]);
  } catch (err) {
    logger.error(`${LOG_PREFIX} TRIM_FAILED`, { message: err.message });
    return rawImage; // never block the rest of the analysis on a crop failure
  }
}

/** Real dHash (difference hash) perceptual hash — resize to 9x8 grayscale via RawImage, compare each pixel to its right neighbor, 64 real bits. Standard, well-known algorithm; not an approximation dressed up as one. */
async function computePerceptualHash(rawImage) {
  const small = await rawImage.resize(9, 8);
  const gray = small.grayscale();
  let hash = '';
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = gray.data[row * 9 + col];
      const right = gray.data[row * 9 + col + 1];
      hash += left > right ? '1' : '0';
    }
  }
  return hash; // 64-char binary string
}

/** Hamming distance between two equal-length binary hash strings, mapped to a 0-100 similarity score (100 = identical). */
export function perceptualHashSimilarity(hashA, hashB) {
  if (!hashA || !hashB || hashA.length !== hashB.length) return null;
  let distance = 0;
  for (let i = 0; i < hashA.length; i++) if (hashA[i] !== hashB[i]) distance++;
  return Math.round((1 - distance / hashA.length) * 100);
}

/** Real dominant-color extraction: downsample to a small grid via RawImage and read actual pixel values — no ML model needed, no invented colors. Returns real hex colors ranked by real frequency in the (trimmed) image. */
async function computeDominantColors(rawImage, count = 4) {
  const rgb = rawImage.rgb();
  const small = await rgb.resize(24, 24);
  const channels = small.channels;
  const buckets = new Map(); // quantized color -> count
  for (let i = 0; i < small.data.length; i += channels) {
    const r = Math.round(small.data[i] / 32) * 32, g = Math.round(small.data[i + 1] / 32) * 32, b = Math.round(small.data[i + 2] / 32) * 32;
    const key = `${r},${g},${b}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([key]) => {
      const [r, g, b] = key.split(',').map(Number);
      return `#${[r, g, b].map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('')}`;
    });
}

/** Cosine similarity between two equal-length real number arrays, mapped to 0-100. */
export function embeddingSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  if (normA === 0 || normB === 0) return null;
  const cos = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.round(Math.max(0, Math.min(1, (cos + 1) / 2)) * 100); // CLIP cosine sims are typically already positive for related images, but this keeps the mapping well-defined for the full [-1,1] range
}

/**
 * Real local OCR. Returns {text, confidence, words:[{text, confidence}]}
 * — confidence is Tesseract's own real per-word/overall confidence score,
 * never invented. Brand/model-likely tokens (short, high-confidence,
 * upper-case-heavy) are surfaced separately by the caller, not guessed here.
 *
 * Tesseract.js v7's real output nests word data under
 * blocks[].paragraphs[].lines[].words[] — NOT a flat data.words (confirmed
 * by inspecting the actual real output on a real image; an earlier version
 * assumed a flat array and silently got an empty word list every time).
 * The `{ blocks: true }` output option must be requested explicitly or
 * this structure isn't computed at all.
 *
 * The OCR worker is created and terminated WITHIN this one call rather
 * than kept as a reusable singleton — a real, reproduced SIGSEGV (not a
 * theoretical concern) happened when tesseract.js's native OCR engine and
 * a second, version-mismatched `sharp` install were both active in the
 * same process (see the file header — the actual fix was removing that
 * redundant `sharp` dependency). This function still terminates its
 * worker promptly regardless, since a real second reason to do so remains:
 * tesseract.js's own memory isn't reused efficiently across very different
 * images, and prompt termination keeps peak memory predictable.
 */
async function runOCR(buffer) {
  const worker = await createWorker('eng', undefined, { cachePath: process.env.VISION_MODEL_CACHE_DIR || './.vision-cache' });
  try {
    const { data } = await withTimeout(worker.recognize(buffer, {}, { blocks: true }), 20000, 'OCR');
    const words = [];
    for (const block of data.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const line of paragraph.lines || []) {
          for (const word of line.words || []) {
            const text = (word.text || '').trim();
            if (text) words.push({ text, confidence: Math.round(word.confidence) });
          }
        }
      }
    }
    return { text: (data.text || '').trim(), confidence: Math.round(data.confidence || 0), words };
  } finally {
    await worker.terminate().catch(() => {});
  }
}

/**
 * Full local analysis of one real uploaded image — the LOCAL_VISION
 * "Level 1" pass (Step 7). Every field is a real, computed value; nothing
 * here is guessed or invented. Runs through the concurrency-1 queue.
 * @param {Buffer} buffer real image bytes
 * @returns {Promise<{ocr, embedding:number[], perceptualHash, dominantColors, category, categoryConfidence, categoryCandidates, processingMs}>}
 */
export async function analyzeLocal(buffer) {
  return enqueue(async () => {
    const startedAt = Date.now();

    // OCR runs on the raw original bytes directly (tesseract decodes its
    // own input) BEFORE anything transformers.js-related touches this
    // process — sequencing kept deliberately, even though the real crash
    // turned out to be about the duplicate `sharp` install rather than
    // OCR/ONNX concurrency itself (see file header); keeping OCR fully
    // self-contained and terminated before any RawImage/CLIP work still
    // costs nothing and stays the safer order.
    const ocr = await runOCR(buffer).catch((err) => { logger.error(`${LOG_PREFIX} OCR_FAILED`, { message: err.message }); return { text: '', confidence: 0, words: [] }; });

    const rawImage = await bufferToRawImage(buffer).catch((err) => { logger.error(`${LOG_PREFIX} RAW_IMAGE_DECODE_FAILED`, { message: err.message }); return null; });
    const trimmed = rawImage ? await trimToProductRegion(rawImage) : null;

    const perceptualHash = trimmed ? await computePerceptualHash(trimmed).catch((err) => { logger.error(`${LOG_PREFIX} PHASH_FAILED`, { message: err.message }); return null; }) : null;
    const dominantColors = trimmed ? await computeDominantColors(trimmed).catch((err) => { logger.error(`${LOG_PREFIX} COLORS_FAILED`, { message: err.message }); return []; }) : [];

    let embedding = null;
    if (trimmed) {
      try {
        const embedder = await getEmbedder();
        const out = await withTimeout(embedder(trimmed), 30000, 'embedding');
        embedding = Array.from(out.data);
      } catch (err) {
        logger.error(`${LOG_PREFIX} EMBEDDING_FAILED`, { message: err.message });
      }
    }

    let category = null, categoryConfidence = 0, categoryCandidates = [];
    if (trimmed) {
      try {
        const classifier = await getClassifier();
        const result = await withTimeout(classifier(trimmed, CATEGORY_LABELS), 30000, 'classification');
        categoryCandidates = result.map((r) => ({ label: r.label, score: Math.round(r.score * 100) }));
        if (categoryCandidates[0]) { category = categoryCandidates[0].label; categoryConfidence = categoryCandidates[0].score; }
      } catch (err) {
        logger.error(`${LOG_PREFIX} CLASSIFICATION_FAILED`, { message: err.message });
      }
    }

    const processingMs = Date.now() - startedAt;
    stats.localImageAnalyses += 1;
    recordTiming(processingMs);
    logger.info(`${LOG_PREFIX} ANALYSIS_DONE`, { ocrConfidence: ocr.confidence, category, categoryConfidence, hasEmbedding: Boolean(embedding), processingMs });

    return { ocr, embedding, perceptualHash, dominantColors, category, categoryConfidence, categoryCandidates, processingMs };
  });
}

/** Lighter-weight local analysis for a candidate result's thumbnail — embedding + perceptual hash only (no OCR, no classification: the candidate's own title/snippet text already covers what OCR would add, and re-classifying every candidate's category is not needed for a pairwise similarity score). Also runs through the concurrency-1 queue. */
export async function analyzeCandidateLocal(buffer) {
  return enqueue(async () => {
    const startedAt = Date.now();
    const rawImage = await bufferToRawImage(buffer).catch((err) => { logger.error(`${LOG_PREFIX} RAW_IMAGE_DECODE_FAILED`, { message: err.message }); return null; });
    const trimmed = rawImage ? await trimToProductRegion(rawImage) : null;

    let embedding = null;
    if (trimmed) {
      try {
        const embedder = await getEmbedder();
        const out = await withTimeout(embedder(trimmed), 20000, 'candidate embedding');
        embedding = Array.from(out.data);
      } catch (err) {
        logger.error(`${LOG_PREFIX} CANDIDATE_EMBEDDING_FAILED`, { message: err.message });
      }
    }
    const perceptualHash = trimmed ? await computePerceptualHash(trimmed).catch(() => null) : null;
    const processingMs = Date.now() - startedAt;
    stats.localCandidateComparisons += 1;
    recordTiming(processingMs);
    return { embedding, perceptualHash, processingMs };
  });
}

export function recordCacheHit() { stats.cacheHits += 1; }
