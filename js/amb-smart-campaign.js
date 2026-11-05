// AMB «Smart Campaign» — one journey per product, drawn like the reference product UI: a new-campaign flow (store → product), then a numbered stepper
// 1 المعلومات · 2 البحث · 3 صور الصفحة · 4 صفحة المنتج · 5 النشر على المتجر · 6 الكابشن · 7 الفيديوهات · 8 الكامبين.
// A journey is a page project (same data, same tools) plus its research / launch state. Nothing here publishes by itself: the store update and the Meta upload each need the owner's confirmation.
import { api } from './api-client.js';
import { mountProductPage } from './amb-product-page.js';
import { stepInfo, stepResearch, stepImages, stepPage, stepCaptions, B, esc, lines, assetUrl } from './amb-smart-steps.js';
import { stepPublish } from './amb-smart-publish.js';
import { stepCampaign } from './amb-smart-builder.js';

const STEP_KEYS = ['info', 'research', 'images', 'page', 'publish', 'captions', 'videos', 'campaign'];
const S = { view: 'home', list: null, id: null, step: 1, stores: null, storeId: null, eo: { q: '', results: null, loading: false }, styles: [], pack: [], newForm: { name: '', facts: '', supplierUrl: '', style: '' }, file: null, filePreview: null, creating: false, err: null };

async function pollJob(id, onTick) {
  for (let i = 0; i < 900; i++) { const j = await api.get(`/api/amb-media/jobs/${id}`); onTick?.(j); if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(j.status)) return j; await new Promise((r) => setTimeout(r, 2000)); }
  throw new Error('الشغل أخد وقت أطول من المتوقع.');
}

export async function mountSmartCampaign(panel, opts = {}) {
  const toast = opts.toast || (() => {});
  const root = panel;
  let C = null; let watchTimer = null;
  const stopWatch = () => { if (watchTimer) { clearInterval(watchTimer); watchTimer = null; } };

  async function loadList() { S.list = (await api.get(B)).projects; }
  async function loadRef() { const t = await api.get(`${B}/templates`); S.styles = t.styles || []; S.pack = t.pack || []; if (!S.newForm.style && S.styles[0]) S.newForm.style = S.styles[0].id; }

  // ---------------------------------------------------------------- the journey context every step shares
  function makeContext(id) {
    const c = {
      id, p: null, j: null, toast, msg: {}, busy: {}, barState: {}, styles: S.styles, pack: S.pack, edit: null, editCopy: false, editCap: null, pub: null, bs: null,
      say: (k, text, bad = false) => { c.msg[k] = text ? { text, bad } : null; },
      bar: (k) => (c.busy[k] ? `<div class="sx-job" style="padding:0"><div class="bar"><i style="width:${c.barState[k]?.pct || 3}%"></i></div><small>${esc(c.barState[k]?.message || 'شغال…')}</small></div>` : ''),
      go: (n) => { stopWatch(); S.step = Math.min(8, Math.max(1, n)); c.edit = null; c.editCopy = false; c.editCap = null; renderJourney(); },
      rerender: () => renderStep(),
      reload: async () => { c.p = await api.get(`${B}/${id}`); c.j = await api.get(`${B}/${id}/journey`); refreshChrome(); },
      watch: () => { if (watchTimer) return; watchTimer = setInterval(async () => { if (S.step !== 3 || !root.isConnected) return stopWatch(); try { await c.reload(); } catch { return; } renderStep(); if (!(c.p.images || []).some((i) => ['QUEUED', 'GENERATING'].includes(i.status))) stopWatch(); }, 3000); },
      runJob: async (key, start, label, o = {}) => {
        c.busy[key] = true; c.barState[key] = { pct: 3, message: label }; c.say(key, null); refreshChrome(); renderStep();
        try {
          const started = await start(); const job = started.job || started;
          const done = await pollJob(job.id, (jb) => { c.barState[key] = { pct: jb.progress, message: jb.message }; document.querySelectorAll('.sx-job .bar i').forEach((b) => { b.style.width = `${jb.progress}%`; }); if (o.watch) c.reload().then(() => { if (S.step === 3) renderStep(); }).catch(() => {}); });
          c.busy[key] = false; await c.reload();
          c.say(key, done.status === 'FAILED' ? (done.error?.message || 'فشل.') : '✅ خلص.', done.status === 'FAILED');
        } catch (e) { c.busy[key] = false; c.say(key, e.message, true); }
        refreshChrome(); renderStep();
      },
    };
    return c;
  }

  // ---------------------------------------------------------------- views
  function homeView() {
    return `<div class="sx-pagehead"><div><h1 class="sx-title">🧠 Smart Campaign</h1><div class="sx-sub">رحلة كاملة لكل منتج: من إيزي أوردر لحد الكامبين — البحث والصور والكابشنات والفيديوهات والرفع.</div></div><button class="sx-btn primary" data-s-new>➕ كامبين جديد</button></div>
      ${S.list === null ? '<div class="sx-card"><div class="sx-empty"><div class="sx-spin"></div></div></div>' : S.list.length ? `<div class="sx-pgrid">${S.list.map((x) => `<button type="button" class="sx-pcard" data-s-open="${esc(x.id)}"><div class="im">${x.hasRef ? `<img src="${B}/${esc(x.id)}/assets/ref" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode('📦'))">` : '📦'}</div><div class="nm">${esc(x.name)}</div><div class="mt"><span class="sx-badge ${x.published ? 'ok' : ''}">${x.published ? 'منشور' : 'مسودة'}</span><span>${x.images} صورة</span><span>${x.videos} فيديو</span>${x.eo ? '<span>🔗 إيزي أوردر</span>' : ''}</div></button>`).join('')}</div>` : '<div class="sx-card"><div class="sx-empty"><div class="ic">🧠</div><p>لسه مفيش رحلات</p><small>اضغط «كامبين جديد» واختار منتج من متجرك.</small></div></div>'}`;
  }

  function newView() {
    const stores = S.stores || [];
    const mine = (S.list || []).filter((x) => !S.storeId || !x.storeId || x.storeId === S.storeId);
    return `<div><button class="sx-crumb" data-s-home>→ الكامبينات</button><h1 class="sx-title">كامبين جديد</h1><div class="sx-sub">اختار المتجر، وبعدين المنتج، وبعدها الكريتيف والكامبين.</div></div>
      <div class="sx-card"><div class="sx-cbody"><h2 style="font-size:16px">1. اختيار المتجر</h2>${S.stores === null ? '<div class="sx-spin"></div>' : stores.length ? `<div class="sx-choices">${stores.map((s) => `<button type="button" class="sx-store ${S.storeId === s.id ? 'on' : ''}" data-s-store="${esc(s.id)}"><span class="ico">🏬</span><span style="flex:1"><b>${esc(s.name || s.id)}</b>${s.domain ? `<small>${esc(s.domain)}</small>` : ''}</span>${S.storeId === s.id ? '<span style="color:var(--sx-primary)">✓</span>' : ''}</button>`).join('')}</div>` : '<div class="sx-msg warn">مفيش متجر Easy Orders متربط.</div>'}</div></div>
      <div class="sx-card"><div class="sx-cbody"><h2 style="font-size:16px">2. اختيار المنتج</h2>
        <div class="sx-choices"><button type="button" class="sx-bigchoice" data-s-newprod><span class="ico">🆕</span><span><b>منتج جديد</b><small>ارفع صورة وأعمل صفحة منتج جديدة على المتجر</small></span></button><button type="button" class="sx-bigchoice" data-s-existing><span class="ico">📥</span><span><b>منتج موجود على المتجر</b><small>اسحب منتج منشور بالفعل واعمله كامبين</small></span></button></div>
        ${mine.length ? `<div><b style="font-size:13px">منتجات اتعملت في السيستم للمتجر ده</b></div><div class="sx-pgrid">${mine.map((x) => `<button type="button" class="sx-pcard" data-s-open="${esc(x.id)}"><div class="im">${x.hasRef ? `<img src="${B}/${esc(x.id)}/assets/ref" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode('📦'))">` : '📦'}</div><div class="nm">${esc(x.name)}</div></button>`).join('')}</div>` : ''}</div></div>`;
  }

  function existingView() {
    const r = S.eo.results;
    return `<div><button class="sx-crumb" data-s-back-new>→ كامبين جديد</button><h1 class="sx-title">منتج موجود على المتجر</h1><div class="sx-sub">اختار المنتج — بنسحب منه الاسم والسعر والوصف والصور والمخزون.</div></div>
      <div class="sx-card"><div class="sx-cbody"><label class="sx-f"><span>ابحث باسم المنتج</span><input data-s-eoq value="${esc(S.eo.q)}" placeholder="اكتب جزء من الاسم…"></label>${S.err ? `<div class="sx-msg bad">${esc(S.err)}</div>` : ''}
        ${S.eo.loading ? '<div class="sx-spin"></div>' : r ? (r.length ? `<div class="sx-pgrid">${r.map((x) => `<button type="button" class="sx-pcard" data-s-pick="${esc(x.id)}" data-s-pickstore="${esc(x.storeId)}" ${S.creating ? 'disabled' : ''}><div class="im">${x.thumb ? `<img src="${esc(x.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '📦'}</div><div class="nm">${esc(x.name)}</div><div class="mt"><span>${x.price != null ? esc(x.price) + ' ج' : ''}</span><span>${esc(x.storeName || '')}</span></div></button>`).join('')}</div>` : '<div class="sx-empty"><p>مفيش منتجات مطابقة.</p></div>') : ''}
        ${S.creating ? '<div class="sx-msg">⏳ بنسحب المنتج من إيزي أوردر…</div>' : ''}</div></div>`;
  }

  function newProductView() {
    const f = S.newForm; const store = (S.stores || []).find((s) => s.id === S.storeId);
    return `<div><button class="sx-crumb" data-s-back-new>→ كامبين جديد</button><h1 class="sx-title">منتج جديد</h1><div class="sx-sub">ارفع صورة واضحة للمنتج. السيستم هيعرفه، يبحث عنه، ويجهز خطة الصفحة لوحده.</div></div>
      <div class="sx-card"><div class="sx-cbody">
        <div class="sx-f"><span>صورة المنتج</span><label class="sx-drop">${S.filePreview ? `<img src="${esc(S.filePreview)}" alt="">` : '<div style="font-size:28px">🖼️</div><b>اضغط أو اسحب الصورة هنا</b><small>JPG أو PNG — خلفية بيضا أو صورة واضحة أحسن</small>'}<input type="file" accept="image/jpeg,image/png,image/webp" data-n-file hidden></label></div>
        <div class="sx-row"><label class="sx-f"><span>اسم المنتج</span><input data-n="name" value="${esc(f.name)}"><small>اختياري — لو سبته هيتسمّى «منتج جديد».</small></label><label class="sx-f"><span>المتجر</span><input value="${esc(store?.name || '—')}" disabled></label></div>
        <label class="sx-f"><span>معلومات عن المنتج (اختياري بس بيفرق جدًا)</span><textarea data-n="facts" rows="5" placeholder="بيعمل إيه؟ مميزاته؟ الخامة؟ المقاسات؟ اللي في العلبة؟ — اكتب اللي تعرفه، سطر لكل معلومة">${esc(f.facts)}</textarea><small>الذكاء الاصطناعي بيعتبر الكلام ده المرجع الأول للصور والكابشن.</small></label>
        <label class="sx-f"><span>لينك المورد أو منتج مشابه (اختياري)</span><input data-n="supplierUrl" dir="ltr" value="${esc(f.supplierUrl)}" placeholder="https://www.aliexpress.com/item/…"><small>علي إكسبرس، أمازون، أو أي صفحة فيها مواصفات المنتج.</small></label>
        <div class="sx-f"><span>ستايل صور الصفحة</span><div class="sx-styles">${S.styles.map((s) => `<button type="button" class="sx-style ${f.style === s.id ? 'on' : ''}" data-n-style="${esc(s.id)}"><span><b>${esc(s.label)}</b><small>${esc(s.hint || '')}</small></span><span class="sx-sw">${swatch(s.id)}</span></button>`).join('')}</div></div>
        ${S.err ? `<div class="sx-msg bad">${esc(S.err)}</div>` : ''}
        <button class="sx-btn primary" style="height:46px" data-n-go ${S.creating ? 'disabled' : ''}>${S.creating ? '⏳ بنجهّز…' : 'ابدأ البحث عن المنتج'}</button></div></div>`;
  }
  const swatch = (id) => ({ clean_blue: ['#0B2A5B', '#2F6FED', '#ffffff'], cream_gold: ['#14306B', '#C9A24B', '#F4ECDC'], auto: ['#334155', '#64748b', '#e2e8f0'] }[id] || ['#334155', '#64748b', '#e2e8f0']).map((c) => `<i style="background:${c}"></i>`).join('');

  function journeyView() {
    return `<div><button class="sx-crumb" data-s-home>→ المنتجات</button></div>
      <div class="sx-jhead"><div class="th" id="sxThumb"></div><div class="nm"><h1 id="sxName"></h1></div><span id="sxBadge"></span></div>
      <div class="sx-card sx-progress"><div class="sx-ptop"><span id="sxCount"></span><div class="sx-pbar" id="sxBar"></div></div><div class="sx-steps" id="sxSteps"></div></div>
      <div class="sx-jobs" id="sxJobs"></div>
      <div id="sxStep"></div>
      <div class="sx-foot" id="sxFoot"></div>`;
  }

  function refreshChrome() {
    if (S.view !== 'journey' || !C?.p) return;
    const p = C.p; const steps = C.j.steps; const done = steps.filter((s) => s.state === 'done' || s.state === 'store').length;
    const q = (id) => root.querySelector(id);
    if (q('#sxThumb')) q('#sxThumb').innerHTML = p.reference ? `<img src="${assetUrl(p, 'ref', p.reference.at ? Date.parse(p.reference.at) : 0)}" alt="">` : '📦';
    if (q('#sxName')) q('#sxName').textContent = p.name;
    if (q('#sxBadge')) q('#sxBadge').innerHTML = `<span class="sx-badge ${p.smart?.publish ? 'ok' : ''}">${p.smart?.publish ? 'منشور' : 'مسودة'}</span>${p.eo ? ' <span class="sx-badge pri">🔗 إيزي أوردر</span>' : ''}`;
    if (q('#sxCount')) q('#sxCount').textContent = `${done} من 8 خطوات`;
    if (q('#sxBar')) q('#sxBar').innerHTML = steps.map((s) => `<i class="${s.state === 'done' || s.state === 'store' ? 'on' : ''}"></i>`).join('');
    if (q('#sxSteps')) { q('#sxSteps').innerHTML = steps.map((s) => `<button type="button" class="sx-step ${s.state} ${S.step === s.n ? 'cur' : ''}" data-s-step="${s.n}" ${S.step === s.n ? 'aria-current="step"' : ''}><i>${s.state === 'done' ? '✓' : s.state === 'store' ? '🏪' : s.state === 'fail' ? '✕' : C.busy[STEP_KEYS[s.n - 1] === 'images' ? 'imgs' : STEP_KEYS[s.n - 1] === 'captions' ? 'copy' : STEP_KEYS[s.n - 1]] ? '⟳' : s.n}</i><span>${esc(s.label)}</span><small>${esc(s.sub || '')}</small></button>`).join(''); q('#sxSteps').querySelectorAll('[data-s-step]').forEach((b) => { b.onclick = () => C.go(Number(b.dataset.sStep)); }); }
    const jobs = Object.entries(C.busy).filter(([, v]) => v).map(([k]) => `<div class="sx-card sx-job"><div class="t"><span>${esc({ imgs: 'صور الصفحة', research: 'البحث', copy: 'الكلام والكابشن' }[k] || k)}</span><span>${esc(String(C.barState[k]?.pct ?? 0))}%</span></div><div class="bar"><i style="width:${C.barState[k]?.pct || 3}%"></i></div></div>`).join('');
    if (q('#sxJobs')) q('#sxJobs').innerHTML = jobs;
    const next = steps[S.step]; const prev = steps[S.step - 2]; const cur = steps[S.step - 1];
    if (q('#sxFoot')) { q('#sxFoot').innerHTML = `<button class="sx-btn ghost" data-s-prev ${prev ? '' : 'disabled'}>→ رجوع</button>${next ? `<button class="sx-btn ${cur.state === 'done' || cur.state === 'store' ? 'primary' : ''}" data-s-next>التالي: ${esc(next.label)} ←</button>` : '<span></span>'}`; const pv = q('[data-s-prev]'); if (pv) pv.onclick = () => C.go(S.step - 1); const nx = q('[data-s-next]'); if (nx) nx.onclick = () => C.go(S.step + 1); }
  }

  function renderStep() {
    const el = root.querySelector('#sxStep'); if (!el || !C?.p) return;
    const k = STEP_KEYS[S.step - 1];
    if (k === 'info') stepInfo(el, C);
    else if (k === 'research') stepResearch(el, C);
    else if (k === 'images') stepImages(el, C);
    else if (k === 'page') stepPage(el, C);
    else if (k === 'publish') stepPublish(el, C);
    else if (k === 'captions') stepCaptions(el, C);
    else if (k === 'videos') {
      el.innerHTML = `<div class="sx-sec"><h2>الفيديوهات</h2><p>فيديوهات المنتج من تيك توك وانستجرام ويوتيوب، وفيديوهات بالذكاء الاصطناعي.</p></div><div id="sxEmbed"></div>`;
      mountProductPage(el.querySelector('#sxEmbed'), { toast, embedded: true, projectId: C.id, sections: ['vids'] });
    } else if (k === 'campaign') stepCampaign(el, C);
  }

  async function renderJourney() {
    root.innerHTML = `<div class="sx">${journeyView()}</div>`;
    root.querySelectorAll('[data-s-home]').forEach((b) => { b.onclick = async () => { stopWatch(); S.view = 'home'; await loadList(); render(); }; });
    refreshChrome(); renderStep();
  }

  async function openJourney(id, step = null) {
    stopWatch(); S.id = id; S.view = 'journey'; C = makeContext(id);
    root.innerHTML = '<div class="sx"><div class="sx-card"><div class="sx-empty"><div class="sx-spin"></div></div></div></div>';
    await C.reload();
    if (step) S.step = step; else { const first = C.j.steps.find((s) => s.state === 'todo' || s.state === 'warn' || s.state === 'fail'); S.step = first ? first.n : 8; }
    await renderJourney();
  }

  // ---------------------------------------------------------------- home / new flows
  function wire() {
    const on = (sel, fn) => root.querySelectorAll(sel).forEach((n) => { n.onclick = (ev) => fn(n, ev); });
    on('[data-s-new]', async () => { S.view = 'new'; render(); if (S.stores === null) { try { const r = await api.get('/api/ai-media-buyer/launch/stores'); S.stores = (r.stores || []).filter((s) => s.enabled !== false); if (!S.storeId && S.stores[0]) S.storeId = S.stores[0].id; } catch { S.stores = []; } render(); } });
    on('[data-s-home]', async () => { S.view = 'home'; S.err = null; await loadList(); render(); });
    on('[data-s-back-new]', () => { S.view = 'new'; S.err = null; render(); });
    on('[data-s-open]', (n) => openJourney(n.dataset.sOpen).catch((e) => toast(e.message, 'error')));
    on('[data-s-store]', (n) => { S.storeId = n.dataset.sStore; render(); });
    on('[data-s-existing]', () => { S.view = 'existing'; S.err = null; S.eo.results = null; render(); searchEo(); });
    on('[data-s-newprod]', () => { S.view = 'newproduct'; S.err = null; render(); });
    const eoq = root.querySelector('[data-s-eoq]'); if (eoq) { let tm = null; eoq.oninput = () => { S.eo.q = eoq.value; clearTimeout(tm); tm = setTimeout(async () => { await searchEo(); const el2 = root.querySelector('[data-s-eoq]'); if (el2) { el2.focus(); el2.setSelectionRange(el2.value.length, el2.value.length); } }, 350); }; }
    on('[data-s-pick]', async (n) => {
      if (S.creating) return; S.creating = true; S.err = null; render();
      try { const p = await api.post(B, { eo: { id: n.dataset.sPick, storeId: n.dataset.sPickstore } }); S.creating = false; await openJourney(p.id, 1); }
      catch (e) { S.creating = false; S.err = e.message; render(); }
    });
    // new product form
    const keep = () => { root.querySelectorAll('[data-n]').forEach((i) => { S.newForm[i.dataset.n] = i.value; }); };
    root.querySelectorAll('[data-n]').forEach((i) => { i.oninput = keep; });
    on('[data-n-style]', (n) => { keep(); S.newForm.style = n.dataset.nStyle; render(); });
    const nf = root.querySelector('[data-n-file]'); if (nf) nf.onchange = () => { keep(); const f = nf.files?.[0]; if (!f) return; if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { S.err = 'لازم JPG أو PNG أو WebP.'; return render(); } if (f.size > 8 * 1024 * 1024) { S.err = 'الصورة أكبر من 8MB.'; return render(); } S.err = null; S.file = f; S.filePreview = URL.createObjectURL(f); render(); };
    on('[data-n-go]', async () => {
      keep(); if (!S.file) { S.err = 'ارفع صورة المنتج الأول.'; return render(); }
      S.creating = true; S.err = null; render();
      try {
        const f = S.newForm; const facts = lines(f.facts);
        const p = await api.post(B, { name: f.name.trim() || 'منتج جديد', facts, style: f.style || undefined });
        if (f.supplierUrl.trim()) await api.put(`${B}/${p.id}`, { supplierUrl: f.supplierUrl.trim() }).catch(() => {});
        const r = await fetch(`${B}/${p.id}/reference`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': S.file.type }, body: S.file }); if (!r.ok) throw new Error((await r.json().catch(() => null))?.message || `فشل رفع الصورة (${r.status})`);
        S.creating = false; S.file = null; S.filePreview = null; S.newForm = { name: '', facts: '', supplierUrl: '', style: f.style };
        await openJourney(p.id, 2);
        if (facts.length) C.runJob('research', () => api.post(`${B}/${p.id}/research`, {}), 'بحلّل المنتج والجمهور…');
      } catch (e) { S.creating = false; S.err = e.message; render(); }
    });
  }

  async function searchEo() {
    S.eo.loading = true; render();
    try { const all = (await api.get(`${B}/eo-products?q=${encodeURIComponent(S.eo.q)}`)).products || []; S.eo.results = S.storeId ? all.filter((x) => !x.storeId || x.storeId === S.storeId) : all; } catch (e) { S.eo.results = []; S.err = e.message; }
    S.eo.loading = false; render();
  }

  function render() {
    if (S.view === 'journey') return;
    const body = S.view === 'new' ? newView() : S.view === 'existing' ? existingView() : S.view === 'newproduct' ? newProductView() : homeView();
    root.innerHTML = `<div class="sx">${body}</div>`; wire();
  }

  // ---------------------------------------------------------------- boot
  root.innerHTML = '<div class="sx"><div class="sx-card"><div class="sx-empty"><div class="sx-spin"></div></div></div></div>';
  try { await Promise.all([loadList(), loadRef()]); } catch (e) { root.innerHTML = `<div class="sx"><div class="sx-msg bad">تعذّر التحميل: ${esc(e.message)}</div></div>`; return; }
  if (S.view === 'journey' && S.id) { try { await openJourney(S.id, S.step); return; } catch { S.view = 'home'; } }
  if (S.view !== 'home' && S.view !== 'new' && S.view !== 'existing' && S.view !== 'newproduct') S.view = 'home';
  render();
}
