// AI Operator V2 — the bulk REVIEW preview (read-only). It answers «what would happen to each selected campaign» using ONLY facts the existing engines already hold (status, exceptions, data freshness, open decisions,
// today's plan items, Winner class, last budget change) — it does NOT decide eligibility by itself and it does NOT create anything. The FINAL eligibility is re-checked by the existing engine when a draft plan is created (phase 3),
// and again right before any execution; this preview says so. No Meta call, no write, no plan, no decision row.
import crypto from 'node:crypto';
import { getOperatorConfig } from './operatorStore.js';
import { evaluateWriteGate } from './writeGate.js';
import { buildRows, resolvePeriod, fingerprint } from './campaignQuery.js';
import { readSnapshot } from './campaignSelection.js';
import { cairoDate } from './dailyPlanTime.js';

export const ACTIONS = { OPEN: { gate: 'RESUME', needs: 'PAUSED', exc: ['NO_AUTO_OPEN'], label: 'فتح الحملات' }, PAUSE: { gate: 'PAUSE', needs: 'ACTIVE', exc: ['NO_AUTO_STOP'], label: 'إيقاف الحملات' }, INCREASE_BUDGET: { gate: 'INCREASE_BUDGET', needs: 'ACTIVE', exc: ['NO_AUTO_SCALE', 'NO_BUDGET_CHANGE'], label: 'زيادة الميزانيات' }, DECREASE_BUDGET: { gate: 'DECREASE_BUDGET', needs: 'ACTIVE', exc: ['NO_BUDGET_CHANGE'], label: 'تقليل الميزانيات' }, ADD_EXCLUSION: { gate: null, needs: null, exc: [], label: 'إضافة استثناء' }, REMOVE_EXCLUSION: { gate: null, needs: null, exc: [], label: 'إزالة استثناء' } };
const bad = (message, code = 'BAD_REQUEST', status = 400) => { const e = new Error(message); e.status = status; e.code = code; return e; };
export const CREATABLE = ['OPEN', 'PAUSE', 'INCREASE_BUDGET', 'DECREASE_BUDGET'];
/** the hash of the ELIGIBLE set: the user echoes it to create — so the draft is exactly what the preview showed */
export const previewHashOf = (action, ids) => crypto.createHash('sha1').update(`${action}|${[...ids].sort().join(',')}`).digest('hex');
const DECISION_ACTION = { OPEN: 'OPEN', PAUSE: 'PAUSE', INCREASE_BUDGET: 'SCALE_UP', DECREASE_BUDGET: 'SCALE_DOWN' };

export function sanitizeParams(action, p = {}) {
  const x = p || {}; const mode = ['pct', 'amt', 'fix'].includes(x.mode) ? x.mode : 'pct'; const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
  const out = { mode, value: num(x.value, mode === 'pct' ? 20 : 0), dailyCap: num(x.dailyCap, null), cooldownHours: num(x.cooldownHours, 24), minOrders: num(x.minOrders, null) };
  for (const [k, v] of Object.entries(out)) if (v != null && typeof v === 'number' && !Number.isFinite(v)) throw bad(`القيمة ${k} لازم تكون رقم.`);
  if (['INCREASE_BUDGET', 'DECREASE_BUDGET'].includes(action)) { if (!(out.value > 0)) throw bad('قيمة التعديل لازم تكون أكبر من صفر.'); if (out.mode === 'pct' && out.value > 100) throw bad('النسبة لازم تكون من 1 لـ 100.'); }
  return out;
}
/** pure: the verdict for ONE live row */
export function verdictFor(row, action, params, { snapshotFp = null } = {}) {
  const def = ACTIONS[action]; const reasons = [], warnings = []; let kind = 'ELIGIBLE';
  const RANK = { ELIGIBLE: 0, REJECTED: 1, PROTECTED: 2, EXCLUDED: 3 }; const reject = (why, k = 'REJECTED') => { reasons.push(why); if (RANK[k] > RANK[kind]) kind = k; };
  const changed = snapshotFp != null && snapshotFp !== fingerprint(row);
  let after = { status: row.status, budget: row.budget };
  if (action === 'ADD_EXCLUSION') { if (row.excluded) reject('الحملة مستثناة بالفعل.'); else warnings.push('الاستثناء بيمنع أي أتمتة على الحملة لحد ما يتشال.'); return { kind, reasons, warnings, changed, before: { status: row.status, budget: row.budget }, after, budgetDelta: 0 }; }
  if (action === 'REMOVE_EXCLUSION') { if (!row.excluded) reject('الحملة مش مستثناة.'); return { kind, reasons, warnings, changed, before: { status: row.status, budget: row.budget }, after, budgetDelta: 0 }; }
  if (row.status !== def.needs) reject(def.needs === 'PAUSED' ? 'الحملة شغالة أصلًا.' : 'الحملة متوقفة.');
  const hit = (row.exceptions || []).filter((t) => def.exc.includes(t) || t === 'NO_AUTOMATION'); if (hit.length) { reject(`مستثناة من العملية دي (${hit.join(' / ')}).`, 'EXCLUDED'); }
  if (action === 'PAUSE' && row.protectedC && !hit.length) reject('حملة محمية من الإيقاف — مراجعة يدوية.', 'PROTECTED');
  if (!row.dataFresh) reject(`بيانات قديمة (آخر مزامنة من ${row.dataAgeMin} دقيقة) — مفيش قرار على بيانات قديمة.`);
  if (!row.linked) { if (action === 'OPEN') reject('الحملة مش مربوطة بمنتج متأكد منه — مفيش مخزون ولا حد ربح للفحص، فمينفعش تتفتح من CPA لوحده.'); else warnings.push('الحملة مش مربوطة بمنتج متأكد منه — مفيش حد ربح/مخزون للفحص.'); }
  if (action === 'OPEN') {
    const st = row.stock?.status; if (st === 'OUT_OF_STOCK') reject('المخزون خلص — مفيش فتح (حظر ثابت).'); else if (st === 'STOCK_UNKNOWN') warnings.push('المخزون غير معروف — تحذير (قرارك).'); else if (st === 'LOW') warnings.push('المخزون منخفض.'); else if (!row.stock) warnings.push('حالة المخزون غير متاحة.');
    if (row.cpaVsLimits === 'ABOVE_HARDSTOP') warnings.push(`CPA الفترة ${row.period.cpa} فوق Hard Stop المنتج ${row.limits.hardStop}.`); if (row.losingDays >= 3) warnings.push(`خاسرة ${row.losingDays} أيام متتالية قبل الإيقاف.`); if ((row.period.orders ?? 0) === 0) warnings.push('مفيش أوردرات في الفترة المختارة.');
  } else if (action === 'PAUSE' && row.stock?.status === 'OUT_OF_STOCK') warnings.push('بدون مخزون — سبب إضافي للإيقاف.');
  const open = row.pendingDecision; if (open && DECISION_ACTION[action] && open.action !== DECISION_ACTION[action] && ['PREPARED', 'APPROVED', 'EXECUTING'].includes(open.status)) reject(`فيه قرار مفتوح مختلف على نفس الحملة (${open.action}).`);
  if (changed) warnings.push('بيانات الحملة اتغيّرت بعد لقطة التحديد — النتيجة دي على البيانات الحالية.');
  if (action === 'PAUSE') { if (row.winner.status === 'WINNER') warnings.push('رابحة تاريخيًا — راجعها قبل أي إيقاف.'); else if (row.winner.status === 'UNKNOWN') warnings.push(`تصنيف Winner غير معروف: ${row.winner.reason}`); }
  if (action === 'OPEN') {
    const it = row.planItem?.type === 'OPEN' ? row.planItem : null;
    if (it && ['BLOCKED', 'PROTECTED'].includes(it.eligibility)) reject(`خطة الفتح اليومية حاكمة عليها ${it.eligibility === 'BLOCKED' ? 'ممنوعة' : 'محمية'}.`, it.eligibility === 'PROTECTED' ? 'PROTECTED' : 'REJECTED');
    else if (!it) warnings.push('لم تُقيَّم في خطة الفتح اليومية — الأهلية الكاملة (CPA + أوردرات + مخزون + حد الربح) بتتفحص عند إنشاء الخطة.');
    after = { status: 'ACTIVE', budget: row.budget };
  }
  if (action === 'PAUSE') after = { status: 'PAUSED', budget: row.budget };
  let delta = action === 'OPEN' ? (row.budget ?? 0) : action === 'PAUSE' ? -(row.budget ?? 0) : 0;
  if (action === 'INCREASE_BUDGET' || action === 'DECREASE_BUDGET') {
    const up = action === 'INCREASE_BUDGET';
    if (row.budget == null) reject('ميزانية الحملة غير معروفة.');
    else {
      const nb = params.mode === 'pct' ? Math.round(row.budget * (1 + (up ? 1 : -1) * params.value / 100)) : params.mode === 'amt' ? Math.round(row.budget + (up ? 1 : -1) * params.value) : Math.round(params.value);
      const d = nb - row.budget; delta = d; after = { status: row.status, budget: nb };
      if (nb <= 0) reject('الميزانية الجديدة لازم تكون أكبر من صفر.'); else if (up && d <= 0) reject('الميزانية الجديدة مش زيادة.'); else if (!up && d >= 0) reject('الميزانية الجديدة مش تقليل.');
      if (up && params.dailyCap != null && d > params.dailyCap) reject(`الزيادة ${d} فوق السقف اليومي ${params.dailyCap}.`);
      const lb = row.lastBudgetChange; if (lb?.daysAgo != null && lb.daysAgo * 24 < params.cooldownHours) reject(`Cooldown لسه ما خلصش (آخر تعديل من ${lb.daysAgo} يوم، الحد ${params.cooldownHours} ساعة).`);
      else if (lb?.daysAgo != null && lb.daysAgo < 3) warnings.push('تعديل متكرر — احتمال تأثير على مرحلة التعلم في Meta.');
      if (up && row.period.cpa != null && row.zones?.warn != null && row.period.cpa > row.zones.warn) warnings.push(`CPA ${row.period.cpa} فوق حد التحذير ${row.zones.warn}.`);
      warnings.push(row.budgetLevel === 'ABO' ? 'ABO: التعديل بيتم على ميزانيات الـ Ad Sets (مش على الحملة).' : 'CBO: التعديل على ميزانية الحملة.');
    }
  }
  return { kind, reasons, warnings, changed, before: { status: row.status, budget: row.budget }, after, budgetDelta: delta };
}

export async function reviewPreview({ user, access, body, now = new Date() }) {
  const b = body || {}; const action = String(b.action || ''); if (!ACTIONS[action]) throw bad(`الإجراء غير معروف: ${action}`);
  const params = sanitizeParams(action, b.params);
  const excluded = new Set((Array.isArray(b.excluded) ? b.excluded : []).map(String)); let refs = [], fpBy = new Map(), period = { key: 'last7' }, snap = null;
  if (b.snapshotId) { snap = await readSnapshot({ id: b.snapshotId, user, access, now }); refs = snap.items.map((i) => ({ c: i.c, a: i.a })); fpBy = new Map(snap.items.map((i) => [`${i.a}:${i.c}`, i.fp])); period = snap.query?.period || period; }
  else if (Array.isArray(b.ids)) { if (b.ids.length > 500) throw bad('الاختيار اليدوي أقصاه 500 حملة — استخدم «تحديد كل المطابق».'); refs = b.ids.map((i) => ({ c: String(i.campaignId), a: String(i.adAccountId) })); }
  else throw bad('محتاج snapshotId أو ids.');
  refs = refs.filter((r) => !excluded.has(r.c)); const today = cairoDate(now);
  const outOfScope = refs.filter((r) => !access.accounts.includes(r.a)); const inScope = refs.filter((r) => access.accounts.includes(r.a));
  const accts = [...new Set(inScope.map((r) => r.a))];
  const live = new Map(); if (accts.length) { const p = resolvePeriod({ key: period.key || 'last7', from: period.from, to: period.to }, today); const built = await buildRows({ accounts: accts, stores: access.stores, period: p, compare: false, now, noCache: true }); for (const r of built.rows) live.set(`${r.adAccountId}:${r.campaignId}`, r); }
  const items = []; let before = 0, afterSum = 0;
  for (const r of inScope) { const row = live.get(`${r.a}:${r.c}`); if (!row) { items.push({ campaignId: r.c, adAccountId: r.a, name: null, kind: 'NOT_FOUND', reasons: ['الحملة مبقتش موجودة في بيانات Meta المتزامنة.'], warnings: [], changed: true }); continue; }
    const v = verdictFor(row, action, params, { snapshotFp: fpBy.get(`${r.a}:${r.c}`) ?? null }); items.push({ campaignId: row.campaignId, adAccountId: row.adAccountId, name: row.name, productName: row.productName, status: row.status, budgetLevel: row.budgetLevel, ...v });
    if (v.kind === 'ELIGIBLE') { before += row.status === 'ACTIVE' ? row.budget ?? 0 : 0; afterSum += v.after.status === 'ACTIVE' ? v.after.budget ?? 0 : 0; } }
  const cfg = await getOperatorConfig(); const gate = ACTIONS[action].gate ? evaluateWriteGate({ config: cfg, actionType: ACTIONS[action].gate, mode: 'APPROVAL' }) : { ok: true };
  const count = (k) => items.filter((i) => i.kind === k).length;
  return {
    action, label: ACTIONS[action].label, params, snapshotId: snap?.id || null, snapshotAt: snap?.createdAt || null, previewAt: now.toISOString(),
    totals: { selected: refs.length, inScope: inScope.length, eligible: count('ELIGIBLE'), rejected: count('REJECTED') + count('NOT_FOUND'), excluded: count('EXCLUDED'), protected: count('PROTECTED'), outOfScope: outOfScope.length, changed: items.filter((i) => i.changed).length, withWarnings: items.filter((i) => i.warnings?.length).length },
    exposure: { eligibleBefore: Math.round(before), eligibleAfter: Math.round(afterSum), delta: Math.round(items.filter((i) => i.kind === 'ELIGIBLE').reduce((t, i) => t + (i.budgetDelta || 0), 0)) },
    execution: { available: !!gate.ok, reasons: gate.ok ? [] : gate.reasons.map((x) => ({ code: x.code, message: x.message })), mode: cfg.mode, note: 'أي تنفيذ بيمر على الموافقات وبوابات الأمان الحالية. الأهلية النهائية بتتفحص بالمحرك الحالي عند إنشاء الخطة، وتاني قبل التنفيذ.' },
    previewHash: previewHashOf(action, items.filter((i) => i.kind === 'ELIGIBLE').map((i) => `${i.adAccountId}:${i.campaignId}`)),
    canCreateDraft: !!access.capabilities?.prepareDrafts && CREATABLE.includes(action) && items.some((i) => i.kind === 'ELIGIBLE'),
    createDraftNote: CREATABLE.includes(action) ? (access.capabilities?.prepareDrafts ? 'حفظ المسودة = إنشاء خطة / قرارات بحالة PREPARED في النظام الحالي. ده مش اعتماد ومش تنفيذ: الاعتماد للمسؤول من مركز الموافقات، والتنفيذ بعد بوابات الأمان.' : 'حسابك مش مسموح له بإنشاء مسودات — المعاينة والتصدير فقط.') : 'الاستثناءات والأرقام المخصصة معاينة فقط في الوقت الحالي.', items,
  };
}
