// TikTok Marketing API v1.3 client. One small class of calls; the transport is injectable so the whole launch flow runs against the in-memory mock (mock.js) in tests and in the
// «تجريبي» mode, and against business-api.tiktok.com with the owner's token in real use. WRITES (POST) are NEVER retried automatically — a retried create can double-bill.
import { API_BASE } from './spec.js';

export class TikTokError extends Error {
  constructor(message, { code = null, requestId = null, status = null, path = null } = {}) { super(message); this.name = 'TikTokError'; this.code = code; this.requestId = requestId; this.status = status; this.path = path; }
}

/** TikTok's error → what it means and what to do, in Arabic. Keyword-based because TikTok's messages change; unknown → the raw message is still shown. */
export function explainTikTokError(err) {
  const msg = String(err?.message || err || ''); const code = Number(err?.code);
  const R = (title, action) => ({ title, action });
  if (/access token|auth(entication)?|token (is )?(invalid|expired)|40105|40104/i.test(msg) || code === 40105 || code === 40104) return R('التوكن بتاع تيك توك منتهي أو غلط', 'اربط حساب تيك توك من جديد (التوكن الجديد من TikTok for Business → Developers).');
  if (/permission|not authorized|no access|40001.*advertiser|scope/i.test(msg) || code === 40002 && /advertiser/i.test(msg)) return R('مفيش صلاحية على الحساب الإعلاني ده', 'اتأكد إن التوكن مربوط بالحساب الإعلاني ده وإن التطبيق عنده صلاحيات الإعلانات (Ads Management).');
  if (/rate limit|too many requests|frequency|40100|QPS/i.test(msg) || code === 40100) return R('تيك توك حاطّة حد طلبات مؤقت', 'استنى دقيقة أو اتنين وكمّل — الشغل اللي اتعمل متحفظ ومش هيتكرر.');
  if (/budget.*(low|min|less)|minimum.*budget|budget.*at least/i.test(msg)) return R('الميزانية أقل من الحد الأدنى بتاع تيك توك', 'ارفع الميزانية اليومية (الحد الأدنى بيختلف حسب العملة).');
  if (/pixel/i.test(msg)) return R('مشكلة في الـ Pixel', 'اتأكد إن الـ Pixel ده تابع للحساب الإعلاني وإن الحدث المختار موجود فيه.');
  if (/identity|display name|custom(ized)? user/i.test(msg)) return R('مشكلة في هوية الإعلان (البراند)', 'اتأكد من اسم البراند (حد أقصى 40 حرف) أو اختار هوية موجودة.');
  if (/video/i.test(msg) && /(format|size|duration|resolution|ratio|not found|process)/i.test(msg)) return R('الفيديو مش مقبول', 'الفيديو لازم يكون MP4 أو MOV، رأسي 9:16 (720×1280 أو أكبر)، من 5 ثواني لـ 60 ثانية، وأقل من 500MB. جرّب فيديو تاني.');
  if (/landing|url|domain|link/i.test(msg)) return R('لينك صفحة المنتج مرفوض', 'اتأكد إن اللينك https وبيفتح وإن الدومين مش محجوب على تيك توك.');
  if (/policy|violat|reject|not allowed|prohibit/i.test(msg)) return R('تيك توك رفضت المحتوى (سياسة الإعلانات)', 'راجع نص الإعلان والفيديو (ادعاءات طبية/قبل وبعد/ضمانات بتترفض غالبًا).');
  if (/parameter|invalid|missing|required|40002|40001/i.test(msg) || code === 40002 || code === 40001) return R('تيك توك رفضت بيانات في الطلب', 'راجع الحقل المذكور في الرسالة وصحّحه. لو مش واضح ابعت الرسالة دي.');
  if (/timeout|timed out|ECONN|network|fetch failed|50002|5\d\d/i.test(msg)) return R('تيك توك مش بترد دلوقتي', 'جرّب تاني بعد دقيقة. اللي اتعمل قبل كده متحفظ ومش هيتكرر.');
  return R('تيك توك رجّعت خطأ', 'اقرأ الرسالة تحت، ولو مش واضحة ابعتها.');
}

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const json = (v) => JSON.stringify(v);

/** Default transport: real HTTPS to TikTok. Returns TikTok's envelope { code, message, data, request_id }. */
export function httpTransport({ token, fetchImpl = fetch, timeoutMs = 30_000, base = API_BASE }) {
  return async (method, path, { query = null, body = null } = {}) => {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, typeof v === 'object' ? json(v) : String(v));
    const res = await fetchImpl(url.toString(), {
      method, headers: { 'Access-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? json(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => null);
    if (!data) throw new TikTokError(`TikTok HTTP ${res.status} (رد مش مفهوم)`, { status: res.status, path });
    return data;
  };
}

export function createTikTokClient({ advertiserId, transport }) {
  if (!advertiserId) throw new Error('advertiserId مطلوب');
  const call = async (method, path, { query, body } = {}) => {
    let env;
    try { env = await transport(method, path, { query, body }); }
    catch (e) { throw e instanceof TikTokError ? e : new TikTokError(e?.name === 'TimeoutError' ? 'timeout — تيك توك ماردتش في الوقت' : String(e?.message || e), { path }); }
    if (Number(env.code) !== 0) throw new TikTokError(env.message || `TikTok error ${env.code}`, { code: Number(env.code), requestId: env.request_id || null, path });
    return env.data ?? {};
  };
  const get = (path, query) => call('GET', path, { query: { advertiser_id: advertiserId, ...query } });
  const post = (path, body) => call('POST', path, { body: { advertiser_id: advertiserId, ...body } });

  return {
    advertiserId,
    /** { name, currency, timezone, status, balance } — also the «is the token good?» check. */
    async advertiserInfo() {
      const d = await call('GET', '/advertiser/info/', { query: { advertiser_ids: [advertiserId], fields: ['name', 'currency', 'timezone', 'status', 'balance', 'company'] } });
      const a = asArray(d.list)[0];
      if (!a) throw new TikTokError('الحساب الإعلاني مش ظاهر للتوكن ده', { code: 40002, path: '/advertiser/info/' });
      return { id: String(a.advertiser_id || advertiserId), name: a.name || a.company || '', currency: a.currency || '', timezone: a.timezone || 'Africa/Cairo', status: a.status || '', balance: a.balance ?? null };
    },
    async pixels() { const d = await get('/pixel/list/'); return asArray(d.pixels).map((p) => ({ id: String(p.pixel_id), name: p.pixel_name || String(p.pixel_id) })); },
    async identities() { const d = await get('/identity/get/', { identity_type: 'CUSTOMIZED_USER' }); return asArray(d.identity_list).map((i) => ({ id: String(i.identity_id), name: i.display_name || String(i.identity_id) })); },
    async createIdentity(displayName) { const d = await post('/identity/create/', { display_name: displayName }); return String(d.identity_id); },
    async interests() { const d = await get('/tool/interest_category/', { version: 2, placement: ['PLACEMENT_TIKTOK'] }); return asArray(d.interest_categories).map((c) => ({ id: String(c.interest_category_id), name: c.interest_category_name || String(c.interest_category_id) })); },
    /** Upload a video by public URL → video_id. */
    async uploadVideoByUrl(url, fileName) {
      const d = await post('/file/video/ad/upload/', { upload_type: 'UPLOAD_BY_URL', video_url: url, file_name: String(fileName || 'video').slice(0, 100) });
      const first = Array.isArray(d) ? d[0] : asArray(d.list)[0] || (d.video_id ? d : null) || asArray(d.videos)[0];
      if (!first?.video_id) throw new TikTokError('تيك توك ماردتش بـ video_id بعد رفع الفيديو', { path: '/file/video/ad/upload/' });
      return String(first.video_id);
    },
    /** Info for uploaded videos (cover URL, size, duration, processing state). */
    async videoInfo(videoIds) { const d = await get('/file/video/ad/info/', { video_ids: videoIds }); return asArray(d.list); },
    async uploadImageByUrl(url, fileName) { const d = await post('/file/image/ad/upload/', { upload_type: 'UPLOAD_BY_URL', image_url: url, file_name: String(fileName || 'cover').slice(0, 100) }); if (!d.image_id) throw new TikTokError('تيك توك ماردتش بـ image_id', { path: '/file/image/ad/upload/' }); return String(d.image_id); },
    async createCampaign(payload) { const d = await call('POST', '/campaign/create/', { body: payload }); return String(d.campaign_id); },
    async createAdGroup(payload) { const d = await call('POST', '/adgroup/create/', { body: payload }); return String(d.adgroup_id); },
    async createAds(payload) { const d = await call('POST', '/ad/create/', { body: payload }); return asArray(d.ad_ids).map(String); },
    async setStatus(level, ids, status) {
      const path = { campaign: '/campaign/status/update/', adgroup: '/adgroup/status/update/', ad: '/ad/status/update/' }[level];
      const key = { campaign: 'campaign_ids', adgroup: 'adgroup_ids', ad: 'ad_ids' }[level];
      if (!path) throw new Error('مستوى غير معروف');
      return post(path, { [key]: ids, operation_status: status });
    },
    async listCampaigns() { const d = await get('/campaign/get/', { fields: ['campaign_id', 'campaign_name', 'operation_status', 'objective_type', 'budget'], page_size: 100 }); return asArray(d.list); },
  };
}
