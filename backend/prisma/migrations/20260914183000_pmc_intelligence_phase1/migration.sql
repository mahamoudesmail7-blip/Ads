-- Product Marketing Center — Intelligence & Strategy layer (Phase 1).
-- PREPARED via hand-written SQL (never run through `prisma migrate dev`/
-- `diff`) — purely additive: 8 new nullable columns on the existing
-- pmc_snapshots table + 3 new tables + their indexes/foreign keys. No ALTER
-- on any existing column, no DROP, no TRUNCATE, no RENAME, no constraint
-- change on any existing @@unique.
--
-- This migration is intended to run ONCE through the normal Prisma
-- migration flow (`prisma migrate deploy`), which tracks it in
-- `_prisma_migrations` and will not re-apply it. It is NOT idempotent if
-- run by hand outside that flow — re-running this file's raw SQL a second
-- time against a database that already has these columns/tables will fail
-- on the duplicate ADD COLUMN / CREATE TABLE. It does not drop or rewrite
-- any existing data either way.

-- AlterTable — all 8 new columns added in a single statement (one lock
-- acquisition) on the existing pmc_snapshots table. Every column stays
-- nullable — no default, no NOT NULL, no backfill; a snapshot computed
-- before this phase simply reads these back as NULL.
ALTER TABLE "pmc_snapshots"
    ADD COLUMN "markets_json" TEXT,
    ADD COLUMN "buyer_insights_json" TEXT,
    ADD COLUMN "hook_intel_json" TEXT,
    ADD COLUMN "angle_intel_json" TEXT,
    ADD COLUMN "needs_attention_json" TEXT,
    ADD COLUMN "winning_components_json" TEXT,
    ADD COLUMN "market_gaps_json" TEXT,
    ADD COLUMN "strategist_json" TEXT;

-- CreateTable
CREATE TABLE "pmc_tests" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "test_type" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "variable" TEXT NOT NULL,
    "control" TEXT NOT NULL,
    "variation" TEXT NOT NULL,
    "recommended_budget" DOUBLE PRECISION,
    "min_data_requirement" INTEGER,
    "success_metric" TEXT NOT NULL,
    "stop_condition" TEXT,
    "expected_learning" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'P2',
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pmc_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pmc_test_results" (
    "id" SERIAL NOT NULL,
    "test_id" INTEGER NOT NULL,
    "window_from" TEXT NOT NULL,
    "window_to" TEXT NOT NULL,
    "spend" DOUBLE PRECISION,
    "meta_purchases" INTEGER,
    "orders" INTEGER,
    "confirmed_orders" INTEGER,
    "delivered_orders" INTEGER,
    "ctr" DOUBLE PRECISION,
    "cpc" DOUBLE PRECISION,
    "cpa" DOUBLE PRECISION,
    "delivered_cpa" DOUBLE PRECISION,
    "roas" DOUBLE PRECISION,
    "revenue" DOUBLE PRECISION,
    "net_profit" DOUBLE PRECISION,
    "classification" TEXT NOT NULL,
    "what_did_we_learn" TEXT,
    "what_next" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pmc_test_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pmc_learning" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "dimension" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "sample_size" INTEGER NOT NULL DEFAULT 0,
    "evidence_json" TEXT,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pmc_learning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pmc_tests_profile_id_status_idx" ON "pmc_tests"("profile_id", "status");

-- CreateIndex
CREATE INDEX "pmc_test_results_test_id_idx" ON "pmc_test_results"("test_id");

-- CreateIndex (this table's dedup key — one current verdict per profile+dimension+key)
CREATE UNIQUE INDEX "pmc_learning_profile_id_dimension_key_key" ON "pmc_learning"("profile_id", "dimension", "key");

-- AddForeignKey (ON DELETE CASCADE — a test/result/learning row is meaningless without its parent profile/test)
ALTER TABLE "pmc_tests" ADD CONSTRAINT "pmc_tests_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "pmc_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (ON DELETE SET NULL — deleting a user must never delete their created tests)
ALTER TABLE "pmc_tests" ADD CONSTRAINT "pmc_tests_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pmc_test_results" ADD CONSTRAINT "pmc_test_results_test_id_fkey" FOREIGN KEY ("test_id") REFERENCES "pmc_tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pmc_learning" ADD CONSTRAINT "pmc_learning_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "pmc_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
