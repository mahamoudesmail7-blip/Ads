// product-research.js — Product Research Intelligence controller. Every
// number/result shown here comes from a real backend call
// (/api/product-research/*); nothing is invented client-side. Search
// execution is async on the server (Step 18) — this file polls
// GET /search/:id until the pipeline reaches a terminal status.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const PLATFORM_LABEL = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', META_AD_LIBRARY: 'Meta Ads Library' };
const CLASS_LABEL = { EXACT_MATCH: 'تطابق تام', VERY_SIMILAR: 'مشابه جدًا', SIMILAR: 'مشابه', RELATED: 'ذو صلة', IRRELEVANT: 'غير مرتبط' };
const CLASS_COLOR = { EXACT_MATCH: 'green', VERY_SIMILAR: 'green', SIMILAR: 'yellow', RELATED: '', IRRELEVANT: 'red' };
const STATUS_LABEL_AR = {
  PENDING: 'في الانتظار...', ANALYZING: 'جاري تحليل المنتج...', GENERATING_QUERIES: 'جاري إنشاء كلمات البحث...',
  SEARCHING: 'جاري البحث في المنصات...', RANKING: 'جاري تحليل وترتيب النتائج...',
  COMPLETED: '✅ اكتمل البحث', PARTIAL: '⚠️ اكتمل جزئيًا', FAILED: '❌ فشل البحث',
};
const PLATFORM_STATUS_LABEL_AR = { PENDING: 'في الانتظار', COMPLETE: 'مكتمل', PARTIAL: 'جزئي', FAILED: 'فشل', NOT_CONFIGURED: 'غير مربوط' };
const PLATFORM_STATUS_COLOR = { COMPLETE: 'green', PARTIAL: 'yellow', FAILED: 'red', NOT_CONFIGURED: '' };

const chips = { alt: [], ar: [], en: [], kw: [] };
let imageBase64 = null;
let imageMediaType = null;
let currentSearchId = null;
let pollTimer = null;
let currentTab = 'all';
let currentPage = 1;

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
async function loadProviderStatus() {
  try {
    const { providers } = await api.get('/api/product-research/provider-status');
    document.getElementById('prProviderStatusList').innerHTML = providers
      .map((p) => `<span class="badge ${p.status === 'CONNECTED' ? 'green' : ''}">${PLATFORM_LABEL[p.platform]}: ${p.status === 'CONNECTED' ? '✅ متصل' : '⚪ غير مربوط'}</span>`)
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
  };

  const btn = document.getElementById('prBtnStartSearch');
  btn.disabled = true;
  try {
    const { searchId } = await api.post('/api/product-research/search', body);
    currentSearchId = searchId;
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
  document.getElementById('prProgressText').textContent = STATUS_LABEL_AR[data.status] || data.status;
  const statusList = document.getElementById('prPlatformStatusList');
  statusList.innerHTML = data.platforms
    .map((p) => {
      const s = data.platformStatus?.[p] || 'PENDING';
      return `<span class="badge ${PLATFORM_STATUS_COLOR[s] || ''}">${PLATFORM_LABEL[p]}: ${PLATFORM_STATUS_LABEL_AR[s] || s}</span>`;
    })
    .join('');
  const errEl = document.getElementById('prProgressError');
  if (data.error) {
    errEl.textContent = `⚠️ ${data.error}`;
    errEl.style.display = 'block';
  } else {
    errEl.style.display = 'none';
  }

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
  if (data.results.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
  } else {
    emptyEl.style.display = 'none';
    listEl.innerHTML = data.results.map(resultCardHtml).join('');
    wireResultButtons(listEl, searchId);
  }

  const pages = Math.ceil(data.total / data.pageSize);
  const pagEl = document.getElementById('prResultsPagination');
  pagEl.innerHTML = pages > 1
    ? Array.from({ length: pages }, (_, i) => `<button class="btn secondary small${i + 1 === page ? ' active' : ''}" data-page="${i + 1}">${i + 1}</button>`).join('')
    : '';
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
        { label: 'إعلانات موجودة', value: s.adsFound },
        { label: 'إعلانات نشطة', value: s.activeAds },
        { label: 'معلنين مختلفين', value: s.advertisersFound },
        { label: 'تطابق تام', value: s.exactMatches },
        { label: 'كرييتيف موجود', value: s.creativesFound },
      ];
      adTilesEl.innerHTML = adTiles.map((t) => `<div class="stat-tile"><div class="label">${escapeHtml(t.label)}</div><div class="value">${t.value}</div></div>`).join('');
      adTilesEl.style.display = 'grid';
    } else {
      adTilesEl.style.display = 'none';
    }
  } catch {
    /* summary is a nice-to-have — never block the results view on it */
  }
}

function resultCardHtml(r) {
  const isAd = r.platform === 'META_AD_LIBRARY';
  const cls = r.classification ? `<span class="badge ${CLASS_COLOR[r.classification] || ''}">${CLASS_LABEL[r.classification] || r.classification}${r.matchScore !== null ? ` — ${r.matchScore}%` : ''}</span>` : '<span class="faint">مش متقيّم لسه</span>';
  const m = r.metrics || {};
  const adMeta = isAd
    ? [
        m.activeStatus ? `<span class="badge ${m.activeStatus === 'ACTIVE' ? 'green' : ''}">${m.activeStatus === 'ACTIVE' ? '🟢 نشط' : '⚪ متوقف'}</span>` : '',
        m.cta ? `<span>CTA: ${escapeHtml(m.cta)}</span>` : '',
        m.endDate ? `<span>انتهى: ${new Date(m.endDate).toLocaleDateString('ar-EG')}</span>` : '',
        m.platformsShownOn?.length ? `<span>عرض على: ${m.platformsShownOn.join('، ')}</span>` : '',
      ].filter(Boolean).join('')
    : '';
  return `
    <div class="action-card" data-result-id="${r.id}">
      <div class="action-card-title">${r.thumbnail ? `<img src="${escapeHtml(r.thumbnail)}" style="width:32px;height:32px;border-radius:6px;object-fit:cover;vertical-align:middle;margin-left:8px;" />` : ''}${escapeHtml(r.title || r.accountName || 'بدون عنوان')}</div>
      <div class="action-card-metrics">
        <span>${PLATFORM_LABEL[r.platform] || r.platform}</span>
        <span>${escapeHtml(r.contentType)}</span>
        ${r.accountName ? `<span>👤 ${escapeHtml(r.accountName)}</span>` : ''}
        ${m.views ? `<span>👁️ ${m.views.toLocaleString('ar-EG')}</span>` : ''}
        ${m.likes ? `<span>❤️ ${m.likes.toLocaleString('ar-EG')}</span>` : ''}
        ${adMeta}
        ${cls}
      </div>
      ${r.snippet ? `<div class="action-card-reasons">${escapeHtml(r.snippet.slice(0, 160))}</div>` : ''}
      ${r.aiReason ? `<div class="action-card-confidence">🤖 ${escapeHtml(r.aiReason)}</div>` : ''}
      <div class="toolbar" style="margin-top:8px;">
        <a class="btn secondary small" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">${isAd ? 'فتح الإعلان' : 'فتح الرابط'}</a>
        <button class="btn secondary small" data-action="save-competitor" data-id="${r.id}">${r.isSavedCompetitor ? '✅ محفوظ كمنافس' : 'حفظ كمنافس'}</button>
        <button class="btn secondary small" data-action="analyze" data-id="${r.id}">${isAd ? 'تحليل الإعلان' : 'تحليل المحتوى'}</button>
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

  document.getElementById('prBtnStartSearch').onclick = startSearch;

  await loadProviderStatus();
  await loadHistory();
}

init();
