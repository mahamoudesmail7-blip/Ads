// Campaign Launch Builder — Phase E: real video upload, browser -> this
// backend -> Meta's resumable video upload, relaying fixed-size chunks
// as they arrive off the incoming HTTP request stream. NEVER buffers a
// full video in memory: at most one in-flight chunk (the size Meta itself
// requests per transfer call, typically a few MB) plus a small read-ahead
// window is held at once, regardless of the total file size.
//
// Deliberately raw binary POST (one video per request, metadata via
// headers), not multipart/form-data — this codebase has no streaming
// multipart parser and deliberately avoids multer's buffer-first model
// (see easyOrdersImport.js's header comment); a single-file raw body needs
// no such parser at all and streams natively via the Node http request
// object. The Meta access token never leaves this backend — the browser
// only ever talks to our own /launch/jobs/:jobId/videos/:slotKey route.
import { getConnection, getDecryptedToken } from '../metaAuth.js';

const GRAPH_VERSION = 'v21.0'; // matches metaGraphClient.js's GRAPH_VERSION — same connection, same API version, never a second integration
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Live per-(job,slot) progress, purely for UI polling — never the source of
// truth for whether an upload succeeded (that's the DB row's status/
// meta_video_id, written by the route only after Meta itself confirms).
// Lost on server restart, which is fine: the frontend's upload request
// itself is still the real, authoritative in-flight operation; a lost
// progress entry just means the polling UI stops updating until the main
// request resolves.
const progressByKey = new Map();
const progressKey = (jobId, slotKey) => `${jobId}::${slotKey}`;
export function getUploadProgress(jobId, slotKey) {
  return progressByKey.get(progressKey(jobId, slotKey)) || null;
}
function setUploadProgress(jobId, slotKey, bytesSent, totalBytes) {
  progressByKey.set(progressKey(jobId, slotKey), { bytesSent, totalBytes, updatedAt: Date.now() });
}
function clearUploadProgress(jobId, slotKey) {
  progressByKey.delete(progressKey(jobId, slotKey));
}

// None of Meta's fetch() calls in this file had a timeout — confirmed live
// as the actual cause of uploads hanging forever at "100%": the LAST chunk
// transfers fine (progress hits fileSize/fileSize), then the 'finish' phase
// call to Meta stalls with no response and no connection error, so the
// `await` never resolves or rejects. The route's try/catch around
// streamUploadVideoToMeta() can only mark a video FAILED (and let the
// frontend's retry button work) if the promise it's awaiting actually
// settles — a hung fetch defeats that entirely, leaving the DB row stuck at
// UPLOADING and the browser's own request hung the same way. AbortController
// timeouts here are what make a stall fail cleanly instead of hanging.
const METADATA_TIMEOUT_MS = 30000; // 'start'/'finish' calls carry no file bytes — should be fast
const CHUNK_TIMEOUT_MS = 90000; // a real chunk transfer (a few MB) over a slow connection needs more room

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Meta لم ترد خلال ${Math.round(timeoutMs / 1000)} ثانية — الاتصال عالق، أعد المحاولة.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function metaGraphForm(path, fields) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
  const res = await fetchWithTimeout(`${GRAPH_BASE}${path}`, { method: 'POST', body: form }, METADATA_TIMEOUT_MS);
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.error) {
    const e = json?.error || {};
    const err = new Error(e.message || `Meta upload request failed (HTTP ${res.status})`);
    err.metaError = e;
    throw err;
  }
  return json;
}

async function metaTransferChunk(adAccountId, token, { uploadSessionId, startOffset, chunk }) {
  const form = new FormData();
  form.append('upload_phase', 'transfer');
  form.append('upload_session_id', uploadSessionId);
  form.append('start_offset', String(startOffset));
  form.append('access_token', token);
  form.append('video_file_chunk', new Blob([chunk]), 'chunk');
  const res = await fetchWithTimeout(`${GRAPH_BASE}/${adAccountId}/advideos`, { method: 'POST', body: form }, CHUNK_TIMEOUT_MS);
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.error) {
    const e = json?.error || {};
    const err = new Error(e.message || `Meta chunk transfer failed (HTTP ${res.status})`);
    err.metaError = e;
    throw err;
  }
  return json; // { start_offset, end_offset }
}

/** Best-effort processing status for an uploaded video (e.g. 'ready', 'processing', 'error'). Never throws — a status-check failure shouldn't fail the upload it's checking on. */
export async function getMetaVideoStatus(token, videoId) {
  try {
    const res = await fetchWithTimeout(`${GRAPH_BASE}/${videoId}?fields=status&access_token=${encodeURIComponent(token)}`, {}, METADATA_TIMEOUT_MS);
    const json = await res.json();
    return json?.status?.video_status || null;
  } catch {
    return null;
  }
}

/**
 * A video ad creative requires an explicit thumbnail (confirmed live: Meta
 * rejects adcreatives creation with "Your ad needs a video thumbnail"
 * otherwise) — Meta auto-generates several once the video finishes
 * processing (confirmed live via GET .../{video-id}?fields=picture,
 * thumbnails), so this just reads that back rather than uploading a new
 * image. Returns null if the video has no thumbnail yet (still
 * processing) — the caller must not build a creative in that case.
 */
export async function getMetaVideoThumbnailUrl(token, videoId) {
  try {
    const res = await fetchWithTimeout(`${GRAPH_BASE}/${videoId}?fields=picture&access_token=${encodeURIComponent(token)}`, {}, METADATA_TIMEOUT_MS);
    const json = await res.json();
    return json?.picture || null;
  } catch {
    return null;
  }
}

/**
 * Buffers just enough of an incoming Node Readable stream to serve
 * readExactly(n) calls — never the whole stream. Pauses the source once
 * more than ~16MB is buffered ahead of what's been consumed, so a fast
 * incoming stream can never run far ahead of a slower outgoing relay to
 * Meta. This is the entire memory-safety mechanism: total resident memory
 * for one upload is bounded by this window, not by file size.
 */
class ChunkReader {
  constructor(stream) {
    this.stream = stream;
    this.buffers = [];
    this.bufferedLength = 0;
    this.ended = false;
    this.error = null;
    this.waiter = null;
    stream.on('data', (chunk) => {
      this.buffers.push(chunk);
      this.bufferedLength += chunk.length;
      this._wake();
      if (this.bufferedLength > 16 * 1024 * 1024) stream.pause();
    });
    stream.on('end', () => { this.ended = true; this._wake(); });
    stream.on('error', (err) => { this.error = err; this._wake(); });
  }
  _wake() { if (this.waiter) { const w = this.waiter; this.waiter = null; w(); } }
  async readExactly(n) {
    while (this.bufferedLength < n && !this.ended && !this.error) {
      await new Promise((resolve) => { this.waiter = resolve; this.stream.resume(); });
    }
    if (this.error) throw this.error;
    const take = Math.min(n, this.bufferedLength);
    if (take === 0) return Buffer.alloc(0);
    const combined = this.buffers.length === 1 ? this.buffers[0] : Buffer.concat(this.buffers, this.bufferedLength);
    const out = Buffer.from(combined.subarray(0, take)); // copy out — the shared backing buffer is dropped right after
    const rest = combined.subarray(take);
    this.buffers = rest.length ? [rest] : [];
    this.bufferedLength = rest.length;
    return out;
  }
}

/**
 * Streams `req` (an in-progress HTTP request body — the video bytes) to
 * Meta's resumable /advideos upload for `adAccountId`, chunk by chunk, at
 * exactly the offsets Meta's own API requests each step. Returns the real
 * Meta video_id once Meta confirms the upload is finished. Throws on any
 * failure (network, Meta error, stream cut short) — the caller is
 * responsible for recording that as a FAILED video asset.
 */
export async function streamUploadVideoToMeta({ req, adAccountId, fileSize, token, jobId, slotKey }) {
  const start = await metaGraphForm(`/${adAccountId}/advideos`, { upload_phase: 'start', file_size: fileSize, access_token: token });
  const videoId = start.video_id;
  const sessionId = start.upload_session_id;
  let startOffset = Number(start.start_offset);
  let endOffset = Number(start.end_offset);

  const reader = new ChunkReader(req);
  let sent = 0;
  setUploadProgress(jobId, slotKey, 0, fileSize);
  try {
    while (endOffset > startOffset) {
      const need = endOffset - startOffset;
      const chunk = await reader.readExactly(need);
      if (chunk.length === 0) throw new Error('انقطع رفع الفيديو قبل اكتماله — الاتصال اتقفل بدري.');
      const result = await metaTransferChunk(adAccountId, token, { uploadSessionId: sessionId, startOffset, chunk });
      sent += chunk.length;
      setUploadProgress(jobId, slotKey, sent, fileSize);
      startOffset = Number(result.start_offset);
      endOffset = Number(result.end_offset);
    }
    const fin = await metaGraphForm(`/${adAccountId}/advideos`, { upload_phase: 'finish', upload_session_id: sessionId, access_token: token });
    if (!fin.success) throw new Error('فشل إنهاء رفع الفيديو على Meta.');
    return { videoId, sessionId };
  } finally {
    clearUploadProgress(jobId, slotKey);
  }
}

/** Real, current Meta access token for the launch wizard's video uploads — the SAME single global connection every other Meta call in this app uses. */
export async function requireLaunchToken() {
  const connection = await getConnection();
  if (!connection || connection.status !== 'CONNECTED') { const e = new Error('اربط حساب Meta Ads الأول.'); e.status = 400; throw e; }
  return getDecryptedToken();
}
