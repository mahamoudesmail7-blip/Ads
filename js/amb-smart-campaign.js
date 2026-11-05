// AMB «Smart Campaign» — one journey per product: product (Easy Orders) → research & audience → images → captions → videos → publish to the store → review → campaign.
// A journey is a page project (same data, same tools) plus its research / launch state. Steps 1, 3, 4, 5 embed the product-page tools; 2, 6, 7 are new; 8 is the campaign builder.
// Nothing here publishes by itself: the store update and the Meta upload each need the owner's explicit confirmation.
import { api } from './api-client.js';
import { mountProductPage } from './amb-product-page.js';
import { mountSmartBuilder } from './amb-smart-builder.js';
import { mountSmartPublish } from './amb-smart-publish.js';

const B = '/api/amb-media/pages';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STEP_HINT = { 1: 'بيانات المنتج من إيزي أوردر وصورته', 2: 'تحليل الجمهور والزوايا من معلومات المنتج الحقيقية', 3: 'صور الصفحة بنظام تصميم واحد', 4: 'محتوى الصفحة وكابشنات الإعلان', 5: 'فيديوهات من البحث أو بالذكاء الاصطناعي', 6: 'تحديث وصف وصور المنتج على إيزي أوردر (بموافقتك)', 7: 'قائمة فحص قبل الكامبين', 8: 'إنشاء الكامبين ورفعه على ميتا (متوقف لحد ما تشغّله)' };
const STATE_ICON = { done: '✓', todo: '', warn: '⟳', fail: '✕' };

const S = { view: 'list', list: null, id: null, journey: null, project: null, step: 1, busy: {}, msg: {}, bar: {} };

async function pollJob(id, onTick) {
  for (let i = 0; i < 900; i++) {
    const j = await api.get(`/api/amb-media/jobs/${id}`);
    onTick?.(j);
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('الشغل أخد وقت أطول من المتوقع.');
}

export async function mountSmartCampaign(panel, opts = {}) {
  const toast = opts.toast || (() => {});
  const root = panel;
  const say = (k, text, bad = false) => { S.msg[k] = text ? { text, bad } : null; };
  const note = (k) => (S.msg[k] ? `<div class="pgp-msg ${S.msg[k].bad ? 'bad' : 'good'}">${esc(S.msg[k].text)}</div>` : '');
  const bar = (k) => (S.busy[k] ? `<div class="amt-prog"><i style="width:${S.bar[k]?.pct || 3}%"></i></div><small class="amt-dim">${esc(S.bar[k]?.message || 'شغال…')}</small>` : '');

  async function loadList() { S.list = (await api.get(B)).projects; }
  async function loadJourney() { S.journey = await api.get(`${B}/${S.id}/journey`); S.project = await api.get(`${B}/${S.id}`); }
  async function openJourney(id, step = null) {
    S.id = id; S.view = 'journey'; S.msg = {};
    await loadJourney();
    if (step) S.step = step; else { const first = S.journey.steps.find((s) => s.state !== 'done' && s.key !== 'publish'); S.step = first ? first.n : 7; }
    render();
  }

  // -------------------------------------------------------------- views
  function listView() {
    return `<div class="sc-head"><div><h3>🧠 Smart Campaign</h3><small class="amt-dim">رحلة كاملة لكل منتج: من إيزي أوردر لحد الكامبين — البحث والصور والكابشنات والفيديوهات والمراجعة والرفع.</small></div><button class="amb-btn primary" data-sc-new>➕ كامبين ذكي جديد</button></div>
      ${S.list === null ? '<div class="amb-loading">جارِ التحميل…</div>' : S.list.length ? `<div class="sc-list">${S.list.map((p) => `<button type="button" class="sc-card" data-sc-open="${esc(p.id)}"><b>${esc(p.name)}</b><span>${p.images} صورة · ${p.videos} فيديو${p.eo ? ' · 🔗 إيزي أوردر' : ''}</span><small>افتح الرحلة ›</small></button>`).join('')}</div>` : '<div class="pgp-empty">لسه مفيش رحلات. اضغط «كامبين ذكي جديد» واختار منتج من إيزي أوردر.</div>'}`;
  }

  function stepBar() {
    return `<div class="sc-steps" role="list">${S.journey.steps.map((s) => `<button type="button" role="listitem" class="sc-step ${s.state} ${S.step === s.n ? 'cur' : ''}" data-sc-step="${s.n}" ${S.step === s.n ? 'aria-current="step"' : ''}><i>${STATE_ICON[s.state] || s.n}</i><span>${esc(s.label)}</span></button>`).join('')}</div>`;
  }

  function researchView() {
    const r = S.journey.research;
    const chips = (arr, cls = '') => (arr || []).map((x) => `<span class="sc-chip ${cls}">${esc(x)}</span>`).join('');
    return `<div class="lp-card pgp-sec"><div class="sc-rhead"><div><b>🔎 البحث والجمهور</b><small class="amt-dim">بيحلّل المنتج من المعلومات الحقيقية وصورته بس — مفيش مواصفات بتتخترع.</small></div>
      <button class="amb-btn primary" data-sc-research ${S.busy.research ? 'disabled' : ''}>${r ? '🔄 أعد التحليل' : '🔎 حلّل المنتج والجمهور'}</button></div>${bar('research')}${note('research')}
      ${r ? `<div class="sc-research">
        <p class="sc-sum">${esc(r.summary)}</p>
        <div class="sc-grid">
          <section><b>🎯 الجمهور</b><p>${esc(r.audience.description)}</p><div class="sc-chips"><span class="sc-chip">${{ ALL: 'الكل', MALE: 'رجالة', FEMALE: 'ستات' }[r.audience.gender] || 'الكل'}</span><span class="sc-chip">${r.audience.ageMin}–${r.audience.ageMax} سنة</span>${chips(r.audience.interests, 'int')}</div></section>
          <section><b>💡 الفوايد</b><ul>${(r.benefits || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>
          <section><b>😣 المشاكل اللي بيحلها</b><ul>${(r.painPoints || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>
          <section><b>🤔 اعتراضات محتملة</b><ul>${(r.objections || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>
          <section class="sc-wide"><b>🧲 زوايا الإعلان</b>${(r.angles || []).map((a) => `<div class="sc-angle"><em>${esc(a.name)}</em><span>${esc(a.hook)}</span></div>`).join('')}</section>
          <section class="sc-wide sc-caution"><b>⚠️ ادعاءات تتجنبها (سياسة ميتا)</b><ul>${(r.policyCautions || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>
        </div>
        <small class="amt-dim">الجمهور ده بيبقى نقطة البداية في استهداف الكامبين (الخطوة 8) وإنت اللي بتقرر.</small></div>` : '<div class="pgp-empty">لسه ما اتعملش تحليل. اتأكد إن معلومات المنتج (الخطوة 1) مكتوبة، وبعدين اضغط الزرار.</div>'}</div>`;
  }

  function reviewView() {
    const r = S.journey.readiness;
    const icon = { ok: '✅', warn: '⚠️', fail: '⛔' };
    return `<div class="lp-card pgp-sec"><div class="sc-rhead"><div><b>✔️ المراجعة قبل الكامبين</b><small class="amt-dim">${r.ready ? 'مفيش حاجة بتمنع الكامبين' : 'فيه حاجات لازم تتصلح الأول'}${r.warnings ? ` · ${r.warnings} تنبيه` : ''}</small></div></div>
      <div class="sc-check">${r.items.map((i) => `<div class="sc-ci ${i.level}"><span>${icon[i.level]}</span><div><b>${esc(i.label)}</b><small>${esc(i.detail || '')}</small></div>${i.level !== 'ok' ? `<button class="amb-btn sm" data-sc-step="${i.step}">روح للخطوة ${i.step}</button>` : ''}</div>`).join('')}</div>
      <div class="pgp-msg ${r.ready ? 'good' : 'bad'}">${r.ready ? '✅ جاهز للكامبين — كمّل للخطوة 8.' : `⛔ مش جاهز: ${esc(r.blockers.join(' · '))}`}</div></div>`;
  }

  function journeyView() {
    const p = S.project;
    const nav = `<div class="sc-nav"><button class="amb-btn ghost" data-sc-prev ${S.step <= 1 ? 'disabled' : ''}>← السابق</button><span class="amt-dim">خطوة ${S.step} من 8 — ${esc(STEP_HINT[S.step])}</span><button class="amb-btn primary" data-sc-next ${S.step >= 8 ? 'disabled' : ''}>التالي →</button></div>`;
    return `<div class="sc-head"><div><h3>🧠 ${esc(p.name)}</h3><small class="amt-dim">${p.eo ? `🔗 ${esc(p.eo.name)} · ` : ''}الرحلة بالترتيب — كل خطوة بتتحفظ لوحدها</small></div><button class="amb-btn ghost" data-sc-back>رجوع للرحلات</button></div>
      ${stepBar()}${nav}<div class="sc-body" id="scBody"></div>${nav.replace(/data-sc-prev/g, 'data-sc-prev2').replace(/data-sc-next/g, 'data-sc-next2')}`;
  }

  function render() {
    if (S.view === 'new') { root.innerHTML = '<div class="sc-wrap"><div class="sc-head"><h3>➕ كامبين ذكي جديد</h3></div><div id="scBody"></div></div>'; mountNew(); return; }
    root.innerHTML = `<div class="sc-wrap">${S.view === 'journey' && S.journey ? journeyView() : listView()}</div>`;
    wire();
    if (S.view === 'journey') mountStep();
  }

  function mountNew() {
    mountProductPage(root.querySelector('#scBody'), { toast, embedded: true, start: 'new', onBack: async () => { S.view = 'list'; await loadList(); render(); }, onCreated: (p) => { toast('اتعملت الرحلة — كمّل خطوة خطوة.', 'success'); openJourney(p.id, 1).catch((e) => toast(e.message, 'error')); } });
  }

  function mountStep() {
    const body = root.querySelector('#scBody'); if (!body) return;
    const id = S.id; const embed = (sections) => mountProductPage(body, { toast, embedded: true, projectId: id, sections });
    if (S.step === 1) embed(['data']);
    else if (S.step === 2) { body.innerHTML = researchView(); wireStepBody(); }
    else if (S.step === 3) embed(['imgs']);
    else if (S.step === 4) {
      body.innerHTML = `<div class="lp-card pgp-sec"><div class="sc-rhead"><div><b>✍️ المحتوى والكابشنات</b><small class="amt-dim">بيكتب عنوان الصفحة ووصفها وكابشنات الإعلان من المعلومات الحقيقية (والبحث لو اتعمل).</small></div><button class="amb-btn primary" data-sc-gencopy ${S.busy.copy ? 'disabled' : ''}>✍️ اكتب المحتوى بالـ AI</button></div>${bar('copy')}${note('copy')}</div><div id="scEmbed"></div>`;
      mountProductPage(body.querySelector('#scEmbed'), { toast, embedded: true, projectId: id, sections: ['copy', 'caps'] }); wireStepBody();
    } else if (S.step === 5) embed(['vids']);
    else if (S.step === 6) mountSmartPublish(body, { toast, projectId: id, onChange: async () => { await loadJourney(); } });
    else if (S.step === 7) { body.innerHTML = reviewView(); wireStepBody(); }
    else if (S.step === 8) mountSmartBuilder(body, { toast, projectId: id, journey: S.journey, project: S.project, onChange: async () => { await loadJourney(); const bar2 = root.querySelector('.sc-steps'); if (bar2) bar2.outerHTML = stepBar(); wireStepBar(); } });
  }

  async function runJob(key, start, label) {
    S.busy[key] = true; S.bar[key] = { pct: 3, message: label }; say(key, null); mountStep();
    try {
      const job = await start();
      const done = await pollJob(job.job?.id || job.id, (j) => { S.bar[key] = { pct: j.progress, message: j.message }; const b = root.querySelector('.amt-prog i'); if (b) b.style.width = `${j.progress}%`; });
      S.busy[key] = false;
      if (done.status === 'FAILED') { say(key, done.error?.message || 'فشل.', true); await loadJourney(); mountStep(); return; }
      await loadJourney(); const barEl = root.querySelector('.sc-steps'); if (barEl) { barEl.outerHTML = stepBar(); wireStepBar(); }
      say(key, '✅ خلص.'); mountStep();
    } catch (e) { S.busy[key] = false; say(key, e.message, true); mountStep(); }
  }

  function wireStepBar() { root.querySelectorAll('[data-sc-step]').forEach((b) => { b.onclick = () => { S.step = Number(b.dataset.scStep); render(); }; }); }
  function wireStepBody() {
    const r = root.querySelector('[data-sc-research]'); if (r) r.onclick = () => runJob('research', () => api.post(`${B}/${S.id}/research`, {}), 'بحلّل المنتج والجمهور…');
    const g = root.querySelector('[data-sc-gencopy]'); if (g) g.onclick = () => runJob('copy', () => api.post(`${B}/${S.id}/copy`, {}), 'بكتب المحتوى والكابشنات…');
    root.querySelectorAll('#scBody [data-sc-step]').forEach((b) => { b.onclick = () => { S.step = Number(b.dataset.scStep); render(); }; });
  }
  function wire() {
    const on = (sel, fn) => root.querySelectorAll(sel).forEach((el) => { el.onclick = (ev) => fn(el, ev); });
    on('[data-sc-new]', () => { S.view = 'new'; render(); });
    on('[data-sc-open]', (el) => openJourney(el.dataset.scOpen).catch((e) => toast(e.message, 'error')));
    on('[data-sc-back]', async () => { S.view = 'list'; S.id = null; await loadList(); render(); });
    wireStepBar();
    const go = (d) => async () => { S.step = Math.min(8, Math.max(1, S.step + d)); await loadJourney().catch(() => {}); render(); };
    on('[data-sc-prev],[data-sc-prev2]', go(-1)); on('[data-sc-next],[data-sc-next2]', go(1));
  }

  // -------------------------------------------------------------- boot
  root.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  try {
    if (S.view === 'journey' && S.id) { await loadJourney(); }
    else { S.view = 'list'; await loadList(); }
  } catch (e) { root.innerHTML = `<div class="pgp-empty">تعذّر التحميل: ${esc(e.message)}</div>`; return; }
  render();
}
