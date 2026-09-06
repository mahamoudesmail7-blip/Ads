-- CreateTable
CREATE TABLE "amb_products" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER,
    "product_name" TEXT NOT NULL,
    "external_product_ref" TEXT,
    "product_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pricing_multiplier" DOUBLE PRECISION NOT NULL DEFAULT 3,
    "suggested_selling_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actual_selling_price" DOUBLE PRECISION,
    "packaging_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "shipping_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "other_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rto_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confirmation_rate" DOUBLE PRECISION,
    "delivery_rate" DOUBLE PRECISION,
    "target_cpa" DOUBLE PRECISION,
    "warning_cpa" DOUBLE PRECISION,
    "max_cpa" DOUBLE PRECISION,
    "target_profit" DOUBLE PRECISION,
    "min_profit" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amb_product_campaign_map" (
    "id" SERIAL NOT NULL,
    "amb_product_id" INTEGER NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "campaign_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'MAPPED',
    "match_source" TEXT NOT NULL DEFAULT 'MANUAL',
    "match_confidence" DOUBLE PRECISION,
    "ai_reason" TEXT,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_product_campaign_map_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amb_sync_runs" (
    "id" SERIAL NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "ad_account_id" TEXT,
    "account_currency" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "snapshot_rows" INTEGER NOT NULL DEFAULT 0,
    "adsdaily_refreshed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "amb_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_performance_snapshots" (
    "id" SERIAL NOT NULL,
    "sync_run_id" INTEGER NOT NULL,
    "snapshot_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ad_account_id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "date_start" TEXT NOT NULL,
    "date_stop" TEXT NOT NULL,
    "campaign_id" TEXT,
    "campaign_name" TEXT,
    "campaign_status" TEXT,
    "campaign_objective" TEXT,
    "campaign_budget" DOUBLE PRECISION,
    "campaign_budget_type" TEXT,
    "adset_id" TEXT,
    "adset_name" TEXT,
    "adset_status" TEXT,
    "adset_budget" DOUBLE PRECISION,
    "adset_budget_type" TEXT,
    "ad_id" TEXT,
    "ad_name" TEXT,
    "ad_status" TEXT,
    "creative_id" TEXT,
    "spend" DOUBLE PRECISION,
    "impressions" INTEGER,
    "reach" INTEGER,
    "frequency" DOUBLE PRECISION,
    "clicks" INTEGER,
    "ctr" DOUBLE PRECISION,
    "cpc" DOUBLE PRECISION,
    "cpm" DOUBLE PRECISION,
    "meta_purchases" INTEGER,
    "meta_revenue" DOUBLE PRECISION,
    "cost_per_purchase" DOUBLE PRECISION,
    "conversion_rate" DOUBLE PRECISION,
    "roas" DOUBLE PRECISION,
    "results" INTEGER,
    "result_indicator" TEXT,
    "actions_json" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meta_performance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amb_recommendations" (
    "id" SERIAL NOT NULL,
    "batch_id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "amb_product_id" INTEGER,
    "product_name" TEXT,
    "level" TEXT NOT NULL,
    "entity_id" TEXT,
    "entity_name" TEXT,
    "campaign_id" TEXT,
    "campaign_name" TEXT,
    "adset_id" TEXT,
    "adset_name" TEXT,
    "ad_id" TEXT,
    "ad_name" TEXT,
    "decision" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "executable" BOOLEAN NOT NULL DEFAULT false,
    "current_metrics_json" TEXT,
    "target_metrics_json" TEXT,
    "current_budget" DOUBLE PRECISION,
    "recommended_budget" DOUBLE PRECISION,
    "budget_change_pct" DOUBLE PRECISION,
    "reason" TEXT,
    "reason_facts_json" TEXT,
    "rule_engine_json" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'LOW',
    "risk_level" TEXT NOT NULL DEFAULT 'MEDIUM',
    "data_sufficiency" TEXT NOT NULL DEFAULT 'WEAK',
    "priority" TEXT NOT NULL DEFAULT 'P3',
    "time_window_from" TEXT,
    "time_window_to" TEXT,
    "time_window_label" TEXT,
    "source" TEXT NOT NULL DEFAULT 'AI',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewed_by_id" INTEGER,
    "reviewed_at" TIMESTAMP(3),
    "edited_json" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amb_actions" (
    "id" SERIAL NOT NULL,
    "recommendation_id" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "entity_name" TEXT,
    "campaign_id" TEXT,
    "adset_id" TEXT,
    "ad_id" TEXT,
    "old_value_json" TEXT,
    "new_value_json" TEXT,
    "ai_reason" TEXT,
    "ai_confidence" TEXT,
    "metrics_before_json" TEXT,
    "approval_status" TEXT NOT NULL DEFAULT 'APPROVED',
    "execution_status" TEXT NOT NULL DEFAULT 'PENDING',
    "revalidation_json" TEXT,
    "meta_request_json" TEXT,
    "meta_response_json" TEXT,
    "meta_error" TEXT,
    "executed_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executed_at" TIMESTAMP(3),

    CONSTRAINT "amb_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amb_action_results" (
    "id" SERIAL NOT NULL,
    "action_id" INTEGER NOT NULL,
    "checkpoint" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "evaluated_at" TIMESTAMP(3),
    "cpa_before" DOUBLE PRECISION,
    "cpa_after" DOUBLE PRECISION,
    "roas_before" DOUBLE PRECISION,
    "roas_after" DOUBLE PRECISION,
    "spend_before" DOUBLE PRECISION,
    "spend_after" DOUBLE PRECISION,
    "purchases_before" INTEGER,
    "purchases_after" INTEGER,
    "delivered_cpa_before" DOUBLE PRECISION,
    "delivered_cpa_after" DOUBLE PRECISION,
    "profit_before" DOUBLE PRECISION,
    "profit_after" DOUBLE PRECISION,
    "result_class" TEXT,
    "notes_json" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "amb_action_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amb_alerts" (
    "id" SERIAL NOT NULL,
    "severity" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "ad_account_id" TEXT,
    "level" TEXT,
    "entity_id" TEXT,
    "entity_name" TEXT,
    "campaign_id" TEXT,
    "recommendation_id" INTEGER,
    "dedupe_key" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "amb_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "amb_products_product_id_key" ON "amb_products"("product_id");

-- CreateIndex
CREATE INDEX "amb_products_active_idx" ON "amb_products"("active");

-- CreateIndex
CREATE INDEX "amb_product_campaign_map_amb_product_id_idx" ON "amb_product_campaign_map"("amb_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "amb_product_campaign_map_ad_account_id_campaign_id_key" ON "amb_product_campaign_map"("ad_account_id", "campaign_id");

-- CreateIndex
CREATE INDEX "amb_sync_runs_started_at_idx" ON "amb_sync_runs"("started_at");

-- CreateIndex
CREATE INDEX "meta_performance_snapshots_snapshot_at_idx" ON "meta_performance_snapshots"("snapshot_at");

-- CreateIndex
CREATE INDEX "meta_performance_snapshots_ad_account_id_snapshot_at_idx" ON "meta_performance_snapshots"("ad_account_id", "snapshot_at");

-- CreateIndex
CREATE INDEX "meta_performance_snapshots_level_campaign_id_idx" ON "meta_performance_snapshots"("level", "campaign_id");

-- CreateIndex
CREATE INDEX "meta_performance_snapshots_adset_id_idx" ON "meta_performance_snapshots"("adset_id");

-- CreateIndex
CREATE INDEX "meta_performance_snapshots_ad_id_idx" ON "meta_performance_snapshots"("ad_id");

-- CreateIndex
CREATE INDEX "amb_recommendations_status_idx" ON "amb_recommendations"("status");

-- CreateIndex
CREATE INDEX "amb_recommendations_batch_id_idx" ON "amb_recommendations"("batch_id");

-- CreateIndex
CREATE INDEX "amb_recommendations_ad_account_id_created_at_idx" ON "amb_recommendations"("ad_account_id", "created_at");

-- CreateIndex
CREATE INDEX "amb_recommendations_priority_idx" ON "amb_recommendations"("priority");

-- CreateIndex
CREATE INDEX "amb_actions_execution_status_idx" ON "amb_actions"("execution_status");

-- CreateIndex
CREATE INDEX "amb_actions_recommendation_id_idx" ON "amb_actions"("recommendation_id");

-- CreateIndex
CREATE INDEX "amb_actions_created_at_idx" ON "amb_actions"("created_at");

-- CreateIndex
CREATE INDEX "amb_action_results_due_at_idx" ON "amb_action_results"("due_at");

-- CreateIndex
CREATE UNIQUE INDEX "amb_action_results_action_id_checkpoint_key" ON "amb_action_results"("action_id", "checkpoint");

-- CreateIndex
CREATE UNIQUE INDEX "amb_alerts_dedupe_key_key" ON "amb_alerts"("dedupe_key");

-- CreateIndex
CREATE INDEX "amb_alerts_read_created_at_idx" ON "amb_alerts"("read", "created_at");

-- AddForeignKey
ALTER TABLE "amb_products" ADD CONSTRAINT "amb_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amb_products" ADD CONSTRAINT "amb_products_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amb_product_campaign_map" ADD CONSTRAINT "amb_product_campaign_map_amb_product_id_fkey" FOREIGN KEY ("amb_product_id") REFERENCES "amb_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amb_product_campaign_map" ADD CONSTRAINT "amb_product_campaign_map_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_performance_snapshots" ADD CONSTRAINT "meta_performance_snapshots_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "amb_sync_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amb_recommendations" ADD CONSTRAINT "amb_recommendations_amb_product_id_fkey" FOREIGN KEY ("amb_product_id") REFERENCES "amb_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amb_recommendations" ADD CONSTRAINT "amb_recommendations_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amb_actions" ADD CONSTRAINT "amb_actions_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "amb_recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amb_actions" ADD CONSTRAINT "amb_actions_executed_by_id_fkey" FOREIGN KEY ("executed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amb_action_results" ADD CONSTRAINT "amb_action_results_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "amb_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
