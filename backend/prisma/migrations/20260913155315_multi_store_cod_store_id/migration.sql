-- Multi-store COD (Phase 1). Applied together with the following migration
-- (20260915190000_multi_store_product_and_backfill), which backfills every
-- pre-existing row's new store_id to 'default' — evidence-based, see that
-- migration's own header.
-- Purely additive: nullable columns + non-unique indexes only.
-- No ALTER on any existing column, no DROP, no TRUNCATE, no constraint
-- change on any existing @@unique. Safe to run any number of times against
-- a database that doesn't already have these columns/indexes.

-- AlterTable
ALTER TABLE "easyorders_orders" ADD COLUMN "store_id" TEXT;

-- AlterTable
ALTER TABLE "daily_orders" ADD COLUMN "store_id" TEXT;

-- CreateIndex
CREATE INDEX "easyorders_orders_store_id_idx" ON "easyorders_orders"("store_id");

-- CreateIndex
CREATE INDEX "easyorders_orders_store_id_product_id_idx" ON "easyorders_orders"("store_id", "product_id");

-- CreateIndex
CREATE INDEX "easyorders_orders_store_id_date_idx" ON "easyorders_orders"("store_id", "date");

-- CreateIndex
CREATE INDEX "daily_orders_store_id_product_id_date_idx" ON "daily_orders"("store_id", "product_id", "date");
