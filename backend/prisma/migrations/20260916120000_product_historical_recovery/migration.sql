-- Historical-only product recovery — additive columns only, no data
-- touched by this migration itself (the actual recovery is a separate,
-- explicit, dry-run-first script/route call — see
-- recoverHistoricalProduct() in productMarketing.js). Safe to run any
-- number of times.

-- AlterTable
ALTER TABLE "products" ADD COLUMN "is_historical" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN "historical_note" TEXT;
