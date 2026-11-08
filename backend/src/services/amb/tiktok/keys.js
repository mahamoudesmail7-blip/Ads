// TikTok connection: access token (AES-256-GCM, never returned by any route — only { last4 }), advertiser id, and the «تجريبي» (mock) switch. Own settings row so no other writer can clobber it.
// Env fallback: TIKTOK_ACCESS_TOKEN + TIKTOK_ADVERTISER_ID. The OWNER enters the token in the app; nothing here (or in the assistant) ever sees or logs it.
import { prisma } from '../../../prisma.js';
import { encrypt, decrypt } from '../../metaCrypto.js';
import { createTikTokClient, httpTransport } from './client.js';
import { createMockTikTok } from './mock.js';

const ROW = 'tiktok-keys';
const clean = (v) => String(v ?? '').trim().replace(/^["']|["']$/g, '');
const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const last4 = (v) => (v.length > 8 ? v.slice(-4) : '');

async function readRow() { const row = await prisma.settings.findUnique({ where: { id: ROW } }); return row ? parse(row.data) : {}; }
async function writeRow(o) { const data = JSON.stringify(o); await prisma.settings.upsert({ where: { id: ROW }, create: { id: ROW, data }, update: { data } }); }

export const validAdvertiserId = (v) => /^\d{6,25}$/.test(String(v || ''));
export const validToken = (v) => { const s = String(v || ''); return s.length >= 20 && s.length <= 400 && !/\s/.test(s); };

/** { mode: 'REAL' | 'MOCK' | 'NONE', token?, advertiserId? } — server-side only. */
export async function getConnection() {
  const row = await readRow();
  let token = null;
  if (row.token?.enc) { try { token = decrypt(row.token.enc); } catch { /* encryption key changed */ } }
  token = token || clean(process.env.TIKTOK_ACCESS_TOKEN) || null;
  const advertiserId = clean(row.advertiserId) || clean(process.env.TIKTOK_ADVERTISER_ID) || null;
  if (row.mock) return { mode: 'MOCK', advertiserId: null, token: null };
  if (token && validAdvertiserId(advertiserId)) return { mode: 'REAL', token, advertiserId };
  return { mode: 'NONE', token: null, advertiserId: null };
}

/** Status for the UI — never the token. */
export async function getStatus() {
  const row = await readRow(); const c = await getConnection();
  const env = !row.token?.enc && !!clean(process.env.TIKTOK_ACCESS_TOKEN);
  return { mode: c.mode, advertiserId: c.advertiserId || clean(row.advertiserId) || null, tokenSaved: !!row.token?.enc || env, tokenSource: row.token?.enc ? 'SAVED' : env ? 'ENV' : null, last4: row.token?.enc ? row.token.last4 || '' : '', updatedAt: row.updatedAt || null };
}

export async function saveCredentials({ token, advertiserId }) {
  const t = clean(token); const a = clean(advertiserId);
  if (!validAdvertiserId(a)) { const e = new Error('رقم الحساب الإعلاني (Advertiser ID) لازم يكون أرقام بس (من 6 لـ 25 رقم).'); e.status = 400; throw e; }
  const row = await readRow();
  if (t) {
    if (!validToken(t)) { const e = new Error('التوكن غير صالح (قصير أو فيه مسافات). انسخه كامل من TikTok for Business.'); e.status = 400; throw e; }
    row.token = { enc: encrypt(t), last4: last4(t) };
  } else if (!row.token?.enc && !clean(process.env.TIKTOK_ACCESS_TOKEN)) { const e = new Error('اكتب التوكن (Access Token).'); e.status = 400; throw e; }
  row.advertiserId = a; row.mock = false; row.updatedAt = new Date().toISOString();
  await writeRow(row);
  return getStatus();
}
export async function setMock(on) { const row = await readRow(); row.mock = !!on; row.updatedAt = new Date().toISOString(); await writeRow(row); return getStatus(); }
export async function clearCredentials() { const row = await readRow(); delete row.token; delete row.advertiserId; row.mock = false; row.updatedAt = new Date().toISOString(); await writeRow(row); return getStatus(); }

let mockSingleton = null;
export function getMock() { if (!mockSingleton) mockSingleton = createMockTikTok(); return mockSingleton; }
export function _resetMockForTests() { mockSingleton = null; }

/** The client for the current connection. REAL → business-api.tiktok.com; MOCK → the in-memory stand-in; NONE → throws a clear Arabic error. */
export async function getClient({ fetchImpl } = {}) {
  const c = await getConnection();
  if (c.mode === 'NONE') { const e = new Error('حساب تيك توك مش مربوط. اربطه الأول (Access Token + Advertiser ID) أو جرّب الوضع التجريبي.'); e.status = 409; e.code = 'TIKTOK_NOT_CONNECTED'; throw e; }
  if (c.mode === 'MOCK') { const m = getMock(); return { mode: 'MOCK', client: createTikTokClient({ advertiserId: m.advertiser.advertiser_id, transport: m.transport }) }; }
  return { mode: 'REAL', client: createTikTokClient({ advertiserId: c.advertiserId, transport: httpTransport({ token: c.token, fetchImpl }) }) };
}
