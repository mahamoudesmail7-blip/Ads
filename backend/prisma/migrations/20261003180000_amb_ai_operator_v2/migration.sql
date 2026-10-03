-- AI Operator v2 — decision lifecycle events, rule versioning on decisions, richer per-product profile, per-store limits.
-- HAND-WRITTEN SQL (never `prisma migrate dev`/`diff` against this shared production database — standing shadow-database incident rule).
-- Purely additive: one new table + nullable columns on the six Operator tables created in 20261003100000_amb_ai_operator (all empty/new). No existing app table is touched.

CREATE TABLE "amb_operator_events" (
    "id" SERIAL NOT NULL,
    "decision_id" INTEGER,
    "kind" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "actor" TEXT,
    "actor_id" INTEGER,
    "note" TEXT,
    "data_json" TEXT,
    "campaign_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "amb_operator_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "amb_operator_events_decision_id_created_at_idx" ON "amb_operator_events"("decision_id", "created_at");
CREATE INDEX "amb_operator_events_campaign_id_kind_created_at_idx" ON "amb_operator_events"("campaign_id", "kind", "created_at");
CREATE INDEX "amb_operator_events_kind_created_at_idx" ON "amb_operator_events"("kind", "created_at");

ALTER TABLE "amb_operator_decisions" ADD COLUMN "rule_version" INTEGER;
ALTER TABLE "amb_operator_decisions" ADD COLUMN "rule_snapshot_json" TEXT;
ALTER TABLE "amb_operator_decisions" ADD COLUMN "error_category" TEXT;
ALTER TABLE "amb_operator_decisions" ADD COLUMN "reject_reason" TEXT;
ALTER TABLE "amb_operator_decisions" ADD COLUMN "expected_state_json" TEXT;

ALTER TABLE "amb_operator_product_config" ADD COLUMN "automation_mode" TEXT;
ALTER TABLE "amb_operator_product_config" ADD COLUMN "max_scale_pct" DOUBLE PRECISION;
ALTER TABLE "amb_operator_product_config" ADD COLUMN "testing_spend_allowance" DOUBLE PRECISION;
ALTER TABLE "amb_operator_product_config" ADD COLUMN "testing_min_sample" INTEGER;

ALTER TABLE "amb_operator_config" ADD COLUMN "store_limits_json" TEXT;
ALTER TABLE "amb_operator_config" ADD COLUMN "autopilot_attest_json" TEXT;
