// An in-memory stand-in for the TikTok Marketing API: same envelope ({ code, message, data }), same required-field checks as the real create calls, a call log. It lets the whole wizard
// + launch run with NO credentials («الوضع التجريبي» — for learning the screens and for the tests) and lets the tests inject failures at any step to prove nothing is duplicated.
// It is clearly labelled in the UI; nothing it «creates» exists on TikTok.
let seq = 1000;
const id = () => String(++seq) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');

const fail = (code, message) => ({ code, message, request_id: 'mock-req' });
const ok = (data) => ({ code: 0, message: 'OK', data, request_id: 'mock-req' });

export function createMockTikTok({ advertiser = {}, failures = {}, latencyMs = 0 } = {}) {
  const state = { campaigns: new Map(), adgroups: new Map(), ads: new Map(), videos: new Map(), images: new Map(), identities: new Map(), log: [], failuresLeft: { ...failures } };
  const A = { advertiser_id: '7000000000001', name: 'حساب تجريبي', currency: 'EGP', timezone: 'Africa/Cairo', status: 'STATUS_ENABLE', balance: 5000, ...advertiser };
  state.identities.set('mock_identity_1', { identity_id: 'mock_identity_1', display_name: 'براند تجريبي' });
  const pixels = [{ pixel_id: 'MOCKPIXEL001', pixel_name: 'Pixel المتجر (تجريبي)' }];
  const interests = [['10001', 'الجمال والعناية'], ['10002', 'الصحة واللياقة'], ['10003', 'المنزل والمطبخ'], ['10004', 'الأجهزة والإلكترونيات'], ['10005', 'الموضة'], ['10006', 'الأم والطفل']].map(([i, n]) => ({ interest_category_id: i, interest_category_name: n }));

  const need = (body, fields) => fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');

  async function transport(method, path, { query = null, body = null } = {}) {
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
    state.log.push({ method, path, body: body ? JSON.parse(JSON.stringify(body)) : null, query });
    // injected failure: consumed once, so a RESUME of the same step then succeeds (proves resume works and nothing is duplicated)
    for (const key of Object.keys(state.failuresLeft)) if (path.includes(key) && state.failuresLeft[key] > 0) { state.failuresLeft[key]--; return fail(40002, `Invalid parameter (mock failure injected on ${key})`); }
    switch (path) {
      case '/advertiser/info/': return ok({ list: [A] });
      case '/pixel/list/': return ok({ pixels });
      case '/identity/get/': return ok({ identity_list: [...state.identities.values()] });
      case '/identity/create/': { const m = need(body, ['display_name']); if (m.length) return fail(40002, `Missing required: ${m}`); if (String(body.display_name).length > 40) return fail(40002, 'display_name too long'); const identity_id = 'mock_identity_' + id(); state.identities.set(identity_id, { identity_id, display_name: body.display_name }); return ok({ identity_id }); }
      case '/tool/interest_category/': return ok({ interest_categories: interests });
      case '/file/video/ad/upload/': {
        const m = need(body, ['video_url']); if (m.length) return fail(40002, 'Missing required: video_url');
        if (!/^https:\/\//.test(body.video_url)) return fail(40002, 'video_url must be https');
        if (/bad-video/.test(body.video_url)) return fail(40002, 'Video format not supported (video not found or cannot be processed)');
        const video_id = 'v_' + id(); state.videos.set(video_id, { video_id, video_cover_url: 'https://mock.cdn/cover/' + video_id + '.jpg', duration: 18, width: 720, height: 1280, url: body.video_url }); return ok([{ video_id }]);
      }
      case '/file/video/ad/info/': return ok({ list: (query.video_ids || []).map((v) => state.videos.get(v)).filter(Boolean) });
      case '/file/image/ad/upload/': { if (!body.image_url) return fail(40002, 'Missing required: image_url'); const image_id = 'img_' + id(); state.images.set(image_id, body.image_url); return ok({ image_id }); }
      case '/campaign/create/': {
        const m = need(body, ['campaign_name', 'objective_type', 'budget_mode']); if (m.length) return fail(40002, `Missing required: ${m}`);
        if (body.budget_mode !== 'BUDGET_MODE_INFINITE' && !(Number(body.budget) > 0)) return fail(40002, 'budget is required for this budget_mode');
        const campaign_id = id(); state.campaigns.set(campaign_id, { campaign_id, ...body, operation_status: body.operation_status || 'ENABLE' }); return ok({ campaign_id });
      }
      case '/adgroup/create/': {
        const m = need(body, ['campaign_id', 'adgroup_name', 'billing_event', 'optimization_goal', 'schedule_type', 'schedule_start_time', 'location_ids']); if (m.length) return fail(40002, `Missing required: ${m}`);
        const camp = state.campaigns.get(String(body.campaign_id)); if (!camp) return fail(40002, 'campaign_id not found');
        if (camp.budget_mode === 'BUDGET_MODE_INFINITE' && !(Number(body.budget) > 0)) return fail(40002, 'budget is required on the ad group when the campaign has no budget');
        if (body.optimization_goal === 'CONVERT' && (!body.pixel_id || !body.optimization_event)) return fail(40002, 'pixel_id and optimization_event are required for CONVERT');
        if (body.bid_type === 'BID_TYPE_CUSTOM' && !(Number(body.bid_price) > 0 || Number(body.conversion_bid_price) > 0)) return fail(40002, 'bid price required for BID_TYPE_CUSTOM');
        const adgroup_id = id(); state.adgroups.set(adgroup_id, { adgroup_id, ...body, operation_status: body.operation_status || 'ENABLE' }); return ok({ adgroup_id });
      }
      case '/ad/create/': {
        const m = need(body, ['adgroup_id', 'creatives']); if (m.length || !Array.isArray(body.creatives) || !body.creatives.length) return fail(40002, 'Missing required: adgroup_id / creatives');
        if (!state.adgroups.get(String(body.adgroup_id))) return fail(40002, 'adgroup_id not found');
        const ad_ids = [];
        for (const cr of body.creatives) {
          const mm = need(cr, ['ad_name', 'ad_format', 'video_id', 'ad_text', 'identity_id', 'identity_type']); if (mm.length) return fail(40002, `Missing required in creative: ${mm}`);
          if (!state.videos.has(cr.video_id)) return fail(40002, 'video_id not found in the ad account library');
          if (String(cr.ad_text).length > 100) return fail(40002, 'ad_text too long');
          if (!state.identities.has(cr.identity_id)) return fail(40002, 'identity_id not found');
          const ad_id = id(); state.ads.set(ad_id, { ad_id, adgroup_id: body.adgroup_id, ...cr, operation_status: 'DISABLE' }); ad_ids.push(ad_id);
        }
        return ok({ ad_ids });
      }
      case '/campaign/status/update/': for (const c of body.campaign_ids || []) { const x = state.campaigns.get(String(c)); if (x) x.operation_status = body.operation_status; } return ok({});
      case '/adgroup/status/update/': for (const c of body.adgroup_ids || []) { const x = state.adgroups.get(String(c)); if (x) x.operation_status = body.operation_status; } return ok({});
      case '/ad/status/update/': for (const c of body.ad_ids || []) { const x = state.ads.get(String(c)); if (x) x.operation_status = body.operation_status; } return ok({});
      case '/campaign/get/': return ok({ list: [...state.campaigns.values()] });
      default: return fail(40002, `mock: unknown path ${path}`);
    }
  }
  const creates = () => state.log.filter((l) => l.method === 'POST' && /\/(campaign|adgroup|ad)\/create\/|\/identity\/create\/|\/file\/(video|image)\/ad\/upload\//.test(l.path));
  return { transport, state, advertiser: A, creates };
}
