// Ads Payment Center — the engine: extraction (single / bulk), manual registration, payment (single / bulk), reconciliation, credit confirmation and the background follow-up.
//
// The money rules, in one place:
//   1. A job / payment is persisted in its «in progress» state BEFORE the provider is called, with an idempotency key. A second click, a retry or a restarted server finds that record
//      and gets it back — it can never start a second one.
//   2. A provider answer is one of CONFIRMED / FAILED / UNCERTAIN. Only an explicit FAILED («nothing was charged / issued») allows a retry. A timeout, an exception, a restart in the
//      middle, an unknown answer = UNCERTAIN, and an UNCERTAIN payment is NEVER retried — it is looked up (provider query) or resolved by a human with evidence first.
//   3. «Paid» and «credited» are separate facts. PAID needs a trusted payment confirmation; CREDITED needs a trusted credit confirmation (provider / matched Meta transaction / a named
//      person's manual confirmation with evidence). A balance that went up is stored as a HINT and never moves a code to CREDITED.
//   4. Nothing here pays or extracts by itself because of a forecast, an alert or a schedule: every money move starts from a person's explicit request.
import crypto from 'node:crypto';
import { logger } from '../../../logger.js';
import { todayISO, addDaysISO } from '../metricsEngine.js';
import { cairoLocalToUtc } from '../cloneEngine.js';
import * as S from './store.js';
import { STATUS, STATUS_LABEL, OPEN_STATUSES, PAYABLE, SOURCE, JOB_STATUS, bad, parseAmount, validAccountId, validCode, normalizeCode, sumEgp, toPi, fromPi } from './spec.js';
import { providerStatus, adapter } from './providers.js';

// ---------------------------------------------------------------------------
// dependencies (injectable so the suites run with no Meta and no network)
// ---------------------------------------------------------------------------
async function defaultListAccounts() {
  const { listViewAccounts } = await import('../viewAccounts.js');
  const { accounts } = await listViewAccounts();
  return accounts.map((a) => ({ id: a.id, name: a.name, isPrimary: !!a.isPrimary }));
}
async function defaultGetFunds(accountId) {
  const { getDecryptedToken } = await import('../../metaAuth.js');
  const { accountFunds } = await import('../accountsToday.js');
  const token = await getDecryptedToken();
  return accountFunds(token, accountId, false);
}
export const deps = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), listAccounts: defaultListAccounts, getFunds: defaultGetFunds };
export function _setDeps(over) { Object.assign(deps, over); }
const nowIso = () => new Date(deps.now()).toISOString();
const cairoDay = (ms) => todayISO(new Date(ms));

const EXTRACT_TIMEOUT_MS = 45_000;
const PAY_TIMEOUT_MS = 60_000;
const STALE_EXTRACT_MS = 3 * 60_000;
const STALE_PAY_MS = 5 * 60_000;
const withTimeout = (p, ms) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('provider timeout'), { timeout: true })), ms); })]).finally(() => clearTimeout(t)); };
const inflight = new Set(); // ids currently awaiting a provider in THIS process (a stale record not in here was interrupted by a restart)
const actorOf = (u) => (u ? { id: u.id ?? null, name: u.name || u.email || null } : { id: null, name: 'النظام' });
const hash12 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

export async function requirePerm(user, ...needAny) {
  const p = await S.permsFor(user);
  if (!needAny.some((k) => p[k])) throw bad('مفيش عندك صلاحية للعملية دي.', 403, { error: 'FORBIDDEN' });
  return p;
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------
const baseCache = { v: null, get() { return this.v; }, set(x) { this.v = x; } }; // the switchable-account list, 60 s
export async function accountsList({ codes = null } = {}) {
  const cfg = await S.getConfig();
  let list = []; const hit = deps.listAccounts === defaultListAccounts ? baseCache.get() : null;
  if (hit && Date.now() - hit.at < 60_000) list = hit.list.map((a) => ({ ...a }));
  else { try { list = await deps.listAccounts(); if (deps.listAccounts === defaultListAccounts) baseCache.set({ at: Date.now(), list: list.map((a) => ({ ...a })) }); } catch (e) { logger.warn('[adsPayments] accounts read failed', { message: e.message }); } }
  const seen = new Set(list.map((a) => a.id));
  // an account that has codes but dropped out of the switchable list must still be visible (its money history does not vanish)
  for (const c of codes || await S.allCodes()) if (!seen.has(c.accountId)) { seen.add(c.accountId); list.push({ id: c.accountId, name: c.accountName || c.accountId, isPrimary: false, removed: true }); }
  return list.map((a) => ({ ...a, name: cfg.accountNames[a.id] || a.name || a.id })); // an alias the owner typed wins over Meta's name
}
async function accountOrThrow(accountId) {
  if (!validAccountId(accountId)) throw bad('الحساب الإعلاني غير صالح.');
  const a = (await accountsList()).find((x) => x.id === accountId && !x.removed);
  if (!a) throw bad('الحساب الإعلاني ده مش من الحسابات المربوطة بالسيستم.');
  return a;
}
const isExpiredNow = (c, ms) => (c.status === 'UNPAID' || c.status === 'PAY_FAILED') && c.expiresAt && new Date(c.expiresAt).getTime() <= ms;
export async function openCodesOf(accountId, ms = deps.now()) {
  return (await S.allCodes()).filter((c) => c.accountId === accountId && OPEN_STATUSES.includes(c.status) && !isExpiredNow(c, ms));
}
const brief = (c) => ({ id: c.id, code: c.code, amountEgp: c.amountEgp, status: c.status, statusLabel: STATUS_LABEL[c.status], extractedAt: c.extractedAt });

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------
function requireRequestId(v) { const s = String(v || '').trim(); if (!/^[A-Za-z0-9_-]{8,64}$/.test(s)) throw bad('معرّف الطلب مفقود — حدّث الصفحة وجرّب تاني.'); return s; }

/** The warning the screen shows BEFORE a new code is requested for an account that still has an open one. */
export async function extractWarnings({ accountId, amountEgp = null }) {
  const open = await openCodesOf(accountId);
  const ms = deps.now();
  const recent = (await S.allJobs()).filter((j) => j.accountId === accountId && [JOB_STATUS.PENDING, JOB_STATUS.EXTRACTING, JOB_STATUS.DONE, JOB_STATUS.UNCERTAIN].includes(j.status) && ms - new Date(j.createdAt).getTime() < 90_000 && (amountEgp == null || toPi(j.amountEgp) === toPi(amountEgp)));
  return { open: open.map(brief), recentJobs: recent.map((j) => ({ id: j.id, amountEgp: j.amountEgp, status: j.status, at: j.createdAt })) };
}

async function validateExtractInput({ accountId, amountEgp }) {
  const cfg = await S.getConfig();
  const account = await accountOrThrow(accountId);
  const amount = parseAmount(amountEgp, { min: cfg.minAmountEgp, max: cfg.maxAmountEgp });
  return { account, amount, cfg };
}

export async function extractCode(user, { accountId, amountEgp, requestId, acknowledgeExisting = false }) {
  await requirePerm(user, 'extract');
  const rid = requireRequestId(requestId);
  const { account, amount } = await validateExtractInput({ accountId, amountEgp });
  const id = hash12(`x|${accountId}|${amount}|${rid}`);
  // the check + the creation of the job are ONE serialized step per account, so two people clicking at the same moment cannot both pass the «no open / recent code» check
  const made = await serialize('extract:' + accountId, async () => {
    const prior = await S.getJob(id);
    if (prior) return { job: prior, idempotent: true };
    const st = providerStatus().extract;
    if (!st.available) throw bad('استخراج الكود الآلي محتاج ربط رسمي — سجّل الكود يدويًا من Ads Manager.', 409, { error: 'NEEDS_CONNECTION', provider: st });
    const w = await extractWarnings({ accountId, amountEgp: amount });
    if (!acknowledgeExisting && (w.open.length || w.recentJobs.length)) throw bad(w.open.length ? 'فيه كود سابق لنفس الحساب لسه غير مدفوع أو متعلق.' : 'اتطلب كود بنفس المبلغ لنفس الحساب من لحظات.', 409, { error: w.open.length ? 'EXISTING_OPEN_CODES' : 'DUPLICATE_RECENT', warnings: w });
    const job = await S.createJob({ id, batchId: null, accountId, accountName: account.name, amountEgp: amount, status: JOB_STATUS.PENDING, attempt: 0, codeId: null, error: null, requestedBy: actorOf(user), requestedAt: nowIso() });
    if (!job) return { job: await S.getJob(id), idempotent: true };
    await S.audit({ actor: actorOf(user), action: 'EXTRACT_REQUESTED', target: { type: 'job', id }, detail: { accountId, amountEgp: amount, acknowledgedExisting: !!acknowledgeExisting } });
    return { job, idempotent: false };
  });
  if (made.idempotent) return { job: made.job, code: made.job?.codeId ? await S.getCode(made.job.codeId) : null, idempotent: true };
  return runJob(id, user);
}

/** Runs ONE persisted extraction job exactly once. A claim (PENDING→EXTRACTING) is a compare-and-set, so two runners can never both call the provider for it. */
export async function runJob(jobId, user = null) {
  let claimed = false;
  try {
    await S.updateJob(jobId, (j) => { if (j.status !== JOB_STATUS.PENDING) throw bad('already claimed', 409, { skip: true }); j.status = JOB_STATUS.EXTRACTING; j.startedAt = nowIso(); j.attempt = (j.attempt || 0) + 1; claimed = true; return j; });
  } catch (e) { if (!e.skip) throw e; }
  const job = await S.getJob(jobId);
  if (!claimed) return { job, code: job?.codeId ? await S.getCode(job.codeId) : null, skipped: true };
  const ad = adapter('extract');
  inflight.add(jobId);
  let res;
  try {
    if (!ad) throw bad('no provider', 409, { beforeSend: true });
    res = await withTimeout(Promise.resolve(ad.extract({ accountId: job.accountId, amountEgp: job.amountEgp, idempotencyKey: jobId })), EXTRACT_TIMEOUT_MS);
  } catch (err) {
    res = err?.beforeSend ? { outcome: 'FAILED', message: err.message } : { outcome: 'UNCERTAIN', message: err?.timeout ? 'المزود ماردّش في الوقت المناسب.' : `انقطع الاتصال أثناء الاستخراج (${String(err?.message || err).slice(0, 120)})` };
  } finally { inflight.delete(jobId); }
  return settleJob(jobId, res, user, ad?.simulated);
}

async function settleJob(jobId, res, user, simulated) {
  const job = await S.getJob(jobId);
  if (res?.outcome === 'ISSUED' && validCode(res.code)) {
    const id = S.newId();
    try {
      const code = await S.createCode({ id, code: res.code, accountId: job.accountId, accountName: job.accountName, amountEgp: job.amountEgp, status: STATUS.UNPAID, source: simulated ? SOURCE.SIMULATED : SOURCE.PROVIDER, simulated: !!simulated,
        extractedAt: nowIso(), extractedBy: job.requestedBy, expiresAt: res.expiresAt ? new Date(res.expiresAt).toISOString() : null, jobId, payment: null, credit: null, lastCheckedAt: null, reason: null,
        events: [{ at: nowIso(), type: 'EXTRACTED', by: job.requestedBy, note: simulated ? 'استخراج محاكاة' : 'استخراج من المصدر الرسمي' }] });
      const done = await S.updateJob(jobId, (j) => { j.status = JOB_STATUS.DONE; j.codeId = id; j.finishedAt = nowIso(); j.error = null; return j; });
      await S.audit({ actor: job.requestedBy, action: 'CODE_EXTRACTED', target: { type: 'code', id }, detail: { accountId: job.accountId, amountEgp: job.amountEgp, simulated: !!simulated } });
      return { job: done, code };
    } catch (e) {
      const done = await S.updateJob(jobId, (j) => { j.status = JOB_STATUS.UNCERTAIN; j.finishedAt = nowIso(); j.error = e.duplicate ? 'المزود رجّع كود متسجل قبل كده — راجعه.' : `فشل حفظ الكود (${e.message})`; j.providerCode = normalizeCode(res.code); return j; });
      await S.audit({ actor: job.requestedBy, action: 'EXTRACT_SAVE_PROBLEM', target: { type: 'job', id: jobId }, outcome: 'UNCERTAIN', detail: { message: e.message } });
      return { job: done, code: null };
    }
  }
  const status = res?.outcome === 'FAILED' ? JOB_STATUS.FAILED : JOB_STATUS.UNCERTAIN;
  const msg = res?.outcome === 'ISSUED' ? 'رجع كود بصيغة غير صالحة.' : (res?.message || (status === JOB_STATUS.FAILED ? 'فشل الاستخراج.' : 'النتيجة غير مؤكدة.'));
  const done = await S.updateJob(jobId, (j) => { j.status = status; j.finishedAt = nowIso(); j.error = msg; j.rateLimited = !!res?.rateLimited; j.retryAfterMs = res?.retryAfterMs || null; return j; });
  await S.audit({ actor: job.requestedBy, action: 'EXTRACT_RESULT', target: { type: 'job', id: jobId }, outcome: status, detail: { message: msg } });
  return { job: done, code: null };
}

/** A person resolves an UNCERTAIN extraction: attach the code that really was issued, or confirm that nothing was issued. */
export async function resolveJob(user, jobId, { resolution, code = null, expiresAt = null, note = '' }) {
  await requirePerm(user, 'extract');
  const job = await S.getJob(jobId); if (!job) throw bad('العملية مش موجودة.', 404);
  if (job.status !== JOB_STATUS.UNCERTAIN) throw bad('العملية دي مش في حالة «نتيجة غير مؤكدة».', 409);
  if (resolution === 'NOT_ISSUED') {
    if (String(note).trim().length < 3) throw bad('اكتب دليل إن الكود ماتطلعش (مثلًا راجعت Ads Manager).');
    const done = await S.updateJob(jobId, (j) => { j.status = JOB_STATUS.FAILED; j.error = 'اتأكد إن الكود ماتطلعش — ' + String(note).trim().slice(0, 200); j.finishedAt = nowIso(); return j; });
    await S.audit({ actor: actorOf(user), action: 'EXTRACT_RESOLVED_NOT_ISSUED', target: { type: 'job', id: jobId }, detail: { note } });
    return { job: done, code: null };
  }
  if (resolution === 'ATTACH_CODE') {
    if (!validCode(code)) throw bad('رقم الكود غير صالح.');
    const id = S.newId();
    const rec = await S.createCode({ id, code, accountId: job.accountId, accountName: job.accountName, amountEgp: job.amountEgp, status: STATUS.UNPAID, source: SOURCE.MANUAL, simulated: false, extractedAt: job.finishedAt || job.requestedAt, extractedBy: job.requestedBy,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, jobId, payment: null, credit: null, lastCheckedAt: null, reason: null, events: [{ at: nowIso(), type: 'ATTACHED_TO_JOB', by: actorOf(user), note: 'ربط يدوي بعد نتيجة غير مؤكدة' }] });
    const done = await S.updateJob(jobId, (j) => { j.status = JOB_STATUS.DONE; j.codeId = id; j.error = null; return j; });
    await S.audit({ actor: actorOf(user), action: 'EXTRACT_RESOLVED_ATTACHED', target: { type: 'code', id }, detail: { jobId } });
    return { job: done, code: rec };
  }
  throw bad('اختار: ربط الكود أو تأكيد إنه ماتطلعش.');
}

/** MANUAL path: the code was generated in Ads Manager (or anywhere official) and is registered here so it is tracked, de-duplicated and audited. */
export async function registerManualCode(user, { accountId, amountEgp, code, expiresAt = null, extractedAt = null, note = '', acknowledgeExisting = false }) {
  await requirePerm(user, 'extract');
  const { account, amount } = await validateExtractInput({ accountId, amountEgp });
  if (!validCode(code)) throw bad('رقم الكود غير صالح (أرقام/حروف من 5 لـ 24).');
  const ms = deps.now();
  let exp = null; if (expiresAt) { exp = new Date(expiresAt); if (Number.isNaN(exp.getTime())) throw bad('تاريخ الانتهاء غير صالح.'); if (exp.getTime() <= ms) throw bad('تاريخ الانتهاء فات — الكود ده منتهي.'); exp = exp.toISOString(); }
  let ext = nowIso(); if (extractedAt) { const d = new Date(extractedAt); if (Number.isNaN(d.getTime()) || d.getTime() > ms + 60_000) throw bad('وقت الاستخراج غير صالح.'); ext = d.toISOString(); }
  const w = await extractWarnings({ accountId });
  if (!acknowledgeExisting && w.open.length) throw bad('فيه كود سابق لنفس الحساب لسه غير مدفوع أو متعلق.', 409, { error: 'EXISTING_OPEN_CODES', warnings: w });
  const id = S.newId();
  const rec = await S.createCode({ id, code, accountId, accountName: account.name, amountEgp: amount, status: STATUS.UNPAID, source: SOURCE.MANUAL, simulated: false, extractedAt: ext, extractedBy: actorOf(user), expiresAt: exp, jobId: null, payment: null, credit: null, lastCheckedAt: null, reason: null,
    events: [{ at: nowIso(), type: 'REGISTERED_MANUALLY', by: actorOf(user), note: String(note || '').slice(0, 200) || 'تسجيل يدوي لكود من Ads Manager' }] });
  await S.audit({ actor: actorOf(user), action: 'CODE_REGISTERED_MANUALLY', target: { type: 'code', id }, detail: { accountId, amountEgp: amount, hasExpiry: !!exp } });
  return rec;
}

// ---------------------------------------------------------------------------
// bulk extraction
// ---------------------------------------------------------------------------
async function normalizeBulkItems(items) {
  if (!Array.isArray(items) || !items.length) throw bad('اختار حساب واحد على الأقل.');
  if (items.length > 40) throw bad('أقصى عدد 40 كود في الدفعة الواحدة.');
  const seen = new Set(); const out = [];
  for (const it of items) {
    const { account, amount } = await validateExtractInput(it);
    if (seen.has(account.id)) throw bad(`الحساب «${account.name}» مكرر في الدفعة.`);
    seen.add(account.id); out.push({ accountId: account.id, accountName: account.name, amountEgp: amount });
  }
  return out;
}
export async function previewBulkExtract(user, { items }) {
  await requirePerm(user, 'extract');
  const rows = await normalizeBulkItems(items);
  const withWarn = []; for (const r of rows) { const w = await extractWarnings({ accountId: r.accountId }); withWarn.push({ ...r, openCodes: w.open }); }
  return { items: withWarn, count: rows.length, totalEgp: sumEgp(rows.map((r) => r.amountEgp)), warnings: withWarn.filter((r) => r.openCodes.length).length, provider: providerStatus().extract };
}
export async function startBulkExtract(user, { items, requestId, acknowledgeExisting = false }) {
  await requirePerm(user, 'extract');
  const rid = requireRequestId(requestId);
  const rows = await normalizeBulkItems(items);
  const batchId = hash12(`bx|${rid}`);
  const prior = await S.getBatch(batchId); if (prior) return batchView(prior, { idempotent: true });
  const st = providerStatus().extract;
  if (!st.available) throw bad('الاستخراج الجماعي الآلي محتاج ربط رسمي.', 409, { error: 'NEEDS_CONNECTION', provider: st });
  if (!acknowledgeExisting) { for (const r of rows) { const w = await extractWarnings({ accountId: r.accountId, amountEgp: r.amountEgp }); if (w.open.length || w.recentJobs.length) throw bad(`الحساب «${r.accountName}» عليه كود سابق متعلق أو طلب قريب.`, 409, { error: 'EXISTING_OPEN_CODES', warnings: w, accountId: r.accountId }); } }
  const jobs = [];
  for (let i = 0; i < rows.length; i++) {
    const jid = hash12(`bxj|${batchId}|${i}`);
    await S.createJob({ id: jid, batchId, accountId: rows[i].accountId, accountName: rows[i].accountName, amountEgp: rows[i].amountEgp, status: JOB_STATUS.PENDING, attempt: 0, codeId: null, error: null, requestedBy: actorOf(user), requestedAt: nowIso() });
    jobs.push(jid);
  }
  const batch = await S.createBatch({ id: batchId, type: 'EXTRACT', status: 'RUNNING', jobIds: jobs, createdBy: actorOf(user), totalEgp: sumEgp(rows.map((r) => r.amountEgp)) });
  await S.audit({ actor: actorOf(user), action: 'BULK_EXTRACT_STARTED', target: { type: 'batch', id: batchId }, detail: { count: rows.length, totalEgp: batch.totalEgp } });
  runExtractBatch(batchId, user).catch((e) => logger.error('[adsPayments] bulk extract runner crashed', { message: e.message }));
  return batchView(batch);
}
const runningBatches = new Set();
export async function runExtractBatch(batchId, user = null, { awaitRun = false } = {}) {
  if (runningBatches.has(batchId)) return;
  runningBatches.add(batchId);
  const work = (async () => {
    try {
      const cfg = await S.getConfig();
      const batch = await S.getBatch(batchId); if (!batch) return;
      await S.updateBatch(batchId, (b) => { b.status = 'RUNNING'; return b; });
      let first = true;
      for (const jid of batch.jobIds) {
        let job = await S.getJob(jid); if (!job || job.status !== JOB_STATUS.PENDING) continue;
        if (!first && cfg.extractGapMs) await deps.sleep(cfg.extractGapMs); first = false;
        let r = await runJob(jid, user);
        for (let tries = 0; r.job?.status === JOB_STATUS.FAILED && r.job.rateLimited && tries < 2; tries++) { // the provider said «rate limited» = nothing was issued: wait and ask the SAME job again
          await deps.sleep(Math.min(60_000, r.job.retryAfterMs || cfg.extractGapMs * 4 || 5000));
          await S.updateJob(jid, (j) => { if (j.status !== JOB_STATUS.FAILED) return undefined; j.status = JOB_STATUS.PENDING; return j; });
          r = await runJob(jid, user);
        }
      }
      await S.updateBatch(batchId, (b) => { b.status = 'DONE'; b.finishedAt = nowIso(); return b; });
    } finally { runningBatches.delete(batchId); }
  })();
  if (awaitRun) await work; else work.catch(() => {});
  return work;
}
export async function resumeExtractBatch(user, batchId) {
  await requirePerm(user, 'extract');
  const b = await S.getBatch(batchId); if (!b || b.type !== 'EXTRACT') throw bad('الدفعة مش موجودة.', 404);
  const jobs = await Promise.all(b.jobIds.map((id) => S.getJob(id)));
  if (jobs.some((j) => j?.status === JOB_STATUS.UNCERTAIN)) throw bad('فيه عملية «نتيجة غير مؤكدة» — حلّها الأول قبل ما تكمّل.', 409);
  runExtractBatch(batchId, user).catch(() => {});
  return batchView(await S.getBatch(batchId));
}

async function batchView(batch, extra = {}) {
  if (!batch) return null;
  if (batch.type === 'EXTRACT') {
    const jobs = (await Promise.all(batch.jobIds.map((id) => S.getJob(id)))).filter(Boolean);
    const count = (s) => jobs.filter((j) => j.status === s).length;
    return { ...extra, ...batch, items: jobs.map((j) => ({ jobId: j.id, accountId: j.accountId, accountName: j.accountName, amountEgp: j.amountEgp, status: j.status, codeId: j.codeId, error: j.error })), counts: { pending: count('PENDING'), extracting: count('EXTRACTING'), done: count('DONE'), failed: count('FAILED'), uncertain: count('UNCERTAIN') } };
  }
  const items = batch.items || []; const count = (s) => items.filter((i) => i.status === s).length;
  return { ...extra, ...batch, counts: { pending: count('PENDING'), paying: count('PAYING'), paid: count('PAID'), failed: count('FAILED'), uncertain: count('UNCERTAIN'), skipped: count('SKIPPED') } };
}
export async function getBatchView(id) { return batchView(await S.getBatch(id)); }
export async function listBatchViews() { return Promise.all((await S.allBatches()).slice(0, 20).map((b) => batchView(b))); }

// ---------------------------------------------------------------------------
// payment
// ---------------------------------------------------------------------------
const claimChains = new Map();
const serialize = (key, fn) => { const prev = claimChains.get(key) || Promise.resolve(); const run = prev.catch(() => {}).then(fn); claimChains.set(key, run.catch(() => {})); return run; };

async function methodOrThrow(methodId) {
  const m = (await S.listMethods()).find((x) => x.id === methodId);
  if (!m) throw bad('اختار وسيلة الدفع.');
  if (!m.active) throw bad('وسيلة الدفع دي متوقفة.');
  return m;
}
export async function paidTodayBy(userId, ms = deps.now()) {
  const day = cairoDay(ms);
  const codes = await S.allCodes();
  return sumEgp(codes.filter((c) => c.payment?.paidBy?.id === userId && c.payment.paidAt && cairoDay(new Date(c.payment.paidAt).getTime()) === day).map((c) => c.payment.totalEgp)
    .concat(codes.filter((c) => c.status === STATUS.PAYING && c.payment?.startedBy?.id === userId && c.payment.startedAt && cairoDay(new Date(c.payment.startedAt).getTime()) === day).map((c) => c.payment.totalEgp || c.amountEgp)));
}
async function dailyLimitCheck(user, addEgp, cfg) {
  const lim = cfg.dailyLimits?.[String(user?.id)];
  if (lim == null) return;
  const used = await paidTodayBy(user.id);
  if (toPi(used) + toPi(addEgp) > toPi(lim)) throw bad(`ده هيعدّي حدك اليومي للدفع (${lim.toLocaleString('en-US')} ج — اتدفع النهارده ${used.toLocaleString('en-US')} ج).`, 403, { error: 'DAILY_LIMIT', limitEgp: lim, usedEgp: used });
}

export async function quotePay(user, codeId, methodId) {
  await requirePerm(user, 'pay', 'bulkPay');
  const code = await S.getCode(codeId); if (!code) throw bad('الكود مش موجود.', 404);
  const method = await methodOrThrow(methodId);
  const fee = S.feeFor(method, code.amountEgp);
  const total = sumEgp([code.amountEgp, fee]);
  const st = providerStatus().pay;
  return { code: { ...brief(code), accountId: code.accountId, accountName: code.accountName, expiresAt: code.expiresAt }, method: { id: method.id, label: method.label, type: method.type, maskedRef: method.maskedRef, balanceEgp: method.balanceEgp, balanceSource: method.balanceSource }, amountEgp: code.amountEgp, feeEgp: fee, feeSource: 'CONFIG', totalEgp: total,
    sufficient: method.balanceEgp == null ? null : toPi(method.balanceEgp) >= toPi(total), directPay: st.available, provider: st, payable: PAYABLE.includes(code.status) && !isExpiredNow(code, deps.now()) };
}

/** Atomically moves UNPAID/PAY_FAILED → PAYING (the single winner of a race), stamping the attempt. */
async function claimPayment(code, user, method, { requestId, fee, total, kind }) {
  return serialize(`claim:${user?.id}`, async () => {
    const cfg = await S.getConfig();
    await dailyLimitCheck(user, total, cfg);
    let dupNote = false;
    try {
      return await S.updateCode(code.id, (c) => {
        const seen = (c.payment?.attempts || []).find((a) => a.requestId === requestId);
        if (seen) throw bad('الطلب ده اتنفذ قبل كده.', 409, { error: 'DUPLICATE_REQUEST', replay: true });
        if (c.status === STATUS.PAYING) { dupNote = true; throw bad('الكود ده جاري دفعه دلوقتي — استنى النتيجة.', 409, { error: 'ALREADY_PAYING' }); }
        if (c.status === STATUS.UNCERTAIN) throw bad('آخر محاولة دفع للكود ده نتيجتها غير مؤكدة — لازم تتطابق الأول قبل أي محاولة جديدة.', 409, { error: 'UNCERTAIN_BLOCKS_RETRY' });
        if (c.status === STATUS.PAID || c.status === STATUS.CREDITED) { dupNote = true; throw bad('الكود ده مدفوع بالفعل.', 409, { error: 'ALREADY_PAID' }); }
        if (!PAYABLE.includes(c.status)) throw bad(`الكود في حالة «${STATUS_LABEL[c.status]}» — مينفعش يتدفع.`, 409, { error: 'NOT_PAYABLE' });
        if (isExpiredNow(c, deps.now())) throw bad('الكود انتهت صلاحيته.', 409, { error: 'EXPIRED' });
        const n = (c.payment?.attempts?.length || 0) + 1;
        c.status = STATUS.PAYING;
        c.payment = { ...(c.payment || {}), methodId: method.id, methodLabel: method.label, methodType: method.type, startedAt: nowIso(), startedBy: actorOf(user), feeEgp: fee, totalEgp: total, kind, attemptNo: n, idempotencyKey: `pay-${c.id}-${n}`,
          attempts: [...(c.payment?.attempts || []), { requestId, at: nowIso(), by: actorOf(user), attemptNo: n, outcome: 'STARTED' }] };
        S.pushEvent(c, 'PAY_STARTED', actorOf(user), `${method.label} — ${total} ج`);
        return c;
      });
    } catch (e) {
      if (dupNote) { await S.updateCode(code.id, (c) => { S.pushEvent(c, 'DUP_PAY_BLOCKED', actorOf(user), e.message); return c; }).catch(() => {}); await S.audit({ actor: actorOf(user), action: 'PAY_DUPLICATE_BLOCKED', target: { type: 'code', id: code.id }, outcome: 'BLOCKED', detail: { reason: e.error } }); }
      throw e;
    }
  });
}

async function settlePayment(codeId, attemptNo, res, user, method, { simulated = false } = {}) {
  const apply = (c) => {
    if (c.status !== STATUS.PAYING || c.payment?.attemptNo !== attemptNo) return undefined; // already settled by the follow-up / a person: never overwrite
    const p = c.payment; const by = actorOf(user);
    const att = p.attempts.find((a) => a.attemptNo === attemptNo);
    if (res.outcome === 'CONFIRMED') {
      const fee = res.feeEgp != null ? Number(res.feeEgp) : p.feeEgp;
      c.payment = { ...p, feeEgp: fee, totalEgp: sumEgp([c.amountEgp, fee]), paidAt: res.paidAt || nowIso(), paidBy: p.startedBy || by, txnRef: res.txnRef || null, receipt: res.receipt || null, paymentSource: simulated ? 'SIMULATED' : (res.manual ? 'MANUAL' : 'PROVIDER'), confirmedAmountEgp: res.amountEgp ?? c.amountEgp };
      if (att) att.outcome = 'CONFIRMED';
      if (res.amountEgp != null && toPi(res.amountEgp) !== toPi(c.amountEgp)) { c.status = STATUS.REVIEW; c.reason = 'AMOUNT_MISMATCH'; S.pushEvent(c, 'AMOUNT_MISMATCH', by, `المبلغ المدفوع ${res.amountEgp} ج يختلف عن قيمة الكود ${c.amountEgp} ج`); }
      else { c.status = STATUS.PAID; c.reason = null; S.pushEvent(c, 'PAID', by, `${p.methodLabel} — عملية ${res.txnRef || '—'}`); }
    } else if (res.outcome === 'FAILED') {
      c.status = STATUS.PAY_FAILED; c.reason = res.message || 'فشل الدفع'; if (att) att.outcome = 'FAILED'; c.payment = { ...p, failedAt: nowIso(), failMessage: c.reason };
      S.pushEvent(c, 'PAY_FAILED', by, c.reason);
    } else {
      c.status = STATUS.UNCERTAIN; c.reason = res.message || 'نتيجة الدفع غير مؤكدة'; if (att) att.outcome = 'UNCERTAIN'; c.payment = { ...p, uncertainAt: nowIso() };
      S.pushEvent(c, 'PAY_UNCERTAIN', by, c.reason);
    }
    return c;
  };
  const code = await S.updateCode(codeId, apply);
  if (res.outcome === 'CONFIRMED' && simulated) await S.debitMethodBalance(method.id, code.payment?.totalEgp ?? code.amountEgp).catch(() => null);
  await S.audit({ actor: actorOf(user), action: 'PAY_RESULT', target: { type: 'code', id: codeId }, outcome: res.outcome, detail: { methodId: method.id, totalEgp: code.payment?.totalEgp, txnRef: code.payment?.txnRef || null } });
  return code;
}

/** DIRECT payment through the payment adapter. Needs the explicit confirmation the screen collected and the exact total the user saw. */
export async function payCode(user, codeId, { methodId, requestId, confirm = false, expectedTotalEgp = null }) {
  await requirePerm(user, 'pay');
  if (confirm !== true) throw bad('لازم تأكيد صريح قبل الدفع.', 400, { error: 'CONFIRM_REQUIRED' });
  const rid = requireRequestId(requestId);
  const st = providerStatus().pay;
  if (!st.available) throw bad('الدفع المباشر محتاج ربط رسمي — ادفع من فوري/محفظتك وسجّل العملية يدويًا.', 409, { error: 'NEEDS_CONNECTION', provider: st });
  const code = await S.getCode(codeId); if (!code) throw bad('الكود مش موجود.', 404);
  const method = await methodOrThrow(methodId);
  const fee = S.feeFor(method, code.amountEgp); const total = sumEgp([code.amountEgp, fee]);
  if (expectedTotalEgp == null || toPi(expectedTotalEgp) !== toPi(total)) throw bad(`الإجمالي اتغيّر (${total} ج) — راجع وأكّد تاني.`, 409, { error: 'QUOTE_CHANGED', totalEgp: total });
  if (method.balanceEgp != null && toPi(method.balanceEgp) < toPi(total)) throw bad(`رصيد «${method.label}» (${method.balanceEgp} ج) مش كافي للدفع (${total} ج).`, 409, { error: 'INSUFFICIENT_FUNDS' });
  // the balance BEFORE the payment (a hint for the credit follow-up) is read first, with a short time limit: a slow Meta must never leave a code stuck in «جاري الدفع»
  let before = null; try { before = (await withTimeout(Promise.resolve(deps.getFunds(code.accountId)), 3000))?.available ?? null; } catch { /* the hint is optional */ }
  const claimed = await claimPayment(code, user, method, { requestId: rid, fee, total, kind: 'DIRECT' });
  await audit0(user, 'PAY_STARTED', codeId, { methodId, totalEgp: total });
  const ad = adapter('pay');
  if (before != null) await S.updateCode(codeId, (c) => { c.creditWatch = { balanceBeforeEgp: before, at: nowIso() }; return c; }).catch(() => {});
  inflight.add(codeId);
  let res;
  try {
    res = await withTimeout(Promise.resolve(ad.pay({ code: claimed.code, amountEgp: claimed.amountEgp, method, idempotencyKey: claimed.payment.idempotencyKey })), PAY_TIMEOUT_MS);
    if (!res || !['CONFIRMED', 'FAILED', 'UNCERTAIN'].includes(res.outcome)) res = { outcome: 'UNCERTAIN', message: 'رد غير مفهوم من مزود الدفع.' };
  } catch (err) {
    res = err?.beforeSend ? { outcome: 'FAILED', message: err.message } : { outcome: 'UNCERTAIN', message: err?.timeout ? 'مزود الدفع ماردّش في الوقت المناسب — ممكن الخصم حصل.' : `انقطع الاتصال أثناء الدفع — ممكن الخصم حصل (${String(err?.message || err).slice(0, 100)}).` };
  } finally { inflight.delete(codeId); }
  return settlePayment(codeId, claimed.payment.attemptNo, res, user, method, { simulated: !!ad.simulated });
}
const audit0 = (user, action, codeId, detail) => S.audit({ actor: actorOf(user), action, target: { type: 'code', id: codeId }, detail });

/** MANUAL path: the payment was made outside (Fawry app / a wallet / a branch). A named person records the real transaction number + receipt; the system treats it as an attested payment. */
export async function recordManualPayment(user, codeId, { methodId, txnRef, receiptRef = '', receiptNote = '', paidAt = null, feeEgp = null, amountPaidEgp = null, requestId }) {
  await requirePerm(user, 'pay');
  const rid = requireRequestId(requestId);
  const ref = String(txnRef || '').trim(); if (ref.length < 4 || ref.length > 60) throw bad('رقم العملية مطلوب (4 حروف/أرقام على الأقل).');
  const code = await S.getCode(codeId); if (!code) throw bad('الكود مش موجود.', 404);
  const method = await methodOrThrow(methodId);
  let when = nowIso(); if (paidAt) { const d = new Date(paidAt); if (Number.isNaN(d.getTime()) || d.getTime() > deps.now() + 60_000) throw bad('وقت الدفع غير صالح.'); when = d.toISOString(); }
  const fee = feeEgp == null || feeEgp === '' ? S.feeFor(method, code.amountEgp) : Number(feeEgp); if (!Number.isFinite(fee) || fee < 0 || fee > 10000) throw bad('الرسوم غير صالحة.');
  const total = sumEgp([code.amountEgp, fee]);
  const dup = (await S.allCodes()).find((c) => c.id !== codeId && c.payment?.txnRef && c.payment.txnRef === ref);
  if (dup) throw bad('رقم العملية ده مسجل على كود تاني — مينفعش يتسجل مرتين.', 409, { error: 'TXN_REUSED' });
  const claimed = await claimPayment(code, user, method, { requestId: rid, fee, total, kind: 'MANUAL' });
  const amt = amountPaidEgp == null || amountPaidEgp === '' ? code.amountEgp : Number(amountPaidEgp);
  const res = { outcome: 'CONFIRMED', manual: true, txnRef: ref, receipt: { number: String(receiptRef || '').trim().slice(0, 60) || null, note: String(receiptNote || '').trim().slice(0, 300) || null }, paidAt: when, feeEgp: fee, amountEgp: amt };
  return settlePayment(codeId, claimed.payment.attemptNo, res, user, method);
}

/** A PAYING / UNCERTAIN payment is looked up at the source; a person with evidence can resolve what the source cannot. Never a blind retry. */
export async function reconcilePayment(user, codeId, { resolution = null, txnRef = '', evidence = '', paidAt = null, receiptRef = '' } = {}) {
  await requirePerm(user, 'pay');
  const code = await S.getCode(codeId); if (!code) throw bad('الكود مش موجود.', 404);
  if (![STATUS.UNCERTAIN, STATUS.PAYING].includes(code.status)) throw bad('الكود ده مش في حالة تحتاج مطابقة.', 409);
  const by = actorOf(user);
  let outcome = null; let info = {};
  if (!resolution) {
    const ad = adapter('pay');
    if (!ad?.queryPayment) throw bad('المزود مش متاح للاستعلام — راجع كشف الحساب وسجّل القرار يدويًا مع دليل.', 409, { error: 'NEEDS_EVIDENCE' });
    let q; try { q = await withTimeout(Promise.resolve(ad.queryPayment({ code: code.code, idempotencyKey: code.payment?.idempotencyKey, txnRef: code.payment?.txnRef })), 30_000); } catch { q = { outcome: 'UNKNOWN' }; }
    if (q.outcome === 'CONFIRMED') { outcome = 'PAID'; info = { txnRef: q.txnRef, receipt: q.receipt, paidAt: q.paidAt }; } else if (q.outcome === 'NOT_PAID') outcome = 'NOT_PAID';
    else throw bad('المصدر مقدرش يأكد النتيجة — راجع كشف الحساب وسجّل القرار يدويًا مع دليل.', 409, { error: 'NEEDS_EVIDENCE' });
  } else {
    if (String(evidence).trim().length < 4) throw bad('اكتب الدليل (مثلًا: رقم العملية في كشف الحساب أو إن الخصم ماحصلش).');
    if (resolution === 'PAID') { if (String(txnRef).trim().length < 4) throw bad('رقم العملية مطلوب لتأكيد الدفع.'); outcome = 'PAID'; info = { txnRef: String(txnRef).trim(), receipt: { number: String(receiptRef || '').trim() || null, note: 'مطابقة يدوية' }, paidAt: paidAt ? new Date(paidAt).toISOString() : nowIso() }; }
    else if (resolution === 'NOT_PAID') outcome = 'NOT_PAID'; else throw bad('القرار غير صالح.');
  }
  const done = await S.updateCode(codeId, (c) => {
    if (![STATUS.UNCERTAIN, STATUS.PAYING].includes(c.status)) throw bad('الحالة اتغيّرت.', 409);
    if (outcome === 'PAID') { c.status = STATUS.PAID; c.reason = null; c.payment = { ...c.payment, txnRef: info.txnRef || null, receipt: info.receipt || null, paidAt: info.paidAt || nowIso(), paidBy: c.payment?.startedBy || by, paymentSource: 'MANUAL', reconciledBy: by }; S.pushEvent(c, 'RECONCILED_PAID', by, evidence || 'تأكيد من المصدر'); }
    else { c.status = STATUS.UNPAID; c.reason = null; c.payment = { ...c.payment, reconciledNotPaidAt: nowIso(), reconciledBy: by }; S.pushEvent(c, 'RECONCILED_NOT_PAID', by, evidence || 'تأكيد من المصدر إن مفيش خصم'); }
    return c;
  });
  await S.audit({ actor: by, action: 'PAY_RECONCILED', target: { type: 'code', id: codeId }, detail: { outcome } });
  return done;
}

/** «مسمّع بنجاح» — only with a trusted confirmation. The manual one names the person and keeps the evidence. */
export async function confirmCredit(user, codeId, { evidence = '', at = null } = {}) {
  await requirePerm(user, 'pay', 'reports');
  if (String(evidence).trim().length < 4) throw bad('اكتب دليل التسميع (مثلًا: رقم المعاملة في Ads Manager ← الفوترة).');
  const by = actorOf(user);
  let when = nowIso(); if (at) { const d = new Date(at); if (Number.isNaN(d.getTime()) || d.getTime() > deps.now() + 60_000) throw bad('وقت التسميع غير صالح.'); when = d.toISOString(); }
  const done = await S.updateCode(codeId, (c) => {
    if (![STATUS.PAID, STATUS.REVIEW].includes(c.status) || !c.payment?.paidAt) throw bad('التسميع بيتأكد بس على كود مدفوع.', 409);
    if (new Date(when).getTime() < new Date(c.payment.paidAt).getTime()) throw bad('وقت التسميع لا يمكن أن يسبق وقت الدفع.');
    c.status = STATUS.CREDITED; c.reason = null; c.credit = { at: when, source: 'MANUAL', evidence: String(evidence).trim().slice(0, 300), by, amountEgp: c.amountEgp };
    S.pushEvent(c, 'CREDITED', by, 'تأكيد يدوي: ' + String(evidence).trim().slice(0, 120)); return c;
  });
  await S.audit({ actor: by, action: 'CREDIT_CONFIRMED_MANUALLY', target: { type: 'code', id: codeId }, detail: { at: when } });
  return done;
}

export async function cancelCode(user, codeId, { note = '' } = {}) {
  await requirePerm(user, 'extract', 'pay');
  const by = actorOf(user);
  const done = await S.updateCode(codeId, (c) => {
    if (![STATUS.UNPAID, STATUS.PAY_FAILED].includes(c.status)) throw bad('الكود ده مينفعش يتلغى في حالته الحالية.', 409);
    c.status = STATUS.EXPIRED; c.reason = 'CANCELLED'; S.pushEvent(c, 'CANCELLED', by, String(note || '').slice(0, 200) || 'اتلغى يدويًا'); return c;
  });
  await S.audit({ actor: by, action: 'CODE_CANCELLED', target: { type: 'code', id: codeId }, detail: { note } });
  return done;
}
export async function flagReview(user, codeId, { note = '' } = {}) {
  await requirePerm(user, 'extract', 'pay', 'reports');
  if (String(note).trim().length < 3) throw bad('اكتب سبب المراجعة.');
  const by = actorOf(user);
  const done = await S.updateCode(codeId, (c) => {
    if ([STATUS.CREDITED, STATUS.EXPIRED, STATUS.PAYING].includes(c.status)) throw bad('الكود ده مينفعش يتحول للمراجعة في حالته الحالية.', 409);
    c.status = STATUS.REVIEW; c.reason = 'MANUAL_REVIEW'; S.pushEvent(c, 'FLAGGED_REVIEW', by, String(note).trim().slice(0, 200)); return c;
  });
  await S.audit({ actor: by, action: 'CODE_FLAGGED_REVIEW', target: { type: 'code', id: codeId }, detail: { note } });
  return done;
}

// ---------------------------------------------------------------------------
// bulk payment
// ---------------------------------------------------------------------------
export async function previewBulkPay(user, { codeIds, methodId }) {
  await requirePerm(user, 'bulkPay');
  if (!Array.isArray(codeIds) || !codeIds.length) throw bad('اختار كود واحد على الأقل.');
  if (codeIds.length > 40) throw bad('أقصى عدد 40 كود في الدفعة الواحدة.');
  if (new Set(codeIds).size !== codeIds.length) throw bad('فيه كود مكرر في الاختيار.');
  const method = await methodOrThrow(methodId);
  const ms = deps.now(); const rows = [];
  for (const id of codeIds) {
    const c = await S.getCode(id); if (!c) throw bad('كود مش موجود في الاختيار.', 404);
    const fee = S.feeFor(method, c.amountEgp); const eligible = PAYABLE.includes(c.status) && !isExpiredNow(c, ms);
    rows.push({ codeId: c.id, code: c.code, accountId: c.accountId, accountName: c.accountName, amountEgp: c.amountEgp, feeEgp: fee, totalEgp: sumEgp([c.amountEgp, fee]), status: c.status, eligible, reason: eligible ? null : (isExpiredNow(c, ms) ? 'منتهي الصلاحية' : `حالته «${STATUS_LABEL[c.status]}»`) });
  }
  const ok = rows.filter((r) => r.eligible);
  const totals = { count: ok.length, amountEgp: sumEgp(ok.map((r) => r.amountEgp)), feesEgp: sumEgp(ok.map((r) => r.feeEgp)), totalEgp: sumEgp(ok.map((r) => r.totalEgp)) };
  const st = providerStatus().pay;
  return { items: rows, totals, accounts: [...new Set(ok.map((r) => r.accountName))], method: { id: method.id, label: method.label, type: method.type, balanceEgp: method.balanceEgp }, sufficient: method.balanceEgp == null ? null : toPi(method.balanceEgp) >= toPi(totals.totalEgp), directPay: st.available, provider: st };
}
export async function startBulkPay(user, { codeIds, methodId, requestId, confirm = false, expectedTotalEgp = null }) {
  const p = await S.permsFor(user); if (!p.bulkPay || !p.pay) throw bad('الدفع الجماعي محتاج صلاحيتي «الدفع الجماعي» و«تنفيذ الدفع» معًا.', 403, { error: 'FORBIDDEN' });
  if (confirm !== true) throw bad('لازم موافقة صريحة قبل الدفع الجماعي.', 400, { error: 'CONFIRM_REQUIRED' });
  const rid = requireRequestId(requestId);
  const batchId = hash12(`bp|${rid}`);
  const prior = await S.getBatch(batchId); if (prior) return batchView(prior, { idempotent: true });
  const st = providerStatus().pay;
  if (!st.available) throw bad('الدفع الجماعي محتاج ربط رسمي مع مزود الدفع — استخدم تسجيل الدفع اليدوي لكل كود.', 409, { error: 'NEEDS_CONNECTION', provider: st });
  const pv = await previewBulkPay(user, { codeIds, methodId });
  if (pv.items.some((r) => !r.eligible)) throw bad('فيه كود في الاختيار مش قابل للدفع — راجع المعاينة.', 409, { error: 'NOT_ALL_PAYABLE', items: pv.items.filter((r) => !r.eligible) });
  if (expectedTotalEgp == null || toPi(expectedTotalEgp) !== toPi(pv.totals.totalEgp)) throw bad(`الإجمالي اتغيّر (${pv.totals.totalEgp} ج) — راجع وأكّد تاني.`, 409, { error: 'QUOTE_CHANGED', totalEgp: pv.totals.totalEgp });
  if (pv.sufficient === false) throw bad(`رصيد الوسيلة (${pv.method.balanceEgp} ج) مش كافي للإجمالي (${pv.totals.totalEgp} ج).`, 409, { error: 'INSUFFICIENT_FUNDS' });
  await dailyLimitCheck(user, pv.totals.totalEgp, await S.getConfig());
  const items = pv.items.map((r) => ({ codeId: r.codeId, code: r.code, accountName: r.accountName, amountEgp: r.amountEgp, feeEgp: r.feeEgp, totalEgp: r.totalEgp, status: 'PENDING', error: null, txnRef: null }));
  const batch = await S.createBatch({ id: batchId, type: 'PAY', status: 'RUNNING', methodId, methodLabel: pv.method.label, items, totals: pv.totals, createdBy: actorOf(user) });
  await S.audit({ actor: actorOf(user), action: 'BULK_PAY_STARTED', target: { type: 'batch', id: batchId }, detail: { count: items.length, totalEgp: pv.totals.totalEgp, methodId } });
  runPayBatch(batchId, user).catch((e) => logger.error('[adsPayments] bulk pay runner crashed', { message: e.message }));
  return batchView(batch);
}
export async function runPayBatch(batchId, user, { awaitRun = false } = {}) {
  if (runningBatches.has(batchId)) return;
  runningBatches.add(batchId);
  const work = (async () => {
    try {
      const b0 = await S.getBatch(batchId); if (!b0) return;
      await S.updateBatch(batchId, (b) => { b.status = 'RUNNING'; return b; });
      for (let i = 0; i < b0.items.length; i++) {
        const cur = (await S.getBatch(batchId)).items[i]; if (cur.status !== 'PENDING') continue;
        await S.updateBatch(batchId, (b) => { b.items[i].status = 'PAYING'; return b; });
        let outcome = 'FAILED'; let err = null; let txn = null;
        try {
          const done = await payCode(user, cur.codeId, { methodId: b0.methodId, requestId: `${batchId}${i}`.padEnd(8, 'x'), confirm: true, expectedTotalEgp: cur.totalEgp });
          outcome = done.status === STATUS.PAID || done.status === STATUS.CREDITED ? 'PAID' : done.status === STATUS.UNCERTAIN ? 'UNCERTAIN' : done.status === STATUS.REVIEW ? 'PAID' : 'FAILED'; txn = done.payment?.txnRef || null; err = done.reason || null;
        } catch (e) { outcome = e.error === 'DAILY_LIMIT' || e.error === 'INSUFFICIENT_FUNDS' ? 'SKIPPED' : 'FAILED'; err = e.message; if (outcome === 'SKIPPED') { await S.updateBatch(batchId, (b) => { b.items[i].status = 'SKIPPED'; b.items[i].error = err; return b; }); break; } }
        await S.updateBatch(batchId, (b) => { b.items[i].status = outcome; b.items[i].error = err; b.items[i].txnRef = txn; return b; });
        if (outcome === 'UNCERTAIN') { await S.updateBatch(batchId, (b) => { b.status = 'STOPPED_UNCERTAIN'; return b; }); await S.audit({ actor: actorOf(user), action: 'BULK_PAY_STOPPED', target: { type: 'batch', id: batchId }, outcome: 'UNCERTAIN' }); return; } // never charge the rest while a result is unknown
      }
      await S.updateBatch(batchId, (b) => { const open = b.items.some((x) => x.status === 'PENDING'); b.status = open ? 'STOPPED' : 'DONE'; b.finishedAt = nowIso(); return b; });
    } finally { runningBatches.delete(batchId); }
  })();
  if (awaitRun) await work; else work.catch(() => {});
  return work;
}
export async function resumePayBatch(user, batchId) {
  await requirePerm(user, 'bulkPay');
  const b = await S.getBatch(batchId); if (!b || b.type !== 'PAY') throw bad('الدفعة مش موجودة.', 404);
  if (b.items.some((i) => i.status === 'UNCERTAIN')) throw bad('فيه كود «نتيجة غير مؤكدة» — طابقه الأول قبل ما تكمّل.', 409);
  runPayBatch(batchId, user).catch(() => {});
  return batchView(await S.getBatch(batchId));
}

// ---------------------------------------------------------------------------
// follow-up (background) — runs every few minutes and survives a restart because everything it needs is in the records
// ---------------------------------------------------------------------------
export async function monitorTick({ now = deps.now() } = {}) {
  const state = await S.getMonitorState();
  const out = { expired: 0, interrupted: 0, reconciled: 0, credited: 0, checked: 0, skipped: null };
  if (state.backoffUntil && new Date(state.backoffUntil).getTime() > now) { out.skipped = 'BACKOFF'; return out; }
  const cfg = await S.getConfig();
  try {
    // 1. interrupted work (a restart in the middle): never retried, only marked UNCERTAIN
    for (const j of await S.allJobs()) {
      if (j.status === JOB_STATUS.EXTRACTING && !inflight.has(j.id) && now - new Date(j.startedAt || j.createdAt).getTime() > STALE_EXTRACT_MS) {
        await S.updateJob(j.id, (x) => { if (x.status !== JOB_STATUS.EXTRACTING) return undefined; x.status = JOB_STATUS.UNCERTAIN; x.error = 'السيرفر وقف أثناء الاستخراج — ممكن الكود يكون اتطلّع. راجع Ads Manager قبل أي محاولة جديدة.'; x.finishedAt = nowIso(); return x; }).catch(() => {}); out.interrupted++;
      }
    }
    const codes = await S.allCodes();
    for (const c of codes) {
      if (c.status === STATUS.PAYING && !inflight.has(c.id) && now - new Date(c.payment?.startedAt || c.updatedAt).getTime() > STALE_PAY_MS) {
        await S.updateCode(c.id, (x) => { if (x.status !== STATUS.PAYING) return undefined; x.status = STATUS.UNCERTAIN; x.reason = 'انقطاع أثناء الدفع — ممكن الخصم حصل'; S.pushEvent(x, 'PAY_INTERRUPTED', null, x.reason); return x; }).catch(() => {}); out.interrupted++;
      }
    }
    for (const b of (await S.allBatches()).filter((x) => x.status === 'RUNNING' && !runningBatches.has(x.id) && now - new Date(x.updatedAt).getTime() > STALE_PAY_MS)) { // a live run touches its batch on every item, so only a batch silent for minutes was cut off by a restart
      await S.updateBatch(b.id, (x) => { x.status = 'INTERRUPTED'; if (x.items) x.items.forEach((i) => { if (i.status === 'PAYING') i.status = 'UNCERTAIN'; }); return x; }).catch(() => {});
      if (b.jobIds) for (const jid of b.jobIds) { const j = await S.getJob(jid); if (j?.status === JOB_STATUS.EXTRACTING && !inflight.has(jid)) await S.updateJob(jid, (x) => { x.status = JOB_STATUS.UNCERTAIN; x.error = 'السيرفر وقف أثناء الاستخراج.'; return x; }).catch(() => {}); }
    }
    // 2. expiry (a PAID code can never expire — the money already moved)
    for (const c of codes) {
      if (isExpiredNow(c, now)) { await S.updateCode(c.id, (x) => { if (!isExpiredNow(x, now)) return undefined; x.status = STATUS.EXPIRED; x.reason = 'EXPIRED'; S.pushEvent(x, 'EXPIRED', null, 'انتهت الصلاحية'); return x; }).catch(() => {}); out.expired++; }
    }
    // 3. UNCERTAIN payments: ask the source (read only). 4. PAID codes: ask whether Meta credited them.
    const payAd = adapter('pay'); const creditAd = adapter('credit');
    for (const c of (await S.allCodes())) {
      if (c.status === STATUS.UNCERTAIN && c.payment && payAd?.queryPayment) {
        try {
          const q = await withTimeout(Promise.resolve(payAd.queryPayment({ code: c.code, idempotencyKey: c.payment.idempotencyKey, txnRef: c.payment.txnRef })), 30_000); out.checked++;
          if (q?.outcome === 'CONFIRMED') { await S.updateCode(c.id, (x) => { if (x.status !== STATUS.UNCERTAIN) return undefined; x.status = STATUS.PAID; x.reason = null; x.lastCheckedAt = nowIso(); x.payment = { ...x.payment, txnRef: q.txnRef || x.payment.txnRef, receipt: q.receipt || x.payment.receipt, paidAt: q.paidAt || nowIso(), paidBy: x.payment.startedBy, paymentSource: 'PROVIDER' }; S.pushEvent(x, 'RECONCILED_PAID', null, 'تأكيد من المزود في المتابعة التلقائية'); return x; }); out.reconciled++; }
          else if (q?.outcome === 'NOT_PAID') { await S.updateCode(c.id, (x) => { if (x.status !== STATUS.UNCERTAIN) return undefined; x.status = STATUS.UNPAID; x.reason = null; x.lastCheckedAt = nowIso(); S.pushEvent(x, 'RECONCILED_NOT_PAID', null, 'المزود أكد إن مفيش خصم'); return x; }); out.reconciled++; }
        } catch (e) { if (e?.rateLimited) { state.backoffUntil = new Date(now + (e.retryAfterMs || 5 * 60_000)).toISOString(); break; } }
      }
      if (c.status === STATUS.PAID && c.payment?.paidAt) {
        let hint = null; let creditRes = null;
        if (creditAd?.queryCredit) { try { creditRes = await withTimeout(Promise.resolve(creditAd.queryCredit({ code: c.code, accountId: c.accountId, amountEgp: c.amountEgp, paidAt: c.payment.paidAt })), 30_000); out.checked++; } catch (e) { if (e?.rateLimited) { state.backoffUntil = new Date(now + (e.retryAfterMs || 5 * 60_000)).toISOString(); break; } } }
        if (creditRes?.outcome === 'CREDITED') {
          await S.updateCode(c.id, (x) => { if (x.status !== STATUS.PAID) return undefined; x.status = STATUS.CREDITED; x.lastCheckedAt = nowIso(); x.credit = { at: creditRes.at || nowIso(), source: creditRes.source || 'PROVIDER', evidence: String(creditRes.evidence || '').slice(0, 300), by: null, amountEgp: x.amountEgp }; S.pushEvent(x, 'CREDITED', null, 'تأكيد التسميع: ' + (creditRes.source || 'PROVIDER')); return x; }); out.credited++; continue;
        }
        if (c.creditWatch?.balanceBeforeEgp != null) { // a balance that rose is only a HINT — never proof for this code
          try { const f = await withTimeout(Promise.resolve(deps.getFunds(c.accountId)), 8000); out.checked++; if (f?.available != null) { const delta = fromPi(toPi(f.available) - toPi(c.creditWatch.balanceBeforeEgp)); hint = { balanceNowEgp: f.available, deltaEgp: delta, at: nowIso(), looksCredited: delta >= c.amountEgp * 0.9 }; } } catch (e) { if (e?.rateLimited) { state.backoffUntil = new Date(now + 5 * 60_000).toISOString(); break; } }
        }
        await S.updateCode(c.id, (x) => { if (x.status !== STATUS.PAID) return undefined; x.lastCheckedAt = nowIso(); if (hint) x.creditHint = hint; return x; }).catch(() => {});
      }
    }
    state.lastOkAt = new Date(now).toISOString(); state.lastError = null;
  } catch (e) {
    state.lastError = String(e?.message || e).slice(0, 200); logger.warn('[adsPayments] monitor tick failed', { message: state.lastError });
    if (e?.rateLimited) state.backoffUntil = new Date(now + 5 * 60_000).toISOString();
  }
  state.lastTickAt = new Date(now).toISOString(); state.everyMin = cfg.monitorEveryMin;
  await S.saveMonitorState(state);
  return out;
}
export { cairoDay, addDaysISO, cairoLocalToUtc };
