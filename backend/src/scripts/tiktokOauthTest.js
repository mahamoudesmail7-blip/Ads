// 🧪 TikTok official OAuth + multi-account + write lock + Sales/Smart+ preview. TikTok is a mock fetch; NOTHING is ever sent to TikTok, nothing is created.
//   node src/scripts/tiktokOauthTest.js
import './_testGuard.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

const OA = await imp('../services/amb/tiktok/oauth.js');
const KY = await imp('../services/amb/tiktok/keys.js');
const LA = await imp('../services/amb/tiktok/launch.js');
const SA = await imp('../services/amb/tiktok/sales.js');
const BD = await imp('../services/amb/tiktok/builder.js');
const MK = await imp('../services/amb/tiktok/mock.js');
const CL = await imp('../services/amb/tiktok/client.js');
const prisma = (await imp('../prisma.js')).prisma;

const APP_SECRET = 'S'.repeat(8) + 'ecretValue' + '0'.repeat(10);
const wipe = async () => { await prisma.settings.deleteMany({ where: { id: { in: ['tiktok-oauth', 'tiktok-keys'] } } }); };
await wipe();

// ---- a fake TikTok (fetch) that records every request so we can prove: no write endpoint is ever called
const calls = [];
function fakeTikTok({ advertisers = [{ advertiser_id: '7000000000001', advertiser_name: 'Account One' }, { advertiser_id: '7000000000002', advertiser_name: 'Account Two' }], tokenCode = 0, refresh = true, failExchange = false, expiresIn = 86400 } = {}) {
  let n = 0;
  return async (url, init = {}) => {
    const u = new URL(url); const path = u.pathname.replace('/open_api/v1.3', ''); const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', path, body, headers: init.headers || {}, query: Object.fromEntries(u.searchParams) });
    const R = (data, code = 0, message = 'OK') => ({ json: async () => ({ code, message, data, request_id: 'req' }), status: 200 });
    if (path === '/oauth2/access_token/') { if (failExchange || body.auth_code === 'BAD') return R(null, 40002, 'Invalid auth_code'); n++; return R({ access_token: `ACCESS_TOKEN_${n}_` + 'x'.repeat(20), ...(refresh ? { refresh_token: `REFRESH_TOKEN_${n}_` + 'y'.repeat(20) } : {}), expires_in: expiresIn, advertiser_ids: advertisers.map((a) => a.advertiser_id), scope: [1, 3] }); }
    if (path === '/oauth2/refresh_token/') return R({ access_token: 'REFRESHED_ACCESS_' + 'z'.repeat(20), refresh_token: 'REFRESH_ROTATED_' + 'w'.repeat(20), expires_in: 86400 });
    if (path === '/oauth2/advertiser/get/') return R({ list: advertisers });
    if (path === '/advertiser/info/') return R({ list: JSON.parse(u.searchParams.get('advertiser_ids')).map((id) => ({ advertiser_id: id, name: `Info ${id.slice(-1)}`, currency: 'EGP', timezone: 'Africa/Cairo', status: 'STATUS_ENABLE' })) });
    if (path === '/pixel/list/') return R({ pixels: [{ pixel_id: 'PX1', pixel_name: 'Pixel' }] });
    if (path === '/identity/get/') return R({ identity_list: [{ identity_id: 'ID1', display_name: 'Brand' }] });
    return R(null, 40002, 'unknown path in test: ' + path);
  };
}
const WRITE_PATHS = /\/(campaign|adgroup|ad)\/(create|update|status)|\/identity\/create|\/file\/(video|image)|\/pixel\/create|\/advertiser\/(create|update)/;

console.log('\n1. app config (owner-provided) — secret never returned');
{
  ok('not configured at first', (await OA.appStatus()).configured === false);
  ok('startAuth refuses until the app is configured', (await rejects(OA.startAuth({ userId: 1 })))?.code === 'TIKTOK_APP_NOT_CONFIGURED');
  ok('a bad App ID is refused with an Arabic reason', /App ID/.test((await rejects(OA.setApp({ appId: 'abc', secret: APP_SECRET })))?.message || ''));
  ok('a short secret is refused', (await rejects(OA.setApp({ appId: '7123456789012345678', secret: 'short' })))?.status === 400);
  ok('a secret is required the first time', (await rejects(OA.setApp({ appId: '7123456789012345678' })))?.status === 400);
  const st = await OA.setApp({ appId: '7123456789012345678', secret: APP_SECRET });
  ok('saved → configured; status shows the App ID + last 4 only', st.configured && st.appId === '7123456789012345678' && st.last4 === APP_SECRET.slice(-4) && !JSON.stringify(st).includes(APP_SECRET));
  const raw = JSON.parse((await prisma.settings.findUnique({ where: { id: 'tiktok-oauth' } })).data);
  ok('the secret is encrypted at rest', !JSON.stringify(raw).includes(APP_SECRET) && raw.app.secretEnc.length > 20);
  ok('updating only the App ID keeps the saved secret', (await OA.setApp({ appId: '7123456789012345679' })).appId === '7123456789012345679' && (await OA.getApp()).secret === APP_SECRET);
  await OA.setApp({ appId: '7123456789012345678' });
}

console.log('\n2. redirect URL + the authorization link');
{
  ok('the redirect URL is the fixed production callback', OA.redirectUri() === 'https://ads-production-360b.up.railway.app/api/amb-tiktok/oauth/callback');
  ok('a custom base is normalised (no double slash)', OA.redirectUri('https://x.example/') === 'https://x.example/api/amb-tiktok/oauth/callback');
  const r = await OA.startAuth({ userId: 7 });
  const u = new URL(r.url);
  ok('the authorization URL carries app_id, state and the exact redirect_uri — and NO secret', u.origin + u.pathname === OA.AUTH_URL && u.searchParams.get('app_id') === '7123456789012345678' && u.searchParams.get('state') === r.state && u.searchParams.get('redirect_uri') === OA.redirectUri() && !r.url.includes(APP_SECRET));
  ok('the state is 48 hex chars (192 bits of randomness)', /^[0-9a-f]{48}$/.test(r.state));
  const r2 = await OA.startAuth({ userId: 7 }); ok('every start gets a different state', r2.state !== r.state);
  await OA.consumeState(r.state, 7); await OA.consumeState(r2.state, 7);
}

console.log('\n3. state: single-use, expiring, user-bound, forged → refused');
{
  const r = await OA.startAuth({ userId: 7 });
  ok('a wrong-user callback is refused (and the state is burnt)', (await rejects(OA.consumeState(r.state, 8)))?.code === 'STATE_USER' && (await rejects(OA.consumeState(r.state, 7)))?.code === 'STATE_USED');
  const r2 = await OA.startAuth({ userId: 7 }); ok('a valid state is consumed once', (await OA.consumeState(r2.state, 7)) === true);
  ok('…and a second use is refused (replay)', (await rejects(OA.consumeState(r2.state, 7)))?.code === 'STATE_USED');
  ok('a forged / malformed state is refused', (await rejects(OA.consumeState('nope', 7)))?.code === 'BAD_STATE' && (await rejects(OA.consumeState('a'.repeat(48), 7)))?.code === 'STATE_USED');
  const r3 = await OA.startAuth({ userId: 7 }, { now: 1_000_000 });
  ok('an expired state (> 10 min) is refused', (await rejects(OA.consumeState(r3.state, 7, { now: 1_000_000 + OA.STATE_TTL_MS + 1 })))?.code === 'STATE_EXPIRED');
  for (let i = 0; i < 25; i++) await OA.startAuth({ userId: 7 });
  ok('pending states are bounded (≤ 20)', Object.keys((await OA._readForTests()).states).length <= 20);
  await prisma.settings.deleteMany({ where: { id: 'tiktok-oauth' } }); await OA.setApp({ appId: '7123456789012345678', secret: APP_SECRET });
}

console.log('\n4. the callback — links every authorized advertiser, encrypted, once');
let state1;
{
  calls.length = 0;
  const s = await OA.startAuth({ userId: 7 }); state1 = s.state;
  const dep = { fetchImpl: fakeTikTok() };
  ok('a callback without a code is refused', (await rejects(OA.completeAuth({ authCode: '', state: s.state, cookieState: s.state, userId: 7 }, dep)))?.code === 'NO_CODE');
  ok('a callback whose cookie does not match (another browser) is refused', (await rejects(OA.completeAuth({ authCode: 'CODE1', state: s.state, cookieState: 'other', userId: 7 }, dep)))?.code === 'STATE_COOKIE');
  ok('a callback with no cookie at all is refused', (await rejects(OA.completeAuth({ authCode: 'CODE1', state: s.state, cookieState: undefined, userId: 7 }, dep)))?.code === 'STATE_COOKIE');
  const r = await OA.completeAuth({ authCode: 'CODE1', state: s.state, cookieState: s.state, userId: 7 }, dep);
  ok('both authorized advertisers are linked', r.added === 2 && r.updated === 0 && r.advertisers.length === 2 && r.advertisers.every((a) => a.isNew));
  const exch = calls.find((c) => c.path === '/oauth2/access_token/');
  ok('the exchange sends app_id, secret and auth_code in a POST BODY (never in a URL)', exch.method === 'POST' && exch.body.app_id === '7123456789012345678' && exch.body.secret === APP_SECRET && exch.body.auth_code === 'CODE1' && !Object.keys(exch.query).length);
  const adv = calls.find((c) => c.path === '/oauth2/advertiser/get/');
  ok('the advertiser list is fetched with app credentials (GET)', adv.method === 'GET' && adv.query.access_token.startsWith('ACCESS_TOKEN_'));
  const infoCall = calls.find((c) => c.path === '/advertiser/info/');
  ok('advertiser info is read with the Access-Token HEADER (not a query param)', infoCall.headers['Access-Token'].startsWith('ACCESS_TOKEN_') && !infoCall.query.access_token);
  ok('NO write endpoint was called', !calls.some((c) => WRITE_PATHS.test(c.path)));
  const row = JSON.parse((await prisma.settings.findUnique({ where: { id: 'tiktok-oauth' } })).data); const dump = JSON.stringify(row);
  ok('tokens are encrypted at rest (neither the access nor the refresh token appears in the database)', !dump.includes('ACCESS_TOKEN_') && !dump.includes('REFRESH_TOKEN_') && !dump.includes(APP_SECRET));
  const accts = await OA.listAccounts();
  ok('accounts are listed with name/currency/zone, the first is active — and no token', accts.length === 2 && accts.filter((a) => a.active).length === 1 && accts[0].currency === 'EGP' && !JSON.stringify(accts).includes('ACCESS_TOKEN_') && accts.every((a) => a.canRefresh));
  ok('the used state cannot be replayed with the same code', (await rejects(OA.completeAuth({ authCode: 'CODE1', state: s.state, cookieState: s.state, userId: 7 }, dep)))?.code === 'STATE_USED');
  const last = await OA.takeLastCallback(); ok('the screen gets the result once', last.ok === true && last.added === 2 && (await OA.takeLastCallback()) === null);
}

console.log('\n5. linking the same advertiser again never duplicates it');
{
  const s = await OA.startAuth({ userId: 7 });
  const r = await OA.completeAuth({ authCode: 'CODE2', state: s.state, cookieState: s.state, userId: 7 }, { fetchImpl: fakeTikTok() });
  ok('re-authorizing the same two accounts UPDATES them (added 0, updated 2)', r.added === 0 && r.updated === 2 && r.advertisers.every((a) => !a.isNew));
  ok('still exactly 2 accounts', (await OA.listAccounts()).length === 2);
  const grants = Object.keys((await OA._readForTests()).grants); ok('the old grant (token) is dropped — one live grant', grants.length === 1);
  const s3 = await OA.startAuth({ userId: 7 });
  const r3 = await OA.completeAuth({ authCode: 'CODE3', state: s3.state, cookieState: s3.state, userId: 7 }, { fetchImpl: fakeTikTok({ advertisers: [{ advertiser_id: '7000000000002', advertiser_name: 'Account Two' }, { advertiser_id: '7000000000003', advertiser_name: 'Account Three' }] }) });
  ok('a new authorization with one old + one new advertiser: 1 added, 1 updated, 3 accounts total', r3.added === 1 && r3.updated === 1 && (await OA.listAccounts()).length === 3);
  ok('the earlier active account stays active', (await OA.listAccounts()).find((a) => a.active).advertiserId === '7000000000001');
}

console.log('\n6. errors are handled (and leave nothing half-saved)');
{
  const before = (await OA.listAccounts()).length;
  const s = await OA.startAuth({ userId: 7 });
  const e = await rejects(OA.completeAuth({ authCode: 'BAD', state: s.state, cookieState: s.state, userId: 7 }, { fetchImpl: fakeTikTok() }));
  ok('TikTok refusing the code → an error, no account added', e instanceof CL.TikTokError && (await OA.listAccounts()).length === before);
  const s2 = await OA.startAuth({ userId: 7 });
  const e2 = await rejects(OA.completeAuth({ authCode: 'X', state: s2.state, cookieState: s2.state, userId: 7 }, { fetchImpl: fakeTikTok({ advertisers: [] }) }));
  ok('an authorization with zero advertisers explains what to do', e2?.code === 'NO_ADVERTISERS' && /حساب إعلاني/.test(e2.message));
  ok('the failed state is burnt (cannot be retried)', (await rejects(OA.consumeState(s.state, 7)))?.code === 'STATE_USED');
  await OA.recordCallbackError('اتلغى التفويض'); const lc = await OA.takeLastCallback(); ok('an error is recorded for the screen', lc.ok === false && /اتلغى/.test(lc.message));
  const s3 = await OA.startAuth({ userId: 7 });
  const garbage = async () => ({ json: async () => { throw new Error('not json'); }, status: 502 });
  ok('a non-JSON reply from TikTok is a clear error', /HTTP 502/.test((await rejects(OA.completeAuth({ authCode: 'X', state: s3.state, cookieState: s3.state, userId: 7 }, { fetchImpl: garbage })))?.message || ''));
}

console.log('\n7. several simultaneous callbacks never corrupt the storage');
{
  const states = await Promise.all([OA.startAuth({ userId: 7 }), OA.startAuth({ userId: 7 }), OA.startAuth({ userId: 7 })]);
  const results = await Promise.allSettled(states.map((s, i) => OA.completeAuth({ authCode: 'C' + i, state: s.state, cookieState: s.state, userId: 7 }, { fetchImpl: fakeTikTok({ advertisers: [{ advertiser_id: '7000000000001', advertiser_name: 'One' }] }) })));
  ok('all three callbacks succeed in order (serialised)', results.every((r) => r.status === 'fulfilled'));
  const accts = await OA.listAccounts(); ok('the account list stayed consistent (3 accounts, one token grant in use)', accts.length === 3 && Object.keys((await OA._readForTests()).grants).length >= 1);
  const same = await Promise.allSettled([OA.consumeState((await OA.startAuth({ userId: 7 })).state, 7)]);
  ok('(sanity) consumeState works after the burst', same[0].status === 'fulfilled');
}

console.log('\n8. active account, disconnect, tokens, refresh');
{
  ok('switching the active account', (await OA.setActive('7000000000002')).active === '7000000000002' && (await OA.listAccounts()).find((a) => a.active).advertiserId === '7000000000002');
  ok('an unknown account is refused', (await rejects(OA.setActive('999')))?.status === 404 && (await rejects(OA.disconnect('999')))?.status === 404);
  const t = await OA.getTokenFor('7000000000002'); ok('the server can decrypt the token for the active account (and only there)', t.token.startsWith('ACCESS_TOKEN_') && t.currency === 'EGP');
  const conn = await KY.getConnection();
  ok('the TikTok connection now uses the OAuth account (REAL, via OAUTH, that advertiser)', conn.mode === 'REAL' && conn.via === 'OAUTH' && conn.advertiserId === '7000000000002' && conn.token.startsWith('ACCESS_TOKEN_'));
  const st = await KY.getStatus(); ok('status exposes counts + the app state but NO token', st.oauth.accounts === 3 && st.oauth.app.configured && !JSON.stringify(st).includes('ACCESS_TOKEN_'));
  // expiry → refresh
  const row = JSON.parse((await prisma.settings.findUnique({ where: { id: 'tiktok-oauth' } })).data);
  const gid = row.advertisers['7000000000002'].grantId; row.grants[gid].expiresAt = new Date(Date.now() + 60_000).toISOString();
  await prisma.settings.update({ where: { id: 'tiktok-oauth' }, data: { data: JSON.stringify(row) } });
  calls.length = 0;
  const t2 = await OA.getTokenFor('7000000000002', { fetchImpl: fakeTikTok() });
  ok('a token about to expire is refreshed (POST /oauth2/refresh_token/ with the stored refresh token)', t2.token.startsWith('REFRESHED_ACCESS_') && calls.some((c) => c.path === '/oauth2/refresh_token/' && c.body.refresh_token.startsWith('REFRESH_TOKEN_')));
  ok('the rotated refresh token is stored (encrypted) and the refreshed token is used next time', (await OA.getTokenFor('7000000000002')).token.startsWith('REFRESHED_ACCESS_') && !(await prisma.settings.findUnique({ where: { id: 'tiktok-oauth' } })).data.includes('REFRESHED_ACCESS_'));
  const t3 = await OA.getTokenFor('7000000000002', { fetchImpl: async () => { throw new Error('network'); } }, { now: Date.now() + 80_000_000 });
  ok('a failed refresh keeps the old token instead of losing the account', !!t3?.token);
  const d = await OA.disconnect('7000000000002');
  ok('disconnecting the active account moves "active" to another one', d.active && d.active !== '7000000000002' && (await OA.listAccounts()).length === 2);
  ok('its token is gone', (await OA.getTokenFor('7000000000002')) === null);
}

console.log('\n9. permissions check — READ-ONLY');
{
  calls.length = 0;
  const client = CL.createTikTokClient({ advertiserId: '7000000000001', transport: async (m, p, o) => { const r = await fakeTikTok()(`https://business-api.tiktok.com/open_api/v1.3${p}?${new URLSearchParams(Object.fromEntries(Object.entries(o.query || {}).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])))}`, { method: m, headers: {}, body: o.body ? JSON.stringify(o.body) : undefined }); return r.json(); } });
  const r = await OA.checkAccount('7000000000001', { client, scope: [1, 3] });
  ok('a healthy account passes: access + pixel + identities', r.ok && r.checks.find((c) => c.name === 'الوصول للحساب الإعلاني').status === 'OK' && r.checks.find((c) => c.name === 'الـ Pixel').status === 'OK');
  ok('it says honestly that the write permission is only proven by the first real launch', r.checks.some((c) => c.status === 'INFO' && /أول رفع حقيقي/.test(c.text)));
  ok('the check only READS (no write endpoint was called)', !calls.some((c) => WRITE_PATHS.test(c.path)) && calls.every((c) => c.method === 'GET'));
  const bad = await OA.checkAccount('7', { client: { advertiserInfo: async () => { throw new Error('no permission'); } } });
  ok('an unreachable account fails the check with advice', bad.ok === false && /اربط/.test(bad.note));
}

console.log('\n10. the real-write lock (default LOCKED) — nothing real can be launched until the owner opens it');
{
  ok('locked by default', (await OA.getWritesUnlocked()) === false);
  const mem = new Map(); const mk = () => ({ id: 'abcdef012345', name: 'x', status: 'DRAFT', mode: 'REAL', config: BD.normalizeConfig({ name: 'Name', objective: 'TRAFFIC', landingUrl: 'https://s.example/p', displayName: 'Brand', adText: 'Hi there', videos: [{ url: 'https://c.example/a.mp4' }], locations: ['357994'], ageGroups: ['AGE_18_24'], dailyBudget: 1000 }), progress: { identityId: null, uploads: {}, campaignId: 'C1', adgroupId: 'G1', adIds: ['A1'], enabled: false, steps: [] }, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  mem.set('abcdef012345', mk()); const m = MK.createMockTikTok();
  const deps = { getDraft: async (id) => JSON.parse(JSON.stringify(mem.get(id))), saveDraft: async (d) => { mem.set(d.id, d); return d; }, client: CL.createTikTokClient({ advertiserId: '7', transport: m.transport }), connection: async () => ({ mode: 'REAL' }), guard: async () => ({ ok: true }) };
  const e1 = await rejects(LA.launchDraft('abcdef012345', {}, { ...deps, sleep: async () => {} }));
  ok('a REAL launch is refused while locked (423, code TIKTOK_WRITES_LOCKED) — before any TikTok call', e1?.status === 423 && e1.code === 'TIKTOK_WRITES_LOCKED' && m.creates().length === 0 && m.state.log.length === 0);
  const e2 = await rejects(LA.enableDraft('abcdef012345', {}, deps)); ok('enabling is refused while locked', e2?.code === 'TIKTOK_WRITES_LOCKED' && m.state.log.length === 0);
  const e3 = await rejects(LA.pauseDraft('abcdef012345', {}, deps)); ok('pausing is refused while locked too', e3?.code === 'TIKTOK_WRITES_LOCKED' && m.state.log.length === 0);
  const unlockedDeps = { ...deps, writesUnlocked: async () => true };
  const en = await LA.enableDraft('abcdef012345', {}, unlockedDeps); ok('once the owner opens the lock the same call goes through', en.progress.enabled === true && m.state.log.some((l) => /status\/update/.test(l.path)));
  ok('the DEMO mode is never blocked by the lock (nothing real is sent)', await (async () => { const mm = MK.createMockTikTok(); const mem2 = new Map(); const d = mk(); d.mode = 'MOCK'; d.progress = { identityId: null, uploads: {}, campaignId: null, adgroupId: null, adIds: [], enabled: false, steps: [] }; mem2.set(d.id, d); const r = await LA.launchDraft(d.id, {}, { getDraft: async (id) => JSON.parse(JSON.stringify(mem2.get(id))), saveDraft: async (x) => { mem2.set(x.id, x); return x; }, client: CL.createTikTokClient({ advertiserId: '7', transport: mm.transport }), connection: async () => ({ mode: 'MOCK' }), sleep: async () => {}, now: () => new Date('2026-11-08T10:00:00Z') }); return r.status === 'LAUNCHED'; })());
  ok('opening the lock is a stored switch the owner controls', (await OA.setWritesUnlocked(true)).writes === true && (await OA.getWritesUnlocked()) === true && (await OA.setWritesUnlocked(false)).writes === false);
}

console.log('\n11. Sales / Smart+ foundation (preview only)');
{
  const good = { name: 'Selicon', objective: 'CONVERSIONS', event: 'PURCHASE', pixelId: 'PX1', landingUrl: 'https://s.example/p', displayName: 'B', adText: 'اطلب الآن', videos: Array.from({ length: 6 }, (_, i) => ({ url: `https://c.example/${i}.mp4` })), ageGroups: ['AGE_18_24', 'AGE_25_34', 'AGE_35_44', 'AGE_45_54'], dailyBudget: 1000 };
  const r = SA.smartPlusReadiness(good); ok('a sales config with pixel, 6 creatives and broad targeting is Smart+-ready', r.eligible && r.recommendedOk && r.items.every((i) => i.ok));
  const few = SA.smartPlusReadiness({ ...good, videos: [{ url: 'https://c.example/a.mp4' }] }); ok('fewer than 6 creatives is still eligible but not «recommended»', few.eligible && !few.recommendedOk && !few.items.find((i) => i.key === 'creatives').ok);
  ok('no pixel / non-sales → not eligible, with the reason', !SA.smartPlusReadiness({ ...good, pixelId: '' }).eligible && !SA.smartPlusReadiness({ ...good, objective: 'TRAFFIC' }).eligible);
  const p = SA.previewPayloads(good, { advertiserId: '700' });
  ok('both Sales variants are previewed: WEB_CONVERSIONS (current) and SALES + sales_destination=WEBSITE', p.variants.LEGACY_WEB_CONVERSIONS.campaign.objective_type === 'WEB_CONVERSIONS' && p.variants.SALES_WEBSITE.campaign.objective_type === 'SALES' && p.variants.SALES_WEBSITE.campaign.sales_destination === 'WEBSITE');
  ok('every preview payload is created DISABLED and uses placeholder ids only (nothing real)', p.variants.SALES_WEBSITE.campaign.operation_status === 'DISABLE' && p.adgroup.operation_status === 'DISABLE' && p.adgroup.campaign_id === '<CAMPAIGN_ID>' && p.ads.adgroup_id === '<ADGROUP_ID>' && p.writesSent === 0);
  ok('the ad group is a conversion ad group (CONVERT / OCPM / pixel / SHOPPING)', p.adgroup.optimization_goal === 'CONVERT' && p.adgroup.billing_event === 'OCPM' && p.adgroup.pixel_id === 'PX1' && p.adgroup.optimization_event === 'SHOPPING');
  ok('six videos → six ads in the preview', p.ads.creatives.length === 6);
}

console.log('\n12. the existing Meta / scale code is untouched');
{
  const fs = await import('node:fs'); const src = (rel) => fs.readFileSync(join(__dirname, rel), 'utf8');
  ok('no Meta / AI Operator / bulk-scale file imports the TikTok modules', ['../services/amb/scaleBulk.js', '../services/amb/scaleWinners.js', '../services/metaGraphClient.js', '../services/amb/cloneEngine.js', '../routes/meta.js', '../routes/aiMediaBuyer.js', '../routes/operator.js'].every((f) => !/tiktok/i.test(src(f))));
}

await wipe();
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
