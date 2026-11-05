// AMB «صفحة المنتج» — build a product page from A to Z: product data (optionally from Easy Orders) → AI copy → a chosen set of designed images
// (Arabic headline rendered inside each image) → videos → a live preview in page order → ZIP + copy text to publish.
// Long work runs as server jobs; this file starts them and polls. Nothing here publishes to a store or to Meta.
import { api } from './api-client.js';

const B = '/api/amb-media/pages';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const asset = (p, id, v = 0) => `${B}/${p.id}/assets/${id}?v=${v}`;
const SRC = { LENS: 'من بحث الصورة', TIKTOK: 'تيك توك', INSTAGRAM: 'ريلز', META_ADS: 'إعلان شغّال', MANUAL: 'لينك منك', YOUTUBE: 'يوتيوب', LINK: 'لينك' };
const STATUS_AR = { QUEUED: 'في الانتظار', GENERATING: 'بيتولّد…', FAILED: 'فشل' };

const S = { open: {}, list: null, cur: null, tpl: [], eo: { q: '', results: null }, draft: [], form: { name: '', price: '', oldPrice: '', facts: '', eo: null }, msg: {}, busy: {}, bar: {}, find: null, picks: new Set(), editing: null, view: 'list', poll: null };

function toastOf(opts) { return opts?.toast || (() => {}); }

async function pollJob(id, onTick) {
  for (let i = 0; i < 1200; i++) {
    const j = await api.get(`/api/amb-media/jobs/${id}`);
    onTick?.(j);
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('الشغل أخد وقت أطول من المتوقع.');
}

export async function mountProductPage(panel, opts = {}) {
  const toast = toastOf(opts);
  // embedded use (Smart Campaign): show only some sections of ONE project, without the page chrome; `start:'new'` opens the create form and reports the new project instead of opening it
  S.only = Array.isArray(opts.sections) ? new Set(opts.sections) : null; S.embedded = !!opts.embedded; S.onCreated = typeof opts.onCreated === 'function' ? opts.onCreated : null;
  if (opts.start === 'new') { S.view = 'new'; S.form = { name: '', price: '', oldPrice: '', facts: '', eo: null }; S.eo = { q: '', results: null }; } else if (opts.projectId) { S.view = 'project'; } else if (S.embedded) { S.view = 'list'; }
  const root = panel;
  if (S.poll) { clearInterval(S.poll); S.poll = null; }

  const note = (k) => (S.msg[k] ? `<div class="pgp-msg ${S.msg[k].bad ? 'bad' : 'good'}">${esc(S.msg[k].text)}</div>` : '');
  const bar = (k) => (S.busy[k] ? `<div class="amt-prog"><i style="width:${S.bar[k]?.pct || 3}%"></i></div><small class="amt-dim">${esc(S.bar[k]?.message || 'شغال…')}</small>` : '');
  const say = (k, text, bad = false) => { S.msg[k] = text ? { text, bad } : null; };

  async function loadTemplates() { if (!S.tpl.length) { const r = await api.get(`${B}/templates`); S.tpl = r.templates; S.styles = r.styles || []; S.pack = r.pack || []; } }
  async function loadList() { S.list = (await api.get(B)).projects; }
  async function openProject(id) { S.cur = await api.get(`${B}/${id}`); S.view = 'project'; S.draft = []; S.find = null; S.picks.clear(); S.editing = null; render(); startWatch(); }
  async function refresh() { if (S.cur) { S.cur = await api.get(`${B}/${S.cur.id}`); } }

  // while an image is queued/generating, re-read the project so finished images appear one by one
  function startWatch() {
    if (S.poll) clearInterval(S.poll);
    S.poll = setInterval(async () => {
      if (!S.cur || S.view !== 'project' || !document.body.contains(root)) { clearInterval(S.poll); S.poll = null; return; }
      if (!S.cur.images.some((i) => ['QUEUED', 'GENERATING'].includes(i.status))) return;
      try { await refresh(); const g = root.querySelector('[data-pgp-gallery]'); if (g) { g.innerHTML = galleryHtml(); wireGallery(); } const pv = root.querySelector('[data-pgp-preview]'); if (pv) pv.innerHTML = previewHtml(); } catch { /* next tick */ }
    }, 3000);
  }

  // ---------------------------------------------------------------- views
  function listView() {
    return `<div class="pgp-head"><div><h3>🧾 صفحات المنتجات</h3><small class="amt-dim">اعمل صفحة منتج كاملة: محتوى + صور مصمّمة + فيديوهات، وتنزّلها جاهزة لإيزي أوردر</small></div><button class="amb-btn primary" data-pgp-new>➕ صفحة جديدة</button></div>
      ${S.list === null ? '<div class="amb-loading">جارِ التحميل…</div>' : S.list.length ? `<div class="pgp-list">${S.list.map((p) => `<button type="button" class="pgp-card" data-pgp-open="${p.id}"><b>${esc(p.name)}</b><small>${p.images} صورة · ${p.videos} فيديو · ${p.hasCopy ? 'فيه محتوى' : 'من غير محتوى'}</small><small class="amt-dim">${esc((p.updatedAt || '').slice(0, 10))}</small></button>`).join('')}</div>` : '<div class="pgp-empty">لسه ما عملتش أي صفحة. اضغط «صفحة جديدة».</div>'}`;
  }

  /** What Easy Orders gave us for the picked product, before the page is even created. */
  function eoSummary(d) {
    const stock = d.trackStock ? (d.quantity > 0 ? `متاح ${d.quantity}` : '⛔ المخزون خلص') : 'المخزون مش متتبّع';
    return `<div class="pgp-eosum"><div class="pgp-eosum-h"><b>✅ اتجاب من إيزي أوردر: ${esc(d.name)}</b><small class="amt-dim">راجع أو عدّل أي حاجة تحت قبل ما تنشئ الصفحة</small></div>
      <div class="pgp-chips">${d.price != null ? `<span>💰 ${esc(d.price)} ج${d.oldPrice ? ` <s>${esc(d.oldPrice)}</s>` : ''}</span>` : ''}<span>📦 ${esc(stock)}</span>${d.freeShipping ? '<span>🚚 شحن مجاني</span>' : ''}${(d.categories || []).map((c) => `<span>🏷️ ${esc(c)}</span>`).join('')}<span>🖼️ ${d.images.length} صورة</span><span>📝 ${d.facts.length} معلومة من الوصف</span></div>
      ${d.images.length ? `<div class="pgp-strip">${d.images.slice(0, 8).map((u) => `<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer">`).join('')}</div>` : ''}</div>`;
  }
  /** The linked Easy Orders product on an existing page: stock / categories / pictures + the refresh buttons. */
  function eoCard(p) {
    const e = p.eo; if (!e) return '';
    const stock = e.trackStock ? (e.quantity > 0 ? `متاح ${e.quantity}` : '⛔ المخزون خلص') : 'المخزون مش متتبّع';
    return `<div class="pgp-eocard"><div class="pgp-eosum-h"><b>🔗 مربوط بمنتج إيزي أوردر: ${esc(e.name)}</b><small class="amt-dim">آخر تحديث ${esc(String(e.syncedAt || '').slice(0, 16).replace('T', ' '))}</small></div>
      <div class="pgp-chips"><span>📦 ${esc(stock)}</span>${e.freeShipping ? '<span>🚚 شحن مجاني</span>' : ''}${(e.categories || []).map((c) => `<span>🏷️ ${esc(c)}</span>`).join('')}</div>
      ${(e.images || []).length ? `<small class="amt-dim">صور المنتج في إيزي أوردر — اضغط على صورة تستخدمها كصورة المنتج للصفحة دي:</small><div class="pgp-strip">${e.images.map((u, i) => `<button type="button" class="pgp-eoimg" data-pgp-eo-img="${i}" title="استخدمها كصورة المنتج"><img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`).join('')}</div>` : ''}
      <div class="pgp-actions"><button class="amb-btn sm" data-pgp-eo-sync="info" ${S.busy.eosync ? 'disabled' : ''}>🔄 حدّث المخزون والتصنيف والصور</button><button class="amb-btn sm" data-pgp-eo-sync="all" ${S.busy.eosync ? 'disabled' : ''}>🔄 حدّث الاسم والسعر والمميزات كمان (بيستبدل اللي كتبته)</button></div>${note('eosync')}</div>`;
  }
  /** Ad captions written together with the page copy (same facts, same claims scan). */
  function capsSection(p) {
    const caps = p.copy?.captions || [];
    if (!caps.length) return '<div class="pgp-empty">لسه مفيش كابشنات. اضغط «اكتب المحتوى بالـ AI» في القسم الأول — بيكتب 3 كابشنات إعلان مع المحتوى.</div>';
    return `${caps.map((c, i) => `<div class="pgp-cap" data-pgp-cap="${i}"><label class="pgp-f"><span>كابشن ${i + 1}</span><textarea data-pgp-cap-p rows="4">${esc(c.primary)}</textarea></label>
      <label class="pgp-f"><span>العنوان</span><input data-pgp-cap-h value="${esc(c.headline)}"></label>
      <div class="pgp-actions"><button type="button" class="amb-btn sm" data-pgp-cap-copy="${i}">📋 انسخ</button></div></div>`).join('')}
      <div class="pgp-actions"><button class="amb-btn primary" data-pgp-savecaps>حفظ الكابشنات</button></div>${note('savecaps')}`;
  }

  function newView() {
    const f = S.form;
    return `<div class="pgp-head"><h3>➕ صفحة منتج جديدة</h3><button class="amb-btn ghost" data-pgp-back>رجوع</button></div>
      <section class="lp-card pgp-sec">
        <label class="pgp-f"><span>جيب من إيزي أوردر (اختياري)</span><input data-pgp-eo-q placeholder="ابحث باسم المنتج…" value="${esc(S.eo.q)}"></label>
        ${S.eo.results ? `<div class="pgp-eo">${S.eo.results.length ? S.eo.results.map((p) => `<button type="button" class="pgp-eo-item ${f.eo?.id === p.id ? 'on' : ''}" data-pgp-eo-pick="${esc(p.id)}">${p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<i>📦</i>'}<span>${esc(p.name)}</span><small>${p.storeName ? esc(p.storeName) + ' · ' : ''}${p.price != null ? esc(p.price) + ' ج' : ''}</small></button>`).join('') : '<small class="amt-dim">مفيش منتجات مطابقة.</small>'}</div>` : ''}
        ${f.eo ? (S.eoLoading ? '<div class="pgp-msg good">⏳ بجيب بيانات المنتج من إيزي أوردر…</div>' : f.eoDetail ? eoSummary(f.eoDetail) : '') : ''}
        <label class="pgp-f"><span>اسم المنتج</span><input data-pgp-name value="${esc(f.name)}"></label>
        <div class="pgp-row"><label class="pgp-f"><span>السعر (ج)</span><input data-pgp-price inputmode="decimal" value="${esc(f.price)}"></label><label class="pgp-f"><span>السعر قبل الخصم (ج)</span><input data-pgp-old inputmode="decimal" value="${esc(f.oldPrice)}"></label></div>
        <label class="pgp-f"><span>معلومات ومميزات حقيقية عن المنتج (سطر لكل معلومة) — الـ AI مش هيكتب غير اللي هنا</span><textarea data-pgp-facts rows="6" placeholder="بلوتوث&#10;راديو FM / AM / SW&#10;بطارية قابلة للشحن">${esc(f.facts)}</textarea></label>
        <div class="pgp-actions"><button class="amb-btn primary" data-pgp-create ${S.busy.create ? 'disabled' : ''}>إنشاء الصفحة</button></div>${note('create')}
      </section>`;
  }

  // a collapsible section that keeps its open/closed state across re-renders
  const det = (k, dflt, title, body) => `<details class="lp-card pgp-sec" data-sec="${k}" ${(S.open[k] ?? dflt) ? 'open' : ''}><summary>${title}</summary>${body}</details>`;

  function projectView() {
    const p = S.cur; const c = p.copy || {};
    if (S.only) { const sec = { data: ['① بيانات المنتج وصورته', () => dataSection(p)], copy: ['المحتوى (العنوان والوصف والمميزات)', () => copySection(p, c)], caps: ['كابشنات الإعلان', () => capsSection(p)], imgs: ['صور الصفحة', () => `<div data-pgp-imgsec>${imagesSection(p)}</div>`], vids: ['الفيديوهات', () => videosSection(p)] };
      return `<div class="pgp-main">${[...S.only].filter((k) => sec[k]).map((k) => det(k, true, sec[k][0], sec[k][1]())).join('')}</div>`; }
    return `<div class="pgp-head"><div><h3>🧾 ${esc(p.name)}</h3><small class="amt-dim">${p.eo ? 'مربوط بإيزي أوردر · ' : ''}الصفحة بالترتيب: المحتوى ثم الصور ثم الفيديوهات</small></div><div class="pgp-actions"><button class="amb-btn ghost" data-pgp-back>رجوع</button><button class="amb-btn ghost" data-pgp-del>مسح الصفحة</button></div></div>
    <div class="pgp-cols">
      <div class="pgp-main">
        ${det('data', true, '① بيانات المنتج وصورته', dataSection(p))}
        ${det('copy', !!p.copy, '② المحتوى (العنوان والوصف والمميزات)', copySection(p, c))}
        ${det('caps', !!p.copy?.captions?.length, '③ كابشنات الإعلان', capsSection(p))}
        ${det('imgs', true, '④ صور الصفحة', `<div data-pgp-imgsec>${imagesSection(p)}</div>`)}
        ${det('vids', false, '⑤ الفيديوهات', videosSection(p))}
      </div>
      <aside class="pgp-side"><div class="lp-card pgp-sec"><b>👁️ شكل الصفحة بالترتيب</b><div data-pgp-preview>${previewHtml()}</div>
        <div class="pgp-actions"><button class="amb-btn primary" data-pgp-zip>⬇️ نزّل الصفحة (ZIP)</button><button class="amb-btn" data-pgp-copytxt>📋 انسخ النص</button></div>${note('export')}</div></aside>
    </div>`;
  }

  function dataSection(p) {
    return `${eoCard(p)}<div class="pgp-row"><label class="pgp-f"><span>اسم المنتج</span><input data-pgp-pname value="${esc(p.name)}"></label><label class="pgp-f"><span>السعر</span><input data-pgp-pprice inputmode="decimal" value="${esc(p.price ?? '')}"></label><label class="pgp-f"><span>قبل الخصم</span><input data-pgp-pold inputmode="decimal" value="${esc(p.oldPrice ?? '')}"></label></div>
      <label class="pgp-f"><span>معلومات ومميزات حقيقية (سطر لكل معلومة)</span><textarea data-pgp-pfacts rows="5">${esc((p.facts || []).join('\n'))}</textarea></label>
      <div class="pgp-ref">${p.reference ? `<img src="${asset(p, 'ref', p.reference.at ? Date.parse(p.reference.at) : 0)}" alt="صورة المنتج">` : '<div class="pgp-noimg">مفيش صورة للمنتج</div>'}
        <div><b>صورة المنتج الحقيقية</b><small class="amt-dim">كل الصور والفيديوهات بتبدأ منها وبتحافظ على شكل المنتج. JPG أو PNG حتى 8MB.</small>
        <div class="pgp-actions"><button class="amb-btn sm" data-pgp-ref>${p.reference ? 'غيّر الصورة' : 'ارفع صورة المنتج'}</button><input type="file" accept="image/jpeg,image/png,image/webp" data-pgp-ref-in hidden></div>${note('ref')}</div></div>
      <div class="pgp-actions"><button class="amb-btn" data-pgp-savedata>حفظ البيانات</button><button class="amb-btn primary" data-pgp-gencopy ${S.busy.copy ? 'disabled' : ''}>✍️ اكتب المحتوى بالـ AI</button></div>${bar('copy')}${note('data')}${note('copy')}`;
  }

  function copySection(p, c) {
    if (!p.copy) return '<div class="pgp-empty">لسه مفيش محتوى. اضغط «اكتب المحتوى بالـ AI» في القسم الأول (بيقرأ المعلومات والصورة).</div>';
    const issues = (c.claimIssues || []).map((i) => `<li><b>${esc(i.field)}</b>: ${esc(i.text)} — ${esc(i.reason)}</li>`).join('');
    return `${issues ? `<div class="pgp-warn"><b>⚠️ ادعاءات محتاجة مراجعة قبل النشر</b><ul>${issues}</ul></div>` : ''}
      <label class="pgp-f"><span>العنوان</span><input data-pgp-c-title value="${esc(c.title)}"></label>
      <label class="pgp-f"><span>جملة تحت العنوان</span><input data-pgp-c-sub value="${esc(c.subtitle)}"></label>
      <label class="pgp-f"><span>الوصف (فقرة لكل سطر)</span><textarea data-pgp-c-par rows="5">${esc((c.paragraphs || []).join('\n'))}</textarea></label>
      <label class="pgp-f"><span>المميزات (سطر لكل ميزة — بتظهر على أيقونات الصور)</span><textarea data-pgp-c-feat rows="6">${esc((c.features || []).join('\n'))}</textarea></label>
      <label class="pgp-f"><span>خطوات الاستخدام / التركيب (سطر لكل خطوة: العنوان | الشرح)</span><textarea data-pgp-c-steps rows="3">${esc((c.steps || []).map((s) => `${s.title} | ${s.text}`).join('\n'))}</textarea></label>
      <label class="pgp-f"><span>نص زرار الطلب</span><input data-pgp-c-cta value="${esc(c.cta)}"></label>
      <div class="pgp-actions"><button class="amb-btn primary" data-pgp-savecopy>حفظ المحتوى</button></div>${note('savecopy')}`;
  }

  function draftRow(d, i) {
    const t = S.tpl.find((x) => x.id === d.template) || { fields: [], label: d.template };
    return `<div class="pgp-draft" data-pgp-draft="${i}"><div class="pgp-dh"><b>${esc(t.label)}</b><button type="button" class="amb-btn sm ghost" data-pgp-draft-del="${i}">✕</button></div>
      ${t.fields.includes('headline') ? `<label class="pgp-f"><span>العنوان على الصورة (سيبه فاضي = من المحتوى)</span><input data-d="headline" value="${esc(d.headline || '')}"></label>` : ''}
      ${t.fields.includes('subtitle') ? `<label class="pgp-f"><span>الجملة الفرعية</span><input data-d="subtitle" value="${esc(d.subtitle || '')}"></label>` : ''}
      ${t.fields.includes('labels') ? `<label class="pgp-f"><span>أيقونات المميزات (سطر لكل ميزة، سيبها فاضية = من المميزات)</span><textarea data-d="labels" rows="3">${esc((d.labels || []).join('\n'))}</textarea></label>` : ''}
      ${t.fields.includes('steps') ? `<label class="pgp-f"><span>الخطوات (العنوان | الشرح)</span><textarea data-d="steps" rows="3">${esc((d.steps || []).map((s) => `${s.title} | ${s.text}`).join('\n'))}</textarea></label>` : ''}
      ${t.fields.includes('cta') ? `<label class="pgp-f"><span>نص الزرار</span><input data-d="cta" value="${esc(d.cta || '')}"></label>` : ''}</div>`;
  }

  function imagesSection(p) {
    const style = p.style || 'clean_blue';
    const packBox = `<div class="pgp-pack"><div><b>⚡ حزمة الصفحة: 5 صور بنفس النظام</b><small class="amt-dim">بالترتيب: ${(S.pack || []).map((x, i) => `${i + 1}) ${esc(x.label)}`).join(' · ')}. نفس الألوان والخط والكروت، والمنتج ثابت من صورته.</small></div>
      <label class="pgp-f"><span>أسلوب التصميم (بيتثبّت على كل صور الصفحة)</span><select data-pgp-style>${(S.styles || []).map((x) => `<option value="${esc(x.id)}" ${x.id === style ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select><small class="amt-dim">${esc((S.styles || []).find((x) => x.id === style)?.hint || '')}</small></label>
      <div class="pgp-actions"><select data-pgp-pack-q><option value="high">جودة عالية (نص أدق — الأفضل للحزمة)</option><option value="medium">جودة عادية (أرخص)</option></select><button class="amb-btn primary" data-pgp-pack ${S.busy.imgs ? 'disabled' : ''}>⚡ جهّز الحزمة (5 صور)</button></div>
      <small class="amt-dim">التكلفة التقريبية (تقدير): حوالي 1$ لـ 5 صور بجودة عالية، وحوالي 0.2$ بجودة عادية. اكتب المحتوى (القسم ②) الأول عشان العناوين تبقى من المنتج.</small></div>`;
    return `${packBox}<div class="pgp-sub">أو اختار قوالب الصور اللي عايزها واحدة واحدة (تقدر تختار نفس القالب أكتر من مرة):</div>
      <div class="pgp-tpls">${S.tpl.map((t) => `<button type="button" class="pgp-tpl" data-pgp-addtpl="${t.id}"><b>${esc(t.label)}</b><small>${esc(t.hint)}</small></button>`).join('')}</div>
      ${S.draft.length ? `<div class="pgp-drafts">${S.draft.map(draftRow).join('')}</div>
        <div class="pgp-actions"><select data-pgp-quality><option value="medium">جودة عادية (أرخص)</option><option value="high">جودة عالية (نص أدق وأغلى)</option><option value="low">جودة منخفضة (تجريبي)</option></select>
        <button class="amb-btn primary" data-pgp-genimgs ${S.busy.imgs ? 'disabled' : ''}>🎨 ولّد ${S.draft.length} صورة</button></div>` : ''}
      ${bar('imgs')}${note('imgs')}
      <div class="pgp-gallery" data-pgp-gallery>${galleryHtml()}</div>
      <small class="amt-dim">النص العربي جوه الصورة بيتقرأ تاني بعد التوليد، وأي صورة فيها خطأ محتمل بتتعلّم «راجع النص». الصورة اللي فيها غلط ولّدها من جديد.</small>`;
  }

  function galleryHtml() {
    const p = S.cur;
    if (!p.images.length) return '<div class="pgp-empty">لسه مفيش صور.</div>';
    return p.images.map((e, i) => {
      const t = S.tpl.find((x) => x.id === e.template);
      const media = e.status === 'READY' ? `<img src="${asset(p, e.id, e.version)}" alt="" loading="lazy">` : `<div class="pgp-ph ${e.status === 'FAILED' ? 'bad' : ''}">${e.status === 'FAILED' ? `⚠️ ${esc(e.error || 'فشل')}` : `<span class="pgp-spin"></span>${esc(STATUS_AR[e.status] || e.status)}`}</div>`;
      const warn = e.status === 'READY' && e.textCheck && !e.textCheck.ok ? `<span class="pgp-badge warn" title="${esc(e.textCheck.seen || '')}">⚠️ راجع النص (${e.textCheck.headlineScore}%)</span>` : e.status === 'READY' && !e.textCheck ? '<span class="pgp-badge">النص ما اتراجعش</span>' : '';
      return `<div class="pgp-img" data-pgp-img="${e.id}"><div class="pgp-imgbox">${media}${warn}</div>
        <div class="pgp-imeta"><b>${i + 1}. ${esc(t?.label || e.template)}</b>
        <div class="pgp-iact"><button class="amb-btn sm ghost" data-pgp-up="${e.id}" title="فوق" ${i === 0 ? 'disabled' : ''}>⬆️</button><button class="amb-btn sm ghost" data-pgp-down="${e.id}" title="تحت" ${i === p.images.length - 1 ? 'disabled' : ''}>⬇️</button><button class="amb-btn sm ghost" data-pgp-edit="${e.id}" title="عدّل النص وولّد من جديد">✏️</button><button class="amb-btn sm ghost" data-pgp-regen="${e.id}" title="ولّد من جديد" ${['QUEUED', 'GENERATING'].includes(e.status) ? 'disabled' : ''}>🔄</button>${e.status === 'READY' ? `<a class="amb-btn sm ghost" href="${asset(p, e.id, e.version)}" download="${String(i + 1).padStart(2, '0')}-${esc(e.template)}.png" title="تنزيل">💾</a>` : ''}<button class="amb-btn sm ghost" data-pgp-rm="${e.id}" title="مسح">🗑️</button></div></div>
        ${S.editing === e.id ? editPanel(e) : ''}</div>`;
    }).join('');
  }

  function editPanel(e) {
    const t = S.tpl.find((x) => x.id === e.template) || { fields: [] };
    return `<div class="pgp-edit" data-pgp-editpanel="${e.id}">
      ${t.fields.includes('headline') ? `<label class="pgp-f"><span>العنوان</span><input data-e="headline" value="${esc(e.headline || '')}"></label>` : ''}
      ${t.fields.includes('subtitle') ? `<label class="pgp-f"><span>الجملة الفرعية</span><input data-e="subtitle" value="${esc(e.subtitle || '')}"></label>` : ''}
      ${t.fields.includes('labels') ? `<label class="pgp-f"><span>الأيقونات (سطر لكل ميزة)</span><textarea data-e="labels" rows="3">${esc((e.labels || []).join('\n'))}</textarea></label>` : ''}
      ${t.fields.includes('steps') ? `<label class="pgp-f"><span>الخطوات (العنوان | الشرح)</span><textarea data-e="steps" rows="3">${esc((e.steps || []).map((s) => `${s.title} | ${s.text}`).join('\n'))}</textarea></label>` : ''}
      ${t.fields.includes('cta') ? `<label class="pgp-f"><span>نص الزرار</span><input data-e="cta" value="${esc(e.cta || '')}"></label>` : ''}
      <div class="pgp-actions"><button class="amb-btn sm primary" data-pgp-regen-save="${e.id}">حفظ وولّد من جديد</button><button class="amb-btn sm ghost" data-pgp-edit-close>إلغاء</button></div></div>`;
  }

  function videosSection(p) {
    const cands = S.find?.candidates || [];
    const explainer = (S.vidMode || 'explainer') === 'explainer';
    return `<div class="pgp-sub">فيديو AI من صورة المنتج:</div>
      <div class="pgp-actions"><select data-pgp-v-mode><option value="explainer" ${explainer ? 'selected' : ''}>فيديو شرح: مشاهد استخدام + تعليق صوتي بالمصري + ترجمة</option><option value="clip" ${explainer ? '' : 'selected'}>مقطع قصير متحرك من الصورة (بدون شرح)</option></select></div>
      ${explainer ? `<small class="amt-dim">الشرح بيتكتب من «المعلومات والمميزات الحقيقية» في القسم الأول، فراجعها قبل ما تولّد. التكلفة التقريبية (تقدير): حوالي 1.3$ لفيديو بـ 3 مشاهد و1.7$ لـ 4. بياخد من 5 لـ 12 دقيقة.</small>
      <div class="pgp-actions"><select data-pgp-v-scenes><option value="3">3 مشاهد (~16 ث)</option><option value="4">4 مشاهد (~21 ث)</option></select><select data-pgp-v-count><option value="1">1 فيديو</option><option value="2">2 فيديو</option></select><label class="amt-check"><input type="checkbox" data-pgp-v-caps checked> ترجمة عربي</label><button class="amb-btn primary" data-pgp-genvid ${S.busy.vid ? 'disabled' : ''}>🎬 ولّد فيديو الشرح</button></div>`
      : `<small class="amt-dim">بيحرّك صورة المنتج نفسها من غير شرح. لو الصورة فيها كتابة أو تصميم إعلاني، الكتابة هتتحرك معاها.</small>
      <div class="pgp-actions"><select data-pgp-v-style><option value="ugc">UGC عفوي</option><option value="demo">عرض المنتج</option><option value="lifestyle">استخدام يومي</option></select><select data-pgp-v-secs><option value="5">5 ثواني</option><option value="10">10 ثواني</option></select><select data-pgp-v-count><option value="1">1</option><option value="2">2</option><option value="3">3</option></select><button class="amb-btn primary" data-pgp-genvid ${S.busy.vid ? 'disabled' : ''}>🎬 ولّد المقطع</button></div>`}${bar('vid')}${note('vid')}
      <div class="pgp-sub">أو دوّر على فيديوهات موجودة للمنتج (تيك توك وريلز ومكتبة الإعلانات) وخزّن اللينكات:</div>
      <textarea data-pgp-v-links rows="2" placeholder="اختياري: الصق لينكات فيديوهات سطر لكل لينك">${esc(S.findLinks || '')}</textarea>
      <div class="pgp-actions"><button class="amb-btn" data-pgp-findvid ${S.busy.find ? 'disabled' : ''}>🔎 ابحث</button></div>${bar('find')}${note('find')}
      ${cands.length ? `<div class="amt-sources">${(S.find.sources || []).map((x) => `<span class="amt-chip ${x.ok ? 'on' : 'off'}" title="${esc(x.error || '')}">${esc(x.label)}: ${x.ok ? x.count : 'فشل'}</span>`).join('')}</div>
        <div class="pgp-cands">${cands.map((c) => `<label class="pgp-cand ${S.picks.has(c.id) ? 'on' : ''}"><input type="checkbox" data-pgp-pick="${esc(c.id)}" ${S.picks.has(c.id) ? 'checked' : ''}><div class="amt-cover">${c.thumbnail ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(c.thumbnail)}" alt="" onerror="this.remove()">` : '<span>🎬</span>'}${c.matchScore != null ? `<span class="amt-score ${c.matchScore >= 70 ? 'hi' : c.matchScore >= 40 ? 'mid' : 'lo'}">${c.matchScore}%</span>` : ''}</div><div class="amt-cinfo"><b>${esc(SRC[c.source] || c.source)}${c.author ? ` · ${esc(c.author)}` : ''}</b><small>${esc((c.caption || '').slice(0, 60))}</small><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" class="amt-open">فتح ↗</a></div></label>`).join('')}</div>
        <div class="pgp-actions"><button class="amb-btn primary" data-pgp-savepicks ${S.picks.size ? '' : 'disabled'}>أضف المختار للصفحة (${S.picks.size})</button></div>` : ''}
      <div class="pgp-sub">فيديوهات الصفحة (${p.videos.length}):</div>
      <div class="pgp-vids">${p.videos.length ? p.videos.map((v) => `<div class="pgp-vid">${v.kind === 'AI' ? `<video controls preload="metadata" src="${asset(p, v.id)}"></video>` : `<a href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(v.title || SRC[v.source] || v.url)}</a>`}<small class="amt-dim">${v.kind === 'AI' ? `فيديو AI · ${v.seconds}ث` : esc(SRC[v.source] || 'لينك')}</small><button class="amb-btn sm ghost" data-pgp-vrm="${v.id}">🗑️</button></div>`).join('') : '<div class="pgp-empty">لسه مفيش فيديوهات.</div>'}</div>`;
  }

  function previewHtml() {
    const p = S.cur; const c = p.copy || {};
    const imgs = p.images.filter((i) => i.status === 'READY');
    return `<div class="pgp-phone"><div class="pgp-ptitle">${esc(c.title || p.name)}</div>${c.subtitle ? `<div class="pgp-psub">${esc(c.subtitle)}</div>` : ''}
      <div class="pgp-pprice">${p.price != null ? `<b>${esc(p.price)} ج</b>` : ''}${p.oldPrice ? ` <s>${esc(p.oldPrice)} ج</s>` : ''}</div>
      ${(c.paragraphs || []).map((t) => `<p>${esc(t)}</p>`).join('')}
      ${imgs.map((e) => `<img src="${asset(p, e.id, e.version)}" alt="" loading="lazy">`).join('') || '<div class="pgp-empty">الصور هتظهر هنا بالترتيب.</div>'}
      ${p.videos.some((v) => v.kind === 'AI') ? '<div class="pgp-psub">🎬 + فيديوهات الصفحة</div>' : ''}</div>`;
  }

  // ---------------------------------------------------------------- render + wiring
  function render() {
    root.innerHTML = `<div class="pgp">${S.view === 'new' ? newView() : S.view === 'project' && S.cur ? projectView() : listView()}</div>`;
    wire();
  }

  const val = (sel) => root.querySelector(sel)?.value ?? '';
  const parseSteps = (txt) => lines(txt).map((l) => { const [a, ...b] = l.split('|'); return { title: (a || '').trim(), text: b.join('|').trim() }; }).filter((s) => s.title).slice(0, 3);

  async function runJob(key, start, { onDone, label } = {}) {
    S.busy[key] = true; S.bar[key] = { pct: 3, message: label || 'بدأ…' }; say(key, null); render();
    try {
      const started = await start();
      const job = started.job || started;
      const done = await pollJob(job.id, (j) => { S.bar[key] = { pct: j.progress, message: j.message }; const b = root.querySelector(`.pgp-sec .amt-prog i`); if (b) b.style.width = `${j.progress}%`; });
      S.busy[key] = false;
      await refresh().catch(() => {});
      if (done.status === 'FAILED') { say(key, done.error?.message || 'فشل.', true); render(); return null; }
      if (onDone) onDone(done.result, done);
      render(); return done;
    } catch (e) { S.busy[key] = false; say(key, e.message, true); render(); return null; }
  }

  function wire() {
    const on = (sel, fn) => root.querySelectorAll(sel).forEach((el) => { el.onclick = (ev) => fn(el, ev); });
    on('[data-pgp-back]', async () => { if (S.embedded && typeof opts.onBack === 'function') return opts.onBack(); S.view = 'list'; S.cur = null; await loadList(); render(); });
    on('[data-pgp-new]', () => { S.view = 'new'; S.form = { name: '', price: '', oldPrice: '', facts: '', eo: null }; S.eo = { q: '', results: null }; render(); });
    on('[data-pgp-open]', (el) => openProject(el.dataset.pgpOpen).catch((e) => toast(e.message, 'error')));

    // new project form
    const eoq = root.querySelector('[data-pgp-eo-q]');
    if (eoq) { let tm = null; eoq.oninput = () => { S.eo.q = eoq.value; clearTimeout(tm); tm = setTimeout(async () => { try { S.eo.results = (await api.get(`${B}/eo-products?q=${encodeURIComponent(S.eo.q)}`)).products; } catch { S.eo.results = []; } const keep = S.eo.q; render(); const el = root.querySelector('[data-pgp-eo-q]'); if (el) { el.focus(); el.setSelectionRange(keep.length, keep.length); } }, 400); }; if (S.eo.results === null) { api.get(`${B}/eo-products`).then((r) => { S.eo.results = r.products; if (S.view === 'new') render(); }).catch(() => { S.eo.results = []; }); } }
    on('[data-pgp-eo-pick]', async (el) => {
      const p = (S.eo.results || []).find((x) => String(x.id) === el.dataset.pgpEoPick && (!el.dataset.pgpEoStore || x.storeId === el.dataset.pgpEoStore)); if (!p) return;
      S.form.eo = p; S.form.eoDetail = null; S.eoLoading = true; say('create', null); render();
      try {
        const d = await api.get(`${B}/eo-products/${encodeURIComponent(p.storeId)}/${encodeURIComponent(p.id)}`);
        S.form.eoDetail = d; S.form.name = d.name || p.name; S.form.price = d.price ?? ''; S.form.oldPrice = d.oldPrice ?? ''; S.form.facts = (d.facts || []).join('\n');
      } catch (e) { say('create', e.message, true); S.form.price = S.form.price || (p.price ?? ''); S.form.name = S.form.name || p.name; }
      S.eoLoading = false; render();
    });
    const keepForm = () => { S.form.name = val('[data-pgp-name]'); S.form.price = val('[data-pgp-price]'); S.form.oldPrice = val('[data-pgp-old]'); S.form.facts = val('[data-pgp-facts]'); };
    root.querySelectorAll('[data-pgp-name],[data-pgp-price],[data-pgp-old],[data-pgp-facts]').forEach((el) => { el.oninput = keepForm; });
    on('[data-pgp-create]', async () => {
      keepForm(); S.busy.create = true; say('create', null); render();
      try { const p = await api.post(B, { name: S.form.name, price: S.form.price, oldPrice: S.form.oldPrice, facts: lines(S.form.facts), eo: S.form.eo ? { id: S.form.eo.id, storeId: S.form.eo.storeId } : undefined }); S.busy.create = false; await loadList(); S.cur = p; if (S.onCreated) { S.onCreated(p); return; } S.view = 'project'; render(); startWatch(); }
      catch (e) { S.busy.create = false; say('create', e.message, true); render(); }
    });

    if (S.view !== 'project' || !S.cur) return;
    const p = S.cur;
    on('[data-pgp-del]', async () => { if (!confirm('تمسح الصفحة دي بكل صورها وفيديوهاتها؟')) return; try { await api.delete(`${B}/${p.id}`); S.view = 'list'; S.cur = null; await loadList(); render(); } catch (e) { toast(e.message, 'error'); } });

    // 1. data + reference photo
    on('[data-pgp-savedata]', async () => { try { S.cur = await api.put(`${B}/${p.id}`, { name: val('[data-pgp-pname]'), price: val('[data-pgp-pprice]'), oldPrice: val('[data-pgp-pold]'), facts: lines(val('[data-pgp-pfacts]')) }); say('data', '✅ اتحفظت البيانات.'); } catch (e) { say('data', e.message, true); } render(); });
    const refBtn = root.querySelector('[data-pgp-ref]'), refIn = root.querySelector('[data-pgp-ref-in]');
    if (refBtn && refIn) {
      refBtn.onclick = () => refIn.click();
      refIn.onchange = async () => {
        const f = refIn.files?.[0]; if (!f) return;
        if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { say('ref', 'لازم JPG أو PNG أو WebP.', true); render(); return; }
        if (f.size > 8 * 1024 * 1024) { say('ref', 'الصورة أكبر من 8MB.', true); render(); return; }
        try { const res = await fetch(`${B}/${p.id}/reference`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': f.type }, body: f }); const j = await res.json().catch(() => null); if (!res.ok) throw new Error(j?.message || `فشل الرفع (${res.status})`); await refresh(); say('ref', '✅ اتحفظت صورة المنتج.'); } catch (e) { say('ref', e.message, true); }
        render();
      };
    }
    on('[data-pgp-gencopy]', async () => { await runJob('copy', () => api.post(`${B}/${p.id}/copy`, {}), { label: 'بكتب المحتوى…', onDone: () => say('copy', '✅ المحتوى اتكتب — راجعه في القسم التاني.') }); });

    // linked Easy Orders product
    on('[data-pgp-eo-sync]', async (el) => {
      const all = el.dataset.pgpEoSync === 'all';
      if (all && !confirm('ده هيستبدل الاسم والسعر والمميزات اللي كتبتها بالبيانات الحالية من إيزي أوردر. تكمّل؟')) return;
      S.busy.eosync = true; say('eosync', null); render();
      try { S.cur = await api.post(`${B}/${p.id}/eo-sync`, { overwrite: all }); say('eosync', all ? '✅ اتحدّثت كل البيانات من إيزي أوردر.' : '✅ اتحدّث المخزون والتصنيف والصور.'); } catch (e) { say('eosync', e.message, true); }
      S.busy.eosync = false; render();
    });
    on('[data-pgp-eo-img]', async (el) => {
      try { S.cur = await api.post(`${B}/${p.id}/reference-from-eo`, { index: Number(el.dataset.pgpEoImg) }); say('ref', '✅ اتغيّرت صورة المنتج.'); toast('اتغيّرت صورة المنتج.', 'success'); } catch (e) { say('ref', e.message, true); toast(e.message, 'error'); }
      render();
    });

    // 2b. ad captions
    on('[data-pgp-cap-copy]', async (el) => {
      const box = root.querySelector(`[data-pgp-cap="${el.dataset.pgpCapCopy}"]`); if (!box) return;
      const text = `${box.querySelector('[data-pgp-cap-h]').value}\n\n${box.querySelector('[data-pgp-cap-p]').value}`.trim();
      try { await navigator.clipboard.writeText(text); toast('اتنسخ الكابشن.', 'success'); } catch { toast('المتصفح منع النسخ — حدّد النص وانسخه بإيدك.', 'error'); }
    });
    on('[data-pgp-savecaps]', async () => {
      const captions = [...root.querySelectorAll('[data-pgp-cap]')].map((b) => ({ primary: b.querySelector('[data-pgp-cap-p]').value, headline: b.querySelector('[data-pgp-cap-h]').value }));
      try { S.cur = await api.put(`${B}/${p.id}`, { copy: { captions } }); say('savecaps', '✅ اتحفظت الكابشنات.'); } catch (e) { say('savecaps', e.message, true); }
      render();
    });

    // 2. copy
    on('[data-pgp-savecopy]', async () => {
      try { S.cur = await api.put(`${B}/${p.id}`, { copy: { title: val('[data-pgp-c-title]'), subtitle: val('[data-pgp-c-sub]'), paragraphs: lines(val('[data-pgp-c-par]')), features: lines(val('[data-pgp-c-feat]')), steps: parseSteps(val('[data-pgp-c-steps]')), cta: val('[data-pgp-c-cta]'), headlines: p.copy?.headlines || {} } }); say('savecopy', '✅ اتحفظ المحتوى.'); } catch (e) { say('savecopy', e.message, true); }
      render();
    });

    // 3. images
    root.querySelectorAll('details[data-sec]').forEach((d) => { d.ontoggle = () => { S.open[d.dataset.sec] = d.open; }; });
    const syncDraft = () => root.querySelectorAll('[data-pgp-draft]').forEach((row) => { const d = S.draft[Number(row.dataset.pgpDraft)]; if (!d) return; row.querySelectorAll('[data-d]').forEach((inp) => { const k = inp.dataset.d; d[k] = k === 'labels' ? lines(inp.value) : k === 'steps' ? parseSteps(inp.value) : inp.value; }); });
    // adding / dropping a template redraws ONLY the images section, so nothing typed elsewhere is lost
    const redrawImages = () => { const box = root.querySelector('[data-pgp-imgsec]'); if (box) { box.innerHTML = imagesSection(S.cur); wire(); } };
    on('[data-pgp-addtpl]', (el) => { syncDraft(); S.draft.push({ template: el.dataset.pgpAddtpl, headline: '', subtitle: '', labels: [], steps: [], cta: '' }); redrawImages(); });
    on('[data-pgp-draft-del]', (el) => { syncDraft(); S.draft.splice(Number(el.dataset.pgpDraftDel), 1); redrawImages(); });
    on('[data-pgp-genimgs]', async () => {
      syncDraft(); const items = S.draft.slice(); const quality = val('[data-pgp-quality]') || 'medium';
      const done = await runJob('imgs', async () => { const r = await api.post(`${B}/${p.id}/images`, { items, quality }); S.draft = []; await refresh(); return r; }, { label: 'بولّد الصور…', onDone: (r) => say('imgs', `✅ خلصت ${r.done.length} صورة${r.failed?.length ? ` (فشل ${r.failed.length})` : ''}.`) });
      void done;
    });
    const styleSel = root.querySelector('[data-pgp-style]'); if (styleSel) styleSel.onchange = async () => { try { S.cur = await api.put(`${B}/${p.id}`, { style: styleSel.value }); redrawImages(); } catch (e) { say('imgs', e.message, true); redrawImages(); } };
    on('[data-pgp-pack]', async () => {
      if (!p.copy && !confirm('لسه ما كتبتش المحتوى بالـ AI، فالعناوين هتبقى من اسم المنتج بس. تكمّل؟')) return;
      const quality = val('[data-pgp-pack-q]') || 'high'; const style = val('[data-pgp-style]') || p.style;
      await runJob('imgs', async () => { const r = await api.post(`${B}/${p.id}/images/pack`, { quality, style }); await refresh(); return r; }, { label: 'بجهّز حزمة الصفحة…', onDone: (r) => say('imgs', `✅ خلصت ${r.done.length} من 5 صور${r.failed?.length ? ` (فشل ${r.failed.length})` : ''}.`) });
    });
    wireGallery();

    // 4. videos
    const links = root.querySelector('[data-pgp-v-links]'); if (links) links.oninput = () => { S.findLinks = links.value; };
    const vmode = root.querySelector('[data-pgp-v-mode]'); if (vmode) vmode.onchange = () => { S.vidMode = vmode.value; render(); const sec = root.querySelector('details[data-sec=vids]'); if (sec) sec.open = true; };
    on('[data-pgp-genvid]', async () => {
      const explainer = (S.vidMode || 'explainer') === 'explainer';
      const payload = explainer ? { mode: 'explainer', count: Number(val('[data-pgp-v-count]')), scenes: Number(val('[data-pgp-v-scenes]')), captions: !!root.querySelector('[data-pgp-v-caps]')?.checked } : { mode: 'clip', count: Number(val('[data-pgp-v-count]')), seconds: Number(val('[data-pgp-v-secs]')), style: val('[data-pgp-v-style]') };
      await runJob('vid', () => api.post(`${B}/${p.id}/videos/ai`, payload), { label: 'بولّد الفيديو — بياخد دقايق…', onDone: (r) => say('vid', `✅ اتضاف ${r.added.length} فيديو${r.failed?.length ? ` (فشل ${r.failed.length}: ${r.failed[0].error})` : ''}.`) });
    });
    on('[data-pgp-findvid]', async () => { S.find = null; S.picks.clear(); await runJob('find', () => api.post(`${B}/${p.id}/videos/find`, { target: 12, manualUrls: lines(S.findLinks || '') }), { label: 'بدوّر…', onDone: (r) => { S.find = r; say('find', `✅ لقيت ${r.candidates.length} فيديو.`); } }); });
    root.querySelectorAll('[data-pgp-pick]').forEach((cb) => { cb.onchange = () => { cb.checked ? S.picks.add(cb.dataset.pgpPick) : S.picks.delete(cb.dataset.pgpPick); cb.closest('.pgp-cand').classList.toggle('on', cb.checked); const b = root.querySelector('[data-pgp-savepicks]'); if (b) { b.disabled = !S.picks.size; b.textContent = `أضف المختار للصفحة (${S.picks.size})`; } }; });
    on('[data-pgp-savepicks]', async () => {
      let ok = 0, bad = 0;
      for (const c of (S.find?.candidates || []).filter((x) => S.picks.has(x.id))) { try { await api.post(`${B}/${p.id}/videos/link`, { url: c.url, title: c.caption || c.author || '', source: c.source }); ok++; } catch { bad++; } }
      S.picks.clear(); await refresh(); say('find', `اتضاف ${ok} لينك${bad ? ` (${bad} مكرر أو فشل)` : ''}.`, !ok); render();
    });
    on('[data-pgp-vrm]', async (el) => { if (!confirm('تمسح الفيديو ده؟')) return; try { await api.delete(`${B}/${p.id}/videos/${el.dataset.pgpVrm}`); await refresh(); render(); } catch (e) { toast(e.message, 'error'); } });

    // export
    on('[data-pgp-zip]', () => { if (!p.images.some((i) => i.status === 'READY')) { say('export', 'مفيش صور جاهزة للتصدير.', true); render(); return; } const a = document.createElement('a'); a.href = `${B}/${p.id}/export.zip`; a.download = `page-${p.id}.zip`; document.body.appendChild(a); a.click(); a.remove(); });
    on('[data-pgp-copytxt]', async () => { try { const t = await (await fetch(`${B}/${p.id}/export.txt`, { credentials: 'include' })).text(); await navigator.clipboard.writeText(t); say('export', '✅ اتنسخ النص (العنوان والوصف والمميزات).'); } catch { say('export', 'تعذّر النسخ — جرّب من نافذة المتصفح.', true); } render(); });
  }

  function wireGallery() {
    const p = S.cur; if (!p) return;
    const on = (sel, fn) => root.querySelectorAll(sel).forEach((el) => { el.onclick = () => fn(el); });
    const move = async (id, dir) => { const ids = p.images.map((i) => i.id); const i = ids.indexOf(id); const j = i + dir; if (i < 0 || j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; try { await api.put(`${B}/${p.id}/images-order`, { order: ids }); await refresh(); render(); } catch (e) { toast(e.message, 'error'); } };
    on('[data-pgp-up]', (el) => move(el.dataset.pgpUp, -1));
    on('[data-pgp-down]', (el) => move(el.dataset.pgpDown, 1));
    on('[data-pgp-rm]', async (el) => { if (!confirm('تمسح الصورة دي؟')) return; try { await api.delete(`${B}/${p.id}/images/${el.dataset.pgpRm}`); await refresh(); render(); } catch (e) { toast(e.message, 'error'); } });
    on('[data-pgp-edit]', (el) => { S.editing = S.editing === el.dataset.pgpEdit ? null : el.dataset.pgpEdit; render(); });
    on('[data-pgp-edit-close]', () => { S.editing = null; render(); });
    const regen = async (id, patch) => { S.editing = null; await runJob('imgs', () => api.post(`${B}/${p.id}/images/${id}/regenerate`, patch || {}), { label: 'بولّد من جديد…', onDone: () => say('imgs', '✅ اتولّدت من جديد.') }); };
    on('[data-pgp-regen]', (el) => regen(el.dataset.pgpRegen, {}));
    on('[data-pgp-regen-save]', (el) => { const id = el.dataset.pgpRegenSave; const panel = root.querySelector(`[data-pgp-editpanel="${id}"]`); const patch = {}; panel?.querySelectorAll('[data-e]').forEach((inp) => { const k = inp.dataset.e; patch[k] = k === 'labels' ? lines(inp.value) : k === 'steps' ? parseSteps(inp.value) : inp.value; }); regen(id, patch); });
  }

  // ---------------------------------------------------------------- boot
  root.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  try { await Promise.all([loadTemplates(), loadList()]); } catch (e) { root.innerHTML = `<div class="pgp-empty">تعذّر التحميل: ${esc(e.message)}</div>`; return; }
  if (opts.projectId && (!S.cur || S.cur.id !== opts.projectId)) { try { S.cur = await api.get(`${B}/${opts.projectId}`); S.view = 'project'; S.draft = []; S.find = null; S.picks.clear(); S.editing = null; startWatch(); } catch { S.view = 'list'; S.cur = null; } }
  else if (S.view === 'project' && S.cur) { try { await refresh(); startWatch(); } catch { S.view = 'list'; S.cur = null; } }
  render();
}
