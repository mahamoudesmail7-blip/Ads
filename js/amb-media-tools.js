// AMB smart media tools — the panel inside the launch wizard's «الفيديوهات والصور» step.
//   0) (the provider keys moved to Settings → «مفاتيح مزوّدي الميديا»; here only a hint when something isn't linked)   1) AI page images
//   2) find existing product videos → pick → import into the creative pool   3) short AI videos from the product photo
// Long work runs as a server job; this file starts it and polls. State lives at module level so the wizard re-rendering the step
// (it does, on every upload) never loses the search result, the selection or a running job's progress bar.
import { api } from './api-client.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ORDER = ['apify', 'openai', 'fal', 'serpapi'];
const SRC = { LENS: 'من بحث الصورة', TIKTOK: 'تيك توك', INSTAGRAM: 'ريلز', META_ADS: 'إعلان شغّال', MANUAL: 'لينك منك', YOUTUBE: 'يوتيوب' };
const nf = new Intl.NumberFormat('ar-EG', { notation: 'compact' });

// jobId (launch job) → UI state kept across re-renders
const STATE = new Map();
let LIVE = null; // the newest mounted panel: a job started from an older render still repaints the CURRENT one when it finishes
const st = (jobId) => { if (!STATE.has(jobId)) STATE.set(jobId, { find: null, selected: new Set(), busy: {}, bar: {}, msg: {}, links: '' }); return STATE.get(jobId); };

async function pollJob(id, onTick, { everyMs = 2000, maxMs = 35 * 60_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const j = await api.get(`/api/amb-media/jobs/${id}`);
    onTick?.(j);
    if (j.status === 'SUCCEEDED' || j.status === 'FAILED' || j.status === 'CANCELED') return j;
    if (Date.now() - t0 > maxMs) throw new Error('الشغل أخد وقت أطول من المتوقع — ارجع شوف النتيجة بعد شوية.');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** One line instead of the old key panel: which providers still need linking, and a way to the Settings page. */
function keysHint(providers) {
  const missing = ORDER.filter((id) => providers[id] && !providers[id].configured).map((id) => providers[id].label);
  if (!missing.length) return '';
  return `<div class="amt-keyhint">⚙️ لسه مش مربوط: <b>${esc(missing.join('، '))}</b> — اربطه من <a href="#" data-amt-settings>الإعدادات ← مفاتيح مزوّدي الميديا</a></div>`;
}

/** Full-size look at a picture (mounted on <html>: the embedded page's body carries a transform, which would pin a fixed overlay mid-page). */
export function openImageViewer(src, caption = '') {
  document.querySelectorAll('.amt-viewer.img').forEach((x) => x.remove());
  const ov = document.createElement('div');
  ov.className = 'amt-viewer img';
  ov.innerHTML = `<div class="amt-viewer-box"><button type="button" class="amt-viewer-x" aria-label="إغلاق">✕</button><img src="${esc(src)}" alt="" />${caption ? `<small>${esc(caption)}</small>` : ''}</div>`;
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.querySelector('.amt-viewer-x').onclick = close;
  document.addEventListener('keydown', onKey);
  document.documentElement.appendChild(ov);
}
export const imagePreviewUrl = (jobId, slotKey) => `/api/amb-media/image-preview?launchJobId=${encodeURIComponent(jobId)}&slotKey=${encodeURIComponent(slotKey)}`;

/** The pictures this tool just made: look at each (click = full size) and drop the ones you don't want. */
function galleryHtml(s, jobId) {
  const list = s.gallery || [];
  if (!list.length || !jobId) return '';
  return `<div class="amt-gal"><div class="amt-galhead"><b>الصور اللي اتولّدت (${list.length})</b><small class="amt-dim">اضغط على صورة تكبّرها · ✕ تستبعدها من قائمة الرفع</small></div>
    <div class="amt-galgrid">${list.map((k) => `<figure class="amt-galitem"><button type="button" class="amt-galimg" data-amt-gview="${esc(k)}" title="تكبير"><img loading="lazy" src="${esc(imagePreviewUrl(jobId, k))}" alt="${esc(k)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'🖼️'}))"></button><figcaption>${esc(k)}<button type="button" class="amt-galdel" data-amt-gdel="${esc(k)}" title="استبعاد" aria-label="استبعاد ${esc(k)}">✕</button></figcaption></figure>`).join('')}</div></div>`;
}

const bar = (s, k) => (s.busy[k] ? `<div class="amt-prog"><i style="width:${s.bar[k]?.pct || 3}%"></i></div><small class="amt-dim">${esc(s.bar[k]?.message || 'شغال…')}</small>` : '');
const note = (s, k) => (s.msg[k] ? `<div class="amt-msg ${s.msg[k].bad ? 'bad' : 'good'}">${esc(s.msg[k].text)}</div>` : '');
const disabledWhy = (cap) => (cap && !cap.ready ? `<small class="amt-dim">⚠️ ${esc(cap.reason)}</small>` : '');

function candidateCard(c, selected) {
  const stats = [c.views != null ? `👁 ${nf.format(c.views)}` : '', c.adDays != null ? `📅 شغّال من ${c.adDays} يوم` : '', c.adCount > 1 ? `×${c.adCount} نسخة` : '', c.durationSec ? `${Math.round(c.durationSec)}ث` : ''].filter(Boolean).join(' · ');
  const score = c.matchScore != null ? `<span class="amt-score ${c.matchScore >= 70 ? 'hi' : c.matchScore >= 40 ? 'mid' : 'lo'}" title="${esc(c.matchNote || '')}">${c.matchScore}%</span>` : '';
  return `<label class="amt-cand ${selected ? 'on' : ''}">
    <input type="checkbox" data-amt-pick="${esc(c.id)}" ${selected ? 'checked' : ''} />
    <div class="amt-cover">${c.thumbnail ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(c.thumbnail)}" alt="" onerror="this.remove()">` : '<span>🎬</span>'}${score}</div>
    <div class="amt-cinfo"><b>${esc(SRC[c.source] || c.source)}${c.author ? ` · ${esc(c.author)}` : ''}</b><small>${esc((c.caption || '').slice(0, 70))}</small><small class="amt-dim">${esc(stats)}</small>
    <a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" class="amt-open">فتح الأصل ↗</a></div></label>`;
}

export async function mountMediaTools(el, { toast = () => {}, getJobId = () => null, getProductId = () => null, ensureJob = async () => null, onAdded = async () => {}, onRemove = () => {} } = {}) {
  if (!el) return;
  el.innerHTML = '<div class="amt-dim">بيحمّل حالة الربط…</div>';
  let providers, caps;
  try { [providers, caps] = await Promise.all([api.get('/api/amb-media/keys').then((r) => r.providers), api.get('/api/amb-media/capabilities')]); }
  catch (e) { el.innerHTML = `<div class="amt-dim">تعذّر تحميل حالة الربط: ${esc(e.message)}</div>`; return; }
  const jobId = () => getJobId();

  const draw = () => {
    const J = jobId(); const s = st('w');
    const cands = s.find?.candidates || [];
    el.innerHTML = `
      <div class="amt-head"><b>🧰 أدوات الميديا الذكية</b><small class="amt-dim">الأدوات بتضيف الفيديوهات والصور لنفس قائمة الرفع تحت (مفاتيح المزوّدين من الإعدادات)</small></div>
      ${keysHint(providers)}

      <div class="amt-tool" data-tool="photo">
        <div class="amt-th"><b>📷 صورة المنتج</b><small class="amt-dim">كل الأدوات بتبدأ من صورة المنتج الحقيقية. لو السيستم مالقاش صورة، ارفع واحدة (JPG/PNG حتى 8MB)</small></div>
        <div class="amt-ctl"><button type="button" class="amb-btn sm" data-amt-photo ${getProductId() ? '' : 'disabled'}>ارفع صورة المنتج</button><input type="file" accept="image/jpeg,image/png,image/webp" data-amt-photo-input hidden /></div>${note(s, 'photo')}
      </div>

      <div class="amt-tool" data-tool="pi">
        <div class="amt-th"><b>🖼️ صور بالـ AI من صورة المنتج</b><small class="amt-dim">بتحافظ على شكل المنتج الحقيقي وبتترفع على حسابك الإعلاني</small></div>
        <div class="amt-ctl">
          <select data-amt-pi-style>${Object.entries(caps.pageImages.styles || {}).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
          <select data-amt-pi-count>${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n} صور</option>`).join('')}</select>
          <button type="button" class="amb-btn sm primary" data-amt-go="pi" ${s.busy.pi || !caps.pageImages.ready ? 'disabled' : ''}>ولّد الصور</button>
        </div>${disabledWhy(caps.pageImages)}${bar(s, 'pi')}${note(s, 'pi')}${galleryHtml(s, J)}
      </div>

      <div class="amt-tool" data-tool="find">
        <div class="amt-th"><b>🔎 دوّر على فيديوهات للمنتج</b><small class="amt-dim">أول مرحلة: بحث بصورة المنتج (Google Lens)، وبعدها تيك توك وريلز ومكتبة إعلانات ميتا — وبيترتّبوا بشبه الغلاف لصورة المنتج</small></div>
        <textarea data-amt-links rows="2" placeholder="اختياري: الصق لينكات فيديوهات (تيك توك / انستجرام / يوتيوب) سطر لكل لينك">${esc(s.links)}</textarea>
        <div class="amt-ctl">
          <select data-amt-find-target>${[8, 12, 20].map((n) => `<option value="${n}" ${n === 12 ? 'selected' : ''}>${n} فيديو</option>`).join('')}</select>
          <button type="button" class="amb-btn sm primary" data-amt-go="find" ${s.busy.find || (!caps.finder.ready && !s.links.trim()) ? 'disabled' : ''}>ابحث</button>
        </div>${disabledWhy(caps.finder)}${bar(s, 'find')}${note(s, 'find')}
        ${cands.length ? `<div class="amt-sources">${(s.find.sources || []).map((x) => `<span class="amt-chip ${x.ok ? 'on' : 'off'}" title="${esc(x.error || '')}">${esc(x.label)}: ${x.ok ? x.count : 'فشل'}</span>`).join('')}${s.find.scored ? '' : '<span class="amt-chip off">من غير ترتيب بالغلاف</span>'}</div>
          <div class="amt-grid">${cands.map((c) => candidateCard(c, s.selected.has(c.id))).join('')}</div>
          <div class="amt-ctl"><button type="button" class="amb-btn sm primary" data-amt-go="imp" ${s.busy.imp || !s.selected.size ? 'disabled' : ''}>استورد المختار (${s.selected.size})</button><small class="amt-dim">بيتنزّلوا على السيرفر ويترفعوا على الحساب الإعلاني. تأكد إن عندك حق استخدام الفيديو — إعادة نشر فيديوهات الغير ممكن تجيب بلاغات حقوق.</small></div>${bar(s, 'imp')}${note(s, 'imp')}` : ''}
      </div>

      <div class="amt-tool" data-tool="ai">
        <div class="amt-th"><b>🎬 فيديو AI من صورة المنتج</b><small class="amt-dim">التوليد بيخصم من رصيد fal.ai وOpenAI وبياخد عدة دقايق</small></div>
        <div class="amt-ctl">
          <select data-amt-ai-mode><option value="explainer" ${(s.aiMode || 'explainer') === 'explainer' ? 'selected' : ''}>فيديو شرح: مشاهد استخدام + تعليق صوتي بالمصري + ترجمة</option><option value="clip" ${s.aiMode === 'clip' ? 'selected' : ''}>مقطع قصير متحرك من الصورة (بدون شرح)</option></select>
        </div>
        ${(s.aiMode || 'explainer') === 'explainer' ? `
        <label class="amt-fieldlbl">مميزات الجهاز الحقيقية (سطر لكل ميزة) — الشرح هيتكتب منها بس، فكل ما كانت أدق كان الفيديو أحسن
          <textarea data-amt-ai-facts rows="3" placeholder="رشاش مدمج يرطّب الشعر&#10;بطارية قابلة للشحن&#10;رأس فرشاة واسع">${esc(s.aiFacts || '')}</textarea></label>
        <div class="amt-ctl">
          <select data-amt-ai-scenes><option value="3">3 مشاهد (حوالي 16 ثانية)</option><option value="4">4 مشاهد (حوالي 21 ثانية)</option></select>
          <select data-amt-ai-count>${[1, 2].map((n) => `<option value="${n}">${n} فيديو</option>`).join('')}</select>
          <label class="amt-check"><input type="checkbox" data-amt-ai-caps checked> ترجمة عربي على الشاشة</label>
          <button type="button" class="amb-btn sm primary" data-amt-go="ai" ${s.busy.ai || !caps.aiVideos.ready ? 'disabled' : ''}>ولّد فيديو الشرح</button>
        </div>
        <small class="amt-dim">التكلفة التقريبية (تقدير): حوالي 1.3$ لفيديو بـ 3 مشاهد، و1.7$ لـ 4 مشاهد. التوليد بياخد من 5 لـ 12 دقيقة.</small>` : `
        <div class="amt-ctl">
          <select data-amt-ai-style>${(caps.aiVideos.styles || []).map((k) => `<option value="${k}">${{ ugc: 'UGC عفوي', demo: 'عرض المنتج', lifestyle: 'استخدام يومي' }[k] || k}</option>`).join('')}</select>
          <select data-amt-ai-secs><option value="5">5 ثواني</option><option value="10">10 ثواني</option></select>
          <select data-amt-ai-count>${[1, 2, 3].map((n) => `<option value="${n}">${n} فيديو</option>`).join('')}</select>
          <button type="button" class="amb-btn sm primary" data-amt-go="ai" ${s.busy.ai || !caps.aiVideos.ready ? 'disabled' : ''}>ولّد المقطع</button>
        </div>
        <small class="amt-dim">مقطع عمودي قصير بيحرّك صورة المنتج نفسها، من غير شرح. لو الصورة فيها كتابة أو تصميم إعلاني، الكتابة هتتحرك معاها.</small>`}
        ${disabledWhy(caps.aiVideos)}${bar(s, 'ai')}${note(s, 'ai')}
      </div>
`;
    wire();
  };
  LIVE = { draw };
  const render = () => (LIVE?.draw || draw)();

  const msg = (id, text, bad) => { const m = el.querySelector(`[data-amt-msg="${id}"]`); if (m) { m.textContent = text; m.className = `amt-msg ${bad ? 'bad' : 'good'}`; } };

  async function runTool(kind, startPath, payload, { okText }) {
    const s = st('w');
    s.busy[kind] = true; s.bar[kind] = { pct: 3, message: 'بدأ…' }; s.msg[kind] = null; render();
    try {
      const J = await ensureJob(); // the wizard creates its upload job lazily — start it now so the tool has somewhere to put the result
      if (!J) throw new Error('اختار المنتج والحساب الإعلاني الأول (الخطوة 1 و2).');
      if (s.forJob && s.forJob !== J) { s.find = null; s.selected.clear(); }
      s.forJob = J;
      const started = await api.post(startPath, { launchJobId: J, ...payload });
      const done = await pollJob(started.id, (j) => { s.bar[kind] = { pct: j.progress, message: j.message }; const b = el.querySelector(`[data-tool="${kind === 'imp' ? 'find' : kind}"] .amt-prog i`); if (b) b.style.width = `${j.progress}%`; });
      s.busy[kind] = false;
      if (done.status === 'FAILED') { s.msg[kind] = { text: done.error?.message || 'فشل.', bad: true }; render(); return null; }
      s.msg[kind] = { text: okText(done.result), bad: false };
      return done;
    } catch (e) { s.busy[kind] = false; s.msg[kind] = { text: e.message, bad: true }; render(); return null; }
  }

  function wire() {
    const J = jobId(); const s = st('w');
    const toSettings = el.querySelector('[data-amt-settings]');
    if (toSettings) toSettings.onclick = (e) => { e.preventDefault(); try { window.top.location.hash = '#/settings.html'; } catch { window.location.href = 'settings.html'; } };

    el.querySelectorAll('[data-amt-gview]').forEach((b) => { b.onclick = () => openImageViewer(imagePreviewUrl(jobId(), b.dataset.amtGview), b.dataset.amtGview); });
    el.querySelectorAll('[data-amt-gdel]').forEach((b) => {
      b.onclick = async () => {
        const k = b.dataset.amtGdel; const J2 = jobId(); if (!J2) return; b.disabled = true;
        try { await api.delete(`/api/ai-media-buyer/launch/jobs/${J2}/images/${k}`); s.gallery = (s.gallery || []).filter((x) => x !== k); onRemove(k); render(); toast('اتشالت الصورة من قائمة الرفع.', 'success'); }
        catch (e) { b.disabled = false; toast(e.message || 'تعذّر استبعاد الصورة.', 'error'); }
      };
    });
    const photoBtn = el.querySelector('[data-amt-photo]'), photoIn = el.querySelector('[data-amt-photo-input]');
    if (photoBtn && photoIn) {
      photoBtn.onclick = () => photoIn.click();
      photoIn.onchange = async () => {
        const file = photoIn.files?.[0]; const pid = getProductId(); if (!file || !pid) return;
        if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { s.msg.photo = { text: 'لازم تختار صورة JPG أو PNG أو WebP.', bad: true }; render(); return; }
        if (file.size > 8 * 1024 * 1024) { s.msg.photo = { text: 'الصورة أكبر من 8MB.', bad: true }; render(); return; }
        photoBtn.disabled = true;
        try {
          const res = await fetch(`/api/ai-media-buyer/products/by-catalog/${pid}/manual-image`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': file.type }, body: file });
          const j = await res.json().catch(() => null);
          if (!res.ok) throw new Error(j?.message || `فشل رفع الصورة (HTTP ${res.status}).`);
          s.msg.photo = { text: '✅ اتحفظت صورة المنتج — جرّب الأدوات دلوقتي.', bad: false };
        } catch (e) { s.msg.photo = { text: e.message, bad: true }; }
        render();
      };
    }
    const ta = el.querySelector('[data-amt-links]'); if (ta) ta.oninput = () => { s.links = ta.value; const go = el.querySelector('[data-amt-go="find"]'); if (go) go.disabled = s.busy.find || (!caps.finder.ready && !s.links.trim()); };
    el.querySelectorAll('[data-amt-pick]').forEach((cb) => { cb.onchange = () => { cb.checked ? s.selected.add(cb.dataset.amtPick) : s.selected.delete(cb.dataset.amtPick); cb.closest('.amt-cand').classList.toggle('on', cb.checked); const go = el.querySelector('[data-amt-go="imp"]'); if (go) { go.disabled = s.busy.imp || !s.selected.size; go.textContent = `استورد المختار (${s.selected.size})`; } }; });
    const val = (sel) => el.querySelector(sel)?.value;
    const go = (k) => el.querySelector(`[data-amt-go="${k}"]`);
    if (go('pi')) go('pi').onclick = async () => { const d = await runTool('pi', '/api/amb-media/page-images', { count: Number(val('[data-amt-pi-count]')), style: val('[data-amt-pi-style]') }, { okText: (r) => `اتضافت ${r.added.length} صورة لقائمة الرفع${r.failed?.length ? ` (فشل ${r.failed.length})` : ''} — شوفها تحت واستبعد اللي مش عاجبك.` }); if (d) { s.gallery = [...new Set([...(s.gallery || []), ...(d.result.added || [])])]; await onAdded(); render(); } };
    if (go('find')) go('find').onclick = async () => { s.find = null; s.selected.clear(); const manualUrls = s.links.split(/\s+/).filter(Boolean); const d = await runTool('find', '/api/amb-media/videos/find', { target: Number(val('[data-amt-find-target]')), manualUrls }, { okText: (r) => (r.candidates.length ? `لقيت ${r.candidates.length} فيديو شبه المنتج — اختار اللي عايزه.${r.filteredOut ? ` (استبعدت ${r.filteredOut} فيديو مش شبهه.)` : ''}` : '') });
      if (d) {
        s.find = { ...d.result, jobId: d.id };
        if (!d.result.candidates.length) s.msg.find = { bad: true, text: `مفيش فيديو مطابق للمنتج ظهر${d.result.filteredOut ? ` (استبعدت ${d.result.filteredOut} فيديو الغلاف بتاعهم مش بيبيّن المنتج)` : ''}. جرّب صورة منتج أوضح (الجهاز لوحده على خلفية بيضا)، أو الصق لينكات فيديوهات بنفسك.` };
        render();
      }
    };
    if (go('imp')) go('imp').onclick = async () => { const d = await runTool('imp', '/api/amb-media/videos/import', { findJobId: s.find.jobId, ids: [...s.selected] }, { okText: (r) => `اتضاف ${r.added.length} فيديو لقائمة الرفع${r.failed?.length ? ` (فشل ${r.failed.length}: ${r.failed[0].error})` : ''}.` }); if (d) { s.selected.clear(); await onAdded(); render(); } };
    const modeSel = el.querySelector('[data-amt-ai-mode]'); if (modeSel) modeSel.onchange = () => { s.aiMode = modeSel.value; render(); };
    const factsTa = el.querySelector('[data-amt-ai-facts]'); if (factsTa) factsTa.oninput = () => { s.aiFacts = factsTa.value; };
    if (go('ai')) go('ai').onclick = async () => {
      const explainer = (s.aiMode || 'explainer') === 'explainer';
      const payload = explainer
        ? { mode: 'explainer', count: Number(val('[data-amt-ai-count]')), scenes: Number(val('[data-amt-ai-scenes]')), captions: !!el.querySelector('[data-amt-ai-caps]')?.checked, facts: String(s.aiFacts || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean) }
        : { mode: 'clip', count: Number(val('[data-amt-ai-count]')), seconds: Number(val('[data-amt-ai-secs]')), style: val('[data-amt-ai-style]') };
      const d = await runTool('ai', '/api/amb-media/ai-videos', payload, { okText: (r) => `اتضاف ${r.added.length} ${explainer ? 'فيديو شرح' : 'مقطع'} لقائمة الرفع${r.failed?.length ? ` (فشل ${r.failed.length}: ${r.failed[0].error})` : ''}.` });
      if (d) { await onAdded(); render(); }
    };
  }
  render();
}
