// Safety net for the EasyOrders integration. EasyOrders' "order-status-update" webhook is unreliable for these stores, so this
// periodically PULLS the current status of still-active orders and applies any change through applyStatusToOrder() — the same
// function the webhook uses.
//
// 2026-10-02 rewrite (see services/easyOrdersStatus.js for the audit): the old loop re-walked EVERY active order (~10.9k) every
// 2 minutes with no overlap guard, no per-key rate budget, and turned every 429/400 into a silent skip. Now each tick is
// bounded (30 orders), never overlaps, respects a per-key budget (30/min, shared key with production), tries every configured
// store's key (orders can be tagged to the wrong store), and records exact counters so a failing sync is visible.
import { logger } from '../logger.js';
import { listStores } from './easyOrdersStores.js';
import { reconcileOrders, reconcileHealth, recordTick } from './easyOrdersStatus.js';

const RECONCILE_INTERVAL_MS = 2 * 60 * 1000;
const ORDERS_PER_TICK = 30;

export async function reconcileActiveOrders() {
  if (!listStores().length) return null; // nothing configured to poll with
  if (reconcileHealth.running) return null; // never overlap ticks
  reconcileHealth.running = true;
  try {
    const stats = await reconcileOrders({ limit: ORDERS_PER_TICK });
    recordTick(stats);
    return stats;
  } finally { reconcileHealth.running = false; }
}

let timer = null;
export function startEasyOrdersReconciliation() {
  if (timer) return;
  timer = setInterval(() => {
    reconcileActiveOrders().catch((err) => logger.error('EasyOrders reconciliation failed', { message: err.message }));
  }, RECONCILE_INTERVAL_MS);
  timer.unref?.();
}
