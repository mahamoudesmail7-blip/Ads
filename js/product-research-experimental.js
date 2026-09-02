// product-research-experimental.js — "Internal Creative Discovery Platform"
// (EXPERIMENTAL). Fully isolated from js/product-research.js: its own
// module scope, its own state object (never touches or reads
// product-research.js's internal variables), its own DOM ids (all
// prefixed `icd*`), its own backend endpoints
// (/api/product-research/experimental/*). A bug in this file cannot break
// the real Product Research controller, and vice versa — the only shared
// surface is the read-only `api`/`UI` helper modules and the top-level
// section-toggle buttons, which just flip `display` on two container divs.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const EXP_API = '/api/product-research/experimental';

const PLATFORM_LABEL = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', META_AD_LIBRARY: 'Meta Ads Library' };
const CLASS_LABEL = { EXACT_MATCH: 'تطابق تام', VERY_SIMILAR: 'مشابه جدًا', SIMILAR: 'مشابه', RELATED: 'ذو صلة', IRRELEVANT: 'غير مرتبط', UNCLASSIFIED: 'غير مصنف' };
const CLASS_COLOR = { EXACT_MATCH: 'green', VERY_SIMILAR: 'green', SIMILAR: 'yellow', UNCLASSIFIED: '' };
const STATUS_LABEL_AR = {
  PENDING: 'في الانتظار...', ANALYZING: 'جاري تحليل المنتج...', GENERATING_QUERIES: 'جاري إنشاء كلمات البحث...',
  SEARCHING: 'جاري البحث في المنصات...', RANKING: 'جاري تحليل وترتيب النتائج...',
  COMPLETED: '✅ اكتمل البحث', PARTIAL: '⚠️ اكتمل جزئيًا', FAILED: '❌ فشل البحث', CANCELLED: '⛔ اتلغى البحث',
};
const PLATFORM_STATUS_AR = { PENDING: 'في الانتظار', COMPLETE: 'مكتمل', PARTIAL: 'نتائج جزئية', FAILED: 'فشل', NOT_CONFIGURED: 'غير مربوط' };
const PLATFORM_STATUS_CLASS = { PENDING: 'st-pending', COMPLETE: 'st-complete', PARTIAL: 'st-partial', FAILED: 'st-failed', NOT_CONFIGURED: 'st-pending' };
const PROVIDER_STATUS_BADGE = { CONNECTED: 'green', DEGRADED: 'yellow', ERROR: 'red', NOT_CONFIGURED: 'faint' };
const PROVIDER_STATUS_LABEL = { CONNECTED: '✅ متصل', DEGRADED: '🟡 غير مستقر', ERROR: '⚠️ خطأ', NOT_CONFIGURED: '⚪ غير مربوط' };
const PLATFORM_ERROR_LABEL_AR = {
  QUOTA_EXCEEDED: 'انتهت حصة المزود (مؤقت)', RATE_LIMITED: 'تجاوز حد الطلبات', INVALID_CREDENTIALS: 'بيانات اعتماد غير صحيحة',
  INSUFFICIENT_CREDITS: 'الرصيد غير متاح', TIMEOUT: 'انتهت المهلة', NETWORK_ERROR: 'مشكلة اتصال', SERVER_ERROR: 'خطأ من المزود',
  VALIDATION_ERROR: 'طلب غير صحيح', UNKNOWN_ERROR: 'خطأ غير معروف',
};

// Isolated state — deliberately named/namespaced per the request so it can
// never be confused with, or accidentally reused from, the real Product
// Research controller's module-level variables.
const internalCreativeDiscovery = {
  featureEnabled: false,
  chips: { alt: [], ar: [], en: [], kw: [] },
  imageBase64: null,
  imageMediaType: null,
  currentSearchId: null,
  pollTimer: null,
  mode: 'quick',
  currentPage: 1,
};

function escapeHtml(s) { return UI.escapeHtml ? UI.escapeHtml(String(s ?? '')) : String(s ?? ''); }

// --- Section toggle (top-level, shared markup only) ---
function wireSectionToggle() {
  const btnCurrent = document.getElementById('prSectionTabCurrent');
  const btnExperimental = document.getElementById('prSectionTabExperimental');
  const secCurrent = document.getElementById('prCurrentSection');
  const secExperimental = document.getElementById('prExperimentalSection');
  if (!btnCurrent || !btnExperimental) return;

  btnCurrent.onclick = () => {
    btnCurrent.classList.add('active');
    btnExperimental.classList.remove('active');
    secCurrent.style.display = '';
    secExperimental.style.display = 'none';
  };
  btnExperimental.onclick = () => {
    btnExperimental.classList.add('active');
    btnCurrent.classList.remove('active');
    secCurrent.style.display = 'none';
    secExperimental.style.display = '';
  };
}

// --- Chips (isolated copy — same UX as the real page, own state/DOM ids) ---
function renderChips(field) {
  const el = document.getElementById('icdChips' + field.charAt(0).toUpperCase() + field.slice(1));
  if (!el) return;
  el.innerHTML = internalCreativeDiscovery.chips[field].map((v, i) => `<span class="icd-chip">${escapeHtml(v)}<button data-field="${field}" data-idx="${i}" title="حذف">×</button></span>`).join('');
  el.querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      internalCreativeDiscovery.chips[btn.dataset.field].splice(Number(btn.dataset.idx), 1);
      renderChips(btn.dataset.field);
    };
  });
}
function addChip(field, inputEl) {
  if (!inputEl.value.trim()) return;
  internalCreativeDiscovery.chips[field].push(inputEl.value.trim());
  inputEl.value = '';
  renderChips(field);
}
function wireChipInput(inputId, field) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addChip(field, input); }
  });
  document.querySelector(`[data-icd-add-chip="${field}"]`)?.addEventListener('click', () => addChip(field, input));
}

function wireImageUpload() {
  const input = document.getElementById('icdImageInput');
  const btn = document.getElementById('icdBtnPickImage');
  if (!input || !btn) return;
  btn.onclick = () => input.click();
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      UI.toast('نوع الصورة لازم يكون JPEG أو PNG أو WEBP', 'error');
      input.value = ''; return;
    }
    if (file.size > 5 * 1024 * 1024) {
      UI.toast('حجم الصورة أكبر من 5 ميجا', 'error');
      input.value = ''; return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      internalCreativeDiscovery.imageBase64 = dataUrl.split(',')[1];
      internalCreativeDiscovery.imageMediaType = file.type;
      document.getElementById('icdImageName').textContent = file.name;
      const preview = document.getElementById('icdImagePreview');
      preview.src = dataUrl;
      preview.style.display = 'block';
    };
    reader.readAsDataURL(file);
  });
}

// --- Provider status (real, honest — never CONNECTED from key presence alone) ---
async function loadProviderStatus() {
  const el = document.getElementById('icdProviderStatusList');
  try {
    const data = await api.get(`${EXP_API}/status`);
    internalCreativeDiscovery.featureEnabled = Boolean(data.enabled);
    const tabBtn = document.getElementById('prSectionTabExperimental');
    if (tabBtn) tabBtn.style.display = internalCreativeDiscovery.featureEnabled ? '' : 'none';
    if (!internalCreativeDiscovery.featureEnabled) return;

    el.innerHTML = data.providers
      .map((p) => `<span class="icd-mini-badge ${p.status === 'CONNECTED' ? 'green' : ''}" style="font-size:11.5px; padding:4px 10px;">${PLATFORM_LABEL[p.platform] || p.platform}: ${escapeHtml(p.provider || '—')} — ${PROVIDER_STATUS_LABEL[p.status] || p.status}</span>`)
      .join('');
  } catch (err) {
    if (el) el.innerHTML = `<span class="icd-faint">⚠️ ${escapeHtml(err.message)}</span>`;
  }
}

// --- Mode toggle ---
function wireModeToggle() {
  document.getElementById('icdModeQuick')?.addEventListener('click', () => setMode('quick'));
  document.getElementById('icdModeDeep')?.addEventListener('click', () => setMode('deep'));
}
function setMode(mode) {
  internalCreativeDiscovery.mode = mode;
  document.getElementById('icdModeQuick')?.classList.toggle('active', mode === 'quick');
  document.getElementById('icdModeDeep')?.classList.toggle('active', mode === 'deep');
}

// --- Start / cancel / new search ---
async function startSearch() {
  const productName = document.getElementById('icdProductName').value.trim();
  if (!productName) return UI.toast('اكتب اسم المنتج الأول', 'error');
  const platforms = [...document.querySelectorAll('#icdPlatformToggles input:checked')].map((i) => i.value);
  if (platforms.length === 0) return UI.toast('اختار منصة واحدة على الأقل', 'error');

  const body = {
    productName,
    possibleNames: internalCreativeDiscovery.chips.alt,
    namesAr: internalCreativeDiscovery.chips.ar,
    namesEn: internalCreativeDiscovery.chips.en,
    keywords: internalCreativeDiscovery.chips.kw,
    description: document.getElementById('icdDescription').value.trim(),
    imageBase64: internalCreativeDiscovery.imageBase64 || undefined,
    imageMediaType: internalCreativeDiscovery.imageMediaType || undefined,
    country: document.getElementById('icdCountry').value,
    platforms,
    mode: internalCreativeDiscovery.mode,
    adLibraryRawLimit: Number(document.getElementById('icdAdLibraryRawLimit').value),
    adLibraryActiveOnly: false,
  };

  const btn = document.getElementById('icdBtnStartSearch');
  btn.disabled = true;
  try {
    const { searchId } = await api.post(`${EXP_API}/search`, body);
    internalCreativeDiscovery.currentSearchId = searchId;
    document.getElementById('icdProductCard').style.display = 'block';
    document.getElementById('icdPlatformPanel').style.display = 'block';
    document.getElementById('icdBtnCancelSearch').style.display = '';
    startPolling(searchId);
  } catch (err) {
    UI.toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function cancelSearch() {
  if (!internalCreativeDiscovery.currentSearchId) return;
  try {
    await api.post(`${EXP_API}/search/${internalCreativeDiscovery.currentSearchId}/cancel`, {});
    UI.toast('تم إلغاء البحث');
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

function resetToNewSearch() {
  if (internalCreativeDiscovery.pollTimer) clearInterval(internalCreativeDiscovery.pollTimer);
  internalCreativeDiscovery.currentSearchId = null;
  document.getElementById('icdProductCard').style.display = 'none';
  document.getElementById('icdPlatformPanel').style.display = 'none';
  document.getElementById('icdSummaryPanel').style.display = 'none';
  document.getElementById('icdFiltersPanel').style.display = 'none';
  document.getElementById('icdResultsPanel').style.display = 'none';
  document.getElementById('icdBtnCancelSearch').style.display = 'none';
}

// --- Polling / progress ---
function startPolling(searchId) {
  if (internalCreativeDiscovery.pollTimer) clearInterval(internalCreativeDiscovery.pollTimer);
  const poll = async () => {
    try {
      const data = await api.get(`${EXP_API}/search/${searchId}`);
      renderProgress(data);
      if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(data.status)) {
        clearInterval(internalCreativeDiscovery.pollTimer);
        document.getElementById('icdBtnCancelSearch').style.display = 'none';
        if (data.resultCount > 0) {
          document.getElementById('icdSummaryPanel').style.display = 'block';
          document.getElementById('icdFiltersPanel').style.display = 'block';
          document.getElementById('icdResultsPanel').style.display = 'block';
          await loadResults(searchId, 1);
        }
      }
    } catch (err) {
      clearInterval(internalCreativeDiscovery.pollTimer);
      UI.toast(err.message, 'error');
    }
  };
  poll();
  internalCreativeDiscovery.pollTimer = setInterval(poll, 2000);
}

function renderProgress(data) {
  document.getElementById('icdProductName2').textContent = data.productName;
  const thumb = document.getElementById('icdProductThumb');
  const placeholder = document.getElementById('icdProductThumbPlaceholder');
  if (data.productImage) { thumb.src = data.productImage; thumb.style.display = 'block'; placeholder.style.display = 'none'; }
  else { thumb.style.display = 'none'; placeholder.style.display = 'flex'; }

  document.getElementById('icdProductMeta').innerHTML = [
    `<span>نوع البحث: <b>${data.mode === 'deep' ? 'عميق' : 'سريع'}</b></span>`,
    `<span>عدد المنصات: <b>${data.platforms.length}</b></span>`,
    `<span>إجمالي النتائج: <b>${data.resultCount}</b></span>`,
    `<span>الحالة: <b>${STATUS_LABEL_AR[data.status] || data.status}</b></span>`,
    data.productImage ? `<span>🖼️ بحث بالصورة</span>` : '',
  ].filter(Boolean).join('');

  let progressText = STATUS_LABEL_AR[data.status] || data.status;
  document.getElementById('icdProgressText').textContent = progressText;

  const grid = document.getElementById('icdPlatformGrid');
  grid.innerHTML = data.platforms
    .map((p) => {
      const s = data.platformStatus?.[p] || 'PENDING';
      const count = data.byPlatform?.[p] ?? 0;
      const err = data.platformErrors?.[p];
      const statusClass = { COMPLETE: 'COMPLETE', PARTIAL: 'PARTIAL', FAILED: 'FAILED' }[s] || '';
      return `<div class="icd-platform-card status-${statusClass}">
        <div class="icd-platform-name">${PLATFORM_LABEL[p] || p}</div>
        <div class="icd-platform-provider" data-provider-for="${p}">جاري التحقق...</div>
        <div class="icd-platform-count">${count}</div>
        <div class="icd-platform-count-label">نتيجة تم جمعها</div>
        <span class="icd-platform-status ${PLATFORM_STATUS_CLASS[s] || 'st-pending'}">${PLATFORM_STATUS_AR[s] || s}</span>
        ${err ? `<div class="icd-platform-error">${escapeHtml(PLATFORM_ERROR_LABEL_AR[err.errorType] || err.errorType)}</div>` : ''}
      </div>`;
    })
    .join('');

  // Fill in the real provider name per platform card from the same status
  // endpoint already loaded (avoids a second round trip on every poll tick).
  applyKnownProviders();

  if (data.summary) {
    const s = data.summary;
    document.getElementById('icdSummaryGrid').innerHTML = [
      { l: 'إجمالي النتائج', n: s.totalResults },
      { l: 'النتائج الفريدة', n: s.uniqueResults },
      { l: 'مطابقة تامة', n: s.exactMatches },
      { l: 'مطابقة قوية', n: s.verySimilar },
      { l: 'مشابهة', n: s.similar },
      { l: 'غير مصنفة', n: s.unclassified },
    ].map((t) => `<div class="icd-summary-tile"><div class="n">${t.n}</div><div class="l">${escapeHtml(t.l)}</div></div>`).join('');
  }
}

let knownProviders = null;
async function applyKnownProviders() {
  if (!knownProviders) {
    try {
      const data = await api.get(`${EXP_API}/status`);
      knownProviders = Object.fromEntries((data.providers || []).map((p) => [p.platform, p.provider]));
    } catch { knownProviders = {}; }
  }
  document.querySelectorAll('[data-provider-for]').forEach((el) => {
    const p = el.dataset.providerFor;
    el.textContent = `المصدر: ${knownProviders[p] || 'غير معروف'}`;
  });
}

// --- Results ---
async function loadResults(searchId, page = 1) {
  internalCreativeDiscovery.currentPage = page;
  const params = { page, pageSize: 50 };
  const platform = document.getElementById('icdFilterPlatform')?.value;
  if (platform) params.platform = platform;
  const classification = document.getElementById('icdFilterClassification')?.value;
  if (classification) params.classification = classification;
  const active = document.getElementById('icdFilterActive')?.value;
  if (active) params.active = active;
  const sort = document.getElementById('icdSortBy')?.value;
  if (sort && sort !== 'match') params.sort = sort;

  let data;
  try {
    data = await api.get(`${EXP_API}/search/${searchId}/results`, params);
  } catch (err) {
    UI.toast(err.message, 'error');
    return;
  }

  const grid = document.getElementById('icdResultGrid');
  const empty = document.getElementById('icdResultsEmpty');
  const rangeEl = document.getElementById('icdResultsRangeText');
  if (data.results.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    rangeEl.textContent = '';
  } else {
    empty.style.display = 'none';
    grid.innerHTML = data.results.map(resultCardHtml).join('');
    const from = (data.page - 1) * data.pageSize + 1;
    const to = Math.min(data.page * data.pageSize, data.total);
    rangeEl.textContent = `عرض ${from}–${to} من ${data.total} نتيجة`;
  }

  const pages = Math.ceil(data.total / data.pageSize);
  const pagEl = document.getElementById('icdResultsPagination');
  pagEl.innerHTML = pages > 1
    ? Array.from({ length: pages }, (_, i) => `<button class="icd-btn secondary small${i + 1 === page ? '' : ''}" data-page="${i + 1}" style="${i + 1 === page ? 'border-color:var(--icd-cyan);color:var(--icd-cyan);' : ''}">${i + 1}</button>`).join('')
    : '';
  pagEl.querySelectorAll('button').forEach((b) => (b.onclick = () => loadResults(searchId, Number(b.dataset.page))));
}

function resultCardHtml(r) {
  const classification = r.classification || 'UNCLASSIFIED';
  const m = r.metrics || {};
  return `<div class="icd-result-card">
    ${r.thumbnail ? `<img class="icd-result-thumb" src="${escapeHtml(r.thumbnail)}" />` : `<div class="icd-result-thumb-placeholder">🖼️</div>`}
    <div class="icd-result-body">
      <div class="icd-result-platform">${PLATFORM_LABEL[r.platform] || r.platform}</div>
      <div class="icd-result-title">${escapeHtml(r.title || r.accountName || 'بدون عنوان')}</div>
      <div class="icd-result-meta">${r.accountName ? `👤 ${escapeHtml(r.accountName)}` : ''}${r.publishedAt ? ` · ${new Date(r.publishedAt).toLocaleDateString('ar-EG')}` : ''}</div>
      <div class="icd-result-badges">
        <span class="icd-mini-badge ${CLASS_COLOR[classification] || ''}">${CLASS_LABEL[classification] || classification}${r.matchScore !== null && r.matchScore !== undefined ? ` ${r.matchScore}%` : ''}</span>
        ${m.activeStatus === 'ACTIVE' ? '<span class="icd-mini-badge green">🟢 نشط</span>' : ''}
        <span class="icd-mini-badge">${escapeHtml(r.provider || '')}</span>
      </div>
      <div class="icd-result-actions">
        <a class="icd-btn secondary small" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">فتح المصدر</a>
        <button class="icd-btn secondary small" data-action="save" data-id="${r.id}">حفظ</button>
      </div>
    </div>
  </div>`;
}

// --- Init ---
function init() {
  wireSectionToggle();
  wireChipInput('icdInputAlt', 'alt');
  wireChipInput('icdInputAr', 'ar');
  wireChipInput('icdInputEn', 'en');
  wireChipInput('icdInputKw', 'kw');
  wireImageUpload();
  wireModeToggle();

  document.getElementById('icdBtnStartSearch')?.addEventListener('click', startSearch);
  document.getElementById('icdBtnCancelSearch')?.addEventListener('click', cancelSearch);
  document.getElementById('icdBtnNewSearch')?.addEventListener('click', resetToNewSearch);

  ['icdFilterPlatform', 'icdFilterClassification', 'icdFilterActive', 'icdSortBy'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => {
      if (internalCreativeDiscovery.currentSearchId) loadResults(internalCreativeDiscovery.currentSearchId, 1);
    });
  });

  loadProviderStatus();
}

init();
