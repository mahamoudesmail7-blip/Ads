// ranking.js — page controller for ranking.html (spec sections 5, 53-57).
// Three DISTINCT rankings that must never be confused with each other
// (section 57): who sold the most today, who grew the most vs yesterday,
// and who performs best against their own history — plus the profit-based
// views from section 5 ("من أكثر منتج بيكسبني، وليس فقط من أكثر منتج بيبيع").
//
// ROAS is intentionally not shown yet: it requires real Meta Ads spend
// data, which doesn't exist until that integration lands (see README
// "Future Integrations"). Showing a column that's always empty would be
// worse than omitting it.
import { Products, DailyOrders, Settings } from './db.js';
import * as A from './analytics.js';
import * as UI from './ui-common.js';
import { buildProductBundle } from './product-bundle.js';

const SORTS = {
  'ترتيب الأوردرات': (a, b) => (b.a.today ?? -Infinity) - (a.a.today ?? -Infinity),
  'ترتيب النمو': (a, b) => (b.a.tableChange.pct ?? -Infinity) - (a.a.tableChange.pct ?? -Infinity),
  'ترتيب الأداء': (a, b) => (b.score?.score ?? b.a.health.score) - (a.score?.score ?? a.a.health.score),
  'صافي الربح': (a, b) => (b.profit.profitRecent ?? -Infinity) - (a.profit.profitRecent ?? -Infinity),
  'الربح / أوردر': (a, b) => (b.profit.profitPerOrder ?? -Infinity) - (a.profit.profitPerOrder ?? -Infinity),
  'نسبة المرتجعات': (a, b) => (a.profit.returnRate ?? Infinity) - (b.profit.returnRate ?? Infinity),
};

let bundles = [];
let sortKey = 'ترتيب الأوردرات';

async function init() {
  UI.renderSidebar('ranking');

  const chipEl = document.getElementById('sortChips');
  chipEl.innerHTML = Object.keys(SORTS)
    .map((k) => `<span class="chip ${k === sortKey ? 'active' : ''}" data-k="${k}">${k}</span>`)
    .join('');
  chipEl.querySelectorAll('.chip').forEach((chip) => {
    chip.onclick = () => {
      sortKey = chip.dataset.k;
      chipEl.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      render();
    };
  });

  const settings = await Settings.get();
  const products = (await Products.all()).filter((p) => !p.is_demo);
  const allOrders = await DailyOrders.all(); // 🧪 demo orders included — see alerts.js comment
  const asOfDate = A.todayStr();

  const byProduct = new Map();
  for (const o of allOrders) {
    if (!byProduct.has(o.product_id)) byProduct.set(o.product_id, []);
    byProduct.get(o.product_id).push(o);
  }

  bundles = products.map((p) => buildProductBundle(p, byProduct.get(p.id) || [], asOfDate, settings));
  render();
}

function render() {
  const tbody = document.getElementById('tbody');
  document.getElementById('emptyState').style.display = bundles.length === 0 ? 'block' : 'none';

  const sorted = [...bundles].sort(SORTS[sortKey]);

  tbody.innerHTML = sorted
    .map(({ product, a, profit, score, v2 }, i) => {
      const profitCls = profit.profitRecent > 0 ? 'green' : profit.profitRecent < 0 ? 'red' : '';
      const perOrderCls = profit.profitPerOrder > 0 ? 'green' : profit.profitPerOrder < 0 ? 'red' : '';
      return `
      <tr class="row-link" data-id="${product.id}" style="cursor:pointer">
        <td class="mono faint">#${i + 1}</td>
        <td>${UI.escapeHtml(product.product_name)}</td>
        <td class="num" style="color:var(--${profitCls || 'text-dim'})">${UI.fmtCurrency(profit.profitRecent)}</td>
        <td class="num" style="color:var(--${perOrderCls || 'text-dim'})">${UI.fmtCurrency(profit.profitPerOrder)}</td>
        <td class="num">${profit.breakEvenCPA !== null ? UI.fmtCurrency(profit.breakEvenCPA) : '<span class="faint">—</span>'}</td>
        <td class="num">${UI.fmtCurrency(profit.currentCPA)}</td>
        <td class="num">${profit.returnRate !== null ? profit.returnRate.toFixed(1) + '%' : '<span class="faint">—</span>'}</td>
        <td class="num">${UI.fmtNum(a.today)}</td>
        <td>${score ? `${UI.healthBar(score.score)} <span class="faint">(${UI.scoreLabelAr(score.label)})</span>` : '<span class="faint">البيانات غير متوفرة</span>'}</td>
        <td>${UI.recPill(v2.type)}</td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('.row-link').forEach((tr) => {
    tr.onclick = () => (window.location.href = UI.productLink(tr.dataset.id));
  });
}

init();
