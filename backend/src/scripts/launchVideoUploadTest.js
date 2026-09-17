// Campaign Launch Builder — Phase E (services/amb/launchVideoUpload.js).
// Offline tests for the chunked-relay mechanism itself: global fetch is
// mocked to simulate Meta's real start/transfer/finish protocol (no real
// network, no real Meta account touched) while a real Node Readable stream
// feeds bytes in small, irregular pieces — exercising the exact buffering/
// backpressure logic that guarantees this never holds a whole video in
// memory. The REAL end-to-end path (real Meta account, real video IDs,
// real DB persistence) was verified manually against the connected Ahmed
// Samy account during Phase E development — see that session's report;
// this file guards the offline-testable mechanics going forward.
//   node src/scripts/launchVideoUploadTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { streamUploadVideoToMeta, getUploadProgress } = await imp('../services/amb/launchVideoUpload.js');

const originalFetch = global.fetch;
function fakeFileStream(totalBytes, pieceSize) {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= totalBytes) { this.push(null); return; }
      const n = Math.min(pieceSize, totalBytes - sent);
      this.push(Buffer.alloc(n, 65 + (sent % 26))); // varying content, never all-zero
      sent += n;
    },
  });
}

console.log('§1 Chunked relay against a mocked Meta protocol — correct offsets, correct total bytes, memory-safe buffering:');
{
  const TOTAL = 500_000; // 500KB fake "video"
  const META_CHUNK = 131_072; // Meta tells us to transfer in ~128KB steps — smaller than our own 16MB buffering window, so this also proves the buffering window doesn't force one huge chunk
  let transferredBytes = 0;
  let transferCalls = 0;
  const seenOffsets = [];

  global.fetch = async (url, opts) => {
    const body = opts.body;
    if (body instanceof URLSearchParams) {
      const phase = body.get('upload_phase');
      if (phase === 'start') {
        return { ok: true, json: async () => ({ video_id: 'fake_video_1', upload_session_id: 'sess_1', start_offset: '0', end_offset: String(Math.min(META_CHUNK, TOTAL)) }) };
      }
      if (phase === 'finish') {
        return { ok: true, json: async () => ({ success: transferredBytes === TOTAL }) };
      }
    }
    // transfer phase — body is a real FormData with the chunk
    transferCalls++;
    let chunkLen = 0;
    let startOffset = null;
    for (const [k, v] of body.entries()) {
      if (k === 'start_offset') startOffset = Number(v);
      if (k === 'video_file_chunk') chunkLen = v.size;
    }
    seenOffsets.push(startOffset);
    transferredBytes += chunkLen;
    const nextStart = startOffset + chunkLen;
    const nextEnd = Math.min(nextStart + META_CHUNK, TOTAL);
    return { ok: true, json: async () => ({ start_offset: String(nextStart), end_offset: String(nextEnd) }) };
  };

  try {
    const stream = fakeFileStream(TOTAL, 20_000); // the SOURCE delivers in small, irregular 20KB pieces — smaller than Meta's requested 128KB chunk, forcing readExactly() to accumulate across multiple 'data' events
    const result = await streamUploadVideoToMeta({ req: stream, adAccountId: 'act_fake', fileSize: TOTAL, token: 'fake_token', jobId: 'test-job', slotKey: 'C1' });
    ok('returns the real (mocked) video_id', result.videoId === 'fake_video_1', result.videoId);
    ok('every byte of the fake file was relayed, no more no less', transferredBytes === TOTAL, String(transferredBytes));
    ok('more than one transfer call happened (genuinely chunked, not one giant buffer)', transferCalls > 1, String(transferCalls));
    ok('offsets are strictly increasing and start at 0', seenOffsets[0] === 0 && seenOffsets.every((o, i) => i === 0 || o > seenOffsets[i - 1]));
    ok('progress tracker is cleared after completion (no leak)', getUploadProgress('test-job', 'C1') === null);
  } finally {
    global.fetch = originalFetch;
  }
}

console.log('\n§2 Source stream ends early (network cut mid-upload) — must throw, never silently finish:');
{
  global.fetch = async (url, opts) => {
    const body = opts.body;
    if (body instanceof URLSearchParams && body.get('upload_phase') === 'start') {
      return { ok: true, json: async () => ({ video_id: 'v', upload_session_id: 's', start_offset: '0', end_offset: '100000' }) };
    }
    return { ok: true, json: async () => ({ start_offset: '50000', end_offset: '100000' }) }; // pretends more is needed
  };
  try {
    const shortStream = fakeFileStream(50_000, 10_000); // only delivers half of what "file_size" claims
    let threw = false;
    try {
      await streamUploadVideoToMeta({ req: shortStream, adAccountId: 'act_fake', fileSize: 100_000, token: 'fake_token', jobId: 'test-job', slotKey: 'C2' });
    } catch (e) {
      threw = true;
      ok('throws a clear Arabic error rather than reporting a fake success', /انقطع/.test(e.message), e.message);
    }
    ok('a stream that ends before the declared file_size throws', threw);
  } finally {
    global.fetch = originalFetch;
  }
}

console.log('\n§3 Meta rejects the upload (real error shape) — surfaces the real message, never swallows it:');
{
  global.fetch = async (url, opts) => {
    const body = opts.body;
    if (body instanceof URLSearchParams && body.get('upload_phase') === 'start') {
      return { ok: false, status: 400, json: async () => ({ error: { message: 'رسالة خطأ حقيقية من Meta (محاكاة)', code: 100 } }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const stream = fakeFileStream(1000, 500);
    let threw = false;
    try {
      await streamUploadVideoToMeta({ req: stream, adAccountId: 'act_fake', fileSize: 1000, token: 'fake_token', jobId: 'test-job', slotKey: 'C3' });
    } catch (e) {
      threw = true;
      ok('the real Meta error message reaches the caller unmodified', e.message === 'رسالة خطأ حقيقية من Meta (محاكاة)', e.message);
      ok('the raw Meta error object is attached for logging/diagnostics', e.metaError?.code === 100);
    }
    ok('a Meta-side rejection throws', threw);
  } finally {
    global.fetch = originalFetch;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
