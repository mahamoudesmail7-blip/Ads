-- Multi-store (Phase 2) — additive column + evidence-based backfill.
-- Purely additive: nullable column + non-unique index only. No ALTER on any
-- existing column, no DROP, no TRUNCATE, no constraint change on any
-- existing @@unique. Safe to run any number of times.
--
-- Runs AFTER 20260913155315_multi_store_cod_store_id (which adds store_id
-- to easyorders_orders/daily_orders but was never applied until this same
-- deploy) — both migrations apply together, in order, on first deploy.
--
-- Backfill justification (verified against production before writing this
-- migration, not assumed): every existing easyorders_orders row's REAL
-- Easy Orders account UUID (easy_orders_store_id, unrelated to our own
-- store_id) has exactly one non-null distinct value across all 250 rows
-- (248 legacy rows predate that column and are null). 100% of historical
-- order/product data came from the one real store our internal id
-- "default" already represents — so backfilling every pre-existing row's
-- new store_id to 'default' is evidence-backed, not a guess. Any NEW
-- second-store data starts flowing in only after this deploy and gets its
-- own real store_id going forward (see routes/webhooks.js's per-store
-- secret resolution).

-- AlterTable
ALTER TABLE "products" ADD COLUMN "store_id" TEXT;

-- CreateIndex
CREATE INDEX "products_store_id_idx" ON "products"("store_id");

-- Backfill (additive UPDATE only — no row deleted, no id changed, no data moved between tables)
UPDATE "easyorders_orders" SET "store_id" = 'default' WHERE "store_id" IS NULL;
UPDATE "daily_orders" SET "store_id" = 'default' WHERE "store_id" IS NULL;
UPDATE "products" SET "store_id" = 'default' WHERE "store_id" IS NULL;
