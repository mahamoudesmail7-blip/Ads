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

const PLATFORM_LABEL = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', META_AD_LIBRARY: 'Meta Ads Library', google: 'Google' };
const CLASS_LABEL = { EXACT_MATCH: 'تطابق تام', VERY_SIMILAR: 'مشابه جدًا', SIMILAR: 'مشابه', RELATED: 'ذو صلة', IRRELEVANT: 'غير مرتبط', UNCLASSIFIED: 'غير مصنف' };
const CLASS_COLOR = { EXACT_MATCH: 'green', VERY_SIMILAR: 'green', SIMILAR: 'yellow', UNCLASSIFIED: '' };
const STATUS_LABEL_AR = {
  PENDING: 'في الانتظار...', ANALYZING: 'جاري تحليل المنتج...', GENERATING_QUERIES: 'جاري إنشاء كلمات البحث...',
  SEARCHING: 'جاري البحث في المنصات...', RANKING: 'جاري تحليل وترتيب النتائج...',
  COMPLETED: '✅ اكتمل البحث', PARTIAL: '⚠️ اكتمل جزئيًا', FAILED: '❌ فشل البحث', CANCELLED: '⛔ اتلغى البحث',
};
const PLATFORM_STATUS_AR = { PENDING: 'في الانتظار', SEARCHING: 'جاري البحث...', COMPLETE: 'مكتمل', PARTIAL: 'نتائج جزئية', FAILED: 'فشل', NOT_CONFIGURED: 'غير مربوط' };
const PLATFORM_STATUS_CLASS = { PENDING: 'st-pending', SEARCHING: 'st-running', COMPLETE: 'st-complete', PARTIAL: 'st-partial', FAILED: 'st-failed', NOT_CONFIGURED: 'st-pending' };
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
const MAX_REFERENCE_IMAGES = 4;
const internalCreativeDiscovery = {
  featureEnabled: false,
  chips: { alt: [], ar: [], en: [], kw: [] },
  images: [], // {base64, mediaType, name, dataUrl}[] — 1-4 real reference angles of the SAME product (Step: multi-image visual matching)
  currentSearchId: null,
  pollTimer: null,
  mode: 'quick',
  currentPage: 1,
  showAllMatches: false, // "توسيع النتائج المشابهة" toggle — false = strict >=75 default view
  currentSearchHasImage: false, // whether the CURRENT search had a reference image at all (real, from the backend — never guessed)
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

function renderImagePreviews() {
  const el = document.getElementById('icdImagePreviews');
  if (!el) return;
  el.innerHTML = internalCreativeDiscovery.images
    .map((img, i) => `<div class="icd-ref-thumb"><img src="${img.dataUrl}" alt="صورة ${i + 1}"><span class="icd-ref-idx">${i + 1}</span><button type="button" data-remove-image="${i}" title="حذف">×</button></div>`)
    .join('');
  el.querySelectorAll('[data-remove-image]').forEach((btn) => {
    btn.onclick = () => {
      internalCreativeDiscovery.images.splice(Number(btn.dataset.removeImage), 1);
      renderImagePreviews();
      updateImagePickerState();
    };
  });
}

function updateImagePickerState() {
  const btn = document.getElementById('icdBtnPickImage');
  const nameEl = document.getElementById('icdImageName');
  if (!btn || !nameEl) return;
  const count = internalCreativeDiscovery.images.length;
  btn.disabled = count >= MAX_REFERENCE_IMAGES;
  nameEl.textContent = count > 0 ? `${count}/${MAX_REFERENCE_IMAGES} صور مرفوعة` : '';
}

/** 1-4 real reference images of the SAME product (Step: multi-image visual matching) — 1 image still works fine; extra angles (side/back/packaging) only make visual matching more accurate, never required. */
function wireImageUpload() {
  const input = document.getElementById('icdImageInput');
  const btn = document.getElementById('icdBtnPickImage');
  if (!input || !btn) return;
  btn.onclick = () => input.click();
  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    input.value = ''; // allow re-selecting the same file later
    if (files.length === 0) return;
    const remainingSlots = MAX_REFERENCE_IMAGES - internalCreativeDiscovery.images.length;
    if (remainingSlots <= 0) { UI.toast(`أقصى عدد صور ${MAX_REFERENCE_IMAGES}`, 'error'); return; }
    for (const file of files.slice(0, remainingSlots)) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        UI.toast('نوع الصورة لازم يكون JPEG أو PNG أو WEBP', 'error');
        continue;
      }
      if (file.size > 5 * 1024 * 1024) {
        UI.toast('حجم كل صورة لازم يكون أقل من 5 ميجا', 'error');
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        internalCreativeDiscovery.images.push({ base64: dataUrl.split(',')[1], mediaType: file.type, name: file.name, dataUrl });
        renderImagePreviews();
        updateImagePickerState();
      };
      reader.readAsDataURL(file);
    }
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
  // Image-only mode (Step 1): a typed product name is no longer required
  // as long as an image was uploaded — Stage A generates the name
  // automatically server-side. Only block submit when NEITHER exists.
  const productName = document.getElementById('icdProductName').value.trim();
  const hasImage = internalCreativeDiscovery.images.length > 0;
  if (!productName && !hasImage) return UI.toast('اكتب اسم المنتج أو ارفع صورة له', 'error');
  const platforms = [...document.querySelectorAll('#icdPlatformToggles input:checked')].map((i) => i.value);
  if (platforms.length === 0) return UI.toast('اختار منصة واحدة على الأقل', 'error');

  const body = {
    productName,
    possibleNames: internalCreativeDiscovery.chips.alt,
    namesAr: internalCreativeDiscovery.chips.ar,
    namesEn: internalCreativeDiscovery.chips.en,
    keywords: internalCreativeDiscovery.chips.kw,
    description: document.getElementById('icdDescription').value.trim(),
    // 1-4 real reference images of the SAME product (Step: multi-image
    // visual matching) — the backend also still accepts the old singular
    // imageBase64/imageMediaType shape, but this page always sends the
    // new array now.
    images: hasImage ? internalCreativeDiscovery.images.map((img) => ({ imageBase64: img.base64, imageMediaType: img.mediaType })) : undefined,
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
  internalCreativeDiscovery.showAllMatches = false;
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
  internalCreativeDiscovery.currentSearchHasImage = Boolean(data.productImage);
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
    data.productImages?.length ? `<span>🖼️ بحث بالصورة (${data.productImages.length} صور مرجعية)</span>` : '',
  ].filter(Boolean).join('');

  let progressText = STATUS_LABEL_AR[data.status] || data.status;
  document.getElementById('icdProgressText').textContent = progressText;

  renderIdentityProfile(data);

  const grid = document.getElementById('icdPlatformGrid');
  grid.innerHTML = data.platforms
    .map((p) => {
      const s = data.platformStatus?.[p] || 'PENDING';
      const count = data.byPlatform?.[p] ?? 0;
      const err = data.platformErrors?.[p];
      const statusClass = { COMPLETE: 'COMPLETE', PARTIAL: 'PARTIAL', FAILED: 'FAILED' }[s] || '';
      // Real, backend-driven percentage (Step: real Progress system) —
      // read straight from data.platformProgress on every poll, never
      // computed or animated by a frontend timer. Defaults to 1% only
      // when the field is genuinely absent (e.g. an older search row from
      // before this feature) — never fabricated beyond that. The bar's
      // `width` transitions smoothly via CSS between real values; the
      // number itself is exactly what the backend last persisted.
      const progress = Math.max(1, Math.min(100, Math.round(data.platformProgress?.[p] ?? 1)));
      return `<div class="icd-platform-card status-${statusClass}">
        <div class="icd-platform-name">${PLATFORM_LABEL[p] || p}</div>
        <div class="icd-platform-provider" data-provider-for="${p}">جاري التحقق...</div>
        <div class="icd-platform-progress-pct">${progress}%</div>
        <div class="icd-platform-progress-bar"><div class="icd-platform-progress-fill st-${statusClass ? statusClass.toLowerCase() : 'running'}" style="width:${progress}%"></div></div>
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

// --- Identity Profile (Steps 21-23) — analysis state + the compact
// auto-generated profile display, real data only, never fabricated. ---
function renderIdentityProfile(data) {
  const panel = document.getElementById('icdIdentityPanel');
  if (!data.productImage) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  const stateEl = document.getElementById('icdAnalysisStateText');
  const profile = data.identityProfile;
  const cardEl = document.getElementById('icdIdentityProfileCard');

  if (!profile) {
    stateEl.textContent = ['ANALYZING'].includes(data.status) || data.status === 'PENDING' ? 'جاري التعرف على المنتج...' : 'لسه هيبدأ التعرف على المنتج...';
    cardEl.style.display = 'none';
    return;
  }

  if (!profile.mainProductName) {
    stateEl.textContent = 'الصورة غير كافية للتعرف الدقيق على المنتج';
    cardEl.style.display = 'none';
    return;
  }

  // identityProvider reflects which real provider actually produced this
  // profile (Step 24 diagnostic, Step 23 UI text) — LOCAL_VISION always
  // runs; ANTHROPIC is layered on top only when it was actually available
  // and actually improved something, never required (Step 31).
  const usedAnthropic = data.identityProvider === 'LOCAL_VISION+ANTHROPIC';
  const confidenceLabel = profile.overallConfidence >= 60 ? 'تم التعرف على المنتج محليًا' : 'تم التعرف بشكل مبدئي محليًا';
  stateEl.textContent = usedAnthropic ? `${confidenceLabel} — تم تحسين التعرف بالذكاء الاصطناعي` : confidenceLabel;
  cardEl.style.display = 'block';

  document.getElementById('icdIdName').textContent = `${profile.mainProductName} (ثقة ${profile.mainProductNameConfidence}%)`;
  document.getElementById('icdIdBrand').textContent = profile.brand ? `${profile.brand} (${profile.brandConfidence}%)` : 'غير ظاهر';
  document.getElementById('icdIdModel').textContent = profile.model ? `${profile.model} (${profile.modelConfidence}%)` : 'غير ظاهر';
  const altNames = [...new Set([...(profile.alternativeNames || []), ...(profile.arabicNames || []), ...(profile.englishNames || [])])];
  document.getElementById('icdIdAltNames').innerHTML = altNames.length ? altNames.map((n) => `<span class="icd-mini-badge">${escapeHtml(n)}</span>`).join('') : '<span class="icd-faint">لا يوجد</span>';
  document.getElementById('icdIdKeywords').innerHTML = (profile.keywords || []).length ? profile.keywords.map((k) => `<span class="icd-mini-badge cyan">${escapeHtml(k)}</span>`).join('') : '<span class="icd-faint">لا يوجد</span>';
  document.getElementById('icdIdDescription').textContent = profile.description || 'غير متاح';
  const features = [...(profile.distinctiveFeatures || [])];
  document.getElementById('icdIdFeatures').innerHTML = features.length ? features.map((f) => `<span class="icd-mini-badge yellow">${escapeHtml(f)}</span>`).join('') : '<span class="icd-faint">لا يوجد</span>';

  if (profile.multipleProductsDetected) {
    stateEl.textContent += ' — تم اكتشاف أكثر من منتج في الصورة، وتم التركيز على الأبرز';
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
  // Strict same-exact-product default (Step 5): whenever the search has a
  // reference image and the user hasn't asked to expand, only real
  // visualMatchScore >= 75 results are requested at all — never mixed
  // client-side, the backend itself excludes weaker/unverified matches
  // from this response.
  if (internalCreativeDiscovery.currentSearchHasImage && !internalCreativeDiscovery.showAllMatches) {
    params.minVisualMatchScore = 75;
  }

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
  renderExpandToggle(searchId, data.total);
  if (data.results.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = internalCreativeDiscovery.currentSearchHasImage && !internalCreativeDiscovery.showAllMatches
      ? 'مفيش نتايج مطابقة تمامًا للمنتج لسه — جرب "توسيع النتائج المشابهة" فوق.'
      : 'مفيش نتايج.';
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

/** "توسيع النتائج المشابهة" (Step 5) — only shown at all when this search has a reference image; lets the strict >=75 default view be relaxed on demand without ever silently mixing weak matches into it automatically. */
function renderExpandToggle(searchId, total) {
  const row = document.getElementById('icdExpandMatchesRow');
  if (!row) return;
  if (!internalCreativeDiscovery.currentSearchHasImage) { row.style.display = 'none'; return; }
  row.style.display = 'block';
  row.innerHTML = internalCreativeDiscovery.showAllMatches
    ? `<button class="icd-btn secondary small" id="icdBtnCollapseMatches">🎯 عرض المطابقات القوية فقط (75%+)</button>`
    : `<button class="icd-btn secondary small" id="icdBtnExpandMatches">توسيع النتائج المشابهة (عرض كل الدرجات)</button>`;
  document.getElementById('icdBtnExpandMatches')?.addEventListener('click', () => {
    internalCreativeDiscovery.showAllMatches = true;
    loadResults(searchId, 1);
  });
  document.getElementById('icdBtnCollapseMatches')?.addEventListener('click', () => {
    internalCreativeDiscovery.showAllMatches = false;
    loadResults(searchId, 1);
  });
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
        ${r.visualMatchScore !== null && r.visualMatchScore !== undefined
          ? `<span class="icd-mini-badge ${r.visualMatchScore >= 85 ? 'green' : r.visualMatchScore >= 75 ? 'cyan' : 'yellow'}" title="${escapeHtml((r.matchReasons || []).join('، '))}">🖼️ ${r.visualMatchScore}% — ${escapeHtml(r.matchLabel || '')}</span>`
          : (internalCreativeDiscovery.currentSearchHasImage ? '<span class="icd-mini-badge">🖼️ لم يتم التحقق بصريًا</span>' : '')}
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
  updateImagePickerState();
  wireModeToggle();

  document.getElementById('icdBtnStartSearch')?.addEventListener('click', startSearch);
  document.getElementById('icdBtnCancelSearch')?.addEventListener('click', cancelSearch);
  document.getElementById('icdBtnNewSearch')?.addEventListener('click', resetToNewSearch);
  document.getElementById('icdBtnToggleAdvanced')?.addEventListener('click', () => {
    const el = document.getElementById('icdAdvancedFields');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  });

  ['icdFilterPlatform', 'icdFilterClassification', 'icdFilterActive', 'icdSortBy'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => {
      if (internalCreativeDiscovery.currentSearchId) loadResults(internalCreativeDiscovery.currentSearchId, 1);
    });
  });

  loadProviderStatus();
}

init();
