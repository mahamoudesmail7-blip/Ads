# Inventory webhook — contract (v1, canonical)

`POST https://<host>/api/webhooks/inventory`  (public; authenticated by `INVENTORY_WEBHOOK_SECRET`)

## Authentication (either one)
1. **HMAC (preferred)** — `X-Inventory-Signature: sha256=<hex>` where `hex = HMAC_SHA256(secret, "<X-Inventory-Timestamp>.<raw body>")`
   (or over the raw body alone when no timestamp header is sent). `X-Inventory-Timestamp` (unix seconds or ISO) must be within 5 minutes.
2. **Shared secret** — `X-Inventory-Secret: <secret>` or `Authorization: Bearer <secret>`. Never a query parameter.

## Body (JSON, max 256 KB, max 200 items)
```json
{
  "event_id": "evt_123",
  "event_type": "stock.updated",
  "occurred_at": "2026-10-06T12:00:00Z",
  "version": 17,
  "store_id": "trendy-storeee",
  "warehouse": "main",
  "items": [{
    "external_product_id": "A-1", "sku": "SKU-1", "barcode": "6221234567890", "easy_orders_uuid": "…", "name": "…",
    "current_stock": 10, "reserved": 2, "available": 8, "minimum_stock": 5, "updated_at": "2026-10-06T12:00:00Z", "warehouse": "main"
  }]
}
```
* `event_type`: `stock.updated`, `inventory.updated`, `product.updated` (configurable). Other types → `200 {ignored:true}`.
* `event_id` = idempotency key. `occurred_at`/`updated_at` or `version` = out-of-order protection (an older update never overwrites a newer one).
* `available` is what the Operator uses. If omitted: `current_stock − reserved`; if `reserved` is also omitted: `current_stock`.
* `store_id` (OUR store id) is optional; when sent it restricts matching to that store.
* Matching order: owner mapping → SKU (`sku` / product code) → barcode (owner mapping only) → Easy Orders UUID / external id → name (**SUGGESTED only, never applied**). Unknown products are never created.

## Response
`200 {ok, eventId, counts, results:[{index,status,…}]}` with `status` ∈ `APPLIED | DUPLICATE | STALE_EVENT | UNMAPPED | SUGGESTED | CONFLICT | MAPPING_ERROR | INVALID_ITEM`.
`?dryRun=1` validates and reports `WOULD_APPLY` without writing.
Errors: `401` bad/missing credentials or replayed timestamp · `400` invalid JSON/payload · `413` too large · `429` rate limit (120/min) · `503` secret not configured.
