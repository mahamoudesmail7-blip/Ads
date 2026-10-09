// opx-pricing.js — «التسعير الذكي» (Beta): price a product BEFORE ads run and tie the result to the CPA rules.
// Presentation over /api/operator/pricing/*. It SUGGESTS only: it never changes a store / Easy Orders price, never activates a rule and never talks to Meta.
// Kept apart on screen (never blended): the owner's ESTIMATES (CPA, ad reserve) · actual Meta CPA (Meta purchases ≠ delivered orders) · confirmed delivered-order CPA (only with trusted COD data).
import { api } from './api-client.js';
import { E, $, num, egp, ICONS, kpiCard, pill, skeletonRows, openDrawer, closeDrawer, toast, confirmModal, thumb, hydrateThumbs, store } from './opx-ui.js';

const S = { ctx: null, root: null, products: [], cur: null, detail: null, inputs: {}, res: null, seq: 0, timer: null, defaults: { multiplier: 3, markupPct: 85 }, win: 'last7', saving: false };
const f2 = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const money = (n) => (n === null || n === undefined ? '—' : `${f2(n)} جنيه`);
const FIELDS = [['wholesale', 'سعر الجملة', 'جنيه', 1], ['shipping', 'الشحن والنقل', 'جنيه', 1], ['other', 'التغليف والمصاريف الإضافية', 'جنيه', 1], ['expectedCpa', 'CPA المتوقع لكل أوردر', 'جنيه', 2], ['multiplier', 'معامل احتياطي الإعلان', 'مرة', 2], ['markupPct', 'نسبة الربح المضافة', '%', 3], ['currentPrice', 'سعر البيع الحالي', 'جنيه', 4]];
const HINT = { expectedCpa: 'تكلفة الإعلان المتوقعة لكل أوردر — تقدير منك، مش رقم فعلي.', multiplier: 'بيحجز مبلغ للإعلان داخل السعر (CPA × المعامل). المقترح 3 وتقدر تغيّره — ده افتراض تسعير مش تكلفة حقيقية.', markupPct: 'نسبة الربح المضافة فوق التكلفة المرجعية (مثال 85%). تقدر تغيّرها.', other: 'تغليف وأي مصاريف إضافية. اكتب 0 لو مفيش — السيستم مش بيفترض.' };
const VERDICT = { BETTER: ['green', 'أفضل من المتوقع'], ON_TARGET: ['blue', 'قريب من المتوقع'], WORSE: ['red', 'أسوأ من المتوقع'], INSUFFICIENT_SAMPLE: ['gray', 'عينة غير كافية'], NO_DATA: ['gray', 'لا بيانات'] };
const WINL = { last3: 'آخر 3 أيام', last7: 'آخر 7 أيام', last30: 'آخر 30 يوم' };
const LVL = { good: ['green', '✓'], warn: ['amber', '!'], bad: ['red', '✕'], info: ['blue', 'i'] };

export async function mountPricingWorkspace(root, ctx) {
  S.ctx = ctx; S.root = root; S.cur = null; S.detail = null; S.res = null; S.inputs = {};
  root.innerHTML = `<div class="opx-card">${skeletonRows(6)}</div>`;
  try { S.products = (await api.get('/api/operator/pricing/products')).products; } catch (e) { root.innerHTML = `<div class="opx-card opx-empty">⚠️ ${E(e.message)}</div>`; return; }
  const last = store.get('opx.pricing.key', ''); S.cur = S.products.find((p) => p.key === last) || S.products[0] || null;
  shell(); if (S.cur) await pick(S.cur.key);
}
const need = () => S.products.filter((p) => !p.economicsComplete).length;

function shell() {
  const incomplete = need();
  S.root.innerHTML = `
    <div class="opx-card opx-head opx-fade"><div class="opx-head-icon violet">${ICONS.coins}</div><div class="grow"><h1>التسعير الذكي ${pill('Beta', 'violet')}</h1><p>احسب السعر المقترح للمنتج بناءً على التكلفة والإعلان وهامش الربح — اقتراح فقط، مفيش سعر بيتغيّر تلقائيًا.</p></div>
      <div class="opx-state"><span class="opx-switch" aria-hidden="true"></span><div><b>لا يغيّر أسعار ولا قواعد</b><small>السعر في المتجر و Easy Orders ما بيتلمسش</small></div></div></div>
    <div class="opx-price" id="prRoot">
      <section class="opx-card opx-price-in" id="prIn"></section>
      <section class="opx-price-mid" id="prMid"></section>
      <section class="opx-price-out" id="prOut"></section>
    </div>
    ${incomplete ? `<p class="opx-note" style="margin-top:10px">${num(incomplete)} منتج بدون اقتصاديات مكتملة — اختار المنتج وكمّل الخطوات.</p>` : ''}`;
}
async function pick(key) {
  S.cur = S.products.find((p) => p.key === key) || S.cur; store.set('opx.pricing.key', S.cur.key); S.res = null;
  $('prIn').innerHTML = `<div style="padding:16px">${skeletonRows(5)}</div>`; $('prMid').innerHTML = ''; $('prOut').innerHTML = '';
  try { S.detail = await api.get(`/api/operator/pricing/${S.cur.productId}`, { storeId: S.cur.storeId }); } catch (e) { $('prIn').innerHTML = `<div class="opx-empty">⚠️ ${E(e.message)}</div>`; return; }
  S.defaults = S.detail.suggestedDefaults || S.defaults; const d = S.detail.state?.draft?.inputs; const ec = S.detail.economics;
  // values come ONLY from what the owner already saved (a draft, or the product's saved economics); the two proposed starting values are labelled as such
  S.inputs = d ? { ...d } : { wholesale: ec?.productCost > 0 ? ec.productCost : null, shipping: ec?.shippingCost > 0 ? ec.shippingCost : null, other: null, expectedCpa: ec?.targetCpa > 0 ? ec.targetCpa : null, multiplier: null, markupPct: null, currentPrice: ec?.currentPrice > 0 ? ec.currentPrice : (S.cur.currentPrice || null) };
  S.usedDefaults = { multiplier: S.inputs.multiplier == null, markupPct: S.inputs.markupPct == null };
  if (S.inputs.multiplier == null) S.inputs.multiplier = S.defaults.multiplier; if (S.inputs.markupPct == null) S.inputs.markupPct = S.defaults.markupPct;
  drawInputs(); await analyze();
}
const val = (k) => (S.inputs[k] === null || S.inputs[k] === undefined ? '' : S.inputs[k]);
function field([k, label, unit]) {
  const miss = S.res?.computed?.status === 'INCOMPLETE' && S.res.computed.missing.some((m) => m.key === k);
  return `<label class="opx-field ${miss ? 'miss' : ''}"><span>${label}${['wholesale', 'shipping', 'other', 'expectedCpa', 'multiplier', 'markupPct'].includes(k) ? '<i>*</i>' : ' <em class="opt">(اختياري)</em>'}${HINT[k] ? ` <em class="q" title="${E(HINT[k])}">؟</em>` : ''}</span><div class="opx-unit"><input class="opx-input" id="pf_${k}" data-k="${k}" type="text" inputmode="decimal" autocomplete="off" value="${E(val(k))}" placeholder="${k === 'currentPrice' ? 'اختياري' : ''}"><b>${unit}</b></div>${k === 'multiplier' && S.usedDefaults.multiplier ? '<small class="opx-note">قيمة مقترحة قابلة للتعديل</small>' : ''}${k === 'markupPct' && S.usedDefaults.markupPct ? '<small class="opx-note">قيمة مقترحة قابلة للتعديل</small>' : ''}</label>`;
}
function drawInputs() {
  const p = S.cur; const admin = S.ctx.isAdmin; const incomplete = !p.economicsComplete;
  $('prIn').innerHTML = `
    <h3 class="opx-sec">اختر المنتج</h3>
    <div class="opx-pick"><div class="opx-pick-t">${thumb(p.productId, p.name)}<div><b>${E(p.name)}</b><small>#${p.productId} · ${num(p.campaigns)} حملة</small></div></div>
      <select class="opx-select" id="prSel" aria-label="المنتج">${S.products.map((x) => `<option value="${E(x.key)}" ${x.key === p.key ? 'selected' : ''}>${E(x.name)} — #${x.productId}${x.economicsComplete ? '' : ' (ناقص)'}</option>`).join('')}</select></div>
    ${incomplete ? `<div class="opx-notice amber opx-wiz"><div class="grow"><b>اقتصاديات المنتج ناقصة — معالج التسعير</b><small>ناقص: ${E(p.missing.join('، '))}. اكتب القيم الحقيقية بنفسك — السيستم مش بيفترض أي تكلفة.</small></div></div>` : ''}
    <h3 class="opx-sec"><i>1</i> تكلفة المنتج والمصاريف</h3><div class="opx-fields">${FIELDS.filter((x) => x[3] === 1).map(field).join('')}</div>
    <h3 class="opx-sec"><i>2</i> إعدادات الإعلان</h3><div class="opx-fields">${FIELDS.filter((x) => x[3] === 2).map(field).join('')}</div>
    <h3 class="opx-sec"><i>3</i> هامش الربح</h3><div class="opx-fields">${FIELDS.filter((x) => x[3] === 3).map(field).join('')}</div>
    <h3 class="opx-sec"><i>4</i> السعر الحالي (اختياري)</h3><div class="opx-fields">${FIELDS.filter((x) => x[3] === 4).map(field).join('')}</div>
    <div id="prErr"></div>
    <div class="opx-price-btns"><button class="opx-btn" id="prDraft" ${admin ? '' : 'disabled title="ADMIN فقط"'}>${ICONS.history} حفظ كمسودة</button><button class="opx-btn primary" id="prCalc">${ICONS.target} حساب السعر المقترح</button></div>
    ${S.detail.state?.draft ? `<small class="opx-note">آخر مسودة: ${E(new Date(S.detail.state.draft.savedAt).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' }))}</small>` : ''}`;
  hydrateThumbs($('prIn'));
  $('prSel').onchange = (e) => pick(e.target.value);
  $('prIn').querySelectorAll('input[data-k]').forEach((i) => { i.oninput = () => { S.inputs[i.dataset.k] = i.value; S.usedDefaults[i.dataset.k] = false; clearTimeout(S.timer); S.timer = setTimeout(analyze, 300); }; });
  $('prCalc').onclick = async () => { await analyze(); $('prMid').scrollIntoView?.({ behavior: 'smooth', block: 'start' }); };
  $('prDraft').onclick = saveDraft;
}
async function analyze() {
  const my = ++S.seq;
  try { const r = await api.post(`/api/operator/pricing/${S.cur.productId}/analyze`, { inputs: S.inputs }); if (my !== S.seq) return; S.res = r; } catch (e) { if (my !== S.seq) return; S.res = null; $('prErr').innerHTML = `<div class="opx-note bad">⚠️ ${E(e.message)}</div>`; return; }
  const c = S.res.computed; $('prErr').innerHTML = c.status === 'INVALID' ? `<div class="opx-note bad">${c.errors.map((x) => `⚠️ ${E(x)}`).join('<br>')}</div>` : c.status === 'INCOMPLETE' ? `<div class="opx-note">ناقص: ${E(c.missing.map((m) => m.label).join('، '))}</div>` : '';
  $('prIn').querySelectorAll('.opx-field').forEach((el) => { const k = el.querySelector('input').dataset.k; el.classList.toggle('miss', c.status === 'INCOMPLETE' && c.missing.some((m) => m.key === k)); });
  drawResults();
}
function drawResults() {
  const r = S.res; const c = r?.computed;
  if (!c || c.status !== 'OK') {
    $('prMid').innerHTML = `<div class="opx-card opx-price-empty"><div class="opx-head-icon violet">${ICONS.coins}</div><b>${c?.status === 'INVALID' ? 'فيه قيمة غير صالحة' : 'كمّل المدخلات عشان يتحسب السعر'}</b><small>${c?.status === 'INCOMPLETE' ? E('ناقص: ' + c.missing.map((m) => m.label).join('، ')) : ''}</small><small>مفيش أي رقم بيتحسب بقيمة مفترضة — السيستم محتاج تكاليفك الحقيقية.</small></div>`;
    $('prOut').innerHTML = `<div class="opx-card opx-panel"><h3>توصيات ذكية</h3>${recs(r?.recommendations)}</div>`; return;
  }
  const st = c.steps, a = c.analysis, admin = S.ctx.isAdmin;
  const row = (k, v, strong) => `<div class="opx-kv ${strong ? 'strong' : ''}"><span>${k}</span><b>${v}</b></div>`;
  $('prMid').innerHTML = `
    <div class="opx-card opx-price-hero"><div class="opx-price-tag">${ICONS.coins}<span>السعر المقترح</span></div><div class="opx-price-big" id="prBig">${f2(st.suggested)} <small>جنيه</small></div><small>حسب المعادلة المحددة</small></div>
    <div class="opx-card opx-panel"><h3>تفاصيل الحساب</h3>
      ${row('تكلفة المنتج بالمصاريف', f2(st.landed))}${row(`احتياطي الإعلان (${c.inputs.expectedCpa} × ${c.inputs.multiplier})`, `${f2(st.adReserve)} <em class="asm">افتراض تسعير</em>`)}${row('إجمالي التكلفة المرجعية', f2(st.reference))}${row(`الربح المضاف (${c.inputs.markupPct}%)`, f2(st.markupAmount))}${row('السعر المقترح', f2(st.suggested), true)}
      <button class="opx-btn ghost sm" id="prAdv">${ICONS.eye} التفاصيل المتقدمة</button></div>
    ${c.rounding.length ? `<div class="opx-card opx-panel opx-round"><h3>سعر مقترح بعد التقريب التسويقي <small class="opx-note">اقتراح منفصل — مش تغيير تلقائي</small></h3>${c.rounding.map((o) => `<div class="opx-round-i"><b>${f2(o.price)} جنيه</b><span>${E(o.label)}</span><small><bdi dir="ltr">${o.diff > 0 ? '+' : ''}${f2(o.diff)}</bdi> عن المقترح · ربح الأوردر ${f2(o.contribution)} · ${E(o.note)}</small></div>`).join('')}</div>` : ''}
    <div class="opx-card opx-panel"><h3>بدائل تسعير <small class="opx-note">سيناريوهات من نفس مدخلاتك</small></h3><div class="opx-scn">${c.scenarios.map((s, i) => `<div class="opx-scn-i ${i === 1 ? 'on' : ''}"><small>${E(s.name)}</small><span>هامش ${s.markupPct}%</span><b>${f2(s.price)}</b><small>ربح ${f2(s.contributionPerOrder)}</small></div>`).join('')}</div></div>
    <div class="opx-price-btns"><button class="opx-btn primary" id="prApprove" ${admin ? '' : 'disabled title="ADMIN فقط"'}>${ICONS.check} اعتماد السعر المقترح</button><button class="opx-btn" id="prRules" ${admin ? '' : 'disabled title="ADMIN فقط"'}>${ICONS.rules} استخدام نتائج التسعير في قواعد المنتج</button></div>
    ${S.detail.state?.approved ? `<small class="opx-note">آخر سعر معتمد داخل الـOperator: <b>${f2(S.detail.state.approved.price)}</b> · لم يُطبَّق على المتجر</small>` : ''}`;
  $('prOut').innerHTML = analysisHtml(r);
  $('prAdv').onclick = advanced; $('prApprove').onclick = approve; $('prRules').onclick = rulesPreview;
  $('prOut').querySelectorAll('[data-win]').forEach((b) => { b.onclick = () => { S.win = b.dataset.win; $('prOut').innerHTML = analysisHtml(S.res); wireWin(); }; }); wireWin();
}
function wireWin() { $('prOut').querySelectorAll('[data-win]').forEach((b) => { b.onclick = () => { S.win = b.dataset.win; $('prOut').innerHTML = analysisHtml(S.res); wireWin(); }; }); }
function analysisHtml(r) {
  const c = r.computed, a = c.analysis, w = r.comparison.find((x) => x.key === S.win) || r.comparison[1];
  const kv = (k, v, cls = '') => `<div class="opx-kv ${cls}"><span>${k}</span><b>${v}</b></div>`;
  const cur = c.current;
  return `
    <div class="opx-card opx-panel"><h3>${ICONS.target} تحليل الربحية <span class="opx-tag-est">تقدير</span></h3>
      <small class="opx-note">محسوب من مدخلاتك (CPA المتوقع) — مش من أوردرات مسلّمة.</small>
      ${kv('سعر البيع المقترح', money(c.steps.suggested))}${kv('التكلفة المرجعية', money(c.steps.reference))}${kv('هامش الربح الإجمالي (قبل الإعلان)', `${f2(a.grossMarginPct)}%`, a.grossMarginPct < 0 ? 'bad' : 'good')}${kv('الربح المتوقع للأوردر (Contribution)', money(a.contributionPerOrder), a.contributionPerOrder < 0 ? 'bad' : 'good')}
      ${kv('CPA المتوقع (تقديري)', money(c.inputs.expectedCpa))}${kv('نقطة تعادل CPA', `${money(a.breakEvenCpa)} <em class="q" title="أقصى CPA قبل ما الربح يوصل صفر عند هذا السعر = السعر − التكلفة">؟</em>`)}${kv('هامش الأمان', a.safetyMarginPct == null ? '—' : `${f2(a.safetyMarginPct)}%`, a.safetyMarginPct != null && a.safetyMarginPct < 20 ? 'bad' : '')}
      ${cur ? `<hr class="opx-hr">${kv('السعر الحالي', money(cur.price))}${kv('الفرق للمقترح', `<bdi dir="ltr">${cur.diffToSuggested > 0 ? '+' : ''}${f2(cur.diffToSuggested)} (${f2(cur.diffToSuggestedPct)}%)</bdi>`)}${kv('ربح الأوردر بالسعر الحالي', money(cur.contributionPerOrder), cur.contributionPerOrder < 0 ? 'bad' : 'good')}` : ''}</div>
    <div class="opx-card opx-panel"><h3>${ICONS.history} مقارنة مع الأداء الفعلي <span class="opx-tag-act">فعلي</span></h3>
      <div class="opx-chips" role="tablist">${r.comparison.map((x) => `<button class="opx-chip ${x.key === (w?.key) ? 'on' : ''}" data-win="${x.key}">${WINL[x.key]}</button>`).join('')}</div>
      ${w ? `${kv('CPA الفعلي من Meta', w.metaCpa == null ? 'غير متاح' : money(w.metaCpa))}${kv('أوردرات Meta (مش مسلّمة)', num(w.purchases))}${kv('مصاريف الإعلان', money(w.spend))}${kv('الفرق عن المتوقع', w.deltaVsExpected == null ? '—' : `<bdi dir="ltr">${w.deltaVsExpected > 0 ? '+' : ''}${f2(w.deltaVsExpected)} (${w.deltaVsExpectedPct > 0 ? '+' : ''}${f2(w.deltaVsExpectedPct)}%)</bdi>`)}
        ${kv('CPA الأوردر المسلّم (مؤكد)', w.deliveredCpa == null ? `غير متاح <small class="opx-note">${E(w.codReason || '')}</small>` : money(w.deliveredCpa))}
        <div class="opx-verdict">${pill(VERDICT[w.verdict][1], VERDICT[w.verdict][0])}${w.profitConfirmed ? pill('الربحية مؤكدة (مسلّم)', 'green') : pill('الربحية غير مؤكدة — تقدير', 'amber')}${w.sufficient ? '' : `<small class="opx-note">أقل من ${w.minSample} أوردر</small>`}</div>` : '<div class="opx-empty">لا بيانات</div>'}</div>
    <div class="opx-card opx-panel"><h3>توصيات ذكية</h3>${recs(r.recommendations)}<small class="opx-note">${E(r.dataNote)}</small></div>`;
}
const recs = (l = []) => (l.length ? `<ul class="opx-recs">${l.map((x) => `<li class="${LVL[x.level][0]}"><i>${LVL[x.level][1]}</i><div><b>${E(x.title)}</b><small>${E(x.why)}</small></div></li>`).join('')}</ul>` : '<div class="opx-empty">—</div>');

async function saveDraft() {
  try { const r = await api.put(`/api/operator/pricing/${S.cur.productId}/draft`, { storeId: S.cur.storeId, inputs: S.inputs }); S.detail.state = r; toast('اتحفظت كمسودة — مفيش سعر أو قاعدة اتغيّرت'); drawInputsKeepFocus(); } catch (e) { toast(e.message, 'error'); }
}
function drawInputsKeepFocus() { const t = document.activeElement?.id; drawInputs(); if (t && $(t)) $(t).focus(); analyze(); }
async function approve() {
  const c = S.res?.computed; if (!c || c.status !== 'OK') return;
  const opts = [{ price: c.steps.suggested, label: 'السعر المقترح' }, ...c.rounding.map((o) => ({ price: o.price, label: o.label }))];
  const picked = await choosePrice(opts); if (picked == null) return;
  if (!(await confirmModal({ title: 'اعتماد السعر المقترح', message: `هيتسجل السعر ${f2(picked)} جنيه كسعر معتمد داخل الـOperator فقط. مفيش سعر هيتغيّر في المتجر أو Easy Orders، ومفيش قاعدة هتتفعّل.`, confirmLabel: 'اعتماد' }))) return;
  try { const r = await api.post(`/api/operator/pricing/${S.cur.productId}/approve`, { storeId: S.cur.storeId, inputs: S.inputs, price: picked, confirm: true }); S.detail.state = r; toast(r.note || 'اتسجل'); drawResults(); } catch (e) { toast(e.message, 'error'); }
}
function choosePrice(opts) {
  return new Promise((resolve) => {
    const d = openDrawer({ title: 'اختر السعر المراد اعتماده', body: `<div class="opx-choose">${opts.map((o, i) => `<label class="opx-pick-opt"><input type="radio" name="prc" value="${o.price}" ${i === 0 ? 'checked' : ''}><b>${f2(o.price)} جنيه</b><span>${E(o.label)}</span></label>`).join('')}</div>`, foot: '<button class="opx-btn" id="prcNo">إلغاء</button><button class="opx-btn primary" id="prcOk">متابعة</button>' });
    d.querySelector('#prcNo').onclick = () => { closeDrawer(); resolve(null); }; d.querySelector('#prcOk').onclick = () => { const v = Number(d.querySelector('input[name="prc"]:checked').value); closeDrawer(); resolve(v); };
  });
}
async function rulesPreview() {
  openDrawer({ title: 'استخدام نتائج التسعير في قواعد المنتج', body: '<div class="opx-skel" style="height:200px"></div>' });
  let pv; try { pv = await api.post(`/api/operator/pricing/${S.cur.productId}/rules-preview`, { storeId: S.cur.storeId, inputs: S.inputs }); } catch (e) { openDrawer({ title: 'استخدام نتائج التسعير', body: `<div class="opx-notice red"><div class="grow"><b>${E(e.message)}</b></div></div>` }); return; }
  if (!pv.ok) { openDrawer({ title: 'استخدام نتائج التسعير', body: `<div class="opx-notice amber"><div class="grow"><b>${E(pv.message)}</b></div></div>` }); return; }
  const show = (v) => (v === null || v === undefined ? '<em class="opx-note">فاضي</em>' : f2(v));
  const d = openDrawer({ title: 'معاينة: الحقول اللي هتتغيّر', body: `<div class="opx-notice blue"><div class="grow"><b>معاينة فقط — ما اتحفظش حاجة</b><small>${E(pv.note)}</small></div></div>
      <table class="opx-table"><thead><tr><th></th><th>الحقل</th><th class="num">الحالي</th><th class="num">المقترح</th></tr></thead><tbody>${pv.changes.map((c, i) => `<tr class="${c.changed ? '' : 'dim'}"><td><input type="checkbox" class="opx-check" data-f="${E(c.field)}" ${c.defaultOn && c.changed ? 'checked' : ''} aria-label="تطبيق"></td><td>${E(c.label)}${c.optional ? ' <em class="opx-note">اختياري</em>' : ''}${c.warning ? `<small class="opx-note">${E(c.warning)}</small>` : ''}</td><td class="num">${show(c.from)}</td><td class="num"><b>${show(c.to)}</b></td></tr>`).join('')}</tbody></table>
      ${(pv.warnings || []).map((w) => `<div class="opx-note bad">⚠️ ${E(w)}</div>`).join('')}
      <div class="opx-note">لن يتم: تغيير سعر البيع · تفعيل أي قاعدة · حفظ Target CPA أو Hard Stop إلا لو اخترتهم بنفسك.</div>`,
    foot: '<button class="opx-btn" id="rpNo">إغلاق</button><button class="opx-btn primary" id="rpOk">تطبيق المحدد (مسودة فقط)</button>' });
  d.querySelector('#rpNo').onclick = closeDrawer;
  d.querySelector('#rpOk').onclick = async () => {
    const fields = [...d.querySelectorAll('input[data-f]:checked')].map((x) => x.dataset.f); if (!fields.length) { toast('اختار حقل واحد على الأقل', 'warning'); return; }
    if (!(await confirmModal({ title: 'تطبيق على قواعد المنتج', message: `هيتحفظ ${fields.length} حقل (${fields.join('، ')}). مسودة القواعد ما بتتفعّلش من هنا، والسعر ما بيتغيّرش.`, confirmLabel: 'تطبيق' }))) return;
    try { const r = await api.post(`/api/operator/pricing/${S.cur.productId}/rules-apply`, { storeId: S.cur.storeId, inputs: S.inputs, fields, confirm: true }); closeDrawer(); toast('اتحفظ — مفيش قاعدة اتفعّلت ولا سعر اتغيّر'); await pick(S.cur.key); return r; } catch (e) { toast(e.message, 'error'); }
  };
}
function advanced() {
  const r = S.res; const c = r.computed; const kv = (k, v) => `<div class="opx-kv"><span>${k}</span><b>${v}</b></div>`;
  openDrawer({ title: 'التفاصيل المتقدمة للتسعير', body: `
    <div><b>خطوات المعادلة</b>${kv('Product Landed Cost', `${E(c.formula.landed)} = ${f2(c.steps.landed)}`)}${kv('Advertising Reserve', `${E(c.formula.adReserve)} = ${f2(c.steps.adReserve)}`)}${kv('Reference Cost', `${E(c.formula.reference)} = ${f2(c.steps.reference)}`)}${kv('Markup Amount', `${E(c.formula.markupAmount)} = ${f2(c.steps.markupAmount)}`)}${kv('Suggested Selling Price', `${E(c.formula.suggested)} = ${f2(c.steps.suggested)}`)}</div>
    <div><b>مفاهيم منفصلة (ما بتتخلطش)</b><ul class="opx-note"><li>Estimated CPA: رقمك المتوقع (${f2(c.inputs.expectedCpa)}).</li><li>Advertising Reserve: ${f2(c.steps.adReserve)} — افتراض تسعير، مش مصروف فعلي.</li><li>Actual Meta CPA: الصرف ÷ أوردرات Meta لنفس الفترة.</li><li>Confirmed Delivered CPA: الصرف ÷ الأوردرات المسلّمة، ويظهر فقط مع بيانات COD كافية وموثوقة.</li><li>Gross Margin: (السعر − التكلفة) ÷ السعر قبل الإعلان.</li><li>Contribution Profit: السعر − التكلفة − CPA.</li><li>Break-even CPA: السعر − التكلفة.</li></ul></div>
    <div><b>مقارنة الفترات</b><table class="opx-table"><thead><tr><th>الفترة</th><th class="num">أوردرات Meta</th><th class="num">CPA Meta</th><th class="num">CPA مسلّم</th><th>الحكم</th></tr></thead><tbody>${r.comparison.map((w) => `<tr><td>${WINL[w.key]}</td><td class="num">${num(w.purchases)}</td><td class="num">${w.metaCpa == null ? '—' : f2(w.metaCpa)}</td><td class="num">${w.deliveredCpa == null ? '—' : f2(w.deliveredCpa)}</td><td>${pill(VERDICT[w.verdict][1], VERDICT[w.verdict][0])}</td></tr>`).join('')}</tbody></table></div>
    ${(S.detail.state?.history || []).length ? `<div><b>سجل الاعتمادات</b>${S.detail.state.history.map((h) => kv(new Date(h.at).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' }), f2(h.price))).join('')}</div>` : ''}
    <div class="opx-note">${c.notes.map(E).join('<br>')}</div>` });
}
