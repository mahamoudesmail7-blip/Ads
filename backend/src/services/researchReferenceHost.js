// researchReferenceHost.js — a SHORT-LIVED public URL for the owner's reference photo, so a reverse-image engine (Google Lens through SerpApi) can fetch it.
// The photo lives in memory only (never on disk, never in a log), under an unguessable 32-hex token, for 25 minutes, and is served by routes/researchReference.js.
import crypto from 'node:crypto';

const TTL_MS = 25 * 60 * 1000;
const MAX_ITEMS = 40;
const store = new Map(); // token -> { buffer, mediaType, expiresAt }

function sweep() { const now = Date.now(); for (const [t, v] of store) if (v.expiresAt <= now) store.delete(t); }

/** The app's own public origin (Railway sets RAILWAY_PUBLIC_DOMAIN). null → no reverse-image search (honest skip, never a made-up host). */
export function publicBaseUrl() {
  const explicit = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (/^https:\/\//.test(explicit)) return explicit;
  const rail = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (rail) return `https://${rail}`;
  const front = (process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
  return front.startsWith('https://') ? front : null;
}

/** @returns {{token:string, url:string|null}} url is null when the app has no known public origin. */
export function hostReferenceImage(imageBase64, mediaType = 'image/jpeg', { ttlMs = TTL_MS } = {}) {
  sweep();
  while (store.size >= MAX_ITEMS) store.delete(store.keys().next().value);
  const buffer = Buffer.from(String(imageBase64 || '').replace(/^data:[^,]*,/, ''), 'base64');
  if (buffer.length < 500 || buffer.length > 8 * 1024 * 1024) throw new Error('reference image size is not valid');
  const token = crypto.randomBytes(16).toString('hex');
  store.set(token, { buffer, mediaType: /^image\/(jpeg|png|webp|gif)$/.test(mediaType) ? mediaType : 'image/jpeg', expiresAt: Date.now() + ttlMs });
  const base = publicBaseUrl();
  return { token, url: base ? `${base}/api/research-ref/${token}` : null };
}

export function getHostedImage(token) {
  if (!/^[a-f0-9]{32}$/.test(String(token || ''))) return null;
  const v = store.get(token);
  if (!v) return null;
  if (v.expiresAt <= Date.now()) { store.delete(token); return null; }
  return v;
}

export function dropHostedImage(token) { store.delete(token); }
export const _hostedCount = () => store.size;
