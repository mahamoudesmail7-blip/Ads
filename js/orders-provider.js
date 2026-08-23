// orders-provider.js — Orders Provider layer (spec sections 3, 59, 62-64).
//
// Purpose: the Analytics Engine (analytics.js) and everything built on top
// of it (profit.js, inventory.js, recommendation-engine.js, daily-monitor.js)
// only ever reads from `daily_orders` in db.js. It has NO idea where those
// rows came from — manual entry, CSV import, or (later) EasyOrders. That
// separation is what makes swapping the data source possible without
// touching a single line of analysis logic.
//
// Today, three things write into `daily_orders`: the manual entry form
// (entry.js), the CSV importer (csv.js), and the demo seed generator
// (seed.js). All three already go through the same chokepoint —
// `DailyOrders.upsert()` in db.js — which is what guarantees no duplicate
// row for the same (product, date) ever exists.
//
// This file formalizes that as an explicit "provider" interface so a
// future EasyOrders integration has a documented contract to implement,
// instead of improvising one later and risking a rewrite of the engine.

/**
 * Order Status enum a real EasyOrders integration will hand back per order
 * (spec: prepare for New/Confirmed/Delivered/Returned/Cancelled/Pending).
 * Not used anywhere yet — daily_orders only stores an aggregate COUNT today,
 * with no per-order status — but fixing the vocabulary now means
 * normalizeOrder() below has one obvious place to map EasyOrders' own
 * status strings into.
 *
 * ABSOLUTE RULE for whenever this is wired up: CANCELLED and RETURNED must
 * NEVER be counted as DELIVERED. An order's daily "orders_count" should
 * reflect orders actually placed (NEW/CONFIRMED/DELIVERED/PENDING); a
 * cancelled or returned order stays visible in the source history (for
 * profit.js's actualReturnRate) but must not inflate that day's count as if
 * it were a completed sale.
 * @readonly
 */
export const ORDER_STATUS = {
  NEW: 'NEW',
  CONFIRMED: 'CONFIRMED',
  DELIVERED: 'DELIVERED',
  RETURNED: 'RETURNED',
  CANCELLED: 'CANCELLED',
  PENDING: 'PENDING',
};

/**
 * @typedef {object} OrdersProvider
 * @property {() => Promise<{fetched: number, written: number, skipped: number}>} syncOrders
 *   Pulls orders from the source and writes them into daily_orders via
 *   DailyOrders.upsert(). Must be safe to call repeatedly (idempotent) —
 *   see EasyOrdersProvider below for why that's harder than it sounds once
 *   individual orders (not daily aggregates) are involved.
 * @property {string} name Human-readable source name, e.g. "بيانات تجريبية", "EasyOrders".
 */

/**
 * The provider in use today: manual entry / CSV import / demo seed. There is
 * nothing to "sync" — data already arrives directly into daily_orders — so
 * this exists mainly so the rest of the app can ask "what's my current
 * orders source?" through one consistent interface rather than assuming.
 * @type {OrdersProvider}
 */
export const DemoOrdersProvider = {
  name: 'إدخال يدوي / رفع ملف / بيانات تجريبية',
  async syncOrders() {
    return { fetched: 0, written: 0, skipped: 0 };
  },
};

/**
 * NOT IMPLEMENTED. Documents exactly what a real EasyOrders integration
 * needs to do, so building it later is "fill in these four methods" rather
 * than "figure out the architecture from scratch". Every method throws
 * until it's actually wired up — this file intentionally does not pretend
 * to talk to an API that doesn't exist.
 *
 * Critical design note (spec sections 62-64): EasyOrders will hand back
 * INDIVIDUAL orders, each with its own Order ID — a different shape than
 * our current daily-aggregate model (`daily_orders` = one row per
 * product+date, holding a COUNT). `normalizeOrder()` + `dedupeByOrderId()`
 * below are where that gap gets closed: individual orders are deduplicated
 * by Order ID first, THEN aggregated into a count per product+date, and
 * ONLY the resulting counts are written via DailyOrders.upsert() — which
 * still provides the product+date duplicate guard as a second safety net.
 * A cancelled order is kept in the source data with its own status, never
 * silently deleted from history, and never counted as a completed order in
 * the daily count; a returned order counts toward "delivered→returned"
 * (profit.js's actualReturnRate) rather than being subtracted from Orders.
 * @type {OrdersProvider & {
 *   fetchOrders: (sinceDate: string) => Promise<object[]>,
 *   normalizeOrder: (raw: object) => {orderId: string, productSku: string, date: string, status: keyof typeof ORDER_STATUS},
 *   mapProductBySku: (sku: string) => Promise<number|null>,
 *   dedupeByOrderId: (orders: object[]) => object[],
 * }}
 */
export const EasyOrdersProvider = {
  name: 'EasyOrders',
  async fetchOrders() {
    throw new Error('EasyOrdersProvider غير مفعّل بعد — يحتاج ربط API/Webhook فعلي.');
  },
  normalizeOrder() {
    throw new Error('EasyOrdersProvider.normalizeOrder غير مفعّل بعد.');
  },
  // Real matching logic already exists and is tested — see
  // product-mapping.js's mapProductByName(). This method stays a stub
  // (throws) because it also needs Products.all() (an IndexedDB read),
  // which this file deliberately never touches directly.
  async mapProductBySku() {
    throw new Error('EasyOrdersProvider.mapProductBySku غير مفعّل بعد — راجع product-mapping.js لمنطق المطابقة الجاهز.');
  },
  dedupeByOrderId(orders) {
    const seen = new Set();
    return orders.filter((o) => {
      if (seen.has(o.orderId)) return false;
      seen.add(o.orderId);
      return true;
    });
  },
  async syncOrders() {
    throw new Error('EasyOrdersProvider.syncOrders غير مفعّل بعد — راجع قسم "الخطوة التالية" في الـREADME.');
  },
};

/** The provider actually in use right now. Swapping this line is the entire migration once EasyOrders is ready. */
export const activeOrdersProvider = DemoOrdersProvider;
