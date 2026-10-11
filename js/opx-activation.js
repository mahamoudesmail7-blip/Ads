// opx-activation.js — «نموذج قرارات التفعيل»: ONE screen to decide a product's AUTOMATIC activation.
// Sections: safety state · CONFIRMED saved values · CPA mapping PROPOSAL (nothing is applied until the owner ticks each line) · campaign performance 3/7/30 · open candidates with LIVE budget + guards · every remaining decision.
// Saving here = a DRAFT of the product policy (activates nothing, writes nothing to Meta) and, separately, the account daily limits. Activation stays in «قواعد المنتجات» with its own confirmation.
import { api } from './api-client.js';
import { E, $, num, egp, ICONS, pill, openDrawer, closeDrawer, toast, confirmModal, skeletonRows } from './opx-ui.js';

const DAYS = [[6, 'سبت'], [0, 'أحد'], [1, 'اتنين'], [2, 'تلات'], [3, 'أربع'], [4, 'خميس'], [5, 'جمعة']];
const S = { sheet: null, pol: null, productId: null, storeId: null, ctx: null };
const V = (x) => (x === null || x === undefined ? '' : x);
const cpa = (x) => (x == null ? '—' : num(x));
const val = (o) => (o && o.value != null ? `${num(o.value)}${o.source ? ` <small style="color:var(--opx-muted)">(${E(o.source)})</small>` : ''}` : '<b style="color:var(--opx-red,#c0392b)">غير محفوظ</b>');

export async function openActivationSheet(productId, storeId, ctx) {
  S.ctx = ctx; S.productId = productId; S.storeId = storeId; openDrawer({ title: 'نموذج قرارات التفعيل', body: skeletonRows(6) });
  try { [S.sheet, S.pol] = await Promise.all([api.get(`/api/operator/automation/activation-sheet/${productId}`, { storeId }), api.get(`/api/operator/product-rules/${productId}`, { store: storeId })]); } catch (e) { openDrawer({ title: 'نموذج قرارات التفعيل', body: `<div class="opx-note bad">⚠️ ${E(e.message)}</div>` }); return; }
  render();
}

const inp = (id, label, v, hint = '', type = 'number') => `<label>${E(label)}<input class="opx-input" id="${id}" type="${type}" ${type === 'number' ? 'step="any" min="0"' : ''} value="${E(V(v))}" ${S.ctx.isAdmin ? '' : 'disabled'}>${hint ? `<small style="font-weight:600;color:var(--opx-muted)">${E(hint)}</small>` : ''}</label>`;

function render() {
  const s = S.sheet, g = s.global, c = s.confirmed; const pol = S.pol.draft || S.pol.active || {}; const sch = pol.schedule || {}, cp = pol.cpa || {}, z = pol.zeroOrder || {}, b = pol.budget || {}; const days = sch.days || [];
  const safe = g.writesLocked && g.allPermissionsOff && !g.emergencyStop;
  const strip = `<div class="opx-notice ${g.writesLocked && g.allPermissionsOff ? 'green' : 'red'}"><div class="grow"><b>${g.writesLocked ? 'كتابة Meta مقفولة' : 'كتابة Meta مفتوحة'} · ${g.allPermissionsOff ? 'كل صلاحيات التنفيذ OFF' : 'فيه صلاحية تنفيذ مفتوحة'} · وضع النظام ${E(g.mode)}${g.emergencyStop ? ' · Emergency Stop شغّال' : ''}</b><small>${safe ? 'آمن: النموذج ده مش بينفّذ حاجة. الحفظ هنا مسودة فقط.' : 'اقفل القفل وكل الصلاحيات قبل أي تفعيل.'} · الأتمتة لسه بتتفعّل من «قواعد المنتجات» بتأكيد منفصل.</small></div></div>`;
  const conf = `<h3>${ICONS.check} القيم المؤكدة (محفوظة فعلًا)</h3><table class="opx-table"><tbody>
    <tr><td>سعر البيع</td><td>${val(c.sellingPrice)}</td><td>تكلفة المنتج</td><td>${val(c.purchaseCost)}</td></tr>
    <tr><td>الشحن</td><td>${val(c.shipping)}</td><td>التغليف + تكاليف أخرى</td><td>${val(c.packaging)} + ${val(c.other)}</td></tr>
    <tr><td>هامش الوحدة</td><td>${c.unitMargin != null ? egp(c.unitMargin) : '—'}</td><td>المخزون / الحد الأدنى</td><td>${c.stock.known ? `${num(c.stock.current)} / ${c.stock.minimum != null ? num(c.stock.minimum) : '<b>غير محفوظ</b>'}` : '<b>غير معروف</b>'}</td></tr>
    <tr><td>Target CPA</td><td>${val(c.targetCpa)}</td><td>Maximum CPA</td><td>${val(c.maxCpa)}</td></tr>
    <tr><td>Hard Stop CPA</td><td>${val(c.hardStopCpa)}</td><td></td><td></td></tr></tbody></table>
    <p class="opx-note">الهامش محسوب بعد التغليف والتكاليف الأخرى المحفوظة (مش بس التكلفة والشحن). لو التغليف أو التكاليف الأخرى غلط، صحّحها من «التسعير» قبل أي قرار CPA.</p>`;
  const mapRows = s.mapping.rows.map((r) => `<tr><td>${E(r.label)}</td><td>${E(r.sourceLabel)}: <b>${r.value != null ? num(r.value) : '—'}</b></td><td><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" class="opx-check" data-map="${r.field}" ${r.proposed && S.ctx.isAdmin ? '' : 'disabled'}> اعتمد الاقتراح</label></td><td><small>${E(r.reason)}</small></td></tr>`).join('');
  const mapping = `<h3>${ICONS.target} ربط الـCPA المقترح <small style="font-weight:600;color:var(--opx-muted)">(اقتراح — مفيش حاجة بتتملّى لوحدها)</small></h3>
    ${s.mapping.problems.length ? `<div class="opx-notice red"><div class="grow"><b>${E(s.mapping.problems.join(' '))}</b></div></div>` : ''}
    <table class="opx-table"><thead><tr><th>الحد</th><th>المصدر المحفوظ</th><th></th><th>السبب</th></tr></thead><tbody>${mapRows}</tbody></table>
    <div class="opx-form">${inp('pa_scale', 'حد الـScale (CPA ≤)', cp.scale, 'يتملّى لما تعتمد الاقتراح فوق، أو اكتب رقمك')}${inp('pa_reduce', 'حد الـReduce (CPA ≥)', cp.reduce, 'يتملّى لما تعتمد الاقتراح فوق، أو اكتب رقمك')}${inp('pa_hard', 'Hard Stop CPA', cp.hardStop, 'محفوظ بالفعل')}${inp('pa_nmin', 'CPA الطبيعي — من (اختياري)', cp.normalMin)}${inp('pa_nmax', 'CPA الطبيعي — إلى (اختياري)', cp.normalMax)}</div>`;
  const t = s.campaigns.totals; const row = (r) => `<tr><td><b>${E(r.name)}</b><small style="display:block;color:var(--opx-muted)">${E(r.id)}</small></td><td>${pill(E(r.status || '—'), r.status === 'ACTIVE' ? 'green' : 'gray')}</td><td class="num">${r.budget != null ? egp(r.budget) : '—'}</td><td class="num">${num(r.d3.orders)}<small> · ${cpa(r.d3.cpa)}</small></td><td class="num">${num(r.d7.orders)}<small> · ${cpa(r.d7.cpa)}</small></td><td class="num">${num(r.d30.orders)}<small> · ${cpa(r.d30.cpa)}</small></td></tr>`;
  const camps = `<h3>${ICONS.megaphone} أداء الحملات (${num(s.campaigns.count)} حملة، ${num(s.campaigns.active)} شغالة) — مرتبة بأوردرات آخر 7 أيام ثم CPA</h3>
    <div class="opx-scroll" style="max-height:300px"><table class="opx-table"><thead><tr><th>الحملة</th><th>الحالة</th><th class="num">الميزانية</th><th class="num">3 أيام (أوردر · CPA)</th><th class="num">7 أيام</th><th class="num">30 يوم</th></tr></thead><tbody>
      <tr><td><b>إجمالي المنتج</b></td><td></td><td></td><td class="num">${num(t.d3.orders)} · ${cpa(t.d3.cpa)}</td><td class="num">${num(t.d7.orders)} · ${cpa(t.d7.cpa)}</td><td class="num">${num(t.d30.orders)} · ${cpa(t.d30.cpa)}</td></tr>${s.campaigns.rows.map(row).join('')}</tbody></table></div>`;
  const oc = (o) => { const lv = o.live; const liveTxt = !lv ? `<small>مش مقروءة لايف (${E(o.eligibility)})</small>` : lv.error ? `<small class="opx-note bad">${E(lv.error)}</small>` : `<b>${lv.campaignBudget != null ? egp(lv.campaignBudget) : lv.adsets.map((a) => `${E(a.name)} ${a.budget != null ? egp(a.budget) : ''} (${E(a.status)})`).join('، ') || '—'}</b> <small>${E(lv.level)} · ${E(lv.status || '')} · لايف ${new Date(lv.readAt).toLocaleTimeString('ar-EG')}</small>`;
    return `<tr><td><b>${E(o.name)}</b>${o.selected ? ' ' + pill('مختارة للفتح', 'blue') : ''}<small style="display:block;color:var(--opx-muted)">${E(o.campaignId)}</small></td><td>${pill(E(o.eligibility), o.eligibility === 'ELIGIBLE' ? 'green' : o.eligibility === 'BLOCKED' ? 'red' : 'amber')}</td><td>${liveTxt}</td><td>${o.blocks.length ? o.blocks.map((x) => `<small class="opx-why" style="display:block">⛔ ${E(x)}</small>`).join('') : '<small>مفيش حارس مانع</small>'}${(o.warnings || []).map((x) => `<small class="opx-why" style="display:block">⚠️ ${E(x.code || x)}</small>`).join('')}</td></tr>`; };
  const open = `<h3>${ICONS.clock} المرشحة للفتح (ميزانية لايف من Meta + الحواجز)</h3>
    <div class="opx-scroll" style="max-height:260px"><table class="opx-table"><thead><tr><th>الحملة</th><th>الأهلية</th><th>الميزانية الحية</th><th>الحواجز</th></tr></thead><tbody>${s.openCandidates.length ? s.openCandidates.map(oc).join('') : '<tr><td colspan="4" class="opx-empty">مفيش مرشحة للفتح دلوقتي.</td></tr>'}</tbody></table></div>
    <p class="opx-note">لو اتفتحت كل المرشحة المؤهلة: <b>${egp(s.exposure.openCandidatesWithBudget)}</b>/يوم. سقف المنتج: <b>${s.exposure.productDailyCap != null ? egp(s.exposure.productDailyCap) : 'غير محدد'}</b> · سقف الحساب: <b>${s.exposure.accountCap != null ? egp(s.exposure.accountCap) : 'غير محدد'}</b> · سقف الفتح الإجمالي: <b>${s.exposure.openPolicyCap != null ? egp(s.exposure.openPolicyCap) : 'غير محدد'}</b></p>`;
  const form = `<h3>${ICONS.rules} باقي القرارات (سياسة المنتج — مسودة)</h3>
    <div class="opx-form"><label>وضع المنتج في المسودة<select class="opx-select" id="pa_mode" ${S.ctx.isAdmin ? '' : 'disabled'}>${[['', 'يرث العام'], ['MANUAL', 'MANUAL'], ['APPROVAL', 'APPROVAL'], ['AUTOMATIC', 'AUTOMATIC (مسودة فقط — مش بيفعّل)']].map(([k, t2]) => `<option value="${k}" ${String(V(pol.mode)) === k ? 'selected' : ''}>${E(t2)}</option>`).join('')}</select></label></div>
    <h4>إيقاف الصرف بدون أوردرات</h4><div class="opx-form">${inp('pa_zspend', 'حد الصرف بدون أوردر (ج.م)', z.spend)}${inp('pa_zage', 'أقل عمر للحملة (ساعات)', z.minAgeHours)}</div>
    <h4>الميزانية</h4><div class="opx-form">${inp('pa_inc', 'نسبة الزيادة %', b.increasePct, 'أقصى 20% للأكشن الواحد')}${inp('pa_dec', 'نسبة التقليل %', b.decreasePct, 'أقصى 20% للأكشن الواحد')}${inp('pa_minp', 'أقل عدد أوردرات للقرار', b.minPurchases)}${inp('pa_cool', 'Cooldown بين تعديلين (ساعات، أقل 6)', b.cooldownHours)}${inp('pa_minb', 'أقل ميزانية للحملة', b.minBudget)}${inp('pa_maxb', 'أقصى ميزانية للحملة', b.maxBudget)}${inp('pa_cap', 'سقف التعرض اليومي للمنتج', b.dailySpendCap)}</div>
    <h4>المواعيد (توقيت القاهرة)</h4><div class="opx-form">${inp('pa_open', 'وقت الفتح', sch.openTime, '', 'time')}${inp('pa_close', 'وقت الإيقاف', sch.closeTime, '', 'time')}</div>
    <div><div class="opx-note" style="margin-bottom:6px">أيام التشغيل (فارغ = كل الأيام)</div><div class="opx-days" id="pa_days">${DAYS.map(([k, t2]) => `<button type="button" class="opx-day ${days.includes(k) ? 'on' : ''}" data-paday="${k}" ${S.ctx.isAdmin ? '' : 'disabled'}>${t2}</button>`).join('')}</div></div>
    <h4>الحماية</h4><div class="opx-form">${inp('pa_moh', 'حماية التعديل اليدوي (ساعات بعد تعديلك على Meta)', pol.manualOverrideHours, `بتتمدد بس — الحد العام ${g.cooldownDefaults.manualOverrideCooldownHours ?? 24} ساعة`)}</div>
    <p class="opx-note">الحد الأدنى للمخزون: <b>${c.stock.minimum != null ? num(c.stock.minimum) : 'غير محفوظ'}</b> ${c.stock.minimum != null ? '(محفوظ في بيانات المنتج)' : '— يتحفظ من «التسعير»'}.</p>`;
  const acc = g.account || {}; const account = `<h3>${ICONS.shield} حدود الحساب اليومية <small style="font-weight:600;color:var(--opx-muted)">(بتحمي الحساب كله — حفظها فوري ومنفصل)</small></h3>
    <div class="opx-form">${inp('ac_spend', 'سقف الصرف اليومي تحت الـAI (ج.م)', acc.maxDailySpendUnderAi)}${inp('ac_en', 'أقصى عدد فتح في اليوم', acc.maxEnablesPerDay)}${inp('ac_pa', 'أقصى عدد إيقاف في اليوم', acc.maxPausesPerDay)}${inp('ac_inc', 'أقصى زيادة ميزانية في اليوم (ج.م)', acc.maxBudgetIncreasePerDay)}</div>
    <div class="opx-cpa-btns"><button class="opx-btn" id="pa_acc" ${S.ctx.isAdmin ? '' : 'disabled'}>حفظ حدود الحساب</button></div>
    <p class="opx-note">قرارات عامة بتتحفظ من شاشاتها (بنسخ ومعتمدة): سياسة الإيقاف (${g.pausePolicy.enabled && g.pausePolicy.approvedVersion === g.pausePolicy.version ? 'معتمدة' : '<b>غير معتمدة</b>'}) من «الأتمتة» · سياسة الفتح${g.openPolicy ? ` (v${g.openPolicy.version}، CPA ${g.openPolicy.minCpa}–${g.openPolicy.maxCpa}، ${g.openPolicy.minPurchases} أوردر)` : ''} — سقف التعرض الإجمالي والحد الأدنى للمخزون للفتح من «فتح متقدم».</p>`;
  const miss = s.missing.filter((m) => m.missing);
  const missBox = `<h3>${ICONS.stop} الناقص (${num(miss.length)}) — مفيش حاجة بتتحط افتراضيًا</h3><div class="opx-scroll" style="max-height:220px"><table class="opx-table"><tbody>${s.missing.map((m) => `<tr><td>${m.missing ? '⛔' : '✅'}</td><td>${E(m.label)}</td><td><small>${E(m.scope)}</small></td><td>${m.current != null && !m.missing ? E(String(typeof m.current === 'object' ? JSON.stringify(m.current) : m.current)) : '—'}</td><td><small>${E(m.where)}</small></td></tr>`).join('')}</tbody></table></div>
    <div class="opx-notice ${miss.length ? 'amber' : 'green'}"><div class="grow"><b>${miss.length ? 'NEEDS_CONFIGURATION — ناقص ' + num(miss.length) + ' قرار' : 'كل القيم متحددة — التفعيل بقرارك من «قواعد المنتجات»'}</b></div></div>`;
  const foot = S.ctx.isAdmin ? `<button class="opx-btn" id="pa_save">${ICONS.history} حفظ كمسودة (لا يفعّل شيئًا)</button><button class="opx-btn" id="pa_rules">فتح «قواعد المنتجات» للتفعيل</button>` : '<span class="opx-note">للقراءة فقط — التعديل لـADMIN.</span>';
  const panel = openDrawer({ title: `نموذج قرارات التفعيل — ${E(s.product.name || s.product.id)}`, body: `${strip}${conf}${mapping}${camps}${open}${form}${account}${missBox}`, foot }); if (window.innerWidth > 900) panel.style.width = 'min(760px,100vw)'; else panel.style.width = '';
  panel.querySelectorAll('[data-paday]').forEach((d) => { d.onclick = () => d.classList.toggle('on'); });
  panel.querySelectorAll('[data-map]').forEach((cb) => { cb.onchange = () => { const f = cb.dataset.map; const r = s.mapping.rows.find((x) => x.field === f); const el = $({ scale: 'pa_scale', reduce: 'pa_reduce', hardStop: 'pa_hard' }[f]); if (cb.checked) el.value = r.value; else if (String(el.value) === String(r.value)) el.value = ''; }; });
  if ($('pa_save')) $('pa_save').onclick = saveDraft; if ($('pa_acc')) $('pa_acc').onclick = saveAccount; if ($('pa_rules')) $('pa_rules').onclick = () => { closeDrawer(); window.dispatchEvent(new CustomEvent('opx:open', { detail: 'rules' })); };
}

const num0 = (id) => { const x = $(id); if (!x) return null; const t = String(x.value).trim(); return t === '' ? null : Number(t); };
const str0 = (id) => { const x = $(id); if (!x) return null; const t = String(x.value).trim(); return t === '' ? null : t; };
async function saveDraft() {
  const base = JSON.parse(JSON.stringify(S.pol.draft || S.pol.active || {})); const days = [...document.querySelectorAll('#pa_days .opx-day.on')].map((d) => Number(d.dataset.paday));
  const policy = { ...base, mode: str0('pa_mode'), schedule: { ...(base.schedule || {}), openTime: str0('pa_open'), closeTime: str0('pa_close'), days: days.length ? days : null },
    cpa: { ...(base.cpa || {}), normalMin: num0('pa_nmin'), normalMax: num0('pa_nmax'), scale: num0('pa_scale'), reduce: num0('pa_reduce'), hardStop: num0('pa_hard') },
    zeroOrder: { ...(base.zeroOrder || {}), spend: num0('pa_zspend'), minAgeHours: num0('pa_zage') },
    budget: { ...(base.budget || {}), increasePct: num0('pa_inc'), decreasePct: num0('pa_dec'), minPurchases: num0('pa_minp'), cooldownHours: num0('pa_cool'), minBudget: num0('pa_minb'), maxBudget: num0('pa_maxb'), dailySpendCap: num0('pa_cap') }, manualOverrideHours: num0('pa_moh') };
  try { S.pol = await api.put(`/api/operator/product-rules/${S.productId}/draft`, { storeId: S.storeId, policy }); toast('اتحفظت كمسودة — لسه مش مفعّلة ومفيش حاجة اتنفذت'); S.sheet = await api.get(`/api/operator/automation/activation-sheet/${S.productId}`, { storeId: S.storeId }); render(); } catch (e) { toast((e.details || [e.message]).join(' '), 'error'); }
}
async function saveAccount() {
  const account = { maxDailySpendUnderAi: num0('ac_spend'), maxEnablesPerDay: num0('ac_en'), maxPausesPerDay: num0('ac_pa'), maxBudgetIncreasePerDay: num0('ac_inc') };
  if (!(await confirmModal({ title: 'حفظ حدود الحساب اليومية', message: 'الحدود دي بتحمي الحساب كله وبتتطبق فورًا على أي تنفيذ (يدوي أو تلقائي). مفيش حاجة بتتنفذ بالحفظ.', confirmLabel: 'احفظ' }))) return;
  try { await api.put('/api/operator/limits', { limits: { account } }); toast('اتحفظت حدود الحساب'); S.sheet = await api.get(`/api/operator/automation/activation-sheet/${S.productId}`, { storeId: S.storeId }); render(); } catch (e) { toast((e.details || [e.message]).join(' '), 'error'); }
}
