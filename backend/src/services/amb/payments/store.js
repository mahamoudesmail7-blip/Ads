// Ads Payment Center — storage. NO schema change: every record is one `settings` row (the same pattern the TikTok drafts use), so it follows the workspace isolation of prisma.settings
// and needs no migration on production.
//   fp:c:<id>      one extracted / registered code (+ its payment, credit and event history)
//   fp:cn:<CODE>   unique index of code numbers (a code number can be registered only once)
//   fp:j:<id>      one extraction job (single or an item of a bulk run) — persisted BEFORE the provider is called
//   fp:b:<id>      a bulk batch (extract or pay) with its items
//   fp:a:<ms>-<r>  audit log entry (who / when / what / result) — append only
//   fp:x:<key>     closing report (day YYYY-MM-DD or month YYYY-MM) — immutable once written
//   fp:cfg · fp:methods · fp:perms · fp:mon   settings, payment methods (no secrets), per-user grants, follow-up state
//
// Every change to an existing record goes through casUpdate(): read → compute → write ONLY IF the row is still exactly what was read (`updateMany where data = old`).
// That is what makes «two clicks / two employees / a retry» unable to pay or extract the same thing twice, with no lock table and no process-local state to lose on restart.
import crypto from 'node:crypto';
import { prisma } from '../../../prisma.js';
import { DEFAULT_SETTINGS, DEFAULT_MANAGER_PERMS, PERMS, bad, normalizeCode, parseAmount, toPi, fromPi } from './spec.js';

export const P = { code: 'fp:c:', codeIdx: 'fp:cn:', job: 'fp:j:', batch: 'fp:b:', audit: 'fp:a:', close: 'fp:x:', cfg: 'fp:cfg', methods: 'fp:methods', perms: 'fp:perms', mon: 'fp:mon' };
const parse = (s) => { try { return JSON.parse(s || 'null'); } catch { return null; } };
export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomBytes(6).toString('hex');
export const validId = (id) => /^[0-9a-f]{12}$/.test(String(id || ''));

// ---------------------------------------------------------------------------
// row primitives
// ---------------------------------------------------------------------------
async function readRow(id) { const r = await prisma.settings.findUnique({ where: { id } }); return r ? { raw: r.data, obj: parse(r.data) } : null; }
async function writeRow(id, obj) { const data = JSON.stringify(obj); await prisma.settings.upsert({ where: { id }, create: { id, data }, update: { data } }); return obj; }
/** Creates the row only if it does not exist yet. Returns null when somebody else created it first (unique violation). */
async function createRow(id, obj) {
  try { await prisma.settings.create({ data: { id, data: JSON.stringify(obj) } }); return obj; } catch (e) { if (e?.code === 'P2002') return null; throw e; }
}
/**
 * Compare-and-set update. `fn(current)` returns the NEW object (or throws to abort / returns undefined for «nothing to change»).
 * The write only lands when the row still holds exactly the text that was read; otherwise it re-reads and recomputes (so fn must be pure on its input).
 */
export async function casUpdate(id, fn, { tries = 10 } = {}) {
  for (let i = 0; i < tries; i++) {
    const cur = await readRow(id);
    if (!cur || !cur.obj) throw bad('السجل مش موجود.', 404);
    const next = await fn(JSON.parse(cur.raw));
    if (next === undefined) return cur.obj;
    next.updatedAt = nowIso();
    const res = await prisma.settings.updateMany({ where: { id, data: cur.raw }, data: { data: JSON.stringify(next) } });
    if (res.count === 1) return next;
  }
  throw bad('السجل بيتعدّل من مكان تاني — جرّب تاني.', 409);
}
async function listRows(prefix, { take = null, desc = false } = {}) {
  const rows = await prisma.settings.findMany({ where: { id: { startsWith: prefix } }, orderBy: { id: desc ? 'desc' : 'asc' }, ...(take ? { take } : {}) });
  return rows.map((r) => parse(r.data)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// audit log (append only) — never contains a secret, a token, a wallet number or a verification code
// ---------------------------------------------------------------------------
const SECRETISH = /(token|secret|password|pass|otp|pin|cvv|authorization|api[_-]?key)/i;
function scrub(v, depth = 0) {
  if (v == null || depth > 4) return v ?? null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, SECRETISH.test(k) ? '[محجوب]' : scrub(x, depth + 1)]));
  return typeof v === 'string' ? v.slice(0, 400) : v;
}
export async function audit({ actor = null, action, target = null, outcome = 'OK', detail = null }) {
  const at = nowIso();
  const id = `${P.audit}${String(Date.now()).padStart(13, '0')}-${crypto.randomBytes(3).toString('hex')}`;
  const rec = { at, actor: actor ? { id: actor.id ?? null, name: actor.name ?? null } : null, action, target, outcome, detail: scrub(detail) };
  await writeRow(id, rec).catch(() => null); // an audit write must never break the operation it describes
  return rec;
}
export async function listAudit({ limit = 100, codeId = null } = {}) {
  const rows = await listRows(P.audit, { take: codeId ? 2000 : Math.min(500, limit), desc: true });
  const out = codeId ? rows.filter((r) => r.target?.id === codeId) : rows;
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// codes
// ---------------------------------------------------------------------------
export async function createCode(rec) {
  const code = normalizeCode(rec.code);
  const idx = await createRow(P.codeIdx + code, { codeId: rec.id, at: nowIso() });
  if (!idx) { const e = bad('رقم الكود ده متسجل قبل كده — مينفعش يتسجل مرتين.', 409, { duplicate: true }); throw e; }
  const full = { ...rec, code, events: rec.events || [], createdAt: nowIso(), updatedAt: nowIso() };
  const made = await createRow(P.code + rec.id, full);
  if (!made) throw bad('تعارض في إنشاء الكود.', 409);
  return full;
}
export async function getCode(id) { if (!validId(id)) return null; return (await readRow(P.code + id))?.obj || null; }
export async function findCodeByNumber(code) {
  const idx = await readRow(P.codeIdx + normalizeCode(code)); if (!idx?.obj?.codeId) return null;
  return getCode(idx.obj.codeId);
}
export async function allCodes() { return listRows(P.code); }
/** `fn(code)` mutates and returns the code; every call should push an event so the history explains each change. */
export const updateCode = (id, fn) => casUpdate(P.code + id, fn);
export const pushEvent = (c, type, by, note = null, data = null) => { (c.events ||= []).push({ at: nowIso(), type, by: by ? { id: by.id ?? null, name: by.name ?? null } : null, note, ...(data ? { data: scrub(data) } : {}) }); return c; };

// ---------------------------------------------------------------------------
// extraction jobs & bulk batches
// ---------------------------------------------------------------------------
export async function createJob(job) { const made = await createRow(P.job + job.id, { ...job, createdAt: nowIso(), updatedAt: nowIso() }); return made; }
export async function getJob(id) { return (await readRow(P.job + id))?.obj || null; }
export async function allJobs() { return listRows(P.job); }
export const updateJob = (id, fn) => casUpdate(P.job + id, fn);
export async function createBatch(b) { const made = await createRow(P.batch + b.id, { ...b, createdAt: nowIso(), updatedAt: nowIso() }); if (!made) throw bad('تعارض في إنشاء الدفعة.', 409); return made; }
export async function getBatch(id) { if (!validId(id)) return null; return (await readRow(P.batch + id))?.obj || null; }
export async function allBatches() { return listRows(P.batch, { take: 100, desc: true }); }
export const updateBatch = (id, fn) => casUpdate(P.batch + id, fn);

// ---------------------------------------------------------------------------
// settings · methods · grants · monitor state
// ---------------------------------------------------------------------------
export async function getConfig() { const row = (await readRow(P.cfg))?.obj || {}; return { ...DEFAULT_SETTINGS, ...row, accountNames: { ...(row.accountNames || {}) }, dailyLimits: { ...(row.dailyLimits || {}) } }; }
const num = (v, lo, hi, name) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw bad(`${name} لازم يكون بين ${lo} و ${hi}.`); return n; };
export function validateConfigPatch(p) {
  const out = {};
  if ('monitorEveryMin' in p) out.monitorEveryMin = Math.round(num(p.monitorEveryMin, 1, 60, 'فترة المتابعة (دقيقة)'));
  if ('alertAfterMin' in p) out.alertAfterMin = Math.round(num(p.alertAfterMin, 5, 1440, 'مدة التنبيه (دقيقة)'));
  if ('expiryWarnMin' in p) out.expiryWarnMin = Math.round(num(p.expiryWarnMin, 5, 2880, 'تنبيه قرب الانتهاء (دقيقة)'));
  if ('creditOverdueMin' in p) out.creditOverdueMin = Math.round(num(p.creditOverdueMin, 5, 4320, 'مهلة التسميع (دقيقة)'));
  if ('defaultExpiryHours' in p) out.defaultExpiryHours = Math.round(num(p.defaultExpiryHours, 1, 720, 'صلاحية الكود الافتراضية (ساعة)'));
  if ('minAmountEgp' in p) out.minAmountEgp = num(p.minAmountEgp, 1, 1000000, 'أقل مبلغ');
  if ('maxAmountEgp' in p) out.maxAmountEgp = num(p.maxAmountEgp, 1, 10000000, 'أعلى مبلغ');
  if ('extractGapMs' in p) out.extractGapMs = Math.round(num(p.extractGapMs, 0, 60000, 'الفاصل بين الاستخراجات (مللي ثانية)'));
  if ('coverDays' in p) out.coverDays = num(p.coverDays, 0.5, 14, 'أيام التغطية');
  if ('needTopUpHours' in p) out.needTopUpHours = Math.round(num(p.needTopUpHours, 1, 720, 'حد الساعات للشحن'));
  if ('lowBalanceEgp' in p) out.lowBalanceEgp = num(p.lowBalanceEgp, 0, 10000000, 'حد الرصيد المنخفض');
  if ('closingEnabled' in p) out.closingEnabled = !!p.closingEnabled;
  if ('accountNames' in p) { const m = {}; for (const [k, v] of Object.entries(p.accountNames || {})) { if (/^act_\d{5,25}$/.test(k) && String(v || '').trim()) m[k] = String(v).trim().slice(0, 80); } out.accountNames = m; }
  if ('dailyLimits' in p) { const m = {}; for (const [k, v] of Object.entries(p.dailyLimits || {})) { if (!/^\d{1,9}$/.test(k)) continue; if (v === '' || v === null) continue; m[k] = num(v, 0, 100000000, 'الحد اليومي'); } out.dailyLimits = m; }
  if (out.minAmountEgp != null && out.maxAmountEgp != null && out.minAmountEgp > out.maxAmountEgp) throw bad('أقل مبلغ لازم يكون أصغر من أعلى مبلغ.');
  return out;
}
export async function saveConfig(patch) {
  const clean = validateConfigPatch(patch || {});
  const cur = (await readRow(P.cfg))?.obj || {};
  const next = { ...cur, ...clean };
  const merged = { ...DEFAULT_SETTINGS, ...next };
  if (merged.minAmountEgp > merged.maxAmountEgp) throw bad('أقل مبلغ لازم يكون أصغر من أعلى مبلغ.');
  await writeRow(P.cfg, next);
  return getConfig();
}

// payment methods hold NO credentials — only a label, a type, an optional masked reference and the fee rule. Connecting a real wallet is done by the provider adapter (server-side env), never stored here.
export const METHOD_TYPES = Object.freeze({ WALLET: 'محفظة', FAWRY_BALANCE: 'رصيد فوري', BANK: 'تحويل بنكي', CARD: 'كارت', CASH: 'كاش / منفذ فوري', OTHER: 'أخرى' });
export async function listMethods() { return (await readRow(P.methods))?.obj?.methods || []; }
async function saveMethods(methods) { await writeRow(P.methods, { methods, updatedAt: nowIso() }); return methods; }
export async function upsertMethod(input, { userId = null } = {}) {
  const methods = await listMethods();
  const label = String(input.label || '').trim().slice(0, 60); if (!label) throw bad('اسم وسيلة الدفع مطلوب.');
  const type = METHOD_TYPES[input.type] ? input.type : 'WALLET';
  const feePct = input.feePct === '' || input.feePct == null ? 0 : Number(input.feePct); const feeFixed = input.feeFixed === '' || input.feeFixed == null ? 0 : Number(input.feeFixed);
  if (!Number.isFinite(feePct) || feePct < 0 || feePct > 20) throw bad('نسبة الرسوم لازم تكون بين 0 و 20%.');
  if (!Number.isFinite(feeFixed) || feeFixed < 0 || feeFixed > 1000) throw bad('الرسوم الثابتة لازم تكون بين 0 و 1000 ج.');
  const masked = String(input.maskedRef || '').trim().slice(0, 12); // «••1234» only — the full number is never stored
  if (masked && /\d{9,}/.test(masked)) throw bad('ماتكتبش رقم الوسيلة كامل — اكتب آخر 4 أرقام بس.');
  const balance = input.balanceEgp === '' || input.balanceEgp == null ? null : Number(input.balanceEgp);
  if (balance != null && (!Number.isFinite(balance) || balance < 0)) throw bad('الرصيد غير صالح.');
  const rec = { id: input.id && methods.find((m) => m.id === input.id) ? input.id : newId(), label, type, maskedRef: masked || null, feePct, feeFixed: Math.round(feeFixed * 100) / 100, balanceEgp: balance, balanceSource: balance == null ? null : 'MANUAL', active: input.active !== false, updatedBy: userId, updatedAt: nowIso() };
  const i = methods.findIndex((m) => m.id === rec.id);
  if (i >= 0) methods[i] = { ...methods[i], ...rec, createdAt: methods[i].createdAt }; else methods.push({ ...rec, createdAt: nowIso() });
  await saveMethods(methods); return rec;
}
export async function removeMethod(id) { const ms = await listMethods(); await saveMethods(ms.filter((m) => m.id !== id)); return { removed: ms.some((m) => m.id === id) }; }
/** Debits a method's KNOWN balance (simulation / a balance the owner keeps by hand). A null balance stays null — never a guessed number. */
export async function debitMethodBalance(id, egp) {
  const ms = await listMethods(); const m = ms.find((x) => x.id === id); if (!m || m.balanceEgp == null) return null;
  m.balanceEgp = fromPi(Math.max(0, toPi(m.balanceEgp) - toPi(egp))); m.updatedAt = nowIso(); await saveMethods(ms); return m.balanceEgp;
}
export const feeFor = (method, amountEgp) => fromPi(Math.round(toPi(amountEgp) * (Number(method?.feePct) || 0) / 100) + toPi(method?.feeFixed || 0));

// per-user grants
export async function getGrants() { return (await readRow(P.perms))?.obj?.users || {}; }
export async function setUserPerms(userId, perms) {
  if (!/^\d{1,9}$/.test(String(userId))) throw bad('مستخدم غير صالح.');
  const clean = {}; for (const k of Object.keys(PERMS)) clean[k] = !!perms?.[k];
  const users = await getGrants(); users[String(userId)] = clean; await writeRow(P.perms, { users, updatedAt: nowIso() }); return clean;
}
/** ADMIN / owner: everything. MANAGER: the safe defaults + whatever the owner granted. Anyone else: only what was granted (usually nothing). */
export async function permsFor(user) {
  const all = Object.fromEntries(Object.keys(PERMS).map((k) => [k, true]));
  if (!user) return Object.fromEntries(Object.keys(PERMS).map((k) => [k, false]));
  if (user.role === 'ADMIN' || user.is_owner) return all;
  const granted = (await getGrants())[String(user.id)];
  const base = user.role === 'MANAGER' ? { ...DEFAULT_MANAGER_PERMS } : Object.fromEntries(Object.keys(PERMS).map((k) => [k, false]));
  return { ...base, ...(granted || {}) };
}

export async function getMonitorState() { return (await readRow(P.mon))?.obj || { lastTickAt: null, lastOkAt: null, lastError: null, backoffUntil: null, lastClosedDay: null }; }
export async function saveMonitorState(s) { return writeRow(P.mon, s); }

// closings are write-once
export async function createClosing(key, rec) { return createRow(P.close + key, rec); }
export async function getClosing(key) { return (await readRow(P.close + key))?.obj || null; }
export async function listClosings(kind = 'day') { const rows = await listRows(P.close, { desc: true }); return rows.filter((r) => r.kind === kind).slice(0, 120); }

export { parseAmount, toPi, fromPi };
