// «مفاتيح مزوّدي الميديا» — the card in the Settings page where Apify / OpenAI / fal.ai / SerpApi are linked (keys are stored encrypted on the server; the value is never shown again).
// It used to sit inside the campaign launch wizard; it belongs with the rest of the system settings.
import { api } from './api-client.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ORDER = ['apify', 'openai', 'fal', 'serpapi'];

function row(id, p) {
  const chip = p.configured
    ? `<span class="mk-chip on">✓ مربوط${p.source === 'ENV' ? ' (من إعدادات السيرفر)' : ''}${p.last4 ? ` · …${esc(p.last4)}` : ''}</span>`
    : '<span class="mk-chip off">غير مربوط</span>';
  const actions = p.envOnly ? ''
    : `<button type="button" class="btn secondary small" data-mk-edit="${id}">${p.configured ? 'تغيير' : 'ربط'}</button>
       ${p.configured ? `<button type="button" class="btn secondary small" data-mk-test="${id}">اختبار</button>` : ''}
       ${p.source === 'SAVED' ? `<button type="button" class="btn secondary small" data-mk-del="${id}">مسح</button>` : ''}`;
  return `<div class="mk-row" data-mk-row="${id}">
    <div class="mk-main"><b>${esc(p.label)}</b><small>${esc(p.usedFor)}</small>${p.envOnly && !p.configured ? '<small>بيتظبط من Railway (متغير OPENAI_API_KEY) وشحن الرصيد من platform.openai.com</small>' : ''}</div>
    <div class="mk-side">${chip}${actions}</div>
    <div class="mk-edit" data-mk-form="${id}" hidden>
      <input type="password" autocomplete="off" spellcheck="false" placeholder="الصق المفتاح هنا" data-mk-input="${id}" />
      <button type="button" class="btn small" data-mk-save="${id}">حفظ</button>
    </div>
    <div class="mk-msg" data-mk-msg="${id}"></div>
  </div>`;
}

export async function mountMediaKeys(el, { toast = () => {} } = {}) {
  if (!el) return;
  el.innerHTML = '<div class="mk-dim">بيحمّل حالة الربط…</div>';
  let providers;
  try { providers = (await api.get('/api/amb-media/keys')).providers; }
  catch (e) { el.innerHTML = `<div class="mk-dim">تعذّر تحميل حالة الربط: ${esc(e.message)}</div>`; return; }

  const msg = (id, text, bad) => { const m = el.querySelector(`[data-mk-msg="${id}"]`); if (m) { m.textContent = text; m.className = `mk-msg ${bad ? 'bad' : 'good'}`; } };
  const draw = () => {
    el.innerHTML = `<div class="mk-rows">${ORDER.filter((id) => providers[id]).map((id) => row(id, providers[id])).join('')}</div>`;
    el.querySelectorAll('[data-mk-edit]').forEach((b) => { b.onclick = () => { const f = el.querySelector(`[data-mk-form="${b.dataset.mkEdit}"]`); f.hidden = !f.hidden; if (!f.hidden) f.querySelector('input').focus(); }; });
    el.querySelectorAll('[data-mk-save]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.mkSave; const input = el.querySelector(`[data-mk-input="${id}"]`); b.disabled = true;
        try {
          providers[id] = await api.put(`/api/amb-media/keys/${id}`, { value: input.value }); input.value = '';
          draw(); toast('اتحفظ المفتاح (مشفّر).', 'success');
          const t = await api.post(`/api/amb-media/keys/${id}/test`, {}); msg(id, t.message, !t.ok);
        } catch (e) { msg(id, e.message, true); b.disabled = false; }
      };
    });
    el.querySelectorAll('[data-mk-test]').forEach((b) => { b.onclick = async () => { b.disabled = true; try { const t = await api.post(`/api/amb-media/keys/${b.dataset.mkTest}/test`, {}); msg(b.dataset.mkTest, t.message, !t.ok); } catch (e) { msg(b.dataset.mkTest, e.message, true); } b.disabled = false; }; });
    el.querySelectorAll('[data-mk-del]').forEach((b) => { b.onclick = async () => { if (!confirm('تمسح المفتاح المحفوظ؟')) return; try { providers[b.dataset.mkDel] = await api.delete(`/api/amb-media/keys/${b.dataset.mkDel}`); draw(); toast('اتمسح المفتاح.', 'success'); } catch (e) { msg(b.dataset.mkDel, e.message, true); } }; });
  };
  draw();
}
