-- Customer Database (additive) — PREPARED, NOT APPLIED to production.
-- Hand-written (never run through `prisma migrate dev`/`diff`) — purely
-- additive: one new table + nullable columns + non-unique indexes only.
-- No ALTER on any existing column, no DROP, no TRUNCATE, no RENAME, no
-- constraint change on any existing @@unique.
--
-- This migration is intended to run ONCE through the normal Prisma
-- migration flow (`prisma migrate deploy`), which tracks it in
-- `_prisma_migrations` and will not re-apply it. It is NOT idempotent if
-- run by hand outside that flow — re-running this file's raw SQL a second
-- time against a database that already has "customers" (or these new
-- easyorders_orders columns/indexes) will fail on the duplicate
-- CREATE TABLE / ADD COLUMN / CREATE INDEX. It does not drop or rewrite any
-- existing data either way.
--
-- Built ONLY from fields confirmed present in Easy Orders' real order API
-- response (inspected live against 2 real production orders). Deliberately
-- excludes email/notes/coupon/UTM/campaign_id/ad_set_id/ad_id — confirmed
-- ABSENT from the real payload.

-- CreateTable
CREATE TABLE "customers" (
    "id" SERIAL NOT NULL,
    "normalized_phone" TEXT,
    "primary_phone" TEXT,
    "other_phones_json" TEXT,
    "name" TEXT,
    "government" TEXT,
    "address" TEXT,
    "easy_orders_guest_id" TEXT,
    "first_order_at" TIMESTAMP(3),
    "last_order_at" TIMESTAMP(3),
    "total_orders" INTEGER NOT NULL DEFAULT 0,
    "confirmed_orders" INTEGER NOT NULL DEFAULT 0,
    "delivered_orders" INTEGER NOT NULL DEFAULT 0,
    "returned_orders" INTEGER NOT NULL DEFAULT 0,
    "cancelled_orders" INTEGER NOT NULL DEFAULT 0,
    "total_order_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "delivered_revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (unique — this is the customer dedup key; Postgres allows
-- multiple NULLs under a unique index, so orders with no phone are unaffected)
CREATE UNIQUE INDEX "customers_normalized_phone_key" ON "customers"("normalized_phone");

-- AlterTable — all 10 new columns added in a single statement (one lock
-- acquisition instead of ten) on the existing easyorders_orders table.
-- Every column stays nullable — no default, no NOT NULL, no backfill.
ALTER TABLE "easyorders_orders"
    ADD COLUMN "customer_id" INTEGER,
    ADD COLUMN "easy_orders_store_id" TEXT,
    ADD COLUMN "easy_orders_guest_id" TEXT,
    ADD COLUMN "payment_method" TEXT,
    ADD COLUMN "ip_address" TEXT,
    ADD COLUMN "ip_country" TEXT,
    ADD COLUMN "total_cost" DOUBLE PRECISION,
    ADD COLUMN "delivery_rate_status" TEXT,
    ADD COLUMN "delivery_rate_result" TEXT,
    ADD COLUMN "tracking_json" TEXT;

-- CreateIndex
CREATE INDEX "easyorders_orders_customer_id_idx" ON "easyorders_orders"("customer_id");

-- AddForeignKey (ON DELETE SET NULL — deleting a Customer row, if that ever
-- happens, must never cascade-delete real order history)
ALTER TABLE "easyorders_orders" ADD CONSTRAINT "easyorders_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
