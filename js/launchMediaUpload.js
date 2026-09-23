// launchMediaUpload.js — shared Launch Builder media-validation/upload
// primitives (AI Media Buyer Operator, Phase 2 Slice 2). The validation
// logic and raw-binary upload convention here are copied verbatim from
// js/ai-media-buyer.js's proven, production-verified wizard implementation
// (never re-derived) so the chat-driven uploader (js/assistant.js) sends
// byte-for-byte the same requests the wizard already does — the wizard
// itself is left untouched here (not refactored to import this module) to
// avoid any risk of regressing a production-critical, currently-working
// upload path this late; both files intentionally hold their own copy of
// these pure, stateless functions rather than one importing from the other.

export const LAUNCH_MAX_VIDEOS = 300;
const META_VIDEO_EXTENSIONS = ['3g2', '3gp', '3gpp', 'asf', 'avi', 'dat', 'divx', 'dv', 'f4v', 'flv', 'gif', 'm2ts', 'm4v', 'mkv', 'mod', 'mov', 'mp4', 'mpe', 'mpeg', 'mpeg4', 'mpg', 'mts', 'nsv', 'ogm', 'ogv', 'qt', 'tod', 'ts', 'vob', 'wmv'];
const META_MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
const META_MIN_DURATION_SEC = 1;
const META_MAX_DURATION_SEC = 241 * 60;
const META_MIN_WIDTH = 600;
const META_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png'];
const META_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const META_MIN_IMAGE_DIM = 600;

export function naturalCompare(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }
function launchExtOf(filename) { const m = /\.([a-z0-9]+)$/i.exec(filename || ''); return m ? m[1].toLowerCase() : ''; }

/** True for a real image file (JPG/PNG) — everything else is routed through the video path. */
export function isLaunchImageFile(file) {
  if (file.type) return file.type.startsWith('image/');
  return META_IMAGE_EXTENSIONS.includes(launchExtOf(file.name));
}

/** A practical dedup fingerprint (first 4MB + total size) — never reads a whole multi-GB file into browser memory just to hash it. */
export async function computeLaunchContentHash(file) {
  try {
    const buf = await file.slice(0, 4 * 1024 * 1024).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex}:${file.size}`;
  } catch { return null; }
}

function probeLaunchVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true; v.src = url;
    const done = (fn) => { clearTimeout(timer); URL.revokeObjectURL(url); fn(); };
    const timer = setTimeout(() => done(() => reject(new Error('timeout'))), 15000);
    v.onloadedmetadata = () => { try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); } catch { done(() => resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight, thumbnailUrl: null })); } };
    v.onseeked = () => {
      let thumbnailUrl = null;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 160; canvas.height = Math.max(1, Math.round(160 * ((v.videoHeight || 120) / (v.videoWidth || 160))));
        canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
        thumbnailUrl = canvas.toDataURL('image/jpeg', 0.6);
      } catch { /* best-effort only */ }
      done(() => resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight, thumbnailUrl }));
    };
    v.onerror = () => done(() => reject(new Error('decode error')));
  });
}

export async function validateLaunchVideoFile(file) {
  const ext = launchExtOf(file.name);
  if (!META_VIDEO_EXTENSIONS.includes(ext)) return { ok: false, reason: `صيغة الملف (.${ext || '?'}) مش من صيغ الفيديو المدعومة من Meta.` };
  if (!(file.size > 0)) return { ok: false, reason: 'الملف فارغ.' };
  if (file.size > META_MAX_VIDEO_BYTES) return { ok: false, reason: 'حجم الملف أكبر من حد Meta الأقصى (4 جيجابايت).' };
  let meta;
  try { meta = await probeLaunchVideo(file); } catch { return { ok: false, reason: 'تعذّر قراءة الفيديو — الملف قد يكون تالفًا أو صيغته غير مدعومة من المتصفح.' }; }
  if (!Number.isFinite(meta.duration) || meta.duration <= 0) return { ok: false, reason: 'تعذّر قراءة مدة الفيديو — الملف قد يكون تالفًا.' };
  if (meta.duration < META_MIN_DURATION_SEC) return { ok: false, reason: 'الفيديو قصير جدًا.' };
  if (meta.duration > META_MAX_DURATION_SEC) return { ok: false, reason: 'الفيديو أطول من أقصى مدة يقبلها أي موضع إعلاني عند Meta (241 دقيقة).' };
  const warning = meta.width && meta.width < META_MIN_WIDTH ? `عرض الفيديو (${meta.width}px) أقل من حد Meta الأدنى الموصى به (600px) — ممكن يظهر بجودة رديئة.` : null;
  return { ok: true, duration: meta.duration, width: meta.width, height: meta.height, thumbnailUrl: meta.thumbnailUrl, warning };
}

function probeLaunchImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, thumbnailUrl: url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode error')); };
    img.src = url;
  });
}

export async function validateLaunchImageFile(file) {
  const ext = launchExtOf(file.name);
  if (!META_IMAGE_EXTENSIONS.includes(ext)) return { ok: false, reason: `صيغة الملف (.${ext || '?'}) مش من صيغ الصور المدعومة (JPG/PNG فقط).` };
  if (!(file.size > 0)) return { ok: false, reason: 'الملف فارغ.' };
  if (file.size > META_MAX_IMAGE_BYTES) return { ok: false, reason: 'حجم الملف أكبر من الحد الأقصى (8 ميجابايت).' };
  let meta;
  try { meta = await probeLaunchImage(file); } catch { return { ok: false, reason: 'تعذّر قراءة الصورة — الملف قد يكون تالفًا أو صيغته غير مدعومة من المتصفح.' }; }
  const warning = (meta.width && meta.width < META_MIN_IMAGE_DIM) || (meta.height && meta.height < META_MIN_IMAGE_DIM)
    ? `مقاس الصورة (${meta.width}×${meta.height}px) أقل من الحد الأدنى الموصى به من Meta (600×600px) — ممكن تظهر بجودة رديئة.` : null;
  return { ok: true, width: meta.width, height: meta.height, thumbnailUrl: meta.thumbnailUrl, warning };
}

/** Given the slot keys a job already has for one kind, returns the next `count` free sequential keys (C1.. for video, I1.. for image) — same convention js/ai-media-buyer.js's wizard uses, just parameterized instead of closing over its own launchState. */
export function nextSlotKeys(existingSlotKeys, count, kind = 'video') {
  const prefix = kind === 'image' ? 'I' : 'C';
  const used = new Set(existingSlotKeys);
  const keys = [];
  for (let n = 1; keys.length < count; n++) { const k = `${prefix}${n}`; if (!used.has(k)) keys.push(k); }
  return keys;
}

/** Raw-binary upload to the video route — NDJSON response, last line wins. Byte-for-byte the same request js/ai-media-buyer.js's uploadLaunchVideo() sends. */
export async function uploadLaunchVideoSlot({ jobId, slotKey, file, contentHash, duration }) {
  const res = await fetch(`/api/ai-media-buyer/launch/jobs/${jobId}/videos/${slotKey}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
      'X-Content-Hash': contentHash || '',
      'X-Duration-Seconds': Number.isFinite(duration) ? String(duration) : '',
    },
    body: file,
  });
  const text = await res.text();
  const lines = text.trim().split('\n').filter(Boolean);
  let last = null;
  for (const line of lines) { try { last = JSON.parse(line); } catch { /* ignore a malformed line, keep the last valid one */ } }
  if (!res.ok || !last || last.type === 'error') throw new Error(last?.message || `فشل رفع الفيديو (HTTP ${res.status}).`);
  return { videoId: last.videoId, reused: !!last.reused };
}

/** Raw-binary upload to the image route — single buffered JSON response. Byte-for-byte the same request js/ai-media-buyer.js's uploadLaunchImage() sends. */
export async function uploadLaunchImageSlot({ jobId, slotKey, file, contentHash, width, height }) {
  const res = await fetch(`/api/ai-media-buyer/launch/jobs/${jobId}/images/${slotKey}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
      'X-Content-Hash': contentHash || '',
      'X-Width': Number.isFinite(width) ? String(width) : '',
      'X-Height': Number.isFinite(height) ? String(height) : '',
    },
    body: file,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.imageHash) throw new Error(data?.message || `فشل رفع الصورة (HTTP ${res.status}).`);
  return { imageHash: data.imageHash, reused: !!data.reused };
}
