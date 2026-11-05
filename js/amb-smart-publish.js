// Smart Campaign step 5 — «النشر على المتجر». A product that already lives on the store has its page there («صفحتك جاهزة»); what this step adds is a GUARDED text update
// (preview before / after → explicit confirmation → write), the landing-page link the campaign will use, and the manual package.
import { api } from './api-client.js';
import * as UI from './ui-common.js';
import { B, esc } from './amb-smart-steps.js';

export function stepPublish(el, C) {
  const p = C.p; const e = p.eo; const pub = p.smart?.publish;
  const ready = (p.images || []).filter((i) => i.status === 'READY').length;
  const st = C.pub || (C.pub = { opts: { description: true, name: false, prices: false, settings: false }, preview: null, busy: false });
  const q = () => `description=${st.opts.description ? 1 : 0}&name=${st.opts.name ? 1 : 0}&prices=${st.opts.prices ? 1 : 0}&settings=${st.opts.settings ? 1 : 0}`;
  const landing = p.smart?.landingUrl || '';
  const checks = [[!!e, 'المتجر مربوط'], [ready > 0, 'صور الصفحة جاهزة'], [p.price != null && p.price > 0, 'السعر متحدد']];
  el.innerHTML = `<div class="sx-sec"><h2>النشر على المتجر</h2><p>اتأكد إن كل حاجة جاهزة وحدّث المنتج على المتجر — بتأكيدك بس.</p></div>
    ${e ? `<div class="sx-banner"><div class="ico">🏪</div><div><b>صفحة المنتج جاهزة عندك</b><small>الكابشنات والكامبين هيستخدموا لينك صفحتك — مش محتاج تعمل صور أو صفحة أو تنشر من هنا.</small></div>${landing ? `<a class="sx-btn" href="${esc(landing)}" target="_blank" rel="noopener noreferrer">صفحة المنتج على المتجر ↗</a>` : ''}</div>` : ''}
    <div class="sx-card"><div class="sx-chead"><b>قبل النشر</b></div><div class="sx-cbody"><div class="sx-list">${checks.map(([ok, l]) => `<div class="sx-li ${ok ? '' : 'warn'}"><span>${ok ? '✓' : '○'}</span>${esc(l)}</div>`).join('')}</div>
      ${pub ? `<div class="sx-msg">✅ اتحدّث المتجر قبل كده (${esc((pub.fields || []).join('، '))}) — ${esc(String(pub.at).slice(0, 16).replace('T', ' '))}</div>` : ''}
      ${!e ? '<div class="sx-msg warn">الصفحة دي مش مربوطة بمنتج من إيزي أوردر، فمفيش تحديث للمتجر. نزّل الحزمة تحت وانشرها بإيدك.</div>' : `
      <div class="sx-msg warn">⚠️ التحديث بيكتب على المتجر الحقيقي. هتشوف التغيير قبل وبعد، ومفيش حاجة بتتبعت غير بعد تأكيدك. بيحدّث <b>النص والإعدادات بس</b> — الصور مش بتتبعت (محتاجة استضافة دايمة لسه مش متوصلة).</div>
      <div class="sx-list" style="gap:6px;">${[['description', 'وصف المنتج (من كلام الصفحة)'], ['name', 'اسم المنتج'], ['prices', 'الأسعار (السعر قبل الخصم وسعر البيع)'], ['settings', 'إعدادات الصفحة (من خطوة «صفحة المنتج»)']].map(([k, l]) => `<label class="sx-toggle"><input type="checkbox" data-sp-o="${k}" ${st.opts[k] ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <div><button class="sx-btn" data-sp-preview ${st.busy ? 'disabled' : ''}>👁️ معاينة التغيير</button></div>
      ${st.preview ? `<div class="sx-diff">${st.preview.fields.map((f) => `<div class="sx-drow"><b>${esc(f.label)}</b><div><small>قبل</small><div class="sx-dbox">${esc(f.before || '—')}</div></div><div><small>بعد</small><div class="sx-dbox new">${esc(f.after)}</div></div></div>`).join('')}${st.preview.notes.map((n) => `<div class="sx-msg warn">${esc(n)}</div>`).join('')}<div><button class="sx-btn primary" data-sp-apply ${st.busy ? 'disabled' : ''}>انشر على المتجر</button></div></div>` : ''}`}
      ${C.msg.publish ? `<div class="sx-msg ${C.msg.publish.bad ? 'bad' : ''}">${esc(C.msg.publish.text)}</div>` : ''}
    </div></div>
    <div class="sx-card"><div class="sx-chead"><div><b>المنتج موجود على متجرك بالفعل؟</b><br><small>حط لينكه هنا وتقدر تعمل الكامبين على طول من غير ما تنشره من هنا.</small></div></div><div class="sx-cbody">
      <label class="sx-f"><span>لينك المنتج على المتجر</span><input data-sp-landing dir="ltr" value="${esc(landing)}" placeholder="https://www.your-store.com/products/…"><small>ده اللينك اللي الإعلانات والكابشن بيوّدوا عليه — لو غيرت الـ slug أو الدومين حدّثه هنا.</small></label>
      <div><button class="sx-btn" data-sp-savelanding>حفظ اللينك</button></div></div></div>
    <div class="sx-card"><div class="sx-chead"><div><b>📦 حزمة النشر اليدوي</b><br><small>الصور بالترتيب + نص الصفحة — ارفعها على المتجر بإيدك.</small></div></div><div class="sx-cbody"><div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="sx-btn" data-sp-zip>⬇️ نزّل الحزمة (ZIP)</button><button class="sx-btn" data-sp-copy>📋 انسخ النص</button></div></div></div>`;

  const redraw = () => C.rerender();
  el.querySelectorAll('[data-sp-o]').forEach((c) => { c.onchange = () => { st.opts[c.dataset.spO] = c.checked; st.preview = null; C.say('publish', null); redraw(); }; });
  const pv = el.querySelector('[data-sp-preview]');
  if (pv) pv.onclick = async () => { st.busy = true; C.say('publish', null); redraw(); try { st.preview = await api.get(`${B}/${p.id}/eo-publish/preview?${q()}`); } catch (er) { st.preview = null; C.say('publish', er.message, true); } st.busy = false; redraw(); };
  const ap = el.querySelector('[data-sp-apply]');
  if (ap) ap.onclick = async () => {
    const prev = st.preview; if (!prev) return;
    const ok = await UI.confirmModal({ title: 'تحديث المنتج على إيزي أوردر', message: `هيتحدّث ${prev.product.name} على المتجر الحقيقي: ${prev.fields.map((f) => f.label).join('، ')}.\nالتحديث بيظهر للعملاء على طول. متأكد؟`, confirmLabel: 'أيوه، حدّث المتجر', danger: true });
    if (!ok) return;
    st.busy = true; C.say('publish', null); redraw();
    try { await api.post(`${B}/${p.id}/eo-publish`, { options: st.opts, hash: prev.hash, confirm: true }); await C.reload(); st.preview = null; C.say('publish', '✅ اتحدّث المنتج على إيزي أوردر.'); C.toast('اتحدّث المنتج على إيزي أوردر.', 'success'); } catch (er) { C.say('publish', er.message, true); }
    st.busy = false; redraw();
  };
  const sl = el.querySelector('[data-sp-savelanding]');
  if (sl) sl.onclick = async () => { try { await api.put(`${B}/${p.id}`, { smart: { landingUrl: el.querySelector('[data-sp-landing]').value.trim() } }); await C.reload(); C.say('publish', '✅ اتحفظ اللينك.'); } catch (er) { C.say('publish', er.message, true); } redraw(); };
  const zip = el.querySelector('[data-sp-zip]');
  if (zip) zip.onclick = () => { if (!ready) { C.say('publish', 'مفيش صور جاهزة للتصدير.', true); return redraw(); } const a = document.createElement('a'); a.href = `${B}/${p.id}/export.zip`; a.download = `page-${p.id}.zip`; document.body.appendChild(a); a.click(); a.remove(); };
  const cp = el.querySelector('[data-sp-copy]');
  if (cp) cp.onclick = async () => { try { const t = await (await fetch(`${B}/${p.id}/export.txt`, { credentials: 'include' })).text(); await navigator.clipboard.writeText(t); C.toast('اتنسخ النص.', 'success'); } catch { C.toast('تعذّر النسخ.', 'error'); } };
}
