// ai-intelligence.js — page controller for ai-intelligence.html: a Daily
// Decision Dashboard, not an analytics dashboard. Upload -> column mapping
// -> real product-first Decision Engine (backend/src/services/
// productAnalysis.js + decisionEngine.js) -> a real Claude "Marketing
// Performance Decision Agent" (backend/src/services/aiActionPlan.js) writes
// the reason/action text on top of already-final numbers -> Top-3-by-
// default sections with "عرض المزيد" -> a generalized entity-detail drawer
// (product or standalone campaign) for drill-down. Data Quality Center and
// True Business Performance (optional, product-linked profitability layer)
// are unchanged from Phase 1.
import * as UI from './ui-common.js';
import { api } from './api-client.js';
import { Products } from './db.js';

const SOURCE_LABELS_AR = { easyorders: 'EasyOrders', daily_orders: 'إدخال يدوي', none: 'مفيش بيانات حقيقية' };

const BUCKETS = [
  { key: 'scale', containerId: 'aiBucketScale', title: '🚀 جاهز للتوسع', cardClass: 'SCALE', emptyText: 'مفيش منتج أو حملة وصلت لمستوى التوسع لسه في الفترة دي.' },
  { key: 'optimize', containerId: 'aiBucketOptimize', title: '🟡 يحتاج تحسين', cardClass: 'FIX', emptyText: 'مفيش حاجة محتاجة تحسين دلوقتي.' },
  { key: 'stop', containerId: 'aiBucketStop', title: '🔴 يحتاج تدخل فوري', cardClass: 'EXIT', emptyText: 'مفيش مشاكل حرجة دلوقتي.' },
  { key: 'collectMoreData', containerId: 'aiBucketCollect', title: '🧪 يحتاج بيانات أكتر', cardClass: 'INSUFFICIENT_DATA', emptyText: 'كل الحملات النشطة معاها بيانات كافية لقرار.' },
  { key: 'opportunities', containerId: 'aiBucketOpportunities', title: '💎 فرص مخفية', cardClass: 'RESTOCK', emptyText: 'مفيش فرص توسع واضحة بصرف منخفض دلوقتي.' },
];

const PRIORITY_LABEL_AR = { HIGH: 'أولوية عالية', MEDIUM: 'أولوية متوسطة', LOW: 'أولوية منخفضة' };
const CONFIDENCE_LABEL_AR = { HIGH: 'عالية', MEDIUM: 'متوسطة', LOW: 'منخفضة' };

let currentUpload = null; // {uploadId, headers, guessedMapping}
let currentDateFrom = null;
let currentDateTo = null;
let lastDecisions = null; // last /decisions response (for the drawer's reason/action lookup)
let productsCache = null;
let linkTargetCampaign = null;
let expandedBuckets = new Set();

async function init() {
  UI.renderSidebar('aiintel');
  document.getElementById('btnPickFile').onclick = () => document.getElementById('aiFileInput').click();
  document.getElementById('aiFileInput').onchange = handleFileSelected;
  document.getElementById('btnCancelMapping').onclick = cancelMapping;
  document.getElementById('btnConfirmProcess').onclick = confirmAndProcess;

  document.getElementById('filterToday').onclick = () => applyPresetRange(0, 0);
  document.getElementById('filterYesterday').onclick = () => applyPresetRange(1, 1);
  document.getElementById('filterLast7').onclick = () => applyPresetRange(6, 0);
  document.getElementById('btnApplyDateRange').onclick = () => {
    currentDateFrom = document.getElementById('aiDateFrom').value || null;
    currentDateTo = document.getElementById('aiDateTo').value || null;
    loadDecisions();
  };
  document.getElementById('btnShowInactive').onclick = toggleInactive;

  document.getElementById('aiCampaignDrawerOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'aiCampaignDrawerOverlay') closeEntityDrawer();
  });
  document.getElementById('btnCancelLink').onclick = closeLinkModal;
  document.getElementById('btnConfirmLink').onclick = confirmLinkProduct;
  document.getElementById('aiLinkProductOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'aiLinkProductOverlay') closeLinkModal();
  });

  await Promise.all([loadDecisions(), loadUploads(), loadTruePerformance()]);
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function applyPresetRange(fromDaysAgo, toDaysAgo) {
  currentDateFrom = isoDaysAgo(fromDaysAgo);
  currentDateTo = isoDaysAgo(toDaysAgo);
  document.getElementById('aiDateFrom').value = currentDateFrom;
  document.getElementById('aiDateTo').value = currentDateTo;
  loadDecisions();
}

// ---------------------------------------------------------------------------
// Upload + column mapping (unchanged from Phase 1)
// ---------------------------------------------------------------------------

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
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
  const FIELD_LABELS_AR = {
    date: 'التاريخ', campaign_name: 'اسم الحملة', campaign_id: 'كود الحملة', campaign_delivery: 'حالة الحملة',
    adset_name: 'اسم المجموعة الإعلانية', adset_id: 'كود المجموعة الإعلانية', ad_name: 'اسم الإعلان', ad_id: 'كود الإعلان',
    creative_name: 'اسم الكرييتف', creative_id: 'كود الكرييتف', spend: 'الصرف', impressions: 'مرات الظهور', reach: 'الوصول',
    frequency: 'التكرار', clicks: 'النقرات', ctr: 'CTR', cpc: 'CPC', cpm: 'CPM', landing_page_views: 'مشاهدات صفحة الهبوط',
    leads: 'الليدز', add_to_cart: 'إضافة للسلة', initiate_checkout: 'بدء الدفع', meta_purchases: 'مشتريات (Meta)',
    meta_revenue: 'إيراد (Meta)', meta_roas: 'ROAS (Meta)', results: 'النتائج (Results)', cost_per_result: 'التكلفة لكل نتيجة',
    result_indicator: 'مؤشر النتيجة',
  };
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
    const replacedNote = processResult.replacedRows > 0 ? ` — استبدل ${processResult.replacedRows} صف قديم لنفس التواريخ (مش هيتحسب مرتين).` : '';
    statusEl.textContent = `✅ اتعالج ${processResult.metricsCreated} صف${replacedNote}${processResult.unmatchedCampaigns.length ? ` — ${processResult.unmatchedCampaigns.length} حملة مش مربوطة بمنتج (تحليل الأداء شغال برضه)` : ''}.`;
    UI.toast('✅ تم رفع ومعالجة البيانات');

    document.getElementById('aiMappingCard').style.display = 'none';
    currentUpload = null;
    await Promise.all([loadDecisions(), loadUploads(), loadTruePerformance()]);
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
// Manual product linking (Data Quality Center removed — this modal is now
// reached only from an entity's drawer, e.g. an unmapped campaign's
// "🔗 ربط بمنتج" button)
// ---------------------------------------------------------------------------

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
    await Promise.all([loadTruePerformance(), loadDecisions()]);
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
// Daily Decision Dashboard
// ---------------------------------------------------------------------------

function money(n, decimals = 0) {
  return n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: decimals });
}

async function loadDecisions() {
  const params = {};
  if (currentDateFrom) params.dateFrom = currentDateFrom;
  if (currentDateTo) params.dateTo = currentDateTo;
  const data = await api.get('/api/ai-intelligence/decisions', params);
  lastDecisions = data.hasData ? data : null;

  document.getElementById('aiNoDataState').style.display = data.hasData ? 'none' : 'block';
  document.getElementById('aiNoActiveState').style.display = 'none';
  document.getElementById('aiFallbackNote').style.display = 'none';
  if (!data.hasData) {
    document.getElementById('aiDashboard').style.display = 'none';
    return;
  }

  if (data.usedFallback) {
    const note = document.getElementById('aiFallbackNote');
    note.style.display = 'block';
    note.textContent = `مفيش بيانات لليوم — معروض آخر بيانات مرفوعة بتاريخ ${data.window.from}.`;
  }

  const hasActivity = data.activeSummary.activeProducts > 0 || data.activeSummary.activeCampaigns > 0;
  if (!hasActivity) {
    document.getElementById('aiDashboard').style.display = 'none';
    const empty = document.getElementById('aiNoActiveState');
    empty.style.display = 'block';
    empty.textContent = 'مفيش حملات نشطة فيها صرف أو حالة Active خلال الفترة المختارة.';
    return;
  }

  document.getElementById('aiDashboard').style.display = 'block';
  renderSummaryTiles(data.activeSummary);
  renderActionPlan(data.actionPlan, data.window);
  renderNeedsMapping(data.needsMapping);
  for (const b of BUCKETS) renderBucket(b, data.buckets[b.key], data.actionPlan);

  const inactiveBtn = document.getElementById('btnShowInactive');
  inactiveBtn.textContent = `عرض الحملات غير النشطة (${data.inactiveCount})`;
  inactiveBtn.style.display = data.inactiveCount > 0 ? 'inline-flex' : 'none';
  document.getElementById('aiInactiveWrap').style.display = 'none';
}

function renderSummaryTiles(s) {
  const tiles = [
    { label: '📦 منتجات نشطة', value: s.activeProducts },
    { label: '📣 حملات نشطة', value: s.activeCampaigns },
    { label: '💰 إجمالي الصرف', value: money(s.spend) + ' جنيه' },
    { label: '🎯 إجمالي النتائج', value: s.results !== null ? money(s.results) : '—' },
    { label: '📌 متوسط CPA', value: s.cpa !== null ? money(s.cpa, 1) + ' جنيه' : '—' },
  ];
  document.getElementById('aiSummaryTiles').innerHTML = tiles
    .map((t) => `<div class="stat-tile"><div class="label">${t.label}</div><div class="value" style="font-size:22px;">${t.value}</div></div>`)
    .join('');
}

function renderActionPlan(plan, window) {
  const el = document.getElementById('aiActionPlanCard');
  const items = plan.items || [];
  const byKey = new Map(items.map((it) => [it.entityKey, it]));
  const ranked = (lastDecisions ? Object.values(lastDecisions.buckets).flatMap((b) => b.items) : [])
    .filter((e) => e.classification !== 'COLLECT_MORE_DATA')
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 5);

  const CLASS_ICON = { SCALE: '🚀', OPTIMIZE: '🟡', STOP: '🔴' };
  const listHtml = ranked
    .map((e, i) => {
      const text = byKey.get(e.entityKey);
      return `<div style="padding:8px 0; border-bottom:1px solid var(--border);">
        <div style="font-size:13.5px;"><b>${i + 1}. ${CLASS_ICON[e.classification] || ''} ${UI.escapeHtml(e.entityName)}</b> <span class="faint">(CPA: ${e.cpa !== null ? e.cpa.toFixed(1) : '—'} جنيه)</span></div>
        ${text ? `<div style="font-size:13px; margin-top:2px;">${UI.escapeHtml(text.recommendedAction)}</div>` : ''}
      </div>`;
    })
    .join('');

  el.innerHTML = `
    <div class="section-title" style="margin-top:0;">🤖 خطة عمل اليوم</div>
    <div style="font-size:13.5px; margin-bottom:10px;">${UI.escapeHtml(plan.summary)}</div>
    ${listHtml || '<div class="faint" style="font-size:12.5px;">مفيش أولويات واضحة النهاردة.</div>'}
    <div class="toolbar" style="margin-top:12px; margin-bottom:0;">
      <button class="btn secondary small" id="btnRefreshPlan">🔄 تحديث الخطة</button>
      ${plan.source === 'FALLBACK' ? '<span class="faint" style="font-size:11.5px;">النصوص دي مؤقتة (قوالب ثابتة) — التصنيف والأرقام صحيحة 100%.</span>' : ''}
    </div>
  `;
  document.getElementById('btnRefreshPlan').onclick = async () => {
    const btn = document.getElementById('btnRefreshPlan');
    btn.disabled = true;
    btn.textContent = 'بيحدّث...';
    try {
      await api.post('/api/ai-intelligence/decisions/generate-plan', { dateFrom: window.from, dateTo: window.to });
      await loadDecisions();
    } finally {
      btn.disabled = false;
    }
  };
}

function renderNeedsMapping(nm) {
  const el = document.getElementById('aiNeedsMappingLine');
  if (nm.count === 0) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.innerHTML = `🔗 ${nm.count} حملة نشطة محتاجة ربط بمنتج — افتح تفاصيل أي حملة تحت وادوس "ربط بمنتج".`;
}

function priorityBadgeColor(p) {
  return p === 'HIGH' ? 'red' : p === 'MEDIUM' ? 'yellow' : 'gray';
}

function entityCardHtml(e, actionItem, cardClass) {
  const reason = actionItem?.reason || '';
  const action = actionItem?.recommendedAction || '';
  return `
    <div class="action-card ${cardClass}" style="cursor:pointer;" data-open-type="${e.entityType}" data-open-key="${UI.escapeHtml(e.entityKey)}">
      <div class="action-card-title">${e.entityType === 'product' ? '📦' : '📣'} ${UI.escapeHtml(e.entityName)} <span class="badge ${priorityBadgeColor(e.priority)}" style="margin-inline-start:6px;">${PRIORITY_LABEL_AR[e.priority]}</span></div>
      <div class="action-card-metrics">
        <span class="mono">CPA: ${e.cpa !== null ? e.cpa.toFixed(1) : '—'} جنيه</span>
        <span class="mono">صرف: ${money(e.spend)} جنيه</span>
        <span class="mono">نتائج: ${e.results ?? '—'}</span>
      </div>
      ${reason ? `<div class="action-card-reasons">${UI.escapeHtml(reason)}</div>` : ''}
      ${action ? `<div class="action-card-reasons" style="font-weight:600;">${UI.escapeHtml(action)}</div>` : ''}
      <div class="action-card-confidence">الثقة: ${CONFIDENCE_LABEL_AR[e.confidence]}</div>
      <div class="action-status-row">
        <button class="status-btn" data-review="REVIEWED" data-type="${e.entityType}" data-key="${UI.escapeHtml(e.entityKey)}">✓ تمت المراجعة</button>
        <button class="status-btn" data-review="DISMISSED" data-type="${e.entityType}" data-key="${UI.escapeHtml(e.entityKey)}">تجاهل</button>
      </div>
    </div>`;
}

function renderBucket(bucketDef, bucketData, plan) {
  const el = document.getElementById(bucketDef.containerId);
  const items = bucketData.items || [];
  const byKey = new Map((plan.items || []).map((it) => [it.entityKey, it]));

  if (items.length === 0) {
    el.innerHTML = `<div class="section-title">${bucketDef.title}</div><div class="empty-state" style="font-size:13px;">${bucketDef.emptyText}</div>`;
    return;
  }

  const expanded = expandedBuckets.has(bucketDef.key);
  const shown = expanded ? items : items.slice(0, 3);
  const remaining = items.length - shown.length;

  el.innerHTML = `
    <div class="section-title">${bucketDef.title} <span class="faint" style="font-weight:400; font-size:12px;">(${items.length})</span></div>
    <div class="ai-bucket-cards">${shown.map((e) => entityCardHtml(e, byKey.get(e.entityKey), bucketDef.cardClass)).join('')}</div>
    ${remaining > 0 ? `<button class="btn secondary small" data-expand="${bucketDef.key}" style="margin-top:8px;">عرض المزيد (${remaining})</button>` : ''}
  `;

  el.querySelectorAll('[data-open-type]').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.status-btn')) return; // review/dismiss buttons handle their own click
      openEntityDrawer(card.dataset.openType, card.dataset.openKey);
    });
  });
  el.querySelectorAll('[data-review]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      await api.post('/api/ai-intelligence/decisions/review', { entityType: btn.dataset.type, entityKey: btn.dataset.key, status: btn.dataset.review });
      UI.toast(btn.dataset.review === 'DISMISSED' ? 'تم التجاهل' : 'تم وضع علامة تمت المراجعة');
      await loadDecisions();
    };
  });
  const expandBtn = el.querySelector('[data-expand]');
  if (expandBtn) {
    expandBtn.onclick = () => {
      expandedBuckets.add(bucketDef.key);
      renderBucket(bucketDef, bucketData, plan);
    };
  }
}

async function toggleInactive() {
  const wrap = document.getElementById('aiInactiveWrap');
  if (wrap.style.display === 'block') {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  const body = document.getElementById('aiInactiveBody');
  body.innerHTML = '<tr><td colspan="5" class="empty-state">جارِ التحميل…</td></tr>';
  const params = {};
  if (currentDateFrom) params.dateFrom = currentDateFrom;
  if (currentDateTo) params.dateTo = currentDateTo;
  const data = await api.get('/api/ai-intelligence/analysis', params);
  if (!data.hasData) {
    body.innerHTML = '<tr><td colspan="5" class="empty-state">مفيش بيانات.</td></tr>';
    return;
  }
  const inactive = data.campaigns.filter((c) => !((c.spend || 0) > 0 || c.delivery === 'active'));
  if (inactive.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="empty-state">مفيش حملات غير نشطة في الفترة دي.</td></tr>';
    return;
  }
  body.innerHTML = inactive
    .map(
      (c) => `<tr>
        <td>${UI.escapeHtml(c.campaignName)}</td>
        <td><span class="badge gray">${c.delivery ? UI.escapeHtml(c.delivery) : 'غير نشطة'}</span></td>
        <td class="mono">${money(c.spend)}</td>
        <td class="mono">${c.results ?? '—'}</td>
        <td class="mono">${c.cpa !== null ? c.cpa.toFixed(1) : '—'}</td>
      </tr>`
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Entity detail drawer (product or standalone campaign)
// ---------------------------------------------------------------------------

function metricRow(label, value) {
  return `<div style="display:flex; justify-content:space-between; font-size:13px; padding:6px 0; border-bottom:1px solid var(--border);"><span class="faint">${label}</span><span class="mono">${value}</span></div>`;
}

async function openEntityDrawer(type, key) {
  const overlay = document.getElementById('aiCampaignDrawerOverlay');
  const panel = document.getElementById('aiCampaignDrawerPanel');
  panel.innerHTML = '<div class="empty-state">جارِ التحميل…</div>';
  overlay.classList.add('open');

  const params = { type, key };
  if (currentDateFrom) params.dateFrom = currentDateFrom;
  if (currentDateTo) params.dateTo = currentDateTo;

  try {
    const entity = await api.get('/api/ai-intelligence/decisions/entity', params);
    renderEntityDrawer(entity);
  } catch (err) {
    panel.innerHTML = `<div class="empty-state">⚠️ ${UI.escapeHtml(err.message)}</div>`;
  }
}

function closeEntityDrawer() {
  document.getElementById('aiCampaignDrawerOverlay').classList.remove('open');
}

const CLASSIFICATION_LABEL_AR = { SCALE: '🚀 توسع', OPTIMIZE: '🟡 تحسين', STOP: '🔴 إيقاف/تقليل', COLLECT_MORE_DATA: '🧪 يحتاج بيانات أكتر' };

function renderEntityDrawer(e) {
  const panel = document.getElementById('aiCampaignDrawerPanel');

  const campaignRows = e.campaigns
    ? `<div class="section-title" style="font-size:13.5px;">ليه؟ — أداء الحملات جوه المنتج</div>
      <div class="table-wrap" style="margin-bottom:14px;"><table class="data"><thead><tr><th>الحملة</th><th>الصرف</th><th>النتائج</th><th>CPA</th></tr></thead><tbody>
      ${e.campaigns
        .map(
          (c) => `<tr>
            <td>${UI.escapeHtml(c.campaignName)}</td>
            <td class="mono">${money(c.spend)}</td>
            <td class="mono">${c.results ?? '—'}</td>
            <td class="mono">${c.cpa !== null ? c.cpa.toFixed(1) : '—'}</td>
          </tr>`
        )
        .join('')}
      </tbody></table></div>`
    : '';

  const adRows = e.adBreakdown
    ? `<div class="section-title" style="font-size:13.5px;">🖼️ الإعلانات المرتبطة</div>
      <div class="table-wrap" style="margin-bottom:14px;"><table class="data"><thead><tr><th>الإعلان</th><th>الصرف</th><th>النتائج</th><th>CPA</th></tr></thead><tbody>
      ${e.adBreakdown.map((ad) => `<tr><td>${UI.escapeHtml(ad.campaignName)}</td><td class="mono">${money(ad.spend)}</td><td class="mono">${ad.results ?? '—'}</td><td class="mono">${ad.cpa !== null ? ad.cpa.toFixed(1) : '—'}</td></tr>`).join('')}
      </tbody></table></div>`
    : `<div class="faint" style="font-size:12.5px; margin-bottom:14px;">مفيش بيانات على مستوى الإعلان — الملف المرفوع حملات فقط (Campaign-level) من غير أعمدة Ad Set / Ad.</div>`;

  const drillDown = e.drillDown
    ? `<div class="section-title" style="font-size:13.5px;">🎯 التوصية بالتفصيل</div>
      <div style="font-size:13px; margin-bottom:6px;"><b>حافظ على:</b> ${e.drillDown.protect.map((c) => UI.escapeHtml(c.campaignName)).join('، ')}</div>
      <div style="font-size:13px; margin-bottom:14px;"><b>قلل/أوقف:</b> ${e.drillDown.reduce.map((c) => UI.escapeHtml(c.campaignName)).join('، ')}</div>`
    : '';

  panel.innerHTML = `
    <div class="drawer-header">
      <div>
        <div class="drawer-title">${e.entityType === 'product' ? '📦' : '📣'} ${UI.escapeHtml(e.entityName)}</div>
        <div class="drawer-meta">${CLASSIFICATION_LABEL_AR[e.classification]} · ${PRIORITY_LABEL_AR[e.priority]} · ثقة ${CONFIDENCE_LABEL_AR[e.confidence]}</div>
      </div>
      <button class="drawer-close" id="aiDrawerCloseBtn">✕</button>
    </div>

    ${e.reason ? `<div style="font-size:13.5px; margin-bottom:8px;">${UI.escapeHtml(e.reason)}</div>` : ''}
    ${e.recommendedAction ? `<div style="font-size:13.5px; font-weight:600; margin-bottom:14px;">${UI.escapeHtml(e.recommendedAction)}</div>` : ''}

    ${metricRow('الصرف', money(e.spend) + ' جنيه')}
    ${metricRow('النتائج', e.results ?? '—')}
    ${metricRow('CPA', e.cpa !== null ? e.cpa.toFixed(2) + ' جنيه' : '—')}
    ${metricRow('ROAS' + (e.revenueEstimated ? ' (تقديري)' : ''), e.roas !== null ? e.roas.toFixed(2) + 'x' : 'مفيش بيانات إيراد')}

    <div style="margin:14px 0;"></div>
    ${drillDown}
    ${campaignRows}
    ${adRows}

    <div class="toolbar" style="margin-top:8px;">
      <button class="btn secondary small" id="aiDrawerReviewBtn">✓ تمت المراجعة</button>
      <button class="btn secondary small" id="aiDrawerDismissBtn">تجاهل</button>
      ${e.entityType === 'campaign' ? `<button class="btn secondary small" id="aiDrawerLinkBtn">🔗 ربط بمنتج</button>` : ''}
    </div>
  `;

  document.getElementById('aiDrawerCloseBtn').onclick = closeEntityDrawer;
  document.getElementById('aiDrawerReviewBtn').onclick = async () => {
    await api.post('/api/ai-intelligence/decisions/review', { entityType: e.entityType, entityKey: e.entityKey, status: 'REVIEWED' });
    UI.toast('تم وضع علامة تمت المراجعة');
    closeEntityDrawer();
    loadDecisions();
  };
  document.getElementById('aiDrawerDismissBtn').onclick = async () => {
    await api.post('/api/ai-intelligence/decisions/review', { entityType: e.entityType, entityKey: e.entityKey, status: 'DISMISSED' });
    UI.toast('تم التجاهل');
    closeEntityDrawer();
    loadDecisions();
  };
  const linkBtn = document.getElementById('aiDrawerLinkBtn');
  if (linkBtn) linkBtn.onclick = () => openLinkModal(e.entityName);
}

init();
