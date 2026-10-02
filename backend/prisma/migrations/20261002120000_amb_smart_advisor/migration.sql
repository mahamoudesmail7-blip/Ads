-- Smart Advisor — recommendation lifecycle + versioned action plans.
-- HAND-WRITTEN SQL (never `prisma migrate dev`/`diff` against this shared
-- production database — see the standing shadow-database incident rule).
-- Purely additive: two brand-new tables, zero ALTER/DROP/RENAME on any
-- existing table or column. Run once through `prisma migrate deploy`.

CREATE TABLE "amb_advisor_recommendations" (
    "id" SERIAL NOT NULL,
    "recommendation_id" TEXT NOT NULL,
    "product_id" INTEGER NOT NULL,
    "store_id" TEXT NOT NULL,
    "plan_version" INTEGER NOT NULL,
    "action_key" TEXT NOT NULL,
    "rec_type" TEXT NOT NULL,
    "problem_type" TEXT,
    "title" TEXT NOT NULL,
    "hypothesis" TEXT,
    "target_variable" TEXT,
    "evidence_json" TEXT,
    "data_quality_json" TEXT,
    "confidence" TEXT,
    "success_json" TEXT NOT NULL,
    "context_json" TEXT,
    "context_hash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECOMMENDED',
    "verdict" TEXT,
    "baseline_json" TEXT,
    "baseline_frozen_at" TIMESTAMP(3),
    "links_json" TEXT,
    "rollback_json" TEXT,
    "executed_at" TIMESTAMP(3),
    "evaluation_json" TEXT,
    "evaluation_key" TEXT,
    "evaluated_at" TIMESTAMP(3),
    "learning_json" TEXT,
    "expired_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "amb_advisor_recommendations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "amb_advisor_recommendations_recommendation_id_key" ON "amb_advisor_recommendations"("recommendation_id");
CREATE INDEX "amb_advisor_recommendations_store_id_product_id_status_idx" ON "amb_advisor_recommendations"("store_id", "product_id", "status");
CREATE INDEX "amb_advisor_recommendations_product_id_action_key_idx" ON "amb_advisor_recommendations"("product_id", "action_key");
ALTER TABLE "amb_advisor_recommendations" ADD CONSTRAINT "amb_advisor_recommendations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "amb_advisor_plan_versions" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "store_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "state_hash" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "plan_json" TEXT NOT NULL,
    "change_reasons_json" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "amb_advisor_plan_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "amb_advisor_plan_versions_product_id_store_id_version_key" ON "amb_advisor_plan_versions"("product_id", "store_id", "version");
CREATE INDEX "amb_advisor_plan_versions_product_id_store_id_created_at_idx" ON "amb_advisor_plan_versions"("product_id", "store_id", "created_at");
ALTER TABLE "amb_advisor_plan_versions" ADD CONSTRAINT "amb_advisor_plan_versions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
