// ai-operator-setup.js — AI Operator setup & operations screens: control center (wizard, readiness, what-if, health, brief, safety, command center),
// product readiness + automation profile + bulk CSV setup, campaign mapping center, exceptions, execution log, performance.
// Presentation only: every number, guard and permission comes from /api/operator/* (the server is the authority).
import * as UI from './ui-common.js';
import { api } from './api-client.js';
import { drawCompletion } from './ai-operator-completion.js';
import { drawSetupGrid } from './ai-operator-grid.js';
import { E, $, num, egp, ago, dt, S, MODES, ACTION_ICON, STATUS_CLS, READY_CLS, PROFIT_AR, openDrawer, closeDrawer, drawerHead, kpi, fld, condText, blockPanel, wireSetupButtons } from './ai-operator-core.js';

const refresh = async () => { await S.hooks.refreshTop?.(); S.hooks.drawTop?.(); };

// =====================================================================================================================
// setup-action router: one place that turns a "[أدخل اقتصاديات المنتج]"-style button into the right screen
// =====================================================================================================================
export function handleSetupAction(type, { productId = null, campaignId = null } = {}) {
  if (['ECONOMICS', 'STOCK', 'HARD_STOP', 'DATA_QUALITY'].includes(type)) {
    if (productId) return showProfile(productId, { heavy: type === 'DATA_QUALITY', focus: type });
    if (type === 'DATA_QUALITY') { UI.toast('جودة البيانات بتتفحص لكل منتج — افتح "جاهزية المنتجات".'); return S.hooks.switchTab('readiness'); }
    UI.toast('الحملة دي مش مربوطة بمنتج — اربطها الأول.'); return S.hooks.switchTab('mapping', { campaignId });
  }
  if (type === 'MAPPING') return S.hooks.switchTab('mapping', { campaignId });
  if (type === 'EXCEPTIONS') return S.hooks.switchTab('excluded');
  if (type === 'RULES') return S.hooks.switchTab('rules');
  if (type === 'SAFETY') { S.hooks.switchTab('control'); setTimeout(() => $('opSafety')?.scrollIntoView({ behavior: 'smooth' }), 400); return; }
  if (type === 'EMERGENCY') return $('opResume')?.click() || UI.toast('إيقاف الطوارئ مش مفعّل.');
  if (type === 'MODE') { closeDrawer(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
}

// =====================================================================================================================
// product automation profile (spec 58) — single profile per store + product
// =====================================================================================================================
export async function showProfile(productId, { heavy = false, focus = null } = {}) {
  openDrawer(`${drawerHead('ملف أتمتة المنتج')}<div class="amb-drawer-body"><div class="amb-loading">جارِ التحميل…</div></div>`);
  let p; try { p = await api.get(`/api/operator/products/${productId}/profile`, { heavy: heavy ? 1 : 0 }); } catch (e) { UI.toast(e.message, 'error'); return closeDrawer(); }
  const ec = p.economics, st = p.stock, rd = p.readiness; const dis = S.isAdmin ? '' : 'disabled';
  const src = (o) => (o?.source ? `<small class="op-src">${E({ AMB: 'AMB', CATALOG: 'الكتالوج', OPERATOR_OVERRIDE: 'تخصيص Operator', CALCULATED: 'محسوب', MANUAL: 'يدوي' }[o.source] || o.source)}</small>` : '<small class="op-unk">غير مسجّل</small>');
  const f = (label, key, o, extra = '') => `<label>${E(label)} ${src(o)}<input id="f_${key}" type="number" min="0" step="any" value="${o?.value ?? ''}" data-orig="${o?.value ?? ''}" ${dis} ${extra} /></label>`;
  openDrawer(`${drawerHead(`${E(p.product.name)} <small>· ${E(p.store)}</small>`)}
    <div class="amb-drawer-body op-details">
      <div class="op-readyline ${READY_CLS[rd.state]}"><b>${rd.icon} ${E(rd.state)}</b> ${rd.missing.length ? `— ناقص: ${rd.missing.map((m) => E(m.label)).join('، ')}` : '— جاهز للأتمتة'}</div>
      <div class="op-block"><h4>✅ قائمة الجاهزية</h4><ul class="op-checklist">${rd.items.map((i) => `<li class="${i.ok ? 'ok' : i.pending ? 'pend' : 'no'}">${i.ok ? '✓' : i.pending ? '…' : '✗'} <b>${E(i.label)}</b> — ${E(i.detail)} ${!i.ok && i.action ? `<button class="amb-btn sm" data-focus="${E(i.key)}">${E(i.action.label)}</button>` : ''}</li>`).join('')}</ul>
        ${!heavy ? '<button class="amb-btn sm" id="opProfDq">فحص جودة البيانات والمخزون (ممكن ياخد وقت)</button>' : ''}</div>
      <div class="op-block"><h4>🏷️ الهوية</h4><div class="op-form"><label>المنتج<input value="${E(p.product.name)}" disabled /></label><label>المتجر<input value="${E(p.store)}" disabled /></label>
        <label>Product Key<input id="f_product_key" value="${E(p.productKey || '')}" ${dis} /></label></div></div>
      <div class="op-block"><h4>💰 الاقتصاديات</h4><div class="op-sub">كل رقم بيتحفظ في مكانه الأصلي (مفيش نسخ مكررة). الفاضي = غير معروف، ومش بيتحفظ صفر.</div>
        <div class="op-form">${f('سعر البيع', 'selling_price', ec.sellingPrice)}${f('تكلفة الشراء', 'product_cost', ec.purchaseCost)}${f('الشحن', 'shipping_cost', ec.shipping)}${f('التغليف', 'packaging_cost', ec.packaging)}${f('تكاليف أخرى', 'other_cost', ec.other)}</div>
        <div class="op-sub">هامش الوحدة (قبل الإعلانات): <b>${ec.unitMargin == null ? '— غير معروف' : egp(ec.unitMargin)}</b></div>
        <div class="op-form">${f('Target CPA', 'target_cpa', ec.targetCpa)}${f('Max CPA', 'max_cpa', ec.maxCpa)}${f('Hard Stop CPA', 'hard_stop_cpa', ec.hardStopCpa)}${f('أدنى ربح للوحدة', 'min_profit', ec.minProfit)}</div></div>
      ${priceBlock(p.priceResolution)}
      <div class="op-block"><h4>⛔ حد الإيقاف بدون أوردرات (لكل منتج)</h4><div class="op-sub">مفيش رقم عام ثابت. اختار طريقة لهذا المنتج — مع حماية عمر الحملة وآخر شراء وفترة السماح.${p.zeroOrder ? '' : ' <b class="op-bad">غير مضبوط → إيقاف الصفر-أوردرات محجوب لهذا المنتج.</b>'}</div>
        <div class="op-form"><label>الطريقة<select id="zo_mode" ${dis}><option value="">— غير مضبوط —</option><option value="FIXED_SPEND" ${p.zeroOrder?.mode === 'FIXED_SPEND' ? 'selected' : ''}>مبلغ ثابت (ج.م)</option><option value="TARGET_CPA_MULTIPLE" ${p.zeroOrder?.mode === 'TARGET_CPA_MULTIPLE' ? 'selected' : ''}>مضاعف Target CPA</option></select></label>
        <label>المبلغ الثابت<input id="zo_fixed" type="number" min="1" value="${p.zeroOrder?.fixedSpend ?? ''}" ${dis} /></label><label>المضاعف (× Target CPA)<input id="zo_mult" type="number" min="0.5" step="0.1" value="${p.zeroOrder?.multiple ?? ''}" ${dis} /></label>
        <label>أدنى عمر للحملة (ساعة)<input id="zo_age" type="number" min="0" value="${p.zeroOrder?.minCampaignAgeHours ?? ''}" ${dis} /></label><label>فترة السماح (ساعة)<input id="zo_grace" type="number" min="0" value="${p.zeroOrder?.attributionGraceHours ?? ''}" ${dis} /></label><label>حماية آخر شراء (ساعة)<input id="zo_recent" type="number" min="0" max="72" value="${p.zeroOrder?.recentPurchaseHours ?? ''}" ${dis} /></label></div>
        ${S.isAdmin ? '<button class="amb-btn" id="zoSave">حفظ حد الإيقاف</button>' : ''}</div>
      <div class="op-block"><h4>📦 المخزون</h4><div class="op-form">${f('المخزون الحالي', 'current_stock', { value: st.current, source: st.known ? 'CATALOG' : null })}${f('الحد الأدنى', 'minimum_stock', { value: st.minimum, source: st.minimum != null ? 'CATALOG' : null })}</div>
        <div class="op-sub">${st.known ? `الحالة: ${E(st.status || '—')}${st.daysRemaining != null ? ` · تغطية ${num(st.daysRemaining, 1)} يوم` : ''}` : 'المخزون غير مسجّل — الفتح والتوسع بيتمنعوا لحد ما تسجله.'}</div></div>
      <div class="op-block"><h4>⚙️ حدود الأتمتة</h4><div class="op-form">${f('أقصى نسبة توسع في الخطوة %', 'max_scale_pct', { value: p.scale.maxScalePct, source: p.scale.maxScalePct != null ? 'MANUAL' : null })}${f('ميزانية الاختبار (ج.م)', 'testing_spend_allowance', { value: p.testing.spendAllowance, source: p.testing.spendAllowance != null ? 'MANUAL' : null })}${f('أدنى عينة اختبار (أوردرات)', 'testing_min_sample', { value: p.testing.minSample, source: p.testing.minSample != null ? 'MANUAL' : null })}
        <label>وضع أتمتة المنتج<select id="f_automation_mode" ${dis}><option value="">يرث الوضع العام</option>${MODES.map((m) => `<option value="${m.key}" ${p.automationMode === m.key ? 'selected' : ''}>${E(m.label)}</option>`).join('')}</select></label></div>
        <div class="op-sub">الوضع الأشد (العام أو الخاص بالمنتج أو القاعدة) هو اللي بيحكم.</div></div>
      <div class="op-block"><h4>🔗 الحملات المربوطة (${p.campaigns.length})</h4>${p.campaigns.length ? `<ul class="op-ul">${p.campaigns.slice(0, 15).map((c) => `<li>${E(c.campaignName || c.campaignId)} <span class="op-pill ${c.verified ? 'green' : 'amber'}">${c.verified ? 'VERIFIED' : 'SUGGESTED'}</span></li>`).join('')}</ul>` : '<div class="op-unk">مفيش حملات مربوطة</div>'}</div>
      <div class="op-block"><h4>🚫 الاستثناءات</h4>${p.exceptions.length ? `<ul class="op-ul">${p.exceptions.map((x) => `<li>${E(x.scope_type)} ${E(x.scope_label || x.scope_id)} — ${E(x.types.join(', '))}</li>`).join('')}</ul>` : '<div class="op-unk">مفيش</div>'}</div>
      ${S.isAdmin ? '<div id="opProfMsg"></div><button class="amb-btn success" id="opProfSave">حفظ الملف</button>' : ''}
    </div>`);
  wireProfile(p, productId);
  if (focus) { const map = { ECONOMICS: 'f_product_cost', STOCK: 'f_current_stock', HARD_STOP: 'f_hard_stop_cpa' }; setTimeout(() => $(map[focus] || '')?.focus(), 300); }
}
function priceBlock(pr) {
  if (!pr) return '';
  const lab = { OWNER_ENTERED: 'AMB (إدخالك)', CATALOG: 'كتالوج المنتجات', STORE_CATALOG: 'كتالوج المتجر (Easy Orders)' };
  if (pr.status === 'CONFLICT') return `<div class="op-banner red">⚠️ <b>تعارض في سعر البيع</b> — ${E(pr.reason)}<br>${Object.entries(pr.conflict || {}).map(([k, v]) => `<span class="op-pill amber">${E({ owner: 'AMB', catalog: 'الكتالوج', storeCatalog: 'كتالوج المتجر' }[k] || k)}: ${num(v)} ج.م</span>`).join(' ')}<br>القرارات المعتمدة على الربح متوقفة لحد ما تحسم السعر الصحيح (الحقل اللي تحت).</div>`;
  if (pr.status === 'FROM_STORE_CATALOG') return `<div class="op-banner blue">💡 السعر <b>${num(pr.value)} ج.م</b> مأخوذ من ${E(lab.STORE_CATALOG)} (مطابقة اسم دقيقة وفريدة داخل نفس المتجر) — مقترح للمراجعة، اكتبه في «سعر البيع» لو صح.</div>`;
  if (pr.status === 'MISSING') return `<div class="op-banner amber">سعر البيع: ${E(pr.reason || 'غير موجود')}</div>`;
  return `<div class="op-sub">سعر البيع الموثَّق: <b>${num(pr.value)} ج.م</b> — ${E(lab[pr.source] || pr.source)} ${pr.status === 'VERIFIED' ? '✓ مطابق لكتالوج المتجر' : '(لم يُقارَن بكتالوج المتجر)'}</div>`;
}
function wireProfile(p, productId) {
  const root = $('ambDrawerPanel');
  root.querySelectorAll('[data-focus]').forEach((b) => { b.onclick = () => { const m = { ECONOMICS: 'f_product_cost', STOCK: 'f_current_stock', MIN_STOCK: 'f_minimum_stock', TARGET_CPA: 'f_target_cpa', HARD_STOP: 'f_hard_stop_cpa' }[b.dataset.focus]; if (m) $(m)?.focus(); else if (b.dataset.focus === 'MAPPING') { closeDrawer(); S.hooks.switchTab('mapping'); } else if (b.dataset.focus === 'DATA_QUALITY') $('opProfDq')?.click(); }; });
  if ($('zoSave')) $('zoSave').onclick = async () => {
    const mode = $('zo_mode').value; const n = (id) => { const v = $(id).value.trim(); return v === '' ? undefined : Number(v); };
    const zeroOrder = mode ? { mode, fixedSpend: mode === 'FIXED_SPEND' ? n('zo_fixed') : undefined, multiple: mode === 'TARGET_CPA_MULTIPLE' ? n('zo_mult') : undefined, minCampaignAgeHours: n('zo_age'), attributionGraceHours: n('zo_grace'), recentPurchaseHours: n('zo_recent') } : null;
    try { await api.put(`/api/operator/products/${productId}/zero-order`, { zeroOrder }); UI.toast('تم الحفظ'); await refresh(); showProfile(productId); } catch (e) { $('opProfMsg') ? ($('opProfMsg').innerHTML = `<div class="op-bad">✗ ${E(e.message)}</div>`) : UI.toast(e.message, 'error'); }
  };
  if ($('opProfDq')) $('opProfDq').onclick = () => showProfile(productId, { heavy: true });
  if ($('opProfSave')) $('opProfSave').onclick = async () => {
    const patch = {};
    for (const k of ['selling_price', 'product_cost', 'shipping_cost', 'packaging_cost', 'other_cost', 'target_cpa', 'max_cpa', 'hard_stop_cpa', 'min_profit', 'current_stock', 'minimum_stock', 'max_scale_pct', 'testing_spend_allowance', 'testing_min_sample']) { const el = $(`f_${k}`); if (el && el.value !== el.dataset.orig) patch[k] = el.value.trim() === '' ? null : Number(el.value); }
    if ($('f_product_key').value.trim() !== (p.productKey || '')) patch.product_key = $('f_product_key').value.trim() || null;
    const am = $('f_automation_mode').value || null; if (am !== (p.automationMode || null)) patch.automation_mode = am;
    if (!Object.keys(patch).length) return UI.toast('مفيش تغيير.');
    try { const r = await api.put(`/api/operator/products/${productId}/profile`, patch); UI.toast('تم الحفظ'); if (r.warnings?.length) UI.toast(r.warnings[0], 'error'); await refresh(); showProfile(productId); S.hooks.reloadBody?.(); }
    catch (e) { $('opProfMsg').innerHTML = `<div class="op-bad">✗ ${E(e.message)}</div>`; }
  };
}

// =====================================================================================================================
// product readiness (spec 59/61)
// =====================================================================================================================
let readyFilter = 'ALL';
export async function drawReadiness(body, { heavy = false } = {}) {
  // default view = the editable Setup Grid (all products in one table); the classic list (with the data-quality check) is one click away
  if (S.readyView !== 'list') {
    body.innerHTML = '<div class="op-toolbar"><div><button class="amb-btn" id="opViewList">📋 عرض القائمة وفحص جودة البيانات</button></div></div><div id="opGridRoot"></div>';
    $('opViewList').onclick = () => { S.readyView = 'list'; drawReadiness(body); };
    return drawSetupGrid($('opGridRoot'));
  }
  body.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  const r = await api.get('/api/operator/readiness', { heavy: heavy ? 1 : 0 });
  S.products = r.products;
  const c = { READY: 0, PARTIAL: 0, BLOCKED: 0 }; r.products.forEach((p) => c[p.readiness.state]++);
  const rows = r.products.filter((p) => readyFilter === 'ALL' || p.readiness.state === readyFilter);
  body.innerHTML = `
    <div class="op-toolbar"><div class="amb-filters" style="margin:0">${['ALL', 'BLOCKED', 'PARTIAL', 'READY'].map((k) => `<button class="amb-fbtn ${readyFilter === k ? 'active' : ''}" data-rf="${k}">${k === 'ALL' ? `الكل (${r.products.length})` : `${{ BLOCKED: '🔴', PARTIAL: '🟡', READY: '🟢' }[k]} ${k} (${c[k]})`}</button>`).join('')}</div>
      <div><button class="amb-btn orange" id="opViewGrid">📝 جدول الإعداد الشامل</button> ${heavy ? '' : '<button class="amb-btn" id="opRdDq">فحص جودة البيانات (ياخد وقت)</button>'} ${S.isAdmin ? '<button class="amb-btn orange" id="opRdImport">📥 إعداد جماعي (CSV)</button>' : ''}</div></div>
    ${heavy ? '' : '<div class="op-sub">جودة البيانات لسه ما اتفحصتش — المنتج مش بيتحسب READY قبل ما تتفحص.</div>'}
    <div class="table-wrap"><table class="data op-table2"><thead><tr><th>الجاهزية</th><th>المنتج</th><th>المتجر</th><th>حملات مربوطة</th><th>الاقتصاديات</th><th>المخزون</th><th>Target</th><th>Hard Stop</th><th>الأتمتة</th><th>الناقص</th><th></th></tr></thead><tbody>
    ${rows.map((p) => `<tr><td><span class="op-pill ${READY_CLS[p.readiness.state]}">${p.readiness.icon} ${E(p.readiness.state)}</span></td><td><b>${E(p.name)}</b>${p.productKey ? `<div class="op-camp">${E(p.productKey)}</div>` : ''}</td><td>${E(p.storeId)}</td>
      <td>${num(p.campaignsMapped)}${p.campaignsSuggested ? ` <small class="op-unk">(+${p.campaignsSuggested} مقترح)</small>` : ''}</td><td>${p.economicsComplete ? '✓' : '<span class="op-unk">ناقصة</span>'}</td><td>${p.stockKnown ? num(p.stock) : '<span class="op-unk">غير مسجّل</span>'}</td><td>${p.targetCpa == null ? '<span class="op-unk">—</span>' : egp(p.targetCpa)}</td><td>${p.hardStop == null ? '<span class="op-unk">—</span>' : egp(p.hardStop)}</td><td>${E(p.automationMode || 'يرث')}</td>
      <td class="op-why">${p.readiness.missing.slice(0, 4).map((m) => `<button class="amb-btn sm ${m.severity === 'CRITICAL' ? 'orange' : ''}" data-setup="${E(m.action.type)}" data-pid="${p.productId}" data-cid="">${E(m.action.label)}</button>`).join(' ') || '<span class="op-ok">كله تمام</span>'}</td>
      <td><button class="amb-btn sm" data-prof="${p.productId}">فتح الملف</button></td></tr>`).join('')}</tbody></table></div>`;
  body.querySelectorAll('[data-rf]').forEach((b) => { b.onclick = () => { readyFilter = b.dataset.rf; drawReadiness(body, { heavy }); }; });
  body.querySelectorAll('[data-prof]').forEach((b) => { b.onclick = () => showProfile(Number(b.dataset.prof)); });
  if ($('opRdDq')) $('opRdDq').onclick = () => { $('opRdDq').disabled = true; $('opRdDq').textContent = '⏳ بيفحص…'; drawReadiness(body, { heavy: true }).catch((e) => UI.toast(e.message, 'error')); };
  if ($('opViewGrid')) $('opViewGrid').onclick = () => { S.readyView = 'grid'; drawReadiness(body); };
  if ($('opRdImport')) $('opRdImport').onclick = showImport;
  wireSetupButtons(body);
}

// ---- bulk setup (spec 61) -------------------------------------------------------------------------------------------------------------------------
function showImport() {
  openDrawer(`${drawerHead('📥 إعداد جماعي للمنتجات')}<div class="amb-drawer-body op-details">
    <div class="op-sub">1) نزّل القالب (فيه كل منتجاتك) · 2) املا الأرقام اللي عندك بس (الفاضي = متتغيّرش) · 3) ارفعه أو الصقه · 4) راجع المعاينة · 5) طبّق. مفيش حاجة بتتحفظ قبل ما تضغط "طبّق".</div>
    <div class="op-form"><a class="amb-btn" href="/api/operator/import/template" download>⬇️ نزّل القالب</a><label>ارفع ملف CSV<input type="file" id="impFile" accept=".csv,.txt,text/csv" /></label></div>
    <textarea id="impText" class="op-textarea" placeholder="product_id,product,store,purchase_cost,selling_price,shipping,packaging,target_cpa,hard_stop_cpa,minimum_stock,current_stock"></textarea>
    <div style="margin:10px 0"><button class="amb-btn" id="impPrev">معاينة (بدون حفظ)</button></div><div id="impOut"></div></div>`);
  $('impFile').onchange = (ev) => { const f = ev.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { $('impText').value = String(rd.result || ''); }; rd.readAsText(f, 'utf-8'); };
  $('impPrev').onclick = async () => {
    const csv = $('impText').value; const out = $('impOut'); if (!csv.trim()) return UI.toast('الصق CSV أو ارفع ملف.');
    out.innerHTML = '<div class="amb-loading">…</div>';
    try {
      const pv = await api.post('/api/operator/import/preview', { csv });
      if (!pv.ok) { out.innerHTML = `<div class="op-bad">${E(pv.error)}</div>`; return; }
      const s = pv.summary;
      out.innerHTML = `<div class="op-sub">${num(s.rows)} صف · <b class="op-ok">${s.ok} سليم</b> · <b>${s.warn} تحذير</b> · <b class="op-bad">${s.error} خطأ</b>${s.truncated ? ' · (اتقطع عند 500 صف)' : ''}</div>
        <div class="table-wrap"><table class="data op-table2"><thead><tr><th>سطر</th><th>المنتج</th><th>الحالة</th><th>التغييرات (من ← إلى)</th><th>ملاحظات</th></tr></thead><tbody>${pv.rows.map((r) => `<tr class="${r.status === 'ERROR' ? 'blocked' : ''}"><td>${r.line}</td><td>${E(r.product ? `${r.product.name} · ${r.product.storeId}` : r.input)}</td><td><span class="op-pill ${r.status === 'OK' ? 'green' : r.status === 'WARN' ? 'amber' : 'red'}">${r.status}</span></td>
        <td class="op-why">${r.changes.map((c) => `${E(c.field)}: ${E(c.from ?? '—')} ← <b>${E(c.to)}</b>`).join('<br>') || '—'}</td><td class="op-why">${[...r.errors.map((e) => `<span class="op-bad">✗ ${E(e)}</span>`), ...r.warnings.map((w) => `⚠️ ${E(w)}`)].join('<br>')}</td></tr>`).join('')}</tbody></table></div>
        <label class="op-check"><input type="checkbox" id="impSkip" ${s.error ? '' : 'disabled'} /> تجاهل الصفوف الغلط وطبّق السليم بس</label>
        <button class="amb-btn success" id="impApply" ${s.ok + s.warn === 0 ? 'disabled' : ''}>طبّق على ${s.ok + s.warn} صف</button>`;
      $('impApply').onclick = async () => {
        if (!(await UI.confirmModal({ title: 'تطبيق الإعداد الجماعي', message: `هيتحفظ ${s.ok + s.warn} صف في أماكنه الأصلية (اقتصاديات AMB / مخزون الكتالوج / إعدادات Operator).`, confirmLabel: 'طبّق' }))) return;
        try { const r = await api.post('/api/operator/import/apply', { csv, skipInvalid: $('impSkip').checked }); UI.toast(`اتحفظ ${r.summary.saved} · اتجاهل ${r.summary.skipped} · بدون تغيير ${r.summary.unchanged}${r.summary.failed ? ` · فشل ${r.summary.failed}` : ''}`); closeDrawer(); await refresh(); S.hooks.reloadBody?.(); } catch (e) { UI.toast(e.message, 'error'); }
      };
    } catch (e) { out.innerHTML = `<div class="op-bad">${E(e.message)}</div>`; }
  };
}

// =====================================================================================================================
// campaign mapping center (spec 62/63)
// =====================================================================================================================
let mapFilter = 'ALL'; let mapSearch = '';
/** Review queue grouped by name family — ONE human decision per family (still confirm-only: nothing becomes VERIFIED without the click). */
function famPanel(r) {
  const fams = [...(r.families || [])].sort((a, b) => (b.reviews.includes('CONFIRM') ? 1 : 0) - (a.reviews.includes('CONFIRM') ? 1 : 0) || b.spend7d - a.spend7d).slice(0, 80); if (!fams.length) return '';
  const opts = (sel) => `<option value="">— المنتج —</option>${(S.products || []).map((p) => `<option value="${p.ambProductId}" ${sel === p.ambProductId ? 'selected' : ''}>${E(p.name)} · ${E(p.storeId)}</option>`).join('')}`;
  return `<div class="amb-panel"><h3>🗂️ قائمة المراجعة (${num(r.counts.review)} حملة · ${num(r.counts.families)} عائلة)</h3><div class="op-sub">حملات ملهاش دليل حاسم، متجمّعة بعائلة الاسم — قرار واحد لكل عائلة. ${num(r.counts.ambiguous)} فيها أكتر من منتج محتمل.</div>${fams.map((f, i) => `<div class="op-fam"><div><b>${E(f.prefix || '—')}</b> · ${num(f.count)} حملة · صرف 7 أيام ${num(f.spend7d)} ج.م<div class="op-camp">${E(f.sampleNames.join(' | '))}${f.reviews.includes('AMBIGUOUS') ? ' · <b class="op-bad">غامضة</b>' : ''}</div></div>${S.isAdmin ? `<select id="famPick_${i}">${opts(f.suggestedAmbProductId)}</select><button class="amb-btn success sm" data-fam="${i}">أكّد العائلة</button>` : ''}</div>`).join('')}</div>`;
}
const MAP_CLS = { VERIFIED: 'green', SUGGESTED: 'amber', UNMAPPED: 'gray', CONFLICT: 'red' };
export async function drawMapping(body) {
  body.innerHTML = '<div class="amb-loading">جارِ التحميل… (264 حملة تقريبًا)</div>';
  const [r, rd] = await Promise.all([api.get('/api/operator/mapping'), S.products ? { products: S.products } : api.get('/api/operator/readiness')]);
  S.products = rd.products;
  if (!r.connected) { body.innerHTML = '<div class="amb-panel amb-empty">اربط حساب Meta الأول.</div>'; return; }
  if (S.mapFocus) { mapSearch = ''; mapFilter = 'ALL'; }
  const rows = r.rows.filter((x) => (mapFilter === 'ALL' || x.state === mapFilter) && (!mapSearch || (x.campaignName || '').toLowerCase().includes(mapSearch.toLowerCase())));
  body.innerHTML = `
    <div class="op-banner blue">🔗 ${E(r.note)} (VERIFIED فقط = ربط يدوي مؤكَّد أو حملة اترفعت من النظام.)</div>
    <div class="op-toolbar"><div class="amb-filters" style="margin:0">${['ALL', 'CONFLICT', 'UNMAPPED', 'SUGGESTED', 'VERIFIED'].map((k) => `<button class="amb-fbtn ${mapFilter === k ? 'active' : ''}" data-mf="${k}">${k === 'ALL' ? `الكل (${r.total})` : `${k} (${r.counts[k]})`}</button>`).join('')}</div>
      <div><input id="mapSearch" class="op-search" placeholder="بحث باسم الحملة" value="${E(mapSearch)}" />${S.isAdmin ? ' <button class="amb-btn" id="mapSuggest" title="يحفظ كاقتراح (SUGGESTED) أي حملة اسمها فيه Product Key معروف — مبيأكدش حاجة">اقترح ربط بالـProduct Key</button>' : ''}</div></div>
    ${famPanel(r)}
    <div class="table-wrap"><table class="data op-table2"><thead><tr><th>الحملة</th><th>صرف 7 أيام</th><th>Product Key المكتشف</th><th>المنتج الحالي / المقترح</th><th>الثقة</th><th>المصدر</th><th>الحالة</th><th></th></tr></thead><tbody>
    ${rows.map((x) => `<tr class="${S.mapFocus === x.campaignId ? 'op-focus' : ''} ${x.state === 'CONFLICT' ? 'blocked' : ''}" id="mrow_${E(x.campaignId)}"><td><div class="op-prod" title="${E(x.campaignId)}">${E(x.campaignName || x.campaignId)}</div><div class="op-camp">${E(x.campaignStatus)}${x.excluded ? ' · <b>مستبعدة</b>' : ''}</div></td><td>${egp(x.spend7d)}</td><td>${E(x.detectedProductKey || '—')}</td>
      <td>${x.product ? `<b>${E(x.product.name)}</b>` : x.suggestion ? `<span class="op-sugg">${E(x.suggestion.productName)}</span><div class="op-camp">${E(x.suggestion.evidence)}</div>` : '<span class="op-unk">—</span>'}${x.note ? `<div class="op-bad">${E(x.note)}</div>` : ''}</td>
      <td>${x.confidence == null ? '—' : `${Math.round(x.confidence * 100)}%`}${x.suggestion?.weak ? ' <small class="op-unk">(ضعيف)</small>' : ''}</td><td>${E(x.source)}</td><td><span class="op-pill ${MAP_CLS[x.state]}">${E(x.state)}</span></td>
      <td class="op-btns">${S.isAdmin ? `${x.suggestion && x.state !== 'VERIFIED' ? `<button class="amb-btn success sm" data-mc="confirm" data-cid="${E(x.campaignId)}" data-pid="${x.suggestion.ambProductId}">أكّد الربط</button>` : ''}<button class="amb-btn sm" data-mc="change" data-cid="${E(x.campaignId)}">${x.product ? 'غيّر المنتج' : 'اختار منتج'}</button>${x.state === 'VERIFIED' ? `<button class="amb-btn sm" data-mc="unmap" data-cid="${E(x.campaignId)}">فك الربط</button>` : ''}<button class="amb-btn sm" data-mc="${x.excluded ? 'include' : 'exclude'}" data-cid="${E(x.campaignId)}">${x.excluded ? 'رجّع للأتمتة' : 'استبعد'}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  body.querySelectorAll('[data-mf]').forEach((b) => { b.onclick = () => { mapFilter = b.dataset.mf; S.mapFocus = null; drawMapping(body); }; });
  $('mapSearch').onchange = (e) => { mapSearch = e.target.value; S.mapFocus = null; drawMapping(body); };
  body.querySelectorAll('[data-fam]').forEach((b) => { b.onclick = async () => {
    const f = (r.families || [])[Number(b.dataset.fam)]; const sel = body.querySelector(`#famPick_${b.dataset.fam}`); const pid = Number(sel?.value); if (!f || !pid) return UI.toast('اختار المنتج الأول.');
    const pn = (S.products || []).find((x) => x.ambProductId === pid)?.name || '';
    if (!(await UI.confirmModal({ title: 'تأكيد ربط عائلة حملات', message: `ربط ${f.count} حملة (${f.prefix}) بالمنتج «${pn}» كـVERIFIED. الأتمتة هتبقى مسموحة عليهم. إنت اللي بتقرر — مفيش ربط تلقائي.`, confirmLabel: 'أكّد الكل' }))) return;
    try { const x = await api.post('/api/operator/mapping/confirm-family', { campaignIds: f.campaignIds.slice(0, 40), ambProductId: pid }); UI.toast(`اتأكد ${x.confirmed} ربط`); await refresh(); drawMapping(body); } catch (e) { UI.toast(e.message, 'error'); }
  }; });
  if ($('mapSuggest')) $('mapSuggest').onclick = async () => { try { const x = await api.post('/api/operator/mapping/suggest', {}); UI.toast(`اتحفظ ${x.saved} اقتراح (SUGGESTED) — محتاجين تأكيدك`); drawMapping(body); } catch (e) { UI.toast(e.message, 'error'); } };
  const byId = new Map(r.rows.map((x) => [x.campaignId, x]));
  body.querySelectorAll('[data-mc]').forEach((b) => { b.onclick = async () => {
    const x = byId.get(b.dataset.cid); const act = b.dataset.mc;
    try {
      if (act === 'confirm') { if (!(await UI.confirmModal({ title: 'تأكيد الربط', message: `ربط «${x.campaignName}» بـ«${x.suggestion.productName}» كـVERIFIED. الأتمتة هتبقى مسموحة على الحملة دي.`, confirmLabel: 'أكّد' }))) return; await api.post('/api/operator/mapping/confirm', { campaignId: x.campaignId, campaignName: x.campaignName, ambProductId: Number(b.dataset.pid) }); UI.toast('تم الربط'); }
      else if (act === 'change') return pickProduct(x, body);
      else if (act === 'unmap') { if (!(await UI.confirmModal({ title: 'فك الربط', message: 'الحملة هترجع UNMAPPED والأتمتة هتتمنع عليها.', confirmLabel: 'فك', danger: true }))) return; await api.delete(`/api/operator/mapping/${encodeURIComponent(x.campaignId)}`); UI.toast('تم'); }
      else if (act === 'exclude' || act === 'include') { await api.post('/api/operator/mapping/exclude', { campaignId: x.campaignId, campaignName: x.campaignName, exclude: act === 'exclude' }); UI.toast(act === 'exclude' ? 'اتستبعدت من الأتمتة' : 'رجعت للأتمتة'); }
      await refresh(); drawMapping(body);
    } catch (e) { UI.toast(e.message, 'error'); }
  }; });
  if (S.mapFocus) { const el = $(`mrow_${S.mapFocus}`); if (el) el.scrollIntoView({ block: 'center' }); S.mapFocus = null; }
}
function pickProduct(x, body) {
  const opts = (S.products || []).map((p) => `<option value="${p.ambProductId}" ${x.product?.ambProductId === p.ambProductId ? 'selected' : ''}>${E(p.name)} · ${E(p.storeId)}</option>`).join('');
  openDrawer(`${drawerHead('اختيار منتج للحملة')}<div class="amb-drawer-body op-details"><div class="op-sub">${E(x.campaignName)}</div><div class="op-form"><label>المنتج<select id="mapPick"><option value="">— اختار —</option>${opts}</select></label></div><button class="amb-btn success" id="mapPickGo">أكّد الربط (VERIFIED)</button></div>`);
  $('mapPickGo').onclick = async () => { const v = $('mapPick').value; if (!v) return UI.toast('اختار منتج.'); try { await api.post('/api/operator/mapping/confirm', { campaignId: x.campaignId, campaignName: x.campaignName, ambProductId: Number(v) }); UI.toast('تم الربط'); closeDrawer(); await refresh(); drawMapping(body); } catch (e) { UI.toast(e.message, 'error'); } };
}

// =====================================================================================================================
// exceptions ("المستثناة")
// =====================================================================================================================
export async function drawExcluded(body) {
  body.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  const [r, d] = await Promise.all([api.get('/api/operator/exceptions'), api.get('/api/operator/decisions', { bucket: 'excluded', limit: 100 })]);
  body.innerHTML = `
    <div class="amb-panel"><h3>🚫 الاستثناءات الفعّالة (بتتغلب على أي قاعدة)</h3>${r.exceptions.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>النطاق</th><th>العنصر</th><th>النوع</th><th>السبب</th><th>ينتهي</th><th></th></tr></thead><tbody>${r.exceptions.map((x) => `<tr><td>${E(x.scope_type)}</td><td>${E(x.scope_label || x.scope_id)}</td><td>${x.types.map((t) => `<span class="op-pill gray">${E(t)}</span>`).join(' ')}</td><td>${E(x.reason || '—')}</td><td>${x.expires_at ? E(dt(x.expires_at)) : 'دائم'}</td><td>${S.isAdmin ? `<button class="amb-btn danger sm" data-rx="${x.id}">إزالة</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="amb-empty">مفيش استثناءات.</div>'}
      ${S.isAdmin ? `<h4 style="margin-top:14px">➕ استثناء جديد</h4><div class="op-form"><label>النطاق<select id="xs"><option value="CAMPAIGN">حملة (Campaign ID)</option><option value="PRODUCT">منتج (Product ID)</option><option value="STORE">متجر (store id)</option><option value="TAG">وسم (مثلاً TESTING)</option></select></label><label>المعرّف<input id="xi" placeholder="ID" /></label>
      <label>النوع<select id="xt"><option value="NO_AUTO_STOP">NO AUTO STOP</option><option value="NO_AUTO_OPEN">NO AUTO OPEN</option><option value="NO_AUTO_SCALE">NO AUTO SCALE</option><option value="NO_BUDGET_CHANGE">NO BUDGET CHANGE</option><option value="NO_AUTOMATION">NO AUTOMATION</option></select></label><label>مدة (ساعات، فاضي=دائم)<input id="xh" type="number" min="1" /></label><label>السبب<input id="xr" /></label></div><button class="amb-btn success" id="xAdd">إضافة</button>` : ''}</div>
    <div class="amb-panel"><h3>🛡️ قرارات اتحمت بسبب استثناء / حملة اختبار / أتمتة منتج مقفولة (${d.decisions.length})</h3>${d.decisions.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>الحملة</th><th>المنتج</th><th>الأكشن المطلوب</th><th>السبب</th></tr></thead><tbody>${d.decisions.map((x) => `<tr><td>${E(x.campaignName || x.campaignId)}</td><td>${E(x.productName || '—')}</td><td>${ACTION_ICON[x.action] || ''} ${E(x.actionLabel)}</td><td class="op-why">${E(x.primaryBlock?.message || '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="amb-empty">لا حاجة.</div>'}</div>`;
  body.querySelectorAll('[data-rx]').forEach((b) => { b.onclick = async () => { await api.delete(`/api/operator/exceptions/${b.dataset.rx}`); UI.toast('تمت الإزالة'); await refresh(); drawExcluded(body); }; });
  if ($('xAdd')) $('xAdd').onclick = async () => { const id = $('xi').value.trim(); if (!id) return UI.toast('المعرّف مطلوب.'); const h = $('xh').value.trim(); try { await api.post('/api/operator/exceptions', { scopeType: $('xs').value, scopeId: id, scopeLabel: id, types: [$('xt').value], reason: $('xr').value.trim() || null, ttlHours: h ? Number(h) : null }); UI.toast('تم'); await refresh(); drawExcluded(body); } catch (e) { UI.toast(e.message, 'error'); } };
}

// =====================================================================================================================
// execution log (spec 65/105/106/107)
// =====================================================================================================================
export async function drawHistory(body) {
  body.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  const [r, au] = await Promise.all([api.get('/api/operator/decisions', { bucket: 'history', limit: 150 }), api.get('/api/operator/audit', { limit: 60 })]);
  const rows = r.decisions;
  body.innerHTML = `
    <div class="amb-panel"><h3>📜 سجل التنفيذ (${rows.length})</h3><div class="op-sub">"تم التنفيذ" بتظهر بس بعد قراءة Meta اللي أكدت التغيير. قبل كده بتظهر "اتبعت لـ Meta".</div>${rows.length ? `<div class="table-wrap"><table class="data op-table2"><thead><tr><th>الوقت</th><th>الحملة</th><th>الأكشن</th><th>القاعدة</th><th>الحالة</th><th>قبل ← بعد</th><th>الأثر</th><th></th></tr></thead><tbody>
      ${rows.map((d) => `<tr><td>${E(dt(d.executedAt || d.updatedAt))}</td><td><div class="op-prod">${E(d.campaignName || d.campaignId)}</div><div class="op-camp">${E(d.productName || '')}</div></td><td>${ACTION_ICON[d.action] || ''} ${E(d.actionLabel)}</td><td>${E(d.ruleName || '—')}${d.ruleVersion ? ` <small>v${d.ruleVersion}</small>` : ''}</td>
      <td><span class="op-pill ${STATUS_CLS[d.status] || 'gray'}">${E(d.lifecycleLabel)}</span>${d.error ? `<div class="op-bad op-camp">${E(d.error)}</div>` : ''}</td>
      <td>${d.canonical.budgetChange ? `${num(d.canonical.budgetChange.from)} ← ${num(d.canonical.budgetChange.to)} (${d.canonical.budgetChange.pct > 0 ? '+' : ''}${d.canonical.budgetChange.pct}%)` : `${E(d.canonical.previousMetaState.status || '—')} ← ${E(d.canonical.proposedMetaState.status || '—')}`}</td>
      <td class="op-why">${d.outcome ? `${E(d.outcome.verdict)}${d.outcome.cpaBefore != null ? ` · CPA ${num(d.outcome.cpaBefore)} ← ${num(d.outcome.cpaAfter)}` : ''}${d.outcome.note ? `<div class="op-camp">${E(d.outcome.note)}</div>` : ''}` : '<span class="op-unk">لسه</span>'}</td>
      <td class="op-btns"><button class="amb-btn sm" data-ev="${d.id}">الخط الزمني</button>${S.isAdmin && d.status === 'FAILED' && d.errorCategory === 'RETRYABLE' ? `<button class="amb-btn sm warning" data-retry="${d.id}">إعادة محاولة</button>` : ''}${S.isAdmin && ['EXECUTED', 'VERIFIED'].includes(d.status) && d.rollback ? `<button class="amb-btn sm" data-rb="${d.id}">تجهيز رجوع</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="amb-empty">مفيش تنفيذات لسه.</div>'}</div>
    <div class="amb-panel"><h3>🧾 سجل تغييرات الإعدادات والقواعد</h3>${au.entries.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>الوقت</th><th>المستخدم</th><th>الحدث</th><th>تفاصيل</th></tr></thead><tbody>${au.entries.map((a) => `<tr><td>${E(dt(a.at))}</td><td>${E(a.actor)}</td><td>${E(a.label)}</td><td class="op-why"><code>${E(JSON.stringify(a.input || {}).slice(0, 160))}</code></td></tr>`).join('')}</tbody></table></div>` : '<div class="amb-empty">—</div>'}</div>`;
  body.querySelectorAll('[data-ev]').forEach((b) => { b.onclick = () => showEvents(Number(b.dataset.ev)); });
  body.querySelectorAll('[data-retry]').forEach((b) => { b.onclick = async () => { try { await api.post(`/api/operator/decisions/${b.dataset.retry}/retry`, {}); UI.toast('اتجهز للموافقة من جديد'); await refresh(); drawHistory(body); } catch (e) { UI.toast(e.message, 'error'); } }; });
  body.querySelectorAll('[data-rb]').forEach((b) => { b.onclick = async () => { try { await api.post(`/api/operator/decisions/${b.dataset.rb}/rollback`, { reason: 'MANUAL' }); UI.toast('اتجهز رجوع — هيظهر في "قرارات اليوم" للموافقة'); await refresh(); } catch (e) { UI.toast(e.message, 'error'); } }; });
}
export async function showEvents(id) {
  const r = await api.get(`/api/operator/decisions/${id}/events`);
  openDrawer(`${drawerHead(`الخط الزمني — قرار #${id}`)}<div class="amb-drawer-body op-details">${r.events.length ? `<ol class="op-timeline">${r.events.map((e) => `<li><b>${E(e.from || '·')} → ${E(e.to || e.kind)}</b> <small>${E(e.actor || '')} · ${E(dt(e.at))}</small>${e.note ? `<div class="op-camp">${E(e.note)}</div>` : ''}</li>`).join('')}</ol>` : '<div class="op-unk">مفيش أحداث.</div>'}</div>`);
}

// =====================================================================================================================
// performance (spec 97–99) + shadow report
// =====================================================================================================================
export async function drawPerformance(body) {
  body.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  const [p, sh] = await Promise.all([api.get('/api/operator/performance', { days: 30 }), api.get('/api/operator/shadow-report', { days: 7 })]);
  const t = p.totals, h = sh.hindsight;
  body.innerHTML = `
    <div class="amb-panel"><h3>📊 أداء AI Operator — آخر ${p.days} يوم</h3>
      <div class="amb-kpis op-kpis">${kpi('اتنفذ', t.executed, 'green')}${kpi('اتأكد من Meta', t.verified, 'green')}${kpi('فشل', t.failed, 'red')}${kpi('اترجع', t.rolledBack, 'purple')}${kpi('ممنوع', t.blocked, 'red')}${kpi('مرفوض', t.rejected, 'gray')}${kpi('انتهت صلاحيته', t.expired, 'gray')}</div>
      <div class="table-wrap"><table class="data"><thead><tr><th>النوع</th><th>اتنفذ</th><th>اتأكد</th><th>فشل</th><th>اترجع</th><th>ممنوع</th><th>مرفوض</th></tr></thead><tbody>${Object.entries(p.byType).map(([k, v]) => `<tr><td>${ACTION_ICON[k]} ${E({ OPEN: 'فتح', PAUSE: 'إيقاف', SCALE_UP: 'توسع', SCALE_DOWN: 'تقليل ميزانية' }[k])}</td><td>${v.executed}</td><td>${v.verified}</td><td>${v.failed}</td><td>${v.rolledBack}</td><td>${v.blocked}</td><td>${v.rejected}</td></tr>`).join('')}</tbody></table></div>
      <div class="op-banner blue">ℹ️ ${E(p.outcomes.note)}${p.outcomes.summary ? ` — ${Object.entries(p.outcomes.summary).map(([k, v]) => `${E(k)}: ${v}`).join(' · ')}` : ''}</div></div>
    <div class="amb-panel"><h3>🔎 إيه اللي حصل بعد الأكشن؟</h3>${p.executed.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>الحملة</th><th>الأكشن</th><th>قبل</th><th>بعد</th><th>الحكم</th></tr></thead><tbody>${p.executed.map((o) => `<tr><td>${E(o.campaignName || o.campaignId)}</td><td>${E(o.actionLabel)}${o.action_ ? `<div class="op-camp">${E(o.action_)}</div>` : ''}</td><td>CPA ${o.before.cpa == null ? '—' : num(o.before.cpa)}</td><td>${o.after ? `CPA ${num(o.after.cpa)} (${o.after.changePct > 0 ? '+' : ''}${o.after.changePct}%)` : '<span class="op-unk">لسه</span>'}</td><td><span class="op-pill ${{ IMPROVED: 'green', HARMFUL: 'red', WORSENED: 'red', CONFOUNDED: 'gray' }[o.verdict] || 'gray'}">${E(o.verdict)}</span>${o.note ? `<div class="op-camp">${E(o.note)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="amb-empty">مفيش أكشنز اتنفذت لسه.</div>'}</div>
    <div class="amb-panel"><h3>👻 تقرير Shadow — آخر ${sh.days} أيام</h3>
      <div class="amb-kpis op-kpis">${kpi('قرارات متقيّمة', sh.totalEvaluated, 'blue')}${kpi('كان هيقفل', sh.suggested.PAUSE, 'amber')}${kpi('كان هيفتح', sh.suggested.OPEN, 'green')}${kpi('كان هيوسّع', sh.suggested.SCALE_UP, 'purple')}${kpi('اتمنعت', sh.blockedCorrectly, 'red')}</div>
      <div class="op-sub">بأثر رجعي: قرارات اتحسبت ${num(h.evaluated)} · خسارة كان هيتجنبها الإيقاف ${num(h.wasteAvoided)} قرار (${egp(h.wasteAvoidedAmount)}) · حملات جابت أوردرات بعد قرار الإيقاف ${num(h.laterPurchases)} · انت عملت نفس الأكشن ${num(h.userDidSame)} · لسه ${num(h.stillPending)}</div><div class="op-banner blue">ℹ️ ${E(sh.note)}</div></div>`;
}

// =====================================================================================================================
// control center (spec 60/92/100/101/102/117 + Command Center)
// =====================================================================================================================
export async function drawControl(body) {
  body.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  const [g, hl, br] = await Promise.all([api.get('/api/operator/global-readiness'), api.get('/api/operator/health'), api.get('/api/operator/brief')]);
  body.innerHTML = `
    <div id="opCompletion"></div>
    <div class="amb-panel"><h3>🧭 جاهزية الأتمتة (إيه اللازم تظبطه قبل Autopilot)</h3>
      <div class="amb-kpis op-kpis">${kpi('🟢 منتجات جاهزة', g.products.ready, 'green')}${kpi('🟡 جزئية', g.products.partial, 'amber')}${kpi('🔴 متوقفة', g.products.blocked, 'red')}${kpi('حملات مربوطة', g.campaigns.mapped, 'blue')}${kpi('حملات غير مربوطة', g.campaigns.unmapped, 'gray', g.campaigns.suggested ? `+${g.campaigns.suggested} مقترح` : '')}${kpi('منتجات بدون اقتصاديات', g.missingEconomics, 'red')}${kpi('منتجات بدون مخزون', g.missingStock, 'red')}${kpi('متوقفة بجودة البيانات', g.blockedByDataQuality, 'amber', g.dataQualityChecked ? '' : 'لسه ما اتفحصتش')}</div>
      <button class="amb-btn" data-goto="readiness">فتح جاهزية المنتجات</button> <button class="amb-btn" data-goto="mapping">فتح ربط الحملات</button></div>
    <div class="amb-panel"><h3>🔮 لو شغلت الأوتوميشن دلوقتي؟</h3><div class="op-sub">محاكاة Shadow على بيانات حقيقية — بتقرا بس ومبتكتبش أي حاجة ومبتنفذش على Meta.</div><button class="amb-btn orange" id="opWhat">🔮 شغّل المحاكاة</button><div id="opWhatOut"></div></div>
    <div class="amb-panel"><h3>🩺 صحة AI Operator</h3><div class="op-health">
      <div><small>آخر تقييم</small><b>${E(ago(hl.lastEvaluation))}</b></div><div><small>آخر قراءة Meta</small><b class="${hl.metaFresh ? 'op-ok' : 'op-bad'}">${E(ago(hl.lastMetaRead))}</b></div><div><small>آخر كتابة على Meta</small><b>${E(hl.lastMetaWrite ? ago(hl.lastMetaWrite) : 'لا يوجد')}</b></div>
      <div><small>الجدولة</small><b>${hl.scheduler?.started ? (hl.scheduler.running ? 'شغالة الآن' : 'مفعّلة') : 'متوقفة'}${hl.scheduler?.consecutiveFailures ? ` · فشل متتالي ${hl.scheduler.consecutiveFailures}` : ''}</b></div><div><small>في الانتظار</small><b>${num(hl.queueDepth)}</b></div><div><small>فشل (24س)</small><b class="${hl.failedLast24h ? 'op-bad' : ''}">${num(hl.failedLast24h)}</b></div><div><small>ممنوع</small><b>${num(hl.blocked)}</b></div><div><small>إيقاف الطوارئ</small><b class="${hl.emergencyStop ? 'op-bad' : 'op-ok'}">${hl.emergencyStop ? 'مفعّل' : 'مقفول'}</b></div></div></div>
    <div class="amb-panel"><h3>📰 الملخص اليومي</h3>
      <div class="op-brief"><div><h4>عمل إيه AI Operator؟</h4>${br.did.length ? `<ul class="op-ul">${br.did.slice(0, 6).map((x) => `<li>${E(x.actionLabel)} — ${E(x.campaign || '')} ${x.verified ? '✓' : '(مش متأكد)'}</li>`).join('')}</ul>` : '<div class="op-unk">مفيش تنفيذ آخر 24 ساعة</div>'}</div>
        <div><h4>عايز موافقة على</h4>${br.needsApproval.length ? `<ul class="op-ul">${br.needsApproval.slice(0, 6).map((x) => `<li>${E(x.actionLabel)} — ${E(x.campaign || '')}</li>`).join('')}</ul>` : '<div class="op-unk">مفيش</div>'}</div>
        <div><h4>اتمنع (${num(br.blocked.total)})</h4>${br.blocked.top.length ? `<ul class="op-ul">${br.blocked.top.map((x) => `<li>${E(x.code)}: ${x.count}</li>`).join('')}</ul>` : '<div class="op-unk">—</div>'}</div>
        <div><h4>محتاج تجهيز منك</h4><ul class="op-ul"><li>منتجات متوقفة: ${num(br.needsSetup.productsBlocked)}</li><li>بدون اقتصاديات: ${num(br.needsSetup.missingEconomics)}</li><li>بدون مخزون: ${num(br.needsSetup.missingStock)}</li><li>حملات غير مربوطة: ${num(br.needsSetup.unmappedCampaigns)}</li></ul></div>
        <div><h4>اتحسّن / ساء</h4><div>${br.improved.length ? br.improved.map((x) => `<div class="op-ok">↗ ${E(x.campaign)}</div>`).join('') : '<span class="op-unk">—</span>'}${br.worsened.map((x) => `<div class="op-bad">↘ ${E(x.campaign)}</div>`).join('')}</div></div>
        <div><h4>أكبر خطر / فرصة</h4><div>${br.topRisk ? `<div class="op-bad">⚠️ ${E(br.topRisk.text)}</div>` : '<span class="op-unk">لا خطر مرصود</span>'}${br.topOpportunity ? `<div class="op-ok">📈 ${E(br.topOpportunity.campaign || '')}</div>` : ''}</div></div></div></div>
    <div id="opSafety"></div><div id="opCmdBox"></div>`;
  body.querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => S.hooks.switchTab(b.dataset.goto); });
  drawCompletion($('opCompletion')); // end-to-end Completion Center (replaces the old step wizard; same data sources, clickable)
  $('opWhat').onclick = whatWillHappen;
  drawSafety($('opSafety'));
  drawCommand($('opCmdBox'));
}

async function whatWillHappen() {
  const out = $('opWhatOut'); const btn = $('opWhat'); btn.disabled = true; out.innerHTML = '<div class="amb-loading">🔮 بيحاكي على الـ264 حملة… (حتى 40 ثانية)</div>';
  try {
    const r = await api.post('/api/operator/what-will-happen', {}); const s = r.summary;
    out.innerHTML = `<div class="amb-kpis op-kpis">${kpi('اتقيّم', s.objectsEvaluated, 'blue', `${s.rulesEvaluated} قاعدة`)}${kpi('هيفتح', s.wouldOpen, 'green')}${kpi('هيقفل', s.wouldPause, 'amber')}${kpi('هيوسّع', s.wouldScale, 'purple')}${kpi('هيقلل ميزانية', s.wouldReduce, 'amber')}${kpi('ممنوع', s.blocked, 'red')}${kpi('مستبعد', s.excluded, 'gray')}${kpi('محمي', s.protected, 'gray')}${kpi('بيانات ناقصة', s.unknown, 'red')}</div>
      <div class="op-sub">🔒 محاكاة فقط — wrote: ${r.wrote ? 'نعم' : 'لا'} · ${num(r.ms)}ms${s.rulesEvaluated ? '' : ' · مفيش قواعد مفعّلة، فعّل قاعدة الأول.'}</div>
      ${r.candidates.length ? `<div class="table-wrap"><table class="data op-table2"><thead><tr><th>الحملة</th><th>المنتج</th><th>الأكشن</th><th>النتيجة</th><th>السبب / المطلوب</th></tr></thead><tbody>${r.candidates.slice(0, 60).map((c) => `<tr><td><div class="op-prod">${E(c.campaign.name)}</div></td><td>${E(c.productName || '—')}</td><td>${ACTION_ICON[c.action] || ''} ${E(c.actionLabel)}</td><td><span class="op-pill ${c.wouldBe === 'BLOCKED' ? 'red' : 'blue'}">${E(c.wouldBe === 'BLOCKED' ? 'ممنوع' : 'هيتنفذ')}</span></td><td class="op-why">${c.wouldBe === 'BLOCKED' ? blockPanel({ actionLabel: c.actionLabel, unblock: c.canonical.unblock }, { compact: true }) : E(c.canonical.recommendedAction)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="amb-empty">مفيش مرشّحين.</div>'}`;
    wireSetupButtons(out);
  } catch (e) { out.innerHTML = `<div class="op-bad">${E(e.message)}</div>`; } finally { btn.disabled = false; }
}

// ---- safety & limits (spec 102/74/75) ----------------------------------------------------------------------------------------------------------
function drawSafety(root) {
  const c = S.cfg.config, L = c.limits, a = S.cfg.allowlist, sch = c.schedule, gate = S.cfg.gate; const dis = S.isAdmin ? '' : 'disabled';
  const lim = (label, k, v) => `<label>${E(label)}<input data-lim="${k}" type="number" min="0" step="any" value="${v ?? ''}" ${dis} /></label>`;
  const acc = L.account || {};
  root.innerHTML = `
    <div class="amb-panel"><h3>🔒 الأمان والحدود</h3>
      <div class="op-sub">✅ الأكشنز المسموحة لـ Autopilot (بتتغير من «الإعدادات» ← أوتوبايلوت). كلها مقفولة افتراضيًا، وأي أكشن مقفول بيفضل بموافقتك.</div><div class="op-allow">${Object.entries(a).map(([k, v]) => `<span class="op-pill ${v ? 'green' : 'gray'}">${ACTION_ICON[k]} ${E(S.cfg.meta.actionLabels[k])}: ${v ? 'مسموح' : 'مقفول'}</span>`).join(' ')}</div>
      <h4>حدود الأكشن</h4><div class="op-form">${lim('أقصى تقليل ميزانية للأكشن %', 'maxDecreasePct', L.maxDecreasePct)}${lim('أقصى تغييرات للحملة/يوم', 'maxChangesPerCampaignPerDay', L.maxChangesPerCampaignPerDay)}${lim('أقصى أكشنز/ساعة', 'maxActionsPerHour', L.maxActionsPerHour)}${lim('أقصى أكشنز/يوم', 'maxActionsPerDay', L.maxActionsPerDay)}${lim('أقل تغطية مخزون للتوسع (يوم)', 'minDaysCover', L.minDaysCover)}</div>
      <h4>حدود الحساب اليومية (بتحمي الحساب كله)</h4><div class="op-form">${lim('أقصى عدد فتح حملات/يوم', 'acc_maxEnablesPerDay', acc.maxEnablesPerDay)}${lim('أقصى عدد إيقاف/يوم', 'acc_maxPausesPerDay', acc.maxPausesPerDay)}${lim('أقصى زيادة ميزانية إجمالية/يوم (ج.م)', 'acc_maxBudgetIncreasePerDay', acc.maxBudgetIncreasePerDay)}${lim('أقصى ميزانية يومية تحت تحكم AI (ج.م)', 'acc_maxDailySpendUnderAi', acc.maxDailySpendUnderAi)}</div>
      <h4>حدود الخسارة اليومية</h4><div class="op-form">${lim('الحساب (ج.م)', 'loss_account', L.lossLimits?.account)}${lim('المنتج (ج.م)', 'loss_product', L.lossLimits?.product)}${lim('الحملة (ج.م)', 'loss_campaign', L.lossLimits?.campaign)}</div>
      <h4>النضج وعدم التراجع</h4><div class="op-form">${lim('أدنى عمر للحملة قبل الإيقاف (ساعة)', 'minCampaignAgeHours', L.minCampaignAgeHours)}${lim('فترة السماح بعد تعديل (ساعة)', 'attributionGraceHours', L.attributionGraceHours)}${lim('تهدئة بعد تعديلك اليدوي (ساعة)', 'manualOverrideCooldownHours', L.manualOverrideCooldownHours)}</div>
      <h4>فترات التهدئة (ساعات)</h4><div class="op-form">${['OPEN', 'PAUSE', 'SCALE_UP', 'SCALE_DOWN'].map((k) => `<label>${E(S.cfg.meta.actionLabels[k])}<input data-cd="${k}" type="number" min="1" max="168" value="${c.cooldowns[k]}" ${dis} /></label>`).join('')}</div>
      <h4>جدول التشغيل الآلي</h4><div class="op-form"><label>النمط<select id="sch_mode" ${dis}><option value="ALWAYS" ${sch.mode === 'ALWAYS' ? 'selected' : ''}>24/7</option><option value="HOURS" ${sch.mode === 'HOURS' ? 'selected' : ''}>ساعات محددة فقط</option><option value="EXCLUDED_HOURS" ${sch.mode === 'EXCLUDED_HOURS' ? 'selected' : ''}>كل الوقت ما عدا ساعات</option></select></label><label>من<input id="sch_from" type="time" value="${E(sch.ranges?.[0]?.from || '')}" ${dis} /></label><label>إلى<input id="sch_to" type="time" value="${E(sch.ranges?.[0]?.to || '')}" ${dis} /></label></div>
      ${S.isAdmin ? '<button class="amb-btn success" id="opSaveLim">حفظ الحدود</button>' : ''}
      <h4 style="margin-top:16px">🏬 حدود كل متجر (ما بتتسربش بين المتاجر)</h4><div class="op-sub">${Object.keys(c.storeLimits || {}).length ? Object.entries(c.storeLimits).map(([s, o]) => `<b>${E(s)}</b>: ${E(JSON.stringify(o))}`).join(' · ') : 'مفيش حدود خاصة بمتجر — بيتطبق حد الحساب.'}</div>
      ${S.isAdmin ? '<div class="op-form"><label>المتجر (store id)<input id="sl_store" placeholder="trendy-storeee" /></label><label>أقصى زيادة ميزانية/يوم<input id="sl_inc" type="number" min="0" /></label><label>أقصى فتح/يوم<input id="sl_en" type="number" min="0" /></label><label>أقصى إيقاف/يوم<input id="sl_pa" type="number" min="0" /></label></div><button class="amb-btn" id="opSaveStore">حفظ حد المتجر</button>' : ''}</div>
    <div class="amb-panel"><h3>🛂 بوابة تفعيل Autopilot</h3><div class="op-sub">${gate.ok ? '✅ كل الشروط متحققة — لسه التفعيل قرارك.' : `❌ ${gate.checks.filter((x) => !x.ok).length} شرط ناقص.`} ${E(gate.note)}</div>
      <ul class="op-checklist">${gate.checks.map((x) => `<li class="${x.ok ? 'ok' : 'no'}">${x.ok ? '✓' : '✗'} ${E(x.label)} <small>— ${E(x.detail)}</small></li>`).join('')}</ul>${S.isAdmin ? '<button class="amb-btn" id="opGate">فتح بوابة Autopilot</button>' : ''}</div>
    <div class="amb-panel"><h3>ترتيب الحواجز (من الأقوى للأضعف)</h3><ol class="op-ol">${S.cfg.meta.precedence.map((p) => `<li><b>${E(p.label_ar || p.key)}</b></li>`).join('')}</ol><div class="op-sub">أي حاجز من فوق بيتغلب على اللي تحته. <b>حواجز الأمان</b> (إيقاف الطوارئ، الاستثناءات، مخزون صفر، حدود الخسارة) أقوى من <b>قواعد التحسين</b> (فتح/توسع/ميزانية)، والمستشار الذكي في الآخر.</div></div>`;
  if ($('opGate')) $('opGate').onclick = showGate;
  if ($('opSaveLim')) $('opSaveLim').onclick = async () => {
    const n = (k) => { const v = root.querySelector(`[data-lim="${k}"]`).value.trim(); return v === '' ? null : Number(v); };
    const cds = {}; root.querySelectorAll('[data-cd]').forEach((i) => { cds[i.dataset.cd] = Number(i.value); });
    const from = $('sch_from').value, to = $('sch_to').value, sm = $('sch_mode').value;
    try {
      await api.put('/api/operator/limits', { limits: { maxDecreasePct: n('maxDecreasePct'), maxChangesPerCampaignPerDay: n('maxChangesPerCampaignPerDay'), maxActionsPerHour: n('maxActionsPerHour'), maxActionsPerDay: n('maxActionsPerDay'), minDaysCover: n('minDaysCover'), minCampaignAgeHours: n('minCampaignAgeHours'), attributionGraceHours: n('attributionGraceHours'), manualOverrideCooldownHours: n('manualOverrideCooldownHours'),
        lossLimits: { account: n('loss_account'), product: n('loss_product'), campaign: n('loss_campaign') }, account: { maxEnablesPerDay: n('acc_maxEnablesPerDay'), maxPausesPerDay: n('acc_maxPausesPerDay'), maxBudgetIncreasePerDay: n('acc_maxBudgetIncreasePerDay'), maxDailySpendUnderAi: n('acc_maxDailySpendUnderAi') } }, cooldowns: cds, schedule: { mode: sm, ranges: sm !== 'ALWAYS' && from && to ? [{ from, to }] : [] } });
      UI.toast('تم الحفظ'); await refresh(); S.hooks.reloadBody?.();
    } catch (e) { UI.toast(e.message, 'error'); }
  };
  if ($('opSaveStore')) $('opSaveStore').onclick = async () => {
    const sid = $('sl_store').value.trim(); if (!sid) return UI.toast('اكتب store id.');
    const v = (id) => { const x = $(id).value.trim(); return x === '' ? null : Number(x); };
    try { await api.put('/api/operator/limits', { storeLimits: { [sid]: { maxBudgetIncreasePerDay: v('sl_inc'), maxEnablesPerDay: v('sl_en'), maxPausesPerDay: v('sl_pa') } } }); UI.toast('تم'); await refresh(); S.hooks.reloadBody?.(); } catch (e) { UI.toast(e.message, 'error'); }
  };
}

export async function showGate() {
  const r = await api.get('/api/operator/autopilot-gate'); const g = r.gate;
  openDrawer(`${drawerHead('🛂 بوابة تفعيل Autopilot')}<div class="amb-drawer-body op-details">
    <div class="op-banner amber">${E(g.note)}</div>
    <ul class="op-checklist">${g.checks.map((x) => `<li class="${x.ok ? 'ok' : 'no'}">${x.ok ? '✓' : '✗'} <b>${E(x.label)}</b> <small>— ${E(x.detail)}</small></li>`).join('')}</ul>
    <h4>تأكيداتك الصريحة</h4><div class="op-sub">دي حاجات مينفعش النظام يثبتها لوحده. أكّدها فقط لو اتأكدت منها فعلًا (مثلاً بعد تجربة أول كتابة حقيقية على حملة واحدة منخفضة المخاطر بموافقتك).</div>
    ${Object.entries(r.attestKeys).map(([k, label]) => `<label class="op-check"><input type="checkbox" data-att="${E(k)}" ${g.checks.find((c) => c.key === `attest:${k}`)?.ok ? 'checked disabled' : ''} /> ${E(label)}</label>`).join('')}
    <div style="margin:10px 0"><button class="amb-btn" id="gAtt">سجّل التأكيدات</button> <button class="amb-btn ghost" id="gRev">سحب كل التأكيدات</button></div>
    <button class="amb-btn danger" id="gGo" ${g.ok ? '' : 'disabled'}>فعّل Autopilot</button>
    <div class="op-sub">فترة Shadow قبل التفعيل: ${num(g.shadowDays)} يوم. مفيش تفعيل تلقائي بعد أي مدة.</div></div>`);
  $('gAtt').onclick = async () => { const keys = [...document.querySelectorAll('[data-att]:checked:not(:disabled)')].map((x) => x.dataset.att); if (!keys.length) return UI.toast('اختار تأكيد.'); try { await api.post('/api/operator/autopilot-gate/attest', { keys }); UI.toast('اتسجّل'); await refresh(); showGate(); } catch (e) { UI.toast(e.message, 'error'); } };
  $('gRev').onclick = async () => { try { await api.delete('/api/operator/autopilot-gate/attest'); UI.toast('اتسحبت'); await refresh(); showGate(); } catch (e) { UI.toast(e.message, 'error'); } };
  $('gGo').onclick = async () => { if (!(await UI.confirmModal({ title: 'تفعيل Autopilot', message: 'هينفّذ على Meta من غير موافقة فقط للقواعد المعلّمة Autopilot وبحدود الأمان. الأتمتة ممكن توقفها بزرار 🛑 في أي لحظة. متأكد؟', confirmLabel: 'فعّل Autopilot', danger: true }))) return; try { await api.put('/api/operator/mode', { mode: 'AUTOPILOT', confirmAutopilot: true }); UI.toast('Autopilot شغال'); closeDrawer(); await refresh(); S.hooks.reloadBody?.(); } catch (e) { UI.toast(e.message, 'error'); } };
}

// ---- command center ------------------------------------------------------------------------------------------------------------------------------
function drawCommand(root) {
  root.innerHTML = `<div class="amb-panel"><h3>💬 Command Center</h3><div class="op-sub">الأوامر بتتحوّل لـ: استعلام (قراءة) / مسودة قاعدة (للتأكيد) / اقتراح إيقاف طوارئ (للتأكيد). مفيش تنفيذ مباشر على حملة من هنا.</div>
    <div class="op-nl"><input id="opCmd" placeholder='مثال: إيه الحملات اللي هتتوقف؟ — فرص التوسع — لو CPA أعلى من 150 وقف الحملة — إيقاف فوري' /><button class="amb-btn orange" id="opCmdGo">نفّذ</button></div>
    <div class="op-chips">${['إيه الحملات اللي هتتوقف؟', 'فرص التوسع', 'القرارات الممنوعة', 'ملخص النهارده', 'القواعد', 'الاستثناءات'].map((x) => `<button class="amb-fbtn" data-q="${E(x)}">${E(x)}</button>`).join('')}</div><div id="opCmdOut"></div></div>`;
  const go = async (text) => {
    const out = $('opCmdOut'); out.innerHTML = '<div class="amb-loading">…</div>';
    try {
      const r = await api.post('/api/operator/command', { text });
      let h = `<div class="op-preview"><b>${E(r.title || r.kind)}</b><div>${E(r.message || '')}</div>`;
      if (r.kind === 'EMERGENCY') h += '<button class="op-stop" id="opCmdStop">🛑 أكّد الإيقاف الفوري</button>';
      if (r.kind === 'RULE_DRAFT') h += `<div class="op-conds">${condText(r.rule.conditions, S.cfg.meta.fields)}</div>${(r.validation.errors || []).map((e) => `<div class="op-bad">✗ ${E(e.message)}</div>`).join('')}${S.isAdmin ? '<button class="amb-btn" id="opCmdEdit">راجع في منشئ القواعد</button>' : ''}`;
      if (r.decisions?.length) h += `<ul class="op-ul">${r.decisions.slice(0, 15).map((d) => `<li>${ACTION_ICON[d.action] || ''} ${E(d.campaignName || d.campaignId)} — ${E(d.productName || '')} <span class="op-pill ${STATUS_CLS[d.status] || 'gray'}">${E(d.lifecycleLabel || d.statusLabel)}</span></li>`).join('')}</ul>`;
      if (r.overview) h += `<div class="op-sub">حملات: ${num(r.overview.kpis.monitored)} · للفتح ${num(r.overview.kpis.readyToOpen)} · للإيقاف ${num(r.overview.kpis.proposedPause)} · توسع ${num(r.overview.kpis.scaleOpportunities)} · ممنوع ${num(r.overview.kpis.blockedBySafety)}</div>`;
      if (r.rules) h += `<ul class="op-ul">${r.rules.map((x) => `<li>${E(x.name)} — ${E(x.mode)} ${x.enabled ? '✓' : '(متوقفة)'}</li>`).join('')}</ul>`;
      if (r.exceptions) h += `<ul class="op-ul">${r.exceptions.map((x) => `<li>${E(x.scope_type)} ${E(x.scope_label || x.scope_id)} — ${E(x.types.join(', '))}</li>`).join('')}</ul>`;
      out.innerHTML = `${h}</div>`;
      if ($('opCmdStop')) $('opCmdStop').onclick = () => S.hooks.emergencyStop?.();
      if ($('opCmdEdit')) $('opCmdEdit').onclick = () => S.hooks.ruleForm?.({ ...r.rule, name: r.rule.name || text.slice(0, 60), nl_text: text });
    } catch (e) { out.innerHTML = `<div class="op-bad">${E(e.message)}</div>`; }
  };
  $('opCmdGo').onclick = () => go($('opCmd').value);
  $('opCmd').onkeydown = (e) => { if (e.key === 'Enter') go($('opCmd').value); };
  root.querySelectorAll('[data-q]').forEach((b) => { b.onclick = () => { $('opCmd').value = b.dataset.q; go(b.dataset.q); }; });
}
