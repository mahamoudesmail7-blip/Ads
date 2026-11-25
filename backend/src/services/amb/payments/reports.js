// Ads Payment Center — read models: periods, the overview, account cards, the movement chart, the report, the smart alerts, the top-up forecast, the daily / monthly closing and the Excel export.
//
// Accounting rule: every figure is dated by ITS OWN event —
//   codes extracted  → by the extraction time      (extractedAt)
//   actual payments  → by the payment time         (payment.paidAt)
//   credited balance → by the confirmation time    (credit.at)
// so a code extracted on the 30th, paid on the 1st and credited on the 2nd appears in three different periods and can never be counted twice in one.
// «Value of the codes» (what was asked for), «actual payments» (what left the wallets, fees included) and «confirmed credited balance» are three separate numbers.
import { todayISO, addDaysISO, loadSnapshots, latestPerDayPerEntity } from '../metricsEngine.js';
import { cairoLocalToUtc } from '../cloneEngine.js';
import * as S from './store.js';
import { STATUS, STATUS_LABEL, BUCKET, OPEN_STATUSES, PRESETS, PRESET_LABEL, SOURCE_LABEL, CREDIT_SOURCE_LABEL, bad, sumEgp, toPi, fromPi } from './spec.js';
import { providerStatus } from './providers.js';
import * as E from './engine.js';

const dayStartMs = (d) => cairoLocalToUtc(d, '00:00').getTime();
const monthStart = (d) => `${d.slice(0, 7)}-01`;
const addMonths = (d, n) => { const [y, m] = d.slice(0, 7).split('-').map(Number); const t = y * 12 + (m - 1) + n; const yy = Math.floor(t / 12); const mm = (t % 12) + 1; return `${yy}-${String(mm).padStart(2, '0')}-01`; };
const daysInMonth = (d) => { const [y, m] = d.slice(0, 7).split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const diffDays = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000);
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
export const monthLabel = (d) => `${AR_MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

function mk(from, to, label) { return { from, to, label, fromMs: dayStartMs(from), toMs: dayStartMs(addDaysISO(to, 1)), days: diffDays(from, to) + 1 }; }

/** Period + the previous comparable period, all in Cairo calendar days (inclusive). */
export function resolvePeriod({ preset = 'month', from = null, to = null } = {}, now = Date.now()) {
  if (!PRESETS.includes(preset)) throw bad('الفترة غير صالحة.');
  const today = todayISO(new Date(now));
  let p; let prev; let prevLabel;
  switch (preset) {
    case 'today': p = mk(today, today); prev = mk(addDaysISO(today, -1), addDaysISO(today, -1)); prevLabel = 'أمس'; break;
    case 'yesterday': { const y = addDaysISO(today, -1); p = mk(y, y); prev = mk(addDaysISO(y, -1), addDaysISO(y, -1)); prevLabel = 'اليوم السابق'; break; }
    case 'last7': case 'last14': case 'last30': { const n = Number(preset.slice(4)); p = mk(addDaysISO(today, -(n - 1)), today); prev = mk(addDaysISO(p.from, -n), addDaysISO(p.from, -1)); prevLabel = `الـ ${n} يوم السابقين`; break; }
    case 'month': { const ms = monthStart(today); const elapsed = diffDays(ms, today) + 1; const pm = addMonths(ms, -1); p = mk(ms, today); prev = mk(pm, addDaysISO(pm, Math.min(elapsed, daysInMonth(pm)) - 1)); prevLabel = 'نفس الفترة من الشهر الماضي'; break; }
    case 'lastMonth': { const lm = addMonths(monthStart(today), -1); p = mk(lm, addDaysISO(addMonths(lm, 1), -1)); const pm = addMonths(lm, -1); prev = mk(pm, addDaysISO(lm, -1)); prevLabel = 'الشهر اللي قبله'; break; }
    case 'year': { const ys = `${today.slice(0, 4)}-01-01`; p = mk(ys, today); const py = `${Number(today.slice(0, 4)) - 1}`; prev = mk(`${py}-01-01`, addDaysISO(`${py}-01-01`, diffDays(ys, today))); prevLabel = 'نفس الفترة من السنة الماضية'; break; }
    case 'custom': {
      if (!validDate(from) || !validDate(to)) throw bad('اختار تاريخ البداية والنهاية.');
      if (from > to) throw bad('تاريخ البداية لازم يكون قبل النهاية.');
      if (diffDays(from, to) > 400) throw bad('أقصى فترة مخصصة 400 يوم.');
      p = mk(from, to); const n = p.days; prev = mk(addDaysISO(from, -n), addDaysISO(from, -1)); prevLabel = 'الفترة السابقة بنفس الطول'; break;
    }
    default: throw bad('الفترة غير صالحة.');
  }
  const label = preset === 'custom' ? `${p.from} → ${p.to}` : PRESET_LABEL[preset];
  return { preset, label: preset === 'month' ? monthLabel(p.from) : label, from: p.from, to: p.to, fromMs: p.fromMs, toMs: p.toMs, days: p.days, prev: { from: prev.from, to: prev.to, fromMs: prev.fromMs, toMs: prev.toMs, label: prevLabel } };
}
const within = (iso, p) => { if (!iso) return false; const t = new Date(iso).getTime(); return t >= p.fromMs && t < p.toMs; };
const bucketOf = (status) => (BUCKET.unpaid.includes(status) ? 'unpaid' : BUCKET.pending.includes(status) ? 'pending' : BUCKET.credited.includes(status) ? 'credited' : 'expired');
const mins = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)) : null);
const avg = (xs) => (xs.length ? Math.round(xs.reduce((s, v) => s + v, 0) / xs.length) : null);
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const actualOf = (c) => c.payment?.totalEgp ?? c.amountEgp;

/** Every metric of §9 for one period, computed from the codes by each event's own date. */
export function computeReport(codes, p, { names = {} } = {}) {
  const ext = codes.filter((c) => within(c.extractedAt, p));
  const paid = codes.filter((c) => c.payment?.paidAt && within(c.payment.paidAt, p));
  const cred = codes.filter((c) => c.credit?.at && within(c.credit.at, p));
  const bucket = { unpaid: [], pending: [], credited: [], expired: [] }; for (const c of ext) bucket[bucketOf(c.status)].push(c);
  const val = (xs) => sumEgp(xs.map((c) => c.amountEgp));
  const byKey = (list, keyFn, labelFn, valFn) => { const m = new Map(); for (const c of list) { const k = keyFn(c); if (k == null) continue; const e = m.get(k) || { key: k, label: labelFn(c), count: 0, totalEgp: 0, _pi: 0 }; e.count++; e._pi += toPi(valFn(c)); m.set(k, e); } return [...m.values()].map(({ _pi, ...r }) => ({ ...r, totalEgp: fromPi(_pi) })).sort((a, b) => b.totalEgp - a.totalEgp); };
  const feesEgp = sumEgp(paid.map((c) => c.payment.feeEgp || 0));
  return {
    period: { preset: p.preset, label: p.label, from: p.from, to: p.to },
    extracted: { count: ext.length, valueEgp: val(ext), avgCodeEgp: ext.length ? fromPi(Math.round(toPi(val(ext)) / ext.length)) : null },
    buckets: Object.fromEntries(Object.entries(bucket).map(([k, xs]) => [k, { count: xs.length, valueEgp: val(xs), pct: pct(xs.length, ext.length) }])),
    payments: { count: paid.length, codesValueEgp: val(paid), feesEgp, actualEgp: sumEgp(paid.map(actualOf)) },
    credited: { count: cred.length, valueEgp: val(cred) },
    avgMinutesToPay: avg(paid.map((c) => mins(c.extractedAt, c.payment.paidAt)).filter((x) => x != null)),
    avgMinutesToCredit: avg(cred.map((c) => mins(c.payment?.paidAt, c.credit.at)).filter((x) => x != null)),
    byAccount: byKey(paid, (c) => c.accountId, (c) => names[c.accountId] || c.accountName, actualOf),
    byUser: byKey(paid, (c) => c.payment?.paidBy?.id ?? c.payment?.paidBy?.name ?? 'unknown', (c) => c.payment?.paidBy?.name || 'غير معروف', actualOf),
    byMethod: byKey(paid, (c) => c.payment?.methodId || 'unknown', (c) => c.payment?.methodLabel || 'غير معروف', actualOf),
  };
}

export function periodComparison(codes, p) {
  const cur = codes.filter((c) => c.payment?.paidAt && within(c.payment.paidAt, p)); const prv = codes.filter((c) => c.payment?.paidAt && within(c.payment.paidAt, p.prev));
  const a = sumEgp(cur.map(actualOf)); const b = sumEgp(prv.map(actualOf));
  return { currentEgp: a, previousEgp: b, changePct: b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null, label: p.prev.label, previousCount: prv.length };
}

/** Movement chart. day | week | month buckets over the period; payments by payment date (actual), extraction by extraction date. */
export function movementSeries(codes, p, granularity = 'week') {
  const buckets = [];
  if (granularity === 'day') { for (let d = p.from; d <= p.to; d = addDaysISO(d, 1)) buckets.push({ from: d, to: d, label: d.slice(8) }); }
  else if (granularity === 'month') { for (let m = monthStart(p.from); m <= p.to; m = addMonths(m, 1)) buckets.push({ from: m < p.from ? p.from : m, to: addDaysISO(addMonths(m, 1), -1) > p.to ? p.to : addDaysISO(addMonths(m, 1), -1), label: AR_MONTHS[Number(m.slice(5, 7)) - 1] }); }
  else { let i = 1; for (let d = p.from; d <= p.to; d = addDaysISO(d, 7), i++) { const e = addDaysISO(d, 6); buckets.push({ from: d, to: e > p.to ? p.to : e, label: `${i} الأسبوع` }); } }
  if (buckets.length > 400) throw bad('الفترة كبيرة على العرض ده — اختار عرض أسبوعي أو شهري.');
  const rows = buckets.map((b) => ({ ...b, fromMs: dayStartMs(b.from), toMs: dayStartMs(addDaysISO(b.to, 1)), paidEgp: 0, extractedEgp: 0, creditedEgp: 0, paidCount: 0 }));
  const put = (iso, fn) => { if (!iso) return; const t = new Date(iso).getTime(); const r = rows.find((x) => t >= x.fromMs && t < x.toMs); if (r) fn(r); };
  for (const c of codes) {
    put(c.extractedAt, (r) => { r.extractedEgp = sumEgp([r.extractedEgp, c.amountEgp]); });
    put(c.payment?.paidAt, (r) => { r.paidEgp = sumEgp([r.paidEgp, actualOf(c)]); r.paidCount++; });
    put(c.credit?.at, (r) => { r.creditedEgp = sumEgp([r.creditedEgp, c.amountEgp]); });
  }
  return rows.map(({ fromMs, toMs, ...r }) => r);
}

// ---------------------------------------------------------------------------
// account cards
// ---------------------------------------------------------------------------
export function accountCards(codes, accounts, p, { funds = {}, now = Date.now() } = {}) {
  const today = todayISO(new Date(now)); const todayP = { fromMs: dayStartMs(today), toMs: dayStartMs(addDaysISO(today, 1)) };
  const mStart = monthStart(today); const monthP = { fromMs: dayStartMs(mStart), toMs: dayStartMs(addDaysISO(today, 1)) };
  return accounts.map((a) => {
    const mine = codes.filter((c) => c.accountId === a.id);
    const ext = mine.filter((c) => within(c.extractedAt, p));
    const b = (k) => ext.filter((c) => bucketOf(c.status) === k);
    const paidToday = mine.filter((c) => c.payment?.paidAt && within(c.payment.paidAt, todayP)); const paidMonth = mine.filter((c) => c.payment?.paidAt && within(c.payment.paidAt, monthP));
    const f = funds[a.id] || null;
    return { id: a.id, name: a.name, isPrimary: !!a.isPrimary, removed: !!a.removed,
      balance: f ? { available: f.available ?? null, display: f.display ?? null, error: f.error || null } : null,
      extractedCount: ext.length, extractedValueEgp: sumEgp(ext.map((c) => c.amountEgp)),
      credited: b('credited').length, pending: b('pending').length, unpaid: b('unpaid').length, expired: b('expired').length, creditedPct: pct(b('credited').length, ext.length),
      paidTodayEgp: sumEgp(paidToday.map(actualOf)), paidMonthEgp: sumEgp(paidMonth.map(actualOf)), openCount: mine.filter((c) => OPEN_STATUSES.includes(c.status)).length };
  });
}

// ---------------------------------------------------------------------------
// spend (for «payments vs ad spend» and the forecast) — from our own synced snapshots, never a live Meta call
// ---------------------------------------------------------------------------
export const rdeps = {
  /** ONE query for every account: Map<accountId, Map<day, spend>> (the screen asks for all accounts at once). Tests inject spendByDay instead (then this is switched off). */
  async spendByDayAll(from, to) {
    const rows = await loadSnapshots({ level: 'campaign', from, to });
    const byC = latestPerDayPerEntity(rows, 'campaign'); const out = new Map();
    for (const days of byC.values()) for (const [d, r] of days) { const a = r.ad_account_id; if (!out.has(a)) out.set(a, new Map()); const m = out.get(a); m.set(d, (m.get(d) || 0) + (Number(r.spend) || 0)); }
    return out;
  },
  async spendByDay(accountId, from, to) {
    const rows = await loadSnapshots({ level: 'campaign', from, to, adAccountId: accountId });
    const byC = latestPerDayPerEntity(rows, 'campaign'); const out = new Map();
    for (const days of byC.values()) for (const [d, r] of days) out.set(d, (out.get(d) || 0) + (Number(r.spend) || 0));
    return out;
  },
};
export function _setReportDeps(o) { Object.assign(rdeps, o); if (o.spendByDay && !o.spendByDayAll) rdeps.spendByDayAll = null; }
/** Map<accountId, Map<day, spend>> for these accounts — one query, or (injected) one call per account in parallel. A failure gives an empty map for that account (never a made-up number). */
async function spendMap(ids, from, to) {
  if (rdeps.spendByDayAll) { try { const all = await rdeps.spendByDayAll(from, to); return new Map(ids.map((id) => [id, all.get(id) || null])); } catch { return new Map(ids.map((id) => [id, null])); } }
  const pairs = await Promise.all(ids.map(async (id) => { try { return [id, await rdeps.spendByDay(id, from, to)]; } catch { return [id, null]; } }));
  return new Map(pairs);
}

export async function spendVsPayments(codes, accounts, p) {
  if (p.days > 100) return { available: false, note: 'المقارنة بالإنفاق متاحة لحد 100 يوم.' };
  const rows = []; const sm = await spendMap(accounts.map((a) => a.id), p.from, p.to);
  for (const a of accounts) {
    const m = sm.get(a.id); const spend = m ? Math.round([...m.values()].reduce((s, v) => s + v, 0) * 100) / 100 : null;
    const paid = sumEgp(codes.filter((c) => c.accountId === a.id && c.payment?.paidAt && within(c.payment.paidAt, p)).map((c) => c.payment?.confirmedAmountEgp ?? c.amountEgp));
    rows.push({ accountId: a.id, name: a.name, spendEgp: spend, paidCodesEgp: paid, diffEgp: spend == null ? null : fromPi(toPi(paid) - toPi(spend)) });
  }
  return { available: true, rows, note: 'الإنفاق من آخر مزامنة (قد يتأخر لحد 15 دقيقة). المدفوع = قيمة الأكواد المدفوعة بدون الرسوم.' };
}

// ---------------------------------------------------------------------------
// forecast — an ESTIMATE, always labelled so; it never extracts or pays by itself
// ---------------------------------------------------------------------------
export async function buildForecast({ codes, accounts, funds, cfg, now = Date.now() }) {
  const today = todayISO(new Date(now)); const from = addDaysISO(today, -7); const to = addDaysISO(today, -1);
  const out = []; const live = accounts.filter((x) => !x.removed); const sm = await spendMap(live.map((a) => a.id), from, to);
  for (const a of live) {
    let avgDaily = null; let daysUsed = 0;
    { const m = sm.get(a.id); if (m) { const vals = [...m.values()].filter((v) => v > 0); daysUsed = vals.length; if (vals.length) avgDaily = Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100; } }
    const bal = funds[a.id]?.available ?? null;
    const incoming = sumEgp(codes.filter((c) => c.accountId === a.id && [STATUS.PAID, STATUS.PAYING].includes(c.status)).map((c) => c.amountEgp)); // paid, not yet credited
    const waiting = sumEgp(codes.filter((c) => c.accountId === a.id && [STATUS.UNPAID, STATUS.PAY_FAILED].includes(c.status) && !(c.expiresAt && new Date(c.expiresAt).getTime() <= now)).map((c) => c.amountEgp));
    let hours = null; let suggested = null; let needsToday = null; let note = null;
    if (bal != null && avgDaily != null && avgDaily > 0) {
      hours = Math.round((bal / (avgDaily / 24)) * 10) / 10;
      const need = avgDaily * cfg.coverDays - bal - incoming;
      suggested = need > 0 ? Math.ceil(need / 500) * 500 : 0;
      needsToday = hours <= cfg.needTopUpHours && incoming + waiting < avgDaily * cfg.coverDays;
    } else note = bal == null ? 'الرصيد غير متاح (حساب بكارت أو القراءة فشلت).' : 'مفيش إنفاق كفاية في آخر 7 أيام للتقدير.';
    out.push({ accountId: a.id, name: a.name, balanceEgp: bal, avgDailySpendEgp: avgDaily, spendDaysUsed: daysUsed, hoursLeft: hours, suggestedTopUpEgp: suggested, needsTopUpToday: needsToday, incomingEgp: incoming, waitingEgp: waiting, note });
  }
  return { estimate: true, note: 'تقديرات مبنية على متوسط إنفاق آخر 7 أيام والرصيد الحالي — مش أرقام مؤكدة، ومفيش استخراج ولا دفع بيحصل تلقائيًا بسببها.', coverDays: cfg.coverDays, needTopUpHours: cfg.needTopUpHours, accounts: out.sort((x, y) => (x.hoursLeft ?? 1e9) - (y.hoursLeft ?? 1e9)) };
}

// ---------------------------------------------------------------------------
// alerts (computed live from the state — nothing to dismiss, nothing that goes stale)
// ---------------------------------------------------------------------------
export function buildAlerts({ codes, accounts, forecast = null, monitor = {}, providers = providerStatus(), methods = [], cfg, now = Date.now() }) {
  const out = []; const A = (id) => accounts.find((a) => a.id === id)?.name || id;
  const push = (a) => out.push({ severity: 'WARNING', ...a });
  const ageMin = (iso) => Math.round((now - new Date(iso).getTime()) / 60000);
  const hm = (m) => (m >= 120 ? `${Math.round(m / 60)} ساعة` : `${m} دقيقة`);
  const dayOf = (iso) => todayISO(new Date(iso)); const today = todayISO(new Date(now));
  for (const c of codes) {
    const tgt = { type: 'code', id: c.id };
    const base = `الكود ${c.code} · حساب ${A(c.accountId)} · ${c.amountEgp.toLocaleString('en-US')} ج`; // starts with Arabic so the line reads right-to-left
    if (c.status === STATUS.UNPAID || c.status === STATUS.PAY_FAILED) {
      const expired = c.expiresAt && new Date(c.expiresAt).getTime() <= now; if (expired) continue;
      if (c.expiresAt && new Date(c.expiresAt).getTime() - now <= cfg.expiryWarnMin * 60000) push({ key: `exp:${c.id}`, type: 'EXPIRING', severity: 'CRITICAL', title: 'كود قرّب ينتهي', message: `${base} · باقي ${hm(Math.max(0, Math.round((new Date(c.expiresAt).getTime() - now) / 60000)))}.`, target: tgt, at: c.extractedAt });
      if (dayOf(c.extractedAt) < today) push({ key: `old:${c.id}`, type: 'PENDING_FROM_YESTERDAY', severity: 'CRITICAL', title: 'كود متعلق من يوم سابق', message: `${base} · اتطلّع يوم ${dayOf(c.extractedAt)} ولسه «${STATUS_LABEL[c.status]}».`, target: tgt, at: c.extractedAt });
      else if (ageMin(c.extractedAt) >= cfg.alertAfterMin) push({ key: `unp:${c.id}`, type: 'UNPAID_CODE', title: 'كود اتطلّع ولم يُدفع', message: `${base} · من ${hm(ageMin(c.extractedAt))}.`, target: tgt, at: c.extractedAt });
      if (c.status === STATUS.PAY_FAILED) push({ key: `pf:${c.id}`, type: 'PAY_FAILED', severity: 'CRITICAL', title: 'فشل عملية الدفع', message: `${base} · ${c.reason || ''}`, target: tgt, at: c.payment?.failedAt || c.updatedAt });
    }
    if (c.status === STATUS.PAID && c.payment?.paidAt && ageMin(c.payment.paidAt) >= Math.min(cfg.creditOverdueMin, cfg.alertAfterMin)) {
      push({ key: `pnc:${c.id}`, type: 'PAID_NOT_CREDITED', severity: ageMin(c.payment.paidAt) >= cfg.creditOverdueMin ? 'CRITICAL' : 'WARNING', title: 'كود مدفوع ولم يُسمَّع', message: `${base} · اتدفع من ${hm(ageMin(c.payment.paidAt))}.${c.creditHint?.looksCredited ? ' الرصيد زاد (دليل مساعد فقط، مش تأكيد).' : ''}`, target: tgt, at: c.payment.paidAt });
    }
    if (c.status === STATUS.UNCERTAIN) push({ key: `unc:${c.id}`, type: 'PAY_UNCERTAIN', severity: 'CRITICAL', title: 'نتيجة دفع غير مؤكدة', message: `${base} · لا تعيد الدفع قبل المطابقة.`, target: tgt, at: c.updatedAt });
    if (c.status === STATUS.REVIEW && c.reason === 'AMOUNT_MISMATCH') push({ key: `mm:${c.id}`, type: 'AMOUNT_MISMATCH', severity: 'CRITICAL', title: 'اختلاف مبلغ الدفع عن قيمة الكود', message: `${base} · المدفوع ${c.payment?.confirmedAmountEgp} ج.`, target: tgt, at: c.updatedAt });
    else if (c.status === STATUS.REVIEW) push({ key: `rv:${c.id}`, type: 'NEEDS_REVIEW', title: 'كود يحتاج مراجعة', message: base, target: tgt, at: c.updatedAt });
    const dups = (c.events || []).filter((e) => e.type === 'DUP_PAY_BLOCKED' && now - new Date(e.at).getTime() < 24 * 3600_000);
    if (dups.length) push({ key: `dup:${c.id}`, type: 'DUPLICATE_PAY_ATTEMPT', severity: 'CRITICAL', title: 'محاولة دفع مكرر اتمنعت', message: `${base} · ${dups.length} محاولة.`, target: tgt, at: dups[dups.length - 1].at });
  }
  const unpaidTotal = sumEgp(codes.filter((c) => [STATUS.UNPAID, STATUS.PAY_FAILED].includes(c.status) && !(c.expiresAt && new Date(c.expiresAt).getTime() <= now)).map((c) => c.amountEgp));
  for (const m of methods.filter((x) => x.active && x.balanceEgp != null)) if (unpaidTotal > 0 && toPi(m.balanceEgp) < toPi(unpaidTotal)) push({ key: `wal:${m.id}`, type: 'WALLET_LOW', severity: 'CRITICAL', title: 'رصيد محفظة غير كافٍ', message: `«${m.label}» رصيده ${m.balanceEgp.toLocaleString('en-US')} ج وعليه أكواد غير مدفوعة بـ ${unpaidTotal.toLocaleString('en-US')} ج.`, target: { type: 'tab', id: 'wallets' } });
  for (const f of forecast?.accounts || []) {
    if (f.balanceEgp != null && f.balanceEgp < cfg.lowBalanceEgp) push({ key: `lowbal:${f.accountId}`, type: 'ACCOUNT_LOW_BALANCE', severity: 'CRITICAL', title: 'حساب إعلاني رصيده منخفض', message: `«${f.name}» رصيده ${f.balanceEgp.toLocaleString('en-US')} ج فقط.`, target: { type: 'account', id: f.accountId } });
    else if (f.needsTopUpToday && f.hoursLeft != null) push({ key: `risk:${f.accountId}`, type: 'ACCOUNT_AT_RISK', title: 'حساب معرّض للتوقف بسبب نفاد الرصيد', message: `«${f.name}» يكفي نحو ${f.hoursLeft} ساعة (تقدير) — مقترح شحن ${f.suggestedTopUpEgp?.toLocaleString('en-US')} ج.`, target: { type: 'account', id: f.accountId } });
  }
  const everyMin = cfg.monitorEveryMin || 5;
  if (monitor.lastTickAt && now - new Date(monitor.lastTickAt).getTime() > everyMin * 3 * 60000) push({ key: 'stale', type: 'DATA_STALE', severity: 'CRITICAL', title: 'توقف تحديث بيانات المدفوعات', message: `آخر متابعة كانت من ${hm(Math.round((now - new Date(monitor.lastTickAt).getTime()) / 60000))}.`, target: { type: 'tab', id: 'settings' } });
  if (monitor.lastError) push({ key: 'monerr', type: 'LINK_PROBLEM', severity: 'CRITICAL', title: 'مشكلة في الربط مع Meta أو مزود الدفع', message: monitor.lastError, target: { type: 'tab', id: 'settings' } });
  const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  return out.sort((a, b) => (rank[a.severity] - rank[b.severity]) || String(b.at || '').localeCompare(String(a.at || '')));
}

// ---------------------------------------------------------------------------
// closing — immutable snapshots + clear «late» adjustments
// ---------------------------------------------------------------------------
export function buildClosing(codes, kind, key, now = Date.now()) {
  const p = kind === 'day' ? resolvePeriod({ preset: 'custom', from: key, to: key }, now) : resolvePeriod({ preset: 'custom', from: `${key}-01`, to: addDaysISO(addMonths(`${key}-01`, 1), -1) }, now);
  const asOf = p.toMs; // positions are measured at the END of the period
  const rep = computeReport(codes, p);
  const known = codes.filter((c) => new Date(c.extractedAt).getTime() < asOf);
  const statusAt = (c) => { // the code's state at the close, rebuilt from its own dated events — never from today's status
    if (c.credit?.at && new Date(c.credit.at).getTime() < asOf) return STATUS.CREDITED;
    if (c.payment?.paidAt && new Date(c.payment.paidAt).getTime() < asOf) return STATUS.PAID;
    if (c.status === STATUS.EXPIRED && c.expiresAt && new Date(c.expiresAt).getTime() < asOf) return STATUS.EXPIRED;
    return STATUS.UNPAID;
  };
  const open = known.map((c) => ({ c, s: statusAt(c) }));
  const discrepancies = codes.filter((c) => c.reason === 'AMOUNT_MISMATCH' && c.payment?.paidAt && within(c.payment.paidAt, p)).map((c) => ({ codeId: c.id, code: c.code, note: `المدفوع ${c.payment.confirmedAmountEgp} ج ≠ قيمة الكود ${c.amountEgp} ج` }))
    .concat(codes.filter((c) => c.status === STATUS.UNCERTAIN && c.payment?.startedAt && within(c.payment.startedAt, p)).map((c) => ({ codeId: c.id, code: c.code, note: 'نتيجة دفع غير مؤكدة' })));
  const paid = codes.filter((c) => c.payment?.paidAt && within(c.payment.paidAt, p));
  return { id: key, kind, key, period: { from: p.from, to: p.to }, createdAt: new Date(now).toISOString(),
    totals: { extractedCount: rep.extracted.count, extractedEgp: rep.extracted.valueEgp, paidCount: rep.payments.count, paidCodesEgp: rep.payments.codesValueEgp, actualPaidEgp: rep.payments.actualEgp, feesEgp: rep.payments.feesEgp, outflowEgp: rep.payments.actualEgp, creditedCount: rep.credited.count, creditedEgp: rep.credited.valueEgp },
    positionsAtClose: { unpaid: { count: open.filter((x) => x.s === STATUS.UNPAID).length, valueEgp: sumEgp(open.filter((x) => x.s === STATUS.UNPAID).map((x) => x.c.amountEgp)) }, paidNotCredited: { count: open.filter((x) => x.s === STATUS.PAID).length, valueEgp: sumEgp(open.filter((x) => x.s === STATUS.PAID).map((x) => x.c.amountEgp)) } },
    byMethod: rep.byMethod, byAccount: rep.byAccount, discrepancies, paidCodeIds: paid.map((c) => c.id) };
}
/** Credits / payments recorded AFTER a closing for codes the closing already knew: shown beside the (unchanged) closing as dated adjustments. */
export function lateAdjustments(codes, closing) {
  const end = dayStartMs(addDaysISO(closing.period.to, 1)); const out = [];
  for (const c of codes) {
    if (new Date(c.extractedAt).getTime() >= end) continue;
    if (c.credit?.at && new Date(c.credit.at).getTime() >= end && new Date(c.payment?.paidAt || 0).getTime() < end) out.push({ codeId: c.id, code: c.code, type: 'CREDIT_AFTER_CLOSE', at: c.credit.at, amountEgp: c.amountEgp, note: 'تسميع بعد التقفيل' });
    if (c.payment?.paidAt && new Date(c.payment.paidAt).getTime() >= end) out.push({ codeId: c.id, code: c.code, type: 'PAYMENT_AFTER_CLOSE', at: c.payment.paidAt, amountEgp: actualOf(c), note: 'دفع بعد التقفيل' });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
/** Writes every missing daily closing (and monthly ones) up to YESTERDAY, Cairo. Write-once: an existing closing is never touched. */
export async function runClosings({ now = Date.now(), maxBack = 10 } = {}) {
  const cfg = await S.getConfig(); if (!cfg.closingEnabled) return { created: [] };
  const codes = await S.allCodes(); const today = todayISO(new Date(now)); const created = [];
  if (!codes.length) return { created };
  const first = todayISO(new Date(Math.min(...codes.map((c) => new Date(c.extractedAt).getTime()))));
  for (let i = 1; i <= maxBack; i++) {
    const d = addDaysISO(today, -i); if (d < first) break;
    if (await S.getClosing(d)) continue;
    const rec = buildClosing(codes, 'day', d, now); if (await S.createClosing(d, rec)) created.push(d);
  }
  const lastMonth = addMonths(monthStart(today), -1).slice(0, 7);
  if (`${lastMonth}-01` >= monthStart(first) && !(await S.getClosing(lastMonth))) { const rec = buildClosing(codes, 'month', lastMonth, now); if (await S.createClosing(lastMonth, rec)) created.push(lastMonth); }
  return { created };
}

// ---------------------------------------------------------------------------
// the code row as the screen shows it
// ---------------------------------------------------------------------------
export function codeRow(c, { names = {}, now = Date.now() } = {}) {
  const expiredNow = (c.status === STATUS.UNPAID || c.status === STATUS.PAY_FAILED) && c.expiresAt && new Date(c.expiresAt).getTime() <= now;
  const status = expiredNow ? STATUS.EXPIRED : c.status;
  return { id: c.id, code: c.code, accountId: c.accountId, accountName: names[c.accountId] || c.accountName, amountEgp: c.amountEgp, status, statusLabel: STATUS_LABEL[status], reason: c.reason || null,
    source: c.source, sourceLabel: SOURCE_LABEL[c.source] || c.source, simulated: !!c.simulated,
    extractedAt: c.extractedAt, extractedBy: c.extractedBy?.name || null, expiresAt: c.expiresAt || null,
    paidAt: c.payment?.paidAt || null, paidBy: c.payment?.paidBy?.name || null, creditedAt: c.credit?.at || null,
    methodLabel: c.payment?.methodLabel || null, methodType: c.payment?.methodType || null, txnRef: c.payment?.txnRef || null, receipt: c.payment?.receipt || null,
    feeEgp: c.payment?.feeEgp ?? null, totalEgp: c.payment?.totalEgp ?? null, creditSource: c.credit ? (CREDIT_SOURCE_LABEL[c.credit.source] || c.credit.source) : null, creditEvidence: c.credit?.evidence || null, creditHint: c.creditHint || null,
    minutesToPay: mins(c.extractedAt, c.payment?.paidAt), minutesToCredit: mins(c.payment?.paidAt, c.credit?.at), lastCheckedAt: c.lastCheckedAt || null, attempts: c.payment?.attempts?.length || 0 };
}

// ---------------------------------------------------------------------------
// Excel export
// ---------------------------------------------------------------------------
export async function buildWorkbook({ rows, report, period }) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook(); wb.creator = 'AI Media Buyer'; wb.created = new Date();
  const ws = wb.addWorksheet('الأكواد', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  ws.columns = [['الكود', 16], ['الحساب الإعلاني', 24], ['المبلغ', 12], ['الحالة', 18], ['وقت الاستخراج', 20], ['وقت الدفع', 20], ['وقت التسميع', 20], ['انتهاء الصلاحية', 20], ['طريقة الدفع', 18], ['الموظف', 18], ['رقم العملية', 20], ['رسوم', 10], ['إجمالي المخصوم', 14], ['المصدر', 16]].map(([header, width]) => ({ header, width }));
  const d = (x) => (x ? new Date(x) : null);
  for (const r of rows) ws.addRow([r.code, r.accountName, r.amountEgp, r.statusLabel, d(r.extractedAt), d(r.paidAt), d(r.creditedAt), d(r.expiresAt), r.methodLabel || '', r.paidBy || r.extractedBy || '', r.txnRef || '', r.feeEgp ?? '', r.totalEgp ?? '', r.sourceLabel]);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6D28D9' } };
  for (const col of [5, 6, 7, 8]) ws.getColumn(col).numFmt = 'yyyy-mm-dd hh:mm';
  const sm = wb.addWorksheet('ملخص', { views: [{ rightToLeft: true }] });
  sm.columns = [{ width: 38 }, { width: 20 }];
  const line = (a, b) => sm.addRow([a, b]);
  line('الفترة', `${period.from} → ${period.to}`);
  line('عدد الأكواد المستخرجة', report.extracted.count); line('قيمة الأكواد المستخرجة', report.extracted.valueEgp);
  line('عدد الأكواد المدفوعة', report.payments.count); line('قيمة الأكواد المدفوعة', report.payments.codesValueEgp); line('رسوم الدفع', report.payments.feesEgp); line('إجمالي المدفوعات الفعلية (بالرسوم)', report.payments.actualEgp);
  line('الرصيد المضاف المؤكد (تسميع)', report.credited.valueEgp); line('قيمة غير المدفوع', report.buckets.unpaid.valueEgp); line('قيمة المعلّق', report.buckets.pending.valueEgp);
  line('متوسط قيمة الكود', report.extracted.avgCodeEgp ?? ''); line('متوسط مدة التسميع (دقيقة)', report.avgMinutesToCredit ?? '');
  sm.addRow([]); sm.addRow(['المدفوعات لكل حساب', 'ج']); for (const r of report.byAccount) sm.addRow([r.label, r.totalEgp]);
  sm.addRow([]); sm.addRow(['المدفوعات لكل موظف', 'ج']); for (const r of report.byUser) sm.addRow([r.label, r.totalEgp]);
  sm.addRow([]); sm.addRow(['المدفوعات لكل وسيلة دفع', 'ج']); for (const r of report.byMethod) sm.addRow([r.label, r.totalEgp]);
  sm.getColumn(1).font = { bold: true };
  return wb.xlsx.writeBuffer();
}

export { E };
