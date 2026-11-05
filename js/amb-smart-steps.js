// Smart Campaign — the content steps of the journey (1 المعلومات · 2 البحث · 3 صور الصفحة · 4 صفحة المنتج · 6 الكابشن), drawn like the reference product UI.
// Every step is a function (el, C): `C` is the journey context built in amb-smart-campaign.js (project, journey, reload, rerender, runJob, say…).
import { api } from './api-client.js';

export const B = '/api/amb-media/pages';
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const lines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
export const assetUrl = (p, id, v = 0) => `${B}/${p.id}/assets/${id}?v=${v}`;
const nf = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const msgHtml = (C, k) => (C.msg[k] ? `<div class="sx-msg ${C.msg[k].bad ? 'bad' : ''}">${esc(C.msg[k].text)}</div>` : '');
const sechead = (title, sub) => `<div class="sx-sec"><h2>${esc(title)}</h2><p>${esc(sub)}</p></div>`;
const on = (el, sel, fn) => el.querySelectorAll(sel).forEach((n) => { n.onclick = (ev) => fn(n, ev); });
const val = (el, sel) => el.querySelector(sel)?.value ?? '';

// ------------------------------------------------------------------------------------------------ 1 · المعلومات
export function stepInfo(el, C) {
  const p = C.p; const e = p.eo;
  const stock = e ? (e.trackStock ? (e.quantity > 0 ? `متاح ${e.quantity}` : '⛔ المخزون خلص') : 'المخزون مش متتبّع') : '';
  el.innerHTML = `${sechead('المعلومات', 'صورة المنتج ومعلوماته الحقيقية — دي اللي كل الخطوات اللي بعدها بتبدأ منها.')}
    <div class="sx-card"><div class="sx-cbody">
      <div class="sx-row" style="grid-template-columns: minmax(220px, 280px) 1fr; align-items: start;">
        <div class="sx-f"><span>صورة المنتج</span>
          <label class="sx-drop" data-i-drop>${p.reference ? `<img src="${assetUrl(p, 'ref', p.reference.at ? Date.parse(p.reference.at) : 0)}" alt="صورة المنتج">` : '<b>اضغط أو اسحب الصورة هنا</b><small>JPG أو PNG — خلفية بيضا أو صورة واضحة أحسن</small>'}<input type="file" accept="image/jpeg,image/png,image/webp" data-i-file hidden></label>
          ${p.reference ? '<small>اضغط على الصورة لو عايز تغيّرها.</small>' : ''}${msgHtml(C, 'ref')}</div>
        <div style="display:grid; gap:14px;">
          <label class="sx-f"><span>اسم المنتج</span><input data-i="name" value="${esc(p.name)}"></label>
          <div class="sx-row"><label class="sx-f"><span>سعر البيع (ج)</span><input data-i="price" inputmode="decimal" value="${esc(p.price ?? '')}"></label><label class="sx-f"><span>السعر قبل الخصم (ج)</span><input data-i="oldPrice" inputmode="decimal" value="${esc(p.oldPrice ?? '')}"></label></div>
          <label class="sx-f"><span>معلومات عن المنتج (اختياري بس بيفرق جدًا)</span><textarea data-i="facts" rows="6" placeholder="بيعمل إيه؟ مميزاته؟ الخامة؟ المقاسات؟ اللي في العلبة؟ — اكتب اللي تعرفه، سطر لكل معلومة">${esc((p.facts || []).join('\n'))}</textarea><small>الذكاء الاصطناعي بيعتبر الكلام ده المرجع الأول للبحث والصور والكابشن — ومش بيكتب غيره.</small></label>
          <label class="sx-f"><span>لينك المورد أو منتج مشابه (اختياري)</span><input data-i="supplierUrl" dir="ltr" value="${esc(p.supplierUrl || '')}" placeholder="https://www.aliexpress.com/item/…"><small>علي إكسبرس، أمازون، أو أي صفحة فيها مواصفات المنتج.</small></label>
        </div>
      </div>
      ${e ? `<div class="sx-rbox" style="gap:10px;"><b>🔗 مربوط بمنتج إيزي أوردر: ${esc(e.name)}</b>
        <div class="sx-chips"><span class="sx-badge">📦 ${esc(stock)}</span>${e.freeShipping ? '<span class="sx-badge">🚚 شحن مجاني</span>' : ''}${(e.categories || []).map((c) => `<span class="sx-badge">🏷️ ${esc(c)}</span>`).join('')}</div>
        ${(e.images || []).length ? `<small>صور المنتج في إيزي أوردر — اضغط على صورة تخليها صورة المنتج هنا:</small><div class="sx-chiprow">${e.images.map((u, i) => `<button type="button" class="sx-btn ghost" style="padding:0;height:auto;" data-i-eoimg="${i}" title="استخدمها كصورة المنتج"><img src="${esc(u)}" alt="" referrerpolicy="no-referrer" style="width:64px;height:64px;object-fit:cover;border-radius:10px;border:1px solid var(--sx-border2);"></button>`).join('')}</div>` : ''}
        <div class="sx-chiprow"><button class="sx-btn sm" data-i-sync="info" ${C.busy.eosync ? 'disabled' : ''}>🔄 حدّث المخزون والتصنيف والصور</button><button class="sx-btn sm" data-i-sync="all" ${C.busy.eosync ? 'disabled' : ''}>🔄 حدّث الاسم والسعر والمعلومات كمان</button></div>${msgHtml(C, 'eosync')}</div>` : ''}
      ${msgHtml(C, 'info')}
      <div class="sx-foot" style="border:0;padding:0;"><button class="sx-btn" data-i-save>💾 حفظ</button><button class="sx-btn primary" data-i-next>ابدأ البحث عن المنتج ←</button></div>
    </div></div>`;
  const save = async () => { C.say('info', null); try { await api.put(`${B}/${p.id}`, { name: val(el, '[data-i="name"]'), price: val(el, '[data-i="price"]'), oldPrice: val(el, '[data-i="oldPrice"]'), facts: lines(val(el, '[data-i="facts"]')), supplierUrl: val(el, '[data-i="supplierUrl"]') }); await C.reload(); C.say('info', '✅ اتحفظت البيانات.'); return true; } catch (er) { C.say('info', er.message, true); return false; } };
  on(el, '[data-i-save]', async () => { await save(); C.rerender(); });
  on(el, '[data-i-next]', async () => { if (await save()) C.go(2); else C.rerender(); });
  const file = el.querySelector('[data-i-file]'); if (file) file.onchange = async () => {
    const f = file.files?.[0]; if (!f) return;
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { C.say('ref', 'لازم JPG أو PNG أو WebP.', true); return C.rerender(); }
    if (f.size > 8 * 1024 * 1024) { C.say('ref', 'الصورة أكبر من 8MB.', true); return C.rerender(); }
    try { const r = await fetch(`${B}/${p.id}/reference`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': f.type }, body: f }); const j = await r.json().catch(() => null); if (!r.ok) throw new Error(j?.message || `فشل الرفع (${r.status})`); await C.reload(); C.say('ref', '✅ اتحفظت صورة المنتج.'); } catch (er) { C.say('ref', er.message, true); }
    C.rerender();
  };
  on(el, '[data-i-eoimg]', async (n) => { try { await api.post(`${B}/${p.id}/reference-from-eo`, { index: Number(n.dataset.iEoimg) }); await C.reload(); C.say('ref', '✅ اتغيّرت صورة المنتج.'); } catch (er) { C.say('ref', er.message, true); } C.rerender(); });
  on(el, '[data-i-sync]', async (n) => {
    const all = n.dataset.iSync === 'all';
    if (all && !confirm('ده هيستبدل الاسم والسعر والمعلومات اللي كتبتها بالبيانات الحالية من إيزي أوردر. تكمّل؟')) return;
    C.busy.eosync = true; C.say('eosync', null); C.rerender();
    try { await api.post(`${B}/${p.id}/eo-sync`, { overwrite: all }); await C.reload(); C.say('eosync', all ? '✅ اتحدّثت كل البيانات.' : '✅ اتحدّث المخزون والتصنيف والصور.'); } catch (er) { C.say('eosync', er.message, true); }
    C.busy.eosync = false; C.rerender();
  });
}

// ------------------------------------------------------------------------------------------------ 2 · البحث
export function stepResearch(el, C) {
  const r = C.j.research; const chips = (a, cls = '') => (a || []).map((x) => `<span class="sx-badge ${cls}">${esc(x)}</span>`).join('');
  el.innerHTML = `${sechead('البحث', 'السيستم بيحلّل المنتج من معلوماته الحقيقية وصورته: الجمهور، والفوايد، والمشاكل، وزوايا الإعلان، وإيه اللي تتجنبه.')}
    <div class="sx-card"><div class="sx-chead"><b>${r ? 'نتيجة البحث' : 'لسه ما اتعملش بحث'}</b><button class="sx-btn primary" data-r-go ${C.busy.research ? 'disabled' : ''}>${r ? '🔄 إعادة البحث' : '🔎 ابدأ البحث'}</button></div>
      <div class="sx-cbody">${msgHtml(C, 'research')}${!r && !(C.p.facts || []).length ? '<div class="sx-msg warn">اكتب معلومات المنتج في خطوة «المعلومات» الأول — البحث بيعتمد عليها.</div>' : ''}
      ${r ? `<p style="margin:0;font-weight:700;">${esc(r.summary)}</p><div class="sx-rgrid">
        <div class="sx-rbox"><b>🎯 الجمهور</b><span>${esc(r.audience.description)}</span><div class="sx-chips"><span class="sx-badge pri">${{ ALL: 'الكل', MALE: 'رجالة', FEMALE: 'ستات' }[r.audience.gender] || 'الكل'}</span><span class="sx-badge pri">${r.audience.ageMin}–${r.audience.ageMax} سنة</span>${chips(r.audience.interests)}</div></div>
        <div class="sx-rbox"><b>💡 الفوايد</b><ul>${(r.benefits || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div class="sx-rbox"><b>😣 المشاكل اللي بيحلها</b><ul>${(r.painPoints || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div class="sx-rbox"><b>🤔 اعتراضات محتملة</b><ul>${(r.objections || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div class="sx-rbox wide"><b>🧲 زوايا الإعلان</b>${(r.angles || []).map((a) => `<div class="sx-angle"><em>${esc(a.name)}</em><span>${esc(a.hook)}</span></div>`).join('')}</div>
        <div class="sx-rbox wide caution"><b>⚠️ تجنب في الإعلان (سياسة ميتا)</b><ul>${(r.policyCautions || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>` : '<div class="sx-empty"><div class="ic">🔎</div><p>اضغط «ابدأ البحث»</p><small>بياخد حوالي دقيقة، وبتقدر تقفل الصفحة.</small></div>'}
      ${C.bar('research')}</div></div>`;
  on(el, '[data-r-go]', () => C.runJob('research', () => api.post(`${B}/${C.p.id}/research`, {}), 'بحلّل المنتج والجمهور…'));
}

// ------------------------------------------------------------------------------------------------ 3 · صور الصفحة
const ROLE = { hero_hook: 'الرئيسية', problem: 'المشكلة', problem_solution: 'المشكلة والحل', demonstration: 'الاستخدام', final_cta: 'اطلب دلوقتي', features_hero: 'المميزات', feature_grid: 'المميزات', parts_breakdown: 'التفاصيل', before_after: 'قبل وبعد', lifestyle_home: 'في البيت', how_to_steps: 'طريقة الاستخدام', offer_cta: 'العرض' };
export function stepImages(el, C) {
  const p = C.p; const imgs = p.images || []; const ready = imgs.filter((i) => i.status === 'READY').length;
  const n = (p.smart?.imageCount) || Math.min(5, Math.max(1, (C.pack || []).length)) || 4;
  const pack = C.pack || [];
  const busyImgs = imgs.some((i) => ['QUEUED', 'GENERATING'].includes(i.status));
  el.innerHTML = `${sechead('صور الصفحة', 'الصور اللي بتتحط تحت بعض في وصف المنتج، وكمان بتتستخدم في الإعلان.')}
    <div class="sx-card"><div class="sx-chead"><div><b>${imgs.length ? `${ready} من ${imgs.length} جاهزة` : 'لسه مفيش صور'}</b></div><button class="sx-btn primary" data-g-go ${C.busy.imgs || busyImgs ? 'disabled' : ''}>🖼️ ${imgs.length ? 'ولّد صور تانية' : 'ولّد الصور'}</button></div>
      <div class="sx-cbody">
        <div class="sx-chiprow"><label class="sx-f" style="grid-auto-flow:column;align-items:center;gap:8px;"><span>عدد صور الصفحة</span><select data-g-count style="width:86px;">${[1, 2, 3, 4, 5].map((k) => `<option value="${k}" ${k === n ? 'selected' : ''}>${k}</option>`).join('')}</select></label></div>
        <div class="sx-chiprow">${(C.styles || []).map((s) => `<button type="button" class="sx-chipbtn ${p.style === s.id ? 'on' : ''}" data-g-style="${esc(s.id)}" title="${esc(s.hint || '')}">${esc(s.label)}</button>`).join('')}</div>
        <small style="color:var(--sx-muted)">كل الصور بنظام تصميم واحد وبالمنتج زي ما هو. ${p.reference ? '' : '⚠️ مفيش صورة للمنتج — ارفعها في خطوة «المعلومات».'}</small>
        ${msgHtml(C, 'imgs')}${C.bar('imgs')}
        ${imgs.length ? `<div class="sx-igrid">${imgs.map((i, k) => `<div class="sx-icard" data-g-card="${esc(i.id)}"><div class="im">${i.status === 'READY' ? `<img src="${assetUrl(p, i.id, i.version)}" alt="" loading="lazy">` : i.status === 'FAILED' ? `<div style="padding:14px;text-align:center;color:var(--sx-bad);font-size:12.5px;">⚠️ ${esc(i.error || 'فشل التوليد')}</div>` : '<div class="sx-spin"></div>'}<span class="role">${esc(ROLE[i.template] || i.template)} · ${k + 1}</span></div>
          <div class="cap">${esc(i.headline || ROLE[i.template] || '')}</div>
          <div class="acts"><button class="sx-btn sm" data-g-regen="${esc(i.id)}" ${['QUEUED', 'GENERATING'].includes(i.status) ? 'disabled' : ''}>ولّد تاني</button><button class="sx-btn sm danger" data-g-del="${esc(i.id)}">حذف</button><button class="sx-btn sm" data-g-edit="${esc(i.id)}">كلام الصورة</button>${i.status === 'READY' ? `<a class="sx-btn sm" href="${assetUrl(p, i.id, i.version)}" download="page-${k + 1}.png">تحميل</a>` : ''}</div>
          ${C.edit === i.id ? `<div style="padding:0 12px 12px;display:grid;gap:8px;"><label class="sx-f"><span>العنوان</span><input data-g-h value="${esc(i.headline || '')}"></label><label class="sx-f"><span>الجملة تحت العنوان</span><input data-g-s value="${esc(i.subtitle || '')}"></label><div class="sx-chiprow"><button class="sx-btn sm primary" data-g-save="${esc(i.id)}">احفظ وولّد تاني</button><button class="sx-btn sm" data-g-cancel>إلغاء</button></div></div>` : ''}</div>`).join('')}</div>` : '<div class="sx-empty"><div class="ic">🖼️</div><p>لسه مفيش صور</p><small>اضغط «ولّد الصور» — بتتولّد على دفعات وبتظهر واحدة واحدة.</small></div>'}
      </div></div>`;
  on(el, '[data-g-style]', async (b) => { try { await api.put(`${B}/${p.id}`, { style: b.dataset.gStyle }); await C.reload(); } catch (e) { C.say('imgs', e.message, true); } C.rerender(); });
  const cnt = el.querySelector('[data-g-count]'); if (cnt) cnt.onchange = async () => { try { await api.put(`${B}/${p.id}`, { smart: { imageCount: Number(cnt.value) } }); await C.reload(); } catch { /* the next generate still uses the select value */ } };
  on(el, '[data-g-go]', async () => {
    const count = Number(el.querySelector('[data-g-count]')?.value || n);
    const items = pack.slice(0, count).map((x) => ({ template: x.template }));
    if (!items.length) { C.say('imgs', 'قوالب الصور مش متحمّلة — حدّث الصفحة.', true); return C.rerender(); }
    await C.runJob('imgs', () => api.post(`${B}/${p.id}/images`, { items, quality: 'high' }), 'بولّد الصور…', { watch: true });
  });
  on(el, '[data-g-regen]', (b) => C.runJob('imgs', () => api.post(`${B}/${p.id}/images/${b.dataset.gRegen}/regenerate`, {}), 'بولّد الصورة من جديد…', { watch: true }));
  on(el, '[data-g-del]', async (b) => { if (!confirm('تمسح الصورة دي؟')) return; try { await api.delete(`${B}/${p.id}/images/${b.dataset.gDel}`); await C.reload(); } catch (e) { C.say('imgs', e.message, true); } C.rerender(); });
  on(el, '[data-g-edit]', (b) => { C.edit = b.dataset.gEdit; C.rerender(); });
  on(el, '[data-g-cancel]', () => { C.edit = null; C.rerender(); });
  on(el, '[data-g-save]', (b) => { const card = el.querySelector(`[data-g-card="${b.dataset.gSave}"]`); const patch = { headline: val(card, '[data-g-h]'), subtitle: val(card, '[data-g-s]') }; C.edit = null; return C.runJob('imgs', () => api.post(`${B}/${p.id}/images/${b.dataset.gSave}/regenerate`, patch), 'بولّد الصورة بالكلام الجديد…', { watch: true }); });
  if (busyImgs) C.watch();
}

// ------------------------------------------------------------------------------------------------ 4 · صفحة المنتج
export function stepPage(el, C) {
  const p = C.p; const c = p.copy; const ps = p.smart?.pageSettings || {};
  const disc = p.oldPrice && p.price && p.oldPrice > p.price ? Math.round((1 - p.price / p.oldPrice) * 100) : 0;
  const ready = (p.images || []).filter((i) => i.status === 'READY');
  const margin = p.price && p.unitCost ? Math.round(((p.price - p.unitCost) / p.price) * 100) : null;
  el.innerHTML = `${sechead('صفحة المنتج', 'السعر والكلام اللي فوق وتحت الصور، وترتيب الصور، وإعدادات الصفحة — مع شكلها النهائي.')}
    <div class="sx-cols">
      <div style="display:grid;gap:16px;">
        <div class="sx-card"><div class="sx-chead"><b>السعر</b></div><div class="sx-cbody">
          <div class="sx-row"><label class="sx-f"><span>قبل الخصم</span><input data-p="oldPrice" inputmode="decimal" value="${esc(p.oldPrice ?? '')}"></label><label class="sx-f"><span>سعر البيع</span><input data-p="price" inputmode="decimal" value="${esc(p.price ?? '')}"></label></div>
          <label class="sx-f"><span>تكلفة القطعة عليك</span><input data-p="unitCost" inputmode="decimal" value="${esc(p.unitCost ?? '')}"></label>
          <div class="sx-chiprow">${disc ? `<span class="sx-badge ok">خصم ${disc}%</span>` : ''}${margin !== null ? `<span class="sx-badge ${margin > 0 ? 'ok' : 'bad'}">هامش ${margin}%</span>` : ''}</div>
          <div><button class="sx-btn sm" data-p-saveprice>حفظ</button></div>${msgHtml(C, 'price')}</div></div>
        <div class="sx-card"><div class="sx-chead"><div><b>شكل الصفحة</b><br><small>زي ما هتظهر للعميل على الموبايل.</small></div></div><div class="sx-cbody"><div class="sx-phone">
          ${p.reference ? `<img src="${assetUrl(p, 'ref', p.reference.at ? Date.parse(p.reference.at) : 0)}" alt="">` : ''}<div class="hd"><b>${esc(p.name)}</b><span class="pr">${esc(p.price ?? '')} ج.م${p.oldPrice ? `<s>${esc(p.oldPrice)} ج.م</s>` : ''}</span></div>
          ${ready.map((i, k) => `<div class="sx-pimg"><img src="${assetUrl(p, i.id, i.version)}" alt="" loading="lazy"><div class="tools"><button data-p-up="${k}" ${k === 0 ? 'disabled' : ''} title="فوق">↑</button><button data-p-down="${k}" ${k === ready.length - 1 ? 'disabled' : ''} title="تحت">↓</button><button data-p-rm="${esc(i.id)}" title="شيل">🗑</button></div></div>`).join('') || '<div style="padding:20px;text-align:center;color:#8a94a6;font-size:12.5px;">الصور هتظهر هنا بالترتيب.</div>'}</div></div></div>
      </div>
      <div style="display:grid;gap:16px;">
        <div class="sx-card"><div class="sx-chead"><b>كلام الصفحة</b>${c ? `<button class="sx-btn sm" data-p-editcopy>${C.editCopy ? 'إغلاق' : '✏️ تعديل كلام الصفحة'}</button>` : ''}</div><div class="sx-cbody">
          ${msgHtml(C, 'copy')}
          ${c && !C.editCopy ? `<div class="sx-f"><span>اسم المنتج على الصفحة</span><b>${esc(c.title || p.name)}</b></div>${c.subtitle ? `<div class="sx-f"><span>كلام فوق الصور</span><div class="sx-text">${esc(c.subtitle)}</div></div>` : ''}
            <div class="sx-f"><span>كلام تحت الصور</span><div class="sx-text">${(c.paragraphs || []).map((t) => `<p style="margin:0 0 6px;">${esc(t)}</p>`).join('')}${(c.features || []).length ? `<ul>${c.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</div></div>
            ${(c.claimIssues || []).length ? `<div class="sx-msg warn">⚠️ ادعاءات محتاجة مراجعة: ${esc(c.claimIssues.map((i) => i.reason).join(' · '))}</div>` : ''}` : ''}
          ${c && C.editCopy ? `<label class="sx-f"><span>العنوان</span><input data-c="title" value="${esc(c.title || '')}"></label><label class="sx-f"><span>جملة تحت العنوان</span><input data-c="subtitle" value="${esc(c.subtitle || '')}"></label><label class="sx-f"><span>الوصف (فقرة لكل سطر)</span><textarea data-c="paragraphs" rows="5">${esc((c.paragraphs || []).join('\n'))}</textarea></label><label class="sx-f"><span>المميزات (سطر لكل ميزة)</span><textarea data-c="features" rows="6">${esc((c.features || []).join('\n'))}</textarea></label><div><button class="sx-btn primary sm" data-p-savecopy>حفظ</button></div>` : ''}
          ${!c ? `<div class="sx-empty"><div class="ic">✍️</div><p>لسه مفيش كلام للصفحة</p><small>بيكتب العنوان والوصف والمميزات (وكابشنات الإعلان) من المعلومات الحقيقية.</small><button class="sx-btn primary" data-p-gen ${C.busy.copy ? 'disabled' : ''}>✍️ اكتب المحتوى بالـ AI</button></div>${C.bar('copy')}` : ''}
        </div></div>
        <div class="sx-card"><div class="sx-chead"><div><b>إعدادات صفحة المنتج</b><br><small>بتتحفظ هنا، وبتتطبّق على المتجر لما تحدّثه من خطوة «النشر على المتجر» (بتأكيدك).</small></div></div><div class="sx-cbody">
          ${[['buyFromPage', 'الشراء من نفس الصفحة', 'فورم الطلب جوه صفحة المنتج، من غير ما العميل يروح لصفحة شراء.'], ['skipCart', 'تخطي السلة', ''], ['fixedBuy', 'زرار شراء ثابت أسفل الصفحة', ''], ['freeShipping', 'شحن مجاني', ''], ['visitors', 'عداد «في ناس بتشوف المنتج دلوقتي»', '']].map(([k, l, d]) => `<label class="sx-toggle"><input type="checkbox" data-ps="${k}" ${ps[k] ? 'checked' : ''}><span><b>${l}</b>${d ? `<small>${d}</small>` : ''}</span></label>`).join('')}
          <label class="sx-f"><span>نص زرار الشراء</span><input data-ps-text value="${esc(ps.buyText || 'اضغط هنا للشراء')}"></label>
          <div><button class="sx-btn sm" data-p-savesettings>حفظ الإعدادات</button></div>${msgHtml(C, 'settings')}</div></div>
      </div>
    </div>`;
  on(el, '[data-p-saveprice]', async () => { try { await api.put(`${B}/${p.id}`, { price: val(el, '[data-p="price"]'), oldPrice: val(el, '[data-p="oldPrice"]'), unitCost: val(el, '[data-p="unitCost"]') }); await C.reload(); C.say('price', '✅ اتحفظ السعر.'); } catch (e) { C.say('price', e.message, true); } C.rerender(); });
  on(el, '[data-p-editcopy]', () => { C.editCopy = !C.editCopy; C.rerender(); });
  on(el, '[data-p-savecopy]', async () => { try { await api.put(`${B}/${p.id}`, { copy: { title: val(el, '[data-c="title"]'), subtitle: val(el, '[data-c="subtitle"]'), paragraphs: lines(val(el, '[data-c="paragraphs"]')), features: lines(val(el, '[data-c="features"]')) } }); await C.reload(); C.editCopy = false; C.say('copy', '✅ اتحفظ كلام الصفحة.'); } catch (e) { C.say('copy', e.message, true); } C.rerender(); });
  on(el, '[data-p-gen]', () => C.runJob('copy', () => api.post(`${B}/${p.id}/copy`, {}), 'بكتب المحتوى والكابشنات…'));
  on(el, '[data-p-savesettings]', async () => { const pageSettings = {}; el.querySelectorAll('[data-ps]').forEach((c) => { pageSettings[c.dataset.ps] = c.checked; }); pageSettings.buyText = val(el, '[data-ps-text]'); try { await api.put(`${B}/${p.id}`, { smart: { pageSettings } }); await C.reload(); C.say('settings', '✅ اتحفظت الإعدادات.'); } catch (e) { C.say('settings', e.message, true); } C.rerender(); });
  const move = async (k, d) => { const ids = ready.map((i) => i.id); const j = k + d; if (j < 0 || j >= ids.length) return; [ids[k], ids[j]] = [ids[j], ids[k]]; const rest = (p.images || []).filter((i) => i.status !== 'READY').map((i) => i.id); try { await api.put(`${B}/${p.id}/images-order`, { order: [...ids, ...rest] }); await C.reload(); } catch (e) { C.toast(e.message, 'error'); } C.rerender(); };
  on(el, '[data-p-up]', (b) => move(Number(b.dataset.pUp), -1)); on(el, '[data-p-down]', (b) => move(Number(b.dataset.pDown), 1));
  on(el, '[data-p-rm]', async (b) => { if (!confirm('تشيل الصورة دي من الصفحة؟')) return; try { await api.delete(`${B}/${p.id}/images/${b.dataset.pRm}`); await C.reload(); } catch (e) { C.toast(e.message, 'error'); } C.rerender(); });
}

// ------------------------------------------------------------------------------------------------ 6 · الكابشن
const ANGLE_FALLBACK = ['زاوية المشكلة', 'زاوية المميزات', 'زاوية العرض'];
export function stepCaptions(el, C) {
  const p = C.p; const caps = p.copy?.captions || []; const sel = p.smart?.selectedCaption ?? 0;
  const angles = (C.j.research?.angles || []).map((a) => a.name);
  el.innerHTML = `${sechead('الكابشن', 'نسخ الإعلان والهيدلاين — اختار اللي هتنزل بيها.')}
    <div class="sx-card"><div class="sx-chead"><b>${caps.length ? `${caps.length} كابشن` : 'لسه مفيش كابشن'}</b><button class="sx-btn primary" data-k-go ${C.busy.copy ? 'disabled' : ''}>✍️ ${caps.length ? 'اكتب كابشن تاني' : 'اكتب الكابشن'}</button></div>
      <div class="sx-cbody">${msgHtml(C, 'copy')}${C.bar('copy')}
        ${caps.length ? `<div class="sx-caps">${caps.map((cp, i) => `<div class="sx-cap ${i === sel ? 'sel' : ''}" data-k-card="${i}">
          <div style="display:flex;justify-content:space-between;align-items:center;"><span class="sx-badge pri">${esc(angles[i] || ANGLE_FALLBACK[i] || `كابشن ${i + 1}`)}</span>${i === sel ? '<span class="sx-badge ok">✓ المختارة للكامبين</span>' : `<button class="sx-btn sm" data-k-pick="${i}">اختار دي</button>`}</div>
          ${C.editCap === i ? `<label class="sx-f"><span>الهيدلاين</span><input data-k-h value="${esc(cp.headline)}"></label><label class="sx-f"><span>الكابشن</span><textarea data-k-p rows="9">${esc(cp.primary)}</textarea></label><div class="sx-chiprow"><button class="sx-btn sm primary" data-k-save="${i}">حفظ</button><button class="sx-btn sm" data-k-cancel>إلغاء</button></div>`
            : `<div class="hl">${esc(cp.headline || '—')}</div><pre>${esc(cp.primary)}</pre><div class="acts"><button class="sx-btn sm" data-k-copy="h" data-i="${i}">نسخ الهيدلاين</button><button class="sx-btn sm" data-k-copy="p" data-i="${i}">نسخ الكابشن</button><button class="sx-btn sm ghost" data-k-edit="${i}">✏️ تعديل</button></div>`}
          </div>`).join('')}</div>
          ${(p.copy?.claimIssues || []).some((x) => /^caption/.test(x.field)) ? `<div class="sx-msg warn">⚠️ فيه كابشن فيه ادعاء محتاج مراجعة: ${esc(p.copy.claimIssues.filter((x) => /^caption/.test(x.field)).map((x) => `${x.field}: ${x.reason}`).join(' · '))}</div>` : ''}
          <small style="color:var(--sx-muted)">اللينك بيتحط في الإعلان أوتوماتيك وقت الكامبين.</small>`
          : '<div class="sx-empty"><div class="ic">💬</div><p>لسه مفيش كابشن.</p><small>بيكتب 3 كابشنات بزوايا مختلفة من المعلومات الحقيقية (والبحث لو اتعمل).</small></div>'}
      </div></div>`;
  on(el, '[data-k-go]', () => C.runJob('copy', () => api.post(`${B}/${p.id}/copy`, {}), 'بكتب المحتوى والكابشنات…'));
  on(el, '[data-k-pick]', async (b) => { try { await api.put(`${B}/${p.id}`, { smart: { selectedCaption: Number(b.dataset.kPick) } }); await C.reload(); } catch (e) { C.toast(e.message, 'error'); } C.rerender(); });
  on(el, '[data-k-copy]', async (b) => { const cp = caps[Number(b.dataset.i)]; try { await navigator.clipboard.writeText(b.dataset.kCopy === 'h' ? cp.headline : cp.primary); C.toast('اتنسخ.', 'success'); } catch { C.toast('المتصفح منع النسخ.', 'error'); } });
  on(el, '[data-k-edit]', (b) => { C.editCap = Number(b.dataset.kEdit); C.rerender(); });
  on(el, '[data-k-cancel]', () => { C.editCap = null; C.rerender(); });
  on(el, '[data-k-save]', async (b) => { const i = Number(b.dataset.kSave); const next = caps.map((x, k) => (k === i ? { primary: val(el, '[data-k-p]'), headline: val(el, '[data-k-h]') } : x)); try { await api.put(`${B}/${p.id}`, { copy: { captions: next } }); await C.reload(); C.editCap = null; } catch (e) { C.toast(e.message, 'error'); } C.rerender(); });
}
