// AMB smart media tools — the panel inside the launch wizard's «الفيديوهات والصور» step.
// Phase 0: provider keys (Apify / fal.ai / SerpApi, OpenAI shown read-only). The finder and the AI generators plug in below later.
// Keys are write-only: the server returns only { configured, source, last4 }.
import { api } from './api-client.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ORDER = ['apify', 'openai', 'fal', 'serpapi'];
const SOON = [
  ['🔎', 'جمع فيديوهات المنتج', 'تيك توك وريلز ومكتبة إعلانات ميتا'],
  ['🖼️', 'صور الصفحة بالـ AI', 'من صورة المنتج والبرومبت'],
  ['🎬', 'فيديوهات AI كاملة', 'سكريبت وصوت ولقطات ومونتاج'],
];

function rowHtml(id, p) {
  const chip = p.configured
    ? `<span class="amt-chip on">✓ مربوط${p.source === 'ENV' ? ' (من إعدادات السيرفر)' : ''}${p.last4 ? ` · …${esc(p.last4)}` : ''}</span>`
    : '<span class="amt-chip off">غير مربوط</span>';
  const actions = p.envOnly
    ? ''
    : `<button type="button" class="amb-btn sm" data-amt-edit="${id}">${p.configured ? 'تغيير' : 'ربط'}</button>
       ${p.configured ? `<button type="button" class="amb-btn sm" data-amt-test="${id}">اختبار</button>` : ''}
       ${p.source === 'SAVED' ? `<button type="button" class="amb-btn sm" data-amt-del="${id}">مسح</button>` : ''}`;
  return `<div class="amt-row" data-amt-row="${id}">
    <div class="amt-main"><b>${esc(p.label)}</b><small class="amt-dim">${esc(p.usedFor)}</small>${p.envOnly && !p.configured ? '<small class="amt-dim">بيتظبط من Railway (متغير OPENAI_API_KEY) وشحن الرصيد من platform.openai.com</small>' : ''}</div>
    <div class="amt-side">${chip}${actions}</div>
    <div class="amt-edit" data-amt-form="${id}" hidden>
      <input type="password" autocomplete="off" spellcheck="false" placeholder="الصق المفتاح هنا" data-amt-input="${id}" />
      <button type="button" class="amb-btn sm primary" data-amt-save="${id}">حفظ</button>
    </div>
    <div class="amt-msg" data-amt-msg="${id}"></div>
  </div>`;
}

export async function mountMediaTools(el, { toast = () => {} } = {}) {
  if (!el) return;
  el.innerHTML = '<div class="amt-dim">بيحمّل حالة الربط…</div>';
  let providers;
  try { providers = (await api.get('/api/amb-media/keys')).providers; }
  catch (e) { el.innerHTML = `<div class="amt-dim">تعذّر تحميل حالة الربط: ${esc(e.message)}</div>`; return; }

  const render = () => {
    el.innerHTML = `
      <div class="amt-head"><b>🧰 أدوات الميديا الذكية</b><small class="amt-dim">اربط المزوّدين مرة واحدة، والأدوات تشتغل منهم</small></div>
      <div class="amt-rows">${ORDER.filter((id) => providers[id]).map((id) => rowHtml(id, providers[id])).join('')}</div>
      <div class="amt-soon">${SOON.map(([i, t, s]) => `<div class="amt-soon-card"><span>${i}</span><b>${t}</b><small>${s}</small><em>قريبًا</em></div>`).join('')}</div>`;
    const msg = (id, text, bad) => { const m = el.querySelector(`[data-amt-msg="${id}"]`); if (m) { m.textContent = text; m.className = `amt-msg ${bad ? 'bad' : 'good'}`; } };
    el.querySelectorAll('[data-amt-edit]').forEach((b) => { b.onclick = () => { const f = el.querySelector(`[data-amt-form="${b.dataset.amtEdit}"]`); f.hidden = !f.hidden; if (!f.hidden) f.querySelector('input').focus(); }; });
    el.querySelectorAll('[data-amt-save]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.amtSave; const input = el.querySelector(`[data-amt-input="${id}"]`);
        b.disabled = true;
        try {
          providers[id] = await api.put(`/api/amb-media/keys/${id}`, { value: input.value });
          input.value = ''; render(); toast('اتحفظ المفتاح (مشفّر).', 'success');
          const t = await api.post(`/api/amb-media/keys/${id}/test`, {}); msg(id, t.message, !t.ok);
        } catch (e) { msg(id, e.message, true); b.disabled = false; }
      };
    });
    el.querySelectorAll('[data-amt-test]').forEach((b) => { b.onclick = async () => { b.disabled = true; try { const t = await api.post(`/api/amb-media/keys/${b.dataset.amtTest}/test`, {}); msg(b.dataset.amtTest, t.message, !t.ok); } catch (e) { msg(b.dataset.amtTest, e.message, true); } b.disabled = false; }; });
    el.querySelectorAll('[data-amt-del]').forEach((b) => { b.onclick = async () => { if (!confirm('تمسح المفتاح المحفوظ؟')) return; try { providers[b.dataset.amtDel] = await api.delete(`/api/amb-media/keys/${b.dataset.amtDel}`); render(); } catch (e) { msg(b.dataset.amtDel, e.message, true); } }; });
  };
  render();
}
