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

/** An inventory snapshot older than this is NOT live truth — it is reported as stale and the stock stays UNKNOWN (never treated as current). */
export const SNAPSHOT_MAX_AGE_DAYS = 3;

/**
 * THE one place that decides where a product's stock number comes from (every consumer — Advisor, Money Guard, Operator — goes through here):
 *   1. Product.current_stock (catalog, the master)           -> source CATALOG
 *   2. the latest InventorySnapshot (the Daily Stock Tracking module) when it is fresh -> source INVENTORY_SNAPSHOT (+ asOf date)
 *   3. a stale snapshot is shown (staleValue) but NOT used     -> source INVENTORY_SNAPSHOT_STALE, current stays null
 *   4. nothing                                                 -> source null (STOCK_UNKNOWN)
 * No hardcoded/legacy file is ever consulted. Never invents a number.
 */
export async function resolveStockInputs(productId, { now = new Date() } = {}) {
  const { prisma } = await import('../../prisma.js');
  const product = await prisma.product.findUnique({ where: { id: Number(productId) }, select: { current_stock: true, minimum_stock: true } });
  const minimum = product?.minimum_stock ?? null;
  if (product?.current_stock != null) return { current: product.current_stock, minimum, source: 'CATALOG', asOf: null, stale: false, staleValue: null };
  const snap = await prisma.inventorySnapshot.findFirst({ where: { product_id: Number(productId) }, orderBy: { date: 'desc' }, select: { date: true, closing_stock: true, source: true } });
  if (snap) {
    const ageDays = (now.getTime() - new Date(`${snap.date}T00:00:00Z`).getTime()) / 86_400_000;
    const stale = !(ageDays <= SNAPSHOT_MAX_AGE_DAYS);
    return { current: stale ? null : snap.closing_stock, minimum, source: stale ? 'INVENTORY_SNAPSHOT_STALE' : 'INVENTORY_SNAPSHOT', asOf: snap.date, stale, staleValue: stale ? snap.closing_stock : null, snapshotSource: snap.source || null };
  }
  return { current: null, minimum, source: null, asOf: null, stale: false, staleValue: null };
}

/**
 * Demand per day from ALL orders (any status) — the conservative velocity used when delivered/confirmed statuses are not trustworthy
 * (an order that is still PENDING still consumes stock). Null (never 0) when there is no order data.
 */
export async function ordersVelocityForProduct({ productId, storeId, days = 14 }) {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const counts = await codCountsForProduct({ productId, storeId, from, to });
  if (counts.source === 'none' || counts.orders == null) return null;
  return counts.orders / days;
}

/** One-product composition — what prepare_scale (Money Guard) and any future stock-aware UI should call. Additive fields: source/asOf (where the number came from), avgDailyOrders + daysRemainingConservative (order-based, does not depend on delivery statuses). */
export async function stockGuardForProduct({ productId, storeId, days = 14 }) {
  const inputs = await resolveStockInputs(productId);
  const base = stockStatus({ current_stock: inputs.current, minimum_stock: inputs.minimum });
  const avgDailyDelivered = await salesVelocityForProduct({ productId, storeId, days });
  const avgDailyOrders = await ordersVelocityForProduct({ productId, storeId, days });
  return {
    ...base, avgDailyDelivered, daysRemaining: daysRemaining({ currentStock: base.currentStock, avgDailyDelivered }),
    source: inputs.source, asOf: inputs.asOf, staleValue: inputs.staleValue, avgDailyOrders, daysRemainingConservative: daysRemaining({ currentStock: base.currentStock, avgDailyDelivered: avgDailyOrders }),
  };
}
