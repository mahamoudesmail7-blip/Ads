// AMB — TikTok campaigns. Mounted at /api/amb-tiktok. ADMIN only (it spends money). The launch runs in the background and the screen polls the draft.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import * as SP from '../services/amb/tiktok/spec.js';
import * as BD from '../services/amb/tiktok/builder.js';
import * as KY from '../services/amb/tiktok/keys.js';
import * as DR from '../services/amb/tiktok/drafts.js';
import * as LA from '../services/amb/tiktok/launch.js';
import * as OA from '../services/amb/tiktok/oauth.js';
import * as SA from '../services/amb/tiktok/sales.js';
import { explainTikTokError, createTikTokClient, httpTransport } from '../services/amb/tiktok/client.js';
import { logger } from '../logger.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN'));

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const did = (req) => { if (!DR.validDraftId(req.params.id)) throw bad('معرّف الكامبين غير صالح.'); return req.params.id; };

// account snapshot (advertiser + pixels + identities) cached for a minute so the wizard does not hammer TikTok
let acctCache = { at: 0, mode: null, data: null };
async function accountSnapshot({ force = false } = {}) {
  const c = await KY.getConnection();
  if (c.mode === 'NONE') return null;
  if (!force && acctCache.data && acctCache.mode === c.mode && Date.now() - acctCache.at < 60_000) return acctCache.data;
  const { client, mode } = await KY.getClient();
  const [info, pixels, identities] = await Promise.all([client.advertiserInfo(), client.pixels().catch(() => []), client.identities().catch(() => [])]);
  acctCache = { at: Date.now(), mode, data: { mode, info, pixels, identities } };
  return acctCache.data;
}
const ctxOf = (snap) => ({ timeZone: snap?.info?.timezone || 'Africa/Cairo', currency: snap?.info?.currency || '', now: new Date() });

export const publicOptions = () => ({
  objectives: Object.entries(SP.OBJECTIVES).map(([id, o]) => ({ id, label: o.label, emoji: o.emoji, hint: o.hint, recommended: !!o.recommended, needsPixel: o.needsPixel, needsLanding: o.needsLanding, bid: o.bidKind, unsupported: o.needsExtra || null })),
  events: Object.entries(SP.EVENTS).map(([id, e]) => ({ id, label: e.label, recommended: !!e.recommended })),
  bidStrategies: Object.entries(SP.BID_STRATEGIES).map(([id, b]) => ({ id, ...b })),
  ctas: Object.entries(SP.CTAS).map(([id, label]) => ({ id, label })),
  ageGroups: Object.entries(SP.AGE_GROUPS).map(([id, label]) => ({ id, label })),
  genders: Object.entries(SP.GENDERS).map(([id, label]) => ({ id, label })),
  languages: Object.entries(SP.LANGUAGES).map(([id, label]) => ({ id, label })),
  operatingSystems: Object.entries(SP.OPERATING_SYSTEMS).map(([id, label]) => ({ id, label })),
  locations: Object.entries(SP.LOCATIONS).map(([id, l]) => ({ id, label: l.label })),
  placements: Object.entries(SP.PLACEMENTS).map(([id, p]) => ({ id, ...p })),
  budgetLevels: Object.entries(SP.BUDGET_LEVELS).map(([id, b]) => ({ id, ...b })),
  runModes: Object.entries(SP.RUN_MODES).map(([id, r]) => ({ id, ...r })),
  presets: Object.entries(SP.PRESETS).map(([id, p]) => ({ id, label: p.label, description: p.description, config: p.config })),
  limits: SP.LIMITS, defaults: SP.defaultConfig(),
});

router.get('/options', asyncRoute(async (_req, res) => res.json(publicOptions())));

// ---- official OAuth (advertiser authorization) — multi-account. Read-only toward TikTok: it never creates or changes anything on TikTok.
const STATE_COOKIE = 'tiktok_oauth_state';
const IS_PROD = process.env.NODE_ENV === 'production';
const FRONT = () => `${process.env.FRONTEND_URL || ''}/app.html#/ai-media-buyer.html#tiktok`;
const advId = (req) => { if (!/^d{6,25}$/.test(String(req.params.id || ''))) throw bad('رقم الحساب الإعلاني غير صالح.'); return req.params.id; };

/** Everything the screen needs about the OAuth setup: the Redirect URL to paste into TikTok Developers, the app status (never the secret), the linked accounts, the write lock. */
router.get('/oauth/info', asyncRoute(async (_req, res) => res.json({
  redirectUri: OA.redirectUri(), authorizeHost: new URL(OA.AUTH_URL).host, app: await OA.appStatus(), accounts: await OA.listAccounts(), writesUnlocked: await OA.getWritesUnlocked(),
})));
router.put('/oauth/app', asyncRoute(async (req, res) => res.json(await OA.setApp({ appId: req.body?.appId, secret: req.body?.secret }))));
router.delete('/oauth/app', asyncRoute(async (_req, res) => res.json(await OA.clearApp())));
/** Step 1: the owner clicks «ربط». We create the single-use state (server record + httpOnly cookie) and hand back TikTok's authorization URL. */
router.post('/oauth/start', asyncRoute(async (req, res) => {
  const r = await OA.startAuth({ userId: req.user.id });
  res.cookie(STATE_COOKIE, r.state, { httpOnly: true, secure: IS_PROD, sameSite: 'lax', maxAge: OA.STATE_TTL_MS });
  res.json({ url: r.url, expiresInSec: r.expiresInSec });
}));
/** Step 2: TikTok sends the browser back here. ALWAYS ends in a redirect to the screen (success or error) — never a bare JSON error in the browser. */
router.get('/oauth/callback', asyncRoute(async (req, res) => {
  const authCode = String(req.query.auth_code || req.query.code || ''); const state = String(req.query.state || '');
  const cookieState = req.cookies?.[STATE_COOKIE]; res.clearCookie(STATE_COOKIE);
  const fail = async (message) => { await OA.recordCallbackError(message).catch(() => {}); return res.redirect(FRONT()); };
  if (req.query.error) return fail(String(req.query.error_description || req.query.error));
  try {
    const r = await OA.completeAuth({ authCode, state, cookieState, userId: req.user.id });
    logger.info('TikTok OAuth linked', { added: r.added, updated: r.updated }); // counts only — no ids, no tokens
    return res.redirect(FRONT());
  } catch (e) {
    logger.warn('TikTok OAuth callback failed', { code: e.code || null, message: String(e.message).slice(0, 160) });
    return fail(explainTikTokError(e).title === 'تيك توك رجّعت خطأ' ? e.message : `${explainTikTokError(e).title} — ${explainTikTokError(e).action}`);
  }
}));
router.get('/oauth/last', asyncRoute(async (_req, res) => res.json({ last: await OA.takeLastCallback() })));
router.get('/oauth/accounts', asyncRoute(async (_req, res) => res.json({ accounts: await OA.listAccounts() })));
router.post('/oauth/accounts/:id/activate', asyncRoute(async (req, res) => { acctCache = { at: 0, mode: null, data: null }; res.json(await OA.setActive(advId(req))); }));
router.delete('/oauth/accounts/:id', asyncRoute(async (req, res) => { acctCache = { at: 0, mode: null, data: null }; res.json(await OA.disconnect(advId(req))); }));
/** Permission check for one linked account — READ-ONLY (advertiser info, pixels, identities). */
router.get('/oauth/accounts/:id/check', asyncRoute(async (req, res) => {
  const id = advId(req); const t = await OA.getTokenFor(id); if (!t) throw bad('الحساب ده مش مربوط.', 404);
  const acc = (await OA.listAccounts()).find((a) => a.advertiserId === id);
  const client = createTikTokClient({ advertiserId: id, transport: httpTransport({ token: t.token }) });
  res.json(await OA.checkAccount(id, { client, scope: acc?.scope || [] }));
}));
/** The real-write lock (default LOCKED). Opening it needs an explicit confirmation. */
router.put('/oauth/writes', asyncRoute(async (req, res) => {
  if (req.body?.on === true && req.body?.confirm !== true) throw bad('فتح الرفع الحقيقي لازم تأكيد صريح.');
  res.json(await OA.setWritesUnlocked(req.body?.on === true));
}));

// ---- connection
router.get('/status', asyncRoute(async (_req, res) => res.json(await KY.getStatus())));
router.post('/connect', asyncRoute(async (req, res) => {
  const { token, advertiserId } = req.body || {};
  const status = await KY.saveCredentials({ token, advertiserId });
  acctCache = { at: 0, mode: null, data: null };
  try { const snap = await accountSnapshot({ force: true }); res.json({ status, account: snap.info, pixels: snap.pixels.length }); }
  catch (e) { res.status(200).json({ status, error: { message: e.message, ...explainTikTokError(e) } }); } // saved, but TikTok did not accept it: say why
}));
router.post('/connect/mock', asyncRoute(async (req, res) => { acctCache = { at: 0, mode: null, data: null }; res.json(await KY.setMock(!!req.body?.on)); }));
router.delete('/connect', asyncRoute(async (_req, res) => { acctCache = { at: 0, mode: null, data: null }; res.json(await KY.clearCredentials()); }));
router.get('/account', asyncRoute(async (req, res) => {
  try { const snap = await accountSnapshot({ force: req.query.refresh === '1' }); res.json(snap ? { connected: true, ...snap } : { connected: false }); }
  catch (e) { res.json({ connected: false, error: { message: e.message, ...explainTikTokError(e) } }); }
}));
router.get('/interests', asyncRoute(async (_req, res) => { const { client } = await KY.getClient(); res.json({ interests: await client.interests() }); }));

// ---- drafts
router.get('/drafts', asyncRoute(async (_req, res) => res.json({ drafts: await DR.listDrafts() })));
router.post('/drafts', asyncRoute(async (req, res) => {
  const conn = await KY.getConnection(); if (conn.mode === 'NONE') throw bad('اربط حساب تيك توك الأول (أو جرّب الوضع التجريبي).', 409);
  const { preset, config } = req.body || {};
  if (preset && !SP.PRESETS[preset]) throw bad('القالب غير معروف.');
  res.status(201).json(await DR.createDraft({ preset, config, userId: req.user.id, mode: conn.mode }));
}));
router.get('/drafts/:id', asyncRoute(async (req, res) => {
  const d = await DR.getDraft(did(req)); if (!d) return res.status(404).json({ error: 'NOT_FOUND', message: 'الكامبين مش موجود.' });
  res.json({ ...d, running: LA.isRunning(d.id), stepLabels: LA.STEP_LABELS });
}));
router.put('/drafts/:id', asyncRoute(async (req, res) => res.json(await DR.updateDraftConfig(did(req), req.body?.config || {}))));
router.delete('/drafts/:id', asyncRoute(async (req, res) => res.json(await DR.deleteDraft(did(req)))));
router.post('/drafts/:id/duplicate', asyncRoute(async (req, res) => res.status(201).json(await DR.duplicateDraft(did(req), req.user.id))));
router.post('/drafts/:id/validate', asyncRoute(async (req, res) => {
  const d = await DR.getDraft(did(req)); if (!d) throw bad('الكامبين مش موجود.', 404);
  const cfg = req.body?.config ? { ...d.config, ...req.body.config } : d.config;
  let snap = null; try { snap = await accountSnapshot(); } catch { /* validate with defaults when TikTok is unreachable */ }
  const ctx = ctxOf(snap); const v = BD.validateConfig(cfg, ctx);
  res.json({ ok: v.ok, errors: v.errors, warnings: v.warnings, summary: BD.summarize(v.config, ctx), account: snap?.info || null, smartPlus: SA.smartPlusReadiness(v.config) });
}));

/** The exact request bodies a launch WOULD send (placeholder ids) — a preview, nothing is sent to TikTok. */
router.get('/drafts/:id/preview', asyncRoute(async (req, res) => {
  const d = await DR.getDraft(did(req)); if (!d) throw bad('الكامبين مش موجود.', 404);
  let snap = null; try { snap = await accountSnapshot(); } catch { /* preview with defaults */ }
  res.json({ ...SA.previewPayloads(d.config, { timeZone: snap?.info?.timezone || 'Africa/Cairo' }), smartPlus: SA.smartPlusReadiness(d.config) });
}));

// ---- launch (background) / enable / pause
router.post('/drafts/:id/launch', asyncRoute(async (req, res) => {
  const id = did(req);
  if (req.body?.confirm !== true) throw bad('لازم تأكيد صريح على الرفع.');
  const d = await DR.getDraft(id); if (!d) throw bad('الكامبين مش موجود.', 404);
  if (LA.isRunning(id)) throw bad('الكامبين بيتم رفعه دلوقتي.', 409);
  const enable = req.body?.enable === true;
  // fail fast (connection / mode / guard / validation) so the screen shows the reason immediately instead of a silent background failure
  const conn = await KY.getConnection();
  if (conn.mode === 'NONE') throw bad('حساب تيك توك مش مربوط.', 409);
  if (d.mode !== conn.mode) throw bad(d.mode === 'MOCK' ? 'الكامبين ده اتعمل في الوضع التجريبي ومينفعش يتبعت لتيك توك الحقيقي. اعمل كامبين جديد.' : 'الربط الحالي تجريبي — الكامبين ده للحساب الحقيقي.', 409);
  const v = BD.validateConfig(d.config, ctxOf(await accountSnapshot().catch(() => null)));
  if (!v.ok) { const e = bad(v.errors.map((x) => x.message).join(' — ')); e.validation = v.errors; throw e; }
  LA.launchDraft(id, { userId: req.user.id, enable }).catch((e) => logger.warn('TikTok launch failed', { draft: id, message: e.message }));
  res.status(202).json({ started: true, id });
}));
router.post('/drafts/:id/enable', asyncRoute(async (req, res) => {
  if (req.body?.confirm !== true) throw bad('لازم تأكيد صريح على التشغيل.');
  res.json(await LA.enableDraft(did(req), { userId: req.user.id }));
}));
router.post('/drafts/:id/pause', asyncRoute(async (req, res) => res.json(await LA.pauseDraft(did(req), { userId: req.user.id }))));

export default router;
