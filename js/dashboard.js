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

  renderQuickStats();
  renderComparison();
  await renderInventoryKpis();
  renderImproved();
  renderDeclined();
  renderTop4();
  renderZeroOrder();
  renderIntervention();
  renderActionPlan();
  await renderWorkTeaser();
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

init();
