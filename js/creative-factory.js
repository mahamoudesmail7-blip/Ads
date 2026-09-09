// AI Creative Factory — page controller for creative-factory.html.
// RTL Arabic, premium light. Talks only to /api/creative-factory/* via the
// shared api-client. Four tabs: إنشاء جديد / مشاريعي / النتائج / تعلّم الـ AI.
//
// "إنشاء جديد" is a SINGLE-SCREEN workspace (no forced step pages): the three
// core cards (صور المنتج / مواصفات المنتج / إعدادات الصور) + the AI
// recommendation + the suggested sequence + the expected-result preview are
// all visible at once, and one "⚡ إنشاء الصور الآن" button runs the full
// existing backend pipeline (DNA → plan → claims → copy → prompts → jobs).
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const E = (s) => UI.escapeHtml(String(s ?? ''));
const $ = (id) => document.getElementById(id);
const fmtN = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US'));

const NAV = [
  { key: 'new', label: 'إنشاء جديد', icon: '✨' },
  { key: 'projects', label: 'مشاريعي', icon: '🗂️' },
  { key: 'results', label: 'النتائج', icon: '🖼️' },
  { key: 'learn', label: 'تعلّم الـ AI', icon: '📈' },
];

const PROJECT_TYPE_CARDS = [
  { key: 'PRODUCT_PAGE', ic: '📄', t: 'صور صفحة المنتج', d: 'مجموعة صور مترابطة ومتكاملة' },
  { key: 'META_ADS', ic: '🎯', t: 'صور بوستات / إعلانات', d: 'صور إعلانية مستقلة ومتنوعة' },
  { key: 'SOCIAL', ic: '📱', t: 'بوستات سوشيال', d: 'منشورات جاهزة' },
  { key: 'RETARGETING', ic: '🔁', t: 'إعادة استهداف', d: 'صور للريتارجت' },
  { key: 'VARIATIONS', ic: '🧬', t: 'Variations', d: 'اشتقاقات من فكرة' },
  { key: 'CUSTOM', ic: '🎨', t: 'صورة مخصصة', d: 'حسب طلبك' },
];
const LOCK_LABEL = { STRICT: 'صارم', BALANCED: 'متوازن', CREATIVE: 'إبداعي' };
const DENSITY_LABEL = { MINIMAL: 'قليل جدًا', LOW: 'قليل', MEDIUM: 'متوسط' };
const PEOPLE_LABEL = { NONE: 'بدون أشخاص', MEN: 'رجال', WOMEN: 'سيدات', AI_CHOICE: 'حسب فكرة الـ AI' };
const ITEM_STATUS = {
  PLANNED: ['في الانتظار', 'gray'], QUEUED: ['في الانتظار', 'gray'], GENERATING: ['جاري إنشاء الصورة', 'violet'],
  REVIEWING: ['جاري فحص الجودة', 'violet'], REGENERATING: ['إعادة المحاولة', 'amber'],
  COMPLETED: ['تم', 'green'], NEEDS_REVIEW: ['يحتاج مراجعة', 'amber'], FAILED: ['فشل', 'red'],
};
const AUDIENCE_CHIPS = ['سيدات', 'رجال', 'أطفال', 'العناية بالشعر', 'السيارات', 'المنزل'];
const STYLE_CHIPS = [
  { k: 'WHITE_BG', t: 'خلفية بيضاء' }, { k: 'LIFESTYLE', t: 'لايف ستايل' }, { k: 'INFOGRAPHIC', t: 'إنفوجرافيك' },
  { k: 'BEFORE_AFTER', t: 'قبل / بعد' }, { k: 'FEATURES', t: 'مميزات' }, { k: 'SIZES', t: 'مقاسات' },
  { k: 'HIJAB', t: 'بنت محجبة' },
];

const state = {
  tab: 'new', me: null, isAdmin: false, status: null,
  ws: null,            // single-screen "إنشاء جديد" workspace state
  poll: null,
  saveTimers: {},
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
  const rid = (state.rid = (state.rid || 0) + 1); // guards a slow render from clobbering a newer one
  const run = { new: renderNew, projects: renderProjects, results: renderResults, learn: renderLearn }[state.tab];
  run(view, rid).catch((err) => { if (state.rid === rid) view.innerHTML = `<div class="cf-empty">⚠️ ${E(err.message || err)}</div>`; });
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
// TAB 1 — إنشاء جديد  (single-screen workspace)
// ===========================================================================
const LS_KEY = 'cf_ws_v2';
function newWs() {
  const s = state.status?.settings || {};
  return {
    productId: null, product: null,
    projectId: null, project: null,
    imageType: 'PRODUCT_PAGE',
    count: 5, countMode: 'MANUAL', aiCountReason: null,
    specsText: '',
    audience: new Set(), audienceCustom: '',
    styles: new Set(['WHITE_BG', 'FEATURES']),
    adv: {
      productLockMode: s.cfDefaultProductLockMode || 'STRICT',
      generationMode: s.cfDefaultGenerationMode || 'FAST',
      textDensity: s.cfDefaultTextDensity || 'MINIMAL',
      peopleRule: s.cfDefaultPeopleRule || 'NONE',
      hijabRequired: !!s.cfHijabRequiredDefault,
      market: s.cfDefaultMarket || 'EG', language: s.cfDefaultLanguage || 'ar', dialect: s.cfDefaultDialect || 'egyptian',
      stylePreset: s.cfDefaultStylePreset || 'EGY_ECOM', aspectRatio: '1:1',
    },
    plan: null, jobId: null, savedAt: null, phase: 'setup', // setup | generating
  };
}

function wsPersist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ productId: state.ws.productId, projectId: state.ws.projectId })); } catch { /* ignore */ }
}
async function wsResume() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { /* ignore */ }
  const ws = newWs();
  if (saved?.projectId) {
    try {
      const p = await api.get(`/api/creative-factory/projects/${saved.projectId}`);
      if (p && !p.archivedAt && !['COMPLETED', 'CANCELLED'].includes(p.status)) {
        ws.projectId = p.id; ws.project = p; ws.productId = p.productId;
        ws.imageType = p.projectType; ws.count = p.quantity; ws.countMode = p.quantityMode;
        ws.aiCountReason = p.aiQuantityReason || null;
        ws.adv = { ...ws.adv, productLockMode: p.productLockMode, generationMode: p.generationMode, textDensity: p.textDensity, peopleRule: p.peopleRule, hijabRequired: p.hijabRequired, market: p.market, language: p.language, dialect: p.dialect, stylePreset: p.stylePreset || ws.adv.stylePreset, aspectRatio: p.aspectRatio };
        ws.styles = new Set(parseStyleNotes(p.planNotes));
        if (p.items && p.items.length) ws.plan = { items: p.items };
        if (['QUEUED', 'GENERATING', 'REVIEWING', 'REGENERATING', 'PARTIAL_COMPLETE', 'FAILED'].includes(p.status) && p.jobs?.[0]) { ws.jobId = p.jobs[0].id; if (['QUEUED', 'GENERATING', 'REVIEWING', 'REGENERATING'].includes(p.status)) ws.phase = 'generating'; }
      }
    } catch { /* stale — start fresh */ }
  }
  if (!ws.productId && saved?.productId) {
    try { await api.get(`/api/creative-factory/products/${saved.productId}`); ws.productId = saved.productId; } catch { /* ignore */ }
  }
  if (ws.productId) {
    try {
      ws.product = await api.get(`/api/creative-factory/products/${ws.productId}`);
      ws.specsText = ws.product.specifications || ws.product.benefits || '';
      ws.audience = new Set(String(ws.product.targetAudience || '').split(/[،,]+/).map((x) => x.trim()).filter(Boolean).filter((x) => AUDIENCE_CHIPS.includes(x)));
      ws.audienceCustom = String(ws.product.targetAudience || '').split(/[،,]+/).map((x) => x.trim()).filter((x) => x && !AUDIENCE_CHIPS.includes(x)).join('، ');
    } catch { ws.productId = null; }
  }
  return ws;
}
function parseStyleNotes(notes) {
  if (!notes) return ['WHITE_BG', 'FEATURES'];
  const found = STYLE_CHIPS.filter((c) => notes.includes(c.t)).map((c) => c.k);
  return found.length ? found : [];
}
function styleNotesString(ws) {
  const labels = STYLE_CHIPS.filter((c) => ws.styles.has(c.k)).map((c) => c.t);
  return labels.length ? `أساليب بصرية مفضّلة للمالك: ${labels.join('، ')}. اختر لكل صورة الأنسب منها.` : '';
}

function wsStage(ws) {
  const refs = ws.product?.referenceImages?.length || 0;
  const minRefs = ws.product?.limits?.minReferenceImages || 3;
  if (ws.phase === 'generating' || ws.jobId) return 5;
  if (ws.plan?.items?.length) return 4;
  if (ws.productId && refs >= minRefs && ws.specsText.trim()) return 3;
  if (ws.productId && refs >= minRefs) return 2;
  return 1;
}

async function renderNew(view, rid) {
  if (needAdmin(view)) return;
  if (!state.ws) state.ws = await wsResume();
  if (rid !== undefined && state.rid !== rid) return; // a newer tab switch won
  const ws = state.ws;
  const stage = wsStage(ws);
  const STEPS = [
    ['المنتج', 'أضف صور المنتج والمعلومات'],
    ['الهدف', 'اختر نوع الصور'],
    ['العدد', 'حدد عدد الصور'],
    ['الخطة', 'راجع خطة الصور'],
    ['الإنشاء', 'توليد الصور ومراجعة النتائج'],
  ];
  view.innerHTML = `
    <div class="cf-head cf-head-hero">
      <div>
        <h1>✨ مصنع الكرياتيفات</h1>
        <div class="sub">حوّل صور منتجك إلى كرياتيفات جاهزة للبيع</div>
      </div>
      <div class="cf-hero-badge">📊 صور مصممة خصيصًا لسوقك ومنتجك</div>
    </div>
    ${providerBanner()}
    <div class="cf-stepper">
      ${STEPS.map((s, i) => `<div class="cf-stepbox ${i + 1 === stage ? 'on' : i + 1 < stage ? 'done' : ''}">
        <div class="n">${i + 1 < stage ? '✓' : i + 1}</div>
        <div><div class="t">${E(s[0])}</div><div class="d">${E(s[1])}</div></div>
      </div>`).join('')}
    </div>
    <div id="cfSaveTag" class="cf-savetag" ${ws.savedAt ? '' : 'hidden'}>✓ تم الحفظ تلقائيًا</div>
    <div id="cfWorkspace"></div>`;
  await paintWorkspace();
}

async function paintWorkspace() {
  const ws = state.ws;
  const zone = $('cfWorkspace');
  if (ws.phase === 'generating' || (ws.jobId && ws.plan)) { await wsPaintGenerate(zone); return; }

  zone.innerHTML = `
    <div class="cf-ws-grid">
      <div class="cf-ws-card" id="cfCardImages"></div>
      <div class="cf-ws-card" id="cfCardSpecs"></div>
      <div class="cf-ws-card" id="cfCardSettings"></div>
    </div>
    <div class="cf-reco" id="cfReco"></div>
    <div id="cfPreview"></div>`;
  await Promise.all([paintCardImages(), paintCardSpecs(), paintCardSettings()]);
  paintReco();
  paintPreview();
}

// ---- CARD A — product images -----------------------------------------
async function paintCardImages() {
  const ws = state.ws;
  const box = $('cfCardImages');
  if (!box) return;
  if (!ws.productId) {
    const { products } = await api.get('/api/creative-factory/products');
    box.innerHTML = `<h2>صور المنتج</h2><div class="hint">اختر منتجًا موجودًا أو أضِف منتجًا جديدًا لبدء الرفع.</div>
      <div class="cf-field"><label>منتج موجود</label><select id="cfProdSel"><option value="">— اختر —</option>${products.map((p) => `<option value="${p.id}">${E(p.name)} · ${p.referenceImageCount} صورة</option>`).join('')}</select></div>
      <button class="cf-btn primary" id="cfNewProd" style="width:100%;">+ منتج جديد</button>`;
    $('cfProdSel').onchange = async (e) => { const id = Number(e.target.value) || null; if (id) { ws.productId = id; ws.product = await api.get(`/api/creative-factory/products/${id}`); ws.specsText = ws.product.specifications || ws.product.benefits || ''; wsPersist(); paintWorkspace(); renderStepper(); } };
    $('cfNewProd').onclick = () => openNewProductForm();
    return;
  }
  const p = ws.product || (ws.product = await api.get(`/api/creative-factory/products/${ws.productId}`));
  const refs = p.referenceImages || [];
  const min = p.limits.minReferenceImages, max = p.limits.maxReferenceImages;
  const dnaOk = p.dna && p.dna.source !== 'UNAVAILABLE';
  box.innerHTML = `
    <div class="cf-ws-cardhead"><h2>صور المنتج</h2><span class="cf-badge ${refs.length >= min ? 'green' : 'amber'}">${refs.length >= min ? refs.length + ' صور' : min + ' صور مطلوبة'}</span></div>
    <div class="cf-refs">
      ${refs.map((r, i) => `<div class="cf-ref" data-ref="${r.id}">
        <img src="/api/creative-factory/products/${ws.productId}/reference-images/${r.id}/image" loading="lazy"/>
        <div class="meta">
          <button data-mv="up" ${i === 0 ? 'disabled' : ''} title="لليمين">↑</button>
          <button data-mv="down" ${i === refs.length - 1 ? 'disabled' : ''} title="لليسار">↓</button>
          <button data-rep="${r.id}" title="استبدال">⇄</button>
          <button data-del="${r.id}" class="del" title="حذف">✕</button>
        </div>
      </div>`).join('')}
      ${refs.length < max ? `<button class="cf-addref" id="cfAddRef">+<span>إضافة صورة أخرى</span></button>` : ''}
    </div>
    <input type="file" id="cfFile" accept="image/png,image/jpeg,image/webp" multiple hidden />
    <input type="file" id="cfFileRep" accept="image/png,image/jpeg,image/webp" hidden />
    <div class="cf-muted" style="margin-top:8px;">ارفع من ${min} إلى ${max} صور واضحة من زوايا مختلفة للمنتج — JPG / PNG / WEBP</div>
    <div class="cf-understood ${dnaOk ? 'ok' : ''}" id="cfUnderstood">
      ${dnaOk ? '✓ تم فهم المنتج — <span class="lnk">عرض التفاصيل</span>' : (refs.length >= min && state.ws.specsText.trim() ? '<span class="lnk">تحليل المنتج الآن</span>' : 'أضِف الصور والمواصفات ليفهم النظام المنتج')}
    </div>`;
  // wiring
  const filEl = $('cfFile'); let repId = null;
  $('cfAddRef') && ($('cfAddRef').onclick = () => filEl.click());
  filEl.onchange = () => uploadRefs(filEl.files);
  $('cfFileRep').onchange = () => { if (repId) replaceRef(repId, $('cfFileRep').files[0]); };
  box.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { try { await api.delete(`/api/creative-factory/products/${ws.productId}/reference-images/${b.dataset.del}`); await reloadProduct(); paintWorkspace(); renderStepper(); } catch (e) { UI.toast(e.message, 'error'); } });
  box.querySelectorAll('[data-rep]').forEach((b) => b.onclick = () => { repId = Number(b.dataset.rep); $('cfFileRep').click(); });
  box.querySelectorAll('[data-mv]').forEach((b) => b.onclick = async () => {
    const ids = refs.map((r) => r.id); const row = b.closest('[data-ref]'); const idx = ids.indexOf(Number(row.dataset.ref));
    const j = b.dataset.mv === 'up' ? idx - 1 : idx + 1; if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    try { await api.post(`/api/creative-factory/products/${ws.productId}/reference-images/reorder`, { orderIds: ids }); await reloadProduct(); paintCardImages(); } catch (e) { UI.toast(e.message, 'error'); }
  });
  const uEl = $('cfUnderstood');
  uEl.querySelector('.lnk') && (uEl.querySelector('.lnk').onclick = () => dnaOk ? openDnaDrawer() : runAnalyze());
}
async function reloadProduct() {
  const ws = state.ws;
  ws.product = await api.get(`/api/creative-factory/products/${ws.productId}`);
}
async function uploadRefs(fileList) {
  const ws = state.ws;
  for (const f of [...(fileList || [])].slice(0, 6)) {
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { UI.toast(`${f.name}: نوع غير مدعوم`, 'error'); continue; }
    try {
      const dataUrl = await readAsDataUrl(f);
      await api.post(`/api/creative-factory/products/${ws.productId}/reference-images`, { dataUrl, angleLabel: '' });
    } catch (e) { UI.toast(`${f.name}: ${e.message}`, 'error'); }
  }
  await reloadProduct(); paintWorkspace(); renderStepper();
}
async function replaceRef(refId, file) {
  if (!file) return;
  const ws = state.ws;
  try {
    const dataUrl = await readAsDataUrl(file);
    await api.post(`/api/creative-factory/products/${ws.productId}/reference-images`, { dataUrl, angleLabel: '' });
    await api.delete(`/api/creative-factory/products/${ws.productId}/reference-images/${refId}`);
    await reloadProduct(); paintCardImages();
  } catch (e) { UI.toast(e.message, 'error'); }
}
function readAsDataUrl(f) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(f); }); }

async function runAnalyze() {
  const ws = state.ws;
  const uEl = $('cfUnderstood'); if (uEl) uEl.innerHTML = '⏳ جاري فهم المنتج…';
  try {
    // make sure the latest specs are saved so DNA analysis sees them
    await wsSaveProductNow();
    await api.post(`/api/creative-factory/products/${ws.productId}/dna/analyze`, {});
    await reloadProduct();
    UI.toast('تم فهم المنتج');
  } catch (e) { UI.toast(e.message, 'error'); }
  paintCardImages(); paintPreview();
}

// ---- CARD B — product info -----------------------------------------
async function paintCardSpecs() {
  const ws = state.ws;
  const box = $('cfCardSpecs'); if (!box) return;
  const disabled = ws.productId ? '' : 'disabled';
  box.innerHTML = `
    <h2>مواصفات المنتج</h2>
    <div class="hint">اكتب المعلومات ببساطة — النظام يرتّبها داخليًا (Product DNA).</div>
    <div class="cf-field">
      <label>اكتب مواصفات ومميزات المنتج</label>
      <textarea id="cfSpecs" ${disabled} rows="7" placeholder="مثال:
• فرشاة شعر مع بخاخ ماء مدمج
• تساعد أثناء التسريح وتقلل الهيشان
• تصميم عملي خفيف وسهل الحمل
• مناسبة للاستخدام اليومي والسفر">${E(ws.specsText)}</textarea>
    </div>
    <div class="cf-field">
      <label>الجمهور المستهدف</label>
      <div class="cf-chips" id="cfAud">
        ${AUDIENCE_CHIPS.map((a) => `<button class="cf-chip ${ws.audience.has(a) ? 'on' : ''}" data-aud="${E(a)}">${E(a)}</button>`).join('')}
        <button class="cf-chip ${ws.audienceCustom ? 'on' : ''}" data-aud="__custom">أخرى…</button>
      </div>
      <input id="cfAudCustom" class="cf-audcustom" placeholder="جمهور مخصص (افصل بفاصلة)" value="${E(ws.audienceCustom)}" ${ws.audienceCustom ? '' : 'hidden'} ${disabled}/>
    </div>
    <div class="cf-muted">السوق الافتراضي: <b>مصر</b> — تقدر تغيّره من «إعدادات متقدمة».</div>
    ${disabled ? '<div class="cf-muted" style="margin-top:6px;color:var(--cf-amber);">اختر منتجًا أولاً من بطاقة «صور المنتج».</div>' : ''}`;
  if (disabled) return;
  const ta = $('cfSpecs');
  ta.oninput = () => { ws.specsText = ta.value; scheduleSaveProduct(); };
  $('cfAud').querySelectorAll('[data-aud]').forEach((b) => b.onclick = () => {
    const v = b.dataset.aud;
    if (v === '__custom') { const inp = $('cfAudCustom'); inp.hidden = !inp.hidden; b.classList.toggle('on', !inp.hidden || !!inp.value); if (!inp.hidden) inp.focus(); }
    else { ws.audience.has(v) ? ws.audience.delete(v) : ws.audience.add(v); b.classList.toggle('on'); }
    scheduleSaveProduct();
  });
  $('cfAudCustom').oninput = () => { ws.audienceCustom = $('cfAudCustom').value; scheduleSaveProduct(); };
}

// ---- CARD C — creative settings -----------------------------------
async function paintCardSettings() {
  const ws = state.ws;
  const box = $('cfCardSettings'); if (!box) return;
  const btns = state.status?.options?.imageCountButtons || [1, 2, 3, 4, 5, 10, 20, 50];
  box.innerHTML = `
    <h2>نوع الصور</h2>
    <div class="cf-typecards">
      ${PROJECT_TYPE_CARDS.slice(0, 2).map((c) => `<button class="cf-typecard ${ws.imageType === c.key ? 'sel' : ''}" data-type="${c.key}">
        <div class="ic">${c.ic}</div><div class="t">${E(c.t)}</div><div class="d">${E(c.d)}</div>
        <span class="tick">✓</span>
      </button>`).join('')}
    </div>

    <div class="cf-sec-label">عدد الصور المطلوبة</div>
    <div class="cf-count-btns" id="cfCount">
      ${btns.map((n) => `<button class="${ws.countMode === 'MANUAL' && ws.count === n ? 'sel' : ''}" data-cnt="${n}">${n}</button>`).join('')}
    </div>
    <button class="cf-btn ghost sm" id="cfAiCount" style="margin-top:8px;">✨ اقترح العدد بالذكاء الاصطناعي</button>
    ${ws.countMode === 'AI' && ws.aiCountReason ? `<div class="cf-muted" style="margin-top:6px;">✨ اقترح ${ws.count} — ${E(ws.aiCountReason)}</div>` : ''}

    <div class="cf-sec-label">أسلوب الصور <span class="cf-muted">(تفضيلات — الـ AI يختار الأنسب لكل صورة)</span></div>
    <div class="cf-chips" id="cfStyles">
      ${STYLE_CHIPS.map((c) => `<button class="cf-chip ${ws.styles.has(c.k) ? 'on' : ''}" data-style="${c.k}">${E(c.t)}</button>`).join('')}
    </div>

    <button class="cf-btn primary cf-gen-btn" id="cfGenNow">⚡ إنشاء الصور الآن</button>
    <details class="cf-collapse" id="cfAdvBox"><summary>إعدادات متقدمة</summary><div id="cfAdv"></div></details>`;

  box.querySelectorAll('[data-type]').forEach((b) => b.onclick = () => {
    ws.imageType = b.dataset.type;
    if (ws.imageType === 'PRODUCT_PAGE' && ws.countMode === 'MANUAL' && ![1, 2, 3, 4, 5, 10, 20, 50].includes(ws.count)) ws.count = 5;
    ws.plan = null;
    paintCardSettings(); paintPreview(); renderStepper(); scheduleSaveProject();
  });
  $('cfCount').querySelectorAll('[data-cnt]').forEach((b) => b.onclick = () => {
    ws.countMode = 'MANUAL'; ws.count = Number(b.dataset.cnt); ws.aiCountReason = null; ws.plan = null;
    paintCardSettings(); paintPreview(); scheduleSaveProject();
  });
  $('cfAiCount').onclick = async () => {
    const btn = $('cfAiCount'); btn.disabled = true; btn.textContent = '… جاري الاقتراح';
    try {
      await wsEnsureProject();
      const rec = await api.post(`/api/creative-factory/projects/${ws.projectId}/recommend-count`, {});
      ws.countMode = 'AI'; ws.count = rec.count; ws.aiCountReason = rec.reason; ws.plan = null;
      ws.rec = rec;
      paintCardSettings(); paintReco(); paintPreview(); scheduleSaveProject();
    } catch (e) { UI.toast(e.message, 'error'); btn.disabled = false; btn.textContent = '✨ اقترح العدد بالذكاء الاصطناعي'; }
  };
  $('cfStyles').querySelectorAll('[data-style]').forEach((b) => b.onclick = () => {
    const k = b.dataset.style;
    ws.styles.has(k) ? ws.styles.delete(k) : ws.styles.add(k);
    if (k === 'HIJAB') { ws.adv.hijabRequired = ws.styles.has('HIJAB'); if (ws.styles.has('HIJAB') && ws.adv.peopleRule === 'NONE') ws.adv.peopleRule = 'WOMEN'; }
    b.classList.toggle('on'); ws.plan = null; scheduleSaveProject();
  });
  $('cfGenNow').onclick = wsGenerateNow;
  $('cfAdvBox').ontoggle = () => { if ($('cfAdvBox').open) paintAdv(); };
}

function paintAdv() {
  const ws = state.ws;
  const box = $('cfAdv'); if (!box) return;
  const presets = state.status?.options?.stylePresets || [];
  box.innerHTML = `
    <div class="cf-row">
      <div class="cf-field"><label>قفل المنتج</label><select data-adv="productLockMode">${Object.entries(LOCK_LABEL).map(([k, v]) => `<option value="${k}" ${ws.adv.productLockMode === k ? 'selected' : ''}>${v}${k === 'STRICT' ? ' (افتراضي)' : ''}</option>`).join('')}</select></div>
      <div class="cf-field"><label>وضع الإنشاء</label><select data-adv="generationMode"><option value="FAST" ${ws.adv.generationMode === 'FAST' ? 'selected' : ''}>Fast</option><option value="PREMIUM" ${ws.adv.generationMode === 'PREMIUM' ? 'selected' : ''}>Premium</option></select></div>
      <div class="cf-field"><label>كثافة النص</label><select data-adv="textDensity">${Object.entries(DENSITY_LABEL).map(([k, v]) => `<option value="${k}" ${ws.adv.textDensity === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="cf-row">
      <div class="cf-field"><label>الأشخاص</label><select data-adv="peopleRule">${Object.entries(PEOPLE_LABEL).map(([k, v]) => `<option value="${k}" ${ws.adv.peopleRule === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="cf-field"><label>نمط أساسي</label><select data-adv="stylePreset">${presets.map((p) => `<option value="${p.key}" ${ws.adv.stylePreset === p.key ? 'selected' : ''}>${E(p.label)}</option>`).join('')}</select></div>
      <div class="cf-field"><label>المقاس</label><select data-adv="aspectRatio">${(state.status.options.aspectRatios || ['1:1']).map((r) => `<option ${ws.adv.aspectRatio === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
    </div>
    <div class="cf-row">
      <div class="cf-field"><label>السوق</label><input data-adv="market" value="${E(ws.adv.market)}"/></div>
      <div class="cf-field"><label>اللغة</label><input data-adv="language" value="${E(ws.adv.language)}"/></div>
      <div class="cf-field"><label>اللهجة</label><input data-adv="dialect" value="${E(ws.adv.dialect)}"/></div>
    </div>
    ${state.isAdmin ? `<div class="cf-row"><div class="cf-field"><label>حد الجودة للاعتماد التلقائي</label><input id="cfQt" type="number" min="50" max="100" value="${state.status.settings?.cfQualityThreshold ?? 88}"/></div></div>` : ''}`;
  box.querySelectorAll('[data-adv]').forEach((el) => el.onchange = () => {
    const k = el.dataset.adv; ws.adv[k] = el.value; ws.plan = null; scheduleSaveProject();
  });
  if ($('cfQt')) $('cfQt').onchange = async () => {
    const v = Math.max(50, Math.min(100, Number($('cfQt').value) || 88));
    try { await api.patch('/api/creative-factory/settings', { cfQualityThreshold: v }); state.status.settings.cfQualityThreshold = v; UI.toast('تم حفظ حد الجودة'); } catch (e) { UI.toast(e.message, 'error'); }
  };
}

// ---- AI recommendation panel ---------------------------------------
function recoBullets(ws) {
  const t = (ws.specsText || '').toLowerCase();
  const lines = (ws.specsText || '').split(/\n|•|-|•/).map((s) => s.trim()).filter((s) => s.length > 2);
  const out = [];
  if (lines.length >= 3) out.push('المنتج يحتوي على عدة مميزات تحتاج شرح بصري');
  if (/قبل|بعد|before|after|تجعد|فرد|هيشان|نتيج|تحسين/.test(t)) out.push('صورة قبل / بعد قد تساعد في توضيح الفكرة');
  if (lines.length) out.push('صور المميزات تساعد العميل على فهم المنتج');
  if (/علب|كرتون|packaging|box|تغليف|صندوق/.test(t)) out.push('صورة المنتج والعبوة تزيد وضوح ما سيستلمه العميل');
  if (!out.length) out.push('صورة رئيسية واضحة + صورة تفاصيل تكفي لبداية قوية');
  return out.slice(0, 4);
}
function paintReco() {
  const ws = state.ws;
  const box = $('cfReco'); if (!box) return;
  const typeLabel = ws.imageType === 'PRODUCT_PAGE' ? 'صفحة المنتج' : 'إعلانات';
  const reason = ws.rec?.reason || (ws.countMode === 'AI' ? ws.aiCountReason : null);
  box.innerHTML = `
    <div class="cf-reco-main">
      <div class="cf-reco-head"><span class="bot">🤖</span><h2>اقتراح الذكاء الاصطناعي</h2><span class="cf-badge violet">مناسب ✨</span></div>
      <p class="cf-reco-lead">بناءً على نوع المنتج ومميزاته، أنصحك بإنشاء <b>${ws.count}</b> ${ws.count > 10 ? 'صورة' : 'صور'} ${typeLabel === 'صفحة المنتج' ? 'لصفحة المنتج' : 'إعلانية'}.</p>
      ${reason ? `<p class="cf-muted">${E(reason)}</p>` : ''}
      <ul class="cf-reco-why">${recoBullets(ws).map((b) => `<li>✓ ${E(b)}</li>`).join('')}</ul>
      <p class="cf-reco-note">هذا العدد يحقق توازن بين الشرح والإقناع.</p>
    </div>
    <div class="cf-seq">
      <h3>التسلسل المقترح للصور</h3>
      <ol id="cfSeqList">${seqRows(ws)}</ol>
      ${ws.plan?.items?.length ? '<div class="cf-muted">التسلسل الفعلي من مخطط الـ AI.</div>' : '<button class="cf-btn ghost sm" id="cfShowPlan" style="margin-top:8px;">عرض الخطة الفعلية</button>'}
    </div>`;
  if ($('cfShowPlan')) $('cfShowPlan').onclick = wsShowPlan;
}
function seqRows(ws) {
  const items = ws.plan?.items?.length ? ws.plan.items : previewSequence(ws.imageType, ws.count);
  return items.map((it, i) => `<li><span class="sn">${i + 1}</span><span>${E(it.purpose || it.label || 'صورة')}${it.angle ? ` <span class="cf-muted">(${E(it.angle)})</span>` : ''}</span></li>`).join('');
}
function previewSequence(type, count) {
  const n = Math.max(1, count);
  if (type === 'PRODUCT_PAGE') {
    const order = [
      ['الصورة الرئيسية (هوك قوي)', 'HERO'], ['المشكلة التي يعالجها المنتج', 'PROBLEM'], ['المشكلة والحل', 'PROBLEM_SOLUTION'],
      ['المنتج أثناء الاستخدام', 'DEMONSTRATION'], ['أهم المميزات', 'BENEFITS'], ['إنفوجرافيك مواصفات', 'FEATURE_INFOGRAPHIC'],
      ['زوايا متعددة للمنتج', 'MULTI_ANGLE'], ['تفاصيل قريبة', 'MACRO_DETAILS'], ['المنتج في سياق حقيقي', 'LIFESTYLE'],
      ['طريقة الاستخدام', 'HOW_TO_USE'], ['الرد على اعتراض', 'OBJECTION'], ['المنتج + العبوة', 'PRODUCT_PACKAGING'],
      ['قبل / بعد', 'BEFORE_AFTER'], ['صورة ختامية للشراء', 'FINAL_CTA'],
    ].slice(0, n).map(([label, angle]) => ({ label, angle, purpose: label }));
    if (n > 2 && order[order.length - 1].angle !== 'FINAL_CTA') order[order.length - 1] = { label: 'صورة ختامية للشراء', angle: 'FINAL_CTA', purpose: 'صورة ختامية للشراء' };
    return order;
  }
  const angles = ['PROBLEM', 'PROBLEM_SOLUTION', 'CURIOSITY', 'PRODUCT_DEMO', 'BENEFIT', 'FEATURE', 'LIFESTYLE', 'BEFORE_AFTER', 'COMPARISON', 'OFFER'];
  return Array.from({ length: n }, (_, i) => ({ label: `إعلان — ${angles[i % angles.length]}`, angle: angles[i % angles.length], purpose: `إعلان — ${angles[i % angles.length]}` }));
}

// ---- expected-result preview strip --------------------------------
function paintPreview() {
  const ws = state.ws;
  const box = $('cfPreview'); if (!box) return;
  const real = ws.plan?.items?.length ? ws.plan.items : null;
  const items = real || previewSequence(ws.imageType, ws.count);
  const anyRealAsset = real && real.some((it) => it.approvedAsset || (it.assets && it.assets.length));
  box.innerHTML = `
    <div class="cf-preview-head">
      <h2>${anyRealAsset ? 'الصور النهائية' : 'مثال للنتيجة المتوقعة'}</h2>
      <span class="cf-badge ${anyRealAsset ? 'green' : 'gray'}">${anyRealAsset ? 'صور فعلية' : 'معاينة الخطة'}</span>
    </div>
    <div class="cf-preview-strip">
      ${items.map((it, i) => {
        const a = it.approvedAsset || (it.assets && it.assets[0]);
        return `<div class="cf-preview-card" ${a ? `data-open-asset="${a.id}"` : ''}>
          ${a ? `<img src="/api/creative-factory/assets/${a.id}/image" loading="lazy"/>` : `<div class="ph"><span class="pn">${i + 1}</span><span class="pl">معاينة</span></div>`}
          <div class="pc-body"><span class="idx">${i + 1}</span> ${E(shortAngle(it.angle) || it.purpose || it.label || '')}</div>
        </div>`;
      }).join('')}
    </div>
    ${!real ? '<div class="cf-muted">دي معاينة تقريبية — التسلسل النهائي يتحدد من مخطط الـ AI حسب منتجك.</div>' : ''}`;
  box.querySelectorAll('[data-open-asset]').forEach((c) => c.onclick = () => openAssetDrawer(Number(c.dataset.openAsset)));
}
function shortAngle(a) {
  return { HERO: 'Hero — هوك رئيسي', PROBLEM: 'Problem — المشكلة', PROBLEM_SOLUTION: 'Problem/Solution', BEFORE_AFTER: 'Before/After — قبل/بعد', BENEFITS: 'Features — المميزات', FEATURE_INFOGRAPHIC: 'إنفوجرافيك', MULTI_ANGLE: 'زوايا متعددة', MACRO_DETAILS: 'تفاصيل', LIFESTYLE: 'Lifestyle', HOW_TO_USE: 'طريقة الاستخدام', OBJECTION: 'اعتراض', PRODUCT_PACKAGING: 'Product Detail — المنتج والعبوة', FINAL_CTA: 'CTA ختامية', DEMONSTRATION: 'أثناء الاستخدام' }[a] || a || '';
}

// ---- save (auto) --------------------------------------------------
function markSaved() {
  state.ws.savedAt = Date.now();
  const t = $('cfSaveTag'); if (t) { t.hidden = false; t.classList.add('flash'); setTimeout(() => t && t.classList.remove('flash'), 1200); }
}
function scheduleSaveProduct() {
  clearTimeout(state.saveTimers.prod);
  state.saveTimers.prod = setTimeout(() => wsSaveProductNow().catch(() => {}), 800);
}
async function wsSaveProductNow() {
  const ws = state.ws; if (!ws.productId) return;
  const aud = [...ws.audience, ...String(ws.audienceCustom || '').split(/[،,]+/).map((x) => x.trim()).filter(Boolean)].join('، ');
  await api.patch(`/api/creative-factory/products/${ws.productId}`, {
    specifications: ws.specsText || null,
    benefits: ws.specsText || null,          // mirror so downstream feature-counting works
    targetAudience: aud || null,
  });
  markSaved();
}
function scheduleSaveProject() {
  clearTimeout(state.saveTimers.proj);
  state.saveTimers.proj = setTimeout(() => wsSaveProjectNow().catch(() => {}), 800);
  renderStepper();
}
async function wsEnsureProject() {
  const ws = state.ws;
  if (ws.projectId) return ws.projectId;
  const body = projectBody(ws);
  const p = await api.post('/api/creative-factory/projects', body);
  ws.projectId = p.id; ws.project = p; wsPersist();
  return ws.projectId;
}
function projectBody(ws) {
  return {
    productId: ws.productId, projectType: ws.imageType, quantity: ws.count, quantityMode: ws.countMode,
    aiQuantityReason: ws.aiCountReason || undefined,
    stylePreset: ws.adv.stylePreset, market: ws.adv.market, language: ws.adv.language, dialect: ws.adv.dialect,
    aspectRatio: ws.adv.aspectRatio, textDensity: ws.adv.textDensity, peopleRule: ws.adv.peopleRule,
    hijabRequired: ws.adv.hijabRequired, generationMode: ws.adv.generationMode, productLockMode: ws.adv.productLockMode,
    planNotes: styleNotesString(ws),
  };
}
async function wsSaveProjectNow() {
  const ws = state.ws;
  const refs = ws.product?.referenceImages?.length || 0;
  const min = ws.product?.limits?.minReferenceImages || 3;
  if (!ws.productId || refs < min) return;               // can't persist a project yet — kept in localStorage
  if (!ws.projectId) { await wsEnsureProject(); markSaved(); return; }
  await api.patch(`/api/creative-factory/projects/${ws.projectId}`, projectBody(ws));
  markSaved();
}

function renderStepper() {
  const ws = state.ws; if (!ws) return;
  const stage = wsStage(ws);
  document.querySelectorAll('.cf-stepbox').forEach((el, i) => {
    el.classList.toggle('on', i + 1 === stage);
    el.classList.toggle('done', i + 1 < stage);
    const n = el.querySelector('.n'); if (n) n.textContent = i + 1 < stage ? '✓' : String(i + 1);
  });
}

// ---- plan preview (real) ----------------------------------------
async function wsShowPlan() {
  const ws = state.ws;
  const btn = $('cfShowPlan'); if (btn) { btn.disabled = true; btn.textContent = '… جاري تصميم الخطة'; }
  try {
    await wsSaveProjectNow();
    await wsEnsureProject();
    const res = await api.post(`/api/creative-factory/projects/${ws.projectId}/plan`, { count: ws.count });
    ws.plan = { items: res.items || [] };
    markSaved();
    paintReco(); paintPreview(); renderStepper();
  } catch (e) { UI.toast(e.message, 'error'); if (btn) { btn.disabled = false; btn.textContent = 'عرض الخطة الفعلية'; } }
}

// ---- GENERATE (full pipeline) ---------------------------------
async function wsGenerateNow() {
  const ws = state.ws;
  const refs = ws.product?.referenceImages?.length || 0;
  const min = ws.product?.limits?.minReferenceImages || 3;
  if (!ws.productId) return UI.toast('اختر منتجًا أولاً.', 'error');
  if (refs < min) return UI.toast(`محتاج ${min} صور مرجعية على الأقل.`, 'error');
  if (!ws.specsText.trim()) return UI.toast('اكتب مواصفات المنتج.', 'error');
  if (!ws.imageType) return UI.toast('اختر نوع الصور.', 'error');

  const btn = $('cfGenNow'); btn.disabled = true;
  const setBtn = (t) => { btn.textContent = t; };
  try {
    setBtn('… جاري حفظ المشروع'); await wsSaveProductNow(); await wsSaveProjectNow(); await wsEnsureProject();
    setBtn('… جاري فهم المنتج');
    if (!ws.product.dna || ws.product.dna.source === 'UNAVAILABLE') {
      try { await api.post(`/api/creative-factory/products/${ws.productId}/dna/analyze`, {}); await reloadProduct(); } catch { /* deterministic fallback still works */ }
    }
    setBtn('… جاري تصميم الخطة');
    if (!ws.plan?.items?.length) {
      const res = await api.post(`/api/creative-factory/projects/${ws.projectId}/plan`, { count: ws.count });
      ws.plan = { items: res.items || [] };
    }
    setBtn('… جاري تجهيز البرومبتات');
    await api.post(`/api/creative-factory/projects/${ws.projectId}/plan/approve`, {});

    if (!state.status.provider.image.configured) {
      UI.toast('الخطة جاهزة ومحفوظة. زر التوليد هيشتغل بعد إضافة OPENAI_API_KEY.', 'error');
      btn.disabled = false; setBtn('⚡ إنشاء الصور الآن'); paintReco(); paintPreview(); return;
    }
    setBtn('… بدء التوليد');
    const job = await api.post(`/api/creative-factory/projects/${ws.projectId}/generate`, {});
    ws.jobId = job.id; ws.phase = 'generating'; markSaved();
    renderNew($('cfView'));
  } catch (e) {
    UI.toast(`فشل بدء الإنشاء: ${e.message}`, 'error');
    btn.disabled = false; setBtn('⚡ إنشاء الصور الآن');
  }
}

// ---- generation view (live) ----------------------------------
async function wsPaintGenerate(zone) {
  await paintGen(zone);
  if (state.poll) clearInterval(state.poll);
  state.poll = setInterval(() => paintGen(zone).catch(() => {}), 2500);
}
async function paintGen(zone) {
  const ws = state.ws;
  const proj = await api.get(`/api/creative-factory/projects/${ws.projectId}`);
  ws.project = proj; ws.plan = { items: proj.items };
  const job = proj.jobs[0] || null;
  const terminal = ['COMPLETED', 'PARTIAL_COMPLETE', 'FAILED', 'CANCELLED'].includes(job?.status);
  if (terminal && state.poll) { clearInterval(state.poll); state.poll = null; }
  const done = proj.items.filter((i) => i.status === 'COMPLETED').length;
  const fail = proj.items.filter((i) => ['FAILED', 'NEEDS_REVIEW'].includes(i.status)).length;
  zone.innerHTML = `
    <div class="cf-gen-top">
      <div>
        <div class="cf-gen-title">${E(statusText(job?.status || 'QUEUED'))}</div>
        <div class="cf-muted">${done} / ${proj.items.length} صور جاهزة${fail ? ` · ${fail} تحتاج مراجعة` : ''}</div>
      </div>
      <div class="cf-gen-actions">
        ${terminal && fail ? '<button class="cf-btn sm" id="cfGenRetry">إعادة محاولة الناقص</button>' : ''}
        <a class="cf-btn ghost sm" href="#results">كل النتائج</a>
        <button class="cf-btn ghost sm" id="cfGenNew">مشروع جديد</button>
      </div>
    </div>
    <div class="cf-progress" style="margin:10px 0 16px;"><i style="width:${job?.progress || 0}%"></i></div>
    ${job?.status === 'FAILED' && job.error ? `<div class="cf-banner warn">فشل إنشاء الصور: ${E(job.error)}</div>` : ''}
    ${job?.status === 'COMPLETED' ? '<div class="cf-banner ok">✅ تم إنشاء كل الصور بنجاح.</div>' : ''}
    <div class="cf-grid gallery">${proj.items.map(genItemTile).join('')}</div>`;
  proj.items.forEach((it) => {
    const t = zone.querySelector(`[data-gi="${it.id}"]`);
    const a = it.approvedAsset || (it.assets && it.assets[0]);
    if (t && a) t.onclick = () => openAssetDrawer(a.id);
  });
  if ($('cfGenRetry')) $('cfGenRetry').onclick = async () => { try { const j = await api.post(`/api/creative-factory/projects/${ws.projectId}/retry-failed`, {}); ws.jobId = j.id; wsPaintGenerate(zone); } catch (e) { UI.toast(e.message, 'error'); } };
  if ($('cfGenNew')) $('cfGenNew').onclick = () => { try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ } state.ws = newWs(); renderNew($('cfView')); };
}
function genItemTile(it) {
  const [lbl, cls] = ITEM_STATUS[it.status] || ['—', 'gray'];
  const a = it.approvedAsset || (it.assets && it.assets[0]);
  const q = a && a.quality;
  return `<div class="cf-tile" data-gi="${it.id}">
    ${a ? `<img class="thumb" src="/api/creative-factory/assets/${a.id}/image" loading="lazy"/>` : `<div class="thumb ph">${it.status === 'GENERATING' ? '⏳ جاري الإنشاء' : it.status === 'REGENERATING' ? '↻ إعادة المحاولة' : it.status === 'REVIEWING' ? '🔍 فحص الجودة' : it.status === 'FAILED' ? '✕ فشل' : 'في الانتظار'}</div>`}
    <div class="body"><div class="top"><span style="font-weight:800;font-size:12px;">#${it.position}</span><span class="cf-badge ${cls}">${lbl}</span></div>
    <div class="hook">${E(shortAngle(it.angle) || it.purpose || '')}</div>
    ${q && q.overall != null ? `<button class="cf-qscore" data-q="${a.id}">${q.overall} / 100</button>` : ''}
    </div></div>`;
}
function statusText(s) {
  return { QUEUED: 'في قائمة الانتظار…', GENERATING: 'جاري إنشاء الصور…', REVIEWING: 'جاري فحص الجودة…', REGENERATING: 'إعادة المحاولة…', PARTIAL_COMPLETE: 'اكتمل جزئيًا', COMPLETED: 'اكتمل', FAILED: 'فشل', CANCELLED: 'أُلغي' }[s] || s;
}

// ---- Product DNA drawer + new-product form ----------------------
async function openDnaDrawer() {
  const ws = state.ws;
  const d = ws.product?.dna;
  const data = d?.data || {};
  const val = (k) => (Array.isArray(data[k]) ? data[k].join('، ') : (data[k] || ''));
  const LIST_KEYS = ['primary_colors', 'secondary_colors', 'visible_materials', 'logos_branding', 'accessories', 'unique_design_details', 'features_visible_in_reference', 'never_invent', 'category_safety_rules'];
  const TEXT_KEYS = ['product_category', 'product_type', 'primary_purpose', 'exact_shape', 'proportions', 'surface_texture', 'buttons', 'ports', 'display_screen', 'packaging_appearance', 'correct_orientation', 'physical_scale', 'likely_audience'];
  openDrawer(`<h2 style="margin-top:0;">فهم المنتج (Product DNA)</h2>
    <div class="cf-muted">${d ? `${dnaSourceLabel(d.source)} · إصدار ${d.version} · ثقة ${d.confidence ?? '—'}${data.scale_confidence != null ? ` · ثقة المقياس ${data.scale_confidence}` : ''}` : 'لم يتم التحليل بعد'}</div>
    ${TEXT_KEYS.filter((k) => data[k] != null || d).map((k) => `<div class="cf-field"><label>${E(dnaFieldLabel(k))}</label><input data-dna="${k}" value="${E(val(k))}"/></div>`).join('')}
    ${LIST_KEYS.map((k) => `<div class="cf-field"><label>${E(dnaFieldLabel(k))}</label><input data-dna="${k}" value="${E(val(k))}" placeholder="افصل بفاصلة"/></div>`).join('')}
    <button class="cf-btn primary" id="cfDnaSave">حفظ التعديلات</button>
    <button class="cf-btn ghost" id="cfDnaRe" style="margin-inline-start:8px;">إعادة التحليل</button>`);
  $('cfDnaSave').onclick = async () => {
    const patch = {};
    $('cfDrawer').querySelectorAll('[data-dna]').forEach((inp) => {
      const k = inp.dataset.dna;
      patch[k] = LIST_KEYS.includes(k) ? inp.value.split(/[،,]+/).map((x) => x.trim()).filter(Boolean) : (inp.value.trim() || null);
    });
    try { await api.patch(`/api/creative-factory/products/${ws.productId}/dna`, { data: patch }); closeDrawer(); await reloadProduct(); UI.toast('تم الحفظ'); paintCardImages(); }
    catch (e) { UI.toast(e.message, 'error'); }
  };
  $('cfDnaRe').onclick = async () => { closeDrawer(); await runAnalyze(); };
}
function dnaFieldLabel(k) {
  return {
    product_category: 'الفئة', product_type: 'نوع المنتج', primary_purpose: 'الغرض الأساسي',
    exact_shape: 'الشكل الدقيق', proportions: 'النِسب', surface_texture: 'ملمس السطح',
    primary_colors: 'الألوان الأساسية', secondary_colors: 'ألوان ثانوية', visible_materials: 'الخامات المرئية',
    buttons: 'الأزرار', ports: 'المنافذ', display_screen: 'الشاشة',
    logos_branding: 'الشعارات/العلامة', accessories: 'ملحقات', unique_design_details: 'تفاصيل مميزة',
    features_visible_in_reference: 'مميزات ظاهرة في الصور', never_invent: 'ممنوع اختراعه',
    category_safety_rules: 'قيود الفئة', packaging_appearance: 'مظهر العبوة',
    correct_orientation: 'الاتجاه الصحيح', physical_scale: 'الحجم الواقعي', likely_audience: 'الجمهور المرجّح',
  }[k] || k;
}
function dnaSourceLabel(s) { return { AI_ANALYZED: 'بالذكاء الاصطناعي', USER_EDITED: 'تعديل يدوي', MIXED: 'مختلط', UNAVAILABLE: 'غير متاح (يدوي)' }[s] || s; }

function openNewProductForm() {
  api.get('/api/creative-factory/products/catalog').then(({ suggestions }) => {
    const opts = suggestions.filter((s) => !s.linked);
    openDrawer(`<h2 style="margin-top:0;">منتج جديد</h2>
      <div class="cf-field"><label>من الكتالوج (اختياري)</label><select id="npCat"><option value="">— بدون —</option>${opts.map((o) => `<option value="${o.ambProductId}">${E(o.name)}</option>`).join('')}</select></div>
      <div class="cf-field"><label>اسم المنتج *</label><input id="npName"/></div>
      <div class="cf-field"><label>التصنيف</label><input id="npCategory"/></div>
      <div class="cf-field"><label>مواصفات ومميزات المنتج</label><textarea id="npSpecs" rows="5"></textarea></div>
      <div class="cf-field"><label>ادعاءات ممنوعة (اختياري)</label><input id="npForbidden" placeholder="عبارات ما ينفعش تظهر"/></div>
      <div class="cf-field"><label>سعر البيع (اختياري)</label><input id="npPrice" type="number"/></div>
      <button class="cf-btn primary" id="npSave">حفظ وبدء</button>`);
    $('npCat').onchange = (e) => { const o = opts.find((x) => String(x.ambProductId) === e.target.value); if (o && !$('npName').value) $('npName').value = o.name; };
    $('npSave').onclick = async () => {
      const g = (id) => $(id).value.trim();
      if (!g('npName')) return UI.toast('اسم المنتج مطلوب', 'error');
      try {
        const p = await api.post('/api/creative-factory/products', {
          ambProductId: Number($('npCat').value) || undefined,
          name: g('npName'), category: g('npCategory') || undefined,
          specifications: g('npSpecs') || undefined, benefits: g('npSpecs') || undefined,
          forbiddenClaims: g('npForbidden') || undefined,
          sellingPrice: g('npPrice') ? Number(g('npPrice')) : undefined,
        });
        state.ws = newWs(); state.ws.productId = p.id;
        state.ws.product = await api.get(`/api/creative-factory/products/${p.id}`);
        state.ws.specsText = g('npSpecs') || '';
        wsPersist(); closeDrawer(); UI.toast('تم إنشاء المنتج'); renderNew($('cfView'));
      } catch (e) { UI.toast(e.message, 'error'); }
    };
  });
}

// ===========================================================================
// TAB 2 — مشاريعي
// ===========================================================================
async function renderProjects(view, rid) {
  const { projects } = await api.get('/api/creative-factory/projects');
  if (rid !== undefined && state.rid !== rid) return;
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
  openDrawer(`<h2 style="margin-top:0;">${E(p.productName || 'مشروع')} — ${E(p.projectType)}</h2>
    <div class="cf-muted">الحالة: ${E(p.status)} · ${p.items.length} صورة · نمط ${E(p.stylePreset || '—')} · قفل ${E(LOCK_LABEL[p.productLockMode] || p.productLockMode)}</div>
    <div class="cf-grid gallery" style="margin-top:14px;">${p.items.map(genItemTile).join('')}</div>
    <div class="cf-actions">
      ${['DRAFT', 'PLAN_READY', 'PLANNING'].includes(p.status) ? `<button class="cf-btn primary" id="pjResume">إكمال في «إنشاء جديد»</button>` : ''}
      ${state.isAdmin && ['DRAFT', 'PLAN_READY'].includes(p.status) ? `<button class="cf-btn" id="pjGenerate">بدء الإنشاء</button>` : ''}
      ${state.isAdmin && ['PARTIAL_COMPLETE', 'FAILED'].includes(p.status) ? `<button class="cf-btn" id="pjRetry">إعادة محاولة الفاشل</button>` : ''}
      ${state.isAdmin ? `<button class="cf-btn ghost" id="pjDup">تكرار المشروع</button>` : ''}
      ${state.isAdmin && p.status !== 'CANCELLED' ? `<button class="cf-btn ghost" id="pjArch" style="color:var(--cf-red);">أرشفة</button>` : ''}
    </div>`);
  $('cfDrawer').querySelectorAll('[data-gi]').forEach((t) => {
    const it = p.items.find((x) => String(x.id) === t.dataset.gi);
    const a = it?.approvedAsset || it?.assets?.[0];
    if (a) t.onclick = () => openAssetDrawer(a.id);
  });
  if ($('pjResume')) $('pjResume').onclick = () => { try { localStorage.setItem(LS_KEY, JSON.stringify({ productId: p.productId, projectId: p.id })); } catch { /* ignore */ } state.ws = null; closeDrawer(); location.hash = 'new'; };
  if ($('pjGenerate')) $('pjGenerate').onclick = async () => { try { await api.post(`/api/creative-factory/projects/${id}/plan/approve`, {}); await api.post(`/api/creative-factory/projects/${id}/generate`, {}); closeDrawer(); UI.toast('بدأ الإنشاء'); route(); } catch (e) { UI.toast(e.message, 'error'); } };
  if ($('pjRetry')) $('pjRetry').onclick = async () => { try { await api.post(`/api/creative-factory/projects/${id}/retry-failed`, {}); closeDrawer(); UI.toast('بدأت إعادة المحاولة'); route(); } catch (e) { UI.toast(e.message, 'error'); } };
  if ($('pjDup')) $('pjDup').onclick = async () => { try { await api.post(`/api/creative-factory/projects/${id}/duplicate`, {}); closeDrawer(); UI.toast('تم التكرار'); route(); } catch (e) { UI.toast(e.message, 'error'); } };
  if ($('pjArch')) $('pjArch').onclick = async () => { if (!await UI.confirmModal({ title: 'أرشفة المشروع', message: 'المشروع هيتنقل للأرشيف.', confirmLabel: 'أرشفة', danger: true })) return; try { await api.post(`/api/creative-factory/projects/${id}/archive`, {}); closeDrawer(); route(); } catch (e) { UI.toast(e.message, 'error'); } };
}

// ===========================================================================
// TAB 3 — النتائج (gallery)
// ===========================================================================
const results = { cursor: null, items: [], filter: {} };
async function renderResults(view, rid) {
  if (rid !== undefined && state.rid !== rid) return;
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
      ${sc('product_accuracy_score', 'تطابق المنتج')}${sc('visual_quality_score', 'الجودة البصرية')}${sc('marketing_score', 'وضوح الإعلان')}${sc('arabic_text_score', 'النص العربي')}${sc('claim_score', 'سلامة الادعاءات')}
      ${(q.failureReasons || []).length ? `<div class="cf-muted" style="margin-top:6px;">ملاحظات: ${q.failureReasons.map(E).join(' · ')}</div>` : ''}
      <details class="cf-collapse" style="margin-top:6px;"><summary>كل المقاييس</summary>${sc('identity_score', 'هوية المنتج')}${sc('composition_score', 'التكوين')}${sc('product_visibility_score', 'وضوح المنتج')}${sc('text_readability_score', 'سهولة القراءة')}${sc('artifact_score', 'خلو من التشوه')}${sc('reference_consistency_score', 'الاتساق مع المرجع')}${sc('plan_compliance_score', 'الالتزام بالخطة')}</details>
    </div>` : '<div class="cf-muted" style="margin-top:12px;">لا يوجد تقييم آلي (الـ AI النصي غير متاح).</div>'}
    <div class="cf-fbrow">
      <button class="cf-btn ghost sm" data-fb="UP">👍 ممتازة</button>
      <button class="cf-btn ghost sm" data-fb="DOWN">👎 مش مناسبة</button>
    </div>
    <div class="cf-actions">
      ${state.isAdmin && a.status !== 'APPROVED' ? `<button class="cf-btn primary sm" data-st="APPROVED">اعتماد</button>` : ''}
      ${state.isAdmin && a.status !== 'REJECTED' ? `<button class="cf-btn ghost sm" data-st="REJECTED">رفض</button>` : ''}
      <a class="cf-btn ghost sm" href="${E(a.imageUrl)}" target="_blank" download>تحميل</a>
      ${state.isAdmin ? `<button class="cf-btn ghost sm" id="cfRegen">إعادة إنشاء</button>` : ''}
      ${state.isAdmin ? `<button class="cf-btn ghost sm" id="cfVary">Variation</button>` : ''}
    </div>
    ${state.isAdmin ? `<div class="cf-varmenu">
      <button class="cf-btn ghost sm" data-vt="NEW_HOOK">تغيير الهوك</button>
      <button class="cf-btn ghost sm" data-vt="NEW_COPY">تغيير النص</button>
      <button class="cf-btn ghost sm" data-vt="NEW_BACKGROUND">تغيير الخلفية</button>
      <button class="cf-btn ghost sm" data-vt="NEW_CAMERA_ANGLE">تغيير الزاوية</button>
      <button class="cf-btn ghost sm" data-vt="SAME_CONCEPT:3">نفس الفكرة ×3</button>
      <button class="cf-btn ghost sm" id="cfDetails">عرض التفاصيل</button>
    </div>` : ''}
    <div id="cfPromptBox"></div>`;
  $('cfDrawer').querySelectorAll('[data-st]').forEach((b) => {
    b.onclick = async () => { try { await api.post(`/api/creative-factory/assets/${id}/status`, { status: b.dataset.st }); UI.toast('تم'); openAssetDrawer(id); if (state.tab === 'results') renderResults($('cfView')); } catch (e) { UI.toast(e.message, 'error'); } };
  });
  const FB_REASONS = ['المنتج اتغير', 'الفكرة ضعيفة', 'التصميم مش عاجبني', 'الكلام ضعيف', 'الصورة مش واقعية', 'استخدام المنتج غلط', 'أخرى'];
  const sendFb = async (verdict, reason) => {
    try { await api.post(`/api/creative-factory/assets/${id}/feedback`, { verdict, reason }); UI.toast(verdict === 'UP' ? 'اتسجّل 👍' : 'اتسجّل — هنحسّن الاقتراحات القادمة'); $('cfPromptBox').innerHTML = ''; }
    catch (e) { UI.toast(e.message, 'error'); }
  };
  $('cfDrawer').querySelectorAll('[data-fb]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.fb === 'UP') return sendFb('UP');
      $('cfPromptBox').innerHTML = `<div style="margin-top:10px;border-top:1px solid var(--cf-border);padding-top:10px;"><div class="cf-muted" style="margin-bottom:6px;">إيه السبب؟</div><div class="cf-chips">${FB_REASONS.map((r) => `<button class="cf-chip" data-fbr="${E(r)}">${E(r)}</button>`).join('')}</div></div>`;
      $('cfPromptBox').querySelectorAll('[data-fbr]').forEach((c) => c.onclick = () => sendFb('DOWN', c.dataset.fbr));
    };
  });
  if ($('cfRegen')) $('cfRegen').onclick = async () => {
    if (!await UI.confirmModal({ title: 'إعادة إنشاء', message: 'هيتم رفض الصورة الحالية وإعادة توليد نفس العنصر.', confirmLabel: 'إعادة', danger: true })) return;
    try {
      await api.post(`/api/creative-factory/assets/${id}/status`, { status: 'REJECTED' });
      if (a.project?.id) await api.post(`/api/creative-factory/projects/${a.project.id}/retry-failed`, {});
      UI.toast('بدأت إعادة الإنشاء'); closeDrawer();
    } catch (e) { UI.toast(e.message, 'error'); }
  };
  if ($('cfVary')) $('cfVary').onclick = () => variationPrompt(id);
  $('cfDrawer').querySelectorAll('[data-vt]').forEach((b) => b.onclick = async () => {
    const [vt, cnt] = b.dataset.vt.split(':');
    try { await api.post(`/api/creative-factory/assets/${id}/variations`, { variationType: vt, count: Number(cnt) || 1 }); UI.toast('بدأ إنشاء Variation — تابعه في «النتائج».'); closeDrawer(); }
    catch (e) { UI.toast(e.message, 'error'); }
  });
  if ($('cfDetails')) $('cfDetails').onclick = () => {
    $('cfPromptBox').innerHTML = `<pre style="white-space:pre-wrap;font-size:11px;background:var(--cf-bg);padding:10px;border-radius:8px;margin-top:10px;">${E(a.prompt || 'لا يوجد برومبت محفوظ.')}</pre>
      <div class="cf-muted">إصدار البرومبت ${a.promptVersion || 1} · محاولات: ${(a.attempts || []).length}</div>`;
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
async function renderLearn(view, rid) {
  const data = await api.get('/api/creative-factory/learning');
  if (rid !== undefined && state.rid !== rid) return;
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
      ${(() => {
        const fb = data.feedback || {};
        if (!fb.total) return '';
        const angleRows = (fb.byAngle || []).filter((x) => x.n >= 1).slice(0, 8);
        const reasons = Object.entries(fb.byReason || {}).sort((a, b) => b[1] - a[1]);
        return `<div class="cf-card"><h2>تقييمك للكرياتيفات (${fb.total})</h2>
          <div class="cf-muted" style="margin-bottom:8px;">النظام بيرجّح الزوايا اللي قيّمتها 👍 ويتجنّب اللي 👎 في الخطط الجاية لنفس فئة المنتج.</div>
          ${angleRows.map((r) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--cf-border);font-size:12.5px;"><b>${E(r.key || '—')}</b><span class="${r.score > 0 ? '' : 'cf-muted'}" style="${r.score > 0 ? 'color:var(--cf-green)' : r.score < 0 ? 'color:var(--cf-red)' : ''}">👍 ${r.up} · 👎 ${r.down}</span></div>`).join('') || '<div class="cf-muted">لسه مفيش تقييمات موزّعة على زوايا.</div>'}
          ${reasons.length ? `<div class="cf-muted" style="margin-top:8px;">أكثر أسباب الرفض: ${reasons.map(([k, v]) => `${E(k)} (${v})`).join(' · ')}</div>` : ''}
        </div>`;
      })()}
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
