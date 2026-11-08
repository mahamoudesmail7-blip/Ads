// TikTok Marketing API — official OAuth (Advertiser authorization) + multi-account storage. READ-ONLY toward TikTok: it only exchanges the auth code, lists authorized advertisers and reads their info.
//
// Flow:  owner clicks «ربط» → POST /oauth/start (ADMIN) makes a single-use `state` (random, stored server-side with the user id + expiry, ALSO set as an httpOnly cookie) → browser goes to TikTok's authorization page
//        → TikTok redirects to our /oauth/callback?auth_code=…&state=… → state must equal the cookie AND be an unexpired, unused, same-user server record (it is deleted on first use) → auth_code is exchanged
//        (POST /oauth2/access_token/) → authorized advertisers are listed → each is upserted (ONE row per advertiser: re-linking updates it, never duplicates) with the token AES-256-GCM encrypted.
// Secrets: the App Secret and every token are encrypted at rest and NEVER returned by any route, logged, or put in a URL. App ID / Secret come from the owner (saved here encrypted, or env TIKTOK_APP_ID / TIKTOK_APP_SECRET).
import crypto from 'node:crypto';
import { prisma } from '../../../prisma.js';
import { encrypt, decrypt } from '../../metaCrypto.js';
import { API_BASE } from './spec.js';
import { TikTokError } from './client.js';

const ROW = 'tiktok-oauth';
export const AUTH_URL = 'https://business-api.tiktok.com/portal/auth';
export const STATE_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 10 * 60_000;
const clean = (v) => String(v ?? '').trim().replace(/^["']|["']$/g, '');
const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const last4 = (v) => (v.length > 8 ? v.slice(-4) : '');
const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

export const validAppId = (v) => /^\d{6,30}$/.test(String(v || ''));
export const validSecret = (v) => { const s = String(v || ''); return s.length >= 16 && s.length <= 200 && !/\s/.test(s); };

// ---- storage (one settings row; every read-modify-write is serialised so two callbacks can never interleave)
let chain = Promise.resolve();
const locked = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
async function readRow() { const row = await prisma.settings.findUnique({ where: { id: ROW } }); const d = row ? parse(row.data) : {}; return { app: d.app || null, grants: d.grants || {}, advertisers: d.advertisers || {}, active: d.active || null, states: d.states || {}, writes: !!d.writes, lastCallback: d.lastCallback || null }; }
async function writeRow(d) { const data = JSON.stringify(d); await prisma.settings.upsert({ where: { id: ROW }, create: { id: ROW, data }, update: { data } }); }
const mutate = (fn) => locked(async () => { const d = await readRow(); const r = await fn(d); await writeRow(d); return r; });
export const _readForTests = readRow;

// ---- the TikTok app (owner-provided)
export async function getApp() {
  const d = await readRow(); let secret = null;
  if (d.app?.secretEnc) { try { secret = decrypt(d.app.secretEnc); } catch { /* encryption key changed */ } }
  const appId = clean(d.app?.appId) || clean(process.env.TIKTOK_APP_ID) || null;
  secret = secret || clean(process.env.TIKTOK_APP_SECRET) || null;
  return { appId, secret };
}
export async function appStatus() {
  const d = await readRow(); const a = await getApp();
  return { configured: !!(a.appId && a.secret), appId: a.appId || null, secretSaved: !!a.secret, last4: d.app?.last4 || '', source: d.app?.secretEnc ? 'SAVED' : a.secret ? 'ENV' : null };
}
export async function setApp({ appId, secret }) {
  const id = clean(appId); const s = clean(secret);
  if (!validAppId(id)) throw bad('App ID لازم يكون أرقام بس (من 6 لـ 30 رقم). انسخه من My Apps في TikTok Developers.');
  return mutate(async (d) => {
    const cur = d.app || {};
    if (s) { if (!validSecret(s)) throw bad('الـ Secret غير صالح (قصير أو فيه مسافات). انسخه كامل.'); d.app = { appId: id, secretEnc: encrypt(s), last4: last4(s), updatedAt: new Date().toISOString() }; }
    else if (cur.secretEnc || clean(process.env.TIKTOK_APP_SECRET)) d.app = { ...cur, appId: id, updatedAt: new Date().toISOString() };
    else throw bad('اكتب الـ Secret.');
    return { configured: true };
  }).then(() => appStatus());
}
export async function clearApp() { await mutate(async (d) => { d.app = null; }); return appStatus(); }

// ---- redirect URL (what the owner pastes into TikTok Developers → «Advertiser redirect URL»)
export function redirectUri(baseUrl) {
  const base = clean(baseUrl) || clean(process.env.PUBLIC_BASE_URL) || 'https://ads-production-360b.up.railway.app';
  return `${base.replace(/\/+$/, '')}/api/amb-tiktok/oauth/callback`;
}

// ---- state (CSRF + replay protection)
export async function startAuth({ userId, baseUrl }, { now = Date.now() } = {}) {
  const app = await getApp(); if (!app.appId || !app.secret) throw bad('تطبيق تيك توك لسه مش متظبط: احفظ App ID والـ Secret الأول (بعد ما التطبيق يتوافق عليه).', 409, { code: 'TIKTOK_APP_NOT_CONFIGURED' });
  const state = crypto.randomBytes(24).toString('hex');
  await mutate(async (d) => {
    for (const [k, v] of Object.entries(d.states)) if (v.exp < now) delete d.states[k]; // prune expired
    const keys = Object.keys(d.states); if (keys.length >= 20) delete d.states[keys[0]]; // bounded
    d.states[state] = { userId: Number(userId) || null, exp: now + STATE_TTL_MS };
  });
  const url = `${AUTH_URL}?${new URLSearchParams({ app_id: app.appId, state, redirect_uri: redirectUri(baseUrl) }).toString()}`;
  return { state, url, expiresInSec: Math.round(STATE_TTL_MS / 1000) };
}
/** Validates and CONSUMES a state: unknown / expired / other user / already used → throws. Single use. */
export async function consumeState(state, userId, { now = Date.now() } = {}) {
  if (!/^[0-9a-f]{48}$/.test(String(state || ''))) throw bad('طلب الربط غير صالح (state). ابدأ الربط من جديد.', 400, { code: 'BAD_STATE' });
  const r = await mutate(async (d) => { // the state is burnt (persisted) BEFORE any check can fail — a failed attempt never leaves it usable
    const st = d.states[state];
    if (!st) return { err: 'STATE_USED' };
    delete d.states[state];
    if (st.exp < now) return { err: 'STATE_EXPIRED' };
    if (st.userId && Number(userId) && st.userId !== Number(userId)) return { err: 'STATE_USER' };
    return { ok: true };
  });
  if (r.err === 'STATE_USED') throw bad('طلب الربط ده اتستخدم قبل كده أو انتهى. ابدأ الربط من جديد.', 400, { code: 'STATE_USED' });
  if (r.err === 'STATE_EXPIRED') throw bad('انتهت مهلة طلب الربط (10 دقايق). ابدأ من جديد.', 400, { code: 'STATE_EXPIRED' });
  if (r.err === 'STATE_USER') throw bad('طلب الربط ده اتعمل بمستخدم تاني.', 403, { code: 'STATE_USER' });
  return true;
}

// ---- TikTok calls (injectable fetch). The envelope is { code, message, data }.
async function tt(method, path, { query, body, headers = {}, fetchImpl = fetch } = {}) {
  const url = new URL(API_BASE + path); for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  const res = await fetchImpl(url.toString(), { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const env = await res.json().catch(() => null);
  if (!env) throw new TikTokError(`TikTok HTTP ${res.status} (رد مش مفهوم)`, { status: res.status, path });
  if (Number(env.code) !== 0) throw new TikTokError(env.message || `TikTok error ${env.code}`, { code: Number(env.code), requestId: env.request_id || null, path });
  return env.data || {};
}
/** auth_code → tokens. Tolerant of the response shape (refresh token / expiry are optional). */
export async function exchangeAuthCode({ appId, secret, authCode }, deps = {}) {
  const d = await tt('POST', '/oauth2/access_token/', { body: { app_id: appId, secret, auth_code: authCode }, ...deps });
  if (!d.access_token) throw new TikTokError('تيك توك ماردتش بـ access_token', { path: '/oauth2/access_token/' });
  const ttl = Number(d.expires_in) > 0 ? Number(d.expires_in) : null; const rttl = Number(d.refresh_token_expires_in) > 0 ? Number(d.refresh_token_expires_in) : null;
  return { accessToken: String(d.access_token), refreshToken: d.refresh_token ? String(d.refresh_token) : null, expiresInSec: ttl, refreshExpiresInSec: rttl, advertiserIds: (Array.isArray(d.advertiser_ids) ? d.advertiser_ids : []).map(String), scope: Array.isArray(d.scope) ? d.scope : d.scope != null ? [d.scope] : [] };
}
export async function refreshAccessToken({ appId, secret, refreshToken }, deps = {}) {
  const d = await tt('POST', '/oauth2/refresh_token/', { body: { app_id: appId, secret, refresh_token: refreshToken }, ...deps });
  if (!d.access_token) throw new TikTokError('تيك توك ماردتش بـ access_token جديد', { path: '/oauth2/refresh_token/' });
  return { accessToken: String(d.access_token), refreshToken: d.refresh_token ? String(d.refresh_token) : refreshToken, expiresInSec: Number(d.expires_in) > 0 ? Number(d.expires_in) : null };
}
/** Which advertisers this token may use — the authoritative list from TikTok plus whatever the exchange returned. */
export async function listAuthorizedAdvertisers({ appId, secret, accessToken, fromExchange = [] }, deps = {}) {
  const ids = new Set(fromExchange.map(String)); const names = new Map();
  try { const d = await tt('GET', '/oauth2/advertiser/get/', { query: { app_id: appId, secret, access_token: accessToken }, ...deps }); for (const a of Array.isArray(d.list) ? d.list : []) { ids.add(String(a.advertiser_id)); if (a.advertiser_name) names.set(String(a.advertiser_id), a.advertiser_name); } } catch (e) { if (!ids.size) throw e; }
  return { ids: [...ids], names };
}
export async function readAdvertiserInfo({ accessToken, ids }, deps = {}) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const d = await tt('GET', '/advertiser/info/', { query: { advertiser_ids: JSON.stringify(chunk), fields: JSON.stringify(['name', 'currency', 'timezone', 'status', 'company']) }, headers: { 'Access-Token': accessToken }, ...deps }).catch(() => ({ list: [] }));
    for (const a of Array.isArray(d.list) ? d.list : []) out.set(String(a.advertiser_id), { name: a.name || a.company || '', currency: a.currency || '', timezone: a.timezone || 'Africa/Cairo', status: a.status || '' });
  }
  return out;
}

// ---- the callback
/**
 * Completes an authorization. Throws Arabic errors; on success returns { added, updated, advertisers:[{advertiserId,name,isNew}] }. cookieState must equal state (browser binding).
 */
export async function completeAuth({ authCode, state, cookieState, userId }, deps = {}, { now = Date.now() } = {}) {
  if (!authCode) throw bad('تيك توك ماردتش بكود التفويض (auth_code). ابدأ الربط من جديد.', 400, { code: 'NO_CODE' });
  if (!state || !cookieState || state !== cookieState) throw bad('الطلب ده مش من نفس المتصفح اللي بدأ الربط. ابدأ الربط من جديد.', 400, { code: 'STATE_COOKIE' });
  await consumeState(state, userId, { now });
  const app = await getApp(); if (!app.appId || !app.secret) throw bad('تطبيق تيك توك مش متظبط.', 409, { code: 'TIKTOK_APP_NOT_CONFIGURED' });
  const tok = await exchangeAuthCode({ appId: app.appId, secret: app.secret, authCode }, deps);
  const adv = await listAuthorizedAdvertisers({ appId: app.appId, secret: app.secret, accessToken: tok.accessToken, fromExchange: tok.advertiserIds }, deps);
  if (!adv.ids.length) throw bad('مفيش أي حساب إعلاني اتفوّض للتطبيق. في صفحة التفويض اختار حساب إعلاني واحد على الأقل.', 409, { code: 'NO_ADVERTISERS' });
  const info = await readAdvertiserInfo({ accessToken: tok.accessToken, ids: adv.ids }, deps);
  const nowIso = new Date(now).toISOString();
  return mutate(async (d) => {
    const grantId = crypto.randomBytes(6).toString('hex');
    d.grants[grantId] = { tokenEnc: encrypt(tok.accessToken), refreshEnc: tok.refreshToken ? encrypt(tok.refreshToken) : null, last4: last4(tok.accessToken), scope: tok.scope, expiresAt: tok.expiresInSec ? new Date(now + tok.expiresInSec * 1000).toISOString() : null, refreshExpiresAt: tok.refreshExpiresInSec ? new Date(now + tok.refreshExpiresInSec * 1000).toISOString() : null, advertiserIds: adv.ids, createdAt: nowIso, connectedBy: Number(userId) || null };
    let added = 0; let updated = 0; const advertisers = [];
    for (const id of adv.ids) {
      const prev = d.advertisers[id]; const i = info.get(id) || {};
      d.advertisers[id] = { grantId, name: i.name || adv.names.get(id) || prev?.name || id, currency: i.currency || prev?.currency || '', timezone: i.timezone || prev?.timezone || 'Africa/Cairo', status: i.status || prev?.status || '', connectedAt: prev?.connectedAt || nowIso, updatedAt: nowIso };
      if (prev) updated++; else added++;
      advertisers.push({ advertiserId: id, name: d.advertisers[id].name, isNew: !prev });
    }
    if (!d.active || !d.advertisers[d.active]) d.active = adv.ids[0];
    for (const [gid, g] of Object.entries(d.grants)) if (!Object.values(d.advertisers).some((a) => a.grantId === gid)) delete d.grants[gid]; // grants nobody uses any more
    d.lastCallback = { ok: true, at: nowIso, added, updated, count: adv.ids.length };
    return { added, updated, advertisers };
  });
}
export async function recordCallbackError(message, { now = Date.now() } = {}) { await mutate(async (d) => { d.lastCallback = { ok: false, at: new Date(now).toISOString(), message: String(message || '').slice(0, 300) }; }); }
/** The result of the last callback, shown ONCE on the screen. */
export async function takeLastCallback() { return mutate(async (d) => { const r = d.lastCallback; d.lastCallback = null; return r; }); }

// ---- accounts
export async function listAccounts() {
  const d = await readRow();
  return Object.entries(d.advertisers).map(([id, a]) => { const g = d.grants[a.grantId] || {}; const exp = g.expiresAt ? new Date(g.expiresAt).getTime() : null; return { advertiserId: id, name: a.name, currency: a.currency, timezone: a.timezone, status: a.status, connectedAt: a.connectedAt, active: d.active === id, tokenLast4: g.last4 || '', tokenExpiresAt: g.expiresAt || null, tokenExpired: exp ? exp < Date.now() && !g.refreshEnc : false, canRefresh: !!g.refreshEnc, scope: g.scope || [] }; }).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}
export async function setActive(advertiserId) { return mutate(async (d) => { if (!d.advertisers[advertiserId]) throw bad('الحساب الإعلاني ده مش مربوط.', 404); d.active = advertiserId; return { active: advertiserId }; }); }
export async function disconnect(advertiserId) {
  return mutate(async (d) => {
    if (!d.advertisers[advertiserId]) throw bad('الحساب الإعلاني ده مش مربوط.', 404);
    delete d.advertisers[advertiserId];
    for (const [gid] of Object.entries(d.grants)) if (!Object.values(d.advertisers).some((a) => a.grantId === gid)) delete d.grants[gid];
    if (d.active === advertiserId) d.active = Object.keys(d.advertisers)[0] || null;
    return { disconnected: advertiserId, active: d.active };
  });
}
export async function getWritesUnlocked() { return !!(await readRow()).writes; }
export async function setWritesUnlocked(on) { return mutate(async (d) => { d.writes = !!on; return { writes: d.writes }; }); }

/** The decrypted token for an advertiser (refreshing it first when it is about to expire and a refresh token exists). Server-side only. */
export async function getTokenFor(advertiserId, deps = {}, { now = Date.now() } = {}) {
  const d = await readRow(); const a = d.advertisers[advertiserId]; const g = a && d.grants[a.grantId];
  if (!g) return null;
  let token; try { token = decrypt(g.tokenEnc); } catch { return null; }
  const exp = g.expiresAt ? new Date(g.expiresAt).getTime() : null;
  if (exp && exp - now < REFRESH_MARGIN_MS && g.refreshEnc) {
    const app = await getApp(); let rt = null; try { rt = decrypt(g.refreshEnc); } catch { /* unreadable */ }
    if (app.appId && app.secret && rt) {
      try {
        const nt = await refreshAccessToken({ appId: app.appId, secret: app.secret, refreshToken: rt }, deps);
        await mutate(async (dd) => { const gg = dd.grants[a.grantId]; if (gg) { gg.tokenEnc = encrypt(nt.accessToken); gg.last4 = last4(nt.accessToken); gg.refreshEnc = nt.refreshToken ? encrypt(nt.refreshToken) : gg.refreshEnc; gg.expiresAt = nt.expiresInSec ? new Date(now + nt.expiresInSec * 1000).toISOString() : null; } });
        token = nt.accessToken;
      } catch { /* keep the old token: the real call will say if it is dead */ }
    }
  }
  return { token, advertiserId, name: a.name, currency: a.currency, timezone: a.timezone };
}
export async function getActiveAccount() { const d = await readRow(); return d.active && d.advertisers[d.active] ? { advertiserId: d.active, ...d.advertisers[d.active] } : null; }

// ---- permissions + accounts check (READ-ONLY: no write is attempted, because a write permission can only be proven by a write)
export async function checkAccount(advertiserId, { client, scope = [] }) {
  const checks = []; const add = (name, status, text) => checks.push({ name, status, text });
  let info = null;
  try { info = await client.advertiserInfo(); add('الوصول للحساب الإعلاني', 'OK', `${info.name || advertiserId} (${info.currency || '—'}) — ${info.status || 'متاح'}`); } catch (e) { add('الوصول للحساب الإعلاني', 'FAIL', String(e.message || e).slice(0, 200)); return { ok: false, checks, note: 'التوكن مش قادر يقرا الحساب. اربط الحساب من جديد.' }; }
  if (info.status && !/ENABLE|ACTIVE/i.test(info.status)) add('حالة الحساب', 'WARN', `حالة الحساب «${info.status}» — ممكن ما يقبلش حملات جديدة.`);
  try { const px = await client.pixels(); add('الـ Pixel', px.length ? 'OK' : 'WARN', px.length ? `${px.length} Pixel` : 'مفيش Pixel على الحساب — محتاجه لحملات المبيعات.'); } catch (e) { add('الـ Pixel', 'WARN', 'تعذّرت قراءة الـ Pixels: ' + String(e.message || e).slice(0, 120)); }
  try { const ids = await client.identities(); add('هويات الإعلان (البراند)', 'OK', `${ids.length} هوية`); } catch (e) { add('هويات الإعلان', 'WARN', 'تعذّرت قراءة الهويات: ' + String(e.message || e).slice(0, 120)); }
  if (scope.length) add('الصلاحيات الممنوحة', 'OK', `Scopes: ${scope.join(', ')}`);
  add('صلاحية إنشاء الحملات', 'INFO', 'مش بتتأكد غير بأول رفع حقيقي (تيك توك مفيهاش اختبار من غير كتابة). الرفع الحقيقي مقفول لحد ما تفتحه.');
  return { ok: !checks.some((c) => c.status === 'FAIL'), checks, info };
}
