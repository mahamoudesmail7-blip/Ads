-- Daily Campaign Operations Center — the two daily plans (OPEN 00:00 / PAUSE 13:00, Africa/Cairo) and their per-campaign items.
-- HAND-WRITTEN SQL (never `prisma migrate dev`/`diff` against this shared production database — standing shadow-database incident rule).
-- Purely additive: two NEW tables, no existing table is touched.

CREATE TABLE "amb_daily_plans" (
    "id" SERIAL NOT NULL,
    "plan_key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "plan_date" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Cairo',
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PREPARED',
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "prepared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data_as_of" TIMESTAMP(3),
    "data_state" TEXT NOT NULL DEFAULT 'FRESH',
    "surfaced_at" TIMESTAMP(3),
    "dismissed_at" TIMESTAMP(3),
    "approved_by_id" INTEGER,
    "approved_at" TIMESTAMP(3),
    "approval_mode" TEXT,
    "execution_mode" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "summary_json" TEXT,
    "evidence_json" TEXT,
    "lock_owner" TEXT,
    "lock_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "amb_daily_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "amb_daily_plans_plan_key_version_key" ON "amb_daily_plans"("plan_key", "version");
CREATE INDEX "amb_daily_plans_plan_date_type_idx" ON "amb_daily_plans"("plan_date", "type");
CREATE INDEX "amb_daily_plans_status_scheduled_at_idx" ON "amb_daily_plans"("status", "scheduled_at");

CREATE TABLE "amb_daily_plan_items" (
    "id" SERIAL NOT NULL,
    "plan_id" INTEGER NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "campaign_name" TEXT,
    "product_id" INTEGER,
    "product_name" TEXT,
    "store_id" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "selectable" BOOLEAN NOT NULL DEFAULT true,
    "eligibility" TEXT NOT NULL DEFAULT 'ELIGIBLE',
    "block_codes_json" TEXT,
    "risk" TEXT,
    "risk_score" INTEGER,
    "evidence_json" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "status_reason" TEXT,
    "status_at" TIMESTAMP(3),
    "amb_action_id" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "amb_daily_plan_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "amb_daily_plan_items_plan_id_idx" ON "amb_daily_plan_items"("plan_id");
CREATE INDEX "amb_daily_plan_items_campaign_id_idx" ON "amb_daily_plan_items"("campaign_id");
ALTER TABLE "amb_daily_plan_items" ADD CONSTRAINT "amb_daily_plan_items_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "amb_daily_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
