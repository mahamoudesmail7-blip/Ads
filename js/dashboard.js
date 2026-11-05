// dashboard.js — page controller for index.html: a "glance" page (spec:
// "لا تحول النظرة السريعة إلى Dashboard ضخمة") that now behaves as if the
// system were already connected to a real order source — it reflects
// whatever daily_orders data exists (🧪 demo today, real once entered/
// connected) rather than only real entries. The detailed day-to-day
// workflow still lives on dedicated pages — 🎯 تاسكات اليوم (per-product
// decisions + completion), 🛠️ الشغل اللي هيتعمل (team assignment), 📦
// المنتجات (full catalog, sortable by Score) — so this page stays a quick
// summary with a compact Action Plan and a one-click Daily Report, not a
// second copy of those pages.
import { Products, DailyOrders, Settings, TaskAssignments, TeamMembers } from './db.js';
import * as A from './analytics.js';
import * as UI from './ui-common.js';
import { buildProductBundle } from './product-bundle.js';
import { classifyDailyStatus } from './daily-monitor.js';
import { analyzeProductDecision } from './decision-engine.js';
import { buildTask, topTasks } from './task-engine.js';
import { calculateProductScore } from './product-score.js';
import { openProductDrawer } from './product-drawer.js';
import { wireScoreTriggers } from './score-modal.js';
import { generateDemoTasks, resetDemoTasks } from './demo-tasks.js';
import { loadDemoDay } from './demo-day-scenario.js';
import { loadPerfTestScenario } from './perf-test-scenario.js';
import { getWarehouseSummary, getReconciliation } from './inventory-store.js';
import { api } from './api-client.js';

const state = { asOfDate: A.todayStr() };

let settings = null;
let items = []; // active real products: {product, a, dailyStatus, decision, task, score}
let comparisonItems = []; // real products + 🧪 perf-test-scenario demo products — the 📊 comparison table intentionally includes both (see renderComparison)
let maxUsableDate = A.todayStr(); // latest date with ANY order data (demo or real) — lets 🧪 scenarios dated slightly ahead of "real today" stay reachable

async function init() {
  UI.renderSidebar('dashboard');

  const picker = document.getElementById('asOfDatePicker');
  picker.value = state.asOfDate;
  picker.max = A.todayStr();
  picker.onchange = () => {
    state.asOfDate = picker.value;
    refresh();
  };
  document.getElementById('btnToday').onclick = () => {
    state.asOfDate = A.todayStr();
    picker.value = state.asOfDate;
    refresh();
  };
  document.getElementById('btnYesterday').onclick = () => {
    state.asOfDate = A.addDays(A.todayStr(), -1);
    picker.value = state.asOfDate;
    refresh();
  };
  document.getElementById('btnSimulateNextDay').onclick = () => {
    const next = A.addDays(state.asOfDate, 1);
    if (next > maxUsableDate) {
      UI.toast('محاكاة الأيام تتوقف عند آخر يوم فيه بيانات — ولّد بيانات اختبار جديدة لتجربة يوم جديد فعليًا', 'error');
      return;
    }
    state.asOfDate = next;
    picker.value = state.asOfDate;
    refresh();
  };
  document.getElementById('btnLoadDemoDay').onclick = async () => {
    document.getElementById('btnLoadDemoDay').disabled = true;
    const result = await loadDemoDay();
    document.getElementById('btnLoadDemoDay').disabled = false;
    document.getElementById('demoStatus').textContent =
      result.unmatched.length > 0
        ? `تم تحميل ${result.matched} منتج بنجاح — تعذّر إيجاد: ${result.unmatched.join('، ')}`
        : `تم تحميل تجربة يوم ${result.demoToday} على ${result.matched} منتج (${result.ordersWritten} سجل).`;
    state.asOfDate = result.demoToday;
    picker.value = state.asOfDate;
    UI.toast('✅ تم تحميل تجربة اليوم الجديد');
    await refresh();
  };
  document.getElementById('btnGenerateDemo').onclick = async () => {
    document.getElementById('btnGenerateDemo').disabled = true;
    const result = await generateDemoTasks(state.asOfDate);
    document.getElementById('btnGenerateDemo').disabled = false;
    document.getElementById('demoStatus').textContent = result.generated
      ? `تم توليد ${result.ordersWritten} سجل تجربة على ${result.productsCovered} منتج.`
      : 'لا توجد منتجات حقيقية بعد — أضفها من صفحة المنتجات أولًا.';
    UI.toast('✅ تم توليد بيانات الاختبار');
    await refresh();
  };
  document.getElementById('btnResetDemo').onclick = async () => {
    document.getElementById('btnResetDemo').disabled = true;
    // "العودة للبيانات الافتراضية" — back to real today, running the
    // general 127-product scenario (not the curated Demo Day).
    state.asOfDate = A.todayStr();
    picker.value = state.asOfDate;
    const result = await resetDemoTasks(state.asOfDate);
    document.getElementById('btnResetDemo').disabled = false;
    document.getElementById('demoStatus').textContent = `تم مسح ${result.removed} سجل قديم وتوليد ${result.ordersWritten} سجل جديد.`;
    UI.toast('تم تحديث بيانات التجربة');
    await refresh();
  };
  document.getElementById('btnDailyReport').onclick = toggleDailyReport;
  document.getElementById('btnLoadPerfTest').onclick = async () => {
    document.getElementById('btnLoadPerfTest').disabled = true;
    const result = await loadPerfTestScenario();
    document.getElementById('btnLoadPerfTest').disabled = false;
    UI.toast(`✅ تم تحميل ${result.productsLoaded} منتجات اختبار الأداء`);
    await refresh();
  };

  document.getElementById('btnAccountsTodayRefresh').onclick = () => { renderAccountsToday(true); renderMonthDays(true); renderTopProducts(); };
  initProfitCard(); // the product profit card loads its own product list once; it is not part of refresh()

  await refresh();
}

async function refresh() {
  settings = await Settings.get();
  const products = (await Products.all()).filter((p) => !p.is_demo && p.active);
  // 🧪 Demo orders included on purpose (spec: "أريد النظرة السريعة تعمل
  // كأن النظام مربوط بـ EasyOrders") — this page should reflect whatever
  // order data exists, demo now, real later. A real entry for a given
  // date automatically reclaims it from demo status (DailyOrders.upsert).
  const allOrders = await DailyOrders.all();

  const byProduct = new Map();
  for (const o of allOrders) {
    if (!byProduct.has(o.product_id)) byProduct.set(o.product_id, []);
    byProduct.get(o.product_id).push(o);
  }

  maxUsableDate = allOrders.reduce((max, o) => (o.date > max ? o.date : max), A.todayStr());
  const picker = document.getElementById('asOfDatePicker');
  picker.max = maxUsableDate;

  items = products.map((p) => {
    const { a, inventory, v2 } = buildProductBundle(p, byProduct.get(p.id) || [], state.asOfDate, settings);
    const dailyStatus = classifyDailyStatus(a, settings);
    const decision = analyzeProductDecision(a, dailyStatus, v2.type, inventory);
    const task = buildTask({ product: p, a, decision, inventory });
    const score = calculateProductScore(a);
    return { product: p, a, dailyStatus, decision, task, score };
  });

  // 📊 مقارنة أداء المنتجات: real products PLUS the 🧪 perf-test-scenario's
  // own demo products (which aren't part of `products` above since those
  // are filtered to !is_demo) — this section is meant to also show the
  // test scenario when it's loaded, unlike the rest of the page.
  const allActiveProducts = (await Products.all()).filter((p) => p.active);
  comparisonItems = allActiveProducts.map((p) => {
    const { a, inventory, v2 } = buildProductBundle(p, byProduct.get(p.id) || [], state.asOfDate, settings);
    const dailyStatus = classifyDailyStatus(a, settings);
    const decision = analyzeProductDecision(a, dailyStatus, v2.type, inventory);
    return { product: p, a, dailyStatus, decision };
  });

  document.getElementById('dateLabel').textContent = `عرض بيانات بتاريخ ${state.asOfDate}`;
  document.getElementById('emptyDashboardBanner').style.display = items.length === 0 ? 'block' : 'none';

  renderAccountsToday(false); // not awaited: Meta being slow must never delay the rest of the page
  { const anchor = String(state.asOfDate).slice(0, 7); if (anchor !== mdAnchor) { mdAnchor = anchor; mdMonth = null; } } // the dashboard date moved to another month → follow it
  renderMonthDays(false);
  renderTopProducts();
  // Owner 2026-11-03: the empty / all-zero / stale sections (quick stats, inventory, comparison, improved, declined, top 4, zero-order, needs-intervention, action plan, work teaser) are hidden in index.html (hidden) and no longer computed;
  // their render functions are kept so putting a card back is just removing its `hidden` and re-adding its render call here.
  if (document.getElementById('dailyReportCard').style.display !== 'none') renderDailyReport();
}

// ---------------------------------------------------------------------------
// 📊 مقارنة أداء المنتجات — أمس مقابل اليوم. Ranked by |change.abs|
// (biggest movers first — "importance and priority, not alphabetical"),
// with a prominent alert banner for the worst declines.
// ---------------------------------------------------------------------------

function renderComparison() {
  const ranked = [...comparisonItems]
    .filter((x) => x.a.change.abs !== null)
    .sort((x, y) => Math.abs(y.a.change.abs) - Math.abs(x.a.change.abs));

  // A hard "top 3" would let a busy demo day's noise crowd out a genuinely
  // meaningful drop (e.g. -4 orders) just because several other products
  // happened to drop by more. A fixed severity threshold instead means any
  // product declining by 4+ orders qualifies, independent of how many other
  // products also declined today; 🧪 test-scenario products are surfaced
  // first (so the exact worked example always gets its banner), then the
  // most severe real declines fill any remaining slots — capped so it
  // can't grow into a wall of banners on a very bad day.
  const alerts = ranked
    .filter((x) => x.a.change.abs !== null && x.a.change.abs <= -4)
    .sort((x, y) => (x.product.is_demo === y.product.is_demo ? x.a.change.abs - y.a.change.abs : x.product.is_demo ? -1 : 1))
    .slice(0, 6);
  document.getElementById('comparisonAlerts').innerHTML = alerts
    .map((x) => {
      const abs = Math.abs(x.a.change.abs);
      return `<div class="perf-alert-banner">⚠️ تنبيه مهم: ${UI.escapeHtml(x.product.product_name)} سجل ${x.a.yesterday} أوردر أمس مقابل ${x.a.today} أوردر اليوم — انخفاض قدره ${abs} ${abs === 1 ? 'أوردر' : 'أوردرات'}، لذلك يُنصح بمراجعة أداء الحملة والإعلان فورًا.</div>`;
    })
    .join('');

  const tbody = document.getElementById('comparisonTableBody');
  if (ranked.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">لا توجد بيانات كافية للمقارنة بعد.</td></tr>';
    return;
  }
  tbody.innerHTML = ranked
    .map((x) => {
      const abs = x.a.change.abs;
      const rowClass = abs > 0 ? 'comparison-row-positive' : abs < 0 ? 'comparison-row-negative' : '';
      const diffColor = abs > 0 ? 'var(--green)' : abs < 0 ? 'var(--red)' : 'var(--text-dim)';
      return `
      <tr class="${rowClass}">
        <td>${UI.escapeHtml(x.product.product_name)}${x.product.is_demo ? ' <span class="faint" style="font-size:10px;">🧪</span>' : ''}</td>
        <td class="num mono">${x.a.yesterday ?? '—'}</td>
        <td class="num mono">${x.a.today ?? '—'}</td>
        <td class="num" style="color:${diffColor}; font-weight:700;">${UI.fmtChangeAbs(abs)}</td>
        <td class="num">${UI.fmtPct(x.a.change.pct)}</td>
        <td>${x.dailyStatus.icon} ${x.dailyStatus.label}</td>
        <td style="font-size:12.5px; color:var(--text-dim);">${UI.escapeHtml(x.decision.note)}</td>
      </tr>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// 🏭 المخزون — compact KPI teaser, full detail lives on inventory.html
// (spec section 13: "New Main Dashboard Cards").
// ---------------------------------------------------------------------------

async function renderInventoryKpis() {
  const [summary, reconciliation] = await Promise.all([getWarehouseSummary(state.asOfDate), getReconciliation(state.asOfDate)]);
  const stats = [
    ['📦 وحدات خارجة اليوم', summary.totalUnitsOutToday],
    ['📊 المخزون الحالي', summary.totalUnitsAvailable],
    ['🔄 منتجات بها حركة', summary.productsWithMovement],
    ['⚠️ مخزون منخفض', summary.lowStockProducts],
    ['🔴 نفد من المخزون', summary.outOfStockProducts],
    ['⚖️ فرق الأوردرات/المخزون', reconciliation.diff ?? '—'],
  ];
  document.getElementById('inventoryKpiBody').innerHTML = stats.map(([label, value]) => `<span>${label}: <b class="mono">${value}</b></span>`).join('');
}

// ---------------------------------------------------------------------------
// 1. أهم أرقام اليوم
// ---------------------------------------------------------------------------

function renderQuickStats() {
  // Counted the SAME way as the list sections below (not by dailyStatus
  // bucket) so every number on this page is internally consistent: open
  // "🟢 ظبطت النهارده" and you'll find exactly this many cards.
  const improved = items.filter((x) => x.a.change.abs !== null && x.a.change.abs > 0).length;
  const declined = items.filter((x) => x.a.change.abs !== null && x.a.change.abs < 0 && x.a.today !== 0).length;
  const zeroOrder = items.filter((x) => x.dailyStatus.code === 'STOPPED').length;
  const byAction = (code) => items.filter((x) => x.decision.action.code === code).length;

  const stats = [
    ['📦 إجمالي المنتجات', items.length],
    ['🟢 ظبطت النهارده', improved],
    ['🔴 ريحت النهارده', declined],
    ['🚨 بدون أوردر', zeroOrder],
    ['🔥 Scale', byAction('SCALE_UP')],
    ['⬇️ Reduce', byAction('REDUCE')],
    ['⚠️ Review', byAction('STOP_CANDIDATE') + byAction('REVIEW_NOW')],
  ];

  document.getElementById('quickStatsBody').innerHTML = stats
    .map(([label, value]) => `<span>${label}: <b class="mono">${value}</b></span>`)
    .join('');
}

// ---------------------------------------------------------------------------
// 💳 الحسابات الإعلانية — لكل حساب: صرف / أوردرات / كوست / فاند، وتحتها الإجمالي (أوفر رول).
// الأوردرات = مشتريات Meta لكل حساب (Easy Orders مش بيعرف الأوردر جه من أنهي حساب).
// ---------------------------------------------------------------------------

const ATD_COLORS = ['#ff7a1a', '#7a4dff', '#2f80ed', '#16a34a', '#e11d74', '#0ea5a4'];
const ATD_REDUCED = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let accountsTodayGen = 0;
async function renderAccountsToday(force) {
  const gen = ++accountsTodayGen; // a slower, older response never overwrites a newer one
  const body = document.getElementById('accountsTodayBody');
  const isToday = state.asOfDate === A.todayStr();
  document.getElementById('accountsTodayTitle').textContent = isToday ? '💳 الحسابات الإعلانية — النهارده' : `💳 الحسابات الإعلانية — ${state.asOfDate}`;
  if (!body.querySelector('.atd')) body.innerHTML = '<div class="atd-loading"><div class="atd-skel"></div><div class="atd-skel"></div><div class="atd-skel"></div></div>';
  let r;
  try { r = await api.get('/api/ai-media-buyer/accounts-today', { date: state.asOfDate, force: force ? '1' : '' }); }
  catch (e) { if (gen === accountsTodayGen) body.innerHTML = `<span class="atd-err">⚠️ تعذّر تحميل أرقام الحسابات: ${UI.escapeHtml(e.message || '')}</span>`; return; }
  if (gen !== accountsTodayGen || !r) return;

  const money = (n) => `${UI.fmtNum(Math.round(n))}<small>ج</small>`;
  // a number that counts up from 0 (data-to / data-kind are read by atdCountUp); null stays a plain dash, never an animated 0
  const num = (n, kind) => (n === null || n === undefined ? '—' : `<span data-to="${n}" data-kind="${kind}">${kind === 'money' ? money(0) : '0'}</span>`);
  const fundsHtml = (f) => {
    if (!f || f.error) return '<span class="x na">غير متاح من Meta</span>';
    if (f.available !== null && f.available !== undefined) return `<span class="x${f.low ? ' low' : ''}">رصيد متاح: ${UI.fmtNum(Math.round(f.available))} ج</span>`;
    if (f.display) return `<span class="x${f.low ? ' low' : ''}">${UI.escapeHtml(f.display)}</span>`;
    if (f.balance !== null) return `<span class="x">${f.isPrepay === false ? 'مستحق' : 'رصيد'}: ${UI.fmtNum(Math.round(f.balance))} ${UI.escapeHtml(f.currency)}</span>`;
    return '<span class="x na">—</span>';
  };

  const total = r.total || { spend: 0, orders: 0, cpa: null };
  const cards = r.accounts.map((a, i) => {
    const share = total.spend > 0 && a.spend ? Math.min(100, (a.spend / total.spend) * 100) : 0;
    const initial = UI.escapeHtml((a.name || '?').trim().charAt(0).toUpperCase());
    return `
    <article class="atd-card${a.hasData ? '' : ' is-empty'}${a.funds?.low ? ' is-low' : ''}" style="--acc:${ATD_COLORS[i % ATD_COLORS.length]}; --i:${i}">
      <div class="atd-id">
        <div class="atd-avatar">${initial}</div>
        <div style="min-width:0;"><div class="atd-name">${UI.escapeHtml(a.name || a.id)}</div><div class="atd-sub">${a.activeCampaigns ? `${a.activeCampaigns} حملة بتصرف` : 'لا حملات بتصرف'}</div></div>
        ${a.funds?.low ? '<span class="atd-chip warn">⚠️ فاند منخفض</span>' : a.active === false ? '<span class="atd-chip off">غير نشط</span>' : a.isPrimary ? '<span class="atd-chip">★ الأساسي</span>' : ''}
      </div>
      ${a.hasData ? `
      <div class="atd-share">
        <div class="atd-share-row"><span>حصته من الصرف</span><b>${UI.fmtNum(Math.round(share))}%</b></div>
        <div class="atd-bar"><i data-w="${share.toFixed(1)}"></i></div>
      </div>
      <div class="atd-kpis">
        <div class="atd-kpi"><div class="l">الصرف</div><div class="v">${num(a.spend, 'money')}</div></div>
        <div class="atd-kpi"><div class="l">الأوردرات</div><div class="v">${num(a.orders ?? 0, 'int')}</div></div>
        <div class="atd-kpi"><div class="l">الكوست</div><div class="v">${num(a.cpa, 'money')}</div></div>
      </div>` : '<div class="atd-none">لا توجد بيانات صرف لليوم ده</div>'}
      <div class="atd-funds${a.funds?.low ? ' is-low' : ''}"><span class="ic">${a.funds?.low ? '⚠️' : '💳'}</span><span class="t">الفاند</span>${fundsHtml(a.funds)}</div>
      <div class="atd-hint">📦 اضغط لعرض منتجات الحساب <span>›</span></div>
    </article>`;
  }).join('');

  const lowList = r.accounts.filter((a) => a.funds?.low);
  const lowBanner = lowList.length ? `<div class="atd-alert" role="alert">${lowList.map((a) => `<div>⚠️ حساب <b>${UI.escapeHtml(a.name || a.id)}</b> رصيده المتاح <b>${UI.fmtNum(Math.round(a.funds.available))} ج</b> (أقل من ${UI.fmtNum(r.lowFundsThreshold || 2000)} ج) — ممكن يقف فاند، اشحنه.</div>`).join('')}</div>` : '';
  body.innerHTML = `
    <div class="atd">
      ${lowBanner}
      <div class="atd-wrap">
        <button class="atd-nav atd-prev" type="button" aria-label="السابق">›</button>
        <div class="atd-track" tabindex="0">${cards}</div>
        <button class="atd-nav atd-next" type="button" aria-label="التالي">‹</button>
      </div>
      <div class="atd-dots">${r.accounts.map((_, i) => `<button class="atd-dot${i === 0 ? ' on' : ''}" type="button" aria-label="حساب ${i + 1}"></button>`).join('')}</div>
      <section class="atd-total">
        <div class="ttl">📊 الإجمالي <em>${r.accounts.length} حسابات</em></div>
        <div class="stats">
          <div class="s"><div class="l">إجمالي الصرف</div><div class="v">${num(total.spend, 'money')}</div></div>
          <div class="s"><div class="l">إجمالي الأوردرات</div><div class="v">${num(total.orders, 'int')}</div></div>
          <div class="s"><div class="l">الكوست أوفر رول</div><div class="v">${num(total.cpa, 'money')}</div></div>
        </div>
      </section>
      <div class="atd-note">${UI.escapeHtml(r.note || '')}</div>
    </div>`;

  const root = body.querySelector('.atd');
  atdWireSlider(root);
  atdAnimate(root);
  root.querySelectorAll('.atd-card').forEach((el, i) => {
    el.tabIndex = 0;
    el.onclick = () => openAccountProducts(r.accounts[i], i);
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAccountProducts(r.accounts[i], i); } };
  });
}

/** Counts every [data-to] up from 0 (ease-out) and fills the share bars; with reduced motion the final values are written at once. */
function atdAnimate(root) {
  const fmt = (v, kind) => (kind === 'money' ? `${UI.fmtNum(Math.round(v))}<small>ج</small>` : UI.fmtNum(Math.round(v)));
  const bars = root.querySelectorAll('.atd-bar > i, .atp-bar > i');
  const nums = [...root.querySelectorAll('[data-to]')];
  if (ATD_REDUCED()) { nums.forEach((el) => { el.innerHTML = fmt(Number(el.dataset.to), el.dataset.kind); }); bars.forEach((b) => { b.style.width = `${b.dataset.w}%`; }); return; }
  requestAnimationFrame(() => bars.forEach((b) => { b.style.width = `${b.dataset.w}%`; })); // the CSS transition fills them
  const DUR = 1000, t0 = performance.now();
  const tick = (now) => {
    if (!root.isConnected) return; // the card was re-rendered meanwhile
    const p = Math.min(1, (now - t0) / DUR), e = 1 - Math.pow(1 - p, 3);
    for (const el of nums) el.innerHTML = fmt(Number(el.dataset.to) * e, el.dataset.kind);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Slider: scroll-snap track + arrows + dots. Direction-agnostic (RTL/LTR) because it only ever uses scrollIntoView on the target card. Arrows/dots hide when every card fits. */
function atdWireSlider(root) {
  const track = root.querySelector('.atd-track');
  const cards = [...track.querySelectorAll('.atd-card')];
  const dots = [...root.querySelectorAll('.atd-dot')];
  const prev = root.querySelector('.atd-prev'), next = root.querySelector('.atd-next');
  const rtl = getComputedStyle(track).direction === 'rtl';
  const startEdge = (el) => { const r = el.getBoundingClientRect(); return rtl ? r.right : r.left; };
  const current = () => { const s = startEdge(track); let best = 0, bd = Infinity; cards.forEach((c, i) => { const d = Math.abs(startEdge(c) - s); if (d < bd) { bd = d; best = i; } }); return best; };
  const go = (i) => cards[Math.max(0, Math.min(cards.length - 1, i))].scrollIntoView({ behavior: ATD_REDUCED() ? 'auto' : 'smooth', inline: 'start', block: 'nearest' });
  const sync = () => {
    const fits = track.scrollWidth <= track.clientWidth + 2;
    root.classList.toggle('atd-fit', fits);
    const i = current();
    const atEnd = Math.abs(track.scrollWidth - track.clientWidth - Math.abs(track.scrollLeft)) < 3; // the last card can't reach the start edge: treat the real end as "last"
    const idx = atEnd ? cards.length - 1 : i;
    dots.forEach((d, k) => d.classList.toggle('on', k === idx));
    prev.disabled = idx <= 0 && Math.abs(track.scrollLeft) < 3;
    next.disabled = atEnd;
  };
  let raf = 0;
  track.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(sync); }, { passive: true });
  window.addEventListener('resize', () => { if (root.isConnected) sync(); });
  prev.onclick = () => go(current() - 1);
  next.onclick = () => go(current() + 1);
  dots.forEach((d, k) => { d.onclick = () => go(k); });
  track.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const forward = rtl ? e.key === 'ArrowLeft' : e.key === 'ArrowRight';
    go(current() + (forward ? 1 : -1));
  });
  sync();
}

// ---------------------------------------------------------------------------
// اضغط على أي حساب → منتجاته النهارده (أوردرات / صرف / كوست)، الأكتر أوردرات فوق، في سلايدر. نفس الشاشة لكل الحسابات.
// ---------------------------------------------------------------------------

const ATP_PER_PAGE = 5;
let atpKeyHandler = null;
let atpGen = 0;

function closeAccountProducts() {
  atpGen += 1;
  document.getElementById('atpOverlay')?.remove();
  if (atpKeyHandler) { document.removeEventListener('keydown', atpKeyHandler); atpKeyHandler = null; }
}

async function openAccountProducts(acc, colorIdx) {
  closeAccountProducts();
  const gen = atpGen;
  const color = ATD_COLORS[colorIdx % ATD_COLORS.length];
  const isToday = state.asOfDate === A.todayStr();
  const dayLabel = isToday ? 'النهارده' : state.asOfDate;
  const ov = document.createElement('div');
  ov.className = 'atp-overlay';
  ov.id = 'atpOverlay';
  ov.innerHTML = `
    <div class="atp-modal" role="dialog" aria-modal="true" style="--acc:${color}">
      <div class="atp-head">
        <div class="atd-avatar">${UI.escapeHtml((acc.name || '?').trim().charAt(0).toUpperCase())}</div>
        <div class="atp-title"><b>${UI.escapeHtml((acc.name || acc.id).trim())}</b><span>📦 المنتجات اللي جابت أوردرات — ${UI.escapeHtml(dayLabel)}</span></div>
        <button class="atp-x" type="button" aria-label="إغلاق">✕</button>
      </div>
      <div class="atp-body"><div class="atd-loading"><div class="atd-skel" style="height:240px"></div></div></div>
    </div>`;
  document.documentElement.appendChild(ov); // not <body>: the embedded page's body carries a transform, which would turn this "fixed" overlay into one as tall as the whole page
  ov.addEventListener('click', (e) => { if (e.target === ov) closeAccountProducts(); });
  ov.querySelector('.atp-x').onclick = closeAccountProducts;
  atpKeyHandler = (e) => { if (e.key === 'Escape') closeAccountProducts(); };
  document.addEventListener('keydown', atpKeyHandler);

  const body = ov.querySelector('.atp-body');
  let r;
  try { r = await api.get(`/api/ai-media-buyer/accounts-today/${encodeURIComponent(acc.id)}/products`, { date: state.asOfDate }); }
  catch (e) { if (gen === atpGen) body.innerHTML = `<div class="atd-err">⚠️ تعذّر تحميل منتجات الحساب: ${UI.escapeHtml(e.message || '')}</div>`; return; }
  if (gen !== atpGen || !r) return;

  const money = (n) => `${UI.fmtNum(Math.round(n))}<small>ج</small>`;
  const num = (n, kind) => (n === null || n === undefined ? '—' : `<span data-to="${n}" data-kind="${kind}">${kind === 'money' ? money(0) : '0'}</span>`);
  const maxOrders = Math.max(1, ...r.products.map((p) => p.orders));
  const medal = (i) => (i === 0 ? ' gold' : i === 1 ? ' silver' : i === 2 ? ' bronze' : '');

  const rowHtml = (p, i) => `
    <div class="atp-row" style="--i:${i % ATP_PER_PAGE}">
      <div class="atp-rank${medal(i)}">${i + 1}</div>
      <div class="atp-main">
        <div class="atp-name">${UI.escapeHtml(p.name)}${p.source === 'NAME' ? '<span class="atp-chip" title="الحملات دي متجمّعة بالاسم المتشابه بس، مش مربوطة بمنتج في السيستم">بالاسم</span>' : ''}</div>
        <div class="atp-sub">${p.campaigns} ${p.campaigns === 1 ? 'حملة' : 'حملات'} · ${UI.fmtNum(Math.round(p.orderShare))}% من أوردرات الحساب</div>
        <div class="atp-bar"><i data-w="${((p.orders / maxOrders) * 100).toFixed(1)}"></i></div>
      </div>
      <div class="atp-stat orders"><div class="l">الأوردرات</div><div class="v">${num(p.orders, 'int')}</div></div>
      <div class="atp-stat"><div class="l">الصرف</div><div class="v">${num(p.spend, 'money')}</div></div>
      <div class="atp-stat cpa"><div class="l">الكوست</div><div class="v">${num(p.cpa, 'money')}</div></div>
    </div>`;

  const pages = [];
  for (let i = 0; i < r.products.length; i += ATP_PER_PAGE) pages.push(r.products.slice(i, i + ATP_PER_PAGE).map((p, k) => rowHtml(p, i + k)).join(''));

  const noOrdersSpend = r.noOrders.reduce((s, p) => s + p.spend, 0);
  const noOrdersHtml = r.noOrders.length ? `
    <details class="atp-noorders">
      <summary>⚠️ صرف من غير أوردرات (${r.noOrders.length}) — ${UI.fmtNum(Math.round(noOrdersSpend))} ج</summary>
      ${r.noOrders.map((p) => `<div class="atp-nrow"><span>${UI.escapeHtml(p.name)}${p.source === 'NAME' ? '<span class="atp-chip">بالاسم</span>' : ''} <small>· ${p.campaigns} ${p.campaigns === 1 ? 'حملة' : 'حملات'}</small></span><b>${UI.fmtNum(Math.round(p.spend))} ج</b></div>`).join('')}
    </details>` : '';

  const t = r.totals;
  body.innerHTML = `
    <div class="atp-sum">
      <div class="s"><div class="l">منتجات جابت أوردرات</div><div class="v">${num(r.products.length, 'int')}</div></div>
      <div class="s"><div class="l">إجمالي الأوردرات</div><div class="v">${num(t.orders, 'int')}</div></div>
      <div class="s"><div class="l">إجمالي الصرف</div><div class="v">${num(t.spend, 'money')}</div></div>
      <div class="s"><div class="l">الكوست أوفر رول</div><div class="v">${num(t.cpa, 'money')}</div></div>
    </div>
    ${pages.length ? `
    <div class="atp-slider">
      <button class="atd-nav atp-prev" type="button" aria-label="السابق">›</button>
      <div class="atp-track" tabindex="0">${pages.map((h) => `<div class="atp-slide">${h}</div>`).join('')}</div>
      <button class="atd-nav atp-next" type="button" aria-label="التالي">‹</button>
    </div>
    <div class="atp-foot"><div class="atd-dots">${pages.map((_, i) => `<button class="atd-dot${i === 0 ? ' on' : ''}" type="button" aria-label="صفحة ${i + 1}"></button>`).join('')}</div><span class="atp-page">صفحة <b>1</b> من ${pages.length}</span></div>`
      : '<div class="atp-empty">لا توجد منتجات جابت أوردرات على الحساب ده في اليوم ده.</div>'}
    ${noOrdersHtml}
    <div class="atd-note">المنتجات بدون علامة مربوطة من الرفع أو الربط. علامة «بالاسم» = تجميع حملات متشابهة في الاسم، مش مربوطة بمنتج في السيستم.</div>`;

  if (pages.length) atpWireSlider(body);
  atdAnimate(body);
}

/** Pages slider (one slide = ATP_PER_PAGE rows): arrows, dots and a page counter; direction-agnostic like the accounts slider. */
function atpWireSlider(root) {
  const track = root.querySelector('.atp-track');
  const slides = [...track.querySelectorAll('.atp-slide')];
  const dots = [...root.querySelectorAll('.atd-dot')];
  const prev = root.querySelector('.atp-prev'), next = root.querySelector('.atp-next');
  const pageEl = root.querySelector('.atp-page b');
  const rtl = getComputedStyle(track).direction === 'rtl';
  const edge = (el) => { const r = el.getBoundingClientRect(); return rtl ? r.right : r.left; };
  const current = () => { const s = edge(track); let best = 0, bd = Infinity; slides.forEach((c, i) => { const d = Math.abs(edge(c) - s); if (d < bd) { bd = d; best = i; } }); return best; };
  const go = (i) => slides[Math.max(0, Math.min(slides.length - 1, i))].scrollIntoView({ behavior: ATD_REDUCED() ? 'auto' : 'smooth', inline: 'start', block: 'nearest' });
  const sync = () => {
    const i = current();
    dots.forEach((d, k) => d.classList.toggle('on', k === i));
    if (pageEl) pageEl.textContent = String(i + 1);
    prev.disabled = i <= 0;
    next.disabled = i >= slides.length - 1;
  };
  let raf = 0;
  track.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(sync); }, { passive: true });
  prev.onclick = () => go(current() - 1);
  next.onclick = () => go(current() + 1);
  dots.forEach((d, k) => { d.onclick = () => go(k); });
  track.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    go(current() + ((rtl ? e.key === 'ArrowLeft' : e.key === 'ArrowRight') ? 1 : -1));
  });
  slides.length < 2 ? (root.querySelector('.atp-slider').classList.add('single'), root.querySelector('.atp-foot').style.display = 'none') : sync();
}

// ---------------------------------------------------------------------------
// 🏆 أفضل المنتجات من كل الحسابات: الأكتر أوردرات بشرط الكوست كويس (<= سقف الكوست، وبحد أدنى من الأوردرات). أول 5، و«عرض المزيد» يفتح الباقي.
// ---------------------------------------------------------------------------

const TP_FIRST = 5;
const TP_MAX = 15;
let topProductsGen = 0;

async function renderTopProducts() {
  const gen = ++topProductsGen; // a slower, older response never overwrites a newer one
  const body = document.getElementById('topProductsBody');
  if (!body) return;
  if (!body.querySelector('.tp')) body.innerHTML = '<div class="atd-loading"><div class="atd-skel" style="height:120px"></div></div>';
  let r;
  try { r = await api.get('/api/ai-media-buyer/top-products-today', { date: state.asOfDate }); }
  catch (e) { if (gen === topProductsGen) body.innerHTML = `<span class="atd-err">⚠️ تعذّر تحميل أفضل المنتجات: ${UI.escapeHtml(e.message || '')}</span>`; return; }
  if (gen !== topProductsGen || !r) return;

  const c = r.criteria || { maxCpa: 150, minOrders: 3 };
  const rule = `الأكتر أوردرات من ${r.accounts} حساب، بشرط الكوست ≤ ${UI.fmtNum(c.maxCpa)} ج وحد أدنى ${c.minOrders} أوردرات`;
  if (!r.products.length) { body.innerHTML = `<div class="tp"><div class="tp-rule">${UI.escapeHtml(rule)}</div><div class="atp-empty">لا يوجد منتج حقق الشرط النهارده.</div></div>`; return; }

  const money = (n) => `${UI.fmtNum(Math.round(n))}<small>ج</small>`;
  const maxOrders = Math.max(1, ...r.products.map((p) => p.orders));
  const medal = (i) => (i === 0 ? ' gold' : i === 1 ? ' silver' : i === 2 ? ' bronze' : '');
  const rowHtml = (p, i, delay) => {
    const chips = p.accounts.slice(0, 4).map((a) => `<span class="tp-acct">${UI.escapeHtml(a.name)} <b>${UI.fmtNum(a.orders)}</b></span>`).join('') + (p.accounts.length > 4 ? `<span class="tp-acct more">+${p.accounts.length - 4}</span>` : '');
    return `
    <div class="atp-row" style="--i:${delay}">
      <div class="atp-rank${medal(i)}">${i + 1}</div>
      <div class="atp-main">
        <div class="atp-name">${UI.escapeHtml(p.name)}${p.source === 'NAME' ? '<span class="atp-chip" title="الحملات دي متجمّعة بالاسم المتشابه بس، مش مربوطة بمنتج في السيستم">بالاسم</span>' : ''}</div>
        <div class="atp-sub">${p.campaigns} ${p.campaigns === 1 ? 'حملة' : 'حملات'} · ${p.accounts.length} ${p.accounts.length === 1 ? 'حساب' : 'حسابات'}</div>
        <div class="tp-accts">${chips}</div>
        <div class="atp-bar"><i data-w="${((p.orders / maxOrders) * 100).toFixed(1)}"></i></div>
      </div>
      <div class="atp-stat orders"><div class="l">الأوردرات</div><div class="v"><span data-to="${p.orders}" data-kind="int">0</span></div></div>
      <div class="atp-stat"><div class="l">الصرف</div><div class="v"><span data-to="${p.spend}" data-kind="money">${money(0)}</span></div></div>
      <div class="atp-stat cpa"><div class="l">الكوست</div><div class="v"><span data-to="${p.cpa}" data-kind="money">${money(0)}</span></div></div>
    </div>`;
  };

  const list = r.products.slice(0, TP_MAX);
  const first = list.slice(0, TP_FIRST), more = list.slice(TP_FIRST);
  body.innerHTML = `
    <div class="tp" style="--acc:#ff7a1a">
      <div class="tp-rule">${UI.escapeHtml(rule)}</div>
      <div class="tp-list">${first.map((p, i) => rowHtml(p, i, i)).join('')}</div>
      ${more.length ? `
      <div class="tp-list tp-more" hidden>${more.map((p, i) => rowHtml(p, TP_FIRST + i, i)).join('')}</div>
      <div class="tp-btnwrap"><button class="tp-btn" type="button" aria-expanded="false"><span class="t">عرض المزيد (${more.length})</span><span class="ar">⌄</span></button></div>` : ''}
    </div>`;

  const root = body.querySelector('.tp');
  atdAnimate(root);
  const btn = root.querySelector('.tp-btn');
  if (btn) btn.onclick = () => {
    const box = root.querySelector('.tp-more');
    const open = box.hasAttribute('hidden');
    if (open) {
      box.querySelectorAll('.atp-bar > i').forEach((b) => { b.style.width = '0'; });
      box.removeAttribute('hidden');
      void box.offsetWidth; // restart the row / bar animations from zero
      atdAnimate(box);
    } else box.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', String(open));
    btn.querySelector('.t').textContent = open ? 'عرض أقل' : `عرض المزيد (${more.length})`;
    btn.classList.toggle('open', open);
  };
}

// ---------------------------------------------------------------------------
// 📈 كسبان ولا خسران؟ — منتج واحد × فترة (آخر 3 أيام / 7 / 30 / كل الفترة) على كل الحسابات: الصرف والأوردرات والكوست، وتقدير الربح.
// الربح = أوردرات × نسبة التسليم × (سعر البيع − التكلفة) − الصرف. الأرقام الناقصة (سعر / تكلفة / نسبة تسليم) بتتكتب باليد، ومش بتتحفظ.
// ---------------------------------------------------------------------------

const PF_PERIODS = [['last3', 'آخر 3 أيام'], ['last7', 'آخر 7 أيام'], ['last30', 'آخر 30 يوم'], ['all', 'كل الفترة']];
const pf = { products: null, productId: null, period: 'last7', data: null, gen: 0, manual: null };

function pfStore(key, val) { try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch { /* storage may be unavailable */ } return null; }

async function initProfitCard() {
  const body = document.getElementById('profitBody');
  if (!body) return;
  pf.period = PF_PERIODS.some(([k]) => k === pfStore('pfPeriod')) ? pfStore('pfPeriod') : 'last7';
  const saved = Number(pfStore('pfProduct'));
  pf.productId = Number.isInteger(saved) && saved > 0 ? saved : null;
  body.innerHTML = '<div class="atd-loading"><div class="atd-skel" style="height:90px"></div></div>';
  try { pf.products = (await api.get('/api/ai-media-buyer/product-profit/products')).products || []; }
  catch (e) { body.innerHTML = `<span class="atd-err">⚠️ تعذّر تحميل قائمة المنتجات: ${UI.escapeHtml(e.message || '')}</span>`; return; }
  if (pf.productId && !pf.products.some((p) => p.productId === pf.productId)) pf.productId = null;
  pfRenderShell();
  if (pf.productId) pfLoad();
}

function pfRenderShell() {
  const body = document.getElementById('profitBody');
  const opts = (pf.products || []).map((p) => `<option value="${p.productId}"${p.productId === pf.productId ? ' selected' : ''}>${UI.escapeHtml(p.name)}</option>`).join('');
  body.innerHTML = `
    <div class="pf">
      <div class="pf-controls">
        <div class="pf-pick">
          <input class="pf-search" type="search" placeholder="🔎 دوّر على منتج…" aria-label="بحث عن منتج">
          <select class="pf-select" aria-label="المنتج"><option value="">— اختار المنتج —</option>${opts}</select>
        </div>
        <div class="pf-periods" role="group" aria-label="الفترة">${PF_PERIODS.map(([k, l]) => `<button type="button" class="pf-chip${k === pf.period ? ' on' : ''}" data-p="${k}">${l}</button>`).join('')}</div>
      </div>
      <div class="pf-result"><div class="pf-hint">اختار منتج وفترة، وهتشوف صرفه وأوردراته وكوستُه وكسبان ولا خسران.</div></div>
    </div>`;
  const root = body.querySelector('.pf');
  const sel = root.querySelector('.pf-select'), search = root.querySelector('.pf-search');
  sel.onchange = () => { pf.productId = Number(sel.value) || null; pf.manual = null; pfStore('pfProduct', String(pf.productId || '')); if (pf.productId) pfLoad(); else root.querySelector('.pf-result').innerHTML = '<div class="pf-hint">اختار منتج وفترة.</div>'; };
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    const keep = pf.productId;
    sel.innerHTML = '<option value="">— اختار المنتج —</option>' + (pf.products || []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.productId === keep).map((p) => `<option value="${p.productId}"${p.productId === keep ? ' selected' : ''}>${UI.escapeHtml(p.name)}</option>`).join('');
  };
  root.querySelectorAll('.pf-chip').forEach((b) => { b.onclick = () => { pf.period = b.dataset.p; pfStore('pfPeriod', pf.period); root.querySelectorAll('.pf-chip').forEach((x) => x.classList.toggle('on', x === b)); if (pf.productId) pfLoad(); }; });
}

async function pfLoad() {
  const gen = ++pf.gen;
  const res = document.querySelector('#profitBody .pf-result');
  if (!res) return;
  res.innerHTML = '<div class="atd-loading"><div class="atd-skel" style="height:220px"></div></div>';
  let d;
  try { d = await api.get('/api/ai-media-buyer/product-profit', { productId: pf.productId, period: pf.period }); }
  catch (e) { if (gen === pf.gen) res.innerHTML = `<span class="atd-err">⚠️ ${UI.escapeHtml(e.message || 'تعذّر الحساب')}</span>`; return; }
  if (gen !== pf.gen || !d) return;
  pf.data = d;
  const ec = d.economics || {};
  pf.manual = { price: ec.available ? ec.sellingPrice : '', cost: ec.available ? ec.unitCost : '', share: ec.available ? Math.round(ec.deliveredShare * 100) : 100, edited: false };
  pfRenderResult();
}

/** The profit under the numbers currently typed in (or the server's own estimate while nothing was edited). */
function pfCalc() {
  const d = pf.data, m = pf.manual, t = d.totals;
  if (!m.edited && d.economics?.available) return { profit: d.profit.estimated, source: 'SYSTEM', gross: d.economics.grossPerDelivered, share: d.economics.deliveredShare, contribution: d.economics.contributionPerOrder };
  const price = Number(m.price), cost = Number(m.cost), share = Number(m.share) / 100;
  if (!(price > 0) || !(cost >= 0) || m.cost === '' || !(share > 0 && share <= 1)) return { profit: null, source: 'NONE' };
  const gross = price - cost, contribution = share * gross;
  return { profit: Math.round((t.orders * contribution - t.spend) * 100) / 100, source: 'MANUAL', gross, share, contribution };
}

function pfVerdict(profit, spend, orders) {
  if (!(spend > 0) && !(orders > 0)) return 'NO_DATA';
  if (profit === null) return 'UNKNOWN';
  const band = Math.max(50, 0.02 * spend);
  return profit > band ? 'WIN' : profit < -band ? 'LOSS' : 'BREAKEVEN';
}

function pfRenderResult() {
  const res = document.querySelector('#profitBody .pf-result');
  const d = pf.data, t = d.totals, m = pf.manual;
  const calc = pfCalc();
  const verdict = pfVerdict(calc.profit, t.spend, t.orders);
  const money = (n) => `${UI.fmtNum(Math.round(n))}<small>ج</small>`;
  const cnt = (n, kind) => (n === null || n === undefined ? '—' : `<span data-to="${n}" data-kind="${kind}">${kind === 'money' ? money(0) : '0'}</span>`);
  const V = {
    WIN: ['win', '🟢 كسبان', `صافي ربح تقديري ${UI.fmtNum(Math.round(calc.profit || 0))} ج`],
    LOSS: ['loss', '🔴 خسران', `صافي خسارة تقديرية ${UI.fmtNum(Math.round(Math.abs(calc.profit || 0)))} ج`],
    BREAKEVEN: ['even', '🟡 تعادل تقريبًا', `الفرق ${UI.fmtNum(Math.round(calc.profit || 0))} ج`],
    UNKNOWN: ['unk', '⚪ الربح غير محسوب', 'اكتب سعر البيع والتكلفة تحت وهيتحسب'],
    NO_DATA: ['unk', '⚪ مفيش صرف في الفترة دي', 'جرّب فترة أطول'],
  }[verdict];

  const beShare = calc.gross > 0 && t.orders > 0 ? t.spend / (t.orders * calc.gross) : null;
  // per ORDER: what one order leaves before the ad, and after paying for it (the cost per order)
  const perBefore = calc.contribution ?? null;
  const perAfter = perBefore !== null && t.cpa !== null ? perBefore - t.cpa : null;
  const signed = (n) => (n === null ? '—' : `<span class="sg">${n < 0 ? '−' : ''}</span>${cnt(Math.abs(n), 'money')}`);
  const w = d.window;
  const note = d.linkedCampaigns === 0 ? '<div class="pf-warn">⚠️ المنتج ده مالوش حملات مربوطة في السيستم، فمفيش أرقام. اربط حملاته الأول.</div>' : '';
  const hist = d.history || { historyDays: 0, incomplete: [] };
  const dataNote = hist.incomplete.length
    ? `<div class="pf-warn">⚠️ تعذّر تحميل التاريخ القديم من Meta لحسابات: ${UI.escapeHtml(hist.incomplete.join('، '))}. الأرقام ناقصة للأيام القديمة بتاعتهم، جرّب تاني بعد دقايق.</div>`
    : (hist.historyDays > 0 ? '<div class="pf-sub">الأيام القديمة مقروءة مباشرة من Meta</div>' : '');
  const srcTxt = calc.source === 'SYSTEM'
    ? (d.economics.deliveredShareSource === 'ASSUMED_100' ? 'بافتراض إن كل أوردر اتسلّم (100%)' : 'بنسب التأكيد/التسليم المسجّلة للمنتج')
    : calc.source === 'MANUAL' ? 'بالأرقام اللي كتبتها (من غير تكلفة المرتجع)' : '';

  const maxSpend = Math.max(1, ...d.daily.map((x) => x.spend));
  const dayProfit = (x) => (calc.contribution != null ? x.orders * calc.contribution - x.spend : null);
  const step = d.daily.length > 31 ? Math.ceil(d.daily.length / 20) : 1;
  const cols = d.daily.map((x, i) => {
    const p = dayProfit(x);
    const cls = !x.hasData ? ' nodata' : p === null ? '' : p >= 0 ? ' up' : ' down';
    const tip = `${x.date} · صرف ${UI.fmtNum(Math.round(x.spend))} ج · ${x.orders} أوردر${x.cpa !== null ? ` · كوست ${UI.fmtNum(Math.round(x.cpa))} ج` : ''}${p !== null && x.hasData ? ` · ${p >= 0 ? 'ربح' : 'خسارة'} ${UI.fmtNum(Math.round(Math.abs(p)))} ج` : ''}`;
    return `<div class="pf-col${cls}" title="${UI.escapeHtml(tip)}" style="--i:${Math.min(i, 30)}"><div class="n">${x.orders || ''}</div><div class="bar"><i data-h="${((x.spend / maxSpend) * 100).toFixed(1)}"></i></div><div class="d">${i % step === 0 ? x.date.slice(8) : ''}</div></div>`;
  }).join('');

  const accts = d.accounts.map((a) => `<div class="pf-acct"><span class="nm">${UI.escapeHtml(a.name)}</span><span>${UI.fmtNum(a.orders)} أوردر</span><span>${UI.fmtNum(Math.round(a.spend))} ج</span><span class="cpa">${a.cpa === null ? '—' : UI.fmtNum(Math.round(a.cpa)) + ' ج'}</span></div>`).join('');

  res.innerHTML = `
    ${note}
    <div class="pf-verdict ${V[0]}">
      <div class="big">${V[1]}</div>
      <div class="det"><b>${UI.escapeHtml(d.name)}</b><span>${V[2]}${srcTxt ? ' · ' + srcTxt : ''}</span><span class="pf-sub">من ${UI.escapeHtml(w.from)} إلى ${UI.escapeHtml(w.to)} (${w.days} يوم)</span>${dataNote}</div>
    </div>
    <div class="pf-kpis">
      <div class="pf-kpi"><div class="l">الصرف</div><div class="v">${cnt(t.spend, 'money')}</div></div>
      <div class="pf-kpi"><div class="l">الأوردرات</div><div class="v">${cnt(t.orders, 'int')}</div></div>
      <div class="pf-kpi"><div class="l">الكوست</div><div class="v">${cnt(t.cpa, 'money')}</div></div>
      <div class="pf-kpi" title="سعر البيع − تكلفة المنتج والشحن، مضروب في نسبة التسليم"><div class="l">ربح الأوردر قبل الإعلان</div><div class="v">${signed(perBefore)}</div></div>
      <div class="pf-kpi ${perAfter === null ? '' : perAfter >= 0 ? 'win' : 'loss'}" title="ربح الأوردر قبل الإعلان − الكوست (تكلفة الإعلان لكل أوردر)"><div class="l">ربح الأوردر بعد الإعلان</div><div class="v">${signed(perAfter)}</div></div>
      <div class="pf-kpi ${V[0]}"><div class="l">صافي الربح / الخسارة</div><div class="v">${calc.profit === null ? '—' : `<span class="sg">${calc.profit < 0 ? '−' : '+'}</span>${cnt(Math.abs(calc.profit), 'money')}`}</div></div>
    </div>
    <div class="pf-calc">
      <div class="pf-calc-t">🧮 احسب بأرقامك ${d.economics?.available ? '<small>(معبّاة من بيانات المنتج)</small>' : `<small>(${UI.escapeHtml(d.economics?.reason || 'مفيش سعر وتكلفة')})</small>`}</div>
      <div class="pf-fields">
        <label>سعر البيع للأوردر (ج)<input class="pf-in" data-k="price" type="number" min="0" step="1" value="${m.price === '' ? '' : m.price}"></label>
        <label title="اللي بتدفعه عشان توصّل أوردر واحد للعميل من غير الإعلان: المنتج + الشحن + التغليف">تكلفة المنتج والشحن للأوردر — من غير الإعلان (ج)<input class="pf-in" data-k="cost" type="number" min="0" step="1" value="${m.cost === '' ? '' : m.cost}"></label>
        <label>نسبة اللي بيتسلّم (%)<input class="pf-in" data-k="share" type="number" min="1" max="100" step="1" value="${m.share}"></label>
      </div>
      <div class="pf-help">مثال: المنتج 60 ج + الشحن 30 ج = 90 ج. ده مش تكلفة الإعلان (الكوست)، الإعلان بيتخصم لوحده من الصرف.</div>
      <div class="pf-be">${beShare === null ? 'اكتب السعر والتكلفة عشان نحسب النسبة اللي بيكسب عندها.' : beShare > 1 ? '⚠️ حتى لو كل الأوردرات اتسلّمت المنتج بيخسر بالصرف ده.' : `بيكسب طالما نسبة التسليم <b>${UI.fmtNum(Math.ceil(beShare * 100))}%</b> أو أكتر.`}</div>
    </div>
    ${d.daily.length ? `<div class="pf-chart-t">الصرف كل يوم <small>(الرقم فوق العمود = عدد الأوردرات${calc.contribution != null ? ' · أخضر = يوم كسبان، أحمر = يوم خسران' : ''})</small></div><div class="pf-chart" dir="ltr">${cols}</div>` : ''}
    ${accts ? `<div class="pf-accts"><div class="pf-chart-t">حسب الحساب</div>${accts}</div>` : ''}
    <div class="atd-note">الأوردرات = مشتريات Meta (Website Purchases) وبتتحدّث كل 15 دقيقة تقريبًا. الربح تقدير، مش حسابات محاسبية.</div>`;

  const root = res;
  atdAnimate(root);
  root.querySelectorAll('.pf-col .bar > i').forEach((b) => { b.style.height = ATD_REDUCED() ? `${b.dataset.h}%` : '0%'; });
  if (!ATD_REDUCED()) requestAnimationFrame(() => requestAnimationFrame(() => root.querySelectorAll('.pf-col .bar > i').forEach((b) => { b.style.height = `${b.dataset.h}%`; })));
  root.querySelectorAll('.pf-in').forEach((inp) => {
    inp.oninput = () => {
      pf.manual[inp.dataset.k] = inp.value === '' ? '' : Number(inp.value);
      pf.manual.edited = true;
      clearTimeout(pf.t); pf.t = setTimeout(() => { const k = inp.dataset.k; pfRenderResult(); const again = document.querySelector(`#profitBody .pf-in[data-k="${k}"]`); if (again) { again.focus(); const v = again.value; again.value = ''; again.value = v; } }, 450);
    };
  });
}

// ---------------------------------------------------------------------------
// 2 / 3. ظبطت / ريحت النهارده — Today vs Yesterday فقط، بدون أي نسبة،
// وبدون انتظار تأكيد متعدد الأيام (هذا ليس القرار، القرار في 🎯 تاسكات اليوم).
// ---------------------------------------------------------------------------

function simpleChangeCard(x) {
  const { product, a, score, decision } = x;
  return `
  <div class="drawer-timeline-row" data-id="${product.id}" style="cursor:pointer; padding:8px 0; align-items:center;">
    <span>${UI.escapeHtml(product.product_name)}</span>
    <span style="display:flex; align-items:center; gap:10px;">
      <span class="mono">${a.yesterday ?? '—'} → ${a.today ?? '—'} <b style="color:${a.change.abs > 0 ? 'var(--green)' : 'var(--red)'}">${UI.fmtChangeAbs(a.change.abs)}</b></span>
      ${UI.scoreCircleHtml(score, 'sm')}
      <span class="rec-pill ${decision.action.code}" style="font-size:10px; padding:1px 6px;">${decision.action.label}</span>
    </span>
  </div>`;
}

function wireSimpleCards(container) {
  container.querySelectorAll('[data-id]').forEach((el) => {
    el.onclick = () => openProductDrawer(el.dataset.id, refresh);
  });
  wireScoreTriggers(container, (id) => {
    const item = items.find((x) => String(x.product.id) === String(id));
    return { name: item.product.product_name, result: item.score };
  });
}

// "ظبطت/ريحت" هنا = Today vs Yesterday المباشرة فقط (بدون انتظار تأكيد
// متعدد الأيام) — المنتجات اللي وصلت لصفر ليها قسمها المستقل "بدون أوردر"
// فلا تتكرر هنا (نفس منطق renderIntervention أدناه).

function renderImproved() {
  const list = items
    .filter((x) => x.a.change.abs !== null && x.a.change.abs > 0)
    .sort((x, y) => y.a.change.abs - x.a.change.abs)
    .slice(0, 8);
  const body = document.getElementById('improvedBody');
  body.innerHTML = list.length ? list.map(simpleChangeCard).join('') : '<div class="empty-state">لا يوجد منتج تحسن عن أمس.</div>';
  wireSimpleCards(body);
}

function renderDeclined() {
  const list = items
    .filter((x) => x.a.change.abs !== null && x.a.change.abs < 0 && x.a.today !== 0)
    .sort((x, y) => x.a.change.abs - y.a.change.abs)
    .slice(0, 8);
  const body = document.getElementById('declinedBody');
  body.innerHTML = list.length ? list.map(simpleChangeCard).join('') : '<div class="empty-state">لا يوجد منتج تراجع عن أمس. 👍</div>';
  wireSimpleCards(body);
}

// ---------------------------------------------------------------------------
// 🚨 منتجات بدون أوردر — صفر صريح بعد نشاط حقيقي (STOPPED)، قسم مستقل
// وواضح لأنه أكثر الحالات إلحاحًا (spec section 6).
// ---------------------------------------------------------------------------

function renderZeroOrder() {
  const list = items.filter((x) => x.dailyStatus.code === 'STOPPED').sort((x, y) => (y.a.avg7 ?? 0) - (x.a.avg7 ?? 0));
  const body = document.getElementById('zeroOrderBody');
  if (list.length === 0) {
    body.innerHTML = '<div class="empty-state">لا يوجد منتج بدون أوردر النهارده. 👍</div>';
    return;
  }
  body.innerHTML = list
    .map(
      (x) => `
    <div class="action-card STOP_CANDIDATE" data-id="${x.product.id}" style="cursor:pointer;">
      <div class="action-card-title">🚨 ${UI.escapeHtml(x.product.product_name)}</div>
      <div class="action-card-metrics">
        <span class="mono">${x.a.yesterday ?? '—'} ← 0</span>
        <span>الفرق: ${UI.fmtChangeAbs(x.a.change.abs)}</span>
      </div>
      <div class="action-card-reasons">${UI.escapeHtml(x.decision.note)}</div>
    </div>`
    )
    .join('');
  body.querySelectorAll('[data-id]').forEach((el) => (el.onclick = () => openProductDrawer(el.dataset.id, refresh)));
}

// ---------------------------------------------------------------------------
// 4. محتاجة تدخل — Score < 50، أو تراجع متتالي (المنتجات بدون أوردر لها
// قسمها المستقل أعلاه فلا تتكرر هنا).
// ---------------------------------------------------------------------------

function renderIntervention() {
  const list = items
    .filter((x) => x.dailyStatus.code !== 'STOPPED' && ((x.score.score !== null && x.score.score < 50) || x.a.declineStreak >= (settings.consecutiveDeclineDays || 4)))
    .sort((x, y) => (x.score.score ?? 0) - (y.score.score ?? 0))
    .slice(0, 8);

  const body = document.getElementById('interventionBody');
  if (list.length === 0) {
    body.innerHTML = '<div class="empty-state">لا يوجد منتج يحتاج تدخل عاجل النهارده. 👍</div>';
    return;
  }
  body.innerHTML = list
    .map(
      (x) => `
    <div class="action-card ${x.decision.action.code}" data-id="${x.product.id}" style="cursor:pointer;">
      <div class="action-card-title">${x.dailyStatus.icon} ${UI.escapeHtml(x.product.product_name)}</div>
      <div class="action-card-metrics">
        <span class="mono">${x.a.yesterday ?? '—'} ← ${x.a.today ?? '—'}</span>
        <span>${UI.fmtChangeAbs(x.a.change.abs)}</span>
        <span>${UI.scoreCircleHtml(x.score, 'sm')}</span>
      </div>
      <div class="action-card-reasons">${UI.escapeHtml(x.decision.note)}</div>
    </div>`
    )
    .join('');
  body.querySelectorAll('[data-id]').forEach((el) => (el.onclick = () => openProductDrawer(el.dataset.id, refresh)));
  wireScoreTriggers(body, (id) => {
    const item = items.find((x) => String(x.product.id) === String(id));
    return { name: item.product.product_name, result: item.score };
  });
}

// ---------------------------------------------------------------------------
// 5. 🏆 أفضل 4 منتجات — Score DESC
// ---------------------------------------------------------------------------

const MEDALS = ['🥇', '🥈', '🥉', '🏅'];

function renderTop4() {
  const top = items
    .filter((x) => x.score.score !== null)
    .sort((x, y) => y.score.score - x.score.score)
    .slice(0, 4);

  const body = document.getElementById('top4Body');
  if (top.length === 0) {
    body.innerHTML = '<div class="empty-state">لا توجد بيانات كافية بعد لحساب التقييم.</div>';
    return;
  }
  body.innerHTML = top
    .map(
      (x, i) => `
    <div class="top4-card" data-id="${x.product.id}">
      <span class="top4-medal">${MEDALS[i]}</span>
      <div class="top4-info">
        <div class="top4-name">${UI.escapeHtml(x.product.product_name)}</div>
        <div class="top4-metrics">اليوم: ${x.a.today ?? '—'} · أمس: ${x.a.yesterday ?? '—'} · <span class="rec-pill ${x.decision.action.code}" style="font-size:10px; padding:1px 6px;">${x.decision.action.label}</span></div>
      </div>
      ${UI.scoreCircleHtml(x.score, 'sm')}
    </div>`
    )
    .join('');
  body.querySelectorAll('.top4-card').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('[data-score-trigger]')) return;
      openProductDrawer(el.dataset.id, refresh);
    };
  });
  wireScoreTriggers(body, (id) => {
    const item = items.find((x) => String(x.product.id) === String(id));
    return { name: item.product.product_name, result: item.score };
  });
}

// ---------------------------------------------------------------------------
// 🎯 خطة العمل (Action Plan) — مجموعة مختصرة (حتى 5 لكل قسم)، القائمة
// الكاملة والتنفيذ الفعلي (✅/❌) في 🎯 تاسكات اليوم — هنا فقط للمعاينة.
// ---------------------------------------------------------------------------

const ACTION_PLAN_GROUPS = [
  { codes: ['SCALE_UP'], title: '🔥 SCALE' },
  { codes: ['REDUCE'], title: '⬇️ REDUCE' },
  { codes: ['STOP_CANDIDATE', 'REVIEW_NOW'], title: '🚨 PAUSE / REVIEW' },
  { codes: ['CONTINUE', 'INSUFFICIENT_DATA'], title: '👀 MONITOR' },
];

function renderActionPlan() {
  const body = document.getElementById('actionPlanBody');
  const sections = ACTION_PLAN_GROUPS.map((g) => ({
    ...g,
    items: items.filter((x) => g.codes.includes(x.decision.action.code)).sort((x, y) => Math.abs(y.a.change.abs ?? 0) - Math.abs(x.a.change.abs ?? 0)),
  }));

  body.innerHTML = sections
    .map((s) => {
      const shown = s.items.slice(0, 5);
      const more = s.items.length - shown.length;
      return `
      <div class="action-group">
        <div class="action-group-title">${s.title} <span class="faint" style="font-weight:400; font-size:12px;">(${s.items.length})</span></div>
        ${
          shown.length === 0
            ? '<div class="empty-state">لا يوجد منتج في هذه المجموعة النهارده.</div>'
            : shown
                .map(
                  (x) => `
          <div class="action-card ${x.decision.action.code}" data-id="${x.product.id}" style="cursor:pointer;">
            <div class="action-card-title">${UI.escapeHtml(x.product.product_name)}</div>
            <div class="action-card-metrics"><span class="mono">${x.a.yesterday ?? '—'} ← ${x.a.today ?? '—'}</span></div>
            <div class="action-card-reasons">${UI.escapeHtml(x.decision.note)}</div>
          </div>`
                )
                .join('')
        }
        ${more > 0 ? `<a href="tasks.html" class="faint" style="font-size:12px;">+${more} أكتر في 🎯 تاسكات اليوم ↗</a>` : ''}
      </div>`;
    })
    .join('');
  body.querySelectorAll('[data-id]').forEach((el) => (el.onclick = () => openProductDrawer(el.dataset.id, refresh)));
}

// ---------------------------------------------------------------------------
// 🛠️ الشغل اللي هيتعمل — teaser only, full workflow lives in work.html
// ---------------------------------------------------------------------------

async function renderWorkTeaser() {
  const actionable = items.filter((x) => ['URGENT', 'IMPORTANT'].includes(x.task.priority.code));
  const top = topTasks(actionable.map((x) => x.task), 4);
  const body = document.getElementById('workTeaserBody');
  if (top.length === 0) {
    body.innerHTML = '<div class="empty-state">لا يوجد شغل عاجل النهارده. 👍</div>';
    return;
  }

  const [assignRows, employees] = await Promise.all([TaskAssignments.forDate(state.asOfDate), TeamMembers.all()]);
  const assignMap = new Map(assignRows.map((r) => [r.product_id, r.employee_id]));
  const empMap = new Map(employees.map((e) => [e.id, e.name]));

  body.innerHTML = top
    .map((t) => {
      const item = actionable.find((x) => x.product.id === t.productId);
      const empName = empMap.get(assignMap.get(t.productId));
      return `
      <div class="drawer-timeline-row" data-id="${t.productId}" style="cursor:pointer; padding:8px 0;">
        <span>${t.taskType.icon} ${UI.escapeHtml(t.productName)} ${empName ? `<span class="faint" style="font-size:11px;">— 👤 ${UI.escapeHtml(empName)}</span>` : ''}</span>
        <span style="font-size:12px; color:var(--text-dim);">${t.priority.icon} ${UI.escapeHtml(item.decision.action.label)}</span>
      </div>`;
    })
    .join('');
  body.querySelectorAll('[data-id]').forEach((el) => (el.onclick = () => openProductDrawer(el.dataset.id, refresh)));
}

// ---------------------------------------------------------------------------
// 📋 تقرير اليوم
// ---------------------------------------------------------------------------

function toggleDailyReport() {
  const card = document.getElementById('dailyReportCard');
  const showing = card.style.display !== 'none';
  card.style.display = showing ? 'none' : 'block';
  if (!showing) renderDailyReport();
}

function buildDailyReportText() {
  const byAction = (code) => items.filter((x) => x.decision.action.code === code).length;
  const improved = items.filter((x) => x.a.change.abs !== null && x.a.change.abs > 0).length;
  const declined = items.filter((x) => x.a.change.abs !== null && x.a.change.abs < 0 && x.a.today !== 0).length;
  const zeroOrder = items.filter((x) => x.dailyStatus.code === 'STOPPED').length;

  const lines = [];
  lines.push(`📋 تقرير اليوم — ${state.asOfDate}`);
  lines.push('');
  lines.push(`إجمالي المنتجات: ${items.length}`);
  lines.push(`🟢 ظبطت: ${improved}`);
  lines.push(`🔴 ريحت: ${declined}`);
  lines.push(`🚨 بدون أوردر: ${zeroOrder}`);
  lines.push(`🔥 Scale: ${byAction('SCALE_UP')}`);
  lines.push(`⬇️ Reduce: ${byAction('REDUCE')}`);
  lines.push(`🚨 Review: ${byAction('STOP_CANDIDATE') + byAction('REVIEW_NOW')}`);
  lines.push(`👀 Monitor: ${byAction('CONTINUE') + byAction('INSUFFICIENT_DATA')}`);
  lines.push('');

  const top4 = items.filter((x) => x.score.score !== null).sort((x, y) => y.score.score - x.score.score).slice(0, 4);
  if (top4.length > 0) {
    lines.push('———  🏆 Top 4  ———');
    top4.forEach((x, i) => lines.push(`${i + 1}. ${x.product.product_name} — Score ${x.score.score} — ${x.a.yesterday ?? '—'} ← ${x.a.today ?? '—'}`));
    lines.push('');
  }

  const needsAttention = items
    .filter((x) => x.dailyStatus.code !== 'STOPPED' && ((x.score.score !== null && x.score.score < 50) || x.a.declineStreak >= (settings.consecutiveDeclineDays || 4)))
    .sort((x, y) => (x.score.score ?? 0) - (y.score.score ?? 0));
  if (needsAttention.length > 0) {
    lines.push('———  🚨 محتاجة تدخل  ———');
    for (const x of needsAttention) lines.push(`${x.product.product_name} — ${x.a.yesterday ?? '—'} ← ${x.a.today ?? '—'} — ${x.decision.action.label}`);
    lines.push('');
  }

  lines.push('———  🎯 Action Plan  ———');
  for (const g of ACTION_PLAN_GROUPS) {
    const groupItems = items.filter((x) => g.codes.includes(x.decision.action.code));
    if (groupItems.length === 0) continue;
    lines.push(`${g.title} (${groupItems.length})`);
    for (const x of groupItems) lines.push(`  • ${x.product.product_name}: ${x.decision.note}`);
  }

  return lines.join('\n');
}

function renderDailyReport() {
  document.getElementById('dailyReportBody').textContent = buildDailyReportText();
}

// ---------------------------------------------------------------------------
// 📅 كل يوم جاب كام أوردر — أعمدة اليوم بالنسبة للشهر كله (مشتريات Meta لكل الحسابات)، والضغط على عمود يفتح منتجات اليوم ده، وفيه سلايدر بين الأيام.
// ---------------------------------------------------------------------------

const MD_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
let mdMonth = null; // YYYY-MM currently shown (null = the month of the dashboard date)
let mdAnchor = null;
let mdGen = 0;
let mdDoc = null;
let mdKeyHandler = null;
let mdOpenDay = null;

const mdMonthLabel = (m) => `${MD_MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const mdShift = (m, delta) => { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + delta, 1)); return d.toISOString().slice(0, 7); };
const mdMoney = (n) => `${UI.fmtNum(Math.round(n))}<small>ج</small>`;
const mdNum = (n, kind) => (n === null || n === undefined ? '—' : `<span data-to="${n}" data-kind="${kind}">${kind === 'money' ? mdMoney(0) : '0'}</span>`);

async function renderMonthDays(force) {
  const body = document.getElementById('monthDaysBody');
  if (!body) return;
  const gen = ++mdGen; // a slower, older response never overwrites a newer one
  const month = mdMonth || String(state.asOfDate || A.todayStr()).slice(0, 7);
  mdMonth = month;
  if (!body.querySelector('.md')) body.innerHTML = '<div class="atd-loading"><div class="atd-skel" style="height:230px"></div></div>';
  let r;
  try { r = await api.get('/api/ai-media-buyer/orders-by-day', { month, force: force ? '1' : '' }); }
  catch (e) { if (gen === mdGen) body.innerHTML = `<span class="atd-err">⚠️ تعذّر تحميل أوردرات الأيام: ${UI.escapeHtml(e.message || '')}</span>`; return; }
  if (gen !== mdGen || !r) return;
  mdDoc = r;

  const todayStr = A.todayStr();
  const isCurrent = month === todayStr.slice(0, 7);
  const maxOrders = Math.max(1, ...r.days.map((d) => d.orders));
  const best = r.bestDay?.date || null;
  const bars = r.days.map((d, i) => {
    const h = d.hasData ? Math.max(4, Math.round((d.orders / maxOrders) * 100)) : 0;
    const cls = ['md-col', d.future ? 'is-future' : '', !d.hasData ? 'is-empty' : '', d.date === todayStr ? 'is-today' : '', d.date === best ? 'is-best' : ''].filter(Boolean).join(' ');
    const label = d.future ? '' : d.hasData ? UI.fmtNum(d.orders) : '—';
    const title = d.future ? `${d.day} — لسه ما جاش` : d.hasData ? `يوم ${d.day}: ${d.orders} أوردر · صرف ${UI.fmtNum(Math.round(d.spend))} ج` : `يوم ${d.day}: مفيش بيانات`;
    return `
      <button type="button" class="${cls}" data-day="${d.date}" style="--i:${i}" ${d.future ? 'disabled' : ''} title="${UI.escapeHtml(title)}" aria-label="${UI.escapeHtml(title)}">
        <span class="md-val">${d.date === best ? '<em aria-hidden="true">👑</em>' : ''}${label}</span>
        <span class="md-bar"><i style="--h:${h}%"></i></span>
        <span class="md-day">${d.day}</span>
      </button>`;
  }).join('');

  body.innerHTML = `
    <section class="md">
      <div class="md-head">
        <div class="md-title">📅 أوردرات كل يوم <em>${UI.escapeHtml(mdMonthLabel(month))}</em></div>
        <div class="md-nav">
          <button type="button" class="md-arrow" data-md="prev" aria-label="الشهر السابق">›</button>
          <button type="button" class="md-arrow" data-md="next" aria-label="الشهر التالي" ${isCurrent ? 'disabled' : ''}>‹</button>
        </div>
      </div>
      <div class="md-stats">
        <div class="s"><div class="l">إجمالي الشهر</div><div class="v">${mdNum(r.total.orders, 'int')}</div></div>
        <div class="s"><div class="l">متوسط اليوم</div><div class="v">${r.avgPerDay === null ? '—' : mdNum(Math.round(r.avgPerDay), 'int')}</div></div>
        <div class="s"><div class="l">أفضل يوم</div><div class="v">${r.bestDay ? `${mdNum(r.bestDay.orders, 'int')} <small>(يوم ${r.bestDay.day})</small>` : '—'}</div></div>
        <div class="s"><div class="l">الصرف</div><div class="v">${mdNum(r.total.spend, 'money')}</div></div>
        <div class="s"><div class="l">الكوست</div><div class="v">${mdNum(r.total.cpa, 'money')}</div></div>
      </div>
      <div class="md-chart" dir="ltr" tabindex="0">${bars}</div>
      <div class="atd-note">📦 اضغط على أي يوم يظهرلك الأوردرات اللي جت فيه من منتجات إيه. ${UI.escapeHtml(r.note || '')}</div>
    </section>`;

  const root = body.querySelector('.md');
  atdAnimate(root);
  root.querySelectorAll('[data-md]').forEach((b) => { b.onclick = () => { mdMonth = mdShift(month, b.dataset.md === 'prev' ? -1 : 1); renderMonthDays(false); }; });
  root.querySelectorAll('.md-col:not([disabled])').forEach((c) => { c.onclick = () => openDayOrders(c.dataset.day); });
  const chart = root.querySelector('.md-chart');
  const cur = chart.querySelector('.is-today') || chart.querySelector('.md-col:last-child');
  if (cur && chart.scrollWidth > chart.clientWidth) chart.scrollLeft = Math.max(0, cur.offsetLeft - chart.clientWidth / 2);
}

function closeDayOrders() {
  document.getElementById('mdOverlay')?.remove();
  mdOpenDay = null;
  if (mdKeyHandler) { document.removeEventListener('keydown', mdKeyHandler); mdKeyHandler = null; }
}

/** The popup for one day: its products (orders / spend / cost per order, best first) with arrows + keyboard to slide to the previous / next day. */
function openDayOrders(date) {
  if (!mdDoc) return;
  const days = mdDoc.days.filter((d) => !d.future);
  const idx = days.findIndex((d) => d.date === date);
  if (idx < 0) return;
  let ov = document.getElementById('mdOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'atp-overlay';
    ov.id = 'mdOverlay';
    ov.innerHTML = '<div class="atp-modal md-modal" role="dialog" aria-modal="true" style="--acc:#ff7a1a"></div>';
    document.documentElement.appendChild(ov); // not <body>: the embedded page's body carries a transform, which would turn this "fixed" overlay into one as tall as the whole page
    ov.addEventListener('click', (e) => { if (e.target === ov) closeDayOrders(); });
    mdKeyHandler = (e) => {
      if (e.key === 'Escape') return closeDayOrders();
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      // the page is RTL: "next day" sits on the left, like the accounts slider
      showDay(mdOpenDay + (e.key === 'ArrowLeft' ? 1 : -1), e.key === 'ArrowLeft' ? 'next' : 'prev');
    };
    document.addEventListener('keydown', mdKeyHandler);
  }
  const modal = ov.querySelector('.md-modal');

  function showDay(i, dir) {
    if (i < 0 || i >= days.length) return;
    mdOpenDay = i;
    const d = days[i];
    const maxOrders = Math.max(1, ...d.products.map((p) => p.orders));
    const medal = (k) => (k === 0 ? ' gold' : k === 1 ? ' silver' : k === 2 ? ' bronze' : '');
    const weekday = new Date(`${d.date}T12:00:00Z`).toLocaleDateString('ar-EG', { weekday: 'long', timeZone: 'UTC' });
    const rows = d.products.map((p, k) => `
      <div class="atp-row md-row" style="--i:${Math.min(k, 8)}">
        <div class="atp-rank${medal(k)}">${k + 1}</div>
        <div class="atp-main">
          <div class="atp-name">${UI.escapeHtml(p.name)}${p.source === 'NAME' ? '<span class="atp-chip" title="الحملات دي متجمّعة بالاسم المتشابه بس، مش مربوطة بمنتج">بالاسم</span>' : ''}</div>
          <div class="atp-sub">${p.campaigns} ${p.campaigns === 1 ? 'حملة' : 'حملات'} · ${UI.fmtNum(Math.round(p.orderShare))}% من أوردرات اليوم${p.accounts.length > 1 ? ` · ${p.accounts.map((a) => `${UI.escapeHtml(a.name)} ${a.orders}`).join(' / ')}` : p.accounts[0] ? ` · ${UI.escapeHtml(p.accounts[0].name)}` : ''}</div>
          <div class="atp-bar"><i data-w="${((p.orders / maxOrders) * 100).toFixed(1)}"></i></div>
        </div>
        <div class="atp-stat orders"><div class="l">الأوردرات</div><div class="v">${mdNum(p.orders, 'int')}</div></div>
        <div class="atp-stat"><div class="l">الصرف</div><div class="v">${mdNum(p.spend, 'money')}</div></div>
        <div class="atp-stat cpa"><div class="l">الكوست</div><div class="v">${mdNum(p.cpa, 'money')}</div></div>
      </div>`).join('');
    const noOrdersSpend = d.noOrders.reduce((s, p) => s + p.spend, 0);
    const noOrdersHtml = d.noOrders.length ? `
      <details class="atp-noorders">
        <summary>⚠️ صرف من غير أوردرات (${d.noOrders.length}) — ${UI.fmtNum(Math.round(noOrdersSpend))} ج</summary>
        ${d.noOrders.map((p) => `<div class="atp-nrow"><span>${UI.escapeHtml(p.name)}${p.source === 'NAME' ? '<span class="atp-chip">بالاسم</span>' : ''}</span><b>${UI.fmtNum(Math.round(p.spend))} ج</b></div>`).join('')}
      </details>` : '';
    modal.innerHTML = `
      <div class="atp-head">
        <div class="md-daybadge"><b>${d.day}</b><span>${UI.escapeHtml(MD_MONTHS[Number(d.date.slice(5, 7)) - 1])}</span></div>
        <div class="atp-title"><b>أوردرات يوم ${d.day} — ${UI.escapeHtml(weekday)}</b><span>📦 المنتجات اللي جابت الأوردرات دي، من كل الحسابات</span></div>
        <div class="md-pager">
          <button type="button" class="atd-nav" data-go="prev" aria-label="اليوم السابق" ${i <= 0 ? 'disabled' : ''}>›</button>
          <span class="md-pos"><b>${i + 1}</b> / ${days.length}</span>
          <button type="button" class="atd-nav" data-go="next" aria-label="اليوم التالي" ${i >= days.length - 1 ? 'disabled' : ''}>‹</button>
        </div>
        <button class="atp-x" type="button" aria-label="إغلاق">✕</button>
      </div>
      <div class="atp-body md-body ${dir ? `md-slide-${dir}` : ''}">
        <div class="atp-sum">
          <div class="s"><div class="l">إجمالي الأوردرات</div><div class="v">${mdNum(d.orders, 'int')}</div></div>
          <div class="s"><div class="l">منتجات جابت أوردرات</div><div class="v">${mdNum(d.products.length, 'int')}</div></div>
          <div class="s"><div class="l">إجمالي الصرف</div><div class="v">${mdNum(d.spend, 'money')}</div></div>
          <div class="s"><div class="l">الكوست أوفر رول</div><div class="v">${mdNum(d.cpa, 'money')}</div></div>
        </div>
        ${d.products.length ? `<div class="md-list">${rows}</div>` : `<div class="atp-empty">${d.hasData ? 'مفيش منتج جاب أوردرات في اليوم ده.' : 'مفيش بيانات مزامنة لليوم ده.'}</div>`}
        ${noOrdersHtml}
        <div class="atd-note">الأوردرات = مشتريات Meta. «بالاسم» = تجميع حملات متشابهة في الاسم، مش مربوطة بمنتج.</div>
      </div>`;
    modal.querySelector('.atp-x').onclick = closeDayOrders;
    modal.querySelector('[data-go="prev"]').onclick = () => showDay(mdOpenDay - 1, 'prev');
    modal.querySelector('[data-go="next"]').onclick = () => showDay(mdOpenDay + 1, 'next');
    atdAnimate(modal);
  }
  showDay(idx, null);
}

init();
