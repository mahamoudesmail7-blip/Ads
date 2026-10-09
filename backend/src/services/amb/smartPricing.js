// AI Operator — SMART PRODUCT PRICING (التسعير الذكي). 2026-10-09.
// Helps the owner PRICE a product before ads run and ties the result to the CPA rules — it never changes a price anywhere, never writes Product Rules / CPA limits on its own, and never calls Meta or Easy Orders.
//   Product Landed Cost   = Wholesale + Shipping + Other costs
//   Advertising Reserve   = Expected CPA × Advertising Multiplier         (a PRICING ASSUMPTION — not a realised cost)
//   Reference Cost        = Landed Cost + Advertising Reserve
//   Markup Amount         = Reference Cost × Markup %
//   Suggested Selling Price = Reference Cost + Markup Amount
// Kept strictly apart (never blended): Estimated CPA · Advertising Reserve · Actual Meta CPA · Confirmed Delivered-Order CPA · Gross Margin · Contribution Profit · Break-even CPA.
// Meta purchases are NOT delivered orders; with unreliable COD data the profit is shown as an ESTIMATE only. Storage: operator config `limits_json.pricing[<store>:<product>]` (no schema change).
import { prisma } from '../../prisma.js';
import { policyKey } from './productPolicy.js';

export const SUGGESTED_DEFAULTS = Object.freeze({ multiplier: 3, markupPct: 85 }); // starting values the UI proposes (editable) — never stored costs
const FIELDS = ['wholesale', 'shipping', 'other', 'expectedCpa', 'multiplier', 'markupPct', 'currentPrice'];
const LABEL = { wholesale: 'سعر الجملة', shipping: 'الشحن والنقل', other: 'التغليف والمصاريف الإضافية', expectedCpa: 'CPA المتوقع لكل أوردر', multiplier: 'معامل احتياطي الإعلان', markupPct: 'نسبة الربح المضافة', currentPrice: 'سعر البيع الحالي' };
const REQUIRED = ['wholesale', 'shipping', 'other', 'expectedCpa', 'multiplier', 'markupPct']; // nothing real is ever assumed: every cost must be typed (0 is fine when typed)
const MIN_SAMPLE = { last3: 3, last7: 5, last30: 8 }; // purchases needed before an actual CPA is allowed to judge the estimate

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const toNum = (v) => (blank(v) ? null : Number(String(v).replace(/,/g, '')));

/** Normalises raw form values. Blank → null (= "not entered"). Returns {clean, errors}. NaN / negative / absurd values are errors, never silently fixed. */
export function normalizeInputs(raw = {}) {
  const clean = {}; const errors = [];
  for (const k of FIELDS) {
    const n = toNum(raw?.[k]);
    if (n === null) { clean[k] = null; continue; }
    if (!Number.isFinite(n)) { errors.push(`${LABEL[k]}: لازم يكون رقم صالح.`); clean[k] = null; continue; }
    clean[k] = n;
  }
  const rng = (k, min, max, { gtZero = false } = {}) => { const v = clean[k]; if (v === null) return; if (v < min || v > max || (gtZero && v <= 0)) errors.push(`${LABEL[k]}: لازم يكون ${gtZero ? 'أكبر من صفر و' : ''}بين ${min} و${max.toLocaleString('en-US')}.`); };
  rng('wholesale', 0, 1e7, { gtZero: true }); rng('shipping', 0, 1e6); rng('other', 0, 1e6); rng('expectedCpa', 0, 1e6); rng('multiplier', 0, 50); rng('markupPct', 0, 1000); rng('currentPrice', 0, 1e8, { gtZero: true });
  return { clean, errors };
}

const ceilTo = (x, step) => Math.ceil(x / step) * step;
/** marketing roundings — SEPARATE suggestions, each with what it does to the profit; none is ever applied automatically */
export function roundingOptions(suggested, landed, expectedCpa) {
  if (!(suggested > 0)) return [];
  const eff = (price) => ({ price, diff: r2(price - suggested), contribution: r2(price - landed - expectedCpa) });
  const out = []; const step = suggested >= 100 ? 10 : 5;
  const up = ceilTo(suggested, step); if (Math.abs(up - suggested) > 0.004) out.push({ key: 'ROUND_UP', label: `تقريب لأقرب ${step} لأعلى`, ...eff(up), note: 'لا يقلل الربح' });
  if (suggested >= 100) {
    const down = Math.floor((suggested + 1) / 100) * 100 - 1; if (down >= 99 && down < suggested) out.push({ key: 'CHARM_DOWN', label: `سعر نفسي ${down.toLocaleString('en-US')}`, ...eff(down), note: 'أقل من المقترح — يقلل الربح للأوردر' });
    const upC = Math.ceil((suggested + 1) / 100) * 100 - 1; if (upC > suggested && upC !== up) out.push({ key: 'CHARM_UP', label: `سعر نفسي ${upC.toLocaleString('en-US')}`, ...eff(upC), note: 'أعلى من المقترح — قد يقلل المبيعات' });
  }
  return out;
}

/** profitability at ONE price. contribution is an ESTIMATE (it uses the owner's expected CPA, not an observed one). */
export function analyzePrice({ price, landed, expectedCpa }) {
  if (!(price > 0)) return null;
  const grossMargin = r2(((price - landed) / price) * 100); // before advertising
  const contribution = r2(price - landed - expectedCpa); // per delivered order, after the EXPECTED ad cost
  const breakEvenCpa = r2(price - landed); // the CPA at which the contribution is exactly 0
  return { price: r2(price), grossMarginPct: grossMargin, contributionPerOrder: contribution, contributionMarginPct: r2((contribution / price) * 100), breakEvenCpa, safetyMarginPct: breakEvenCpa > 0 ? r2(((breakEvenCpa - expectedCpa) / breakEvenCpa) * 100) : null, estimateOnly: true };
}

/** The formula + analysis. status: OK | INCOMPLETE (a required value is missing — NOTHING is computed) | INVALID. */
export function computePricing(raw = {}) {
  const { clean: i, errors } = normalizeInputs(raw);
  const missing = REQUIRED.filter((k) => i[k] === null && !errors.some((e) => e.startsWith(LABEL[k])));
  if (errors.length) return { status: 'INVALID', errors, missing, inputs: i };
  if (missing.length) return { status: 'INCOMPLETE', missing: missing.map((k) => ({ key: k, label: LABEL[k] })), inputs: i, note: 'ناقص مدخلات — ما اتحسبش أي رقم. السيستم ما بيفترضش أي تكلفة.' };
  const landed = r2(i.wholesale + i.shipping + i.other); const adReserve = r2(i.expectedCpa * i.multiplier); const reference = r2(landed + adReserve);
  const markupAmount = r2(reference * (i.markupPct / 100)); const suggested = r2(reference + markupAmount);
  const analysis = analyzePrice({ price: suggested, landed, expectedCpa: i.expectedCpa });
  const rounding = roundingOptions(suggested, landed, i.expectedCpa);
  const scenarios = [['محافظ', Math.max(0, i.markupPct - 25)], ['متوازن (اختيارك)', i.markupPct], ['هامش أعلى', i.markupPct + 15]].map(([name, m]) => { const price = r2(reference + reference * (m / 100)); return { name, markupPct: m, price, contributionPerOrder: r2(price - landed - i.expectedCpa) }; });
  const current = i.currentPrice != null ? { ...analyzePrice({ price: i.currentPrice, landed, expectedCpa: i.expectedCpa }), diffToSuggested: r2(suggested - i.currentPrice), diffToSuggestedPct: r2(((suggested - i.currentPrice) / i.currentPrice) * 100) } : null;
  return {
    status: 'OK', inputs: i,
    steps: { landed, adReserve, reference, markupAmount, suggested },
    formula: { landed: `${i.wholesale} + ${i.shipping} + ${i.other}`, adReserve: `${i.expectedCpa} × ${i.multiplier}`, reference: `${landed} + ${adReserve}`, markupAmount: `${reference} × ${i.markupPct}%`, suggested: `${reference} + ${markupAmount}` },
    analysis, rounding, scenarios, current,
    notes: ['احتياطي الإعلان افتراض تسعير وليس تكلفة فعلية متحققة.', 'السعر المقترح اقتراح فقط: لا يتم تغيير أي سعر في المتجر أو Easy Orders.', 'الربح هنا تقدير مبني على CPA المتوقع — مش على أوردرات مسلّمة.'],
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// actual performance vs the estimate (Meta purchases ≠ delivered orders)
// ---------------------------------------------------------------------------------------------------------------------------------------------
/** windows: [{key:'last3'|'last7'|'last30', spend, purchases, cod:{dataState, sample, delivered, deliveryRate}}]. Pure. */
export function compareWithActual({ expectedCpa, landed = null, price = null, windows = [] }) {
  return windows.map((w) => {
    const spend = Number(w.spend) || 0, purchases = Number(w.purchases) || 0; const need = MIN_SAMPLE[w.key] ?? 5;
    const metaCpa = purchases > 0 ? r2(spend / purchases) : null; // spend / META purchases of the same window
    const cod = w.cod || {}; const codTrusted = cod.dataState === 'AVAILABLE' && cod.deliveryRate != null && Number(cod.delivered) > 0; // rates are null when the COD sample is too small or the statuses are unreliable
    const deliveredCpa = codTrusted && spend > 0 ? r2(spend / Number(cod.delivered)) : null;
    const sufficient = purchases >= need;
    const verdict = !sufficient ? 'INSUFFICIENT_SAMPLE' : metaCpa === null ? 'NO_DATA' : metaCpa <= expectedCpa ? 'BETTER' : metaCpa <= expectedCpa * 1.1 ? 'ON_TARGET' : 'WORSE';
    const profit = (cpa) => (cpa != null && price > 0 && landed != null ? r2(price - landed - cpa) : null);
    return { key: w.key, spend: r2(spend), purchases, minSample: need, sufficient, metaCpa, deltaVsExpected: metaCpa != null ? r2(metaCpa - expectedCpa) : null, deltaVsExpectedPct: metaCpa != null && expectedCpa > 0 ? r2(((metaCpa - expectedCpa) / expectedCpa) * 100) : null, verdict,
      deliveredCpa, codTrusted, codReason: codTrusted ? null : cod.dataState === 'AVAILABLE' ? 'عينة COD صغيرة أو حالات الأوردرات غير موثوقة' : 'لا توجد بيانات COD', sampleCod: cod.sample ?? null,
      contributionByMetaCpa: profit(metaCpa), contributionByDeliveredCpa: profit(deliveredCpa), profitConfirmed: deliveredCpa != null };
  });
}

/** explainable, evidence-gated recommendations. Never a command: nothing here changes a price or a rule. */
export function buildRecommendations({ computed, comparison = [], currentPrice = null }) {
  const out = []; const add = (level, title, why) => out.push({ level, title, why });
  if (computed?.status !== 'OK') { add('info', 'أكمل المدخلات الأول', 'السيستم ما بيفترضش أي تكلفة — محتاج كل القيم تتكتب عشان يحسب السعر.'); return out; }
  const { steps, analysis, inputs } = computed;
  if (analysis.safetyMarginPct != null && analysis.safetyMarginPct < 20) add('warn', 'هامش الأمان ضيق', `نقطة التعادل ${analysis.breakEvenCpa} ج.م مقابل CPA متوقع ${inputs.expectedCpa} — هامش الأمان ${analysis.safetyMarginPct}% بس.`);
  if (currentPrice != null) {
    const c = computed.current;
    if (c.contributionPerOrder < 0) add('bad', 'السعر الحالي لا يغطي التكلفة + CPA المتوقع', `الربح المتوقع للأوردر ${c.contributionPerOrder} ج.م (تقدير). السعر المقترح ${steps.suggested} ج.م.`);
    else if (c.diffToSuggested > 0) add('info', 'السعر الحالي أقل من المقترح', `الفرق ${c.diffToSuggested} ج.م (${c.diffToSuggestedPct}%). الربح المتوقع للأوردر الآن ${c.contributionPerOrder} ج.م مقابل ${analysis.contributionPerOrder} عند المقترح.`);
    else add('good', 'السعر الحالي أعلى من المقترح أو مساوي له', `الربح المتوقع للأوردر ${c.contributionPerOrder} ج.م (تقدير).`);
  }
  const usable = comparison.filter((w) => w.sufficient && w.metaCpa != null);
  if (!comparison.length || !comparison.some((w) => w.purchases > 0)) add('info', 'لا توجد بيانات إعلانات حقيقية للمقارنة', 'التقدير مبني على CPA المتوقع بس. بعد ما الحملات تجيب أوردرات هتتقارن بالفعلي (3 / 7 / 30 يوم).');
  else if (!usable.length) add('info', 'عينة الإعلانات صغيرة', 'عدد أوردرات Meta أقل من الحد الأدنى للحكم في كل الفترات — مفيش حكم على CPA المتوقع لسه.');
  for (const w of usable) {
    const nm = { last3: '3 أيام', last7: '7 أيام', last30: '30 يوم' }[w.key];
    if (w.verdict === 'WORSE') add(w.metaCpa > analysis.breakEvenCpa ? 'bad' : 'warn', `CPA الفعلي (${nm}) أسوأ من المتوقع`, `${w.metaCpa} ج.م مقابل ${inputs.expectedCpa} (+${w.deltaVsExpectedPct}%).${w.metaCpa > analysis.breakEvenCpa ? ` وهو أعلى من نقطة التعادل ${analysis.breakEvenCpa} — الأوردر خسارة عند السعر المقترح.` : ''}`);
    else add('good', `CPA الفعلي (${nm}) ${w.verdict === 'BETTER' ? 'أفضل من' : 'قريب من'} المتوقع`, `${w.metaCpa} ج.م مقابل ${inputs.expectedCpa} — بناءً على ${w.purchases} أوردر من Meta.`);
  }
  if (comparison.some((w) => w.purchases > 0) && !comparison.some((w) => w.profitConfirmed)) add('warn', 'الربحية غير مؤكدة', 'أوردرات Meta مش أوردرات مسلّمة، وبيانات COD غير كافية/موثوقة — الربح المعروض تقدير فقط.');
  if (comparison.some((w) => w.profitConfirmed)) add('info', 'CPA الأوردر المسلّم متاح', 'محسوب من الصرف ÷ الأوردرات المسلّمة فعليًا (Easy Orders)، وهو الأقرب للربح الحقيقي.');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// storage (operator config JSON — same pattern as the product policies; no schema change)
// ---------------------------------------------------------------------------------------------------------------------------------------------
const key = (storeId, productId) => policyKey(storeId, productId);
async function readAll() { const row = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const raw = j(row?.limits_json, null) || {}; return { raw, all: raw.pricing || {} }; }
async function writeAll(raw, all, userId) { await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify({ ...raw, pricing: all }), updated_by_id: userId ?? null } }); }
const audit = (userId, kind, input) => prisma.aiAuditLog.create({ data: { actor_id: userId ?? null, kind, action: 'EXECUTE', input_json: JSON.stringify(input).slice(0, 3500), success: true } }).catch(() => {});
const event = (userId, kind, note, data = {}) => prisma.ambOperatorEvent.create({ data: { kind, actor: 'USER', actor_id: userId ?? null, note, data_json: JSON.stringify(data).slice(0, 3500) } }).catch(() => {});
const fail = (status, message, code) => { const e = new Error(message); e.status = status; if (code) e.code = code; return e; };
async function requireAdmin(userId, deps = {}) { const u = deps.user || await prisma.user.findUnique({ where: { id: Number(userId) }, select: { id: true, role: true, status: true } }); if (!u || u.role !== 'ADMIN' || u.status !== 'ACTIVE') throw fail(403, 'ده محتاج ADMIN.'); return u; }

export async function getPricingState({ productId, storeId }) {
  const { all } = await readAll(); const e = all[key(storeId, productId)] || null;
  return { key: key(storeId, productId), draft: e?.draft || null, approved: e?.approved || null, history: (e?.history || []).slice(-10).reverse() };
}
/** DRAFT: incomplete values are fine (blank stays blank); invalid numbers are refused. Changes nothing but this draft. */
export async function savePricingDraft({ productId, storeId, inputs, userId, deps = {} }) {
  await requireAdmin(userId, deps); const { clean, errors } = normalizeInputs(inputs); if (errors.length) { const e = fail(400, errors.join(' '), 'INVALID_INPUTS'); e.details = errors; throw e; }
  const { raw, all } = await readAll(); const k = key(storeId, productId); const cur = all[k] || {};
  all[k] = { ...cur, draft: { inputs: clean, savedAt: new Date().toISOString(), savedById: Number(userId) } };
  await writeAll(raw, all, userId); await audit(userId, 'OPERATOR_PRICING_DRAFT', { key: k, inputs: clean }); await event(userId, 'PRICING_DRAFT_SAVED', `حفظ مسودة تسعير المنتج ${k} (لم يتغير أي سعر)`, { key: k });
  return getPricingState({ productId, storeId });
}
/** "اعتماد السعر المقترح" — records the owner's decision INSIDE the Operator only. Requires confirm + a complete OK computation + a price that is one of the computed options. Never touches Easy Orders / the store / AmbProduct prices. */
export async function approvePrice({ productId, storeId, inputs, price, confirm, userId, deps = {} }) {
  await requireAdmin(userId, deps); if (confirm !== true) throw fail(400, 'محتاج تأكيد صريح لاعتماد السعر.', 'CONFIRM_REQUIRED');
  const c = computePricing(inputs); if (c.status !== 'OK') throw fail(400, c.status === 'INCOMPLETE' ? 'المدخلات ناقصة — مفيش سعر يتعتمد.' : (c.errors || []).join(' '), 'NOT_COMPUTABLE');
  const allowed = [c.steps.suggested, ...c.rounding.map((r) => r.price)]; const chosen = r2(Number(price ?? c.steps.suggested));
  if (!allowed.some((p) => Math.abs(p - chosen) < 0.005)) throw fail(400, 'السعر لازم يكون السعر المقترح أو أحد التقريبات المعروضة.', 'PRICE_NOT_OFFERED');
  const { raw, all } = await readAll(); const k = key(storeId, productId); const cur = all[k] || {};
  const rec = { price: chosen, suggested: c.steps.suggested, inputs: c.inputs, steps: c.steps, analysis: analyzePrice({ price: chosen, landed: c.steps.landed, expectedCpa: c.inputs.expectedCpa }), approvedAt: new Date().toISOString(), approvedById: Number(userId), appliedToStore: false };
  all[k] = { ...cur, approved: rec, history: [...(cur.history || []), { at: rec.approvedAt, by: Number(userId), price: chosen, suggested: c.steps.suggested, inputs: c.inputs }].slice(-30) };
  await writeAll(raw, all, userId); await audit(userId, 'OPERATOR_PRICING_APPROVED', { key: k, price: chosen, suggested: c.steps.suggested }); await event(userId, 'PRICING_APPROVED', `اعتماد سعر مقترح ${chosen} للمنتج ${k} داخل الـOperator فقط — لم يتغير سعر المتجر/Easy Orders`, { key: k, price: chosen });
  return { ...(await getPricingState({ productId, storeId })), note: 'اتسجل داخل الـOperator بس. لم يتغير أي سعر في المتجر أو Easy Orders.' };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Integration with Product Rules: PREVIEW first (writes nothing); APPLY only with confirm + the exact fields the owner ticked
// ---------------------------------------------------------------------------------------------------------------------------------------------
const ECON_MAP = [ // [field, label, inputKey, optional]
  ['product_cost', 'تكلفة المنتج (الجملة)', 'wholesale', false], ['shipping_cost', 'تكلفة الشحن', 'shipping', false], ['other_cost', 'التغليف والمصاريف الإضافية', 'other', false], ['target_cpa', 'Target CPA (من CPA المتوقع)', 'expectedCpa', true],
];
export const APPLY_FIELDS = [...ECON_MAP.map((m) => m[0]), 'policy.cpa.hardStop'];
async function loadAmb(productId) { return prisma.ambProduct.findUnique({ where: { product_id: Number(productId) } }); }
export async function previewApplyToRules({ productId, storeId, inputs, PP }) {
  const c = computePricing(inputs); if (c.status !== 'OK') return { ok: false, status: c.status, message: c.status === 'INCOMPLETE' ? 'المدخلات ناقصة — مفيش حاجة تتطبق.' : (c.errors || []).join(' '), changes: [] };
  const amb = await loadAmb(productId); const pol = PP ? await PP.getProductPolicy({ productId, storeId }) : null; const changes = [];
  for (const [field, label, ik, optional] of ECON_MAP) { const from = amb ? amb[field] ?? null : null; const to = c.inputs[ik]; changes.push({ target: 'PRODUCT_ECONOMICS', field, label, from, to, changed: from === null || Number(from) !== Number(to), optional, defaultOn: !optional }); }
  const hs = pol?.draft?.cpa?.hardStop ?? null; changes.push({ target: 'POLICY_DRAFT', field: 'policy.cpa.hardStop', label: 'Hard Stop CPA في مسودة قواعد المنتج (= نقطة التعادل)', from: hs, to: c.analysis.breakEvenCpa, changed: hs === null || Number(hs) !== Number(c.analysis.breakEvenCpa), optional: true, defaultOn: false, warning: 'نقطة التعادل = أقصى CPA قبل ما الأوردر يبقى بدون ربح. اختيارك لو عايزها حد إيقاف.' });
  const warnings = []; if (amb && Number(amb.packaging_cost) > 0) warnings.push(`فيه تكلفة تغليف محفوظة (${amb.packaging_cost}) — هتفضل زي ما هي. تأكد إن «التغليف والمصاريف الإضافية» مش مكررة.`);
  if (!amb) warnings.push('المنتج مالوش سجل اقتصاديات (AmbProduct) — هيتعمل من الكتالوج عند التطبيق.');
  if (!(Number(amb?.actual_selling_price) > 0)) warnings.push('تحديث تكلفة المنتج بيعيد حساب «سعر البيع المقترح القديم» (تكلفة × معامل التسعير الحالي) المستخدم في حسابات الربح الداخلية لما مفيش سعر بيع فعلي محفوظ. ده مش سعر المتجر ومش سعر Easy Orders.');
  return { ok: true, changes, warnings, priceUnchanged: true, note: 'السعر نفسه ما بيتغيرش. مفيش حاجة بتتحفظ أو بتتفعّل في المعاينة، ومسودة القواعد عمرها ما بتتفعّل من هنا.' };
}
export async function applyToRules({ productId, storeId, inputs, fields, confirm, userId, PP, ambProducts, deps = {} }) {
  await requireAdmin(userId, deps); if (confirm !== true) throw fail(400, 'محتاج تأكيد صريح لتطبيق النتائج على قواعد المنتج.', 'CONFIRM_REQUIRED');
  const list = Array.isArray(fields) ? [...new Set(fields)] : []; if (!list.length) throw fail(400, 'اختار الحقول اللي عايز تطبقها.', 'NO_FIELDS'); const bad = list.filter((f) => !APPLY_FIELDS.includes(f)); if (bad.length) throw fail(400, `حقول غير مسموحة: ${bad.join(', ')}`, 'FIELD_NOT_ALLOWED');
  const c = computePricing(inputs); if (c.status !== 'OK') throw fail(400, 'المدخلات ناقصة أو غير صالحة.', 'NOT_COMPUTABLE');
  const econ = {}; for (const [field, , ik] of ECON_MAP) if (list.includes(field)) econ[field] = c.inputs[ik];
  const before = await loadAmb(productId); const applied = { economics: null, policyDraft: null };
  if (Object.keys(econ).length) { let amb = before; if (!amb) amb = await ambProducts.createFromCatalogProduct(productId, userId); applied.economics = await ambProducts.updateProduct(amb.id, econ); }
  if (list.includes('policy.cpa.hardStop')) { const pol = await PP.getProductPolicy({ productId, storeId }); const draft = JSON.parse(JSON.stringify(pol.draft || pol.active || {})); draft.cpa = { ...(draft.cpa || {}), hardStop: c.analysis.breakEvenCpa }; applied.policyDraft = (await PP.saveDraft({ productId, storeId, policy: draft, userId, deps })).status; }
  await audit(userId, 'OPERATOR_PRICING_APPLIED_TO_RULES', { productId, storeId, fields: list, econ, hardStop: list.includes('policy.cpa.hardStop') ? c.analysis.breakEvenCpa : null }); await event(userId, 'PRICING_APPLIED_TO_RULES', `تطبيق نتائج التسعير على قواعد المنتج ${key(storeId, productId)}: ${list.join(', ')} (مسودة فقط — لم يُفعَّل شيء ولم يتغير سعر)`, { productId, fields: list });
  return { ok: true, applied, fields: list, policyActivated: false, priceChanged: false };
}
