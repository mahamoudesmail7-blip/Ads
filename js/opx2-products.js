// opx2-products.js — AI Operator V2 «اقتصاديات المنتجات»: the owner's six products with their REAL numbers, what is missing, and the forms to enter it (costs · stock · CPA limits · budget limits · the 20% rules · stop rules).
// Presentation only: every number, the profitability, the readiness verdict, the simulation and the lock come from the SERVER (/api/operator/product-economics*). Saving stores economics + a policy DRAFT; nothing runs until the owner
// activates it (the existing gated activation: readiness must pass, AUTOMATIC needs an extra explicit confirmation). A product that already runs a policy (Hair-Cap) is shown LOCKED and can't be edited here.
import { api } from './api-client.js';
import { E, num, egp, pill, toast, skeleton, errorCard, openModal, closeAll, modalEl, debounce } from './opx2-ui.js';

const P = { host: null, ctx: null, board: null, scope: 'six', ed: null };
export function stopProducts() { P.host = null; P.ed = null; }
const isAdmin = () => P.ctx?.level === 'ADMIN';
const STATE_PILL = (p) => (p.locked ? pill('🔒 شغّال AUTOMATIC', 'info') : p.readiness.ready ? pill('✅ جاهز للتفعيل', 'ok') : pill(`⚠️ ناقص ${p.readiness.missing.length}`, 'warn'));
const ST_AR = { SAFE: 'آمن', LOW: 'منخفض', OUT_OF_STOCK: 'نفد', STOCK_UNKNOWN: 'غير معروف' };
const val = (v, f = num) => (v === null || v === undefined ? '<span class="opx2-na" title="غير متوفر — لسه ما اتسجّلش">غير متوفر</span>' : f(v));
const money = (v) => (v === null || v === undefined ? val(null) : `<span class="${v < 0 ? 'opx2-neg' : 'opx2-pos'}">${egp(v)}</span>`);

export async function mountProducts(host, ctx) {
  P.host = host; P.ctx = ctx; host.innerHTML = `<h1>اقتصاديات المنتجات</h1><div class="opx2-card">${skeleton(5, 46)}</div>`;
  await load();
}
async function load() {
  try { P.board = await api.get(`/api/operator/product-economics?scope=${P.scope}`); } catch (e) { P.host.innerHTML = errorCard(e.message || 'تعذّر تحميل اقتصاديات المنتجات.'); P.host.querySelector('#o2Retry').onclick = load; return; }
  draw();
}
function draw() {
  const h = P.host; if (!h) return; const b = P.board; const s = b.summary;
  h.innerHTML = `<div class="opx2-pe"><h1>اقتصاديات المنتجات</h1>
    <p class="lead">منتجاتك وأرقامها الفعلية، وإيه الناقص، وتدخل الناقص من هنا: التكلفة والمخزون وحدود CPA والميزانية وقواعد الزيادة والتقليل والإيقاف.</p>
    <div class="opx2-banner info">🔒 <b>الحفظ هنا = مسودة فقط.</b> مفيش حاجة بتتنفذ ولا AUTOMATIC بيشتغل لحد ما تعمل فحص الجاهزية وتعتمد وتفعّل بنفسك. الخانة الفاضية = «غير متوفر» (مش صفر). ${isAdmin() ? '' : '<b>العرض فقط لحسابك</b> — التعديل للمسؤول.'}</div>
    <div class="opx2-grid opx2-g4"><div class="opx2-card opx2-kpi"><span>منتجات معروضة</span><b>${num(b.count)}</b></div><div class="opx2-card opx2-kpi"><span>جاهز للتفعيل</span><b style="color:var(--ok)">${num(s.ready)}</b></div><div class="opx2-card opx2-kpi"><span>ناقص بيانات</span><b style="color:var(--warn)">${num(s.blocked)}</b></div><div class="opx2-card opx2-kpi"><span>شغّال AUTOMATIC (مقفول)</span><b>${num(s.locked)}</b></div></div>
    <div class="opx2-fld"><div class="opx2-seg"><button data-scope="six" class="${P.scope === 'six' ? 'on' : ''}">المنتجات الستة</button><button data-scope="all" class="${P.scope === 'all' ? 'on' : ''}">كل المنتجات</button></div><button class="opx2-btn sm" id="peRef">↻ تحديث</button></div>
    <div class="opx2-pgrid" id="peGrid">${b.products.length ? b.products.map(card).join('') : '<div class="opx2-empty">مفيش منتجات.</div>'}</div></div>`;
  h.querySelectorAll('[data-scope]').forEach((x) => { x.onclick = () => { P.scope = x.dataset.scope; load(); }; });
  h.querySelector('#peRef').onclick = load;
  h.querySelectorAll('[data-open]').forEach((x) => { x.onclick = () => openEditor(Number(x.dataset.open)); });
}
function card(p) {
  const pf = p.profit, pr = p.performance, rd = p.readiness; const okN = rd.checks.filter((c) => c.required && c.ok).length, allN = rd.checks.filter((c) => c.required).length;
  return `<article class="opx2-card opx2-pc ${p.locked ? 'lk' : ''}" data-pid="${p.productId}">
    <header><div><b>${E(p.name)}</b><small>${E(p.storeId || '')} · ${p.campaigns.active} حملة شغالة من ${p.campaigns.total}</small></div>${STATE_PILL(p)}</header>
    <div class="opx2-pcs"><div><span>CPA 7 أيام</span><b>${val(pr.cpa7)}</b><small>${val(pr.orders7)} أوردر</small></div><div><span>CPA 30 يوم</span><b>${val(pr.cpa30)}</b><small>${val(pr.orders30)} أوردر</small></div>
      <div><span>هامش الوحدة</span><b>${val(pf.unitMargin, egp)}</b><small>${pf.marginPct == null ? 'غير متوفر' : pf.marginPct + '% من السعر'}</small></div><div><span>صافي 30 يوم (تقديري)</span><b>${money(pf.profit30)}</b><small>أوردرات × هامش − صرف</small></div></div>
    <div class="opx2-prog" title="بنود الجاهزية المطلوبة"><i style="width:${allN ? Math.round((okN / allN) * 100) : 0}%"></i></div><small class="opx2-note">جاهزية ${okN}/${allN}${rd.missing.length ? ' — ناقص: ' + E(rd.missing.slice(0, 3).map((m) => m.label.split('(')[0].trim()).join(' · ')) + (rd.missing.length > 3 ? '…' : '') : ' — كل البنود تمام'}</small>
    <footer><button class="opx2-btn ${p.locked || !isAdmin() ? '' : 'pri'} sm" data-open="${p.productId}">${p.locked ? '👁 عرض (مقفول)' : isAdmin() ? '✏️ إدخال وتعديل' : '👁 عرض'}</button><span>${pill(p.policy.status === 'NONE' ? 'بدون سياسة' : p.policy.status === 'DRAFT' ? 'مسودة' : p.policy.status === 'ACTIVE' ? 'سياسة مفعّلة' : 'مفعّلة + مسودة', p.policy.status === 'NONE' ? 'gray' : 'info')}</span></footer></article>`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the editor
// ---------------------------------------------------------------------------------------------------------------------------------------------
const EF = [['cost', 'تكلفة الشراء (للوحدة)'], ['shipping', 'الشحن'], ['packaging', 'التغليف'], ['other', 'تكاليف أخرى'], ['currentStock', 'المخزون الحالي'], ['minimumStock', 'الحد الأدنى للمخزون']];
const CF = [['target', 'CPA المستهدف'], ['max', 'أقصى CPA'], ['hardStop', 'Hard Stop CPA']];
const PF1 = [['scale', 'Scale: زوّد لو CPA ≤'], ['reduce', 'Reduce: قلّل لو CPA ≥'], ['hardStop', 'Hard Stop (سياسة)']]; const PF2 = [['minBudget', 'أقل ميزانية للحملة'], ['maxBudget', 'أقصى ميزانية للحملة'], ['dailySpendCap', 'سقف المنتج اليومي']];
const PF3 = [['increasePct', 'نسبة الزيادة %'], ['decreasePct', 'نسبة التقليل %'], ['minPurchases', 'أقل أوردرات للقرار'], ['cooldownHours', 'فترة تهدئة (ساعات)'], ['maxChangesPerDay', 'أقصى تعديلات/يوم']]; const PF4 = [['zeroSpend', 'أوقف لو صرف ≥ (بدون أوردرات)'], ['zeroMinAgeHours', 'أقل عمر للحملة (ساعات)']];
// the 20% / 5 orders / 24h / 4 changes / zero-order stop of Hair-Cap, offered as EDITABLE starting values (marked «مقترح»); the budget limits and every CPA line stay EMPTY until the owner types them
const STARTERS = { increasePct: 20, decreasePct: 20, minPurchases: 5, cooldownHours: 24, maxChangesPerDay: 4, zeroSpend: 200, zeroMinAgeHours: 24 };
const fld = (grp, k, label, v, dis, sug) => `<label class="opx2-pfld">${E(label)}<input inputmode="decimal" data-g="${grp}" data-k="${k}" value="${v == null ? '' : E(v)}" ${dis ? 'disabled' : ''}${sug ? ' class="sug" title="قيمة مقترحة بنفس إعدادات Hair-Cap — عدّلها لو عايز، ولازم تحفظها"' : ''}></label>`;
function openEditor(id) {
  const p = P.board.products.find((x) => x.productId === id); if (!p) return; const dis = !isAdmin() || p.locked; const f = p.policy.form;
  const ec = { cost: p.economics.cost.value, shipping: p.economics.shipping.value, packaging: p.economics.packaging.value, other: p.economics.other.value, currentStock: p.stock.manualCurrent, minimumStock: p.stock.manualMinimum };
  const cl = { target: p.cpa.target, max: p.cpa.max, hardStop: p.cpa.hardStop }; const pl = { ...Object.fromEntries(Object.keys(STARTERS).concat(['scale', 'reduce', 'hardStop', 'minBudget', 'maxBudget', 'dailySpendCap']).map((k) => [k, null])), ...(f || STARTERS) };
  P.ed = { p, ec, cl, pl, started: !f, last: null, ready: null };
  const price = p.economics.price; const sug = (k) => P.ed.started && k in STARTERS;
  openModal(`<div class="opx2-ped"><div class="hd"><div><h2>${E(p.name)}</h2><small>${E(p.storeId || '')} · ${STATE_PILL(p)}</small></div><button class="opx2-btn" id="peX">✕ إغلاق</button></div>
    ${p.locked ? `<div class="opx2-banner warn">🔒 ${E(p.lockedReason)} <button class="opx2-btn sm" id="peLegacy">فتح «قواعد المنتجات»</button></div>` : ''}
    <div class="opx2-pcols"><div class="opx2-pform">
      <fieldset><legend>1) الاقتصاديات والمخزون</legend><div class="opx2-fld"><span>سعر البيع: <b>${val(price.value, egp)}</b> ${pill(E(price.status), price.status === 'CONFLICT' ? 'bad' : price.status === 'MISSING' ? 'warn' : 'gray')} <small class="opx2-note">${E(price.reason || (price.source ? 'المصدر: ' + price.source : ''))} — بيتعدل من «التسعير الذكي»</small></span></div>
        <div class="opx2-pg">${EF.map(([k, l]) => fld('ec', k, l, ec[k], dis)).join('')}</div></fieldset>
      <fieldset><legend>2) حدود CPA</legend><div class="opx2-pg">${CF.map(([k, l]) => fld('cl', k, l, cl[k], dis)).join('')}</div><div class="opx2-pg">${PF1.map(([k, l]) => fld('pl', k, l, pl[k], dis)).join('')}</div>
        <div class="opx2-fld"><button class="opx2-btn sm" id="peSug" ${dis ? 'disabled' : ''}>استخدم المقترح (0.6 / 0.9 / 1.0 من أعلى CPA)</button><small class="opx2-note" id="peSugNote">المقترح بيتحسب من أقصى CPA الحقيقي — مش بيتطبّق إلا لما تضغط وتحفظ.</small></div></fieldset>
      <fieldset><legend>3) حدود الميزانية</legend><div class="opx2-pg">${PF2.map(([k, l]) => fld('pl', k, l, pl[k], dis)).join('')}</div></fieldset>
      <fieldset><legend>4) قواعد الزيادة والتقليل والإيقاف</legend><div class="opx2-pg">${PF3.map(([k, l]) => fld('pl', k, l, pl[k], dis, sug(k))).join('')}</div><div class="opx2-pg">${PF4.map(([k, l]) => fld('pl', k, l, pl[k], dis, sug(k))).join('')}</div></fieldset></div>
      <aside class="opx2-plive"><h3>الربحية والمحاكاة</h3><div id="peLive" class="opx2-note">بتتحدّث تلقائيًا وإنت بتكتب (بدون حفظ).</div><h3 style="margin-top:14px">فحص الجاهزية</h3><div id="peReady">${readyHtml(p.readiness)}</div></aside></div>
    <div class="opx2-fld ft"><button class="opx2-btn pri" id="peSave" ${dis ? 'disabled' : ''}>💾 حفظ (مسودة)</button><button class="opx2-btn" id="peCheck" ${p.locked ? 'disabled' : ''}>✅ فحص الجاهزية</button><button class="opx2-btn" id="peAct" disabled title="بيتفتح لما الجاهزية تكمل وفيه مسودة محفوظة">⚡ اعتماد وتفعيل AUTOMATIC</button></div></div>`);
  const m = modalEl(); m.querySelector('#peX').onclick = closeAll; const lg = m.querySelector('#peLegacy'); if (lg) lg.onclick = () => { closeAll(); P.ctx.openLegacy('rules'); };
  const collect = () => { const g = (grp) => Object.fromEntries([...m.querySelectorAll(`[data-g="${grp}"]`)].map((i) => [i.dataset.k, i.value.trim() === '' ? null : Number(i.value.replace(/,/g, ''))])); return { economics: g('ec'), cpaLimits: g('cl'), policy: g('pl') }; };
  P.ed.collect = collect; const live = debounce(() => preview(), 450); m.querySelectorAll('input[data-g]').forEach((i) => { i.oninput = live; });
  m.querySelector('#peSug').onclick = () => { const s = P.ed.last?.suggestion; if (!s) { toast('اكتب أقصى CPA (أو كمّل التكلفة والسعر) الأول — المقترح بيتحسب من رقم حقيقي.', 'warning'); return; } const set = (grp, k, v) => { const i = m.querySelector(`[data-g="${grp}"][data-k="${k}"]`); if (i) i.value = v; }; set('pl', 'scale', s.scale); set('pl', 'reduce', s.reduce); set('pl', 'hardStop', s.hardStop); const hs = m.querySelector('[data-g="cl"][data-k="hardStop"]'); if (hs && !hs.value) hs.value = s.hardStop; preview(); };
  m.querySelector('#peSave').onclick = save; m.querySelector('#peCheck').onclick = checkReady; m.querySelector('#peAct').onclick = activate; preview();
}
const readyHtml = (rd) => `<ul class="opx2-chk">${rd.checks.filter((c) => c.required).map((c) => `<li class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✅' : '❌'} ${E(c.label)}<small>${E(c.detail || '')}</small></li>`).join('')}</ul>`;
async function preview() {
  const m = modalEl(); if (!m || !P.ed) return; const live = m.querySelector('#peLive'); const { p, collect } = P.ed; const body = collect();
  try { const r = await api.post(`/api/operator/product-economics/${p.productId}/preview`, body); P.ed.last = r; if (!modalEl()?.querySelector('#peLive')) return;
    const sim = r.simulation; const names = { KEEP: ['استمرار', 'gray'], WOULD_INCREASE: ['هتزوّد', 'ok'], WOULD_REDUCE: ['هتقلّل', 'warn'], ZERO_ORDER_STOP: ['هتوقف', 'bad'] };
    live.innerHTML = r.errors?.length ? `<div class="opx2-banner bad">⚠️ ${E(r.errors.join(' '))}</div>` : `<div class="opx2-kv"><span>سعر البيع</span><b>${val(r.price.value, egp)}</b></div><div class="opx2-kv"><span>هامش الوحدة (= السعر − كل التكاليف)</span><b>${val(r.profit.unitMargin, egp)}</b></div><div class="opx2-kv"><span>الهامش من السعر</span><b>${r.profit.marginPct == null ? val(null) : r.profit.marginPct + '%'}</b></div><div class="opx2-kv"><span>أقصى CPA قبل الخسارة</span><b>${val(r.calculatedMaxCpa, egp)}</b></div><div class="opx2-kv"><span>صافي آخر 7 / 30 يوم</span><b>${money(r.profit.profit7)} / ${money(r.profit.profit30)}</b></div><small class="opx2-note">${E(r.profit.note)}</small>
      ${sim ? `<h3 style="margin-top:10px">لو السياسة دي شغالة دلوقتي (آخر 7 أيام)</h3>${sim.rows.length ? sim.rows.map((x) => `<div class="opx2-kv"><span>${E(x.name || x.campaignId)}</span><b>${pill(names[x.verdict]?.[0] || x.verdict, names[x.verdict]?.[1] || 'gray', x.why)}</b></div>`).join('') : '<small class="opx2-note">مفيش حملات شغالة للمنتج دلوقتي.</small>'}<small class="opx2-note">محاكاة من بيانات متزامنة، من غير حواجز الأمان الحية — مفيش تنفيذ.</small>` : '<small class="opx2-note">كمّل خطوط الـ CPA وحدود الميزانية عشان تظهر المحاكاة.</small>'}`;
    const sg = m.querySelector('#peSugNote'); if (sg && r.suggestion) sg.textContent = `المقترح من أقصى CPA ${r.suggestion.basis}: Scale ${r.suggestion.scale} · Reduce ${r.suggestion.reduce} · Hard Stop ${r.suggestion.hardStop}.`;
  } catch (e) { live.innerHTML = `<div class="opx2-banner bad">⚠️ ${E(e.message)}</div>`; }
}
async function save() {
  const { p, collect } = P.ed; const m = modalEl(); const btn = m.querySelector('#peSave'); btn.disabled = true;
  try { const r = await api.put(`/api/operator/product-economics/${p.productId}`, collect()); toast('اتحفظ كمسودة — مفيش تنفيذ. اعمل فحص الجاهزية.'); P.board = await api.get(`/api/operator/product-economics?scope=${P.scope}`); const np = P.board.products.find((x) => x.productId === p.productId); P.ed.p = np || p; m.querySelector('#peReady').innerHTML = readyHtml(r.card.readiness); P.ed.ready = r.card.readiness; P.ed.hasDraft = true; unlockAct(); draw(); }
  catch (e) { toast((e.details || [e.message]).join(' '), 'error'); } finally { btn.disabled = false; }
}
function unlockAct() { const m = modalEl(); const a = m?.querySelector('#peAct'); if (a && P.ed) a.disabled = !(P.ed.ready?.ready && P.ed.hasDraft); }
async function checkReady() {
  const { p } = P.ed; const m = modalEl();
  try { const r = await api.get(`/api/operator/product-economics/${p.productId}/readiness`); P.ed.ready = r; P.ed.hasDraft = r.hasDraft; m.querySelector('#peReady').innerHTML = `${readyHtml(r)}<div class="opx2-banner ${r.ready ? 'ok' : 'warn'}">${r.ready ? '✅ كل البنود تمام' + (r.hasDraft ? ' — تقدر تعتمد وتفعّل.' : ' — احفظ مسودة الأول.') : '⚠️ ناقص: ' + E(r.missing.map((x) => x.label.split('(')[0].trim()).join(' · '))}</div>`; unlockAct(); }
  catch (e) { toast(e.message || 'تعذّر فحص الجاهزية.', 'error'); }
}
async function activate() {
  const { p } = P.ed; let sum = null; try { sum = await api.get(`/api/operator/automation/activation-summary/${p.productId}?storeId=${encodeURIComponent(p.storeId || 'default')}`); } catch (e) { toast(e.message || 'تعذّر تجهيز ملخص التفعيل.', 'error'); return; }
  const ops = (sum.operations || []).map((o) => `<li>${E(o.label || o.op)}: ${o.willRun ? '✅ هيشتغل تلقائي' : '⛔ مش هيشتغل (' + (!o.permissionOn ? 'الصلاحية OFF' : 'السياسة العامة مش معتمدة') + ')'}</li>`).join('');
  openModal(`<div class="opx2-ped" style="max-width:640px;margin:0 auto"><h2>اعتماد وتفعيل AUTOMATIC — ${E(p.name)}</h2><div class="opx2-banner warn">⚠️ بعد التفعيل السيستم هيشتغل على <b>حملات المنتج ده</b> لوحده: يفتح ويقفل ويزوّد/يقلّل الميزانية 20% حسب الحدود اللي حفظتها — على Meta فعليًا (طالما الوضع العام AUTOMATIC والقفل مفتوح والصلاحيات ON).</div>
    <ul class="opx2-note">${ops}</ul><div class="opx2-kv"><span>حملات شغالة تحت السياسة</span><b>${num(sum.scope?.activeCount)}</b></div><div class="opx2-kv"><span>أقصى تعرّض يومي (سقف المنتج)</span><b>${val(sum.exposure?.maxDailyCap, egp)}</b></div><div class="opx2-kv"><span>مستوى المخاطرة</span><b>${E(sum.risk?.level || '—')}</b></div>
    <label class="opx2-fld"><input type="checkbox" id="peOk"> فهمت وأعتمد التفعيل بنفسي</label><div class="opx2-fld"><button class="opx2-btn pri" id="peGo" disabled>تفعيل AUTOMATIC</button><button class="opx2-btn" id="peNo">إلغاء</button></div></div>`);
  const m = modalEl(); const ok = m.querySelector('#peOk'), go = m.querySelector('#peGo'); ok.onchange = () => { go.disabled = !ok.checked; }; m.querySelector('#peNo').onclick = () => openEditor(p.productId);
  go.onclick = async () => { go.disabled = true; try { await api.post(`/api/operator/product-rules/${p.productId}/activate`, { storeId: p.storeId || 'default', confirm: true, confirmAutomatic: true }); toast('اتفعّل AUTOMATIC على المنتج — راقب «إيه اللي اتنفذ».'); closeAll(); await load(); } catch (e) { toast(e.message || 'التفعيل اتمنع.', 'error'); go.disabled = false; } };
}
