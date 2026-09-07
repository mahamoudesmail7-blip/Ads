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

// The permissions the CURRENT system actually uses:
//   ads_read / ads_management  — read + (approved) write of campaigns/ad sets/ads
//   business_management         — see Business Portfolios + their owned assets
//   pages_show_list / pages_read_engagement — list the Pages a destination
//                                 account can post as (Campaign Clone identity)
//   pages_manage_ads           — create ad creatives that post as a Page
//   instagram_basic            — resolve Instagram identities for the clone
// Used ONLY by the classic-dialog fallback (`?mode=classic`); the default
// Business-Login (config_id) flow takes its permission set from the App's
// Login configuration, and the user picks which Businesses/Pages to share on
// Facebook's own screen.
export const DEFAULT_OAUTH_SCOPES = [
  'ads_read', 'ads_management', 'business_management',
  'pages_show_list', 'pages_read_engagement', 'pages_manage_ads', 'instagram_basic',
];

// .env.example documents every Meta var wrapped in double quotes
// (META_APP_ID="", META_CONFIG_ID="2166183033951878", ...) — correct .env
// file syntax, but Railway's Variables UI is a plain text field with no
// quote-stripping of its own. Pasting a credential the same way it's shown
// in .env.example (quotes included) makes process.env.X literally start
// and end with a `"` character — invisible in a quick glance at the
// Railway UI, but a different string than Facebook expects. Combined with
// a trailing newline/space (also invisible), this is the single most
// likely real-world cause of "Error validating client secret" when the
// underlying App ID/Secret pair is actually correct. Both are stripped
// defensively here, for every Meta env var, not just the ones already
// suspected.
function cleanEnvValue(raw) {
  if (raw === undefined || raw === null) return raw;
  let v = raw.trim();
  if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function requiredEnv(name) {
  const v = cleanEnvValue(process.env[name]);
  if (!v) throw new Error(`${name} مش متظبط في الـ .env — لازم تضيفه الأول.`);
  return v;
}

export function getRedirectUri() {
  const explicit = cleanEnvValue(process.env.META_REDIRECT_URI);
  return explicit || `${requiredEnv('BACKEND_URL')}/api/meta/callback`;
}

/** Safe (no secret values, only presence/shape) snapshot of the Meta env vars actually in effect right now — logged at the moment a real connection is attempted, per explicit request, so a live Railway log line during the next real attempt can confirm or rule out a bad/misformatted value without ever exposing it. */
export function debugEnvSnapshot() {
  const rawAppId = process.env.META_APP_ID;
  const rawAppSecret = process.env.META_APP_SECRET;
  const rawRedirect = process.env.META_REDIRECT_URI;
  return {
    hasAppId: Boolean(rawAppId),
    hasAppSecret: Boolean(rawAppSecret),
    appIdLength: rawAppId?.length ?? null,
    appSecretLength: rawAppSecret?.length ?? null,
    appIdLooksQuoted: Boolean(rawAppId && rawAppId.trim().length >= 2 && (rawAppId.trim()[0] === '"' || rawAppId.trim()[0] === "'")),
    appSecretLooksQuoted: Boolean(rawAppSecret && rawAppSecret.trim().length >= 2 && (rawAppSecret.trim()[0] === '"' || rawAppSecret.trim()[0] === "'")),
    appIdHasWhitespace: Boolean(rawAppId && rawAppId !== rawAppId.trim()),
    appSecretHasWhitespace: Boolean(rawAppSecret && rawAppSecret !== rawAppSecret.trim()),
    redirectUriConfigured: Boolean(rawRedirect),
    redirectUriInEffect: getRedirectUri(),
    configId: CONFIG_ID,
    nodeEnv: process.env.NODE_ENV,
  };
}

/**
 * The real Facebook OAuth dialog URL. Two modes, both genuine navigation
 * targets:
 *   default  — Facebook Login for Business (config_id). Permissions + asset
 *              types come from the App's Login configuration; the user picks
 *              which Business Portfolios / Pages / ad accounts to share on
 *              Facebook's screen.
 *   classic  — a plain OAuth dialog with an explicit `scope` list. Use this to
 *              request Page scopes the config_id flow doesn't include, without
 *              editing the App dashboard.
 * `rerequest` forces Facebook to re-show the consent/asset screen even when
 * the user already granted something (needed to ADD a second Business
 * Portfolio or extra permissions to an existing grant).
 */
export function buildAuthUrl(state, { mode = 'config', rerequest = false } = {}) {
  const appId = requiredEnv('META_APP_ID');
  const url = new URL(`https://www.facebook.com/${AUTH_DIALOG_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', getRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  if (mode === 'classic') {
    const scopes = (cleanEnvValue(process.env.META_OAUTH_SCOPES) || DEFAULT_OAUTH_SCOPES.join(',')).replace(/\s+/g, '');
    url.searchParams.set('scope', scopes);
  } else {
    url.searchParams.set('config_id', CONFIG_ID);
  }
  if (rerequest) url.searchParams.set('auth_type', 'rerequest');
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

  // Re-auth by the SAME Meta user (adding a Business Portfolio / extra
  // permissions to the grant) just refreshes the token in place — the
  // existing selected account + all mappings are preserved. A DIFFERENT Meta
  // user is a deliberate account switch; today the system holds one
  // connection, so surface it clearly rather than swap tokens silently.
  const existing = await prisma.metaConnection.findUnique({ where: { id: 'default' } });
  const userChanged = existing?.status === 'CONNECTED' && existing.meta_user_id && existing.meta_user_id !== me.id;

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

  return { metaUserName: me.name, tokenExpiresAt: expiresAt, userChanged, previousUserName: userChanged ? existing.meta_user_name : null };
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
