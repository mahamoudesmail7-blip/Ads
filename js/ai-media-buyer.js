// ai-media-buyer.js — page controller for ai-media-buyer.html. A new module
// INSIDE AI Intelligence (the existing ai-intelligence.html is untouched).
// Every number shown here is computed by the backend's deterministic engines
// (backend/src/services/amb/*). Claude only ever writes the `reason` text and
// the executive summary. Nothing reaches the live Meta ad account without an
// explicit "Approve & Execute" click and a backend revalidation.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const E = (s) => UI.escapeHtml(String(s ?? ''));
const $ = (id) => document.getElementById(id);

function fmtNum(v, d = 0) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtEGP(v, d = 0) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `${fmtNum(v, d)} ج`;
}
function fmtPct(v, d = 1) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `${fmtNum(v, d)}%`;
}
function fmtX(v, d = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `${fmtNum(v, d)}×`;
}
function fmtDT(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
}

const TABS = [
  { key: 'overview', label: 'نظرة عامة', panel: 'ambTabOverview', render: renderOverview },
  { key: 'products', label: 'المنتجات', panel: 'ambTabProducts', render: renderProducts },
  { key: 'campaigns', label: 'تحليل الحملات', panel: 'ambTabCampaigns', render: renderCampaigns },
  { key: 'winners', label: 'الأبطال', panel: 'ambTabWinners', render: renderWinners },
  { key: 'plan', label: 'خطة عمل AI', panel: 'ambTabPlan', render: renderPlan, countKey: 'pendingCriticalRecs' },
  { key: 'history', label: 'سجل التنفيذ', panel: 'ambTabHistory', render: renderHistory },
  { key: 'settings', label: 'الإعدادات', panel: 'ambTabSettings', render: renderSettings },
];

const WINDOWS = [
  { key: 'today', label: 'اليوم' },
  { key: 'yesterday', label: 'أمس' },
  { key: 'last3', label: 'آخر 3 أيام' },
  { key: 'last7', label: 'آخر 7 أيام' },
];

let state = {
  tab: 'overview',
  window: 'today',
  overview: null,
  isAdmin: false,
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
async function init() {
  UI.renderSidebar('aimediabuyer');
  try {
    const me = await api.get('/api/auth/me');
    state.isAdmin = me.role === 'ADMIN' || me.is_owner;
  } catch { /* api-client handles 401 */ }

  $('ambBtnSyncNow').onclick = syncNow;
  $('ambDrawerOverlay').addEventListener('click', (e) => { if (e.target.id === 'ambDrawerOverlay') closeDrawer(); });

  window.addEventListener('hashchange', route);
  await loadSyncStrip();
  route();
}

function renderTabs() {
  $('ambTabs').innerHTML = TABS.map((t) => {
    const count = t.countKey && state.overview?.status?.[t.countKey] ? `<span class="amb-tab-count">${state.overview.status[t.countKey]}</span>` : '';
    return `<button class="amb-tab ${t.key === state.tab ? 'active' : ''}" data-tab="${t.key}">${E(t.label)}${count}</button>`;
  }).join('');
  $('ambTabs').querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { location.hash = b.dataset.tab; };
  });
}

function route() {
  const hash = (location.hash || '#overview').slice(1);
  const tab = TABS.find((t) => t.key === hash) ? hash : 'overview';
  state.tab = tab;
  renderTabs();
  for (const t of TABS) $(t.panel).hidden = t.key !== tab;
  const t = TABS.find((x) => x.key === tab);
  const panel = $(t.panel);
  panel.innerHTML = '<div class="faint" style="padding:20px;">جارِ التحميل…</div>';
  t.render(panel).catch((err) => {
    panel.innerHTML = `<div class="empty-state">⚠️ ${E(err.message || err)}</div>`;
  });
}

async function loadSyncStrip() {
  try {
    const s = await api.get('/api/ai-media-buyer/sync/status');
    const last = s.lastRun;
    const statusAr = { SUCCESS: 'تمت بنجاح', RUNNING: 'جارية', PARTIAL: 'جزئية', FAILED: 'فشلت' }[last?.status] || '—';
    $('ambSyncText').innerHTML = last
      ? `آخر مزامنة: <b>${fmtDT(last.at)}</b> · الحالة: <b>${E(statusAr)}</b> · المزامنة الجاية: <b>${fmtDT(s.nextSyncAt)}</b> · كل ${s.intervalMinutes} دقيقة${last.snapshotRows != null ? ` · ${last.snapshotRows} صف snapshot` : ''}`
      : 'لسه مفيش مزامنة — اضغط "مزامنة الآن" أو استنى الجدولة.';
  } catch (err) {
    $('ambSyncText').textContent = `⚠️ ${err.message}`;
  }
}

async function syncNow() {
  const btn = $('ambBtnSyncNow');
  btn.disabled = true;
  btn.textContent = '… بيزامن';
  try {
    const r = await api.post('/api/ai-media-buyer/sync/run', {});
    if (r.skipped) UI.toast(`المزامنة اتخطت: ${r.skipped}`, 'error');
    else UI.toast(`✅ اتزامن ${r.snapshotRows} صف (+${r.adsDailyRefreshed} في AI Intelligence)`);
    await loadSyncStrip();
    route();
  } catch (err) {
    UI.toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 مزامنة الآن';
  }
}

function windowPicker(onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'toolbar';
  wrap.style.marginBottom = '14px';
  wrap.innerHTML = WINDOWS.map((w) => `<button class="btn secondary small ${w.key === state.window ? '' : ''}" data-w="${w.key}" style="${w.key === state.window ? 'background:var(--accent);color:#fff;' : ''}">${E(w.label)}</button>`).join('');
  wrap.querySelectorAll('[data-w]').forEach((b) => {
    b.onclick = () => { state.window = b.dataset.w; onChange(); };
  });
  return wrap;
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------
function openDrawer(html) {
  $('ambDrawerPanel').innerHTML = html;
  $('ambDrawerOverlay').classList.add('open');
}
function closeDrawer() { $('ambDrawerOverlay').classList.remove('open'); }

// ---------------------------------------------------------------------------
// TAB: Overview
// ---------------------------------------------------------------------------
async function renderOverview(panel) {
  const ov = await api.get(`/api/ai-media-buyer/overview?window=${state.window}`);
  state.overview = ov;
  renderTabs();
  $('ambModeBadge').textContent = { ADVISORY: 'وضع استشاري', APPROVAL: 'وضع الموافقة', AUTOPILOT: 'أوتوبايلوت' }[ov.executionMode] || ov.executionMode || '—';
  $('ambModeBadge').className = 'badge ' + (ov.executionMode === 'AUTOPILOT' ? 'red' : ov.executionMode === 'APPROVAL' ? 'blue' : 'gray');

  if (!ov.connected) {
    panel.innerHTML = `<div class="empty-state">${E(ov.message || 'اربط حساب Meta Ads من صفحة AI Intelligence الأول.')}</div>`;
    return;
  }
  const k = ov.kpis, st = ov.status;
  panel.innerHTML = `
    <div id="ambHealthMount"></div>
    <div id="ambAttentionMount"></div>

    ${ov.aiSays ? `<div class="card" style="margin-bottom:18px; border-color:var(--accent-dim);">
      <div class="section-title" style="margin-top:0;">🤖 AI Media Buyer بيقول</div>
      <div style="font-size:13.5px; line-height:1.8;">${E(ov.aiSays)}</div>
    </div>` : ''}

    <div class="amb-kpi-grid">
      ${kpi('صرف اليوم', fmtEGP(k.spendToday))}
      ${kpi('إيراد اليوم', fmtEGP(k.revenueToday))}
      ${kpi('صافي ربح اليوم', k.netProfitToday === null ? '—' : fmtEGP(k.netProfitToday), k.netProfitToday === null ? '' : k.netProfitToday >= 0 ? 'pos' : 'neg')}
      ${kpi('متوسط CPA', fmtEGP(k.avgCpa))}
      ${kpi('CPA المسلّم', k.deliveredCpa === null ? '—' : fmtEGP(k.deliveredCpa))}
      ${kpi('ROAS', fmtX(k.roas))}
      ${kpi('حملات نشطة', fmtNum(k.activeCampaigns))}
      ${kpi('إعلانات نشطة', fmtNum(k.activeAds))}
    </div>

    <div class="amb-status-cards">
      <div class="amb-status-card win"><div class="n">${st.winners}</div><div>🟢 رابحة</div></div>
      <div class="amb-status-card mon"><div class="n">${st.needsMonitoring}</div><div>🟡 تحتاج متابعة</div></div>
      <div class="amb-status-card act"><div class="n">${st.needsImmediateAction}</div><div>🔴 تدخل فوري</div></div>
      <div class="amb-status-card scale"><div class="n">${st.scaleOpportunities}</div><div>🚀 فرص توسّع</div></div>
    </div>

    <div id="ambReadinessMount"></div>

    <div class="toolbar">
      <button class="btn" id="ambGoPlan">راجع خطة العمل (${st.pendingCriticalRecs} حرجة)</button>
      <button class="btn secondary" id="ambGoWinners">الأبطال</button>
      <button class="btn secondary" id="ambGoCampaigns">تحليل الحملات</button>
    </div>
  `;
  panel.prepend(windowPicker(() => route()));
  $('ambGoPlan').onclick = () => (location.hash = 'plan');
  $('ambGoWinners').onclick = () => (location.hash = 'winners');
  $('ambGoCampaigns').onclick = () => (location.hash = 'campaigns');

  // Command-center widgets load independently so a slow one never blocks the KPIs.
  loadHealth();
  loadAttention();
  loadReadiness();
}

async function loadHealth() {
  const mount = $('ambHealthMount');
  if (!mount) return;
  try {
    const h = await api.get(`/api/ai-media-buyer/health?window=${state.window}`);
    if (!h.connected) return;
    const cls = h.score >= 80 ? 'pos' : h.score >= 40 ? '' : 'neg';
    const statusBadge = { HEALTHY: 'green', OK: 'blue', NEEDS_ATTENTION: 'yellow', CRITICAL: 'red' }[h.status] || 'gray';
    mount.innerHTML = `<div class="card" style="margin-bottom:16px;">
      <div style="display:flex; align-items:center; gap:16px; flex-wrap:wrap;">
        <div style="font-size:30px; font-weight:800; letter-spacing:-1px;" class="${cls === 'pos' ? '' : ''}"><span style="color:var(--${statusBadge === 'green' ? 'green' : statusBadge === 'red' ? 'red' : statusBadge === 'yellow' ? 'yellow' : 'accent'});">${h.score}</span><span class="faint" style="font-size:16px;">/100</span></div>
        <div>
          <div style="font-weight:700;">صحة حساب AI Media Buyer</div>
          <span class="badge ${statusBadge}">${E(h.statusAr)}</span>
        </div>
        <div style="flex:1;"></div>
        <button class="btn secondary small" id="ambHealthToggle">تفاصيل العوامل</button>
      </div>
      <div style="margin-top:12px; font-size:12.5px;"><b>أهم أسباب النقص:</b>
        <ul style="margin:6px 0 0; padding-inline-start:18px; line-height:1.8;">
          ${h.topReasons.map((t) => `<li>−${t.impact} · ${E(t.label)} — ${E(t.reason)}</li>`).join('')}
        </ul>
      </div>
      <div id="ambHealthFactors" hidden style="margin-top:10px;">
        <table class="data" style="font-size:12px;"><thead><tr><th>العامل</th><th>الوزن</th><th>النتيجة</th><th>السبب</th></tr></thead>
        <tbody>${h.factors.map((f) => `<tr><td>${E(f.label)}</td><td>${f.weight}</td><td>${f.scorePct}%</td><td>${E(f.reason)}</td></tr>`).join('')}</tbody></table>
      </div>
    </div>`;
    $('ambHealthToggle').onclick = () => { const el = $('ambHealthFactors'); el.hidden = !el.hidden; };
  } catch { /* non-fatal */ }
}

const PRI_AR = { P0: 'خسارة فلوس', P1: 'فرصة / بطل', P2: 'تحسين', P3: 'بيانات ناقصة' };
async function loadAttention() {
  const mount = $('ambAttentionMount');
  if (!mount) return;
  try {
    const na = await api.get(`/api/ai-media-buyer/needs-attention?window=${state.window}`);
    if (!na.connected || na.count === 0) {
      mount.innerHTML = `<div class="card" style="margin-bottom:16px;"><div class="section-title" style="margin-top:0;">🎯 محتاج انتباهك</div><div class="faint" style="font-size:12.5px;">مفيش حاجة عاجلة دلوقتي. ✅</div></div>`;
      return;
    }
    mount.innerHTML = `<div class="card" style="margin-bottom:16px; border-color:var(--accent-dim);">
      <div class="section-title" style="margin-top:0;">🎯 محتاج انتباهك <span class="faint" style="font-weight:400; font-size:12px;">(${na.count})</span></div>
      ${na.items.map((it) => `
        <div class="eo-task-row" data-att-tab="${it.cta?.tab || ''}" data-att-rec="${it.cta?.recId || ''}" style="cursor:${it.cta ? 'pointer' : 'default'};">
          <span class="amb-pri ${it.priority}">${it.priority}</span>
          <span class="eo-task-text"><b>${E(it.title)}</b> <span class="faint">— ${E(PRI_AR[it.priority])}</span><br><span class="faint" style="font-size:12px;">${E(it.detail || '')}</span></span>
          <span class="faint" style="font-size:11.5px; white-space:nowrap;">${E(it.action || '')} ›</span>
        </div>`).join('')}
    </div>`;
    mount.querySelectorAll('[data-att-tab]').forEach((row) => {
      row.onclick = () => { if (row.dataset.attTab) location.hash = row.dataset.attTab; };
    });
  } catch { /* non-fatal */ }
}

async function loadReadiness() {
  const mount = $('ambReadinessMount');
  if (!mount) return;
  try {
    const ar = await api.get('/api/ai-media-buyer/autopilot-readiness');
    if (!ar.connected) return;
    mount.innerHTML = `<div class="card" style="margin-bottom:16px;">
      <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
        <div style="font-weight:700;">جاهزية الأوتوبايلوت</div>
        <div style="flex:1; min-width:160px; background:var(--bg-elevated); border-radius:8px; height:12px; overflow:hidden;">
          <div style="height:100%; width:${ar.readinessPct}%; background:var(--accent);"></div>
        </div>
        <div style="font-weight:800;">${ar.readinessPct}%</div>
        <span class="badge ${ar.autopilotEnabled ? 'red' : 'gray'}">${ar.autopilotEnabled ? 'مفعّل ⚠️' : 'مقفول'}</span>
        <button class="btn secondary small" id="ambReadyToggle">المتطلبات</button>
      </div>
      <div class="faint" style="font-size:11.5px; margin-top:6px;">${E(ar.note)}</div>
      <div id="ambReadyList" hidden style="margin-top:10px; font-size:12.5px;">
        ${ar.checklist.map((c) => `<div style="padding:3px 0;"><span style="color:var(--${c.met ? 'green' : 'text-faint'});">${c.met ? '✔' : '○'}</span> ${E(c.label)} <span class="faint">(${E(c.detail)})</span></div>`).join('')}
      </div>
    </div>`;
    $('ambReadyToggle').onclick = () => { const el = $('ambReadyList'); el.hidden = !el.hidden; };
  } catch { /* non-fatal */ }
}
function kpi(label, value, cls = '') {
  return `<div class="amb-kpi"><div class="amb-kpi-label">${E(label)}</div><div class="amb-kpi-value ${cls}">${value}</div></div>`;
}

// ---------------------------------------------------------------------------
// TAB: Products
// ---------------------------------------------------------------------------
async function renderProducts(panel) {
  const [list, catalog] = await Promise.all([
    api.get('/api/ai-media-buyer/products'),
    api.get('/api/ai-media-buyer/catalog-products'),
  ]);
  panel.innerHTML = `
    <div class="toolbar" style="margin-bottom:14px;">
      <button class="btn" id="ambNewProduct">+ منتج جديد</button>
      <select id="ambSeedCatalog" style="max-width:260px;">
        <option value="">— أنشئ من منتج في الكتالوج —</option>
        ${catalog.map((c) => `<option value="${c.id}">${E(c.product_name)}</option>`).join('')}
      </select>
    </div>
    ${list.length === 0 ? '<div class="empty-state">مفيش منتجات في AI Media Buyer لسه. اربط كل حملة بمنتج عشان يحسب الربحية الحقيقية.</div>' : `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>المنتج</th><th>التكلفة</th><th>مضاعف</th><th>سعر البيع</th><th>Break-even CPA</th><th>Target CPA</th><th>حملات</th><th></th></tr></thead>
        <tbody>${list.map(productRow).join('')}</tbody>
      </table></div>`}
  `;
  $('ambNewProduct').onclick = () => openProductEditor(null);
  $('ambSeedCatalog').onchange = async (e) => {
    if (!e.target.value) return;
    try {
      await api.post(`/api/ai-media-buyer/products/from-catalog/${e.target.value}`, {});
      UI.toast('✅ اتنشأ منتج من الكتالوج');
      route();
    } catch (err) { UI.toast(err.message, 'error'); }
  };
  panel.querySelectorAll('[data-prod]').forEach((b) => {
    b.onclick = () => (b.dataset.act === 'edit' ? openProductEditor(Number(b.dataset.prod)) : openProductDashboard(Number(b.dataset.prod)));
  });
}
function productRow(p) {
  return `<tr>
    <td><b>${E(p.productName)}</b>${p.linkedProductName ? `<div class="faint" style="font-size:11px;">↔ ${E(p.linkedProductName)}</div>` : ''}</td>
    <td>${fmtEGP(p.productCost)}</td>
    <td>${fmtNum(p.pricingMultiplier, 2)}</td>
    <td>${fmtEGP(p.effectiveSellingPrice)}${p.actualSellingPrice ? ' <span class="faint">(يدوي)</span>' : ''}</td>
    <td>${fmtEGP((p.effectiveSellingPrice || 0) - (p.productCost || 0) - (p.packagingCost || 0) - (p.shippingCost || 0) - (p.otherCost || 0))}</td>
    <td>${fmtEGP(p.targetCpa)}</td>
    <td>${p.mappedCampaignCount}</td>
    <td style="white-space:nowrap;">
      <button class="btn secondary small" data-prod="${p.id}" data-act="dash">تحليل</button>
      <button class="btn secondary small" data-prod="${p.id}" data-act="edit">تعديل</button>
    </td>
  </tr>`;
}

const PFIELDS = [
  ['product_name', 'اسم المنتج', 'text'], ['external_product_ref', 'Product ID (اختياري)', 'text'],
  ['product_cost', 'تكلفة المنتج', 'number'], ['pricing_multiplier', 'مضاعف التسعير', 'number'],
  ['actual_selling_price', 'سعر البيع الفعلي (تجاوز يدوي)', 'number'],
  ['packaging_cost', 'تكلفة التغليف', 'number'], ['shipping_cost', 'تكلفة الشحن', 'number'],
  ['other_cost', 'تكاليف أخرى', 'number'], ['rto_cost', 'تكلفة المرتجع / RTO', 'number'],
  ['confirmation_rate', 'نسبة التأكيد (0-1)', 'number'], ['delivery_rate', 'نسبة التسليم (0-1)', 'number'],
  ['target_cpa', 'Target CPA', 'number'], ['warning_cpa', 'Warning CPA', 'number'], ['max_cpa', 'أقصى CPA مسموح', 'number'],
  ['target_profit', 'الربح المستهدف', 'number'], ['min_profit', 'أدنى ربح', 'number'], ['currency', 'العملة', 'text'],
];

async function openProductEditor(id) {
  let p = { pricing_multiplier: 3, currency: 'EGP' };
  if (id) p = await api.get(`/api/ai-media-buyer/products/${id}`).then((r) => ({
    ...r.product,
    // map serialized camelCase back to snake for the form
    product_name: r.product.productName, external_product_ref: r.product.externalProductRef,
    product_cost: r.product.productCost, pricing_multiplier: r.product.pricingMultiplier,
    actual_selling_price: r.product.actualSellingPrice, packaging_cost: r.product.packagingCost,
    shipping_cost: r.product.shippingCost, other_cost: r.product.otherCost, rto_cost: r.product.rtoCost,
    confirmation_rate: r.product.confirmationRate, delivery_rate: r.product.deliveryRate,
    target_cpa: r.product.targetCpa, warning_cpa: r.product.warningCpa, max_cpa: r.product.maxCpa,
    target_profit: r.product.targetProfit, min_profit: r.product.minProfit, currency: r.product.currency,
  }));
  openDrawer(`
    <div class="drawer-header"><div class="drawer-title">${id ? 'تعديل منتج' : 'منتج جديد'}</div><button class="drawer-close" id="ambDrawerX">×</button></div>
    <div class="drawer-section">
      <div class="amb-field-grid">
        ${PFIELDS.map(([f, label, type]) => `
          <div class="field"><label>${E(label)}</label>
            <input type="${type}" data-f="${f}" value="${p[f] ?? ''}" ${type === 'number' ? 'step="any"' : ''} />
          </div>`).join('')}
      </div>
      <div class="amb-derived" id="ambPricePreview" style="margin-top:14px;"></div>
      <div class="toolbar" style="margin-top:16px;">
        <button class="btn" id="ambSaveProduct">حفظ</button>
        ${id && state.isAdmin ? `<button class="btn danger" id="ambDelProduct">حذف</button>` : ''}
        <button class="btn secondary" id="ambCancelProduct">إلغاء</button>
      </div>
    </div>
  `);
  const readForm = () => {
    const o = {};
    $('ambDrawerPanel').querySelectorAll('[data-f]').forEach((el) => {
      const v = el.value.trim();
      o[el.dataset.f] = v === '' ? null : el.type === 'number' ? Number(v) : v;
    });
    return o;
  };
  const updatePreview = () => {
    const o = readForm();
    const sp = o.actual_selling_price || (Number(o.product_cost || 0) * Number(o.pricing_multiplier || 0));
    const base = Number(o.product_cost || 0) + Number(o.packaging_cost || 0) + Number(o.shipping_cost || 0) + Number(o.other_cost || 0);
    const be = sp - base;
    let cod = null;
    if (o.confirmation_rate != null && o.delivery_rate != null) {
      const gp = sp - base;
      cod = (o.confirmation_rate * o.delivery_rate) * gp - (o.confirmation_rate * (1 - o.delivery_rate)) * Number(o.rto_cost || 0);
    }
    $('ambPricePreview').innerHTML = `
      <div class="amb-derived-row"><span>السعر المقترح (تكلفة × مضاعف)</span><b>${fmtEGP(Number(o.product_cost || 0) * Number(o.pricing_multiplier || 0))}</b></div>
      <div class="amb-derived-row"><span>السعر المستخدم في الحساب</span><b>${fmtEGP(sp)}</b></div>
      <div class="amb-derived-row"><span>التكلفة التشغيلية الأساسية</span><b>${fmtEGP(base)}</b></div>
      <div class="amb-derived-row"><span>ربح إجمالي قبل الإعلانات</span><b>${fmtEGP(sp - base)}</b></div>
      <div class="amb-derived-row"><span>Break-even CPA (أساسي)</span><b>${fmtEGP(be)}</b></div>
      <div class="amb-derived-row"><span>Break-even CPA (معدّل COD)</span><b>${cod === null ? '— (ضيف نسبة التأكيد/التسليم)' : fmtEGP(cod)}</b></div>`;
  };
  $('ambDrawerPanel').querySelectorAll('[data-f]').forEach((el) => el.addEventListener('input', updatePreview));
  updatePreview();
  $('ambDrawerX').onclick = closeDrawer;
  $('ambCancelProduct').onclick = closeDrawer;
  $('ambSaveProduct').onclick = async () => {
    try {
      const body = readForm();
      if (id) await api.patch(`/api/ai-media-buyer/products/${id}`, body);
      else await api.post('/api/ai-media-buyer/products', body);
      UI.toast('✅ اتحفظ');
      closeDrawer();
      route();
    } catch (err) { UI.toast(err.message, 'error'); }
  };
  if ($('ambDelProduct')) $('ambDelProduct').onclick = async () => {
    if (!(await UI.confirmModal({ title: 'حذف المنتج', message: 'هيتحذف من AI Media Buyer (مش من الكتالوج). متابعة؟', danger: true, confirmLabel: 'حذف' }))) return;
    await api.delete(`/api/ai-media-buyer/products/${id}`);
    UI.toast('اتحذف');
    closeDrawer();
    route();
  };
}

async function openProductDashboard(id) {
  openDrawer('<div class="drawer-section faint">جارِ التحميل…</div>');
  const d = await api.get(`/api/ai-media-buyer/products/${id}?window=${state.window}`);
  const m = d.metrics, e = d.economics, cls = d.classification;
  const clsBadge = { WINNING: 'green', PROFITABLE: 'green', BREAK_EVEN: 'gray', AT_RISK: 'yellow', LOSING: 'red', NO_DATA: 'gray' }[cls.label] || 'gray';
  openDrawer(`
    <div class="drawer-header"><div class="drawer-title">${E(d.product.productName)}</div><button class="drawer-close" id="ambDrawerX">×</button></div>
    <div class="drawer-section">
      <span class="badge ${clsBadge}">${E({ WINNING: 'منتج رابح', PROFITABLE: 'مربح', BREAK_EVEN: 'تعادل', AT_RISK: 'في خطر', LOSING: 'خاسر', NO_DATA: 'بيانات ناقصة' }[cls.label] || cls.label)}</span>
      <div class="faint" style="font-size:12.5px; margin:8px 0 14px;">${E(cls.reason)} · نافذة: ${E(d.window.label)}</div>
      <div class="amb-derived">
        <div class="amb-derived-row"><span>إجمالي الصرف</span><b>${fmtEGP(m.totalSpend)}</b></div>
        <div class="amb-derived-row"><span>مشتريات Meta</span><b>${fmtNum(m.metaPurchases)}</b></div>
        <div class="amb-derived-row"><span>أوردرات مؤكدة</span><b>${fmtNum(m.confirmedOrders)}</b></div>
        <div class="amb-derived-row"><span>أوردرات مسلّمة</span><b>${fmtNum(m.deliveredOrders)}</b></div>
        <div class="amb-derived-row"><span>إيراد</span><b>${fmtEGP(m.revenue)}</b></div>
        <div class="amb-derived-row"><span>متوسط CPA</span><b>${fmtEGP(m.avgCpa)}</b></div>
        <div class="amb-derived-row"><span>Confirmed CPA</span><b>${fmtEGP(m.confirmedCpa)}</b></div>
        <div class="amb-derived-row"><span>Delivered CPA</span><b>${fmtEGP(m.deliveredCpa)}</b></div>
        <div class="amb-derived-row"><span>ROAS</span><b>${fmtX(m.roas)}</b></div>
      </div>
      <div class="section-title">صافي الربح (${E(d.cod.source === 'none' ? 'مفيش بيانات تسليم' : d.cod.source)})</div>
      <div class="amb-derived">
        <div class="amb-derived-row"><span>الإيراد</span><b>${fmtEGP(m.pnl.revenue)}</b></div>
        <div class="amb-derived-row"><span>صرف الإعلانات</span><b>${fmtEGP(m.pnl.adSpend)}</b></div>
        <div class="amb-derived-row"><span>تكلفة البضاعة (COGS)</span><b>${fmtEGP(m.pnl.cogs)}</b></div>
        <div class="amb-derived-row"><span>شحن</span><b>${fmtEGP(m.pnl.shipping)}</b></div>
        <div class="amb-derived-row"><span>تغليف</span><b>${fmtEGP(m.pnl.packaging)}</b></div>
        <div class="amb-derived-row"><span>تكلفة المرتجع</span><b>${fmtEGP(m.pnl.rtoCost)}</b></div>
        <div class="amb-derived-row"><span>تكاليف أخرى</span><b>${fmtEGP(m.pnl.otherCost)}</b></div>
        <div class="amb-derived-row" style="border-top:1px solid var(--border); margin-top:4px; padding-top:8px;"><span><b>صافي الربح</b></span><b class="${(m.netProfit ?? 0) >= 0 ? '' : ''}" style="color:${(m.netProfit ?? 0) >= 0 ? 'var(--green)' : 'var(--red)'};">${fmtEGP(m.netProfit)} (${fmtPct(m.netMarginPct)})</b></div>
      </div>
      <div class="section-title">أفضل عنصر داخل المنتج</div>
      ${['campaign', 'adset', 'ad', 'creative'].map((lvl) => {
        const b = d.bests[lvl];
        const arLvl = { campaign: 'حملة', adset: 'مجموعة', ad: 'إعلان', creative: 'كرييتف' }[lvl];
        return b ? `<div class="amb-winner-card"><span class="amb-winner-trophy">🏆</span><div class="amb-winner-body"><div class="amb-winner-name">${arLvl}: ${E(b.name)}</div><div class="amb-winner-meta">CPA ${fmtEGP(b.cpa)} · ${fmtNum(b.purchases)} شراء · ROAS ${fmtX(b.roas)}</div></div></div>` : `<div class="faint" style="font-size:12px;">${arLvl}: مفيش بيانات كافية</div>`;
      }).join('')}
      ${d.observedRates.confirmationRate != null ? `<div class="faint" style="font-size:12px; margin-top:12px;">نِسب مرصودة من البيانات الحقيقية: تأكيد ${fmtPct(d.observedRates.confirmationRate * 100)} · تسليم ${fmtPct(d.observedRates.deliveryRate * 100)} (عيّنة ${d.observedRates.sample})</div>` : ''}
      <div class="toolbar" style="margin-top:14px;"><button class="btn secondary" id="ambDrawerX2">إغلاق</button></div>
    </div>
  `);
  $('ambDrawerX').onclick = closeDrawer;
  $('ambDrawerX2').onclick = closeDrawer;
}

// ---------------------------------------------------------------------------
// TAB: Campaign Analysis (hierarchy) + inline mapping
// ---------------------------------------------------------------------------
async function renderCampaigns(panel) {
  panel.innerHTML = '';
  panel.appendChild(windowPicker(() => route()));
  const [tree, mapState, products] = await Promise.all([
    api.get(`/api/ai-media-buyer/hierarchy?window=${state.window}`),
    api.get('/api/ai-media-buyer/mapping').catch(() => null),
    api.get('/api/ai-media-buyer/products').catch(() => []),
  ]);

  const acct = tree.accountAvg;
  const head = document.createElement('div');
  head.innerHTML = `<div class="faint" style="font-size:12.5px; margin-bottom:12px;">
    متوسط الحساب — صرف ${fmtEGP(acct?.spend)} · CPA ${fmtEGP(acct?.cpa)} · ROAS ${fmtX(acct?.roas)} · CTR ${fmtPct(acct?.ctr)}
  </div>
  <div class="faint" style="font-size:12px; margin-bottom:14px;">
    🟢 رابح/مربح · 🟡 تحسين · 🔴 خسارة/مرشح إيقاف · 🔵 فرصة توسّع · ⚪ محتاج بيانات
  </div>`;
  panel.appendChild(head);

  if (mapState && mapState.counts) {
    const mm = document.createElement('div');
    mm.className = 'card';
    mm.style.marginBottom = '16px';
    mm.innerHTML = `<div class="section-title" style="margin-top:0;">ربط الحملات بالمنتجات</div>
      <div class="faint" style="font-size:12px; margin-bottom:8px;">مربوط ${mapState.counts.mapped} · مقترح ${mapState.counts.suggested} · غير مربوط ${mapState.counts.unmapped}</div>
      ${mapState.unmapped.slice(0, 8).map((c) => `
        <div class="eo-task-row">
          <span class="eo-task-text">${E(c.campaignName || c.campaignId)} <span class="faint">(${fmtEGP(c.spend)})</span>${c.suggestion ? ` — مقترح: <b>${E(c.suggestion.productName || '')}</b>` : ''}</span>
          <select data-map-campaign="${E(c.campaignId)}" data-map-name="${E(c.campaignName || '')}" style="max-width:180px;">
            <option value="">— اختر منتج —</option>
            ${products.map((p) => `<option value="${p.id}" ${c.suggestion && c.suggestion.ambProductId === p.id ? 'selected' : ''}>${E(p.productName)}</option>`).join('')}
          </select>
        </div>`).join('') || '<div class="faint" style="font-size:12px;">كل الحملات النشطة مربوطة ✅</div>'}`;
    panel.appendChild(mm);
    mm.querySelectorAll('[data-map-campaign]').forEach((sel) => {
      sel.onchange = async () => {
        if (!sel.value) return;
        try {
          await api.post('/api/ai-media-buyer/mapping', { campaignId: sel.dataset.mapCampaign, campaignName: sel.dataset.mapName, ambProductId: Number(sel.value) });
          UI.toast('✅ اتربطت'); route();
        } catch (err) { UI.toast(err.message, 'error'); }
      };
    });
  }

  const treeWrap = document.createElement('div');
  const groups = [];
  for (const p of tree.products || []) groups.push({ title: `📦 ${p.name}`, node: p, children: p.children });
  if ((tree.unmappedCampaigns || []).length) groups.push({ title: '— حملات غير مربوطة بمنتج —', node: null, children: tree.unmappedCampaigns });

  treeWrap.innerHTML = groups.map((g) => `
    <div style="margin-bottom:18px;">
      <div class="section-title">${E(g.title)} ${g.node ? statusDot(g.node.status) : ''} ${g.node && g.node.metrics ? `<span class="faint" style="font-weight:400;font-size:12px;">CPA ${fmtEGP(g.node.metrics.cpa)} · صرف ${fmtEGP(g.node.metrics.spend)}</span>` : ''}</div>
      ${(g.children || []).map((c) => treeNode(c, 0)).join('') || '<div class="faint" style="font-size:12px;">مفيش حملات نشطة.</div>'}
    </div>`).join('');
  panel.appendChild(treeWrap);
  wireTree(treeWrap);
}

function statusDot(s) {
  if (!s) return '';
  const ar = { HEALTHY: 'سليم', OPTIMIZE: 'تحسين', LOSS: 'خسارة', STOP_CANDIDATE: 'مرشح إيقاف', WATCH: 'مراقبة', SCALE_OPPORTUNITY: 'فرصة توسّع', NEED_MORE_DATA: 'محتاج بيانات' }[s.verdict] || s.verdict;
  return `<span class="amb-dot ${s.color}" title="${E(ar)}"></span>`;
}

function treeNode(node, depth) {
  const m = node.metrics || {};
  const hasKids = (node.children && node.children.length) || (node.creatives && node.creatives.length);
  const lvlAr = { campaign: 'حملة', adset: 'مجموعة', ad: 'إعلان', creative: 'كرييتف' }[node.level] || node.level;
  return `<div class="amb-tree-node">
    <div class="amb-tree-row" data-node-toggle="${hasKids ? '1' : '0'}">
      <span class="amb-tree-caret">${hasKids ? '▶' : ''}</span>
      ${statusDot(node.status)}
      <span class="amb-tree-name" title="${E(node.name)}"><span class="faint" style="font-size:11px;">${E(lvlAr)}</span> ${E(node.name)}</span>
      <span class="amb-tree-metrics">
        <span>صرف <b>${fmtEGP(m.spend)}</b></span>
        <span>شراء <b>${fmtNum(m.purchases)}</b></span>
        <span>CPA <b>${fmtEGP(m.cpa)}</b></span>
        <span>ROAS <b>${fmtX(m.roas)}</b></span>
        ${node.budget != null ? `<span>ميزانية <b>${fmtEGP(node.budget)}</b></span>` : ''}
      </span>
    </div>
    ${hasKids ? `<div class="amb-tree-children">
      ${(node.children || []).map((c) => treeNode(c, depth + 1)).join('')}
      ${(node.creatives || []).length ? `<div class="faint" style="font-size:11px; margin:6px 0;">كرييتيفز:</div>${node.creatives.map((c) => treeNode(c, depth + 1)).join('')}` : ''}
    </div>` : ''}
  </div>`;
}
function wireTree(root) {
  root.querySelectorAll('[data-node-toggle="1"]').forEach((row) => {
    row.onclick = () => {
      const kids = row.parentElement.querySelector('.amb-tree-children');
      const caret = row.querySelector('.amb-tree-caret');
      if (!kids) return;
      const open = kids.classList.toggle('open');
      caret.classList.toggle('open', open);
    };
  });
}

// ---------------------------------------------------------------------------
// TAB: Winners
// ---------------------------------------------------------------------------
async function renderWinners(panel) {
  panel.innerHTML = '';
  panel.appendChild(windowPicker(() => route()));
  const w = await api.get(`/api/ai-media-buyer/winners?window=${state.window}`);
  const wn = w.winners;
  const cov = w.coverage || { analyzed: 0, notAnalyzed: 0, insufficientData: 0, total: 0 };

  // Full-panel winner card (spec section 5).
  const bigCard = (icon, label, node) => node
    ? `<div class="amb-winner-card" style="align-items:flex-start;"><span class="amb-winner-trophy">${icon}</span><div class="amb-winner-body">
        <div class="amb-winner-name">${E(label)}: ${E(node.name || node.label)}</div>
        <div class="amb-rec-metrics" style="margin:6px 0;">
          <span>صرف <b>${fmtEGP(node.spend)}</b></span>
          <span>شراء <b>${fmtNum(node.purchases)}</b></span>
          <span>CPA <b>${fmtEGP(node.cpa)}</b></span>
          ${node.deliveredCpa != null ? `<span>CPA مسلّم <b>${fmtEGP(node.deliveredCpa)}</b> <span class="faint">(${E(node.deliveredCpaScope || '')})</span></span>` : ''}
          <span>CTR <b>${fmtPct(node.ctr)}</b></span>
          <span>CPC <b>${fmtEGP(node.cpc)}</b></span>
          <span>CVR <b>${fmtPct(node.conversionRate)}</b></span>
          <span>ROAS <b>${fmtX(node.roas)}</b></span>
          ${node.netProfit != null ? `<span>صافي ربح <b>${fmtEGP(node.netProfit)}</b> <span class="faint">(${E(node.netProfitScope || '')})</span></span>` : ''}
          <span>كفاية بيانات <b>${E({ STRONG: 'قوية', MODERATE: 'كافية', WEAK: 'ضعيفة' }[node.dataSufficiency] || node.dataSufficiency)}</b></span>
          <span>ثقة <b>${E(node.confidence)}</b></span>
        </div>
        <div style="font-size:12.5px;">✅ <b>ليه هو البطل:</b> ${E(node.why || '—')}</div>
      </div></div>`
    : `<div class="faint" style="font-size:12.5px; padding:6px 0;">${E(label)}: لسه مفيش عنصر بيحقق شروط "البطل" (صرف كافٍ + حجم + CPA تحت الهدف + كفاية بيانات).</div>`;

  panel.insertAdjacentHTML('beforeend', `
    <div class="card" style="margin-bottom:14px; display:flex; gap:18px; flex-wrap:wrap; align-items:center;">
      <div class="section-title" style="margin:0;">تحليل الكرييتيفات:</div>
      <span class="badge green">مُحلَّل ${cov.analyzed}</span>
      <span class="badge yellow">بيانات غير كافية ${cov.insufficientData}</span>
      <span class="badge gray">غير مُحلَّل ${cov.notAnalyzed}</span>
      <span class="faint" style="font-size:12px;">من إجمالي ${cov.total} كرييتف</span>
      <div style="flex:1;"></div>
      <button class="btn secondary small" id="ambRunCreative">حلّل الكرييتيفات الباقية</button>
    </div>
    <div class="card" style="margin-bottom:16px;">
      <div class="section-title" style="margin-top:0;">🏆 الأبطال — نافذة ${E(w.window.label)}</div>
      ${bigCard('🥇', 'المنتج', wn.product)}
      ${bigCard('🚀', 'الحملة', wn.campaign)}
      ${bigCard('🎯', 'المجموعة الإعلانية', wn.adset)}
      ${bigCard('📢', 'الإعلان', wn.ad)}
      ${bigCard('🎨', 'الكرييتف', wn.creative)}
      ${labelWinnerLine('🪝 الهوك', wn.hook)}
      ${labelWinnerLine('📐 زاوية البيع', wn.sellingAngle)}
      ${labelWinnerLine('🎁 العرض', wn.offer)}
      ${labelWinnerLine('👥 زاوية الجمهور', wn.audienceAngle)}
    </div>
    ${labelTable('🪝 مقارنة الهوكس', w.hooks)}
    ${labelTable('📐 مقارنة زوايا البيع', w.angles)}
    ${labelTable('🎁 مقارنة العروض', w.offers)}
    ${labelTable('👥 مقارنة زوايا الجمهور', w.audiences)}
  `);
  $('ambRunCreative').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = '… بيحلل';
    try { const r = await api.post('/api/ai-media-buyer/creative-analysis/run', { max: 25 }); UI.toast(`✅ اتحلل ${r.analyzed} كرييتف (${r.insufficient} غير كافٍ)`); route(); }
    catch (err) { UI.toast(err.message, 'error'); e.target.disabled = false; e.target.textContent = 'حلّل الكرييتيفات الباقية'; }
  };
}
function labelWinnerLine(label, w) {
  if (!w) return `<div class="faint" style="font-size:12.5px; padding:6px 0;">${E(label)}: لسه مفيش بطل واضح (البيانات مش كافية أو الكرييتيفات مش متحللة).</div>`;
  return `<div class="amb-winner-card"><span class="amb-winner-trophy">🏆</span><div class="amb-winner-body">
    <div class="amb-winner-name">${E(label)}: ${E(w.label)}</div>
    <div class="amb-winner-meta">CPA ${fmtEGP(w.cpa)} · ${fmtNum(w.purchases)} شراء · CTR ${fmtPct(w.ctr)} · مصدر: ${w.source === 'CREATIVE_ANALYSIS' ? 'تحليل الكرييتف' : 'اسم الإعلان'}</div>
    <div style="font-size:12px; margin-top:3px;">${E(w.why || '')}</div>
  </div></div>`;
}
function labelTable(title, group) {
  if (!group || !group.table || group.table.length === 0) {
    return `<div class="card" style="margin-bottom:16px;"><div class="section-title" style="margin-top:0;">${E(title)}</div>
      <div class="faint" style="font-size:12.5px;">لسه مفيش تصنيفات كفاية للمقارنة — شغّل تحليل الكرييتيفات أو استنى بيانات أكتر.</div></div>`;
  }
  return `<div class="card" style="margin-bottom:16px;"><div class="section-title" style="margin-top:0;">${E(title)} ${group.winner ? `— البطل: <b>${E(group.winner.label)}</b>` : ''}</div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>التصنيف</th><th>مصدر</th><th>إعلانات</th><th>صرف</th><th>شراء</th><th>CPA</th><th>CTR</th><th>CVR</th><th>كفاية بيانات</th></tr></thead>
      <tbody>${group.table.map((r) => `<tr ${group.winner && r.label === group.winner.label ? 'style="background:var(--green-bg);"' : ''}>
        <td>${E(r.label)}</td><td class="faint">${r.source === 'CREATIVE_ANALYSIS' ? 'كرييتف' : 'اسم'}</td><td>${fmtNum(r.adCount)}</td><td>${fmtEGP(r.spend)}</td><td>${fmtNum(r.purchases)}</td><td>${fmtEGP(r.cpa)}</td><td>${fmtPct(r.ctr)}</td><td>${fmtPct(r.conversionRate)}</td><td>${E({ STRONG: 'قوية', MODERATE: 'كافية', WEAK: 'ضعيفة' }[r.dataSufficiency] || '')}</td>
      </tr>`).join('')}</tbody>
    </table></div></div>`;
}

// ---------------------------------------------------------------------------
// TAB: AI Action Plan
// ---------------------------------------------------------------------------
async function renderPlan(panel) {
  const cur = await api.get('/api/ai-media-buyer/recommendations');
  const active = cur.active || cur.items || [];
  const resolved = cur.resolved || [];
  const CATS = [
    { key: 'SCALE', label: '🚀 توسّع (SCALE)' },
    { key: 'HOLD', label: '🟢 تثبيت (HOLD)' },
    { key: 'MONITOR', label: '🟡 مراقبة (MONITOR)' },
    { key: 'PAUSE_CANDIDATE', label: '🔴 مرشّح للإيقاف (PAUSE CANDIDATE)' },
    { key: 'NEW_CREATIVE_NEEDED', label: '🎨 كرييتف جديد مطلوب' },
  ];
  const byCat = {};
  for (const it of active) (byCat[it.category] = byCat[it.category] || []).push(it);
  const extResolved = resolved.filter((r) => ['RESOLVED_EXTERNALLY', 'NO_LONGER_APPLICABLE'].includes(r.status));

  panel.innerHTML = `
    <div class="toolbar" style="margin-bottom:14px;">
      <button class="btn" id="ambGenPlan">🔄 توليد خطة جديدة</button>
      <button class="btn secondary" id="ambReconcile">↻ طابق مع حالة Meta</button>
      ${cur.generatedAt ? `<span class="faint" style="font-size:12px;">آخر توليد: ${fmtDT(cur.generatedAt)}</span>` : ''}
    </div>
    ${active.length === 0 ? `<div class="empty-state">مفيش توصيات نشطة محتاجة إجراء دلوقتي.${resolved.length ? ' (فيه توصيات محلولة تحت)' : ' اضغط "توليد خطة جديدة".'}</div>` : CATS.map((c) => {
      const list = (byCat[c.key] || []).sort((a, b) => a.priority.localeCompare(b.priority));
      if (!list.length) return '';
      return `<div style="margin-bottom:20px;"><div class="section-title">${E(c.label)} <span class="faint" style="font-weight:400;font-size:12px;">(${list.length})</span></div>${list.map(recCard).join('')}</div>`;
    }).join('')}
    ${extResolved.length ? `<div style="margin-top:8px;">
      <button class="btn secondary small" id="ambToggleResolved">توصيات محلولة / خارج النطاق (${extResolved.length}) ▾</button>
      <div id="ambResolvedList" hidden style="margin-top:10px;">${extResolved.map(resolvedCard).join('')}</div>
    </div>` : ''}
  `;
  const rc = $('ambReconcile');
  if (rc) rc.onclick = async () => {
    rc.disabled = true; rc.textContent = '… بيطابق';
    try {
      const r = await api.post('/api/ai-media-buyer/recommendations/reconcile', {});
      UI.toast(r.resolvedExternally + r.noLongerApplicable > 0 ? `✅ اتحلّت ${r.resolvedExternally} + ${r.noLongerApplicable} خارج النطاق` : 'كل التوصيات لسه منطبقة');
      route();
    } catch (err) { UI.toast(err.message, 'error'); rc.disabled = false; rc.textContent = '↻ طابق مع حالة Meta'; }
  };
  const tr = $('ambToggleResolved');
  if (tr) tr.onclick = () => { const el = $('ambResolvedList'); el.hidden = !el.hidden; };
  $('ambGenPlan').onclick = async () => {
    const btn = $('ambGenPlan'); btn.disabled = true; btn.textContent = '… بيحلل';
    try {
      const r = await api.post('/api/ai-media-buyer/recommendations/generate', { window: state.window });
      UI.toast(`✅ ${r.count} توصية (${r.source === 'AI' ? 'تحليل Claude' : 'قوالب احتياطية'})`);
      route();
    } catch (err) { UI.toast(err.message, 'error'); btn.disabled = false; btn.textContent = '🔄 توليد خطة جديدة'; }
  };
  panel.querySelectorAll('[data-rec]').forEach((b) => {
    const id = Number(b.dataset.rec);
    if (b.dataset.act === 'approve') b.onclick = () => approveRec(id, b);
    if (b.dataset.act === 'reject') b.onclick = () => rejectRec(id);
    if (b.dataset.act === 'edit') b.onclick = () => editRec(id);
    if (b.dataset.act === 'details') b.onclick = () => showRecDetails(id);
    if (b.dataset.act === 'dryrun') b.onclick = () => dryRunRec(id);
  });
}

const DECISION_AR = {
  SCALE: 'توسّع', HOLD: 'تثبيت', MONITOR: 'مراقبة', PAUSE: 'إيقاف', PAUSE_LOSER: 'إيقاف خاسر',
  REDUCE_BUDGET: 'تقليل ميزانية', INCREASE_BUDGET: 'زيادة ميزانية', DUPLICATE_WINNER: 'تكرار البطل',
  TEST_NEW_CREATIVE: 'اختبار كرييتف جديد', TEST_NEW_HOOK: 'اختبار هوك جديد', TEST_NEW_AUDIENCE: 'اختبار جمهور جديد',
};
const STATUS_AR = {
  PENDING: '', APPROVED: 'موافَق عليها', REJECTED: 'مرفوضة', EXECUTED: '✅ اتنفّذت',
  SUPERSEDED: 'محدّثة', NEEDS_REANALYSIS: '⚠️ محتاجة إعادة تحليل', EXPIRED: 'منتهية',
  RESOLVED_EXTERNALLY: '✔ اتحلّت من Meta', NO_LONGER_APPLICABLE: 'خارج النطاق',
};
const STATUS_BADGE = { EXECUTED: 'green', RESOLVED_EXTERNALLY: 'green', NEEDS_REANALYSIS: 'red', NO_LONGER_APPLICABLE: 'gray' };
const META_STATUS_AR = { ACTIVE: 'شغّال', PAUSED: 'متوقف', CAMPAIGN_PAUSED: 'الحملة متوقفة', ADSET_PAUSED: 'المجموعة متوقفة', ARCHIVED: 'مؤرشف', DELETED: 'محذوف', DISAPPROVED: 'مرفوض', PENDING_REVIEW: 'تحت المراجعة', IN_PROCESS: 'قيد التجهيز', WITH_ISSUES: 'به مشاكل' };

function resolvedCard(r) {
  return `<div class="amb-rec" style="border-inline-start-color:var(--gray); opacity:.9;">
    <div class="amb-rec-head">
      <span class="amb-pri ${r.priority}">${r.priority}</span>
      <span class="amb-rec-title">${E(DECISION_AR[r.decision] || r.decision)} — ${E(r.entityName || '')}</span>
      <span class="badge ${STATUS_BADGE[r.status] || 'gray'}">${E(STATUS_AR[r.status] || r.status)}</span>
      ${r.currentStatus ? `<span class="faint" style="font-size:12px;">حالة Meta: ${E(META_STATUS_AR[r.currentStatus] || r.currentStatus)}</span>` : ''}
    </div>
    <div style="font-size:12.5px; margin-top:6px;">${E(r.resolutionNote || 'اتحلّت خارج النظام.')}</div>
    <div class="amb-rec-actions"><button class="btn secondary small" data-rec="${r.id}" data-act="details">التفاصيل</button></div>
  </div>`;
}

function recCard(r) {
  const m = r.currentMetrics || {};
  const t = r.targetMetrics || {};
  const canExec = r.executable && r.status === 'PENDING';
  const statusAr = STATUS_AR[r.status] ?? r.status;
  const metaOk = !r.currentStatus || r.currentStatus === 'ACTIVE';
  return `<div class="amb-rec ${r.priority}">
    <div class="amb-rec-head">
      <span class="amb-pri ${r.priority}">${r.priority}</span>
      <span class="amb-rec-title">${E(DECISION_AR[r.decision] || r.decision)} — ${E(r.entityName || '')}</span>
      <span class="badge gray">${E({ product: 'منتج', campaign: 'حملة', adset: 'مجموعة', ad: 'إعلان' }[r.level] || r.level)}</span>
      ${r.productName ? `<span class="faint" style="font-size:12px;">📦 ${E(r.productName)}</span>` : ''}
      ${r.currentStatus ? `<span class="badge ${metaOk ? 'blue' : 'yellow'}" title="حالة العنصر الحالية في Meta">Meta: ${E(META_STATUS_AR[r.currentStatus] || r.currentStatus)}</span>` : ''}
      ${statusAr ? `<span class="badge ${STATUS_BADGE[r.status] || 'gray'}">${E(statusAr)}</span>` : ''}
    </div>
    <div class="amb-rec-metrics">
      <span>CPA حالي <b>${fmtEGP(m.cpa)}</b></span>
      <span>الهدف <b>${fmtEGP(t.targetCpa)}</b></span>
      <span>صرف <b>${fmtEGP(m.spend)}</b></span>
      <span>شراء <b>${fmtNum(m.purchases)}</b></span>
      <span>ROAS <b>${fmtX(m.roas)}</b></span>
      ${r.currentBudget != null ? `<span>ميزانية <b>${fmtEGP(r.currentBudget)}</b> ← <b>${fmtEGP(r.recommendedBudget)}</b> (${r.budgetChangePct > 0 ? '+' : ''}${fmtNum(r.budgetChangePct)}%)</span>` : ''}
    </div>
    ${r.explain ? `<div class="amb-rec-explain" style="margin:8px 0; font-size:12.5px; line-height:1.75;">
      <div><b>إيه اللي حصل؟</b> ${E(r.explain.whatHappened || r.reason || '—')}</div>
      ${r.explain.why ? `<div><b>ليه؟</b> ${E(r.explain.why)}</div>` : ''}
      <div><b>الإجراء المطلوب:</b> ${E(r.explain.whatToDo || '—')}</div>
      ${r.explain.expectedBenefit ? `<div><b>الفايدة المتوقعة:</b> ${E(r.explain.expectedBenefit)}</div>` : ''}
      ${r.explain.risk ? `<div><b>المخاطرة:</b> ${E(r.explain.risk)}</div>` : ''}
      ${r.explain.dataSupport ? `<div><b>دعم البيانات:</b> ${E(r.explain.dataSupport)}</div>` : ''}
    </div>` : `<div class="amb-rec-reason">💬 ${E(r.reason || '—')}</div>`}
    <div class="faint" style="font-size:11.5px;">ثقة: ${E(r.confidence)} · مخاطرة: ${E(r.riskLevel)} · كفاية بيانات: ${E(r.dataSufficiency)} · نافذة: ${E(r.timeWindow?.label || '')} · مصدر: ${r.source === 'AI' ? 'Claude' : 'قالب'}</div>
    <div class="amb-rec-actions">
      ${canExec ? `<button class="btn small" data-rec="${r.id}" data-act="approve">موافقة وتنفيذ</button>` : ''}
      ${canExec ? `<button class="btn secondary small" data-rec="${r.id}" data-act="dryrun">تحقّق من المسار (بدون تنفيذ)</button>` : ''}
      ${r.status === 'PENDING' ? `<button class="btn secondary small" data-rec="${r.id}" data-act="reject">رفض</button>` : ''}
      ${r.status === 'PENDING' && r.currentBudget != null && r.executable ? `<button class="btn secondary small" data-rec="${r.id}" data-act="edit">تعديل الأكشن</button>` : ''}
      <button class="btn secondary small" data-rec="${r.id}" data-act="details">التفاصيل</button>
      ${!r.executable ? `<span class="faint" style="font-size:11.5px; align-self:center;">أكشن مسودة — لازم موافقة يدوية وتنفيذ خارج النظام</span>` : ''}
    </div>
  </div>`;
}

async function dryRunRec(id) {
  openDrawer('<div class="drawer-section faint">بيتحقق من مسار التنفيذ على Meta (بدون أي تغيير)…</div>');
  try {
    const d = await api.get(`/api/ai-media-buyer/recommendations/${id}/dry-run`);
    const verdictAr = { READY: '🟢 جاهز للتنفيذ', WOULD_ABORT_REANALYSIS: '⚠️ هيتوقف — محتاج إعادة تحليل', WOULD_BLOCK_RULES: '🔴 فحص القواعد هيرفض', DRAFT_ONLY: 'مسودة فقط', BLOCKED: '🔴 متوقف' }[d.verdict] || d.verdict;
    openDrawer(`
      <div class="drawer-header"><div class="drawer-title">تحقّق من مسار التنفيذ (Dry Run)</div><button class="drawer-close" id="ambDrawerX">×</button></div>
      <div class="drawer-section">
        <div style="font-weight:700; margin-bottom:8px;">${E(verdictAr)}</div>
        ${d.note ? `<div class="faint" style="font-size:12.5px; margin-bottom:8px;">${E(d.note)}</div>` : ''}
        <div class="amb-derived">
          <div class="amb-derived-row"><span>وصول لـ Meta</span><b>${d.canReachMeta ? 'نعم ✅' : 'لا'}</b></div>
          ${d.live ? `<div class="amb-derived-row"><span>حالة العنصر الحيّة</span><b>${E(d.live.status || '—')}</b></div>` : ''}
          ${d.live && d.live.budgetMajor != null ? `<div class="amb-derived-row"><span>الميزانية الحيّة</span><b>${fmtEGP(d.live.budgetMajor)} (${E(d.live.budgetType || '')})</b></div>` : ''}
          ${d.materiality ? `<div class="amb-derived-row"><span>تغيّر مؤثر منذ التوصية؟</span><b>${d.materiality.material ? 'نعم — إعادة تحليل' : 'لا'}</b></div>` : ''}
          ${d.revalidation ? `<div class="amb-derived-row"><span>إعادة التحقّق من القواعد</span><b>${d.revalidation.passed ? 'نجحت ✅' : 'رفضت ❌'}</b></div>` : ''}
        </div>
        ${d.plannedRequest ? `<div class="section-title">الطلب اللي هيتبعت لـ Meta (لو وافقت)</div>
          <pre style="white-space:pre-wrap; font-size:11.5px; background:var(--bg-elevated); padding:10px; border-radius:8px;">${E(d.plannedRequest.endpoint)}\n${E(JSON.stringify(d.plannedRequest.body, null, 1))}${d.plannedRequest.humanReadable ? '\n// ' + E(d.plannedRequest.humanReadable) : ''}</pre>` : ''}
        ${d.revalidation ? `<div class="section-title">فحوصات القواعد</div><div class="amb-rec-checks">${(d.revalidation.checks || []).map((c) => `<div class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✔' : '✖'} ${E(c.name)} — ${E(c.detail)}</div>`).join('')}</div>` : ''}
        <div class="faint" style="font-size:11.5px; margin-top:10px;">مفيش أي حاجة اتبعتت لـ Meta. ده تحقّق فقط.</div>
        <div class="toolbar" style="margin-top:12px;"><button class="btn secondary" id="ambDrawerX2">إغلاق</button></div>
      </div>`);
    $('ambDrawerX').onclick = closeDrawer;
    $('ambDrawerX2').onclick = closeDrawer;
  } catch (err) {
    openDrawer(`<div class="drawer-section"><div class="empty-state">⚠️ ${E(err.message)}</div><button class="btn secondary" id="ambDrawerX2">إغلاق</button></div>`);
    $('ambDrawerX2').onclick = closeDrawer;
  }
}

async function approveRec(id, btn) {
  const ok = await UI.confirmModal({
    title: 'موافقة وتنفيذ على Meta',
    message: 'هيتبعت أمر حقيقي لحساب Meta Ads بعد إعادة تحقّق من الأرقام الحالية. متابعة؟',
    confirmLabel: 'نفّذ الآن', danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    const r = await api.post(`/api/ai-media-buyer/recommendations/${id}/approve`, {});
    if (r.ok) UI.toast('✅ اتنفّذ على Meta');
    else if (r.aborted) UI.toast(`⛔ اتوقف: ${r.message}`, 'error');
    else UI.toast(r.message || 'ماتنفّذش', 'error');
    route();
  } catch (err) {
    UI.toast(err.message, 'error');
    btn.disabled = false;
  }
}
async function rejectRec(id) {
  await api.post(`/api/ai-media-buyer/recommendations/${id}/reject`, {});
  UI.toast('اترفضت');
  route();
}
async function editRec(id) {
  const r = await api.get(`/api/ai-media-buyer/recommendations/${id}`);
  const val = prompt(`الميزانية المقترحة الجديدة (الحالية ${fmtEGP(r.currentBudget)}، مسموح ±${20}% لكل أكشن):`, r.recommendedBudget);
  if (val === null) return;
  try {
    await api.patch(`/api/ai-media-buyer/recommendations/${id}`, { recommendedBudget: Number(val) });
    UI.toast('✅ اتعدّل');
    route();
  } catch (err) { UI.toast(err.message, 'error'); }
}
async function showRecDetails(id) {
  const r = await api.get(`/api/ai-media-buyer/recommendations/${id}`);
  const re = r.ruleEngine || {};
  openDrawer(`
    <div class="drawer-header"><div class="drawer-title">تفاصيل التوصية</div><button class="drawer-close" id="ambDrawerX">×</button></div>
    <div class="drawer-section">
      <div style="font-weight:700; margin-bottom:6px;">${E(DECISION_AR[r.decision] || r.decision)} — ${E(r.entityName || '')}</div>
      <div class="faint" style="font-size:12px; margin-bottom:8px;">
        ${E(r.campaignName ? 'حملة: ' + r.campaignName : '')} ${E(r.adsetName ? '· مجموعة: ' + r.adsetName : '')} ${E(r.adName ? '· إعلان: ' + r.adName : '')}
      </div>
      <div style="font-size:12.5px; margin-bottom:8px;">
        الحالة: <span class="badge ${STATUS_BADGE[r.status] || 'gray'}">${E(STATUS_AR[r.status] || r.status || 'PENDING')}</span>
        ${r.currentStatus ? ` · حالة العنصر في Meta وقت التوليد: <b>${E(META_STATUS_AR[r.currentStatus] || r.currentStatus)}</b>` : ''}
      </div>
      ${r.resolutionNote ? `<div class="amb-derived" style="margin-bottom:10px;">📌 ${E(r.resolutionNote)}${r.resolvedAt ? ` <span class="faint">(${fmtDT(r.resolvedAt)})</span>` : ''}</div>` : ''}
      <div class="amb-rec-reason">💬 ${E(r.reason || '—')}</div>
      <div class="section-title">فحص القواعد (Rule Engine)</div>
      <div class="amb-rec-checks">
        ${(re.checks || []).map((c) => `<div class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✔' : '✖'} ${E(c.name)} — ${E(c.detail)}</div>`).join('') || '<div class="faint">مفيش تفاصيل.</div>'}
      </div>
      ${re.blockers && re.blockers.length ? `<div style="margin-top:8px; color:var(--red); font-size:12.5px;">موانع: ${re.blockers.map(E).join(' / ')}</div>` : ''}
      <div class="section-title">الأكشنز</div>
      ${(r.actions || []).map((a) => `<div class="faint" style="font-size:12px;">#${a.id} — ${E(a.status)} — ${fmtDT(a.at)}${a.metaError ? ` — خطأ: ${E(a.metaError)}` : ''}</div>`).join('') || '<div class="faint" style="font-size:12px;">لسه مفيش تنفيذ.</div>'}
      <div class="toolbar" style="margin-top:14px;"><button class="btn secondary" id="ambDrawerX2">إغلاق</button></div>
    </div>
  `);
  $('ambDrawerX').onclick = closeDrawer;
  $('ambDrawerX2').onclick = closeDrawer;
}

// ---------------------------------------------------------------------------
// TAB: Execution History
// ---------------------------------------------------------------------------
async function renderHistory(panel) {
  const rows = await api.get('/api/ai-media-buyer/execution-history?limit=80');
  panel.innerHTML = rows.length === 0
    ? '<div class="empty-state">مفيش أكشنز اتنفّذت لسه.</div>'
    : `<div class="table-wrap"><table class="data">
        <thead><tr><th>الوقت</th><th>العنصر</th><th>الأكشن</th><th>قبل ← بعد</th><th>الحالة</th><th>النتيجة (24س)</th><th>وافق</th></tr></thead>
        <tbody>${rows.map(histRow).join('')}</tbody>
      </table></div>`;
  panel.querySelectorAll('[data-hist]').forEach((b) => b.onclick = () => showHistDetails(rows.find((x) => x.id === Number(b.dataset.hist))));
}
function histRow(a) {
  const ex = { PENDING: 'منتظر', REVALIDATING: 'إعادة تحقّق', EXECUTED: '✅ تم', FAILED: '❌ فشل', ABORTED_REANALYSIS: '⛔ إعادة تحليل' }[a.executionStatus] || a.executionStatus;
  const h24 = (a.results || []).find((r) => r.checkpoint === 'H24');
  const resAr = h24?.resultClass ? ({ SUCCESSFUL: '🟢 ناجح', NEUTRAL: '🟡 محايد', FAILED: '🔴 فاشل' }[h24.resultClass]) : (h24 ? '⏳ مستني' : '—');
  const bp = a.oldValue, np = a.newValue;
  const change = a.actionType.includes('BUDGET') && bp && np ? `${fmtEGP(bp.budget)} ← ${fmtEGP(np.budget)}` : bp && np ? `${E(bp.status || '')} ← ${E(np.status || '')}` : '—';
  return `<tr>
    <td style="white-space:nowrap;">${fmtDT(a.at)}</td>
    <td>${E(a.entityName || '')}${a.productName ? `<div class="faint" style="font-size:11px;">${E(a.productName)}</div>` : ''}</td>
    <td>${E(DECISION_AR[a.actionType] || a.actionType)} <span class="faint">(${E(a.mode)})</span></td>
    <td>${change}</td>
    <td>${E(ex)}${a.metaError ? `<div class="faint" style="font-size:11px; color:var(--red);">${E(a.metaError.slice(0, 60))}</div>` : ''}</td>
    <td>${resAr}</td>
    <td>${E(a.approvedBy || '')} <button class="btn secondary small" data-hist="${a.id}">تفاصيل</button></td>
  </tr>`;
}
function showHistDetails(a) {
  if (!a) return;
  openDrawer(`
    <div class="drawer-header"><div class="drawer-title">تفاصيل التنفيذ #${a.id}</div><button class="drawer-close" id="ambDrawerX">×</button></div>
    <div class="drawer-section">
      <div class="amb-derived">
        <div class="amb-derived-row"><span>العنصر</span><b>${E(a.entityName || '')}</b></div>
        <div class="amb-derived-row"><span>الأكشن</span><b>${E(DECISION_AR[a.actionType] || a.actionType)}</b></div>
        <div class="amb-derived-row"><span>الوضع</span><b>${E(a.mode)}</b></div>
        <div class="amb-derived-row"><span>الحالة</span><b>${E(a.executionStatus)}</b></div>
        <div class="amb-derived-row"><span>وافق</span><b>${E(a.approvedBy || '')}</b></div>
        <div class="amb-derived-row"><span>تنفيذ</span><b>${fmtDT(a.executedAt)}</b></div>
      </div>
      <div class="section-title">سبب الـ AI</div>
      <div class="amb-rec-reason">${E(a.aiReason || '—')}</div>
      ${a.revalidation ? `<div class="section-title">إعادة التحقّق قبل التنفيذ</div><pre style="white-space:pre-wrap; font-size:11px; background:var(--bg-elevated); padding:10px; border-radius:8px;">${E(JSON.stringify(a.revalidation, null, 1))}</pre>` : ''}
      ${a.metaError ? `<div style="color:var(--red); font-size:12.5px; margin-top:8px;">خطأ Meta: ${E(a.metaError)}</div>` : ''}
      <div class="section-title">تقييم النتيجة</div>
      ${(a.results || []).map((r) => `<div class="amb-derived" style="margin-bottom:8px;">
        <div class="amb-derived-row"><span>نقطة</span><b>${r.checkpoint} — ${r.evaluatedAt ? fmtDT(r.evaluatedAt) : 'مستني ' + fmtDT(r.dueAt)}</b></div>
        ${r.resultClass ? `<div class="amb-derived-row"><span>التصنيف</span><b>${E({ SUCCESSFUL: 'ناجح', NEUTRAL: 'محايد', FAILED: 'فاشل' }[r.resultClass])}</b></div>` : ''}
        <div class="amb-derived-row"><span>CPA قبل ← بعد</span><b>${fmtEGP(r.cpaBefore)} ← ${fmtEGP(r.cpaAfter)}</b></div>
        <div class="amb-derived-row"><span>شراء قبل ← بعد</span><b>${fmtNum(r.purchasesBefore)} ← ${fmtNum(r.purchasesAfter)}</b></div>
        <div class="amb-derived-row"><span>ربح قبل ← بعد</span><b>${fmtEGP(r.profitBefore)} ← ${fmtEGP(r.profitAfter)}</b></div>
        ${r.notes && r.notes.note ? `<div class="faint" style="font-size:11.5px; margin-top:4px;">${E(r.notes.note)}</div>` : ''}
      </div>`).join('') || '<div class="faint" style="font-size:12px;">مفيش نقاط تقييم.</div>'}
      <div class="toolbar" style="margin-top:14px;"><button class="btn secondary" id="ambDrawerX2">إغلاق</button></div>
    </div>
  `);
  $('ambDrawerX').onclick = closeDrawer;
  $('ambDrawerX2').onclick = closeDrawer;
}

// ---------------------------------------------------------------------------
// TAB: Settings
// ---------------------------------------------------------------------------
const SETTING_FIELDS = [
  ['ambExecutionMode', 'وضع التشغيل', 'select', ['ADVISORY', 'APPROVAL', 'AUTOPILOT']],
  ['ambSyncIntervalMinutes', 'كل كام دقيقة تتم المزامنة', 'number'],
  ['ambAlsoRefreshAdsDailyMetric', 'حدّث كمان بيانات AI Intelligence مع كل مزامنة', 'bool'],
  ['ambDefaultPricingMultiplier', 'مضاعف التسعير الافتراضي', 'number'],
  ['ambDefaultTargetCpa', 'Target CPA الافتراضي', 'number'],
  ['ambDefaultCurrency', 'العملة الافتراضية', 'text'],
  ['ambNoPurchaseStopMultiplier', 'مضاعف الإيقاف بدون شراء (Target CPA ×)', 'number'],
  ['ambMaxBudgetIncreasePct', 'أقصى زيادة ميزانية لكل أكشن %', 'number'],
  ['ambScalingCooldownHours', 'فترة تهدئة التوسّع (ساعات)', 'number'],
  ['ambMaxDailyBudgetIncreasePct', 'أقصى زيادة ميزانية يومية %', 'number'],
  ['ambMaxAllowedDailyLoss', 'أقصى خسارة يومية مسموحة', 'number'],
  ['ambMaxAutoExecutionAmount', 'أقصى مبلغ تنفيذ تلقائي', 'number'],
  ['ambMinPurchasesBeforeScaling', 'أدنى مشتريات قبل التوسّع', 'number'],
  ['ambMinSpendBeforeDecision', 'أدنى صرف قبل أي قرار', 'number'],
  ['ambAnalysisLookbackDays', 'نافذة التحليل (أيام)', 'number'],
  ['ambScaleCpaBetterPct', 'CPA لازم يكون أحسن من الهدف بـ % قبل التوسّع', 'number'],
  ['ambCreativeFatigueFreqThreshold', 'حد التكرار لإجهاد الكرييتف', 'number'],
  ['ambAllowAutoPause', 'أوتوبايلوت: اسمح بالإيقاف التلقائي', 'bool'],
  ['ambAllowAutoBudgetIncrease', 'أوتوبايلوت: اسمح بزيادة الميزانية', 'bool'],
  ['ambAllowAutoBudgetDecrease', 'أوتوبايلوت: اسمح بتقليل الميزانية', 'bool'],
  ['ambAllowDuplicationActions', 'أوتوبايلوت: اسمح بأكشنز التكرار', 'bool'],
];
async function renderSettings(panel) {
  const { settings } = await api.get('/api/ai-media-buyer/settings');
  panel.innerHTML = `
    <div class="card">
      <div class="section-title" style="margin-top:0;">إعدادات AI Media Buyer</div>
      <div class="faint" style="font-size:12px; margin-bottom:14px;">وضع "الموافقة" هو الافتراضي — مفيش تنفيذ على Meta من غير موافقتك. كل خيارات الأوتوبايلوت الخطيرة مقفولة افتراضيًا.</div>
      <div class="amb-field-grid">
        ${SETTING_FIELDS.map(([k, label, type, opts]) => {
          const v = settings[k];
          if (type === 'bool') return `<div class="field"><label style="display:flex; align-items:center; gap:8px; cursor:pointer;"><input type="checkbox" data-s="${k}" ${v ? 'checked' : ''} /> ${E(label)}</label></div>`;
          if (type === 'select') return `<div class="field"><label>${E(label)}</label><select data-s="${k}">${opts.map((o) => `<option value="${o}" ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
          return `<div class="field"><label>${E(label)}</label><input type="${type}" data-s="${k}" value="${v ?? ''}" step="any" /></div>`;
        }).join('')}
      </div>
      <div class="toolbar" style="margin-top:16px;">
        ${state.isAdmin ? '<button class="btn" id="ambSaveSettings">حفظ الإعدادات</button>' : '<span class="faint">الحفظ متاح للـ ADMIN فقط.</span>'}
      </div>
    </div>
  `;
  if ($('ambSaveSettings')) $('ambSaveSettings').onclick = async () => {
    const body = {};
    panel.querySelectorAll('[data-s]').forEach((el) => {
      if (el.type === 'checkbox') body[el.dataset.s] = el.checked;
      else if (el.type === 'number') body[el.dataset.s] = el.value === '' ? null : Number(el.value);
      else body[el.dataset.s] = el.value;
    });
    try {
      await api.put('/api/ai-media-buyer/settings', body);
      UI.toast('✅ اتحفظت الإعدادات');
      await loadSyncStrip();
      route();
    } catch (err) { UI.toast(err.message, 'error'); }
  };
}

init();
