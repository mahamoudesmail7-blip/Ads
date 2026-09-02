// localVisionProvider.js — EXPERIMENTAL, Internal Creative Discovery only.
// Thin client for the real local-vision computation, which runs inside a
// dedicated worker_thread (localVisionWorker.js) — see that file's header
// for exactly why: a live Railway test got stuck in ANALYZING for 9+
// minutes, past every JS-level timeout this file had, because the
// blocking work (onnxruntime-node / tesseract.js native calls) runs
// synchronously on whatever thread calls it, which starves that same
// thread's own event loop of the chance to ever fire a `setTimeout`
// callback — a `Promise.race` timeout literally cannot interrupt work
// blocking the very loop it needs to run on. Moving the work to a
// separate worker thread fixes this at the root: this file's own timeout
// runs on the always-free main thread, so it can always fire and forcibly
// `worker.terminate()` a genuinely stuck worker.
//
// Verified for real (via the worker) before being wired into anything:
// OCR correctly read "BOSCH" off a real product photo (95%+ word
// confidence); CLIP correctly embedded the same image (512-dim vector)
// and correctly zero-shot-classified it as "electric kettle" (58.6% with
// a broad-only label set beaten by "electric kettle" 58.6%/"kitchen
// appliance" 37% once specific labels were added); a real 64-bit dHash
// and real dominant colors were computed from actual pixel data. See the
// delivery report for the full reproduction, including three real bugs
// found and fixed along the way (Tesseract.js v7's real nested word
// output shape, a real SIGSEGV from a duplicate `sharp` install, and a
// too-generic category label set) plus this fourth one (the hang) found
// on the live Railway deploy itself, not locally.
//
// Resource posture (Railway safety, Steps 26/27): the worker thread is
// spawned lazily on first real use, not at server startup, and is reused
// across calls (keeping the ~86MB×2 CLIP models warm in the worker's own
// memory) until it either stays healthy or gets terminated for hanging —
// a terminated worker is replaced by a fresh one on the next call. A
// single in-process queue still caps concurrent image analysis at 1 at a
// time, so peak memory never scales with request concurrency.
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import path from 'path';
import { logger } from '../../logger.js';

const LOG_PREFIX = '[LocalVision]';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'localVisionWorker.js');

// Generous but real: a cold model download (~180MB combined across both
// pipelines) plus OCR plus inference should comfortably finish inside
// this on any reasonable connection. If it doesn't, the worker is killed
// and the caller gets a real, honest failure instead of a silent hang —
// exactly the guarantee the previous JS-level timeout was supposed to
// provide but structurally could not.
const CALL_TIMEOUT_MS = 180000;

let worker = null;
let nextRequestId = 1;
const pending = new Map(); // id -> {resolve, reject, timer}

function spawnWorker() {
  const w = new Worker(WORKER_PATH);
  w.on('message', (msg) => {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error));
    else entry.resolve(msg.result);
  });
  w.on('error', (err) => {
    logger.error(`${LOG_PREFIX} WORKER_ERROR`, { message: err.message });
    failAllPending(err);
    worker = null; // replaced fresh on the next call
  });
  w.on('exit', (code) => {
    if (code !== 0) logger.error(`${LOG_PREFIX} WORKER_EXITED`, { code });
    failAllPending(new Error(`local vision worker exited (code ${code})`));
    worker = null;
  });
  // Forward the worker's own console-based logging into the real app logger.
  w.stdout?.on('data', (chunk) => logger.info(`${LOG_PREFIX} ${chunk.toString().trim()}`));
  w.stderr?.on('data', (chunk) => logger.error(`${LOG_PREFIX} ${chunk.toString().trim()}`));
  return w;
}

function failAllPending(err) {
  for (const [id, entry] of pending.entries()) {
    clearTimeout(entry.timer);
    entry.reject(err);
    pending.delete(id);
  }
}

function getWorker() {
  if (!worker) worker = spawnWorker();
  return worker;
}

/**
 * Sends real image bytes to the worker thread and waits for a real
 * result, with a hard, ALWAYS-effective timeout enforced from this
 * (never-blocked) main thread: on timeout the worker is force-terminated
 * (whatever it was doing, regardless of whether that was CPU-blocking
 * native code) and replaced on the next call.
 */
function callWorker(type, buffer) {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    const w = getWorker();
    const timer = setTimeout(() => {
      pending.delete(id);
      logger.error(`${LOG_PREFIX} WORKER_TIMEOUT`, { type, timeoutMs: CALL_TIMEOUT_MS });
      w.terminate().catch(() => {});
      worker = null;
      reject(new Error(`local vision ${type} timed out after ${CALL_TIMEOUT_MS}ms`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    // Buffers transfer as a real ArrayBuffer copy across the thread
    // boundary (structured clone) — no shared-memory hazards, no manual
    // serialization needed.
    w.postMessage({ id, type, buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) });
  });
}

// --- Concurrency-1 queue (Step 26: memory-safe concurrency) — still
// applies on top of the worker: only one image is ever in flight through
// the worker at a time, so its own memory stays bounded regardless of how
// many searches are running concurrently in the main process. ---
let queueTail = Promise.resolve();
function enqueue(fn) {
  const run = queueTail.then(fn, fn);
  queueTail = run.catch(() => {});
  return run;
}

// --- Real-usage cost/perf counters (Step 25) — in-memory, process-lifetime, same convention as providerHealth.js ---
const stats = { localImageAnalyses: 0, localCandidateComparisons: 0, cacheHits: 0, totalProcessingMs: 0, processedCount: 0 };
export function getLocalVisionStats() {
  return { ...stats, averageProcessingMs: stats.processedCount > 0 ? Math.round(stats.totalProcessingMs / stats.processedCount) : null };
}
export function recordCacheHit() { stats.cacheHits += 1; }

/** Hamming distance between two equal-length binary hash strings, mapped to a 0-100 similarity score (100 = identical). */
export function perceptualHashSimilarity(hashA, hashB) {
  if (!hashA || !hashB || hashA.length !== hashB.length) return null;
  let distance = 0;
  for (let i = 0; i < hashA.length; i++) if (hashA[i] !== hashB[i]) distance++;
  return Math.round((1 - distance / hashA.length) * 100);
}

/** Cosine similarity between two equal-length real number arrays, mapped to 0-100. */
export function embeddingSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  if (normA === 0 || normB === 0) return null;
  const cos = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.round(Math.max(0, Math.min(1, (cos + 1) / 2)) * 100);
}

/**
 * Full local analysis of one real uploaded image — the LOCAL_VISION
 * "Level 1" pass (Step 7). Every field is a real, computed value; nothing
 * here is guessed or invented. Runs through the concurrency-1 queue, and
 * through the worker-thread timeout above — never hangs indefinitely.
 * @param {Buffer} buffer real image bytes
 */
export async function analyzeLocal(buffer) {
  return enqueue(async () => {
    const startedAt = Date.now();
    const result = await callWorker('analyzeLocal', buffer);
    stats.localImageAnalyses += 1;
    stats.totalProcessingMs += Date.now() - startedAt;
    stats.processedCount += 1;
    return result;
  });
}

/** Lighter-weight local analysis for a candidate result's thumbnail — embedding + perceptual hash only. Also runs through the concurrency-1 queue and the worker timeout. */
export async function analyzeCandidateLocal(buffer) {
  return enqueue(async () => {
    const startedAt = Date.now();
    const result = await callWorker('analyzeCandidateLocal', buffer);
    stats.localCandidateComparisons += 1;
    stats.totalProcessingMs += Date.now() - startedAt;
    stats.processedCount += 1;
    return result;
  });
}
