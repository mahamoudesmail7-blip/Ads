// alerts.js — page controller for alerts.html.
// V1: spec sections 10, 11. V2: section 8 (Stock Alerts), plus the
// needs-attention ranking and EXIT/negative classification now route
// through the V2 recommendation (profit + inventory aware), not just the
// core order-trend verdict.
// Deliberately decoupled from rendering: buildAlerts() below returns plain
// data structures so a future Notification Engine (Telegram/WhatsApp/Email
// per section 18) can consume the exact same alert objects without needing
// the DOM.
import { Products, DailyOrders, Settings } from './db.js';
import * as A from './analytics.js';
import * as UI from './ui-common.js';
import { buildProductBundle } from './product-bundle.js';
import { api } from './api-client.js';

/** Pure function: given bundles, returns categorized alert lists. No DOM. */
export function buildAlerts(bundles, settings) {
  const act = bundles.filter((x) => x.product.active && !x.a.isNew);

  const positive = act
    .filter((x) => x.a.baseline.pct !== null && x.a.baseline.pct >= settings.upThreshold)
    .sort((a, b) => b.a.baseline.pct - a.a.baseline.pct);

  const negative = act
    .filter((x) => x.a.status === 'DOWN' || x.a.status === 'CRITICAL')
    .sort((a, b) => (a.a.baseline.pct ?? 0) - (b.a.baseline.pct ?? 0));

  const continuousDecline = act
    .filter((x) => x.a.declineStreak >= settings.consecutiveDeclineDays)
    .sort((a, b) => b.a.declineStreak - a.a.declineStreak);

  const stockAlerts = act
    .filter((x) => x.inventory.status === 'CRITICAL' || x.inventory.status === 'LOW')
    .sort((a, b) => (a.inventory.daysRemaining ?? Infinity) - (b.inventory.daysRemaining ?? Infinity));

  const needsAttention = act
    .map((x) => {
      const riskScore =
        (100 - x.a.health.score) +
        x.a.declineStreak * 5 +
        (x.v2.type === 'EXIT' ? 60 : 0) +
        (x.v2.type === 'FIX' ? 30 : 0) +
        (x.v2.type === 'RESTOCK' ? 20 : 0) +
        (x.a.status === 'CRITICAL' ? 25 : 0) +
        (x.a.status === 'DOWN' ? 10 : 0) +
        (x.a.trend.code === 'VOLATILE' ? 8 : 0) +
        (x.a.zeroDays14 > 0 ? x.a.zeroDays14 * 3 : 0) +
        (x.profit.profitPerOrder !== null && x.profit.profitPerOrder < 0 ? 20 : 0);
      return { ...x, riskScore };
    })
    .filter((x) => x.riskScore > 25)
    .sort((a, b) => b.riskScore - a.riskScore);

  return { positive, negative, continuousDecline, needsAttention, stockAlerts };
}

// ---------------------------------------------------------------------------
// 🚨 مركز التنبيهات — live, from the real data (Easy Orders feed, Meta sync, campaign CPA, zero-order spend, stock, funds).
// ---------------------------------------------------------------------------
const AC_KINDS = { ORDERS_FEED: ['📦', 'أوردرات Easy Orders'], SYNC: ['🔄', 'مزامنة Meta'], CPA: ['🎯', 'CPA'], ZERO_ORDERS: ['💸', 'صرف بدون أوردر'], STOCK: ['📉', 'المخزون'], FUNDS: ['💳', 'رصيد الحساب'], SYSTEM: ['⚙️', 'النظام'] };
const AC_SEV = { CRITICAL: ['حرج', 'crit'], WARNING: ['تحذير', 'warn'], INFO: ['معلومة', 'info'] };
let acDoc = null; let acKind = 'all'; let acGen = 0; let acAll = false;
const AC_LIMIT = 12; // the first screen shows the 12 that matter most (severity, then the money at stake); the rest is one click away

function acCard(a, i) {
  const [icon, kindLabel] = AC_KINDS[a.kind] || ['•', a.kind];
  const [sevLabel, sevCls] = AC_SEV[a.severity] || ['', 'info'];
  const link = a.entity?.productId ? UI.productLink(a.entity.productId) : '';
  return `
  <article class="ac-card ${sevCls}" style="--i:${Math.min(i, 12)}" ${link ? `data-goto="${link}" tabindex="0"` : ''}>
    <div class="ac-ic" aria-hidden="true">${icon}</div>
    <div class="ac-body">
      <div class="ac-top"><span class="ac-sev ${sevCls}">${sevLabel}</span><span class="ac-kind">${UI.escapeHtml(kindLabel)}</span></div>
      <div class="ac-title">${UI.escapeHtml(a.title)}</div>
      ${a.detail ? `<div class="ac-detail">${UI.escapeHtml(a.detail)}</div>` : ''}
      ${a.facts?.length ? `<div class="ac-facts">${a.facts.map((f) => `<span><em>${UI.escapeHtml(f.l)}</em> <b>${UI.escapeHtml(f.v)}</b></span>`).join('')}</div>` : ''}
      ${a.action ? `<div class="ac-action">👉 ${UI.escapeHtml(a.action)}</div>` : ''}
    </div>
  </article>`;
}

function acRender() {
  const box = document.getElementById('acList'); if (!box || !acDoc) return;
  const list = acDoc.alerts.filter((a) => acKind === 'all' || a.kind === acKind);
  const sm = acDoc.summary;
  document.getElementById('acSummary').innerHTML = `
    <div class="ac-sum crit"><b>${sm.CRITICAL}</b><span>حرجة</span></div>
    <div class="ac-sum warn"><b>${sm.WARNING}</b><span>تحذيرات</span></div>
    <div class="ac-sum ok"><b>${acDoc.alerts.length === 0 ? '✓' : sm.total}</b><span>${acDoc.alerts.length === 0 ? 'كله تمام' : 'الإجمالي'}</span></div>`;
  const kinds = Object.keys(sm.kinds || {});
  document.getElementById('acFilters').innerHTML = kinds.length > 1 ? [['all', 'الكل', sm.total], ...kinds.map((k) => [k, (AC_KINDS[k] || ['', k])[1], sm.kinds[k]])].map(([k, l, n]) => `<button type="button" class="ac-chip${acKind === k ? ' on' : ''}" data-k="${k}">${UI.escapeHtml(l)} <b>${n}</b></button>`).join('') : '';
  document.querySelectorAll('#acFilters [data-k]').forEach((b) => { b.onclick = () => { acKind = b.dataset.k; acAll = false; acRender(); }; });
  const shown = acAll ? list : list.slice(0, AC_LIMIT);
  box.innerHTML = list.length ? shown.map(acCard).join('') + (list.length > shown.length ? `<button type="button" class="ac-more" id="acMore">عرض الباقي (${list.length - shown.length})</button>` : '') : `<div class="ac-allgood">✅ مفيش حاجة محتاجة انتباه دلوقتي.<small>اتفحص: أوردرات Easy Orders · مزامنة Meta · CPA الحملات · صرف بدون أوردر · المخزون · أرصدة الحسابات</small></div>`;
  const more = document.getElementById('acMore'); if (more) more.onclick = () => { acAll = true; acRender(); };
  box.querySelectorAll('[data-goto]').forEach((c) => { c.style.cursor = 'pointer'; c.onclick = () => (window.location.href = c.dataset.goto); });
  const t = new Date(acDoc.generatedAt);
  document.getElementById('acStamp').textContent = `آخر فحص ${t.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
}

async function acLoad(force) {
  const gen = ++acGen; const btn = document.getElementById('acRefresh');
  if (btn) btn.disabled = true;
  try {
    const d = await api.get('/api/ai-media-buyer/alerts-center', force ? { force: '1' } : {});
    if (gen !== acGen) return;
    acDoc = d; acRender();
  } catch (e) {
    if (gen === acGen) document.getElementById('acList').innerHTML = `<div class="empty-state">⚠️ تعذّر تحميل مركز التنبيهات: ${UI.escapeHtml(e.message || '')}</div>`;
  } finally { if (btn) btn.disabled = false; }
}

async function init() {
  UI.renderSidebar('alerts');
  acLoad(false);
  document.getElementById('acRefresh').onclick = () => acLoad(true);
  setInterval(() => { if (!document.hidden) acLoad(false); }, 60_000);
  const settings = await Settings.get();
  const products = (await Products.all()).filter((p) => !p.is_demo);
  // 🧪 Demo orders included on purpose (spec: dashboard/alerts should behave
  // "as if EasyOrders is connected") — a real order for the same date
  // automatically reclaims it from demo status (see DailyOrders.upsert).
  const allOrders = await DailyOrders.all();
  const asOfDate = A.todayStr();

  const byProduct = new Map();
  for (const o of allOrders) {
    if (!byProduct.has(o.product_id)) byProduct.set(o.product_id, []);
    byProduct.get(o.product_id).push(o);
  }

  const bundles = products.map((p) => buildProductBundle(p, byProduct.get(p.id) || [], asOfDate, settings));
  document.getElementById('dateLabel').textContent = `بيانات بتاريخ ${asOfDate}`;

  const { positive, negative, continuousDecline, needsAttention, stockAlerts } = buildAlerts(bundles, settings);

  renderList('attentionList', needsAttention.slice(0, 10), (x, i) => attentionCard(x, i + 1), 'لا توجد منتجات تحتاج انتباهًا حاليًا. 👍');
  renderList('stockList', stockAlerts, stockCard, 'لا توجد تنبيهات مخزون حاليًا. 👍');
  renderList('positiveList', positive, positiveCard, 'لا توجد تنبيهات إيجابية اليوم.');
  renderList('declineList', continuousDecline, declineCard, 'لا يوجد منتج في انخفاض مستمر حاليًا.');
  renderList('negativeList', negative, negativeCard, 'لا توجد تنبيهات سلبية اليوم.');
}

function renderList(containerId, items, cardFn, emptyMsg) {
  const el = document.getElementById(containerId);
  if (items.length === 0) {
    el.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
    return;
  }
  el.innerHTML = items.map(cardFn).join('');
  el.querySelectorAll('[data-goto]').forEach((card) => {
    card.style.cursor = 'pointer';
    card.onclick = () => (window.location.href = UI.productLink(card.dataset.goto));
  });
}

function positiveCard({ product, a, profit, v2 }) {
  return `
  <div class="alert-card positive" data-goto="${product.id}">
    <div class="alert-title">🔥 ${UI.escapeHtml(product.product_name)}</div>
    <div class="alert-meta">
      <span>اليوم: ${UI.fmtNum(a.today)} أوردر</span>
      <span>معدل ${a.baselineDays} أيام: ${UI.fmtAvg(a.avg7)}</span>
      <span>الأداء: ${UI.fmtPct(a.baseline.pct)}</span>
      ${profit.profitPerOrder !== null ? `<span>ربح الأوردر: ${UI.fmtCurrency(profit.profitPerOrder)}</span>` : ''}
    </div>
    <div class="alert-rec"><b>الحالة:</b> 🟢 أداء ممتاز — <b>التوصية:</b> ${UI.recActionText(v2.type === 'SCALE' ? 'SCALE' : 'NORMAL')}</div>
  </div>`;
}

function negativeCard({ product, a, v2 }) {
  const critical = a.status === 'CRITICAL';
  return `
  <div class="alert-card negative" data-goto="${product.id}">
    <div class="alert-title">⚠️ ${UI.escapeHtml(product.product_name)} ${UI.recPill(v2.type)}</div>
    <div class="alert-meta">
      <span>اليوم: ${UI.fmtNum(a.today)} أوردر</span>
      <span>معدل ${a.baselineDays} أيام: ${UI.fmtAvg(a.avg7)}</span>
      <span>الأداء: ${UI.fmtPct(a.baseline.pct)}</span>
    </div>
    <div class="alert-rec"><b>الحالة:</b> ${critical ? '🚨 يحتاج تدخل عاجل' : '🟡 يحتاج متابعة'} — <b>التوصية:</b> ${critical ? 'مراجعة عاجلة / تقليل الإنفاق الإعلاني' : 'مراقبة عن قرب'}</div>
  </div>`;
}

function declineCard({ product, a }) {
  const last = a.trend;
  return `
  <div class="alert-card warning" data-goto="${product.id}">
    <div class="alert-title">🚨 ${UI.escapeHtml(product.product_name)}</div>
    <div class="alert-meta">
      <span>انخفاض لمدة ${a.declineStreak} أيام متتالية</span>
      <span>اتجاه الأداء: ${UI.trendLabel(last)}</span>
    </div>
    <div class="alert-rec"><b>التوصية:</b> راجع المحتوى الإعلاني وتكلفة الأوردر والعرض والمنتج نفسه</div>
  </div>`;
}

function stockCard({ product, inventory }) {
  const critical = inventory.status === 'CRITICAL';
  return `
  <div class="alert-card ${critical ? 'negative' : 'warning'}" data-goto="${product.id}">
    <div class="alert-title">${critical ? '🚨 يحتاج إعادة طلب فورًا' : '⚠️ مخزون منخفض'} — ${UI.escapeHtml(product.product_name)}</div>
    <div class="alert-meta">
      <span>المخزون: ${inventory.currentStock}</span>
      <span>المتوسط اليومي: ${inventory.dailyAverageSales?.toFixed(1) ?? '—'}</span>
      <span>الأيام المتبقية: ${inventory.daysRemaining?.toFixed(1) ?? '—'}</span>
    </div>
    <div class="alert-rec"><b>التوصية:</b> ${critical ? 'أعد الطلب فورًا' : 'خطط لإعادة الطلب قريبًا'}${inventory.restockQuantity ? ` (كمية مقترحة: ${inventory.restockQuantity})` : ''}</div>
  </div>`;
}

function attentionCard({ product, a, v2 }, rank) {
  const reasons = [...v2.reasons];
  if (a.zeroDays14 > 0) reasons.push(`${a.zeroDays14} يوم بدون أوردرات خلال آخر 14 يوم`);

  return `
  <div class="alert-card ${v2.type === 'EXIT' ? 'negative' : 'warning'}" data-goto="${product.id}">
    <div class="alert-title">#${rank} ${UI.escapeHtml(product.product_name)} — ${UI.recPill(v2.type)}</div>
    <div class="alert-meta">
      <span>تقييم حالة المنتج: ${UI.healthBar(a.health.score)} (${UI.scoreLabelAr(a.health.label)})</span>
      <span>الحالة: ${UI.statusBadge(a.status)}</span>
    </div>
    <div class="alert-rec">${reasons.map((r) => UI.escapeHtml(UI.translateReason(r))).join(' • ')}</div>
  </div>`;
}

init();
