// AI Media Buyer — AUTO SCALE («اسكيل أوتوماتيك»). A media buyer sits and scales the winners of every ad account by hand; this does the same ROUTINE by itself, once a day:
//
//   at `runAtCairo` (default 12:00 noon, Cairo) it walks the ad accounts ONE AFTER ANOTHER — the connected one (Ahmed Samy) first, then every other switchable account (Hady …) —
//   and for each account scales every campaign that is «جاهزة للاسكيل» (the SAME rule the page uses: ≥ 1 order and CPA ≤ 80 EGP) as a normal bulk scale:
//   CBO, `budgetEgp` (300) per campaign, the winning ads, SCHEDULED to start at `startAtCairo` (default 00:00 = the coming midnight). An account is finished (all its scales done) before the next starts.
//
// It is only a sequencer around the EXISTING pieces — listScaleWinners (what is ready), scaleBulk.startBulk (one campaign at a time, the gap between them, the stop on a Meta throttle) and executeScale
// (validation, clone engine, decision row, PAUSED+proof verification). So every guard of a hand-made scale applies unchanged: the Emergency Stop / the Meta write lock (checked before anything
// starts, and again by every executeScale), a campaign already scaled is not offered again (its decision row), report-only accounts are never scaled.
//
// OFF by default. The owner switches it on (and off) from the scale page; switching it off also stops the run in progress (what was already created stays — it is real and recorded).
// No AI, nothing guessed: every number comes from the saved config.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnectionUnscoped, accountScope } from '../metaAuth.js';
import { getAmbSettings } from './settings.js';
import { getViewAccountIds } from './snapshotSync.js';
import { checkGlobalMetaWrite } from './writeGate.js';
import { cairoLocalToUtc } from './cloneEngine.js';
import { startBulk, getBatch, cancelBatch, MAX_ITEMS, MIN_GAP_S, MAX_GAP_S, META_THROTTLE_RE } from './scaleBulk.js';

const CFG_ID = 'amb:autoscale';
const TZ = 'Africa/Cairo';
export const DEFAULTS = Object.freeze({
  enabled: false, runAtCairo: '12:00', runUntilCairo: '23:00', startAtCairo: '00:00', budgetEgp: 300, accountBudgets: {}, window: 'today', gapSeconds: 60, maxPerAccount: MAX_ITEMS, accountIds: null, enabledBy: null, enabledAt: null,
});
/** The daily window is [runAtCairo, runUntilCairo] (default 12:00 → 23:00): the system works inside it (switching it on at 8 pm scales at once), stops starting new accounts at the end, and — because the scale is scheduled for the coming midnight — waits after 00:00 until noon, when the day has winners again. */
const MAX_RESUMES = 2;
const WINDOWS = ['today', 'yesterday'];

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }
const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const normHM = (v) => { const m = HM.exec(String(v || '').trim()); return m ? `${String(m[1]).padStart(2, '0')}:${m[2]}` : null; };

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Cairo clock helpers (pure)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
/** { date: 'YYYY-MM-DD', minutes: minutes since Cairo midnight } of an instant. */
export function cairoNow(ms = Date.now()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
export function addDays(dateStr, n) { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const hmToMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };

/**
 * The next Cairo wall-clock `startAtCairo` that is at least `leadMs` ahead of `ms` → 'YYYY-MM-DDTHH:MM' (the format startBulk / executeScale take).
 * 12:00 noon + 00:00 → tonight's midnight («بكرة 00:00» on the calendar).
 */
export function nextStartAt(ms, startAtCairo, leadMs = 0) {
  const hm = normHM(startAtCairo); if (!hm) throw bad('موعد البدء لازم يكون بصيغة HH:MM.');
  const today = cairoNow(ms).date;
  for (let k = 0; k <= 2; k++) {
    const date = addDays(today, k); const at = cairoLocalToUtc(date, hm);
    if (at && at.getTime() >= ms + leadMs) return `${date}T${hm}`;
  }
  return `${addDays(today, 3)}T${hm}`;
}
/** When the next daily run is due (ms), or null: right now when it has not run today and we are inside the window; today's start when it is still ahead; else tomorrow's. */
export function nextRunAt(cfg, state, ms = Date.now()) {
  const hm = normHM(cfg.runAtCairo); const until = normHM(cfg.runUntilCairo || DEFAULTS.runUntilCairo); if (!hm || !until) return null;
  const now = cairoNow(ms); const ranToday = state?.lastRunDate === now.date;
  const startMin = hmToMin(hm); const endMin = hmToMin(until);
  if (!ranToday && now.minutes >= startMin && now.minutes < endMin) return ms;
  const date = (!ranToday && now.minutes < startMin) ? now.date : addDays(now.date, 1);
  return cairoLocalToUtc(date, hm)?.getTime() ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Config + state (one settings row; own validation, independent of the AMB settings schema)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
/** Pure: validate a config patch (only known keys) and return the cleaned fields. Throws a clean 400. */
export function validateConfigPatch(patch = {}) {
  const out = {};
  if ('runAtCairo' in patch) { const v = normHM(patch.runAtCairo); if (!v) throw bad('وقت التشغيل لازم يكون بصيغة HH:MM (مثلًا 12:00).'); out.runAtCairo = v; }
  if ('runUntilCairo' in patch) { const v = normHM(patch.runUntilCairo); if (!v) throw bad('وقت الانتهاء لازم يكون بصيغة HH:MM (مثلًا 23:00).'); out.runUntilCairo = v; }
  if ('accountBudgets' in patch) {
    const o = patch.accountBudgets && typeof patch.accountBudgets === 'object' ? patch.accountBudgets : {}; const clean = {};
    for (const [k, val] of Object.entries(o)) { if (val === '' || val == null) continue; if (!/^act_\d+$/.test(k)) throw bad('حساب غير صالح في ميزانيات الحسابات.'); const n = Number(val); if (!(n >= 10 && n <= 100000)) throw bad('ميزانية كل حساب لازم تكون بين 10 و 100000 جنيه.'); clean[k] = Math.round(n * 100) / 100; }
    out.accountBudgets = clean;
  }
  if ('startAtCairo' in patch) { const v = normHM(patch.startAtCairo); if (!v) throw bad('موعد بداية الكامبينات لازم يكون بصيغة HH:MM (مثلًا 00:00).'); out.startAtCairo = v; }
  if ('budgetEgp' in patch) { const v = Number(patch.budgetEgp); if (!(v >= 10 && v <= 100000)) throw bad('ميزانية الكامبين لازم تكون بين 10 و 100000 جنيه.'); out.budgetEgp = Math.round(v * 100) / 100; }
  if ('window' in patch) { if (!WINDOWS.includes(patch.window)) throw bad('فترة الاختيار لازم تكون today أو yesterday.'); out.window = patch.window; }
  if ('gapSeconds' in patch) { const v = Math.round(Number(patch.gapSeconds)); if (!(v >= MIN_GAP_S && v <= MAX_GAP_S)) throw bad(`الفاصل بين الكامبينات لازم بين ${MIN_GAP_S} و ${MAX_GAP_S} ثانية.`); out.gapSeconds = v; }
  if ('maxPerAccount' in patch) { const v = Math.round(Number(patch.maxPerAccount)); if (!(v >= 1 && v <= MAX_ITEMS)) throw bad(`أقصى عدد كامبينات للحساب في اليوم بين 1 و ${MAX_ITEMS}.`); out.maxPerAccount = v; }
  if ('accountIds' in patch) {
    if (patch.accountIds === null) out.accountIds = null;
    else { const ids = Array.isArray(patch.accountIds) ? patch.accountIds.map(String) : []; if (!ids.length || ids.some((x) => !/^act_\d+$/.test(x))) throw bad('الحسابات لازم تكون act_… أو الكل.'); out.accountIds = [...new Set(ids)]; }
  }
  return out;
}

async function loadAll() {
  let row = null; try { row = await prisma.settings.findUnique({ where: { id: CFG_ID } }); } catch { /* empty */ }
  let v = {}; try { v = JSON.parse(row?.data || '{}'); } catch { v = {}; }
  return { config: { ...DEFAULTS, ...(v.config || {}) }, state: { lastRunDate: null, lastRun: null, running: null, history: [], resumes: 0, lastCheck: null, ...(v.state || {}) } };
}
async function saveAll(all) { const data = JSON.stringify({ config: all.config, state: all.state }); await prisma.settings.upsert({ where: { id: CFG_ID }, create: { id: CFG_ID, data }, update: { data } }); }

export async function saveConfig(patch, { userId = null } = {}) {
  const clean = validateConfigPatch(patch || {}); const all = await loadAll();
  const next = { ...all.config, ...clean }; if (hmToMin(next.runUntilCairo) <= hmToMin(next.runAtCairo)) throw bad('وقت الانتهاء لازم يكون بعد وقت البداية في نفس اليوم.');
  all.config = next; await saveAll(all);
  logger.info('[autoScale] config saved', { userId, keys: Object.keys(clean) });
  return all.config;
}

let runSlotValue = null; // { stop: boolean, batchId: string|null }
const runSlot = { get: () => runSlotValue, set: (v) => { runSlotValue = v; return v; }, clear: () => { runSlotValue = null; } };

/** Switch the daily auto scale on / off. Off also stops the run in progress. */
export async function setEnabled(on, { userId = null } = {}) {
  const all = await loadAll();
  all.config.enabled = !!on; all.config.enabledBy = on ? (userId ?? all.config.enabledBy ?? null) : all.config.enabledBy; all.config.enabledAt = on ? new Date().toISOString() : all.config.enabledAt;
  await saveAll(all);
  let stopped = false; if (!on) stopped = requestStop();
  logger.info('[autoScale] ' + (on ? 'ENABLED' : 'DISABLED'), { userId, stopped });
  return { enabled: all.config.enabled, stopped };
}

/** Stop the run in progress (cancels the bulk that is running; campaigns already created stay). */
export function requestStop() {
  const s = runSlot.get(); if (!s) return false;
  s.stop = true; if (s.batchId) { try { cancelBatch(s.batchId); } catch { /* already finished */ } }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Accounts + plan
// ---------------------------------------------------------------------------------------------------------------------------------------------------
/** The accounts to scale, in order: the connected account first, then the other switchable ones; report-only accounts are never scaled. */
/** Pure: which accounts a run scales, in order. The connected account first. «للمتابعة فقط» accounts are left out UNLESS the owner ticked them in the settings (`explicit` = the saved list; null = never chosen → every account except the report-only ones). */
export function pickAccounts({ ids, primary, reportOnly, explicit }) {
  const ordered = primary ? [primary, ...ids.filter((id) => id !== primary)] : [...ids];
  const chosen = Array.isArray(explicit) ? new Set(explicit) : null;
  return { ordered, selected: ordered.filter((id) => (chosen ? chosen.has(id) : !reportOnly.has(id))), reportOnlyLeftOut: chosen ? [] : ordered.filter((id) => reportOnly.has(id)) };
}
export async function defaultAccounts(cfg, { all = false } = {}) {
  const conn = await getConnectionUnscoped(); const settings = await getAmbSettings();
  const reportOnly = new Set((settings.ambReportOnlyAccountIds || []).map(String));
  const primary = conn?.status === 'CONNECTED' ? conn.selected_ad_account_id || null : null;
  const picked = pickAccounts({ ids: await getViewAccountIds(), primary, reportOnly, explicit: Array.isArray(cfg.accountIds) ? cfg.accountIds : null });
  const ids = all ? picked.ordered : picked.selected; const skipped = picked.reportOnlyLeftOut;
  let names = new Map();
  try { const { listViewAccounts } = await import('./viewAccounts.js'); names = new Map((await listViewAccounts()).accounts.map((a) => [a.id, a.name])); } catch { /* names are cosmetic */ }
  return { accounts: ids.map((id) => ({ id, name: names.get(id) || (id === primary ? conn?.selected_ad_account_name : null) || id, isPrimary: id === primary, reportOnly: reportOnly.has(id) })), reportOnlySkipped: skipped };
}

/** Pure: the cards of one account → the bulk items (CBO, the configured budget, the winning ads), best first, capped. */
export const budgetFor = (cfg, accountId) => Number(cfg.accountBudgets?.[accountId]) > 0 ? Number(cfg.accountBudgets[accountId]) : cfg.budgetEgp;
export function buildItems(cards, cfg, accountId = null) {
  const budget = budgetFor(cfg, accountId);
  const ready = (cards || []).filter((c) => c && c.decisionStatus === 'PENDING' && !c.adsUnavailable && Array.isArray(c.winningAdIds) && c.winningAdIds.length);
  ready.sort((a, b) => ((b.orders || 0) - (a.orders || 0)) || ((a.cpa ?? 1e9) - (b.cpa ?? 1e9)));
  const picked = ready.slice(0, cfg.maxPerAccount);
  return { items: picked.map((c) => ({ sourceCampaignId: c.sourceCampaignId, label: c.displayName || c.sourceCampaignName || c.sourceCampaignId, budgetMode: 'CBO', selectedAdIds: c.winningAdIds, campaignBudgetEgp: budget })), budgetEgp: budget, ready: ready.length, leftOver: Math.max(0, ready.length - picked.length) };
}

async function listWinnersFor(account, cfg, deps) {
  const run = async () => (deps.listWinners || (async (a) => (await import('./scaleWinners.js')).listScaleWinners(a)))({ windowName: cfg.window, adAccountId: account.isPrimary ? null : account.id });
  return account.isPrimary ? run() : (deps.runInScope ? deps.runInScope(account.id, run) : accountScope.run({ adAccountId: account.id }, run));
}

/** For the settings panel: every account the system could scale (connected first), whether it is included and its own budget (null = the default one). */
export async function listAccountsForConfig() {
  const { config } = await loadAll();
  const { accounts, reportOnlySkipped } = await defaultAccounts({ ...config, accountIds: null }, { all: true });
  return { defaultBudgetEgp: config.budgetEgp, reportOnly: reportOnlySkipped, accounts: accounts.map((a) => ({ id: a.id, name: a.name, isPrimary: a.isPrimary, reportOnly: !!a.reportOnly, included: Array.isArray(config.accountIds) ? config.accountIds.includes(a.id) : !a.reportOnly, budgetEgp: Number(config.accountBudgets?.[a.id]) > 0 ? Number(config.accountBudgets[a.id]) : null, effectiveBudgetEgp: budgetFor(config, a.id) })) };
}

/** Read-only: what a run would do right now (which campaigns on which account, the budget, the start time). Calls Meta only to READ. */
export async function previewAutoScale({ now = Date.now(), deps = {} } = {}) {
  const { config } = await loadAll();
  const { accounts, reportOnlySkipped } = await (deps.accounts || defaultAccounts)(config);
  const startAt = nextStartAt(now, config.startAtCairo, 0);
  const out = [];
  for (const a of accounts) {
    try { const cards = (await listWinnersFor(a, config, deps)).cards || []; const b = buildItems(cards, config, a.id); out.push({ accountId: a.id, name: a.name, isPrimary: a.isPrimary, ready: b.ready, willScale: b.items.length, leftOver: b.leftOver, budgetEgp: b.budgetEgp, dailyTotalEgp: Math.round(b.items.length * b.budgetEgp), campaigns: b.items.map((i) => i.label) }); }
    catch (e) { out.push({ accountId: a.id, name: a.name, isPrimary: a.isPrimary, error: String(e.message || e).slice(0, 200) }); }
  }
  return { startAt, budgetEgp: config.budgetEgp, window: config.window, accounts: out, totalDailyEgp: out.reduce((t, a) => t + (a.dailyTotalEgp || 0), 0), reportOnlySkipped };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const RETRY_AFTER_MS = 10 * 60_000; // a held account is tried again this long after it was set aside
export const STUCK_AFTER_MS = 6 * 60_000; // one campaign running longer than this = Meta is slow on that account
const MAX_HARD_ERRORS = 3; // an error that is not «Meta is busy» is retried this many times, then the account is left as failed

/** Has Meta put this ad account on hold since `sinceMs`? The clone engine writes THROTTLE_WAIT while it waits for an account's quota. */
async function accountOnHold(accountId, sinceMs) {
  const hit = await prisma.ambCloneAudit.findFirst({ where: { event: 'THROTTLE_WAIT', created_at: { gte: new Date(sinceMs) }, batch: { destination_account_ids_json: { contains: accountId } } }, select: { id: true } }).catch(() => null);
  return !!hit;
}

/**
 * Waits for one account's bulk. When Meta holds the account (quota wait, or one campaign stuck too long) the rest of ITS campaigns are cancelled and the call returns at once with `held`:
 * the run goes on to the next account instead of standing behind this one. The campaign already being created finishes by itself when Meta releases the account.
 */
async function waitForBatch(id, slot, deps, { accountId, sinceMs }) {
  const poll = deps.pollMs ?? 4000;
  const onHold = deps.isOnHold || accountOnHold;
  for (;;) {
    const b = (deps.getBatch || getBatch)(id); if (!b) return { fin: null };
    if (b.status !== 'RUNNING') return { fin: b };
    if (slot.stop) { try { (deps.cancelBatch || cancelBatch)(id); } catch { /* done */ } return { fin: (deps.getBatch || getBatch)(id) || b }; } // «إيقاف» returns at once, even if the campaign in hand is held by Meta
    else {
      const cur = (b.items || []).find((x) => x.status === 'RUNNING');
      const stuck = cur?.startedAt && (deps.now || Date.now)() - cur.startedAt > STUCK_AFTER_MS;
      if (stuck || await onHold(accountId, sinceMs)) {
        try { (deps.cancelBatch || cancelBatch)(id); } catch { /* done */ }
        return { fin: (deps.getBatch || getBatch)(id) || b, held: stuck ? 'كامبين بياخد وقت طويل على ميتا' : 'ميتا حاجزة الحساب مؤقتًا (حد الطلبات)' };
      }
    }
    await (deps.sleep || sleep)(poll);
  }
}

/** Write the run state without touching the config: a setting the owner changes while a run is going must stay as they saved it. */
async function saveState(patch) { const fresh = await loadAll(); Object.assign(fresh.state, patch); await saveAll(fresh); }

/**
 * The whole day's pass over every account. `force` runs even when switched off (the owner's «شغّل دلوقتي»).
 * Accounts are worked one at a time. When one has a problem (Meta quota wait, a stuck campaign, a busy account, a temporary error) it is set aside («مستني») and the next one starts;
 * the run comes back to it after RETRY_AFTER_MS (longer each time it is still held, up to 3×) until its winners are done or the time before the start runs out. A campaign already scaled is never offered again (its decision row), and the
 * per-account cap counts every attempt together.
 */
export async function runAutoScale({ now = Date.now(), force = false, trigger = 'SCHEDULED', userId = null, deps = {} } = {}) {
  const all = await loadAll(); const cfg = all.config;
  if (!force && !cfg.enabled) return { skipped: 'DISABLED' };
  if (runSlot.get()) return { skipped: 'ALREADY_RUNNING' };
  const gate = await (deps.writeGate || ((a) => checkGlobalMetaWrite(a)))({ source: 'autoscale:run', userId });
  if (!gate.ok) { await saveState({ lastCheck: { at: new Date(now).toISOString(), status: 'BLOCKED', reason: gate.message || gate.code || 'WRITE_BLOCKED' } }); return { skipped: 'WRITE_BLOCKED', reason: gate.message || gate.code }; }
  const slot = { stop: false, batchId: null }; runSlot.set(slot);
  const t0 = Date.now(); const clock = deps.clock || (() => now + (Date.now() - t0)); // the run's own clock (tests pass their own)
  const today = cairoNow(now).date;
  const run = { date: today, trigger, startedAt: new Date(now).toISOString(), finishedAt: null, status: 'RUNNING', startAt: null, budgetEgp: cfg.budgetEgp, accounts: [] };
  await saveState({ lastRunDate: today, running: run });
  try {
    const { accounts, reportOnlySkipped } = await (deps.accounts || defaultAccounts)(cfg);
    if ((reportOnlySkipped || []).length) run.accounts.push({ accountId: reportOnlySkipped[0], name: reportOnlySkipped.length > 1 ? reportOnlySkipped.length + ' حساب «للمتابعة فقط»' : reportOnlySkipped[0], status: 'SKIPPED', reason: 'حسابات «للمتابعة فقط» — مش بتتسكيل إلا لو علّمتها من الإعدادات.' });
    const actor = userId ?? cfg.enabledBy ?? null;
    const startAt = nextStartAt(now, cfg.startAtCairo, 0); const startMs = cairoLocalToUtc(startAt.slice(0, 10), startAt.slice(11)).getTime(); // ONE start time for the whole run: never pushed to the next day's midnight
    const windowOver = () => trigger === 'SCHEDULED' && (cairoNow(clock()).date !== today || cairoNow(clock()).minutes >= hmToMin(cfg.runUntilCairo));
    const needMs = (n) => 5 * 60_000 + n * cfg.gapSeconds * 1000 + 120_000; // the campaigns must still be created before the start time
    const queue = accounts.map((a) => ({ a, rec: null, nextAt: 0, used: 0, errors: 0 }));
    const lateReason = (q) => (q.rec?.status === 'WAITING' ? 'فضل محجوز من ميتا لحد ما الوقت خلص — هيتسكيّل بكرة ' + cfg.runAtCairo + '.' : 'عدّى وقت الانتهاء (' + cfg.runUntilCairo + ') — هيتسكيّل بكرة ' + cfg.runAtCairo + '.');
    const recOf = (q) => { if (!q.rec) { q.rec = { accountId: q.a.id, name: q.a.name, status: 'RUNNING', ready: 0, scaled: 0, failed: 0, skipped: 0, held: 0, leftOver: 0, attempts: 0, reason: null, startedAt: new Date(clock()).toISOString() }; run.accounts.push(q.rec); } return q.rec; };
    const close = (q, status, reason) => { const rec = recOf(q); rec.status = status; if (reason !== undefined) rec.reason = reason; rec.retryAt = null; rec.finishedAt = new Date(clock()).toISOString(); };
    const defer = (q, why) => { const rec = recOf(q); q.holds = (q.holds || 0) + 1; q.nextAt = clock() + (deps.retryAfterMs ?? RETRY_AFTER_MS) * Math.min(q.holds, 3); /* 10, 20, then every 30 min while it stays held */ rec.status = 'WAITING'; rec.reason = String(why).slice(0, 220) + ' — هنرجعله تلقائي.'; rec.retryAt = new Date(q.nextAt).toISOString(); queue.push(q); };

    while (queue.length && !slot.stop) {
      const i = queue.findIndex((q) => q.nextAt <= clock()); // new accounts first (they are ahead in the queue), then the held ones whose wait is over
      if (i < 0) {
        const soonest = Math.min(...queue.map((q) => q.nextAt));
        if (windowOver() || soonest + needMs(1) > startMs) { for (const q of queue.splice(0)) close(q, q.used ? 'PARTIAL' : 'TOO_LATE', lateReason(q)); break; }
        await (deps.sleep || sleep)(Math.max(1000, Math.min(15_000, soonest - clock()))); continue;
      }
      const q = queue.splice(i, 1)[0]; const a = q.a;
      if (windowOver()) { close(q, q.used ? 'PARTIAL' : 'TOO_LATE', lateReason(q)); continue; }
      const rec = recOf(q); rec.status = 'RUNNING'; rec.retryAt = null; rec.attempts += 1; await saveState({ running: run });
      try {
        const left = cfg.maxPerAccount - q.used;
        if (left <= 0) { close(q, rec.failed ? 'PARTIAL' : 'DONE', null); continue; }
        const cards = (await listWinnersFor(a, cfg, deps)).cards || [];
        const b = buildItems(cards, { ...cfg, maxPerAccount: left }, a.id); rec.ready = Math.max(rec.ready, b.ready + q.used); rec.leftOver = b.leftOver; rec.budgetEgp = b.budgetEgp;
        if (!b.items.length) { close(q, q.used ? (rec.failed ? 'PARTIAL' : 'DONE') : 'NOTHING', q.used ? null : 'مفيش كامبينات جاهزة للاسكيل.'); continue; }
        if (startMs - clock() < needMs(Math.min(b.items.length, 1))) { close(q, q.used ? 'PARTIAL' : 'TOO_LATE', 'الوقت مش كفاية قبل موعد البدء (' + cfg.startAtCairo + ') — هيتسكيّل بكرة.'); continue; }
        const fits = Math.max(1, Math.floor((startMs - clock() - needMs(0)) / (cfg.gapSeconds * 1000))); const items = b.items.slice(0, fits);
        run.startAt = startAt;
        const exec = deps.exec || (await import('./scaleWinners.js')).executeScale;
        const start = () => (deps.startBulk || startBulk)({ items, startMode: 'SCHEDULE', startAt, gapSeconds: cfg.gapSeconds, windowName: cfg.window, userId: actor, adAccountId: a.isPrimary ? null : a.id }, { exec, toUtc: cairoLocalToUtc });
        const sinceMs = Date.now();
        const batch0 = a.isPrimary ? start() : (deps.runInScope ? await deps.runInScope(a.id, async () => start()) : await accountScope.run({ adAccountId: a.id }, async () => start()));
        slot.batchId = batch0.id;
        const { fin, held } = await waitForBatch(batch0.id, slot, deps, { accountId: a.id, sinceMs }); slot.batchId = null;
        if (!fin) { close(q, 'UNKNOWN', 'ملقتش نتيجة الطلب (السيرفر اتعمله restart؟).'); continue; }
        const done = fin.counts.done || 0; const failed = fin.counts.failed || 0; const inFlight = held ? (fin.items || []).filter((x) => x.status === 'RUNNING').length : 0;
        rec.scaled += done; rec.failed += failed; rec.skipped += fin.counts.skipped || 0; rec.held += inFlight; q.used += done + failed + inFlight; if (done) q.holds = 0;
        const errs = (fin.items || []).filter((x) => x.error).map((x) => x.error);
        if (fin.stopReason === 'WRITE_BLOCKED') { close(q, 'STOPPED_WRITE_BLOCKED', errs[0] ? String(errs[0]).slice(0, 220) : null); run.stopReason = 'WRITE_BLOCKED'; slot.stop = true; continue; }
        if (slot.stop) { close(q, 'CANCELED', 'اتوقف.'); continue; }
        if (held) { defer(q, held); continue; }
        if (fin.stopReason === 'RATE_LIMIT' || fin.stopReason === 'WAIT_TIMEOUT') { defer(q, fin.stopReason === 'RATE_LIMIT' ? 'ميتا حاجزة الحساب مؤقتًا (حد الطلبات)' : 'ميتا بطيئة على الحساب'); continue; }
        close(q, fin.status === 'CANCELED' ? 'CANCELED' : (rec.failed ? 'PARTIAL' : 'DONE'), errs[0] ? String(errs[0]).slice(0, 220) : null);
      } catch (e) {
        const msg = String(e.message || e).slice(0, 220); logger.warn('[autoScale] account failed', { accountId: a.id, message: msg });
        const busy = e.status === 409 || META_THROTTLE_RE.test(msg);
        if (!busy) q.errors += 1;
        if (slot.stop) close(q, 'CANCELED', 'اتوقف.');
        else if (busy || q.errors < MAX_HARD_ERRORS) defer(q, busy ? (e.status === 409 ? 'الحساب عليه اسكيل لسه شغال' : 'ميتا حاجزة الحساب مؤقتًا (حد الطلبات)') : msg);
        else close(q, 'FAILED', msg);
      } finally { await saveState({ running: run }); }
    }
    for (const q of queue.splice(0)) close(q, 'CANCELED', 'اتوقف.');
    const anyBad = run.accounts.some((r) => ['FAILED', 'PARTIAL', 'UNKNOWN'].includes(r.status) || String(r.status).startsWith('STOPPED'));
    run.status = slot.stop ? 'STOPPED' : (anyBad ? 'PARTIAL' : 'DONE');
  } catch (e) { run.status = 'FAILED'; run.reason = String(e.message || e).slice(0, 220); logger.error('[autoScale] run failed', { message: run.reason }); }
  finally {
    run.finishedAt = new Date().toISOString(); runSlot.clear();
    const fresh = await loadAll(); // the owner may have changed the config while it ran: keep THEIR config, only write the state
    fresh.state.running = null; fresh.state.lastRun = run; fresh.state.history = [run, ...(fresh.state.history || [])].slice(0, 14); fresh.state.resumes = 0; fresh.state.lastCheck = null; await saveAll(fresh);
  }
  return { ran: true, run };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------------------------------------------------------------------------------
/** One 60-second tick: starts the day's run when it is due. The run itself continues in the background (it takes as long as the scaling takes). */
export async function autoScaleTick({ now = Date.now(), deps = {} } = {}) {
  const all = await loadAll(); const { config: cfg, state } = all;
  if (!cfg.enabled) return { skipped: 'DISABLED' };
  if (runSlot.get()) return { skipped: 'ALREADY_RUNNING' };
  const c = cairoNow(now); const hm = normHM(cfg.runAtCairo); if (!hm) return { skipped: 'BAD_CONFIG' };
  if (state.running) { // the server restarted in the middle of a run: settle it; the winners already scaled have their decision rows (never offered again), so the same day may continue (bounded)
    const prev = { ...state.running, status: 'INTERRUPTED', finishedAt: new Date(now).toISOString() };
    state.lastRun = prev; state.history = [prev, ...(state.history || [])].slice(0, 14); state.running = null;
    if ((state.resumes || 0) < MAX_RESUMES) { state.resumes = (state.resumes || 0) + 1; state.lastRunDate = null; } await saveAll(all);
  }
  if (state.lastRunDate === c.date) return { skipped: 'ALREADY_RAN_TODAY' };
  const start = hmToMin(hm); if (c.minutes < start) return { skipped: 'NOT_YET' };
  if (c.minutes >= hmToMin(cfg.runUntilCairo || DEFAULTS.runUntilCairo)) return { skipped: 'WINDOW_PASSED' };
  const p = runAutoScale({ now, deps }).catch((e) => logger.error('[autoScale] tick run failed', { message: e.message }));
  if (deps.awaitRun) return p; return { started: true };
}

let timer = null;
export function startAutoScaleScheduler() {
  if (timer) return;
  timer = setInterval(() => autoScaleTick({ now: Date.now() }).catch((e) => logger.error('[autoScale] tick failed', { message: e.message })), 60_000);
  timer.unref?.(); logger.info('Auto scale scheduler started (60s tick; OFF until the owner switches it on)');
}

/** For the screen: config, last run, the run in progress, when the next one is due, and whether the write lock would refuse it. */
export async function getAutoScaleStatus({ now = Date.now(), deps = {} } = {}) {
  const { config, state } = await loadAll();
  const gate = await (deps.writeGate || ((a) => checkGlobalMetaWrite({ ...a, deps: { audit: false } })))({ source: 'autoscale:status' }).catch(() => null);
  const live = runSlot.get();
  return { config, running: !!live, run: state.running, lastRun: state.lastRun, history: state.history || [], lastCheck: state.lastCheck || null, nextRunAt: config.enabled ? nextRunAt(config, state, now) : null, nextStartAt: nextStartAt(now, config.startAtCairo), writeGate: gate ? { ok: !!gate.ok, message: gate.message || null, code: gate.code || null } : null };
}
