// Real per-product profitability — extracted verbatim from the original
// GET /api/ai-intelligence/true-performance handler (routes/adsIntelligence.js)
// so the AI tool layer (services/aiTools.js) and that route call the exact
// same computation instead of two copies drifting apart. No logic changed
// in this extraction — same Meta spend/purchases join against real
// EasyOrders/DailyOrder rows, same netProfit/revenue math from js/profit.js.
import { prisma } from '../prisma.js';
import { netProfit, revenue } from '../../../js/profit.js';

/**
 * @param {{dateFrom?: string, dateTo?: string, productId?: number}} params
 * @returns {Promise<{dateFrom: string|null, dateTo: string|null, products: object[]}>}
 */
export async function computeTruePerformance({ dateFrom, dateTo, productId } = {}) {
  const dateFilter = {};
  if (dateFrom) dateFilter.gte = dateFrom;
  if (dateTo) dateFilter.lte = dateTo;

  const adsWhere = { matched_product_id: { not: null } };
  if (dateFrom || dateTo) adsWhere.date = dateFilter;
  if (productId) adsWhere.matched_product_id = productId;

  const adsGroups = await prisma.adsDailyMetric.groupBy({
    by: ['matched_product_id'],
    where: adsWhere,
    _sum: { spend: true, meta_purchases: true, meta_revenue: true, impressions: true, clicks: true },
  });

  const results = [];
  for (const g of adsGroups) {
    const pid = g.matched_product_id;
    const product = await prisma.product.findUnique({ where: { id: pid } });
    if (!product) continue;

    const spend = g._sum.spend || 0;
    const metaPurchases = g._sum.meta_purchases || 0;
    const metaRevenue = g._sum.meta_revenue || 0;
    const metaRoas = spend > 0 ? metaRevenue / spend : null;

    const eoWhere = { product_id: pid };
    if (dateFrom || dateTo) eoWhere.date = dateFilter;
    const eoRows = await prisma.easyOrdersOrder.findMany({ where: eoWhere });

    let source, actualOrders, confirmedOrders, deliveredOrders, cancelledOrders, returnedOrders, actualRevenue;
    if (eoRows.length > 0) {
      source = 'easyorders';
      const byOrder = new Map();
      for (const r of eoRows) if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, r.status);
      const statuses = [...byOrder.values()];
      actualOrders = statuses.length;
      confirmedOrders = statuses.filter((s) => s === 'CONFIRMED').length;
      deliveredOrders = statuses.filter((s) => s === 'DELIVERED').length;
      cancelledOrders = statuses.filter((s) => s === 'CANCELLED').length;
      returnedOrders = statuses.filter((s) => s === 'RETURNED').length;
      actualRevenue = revenue(product, deliveredOrders || actualOrders);
    } else {
      const doWhere = { product_id: pid };
      if (dateFrom || dateTo) doWhere.date = dateFilter;
      const dailyRows = await prisma.dailyOrder.findMany({ where: doWhere });
      source = dailyRows.length > 0 ? 'daily_orders' : 'none';
      actualOrders = dailyRows.reduce((s, r) => s + (r.orders_count || 0), 0);
      confirmedOrders = null;
      deliveredOrders = dailyRows.reduce((s, r) => s + (r.delivered_count || 0), 0);
      cancelledOrders = null;
      returnedOrders = dailyRows.reduce((s, r) => s + (r.returned_count || 0), 0);
      actualRevenue = revenue(product, deliveredOrders || actualOrders);
    }

    const trueCPA = actualOrders > 0 ? spend / actualOrders : null;
    const netProfitValue = netProfit(product, deliveredOrders || actualOrders, trueCPA ?? undefined);
    const trueRoas = spend > 0 && actualRevenue !== null ? actualRevenue / spend : null;
    const deliveredRoas = spend > 0 && deliveredOrders ? (deliveredOrders * product.selling_price) / spend : null;
    const costPerDeliveredOrder = deliveredOrders > 0 ? spend / deliveredOrders : null;

    results.push({
      productId: pid,
      productName: product.product_name,
      meta: { spend, purchases: metaPurchases, revenue: metaRevenue, roas: metaRoas, impressions: g._sum.impressions || 0, clicks: g._sum.clicks || 0 },
      real: {
        source,
        actualOrders,
        confirmedOrders,
        deliveredOrders,
        cancelledOrders,
        returnedOrders,
        actualRevenue,
        netProfit: netProfitValue,
        trueCPA,
        trueRoas,
        deliveredRoas,
        costPerDeliveredOrder,
      },
    });
  }

  results.sort((a, b) => b.meta.spend - a.meta.spend);
  return { dateFrom: dateFrom || null, dateTo: dateTo || null, products: results };
}
