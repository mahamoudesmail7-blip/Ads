// compare.js — page controller for compare.html (spec section 16, extended
// with V2 profit/inventory metrics for full consistency with Dashboard/Ranking).
import { Products, DailyOrders, Settings } from './db.js';
import * as A from './analytics.js';
import * as UI from './ui-common.js';
import { buildProductBundle } from './product-bundle.js';

const selected = new Set();
let products = [];
let settings = null;
let byProduct = new Map();

async function init() {
  UI.renderSidebar('compare');
  settings = await Settings.get();
  products = (await Products.all()).filter((p) => !p.is_demo);
  products.sort((a, b) => a.product_name.localeCompare(b.product_name, 'ar'));

  const allOrders = await DailyOrders.all(); // 🧪 demo orders included — see alerts.js comment
  for (const o of allOrders) {
    if (!byProduct.has(o.product_id)) byProduct.set(o.product_id, []);
    byProduct.get(o.product_id).push(o);
  }

  const preselect = (UI.qs('ids') || '').split(',').filter(Boolean).map(Number);
  preselect.forEach((id) => selected.add(id));

  renderChips();
  renderCompare();
}

function renderChips() {
  document.getElementById('productChips').innerHTML = products
    .map((p) => `<span class="chip ${selected.has(p.id) ? 'active' : ''}" data-id="${p.id}">${UI.escapeHtml(p.product_name)}</span>`)
    .join('');
  document.querySelectorAll('#productChips .chip').forEach((chip) => {
    chip.onclick = () => {
      const id = Number(chip.dataset.id);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      renderChips();
      renderCompare();
    };
  });
}

function renderCompare() {
  const wrap = document.getElementById('compareWrap');
  const emptyState = document.getElementById('emptyState');

  const asOfDate = A.todayStr();
  const rows = [...selected]
    .map((id) => products.find((p) => p.id === id))
    .filter(Boolean) // a stale/invalid id in the URL (e.g. a bookmarked link after Clear Demo Data) is skipped, not a crash
    .map((product) => buildProductBundle(product, byProduct.get(product.id) || [], asOfDate, settings));

  if (rows.length === 0) {
    wrap.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';

  const metrics = [
    { label: 'اليوم', render: ({ a }) => UI.fmtNum(a.today) },
    { label: 'معدل 7 أيام', render: ({ a }) => UI.fmtAvg(a.avg7) },
    { label: 'معدل 14 يوم', render: ({ a }) => UI.fmtAvg(a.avg14) },
    { label: 'الفرق %', render: ({ a }) => UI.fmtPct(a.tableChange.pct) },
    { label: 'اتجاه الأداء', render: ({ a }) => UI.trendLabel(a.trend) },
    { label: 'الحالة', render: ({ a }) => UI.statusBadge(a.status) },
    { label: 'تقييم حالة المنتج', render: ({ a }) => UI.healthBar(a.health.score) },
    { label: 'أقصى تكلفة أوردر مربحة', render: ({ profit }) => (profit.breakEvenCPA !== null ? UI.fmtCurrency(profit.breakEvenCPA) : '<span class="faint">—</span>') },
    { label: 'ربح الأوردر', render: ({ profit }) => UI.fmtCurrency(profit.profitPerOrder) },
    { label: 'صافي الربح (فترة الرصد)', render: ({ profit }) => UI.fmtCurrency(profit.profitRecent) },
    { label: 'المخزون (أيام متبقية)', render: ({ inventory }) => UI.stockStatusBadge(inventory.status, inventory.daysRemaining) },
    { label: 'تقييم المنتج', render: ({ score }) => (score ? `${score.score}/100 (${UI.scoreLabelAr(score.label)})` : '<span class="faint">البيانات غير متوفرة</span>') },
    { label: 'التوصية', render: ({ v2 }) => UI.recPill(v2.type) },
  ];

  wrap.innerHTML = `
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr><th>المقياس</th>${rows.map((r) => `<th><a href="${UI.productLink(r.product.id)}">${UI.escapeHtml(r.product.product_name)}</a></th>`).join('')}</tr>
        </thead>
        <tbody>
          ${metrics
            .map(
              (m) => `<tr><td class="muted">${m.label}</td>${rows.map((r) => `<td>${m.render(r)}</td>`).join('')}</tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

init();
