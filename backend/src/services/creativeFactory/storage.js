// AI Creative Factory — StorageService abstraction.
//
// Durable object storage for reference images + generated assets. Railway's
// filesystem is ephemeral, so nothing is ever written to disk. The DEFAULT
// `db` provider stores bytes in Postgres (cf_blobs, bytea) — durable, needs
// no external bucket or secret, works the moment the app boots. `s3`,
// `cloudinary` and `supabase` are config-ready placeholders: selecting one
// via CF_STORAGE_PROVIDER without its env vars fails loudly instead of
// silently losing images.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { storageProviderName } from './config.js';

export class CfStorageError extends Error {
  constructor(message, code = 'STORAGE_ERROR') { super(message); this.code = code; this.name = 'CfStorageError'; }
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function newKey(mime, prefix = 'cf') {
  return `${prefix}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${EXT[mime] || 'png'}`;
}

/** Parse a data: URL into { buffer, mime }. Throws CfStorageError on a malformed value. */
export function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) throw new CfStorageError('صيغة الصورة غير صالحة (data URL متوقعة).', 'BAD_DATA_URL');
  const mime = (m[1] || 'image/png').toLowerCase();
  const buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return { buffer, mime };
}

// ---------------------------------------------------------------------------
// db provider (default)
// ---------------------------------------------------------------------------
const dbProvider = {
  name: 'db',
  async put(buffer, { mime = 'image/png', prefix = 'cf' } = {}) {
    const key = newKey(mime, prefix);
    await prisma.cfBlob.create({ data: { key, data: buffer, mime, bytes: buffer.length } });
    return { provider: 'db', key, bytes: buffer.length, mime, url: null };
  },
  async get(key) {
    const row = await prisma.cfBlob.findUnique({ where: { key } });
    if (!row) return null;
    return { buffer: Buffer.from(row.data), mime: row.mime, bytes: row.bytes };
  },
  async del(key) {
    await prisma.cfBlob.deleteMany({ where: { key } });
  },
};

// ---------------------------------------------------------------------------
// External providers — config-ready placeholders. They intentionally throw a
// clear, non-secret error until their integration + env vars are added, so
// the app never pretends an image was stored when it wasn't.
// ---------------------------------------------------------------------------
function placeholder(name, envHint) {
  const fail = () => { throw new CfStorageError(`مزود التخزين "${name}" غير مُهيأ بعد — ${envHint}`, 'STORAGE_NOT_CONFIGURED'); };
  return { name, put: fail, get: fail, del: fail };
}

const PROVIDERS = {
  db: dbProvider,
  s3: placeholder('s3', 'ضيف S3_BUCKET/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY ثم فعّل CF_STORAGE_PROVIDER=s3.'),
  cloudinary: placeholder('cloudinary', 'ضيف CLOUDINARY_URL ثم فعّل CF_STORAGE_PROVIDER=cloudinary.'),
  supabase: placeholder('supabase', 'ضيف SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/SUPABASE_STORAGE_BUCKET ثم فعّل CF_STORAGE_PROVIDER=supabase.'),
};

export function activeStorageProvider() {
  const name = storageProviderName();
  return PROVIDERS[name] || dbProvider;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export const StorageService = {
  /** Store raw bytes. Returns { provider, key, bytes, mime, url }. */
  async putBuffer(buffer, opts = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new CfStorageError('لا توجد بيانات صورة لحفظها.', 'EMPTY_IMAGE');
    return activeStorageProvider().put(buffer, opts);
  },
  /** Store a data: URL (what the OpenAI Images API returns as b64_json, wrapped). */
  async putDataUrl(dataUrl, opts = {}) {
    const { buffer, mime } = parseDataUrl(dataUrl);
    return StorageService.putBuffer(buffer, { mime, ...opts });
  },
  /** Store a raw base64 string + known mime. */
  async putBase64(b64, mime = 'image/png', opts = {}) {
    return StorageService.putBuffer(Buffer.from(String(b64 || ''), 'base64'), { mime, ...opts });
  },
  /** { buffer, mime, bytes } or null. */
  async get({ provider, key }) {
    if (!key) return null;
    const p = PROVIDERS[provider] || activeStorageProvider();
    return p.get(key);
  },
  /** A `data:` URL for inlining into an <img> or a Claude vision block, or null. */
  async getDataUrl({ provider, key }) {
    const got = await StorageService.get({ provider, key });
    if (!got) return null;
    return `data:${got.mime};base64,${got.buffer.toString('base64')}`;
  },
  async del({ provider, key }) {
    if (!key) return;
    const p = PROVIDERS[provider] || activeStorageProvider();
    await p.del(key);
  },
};
