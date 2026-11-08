// TikTok launch orchestration: validate → identity → upload videos (+ covers) → campaign → ad group → ads → (optionally) enable.
// Rules that keep it safe:
//   · everything is created DISABLED; turning it on is a separate, explicit step (confirm=true);
//   · after EVERY remote create the id is saved on the draft, so a failure at any step is RESUMED from that step — nothing already created is created again;
//   · a create that died on the network (unknown outcome) is checked against TikTok by name before it is retried, so a timeout can not double-create the campaign;
//   · a draft is launched by one process at a time (in-memory lock + LAUNCHING status);
//   · the global write guard (Emergency Stop) applies to real launches.
import { validateConfig, buildCampaignPayload, buildAdGroupPayload, buildAdPayload } from './builder.js';
import { explainTikTokError, TikTokError } from './client.js';
import { getDraft, saveDraftRow } from './drafts.js';
import { getClient, getConnection } from './keys.js';
import { getWritesUnlocked } from './oauth.js';

const running = new Set();
const STEPS = ['validate', 'identity', 'upload', 'campaign', 'adgroup', 'ads', 'enable'];
export const STEP_LABELS = { validate: 'مراجعة البيانات', identity: 'هوية الإعلان (البراند)', upload: 'رفع الفيديوهات', campaign: 'إنشاء الحملة', adgroup: 'إنشاء المجموعة الإعلانية', ads: 'إنشاء الإعلانات', enable: 'التشغيل' };
const LOCK_STALE_MS = 15 * 60_000;
const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

const mark = (d, key, status, extra = {}) => {
  const steps = d.progress.steps.filter((s) => s.key !== key); steps.push({ key, status, at: new Date().toISOString(), ...extra });
  d.progress.steps = STEPS.map((k) => steps.find((s) => s.key === k)).filter(Boolean);
};
const stepDone = (d, key) => d.progress.steps.find((s) => s.key === key)?.status === 'DONE';

export async function assertWritesUnlocked(deps = {}) {
  const on = deps.writesUnlocked ? await deps.writesUnlocked() : await getWritesUnlocked();
  if (!on) throw bad('الرفع الحقيقي على تيك توك مقفول (أمان). افتحه من شاشة «الربط» بعد ما تتأكد من الحسابات.', 423, { code: 'TIKTOK_WRITES_LOCKED' });
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vKey = (v) => (v.videoId ? `id:${v.videoId}` : `url:${v.url}`);

/** Run (or resume) a launch. Returns the draft. enable=true also turns it on at the end (the caller must have the owner's explicit confirmation). */
export async function launchDraft(id, opts = {}, deps = {}) {
  if (running.has(id)) throw bad('الكامبين بيتم رفعه دلوقتي.', 409); // the lock is taken synchronously: two clicks / two tabs can never both start
  running.add(id);
  try { return await launchInner(id, opts, deps); } finally { running.delete(id); }
}

async function launchInner(id, { userId = null, enable = false } = {}, deps = {}) {
  const sleep = deps.sleep || defaultSleep; const now = deps.now || (() => new Date());
  const get = deps.getDraft || getDraft; const save = deps.saveDraft || saveDraftRow;
  const d0 = await get(id); if (!d0) throw bad('الكامبين مش موجود.', 404);
  if (d0.status === 'LAUNCHING' && now().getTime() - new Date(d0.updatedAt).getTime() < LOCK_STALE_MS) throw bad('الكامبين بيتم رفعه دلوقتي — استنى لحد ما يخلص.', 409);
  const conn = deps.connection ? await deps.connection() : await getConnection();
  if (conn.mode === 'NONE') throw bad('حساب تيك توك مش مربوط.', 409, { code: 'TIKTOK_NOT_CONNECTED' });
  if (d0.mode !== conn.mode) throw bad(d0.mode === 'MOCK' ? 'الكامبين ده اتعمل في الوضع التجريبي ومينفعش يتبعت لتيك توك الحقيقي. اعمل كامبين جديد.' : 'الربط الحالي تجريبي — الكامبين ده للحساب الحقيقي. اربط الحساب الحقيقي الأول.', 409);
  if (conn.mode === 'REAL') await assertWritesUnlocked(deps); // the real-write lock (default LOCKED): the owner opens it explicitly in the TikTok screen
  if (conn.mode === 'REAL') { const g = deps.guard ? await deps.guard() : await (await import('../writeGate.js')).checkGlobalMetaWrite({ source: 'tiktok:launch', userId }); if (!g.ok) throw bad(g.message || 'الكتابة متوقفة (Emergency Stop).', 423); }

  const prevError = d0.error; // remembered: a create that died on the network is looked up by name instead of blindly repeated
  const d = d0; d.status = 'LAUNCHING'; d.error = null; await save(d);
  const { client } = deps.client ? { client: deps.client } : await getClient();
  let currentStep = 'validate';
  try {
    // 1) validate with the REAL account context (time zone + currency)
    currentStep = 'validate'; mark(d, 'validate', 'RUNNING'); await save(d);
    const info = await client.advertiserInfo();
    const v = validateConfig(d.config, { timeZone: info.timezone, currency: info.currency, now: now() });
    if (!v.ok) throw bad(v.errors.map((e) => e.message).join(' — '), 400, { validation: v.errors });
    const cfg = v.config; d.progress.warnings = v.warnings.map((w) => w.message);
    mark(d, 'validate', 'DONE'); await save(d);

    // 2) identity
    currentStep = 'identity';
    if (!d.progress.identityId) {
      mark(d, 'identity', 'RUNNING'); await save(d);
      if (cfg.identity.mode === 'EXISTING') d.progress.identityId = cfg.identity.id;
      else {
        const existing = (await client.identities()).find((i) => i.name.trim().toLowerCase() === cfg.displayName.trim().toLowerCase()); // same brand name → reuse, never duplicate
        d.progress.identityId = existing ? existing.id : await client.createIdentity(cfg.displayName);
      }
      mark(d, 'identity', 'DONE', { detail: d.progress.identityId }); await save(d);
    }

    // 3) videos + covers (each saved the moment it exists)
    currentStep = 'upload';
    if (!cfg.videos.every((vv) => d.progress.uploads[vKey(vv)]?.coverImageId)) {
      mark(d, 'upload', 'RUNNING'); await save(d);
      for (let i = 0; i < cfg.videos.length; i++) {
        const vv = cfg.videos[i]; const key = vKey(vv); const up = d.progress.uploads[key] || (d.progress.uploads[key] = { name: vv.name || `فيديو ${i + 1}` });
        if (up.coverImageId) continue;
        if (!up.videoId) { up.videoId = vv.videoId || await client.uploadVideoByUrl(vv.url, up.name); await save(d); }
        let info = null;
        for (let t = 0; t < (deps.pollTries ?? 20); t++) { info = (await client.videoInfo([up.videoId]))[0]; if (info?.video_cover_url) break; await sleep(deps.pollMs ?? 3000); }
        if (!info?.video_cover_url) throw bad('الفيديو لسه بيتعالج على تيك توك. ماتتكررش حاجة — اضغط «كمّل» بعد دقيقة.', 202, { retryable: true });
        if (info.width && info.height && info.height < info.width) (d.progress.warnings ||= []).push(`الفيديو «${up.name}» أفقي — تيك توك بيشتغل أحسن مع الفيديو الرأسي 9:16.`);
        if (info.duration && info.duration < 5) (d.progress.warnings ||= []).push(`الفيديو «${up.name}» أقل من 5 ثواني.`);
        up.coverImageId = await client.uploadImageByUrl(info.video_cover_url, `${up.name} cover`); await save(d);
      }
      mark(d, 'upload', 'DONE', { detail: `${cfg.videos.length}` }); await save(d);
    }

    // 4) campaign (a create whose outcome is unknown is looked up by name first)
    currentStep = 'campaign';
    if (!d.progress.campaignId) {
      mark(d, 'campaign', 'RUNNING'); await save(d);
      const prev = prevError?.step === 'campaign' && prevError?.unknownOutcome;
      let adopted = null;
      if (prev) { try { adopted = (await client.listCampaigns()).find((c) => c.campaign_name === cfg.name); } catch { /* fall through to a normal create */ } }
      d.progress.campaignId = adopted ? String(adopted.campaign_id) : await client.createCampaign(buildCampaignPayload(cfg, { advertiserId: client.advertiserId }));
      mark(d, 'campaign', 'DONE', { detail: d.progress.campaignId }); await save(d);
    }

    // 5) ad group
    currentStep = 'adgroup';
    if (!d.progress.adgroupId) {
      mark(d, 'adgroup', 'RUNNING'); await save(d);
      d.progress.adgroupId = await client.createAdGroup(buildAdGroupPayload(cfg, { advertiserId: client.advertiserId, campaignId: d.progress.campaignId, timeZone: info.timezone, now: now() }));
      mark(d, 'adgroup', 'DONE', { detail: d.progress.adgroupId }); await save(d);
    }

    // 6) ads
    currentStep = 'ads';
    if (!d.progress.adIds.length) {
      mark(d, 'ads', 'RUNNING'); await save(d);
      const uploads = cfg.videos.map((vv) => ({ ...d.progress.uploads[vKey(vv)] }));
      d.progress.adIds = await client.createAds(buildAdPayload(cfg, { advertiserId: client.advertiserId, adgroupId: d.progress.adgroupId, identityId: d.progress.identityId, uploads }));
      mark(d, 'ads', 'DONE', { detail: `${d.progress.adIds.length}` }); await save(d);
    }
    d.status = 'LAUNCHED'; await save(d);

    // 7) turn on — only when explicitly asked
    if (enable) await enableDraftInner(d, client, save);
    return d;
  } catch (e) {
    const unknownOutcome = !(e instanceof TikTokError && e.code != null) && !e.status; // network/timeout: TikTok may or may not have created it
    d.status = 'FAILED';
    d.error = { step: currentStep, stepLabel: STEP_LABELS[currentStep], message: String(e.message || e).slice(0, 500), code: e.code ?? null, requestId: e.requestId ?? null, unknownOutcome: unknownOutcome && ['campaign', 'adgroup', 'ads'].includes(currentStep), hint: explainTikTokError(e), at: new Date().toISOString() };
    mark(d, currentStep, 'FAILED', { error: d.error.message });
    await save(d).catch(() => {});
    throw e;
  }
}

async function enableDraftInner(d, client, save) {
  mark(d, 'enable', 'RUNNING'); await save(d);
  await client.setStatus('campaign', [d.progress.campaignId], 'ENABLE');
  await client.setStatus('adgroup', [d.progress.adgroupId], 'ENABLE');
  if (d.progress.adIds.length) await client.setStatus('ad', d.progress.adIds, 'ENABLE');
  d.progress.enabled = true; d.status = 'ENABLED'; mark(d, 'enable', 'DONE'); await save(d);
}

/** Turn an already-launched (paused) campaign on. Explicit confirmation is the caller's job. */
export async function enableDraft(id, { userId = null } = {}, deps = {}) {
  const get = deps.getDraft || getDraft; const save = deps.saveDraft || saveDraftRow;
  const d = await get(id); if (!d) throw bad('الكامبين مش موجود.', 404);
  if (!d.progress.campaignId || !d.progress.adgroupId || !d.progress.adIds.length) throw bad('الكامبين لسه ما اتعملش بالكامل على تيك توك.', 409);
  if (d.progress.enabled) return d;
  const conn = deps.connection ? await deps.connection() : await getConnection();
  if (conn.mode !== d.mode) throw bad('نوع الربط الحالي مختلف عن نوع الكامبين.', 409);
  if (conn.mode === 'REAL') await assertWritesUnlocked(deps); // the real-write lock (default LOCKED): the owner opens it explicitly in the TikTok screen
  if (conn.mode === 'REAL') { const g = deps.guard ? await deps.guard() : await (await import('../writeGate.js')).checkGlobalMetaWrite({ source: 'tiktok:enable', userId }); if (!g.ok) throw bad(g.message || 'الكتابة متوقفة (Emergency Stop).', 423); }
  const { client } = deps.client ? { client: deps.client } : await getClient();
  try { await enableDraftInner(d, client, save); } catch (e) { d.error = { step: 'enable', stepLabel: STEP_LABELS.enable, message: String(e.message || e).slice(0, 500), code: e.code ?? null, hint: explainTikTokError(e), at: new Date().toISOString() }; await save(d).catch(() => {}); throw e; }
  return d;
}

export async function pauseDraft(id, { userId = null } = {}, deps = {}) {
  const get = deps.getDraft || getDraft; const save = deps.saveDraft || saveDraftRow;
  const d = await get(id); if (!d) throw bad('الكامبين مش موجود.', 404);
  if (!d.progress.campaignId) throw bad('الكامبين لسه ما اتعملش على تيك توك.', 409);
  const connP = deps.connection ? await deps.connection() : await getConnection();
  if (connP.mode === 'REAL') await assertWritesUnlocked(deps);
  const { client } = deps.client ? { client: deps.client } : await getClient();
  await client.setStatus('campaign', [d.progress.campaignId], 'DISABLE'); // pausing the campaign stops delivery for everything under it
  d.progress.enabled = false; d.status = 'LAUNCHED'; await save(d); return d;
}

export const isRunning = (id) => running.has(id);
