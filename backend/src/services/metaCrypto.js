// metaCrypto.js — AES-256-GCM encryption for the Meta Ads OAuth access
// token at rest (MetaConnection.access_token_enc). "Store the access token
// securely" is taken literally here: it's never stored in plaintext in the
// database, and nothing outside this file ever handles a raw token except
// to immediately encrypt it or, once decrypted, use it for a single Graph
// API call within services/metaGraphClient.js — never returned from any
// route, never logged.
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const hex = process.env.META_TOKEN_ENCRYPTION_KEY;
  if (!hex) throw new Error('META_TOKEN_ENCRYPTION_KEY مش متظبط — لازم قيمة hex بطول 32 بايت (64 حرف) في الـ .env.');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('META_TOKEN_ENCRYPTION_KEY لازم يكون 32 بايت (64 حرف hex) بالظبط.');
  return key;
}

/** @param {string} plaintext @returns {string} base64 "iv:authTag:ciphertext" packed together */
export function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM standard IV size
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/** @param {string} packed the base64 string encrypt() produced @returns {string} plaintext */
export function decrypt(packed) {
  const key = getKey();
  const buf = Buffer.from(packed, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
