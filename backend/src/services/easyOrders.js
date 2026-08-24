// Shared EasyOrders logic used by BOTH the webhook receiver
// (routes/webhooks.js) and the periodic reconciliation job
// (services/easyOrdersReconcile.js) — extracted so the two paths can never
// drift into applying a status differently. Moved here verbatim from
// webhooks.js; its behavior is unchanged, only its location.
import { prisma } from '../prisma.js';

export const EASYORDERS_API_BASE = 'https://api.easy-orders.net/api/v1/external-apps';

/**
 * EasyOrders hasn't published a full status enum (only "pending"/"paid" are
 * shown in their docs) — matched by keyword rather than an exact list, so an
 * unanticipated status string still lands somewhere sane (PENDING, never
 * silently treated as DELIVERED) instead of throwing.
 */
export function normalizeStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('cancel')) return 'CANCELLED';
  if (s.includes('return')) return 'RETURNED';
  if (s.includes('deliver')) return 'DELIVERED';
  if (s.includes('confirm') || s === 'paid') return 'CONFIRMED';
  return 'PENDING';
}

export function toDateOnly(iso) {
  return (iso || new Date().toISOString()).slice(0, 10);
}

/** Recomputes the DailyOrder aggregate for one (product, date) from every EasyOrdersOrder row tracked for it — never hand-incremented, always derived fresh so a later status change (e.g. a return) self-corrects the aggregate instead of drifting. */
export async function recomputeDailyOrder(productId, date) {
  if (!productId) return;
  const rows = await prisma.easyOrdersOrder.findMany({ where: { product_id: productId, date } });
  const sum = (statuses) => rows.filter((r) => statuses.includes(r.status)).reduce((acc, r) => acc + r.quantity, 0);
  const orders_count = sum(['PENDING', 'CONFIRMED', 'DELIVERED']);
  const delivered_count = sum(['DELIVERED']);
  const returned_count = sum(['RETURNED']);

  if (rows.length === 0) return; // nothing left to track for this product+date — leave any pre-existing manual/demo row alone.

  await prisma.dailyOrder.upsert({
    where: { product_id_date: { product_id: productId, date } },
    update: { orders_count, delivered_count, returned_count, source: 'easyorders' },
    create: { product_id: productId, date, orders_count, delivered_count, returned_count, source: 'easyorders' },
  });
}

/** Matches an EasyOrders cart item to our Product by exact SKU — no fuzzy name matching here (unlike the Excel-import path in product-mapping.js): a wrong guess would silently misattribute a real sale, which is worse than leaving it unmatched for manual review. */
async function matchProduct(sku) {
  if (!sku) return null;
  return prisma.product.findFirst({ where: { sku } });
}

/** Upserts one EasyOrdersOrder row per cart item from a full order payload (either the original webhook body, or a Get-Order-By-ID response), then recomputes every (product, date) it touches. */
export async function ingestOrder(order) {
  const date = toDateOnly(order.created_at);
  const status = normalizeStatus(order.status);
  const touched = new Set();

  for (const item of order.cart_items || []) {
    const sku = item.product?.sku || null;
    const productNameRaw = item.product?.name || null;
    const product = await matchProduct(sku);
    await prisma.easyOrdersOrder.upsert({
      where: { order_id_cart_item_id: { order_id: order.id, cart_item_id: item.id } },
      update: { status, raw_status: order.status, quantity: item.quantity || 1, product_id: product?.id ?? null, sku, product_name_raw: productNameRaw, matched: !!product, date },
      create: {
        order_id: order.id,
        cart_item_id: item.id,
        product_id: product?.id ?? null,
        sku,
        product_name_raw: productNameRaw,
        date,
        status,
        raw_status: order.status,
        quantity: item.quantity || 1,
        matched: !!product,
      },
    });
    if (product) touched.add(`${product.id}::${date}`);
  }

  for (const key of touched) {
    const [productId, d] = key.split('::');
    await recomputeDailyOrder(Number(productId), d);
  }
}

/** Fetches one order's current state directly via the API key — used when a status-update webhook references an order we've never seen, and by the reconciliation job below. */
export async function fetchOrderById(orderId) {
  const apiKey = process.env.EASYORDERS_API_KEY;
  if (!apiKey) return null;
  const res = await fetch(`${EASYORDERS_API_BASE}/orders/${orderId}`, { headers: { 'Api-Key': apiKey } });
  if (!res.ok) return null;
  return res.json();
}

/** Applies a new status to every EasyOrdersOrder row tracked for one order_id, then recomputes every (product, date) touched. Shared by the webhook's order-status-update handler and the reconciliation job so both apply a status change identically. Returns both counts since the reconciliation job needs to know whether anything actually changed, not just how many rows exist. */
export async function applyStatusToOrder(orderId, rawStatus) {
  const status = normalizeStatus(rawStatus);
  const rows = await prisma.easyOrdersOrder.findMany({ where: { order_id: orderId } });
  const touched = new Set();
  let changedRows = 0;
  for (const row of rows) {
    if (row.status === status) continue; // no-op — avoids an unnecessary write + recompute when nothing actually changed
    await prisma.easyOrdersOrder.update({ where: { id: row.id }, data: { status, raw_status: rawStatus } });
    changedRows++;
    if (row.product_id) touched.add(`${row.product_id}::${row.date}`);
  }
  for (const key of touched) {
    const [productId, d] = key.split('::');
    await recomputeDailyOrder(Number(productId), d);
  }
  return { totalRows: rows.length, changedRows };
}
