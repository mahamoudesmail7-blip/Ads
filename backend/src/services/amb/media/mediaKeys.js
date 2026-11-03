// AMB Media — provider keys (Apify / fal.ai / SerpApi) for the smart media tools inside the launch wizard.
// Stored AES-256-GCM encrypted (same metaCrypto as the Meta token) in their OWN settings row (id 'media-keys'),
// so no other settings writer can clobber or leak them. The env var is the fallback (`APIFY_TOKEN`, `FAL_KEY`, `SERPAPI_KEY`).
// A key is NEVER returned by any route — only { configured, source, last4 }. OpenAI is not here: it already lives in the
// central AI gateway (OPENAI_API_KEY env) and is only REPORTED.
import { prisma } from '../../../prisma.js';
import { encrypt, decrypt } from '../../metaCrypto.js';
import { isOpenAiConfigured } from '../../aiGateway/openaiClient.js';

const ROW = 'media-keys';
export const MEDIA_PROVIDERS = {
  apify: { env: 'APIFY_TOKEN', label: 'Apify', usedFor: 'بحث تيك توك وريلز ومكتبة إعلانات ميتا' },
  fal: { env: 'FAL_KEY', label: 'fal.ai', usedFor: 'فيديوهات الذكاء الاصطناعي (Kling والصوت)' },
  serpapi: { env: 'SERPAPI_KEY', label: 'SerpApi', usedFor: 'البحث بصورة المنتج (Google Lens) — اختياري' },
};

const clean = (v) => String(v ?? '').trim().replace(/^["']|["']$/g, '');
const last4 = (v) => (v.length > 8 ? v.slice(-4) : '');
const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

async function readRow() {
  const row = await prisma.settings.findUnique({ where: { id: ROW } });
  return row ? parse(row.data) : {};
}
async function writeRow(obj) {
  const data = JSON.stringify(obj);
  await prisma.settings.upsert({ where: { id: ROW }, create: { id: ROW, data }, update: { data } });
}

/** The decrypted key for a provider (saved value first, env fallback) or null. For server-side use only. */
export async function getMediaKey(provider) {
  const p = MEDIA_PROVIDERS[provider];
  if (!p) throw new Error(`مزوّد غير معروف: ${provider}`);
  const saved = (await readRow())[provider];
  if (saved?.enc) { try { return decrypt(saved.enc); } catch { /* unreadable (encryption key changed) — fall through to env */ } }
  return clean(process.env[p.env]) || null;
}

/** Status only — never the key. */
export async function getMediaKeysStatus() {
  const row = await readRow();
  const providers = {};
  for (const [id, p] of Object.entries(MEDIA_PROVIDERS)) {
    const saved = row[id];
    const envVal = clean(process.env[p.env]);
    providers[id] = {
      label: p.label, usedFor: p.usedFor,
      configured: !!(saved?.enc || envVal),
      source: saved?.enc ? 'SAVED' : envVal ? 'ENV' : null,
      last4: saved?.enc ? saved.last4 || '' : last4(envVal),
      updatedAt: saved?.updatedAt || null,
    };
  }
  providers.openai = { label: 'OpenAI', usedFor: 'ترتيب الأغلفة وفحص التطابق وصور الصفحة', configured: isOpenAiConfigured(), source: isOpenAiConfigured() ? 'ENV' : null, last4: '', updatedAt: null, envOnly: true };
  return providers;
}

export async function setMediaKey(provider, value) {
  if (!MEDIA_PROVIDERS[provider]) { const e = new Error('مزوّد غير معروف.'); e.status = 400; throw e; }
  const v = clean(value);
  if (v.length < 12 || /\s/.test(v)) { const e = new Error('المفتاح غير صالح (قصير أو فيه مسافات).'); e.status = 400; throw e; }
  const row = await readRow();
  row[provider] = { enc: encrypt(v), last4: last4(v), updatedAt: new Date().toISOString() };
  await writeRow(row);
  return (await getMediaKeysStatus())[provider];
}

export async function clearMediaKey(provider) {
  if (!MEDIA_PROVIDERS[provider]) { const e = new Error('مزوّد غير معروف.'); e.status = 400; throw e; }
  const row = await readRow();
  delete row[provider];
  await writeRow(row);
  return (await getMediaKeysStatus())[provider];
}

const probe = async (url, init) => { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }); return { status: r.status, json: await r.json().catch(() => null) }; };

/** Live check of a saved key. Apify and SerpApi have a free account endpoint; fal has none we can rely on, so it is reported as "saved, not verified". */
export async function testMediaKey(provider, { fetchImpl } = {}) {
  const key = await getMediaKey(provider);
  if (!key) return { ok: false, verified: false, message: 'مفيش مفتاح متسجّل.' };
  const call = fetchImpl || probe;
  if (provider === 'apify') {
    const r = await call('https://api.apify.com/v2/users/me', { headers: { Authorization: `Bearer ${key}` } });
    if (r.status === 401) return { ok: false, verified: true, message: 'Apify: التوكن غلط.' };
    if (r.status !== 200) return { ok: false, verified: true, message: `Apify ردّ بحالة ${r.status}.` };
    const d = r.json?.data || {};
    return { ok: true, verified: true, message: `Apify شغّال — @${d.username || '?'} · ${d.plan?.id || 'plan'}` };
  }
  if (provider === 'serpapi') {
    const r = await call(`https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`, {});
    if (r.status !== 200) return { ok: false, verified: true, message: 'SerpApi: المفتاح غلط أو مرفوض.' };
    return { ok: true, verified: true, message: `SerpApi شغّال — باقي ${r.json?.total_searches_left ?? '?'} بحث.` };
  }
  return { ok: true, verified: false, message: 'المفتاح اتحفظ، لكن fal.ai ملوهوش فحص مجاني — هيتأكد أول فيديو AI.' };
}
