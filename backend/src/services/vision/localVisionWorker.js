// localVisionWorker.js — EXPERIMENTAL, Internal Creative Discovery only.
// The actual local-vision computation (OCR, CLIP embeddings/classification,
// perceptual hash, dominant colors, product-region crop), run inside a
// dedicated worker_thread rather than the main server process.
//
// WHY A WORKER THREAD (real finding, not precautionary): a live test on
// the deployed Railway container got stuck in ANALYZING for 9+ minutes —
// well past every JS-level `Promise.race`-based timeout this code had
// (verified: those timeouts are still in place below, and did NOT fire).
// The only explanation consistent with a plain `setTimeout` callback never
// running is that the blocking work is happening synchronously on the
// same thread as the event loop that would need to run that timer —
// almost certainly inside onnxruntime-node's or tesseract.js's native
// bindings during model load/inference. A `Promise.race` timeout can never
// interrupt that, on any host, by construction: the timer callback is
// queued on the very event loop that's blocked. Moving the actual work to
// a separate OS thread (worker_threads) fixes this at the root: the
// PARENT's event loop stays free regardless of what the worker is doing,
// so the parent's own timeout (localVisionProvider.js) can always fire
// and forcibly `worker.terminate()` a stuck worker — a real, reliable
// timeout instead of one that silently never worked.
import { parentPort } from 'worker_threads';
import os from 'os';
import path from 'path';
import { createWorker } from 'tesseract.js';

const LOG_PREFIX = '[LocalVisionWorker]';

function log(event, data) {
  // No access to the app's own logger inside a worker thread (a separate
  // module registry) — plain console output, which Node forwards to the
  // parent process's stdout/stderr automatically for a worker thread.
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'INFO', event: `${LOG_PREFIX} ${event}`, ...data }));
}
function logError(event, data) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'ERROR', event: `${LOG_PREFIX} ${event}`, ...data }));
}

function visionCacheDir() {
  return process.env.VISION_MODEL_CACHE_DIR || path.join(os.tmpdir(), 'internal-creative-discovery-vision-cache');
}

// Zero-shot category taxonomy — mixes broad families (an honest fallback
// for products that don't match a specific type below) with specific
// common e-commerce product types. A real electric kettle test photo was
// correctly-but-uselessly classified as "kitchen appliance" (37%) with a
// broad-only label set, versus the specific, more useful "electric
// kettle" (58.6%) once these specific labels were added — confirmed live.
const CATEGORY_LABELS = [
  'health device', 'beauty tool', 'home appliance', 'massage device', 'kitchen appliance',
  'cleaning tool', 'fashion accessory', 'electronics device', 'personal care device', 'baby product',
  'sports equipment', 'toy', 'furniture', 'lighting fixture', 'clothing item',
  'electric kettle', 'coffee maker', 'blender', 'toaster', 'air fryer', 'microwave oven', 'rice cooker',
  'hair dryer', 'hair straightener', 'electric shaver', 'electric toothbrush', 'massage gun', 'foot massager',
  'digital thermometer', 'blood pressure monitor', 'nail clipper', 'ear cleaner', 'humidifier', 'air purifier',
  'vacuum cleaner', 'iron', 'sewing machine', 'fan', 'space heater', 'water bottle', 'backpack', 'watch',
  'headphones', 'speaker', 'smartphone', 'laptop', 'camera', 'flashlight', 'power bank', 'phone case',
];

async function bufferToRawImage(buffer) {
  const { RawImage } = await import('@xenova/transformers');
  return RawImage.fromBlob(new Blob([buffer]));
}

let embedderPromise = null;
let classifierPromise = null;
function getEmbedder() {
  if (!embedderPromise) {
    log('LOADING_EMBEDDER_MODEL', {});
    embedderPromise = import('@xenova/transformers').then(({ pipeline, env }) => {
      env.cacheDir = visionCacheDir();
      return pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32', { quantized: true });
    }).catch((err) => { embedderPromise = null; throw err; });
  }
  return embedderPromise;
}
function getClassifier() {
  if (!classifierPromise) {
    log('LOADING_CLASSIFIER_MODEL', {});
    classifierPromise = import('@xenova/transformers').then(({ pipeline, env }) => {
      env.cacheDir = visionCacheDir();
      return pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32', { quantized: true });
    }).catch((err) => { classifierPromise = null; throw err; });
  }
  return classifierPromise;
}

/** Real background-trim heuristic — scans the four outer edges of actual pixel data for uniform (low-variance) rows/columns and crops them away. Not a trained object detector; falls back to the untrimmed original if the result would be degenerate. */
async function trimToProductRegion(rawImage) {
  try {
    const gray = rawImage.grayscale();
    const { width, height, data } = gray;
    const rowVariance = (y) => { let sum = 0, sumSq = 0; for (let x = 0; x < width; x++) { const v = data[y * width + x]; sum += v; sumSq += v * v; } const mean = sum / width; return sumSq / width - mean * mean; };
    const colVariance = (x) => { let sum = 0, sumSq = 0; for (let y = 0; y < height; y++) { const v = data[y * width + x]; sum += v; sumSq += v * v; } const mean = sum / height; return sumSq / height - mean * mean; };
    const THRESHOLD = 18;
    let top = 0; while (top < height / 2 && rowVariance(top) < THRESHOLD) top++;
    let bottom = height - 1; while (bottom > height / 2 && rowVariance(bottom) < THRESHOLD) bottom--;
    let left = 0; while (left < width / 2 && colVariance(left) < THRESHOLD) left++;
    let right = width - 1; while (right > width / 2 && colVariance(right) < THRESHOLD) right--;
    const cropW = right - left, cropH = bottom - top;
    if (cropW < 48 || cropH < 48 || cropW * cropH < width * height * 0.08) return rawImage;
    return await rawImage.crop([left, top, right, bottom]);
  } catch {
    return rawImage;
  }
}

async function computePerceptualHash(rawImage) {
  const small = await rawImage.resize(9, 8);
  const gray = small.grayscale();
  let hash = '';
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) hash += gray.data[row * 9 + col] > gray.data[row * 9 + col + 1] ? '1' : '0';
  return hash;
}

async function computeDominantColors(rawImage, count = 4) {
  const small = await rawImage.rgb().resize(24, 24);
  const channels = small.channels;
  const buckets = new Map();
  for (let i = 0; i < small.data.length; i += channels) {
    const key = `${Math.round(small.data[i] / 32) * 32},${Math.round(small.data[i + 1] / 32) * 32},${Math.round(small.data[i + 2] / 32) * 32}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([key]) => `#${key.split(',').map((v) => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('')}`);
}

/** OCR worker created and terminated per call — tesseract.js's own memory isn't reused efficiently across very different images, and prompt termination keeps this worker thread's own peak memory predictable. */
async function runOCR(buffer) {
  const worker = await createWorker('eng', undefined, { cachePath: visionCacheDir() });
  try {
    const { data } = await worker.recognize(buffer, {}, { blocks: true });
    const words = [];
    for (const block of data.blocks || []) for (const paragraph of block.paragraphs || []) for (const line of paragraph.lines || []) for (const word of line.words || []) { const text = (word.text || '').trim(); if (text) words.push({ text, confidence: Math.round(word.confidence) }); }
    return { text: (data.text || '').trim(), confidence: Math.round(data.confidence || 0), words };
  } finally {
    await worker.terminate().catch(() => {});
  }
}

async function analyzeLocal(buffer) {
  const startedAt = Date.now();
  const ocr = await runOCR(buffer).catch((err) => { logError('OCR_FAILED', { message: err.message }); return { text: '', confidence: 0, words: [] }; });
  const rawImage = await bufferToRawImage(buffer).catch((err) => { logError('RAW_IMAGE_DECODE_FAILED', { message: err.message }); return null; });
  const trimmed = rawImage ? await trimToProductRegion(rawImage) : null;
  const perceptualHash = trimmed ? await computePerceptualHash(trimmed).catch(() => null) : null;
  const dominantColors = trimmed ? await computeDominantColors(trimmed).catch(() => []) : [];

  let embedding = null;
  if (trimmed) {
    try { embedding = Array.from((await (await getEmbedder())(trimmed)).data); } catch (err) { logError('EMBEDDING_FAILED', { message: err.message }); }
  }
  let category = null, categoryConfidence = 0, categoryCandidates = [];
  if (trimmed) {
    try {
      const result = await (await getClassifier())(trimmed, CATEGORY_LABELS);
      categoryCandidates = result.map((r) => ({ label: r.label, score: Math.round(r.score * 100) }));
      if (categoryCandidates[0]) { category = categoryCandidates[0].label; categoryConfidence = categoryCandidates[0].score; }
    } catch (err) { logError('CLASSIFICATION_FAILED', { message: err.message }); }
  }

  const processingMs = Date.now() - startedAt;
  log('ANALYSIS_DONE', { ocrConfidence: ocr.confidence, category, categoryConfidence, hasEmbedding: Boolean(embedding), processingMs });
  return { ocr, embedding, perceptualHash, dominantColors, category, categoryConfidence, categoryCandidates, processingMs };
}

async function analyzeCandidateLocal(buffer) {
  const startedAt = Date.now();
  const rawImage = await bufferToRawImage(buffer).catch((err) => { logError('RAW_IMAGE_DECODE_FAILED', { message: err.message }); return null; });
  const trimmed = rawImage ? await trimToProductRegion(rawImage) : null;
  let embedding = null;
  if (trimmed) {
    try { embedding = Array.from((await (await getEmbedder())(trimmed)).data); } catch (err) { logError('CANDIDATE_EMBEDDING_FAILED', { message: err.message }); }
  }
  const perceptualHash = trimmed ? await computePerceptualHash(trimmed).catch(() => null) : null;
  return { embedding, perceptualHash, processingMs: Date.now() - startedAt };
}

parentPort.on('message', async (msg) => {
  const { id, type, buffer } = msg;
  try {
    const nodeBuffer = Buffer.from(buffer);
    const result = type === 'analyzeCandidateLocal' ? await analyzeCandidateLocal(nodeBuffer) : await analyzeLocal(nodeBuffer);
    parentPort.postMessage({ id, result });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message || String(err) });
  }
});

log('WORKER_READY', {});
