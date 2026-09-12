// AI Product Marketing Center — "مركز التسويق الذكي للمنتج". Page controller
// for product-marketing-center.html. Isolated module: talks only to
// /api/product-marketing/* via the shared api-client, same as every other
// AMB/Creative Factory page. No Meta write anywhere on this page — every
// action here is read/analyze/decide-a-recommendation only.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const E = (s) => UI.escapeHtml(String(s ?? ''));
const $ = (id) => document.getElementById(id);
const fmtEGP = (n) => UI.fmtCurrency(n);
const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
const fmtPct1 = (n) => (n === null || n === undefined ? '—' : `${Math.round(n * 1000) / 10}%`);

const WINDOWS = [
  { k: 'today', label: 'اليوم' }, { k: 'yesterday', label: 'أمس' },
  { k: 'last3', label: 'آخر 3 أيام' }, { k: 'last7', label: 'آخر 7 أيام' },
];
const TABS = [
  { k: 'overview', label: 'نظرة عامة' },
  { k: 'audience', label: 'الجمهور والأسواق' },
  { k: 'angles', label: 'زوايا البيع' },
  { k: 'creative', label: 'الكرياتيف' },
  { k: 'hooks', label: 'Hooks والبوستات' },
  { k: 'locations', label: 'المناطق' },
  { k: 'competitors', label: 'المنافسين' },
  { k: 'tests', label: 'الاختبارات والنتائج' },
];

const state = {
  me: null,
  source: 'EASY_ORDERS', // EASY_ORDERS | MANUAL_UPLOAD (source-picker only, before lock)
  eoQuery: '', eoResults: [],
  uploadImages: [], // [{base64, mediaType, dataUrl}]
  profile: null, // locked profile
  windowName: 'last7',
  snapshot: null, snapshotLoading: false,
  tab: 'overview',
  memory: null, actions: null, competitors: null,
  hookResult: null, postResult: null, ideaResult: null, testPackResult: null,
  genAngle: '', genTone: 'مباشر', genCategory: '',
};

async function init() {
  try { state.me = await api.get('/api/auth/me'); } catch { /* redirected by api-client on 401 */ }
  $('ambDrawerOverlay').addEventListener('click', (e) => { if (e.target.id === 'ambDrawerOverlay') $('ambDrawerOverlay').classList.remove('open'); });
  renderNav();
  render();
}

function renderNav() {
  const u = state.me || {};
  const initials = (u.name || 'U').trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
  $('ambNav').innerHTML = `
    <div class="amb-nav-brand">
      <div class="logo">💡</div>
      <div><div class="t">مركز التسويق الذكي</div><div class="s">قرارات تسويقية أذكى لكل منتج</div></div>
    </div>
    <div class="amb-nav-list">
      <a class="amb-nav-item active" href="product-marketing-center.html">💡<span>مركز التسويق الذكي</span></a>
      <a class="amb-nav-item" href="ai-media-buyer.html">📈<span>AI Media Buyer</span></a>
      <a class="amb-nav-item" href="creative-factory.html">✨<span>مصنع الإعلانات</span></a>
      <a class="amb-nav-item" href="product-research.html">🔍<span>البحث عن المنتجات</span></a>
    </div>
    <div class="amb-nav-foot">
      <div class="amb-nav-user">
        <div class="av">${E(initials)}</div>
        <div><div class="nm">${E(u.name || '—')}</div><div class="rl">${E({ ADMIN: 'مدير النظام', MANAGER: 'مدير', EMPLOYEE: 'موظف' }[u.role] || u.role || '')}</div></div>
      </div>
      <a class="amb-nav-link" href="ai-intelligence.html">🧠 AI Intelligence</a>
      <a class="amb-nav-link" href="index.html">↩︎ الرجوع للنظام</a>
    </div>`;
}

function render() {
  const view = $('pmcView');
  view.innerHTML = `
    <div class="pmc-header">
      <div>
        <h1>مركز التسويق الذكي للمنتج</h1>
        <div class="sub">نفهم منتجك، نكتشف له أفضل جمهور وزوايا بيع، ونحوّل البيانات إلى أفكار وكرياتيفات قابلة للاختبار.</div>
      </div>
      <div class="pmc-ai-chip">🤖 ذكاء اصطناعي مخصص لمنتجك</div>
    </div>
    <div id="pmcBody"></div>`;
  if (!state.profile) renderSourcePicker($('pmcBody'));
  else renderWorkspace($('pmcBody'));
}

// ---------------------------------------------------------------------------
// §1 — Product source, lock, understanding
// ---------------------------------------------------------------------------
function renderSourcePicker(mount) {
  mount.innerHTML = `
    <div class="amb-panel">
      <div class="section-title" style="margin-top:0;">اختر مصدر المنتج</div>
      <div class="faint" style="font-size:12px;margin-bottom:14px;">قبل أي تحليل، لازم تحدد المنتج الحقيقي اللي هنشتغل عليه — من كتالوج Easy Orders أو برفع صورته. مفيش تحليل من غير منتج معتمد.</div>
      <div class="pmc-source-grid">
        <div class="pmc-source-card ${state.source === 'EASY_ORDERS' ? 'active' : ''}" data-src="EASY_ORDERS">
          <div class="ic">🛒</div>
          <div class="t">اختيار من Easy Orders</div>
          <div class="d">اختار واختار المنتج بنفس الاسم وصورته الحقيقية من الكتالوج.</div>
        </div>
        <div class="pmc-source-card ${state.source === 'MANUAL_UPLOAD' ? 'active' : ''}" data-src="MANUAL_UPLOAD">
          <div class="ic">📷</div>
          <div class="t">رفع صورة المنتج</div>
          <div class="d">ارفع صورة أو أكتر، وهنحلل المنتج بصريًا (حتى 5 صور، JPG/PNG/WEBP).</div>
        </div>
      </div>
      <div id="pmcSourceBody"></div>
    </div>`;
  mount.querySelectorAll('[data-src]').forEach((c) => { c.onclick = () => { state.source = c.dataset.src; render(); }; });
  if (state.source === 'EASY_ORDERS') renderEasyOrdersPicker($('pmcSourceBody'));
  else renderUploadPicker($('pmcSourceBody'));
}

function renderEasyOrdersPicker(mount) {
  mount.innerHTML = `
    <div class="pmc-eo-search">
      <input class="amb-input" id="pmcEoSearch" type="search" placeholder="ابحث عن المنتج بالاسم..." value="${E(state.eoQuery)}" style="width:100%;min-width:0;" />
      <div id="pmcEoResults" class="pmc-eo-results"></div>
    </div>`;
  const input = $('pmcEoSearch');
  const paintResults = () => {
    const box = $('pmcEoResults');
    if (!state.eoResults.length) { box.innerHTML = `<div class="pmc-empty">${state.eoQuery ? 'مفيش نتائج مطابقة.' : 'ابدأ الكتابة للبحث في كتالوج Easy Orders.'}</div>`; return; }
    box.innerHTML = state.eoResults.map((p) => `<div class="pmc-eo-row" data-eo="${E(p.id)}">
      <img src="${E(p.thumb || '')}" onerror="this.style.visibility='hidden'" />
      <div class="n">${E(p.name)}</div>
      <span class="faint" style="font-size:11px;">#${E(p.slug || p.id)}</span>
    </div>`).join('');
    box.querySelectorAll('[data-eo]').forEach((r) => { r.onclick = () => lockEasyOrders(r.dataset.eo); });
  };
  let t = null;
  const search = async () => {
    state.eoQuery = input.value;
    try { state.eoResults = (await api.get('/api/product-marketing/easy-orders/search', { q: state.eoQuery })).products; }
    catch (e) { UI.toast(e.message, 'error'); state.eoResults = []; }
    paintResults();
  };
  input.oninput = () => { clearTimeout(t); t = setTimeout(search, 250); };
  search();
}

function renderUploadPicker(mount) {
  mount.innerHTML = `
    <div class="pmc-upload-zone" id="pmcDropZone">
      <div style="font-size:28px;">📷</div>
      <div style="font-weight:700;margin:6px 0;">اسحب الصور هنا أو دوس للاختيار</div>
      <div class="faint" style="font-size:12px;">حتى 5 صور — JPEG / PNG / WEBP، أقل من 5 ميجا لكل صورة</div>
      <input type="file" id="pmcFileInput" accept="image/jpeg,image/png,image/webp" multiple style="display:none;" />
    </div>
    <div class="pmc-upload-previews" id="pmcPreviews"></div>
    <div class="toolbar" style="margin-top:14px;">
      <button class="amb-btn primary" id="pmcAnalyzeUpload" ${state.uploadImages.length ? '' : 'disabled'}>تحليل الصور وتأكيد المنتج</button>
    </div>`;
  const paintPreviews = () => { $('pmcPreviews').innerHTML = state.uploadImages.map((im, i) => `<img src="${im.dataUrl}" title="صورة ${i + 1}" />`).join(''); $('pmcAnalyzeUpload').disabled = !state.uploadImages.length; };
  const zone = $('pmcDropZone'); const input = $('pmcFileInput');
  zone.onclick = () => input.click();
  input.onchange = async () => { await addFiles([...input.files]); paintPreviews(); };
  zone.ondragover = (e) => e.preventDefault();
  zone.ondrop = async (e) => { e.preventDefault(); await addFiles([...e.dataTransfer.files]); paintPreviews(); };
  $('pmcAnalyzeUpload').onclick = lockFromUpload;
  paintPreviews();
}

function readAsDataUrl(f) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(f); }); }
async function addFiles(files) {
  const remaining = 5 - state.uploadImages.length;
  if (remaining <= 0) { UI.toast('أقصى عدد صور 5', 'error'); return; }
  for (const f of files.slice(0, remaining)) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) { UI.toast('نوع الصورة لازم يكون JPEG أو PNG أو WEBP', 'error'); continue; }
    if (f.size > 5 * 1024 * 1024) { UI.toast('حجم الصورة لازم يكون أقل من 5 ميجا', 'error'); continue; }
    const dataUrl = await readAsDataUrl(f);
    state.uploadImages.push({ base64: dataUrl.split(',')[1], mediaType: f.type, dataUrl });
  }
}

async function lockEasyOrders(eoId) {
  try {
    state.profile = await api.post('/api/product-marketing/profiles/from-easy-orders', { eoProductId: eoId });
    resetWorkspace();
    render();
  } catch (e) { UI.toast(e.message, 'error'); }
}
async function lockFromUpload() {
  try {
    const images = state.uploadImages.map((im) => ({ imageBase64: im.base64, imageMediaType: im.mediaType }));
    state.profile = await api.post('/api/product-marketing/profiles/from-images', { images });
    resetWorkspace();
    render();
  } catch (e) { UI.toast(e.message, 'error'); }
}
function resetWorkspace() {
  state.tab = 'overview'; state.snapshot = null; state.memory = null; state.actions = null; state.competitors = null;
  state.hookResult = null; state.postResult = null; state.ideaResult = null; state.testPackResult = null;
}

// ---------------------------------------------------------------------------
// Workspace: confirmed card + window selector + tabs
// ---------------------------------------------------------------------------
function renderWorkspace(mount) {
  const p = state.profile;
  mount.innerHTML = `
    <div class="pmc-confirm-card">
      <img src="${E(p.primaryImageUrl || '')}" onerror="this.style.visibility='hidden'" />
      <div class="body">
        <div class="title">✅ المنتج المعتمد للتحليل</div>
        <div class="name">${E(p.lockedName)}</div>
        <div class="faint" style="font-size:12px;">المصدر: ${p.source === 'EASY_ORDERS' ? 'Easy Orders' : 'رفع يدوي'}${p.sellingPrice ? ` · السعر: ${fmtEGP(p.sellingPrice)}` : ''}</div>
        <div class="pmc-trait-groups">
          ${traitCol('confirmed', 'خصائص مؤكدة', p.confirmedTraits)}
          ${traitCol('potential', 'خصائص محتملة', p.potentialTraits)}
          ${traitCol('unconfirmed', 'غير مؤكد', p.unconfirmedTraits)}
        </div>
      </div>
      <button class="amb-btn sm ghost" id="pmcChangeProduct">تغيير المنتج</button>
    </div>

    <div class="toolbar" style="margin:14px 0;justify-content:space-between;">
      <span class="amb-fgrp"><span class="fl">الفترة</span>${WINDOWS.map((w) => `<button class="amb-fbtn ${state.windowName === w.k ? 'active' : ''}" data-win="${w.k}">${E(w.label)}</button>`).join('')}</span>
      <button class="amb-btn sm" id="pmcRefresh">🔄 تحديث التحليل</button>
    </div>

    <div class="pmc-tabs">${TABS.map((t) => `<button class="pmc-tab ${state.tab === t.k ? 'active' : ''}" data-tab="${t.k}">${E(t.label)}</button>`).join('')}</div>
    <div id="pmcTabBody"></div>`;

  $('pmcChangeProduct').onclick = () => { state.profile = null; render(); };
  mount.querySelectorAll('[data-win]').forEach((b) => { b.onclick = () => { state.windowName = b.dataset.win; state.snapshot = null; renderWorkspace(mount); loadSnapshot(); }; });
  $('pmcRefresh').onclick = () => loadSnapshot(true);
  mount.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { state.tab = b.dataset.tab; renderTabBody(); }; });

  if (!state.snapshot && !state.snapshotLoading) loadSnapshot();
  else renderTabBody();
}

function traitCol(cls, label, items) {
  if (!items?.length) return '';
  return `<div class="pmc-trait-col ${cls}"><div class="h">${E(label)}</div><ul>${items.map((t) => `<li>${E(t.label)}${t.value ? `: ${E(t.value)}` : ''}</li>`).join('')}</ul></div>`;
}

async function loadSnapshot(force = false) {
  state.snapshotLoading = true;
  const body = $('pmcTabBody'); if (body) body.innerHTML = '<div class="pmc-empty">🤖 بنحلل المنتج… (بيانات حقيقية + ذكاء اصطناعي)</div>';
  try {
    state.snapshot = await api.post(`/api/product-marketing/profiles/${state.profile.id}/analyze`, { window: state.windowName, force });
  } catch (e) {
    UI.toast(e.message, 'error');
    state.snapshot = null;
  }
  state.snapshotLoading = false;
  renderTabBody();
}

function renderTabBody() {
  const mount = $('pmcTabBody');
  if (!mount) return;
  if (!state.snapshot) { mount.innerHTML = '<div class="pmc-empty">مفيش تحليل متاح حاليًا.</div>'; return; }
  const s = state.snapshot;
  const renderers = { overview: renderOverview, audience: renderAudience, angles: renderAngles, creative: renderCreative, hooks: renderHooksTab, locations: renderLocations, competitors: renderCompetitors, tests: renderTests };
  (renderers[state.tab] || renderOverview)(mount, s);
}

function kindPill(kind) { return kind ? `<span class="pmc-pill ${E(kind)}">${{ FACT: 'حقيقة', HYPOTHESIS: 'فرضية', RECOMMENDATION: 'توصية' }[kind] || kind}</span>` : ''; }
function confPill(c) { return c ? `<span class="pmc-pill conf-${E(c)}">ثقة ${{ LOW: 'منخفضة', MEDIUM: 'متوسطة', HIGH: 'عالية' }[c] || c}</span>` : ''; }
function claimPill(status, reason) { const map = { GREEN: ['🟢 آمن', ''], YELLOW: ['🟡 يحتاج إثبات', ''], RED: ['🔴 غير موصى به', reason || ''] }; const [label] = map[status] || ['—', '']; return `<span class="pmc-claim ${E(status)}" title="${E(reason || '')}">${label}</span>`; }

// ---- §4/§5/§6/§20/§21 — Overview ----
function renderOverview(mount, s) {
  const op = s.opportunity || {};
  const scoreColor = op.label === 'قوية' ? 'strong' : op.label === 'متوسطة' ? 'medium' : 'weak';
  const ring = op.score != null ? scoreRingSvg(op.score, scoreColor) : '<div class="pmc-empty" style="padding:16px;">البيانات غير كافية للحكم</div>';
  const m = s.metrics || {};
  mount.innerHTML = `
    <div class="pmc-top-grid">
      <div class="pmc-card">
        <div class="h">💡 فرصة نجاح المنتج</div>
        ${ring}
        ${op.dataSufficient ? `<div class="pmc-score-label ${scoreColor}">${E(op.label)} · ${confPill(op.confidence)}</div>` : `<div class="faint" style="text-align:center;font-size:12px;">${E(op.note || 'البيانات غير كافية للحكم')}</div>`}
      </div>
      <div class="pmc-card">
        <div class="h">📊 الأداء الحالي — ${E(m.windowLabel || '')}</div>
        <div class="pmc-kv"><span>المصروف</span><b>${fmtEGP(m.totalSpend)}</b></div>
        <div class="pmc-kv"><span>مشتريات Meta</span><b>${fmtNum(m.metaPurchases)}</b></div>
        <div class="pmc-kv"><span>طلبات مُستلمة (COD)</span><b>${fmtNum(m.deliveredOrders)}</b></div>
        <div class="pmc-kv"><span>معدل الاستلام</span><b>${fmtPct1(m.deliveryRate)}</b></div>
        <div class="pmc-kv"><span>Delivered CPA</span><b>${fmtEGP(m.deliveredCpa)}</b></div>
        <div class="pmc-kv"><span>صافي الربح</span><b>${fmtEGP(m.netProfit)}</b></div>
      </div>
      <div class="pmc-card">
        <div class="h">🩺 التشخيص السريع</div>
        ${(s.diagnosis || []).map((d) => `<div class="pmc-diag-item"><div class="dot ${E(d.severity)}"></div><div><div class="t">${E(d.problem)}</div><div class="e">${E(d.evidence)}</div><div class="a">↳ ${E(d.action)}</div></div></div>`).join('')}
        ${s.diagnosisNarrative ? `<div class="faint" style="font-size:12px;margin-top:8px;">${E(s.diagnosisNarrative)}</div>` : ''}
      </div>
      <div class="pmc-card">
        <div class="h">👥 أفضل جمهور مقترح</div>
        ${audienceSummaryHtml(s.audience)}
      </div>
      <div class="pmc-card">
        <div class="h">📍 أفضل المحافظات</div>
        ${(s.locations || []).slice(0, 5).map((l) => `<div class="pmc-kv"><span>${E(l.government)}</span><b>${fmtNum(l.delivered)} مُستلم</b></div>`).join('') || '<div class="pmc-empty" style="padding:10px;">البيانات غير كافية للحكم</div>'}
      </div>
      <div class="pmc-card">
        <div class="h">🏆 التركيبة الرابحة</div>
        ${winningFormulaHtml(s.winningFormula)}
      </div>
    </div>

    <div class="pmc-card" style="margin-top:14px;">
      <div class="h">🔥 أفضل زوايا بيع مقترحة</div>
      ${(s.angles || []).slice(0, 3).map((a) => `<div class="pmc-angle-mini"><span>${E(a.name)} ${claimPill(a.claimStatus, a.claimReason)}</span>${confPill(a.confidence)}</div>`).join('') || '<div class="pmc-empty">البيانات غير كافية للحكم</div>'}
    </div>

    <div class="pmc-card" style="margin-top:14px;">
      <div class="h">⚡ ماذا أفعل الآن؟</div>
      ${actionsListHtml(s.actions)}
      ${s.aiFailed ? `<div class="faint" style="font-size:11.5px;margin-top:6px;">⚠️ تعذّر توليد التوصيات الذكية: ${E(s.aiFailReason || '')}</div>` : ''}
    </div>`;
  wireActionButtons(mount);
}

function scoreRingSvg(score, cls) {
  const r = 40, c = 2 * Math.PI * r;
  const color = cls === 'strong' ? 'var(--amb-green)' : cls === 'medium' ? 'var(--amb-amber)' : 'var(--amb-red)';
  const off = c - (Math.max(0, Math.min(100, score)) / 100) * c;
  return `<div class="pmc-score-ring"><svg width="92" height="92" viewBox="0 0 92 92">
    <circle cx="46" cy="46" r="${r}" fill="none" stroke="var(--amb-border)" stroke-width="8" />
    <circle cx="46" cy="46" r="${r}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}" />
  </svg><div class="num"><b>${score}</b><span>/100</span></div></div>`;
}

function audienceSummaryHtml(a) {
  if (!a || a.unavailable) return `<div class="pmc-empty" style="padding:10px;">${E(a?.reason || 'البيانات غير كافية للحكم')}</div>`;
  const rows = [];
  if (a.gender?.value) rows.push(`<div class="pmc-kv"><span>النوع</span><b>${E(a.gender.value)} ${kindPill(a.gender.kind)}</b></div>`);
  if (a.ageRange?.value) rows.push(`<div class="pmc-kv"><span>السن</span><b>${E(a.ageRange.value)}</b></div>`);
  if (a.buyerVsUser?.user) rows.push(`<div class="pmc-kv"><span>المستخدم</span><b>${E(a.buyerVsUser.user)}</b></div>`);
  if (a.buyerVsUser?.buyer) rows.push(`<div class="pmc-kv"><span>المشتري</span><b>${E(a.buyerVsUser.buyer)}</b></div>`);
  return rows.join('') || '<div class="pmc-empty" style="padding:10px;">البيانات غير كافية للحكم</div>';
}

function winningFormulaHtml(wf) {
  if (!wf || !wf.available) return '<div class="pmc-empty" style="padding:10px;">البيانات غير كافية للحكم بعد</div>';
  const rows = [['النوع', wf.gender], ['السن', wf.ageRange], ['المكان', wf.location], ['الزاوية', wf.angle], ['Hook', wf.hook], ['الشكل', wf.format]];
  return rows.filter(([, v]) => v).map(([k, v]) => `<div class="pmc-kv"><span>${E(k)}</span><b>${E(v)}</b></div>`).join('') + (wf.narrative ? `<div class="faint" style="font-size:11.5px;margin-top:6px;">${E(wf.narrative)}</div>` : '');
}

function actionsListHtml(actions) {
  if (!actions?.length) return '<div class="pmc-empty">مفيش توصيات حاليًا.</div>';
  return actions.map((a, i) => `<div class="pmc-action-item">
    <div class="t">${E(a.title)} ${confPill(a.confidence)}</div>
    <div class="r">${E(a.reason)}${a.expectedBenefit ? ` · الفايدة المتوقعة: ${E(a.expectedBenefit)}` : ''}${a.risk ? ` · الخطورة: ${E(a.risk)}` : ''}</div>
    <div class="faint" style="font-size:11px;margin-bottom:6px;">المصدر: ${E(a.source || '—')}</div>
    <div class="btns">
      <button class="amb-btn sm primary" data-act-approve="${i}">موافقة</button>
      <button class="amb-btn sm" data-act-modify="${i}">تعديل</button>
      <button class="amb-btn sm ghost" data-act-reject="${i}">رفض</button>
    </div>
  </div>`).join('');
}
function wireActionButtons(mount) {
  const decide = async (i, status) => {
    const list = await api.get(`/api/product-marketing/profiles/${state.profile.id}/actions`);
    const row = list.actions.find((a) => a.actionKey === state.snapshot.actions[i]?.actionKey);
    if (!row) { UI.toast('التوصية دي مش متاحة للقرار حاليًا.', 'error'); return; }
    try { await api.post(`/api/product-marketing/actions/${row.id}/decide`, { status }); UI.toast('تم تسجيل القرار.'); }
    catch (e) { UI.toast(e.message, 'error'); }
  };
  mount.querySelectorAll('[data-act-approve]').forEach((b) => b.onclick = () => decide(Number(b.dataset.actApprove), 'APPROVED'));
  mount.querySelectorAll('[data-act-modify]').forEach((b) => b.onclick = () => decide(Number(b.dataset.actModify), 'MODIFIED'));
  mount.querySelectorAll('[data-act-reject]').forEach((b) => b.onclick = () => decide(Number(b.dataset.actReject), 'REJECTED'));
}

// ---- §7/§9 — Audience & Markets ----
function renderAudience(mount, s) {
  const a = s.audience || {};
  mount.innerHTML = `
    <div class="pmc-card">
      <div class="h">👥 خريطة السوق والجمهور</div>
      ${a.unavailable ? `<div class="pmc-empty">${E(a.reason)}</div>` : `
        <div class="pmc-kv"><span>النوع</span><b>${E(a.gender?.value || '—')} ${kindPill(a.gender?.kind)} ${confPill(a.gender?.confidence)}</b></div>
        <div class="faint" style="font-size:11.5px;margin:4px 0 10px;">${E(a.gender?.evidence || '')}</div>
        <div class="pmc-kv"><span>السن</span><b>${E(a.ageRange?.value || '—')} ${kindPill(a.ageRange?.kind)} ${confPill(a.ageRange?.confidence)}</b></div>
        <div class="faint" style="font-size:11.5px;margin:4px 0 10px;">${E(a.ageRange?.evidence || '')}</div>
        ${a.buyerVsUser ? `<div class="pmc-kv"><span>المستخدم</span><b>${E(a.buyerVsUser.user || '—')}</b></div>
        <div class="pmc-kv"><span>المشتري</span><b>${E(a.buyerVsUser.buyer || '—')}</b></div>
        <div class="pmc-kv"><span>المشتري الثانوي</span><b>${E(a.buyerVsUser.secondaryBuyer || '—')}</b></div>
        <div class="pmc-kv"><span>فرصة هدية</span><b>${E(a.buyerVsUser.giftOpportunity || '—')}</b></div>` : ''}
      `}
    </div>
    <div class="pmc-card" style="margin-top:14px;">
      <div class="h">🎯 شرائح مقترحة</div>
      ${(a.segments || []).map((seg) => `<div class="pmc-angle-card">
        <div class="head"><span class="name">${E(seg.label)}</span>${kindPill(seg.kind)}${confPill(seg.confidence)}</div>
        <div class="pmc-angle-fields">
          <div class="f"><b>النوع</b>${E(seg.gender || '—')}</div>
          <div class="f"><b>السن</b>${E(seg.ageRange || '—')}</div>
          <div class="f"><b>المكان</b>${E(seg.location || '—')}</div>
          <div class="f"><b>حجم البيانات</b>${E(seg.dataSize || '—')}</div>
        </div>
        ${seg.evidence ? `<div class="faint" style="font-size:11.5px;margin-top:8px;">الدليل: ${E(seg.evidence)}</div>` : ''}
      </div>`).join('') || '<div class="pmc-empty">البيانات غير كافية للحكم</div>'}
    </div>`;
}

// ---- §10/§11 — Sales angles ----
function renderAngles(mount, s) {
  mount.innerHTML = `
    <div class="pmc-card">
      <div class="h">🎯 أفضل زوايا بيع مقترحة</div>
      ${(s.angles || []).map((a, i) => `<div class="pmc-angle-card">
        <div class="head"><span class="name">${E(a.name)}</span><span class="cat">${E(a.category || '')}</span>${confPill(a.confidence)}${claimPill(a.claimStatus, a.claimReason)}</div>
        <div class="faint" style="font-size:12.5px;">${E(a.why || '')}</div>
        <div class="pmc-angle-fields">
          <div class="f"><b>الجمهور</b>${E(a.audience || '—')}</div>
          <div class="f"><b>السن</b>${E(a.ageRange || '—')}</div>
          <div class="f"><b>المكان</b>${E(a.location || '—')}</div>
          <div class="f"><b>المشكلة</b>${E(a.painPoint || '—')}</div>
          <div class="f"><b>الفايدة</b>${E(a.benefit || '—')}</div>
          <div class="f"><b>Hook مقترح</b>${E(a.hook || '—')}</div>
          <div class="f"><b>الشكل المقترح</b>${E(a.suggestedFormat || '—')}</div>
        </div>
        ${a.claimStatus === 'RED' ? `<div class="faint" style="font-size:11.5px;color:var(--amb-red);margin-top:6px;">🔴 ${E(a.claimReason)}</div>` : ''}
        <div class="toolbar" style="margin-top:10px;">
          <button class="amb-btn sm" data-gen-hooks="${i}">توليد Hooks لهذه الزاوية</button>
          <button class="amb-btn sm" data-gen-post="${i}">توليد بوست</button>
          <button class="amb-btn sm ghost" data-gen-idea="${i}">أفكار كرياتيف</button>
        </div>
      </div>`).join('') || '<div class="pmc-empty">البيانات غير كافية للحكم — استمر بالصرف على المنتج أو راجع تحليل المنافسين.</div>'}
    </div>`;
  mount.querySelectorAll('[data-gen-hooks]').forEach((b) => b.onclick = () => { state.genAngle = s.angles[Number(b.dataset.genHooks)].name; state.tab = 'hooks'; renderTabBody(); generateHooks(); });
  mount.querySelectorAll('[data-gen-post]').forEach((b) => b.onclick = () => { state.genAngle = s.angles[Number(b.dataset.genPost)].name; state.tab = 'hooks'; renderTabBody(); generatePost(); });
  mount.querySelectorAll('[data-gen-idea]').forEach((b) => b.onclick = () => { state.genAngle = s.angles[Number(b.dataset.genIdea)].name; state.tab = 'creative'; renderTabBody(); generateIdeas(); });
}

// ---- §12/§13/§14/§17 — Creative Intelligence ----
function renderCreative(mount, s) {
  mount.innerHTML = `
    <div class="pmc-card">
      <div class="h">🧠 ذكاء الكرياتيف</div>
      <div class="pmc-angle-fields">
        <div class="f"><b>أفضل إعلان</b>${s.bestAd ? `${E(s.bestAd.name)} — CPA ${fmtEGP(s.bestAd.cpa)}` : 'البيانات غير كافية للحكم'}</div>
        <div class="f"><b>أضعف إعلان</b>${s.worstAd ? `${E(s.worstAd.name)} — CPA ${fmtEGP(s.worstAd.cpa)}` : 'البيانات غير كافية للحكم'}</div>
        <div class="f"><b>أفضل Hook مكتشف</b>${E(s.bestAd?.analysis?.hook || '—')}</div>
        <div class="f"><b>أفضل زاوية مكتشفة</b>${E(s.bestAd?.analysis?.sellingAngle || '—')}</div>
      </div>
    </div>

    <div class="pmc-winner-box">
      <div style="font-weight:800;margin-bottom:6px;">🏆 بصمة الإعلان الرابح</div>
      ${s.winnerDna?.available ? `<ul style="margin:0 0 8px;padding-inline-start:18px;">${(s.winnerDna.reasons || []).map((r) => `<li>${E(r)}</li>`).join('')}</ul><div class="faint" style="font-size:12.5px;">${E(s.winnerDna.narrative || '')}</div>
        <div class="toolbar" style="margin-top:10px;"><button class="amb-btn sm" id="pmcVariations3">3 Variations</button><button class="amb-btn sm" id="pmcVariations5">5 Variations</button><button class="amb-btn sm" id="pmcVariations10">10 Variations</button></div>`
        : '<div class="faint">البيانات غير كافية للحكم بعد.</div>'}
    </div>

    <div class="pmc-loser-box">
      <div style="font-weight:800;margin-bottom:6px;">🔬 تحليل الإعلان الضعيف</div>
      ${s.loserAutopsy?.available ? `<div class="faint" style="font-size:12.5px;">السبب الجذري: <b>${E(s.loserAutopsy.rootCause)}</b><br/>${E(s.loserAutopsy.narrative || '')}</div>` : '<div class="faint">البيانات غير كافية للحكم بعد.</div>'}
    </div>

    <div class="pmc-card">
      <div class="h">🎨 أفكار كرياتيف${state.genAngle ? ` — ${E(state.genAngle)}` : ''}</div>
      <button class="amb-btn sm primary" id="pmcGenIdeas">توليد أفكار كرياتيف</button>
      <div id="pmcIdeasBox" style="margin-top:10px;">${ideasHtml(state.ideaResult)}</div>
    </div>

    <div class="pmc-card" style="margin-top:14px;">
      <div class="h">🏭 مصنع الإعلانات</div>
      <div class="faint" style="font-size:12px;margin-bottom:8px;">أرسل أفكار الكرياتيف مباشرة لمصنع الإعلانات لإنشاء الصور الفعلية.</div>
      <button class="amb-btn sm" id="pmcCfCheck">تحقق من الجاهزية</button>
      <div id="pmcCfStatus" style="margin-top:8px;"></div>
    </div>`;
  const gen3 = $('pmcVariations3'), gen5 = $('pmcVariations5'), gen10 = $('pmcVariations10');
  [gen3, gen5, gen10].forEach((b) => b && (b.onclick = () => UI.toast('الاشتقاقات هتتولد من نفس فكرة الإعلان الرابح — استخدم "أفكار كرياتيف" فوق ثم أرسلها لمصنع الإعلانات.', 'info')));
  $('pmcGenIdeas').onclick = generateIdeas;
  $('pmcCfCheck').onclick = checkCfReadiness;
}
function ideasHtml(ideas) {
  if (!ideas?.length) return '';
  return ideas.map((idea) => `<div class="pmc-idea-item">
    <div class="t">${E(idea.type)}</div>
    <div class="f"><b>المشهد:</b> ${E(idea.scene)}</div>
    <div class="f"><b>Hook:</b> ${E(idea.hook)}</div>
    <div class="f"><b>مكان المنتج:</b> ${E(idea.productPlacement)}</div>
    <div class="f"><b>النص الأساسي:</b> ${E(idea.mainText)}</div>
    <div class="f"><b>CTA:</b> ${E(idea.cta)}</div>
    <div class="f"><b>الجمهور المستهدف:</b> ${E(idea.targetAudience)}</div>
    <div class="f faint">${E(idea.whyItCouldWork)}</div>
  </div>`).join('');
}
async function generateIdeas() {
  const box = $('pmcIdeasBox'); if (box) box.innerHTML = '<div class="pmc-empty">🤖 بنولّد أفكار كرياتيف…</div>';
  try {
    const r = await api.post(`/api/product-marketing/profiles/${state.profile.id}/creative-ideas`, { angle: state.genAngle, count: 4 });
    state.ideaResult = r.ok ? r.ideas : null;
    if (!r.ok) UI.toast(r.reason || 'تعذّر توليد الأفكار.', 'error');
  } catch (e) { UI.toast(e.message, 'error'); state.ideaResult = null; }
  if (box) box.innerHTML = ideasHtml(state.ideaResult) || '<div class="pmc-empty">تعذّر التوليد.</div>';
}
async function checkCfReadiness() {
  const box = $('pmcCfStatus');
  try {
    const r = await api.get(`/api/product-marketing/profiles/${state.profile.id}/creative-factory-readiness`);
    box.innerHTML = r.ready ? `<span class="badge green">✅ جاهز — <a href="creative-factory.html">افتح مصنع الإعلانات</a></span>` : `<span class="badge gray">${E(r.reason)}</span>`;
  } catch (e) { box.innerHTML = `<span class="badge red">${E(e.message)}</span>`; }
}

// ---- §15/§16 — Hook Lab & Post Generator ----
function renderHooksTab(mount) {
  mount.innerHTML = `
    <div class="pmc-card">
      <div class="h">🎣 مختبر الـ Hooks</div>
      <div class="toolbar" style="margin-bottom:10px;">
        <input class="amb-input sm" id="pmcAngleInput" placeholder="الزاوية (اختياري)" value="${E(state.genAngle)}" />
        <select class="amb-select sm" id="pmcHookCount"><option value="5">5</option><option value="10" selected>10</option><option value="20">20</option></select>
        <button class="amb-btn sm primary" id="pmcGenHooks">توليد Hooks</button>
      </div>
      <div id="pmcHooksBox">${hooksHtml(state.hookResult)}</div>
    </div>
    <div class="pmc-card" style="margin-top:14px;">
      <div class="h">📝 مولد البوستات</div>
      <div class="toolbar" style="margin-bottom:10px;">
        <select class="amb-select sm" id="pmcToneSelect">
          ${['مباشر', 'فضولي', 'Problem/Solution', 'عائلي', 'Premium', 'شبابي', 'هدية', 'Demonstration', 'بسيط'].map((t) => `<option ${state.genTone === t ? 'selected' : ''}>${E(t)}</option>`).join('')}
        </select>
        <button class="amb-btn sm primary" id="pmcGenPost">توليد بوست</button>
      </div>
      <div id="pmcPostBox">${postHtml(state.postResult)}</div>
    </div>
    <div class="pmc-card" style="margin-top:14px;">
      <div class="h">📦 حزمة اختبار بضغطة واحدة</div>
      <div class="faint" style="font-size:12px;margin-bottom:8px;">5 Hooks + بوست + 3 أفكار كرياتيف لنفس الزاوية، جاهزين للإرسال لمصنع الإعلانات.</div>
      <button class="amb-btn sm primary" id="pmcGenPack">إنشاء حزمة اختبار</button>
      <div id="pmcPackBox" style="margin-top:10px;"></div>
    </div>`;
  $('pmcAngleInput').oninput = (e) => { state.genAngle = e.target.value; };
  $('pmcGenHooks').onclick = () => generateHooks(Number($('pmcHookCount').value));
  $('pmcGenPost').onclick = () => generatePost($('pmcToneSelect').value);
  $('pmcGenPack').onclick = generateTestPack;
}
function hooksHtml(hooks) {
  if (!hooks?.length) return '';
  return hooks.map((h) => `<div class="pmc-hook-item">${E(h.text)} ${claimPill(h.claimStatus, h.claimReason)}<div class="faint" style="font-size:11px;">${E(h.category || '')}</div></div>`).join('');
}
function postHtml(post) {
  if (!post) return '';
  return `<div class="pmc-hook-item">
    <div><b>Headline:</b> ${E(post.headline)}</div>
    <div style="margin-top:6px;"><b>قصير:</b> ${E(post.short)}</div>
    <div style="margin-top:6px;"><b>متوسط:</b> ${E(post.medium)}</div>
    <div style="margin-top:6px;"><b>طويل:</b> ${E(post.long)}</div>
    <div style="margin-top:6px;"><b>CTA:</b> ${E(post.cta)}</div>
    <div style="margin-top:6px;">${claimPill(post.claimStatus, post.claimReason)}</div>
  </div>`;
}
async function generateHooks(count = 10) {
  const box = $('pmcHooksBox'); if (box) box.innerHTML = '<div class="pmc-empty">🤖 بنولّد Hooks…</div>';
  try {
    const r = await api.post(`/api/product-marketing/profiles/${state.profile.id}/hooks`, { angle: state.genAngle, category: state.genCategory, count });
    state.hookResult = r.ok ? r.hooks : null;
    if (!r.ok) UI.toast(r.reason || 'تعذّر توليد الـ Hooks.', 'error');
  } catch (e) { UI.toast(e.message, 'error'); state.hookResult = null; }
  if (box) box.innerHTML = hooksHtml(state.hookResult) || '<div class="pmc-empty">تعذّر التوليد.</div>';
}
async function generatePost(tone = state.genTone) {
  state.genTone = tone;
  const box = $('pmcPostBox'); if (box) box.innerHTML = '<div class="pmc-empty">🤖 بنكتب البوست…</div>';
  try {
    const r = await api.post(`/api/product-marketing/profiles/${state.profile.id}/posts`, { angle: state.genAngle, tone });
    state.postResult = r.ok ? r.post : null;
    if (!r.ok) UI.toast(r.reason || 'تعذّر توليد البوست.', 'error');
  } catch (e) { UI.toast(e.message, 'error'); state.postResult = null; }
  if (box) box.innerHTML = postHtml(state.postResult) || '<div class="pmc-empty">تعذّر التوليد.</div>';
}
async function generateTestPack() {
  const box = $('pmcPackBox'); box.innerHTML = '<div class="pmc-empty">🤖 بنجهّز حزمة الاختبار…</div>';
  try {
    const pack = await api.post(`/api/product-marketing/profiles/${state.profile.id}/test-pack`, { angle: state.genAngle });
    box.innerHTML = `<div class="section-title" style="font-size:13px;">Hooks</div>${hooksHtml(pack.hooks) || '<div class="pmc-empty">—</div>'}
      <div class="section-title" style="font-size:13px;margin-top:10px;">بوست</div>${postHtml(pack.post) || '<div class="pmc-empty">—</div>'}
      <div class="section-title" style="font-size:13px;margin-top:10px;">أفكار كرياتيف</div>${ideasHtml(pack.ideas) || '<div class="pmc-empty">—</div>'}`;
  } catch (e) { UI.toast(e.message, 'error'); box.innerHTML = '<div class="pmc-empty">تعذّر إنشاء الحزمة.</div>'; }
}

// ---- §8 — Locations ----
function renderLocations(mount, s) {
  const rows = s.locations || [];
  mount.innerHTML = `
    <div class="pmc-card">
      <div class="h">📍 أفضل المحافظات — ${E(s.metrics?.windowLabel || '')}</div>
      <div class="faint" style="font-size:11.5px;margin-bottom:10px;">الترتيب حسب: الطلبات المُستلمة فعليًا أولًا، ثم معدل الاستلام — مش عدد المشتريات على Meta فقط (مناسب لأوردرات الدفع عند الاستلام).</div>
      ${rows.length ? `<div class="table-wrap"><table class="data pmc-loc-table">
        <thead><tr><th>المحافظة</th><th>الطلبات</th><th>مؤكدة</th><th>مُستلمة</th><th>مرتجعة</th><th>معدل الاستلام</th></tr></thead>
        <tbody>${rows.map((l) => `<tr><td>${E(l.government)}</td><td>${fmtNum(l.orders)}</td><td>${fmtNum(l.confirmed)}</td><td>${fmtNum(l.delivered)}</td><td>${fmtNum(l.returned)}</td><td>${fmtPct1(l.deliveryRate)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="pmc-empty">البيانات غير كافية للحكم — لا توجد طلبات مسجّلة بعنوان محافظة في هذه الفترة.</div>'}
      ${s.locationCommentary ? `<div class="faint" style="font-size:12px;margin-top:10px;">${E(s.locationCommentary)}</div>` : ''}
    </div>`;
}

// ---- §18 — Competitors ----
async function renderCompetitors(mount) {
  mount.innerHTML = '<div class="pmc-empty">بنحمّل بيانات المنافسين…</div>';
  if (!state.competitors) {
    try { state.competitors = await api.get(`/api/product-marketing/profiles/${state.profile.id}/competitors`); }
    catch (e) { state.competitors = { available: false, reason: e.message }; }
  }
  const c = state.competitors;
  if (!c.available) { mount.innerHTML = `<div class="pmc-empty">${E(c.reason)}${c.reason?.includes('البحث') ? ' — <a href="product-research.html">افتح صفحة البحث عن المنتجات</a>' : ''}</div>`; return; }
  mount.innerHTML = `
    <div class="pmc-card">
      <div class="h">🏆 تحليل المنافسين</div>
      <div class="faint" style="font-size:11.5px;margin-bottom:10px;">بيانات من صفحة "البحث عن المنتجات" الحالية — مفيش بحث جديد بيتعمل هنا.</div>
      ${c.competitors.map((cc) => `<div class="pmc-kv"><span>${E(cc.accountName || cc.accountUrl)} (${E(cc.platform)})</span><b>${cc.followerCount != null ? fmtNum(cc.followerCount) + ' متابع' : 'غير متاح'}</b></div>`).join('')}
    </div>`;
}

// ---- §21/§22/§24 — Tests & Results (memory + actions log + test pack) ----
async function renderTests(mount, s) {
  mount.innerHTML = `
    <div class="pmc-card">
      <div class="h">⚡ سجل التوصيات</div>
      ${actionsListHtml(s.actions)}
    </div>
    <div class="pmc-card" style="margin-top:14px;">
      <div class="h">🧠 الذاكرة التسويقية الذاتية التعلّم</div>
      <div id="pmcMemoryBox" class="pmc-empty">بنحمّل السجل…</div>
    </div>`;
  wireActionButtons(mount);
  try {
    const { entries } = await api.get(`/api/product-marketing/profiles/${state.profile.id}/memory`);
    $('pmcMemoryBox').outerHTML = entries.length ? entries.map((m) => `<div class="pmc-memory-item">
      <div class="lbl">${E(m.field)}</div>
      <div><b>الافتراض السابق:</b> ${E(JSON.stringify(m.previous))}</div>
      <div><b>الدليل الجديد:</b> ${E(m.evidence)}</div>
      <div><b>التوصية الجديدة:</b> ${E(JSON.stringify(m.new))}</div>
    </div>`).join('') : '<div class="pmc-empty" id="pmcMemoryBox">مفيش تغييرات في الافتراضات لسه — لسه أول تحليل لهذا المنتج.</div>';
  } catch { /* memory is best-effort */ }
}

document.addEventListener('DOMContentLoaded', init);
