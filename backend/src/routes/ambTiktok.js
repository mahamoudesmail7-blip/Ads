// AMB — TikTok campaigns. Mounted at /api/amb-tiktok. ADMIN only (it spends money). The launch runs in the background and the screen polls the draft.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import * as SP from '../services/amb/tiktok/spec.js';
import * as BD from '../services/amb/tiktok/builder.js';
import * as KY from '../services/amb/tiktok/keys.js';
import * as DR from '../services/amb/tiktok/drafts.js';
import * as LA from '../services/amb/tiktok/launch.js';
import { explainTikTokError } from '../services/amb/tiktok/client.js';
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
  res.json({ ok: v.ok, errors: v.errors, warnings: v.warnings, summary: BD.summarize(v.config, ctx), account: snap?.info || null });
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
