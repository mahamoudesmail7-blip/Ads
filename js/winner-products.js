// winner-products.js — "🔥 منتجات وينر" (Winner Products Discovery Engine).
// Phase 1. Fully isolated from js/product-research.js and
// js/product-research-experimental.js: own state object, own DOM ids (wp*),
// own backend endpoints (/api/winner-products/*). Does not touch either
// existing controller's variables, and does not modify the existing
// 2-tab wireSectionToggle() logic — this file wires its OWN tab/section
// show-hide on top of it.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const WP_API = '/api/winner-products';

const PLATFORM_LABEL = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', META_AD_LIBRARY: 'Meta Ads Library' };
const MARKET_LABEL = {
  EG: 'مصر', EG_GAP: '🔥 فرصة مصر', GULF: 'الخليج', SA: 'السعودية', AE: 'الإمارات',
  US: 'أمريكا', CA: 'كندا', UK: 'بريطانيا', EU: 'أوروبا', ASIA: 'آسيا', WORLD: 'كل العالم',
};
const PLATFORM_ERROR_LABEL_AR = {
  QUOTA_EXCEEDED: 'انتهت حصة المزود (مؤقت)', RATE_LIMITED: 'تجاوز حد الطلبات', INVALID_CREDENTIALS: 'بيانات اعتماد غير صحيحة',
  INSUFFICIENT_CREDITS: 'الرصيد غير متاح', TIMEOUT: 'انتهت المهلة', NETWORK_ERROR: 'مشكلة اتصال', SERVER_ERROR: 'خطأ من المزود',
  VALIDATION_ERROR: 'طلب غير صحيح', UNKNOWN_ERROR: 'خطأ غير معروف',
};

const wp = {
  categories: [],
  mode: 'quick',
  currentSearchId: null,
  pollTimer: null,
  view: 'search', // 'search' | 'saved'
};

function escapeHtml(s) { return UI.escapeHtml ? UI.escapeHtml(String(s ?? '')) : String(s ?? ''); }

// --- Tab / section toggle (additive — does not touch wireSectionToggle()) ---
function wireWinnerTab() {
  const btnWinner = document.getElementById('prSectionTabWinner');
  const btnCurrent = document.getElementById('prSectionTabCurrent');
  const btnExperimental = document.getElementById('prSectionTabExperimental');
  const secCurrent = document.getElementById('prCurrentSection');
  const secExperimental = document.getElementById('prExperimentalSection');
  const secWinner = document.getElementById('prWinnerSection');
  if (!btnWinner || !secWinner) return;

  btnWinner.onclick = () => {
    btnWinner.classList.add('active');
    btnCurrent?.classList.remove('active');
    btnExperimental?.classList.remove('active');
    if (secCurrent) secCurrent.style.display = 'none';
    if (secExperimental) secExperimental.style.display = 'none';
    secWinner.style.display = 'block';
  };
  // The two EXISTING tab buttons already have their own onclick (set by
  // wireSectionToggle() in product-research-experimental.js) that only
  // knows about the original two sections — adding a capturing listener
  // here (not replacing theirs) is enough to also hide the new section
  // when the user switches away from it.
  [btnCurrent, btnExperimental].forEach((btn) => {
    btn?.addEventListener('click', () => {
      btnWinner.classList.remove('active');
      secWinner.style.display = 'none';
    });
  });
}

// --- Provider status (reuses the SAME /api/winner-products/provider-status shape as product-research's own) ---
async function loadProviderStatus() {
  const el = document.getElementById('wpProviderStatusList');
  if (!el) return;
  try {
    const data = await api.get(`${WP_API}/provider-status`);
    el.innerHTML = (data.providers || []).map((p) => {
      const cls = p.status === 'CONNECTED' ? 'green' : p.status === 'DEGRADED' ? 'yellow' : p.status === 'ERROR' ? 'red' : '';
      const label = p.status === 'CONNECTED' ? '✅ متصل' : p.status === 'DEGRADED' ? '🟡 غير مستقر' : p.status === 'ERROR' ? '⚠️ خطأ' : '⚪ غير مربوط';
      // Real classified reason (from the SAME traffic-driven health tracker
      // the status comes from) — never just "ERROR" with no explanation.
      const reason = p.status === 'ERROR' && p.detail ? ` (${escapeHtml(PLATFORM_ERROR_LABEL_AR[p.detail] || p.detail)})` : '';
      return `<span class="icd-mini-badge ${cls}" title="${p.lastErrorAt ? 'آخر خطأ: ' + new Date(p.lastErrorAt).toLocaleString('ar-EG') : ''}">${escapeHtml(PLATFORM_LABEL[p.platform] || p.platform)}: ${label}${reason}</span>`;
    }).join('');
  } catch (err) {
    el.innerHTML = `<span class="icd-faint">تعذر تحميل حالة المزودين.</span>`;
  }
}

// --- Categories ---
async function loadCategories() {
  const sel = document.getElementById('wpCategory');
  if (!sel) return;
  try {
    const data = await api.get(`${WP_API}/categories`);
    wp.categories = data.categories || [];
    sel.innerHTML = wp.categories.map((c) => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label_ar)}</option>`).join('');
  } catch (err) {
    UI.toast?.(err.message, 'error');
  }
}

// --- Mode toggle (quick/deep) — same visual pattern as icdModeQuick/Deep ---
function wireModeToggle() {
  const qBtn = document.getElementById('wpModeQuick');
  const dBtn = document.getElementById('wpModeDeep');
  if (!qBtn || !dBtn) return;
  qBtn.onclick = () => { wp.mode = 'quick'; qBtn.classList.add('active'); dBtn.classList.remove('active'); };
  dBtn.onclick = () => { wp.mode = 'deep'; dBtn.classList.add('active'); qBtn.classList.remove('active'); };
}

// --- Search lifecycle ---
async function startSearch() {
  const category = document.getElementById('wpCategory')?.value;
  if (!category) return UI.toast?.('اختار قسم المنتج الأول', 'error');
  const market = document.getElementById('wpMarket')?.value || 'EG';
  const timeRange = document.getElementById('wpTimeRange')?.value || '7d';

  wp.view = 'search';
  const btn = document.getElementById('wpBtnStartSearch');
  if (btn) btn.disabled = true;
  document.getElementById('wpResultsEmpty').style.display = 'none';
  document.getElementById('wpResultGrid').innerHTML = '';
  setStatusLine('⏳ جارِ إنشاء البحث...');

  try {
    const { searchId } = await api.post(`${WP_API}/search`, { category, market, timeRange, mode: wp.mode });
    wp.currentSearchId = searchId;
    document.getElementById('wpPlatformPanel').style.display = 'block';
    document.getElementById('wpBtnCancelSearch').style.display = '';
    startPolling(searchId);
  } catch (err) {
    UI.toast?.(err.message, 'error');
    setStatusLine('');
  } finally {
    if (btn) btn.disabled = false;
  }
}

const STATUS_LABEL_AR = {
  QUEUED: 'في الانتظار...', SEARCHING: 'جارِ البحث في المنصات...', NORMALIZING: 'جارِ تجميع المنتجات المتشابهة...',
  SCORING: 'جارِ الحساب...', COMPLETED: '✅ اكتمل الاكتشاف', PARTIAL: '⚠️ اكتمل جزئيًا', FAILED: '❌ فشل الاكتشاف',
};
function setStatusLine(text) {
  const el = document.getElementById('wpStatusLine');
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? 'block' : 'none';
}

function renderPlatformGrid(platformStatus) {
  const grid = document.getElementById('wpPlatformGrid');
  if (!grid) return;
  const entries = Object.entries(platformStatus || {});
  grid.innerHTML = entries.map(([platform, status]) => {
    const cls = status === 'COMPLETE' ? 'green' : status === 'FAILED' ? 'red' : status === 'SEARCHING' ? 'cyan' : '';
    const label = status === 'COMPLETE' ? 'مكتمل' : status === 'FAILED' ? 'فشل' : status === 'SEARCHING' ? 'جارِ البحث...' : 'في الانتظار';
    return `<span class="icd-mini-badge ${cls}">${escapeHtml(PLATFORM_LABEL[platform] || platform)}: ${label}</span>`;
  }).join('');
}

function startPolling(searchId) {
  if (wp.pollTimer) clearInterval(wp.pollTimer);
  wp.pollTimer = setInterval(() => pollOnce(searchId), 2000);
  pollOnce(searchId);
}
function stopPolling() {
  if (wp.pollTimer) clearInterval(wp.pollTimer);
  wp.pollTimer = null;
}

async function pollOnce(searchId) {
  try {
    const data = await api.get(`${WP_API}/search/${searchId}`);
    const { search, products } = data;
    setStatusLine(STATUS_LABEL_AR[search.status] || search.status);
    if (search.platform_status_json) renderPlatformGrid(JSON.parse(search.platform_status_json));
    renderResults(products || []);
    if (['COMPLETED', 'PARTIAL', 'FAILED'].includes(search.status)) {
      stopPolling();
      document.getElementById('wpBtnCancelSearch').style.display = 'none';
      if (search.error) UI.toast?.(search.error, search.status === 'FAILED' ? 'error' : undefined);
    }
  } catch (err) {
    stopPolling();
    setStatusLine('');
    UI.toast?.(err.message, 'error');
  }
}

function trendStageChip(stage) {
  if (!stage) return '';
  const map = { EMERGING: ['🆕 Emerging', ''], RISING: ['🚀 Rising', 'cyan'], WINNER: ['🔥 Winner', 'green'], SATURATED: ['⚠️ Saturated', 'yellow'] };
  const [label, cls] = map[stage] || [stage, ''];
  return `<span class="icd-mini-badge ${cls}">${label}</span>`;
}

function productCardHtml(p, opts = {}) {
  const platforms = p.platforms_json ? JSON.parse(p.platforms_json) : [];
  const scoreText = p.winner_score != null ? `🔥 ${p.winner_score}/100` : 'Winner Score: قريبًا';
  const satText = p.egypt_saturation != null ? `🇪🇬 ${p.egypt_saturation}/100` : 'تشبع مصر: قريبًا';
  return `<div class="icd-result-card" data-product-id="${p.id}">
    ${p.thumbnail ? `<img class="icd-result-thumb" src="${escapeHtml(p.thumbnail)}" loading="lazy" />` : `<div class="icd-result-thumb-placeholder">🔥</div>`}
    <div class="icd-result-body">
      <div class="icd-result-platform">${platforms.map((pl) => escapeHtml(PLATFORM_LABEL[pl] || pl)).join(' · ') || '—'}</div>
      <div class="icd-result-title">${escapeHtml(p.display_name)}</div>
      <div class="icd-result-meta">🎬 ${p.videos_count} فيديو · 📢 ${p.ads_count} إعلان · 🏪 ${p.advertisers_count} معلن</div>
      <div class="icd-result-badges">
        ${trendStageChip(p.trend_stage)}
        <span class="icd-mini-badge">${escapeHtml(scoreText)}</span>
        <span class="icd-mini-badge">${escapeHtml(satText)}</span>
      </div>
      <div class="icd-result-actions">
        ${opts.saved ? `<button class="icd-btn secondary small" data-unsave="${p.id}">🗑️ إلغاء الحفظ</button>`
                     : `<button class="icd-btn secondary small" data-save="${p.id}">💾 حفظ المنتج</button>`}
      </div>
    </div>
  </div>`;
}

function renderResults(products) {
  const grid = document.getElementById('wpResultGrid');
  const empty = document.getElementById('wpResultsEmpty');
  if (!grid || !empty) return;
  if (!products.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = 'مفيش منتجات مكتشفة لسه — البحث لسه شغال أو مفيش نتائج حقيقية اتلاقت.';
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = products.map((p) => productCardHtml(p, { saved: false })).join('');
  wireCardActions(grid);
}

function wireCardActions(container) {
  container.querySelectorAll('[data-save]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api.post(`${WP_API}/saved/${btn.dataset.save}`, {});
        UI.toast?.('✅ اتحفظ المنتج');
      } catch (err) { UI.toast?.(err.message, 'error'); }
    };
  });
  container.querySelectorAll('[data-unsave]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api.delete(`${WP_API}/saved/${btn.dataset.unsave}`);
        UI.toast?.('تم إلغاء الحفظ');
        loadSaved();
      } catch (err) { UI.toast?.(err.message, 'error'); }
    };
  });
}

async function loadSaved() {
  wp.view = 'saved';
  stopPolling();
  document.getElementById('wpPlatformPanel').style.display = 'none';
  document.getElementById('wpBtnCancelSearch').style.display = 'none';
  setStatusLine('');
  const grid = document.getElementById('wpResultGrid');
  const empty = document.getElementById('wpResultsEmpty');
  try {
    const data = await api.get(`${WP_API}/saved`);
    const products = data.products || [];
    if (!products.length) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      empty.textContent = 'مفيش منتجات محفوظة لسه.';
      return;
    }
    empty.style.display = 'none';
    grid.innerHTML = products.map((p) => productCardHtml(p, { saved: true })).join('');
    wireCardActions(grid);
  } catch (err) {
    UI.toast?.(err.message, 'error');
  }
}

function wireCancel() {
  const btn = document.getElementById('wpBtnCancelSearch');
  if (!btn) return;
  btn.onclick = () => {
    stopPolling();
    btn.style.display = 'none';
    setStatusLine('');
  };
}

function init() {
  wireWinnerTab();
  wireModeToggle();
  wireCancel();
  loadCategories();
  loadProviderStatus();
  document.getElementById('wpBtnStartSearch')?.addEventListener('click', startSearch);
  document.getElementById('wpBtnShowSaved')?.addEventListener('click', loadSaved);
}

init();
