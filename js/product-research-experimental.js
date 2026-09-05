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
const MATCH_DECISION_LABEL = { EXACT: '🎯 مطابق للمنتج', REVIEW: '🔍 محتاج مراجعة', REJECT: 'مرفوض' };
const MATCH_DECISION_COLOR = { EXACT: 'green', REVIEW: 'yellow', REJECT: 'red' };
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

// --- Visual-only additions (premium redesign) ---
// AI Analysis Pipeline nodes — each mapped to a REAL backend search status
// (data.status, already returned by GET /search/:id, unchanged). Never a
// fake/invented stage: GENERATING_QUERIES legitimately covers both
// "استخراج الأسماء" and "كلمات مفتاحية" since the backend doesn't expose a
// finer split, so both nodes light up together while that one real status
// is active — never fabricated beyond what the backend actually reports.
const PIPELINE_NODES = [
  { icon: '📷', label: 'تحليل الصورة', status: 'ANALYZING' },
  { icon: '🏷️', label: 'استخراج الأسماء', status: 'GENERATING_QUERIES' },
  { icon: '🔑', label: 'كلمات مفتاحية', status: 'GENERATING_QUERIES' },
  { icon: '🔍', label: 'بدء البحث', status: 'SEARCHING' },
  { icon: '📦', label: 'جمع النتائج', status: 'RANKING' },
];
const PIPELINE_ORDER = ['PENDING', 'ANALYZING', 'GENERATING_QUERIES', 'SEARCHING', 'RANKING'];

// Shared ring geometry (perf: computed once, reused by both the initial
// build and every incremental update below — see renderPlatformGrid).
const RING_R = 30;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;
function ringDashOffset(progress) {
  return Math.max(0, RING_CIRCUMFERENCE * (1 - progress / 100)).toFixed(1);
}

/** Real, deterministic SVG circular progress ring (Step: circular progress) — the SAME `progress` number already computed from data.platformProgress drives stroke-dashoffset; no separate/fake value. Used only for the FIRST render of a platform card — every later poll updates the existing ring's attributes in place (renderPlatformGrid) instead of rebuilding this markup, so the CSS `transition` on stroke-dashoffset can actually interpolate between real values instead of snapping on a freshly-created node. */
function svgRing(progress, ringClass) {
  return `<div class="icd-ring-wrap"><svg class="icd-ring" width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
    <circle class="icd-ring-bg" cx="36" cy="36" r="${RING_R}"></circle>
    <circle class="icd-ring-fill ${ringClass}" cx="36" cy="36" r="${RING_R}" stroke-dasharray="${RING_CIRCUMFERENCE.toFixed(1)}" stroke-dashoffset="${ringDashOffset(progress)}"></circle>
  </svg><div class="icd-ring-pct">${progress}%</div></div>`;
}

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
  competitorPollTimer: null, // Step: Meta Ads competitor intelligence — separate slow poll, only while a batch is genuinely in progress, decoupled from the fast 2s progress poll
  mode: 'quick',
  currentPage: 1,
  matchGroup: 'EXACT', // Step: exact product matching — 'EXACT' | 'REVIEW' tab, only meaningful when currentSearchVisualMatchingActive
  lastMatchDecisions: null, // {exact, review, reject} counts from the most recent poll's summary — used for the tab labels/counts without a separate request
  resultsById: {}, // Step: Part 8 — id -> full result object from the most recent loadResults(), read by the "عرض التحليل" expandable toggle
  currentSearchVisualMatchingActive: false, // whether the CURRENT search actually ran real visual verification (data.visualMatchingActive) — never just "an image was uploaded"
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
    // renderPlatformGrid() now updates existing cards by platform key
    // instead of replacing the whole grid every poll (perf) — so a NEW
    // search must explicitly start from an empty grid, otherwise it would
    // silently reuse/update the PREVIOUS search's cards.
    const grid = document.getElementById('icdPlatformGrid');
    if (grid) grid.innerHTML = '';
    resetCompetitorPanel();
    startPolling(searchId);
    wireCompetitorToggle();
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
  internalCreativeDiscovery.matchGroup = 'EXACT';
  internalCreativeDiscovery.lastMatchDecisions = null;
  document.getElementById('icdProductCard').style.display = 'none';
  document.getElementById('icdPlatformPanel').style.display = 'none';
  document.getElementById('icdSummaryPanel').style.display = 'none';
  document.getElementById('icdFiltersPanel').style.display = 'none';
  document.getElementById('icdResultsPanel').style.display = 'none';
  document.getElementById('icdBtnCancelSearch').style.display = 'none';
  resetCompetitorPanel();
  const qbPanel = document.getElementById('icdQueryBreakdownPanel');
  const qbBody = document.getElementById('icdQueryBreakdownBody');
  const qbHint = document.getElementById('icdQueryBreakdownToggleHint');
  if (qbPanel) qbPanel.style.display = 'none';
  if (qbBody) qbBody.style.display = 'none';
  if (qbHint) qbHint.textContent = 'اضغط للعرض';
}

/** Step: Meta Ads competitor intelligence — collapsed/empty state for a fresh search, and stops any in-flight slow poll from a PREVIOUS search. */
function resetCompetitorPanel() {
  if (internalCreativeDiscovery.competitorPollTimer) {
    clearInterval(internalCreativeDiscovery.competitorPollTimer);
    internalCreativeDiscovery.competitorPollTimer = null;
  }
  const panel = document.getElementById('icdCompetitorPanel');
  const body = document.getElementById('icdCompetitorBody');
  const hint = document.getElementById('icdCompetitorToggleHint');
  const content = document.getElementById('icdCompetitorContent');
  const empty = document.getElementById('icdCompetitorEmpty');
  if (panel) panel.style.display = 'none';
  if (body) body.style.display = 'none';
  if (hint) hint.textContent = 'اضغط للعرض';
  if (content) content.style.display = 'none';
  if (empty) empty.style.display = 'none';
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
  // Real signal (Step: exact product matching) — data.visualMatchingActive
  // comes straight from whether any result actually got a real
  // visual_match_score, NOT from identityProvider. That distinction
  // matters now: the common manual-name+image case builds reference
  // embeddings via the lightweight path (buildReferenceEmbeddings) without
  // ever generating a Product Identity Profile, so identityProvider stays
  // null there even though visual verification genuinely ran. Using the
  // old identityProvider-based check would have silently hidden the exact-
  // match tabs for exactly the case they matter most for.
  internalCreativeDiscovery.currentSearchVisualMatchingActive = Boolean(data.visualMatchingActive);
  internalCreativeDiscovery.lastMatchDecisions = data.summary?.matchDecisions || null;
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
    // Step: honest AI-expansion status (Part 2/11) — never pretend Claude
    // enriched the name/keyword vocabulary when it actually fell back
    // (e.g. insufficient Anthropic credits). The names the user typed
    // themselves (أسماء المنتج chips) still drive the real search either way.
    data.aiProfile?._analysisSource === 'fallback' ? '<span class="icd-mini-badge yellow">⚠️ توسيع الأسماء بالذكاء الاصطناعي غير متاح حاليًا — استخدم الأسماء اللي كتبتها بس</span>' : '',
  ].filter(Boolean).join('');

  let progressText = STATUS_LABEL_AR[data.status] || data.status;
  document.getElementById('icdProgressText').textContent = progressText;

  // PERF: a single class drives every "only while actively searching"
  // visual (hero halo/scan, overall-progress shimmer) via CSS — computed
  // once per poll from the real status, never a separate timer.
  const isActive = !['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(data.status);
  document.getElementById('icdProductCard')?.classList.toggle('icd-searching-active', isActive);

  renderIdentityProfile(data);
  renderPipeline(data);
  renderOverallProgress(data);
  renderPlatformGrid(data);
  renderSummaryTiles(data);
  renderCompetitorTabAvailability(data);
}

/**
 * PERF (Step: avoid re-rendering all platform cards on every poll): the
 * previous version replaced the ENTIRE grid's innerHTML every 2s poll,
 * destroying and recreating every card (and its SVG ring) even when
 * nothing about that platform had changed — real cost multiplied by up to
 * 6 platforms every single tick for the whole duration of a search, and
 * it also meant the ring's CSS `transition` could never actually
 * interpolate (a brand-new SVG node has no "previous value" to animate
 * from). This now builds each card ONCE and, on every later poll, only
 * touches the specific attributes/text that actually changed — same real
 * data, same real values, far less DOM/style work per tick.
 */
function renderPlatformGrid(data) {
  const grid = document.getElementById('icdPlatformGrid');
  if (!grid) return;
  const existing = new Map([...grid.children].map((el) => [el.dataset.platform, el]));

  for (const p of data.platforms) {
    const s = data.platformStatus?.[p] || 'PENDING';
    const count = data.byPlatform?.[p] ?? 0;
    const err = data.platformErrors?.[p];
    const statusClass = { COMPLETE: 'COMPLETE', PARTIAL: 'PARTIAL', FAILED: 'FAILED' }[s] || '';
    // Real, backend-driven percentage (Step: real Progress system) — read
    // straight from data.platformProgress on every poll, never computed or
    // animated by a frontend timer. Defaults to 1% only when the field is
    // genuinely absent (e.g. an older search row from before this
    // feature) — never fabricated beyond that.
    const progress = Math.max(1, Math.min(100, Math.round(data.platformProgress?.[p] ?? 1)));
    const ringClass = PLATFORM_STATUS_CLASS[s] || 'st-pending';

    let card = existing.get(p);
    if (!card) {
      // First time this platform card is rendered for this search — build it once.
      card = document.createElement('div');
      card.dataset.platform = p;
      card.innerHTML = `<div class="icd-platform-head"><div class="icd-platform-name">${PLATFORM_LABEL[p] || p}</div></div>
        <div class="icd-platform-provider" data-provider-for="${p}">جاري التحقق...</div>
        ${svgRing(progress, ringClass)}
        <div class="icd-platform-count">${count}</div>
        <div class="icd-platform-count-label">نتيجة تم جمعها</div>
        <span class="icd-platform-status ${ringClass}">${PLATFORM_STATUS_AR[s] || s}</span>`;
      card.className = `icd-platform-card status-${statusClass}`;
      card.dataset._status = s;
      card.dataset._progress = String(progress);
      grid.appendChild(card);
      continue; // already fully up to date on first paint
    }

    // Update only what actually changed (Step: update only DOM values that changed).
    if (card.dataset._status !== s) {
      card.dataset._status = s;
      card.className = `icd-platform-card status-${statusClass}`;
      const ringFill = card.querySelector('.icd-ring-fill');
      if (ringFill) ringFill.setAttribute('class', `icd-ring-fill ${ringClass}`);
      const statusEl = card.querySelector('.icd-platform-status');
      if (statusEl) { statusEl.className = `icd-platform-status ${ringClass}`; statusEl.textContent = PLATFORM_STATUS_AR[s] || s; }
    }
    if (card.dataset._progress !== String(progress)) {
      card.dataset._progress = String(progress);
      const ringFill = card.querySelector('.icd-ring-fill');
      // Same DOM node as last poll → the CSS `transition` on
      // stroke-dashoffset now genuinely interpolates from the real
      // previous value to the real new one (Step: rings transition only
      // when real progress changes).
      if (ringFill) ringFill.setAttribute('stroke-dashoffset', ringDashOffset(progress));
      const pctEl = card.querySelector('.icd-ring-pct');
      if (pctEl) pctEl.textContent = `${progress}%`;
    }
    const countEl = card.querySelector('.icd-platform-count');
    if (countEl && countEl.textContent !== String(count)) countEl.textContent = count;

    const errText = err ? (PLATFORM_ERROR_LABEL_AR[err.errorType] || err.errorType) : '';
    let errEl = card.querySelector('.icd-platform-error');
    if (errText) {
      if (!errEl) { card.insertAdjacentHTML('beforeend', `<div class="icd-platform-error"></div>`); errEl = card.querySelector('.icd-platform-error'); }
      if (errEl.textContent !== errText) errEl.textContent = errText;
    } else if (errEl) {
      errEl.remove();
    }
  }

  // Defensive parity with the old full-replace behavior — data.platforms
  // doesn't actually change once a search starts, but if it ever did,
  // don't leave a stale card behind.
  for (const [p, el] of existing) if (!data.platforms.includes(p)) el.remove();

  // Fill in the real provider name per platform card from the same status
  // endpoint already loaded (avoids a second round trip on every poll tick).
  applyKnownProviders();
}

function renderSummaryTiles(data) {
  if (!data.summary) return;
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

/** AI Analysis Pipeline (visual redesign only) — every node's done/current/upcoming state is derived purely from the real data.status the backend already returns; never a fabricated stage. Hidden entirely for FAILED/CANCELLED since this frontend has no reliable way to know which real stage was reached when the pipeline stopped (never guessed). */
function renderPipeline(data) {
  const el = document.getElementById('icdPipeline');
  if (!el) return;
  if (['FAILED', 'CANCELLED'].includes(data.status)) { el.style.display = 'none'; return; }
  el.style.display = 'flex';

  const terminal = ['COMPLETED', 'PARTIAL'].includes(data.status);
  const currentOrderIdx = terminal ? PIPELINE_ORDER.length : PIPELINE_ORDER.indexOf(data.status === 'PENDING' ? 'ANALYZING' : data.status);

  el.innerHTML = PIPELINE_NODES.map((node) => {
    const nodeOrderIdx = PIPELINE_ORDER.indexOf(node.status);
    const state = (terminal || nodeOrderIdx < currentOrderIdx) ? 'done' : (nodeOrderIdx === currentOrderIdx ? 'current' : '');
    return `<div class="icd-pipeline-node ${state}">
      <div class="icd-pipeline-line"></div>
      <div class="icd-pipeline-icon">${state === 'done' ? '✓' : node.icon}</div>
      <div class="icd-pipeline-label">${escapeHtml(node.label)}</div>
    </div>`;
  }).join('');
}

/** Overall progress (visual redesign only) — a real, plain average of the real per-platform data.platformProgress values already persisted by the backend. Not a frontend timer and not simulated: if the backend hasn't moved any platform past 1%, this correctly shows 1%; it only moves when a real poll returns real updated numbers. */
function renderOverallProgress(data) {
  const wrap = document.getElementById('icdOverallProgress');
  const fill = document.getElementById('icdOverallFill');
  const pctEl = document.getElementById('icdOverallPct');
  if (!wrap || !fill || !pctEl) return;
  const values = (data.platforms || []).map((p) => data.platformProgress?.[p]).filter((v) => typeof v === 'number');
  if (values.length === 0) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  const avg = Math.max(1, Math.min(100, Math.round(values.reduce((a, b) => a + b, 0) / values.length)));
  fill.style.width = `${avg}%`;
  pctEl.textContent = `${avg}%`;
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
  // Step: exact product matching — whenever real visual verification ran
  // for this search, results are requested pre-split by the real stored
  // match_decision (مطابق للمنتج / محتاج مراجعة) rather than a score
  // slider; REJECT is never requestable (the backend already hides those
  // via ignored:true). Text-only searches (no image) never set this —
  // the plain flat list stays exactly as before.
  if (internalCreativeDiscovery.currentSearchVisualMatchingActive) {
    params.matchDecision = internalCreativeDiscovery.matchGroup;
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
  renderMatchTabs(searchId);
  if (data.results.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = internalCreativeDiscovery.currentSearchVisualMatchingActive
      ? (internalCreativeDiscovery.matchGroup === 'EXACT'
          ? 'مفيش نتايج مطابقة تمامًا للمنتج لسه — جرب تبويب "محتاج مراجعة" فوق.'
          : 'مفيش نتايج تحتاج مراجعة.')
      : 'مفيش نتايج.';
    rangeEl.textContent = '';
  } else {
    empty.style.display = 'none';
    grid.innerHTML = data.results.map(resultCardHtml).join('');
    // Step: Part 8 — the "عرض التحليل" expandable view needs the full
    // adAnalysis object at toggle time; kept in a plain map rather than
    // re-fetching, refreshed on every page load (stale entries from a
    // previous page are harmless — only ever read by their own id).
    for (const r of data.results) internalCreativeDiscovery.resultsById[r.id] = r;
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

/**
 * Step: exact product matching — result grouping tabs. Only shown when
 * this search actually ran real visual verification (currentSearchVisual
 * MatchingActive); text-only searches never see this, unchanged from
 * before. Two explicit, honestly-labeled groups (never a score slider):
 * "🎯 مطابق للمنتج" (match_decision=EXACT, the default) and "🔍 محتاج
 * مراجعة" (match_decision=REVIEW). REJECT results are never a tab — they
 * stay hidden (ignored:true on the backend), exactly as the user asked.
 * Counts come from the most recent poll's summary.matchDecisions, no
 * extra request needed.
 */
function renderMatchTabs(searchId) {
  const row = document.getElementById('icdExpandMatchesRow');
  if (!row) return;
  if (!internalCreativeDiscovery.currentSearchVisualMatchingActive) { row.style.display = 'none'; return; }
  const counts = internalCreativeDiscovery.lastMatchDecisions || { exact: 0, review: 0, reject: 0 };
  row.style.display = 'flex';
  row.style.gap = '8px';
  const tab = (group, label, count) => {
    const active = internalCreativeDiscovery.matchGroup === group;
    return `<button class="icd-btn ${active ? '' : 'secondary'} small" data-match-group="${group}"${active ? ' style="border-color:var(--icd-cyan);color:var(--icd-cyan);"' : ''}>${label} (${count})</button>`;
  };
  row.innerHTML = tab('EXACT', '🎯 مطابق للمنتج', counts.exact) + tab('REVIEW', '🔍 محتاج مراجعة', counts.review);
  row.querySelectorAll('[data-match-group]').forEach((btn) => {
    btn.addEventListener('click', () => {
      internalCreativeDiscovery.matchGroup = btn.dataset.matchGroup;
      loadResults(searchId, 1);
    });
  });
}

const OFFER_KEY_LABEL_SHORT_AR = { cod: 'الدفع عند الاستلام', freeShipping: 'شحن مجاني', bundle: 'باقة', warranty: 'ضمان', limitedQuantity: 'كمية محدودة' };
const ANGLE_LABEL_AR = {
  Security: 'الأمان', Privacy: 'الخصوصية', Convenience: 'السهولة', Portability: 'قابلية الحمل',
  Technology: 'التكنولوجيا', 'Home Use': 'الاستخدام المنزلي', 'Price/Value': 'السعر/القيمة', UNKNOWN: 'غير محدد',
};

/** Step: Part 7 — compact per-card analysis, Meta results only, only when analyzeOneAd() actually ran. Every absent value renders "غير مذكور", never a fabricated 0/EGP. */
function metaAnalysisCompactHtml(r) {
  if (r.platform !== 'META_AD_LIBRARY' || !r.adAnalysis) return '';
  const a = r.adAnalysis;
  const na = 'غير مذكور';
  const priceText = a.price?.hasPrice ? `${a.price.value} ${a.price.currency}` : na;
  const discountText = a.discount?.hasDiscount ? (a.discount.percentage ? `${a.discount.percentage}%` : 'موجود') : na;
  const offerText = Object.entries(OFFER_KEY_LABEL_SHORT_AR).filter(([k]) => a.offers?.[k]).map(([, label]) => label).join('، ') || na;
  const hookTypesText = (a.hook?.types || []).map((t) => HOOK_TYPE_LABEL_AR[t] || t).join('، ') || na;
  const verificationText = r.matchDecision === 'EXACT' ? `مطابق ${r.exactMatchScore}%` : r.matchDecision === 'REVIEW' ? `محتاج مراجعة (${r.exactMatchScore}%)` : 'لم يتم التحقق بصريًا';
  const sourceNote = a.hook?.source === 'RULE_BASED' ? '<span class="icd-faint">(تحليل محلي — بدون AI)</span>' : '';
  return `<div class="icd-ad-analysis">
    <div class="icd-ad-row"><b>الهوك:</b> ${escapeHtml(a.hook?.text || na)} ${sourceNote}</div>
    <div class="icd-ad-row"><b>نوع الهوك:</b> ${escapeHtml(hookTypesText)}</div>
    <div class="icd-ad-row"><b>زاوية البيع:</b> ${escapeHtml(ANGLE_LABEL_AR[a.sellingAngle?.value] || a.sellingAngle?.value || na)}</div>
    <div class="icd-ad-row"><b>السعر:</b> ${escapeHtml(priceText)}</div>
    <div class="icd-ad-row"><b>الخصم:</b> ${escapeHtml(discountText)}</div>
    <div class="icd-ad-row"><b>العرض:</b> ${escapeHtml(offerText)}</div>
    <div class="icd-ad-row"><b>CTA:</b> ${escapeHtml(a.cta?.text || na)}</div>
    <div class="icd-ad-row"><b>نوع الإعلان:</b> ${escapeHtml(a.creativeFormat?.value || na)}</div>
    <div class="icd-ad-row"><b>مدة التشغيل:</b> ${r.adLongevity?.days != null ? r.adLongevity.days + ' يوم' : 'غير متاح'}</div>
    <div class="icd-ad-row"><b>Verification:</b> ${escapeHtml(verificationText)}</div>
    <button class="icd-btn secondary small" data-action="toggle-analysis" data-id="${r.id}">عرض التحليل</button>
    <div class="icd-ad-full" id="icdAdFull${r.id}" style="display:none;"></div>
  </div>`;
}

/** Step: Part 8 — the rest of the analysis, revealed only on demand so cards stay lightweight by default. */
function metaAnalysisFullHtml(a) {
  const na = 'غير مذكور';
  return `
    <div class="icd-ad-row"><b>المشكلة:</b> ${escapeHtml(a.problem?.value || na)}</div>
    <div class="icd-ad-row"><b>الفوائد:</b> ${(a.benefits?.items || []).map(escapeHtml).join('، ') || na}</div>
    <div class="icd-ad-row"><b>الخصائص:</b> ${(a.features?.items || []).map(escapeHtml).join('، ') || na}</div>
    <div class="icd-ad-row"><b>الجمهور المستهدف (استنتاج AI):</b> ${escapeHtml(a.targetAudience?.value || na)}</div>
    <div class="icd-ad-row"><b>أسلوب الإبداع:</b> ${escapeHtml(a.creativeStyle?.value || na)}</div>
    <div class="icd-ad-row"><b>عناصر الثقة:</b> ${(a.trustElements?.elements || []).join('، ') || na}</div>
    <div class="icd-ad-row"><b>إلحاح:</b> ${a.urgency?.present ? escapeHtml((a.urgency.phrases || []).join('، ')) : na}</div>
    <div class="icd-ad-row icd-faint">مصدر التحليل الدلالي: ${a.hook?.source === 'AI_ANALYZED' ? 'ذكاء اصطناعي (AI)' : a.hook?.source === 'RULE_BASED' ? 'قواعد محلية (بدون AI)' : 'غير معروف'}</div>`;
}

function resultCardHtml(r) {
  const classification = r.classification || 'UNCLASSIFIED';
  const m = r.metrics || {};
  return `<div class="icd-result-card">
    ${r.thumbnail ? `<img class="icd-result-thumb" src="${escapeHtml(r.thumbnail)}" loading="lazy" decoding="async" />` : `<div class="icd-result-thumb-placeholder">🖼️</div>`}
    <div class="icd-result-body">
      <div class="icd-result-platform">${PLATFORM_LABEL[r.platform] || r.platform}</div>
      <div class="icd-result-title">${escapeHtml(r.title || r.accountName || 'بدون عنوان')}</div>
      <div class="icd-result-meta">${r.accountName ? `👤 ${escapeHtml(r.accountName)}` : ''}${r.publishedAt ? ` · ${new Date(r.publishedAt).toLocaleDateString('ar-EG')}` : ''}</div>
      <div class="icd-result-badges">
        <span class="icd-mini-badge ${CLASS_COLOR[classification] || ''}">${CLASS_LABEL[classification] || classification}${r.matchScore !== null && r.matchScore !== undefined ? ` ${r.matchScore}%` : ''}</span>
        ${r.exactMatchScore !== null && r.exactMatchScore !== undefined
          ? `<span class="icd-mini-badge ${MATCH_DECISION_COLOR[r.matchDecision] || ''}" title="${escapeHtml((r.matchReasons || []).join(' | '))}">🖼️ ${r.exactMatchScore}% — ${escapeHtml(MATCH_DECISION_LABEL[r.matchDecision] || '')}</span>`
          : (internalCreativeDiscovery.currentSearchVisualMatchingActive ? '<span class="icd-mini-badge">🖼️ لم يتم التحقق بصريًا</span>' : '')}
        ${m.activeStatus === 'ACTIVE' ? '<span class="icd-mini-badge green">🟢 نشط</span>' : ''}
        <span class="icd-mini-badge">${escapeHtml(r.provider || '')}</span>
      </div>
      ${metaAnalysisCompactHtml(r)}
      <div class="icd-result-actions">
        <a class="icd-btn secondary small" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">فتح المصدر</a>
        <button class="icd-btn secondary small" data-action="save" data-id="${r.id}" data-media-type="${m.mediaType ? String(m.mediaType).toLowerCase() : ''}" data-has-multi="${m.hasMultipleMedia ? '1' : '0'}">حفظ</button>
      </div>
    </div>
  </div>`;
}

// --- Real media download ("حفظ") ---
// Previously a complete no-op (data-action="save" rendered with zero
// attached behavior). Real backend proxy/stream endpoint, never a plain
// cross-origin <a href download> (Meta/Instagram/TikTok/YouTube CDNs may
// ignore or block that attribute entirely) — see productResearchExperimental
// .js's new GET /results/:id/download route.
async function downloadResult(resultId, mediaType, btn) {
  const originalLabel = 'حفظ';
  btn.disabled = true;
  btn.textContent = 'جاري التحميل...';
  try {
    const res = await fetch(`${EXP_API}/results/${resultId}/download?type=${encodeURIComponent(mediaType)}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || 'تعذر تحميل الملف');
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `download-${resultId}`;
    // A same-origin blob URL — the browser always honors <a download> on
    // this regardless of what cross-origin restrictions the ORIGINAL media
    // host would have imposed on a direct link to it.
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
    btn.textContent = 'بدأ التحميل';
  } catch (err) {
    btn.textContent = 'تعذر تحميل الملف';
    UI.toast(err.message, 'error');
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = originalLabel; }, 2500);
  }
}

/** Multi-media Meta ad (video + image both present) — a small inline choice instead of guessing which one the user wants. */
function showDownloadChoice(btn, resultId) {
  const row = btn.closest('.icd-result-actions');
  if (!row || row.querySelector('.icd-download-choice')) return;
  const choice = document.createElement('span');
  choice.className = 'icd-download-choice';
  choice.innerHTML = `<button class="icd-btn secondary small" data-dl="video">تحميل الفيديو</button><button class="icd-btn secondary small" data-dl="image">تحميل الصور</button>`;
  row.appendChild(choice);
  choice.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      choice.remove();
      downloadResult(resultId, b.dataset.dl, btn);
    });
  });
}

function wireResultGridDownloads() {
  const grid = document.getElementById('icdResultGrid');
  if (!grid || grid.dataset.downloadsWired) return;
  grid.dataset.downloadsWired = '1';
  grid.addEventListener('click', (e) => {
    const saveBtn = e.target.closest('[data-action="save"]');
    if (saveBtn && !saveBtn.disabled) {
      const resultId = saveBtn.dataset.id;
      const hasMulti = saveBtn.dataset.hasMulti === '1';
      const mediaType = saveBtn.dataset.mediaType.includes('video') ? 'video' : 'image';
      if (hasMulti) { showDownloadChoice(saveBtn, resultId); return; }
      downloadResult(resultId, mediaType, saveBtn);
      return;
    }
    // Step: Part 8 — expandable full analysis, lazily rendered from the
    // already-fetched result object (internalCreativeDiscovery.resultsById)
    // — never a new request, cards stay lightweight until actually opened.
    const toggleBtn = e.target.closest('[data-action="toggle-analysis"]');
    if (toggleBtn) {
      const r = internalCreativeDiscovery.resultsById[toggleBtn.dataset.id];
      const full = document.getElementById(`icdAdFull${toggleBtn.dataset.id}`);
      if (!r || !full) return;
      const isOpen = full.style.display !== 'none';
      if (isOpen) {
        full.style.display = 'none';
        toggleBtn.textContent = 'عرض التحليل';
      } else {
        if (!full.dataset.rendered) { full.innerHTML = metaAnalysisFullHtml(r.adAnalysis || {}); full.dataset.rendered = '1'; }
        full.style.display = 'block';
        toggleBtn.textContent = 'إخفاء التحليل';
      }
    }
  });
}

// --- Query breakdown ("الكلمات اللي جابت نتائج") — Part 4 ---
function wireQueryBreakdownToggle() {
  const toggle = document.getElementById('icdQueryBreakdownToggle');
  if (!toggle || toggle.dataset.wired) return;
  toggle.dataset.wired = '1';
  toggle.addEventListener('click', async () => {
    const body = document.getElementById('icdQueryBreakdownBody');
    const hint = document.getElementById('icdQueryBreakdownToggleHint');
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    if (hint) hint.textContent = isOpen ? 'اضغط للعرض' : 'اضغط للإخفاء';
    if (!isOpen && internalCreativeDiscovery.currentSearchId) await loadQueryBreakdown(internalCreativeDiscovery.currentSearchId);
  });
}

async function loadQueryBreakdown(searchId) {
  const table = document.getElementById('icdQueryBreakdownTable');
  let data;
  try {
    data = await api.get(`${EXP_API}/search/${searchId}/query-breakdown`);
  } catch (err) {
    table.innerHTML = `<tbody><tr><td>${escapeHtml(err.message)}</td></tr></tbody>`;
    return;
  }
  const rows = data.breakdown || [];
  if (rows.length === 0) { table.innerHTML = '<tbody><tr><td class="icd-faint">لا توجد بيانات.</td></tr></tbody>'; return; }
  const headers = ['الكلمة', 'المنصة', 'مرشحين تم إيجادهم', 'مطابقات تامة', 'إعلانات Meta'];
  table.innerHTML = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.query)}</td>
      <td>${escapeHtml(PLATFORM_LABEL[r.platform] || r.platform)}</td>
      <td>${r.candidatesLinked}</td>
      <td>${r.exactMatches}</td>
      <td>${r.platform === 'META_AD_LIBRARY' ? r.metaAdsFound : '—'}</td>
    </tr>`).join('')}</tbody>`;
}

// --- Meta Ads Competitor Intelligence (Part 2) ---
// Fully lazy: nothing here is fetched until the user opens the panel, and
// the slow poll (7s) only ever runs while a real analysis batch is still
// in progress — completely decoupled from the fast 2s progress poll, so
// this can never regress the page-performance work from the previous
// session.
const HOOK_TYPE_LABEL_AR = {
  Question: 'سؤال', Problem: 'مشكلة', Pain: 'ألم/معاناة', Curiosity: 'فضول', Benefit: 'فايدة', Price: 'سعر', Discount: 'خصم',
  Demonstration: 'عرض توضيحي', 'Before/After': 'قبل/بعد', 'Social Proof': 'دليل اجتماعي', Fear: 'خوف',
  Convenience: 'سهولة', Lifestyle: 'أسلوب حياة', Gift: 'هدية', Urgency: 'إلحاح', 'Product Reveal': 'كشف المنتج',
  Educational: 'تعليمي', Story: 'قصة', Other: 'أخرى', UNKNOWN: 'غير محدد',
};
const OFFER_KEY_LABEL_AR = { cod: 'الدفع عند الاستلام', freeShipping: 'شحن مجاني', bundle: 'باقة/عرض', warranty: 'ضمان', limitedQuantity: 'كمية محدودة' };

/** Idempotent — wired once ever, reads currentSearchId at CLICK time (never closes over one search's id) so it keeps working correctly across multiple searches without accumulating duplicate listeners. */
function wireCompetitorToggle() {
  const toggle = document.getElementById('icdCompetitorToggle');
  if (!toggle || toggle.dataset.wired) return;
  toggle.dataset.wired = '1';
  toggle.addEventListener('click', () => {
    const body = document.getElementById('icdCompetitorBody');
    const hint = document.getElementById('icdCompetitorToggleHint');
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    if (hint) hint.textContent = isOpen ? 'اضغط للعرض' : 'اضغط للإخفاء';
    if (!isOpen && internalCreativeDiscovery.currentSearchId) loadCompetitorAnalysis(internalCreativeDiscovery.currentSearchId);
  });
}

/** Called from renderProgress() — purely a visibility decision from already-known data (data.platforms), never an extra fetch. */
function renderCompetitorTabAvailability(data) {
  const panel = document.getElementById('icdCompetitorPanel');
  if (!panel) return;
  const terminal = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(data.status);
  panel.style.display = (terminal && data.platforms.includes('META_AD_LIBRARY')) ? 'block' : 'none';
  const qbPanel = document.getElementById('icdQueryBreakdownPanel');
  if (qbPanel) qbPanel.style.display = (terminal && data.resultCount > 0) ? 'block' : 'none';
}

function barListHtml(items, limit = 8) {
  if (!items || items.length === 0) return `<div class="icd-faint">لا توجد بيانات كافية.</div>`;
  return items.slice(0, limit).map((i) => `
    <div class="icd-bar-row">
      <div class="icd-bar-label" title="${escapeHtml(i.value)}">${escapeHtml(i.value)}</div>
      <div class="icd-bar-track"><div class="icd-bar-fill" style="width:${Math.min(100, i.pct)}%"></div></div>
      <div class="icd-bar-pct">${i.pct}% (${i.count})</div>
    </div>`).join('');
}

/**
 * Step: Part 5/9 — explicit buckets, never a silently-empty panel. Shown
 * plainly regardless of how many landed in each bucket — the whole point
 * is that "0 EXACT" no longer looks like the feature is broken when 70
 * real ads were simply never visually compared.
 */
function renderCompetitorSummary(data) {
  const b = data.buckets || {};
  const tiles = [
    { n: b.metaAdsFound ?? data.adsFound, l: 'إعلانات Meta تم العثور عليها' },
    { n: b.verifiedExact ?? 0, l: 'مطابق للمنتج (verified)' },
    { n: b.possibleReview ?? 0, l: 'محتاج مراجعة' },
    { n: b.unverified ?? 0, l: 'لم يتم التحقق بصريًا' },
    { n: b.rejected ?? 0, l: 'مرفوض (منتج مختلف)' },
    { n: b.analyzed ?? data.adsAnalyzed, l: 'تم تحليلها' },
    { n: `${data.price.visibilityPct}%`, l: 'إظهار السعر' },
    { n: `${data.discountUsageRate}%`, l: 'استخدام الخصم' },
  ];
  document.getElementById('icdCompetitorSummary').innerHTML = tiles.map((t) => `<div class="icd-summary-tile"><div class="n">${t.n}</div><div class="l">${t.l}</div></div>`).join('');

  // Step: Part 11 — AI status transparency, never a blank/mysterious section.
  const aiEl = document.getElementById('icdCompetitorAiStatus');
  if (aiEl && data.aiStatus) {
    const color = data.aiStatus.status === 'AVAILABLE' ? 'green' : data.aiStatus.status === 'NOT_CONFIGURED' ? '' : 'yellow';
    aiEl.innerHTML = `<span class="icd-mini-badge ${color}">${data.aiStatus.status === 'AVAILABLE' ? '✅' : '⚠️'} ${escapeHtml(data.aiStatus.label)}</span>`;
  }
}

function renderCompetitorPrice(price) {
  const el = document.getElementById('icdCompetitorPrice');
  if (price.adsAnalyzed === 0) { el.textContent = 'لا توجد بيانات لسه.'; return; }
  const lines = [`إعلانات تم تحليلها: ${price.adsAnalyzed}`, `إعلانات تظهر السعر صراحة: ${price.adsWithPrice} (${price.visibilityPct}%)`];
  const currencies = Object.keys(price.byCurrency);
  if (currencies.length === 0) lines.push('مفيش سعر ظاهر بوضوح في أي إعلان اتحلل.');
  // Never combined across currencies — each reported separately (Step 21).
  for (const cur of currencies) {
    const s = price.byCurrency[cur];
    lines.push(`${cur}: من ${s.min} لـ ${s.max} — المتوسط ${s.average}, الوسيط ${s.median} (${s.count} إعلان)`);
  }
  el.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
}

function renderCompetitorOffers(data) {
  const items = [
    ...Object.entries(data.offerUsage).map(([k, v]) => ({ value: OFFER_KEY_LABEL_AR[k] || k, count: v.count, pct: v.pct })),
    { value: 'إلحاح (Urgency)', count: Math.round((data.urgencyUsageRate / 100) * (data.adsAnalyzed || data.price.adsAnalyzed || 0)), pct: data.urgencyUsageRate },
  ];
  document.getElementById('icdCompetitorOffers').innerHTML = barListHtml(items, 10);
}

function renderCompetitorCreative(data) {
  const items = [
    ...data.creativeFormats.map((f) => ({ value: `صيغة: ${f.value}`, count: f.count, pct: f.pct })),
    ...data.creativeStyles.map((s) => ({ value: `أسلوب: ${s.value}`, count: s.count, pct: s.pct })),
  ];
  document.getElementById('icdCompetitorCreative').innerHTML = barListHtml(items, 10);
}

function renderDecisionIntelligence(di) {
  const el = document.getElementById('icdCompetitorDecision');
  if (!di) { el.innerHTML = '<div class="icd-faint">لسه مفيش تحليل كافي لإنشاء توصيات.</div>'; return; }
  const fallbackNote = di.source === 'AI_ANALYZED' ? '' : '<div class="icd-faint" style="margin-bottom:8px;">⚠️ تحليل مبني على قواعد ثابتة فقط — خدمة الذكاء الاصطناعي غير متاحة حاليًا.</div>';
  const card = (title, bodyHtml) => `<div class="icd-decision-card"><div class="t">${title}</div>${bodyHtml}</div>`;
  const listCard = (title, items) => (items && items.length ? card(title, `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`) : '');
  const testOpportunities = (di.testOpportunities || []).map((o) => card(
    `🧪 ${escapeHtml(o.angle || '')} — ثقة: ${escapeHtml(o.confidence || '')}`,
    `<div>هوك مقترح: ${escapeHtml(o.suggestedHook || '')}</div><div>ليه تجربها: ${escapeHtml(o.why || '')}</div><div class="icd-faint">الدليل من بيانات المنافسين: ${escapeHtml(o.evidence || '')}</div>`
  )).join('');
  el.innerHTML = fallbackNote
    + listCard('🔥 أكثر الأنماط تكرارًا عند المنافسين', di.topPatterns)
    + listCard('📈 زوايا مشبعة (مستخدمة بكثرة)', di.saturatedAngles)
    + listCard('🌱 زوايا أقل استخدامًا (مش بالضرورة أفضل)', di.underusedAngles)
    + testOpportunities
    + listCard('🎬 توصيات إبداعية للتجربة', di.creativeRecommendations)
    + (di.offerPositioning ? card('💡 تموضع العرض', `<div>${escapeHtml(di.offerPositioning)}</div>`) : '');
}

function renderCompetitorTable(competitors) {
  const el = document.getElementById('icdCompetitorTable');
  if (!competitors || competitors.length === 0) { el.innerHTML = ''; return; }
  const headers = ['المنافس', 'عدد الإعلانات', 'الهوك', 'زاوية البيع', 'السعر', 'الخصم', 'العرض', 'أسلوب الإبداع', 'CTA', 'مدة التشغيل (يوم)', 'مطابقة تامة', ''];
  el.innerHTML = `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${competitors.map((c) => `
    <tr>
      <td>${escapeHtml(c.accountName || '—')}</td>
      <td>${c.adsFound}</td>
      <td>${escapeHtml(HOOK_TYPE_LABEL_AR[c.hook] || c.hook || '—')}</td>
      <td>${escapeHtml(c.sellingAngle || '—')}</td>
      <td>${escapeHtml(c.price || '—')}</td>
      <td>${escapeHtml(c.discount || '—')}</td>
      <td>${escapeHtml(c.offer || '—')}</td>
      <td>${escapeHtml(c.creativeStyle || '—')}</td>
      <td>${escapeHtml(c.cta || '—')}</td>
      <td>${c.adLongevityDays ?? '—'}</td>
      <td>✅</td>
      <td><a class="icd-btn secondary small" href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">عرض</a></td>
    </tr>`).join('')}</tbody>`;
}

async function loadCompetitorAnalysis(searchId, isPoll = false) {
  const empty = document.getElementById('icdCompetitorEmpty');
  const content = document.getElementById('icdCompetitorContent');
  let data;
  try {
    data = await api.get(`${EXP_API}/search/${searchId}/competitor-analysis`);
  } catch (err) {
    if (!isPoll) UI.toast(err.message, 'error');
    return;
  }
  if (data.adsFound === 0) {
    empty.style.display = 'block';
    empty.textContent = 'لم يتم العثور على إعلانات منافسين مطابقة تمامًا للمنتج في Meta Ads Library لهذا البحث.';
    content.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  content.style.display = 'block';
  renderCompetitorSummary(data);
  document.getElementById('icdCompetitorHooks').innerHTML = barListHtml(data.hooks.map((h) => ({ ...h, value: HOOK_TYPE_LABEL_AR[h.value] || h.value })));
  document.getElementById('icdCompetitorAngles').innerHTML = barListHtml(data.sellingAngles);
  renderCompetitorPrice(data.price);
  renderCompetitorOffers(data);
  renderCompetitorCreative(data);
  renderDecisionIntelligence(data.decisionIntelligence);
  renderCompetitorTable(data.competitors);

  // Only ever polls while a real batch is genuinely still running —
  // stops itself the moment it isn't, never a fixed-duration timer.
  if (data.batchStatus === 'IN_PROGRESS') {
    if (!internalCreativeDiscovery.competitorPollTimer) {
      internalCreativeDiscovery.competitorPollTimer = setInterval(() => loadCompetitorAnalysis(searchId, true), 7000);
    }
  } else if (internalCreativeDiscovery.competitorPollTimer) {
    clearInterval(internalCreativeDiscovery.competitorPollTimer);
    internalCreativeDiscovery.competitorPollTimer = null;
  }
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
  wireResultGridDownloads();
  wireQueryBreakdownToggle();

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
