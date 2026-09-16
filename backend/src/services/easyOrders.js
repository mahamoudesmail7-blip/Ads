// Shared EasyOrders logic used by BOTH the webhook receiver
// (routes/webhooks.js) and the periodic reconciliation job
// (services/easyOrdersReconcile.js) — extracted so the two paths can never
// drift into applying a status differently. Moved here verbatim from
// webhooks.js; its behavior is unchanged, only its location.
import { prisma } from '../prisma.js';
import { ensureLostOrderTracking } from './lostOrders.js';
import { normalizeName } from '../../../js/product-mapping.js';
import { linkOrderToCustomer, recomputeCustomerStats } from './customers.js';
import { getStoreApiKey } from './easyOrdersStores.js';

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

/**
 * Recomputes the DailyOrder aggregate for one (product, date) from every
 * EasyOrdersOrder row tracked for it — never hand-incremented, always
 * derived fresh so a later status change (e.g. a return) self-corrects the
 * aggregate instead of drifting.
 *
 * Multi-store — the aggregation query itself stays scoped by product_id
 * only (not store_id): since matchProduct()/findInternalProductByName() now
 * keep two stores' products on separate internal product_id values, "every
 * EasyOrdersOrder row for this product_id" is already exactly one store's
 * rows. `storeId` here only tags the resulting DailyOrder row itself, for
 * direct queryability — same store_id every row for this product already
 * shares.
 */
export async function recomputeDailyOrder(productId, date, storeId = 'default') {
  if (!productId) return;
  const rows = await prisma.easyOrdersOrder.findMany({ where: { product_id: productId, date } });
  const sum = (statuses) => rows.filter((r) => statuses.includes(r.status)).reduce((acc, r) => acc + r.quantity, 0);
  const orders_count = sum(['PENDING', 'CONFIRMED', 'DELIVERED']);
  const delivered_count = sum(['DELIVERED']);
  const returned_count = sum(['RETURNED']);

  if (rows.length === 0) return; // nothing left to track for this product+date — leave any pre-existing manual/demo row alone.

  await prisma.dailyOrder.upsert({
    where: { product_id_date: { product_id: productId, date } },
    update: { orders_count, delivered_count, returned_count, source: 'easyorders', store_id: storeId },
    create: { product_id: productId, date, orders_count, delivered_count, returned_count, source: 'easyorders', store_id: storeId },
  });
}

// A media-buying platform (e.g. Easy Orders) sometimes appends its own
// internal tag to a product's listed name — observed real example:
// "جهاز قياس الضغط الذكي المنزلي (s48)" for an internal catalog entry named
// exactly "جهاز قياس الضغط الذكي المنزلي". Stripped BEFORE normalizing,
// and only this one literal, narrow shape — never a general
// parenthetical-removal (which could eat real distinguishing info like a
// genuine "(كبير)" size variant).
const STORE_TAG_SUFFIX = /\s*\(s\d+\)\s*$/i;
export function stripStoreTagSuffix(name) {
  return String(name || '').replace(STORE_TAG_SUFFIX, '').trim();
}

/** The one normalized key both sides of the name comparison are reduced to — suffix-stripped, then run through the SAME Arabic-aware exact normalizer already trusted elsewhere in this codebase (js/product-mapping.js, also used by amb/mapping.js and amb/productMarketing.js). Still an EXACT-match key, never a similarity score. */
export function exactNameKey(name) {
  return normalizeName(stripStoreTagSuffix(name));
}

/**
 * Matches an EasyOrders cart item to our Product.
 *
 * A. Exact Easy Orders product UUID match (cart_items[].product.id on the
 *    real order payload — confirmed present via Easy Orders' own API docs).
 *    The single most reliable signal available: unlike a name or even a
 *    SKU, this UUID can never coincidentally collide between two unrelated
 *    products. Scoped by store (a store's own product, or a legacy
 *    unscoped one) so two stores' catalogs can never cross-match. Checked
 *    FIRST, before SKU/name, per the stable-identity priority this
 *    integration is built around.
 * B. Exact SKU match (unchanged from before — a real, already-trusted tier)
 *    — only reached when no UUID was given or it didn't resolve a product.
 * C. ONLY when neither of the above resolved a product, fall back to an
 *    EXACT normalized-name match — never fuzzy, never a substring/contains
 *    check, never partial-word overlap. If more than one active internal
 *    product normalizes to the same name, that's an ambiguous data
 *    problem, not something to guess through — treated the same as no
 *    match at all (UNMAPPED).
 *
 * Never touches Product Mapping's fuzzy tier or any AI — a wrong guess here
 * would silently misattribute a real sale, which is worse than leaving it
 * unmatched for manual review.
 *
 * Multi-store — `storeId`, when given, scopes the UUID tier directly (a
 * store's own product or a legacy untagged one, never a different store's),
 * and is used to break a genuine name tie in tier C between two active
 * products that otherwise match equally; it never widens or narrows tier C's
 * initial candidate set, so a single unambiguous global name match (today's
 * fallback case) behaves identically to before.
 */
export async function matchProduct(sku, name, storeId = null, easyOrdersUuid = null) {
  if (easyOrdersUuid) {
    const byUuid = await prisma.product.findFirst({ where: { easy_orders_uuid: easyOrdersUuid, OR: [{ store_id: storeId }, { store_id: null }] } });
    if (byUuid) return byUuid;
  }

  if (sku) {
    const bySku = await prisma.product.findFirst({ where: { sku } });
    if (bySku) return bySku;
  }

  const key = exactNameKey(name);
  if (!key) return null;
  // A historical (deleted-from-source) product is excluded from this tier
  // — if this exact name is ever seen again on a fresh incoming order, it
  // means the product genuinely exists in the live catalog again and must
  // resolve through the normal catalog-creation flow into its OWN new
  // Product, never silently reuse the old historical record.
  const candidates = await prisma.product.findMany({ where: { active: true, is_historical: false }, select: { id: true, product_name: true, sku: true, store_id: true } });
  const matches = candidates.filter((p) => exactNameKey(p.product_name) === key);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 && storeId) {
    const storeMatches = matches.filter((p) => p.store_id === storeId);
    if (storeMatches.length === 1) return storeMatches[0];
  }
  return null;
}

/**
 * Upserts one EasyOrdersOrder row per cart item from a full order payload
 * (either the original webhook body, or a Get-Order-By-ID response), then
 * recomputes every (product, date) it touches.
 *
 * Multi-store — `storeId` is OUR OWN internal store id (resolved by the
 * caller: routes/webhooks.js resolves it from which configured store's
 * secret matched; services/easyOrdersReconcile.js already knows it from the
 * EasyOrdersOrder row it's re-checking). Defaults to 'default' — the one
 * real store 100% of pre-multi-store data belongs to — so any caller that
 * hasn't been updated yet keeps today's exact behavior.
 */
export async function ingestOrder(order, storeId = 'default') {
  const date = toDateOnly(order.created_at);
  const status = normalizeStatus(order.status);
  const touched = new Set();

  // Fields confirmed present in Easy Orders' REAL order API response
  // (inspected live against real production orders) — see schema.prisma's
  // EasyOrdersOrder comment for exactly which fields were checked and
  // confirmed absent (email/notes/coupon/UTM/campaign_id/ad_set_id/ad_id).
  // metadata's delivery-rate sub-object is keyed by the order's own phone
  // number, per the real payload shape.
  const deliveryRateInfo = (order.phone && order.metadata) ? order.metadata[order.phone] : null;
  const customerFields = {
    short_id: typeof order.short_id === 'number' ? order.short_id : null,
    customer_name: order.full_name || null,
    customer_phone: order.phone || null,
    customer_address: order.address || null,
    customer_government: order.government || null,
    order_cost: typeof order.cost === 'number' ? order.cost : null,
    shipping_cost: typeof order.shipping_cost === 'number' ? order.shipping_cost : null,
    easy_orders_store_id: order.store_id || null,
    easy_orders_guest_id: order.guest_id || null,
    payment_method: order.payment_method || null,
    ip_address: order.ip || null,
    ip_country: order.ip_country || null,
    total_cost: typeof order.total_cost === 'number' ? order.total_cost : null,
    delivery_rate_status: deliveryRateInfo?.delivery_rate_status || null,
    delivery_rate_result: deliveryRateInfo?.rate_result || null,
    tracking_json: order.metadata?.tracking ? JSON.stringify(order.metadata.tracking) : null,
    // Multi-store — OUR OWN internal store id (distinct from
    // easy_orders_store_id above, which is Easy Orders' own account UUID).
    // An order's store never changes after creation, but writing it on
    // every update too is harmless (idempotent) and keeps this one
    // customerFields spread as the single source for both branches.
    store_id: storeId,
  };

  for (const item of order.cart_items || []) {
    const sku = item.product?.sku || null;
    const productNameRaw = item.product?.name || null;
    const easyOrdersProductUuid = item.product?.id || null;
    const product = await matchProduct(sku, productNameRaw, storeId, easyOrdersProductUuid);
    await prisma.easyOrdersOrder.upsert({
      where: { order_id_cart_item_id: { order_id: order.id, cart_item_id: item.id } },
      update: { status, raw_status: order.status, quantity: item.quantity || 1, product_id: product?.id ?? null, sku, product_name_raw: productNameRaw, easy_orders_product_uuid: easyOrdersProductUuid, matched: !!product, date, ...customerFields },
      create: {
        order_id: order.id,
        cart_item_id: item.id,
        product_id: product?.id ?? null,
        sku,
        product_name_raw: productNameRaw,
        easy_orders_product_uuid: easyOrdersProductUuid,
        date,
        status,
        raw_status: order.status,
        quantity: item.quantity || 1,
        matched: !!product,
        ...customerFields,
      },
    });
    if (product) touched.add(`${product.id}::${date}`);
  }

  for (const key of touched) {
    const [productId, d] = key.split('::');
    await recomputeDailyOrder(Number(productId), d, storeId);
  }
  await ensureLostOrderTracking(order.id);

  // Customer Database — resolves/creates the Customer for this order's real
  // phone, links every row of this order_id to it, and recomputes that
  // customer's aggregates. Never throws: a customer-linking failure must
  // never stop the order itself from being ingested.
  await linkOrderToCustomer({
    orderId: order.id,
    rawPhone: order.phone,
    fullName: order.full_name,
    government: order.government,
    address: order.address,
    guestId: order.guest_id,
  });
}

/** Fetches one order's current state directly via the API key — used when a status-update webhook references an order we've never seen, and by the reconciliation job below. */
/**
 * Multi-store — `storeId`, when given, resolves that store's OWN real API
 * key via getStoreApiKey() (each configured store's key lives in its own
 * env var — see services/easyOrdersStores.js). Falls back to the original
 * global EASYORDERS_API_KEY when storeId is omitted or its own key isn't
 * configured, so every pre-multi-store caller (and a store not yet given
 * its own key) keeps working exactly as before.
 */
export async function fetchOrderById(orderId, storeId = null) {
  const apiKey = (storeId && getStoreApiKey(storeId)) || process.env.EASYORDERS_API_KEY;
  if (!apiKey) return null;
  const res = await fetch(`${EASYORDERS_API_BASE}/orders/${orderId}`, { headers: { 'Api-Key': apiKey } });
  if (!res.ok) return null;
  return res.json();
}

// Empirically confirmed (2026-09-16, live probe against a real store's
// key): GET /orders, /orders?page=1&limit=5, /orders?limit=5, and
// /orders?filter=status||eq||pending ALL return 404 — EasyOrders genuinely
// exposes no bulk orders-list/export endpoint of any kind, unlike
// /products (which supports undocumented page/limit despite similarly
// thin docs). This means historical orders that predate a store's webhook
// being configured are permanently unrecoverable via their API — there is
// no way to discover past order IDs to fetch individually, and no list to
// page through. Not a gap in our integration; a real platform limitation.

/** Same as fetchOrderById but by the human-friendly short_id (e.g. 2169 / "#2169") — what a human actually has on hand, unlike the internal UUID. Used by the Lost Orders "add manually" flow. */
export async function fetchOrderByShortId(shortId) {
  const apiKey = process.env.EASYORDERS_API_KEY;
  if (!apiKey) return null;
  const res = await fetch(`${EASYORDERS_API_BASE}/orders/short/${shortId}`, { headers: { 'Api-Key': apiKey } });
  if (!res.ok) return null;
  return res.json();
}

/** Applies a new status to every EasyOrdersOrder row tracked for one order_id, then recomputes every (product, date) touched. Shared by the webhook's order-status-update handler and the reconciliation job so both apply a status change identically. Returns both counts since the reconciliation job needs to know whether anything actually changed, not just how many rows exist. */
export async function applyStatusToOrder(orderId, rawStatus) {
  const status = normalizeStatus(rawStatus);
  const rows = await prisma.easyOrdersOrder.findMany({ where: { order_id: orderId } });
  const touched = new Map(); // "productId::date" -> that row's own already-set store_id
  const touchedCustomerIds = new Set();
  let changedRows = 0;
  for (const row of rows) {
    if (row.status === status) continue; // no-op — avoids an unnecessary write + recompute when nothing actually changed
    await prisma.easyOrdersOrder.update({ where: { id: row.id }, data: { status, raw_status: rawStatus } });
    changedRows++;
    if (row.product_id) touched.set(`${row.product_id}::${row.date}`, row.store_id || 'default');
    if (row.customer_id) touchedCustomerIds.add(row.customer_id);
  }
  for (const [key, rowStoreId] of touched) {
    const [productId, d] = key.split('::');
    await recomputeDailyOrder(Number(productId), d, rowStoreId);
  }
  // A status change (e.g. PENDING -> DELIVERED, or -> RETURNED) shifts this
  // customer's confirmed/delivered/returned/cancelled counts and revenue —
  // recomputed fresh, same as the product-level DailyOrder aggregate above.
  for (const customerId of touchedCustomerIds) await recomputeCustomerStats(customerId);
  if (changedRows > 0) await ensureLostOrderTracking(orderId);
  return { totalRows: rows.length, changedRows };
}
