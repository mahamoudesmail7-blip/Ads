// AI Creative Factory — page controller for creative-factory.html.
// RTL Arabic, premium light. Talks only to /api/creative-factory/* via the
// shared api-client. Four tabs: إنشاء جديد / مشاريعي / النتائج / تعلّم الـ AI.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const E = (s) => UI.escapeHtml(String(s ?? ''));
const $ = (id) => document.getElementById(id);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const fmtN = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US'));

const NAV = [
  { key: 'new', label: 'إنشاء جديد', icon: '✨' },
  { key: 'projects', label: 'مشاريعي', icon: '🗂️' },
  { key: 'results', label: 'النتائج', icon: '🖼️' },
  { key: 'learn', label: 'تعلّم الـ AI', icon: '📈' },
];

const PROJECT_TYPE_CARDS = [
  { key: 'PRODUCT_PAGE', ic: '📄', t: 'صفحة منتج', d: 'تسلسل صور مترابط للصفحة' },
  { key: 'META_ADS', ic: '🎯', t: 'إعلانات Meta', d: 'كرياتيفات متنوعة الزوايا' },
  { key: 'SOCIAL', ic: '📱', t: 'بوستات سوشيال', d: 'منشورات جاهزة' },
  { key: 'RETARGETING', ic: '🔁', t: 'إعادة استهداف', d: 'صور للريتارجت' },
  { key: 'VARIATIONS', ic: '🧬', t: 'Variations', d: 'اشتقاقات من فكرة' },
  { key: 'CUSTOM', ic: '🎨', t: 'صورة مخصصة', d: 'حسب طلبك' },
];
const LOCK_LABEL = { STRICT: 'صارم', BALANCED: 'متوازن', CREATIVE: 'إبداعي' };
const DENSITY_LABEL = { MINIMAL: 'قليل جدًا', LOW: 'قليل', MEDIUM: 'متوسط' };
const PEOPLE_LABEL = { NONE: 'بدون أشخاص', MEN: 'رجال', WOMEN: 'سيدات', AI_CHOICE: 'حسب فكرة الـ AI' };
const ITEM_STATUS = {
  PLANNED: ['في الخطة', 'gray'], QUEUED: ['في الانتظار', 'gray'], GENERATING: ['جاري الإنشاء', 'violet'],
  REVIEWING: ['فحص الجودة', 'violet'], REGENERATING: ['إعادة المحاولة', 'amber'],
  COMPLETED: ['تم', 'green'], NEEDS_REVIEW: ['يحتاج مراجعة', 'amber'], FAILED: ['فشل', 'red'],
};

const state = {
  tab: 'new', me: null, isAdmin: false, status: null,
  wiz: null,           // active wizard state
  poll: null,
};

// ---------------------------------------------------------------------------
async function init() {
  try {
    state.me = await api.get('/api/auth/me');
    state.isAdmin = state.me.role === 'ADMIN' || state.me.is_owner;
  } catch { return; }
  try { state.status = await api.get('/api/creative-factory/status'); }
  catch (e) { $('cfView').innerHTML = `<div class="cf-empty">⚠️ ${E(e.message)}</div>`; return; }

  $('cfDrawerOverlay').addEventListener('click', (e) => { if (e.target.id === 'cfDrawerOverlay') closeDrawer(); });
  window.addEventListener('hashchange', route);
  renderNav();
  route();
}

function renderNav() {
  const u = state.me || {};
  const initials = (u.name || 'U').trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
  $('cfNav').innerHTML = `
    <div class="cf-nav-brand">
      <div class="logo">✨</div>
      <div><div class="t">مصنع الكرياتيفات</div><div class="s">صور منتجات بالذكاء الاصطناعي</div></div>
    </div>
    ${NAV.map((n) => `<button class="cf-nav-item ${n.key === state.tab ? 'active' : ''}" data-nav="${n.key}"><span>${n.icon}</span><span>${E(n.label)}</span></button>`).join('')}
    <div class="cf-nav-foot">
      <div class="cf-nav-user"><div class="av">${E(initials)}</div><div><div class="nm">${E(u.name || '—')}</div><div class="rl">${E({ ADMIN: 'مدير النظام', MANAGER: 'مدير', EMPLOYEE: 'موظف' }[u.role] || u.role || '')}</div></div></div>
      <a class="cf-nav-link" href="ai-media-buyer.html">🧠 AI Media Buyer</a>
      <a class="cf-nav-link" href="ai-intelligence.html">🧠 AI Intelligence</a>
      <a class="cf-nav-link" href="index.html">↩︎ الرجوع للنظام</a>
    </div>`;
  $('cfNav').querySelectorAll('[data-nav]').forEach((b) => { b.onclick = () => { location.hash = b.dataset.nav; }; });
}

function route() {
  if (state.poll) { clearInterval(state.poll); state.poll = null; }
  const hash = (location.hash || '#new').slice(1).split('/')[0];
  state.tab = NAV.find((n) => n.key === hash) ? hash : 'new';
  renderNav();
  const view = $('cfView');
  view.innerHTML = '<div class="cf-loading">جارِ التحميل…</div>';
  const run = { new: renderNew, projects: renderProjects, results: renderResults, learn: renderLearn }[state.tab];
  run(view).catch((err) => { view.innerHTML = `<div class="cf-empty">⚠️ ${E(err.message || err)}</div>`; });
}

function providerBanner() {
  const p = state.status?.provider;
  if (!p) return '';
  if (!p.image.configured) {
    return `<div class="cf-banner warn">⚙️ <div><b>مزود إنشاء الصور غير مُهيأ.</b> تقدر تجهّز كل حاجة (المنتج، الـ DNA، الخطة) دلوقتي — لكن زر إنشاء الصور هيشتغل بعد إضافة <code>${E(p.image.envVar)}</code> في متغيرات البيئة.${!p.text.configured ? ` كمان <code>${E(p.text.envVar)}</code> مش متظبط، فالتحليل والخطة هيبقوا بقوالب افتراضية بدل الـ AI.` : ''}</div></div>`;
  }
  if (!p.text.configured) {
    return `<div class="cf-banner info">ℹ️ الـ AI النصي (<code>${E(p.text.envVar)}</code>) مش متظبط — التحليل والخطة والنصوص هتبقى بقوالب افتراضية.</div>`;
  }
  return '';
}

function head(title, sub) {
  return `<div class="cf-head"><h1>${E(title)}</h1><div class="sub">${E(sub)}</div></div>`;
}
function needAdmin(view) {
  if (state.isAdmin) return false;
  view.innerHTML = head('مصنع الكرياتيفات', '') + `<div class="cf-banner warn">هذه الأداة متاحة للـ ADMIN فقط للإنشاء والتعديل. تقدر تتصفح المشاريع والنتائج فقط.</div>`;
  return true;
}

// ===========================================================================
// TAB 1 — إنشاء جديد (wizard)
// ===========================================================================
function newWiz() {
  return {
    step: 'product',
    productId: null, product: null,
    projectType: null, projectId: null, project: null,
    count: 5, countMode: 'MANUAL', aiReason: null,
    adv: { stylePreset: state.status?.settings?.cfDefaultStylePreset || 'EGY_ECOM', market: 'EG', language: 'ar', dialect: 'egyptian', aspectRatio: '1:1', textDensity: 'MINIMAL', peopleRule: 'NONE', hijabRequired: false, generationMode: state.status?.settings?.cfDefaultGenerationMode || 'FAST', productLockMode: 'STRICT' },
    plan: null, jobId: null,
  };
}
const STEP_ORDER = ['product', 'goal', 'count', 'plan', 'generate'];
const STEP_LABEL = { product: 'المنتج', goal: 'الهدف', count: 'العدد', plan: 'الخطة', generate: 'الإنشاء' };

async function renderNew(view) {
  if (needAdmin(view)) return;
  if (!state.wiz) state.wiz = newWiz();
  const w = state.wiz;
  const cur = STEP_ORDER.indexOf(w.step);
  view.innerHTML = head('مصنع الكرياتيفات', 'حوّل صور منتجك إلى كرياتيفات جاهزة للبيع') + providerBanner()
    + `<div class="cf-steps">${STEP_ORDER.map((s, i) => `<div class="cf-step ${i === cur ? 'on' : i < cur ? 'done' : ''}"><span class="n">${i < cur ? '✓' : i + 1}</span>${E(STEP_LABEL[s])}</div>`).join('')}</div>`
    + `<div id="cfWizBody"></div>`;
  const body = $('cfWizBody');
  if (w.step === 'product') await wizProduct(body);
  else if (w.step === 'goal') wizGoal(body);
  else if (w.step === 'count') await wizCount(body);
  else if (w.step === 'plan') await wizPlan(body);
  else if (w.step === 'generate') await wizGenerate(body);
}
function goStep(s) { state.wiz.step = s; renderNew($('cfView')); }

// ---- STEP: product -------------------------------------------------------
async function wizProduct(body) {
  const w = state.wiz;
  const { products } = await api.get('/api/creative-factory/products');
  body.innerHTML = `
    <div class="cf-card">
      <h2>1) اختر المنتج أو أضِف منتجًا جديدًا</h2>
      <div class="hint">لازم المنتج يكون فيه 3–6 صور مرجعية قبل بدء أي مشروع.</div>
      <div class="cf-row">
        <div class="cf-field"><label>منتج موجود</label>
          <select id="cfProdSel"><option value="">— اختر —</option>${products.map((p) => `<option value="${p.id}" ${w.productId === p.id ? 'selected' : ''}>${E(p.name)} · ${p.referenceImageCount} صورة · ${p.projectCount} مشروع</option>`).join('')}</select>
        </div>
        <div class="cf-field" style="align-self:flex-end;"><button class="cf-btn" id="cfNewProd">+ منتج جديد</button></div>
      </div>
      <div id="cfProdPane"></div>
    </div>`;
  $('cfProdSel').onchange = async (e) => { w.productId = Number(e.target.value) || null; w.product = null; await loadProdPane(); };
  $('cfNewProd').onclick = () => openNewProductForm();
  if (w.productId) await loadProdPane();
}

async function loadProdPane() {
  const w = state.wiz;
  const pane = $('cfProdPane');
  if (!w.productId) { pane.innerHTML = ''; return; }
  pane.innerHTML = '<div class="cf-loading">تحميل المنتج…</div>';
  const p = await api.get(`/api/creative-factory/products/${w.productId}`);
  w.product = p;
  const refs = p.referenceImages || [];
  const dna = p.dna;
  pane.innerHTML = `
    <div style="margin-top:16px;">
      <h2 style="font-size:14px;">الصور المرجعية (${refs.length}/${p.limits.maxReferenceImages})</h2>
      <div class="cf-dropzone" id="cfDrop">اسحب وأفلت الصور هنا أو اضغط للاختيار — jpg / png / webp</div>
      <input type="file" id="cfFile" accept="image/png,image/jpeg,image/webp" multiple hidden />
      <div class="cf-refs" id="cfRefs">${refs.map(refCard).join('')}</div>
    </div>
    <div style="margin-top:18px;">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <h2 style="font-size:14px;margin:0;">تحليل المنتج (Product DNA)</h2>
        <button class="cf-btn sm" id="cfAnalyze">${dna ? 'إعادة التحليل' : 'تحليل المنتج'}</button>
        <span class="cf-muted">${dna ? `الإصدار ${dna.version} · ${dnaSourceLabel(dna.source)} · ثقة ${dna.confidence ?? '—'}` : 'لم يتم بعد'}</span>
      </div>
      <div id="cfDna">${dna ? dnaCard(dna) : '<div class="cf-muted" style="margin-top:8px;">اضغط «تحليل المنتج» بعد رفع الصور المرجعية.</div>'}</div>
    </div>
    <div class="cf-field" style="margin-top:16px;max-width:280px;">
      <label>قفل المنتج (Product Lock)</label>
      <select id="cfLock">${Object.entries(LOCK_LABEL).map(([k, v]) => `<option value="${k}" ${(w.adv.productLockMode) === k ? 'selected' : ''}>${v}${k === 'STRICT' ? ' (افتراضي)' : ''}</option>`).join('')}</select>
    </div>
    <div class="cf-actions">
      <button class="cf-btn primary" id="cfToGoal" ${refs.length < p.limits.minReferenceImages ? 'disabled' : ''}>التالي: الهدف ←</button>
      ${refs.length < p.limits.minReferenceImages ? `<span class="cf-muted">محتاج ${p.limits.minReferenceImages - refs.length} صورة إضافية على الأقل.</span>` : ''}
    </div>`;
  wireRefUpload();
  $('cfLock').onchange = (e) => { w.adv.productLockMode = e.target.value; };
  $('cfAnalyze').onclick = async () => {
    const btn = $('cfAnalyze'); btn.disabled = true; btn.textContent = 'جاري التحليل…';
    try { const d = await api.post(`/api/creative-factory/products/${w.productId}/dna/analyze`, {}); $('cfDna').innerHTML = dnaCard(d); UI.toast('تم تحليل المنتج'); await loadProdPane(); }
    catch (e) { UI.toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'تحليل المنتج'; }
  };
  $('cfToGoal').onclick = () => goStep('goal');
}

function refCard(r) {
  return `<div class="cf-ref" data-ref="${r.id}">
    <img src="/api/creative-factory/products/${state.wiz.productId}/reference-images/${r.id}/image" alt="" loading="lazy" />
    <div class="meta"><input value="${E(r.angleLabel || '')}" placeholder="الزاوية" disabled /><button data-del="${r.id}">حذف</button></div>
  </div>`;
}
function wireRefUpload() {
  const drop = $('cfDrop'); const file = $('cfFile'); const w = state.wiz;
  if (!drop) return;
  drop.onclick = () => file.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
  drop.ondragleave = () => drop.classList.remove('drag');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drag'); uploadFiles(e.dataTransfer.files); };
  file.onchange = () => uploadFiles(file.files);
  $('cfRefs').querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      try { await api.delete(`/api/creative-factory/products/${w.productId}/reference-images/${b.dataset.del}`); await loadProdPane(); }
      catch (e) { UI.toast(e.message, 'error'); }
    };
  });
}
async function uploadFiles(fileList) {
  const w = state.wiz;
  const files = [...(fileList || [])].slice(0, 6);
  for (const f of files) {
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { UI.toast(`${f.name}: نوع غير مدعوم`, 'error'); continue; }
    try {
      const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(f); });
      await api.post(`/api/creative-factory/products/${w.productId}/reference-images`, { dataUrl, angleLabel: '' });
    } catch (e) { UI.toast(`${f.name}: ${e.message}`, 'error'); }
  }
  await loadProdPane();
}

function dnaSourceLabel(s) { return { AI_ANALYZED: 'بالذكاء الاصطناعي', USER_EDITED: 'تعديل يدوي', MIXED: 'مختلط', UNAVAILABLE: 'غير متاح (يدوي)' }[s] || s; }
function dnaCard(dna) {
  const d = dna.data || {};
  const rows = [
    ['الألوان الأساسية', (d.primary_colors || []).join('، ')],
    ['الخامات المرئية', (d.visible_materials || []).join('، ')],
    ['الشكل', d.product_shape], ['الشاشة', d.display_screen], ['المنافذ', d.ports],
    ['الشعارات/العلامة', (d.logos_branding || []).join('، ')],
    ['ملحقات', (d.accessories || []).join('، ')],
    ['مظهر العبوة', d.packaging_appearance],
    ['تفاصيل مميزة', (d.unique_design_details || []).join('، ')],
    ['ممنوع اختراعه', (d.never_invent || []).join('، ')],
  ].filter(([, v]) => v);
  return `<div class="cf-card" style="margin-top:10px;background:var(--cf-bg);box-shadow:none;">
    <div style="font-weight:800;font-size:13px;margin-bottom:6px;">فهمنا المنتج كالتالي</div>
    ${rows.length ? `<div class="kv" style="font-size:12px;line-height:1.9;">${rows.map(([k, v]) => `<div><b>${E(k)}:</b> ${E(v)}</div>`).join('')}</div>` : '<div class="cf-muted">مفيش تفاصيل مستخرجة — الـ AI النصي غالبًا مش متظبط. تقدر تدخل التفاصيل يدويًا لاحقًا.</div>'}
    <button class="cf-btn sm ghost" style="margin-top:10px;" id="cfEditDna">تعديل يدوي</button>
  </div>`;
}
// (dna edit handler wired after render)
document.addEventListener('click', async (e) => {
  if (e.target && e.target.id === 'cfEditDna') {
    const w = state.wiz; if (!w?.productId) return;
    const d = (w.product?.dna?.data) || {};
    const val = (k) => (Array.isArray(d[k]) ? d[k].join('، ') : (d[k] || ''));
    openDrawer(`<h2 style="margin-top:0;">تعديل Product DNA</h2>
      ${['primary_colors', 'secondary_colors', 'visible_materials', 'logos_branding', 'accessories', 'unique_design_details', 'never_invent'].map((k) => `<div class="cf-field"><label>${E(k)}</label><input data-dna="${k}" value="${E(val(k))}" placeholder="افصل بفاصلة"/></div>`).join('')}
      ${['product_shape', 'display_screen', 'ports', 'packaging_appearance'].map((k) => `<div class="cf-field"><label>${E(k)}</label><input data-dna="${k}" value="${E(val(k))}"/></div>`).join('')}
      <button class="cf-btn primary" id="cfDnaSave">حفظ</button>`);
    $('cfDnaSave').onclick = async () => {
      const patch = {};
      $('cfDrawer').querySelectorAll('[data-dna]').forEach((inp) => {
        const k = inp.dataset.dna;
        patch[k] = ['product_shape', 'display_screen', 'ports', 'packaging_appearance'].includes(k) ? (inp.value.trim() || null) : inp.value.split(/[،,]+/).map((x) => x.trim()).filter(Boolean);
      });
      try { await api.patch(`/api/creative-factory/products/${w.productId}/dna`, { data: patch }); closeDrawer(); UI.toast('تم الحفظ'); await loadProdPane(); }
      catch (err) { UI.toast(err.message, 'error'); }
    };
  }
});

function openNewProductForm() {
  api.get('/api/creative-factory/products/catalog').then(({ suggestions }) => {
    const opts = suggestions.filter((s) => !s.linked);
    openDrawer(`<h2 style="margin-top:0;">منتج جديد</h2>
      <div class="cf-field"><label>من الكتالوج (اختياري)</label><select id="npCat"><option value="">— بدون —</option>${opts.map((o) => `<option value="${o.ambProductId}">${E(o.name)}</option>`).join('')}</select></div>
      <div class="cf-field"><label>اسم المنتج *</label><input id="npName"/></div>
      <div class="cf-field"><label>اسم داخلي / إنجليزي</label><input id="npInternal"/></div>
      <div class="cf-field"><label>التصنيف</label><input id="npCategory"/></div>
      <div class="cf-field"><label>الوصف</label><textarea id="npDesc"></textarea></div>
      <div class="cf-field"><label>المواصفات</label><textarea id="npSpecs"></textarea></div>
      <div class="cf-field"><label>الفوائد الرئيسية</label><textarea id="npBenefits"></textarea></div>
      <div class="cf-field"><label>حالات الاستخدام</label><textarea id="npUse"></textarea></div>
      <div class="cf-field"><label>الجمهور المستهدف</label><textarea id="npAud"></textarea></div>
      <div class="cf-field"><label>مشاكل العميل الأساسية</label><textarea id="npProblems"></textarea></div>
      <div class="cf-field"><label>ادعاءات مسموح بها</label><textarea id="npAllowed"></textarea></div>
      <div class="cf-field"><label>ادعاءات ممنوعة</label><textarea id="npForbidden"></textarea></div>
      <div class="cf-field"><label>سعر البيع (اختياري)</label><input id="npPrice" type="number"/></div>
      <div class="cf-field"><label>ملاحظات</label><textarea id="npNotes"></textarea></div>
      <button class="cf-btn primary" id="npSave">حفظ المنتج</button>`);
    $('npCat').onchange = (e) => { const o = opts.find((x) => String(x.ambProductId) === e.target.value); if (o && !$('npName').value) $('npName').value = o.name; };
    $('npSave').onclick = async () => {
      const g = (id) => $(id).value.trim();
      if (!g('npName')) return UI.toast('اسم المنتج مطلوب', 'error');
      const body = {
        ambProductId: Number($('npCat').value) || undefined,
        name: g('npName'), internalName: g('npInternal') || undefined, category: g('npCategory') || undefined,
        description: g('npDesc') || undefined, specifications: g('npSpecs') || undefined, benefits: g('npBenefits') || undefined,
        useCases: g('npUse') || undefined, targetAudience: g('npAud') || undefined, problems: g('npProblems') || undefined,
        allowedClaims: g('npAllowed') || undefined, forbiddenClaims: g('npForbidden') || undefined,
        sellingPrice: g('npPrice') ? Number(g('npPrice')) : undefined, notes: g('npNotes') || undefined,
      };
      try {
        const p = await api.post('/api/creative-factory/products', body);
        state.wiz.productId = p.id; closeDrawer(); UI.toast('تم إنشاء المنتج'); await renderNew($('cfView'));
      } catch (e) { UI.toast(e.message, 'error'); }
    };
  });
}

// ---- STEP: goal --------------------------------------------------------
function wizGoal(body) {
  const w = state.wiz;
  body.innerHTML = `<div class="cf-card"><h2>2) إيه اللي عايز تعمله؟</h2>
    <div class="cf-grid cards" style="margin-top:12px;">
      ${PROJECT_TYPE_CARDS.map((c) => `<div class="cf-choice ${w.projectType === c.key ? 'sel' : ''}" data-pt="${c.key}"><div class="ic">${c.ic}</div><div class="t">${E(c.t)}</div><div class="d">${E(c.d)}</div></div>`).join('')}
    </div>
    <div class="cf-actions">
      <button class="cf-btn ghost" id="cfBackP">→ رجوع</button>
      <button class="cf-btn primary" id="cfToCount" ${w.projectType ? '' : 'disabled'}>التالي: العدد ←</button>
    </div></div>`;
  body.querySelectorAll('[data-pt]').forEach((c) => { c.onclick = () => { w.projectType = c.dataset.pt; wizGoal(body); }; });
  $('cfBackP').onclick = () => goStep('product');
  $('cfToCount').onclick = () => goStep('count');
}

// ---- STEP: count + advanced ------------------------------------------
async function wizCount(body) {
  const w = state.wiz;
  const btns = state.status?.options?.imageCountButtons || [1, 2, 3, 4, 5, 10, 20, 50];
  const presets = state.status?.options?.stylePresets || [];
  const est = await api.post('/api/creative-factory/projects/estimate-cost', { count: w.count, generationMode: w.adv.generationMode }).catch(() => null);
  body.innerHTML = `<div class="cf-card">
    <h2>3) عدد الصور</h2>
    <div class="cf-count-btns" style="margin:12px 0;">
      ${btns.map((n) => `<button class="${w.countMode === 'MANUAL' && w.count === n ? 'sel' : ''}" data-cnt="${n}">${n}</button>`).join('')}
      <button class="${w.countMode === 'AI' ? 'sel' : ''}" data-cnt="ai" style="min-width:auto;padding:9px 14px;">✨ خلّي الـ AI يحدد</button>
    </div>
    ${w.countMode === 'AI' && w.aiReason ? `<div class="cf-banner info">أنصحك بـ <b>${w.count}</b> صورة — ${E(w.aiReason)}</div>` : ''}
    <div class="cf-muted">التكلفة التقديرية: <b>${E(est?.display || 'غير متاحة حاليًا')}</b></div>

    <details class="cf-collapse" style="margin-top:16px;">
      <summary>إعدادات متقدمة (اختياري)</summary>
      <div class="cf-row" style="margin-top:10px;">
        <div class="cf-field"><label>نمط التصميم</label><select data-adv="stylePreset">${presets.map((p) => `<option value="${p.key}" ${w.adv.stylePreset === p.key ? 'selected' : ''}>${E(p.label)}</option>`).join('')}</select></div>
        <div class="cf-field"><label>المقاس</label><select data-adv="aspectRatio">${(state.status.options.aspectRatios || ['1:1']).map((r) => `<option ${w.adv.aspectRatio === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
        <div class="cf-field"><label>كثافة النص</label><select data-adv="textDensity">${Object.entries(DENSITY_LABEL).map(([k, v]) => `<option value="${k}" ${w.adv.textDensity === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      </div>
      <div class="cf-row">
        <div class="cf-field"><label>الأشخاص</label><select data-adv="peopleRule">${Object.entries(PEOPLE_LABEL).map(([k, v]) => `<option value="${k}" ${w.adv.peopleRule === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="cf-field"><label>حجاب إلزامي</label><select data-adv="hijabRequired"><option value="false" ${!w.adv.hijabRequired ? 'selected' : ''}>لا</option><option value="true" ${w.adv.hijabRequired ? 'selected' : ''}>نعم</option></select></div>
        <div class="cf-field"><label>وضع الإنشاء</label><select data-adv="generationMode"><option value="FAST" ${w.adv.generationMode === 'FAST' ? 'selected' : ''}>سريع (FAST)</option><option value="PREMIUM" ${w.adv.generationMode === 'PREMIUM' ? 'selected' : ''}>مميز (PREMIUM — أفضل نسخة للهيرو)</option></select></div>
      </div>
      <div class="cf-row">
        <div class="cf-field"><label>السوق</label><input data-adv="market" value="${E(w.adv.market)}"/></div>
        <div class="cf-field"><label>اللغة</label><input data-adv="language" value="${E(w.adv.language)}"/></div>
        <div class="cf-field"><label>اللهجة</label><input data-adv="dialect" value="${E(w.adv.dialect)}"/></div>
      </div>
    </details>

    <div class="cf-actions">
      <button class="cf-btn ghost" id="cfBackG">→ رجوع</button>
      <button class="cf-btn primary" id="cfMakePlan">اقترح خطة الصور بالذكاء الاصطناعي ←</button>
    </div>
  </div>`;
  body.querySelectorAll('[data-cnt]').forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.cnt === 'ai') {
        w.countMode = 'AI';
        await ensureProject();
        try { const rec = await api.post(`/api/creative-factory/projects/${w.projectId}/recommend-count`, {}); w.count = rec.count; w.aiReason = rec.reason; }
        catch (e) { UI.toast(e.message, 'error'); }
      } else { w.countMode = 'MANUAL'; w.count = Number(b.dataset.cnt); w.aiReason = null; }
      wizCount(body);
    };
  });
  body.querySelectorAll('[data-adv]').forEach((el) => {
    el.onchange = () => {
      const k = el.dataset.adv;
      w.adv[k] = k === 'hijabRequired' ? el.value === 'true' : el.value;
      if (['generationMode'].includes(k)) wizCount(body);
    };
  });
  $('cfBackG').onclick = () => goStep('goal');
  $('cfMakePlan').onclick = async () => {
    const btn = $('cfMakePlan'); btn.disabled = true; btn.textContent = 'جاري تصميم الخطة…';
    try { await ensureProject(); const res = await api.post(`/api/creative-factory/projects/${w.projectId}/plan`, { count: w.count }); w.plan = res; goStep('plan'); }
    catch (e) { UI.toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'اقترح خطة الصور بالذكاء الاصطناعي ←'; }
  };
}

async function ensureProject() {
  const w = state.wiz;
  if (w.projectId) {
    // keep settings in sync — recreate only if type changed
    return;
  }
  const body = {
    productId: w.productId, projectType: w.projectType, quantity: w.count, quantityMode: w.countMode,
    aiQuantityReason: w.aiReason || undefined,
    stylePreset: w.adv.stylePreset, market: w.adv.market, language: w.adv.language, dialect: w.adv.dialect,
    aspectRatio: w.adv.aspectRatio, textDensity: w.adv.textDensity, peopleRule: w.adv.peopleRule,
    hijabRequired: w.adv.hijabRequired, generationMode: w.adv.generationMode, productLockMode: w.adv.productLockMode,
  };
  const p = await api.post('/api/creative-factory/projects', body);
  w.projectId = p.id; w.project = p;
}

// ---- STEP: plan -------------------------------------------------------
async function wizPlan(body) {
  const w = state.wiz;
  const proj = await api.get(`/api/creative-factory/projects/${w.projectId}`);
  w.project = proj;
  const est = await api.post('/api/creative-factory/projects/estimate-cost', { count: proj.items.length, generationMode: proj.generationMode }).catch(() => null);
  body.innerHTML = `<div class="cf-card">
    <h2>4) خطة الكرياتيفات (${proj.items.length} صورة)</h2>
    <div class="hint">راجع كل صورة — تقدر تعدّل الفكرة أو النص، تعيد الترتيب، تضيف أو تحذف. مفيش أي صورة هتتولد قبل الاعتماد.</div>
    <div id="cfPlanList">${proj.items.map((it, i) => planItemCard(it, i, proj.items.length)).join('')}</div>
    <button class="cf-btn sm ghost" id="cfAddItem">+ صورة</button>
    <div class="cf-actions">
      <button class="cf-btn ghost" id="cfBackC">→ رجوع للإعدادات</button>
      <button class="cf-btn ghost" id="cfReplan">↻ إعادة توليد الخطة</button>
      <span class="cf-muted">تقدير التكلفة: <b>${E(est?.display || 'غير متاحة حاليًا')}</b></span>
      <button class="cf-btn primary" id="cfApprovePlan">اعتماد الخطة وإنشاء الصور</button>
    </div>
  </div>`;
  wirePlanList(proj);
  $('cfBackC').onclick = () => goStep('count');
  $('cfReplan').onclick = async () => {
    if (!await UI.confirmModal({ title: 'إعادة توليد الخطة', message: 'هيتم استبدال عناصر الخطة الحالية بخطة جديدة.', confirmLabel: 'توليد', danger: true })) return;
    try { await api.post(`/api/creative-factory/projects/${w.projectId}/plan`, { count: proj.items.length }); wizPlan(body); } catch (e) { UI.toast(e.message, 'error'); }
  };
  $('cfAddItem').onclick = async () => { try { await api.post(`/api/creative-factory/projects/${w.projectId}/plan/items`, { purpose: 'صورة إضافية' }); wizPlan(body); } catch (e) { UI.toast(e.message, 'error'); } };
  $('cfApprovePlan').onclick = async () => {
    const btn = $('cfApprovePlan'); btn.disabled = true; btn.textContent = 'جاري بدء الإنشاء…';
    try {
      await api.post(`/api/creative-factory/projects/${w.projectId}/plan/approve`, {});
      const job = await api.post(`/api/creative-factory/projects/${w.projectId}/generate`, {});
      w.jobId = job.id; goStep('generate');
    } catch (e) { UI.toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'اعتماد الخطة وإنشاء الصور'; }
  };
}
function planItemCard(it, i, total) {
  return `<div class="cf-plan-item" data-item="${it.id}">
    <div class="ph">
      <span class="idx">${it.position}</span>
      <span class="purpose">${E(it.purpose || 'صورة')}</span>
      ${it.angle ? `<span class="angle">${E(it.angle)}</span>` : ''}
      <span class="sp">
        <button class="cf-btn sm ghost" data-mv="up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="cf-btn sm ghost" data-mv="down" ${i === total - 1 ? 'disabled' : ''}>↓</button>
        <button class="cf-btn sm ghost" data-edit>تعديل</button>
        <button class="cf-btn sm ghost" data-del style="color:var(--cf-red);">حذف</button>
      </span>
    </div>
    <div class="kv">
      ${it.scene ? `<div><b>المشهد:</b> ${E(it.scene)}</div>` : ''}
      ${it.cameraAngle ? `<div><b>زاوية الكاميرا:</b> ${E(it.cameraAngle)}</div>` : ''}
      ${it.composition ? `<div><b>التكوين:</b> ${E(it.composition)}</div>` : ''}
      ${it.background ? `<div><b>الخلفية:</b> ${E(it.background)}</div>` : ''}
      ${it.headline ? `<div><b>الهوك:</b> «${E(it.headline)}»</div>` : ''}
      ${(it.copy && it.copy.hook && it.copy.hook !== it.headline) ? `<div><b>نص:</b> «${E(it.copy.hook)}»</div>` : ''}
    </div>
    ${it.reason ? `<div class="reason">${E(it.reason)}</div>` : ''}
  </div>`;
}
function wirePlanList(proj) {
  const w = state.wiz;
  const list = $('cfPlanList');
  const ids = proj.items.map((x) => x.id);
  list.querySelectorAll('[data-item]').forEach((row) => {
    const id = Number(row.dataset.item);
    row.querySelector('[data-del]').onclick = async () => { try { await api.delete(`/api/creative-factory/projects/${w.projectId}/plan/items/${id}`); wizPlan($('cfWizBody')); } catch (e) { UI.toast(e.message, 'error'); } };
    row.querySelector('[data-edit]').onclick = () => editPlanItem(proj.items.find((x) => x.id === id));
    row.querySelectorAll('[data-mv]').forEach((b) => {
      b.onclick = async () => {
        const idx = ids.indexOf(id); const j = b.dataset.mv === 'up' ? idx - 1 : idx + 1;
        if (j < 0 || j >= ids.length) return;
        const order = ids.slice(); [order[idx], order[j]] = [order[j], order[idx]];
        try { await api.post(`/api/creative-factory/projects/${w.projectId}/plan/reorder`, { orderIds: order }); wizPlan($('cfWizBody')); } catch (e) { UI.toast(e.message, 'error'); }
      };
    });
  });
}
function editPlanItem(it) {
  const w = state.wiz;
  openDrawer(`<h2 style="margin-top:0;">تعديل الصورة ${it.position}</h2>
    <div class="cf-field"><label>الغرض</label><input id="eiPurpose" value="${E(it.purpose || '')}"/></div>
    <div class="cf-field"><label>الزاوية</label><input id="eiAngle" value="${E(it.angle || '')}"/></div>
    <div class="cf-field"><label>المشهد</label><textarea id="eiScene">${E(it.scene || '')}</textarea></div>
    <div class="cf-field"><label>زاوية الكاميرا</label><input id="eiCam" value="${E(it.cameraAngle || '')}"/></div>
    <div class="cf-field"><label>التكوين</label><input id="eiComp" value="${E(it.composition || '')}"/></div>
    <div class="cf-field"><label>الخلفية</label><input id="eiBg" value="${E(it.background || '')}"/></div>
    <div class="cf-field"><label>الهوك النصي</label><input id="eiHook" value="${E((it.copy && it.copy.hook) || it.headline || '')}"/></div>
    <div class="cf-field"><label>سطر مساند</label><input id="eiSub" value="${E((it.copy && it.copy.supportingLine) || it.supportingCopy || '')}"/></div>
    <div class="cf-field"><label>CTA</label><input id="eiCta" value="${E((it.copy && it.copy.cta) || it.cta || '')}"/></div>
    <button class="cf-btn primary" id="eiSave">حفظ</button>`);
  $('eiSave').onclick = async () => {
    const body = {
      purpose: $('eiPurpose').value, angle: $('eiAngle').value, scene: $('eiScene').value, cameraAngle: $('eiCam').value,
      composition: $('eiComp').value, background: $('eiBg').value, headline: $('eiHook').value,
      copy: { hook: $('eiHook').value, supportingLine: $('eiSub').value, cta: $('eiCta').value },
    };
    try { await api.patch(`/api/creative-factory/projects/${w.projectId}/plan/items/${it.id}`, body); closeDrawer(); wizPlan($('cfWizBody')); }
    catch (e) { UI.toast(e.message, 'error'); }
  };
}

// ---- STEP: generate -------------------------------------------------
async function wizGenerate(body) {
  const w = state.wiz;
  await paintGenerate(body);
  if (state.poll) clearInterval(state.poll);
  state.poll = setInterval(() => paintGenerate(body).catch(() => {}), 2500);
}
async function paintGenerate(body) {
  const w = state.wiz;
  const proj = await api.get(`/api/creative-factory/projects/${w.projectId}`);
  const job = proj.jobs[0] || null;
  const done = ['COMPLETED', 'PARTIAL_COMPLETE', 'FAILED', 'CANCELLED'].includes(job?.status);
  if (done && state.poll) { clearInterval(state.poll); state.poll = null; }
  const counts = { done: proj.items.filter((i) => i.status === 'COMPLETED').length, gen: proj.items.filter((i) => ['GENERATING', 'QUEUED', 'REVIEWING', 'REGENERATING'].includes(i.status)).length, rev: proj.items.filter((i) => i.status === 'NEEDS_REVIEW').length, fail: proj.items.filter((i) => i.status === 'FAILED').length };
  body.innerHTML = `<div class="cf-card">
    <h2>5) الإنشاء</h2>
    ${job ? `
      <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:6px;"><span>${statusText(job.status)}</span><span>${job.completedItems}/${job.totalItems}</span></div>
      <div class="cf-progress"><i style="width:${job.progress || 0}%"></i></div>
      <div class="cf-muted" style="margin-top:6px;">تم: ${counts.done} · قيد الإنشاء: ${counts.gen} · يحتاج مراجعة: ${counts.rev} · فشل: ${counts.fail}</div>
      ${job.status === 'FAILED' && job.error ? `<div class="cf-banner warn" style="margin-top:10px;">فشل إنشاء الصور: ${E(job.error)}</div>` : ''}
      ${job.status === 'COMPLETED' ? `<div class="cf-banner ok" style="margin-top:10px;">✅ تم إنشاء كل الصور بنجاح — راجعها في تبويب «النتائج».</div>` : ''}
    ` : '<div class="cf-muted">لم تبدأ بعد.</div>'}
    <div class="cf-grid gallery" style="margin-top:16px;">
      ${proj.items.map((it) => genItemTile(it)).join('')}
    </div>
    <div class="cf-actions">
      ${(counts.fail || counts.rev) && done ? `<button class="cf-btn" id="cfRetry">إعادة محاولة الفاشل/الناقص</button>` : ''}
      <a class="cf-btn ghost" href="#results">عرض النتائج</a>
      <button class="cf-btn ghost" id="cfNewAnother">مشروع جديد</button>
    </div>
  </div>`;
  proj.items.forEach((it) => {
    const t = body.querySelector(`[data-gi="${it.id}"]`);
    if (t && it.approvedAsset) t.onclick = () => openAssetDrawer(it.approvedAsset.id);
    else if (t && it.assets && it.assets.length) t.onclick = () => openAssetDrawer(it.assets[0].id);
  });
  if ($('cfRetry')) $('cfRetry').onclick = async () => { try { const j = await api.post(`/api/creative-factory/projects/${w.projectId}/retry-failed`, {}); w.jobId = j.id; wizGenerate(body); } catch (e) { UI.toast(e.message, 'error'); } };
  if ($('cfNewAnother')) $('cfNewAnother').onclick = () => { state.wiz = newWiz(); renderNew($('cfView')); };
}
function genItemTile(it) {
  const [lbl, cls] = ITEM_STATUS[it.status] || ['—', 'gray'];
  const a = it.approvedAsset || (it.assets && it.assets[0]);
  return `<div class="cf-tile" data-gi="${it.id}">
    ${a ? `<img class="thumb" src="/api/creative-factory/assets/${a.id}/image" loading="lazy"/>` : `<div class="thumb ph">${it.status === 'GENERATING' ? '⏳ جاري الإنشاء' : it.status === 'REGENERATING' ? '↻ إعادة المحاولة' : it.status === 'FAILED' ? '✕ فشل' : 'في الانتظار'}</div>`}
    <div class="body"><div class="top"><span style="font-weight:800;font-size:12px;">#${it.position}</span><span class="cf-badge ${cls}">${lbl}</span></div>
    <div class="hook">${E(it.purpose || '')}</div>
    ${a && a.quality ? `<div class="meta">جودة ${a.quality.overall ?? '—'} · تطابق ${a.quality.productAccuracy ?? '—'}</div>` : ''}
    </div></div>`;
}
function statusText(s) {
  return { QUEUED: 'في قائمة الانتظار…', GENERATING: 'جاري إنشاء الصور…', REVIEWING: 'فحص الجودة…', REGENERATING: 'إعادة المحاولة…', PARTIAL_COMPLETE: 'اكتمل جزئيًا', COMPLETED: 'اكتمل', FAILED: 'فشل', CANCELLED: 'أُلغي' }[s] || s;
}

// ===========================================================================
// TAB 2 — مشاريعي
// ===========================================================================
async function renderProjects(view) {
  const { projects } = await api.get('/api/creative-factory/projects');
  view.innerHTML = head('مشاريعي', `${projects.length} مشروع`) + providerBanner()
    + (projects.length ? `<div class="cf-grid cards">${projects.map(projectCard).join('')}</div>` : `<div class="cf-empty">مفيش مشاريع لسه. ابدأ من تبويب «إنشاء جديد».</div>`);
  view.querySelectorAll('[data-open]').forEach((c) => { c.onclick = () => openProject(Number(c.dataset.open)); });
}
function projectCard(p) {
  const st = { DRAFT: ['مسودة', 'gray'], PLANNING: ['تخطيط', 'violet'], PLAN_READY: ['الخطة جاهزة', 'violet'], QUEUED: ['في الانتظار', 'violet'], GENERATING: ['جاري الإنشاء', 'violet'], REVIEWING: ['فحص', 'violet'], PARTIAL_COMPLETE: ['اكتمل جزئيًا', 'amber'], COMPLETED: ['مكتمل', 'green'], FAILED: ['فشل', 'red'], CANCELLED: ['ملغي', 'gray'] }[p.status] || [p.status, 'gray'];
  const tc = PROJECT_TYPE_CARDS.find((x) => x.key === p.projectType);
  return `<div class="cf-choice" data-open="${p.id}" style="cursor:pointer;">
    <div style="display:flex;justify-content:space-between;align-items:start;"><div class="ic">${tc?.ic || '🎨'}</div><span class="cf-badge ${st[1]}">${st[0]}</span></div>
    <div class="t">${E(p.productName || 'مشروع')}</div>
    <div class="d">${E(tc?.t || p.projectType)} · ${p.completedItems || 0}/${p.itemCount || p.quantity} صورة</div>
    <div class="cf-muted" style="margin-top:6px;">${new Date(p.updatedAt).toLocaleDateString('ar-EG')}</div>
  </div>`;
}
async function openProject(id) {
  const p = await api.get(`/api/creative-factory/projects/${id}`);
  const running = ['QUEUED', 'GENERATING', 'REVIEWING', 'REGENERATING'].includes(p.status);
  openDrawer(`<h2 style="margin-top:0;">${E(p.productName || 'مشروع')} — ${E(p.projectType)}</h2>
    <div class="cf-muted">الحالة: ${E(p.status)} · ${p.items.length} صورة · نمط ${E(p.stylePreset || '—')} · قفل ${E(LOCK_LABEL[p.productLockMode] || p.productLockMode)}</div>
    <div class="cf-grid gallery" style="margin-top:14px;">${p.items.map(genItemTile).join('')}</div>
    <div class="cf-actions">
      ${state.isAdmin && ['DRAFT', 'PLAN_READY'].includes(p.status) ? `<button class="cf-btn primary" id="pjGenerate">بدء الإنشاء</button>` : ''}
      ${state.isAdmin && ['PARTIAL_COMPLETE', 'FAILED'].includes(p.status) ? `<button class="cf-btn" id="pjRetry">إعادة محاولة الفاشل</button>` : ''}
      ${state.isAdmin ? `<button class="cf-btn ghost" id="pjDup">تكرار المشروع</button>` : ''}
      ${state.isAdmin && p.status !== 'CANCELLED' ? `<button class="cf-btn ghost" id="pjArch" style="color:var(--cf-red);">أرشفة</button>` : ''}
    </div>`);
  $('cfDrawer').querySelectorAll('[data-gi]').forEach((t) => {
    const it = p.items.find((x) => String(x.id) === t.dataset.gi);
    const a = it?.approvedAsset || it?.assets?.[0];
    if (a) t.onclick = () => openAssetDrawer(a.id);
  });
  if ($('pjGenerate')) $('pjGenerate').onclick = async () => { try { await api.post(`/api/creative-factory/projects/${id}/plan/approve`, {}); await api.post(`/api/creative-factory/projects/${id}/generate`, {}); closeDrawer(); UI.toast('بدأ الإنشاء'); route(); } catch (e) { UI.toast(e.message, 'error'); } };
  if ($('pjRetry')) $('pjRetry').onclick = async () => { try { await api.post(`/api/creative-factory/projects/${id}/retry-failed`, {}); closeDrawer(); UI.toast('بدأت إعادة المحاولة'); route(); } catch (e) { UI.toast(e.message, 'error'); } };
  if ($('pjDup')) $('pjDup').onclick = async () => { try { await api.post(`/api/creative-factory/projects/${id}/duplicate`, {}); closeDrawer(); UI.toast('تم التكرار'); route(); } catch (e) { UI.toast(e.message, 'error'); } };
  if ($('pjArch')) $('pjArch').onclick = async () => { if (!await UI.confirmModal({ title: 'أرشفة المشروع', message: 'المشروع هيتنقل للأرشيف.', confirmLabel: 'أرشفة', danger: true })) return; try { await api.post(`/api/creative-factory/projects/${id}/archive`, {}); closeDrawer(); route(); } catch (e) { UI.toast(e.message, 'error'); } };
}

// ===========================================================================
// TAB 3 — النتائج (gallery)
// ===========================================================================
const results = { cursor: null, items: [], filter: {} };
async function renderResults(view) {
  results.cursor = null; results.items = [];
  view.innerHTML = head('النتائج', 'كل الكرياتيفات المُنشأة') + providerBanner()
    + `<div class="cf-row" style="margin-bottom:14px;">
        <div class="cf-field"><label>الحالة</label><select id="rfStatus"><option value="">الكل</option><option value="APPROVED">معتمدة</option><option value="PENDING_REVIEW">قيد المراجعة</option><option value="REJECTED">مرفوضة</option><option value="ARCHIVED">مؤرشفة</option></select></div>
      </div>
      <div class="cf-grid gallery" id="rfGrid"></div>
      <div style="text-align:center;margin-top:16px;"><button class="cf-btn" id="rfMore" hidden>عرض المزيد</button></div>`;
  $('rfStatus').onchange = () => { results.filter.status = $('rfStatus').value || undefined; results.cursor = null; results.items = []; $('rfGrid').innerHTML = ''; loadResults(); };
  $('rfMore').onclick = () => loadResults();
  await loadResults();
}
async function loadResults() {
  const q = { limit: 40, ...results.filter };
  if (results.cursor) q.cursor = results.cursor;
  const res = await api.get('/api/creative-factory/assets', q);
  results.items.push(...res.assets);
  results.cursor = res.nextCursor;
  const grid = $('rfGrid');
  grid.insertAdjacentHTML('beforeend', res.assets.map(galleryTile).join(''));
  grid.querySelectorAll('[data-asset]').forEach((t) => { if (!t.dataset.wired) { t.dataset.wired = '1'; t.onclick = () => openAssetDrawer(Number(t.dataset.asset)); } });
  $('rfMore').hidden = !results.cursor;
  if (!results.items.length) grid.innerHTML = '<div class="cf-empty">مفيش نتائج بعد.</div>';
}
function galleryTile(a) {
  const q = a.quality;
  const badge = a.status === 'APPROVED' ? '<span class="cf-badge green">معتمدة</span>' : a.status === 'REJECTED' ? '<span class="cf-badge red">مرفوضة</span>' : a.status === 'ARCHIVED' ? '<span class="cf-badge gray">مؤرشفة</span>' : '<span class="cf-badge amber">مراجعة</span>';
  return `<div class="cf-tile" data-asset="${a.id}">
    <img class="thumb" src="${E(a.imageUrl)}" loading="lazy"/>
    <div class="body"><div class="top"><span class="cf-badge violet">${E(a.projectType || '')}</span>${badge}</div>
    <div class="hook">${E(a.hook || a.purpose || '')}</div>
    <div class="meta">${a.angle ? E(a.angle) + ' · ' : ''}${q ? `جودة ${q.overall ?? '—'} · تطابق ${q.productAccuracy ?? '—'}` : 'بدون تقييم'}</div>
    </div></div>`;
}

async function openAssetDrawer(id) {
  openDrawer('<div class="cf-loading">تحميل…</div>');
  let a;
  try { a = await api.get(`/api/creative-factory/assets/${id}`); }
  catch (e) { $('cfDrawer').innerHTML = `<div class="cf-empty">⚠️ ${E(e.message)}</div>`; return; }
  const q = a.qualityFull;
  const sc = (k, lbl) => {
    const v = q?.scores?.[k]; if (v === null || v === undefined) return '';
    const cls = v >= 88 ? '' : v >= 70 ? 'mid' : 'low';
    return `<div class="cf-scorebar"><span class="lbl">${E(lbl)}</span><span class="track"><i class="${cls}" style="width:${v}%"></i></span><span class="val">${v}</span></div>`;
  };
  $('cfDrawer').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <h2 style="margin:0;">كرياتيف ${E(a.uuid.slice(0, 8))}</h2>
      <span class="cf-badge ${a.status === 'APPROVED' ? 'green' : a.status === 'REJECTED' ? 'red' : 'amber'}">${E(a.status)}</span>
    </div>
    <img src="${E(a.imageUrl)}" style="width:100%;border-radius:12px;margin:12px 0;background:var(--cf-bg);"/>
    <div class="cf-muted">${E(a.project?.type || '')} · ${E(a.planItem?.purpose || '')} ${a.planItem?.angle ? '· ' + E(a.planItem.angle) : ''} · وضع ${E(a.generationMode || '')}</div>
    ${a.copy?.hook ? `<div style="margin-top:8px;font-weight:700;">«${E(a.copy.hook)}»</div>` : ''}
    ${q ? `<div style="margin-top:14px;">
      <div style="font-weight:800;font-size:13px;margin-bottom:6px;">الجودة — إجمالي ${q.overall ?? '—'}${q.passed ? ' · <span style="color:var(--cf-green)">اجتاز</span>' : ' · <span style="color:var(--cf-amber)">يحتاج مراجعة</span>'}</div>
      ${sc('product_accuracy_score', 'تطابق المنتج')}${sc('identity_score', 'هوية المنتج')}${sc('visual_quality_score', 'الجودة البصرية')}${sc('composition_score', 'التكوين')}
      ${sc('marketing_score', 'وضوح الإعلان')}${sc('arabic_text_score', 'النص العربي')}${sc('claim_score', 'سلامة الادعاءات')}${sc('artifact_score', 'خلو من التشوه')}
      ${(q.failureReasons || []).length ? `<div class="cf-muted" style="margin-top:6px;">ملاحظات: ${q.failureReasons.map(E).join(' · ')}</div>` : ''}
    </div>` : '<div class="cf-muted" style="margin-top:12px;">لا يوجد تقييم آلي (الـ AII النصي غير متاح).</div>'}
    <div class="cf-actions">
      ${state.isAdmin && a.status !== 'APPROVED' ? `<button class="cf-btn primary sm" data-st="APPROVED">اعتماد</button>` : ''}
      ${state.isAdmin && a.status !== 'REJECTED' ? `<button class="cf-btn ghost sm" data-st="REJECTED">رفض</button>` : ''}
      ${state.isAdmin ? `<button class="cf-btn ghost sm" id="cfVary">Variation</button>` : ''}
      ${state.isAdmin ? `<button class="cf-btn ghost sm" id="cfFamily">شجرة العائلة</button>` : ''}
      <a class="cf-btn ghost sm" href="${E(a.imageUrl)}" target="_blank">فتح الصورة</a>
      <button class="cf-btn ghost sm" id="cfPrompt">عرض البرومبت</button>
    </div>
    <div id="cfPromptBox"></div>`;
  $('cfDrawer').querySelectorAll('[data-st]').forEach((b) => {
    b.onclick = async () => { try { await api.post(`/api/creative-factory/assets/${id}/status`, { status: b.dataset.st }); UI.toast('تم'); openAssetDrawer(id); if (state.tab === 'results') renderResults($('cfView')); } catch (e) { UI.toast(e.message, 'error'); } };
  });
  if ($('cfPrompt')) $('cfPrompt').onclick = () => { $('cfPromptBox').innerHTML = a.prompt ? `<pre style="white-space:pre-wrap;font-size:11px;background:var(--cf-bg);padding:10px;border-radius:8px;margin-top:10px;">${E(a.prompt)}</pre><div class="cf-muted">إصدار البرومبت ${a.promptVersion || 1}</div>` : '<div class="cf-muted" style="margin-top:8px;">لا يوجد برومبت محفوظ (الصورة لم تُنشأ فعليًا).</div>'; };
  if ($('cfVary')) $('cfVary').onclick = () => variationPrompt(id);
  if ($('cfFamily')) $('cfFamily').onclick = async () => {
    const fam = await api.get(`/api/creative-factory/assets/${id}/family`);
    $('cfPromptBox').innerHTML = `<div style="margin-top:10px;font-size:12px;"><b>الجذر:</b> #${fam.rootId ?? '—'}<br/>${(fam.edges || []).map((e) => `• ${E(e.type)} (جيل ${e.generation}) → ${e.childAssetId ? '#' + e.childAssetId : 'قيد الإنشاء'} — ${E(e.status)}`).join('<br/>') || 'لا اشتقاقات'}</div>`;
  };
}
function variationPrompt(parentId) {
  const types = [['SAME_CONCEPT', 'نفس الفكرة'], ['NEW_HOOK', 'هوك جديد'], ['NEW_COPY', 'نص جديد'], ['NEW_BACKGROUND', 'خلفية جديدة'], ['NEW_CAMERA_ANGLE', 'زاوية كاميرا'], ['NEW_ENVIRONMENT', 'بيئة جديدة'], ['NEW_AUDIENCE', 'جمهور مختلف'], ['NEW_STYLE', 'أسلوب مختلف'], ['NEW_ANGLE', 'زاوية رسالة جديدة']];
  $('cfPromptBox').innerHTML = `<div style="margin-top:12px;border-top:1px solid var(--cf-border);padding-top:12px;">
    <div class="cf-field"><label>نوع الـ Variation</label><select id="vType">${types.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
    <div class="cf-field"><label>العدد</label><select id="vCount"><option>1</option><option>2</option><option>3</option></select></div>
    <div class="cf-field"><label>تعليمات إضافية (اختياري)</label><input id="vNote"/></div>
    <button class="cf-btn primary sm" id="vGo">إنشاء Variation</button>
  </div>`;
  $('vGo').onclick = async () => {
    try { await api.post(`/api/creative-factory/assets/${parentId}/variations`, { variationType: $('vType').value, count: Number($('vCount').value), instructions: $('vNote').value || undefined }); UI.toast('بدأ إنشاء الـ Variation — تابعه في النتائج/المشروع.'); closeDrawer(); }
    catch (e) { UI.toast(e.message, 'error'); }
  };
}

// ===========================================================================
// TAB 4 — تعلّم الـ AI
// ===========================================================================
async function renderLearn(view) {
  const data = await api.get('/api/creative-factory/learning');
  const dims = data.dimensions || {};
  const DIM_LABEL = { HOOK: 'الهوكات', ANGLE: 'زوايا الرسالة', STYLE: 'الأساليب البصرية', CONCEPT: 'المفاهيم', FORMAT: 'الأنواع' };
  view.innerHTML = head('تعلّم الـ AI', 'أي هوك / زاوية / أسلوب بيجيب نتيجة أحسن — مع حجم عيّنة صريح، بدون استنتاج من بيانات ضعيفة')
    + `<div class="cf-card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div class="cf-muted">${data.linkedCreatives} كرياتيف مربوط بأداء · الحد الأدنى للعيّنة ${data.minSample}</div>
          <div style="display:flex;gap:8px;">
            ${state.isAdmin ? `<button class="cf-btn sm" id="lnLink">ربط كرياتيف بأداء</button><button class="cf-btn sm ghost" id="lnRecompute">إعادة حساب</button>` : ''}
          </div>
        </div>
      </div>
      ${Object.keys(dims).length ? Object.entries(dims).map(([dim, rows]) => `
        <div class="cf-card"><h2>${E(DIM_LABEL[dim] || dim)}</h2>
          ${rows.map((r) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--cf-border);font-size:12.5px;">
            <div><b>${E(r.key)}</b><div class="cf-muted">${E(r.verdict || '')}</div></div>
            <div style="text-align:end;white-space:nowrap;">CPA ${r.avgCpa ? Math.round(r.avgCpa) : '—'} · ROAS ${r.avgRoas ? r.avgRoas.toFixed(2) : '—'}<br/><span class="cf-muted">عيّنة ${r.sampleSize} · ثقة ${r.confidence ?? '—'}%</span></div>
          </div>`).join('')}
        </div>`).join('') : `<div class="cf-empty">مفيش بيانات كافية بعد. اربط الكرياتيفات المُنشأة بأداءها في Meta عشان الـ AI يتعلّم.</div>`}`;
  if ($('lnRecompute')) $('lnRecompute').onclick = async () => { try { const r = await api.post('/api/creative-factory/learning/recompute', {}); UI.toast(`تم — ${r.insights || 0} مؤشر`); renderLearn(view); } catch (e) { UI.toast(e.message, 'error'); } };
  if ($('lnLink')) $('lnLink').onclick = () => {
    openDrawer(`<h2 style="margin-top:0;">ربط كرياتيف بأداء Meta</h2>
      <div class="cf-field"><label>Creative ID (uuid)</label><input id="lkUuid"/></div>
      <div class="cf-field"><label>Meta Ad ID</label><input id="lkAd"/></div>
      <div class="cf-row"><div class="cf-field"><label>Spend</label><input id="lkSpend" type="number"/></div><div class="cf-field"><label>Purchases</label><input id="lkPur" type="number"/></div></div>
      <div class="cf-row"><div class="cf-field"><label>CPA</label><input id="lkCpa" type="number"/></div><div class="cf-field"><label>ROAS</label><input id="lkRoas" type="number"/></div><div class="cf-field"><label>CTR %</label><input id="lkCtr" type="number"/></div></div>
      <button class="cf-btn primary" id="lkSave">حفظ الربط</button>`);
    $('lkSave').onclick = async () => {
      try {
        await api.post('/api/creative-factory/learning/link', {
          assetUuid: $('lkUuid').value.trim(), metaAdId: $('lkAd').value.trim(),
          metrics: { spend: num($('lkSpend').value), purchases: num($('lkPur').value), cpa: num($('lkCpa').value), roas: num($('lkRoas').value), ctr: num($('lkCtr').value) },
        });
        closeDrawer(); UI.toast('تم الربط'); renderLearn(view);
      } catch (e) { UI.toast(e.message, 'error'); }
    };
  };
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : undefined; }

// ===========================================================================
// drawer
// ===========================================================================
function openDrawer(html) { $('cfDrawer').innerHTML = html; $('cfDrawerOverlay').classList.add('open'); }
function closeDrawer() { $('cfDrawerOverlay').classList.remove('open'); }

init();
