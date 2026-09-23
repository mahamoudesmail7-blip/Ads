// AI Media Buyer — Stock Guard (Product Growth & Profit Intelligence, Phase
// 3 Slice 1). `stockStatus()` is the EXACT logic productDossier.js's local
// stockSummary() already used (moved here verbatim, not reinvented) so a
// product's stock state is computed in exactly one place. The genuinely new
// piece is a real sales-velocity/days-remaining calc, built on top of the
// existing codOrders.js counts — never a second COD data source.
import { codCountsForProduct } from './codOrders.js';

/** Real Product.current_stock/minimum_stock -> SAFE|LOW|OUT_OF_STOCK|STOCK_UNKNOWN. Never invents a status when current_stock is unset. */
export function stockStatus(product) {
  if (product.current_stock == null) return { status: 'STOCK_UNKNOWN', currentStock: null, minimumStock: product.minimum_stock ?? null };
  const min = product.minimum_stock ?? 0;
  const status = product.current_stock <= 0 ? 'OUT_OF_STOCK' : product.current_stock <= min ? 'LOW' : 'SAFE';
  return { status, currentStock: product.current_stock, minimumStock: product.minimum_stock ?? null };
}

/** Real average delivered-orders-per-day over a trailing window, from the SAME codOrders.js counts the rest of AMB already trusts. Null (never 0) when there's no real COD data for this product yet. */
export async function salesVelocityForProduct({ productId, storeId, days = 14 }) {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const counts = await codCountsForProduct({ productId, storeId, from, to });
  if (counts.source === 'none' || counts.delivered == null) return null;
  return counts.delivered / days;
}

/** Null-safe — never fabricates a day count when stock or velocity is unknown/zero. */
export function daysRemaining({ currentStock, avgDailyDelivered }) {
  if (currentStock == null || avgDailyDelivered == null || avgDailyDelivered <= 0) return null;
  return Math.round(currentStock / avgDailyDelivered);
}

/** One-product composition — what prepare_scale (Money Guard) and any future stock-aware UI should call. */
export async function stockGuardForProduct({ productId, storeId, days = 14 }) {
  const { prisma } = await import('../../prisma.js');
  const product = await prisma.product.findUnique({ where: { id: Number(productId) }, select: { current_stock: true, minimum_stock: true } });
  const base = stockStatus(product || {});
  const avgDailyDelivered = await salesVelocityForProduct({ productId, storeId, days });
  return { ...base, avgDailyDelivered, daysRemaining: daysRemaining({ currentStock: base.currentStock, avgDailyDelivered }) };
}
