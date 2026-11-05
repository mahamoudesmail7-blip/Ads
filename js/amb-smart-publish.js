// Smart Campaign step 6 — «النشر على المتجر»: update the linked Easy Orders product's TEXT from the journey. WRITES to the live store, so the flow is
// preview (exactly what changes, before / after) → explicit confirmation → write. Images are not sent (they need permanent public hosting); the ZIP is the way for them.
import { api } from './api-client.js';
import * as UI from './ui-common.js';

const B = '/api/amb-media/pages';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function mountSmartPublish(el, { toast = () => {}, projectId, onChange = async () => {} } = {}) {
  const st = { opts: { description: true, name: false, prices: false }, preview: null, busy: false, msg: null };
  let p;
  try { p = await api.get(`${B}/${projectId}`); } catch (e) { el.innerHTML = `<div class="pgp-empty">تعذّر التحميل: ${esc(e.message)}</div>`; return; }

  const q = () => `description=${st.opts.description ? 1 : 0}&name=${st.opts.name ? 1 : 0}&prices=${st.opts.prices ? 1 : 0}`;
  function draw() {
    const pub = p.smart?.publish;
    const prev = st.preview;
    el.innerHTML = `<div class="lp-card pgp-sec">
      <div class="sc-rhead"><div><b>🏪 النشر على المتجر (إيزي أوردر)</b><small class="amt-dim">${p.eo ? `المنتج: ${esc(p.eo.name)}` : 'الصفحة مش مربوطة بمنتج من إيزي أوردر'}</small></div></div>
      ${pub ? `<div class="pgp-msg good">✅ اتحدّث المتجر قبل كده (${esc((pub.fields || []).join('، '))}) — ${esc(String(pub.at).slice(0, 16).replace('T', ' '))}</div>` : ''}
      ${!p.eo ? '<div class="pgp-empty">اربط الصفحة بمنتج من إيزي أوردر في الخطوة 1 عشان تقدر تحدّث المتجر. وممكن تنزّل الحزمة وتنشرها بإيدك.</div>' : `
      <div class="sc-warnbox">⚠️ ده بيكتب على المتجر الحقيقي. هتشوف التغيير قبل وبعد، ومفيش حاجة بتتبعت غير بعد ما تأكّد. بيحدّث <b>النص بس</b> — الصور مش بتتبعت (محتاجة استضافة دايمة لسه مش متوصلة)، نزّل الحزمة وانشرها بإيدك.</div>
      <div class="sc-opts">
        <label><input type="checkbox" data-sp-o="description" ${st.opts.description ? 'checked' : ''}> وصف المنتج (من محتوى الصفحة)</label>
        <label><input type="checkbox" data-sp-o="name" ${st.opts.name ? 'checked' : ''}> اسم المنتج</label>
        <label><input type="checkbox" data-sp-o="prices" ${st.opts.prices ? 'checked' : ''}> الأسعار (السعر قبل الخصم وسعر البيع)</label>
      </div>
      <div class="pgp-actions"><button class="amb-btn" data-sp-preview ${st.busy ? 'disabled' : ''}>👁️ معاينة التغيير</button></div>
      ${prev ? `<div class="sc-diff">${prev.fields.map((f) => `<div class="sc-drow"><b>${esc(f.label)}</b><div><small>قبل</small><div class="sc-dbox">${esc(f.before || '—')}</div></div><div><small>بعد</small><div class="sc-dbox new">${esc(f.after)}</div></div></div>`).join('')}${prev.notes.map((n) => `<div class="pgp-msg bad">${esc(n)}</div>`).join('')}
        <div class="pgp-actions"><button class="amb-btn danger" data-sp-apply ${st.busy ? 'disabled' : ''}>✅ أكّد وحدّث المتجر</button></div></div>` : ''}`}
      ${st.msg ? `<div class="pgp-msg ${st.msg.bad ? 'bad' : 'good'}">${esc(st.msg.text)}</div>` : ''}
      <div class="sc-pack"><b>📦 حزمة النشر اليدوي</b><small class="amt-dim">الصور بالترتيب + نص الصفحة — ارفعها على المتجر بإيدك.</small>
        <div class="pgp-actions"><button class="amb-btn" data-sp-zip>⬇️ نزّل الحزمة (ZIP)</button><button class="amb-btn" data-sp-copy>📋 انسخ النص</button></div></div>
    </div>`;
    wire();
  }

  function wire() {
    el.querySelectorAll('[data-sp-o]').forEach((c) => { c.onchange = () => { st.opts[c.dataset.spO] = c.checked; st.preview = null; st.msg = null; draw(); }; });
    const pv = el.querySelector('[data-sp-preview]');
    if (pv) pv.onclick = async () => {
      st.busy = true; st.msg = null; draw();
      try { st.preview = await api.get(`${B}/${projectId}/eo-publish/preview?${q()}`); } catch (e) { st.preview = null; st.msg = { text: e.message, bad: true }; }
      st.busy = false; draw();
    };
    const ap = el.querySelector('[data-sp-apply]');
    if (ap) ap.onclick = async () => {
      const prev = st.preview; if (!prev) return;
      const ok = await UI.confirmModal({ title: 'تحديث المنتج على إيزي أوردر', message: `هيتحدّث ${prev.product.name} على المتجر الحقيقي: ${prev.fields.map((f) => f.label).join('، ')}.\nالتحديث بيظهر للعملاء على طول. متأكد؟`, confirmLabel: 'أيوه، حدّث المتجر', danger: true });
      if (!ok) return;
      st.busy = true; st.msg = null; draw();
      try {
        await api.post(`${B}/${projectId}/eo-publish`, { options: st.opts, hash: prev.hash, confirm: true });
        p = await api.get(`${B}/${projectId}`); st.preview = null; st.msg = { text: '✅ اتحدّث المنتج على إيزي أوردر.', bad: false }; toast('اتحدّث المنتج على إيزي أوردر.', 'success'); await onChange();
      } catch (e) { st.msg = { text: e.message, bad: true }; }
      st.busy = false; draw();
    };
    const zip = el.querySelector('[data-sp-zip]');
    if (zip) zip.onclick = () => { if (!(p.images || []).some((i) => i.status === 'READY')) { st.msg = { text: 'مفيش صور جاهزة للتصدير.', bad: true }; draw(); return; } const a = document.createElement('a'); a.href = `${B}/${projectId}/export.zip`; a.download = `page-${projectId}.zip`; document.body.appendChild(a); a.click(); a.remove(); };
    const cp = el.querySelector('[data-sp-copy]');
    if (cp) cp.onclick = async () => { try { const t = await (await fetch(`${B}/${projectId}/export.txt`, { credentials: 'include' })).text(); await navigator.clipboard.writeText(t); toast('اتنسخ النص.', 'success'); } catch { toast('تعذّر النسخ.', 'error'); } };
  }
  draw();
}
