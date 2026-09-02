// product-research.js — Product Research Intelligence controller. Every
// number/result shown here comes from a real backend call
// (/api/product-research/*); nothing is invented client-side. Search
// execution is async on the server (Step 18) — this file polls
// GET /search/:id until the pipeline reaches a terminal status.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const PLATFORM_LABEL = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', META_AD_LIBRARY: 'Meta Ads Library' };
const CLASS_LABEL = { EXACT_MATCH: 'تطابق تام', VERY_SIMILAR: 'مشابه جدًا', SIMILAR: 'مشابه', RELATED: 'ذو صلة', IRRELEVANT: 'غير مرتبط', UNCLASSIFIED: 'غير مصنف' };
const CLASS_COLOR = { EXACT_MATCH: 'green', VERY_SIMILAR: 'green', SIMILAR: 'yellow', RELATED: '', IRRELEVANT: 'red', UNCLASSIFIED: '' };
const STATUS_LABEL_AR = {
  PENDING: 'في الانتظار...', ANALYZING: 'جاري تحليل المنتج...', GENERATING_QUERIES: 'جاري إنشاء كلمات البحث...',
  SEARCHING: 'جاري البحث في المنصات...', RANKING: 'جاري تحليل وترتيب النتائج...',
  COMPLETED: '✅ اكتمل البحث', PARTIAL: '⚠️ اكتمل جزئيًا', FAILED: '❌ فشل البحث',
};
const PLATFORM_STATUS_LABEL_AR = { PENDING: 'في الانتظار', COMPLETE: 'مكتمل', PARTIAL: 'جزئي', FAILED: 'فشل', NOT_CONFIGURED: 'غير مربوط' };
const PLATFORM_STATUS_COLOR = { COMPLETE: 'green', PARTIAL: 'yellow', FAILED: 'red', NOT_CONFIGURED: '' };
// Real diagnostic reason shown next to a FAILED/PARTIAL platform badge —
// found via a real incident where SerpApi + YouTube both genuinely ran out
// of quota at the same time and every affected platform's bare "فشل" badge
// looked identical to a code bug. QUOTA_EXCEEDED is the one that matters
// most here (external, resolves on its own — never a code problem); the
// rest cover the other classifyErrorType() outcomes honestly too.
const PLATFORM_ERROR_LABEL_AR = {
  QUOTA_EXCEEDED: 'انتهت حصة/رصيد المزود (مؤقت — هيرجع لوحده)', RATE_LIMITED: 'تم تجاوز حد الطلبات (مؤقت)',
  INVALID_CREDENTIALS: 'بيانات اعتماد المزود غير صحيحة', INSUFFICIENT_CREDITS: 'الرصيد/الفوترة غير متاح عند المزود',
  TIMEOUT: 'انتهت المهلة أثناء الاتصال بالمزود', NETWORK_ERROR: 'مشكلة اتصال مؤقتة بالمزود', SERVER_ERROR: 'خطأ من طرف المزود',
  VALIDATION_ERROR: 'طلب غير صحيح للمزود', UNKNOWN_ERROR: 'خطأ غير معروف من المزود',
};

const chips = { alt: [], ar: [], en: [], kw: [] };
let imageBase64 = null;
let imageMediaType = null;
let currentSearchId = null;
let pollTimer = null;
let currentTab = 'all';
let currentPage = 1;

// --- Deep Search durability across a browser refresh (Step 11/Test F) ---
// The search itself already runs server-side and is fully re-fetchable by
// id (GET /search/:id) — the only thing a refresh actually loses is the
// in-memory `currentSearchId` JS variable pointing at it. Persisting just
// that id (never any result data itself — always re-fetched fresh from the
// server) means a refresh mid-search auto-resumes polling instead of
// silently going blank until the user remembers to reopen it from History.
const LAST_SEARCH_KEY = 'pr_last_search_id';
function rememberSearchId(id) {
  try { localStorage.setItem(LAST_SEARCH_KEY, String(id)); } catch { /* private-mode/storage-blocked — non-fatal, History still works */ }
}
function forgetSearchId() {
  try { localStorage.removeItem(LAST_SEARCH_KEY); } catch { /* non-fatal */ }
}
function recallSearchId() {
  try { return Number(localStorage.getItem(LAST_SEARCH_KEY)) || null; } catch { return null; }
}

function escapeHtml(s) { return UI.escapeHtml ? UI.escapeHtml(String(s ?? '')) : String(s ?? ''); }

// --- Chips ---
function renderChips(field) {
  const el = document.getElementById('prChips' + field.charAt(0).toUpperCase() + field.slice(1));
  el.innerHTML = chips[field].map((v, i) => `<span class="pr-chip">${escapeHtml(v)}<button data-field="${field}" data-idx="${i}" title="حذف">×</button></span>`).join('');
  el.querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      chips[btn.dataset.field].splice(Number(btn.dataset.idx), 1);
      renderChips(btn.dataset.field);
    };
  });
}
function addChip(field, inputEl) {
  if (!inputEl.value.trim()) return;
  chips[field].push(inputEl.value.trim());
  inputEl.value = '';
  renderChips(field);
}
function wireChipInput(inputId, field) {
  const input = document.getElementById(inputId);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addChip(field, input);
    }
  });
  document.querySelector(`[data-add-chip="${field}"]`)?.addEventListener('click', () => addChip(field, input));
}

// --- Image ---
function wireImageUpload() {
  const input = document.getElementById('prImageInput');
  document.getElementById('prBtnPickImage').onclick = () => input.click();
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      UI.toast('نوع الصورة لازم يكون JPEG أو PNG أو WEBP', 'error');
      input.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      UI.toast('حجم الصورة أكبر من 5 ميجا', 'error');
      input.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      imageBase64 = dataUrl.split(',')[1];
      imageMediaType = file.type;
      document.getElementById('prImageName').textContent = file.name;
      const preview = document.getElementById('prImagePreview');
      preview.src = dataUrl;
      preview.style.display = 'block';
    };
    reader.readAsDataURL(file);
  });
}

// --- Provider status ---
const STATUS_BADGE = { CONNECTED: 'green', DEGRADED: 'yellow', ERROR: 'red', NOT_CONFIGURED: '' };
const STATUS_LABEL = { CONNECTED: '✅ متصل', DEGRADED: '🟡 غير مستقر', ERROR: '⚠️ خطأ', NOT_CONFIGURED: '⚪ غير مربوط' };
const ERROR_TYPE_LABEL_AR = {
  INVALID_CREDENTIALS: 'بيانات اعتماد غير صحيحة', INSUFFICIENT_CREDITS: 'الرصيد/الفوترة غير متاح', RATE_LIMITED: 'تم تجاوز حد الطلبات',
  TIMEOUT: 'انتهت المهلة', NETWORK_ERROR: 'مشكلة اتصال مؤقتة', SERVER_ERROR: 'خطأ من طرف المزود', VALIDATION_ERROR: 'طلب غير صحيح', UNKNOWN_ERROR: 'خطأ غير معروف',
};

async function loadProviderStatus() {
  try {
    const { providers } = await api.get('/api/product-research/provider-status');
    document.getElementById('prProviderStatusList').innerHTML = providers
      .map((p) => {
        if (p.platform === 'META_AD_LIBRARY' && p.primary) {
          // 3-tier priority, shown explicitly rather than collapsed to one badge — Apify (primary), then Meta Graph / SerpApi (fallbacks).
          const primaryBadge = `<span class="badge ${STATUS_BADGE[p.primary.status] || ''}">Meta Ads Library — Apify (أساسي): ${STATUS_LABEL[p.primary.status] || p.primary.status}</span>`;
          const fbBadges = (p.fallbacks || [])
            .map((f) => `<span class="badge ${STATUS_BADGE[f.status] || ''}">احتياطي (${f.provider === 'meta_ad_library_api' ? 'Meta Graph' : 'SerpApi'}): ${STATUS_LABEL[f.status] || f.status}</span>`)
            .join('');
          return primaryBadge + fbBadges;
        }
        if (p.platform === 'anthropic') {
          const reason = p.detail && ERROR_TYPE_LABEL_AR[p.detail] ? ` — السبب: ${ERROR_TYPE_LABEL_AR[p.detail]}` : '';
          return `<span class="badge ${STATUS_BADGE[p.status] || ''}">🤖 Anthropic (التحليل الذكي): ${STATUS_LABEL[p.status] || p.status}${reason}</span>`;
        }
        return `<span class="badge ${STATUS_BADGE[p.status] || ''}">${PLATFORM_LABEL[p.platform]}: ${STATUS_LABEL[p.status] || p.status}</span>`;
      })
      .join('');
  } catch (err) {
    document.getElementById('prProviderStatusList').innerHTML = `<span class="faint">⚠️ ${escapeHtml(err.message)}</span>`;
  }
}

// --- Start search ---
async function startSearch() {
  const productName = document.getElementById('prProductName').value.trim();
  if (!productName) return UI.toast('اكتب اسم المنتج الأول', 'error');

  const platforms = [...document.querySelectorAll('#prPlatformToggles input:checked')].map((i) => i.value);
  if (platforms.length === 0) return UI.toast('اختار منصة واحدة على الأقل', 'error');

  const body = {
    productName,
    possibleNames: chips.alt,
    namesAr: chips.ar,
    namesEn: chips.en,
    keywords: chips.kw,
    description: document.getElementById('prDescription').value.trim(),
    imageBase64: imageBase64 || undefined,
    imageMediaType: imageMediaType || undefined,
    country: document.getElementById('prCountry').value,
    language: document.getElementById('prLanguage').value,
    platforms,
    resultsPerPlatform: Number(document.getElementById('prResultsPerPlatform').value),
    adLibraryMode: document.getElementById('prAdLibraryMode').value,
    adLibraryRawLimit: Number(document.getElementById('prAdLibraryRawLimit').value),
    adLibraryActiveOnly: document.getElementById('prAdLibraryActiveOnly').checked,
  };

  const btn = document.getElementById('prBtnStartSearch');
  btn.disabled = true;
  try {
    const { searchId } = await api.post('/api/product-research/search', body);
    currentSearchId = searchId;
    rememberSearchId(searchId);
    document.getElementById('prProgressCard').style.display = 'block';
    startPolling(searchId);
  } catch (err) {
    UI.toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function startPolling(searchId) {
  if (pollTimer) clearInterval(pollTimer);
  const poll = async () => {
    try {
      const data = await api.get(`/api/product-research/search/${searchId}`);
      renderProgress(data);
      if (['COMPLETED', 'PARTIAL', 'FAILED'].includes(data.status)) {
        clearInterval(pollTimer);
        await loadResultsSection(searchId);
        await loadCompetitors(searchId);
        await loadInsights(searchId);
        await loadHistory();
      }
    } catch (err) {
      clearInterval(pollTimer);
      UI.toast(err.message, 'error');
    }
  };
  poll();
  pollTimer = setInterval(poll, 2000);
}

function renderProgress(data) {
  let progressText = STATUS_LABEL_AR[data.status] || data.status;
  if (data.status === 'SEARCHING' && data.adLibraryStats) {
    const s = data.adLibraryStats;
    progressText += ` — جاري البحث في Meta Ads Library: استعلام ${s.queriesExecuted}، تم جمع ${s.rawAdsCollected} إعلان خام، ${s.uniqueAdsAfterDedup} إعلان فريد`;
  } else if (data.status === 'RANKING' && data.adLibraryStats) {
    // Ranking is in progress — a relevant count isn't real yet at this point, never fake one (Step 12).
    progressText += ` — ${data.adLibraryStats.uniqueAdsAfterDedup} إعلان فريد — النتائج لم يتم تصنيفها بعد`;
  } else if (['COMPLETED', 'PARTIAL'].includes(data.status) && data.adLibraryStats) {
    const s = data.adLibraryStats;
    progressText += s.analysisAvailable
      ? ` — ${s.uniqueAdsAfterDedup} إعلان فريد، ${s.exactMatches + s.verySimilar + s.similar} نتيجة ذات صلة عالية`
      : ` — ${s.uniqueAdsAfterDedup} إعلان فريد — النتائج لم يتم تصنيفها بعد`;
  }
  document.getElementById('prProgressText').textContent = progressText;
  const statusList = document.getElementById('prPlatformStatusList');
  statusList.innerHTML = data.platforms
    .map((p) => {
      const s = data.platformStatus?.[p] || 'PENDING';
      const err = data.platformErrors?.[p];
      // A real, specific reason (e.g. "provider quota exhausted, resolves
      // on its own") instead of a bare "فشل" that reads the same whether
      // the cause is a real code bug or a genuine, temporary external
      // provider limit — this is what actually failed and why, not a
      // guess (Step: UI error accuracy).
      const reason = err ? ` — ${escapeHtml(PLATFORM_ERROR_LABEL_AR[err.errorType] || err.errorType)}` : '';
      return `<span class="badge ${PLATFORM_STATUS_COLOR[s] || ''}" title="${err ? escapeHtml(err.message) : ''}">${PLATFORM_LABEL[p]}: ${PLATFORM_STATUS_LABEL_AR[s] || s}${reason}</span>`;
    })
    .join('');
  const errEl = document.getElementById('prProgressError');
  if (data.error) {
    errEl.textContent = `⚠️ ${data.error}`;
    errEl.style.display = 'block';
  } else {
    errEl.style.display = 'none';
  }

  // Non-blocking warnings (Step 17) — shown alongside real results, never
  // instead of them. "Some sources didn't respond" = at least one platform
  // that was actually selected for this search ended PARTIAL/FAILED, while
  // at least one other real result still exists overall.
  const srcWarnEl = document.getElementById('prWarningSources');
  const someFailedOrPartial = data.platforms.some((p) => ['PARTIAL', 'FAILED'].includes(data.platformStatus?.[p]));
  srcWarnEl.style.display = someFailedOrPartial ? 'block' : 'none';

  const aiWarnEl = document.getElementById('prWarningAI');
  const aiUnavailable = data.aiProfile?._analysisSource === 'fallback' || (data.adLibraryStats && data.adLibraryStats.analysisAvailable === false && data.adLibraryStats.adsFound > 0);
  aiWarnEl.style.display = ['COMPLETED', 'PARTIAL'].includes(data.status) && aiUnavailable ? 'block' : 'none';

  document.getElementById('prSummaryTiles').style.display = ['COMPLETED', 'PARTIAL', 'FAILED'].includes(data.status) ? 'grid' : 'none';
}

// --- Results ---
async function loadResultsSection(searchId, page = 1) {
  currentPage = page;
  const params = { page };
  if (currentTab !== 'all') params.platform = currentTab;
  const classFilter = document.getElementById('prClassificationFilter').value;
  if (classFilter) params.classification = classFilter;
  const activeFilter = document.getElementById('prActiveFilter').value;
  if (activeFilter) params.active = activeFilter;
  const sortBy = document.getElementById('prSortBy').value;
  if (sortBy && sortBy !== 'match') params.sort = sortBy;
  params.pageSize = Number(document.getElementById('prPageSize').value) || 50;

  let data;
  try {
    data = await api.get(`/api/product-research/search/${searchId}/results`, params);
  } catch (err) {
    UI.toast(err.message, 'error');
    return;
  }

  document.getElementById('prResultsCard').style.display = 'block';
  const listEl = document.getElementById('prResultsList');
  const emptyEl = document.getElementById('prResultsEmpty');
  const rangeEl = document.getElementById('prResultsRangeText');
  if (data.results.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    rangeEl.textContent = data.total === 0 ? '' : 'مفيش نتائج تطابق الفلاتر المختارة دلوقتي — جرب توسّع الفلاتر.';
  } else {
    emptyEl.style.display = 'none';
    listEl.innerHTML = data.results.map(resultCardHtml).join('');
    wireResultButtons(listEl, searchId);
    const from = (data.page - 1) * data.pageSize + 1;
    const to = Math.min(data.page * data.pageSize, data.total);
    rangeEl.textContent = `عرض ${from}–${to} من ${data.total} نتيجة`;
  }

  // Large result sets (hundreds/thousands) never render as one long button
  // row — capped to a window around the current page, with jump-to-
  // first/last, so pagination itself never becomes the thing that looks broken.
  const pages = Math.ceil(data.total / data.pageSize);
  const pagEl = document.getElementById('prResultsPagination');
  if (pages > 1) {
    const windowSize = 5;
    let start = Math.max(1, page - Math.floor(windowSize / 2));
    let end = Math.min(pages, start + windowSize - 1);
    start = Math.max(1, end - windowSize + 1);
    const btns = [];
    if (start > 1) btns.push(`<button class="btn secondary small" data-page="1">1</button>${start > 2 ? '<span class="faint">…</span>' : ''}`);
    for (let i = start; i <= end; i++) btns.push(`<button class="btn secondary small${i === page ? ' active' : ''}" data-page="${i}">${i}</button>`);
    if (end < pages) btns.push(`${end < pages - 1 ? '<span class="faint">…</span>' : ''}<button class="btn secondary small" data-page="${pages}">${pages}</button>`);
    pagEl.innerHTML = btns.join('');
  } else {
    pagEl.innerHTML = '';
  }
  pagEl.querySelectorAll('button').forEach((b) => (b.onclick = () => loadResultsSection(searchId, Number(b.dataset.page))));

  await renderSummaryTiles(searchId, data.total);
}

async function renderSummaryTiles(searchId, totalVisible) {
  // Real counts from the DB (per-platform + exact matches), not derived client-side from a partial page.
  try {
    const search = await api.get(`/api/product-research/search/${searchId}`);
    const tiles = [
      { label: 'إجمالي النتائج', value: search.resultCount },
    ];
    for (const p of search.platforms) {
      tiles.push({ label: PLATFORM_LABEL[p], value: '—', platformHint: p });
    }
    document.getElementById('prSummaryTiles').innerHTML = tiles
      .map((t) => `<div class="stat-tile"><div class="label">${escapeHtml(t.label)}</div><div class="value">${t.value}</div></div>`)
      .join('');

    const adTilesEl = document.getElementById('prAdLibraryTiles');
    if (search.adLibraryStats) {
      const s = search.adLibraryStats;
      const adTiles = [
        { label: 'إعلانات جُمعت (خام)', value: s.rawAdsCollected },
        { label: 'إعلانات فريدة', value: s.uniqueAdsAfterDedup },
        { label: 'إعلانات نشطة', value: s.activeAds },
        { label: 'معلنين مختلفين', value: s.advertisersFound },
        { label: 'تطابق تام', value: s.exactMatches },
        { label: 'مشابه جدًا', value: s.verySimilar },
        { label: 'مشابه', value: s.similar },
        { label: 'ذو صلة', value: s.related },
        { label: 'غير مصنف', value: s.unclassified },
        { label: 'كرييتيف موجود', value: s.creativesFound },
        { label: 'استعلامات نُفذت', value: s.queriesExecuted },
      ];
      adTilesEl.innerHTML = adTiles.map((t) => `<div class="stat-tile"><div class="label">${escapeHtml(t.label)}</div><div class="value">${t.value}</div></div>`).join('')
        + (!s.analysisAvailable ? `<div class="faint" style="grid-column:1/-1; font-size:12px; margin-top:4px;">🤖 التحليل الذكي غير متاح حالياً — النتائج الحقيقية ما زالت معروضة، وكلها ظاهرة تحت "غير مصنف".</div>` : '')
        + (s.providerLimitReached ? `<div class="faint" style="grid-column:1/-1; font-size:12px; margin-top:4px;">⚠️ وصلنا للحد الأقصى المطلوب (${s.requestedRawLimit}) — يمكن فيه إعلانات تانية متاحة لو رفعت الحد.</div>` : '');
      adTilesEl.style.display = 'grid';
    } else {
      adTilesEl.style.display = 'none';
    }
  } catch {
    /* summary is a nice-to-have — never block the results view on it */
  }
}

function resultCardHtml(r) {
  // A real result renders regardless of which optional fields are null —
  // classification/match score/AI reason/adText/CTA/creative are all
  // enhancement, never a requirement for the card to exist (Steps 1/3/21).
  const isAd = r.platform === 'META_AD_LIBRARY';
  const classification = r.classification || 'UNCLASSIFIED';
  const cls = `<span class="badge ${CLASS_COLOR[classification] || ''}">${CLASS_LABEL[classification] || classification}${r.matchScore !== null && r.matchScore !== undefined ? ` — ${r.matchScore}%` : ''}</span>`;
  const m = r.metrics || {};
  const daysRunning = isAd && r.publishedAt ? Math.max(0, Math.floor((Date.now() - new Date(r.publishedAt).getTime()) / 86400000)) : null;
  const hasCreative = Boolean(r.thumbnail);
  const adMeta = isAd
    ? [
        m.activeStatus ? `<span class="badge ${m.activeStatus === 'ACTIVE' ? 'green' : ''}">${m.activeStatus === 'ACTIVE' ? '🟢 نشط' : '⚪ متوقف'}</span>` : '<span class="faint">حالة النشاط غير معروفة</span>',
        m.cta ? `<span>CTA: ${escapeHtml(m.cta)}</span>` : '',
        m.ctaDomain ? `<span>🔗 ${escapeHtml(m.ctaDomain)}</span>` : '',
        daysRunning !== null ? `<span>📅 شغال من ${daysRunning} يوم</span>` : '',
        m.endDate ? `<span>انتهى: ${new Date(m.endDate).toLocaleDateString('ar-EG')}</span>` : '',
        m.platformsShownOn?.length ? `<span>عرض على: ${m.platformsShownOn.join('، ')}</span>` : '',
        `<span>${hasCreative ? '🖼️ كرييتيف متاح' : 'مفيش كرييتيف متاح'}</span>`,
      ].filter(Boolean).join('')
    : '';
  const matchedQuery = r.discoveredByQueries?.[0]?.query;
  const showAiUnavailableNote = classification === 'UNCLASSIFIED';
  return `
    <div class="action-card" data-result-id="${r.id}">
      <div class="action-card-title">${r.thumbnail ? `<img src="${escapeHtml(r.thumbnail)}" style="width:32px;height:32px;border-radius:6px;object-fit:cover;vertical-align:middle;margin-left:8px;" />` : ''}${escapeHtml(r.title || r.accountName || 'بدون عنوان')}</div>
      <div class="action-card-metrics">
        <span>${PLATFORM_LABEL[r.platform] || r.platform}</span>
        <span>${escapeHtml(r.contentType)}</span>
        ${r.provider ? `<span class="faint">مصدر: ${escapeHtml(r.provider)}</span>` : ''}
        ${r.accountName ? `<span>👤 ${escapeHtml(r.accountName)}</span>` : ''}
        ${m.views ? `<span>👁️ ${m.views.toLocaleString('ar-EG')}</span>` : ''}
        ${m.likes ? `<span>❤️ ${m.likes.toLocaleString('ar-EG')}</span>` : ''}
        ${adMeta}
        ${cls}
      </div>
      ${isAd ? `<div class="action-card-reasons">${r.snippet ? escapeHtml(r.snippet.slice(0, 160)) : '<span class="faint">نص الإعلان غير متاح من المصدر</span>'}</div>` : (r.snippet ? `<div class="action-card-reasons">${escapeHtml(r.snippet.slice(0, 160))}</div>` : '')}
      ${matchedQuery ? `<div class="faint" style="font-size:11.5px;">🔍 اتلقى بكلمة: ${escapeHtml(matchedQuery)}</div>` : ''}
      ${r.aiReason ? `<div class="action-card-confidence">🤖 ${escapeHtml(r.aiReason)}</div>` : (showAiUnavailableNote ? '<div class="faint" style="font-size:11.5px;">التحليل الذكي غير متاح حالياً</div>' : '')}
      <div class="toolbar" style="margin-top:8px;">
        <a class="btn secondary small" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">${isAd ? 'فتح الإعلان' : 'فتح الرابط'}</a>
        ${isAd ? `<a class="btn secondary small" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">فتح Snapshot</a>` : ''}
        <button class="btn secondary small" data-action="save-competitor" data-id="${r.id}">${r.isSavedCompetitor ? '✅ محفوظ كمنافس' : 'حفظ كمنافس'}</button>
        <button class="btn secondary small" data-action="analyze" data-id="${r.id}">${isAd ? 'تحليل الإعلان' : 'تحليل المحتوى'}</button>
        ${isAd && r.accountUrl ? `<a class="btn secondary small" href="${escapeHtml(r.accountUrl)}" target="_blank" rel="noopener noreferrer">بحث عن المعلن</a>` : ''}
        <button class="btn secondary small" data-action="ignore" data-id="${r.id}">تجاهل</button>
      </div>
    </div>`;
}

function wireResultButtons(container, searchId) {
  container.querySelectorAll('[data-action="save-competitor"]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api.post(`/api/product-research/result/${btn.dataset.id}/save-competitor`, {});
        UI.toast('✅ اتحفظ كمنافس');
        btn.textContent = '✅ محفوظ كمنافس';
        await loadCompetitors(searchId);
      } catch (err) {
        UI.toast(err.message, 'error');
      }
    };
  });
  container.querySelectorAll('[data-action="ignore"]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api.post(`/api/product-research/result/${btn.dataset.id}/ignore`, {});
        btn.closest('.action-card').remove();
      } catch (err) {
        UI.toast(err.message, 'error');
      }
    };
  });
  container.querySelectorAll('[data-action="analyze"]').forEach((btn) => {
    btn.onclick = () => openContentAnalysis(btn.dataset.id);
  });
}

async function openContentAnalysis(resultId) {
  const overlay = document.getElementById('prContentDrawerOverlay');
  const panel = document.getElementById('prContentDrawerPanel');
  panel.innerHTML = '<div class="drawer-header"><h2>تحليل المحتوى</h2></div><div class="faint" style="padding:16px;">جارِ التحليل...</div>';
  overlay.classList.add('open');
  overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove('open'); };

  try {
    const { analysis } = await api.post(`/api/product-research/result/${resultId}/analyze`, {});
    const fields = [
      ['hook', 'Hook'], ['product_angle', 'زاوية البيع'], ['benefit', 'الميزة'], ['problem', 'المشكلة اللي بيحلها'],
      ['audience', 'الجمهور المستهدف'], ['offer', 'العرض'], ['price', 'السعر'], ['cta', 'CTA'],
      ['creative_type', 'نوع الكرييتيف'], ['format', 'الصيغة'], ['content_style', 'أسلوب المحتوى'],
    ];
    panel.innerHTML = `
      <div class="drawer-header"><h2>تحليل المحتوى</h2><button class="drawer-close" id="prCloseDrawer">×</button></div>
      <div style="padding:16px;">
        ${fields.map(([key, label]) => `<div style="margin-bottom:10px;"><b>${label}:</b> ${analysis[key] ? escapeHtml(analysis[key]) : '<span class="faint">غير متاح</span>'}</div>`).join('')}
        ${analysis.source === 'unavailable' ? '<div class="empty-state">التحليل بالـ AI مش متاح دلوقتي.</div>' : ''}
      </div>`;
    document.getElementById('prCloseDrawer').onclick = () => overlay.classList.remove('open');
  } catch (err) {
    panel.innerHTML = `<div class="drawer-header"><h2>تحليل المحتوى</h2></div><div class="empty-state" style="margin:16px;">⚠️ ${escapeHtml(err.message)}</div>`;
  }
}

// --- Competitors ---
async function loadCompetitors(searchId) {
  try {
    const { competitors } = await api.get(`/api/product-research/search/${searchId}/competitors`);
    document.getElementById('prCompetitorsCard').style.display = 'block';
    const listEl = document.getElementById('prCompetitorsList');
    const emptyEl = document.getElementById('prCompetitorsEmpty');
    if (competitors.length === 0) {
      listEl.innerHTML = '';
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';
    listEl.innerHTML = competitors
      .map(
        (c) => `
      <div class="action-card">
        <div class="action-card-title">${escapeHtml(c.account_name || 'بدون اسم')}</div>
        <div class="action-card-metrics">
          <span>${PLATFORM_LABEL[c.platform] || c.platform}</span>
          <span>${c.follower_count !== null ? c.follower_count.toLocaleString('ar-EG') + ' متابع' : 'غير متاح'}</span>
        </div>
        <a class="btn secondary small" href="${escapeHtml(c.account_url)}" target="_blank" rel="noopener noreferrer" style="margin-top:8px;">فتح الرابط</a>
      </div>`
      )
      .join('');
  } catch {
    /* non-critical section */
  }
}

// --- Insights ---
async function loadInsights(searchId) {
  try {
    const data = await api.get(`/api/product-research/search/${searchId}/insights`);
    const card = document.getElementById('prInsightsCard');
    if (!data.hasInsights) {
      card.style.display = 'none';
      return;
    }
    card.style.display = 'block';
    const obs = data.observedData;
    document.getElementById('prInsightsContent').innerHTML = `
      <div style="margin-bottom:10px; font-size:13px; font-weight:700;">📊 بيانات ملاحظة (من النتائج الحقيقية)</div>
      <div class="stat-grid" style="margin-bottom:14px;">
        ${Object.entries(obs.byPlatform || {}).map(([p, n]) => `<div class="stat-tile"><div class="label">${PLATFORM_LABEL[p] || p}</div><div class="value">${n}</div></div>`).join('')}
      </div>
      ${obs.topAccounts?.length ? `<div style="font-size:13px; font-weight:700; margin-bottom:8px;">أكثر الحسابات ظهورًا</div><div class="toolbar">${obs.topAccounts.map((a) => `<span class="badge">${escapeHtml(a.name)} (${a.count})</span>`).join('')}</div>` : ''}
      ${!data.aiInterpretation ? '<div class="faint" style="margin-top:12px; font-size:12px;">تفسير الذكاء الاصطناعي للسوق لسه مش متاح في النسخة دي — البيانات المعروضة فوق حقيقية وملاحظة مباشرة بس.</div>' : ''}
    `;
  } catch {
    /* non-critical section */
  }
}

// --- History ---
async function loadHistory() {
  try {
    const { searches } = await api.get('/api/product-research/history');
    const body = document.getElementById('prHistoryBody');
    const empty = document.getElementById('prHistoryEmpty');
    if (searches.length === 0) {
      body.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    body.innerHTML = searches
      .map(
        (s) => `
      <tr>
        <td>${escapeHtml(s.productName)}</td>
        <td>${STATUS_LABEL_AR[s.status] || s.status}</td>
        <td>${s.platforms.map((p) => PLATFORM_LABEL[p]).join('، ')}</td>
        <td>${s.resultCount}</td>
        <td>${s.competitorCount}</td>
        <td>${new Date(s.createdAt).toLocaleString('ar-EG')}</td>
        <td>
          <button class="btn secondary small" data-open="${s.id}">فتح</button>
          <button class="btn secondary small" data-rerun="${s.id}">بحث مرة أخرى</button>
        </td>
      </tr>`
      )
      .join('');
    body.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => reopenSearch(Number(b.dataset.open))));
    body.querySelectorAll('[data-rerun]').forEach((b) => (b.onclick = () => rerunSearch(Number(b.dataset.rerun))));
  } catch {
    /* non-critical section */
  }
}

async function reopenSearch(searchId) {
  currentSearchId = searchId;
  rememberSearchId(searchId);
  document.getElementById('prProgressCard').style.display = 'block';
  const data = await api.get(`/api/product-research/search/${searchId}`);
  renderProgress(data);
  await loadResultsSection(searchId);
  await loadCompetitors(searchId);
  await loadInsights(searchId);
  window.scrollTo({ top: document.getElementById('prProgressCard').offsetTop - 20, behavior: 'smooth' });
}

async function rerunSearch(searchId) {
  try {
    await api.post(`/api/product-research/search/${searchId}/rerun`, {});
    currentSearchId = searchId;
    rememberSearchId(searchId);
    document.getElementById('prProgressCard').style.display = 'block';
    startPolling(searchId);
    window.scrollTo({ top: document.getElementById('prProgressCard').offsetTop - 20, behavior: 'smooth' });
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

// --- Init ---
async function init() {
  wireChipInput('prInputAlt', 'alt');
  wireChipInput('prInputAr', 'ar');
  wireChipInput('prInputEn', 'en');
  wireChipInput('prInputKw', 'kw');
  wireImageUpload();

  document.querySelectorAll('.pr-tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.pr-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = tab.dataset.tab;
      if (currentSearchId) loadResultsSection(currentSearchId, 1);
    };
  });
  document.getElementById('prClassificationFilter').onchange = () => {
    if (currentSearchId) loadResultsSection(currentSearchId, 1);
  };
  document.getElementById('prActiveFilter').onchange = () => {
    if (currentSearchId) loadResultsSection(currentSearchId, 1);
  };
  document.getElementById('prSortBy').onchange = () => {
    if (currentSearchId) loadResultsSection(currentSearchId, 1);
  };

  document.getElementById('prPageSize').onchange = () => {
    if (currentSearchId) loadResultsSection(currentSearchId, 1);
  };

  document.getElementById('prBtnStartSearch').onclick = startSearch;

  await loadProviderStatus();
  await loadHistory();

  // Deep Search durability (Step 11/Test F) — resume a search that was
  // still running when the page was last open, instead of it silently
  // vanishing on refresh. Only auto-resumes non-terminal searches; a
  // finished one is left for the user to reopen from History deliberately.
  const lastId = recallSearchId();
  if (lastId) {
    try {
      const data = await api.get(`/api/product-research/search/${lastId}`);
      if (['PENDING', 'ANALYZING', 'GENERATING_QUERIES', 'SEARCHING', 'RANKING'].includes(data.status)) {
        currentSearchId = lastId;
        document.getElementById('prProgressCard').style.display = 'block';
        startPolling(lastId);
      }
    } catch { forgetSearchId(); /* the remembered search no longer exists — clear it rather than retrying forever */ }
  }
}

init();
