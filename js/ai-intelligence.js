// ai-intelligence.js — page controller for ai-intelligence.html (AI Business
// Intelligence). Upload -> column mapping -> real Campaign Performance
// Analysis Engine (Executive Summary, Performance Overview, Problem
// Detection, AI Decision Center, Campaign Ranking + Detail) -> Data Quality
// Center (Ads Data Quality vs optional Business Mapping) -> optional True
// Business Performance (product-linked profitability layer).
//
// Every number rendered here comes from backend/src/routes/adsIntelligence.js
// and backend/src/services/campaignAnalysis.js, which read only real
// uploaded AdsDailyMetric rows (and, for the optional True Performance
// layer, real EasyOrdersOrder/DailyOrder/Product data) — nothing invented.
// Campaign Performance Analysis never depends on Product Mapping; Product
// Mapping is a separate, optional layer added only for profitability.
import * as UI from './ui-common.js';
import { api } from './api-client.js';
import { Products } from './db.js';

const FIELD_LABELS_AR = {
  date: 'التاريخ',
  campaign_name: 'اسم الحملة',
  campaign_id: 'كود الحملة',
  campaign_delivery: 'حالة الحملة',
  adset_name: 'اسم المجموعة الإعلانية',
  adset_id: 'كود المجموعة الإعلانية',
  ad_name: 'اسم الإعلان',
  ad_id: 'كود الإعلان',
  creative_name: 'اسم الكرييتف',
  creative_id: 'كود الكرييتف',
  spend: 'الصرف',
  impressions: 'مرات الظهور',
  reach: 'الوصول',
  frequency: 'التكرار',
  clicks: 'النقرات',
  ctr: 'CTR',
  cpc: 'CPC',
  cpm: 'CPM',
  landing_page_views: 'مشاهدات صفحة الهبوط',
  leads: 'الليدز',
  add_to_cart: 'إضافة للسلة',
  initiate_checkout: 'بدء الدفع',
  meta_purchases: 'مشتريات (Meta)',
  meta_revenue: 'إيراد (Meta)',
  meta_roas: 'ROAS (Meta)',
  results: 'النتائج (Results)',
  cost_per_result: 'التكلفة لكل نتيجة',
  result_indicator: 'مؤشر النتيجة',
};

const SOURCE_LABELS_AR = { easyorders: 'EasyOrders', daily_orders: 'إدخال يدوي', none: 'مفيش بيانات حقيقية' };

const PROBLEM_TYPE_ICON = {
  HIGH_SPEND_ZERO_RESULTS: '🚨',
  HIGH_SPEND_LOW_RESULTS: '📉',
  CPA_SPIKE: '⚠️',
  CTR_DROP: '👀',
};

const DECISION_BUCKETS = [
  { key: 'stop', title: '🔴 STOP / قلل الصرف', cardClass: 'EXIT' },
  { key: 'fix', title: '🔧 يحتاج مراجعة وإصلاح', cardClass: 'FIX' },
  { key: 'test', title: '🧪 اجمع بيانات أكتر / اختبر', cardClass: 'INSUFFICIENT_DATA' },
  { key: 'scale', title: '🚀 قابل للتوسع', cardClass: 'SCALE' },
  { key: 'opportunities', title: '💎 فرص مخفية', cardClass: 'RESTOCK' },
];

let currentUpload = null; // {uploadId, headers, guessedMapping}
let currentDateFrom = null;
let currentDateTo = null;
let lastAnalysis = null; // last /analysis response, kept so the campaign-detail drawer can reuse its problems
let productsCache = null;
let linkTargetCampaign = null;

async function init() {
  UI.renderSidebar('aiintel');
  document.getElementById('btnPickFile').onclick = () => document.getElementById('aiFileInput').click();
  document.getElementById('aiFileInput').onchange = handleFileSelected;
  document.getElementById('btnCancelMapping').onclick = cancelMapping;
  document.getElementById('btnConfirmProcess').onclick = confirmAndProcess;

  document.getElementById('btnApplyDateRange').onclick = () => {
    currentDateFrom = document.getElementById('aiDateFrom').value || null;
    currentDateTo = document.getElementById('aiDateTo').value || null;
    loadAnalysis();
  };
  document.getElementById('btnClearDateRange').onclick = () => {
    currentDateFrom = null;
    currentDateTo = null;
    document.getElementById('aiDateFrom').value = '';
    document.getElementById('aiDateTo').value = '';
    loadAnalysis();
  };

  document.getElementById('aiCampaignDrawerOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'aiCampaignDrawerOverlay') closeCampaignDrawer();
  });
  document.getElementById('btnCancelLink').onclick = closeLinkModal;
  document.getElementById('btnConfirmLink').onclick = confirmLinkProduct;
  document.getElementById('aiLinkProductOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'aiLinkProductOverlay') closeLinkModal();
  });

  await Promise.all([loadAnalysis(), loadUploads(), loadDataQuality(), loadTruePerformance()]);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]); // strip the "data:...;base64," prefix
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('aiSelectedFileName').textContent = file.name;

  const ext = file.name.split('.').pop().toLowerCase();
  const fileType = ext === 'xlsx' ? 'xlsx' : 'csv';
  const statusEl = document.getElementById('aiUploadStatus');
  statusEl.style.display = 'block';
  statusEl.textContent = 'بيقرأ الملف...';

  try {
    const contentBase64 = await fileToBase64(file);
    statusEl.textContent = 'بيرفع ويحلل الملف...';
    const result = await api.post('/api/ai-intelligence/uploads', { filename: file.name, fileType, contentBase64 });
    statusEl.textContent = `✅ ${result.rowCount} صف — راجع ربط الأعمدة تحت.`;
    currentUpload = result;
    renderMappingStep(result);
  } catch (err) {
    statusEl.textContent = `⚠️ ${err.message}`;
  } finally {
    e.target.value = '';
  }
}

function renderMappingStep(result) {
  const body = document.getElementById('aiMappingBody');
  body.innerHTML = result.canonicalFields
    .map((field) => {
      const guessed = result.guessedMapping[field];
      const options = ['<option value="">— بدون —</option>']
        .concat(result.headers.map((h) => `<option value="${UI.escapeHtml(h)}" ${h === guessed ? 'selected' : ''}>${UI.escapeHtml(h)}</option>`))
        .join('');
      return `
        <tr>
          <td>${FIELD_LABELS_AR[field] || field}${field === 'date' || field === 'campaign_name' ? ' <span class="badge red">مطلوب</span>' : ''}</td>
          <td><select data-field="${field}">${options}</select></td>
        </tr>
      `;
    })
    .join('');

  renderWarnings(result.sampleWarnings, result.invalidCount, result.rowCount);
  document.getElementById('aiMappingCard').style.display = 'block';
}

function renderWarnings(warnings, invalidCount, totalRows) {
  const el = document.getElementById('aiValidationWarnings');
  if (!warnings || warnings.length === 0) {
    el.innerHTML = `<div class="faint" style="font-size:12.5px;">مفيش تحذيرات — كل الصفوف سليمة.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="faint" style="font-size:12.5px; margin-bottom:6px;">⚠️ ${invalidCount} صف من أصل ${totalRows} فيه مشكلة (مش هيتحذف الملف كله، بس الصفوف دي مش هتتحسب):</div>
    <div style="max-height:150px; overflow-y:auto; font-size:12px;">
      ${warnings.map((w) => `<div>صف ${w.row}: ${w.issues.join('، ')}</div>`).join('')}
    </div>
  `;
}

function cancelMapping() {
  currentUpload = null;
  document.getElementById('aiMappingCard').style.display = 'none';
  document.getElementById('aiUploadStatus').style.display = 'none';
  document.getElementById('aiSelectedFileName').textContent = '';
}

async function confirmAndProcess() {
  if (!currentUpload) return;
  const mapping = {};
  document.querySelectorAll('#aiMappingBody select[data-field]').forEach((sel) => {
    mapping[sel.dataset.field] = sel.value || null;
  });
  if (!mapping.date || !mapping.campaign_name) {
    UI.toast('لازم تحدد عمود التاريخ واسم الحملة على الأقل', 'error');
    return;
  }

  const statusEl = document.getElementById('aiUploadStatus');
  statusEl.style.display = 'block';
  statusEl.textContent = 'بيتأكد من الربط...';
  try {
    const mappingResult = await api.patch(`/api/ai-intelligence/uploads/${currentUpload.uploadId}/mapping`, { mapping });
    renderWarnings(mappingResult.sampleWarnings, mappingResult.invalidCount, mappingResult.totalRows);

    statusEl.textContent = 'بيعالج ويربط بالمنتجات...';
    const processResult = await api.post(`/api/ai-intelligence/uploads/${currentUpload.uploadId}/process`, {});
    statusEl.textContent = `✅ اتعالج ${processResult.metricsCreated} صف${processResult.unmatchedCampaigns.length ? ` — ${processResult.unmatchedCampaigns.length} حملة مش مربوطة بمنتج (تحليل الأداء شغال برضه)` : ''}.`;
    UI.toast('✅ تم رفع ومعالجة البيانات');

    document.getElementById('aiMappingCard').style.display = 'none';
    currentUpload = null;
    await Promise.all([loadAnalysis(), loadUploads(), loadDataQuality(), loadTruePerformance()]);
  } catch (err) {
    statusEl.textContent = `⚠️ ${err.message}`;
  }
}

async function loadUploads() {
  const uploads = await api.get('/api/ai-intelligence/uploads');
  const body = document.getElementById('aiUploadsBody');
  const empty = document.getElementById('aiUploadsEmpty');
  if (uploads.length === 0) {
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  const STATUS_BADGE = { UPLOADED: 'yellow', MAPPED: 'yellow', PROCESSED: 'green', FAILED: 'red' };
  const STATUS_LABEL = { UPLOADED: 'مرفوع', MAPPED: 'اتربط', PROCESSED: 'اتعالج', FAILED: 'فشل' };
  body.innerHTML = uploads
    .map(
      (u) => `
      <tr>
        <td>${UI.escapeHtml(u.filename)}</td>
        <td><span class="badge ${STATUS_BADGE[u.status] || 'gray'}">${STATUS_LABEL[u.status] || u.status}</span></td>
        <td class="mono">${u.rowCount ?? '—'}</td>
        <td>${UI.escapeHtml(u.uploadedBy || '—')}</td>
        <td class="mono" style="font-size:12px;">${new Date(u.uploadedAt).toLocaleString('ar-EG')}</td>
      </tr>
    `
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Data Quality Center — restructured: Ads Data Quality (import-time row
// warnings) vs Business Mapping (optional campaign->product linking). The
// second never implies the first is broken or that analysis is blocked.
// ---------------------------------------------------------------------------

async function loadDataQuality() {
  const dq = await api.get('/api/ai-intelligence/data-quality');
  const el = document.getElementById('aiDataQuality');
  const parts = [`<div style="font-size:13.5px; margin-bottom:14px;">📊 إجمالي صفوف الإعلانات المعالجة: <b>${dq.totalMetricRows}</b></div>`];

  parts.push('<div class="section-title" style="font-size:13.5px; margin-top:0;">🩺 جودة بيانات الإعلانات (Ads Data Quality)</div>');
  if (dq.adsDataQuality.importIssues.length === 0) {
    parts.push('<div class="faint" style="font-size:12.5px; margin-bottom:16px;">✅ مفيش تحذيرات عند رفع أي ملف.</div>');
  } else {
    parts.push(
      `<div style="margin-bottom:16px;">${dq.adsDataQuality.importIssues
        .map((i) => `<div style="font-size:12.5px;">📥 ${UI.escapeHtml(i.filename)} — ${i.warningCount} تحذير عند الرفع</div>`)
        .join('')}</div>`
    );
  }

  parts.push('<div class="section-title" style="font-size:13.5px;">🔗 ربط البيزنس (Business Data Mapping) — اختياري</div>');
  parts.push(`<div class="faint" style="font-size:12.5px; margin-bottom:10px;">${UI.escapeHtml(dq.businessMapping.note)}</div>`);

  if (dq.businessMapping.unmatchedCampaignCount === 0) {
    parts.push('<div class="faint" style="font-size:12.5px;">✅ كل الحملات مربوطة بمنتجات.</div>');
  } else {
    parts.push(
      `<div class="table-wrap"><table class="data"><thead><tr><th>اسم الحملة</th><th>عدد الصفوف</th><th>إجمالي الصرف</th><th></th></tr></thead><tbody>${dq.businessMapping.unmatchedCampaigns
        .map(
          (c) => `<tr>
            <td>${UI.escapeHtml(c.campaignName || '—')}</td>
            <td class="mono">${c.rowCount}</td>
            <td class="mono">${c.totalSpend.toFixed(2)}</td>
            <td><button class="btn secondary small" data-link="${UI.escapeHtml(c.campaignName || '')}">ربط بمنتج</button></td>
          </tr>`
        )
        .join('')}</tbody></table></div>`
    );
  }

  el.innerHTML = parts.join('');
  el.querySelectorAll('[data-link]').forEach((btn) => (btn.onclick = () => openLinkModal(btn.dataset.link)));
}

async function loadProductsForLink() {
  if (productsCache) return productsCache;
  productsCache = await Products.all();
  return productsCache;
}

async function openLinkModal(campaignName) {
  linkTargetCampaign = campaignName;
  document.getElementById('linkCampaignName').textContent = campaignName;
  const select = document.getElementById('linkProductSelect');
  select.innerHTML = '<option value="">— جارِ التحميل —</option>';
  document.getElementById('aiLinkProductOverlay').style.display = 'flex';

  const products = await loadProductsForLink();
  select.innerHTML = products.map((p) => `<option value="${p.id}">${UI.escapeHtml(p.product_name)}</option>`).join('');
}

function closeLinkModal() {
  document.getElementById('aiLinkProductOverlay').style.display = 'none';
  linkTargetCampaign = null;
}

async function confirmLinkProduct() {
  const productId = document.getElementById('linkProductSelect').value;
  if (!linkTargetCampaign || !productId) {
    UI.toast('اختار منتج الأول', 'error');
    return;
  }
  try {
    const result = await api.post('/api/ai-intelligence/campaigns/link-product', { campaignName: linkTargetCampaign, productId });
    UI.toast(`✅ اتربط ${result.updatedRows} صف بمنتج "${result.productName}"`);
    closeLinkModal();
    await Promise.all([loadDataQuality(), loadTruePerformance(), loadAnalysis()]);
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

async function loadTruePerformance() {
  const data = await api.get('/api/ai-intelligence/true-performance');
  const body = document.getElementById('aiPerformanceBody');
  const empty = document.getElementById('aiPerformanceEmpty');
  if (data.products.length === 0) {
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  const fmt = (n, d = 2) => (n === null || n === undefined ? '—' : Number(n).toFixed(d));
  body.innerHTML = data.products
    .map(
      (p) => `
      <tr>
        <td>${UI.escapeHtml(p.productName)}</td>
        <td class="mono">${fmt(p.meta.spend)}</td>
        <td class="mono">${p.meta.purchases}</td>
        <td class="mono">${fmt(p.meta.roas)}</td>
        <td class="mono">${p.real.actualOrders}</td>
        <td class="mono">${p.real.deliveredOrders}</td>
        <td class="mono">${fmt(p.real.actualRevenue)}</td>
        <td class="mono ${p.real.netProfit !== null && p.real.netProfit < 0 ? 'eo-text-red' : ''}">${fmt(p.real.netProfit)}</td>
        <td class="mono">${fmt(p.real.trueCPA)}</td>
        <td class="mono">${fmt(p.real.trueRoas)}</td>
        <td><span class="badge gray">${SOURCE_LABELS_AR[p.real.source]}</span></td>
      </tr>
    `
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Campaign Performance Analysis Engine — the real analysis, independent from
// Product Mapping. Reads only /api/ai-intelligence/analysis.
// ---------------------------------------------------------------------------

async function loadAnalysis() {
  const params = {};
  if (currentDateFrom) params.dateFrom = currentDateFrom;
  if (currentDateTo) params.dateTo = currentDateTo;
  const data = await api.get('/api/ai-intelligence/analysis', params);
  lastAnalysis = data.hasData ? data : null;

  document.getElementById('aiNoDataState').style.display = data.hasData ? 'none' : 'block';
  document.getElementById('aiAnalysisWrap').style.display = data.hasData ? 'block' : 'none';
  if (!data.hasData) return;

  renderExecSummary(data);
  renderOverviewTiles(data);
  renderDecisionCenter(data.decisions);
  renderProblems(data.problems);
  renderCampaignsTable(data);
}

function moneyOrDash(n, decimals = 0) {
  return n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: decimals });
}

function renderExecSummary(data) {
  const { summary } = data;
  const el = document.getElementById('aiExecSummary');
  const problemHtml = summary.biggestProblem
    ? `<b>${UI.escapeHtml(summary.biggestProblem.campaignName)}</b> — ${UI.escapeHtml(summary.biggestProblem.message)}`
    : '✅ مفيش مشاكل حرجة ظاهرة دلوقتي.';
  const opportunityHtml = summary.biggestOpportunity
    ? `<b>${UI.escapeHtml(summary.biggestOpportunity.campaignName)}</b> — ${UI.escapeHtml(summary.biggestOpportunity.reason)}`
    : 'مفيش فرصة واضحة لسه — محتاج بيانات أكتر أو فترة أطول.';

  el.innerHTML = `
    <div class="section-title" style="margin-top:0;">🤖 ملخص الذكاء الاصطناعي</div>
    <div style="font-size:13.5px; margin-bottom:12px;">${UI.escapeHtml(summary.summary)}</div>
    <div style="font-size:13px; margin-bottom:8px;"><b>🔴 أكبر مشكلة:</b> ${problemHtml}</div>
    <div style="font-size:13px;"><b>💎 أكبر فرصة:</b> ${opportunityHtml}</div>
    ${!data.hasDateVariety ? '<div class="faint" style="font-size:12px; margin-top:10px;">ملاحظة: البيانات الحالية ليوم واحد بس — مفيش اتجاه (Trend) ممكن يتحلل لحد ما تترفع بيانات لفترة أطول.</div>' : ''}
  `;
}

function renderOverviewTiles(data) {
  const { overview: o, previousOverview: p, hasHistory } = data;
  const el = document.getElementById('aiOverviewTiles');

  const changeSub = (curr, prev, invert = false) => {
    if (!hasHistory || curr === null || prev === null || !prev) return '';
    const pct = ((curr - prev) / prev) * 100;
    const good = invert ? pct <= 0 : pct >= 0;
    return `<div class="sub">${good ? '🟢' : '🔴'} ${UI.fmtPct(pct)} مقارنة بالفترة السابقة</div>`;
  };

  const tiles = [
    { label: '💰 إجمالي الصرف', value: moneyOrDash(o.spend) + ' جنيه', sub: changeSub(o.spend, p?.spend, true) },
    { label: `🎯 إجمالي النتائج${o.resultsSource === 'meta_purchases' ? ' (مشتريات)' : ''}`, value: o.results !== null ? moneyOrDash(o.results) : '—', sub: changeSub(o.results, p?.results, false) },
    { label: '📌 متوسط CPA', value: o.cpa !== null ? moneyOrDash(o.cpa, 2) + ' جنيه' : '—', sub: changeSub(o.cpa, p?.cpa, true) },
    { label: '👁️ مرات الظهور', value: o.impressions !== null ? moneyOrDash(o.impressions) : '—', sub: changeSub(o.impressions, p?.impressions, false) },
    { label: '🖱️ النقرات', value: o.clicks !== null ? moneyOrDash(o.clicks) : '—', sub: changeSub(o.clicks, p?.clicks, false) },
    { label: '📈 CTR', value: o.ctr !== null ? o.ctr.toFixed(2) + '%' : '—', sub: changeSub(o.ctr, p?.ctr, false) },
    { label: '💵 CPC', value: o.cpc !== null ? moneyOrDash(o.cpc, 2) + ' جنيه' : '—', sub: changeSub(o.cpc, p?.cpc, true) },
    { label: '📺 CPM', value: o.cpm !== null ? moneyOrDash(o.cpm, 2) + ' جنيه' : '—', sub: changeSub(o.cpm, p?.cpm, true) },
    { label: `🔁 ROAS${o.revenueEstimated ? ' (تقديري)' : ''}`, value: o.roas !== null ? o.roas.toFixed(2) + 'x' : 'مفيش بيانات إيراد كفاية', sub: changeSub(o.roas, p?.roas, false) },
  ];

  el.innerHTML = tiles
    .map(
      (t) => `<div class="stat-tile">
        <div class="label">${t.label}</div>
        <div class="value" style="font-size:20px;">${t.value}</div>
        ${t.sub || ''}
      </div>`
    )
    .join('');
}

function decisionCardHtml(bucketKey, item) {
  const m = item.metrics;
  return `
    <div class="action-card ${DECISION_BUCKETS.find((b) => b.key === bucketKey).cardClass}" data-open="${UI.escapeHtml(item.campaignName)}" style="cursor:pointer;">
      <div class="action-card-title">${UI.escapeHtml(item.campaignName)}</div>
      <div class="action-card-metrics">
        <span class="mono">صرف: ${moneyOrDash(m.spend)} جنيه</span>
        <span class="mono">نتائج: ${m.results ?? '—'}</span>
        <span class="mono">CPA: ${m.cpa !== null ? m.cpa.toFixed(1) : '—'}</span>
      </div>
      <div class="action-card-reasons">${UI.escapeHtml(item.reason)}</div>
      <div class="action-card-confidence">الثقة: ${item.confidence === 'HIGH' ? 'عالية' : item.confidence === 'MEDIUM' ? 'متوسطة' : 'منخفضة'}</div>
    </div>`;
}

function renderDecisionCenter(decisions) {
  const el = document.getElementById('aiDecisionCenter');
  const groups = DECISION_BUCKETS.map((b) => {
    const items = decisions[b.key] || [];
    if (items.length === 0) return '';
    return `
      <div class="action-group">
        <div class="action-group-title">${b.title} <span class="faint" style="font-weight:400; font-size:12px;">(${items.length})</span></div>
        ${items.map((it) => decisionCardHtml(b.key, it)).join('')}
      </div>`;
  }).join('');

  el.innerHTML = groups || '<div class="empty-state">مفيش قرارات كافية النهاردة — محتاج بيانات أكتر.</div>';
  el.querySelectorAll('[data-open]').forEach((card) => (card.onclick = () => openCampaignDrawer(card.dataset.open)));
}

function problemDetailLine(p) {
  const d = p.detail || {};
  if (p.type === 'HIGH_SPEND_ZERO_RESULTS') return `<span>الصرف: ${moneyOrDash(d.spend)} جنيه</span>`;
  if (p.type === 'HIGH_SPEND_LOW_RESULTS') return `<span>نتائج فعلية: ${d.actualResults} من متوقع ${d.expectedResults}</span><span>CPA: ${d.actualCPA.toFixed(1)} مقابل متوسط ${d.accountAvgCPA.toFixed(1)}</span>`;
  if (p.type === 'CPA_SPIKE') return `<span>CPA: ${d.previousCPA.toFixed(1)} ← ${d.currentCPA.toFixed(1)} (${UI.fmtPct(d.changePct)})</span>`;
  if (p.type === 'CTR_DROP') return `<span>CTR: ${d.previousCTR.toFixed(2)}% ← ${d.currentCTR.toFixed(2)}% (${UI.fmtPct(d.changePct)})</span>`;
  return '';
}

function renderProblems(problems) {
  const el = document.getElementById('aiProblems');
  if (!problems || problems.length === 0) {
    el.innerHTML = '<div class="empty-state">✅ مفيش مشاكل مكتشفة في الفترة دي.</div>';
    return;
  }
  const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  const sorted = [...problems].sort((a, b) => rank[a.severity] - rank[b.severity] || (b.detail?.spend || 0) - (a.detail?.spend || 0));
  const cls = { CRITICAL: 'negative', WARNING: 'warning', INFO: '' };

  el.innerHTML = sorted
    .map(
      (p) => `
    <div class="alert-card ${cls[p.severity]}" data-open="${UI.escapeHtml(p.campaignName)}" style="cursor:pointer;">
      <div class="alert-title">${PROBLEM_TYPE_ICON[p.type] || '⚠️'} ${UI.escapeHtml(p.campaignName)}</div>
      <div class="alert-meta">${problemDetailLine(p)}</div>
      <div class="alert-rec">${UI.escapeHtml(p.message)} — ${UI.escapeHtml(p.recommendedAction)}</div>
    </div>`
    )
    .join('');
  el.querySelectorAll('[data-open]').forEach((card) => (card.onclick = () => openCampaignDrawer(card.dataset.open)));
}

function renderCampaignsTable(data) {
  const { campaigns, minSpendForVerdict } = data;
  const body = document.getElementById('aiCampaignsBody');
  if (campaigns.length === 0) {
    body.innerHTML = `<tr><td colspan="7" class="empty-state">مفيش حملات في الفترة دي.</td></tr>`;
    return;
  }
  body.innerHTML = campaigns
    .map((c) => {
      let statusBadge;
      if (c.spend < minSpendForVerdict) statusBadge = '<span class="badge gray">بيانات غير كافية</span>';
      else if ((c.results || 0) === 0) statusBadge = '<span class="badge red">صفر نتائج</span>';
      else statusBadge = '<span class="badge green">سليمة</span>';

      return `
      <tr data-open="${UI.escapeHtml(c.campaignName)}" style="cursor:pointer;">
        <td>${UI.escapeHtml(c.campaignName)}</td>
        <td>${statusBadge}</td>
        <td class="mono">${moneyOrDash(c.spend)}</td>
        <td class="mono">${c.results ?? '—'}</td>
        <td class="mono">${c.cpa !== null ? c.cpa.toFixed(1) : '—'}</td>
        <td class="mono">${c.ctr !== null ? c.ctr.toFixed(2) + '%' : '—'}</td>
        <td class="mono">${c.roas !== null ? c.roas.toFixed(2) + 'x' : '—'}</td>
      </tr>`;
    })
    .join('');
  body.querySelectorAll('[data-open]').forEach((row) => (row.onclick = () => openCampaignDrawer(row.dataset.open)));
}

// ---------------------------------------------------------------------------
// Campaign Detail drawer
// ---------------------------------------------------------------------------

function sparklineSvg(series, field, color) {
  const values = series.map((d) => d[field]).filter((v) => v !== null && v !== undefined);
  if (values.length < 2) return '';
  const w = 560, h = 90, pad = 6;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const step = (w - pad * 2) / (series.length - 1);
  const points = series
    .map((d, i) => {
      const v = d[field];
      const x = pad + i * step;
      const y = v === null || v === undefined ? null : h - pad - ((v - min) / range) * (h - pad * 2);
      return y === null ? null : `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%; height:${h}px;"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" /></svg>`;
}

async function openCampaignDrawer(name) {
  const overlay = document.getElementById('aiCampaignDrawerOverlay');
  const panel = document.getElementById('aiCampaignDrawerPanel');
  panel.innerHTML = '<div class="empty-state">جارِ التحميل…</div>';
  overlay.classList.add('open');

  const params = { name };
  if (currentDateFrom) params.dateFrom = currentDateFrom;
  if (currentDateTo) params.dateTo = currentDateTo;

  try {
    const data = await api.get('/api/ai-intelligence/campaign-detail', params);
    renderCampaignDrawer(data);
  } catch (err) {
    panel.innerHTML = `<div class="empty-state">⚠️ ${UI.escapeHtml(err.message)}</div>`;
  }
}

function closeCampaignDrawer() {
  document.getElementById('aiCampaignDrawerOverlay').classList.remove('open');
}

function metricRow(label, value) {
  return `<div style="display:flex; justify-content:space-between; font-size:13px; padding:6px 0; border-bottom:1px solid var(--border);"><span class="faint">${label}</span><span class="mono">${value}</span></div>`;
}

function renderCampaignDrawer(data) {
  const { campaignName, delivery, summary: s, accountAvg: a, dailySeries, relatedAds, hasDateVariety } = data;
  const panel = document.getElementById('aiCampaignDrawerPanel');
  const campaignProblems = (lastAnalysis?.problems || []).filter((p) => p.campaignName === campaignName);

  const chart = hasDateVariety ? sparklineSvg(dailySeries, 'spend', '#60a5fa') : '';

  panel.innerHTML = `
    <div class="drawer-header">
      <div>
        <div class="drawer-title">${UI.escapeHtml(campaignName)}</div>
        ${delivery ? `<div class="drawer-meta">${UI.escapeHtml(delivery)}</div>` : ''}
      </div>
      <button class="drawer-close" id="aiDrawerCloseBtn">✕</button>
    </div>

    <div class="section-title" style="font-size:13.5px;">📋 الملخص</div>
    ${metricRow('الصرف', moneyOrDash(s.spend) + ' جنيه')}
    ${metricRow('النتائج' + (s.resultsSource === 'meta_purchases' ? ' (مشتريات)' : ''), s.results ?? '—')}
    ${metricRow('CPA', s.cpa !== null ? s.cpa.toFixed(2) + ' جنيه' : '—')}
    ${metricRow('CTR', s.ctr !== null ? s.ctr.toFixed(2) + '%' : '—')}
    ${metricRow('CPC', s.cpc !== null ? s.cpc.toFixed(2) + ' جنيه' : '—')}
    ${metricRow('CPM', s.cpm !== null ? s.cpm.toFixed(2) + ' جنيه' : '—')}
    ${metricRow('ROAS' + (s.revenueEstimated ? ' (تقديري)' : ''), s.roas !== null ? s.roas.toFixed(2) + 'x' : 'مفيش بيانات إيراد')}

    <div class="section-title" style="font-size:13.5px;">📈 الأداء عبر الوقت</div>
    ${chart ? `<div style="margin-bottom:14px;">${chart}</div>` : `<div class="faint" style="font-size:12.5px; margin-bottom:14px;">لا يمكن عرض اتجاه لأن البيانات في الفترة دي ليوم واحد بس.</div>`}

    <div class="section-title" style="font-size:13.5px;">⚖️ مقارنة بمتوسط الحساب</div>
    ${metricRow('CPA — الحملة مقابل المتوسط', `${s.cpa !== null ? s.cpa.toFixed(1) : '—'} / ${a.cpa !== null ? a.cpa.toFixed(1) : '—'}`)}
    ${metricRow('CTR — الحملة مقابل المتوسط', `${s.ctr !== null ? s.ctr.toFixed(2) + '%' : '—'} / ${a.ctr !== null ? a.ctr.toFixed(2) + '%' : '—'}`)}

    ${
      campaignProblems.length > 0
        ? `<div class="section-title" style="font-size:13.5px;">⚠️ مشاكل مكتشفة</div>` +
          campaignProblems
            .map(
              (p) => `<div class="alert-card ${p.severity === 'CRITICAL' ? 'negative' : p.severity === 'WARNING' ? 'warning' : ''}">
                <div class="alert-title">${PROBLEM_TYPE_ICON[p.type] || '⚠️'} ${UI.escapeHtml(p.message)}</div>
                <div class="alert-rec">${UI.escapeHtml(p.recommendedAction)}</div>
              </div>`
            )
            .join('')
        : ''
    }

    ${
      relatedAds.length > 0
        ? `<div class="section-title" style="font-size:13.5px;">🖼️ الإعلانات المرتبطة</div>
        <div class="table-wrap" style="margin-bottom:14px;"><table class="data"><thead><tr><th>الإعلان</th><th>الصرف</th><th>النتائج</th><th>CPA</th></tr></thead><tbody>
        ${relatedAds
          .map((ad) => `<tr><td>${UI.escapeHtml(ad.campaignName)}</td><td class="mono">${moneyOrDash(ad.spend)}</td><td class="mono">${ad.results ?? '—'}</td><td class="mono">${ad.cpa !== null ? ad.cpa.toFixed(1) : '—'}</td></tr>`)
          .join('')}
        </tbody></table></div>`
        : ''
    }

    <div style="margin-top:14px;">
      <button class="btn secondary small" id="aiDrawerLinkBtn">🔗 ربط بمنتج</button>
    </div>
  `;

  document.getElementById('aiDrawerCloseBtn').onclick = closeCampaignDrawer;
  document.getElementById('aiDrawerLinkBtn').onclick = () => openLinkModal(campaignName);
}

init();
