// metaAuth.js — OAuth orchestration for the Meta Ads "Connect" flow
// (Facebook Login for Business, config_id-based). Owns the ONE place a raw
// access token exists outside metaCrypto.js/metaGraphClient.js: it decrypts
// just-in-time for a caller that needs to make a real Graph API call, and
// re-encrypts immediately after storing a new one. No route ever returns a
// raw token to the frontend.
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { encrypt, decrypt } from './metaCrypto.js';
import { exchangeCodeForToken, exchangeForLongLivedToken, getMe } from './metaGraphClient.js';

const CONFIG_ID = process.env.META_CONFIG_ID || '2166183033951878';
const AUTH_DIALOG_VERSION = 'v21.0';

function requiredEnv(name) {
  // .trim() defensively: a trailing newline/space from copy-pasting a
  // credential into Railway's Variables UI is invisible to the eye but
  // changes the string Facebook receives — a very common real-world cause
  // of "Error validating client secret" even when the value looks correct.
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} مش متظبط في الـ .env — لازم تضيفه الأول.`);
  return v;
}

export function getRedirectUri() {
  return process.env.META_REDIRECT_URI || `${requiredEnv('BACKEND_URL')}/api/meta/callback`;
}

/** The real Facebook OAuth dialog URL for this app's Facebook Login for Business configuration — a genuine navigation target, not an API call. */
export function buildAuthUrl(state) {
  const appId = requiredEnv('META_APP_ID');
  const url = new URL(`https://www.facebook.com/${AUTH_DIALOG_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', getRedirectUri());
  url.searchParams.set('config_id', CONFIG_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
}

export function generateState() {
  return crypto.randomBytes(24).toString('hex');
}

export async function getConnection() {
  return prisma.metaConnection.findUnique({ where: { id: 'default' } });
}

/** Real, current connection status for the frontend — deliberately never includes the token itself. */
export async function getStatus() {
  const c = await getConnection();
  if (!c || c.status !== 'CONNECTED') return { connected: false };
  return {
    connected: true,
    metaUserName: c.meta_user_name,
    selectedBusiness: c.selected_business_id ? { id: c.selected_business_id, name: c.selected_business_name } : null,
    selectedAdAccount: c.selected_ad_account_id ? { id: c.selected_ad_account_id, name: c.selected_ad_account_name } : null,
    tokenExpiresAt: c.token_expires_at,
    lastSyncedAt: c.last_synced_at,
    connectedAt: c.connected_at,
  };
}

/** Decrypts the stored token for a real Graph API call — throws a clear, honest error rather than a silent empty result when there's nothing to decrypt or it's expired. */
export async function getDecryptedToken() {
  const c = await getConnection();
  if (!c || c.status !== 'CONNECTED' || !c.access_token_enc) {
    throw new Error('مفيش حساب Meta Ads متصل دلوقتي.');
  }
  if (c.token_expires_at && new Date(c.token_expires_at) < new Date()) {
    throw new Error('انتهت صلاحية الاتصال بحساب Meta Ads — لازم تعيد الربط.');
  }
  return decrypt(c.access_token_enc);
}

/** Completes the real OAuth code exchange (code -> short-lived token -> long-lived token), then stores the encrypted result. Every step here is a genuine Graph API call — never fabricated. */
export async function completeOAuth({ code, connectedById }) {
  const appId = requiredEnv('META_APP_ID');
  const appSecret = requiredEnv('META_APP_SECRET');
  const redirectUri = getRedirectUri();

  const shortLived = await exchangeCodeForToken({ code, appId, appSecret, redirectUri });
  const longLived = await exchangeForLongLivedToken({ shortLivedToken: shortLived.access_token, appId, appSecret });

  const me = await getMe(longLived.access_token);
  const expiresAt = longLived.expires_in ? new Date(Date.now() + longLived.expires_in * 1000) : null;

  await prisma.metaConnection.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      status: 'CONNECTED',
      connected_by_id: connectedById,
      access_token_enc: encrypt(longLived.access_token),
      token_expires_at: expiresAt,
      meta_user_id: me.id,
      meta_user_name: me.name,
      connected_at: new Date(),
    },
    update: {
      status: 'CONNECTED',
      connected_by_id: connectedById,
      access_token_enc: encrypt(longLived.access_token),
      token_expires_at: expiresAt,
      meta_user_id: me.id,
      meta_user_name: me.name,
      connected_at: new Date(),
      disconnected_at: null,
    },
  });

  return { metaUserName: me.name, tokenExpiresAt: expiresAt };
}

export async function selectAdAccount({ adAccountId, adAccountName, businessId, businessName }) {
  return prisma.metaConnection.update({
    where: { id: 'default' },
    data: {
      selected_ad_account_id: adAccountId,
      selected_ad_account_name: adAccountName,
      selected_business_id: businessId || null,
      selected_business_name: businessName || null,
    },
  });
}

export async function markSynced() {
  return prisma.metaConnection.update({ where: { id: 'default' }, data: { last_synced_at: new Date() } });
}

/** A real disconnect — clears the token so it can never be used again; keeps the last-selected account name only as inert historical metadata (no security value), never re-usable without a fresh OAuth grant. */
export async function disconnect() {
  const existing = await getConnection();
  if (!existing) return;
  await prisma.metaConnection.update({
    where: { id: 'default' },
    data: { status: 'DISCONNECTED', access_token_enc: null, token_expires_at: null, disconnected_at: new Date() },
  });
}
