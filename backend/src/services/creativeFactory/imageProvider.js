// AI Creative Factory — image generation provider abstraction.
//
// One adapter interface:
//   provider.name
//   provider.getCapabilities()          -> { edit, referenceImages, sizes, maxImages }
//   provider.generate({ prompt, size, n, referenceImages, quality }) -> { images:[{b64,mime}], usage, model, raw }
//
// `disabled` is the mock-safe default when OPENAI_API_KEY is absent: it
// throws a clear PROVIDER_NOT_CONFIGURED error and NEVER returns a fake
// image. `openai` targets the Images API (gpt-image-1) and is fully wired but
// inert until the key is set. The API key is read only here and never logged.
import { logger } from '../../logger.js';
import { openAiKey, imageModel, imageProviderName, imageQualityTier } from './config.js';

const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';
const OPENAI_EDITS_URL = 'https://api.openai.com/v1/images/edits';
const TIMEOUT_MS = 120000; // image generation is slow; bounded, single attempt (the job layer owns retries)

export class CfProviderError extends Error {
  constructor(message, code = 'PROVIDER_ERROR', httpStatus = null) {
    super(message);
    this.name = 'CfProviderError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// ---------------------------------------------------------------------------
// disabled provider
// ---------------------------------------------------------------------------
const disabledProvider = {
  name: 'disabled',
  getCapabilities() {
    return { edit: false, referenceImages: false, sizes: [], maxImages: 0, configured: false };
  },
  async generate() {
    throw new CfProviderError(
      'مزود إنشاء الصور غير متصل — ضيف OPENAI_API_KEY في متغيرات البيئة عشان تشغّل التوليد.',
      'PROVIDER_NOT_CONFIGURED',
    );
  },
};

// ---------------------------------------------------------------------------
// openai provider (gpt-image-1)
// ---------------------------------------------------------------------------
function fileFromDataish(img, idx) {
  // img is { b64, mime } or a data: URL string
  let mime = 'image/png';
  let b64 = '';
  if (typeof img === 'string') {
    const m = /^data:([^;,]+)?;base64,(.*)$/s.exec(img);
    if (m) { mime = m[1] || mime; b64 = m[2]; } else { b64 = img; }
  } else if (img && img.b64) {
    mime = img.mime || mime;
    b64 = img.b64;
  }
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
  // Blob + explicit filename is portable across Node 18/20/22 (File is only a
  // stable global from Node 20); undici's FormData reads the 3rd arg as the
  // filename part the OpenAI multipart endpoint needs.
  return { blob: new Blob([Buffer.from(b64, 'base64')], { type: mime }), filename: `reference_${idx}.${ext}` };
}

const openaiProvider = {
  name: 'openai',
  getCapabilities() {
    return {
      edit: true,
      referenceImages: true,
      sizes: ['1024x1024', '1024x1536', '1536x1024', 'auto'],
      maxImages: 10,
      configured: !!openAiKey(),
      model: imageModel(),
    };
  },
  async generate({ prompt, size = '1024x1024', n = 1, referenceImages = [], quality } = {}) {
    const key = openAiKey();
    if (!key) throw new CfProviderError('OPENAI_API_KEY مفقود.', 'PROVIDER_NOT_CONFIGURED');
    if (!prompt || !String(prompt).trim()) throw new CfProviderError('البرومبت فارغ.', 'EMPTY_PROMPT');

    const model = imageModel();
    const useEdit = Array.isArray(referenceImages) && referenceImages.length > 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const startedAt = Date.now();
    let res;
    try {
      if (useEdit) {
        const form = new FormData();
        form.append('model', model);
        form.append('prompt', String(prompt));
        form.append('size', size);
        form.append('n', String(n));
        if (quality || imageQualityTier()) form.append('quality', quality || imageQualityTier());
        referenceImages.slice(0, 10).forEach((img, i) => { const p = fileFromDataish(img, i); form.append('image[]', p.blob, p.filename); });
        res = await fetch(OPENAI_EDITS_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: form,
          signal: controller.signal,
        });
      } else {
        res = await fetch(OPENAI_IMAGES_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: String(prompt), size, n, quality: quality || imageQualityTier() }),
          signal: controller.signal,
        });
      }
    } catch (err) {
      clearTimeout(timer);
      const aborted = err.name === 'AbortError';
      throw new CfProviderError(
        aborted ? `انتهت مهلة إنشاء الصورة (${TIMEOUT_MS / 1000}s).` : `تعذر الاتصال بمزود إنشاء الصور: ${err.message}`,
        aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE',
      );
    }
    clearTimeout(timer);

    const bodyText = await res.text().catch(() => '');
    if (!res.ok) {
      let msg = bodyText.slice(0, 300);
      try { msg = JSON.parse(bodyText)?.error?.message || msg; } catch { /* keep raw */ }
      logger.error('CF_IMAGE_PROVIDER_HTTP_ERROR', { status: res.status, model, useEdit });
      throw new CfProviderError(`مزود إنشاء الصور رجّع خطأ ${res.status}: ${msg}`, 'PROVIDER_HTTP_ERROR', res.status);
    }

    let data;
    try { data = JSON.parse(bodyText); } catch { throw new CfProviderError('رد غير مفهوم من مزود إنشاء الصور.', 'PROVIDER_BAD_RESPONSE'); }
    const images = (data.data || [])
      .map((d) => (d.b64_json ? { b64: d.b64_json, mime: 'image/png' } : null))
      .filter(Boolean);
    if (!images.length) throw new CfProviderError('مزود إنشاء الصور ما رجّعش أي صورة.', 'PROVIDER_EMPTY');

    return {
      images,
      usage: data.usage || null,
      model,
      durationMs: Date.now() - startedAt,
      raw: { size, n, useEdit, created: data.created || null },
    };
  },
};

const REGISTRY = { disabled: disabledProvider, openai: openaiProvider };

/** The active provider adapter, per config. Always returns SOMETHING (falls back to disabled). */
export function getImageProvider() {
  const name = imageProviderName();
  const p = REGISTRY[name] || disabledProvider;
  // openai selected but no key -> behave as disabled (never crash a request path)
  if (p.name === 'openai' && !openAiKey()) return disabledProvider;
  return p;
}

export function imageProviderCapabilities() {
  return getImageProvider().getCapabilities();
}
