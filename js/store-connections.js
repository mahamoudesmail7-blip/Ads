// Store Connections admin page — page controller for store-connections.html.
// ADMIN-only, read-only. Shows, per configured Easy Orders store: whether
// its API key is set, whether its webhook is set (handling the DEFAULT
// store's legacy split-secret shape separately from every other store's
// single-secret shape — see services/easyOrdersStores.js's
// storeConnectionsOverview()), the EXACT webhook URL(s) to paste into that
// store's Easy Orders dashboard, its real product count, and when its last
// real order actually arrived. Never displays a credential value — only
// presence booleans and one-way fingerprints, same as the existing
// storeConfigDiagnostics() admin API this reuses.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const E = (s) => UI.escapeHtml(String(s ?? ''));
const $ = (id) => document.getElementById(id);

async function init() {
  await UI.renderSidebar('storeconnections');
  await load();
}

async function load() {
  const body = $('storeConnectionsBody');
  let data;
  try {
    data = await api.get('/api/product-marketing/stores/connections');
  } catch (err) {
    body.innerHTML = `<div class="card"><p class="muted">⚠️ ${E(err.message)}</p></div>`;
    return;
  }
  render(body, data.stores || []);
}

function statusBadge(ok, labelOk, labelMissing) {
  return ok ? `<span class="badge green">✅ ${E(labelOk)}</span>` : `<span class="badge red">❌ ${E(labelMissing)}</span>`;
}

function webhookRowHtml(label, configured, url, hint) {
  return `
    <div style="padding:10px 0;border-top:1px solid var(--border);">
      <div style="margin-bottom:6px;">${E(label)} ${statusBadge(configured, 'مضبوط', 'غير مضبوط')}</div>
      <div class="toolbar" style="margin-bottom:${hint ? '6px' : '0'};">
        <code style="font-size:12px;word-break:break-all;">${E(url)}</code>
        <button class="btn secondary small" data-copy="${E(url)}">📋 نسخ الرابط</button>
      </div>
      ${hint ? `<div class="faint" style="font-size:11.5px;">${hint}</div>` : ''}
    </div>`;
}
function webhookSectionHtml(s) {
  if (s.webhookMode === 'legacy-split') {
    return [
      webhookRowHtml('طلب جديد (Order Created)', s.legacyOrderCreatedSecretConfigured, s.webhookUrls.orderCreated,
        s.legacyOrderCreatedSecretConfigured ? '' : `حط قيمة حقيقية في متغيّر البيئة <code>EASYORDERS_WEBHOOK_SECRET</code> في Railway، ونفس القيمة في إعدادات الـ webhook ده جوه Easy Orders.`),
      webhookRowHtml('تحديث حالة الطلب (Order Status Update)', s.legacyStatusUpdateSecretConfigured, s.webhookUrls.statusUpdate,
        s.legacyStatusUpdateSecretConfigured ? '' : `حط قيمة حقيقية في متغيّر البيئة <code>EASYORDERS_STATUS_WEBHOOK_SECRET</code> في Railway، ونفس القيمة في إعدادات الـ webhook ده جوه Easy Orders.`),
    ].join('');
  }
  const hint = s.webhookSecretConfigured ? '' : (s.webhookSecretEnv
    ? `حط قيمة حقيقية في متغيّر البيئة <code>${E(s.webhookSecretEnv)}</code> في Railway، ونفس القيمة في إعدادات الـ webhook ده جوه Easy Orders.`
    : 'المتجر ده معندوش webhookSecretEnv متظبط في إعدادات المتاجر أصلاً.');
  return webhookRowHtml('Webhook واحد لكل الأحداث', s.webhookSecretConfigured, s.webhookUrls.combined, hint);
}

function storeCardHtml(s) {
  const lastOrder = s.lastOrderAt ? new Date(s.lastOrderAt).toLocaleString('ar-EG') : 'لسه معملتش أوردر وصل';
  return `
    <div class="card" style="margin-bottom:18px;">
      <div class="section-title" style="margin-top:0;display:flex;justify-content:space-between;align-items:center;">
        <span>🏬 ${E(s.name)} <span class="faint" style="font-size:11.5px;font-weight:400;">(id: ${E(s.id)})</span></span>
        ${s.enabled === false ? '<span class="badge gray">معطّل</span>' : ''}
      </div>

      <div class="stat-grid" style="margin-bottom:14px;">
        ${UI.statTile('🔑 مفتاح API', s.apiKeyConfigured ? '✅ مضبوط' : '❌ غير مضبوط', { colorClass: s.apiKeyConfigured ? 'green' : 'red' })}
        ${UI.statTile('📦 عدد المنتجات', s.productCount != null ? s.productCount.toLocaleString('en-US') : (s.productCountError ? '⚠️ خطأ' : '—'))}
        ${UI.statTile('🧾 إجمالي الأوردرات المستلمة', s.totalOrders.toLocaleString('en-US'))}
        ${UI.statTile('🕐 آخر أوردر وصل', lastOrder, { fontSize: '13px' })}
      </div>
      ${s.productCountError ? `<p class="faint" style="font-size:11.5px;color:var(--danger,#c0392b);">تعذّر تحميل الكتالوج: ${E(s.productCountError)}</p>` : ''}

      <div class="faint" style="font-size:11.5px;margin-bottom:4px;">مفتاح الـ API بيتقرأ من متغيّر البيئة <code>${E(s.apiKeyEnv)}</code> على Railway.</div>

      <div class="section-title" style="font-size:14px;margin-top:16px;">🔌 الـ Webhook</div>
      ${webhookSectionHtml(s)}

      <div class="section-title" style="font-size:14px;margin-top:16px;">📥 استيراد أوردرات قديمة من ملف Export</div>
      <p class="faint" style="font-size:11.5px;">Easy Orders مالهاش API لسحب كل الأوردرات دفعة واحدة — الطريقة الوحيدة للأوردرات القديمة هي تصدّر ملف Excel من لوحة تحكم Easy Orders نفسها (زرار Export) وترفعه هنا. كل صف بيتعامل معاه بالظبط زي أي أوردر حقيقي بييجي من الـ webhook (نفس ربط العميل، نفس التجميعات) — آمن تكرر رفع نفس الملف من غير ما يتكرر أي أوردر.</p>
      <div class="toolbar">
        <input type="file" accept=".xlsx" id="importFile-${E(s.id)}" style="max-width:260px;" />
        <button class="btn small" data-import-store="${E(s.id)}">📥 استورد</button>
      </div>
      <div id="importStatus-${E(s.id)}" style="margin-top:8px;"></div>
    </div>`;
}

function render(body, stores) {
  if (!stores.length) {
    body.innerHTML = '<div class="card"><p class="muted">مفيش أي متجر Easy Orders متظبط حاليًا.</p></div>';
    return;
  }
  body.innerHTML = `
    <div class="card" style="margin-bottom:18px;">
      <p class="faint" style="font-size:12.5px;">هنا تقدر تتابع حالة ربط كل متجر ومفيش تغيير في الـ IDs أو المنتجات أو الحملات من هنا — الاستثناء الوحيد هو قسم "استيراد أوردرات قديمة" في كل كارت، ده بيكتب أوردرات حقيقية عمدًا. لتصحيح أي مفتاح/سر ناقص، لازم تتغيّر في متغيّرات البيئة على Railway مباشرة.</p>
    </div>
    ${stores.map(storeCardHtml).join('')}`;

  body.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        UI.toast('تم نسخ الرابط', 'success');
      } catch {
        UI.toast('تعذّر النسخ التلقائي — انسخ الرابط يدويًا.', 'error');
      }
    };
  });

  body.querySelectorAll('[data-import-store]').forEach((btn) => {
    btn.onclick = () => startImport(btn.dataset.importStore);
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); // strip the "data:...;base64," prefix
    reader.onerror = () => reject(reader.error || new Error('تعذّر قراءة الملف.'));
    reader.readAsDataURL(file);
  });
}

async function startImport(storeId) {
  const fileInput = $(`importFile-${storeId}`);
  const statusBox = $(`importStatus-${storeId}`);
  const file = fileInput?.files?.[0];
  if (!file) { UI.toast('اختر ملف Excel (.xlsx) الأول.', 'error'); return; }

  statusBox.innerHTML = '<p class="muted">⏳ بنقرأ الملف…</p>';
  let started;
  try {
    const fileBase64 = await fileToBase64(file);
    started = await api.post('/api/easyorders/import', { storeId, fileBase64 });
  } catch (e) {
    statusBox.innerHTML = `<p class="badge red">${E(e.message || 'تعذّر بدء الاستيراد.')}</p>`;
    return;
  }
  if (started.parseSkippedCount) {
    statusBox.innerHTML = `<p class="muted">📄 ${E(started.totalRows)} أوردر صالح للاستيراد (${E(started.parseSkippedCount)} صف اتجاهل — مفيهوش Order ID). بنستورد…</p>`;
  } else {
    statusBox.innerHTML = `<p class="muted">📄 ${E(started.totalRows)} أوردر — بنستورد…</p>`;
  }
  pollImportJob(storeId, started.jobId);
}

async function pollImportJob(storeId, jobId) {
  const statusBox = $(`importStatus-${storeId}`);
  let job;
  try {
    job = await api.get(`/api/easyorders/import/${jobId}`);
  } catch (e) {
    statusBox.innerHTML = `<p class="badge red">${E(e.message)}</p>`;
    return;
  }
  const pct = job.totalRows ? Math.round((job.processed / job.totalRows) * 100) : 0;
  if (job.status === 'RUNNING') {
    statusBox.innerHTML = `<p class="muted">⏳ جارِ الاستيراد… ${E(job.processed)}/${E(job.totalRows)} (${pct}%) — ${E(job.imported)} تم، ${E(job.failed)} فشل</p>`;
    setTimeout(() => pollImportJob(storeId, jobId), 1500);
    return;
  }
  if (job.status === 'FAILED') {
    statusBox.innerHTML = `<p class="badge red">فشلت العملية بالكامل: ${E(job.fatalError || 'خطأ غير معروف')}</p>`;
    return;
  }
  const errorLines = job.errors?.length
    ? `<div class="faint" style="font-size:11px;margin-top:6px;">${job.errors.slice(0, 5).map((e) => `Order ${E(e.orderId)}: ${E(e.message)}`).join('<br>')}${job.errors.length > 5 ? `<br>و${job.errors.length - 5} خطأ إضافي…` : ''}</div>`
    : '';
  statusBox.innerHTML = `<p class="badge ${job.failed ? 'yellow' : 'green'}">✅ خلص — ${E(job.imported)} أوردر اتستورد بنجاح${job.failed ? `، ${E(job.failed)} فشل` : ''} (من ${E(job.totalRows)})</p>${errorLines}`;
  load(); // refresh the whole page's real order counts/last-order timestamp now that new data landed
}

document.addEventListener('DOMContentLoaded', init);
