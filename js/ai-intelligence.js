// ai-intelligence.js — page controller for ai-intelligence.html (AI Business
// Intelligence, Phase 1: upload -> column mapping -> Data Quality Center ->
// True Business Performance). Every number rendered here comes from
// backend/src/routes/adsIntelligence.js, which reads only real uploaded
// rows and real EasyOrdersOrder/DailyOrder/Product data — nothing invented.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const FIELD_LABELS_AR = {
  date: 'التاريخ',
  campaign_name: 'اسم الحملة',
  campaign_id: 'كود الحملة',
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
};

const SOURCE_LABELS_AR = { easyorders: 'EasyOrders', daily_orders: 'إدخال يدوي', none: 'مفيش بيانات حقيقية' };

let currentUpload = null; // {uploadId, headers, guessedMapping}

async function init() {
  UI.renderSidebar('aiintel');
  document.getElementById('btnPickFile').onclick = () => document.getElementById('aiFileInput').click();
  document.getElementById('aiFileInput').onchange = handleFileSelected;
  document.getElementById('btnCancelMapping').onclick = cancelMapping;
  document.getElementById('btnConfirmProcess').onclick = confirmAndProcess;
  await Promise.all([loadUploads(), loadDataQuality(), loadTruePerformance()]);
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
    statusEl.textContent = `✅ اتعالج ${processResult.metricsCreated} صف${processResult.unmatchedCampaigns.length ? ` — ${processResult.unmatchedCampaigns.length} حملة مش مربوطة بمنتج` : ''}.`;
    UI.toast('✅ تم رفع ومعالجة البيانات');

    document.getElementById('aiMappingCard').style.display = 'none';
    currentUpload = null;
    await Promise.all([loadUploads(), loadDataQuality(), loadTruePerformance()]);
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

async function loadDataQuality() {
  const dq = await api.get('/api/ai-intelligence/data-quality');
  const el = document.getElementById('aiDataQuality');
  const parts = [`<div style="font-size:13.5px; margin-bottom:10px;">📊 إجمالي صفوف الإعلانات المعالجة: <b>${dq.totalMetricRows}</b></div>`];

  if (dq.unmatchedCampaigns.length === 0) {
    parts.push('<div class="faint" style="font-size:12.5px;">✅ كل الحملات مربوطة بمنتجات.</div>');
  } else {
    parts.push(`<div class="section-title" style="font-size:13px; margin-top:0;">⚠️ ${dq.unmatchedCampaignCount} حملة مش مربوطة بمنتج</div>`);
    parts.push(
      `<div class="table-wrap"><table class="data"><thead><tr><th>اسم الحملة</th><th>عدد الصفوف</th><th>إجمالي الصرف</th></tr></thead><tbody>${dq.unmatchedCampaigns
        .map((c) => `<tr><td>${UI.escapeHtml(c.campaignName || '—')}</td><td class="mono">${c.rowCount}</td><td class="mono">${c.totalSpend.toFixed(2)}</td></tr>`)
        .join('')}</tbody></table></div>`
    );
  }

  if (dq.importIssues.length > 0) {
    parts.push(`<div class="section-title" style="font-size:13px;">📥 ملفات فيها تحذيرات عند الرفع</div>`);
    parts.push(dq.importIssues.map((i) => `<div style="font-size:12.5px;">${UI.escapeHtml(i.filename)} — ${i.warningCount} تحذير</div>`).join(''));
  }

  el.innerHTML = parts.join('');
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

init();
