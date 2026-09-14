// Customer Database — deduplicated by normalized Egyptian phone
// (services/phoneNormalize.js). Built ONLY from fields confirmed present
// in Easy Orders' real order payload (see schema.prisma's Customer model
// comment). Aggregates are always RECOMPUTED fresh from this customer's
// EasyOrdersOrder rows — never hand-incremented — same philosophy as
// services/easyOrders.js's recomputeDailyOrder().
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { normalizeEgyptianPhone } from './phoneNormalize.js';

/** Adds `oldRaw` to the JSON array of previously-seen raw phone strings, deduped, only when it's a real variant different from the new one — never invents a phone that was never actually seen on an order. */
function mergeOtherPhones(existingJson, oldRaw, newRaw) {
  let list = [];
  try { list = existingJson ? JSON.parse(existingJson) : []; } catch { list = []; }
  if (Array.isArray(list) && oldRaw && oldRaw !== newRaw && !list.includes(oldRaw)) list = [...list, oldRaw];
  return list.length ? JSON.stringify(list) : (existingJson || null);
}

/** `a || b` but treats '' the same as null/undefined — a blank string from a malformed order must never overwrite a real previously-known value. */
function preferNonBlank(next, previous) {
  return (next && String(next).trim()) ? next : (previous ?? null);
}

/**
 * Finds or creates the Customer for one order's raw phone, updating its
 * latest-known identity fields — never overwriting a good existing value
 * with blank/missing data from this order. Returns null (never throws, never
 * invents a phone) when the phone can't be safely normalized; the caller
 * still ingests the order itself, just without a customer_id link.
 */
export async function upsertCustomerForOrder({ rawPhone, fullName, government, address, guestId }) {
  const normalized = normalizeEgyptianPhone(rawPhone);
  if (!normalized) return null;

  // Read first only to compute the merge/"don't overwrite good with blank"
  // logic below — the actual write is a single atomic upsert() (Postgres
  // INSERT ... ON CONFLICT DO UPDATE), so two concurrent orders for the
  // SAME brand-new phone can never create two Customer rows: the DB's own
  // unique constraint on normalized_phone is what actually prevents the
  // duplicate, not this read.
  const existing = await prisma.customer.findUnique({ where: { normalized_phone: normalized } });

  return prisma.customer.upsert({
    where: { normalized_phone: normalized },
    create: {
      normalized_phone: normalized,
      primary_phone: rawPhone || null,
      name: fullName || null,
      government: government || null,
      address: address || null,
      easy_orders_guest_id: guestId || null,
    },
    update: existing ? {
      primary_phone: preferNonBlank(rawPhone, existing.primary_phone),
      other_phones_json: mergeOtherPhones(existing.other_phones_json, existing.primary_phone, rawPhone),
      name: preferNonBlank(fullName, existing.name),
      government: preferNonBlank(government, existing.government),
      address: preferNonBlank(address, existing.address),
      easy_orders_guest_id: preferNonBlank(guestId, existing.easy_orders_guest_id),
    } : {
      // The rare race: `existing` came back null but another request
      // created this exact phone a moment later, so this upsert's own
      // `update` branch fires instead of `create`. Nothing to merge against
      // (we never saw the just-created row) — apply this order's own data
      // as-is, same as a fresh create would have.
      primary_phone: rawPhone || undefined,
      name: fullName || undefined,
      government: government || undefined,
      address: address || undefined,
      easy_orders_guest_id: guestId || undefined,
    },
  });
}

/**
 * Recomputes every aggregate counter for one customer from scratch, from
 * their linked EasyOrdersOrder rows — never hand-incremented, so a later
 * status change (e.g. a return) self-corrects the aggregate instead of
 * drifting. Dedupes by order_id first (one real order can have several
 * cart-item rows). Same status convention as codCountsForProduct: DELIVERED
 * implies CONFIRMED.
 */
export async function recomputeCustomerStats(customerId) {
  if (!customerId) return;
  const rows = await prisma.easyOrdersOrder.findMany({
    where: { customer_id: customerId },
    select: { order_id: true, status: true, order_cost: true, created_at: true },
  });
  if (rows.length === 0) return; // nothing left to track for this customer — leave the row as-is, mirrors recomputeDailyOrder's own early-return

  const byOrder = new Map();
  for (const r of rows) if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, r);
  const orders = [...byOrder.values()];

  const countWhere = (pred) => orders.filter(pred).length;
  const sumCostWhere = (pred) => orders.filter(pred).reduce((acc, o) => acc + (o.order_cost || 0), 0);
  const isConfirmedLike = (o) => o.status === 'CONFIRMED' || o.status === 'DELIVERED';
  const dates = orders.map((o) => o.created_at).sort((a, b) => a - b);

  await prisma.customer.update({
    where: { id: customerId },
    data: {
      total_orders: orders.length,
      confirmed_orders: countWhere(isConfirmedLike),
      delivered_orders: countWhere((o) => o.status === 'DELIVERED'),
      returned_orders: countWhere((o) => o.status === 'RETURNED'),
      cancelled_orders: countWhere((o) => o.status === 'CANCELLED'),
      total_order_value: sumCostWhere(() => true),
      delivered_revenue: sumCostWhere((o) => o.status === 'DELIVERED'),
      first_order_at: dates[0],
      last_order_at: dates[dates.length - 1],
    },
  });
}

/**
 * The one entry point services/easyOrders.js's ingestOrder()/
 * applyStatusToOrder() call: resolves (or creates) the Customer for this
 * order's phone, links every EasyOrdersOrder row for this order_id to it,
 * and recomputes that customer's aggregates. Never throws — a failure here
 * must never stop the order itself from being ingested (§11 "one failed
 * order must not stop the full sync"); logs only the order_id, never raw
 * PII, on failure.
 */
export async function linkOrderToCustomer({ orderId, rawPhone, fullName, government, address, guestId }) {
  try {
    const customer = await upsertCustomerForOrder({ rawPhone, fullName, government, address, guestId });
    if (!customer) return null;
    await prisma.easyOrdersOrder.updateMany({ where: { order_id: orderId }, data: { customer_id: customer.id } });
    await recomputeCustomerStats(customer.id);
    return customer.id;
  } catch (err) {
    logger.warn('[Customers] linkOrderToCustomer failed (order still ingested without a customer link)', { orderId, message: err.message });
    return null;
  }
}
