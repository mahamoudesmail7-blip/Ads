-- Stable product identity — additive columns + indexes only. No ALTER on
-- any existing column, no DROP, no data touched (the actual UUID backfill,
-- which requires calling the live Easy Orders API to know the real
-- eoId<->productId correspondence for already-matched products, runs as a
-- separate evidence-based script AFTER this migration, never as blind SQL
-- here). Safe to run any number of times.

-- AlterTable
ALTER TABLE "products" ADD COLUMN "easy_orders_uuid" TEXT;
ALTER TABLE "easyorders_orders" ADD COLUMN "easy_orders_product_uuid" TEXT;

-- CreateIndex
CREATE INDEX "products_store_id_easy_orders_uuid_idx" ON "products"("store_id", "easy_orders_uuid");
CREATE INDEX "easyorders_orders_store_id_easy_orders_product_uuid_idx" ON "easyorders_orders"("store_id", "easy_orders_product_uuid");
