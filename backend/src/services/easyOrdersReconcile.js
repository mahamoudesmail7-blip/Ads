// Safety net for the EasyOrders integration — added after confirming (with a
// real order, twice) that EasyOrders' "order-status-update" webhook event
// never actually fires for this store, even though "order-created" works
// correctly. Rather than depend on that missing push notification, this
// periodically PULLS the real current status of every still-active order
// via the same Get-Order-By-ID API already used as a fallback in
// webhooks.js, and applies any change through the exact same
// applyStatusToOrder() the webhook itself uses — so a status change reaches
// the dashboard within one poll cycle either way.
//
// Only PENDING/CONFIRMED orders are re-checked (not DELIVERED/CANCELLED/
// RETURNED) — the set of "still active" orders stays small regardless of
// total order history, which matters given EasyOrders' 40 requests/minute
// rate limit.
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { fetchOrderById, applyStatusToOrder } from './easyOrders.js';
import { listStores } from './easyOrdersStores.js';

const RECONCILE_INTERVAL_MS = 2 * 60 * 1000; // 2 min — well under the 40 req/min limit even with dozens of active orders

export async function reconcileActiveOrders() {
  if (!listStores().length) return; // nothing configured to poll with — silently skip rather than log noise on every tick

  // Multi-store — each active order re-checks against ITS OWN store's real
  // API key, via the store_id this row was actually ingested with
  // (services/easyOrders.js's ingestOrder() sets it on every row now).
  // `store_id` used to not exist on this table at all (the migration
  // existed but was unapplied) — that earlier state made this select throw
  // PrismaClientValidationError on every tick, confirmed by direct
  // reproduction against production; fixed once the migration was applied.
  const activeOrders = await prisma.easyOrdersOrder.findMany({
    where: { status: { in: ['PENDING', 'CONFIRMED'] } },
    select: { order_id: true, store_id: true },
    distinct: ['order_id'],
  });

  let checked = 0;
  let updated = 0;
  for (const { order_id, store_id } of activeOrders) {
    const fetched = await fetchOrderById(order_id, store_id);
    if (!fetched) continue;
    checked++;
    const { changedRows } = await applyStatusToOrder(order_id, fetched.status);
    if (changedRows > 0) updated++;
  }
  if (updated > 0) {
    logger.info('EasyOrders reconciliation applied real status changes', { checked, updated });
  }
}

export function startEasyOrdersReconciliation() {
  setInterval(() => {
    reconcileActiveOrders().catch((err) => logger.error('EasyOrders reconciliation failed', { message: err.message }));
  }, RECONCILE_INTERVAL_MS);
}
