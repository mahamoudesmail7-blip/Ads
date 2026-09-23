// AI Media Buyer Operator — Price Testing Engine (Product Growth & Profit
// Intelligence, Phase 3 Slice 12). Unlike every other prepare_* tool, the
// consequential action here is a LOCAL database write (Product.selling_price)
// — never a Meta call, never Easy Orders — so it deliberately does NOT reuse
// the Launch-family's AmbLaunchJob/Meta-queue machinery. It reuses instead
// what already exists for exactly this kind of change: productMarketingTests.js's
// PRICE test_type (already in TEST_TYPES) for tracking, and captures a real
// baseline snapshot at prepare time so a later verdict can compare honestly
// instead of guessing what "before" looked like.
import { prisma } from '../../prisma.js';
import { computeTruePerformance } from '../truePerformance.js';
import { classifyProfitState } from '../amb/profitBrain.js';
import { getAmbSettings } from '../amb/settings.js';

/** Real current price + a real baseline snapshot (CR/CPA/confirmation/delivery/profit-per-delivered-order) — never invented, never a guess at "before" state. */
export async function capturePriceTestBaseline({ productId }) {
  const product = await prisma.product.findUnique({
    where: { id: Number(productId) },
    select: { id: true, product_name: true, selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true, commission: true, expected_return_cost: true, active: true, is_historical: true },
  });
  if (!product || !product.active || product.is_historical) return { ok: false, message: 'المنتج ده مش موجود أو مش نشط.' };

  const settings = await getAmbSettings();
  const trueRows = await computeTruePerformance({ productId: Number(productId) });
  const row = trueRows.products?.[0] || { real: { actualOrders: 0 } };
  const profitState = classifyProfitState(row, product, settings);

  return {
    ok: true,
    productName: product.product_name,
    currentPrice: product.selling_price,
    baseline: {
      actualOrders: row.real?.actualOrders ?? null,
      confirmedOrders: row.real?.confirmedOrders ?? null,
      deliveredOrders: row.real?.deliveredOrders ?? null,
      returnedOrders: row.real?.returnedOrders ?? null,
      trueCPA: row.real?.trueCPA ?? null,
      costPerDeliveredOrder: row.real?.costPerDeliveredOrder ?? null,
      netProfit: row.real?.netProfit ?? null,
      profitState: profitState.state,
      marginPct: profitState.marginPct,
      capturedAt: new Date().toISOString(),
    },
  };
}
